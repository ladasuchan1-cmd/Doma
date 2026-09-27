'use strict';
// Integrační testy API: jméno při přihlášení (C9 – označení pro decided_by / audit), nová nastavení (C1, C10)
// a import „jen aktualizovat“ přes API i zdroj (C6).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./api-routes-helpers');
const auth = require('../src/server/auth');

/** Přihlášení s volitelným jménem → klient se session (nebo odpověď při chybě). */
async function loginAs(app, body) {
  const res = await fetch(app.url + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: H.PASSWORD, ...body }) });
  const text = await res.text();
  if (res.status !== 200) return { status: res.status, json: JSON.parse(text) };
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { status: 200, json: JSON.parse(text), client: H.client(app.url, { cookie }) };
}

test('API C9: jméno při přihlášení → ctx.user, decided_by, audit', async (t) => {
  const app = await H.startApp();
  t.after(() => app.stop());
  H.seedBasic(app.db);
  await app.session().post('/api/v1/runs', {});

  await t.test('přihlášení se jménem: /auth/me, schválení, audit', async () => {
    const jana = await loginAs(app, { name: '  Jana Nováková  ' });
    assert.equal(jana.status, 200);
    assert.deepEqual(jana.json, { ok: true });
    const me = await jana.client.get('/api/v1/auth/me');
    assert.equal(me.json.user, 'Jana Nováková');
    assert.equal(me.json.via, 'session');
    const list = await jana.client.get('/api/v1/proposals');
    const id = list.json.items[0].id;
    const r = await jana.client.post('/api/v1/proposals/approve', { ids: [id] });
    assert.equal(r.json.updated, 1);
    const p = (await jana.client.get('/api/v1/proposals?status=approved')).json.items.find((x) => x.id === id);
    assert.equal(p.decided_by, 'Jana Nováková');
    const audit = (await jana.client.get('/api/v1/audit')).json.items;
    assert.ok(audit.some((a) => a.action === 'auth.login' && a.actor === 'Jana Nováková'));
    assert.ok(audit.some((a) => a.action === 'proposals.approve' && a.actor === 'Jana Nováková'));
    // PATCH ruční ceny i zamítnutí nesou jméno
    const other = list.json.items[1].id;
    await jana.client.post('/api/v1/proposals/reject', { ids: [other] });
    const rej = (await jana.client.get('/api/v1/proposals?status=rejected')).json.items[0];
    assert.equal(rej.decided_by, 'Jana Nováková');
  });

  await t.test('bez jména / prázdné jméno → admin', async () => {
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: null }]) {
      const x = await loginAs(app, body);
      assert.equal(x.status, 200, JSON.stringify(body));
      assert.equal((await x.client.get('/api/v1/auth/me')).json.user, 'admin');
    }
  });

  await t.test('neplatné jméno → 400 s českou zprávou (nic se nepřihlásí)', async () => {
    for (const name of ['x'.repeat(65), 'Jana\nNováková', 'tab\tjméno', 'nul\u0000', 42, ['Jana'], 'auto', 'token:abc']) {
      const x = await loginAs(app, { name });
      assert.equal(x.status, 400, JSON.stringify(name));
      assert.match(x.json.error.message, /Jméno/);
    }
    // 64 znaků projde
    const ok = await loginAs(app, { name: 'Ž'.repeat(64) });
    assert.equal(ok.status, 200);
    assert.equal((await ok.client.get('/api/v1/auth/me')).json.user, 'Ž'.repeat(64));
    // špatné heslo se jménem je pořád 401
    const bad = await fetch(app.url + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'spatne', name: 'Jana' }) });
    assert.equal(bad.status, 401);
  });

  await t.test('jméno je součástí podepsané session (nejde podvrhnout), token má vlastní označení', async () => {
    const jana = await loginAs(app, { name: 'Jana' });
    const me = await jana.client.get('/api/v1/auth/me');
    assert.equal(me.json.user, 'Jana');
    // pozměněná session (jiné jméno bez podpisu) neplatí
    const forged = Buffer.from(JSON.stringify({ u: 'Šéf', exp: Date.now() + 3600e3, pv: 'x' })).toString('base64url') + '.podpis';
    const f = await H.client(app.url, { cookie: `${auth.SESSION_COOKIE}=${forged}` }).get('/api/v1/auth/me');
    assert.equal(f.status, 401);
    const tok = app.token(['read'], 'integrace');
    const tm = await tok.get('/api/v1/auth/me');
    assert.equal(tm.json.via, 'token');
    assert.notEqual(tm.json.user, 'Jana');
  });
});

test('API C1/C10: nastavení reject_memory_days, retention_superseded_days, export.pohoda.price_level_includes_vat', async (t) => {
  const app = await H.startApp();
  t.after(() => app.stop());
  const s = app.session();
  let r = await s.get('/api/v1/settings');
  assert.equal(r.json.reject_memory_days, 14);
  assert.equal(r.json.retention_superseded_days, 14);
  assert.equal(r.json.export.pohoda.price_level_includes_vat, true);
  r = await s.put('/api/v1/settings', { reject_memory_days: 30, retention_superseded_days: 7, export: { pohoda: { price_level_includes_vat: false } } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.reject_memory_days, 30);
  assert.equal(r.json.retention_superseded_days, 7);
  assert.equal(r.json.export.pohoda.price_level_includes_vat, false);
  assert.equal((await s.put('/api/v1/settings', { reject_memory_days: 0 })).json.reject_memory_days, 0, '0 = vypnuto');
  for (const bad of [-1, 366, 1.5, '7', null, true]) {
    r = await s.put('/api/v1/settings', { reject_memory_days: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.json.error.message, /Paměť zamítnutých cen|reject_memory_days/);
  }
  assert.equal((await app.token(['read']).put('/api/v1/settings', { reject_memory_days: 5 })).status, 403);
});

test('API C6: POST /import/products?create_missing=0 a zdroj s options.create_missing=false', async (t) => {
  const app = await H.startApp();
  t.after(() => app.stop());
  H.seedBasic(app.db);
  const s = app.session();
  const imp = app.token(['import']);
  const csv = 'kod;imprese_30\nP1;1234\nNEZNAMY-1;5\nP3;777\nNEZNAMY-2;1\n';
  const total = () => app.db.prepare('SELECT count(*) AS c FROM products').get().c;
  const before = total();

  let r = await imp.post('/api/v1/import/products?create_missing=0', csv, { headers: { 'Content-Type': 'text/csv' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.stats.created, 0);
  assert.equal(r.json.stats.updated, 2);
  assert.equal(r.json.stats.skipped_unknown, 2);
  assert.deepEqual(r.json.stats.unknown_codes, ['NEZNAMY-1', 'NEZNAMY-2']);
  assert.equal(total(), before);
  const p1 = app.db.prepare("SELECT attrs FROM products WHERE code = 'P1'").get();
  assert.equal(JSON.parse(p1.attrs).imprese_30, 1234);
  assert.equal(JSON.parse(p1.attrs).N, 'N2', 'ostatní atributy zůstaly');

  // zkušební běh, neplatná hodnota, výchozí chování
  r = await imp.post('/api/v1/import/products?create_missing=0&dry_run=1', csv, { headers: { 'Content-Type': 'text/csv' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.stats.skipped_unknown, 2);
  r = await imp.post('/api/v1/import/products?create_missing=mozna', csv, { headers: { 'Content-Type': 'text/csv' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /create_missing/);

  // zdroj „jen aktualizovat“ (bez URL – data se do něj posílají přes API)
  const src = await s.post('/api/v1/sources', { name: 'Imprese z Disiva', kind: 'products', options: { create_missing: false } });
  assert.ok(src.status === 200 || src.status === 201, src.text);
  const sid = src.json.id;
  assert.equal(src.json.options.create_missing, false);
  r = await imp.post(`/api/v1/import/products?source=${sid}`, csv, { headers: { 'Content-Type': 'text/csv' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.stats.skipped_unknown, 2);
  assert.equal(total(), before);
  // parametr požadavku přebije volbu zdroje
  r = await imp.post(`/api/v1/import/products?source=${sid}&create_missing=1`, csv, { headers: { 'Content-Type': 'text/csv' } });
  assert.equal(r.json.stats.created, 2);
  assert.equal(total(), before + 2);
  // neplatná volba zdroje → 400
  const bad = await s.post('/api/v1/sources', { name: 'Špatně', kind: 'products', options: { create_missing: 'možná' } });
  assert.equal(bad.status, 400);
});
