'use strict';
// Nezávislé black-box testy src/engine/rounding.js podle SPEC §6.6.
// roundPrice(value, rounding, direction?) → number ; priceCandidates(value, rounding) → {down, up}

const test = require('node:test');
const assert = require('node:assert');
const { engine, DEFAULT_BANDS } = require('./engine-spec-helpers.js');

const R = () => engine('rounding');
const ENDING = { mode: 'ending', direction: 'down', bands: DEFAULT_BANDS };

test('rounding: mode none → 2 desetinná místa', () => {
  const { roundPrice } = R();
  // 12345.678 → 12345.68 (nejbližší na haléře)
  assert.strictEqual(roundPrice(12345.678, { mode: 'none' }, 'nearest'), 12345.68);
  // hodnota už na 2 dp zůstává beze změny pro všechny směry
  for (const dir of ['down', 'up', 'nearest']) assert.strictEqual(roundPrice(1234.5, { mode: 'none' }, dir), 1234.5);
});

test('rounding: mode integer – celé koruny, směry down/up/nearest, remíza → dolů', () => {
  const { roundPrice } = R();
  const r = { mode: 'integer' };
  assert.strictEqual(roundPrice(12345.4, r, 'down'), 12345);
  assert.strictEqual(roundPrice(12345.4, r, 'up'), 12346);
  assert.strictEqual(roundPrice(12345.4, r, 'nearest'), 12345);
  assert.strictEqual(roundPrice(12345.6, r, 'nearest'), 12346);
  // remíza 100.5 → down (SPEC: „nearest (tie → down)“)
  assert.strictEqual(roundPrice(100.5, r, 'nearest'), 100);
  for (const dir of ['down', 'up', 'nearest']) assert.strictEqual(roundPrice(12345, r, dir), 12345);
});

test('rounding: ending – výchozí pásma, cenové body k × step + ending', () => {
  const { roundPrice } = R();
  // 12 860,1 > 10 000 → pásmo ending 990, step 1000 → body …, 11 990, 12 990, …
  assert.strictEqual(roundPrice(12860.1, ENDING, 'down'), 11990);
  assert.strictEqual(roundPrice(12860.1, ENDING, 'up'), 12990);
  // nearest: 12860.1 − 11990 = 870.1 ; 12990 − 12860.1 = 129.9 → 12 990
  assert.strictEqual(roundPrice(12860.1, ENDING, 'nearest'), 12990);
  // 523 ≤ 1000 → ending 9, step 10 → 519 / 529
  assert.strictEqual(roundPrice(523, ENDING, 'down'), 519);
  assert.strictEqual(roundPrice(523, ENDING, 'up'), 529);
  assert.strictEqual(roundPrice(523, ENDING, 'nearest'), 519); // 4 vs 6
  assert.strictEqual(roundPrice(526, ENDING, 'nearest'), 529); // 7 vs 3
  // remíza: 524 − 519 = 5 = 529 − 524 → dolů
  assert.strictEqual(roundPrice(524, ENDING, 'nearest'), 519);
  // 5 555 ≤ 10 000 → ending 90, step 100 → 5 490 / 5 590 ; nearest: 65 vs 35 → 5 590
  assert.strictEqual(roundPrice(5555, ENDING, 'down'), 5490);
  assert.strictEqual(roundPrice(5555, ENDING, 'up'), 5590);
  assert.strictEqual(roundPrice(5555, ENDING, 'nearest'), 5590);
});

test('rounding: ending – hranice pásem (pásmo = první s value ≤ up_to)', () => {
  const { roundPrice, priceCandidates } = R();
  // 999 je sám cenovým bodem (99 × 10 + 9)
  for (const dir of ['down', 'up', 'nearest']) assert.strictEqual(roundPrice(999, ENDING, dir), 999);
  // 1001 > 1000 → pásmo 2 (ending 90, step 100): 990 / 1 090
  assert.deepStrictEqual(priceCandidates(1001, ENDING), { down: 990, up: 1090 });
  // 10 000 ≤ 10 000 → pásmo 2: 9 990 / 10 090
  assert.deepStrictEqual(priceCandidates(10000, ENDING), { down: 9990, up: 10090 });
  // 10 001 → pásmo 3 (ending 990, step 1000): 9 990 / 10 990
  assert.deepStrictEqual(priceCandidates(10001, ENDING), { down: 9990, up: 10990 });
  // SPEC-AMBIGUOUS: pásmo se volí podle hodnoty, ne podle kandidáta – pro 1000 (pásmo 1, ending 9) je
  // up kandidát 1009, tj. mimo horní mez pásma. Doslovné čtení SPEC → {down: 999, up: 1009}.
  assert.deepStrictEqual(priceCandidates(1000, ENDING), { down: 999, up: 1009 });
});

test('rounding: přesný cenový bod zůstává ve všech směrech; výsledek je celé číslo', () => {
  const { roundPrice, priceCandidates } = R();
  for (const dir of ['down', 'up', 'nearest']) assert.strictEqual(roundPrice(12990, ENDING, dir), 12990);
  assert.deepStrictEqual(priceCandidates(12990, ENDING), { down: 12990, up: 12990 });
  // „Output is an exact integer when ending/step are integers“ – žádné 12989.999999
  for (const v of [12099.999999999998, 12860.1, 15513.499999999998, 840.51, 5633.1]) {
    for (const dir of ['down', 'up', 'nearest']) {
      const out = roundPrice(v, ENDING, dir);
      assert.ok(Number.isInteger(out), `roundPrice(${v}, ${dir}) = ${out} není celé číslo`);
    }
  }
  // 12 099,999999999998 (typický výsledek plovoucí čárky u spodní hranice) → up = 12 990
  assert.strictEqual(roundPrice(12099.999999999998, ENDING, 'up'), 12990);
});

test('rounding: priceCandidates vrací {down, up}', () => {
  const { priceCandidates } = R();
  assert.deepStrictEqual(priceCandidates(12860.1, ENDING), { down: 11990, up: 12990 });
  assert.deepStrictEqual(priceCandidates(5555, ENDING), { down: 5490, up: 5590 });
  assert.deepStrictEqual(priceCandidates(12860.4, { mode: 'integer' }), { down: 12860, up: 12861 });
});

test('rounding: když down ≤ 0 (žádný bod pod hodnotou) → použije se up', () => {
  const { roundPrice, priceCandidates } = R();
  // 5 → pásmo 1 (ending 9): žádný bod ≤ 5 (k ≥ 0 → nejmenší bod 9) → výsledek 9 i pro směr down
  assert.strictEqual(roundPrice(5, ENDING, 'down'), 9);
  assert.strictEqual(priceCandidates(5, ENDING).up, 9);
  // jediné pásmo ending 990: 500 → down by byl −10 → up = 990
  const only990 = { mode: 'ending', direction: 'down', bands: [{ up_to: null, ending: 990 }] };
  assert.strictEqual(roundPrice(500, only990, 'down'), 990);
  assert.strictEqual(roundPrice(500, only990, 'nearest'), 990);
});

test('rounding: odvození kroku z počtu číslic ending (9→10, 90/99→100, 490/990/999→1000, 0→1)', () => {
  const { roundPrice } = R();
  const one = (ending, extra = {}) => ({ mode: 'ending', direction: 'down', bands: [{ up_to: null, ending, ...extra }] });
  // ending 99 → step 100: 1234 → 1199 / 1299
  assert.strictEqual(roundPrice(1234, one(99), 'down'), 1199);
  assert.strictEqual(roundPrice(1234, one(99), 'up'), 1299);
  // ending 490 → step 1000: 12 860 → 12 490 / 13 490
  assert.strictEqual(roundPrice(12860, one(490), 'down'), 12490);
  assert.strictEqual(roundPrice(12860, one(490), 'up'), 13490);
  // ending 999 → step 1000: 12 860 → 11 999 / 12 999
  assert.strictEqual(roundPrice(12860, one(999), 'down'), 11999);
  assert.strictEqual(roundPrice(12860, one(999), 'up'), 12999);
  // ending 0 bez step → step 1 (celé koruny)
  assert.strictEqual(roundPrice(12860.1, one(0), 'down'), 12860);
  assert.strictEqual(roundPrice(12860.1, one(0), 'up'), 12861);
  // ending 0 se step 100 → stovky
  assert.strictEqual(roundPrice(12860.1, one(0, { step: 100 }), 'down'), 12800);
  assert.strictEqual(roundPrice(12860.1, one(0, { step: 100 }), 'up'), 12900);
  // vlastní step 50 s ending 0 → 12 850 / 12 900
  assert.strictEqual(roundPrice(12860.1, one(0, { step: 50 }), 'down'), 12850);
  assert.strictEqual(roundPrice(12860.1, one(0, { step: 50 }), 'up'), 12900);
  // vlastní step 500 s ending 90 → body 90, 590, 1090, …, 12 590, 13 090
  assert.strictEqual(roundPrice(12860.1, one(90, { step: 500 }), 'down'), 12590);
  assert.strictEqual(roundPrice(12860.1, one(90, { step: 500 }), 'up'), 13090);
});

test('rounding: bez parametru direction se použije rounding.direction', () => {
  const { roundPrice } = R();
  assert.strictEqual(roundPrice(12860.1, { ...ENDING, direction: 'up' }), 12990);
  assert.strictEqual(roundPrice(12860.1, { ...ENDING, direction: 'down' }), 11990);
  assert.strictEqual(roundPrice(12860.1, { ...ENDING, direction: 'nearest' }), 12990);
  // parametr direction má přednost před rounding.direction
  assert.strictEqual(roundPrice(12860.1, { ...ENDING, direction: 'up' }, 'down'), 11990);
});

test('rounding: žádné pásmo neodpovídá (poslední up_to není null) → rozumný výsledek, ne pád', () => {
  // SPEC-AMBIGUOUS: SPEC nepopisuje, co když value > všechna up_to; očekáváme konečné číslo blízko hodnoty
  // (např. poslední pásmo → 4 999, nebo celé Kč → 5 000), rozhodně ne NaN/undefined/0.
  const { roundPrice } = R();
  const r = roundPrice(5000, { mode: 'ending', direction: 'down', bands: [{ up_to: 1000, ending: 9 }] }, 'down');
  assert.ok(Number.isFinite(r) && Math.abs(r - 5000) <= 10, `výsledek ${r}`);
});
