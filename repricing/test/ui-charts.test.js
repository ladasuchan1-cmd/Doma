'use strict';
// Testy čistých výpočtů grafů (public/lib/charts.js).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'lib', 'charts.js')).href);

test('niceTicks vrací hezká čísla pokrývající rozsah', async () => {
  const c = await load();
  assert.deepStrictEqual(c.niceTicks(0, 97, 5), [0, 20, 40, 60, 80, 100]);
  const t = c.niceTicks(10490, 13990, 5);
  assert.ok(t[0] <= 10490 && t[t.length - 1] >= 13990);
  assert.ok(t.every((x) => x % 500 === 0), 'krok 500: ' + t.join(','));
  const same = c.niceTicks(100, 100, 4);
  assert.ok(same[0] < 100 && same[same.length - 1] > 100);
  assert.deepStrictEqual(c.niceTicks(NaN, 5), [0, 1]);
});

test('scale, valueAt, stepPoints', async () => {
  const c = await load();
  const s = c.scale(0, 10, 100, 200);
  assert.strictEqual(s(5), 150);
  const pts = [{ t: 1, v: 10 }, { t: 5, v: 20 }];
  assert.strictEqual(c.valueAt(pts, 0), null);
  assert.strictEqual(c.valueAt(pts, 3), 10);
  assert.strictEqual(c.valueAt(pts, 9), 20);
  assert.deepStrictEqual(c.stepPoints(pts, 8), [{ t: 1, v: 10 }, { t: 5, v: 10 }, { t: 5, v: 20 }, { t: 8, v: 20 }]);
  assert.deepStrictEqual(c.stepPoints([], 8), []);
});
