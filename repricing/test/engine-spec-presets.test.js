'use strict';
// Nezávislé black-box testy src/engine/presets.js podle SPEC §6.5 a §6.9.
// DEFAULT_CONFIG, normalizeConfig(cfg) → {config, errors}, STRATEGY_PRESETS

const test = require('node:test');
const assert = require('node:assert');
const { fold } = require('../src/util/keys.js');
const { engine, SPEC_DEFAULT_CONFIG } = require('./engine-spec-helpers.js');

const PR = () => engine('presets');

/** Každý klíč z expected musí mít v actual stejnou hodnotu (actual může mít klíče navíc). */
function assertSubset(actual, expected, path = 'config') {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    assert.ok(actual !== null && typeof actual === 'object' && !Array.isArray(actual), `${path} má být objekt`);
    for (const k of Object.keys(expected)) assertSubset(actual[k], expected[k], `${path}.${k}`);
  } else {
    assert.deepStrictEqual(actual, expected, `${path}`);
  }
}

test('DEFAULT_CONFIG odpovídá výchozím hodnotám SPEC §6.5', () => {
  assertSubset(PR().DEFAULT_CONFIG, SPEC_DEFAULT_CONFIG, 'DEFAULT_CONFIG');
});

test('normalizeConfig({}) → výchozí konfigurace bez chyb', () => {
  const r = PR().normalizeConfig({});
  assert.ok(r && typeof r === 'object');
  assert.deepStrictEqual(r.errors, []);
  assertSubset(r.config, SPEC_DEFAULT_CONFIG);
});

test('normalizeConfig: hluboké sloučení částečné konfigurace s výchozími hodnotami', () => {
  const r = PR().normalizeConfig({
    target: { mode: 'rank', rank: 2 },
    limits: { min_margin_pct: 18 },
    competitors: { exclude_tags: ['marketplace'] },
    rounding: { direction: 'nearest' },
  });
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.config.target.mode, 'rank');
  assert.strictEqual(r.config.target.rank, 2);
  assert.strictEqual(r.config.target.offset_pct, 0);
  assert.strictEqual(r.config.target.offset_abs, 0);
  assert.strictEqual(r.config.limits.min_margin_pct, 18);
  assert.strictEqual(r.config.limits.max_decrease_pct, 10);
  assert.strictEqual(r.config.limits.max_increase_pct, 15);
  assert.strictEqual(r.config.limits.max_above_msrp_pct, 0);
  assert.strictEqual(r.config.limits.min_change_abs, 5);
  assert.deepStrictEqual(r.config.competitors.exclude_tags, ['marketplace']);
  assert.strictEqual(r.config.competitors.in_stock_only, true);
  assert.strictEqual(r.config.rounding.direction, 'nearest');
  assert.strictEqual(r.config.rounding.mode, 'ending');
  assert.deepStrictEqual(r.config.rounding.bands, SPEC_DEFAULT_CONFIG.rounding.bands);
  assert.strictEqual(r.config.fallback.mode, 'next');
  assert.strictEqual(r.config.stock.zero_stock, 'reprice');
  assert.strictEqual(r.config.approval.auto, false);
});

test('normalizeConfig: explicitní null (vypnutý limit) se nepřepíše výchozí hodnotou', () => {
  const r = PR().normalizeConfig({ limits: { max_decrease_pct: null, max_above_msrp_pct: null } });
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.config.limits.max_decrease_pct, null);
  assert.strictEqual(r.config.limits.max_above_msrp_pct, null);
});

test('normalizeConfig: je idempotentní', () => {
  const { normalizeConfig } = PR();
  const once = normalizeConfig({ target: { mode: 'market_median', offset_pct: -2 } }).config;
  const twice = normalizeConfig(once);
  assert.deepStrictEqual(twice.errors, []);
  assert.deepStrictEqual(twice.config, once);
});

test('normalizeConfig: nemutuje DEFAULT_CONFIG ani vstup', () => {
  const { normalizeConfig, DEFAULT_CONFIG } = PR();
  const before = JSON.stringify(DEFAULT_CONFIG);
  const input = { limits: { min_margin_pct: 22 } };
  const inputBefore = JSON.stringify(input);
  const a = normalizeConfig(input).config;
  a.limits.max_decrease_pct = 99;
  a.rounding.bands.push({ up_to: null, ending: 5 });
  a.competitors.include.push('X');
  assert.strictEqual(JSON.stringify(DEFAULT_CONFIG), before, 'DEFAULT_CONFIG se změnil');
  assert.strictEqual(JSON.stringify(input), inputBefore, 'vstup se změnil');
  const b = normalizeConfig({}).config;
  assert.strictEqual(b.limits.max_decrease_pct, 10);
  assert.strictEqual(b.rounding.bands.length, 3);
  assert.deepStrictEqual(b.competitors.include, []);
});

test('normalizeConfig: neplatné hodnoty → errors (česky, neprázdné)', () => {
  const { normalizeConfig } = PR();
  const bad = [
    { target: { mode: 'nesmysl' } },
    { fallback: { mode: 'nesmysl' } },
    { stock: { zero_stock: 'nesmysl' } },
    { rounding: { mode: 'nesmysl' } },
    { rounding: { direction: 'bokem' } },
    // min_margin_pct ≥ 100 → neplatné (dělení nulou / záporný jmenovatel ve vzorci spodní hranice)
    { limits: { min_margin_pct: 100 } },
    { limits: { min_margin_pct: 120 } },
    // ending musí být menší než step
    { rounding: { mode: 'ending', bands: [{ up_to: null, ending: 90, step: 50 }] } },
    { rounding: { mode: 'ending', bands: [{ up_to: null, ending: 100, step: 100 }] } },
  ];
  for (const c of bad) {
    const r = normalizeConfig(c);
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0, `čekali jsme chybu pro ${JSON.stringify(c)}`);
    for (const e of r.errors) assert.ok(typeof e === 'string' && e.length > 0);
  }
});

test('normalizeConfig: všechny režimy cíle, fallbacku a zero_stock ze SPEC jsou platné', () => {
  const { normalizeConfig } = PR();
  for (const mode of ['undercut_min', 'match_min', 'rank', 'market_avg', 'market_median', 'competitor', 'msrp', 'cost_plus', 'keep', 'fixed', 'clearance']) {
    const extra = mode === 'competitor' ? { competitor: 'VeloMarket.cz' } : mode === 'cost_plus' ? { markup_pct: 30 } : mode === 'fixed' ? { fixed_price: 9990 } : {};
    const r = normalizeConfig({ target: { mode, ...extra } });
    assert.deepStrictEqual(r.errors, [], `režim ${mode}: ${r.errors}`);
  }
  for (const mode of ['next', 'keep', 'msrp', 'cost_plus']) {
    const r = normalizeConfig({ fallback: { mode, markup_pct: mode === 'cost_plus' ? 25 : null } });
    assert.deepStrictEqual(r.errors, [], `fallback ${mode}`);
  }
  for (const z of ['reprice', 'skip', 'msrp']) assert.deepStrictEqual(normalizeConfig({ stock: { zero_stock: z } }).errors, []);
  for (const m of ['none', 'integer', 'ending']) assert.deepStrictEqual(normalizeConfig({ rounding: { mode: m } }).errors, []);
  for (const d of ['down', 'up', 'nearest']) assert.deepStrictEqual(normalizeConfig({ rounding: { direction: d } }).errors, []);
});

// ---------- STRATEGY_PRESETS ----------

function findPreset(needle) {
  const { STRATEGY_PRESETS } = PR();
  const p = STRATEGY_PRESETS.find((x) => fold(x.name).includes(fold(needle)));
  assert.ok(p, `preset „${needle}“ nenalezen`);
  return p;
}
const compile = (f) => engine('filter').compileFilter(f);

test('STRATEGY_PRESETS: tvar, unikátní klíče, platná konfigurace i filtry segmentů', () => {
  const { STRATEGY_PRESETS, normalizeConfig } = PR();
  const { validateFilter } = engine('filter');
  assert.ok(Array.isArray(STRATEGY_PRESETS) && STRATEGY_PRESETS.length >= 7);
  const keys = new Set();
  for (const p of STRATEGY_PRESETS) {
    assert.ok(typeof p.key === 'string' && p.key, 'key');
    assert.ok(!keys.has(p.key), `duplicitní key ${p.key}`);
    keys.add(p.key);
    assert.ok(typeof p.name === 'string' && p.name, 'name');
    assert.ok(typeof p.description === 'string' && p.description, `description ${p.key}`);
    assert.ok(p.config && typeof p.config === 'object', `config ${p.key}`);
    assert.deepStrictEqual(normalizeConfig(p.config).errors, [], `config presetu ${p.key}`);
    if (p.segment !== null) {
      assert.ok(typeof p.segment.name === 'string' && p.segment.name, `segment.name ${p.key}`);
      assert.deepStrictEqual(validateFilter(p.segment.filter).errors, [], `segment.filter ${p.key}`);
    }
    if (p.config.conditions) assert.strictEqual(validateFilter(p.config.conditions).ok, true, `conditions ${p.key}`);
  }
});

test('preset „Ležáky N7/N8 – doprodej“', () => {
  const p = findPreset('Ležáky');
  const c = PR().normalizeConfig(p.config).config;
  assert.ok(p.segment, 'má segment');
  const seg = compile(p.segment.filter);
  assert.strictEqual(seg({ attrs: { N: 'N7' } }), true);
  assert.strictEqual(seg({ attrs: { N: 'N8' } }), true);
  assert.strictEqual(seg({ attrs: { N: 'N3' } }), false);
  assert.strictEqual(seg({ attrs: {} }), false);
  assert.strictEqual(c.target.mode, 'undercut_min');
  assert.strictEqual(c.target.offset_pct, -1);
  assert.strictEqual(c.limits.min_margin_pct, 3);
  assert.strictEqual(c.limits.max_decrease_pct, 15);
});

test('preset „Klíčové značky – držet pozici 2“', () => {
  const c = PR().normalizeConfig(findPreset('Klíčové značky').config).config;
  assert.strictEqual(c.target.mode, 'rank');
  assert.strictEqual(c.target.rank, 2);
  assert.strictEqual(c.limits.min_margin_pct, 18);
  // strop MOC → max_above_msrp_pct je číslo (ne null)
  assert.strictEqual(typeof c.limits.max_above_msrp_pct, 'number');
});

test('preset „Bez konkurence → MOC“', () => {
  const p = findPreset('Bez konkurence');
  const c = PR().normalizeConfig(p.config).config;
  assert.strictEqual(c.target.mode, 'msrp');
  assert.ok(p.segment, 'má segment');
  const seg = compile(p.segment.filter);
  assert.strictEqual(seg({ market_count: 0, position: 'no_data' }), true);
  assert.strictEqual(seg({ market_count: 3, position: 'middle' }), false);
});

test('preset „Výchozí – medián trhu −2 %“', () => {
  const p = findPreset('Výchozí');
  const c = PR().normalizeConfig(p.config).config;
  assert.strictEqual(p.segment, null);
  assert.strictEqual(c.target.mode, 'market_median');
  assert.strictEqual(c.target.offset_pct, -2);
  assert.strictEqual(c.limits.min_margin_pct, 12);
  assert.strictEqual(c.approval.auto, true);
  assert.strictEqual(c.approval.auto_max_change_pct, 3);
});

test('preset „Návrat marže – jsme výrazně nejlevnější“ (conditions)', () => {
  const c = PR().normalizeConfig(findPreset('Návrat marže').config).config;
  assert.strictEqual(c.target.mode, 'undercut_min');
  assert.strictEqual(c.target.offset_pct, -1);
  const cond = compile(c.conditions);
  assert.strictEqual(cond({ position: 'cheapest', gap_min_pct: -6 }), true);
  assert.strictEqual(cond({ position: 'cheapest', gap_min_pct: -5 }), true); // <= −5
  assert.strictEqual(cond({ position: 'cheapest', gap_min_pct: -4 }), false);
  assert.strictEqual(cond({ position: 'middle', gap_min_pct: -6 }), false);
});

test('preset „Doprodej bez prodejů – postupné slevy“', () => {
  const c = PR().normalizeConfig(findPreset('Doprodej bez prodejů').config).config;
  assert.strictEqual(c.target.mode, 'clearance');
  assert.strictEqual(c.target.step_pct, 5);
  assert.strictEqual(c.target.every_days, 14);
  assert.strictEqual(c.target.max_sales_30, 0);
  assert.strictEqual(c.limits.min_margin_pct, 0);
  assert.strictEqual(c.limits.max_below_msrp_pct, 40);
});

test('preset „Víkendová akce“', () => {
  const p = findPreset('Víkendová akce');
  const c = PR().normalizeConfig(p.config).config;
  assert.deepStrictEqual(c.schedule.weekdays, [6, 7]);
  assert.ok(['fixed', 'msrp'].includes(c.target.mode), c.target.mode);
  // SPEC-AMBIGUOUS: „disabled by default“ – tvar presetu {key, name, description, segment, config} pole enabled
  // neobsahuje; akceptujeme p.enabled === false nebo p.config.enabled === false.
  assert.ok(p.enabled === false || p.config.enabled === false, 'víkendová akce má být ve výchozím stavu vypnutá');
});
