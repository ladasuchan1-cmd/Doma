'use strict';
// Zdroj Aukro – plně offline nad zredigovanými ukázkami v test/fixtures/aukro. Síť nahrazuje falešný fetch
// vložený do skutečného src/util/http.js, takže se testuje i cesta přes ctx.http; na aukro.cz nejde nic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createHttp } = require('../src/util/http');
const aukro = require('../src/sources/aukro');

// Pojistka: skutečná síť je v tomto testu zakázaná (aukro.cz blokuje ClaudeBota v robots.txt).
globalThis.fetch = async (url) => {
  throw new Error(`Test se pokusil o skutečný požadavek: ${url}`);
};

const FX = path.join(__dirname, 'fixtures', 'aukro');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(FX, f), 'utf8'));
const readText = (f) => fs.readFileSync(path.join(FX, f), 'utf8');
const LIST = [0, 1, 2].map((n) => readJson(`list_p${n}.json`));
const ALL = LIST.flatMap((p) => p.content);
const raw = (id) => ALL.find((c) => c.itemId === id);
const detailFx = (id) => readJson(`detail_${id}.json`);
const SSR_HTML = readText('detail_ssr_7135472950.html');
const SSR_URL = 'https://aukro.cz/kolo-specialized-crosstrail-l-7135472950';
const NBSP = '\u00a0';
const FOREIGN = ['7103101367', '7102249104', '7135809051', '7135534363'];
const CHEAP = ['7133429684', '7122236998'];
const PII = /REDACTED|sellerLogin|showName|userId|avatar|"seller"/;

/** Falešný Aukro server: routes(req) → {status, body, type} | Error | undefined (= neočekávaný požadavek). */
function fakeAukro(routes) {
  const calls = [];
  const unexpected = [];
  const fetchImpl = async (url, init = {}) => {
    const req = { url, method: init.method || 'GET', headers: init.headers || {}, body: init.body };
    calls.push(req);
    const r = routes(req);
    if (r instanceof Error) throw r;
    if (!r) {
      unexpected.push(`${req.method} ${url}`);
      return new Response('neznámá URL', { status: 418 });
    }
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null);
    return new Response(body, { status: r.status ?? 200, headers: { 'content-type': r.type || 'application/json' } });
  };
  const http = createHttp({ delayMs: 0, retries: 1, fetchImpl, sleepImpl: async () => {} });
  return { http, calls, unexpected };
}

/** Routy API: výpis po stránkách (POST) + detaily (GET). details[id] = JSON | HTTP status. */
function apiRoutes({ pages = LIST, details = {}, html = {}, overrides } = {}) {
  return (req) => {
    const o = overrides?.(req);
    if (o !== undefined) return o;
    const u = new URL(req.url);
    if (u.host !== 'aukro.cz') return undefined;
    if (req.method === 'POST' && u.pathname === '/backend-web/api/offers/searchItemsCommon') {
      if (u.searchParams.get('size') !== '180' || u.searchParams.get('sort') !== 'startingTime:DESC') return undefined;
      if (JSON.stringify(JSON.parse(req.body)) !== JSON.stringify(aukro.SEARCH_BODY)) return undefined;
      const n = Number(u.searchParams.get('page'));
      return { body: pages[n] || { content: [], page: { ...pages[0].page, number: n } } };
    }
    const m = req.method === 'GET' && u.pathname.match(/^\/backend-web\/api\/offers\/(\d+)\/offerDetail$/);
    if (m) {
      const d = typeof details === 'function' ? details(m[1]) : details[m[1]];
      if (d === undefined) return undefined;
      return typeof d === 'number' ? { status: d, body: '' } : { body: d };
    }
    if (req.method === 'GET' && html[req.url] !== undefined) {
      const h = html[req.url];
      return typeof h === 'number' ? { status: h, body: '' } : { body: h, type: 'text/html; charset=utf-8' };
    }
    return undefined;
  };
}

function makeCtx(http, o = {}) {
  const items = [];
  return {
    items,
    http,
    mode: 'full',
    maxPages: 400,
    minPrice: 500,
    isKnown: () => null,
    emit: async (it) => {
      items.push(it);
      return { isNew: true, changed: true };
    },
    ...o,
  };
}

/** HTML stránka se SSR stavem (Angular escapuje „<“ jako \u003C). */
function ssrPage(entries) {
  const aukCache = { 'ssr-subbrand': 'BAZAAR' };
  for (const [key, b] of entries) aukCache[key] = { t: 1, b };
  const json = JSON.stringify({ aukCache }).replace(/</g, '\\u003C');
  return `<!DOCTYPE html><html lang="cs"><head><title>Aukro</title></head><body><auk-root></auk-root><script id="ng-state" type="application/json">${json}</script></body></html>`;
}
const searchKey = (n, body = aukro.SEARCH_BODY) =>
  ['POST', '/backend-web/api/offers/searchItemsCommon', `page=${n}&size=60&sort=startingTime:DESC`, JSON.stringify(body), '{"X-Accept-Subbrand":"BAZAAR"}'].join('\u001c');

/** Detail ve tvaru offerDetail API poskládaný z položky výpisu (pro inzeráty bez uložené ukázky detailu). */
function detailFromList(r) {
  return {
    itemId: r.itemId,
    name: r.itemName,
    seoUrl: r.seoUrl,
    itemType: r.auction ? 'BIDDING' : 'BUYNOW',
    ...(r.auction ? { price: r.price, biddersCount: r.buyersCountRelative } : {}),
    buyNowActive: r.buyNowActive,
    buyNowPrice: r.buyNowPrice,
    retailPrice: r.retailPrice,
    startingTime: r.startingTime,
    endingTime: r.endingTime,
    attributes: r.attributes,
    category: r.categoryPath,
    itemLocation: `${r.location}, Česká republika`,
    postCode: r.postcode,
    state: 'ACTIVE',
    itemImages: [{ position: 0, sizes: { LARGE: { url: r.titleImageUrl.replace('/thumbnail/', '/730x548/') } } }],
    displayedCount: 10,
    descriptionInHtml: `<p>${r.itemName}</p><p>Popis z detailu.</p>`,
    seller: { companyAccount: r.seller.companyAccount, registrationDomain: 'CZ' },
  };
}

// ---------------------------------------------------------------------------------------------------------------

test('kontrakt zdroje; ve výchozí konfiguraci je Aukro vypnuté; žádné přímé fetch()', () => {
  assert.equal(aukro.key, 'aukro');
  assert.equal(aukro.label, 'Aukro');
  assert.equal(aukro.homepage, 'https://aukro.cz');
  assert.equal(aukro.requiresBrowser, false);
  for (const f of ['scan', 'detail', 'confirmGone', 'parseNgState', 'parseSsrDetail']) assert.equal(typeof aukro[f], 'function', f);
  const { DEFAULT_SOURCES, loadConfig } = require('../src/config');
  assert.ok(!DEFAULT_SOURCES.includes('aukro'));
  assert.ok(!loadConfig({}).sources.includes('aukro'));
  assert.ok(loadConfig({ KOLOMAPA_SOURCES: 'bazos,aukro' }).sources.includes('aukro'));
  const loaded = require('../src/sources').loadSources(['aukro']);
  assert.equal(loaded[0], aukro);
  const src = fs.readFileSync(require.resolve('../src/sources/aukro'), 'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(/, 'všechny požadavky jdou přes ctx.http');
  assert.match(src.slice(0, 2000), /VYPNUTO[\s\S]*ClaudeBot/, 'hlavička vysvětluje, proč je zdroj vypnutý');
});

test('výpis: jen aukce → bez ceny, cena + konec v poznámce; params z atributů', () => {
  const it = aukro.normalizeListItem(raw(7123865595));
  assert.equal(it.sourceId, '7123865595');
  assert.equal(it.url, 'https://aukro.cz/author-traction-horske-kolo-26-ram-19-modre-zadni-nosic-7123865595');
  assert.equal(it.title, 'Author Traction – horské kolo 26", rám 19", modré + zadní nosič');
  assert.equal(it.priceCzk, null, 'běžící aukce není pevná cena');
  assert.equal(it.priceNote, `Aukce – aktuální cena 3${NBSP}200${NBSP}Kč (0 přihazujících), končí 9. 10. 2026 7:10`);
  assert.equal(it.postedAt, '2026-10-02T05:12:03.000Z');
  assert.equal(it.categorySrc, 'Horská (MTB) kola');
  assert.equal(it.locationText, 'Zašová');
  assert.equal(it.psc, '75651');
  assert.equal(it.photoUrl, 'https://cdn.aukro.cz/images/sk1775402902070/730x548/author-traction-horske-kolo-26-ram-19-modre-zadni-nosic-267166002.jpeg');
  assert.equal(it.sellerType, 'private');
  assert.equal(it.detailComplete, false);
  assert.deepEqual(it.params, {
    'Stav zboží': 'Použité',
    Značka: 'Author',
    'Průměr kol': '26″',
    'Materiál rámu': 'Dural',
    Odpružení: 'Odpružená přední vidlice',
    Určení: 'Pánská',
    Typ: 'Pánské',
    'Hmotnost kola': '12 kg až 13 kg',
    'Barva kola': 'Modrá',
    'Typ nabídky': 'Aukce',
    Konec: '9. 10. 2026 7:10',
  });
  // 3 přihazující, aukce od 4 Kč – stále žádná cena
  const sp = aukro.normalizeListItem(raw(7135472950));
  assert.equal(sp.priceCzk, null);
  assert.equal(sp.priceNote, `Aukce – aktuální cena 4${NBSP}Kč (3 přihazující), končí 7. 10. 2026 18:25`);
});

test('výpis: aukce + Kup teď, jen Kup teď, původní cena, „Ostatní“ značka, PSČ s mezerou, firma', () => {
  const ab = aukro.normalizeListItem(raw(7135742784));
  assert.equal(ab.priceCzk, 19000);
  assert.equal(ab.priceNote, `Kup teď; aukce – aktuální cena 17${NBSP}000${NBSP}Kč (0 přihazujících), končí 8. 10. 2026 15:26`);
  assert.equal(ab.params['Typ nabídky'], 'Aukce + Kup teď');
  assert.equal(ab.params['Značka'], undefined, '„Ostatní“ = neuvedeno');
  assert.equal(ab.params['Materiál rámu'], 'Karbon');

  const b = aukro.normalizeListItem(raw(7134953681));
  assert.equal(b.priceCzk, 6500);
  assert.equal(b.priceNote, 'Kup teď');
  assert.equal(b.params['Typ nabídky'], 'Kup teď');

  const shop = aukro.normalizeListItem(raw(7041607156));
  assert.equal(raw(7041607156).postcode, '169 00');
  assert.equal(shop.psc, '16900');
  assert.equal(shop.sellerType, 'company');
  assert.equal(shop.priceCzk, 8200);
  assert.equal(shop.params['Původní cena'], `17${NBSP}000${NBSP}Kč`);
  assert.equal(require('../src/util/text').parseCzk(shop.params['Původní cena']), 17000);

  const ebike = aukro.normalizeListItem(raw(7131634758));
  assert.equal(ebike.params['Délka dojezdu'], 'Méně než 130 km');
  assert.equal(ebike.categorySrc, 'Elektrokola');

  const warranty = aukro.normalizeListItem(raw(7127870584));
  assert.equal(warranty.params['Doba záruky (měsíců)'], '24');
  assert.equal(warranty.params['Barva kola'], 'Bílá, Černá', 'duplicitní atribut spojený');
  for (const r of ALL) {
    const p = aukro.normalizeListItem(r).params;
    assert.ok(!('Materíál rámu' in p), 'překlep webu opraven');
    assert.ok(!Object.keys(p).some((k) => /Doba dodání|Kód zboží|EAN/.test(k)), Object.keys(p).join());
  }
});

test('zahraniční prodejci: SK/HU PSČ nebo registrace mimo CZ', () => {
  for (const id of FOREIGN) assert.equal(aukro.isForeignSeller(raw(Number(id))), true, id);
  assert.equal(raw(7103101367).seller.registrationDomain, 'CZ', 'CZ účet se slovenským PSČ');
  assert.equal(aukro.isForeignSeller(raw(7123865595)), false);
  assert.equal(aukro.isForeignSeller(raw(7041607156)), false, 'PSČ s mezerou');
  assert.equal(aukro.isForeignSeller({ postcode: '', seller: { registrationDomain: 'CZ' } }), false, 'chybějící PSČ ≠ zahraničí');
  assert.equal(aukro.isForeignSeller({ postcode: '37501' }), false, 'chybějící doména ≠ zahraničí');
});

test('scan: projde všechny stránky (POST + správné hlavičky), vyřadí zahraniční, levné a duplicity', async () => {
  const f = fakeAukro(apiRoutes());
  const ctx = makeCtx(f.http);
  const res = await aukro.scan(ctx);
  assert.deepEqual(f.unexpected, []);
  assert.equal(f.calls.length, 3);
  f.calls.forEach((c, n) => {
    assert.equal(c.method, 'POST');
    assert.equal(c.url, `https://aukro.cz/backend-web/api/offers/searchItemsCommon?page=${n}&size=180&sort=startingTime:DESC`);
    assert.equal(c.headers['X-Accept-Subbrand'], 'BAZAAR');
    assert.equal(c.headers['Content-Type'], 'application/json');
    assert.match(c.headers.Accept, /application\/json/);
    assert.deepEqual(JSON.parse(c.body), { categorySeoUrl: 'jizdni-kola', splitGroups: {}, fallbackItemsCount: 0, subbrandExclusive: false });
  });
  assert.equal(res.complete, true);
  assert.equal(res.unique, 54);
  assert.equal(res.foreign, 4);
  assert.equal(res.cheap, 2);
  assert.equal(res.emitted, 48);
  const ids = ctx.items.map((i) => i.sourceId);
  assert.equal(new Set(ids).size, ids.length, 'duplicita z posunu stránkování jen jednou');
  for (const id of [...FOREIGN, ...CHEAP]) assert.ok(!ids.includes(id), id);
  for (const it of ctx.items) {
    assert.ok(it.sourceId && it.url.startsWith('https://aukro.cz/') && it.title, it.sourceId);
    assert.ok(it.psc === undefined || /^[1-7]\d{4}$/.test(it.psc), it.psc);
    assert.match(it.photoUrl, /^https:\/\/cdn\.aukro\.cz\/images\/.+\/730x548\//);
    assert.match(it.postedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.ok(it.priceCzk === null || it.priceCzk >= 500);
    if (it.params['Typ nabídky'] === 'Aukce') {
      assert.equal(it.priceCzk, null);
      assert.match(it.priceNote, /^Aukce – aktuální cena .+, končí \d/);
    }
    assert.ok(['private', 'company'].includes(it.sellerType));
  }
  assert.equal(ctx.items.filter((i) => i.priceCzk === null).length, 21);
  assert.doesNotMatch(JSON.stringify(ctx.items), PII, 'žádné údaje o prodávajícím');
});

test('scan: v inkrementálním režimu projde vše, ale complete = false (kontrakt)', async () => {
  const f = fakeAukro(apiRoutes());
  const ctx = makeCtx(f.http, { mode: 'incremental' });
  const res = await aukro.scan(ctx);
  assert.equal(f.calls.length, 3, 'topované nahoře → nikdy nekončit dřív');
  assert.equal(ctx.items.length, 48);
  assert.equal(res.complete, false);
});

test('scan: neúplný průchod (počet nesedí, limit stránek, chyba stránky) → complete false / výjimka', async () => {
  const bigger = LIST.map((p) => ({ ...p, page: { ...p.page, totalElements: 120 } }));
  let f = fakeAukro(apiRoutes({ pages: bigger }));
  let res = await aukro.scan(makeCtx(f.http));
  assert.equal(res.complete, false);

  f = fakeAukro(apiRoutes());
  res = await aukro.scan(makeCtx(f.http, { maxPages: 2 }));
  assert.equal(f.calls.length, 2);
  assert.equal(res.complete, false);

  // stránka 3 trvale 500 → po opakování výjimka; nabídky z prvních stránek už jsou uložené
  f = fakeAukro(apiRoutes({ overrides: (req) => (req.url.includes('page=2&') ? { status: 500, body: 'chyba' } : undefined) }));
  const ctx = makeCtx(f.http);
  await assert.rejects(aukro.scan(ctx), (e) => e.status === 500);
  assert.equal(f.calls.length, 4, '2 stránky + 2 pokusy o třetí');
  assert.ok(ctx.items.length > 30);

  // prázdný výpis = podezřelé, nic neoznačovat jako zmizelé
  f = fakeAukro(apiRoutes({ pages: [{ content: [], page: { number: 0, size: 180, totalElements: 0, totalPages: 0 } }] }));
  res = await aukro.scan(makeCtx(f.http));
  assert.equal(res.complete, false);

  // nečekaný tvar odpovědi → výjimka
  f = fakeAukro(apiRoutes({ pages: [{ error: 'x' }] }));
  await assert.rejects(aukro.scan(makeCtx(f.http)), /neočekávaná odpověď výpisu/);
});

test('scan: API výpisu odmítne (403) → HTML stránky výpisu s ng-state', async () => {
  const other = { ...aukro.SEARCH_BODY, categorySeoUrl: 'cyklistika' };
  const html = {};
  LIST.forEach((p, n) => {
    const url = aukro.listingPageUrl(n);
    html[url] = ssrPage([
      [searchKey(0, other), { content: [ALL[0]], page: { number: 0, size: 6, totalElements: 1, totalPages: 1 } }], // karusel jiné kategorie
      [searchKey(n), p],
    ]);
  });
  assert.equal(aukro.listingPageUrl(0), 'https://aukro.cz/jizdni-kola?sort=startingTime:DESC');
  assert.equal(aukro.listingPageUrl(2), 'https://aukro.cz/jizdni-kola?sort=startingTime:DESC&page=3');
  const f = fakeAukro(apiRoutes({ html, overrides: (req) => (req.method === 'POST' ? { status: 403, body: 'zakázáno' } : undefined) }));
  const ctx = makeCtx(f.http);
  const res = await aukro.scan(ctx);
  assert.deepEqual(f.unexpected, []);
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 1, 'po odmítnutí už API nezkouší');
  assert.equal(res.viaSsr, true);
  assert.equal(res.complete, true);
  assert.equal(ctx.items.length, 48);
});

test('detail: JSON API → popis, fotka, počet fotek, zobrazení, poloha; stejné params jako výpis', async () => {
  const details = Object.fromEntries([7122702822, 7123865595, 7127870584, 7131634758].map((id) => [String(id), detailFx(id)]));
  const f = fakeAukro(apiRoutes({ details }));
  const ctx = makeCtx(f.http);

  const shop = await aukro.detail(ctx, { source_id: '7127870584', url: 'https://aukro.cz/x-7127870584', params: {} });
  const call = f.calls.at(-1);
  assert.equal(call.method, 'GET');
  assert.equal(call.url, 'https://aukro.cz/backend-web/api/offers/7127870584/offerDetail?pageType=DETAIL&requestedFor=DETAIL');
  assert.equal(call.headers['X-Accept-Subbrand'], 'BAZAAR');
  assert.equal(shop.detailComplete, true);
  assert.equal(shop.title, 'Nové horské kolo Olpran Professional Full Disc 29“ hydraulické brzdy');
  assert.equal(shop.priceCzk, 8990, 'jen Kup teď (detail nemá klíč price)');
  assert.equal(shop.priceNote, 'Kup teď');
  assert.match(shop.description, /^Nové horské 29“ kolo Olpran Professional/);
  assert.match(shop.description, /Hmotnost kola je 15,7 kg\./);
  assert.match(shop.description, /volejte na tel\. číslo \[telefon skryt\]/, 'telefon z popisu odstraněn');
  assert.doesNotMatch(shop.description, /<|&nbsp;|700 000 000/);
  assert.equal(shop.photoUrl, 'https://cdn.aukro.cz/images/sk1755208360016/730x548/nove-horske-kolo-olpran-professional-full-disc-29-hydraulicke-brzdy-237399793.jpeg');
  assert.equal(shop.photoCount, 8);
  assert.equal(shop.views, 5);
  assert.equal(shop.locationText, 'Brno');
  assert.equal(shop.psc, '60200');
  assert.equal(shop.sellerType, 'company');
  assert.equal(shop.categorySrc, 'Horská (MTB) kola');
  assert.equal(shop.params['Doba záruky (měsíců)'], '24');
  assert.equal(shop.url, 'https://aukro.cz/nove-horske-kolo-olpran-professional-full-disc-29-hydraulicke-brzdy-7127870584');

  const ebike = await aukro.detail(ctx, { source_id: '7131634758', url: 'https://aukro.cz/x-7131634758' });
  assert.equal(ebike.priceCzk, 20000);
  assert.match(ebike.priceNote, /^Kup teď; aukce – aktuální cena 19\u00a0000\u00a0Kč \(0 přihazujících\), končí 7\. 10\. 2026 10:13$/);
  assert.equal(ebike.views, 65);
  assert.equal(ebike.photoCount, 4);
  assert.equal(ebike.locationText, 'Moravské Bránice');
  assert.match(ebike.description, /Bosch Active Line/);

  const kids = await aukro.detail(ctx, { source_id: '7122702822', url: 'https://aukro.cz/x-7122702822' });
  assert.equal(kids.priceCzk, null);
  assert.match(kids.priceNote, /^Aukce – aktuální cena 3\u00a0999\u00a0Kč/);
  assert.equal(kids.locationText, 'Praha 1');
  assert.equal(kids.psc, '11000');
  assert.equal(kids.params['Značka'], undefined);
  assert.equal(kids.params['Barva kola'], 'Bílá, Černá');
  assert.equal(kids.categorySrc, 'Dětská kola');

  // params z výpisu a detailu jsou shodné včetně pořadí (otisk obsahu se zbytečně nemění)
  for (const id of [7122702822, 7123865595, 7127870584, 7131634758]) {
    const fromList = aukro.normalizeListItem(raw(id)).params;
    const fromDetail = aukro.normalizeDetail(detailFx(id)).params;
    assert.equal(JSON.stringify(fromDetail), JSON.stringify(fromList), String(id));
  }
  assert.deepEqual(f.unexpected, []);
  for (const d of [shop, ebike, kids]) assert.doesNotMatch(JSON.stringify(d), PII);
});

test('detail: 404/410, ukončená nabídka nebo přesun mimo kola → null', async () => {
  const base = detailFx(7123865595);
  const details = {
    1: 404,
    2: 410,
    3: { ...base, itemId: 3, state: 'ENDED' },
    4: { ...base, itemId: 4, category: base.category.slice(0, 2) }, // jen „Cyklistika“
    5: { ...base, itemId: 5, itemArchived: true },
  };
  const f = fakeAukro(apiRoutes({ details }));
  const ctx = makeCtx(f.http);
  for (const id of ['1', '2', '3', '4', '5']) assert.equal(await aukro.detail(ctx, { source_id: id, url: `https://aukro.cz/x-${id}` }), null, id);
  assert.equal(f.calls.length, 5);
  assert.deepEqual(f.unexpected, []);
  await assert.rejects(aukro.detail(ctx, { source_id: 'abc', url: 'https://aukro.cz/x' }), /neplatné id/);
});

test('detail: odpověď jiné nabídky → chyba; jen list stromu kategorií ≠ přesun mimo kola', async () => {
  const base = detailFx(7123865595);
  const f = fakeAukro(apiRoutes({ details: { 555: base, 6: { ...base, itemId: 6, id: 6, category: [base.category.at(-1)] } } }));
  const ctx = makeCtx(f.http);
  await assert.rejects(aukro.detail(ctx, { source_id: '555', url: 'https://aukro.cz/x-555' }), /vrátil nabídku 7123865595/);
  assert.equal((await aukro.detail(ctx, { source_id: '6', url: 'https://aukro.cz/x-6' })).sourceId, '6');
  assert.equal(aukro.isGoneOffer({ state: 'ACTIVE', category: [{ id: 17594, seoUrl: 'horska-mtb-kola' }] }), false);
  assert.equal(aukro.isGoneOffer({ state: 'ACTIVE', category: [{ id: 17533 }, { id: 17570, seoUrl: 'cyklistika' }] }), true);
  assert.equal(aukro.isGoneOffer({ state: 'active' }), false);
});

test('detail: hromadné „zmizení“ nabídek z dnešního výpisu (změna API → 404) → chyba místo null', async () => {
  // výpis projde normálně, detail API ale pro všechno vrací 404 (např. přesunuté na jinou adresu)
  const f = fakeAukro(apiRoutes({ details: () => 404 }));
  const ctx = makeCtx(f.http);
  await aukro.scan(ctx);
  const ids = ctx.items.map((i) => i.sourceId);
  const out = [];
  for (const id of ids.slice(0, 12)) {
    try {
      out.push(await aukro.detail(ctx, { source_id: id, url: `https://aukro.cz/x-${id}` }));
    } catch (e) {
      out.push(e.message);
    }
  }
  assert.deepEqual(out.slice(0, 5), [null, null, null, null, null], 'pár skončených mezi výpisem a detailem je normální');
  assert.match(String(out[5]), /změnilo se API/);
  assert.ok(out.slice(5).every((x) => typeof x === 'string'));
  // nabídka, která v dnešním výpisu nebyla, se pořád smí označit jako zmizelá
  assert.equal(await aukro.detail(ctx, { source_id: '42', url: 'https://aukro.cz/x-42' }), null);
});

test('scan: API vrátí jinou kategorii (ignoruje tělo hledání) → výjimka; cizí kategorie u položky se přeskočí', async () => {
  const other = LIST.map((p) => ({ ...p, categoryPath: [{ id: 17533, seoUrl: 'sport-a-turistika' }, { id: 17570, seoUrl: 'cyklistika' }] }));
  let f = fakeAukro(apiRoutes({ pages: other }));
  let ctx = makeCtx(f.http);
  await assert.rejects(aukro.scan(ctx), /není kategorie kol/);
  assert.equal(ctx.items.length, 0, 'nic neuloženo');

  // jedna položka mimo kola (např. přesunutá do „Cyklistika › Duše“) – přeskočí se, výpis zůstane úplný
  const pages = structuredClone(LIST);
  const moved = pages[0].content.find((c) => c.itemId === 7134953681);
  moved.categoryPath = [{ id: 17533 }, { id: 17570, seoUrl: 'cyklistika' }, { id: 99999, seoUrl: 'duse' }];
  f = fakeAukro(apiRoutes({ pages }));
  ctx = makeCtx(f.http);
  const res = await aukro.scan(ctx);
  assert.equal(res.offCategory, 1);
  assert.equal(res.complete, true);
  assert.ok(!ctx.items.some((i) => i.sourceId === '7134953681'));

  // bez režimu (mimo pipeline) se výpis za úplný nevydává
  f = fakeAukro(apiRoutes());
  assert.equal((await aukro.scan(makeCtx(f.http, { mode: undefined }))).complete, false);
});

test('normalizace: entity v textu, PSČ s předponou / nezlomitelnou mezerou, fotka bez protokolu, slug', () => {
  const r = raw(7123865595);
  const it = aukro.normalizeListItem({
    ...r,
    itemName: 'Kolo &quot;Author&quot; &amp; nosič\r\n',
    location: 'Praha&nbsp;6 , Česká republika',
    postcode: 'CZ-160 00',
    titleImageUrl: '//cdn.aukro.cz/images/sk1/thumbnail/x.jpeg',
    seoUrl: 'kolo/../../evil?x=1',
  });
  assert.equal(it.title, 'Kolo "Author" & nosič');
  assert.equal(it.locationText, 'Praha 6');
  assert.equal(it.psc, '16000');
  assert.equal(aukro.isForeignSeller({ ...r, postcode: 'CZ-160 00' }), false);
  assert.equal(aukro.isForeignSeller({ ...r, postcode: '079 01' }), true, 'SK zůstává zahraniční');
  assert.equal(it.photoUrl, 'https://cdn.aukro.cz/images/sk1/730x548/x.jpeg');
  assert.equal(it.url, 'https://aukro.cz/koloevilx1-7123865595');
  assert.equal(aukro.normalizeListItem({ ...r, titleImageUrl: 'javascript:alert(1)', titleImage: null }).photoUrl, undefined);
});

test('detail: API odpoví 403 → HTML stránka nabídky (ng-state); dál už rovnou HTML', async () => {
  const f = fakeAukro(apiRoutes({ details: { 7135472950: 403 }, html: { [SSR_URL]: SSR_HTML } }));
  const ctx = makeCtx(f.http);
  const listing = { source_id: '7135472950', url: SSR_URL, params: {} };
  const d = await aukro.detail(ctx, listing);
  assert.deepEqual(f.unexpected, []);
  assert.deepEqual(f.calls.map((c) => c.url.replace(/\?.*/, '')), ['https://aukro.cz/backend-web/api/offers/7135472950/offerDetail', SSR_URL]);
  assert.match(f.calls[1].headers.Accept, /text\/html/);
  assert.equal(d.title, 'Kolo Specialized crosstrail L');
  assert.equal(d.priceCzk, null, 'aukce od 4 Kč');
  assert.match(d.priceNote, /^Aukce – aktuální cena 4\u00a0Kč \(3 přihazující\)/);
  assert.equal(d.locationText, 'Týn nad Vltavou');
  assert.equal(d.psc, '37501');
  assert.equal(d.views, 71);
  assert.equal(d.photoCount, 4);
  assert.match(d.photoUrl, /\/730x548\/kolo-specialized-crosstrail-l-298584176\.jpeg$/);
  assert.match(d.description, /^Specialized Crosstrail 2018 – 28” – odpružená vidlice\n/);
  assert.match(d.description, /rok 2018/);
  assert.doesNotMatch(JSON.stringify(d), PII);
  // API odmítá opakovaně: po 3 odmítnutích po sobě se do konce běhu API už nezkouší
  await aukro.detail(ctx, listing);
  await aukro.detail(ctx, listing);
  assert.equal(f.calls.length, 6, '3× (API 403 + HTML)');
  await aukro.detail(ctx, listing);
  assert.equal(f.calls.length, 7);
  assert.equal(f.calls[6].url, SSR_URL, 'rovnou HTML');

  // jednorázové odmítnutí (400 u jedné nabídky) NEpřepne celý běh na 1MB HTML stránky
  const one = fakeAukro(
    apiRoutes({ details: { 7135472950: 400, 7123865595: detailFx(7123865595) }, html: { [SSR_URL]: SSR_HTML } })
  );
  const ctx1 = makeCtx(one.http);
  assert.equal((await aukro.detail(ctx1, listing)).title, 'Kolo Specialized crosstrail L');
  assert.equal((await aukro.detail(ctx1, { source_id: '7123865595', url: 'https://aukro.cz/x-7123865595' })).priceCzk, null);
  assert.deepEqual(
    one.calls.map((c) => c.url.replace(/\?.*/, '')),
    ['https://aukro.cz/backend-web/api/offers/7135472950/offerDetail', SSR_URL, 'https://aukro.cz/backend-web/api/offers/7123865595/offerDetail']
  );

  // 404 i na HTML stránce → nabídka neexistuje
  const g = fakeAukro(apiRoutes({ details: { 9: 403 }, html: { 'https://aukro.cz/x-9': 404 } }));
  assert.equal(await aukro.detail(makeCtx(g.http), { source_id: '9', url: 'https://aukro.cz/x-9' }), null);
  // 429 se nepřepíná na HTML (jen by zatěžoval web) – po opakování chyba
  const h = fakeAukro(apiRoutes({ details: { 8: 429 } }));
  await assert.rejects(aukro.detail(makeCtx(h.http), { source_id: '8', url: 'https://aukro.cz/x-8' }), (e) => e.status === 429);
  assert.ok(h.calls.every((c) => c.url.includes('/offerDetail')));
});

test('parseNgState / parseSsrDetail nad uloženou HTML stránkou', () => {
  const entries = aukro.parseNgState(SSR_HTML);
  assert.ok(Array.isArray(entries) && entries.length >= 3);
  const det = entries.find((e) => e.path === '/backend-web/api/offers/7135472950/offerDetail');
  assert.equal(det.method, 'GET');
  assert.match(det.query, /pageType=DETAIL/);
  const d = aukro.parseSsrDetail(SSR_HTML, '7135472950');
  assert.equal(d.itemId, 7135472950);
  assert.equal(d.name, 'Kolo Specialized crosstrail L');
  assert.match(d.descriptionInHtml, /^<html>/, '\\u003C se dekóduje');
  assert.equal(aukro.parseSsrDetail(SSR_HTML)?.itemId, 7135472950, 'bez id vezme první detail');
  assert.equal(aukro.parseSsrDetail(SSR_HTML, 123), null, 'jiné id');
  assert.equal(aukro.parseNgState('<html><body>bez stavu</body></html>'), null);
  assert.equal(aukro.parseNgState('<script id="ng-state" type="application/json">{rozbité</script>'), null);
  assert.equal(aukro.parseSsrDetail(null), null);
  // jiné pořadí atributů a starší escapování Angularu (&q; …)
  const old = `<script type="application/json" id="ng-state">{&q;aukCache&q;:{&q;GET\\u001c/backend-web/api/offers/5/offerDetail\\u001c\\u001cnull\\u001c&q;:{&q;t&q;:1,&q;b&q;:{&q;itemId&q;:5,&q;name&q;:&q;Kolo &l;b&g;&a;&s;&q;}}}}</script>`;
  assert.equal(aukro.parseSsrDetail(old, 5).name, "Kolo <b>&'");
  // výpis: přednost má hledání v kategorii kol
  const page = ssrPage([
    [searchKey(0, { ...aukro.SEARCH_BODY, categorySeoUrl: 'cyklistika' }), { content: [{ itemId: 1 }], page: {} }],
    [searchKey(0), LIST[0]],
  ]);
  assert.equal(aukro.parseSsrSearch(page).content.length, LIST[0].content.length);
  assert.equal(aukro.parseSsrSearch(SSR_HTML), null);
});

test('confirmGone: uplynulý konec bez požadavku; jinak API detailu', async () => {
  const active = detailFx(7123865595);
  const details = {
    1: 404,
    2: { ...active, itemId: 2 },
    3: { ...active, itemId: 3, category: active.category.slice(0, 2) },
    4: 500,
    5: { ...active, itemId: 5, state: 'ENDED' },
    6: { ...active, itemId: 6, state: undefined },
  };
  const f = fakeAukro(apiRoutes({ details }));
  const ctx = makeCtx(f.http);
  const past = { 'Konec': '1. 1. 2020 10:00' };
  const future = { 'Konec': '1. 1. 2099 10:00' };
  assert.equal(await aukro.confirmGone(ctx, { source_id: '1', url: 'https://aukro.cz/x-1', params: past }), true);
  assert.equal(f.calls.length, 0, 'skončená nabídka se neověřuje požadavkem');
  assert.equal(await aukro.confirmGone(ctx, { source_id: '1', url: 'https://aukro.cz/x-1', params: future }), true, '404');
  assert.equal(await aukro.confirmGone(ctx, { source_id: '2', url: 'https://aukro.cz/x-2', params: future }), false, 'stále aktivní');
  assert.equal(await aukro.confirmGone(ctx, { source_id: '3', url: 'https://aukro.cz/x-3', params: future }), true, 'přesunuto mimo kola');
  assert.equal(await aukro.confirmGone(ctx, { source_id: '4', url: 'https://aukro.cz/x-4', params: future }), null, 'chyba → nevím');
  assert.equal(await aukro.confirmGone(ctx, { source_id: '5', url: 'https://aukro.cz/x-5', params: {} }), true, 'ENDED');
  assert.equal(await aukro.confirmGone(ctx, { source_id: '6', url: 'https://aukro.cz/x-6' }), null, 'stav neznámý');
  assert.equal(await aukro.confirmGone(ctx, { source_id: 'x', url: 'https://aukro.cz/x' }), null);
  assert.deepEqual(f.unexpected, []);
});

test('formatCzDateTime / parseCzDateTime: pražský čas (letní i zimní)', () => {
  assert.equal(aukro.formatCzDateTime('2026-10-07T10:13:50+02:00'), '7. 10. 2026 10:13');
  assert.equal(aukro.formatCzDateTime('2026-12-24T23:30:00Z'), '25. 12. 2026 0:30');
  assert.equal(aukro.formatCzDateTime('nesmysl'), null);
  assert.equal(aukro.formatCzDateTime(undefined), null);
  assert.equal(new Date(aukro.parseCzDateTime('7. 10. 2026 10:13')).toISOString(), '2026-10-07T08:13:00.000Z');
  assert.equal(new Date(aukro.parseCzDateTime('25. 12. 2026 0:30')).toISOString(), '2026-12-24T23:30:00.000Z');
  assert.equal(aukro.parseCzDateTime('32. 1. 2026 10:00'), null);
  assert.equal(aukro.parseCzDateTime(null), null);
  // noci přechodu letní/zimní čas: format → parse vrátí stejný okamžik (mimo nejednoznačnou hodinu 2:00–2:59 v říjnu)
  for (const [from, to] of [
    [Date.UTC(2026, 2, 28, 20), Date.UTC(2026, 2, 29, 4)],
    [Date.UTC(2026, 9, 24, 20), Date.UTC(2026, 9, 25, 4)],
  ]) {
    for (let t = from; t < to; t += 15 * 60000) {
      const s = aukro.formatCzDateTime(new Date(t).toISOString());
      if (/^25\. 10\. 2026 2:/.test(s)) continue;
      assert.equal(aukro.parseCzDateTime(s), t, s);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Zapojení do pipeline: skutečný runPipeline nad DB v paměti; klasifikace a nacenění nahrazené (testují se zvlášť).

function loadPipeline() {
  const stubs = {
    [path.join(__dirname, '..', 'src', 'classify')]: {
      CLASSIFIER_VERSION: 'test-aukro',
      classifyListing: () => ({ isBike: true, bikeType: 'mtb_hardtail', reason: 'test', features: {} }),
    },
    [path.join(__dirname, '..', 'src', 'pricing')]: {
      trainModel: () => ({ summary: { stub: true } }),
      priceAll: () => 0,
    },
  };
  const origLoad = Module._load;
  Module._load = function (request, parent) {
    if (parent?.filename?.endsWith(`${path.sep}src${path.sep}pipeline.js`)) {
      const resolved = path.resolve(path.dirname(parent.filename), request);
      if (stubs[resolved]) return stubs[resolved];
    }
    return origLoad.apply(this, arguments);
  };
  try {
    return require('../src/pipeline');
  } finally {
    Module._load = origLoad;
  }
}

test('pipeline: Aukro → DB (nové, detaily, geolokace), další den změna ceny a zmizelé nabídky', async () => {
  const { runPipeline } = loadPipeline();
  const { openDb } = require('../src/db');
  const { loadConfig } = require('../src/config');
  const config = { ...loadConfig({}), sources: ['aukro'], maxDetails: 1000, minPrice: 500, ai: { enabled: false } };
  // Konec všech nabídek posunutý do budoucna → confirmGone se musí ptát API (test nezávisí na dnešním datu).
  const END = new Date(Date.now() + 7 * 86400000).toISOString();
  const LIVE = LIST.map((p) => ({ ...p, content: p.content.map((c) => ({ ...c, endingTime: END })) }));
  const liveRaw = (id) => LIVE.flatMap((p) => p.content).find((c) => c.itemId === id);
  const fixtures = Object.fromEntries([7122702822, 7123865595, 7127870584, 7131634758].map((id) => [String(id), { ...detailFx(id), endingTime: END }]));

  let pages = LIVE; // mění se mezi běhy
  let goneIds = new Set();
  const detailCalls = [];
  const details = (id) => {
    detailCalls.push(id);
    if (goneIds.has(id)) return 404;
    if (fixtures[id]) return fixtures[id];
    const r = liveRaw(Number(id));
    return r ? detailFromList(r) : undefined;
  };
  const g = fakeAukro((req) => apiRoutes({ pages, details })(req));

  const db = openDb(':memory:');
  const r1 = await runPipeline({ db, config, sources: [aukro], http: g.http, trigger: 'test' });
  assert.deepEqual(g.unexpected, []);
  assert.equal(r1.status, 'ok', JSON.stringify(r1));
  const s1 = r1.stats.sources.aukro;
  assert.equal(s1.mode, 'full');
  assert.equal(s1.complete, true);
  assert.equal(s1.new, 48);
  assert.equal(s1.details, 48);
  assert.equal(s1.detailErrors, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM listings WHERE source = 'aukro'").get().n, 48);
  for (const id of [...FOREIGN, ...CHEAP]) assert.equal(db.prepare('SELECT id FROM listings WHERE source_id = ?').get(id), undefined, id);

  const row = (id) => db.prepare('SELECT * FROM listings WHERE source = ? AND source_id = ?').get('aukro', String(id));
  const shop = row(7127870584);
  assert.equal(shop.price_czk, 8990);
  assert.equal(shop.price_note, 'Kup teď');
  assert.equal(shop.seller_type, 'company');
  assert.equal(shop.photo_count, 8);
  assert.equal(shop.views, 5);
  assert.equal(shop.kraj, 'JHM');
  assert.ok(shop.geo_precision && shop.lat != null && shop.lon != null, 'umístěno na mapu');
  assert.ok(shop.detail_at);
  assert.match(shop.description, /Olpran/);
  assert.match(shop.description, /\[telefon skryt\]/);
  assert.equal(JSON.parse(shop.params)['Doba záruky (měsíců)'], '24');
  const auction = row(7123865595);
  assert.equal(auction.price_czk, null);
  assert.match(auction.price_note, /^Aukce – aktuální cena/);
  assert.equal(auction.kraj, 'ZLK');
  assert.equal(auction.category_src, 'Horská (MTB) kola');
  assert.equal(row(7131634758).kraj, 'JHM');
  assert.equal(row(7122702822).kraj, 'PHA');
  const dump = JSON.stringify(db.prepare("SELECT * FROM listings WHERE source = 'aukro'").all());
  assert.doesNotMatch(dump, /REDACTED|700 000 000/, 'v DB nejsou údaje o prodávajícím ani telefon');

  // 2. den: poslední stránka zmizela (nabídky skončily), u jedné nabídky klesla cena Kup teď
  const p2Emitted = LIVE[2].content.map((c) => String(c.itemId)).filter((id) => row(id));
  assert.ok(p2Emitted.length >= 8);
  goneIds = new Set(p2Emitted);
  const keptUnique = new Set([...LIVE[0].content, ...LIVE[1].content].map((c) => c.itemId)).size;
  const cheaper = structuredClone(LIVE[0]);
  const amulet = cheaper.content.find((c) => c.itemId === 7134953681);
  amulet.buyNowPrice.amount = 5900;
  amulet.price.amount = 5900;
  pages = [cheaper, LIVE[1]].map((p, n) => ({ ...p, page: { number: n, size: 180, totalElements: keptUnique, totalPages: 2 } }));
  db.prepare("UPDATE settings SET value = ? WHERE key = 'lastFullScan:aukro'").run(JSON.stringify('2000-01-01T00:00:00Z'));
  detailCalls.length = 0;
  const r2 = await runPipeline({ db, config, sources: [aukro], http: g.http, trigger: 'test' });
  assert.deepEqual(g.unexpected, []);
  const s2 = r2.stats.sources.aukro;
  assert.equal(s2.complete, true);
  assert.equal(s2.new, 0);
  assert.equal(s2.details, 0, 'detaily se znovu nestahují');
  assert.equal(s2.gone, p2Emitted.length);
  assert.deepEqual([...new Set(detailCalls)].sort(), [...goneIds].sort(), 'API detailu jen (a právě) pro ověření zmizelých');
  assert.equal(s2.changed, 1, 'jen změna ceny; params výpisu a detailu se shodují');
  for (const id of p2Emitted) assert.ok(row(id).gone_at, `${id} zmizel`);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM listings WHERE source = 'aukro' AND gone_at IS NULL").get().n, 48 - p2Emitted.length);
  assert.equal(row(7134953681).price_czk, 5900);
  const hist = db.prepare('SELECT price_czk FROM price_history WHERE listing_id = ? ORDER BY at').all(row(7134953681).id).map((x) => x.price_czk);
  assert.deepEqual(hist, [6500, 5900]);
});
