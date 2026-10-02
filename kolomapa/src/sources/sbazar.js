'use strict';
// Zdroj Sbazar (sbazar.cz) – veřejné JSON API, které používá samotný web (bez cookies, přihlášení i prohlížeče).
//
// VE VÝCHOZÍM STAVU VYPNUTÝ: robots.txt Sbazaru (ověřeno 2. 10. 2026) má pro všechny roboty „Disallow: /“.
// Zapnout ho (KOLOMAPA_SOURCES=bazos,sbazar) je rozhodnutí provozovatele – ideálně s výslovným souhlasem Sbazaru
// (Seznam.cz), např. přes oficiální export / partnerský přístup.
//
// Kategorie (Sbazar nemá podkategorie kol – vše je v jedné kategorii, ~15–20 % tvoří díly a doplňky):
//   628 Sport › Letní sporty › Kola (~10 000 inzerátů), 437 Dětský bazar › Kola a koloběžky, 291 Dětský bazar › Odrážedla.
//
// Jak to funguje:
//  - Výpis: GET /api/v1/items/search?category_id=…&offset=…&limit=500&sort=-create_date&timestamp_to=<unix s>.
//    sort=-create_date = přísně od nejnovějších (bez připnutých topovaných), jedno timestamp_to na celý běh
//    „zmrazí“ výsledek, takže se během průchodu neposouvá. API dovolí jen offset + limit ≤ 10 000 (jinak 422
//    too_high_offset) → kategorie Kola se prochází ve dvou cenových pásmech (do 4 999 Kč / od 5 000 Kč) a pásmo,
//    které by i tak mělo přes ~9 500 inzerátů, se rekurzivně půlí podle ceny. Inzeráty „dohodou“ (cena 0) API vrací
//    v KAŽDÉM cenovém pásmu → odstranění duplicit podle id.
//  - Inkrementální režim: každé pásmo od nejnovějších, konec, když celá stránka obsahuje jen už známé inzeráty
//    starší než (nejnovější známý inzerát − 1 den). Úplný průchod (complete: true) jen v režimu 'full', když se
//    všechna pásma prošla celá a bez chyby.
//  - Detail: GET /api/v1/items/<id> → popis, fotky, původní cena, platnost; 404 = inzerát neexistuje.
//  - Souřadnice: lokalita inzerátu (obec / část obce) se přeloží přes /api/v1/localities/resolve a výsledek se trvale
//    uloží do ctx.cache (stovky inzerátů sdílí jednu obec; nové lokality jen pár desítek denně). Na jeden běh se
//    přeloží nejvýš MAX_RESOLVE_PER_RUN nových lokalit (nejčastější první); zbytek dočtou další běhy a do té doby
//    poloha vychází z textu (obec / okres) v src/geo.
//  - Fotka: obrázkový server sdn.cz vydá soubor jen s povoleným řetězcem úprav („fl=…“) – holá adresa vrací 401.
//    Ověřeno: 1024×768 webp s vodoznakem Sbazaru, bez cookies i refereru.
//  - Soukromí: jméno, přezdívka, portrét, adresa profilu ani id prodávajícího se neukládají. Id účtu slouží jen
//    během běhu v paměti k počítání inzerátů (≥ 8 inzerátů kol na jednom účtu → sellerType 'company').
//    Telefony a e-maily napsané v popisu skryje pipeline.

const { htmlToText, parsePsc, fold } = require('../util/text');

const BASE = 'https://www.sbazar.cz';
const API = `${BASE}/api/v1`;
const PAGE_SIZE = 500;
/** API vrací 422 too_high_offset, když offset + limit > 10 000. */
const OFFSET_CAP = 10000;
/** Pásmo s víc inzeráty se dělí podle ceny (rezerva pod OFFSET_CAP). */
const SPLIT_THRESHOLD = 9500;
const MAX_SPLIT_DEPTH = 14;
/** Tolik inzerátů kol na jednom účtu během průchodu → prodejce bereme jako obchod. */
const SHOP_MIN_LISTINGS = 8;
/** Nových lokalit přeložených na souřadnice za jeden běh (lze změnit config.sbazarMaxResolve). */
const MAX_RESOLVE_PER_RUN = 400;
/** Lokalitu bez souřadnic zkusit znovu po tolika dnech. */
const RESOLVE_RETRY_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;
const IMG_FL = 'fl=exf|res,1024,768,1|wrm,/watermark/sbazar.png,10,10|webp,75';
/** Typy lokalit s bodem obce / části obce. Okres či kraj by v mapě vypadal jako přesná poloha → ty řeší src/geo. */
const RESOLVABLE = new Set(['municipality', 'ward', 'quarter']);

/** Procházené kategorie a jejich výchozí cenová pásma ({from, to} v Kč včetně; null = bez omezení). */
const CATEGORIES = [
  { id: 628, label: 'Kola', bands: [{ from: null, to: 4999 }, { from: 5000, to: null }] },
  { id: 437, label: 'Dětský bazar › Kola a koloběžky', bands: [{ from: null, to: null }] },
  { id: 291, label: 'Dětský bazar › Odrážedla', bands: [{ from: null, to: null }] },
];
const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

// ---------------------------------------------------------------------------------------------------------------
// Pomocníci

const clean = (s) => (typeof s === 'string' || typeof s === 'number' ? String(s).replace(/\s+/g, ' ').trim() : '');
/** Číslo z API (i jako řetězec „6300“ – kdyby se změnil formát); jinak NaN. */
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(v) ? Number(v) : Number.NaN);
/** Adresa obrázku z položky pole images ({url} nebo přímo řetězec). */
const imageUrl = (x) => (typeof x === 'string' ? x : typeof x?.url === 'string' ? x.url : undefined);

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new Error('Přerušeno');
}

/** 17000 → „17 000 Kč“ (nezlomitelné mezery). */
function fmtKc(n) {
  return `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} Kč`;
}

/** Pásmo cen pro hlášky: „do 4 999 Kč“, „od 5 000 Kč“, „2 500–4 999 Kč“, „všechny ceny“. */
function fmtBand({ from, to }) {
  const lo = from > 0 ? from : null;
  if (lo == null && to == null) return 'všechny ceny';
  if (lo == null) return `do ${fmtKc(to)}`;
  if (to == null) return `od ${fmtKc(lo)}`;
  return `${fmtKc(lo).replace(/ Kč$/, '')}–${fmtKc(to)}`;
}

/**
 * Rozdělí cenové pásmo na dvě poloviny. Pásmo bez horní meze se dělí na [from, 2·from − 1] a [2·from, ∞).
 * Jedna cena (nelze dělit) → null.
 * @param {{from: number|null, to: number|null}} band
 * @returns {Array<{from: number|null, to: number|null}>|null}
 */
function splitBand({ from, to }) {
  const lo = from > 0 ? from : 0;
  if (to == null) {
    const mid = lo > 0 ? lo * 2 : 5000;
    return [
      { from, to: mid - 1 },
      { from: mid, to: null },
    ];
  }
  if (to - lo < 1) return null;
  const mid = Math.floor((lo + to + 1) / 2);
  return [
    { from, to: mid - 1 },
    { from: mid, to },
  ];
}

/** Adresa výpisu jedné stránky. */
function searchUrl(categoryId, { from = null, to = null } = {}, offset, timestampTo, limit = PAGE_SIZE) {
  const q = [`category_id=${categoryId}`, `offset=${offset}`, `limit=${limit}`, 'sort=-create_date', `timestamp_to=${timestampTo}`];
  if (from > 0) q.push(`price_from=${from}`);
  if (to != null) q.push(`price_to=${to}`);
  return `${API}/items/search?${q.join('&')}`;
}
const detailUrl = (id) => `${API}/items/${id}`;
const resolveUrl = (type, id) => `${API}/localities/resolve?entity_id=${encodeURIComponent(id)}&entity_type=${encodeURIComponent(type)}`;

// Letní čas v ČR (pravidlo EU): od poslední neděle v březnu 01:00 UTC do poslední neděle v říjnu 01:00 UTC.
function lastSundayAt1Utc(year, month) {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay(), 1);
}
function isPragueSummer(utcMs) {
  const y = new Date(utcMs).getUTCFullYear();
  return utcMs >= lastSundayAt1Utc(y, 2) && utcMs < lastSundayAt1Utc(y, 9);
}

/**
 * Čas Sbazaru (pražský místní čas bez zóny, „2026-10-02T14:59:32“) → ISO v UTC. Dvojznačná hodina při přechodu
 * na zimní čas → první výskyt (letní čas); neexistující hodina při přechodu na letní čas → posun o hodinu dál.
 * Řetězec se zónou (Z / +02:00) se jen převede. Neplatný vstup → undefined.
 * @param {string} s
 * @returns {string|undefined}
 */
function pragueToIso(s) {
  if (typeof s !== 'string') return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s.trim());
  if (!m) return undefined;
  if (m[8]) {
    const ms = Date.parse(s.trim());
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  }
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6] || '0'].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return undefined;
  const naive = Date.UTC(y, mo - 1, d, h, mi, se);
  if (new Date(naive).getUTCDate() !== d) return undefined; // 31. 2. apod.
  const summer = naive - 2 * 3600 * 1000;
  return new Date(isPragueSummer(summer) ? summer : naive - 3600 * 1000).toISOString();
}

/** „2026-11-30T16:20:01“ (místní čas) → „30. 11. 2026“; jinak undefined. */
function czDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(typeof s === 'string' ? s : '');
  if (!m) return undefined;
  const [y, mo, d] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  return `${d}. ${mo}. ${y}`;
}

/**
 * Hlavní fotka v ověřené velikosti 1024×768 (webp s vodoznakem). Jen obrázkový server sdn.cz; jinak undefined.
 * @param {string} u např. „//d46-a.sdn.cz/d_46/c_img_qG_A/…/63c1.jpeg“
 */
function photoUrlOf(u) {
  if (typeof u !== 'string') return undefined;
  const base = u.trim().split(/[?#]/)[0];
  const abs = base.startsWith('//') ? `https:${base}` : base.replace(/^http:\/\//i, 'https://');
  if (!/^https:\/\/(?:[a-z0-9-]+\.)*sdn\.cz\/[^\s"'<>\\]+$/i.test(abs)) return undefined;
  return `${abs}?${IMG_FL}`;
}

/**
 * Cena: „dohodou“ → null + „Dohodou“; 0 Kč → null + „Zdarma / v textu“; v detailu jiná původní cena → „původně X Kč“.
 * @param {object} r položka výpisu nebo detailu
 * @param {boolean} [withOriginal] porovnat s price_original (jen detail)
 * @returns {{priceCzk: number|null, priceNote: string|null}}
 */
function priceInfo(r, withOriginal = false) {
  if (r?.price_by_agreement === true) return { priceCzk: null, priceNote: 'Dohodou' };
  const p = num(r?.price);
  if (p === 0) return { priceCzk: null, priceNote: 'Zdarma / v textu' };
  if (!Number.isFinite(p) || p < 0) return { priceCzk: null, priceNote: null };
  const priceCzk = Math.round(p);
  let priceNote = null;
  const po = num(r?.price_original);
  if (withOriginal && Number.isFinite(po) && po > 0) {
    const orig = Math.round(po);
    if (orig !== priceCzk) priceNote = `původně ${fmtKc(orig)}`;
  }
  return { priceCzk, priceNote };
}

/**
 * Lokalita Sbazaru → text a údaje pro geolokaci. Část obce se připojí („Praha - Smíchov“, „Brno - Královo Pole“);
 * když už název obce obsahuje („Praha 5“, „Brno-Židenice“, „České Budějovice 2“), použije se samotná.
 * @param {object} loc
 * @returns {{locationText?: string, okres?: string, kraj?: string, psc?: string}}
 */
function locationOf(loc) {
  if (!loc || typeof loc !== 'object') return {};
  const mun = clean(loc.municipality);
  const part = clean(loc.citypart) || clean(loc.ward) || clean(loc.quarter);
  let text = mun;
  if (part) {
    const fm = fold(mun);
    const fp = fold(part);
    if (!mun || fp.startsWith(fm)) text = part;
    else if (!fm.startsWith(fp)) text = `${mun} - ${part}`;
  }
  const out = {};
  if (text) out.locationText = text.slice(0, 120);
  if (clean(loc.district)) out.okres = clean(loc.district);
  if (clean(loc.region)) out.kraj = clean(loc.region);
  const psc = parsePsc(clean(loc.zip));
  if (psc) out.psc = psc;
  return out;
}

/** Klíč lokality pro překlad na souřadnice („ward:14682“), jen obec / část obce; jinak null. */
function localityKey(loc) {
  const type = clean(loc?.entity_type).toLowerCase();
  const id = Number(loc?.entity_id);
  return RESOLVABLE.has(type) && Number.isInteger(id) && id > 0 ? `${type}:${id}` : null;
}

/** Údaje, které web o inzerátu skutečně uvádí (žádné odhady z textu – ty dělá src/classify). */
function siteFacts(r, { forDetail = false } = {}) {
  const params = {};
  // null = klíč smazat (pipeline slévá parametry z výpisu) – po zrušení rezervace zmizí „Rezervováno“
  params['Rezervováno'] = r?.is_reserved === true ? 'ano' : null;
  params['Ochrana kupujícího'] = r?.buyer_protection === true ? 'ano' : null;
  // detail nahrazuje parametry celé → prázdné klíče vynechat
  if (forDetail) for (const k of Object.keys(params)) if (params[k] === null) delete params[k];
  return params;
}

function categoryLabel(cat, fallback) {
  const id = Number(cat?.id ?? fallback?.id);
  return CATEGORY_BY_ID.get(id)?.label || clean(cat?.name) || fallback?.label || undefined;
}

function validId(id) {
  const n = typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : id;
  return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
}

function offerUrl(seoName, id) {
  const seo = clean(seoName);
  const ok = /^[a-z0-9-]+$/i.test(seo) && (seo === id || seo.startsWith(`${id}-`));
  return `${BASE}/inzerat/${ok ? seo : id}`;
}

/**
 * Položka výpisu (results[i] z /items/search) → normalizovaná položka (bez souřadnic a typu prodávajícího – ty
 * doplní scan). Neúplná položka → null.
 * @param {object} r
 * @param {{id: number, label: string}} [cat] procházená kategorie (záloha, když položka kategorii nemá)
 */
function normalizeListItem(r, cat) {
  const id = validId(r?.id);
  const title = clean(r?.name).slice(0, 300);
  if (!id || !title) return null;
  const { priceCzk, priceNote } = priceInfo(r);
  const item = {
    sourceId: id,
    url: offerUrl(r.seo_name, id),
    title,
    priceCzk,
    priceNote,
    postedAt: pragueToIso(r.create_date),
    categorySrc: categoryLabel(r.category, cat),
    ...locationOf(r.locality),
    photoUrl: photoUrlOf(Array.isArray(r.images) ? imageUrl(r.images[0]) : undefined),
    params: siteFacts(r),
    sellerType: r.premise && typeof r.premise === 'object' ? 'company' : 'private',
    detailComplete: false,
  };
  for (const k of Object.keys(item)) if (item[k] === undefined) delete item[k];
  return item;
}

/** Popis z detailu: prostý text (HTML jen pro jistotu), bez nadbytečných prázdných řádků. */
function cleanDescription(s) {
  if (typeof s !== 'string') return undefined;
  const t = /<\/?[a-z][^>]*>/i.test(s) ? htmlToText(s) : s;
  const out = t
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out || undefined;
}

/**
 * Detail (result z /items/<id>) → doplňující údaje pro pipeline. Neplatný vstup → null.
 * @param {object} r
 */
function normalizeDetail(r) {
  const id = validId(r?.id);
  if (!id) return null;
  const images = Array.isArray(r.images) ? r.images.map(imageUrl).filter(Boolean) : [];
  const { priceCzk, priceNote } = priceInfo(r, true);
  const params = siteFacts(r, { forDetail: true });
  const validTo = czDate(r.valid_to);
  if (validTo) params['Platnost do'] = validTo;
  const main = (Array.isArray(r.localities) ? r.localities.find((l) => l?.main) : null)?.locality || r.locality;
  const item = {
    sourceId: id,
    url: offerUrl(r.seo_name, id),
    title: clean(r.name).slice(0, 300) || undefined,
    description: cleanDescription(r.description),
    priceCzk,
    priceNote,
    postedAt: pragueToIso(r.create_date),
    categorySrc: categoryLabel(r.category),
    ...locationOf(main),
    photoUrl: photoUrlOf(images[0]),
    photoCount: images.length,
    params,
    // Bez firemního profilu typ neměníme – „obchod“ podle počtu inzerátů určuje scan.
    sellerType: r.premise && typeof r.premise === 'object' ? 'company' : undefined,
    detailComplete: true,
  };
  for (const k of Object.keys(item)) if (item[k] === undefined) delete item[k];
  return item;
}

// ---------------------------------------------------------------------------------------------------------------
// Požadavky

/** Stav běhu navázaný na ctx (zablokování webem platí i pro detaily a ověřování zmizelých). */
const runState = new WeakMap();
function stateOf(ctx) {
  let s = runState.get(ctx);
  if (!s) runState.set(ctx, (s = { blocked: null }));
  return s;
}

function blockedError(message, cause) {
  const e = new Error(message, cause ? { cause } : undefined);
  e.fatal = true;
  return e;
}

/**
 * GET na API Sbazaru → {status, body}. Odpověď v HTML (captcha, chybová stránka, změna API) nebo 401/403 →
 * výjimka s fatal = true a další požadavky v tomto běhu se už neposílají.
 */
async function fetchApi(ctx, url, { okStatuses = [], what = 'data' } = {}) {
  const st = stateOf(ctx);
  if (st.blocked) throw st.blocked;
  let res;
  try {
    res = await ctx.http.request(url, { accept: 'application/json', okStatuses, signal: ctx.signal });
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    if (e?.status === 401 || e?.status === 403) {
      st.blocked = blockedError(`Sbazar odmítl přístup (HTTP ${e.status}) při stahování ${what} – web nás nejspíš blokuje nebo chce ověření „nejste robot“; zkuste to později`, e);
      throw st.blocked;
    }
    throw e;
  }
  const text = typeof res.text === 'function' ? res.text() : '';
  const ct = String(res.headers?.get?.('content-type') || '');
  const head = text.trimStart().slice(0, 1);
  if (head === '<' || (/html/i.test(ct) && head !== '{' && head !== '[')) {
    const captcha = /captcha|nejste robot|challenge-platform|cf-chl/i.test(text.slice(0, 20000));
    st.blocked = blockedError(
      `Sbazar vrátil místo dat HTML stránku${captcha ? ' s ověřením „nejste robot“ (captcha)' : ''} při stahování ${what} (HTTP ${res.status}) – web nás blokuje nebo se změnilo jeho API`
    );
    throw st.blocked;
  }
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Sbazar: odpověď při stahování ${what} není platný JSON (HTTP ${res.status})`);
  }
  return { status: res.status, body };
}

/**
 * Jedna stránka výpisu. Vrací {results, total} nebo {tooHigh: true} (API odmítlo offset nad 10 000).
 */
async function fetchPage(ctx, cat, band, offset, timestampTo, limit = PAGE_SIZE) {
  const what = `výpisu ${cat.label} (${fmtBand(band)}, od ${offset})`;
  const { status, body } = await fetchApi(ctx, searchUrl(cat.id, band, offset, timestampTo, limit), { okStatuses: [422], what });
  if (status === 422) {
    const codes = Array.isArray(body?.errors) ? body.errors.map((e) => e?.error_code) : [];
    if (codes.includes('too_high_offset')) return { tooHigh: true };
    throw new Error(`Sbazar: API odmítlo dotaz ${what} (HTTP 422 ${codes.join(', ')})`);
  }
  const results = body?.results;
  const total = Number(body?.pagination?.total);
  if (!Array.isArray(results) || !Number.isFinite(total) || total < 0) throw new Error(`Sbazar: neočekávaná odpověď ${what} – chybí results/pagination`);
  return { results, total };
}

/**
 * Detail inzerátu; 404/410 = neexistuje → null. Detail se stavem jiným než „active“ (smazaný, neaktivní, prodaný …)
 * se také bere jako zmizelý – koupit se teď nedá; když se inzerát vrátí do výpisu, pipeline ho zase zobrazí.
 */
async function fetchDetail(ctx, id) {
  const { status, body } = await fetchApi(ctx, detailUrl(id), { okStatuses: [404, 410], what: `detailu inzerátu ${id}` });
  if (status === 404 || status === 410) return null;
  const r = body?.result;
  if (!r || typeof r !== 'object' || validId(r.id) !== id) throw new Error(`Sbazar: neočekávaná odpověď detailu inzerátu ${id}`);
  const st = String(r.status ?? '').trim().toLowerCase();
  if (st && st !== 'active') return null;
  return r;
}

/**
 * Souřadnice lokality („ward:14682“) → {lat, lon} | null (API lokalitu nezná – 404 – nebo nemá bod v ČR).
 * Jiná chyba (400/422 = změna API, 5xx, síť) → výjimka; taková lokalita se do cache jako „bez bodu“ neuloží.
 */
async function resolveLocality(ctx, key) {
  const [type, id] = key.split(':');
  const { status, body } = await fetchApi(ctx, resolveUrl(type, id), { okStatuses: [404], what: `lokality ${key}` });
  if (status === 404) return null;
  const lat = num(body?.result?.gps_lat);
  const lon = num(body?.result?.gps_lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 48.4 || lat > 51.2 || lon < 11.9 || lon > 19) return null;
  return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
}

function listingId(listing) {
  const id = validId(String(listing?.source_id ?? listing?.sourceId ?? '').trim());
  if (!id) throw new Error(`Sbazar: neplatné id inzerátu „${listing?.source_id ?? listing?.sourceId ?? ''}“`);
  return id;
}

// ---------------------------------------------------------------------------------------------------------------
// Výpis

function cacheGet(cache, key, log) {
  try {
    return cache.get(key);
  } catch (e) {
    log?.debug?.('Sbazar: čtení cache selhalo', { key, error: e.message });
    return undefined;
  }
}
function cacheSet(cache, key, value, log) {
  try {
    cache.set(key, value);
  } catch (e) {
    log?.debug?.('Sbazar: zápis do cache selhal', { key, error: e.message });
  }
}

/**
 * Zpracuje položky jedné stránky do st.items (bez duplicit). Vrací údaje pro inkrementální konec:
 * {considered, allKnown, newestKnownMs, newestMs}.
 */
function collect(st, cat, results) {
  const page = { considered: 0, allKnown: true, newestKnownMs: -Infinity, newestMs: -Infinity, foreign: 0 };
  const note = (entry) => {
    page.considered++;
    if (!entry.known) page.allKnown = false;
    const t = Number.isFinite(entry.ts) ? entry.ts : Infinity; // neznámé datum nikdy neukončí průchod
    if (t > page.newestMs) page.newestMs = t;
    if (entry.known && Number.isFinite(entry.ts) && entry.ts > page.newestKnownMs) page.newestKnownMs = entry.ts;
  };
  for (const r of results) {
    st.raw++;
    const id = validId(r?.id);
    if (!id) {
      st.invalid++;
      continue;
    }
    // Inzerát jiné kategorie (přesunutý během průchodu, nebo API přestalo filtrovat podle category_id) → přeskočit.
    const catId = Number(r.category?.id);
    if (Number.isInteger(catId) && catId > 0 && catId !== cat.id) {
      st.foreign++;
      page.foreign++;
      continue;
    }
    const prev = st.items.get(id);
    if (prev) {
      st.duplicates++;
      note(prev);
      continue;
    }
    if (st.skipped.has(id)) {
      st.duplicates++;
      continue;
    }
    const item = normalizeListItem(r, cat);
    if (!item) {
      st.invalid++;
      st.skipped.add(id);
      continue;
    }
    if (st.minPrice && item.priceCzk != null && item.priceCzk < st.minPrice) {
      st.cheap++;
      st.skipped.add(id);
      continue;
    }
    let known = false;
    try {
      known = !!st.ctx.isKnown?.(id);
    } catch {
      known = false;
    }
    // Id účtu jen v paměti tohoto běhu (počet inzerátů → obchod); do položky se nedostane.
    const uid = r.user && (typeof r.user.id === 'number' || typeof r.user.id === 'string') ? String(r.user.id) : null;
    if (uid) st.users.set(uid, (st.users.get(uid) || 0) + 1);
    const entry = { item, known, uid, ts: Date.parse(item.postedAt), locKey: localityKey(r.locality) };
    st.items.set(id, entry);
    note(entry);
  }
  return page;
}

/**
 * Kontrola stránky výpisu: většina inzerátů z jiné kategorie = API přestalo filtrovat podle category_id → chyba
 * (pásmo selže, výpis je neúplný a do DB se nedostanou auta ani nábytek).
 */
function checkForeign(info, n, where) {
  if (info.foreign > Math.max(5, n * 0.2)) {
    throw new Error(`Sbazar: výpis ${where} vrací inzeráty jiných kategorií (${info.foreign} z ${n}) – změnilo se API?`);
  }
}

/**
 * Projde jedno cenové pásmo kategorie (od nejnovějších). Při úplném průchodu a příliš velkém pásmu ho rozdělí podle
 * ceny a projde poloviny. Limit stránek (ctx.maxPages) platí pro výchozí pásmo z CATEGORIES (segment) včetně jeho
 * polovin. Chyby požadavků propadnou volajícímu.
 * Úplnost pásma se posuzuje podle počtu RŮZNÝCH id, která přišla (API, které by ignorovalo offset nebo vracelo
 * kratší stránky, tak neprojde jako úplné). Offset se posouvá o skutečný počet vrácených položek.
 * @param {string} seg klíč segmentu pro počítání stránek
 */
async function sweepBand(st, cat, band, seg, depth = 0) {
  const { ctx } = st;
  const log = ctx.log;
  const where = `${cat.label} (${fmtBand(band)})`;
  const ids = new Set();
  let offset = 0;
  let total = null;
  let newestKnown = -Infinity;
  for (;;) {
    throwIfAborted(ctx.signal);
    if ((st.pages.get(seg) || 0) >= st.maxPages) {
      if (st.full) log?.warn?.(`Sbazar: ${where} – dosažen limit ${st.maxPages} stránek, výpis není úplný`);
      st.complete = false;
      return;
    }
    if (offset >= OFFSET_CAP) {
      log?.warn?.(`Sbazar: ${where} – API nedovolí jít za ${OFFSET_CAP} inzerátů, zbytek pásma vynechávám`);
      st.complete = false;
      return;
    }
    const page = await fetchPage(ctx, cat, band, offset, st.timestampTo, Math.min(PAGE_SIZE, OFFSET_CAP - offset));
    st.pages.set(seg, (st.pages.get(seg) || 0) + 1);
    st.requests++;
    if (page.tooHigh) {
      log?.warn?.(`Sbazar: ${where} – API odmítlo offset ${offset} (too_high_offset), výpis není úplný`);
      st.complete = false;
      return;
    }
    total = page.total;
    if (offset === 0 && depth === 0 && st.full && total === 0) {
      // Kategorie kol nikdy nejsou prázdné → spíš změna API / blokace; neúplné, ať pipeline nemaže živé inzeráty.
      log?.warn?.(`Sbazar: ${where} – API vrátilo 0 inzerátů, výpis beru jako neúplný (zmizelé inzeráty tentokrát neoznačuji)`);
      st.complete = false;
    }
    if (offset === 0 && st.full && total > SPLIT_THRESHOLD) {
      const parts = depth < MAX_SPLIT_DEPTH ? splitBand(band) : null;
      if (parts) {
        log?.warn?.(`Sbazar: ${where} má ${total} inzerátů – víc, než API dovolí projít (${OFFSET_CAP}); dělím na ${fmtBand(parts[0])} a ${fmtBand(parts[1])}`);
        checkForeign(collect(st, cat, page.results), page.results.length, where); // v polovinách se jen přeskočí jako duplicitní
        for (const p of parts) await sweepBand(st, cat, p, seg, depth + 1);
        return;
      }
      // Úplnost rozhodne limit offsetu níže (do 10 000 inzerátů projde pásmo celé).
      log?.warn?.(`Sbazar: ${where} má ${total} inzerátů a podle ceny už nejde dál dělit – projdu nejvýš prvních ${OFFSET_CAP}`);
    }
    const info = collect(st, cat, page.results);
    checkForeign(info, page.results.length, where);
    for (const r of page.results) {
      const id = validId(r?.id);
      if (id) ids.add(id);
    }
    offset += page.results.length;
    if (!page.results.length || offset >= total) break;
    if (!st.full) {
      // Inkrementálně: konec, když jsou na stránce jen známé inzeráty starší než nejnovější známý − 1 den
      // (později schválené inzeráty mají starší datum vložení než ty nejnovější).
      if (info.newestKnownMs > newestKnown) newestKnown = info.newestKnownMs;
      if (info.considered > 0 && info.allKnown && info.newestMs < newestKnown - DAY_MS) {
        st.stoppedEarly++;
        return;
      }
    }
  }
  if (st.full && total != null) {
    const tolerance = Math.max(3, Math.ceil(total * 0.01));
    if (ids.size + tolerance < total) {
      log?.warn?.(`Sbazar: ${where} – přišlo ${ids.size} různých z ${total} inzerátů, výpis beru jako neúplný`);
      st.complete = false;
    }
  }
}

/** Souřadnice lokalit (z cache, chybějící se doptají – nejčastější první, s limitem na běh). */
async function resolveCoords(st) {
  const { ctx } = st;
  const log = ctx.log;
  const cache = ctx.cache && typeof ctx.cache.get === 'function' && typeof ctx.cache.set === 'function' ? ctx.cache : st.memCache;
  const counts = new Map();
  for (const e of st.items.values()) if (e.locKey) counts.set(e.locKey, (counts.get(e.locKey) || 0) + 1);
  const coords = new Map();
  const todo = [];
  const now = Date.now();
  for (const [key, n] of counts) {
    const c = cacheGet(cache, `loc:${key}`, log);
    if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) coords.set(key, { lat: c.lat, lon: c.lon });
    else if (c && c.none && now - Date.parse(c.at) < RESOLVE_RETRY_DAYS * DAY_MS) continue;
    else todo.push([key, n]);
  }
  todo.sort((a, b) => b[1] - a[1]);
  const limit = Math.max(0, Number(ctx.config?.sbazarMaxResolve ?? MAX_RESOLVE_PER_RUN) || 0);
  let resolved = 0;
  let failedInRow = 0;
  // „Bez bodu“ se do cache zapíše, jen když v tomtéž běhu aspoň jedna lokalita prošla – kdyby API lokalit přestalo
  // fungovat (např. 404 na všechno), nezablokuje se tím překlad na RESOLVE_RETRY_DAYS dní.
  const nones = [];
  for (const [key] of todo.slice(0, limit)) {
    throwIfAborted(ctx.signal);
    try {
      st.requests++;
      const c = await resolveLocality(ctx, key);
      failedInRow = 0;
      if (c) {
        coords.set(key, c);
        resolved++;
        cacheSet(cache, `loc:${key}`, c, log);
      } else {
        nones.push(key);
        if (!resolved && nones.length >= 10) {
          log?.warn?.('Sbazar: API lokalit nevrací souřadnice ani pro jednu lokalitu – změnilo se? Zkusím v dalším běhu');
          break;
        }
      }
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      if (e?.fatal) {
        log?.warn?.('Sbazar: překlad lokalit na souřadnice přerušen', { error: e.message });
        break;
      }
      log?.debug?.('Sbazar: překlad lokality selhal', { key, error: e.message });
      if (++failedInRow >= 5) {
        log?.warn?.('Sbazar: překlad lokalit opakovaně selhává – zbytek zkusím v dalším běhu', { error: e.message });
        break;
      }
    }
  }
  if (resolved) {
    const at = new Date().toISOString();
    for (const key of nones) cacheSet(cache, `loc:${key}`, { none: true, at }, log);
  }
  if (todo.length > limit) log?.info?.(`Sbazar: souřadnice pro ${limit} z ${todo.length} nových lokalit, zbytek v dalších bězích`);
  return { coords, resolved, pending: Math.max(0, todo.length - resolved) };
}

/**
 * Projde výpisy kol (Kola, dětská kola, odrážedla) a předá inzeráty přes ctx.emit.
 * complete = režim 'full' a všechna pásma prošla celá bez chyby.
 * @param {object} ctx viz docs/ARCHITEKTURA.md
 * @returns {Promise<{complete: boolean, unique: number, emitted: number, cheap: number, duplicates: number,
 *   invalid: number, requests: number, coords: number}>}
 */
async function scan(ctx) {
  const log = ctx.log;
  const st = {
    ctx,
    full: ctx.mode == null || ctx.mode === 'full',
    timestampTo: Math.floor(Date.now() / 1000),
    minPrice: Number(ctx.minPrice) > 0 ? Number(ctx.minPrice) : 0,
    maxPages: ctx.maxPages > 0 ? ctx.maxPages : 400,
    items: new Map(), // id → {item, known, uid, ts, locKey}
    skipped: new Set(),
    users: new Map(), // id účtu → počet inzerátů (jen v paměti během běhu)
    pages: new Map(), // segment → stažené stránky
    memCache: new Map(),
    complete: true,
    raw: 0,
    invalid: 0,
    foreign: 0,
    cheap: 0,
    duplicates: 0,
    requests: 0,
    stoppedEarly: 0,
  };
  const errors = [];
  let fatal = null;
  let bandsOk = 0;
  outer: for (const cat of CATEGORIES) {
    for (const band of cat.bands) {
      try {
        await sweepBand(st, cat, band, `${cat.id}:${cat.bands.indexOf(band)}`);
        bandsOk++;
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        st.complete = false;
        if (e?.fatal) {
          fatal = e;
          break outer;
        }
        errors.push(e);
        log?.warn?.(`Sbazar: výpis ${cat.label} (${fmtBand(band)}) selhal – pokračuji dalším`, { error: e.message });
      }
    }
  }

  const sane = st.invalid + st.foreign <= Math.max(3, st.raw * 0.05);
  if (!sane) {
    st.complete = false;
    log?.warn?.('Sbazar: podezřele mnoho neúplných inzerátů nebo inzerátů jiných kategorií – změnilo se API? Zmizelé inzeráty tentokrát neoznačuji', {
      invalid: st.invalid,
      foreign: st.foreign,
      raw: st.raw,
    });
  }

  // Souřadnice (při zablokování webem už žádné další požadavky)
  let coords = new Map();
  let resolved = 0;
  if (!fatal && st.items.size) ({ coords, resolved } = await resolveCoords(st));

  // Typ prodávajícího: firemní profil, nebo ≥ SHOP_MIN_LISTINGS inzerátů jednoho účtu → obchod.
  let emitted = 0;
  for (const e of st.items.values()) {
    throwIfAborted(ctx.signal);
    const item = { ...e.item };
    const c = e.locKey ? coords.get(e.locKey) : null;
    if (c) {
      item.lat = c.lat;
      item.lon = c.lon;
      item.latLonPrecision = 'city'; // střed obce / části obce
    }
    if (item.sellerType !== 'company') {
      if (e.uid && st.users.get(e.uid) >= SHOP_MIN_LISTINGS) item.sellerType = 'company';
      // Mimo úplný průchod počet inzerátů účtu neznáme → u známých inzerátů typ neměnit.
      else if (!st.full && e.known) delete item.sellerType;
    }
    await ctx.emit(item);
    emitted++;
  }
  st.users.clear();

  if (fatal) throw fatal;
  if (errors.length && !bandsOk) throw errors[0];
  const complete = st.full && st.complete && !errors.length;
  log?.info?.(`Sbazar: ${emitted} inzerátů (pod minimální cenou ${st.cheap}, duplicitních ${st.duplicates})`, {
    requests: st.requests,
    coords: resolved,
    complete,
  });
  return {
    complete,
    unique: st.items.size,
    emitted,
    cheap: st.cheap,
    duplicates: st.duplicates,
    invalid: st.invalid,
    requests: st.requests,
    coords: resolved,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Detail a ověření zmizelých

/**
 * Detail inzerátu: plný popis, počet fotek, hlavní fotka, původní cena, platnost. Inzerát neexistuje → null.
 * @param {object} ctx
 * @param {{source_id: string}} listing řádek z DB
 */
async function detail(ctx, listing) {
  const id = listingId(listing);
  const r = await fetchDetail(ctx, id);
  if (r === null) return null;
  const item = normalizeDetail(r);
  if (!item) throw new Error(`Sbazar: neočekávaná odpověď detailu inzerátu ${id}`);
  return item;
}

/**
 * Ověří, zda inzerát chybějící v úplném výpisu opravdu zmizel.
 * @returns {Promise<boolean|null>} true = smazán (404) / neaktivní / přesunut mimo kola / pod minimální cenou,
 *   false = stále aktivní, null = nevím
 */
async function confirmGone(ctx, listing) {
  let id;
  try {
    id = listingId(listing);
  } catch {
    return null;
  }
  try {
    const r = await fetchDetail(ctx, id);
    if (r === null) return true;
    const catId = Number(r.category?.id);
    if (Number.isInteger(catId) && catId > 0 && !CATEGORY_BY_ID.has(catId)) return true;
    const minPrice = Number(ctx.minPrice) > 0 ? Number(ctx.minPrice) : 0;
    const { priceCzk } = priceInfo(r);
    if (minPrice && priceCzk != null && priceCzk < minPrice) return true;
    return false;
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    return null;
  }
}

module.exports = {
  key: 'sbazar',
  defaultMaxDetails: 2000,
  label: 'Sbazar',
  homepage: BASE,
  requiresBrowser: false,
  scan,
  detail,
  confirmGone,
  // pro testy a ladění
  normalizeListItem,
  normalizeDetail,
  priceInfo,
  pragueToIso,
  photoUrlOf,
  locationOf,
  localityKey,
  splitBand,
  fmtBand,
  searchUrl,
  detailUrl,
  resolveUrl,
  CATEGORIES,
  PAGE_SIZE,
  OFFSET_CAP,
  SPLIT_THRESHOLD,
  SHOP_MIN_LISTINGS,
  MAX_RESOLVE_PER_RUN,
  IMG_FL,
};
