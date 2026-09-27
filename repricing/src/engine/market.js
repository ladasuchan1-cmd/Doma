'use strict';
// Trh = použitelné nabídky konkurence pro jeden produkt po aplikaci filtru strategie (SPEC §6.2).
// Čistá funkce – žádná databáze.

const { nameKey, fold } = require('../util/keys');
const { round, median, mean } = require('../util/num');

const EPS = 1e-9;
const DAY_MS = 86400000;

/** Výchozí filtr konkurence (strategie `competitors`). */
const DEFAULT_MARKET_FILTER = Object.freeze({
  include: Object.freeze([]),
  exclude: Object.freeze([]),
  include_tags: Object.freeze([]),
  exclude_tags: Object.freeze([]),
  in_stock_only: true,
  include_shipping: false,
  max_age_days: null,
  outlier_pct: null,
  min_competitors: 1,
  exclude_keywords: Object.freeze([]),
  max_delivery_days: null,
});

/** Důvody vyřazení nabídky – české popisky pro UI a vysvětlení. */
const EXCLUDE_REASONS = Object.freeze({
  invalid_price: 'neplatná cena',
  disabled: 'konkurent vypnut',
  excluded: 'konkurent vyloučen strategií',
  not_included: 'konkurent není mezi vybranými',
  tag: 'vyřazen podle štítku',
  keyword: 'vyřazen podle klíčového slova v názvu',
  out_of_stock: 'není skladem',
  stale: 'zastaralá cena',
  outlier: 'podezřele nízká cena (odlehlá hodnota)',
});

const collator = new Intl.Collator('cs');

function toMs(now) {
  if (now == null) return Date.now();
  if (now instanceof Date) return now.getTime();
  const t = typeof now === 'number' ? now : Date.parse(now);
  return Number.isFinite(t) ? t : Date.now();
}

function toList(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(/[,;\n]/);
  return [v];
}

function toBool(v, dflt) {
  if (v == null) return dflt;
  if (typeof v === 'string') return !['0', 'false', 'ne', 'no', ''].includes(v.trim().toLowerCase());
  return Boolean(v);
}

function toNumOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Značka připraveného filtru – takový objekt lze předat do buildMarket opakovaně bez nové přípravy
// (metriky používají stále stejný výchozí filtr). Záměrně necachujeme podle objektu filtru ze
// strategie: volající by ho mohl mezi voláními změnit.
const PREPARED = Symbol('preparedMarketFilter');

/**
 * Doplní výchozí hodnoty filtru konkurence a připraví množiny klíčů pro porovnání.
 * @param {object} [filter]
 */
function prepareFilter(filter) {
  if (filter && filter[PREPARED]) return filter;
  const f = { ...DEFAULT_MARKET_FILTER, ...(filter && typeof filter === 'object' ? filter : {}) };
  const keySet = (list, fn) => new Set(toList(list).map((x) => fn(x)).filter(Boolean));
  const p = {
    include: keySet(f.include, nameKey),
    exclude: keySet(f.exclude, nameKey),
    include_tags: keySet(f.include_tags, fold),
    exclude_tags: keySet(f.exclude_tags, fold),
    keywords: toList(f.exclude_keywords).map((k) => fold(k)).filter(Boolean),
    in_stock_only: toBool(f.in_stock_only, true),
    include_shipping: toBool(f.include_shipping, false),
    max_age_days: toNumOrNull(f.max_age_days),
    outlier_pct: toNumOrNull(f.outlier_pct),
    min_competitors: Math.max(1, Math.floor(toNumOrNull(f.min_competitors) ?? 1)),
    // s in_stock_only: nabídka „není skladem“, která dodá nejvýše do N dní, se počítá jako dostupná (null = vypnuto)
    max_delivery_days: toNumOrNull(f.max_delivery_days),
    [PREPARED]: true,
  };
  return p;
}

// Cache klíčů jmen konkurentů (řetězec → nameKey) – jmen je málo, nabídek statisíce.
const keyCache = new Map();
function cachedNameKey(s) {
  if (s == null || s === '') return null;
  let k = keyCache.get(s);
  if (k === undefined) {
    if (keyCache.size > 20000) keyCache.clear();
    k = nameKey(s);
    keyCache.set(s, k);
  }
  return k;
}

// Cache složených štítků – jen pro zmrazená pole (run.js je sdílí mezi nabídkami jednoho konkurenta).
const tagCache = new WeakMap();
function foldedTags(tags) {
  if (!Array.isArray(tags)) return [];
  if (!Object.isFrozen(tags)) return tags.map((t) => fold(t));
  let f = tagCache.get(tags);
  if (!f) {
    f = tags.map((t) => fold(t));
    tagCache.set(tags, f);
  }
  return f;
}

function offerKeys(offer) {
  const keys = [];
  const a = cachedNameKey(offer.competitor);
  if (a) keys.push(a);
  const b = offer.label ? cachedNameKey(offer.label) : null;
  if (b && b !== a) keys.push(b);
  return keys;
}

/**
 * Doprava pro efektivní cenu. Záporná (chyba feedu) se nepřičítá – snížila by efektivní cenu konkurenta
 * a tím i náš cíl. Číselný řetězec („99“) se převede, aby doprava tiše nevypadla (efektivní cena by byla nižší).
 */
function shippingOf(v) {
  if (v == null || typeof v === 'boolean' || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Dodá nabídka (i když není skladem) do limitu max_delivery_days? */
function deliversInTime(offer, f) {
  if (f.max_delivery_days == null) return false;
  const d = offer.delivery_days;
  if (d == null || d === '' || typeof d === 'boolean') return false;
  const n = typeof d === 'number' ? d : Number(d);
  return Number.isFinite(n) && n >= 0 && n <= f.max_delivery_days + EPS;
}

function exclusionReason(offer, f, cutoff) {
  const price = offer.price;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return 'invalid_price';
  if (offer.enabled === false || offer.enabled === 0) return 'disabled';
  if (f.exclude.size || f.include.size) {
    const keys = offerKeys(offer);
    if (f.exclude.size && keys.some((k) => f.exclude.has(k))) return 'excluded';
    if (f.include.size && !keys.some((k) => f.include.has(k))) return 'not_included';
  }
  if (f.include_tags.size || f.exclude_tags.size) {
    const tags = foldedTags(offer.tags);
    if (f.include_tags.size && !tags.some((t) => f.include_tags.has(t))) return 'tag';
    if (f.exclude_tags.size && tags.some((t) => f.exclude_tags.has(t))) return 'tag';
  }
  if (f.keywords.length && offer.name) {
    const n = fold(offer.name);
    if (f.keywords.some((k) => n.includes(k))) return 'keyword';
  }
  // in_stock null = neznámo → bereme jako skladem (SPEC §6.2). S max_delivery_days se nabídka, která není skladem,
  // ale dodá do limitu (delivery_days ≤ max_delivery_days), počítá jako dostupná (typicky kola „u dodavatele do 3 dnů“).
  if (f.in_stock_only && (offer.in_stock === 0 || offer.in_stock === false) && !deliversInTime(offer, f)) return 'out_of_stock';
  if (cutoff != null && offer.observed_at) {
    const t = Date.parse(offer.observed_at);
    // nečitelné datum = neznámé stáří → konzervativně zastaralé
    if (!Number.isFinite(t) || t < cutoff) return 'stale';
  }
  return null;
}

/**
 * Sestaví trh z nabídek konkurence.
 * @param {Array<object>} offers nabídky dle SPEC §6.1
 * @param {object} [filter] filtr konkurence ze strategie (`config.competitors`)
 * @param {{now?: Date|string, maxAgeDays?: number|null}} [ctx]
 * @returns {{offers: object[], excluded: Array<{offer: object, reason: string}>, count: number, min: number|null,
 *   max: number|null, avg: number|null, median: number|null, cheapest: object|null, prices: number[]}}
 */
function buildMarket(offers, filter, ctx = {}) {
  const f = prepareFilter(filter);
  const nowMs = toMs(ctx.now);
  // max_age_days ze strategie > nastavení; hodnota ≤ 0 nebo null = bez omezení stáří
  const maxAge = f.max_age_days != null ? f.max_age_days : toNumOrNull(ctx.maxAgeDays);
  const cutoff = maxAge != null && maxAge > 0 ? nowMs - maxAge * DAY_MS : null;
  let used = [];
  const excluded = [];
  // použitá kopie → původní objekt nabídky (pro excluded u odlehlých hodnot); jen když je kontrola zapnutá
  const originals = f.outlier_pct != null && f.outlier_pct > 0 ? new Map() : null;
  for (const offer of offers || []) {
    if (!offer) continue;
    const reason = exclusionReason(offer, f, cutoff);
    if (reason) {
      excluded.push({ offer, reason });
      continue;
    }
    const ship = f.include_shipping ? shippingOf(offer.shipping) : 0;
    const u = { ...offer, effective: round(offer.price + ship, 2) };
    if (originals) originals.set(u, offer);
    used.push(u);
  }
  // Odlehlé hodnoty (podezřele nízké ceny, např. chyba v feedu) – jen při ≥ 3 nabídkách
  if (f.outlier_pct != null && f.outlier_pct > 0 && used.length >= 3) {
    const med = median(used.map((o) => o.effective));
    const limit = med * (1 - f.outlier_pct / 100);
    const kept = [];
    for (const o of used) {
      if (o.effective < limit - EPS) excluded.push({ offer: originals.get(o), reason: 'outlier' });
      else kept.push(o);
    }
    used = kept;
  }
  used.sort((a, b) => a.effective - b.effective || collator.compare(String(a.competitor ?? ''), String(b.competitor ?? '')));
  const prices = used.map((o) => o.effective);
  const count = used.length;
  return {
    offers: used,
    excluded,
    count,
    min: count ? prices[0] : null,
    max: count ? prices[count - 1] : null,
    avg: count ? round(mean(prices), 2) : null,
    median: count ? round(median(prices), 2) : null,
    cheapest: count ? used[0] : null,
    prices,
  };
}

/** Pořadí naší ceny: 1 + počet použitých nabídek s nižší efektivní cenou (null bez trhu). */
function rankOf(price, market) {
  if (price == null || !Number.isFinite(price) || !market || !market.count) return null;
  const p = round(price, 2);
  let n = 0;
  for (const x of market.prices) {
    if (x < p - EPS) n += 1;
    else break; // prices jsou seřazené vzestupně
  }
  return n + 1;
}

/** Pozice na trhu: cheapest (≤ min), most_expensive (> max), middle, no_data. */
function positionOf(price, market) {
  if (!market || !market.count || price == null || !Number.isFinite(price)) return 'no_data';
  const p = round(price, 2);
  if (p <= market.min + EPS) return 'cheapest';
  if (p > market.max + EPS) return 'most_expensive';
  return 'middle';
}

/** Najde použitou nabídku konkrétního konkurenta (podle nameKey jména nebo popisku). */
function findCompetitorOffer(market, name) {
  const key = nameKey(name);
  if (!key || !market) return null;
  return market.offers.find((o) => offerKeys(o).includes(key)) || null;
}

module.exports = {
  buildMarket,
  deliversInTime,
  rankOf,
  positionOf,
  findCompetitorOffer,
  prepareFilter,
  DEFAULT_MARKET_FILTER,
  EXCLUDE_REASONS,
};
