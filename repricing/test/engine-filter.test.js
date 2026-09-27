'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compileFilter, validateFilter, FilterError, isEmptyFilter } = require('../src/engine/filter.js');

const view = {
  code: 'ABC-1',
  name: 'Horské kolo Škoda',
  manufacturer: 'Cervélo',
  margin_pct: 12.5,
  price: 12990,
  stock: 0,
  note: null,
  empty_str: '  ',
  position: 'cheapest',
  locked: 1,
  active: 0,
  lock_active: false,
  attrs: { N: 'N7', sezona: 2024, imprese_30: '150', 'PARAM.Barva': 'Černá', nested: { x: 5 }, ano: 'ano' },
};
const m = (f) => compileFilter(f)(view);

test('filter: prázdné filtry a skupiny', () => {
  assert.equal(m({}), true);
  assert.equal(m(null), true);
  assert.equal(m({ all: [] }), true);
  assert.equal(m({ any: [] }), false);
  assert.equal(m({ not: {} }), false);
  assert.equal(m({ all: [{ field: 'stock', op: '=', value: 0 }, { field: 'position', op: '=', value: 'cheapest' }] }), true);
  assert.equal(m({ all: [{ field: 'stock', op: '=', value: 0 }, { field: 'position', op: '=', value: 'middle' }] }), false);
  assert.equal(m({ any: [{ field: 'stock', op: '=', value: 1 }, { field: 'position', op: '=', value: 'cheapest' }] }), true);
  assert.equal(m({ not: { field: 'position', op: '=', value: 'cheapest' } }), false);
  assert.equal(m('{"field":"code","op":"=","value":"abc-1"}'), true, 'JSON text');
  assert.equal(isEmptyFilter({}), true);
  assert.equal(isEmptyFilter({ all: [] }), true);
  assert.equal(isEmptyFilter({ any: [] }), false);
});

test('filter: řetězce bez ohledu na velikost písmen a diakritiku', () => {
  assert.equal(m({ field: 'manufacturer', op: '=', value: 'cervelo' }), true);
  assert.equal(m({ field: 'manufacturer', op: '!=', value: 'CERVÉLO' }), false);
  assert.equal(m({ field: 'name', op: 'contains', value: 'SKODA' }), true);
  assert.equal(m({ field: 'name', op: 'not_contains', value: 'škoda' }), false);
  assert.equal(m({ field: 'name', op: 'starts_with', value: 'horske' }), true);
  assert.equal(m({ field: 'name', op: 'starts_with', value: 'kolo' }), false);
});

test('filter: čísla (parseNumber na obou stranách, nečíselné → false)', () => {
  assert.equal(m({ field: 'margin_pct', op: '>', value: '12,4' }), true);
  assert.equal(m({ field: 'margin_pct', op: '>=', value: 12.5 }), true);
  assert.equal(m({ field: 'margin_pct', op: '<', value: 12.5 }), false);
  assert.equal(m({ field: 'margin_pct', op: '<=', value: '12.5' }), true);
  assert.equal(m({ field: 'attrs.imprese_30', op: '>', value: 100 }), true, 'číselný text v atributu');
  assert.equal(m({ field: 'name', op: '>', value: 5 }), false);
  assert.equal(m({ field: 'margin_pct', op: '=', value: '12,5' }), true);
  assert.equal(m({ field: 'attrs.sezona', op: '=', value: '2024' }), true);
  assert.equal(m({ field: 'price', op: 'between', value: [12000, 13000] }), true);
  assert.equal(m({ field: 'price', op: 'between', value: [12990, 12990] }), true, 'včetně mezí');
  assert.equal(m({ field: 'price', op: 'between', value: [13000, 12000] }), true, 'obrácené meze');
  assert.equal(m({ field: 'price', op: 'between', value: [13000, 14000] }), false);
  assert.equal(m({ field: 'name', op: 'between', value: [1, 2] }), false);
});

test('filter: in / not_in (pole i text s čárkami)', () => {
  assert.equal(m({ field: 'attrs.N', op: 'in', value: ['N7', 'N8'] }), true);
  assert.equal(m({ field: 'attrs.N', op: 'in', value: 'n7, n8' }), true);
  assert.equal(m({ field: 'attrs.N', op: 'not_in', value: ['N7'] }), false);
  assert.equal(m({ field: 'attrs.N', op: 'not_in', value: 'N1,N2' }), true);
  assert.equal(m({ field: 'stock', op: 'in', value: ['0', '1'] }), true);
});

test('filter: chybějící hodnota – true jen pro empty, not_in, !=, not_contains, is_false', () => {
  for (const field of ['note', 'missing', 'attrs.missing', 'empty_str']) {
    const r = (op, value) => m({ field, op, value });
    assert.equal(r('empty'), true, field);
    assert.equal(r('not_in', ['x']), true);
    assert.equal(r('!=', 'x'), true);
    assert.equal(r('not_contains', 'x'), true);
    assert.equal(r('is_false'), true);
    assert.equal(r('not_empty'), false);
    assert.equal(r('=', 'x'), false);
    assert.equal(r('in', ['x']), false);
    assert.equal(r('contains', 'x'), false);
    assert.equal(r('starts_with', 'x'), false);
    assert.equal(r('>', 0), false);
    assert.equal(r('<', 0), false);
    assert.equal(r('between', [0, 1]), false);
    assert.equal(r('is_true'), false);
  }
});

test('filter: is_true / is_false a boolean pole 1/0', () => {
  assert.equal(m({ field: 'locked', op: 'is_true' }), true);
  assert.equal(m({ field: 'active', op: 'is_true' }), false);
  assert.equal(m({ field: 'active', op: 'is_false' }), true);
  assert.equal(m({ field: 'lock_active', op: 'is_false' }), true);
  assert.equal(m({ field: 'attrs.ano', op: 'is_true' }), true);
  assert.equal(m({ field: 'locked', op: '=', value: true }), true);
  assert.equal(m({ field: 'lock_active', op: '=', value: false }), true);
});

test('filter: tečkové cesty včetně klíčů atributů s tečkou', () => {
  assert.equal(m({ field: 'attrs.PARAM.Barva', op: '=', value: 'cerna' }), true);
  assert.equal(m({ field: 'attrs.nested.x', op: '=', value: 5 }), true);
  assert.equal(m({ field: 'attrs.nested.y', op: 'empty' }), true);
});

test('filter: validace a FilterError s českou zprávou', () => {
  assert.deepEqual(validateFilter({}), { ok: true, errors: [] });
  assert.equal(validateFilter({ field: 'x', op: 'like', value: 1 }).ok, false);
  assert.throws(() => compileFilter({ field: 'x', op: 'like', value: 1 }), (e) => e instanceof FilterError && /operátor/.test(e.message));
  assert.throws(() => compileFilter({ all: {} }), FilterError);
  assert.throws(() => compileFilter({ all: [], any: [] }), FilterError);
  assert.throws(() => compileFilter({ foo: 1 }), FilterError);
  assert.throws(() => compileFilter({ op: '=', value: 1 }), FilterError);
  assert.throws(() => compileFilter({ field: 'price', op: 'between', value: [1] }), FilterError);
  // nečíselná hodnota u číselného operátoru není chyba struktury – podmínka jen neplatí
  assert.equal(compileFilter({ field: 'price', op: '>', value: 'abc' })(view), false);
  assert.equal(compileFilter({ field: 'price', op: 'between', value: ['a', 'z'] })(view), false);
  assert.throws(() => compileFilter({ field: 'price', op: '=' }), FilterError);
  assert.throws(() => compileFilter([1, 2]), FilterError);
  assert.throws(() => compileFilter('{nejson'), FilterError);
  assert.throws(() => compileFilter({ all: [{ field: 'a', op: '=', value: 1 }, { not: 5 }] }), (e) => e.errors.length === 1 && e.errors[0].includes('filtr.all[1].not'));
});
