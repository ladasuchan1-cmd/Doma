'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_CONFIG, normalizeConfig, STRATEGY_PRESETS } = require('../src/engine/presets.js');
const { validateFilter } = require('../src/engine/filter.js');
const engine = require('../src/engine/index.js');

const errs = (cfg) => normalizeConfig(cfg).errors;
const hasErr = (cfg, needle) => errs(cfg).some((e) => e.includes(needle));

test('config: DEFAULT_CONFIG odpovídá SPEC §6.5 a je zmrazený', () => {
  assert.deepEqual(DEFAULT_CONFIG.target, { mode: 'undercut_min', offset_abs: 0, offset_pct: 0, rank: 1, competitor: null, markup_pct: null, fixed_price: null, step_pct: 5, every_days: 14, max_sales_30: 0 });
  assert.deepEqual(DEFAULT_CONFIG.limits, {
    min_margin_pct: 10, min_profit_abs: null, max_margin_pct: null, max_above_msrp_pct: 0, max_below_msrp_pct: null,
    max_decrease_pct: 10, max_increase_pct: 15, allow_increase: true, allow_decrease: true, min_change_pct: 0.5, min_change_abs: 5,
    respect_product_limits: true,
  });
  assert.deepEqual(DEFAULT_CONFIG.competitors, {
    include: [], exclude: [], include_tags: [], exclude_tags: [], in_stock_only: true, include_shipping: false, max_age_days: null,
    outlier_pct: null, min_competitors: 1, exclude_keywords: [],
  });
  assert.deepEqual(DEFAULT_CONFIG.fallback, { mode: 'next', markup_pct: null, offset_pct: 0 });
  assert.deepEqual(DEFAULT_CONFIG.rounding, { mode: 'ending', direction: 'down', bands: [{ up_to: 1000, ending: 9 }, { up_to: 10000, ending: 90 }, { up_to: null, ending: 990 }] });
  assert.deepEqual(DEFAULT_CONFIG.schedule, { valid_from: null, valid_to: null, weekdays: [], hours: null });
  assert.deepEqual(DEFAULT_CONFIG.stock, { zero_stock: 'reprice' });
  assert.deepEqual(DEFAULT_CONFIG.approval, { auto: false, auto_max_change_pct: 5 });
  assert.deepEqual(DEFAULT_CONFIG.conditions, {});
  assert.ok(Object.isFrozen(DEFAULT_CONFIG.limits));
  assert.equal(engine.DEFAULT_CONFIG, DEFAULT_CONFIG);
});

test('config: normalizeConfig doplní výchozí hodnoty (hluboké sloučení, pole se nahrazují)', () => {
  const { config, errors } = normalizeConfig({ target: { mode: 'rank', rank: 2 }, limits: { min_margin_pct: 18 }, rounding: { bands: [{ up_to: null, ending: 9 }] } });
  assert.deepEqual(errors, []);
  assert.equal(config.target.mode, 'rank');
  assert.equal(config.target.rank, 2);
  assert.equal(config.target.step_pct, 5);
  assert.equal(config.limits.min_margin_pct, 18);
  assert.equal(config.limits.max_decrease_pct, 10);
  assert.deepEqual(config.rounding.bands, [{ up_to: null, ending: 9 }]);
  assert.equal(config.rounding.direction, 'down');
  // nesdílí objekty s DEFAULT_CONFIG
  config.competitors.include.push('x');
  assert.deepEqual(DEFAULT_CONFIG.competitors.include, []);
  for (const empty of [undefined, null, {}, '', '{}']) assert.deepEqual(normalizeConfig(empty), { config: structuredClone(DEFAULT_CONFIG), errors: [] });
  assert.equal(normalizeConfig('{"target":{"mode":"msrp"}}').config.target.mode, 'msrp');
});

test('config: převody hodnot z formulářů', () => {
  const { config, errors } = normalizeConfig({
    target: { offset_pct: '-1,5', offset_abs: null },
    limits: { min_margin_pct: '12', allow_increase: 'ne', allow_decrease: 0, min_change_abs: '' },
    competitors: { exclude: 'Alza, Mall ', exclude_keywords: ['bazar', ' ', 'demo'], in_stock_only: 'false' },
    approval: { auto: 1 },
    schedule: { weekdays: '6,7', hours: [18, 24] },
  });
  assert.deepEqual(errors, []);
  assert.equal(config.target.offset_pct, -1.5);
  assert.equal(config.target.offset_abs, 0);
  assert.equal(config.limits.min_margin_pct, 12);
  assert.equal(config.limits.allow_increase, false);
  assert.equal(config.limits.allow_decrease, false);
  assert.equal(config.limits.min_change_abs, 0);
  assert.deepEqual(config.competitors.exclude, ['Alza', 'Mall']);
  assert.deepEqual(config.competitors.exclude_keywords, ['bazar', 'demo']);
  assert.equal(config.competitors.in_stock_only, false);
  assert.equal(config.approval.auto, true);
  assert.deepEqual(config.schedule.weekdays, [6, 7]);
  assert.deepEqual(config.schedule.hours, [18, 24]);
});

test('config: validace rozsahů a typů (české chyby)', () => {
  assert.ok(hasErr({ limits: { min_margin_pct: 100 } }, 'limits.min_margin_pct'));
  assert.ok(hasErr({ limits: { min_margin_pct: -1 } }, 'limits.min_margin_pct'));
  assert.deepEqual(errs({ limits: { min_margin_pct: 99.9 } }), []);
  assert.deepEqual(errs({ limits: { min_margin_pct: 0 } }), []);
  assert.deepEqual(errs({ limits: { min_margin_pct: null } }), []);
  assert.ok(hasErr({ limits: { min_margin_pct: 'hodně' } }, 'musí být číslo'));
  assert.ok(hasErr({ limits: { max_margin_pct: 5, min_margin_pct: 10 } }, 'max_margin_pct'));
  assert.ok(hasErr({ limits: { max_decrease_pct: 120 } }, 'max_decrease_pct'));
  assert.ok(hasErr({ limits: { max_increase_pct: -5 } }, 'max_increase_pct'));
  assert.ok(hasErr({ limits: { max_below_msrp_pct: 100 } }, 'max_below_msrp_pct'));
  assert.ok(hasErr({ limits: { allow_increase: 'možná' } }, 'allow_increase'));
  assert.ok(hasErr({ target: { rank: 0 } }, 'target.rank'));
  assert.ok(hasErr({ target: { rank: 1.5 } }, 'celé číslo'));
  assert.ok(hasErr({ target: { mode: 'cheapest' } }, 'target.mode'));
  assert.ok(hasErr({ target: { mode: 'competitor' } }, 'target.competitor'));
  assert.ok(hasErr({ target: { mode: 'cost_plus' } }, 'target.markup_pct'));
  assert.ok(hasErr({ target: { mode: 'fixed' } }, 'target.fixed_price'));
  assert.ok(hasErr({ target: { mode: 'fixed', fixed_price: 0 } }, 'target.fixed_price'));
  assert.ok(hasErr({ target: { step_pct: 0 } }, 'target.step_pct'));
  assert.ok(hasErr({ target: { step_pct: 100 } }, 'target.step_pct'));
  assert.ok(hasErr({ fallback: { mode: 'panic' } }, 'fallback.mode'));
  assert.ok(hasErr({ fallback: { mode: 'cost_plus' } }, 'fallback.markup_pct'));
  assert.deepEqual(errs({ fallback: { mode: 'cost_plus' }, target: { markup_pct: 30 } }), []);
  assert.ok(hasErr({ competitors: { min_competitors: 0 } }, 'min_competitors'));
  assert.ok(hasErr({ competitors: { outlier_pct: 100 } }, 'outlier_pct'));
  assert.ok(hasErr({ competitors: { max_age_days: 0 } }, 'max_age_days'));
  assert.ok(hasErr({ rounding: { mode: 'banker' } }, 'rounding.mode'));
  assert.ok(hasErr({ rounding: { direction: 'left' } }, 'rounding.direction'));
  assert.ok(hasErr({ rounding: { bands: [{ up_to: 10000, ending: 90 }, { up_to: 1000, ending: 9 }] } }, 'vzestupně'));
  assert.ok(hasErr({ rounding: { bands: [{ up_to: null, ending: 10, step: 10 }] } }, 'menší než krok'));
  assert.ok(hasErr({ stock: { zero_stock: 'hide' } }, 'stock.zero_stock'));
  assert.ok(hasErr({ approval: { auto_max_change_pct: -1 } }, 'auto_max_change_pct'));
  assert.ok(hasErr({ schedule: { weekdays: [0, 8] } }, 'schedule.weekdays'));
  assert.ok(hasErr({ schedule: { hours: [18] } }, 'schedule.hours'));
  assert.ok(hasErr({ schedule: { hours: [5, 5] } }, 'schedule.hours'));
  assert.ok(hasErr({ schedule: { valid_from: 'zítra' } }, 'schedule.valid_from'));
  assert.ok(hasErr({ schedule: { valid_from: '2026-10-02', valid_to: '2026-10-01' } }, 'schedule'));
  assert.ok(hasErr({ conditions: { field: 'x', op: 'like' } }, 'conditions'));
  assert.ok(hasErr({ limits: 5 }, 'limits: musí být objekt'));
  assert.ok(hasErr('{nejson', 'JSON'));
  assert.ok(hasErr([1], 'objekt'));
  // neplatná hodnota → v configu zůstane výchozí
  const { config } = normalizeConfig({ limits: { min_margin_pct: 150 }, target: { mode: 'x' } });
  assert.equal(config.limits.min_margin_pct, 10);
  assert.equal(config.target.mode, 'undercut_min');
});

test('presets: všechny předvolby jsou platné a úplné', () => {
  const keys = new Set();
  for (const p of STRATEGY_PRESETS) {
    assert.ok(p.key && !keys.has(p.key), p.key);
    keys.add(p.key);
    assert.ok(p.name && p.description, p.key);
    assert.deepEqual(normalizeConfig(p.config).errors, [], p.key);
    if (p.segment) {
      assert.ok(p.segment.name);
      assert.equal(validateFilter(p.segment.filter).ok, true, p.key);
    }
    assert.equal(validateFilter(p.config.conditions).ok, true);
  }
  const byName = Object.fromEntries(STRATEGY_PRESETS.map((p) => [p.name, p]));
  for (const n of [
    'Ležáky N7/N8 – doprodej',
    'Klíčové značky – držet pozici 2',
    'Bez konkurence → MOC',
    'Výchozí – medián trhu −2 %',
    'Návrat marže – jsme výrazně nejlevnější',
    'Doprodej bez prodejů – postupné slevy',
    'Víkendová akce',
  ])
    assert.ok(byName[n], `chybí předvolba ${n}`);
  const n78 = byName['Ležáky N7/N8 – doprodej'];
  assert.deepEqual(n78.segment.filter, { field: 'attrs.N', op: 'in', value: ['N7', 'N8'] });
  assert.equal(n78.config.target.mode, 'undercut_min');
  assert.equal(n78.config.target.offset_pct, -1);
  assert.equal(n78.config.limits.min_margin_pct, 3);
  assert.equal(n78.config.limits.max_decrease_pct, 15);
  const key = byName['Klíčové značky – držet pozici 2'];
  assert.equal(key.config.target.rank, 2);
  assert.equal(key.config.limits.min_margin_pct, 18);
  assert.equal(key.config.limits.max_above_msrp_pct, 0);
  assert.equal(byName['Bez konkurence → MOC'].config.target.mode, 'msrp');
  assert.deepEqual(byName['Bez konkurence → MOC'].segment.filter, { field: 'market_count', op: '=', value: 0 });
  const def = byName['Výchozí – medián trhu −2 %'];
  assert.equal(def.segment, null);
  assert.equal(def.config.target.mode, 'market_median');
  assert.equal(def.config.target.offset_pct, -2);
  assert.equal(def.config.limits.min_margin_pct, 12);
  assert.equal(def.config.approval.auto, true);
  assert.equal(def.config.approval.auto_max_change_pct, 3);
  const rec = byName['Návrat marže – jsme výrazně nejlevnější'];
  assert.deepEqual(rec.config.conditions, { all: [{ field: 'position', op: '=', value: 'cheapest' }, { field: 'gap_min_pct', op: '<=', value: -5 }] });
  const cl = byName['Doprodej bez prodejů – postupné slevy'];
  assert.equal(cl.config.target.mode, 'clearance');
  assert.equal(cl.config.target.step_pct, 5);
  assert.equal(cl.config.target.every_days, 14);
  assert.equal(cl.config.target.max_sales_30, 0);
  assert.equal(cl.config.limits.min_margin_pct, 0);
  assert.equal(cl.config.limits.max_below_msrp_pct, 40);
  const wk = byName['Víkendová akce'];
  assert.equal(wk.enabled, false);
  assert.deepEqual(wk.config.schedule.weekdays, [6, 7]);
  assert.equal(wk.config.target.offset_pct, -10);
  // obecná výchozí strategie je poslední (nejnižší priorita)
  assert.equal(STRATEGY_PRESETS[STRATEGY_PRESETS.length - 1].key, def.key);
});
