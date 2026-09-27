'use strict';
// Testy modelu importu (public/lib/import-model.js).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'lib', 'import-model.js')).href);

test('kanonická pole odpovídají SPEC §3.1 a §3.3', async () => {
  const m = await load();
  const p = m.CANONICAL.products.map((f) => f.key);
  for (const k of ['code', 'ean', 'mpn', 'name', 'manufacturer', 'category', 'supplier', 'owner', 'purchase_price', 'price', 'vat_rate', 'msrp', 'stock', 'sales_30', 'sales_90', 'active']) assert.ok(p.includes(k), k);
  const o = m.CANONICAL.offers.map((f) => f.key);
  for (const k of ['code', 'ean', 'mpn', 'ext_id', 'competitor', 'price', 'shipping', 'availability', 'in_stock', 'delivery_days', 'stock_qty', 'url', 'name', 'observed_at']) assert.ok(o.includes(k), k);
  assert.ok(m.CANONICAL.products.find((f) => f.key === 'code').required);
  assert.ok(m.CANONICAL.offers.find((f) => f.key === 'competitor').required);
});

test('buildMapping vynechá prázdné hodnoty', async () => {
  const m = await load();
  assert.deepStrictEqual(m.buildMapping({ format: 'auto', fields: { ean: 'EAN', code: '' }, defaults: { competitor: 'VeloMarket.cz', url: '' }, csv: { delimiter: '', decimal: ',', header_row: '2' }, price_net: false, attrs: 'all' }), {
    fields: { ean: 'EAN' },
    defaults: { competitor: 'VeloMarket.cz' },
    csv: { decimal: ',', header_row: 2 },
  });
  assert.deepStrictEqual(m.buildMapping({ format: 'xml', item_path: 'SHOP.SHOPITEM', price_net: true, attrs: 'none' }), { format: 'xml', item_path: 'SHOP.SHOPITEM', price_net: true, attrs: 'none' });
  assert.deepStrictEqual(m.buildMapping(), {});
});

test('missingRequired a hasMatchKey', async () => {
  const m = await load();
  assert.deepStrictEqual(m.missingRequired('offers', { price: 'Cena', ean: 'EAN' }, {}), ['Konkurent']);
  assert.deepStrictEqual(m.missingRequired('offers', { price: 'Cena', ean: 'EAN' }, { competitor: 'X' }), []);
  assert.deepStrictEqual(m.missingRequired('products', {}, {}), ['Kód (SKU / POHODA)']);
  assert.ok(!m.hasMatchKey('offers', { price: 'x', competitor: 'y' }));
  assert.ok(m.hasMatchKey('offers', { ean: 'EAN' }));
  assert.ok(m.hasMatchKey('products', {}));
});

test('guessContentType, formatFromName, statsList', async () => {
  const m = await load();
  assert.strictEqual(m.guessContentType('a.CSV', ''), 'text/csv');
  assert.strictEqual(m.guessContentType('a.xlsx', ''), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.strictEqual(m.guessContentType('a.xml', 'text/xml'), 'text/xml', 'typ z prohlížeče má přednost');
  assert.strictEqual(m.guessContentType('a.bin', ''), 'application/octet-stream');
  assert.strictEqual(m.formatFromName('x.tsv'), 'csv');
  assert.deepStrictEqual(m.statsList({ received: 3, errors: [{ row: 1 }], foo: 1 }), [{ key: 'received', label: 'Přijato záznamů', value: 3 }, { key: 'errors', label: 'Chyby', value: 1 }]);
  assert.deepStrictEqual(m.statsList(null), []);
});

test('curlExamples obsahují adresu serveru a token', async () => {
  const m = await load();
  const ex = m.curlExamples('https://ceny.example.cz/');
  assert.ok(ex.length >= 5);
  for (const e of ex) {
    assert.ok(e.title && e.text && e.code, e.id);
    assert.match(e.code, /https:\/\/ceny\.example\.cz\/api\/v1\//);
    assert.match(e.code, /Bearer \$CENOTVORBA_TOKEN/);
  }
  const csv = ex.find((e) => e.id === 'offers-csv');
  const url = /"(https:[^"]+)"/.exec(csv.code)[1];
  const mapping = JSON.parse(new URL(url).searchParams.get('mapping'));
  assert.deepStrictEqual(mapping.fields, { ean: 'EAN', competitor: 'Obchod', price: 'Cena s DPH' });
});
