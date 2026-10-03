'use strict';
// Boosting stromů (src/pricing/gbdt.js) – druhý stupeň nacenění.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fitBoost, predictBoost, binEdges, binOf, MAX_BINS } = require('../src/pricing/gbdt');

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

test('binEdges / binOf: kvantilové koše, chybějící hodnota v koši 0', () => {
  assert.deepEqual(binEdges([1, 1, 2, 3]), [1.5, 2.5]);
  assert.equal(binOf([1.5, 2.5], 1), 1);
  assert.equal(binOf([1.5, 2.5], 2), 2);
  assert.equal(binOf([1.5, 2.5], 9), 3);
  assert.equal(binOf([1.5, 2.5], NaN), 0);
  const many = binEdges(Array.from({ length: 1000 }, (_, i) => i));
  assert.ok(many.length <= MAX_BINS - 2 && many.length > 20);
  assert.deepEqual(binEdges([NaN, NaN]), []);
});

test('fitBoost: naučí interakci a skok, kterou lineární model nezachytí; stejná data → stejný model', () => {
  const r = rng(3);
  const X = [];
  const y = [];
  for (let i = 0; i < 3000; i++) {
    const a = r();
    const b = r();
    X.push([a, b, r()]); // třetí příznak je šum
    y.push((a > 0.5 ? 0.4 : -0.2) + (a > 0.5 && b > 0.5 ? 0.3 : 0) + (r() - 0.5) * 0.1);
  }
  const m = fitBoost(X, y, { trees: 120, depth: 3, minLeaf: 20 });
  const err = (x, truth) => Math.abs(predictBoost(m, x) - truth);
  assert.ok(err([0.8, 0.8, 0.5], 0.7) < 0.08, `vysoko: ${predictBoost(m, [0.8, 0.8, 0.5])}`);
  assert.ok(err([0.8, 0.2, 0.5], 0.4) < 0.08);
  assert.ok(err([0.2, 0.8, 0.5], -0.2) < 0.08);
  const m2 = fitBoost(X, y, { trees: 120, depth: 3, minLeaf: 20 });
  assert.equal(predictBoost(m2, [0.3, 0.6, 0.1]), predictBoost(m, [0.3, 0.6, 0.1]));
});

test('fitBoost: chybějící hodnota má vlastní větev; Huberova ztráta odolá nesmyslům', () => {
  const r = rng(11);
  const X = [];
  const y = [];
  for (let i = 0; i < 2000; i++) {
    const missing = r() < 0.3;
    X.push([missing ? NaN : r()]);
    let v = missing ? 0.5 : 0;
    if (i % 50 === 0) v += 20; // ojedinělé nesmyslné hodnoty (např. cena v haléřích)
    y.push(v);
  }
  const m = fitBoost(X, y, { trees: 150, depth: 2, minLeaf: 20 });
  assert.ok(Math.abs(predictBoost(m, [NaN]) - 0.5) < 0.15, `chybí: ${predictBoost(m, [NaN])}`);
  assert.ok(Math.abs(predictBoost(m, [0.4])) < 0.15, `známá: ${predictBoost(m, [0.4])}`);
  assert.equal(predictBoost(null, [1]), 0);
  assert.equal(predictBoost(fitBoost([], [], { trees: 3 }), []), 0);
});
