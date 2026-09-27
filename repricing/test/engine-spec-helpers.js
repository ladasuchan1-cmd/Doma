'use strict';
// Sdílené pomůcky pro NEZÁVISLÉ black-box testy enginu (test/engine-spec*.test.js).
// Testy vycházejí výhradně z docs/SPEC.md (§3, §6) – implementaci v src/engine/* záměrně nečtou.
// Moduly enginu se načítají líně (engine('pricing')), aby chybějící modul shodil jen testy, které ho používají.

const assert = require('node:assert');
const { deepMerge, DEFAULT_SETTINGS, openDb, bind } = require('../src/db.js');
const { codeKey, nameKey } = require('../src/util/keys.js');

/** Pevný „teď“ pro testy: pátek 25. 9. 2026 12:00 v Praze (CEST, UTC+2). */
const NOW = '2026-09-25T10:00:00.000Z';
const DAY = 86400000;

function daysAgo(d, from = NOW) {
  return new Date(Date.parse(from) - d * DAY).toISOString();
}
function daysAhead(d, from = NOW) {
  return new Date(Date.parse(from) + d * DAY).toISOString();
}

/** Líné načtení modulu enginu. */
function engine(name) {
  return require(`../src/engine/${name}.js`);
}

/** Výchozí konfigurace strategie přepsaná ručně z SPEC §6.5 (nezávislá na presets.js). */
const SPEC_DEFAULT_CONFIG = Object.freeze({
  conditions: {},
  schedule: { valid_from: null, valid_to: null, weekdays: [], hours: null },
  target: {
    mode: 'undercut_min',
    offset_abs: 0,
    offset_pct: 0,
    rank: 1,
    competitor: null,
    markup_pct: null,
    fixed_price: null,
    step_pct: 5,
    every_days: 14,
    max_sales_30: 0,
  },
  competitors: {
    include: [],
    exclude: [],
    include_tags: [],
    exclude_tags: [],
    in_stock_only: true,
    include_shipping: false,
    max_age_days: null,
    outlier_pct: null,
    min_competitors: 1,
    exclude_keywords: [],
  },
  fallback: { mode: 'next', markup_pct: null, offset_pct: 0 },
  limits: {
    min_margin_pct: 10,
    min_profit_abs: null,
    max_margin_pct: null,
    max_above_msrp_pct: 0,
    max_below_msrp_pct: null,
    max_decrease_pct: 10,
    max_increase_pct: 15,
    allow_increase: true,
    allow_decrease: true,
    min_change_pct: 0.5,
    min_change_abs: 5,
    respect_product_limits: true,
  },
  rounding: {
    mode: 'ending',
    direction: 'down',
    bands: [
      { up_to: 1000, ending: 9 },
      { up_to: 10000, ending: 90 },
      { up_to: null, ending: 990 },
    ],
  },
  stock: { zero_stock: 'reprice' },
  approval: { auto: false, auto_max_change_pct: 5 },
});

const DEFAULT_BANDS = SPEC_DEFAULT_CONFIG.rounding.bands;

/** Plná konfigurace = výchozí hodnoty SPEC + přepsání (hluboké sloučení, pole se nahrazují). */
function cfg(over = {}) {
  return deepMerge(structuredClone(SPEC_DEFAULT_CONFIG), structuredClone(over));
}

// Často používané „otevřené“ limity, aby test izoloval jednu věc.
const OPEN_LIMITS = { max_decrease_pct: null, max_increase_pct: null, max_above_msrp_pct: null };
const NO_THRESHOLD = { min_change_pct: 0, min_change_abs: 0 };
const OPEN = { ...OPEN_LIMITS, ...NO_THRESHOLD };
const R_NONE = { mode: 'none' };
const R_INT = { mode: 'integer' };

const COMP_IDS = {
  'VeloMarket.cz': 1,
  'Kolo-Shop.cz': 2,
  'BikeStore.cz': 3,
  'Bazar.cz': 4,
};
let nextCompId = 100;
function compId(name) {
  if (!(name in COMP_IDS)) COMP_IDS[name] = nextCompId++;
  return COMP_IDS[name];
}

/** Nabídka konkurenta ve tvaru SPEC §6.1 (+ `name` kvůli exclude_keywords). */
function offer(competitor, price, over = {}) {
  return {
    competitor_id: compId(competitor),
    competitor,
    label: null,
    tags: [],
    enabled: true,
    price,
    shipping: null,
    in_stock: 1,
    delivery_days: 0,
    url: `https://${competitor.toLowerCase()}/kolo`,
    name: 'Scott Aspect 950 2026',
    observed_at: daysAgo(1),
    ...over,
  };
}

/** Standardní trh z příkladu v zadání: 12 990 / 13 200 / 14 000. */
function market3() {
  return [offer('VeloMarket.cz', 12990), offer('Kolo-Shop.cz', 13200), offer('BikeStore.cz', 14000)];
}

/** Produkt jako řádek tabulky products (attrs = JSON text). */
function product(over = {}) {
  return {
    id: 1,
    code: 'KOLO-1',
    code_key: 'KOLO-1',
    ean: '8590000000001',
    ean_key: '8590000000001',
    mpn: 'SC-ASP-950',
    mpn_key: 'SCASP950',
    name: 'Scott Aspect 950',
    manufacturer: 'Scott',
    category: 'Horská kola',
    supplier: 'Scott Sports',
    owner: 'Petr Novák',
    purchase_price: 8000,
    price: 13490,
    vat_rate: 21,
    msrp: 14990,
    stock: 5,
    sales_30: 3,
    sales_90: 9,
    attrs: '{"N":"N2"}',
    active: 1,
    locked: 0,
    locked_until: null,
    min_price: null,
    max_price: null,
    note: null,
    price_changed_at: daysAgo(30),
    created_at: daysAgo(100),
    updated_at: daysAgo(1),
    ...over,
  };
}

function strategy(config, over = {}) {
  return { id: 7, name: 'Testovací strategie', segment_id: null, config, ...over };
}

/** Pohodlné volání computePrice(product, offers, strategy, ctx). */
function decide(prodOver, offers, cfgOver, { now = NOW, settings = DEFAULT_SETTINGS, strategyOver = {} } = {}) {
  const { computePrice } = engine('pricing');
  return computePrice(product(prodOver), offers, strategy(cfg(cfgOver), strategyOver), { now, settings });
}

function approx(actual, expected, tol = 0.005, msg = '') {
  assert.ok(
    typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
    `${msg} očekáváno ≈ ${expected} (±${tol}), dostali jsme ${actual}`
  );
}

function hasFlag(d, f) {
  return Array.isArray(d.flags) && d.flags.includes(f);
}

// ---------- DB pomůcky pro testy run.js ----------

function ins(db, table, row) {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  return Number(db.prepare(sql).run(...keys.map((k) => bind(row[k]))).lastInsertRowid);
}

function insProduct(db, over = {}) {
  const p = product(over);
  delete p.id;
  p.code_key = codeKey(p.code);
  return ins(db, 'products', p);
}

function insCompetitor(db, name, over = {}) {
  return ins(db, 'competitors', {
    name,
    name_key: nameKey(name),
    label: null,
    enabled: 1,
    tags: '[]',
    created_at: daysAgo(100),
    ...over,
  });
}

function insOffer(db, productId, competitorId, price, over = {}) {
  return ins(db, 'offers', {
    product_id: productId,
    competitor_id: competitorId,
    price,
    shipping: null,
    in_stock: 1,
    delivery_days: 0,
    url: null,
    name: 'Nabídka',
    observed_at: daysAgo(1),
    first_seen_at: daysAgo(20),
    ...over,
  });
}

function insSegment(db, name, filter) {
  return ins(db, 'segments', {
    name,
    description: null,
    filter: JSON.stringify(filter),
    color: null,
    created_at: daysAgo(10),
    updated_at: daysAgo(10),
  });
}

/** config: objekt (uloží se jako JSON beze změny) – volající rozhoduje, zda plný (cfg()) nebo částečný. */
function insStrategy(db, name, config, over = {}) {
  return ins(db, 'strategies', {
    name,
    description: null,
    segment_id: null,
    priority: 100,
    enabled: 1,
    config: JSON.stringify(config),
    created_at: daysAgo(10),
    updated_at: daysAgo(10),
    ...over,
  });
}

function count(db, sql, ...params) {
  return Number(db.prepare(sql).get(...params).c);
}

module.exports = {
  NOW,
  DAY,
  daysAgo,
  daysAhead,
  engine,
  SPEC_DEFAULT_CONFIG,
  DEFAULT_BANDS,
  DEFAULT_SETTINGS,
  cfg,
  OPEN_LIMITS,
  NO_THRESHOLD,
  OPEN,
  R_NONE,
  R_INT,
  offer,
  market3,
  product,
  strategy,
  decide,
  approx,
  hasFlag,
  openDb,
  ins,
  insProduct,
  insCompetitor,
  insOffer,
  insSegment,
  insStrategy,
  count,
};
