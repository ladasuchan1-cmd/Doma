'use strict';
// Bazoš (bazos.cz) – inzeráty kol.
//
// Data bereme z neveřejného JSON API mobilní aplikace Bazoše (robots.txt /api/ nezakazuje, bez cookies a přihlášení):
//   výpis  https://www.bazos.cz/api/v1/ads.php?offset=0&limit=200&section=sp&category=256
//          – nejnovější první, placené TOP inzeráty na začátku (a pár dalších roztroušeně), `topped` je ŘETĚZEC,
//          – stránkuje se offsetem až do konce kategorie (ověřeno 2. 10. 2026: horská kola 11 943 inzerátů = stejně
//            jako HTML výpis; za koncem vrací []). Stránka může mít i méně než `limit` položek (např. 199) –
//            konec poznáme až podle prázdné stránky.
//   detail https://www.bazos.cz/api/v1/ad-detail-2.php?ad_id=224568683
//          – plný popis, PSČ, přibližné souřadnice (≈ těžiště PSČ), všechny fotky, počet inzerátů prodejce;
//            smazaný inzerát → HTTP 410 {"status":"deleted"}.
// HTML výpis (https://sport.bazos.cz/horska/20/ …, 20 inzerátů na stránku, odkaz „Další“) je záloha:
//   - když API pro kategorii vůbec neodpoví, projde se výpis přes HTML,
//   - v celém průchodu se po konci API stáhne 1 HTML stránka na konci výpisu – kdyby API někdy vracelo jen část
//     výpisu (má „Další“), pokračuje se HTML stránkami až na konec.
// Bazoš nemá strukturované parametry (velikost rámu, rok …) – ty se vytěží z textu v src/classify.
// Osobní údaje (jméno, telefon, e-mail, ID prodejce) se nikdy nečtou ani neukládají.

const { decodeEntities, htmlToText, fold, parseCzk, parseCzDate, parsePsc } = require('../util/text');

const API = 'https://www.bazos.cz/api/v1';
const API_LIMIT = 200;
const HTML_PAGE_SIZE = 20;
/** Inkrementální režim: skončit po tolika stránkách po sobě, kde jsou všechny ne-TOP inzeráty známé a beze změny. */
const STALE_PAGES_TO_STOP = 2;
/** Pojistka proti nekonečné smyčce, když ctx.maxPages chybí. */
const HARD_MAX_PAGES = 2000;

/**
 * Kategorie s koly. Vynechané: koloběžky (sp/450) a součástky.
 * section = sekce API, id = kategorie API, host + path = HTML výpis.
 */
const CATEGORIES = [
  { key: 'horska', label: 'Horská kola', section: 'sp', id: '256', host: 'sport.bazos.cz', path: '/horska/' },
  { key: 'elektrokola', label: 'Elektrokola', section: 'sp', id: '465', host: 'sport.bazos.cz', path: '/elektrokola/' },
  { key: 'silnicni', label: 'Silniční kola', section: 'sp', id: '257', host: 'sport.bazos.cz', path: '/silnicni/' },
  { key: 'cyklistika', label: 'Ostatní cyklistika', section: 'sp', id: '259', host: 'sport.bazos.cz', path: '/cyklistika/' },
  { key: 'detska', label: 'Dětská kola', section: 'de', id: '456', host: 'deti.bazos.cz', path: '/kola/' },
];
const CAT_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

const apiListUrl = (cat, offset) => `${API}/ads.php?offset=${offset}&limit=${API_LIMIT}&section=${cat.section}&category=${cat.id}`;
const apiDetailUrl = (id) => `${API}/ad-detail-2.php?ad_id=${encodeURIComponent(id)}`;
const htmlListUrl = (cat, offset) => `https://${cat.host}${cat.path}${offset > 0 ? `${offset}/` : ''}`;

// ---------------------------------------------------------------- chyby a blokace

/** Bazoš nás zablokoval (captcha, „Příliš mnoho dotazů“, HTTP 403/429) – zdroj pro tento běh končí. */
class BazosBlockedError extends Error {
  constructor(reason, url) {
    super(`Bazoš zablokoval stahování (${reason}) – Bazoš pro tento běh končím, zkuste to později nebo zvyšte KOLOMAPA_DELAY_MS`);
    this.name = 'BazosBlockedError';
    this.blocked = true;
    this.url = url;
  }
}

// Kontroluje se jen u odpovědí, které nejsou normální data (neplatný JSON, stránka bez výpisu) – popisy inzerátů
// tato slova obsahovat smějí.
const BLOCK_RX = /captcha|p[řr][íi]li[šs]\s+mnoho|ov[ěe][řr]en[íi]/i;
const states = new WeakMap(); // ctx → {blocked}

function stateOf(ctx) {
  let st = states.get(ctx);
  if (!st) states.set(ctx, (st = { blocked: null }));
  return st;
}

function markBlocked(ctx, reason, url) {
  const st = stateOf(ctx);
  if (!st.blocked) {
    st.blocked = new BazosBlockedError(reason, url);
    ctx.log?.warn?.(st.blocked.message, { url });
  }
  return st.blocked;
}

const isBlocked = (e) => !!(e && e.blocked);

function throwIfAborted(ctx) {
  if (ctx.signal?.aborted) throw ctx.signal.reason || new Error('Přerušeno');
}

/** GET přes sdílený ctx.http (šetrné pauzy, opakování). HTTP 403/429 = blokace. */
async function fetchText(ctx, url, { okStatuses = [], accept } = {}) {
  const st = stateOf(ctx);
  if (st.blocked) throw st.blocked;
  throwIfAborted(ctx);
  let res;
  try {
    res = await ctx.http.request(url, { okStatuses, accept, signal: ctx.signal });
  } catch (e) {
    if (e && (e.status === 403 || e.status === 429)) throw markBlocked(ctx, `HTTP ${e.status}`, url);
    throw e;
  }
  return { status: res.status, url: res.url || url, text: String(res.text() ?? '') };
}

// Chybový JSON objekt API, který zní jako omezení („too many requests“, „blocked“ …) = blokace, ne změna schématu.
const API_BLOCK_RX = /too\s*many|rate.?limit|throttl|blocked|banned|zablokov|captcha|p[řr][íi]li[šs]\s+mnoho/i;

/** JSON odpověď API; HTML/captcha místo JSONu → blokace, jiný nesmysl → chyba schématu. */
function parseApiJson(ctx, text, url) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    if (BLOCK_RX.test(text)) throw markBlocked(ctx, 'captcha / ověření místo dat', url);
    throw new Error(`Bazoš API vrátilo neplatný JSON (${url}): ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && data.id == null && data.status !== 'deleted' && API_BLOCK_RX.test(text.slice(0, 2000))) {
    throw markBlocked(ctx, `API: ${text.slice(0, 80).replace(/\s+/g, ' ')}`, url);
  }
  return data;
}

// ---------------------------------------------------------------- pomocníci

function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return /^(true|1|yes|ano)$/i.test(String(v ?? '').trim());
}

function toInt(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  const d = String(v ?? '').replace(/\D/g, '');
  return d ? Number(d) : null;
}

/** Titulek: dekódované entity, jedna mezera mezi slovy (stejně pro API výpis, detail i HTML → bez falešných změn). */
function cleanTitle(s) {
  return decodeEntities(String(s ?? ''))
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

/** Popis z API (prostý text s \r\n): sjednotit konce řádků a mezery. */
function cleanDescription(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function validId(v) {
  const s = String(v ?? '').trim();
  return /^\d{4,12}$/.test(s) ? s : null;
}

/** Odkaz na inzerát – jen https://*.bazos.cz/inzerat/<id>/… (slug musí být přesný, jinak web vrací 404). */
function validAdUrl(u, id) {
  const s = String(u ?? '').trim().replace(/^http:\/\//i, 'https://');
  const m = /^https:\/\/(?:[a-z0-9-]+\.)*bazos\.cz\/inzerat\/(\d+)\//i.exec(s);
  return m && (!id || m[1] === String(id)) ? s : null;
}

/** ID inzerátu z řádku DB / položky / URL. */
function idOf(listing) {
  return validId(listing?.source_id ?? listing?.sourceId) || validId((/\/inzerat\/(\d+)\//.exec(String(listing?.url ?? '')) || [])[1]);
}

// Europe/Prague: letní čas od poslední neděle v březnu 01:00 UTC do poslední neděle v říjnu 01:00 UTC.
function lastSundayUtc(year, month) {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay(), 1);
}

function isPragueDst(utcMs) {
  const y = new Date(utcMs).getUTCFullYear();
  return utcMs >= lastSundayUtc(y, 2) && utcMs < lastSundayUtc(y, 9);
}

/**
 * Místní pražský čas „2026-10-02 15:22:25“ → ISO v UTC („2026-10-02T13:22:25.000Z“), se střídáním letního času.
 * @param {string} s
 * @returns {string|null}
 */
function pragueLocalToIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0)];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  const local = Date.UTC(y, mo - 1, d, h, mi, se);
  let utc = local - 2 * 3600e3;
  if (!isPragueDst(utc)) utc = local - 3600e3;
  return new Date(utc).toISOString();
}

/** RFC 2822 / ISO s posunem („Fri, 02 Oct 2026 15:23:16 +0200“) → ISO v UTC. */
function rfcToIso(s) {
  if (!s) return null;
  const t = Date.parse(String(s));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const PRICE_TYPE_NOTE = { NEGOTIATED: 'Dohodou', OFFERED: 'Nabídněte', IN_TEXT: 'V textu', ANY: 'Nerozhoduje', FREE: 'Zdarma' };
const PRICE_WORDS = [
  [/dohodou/, 'Dohodou'],
  [/nabidnete/, 'Nabídněte'],
  [/v textu/, 'V textu'],
  [/nerozhoduje/, 'Nerozhoduje'],
  [/zdarma|darem|daruji/, 'Zdarma'],
  [/vymen/, 'Výměna'],
];

/**
 * Cena z Bazoše: „170 000 Kč“ → 170000; slovní ceny („Dohodou“, „Nabídněte“, „V textu“, „Nerozhoduje“, „Zdarma“)
 * → null + priceNote; zástupné 0–1 Kč → null + poznámka. Výpis i detail používají stejný řetězec price_formatted,
 * aby se cena mezi nimi „neměnila“.
 * @param {string} formatted price_formatted / text ceny z HTML
 * @param {{price?: string|number, priceType?: string, currency?: string}} [o] doplňky z detailu API
 * @returns {{priceCzk: number|null, priceNote: string|null}}
 */
function parsePrice(formatted, { price, priceType, currency } = {}) {
  const text = cleanTitle(formatted);
  const type = String(priceType ?? '').toUpperCase();
  let n = null;
  const m = /^(\d{1,3}(?:[ .]\d{3})+|\d+)(?:,-)?\s*(?:Kč|CZK|,-)?$/i.exec(text);
  if (m) n = Number(m[1].replace(/\D/g, ''));
  else if (!text && /^\d+(?:\.\d+)?$/.test(String(price ?? '').trim())) n = Math.round(Number(price));
  else if (/\d/.test(text) && /kč|czk|,-/i.test(text)) n = parseCzk(text);
  if (n != null && currency && !/^(czk|kč)$/i.test(String(currency).trim())) return { priceCzk: null, priceNote: text || null };
  if (n != null && Number.isFinite(n)) {
    if (n <= 1) return { priceCzk: null, priceNote: `${n} Kč – cena neuvedena` };
    return { priceCzk: n, priceNote: null };
  }
  const f = fold(text);
  const word = PRICE_WORDS.find(([rx]) => rx.test(f));
  return { priceCzk: null, priceNote: (word && word[1]) || PRICE_TYPE_NOTE[type] || text || null };
}

/** Fotka v plné velikosti (~1200×900): /img/1m/… (API výpis) i /img/1t/… (HTML výpis) → /img/1/…; bez fotky → null. */
function fullPhotoUrl(u) {
  const s = String(u ?? '').trim();
  if (!/^https?:\/\//i.test(s) || /empty\.gif|nofoto|\/obrazky\//i.test(s)) return null;
  return s.replace(/^http:\/\//i, 'https://').replace(/\/img\/(\d+)[mt]\//, '/img/$1/');
}

// Prodejce firma? Bazoš to neuvádí – odhad z textu (bez diakritiky) a počtu inzerátů prodejce.
// Záměrně bez „nabízíme“ (píší i rodiny), „DPH“ jen ve firemních spojeních („odpočet DPH“, „faktura s DPH“, ne
// „koupeno za … vč. DPH“) a e-shop jen „náš e-shop“ („viz e-shop“ bývá odkaz na cenu nového kola).
const COMPANY_RX =
  /\b(ico|dic)\b|\bic\s*:?\s*\d{8}\b|\b(odpocet|odpoctu|odecist|odectu|odecet|bez|platce|neplatce)\s+dph\b|faktur\w*\s+(s|vc\.?|vcetne)\s+dph|\bprodejn(a|e|y|u|ou|ach|ami)\b|\b(nas\w*|v nasem|na nasem)\s+e-?shop|\bskladem\b|\bna splatky\b/;
const SRO_RX = /\bs\.\s?r\.\s?o\b|\bspol\.\s?s\s?r\.|\bsro\b/g;
// Běžný uživatel Bazoše má nejvýš ~50 inzerátů (ve vzorku 654 detailů špička přesně na 50, nad 50 jen ~1 %);
// víc = firemní účet. Hranice 15 by označila ~22 % prodejců – hlavně lidi, kteří vyprodávají domácnost.
const COMPANY_ADS_COUNT = 51;

/**
 * Odhad typu prodejce.
 * @param {string} text titulek + popis
 * @param {number|null} userAdsCount počet inzerátů prodejce (z detailu API)
 * @returns {'private'|'company'}
 */
function sellerTypeOf(text, userAdsCount) {
  const f = fold(text);
  if (COMPANY_RX.test(f)) return 'company';
  // s.r.o. jen když nejde o „koupeno v XY s.r.o.“
  for (const m of f.matchAll(SRO_RX)) {
    if (!/(koupen|kupovan|porizen|objednan)[^\n]{0,50}$/.test(f.slice(Math.max(0, m.index - 60), m.index))) return 'company';
  }
  if (userAdsCount != null && userAdsCount >= COMPANY_ADS_COUNT) return 'company';
  return 'private';
}

function validCoord(lat, lon) {
  const a = Number(String(lat ?? '').replace(',', '.'));
  const b = Number(String(lon ?? '').replace(',', '.'));
  // jen ČR (hrubý obdélník) – zahraniční / nulové souřadnice ignorovat
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 48.4 || a > 51.2 || b < 11.9 || b > 19.1) return null;
  return { lat: a, lon: b };
}

// ---------------------------------------------------------------- parsery

/**
 * Výpis z API (ads.php) → [{item, isTop}]. Neplatné položky se přeskočí.
 * @param {any} data rozparsovaný JSON
 * @param {{label: string}} cat
 */
function parseApiList(data, cat) {
  if (!Array.isArray(data)) throw new Error(`Bazoš API: výpis ${cat.label} není pole (${typeof data})`);
  const out = [];
  for (const x of data) {
    if (!x || typeof x !== 'object') continue;
    const sourceId = validId(x.id);
    const url = validAdUrl(x.url, sourceId);
    const title = cleanTitle(x.title);
    if (!sourceId || !url || !title) continue;
    const isTop = toBool(x.topped);
    const item = {
      sourceId,
      url,
      title,
      ...parsePrice(x.price_formatted, { currency: x.currency }),
      categorySrc: cat.label,
      locationText: cleanTitle(x.locality) || undefined,
      views: toInt(x.views) ?? undefined,
      detailComplete: false,
    };
    // U TOP inzerátů je „from“ čas požadavku / posledního topování → nepoužitelné (a nesmí přepsat známé datum).
    if (!isTop) item.postedAt = pragueLocalToIso(x.from) || rfcToIso(x.from) || undefined;
    const photo = fullPhotoUrl(x.image_thumbnail);
    if (photo) item.photoUrl = photo;
    else if (/empty\.gif/i.test(String(x.image_thumbnail ?? ''))) item.photoCount = 0;
    out.push({ item, isTop });
  }
  return out;
}

/**
 * Detail z API (ad-detail-2.php) → {gone: true} | {gone: false, item, categoryId}.
 * @param {any} data rozparsovaný JSON (objekt, případně pole s jedním objektem)
 * @param {string} [expectId]
 */
function parseApiDetail(data, expectId) {
  const x = Array.isArray(data) ? data[0] : data;
  if (!x || typeof x !== 'object') throw new Error(`Bazoš API: neočekávaná odpověď detailu ${expectId || ''}`.trim());
  const status = String(x.status ?? '').trim().toLowerCase();
  if (status === 'deleted') return { gone: true };
  // Neznámý stav nebo chybová odpověď bez údajů → chyba (pipeline detail zkusí jindy, inzerát neoznačí jako hotový).
  if ((status && status !== 'active') || (!validId(x.id) && !cleanTitle(x.title))) {
    throw new Error(`Bazoš API: detail ${expectId || ''} má neočekávaný stav „${status || '?'}“`.replace('  ', ' '));
  }
  const sourceId = validId(x.id) || validId(expectId);
  if (expectId && validId(x.id) && validId(x.id) !== String(expectId)) {
    throw new Error(`Bazoš API: detail ${expectId} vrátil jiný inzerát (${x.id})`);
  }
  if (!sourceId) throw new Error('Bazoš API: detail bez ID inzerátu');
  const categoryId = x.category && typeof x.category === 'object' && x.category.id != null ? String(x.category.id).trim() : null;
  const cat = categoryId ? CAT_BY_ID.get(categoryId) : null;
  const title = cleanTitle(x.title);
  const description = cleanDescription(x.description);
  const userAdsCount = toInt(x.user_ads_count);
  const hasImages = Array.isArray(x.images);
  const images = (hasImages ? x.images : [])
    .map((im) => (typeof im === 'string' ? im : im && typeof im === 'object' ? im.url || im.src : null))
    .map(fullPhotoUrl)
    .filter(Boolean);
  const item = {
    sourceId,
    title: title || undefined,
    description: description || undefined,
    ...parsePrice(x.price_formatted, { price: x.price, priceType: x.price_type, currency: x.currency }),
    categorySrc: cat ? cat.label : cleanTitle(x.category?.title) || undefined,
    locationText: cleanTitle(x.locality) || undefined,
    psc: parsePsc(x.zip_code) || undefined,
    photoUrl: images[0] || fullPhotoUrl(x.image_thumbnail) || undefined,
    photoCount: hasImages ? images.length : undefined,
    views: toInt(x.views) ?? undefined,
    sellerType: sellerTypeOf(`${title}\n${description}`, userAdsCount),
    detailComplete: true,
  };
  const url = validAdUrl(x.url, sourceId);
  if (url) item.url = url;
  // Souřadnice z API jsou přibližné (≈ těžiště PSČ), pro mapu krajů ale stačí.
  const c = validCoord(x.latitude, x.longitude);
  if (c) Object.assign(item, c);
  if (!toBool(x.topped)) {
    // Nejdřív přesný formát „YYYY-MM-DD HH:MM:SS“ (pražský čas) – Date.parse by ho bral v časovém pásmu serveru.
    const posted = pragueLocalToIso(x.from) || rfcToIso(x.from);
    if (posted) item.postedAt = posted;
  }
  return { gone: false, item, categoryId };
}

/**
 * HTML výpis (https://sport.bazos.cz/horska/40/) → {ok, items: [{item, isTop, dayDate}], first, total, next}.
 * ok = stránka vypadá jako výpis Bazoše (hlavička „Zobrazeno … z …“ nebo inzeráty).
 * @param {string} html
 * @param {string} pageUrl
 * @param {{label: string}} cat
 */
function parseListHtml(html, pageUrl, cat) {
  const base = new URL(pageUrl);
  const header = /Zobrazeno\s+(\d[\d\s\u00a0]*?)\s*-\s*(\d[\d\s\u00a0]*?)\s+inzerát\S*\s+z\s+(\d[\d\s\u00a0]*)/i.exec(html);
  const nextM = /<a href="([^"]+)"[^>]*>\s*<b>\s*Další\s*<\/b>\s*<\/a>/i.exec(html);
  const items = [];
  const blocks = html.split(/<div class=["']?inzeraty inzeratyflex["']?>/i).slice(1);
  for (const b of blocks) {
    const a = /<h2 class=["']?nadpis["']?>\s*<a href="([^"]*\/inzerat\/(\d+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
    if (!a) continue;
    const sourceId = validId(a[2]);
    const url = validAdUrl(new URL(decodeEntities(a[1]), base).href, sourceId);
    const title = cleanTitle(htmlToText(a[3]));
    if (!sourceId || !url || !title) continue;
    const meta = (/<span class=["']?velikost10["']?>([\s\S]*?)<\/span>\s*<br/i.exec(b) || [])[1] || '';
    const isTop = /class=["']?ztop/i.test(meta) || />\s*TOP\s*</.test(meta);
    const dayDate = parseCzDate((/\[([^\]]+)\]/.exec(meta) || [])[1]);
    const cena = htmlToText((/<div class=["']?inzeratycena["']?>([\s\S]*?)<\/div>/i.exec(b) || [])[1]);
    const lok = (/<div class=["']?inzeratylok["']?>([\s\S]*?)<\/div>/i.exec(b) || [])[1] || '';
    const [place, pscText] = lok.split(/<br\s*\/?>/i).map((s) => cleanTitle(htmlToText(s)));
    const img = (/<img[^>]*src="([^"]+)"[^>]*class=["']?obrazek/i.exec(b) || [])[1];
    const snippet = htmlToText((/<div class=["']?popis["']?>([\s\S]*?)<\/div>/i.exec(b) || [])[1]).replace(/\s*\.\.\.$/, ' …');
    const item = {
      sourceId,
      url,
      title,
      ...parsePrice(cena),
      categorySrc: cat.label,
      locationText: place || undefined,
      psc: parsePsc(pscText) || undefined,
      views: toInt((/<div class=["']?inzeratyview["']?>([\s\S]*?)<\/div>/i.exec(b) || [])[1]) ?? undefined,
      description: snippet || undefined,
      detailComplete: false,
    };
    const photo = fullPhotoUrl(img && decodeEntities(img));
    if (photo) item.photoUrl = photo;
    else if (img && /empty\.gif/i.test(img)) item.photoCount = 0;
    items.push({ item, isTop, dayDate });
  }
  return {
    ok: !!header || items.length > 0,
    items,
    first: header ? toInt(header[1]) : null,
    total: header ? toInt(header[3]) : null,
    next: nextM ? new URL(decodeEntities(nextM[1]), base).href : null,
  };
}

function offsetOfHtmlUrl(u) {
  const m = /\/(\d+)\/?$/.exec(new URL(u).pathname);
  return m ? Number(m[1]) : 0;
}

// ---------------------------------------------------------------- průchod výpisu

/**
 * Předá položku pipeline (minPrice, odstranění duplicit v rámci průchodu). Vrací {emitted, known}.
 * known = inzerát už byl v DB a nezměnil se (pro inkrementální zastavení).
 */
async function emitItem(ctx, run, item) {
  if (run.seen.has(item.sourceId)) return { emitted: false, known: true };
  run.seen.add(item.sourceId);
  const minPrice = Number(ctx.minPrice) || 0;
  // Pod minimální cenou: nové inzeráty přeskočit, známé ale uložit dál (změna ceny, nesmí „zmizet“).
  if (item.priceCzk != null && item.priceCzk < minPrice && !ctx.isKnown?.(item.sourceId)) {
    run.belowMin++;
    return { emitted: false, known: true };
  }
  const r = await ctx.emit(item);
  run.emitted++;
  return { emitted: true, known: !!r && r.isNew === false && !r.changed };
}

/**
 * Projde stránky jedné kategorie přes API. Vrací {complete, pages, positions, endedShort, apiFailed}.
 * apiFailed = API neodpovědělo hned na 1. stránce nebo ji vrátilo prázdnou (→ zkusit HTML).
 * endedShort = poslední neprázdná stránka byla kratší než limit (přirozený konec výpisu; prázdná stránka hned po
 * plné stránce může být i omezení ze strany webu).
 */
async function scanApi(ctx, cat, run) {
  const full = ctx.mode === 'full';
  const maxPages = Math.min(Number(ctx.maxPages) > 0 ? Number(ctx.maxPages) : HARD_MAX_PAGES, HARD_MAX_PAGES);
  let offset = 0;
  let pages = 0;
  let stale = 0;
  let lastLen = 0;
  let noFresh = 0;
  for (;;) {
    throwIfAborted(ctx);
    if (pages >= maxPages) {
      ctx.log?.[full ? 'warn' : 'debug']?.(`Bazoš ${cat.label}: dosažen limit ${maxPages} stránek výpisu (KOLOMAPA_MAX_PAGES)`);
      return { complete: false, pages, positions: offset, stoppedEarly: !full };
    }
    const url = apiListUrl(cat, offset);
    let raw;
    let list;
    try {
      const res = await fetchText(ctx, url, { accept: 'application/json' });
      raw = parseApiJson(ctx, res.text, url);
      list = parseApiList(raw, cat); // jiný JSON než pole → chyba
      if (raw.length && !list.length) throw new Error(`Bazoš API: výpis ${cat.label} má neznámý formát položek`);
      // Neznámá (přečíslovaná) kategorie vrací [] se stavem 200 (ověřeno živě) – kategorie s koly prázdná nebývá.
      if (pages === 0 && !raw.length) throw new Error(`Bazoš API: prázdný výpis kategorie ${cat.label}`);
    } catch (e) {
      if (isBlocked(e) || ctx.signal?.aborted) throw e;
      if (pages === 0) return { complete: false, pages, positions: 0, apiFailed: e };
      throw e;
    }
    pages++;
    // Posun o skutečný počet vrácených pozic (stránka může mít i méně než limit) – konec až u prázdné stránky.
    offset += raw.length;
    if (!raw.length) return { complete: true, pages, positions: offset, endedShort: lastLen < API_LIMIT };
    lastLen = raw.length;
    let fresh = 0;
    let nonTop = 0;
    let nonTopKnown = 0;
    for (const { item, isTop } of list) {
      if (run.seen.has(item.sourceId)) continue; // TOP inzerát už viděný výš v této kategorii
      fresh++;
      const r = await emitItem(ctx, run, item);
      if (!isTop && r.emitted) {
        nonTop++;
        if (r.known) nonTopKnown++;
      }
    }
    ctx.log?.debug?.(`Bazoš ${cat.label}: API stránka ${pages}`, { offset, items: list.length, fresh, nonTop, nonTopKnown });
    if (!fresh) {
      // Krátká stránka samých viděných ID = posun výpisu (během průchodu přibyly nové inzeráty nahoře) → pokračovat.
      // Velká nebo opakovaná = API ignoruje offset / zacyklilo se → raději neúplný průchod.
      if (raw.length >= 50 || ++noFresh >= 2) {
        ctx.log?.warn?.(`Bazoš ${cat.label}: API vrací stále stejné inzeráty (offset ${offset}) – končím kategorii`);
        return { complete: false, pages, positions: offset };
      }
    } else noFresh = 0;
    if (!full && nonTop > 0) {
      stale = nonTopKnown === nonTop ? stale + 1 : 0;
      if (stale >= STALE_PAGES_TO_STOP) return { complete: false, pages, positions: offset, stoppedEarly: true };
    }
  }
}

/** Leží URL ve výpisu dané kategorie (stejný host, cesta pod cat.path)? */
function inCategoryList(u, cat) {
  try {
    const x = new URL(u);
    return x.host === cat.host && x.pathname.startsWith(cat.path);
  } catch {
    return false;
  }
}

/**
 * Projde HTML stránky výpisu od startOffset (záloha za API / ověření konce výpisu). Vrací {complete, pages, ok, total}.
 * @param {{verify?: boolean, apiEndedShort?: boolean, pagesUsed?: number}} o verify = ověřovací stránka po API:
 *   když selže, platí výsledek API – ale jen pokud API skončilo přirozeně kratší stránkou (apiEndedShort)
 */
async function scanHtml(ctx, cat, run, startOffset, { verify = false, apiEndedShort = false, pagesUsed = 0 } = {}) {
  const full = ctx.mode === 'full';
  const maxPages = Math.min(Number(ctx.maxPages) > 0 ? Number(ctx.maxPages) : HARD_MAX_PAGES, HARD_MAX_PAGES);
  let url = htmlListUrl(cat, startOffset);
  let pages = 0;
  let stale = 0;
  let total = null;
  while (url) {
    throwIfAborted(ctx);
    // Jedna ověřovací stránka po API se do limitu nepočítá.
    if (!(verify && pages === 0) && pagesUsed + pages >= maxPages) {
      ctx.log?.[full ? 'warn' : 'debug']?.(`Bazoš ${cat.label}: dosažen limit ${maxPages} stránek výpisu (KOLOMAPA_MAX_PAGES)`);
      return { complete: false, pages, ok: true, total };
    }
    const offset = offsetOfHtmlUrl(url);
    let page;
    let status;
    try {
      const res = await fetchText(ctx, url, { okStatuses: [404] });
      status = res.status;
      // Přesměrování mimo výpis kategorie (zrušená / přejmenovaná kategorie) → cizí inzeráty nebrat.
      if (!inCategoryList(res.url, cat)) throw new Error(`Bazoš: výpis ${cat.label} přesměrován jinam (${res.url})`);
      page = parseListHtml(res.text, url, cat);
      if (status === 404) {
        // 404 za koncem výpisu: hlavička „Zobrazeno … z N“ s N ≤ offset a žádné inzeráty (ověřeno živě).
        // Neexistující kategorie vrací 404 s inzeráty CELÉ sekce (a „Další“ na /20/) → nikdy je nepřebírat.
        if (offset === 0 || page.items.length || (page.total != null && page.total > offset)) {
          throw new Error(`Bazoš: výpis ${cat.label} neexistuje (HTTP 404 ${url})`);
        }
      } else if (!page.ok) {
        if (BLOCK_RX.test(res.text)) throw markBlocked(ctx, 'captcha / ověření místo výpisu', url);
        throw new Error(`Bazoš: stránka výpisu ${url} nemá očekávanou podobu (změna webu?)`);
      }
    } catch (e) {
      if (isBlocked(e) || ctx.signal?.aborted) throw e;
      if (verify && pages === 0) {
        ctx.log?.warn?.(
          `Bazoš ${cat.label}: kontrola konce výpisu přes HTML selhala – ${apiEndedShort ? 'beru výsledek API' : 'API skončilo podezřele (prázdná stránka po plné), průchod beru jako neúplný'}`,
          { url, error: e.message }
        );
        return { complete: apiEndedShort, pages, ok: false, total };
      }
      throw e;
    }
    pages++;
    if (page.total != null) total = page.total;
    if (status === 404) return { complete: true, pages, ok: true, total }; // za koncem výpisu
    if (page.first != null && page.items.length && page.first !== offset + 1) {
      ctx.log?.warn?.(`Bazoš ${cat.label}: HTML stránkování nesouhlasí (čekal jsem ${offset + 1}, web ukazuje ${page.first})`, { url });
      return { complete: verify && pages === 1 && !page.next, pages, ok: false, total };
    }
    let fresh = 0;
    let nonTop = 0;
    let nonTopKnown = 0;
    for (const { item, isTop, dayDate } of page.items) {
      if (run.seen.has(item.sourceId)) continue;
      fresh++;
      const known = ctx.isKnown?.(item.sourceId) || null;
      // Zkrácený popis a datum (jen den) z HTML výpisu jen u inzerátů, které ještě nemají detail.
      if (known && known.detail_at) delete item.description;
      if (!known && !isTop && dayDate) item.postedAt = pragueLocalToIso(`${dayDate} 00:00:00`) || undefined;
      const r = await emitItem(ctx, run, item);
      if (!isTop && r.emitted) {
        nonTop++;
        if (r.known) nonTopKnown++;
      }
    }
    ctx.log?.debug?.(`Bazoš ${cat.label}: HTML stránka`, { url, items: page.items.length, fresh, total: page.total });
    if (verify && pages === 1 && page.next) {
      ctx.log?.warn?.(`Bazoš ${cat.label}: API nevrátilo celý výpis (web uvádí ${page.total ?? '?'} inzerátů) – pokračuji HTML stránkami`);
    }
    if (!full && nonTop > 0) {
      stale = nonTopKnown === nonTop ? stale + 1 : 0;
      if (stale >= STALE_PAGES_TO_STOP) return { complete: false, pages, ok: true, total };
    }
    const next = page.next;
    if (!next) return { complete: true, pages, ok: true, total };
    if (!inCategoryList(next, cat) || offsetOfHtmlUrl(next) <= offset) {
      ctx.log?.warn?.(`Bazoš ${cat.label}: odkaz „Další“ nevede dál ve výpisu kategorie (${next}) – končím kategorii`);
      return { complete: false, pages, ok: false, total };
    }
    url = next;
  }
  return { complete: true, pages, ok: true, total };
}

/** Kolik různých inzerátů kategorie musí průchod vidět vůči počtu, který uvádí web („Zobrazeno … z N“). */
const MIN_SEEN_RATIO = 0.9;

async function scanCategory(ctx, cat, run) {
  const before = run.emitted;
  const seenBefore = run.seen.size;
  const api = await scanApi(ctx, cat, run);
  let complete = api.complete;
  let html = null;
  if (api.apiFailed) {
    ctx.log?.warn?.(`Bazoš ${cat.label}: API nefunguje (${api.apiFailed.message}) – zkouším HTML výpis`);
    html = await scanHtml(ctx, cat, run, 0, { pagesUsed: 0 });
    complete = html.complete;
  } else if (ctx.mode === 'full' && api.complete) {
    // Ověření konce: HTML stránka, kde API skončilo. Má-li „Další“, API vrátilo jen část výpisu → pokračovat HTML.
    const start = Math.max(0, Math.floor((api.positions - 1) / HTML_PAGE_SIZE) * HTML_PAGE_SIZE);
    html = await scanHtml(ctx, cat, run, start, { verify: true, apiEndedShort: !!api.endedShort, pagesUsed: api.pages });
    complete = html.complete;
  }
  // Pojistky proti „úplnému“ průchodu, který ve skutečnosti úplný není (pipeline by pak označila živé inzeráty jako
  // zmizelé): kategorie s koly není nikdy prázdná a počet viděných inzerátů musí odpovídat počtu na webu.
  const seenCat = run.seen.size - seenBefore;
  if (ctx.mode === 'full' && complete) {
    if (!seenCat) {
      ctx.log?.warn?.(`Bazoš ${cat.label}: průchod nenašel žádný inzerát – beru jako neúplný`);
      complete = false;
    } else if (html?.total && seenCat < html.total * MIN_SEEN_RATIO) {
      ctx.log?.warn?.(`Bazoš ${cat.label}: viděno jen ${seenCat} z ${html.total} inzerátů, které uvádí web – beru jako neúplný průchod`);
      complete = false;
    }
  }
  ctx.log?.info?.(`Bazoš ${cat.label}: ${run.emitted - before} inzerátů`, {
    apiPages: api.pages,
    htmlPages: html ? html.pages : 0,
    complete: ctx.mode === 'full' ? complete : undefined,
  });
  return { complete };
}

/**
 * Projde výpisy všech kategorií s koly. Při blokaci končí hned; chyba jedné kategorie nezastaví ostatní,
 * ale na konci se nahlásí (pipeline pak průchod nebere jako úplný).
 * @param {object} ctx kontext pipeline (http, log, mode, maxPages, minPrice, isKnown, emit, signal)
 * @returns {Promise<{complete: boolean}>}
 */
async function scan(ctx) {
  const run = { seen: new Set(), emitted: 0, belowMin: 0 };
  let complete = ctx.mode === 'full';
  const errors = [];
  for (const cat of CATEGORIES) {
    throwIfAborted(ctx);
    try {
      const r = await scanCategory(ctx, cat, run);
      if (!r.complete) complete = false;
    } catch (e) {
      if (isBlocked(e) || ctx.signal?.aborted) throw e;
      complete = false;
      errors.push(`${cat.label}: ${e.message}`);
      ctx.log?.warn?.(`Bazoš ${cat.label}: výpis selhal`, { error: e.message });
    }
  }
  if (run.belowMin) ctx.log?.debug?.(`Bazoš: ${run.belowMin} inzerátů pod minimální cenou ${ctx.minPrice} Kč přeskočeno`);
  if (errors.length) throw new Error(`Bazoš: výpis části kategorií selhal (${run.emitted} inzerátů uloženo) – ${errors.join('; ')}`);
  return { complete };
}

/** Stáhne detail z API → {gone: true} | {gone: false, item, categoryId}. */
async function fetchDetail(ctx, id) {
  const url = apiDetailUrl(id);
  const res = await fetchText(ctx, url, { okStatuses: [410], accept: 'application/json' });
  if (res.status === 410) {
    // 410 Gone = smazaný inzerát (tělo {"idad":"…","status":"deleted"}); captcha by měla jiné tělo.
    if (!/deleted/i.test(res.text) && BLOCK_RX.test(res.text)) throw markBlocked(ctx, 'captcha / ověření místo dat', url);
    return { gone: true };
  }
  return parseApiDetail(parseApiJson(ctx, res.text, url), id);
}

/**
 * Detail inzerátu: plný popis, PSČ, souřadnice, fotka v plné velikosti, počet fotek, typ prodejce.
 * @returns {Promise<object|null>} null = inzerát už neexistuje
 */
async function detail(ctx, listing) {
  const id = idOf(listing);
  if (!id) throw new Error(`Bazoš: nelze zjistit ID inzerátu (${listing?.url || '?'})`);
  const r = await fetchDetail(ctx, id);
  return r.gone ? null : r.item;
}

/**
 * Ověří, zda inzerát chybějící v celém průchodu opravdu zmizel.
 * @returns {Promise<boolean|null>} true = smazán, false = existuje v kategorii s koly, null = nevím / přesunut jinam
 */
async function confirmGone(ctx, listing) {
  const id = idOf(listing);
  if (!id) return null;
  try {
    const r = await fetchDetail(ctx, id);
    if (r.gone) return true;
    // Přesunutý do jiné kategorie (součástky …) – nechat pipeline rozhodnout podle dalšího průchodu.
    if (r.categoryId && !CAT_BY_ID.has(r.categoryId)) return null;
    return false;
  } catch (e) {
    if (isBlocked(e)) throw e;
    ctx.log?.debug?.('Bazoš: ověření zmizení selhalo', { id, error: e.message });
    return null;
  }
}

module.exports = {
  key: 'bazos',
  label: 'Bazoš',
  homepage: 'https://www.bazos.cz',
  requiresBrowser: false,
  scan,
  detail,
  confirmGone,
  // pro testy a ladění
  CATEGORIES,
  BazosBlockedError,
  apiListUrl,
  apiDetailUrl,
  htmlListUrl,
  parseApiList,
  parseApiDetail,
  parseListHtml,
  parsePrice,
  pragueLocalToIso,
  fullPhotoUrl,
  sellerTypeOf,
};
