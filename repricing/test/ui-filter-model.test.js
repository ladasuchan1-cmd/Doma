'use strict';
// Testy modelu filtru segmentů (public/lib/filter-model.js) – gramatika SPEC §6.4.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'lib', 'filter-model.js')).href);
const FIELDS = new Map([
  ['manufacturer', { key: 'manufacturer', label: 'Výrobce', type: 'string' }],
  ['margin_pct', { key: 'margin_pct', label: 'Marže %', type: 'number' }],
  ['position', { key: 'position', label: 'Pozice', type: 'enum' }],
  ['locked', { key: 'locked', label: 'Zamčený', type: 'boolean' }],
  ['attrs.N', { key: 'attrs.N', label: 'N', type: 'string' }],
]);

test('prázdný filtr ↔ model', async () => {
  const m = await load();
  const model = m.toModel({});
  assert.strictEqual(model.kind, 'group');
  assert.strictEqual(model.items.length, 0);
  assert.deepStrictEqual(m.fromModel(model, FIELDS).filter, {});
  assert.deepStrictEqual(m.fromModel(m.toModel(null), FIELDS).filter, {});
  assert.ok(m.isEmptyFilter({}));
  assert.ok(m.isEmptyFilter({ all: [] }));
  assert.ok(!m.isEmptyFilter({ field: 'x', op: 'empty' }));
});

test('vnořené skupiny all/any/not – tam a zpět beze ztráty', async () => {
  const m = await load();
  const f = {
    all: [
      { field: 'manufacturer', op: 'in', value: ['Trek', 'Scott'] },
      { any: [{ field: 'margin_pct', op: '>=', value: 10 }, { field: 'position', op: '=', value: 'cheapest' }] },
      { not: { all: [{ field: 'locked', op: 'is_true' }] } },
    ],
  };
  const back = m.fromModel(m.toModel(f), FIELDS);
  assert.deepStrictEqual(back.errors, []);
  assert.deepStrictEqual(back.filter, f);
  assert.strictEqual(m.countConditions(f), 4);
});

test('samotná podmínka a {not: podmínka} se zabalí do skupiny', async () => {
  const m = await load();
  assert.deepStrictEqual(m.fromModel(m.toModel({ field: 'attrs.N', op: '=', value: 'N7' }), FIELDS).filter, { all: [{ field: 'attrs.N', op: '=', value: 'N7' }] });
  assert.deepStrictEqual(m.fromModel(m.toModel({ not: { field: 'locked', op: 'is_true' } }), FIELDS).filter, { not: { all: [{ field: 'locked', op: 'is_true' }] } });
});

test('neúplné podmínky se vynechají a vrátí chybu; prázdná vnořená skupina zmizí', async () => {
  const m = await load();
  const model = m.toModel({});
  const c1 = m.newCond('manufacturer', 'in', '');
  const c2 = m.newCond('', '', '');
  const c3 = m.newCond('margin_pct', '>=', '12,5');
  const g = m.newGroup('any');
  model.items.push(c1, c2, c3, g);
  const { filter, errors } = m.fromModel(model, FIELDS);
  assert.deepStrictEqual(filter, { all: [{ field: 'margin_pct', op: '>=', value: 12.5 }] });
  assert.deepStrictEqual(errors.map((e) => e.id).sort(), [c1.id, c2.id].sort());
});

test('normalizeValue podle operátoru a typu', async () => {
  const m = await load();
  assert.deepStrictEqual(m.normalizeValue('in', 'Trek, Scott;Trek', 'string'), { ok: true, value: ['Trek', 'Scott'] });
  assert.deepStrictEqual(m.normalizeValue('in', ['1', '2,5'], 'number'), { ok: true, value: [1, 2.5] });
  assert.strictEqual(m.normalizeValue('in', 'a, x', 'number').ok, false);
  assert.deepStrictEqual(m.normalizeValue('between', ['20', '5'], 'number'), { ok: true, value: [5, 20] });
  assert.strictEqual(m.normalizeValue('between', ['1', ''], 'number').ok, false);
  assert.deepStrictEqual(m.normalizeValue('>=', '1 000', 'number'), { ok: true, value: 1000 });
  assert.deepStrictEqual(m.normalizeValue('empty', 'cokoliv', 'string'), { ok: true, value: undefined });
  assert.strictEqual(m.normalizeValue('contains', '  ', 'string').ok, false);
});

test('operátory podle typu pole', async () => {
  const m = await load();
  assert.deepStrictEqual(m.opsFor('boolean'), ['is_true', 'is_false']);
  assert.ok(m.opsFor('number').includes('between'));
  assert.ok(!m.opsFor('string').includes('between'));
  assert.ok(m.opsFor('enum').includes('in'));
  assert.ok(m.opsFor('neznamy').includes('contains'), 'neznámý typ = text');
  for (const op of m.ALL_OPS) assert.ok(m.OP_LABELS[op]);
  assert.strictEqual(m.ALL_OPS.length, 16);
});

test('validateFilter', async () => {
  const m = await load();
  assert.ok(m.validateFilter({ all: [{ field: 'a', op: '=', value: 1 }] }).ok);
  assert.ok(!m.validateFilter({ all: [{ field: 'a', op: '~', value: 1 }] }).ok);
  assert.ok(!m.validateFilter({ all: [{ field: 'a', op: '=' }] }).ok);
  assert.ok(!m.validateFilter({ foo: 1 }).ok);
  assert.ok(!m.validateFilter({ all: [{ field: 'a', op: 'between', value: [1] }] }).ok);
  assert.ok(m.validateFilter({}).ok);
});

test('describeFilter – český popis', async () => {
  const m = await load();
  const f = { all: [{ field: 'manufacturer', op: 'in', value: ['Trek', 'Scott'] }, { any: [{ field: 'margin_pct', op: '>=', value: 10 }, { field: 'position', op: '=', value: 'cheapest' }] }] };
  const s = m.describeFilter(f, FIELDS).replace(/ /g, ' ');
  assert.strictEqual(s, 'Výrobce je jedno z „Trek“ nebo „Scott“ a zároveň (Marže % je alespoň 10 nebo Pozice je rovno Nejlevnější)');
  assert.strictEqual(m.describeFilter({}, FIELDS), 'Všechny produkty');
  assert.strictEqual(m.describeFilter({ not: { field: 'locked', op: 'is_true' } }, FIELDS), 'neplatí, že Zamčený: ano');
  assert.strictEqual(m.describeFilter({ field: 'attrs.sezona', op: 'empty' }, FIELDS), 'sezona je prázdné');
});
