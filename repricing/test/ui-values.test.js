'use strict';
// Čisté pomocné funkce UI pro zobrazení hodnot z API: cena k exportu (final_price), kompaktní částky do dlaždic,
// detail auditu/exportu (objekt z API), naše cena v grafu bez historie, jednotky v KPI.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const lib = (f) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'lib', f)).href);
const norm = (s) => String(s).replace(/[  ]/g, ' ').replace(/−/g, '-');

test('proposal-model: exportuje se final_price, jinak ruční cena, jinak navržená', async () => {
  const m = await lib('proposal-model.js');
  // tvar skutečného API (final_* spočítané serverem)
  const api = { old_price: 1000, new_price: 900, change_pct: -10, margin_after: 20, manual_price: 950, final_price: 950, final_change_pct: -5, final_margin_pct: 23.58 };
  assert.strictEqual(m.finalPrice(api), 950);
  assert.strictEqual(m.finalChangePct(api), -5);
  assert.strictEqual(m.finalMargin(api), 23.58);
  assert.ok(m.isManual(api));
  // bez final_* (starší odpověď / mock) – dopočet z ruční ceny a DPH produktu
  const old = { old_price: 1000, new_price: 900, change_pct: -10, margin_after: 20, manual_price: 950, product: { purchase_price: 600, vat_rate: 21 } };
  assert.strictEqual(m.finalPrice(old), 950);
  assert.strictEqual(m.finalChangePct(old), -5);
  assert.strictEqual(m.finalMargin(old), 23.58);
  // bez ruční ceny = navržená
  const plain = { old_price: 1000, new_price: 900, change_pct: -10, margin_after: 20, manual_price: null };
  assert.strictEqual(m.finalPrice(plain), 900);
  assert.strictEqual(m.finalChangePct(plain), -10);
  assert.strictEqual(m.finalMargin(plain), 20);
  assert.ok(!m.isManual(plain));
  // products[].proposal z API
  assert.strictEqual(m.finalPrice({ new_price: 5990, final_price: 5490 }), 5490);
  // číselné řetězce
  assert.strictEqual(m.finalPrice({ new_price: '12990' }), 12990);
});

test('compactMoney: dlouhé částky zkrátit na mil./mld., krátké beze změny', async () => {
  const f = await lib('format.js');
  assert.strictEqual(norm(f.compactMoney(-1467752.89)), '-1,47 mil. Kč');
  assert.strictEqual(norm(f.compactMoney(1467752, { signed: true })), '+1,47 mil. Kč');
  assert.strictEqual(norm(f.compactMoney(12345678)), '12,3 mil. Kč');
  assert.strictEqual(norm(f.compactMoney(1000000)), '1 mil. Kč');
  assert.strictEqual(norm(f.compactMoney(1.5e9)), '1,5 mld. Kč');
  assert.strictEqual(norm(f.compactMoney(999999)), '999 999 Kč');
  assert.strictEqual(norm(f.compactMoney(-45)), '-45 Kč');
  assert.strictEqual(norm(f.compactMoney(0, { signed: true })), '0 Kč');
  assert.strictEqual(f.compactMoney(null), '–');
});

test('detailText: detail auditu/exportu (objekt z API) jako český text, nikdy [object Object]', async () => {
  const f = await lib('format.js');
  assert.strictEqual(norm(f.detailText({ format: 'json', scope: 'approved', proposal_ids: [1, 2, 3, 4, 5, 6, 7, 8] })), 'formát: json · rozsah: schválené · návrhy: 8 položek');
  assert.strictEqual(f.detailText({ name: 'KoloPointer.cz', changes: { label: { from: null, to: 'KP' }, tags: { from: '[]', to: '["klíčový"]' } } }), 'název: KoloPointer.cz · label: – → KP · tags: – → klíčový');
  assert.strictEqual(f.detailText('text'), 'text');
  assert.strictEqual(f.detailText(null), '');
  assert.strictEqual(f.detailText({ update_current_price: true }), 'přepsat aktuální cenu: ano');
  assert.doesNotMatch(f.detailText({ a: { b: 1 } }), /object Object/);
});

test('seriesWithCurrent: naše cena je v grafu i bez historie změn', async () => {
  const c = await lib('charts.js');
  const now = Date.parse('2026-09-25T12:00:00Z');
  // bez historie → jeden bod v čase poslední změny / založení
  assert.deepStrictEqual(c.seriesWithCurrent([], 1090, '2026-09-20T00:00:00Z', now), [{ t: Date.parse('2026-09-20T00:00:00Z'), v: 1090 }]);
  // neznámé datum → teď
  assert.deepStrictEqual(c.seriesWithCurrent([], 1090, null, now), [{ t: now, v: 1090 }]);
  // historie končí jinou cenou → doplnit aktuální
  const h = [{ t: now - 86400000, v: 999 }];
  assert.deepStrictEqual(c.seriesWithCurrent(h, 1090, null, now), [...h, { t: now, v: 1090 }]);
  // historie končí stejnou cenou → beze změny; bez ceny → jen historie
  assert.deepStrictEqual(c.seriesWithCurrent([{ t: 1, v: 1090 }], 1090, null, now), [{ t: 1, v: 1090 }]);
  assert.deepStrictEqual(c.seriesWithCurrent([], null, null, now), []);
});
