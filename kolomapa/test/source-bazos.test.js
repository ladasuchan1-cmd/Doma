'use strict';
// Zdroj Bazoš – parsery nad reálnými (anonymizovanými) vzorky a průchod výpisu proti falešnému Bazoši (offline).
// HTTP jde přes skutečný src/util/http.js s podvrženým fetch → testuje se i práce se stavovými kódy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const bazos = require('../src/sources/bazos');
const { createHttp } = require('../src/util/http');

const FIX = path.join(__dirname, 'fixtures', 'bazos');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const readText = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const LIST = readJson('api_list_horska.json');
const DETAIL_TPL = readJson('api_detail_224568683.json');
const CAT = Object.fromEntries(bazos.CATEGORIES.map((c) => [c.key, c]));
const PERSONAL = ['name', 'phone', 'phone_id', 'email_id', 'showName', 'sellerLogin', 'userId', 'user_id', 'sellerKey'];

// ---------------------------------------------------------------- falešný Bazoš

const pragueFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const pragueStr = (ms) => pragueFmt.format(new Date(ms)).replace('T', ' ');
const fmtCzk = (n) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} Kč`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** n syntetických položek API výpisu (prvních `tops` TOP, pak od nejnovější), ID klesají od firstId. */
function synthItems(n, { firstId = 224600000, tops = 0, from = Date.parse('2026-10-02T15:00:00+02:00'), cat = CAT.horska } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const tpl = LIST[i % LIST.length];
    const id = String(firstId - i);
    const host = cat.host;
    out.push({
      ...tpl,
      id,
      url: `https://${host}/inzerat/${id}/kolo-${id}.php`,
      title: `Kolo ${id}`,
      topped: i < tops ? 'true' : 'false',
      from: pragueStr(from - i * 600e3),
      price_formatted: fmtCzk(5000 + i * 100),
      image_thumbnail: `https://www.bazos.cz/img/1m/${id.slice(-3)}/${id}.jpg`,
      views: String(10 + i),
    });
  }
  return out;
}

/** HTML stránka výpisu ve stejné podobě jako sport.bazos.cz (z položek API). */
function renderListHtml(items, offset, total, cat) {
  const blocks = items.map((x) => {
    const p = new URL(x.url).pathname;
    const top = x.topped === 'true' ? '<span title="TOP 4x Platí do 21.10. 2026" class="ztop">TOP</span> - ' : '';
    const [y, m, d] = String(x.from).slice(0, 10).split('-').map(Number);
    const img = /empty/.test(x.image_thumbnail) ? 'https://www.bazos.cz/obrazky/empty.gif' : `https://www.bazos.cz/img/1t/${x.id.slice(-3)}/${x.id}.jpg`;
    return `<div class="inzeraty inzeratyflex">
<div class="inzeratynadpis"><a href="${p}"><img src="${img}" class="obrazek" alt="${esc(x.title)}" width="170" height="128"></a>
<h2 class=nadpis><a href="${p}">${esc(x.title)}</a></h2><span class=velikost10> - ${top}[${d}.${m}. ${y}]</span><br>
<div class=popis>Popis inzerátu ${x.id} ...</div><br><br>
</div>
<div class="inzeratycena"><b><span translate="no">  ${esc(x.price_formatted)}</span></b></div>
<div class="inzeratylok">${esc(x.locality)}<br>602 00</div>
<div class="inzeratyview">${x.views} x</div>
<div class="inzeratyakce"><span onclick="odeslatakci('rating','0','0','REDACTED');return false;" class="akce paction">Ohodnotit uživatele</span></div>
</div>`;
  });
  const next = offset + 20 < total ? ` <a href="${cat.path}${offset + 20}/"><b>Další</b></a>` : '';
  const totalTxt = String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `<!DOCTYPE html><html><body><div class="maincontent">
<div class="listainzerat inzeratyflex"><div class="inzeratynadpis"> Zobrazeno ${offset + 1}-${offset + items.length} inzerátů z ${totalTxt}</div></div>
${blocks.join('\n\n')}
<br><div class="strankovani">Stránka: <b><span class=cisla>${offset / 20 + 1}</span></b>${next}</div><br><br><br>
</div></body></html>`;
}

/** Detail API vytvořený z položky výpisu (podle reálné šablony, bez osobních údajů). */
function detailFor(x, catId = '256') {
  const id = String(x.id);
  return {
    ...DETAIL_TPL,
    id,
    title: x.title,
    url: x.url,
    price_formatted: x.price_formatted,
    price: /\d/.test(x.price_formatted) ? x.price_formatted.replace(/\D/g, '') : x.price_formatted,
    price_type: /\d/.test(x.price_formatted) ? 'EXACT' : 'NEGOTIATED',
    topped: x.topped === 'true',
    from: new Date(bazos.pragueLocalToIso(x.from)).toUTCString(), // detail má RFC 2822 („Fri, 02 Oct 2026 …“)
    locality: x.locality,
    category: { id: catId, title: 'X', url: 'x' },
    description: `Plný popis inzerátu č. ${id.slice(-4)}.\r\nDruhý řádek.`,
    images: [`https://www.bazos.cz/img/1/${id.slice(-3)}/${id}.jpg`, `https://www.bazos.cz/img/2/${id.slice(-3)}/${id}.jpg`],
  };
}

/**
 * Falešný web: lists = {kategorieApi: [položky]}, apiCap = API vrací jen prvních N položek kategorie,
 * pageSize = kolik položek API vrátí na stránku (méně než limit 200 → test posunu offsetu), routes = přepsané URL.
 */
function fakeSite({ lists = {}, apiCap = Infinity, pageSize = 20, details = {}, routes = {} } = {}) {
  return (url) => {
    if (routes[url] !== undefined) return typeof routes[url] === 'function' ? routes[url](url) : routes[url];
    const u = new URL(url);
    if (u.pathname === '/api/v1/ads.php') {
      const all = (lists[u.searchParams.get('category')] || []).slice(0, apiCap);
      const off = Number(u.searchParams.get('offset'));
      assert.equal(u.searchParams.get('limit'), '200');
      return { body: all.slice(off, off + pageSize) };
    }
    if (u.pathname === '/api/v1/ad-detail-2.php') {
      const id = u.searchParams.get('ad_id');
      if (details[id] !== undefined) return details[id];
      for (const [catId, items] of Object.entries(lists)) {
        const x = items.find((it) => it.id === id);
        if (x) return { body: detailFor(x, catId) };
      }
      return { status: 410, body: { idad: id, status: 'deleted' } };
    }
    const cat = bazos.CATEGORIES.find((c) => c.host === u.host && u.pathname.startsWith(c.path));
    if (cat) {
      const all = lists[cat.id] || [];
      const off = Number((/\/(\d+)\/$/.exec(u.pathname) || [])[1] || 0);
      const items = all.slice(off, off + 20);
      return { status: items.length || !off ? 200 : 404, body: renderListHtml(items, off, all.length, cat) };
    }
    return { status: 404, body: '<html>Stránka nenalezena</html>' };
  };
}

/** Výpisy pro všechny kategorie: chybějící kategorie dostanou pár starších inzerátů (prázdná kategorie s koly = neúplný průchod). */
function withAll(lists, n = 3) {
  const out = lists;
  bazos.CATEGORIES.forEach((c, i) => {
    if (!out[c.id]) out[c.id] = synthItems(n, { firstId: 210000000 + i * 1000, cat: c, from: Date.parse('2026-09-01T12:00:00+02:00') });
  });
  return out;
}
const FILLER = (given) => bazos.CATEGORIES.filter((c) => !given.includes(c.id)).length * 3;

function makeHttp(handler) {
  const calls = [];
  const http = createHttp({
    delayMs: 0,
    retries: 0,
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      calls.push(url);
      const r = (await handler(url)) || { status: 404, body: 'Not found' };
      const isText = typeof r.body === 'string';
      const res = new Response(isText ? r.body : JSON.stringify(r.body), {
        status: r.status ?? 200,
        headers: { 'content-type': isText ? 'text/html; charset=utf-8' : 'application/json' },
      });
      if (r.finalUrl) Object.defineProperty(res, 'url', { value: r.finalUrl }); // výsledek přesměrování
      return res;
    },
  });
  return { http, calls };
}

function makeLog() {
  const warns = [];
  return { warns, log: { debug() {}, info() {}, warn: (m) => warns.push(m), error: (m) => warns.push(m) } };
}

/** ctx jako v pipeline; „DB“ = Map sourceId → {price, title, detail_at}. */
function makeCtx(http, { mode = 'full', maxPages = 400, minPrice = 500, known = new Map() } = {}) {
  const { log, warns } = makeLog();
  const emitted = [];
  const ctx = {
    http,
    log,
    config: {},
    mode,
    maxPages,
    minPrice,
    isKnown: (id) => known.get(String(id)) || null,
    emit: async (item) => {
      emitted.push(item);
      const prev = known.get(item.sourceId);
      const changed = !prev || prev.priceCzk !== item.priceCzk || prev.title !== item.title;
      known.set(item.sourceId, { priceCzk: item.priceCzk, title: item.title, detail_at: prev?.detail_at ?? null });
      return { isNew: !prev, changed };
    },
  };
  return { ctx, emitted, known, warns };
}

const apiCalls = (calls, catId) => calls.filter((u) => u.includes('/api/v1/ads.php') && u.endsWith(`category=${catId}`));
const htmlCalls = (calls) => calls.filter((u) => !u.includes('/api/'));

// ---------------------------------------------------------------- parsery

test('parsePrice: čísla, slovní ceny, zástupné 1 Kč, jiná měna', () => {
  const p = bazos.parsePrice;
  assert.deepEqual(p('170 000 Kč'), { priceCzk: 170000, priceNote: null });
  assert.deepEqual(p('  5 900 Kč'), { priceCzk: 5900, priceNote: null });
  assert.deepEqual(p('1\u00a0999 Kč'), { priceCzk: 1999, priceNote: null });
  assert.deepEqual(p('Dohodou'), { priceCzk: null, priceNote: 'Dohodou' });
  assert.deepEqual(p('Nabídněte'), { priceCzk: null, priceNote: 'Nabídněte' });
  assert.deepEqual(p('V textu'), { priceCzk: null, priceNote: 'V textu' });
  assert.deepEqual(p('Nerozhoduje'), { priceCzk: null, priceNote: 'Nerozhoduje' });
  assert.deepEqual(p('Zdarma'), { priceCzk: null, priceNote: 'Zdarma' });
  assert.equal(p('1 Kč').priceCzk, null);
  assert.match(p('1 Kč').priceNote, /1 Kč/);
  assert.equal(p('0 Kč').priceCzk, null);
  assert.deepEqual(p('', { price: '3000', priceType: 'EXACT' }), { priceCzk: 3000, priceNote: null });
  assert.deepEqual(p('', { price: 'x', priceType: 'NEGOTIATED' }), { priceCzk: null, priceNote: 'Dohodou' });
  assert.equal(p('150 €', { currency: 'EUR' }).priceCzk, null);
});

test('pragueLocalToIso: pražský čas → UTC včetně přechodů letního času (porovnání s Intl)', () => {
  assert.equal(bazos.pragueLocalToIso('2026-10-02 15:22:25'), '2026-10-02T13:22:25.000Z');
  assert.equal(bazos.pragueLocalToIso('2026-01-15 12:00:00'), '2026-01-15T11:00:00.000Z');
  assert.equal(bazos.pragueLocalToIso('2026-03-29 01:30:00'), '2026-03-29T00:30:00.000Z'); // ještě zimní čas
  assert.equal(bazos.pragueLocalToIso('2026-03-29 03:30:00'), '2026-03-29T01:30:00.000Z'); // už letní
  assert.equal(bazos.pragueLocalToIso('2026-10-25 03:30:00'), '2026-10-25T02:30:00.000Z'); // zase zimní
  assert.equal(bazos.pragueLocalToIso('nesmysl'), null);
  assert.equal(bazos.pragueLocalToIso('2026-13-01 10:00:00'), null);
  // náhodné okamžiky v letech 2025–2027: zpětný převod přes Intl musí sedět
  for (let i = 0; i < 300; i++) {
    const t = Date.UTC(2025, 0, 1) + Math.floor(((i * 7919) % 1000) / 1000 * 3 * 365 * 86400) * 1000;
    const local = pragueStr(t);
    const iso = bazos.pragueLocalToIso(local);
    assert.equal(pragueStr(Date.parse(iso)), local, `${local} → ${iso}`);
  }
});

test('parseApiList: reálný výpis – TOP bez data, ceny, fotky v plné velikosti, žádné osobní údaje', () => {
  const rows = bazos.parseApiList(LIST, CAT.horska);
  assert.equal(rows.length, LIST.length);
  const tops = rows.filter((r) => r.isTop);
  assert.equal(tops.length, 6);
  for (const r of tops) assert.equal(r.item.postedAt, undefined, 'TOP inzerát nesmí mít postedAt (from = čas požadavku)');
  const first = rows.find((r) => r.item.sourceId === '224568683').item;
  assert.deepEqual(
    { ...first },
    {
      sourceId: '224568683',
      url: 'https://sport.bazos.cz/inzerat/224568683/horske-kolo-giant-talon-1-ge.php',
      title: 'horské kolo Giant Talon 1 GE',
      priceCzk: 3000,
      priceNote: null,
      categorySrc: 'Horská kola',
      locationText: 'Brno venkov',
      views: first.views,
      detailComplete: false,
      postedAt: '2026-10-02T13:23:16.000Z',
      photoUrl: first.photoUrl,
    }
  );
  assert.match(first.photoUrl, /^https:\/\/www\.bazos\.cz\/img\/1\/683\/224568683\.jpg/);
  const notes = rows.map((r) => r.item.priceNote).filter(Boolean);
  for (const n of ['Dohodou', 'Nabídněte', 'V textu', 'Nerozhoduje', 'Zdarma']) assert.ok(notes.includes(n), n);
  assert.ok(notes.some((n) => /1 Kč/.test(n)));
  const noPhoto = rows.find((r) => r.item.photoCount === 0);
  assert.ok(noPhoto && !noPhoto.item.photoUrl, 'empty.gif → bez fotky');
  for (const r of rows) {
    assert.equal(typeof r.item.views, 'number');
    for (const k of PERSONAL) assert.equal(r.item[k], undefined);
    if (!r.isTop) assert.match(r.item.postedAt, /^2026-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
  }
});

test('parseApiList: odolnost vůči změnám typů (topped bool/řetězec, čísla, chybějící pole)', () => {
  const base = LIST.find((x) => x.topped === 'false');
  const rows = bazos.parseApiList(
    [
      { ...base, id: Number(base.id), topped: true, views: 12 }, // číselné ID, bool topped
      { ...base, topped: 'false', views: undefined },
      { ...base, id: 'abc' }, // neplatné ID → vynechat
      { ...base, url: 'https://example.com/inzerat/1/x.php' }, // cizí doména → vynechat
      null,
    ],
    CAT.horska
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].isTop, true);
  assert.equal(rows[0].item.views, 12);
  assert.equal(rows[0].item.postedAt, undefined);
  assert.equal(rows[1].item.views, undefined);
  assert.throws(() => bazos.parseApiList({ error: 'x' }, CAT.horska), /není pole/);
});

test('parseApiDetail: reálné detaily – popis, PSČ, souřadnice, fotky, prodejce; smazaný → gone', () => {
  const d = bazos.parseApiDetail(readJson('api_detail_224568683.json'), '224568683');
  assert.equal(d.gone, false);
  const it = d.item;
  assert.equal(it.sourceId, '224568683');
  assert.equal(it.url, 'https://sport.bazos.cz/inzerat/224568683/horske-kolo-giant-talon-1-ge.php');
  assert.equal(it.priceCzk, 3000);
  assert.equal(it.psc, '66431');
  assert.equal(it.locationText, 'Brno venkov');
  assert.equal(it.lat, 49.289978);
  assert.equal(it.lon, 16.575022);
  assert.equal(it.photoUrl, 'https://www.bazos.cz/img/1/683/224568683.jpg?t=1790947693');
  assert.equal(it.photoCount, 1);
  assert.equal(it.categorySrc, 'Horská kola');
  assert.equal(it.sellerType, 'private');
  assert.equal(it.postedAt, '2026-10-02T13:23:16.000Z');
  assert.equal(it.detailComplete, true);
  assert.ok(!/\r/.test(it.description) && it.description.includes('\n• Rám:'), 'popis s \\n místo \\r\\n');
  for (const k of PERSONAL) assert.equal(it[k], undefined);
  assert.equal(it.params, undefined, 'Bazoš nemá strukturované parametry');

  const top = bazos.parseApiDetail(readJson('api_detail_224261387.json'), '224261387').item;
  assert.equal(top.postedAt, undefined, 'TOP: from = čas požadavku');
  assert.equal(top.categorySrc, 'Elektrokola');
  assert.equal(top.photoCount, 2);

  const offer = bazos.parseApiDetail(readJson('api_detail_224568396.json'), '224568396').item;
  assert.deepEqual([offer.priceCzk, offer.priceNote], [null, 'Nabídněte']);

  const kids = bazos.parseApiDetail(readJson('api_detail_223881673.json'), '223881673');
  assert.equal(kids.item.categorySrc, 'Dětská kola');
  assert.equal(kids.categoryId, '456');

  const live = bazos.parseApiDetail(readJson('api_detail_222078536.json'), '222078536').item;
  assert.equal(live.title, 'Junior horské kolo Superior Team 26 (vel. rámu 14" / XS)');
  assert.ok(live.psc && live.lat && live.lon);

  assert.deepEqual(bazos.parseApiDetail(readJson('api_detail_deleted.json'), '200000001'), { gone: true });
  // pole s jedním objektem (starší tvar odpovědi) i nesouhlasné ID
  assert.equal(bazos.parseApiDetail([readJson('api_detail_224568683.json')], '224568683').item.priceCzk, 3000);
  assert.throws(() => bazos.parseApiDetail(readJson('api_detail_224568683.json'), '111111111'), /jiný inzerát/);
  // chybová / neznámá odpověď nesmí projít jako „hotový detail“
  assert.throws(() => bazos.parseApiDetail({ status: 'error', message: 'x' }, '224568683'), /neočekávaný stav/);
  assert.throws(() => bazos.parseApiDetail({}, '224568683'), /neočekávaný stav/);
});

test('sellerTypeOf: firemní znaky v textu, počet inzerátů nad limit běžného uživatele', () => {
  const s = bazos.sellerTypeOf;
  assert.equal(s('Prodám kolo, málo jeté', 3), 'private');
  assert.equal(s('Možno odečíst DPH, vystavíme fakturu s DPH', 1), 'company');
  assert.equal(s('Kolo k vidění na naší prodejně v Brně', 1), 'company');
  assert.equal(s('Prodej na IČO možný', 1), 'company');
  assert.equal(s('Velikosti skladem: S, M, L', 1), 'company');
  assert.equal(s('Bike Shop s.r.o., Brno', 1), 'company');
  assert.equal(s('Kupováno 2.5.2023 v Sport Cyklo s.r.o. Holešov, doklad', 1), 'private');
  assert.equal(s('Koupeno za 40 000 Kč vč. DPH', 2), 'private');
  assert.equal(s('Prodejní cena 5 000 Kč, nabízíme i přilbu', 2), 'private');
  assert.equal(s('Prodám kolo', 50), 'private');
  assert.equal(s('Prodám kolo', 161), 'company');
});

test('parseListHtml: reálné stránky – 1. stránka (TOP, „Další“) a poslední stránka', () => {
  const p1 = bazos.parseListHtml(readText('list_horska_p1.html'), 'https://sport.bazos.cz/horska/', CAT.horska);
  assert.equal(p1.ok, true);
  assert.equal(p1.items.length, 20);
  assert.equal(p1.first, 1);
  assert.equal(p1.total, 11946);
  assert.equal(p1.next, 'https://sport.bazos.cz/horska/20/');
  assert.ok(p1.items.every((r) => r.isTop), '1. stránka jsou samé TOP');
  const a = p1.items[0].item;
  assert.equal(a.sourceId, '224210521');
  assert.equal(a.url, 'https://sport.bazos.cz/inzerat/224210521/spark-rc-world-cup-black-zaruka.php');
  assert.equal(a.title, 'SPARK RC WORLD CUP BLACK-ZÁRUKA');
  assert.equal(a.priceCzk, 170000);
  assert.equal(a.locationText, 'Pelhřimov');
  assert.equal(a.psc, '39301');
  assert.equal(a.views, 267);
  assert.equal(a.photoUrl, 'https://www.bazos.cz/img/1/521/224210521.jpg?t=1790714486');
  assert.match(a.description, /^Prodám top zavodní střelu SCOTT SPARK[\s\S]* …$/);
  assert.ok(p1.items.some((r) => r.item.priceNote === 'Nerozhoduje'));

  const last = bazos.parseListHtml(readText('list_horska_last.html'), 'https://sport.bazos.cz/horska/11940/', CAT.horska);
  assert.equal(last.items.length, 3);
  assert.equal(last.first, 11941);
  assert.equal(last.total, 11943);
  assert.equal(last.next, null);
  assert.equal(last.items[0].isTop, false);
  assert.equal(last.items[0].dayDate, '2026-08-03');
  assert.equal(last.items[0].item.title, 'Junior horské kolo Superior Team 26 (vel. rámu 14" / XS)');
  for (const r of [...p1.items, ...last.items]) for (const k of PERSONAL) assert.equal(r.item[k], undefined);
});

// ---------------------------------------------------------------- průchod výpisu

test('scan (celý průchod): API po stránkách až do prázdné stránky + ověření konce přes HTML', async () => {
  const kids = synthItems(7, { firstId: 224500000, tops: 1, cat: CAT.detska });
  const { http, calls } = makeHttp(fakeSite({ lists: withAll({ 256: LIST, 456: kids }) }));
  const { ctx, emitted, warns } = makeCtx(http, { mode: 'full', minPrice: 500 });
  const res = await bazos.scan(ctx);
  assert.deepEqual(res, { complete: true });
  // horská: 31 položek po 20 → offset 0, 20, 31 (prázdná) – posun o skutečný počet položek
  assert.deepEqual(apiCalls(calls, 256).map((u) => new URL(u).searchParams.get('offset')), ['0', '20', '31']);
  for (const c of bazos.CATEGORIES) assert.ok(apiCalls(calls, c.id).length >= 1, c.label);
  // ověřovací HTML stránka na konci každé kategorie (horská od 20, dětská od 0)
  assert.ok(htmlCalls(calls).includes('https://sport.bazos.cz/horska/20/'));
  assert.ok(htmlCalls(calls).includes('https://deti.bazos.cz/kola/'));
  assert.equal(htmlCalls(calls).length, bazos.CATEGORIES.length);
  // 499 Kč je pod minimální cenou → přeskočeno; 1 Kč (cena neuvedena) zůstává
  const ids = emitted.map((x) => x.sourceId);
  assert.equal(new Set(ids).size, ids.length, 'žádné duplicity');
  assert.equal(ids.length, LIST.length - 1 + kids.length + FILLER(['256', '456']));
  assert.ok(!emitted.some((x) => x.priceCzk === 499));
  assert.ok(emitted.some((x) => /1 Kč/.test(x.priceNote || '')));
  assert.ok(emitted.filter((x) => x.categorySrc === 'Dětská kola').length === 7);
  assert.ok(emitted.every((x) => x.url && x.title && x.detailComplete === false));
  assert.deepEqual(warns, []);
});

test('scan (celý průchod): API vrátí jen část výpisu → pokračuje HTML stránkami až na konec', async () => {
  const items = synthItems(95, { tops: 5 });
  const { http, calls } = makeHttp(fakeSite({ lists: withAll({ 256: items }), apiCap: 40 }));
  const { ctx, emitted, warns } = makeCtx(http, { mode: 'full' });
  const res = await bazos.scan(ctx);
  assert.equal(res.complete, true);
  assert.deepEqual(
    htmlCalls(calls).filter((u) => u.includes('/horska/')),
    ['https://sport.bazos.cz/horska/20/', 'https://sport.bazos.cz/horska/40/', 'https://sport.bazos.cz/horska/60/', 'https://sport.bazos.cz/horska/80/']
  );
  const horska = emitted.filter((x) => x.categorySrc === 'Horská kola');
  assert.equal(horska.length, 95);
  const fromHtml = horska.find((x) => x.sourceId === items[60].id);
  assert.equal(fromHtml.psc, '60200', 'HTML výpis dává PSČ');
  assert.match(fromHtml.description, /…$/);
  assert.ok(fromHtml.postedAt, 'nový ne-TOP inzerát z HTML dostane datum (den)');
  assert.ok(warns.some((w) => /API nevrátilo celý výpis/.test(w)));
});

test('scan (jen novinky): skončí po 2 stránkách samých známých inzerátů, TOP nahoře se nepočítají', async () => {
  const known = new Map();
  const items = synthItems(120, { tops: 6 });
  {
    const { http } = makeHttp(fakeSite({ lists: withAll({ 256: items }) }));
    const { ctx } = makeCtx(http, { mode: 'full', known });
    assert.equal((await bazos.scan(ctx)).complete, true);
  }
  // 5 nových ne-TOP inzerátů za TOP blokem
  const fresh = synthItems(5, { firstId: 224700000 });
  const next = [...items.slice(0, 6), ...fresh, ...items.slice(6)];
  const { http, calls } = makeHttp(fakeSite({ lists: withAll({ 256: next }) }));
  const { ctx, emitted } = makeCtx(http, { mode: 'incremental', known });
  const res = await bazos.scan(ctx);
  assert.equal(res.complete, false, 'inkrementální průchod nikdy není úplný');
  // stránka 1: 6 TOP + 5 nových + 9 známých → ne; 2 a 3: samé známé → konec
  assert.equal(apiCalls(calls, 256).length, 3);
  assert.equal(htmlCalls(calls).length, 0, 'bez HTML ověření');
  for (const f of fresh) assert.ok(emitted.some((x) => x.sourceId === f.id));
  // změna ceny známého inzerátu na 2. stránce → stránka se nepočítá jako „stará“
  const changed = next.map((x, i) => (i === 25 ? { ...x, price_formatted: '1 234 Kč' } : x));
  const h2 = makeHttp(fakeSite({ lists: withAll({ 256: changed }) }));
  const c2 = makeCtx(h2.http, { mode: 'incremental', known });
  await bazos.scan(c2.ctx);
  assert.equal(apiCalls(h2.calls, 256).length, 4);
});

test('scan: respektuje ctx.maxPages (neúplný průchod)', async () => {
  const items = synthItems(70, { tops: 2 });
  const { http, calls } = makeHttp(fakeSite({ lists: withAll({ 256: items }) }));
  const { ctx, emitted, warns } = makeCtx(http, { mode: 'full', maxPages: 2 });
  const res = await bazos.scan(ctx);
  assert.equal(res.complete, false);
  assert.equal(apiCalls(calls, 256).length, 2);
  assert.equal(emitted.filter((x) => x.categorySrc === 'Horská kola').length, 40);
  assert.ok(warns.some((w) => /limit 2 stránek/.test(w)));
});

test('scan: captcha / „Příliš mnoho dotazů“ místo JSONu → okamžitý konec s českou hláškou, žádné další požadavky', async () => {
  const blockPage = '<html><body><h1>Příliš mnoho dotazů</h1><p>Ověření, že nejste robot: <div class="g-recaptcha"></div></p></body></html>';
  const { http, calls } = makeHttp(fakeSite({ lists: { 256: LIST }, routes: { [bazos.apiListUrl(CAT.horska, 20)]: { body: blockPage } } }));
  const { ctx, emitted } = makeCtx(http);
  await assert.rejects(bazos.scan(ctx), (e) => e instanceof bazos.BazosBlockedError && /zablokoval/.test(e.message));
  assert.equal(calls.length, 2, 'po blokaci už žádná další kategorie');
  assert.equal(emitted.length, 19, '1. stránka (20 položek, jedna pod minimální cenou)');
  // detail se stejným ctx už nic nestahuje
  await assert.rejects(bazos.detail(ctx, { source_id: '224568683', url: LIST[6].url }), /zablokoval/);
  assert.equal(calls.length, 2);
});

test('scan: HTTP 403 = blokace', async () => {
  const { http } = makeHttp(() => ({ status: 403, body: 'Forbidden' }));
  const { ctx } = makeCtx(http);
  await assert.rejects(bazos.scan(ctx), /zablokoval.*HTTP 403/);
});

test('scan: API kategorie nefunguje → záloha přes HTML výpis; chyba jiné kategorie nezastaví ostatní', async () => {
  const ebikes = synthItems(30, { firstId: 224400000, tops: 3 });
  const silnicni = synthItems(45, { firstId: 224300000 });
  const site = fakeSite({
    lists: { 465: ebikes, 257: silnicni, 256: LIST },
    routes: {
      [bazos.apiListUrl(CAT.elektrokola, 0)]: { status: 404, body: '<html>Not found</html>' }, // API pryč → HTML
      [bazos.apiListUrl(CAT.silnicni, 20)]: { status: 500, body: 'Internal error' }, // výpadek uprostřed
    },
  });
  const { http, calls } = makeHttp(site);
  const { ctx, emitted, warns } = makeCtx(http, { mode: 'full' });
  await assert.rejects(bazos.scan(ctx), /Silniční kola: HTTP 500/);
  assert.equal(emitted.filter((x) => x.categorySrc === 'Elektrokola').length, 30, 'elektrokola celá z HTML');
  assert.deepEqual(htmlCalls(calls).filter((u) => u.includes('elektrokola')), ['https://sport.bazos.cz/elektrokola/', 'https://sport.bazos.cz/elektrokola/20/']);
  assert.equal(emitted.filter((x) => x.categorySrc === 'Silniční kola').length, 20);
  assert.ok(emitted.some((x) => x.categorySrc === 'Ostatní cyklistika') || apiCalls(calls, 259).length === 1, 'pokračuje dalšími kategoriemi');
  assert.ok(emitted.filter((x) => x.categorySrc === 'Horská kola').length > 0);
  assert.ok(warns.some((w) => /API nefunguje/.test(w)));
});

// ---------------------------------------------------------------- pojistky proti falešně „úplnému“ průchodu
// (úplný průchod = pipeline označí neviděné inzeráty jako zmizelé → chyba tady maže živé inzeráty z mapy)

/** HTML stránka, jakou Bazoš vrací pro NEEXISTUJÍCÍ kategorii (ověřeno živě): HTTP 404, ale s výpisem celé sekce Sport. */
const sectionPage404 = () => ({
  status: 404,
  body: renderListHtml(synthItems(20, { firstId: 199000000 }).map((x) => ({ ...x, title: `Lyže ${x.id}` })), 0, 86074, { path: '/' }),
});

test('scan: neexistující kategorie (API [] se stavem 200, HTML 404 s výpisem celé sekce) → chyba, cizí inzeráty se neuloží', async () => {
  for (const api of [{ body: [] }, { status: 404, body: '<html>Not found</html>' }]) {
    const lists = withAll({ 256: LIST });
    const { http, calls } = makeHttp(
      fakeSite({ lists, routes: { [bazos.apiListUrl(CAT.horska, 0)]: api, 'https://sport.bazos.cz/horska/': sectionPage404() } })
    );
    const { ctx, emitted } = makeCtx(http, { mode: 'full' });
    await assert.rejects(bazos.scan(ctx), /Horská kola: .*neexistuje \(HTTP 404/);
    assert.equal(emitted.filter((x) => x.categorySrc === 'Horská kola').length, 0, 'inzeráty celé sekce Sport se nesmí uložit jako horská kola');
    assert.ok(!calls.includes('https://sport.bazos.cz/20/'), '„Další“ mimo kategorii se nenásleduje');
    assert.ok(emitted.some((x) => x.categorySrc === 'Elektrokola'), 'ostatní kategorie pokračují');
  }
  // prostá 404 bez inzerátů na začátku výpisu také není „konec výpisu“
  const { http } = makeHttp(
    fakeSite({ lists: withAll({ 256: LIST }), routes: { [bazos.apiListUrl(CAT.horska, 0)]: { body: [] }, 'https://sport.bazos.cz/horska/': { status: 404, body: '<html>Stránka nenalezena</html>' } } })
  );
  await assert.rejects(bazos.scan(makeCtx(http, { mode: 'full' }).ctx), /neexistuje \(HTTP 404/);
});

test('scan: prázdná 1. stránka API → záloha přes HTML i v režimu jen novinky', async () => {
  const ebikes = synthItems(30, { firstId: 224400000, tops: 3, cat: CAT.elektrokola });
  const { http, calls } = makeHttp(fakeSite({ lists: withAll({ 465: ebikes }), routes: { [bazos.apiListUrl(CAT.elektrokola, 0)]: { body: [] } } }));
  const { ctx, emitted } = makeCtx(http, { mode: 'incremental' });
  await bazos.scan(ctx);
  assert.equal(emitted.filter((x) => x.categorySrc === 'Elektrokola').length, 30);
  assert.deepEqual(htmlCalls(calls), ['https://sport.bazos.cz/elektrokola/', 'https://sport.bazos.cz/elektrokola/20/']);
});

test('scan: „Další“ nebo přesměrování mimo výpis kategorie → nenásledovat, průchod neúplný', async () => {
  const ebikes = synthItems(30, { firstId: 224400000, cat: CAT.elektrokola });
  const page0 = renderListHtml(ebikes.slice(0, 20), 0, 30, CAT.elektrokola).replace('href="/elektrokola/20/"', 'href="/20/"');
  {
    const { http, calls } = makeHttp(
      fakeSite({ lists: withAll({ 465: ebikes }), routes: { [bazos.apiListUrl(CAT.elektrokola, 0)]: { status: 404, body: 'x' }, 'https://sport.bazos.cz/elektrokola/': { body: page0 } } })
    );
    const { ctx, warns } = makeCtx(http, { mode: 'full' });
    assert.equal((await bazos.scan(ctx)).complete, false);
    assert.ok(!calls.includes('https://sport.bazos.cz/20/'));
    assert.ok(warns.some((w) => /nevede dál ve výpisu kategorie/.test(w)));
  }
  {
    // přesměrování zrušené kategorie na úvod sekce (200) → chyba, nic se neuloží
    const { http } = makeHttp(
      fakeSite({
        lists: withAll({ 465: ebikes }),
        routes: {
          [bazos.apiListUrl(CAT.elektrokola, 0)]: { status: 404, body: 'x' },
          'https://sport.bazos.cz/elektrokola/': { body: renderListHtml(ebikes.slice(0, 20), 0, 86074, { path: '/' }), finalUrl: 'https://sport.bazos.cz/' },
        },
      })
    );
    const { ctx, emitted } = makeCtx(http, { mode: 'full' });
    await assert.rejects(bazos.scan(ctx), /Elektrokola: .*přesměrován jinam/);
    assert.equal(emitted.filter((x) => x.categorySrc === 'Elektrokola').length, 0);
  }
});

test('scan: prázdná stránka API hned po plné stránce + selhané ověření přes HTML → neúplný; po kratší stránce platí API', async () => {
  const items = synthItems(300);
  const verifyUrl = 'https://sport.bazos.cz/horska/180/';
  // API vrátí 200 položek a pak [] (např. omezení ze strany webu), HTML ověření selže 503
  const a = makeHttp(fakeSite({ lists: withAll({ 256: items }), apiCap: 200, pageSize: 200, routes: { [verifyUrl]: { status: 503, body: 'Service Unavailable' } } }));
  const ca = makeCtx(a.http, { mode: 'full' });
  assert.equal((await bazos.scan(ca.ctx)).complete, false);
  assert.ok(a.calls.includes(verifyUrl));
  assert.ok(ca.warns.some((w) => /podezřele/.test(w)));
  // přirozený konec (poslední stránka kratší než limit) a nedostupné HTML → výsledek API platí
  const short = items.slice(0, 190);
  const b = makeHttp(fakeSite({ lists: withAll({ 256: short }), pageSize: 200, routes: { [verifyUrl]: { status: 503, body: 'Service Unavailable' } } }));
  const cb = makeCtx(b.http, { mode: 'full' });
  assert.equal((await bazos.scan(cb.ctx)).complete, true);
  assert.ok(cb.warns.some((w) => /beru výsledek API/.test(w)));
});

test('scan: nové inzeráty během průchodu posunou výpis – krátká poslední stránka samých viděných ID není anomálie', async () => {
  const lists = withAll({ 256: synthItems(40) });
  const site = fakeSite({ lists });
  let n = 0;
  const { http, calls } = makeHttp((url) => {
    // před 3. stránkou přibude nahoře nový inzerát → stránka od offsetu 40 vrátí jen už viděný inzerát č. 40
    if (url.includes('/api/v1/ads.php') && url.endsWith('category=256') && ++n === 3) lists[256] = [...synthItems(1, { firstId: 224700000 }), ...lists[256]];
    return site(url);
  });
  const { ctx, warns } = makeCtx(http, { mode: 'full' });
  assert.equal((await bazos.scan(ctx)).complete, true);
  assert.deepEqual(apiCalls(calls, 256).map((u) => new URL(u).searchParams.get('offset')), ['0', '20', '40', '41']);
  assert.deepEqual(warns, []);
});

test('scan: viděno výrazně méně inzerátů, než uvádí web (API vrací duplicity) → neúplný průchod', async () => {
  const items = synthItems(100);
  // API: každá stránka vrátí polovinu nových a polovinu už viděných položek → offset dojde na konec, ale ID chybí
  const lists = withAll({ 256: items });
  const site = fakeSite({ lists });
  const { http } = makeHttp((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/v1/ads.php' && u.searchParams.get('category') === '256') {
      const off = Number(u.searchParams.get('offset'));
      if (off >= 100) return { body: [] };
      return { body: [...items.slice(off / 2, off / 2 + 10), ...items.slice(Math.max(0, off / 2 - 10), off / 2)] };
    }
    return site(url);
  });
  const { ctx, warns } = makeCtx(http, { mode: 'full' });
  assert.equal((await bazos.scan(ctx)).complete, false);
  assert.ok(warns.some((w) => /viděno jen \d+ z 100/.test(w)), warns.join('\n'));
});

test('scan: inzeráty smazané během průchodu → ověřovací stránka je za koncem (HTTP 404 s hlavičkou, jak vrací web) = konec', async () => {
  const lists = withAll({ 256: synthItems(41) });
  const site = fakeSite({ lists });
  const { http, calls } = makeHttp((url) => {
    // po konci API (offset 41 → []) zmizí 2 inzeráty → HTML stránka od 40 je za koncem výpisu (39 inzerátů)
    if (url === bazos.apiListUrl(CAT.horska, 41)) lists[256] = lists[256].slice(2);
    return site(url);
  });
  const { ctx, warns } = makeCtx(http, { mode: 'full' });
  assert.equal((await bazos.scan(ctx)).complete, true);
  assert.ok(calls.includes('https://sport.bazos.cz/horska/40/'));
  assert.deepEqual(warns, []);
});

test('scan: přerušení (AbortSignal) → okamžitý konec bez dalších požadavků', async () => {
  const ac = new AbortController();
  const lists = withAll({ 256: synthItems(100) });
  const site = fakeSite({ lists });
  const { http, calls } = makeHttp((url) => {
    if (calls.length === 2) ac.abort(new Error('Přerušeno uživatelem'));
    return site(url);
  });
  const { ctx } = makeCtx(http, { mode: 'full' });
  ctx.signal = ac.signal;
  await assert.rejects(bazos.scan(ctx), /Přerušeno uživatelem/);
  assert.equal(calls.length, 2);
  await assert.rejects(bazos.detail(ctx, { source_id: '224568683' }), /Přerušeno uživatelem/);
  assert.equal(calls.length, 2);
});

test('API: chybový JSON „too many requests“ = blokace; detail s místním časem se nečte v pásmu serveru', async () => {
  const { http, calls } = makeHttp(fakeSite({ lists: withAll({ 256: LIST }), routes: { [bazos.apiListUrl(CAT.horska, 0)]: { body: { error: 'Too many requests, try later' } } } }));
  const { ctx } = makeCtx(http);
  await assert.rejects(bazos.scan(ctx), (e) => e instanceof bazos.BazosBlockedError);
  assert.equal(calls.length, 1);
  const d = bazos.parseApiDetail({ ...DETAIL_TPL, from: '2026-10-02 15:22:25' }, DETAIL_TPL.id).item;
  assert.equal(d.postedAt, '2026-10-02T13:22:25.000Z');
});

test('detail / confirmGone: aktivní, smazaný (410), jiná kategorie, chyba serveru', async () => {
  const x = LIST.find((it) => it.id === '224568683');
  const details = {
    224568683: { body: readJson('api_detail_224568683.json') },
    200000001: { status: 410, body: readJson('api_detail_deleted.json') },
    224000001: { body: { ...detailFor({ ...x, id: '224000001', url: 'https://sport.bazos.cz/inzerat/224000001/x.php' }), category: { id: '260', title: 'Součástky', url: 'soucastky' } } },
    224000002: { status: 404, body: '<html>Not found</html>' },
  };
  const { http, calls } = makeHttp(fakeSite({ details }));
  const { ctx } = makeCtx(http);
  const d = await bazos.detail(ctx, { source_id: '224568683', url: x.url });
  assert.equal(d.priceCzk, 3000);
  assert.equal(d.psc, '66431');
  assert.equal(d.detailComplete, true);
  assert.equal(await bazos.detail(ctx, { source_id: '200000001', url: 'https://sport.bazos.cz/inzerat/200000001/x.php' }), null);
  // 404 není důkaz smazání → chyba (pipeline ji započte, inzerát nezmizí)
  await assert.rejects(bazos.detail(ctx, { source_id: '224000002', url: 'https://sport.bazos.cz/inzerat/224000002/x.php' }), /HTTP 404/);
  // ID se dá vzít i z URL
  assert.equal((await bazos.detail(ctx, { url: x.url })).sourceId, '224568683');

  assert.equal(await bazos.confirmGone(ctx, { source_id: '200000001' }), true);
  assert.equal(await bazos.confirmGone(ctx, { source_id: '224568683' }), false);
  assert.equal(await bazos.confirmGone(ctx, { source_id: '224000001' }), null, 'přesunutý do součástek → nevím');
  assert.equal(await bazos.confirmGone(ctx, { source_id: '224000002' }), null);
  assert.ok(calls.every((u) => u.startsWith('https://www.bazos.cz/api/v1/ad-detail-2.php?ad_id=')));
});

// ---------------------------------------------------------------- napojení na pipeline

test('pipeline: Bazoš přes runPipeline – uložení, detaily, zmizelé po potvrzení 410', async () => {
  // classify / pricing píší jiní – v testu jednoduché náhrady (stejný trik jako test/pipeline.test.js)
  const stubs = {
    [path.join(__dirname, '..', 'src', 'classify')]: {
      CLASSIFIER_VERSION: 'test-bazos',
      classifyListing: () => ({ isBike: true, bikeType: 'mtb_hardtail', reason: 'test', features: {} }),
    },
    [path.join(__dirname, '..', 'src', 'pricing')]: { trainModel: () => ({ summary: {} }), priceAll: () => 0 },
  };
  const origLoad = Module._load;
  Module._load = function (request, parent) {
    if (parent && parent.filename && parent.filename.endsWith(`${path.sep}src${path.sep}pipeline.js`)) {
      const resolved = path.resolve(path.dirname(parent.filename), request);
      if (stubs[resolved]) return stubs[resolved];
    }
    return origLoad.apply(this, arguments);
  };
  let runPipeline;
  try {
    delete require.cache[require.resolve('../src/pipeline')];
    ({ runPipeline } = require('../src/pipeline'));
  } finally {
    Module._load = origLoad;
  }
  const { openDb } = require('../src/db');
  const { loadConfig } = require('../src/config');
  const db = openDb(':memory:');
  const config = { ...loadConfig({}), maxDetails: 10, ai: { enabled: false } };
  const { log } = makeLog();

  const items = synthItems(25, { tops: 2 });
  const lists = withAll({ 256: items });
  const details = {};
  const { http, calls } = makeHttp((url) => fakeSite({ lists, details })(url));

  const r1 = await runPipeline({ db, config, log, sources: [bazos], http, trigger: 'test' });
  assert.equal(r1.status, 'ok', JSON.stringify(r1));
  const s1 = r1.stats.sources.bazos;
  assert.equal(s1.mode, 'full');
  assert.equal(s1.complete, true);
  assert.equal(s1.new, 25 + FILLER(['256']));
  assert.equal(s1.details, 10);
  const row = db.prepare("SELECT * FROM listings WHERE source = 'bazos' AND source_id = ?").get(items[2].id);
  assert.equal(row.url, items[2].url);
  assert.equal(row.price_czk, 5200);
  assert.equal(row.category_src, 'Horská kola');
  assert.equal(row.psc, '66431');
  assert.ok(row.detail_at && row.lat && row.lon);
  assert.equal(row.description, `Plný popis inzerátu č. ${items[2].id.slice(-4)}.\nDruhý řádek.`);
  assert.equal(row.photo_count, 2);
  assert.match(row.photo_url, /\/img\/1\/\d{3}\/\d+\.jpg$/);
  assert.equal(row.seller_type, 'private');
  assert.equal(row.posted_at, bazos.pragueLocalToIso(items[2].from));
  const topRow = db.prepare('SELECT posted_at FROM listings WHERE source_id = ?').get(items[0].id);
  assert.equal(topRow.posted_at, null, 'TOP bez data');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listings WHERE kraj IS NULL').get().n, 0, 'všechny geolokované (lokalita / souřadnice)');

  // 2. celý průchod: 2 inzeráty z výpisu zmizely – jeden smazaný (410), druhý ještě existuje (přesunutý níž mimo průchod)
  const goneId = items[10].id;
  const aliveId = items[11].id;
  lists[256] = items.filter((x) => x.id !== goneId && x.id !== aliveId);
  details[goneId] = { status: 410, body: { idad: goneId, status: 'deleted' } };
  details[aliveId] = { body: detailFor(items[11]) };
  db.prepare("UPDATE settings SET value = ? WHERE key = 'lastFullScan:bazos'").run(JSON.stringify('2000-01-01T00:00:00Z'));
  const before = calls.length;
  const r2 = await runPipeline({ db, config, log, sources: [bazos], http, trigger: 'test' });
  assert.equal(r2.stats.sources.bazos.complete, true);
  assert.equal(r2.stats.sources.bazos.new, 0);
  const g = (id) => db.prepare('SELECT gone_at, missed_scans FROM listings WHERE source_id = ?').get(id);
  assert.ok(g(goneId).gone_at, 'smazaný (410) → zmizelý hned');
  assert.equal(g(aliveId).gone_at, null, 'existující → zůstává');
  assert.equal(g(aliveId).missed_scans, 0);
  const newCalls = calls.slice(before);
  assert.ok(newCalls.includes(bazos.apiDetailUrl(goneId)) && newCalls.includes(bazos.apiDetailUrl(aliveId)));
  // detaily dalších 10 inzerátů bez detailu (smazaný z nich se pozná už tady: 410 → null); stažené se znovu nestahují
  assert.equal(r2.stats.sources.bazos.details, 9);
  assert.equal(r2.stats.sources.bazos.gone, 1);
  assert.ok(!newCalls.includes(bazos.apiDetailUrl(items[2].id)));
});
