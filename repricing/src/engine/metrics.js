'use strict';
// Pohled na produkt (View) = sloupce produktu + odvozené metriky (marže, trh, pozice, sklad) – SPEC §6.3.
// Nad View se vyhodnocují filtry segmentů a podmínky strategií. Čisté funkce – žádná databáze.
// Obsahuje i časové pomocníky (zámek, časové okno strategie v čase Europe/Prague).

const { DEFAULT_SETTINGS, parseJson } = require('../db');
const { round, net, marginPct, markupPct } = require('../util/num');
const { buildMarket, rankOf, positionOf, prepareFilter } = require('./market');

const DAY_MS = 86400000;
const TIME_ZONE = 'Europe/Prague';

// ---------------------------------------------------------------------------------------------
// Čas

function toDate(now) {
  if (now == null) return new Date();
  if (now instanceof Date) return now;
  const d = new Date(now);
  return Number.isFinite(d.getTime()) ? d : new Date();
}

const pragueFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
let lastPartsKey = null;
let lastParts = null;

/**
 * Místní čas v Praze pro daný okamžik.
 * @returns {{year, month, day, weekday: 1..7 (1 = pondělí), hour: 0..23, minute, second}}
 */
function pragueParts(date) {
  const d = toDate(date);
  const key = d.getTime();
  if (key === lastPartsKey) return lastParts; // během běhu je `now` stále stejné
  const out = {};
  for (const p of pragueFmt.formatToParts(d)) {
    if (p.type === 'weekday') out.weekday = WEEKDAYS[p.value];
    else if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0;
  lastPartsKey = key;
  lastParts = out;
  return out;
}

/**
 * Převede datum/čas na ms. ISO s časovou zónou (Z, +02:00) se bere doslova; bez zóny
 * („2026-10-01“, „2026-10-01T18:00“ – typicky z formuláře) jako místní čas Europe/Prague.
 * @returns {number|null}
 */
function parseDateTime(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  const s = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(s);
  if (!m) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  const [y, mo, d, h = 0, mi = 0, se = 0] = m.slice(1).map((x) => (x == null ? 0 : Number(x)));
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, se);
  if (!Number.isFinite(asUtc)) return null;
  // posun Prahy vůči UTC v daném okamžiku (dvě iterace kvůli přechodu letního času)
  let t = asUtc;
  for (let i = 0; i < 2; i++) {
    const p = pragueParts(new Date(t));
    const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    t = asUtc - (localAsUtc - t);
  }
  return t;
}

/**
 * Je časové okno strategie aktivní? (SPEC §6.5 schedule)
 * valid_from včetně, valid_to bez; weekdays 1 = po … 7 = ne (prázdné = všechny);
 * hours [od, do) v místním čase Europe/Prague, např. [18, 24]; od > do = přes půlnoc (např. [22, 6]).
 * @param {{valid_from?, valid_to?, weekdays?: number[], hours?: [number, number]|null}|null} schedule
 * @param {Date|string} now
 */
function scheduleActive(schedule, now) {
  if (!schedule || typeof schedule !== 'object') return true;
  const t = toDate(now).getTime();
  const from = parseDateTime(schedule.valid_from);
  const to = parseDateTime(schedule.valid_to);
  if (from != null && t < from) return false;
  if (to != null && t >= to) return false;
  const weekdays = Array.isArray(schedule.weekdays) ? schedule.weekdays : [];
  const hours = Array.isArray(schedule.hours) && schedule.hours.length === 2 ? schedule.hours : null;
  if (!weekdays.length && !hours) return true;
  const p = pragueParts(new Date(t));
  if (weekdays.length && !weekdays.map(Number).includes(p.weekday)) return false;
  if (hours) {
    const h = p.hour + p.minute / 60 + p.second / 3600;
    const a = Number(hours[0]);
    const b = Number(hours[1]);
    const inside = a < b ? h >= a && h < b : h >= a || h < b;
    if (!inside) return false;
  }
  return true;
}

/** Popis časového okna česky (pro vysvětlení). */
function describeSchedule(schedule) {
  if (!schedule) return 'bez omezení';
  const parts = [];
  const names = ['', 'po', 'út', 'st', 'čt', 'pá', 'so', 'ne'];
  if (schedule.valid_from) parts.push(`od ${schedule.valid_from}`);
  if (schedule.valid_to) parts.push(`do ${schedule.valid_to}`);
  if (Array.isArray(schedule.weekdays) && schedule.weekdays.length) parts.push(`dny ${schedule.weekdays.map((d) => names[d] || d).join(', ')}`);
  if (Array.isArray(schedule.hours) && schedule.hours.length === 2) parts.push(`${schedule.hours[0]}–${schedule.hours[1]} h`);
  return parts.length ? parts.join(', ') : 'bez omezení';
}

/**
 * Efektivní zámek: locked = 1 a (locked_until není vyplněno nebo je v budoucnu).
 * Nečitelné locked_until → konzervativně zamčeno.
 */
function isLockActive(product, now) {
  if (!product || !product.locked || product.locked === '0') return false;
  if (product.locked_until == null || product.locked_until === '') return true;
  const t = parseDateTime(product.locked_until);
  if (t == null) return true;
  return t > toDate(now).getTime();
}

/** Celé dny od poslední změny ceny (null = cena se nikdy neměnila / neznámo). */
function daysSince(iso, now) {
  const t = parseDateTime(iso);
  if (t == null) return null;
  return Math.max(0, Math.floor((toDate(now).getTime() - t) / DAY_MS));
}

// ---------------------------------------------------------------------------------------------
// View

// Výchozí filtr trhu pro metriky: zapnutí konkurenti, čerstvé nabídky, bez dopravy, bez výběru konkurentů.
const METRICS_FILTER_ALL = prepareFilter({ in_stock_only: false });
const METRICS_FILTER_STOCK = prepareFilter({ in_stock_only: true });

const numOrNull = (v) =>
  typeof v === 'number'
    ? Number.isFinite(v) ? v : null
    : v == null || typeof v === 'boolean' || (typeof v === 'string' && v.trim() === '') ? null : Number.isFinite(Number(v)) ? Number(v) : null;
// Kladné číslo (i z číselného řetězce) – stejně jako v pricing.js, aby pohled a cenotvorba viděly stejná data.
const pos = (v) => {
  const n = numOrNull(v);
  return n != null && n > 0 ? n : null;
};

/**
 * Sestaví plochý pohled na produkt.
 * Nákupní cena ≤ 0 se bere jako chybějící (marže nelze spočítat) – stejně jako v cenotvorbě.
 * @param {object} product řádek z tabulky products (attrs jako JSON text nebo objekt)
 * @param {Array<object>} offers nabídky konkurence (SPEC §6.1)
 * @param {{now?: Date|string, settings?: object}} [opts]
 * @returns {object} View
 */
function productView(product, offers, opts = {}) {
  const settings = opts.settings ? { ...DEFAULT_SETTINGS, ...opts.settings } : DEFAULT_SETTINGS;
  const now = toDate(opts.now);
  const attrs = typeof product.attrs === 'string' ? parseJson(product.attrs, {}) || {} : product.attrs && typeof product.attrs === 'object' ? product.attrs : {};
  const v = { ...product, attrs };

  const vat = numOrNull(product.vat_rate) ?? numOrNull(settings.vat_rate_default) ?? 21;
  const price = pos(product.price);
  const purchase = pos(product.purchase_price);
  const msrp = pos(product.msrp);
  const stock = numOrNull(product.stock);
  const sales30 = numOrNull(product.sales_30);

  const filter = settings.metrics_in_stock_only ? METRICS_FILTER_STOCK : METRICS_FILTER_ALL;
  const market = buildMarket(offers, filter, { now, maxAgeDays: settings.offer_max_age_days });

  v.vat = vat;
  v.margin_pct = marginPct(price, purchase, vat);
  v.markup_pct = markupPct(price, purchase, vat);
  v.profit_abs = price != null && purchase != null ? round(net(price, vat) - purchase, 2) : null;
  v.below_cost = price != null && purchase != null ? net(price, vat) < purchase - 1e-9 : false;
  v.stock_value = purchase != null && stock != null ? round(purchase * stock, 2) : null;
  v.has_stock = stock != null && stock > 0;
  v.days_of_cover = stock != null && sales30 != null && sales30 > 0 ? round(stock / (sales30 / 30), 1) : null;

  v.market_count = market.count;
  v.offers_count = market.count + market.excluded.filter((e) => e.reason === 'out_of_stock').length;
  v.offers_instock = market.offers.filter((o) => o.in_stock !== 0 && o.in_stock !== false).length;
  v.market_min = market.min;
  v.market_max = market.max;
  v.market_avg = market.avg;
  v.market_median = market.median;
  v.cheapest_competitor = market.cheapest ? market.cheapest.competitor ?? null : null;
  v.rank = rankOf(price, market);
  v.position = positionOf(price, market);
  v.price_index = price != null && market.min ? round((price / market.min) * 100, 1) : null;
  v.price_index_median = price != null && market.median ? round((price / market.median) * 100, 1) : null;
  v.price_index_avg = price != null && market.avg ? round((price / market.avg) * 100, 1) : null;
  v.gap_min_abs = price != null && market.min != null ? round(price - market.min, 2) : null;
  v.gap_min_pct = price != null && market.min ? round(((price - market.min) / market.min) * 100, 2) : null;
  v.msrp_diff_pct = price != null && msrp != null ? round(((price - msrp) / msrp) * 100, 2) : null;
  // „konkurence prodává pod naším nákupem“ – argument pro vyjednávání s dodavatelem
  v.min_below_cost = market.min != null && purchase != null ? net(market.min, vat) < purchase - 1e-9 : false;
  v.lock_active = isLockActive(product, now);
  v.days_since_change = daysSince(product.price_changed_at, now);
  return v;
}

// ---------------------------------------------------------------------------------------------
// Popis polí pro filtry (UI filter builder, API /fields)

const POSITION_LABELS = Object.freeze({
  cheapest: 'Nejlevnější',
  middle: 'Uprostřed',
  most_expensive: 'Nejdražší',
  no_data: 'Bez dat o trhu',
});

const G_PRODUCT = 'Produkt';
const G_PRICE = 'Ceny a marže';
const G_MARKET = 'Trh';
const G_STOCK = 'Sklad a prodeje';
const G_ATTRS = 'Vlastní atributy';

const f = (key, label, type, group, extra) => Object.freeze({ key, label, type, group, ...(extra || {}) });

/** Filtrovatelná pole (bez dynamických attrs.* – ty přidává API z dat, viz discoverAttrFields). */
const FIELDS = Object.freeze([
  // Produkt
  f('code', 'Kód', 'string', G_PRODUCT),
  f('name', 'Název', 'string', G_PRODUCT),
  f('ean', 'EAN', 'string', G_PRODUCT),
  f('mpn', 'Kód výrobce (MPN)', 'string', G_PRODUCT),
  f('manufacturer', 'Výrobce', 'string', G_PRODUCT),
  f('category', 'Kategorie', 'string', G_PRODUCT),
  f('supplier', 'Dodavatel', 'string', G_PRODUCT),
  f('owner', 'Zodpovědná osoba', 'string', G_PRODUCT),
  f('active', 'Aktivní', 'boolean', G_PRODUCT),
  f('locked', 'Zamčeno (příznak)', 'boolean', G_PRODUCT),
  f('lock_active', 'Zámek platí', 'boolean', G_PRODUCT),
  f('locked_until', 'Zamčeno do', 'string', G_PRODUCT),
  f('note', 'Poznámka', 'string', G_PRODUCT),
  f('id', 'ID produktu', 'number', G_PRODUCT),
  f('created_at', 'Založeno', 'string', G_PRODUCT),
  f('updated_at', 'Aktualizováno', 'string', G_PRODUCT),
  // Ceny a marže
  f('price', 'Prodejní cena s DPH', 'number', G_PRICE, { unit: 'Kč' }),
  f('purchase_price', 'Nákupní cena bez DPH', 'number', G_PRICE, { unit: 'Kč' }),
  f('msrp', 'MOC (doporučená cena)', 'number', G_PRICE, { unit: 'Kč' }),
  f('min_price', 'Minimální cena (ruční)', 'number', G_PRICE, { unit: 'Kč' }),
  f('max_price', 'Maximální cena (ruční)', 'number', G_PRICE, { unit: 'Kč' }),
  f('vat_rate', 'Sazba DPH produktu', 'number', G_PRICE, { unit: '%' }),
  f('vat', 'Sazba DPH (použitá)', 'number', G_PRICE, { unit: '%' }),
  f('margin_pct', 'Marže', 'number', G_PRICE, { unit: '%' }),
  f('markup_pct', 'Přirážka', 'number', G_PRICE, { unit: '%' }),
  f('profit_abs', 'Zisk na kus bez DPH', 'number', G_PRICE, { unit: 'Kč' }),
  f('below_cost', 'Prodáváme pod nákupní cenou', 'boolean', G_PRICE),
  f('msrp_diff_pct', 'Rozdíl proti MOC', 'number', G_PRICE, { unit: '%' }),
  f('price_changed_at', 'Poslední změna ceny', 'string', G_PRICE),
  f('days_since_change', 'Dní od poslední změny ceny', 'number', G_PRICE, { unit: 'dní' }),
  // Trh
  f('market_count', 'Počet konkurentů (trh)', 'number', G_MARKET),
  f('offers_count', 'Počet čerstvých nabídek (i neskladem)', 'number', G_MARKET),
  f('offers_instock', 'Konkurentů skladem', 'number', G_MARKET),
  f('market_min', 'Nejnižší cena trhu', 'number', G_MARKET, { unit: 'Kč' }),
  f('market_max', 'Nejvyšší cena trhu', 'number', G_MARKET, { unit: 'Kč' }),
  f('market_avg', 'Průměrná cena trhu', 'number', G_MARKET, { unit: 'Kč' }),
  f('market_median', 'Medián cen trhu', 'number', G_MARKET, { unit: 'Kč' }),
  f('cheapest_competitor', 'Nejlevnější konkurent', 'string', G_MARKET),
  f('rank', 'Pořadí na trhu (1 = nejlevnější)', 'number', G_MARKET),
  f('position', 'Pozice na trhu', 'enum', G_MARKET, {
    values: Object.freeze(Object.keys(POSITION_LABELS)),
    value_labels: POSITION_LABELS,
    options: Object.freeze(Object.entries(POSITION_LABELS).map(([value, label]) => Object.freeze({ value, label }))),
  }),
  f('price_index', 'Cenový index vůči minimu trhu', 'number', G_MARKET, { unit: '%' }),
  f('price_index_median', 'Cenový index vůči mediánu', 'number', G_MARKET, { unit: '%' }),
  f('price_index_avg', 'Cenový index vůči průměru', 'number', G_MARKET, { unit: '%' }),
  f('gap_min_abs', 'Rozdíl proti minimu trhu', 'number', G_MARKET, { unit: 'Kč' }),
  f('gap_min_pct', 'Rozdíl proti minimu trhu (%)', 'number', G_MARKET, { unit: '%' }),
  f('min_below_cost', 'Konkurence prodává pod naším nákupem', 'boolean', G_MARKET),
  // Sklad a prodeje
  f('stock', 'Skladem (ks)', 'number', G_STOCK, { unit: 'ks' }),
  f('has_stock', 'Je skladem', 'boolean', G_STOCK),
  f('sales_30', 'Prodej za 30 dní (ks)', 'number', G_STOCK, { unit: 'ks' }),
  f('sales_90', 'Prodej za 90 dní (ks)', 'number', G_STOCK, { unit: 'ks' }),
  f('stock_value', 'Hodnota skladu v nákupních cenách', 'number', G_STOCK, { unit: 'Kč' }),
  f('days_of_cover', 'Zásoba na počet dní', 'number', G_STOCK, { unit: 'dní' }),
]);

/**
 * Z hodnot atributů produktů odvodí pole `attrs.*` (skupina „Vlastní atributy“, typ odhadnut).
 * @param {Iterable<object>} attrsList objekty attrs (nebo JSON texty)
 * @returns {Array<{key, label, type, group}>}
 */
function discoverAttrFields(attrsList) {
  const seen = new Map();
  for (const a of attrsList || []) {
    const obj = typeof a === 'string' ? parseJson(a, {}) : a;
    if (!obj || typeof obj !== 'object') continue;
    for (const [k, val] of Object.entries(obj)) {
      if (val == null || val === '') {
        if (!seen.has(k)) seen.set(k, new Set());
        continue;
      }
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k).add(typeof val === 'number' ? 'number' : typeof val === 'boolean' ? 'boolean' : 'string');
    }
  }
  return [...seen.entries()]
    .sort((x, y) => x[0].localeCompare(y[0], 'cs'))
    .map(([k, types]) => ({
      key: `attrs.${k}`,
      label: k,
      type: types.size === 1 ? [...types][0] : 'string',
      group: G_ATTRS,
    }));
}

module.exports = {
  productView,
  FIELDS,
  POSITION_LABELS,
  FIELD_GROUPS: Object.freeze([G_PRODUCT, G_PRICE, G_MARKET, G_STOCK, G_ATTRS]),
  discoverAttrFields,
  isLockActive,
  scheduleActive,
  describeSchedule,
  parseDateTime,
  pragueParts,
  daysSince,
  toDate,
};
