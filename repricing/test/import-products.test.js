'use strict';
// Testy importu katalogu (SPEC §5 products.js) – přímo i přes runImport s reálnými soubory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openDb, setSetting } = require('../src/db');
const { importProducts, runImport } = require('../src/import');

const FIX = path.join(__dirname, 'fixtures', 'import');
const fx = (name) => ({ buffer: fs.readFileSync(path.join(FIX, name)), filename: name });
const T1 = '2026-09-20T10:00:00.000Z';
const T2 = '2026-09-25T10:00:00.000Z';

function product(db, code) {
  const r = db.prepare('SELECT * FROM products WHERE code_key = ?').get(code);
  return r ? { ...r, attrs: JSON.parse(r.attrs) } : null;
}

test('importProducts: založení, změna, beze změny; statistiky ve tvaru SPEC', () => {
  const db = openDb();
  let s = importProducts(db, [
    { code: 'A-1', name: 'Kolo A', price: 10990, purchase_price: 7000, vat_rate: 21, ean: '8591234567890', mpn: 'AB-12 x', attrs: { N: 'N2' } },
    { code: 'B-2', name: 'Kolo B', price: 20990 },
  ], { now: T1 });
  assert.deepEqual(s, { received: 2, created: 2, updated: 0, unchanged: 0, deactivated: 0, errors: [] });
  const a = product(db, 'A-1');
  assert.equal(a.ean_key, '8591234567890');
  assert.equal(a.mpn_key, 'AB12X');
  assert.equal(a.active, 1);
  assert.equal(a.locked, 0);
  assert.equal(a.created_at, T1);
  assert.equal(a.price_changed_at, null, 'nový produkt nemá „změnu ceny“');
  assert.deepEqual(a.attrs, { N: 'N2' });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM price_history').get().c, 0);

  s = importProducts(db, [{ code: 'A-1', name: 'Kolo A', price: 10990 }, { code: 'B-2', stock: 3 }], { now: T2 });
  assert.equal(s.unchanged, 1);
  assert.equal(s.updated, 1);
  const b = product(db, 'B-2');
  assert.equal(b.stock, 3);
  assert.equal(b.name, 'Kolo B', 'pole, která záznam nemá, se nemění');
  assert.equal(b.updated_at, T2);
  const a2 = product(db, 'A-1');
  assert.equal(a2.updated_at, T1, 'beze změny → updated_at se nemění');
  // párování podle code_key (velikost písmen, mezery); text kódu se převezme z katalogu (export ho posílá dál)
  s = importProducts(db, [{ code: ' a-1 ', price: 10990 }], { now: T2 });
  assert.deepEqual([s.created, s.updated], [0, 1]);
  assert.equal(product(db, 'A-1').code, 'a-1');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM products').get().c, 2);
});

test('importProducts: změna ceny → price_history(import) + price_changed_at; null maže hodnotu', () => {
  const db = openDb();
  importProducts(db, [{ code: 'A', price: 1000, manufacturer: 'SRAM', msrp: 1200 }], { now: T1 });
  importProducts(db, [{ code: 'A', price: 900 }], { now: T2, importId: 77 });
  const a = product(db, 'A');
  assert.equal(a.price, 900);
  assert.equal(a.price_changed_at, T2);
  const h = db.prepare('SELECT product_id, price, source, ref_id, at FROM price_history').all().map((r) => ({ ...r }));
  // první změna: nejdřív dosavadní cena platná od založení (jinak by ji lowest_30d ztratila), pak nová
  assert.deepEqual(h, [
    { product_id: a.id, price: 1000, source: 'import', ref_id: null, at: T1 },
    { product_id: a.id, price: 900, source: 'import', ref_id: 77, at: T2 },
  ]);
  // stejná cena znovu → žádná historie
  importProducts(db, [{ code: 'A', price: 900.0000000001 }], { now: '2026-09-26T00:00:00Z' });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM price_history').get().c, 2);
  // null = smazat (prázdná buňka ve zdroji)
  importProducts(db, [{ code: 'A', manufacturer: null, msrp: null }], { now: T2 });
  const a2 = product(db, 'A');
  assert.equal(a2.manufacturer, null);
  assert.equal(a2.msrp, null);
  assert.equal(a2.price, 900);
});

test('importProducts: pole spravovaná aplikací se nepřepíší (ani přes runImport se sloupcem Poznámka/note)', () => {
  const db = openDb();
  importProducts(db, [{ code: 'A', price: 100 }], { now: T1 });
  db.prepare("UPDATE products SET locked = 1, locked_until = '2027-01-01T00:00:00.000Z', min_price = 90, max_price = 150, note = 'ručně' WHERE code_key = 'A'").run();
  importProducts(db, [{ code: 'A', price: 110, name: 'X' }], { now: T2 });
  let a = product(db, 'A');
  assert.deepEqual([a.locked, a.locked_until, a.min_price, a.max_price, a.note], [1, '2027-01-01T00:00:00.000Z', 90, 150, 'ručně']);
  // CSV se sloupci note / min_price / locked bez výslovného mapování → jen do attrs
  runImport(db, { kind: 'products', input: { text: 'code;price;note;min_price;locked\nA;120;ze souboru;1;0\n' }, origin: 'upload', now: T2 });
  a = product(db, 'A');
  assert.deepEqual([a.locked, a.min_price, a.note, a.price], [1, 90, 'ručně', 120]);
  assert.equal(a.attrs.note, 'ze souboru');
  // výslovné mapování je přepíše
  runImport(db, {
    kind: 'products',
    input: { text: 'code;min;lock;pozn\nA;95;ne;nová\n' },
    mapping: { fields: { min_price: 'min', locked: 'lock', note: 'pozn' } },
    origin: 'upload',
    now: T2,
  });
  a = product(db, 'A');
  assert.deepEqual([a.locked, a.min_price, a.note], [0, 95, 'nová']);
  // explicitní záznam může nastavit zámek s expirací
  importProducts(db, [{ code: 'A', locked: true, locked_until: '31.12.2026 23:59' }], { now: T2 });
  a = product(db, 'A');
  assert.equal(a.locked, 1);
  assert.equal(a.locked_until, '2026-12-31T22:59:00.000Z');
});

test('importProducts: attrs – nové klíče přepisují, ostatní zůstávají, null maže', () => {
  const db = openDb();
  importProducts(db, [{ code: 'A', attrs: { N: 'N2', sezona: 2025, abc: 'A' } }], { now: T1 });
  const s = importProducts(db, [{ code: 'A', attrs: { N: 'N7', imprese_30: 1200, abc: null } }], { now: T2 });
  assert.equal(s.updated, 1);
  assert.deepEqual(product(db, 'A').attrs, { N: 'N7', sezona: 2025, imprese_30: 1200 });
  const s2 = importProducts(db, [{ code: 'A', attrs: { N: 'N7' } }], { now: T2 });
  assert.equal(s2.unchanged, 1);
  // attrs jako JSON text (přímé volání)
  importProducts(db, [{ code: 'A', attrs: '{"x":1}' }], { now: T2 });
  assert.equal(product(db, 'A').attrs.x, 1);
});

test('importProducts: nákupní cena s DPH (nastavení) a ceny bez DPH (price_is_net)', () => {
  const db = openDb();
  setSetting(db, 'purchase_includes_vat', true);
  importProducts(db, [{ code: 'A', purchase_price: 1210, vat_rate: 21 }, { code: 'B', purchase_price: 1120 }], { now: T1 });
  assert.equal(product(db, 'A').purchase_price, 1000);
  assert.equal(Math.round(product(db, 'B').purchase_price * 100) / 100, 925.62, 'výchozí DPH 21 %');
  setSetting(db, 'purchase_includes_vat', false);
  importProducts(db, [{ code: 'C', vat_rate: 12, price: 1000, msrp: 1100, price_is_net: true }], { now: T1 });
  const c = product(db, 'C');
  assert.equal(c.price, 1120);
  assert.equal(c.msrp, 1232);
  // bez DPH v záznamu → DPH uložené u produktu
  importProducts(db, [{ code: 'C', price: 2000, price_is_net: true }], { now: T2 });
  assert.equal(product(db, 'C').price, 2240);
});

test('importProducts: deactivateMissing + opětovná aktivace + pojistka proti prázdnému importu', () => {
  const db = openDb();
  importProducts(db, [{ code: 'A' }, { code: 'B' }, { code: 'C' }], { now: T1 });
  let s = importProducts(db, [{ code: 'A' }, { code: 'B' }], { now: T2, deactivateMissing: true });
  assert.equal(s.deactivated, 1);
  assert.equal(product(db, 'C').active, 0);
  // bez deactivateMissing se C neaktivuje ani nedeaktivuje nic jiného
  s = importProducts(db, [{ code: 'A' }], { now: T2 });
  assert.equal(s.deactivated, 0);
  assert.equal(product(db, 'B').active, 1);
  // C je zpět v plném katalogu → aktivní
  s = importProducts(db, [{ code: 'A' }, { code: 'B' }, { code: 'C' }], { now: T2, deactivateMissing: true });
  assert.equal(product(db, 'C').active, 1);
  assert.equal(s.updated, 1);
  assert.equal(s.deactivated, 0);
  // import bez jediného platného řádku nesmí deaktivovat celý katalog
  s = importProducts(db, [{ name: 'bez kódu' }], { now: T2, deactivateMissing: true });
  assert.equal(s.deactivated, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM products WHERE active = 1').get().c, 3);
  assert.ok(s.errors.some((e) => /deaktivace/.test(e.message)));
  // výslovné active = 0 ze zdroje
  importProducts(db, [{ code: 'B', active: 'ne' }], { now: T2 });
  assert.equal(product(db, 'B').active, 0);
});

test('importProducts: chyby, varování, duplicitní řádky, limit 100 chyb', () => {
  const db = openDb();
  const s = importProducts(db, [{ code: '' }, { code: 'A', price: 'hodně', stock: 5 }, { code: 'A', stock: 6 }, null], { now: T1 });
  assert.equal(s.received, 4);
  assert.equal(s.created, 1, 'duplicitní kód se počítá jednou');
  assert.equal(product(db, 'A').stock, 6, 'pozdější řádek vyhrává');
  assert.deepEqual(
    s.errors.map((e) => [e.row, e.warning === true]),
    [
      [1, false],
      [2, true],
      [4, false],
    ]
  );
  assert.equal(s.errors[0].message, 'Chybí kód produktu');
  const many = importProducts(db, Array.from({ length: 250 }, () => ({ name: 'x' })), { now: T1 });
  assert.equal(many.errors.length, 100);
  assert.equal(many.errors[99].row, null);
  assert.match(many.errors[99].message, /dalších 151/);
  // duplicita: první beze změny, druhá změní → updated
  const d = importProducts(db, [{ code: 'A', stock: 6 }, { code: 'A', stock: 7 }], { now: T2 });
  assert.deepEqual([d.unchanged, d.updated], [0, 1]);
});

test('runImport: katalog z POHODY (cp1250 CSV) – kódy s mezerami, EAN v exponentu, ceny s měnou, attrs, řádky chyb', () => {
  const db = openDb();
  const r = runImport(db, { kind: 'products', input: fx('katalog-cp1250.csv'), origin: 'upload', now: T1 });
  assert.equal(r.stats.received, 6);
  assert.equal(r.stats.created, 4);
  assert.equal(r.stats.errors.length, 1);
  assert.deepEqual(r.stats.errors[0], { row: 6, message: 'Chybí kód produktu' });
  const s = product(db, 'SAN014XS');
  assert.equal(s.code, 'SAN 014 XS');
  assert.equal(s.ean, '8590000000000');
  assert.equal(s.price, 107990);
  assert.equal(s.msrp, 107990);
  assert.equal(s.purchase_price, 65113);
  assert.deepEqual(s.attrs, { N: 'N7', Sezóna: 2024, 'Imprese 30': 1194 });
  const x = product(db, 'SRA-001');
  assert.equal(x.name, 'SRAM XTR kliky – černé');
  assert.equal(x.owner, 'Petr Svoboda');
  assert.equal(x.purchase_price, 505.5);
  assert.equal(x.vat_rate, 21);
  assert.equal(x.attrs.Poznámka, 'ze souboru');
  assert.equal(x.note, null);
  const m = product(db, 'MAX-028');
  assert.equal(m.ean_key, '8595234463384', 'úvodní nuly EAN se v klíči ignorují');
  assert.equal(m.price, 819);
  const z = product(db, 'ŽLU-777');
  assert.equal(z.vat_rate, 12);
  assert.equal(z.price, 29.9);
  assert.deepEqual(z.attrs, { N: 'N0' });
  // znovu stejný soubor → vše beze změny
  const again = runImport(db, { kind: 'products', input: fx('katalog-cp1250.csv'), origin: 'upload', now: T2 });
  assert.equal(again.stats.unchanged, 4);
  assert.equal(again.stats.updated, 0);
});

test('runImport: Google Merchant feed a POHODA listStock jako katalog', () => {
  const db = openDb();
  const g = runImport(db, { kind: 'products', input: fx('google-merchant.xml'), now: T1 });
  assert.equal(g.stats.created, 2);
  const a = product(db, 'SRA-001');
  assert.deepEqual([a.name, a.price, a.ean, a.manufacturer, a.mpn, a.category], ['SRAM XTR kliky', 9990, '8597315660484', 'SRAM', 'XTR-M9100', 'Komponenty > Kliky']);
  assert.equal(a.attrs.availability, 'in_stock');
  const p = runImport(db, { kind: 'products', input: fx('pohoda-liststock.xml'), now: T2 });
  assert.equal(p.stats.updated, 2);
  const m = product(db, 'MAX-028');
  assert.deepEqual([m.price, m.purchase_price, m.vat_rate, m.stock], [819, 488, 12, -1]);
  const s = product(db, 'SRA-001');
  assert.equal(s.price, 909);
  assert.equal(s.price_changed_at, T2);
  // výchozí cena 9 990 (od založení) + změna na 909
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM price_history WHERE source = ?').get('import').c, 2);
});

test('runImport: varianty produktů (Shoptet-like XML) → produkt na variantu, bez duplicit v attrs', () => {
  const db = openDb();
  const xml = `<SHOP><SHOPITEM><NAME>Kolo Trail</NAME><MANUFACTURER>Author</MANUFACTURER><CODE>TRAIL</CODE>
    <VARIANTS><VARIANT><CODE>TRAIL-M</CODE><EAN>8591111111116</EAN><PRICE_VAT>24 990</PRICE_VAT><PARAMETERS><PARAMETER><NAME>Velikost</NAME><VALUE>M</VALUE></PARAMETER></PARAMETERS></VARIANT>
    <VARIANT><CODE>TRAIL-L</CODE><PRICE_VAT>25 990</PRICE_VAT></VARIANT></VARIANTS></SHOPITEM>
    <SHOPITEM><NAME>Zvonek</NAME><CODE>ZVON</CODE><PRICE_VAT>199</PRICE_VAT></SHOPITEM></SHOP>`;
  const r = runImport(db, { kind: 'products', input: { text: xml }, now: T1 });
  assert.equal(r.stats.created, 3);
  const m = product(db, 'TRAIL-M');
  assert.deepEqual([m.name, m.manufacturer, m.price, m.ean], ['Kolo Trail', 'Author', 24990, '8591111111116']);
  assert.deepEqual(m.attrs, { 'PARAMETERS.PARAMETER.Velikost': 'M' });
  assert.equal(product(db, 'ZVON').price, 199);
  assert.equal(product(db, 'TRAIL'), null, 'rodič s variantami sám produktem není');
});

test('regrese: změna ceny importem zachová dosavadní cenu pro lowest_30d (Omnibus)', () => {
  const { exportRows } = require('../src/export/rows');
  const db = openDb();
  importProducts(db, [{ code: 'OMNI-2', price: 1000 }], { now: T1 });
  importProducts(db, [{ code: 'OMNI-2', price: 1200 }], { now: T2 });
  const row = exportRows(db, { scope: 'all', now: T2 }).find((r) => r.code === 'OMNI-2');
  assert.equal(row.price, 1200);
  assert.equal(row.lowest_30d, 1000, 'cena 1 000 platila ještě před 5 dny');
});
