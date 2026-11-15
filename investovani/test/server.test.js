'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { vytvor, hashHesla, overHeslo } = require('../server.js');
const { yahoo, platnySym } = require('../trh.js');
const Z = require('../zdroje.js');
const PR = require('../preklad.js');

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
  const srv = vytvor({ dataDir, hash: opts.hash !== undefined ? opts.hash : hashHesla(HESLO), trustProxy: !!opts.trustProxy, hlidac: false, trh: opts.trh || falesnyTrh({}).trh, ted: opts.ted, preklad: opts.preklad || { dostupny: () => false, preloz: async () => { throw new Error('bez klíče'); } }, limitPrekladu: opts.limitPrekladu, zdroje: opts.zdroje || { stahni: async (u) => ({ adresa: u, text: '<html><head><style>a{}</style></head><body><h1>Kurz obchodování</h1><p>Naučíme vás vydělávat 5 % měsíčně. Zadejte e-mail a telefon a získáte analýzu zdarma.</p><script>x()</script></body></html>' }), prozkoumej: async (u) => ({ typ: /facebook/.test(u) ? 'facebook' : 'web', feed: /patria/.test(u) ? 'https://www.patria.cz/rss.html' : null }), novinky: async () => [{ titul: 'Zpráva', odkaz: 'https://www.patria.cz/z/1', kdy: 1794600000 }] } });
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

const VYSLEDEK = { jednou_vetou: 'Bitcoin spadl.', lidsky: 'Cena klesla a autor čeká další pokles.', pojmy: [{ pojem: 'bull trap', vyznam: 'Růst, který naláká kupce a pak se otočí.' }], kdo_to_rika: 'Neznámý autor.', tvrzeni: [{ text: 'Cena je 62 000 USD', druh: 'fakt', poznamka: 'Sedí s kurzem.' }], muj_pohled: 'Je to odhad.', co_s_tim: 'Krypto není v žádném z košů.', pozor: [] };

test('překladač na serveru: bez klíče neběží, s klíčem přeloží text i stránku, hlídá limit a délku', async () => {
  const bez = await spust();
  try {
    const { cookie } = await prihlas(bez.base);
    const H = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Inv': '1' };
    assert.equal((await (await fetch(bez.base + '/api/preklad', { headers: { Cookie: cookie } })).json()).dostupny, false);
    assert.equal((await fetch(bez.base + '/api/preklad', { method: 'POST', headers: H, body: '{"text":"cokoli"}' })).status, 503);
  } finally { await bez.zavri(); }

  const volani = [];
  const preklad = { dostupny: () => true, preloz: async (v) => { volani.push(v); if (/ODMITNI/.test(v.material)) throw Object.assign(new Error('x'), { kod: 'odmitnuto' }); return { vysledek: VYSLEDEK, model: 'claude-opus-5-5' }; } };
  const s = await spust({ preklad, limitPrekladu: 4 });
  try {
    assert.equal((await fetch(s.base + '/api/preklad')).status, 401);
    const { cookie } = await prihlas(s.base);
    const H = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Inv': '1' };
    const posli = (b, h = H) => fetch(s.base + '/api/preklad', { method: 'POST', headers: h, body: JSON.stringify(b) });
    assert.equal((await posli({ text: 'x' }, { Cookie: cookie, 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await posli({})).status, 400);
    assert.equal((await posli({ url: 'https://www.facebook.com/nekdo/' })).status, 400);
    assert.equal((await posli({ url: 'http://web.cz/' })).status, 400);
    assert.equal((await posli({ text: 'a'.repeat(40001) })).status, 413);
    assert.equal(volani.length, 0, 'odmítnuté požadavky se k modelu nedostanou a nepočítají se do limitu');

    const r = await posli({ text: 'Propad ceny bitcoinu se prohloubil na 62 000 USD.' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.vysledek, VYSLEDEK); assert.equal(j.zbyva, 3); assert.equal(j.zdroj, null);
    assert.match(volani[0].pokyn, /Jsi průvodce začínajícího investora/);
    assert.match(volani[0].pokyn, /Odpověz jen jedním objektem JSON/);
    assert.match(volani[0].kontext, /^Dnes je \d{4}-\d{2}-\d{2}\./);
    assert.match(volani[0].kontext, /NVDA\): 160 USD/, 'model dostane kurzy, které server zná');

    const w = await posli({ url: 'https://ai.finademica.com/?utm_source=facebook' });
    assert.equal(w.status, 200);
    assert.equal((await w.json()).zdroj, 'https://ai.finademica.com/?utm_source=facebook');
    assert.match(volani[1].material, /Kurz obchodování\nNaučíme vás vydělávat 5 % měsíčně/);
    assert.doesNotMatch(volani[1].material, /x\(\)|a\{\}/, 'skripty a styly se modelu neposílají');

    assert.equal((await posli({ text: 'ODMITNI' })).status, 422);
    const stav = await (await fetch(s.base + '/api/preklad', { headers: { Cookie: cookie } })).json();
    assert.deepEqual([stav.dostupny, stav.zbyva, stav.limit, stav.posledni.length], [true, 1, 4, 2], 'neúspěšný pokus se do limitu počítá, do historie ne');
    assert.equal((await posli({ text: 'čtvrtý' })).status, 200);
    assert.equal((await posli({ text: 'pátý' })).status, 429);
    assert.equal(volani.length, 4);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dataDir, 'preklady.json'), 'utf8')).pocet, 4);
  } finally { await s.zavri(); }
});

test('překladač: čtení odpovědi modelu, text ze stránky a volání Claude API', async () => {
  const cisty = JSON.stringify(VYSLEDEK);
  assert.deepEqual(PR.ctiOdpoved(cisty), VYSLEDEK);
  assert.deepEqual(PR.ctiOdpoved('Tady je výsledek:\n```json\n' + cisty + '\n```'), VYSLEDEK);
  assert.deepEqual(PR.ctiOdpoved('Výsledek: ' + cisty + ' Hotovo.'), VYSLEDEK);
  const divny = PR.ctiOdpoved(JSON.stringify({ lidsky: 'Text.', tvrzeni: [{ text: 'A', druh: 'věštba' }, { druh: 'fakt' }], pojmy: 'nic', pozor: ['x', 5], navic: 1 }));
  assert.deepEqual(divny, { jednou_vetou: '', lidsky: 'Text.', pojmy: [], kdo_to_rika: '', tvrzeni: [{ text: 'A', druh: 'odhad', poznamka: '' }], muj_pohled: '', co_s_tim: '', pozor: ['x'] });
  assert.throws(() => PR.ctiOdpoved('Nevím.'), (e) => e.kod === 'necitelna_odpoved');
  assert.throws(() => PR.ctiOdpoved('{"pojmy":[]}'), (e) => e.kod === 'necitelna_odpoved');
  assert.equal(PR.textZeStranky('<div><h1>Nadpis</h1><p>A &amp; B&nbsp;&#268;</p><script>zlo()</script><!-- skryté --></div>'), 'Nadpis\nA & B Č');
  assert.throws(() => PR.vytahniPokyn('<html></html>'));
  assert.match(PR.sestavZpravu({ material: 'M', zdroj: 'https://w.cz/', kontext: 'K' }), /^<kontext>\nK\n<\/kontext>\n\n<zdroj>https:\/\/w.cz\/<\/zdroj>\n\n<material>\nM\n<\/material>$/);

  assert.equal(PR.prekladac({ apiKey: '' }).dostupny(), false);
  await assert.rejects(PR.prekladac({ apiKey: '' }).preloz({ pokyn: 'P', material: 'M' }), (e) => e.kod === 'bez_klice');
  let pozadavek, odpoved = { stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: cisty }] };
  const klient = { beta: { messages: { create: async (p) => { pozadavek = p; return odpoved; } } } };
  const pr = PR.prekladac({ klient });
  assert.deepEqual((await pr.preloz({ pokyn: 'POKYN', material: 'MATERIÁL', kontext: 'Dnes je 2026-11-15.' })).vysledek, VYSLEDEK);
  assert.deepEqual([pozadavek.model, pozadavek.system, pozadavek.fallbacks, pozadavek.betas[0], pozadavek.output_config.effort, pozadavek.messages.length, pozadavek.messages[0].role], ['claude-opus-5-5', 'POKYN', 'default', 'server-side-fallback-2026-07-01', 'medium', 1, 'user']);
  assert.match(pozadavek.messages[0].content, /<material>\nMATERIÁL\n<\/material>/);
  assert.equal(pozadavek.thinking, undefined, 'na tomhle modelu se thinking neposílá, je vždy zapnuté');
  odpoved = { stop_reason: 'refusal', content: [] };
  await assert.rejects(pr.preloz({ pokyn: 'P', material: 'M' }), (e) => e.kod === 'odmitnuto');
  await assert.rejects(pr.preloz({ pokyn: 'P', material: 'x'.repeat(PR.MAX_ZNAKU + 1) }), (e) => e.kod === 'moc_dlouhe');
});
