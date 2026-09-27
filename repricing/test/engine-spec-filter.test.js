'use strict';
// Nezávislé black-box testy src/engine/filter.js podle SPEC §6.4.
// compileFilter(filter) → (view) => boolean (FilterError při neplatné struktuře) ; validateFilter(filter) → {ok, errors}

const test = require('node:test');
const assert = require('node:assert');
const { engine } = require('./engine-spec-helpers.js');

const FL = () => engine('filter');
const match = (filter, view) => FL().compileFilter(filter)(view);
const cond = (field, op, value) => ({ field, op, value });

const VIEW = Object.freeze({
  code: 'KOLO-1',
  name: 'Horské kolo Scott Aspect 950',
  manufacturer: 'Scott',
  category: 'Horská kola',
  owner: 'Petr Novák',
  stock: 5,
  margin_pct: 25.5,
  price: 13490,
  position: 'middle',
  lock_active: false,
  min_below_cost: true,
  note: null,
  empty_text: '',
  attrs: { N: 'N7', sezona: 'Léto 2026', imprese_30: '1 200' },
});

function isFilterError(e) {
  return (
    e instanceof Error &&
    (e.name === 'FilterError' || (e.constructor && e.constructor.name === 'FilterError')) &&
    typeof e.message === 'string' &&
    e.message.length > 0
  );
}

test('filter: {} a {all: []} odpovídají všemu, {any: []} ničemu', () => {
  assert.strictEqual(match({}, VIEW), true);
  assert.strictEqual(match({}, {}), true);
  assert.strictEqual(match({ all: [] }, VIEW), true);
  assert.strictEqual(match({ any: [] }, VIEW), false);
  assert.strictEqual(match({ any: [] }, {}), false);
});

test('filter: = / != bez ohledu na velikost písmen a diakritiku (fold)', () => {
  assert.strictEqual(match(cond('manufacturer', '=', 'SCOTT'), VIEW), true);
  assert.strictEqual(match(cond('manufacturer', '=', 'Trek'), VIEW), false);
  assert.strictEqual(match(cond('category', '=', 'horska KOLA'), VIEW), true);
  assert.strictEqual(match(cond('owner', '=', 'petr novak'), VIEW), true);
  assert.strictEqual(match(cond('manufacturer', '!=', 'scott'), VIEW), false);
  assert.strictEqual(match(cond('manufacturer', '!=', 'Trek'), VIEW), true);
  // číslo vs. řetězec se stejnou hodnotou
  assert.strictEqual(match(cond('stock', '=', '5'), VIEW), true);
  assert.strictEqual(match(cond('stock', '=', 5), VIEW), true);
  assert.strictEqual(match(cond('position', '=', 'middle'), VIEW), true);
});

test('filter: tečková cesta attrs.N', () => {
  assert.strictEqual(match(cond('attrs.N', '=', 'n7'), VIEW), true);
  assert.strictEqual(match(cond('attrs.sezona', '=', 'leto 2026'), VIEW), true);
  assert.strictEqual(match(cond('attrs.neexistuje', '=', 'x'), VIEW), false);
});

test('filter: číselné operátory > >= < <= přes parseNumber (obě strany)', () => {
  assert.strictEqual(match(cond('margin_pct', '>', 20), VIEW), true);
  assert.strictEqual(match(cond('margin_pct', '>', '20'), VIEW), true);
  assert.strictEqual(match(cond('margin_pct', '>', '25,5'), VIEW), false);
  assert.strictEqual(match(cond('margin_pct', '>=', '25,5'), VIEW), true); // „25,5“ → 25.5, hranice včetně
  assert.strictEqual(match(cond('margin_pct', '<', 25.5), VIEW), false);
  assert.strictEqual(match(cond('margin_pct', '<=', 25.5), VIEW), true);
  assert.strictEqual(match(cond('price', '>', '12 990 Kč'), VIEW), true); // 13490 > 12990
  // pole s textovým číslem „1 200“ → 1200
  assert.strictEqual(match(cond('attrs.imprese_30', '>', 1000), VIEW), true);
  assert.strictEqual(match(cond('attrs.imprese_30', '<', 1000), VIEW), false);
});

test('filter: číselný operátor s nečíselným polem → false (žádné lexikografické porovnání)', () => {
  // pole 'Scott' není číslo → false pro všechny číselné operátory
  assert.strictEqual(match(cond('manufacturer', '>', 1), VIEW), false);
  assert.strictEqual(match(cond('manufacturer', '>=', 1), VIEW), false);
  assert.strictEqual(match(cond('manufacturer', '<', 1e9), VIEW), false);
  assert.strictEqual(match(cond('manufacturer', '<=', 1e9), VIEW), false);
  assert.strictEqual(match(cond('manufacturer', 'between', [0, 1e9]), VIEW), false);
  assert.strictEqual(match(cond('lock_active', '<', 1), VIEW), false); // boolean není číslo
});

test('filter: číselný operátor s nečíselnou hodnotou → false (SPEC: „if either side is not numeric → false“)', () => {
  // SPEC §6.4 popisuje běhovou sémantiku: nečíselná strana → podmínka neplatí (ne chyba kompilace).
  // Pozn.: odmítnutí už při compileFilter by bylo odchylkou od SPEC (FilterError je jen pro strukturu/operátor).
  assert.strictEqual(match(cond('margin_pct', '>', 'abc'), VIEW), false);
  assert.strictEqual(match(cond('margin_pct', '<=', 'abc'), VIEW), false);
  assert.strictEqual(match(cond('manufacturer', '>', 'A'), VIEW), false); // 'Scott' > 'A' – obě strany nečíselné
  assert.strictEqual(match(cond('manufacturer', 'between', ['A', 'Z']), VIEW), false);
});

test('filter: in / not_in – pole i řetězec oddělený čárkou', () => {
  assert.strictEqual(match(cond('attrs.N', 'in', ['N7', 'N8']), VIEW), true);
  assert.strictEqual(match(cond('attrs.N', 'in', ['n8', 'n9']), VIEW), false);
  assert.strictEqual(match(cond('attrs.N', 'in', 'N7,N8'), VIEW), true);
  assert.strictEqual(match(cond('attrs.N', 'in', 'N6,N8'), VIEW), false);
  assert.strictEqual(match(cond('category', 'in', ['horska kola', 'Silniční kola']), VIEW), true);
  assert.strictEqual(match(cond('stock', 'in', '5,6'), VIEW), true);
  assert.strictEqual(match(cond('attrs.N', 'not_in', ['N7', 'N8']), VIEW), false);
  assert.strictEqual(match(cond('attrs.N', 'not_in', 'N1,N2'), VIEW), true);
});

test('filter: in s řetězcem „N7, N8“ (mezery po čárce se ořezávají)', () => {
  // SPEC-AMBIGUOUS: SPEC říká jen „a comma-separated string is split“; ořezání mezer je jediné rozumné čtení.
  assert.strictEqual(match(cond('attrs.N', 'in', 'N6, N7'), VIEW), true);
  assert.strictEqual(match(cond('attrs.N', 'not_in', 'N6, N7'), VIEW), false);
});

test('filter: contains / not_contains / starts_with (fold)', () => {
  assert.strictEqual(match(cond('name', 'contains', 'KOLO'), VIEW), true);
  assert.strictEqual(match(cond('name', 'contains', 'horske'), VIEW), true); // bez diakritiky
  assert.strictEqual(match(cond('name', 'contains', 'Trek'), VIEW), false);
  assert.strictEqual(match(cond('name', 'not_contains', 'trek'), VIEW), true);
  assert.strictEqual(match(cond('name', 'not_contains', 'aspect'), VIEW), false);
  assert.strictEqual(match(cond('name', 'starts_with', 'horské KOLO'), VIEW), true);
  assert.strictEqual(match(cond('name', 'starts_with', 'horske'), VIEW), true);
  assert.strictEqual(match(cond('name', 'starts_with', 'Scott'), VIEW), false);
  assert.strictEqual(match(cond('code', 'starts_with', 'kolo-'), VIEW), true);
});

test('filter: empty / not_empty', () => {
  assert.strictEqual(match(cond('note', 'empty'), VIEW), true); // null
  assert.strictEqual(match(cond('empty_text', 'empty'), VIEW), true); // ''
  assert.strictEqual(match(cond('neexistuje', 'empty'), VIEW), true); // chybí
  assert.strictEqual(match(cond('manufacturer', 'empty'), VIEW), false);
  assert.strictEqual(match(cond('note', 'not_empty'), VIEW), false);
  assert.strictEqual(match(cond('empty_text', 'not_empty'), VIEW), false);
  assert.strictEqual(match(cond('manufacturer', 'not_empty'), VIEW), true);
  assert.strictEqual(match(cond('stock', 'not_empty'), VIEW), true);
});

test('filter: between [a, b] včetně hranic, s parseNumber', () => {
  assert.strictEqual(match(cond('margin_pct', 'between', [25.5, 30]), VIEW), true); // dolní hranice
  assert.strictEqual(match(cond('margin_pct', 'between', [20, 25.5]), VIEW), true); // horní hranice
  assert.strictEqual(match(cond('margin_pct', 'between', ['10', '30']), VIEW), true);
  assert.strictEqual(match(cond('margin_pct', 'between', [25.51, 30]), VIEW), false);
  assert.strictEqual(match(cond('margin_pct', 'between', [10, 25.49]), VIEW), false);
  assert.strictEqual(match(cond('attrs.imprese_30', 'between', [1000, 1500]), VIEW), true); // „1 200“
});

test('filter: is_true / is_false', () => {
  assert.strictEqual(match(cond('min_below_cost', 'is_true'), VIEW), true);
  assert.strictEqual(match(cond('min_below_cost', 'is_false'), VIEW), false);
  assert.strictEqual(match(cond('lock_active', 'is_true'), VIEW), false);
  assert.strictEqual(match(cond('lock_active', 'is_false'), VIEW), true);
});

test('filter: chybějící / null pole → vše false kromě empty, not_in, !=, not_contains, is_false', () => {
  const expectTrue = new Set(['empty', 'not_in', '!=', 'not_contains', 'is_false']);
  const cases = [
    ['=', 'x'],
    ['!=', 'x'],
    ['>', 1],
    ['>=', 1],
    ['<', 1],
    ['<=', 1],
    ['in', ['x', 'y']],
    ['not_in', ['x', 'y']],
    ['contains', 'x'],
    ['not_contains', 'x'],
    ['starts_with', 'x'],
    ['empty', null],
    ['not_empty', null],
    ['between', [0, 100]],
    ['is_true', null],
    ['is_false', null],
  ];
  for (const [op, value] of cases) {
    const want = expectTrue.has(op);
    assert.strictEqual(match(cond('neexistuje', op, value), VIEW), want, `chybějící pole, op ${op}`);
    assert.strictEqual(match(cond('note', op, value), VIEW), want, `null pole, op ${op}`);
    assert.strictEqual(match(cond('attrs.neni', op, value), VIEW), want, `chybějící attrs.*, op ${op}`);
  }
  // chybějící attrs úplně
  assert.strictEqual(match(cond('attrs.N', 'in', ['N7']), { code: 'X' }), false);
  assert.strictEqual(match(cond('attrs.N', 'not_in', ['N7']), { code: 'X' }), true);
});

test('filter: skupiny all / any / not a jejich vnoření', () => {
  const scott = cond('manufacturer', '=', 'scott');
  const trek = cond('manufacturer', '=', 'trek');
  const n7 = cond('attrs.N', 'in', ['N7', 'N8']);
  assert.strictEqual(match({ all: [scott, n7] }, VIEW), true);
  assert.strictEqual(match({ all: [scott, trek] }, VIEW), false);
  assert.strictEqual(match({ any: [trek, n7] }, VIEW), true);
  assert.strictEqual(match({ any: [trek, cond('stock', '>', 10)] }, VIEW), false);
  assert.strictEqual(match({ not: trek }, VIEW), true);
  assert.strictEqual(match({ not: scott }, VIEW), false);
  assert.strictEqual(match({ not: cond('neexistuje', '=', 1) }, VIEW), true);
  assert.strictEqual(match({ all: [{ any: [trek, scott] }, { not: { all: [n7, cond('stock', '<', 3)] } }] }, VIEW), true);
  assert.strictEqual(match({ not: {} }, VIEW), false);
});

test('filter: neplatný operátor → compileFilter vyhodí FilterError (česká zpráva)', () => {
  const { compileFilter } = FL();
  assert.throws(() => compileFilter(cond('manufacturer', 'like', 'Scott')), isFilterError);
  assert.throws(() => compileFilter({ all: [cond('stock', '>', 1), cond('manufacturer', 'LIKE', 'x')] }), isFilterError);
  assert.throws(() => compileFilter({ any: [{ not: cond('stock', '===', 1) }] }), isFilterError);
});

test('filter: neplatná struktura → FilterError', () => {
  const { compileFilter } = FL();
  assert.throws(() => compileFilter({ all: 'x' }), isFilterError);
  assert.throws(() => compileFilter({ any: { field: 'stock' } }), isFilterError);
  assert.throws(() => compileFilter({ field: 'stock' }), isFilterError); // chybí op
  assert.throws(() => compileFilter({ op: '=', value: 1 }), isFilterError); // chybí field
});

test('filter: pokud modul exportuje FilterError, je vyhozená chyba jeho instancí', () => {
  const mod = FL();
  if (typeof mod.FilterError !== 'function') return; // export FilterError SPEC nevyžaduje
  assert.throws(() => mod.compileFilter(cond('x', 'nesmysl', 1)), mod.FilterError);
});

test('validateFilter: {ok, errors} a nikdy nevyhazuje', () => {
  const { validateFilter } = FL();
  assert.deepStrictEqual(validateFilter({}), { ok: true, errors: [] });
  assert.deepStrictEqual(validateFilter({ all: [cond('stock', '>', 1), { not: cond('attrs.N', 'in', 'N7,N8') }] }), {
    ok: true,
    errors: [],
  });
  for (const bad of [cond('stock', 'like', 1), { any: [cond('stock', 'xx', 1)] }, { all: 'x' }, { field: 'stock' }]) {
    const r = validateFilter(bad);
    assert.strictEqual(r.ok, false, JSON.stringify(bad));
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
    for (const e of r.errors) assert.ok(typeof e === 'string' && e.length > 0);
  }
});
