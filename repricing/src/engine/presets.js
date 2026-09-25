'use strict';
// Konfigurace strategie: výchozí hodnoty (SPEC §6.5), normalizace + validace a hotové předvolby (SPEC §6.9).

const { deepMerge, parseJson } = require('../db');
const { parseNumber } = require('../util/num');
const { validateFilter } = require('./filter');
const { validateRounding, DEFAULT_BANDS } = require('./rounding');
const { parseDateTime } = require('./metrics');

const TARGET_MODES = ['undercut_min', 'match_min', 'rank', 'market_avg', 'market_median', 'competitor', 'msrp', 'cost_plus', 'keep', 'fixed', 'clearance'];
const MARKET_MODES = ['undercut_min', 'match_min', 'rank', 'market_avg', 'market_median'];
const FALLBACK_MODES = ['next', 'keep', 'msrp', 'cost_plus'];
const ZERO_STOCK_MODES = ['reprice', 'skip', 'msrp'];

/** Česky popsané režimy (pro UI a vysvětlení). */
const TARGET_MODE_LABELS = Object.freeze({
  undercut_min: 'Podstřelit nejnižší cenu',
  match_min: 'Vyrovnat nejnižší cenu',
  rank: 'Držet pozici v pořadí',
  market_avg: 'Průměr trhu',
  market_median: 'Medián trhu',
  competitor: 'Podle konkrétního konkurenta',
  msrp: 'Podle MOC',
  cost_plus: 'Nákupní cena + přirážka',
  keep: 'Držet aktuální cenu (jen hlídat limity)',
  fixed: 'Pevná cena',
  clearance: 'Doprodej – postupné slevy',
});
const FALLBACK_MODE_LABELS = Object.freeze({
  next: 'Přejít na další strategii',
  keep: 'Ponechat aktuální cenu',
  msrp: 'Nastavit podle MOC',
  cost_plus: 'Nákupní cena + přirážka',
});

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** Výchozí konfigurace strategie (SPEC §6.5). Zmrazená – pro úpravy použijte normalizeConfig(). */
const DEFAULT_CONFIG = deepFreeze({
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
  rounding: { mode: 'ending', direction: 'down', bands: DEFAULT_BANDS.map((b) => ({ ...b })) },
  stock: { zero_stock: 'reprice' },
  approval: { auto: false, auto_max_change_pct: 5 },
});

// Konfigurace, které prošly normalizeConfig bez chyb (computePrice je pak nenormalizuje znovu).
const NORMALIZED = new WeakSet();

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
  return v === undefined ? undefined : structuredClone(v);
}

/**
 * Sloučí konfiguraci s výchozími hodnotami a zkontroluje ji.
 * Neplatné hodnoty jsou v `config` nahrazeny výchozími a popsány v `errors` (česky) –
 * strategii s chybami nelze použít k cenotvorbě.
 * @param {object|string|null} input
 * @returns {{config: object, errors: string[]}}
 */
function normalizeConfig(input) {
  const errors = [];
  let raw = input;
  if (typeof raw === 'string') {
    raw = raw.trim() === '' ? {} : parseJson(raw, undefined);
    if (raw === undefined) {
      errors.push('Konfigurace strategie není platný JSON');
      raw = {};
    }
  }
  if (raw == null) raw = {};
  if (!isPlainObject(raw)) {
    errors.push('Konfigurace strategie musí být objekt');
    raw = {};
  }
  const base = structuredClone(DEFAULT_CONFIG);
  const cfg = deepMerge(base, clone(raw));

  // Sekce, které nejsou objektem → výchozí + chyba
  for (const sec of ['schedule', 'target', 'competitors', 'fallback', 'limits', 'rounding', 'stock', 'approval']) {
    if (!isPlainObject(cfg[sec])) {
      if (cfg[sec] != null) errors.push(`${sec}: musí být objekt`);
      cfg[sec] = structuredClone(DEFAULT_CONFIG[sec]);
    }
  }

  // --- pomocníci --------------------------------------------------------------------------
  const fmt = (n) => String(n).replace('.', ',');
  const numField = (sec, key, { nullable = false, min = -Infinity, max = Infinity, minExcl = false, maxExcl = false, integer = false, dflt } = {}) => {
    const path = `${sec}.${key}`;
    let v = cfg[sec][key];
    const fallback = dflt !== undefined ? dflt : DEFAULT_CONFIG[sec][key];
    if (v === '' || v === undefined) v = null;
    if (v == null) {
      // nevyplněné povinné pole (např. rank u jiného režimu než „rank“) → tiše výchozí hodnota
      cfg[sec][key] = nullable ? null : fallback;
      return cfg[sec][key];
    }
    let n = typeof v === 'number' ? v : typeof v === 'string' ? parseNumber(v) : null;
    if (n == null || !Number.isFinite(n)) {
      errors.push(`${path}: musí být číslo`);
      cfg[sec][key] = fallback;
      return fallback;
    }
    const range =
      (min > -Infinity ? `${minExcl ? '>' : '≥'} ${fmt(min)}` : '') +
      (min > -Infinity && max < Infinity ? ' a ' : '') +
      (max < Infinity ? `${maxExcl ? '<' : '≤'} ${fmt(max)}` : '');
    if ((minExcl ? n <= min : n < min) || (maxExcl ? n >= max : n > max)) {
      errors.push(`${path}: hodnota ${fmt(n)} je mimo povolený rozsah (${range})`);
      cfg[sec][key] = fallback;
      return fallback;
    }
    if (integer && !Number.isInteger(n)) {
      errors.push(`${path}: musí být celé číslo`);
      cfg[sec][key] = fallback;
      return fallback;
    }
    cfg[sec][key] = n;
    return n;
  };
  const boolField = (sec, key) => {
    const v = cfg[sec][key];
    let b;
    if (typeof v === 'boolean') b = v;
    else if (v === 1 || v === 0) b = v === 1;
    else if (typeof v === 'string' && ['true', '1', 'ano', 'yes'].includes(v.trim().toLowerCase())) b = true;
    else if (typeof v === 'string' && ['false', '0', 'ne', 'no'].includes(v.trim().toLowerCase())) b = false;
    else {
      if (v != null) errors.push(`${sec}.${key}: musí být ano/ne (true/false)`);
      b = DEFAULT_CONFIG[sec][key];
    }
    cfg[sec][key] = b;
    return b;
  };
  const enumField = (sec, key, allowed) => {
    const v = cfg[sec][key];
    if (!allowed.includes(v)) {
      errors.push(`${sec}.${key}: neznámá hodnota „${v}“ (povoleno: ${allowed.join(', ')})`);
      cfg[sec][key] = DEFAULT_CONFIG[sec][key];
    }
    return cfg[sec][key];
  };
  const listField = (sec, key) => {
    let v = cfg[sec][key];
    if (v == null || v === '') v = [];
    if (typeof v === 'string') v = v.split(/[,;\n]/);
    if (!Array.isArray(v)) {
      errors.push(`${sec}.${key}: musí být seznam textů`);
      v = [];
    }
    cfg[sec][key] = v.map((x) => (x == null ? '' : String(x).trim())).filter((x) => x !== '');
  };

  // --- conditions -------------------------------------------------------------------------
  if (cfg.conditions == null || cfg.conditions === '') cfg.conditions = {};
  if (typeof cfg.conditions === 'string') {
    const parsed = parseJson(cfg.conditions, undefined);
    if (parsed === undefined) {
      errors.push('conditions: podmínky nejsou platný JSON');
      cfg.conditions = {};
    } else cfg.conditions = parsed ?? {};
  }
  if (!isPlainObject(cfg.conditions)) {
    errors.push('conditions: podmínky musí být filtr (objekt)');
    cfg.conditions = {};
  } else {
    const r = validateFilter(cfg.conditions);
    for (const e of r.errors) errors.push(`conditions: ${e}`);
  }

  // --- schedule ---------------------------------------------------------------------------
  {
    const s = cfg.schedule;
    for (const k of ['valid_from', 'valid_to']) {
      if (s[k] === '' || s[k] === undefined) s[k] = null;
      if (s[k] != null && parseDateTime(s[k]) == null) {
        errors.push(`schedule.${k}: neplatné datum a čas „${s[k]}“`);
        s[k] = null;
      }
    }
    if (s.valid_from && s.valid_to && parseDateTime(s.valid_from) >= parseDateTime(s.valid_to)) {
      errors.push('schedule: „platí od“ musí být dříve než „platí do“');
    }
    let wd = s.weekdays;
    if (wd == null || wd === '') wd = [];
    if (typeof wd === 'string') wd = wd.split(/[,;\s]+/).filter(Boolean);
    if (!Array.isArray(wd)) {
      errors.push('schedule.weekdays: musí být seznam dní 1–7 (1 = pondělí)');
      wd = [];
    }
    const days = [];
    for (const d of wd) {
      const n = Number(d);
      if (!Number.isInteger(n) || n < 1 || n > 7) errors.push(`schedule.weekdays: neplatný den „${d}“ (1 = pondělí … 7 = neděle)`);
      else if (!days.includes(n)) days.push(n);
    }
    s.weekdays = days.sort((a, b) => a - b);
    if (s.hours === '' || s.hours === undefined) s.hours = null;
    if (s.hours != null) {
      const h = s.hours;
      const ok = Array.isArray(h) && h.length === 2 && h.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 24) && h[0] !== h[1] && h[0] < 24;
      if (!ok) {
        errors.push('schedule.hours: musí být [od, do] v hodinách 0–24 (např. [18, 24]), od ≠ do');
        s.hours = null;
      } else s.hours = [h[0], h[1]];
    }
  }

  // --- target -----------------------------------------------------------------------------
  {
    const mode = enumField('target', 'mode', TARGET_MODES);
    numField('target', 'offset_abs', { nullable: true });
    if (cfg.target.offset_abs == null) cfg.target.offset_abs = 0;
    numField('target', 'offset_pct', { nullable: true, min: -100, minExcl: true, max: 1000 });
    if (cfg.target.offset_pct == null) cfg.target.offset_pct = 0;
    numField('target', 'rank', { min: 1, integer: true });
    const comp = cfg.target.competitor;
    cfg.target.competitor = comp == null || String(comp).trim() === '' ? null : String(comp).trim();
    if (mode === 'competitor' && !cfg.target.competitor) errors.push('target.competitor: režim „competitor“ vyžaduje jméno konkurenta');
    numField('target', 'markup_pct', { nullable: true, min: -100, minExcl: true });
    if (mode === 'cost_plus' && cfg.target.markup_pct == null) errors.push('target.markup_pct: režim „cost_plus“ vyžaduje přirážku v %');
    numField('target', 'fixed_price', { nullable: true, min: 0, minExcl: true });
    if (mode === 'fixed' && cfg.target.fixed_price == null) errors.push('target.fixed_price: režim „fixed“ vyžaduje pevnou cenu');
    numField('target', 'step_pct', { min: 0, minExcl: true, max: 100, maxExcl: true });
    numField('target', 'every_days', { min: 0 });
    numField('target', 'max_sales_30', { min: 0 });
  }

  // --- competitors ------------------------------------------------------------------------
  for (const k of ['include', 'exclude', 'include_tags', 'exclude_tags', 'exclude_keywords']) listField('competitors', k);
  boolField('competitors', 'in_stock_only');
  boolField('competitors', 'include_shipping');
  numField('competitors', 'max_age_days', { nullable: true, min: 0, minExcl: true });
  numField('competitors', 'outlier_pct', { nullable: true, min: 0, minExcl: true, max: 100, maxExcl: true });
  numField('competitors', 'min_competitors', { min: 1, integer: true });

  // --- fallback ---------------------------------------------------------------------------
  {
    const fm = enumField('fallback', 'mode', FALLBACK_MODES);
    numField('fallback', 'markup_pct', { nullable: true, min: -100, minExcl: true });
    numField('fallback', 'offset_pct', { nullable: true, min: -100, minExcl: true, max: 1000 });
    if (cfg.fallback.offset_pct == null) cfg.fallback.offset_pct = 0;
    if (fm === 'cost_plus' && cfg.fallback.markup_pct == null && cfg.target.markup_pct == null) {
      errors.push('fallback.markup_pct: záložní režim „cost_plus“ vyžaduje přirážku v %');
    }
  }

  // --- limits -----------------------------------------------------------------------------
  {
    const minM = numField('limits', 'min_margin_pct', { nullable: true, min: 0, max: 99.9 });
    numField('limits', 'min_profit_abs', { nullable: true, min: 0 });
    const maxM = numField('limits', 'max_margin_pct', { nullable: true, min: 0, max: 99.9 });
    if (minM != null && maxM != null && maxM < minM) errors.push('limits.max_margin_pct: maximální marže nesmí být nižší než minimální');
    numField('limits', 'max_above_msrp_pct', { nullable: true, min: -100, minExcl: true });
    numField('limits', 'max_below_msrp_pct', { nullable: true, min: 0, max: 100, maxExcl: true });
    numField('limits', 'max_decrease_pct', { nullable: true, min: 0, max: 100 });
    numField('limits', 'max_increase_pct', { nullable: true, min: 0 });
    boolField('limits', 'allow_increase');
    boolField('limits', 'allow_decrease');
    numField('limits', 'min_change_pct', { nullable: true, min: 0, max: 100 });
    if (cfg.limits.min_change_pct == null) cfg.limits.min_change_pct = 0;
    numField('limits', 'min_change_abs', { nullable: true, min: 0 });
    if (cfg.limits.min_change_abs == null) cfg.limits.min_change_abs = 0;
    boolField('limits', 'respect_product_limits');
  }

  // --- rounding ---------------------------------------------------------------------------
  {
    const r = cfg.rounding;
    if (r.bands == null) r.bands = DEFAULT_BANDS.map((b) => ({ ...b }));
    if (Array.isArray(r.bands)) {
      r.bands = r.bands.map((b) => {
        if (!isPlainObject(b)) return b;
        const out = { ...b };
        for (const k of ['up_to', 'ending', 'step']) {
          if (out[k] === '' || out[k] === undefined) out[k] = null;
          if (typeof out[k] === 'string') {
            const n = parseNumber(out[k]);
            if (n != null) out[k] = n;
          }
        }
        if (out.step == null) delete out.step;
        return out;
      });
    }
    const re = validateRounding(r);
    if (re.length) {
      errors.push(...re);
      if (re.some((e) => e.startsWith('rounding.mode'))) r.mode = DEFAULT_CONFIG.rounding.mode;
      if (re.some((e) => e.startsWith('rounding.direction'))) r.direction = DEFAULT_CONFIG.rounding.direction;
      if (re.some((e) => e.startsWith('rounding.bands'))) r.bands = DEFAULT_BANDS.map((b) => ({ ...b }));
    }
  }

  // --- stock, approval --------------------------------------------------------------------
  enumField('stock', 'zero_stock', ZERO_STOCK_MODES);
  boolField('approval', 'auto');
  numField('approval', 'auto_max_change_pct', { nullable: true, min: 0 });

  if (!errors.length) NORMALIZED.add(cfg);
  return { config: cfg, errors };
}

/** true, pokud objekt vznikl v normalizeConfig bez chyb. */
function isNormalized(cfg) {
  return cfg != null && typeof cfg === 'object' && NORMALIZED.has(cfg);
}

// ---------------------------------------------------------------------------------------------
// Předvolby strategií (pořadí v poli = doporučená priorita: dřívější má přednost)

const P = (partial) => {
  const { config, errors } = normalizeConfig(partial);
  if (errors.length) throw new Error(`Chybná předvolba strategie: ${errors.join('; ')}`);
  return config;
};

/** Hotové strategie (česky) – API `/strategies/presets`, ukázková data. */
const STRATEGY_PRESETS = [
  {
    key: 'weekend_promo',
    name: 'Víkendová akce',
    description:
      'Ukázka časového okna: o víkendu (so–ne) prodává vybrané zboží 10 % pod MOC. Mimo víkend strategie neplatí a produkt se řídí dalšími strategiemi. Ve výchozím stavu vypnutá – upravte segment a zapněte.',
    enabled: false,
    priority: 10,
    segment: {
      name: 'Víkendová akce – vybrané zboží',
      description: 'Produkty s vlastním atributem „akce“ = ano (upravte podle svých dat).',
      filter: { field: 'attrs.akce', op: 'is_true' },
    },
    config: P({
      schedule: { weekdays: [6, 7] },
      target: { mode: 'msrp', offset_pct: -10 },
      limits: { min_margin_pct: 8, max_decrease_pct: 15 },
      fallback: { mode: 'next' },
    }),
  },
  {
    key: 'aged_stock_n7_n8',
    name: 'Ležáky N7/N8 – doprodej',
    description: 'Ležáky (stáří zásoby N7/N8) podstřelí nejnižší cenu trhu o 1 %. Marže smí klesnout až na 3 %, jednorázový pokles nejvýše 15 %, cena se nezvyšuje.',
    enabled: true,
    priority: 20,
    segment: {
      name: 'Ležáky N7/N8',
      description: 'Stáří zásoby (atribut N) je N7 nebo N8.',
      filter: { field: 'attrs.N', op: 'in', value: ['N7', 'N8'] },
    },
    config: P({
      target: { mode: 'undercut_min', offset_pct: -1 },
      // doprodej ležáků cenu nezvedá, ani když jsme hluboko pod trhem
      limits: { min_margin_pct: 3, max_decrease_pct: 15, allow_increase: false },
      fallback: { mode: 'next' },
    }),
  },
  {
    key: 'clearance_no_sales',
    name: 'Doprodej bez prodejů – postupné slevy',
    description:
      'Zboží skladem, které se 90 dní neprodalo: každých 14 dní zlevní o 5 %, dokud se nezačne prodávat. Nikdy pod nákupní cenu (min. marže 0 %) a nejvýše 40 % pod MOC.',
    enabled: true,
    priority: 30,
    segment: {
      name: 'Skladem bez prodejů 90 dní',
      description: 'Skladem > 0 ks a prodej za 90 dní = 0.',
      filter: { all: [{ field: 'stock', op: '>', value: 0 }, { field: 'sales_90', op: '<=', value: 0 }] },
    },
    config: P({
      target: { mode: 'clearance', step_pct: 5, every_days: 14, max_sales_30: 0 },
      limits: { min_margin_pct: 0, max_below_msrp_pct: 40, max_decrease_pct: 10 },
      fallback: { mode: 'next' },
    }),
  },
  {
    key: 'margin_recovery',
    name: 'Návrat marže – jsme výrazně nejlevnější',
    description:
      'Když jsme nejlevnější a o víc než 5 % pod nejlevnějším konkurentem, zdraží na 1 % pod nejnižší cenu trhu. Zbytečně nerozdáváme marži.',
    enabled: true,
    priority: 40,
    segment: null,
    config: P({
      conditions: { all: [{ field: 'position', op: '=', value: 'cheapest' }, { field: 'gap_min_pct', op: '<=', value: -5 }] },
      target: { mode: 'undercut_min', offset_pct: -1 },
      fallback: { mode: 'next' },
    }),
  },
  {
    key: 'key_brands_rank2',
    name: 'Klíčové značky – držet pozici 2',
    description: 'Klíčové značky držíme na 2. místě v pořadí cen (ne nejlevnější), s minimální marží 18 % a nikdy nad MOC.',
    enabled: true,
    priority: 50,
    segment: {
      name: 'Klíčové značky',
      description: 'Výrobci, u kterých chceme držet pozici (upravte seznam).',
      filter: { field: 'manufacturer', op: 'in', value: ['Cannondale', 'Santa Cruz', 'Cervélo', 'Focus'] },
    },
    config: P({
      target: { mode: 'rank', rank: 2 },
      limits: { min_margin_pct: 18, max_above_msrp_pct: 0 },
      fallback: { mode: 'next' },
    }),
  },
  {
    key: 'no_market_msrp',
    name: 'Bez konkurence → MOC',
    description: 'Produkty, které nikdo jiný nenabízí, prodáváme za doporučenou cenu (MOC). Bez MOC cenu ponecháme.',
    enabled: true,
    priority: 60,
    segment: {
      name: 'Bez konkurence',
      description: 'Žádná čerstvá nabídka konkurence (počet konkurentů = 0).',
      filter: { field: 'market_count', op: '=', value: 0 },
    },
    config: P({
      target: { mode: 'msrp' },
      limits: { max_above_msrp_pct: 0 },
      fallback: { mode: 'keep' },
    }),
  },
  {
    key: 'default_median',
    name: 'Výchozí – medián trhu −2 %',
    description:
      'Pro všechny ostatní produkty: 2 % pod mediánem cen trhu, minimální marže 12 %. Změny do 3 % se schvalují automaticky. Bez trhu cenu ponechá.',
    enabled: true,
    priority: 1000,
    segment: null,
    config: P({
      target: { mode: 'market_median', offset_pct: -2 },
      limits: { min_margin_pct: 12 },
      fallback: { mode: 'keep' },
      approval: { auto: true, auto_max_change_pct: 3 },
    }),
  },
];

module.exports = {
  DEFAULT_CONFIG,
  normalizeConfig,
  isNormalized,
  STRATEGY_PRESETS,
  TARGET_MODES,
  MARKET_MODES,
  FALLBACK_MODES,
  ZERO_STOCK_MODES,
  TARGET_MODE_LABELS,
  FALLBACK_MODE_LABELS,
};
