'use strict';
// Testy serveru (server.js): statické soubory, API stavu oslovení, ochrana cest.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-stav-'));
process.env.CSM_STAV = path.join(tmp, 'stav.json');
process.env.CSM_TOKEN = '';
process.env.CSM_AUTH = '0'; // přihlášení testuje server-auth.test.js
const { server, writeStav, STAV_FILE } = require('../server.js');

let base;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('health a prázdný stav', async () => {
  const h = await (await fetch(base + '/api/health')).json();
  assert.deepStrictEqual({ ok: h.ok, zaznamu: h.zaznamu, zapis: h.zapis }, { ok: true, zaznamu: 0, zapis: true });
  const s = await (await fetch(base + '/api/stav')).json();
  assert.strictEqual(s.app, 'cyklo-ski-mapa');
  assert.deepStrictEqual(s.stav, {});
});

test('PUT záznamu, čtení, smazání prázdným záznamem, zápis na disk', async () => {
  const rec = { kontaktovat: true, poznamka: 'zavolat v pondělí', pujcovna: 'ano', upraveno: '2026-10-03T10:00:00.000Z', datumy: { kontaktovat: '2026-10-03' } };
  let res = await fetch(base + '/api/stav/n123', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec) });
  assert.strictEqual(res.status, 200);
  const got = await (await fetch(base + '/api/stav/n123')).json();
  assert.strictEqual(got.kontaktovat, true);
  assert.strictEqual(got.poznamka, 'zavolat v pondělí');
  assert.strictEqual(got.pujcovna, 'ano');
  const all = await (await fetch(base + '/api/stav')).json();
  assert.deepStrictEqual(Object.keys(all.stav), ['n123']);
  writeStav();
  const onDisk = JSON.parse(fs.readFileSync(STAV_FILE, 'utf8'));
  assert.strictEqual(onDisk.stav.n123.kontaktovat, true);
  // prázdný záznam = smazání
  res = await fetch(base + '/api/stav/n123', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(res.status, 200);
  const after = await (await fetch(base + '/api/stav')).json();
  assert.deepStrictEqual(after.stav, {});
});

test('hromadné sloučení PUT /api/stav – vyhrává novější', async () => {
  await fetch(base + '/api/stav/w5', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ volano: true, upraveno: '2026-10-02T00:00:00Z' }) });
  const res = await fetch(base + '/api/stav', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stav: { w5: { navsteva: true, upraveno: '2026-10-03T00:00:00Z' }, 'osk-abc': { kontaktovat: true, upraveno: '2026-10-03T00:00:00Z' }, spatne: { kontaktovat: true } } }) });
  assert.strictEqual(res.status, 200);
  const all = await (await fetch(base + '/api/stav')).json();
  assert.strictEqual(all.stav.w5.navsteva, true);
  assert.strictEqual(all.stav.w5.volano, false);
  assert.ok(all.stav['osk-abc']);
  assert.strictEqual(all.stav.spatne, undefined);
  await fetch(base + '/api/stav/w5', { method: 'DELETE' });
  await fetch(base + '/api/stav/osk-abc', { method: 'DELETE' });
});

test('neplatné vstupy', async () => {
  assert.strictEqual((await fetch(base + '/api/stav/../x', { method: 'PUT', body: '{}' })).status === 200, false);
  assert.strictEqual((await fetch(base + '/api/stav/nesmysl', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
  assert.strictEqual((await fetch(base + '/api/stav/n1', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{neplatny json' })).status, 400);
  assert.strictEqual((await fetch(base + '/api/neco')).status, 404);
  assert.strictEqual((await fetch(base + '/api/stav', { method: 'PATCH' })).status, 405);
});

test('statické soubory a zakázané cesty', async () => {
  const idx = await fetch(base + '/');
  assert.strictEqual(idx.status, 200);
  assert.match(idx.headers.get('content-type'), /text\/html/);
  assert.match(await idx.text(), /Cyklo &amp; Ski mapa/);
  const js = await fetch(base + '/lib/stav.js');
  assert.strictEqual(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.strictEqual((await fetch(base + '/server.js')).status, 404);
  assert.strictEqual((await fetch(base + '/test/server.test.js')).status, 404);
  assert.strictEqual((await fetch(base + '/tools/build-data.js')).status, 404);
  assert.strictEqual((await fetch(base + '/.gitignore')).status, 404);
  // %2e%2e normalizuje už URL parser na kořen; package.json, deploy.sh ani Dockerfile se neservírují
  assert.strictEqual((await fetch(base + '/%2e%2e/package.json')).status, 404);
  assert.strictEqual((await fetch(base + '/..%2fpackage.json')).status, 404);
  assert.strictEqual((await fetch(base + '/deploy.sh')).status, 404);
  assert.strictEqual((await fetch(base + '/Dockerfile')).status, 404);
  assert.strictEqual((await fetch(base + '/deploy/docker-compose.yml')).status, 404);
  assert.strictEqual((await fetch(base + '/login', { redirect: 'manual' })).status, 302); // vypnuté přihlášení → zpět na /
  assert.strictEqual((await fetch(base + '/neexistuje.html')).status, 404);
  assert.strictEqual((await fetch(base + '/', { method: 'POST' })).status, 405);
});
