'use strict';
// Regresní testy importu dat (nálezy money-10, money-11, money-13, data-1 … data-17, security-3).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db');
const { runImport, previewImport } = require('../src/import/sources');
const { importProducts } = require('../src/import/products');
const { importOffers } = require('../src/import/offers');
const { extractRecords } = require('../src/import/records');
const { normalizeAvailability, suggestMapping } = require('../src/import/mapping');
const { parseNumber } = require('../src/util/num');
const { mpnKey } = require('../src/util/keys');
const { detectItemPath, writeZip, encodeWindows1250, decodeBuffer } = require('../src/formats');

const FIX = path.join(__dirname, 'fixtures', 'import');
const T1 = '2026-09-20T10:00:00.000Z';
const T2 = '2026-09-21T10:00:00.000Z';
const NOW = '2026-09-25T12:00:00.000Z';

const product = (db, code) => db.prepare('SELECT * FROM products WHERE code_key = ?').get(code);
const offersOf = (db) =>
  db
    .prepare('SELECT p.code, c.name AS competitor, o.price, o.shipping, o.in_stock, o.observed_at FROM offers o JOIN products p ON p.id = o.product_id JOIN competitors c ON c.id = o.competitor_id ORDER BY p.code, c.name')
    .all()
    .map((r) => ({ ...r }));

// ------------------------------------------------------------------------------------------------ čísla

test('data-10: vynucený desetinný oddělovač u čísla bez oddělovače nic nezkazí', () => {
  assert.equal(parseNumber('12990', { decimal: ',' }), 12990);
  assert.equal(parseNumber('249', { decimal: '.' }), 249);
  assert.equal(parseNumber('1 990', { decimal: ',' }), 1990);
  assert.equal(parseNumber('12.990', { decimal: ',' }), 12990);
  assert.equal(parseNumber('877,50', { decimal: ',' }), 877.5);
  assert.equal(parseNumber('5', { decimal: ',' }), 5);
  // skupina tisíců nezačíná nulou
  assert.equal(parseNumber('0,125'), 0.125);
  assert.equal(parseNumber('0.999'), 0.999);
  // import s mapping.csv.decimal ',' (nápověda UI pro CSV z Excelu)
  const db = openDb();
  const r = runImport(db, { kind: 'products', input: { text: 'kod;cena;sklad\nA;877,50;5\nB;870;12\nC;1 990;1\n' }, mapping: { csv: { decimal: ',' } }, now: T1 });
  assert.equal(r.stats.created, 3);
  assert.deepEqual(['A', 'B', 'C'].map((c) => [product(db, c).price, product(db, c).stock]), [[877.5, 5], [870, 12], [1990, 1]]);
});

test('data-10: CSV se středníkem – čárka je desetinná („123,456“ = 123,456), atributy čteny stejně jako pole', () => {
  const db = openDb();
  const csv = 'Kód;Nákupní cena;Imprese 30;Poznámka\nA;123,456;1.500;x\nB;1234,567;2;y\nC;0,125;3;z\n';
  runImport(db, { kind: 'products', input: { buffer: encodeWindows1250(csv), filename: 'k.csv' }, now: T1 });
  assert.equal(product(db, 'A').purchase_price, 123.456);
  assert.equal(product(db, 'B').purchase_price, 1234.567);
  assert.equal(product(db, 'C').purchase_price, 0.125);
  assert.equal(JSON.parse(product(db, 'A').attrs)['Imprese 30'], 1500);
});

test('money-11: XML a JSON – tečka je desetinná („1299.000“ = 1299, ne 1 299 000); CSV „12.990“ = 12 990', () => {
  const db = openDb();
  const xml = '<items><item><code>A2</code><price>1299.000</price><purchase_price>12396.694</purchase_price></item><item><code>A3</code><price>1652.8925</price></item></items>';
  runImport(db, { kind: 'products', input: { text: xml }, now: T1 });
  assert.equal(product(db, 'A2').price, 1299);
  assert.equal(product(db, 'A2').purchase_price, 12396.694);
  assert.equal(product(db, 'A3').price, 1652.8925);
  runImport(db, { kind: 'products', input: { text: JSON.stringify([{ code: 'A4', price: '2499.500' }]) }, now: T1 });
  assert.equal(product(db, 'A4').price, 2499.5);
  runImport(db, { kind: 'products', input: { text: 'kod;cena\nA5;12.990\n' }, now: T1 });
  assert.equal(product(db, 'A5').price, 12990);
});

test('money-13: cena v cizí měně (EUR, €, $) není číslo – neimportuje se jako Kč', () => {
  for (const v of ['1.299,00 €', '1299 EUR', '$1299', 'USD 1299']) assert.equal(parseNumber(v), null, v);
  assert.equal(parseNumber('12 990 Kč'), 12990);
  assert.equal(parseNumber('12990.00 CZK'), 12990);
  const db = openDb();
  importProducts(db, [{ code: 'EUR-1', price: 30000 }], { now: T1 });
  const r = runImport(db, { kind: 'offers', input: { text: JSON.stringify([{ code: 'EUR-1', competitor: 'DE-Shop', price: '1299 EUR' }]) }, now: NOW });
  assert.equal(r.stats.matched, 0);
  assert.ok(r.stats.errors.some((e) => /Neplatná cena/.test(e.message)));
  assert.equal(offersOf(db).length, 0);
});

// ------------------------------------------------------------------------------------------------ POHODA

test('data-1 + money-10: POHODA listStock s cenovými hladinami – cena = sellingPrice (ne hladina), @payVAT převede základ DPH', () => {
  const db = openDb();
  const input = { buffer: fs.readFileSync(path.join(FIX, 'pohoda-liststock-levels.xml')), filename: 'stock.xml' };
  const pv = previewImport({ input, kind: 'products' });
  assert.equal(pv.offersPath, null, 'cenové hladiny se nerozkládají na řádky');
  assert.equal(pv.suggested.price, 'stockHeader.sellingPrice');
  const r = runImport(db, { kind: 'products', input, now: T1 });
  assert.equal(r.stats.created, 2);
  const k = product(db, 'KOLO-001');
  assert.equal(k.price, 15990);
  assert.equal(k.purchase_price, 9000);
  const p = product(db, 'PLAST-002');
  assert.equal(p.price, 819, 'sellingPrice payVAT="false" 676,86 → s DPH 819');
  assert.equal(p.purchase_price, 500, 'purchasingPrice payVAT="true" 605 → bez DPH 500');
  // opakovaný import stejného souboru: beze změny, žádná falešná historie cen
  const r2 = runImport(db, { kind: 'products', input, now: T2 });
  assert.equal(r2.stats.unchanged, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM price_history').get().n, 0);
});

test('data-1: listStock s hladinami bez typ:id a s jedinou hladinou – cena z sellingPrice', () => {
  const card = (code, levels) =>
    `<lStk:stock><stk:stockHeader><stk:code>${code}</stk:code><stk:sellingPrice>15990</stk:sellingPrice></stk:stockHeader><stk:stockPriceItem>${levels}</stk:stockPriceItem></lStk:stock>`;
  const lvl = (ids, price, id) => `<stk:stockPrice>${id ? `<typ:id>${id}</typ:id>` : ''}<typ:ids>${ids}</typ:ids><typ:price>${price}</typ:price></stk:stockPrice>`;
  const doc = (cards) => `<rsp:responsePack><rsp:responsePackItem><lStk:listStock>${cards}</lStk:listStock></rsp:responsePackItem></rsp:responsePack>`;
  const db = openDb();
  runImport(db, { kind: 'products', input: { text: doc(card('A', lvl('D', 13990) + lvl('VO', 10990)) + card('B', lvl('D', 13990) + lvl('VO', 10990))) }, now: T1 });
  assert.equal(product(db, 'A').price, 15990);
  runImport(db, { kind: 'products', input: { text: doc(card('C', lvl('D', 10990, 2)) + card('D', lvl('D', 10990, 2))) }, now: T1 });
  assert.equal(product(db, 'C').price, 15990);
});

test('data-2: dokument s jedinou kartou / položkou – záznamem je karta, ne vnořené opakované prvky', () => {
  const one =
    '<rsp:responsePack><rsp:responsePackItem><lStk:listStock><lStk:stock><stk:stockHeader><stk:code>KOLO-9</stk:code><stk:sellingPrice>15990</stk:sellingPrice></stk:stockHeader>' +
    '<stk:stockPriceItem><stk:stockPrice><typ:id>2</typ:id><typ:ids>Dealer</typ:ids><typ:price>13000</typ:price></stk:stockPrice><stk:stockPrice><typ:id>3</typ:id><typ:price>12000</typ:price></stk:stockPrice></stk:stockPriceItem>' +
    '</lStk:stock></lStk:listStock></rsp:responsePackItem></rsp:responsePack>';
  assert.equal(detectItemPath(one), 'responsePack.responsePackItem.listStock.stock');
  const db = openDb();
  const r = runImport(db, { kind: 'products', input: { text: one }, now: T1 });
  assert.equal(r.stats.created, 1);
  assert.equal(product(db, 'KOLO-9').price, 15990);
  assert.equal(product(db, '2'), undefined, 'z cenové hladiny nevznikl produkt');
  assert.equal(detectItemPath('<SHOP><SHOPITEM><ITEM_ID>1</ITEM_ID><PARAM><PARAM_NAME>a</PARAM_NAME><VAL>1</VAL></PARAM><PARAM><PARAM_NAME>b</PARAM_NAME><VAL>2</VAL></PARAM></SHOPITEM></SHOP>'), 'SHOP.SHOPITEM');
  assert.equal(
    detectItemPath('<rss><channel><item><g:id>1</g:id><g:shipping><g:country>CZ</g:country><g:price>99</g:price></g:shipping><g:shipping><g:country>SK</g:country><g:price>1</g:price></g:shipping></item></channel></rss>'),
    'rss.channel.item'
  );
});

// ------------------------------------------------------------------------------------------------ párování nabídek

test('data-3: ITEM_ID konkurenta není „náš kód“; kód odporující EAN se nespáruje (konflikt)', () => {
  assert.equal(suggestMapping(['ITEM_ID', 'EAN', 'PRICE_VAT'], 'offers').fields.ext_id, 'ITEM_ID');
  assert.equal(suggestMapping(['ITEM_ID', 'EAN', 'PRICE_VAT'], 'offers').fields.code, undefined);
  assert.equal(suggestMapping(['ITEM_ID', 'EAN', 'PRICE_VAT'], 'offers', { nested: true }).fields.code, 'ITEM_ID', 'monitoring s vnořenými nabídkami');
  const db = openDb();
  importProducts(db, [{ code: '1001', name: 'Kolo A', ean: '8590000000011', price: 20000 }, { code: '1002', name: 'Plášť B', ean: '8590000000028', price: 900 }], { now: T1 });
  const feed = `<SHOP><SHOPITEM><ITEM_ID>1001</ITEM_ID><EAN>8590000000028</EAN><PRICE_VAT>850</PRICE_VAT></SHOPITEM><SHOPITEM><ITEM_ID>77</ITEM_ID><EAN>8590000000011</EAN><PRICE_VAT>19990</PRICE_VAT></SHOPITEM></SHOP>`;
  runImport(db, { kind: 'offers', input: { text: feed }, mapping: { defaults: { competitor: 'Konkurent.cz' } }, now: NOW });
  const o = offersOf(db);
  assert.deepEqual(o.map((x) => [x.code, x.price]), [['1001', 19990], ['1002', 850]]);
  // i s výslovně namapovaným kódem: kód 1001 vs EAN plášťě → konflikt
  const db2 = openDb();
  importProducts(db2, [{ code: '1001', ean: '8590000000011' }, { code: '1002', ean: '8590000000028' }], { now: T1 });
  const s = importOffers(db2, [{ code: '1001', ean: '8590000000028', competitor: 'X', price: 850 }], { now: NOW });
  assert.equal(s.matched, 0);
  assert.equal(JSON.parse(db2.prepare('SELECT raw FROM unmatched_offers').get().raw)._reason, 'conflict');
});

test('data-3: ruční alias konkrétního konkurenta má přednost před automatickým kódem', () => {
  const db = openDb();
  importProducts(db, [{ code: 'A' }, { code: 'B' }], { now: T1 });
  importOffers(db, [{ code: 'A', competitor: 'Velo', price: 1 }], { now: T1 });
  const velo = db.prepare("SELECT id FROM competitors WHERE name_key = 'velo'").get().id;
  const b = product(db, 'B').id;
  db.prepare("INSERT INTO product_aliases (kind, value_key, competitor_id, product_id, created_at) VALUES ('code', 'A', ?, ?, ?)").run(velo, b, T1);
  importOffers(db, [{ code: 'A', competitor: 'Velo', price: 2 }], { now: T2 });
  assert.ok(offersOf(db).some((x) => x.code === 'B' && x.price === 2));
});

test('data-4: obálka API {code: 200, data: [...]} ani <response code="200"> nepárují všechny nabídky na produkt „200“', () => {
  const db = openDb();
  importProducts(db, [{ code: '200', name: 'Pumpa', price: 590 }, { code: '1001', ean: '8590000000011' }, { code: '1002', ean: '8590000000028' }], { now: T1 });
  const body = { code: 200, message: 'OK', shop: 'A.cz', data: [{ ean: '8590000000011', price: 18990 }, { ean: '8590000000028', price: 949 }] };
  const r = runImport(db, { kind: 'offers', input: { text: JSON.stringify(body) }, now: NOW });
  assert.equal(r.stats.matched, 2);
  assert.deepEqual(offersOf(db).map((x) => [x.code, x.competitor, x.price]), [['1001', 'A.cz', 18990], ['1002', 'A.cz', 949]]);
  const db2 = openDb();
  importProducts(db2, [{ code: '200' }, { code: '1001', ean: '8590000000011' }], { now: T1 });
  const xml = '<response code="200" status="ok" shop="B.cz"><items><item><ean>8590000000011</ean><price>18000</price></item><item><ean>8590000000011</ean><price>18100</price></item></items></response>';
  runImport(db2, { kind: 'offers', input: { text: xml }, now: NOW });
  assert.deepEqual(offersOf(db2).map((x) => [x.code, x.competitor]), [['1001', 'B.cz']]);
});

test('data-5: JSON s polem „warnings“ před položkami – záznamy jsou items; deaktivace s podezřelým výsledkem se neprovede', () => {
  const items = [{ code: 'K1', price: 1 }, { code: 'K2', price: 2 }, { code: 'K3', price: 3 }];
  const ex = extractRecords({ text: JSON.stringify({ warnings: [{ code: 'STALE_CACHE', message: 'x' }], items }) }, {}, { kind: 'products' });
  assert.equal(ex.itemPath, 'items');
  const db = openDb();
  runImport(db, { kind: 'products', input: { text: JSON.stringify({ items }) }, options: { deactivate_missing: true }, now: T1 });
  const r = runImport(db, { kind: 'products', input: { text: JSON.stringify({ warnings: [{ code: 'STALE_CACHE' }], items }) }, options: { deactivate_missing: true }, now: T2 });
  assert.equal(r.stats.created, 0);
  assert.equal(r.stats.deactivated, 0);
  assert.equal(product(db, 'STALE_CACHE'), undefined);
});

test('data-6: zástupné MPN („N/A“, „0“) nepárují; MPN se nepoužije proti odporujícímu EAN', () => {
  for (const v of ['N/A', 'n/a', '0', 'x', '-', 'neuvedeno']) assert.equal(mpnKey(v), null, v);
  const db = openDb();
  importProducts(db, [{ code: 'D1', name: 'Duše', mpn: 'N/A' }, { code: 'D0', mpn: 'N/A', active: 0 }, { code: 'M1', ean: '8590000000011', mpn: 'XT-100' }], { now: T1 });
  const s = importOffers(
    db,
    [
      { ean: '4000000000017', mpn: 'n/a', name: 'Řetěz', competitor: 'X', price: 499 },
      { ean: '4000000000024', mpn: 'N/A', name: 'Pedály', competitor: 'X', price: 89 },
      { ean: '4000000000031', mpn: 'XT-100', name: 'Jiná varianta', competitor: 'X', price: 100 }, // EAN odporuje katalogu
      { mpn: 'XT-100', competitor: 'Y', price: 101 }, // bez EAN → MPN platí
    ],
    { now: NOW }
  );
  assert.equal(s.matched, 1);
  assert.deepEqual(offersOf(db).map((x) => [x.code, x.competitor]), [['M1', 'Y']]);
});

test('data-7: Google Merchant – g:sale_price má přednost před g:price; doprava pro CZ z více zemí', () => {
  const db = openDb();
  importProducts(db, [{ code: 'A', ean: '8590000000011' }], { now: T1 });
  const gm =
    '<rss xmlns:g="http://base.google.com/ns/1.0"><channel><item><g:id>X1</g:id><g:gtin>8590000000011</g:gtin><g:price>24990.00 CZK</g:price><g:sale_price>19990.00 CZK</g:sale_price>' +
    '<g:shipping><g:country>SK</g:country><g:price>149 CZK</g:price></g:shipping><g:shipping><g:country>CZ</g:country><g:price>99 CZK</g:price></g:shipping></item>' +
    '<item><g:id>X2</g:id><g:gtin>8590000000028</g:gtin><g:price>100 CZK</g:price><g:sale_price></g:sale_price></item></channel></rss>';
  const r = runImport(db, { kind: 'offers', input: { text: gm }, mapping: { defaults: { competitor: 'GM.cz' } }, now: NOW });
  assert.ok(!r.stats.errors.some((e) => /Doprava/.test(e.message)), JSON.stringify(r.stats.errors));
  const [o] = offersOf(db);
  assert.equal(o.price, 19990);
  assert.equal(o.shipping, 99);
  // prázdná akční cena → běžná cena
  assert.equal(db.prepare('SELECT price FROM unmatched_offers').get().price, 100);
});

test('data-8: duplicity v čase – platí novější zjištění; max. stáří se uplatní před výběrem', () => {
  const rows = [
    { ean: '8590000000011', competitor: 'X', price: 900, observed_at: '2026-09-01T10:00:00Z' },
    { ean: '8590000000011', competitor: 'X', price: 1000, observed_at: '2026-09-25T10:00:00Z' },
  ];
  let db = openDb();
  importProducts(db, [{ code: 'A', ean: '8590000000011' }], { now: T1 });
  importOffers(db, rows, { now: NOW });
  assert.equal(offersOf(db)[0].price, 1000);
  db = openDb();
  importProducts(db, [{ code: 'A', ean: '8590000000011' }], { now: T1 });
  const s = importOffers(db, rows, { now: NOW, maxAgeDays: 7 });
  assert.equal(s.stale, 1);
  assert.equal(offersOf(db)[0].price, 1000);
  // stejný sken (± 1 h): nejnižší cena
  db = openDb();
  importProducts(db, [{ code: 'A', ean: '8590000000011' }], { now: T1 });
  importOffers(db, [{ ...rows[1], price: 1100 }, { ...rows[1], price: 1050, observed_at: '2026-09-25T10:20:00Z' }], { now: NOW });
  assert.equal(offersOf(db)[0].price, 1050);
});

test('data-9: vnořené nabídky i jako jediný objekt (první položky mají jednu <OFFER>); replace nemaže u chybných řádků', () => {
  const items = [];
  for (let i = 1; i <= 250; i++) {
    const offers = [`<OFFER shop="A.cz"><PRICE_VAT>${1000 + i}</PRICE_VAT></OFFER>`];
    if (i > 200) offers.push(`<OFFER shop="B.cz"><PRICE_VAT>${1050 + i}</PRICE_VAT></OFFER>`);
    items.push(`<SHOPITEM><ITEM_ID>P${i}</ITEM_ID><OFFERS>${offers.join('')}</OFFERS></SHOPITEM>`);
  }
  const db = openDb();
  importProducts(db, Array.from({ length: 250 }, (_, i) => ({ code: `P${i + 1}` })), { now: T1 });
  const r = runImport(db, { kind: 'offers', input: { text: `<SHOP>${items.join('')}</SHOP>` }, options: { replace: 'competitors' }, now: NOW });
  assert.equal(r.stats.matched, 300);
  assert.equal(r.stats.errors.filter((e) => !e.warning).length, 0);
  // druhý import: u B.cz chybná cena → replace u B.cz nic nesmaže
  const bad = `<SHOP><SHOPITEM><ITEM_ID>P1</ITEM_ID><OFFERS><OFFER shop="A.cz"><PRICE_VAT>999</PRICE_VAT></OFFER><OFFER shop="B.cz"><PRICE_VAT>abc</PRICE_VAT></OFFER></OFFERS></SHOPITEM></SHOP>`;
  const r2 = runImport(db, { kind: 'offers', input: { text: bad }, options: { replace: 'competitors' }, now: '2026-09-25T13:00:00Z' });
  const cnt = (shop) => db.prepare('SELECT COUNT(*) AS n FROM offers o JOIN competitors c ON c.id = o.competitor_id WHERE c.name = ?').get(shop).n;
  assert.equal(cnt('B.cz'), 50, 'nabídky B.cz zůstaly');
  assert.equal(cnt('A.cz'), 1, 'u A.cz replace proběhl');
  assert.ok(r2.stats.removed >= 249);
});

test('data-11: varianty s vlastním SKU jsou samostatné produkty; duplicitní kód → varování a jediný záznam historie', () => {
  const db = openDb();
  const json = { products: [{ code: 'MARLIN5', name: 'Marlin 5', variants: [{ sku: 'MARLIN5-M', ean: '8590000000011', price: 19990 }, { sku: 'MARLIN5-L', ean: '8590000000028', price: 20990 }] }] };
  runImport(db, { kind: 'products', input: { text: JSON.stringify(json) }, now: T1 });
  assert.equal(product(db, 'MARLIN5-M').price, 19990);
  assert.equal(product(db, 'MARLIN5-L').price, 20990);
  assert.equal(product(db, 'MARLIN5'), undefined);
  // duplicitní kód (POHODA – karta ve více skladech): 3 dny stejného souboru
  const csv = 'kod;cena;sklad\nK1;18990;2\nK1;20000;5\n';
  for (const [i, now] of [T1, T2, NOW].entries()) {
    const r = runImport(db, { kind: 'products', input: { text: csv }, now });
    assert.ok(r.stats.errors.some((e) => /K1 je v importu 2×/.test(e.message)));
    if (i > 0) assert.equal(r.stats.unchanged, 1, 'stejný soubor = beze změny');
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM price_history h JOIN products p ON p.id = h.product_id WHERE p.code = 'K1'").get().n, 0);
  assert.equal(product(db, 'K1').price_changed_at, null);
});

test('data-12: přejmenovaný namapovaný sloupec – varování; chybí sloupec kódu – import selže', () => {
  const db = openDb();
  const mapping = { fields: { code: 'Kód', purchase_price: 'Nákupní cena', stock: 'Stav zásoby' } };
  runImport(db, { kind: 'products', input: { text: 'Kód;Nákupní cena;Stav zásoby\nA;12000;5\n' }, mapping, now: T1 });
  const r = runImport(db, { kind: 'products', input: { text: 'Kód;Nákup bez DPH;Zásoba\nA;15500;0\n' }, mapping, now: T2 });
  assert.ok(r.stats.errors.some((e) => e.warning && /Nákupní cena/.test(e.message)));
  assert.ok(r.stats.errors.some((e) => e.warning && /Stav zásoby/.test(e.message)));
  assert.throws(() => runImport(db, { kind: 'products', input: { text: 'Katalog;cena\nA;1\n' }, mapping, now: T2 }), (e) => e.code === 'MAPPING_COLUMN_MISSING');
  const failed = db.prepare("SELECT status, error FROM imports ORDER BY id DESC LIMIT 1").get();
  assert.equal(failed.status, 'error');
});

test('data-13: řídký sloupec (EAN až od 1001. položky) se najde a namapuje', () => {
  const items = [];
  for (let i = 0; i < 1000; i++) items.push(`<SHOPITEM><ITEM_ID>N${i}</ITEM_ID><PRICE_VAT>100</PRICE_VAT></SHOPITEM>`);
  items.push('<SHOPITEM><ITEM_ID>N1000</ITEM_ID><EAN>8590000000011</EAN><PRICE_VAT>19990</PRICE_VAT></SHOPITEM>');
  const db = openDb();
  importProducts(db, [{ code: 'KOLO', ean: '8590000000011' }], { now: T1 });
  const r = runImport(db, { kind: 'offers', input: { text: `<SHOP>${items.join('')}</SHOP>` }, mapping: { defaults: { competitor: 'X' } }, now: NOW });
  assert.equal(r.stats.matched, 1);
  assert.equal(offersOf(db)[0].price, 19990);
});

test('data-14: položka s více EAN se spáruje podle kteréhokoli z nich', () => {
  const db = openDb();
  importProducts(db, [{ code: 'KOLO', ean: '8590000000011' }], { now: T1 });
  const xml = '<SHOP><SHOPITEM><ITEM_ID>X1</ITEM_ID><EAN>0859000000004</EAN><EAN>8590000000011</EAN><PRICE_VAT>100</PRICE_VAT></SHOPITEM><SHOPITEM><ITEM_ID>X2</ITEM_ID><PRICE_VAT>1</PRICE_VAT></SHOPITEM></SHOP>';
  const r = runImport(db, { kind: 'offers', input: { text: xml }, mapping: { defaults: { competitor: 'X' } }, now: NOW });
  assert.equal(r.stats.matched, 1);
});

test('data-15: ZIP s více datovými soubory se odmítne (dřív se tiše vzal první)', () => {
  const zip = writeZip([
    { name: 'ceny-alza.csv', data: 'ean;konkurent;cena\n8590000000011;Alza.cz;100\n' },
    { name: 'ceny-sportisimo.csv', data: 'ean;konkurent;cena\n8590000000011;Sportisimo.cz;90\n' },
  ]);
  const db = openDb();
  assert.throws(() => runImport(db, { kind: 'offers', input: { buffer: zip, filename: 'ceny.zip' }, now: NOW }), (e) => e.code === 'ZIP_MULTIPLE');
});

test('data-16: „Skladem 0 ks“ = není skladem; doprava „zdarma“ = 0 Kč (nepřežije stará placená)', () => {
  assert.equal(normalizeAvailability('Skladem 0 ks').in_stock, 0);
  assert.equal(normalizeAvailability('Skladem 3 ks').in_stock, 1);
  assert.equal(normalizeAvailability('U dodavatele').in_stock, 0);
  assert.equal(normalizeAvailability('Předprodej').in_stock, 0);
  const db = openDb();
  importProducts(db, [{ code: 'A', ean: '8590000000011' }], { now: T1 });
  runImport(db, { kind: 'offers', input: { text: 'ean;konkurent;cena;doprava\n8590000000011;X;100;99\n' }, now: '2026-09-25T10:00:00Z' });
  assert.equal(offersOf(db)[0].shipping, 99);
  runImport(db, { kind: 'offers', input: { text: 'ean;konkurent;cena;doprava\n8590000000011;X;100;zdarma\n' }, now: NOW });
  assert.equal(offersOf(db)[0].shipping, 0);
});

test('data-17: cp1250 s ® a « » (bez š/ž) se nedekóduje jako ISO-8859-2', () => {
  const text = 'kod;nazev\n1;Řetěz KMC® X11\n2;Shimano®\n3;Světlo «LED»\n';
  assert.equal(decodeBuffer(encodeWindows1250(text)), text);
  // skutečné ISO-8859-2 (Ž/š v textu) se dál pozná
  const iso = Buffer.from([0x0a, 0xae, 0x6c, 0x75, 0x74, 0xfd, 0x20, 0xb9, 0x72, 0x6f, 0x75, 0x62]); // „\nŽlutý šroub“
  assert.equal(decodeBuffer(iso), '\nŽlutý šroub');
});

test('security-3: dlouhá hodnota dostupnosti neblokuje server (bez kvadratického regulárního výrazu)', () => {
  const t0 = Date.now();
  normalizeAvailability('1'.repeat(40000) + ' x');
  normalizeAvailability('2'.repeat(40000) + ' dní');
  assert.ok(Date.now() - t0 < 200, `${Date.now() - t0} ms`);
});
