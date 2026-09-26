'use strict';
// Testy modelu strategie (public/lib/strategy-model.js) – výchozí hodnoty SPEC §6.5, zaokrouhlení §6.6, popis.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'lib', 'strategy-model.js')).href);
const norm = (s) => String(s).replace(/[  ]/g, ' ').replace(/−/g, '-');

test('DEFAULT_CONFIG odpovídá SPEC §6.5 a enginu (podrobné srovnání v ui-strategy-sync)', async () => {
  const m = await load();
  const d = m.DEFAULT_CONFIG;
  assert.strictEqual(d.target.mode, 'undercut_min');
  assert.deepStrictEqual(d.competitors, { include: [], exclude: [], include_tags: [], exclude_tags: [], in_stock_only: true, include_shipping: false, max_age_days: null, outlier_pct: null, min_competitors: 1, exclude_keywords: [], max_delivery_days: null });
  assert.deepStrictEqual(d.group, { align: 'off' }, 'C3: sjednocení skupiny je ve výchozím stavu vypnuté');
  assert.deepStrictEqual(d.fallback, { mode: 'next', markup_pct: null, offset_pct: 0 });
  assert.deepStrictEqual(d.conditions, {});
  assert.deepStrictEqual(d.schedule, { valid_from: null, valid_to: null, weekdays: [], hours: null });
  assert.strictEqual(d.target.step_pct, 5);
  assert.strictEqual(d.limits.min_margin_pct, 10);
  assert.strictEqual(d.limits.max_above_msrp_pct, 0);
  assert.strictEqual(d.limits.min_change_abs, 5);
  assert.deepStrictEqual(d.rounding.bands, [{ up_to: 1000, ending: 9 }, { up_to: 10000, ending: 90 }, { up_to: null, ending: 990 }]);
  assert.deepStrictEqual(d.approval, { auto: false, auto_max_change_pct: 5 });
  const modes = ['undercut_min', 'match_min', 'rank', 'market_avg', 'market_median', 'competitor', 'msrp', 'cost_plus', 'keep', 'fixed', 'clearance'];
  assert.deepStrictEqual(m.TARGET_MODES.map((x) => x.value).sort(), modes.sort());
  for (const x of m.TARGET_MODES) assert.ok(x.label && x.help.length > 30, x.value);
  assert.deepStrictEqual(m.FALLBACK_MODES.map((x) => x.value), ['next', 'keep', 'msrp', 'cost_plus']);
});

test('podmínky, časové okno a doprodej: mergeConfig, validace a popis', async () => {
  const m = await load();
  const c = m.mergeConfig({});
  assert.deepStrictEqual(c.schedule.weekdays, []);
  assert.deepStrictEqual(c.conditions, {});
  assert.strictEqual(c.target.step_pct, 5);
  assert.deepStrictEqual(m.mergeConfig({ conditions: null, schedule: null }).schedule.weekdays, [], 'null = bez omezení');
  const s = norm(m.describeStrategy({ schedule: { weekdays: [6, 7], hours: [18, 24] }, conditions: { field: 'stock', op: '>', value: 0 }, target: { mode: 'clearance', step_pct: 5, every_days: 14, max_sales_30: 0 }, fallback: { mode: 'next' } }, { fieldsMap: new Map([['stock', { label: 'Sklad' }]]) }));
  assert.match(s, /každých 14 dní zlevní o 5 %/);
  assert.match(s, /Navíc jen pro produkty, kde Sklad je větší než 0\./);
  assert.match(s, /Platí jen so, ne, od 18 do 24 h/);
  assert.match(s, /Když chybí základ ceny \(chybí aktuální cena\), produkt propadne na další strategii v pořadí\./);
  assert.ok(m.validateConfig({ schedule: { valid_from: '2026-10-02T00:00:00Z', valid_to: '2026-10-01T00:00:00Z' } }).errors.length);
  assert.ok(m.validateConfig({ schedule: { hours: [5, 5] } }).errors.length);
  assert.ok(m.validateConfig({ target: { mode: 'clearance', step_pct: 0 } }).errors.length);
  assert.ok(m.validateConfig({ conditions: { field: 'x', op: 'nesmysl', value: 1 } }).errors.length);
  assert.deepStrictEqual(m.validateConfig({ conditions: { all: [{ field: 'position', op: '=', value: 'cheapest' }] } }).errors, []);
});

test('krátké souhrny do seznamu strategií: podmínky a platnost', async () => {
  const m = await load();
  const cond = { all: [{ field: 'position', op: '=', value: 'cheapest' }, { field: 'gap_min_pct', op: '<=', value: -5 }] };
  assert.strictEqual(norm(m.describeConditionsShort(cond)), 'pozice = nejlevnější a rozdíl ≤ -5 %');
  assert.strictEqual(m.describeConditionsShort({}), '');
  assert.strictEqual(norm(m.describeConditionsShort({ field: 'attrs.N', op: 'in', value: ['N7', 'N8'] })), 'N = N7 / N8');
  assert.strictEqual(norm(m.describeConditionsShort({ any: [{ field: 'stock', op: '>', value: 0 }, { field: 'has_stock', op: 'is_false' }] })), 'sklad > 0 ks nebo ne skladem');
  assert.strictEqual(norm(m.describeConditionsShort({ field: 'attrs.sezona', op: '<', value: 2026 }, new Map([['attrs.sezona', { label: 'sezona' }]]))), 'sezona < 2026');
  assert.strictEqual(m.describeScheduleShort({ weekdays: [6, 7] }), 'so–ne');
  assert.strictEqual(m.describeScheduleShort({ weekdays: [1, 2, 3, 4, 5] }), 'po–pá');
  assert.strictEqual(m.describeScheduleShort({ weekdays: [1, 3, 5] }), 'po, st, pá');
  assert.strictEqual(norm(m.describeScheduleShort({ weekdays: [6, 7], hours: [18, 24] })), 'so–ne, 18–24 h');
  assert.strictEqual(m.describeScheduleShort({ weekdays: [], hours: null, valid_from: null, valid_to: null }), '');
  assert.strictEqual(m.describeScheduleShort({ weekdays: [1, 2, 3, 4, 5, 6, 7] }), '', 'všechny dny = bez omezení');
  assert.match(norm(m.describeScheduleShort({ valid_to: '2026-10-31T12:00:00Z' })), /^do 31\. 10\. 2026/);
  const now = Date.parse('2026-09-25T12:00:00Z');
  assert.strictEqual(m.scheduleState({ weekdays: [] }, now), 'none');
  assert.strictEqual(m.scheduleState({ valid_to: '2026-09-01T00:00:00Z' }, now), 'expired');
  assert.strictEqual(m.scheduleState({ valid_from: '2026-10-01T00:00:00Z' }, now), 'future');
  assert.strictEqual(m.scheduleState({ weekdays: [6, 7] }, now), 'window');
});

test('nápověda existuje pro každou volbu konfigurace', async () => {
  const m = await load();
  const leafPaths = [];
  const walk = (o, p) => {
    for (const [k, v] of Object.entries(o)) {
      const pp = p ? p + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, pp);
      else leafPaths.push(pp);
    }
  };
  walk(m.DEFAULT_CONFIG, '');
  // target.mode má nápovědu u každého režimu (TARGET_MODES), ostatní volby v HELP
  for (const p of leafPaths) if (p !== 'target.mode' && p !== 'rounding.bands') assert.ok(m.HELP[p] || p === 'conditions', 'chybí nápověda: ' + p);
  for (const p of ['schedule.valid_from', 'schedule.valid_to', 'schedule.weekdays', 'schedule.hours', 'conditions']) assert.ok(m.HELP[p], 'chybí nápověda: ' + p);
});

test('roundPrice / priceCandidates podle SPEC §6.6', async () => {
  const m = await load();
  const r = m.DEFAULT_CONFIG.rounding;
  assert.strictEqual(m.roundPrice(12345, r), 11990);
  assert.strictEqual(m.roundPrice(12345, r, 'up'), 12990);
  assert.strictEqual(m.roundPrice(12345, r, 'nearest'), 11990);
  assert.strictEqual(m.roundPrice(12600, r, 'nearest'), 12990);
  assert.strictEqual(m.roundPrice(8765, r), 8690);
  assert.strictEqual(m.roundPrice(449.5, r), 449);
  assert.strictEqual(m.roundPrice(999, r), 999, 'přesně na cenovém bodu');
  assert.strictEqual(m.roundPrice(5, r), 9, 'down ≤ 0 → up');
  assert.deepStrictEqual(m.priceCandidates(1234, r), { down: 1190, up: 1290 });
  assert.strictEqual(m.stepFor({ ending: 9 }), 10);
  assert.strictEqual(m.stepFor({ ending: 99 }), 100);
  assert.strictEqual(m.stepFor({ ending: 490 }), 1000);
  assert.strictEqual(m.stepFor({ ending: 0 }), 1);
  assert.strictEqual(m.stepFor({ ending: 5, step: 50 }), 50);
  assert.strictEqual(m.roundPrice(1234.56, { mode: 'integer', direction: 'down' }), 1234);
  assert.strictEqual(m.roundPrice(1234.56, { mode: 'integer' }, 'up'), 1235);
  assert.strictEqual(m.roundPrice(1234.567, { mode: 'none' }), 1234.57);
  assert.strictEqual(m.bandFor(5000, r.bands).ending, 90);
});

test('validateConfig', async () => {
  const m = await load();
  assert.deepStrictEqual(m.validateConfig({}).errors, []);
  assert.ok(m.validateConfig({ limits: { min_margin_pct: 100 } }).errors.length);
  assert.ok(m.validateConfig({ target: { mode: 'competitor' } }).errors.some((e) => /konkurenta/.test(e)));
  assert.ok(m.validateConfig({ target: { mode: 'rank', rank: 0 } }).errors.length);
  assert.ok(m.validateConfig({ target: { mode: 'fixed' } }).errors.length);
  assert.ok(m.validateConfig({ rounding: { mode: 'ending', bands: [{ up_to: null, ending: 10, step: 10 }] } }).errors.length, 'konec ≥ krok');
  assert.ok(m.validateConfig({ rounding: { mode: 'ending', bands: [{ up_to: null, ending: 9 }, { up_to: 100, ending: 9 }] } }).errors.length, 'bez meze musí být poslední');
  assert.ok(m.validateConfig({ limits: { allow_increase: false, allow_decrease: false } }).warnings.length);
  assert.ok(m.validateConfig({ limits: { min_margin_pct: null, min_profit_abs: null } }).warnings.length);
});

test('mergeConfig – pole se nahrazují, zbytek se doplní', async () => {
  const m = await load();
  const c = m.mergeConfig({ competitors: { exclude: ['X'] }, rounding: { bands: [{ up_to: null, ending: 90 }] } });
  assert.deepStrictEqual(c.competitors.exclude, ['X']);
  assert.strictEqual(c.competitors.in_stock_only, true);
  assert.deepStrictEqual(c.rounding.bands, [{ up_to: null, ending: 90 }]);
  assert.strictEqual(c.rounding.direction, 'down');
  const d = m.mergeConfig({});
  d.competitors.include.push('Y');
  assert.deepStrictEqual(m.DEFAULT_CONFIG.competitors.include, [], 'výchozí konfigurace se nesmí měnit');
});

test('describeStrategy – lidsky čitelné shrnutí', async () => {
  const m = await load();
  const s = norm(m.describeStrategy({ target: { mode: 'undercut_min', offset_pct: -1 }, limits: { min_margin_pct: 3, max_decrease_pct: 15 } }, { segmentName: 'Ležáky N7/N8' }));
  assert.match(s, /^Pro segment „Ležáky N7\/N8“ nastaví cenu o 1 % pod nejnižší cenou konkurence\./);
  assert.match(s, /minimální marži 3 %/);
  assert.match(s, /sníží nejvýše o 15 %/);
  assert.match(s, /Zaokrouhlí dolů na konce …9 do 1 000 Kč, …90 do 10 000 Kč, …990 nad 10 000 Kč\./);
  assert.match(s, /Všechny návrhy čekají na ruční schválení\./);
  const auto = norm(m.describeStrategy({ target: { mode: 'market_median', offset_pct: -2 }, approval: { auto: true, auto_max_change_pct: 3 }, stock: { zero_stock: 'skip' } }));
  assert.match(auto, /^Pro všechny produkty nastaví cenu o 2 % pod mediánem trhu\./);
  assert.match(auto, /Změny do ±3 % schválí automaticky/);
  assert.match(auto, /Produkty bez skladu nepřeceňuje\./);
  assert.match(norm(m.describeStrategy({ target: { mode: 'cost_plus', markup_pct: 40 } })), /nákup \+ 40 %/);
  assert.doesNotMatch(norm(m.describeStrategy({ target: { mode: 'msrp' } })), /Počítá jen nabídky/, 'nemarketové režimy bez filtru trhu');
  assert.match(norm(m.describeStrategy({ target: { mode: 'msrp' }, fallback: { mode: 'keep' } })), /Když chybí základ ceny \(chybí MOC\), cenu ponechá/);
  assert.doesNotMatch(norm(m.describeStrategy({ target: { mode: 'fixed', fixed_price: 999 } })), /základ ceny/, 'pevná cena nemá náhradní režim');
  assert.match(norm(m.describeStrategy({ target: { mode: 'rank', rank: 2, offset_abs: -1 } })), /o 1 Kč pod cenou konkurenta na 2\. místě/);
  assert.match(norm(m.describeStrategy({ target: { mode: 'undercut_min', offset_pct: -1, offset_abs: 10 } })), /posun -1 % \+10 Kč od nejnižší ceny konkurence/);
});

test('describeTargetShort a describeLimitsShort', async () => {
  const m = await load();
  assert.strictEqual(norm(m.describeTargetShort({ target: { mode: 'undercut_min', offset_pct: -1 } })), 'Nejnižší cena -1 %');
  assert.strictEqual(norm(m.describeTargetShort({ target: { mode: 'rank', rank: 2, offset_abs: -1 } })), 'Pozice 2 -1 Kč');
  assert.strictEqual(m.describeTargetShort({ target: { mode: 'keep' } }), 'Ponechat cenu');
  assert.strictEqual(norm(m.describeLimitsShort({})), 'marže ≥ 10 % · ≤ MOC · -10 % · +15 %');
});
