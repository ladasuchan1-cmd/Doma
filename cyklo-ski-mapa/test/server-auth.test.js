'use strict';
// Testy přihlášení (server.js s CSM_USERS): login, cookie, ochrana stránek i API, odhlášení, „kdo“ u záznamů, brzda pokusů.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-auth-'));
process.env.CSM_STAV = path.join(tmp, 'stav.json');
process.env.CSM_USERS = 'jana:TajneHeslo1; petr:Heslo2';
process.env.CSM_TOKEN = 'token-pro-skripty';
process.env.CSM_TRUST_PROXY = '1';
delete process.env.CSM_AUTH;
const { server, parseUsers, safeNext } = require('../server.js');

let base;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function login(jmeno, heslo) {
  const res = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ jmeno, heslo, next: '/' }) });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { res, cookie };
}

test('parseUsers a safeNext', () => {
  const u = parseUsers('jana:a;petr:b,karel:c\nbez_hesla:\n:bez_jmena');
  assert.deepStrictEqual([...u.entries()], [['jana', 'a'], ['petr', 'b'], ['karel', 'c']]);
  assert.strictEqual(parseUsers('').size, 0);
  assert.strictEqual(safeNext('/x?y=1'), '/x?y=1');
  assert.strictEqual(safeNext('//cizi.web/'), '/');
  assert.strictEqual(safeNext('https://cizi.web/'), '/');
  assert.strictEqual(safeNext(null), '/');
});

test('bez přihlášení: stránka přesměruje na /login, assety a API vrací 401, health je veřejný', async () => {
  const idx = await fetch(base + '/', { redirect: 'manual' });
  assert.strictEqual(idx.status, 302);
  assert.match(idx.headers.get('location'), /^\/login\?next=/);
  assert.strictEqual((await fetch(base + '/app.js')).status, 401);
  assert.strictEqual((await fetch(base + '/data/mista.js')).status, 401);
  assert.strictEqual((await fetch(base + '/api/stav')).status, 401);
  assert.strictEqual((await fetch(base + '/api/health')).status, 200);
  const login = await fetch(base + '/login');
  assert.strictEqual(login.status, 200);
  assert.match(await login.text(), /Přihlaste se/);
  assert.strictEqual((await fetch(base + '/favicon.svg')).status, 200);
});

test('špatné heslo 401, správné nastaví HttpOnly cookie a přesměruje', async () => {
  const bad = await login('jana', 'spatne');
  assert.strictEqual(bad.res.status, 401);
  assert.match(await bad.res.text(), /Nesprávné jméno nebo heslo/);
  assert.strictEqual(bad.cookie, '');
  const ok = await login('jana', 'TajneHeslo1');
  assert.strictEqual(ok.res.status, 302);
  assert.strictEqual(ok.res.headers.get('location'), '/');
  const sc = ok.res.headers.get('set-cookie');
  assert.match(sc, /csm_session=/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  assert.ok(!/Secure/.test(sc), 'bez X-Forwarded-Proto https nesmí být Secure');
});

test('za HTTPS proxy je cookie Secure', async () => {
  const res = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-Proto': 'https' }, body: new URLSearchParams({ jmeno: 'petr', heslo: 'Heslo2' }) });
  assert.match(res.headers.get('set-cookie'), /Secure/);
});

test('přihlášený uživatel: stránka, data (gzip), /api/me, zápis nese kdo, odhlášení cookie zruší', async () => {
  const { cookie } = await login('jana', 'TajneHeslo1');
  const headers = { Cookie: cookie };
  const idx = await fetch(base + '/', { headers });
  assert.strictEqual(idx.status, 200);
  assert.match(idx.headers.get('content-security-policy') || '', /default-src 'self'/);
  const js = await fetch(base + '/lib/stav.js', { headers: { ...headers, 'Accept-Encoding': 'gzip' } });
  assert.strictEqual(js.status, 200);
  assert.strictEqual(js.headers.get('content-encoding'), 'gzip');
  assert.match(await js.text(), /normalizeRecord/); // fetch rozbalí
  const lm = js.headers.get('last-modified');
  const notMod = await fetch(base + '/lib/stav.js', { headers: { ...headers, 'If-Modified-Since': lm } });
  assert.strictEqual(notMod.status, 304);
  const me = await (await fetch(base + '/api/me', { headers })).json();
  assert.deepStrictEqual({ jmeno: me.jmeno, prihlaseni: me.prihlaseni }, { jmeno: 'jana', prihlaseni: true });
  const put = await fetch(base + '/api/stav/n77', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ volano: true, kdo: 'podvrh' }) });
  assert.deepStrictEqual(await put.json(), { ok: true, kdo: 'jana' });
  const rec = await (await fetch(base + '/api/stav/n77', { headers })).json();
  assert.strictEqual(rec.kdo, 'jana');
  assert.strictEqual(rec.volano, true);
  // hromadný import doplní kdo jen tam, kde chybí
  await fetch(base + '/api/stav', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ stav: { n78: { navsteva: true }, n79: { navsteva: true, kdo: 'petr', upraveno: '2030-01-01T00:00:00Z' } } }) });
  const all = await (await fetch(base + '/api/stav', { headers })).json();
  assert.strictEqual(all.stav.n78.kdo, 'jana');
  assert.strictEqual(all.stav.n79.kdo, 'petr');
  const out = await fetch(base + '/logout', { headers, redirect: 'manual' });
  assert.strictEqual(out.status, 302);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  const fake = await fetch(base + '/api/me', { headers: { Cookie: 'csm_session=abc.def' } });
  assert.strictEqual(fake.status, 401);
});

test('Bearer token pro skripty, neznámý token ne', async () => {
  const ok = await fetch(base + '/api/stav', { headers: { Authorization: 'Bearer token-pro-skripty' } });
  assert.strictEqual(ok.status, 200);
  const bad = await fetch(base + '/api/stav', { headers: { Authorization: 'Bearer jiny' } });
  assert.strictEqual(bad.status, 401);
  const me = await (await fetch(base + '/api/me', { headers: { Authorization: 'Bearer token-pro-skripty' } })).json();
  assert.strictEqual(me.jmeno, 'api');
});

test('brzda: po 10 špatných pokusech 429', async () => {
  for (let i = 0; i < 10; i++) {
    const r = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': '203.0.113.9' }, body: new URLSearchParams({ jmeno: 'jana', heslo: 'ne' }) });
    assert.strictEqual(r.status, 401);
  }
  const blocked = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': '203.0.113.9' }, body: new URLSearchParams({ jmeno: 'jana', heslo: 'TajneHeslo1' }) });
  assert.strictEqual(blocked.status, 429);
  // jiná adresa není dotčená
  const other = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': '203.0.113.10' }, body: new URLSearchParams({ jmeno: 'jana', heslo: 'TajneHeslo1' }) });
  assert.strictEqual(other.status, 302);
});
