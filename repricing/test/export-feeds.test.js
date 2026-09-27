'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toXml, toJson, toCsv, templateFields } = require('../src/export/feeds');
const { parseXml, parseCsv } = require('../src/formats');
const { DEFAULT_SETTINGS } = require('../src/db');

const NOW = '2026-09-25T10:00:00.000Z';

const ROWS = [
  {
    proposal_id: 7,
    product_id: 1,
    code: 'KOLO-TREK-FX2-M',
    ean: '8591234567890',
    name: 'Trek FX 2 <M> & „Černá“',
    manufacturer: 'Trek',
    price: 18990.5,
    old_price: 19990,
    change_pct: -5,
    vat_rate: 21,
    currency: 'CZK',
    changed_at: '2026-09-20T08:00:00.000Z',
    strategy: 'Medián trhu −2 %',
    segment: null,
    lowest_30d: 17990,
  },
  {
    proposal_id: null,
    product_id: 2,
    code: 'PLAST;29',
    ean: null,
    name: 'Plášť "Nobby"\nNic',
    manufacturer: 'Schwalbe',
    price: 899,
    old_price: 899,
    change_pct: 0,
    vat_rate: 21,
    currency: 'CZK',
    changed_at: null,
    strategy: null,
    segment: null,
    lowest_30d: 899,
  },
];

test('toXml: výchozí šablona ze settings, atributy kořene, escapování, prázdné hodnoty', () => {
  const xml = toXml(ROWS, DEFAULT_SETTINGS.export.xml, { now: NOW });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<prices generated="2026-09-25T10:00:00.000Z" count="2" currency="CZK">/);
  const root = parseXml(xml);
  assert.equal(root.name, 'prices');
  assert.deepEqual(root.attrs, { generated: NOW, count: '2', currency: 'CZK' });
  assert.equal(root.children.length, 2);
  const item = root.children[0];
  assert.equal(item.name, 'item');
  assert.deepEqual(
    item.children.map((c) => c.name),
    ['code', 'ean', 'name', 'price', 'old_price', 'vat_rate', 'currency', 'changed_at']
  );
  const get = (node, n) => node.children.find((c) => c.name === n).text;
  assert.equal(get(item, 'name'), 'Trek FX 2 <M> & „Černá“');
  assert.equal(get(item, 'price'), '18990.5', 'desetinná tečka');
  assert.equal(get(root.children[1], 'ean'), '', 'null → prázdný element');
  assert.match(xml, /<ean\/>/);
  assert.equal(get(root.children[1], 'name'), 'Plášť "Nobby"\nNic');
});

test('toXml: pole jako objekt pole → element, neznámá pole ignorována, neplatné názvy nahrazeny', () => {
  const xml = toXml(ROWS, { root: 'CENIK', item: 'POLOZKA', fields: { code: 'KOD', price: 'CENA_S_DPH', neznamo: 'X', lowest_30d: 'NEJNIZSI_30', ean: '1bad name' } }, { now: NOW });
  const root = parseXml(xml);
  assert.equal(root.name, 'CENIK');
  assert.equal(root.children[0].name, 'POLOZKA');
  assert.deepEqual(
    root.children[0].children.map((c) => [c.name, c.text]),
    [
      ['KOD', 'KOLO-TREK-FX2-M'],
      ['CENA_S_DPH', '18990.5'],
      ['NEJNIZSI_30', '17990'],
      ['ean', '8591234567890'],
    ]
  );
  // pole jako seznam s neznámými názvy a duplicitami
  assert.deepEqual(templateFields(['code', 'xyz', 'code', 'price']), [
    ['code', 'code'],
    ['price', 'price'],
  ]);
  // neplatný kořen/položka → výchozí
  const r2 = parseXml(toXml(ROWS, { root: '<x>', item: 'a b', fields: ['code'] }, { now: NOW }));
  assert.equal(r2.name, 'prices');
  assert.equal(r2.children[0].name, 'item');
  // bez šablony → výchozí šablona
  const r3 = parseXml(toXml(ROWS, null, { now: NOW }));
  assert.equal(r3.children[0].children.length, 8);
});

test('toXml: prázdný seznam a měna z voleb', () => {
  const xml = toXml([], { root: 'prices', item: 'item', fields: ['code'] }, { now: NOW, currency: 'EUR' });
  const root = parseXml(xml);
  assert.deepEqual(root.attrs, { generated: NOW, count: '0', currency: 'EUR' });
  assert.equal(root.children.length, 0);
});

test('toJson: obálka generated/count/currency/items', () => {
  const j = toJson(ROWS, { now: NOW });
  assert.deepEqual(Object.keys(j), ['generated', 'count', 'currency', 'items']);
  assert.equal(j.generated, NOW);
  assert.equal(j.count, 2);
  assert.equal(j.currency, 'CZK');
  assert.equal(j.items, ROWS);
  assert.deepEqual(toJson([], { now: NOW }), { generated: NOW, count: 0, currency: 'CZK', items: [] });
  assert.ok(!Number.isNaN(Date.parse(toJson([]).generated)));
});

test('toCsv: středník, desetinná čárka, BOM, CRLF, uvozovky; zpětně čitelné', () => {
  const csv = toCsv(ROWS);
  assert.ok(csv.startsWith('﻿proposal_id;product_id;code;ean;name;'));
  assert.ok(csv.includes('\r\n'));
  assert.ok(csv.includes(';18990,5;19990;-5;21;CZK;'));
  assert.ok(csv.includes('"PLAST;29"'));
  const parsed = parseCsv(csv);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].code, 'KOLO-TREK-FX2-M');
  assert.equal(parsed.rows[0].price, '18990,5');
  assert.equal(parsed.rows[1].name, 'Plášť "Nobby"\nNic');
  assert.equal(parsed.rows[1].ean, '');
  // české hlavičky a výběr polí
  const cz = toCsv(ROWS, { labels: true, fields: ['code', 'price', 'lowest_30d'] });
  assert.ok(cz.startsWith('﻿Kód;Nová cena;Nejnižší cena za 30 dní\r\n'));
  const mapped = toCsv(ROWS, { fields: { code: 'kod', price: 'cena' }, bom: false });
  assert.ok(mapped.startsWith('kod;cena\r\nKOLO-TREK-FX2-M;18990,5\r\n'));
});
