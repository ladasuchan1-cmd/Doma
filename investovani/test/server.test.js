'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { vytvor, hashHesla, overHeslo } = require('../server.js');

const HESLO = 'zkusebni-heslo-1';
const OBCHOD = { t: 'ČEZ', d: '2026-11-16', mode: 'paper', size: 2000, entry: 100, stop: 95, target: 112, fees: 0, why: 'Zkouška deníku.' };

async function spust(opts = {}) {
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'inv-'));
  const srv = vytvor({ dataDir, hash: opts.hash !== undefined ? opts.hash : hashHesla(HESLO), trustProxy: !!opts.trustProxy });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = 'http://127.0.0.1:' + srv.address().port;
  return { base, dataDir, zavri: () => new Promise((ok) => srv.close(ok)) };
}
async function prihlas(base, heslo = HESLO, extra = {}) {
  const r = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, extra), body: 'heslo=' + encodeURIComponent(heslo) });
  const c = (r.headers.get('set-cookie') || '').split(';')[0];
  return { r, cookie: c };
}

test('otisk hesla: správné projde, špatné a rozbitý otisk ne', async () => {
  const h = hashHesla('M@ty@s 2024 ěšč');
  assert.match(h, /^scrypt:\d+:\d+:\d+:[^:]+:[^:]+$/);
  assert.equal(await overHeslo('M@ty@s 2024 ěšč', h), true);
  assert.equal(await overHeslo('M@ty@s 2024', h), false);
  assert.equal(await overHeslo('cokoli', ''), false);
  assert.equal(await overHeslo('cokoli', 'scrypt:1:1:1:aa:bb'), false);
});

test('bez přihlášení: stránka přesměruje na login, API vrátí 401, health je veřejný', async () => {
  const s = await spust();
  try {
    const r = await fetch(s.base + '/', { redirect: 'manual' });
    assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/login');
    assert.equal((await fetch(s.base + '/api/trades')).status, 401);
    const post = await fetch(s.base + '/api/trades', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Inv': '1' }, body: JSON.stringify(OBCHOD) });
    assert.equal(post.status, 401);
    const h = await (await fetch(s.base + '/api/health')).json();
    assert.deepEqual({ ok: h.ok, heslo: h.heslo, denik: h.denik }, { ok: true, heslo: true, denik: true });
    const login = await fetch(s.base + '/login');
    assert.equal(login.status, 200);
    assert.match(await login.text(), /name="heslo"/);
  } finally { await s.zavri(); }
});

test('přihlášení: špatné heslo 401, správné nastaví cookie a pustí na stránku', async () => {
  const s = await spust();
  try {
    const zle = await prihlas(s.base, 'spatne');
    assert.equal(zle.r.status, 401); assert.equal(zle.cookie, '');
    const ok = await prihlas(s.base);
    assert.equal(ok.r.status, 303); assert.match(ok.cookie, /^inv_s=\d+\./);
    assert.match(ok.r.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    const st = await fetch(s.base + '/', { headers: { Cookie: ok.cookie } });
    assert.equal(st.status, 200);
    const html = await st.text();
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /window\.__INV_SERVER=1/);
    assert.match(html, /Prvních 10 000 na burze/);
    assert.equal((html.match(/<title>/g) || []).length, 1, 'titulek jen jednou');
    assert.match(st.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    // podvržená cookie neprojde
    assert.equal((await fetch(s.base + '/api/trades', { headers: { Cookie: 'inv_s=99999999999999.abc' } })).status, 401);
  } finally { await s.zavri(); }
});

test('bez nastaveného hesla se nejde přihlásit', async () => {
  const s = await spust({ hash: '' });
  try {
    assert.equal((await prihlas(s.base, '')).r.status, 503);
    assert.equal((await prihlas(s.base, 'cokoli')).r.status, 503);
    assert.equal((await (await fetch(s.base + '/api/health')).json()).heslo, false);
  } finally { await s.zavri(); }
});

test('brzda: po deseti špatných pokusech 429 i pro správné heslo, jiná adresa projde', async () => {
  const s = await spust({ trustProxy: true });
  try {
    for (let i = 0; i < 10; i++) assert.equal((await prihlas(s.base, 'zle' + i, { 'X-Forwarded-For': '203.0.113.5' })).r.status, 401);
    assert.equal((await prihlas(s.base, HESLO, { 'X-Forwarded-For': '203.0.113.5' })).r.status, 429);
    assert.equal((await prihlas(s.base, HESLO, { 'X-Forwarded-For': '203.0.113.6' })).r.status, 303);
  } finally { await s.zavri(); }
});

test('deník: zápis, uzavření, smazání a uložení na disk', async () => {
  const s = await spust();
  try {
    const { cookie } = await prihlas(s.base);
    const H = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Inv': '1' };
    // bez vlastní hlavičky se nezapíše
    assert.equal((await fetch(s.base + '/api/trades', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(OBCHOD) })).status, 403);
    // neplatný obchod: stop nad nákupem, chybí důvod
    assert.equal((await fetch(s.base + '/api/trades', { method: 'POST', headers: H, body: JSON.stringify(Object.assign({}, OBCHOD, { stop: 101 })) })).status, 400);
    assert.equal((await fetch(s.base + '/api/trades', { method: 'POST', headers: H, body: JSON.stringify(Object.assign({}, OBCHOD, { why: ' ' })) })).status, 400);
    assert.equal((await fetch(s.base + '/api/trades', { method: 'POST', headers: H, body: '{' })).status, 400);

    const r = await fetch(s.base + '/api/trades', { method: 'POST', headers: H, body: JSON.stringify(Object.assign({ navic: 'x', id: 'podvrh' }, OBCHOD)) });
    assert.equal(r.status, 201);
    const o = (await r.json()).trade;
    assert.match(o.id, /^[0-9a-f]{16}$/); assert.equal(o.exit, null); assert.equal(o.navic, undefined);

    let seznam = (await (await fetch(s.base + '/api/trades', { headers: { Cookie: cookie } })).json()).trades;
    assert.equal(seznam.length, 1); assert.equal(seznam[0].t, 'ČEZ');

    assert.equal((await fetch(s.base + '/api/trades/' + o.id, { method: 'PATCH', headers: H, body: JSON.stringify({ exit: 0, xd: '2026-11-20' }) })).status, 400);
    assert.equal((await fetch(s.base + '/api/trades/0000000000000000', { method: 'PATCH', headers: H, body: JSON.stringify({ exit: 110, xd: '2026-11-20' }) })).status, 404);
    const u = await fetch(s.base + '/api/trades/' + o.id, { method: 'PATCH', headers: H, body: JSON.stringify({ exit: 110, xd: '2026-11-20', lesson: 'Držet se plánu.', size: 999999 }) });
    assert.equal(u.status, 200);
    const po = (await u.json()).trade;
    assert.equal(po.exit, 110); assert.equal(po.size, 2000, 'uzavření nemění velikost pozice');

    const naDisku = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'denik.json'), 'utf8'));
    assert.equal(naDisku.trades[0].lesson, 'Držet se plánu.');

    assert.equal((await fetch(s.base + '/api/trades/' + o.id, { method: 'DELETE', headers: H })).status, 200);
    seznam = (await (await fetch(s.base + '/api/trades', { headers: { Cookie: cookie } })).json()).trades;
    assert.equal(seznam.length, 0);
  } finally { await s.zavri(); }
});

test('deník přežije restart a nečitelný soubor se nepřepíše', async () => {
  const s = await spust();
  const { cookie } = await prihlas(s.base);
  const H = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Inv': '1' };
  await fetch(s.base + '/api/trades', { method: 'POST', headers: H, body: JSON.stringify(OBCHOD) });
  await s.zavri();

  const s2 = await spust({ dataDir: s.dataDir });
  try {
    // cookie platí i po restartu (klíč je ve složce s daty)
    const seznam = (await (await fetch(s2.base + '/api/trades', { headers: { Cookie: cookie } })).json()).trades;
    assert.equal(seznam.length, 1);
  } finally { await s2.zavri(); }

  fs.writeFileSync(path.join(s.dataDir, 'denik.json'), '{rozbité');
  const s3 = await spust({ dataDir: s.dataDir });
  try {
    assert.equal((await (await fetch(s3.base + '/api/health')).json()).denik, false);
    const r = await fetch(s3.base + '/api/trades', { method: 'POST', headers: H, body: JSON.stringify(OBCHOD) });
    assert.equal(r.status, 503);
    assert.equal(fs.readFileSync(path.join(s.dataDir, 'denik.json'), 'utf8'), '{rozbité');
  } finally { await s3.zavri(); }
});

test('odhlášení zruší cookie', async () => {
  const s = await spust();
  try {
    const { cookie } = await prihlas(s.base);
    const r = await fetch(s.base + '/logout', { method: 'POST', redirect: 'manual', headers: { Cookie: cookie } });
    assert.equal(r.status, 303);
    assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  } finally { await s.zavri(); }
});
