'use strict';
// Zdroj Aukro (aukro.cz) – kategorie „Cyklobazar“ / Kola (seo „jizdni-kola“, id 17590) vč. všech podkategorií
// (horská, silniční, gravel, krosová, trekingová, elektrokola, dětská, BMX, historická, ostatní).
//
// VÝCHOZÍ STAV: VYPNUTO. Zdroj se zapíná jen ručně (KOLOMAPA_SOURCES=bazos,sbazar,cyklobazar,aukro).
// Důvod: aukro.cz/robots.txt obsahuje „User-agent: ClaudeBot / Disallow: /“ – crawler společnosti Anthropic má
// zakázaný celý web. Skupina „User-Agent: *“ výpisy, nabídky ani /backend-web/ nezakazuje, ale zda Aukro denně
// stahovat (a zda to dovolují obchodní podmínky Aukra), musí rozhodnout provozovatel obchodu. Modul byl proto napsán
// a otestován čistě offline nad uloženými ukázkami (test/fixtures/aukro) – při vývoji nešel na aukro.cz ani
// cdn.aukro.cz žádný požadavek. Zátěž po zapnutí: ~10 požadavků na výpis denně + detaily nových nabídek + ověření
// nabídek zmizelých před plánovaným koncem (prodej přes Kup teď, stažení).
//
// Jak to funguje:
//  - Výpis: JSON API, které používá samotný web – POST /backend-web/api/offers/searchItemsCommon (180 nabídek na
//    stránku, od nejnovějších). Topované nabídky jsou připnuté nahoře bez ohledu na řazení, proto se vždy projde
//    CELÝ výpis (i v inkrementálním režimu; je to jen ~10 stránek).
//  - Detail: GET /backend-web/api/offers/{id}/offerDetail → plný popis, fotka, počet fotek a zobrazení.
//    Když API odpoví 4xx (kromě 404/410 = nabídka neexistuje a 429), zkusí se HTML stránka a JSON, který do ní
//    Angular vkládá v <script id="ng-state"> (SSR); po 3 odmítnutích po sobě už do konce běhu rovnou HTML.
//    Totéž pro výpis (jen při chybě hned první stránky).
//  - Pojistky proti změně API: výpis jiné kategorie → chyba; detail hlásící konec u mnoha nabídek z dnešního výpisu
//    → chyba (ne hromadné „zmizení“); odpověď detailu pro jinou nabídku → chyba.
//  - Zahraniční prodejci (PSČ mimo ^[1-7]\d{4}$ nebo registrace mimo CZ) se přeskakují – mapa je jen ČR.
//  - Aukce: běžící příhoz NENÍ cena kola (aukce často začínají na 1 Kč) → priceCzk = null a cena jen v priceNote,
//    pokud nabídka nemá zároveň „Kup teď“ (pak priceCzk = cena Kup teď).
//  - Jméno, login ani id prodávajícího se neukládá; z popisu se odstraní telefonní čísla a e-maily.

const { htmlToText, fold, scrubContacts, decodeEntities } = require('../util/text');

const BASE = 'https://aukro.cz';
const CATEGORY_SEO = 'jizdni-kola';
const CATEGORY_ID = 17590;
// Podkategorie kol (pro případ, že by API vrátilo jen list stromu bez předků).
const BIKE_CATEGORY_IDS = new Set([CATEGORY_ID, 17594, 256788, 63317, 17596, 17595, 147974, 17592, 17591, 17598, 17597]);
const BIKE_CATEGORY_SEO = new Set([
  CATEGORY_SEO, 'horska-mtb-kola', 'gravel-bike-kola', 'krosova-kola', 'trekkingova-kola', 'silnicni-kola', 'elektrokola',
  'detska-kola', 'kola-bmx-a-freestyle', 'historicka-kola', 'ostatni-kola',
]);
const PAGE_SIZE = 180;
const SORT = 'startingTime:DESC';
const SEARCH_BODY = { categorySeoUrl: CATEGORY_SEO, splitGroups: {}, fallbackItemsCount: 0, subbrandExclusive: false };
const API_ACCEPT = 'application/json, text/plain, */*';
const API_HEADERS = { Accept: API_ACCEPT, 'X-Accept-Subbrand': 'BAZAAR' };
const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
/** Rezerva po plánovaném konci nabídky (aukce se při příhozu na poslední chvíli může prodloužit). */
const END_GRACE_MS = 30 * 60 * 1000;
/** Po kolika odmítnutích API detailu (4xx) po sobě jít do konce běhu rovnou na HTML stránky (~1 MB místo ~20 kB). */
const SSR_SWITCH_AFTER = 3;

// Atributy Aukra (název bez diakritiky → štítek v params). Web má v názvu překlep „Materíál rámu“.
const ATTR_LABELS = {
  'stav zbozi': 'Stav zboží',
  znacka: 'Značka',
  'prumer kol': 'Průměr kol',
  'material ramu': 'Materiál rámu',
  odpruzeni: 'Odpružení',
  urceni: 'Určení',
  typ: 'Typ',
  'hmotnost kola': 'Hmotnost kola',
  'barva kola': 'Barva kola',
  'delka dojezdu': 'Délka dojezdu',
  'kapacita baterie': 'Kapacita baterie',
  'doba zaruky (mesicu)': 'Doba záruky (měsíců)',
};
// Atributy bez hodnoty pro nacenění (dodací lhůta, kód zboží obchodu, EAN).
const ATTR_SKIP = [/^doba dodani/, /^kod zbozi/, /^ean$/];

// ---------------------------------------------------------------------------------------------------------------
// Pomocníci

const searchUrl = (page) => `${BASE}/backend-web/api/offers/searchItemsCommon?page=${page}&size=${PAGE_SIZE}&sort=${SORT}`;
const detailUrl = (id) => `${BASE}/backend-web/api/offers/${id}/offerDetail?pageType=DETAIL&requestedFor=DETAIL`;
/** HTML stránka výpisu pro SSR záložku (v UI je stránkování od 1). */
const listingPageUrl = (page) => `${BASE}/${CATEGORY_SEO}?sort=${SORT}${page > 0 ? `&page=${page + 1}` : ''}`;
function offerUrl(seoUrl, id) {
  const slug = String(seoUrl ?? '').replace(/[^a-z0-9-]/gi, '').replace(/^-+|-+$/g, '');
  return `${BASE}/${slug ? `${slug}-` : ''}${id}`;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new Error('Přerušeno');
}

/** Částka z {amount, currency} → kladné celé číslo v Kč, jinak null. */
function money(p) {
  const n = p && typeof p === 'object' ? Number(p.amount) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (p.currency && String(p.currency).toUpperCase() !== 'CZK') return null;
  return Math.round(n);
}

/** 17000 → „17 000 Kč“ (s nezlomitelnými mezerami). */
function fmtKc(n) {
  return `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} Kč`;
}

function biddersText(n) {
  const k = Number(n);
  if (!Number.isFinite(k) || k < 0) return null;
  return `${k} ${k >= 1 && k <= 4 ? 'přihazující' : 'přihazujících'}`;
}

const PRAGUE_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Prague',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hourCycle: 'h23',
});
function pragueParts(ms) {
  const p = {};
  for (const x of PRAGUE_PARTS.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  p.hour %= 24;
  return p;
}

/**
 * ISO čas (s libovolným posunem) → „7. 10. 2026 10:13“ v pražském čase; neplatný vstup → null.
 * @param {string} iso
 * @returns {string|null}
 */
function formatCzDateTime(iso) {
  const ms = Date.parse(iso);
  if (!iso || !Number.isFinite(ms)) return null;
  const p = pragueParts(ms);
  return `${p.day}. ${p.month}. ${p.year} ${p.hour}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * „7. 10. 2026 10:13“ (pražský čas, výstup formatCzDateTime) → milisekundy UTC; jinak null.
 * @param {string} s
 * @returns {number|null}
 */
function parseCzDateTime(s) {
  const m = String(s ?? '').match(/^\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [d, mo, y, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  // Posun Prahy vůči UTC (+1 h / +2 h); druhý krok opraví noci přechodu na letní/zimní čas.
  const offsetAt = (ms) => {
    const p = pragueParts(ms);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60000) * 60000;
  };
  let t = naive - offsetAt(naive);
  t = naive - offsetAt(t);
  return t;
}

function toIso(s) {
  const ms = Date.parse(s);
  return s && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** Text z API → jeden řádek bez nadbytečných mezer (případné HTML entity dekódované). */
const clean = (s) => decodeEntities(String(s ?? '')).replace(/\s+/g, ' ').trim();

/** PSČ z API bez mezer (i nezlomitelných) a bez předpony „CZ“/„CZ-“. */
const pscDigits = (pc) => String(pc ?? '').replace(/\s+/g, '').replace(/^CZ-?/i, '');

/** PSČ → 5 číslic bez mezery, jen české (^[1-7]\d{4}$); jinak undefined. */
function czPsc(pc) {
  const d = pscDigits(pc);
  return /^[1-7]\d{4}$/.test(d) ? d : undefined;
}

function cleanLocation(s) {
  const t = clean(s).replace(/,\s*Česká republika$/i, '').trim();
  return t ? t.slice(0, 120) : undefined;
}

/** Hlavní fotka ve velikosti 730×548 (výpis dává náhled /thumbnail/; stejný soubor je i v detailu jako LARGE). */
function largePhoto(u) {
  if (!u || typeof u !== 'string') return undefined;
  const abs = u.startsWith('//') ? `https:${u}` : u;
  if (!/^https?:\/\//i.test(abs)) return undefined;
  return abs.replace(/\/(thumbnail|400x300|73x73)\//, '/730x548/');
}

/** Cesta kategorií (výpis: categoryPath, detail: category) obsahuje kola? null = cesta chybí. */
function inBikeCategory(path) {
  if (!Array.isArray(path) || !path.length) return null;
  return path.some((c) => BIKE_CATEGORY_IDS.has(Number(c?.id ?? c?.itemCategoryId)) || BIKE_CATEGORY_SEO.has(c?.seoUrl));
}

/** Celá cesta kategorií (s předky) a kola v ní nejsou → nabídka je mimo kola. Jen list stromu / chybí → nevím (false). */
function outsideBikes(path) {
  return Array.isArray(path) && path.length >= 2 && inBikeCategory(path) === false;
}

/** Kategorie na webu = poslední prvek cesty („Horská (MTB) kola“); kořen „Cyklobazar“ → „Kola“. */
function categoryName(path) {
  if (!Array.isArray(path) || !path.length) return undefined;
  const last = path[path.length - 1] || {};
  if (last.id === CATEGORY_ID || last.seoUrl === CATEGORY_SEO) return 'Kola';
  return clean(last.name || last.shortName) || undefined;
}

function sellerType(seller) {
  if (!seller || typeof seller.companyAccount !== 'boolean') return undefined;
  return seller.companyAccount ? 'company' : 'private';
}

/**
 * Cena a typ nabídky. Běžící aukce NENÍ pevná cena: bez „Kup teď“ je priceCzk null a aktuální stav je v priceNote.
 * @returns {{priceCzk: number|null, priceNote: string|null, offerType: string|null}}
 */
function offerInfo({ auction, buyNowActive, buyNowPrice, price, bidders, endingTime }) {
  const bn = buyNowActive ? money(buyNowPrice) : null;
  if (!auction) {
    if (bn) return { priceCzk: bn, priceNote: 'Kup teď', offerType: 'Kup teď' };
    return { priceCzk: null, priceNote: null, offerType: null };
  }
  const bid = money(price);
  const who = biddersText(bidders);
  const end = formatCzDateTime(endingTime);
  const auctionText = `aktuální cena ${bid ? fmtKc(bid) : 'neuvedena'}${who ? ` (${who})` : ''}${end ? `, končí ${end}` : ''}`;
  if (bn) return { priceCzk: bn, priceNote: `Kup teď; aukce – ${auctionText}`, offerType: 'Aukce + Kup teď' };
  return { priceCzk: null, priceNote: `Aukce – ${auctionText}`, offerType: 'Aukce' };
}

const LABEL_ORDER = Object.values(ATTR_LABELS);

/**
 * Atributy Aukra → params (české štítky, duplicity spojené čárkou) + Původní cena, Typ nabídky, Konec.
 * Výpis i detail dávají stejné atributy (jen v jiném pořadí) → klíče i hodnoty se řadí pevně, aby params z výpisu
 * a z detailu byly totožné a otisk obsahu se zbytečně neměnil.
 */
function buildParams(attributes, { retailPrice, offerType, endingTime } = {}) {
  const values = new Map(); // štítek → hodnoty
  for (const a of Array.isArray(attributes) ? attributes : []) {
    const name = clean(a?.attributeName);
    const value = clean(a?.attributeValue);
    if (!name || !value) continue;
    const k = fold(name);
    if (ATTR_SKIP.some((re) => re.test(k))) continue;
    const label = ATTR_LABELS[k] || name;
    if (label === 'Značka' && fold(value) === 'ostatni') continue; // „Ostatní“ = značka neuvedena
    if (!values.has(label)) values.set(label, []);
    if (!values.get(label).includes(value)) values.get(label).push(value);
  }
  const rank = (l) => (LABEL_ORDER.includes(l) ? LABEL_ORDER.indexOf(l) : LABEL_ORDER.length);
  const labels = [...values.keys()].sort((x, y) => rank(x) - rank(y) || x.localeCompare(y, 'cs'));
  const out = {};
  for (const l of labels) out[l] = values.get(l).sort((x, y) => x.localeCompare(y, 'cs')).join(', ');
  const retail = money(retailPrice);
  if (retail) out['Původní cena'] = fmtKc(retail);
  if (offerType) out['Typ nabídky'] = offerType;
  const end = formatCzDateTime(endingTime);
  if (end) out['Konec'] = end;
  return out;
}

/**
 * Zahraniční prodejce (SK/HU…): PSČ, které není české, nebo registrace mimo CZ. Chybějící údaje se za zahraničí
 * nepovažují (změna API nesmí vyřadit všechny nabídky).
 * @param {object} raw položka výpisu (content[i])
 */
function isForeignSeller(raw) {
  const domain = raw?.seller?.registrationDomain;
  if (domain && String(domain).toUpperCase() !== 'CZ') return true;
  const pc = pscDigits(raw?.postcode);
  return pc !== '' && !/^[1-7]\d{4}$/.test(pc);
}

/**
 * Položka výpisu (content[i] z searchItemsCommon) → normalizovaná položka. Neúplná položka → null.
 * @param {object} it
 */
function normalizeListItem(it) {
  if (!it || it.itemId == null || !clean(it.itemName)) return null;
  const id = String(it.itemId);
  const offer = offerInfo({
    auction: it.auction === true,
    buyNowActive: it.buyNowActive,
    buyNowPrice: it.buyNowPrice,
    price: it.price,
    bidders: it.buyersCountRelative,
    endingTime: it.endingTime,
  });
  return {
    sourceId: id,
    url: offerUrl(it.seoUrl, id),
    title: clean(it.itemName),
    priceCzk: offer.priceCzk,
    priceNote: offer.priceNote,
    postedAt: toIso(it.startingTime), // pozor: při opakovaném vystavení se resetuje (id zůstává)
    categorySrc: categoryName(it.categoryPath),
    locationText: cleanLocation(it.location),
    psc: czPsc(it.postcode),
    photoUrl: largePhoto(it.titleImageUrl || it.titleImage?.url),
    params: buildParams(it.attributes, { retailPrice: it.retailPrice, offerType: offer.offerType, endingTime: it.endingTime }),
    sellerType: sellerType(it.seller),
    detailComplete: false,
  };
}

/**
 * Detail nabídky (offerDetail JSON) → normalizovaná položka (detailComplete: true). Neplatný vstup → null.
 * Pozor: nabídka jen s „Kup teď“ nemá v detailu klíč `price`.
 * @param {object} d
 */
function normalizeDetail(d) {
  const rawId = d?.itemId ?? d?.id;
  if (!d || rawId == null) return null;
  const id = String(rawId);
  const auction = typeof d.auction === 'boolean' ? d.auction : /BID|AUCTION/i.test(String(d.itemType || ''));
  const offer = offerInfo({
    auction,
    buyNowActive: d.buyNowActive,
    buyNowPrice: d.buyNowPrice,
    price: d.price,
    bidders: d.biddersCount ?? d.biddersCountRelative,
    endingTime: d.endingTime,
  });
  const imgs = (Array.isArray(d.itemImages) ? d.itemImages : []).slice().sort((a, b) => (a?.position ?? 0) - (b?.position ?? 0));
  const first = imgs[0]?.sizes || {};
  const photoUrl =
    first.LARGE?.url || largePhoto(first.MEDIUM_PREVIEW?.url || first.MEDIUM?.url) || first.ORIGINAL?.url || d.images?.large?.[0]?.url;
  const description = scrubContacts(htmlToText(d.descriptionInHtml) || clean(d.descriptionStripped));
  const out = {
    sourceId: id,
    url: offerUrl(d.seoUrl, id),
    title: clean(d.name) || undefined,
    description: description || undefined,
    priceCzk: offer.priceCzk,
    priceNote: offer.priceNote,
    postedAt: toIso(d.startingTime),
    categorySrc: categoryName(d.category),
    locationText: cleanLocation(d.itemLocation) || cleanLocation(d.seller?.location),
    psc: czPsc(d.postCode),
    photoUrl: photoUrl || undefined,
    photoCount: imgs.length || (Array.isArray(d.images?.large) ? d.images.large.length : undefined) || undefined,
    params: buildParams(d.attributes, { retailPrice: d.retailPrice, offerType: offer.offerType, endingTime: d.endingTime }),
    sellerType: sellerType(d.seller),
    views: Number.isFinite(d.displayedCount) ? d.displayedCount : undefined,
    detailComplete: true,
  };
  return out;
}

/** Nabídka skončila (prodaná / ukončená / archivovaná) nebo už není v kategorii kol. */
function isGoneOffer(d) {
  if (!d || typeof d !== 'object') return false;
  if (d.state && String(d.state).toUpperCase() !== 'ACTIVE') return true;
  if (d.itemArchived === true) return true;
  return outsideBikes(d.category);
}

// ---------------------------------------------------------------------------------------------------------------
// SSR záložka: <script id="ng-state" type="application/json">{"aukCache": {KLÍČ: {t, b: <stejný JSON jako API>}}}</script>
// KLÍČ = [METODA, cesta, query, tělo, hlavičky].join('\u001c')

/**
 * Přečte Angular TransferState z HTML stránky Aukra a vrátí uložené odpovědi API.
 * @param {string} html
 * @returns {{method: string, path: string, query: string, body: string, data: any}[] | null} null = stránka stav nemá
 */
function parseNgState(html) {
  const m = String(html ?? '').match(/<script\b[^>]*\bid\s*=\s*["']?ng-state["']?[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  let raw = m[1].trim();
  // Starší Angular escapoval znaky jako &q; &s; &l; &g; &a;
  if (raw.startsWith('{&q;')) raw = raw.replace(/&q;/g, '"').replace(/&s;/g, "'").replace(/&l;/g, '<').replace(/&g;/g, '>').replace(/&a;/g, '&');
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    return null;
  }
  const cache = state && typeof state === 'object' ? state.aukCache || state : {};
  const out = [];
  for (const [key, val] of Object.entries(cache)) {
    if (!key.includes('\u001c')) continue;
    const [method = '', path = '', query = '', body = ''] = key.split('\u001c');
    out.push({ method: method.toUpperCase(), path, query, body, data: val && typeof val === 'object' && 'b' in val ? val.b : val });
  }
  return out;
}

/**
 * Detail nabídky (stejný tvar jako offerDetail API) z HTML stránky nabídky; nenalezeno → null.
 * @param {string} html
 * @param {string|number} [itemId] když je zadané, musí sedět id nabídky
 */
function parseSsrDetail(html, itemId) {
  for (const e of parseNgState(html) || []) {
    const m = e.method === 'GET' && e.path.match(/\/offers\/(\d+)\/offerDetail$/);
    if (!m || !e.data || typeof e.data !== 'object') continue;
    if (itemId != null && m[1] !== String(itemId)) continue;
    return e.data;
  }
  return null;
}

/**
 * Výsledek hledání (stejný tvar jako searchItemsCommon API) z HTML stránky výpisu; nenalezeno → null.
 * Přednost má záznam pro kategorii kol (stránka může obsahovat i jiná hledání, např. karusely).
 * @param {string} html
 */
function parseSsrSearch(html) {
  let fallback = null;
  for (const e of parseNgState(html) || []) {
    if (e.method !== 'POST' || !/\/offers\/searchItemsCommon$/.test(e.path) || !Array.isArray(e.data?.content)) continue;
    let body = null;
    try {
      body = JSON.parse(e.body);
    } catch {}
    if (body?.categorySeoUrl === CATEGORY_SEO) return e.data;
    fallback ??= e.data;
  }
  return fallback;
}

// ---------------------------------------------------------------------------------------------------------------
// Síť (výhradně přes ctx.http – šetrné pauzy a opakování řeší src/util/http.js)

// Stav jednoho běhu (pipeline vytváří pro každý běh nový ctx):
//  apiRejects – odmítnutí API detailu (4xx) po sobě; od SSR_SWITCH_AFTER rovnou HTML stránky,
//  listed – id nabídek z dnešního výpisu, details / goneListed – pojistka proti hromadnému „zmizení“ (viz detail()).
const runState = new WeakMap();
function stateOf(ctx) {
  let s = runState.get(ctx);
  if (!s) runState.set(ctx, (s = { apiRejects: 0, listed: new Set(), details: 0, goneListed: 0 }));
  return s;
}

/** 4xx kromě 429 (a u detailu kromě 404/410 = nabídka neexistuje) → má smysl zkusit HTML stránku. */
function ssrWorthy(e, { detail = false } = {}) {
  const st = e?.status;
  if (!(st >= 400 && st < 500) || st === 429) return false;
  return !(detail && (st === 404 || st === 410));
}

async function fetchSearchApi(ctx, page) {
  const res = await ctx.http.request(searchUrl(page), {
    method: 'POST',
    accept: API_ACCEPT,
    headers: { ...API_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(SEARCH_BODY),
    signal: ctx.signal,
  });
  try {
    return res.json();
  } catch {
    throw new Error(`Aukro: výpis (strana ${page + 1}) nevrátil JSON`);
  }
}

async function fetchSearchSsr(ctx, page) {
  const html = await ctx.http.text(listingPageUrl(page), { accept: HTML_ACCEPT, signal: ctx.signal });
  const json = parseSsrSearch(html);
  if (!json) throw new Error(`Aukro: HTML výpisu (strana ${page + 1}) neobsahuje data (ng-state)`);
  return json;
}

/**
 * JSON detailu nabídky: API, při 4xx záložka přes HTML stránku. Nabídka neexistuje (404/410) → null.
 * @returns {Promise<object|null>}
 */
async function fetchDetailJson(ctx, id, pageUrl) {
  const st = stateOf(ctx);
  if (st.apiRejects < SSR_SWITCH_AFTER) {
    try {
      const res = await ctx.http.request(detailUrl(id), { accept: API_ACCEPT, headers: API_HEADERS, okStatuses: [404, 410], signal: ctx.signal });
      st.apiRejects = 0;
      if (res.status === 404 || res.status === 410) return null;
      return res.json();
    } catch (e) {
      if (!ssrWorthy(e, { detail: true })) throw e;
      // Jednorázové odmítnutí → HTML jen pro tuto nabídku; opakované → do konce běhu rovnou HTML stránky.
      st.apiRejects++;
      const msg = st.apiRejects >= SSR_SWITCH_AFTER ? 'do konce běhu beru HTML stránky nabídek (SSR)' : 'zkouším HTML stránku nabídky (SSR)';
      ctx.log?.warn?.(`Aukro: API detailu odpovědělo chybou, ${msg}`, { status: e.status, id });
    }
  }
  const res = await ctx.http.request(pageUrl || offerUrl(null, id), { accept: HTML_ACCEPT, okStatuses: [404, 410], signal: ctx.signal });
  if (res.status === 404 || res.status === 410) return null;
  const d = parseSsrDetail(res.text(), id);
  if (!d) throw new Error(`Aukro: HTML stránka nabídky ${id} neobsahuje data detailu (ng-state)`);
  return d;
}

/** Odpověď detailu patří jiné nabídce (přesměrování / změna API) → chyba, ne data cizí nabídky. */
function checkDetailId(d, id) {
  const got = d?.itemId ?? d?.id;
  if (got != null && String(got) !== id) throw new Error(`Aukro: detail nabídky ${id} vrátil nabídku ${got}`);
}

function listingId(listing) {
  const id = String(listing?.source_id ?? listing?.sourceId ?? '').trim();
  if (!/^\d+$/.test(id)) throw new Error(`Aukro: neplatné id nabídky „${id}“`);
  return id;
}

// ---------------------------------------------------------------------------------------------------------------
// Kontrakt zdroje

/**
 * Projde celý výpis kategorie kol (všechny stránky, i v inkrementálním režimu – topované nabídky jsou nahoře).
 * complete = došel na poslední stránku bez chyby, počet unikátních nabídek ≈ totalElements a režim je 'full'.
 * @param {object} ctx viz docs/ARCHITEKTURA.md
 * @returns {Promise<{complete: boolean, total: number|null, unique: number, emitted: number, foreign: number, cheap: number, offCategory: number, viaSsr: boolean}>}
 */
async function scan(ctx) {
  const log = ctx.log;
  const maxPages = ctx.maxPages > 0 ? ctx.maxPages : 400;
  const minPrice = Number(ctx.minPrice) > 0 ? Number(ctx.minPrice) : 0;
  const seen = new Set();
  let page = 0;
  let totalPages = 1;
  let totalElements = null;
  let emitted = 0;
  let foreign = 0;
  let cheap = 0;
  let invalid = 0;
  let offCategory = 0;
  let viaSsr = false;
  const st = stateOf(ctx);
  let reachedEnd = false;

  while (page < totalPages) {
    throwIfAborted(ctx.signal);
    if (page >= maxPages) {
      log?.warn?.(`Aukro: dosažen limit ${maxPages} stránek, výpis není úplný`);
      break;
    }
    let json;
    if (!viaSsr) {
      try {
        json = await fetchSearchApi(ctx, page);
      } catch (e) {
        if (page !== 0 || !ssrWorthy(e)) throw e;
        viaSsr = true; // jen od první stránky – HTML výpis má jinou velikost stránky
        log?.warn?.('Aukro: API výpisu odpovědělo chybou, zkouším HTML stránky výpisu (SSR)', { status: e.status });
      }
    }
    if (viaSsr) json = await fetchSearchSsr(ctx, page);
    const content = json?.content;
    const info = json?.page;
    if (!Array.isArray(content) || !info || typeof info !== 'object') throw new Error(`Aukro: neočekávaná odpověď výpisu (strana ${page + 1})`);
    if (Number.isFinite(info.number) && info.number !== page) {
      throw new Error(`Aukro: výpis vrátil stranu ${info.number + 1} místo ${page + 1}`);
    }
    // API by při změně mohlo tělo hledání ignorovat a vrátit jiný výpis (celý web) → nic neukládat ani nemazat.
    if (inBikeCategory(json.categoryPath) === false) throw new Error(`Aukro: výpis (strana ${page + 1}) není kategorie kol – změnilo se API?`);
    totalPages = Number(info.totalPages) || 0;
    totalElements = Number(info.totalElements) || 0;
    if (!content.length) {
      reachedEnd = true; // výpis se během průchodu zkrátil – úplnost posoudí počet níže
      break;
    }
    for (const raw of content) {
      const id = raw?.itemId != null ? String(raw.itemId) : null;
      if (!id) {
        invalid++;
        continue;
      }
      if (seen.has(id)) continue; // posun stránkování během průchodu
      seen.add(id);
      if (outsideBikes(raw.categoryPath)) {
        offCategory++;
        continue;
      }
      if (isForeignSeller(raw)) {
        foreign++;
        continue;
      }
      const item = normalizeListItem(raw);
      if (!item) {
        invalid++;
        continue;
      }
      if (minPrice && item.priceCzk != null && item.priceCzk < minPrice) {
        cheap++;
        continue;
      }
      st.listed.add(item.sourceId);
      await ctx.emit(item);
      emitted++;
    }
    page++;
    if (page >= totalPages) reachedEnd = true;
  }

  const total = totalElements ?? 0;
  const tolerance = Math.max(3, Math.ceil(total * 0.02));
  const countOk = total > 0 && seen.size + tolerance >= total;
  // Pojistka proti změně formátu API: kdyby většina nabídek vypadala jako zahraniční / neúplná, nic neoznačovat jako zmizelé.
  const sane = foreign <= seen.size * 0.5 && invalid + offCategory <= Math.max(2, seen.size * 0.05);
  const full = ctx.mode === 'full'; // kontrakt: complete jen v úplném režimu
  const complete = reachedEnd && countOk && sane && full;
  if (reachedEnd && !countOk) log?.warn?.('Aukro: počet nabídek nesedí s celkovým počtem, výpis beru jako neúplný', { unique: seen.size, total });
  if (!sane) log?.warn?.('Aukro: podezřele mnoho zahraničních / neúplných nabídek – změnilo se API?', { foreign, invalid, offCategory, unique: seen.size });
  log?.info?.(`Aukro: ${emitted} nabídek z ${seen.size} (zahraniční ${foreign}, pod minimální cenou ${cheap})`, { pages: page, total, viaSsr });
  return { complete, total: totalElements, unique: seen.size, emitted, foreign, cheap, offCategory, viaSsr };
}

/**
 * Detail nabídky: plný popis, fotka, počet fotek, zobrazení, poloha. Nabídka skončila / neexistuje → null.
 * @param {object} ctx
 * @param {{source_id: string, url: string}} listing řádek z DB
 */
async function detail(ctx, listing) {
  const id = listingId(listing);
  const st = stateOf(ctx);
  st.details++;
  const d = await fetchDetailJson(ctx, id, listing.url);
  if (d === null || isGoneOffer(d)) {
    // Pojistka: nabídka je v DNEŠNÍM výpisu, a detail přesto hlásí konec. Pár takových je normální (skončila mezi
    // výpisem a detailem), hromadně to znamená změnu API (jiná adresa → 404, jiné stavy) – pak raději chyba, než
    // označit všechny nové nabídky jako zmizelé.
    if (st.listed.has(id) && ++st.goneListed > Math.max(5, st.details * 0.3)) {
      throw new Error(`Aukro: detail hlásí konec u ${st.goneListed} nabídek z dnešního výpisu – změnilo se API? Neoznačuji jako zmizelé.`);
    }
    return null;
  }
  checkDetailId(d, id);
  const item = normalizeDetail(d);
  if (!item) throw new Error(`Aukro: neočekávaná odpověď detailu nabídky ${id}`);
  return item;
}

/**
 * Ověří, zda nabídka chybějící ve výpisu opravdu skončila. Uplynul-li plánovaný konec (params „Konec“), stačí to
 * bez dalšího požadavku; jinak (prodej přes Kup teď, stažení) se zeptá API detailu.
 * @returns {Promise<boolean|null>} true = skončila, false = stále běží v kategorii kol, null = nevím
 */
async function confirmGone(ctx, listing) {
  const end = parseCzDateTime(listing?.params?.['Konec']);
  if (end != null && end + END_GRACE_MS < Date.now()) return true;
  let id;
  try {
    id = listingId(listing);
  } catch {
    return null;
  }
  try {
    const d = await fetchDetailJson(ctx, id, listing.url);
    if (d === null || isGoneOffer(d)) return true;
    checkDetailId(d, id);
    return String(d.state || '').toUpperCase() === 'ACTIVE' ? false : null;
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    return null;
  }
}

module.exports = {
  key: 'aukro',
  /** Aukro: minimální provoz (robots.txt blokuje ClaudeBota) – detailů za běh jen pár set. */
  defaultMaxDetails: 300,
  label: 'Aukro',
  homepage: 'https://aukro.cz',
  requiresBrowser: false,
  scan,
  detail,
  confirmGone,
  // pro testy a ladění
  parseNgState,
  parseSsrDetail,
  parseSsrSearch,
  normalizeListItem,
  normalizeDetail,
  isForeignSeller,
  isGoneOffer,
  formatCzDateTime,
  parseCzDateTime,
  searchUrl,
  detailUrl,
  listingPageUrl,
  SEARCH_BODY,
};
