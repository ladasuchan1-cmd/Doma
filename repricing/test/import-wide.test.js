'use strict';
// Matice cen konkurence (sloupec = obchod), hlavičky v prvním řádku Excel tabulky, párování podle názvu,
// vlastní e-shop v datech konkurence (settings.own_shops).
const test = require('node:test');
const assert = require('node:assert');
const { openDb, setSetting } = require('../src/db');
const { extractRecords, shopFromHeader } = require('../src/import/records');
const { runImport, previewImport, importProducts, importOffers } = require('../src/import');
const { writeXlsx } = require('../src/formats/xlsx');

const NOW = '2026-09-27T10:00:00.000Z';

// Stejný tvar jako export z nástroje na sledování Heureky: Excel tabulka „Column1…“, skutečné hlavičky v 1. řádku.
function heurekaMatrixXlsx() {
  const cols = ['Column1', 'Sloupec1', 'Column70', 'Column71'];
  const rows = [
    { Column1: 'product_name', Sloupec1: 'mujshop.cz heureka-cz', Column70: 'kupkolo.cz heureka-cz', Column71: 'cyklodesign.cz heureka-cz' },
    { Column1: 'Shimano Deore XT kazeta 12s', Sloupec1: '4990.0', Column70: '4790.0', Column71: '' },
    { Column1: 'Schwalbe Nobby Nic 29x2.40', Sloupec1: '1290.0', Column70: '', Column71: '1190.0' },
    { Column1: 'Dynafit triko vel. M', Sloupec1: '', Column70: '', Column71: '' },
    { Column1: 'Neznámý produkt', Sloupec1: '', Column70: '999.0', Column71: '' },
  ];
  return writeXlsx([{ name: 'results', columns: cols.map((k) => ({ key: k, label: k })), rows }]);
}

test('shopFromHeader: název obchodu z hlavičky sloupce', () => {
  assert.equal(shopFromHeader('kupkolo.cz heureka-cz'), 'kupkolo.cz');
  assert.equal(shopFromHeader('www.Kolo-Shop.cz'), 'kolo-shop.cz');
  assert.equal(shopFromHeader('Sportisimo'), 'Sportisimo');
});

test('matice z Excelu: hlavičky z 1. řádku, rozložení na produkt × konkurent, prázdné buňky vynechány', () => {
  const ex = extractRecords({ buffer: heurekaMatrixXlsx(), filename: 'konkurence.xlsx' }, {}, { kind: 'offers' });
  assert.equal(ex.headerPromoted, true);
  assert.deepEqual(ex.wide.competitors, ['mujshop.cz', 'kupkolo.cz', 'cyklodesign.cz']);
  assert.equal(ex.wide.rows, 4);
  assert.deepEqual(ex.headers, ['product_name', 'competitor', 'price']);
  assert.equal(ex.records.length, 5);
  assert.deepEqual(ex.records[1], { product_name: 'Shimano Deore XT kazeta 12s', competitor: 'kupkolo.cz', price: '4790.0' });
});

test('matice z CSV; u katalogu (products) ani s namapovanou cenou se nerozkládá', () => {
  const csv = 'EAN;VeloMarket.cz;BikePoint.cz\n8590000000011;12 990;13 490\n8590000000028;;899\n';
  const ex = extractRecords({ text: csv }, {}, { kind: 'offers' });
  assert.equal(ex.records.length, 3);
  assert.deepEqual(ex.records[0], { EAN: '8590000000011', competitor: 'velomarket.cz', price: '12 990' });
  const asProducts = extractRecords({ text: csv }, {}, { kind: 'products' });
  assert.equal(asProducts.wide, null);
  const long = extractRecords({ text: 'ean;shop;cena\n8590000000011;velomarket.cz;12990\n' }, {}, { kind: 'offers' });
  assert.equal(long.wide, null);
  const explicitOff = extractRecords({ text: csv }, { wide: false }, { kind: 'offers' });
  assert.equal(explicitOff.wide, null);
  const mapped = extractRecords({ text: csv }, { fields: { price: 'VeloMarket.cz' } }, { kind: 'offers' });
  assert.equal(mapped.wide, null);
});

test('import matice: párování podle přesného názvu, vlastní e-shop se přeskočí', () => {
  const db = openDb();
  importProducts(db, [
    { code: 'A1', name: 'Shimano Deore XT kazeta 12s', price: 4990 },
    { code: 'B2', name: 'SCHWALBE  Nobby Nic 29x2.40', price: 1290 }, // jiná velikost písmen a mezery
  ], { now: NOW });
  setSetting(db, 'own_shops', ['mujshop.cz']);
  const pv = previewImport({ kind: 'offers', input: { buffer: heurekaMatrixXlsx(), filename: 'k.xlsx' } });
  assert.equal(pv.suggested.name, 'product_name');
  assert.ok(pv.errors.some((e) => /matice cen/.test(e.message)));
  const r = runImport(db, { kind: 'offers', input: { buffer: heurekaMatrixXlsx(), filename: 'k.xlsx' }, now: NOW });
  assert.equal(r.stats.own_skipped, 2);
  assert.equal(r.stats.matched, 2);
  assert.equal(r.stats.matched_by_name, 2);
  assert.equal(r.stats.unmatched, 1); // „Neznámý produkt“
  assert.deepEqual(r.stats.wide.competitors, ['mujshop.cz', 'kupkolo.cz', 'cyklodesign.cz']);
  const comps = db.prepare('SELECT name FROM competitors ORDER BY name').all().map((c) => c.name);
  assert.deepEqual(comps, ['cyklodesign.cz', 'kupkolo.cz']);
  const offers = db.prepare('SELECT p.code, c.name, o.price FROM offers o JOIN products p ON p.id = o.product_id JOIN competitors c ON c.id = o.competitor_id ORDER BY p.code').all();
  assert.deepEqual(offers.map((o) => [o.code, o.name, o.price]), [['A1', 'kupkolo.cz', 4790], ['B2', 'cyklodesign.cz', 1190]]);
});

test('párování podle názvu: jen bez jiných identifikátorů, duplicitní název je nejednoznačný, lze vypnout', () => {
  const db = openDb();
  importProducts(db, [
    { code: 'A1', ean: '8590000000011', name: 'Kazeta XT' },
    { code: 'D1', name: 'Plášť 29' },
    { code: 'D2', name: 'Plášť 29' },
  ], { now: NOW });
  // EAN nesedí na nic → název se NEPOUŽIJE (nabídka nese identifikátor, který nic nenašel)
  let s = importOffers(db, [{ competitor: 'x.cz', ean: '8590000000999', name: 'Kazeta XT', price: 100 }], { now: NOW });
  assert.equal(s.matched, 0);
  assert.equal(s.unmatched, 1);
  // duplicitní název → nejednoznačné
  s = importOffers(db, [{ competitor: 'x.cz', name: 'plášť 29', price: 100 }], { now: NOW });
  assert.equal(s.matched, 0);
  assert.equal(s.ambiguous, 1);
  // vypnuto
  s = importOffers(db, [{ competitor: 'x.cz', name: 'Kazeta XT', price: 100 }], { now: NOW, matchByName: false });
  assert.equal(s.matched, 0);
  s = importOffers(db, [{ competitor: 'x.cz', name: 'kazeta   xt', price: 100 }], { now: NOW });
  assert.equal(s.matched, 1);
  assert.equal(s.matched_by_name, 1);
});

test('bez nastaveného vlastního e-shopu se statistika own_skipped neobjeví', () => {
  const db = openDb();
  importProducts(db, [{ code: 'A1', name: 'X' }], { now: NOW });
  const s = importOffers(db, [{ competitor: 'x.cz', code: 'A1', price: 10 }], { now: NOW });
  assert.equal(s.own_skipped, undefined);
});
