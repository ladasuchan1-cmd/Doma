'use strict';
// Každý kód, který engine může vrátit (příznaky, důvody rozhodnutí, důvody vyřazení nabídky, kódy vyzkoušených
// strategií, kroky vysvětlení), musí mít v UI český popisek – jinak by se uživateli ukázal surový kód.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const pricing = require('../src/engine/pricing.js');
const market = require('../src/engine/market.js');

const ROOT = path.join(__dirname, '..');
const loadFormat = () => import(pathToFileURL(path.join(ROOT, 'public', 'lib', 'format.js')).href);
const src = (f) => fs.readFileSync(path.join(ROOT, 'src', 'engine', f), 'utf8');
const literals = (text, re) => [...new Set([...text.matchAll(re)].map((m) => m[1]))];

const hasLabel = (map, code) => Object.prototype.hasOwnProperty.call(map, code) && typeof map[code] === 'string' && map[code].trim() !== '' && map[code] !== code;

test('příznaky rozhodnutí (FLAG_LABELS enginu i všechna volání flag()) mají český popisek, nápovědu a závažnost', async () => {
  const f = await loadFormat();
  const flags = new Set([...Object.keys(pricing.FLAG_LABELS), ...pricing.BLOCKING_FLAGS, ...literals(src('pricing.js'), /flag\('([a-z_]+)'\)/g)]);
  assert.ok(flags.has('ceiling_over_change_limit') && flags.has('rounding_skipped'));
  for (const code of flags) {
    assert.ok(hasLabel(f.FLAG_LABELS, code), 'chybí popisek příznaku ' + code);
    assert.ok(f.FLAG_HELP[code], 'chybí nápověda příznaku ' + code);
    assert.ok(f.FLAG_SEVERITY[code], 'chybí závažnost příznaku ' + code);
    assert.notStrictEqual(f.flagLabel(code), code);
  }
});

test('důvody rozhodnutí (REASON_LABELS enginu, skip()/noChange(), base_missing) mají český popisek', async () => {
  const f = await loadFormat();
  const p = src('pricing.js');
  const reasons = new Set([
    ...Object.keys(pricing.REASON_LABELS),
    ...literals(p, /skip\(d, '([a-z_]+)'\)/g),
    ...literals(p, /noChange\(d, '([a-z_]+)'\)/g),
    ...literals(p, /missing = '([a-z_]+)'/g),
    ...literals(p, /hold = '([a-z_]+)'/g),
  ]);
  for (const code of ['no_price_point', 'invalid_vat', 'invalid_config', 'invalid_target', 'keep', 'same_price', 'clearance_wait', 'fallthrough', 'no_competitor']) {
    assert.ok(reasons.has(code), 'engine už nevrací ' + code + '? (upravte test)');
  }
  for (const code of reasons) {
    assert.ok(hasLabel(f.REASON_LABELS, code), 'chybí popisek důvodu ' + code);
    assert.notStrictEqual(f.reasonLabel(code), code);
  }
});

test('kódy vyzkoušených strategií a statistik běhu (run.js) mají český popisek', async () => {
  const f = await loadFormat();
  const run = src('run.js');
  // tried[].code (disabled/segment/conditions/schedule, base_missing, action) + klíče stats.skipped / no_change_reasons
  const codes = new Set([...literals(run, /code: '([a-z_]+)'/g), 'change', 'no_change', 'skip', 'fallthrough', 'not_applicable', 'none', 'unknown', 'no_strategy']);
  assert.ok(codes.has('conditions') && codes.has('schedule') && codes.has('segment'));
  for (const code of codes) assert.ok(hasLabel(f.REASON_LABELS, code), 'chybí popisek kódu ' + code);
  for (const r of literals(run, /result: '([a-z_]+)'/g)) assert.ok(hasLabel(f.TRIED_RESULT_LABELS, r), 'chybí popisek výsledku ' + r);
});

test('důvody vyřazení nabídky z trhu (EXCLUDE_REASONS) mají český popisek', async () => {
  const f = await loadFormat();
  const codes = new Set([...Object.keys(market.EXCLUDE_REASONS), ...literals(src('market.js'), /reason: '([a-z_]+)'/g)]);
  for (const code of ['keyword', 'invalid_price', 'outlier', 'stale', 'out_of_stock']) assert.ok(codes.has(code), code);
  for (const code of codes) {
    assert.ok(hasLabel(f.EXCLUDED_LABELS, code), 'chybí popisek vyřazení ' + code);
    assert.notStrictEqual(f.excludedLabel(code), code);
  }
});

test('kroky vysvětlení (explain[].step) mají český popisek', async () => {
  const f = await loadFormat();
  const steps = new Set([...literals(src('pricing.js'), /say\('([a-z_]+)'/g), ...literals(src('run.js'), /step: '([a-z_]+)'/g)]);
  assert.ok(steps.size >= 10);
  for (const s of steps) assert.ok(hasLabel(f.STEP_LABELS, s), 'chybí popisek kroku ' + s);
});

test('filtr příznaků v Návrzích nabízí všechny příznaky enginu', async () => {
  const f = await loadFormat();
  for (const code of Object.keys(pricing.FLAG_LABELS)) assert.ok(f.FLAG_LABELS[code], code);
});
