'use strict';
// Cyklobazar (cyklobazar.cz) – inzeráty jízdních kol a elektrokol.
//
// ZDROJ NA VYŽÁDÁNÍ – není v DEFAULT_SOURCES (src/config.js), zapíná se KOLOMAPA_SOURCES=…,cyklobazar. Proč:
//   - web chrání Cloudflare s řízením botů; obyčejný HTTP klient dostane vždy 403 „cf-mitigated: challenge“, takže
//     zdroj potřebuje skutečný prohlížeč (volitelná závislost playwright, src/sources/browser.js),
//   - už pár rychlých požadavků vede k ověření „Potvrďte, že jste člověk“, proto zdroj jde záměrně velmi pomalu
//     (stránka za 20 s) a při jakémkoli ověření se na 12 h zastaví – zda ho takto provozovat, je rozhodnutí
//     provozovatele (podmínky webu, zátěž), ne výchozí chování.
//
// Zásady (nevyjednatelné):
//  - Ochranu Cloudflare NEOBCHÁZÍME: obyčejný Playwright Chromium bez „stealth“ úprav (viz browser.js), žádné řešení
//    CAPTCHA/Turnstile, žádné přenášení cookies, žádné střídání proxy. Když Cloudflare požádá o ověření (HTTP 403 +
//    cf-mitigated: challenge, „Just a moment…“ / „Okamžik…“ / „Potvrďte, že jste člověk“) nebo vrátí 403/429, zdroj
//    pro běh hned skončí a uloží do ctx.cache pauzu COOLDOWN_HOURS (12 h). Do té doby scan() jen zaloguje
//    „Cyklobazar: pauza po ověření Cloudflare do …“ a detail() na web nesáhne.
//  - robots.txt: nikdy sort=, ?do= (telefon, sdílení, AI souhrn), condition=new, type=buy|sell, /tisk, email-protection,
//    /sign/, /lost-password/, /muj-ucet/, /create/, changes?event= – hlídá assertAllowed() před KAŽDÝM požadavkem.
//    Navíc nikdy profily prodejců (/u/…).
//  - Osobní údaje: jméno prodejce, odkaz na profil, ID prodejce ani telefon se nečtou ani neukládají – jen příznak
//    firma (štítek „Profi“) × soukromník.
//  - Pauza mezi stránkami config.cyklobazarDelayMs (výchozí 20 s, nikdy pod 10 s), stránek výpisu nejvýš
//    config.cyklobazarMaxListPages za běh (výchozí 60 ≈ 20 min), detailů defaultMaxDetails = 120 (≈ 40 min).
//
// Web (ověřeno 2. 10. 2026; Nette, server-side HTML, žádné API ani RSS):
//   sitemap  /sitemap/sitemap-ads.xml – VŠECHNY aktivní inzeráty webu (~15 800 ze všech kategorií, bez kategorie)
//            s <lastmod> = „Editováno“; přegeneruje se po hodině (nový inzerát v ní může ~1 h chybět).
//   výpis    /kola (~7 600) a /elektrokola (~1 300), ?vp-page=N, 20 inzerátů na stránku, výchozí řazení podle
//            „Aktualizace pozice“ – topování posouvá staré inzeráty nahoru, takže datum vložení ve výpisu NENÍ
//            monotónní. U položky: „Vytvořeno 1. 10. 2026, 13:46“ (title) a relativní čas posunu („před 5 hodinami“).
//            TOP karusely (cb-offer--compact) se opakují na každé stránce → přeskakují se; topované položky v toku
//            výpisu (cb-offer--is-pinned) se berou, ale o konci průchodu nerozhodují.
//   detail   /inzerat/<hashid>/<slug> (vždy celá adresa se slugem) – JSON-LD Product (plný popis, cena, měna),
//            JSON-LD BreadcrumbList (kategorie), tabulka parametrů, Vloženo/Editováno, obec + okres, galerie
//            (atribut photos). Web neuvádí PSČ, souřadnice ani počet zobrazení.
//   fotky    /uploads/items/R/M/D/<číslo>/<velikost>_<soubor>, velikosti 250/500/800/1680 – načtou se bez cookies.
//
// Průchod (scan):
//   1. Sitemapa (1 požadavek). „Zdravá“ = > 5 000 inzerátů a ne výrazně méně než minule → každý známý inzerát v ní
//      dostane ctx.markSeen (je stále aktivní; refreshDetail, když lastmod > čas našeho detailu). Zmizelé pak
//      označí pipeline + confirmGone() čistě podle sitemapy tohoto běhu (bez dalších požadavků).
//   2. Novinky: /kola a /elektrokola od 1. stránky, dokud není celá stránka (bez topovaných) za „obzorem“ = začátek
//      minulého průchodu novinek − 1 h. Rozhoduje relativní čas posunu („před 5 hodinami“, „včera“ …) jako rozpětí:
//      položka posunutá určitě před obzorem, nebo možná před ním a už známá (hrubé „včera“ = 24–48 h viděl minulý
//      denní běh). Když čas posunu nejde přečíst nebo obzor chybí, platí záloha podle zadání: všechny ne-topované
//      položky stránky jsou známé a vložené dřív než nejnovější známé vložení − 1 den. Jinak do ctx.maxPages /
//      limitu stránek (a obzor se i tak posune – zbytek dožene bod 3).
//   3. Jen v režimu full: zbytek limitu stránek projde výpis dál od uložené pozice (ctx.cache „sweep“) – celý výpis
//      (~445 stránek ≈ 2,5 h) se tak projde postupně během ~1–2 týdnů a pak znovu od začátku. Najde staré inzeráty,
//      které ještě neznáme (první plnění), a obnoví ceny. Rychlejší první plnění: vyšší
//      KOLOMAPA_CYKLOBAZAR_MAX_LIST_PAGES.
//   complete = režim full + zdravá sitemapa + žádná chyba ani ověření.

const { decodeEntities, htmlToText, parseCzk } = require('../util/text');

const BASE = 'https://www.cyklobazar.cz';
const SITEMAP_URL = `${BASE}/sitemap/sitemap-ads.xml`;
/** Kořenové kategorie s koly (breadcrumb slug → štítek). Ostatní kořeny (komponenty, oblečení …) nejsou kola. */
const CATEGORIES = [
  { key: 'kola', label: 'Jízdní kola', path: '/kola' },
  { key: 'elektrokola', label: 'Elektrokola', path: '/elektrokola' },
];
const BIKE_ROOTS = new Set(CATEGORIES.map((c) => c.key));

const DEFAULT_DELAY_MS = 20000;
const MIN_DELAY_MS = 10000;
const DEFAULT_MAX_LIST_PAGES = 60;
const HARD_MAX_PAGES = 1000;
const COOLDOWN_HOURS = 12;
const COOLDOWN_KEY = 'cooldownUntil';
/** Sitemapa s méně inzeráty není zdravá (celý web jich má ~15 800). */
const MIN_SITEMAP_URLS = 5000;
/** … ani když má výrazně méně inzerátů než minulá zdravá sitemapa. */
const MIN_SITEMAP_RATIO = 0.7;
/** Inzerát chybějící ve zdravé sitemapě je smazaný, jen když ho známe déle (sitemapa se generuje po hodině). */
const GONE_GRACE_MS = 2 * 3600e3;
/** Rezerva obzoru novinek (posun hodin u nás a na webu, zpoždění webu). */
const HORIZON_BUFFER_MS = 3600e3;
const DAY_MS = 86400e3;
/** Po tolika chybách webu po sobě (síť, HTTP 5xx) zdroj pro běh skončí – nezatěžovat web, který má potíže. */
const MAX_CONSECUTIVE_FAILURES = 3;

// ---------------------------------------------------------------- robots.txt a osobní údaje

// Podle https://www.cyklobazar.cz/robots.txt (2. 10. 2026) + profily prodejců (/u/) navíc.
const DISALLOWED_RX = [/sort=/i, /[?&]do=/i, /condition=new/i, /type=buy/i, /type=sell/i, /\/tisk/i, /email-protection/i, /changes\?event=/i];
const DISALLOWED_PATHS = ['/sign/', '/lost-password/', '/muj-ucet/', '/create/', '/u/'];

/**
 * Smí zdroj tuto adresu stáhnout? Jen https://www.cyklobazar.cz a nic, co zakazuje robots.txt (nebo vede k osobním
 * údajům). Jinak vyhodí chybu – požadavek se vůbec neodešle.
 * @param {string} url
 */
function assertAllowed(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Cyklobazar: neplatná adresa „${url}“`);
  }
  if (u.origin !== BASE) throw new Error(`Cyklobazar: adresa mimo ${BASE} (${url})`);
  const pq = u.pathname + u.search;
  if (DISALLOWED_RX.some((rx) => rx.test(pq)) || DISALLOWED_PATHS.some((p) => u.pathname.startsWith(p))) {
    throw new Error(`Cyklobazar: ${pq} zakazuje robots.txt (nebo vede k osobním údajům) – nestahuji`);
  }
  return u.href;
}

// ---------------------------------------------------------------- stav běhu, pauza po ověření

/** Cloudflare požádal o ověření / zablokoval – zdroj pro běh končí a má pauzu. */
class CyklobazarChallengeError extends Error {
  constructor(message, { url, status, until } = {}) {
    super(message);
    this.name = 'CyklobazarChallengeError';
    this.challenge = true;
    this.fatal = true;
    this.url = url;
    this.status = status;
    this.until = until;
  }
}

const states = new WeakMap(); // ctx → stav běhu

function stateOf(ctx) {
  let st = states.get(ctx);
  if (!st) {
    st = { sitemap: null, sitemapOk: false, sitemapAtMs: 0, stopped: null, browser: null, browserError: null, requests: 0, failures: 0, seen: new Set() };
    states.set(ctx, st);
  }
  return st;
}

const nowMs = (ctx) => (typeof ctx?.now === 'function' ? Number(ctx.now()) : Date.now());

function throwIfAborted(ctx) {
  if (ctx.signal?.aborted) throw ctx.signal.reason || new Error('Přerušeno');
}

const PRAGUE_FMT = new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** „2. 10. 2026 23:15“ (pražský čas) pro hlášky. */
function fmtPrague(ms) {
  try {
    return PRAGUE_FMT.format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

function cacheGet(ctx, key) {
  try {
    return ctx.cache?.get?.(key);
  } catch {
    return undefined;
  }
}

function cacheSet(ctx, key, value) {
  try {
    ctx.cache?.set?.(key, value);
  } catch (e) {
    ctx.log?.debug?.('Cyklobazar: zápis do cache selhal', { key, error: e.message });
  }
}

/** Konec pauzy po ověření (ms), nebo null když pauza neplatí. */
function cooldownUntil(ctx) {
  const v = cacheGet(ctx, COOLDOWN_KEY);
  const t = v ? Date.parse(String(v)) : NaN;
  return Number.isFinite(t) && t > nowMs(ctx) ? t : null;
}

function pauseError(until) {
  return new CyklobazarChallengeError(`Cyklobazar: pauza po ověření Cloudflare do ${fmtPrague(until)} – na web teď nejdu`, { until: new Date(until).toISOString() });
}

/** Ověření / blokace: uložit pauzu, zastavit zdroj pro zbytek běhu. */
function stopForChallenge(ctx, st, url, r) {
  if (st.stopped) return st.stopped;
  const until = nowMs(ctx) + COOLDOWN_HOURS * 3600e3;
  cacheSet(ctx, COOLDOWN_KEY, new Date(until).toISOString());
  const why = r.status === 429 ? 'web hlásí příliš mnoho požadavků (HTTP 429)' : `Cloudflare žádá ověření „jste člověk?“ (HTTP ${r.status || 403}${r.cfMitigated ? `, cf-mitigated: ${r.cfMitigated}` : ''})`;
  st.stopped = new CyklobazarChallengeError(`Cyklobazar: ${why} – ověření neobcházíme, zdroj končí a má pauzu do ${fmtPrague(until)}`, {
    url,
    status: r.status,
    until: new Date(until).toISOString(),
  });
  ctx.log?.warn?.(st.stopped.message, { url, status: r.status });
  return st.stopped;
}

const delayOf = (ctx) => Math.max(MIN_DELAY_MS, Number(ctx.config?.cyklobazarDelayMs) || DEFAULT_DELAY_MS);

function maxListPagesOf(ctx) {
  const v = ctx.config?.cyklobazarMaxListPages;
  return Number.isInteger(v) && v >= 0 ? v : DEFAULT_MAX_LIST_PAGES;
}

async function browserOf(ctx, st) {
  if (st.browser) return st.browser;
  if (st.browserError) throw st.browserError;
  try {
    if (typeof ctx.getBrowser !== 'function') {
      throw new Error('Cyklobazar potřebuje prohlížeč, ale běh ho nenabízí (ctx.getBrowser) – v adresáři kolomapa spusťte npm install a npx playwright install chromium');
    }
    st.browser = await ctx.getBrowser();
    if (!st.browser || typeof st.browser.fetchHtml !== 'function') throw new Error('Cyklobazar: prohlížeč neumí fetchHtml()');
  } catch (e) {
    e.fatal = true;
    st.browserError = e;
    throw e;
  }
  return st.browser;
}

/**
 * Stáhne stránku webu přes sdílený prohlížeč: kontrola robots.txt, pauza, ověření → stop + pauza.
 * @returns {Promise<{status: number, html: string, url: string}>}
 */
async function fetchPage(ctx, st, url, { referer } = {}) {
  const href = assertAllowed(url);
  if (st.stopped) throw st.stopped;
  throwIfAborted(ctx);
  const until = cooldownUntil(ctx);
  if (until) throw (st.stopped = pauseError(until));
  const browser = await browserOf(ctx, st);
  st.requests++;
  let r;
  try {
    r = (await browser.fetchHtml(href, { referer, minIntervalMs: delayOf(ctx), signal: ctx.signal })) || {};
  } catch (e) {
    if (!ctx.signal?.aborted) noteFailure(ctx, st, e.message);
    throw e;
  }
  if (r.challenged || r.status === 403 || r.status === 429) throw stopForChallenge(ctx, st, href, r);
  if (Number(r.status) >= 500 || !Number(r.status)) noteFailure(ctx, st, `HTTP ${r.status || '?'}`);
  else st.failures = 0;
  return { status: Number(r.status) || 0, html: String(r.html ?? ''), url: r.url || href };
}

/** Chyba webu (síť, 5xx): po MAX_CONSECUTIVE_FAILURES po sobě zdroj pro tento běh skončí (bez pauzy). */
function noteFailure(ctx, st, why) {
  st.failures++;
  if (st.failures >= MAX_CONSECUTIVE_FAILURES && !st.stopped) {
    st.stopped = Object.assign(new Error(`Cyklobazar: web ${st.failures}× po sobě neodpověděl (${why}) – pro tento běh končím`), { fatal: true });
    ctx.log?.warn?.(st.stopped.message);
  }
}

// ---------------------------------------------------------------- pomocníci

/** Text bez značek a s jednou mezerou. */
function clean(s) {
  return htmlToText(String(s ?? ''))
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

/** Popis (prostý text z JSON-LD s \n): sjednotit konce řádků a mezery. */
function cleanDescription(s) {
  return decodeEntities(String(s ?? ''))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? '') : null;
}

const ID_RX = /^[A-Za-z0-9]{6,20}$/;

/** Hashid inzerátu z adresy /inzerat/<id>/… */
function idFromUrl(u) {
  const m = /\/inzerat\/([A-Za-z0-9]{6,20})(?:[/?#]|$)/.exec(String(u ?? ''));
  return m ? m[1] : null;
}

function idOf(listing) {
  const s = String(listing?.source_id ?? listing?.sourceId ?? '').trim();
  return ID_RX.test(s) ? s : idFromUrl(listing?.url);
}

/** Celá adresa inzerátu (se slugem) z relativní / absolutní adresy webu; jinak null. */
function adUrl(href) {
  try {
    const u = new URL(decodeEntities(String(href ?? '')), BASE);
    if (u.origin !== BASE || !/^\/inzerat\/[A-Za-z0-9]{6,20}\/[^/?#\s]+$/.test(u.pathname)) return null;
    return `${BASE}${u.pathname}`;
  } catch {
    return null;
  }
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
 * Pražský místní čas z textu webu („Vytvořeno 1. 10. 2026, 13:46“, „2.10.2026, 15:31“) → ISO v UTC.
 * @param {string} s
 * @returns {string|null}
 */
function pragueToIso(s) {
  const m = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})(?:,?\s*(\d{1,2}):(\d{2}))?/.exec(String(s ?? ''));
  if (!m) return null;
  const [d, mo, y, h, mi] = [+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0)];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const local = Date.UTC(y, mo - 1, d, h, mi);
  let utc = local - 2 * 3600e3;
  if (!isPragueDst(utc)) utc = local - 3600e3;
  return new Date(utc).toISOString();
}

/**
 * Relativní čas posunu ve výpisu → rozpětí stáří v hodinách {low, high} (neznámý text → null).
 * Web používá klasický pomocník Nette „timeAgoInWords“ (ověřeno na vzorcích: minuty do 44, „před hodinou“,
 * hodiny do 23–24, pak „včera“ = 24–48 h, „před N dny“ = zaokrouhlené dny od 48 h …); meze jsou o kus širší
 * (zaokrouhlení, posun hodin), aby průchod skončil spíš o stránku později než dřív.
 * @param {string} s „před 5 hodinami“, „včera“, „před 3 dny“ …
 * @returns {{low: number, high: number}|null}
 */
function ageRange(s) {
  const t = String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  const r = (low, high) => ({ low: Math.max(0, low), high });
  let m;
  if (/právě|teď|chvíl|okamžik/.test(t)) return r(0, 0.1);
  if (/před minutou/.test(t)) return r(0, 0.1);
  if ((m = /před (\d+) minut/.exec(t))) return r((Number(m[1]) - 1) / 60, (Number(m[1]) + 1) / 60);
  if (/před hodinou/.test(t)) return r(0.5, 1.6);
  if ((m = /před (\d+) hodin/.exec(t))) return r(Number(m[1]) - 1, Number(m[1]) + 1);
  if (/včera/.test(t)) return r(23, 49);
  if ((m = /před (\d+) dn/.exec(t))) return r(Math.max(47, (Number(m[1]) - 0.5) * 24 - 1), (Number(m[1]) + 0.5) * 24 + 1);
  if (/před týdnem/.test(t)) return r(6 * 24, 14 * 24);
  if ((m = /před (\d+) týdn/.exec(t))) return r((Number(m[1]) - 1) * 7 * 24, (Number(m[1]) + 1) * 7 * 24);
  if (/před měsícem/.test(t)) return r(29 * 24, 61 * 24);
  if ((m = /před (\d+) měsíc/.exec(t))) return r(Math.max(59, (Number(m[1]) - 0.5) * 30 - 1) * 24, ((Number(m[1]) + 0.5) * 30 + 1) * 24);
  if (/před rokem/.test(t)) return r(364 * 24, 732 * 24);
  if ((m = /před (\d+) (let|rok)/.exec(t))) return r(((Number(m[1]) - 0.5) * 365.25 - 1) * 24, ((Number(m[1]) + 0.5) * 365.25 + 1) * 24);
  return null;
}

/** Dolní odhad stáří (h) z relativního času posunu, nebo null. */
const ageLowHours = (s) => ageRange(s)?.low ?? null;

/**
 * Cena z textu webu: „54 999 Kč“ → 54999; jiná měna („1 200 €“) → null + „Cena v EUR: 1 200 €“; bez čísla
 * („Dohodou“) → null + text.
 * @param {string} text
 * @param {string|null} [currency] měna z JSON-LD (přednost)
 * @param {number|string|null} [amount] částka z JSON-LD
 * @returns {{priceCzk: number|null, priceNote: string|null}}
 */
function parsePrice(text, currency = null, amount = null) {
  const t = clean(text);
  const cur = String(currency || (/kč|czk/i.test(t) ? 'CZK' : /€|eur/i.test(t) ? 'EUR' : /zł|pln/i.test(t) ? 'PLN' : /\$|usd/i.test(t) ? 'USD' : '') || '').toUpperCase();
  const num = amount != null && String(amount).trim() !== '' && Number.isFinite(Number(amount)) ? Math.round(Number(amount)) : parseCzk(t);
  if (cur && cur !== 'CZK') {
    const shown = t || (num != null ? `${String(num).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ${cur}` : cur);
    return { priceCzk: null, priceNote: `Cena v ${cur}: ${shown}` };
  }
  if (num != null && num > 0) return { priceCzk: num, priceNote: null };
  if (num === 0 || /^0\s*(kč)?$/i.test(t)) return { priceCzk: null, priceNote: 'Cena neuvedena' };
  return { priceCzk: null, priceNote: t || null };
}

/** Fotka v 800 px: /uploads/items/R/M/D/<číslo>/250_soubor.jpg → https://www.cyklobazar.cz/…/800_soubor.jpg */
function photo800(u) {
  const s = decodeEntities(String(u ?? '')).trim();
  const m = /(\/uploads\/items\/\d{4}\/\d{1,2}\/\d{1,2}\/\d+\/)(?:(?:250|500|800|1680)_)?([^/?#\s]+\.(?:jpe?g|png|webp|avif))(?:[?#].*)?$/i.exec(s);
  return m ? `${BASE}${m[1]}800_${m[2]}` : null;
}

// ---------------------------------------------------------------- výpis

const tagText = (inner, cls) => {
  const m = new RegExp(`<span class="[^"]*\\b${cls}\\b[^"]*">([\\s\\S]*?)</span>`).exec(inner);
  return m ? clean(m[1]) : '';
};

/**
 * Položka výpisu (vnitřek <a class="cb-offer">) → {item, pinned, age: {low, high}|null, ageText}. Štítek prodejce
 * (cb-offer__tag-user) se čte jen jako příznak „--profi“, jméno nikdy.
 */
function parseListItem(href, inner, pinned, rootLabel) {
  const url = adUrl(href);
  const sourceId = idFromUrl(url);
  const title = clean((/<h4[^>]*>([\s\S]*?)<\/h4>/.exec(inner) || [])[1]);
  if (!url || !sourceId || !title) return null;
  const timeTag = /<small\s[^>]*class="cb-time-ago"[^>]*>([\s\S]*?)<\/small>/.exec(inner);
  const created = timeTag ? attr(timeTag[0].slice(0, timeTag[0].indexOf('>') + 1), 'title') : null;
  const ageText = timeTag ? clean(timeTag[1]) : '';
  let sub = clean((/<span class="cb-tag cb-tag--small hidden">([\s\S]*?)<\/span>/.exec(inner) || [])[1]);
  // Dětská kola mají ve výpisu jen „125-155 cm / 12 let“ (detail: „Dětská kola 24\" / 125-155 cm / …“).
  if (/^\d{2,3}\s*-\s*\d{2,3}\s*cm\b/.test(sub)) sub = `Dětská kola ${sub}`;
  const location = tagText(inner, 'cb-offer__tag-location') || tagText(inner, 'cb-offer__vertical-location');
  const brand = tagText(inner, 'cb-offer__tag-brand');
  const desc = clean((/<div class="cb-offer__desc[^"]*">([\s\S]*?)<\/div>/.exec(inner) || [])[1]);
  const img = (/<img\s[^>]*src="([^"]*\/uploads\/items\/[^"]+)"/.exec(inner) || [])[1];
  const item = {
    sourceId,
    url,
    title,
    ...parsePrice((/<strong class="cb-offer__price">([\s\S]*?)<\/strong>/.exec(inner) || [])[1]),
    categorySrc: sub ? `${rootLabel} › ${sub}` : rootLabel,
    locationText: location || undefined,
    sellerType: /cb-offer__tag-user--profi/.test(inner) ? 'company' : 'private',
    detailComplete: false,
  };
  const postedAt = pragueToIso(created);
  if (postedAt) item.postedAt = postedAt;
  if (desc) item.description = desc;
  if (brand) item.params = { Výrobce: brand };
  const photo = photo800(img);
  if (photo) item.photoUrl = photo;
  else if (/class="cb-offer__photo">\s*<picture>\s*<\/picture>/.test(inner)) item.photoCount = 0; // inzerát bez fotek
  return { item, pinned, ageText, age: ageRange(ageText) };
}

/**
 * Stránka výpisu (/kola?vp-page=N) → {ok, items: [{item, pinned, age, ageText}], total, page, lastPage, hasNext}.
 * Přeskakuje TOP karusely (cb-offer--compact / --vertical) a reklamy (cb-offer--ad).
 * @param {string} html
 * @param {{label: string}} [cat] kořenová kategorie (štítek do categorySrc)
 */
function parseListPage(html, cat = CATEGORIES[0]) {
  const s = String(html ?? '');
  const items = [];
  const ids = new Set();
  for (const m of s.matchAll(/<a\s([^>]*)>([\s\S]*?)<\/a>/g)) {
    const href = attr(m[1], 'href');
    if (!href || !/^(https:\/\/www\.cyklobazar\.cz)?\/inzerat\//.test(href)) continue;
    const cls = ` ${attr(m[1], 'class') || ''} `;
    if (!/ cb-offer /.test(cls) || /cb-offer--(compact|vertical|ad)\b/.test(cls)) continue;
    const it = parseListItem(href, m[2], /cb-offer--is-pinned\b/.test(cls), cat.label);
    if (!it || ids.has(it.item.sourceId)) continue;
    ids.add(it.item.sourceId);
    items.push(it);
  }
  const totalM = /Nalezeno inzerátů:\s*([\d\s\u00a0]+)/.exec(s);
  const pag = (/<div id="snippet-vp-paginator">([\s\S]*?)<\/div>/.exec(s) || [])[1] || '';
  const pages = [...pag.matchAll(/[?&](?:amp;)?vp-page=(\d+)/g)].map((x) => Number(x[1]));
  const cur = (/cb-btn--current">\s*(\d+)\s*</.exec(pag) || [])[1];
  const page = cur ? Number(cur) : pages.length ? null : 1;
  return {
    ok: /class="cb-offer-list"/.test(s) || !!totalM,
    items,
    total: totalM ? Number(totalM[1].replace(/\D/g, '')) : null,
    page,
    lastPage: Math.max(page || 1, ...pages, 1),
    hasNext: /<link href="[^"]*vp-page=\d+[^"]*" rel="next">/.test(s) || /paginator__item--next">\s*<a /.test(pag),
  };
}

// ---------------------------------------------------------------- detail

function jsonLdBlocks(html) {
  const out = [];
  for (const m of String(html).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let j = null;
    try {
      j = JSON.parse(m[1]);
    } catch {
      try {
        // řídicí znaky uvnitř řetězců (neplatný JSON) → mezera
        j = JSON.parse(m[1].replace(/[\u0000-\u001f]+/g, ' '));
      } catch {
        j = null;
      }
    }
    if (Array.isArray(j)) out.push(...j);
    else if (j && typeof j === 'object') out.push(j);
  }
  return out;
}

/** Drobečková navigace → [{name, slug}] bez kořene webu a bez samotného inzerátu. */
function breadcrumbsOf(blocks) {
  const bl = blocks.find((b) => b && b['@type'] === 'BreadcrumbList');
  if (!bl || !Array.isArray(bl.itemListElement)) return [];
  return bl.itemListElement
    .slice()
    .sort((a, b) => (Number(a?.position) || 0) - (Number(b?.position) || 0))
    .map((e) => {
      const id = String(e?.item?.['@id'] ?? e?.item ?? '');
      let slug = null;
      try {
        const u = new URL(id, BASE);
        if (u.origin === BASE) slug = u.pathname.replace(/^\/+|\/+$/g, '');
      } catch {
        /* bez odkazu */
      }
      return { name: clean(e?.name), slug };
    })
    .filter((c) => c.slug && !c.slug.startsWith('inzerat/') && c.name);
}

/** Tabulka parametrů (<tr><th>Popisek:</th><td>…</td></tr>) → {Popisek: hodnota} s přesnými českými popisky. */
function paramsTable(html) {
  const out = {};
  const i = html.indexOf('cb-property-box__table');
  if (i < 0) return out;
  const end = html.indexOf('</table>', i);
  const box = html.slice(i, end > i ? end : i + 20000);
  for (const m of box.matchAll(/<tr>\s*<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g)) {
    const label = clean(m[1]).replace(/\s*:\s*$/, '');
    const value = clean(m[2]);
    if (label && value) out[label] = value;
  }
  return out;
}

/** Patička parametrů: Vloženo / Editováno / „Aktualice pozice“ (sic) → {popisek: text}. */
function footerTimes(html) {
  const out = {};
  const i = html.indexOf('cb-property-box__footer__table');
  if (i < 0) return out;
  const end = html.indexOf('</table>', i);
  for (const m of html.slice(i, end > i ? end : i + 5000).matchAll(/<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g)) {
    const k = clean(m[1]);
    if (k) out[k] = clean(m[2]);
  }
  return out;
}

const GONE_TEXT_RX = /inzer[áa]t\s+(?:byl|je)\s+(?:již\s+|už\s+)?(?:smaz|odstran|prod[áa]n|ukon[čc]|deaktiv|neaktiv)|inzer[áa]t\s+(?:již|už)\s+není\s+(?:aktivní|dostupný|k dispozici)|inzer[áa]t\s+neexistuje/i;

/**
 * Detail inzerátu → {ok, gone, sourceId, item}. Čte JSON-LD Product (popis, cena, měna) a BreadcrumbList (kategorie),
 * tabulku parametrů, Vloženo/Editováno, obec + okres, galerii, štítek „Profi“. Jméno, profil ani telefon prodejce
 * se nečtou.
 * @param {string} html
 */
function parseDetail(html) {
  const s = String(html ?? '');
  const blocks = jsonLdBlocks(s);
  const ld = blocks.find((b) => b && b['@type'] === 'Product') || null;
  const canonical = (/<link rel="canonical" href="([^"]+)"/.exec(s) || [])[1];
  const url = adUrl(canonical);
  const sourceId = idFromUrl(url);
  const h1 = clean((/<div class="offer-detail__header">\s*<h1[^>]*>([\s\S]*?)<\/h1>/.exec(s) || [])[1]);
  const title = clean(ld?.name) || h1;
  if (!sourceId || !title || (!ld && !s.includes('cb-property-box'))) {
    return { ok: false, gone: GONE_TEXT_RX.test(htmlToText(s.slice(0, 400000))), sourceId: sourceId || null, item: null };
  }
  const crumbs = breadcrumbsOf(blocks);
  const params = paramsTable(s);
  const header = (/<div class="offer-detail__header">([\s\S]*?)<\/div>/.exec(s) || [])[1] || '';
  const cond = clean((/class="cb-tag cb-tag--attention"[^>]*>([\s\S]*?)<\/a>/.exec(header) || [])[1]);
  if (cond) params.Stav = cond;
  const times = footerTimes(s);
  if (times['Editováno']) params.Upraveno = times['Editováno'];
  const root = crumbs[0]?.slug || null;
  if (root && !BIKE_ROOTS.has(root)) params['Mimo kategorii kol'] = 'ano';
  if (!params['Výrobce'] && ld?.brand) {
    const b = clean(typeof ld.brand === 'object' ? ld.brand.name : ld.brand);
    if (b) params['Výrobce'] = b;
  }

  // Cena: JSON-LD (částka + měna) má přednost před textem v boxu prodejce.
  const offer = Array.isArray(ld?.offers) ? ld.offers[0] : ld?.offers;
  const priceText = (/<strong class="cb-seller-box__price">([\s\S]*?)<\/strong>/.exec(s) || [])[1] || '';
  const price = offer && offer.price != null ? parsePrice(priceText, offer.priceCurrency || null, offer.price) : parsePrice(priceText);

  // Popis: JSON-LD (plný text); záloha HTML blok „Detailní popis“ (bez AI souhrnu).
  let description = cleanDescription(ld?.description);
  if (!description) {
    const d = (/<div class="offer-detail__desc">([\s\S]*?)<\/div>/.exec(s) || [])[1];
    if (d) description = cleanDescription(htmlToText(d.replace(/<h3[\s\S]*?<\/h3>/, '')));
  }

  // Lokalita: <div class="cb-seller-box__location"><svg/> <a …>Březí</a>, okres Břeclav </div>
  const locHtml = (/<div class="cb-seller-box__location">([\s\S]*?)<\/div>/.exec(s) || [])[1] || '';
  const city = clean((/<a\s[^>]*>([\s\S]*?)<\/a>/.exec(locHtml) || [])[1]) || clean(locHtml).split(',')[0].trim();
  const okres = (/okres\s+(.+)$/i.exec(clean(locHtml)) || [])[1] || null;

  // Fotky: JSON v atributu photos=… u <swipe-gallery>
  let photos = null;
  const galleryTag = (/<swipe-gallery\s[^>]*>/.exec(s) || [])[0] || '';
  const photosAttr = attr(galleryTag, 'photos');
  if (photosAttr) {
    try {
      const arr = JSON.parse(photosAttr);
      if (Array.isArray(arr)) photos = arr.filter((p) => p && typeof p === 'object' && p.path && p.filename);
    } catch {
      photos = null; // neznámý formát galerie – počet fotek neuvádět
    }
  }
  const ldImage = Array.isArray(ld?.image) ? ld.image[0] : typeof ld?.image === 'object' ? ld?.image?.url : ld?.image;
  const photoUrl = (photos?.[0] && photo800(`${photos[0].path}/${photos[0].filename}`)) || photo800(ldImage) || undefined;

  const item = {
    sourceId,
    url,
    title,
    description: description || undefined,
    ...price,
    categorySrc: crumbs.length ? crumbs.map((c) => c.name).join(' › ') : undefined,
    locationText: city || undefined,
    okres: okres ? okres.trim() : undefined,
    photoUrl,
    photoCount: photos ? photos.length : photoUrl || photosAttr ? undefined : 0,
    params,
    sellerType: /cb-seller-box__tag-profi/.test(s) ? 'company' : 'private',
    detailComplete: true,
  };
  const posted = pragueToIso(times['Vloženo']) || pragueToIso(attr((/<div class="cb-time-ago"[^>]*>/.exec(s) || [''])[0], 'title'));
  if (posted) item.postedAt = posted;
  return { ok: true, gone: false, sourceId, item, root };
}

// ---------------------------------------------------------------- sitemap

/**
 * sitemap-ads.xml → {ok, urls, entries: Map(id → {url, lastmodMs})}.
 * @param {string} xml
 */
function parseSitemap(xml) {
  const s = String(xml ?? '');
  const entries = new Map();
  let urls = 0;
  for (const m of s.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    urls++;
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/.exec(m[1]);
    const url = loc ? adUrl(decodeEntities(loc[1])) : null;
    const id = idFromUrl(url);
    if (!id) continue;
    const lm = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/.exec(m[1]);
    const t = lm ? Date.parse(lm[1]) : NaN;
    entries.set(id, { url, lastmodMs: Number.isFinite(t) ? t : null });
  }
  return { ok: /<urlset[\s>]/.test(s), urls, entries };
}

/** Stáhne sitemapu; zdravou uloží do stavu běhu a označí známé inzeráty jako aktivní (ctx.markSeen). */
async function loadSitemap(ctx, st) {
  const r = await fetchPage(ctx, st, SITEMAP_URL, { referer: `${BASE}/` });
  if (r.status !== 200) throw new Error(`Cyklobazar: sitemapa vrátila HTTP ${r.status}`);
  const sm = parseSitemap(r.html);
  st.sitemapAtMs = nowMs(ctx);
  const prev = Number(cacheGet(ctx, 'sitemapCount')) || 0;
  if (!sm.ok || sm.entries.size <= MIN_SITEMAP_URLS || (prev && sm.entries.size < prev * MIN_SITEMAP_RATIO)) {
    ctx.log?.warn?.(
      `Cyklobazar: sitemapa vypadá neúplně (${sm.entries.size} inzerátů${prev ? `, minule ${prev}` : ''}) – mizení inzerátů v tomto běhu nevyhodnocuji`
    );
    return { ok: false, size: sm.entries.size, seen: 0, refresh: 0 };
  }
  st.sitemap = sm.entries;
  st.sitemapOk = true;
  cacheSet(ctx, 'sitemapCount', sm.entries.size);
  let seen = 0;
  let refresh = 0;
  if (typeof ctx.markSeen === 'function' && typeof ctx.isKnown === 'function') {
    for (const [id, e] of sm.entries) {
      const known = ctx.isKnown(id);
      if (!known) continue;
      // Zmizelý (detail vrátil 404) oživit jen, když ho prodejce od té doby upravil – sitemapa může být hodinu stará.
      if (known.gone_at && !(e.lastmodMs && e.lastmodMs > Date.parse(known.gone_at))) continue;
      const refreshDetail = !!(known.detail_at && e.lastmodMs && e.lastmodMs > Date.parse(known.detail_at));
      if (ctx.markSeen(id, { refreshDetail })) {
        seen++;
        if (refreshDetail) refresh++;
      }
    }
  }
  ctx.log?.info?.(`Cyklobazar: sitemapa ${sm.entries.size} inzerátů, z toho ${seen} známých aktivních (${refresh} změněných → nový detail)`);
  return { ok: true, size: sm.entries.size, seen, refresh };
}

// ---------------------------------------------------------------- průchod výpisu

const listUrl = (cat, page) => `${BASE}${cat.path}${page > 1 ? `?vp-page=${page}` : ''}`;

function inCategory(u, cat) {
  try {
    const x = new URL(u);
    return x.origin === BASE && x.pathname === cat.path;
  } catch {
    return false;
  }
}

/** Stáhne a ověří stránku výpisu. {end: true} = za koncem výpisu (404, jiná stránka, přesměrování jinam). */
async function fetchListPage(ctx, st, cat, page) {
  const url = listUrl(cat, page);
  const r = await fetchPage(ctx, st, url, { referer: page > 1 ? listUrl(cat, page - 1) : `${BASE}/` });
  if (r.status === 404 || r.status === 410) return { end: true };
  if (r.status !== 200) throw new Error(`Cyklobazar: výpis ${url} vrátil HTTP ${r.status}`);
  if (!inCategory(r.url, cat)) {
    if (page > 1) return { end: true };
    throw new Error(`Cyklobazar: výpis ${cat.label} přesměrován jinam (${r.url})`);
  }
  const parsed = parseListPage(r.html, cat);
  if (!parsed.ok) throw new Error(`Cyklobazar: stránka výpisu ${url} nemá očekávanou podobu (změna webu?)`);
  // Za koncem výpisu web ukáže jinou stránku (aktuální číslo ≠ požadované) nebo prázdný výpis.
  if (page > 1 && ((parsed.page != null && parsed.page !== page) || !parsed.items.length)) return { end: true };
  if (page === 1 && !parsed.items.length) throw new Error(`Cyklobazar: výpis ${cat.label} je prázdný (změna webu?)`);
  return parsed;
}

/**
 * Předá položky stránky pipeline. Vrací [{item, pinned, age, known}] pro rozhodnutí o konci průchodu.
 * known = inzerát byl v DB už před touto stránkou (nebo je pod minimální cenou a záměrně se přeskočil).
 */
async function emitPage(ctx, st, run, parsed) {
  const out = [];
  const minPrice = Number(ctx.minPrice) || 0;
  for (const e of parsed.items) {
    const it = { ...e.item };
    const known = ctx.isKnown?.(it.sourceId) || null;
    const entry = { item: it, pinned: e.pinned, age: e.age, known: !!known };
    out.push(entry);
    if (!e.pinned && it.postedAt) run.newestPosted = Math.max(run.newestPosted || 0, Date.parse(it.postedAt));
    if (st.seen.has(it.sourceId)) continue; // už předaný v tomto běhu (posun výpisu mezi stránkami)
    st.seen.add(it.sourceId);
    // Pod minimální cenou: nové přeskočit (známé se aktualizují dál – změna ceny, nesmí „zmizet“).
    if (it.priceCzk != null && it.priceCzk < minPrice && !known) {
      run.belowMin++;
      entry.known = true;
      continue;
    }
    // Inzerát s detailem: zkrácený popis a kratší název kategorie z výpisu nepřepisují údaje z detailu.
    if (known && known.detail_at) {
      delete it.description;
      delete it.categorySrc;
    }
    await ctx.emit(it);
    run.emitted++;
  }
  return out;
}

/**
 * Je celá stránka „za obzorem“ (vše už viděl minulý průchod novinek)? Topované položky nerozhodují.
 * 1) Podle času posunu (řazení výpisu): každá položka byla posunutá určitě před obzorem, nebo možná před ním a už
 *    ji známe („včera“ = 24–48 h je hrubé, minulý denní běh ji ale viděl). Neznámá položka s nejistým časem →
 *    pokračovat (mohla přibýt těsně po startu minulého běhu).
 * 2) Záloha, když čas posunu nejde přečíst nebo chybí obzor (podle zadání): všechny položky známé a vložené dřív
 *    než nejnovější známé vložení − 1 den.
 * @param {Array<{item: object, pinned: boolean, age: {low: number, high: number}|null, known: boolean}>} entries
 * @param {{horizonMs: number|null, newestPostedMs: number|null, fetchedAtMs: number}} h
 */
function pageIsStale(entries, h) {
  const rows = entries.filter((e) => !e.pinned);
  if (!rows.length) return false;
  if (h.horizonMs != null && rows.every((e) => e.age)) {
    return rows.every((e) => h.fetchedAtMs - e.age.low * 3600e3 < h.horizonMs || (e.known && h.fetchedAtMs - e.age.high * 3600e3 < h.horizonMs));
  }
  if (h.newestPostedMs != null) {
    return rows.every((e) => e.known && e.item.postedAt && Date.parse(e.item.postedAt) < h.newestPostedMs - DAY_MS);
  }
  return false;
}

/**
 * Novinky: každá kategorie od 1. stránky po obzor. Vrací {done: všechny kategorie došly k obzoru / konci výpisu,
 * pagesByCat: poslední prošlá stránka v kategorii}. done = false jen kvůli limitu stránek – zbytek mezi
 * dosaženou stránkou a starým obzorem pak dožene postupný průchod (jinak by se po delší pauze novinky nikdy
 * nedokončily a průchod by nedostal žádné stránky).
 */
async function walkNew(ctx, st, run, budget) {
  const maxPages = Math.min(Number(ctx.maxPages) > 0 ? Number(ctx.maxPages) : HARD_MAX_PAGES, HARD_MAX_PAGES);
  const horizonIso = cacheGet(ctx, 'newHorizonAt');
  const horizonMs = horizonIso && Number.isFinite(Date.parse(horizonIso)) ? Date.parse(horizonIso) - HORIZON_BUFFER_MS : null;
  const newestIso = cacheGet(ctx, 'newestPostedAt');
  const newestPostedMs = newestIso && Number.isFinite(Date.parse(newestIso)) ? Date.parse(newestIso) : null;
  const pagesByCat = {};
  let done = true;
  for (const cat of CATEGORIES) {
    let catDone = false;
    for (let page = 1; ; page++) {
      throwIfAborted(ctx);
      if (budget.left <= 0 || page > maxPages) break;
      budget.left--;
      run.listPages++;
      const parsed = await fetchListPage(ctx, st, cat, page);
      if (parsed.end) {
        catDone = true;
        break;
      }
      const fetchedAtMs = nowMs(ctx);
      pagesByCat[cat.key] = page;
      const entries = await emitPage(ctx, st, run, parsed);
      ctx.log?.debug?.(`Cyklobazar ${cat.label}: stránka ${page}`, { items: parsed.items.length, lastPage: parsed.lastPage });
      if (page >= parsed.lastPage && !parsed.hasNext) {
        catDone = true;
        break;
      }
      if (pageIsStale(entries, { horizonMs, newestPostedMs, fetchedAtMs })) {
        catDone = true;
        break;
      }
    }
    if (!catDone) done = false;
  }
  return { done, pagesByCat };
}

/** Postupný průchod celého výpisu od uložené pozice (jen režim full). */
async function walkSweep(ctx, st, run, budget, pagesByCat) {
  const maxPages = Math.min(Number(ctx.maxPages) > 0 ? Number(ctx.maxPages) : HARD_MAX_PAGES, HARD_MAX_PAGES);
  const saved = cacheGet(ctx, 'sweep');
  let ci = saved && Number.isInteger(saved.cat) && saved.cat >= 0 && saved.cat < CATEGORIES.length ? saved.cat : 0;
  let page = saved && Number.isInteger(saved.page) && saved.page >= 1 ? saved.page : 1;
  const pagesThisRun = {};
  let wrapped = false;
  while (budget.left > 0 && !wrapped) {
    throwIfAborted(ctx);
    const cat = CATEGORIES[ci];
    // stránky, které právě prošly novinky, znovu nestahovat
    if (pagesByCat[cat.key] && page <= pagesByCat[cat.key]) page = pagesByCat[cat.key] + 1;
    if ((pagesThisRun[cat.key] || 0) >= maxPages) break;
    budget.left--;
    run.listPages++;
    run.sweepPages++;
    pagesThisRun[cat.key] = (pagesThisRun[cat.key] || 0) + 1;
    const parsed = await fetchListPage(ctx, st, cat, page);
    let next = false;
    if (parsed.end) next = true;
    else {
      await emitPage(ctx, st, run, parsed);
      if (page >= parsed.lastPage && !parsed.hasNext) next = true;
      else page++;
    }
    if (next) {
      ci++;
      page = 1;
      if (ci >= CATEGORIES.length) {
        ci = 0;
        wrapped = true;
        cacheSet(ctx, 'sweepDoneAt', new Date(nowMs(ctx)).toISOString());
        ctx.log?.info?.('Cyklobazar: celý výpis prošel, příště průchod začne znovu od začátku');
      }
    }
    cacheSet(ctx, 'sweep', { cat: ci, page });
  }
}

/**
 * Projde sitemapu a výpisy kol a elektrokol (viz hlavička souboru). Při ověření Cloudflare končí hned a nastaví
 * pauzu; během pauzy nedělá nic.
 * @param {object} ctx kontext pipeline (getBrowser, log, config, mode, maxPages, minPrice, cache, isKnown, markSeen,
 *   emit, signal)
 * @returns {Promise<{complete: boolean}>}
 */
async function scan(ctx) {
  const until = cooldownUntil(ctx);
  if (until) {
    ctx.log?.info?.(`Cyklobazar: pauza po ověření Cloudflare do ${fmtPrague(until)}`);
    return { complete: false };
  }
  const st = stateOf(ctx);
  const startedIso = new Date(nowMs(ctx)).toISOString();
  const full = ctx.mode === 'full';
  const run = { emitted: 0, belowMin: 0, listPages: 0, sweepPages: 0, newestPosted: 0 };
  const errors = [];
  const fail = (what, e) => {
    if (e?.fatal || ctx.signal?.aborted) throw e;
    errors.push(`${what}: ${e.message}`);
    ctx.log?.warn?.(`Cyklobazar: ${what} selhal`, { error: e.message });
  };

  try {
    await loadSitemap(ctx, st);
  } catch (e) {
    fail('sitemapa', e);
  }

  const budget = { left: maxListPagesOf(ctx) };
  let pagesByCat = {};
  let listOk = true;
  // Úplně první běh (bez obzoru i pozice průchodu): novinky nemají s čím srovnat – výpis od 1. stránky projde
  // rovnou postupný průchod a obzor se nastaví na začátek tohoto běhu.
  const firstRun = full && !cacheGet(ctx, 'newHorizonAt') && !cacheGet(ctx, 'sweep');
  try {
    if (!firstRun) {
      try {
        const r = await walkNew(ctx, st, run, budget);
        pagesByCat = r.pagesByCat;
        if (!r.done) ctx.log?.info?.('Cyklobazar: novinky nedošly k minulému obzoru (limit stránek) – zbytek dožene postupný průchod');
        cacheSet(ctx, 'newHorizonAt', startedIso);
      } catch (e) {
        listOk = false;
        fail('výpis novinek', e);
      }
    }
    if (full && listOk && budget.left > 0) {
      try {
        await walkSweep(ctx, st, run, budget, pagesByCat);
        if (firstRun) cacheSet(ctx, 'newHorizonAt', startedIso);
      } catch (e) {
        fail('průchod výpisu', e);
      }
    }
  } finally {
    if (run.newestPosted) {
      const prev = Date.parse(cacheGet(ctx, 'newestPostedAt') || '');
      if (!Number.isFinite(prev) || run.newestPosted > prev) cacheSet(ctx, 'newestPostedAt', new Date(run.newestPosted).toISOString());
    }
  }
  if (run.belowMin) ctx.log?.debug?.(`Cyklobazar: ${run.belowMin} nových inzerátů pod minimální cenou ${ctx.minPrice} Kč přeskočeno`);
  ctx.log?.info?.(`Cyklobazar: ${run.emitted} inzerátů z výpisu (${run.listPages} stránek, z toho ${run.sweepPages} postupného průchodu), ${st.requests} požadavků`);
  if (errors.length) throw new Error(`Cyklobazar: část průchodu selhala (${run.emitted} inzerátů uloženo) – ${errors.join('; ')}`);
  return { complete: full && st.sitemapOk };
}

/**
 * Detail inzerátu: plný popis, parametry (přesné české popisky), stav, Vloženo/Editováno, obec + okres, fotka 800 px,
 * počet fotek, typ prodejce. Inzerát mimo kategorie kol vrací params „Mimo kategorii kol“: „ano“ (pro klasifikátor) –
 * null by znamenalo „inzerát zmizel“, a to není pravda.
 * @returns {Promise<object|null>} null = inzerát už neexistuje
 */
async function detail(ctx, listing) {
  const until = cooldownUntil(ctx);
  if (until) throw pauseError(until);
  const st = stateOf(ctx);
  const id = idOf(listing);
  if (!id) throw new Error(`Cyklobazar: nelze zjistit ID inzerátu (${listing?.url || '?'})`);
  const url = adUrl(listing?.url) || st.sitemap?.get(id)?.url || null;
  if (!url || idFromUrl(url) !== id) throw new Error(`Cyklobazar: chybí úplná adresa inzerátu ${id}`);
  const r = await fetchPage(ctx, st, url, { referer: `${BASE}/` });
  if (r.status === 404 || r.status === 410) return null;
  if (r.status !== 200) throw new Error(`Cyklobazar: detail ${url} vrátil HTTP ${r.status}`);
  const d = parseDetail(r.html);
  if (!d.ok) {
    if (d.gone) return null;
    // Přesměrování pryč z inzerátu (výpis / úvod) a inzerát chybí i ve zdravé sitemapě tohoto běhu → smazaný.
    if (idFromUrl(r.url) !== id && st.sitemapOk && st.sitemap && !st.sitemap.has(id)) return null;
    throw new Error(`Cyklobazar: detail ${url} nemá očekávanou podobu (změna webu?)`);
  }
  if (d.sourceId !== id) throw new Error(`Cyklobazar: detail ${id} vrátil jiný inzerát (${d.sourceId})`);
  return d.item;
}

/**
 * Zmizel inzerát? Jen podle sitemapy tohoto běhu (žádný další požadavek na web).
 * @returns {Promise<boolean|null>} true = chybí ve zdravé sitemapě a známe ho > 2 h, false = je v ní, null = nevím
 */
async function confirmGone(ctx, listing) {
  const st = states.get(ctx);
  if (!st || !st.sitemapOk || !st.sitemap) return null;
  const id = idOf(listing);
  if (!id) return null;
  if (st.sitemap.has(id)) return false;
  const first = Date.parse(listing?.first_seen_at ?? listing?.firstSeenAt ?? '');
  if (!Number.isFinite(first)) return null;
  return st.sitemapAtMs - first > GONE_GRACE_MS ? true : null;
}

module.exports = {
  key: 'cyklobazar',
  label: 'Cyklobazar',
  homepage: BASE,
  requiresBrowser: true,
  /** Detailů za běh: 120 × 20 s ≈ 40 min; zbytek se dočte další dny. */
  defaultMaxDetails: 120,
  scan,
  detail,
  confirmGone,
  // pro testy a ladění
  BASE,
  SITEMAP_URL,
  CATEGORIES,
  COOLDOWN_HOURS,
  MIN_SITEMAP_URLS,
  DISALLOWED_PATHS,
  CyklobazarChallengeError,
  assertAllowed,
  listUrl,
  parseListPage,
  parseDetail,
  parseSitemap,
  parsePrice,
  pragueToIso,
  ageLowHours,
  ageRange,
  photo800,
  pageIsStale,
  cooldownUntil,
};
