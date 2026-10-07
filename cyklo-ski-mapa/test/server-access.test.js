'use strict';
// Testy přihlášení přes Cloudflare Access (CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD): aplikace pustí jen požadavek
// s platným tokenem Access, e-mail z tokenu je „kdo“, jména a hesla aplikace neplatí.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEAM = 'tym-test.cloudflareaccess.com';
const AUD = 'aud-mapa-0123456789abcdef';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const cizi = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
let stazeni = 0;
const certs = http.createServer((req, res) => {
  stazeni++;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ keys: [jwk], public_cert: { kid: 'k1', cert: '' }, public_certs: [] }));
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-access-'));
let base;
let srv;

function token(zmeny = {}, { klic = privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const nyni = Math.floor(Date.now() / 1000);
  const obsah = { aud: [AUD], email: 'Jana.Nova@koloshop.cz', exp: nyni + 3600, iat: nyni, nbf: nyni, iss: `https://${TEAM}`, type: 'app', sub: 'x', ...zmeny };
  for (const [k, v] of Object.entries(zmeny)) if (v === undefined) delete obsah[k];
  const h = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(obsah)).toString('base64url');
  const podpis = crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), klic).toString('base64url');
  return `${h}.${p}.${podpis}`;
}
const s = (t) => ({ 'Cf-Access-Jwt-Assertion': t });

test.before(async () => {
  await new Promise((r) => certs.listen(0, '127.0.0.1', r));
  process.env.CSM_STAV = path.join(tmp, 'stav.json');
  process.env.CSM_USERS = 'jana:TajneHeslo1';
  process.env.CSM_TOKEN = 'token-pro-skripty';
  process.env.CSM_TRUST_PROXY = '1';
  process.env.CF_ACCESS_TEAM_DOMAIN = 'tym-test';
  process.env.CF_ACCESS_AUD = AUD;
  process.env.CF_ACCESS_DOMENY = 'koloshop.cz';
  process.env.CF_ACCESS_CERTS_URL = `http://127.0.0.1:${certs.address().port}/cdn-cgi/access/certs`;
  delete process.env.CSM_AUTH;
  const mod = require('../server.js');
  assert.strictEqual(mod.ACCESS_ON, true);
  srv = mod.server;
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(async () => {
  await new Promise((r) => srv.close(r));
  await new Promise((r) => certs.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('bez tokenu: stránka 403, assety a API 401, health veřejný, heslo aplikace nepomůže', async () => {
  const idx = await fetch(base + '/', { redirect: 'manual' });
  assert.strictEqual(idx.status, 403);
  assert.match(await idx.text(), /Přístup jen přes přihlášení Cloudflare e-mailem @koloshop\.cz/);
  assert.strictEqual((await fetch(base + '/app.js')).status, 401);
  assert.strictEqual((await fetch(base + '/api/stav')).status, 401);
  assert.strictEqual((await fetch(base + '/api/health')).status, 200);
  const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ jmeno: 'jana', heslo: 'TajneHeslo1', next: '/' }) });
  assert.strictEqual(login.status, 302, 'formulář se v režimu Access nepoužívá');
  assert.strictEqual(login.headers.get('set-cookie'), null, 'heslo nesmí vydat přihlášení');
  assert.strictEqual((await fetch(base + '/login?next=/x', { redirect: 'manual' })).headers.get('location'), '/x');
});

test('platný token: stránka, /api/me s e-mailem, změna nese e-mail jako „kdo“', async () => {
  const t = token();
  assert.strictEqual((await fetch(base + '/', { headers: s(t) })).status, 200);
  const me = await (await fetch(base + '/api/me', { headers: s(t) })).json();
  assert.deepStrictEqual({ jmeno: me.jmeno, pres: me.pres }, { jmeno: 'jana.nova@koloshop.cz', pres: 'cloudflare-access' });
  const put = await fetch(base + '/api/stav/n42', { method: 'PUT', headers: { ...s(t), 'Content-Type': 'application/json' }, body: JSON.stringify({ volano: true, kdo: 'podvrh' }) });
  assert.deepStrictEqual(await put.json(), { ok: true, kdo: 'jana.nova@koloshop.cz' });
  const out = await fetch(base + '/logout', { headers: s(t), redirect: 'manual' });
  assert.strictEqual(out.headers.get('location'), '/cdn-cgi/access/logout');
});

test('odmítnuté tokeny: jiná aplikace, jiný tým, vypršelý, cizí podpis, neznámý klíč, alg, e-mail, formát', async () => {
  const nyni = Math.floor(Date.now() / 1000);
  const pripady = {
    'jiná aplikace (aud)': token({ aud: ['jina-aplikace'] }),
    'jiný tým (iss)': token({ iss: 'https://utocnik.cloudflareaccess.com' }),
    vypršelý: token({ exp: nyni - 120 }),
    'ještě neplatí': token({ nbf: nyni + 600 }),
    'bez exp': token({ exp: undefined }),
    'cizí podpis': token({}, { klic: cizi.privateKey }),
    'neznámý kid': token({}, { kid: 'k-neni' }),
    'alg none': token({}, { alg: 'none' }),
    'e-mail mimo Koloshop': token({ email: 'nekdo@gmail.com' }),
    'podobná doména': token({ email: 'nekdo@notkoloshop.cz' }),
    'bez e-mailu (service token)': token({ email: undefined }),
    'nesmysl': 'neni.jwt',
  };
  for (const [popis, t] of Object.entries(pripady)) {
    const r = await fetch(base + '/api/stav', { headers: s(t) });
    assert.strictEqual(r.status, 401, popis);
    const stranka = await fetch(base + '/', { headers: s(t), redirect: 'manual' });
    assert.strictEqual(stranka.status, 403, popis + ' (stránka)');
  }
});

test('Bearer token pro skripty platí dál; klíče Access se stahují s mírou', async () => {
  const r = await fetch(base + '/api/stav', { headers: { Authorization: 'Bearer token-pro-skripty' } });
  assert.strictEqual(r.status, 200);
  const pred = stazeni;
  for (let i = 0; i < 5; i++) await fetch(base + '/api/stav', { headers: s(token({}, { kid: 'k-neni-' + i })) });
  assert.ok(stazeni - pred <= 1, `neznámé klíče nesmí pokaždé stahovat klíče znovu (staženo ${stazeni - pred}×)`);
});
