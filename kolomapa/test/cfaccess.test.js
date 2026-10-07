'use strict';
// Přihlášení přes Cloudflare Access: ověření podepsaného JWT (podpis klíčem týmu, vydavatel, AUD aplikace, platnost,
// povolené e-maily) – bez sítě, s vlastním „týmem“ a klíčem RSA.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createAccessVerifier, teamDomain, parseEmailRules, emailAllowed, tokenFromRequest } = require('../src/server/cfaccess');
const { makeTeam } = require('./cfaccess-helpers');

test('teamDomain a pravidla e-mailů', () => {
  assert.equal(teamDomain('bold-dust-a2b5'), 'bold-dust-a2b5.cloudflareaccess.com');
  assert.equal(teamDomain('https://Bold-Dust-A2B5.cloudflareaccess.com/'), 'bold-dust-a2b5.cloudflareaccess.com');
  assert.equal(teamDomain(''), null);
  assert.equal(teamDomain('a b'), null);
  assert.deepEqual(parseEmailRules('@Koloshop.cz, jan@firma.cz; koloshop24.de x'), ['@koloshop.cz', 'jan@firma.cz', '@koloshop24.de']);
  const r = parseEmailRules('@koloshop.cz');
  assert.equal(emailAllowed('Lada@KOLOSHOP.cz', r), true);
  for (const bad of ['a@evilkoloshop.cz', 'a@koloshop.cz.evil.com', 'a@sub.koloshop.cz', 'koloshop.cz', '', null, 'a@b@koloshop.cz']) assert.equal(emailAllowed(bad, r), false, String(bad));
  assert.equal(emailAllowed('kdokoli@kdekoli.cz', []), true, 'bez pravidel rozhoduje politika v Cloudflare');
  assert.equal(tokenFromRequest({ headers: { 'cf-access-jwt-assertion': ' a.b.c ' } }), 'a.b.c');
  assert.equal(tokenFromRequest({ headers: { cookie: 'x=1; CF_Authorization=d.e.f; y=2' } }), 'd.e.f');
  assert.equal(tokenFromRequest({ headers: {} }), null);
});

test('platný token → e-mail; jiná aplikace, jiný tým, vypršelý, cizí podpis, jiný algoritmus → 403', async () => {
  const t = makeTeam();
  const v = createAccessVerifier({ team: t.team, aud: t.aud, emails: '@koloshop.cz', fetchImpl: t.fetchImpl });
  const ok = await v.verify(t.sign());
  assert.deepEqual(ok, { ok: true, email: 'lada@koloshop.cz', name: 'lada@koloshop.cz' });
  const bad = async (token, re) => {
    const r = await v.verify(token);
    assert.equal(r.ok, false, re.source);
    assert.equal(r.status, 403);
    assert.match(r.reason, re);
  };
  await bad(t.sign({ aud: ['b'.repeat(64)] }), /jinou aplikaci/);
  await bad(t.sign({ iss: 'https://jiny-tym.cloudflareaccess.com' }), /jiný tým/);
  await bad(t.sign({ exp: Math.floor(Date.now() / 1000) - 3600 }), /vypršelo/);
  await bad(t.sign({ nbf: Math.floor(Date.now() / 1000) + 3600 }), /ještě neplatí/);
  const { privateKey: cizi } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  await bad(t.sign({}, { key: cizi }), /podpis/);
  await bad(t.sign({}, { alg: 'HS256' }), /nepodporovaný/);
  const [h, p] = t.sign().split('.');
  await bad(`${h}.${p}.`, /neplatný/);
  await bad(`${Buffer.from(JSON.stringify({ alg: 'none', kid: t.kid })).toString('base64url')}.${p}.x`, /nepodporovaný/);
  // podvržený obsah s původním podpisem
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), email: 'cizi@gmail.com' })).toString('base64url');
  await bad(`${h}.${forged}.${t.sign().split('.')[2]}`, /podpis/);
  await bad('nesmysl', /neplatný/);
  assert.equal(t.state.calls, 1, 'klíče týmu se stáhly jednou');
});

test('jen e-maily Koloshopu: cizí doména, podobná doména i token bez e-mailu (servisní token) → 403', async () => {
  const t = makeTeam();
  const v = createAccessVerifier({ team: t.team, aud: t.aud, emails: '@koloshop.cz', fetchImpl: t.fetchImpl });
  for (const email of ['jan@gmail.com', 'jan@evilkoloshop.cz', 'jan@koloshop.cz.evil.com']) {
    const r = await v.verify(t.sign({ email }));
    assert.equal(r.ok, false, email);
    assert.match(r.reason, /nemá do Kolomapy přístup/);
  }
  const svc = await v.verify(t.sign({ email: undefined, common_name: 'servis.access' }));
  assert.equal(svc.ok, false);
  // bez pravidel rozhoduje jen politika v Cloudflare (servisní token projde se jménem)
  const v2 = createAccessVerifier({ team: t.team, aud: t.aud, fetchImpl: t.fetchImpl });
  assert.deepEqual(await v2.verify(t.sign({ email: undefined, common_name: 'servis.access' })), { ok: true, email: null, name: 'servis.access' });
});

test('klíče: výměna klíče (neznámé kid → znovu stáhnout, nejvýš jednou za minutu), výpadek sítě → 503, pak zase dosavadní klíče', async () => {
  let clock = Date.now();
  const t = makeTeam();
  const v = createAccessVerifier({ team: t.team, aud: t.aud, fetchImpl: t.fetchImpl, now: () => clock });
  // ještě nic stažené a síť nejde → 503
  t.state.fail = true;
  const r0 = await v.verify(t.sign());
  assert.equal(r0.status, 503);
  assert.match(r0.reason, /nejde stáhnout/);
  clock += 6000;
  t.state.fail = false;
  assert.equal((await v.verify(t.sign())).ok, true);
  // Cloudflare vymění klíč: token s novým kid → po minutě se klíče stáhnou znovu
  const novy = makeTeam({ kid: 'klic-2' });
  t.state.keys = [t.jwk, novy.jwk];
  const tokenNovy = t.sign({}, { key: novy.privateKey, keyId: 'klic-2' });
  clock += 10_000;
  assert.match((await v.verify(tokenNovy)).reason, /neznámým klíčem/, 'do minuty se znovu nestahuje');
  clock += 60_000;
  assert.equal((await v.verify(tokenNovy)).ok, true, 'po minutě nový klíč');
  // výpadek sítě s už staženými klíči: ověřuje se dál
  t.state.fail = true;
  clock += 2 * 3600_000; // klíče „zastaralé“, obnova selže – token (vydaný na hodiny serveru) se ověří dosavadním klíčem
  const nowS = Math.floor(clock / 1000);
  assert.equal((await v.verify(t.sign({ iat: nowS, nbf: nowS, exp: nowS + 600 }))).ok, true);
  assert.throws(() => createAccessVerifier({ team: '', aud: 'x' }), /neplatný tým/);
  assert.throws(() => createAccessVerifier({ team: 'tym', aud: '' }), /AUD/);
});
