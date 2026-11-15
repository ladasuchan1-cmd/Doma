'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { vytvor, hashHesla, overHeslo } = require('../server.js');
const { yahoo, platnySym } = require('../trh.js');
const Z = require('../zdroje.js');

const HESLO = 'zkusebni-heslo-1';
const OBCHOD = { t: 'ČEZ', d: '2026-11-16', mode: 'paper', size: 2000, entry: 100, stop: 95, target: 112, fees: 0, why: 'Zkouška deníku.' };

// Zdroj cen pro testy: žádná síť, ceny se mění přes `ceny`, čas kurzu přes `cas` (výchozí = právě teď).
function falesnyTrh(ceny, extra = {}) {
  const stav = { ceny: Object.assign({ 'VWCE.DE': 170, NVDA: 160, 'CEZ.PR': 1340, MSFT: 520, AMD: 530 }, ceny), cas: null, volani: 0 };
  const kurz = async (sym) => {
    stav.volani++;
    if (!(sym in stav.ceny)) throw Object.assign(new Error('neznámý'), { kod: 'neznamy' });
    return { sym, nazev: 'Firma ' + sym, burza: 'Test', mena: sym.endsWith('.PR') ? 'CZK' : 'USD', typ: 'EQUITY', cena: stav.ceny[sym], cas: stav.cas != null ? stav.cas : Math.floor(Date.now() / 1000) + 1, predchozi: 100, zmena: stav.ceny[sym] / 100 - 1, nahled: [1, 2, 3] };
  };
  const trh = Object.assign({ kurz, graf: async (sym, r) => Object.assign(await kurz(sym), { rozsah: r, body: [[1, 1], [2, 2]] }), hledej: async (q) => (q.length < 2 ? [] : [{ sym: 'AAPL', nazev: 'Apple', burza: 'NasdaqGS', typ: 'EQUITY' }]) }, extra);
  return { trh, stav };
}

async function spust(opts = {}) {
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'inv-'));
  const srv = vytvor({ dataDir, hash: opts.hash !== undefined ? opts.hash : hashHesla(HESLO), trustProxy: !!opts.trustProxy, hlidac: false, trh: opts.trh || falesnyTrh({}).trh, ted: opts.ted, zdroje: opts.zdroje || { prozkoumej: async (u) => ({ typ: /facebook/.test(u) ? 'facebook' : 'web', feed: /patria/.test(u) ? 'https://www.patria.cz/rss.html' : null }), novinky: async () => [{ titul: 'Zpráva', odkaz: 'https://www.patria.cz/z/1', kdy: 1794600000 }] } });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = 'http://127.0.0.1:' + srv.address().port;
  return { base, dataDir, srv, zavri: () => new Promise((ok) => srv.close(ok)) };
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

test('trh: kurzy sledovaných, přidání a odebrání titulu, benchmark zůstává', async () => {
  const f = falesnyTrh({ AAPL: 250 });
  const s = await spust({ trh: f.trh });
  try {
    assert.equal((await fetch(s.base + '/api/trh')).status, 401);
    const { cookie } = await prihlas(s.base);
    const H = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Inv': '1' };
    let j = await (await fetch(s.base + '/api/trh', { headers: { Cookie: cookie } })).json();
    assert.deepEqual(j.sledovane, ['VWCE.DE', 'NVDA', 'CEZ.PR', 'MSFT', 'AMD']);
    assert.equal(j.benchmark, 'VWCE.DE');
    assert.equal(j.kurzy.find((k) => k.sym === 'NVDA').cena, 160);
    assert.equal(j.kurzy.find((k) => k.sym === 'NVDA').cerstvy, true);

    assert.equal((await fetch(s.base + '/api/trh/sledovane', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"sym":"AAPL"}' })).status, 403);
    assert.equal((await fetch(s.base + '/api/trh/sledovane', { method: 'POST', headers: H, body: '{"sym":"NEEXISTUJE"}' })).status, 404);
    assert.equal((await fetch(s.base + '/api/trh/sledovane', { method: 'POST', headers: H, body: '{"sym":"../etc"}' })).status, 400);
    assert.equal((await fetch(s.base + '/api/trh/sledovane', { method: 'POST', headers: H, body: '{"sym":"aapl"}' })).status, 201);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dataDir, 'sledovane.json'), 'utf8')).syms.slice(-1), ['AAPL']);
    assert.equal((await fetch(s.base + '/api/trh/sledovane/VWCE.DE', { method: 'DELETE', headers: H })).status, 409);
    assert.equal((await fetch(s.base + '/api/trh/sledovane/NVDA', { method: 'DELETE', headers: H })).status, 200);
    j = await (await fetch(s.base + '/api/trh', { headers: { Cookie: cookie } })).json();
    assert.deepEqual(j.sledovane, ['VWCE.DE', 'CEZ.PR', 'MSFT', 'AMD', 'AAPL']);

    assert.equal((await fetch(s.base + '/api/trh/graf?s=NVDA&r=1mo', { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(s.base + '/api/trh/graf?s=NVDA&r=100y', { headers: { Cookie: cookie } })).status, 400);
    assert.equal((await (await fetch(s.base + '/api/trh/hledej?q=app', { headers: { Cookie: cookie } })).json()).vysledky[0].sym, 'AAPL');
  } finally { await s.zavri(); }
});

test('trh: titul, kterému zdroj spadne, nevyprázdní přehled ostatních', async () => {
  const f = falesnyTrh({});
  delete f.stav.ceny.MSFT;
  const s = await spust({ trh: f.trh });
  try {
    const { cookie } = await prihlas(s.base);
    const j = await (await fetch(s.base + '/api/trh', { headers: { Cookie: cookie } })).json();
    assert.equal(j.kurzy.length, 5);
    assert.equal(j.kurzy.find((k) => k.sym === 'MSFT').chyba, 'neznamy');
    assert.equal(j.kurzy.find((k) => k.sym === 'NVDA').cena, 160);
  } finally { await s.zavri(); }
});

test('zkušební nákup: cena ze zdroje, ne od klienta; při zavřené burze se neprovede', async () => {
  const f = falesnyTrh({});
  const s = await spust({ trh: f.trh });
  try {
    const { cookie } = await prihlas(s.base);
    const H = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Inv': '1' };
    const telo = { sym: 'NVDA', size: 2000, stopPct: 5, targetPct: 10, why: 'Zkouška', entry: 1, price: 1 };
    f.stav.cas = Math.floor(Date.now() / 1000) - 3600; // hodinu starý kurz = zavřeno
    const zavreno = await fetch(s.base + '/api/trh/koupit', { method: 'POST', headers: H, body: JSON.stringify(telo) });
    assert.equal(zavreno.status, 409); assert.equal((await zavreno.json()).chyba, 'trh_zavreny');
    f.stav.cas = null;
    assert.equal((await fetch(s.base + '/api/trh/koupit', { method: 'POST', headers: H, body: JSON.stringify(Object.assign({}, telo, { why: '' })) })).status, 400);
    assert.equal((await fetch(s.base + '/api/trh/koupit', { method: 'POST', headers: H, body: JSON.stringify(Object.assign({}, telo, { stopPct: 0 })) })).status, 400);
    assert.equal((await fetch(s.base + '/api/trh/koupit', { method: 'POST', headers: H, body: JSON.stringify(Object.assign({}, telo, { sym: 'NEEXISTUJE' })) })).status, 404);
    const r = await fetch(s.base + '/api/trh/koupit', { method: 'POST', headers: H, body: JSON.stringify(telo) });
    assert.equal(r.status, 201);
    const o = (await r.json()).trade;
    assert.equal(o.entry, 160); assert.equal(o.stop, 152); assert.equal(o.target, 176);
    assert.deepEqual([o.mode, o.auto, o.sym, o.cur, o.bSym, o.bEntry, o.exit], ['paper', true, 'NVDA', 'USD', 'VWCE.DE', 170, null]);
    assert.match(o.d, /^\d{4}-\d{2}-\d{2}$/);
  } finally { await s.zavri(); }
});

test('hlídač: mezi stopem a cílem nic, pod stopem uzavře za skutečný kurz, na cíli také', async () => {
  const f = falesnyTrh({});
  const s = await spust({ trh: f.trh });
  try {
    const { cookie } = await prihlas(s.base);
    const H = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Inv': '1' };
    const kup = (sym) => fetch(s.base + '/api/trh/koupit', { method: 'POST', headers: H, body: JSON.stringify({ sym, size: 2000, stopPct: 5, targetPct: 10, why: 'Zkouška' }) }).then((r) => r.json());
    const a = (await kup('NVDA')).trade, b = (await kup('AMD')).trade;
    const seznam = async () => (await (await fetch(s.base + '/api/trades', { headers: { Cookie: cookie } })).json()).trades;

    f.stav.ceny.NVDA = 155; f.stav.ceny.AMD = 560;
    assert.equal(await s.srv.zkontrolujObchody(), 0, 'uvnitř pásma se nic neděje');

    f.stav.cas = Math.floor(Date.now() / 1000) - 3600; f.stav.ceny.NVDA = 100;
    assert.equal(await s.srv.zkontrolujObchody(), 0, 'starý kurz (zavřená burza) nic neuzavírá');

    f.stav.cas = null; f.stav.ceny.NVDA = 140; f.stav.ceny.AMD = 590; f.stav.ceny['VWCE.DE'] = 171.7;
    assert.equal(await s.srv.zkontrolujObchody(), 2);
    const po = await seznam();
    const na = po.find((x) => x.id === a.id), nb = po.find((x) => x.id === b.id);
    assert.deepEqual([na.exit, na.autoClose, na.bExit], [140, 'stop', 171.7], 'skok pod stop = prodej za kurz, ne za stop 152');
    assert.deepEqual([nb.exit, nb.autoClose], [590, 'cil']);
    assert.match(na.xd, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(await s.srv.zkontrolujObchody(), 0, 'uzavřené se podruhé neuzavírají');
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dataDir, 'denik.json'), 'utf8')).trades.length, 2);
  } finally { await s.zavri(); }
});

test('zkušební prodej: za aktuální kurz, jen otevřený automatický obchod', async () => {
  const f = falesnyTrh({});
  const s = await spust({ trh: f.trh });
  try {
    const { cookie } = await prihlas(s.base);
    const H = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Inv': '1' };
    const o = (await (await fetch(s.base + '/api/trh/koupit', { method: 'POST', headers: H, body: JSON.stringify({ sym: 'CEZ.PR', size: 2500, stopPct: 4, targetPct: 8, why: 'Zkouška' }) })).json()).trade;
    const rucni = (await (await fetch(s.base + '/api/trades', { method: 'POST', headers: H, body: JSON.stringify(OBCHOD) })).json()).trade;
    assert.equal((await fetch(s.base + '/api/trades/' + rucni.id + '/prodat', { method: 'POST', headers: H })).status, 409, 'ruční zápis se neprodává za kurz');
    assert.equal((await fetch(s.base + '/api/trades/' + o.id + '/prodat', { method: 'POST', headers: { Cookie: cookie } })).status, 403);
    f.stav.ceny['CEZ.PR'] = 1360;
    const r = await fetch(s.base + '/api/trades/' + o.id + '/prodat', { method: 'POST', headers: H });
    assert.equal(r.status, 200);
    const po = (await r.json()).trade;
    assert.deepEqual([po.exit, po.autoClose, po.cur], [1360, 'rucne', 'CZK']);
    assert.equal((await fetch(s.base + '/api/trades/' + o.id + '/prodat', { method: 'POST', headers: H })).status, 409);
  } finally { await s.zavri(); }
});

test('zdroj Yahoo: čtení odpovědi, mezipaměť, poslední známá data při výpadku, neznámý titul', async () => {
  assert.equal(platnySym('CEZ.PR'), true); assert.equal(platnySym('../x'), false); assert.equal(platnySym(''), false);
  let volani = 0, rezim = 'ok', cas = 1000000;
  const odpoved = { chart: { result: [{ meta: { currency: 'USD', regularMarketPrice: 162.85, previousClose: 166.19, regularMarketTime: 1794603601, regularMarketDayHigh: 170, regularMarketDayLow: 158.39, fiftyTwoWeekHigh: 243.37, fiftyTwoWeekLow: 148.8, fullExchangeName: 'NasdaqGS', longName: 'NVIDIA Corporation', instrumentType: 'EQUITY', currentTradingPeriod: { regular: { start: 1, end: 2 } } }, timestamp: [10, 20, 30, 40], indicators: { quote: [{ close: [160, null, 161.5, 162.85] }] } }] } };
  const falesnyFetch = async (url) => {
    volani++;
    if (rezim === 'pad') throw new Error('síť');
    if (url.includes('/chart/NIC')) return { status: 404, ok: false, json: async () => ({}) };
    if (url.includes('/search')) return { status: 200, ok: true, json: async () => ({ quotes: [{ symbol: 'CEZ.PR', longname: 'CEZ, a. s.', exchDisp: 'Prague', quoteType: 'EQUITY' }, { symbol: 'X', quoteType: 'OPTION' }, { symbol: 'špatný symbol', quoteType: 'EQUITY' }] }) };
    return { status: 200, ok: true, json: async () => odpoved };
  };
  const y = yahoo({ fetch: falesnyFetch, ted: () => cas });
  const k = await y.kurz('NVDA');
  assert.deepEqual([k.cena, k.predchozi, k.mena, k.nazev, k.burza], [162.85, 166.19, 'USD', 'NVIDIA Corporation', 'NasdaqGS']);
  assert.ok(Math.abs(k.zmena - (162.85 / 166.19 - 1)) < 1e-12);
  assert.deepEqual(k.nahled, [160, 161.5, 162.85], 'prázdné body se vynechají');
  assert.equal(k.body, undefined);
  await y.kurz('NVDA'); await y.graf('NVDA', '1d');
  assert.equal(volani, 1, 'do minuty jde ven jediný dotaz');
  cas += 61 * 1000; rezim = 'pad';
  const stary = await y.kurz('NVDA');
  assert.deepEqual([stary.cena, stary.stare], [162.85, true], 'při výpadku poslední známý kurz, označený jako starý');
  rezim = 'ok';
  await assert.rejects(y.kurz('NIC'), (e) => e.kod === 'neznamy');
  await assert.rejects(y.graf('NVDA', '99y'), (e) => e.kod === 'neznamy');
  assert.deepEqual(await y.hledej('cez'), [{ sym: 'CEZ.PR', nazev: 'CEZ, a. s.', burza: 'Prague', typ: 'EQUITY' }]);
  assert.deepEqual(await y.hledej('c'), []);
});

test('zdroje: výchozí příklad, přidání webu s novinkami a Facebooku jen jako odkazu, odebrání', async () => {
  const s = await spust();
  try {
    assert.equal((await fetch(s.base + '/api/zdroje')).status, 401);
    const { cookie } = await prihlas(s.base);
    const H = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Inv': '1' };
    const seznam = async () => (await (await fetch(s.base + '/api/zdroje', { headers: { Cookie: cookie } })).json()).zdroje;
    let z = await seznam();
    assert.equal(z.length, 1); assert.equal(z[0].typ, 'facebook'); assert.equal(z[0].novinky, null);
    assert.match(z[0].pozn, /74,37 %/);

    const pridej = (b) => fetch(s.base + '/api/zdroje', { method: 'POST', headers: H, body: JSON.stringify(b) });
    assert.equal((await pridej({ url: 'http://nezabezpeceny.cz/', nazev: 'X', pozn: 'Y' })).status, 400);
    assert.equal((await pridej({ url: 'https://127.0.0.1/', nazev: 'X', pozn: 'Y' })).status, 400);
    assert.equal((await pridej({ url: 'https://www.patria.cz/', nazev: 'Patria', pozn: '' })).status, 400, 'bez popisu, kdo to je, se zdroj nepřidá');
    assert.equal((await fetch(s.base + '/api/zdroje', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const r = await pridej({ url: 'https://www.patria.cz/', nazev: 'Patria', pozn: 'Investiční portál a broker.' });
    assert.equal(r.status, 201);
    const novy = (await r.json()).zdroj;
    assert.equal(novy.feed, 'https://www.patria.cz/rss.html');
    assert.equal((await pridej({ url: 'https://www.patria.cz/', nazev: 'Patria', pozn: 'Znovu.' })).status, 409);
    assert.equal((await pridej({ url: 'https://www.facebook.com/nekdo/', nazev: 'Někdo', pozn: 'Prodává kurzy.' })).status, 201);

    z = await seznam();
    assert.equal(z.length, 3);
    assert.equal(z.find((x) => x.nazev === 'Patria').novinky[0].titul, 'Zpráva');
    assert.equal(z.find((x) => x.nazev === 'Někdo').novinky, null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dataDir, 'zdroje.json'), 'utf8')).zdroje.length, 3);

    assert.equal((await fetch(s.base + '/api/zdroje/' + novy.id, { method: 'DELETE', headers: H })).status, 200);
    assert.equal((await fetch(s.base + '/api/zdroje/' + novy.id, { method: 'DELETE', headers: H })).status, 404);
    assert.equal((await seznam()).length, 2);
  } finally { await s.zavri(); }
});

test('čtení zdrojů: RSS i Atom, hledání kanálu ve stránce, zákaz vnitřní sítě, sociální sítě bez stahování', async () => {
  const rss = `<?xml version="1.0"?><rss><channel><title>Kanál</title>
    <item><title><![CDATA[Akcie &amp; dluhopisy <b>rostou</b>]]></title><link>https://web.cz/a?x=1&amp;y=2</link><pubDate>Fri, 13 Nov 2026 10:00:00 GMT</pubDate></item>
    <item><title>Star&#353;&#237; zpr&#225;va</title><link>/b</link><pubDate>Thu, 12 Nov 2026 10:00:00 GMT</pubDate></item>
    <item><title>Bez odkazu</title></item><item><title>Zlý odkaz</title><link>javascript:alert(1)</link></item></channel></rss>`;
  const p = Z.ctiFeed(rss, 'https://web.cz/rss');
  assert.deepEqual(p.map((x) => [x.titul, x.odkaz]), [['Akcie & dluhopisy rostou', 'https://web.cz/a?x=1&y=2'], ['Starší zpráva', 'https://web.cz/b']]);
  assert.equal(p[0].kdy, Date.parse('2026-11-13T10:00:00Z') / 1000);
  const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Video</title><link rel="alternate" href="https://youtube.com/watch?v=1"/><published>2026-11-10T08:00:00+00:00</published></entry></feed>';
  assert.deepEqual(Z.ctiFeed(atom, 'https://youtube.com/feed'), [{ titul: 'Video', odkaz: 'https://youtube.com/watch?v=1', kdy: 1794297600 }]);
  assert.equal(Z.jeFeed(rss), true); assert.equal(Z.jeFeed('<!doctype html><html>'), false);
  assert.equal(Z.najdiFeed('<head><link rel="stylesheet" href="/a.css"><link rel="alternate" type="application/rss+xml" href="/rss.xml"></head>', 'https://web.cz/clanky/'), 'https://web.cz/rss.xml');
  assert.equal(Z.najdiFeed('<head></head>', 'https://web.cz/'), null);
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.18.9.31', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.equal(Z.soukroma(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1']) assert.equal(Z.soukroma(ip), false, ip);
  assert.equal(Z.platnaAdresa('http://web.cz/'), null); assert.equal(Z.platnaAdresa('https://uzivatel:heslo@web.cz/'), null); assert.equal(Z.platnaAdresa('https://localhost/'), null); assert.equal(Z.platnaAdresa('https://web.cz:8443/'), null);
  assert.equal(Z.typZdroje('www.facebook.com'), 'facebook'); assert.equal(Z.typZdroje('x.com'), 'socialni'); assert.equal(Z.typZdroje('notfacebook.com'), 'web');

  let volani = 0;
  const sit = async (url) => { volani++;
    if (url === 'https://web.cz/') return { status: 200, ok: true, headers: new Map(), arrayBuffer: async () => Buffer.from('<link rel="alternate" type="application/atom+xml" href="https://web.cz/atom">') };
    if (url === 'https://web.cz/atom') return { status: 200, ok: true, headers: new Map(), arrayBuffer: async () => Buffer.from(atom) };
    if (url === 'https://presmeruje.cz/') return { status: 302, ok: false, headers: new Map([['location', 'https://vnitrni.cz/']]) };
    return { status: 404, ok: false, headers: new Map() };
  };
  const dnsMock = async (h) => [{ address: h === 'vnitrni.cz' ? '10.0.0.5' : '93.184.216.34' }];
  const c = Z.zdroje({ fetch: sit, lookup: dnsMock });
  assert.deepEqual(await c.prozkoumej('https://web.cz/'), { typ: 'web', feed: 'https://web.cz/atom' });
  assert.deepEqual(await c.prozkoumej('https://www.facebook.com/purpletrading.cz/'), { typ: 'facebook', feed: null });
  assert.equal(volani, 1, 'na Facebook se server vůbec neptá');
  assert.equal((await c.novinky('https://web.cz/atom'))[0].titul, 'Video');
  await c.novinky('https://web.cz/atom'); assert.equal(volani, 2, 'titulky jsou čtvrt hodiny v mezipaměti');
  await assert.rejects(c.prozkoumej('https://vnitrni.cz/'), (e) => e.kod === 'zakazana_adresa');
  await assert.rejects(c.prozkoumej('https://presmeruje.cz/'), (e) => e.kod === 'zakazana_adresa', 'přesměrování do vnitřní sítě neprojde');
  assert.deepEqual(await c.prozkoumej('https://neexistuje-web.cz/'), { typ: 'web', feed: null }, 'web, který neodpovídá, jde přidat jako odkaz');
});
