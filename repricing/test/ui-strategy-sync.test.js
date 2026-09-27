'use strict';
// UI model strategie (public/lib/strategy-model.js) musí přesně odpovídat enginu (src/engine/presets.js, rounding.js):
// výchozí konfigurace nové strategie, režimy cíle, záložní režimy, režimy skladu a zaokrouhlení.
// Když engine přidá volbu nebo změní výchozí hodnotu, tento test selže dřív, než se UI a server rozejdou.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const presets = require('../src/engine/presets.js');
const rounding = require('../src/engine/rounding.js');

const loadUi = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'lib', 'strategy-model.js')).href);
const plain = (v) => JSON.parse(JSON.stringify(v));

test('DEFAULT_CONFIG v UI = DEFAULT_CONFIG enginu (včetně podmínek, okna, doprodeje, klíčových slov a fallback „next“)', async () => {
  const ui = await loadUi();
  assert.deepStrictEqual(plain(ui.DEFAULT_CONFIG), plain(presets.DEFAULT_CONFIG));
  assert.strictEqual(ui.DEFAULT_CONFIG.fallback.mode, 'next');
  // nová strategie z UI (mergeConfig({})) je totéž, co engine vrátí z normalizeConfig({})
  assert.deepStrictEqual(plain(ui.mergeConfig({})), plain(presets.normalizeConfig({}).config));
});

test('výchozí konfigurace z UI projde validací enginu bez chyb', async () => {
  const ui = await loadUi();
  const { errors } = presets.normalizeConfig(ui.mergeConfig({}));
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(ui.validateConfig({}).errors, []);
});

test('seznamy režimů v UI = seznamy enginu', async () => {
  const ui = await loadUi();
  assert.deepStrictEqual(ui.TARGET_MODES.map((m) => m.value).sort(), [...presets.TARGET_MODES].sort(), 'režimy cíle');
  assert.deepStrictEqual(ui.FALLBACK_MODES.map((m) => m.value).sort(), [...presets.FALLBACK_MODES].sort(), 'záložní režimy');
  assert.deepStrictEqual(ui.ZERO_STOCK_MODES.map((m) => m.value).sort(), [...presets.ZERO_STOCK_MODES].sort(), 'nulový sklad');
  assert.deepStrictEqual(ui.ROUNDING_MODES.map((m) => m.value).sort(), [...rounding.MODES].sort(), 'způsob zaokrouhlení');
  assert.deepStrictEqual(ui.ROUNDING_DIRECTIONS.map((m) => m.value).sort(), [...rounding.DIRECTIONS].sort(), 'směr zaokrouhlení');
  // „market“ režimy UI (sekce Konkurence) = MARKET_MODES enginu + competitor (používá trh s filtrem konkurentů)
  const uiMarket = ui.TARGET_MODES.filter((m) => m.market).map((m) => m.value).sort();
  assert.deepStrictEqual(uiMarket, [...presets.MARKET_MODES, 'competitor'].sort());
  // popisky a nápověda u všech režimů
  for (const m of ui.TARGET_MODES) assert.ok(m.label && m.help && m.help.length > 30, 'režim ' + m.value);
  for (const m of ui.FALLBACK_MODES) assert.ok(m.label && m.help, 'záložní režim ' + m.value);
  assert.strictEqual(ui.FALLBACK_MODES.find((m) => m.value === 'next').label, 'Propadnout na další strategii');
});

test('fallback se nabízí u všech režimů, kde engine může postrádat základ ceny (kromě fixed)', async () => {
  const ui = await loadUi();
  for (const mode of presets.TARGET_MODES) {
    assert.strictEqual(ui.usesFallback(mode), mode !== 'fixed', mode);
  }
});

test('každá předvolba enginu projde validací UI a UI ji umí popsat', async () => {
  const ui = await loadUi();
  for (const p of presets.STRATEGY_PRESETS) {
    const v = ui.validateConfig(p.config);
    assert.deepStrictEqual(v.errors, [], p.key);
    assert.ok(ui.describeStrategy(p.config).length > 50, p.key);
    assert.ok(ui.describeTargetShort(p.config), p.key);
  }
});

test('chyby, které hlásí engine, hlásí i UI (aby formulář neposlal konfiguraci, kterou API odmítne)', async () => {
  const ui = await loadUi();
  const bad = [
    { target: { mode: 'competitor' } },
    { target: { mode: 'cost_plus' } },
    { target: { mode: 'fixed' } },
    { target: { mode: 'rank', rank: 0 } },
    { target: { offset_pct: -100 } },
    { fallback: { mode: 'cost_plus' } },
    { limits: { min_margin_pct: 100 } },
    { limits: { min_margin_pct: 20, max_margin_pct: 10 } },
    { limits: { max_below_msrp_pct: 100 } },
    { competitors: { min_competitors: 0 } },
    { competitors: { outlier_pct: 100 } },
    { schedule: { hours: [5, 5] } },
    { schedule: { valid_from: '2026-10-02T00:00:00Z', valid_to: '2026-10-01T00:00:00Z' } },
    { target: { mode: 'clearance', step_pct: 0 } },
    { rounding: { mode: 'ending', bands: [{ up_to: null, ending: 10, step: 10 }] } },
    { conditions: { field: 'stock', op: 'neznamy', value: 1 } },
    { group: { align: 'vse' } },
    { competitors: { max_delivery_days: -1 } },
    { competitors: { max_delivery_days: 366 } },
  ];
  for (const cfg of bad) {
    assert.ok(presets.normalizeConfig(cfg).errors.length > 0, 'engine: ' + JSON.stringify(cfg));
    assert.ok(ui.validateConfig(cfg).errors.length > 0, 'UI: ' + JSON.stringify(cfg));
  }
});

test('mock server UI (tools/ui-mock-server.js) má stejnou výchozí konfiguraci jako engine', () => {
  const mock = require('../tools/ui-mock-server.js');
  assert.deepStrictEqual(plain(mock.DEFAULT_CONFIG), plain(presets.DEFAULT_CONFIG));
});

test('C3: režimy sjednocení skupiny v UI = režimy enginu (s popiskem a nápovědou)', async () => {
  const ui = await loadUi();
  assert.deepStrictEqual(ui.GROUP_ALIGN_MODES.map((m) => m.value).sort(), [...presets.GROUP_ALIGN_MODES].sort());
  for (const m of ui.GROUP_ALIGN_MODES) assert.ok(m.label && m.help, 'režim ' + m.value);
  for (const align of presets.GROUP_ALIGN_MODES) {
    assert.deepStrictEqual(presets.normalizeConfig({ group: { align } }).errors, [], 'engine ' + align);
    assert.deepStrictEqual(ui.validateConfig({ group: { align } }).errors, [], 'UI ' + align);
  }
  assert.deepStrictEqual(ui.validateConfig({ competitors: { max_delivery_days: 3 } }).errors, []);
  assert.deepStrictEqual(presets.normalizeConfig({ competitors: { max_delivery_days: 3 } }).errors, []);
});
