'use strict';
// Zdroj Sbazar – offline nad uloženými (zkrácenými, anonymizovanými) odpověďmi API v test/fixtures/sbazar.
// Falešné ctx.http obsluhuje výpis (filtr kategorie a ceny, řazení od nejnovějších, limit offsetu 10 000 jako
// skutečné API), detail a překlad lokalit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sbazar = require('../src/sources/sbazar');
const { HttpError } = require('../src/util/http');

const FIX = path.join(__dirname, 'fixtures', 'sbazar');
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const L628 = load('list_628.json').results;
const L437 = load('list_437.json').results;
const LOCS = load('localities.json').samples;
const byId = (arr, id) => arr.find((r) => r.id === id);
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------------------------------------------------------
// Falešný server Sbazaru

/**
 * @param {{items?: object[], details?: Record<string, {status?: number, body?: any, ct?: string}>,
 *          locs?: Record<string, object>, override?: (u: URL) => ({status: number, body: any, ct?: string}|null)}} o
 */
function fakeSbazar(o = {}) {
  // výchozí data: fixtures Kola + Dětská kola a jedno odrážedlo (každá kategorie má aspoň 1 inzerát – prázdná
  // kategorie znamená neúplný výpis)
  const items = o.items ?? [...L628, ...L437, ...synth(1, { cat: 291, idBase: 960000000, price: () => 2500 })];
  const locs = o.locs ?? LOCS;
  const calls = [];
  const respond = (url, okStatuses, { status, body, ct = 'application/json; charset=utf-8' }) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const ok = (status >= 200 && status < 300) || (okStatuses || []).includes(status);
    if (!ok) throw new HttpError(`HTTP ${status} pro ${url}`, { status, url, body: text.slice(0, 500) });
    return { status, url, headers: new Headers({ 'content-type': ct }), text: () => text, json: () => JSON.parse(text), buffer: () => Buffer.from(text) };
  };
  const http = {
    async request(url, opts = {}) {
      calls.push(url);
      const u = new URL(url);
      assert.equal(u.host, 'www.sbazar.cz');
      const ov = o.override?.(u);
      if (ov) return respond(url, opts.okStatuses, ov);
      const q = u.searchParams;
      if (u.pathname === '/api/v1/items/search') {
        const cat = Number(q.get('category_id'));
        const offset = Number(q.get('offset'));
        const limit = Number(q.get('limit'));
        if (offset + limit > 10000) return respond(url, opts.okStatuses, { status: 422, body: load('too_high_offset.json') });
        const from = q.has('price_from') ? Number(q.get('price_from')) : null;
        const to = q.has('price_to') ? Number(q.get('price_to')) : null;
        const hit = items
          .filter((r) => r.category.id === cat)
          .filter((r) => r.price_by_agreement || ((from == null || r.price >= from) && (to == null || r.price <= to)))
          .sort((a, b) => (a.create_date < b.create_date ? 1 : a.create_date > b.create_date ? -1 : b.id - a.id));
        return respond(url, opts.okStatuses, {
          status: 200,
          body: { pagination: { limit, offset, total: hit.length }, results: hit.slice(offset, offset + limit), status_code: 200, status_message: 'OK', warnings: {} },
        });
      }
      const dm = u.pathname.match(/^\/api\/v1\/items\/(\d+)$/);
      if (dm) {
        const d = o.details?.[dm[1]];
        if (d) return respond(url, opts.okStatuses, { status: 200, ...d });
        return respond(url, opts.okStatuses, { status: 404, body: load('not_found.json') });
      }
      if (u.pathname === '/api/v1/localities/resolve') {
        const s = locs[`${q.get('entity_type')}:${q.get('entity_id')}`];
        if (s) return respond(url, opts.okStatuses, { status: 200, body: s });
        return respond(url, opts.okStatuses, { status: 404, body: load('not_found.json') });
      }
      return respond(url, opts.okStatuses, { status: 404, body: load('not_found.json') });
    },
  };
  return { http, calls, searches: () => calls.filter((c) => c.includes('/items/search')), resolves: () => calls.filter((c) => c.includes('/localities/resolve')) };
}

function mapCache(store = new Map()) {
  return { store, get: (k) => (store.has(k) ? clone(store.get(k)) : undefined), set: (k, v) => store.set(k, clone(v ?? null)), delete: (k) => store.delete(k) };
}

function makeCtx(http, o = {}) {
  const emitted = [];
  const logs = { warn: [], info: [], debug: [] };
  const known = o.known || new Set();
  const ctx = {
    http,
    log: { warn: (m) => logs.warn.push(m), info: (m) => logs.info.push(m), debug: (m) => logs.debug.push(m), error: (m) => logs.warn.push(m) },
    config: o.config || {},
    mode: o.mode ?? 'full',
    maxPages: o.maxPages ?? 400,
    minPrice: o.minPrice ?? 500,
    cache: o.cache === null ? undefined : o.cache || mapCache(),
    isKnown: (id) => (known.has(String(id)) ? { id: 1 } : null),
    emit: async (item) => {
      emitted.push(item);
      return { isNew: !known.has(item.sourceId), changed: true };
    },
  };
  return { ctx, emitted, logs };
}

/** Po jednom inzerátu v pásmu Kola od 5 000 Kč a v kategoriích 437 a 291 (prázdný segment = neúplný výpis). */
const others = () => [
  ...synth(1, { cat: 628, idBase: 940000000, price: () => 12000 }),
  ...synth(1, { cat: 437, idBase: 950000000, price: () => 9000 }),
  ...synth(1, { cat: 291, idBase: 960000000, price: () => 2500 }),
];

/** Prague-local „YYYY-MM-DDTHH:MM:SS“ z milisekund (jen pro řazení v testech). */
const localStr = (ms) => new Date(ms).toISOString().slice(0, 19);

/** n syntetických inzerátů ze šablony (nejnovější první). */
function synth(n, { cat = 628, start = Date.UTC(2026, 9, 2, 12), stepMs = 10 * 60 * 1000, price = () => 8000, idBase = 300000000, tpl = byId(L628, 234515478), user } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = clone(tpl);
    r.id = idBase + n - i;
    r.seo_name = `${r.id}-kolo-${i}`;
    r.name = `Kolo ${i}`;
    r.create_date = localStr(start - i * stepMs);
    const p = price(i);
    r.price_by_agreement = p === 'dohodou';
    r.price = p === 'dohodou' ? 0 : p;
    r.category = { ...r.category, id: cat };
    if (user) r.user = { id: user(i) };
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Normalizace

test('normalizeListItem: url, titulek, cena, datum, lokalita, PSČ, fotka, kategorie', () => {
  const a = sbazar.normalizeListItem(byId(L628, 234515967));
  assert.deepEqual(a, {
    sourceId: '234515967',
    url: 'https://www.sbazar.cz/inzerat/234515967-horske-kolo-kellys-vanity-50',
    title: 'Horské kolo KELLYS VANITY 50',
    priceCzk: 6300,
    priceNote: null,
    postedAt: '2026-10-02T12:59:32.000Z',
    categorySrc: 'Kola',
    locationText: 'Šardice',
    okres: 'Hodonín',
    kraj: 'Jihomoravský kraj',
    photoUrl: 'https://d46-a.sdn.cz/d_46/c_img_qG_A/kcKfrMAkFMsuhNraH7xVQq/63c1.jpeg?fl=exf|res,1024,768,1|wrm,/watermark/sbazar.png,10,10|webp,75',
    params: {},
    sellerType: 'private',
    detailComplete: false,
  });
  // části obcí
  const loc = (id, arr = L628) => sbazar.normalizeListItem(byId(arr, id)).locationText;
  assert.equal(loc(234515478), 'Brno-Židenice');
  assert.equal(loc(234513321), 'Praha 5');
  assert.equal(loc(234511107), 'Praha - Smíchov');
  assert.equal(loc(234512046), 'České Budějovice 2');
  assert.equal(loc(234505983, L437), 'Zlín');
  assert.equal(loc(234465612, L437), 'Pardubice - Zelené Předměstí');
  // PSČ na 5 číslic
  assert.equal(sbazar.normalizeListItem(byId(L628, 234515325)).psc, '67151');
  assert.equal(sbazar.normalizeListItem(byId(L437, 234465612)).psc, '53002');
  assert.equal(sbazar.normalizeListItem(byId(L628, 234515967)).psc, undefined);
  // dětský bazar
  assert.equal(sbazar.normalizeListItem(byId(L437, 234505983)).categorySrc, 'Dětský bazar › Kola a koloběžky');
  // rezervace jako údaj webu
  assert.deepEqual(sbazar.normalizeListItem(byId(L628, 234471468)).params, { Rezervováno: 'ano' });
});

test('normalizeListItem: firemní profil, ochrana kupujícího, neúplná položka, bez osobních údajů', () => {
  const r = { ...clone(byId(L628, 234515967)), premise: { id: 5, name: 'Cyklo s.r.o.' }, buyer_protection: true, user: { id: 42, user_service: { shop_url: 'x', shop_name: 'Jan' } } };
  const n = sbazar.normalizeListItem(r);
  assert.equal(n.sellerType, 'company');
  assert.deepEqual(n.params, { 'Ochrana kupujícího': 'ano' });
  assert.doesNotMatch(JSON.stringify(n), /Jan|shop|user|Cyklo s\.r\.o\./);
  assert.equal(sbazar.normalizeListItem({ ...r, name: '  ' }), null);
  assert.equal(sbazar.normalizeListItem({ ...r, id: 'abc' }), null);
  assert.equal(sbazar.normalizeListItem(null), null);
  // podivné seo_name → odkaz jen s id
  assert.equal(sbazar.normalizeListItem({ ...r, seo_name: '../x' }).url, 'https://www.sbazar.cz/inzerat/234515967');
});

test('priceInfo: dohodou, 0 Kč, běžná cena, původní cena jen v detailu', () => {
  assert.deepEqual(sbazar.priceInfo({ price: 0, price_by_agreement: true }), { priceCzk: null, priceNote: 'Dohodou' });
  assert.deepEqual(sbazar.priceInfo({ price: 0, price_by_agreement: false }), { priceCzk: null, priceNote: 'Zdarma / v textu' });
  assert.deepEqual(sbazar.priceInfo({ price: 6300, price_by_agreement: false }), { priceCzk: 6300, priceNote: null });
  assert.deepEqual(sbazar.priceInfo({ price: 9000, price_original: 12500 }), { priceCzk: 9000, priceNote: null });
  assert.deepEqual(sbazar.priceInfo({ price: 9000, price_original: 12500 }, true), { priceCzk: 9000, priceNote: 'původně 12 500 Kč' });
  assert.deepEqual(sbazar.priceInfo({ price: 9000, price_original: 9000 }, true), { priceCzk: 9000, priceNote: null });
  assert.deepEqual(sbazar.priceInfo({ price: 0, price_by_agreement: true, price_original: 5000 }, true), { priceCzk: null, priceNote: 'Dohodou' });
  assert.deepEqual(sbazar.priceInfo({ price: -5 }), { priceCzk: null, priceNote: null });
  // číslo jako řetězec (změna formátu API) se ještě přečte, nesmysl ne
  assert.deepEqual(sbazar.priceInfo({ price: '6300' }), { priceCzk: 6300, priceNote: null });
  assert.deepEqual(sbazar.priceInfo({ price: '6 300 Kč' }), { priceCzk: null, priceNote: null });
  assert.deepEqual(sbazar.priceInfo({}), { priceCzk: null, priceNote: null });
});

test('pragueToIso: zimní i letní čas včetně dnů přechodu', () => {
  const t = sbazar.pragueToIso;
  assert.equal(t('2026-01-15T12:00:00'), '2026-01-15T11:00:00.000Z');
  assert.equal(t('2026-07-15T12:00:00'), '2026-07-15T10:00:00.000Z');
  assert.equal(t('2026-10-02T14:59:32'), '2026-10-02T12:59:32.000Z');
  // jaro 29. 3. 2026: 02:00 → 03:00
  assert.equal(t('2026-03-29T01:59:59'), '2026-03-29T00:59:59.000Z');
  assert.equal(t('2026-03-29T03:00:00'), '2026-03-29T01:00:00.000Z');
  assert.equal(t('2026-03-29T02:30:00'), '2026-03-29T01:30:00.000Z'); // neexistující hodina → 03:30 letního času
  // podzim 25. 10. 2026: 03:00 → 02:00 (02:xx dvakrát → první výskyt, letní čas)
  assert.equal(t('2026-10-25T01:59:59'), '2026-10-24T23:59:59.000Z');
  assert.equal(t('2026-10-25T02:30:00'), '2026-10-25T00:30:00.000Z');
  assert.equal(t('2026-10-25T03:00:00'), '2026-10-25T02:00:00.000Z');
  // jiný rok (poslední neděle se liší): 2027 – 28. 3. a 31. 10.
  assert.equal(t('2027-03-28T03:30:00'), '2027-03-28T01:30:00.000Z');
  assert.equal(t('2027-10-30T12:00:00'), '2027-10-30T10:00:00.000Z');
  assert.equal(t('2027-10-31T12:00:00'), '2027-10-31T11:00:00.000Z');
  // přelom roku, mezera místo T, čas se zónou
  assert.equal(t('2026-01-01T00:30:00'), '2025-12-31T23:30:00.000Z');
  assert.equal(t('2026-07-01 08:00:00'), '2026-07-01T06:00:00.000Z');
  assert.equal(t('2026-07-01T08:00:00Z'), '2026-07-01T08:00:00.000Z');
  assert.equal(t('2026-07-01T08:00:00+02:00'), '2026-07-01T06:00:00.000Z');
  for (const bad of ['', null, undefined, '2026-02-31T10:00:00', '2026-13-01T10:00:00', '2.10.2026', 12345]) assert.equal(t(bad), undefined, String(bad));
  // shoda s IANA databází (Intl) po celý rok 2026 po hodinách
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 3600 * 1000) {
    const local = fmt.format(new Date(ms)).replace(' ', 'T');
    if (local.startsWith('2026-10-25T02')) continue; // dvojznačná hodina – ověřeno výše
    assert.equal(t(local), new Date(ms).toISOString(), local);
  }
});

test('photoUrlOf: ověřený řetězec úprav 1024×768, jen sdn.cz', () => {
  const fl = '?fl=exf|res,1024,768,1|wrm,/watermark/sbazar.png,10,10|webp,75';
  assert.equal(sbazar.photoUrlOf('//d46-a.sdn.cz/d_46/c_img_qG_A/abc/63c1.jpeg'), `https://d46-a.sdn.cz/d_46/c_img_qG_A/abc/63c1.jpeg${fl}`);
  assert.equal(sbazar.photoUrlOf('http://d46-a.sdn.cz/d_46/x.jpeg?fl=res,100,100,3'), `https://d46-a.sdn.cz/d_46/x.jpeg${fl}`);
  assert.equal(sbazar.photoUrlOf('https://evil.example.com/x.jpeg'), undefined);
  assert.equal(sbazar.photoUrlOf('//sdn.cz.evil.com/x.jpeg'), undefined);
  assert.equal(sbazar.photoUrlOf(''), undefined);
  assert.equal(sbazar.photoUrlOf(null), undefined);
});

test('locationOf: obec, část obce, okres bez obce, sloučené obce', () => {
  assert.deepEqual(sbazar.locationOf({ municipality: 'Brno', citypart: 'Královo Pole', ward: 'Královo Pole', district: 'Brno-město', region: 'Jihomoravský kraj', zip: '612 00' }), {
    locationText: 'Brno - Královo Pole',
    okres: 'Brno-město',
    kraj: 'Jihomoravský kraj',
    psc: '61200',
  });
  assert.equal(sbazar.locationOf({ municipality: 'Brandýs nad Labem-Stará Boleslav', citypart: 'Brandýs nad Labem' }).locationText, 'Brandýs nad Labem-Stará Boleslav');
  assert.deepEqual(sbazar.locationOf({ municipality: '', district: 'Hodonín', region: 'Jihomoravský kraj', zip: '' }), { okres: 'Hodonín', kraj: 'Jihomoravský kraj' });
  assert.deepEqual(sbazar.locationOf(null), {});
  assert.equal(sbazar.localityKey({ entity_type: 'district', entity_id: 39 }), null);
  assert.equal(sbazar.localityKey({ entity_type: 'ward', entity_id: 14682 }), 'ward:14682');
  assert.equal(sbazar.localityKey({ entity_type: 'municipality', entity_id: 0 }), null);
});

test('splitBand / fmtBand', () => {
  assert.deepEqual(sbazar.splitBand({ from: null, to: 4999 }), [{ from: null, to: 2499 }, { from: 2500, to: 4999 }]);
  assert.deepEqual(sbazar.splitBand({ from: 5000, to: null }), [{ from: 5000, to: 9999 }, { from: 10000, to: null }]);
  assert.deepEqual(sbazar.splitBand({ from: null, to: null }), [{ from: null, to: 4999 }, { from: 5000, to: null }]);
  assert.deepEqual(sbazar.splitBand({ from: 1000, to: 1001 }), [{ from: 1000, to: 1000 }, { from: 1001, to: 1001 }]);
  assert.equal(sbazar.splitBand({ from: 1000, to: 1000 }), null);
  assert.equal(sbazar.fmtBand({ from: null, to: 4999 }), 'do 4 999 Kč');
  assert.equal(sbazar.fmtBand({ from: 5000, to: null }), 'od 5 000 Kč');
  assert.equal(sbazar.fmtBand({ from: 2500, to: 4999 }), '2 500–4 999 Kč');
  assert.equal(sbazar.fmtBand({ from: null, to: null }), 'všechny ceny');
});

// ---------------------------------------------------------------------------------------------------------------
// Výpis

test('scan full: kategorie, cenová pásma, jedno timestamp_to, duplicity „dohodou“, minimální cena, souřadnice', async () => {
  const srv = fakeSbazar();
  const { ctx, emitted } = makeCtx(srv.http, { minPrice: 500 });
  const res = await sbazar.scan(ctx);
  assert.equal(res.complete, true);
  // 628 ve dvou pásmech, 437, 291
  const searches = srv.searches().map((u) => new URL(u).searchParams);
  assert.deepEqual(
    searches.map((q) => [q.get('category_id'), q.get('price_from'), q.get('price_to'), q.get('offset')]),
    [['628', null, '4999', '0'], ['628', '5000', null, '0'], ['437', null, null, '0'], ['291', null, null, '0']]
  );
  assert.ok(searches.every((q) => q.get('sort') === '-create_date' && q.get('limit') === '500'));
  assert.equal(new Set(searches.map((q) => q.get('timestamp_to'))).size, 1, 'jedno timestamp_to na celý běh');
  assert.ok(Math.abs(Number(searches[0].get('timestamp_to')) - Date.now() / 1000) < 60);
  // „dohodou“ (234512184) je v obou pásmech, ale vyjde jednou; 300 Kč (234507753) pod minimální cenou
  const ids = emitted.map((i) => i.sourceId);
  assert.equal(ids.length, new Set(ids).size);
  assert.equal(ids.filter((id) => id === '234512184').length, 1);
  assert.ok(!ids.includes('234507753'));
  assert.ok(ids.includes('234510066'), '500 Kč = minimální cena projde');
  assert.ok(ids.includes('234515025'), '0 Kč bez dohody (cena v textu) projde');
  assert.equal(emitted.length, L628.length - 1 + L437.length + 1);
  assert.equal(res.duplicates, 1);
  assert.equal(res.cheap, 1);
  // souřadnice z překladu lokalit (vzorky ve fixtures), ostatní bez lat/lon
  const brno = emitted.find((i) => i.sourceId === '234515478');
  assert.deepEqual([brno.lat, brno.lon], [49.196302, 16.647522]);
  const zlin = emitted.find((i) => i.sourceId === '234505983');
  assert.deepEqual([zlin.lat, zlin.lon], [49.226655, 17.666337]);
  const sardice = emitted.find((i) => i.sourceId === '234515967');
  assert.deepEqual([sardice.lat, sardice.lon], [48.964028, 17.028118]);
  const radim = emitted.find((i) => i.sourceId === '234510066');
  assert.equal(radim.lat, undefined);
  // každá lokalita se překládá jen jednou
  const keys = srv.resolves().map((u) => `${new URL(u).searchParams.get('entity_type')}:${new URL(u).searchParams.get('entity_id')}`);
  assert.equal(keys.length, new Set(keys).size);
  // žádné osobní údaje ani interní pole
  for (const it of emitted) {
    assert.ok(it.sourceId && it.url.startsWith('https://www.sbazar.cz/inzerat/') && it.title);
    assert.equal(it.sellerType, 'private');
    assert.doesNotMatch(JSON.stringify(it), /user|shop|portrait|premise|entity/);
  }
});

test('scan full: pásmo nad limitem 10 000 se rekurzivně rozdělí podle ceny, nic se neztratí ani nezdvojí', async () => {
  const lower = synth(9800, { price: (i) => (i % 97 === 0 ? 'dohodou' : 100 + ((i * 7919) % 4900)), idBase: 400000000 });
  const upper = synth(300, { price: (i) => 5000 + i * 10, idBase: 500000000 });
  const srv = fakeSbazar({ items: [...lower, ...upper, ...others()], locs: {} });
  const { ctx, emitted, logs } = makeCtx(srv.http, { minPrice: 0, config: { sbazarMaxResolve: 0 } });
  const res = await sbazar.scan(ctx);
  assert.equal(res.complete, true);
  assert.equal(emitted.length, 10103);
  assert.equal(new Set(emitted.map((i) => i.sourceId)).size, 10103);
  assert.ok(logs.warn.some((m) => /dělím na do 2 499 Kč a 2 500–4 999 Kč/.test(m)), logs.warn.join('\n'));
  for (const u of srv.searches()) {
    const q = new URL(u).searchParams;
    assert.ok(Number(q.get('offset')) + Number(q.get('limit')) <= 10000, u);
  }
  const bands = new Set(srv.searches().map((u) => `${new URL(u).searchParams.get('price_from')}-${new URL(u).searchParams.get('price_to')}`));
  assert.ok(bands.has('null-2499') && bands.has('2500-4999'));
});

test('scan full: pásmo, které už nejde dělit (jedna cena), projde jen do limitu → neúplné', async () => {
  const items = [...synth(10300, { price: () => 1000, idBase: 600000000 }), ...others()];
  const srv = fakeSbazar({ items, locs: {} });
  const { ctx, emitted, logs } = makeCtx(srv.http, { minPrice: 0, config: { sbazarMaxResolve: 0 } });
  const res = await sbazar.scan(ctx);
  assert.equal(res.complete, false);
  assert.equal(emitted.length, 10003);
  assert.ok(logs.warn.some((m) => /nejde dál dělit/.test(m)));
  assert.ok(srv.searches().every((u) => Number(new URL(u).searchParams.get('offset')) <= 9500));
  // 9 700 inzerátů za jednu cenu: dělit nejde, ale pod limitem 10 000 projde pásmo celé → úplné
  const srv2 = fakeSbazar({ items: [...synth(9700, { price: () => 1000, idBase: 610000000 }), ...others()], locs: {} });
  const r2 = makeCtx(srv2.http, { minPrice: 0, config: { sbazarMaxResolve: 0 } });
  assert.equal((await sbazar.scan(r2.ctx)).complete, true);
  assert.equal(r2.emitted.length, 9703);
});

test('scan full: limit stránek platí pro každý segment zvlášť → neúplné', async () => {
  const items = [...synth(1200, { price: () => 8000 }), ...synth(700, { price: () => 2000, idBase: 900000000 })];
  const srv = fakeSbazar({ items, locs: {} });
  const { ctx, emitted, logs } = makeCtx(srv.http, { maxPages: 1, config: { sbazarMaxResolve: 0 } });
  const res = await sbazar.scan(ctx);
  assert.equal(res.complete, false);
  // 628: pásmo do 4 999 i od 5 000 dostane po 1 stránce (spodní pásmo nevyčerpá limit hornímu)
  const q = srv.searches().map((u) => new URL(u).searchParams);
  assert.deepEqual(q.filter((x) => x.get('category_id') === '628').map((x) => [x.get('price_to'), x.get('price_from'), x.get('offset')]), [
    ['4999', null, '0'],
    [null, '5000', '0'],
  ]);
  assert.equal(emitted.length, 1000);
  assert.ok(logs.warn.some((m) => /limit 1 stránek/.test(m)));
});

test('scan incremental: konec na stránce jen se známými inzeráty staršími než nejnovější známý − 1 den', async () => {
  // 2000 inzerátů po 10 minutách (≈ 14 dní), všechny nad 5 000 Kč → pásmo „od 5 000 Kč“
  const items = synth(2000, { price: () => 8000 });
  const ids = items.map((r) => String(r.id));
  // a) známé od 300. inzerátu: strana 2 (500–999) je celá známá a o 33 h starší než nejnovější známý → konec po 2 stranách
  {
    const srv = fakeSbazar({ items, locs: {} });
    const { ctx, emitted } = makeCtx(srv.http, { mode: 'incremental', known: new Set(ids.slice(300)) });
    const res = await sbazar.scan(ctx);
    assert.equal(res.complete, false);
    const upper = srv.searches().filter((u) => new URL(u).searchParams.get('price_from') === '5000');
    assert.equal(upper.length, 2);
    assert.equal(emitted.length, 1000);
    // nové inzeráty soukromé, u známých se typ prodávajícího nemění (počet inzerátů účtu neznáme)
    assert.equal(emitted.find((i) => i.sourceId === ids[0]).sellerType, 'private');
    assert.ok(!('sellerType' in emitted.find((i) => i.sourceId === ids[400])));
  }
  // b) známé od 450.: strana 2 je jen o 8 h starší (pozdě schválené inzeráty) → ještě strana 3
  {
    const srv = fakeSbazar({ items, locs: {} });
    const { ctx } = makeCtx(srv.http, { mode: 'incremental', known: new Set(ids.slice(450)) });
    await sbazar.scan(ctx);
    assert.equal(srv.searches().filter((u) => new URL(u).searchParams.get('price_from') === '5000').length, 3);
  }
  // c) neznámý inzerát na straně 2 (např. pozdě schválený) → strana 2 se nepočítá jako „vše známé“, pokračuje se;
  //    neznámý inzerát hlouběji (strana 4) už inkrementální běh nehledá – dožene ho úplný průchod
  {
    const known = new Set(ids.slice(300));
    known.delete(ids[700]);
    known.delete(ids[1700]);
    const srv = fakeSbazar({ items, locs: {} });
    const { ctx, emitted } = makeCtx(srv.http, { mode: 'incremental', known });
    await sbazar.scan(ctx);
    assert.equal(srv.searches().filter((u) => new URL(u).searchParams.get('price_from') === '5000').length, 3);
    assert.ok(emitted.some((i) => i.sourceId === ids[700]));
    assert.ok(!emitted.some((i) => i.sourceId === ids[1700]));
  }
  // d) maxPages platí i v inkrementálním režimu (na segment)
  {
    const srv = fakeSbazar({ items, locs: {} });
    const { ctx, emitted } = makeCtx(srv.http, { mode: 'incremental', maxPages: 1 });
    await sbazar.scan(ctx);
    assert.equal(srv.searches().filter((u) => new URL(u).searchParams.get('price_from') === '5000').length, 1);
    assert.equal(emitted.length, 500);
  }
});

test('scan: účet s ≥ 8 inzeráty → obchod; id účtu se nikam neukládá', async () => {
  const a = synth(8, { price: () => 9000, idBase: 700000000, user: () => 'acc-A' });
  const b = synth(7, { price: () => 9000, idBase: 710000000, user: () => 'acc-B' });
  const prem = synth(1, { price: () => 9000, idBase: 720000000, user: () => 'acc-C' });
  prem[0].premise = { id: 9, name: 'Cyklo s.r.o.' };
  const srv = fakeSbazar({ items: [...a, ...b, ...prem], locs: {} });
  const { ctx, emitted } = makeCtx(srv.http);
  await sbazar.scan(ctx);
  const type = (arr) => new Set(arr.map((r) => emitted.find((i) => i.sourceId === String(r.id)).sellerType));
  assert.deepEqual(type(a), new Set(['company']));
  assert.deepEqual(type(b), new Set(['private']));
  assert.deepEqual(type(prem), new Set(['company']));
  assert.doesNotMatch(JSON.stringify(emitted), /acc-|Cyklo s\.r\.o\./);
});

test('scan: souřadnice lokalit z trvalé cache – druhý běh už nepřekládá; neúspěch se pamatuje; limit na běh', async () => {
  const cache = mapCache();
  const srv = fakeSbazar();
  const r1 = makeCtx(srv.http, { cache });
  await sbazar.scan(r1.ctx);
  const first = srv.resolves().length;
  assert.ok(first > 0);
  // vzorek z fixtures → souřadnice, neznámá lokalita (404) → {none} (zkusí se znovu až za 30 dní)
  assert.deepEqual(cache.get('loc:quarter:15'), { lat: 49.196302, lon: 16.647522 });
  assert.equal(cache.get('loc:municipality:3465').none, true);
  assert.equal(srv.resolves().filter((u) => u.includes('entity_type=district')).length, 0, 'okres se nepřekládá');
  const r2 = makeCtx(srv.http, { cache });
  await sbazar.scan(r2.ctx);
  assert.equal(srv.resolves().length, first, 'druhý běh bez překladu');
  const brno = r2.emitted.find((i) => i.sourceId === '234515478');
  assert.deepEqual([brno.lat, brno.lon], [49.196302, 16.647522]);
  // starý záznam o neúspěchu → zkusí znovu
  cache.set('loc:municipality:3465', { none: true, at: '2026-01-01T00:00:00.000Z' });
  await sbazar.scan(makeCtx(srv.http, { cache }).ctx);
  assert.equal(srv.resolves().length, first + 1);

  // limit na běh: nejčastější lokalita první
  const items = [...synth(5, { price: () => 9000, idBase: 800000000, tpl: byId(L628, 234513321) }), ...synth(2, { price: () => 9000, idBase: 810000000, tpl: byId(L628, 234515478) })];
  const srv2 = fakeSbazar({ items });
  const r3 = makeCtx(srv2.http, { config: { sbazarMaxResolve: 1 } });
  await sbazar.scan(r3.ctx);
  assert.equal(srv2.resolves().length, 1);
  assert.match(srv2.resolves()[0], /entity_id=97&entity_type=quarter/);
  assert.ok(r3.emitted.filter((i) => i.locationText === 'Praha 5').every((i) => i.lat === 50.055293));
  assert.ok(r3.emitted.filter((i) => i.locationText === 'Brno-Židenice').every((i) => i.lat === undefined));

  // bez ctx.cache (např. ladicí nástroj) funguje s cache jen v paměti
  const srv3 = fakeSbazar();
  const r4 = makeCtx(srv3.http, { cache: null });
  await sbazar.scan(r4.ctx);
  assert.ok(r4.emitted.find((i) => i.sourceId === '234515478').lat);
});

test('scan: HTML / captcha / 403 → srozumitelná chyba, už stažené inzeráty se předají', async () => {
  const html = '<!DOCTYPE html><html><body><div class="g-recaptcha">Ověřte, že nejste robot</div></body></html>';
  const srv = fakeSbazar({
    override: (u) => (u.pathname.endsWith('/search') && u.searchParams.get('category_id') === '437' ? { status: 200, body: html, ct: 'text/html' } : null),
  });
  const { ctx, emitted } = makeCtx(srv.http);
  await assert.rejects(sbazar.scan(ctx), (e) => /Sbazar vrátil místo dat HTML stránku s ověřením „nejste robot“ \(captcha\)/.test(e.message) && e.fatal === true);
  assert.equal(emitted.length, L628.length - 1, 'inzeráty z kategorie Kola se uložily');
  assert.equal(srv.resolves().length, 0, 'po zablokování už žádné další požadavky');
  // další požadavky v témže běhu (detail) se už neposílají
  const before = srv.calls.length;
  await assert.rejects(sbazar.detail(ctx, { source_id: '234515478' }), /HTML/);
  assert.equal(srv.calls.length, before);

  const srv403 = fakeSbazar({ override: (u) => (u.pathname.endsWith('/search') ? { status: 403, body: 'Forbidden', ct: 'text/plain' } : null) });
  await assert.rejects(sbazar.scan(makeCtx(srv403.http).ctx), /Sbazar odmítl přístup \(HTTP 403\)/);
});

test('scan: chyba jednoho pásma → ostatní projdou, výsledek neúplný; selže-li vše → výjimka', async () => {
  const srv = fakeSbazar({
    override: (u) => (u.pathname.endsWith('/search') && u.searchParams.get('price_from') === '5000' ? { status: 500, body: { status_code: 500 } } : null),
  });
  const { ctx, emitted, logs } = makeCtx(srv.http);
  const res = await sbazar.scan(ctx);
  assert.equal(res.complete, false);
  assert.ok(emitted.some((i) => i.sourceId === '234505983'), 'dětská kola prošla');
  assert.ok(!emitted.some((i) => i.sourceId === '234512556'), 'drahá kola chybí');
  assert.ok(logs.warn.some((m) => /selhal – pokračuji dalším/.test(m)));

  const bad = fakeSbazar({ override: (u) => (u.pathname.endsWith('/search') ? { status: 200, body: { foo: 1 } } : null) });
  await assert.rejects(sbazar.scan(makeCtx(bad.http).ctx), /neočekávaná odpověď výpisu/);
});

test('scan: přerušení během stahování', async () => {
  const ac = new AbortController();
  const srv = fakeSbazar();
  const { ctx } = makeCtx(srv.http);
  ctx.signal = ac.signal;
  ac.abort(new Error('Přerušeno uživatelem'));
  await assert.rejects(sbazar.scan(ctx), /Přerušeno uživatelem/);
  assert.equal(srv.calls.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// Detail a ověření zmizelých

test('detail: popis, počet fotek, fotka, platnost, původní cena; 404 → null', async () => {
  const d1 = load('detail_234515478.json');
  const d2 = load('detail_227490322.json');
  const d3 = load('detail_234505983.json');
  d3.result.price_original = 9990;
  const srv = fakeSbazar({ details: { 234515478: { body: d1 }, 227490322: { body: d2 }, 234505983: { body: d3 } } });
  const { ctx } = makeCtx(srv.http);
  const a = await sbazar.detail(ctx, { source_id: '234515478' });
  assert.match(a.description, /^Prodám silniční kolo Triban RC120/);
  assert.match(a.description, /Brně-Židenicích\.$/);
  assert.equal(a.photoCount, 17);
  assert.equal(a.photoUrl, `https://d46-a.sdn.cz/d_46/c_img_qG_A/kcKfrMAkFnIwlPJSH7wvsY/b1d1.jpeg?${sbazar.IMG_FL}`);
  assert.deepEqual(a.params, { 'Platnost do': '1. 12. 2026' });
  assert.equal(a.priceCzk, 10000);
  assert.equal(a.priceNote, null);
  assert.equal(a.detailComplete, true);
  assert.equal(a.locationText, 'Brno-Židenice');
  assert.ok(!('sellerType' in a), 'bez firemního profilu typ prodávajícího nemění');
  const b = await sbazar.detail(ctx, { source_id: '227490322' });
  assert.deepEqual([b.priceCzk, b.priceNote, b.photoCount], [null, 'Dohodou', 2]);
  assert.match(b.description, /^Velmi pěkné kvalitní elektrokolo/);
  const c = await sbazar.detail(ctx, { source_id: '234505983' });
  assert.equal(c.priceNote, 'původně 9 990 Kč');
  assert.equal(await sbazar.detail(ctx, { source_id: '111' }), null);
  await assert.rejects(sbazar.detail(ctx, { source_id: 'x1' }), /neplatné id/);
  assert.doesNotMatch(JSON.stringify([a, b, c]), /user|shop|portrait|phone/);
  // detail jiného inzerátu (přesměrování / chyba API) → chyba, ne cizí data
  const srvBad = fakeSbazar({ details: { 5: { body: d1 } } });
  await assert.rejects(sbazar.detail(makeCtx(srvBad.http).ctx, { source_id: '5' }), /neočekávaná odpověď detailu/);
  // 404 jako HTML stránka (změna API) NENÍ „smazáno“
  const srvHtml = fakeSbazar({ override: (u) => (u.pathname.startsWith('/api/v1/items/') ? { status: 404, body: '<html>Stránka nenalezena</html>', ct: 'text/html' } : null) });
  await assert.rejects(sbazar.detail(makeCtx(srvHtml.http).ctx, { source_id: '111' }), /HTML stránku/);
});

test('confirmGone: 404 → true, aktivní → false, jiný stav → null, mimo kola / pod minimální cenou → true', async () => {
  const active = load('detail_234515478.json');
  const inactive = clone(active);
  inactive.result.id = 2;
  inactive.result.status = 'inactive';
  const moved = clone(active);
  moved.result.id = 3;
  moved.result.category = { id: 630, name: 'Koloběžky' };
  const cheap = clone(active);
  cheap.result.id = 4;
  cheap.result.price = 300;
  const srv = fakeSbazar({
    details: { 234515478: { body: active }, 2: { body: inactive }, 3: { body: moved }, 4: { body: cheap } },
    override: (u) => (u.pathname.endsWith('/items/5') ? { status: 500, body: {} } : null),
  });
  const { ctx } = makeCtx(srv.http, { minPrice: 500 });
  assert.equal(await sbazar.confirmGone(ctx, { source_id: '1' }), true);
  assert.equal(await sbazar.confirmGone(ctx, { source_id: '234515478' }), false);
  assert.equal(await sbazar.confirmGone(ctx, { source_id: '2' }), null);
  assert.equal(await sbazar.confirmGone(ctx, { source_id: '3' }), true);
  assert.equal(await sbazar.confirmGone(ctx, { source_id: '4' }), true);
  assert.equal(await sbazar.confirmGone(ctx, { source_id: '5' }), null);
  assert.equal(await sbazar.confirmGone(ctx, { source_id: '' }), null);
});

test('modul: kontrakt zdroje', () => {
  assert.equal(sbazar.key, 'sbazar');
  assert.equal(sbazar.label, 'Sbazar');
  assert.equal(sbazar.homepage, 'https://www.sbazar.cz');
  assert.equal(sbazar.requiresBrowser, false);
  for (const f of ['scan', 'detail', 'confirmGone']) assert.equal(typeof sbazar[f], 'function');
  assert.deepEqual(sbazar.CATEGORIES.map((c) => c.id), [628, 437, 291]);
});
