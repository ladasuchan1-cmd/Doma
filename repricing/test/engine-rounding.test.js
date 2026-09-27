'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { roundPrice, priceCandidates, validateRounding, describeRounding, stepFor } = require('../src/engine/rounding.js');

const DEF = { mode: 'ending', direction: 'down', bands: [{ up_to: 1000, ending: 9 }, { up_to: 10000, ending: 90 }, { up_to: null, ending: 990 }] };

test('rounding: výchozí pásma – dolů / nahoru / nejbližší', () => {
  assert.equal(roundPrice(12365.1, DEF), 11990);
  assert.equal(roundPrice(12365.1, DEF, 'up'), 12990);
  assert.equal(roundPrice(12365.1, DEF, 'nearest'), 11990);
  assert.equal(roundPrice(12600, DEF, 'nearest'), 12990);
  assert.equal(roundPrice(5432, DEF), 5390);
  assert.equal(roundPrice(5432, DEF, 'up'), 5490);
  assert.equal(roundPrice(456, DEF), 449);
  assert.equal(roundPrice(456, DEF, 'up'), 459);
  assert.deepEqual(priceCandidates(12365.1, DEF), { down: 11990, up: 12990 });
});

test('rounding: směr z nastavení a přebití parametrem', () => {
  assert.equal(roundPrice(5432, { ...DEF, direction: 'up' }), 5490);
  assert.equal(roundPrice(5432, { ...DEF, direction: 'up' }, 'down'), 5390);
  assert.equal(roundPrice(5432, { bands: DEF.bands }), 5390, 'výchozí směr je dolů');
});

test('rounding: hranice pásem (pásmo určuje hodnota, value ≤ up_to)', () => {
  assert.deepEqual(priceCandidates(1000, DEF), { down: 999, up: 1009 });
  assert.deepEqual(priceCandidates(1000.01, DEF), { down: 990, up: 1090 });
  assert.deepEqual(priceCandidates(10000, DEF), { down: 9990, up: 10090 });
  assert.deepEqual(priceCandidates(10000.5, DEF), { down: 9990, up: 10990 });
  assert.deepEqual(priceCandidates(999, DEF), { down: 999, up: 999 });
});

test('rounding: hodnota přesně na cenovém bodu zůstává', () => {
  for (const v of [9, 19, 999, 1090, 9990, 12990, 129990]) {
    assert.equal(roundPrice(v, DEF, 'down'), v);
    assert.equal(roundPrice(v, DEF, 'up'), v);
    assert.equal(roundPrice(v, DEF, 'nearest'), v);
  }
});

test('rounding: hodnota pod prvním koncem → up (down ≤ 0 se nepoužije)', () => {
  assert.deepEqual(priceCandidates(5, DEF), { down: 9, up: 9 });
  assert.equal(roundPrice(5, DEF, 'down'), 9);
  assert.equal(roundPrice(0.4, { mode: 'ending', bands: [{ up_to: null, ending: 0 }] }), 1);
  assert.equal(roundPrice(0, { mode: 'integer' }), 1);
});

test('rounding: kroky podle konce pásma a vlastní step', () => {
  assert.equal(stepFor({ ending: 0 }), 1);
  assert.equal(stepFor({ ending: 9 }), 10);
  assert.equal(stepFor({ ending: 90 }), 100);
  assert.equal(stepFor({ ending: 99 }), 100);
  assert.equal(stepFor({ ending: 490 }), 1000);
  assert.equal(stepFor({ ending: 990 }), 1000);
  assert.equal(stepFor({ ending: 999 }), 1000);
  assert.equal(stepFor({ ending: 0, step: 100 }), 100);
  const one = (b) => ({ mode: 'ending', bands: [{ up_to: null, ...b }] });
  assert.deepEqual(priceCandidates(123.4, one({ ending: 0 })), { down: 123, up: 124 });
  assert.deepEqual(priceCandidates(1234, one({ ending: 0, step: 100 })), { down: 1200, up: 1300 });
  assert.deepEqual(priceCandidates(12000, one({ ending: 490 })), { down: 11490, up: 12490 });
  assert.deepEqual(priceCandidates(1234, one({ ending: 99 })), { down: 1199, up: 1299 });
  assert.deepEqual(priceCandidates(1234, one({ ending: 50, step: 100 })), { down: 1150, up: 1250 });
});

test('rounding: nearest – remíza dolů', () => {
  const b = { mode: 'ending', bands: [{ up_to: null, ending: 9 }] };
  assert.equal(roundPrice(14, b, 'nearest'), 9);
  assert.equal(roundPrice(14.01, b, 'nearest'), 19);
  assert.equal(roundPrice(1234.5, { mode: 'integer' }, 'nearest'), 1234);
  assert.equal(roundPrice(1234.51, { mode: 'integer' }, 'nearest'), 1235);
});

test('rounding: integer a none', () => {
  assert.equal(roundPrice(1234.4, { mode: 'integer', direction: 'down' }), 1234);
  assert.equal(roundPrice(1234.4, { mode: 'integer' }, 'up'), 1235);
  assert.equal(roundPrice(1234.567, { mode: 'none' }), 1234.57);
  assert.equal(roundPrice(1234.561, { mode: 'none' }, 'down'), 1234.56);
  assert.deepEqual(priceCandidates(1234.561, { mode: 'none' }), { down: 1234.56, up: 1234.57 });
  assert.deepEqual(priceCandidates(1234.56, { mode: 'none' }), { down: 1234.56, up: 1234.56 });
});

test('rounding: výstup je přesné celé číslo i při plovoucím šumu', () => {
  const v = 0.1 + 0.2 + 12989.7; // 12990.000000000002
  assert.equal(roundPrice(v, DEF, 'down'), 12990);
  assert.equal(roundPrice(v, DEF, 'up'), 12990);
  for (let x = 1; x < 50000; x += 137.37) {
    const r = roundPrice(x, DEF, 'nearest');
    assert.ok(Number.isInteger(r), `${x} → ${r}`);
    const { down, up } = priceCandidates(x, DEF);
    assert.ok(down <= x + 1e-9 || down === up, `down ${down} ≤ ${x}`);
    assert.ok(up >= x - 1e-9);
  }
});

test('rounding: nad posledním pásmem s up_to se použije poslední pásmo', () => {
  const r = { mode: 'ending', bands: [{ up_to: 1000, ending: 9 }] };
  assert.equal(roundPrice(1500, r), 1499);
});

test('rounding: neplatné vstupy', () => {
  assert.equal(roundPrice(NaN, DEF), null);
  assert.equal(roundPrice(null, DEF), null);
  assert.deepEqual(priceCandidates(undefined, DEF), { down: null, up: null });
});

test('rounding: validateRounding', () => {
  assert.deepEqual(validateRounding(DEF), []);
  assert.deepEqual(validateRounding({ mode: 'none', direction: 'up' }), []);
  assert.ok(validateRounding({ ...DEF, mode: 'banker' }).some((e) => e.includes('rounding.mode')));
  assert.ok(validateRounding({ ...DEF, direction: 'sideways' }).some((e) => e.includes('rounding.direction')));
  assert.ok(validateRounding({ ...DEF, bands: [{ up_to: 10000, ending: 90 }, { up_to: 1000, ending: 9 }] }).some((e) => e.includes('vzestupně')));
  assert.ok(validateRounding({ ...DEF, bands: [{ up_to: null, ending: 9 }, { up_to: 1000, ending: 9 }] }).some((e) => e.includes('poslední')));
  assert.ok(validateRounding({ ...DEF, bands: [{ up_to: null, ending: 100, step: 100 }] }).some((e) => e.includes('menší než krok')));
  assert.ok(validateRounding({ ...DEF, bands: [{ up_to: null, ending: -1 }] }).length > 0);
  assert.ok(validateRounding({ ...DEF, bands: [] }).length > 0);
});

test('rounding: popis pro vysvětlení', () => {
  assert.equal(describeRounding(12365, DEF), 'Zaokrouhlení na …990 dolů');
  assert.equal(describeRounding(5000, DEF, 'up'), 'Zaokrouhlení na …90 nahoru');
  assert.equal(describeRounding(500, { mode: 'ending', bands: [{ up_to: null, ending: 9, step: 100 }] }), 'Zaokrouhlení na …09 dolů');
  assert.equal(describeRounding(500, { mode: 'integer' }, 'nearest'), 'Zaokrouhlení na celé koruny k nejbližšímu bodu');
});
