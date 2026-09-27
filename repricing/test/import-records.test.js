'use strict';
// Testy načtení záznamů (SPEC §5 records.js): JSON / XML / CSV / XLSX, zploštění, vnořené nabídky, kódování.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { extractRecords, flattenRecord, ImportError } = require('../src/import');
const { encodeWindows1250, writeXlsx, writeZip } = require('../src/formats');

const FIX = path.join(__dirname, 'fixtures', 'import');
const fx = (name) => ({ buffer: fs.readFileSync(path.join(FIX, name)), filename: name });
const json = (v) => ({ text: JSON.stringify(v) });

test('JSON: kořenové pole, {items}, {data:{offers}}, item_path, jeden objekt', () => {
  let r = extractRecords(json([{ a: 1 }, { a: 2 }]));
  assert.equal(r.format, 'json');
  assert.equal(r.itemPath, null);
  assert.deepEqual(r.records, [{ a: 1 }, { a: 2 }]);
  r = extractRecords(json({ count: 2, items: [{ a: 1 }, { a: 2, b: 'x' }] }));
  assert.equal(r.itemPath, 'items');
  assert.deepEqual(r.headers, ['a', 'b']);
  r = extractRecords(json({ meta: { tags: ['x'], warnings: [] }, data: { offers: [{ ean: '1', price: 10 }] } }));
  assert.equal(r.itemPath, 'data.offers', 'pole objektů má přednost před polem primitiv');
  assert.deepEqual(r.records, [{ ean: '1', price: 10 }]);
  r = extractRecords(json({ data: { offers: [{ a: 1 }], other: [{ b: 2 }] } }), { item_path: 'data.other' });
  assert.deepEqual(r.records, [{ b: 2 }]);
  r = extractRecords(json({ data: { offers: [{ a: 1 }] } }), { item_path: '$.data.offers[*]' });
  assert.deepEqual(r.records, [{ a: 1 }]);
  r = extractRecords(json({ code: 'A', price: 1 }));
  assert.deepEqual(r.records, [{ code: 'A', price: 1 }]);
  assert.throws(() => extractRecords(json({ a: [] }), { item_path: 'b.c' }), (e) => e instanceof ImportError && e.status === 400 && /b\.c/.test(e.message));
});

test('JSON: NDJSON, pole polí s hlavičkou, primitivní záznamy, BOM, neplatný JSON', () => {
  let r = extractRecords({ text: '{"a":1}\n{"a":2}\n\n{"a":3}\n' });
  assert.equal(r.records.length, 3);
  r = extractRecords(json([['ean', 'cena'], ['859', 100], ['860', 200]]));
  assert.deepEqual(r.records, [{ ean: '859', cena: 100 }, { ean: '860', cena: 200 }]);
  r = extractRecords(json(['a', 'b']));
  assert.deepEqual(r.records, [{ value: 'a' }, { value: 'b' }]);
  r = extractRecords({ buffer: Buffer.from('﻿[{"a":"č"}]') });
  assert.deepEqual(r.records, [{ a: 'č' }]);
  assert.throws(() => extractRecords({ text: '{"a":' }), (e) => e instanceof ImportError && /Neplatný JSON/.test(e.message));
  assert.throws(() => extractRecords({ text: '   ' }), /prázdný/);
  assert.throws(() => extractRecords({ buffer: Buffer.alloc(0) }), /prázdný/);
  assert.throws(() => extractRecords(null), ImportError);
});

test('zploštění: tečkové klíče, atributy, text s atributy, pole primitiv, páry PARAM, datumy', () => {
  const flat = flattenRecord({
    a: { b: { c: 1 } },
    '@shop': 'X',
    PRICE_VAT: { '@currency': 'CZK', '#text': '12990' },
    IMG: ['a.jpg', 'b.jpg'],
    PARAM: [
      { PARAM_NAME: 'Barva', VAL: 'černá' },
      { PARAM_NAME: 'Velikost', VAL: 'M' },
    ],
    SINGLE: { PARAM_NAME: 'Materiál', VAL: 'karbon' },
    param: [
      { '@name': 'Hmotnost', '#text': '9,8 kg' },
      { '@name': 'Hmotnost', '#text': '10 kg' },
    ],
    DELIVERY: [
      { ID: 'PPL', PRICE: 99 },
      { ID: 'CP', PRICE: 120 },
    ],
    empty: {},
    none: null,
    list: [],
    one: [{ x: 1 }],
    d: new Date('2026-09-25T10:00:00Z'),
  });
  assert.deepEqual(flat, {
    'a.b.c': 1,
    '@shop': 'X',
    PRICE_VAT: '12990',
    'PRICE_VAT.@currency': 'CZK',
    IMG: 'a.jpg|b.jpg',
    'PARAM.Barva': 'černá',
    'PARAM.Velikost': 'M',
    'SINGLE.Materiál': 'karbon',
    'param.Hmotnost': '9,8 kg|10 kg',
    'DELIVERY.ID': 'PPL|CP',
    'DELIVERY.PRICE': '99|120',
    empty: '',
    none: null,
    list: '',
    'one.x': 1,
    d: '2026-09-25T10:00:00.000Z',
  });
  // kořenový objekt {name, value} se nepovažuje za pár
  assert.deepEqual(flattenRecord({ name: 'Kolo', value: 5 }), { name: 'Kolo', value: 5 });
  // __proto__ jako klíč neznečistí prototyp
  const p = flattenRecord(JSON.parse('{"__proto__": {"x": 1}, "a": 1}'));
  assert.equal(p['__proto__.x'], 1);
  assert.equal({}.x, undefined);
});

test('vnořené nabídky (JSON): řádek na nabídku, dědění polí rodiče, potomek vyhrává, prázdné nabídky', () => {
  const r = extractRecords(fx('konkurence-vnorene.json'), {}, { kind: 'offers' });
  assert.equal(r.itemPath, 'products');
  assert.equal(r.offersPath, 'offers');
  assert.equal(r.records.length, 4, 'produkt bez nabídek nedává žádný řádek');
  assert.deepEqual(r.records[0], {
    generated: '2026-09-25T06:00:00Z', // kořenová pole dědí nabídky
    code: 'SRA-001',
    ean: '8597315660484',
    'offers.shop': 'VeloMarket.cz',
    'offers.price': '12 490 Kč',
    'offers.stock': 'skladem',
    shop: 'VeloMarket.cz',
    price: '12 490 Kč',
    stock: 'skladem',
  });
  assert.equal(r.records[3].ean, 8595234463384);
  // potomek vyhrává při kolizi
  const c = extractRecords(json([{ code: 'A', price: 999, offers: [{ shop: 'X', price: 10 }] }]), {}, { kind: 'offers' });
  assert.equal(c.records[0].price, 10);
  assert.equal(c.records[0]['offers.price'], 10);
  // výslovné offers_path a vypnutí
  const e = extractRecords(json([{ code: 'A', market: { sellers: [{ shop: 'X', amount: 5 }] } }]), { offers_path: 'market.sellers' }, { kind: 'offers' });
  assert.equal(e.records[0].shop, 'X');
  assert.equal(e.records[0]['market.sellers.amount'], 5);
  const off = extractRecords(json([{ code: 'A', offers: [{ shop: 'X', price: 1 }, { shop: 'Y', price: 2 }] }]), { offers_path: 'none' });
  assert.equal(off.records.length, 1);
  assert.equal(off.records[0]['offers.shop'], 'X|Y');
});

test('vnořené pole: doprava se nerozkládá; varianty produktů ano, produkt bez variant zůstane', () => {
  const g = extractRecords(json([{ id: 'A', price: 100, shipping: [{ country: 'CZ', price: 99 }, { country: 'SK', price: 149 }] }]), {}, { kind: 'products' });
  assert.equal(g.offersPath, null);
  assert.equal(g.records.length, 1);
  assert.equal(g.records[0].price, 100);
  const v = extractRecords(
    json([
      { CODE: 'KOLO', NAME: 'Kolo', VARIANTS: [{ CODE: 'KOLO-M', PRICE_VAT: 100 }, { CODE: 'KOLO-L', PRICE_VAT: 110 }] },
      { CODE: 'ZVONEK', NAME: 'Zvonek', PRICE_VAT: 90 },
    ]),
    {},
    { kind: 'products' }
  );
  assert.equal(v.offersPath, 'VARIANTS');
  assert.deepEqual(
    v.records.map((x) => [x.CODE, x.NAME, x.PRICE_VAT]),
    [
      ['KOLO-M', 'Kolo', 100],
      ['KOLO-L', 'Kolo', 110],
      ['ZVONEK', 'Zvonek', 90],
    ]
  );
  // více různých kandidátních polí → nejednoznačné → nerozkládat
  const amb = extractRecords(json([{ a: [{ price: 1 }, { price: 2 }], b: [{ price: 3 }, { price: 4 }] }]));
  assert.equal(amb.offersPath, null);
});

test('XML: Heureka-like – konkurent jako atribut, vnořené nabídky, PARAM, CDATA, atribut měny', () => {
  const r = extractRecords(fx('heureka-konkurence.xml'), {}, { kind: 'offers' });
  assert.equal(r.format, 'xml');
  assert.equal(r.itemPath, 'SHOP.SHOPITEM');
  assert.equal(r.offersPath, 'OFFERS.OFFER');
  assert.equal(r.records.length, 4);
  const first = r.records[0];
  assert.equal(first.ITEM_ID, 'SRA-001');
  assert.equal(first['@shop'], 'VeloMarket.cz');
  assert.equal(first['OFFERS.OFFER.@shop'], 'VeloMarket.cz');
  assert.equal(first.PRICE_VAT, '12 490');
  assert.equal(first['PRICE_VAT.@currency'], 'CZK');
  assert.equal(first['PARAM.Barva'], 'černá');
  assert.equal(first['PARAM.Délka'], '175 mm');
  assert.equal(first.URL, 'https://velomarket.cz/p/xtr?a=1&b=2');
  assert.equal(r.records[2]['@shop'], 'www.VeloMarket.cz', 'jediná nabídka (není pole) se také rozloží');
  assert.ok(!r.headers.includes('OFFERS'), 'prázdný obal nabídek není sloupec');
  // u katalogu (products) se produkt bez nabídek zachová
  const p = extractRecords(fx('heureka-konkurence.xml'), {}, { kind: 'products' });
  assert.ok(p.records.some((x) => x.ITEM_ID === 'BEZ-NABIDEK'));
});

test('XML: atributy kořene dědí nabídky; konkurent jako atribut skupiny', () => {
  const x = `<?xml version="1.0"?><prices shop="VeloMarket.cz" generated="2026-09-25"><offer><ean>8591234567890</ean><price>10</price></offer><offer><ean>8591234567891</ean><price>20</price><shop>Jiný</shop></offer></prices>`;
  const r = extractRecords({ text: x }, {}, { kind: 'offers' });
  assert.equal(r.itemPath, 'prices.offer');
  assert.equal(r.records[0]['@shop'], 'VeloMarket.cz');
  assert.equal(r.records[1].shop, 'Jiný');
  // skupina podle konkurenta: <competitor name="X"><offer>…</offer></competitor>
  const g = `<data><competitor name="VeloMarket.cz"><offer><ean>1</ean><price>10</price></offer><offer><ean>2</ean><price>11</price></offer></competitor>
    <competitor name="KoloPointer.cz"><offer><ean>1</ean><price>12</price></offer><offer><ean>3</ean><price>13</price></offer></competitor></data>`;
  const gr = extractRecords({ text: g }, {}, { kind: 'offers' });
  assert.equal(gr.itemPath, 'data.competitor');
  assert.equal(gr.offersPath, 'offer');
  assert.deepEqual(
    gr.records.map((o) => [o['competitor.@name'], o.ean, o.price]),
    [
      ['VeloMarket.cz', '1', '10'],
      ['VeloMarket.cz', '2', '11'],
      ['KoloPointer.cz', '1', '12'],
      ['KoloPointer.cz', '3', '13'],
    ]
  );
});

test('XML: Google Merchant (jmenné prostory), POHODA listStock (windows-1250), výslovná item_path, chyby', () => {
  const g = extractRecords(fx('google-merchant.xml'), {}, { kind: 'products' });
  assert.equal(g.itemPath, 'rss.channel.item');
  assert.equal(g.records.length, 2);
  assert.equal(g.records[0].id, 'SRA-001');
  assert.equal(g.records[0].price, '9 990.00 CZK');
  assert.equal(g.records[0].product_type, 'Komponenty > Kliky');
  assert.equal(g.records[0]['shipping.price'], '99 CZK|149 CZK');
  const p = extractRecords(fx('pohoda-liststock.xml'), {}, { kind: 'products' });
  assert.equal(p.itemPath, 'responsePack.responsePackItem.listStock.stock');
  assert.equal(p.records[1]['stockHeader.code'], 'MAX-028');
  assert.ok(!('@version' in p.records[0]));
  const one = extractRecords({ text: '<product><code>A</code><price>1</price></product>' });
  assert.deepEqual(one.records, [{ code: 'A', price: '1' }]);
  const explicit = extractRecords({ text: '<a><b><c><x>1</x></c></b><b><c><x>2</x></c></b></a>' }, { item_path: 'a/b/c' });
  assert.deepEqual(explicit.records, [{ x: '1' }, { x: '2' }]);
  assert.throws(() => extractRecords({ text: '<a><b>1</b></a>' }, { item_path: 'a.zzz' }), /zzz/);
  assert.throws(
    () => extractRecords({ text: '<a><b>1</c></a>' }),
    (e) => e instanceof ImportError && e.status === 400 && /XML/.test(e.message) && e.details && e.details.line === 1
  );
});

test('CSV: windows-1250 z POHODY, BOM, prázdné řádky, duplicitní hlavičky, sep=, TSV, vynucené kódování', () => {
  const r = extractRecords(fx('katalog-cp1250.csv'));
  assert.equal(r.format, 'csv');
  assert.equal(r.headers[0], 'Kód');
  assert.ok(r.headers.includes('Zodpovědná osoba'));
  assert.equal(r.records.length, 6, 'prázdné řádky (i jen se středníky) se přeskočí');
  assert.equal(r.records[4].Název, 'Žluťoučký kůň úpěl ďábelské ódy');
  const b = extractRecords(fx('konkurence-bom.csv'));
  assert.equal(b.headers[0], 'EAN');
  assert.equal(b.records[0].Cena, '12 990 Kč');
  const d = extractRecords({ text: 'sep=,\na,a,b\n1,2,3\n' });
  assert.deepEqual(d.headers, ['a', 'a_2', 'b']);
  const t = extractRecords({ text: 'x;y\n1;2\n' }, { format: 'tsv' });
  assert.deepEqual(t.headers, ['x;y']);
  const cp = encodeWindows1250('Kód;Název\nA;Čerstvé ovoce\n');
  assert.equal(extractRecords({ buffer: cp }, { csv: { encoding: 'windows-1250' } }).records[0].Název, 'Čerstvé ovoce');
  assert.equal(extractRecords({ buffer: cp }).records[0].Název, 'Čerstvé ovoce', 'automatická detekce cp1250');
  // hlavička až na 3. řádku
  const h = extractRecords({ text: 'Export z POHODY\n\nkod;cena\nA;1\n' }, { csv: { header_row: 3 } });
  assert.deepEqual(h.records, [{ kod: 'A', cena: '1' }]);
  assert.throws(() => extractRecords({ text: 'a;b\n1;2' }, { format: 'pdf' }), /Neznámý formát/);
});

test('XLSX: čísla (EAN bez exponentu), hlavička, list; ZIP s CSV; gzip', () => {
  const xlsx = writeXlsx([
    { name: 'Info', columns: [{ key: 'x', label: 'Poznámka' }], rows: [{ x: 'nic' }] },
    {
      name: 'Ceny',
      columns: [
        { key: 'ean', label: 'EAN', type: 'number' },
        { key: 'name', label: 'Název' },
        { key: 'price', label: 'Cena', type: 'money' },
      ],
      rows: [
        { ean: 8597315660484, name: 'Kliky', price: 12990 },
        { ean: 8595234463384, name: 'Plášť', price: 819.5 },
      ],
    },
  ]);
  const r = extractRecords({ buffer: xlsx, filename: 'x.xlsx' }, { xlsx: { sheet: 'Ceny' } });
  assert.equal(r.format, 'xlsx');
  assert.deepEqual(r.headers, ['EAN', 'Název', 'Cena']);
  assert.deepEqual(r.records[0], { EAN: 8597315660484, Název: 'Kliky', Cena: 12990 });
  const first = extractRecords({ buffer: xlsx });
  assert.deepEqual(first.records, [{ Poznámka: 'nic' }]);
  assert.throws(() => extractRecords({ buffer: xlsx }, { xlsx: { sheet: 'Neexistuje' } }), ImportError);
  // ZIP, který není sešitem → datový soubor uvnitř
  const zip = writeZip([{ name: 'export/konkurence.csv', data: 'ean;cena\n1;2\n' }]);
  const z = extractRecords({ buffer: zip, filename: 'data.zip' });
  assert.equal(z.format, 'csv');
  assert.deepEqual(z.records, [{ ean: '1', cena: '2' }]);
  assert.throws(() => extractRecords({ buffer: writeZip([{ name: 'a.png', data: 'x' }]) }), /neobsahuje/);
  // gzip
  const gz = zlib.gzipSync(Buffer.from('<SHOP><SHOPITEM><A>1</A></SHOPITEM><SHOPITEM><A>2</A></SHOPITEM></SHOP>'));
  const gr = extractRecords({ buffer: gz, filename: 'feed.xml.gz' });
  assert.equal(gr.format, 'xml');
  assert.equal(gr.records.length, 2);
  // XLSX jako text nejde
  assert.throws(() => extractRecords({ text: 'a' }, { format: 'xlsx' }), /binární/);
});

test('předané objekty (records), hlavičky = sjednocení v pořadí prvního výskytu, limit', () => {
  const r = extractRecords({ records: [{ a: 1, n: { x: 1 } }, { b: 2, a: 3 }] });
  assert.deepEqual(r.headers, ['a', 'n.x', 'b']);
  assert.deepEqual(r.records[0], { a: 1, 'n.x': 1 });
  const many = Array.from({ length: 50 }, (_, i) => `<item><i>${i}</i><p>${i}</p></item>`).join('');
  const l = extractRecords({ text: `<items>${many}</items>` }, {}, { limit: 10 });
  assert.equal(l.records.length, 10);
  assert.equal(l.truncated, true);
  const nl = extractRecords({ text: `<items>${many}</items>` });
  assert.equal(nl.records.length, 50);
  assert.equal(nl.truncated, false);
  assert.ok(Buffer.isBuffer(fs.readFileSync(path.join(FIX, 'katalog-cp1250.csv'))));
  // Buffer / string přímo
  assert.equal(extractRecords(Buffer.from('a;b\n1;2')).records.length, 1);
  assert.equal(extractRecords('[{"a":1}]').records.length, 1);
});

test('regrese: patologicky zanořený JSON → ImportError 400 (ne přetečení zásobníku / HTTP 500)', () => {
  const { extractRecords } = require('../src/import/records');
  for (const text of ['['.repeat(100000) + ']'.repeat(100000), '{"a":'.repeat(20000) + '1' + '}'.repeat(20000), '{"items":[' + '{"a":'.repeat(5000) + '1' + '}'.repeat(5000) + ']}']) {
    assert.throws(
      () => extractRecords({ text }, {}),
      (e) => e.name === 'ImportError' && e.status === 400 && /zanořený/.test(e.message)
    );
  }
  // běžné zanoření (desítky úrovní) projde
  const ok = extractRecords({ text: JSON.stringify({ items: [{ a: { b: { c: { d: { e: 1 } } } }, price: 10 }] }) }, {});
  assert.equal(ok.records.length, 1);
  assert.equal(ok.records[0]['a.b.c.d.e'], 1);
});
