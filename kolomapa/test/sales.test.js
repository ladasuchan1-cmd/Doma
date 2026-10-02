'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { salesFromRows, salesStats, cleanTitle, saleKind } = require('../src/sales');

const row = (o) => ({ 'Kód': 'K1', Datum: '2026-03-01', 'Množství': 1, 'Vážená': 1000, 'Výrobce': 'X', 'Členění': 'sSklad', 'Jméno': 'Jan Novák', Firma: 'ACME s.r.o.', ...o });

test('BAZAR = konečná cena, PROVĚŘENO = cena bez DPH × 1,21', () => {
  const { sales } = salesFromRows([
    row({ 'Název': 'Woom 3 Red 16 dětské kolo - BAZAR', 'Částka': 7000, 'Vážená': 4000 }),
    row({ 'Kód': 'K2', 'Název': 'Haibike Nduro 7 celoodpružené elektrokolo - Prověřeno@vel. L', 'Částka': 57842.98 }),
  ]);
  assert.equal(sales.length, 2);
  const b = sales.find((s) => s.kind === 'bazar');
  assert.equal(b.priceCzk, 7000);
  assert.equal(b.title, 'Woom 3 Red 16 dětské kolo');
  const p = sales.find((s) => s.kind === 'provereno');
  assert.equal(p.priceCzk, 69990);
  assert.equal(p.size, 'L');
});

test('osobní údaje se neukládají', () => {
  const { sales } = salesFromRows([row({ 'Název': 'Giant TCR silniční kolo BAZAR', 'Částka': 16000 })]);
  const json = JSON.stringify(sales);
  assert.ok(!json.includes('Novák'));
  assert.ok(!json.includes('ACME'));
});

test('nekola a vratky se vyřadí', () => {
  const { sales, skipped } = salesFromRows([
    row({ 'Název': 'Dynafit Tour Pole skialpové hole PROVĚŘENO', 'Částka': 900 }),
    row({ 'Kód': 'R', 'Název': 'Focus Jam2 horské elektrokolo - Prověřeno@vel. M', 'Částka': 66843.09, Datum: '2026-06-26' }),
    row({ 'Kód': 'R', 'Název': 'Focus Jam2 horské elektrokolo - Prověřeno@vel. M', 'Částka': 66843.09, Datum: '2026-07-10', 'Množství': -1 }),
    row({ 'Kód': 'R', 'Název': 'Focus Jam2 horské elektrokolo - Prověřeno@vel. M', 'Částka': 59082.64, Datum: '2026-08-10' }),
  ]);
  assert.equal(skipped.nonBike, 1);
  assert.equal(skipped.returned, 2);
  assert.equal(sales.length, 1);
  assert.equal(sales[0].priceCzk, 71490);
});

test('cleanTitle / saleKind', () => {
  assert.deepEqual(cleanTitle('Cannondale Trail 3 horské kolo BAZAR, vel. L'), { title: 'Cannondale Trail 3 horské kolo, vel. L', size: null });
  assert.equal(cleanTitle('GT Grade Carbon Elite WGR gravel kolo@vel. L Prověřeno').size, 'L');
  assert.equal(saleKind('x BAZAR'), 'bazar');
  assert.equal(saleKind('x - Prověřeno'), 'provereno');
});

test('salesStats: poměr výkup/prodej', () => {
  const st = salesStats([
    { kind: 'bazar', priceCzk: 10000, costCzk: 6000 },
    { kind: 'bazar', priceCzk: 10000, costCzk: 7000 },
    { kind: 'provereno', priceCzk: 50000, costCzk: 45000 },
  ]);
  assert.equal(st.bazarCount, 2);
  assert.ok(Math.abs(st.buyRatioMedian - 0.65) < 1e-9);
});
