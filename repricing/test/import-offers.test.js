'use strict';
// Testy importu nabídek konkurence (SPEC §5 offers.js): párování, aliasy, nespárované, historie, nahrazení, matchUnmatched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db');
const { importProducts, importOffers, matchUnmatched, runImport, ImportError } = require('../src/import');

const FIX = path.join(__dirname, 'fixtures', 'import');
const fx = (name) => ({ buffer: fs.readFileSync(path.join(FIX, name)), filename: name });
const T1 = '2026-09-20T10:00:00.000Z';
const T2 = '2026-09-21T10:00:00.000Z';
const T3 = '2026-09-22T10:00:00.000Z';
const STATS_KEYS = ['received', 'matched', 'unmatched', 'ambiguous', 'created', 'updated', 'unchanged', 'stale', 'duplicates', 'removed', 'competitors_created', 'errors'];

function setup() {
  const db = openDb();
  importProducts(
    db,
    [
      { code: 'A', ean: '8591234567890', mpn: 'MPN-A', price: 1000, vat_rate: 21 },
      { code: 'B', ean: '8591234567891', mpn: 'MPN-B', price: 2000, vat_rate: 12 },
      { code: 'C', ean: '8591234567892', price: 3000 },
      // dva produkty se stejným EAN (varianty bez vlastního EAN)
      { code: 'D1', ean: '8590000000001', mpn: 'D-S', price: 100 },
      { code: 'D2', ean: '8590000000001', mpn: 'D-M', price: 100 },
    ],
    { now: T1 }
  );
  return db;
}

const pid = (db, code) => db.prepare('SELECT id FROM products WHERE code_key = ?').get(code).id;
const offers = (db) =>
  db
    .prepare('SELECT p.code, c.name AS competitor, o.* FROM offers o JOIN products p ON p.id = o.product_id JOIN competitors c ON c.id = o.competitor_id ORDER BY p.code, c.name')
    .all()
    .map((r) => ({ ...r }));
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;

test('importOffers: statistiky mají přesně klíče ze SPEC; založení konkurenta podle nameKey', () => {
  const db = setup();
  const s = importOffers(
    db,
    [
      { ean: '8591234567890', competitor: 'VeloMarket.cz', price: 990 },
      { ean: '8591234567891', competitor: 'https://www.velomarket.cz/', price: 1990 },
      { ean: '8591234567892', competitor: 'KOLO-shop.cz ', price: 2990, in_stock: 1 },
    ],
    { now: T1 }
  );
  assert.deepEqual(Object.keys(s), STATS_KEYS);
  assert.deepEqual({ ...s, errors: undefined }, {
    received: 3, matched: 3, unmatched: 0, ambiguous: 0, created: 3, updated: 0, unchanged: 0, stale: 0, duplicates: 0, removed: 0, competitors_created: 2, errors: undefined,
  });
  const comps = db.prepare('SELECT name, name_key FROM competitors ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepEqual(comps, [
    { name: 'VeloMarket.cz', name_key: 'velomarket.cz' },
    { name: 'KOLO-shop.cz', name_key: 'kolo-shop.cz' },
  ]);
  const o = offers(db).find((x) => x.code === 'C');
  assert.equal(o.in_stock, 1);
  assert.equal(o.observed_at, T1);
  assert.equal(o.first_seen_at, T1);
  assert.equal(o.prev_price, null);
});

test('párování: kód má přednost před EAN, pak EAN, pak MPN; kódy bez ohledu na mezery a velikost', () => {
  const db = setup();
  const s = importOffers(
    db,
    [
      { code: ' b ', ean: '8591234567890', competitor: 'X', price: 10 }, // kód B vyhrává nad EAN produktu A
      { ean: '08591234567892', competitor: 'X', price: 11 }, // GTIN-14 s nulou → C
      { mpn: 'mpn a', competitor: 'X', price: 12 }, // MPN bez separátorů → A
      { code: 'NEZNÁMÝ', ean: '8591234567891', competitor: 'Y', price: 13 }, // kód nenalezen → EAN → B
    ],
    { now: T1 }
  );
  assert.equal(s.matched, 4);
  const byComp = offers(db).map((o) => [o.code, o.competitor, o.price]);
  assert.deepEqual(byComp, [
    ['A', 'X', 12],
    ['B', 'X', 10],
    ['B', 'Y', 13],
    ['C', 'X', 11],
  ]);
});

test('párování: více produktů se stejným EAN → ambiguous; MPN zúží; aktivní má přednost', () => {
  const db = setup();
  let s = importOffers(db, [{ ean: '8590000000001', competitor: 'X', price: 50, name: 'Varianta ?' }], { now: T1 });
  assert.deepEqual([s.matched, s.unmatched, s.ambiguous], [0, 0, 1]);
  const u = db.prepare('SELECT * FROM unmatched_offers').get();
  assert.equal(u.match_key, 'ean:8590000000001');
  const raw = JSON.parse(u.raw);
  assert.equal(raw._reason, 'ambiguous');
  assert.deepEqual(raw._candidates.sort(), [pid(db, 'D1'), pid(db, 'D2')].sort());
  // MPN vybere jednoho z kandidátů
  s = importOffers(db, [{ ean: '8590000000001', mpn: 'D-M', competitor: 'X', price: 51 }], { now: T1 });
  assert.equal(s.matched, 1);
  assert.equal(offers(db)[0].code, 'D2');
  // MPN, který mezi kandidáty není → pořád nejednoznačné (konflikt identifikátorů)
  s = importOffers(db, [{ ean: '8590000000001', mpn: 'MPN-A', competitor: 'Z', price: 52 }], { now: T1 });
  assert.equal(s.ambiguous, 1);
  // neaktivní duplikát nevadí
  db.prepare("UPDATE products SET active = 0 WHERE code_key = 'D1'").run();
  s = importOffers(db, [{ ean: '8590000000001', competitor: 'W', price: 53 }], { now: T1 });
  assert.equal(s.matched, 1);
  assert.equal(offers(db).find((o) => o.competitor === 'W').code, 'D2');
});

test('aliasy: druhy code/ean/mpn/ext/name, alias konkurenta má přednost před obecným', () => {
  const db = setup();
  importOffers(db, [{ ext_id: 'x-1', competitor: 'Velo', price: 1 }], { now: T1 }); // založí konkurenta
  const velo = db.prepare("SELECT id FROM competitors WHERE name_key = 'velo'").get().id;
  const ins = db.prepare('INSERT INTO product_aliases (kind, value_key, competitor_id, product_id, created_at) VALUES (?, ?, ?, ?, ?)');
  ins.run('ext', 'X-99', 0, pid(db, 'A'), T1); // obecný
  ins.run('ext', 'X-99', velo, pid(db, 'B'), T1); // pro Velo
  ins.run('name', 'kolo trail 2026', 0, pid(db, 'C'), T1);
  ins.run('ean', '8590000000001', velo, pid(db, 'D1'), T1); // ruční rozhodnutí nejednoznačného EAN
  ins.run('code', 'THEIR-CODE', 0, pid(db, 'A'), T1);
  const s = importOffers(
    db,
    [
      { ext_id: ' x-99 ', competitor: 'Velo', price: 10 },
      { ext_id: 'X-99', competitor: 'Jiný', price: 11 },
      { name: '  Kolo  TRAIL 2026 ', competitor: 'Jiný', price: 12 },
      { ean: '8590000000001', competitor: 'Velo', price: 13 },
      { code: 'their-code', competitor: 'Třetí', price: 14 },
    ],
    { now: T2 }
  );
  assert.deepEqual([s.matched, s.unmatched, s.ambiguous], [5, 0, 0]);
  const got = offers(db).map((o) => [o.code, o.competitor, o.price]);
  assert.deepEqual(got, [
    ['A', 'Jiný', 11],
    ['A', 'Třetí', 14],
    ['B', 'Velo', 10],
    ['C', 'Jiný', 12],
    ['D1', 'Velo', 13],
  ]);
});

test('nespárované: match_key (ean > mpn > code > ext > name), seen_count jednou za import, nejnižší cena, úklid po spárování', () => {
  const db = setup();
  const s = importOffers(
    db,
    [
      { ean: '9999999999994', mpn: 'Q-1', code: 'Q', competitor: 'X', price: 100, name: 'Cizí', url: 'https://x/1' },
      { ean: '9999999999994', competitor: 'X', price: 90 }, // stejný klíč v jednom importu
      { mpn: 'Q-2', code: 'Q2', competitor: 'X', price: 1 },
      { code: 'Q3', ext_id: 'e-3', competitor: 'X', price: 1 },
      { ext_id: 'e 4', name: 'N', competitor: 'X', price: 1 },
      { name: 'Jen Název Žluťoučký', competitor: 'X', price: 1 },
    ],
    { now: T1 }
  );
  assert.equal(s.unmatched, 6);
  const rows = db.prepare('SELECT match_key, seen_count, price, first_seen_at, last_seen_at FROM unmatched_offers ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepEqual(
    rows.map((r) => r.match_key),
    ['ean:9999999999994', 'mpn:Q2', 'code:Q3', 'ext:E4', 'name:jen nazev zlutoucky']
  );
  assert.equal(rows[0].seen_count, 1);
  assert.equal(rows[0].price, 90);
  // další import → seen_count + 1, last_seen_at
  importOffers(db, [{ ean: '9999999999994', competitor: 'X', price: 95 }], { now: T2 });
  const u = db.prepare("SELECT * FROM unmatched_offers WHERE match_key = 'ean:9999999999994'").get();
  assert.deepEqual([u.seen_count, u.price, u.first_seen_at, u.last_seen_at], [2, 95, T1, T2]);
  // produkt se objeví v katalogu → nabídka se spáruje a zmizí z fronty
  importProducts(db, [{ code: 'Q', ean: '9999999999994' }], { now: T2 });
  const s2 = importOffers(db, [{ ean: '9999999999994', competitor: 'X', price: 96 }], { now: T3 });
  assert.equal(s2.matched, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM unmatched_offers WHERE match_key = 'ean:9999999999994'").get().c, 0);
  assert.equal(count(db, 'unmatched_offers'), 4);
});

test('offer_history jen při změně ceny nebo dostupnosti; prev_price / changed_at; ostatní pole', () => {
  const db = setup();
  const base = { ean: '8591234567890', competitor: 'X' };
  importOffers(db, [{ ...base, price: 1000, in_stock: 1, shipping: 99, url: 'u1' }], { now: T1 });
  let s = importOffers(db, [{ ...base, price: 1000, in_stock: 1, shipping: 99, url: 'u1' }], { now: T2 });
  assert.deepEqual([s.unchanged, s.updated], [1, 0]);
  assert.equal(count(db, 'offer_history'), 1);
  assert.equal(offers(db)[0].observed_at, T2, 'observed_at se obnoví i bez změny');
  s = importOffers(db, [{ ...base, price: 950 }], { now: T3 });
  assert.equal(s.updated, 1);
  let o = offers(db)[0];
  assert.deepEqual([o.price, o.prev_price, o.changed_at, o.in_stock, o.shipping, o.url], [950, 1000, T3, 1, 99, 'u1']);
  assert.equal(count(db, 'offer_history'), 2);
  // jen dostupnost → historie, prev_price zůstává
  s = importOffers(db, [{ ...base, price: 950, availability: 'vyprodáno', observed_at: '2026-09-23T10:00:00Z' }], { now: '2026-09-23T10:00:00Z' });
  o = offers(db)[0];
  assert.deepEqual([o.in_stock, o.prev_price, o.changed_at], [0, 1000, T3]);
  assert.equal(count(db, 'offer_history'), 3);
  // jen doprava → updated, bez historie
  s = importOffers(db, [{ ...base, price: 950, shipping: 0 }], { now: '2026-09-24T10:00:00Z' });
  assert.equal(s.updated, 1);
  assert.equal(count(db, 'offer_history'), 3);
  const h = db.prepare('SELECT price, in_stock, observed_at FROM offer_history ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepEqual(h, [
    { price: 1000, in_stock: 1, observed_at: T1 },
    { price: 950, in_stock: 1, observed_at: T3 },
    { price: 950, in_stock: 0, observed_at: '2026-09-23T10:00:00.000Z' },
  ]);
});

test('zastaralé observed_at, maxAgeDays, budoucí čas, duplicity (nejnižší cena)', () => {
  const db = setup();
  const base = { ean: '8591234567890', competitor: 'X' };
  importOffers(db, [{ ...base, price: 1000, observed_at: T2 }], { now: T3 });
  let s = importOffers(db, [{ ...base, price: 1, observed_at: T1 }], { now: T3 });
  assert.equal(s.stale, 1);
  assert.equal(offers(db)[0].price, 1000);
  s = importOffers(db, [{ ...base, price: 900, observed_at: '2026-09-01T00:00:00Z' }, { ean: '8591234567891', competitor: 'X', price: 5, observed_at: '2026-09-01' }], {
    now: T3,
    maxAgeDays: 7,
  });
  assert.equal(s.stale, 2);
  assert.equal(count(db, 'offers'), 1);
  // budoucí čas se ořízne na „teď“ (jinak by zablokoval další importy)
  importOffers(db, [{ ...base, price: 800, observed_at: '2030-01-01T00:00:00Z' }], { now: T3 });
  assert.equal(offers(db)[0].observed_at, T3);
  // duplicity: nejnižší cena; při shodě ceny skladem
  s = importOffers(
    db,
    [
      { ean: '8591234567891', competitor: 'Y', price: 500, url: 'drahá' },
      { ean: '8591234567891', competitor: 'y', price: 450, url: 'levná' },
      { code: 'B', competitor: 'Y', price: 470 },
      { ean: '8591234567892', competitor: 'Y', price: 300, in_stock: 0, url: 'není' },
      { ean: '8591234567892', competitor: 'Y', price: 300, in_stock: 1, url: 'je' },
    ],
    { now: T3 }
  );
  assert.deepEqual([s.matched, s.duplicates, s.created], [5, 3, 2]);
  const y = offers(db).filter((o) => o.competitor === 'Y');
  assert.deepEqual(
    y.map((o) => [o.code, o.price, o.url]),
    [
      ['B', 450, 'levná'],
      ['C', 300, 'je'],
    ]
  );
});

test('replace: competitors / all, pojistka proti prázdnému importu', () => {
  const db = setup();
  importOffers(
    db,
    [
      { code: 'A', competitor: 'X', price: 1 },
      { code: 'B', competitor: 'X', price: 1 },
      { code: 'A', competitor: 'Y', price: 1 },
      { code: 'C', competitor: 'Z', price: 1 },
    ],
    { now: T1 }
  );
  let s = importOffers(db, [{ code: 'A', competitor: 'X', price: 2 }, { code: 'NIKDE', competitor: 'Y', price: 1 }], { now: T2, replace: 'competitors' });
  assert.equal(s.removed, 2, 'X/B a Y/A zmizí, Z zůstává');
  assert.deepEqual(
    offers(db).map((o) => `${o.code}/${o.competitor}`),
    ['A/X', 'C/Z']
  );
  // zastaralý řádek se nepočítá jako chybějící
  s = importOffers(db, [{ code: 'A', competitor: 'X', price: 3, observed_at: '2026-01-01' }], { now: T2, replace: 'all' });
  assert.equal(s.stale, 1);
  assert.equal(s.removed, 1);
  assert.deepEqual(
    offers(db).map((o) => `${o.code}/${o.competitor}`),
    ['A/X']
  );
  s = importOffers(db, [{ competitor: 'X', price: 0 }], { now: T2, replace: 'all' });
  assert.equal(s.removed, 0);
  assert.equal(count(db, 'offers'), 1);
  assert.ok(s.errors.some((e) => /přeskočeno/.test(e.message)));
  assert.throws(() => importOffers(db, [], { replace: 'vše' }), ImportError);
});

test('validace řádků, varování a ceny bez DPH (DPH produktu)', () => {
  const db = setup();
  const s = importOffers(
    db,
    [
      { ean: '8591234567890', competitor: 'X', price: 0 },
      { ean: '8591234567890', competitor: 'X', price: 'zdarma' },
      { ean: '8591234567890', competitor: '', price: 10 },
      { competitor: 'X', price: 10 },
      { ean: '8591234567890', competitor: 'X', price: '1 000', shipping: 'hodně' },
      { ean: '8591234567891', competitor: 'X', price: 1000, shipping: 100, price_is_net: true },
      'nesmysl',
    ],
    { now: T1 }
  );
  assert.equal(s.matched, 2);
  assert.deepEqual(
    s.errors.map((e) => e.row),
    [1, 2, 3, 4, 5, 7]
  );
  assert.equal(s.errors[4].warning, true);
  assert.match(s.errors[0].message, /Neplatná cena/);
  assert.match(s.errors[2].message, /konkurent/);
  assert.match(s.errors[3].message, /párovací klíč/);
  const b = offers(db).find((o) => o.code === 'B');
  assert.equal(b.price, 1120, 'DPH produktu B je 12 %');
  assert.equal(b.shipping, 121, 'doprava s výchozí DPH 21 %');
});

test('matchUnmatched: alias z nejsilnějšího identifikátoru, znovu naimportuje nabídku, smaže řádek; příště páruje sám', () => {
  const db = setup();
  importOffers(db, [{ ean: '9999999999994', mpn: 'Q-1', name: 'Cizí kolo', competitor: 'Velo', price: 777, url: 'https://velo/q', observed_at: T1 }], { now: T1 });
  const u = db.prepare('SELECT * FROM unmatched_offers').get();
  const r = matchUnmatched(db, u.id, pid(db, 'C'), { now: T2 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.alias, { kind: 'ean', value_key: '9999999999994', competitor_id: u.competitor_id });
  assert.equal(count(db, 'unmatched_offers'), 0);
  const o = offers(db);
  assert.equal(o.length, 1);
  assert.deepEqual([o[0].code, o[0].price, o[0].url, o[0].observed_at], ['C', 777, 'https://velo/q', T1]);
  // další import stejné nabídky se spáruje přes alias
  const s = importOffers(db, [{ ean: '9999999999994', competitor: 'velo', price: 700 }], { now: T3 });
  assert.equal(s.matched, 1);
  assert.equal(offers(db)[0].price, 700);
  // jiný konkurent se stejným EAN alias nepoužije (alias je pro konkrétního konkurenta)
  const s2 = importOffers(db, [{ ean: '9999999999994', competitor: 'Jiný', price: 701 }], { now: T3 });
  assert.equal(s2.unmatched, 1);
});

test('matchUnmatched: volba druhu, název, chyby', () => {
  const db = setup();
  importOffers(db, [{ mpn: 'Q-9', name: 'Trail 29"', competitor: 'X', price: 5 }, { name: 'Jen název', competitor: 'X', price: 6 }], { now: T1 });
  const [u1, u2] = db.prepare('SELECT * FROM unmatched_offers ORDER BY id').all();
  let r = matchUnmatched(db, u1.id, pid(db, 'A'), { kind: 'name', now: T2 });
  assert.equal(r.alias.kind, 'name');
  assert.equal(r.alias.value_key, 'trail 29"');
  r = matchUnmatched(db, u2.id, pid(db, 'B'), { now: T2 });
  assert.deepEqual([r.alias.kind, r.alias.value_key], ['name', 'jen nazev']);
  assert.equal(count(db, 'offers'), 2);
  assert.throws(() => matchUnmatched(db, 999, pid(db, 'A')), (e) => e instanceof ImportError && e.status === 404);
  importOffers(db, [{ ean: '9999999999994', competitor: 'X', price: 5 }], { now: T1 });
  const u3 = db.prepare('SELECT * FROM unmatched_offers').get();
  assert.throws(() => matchUnmatched(db, u3.id, 424242), (e) => e.status === 404);
  assert.throws(() => matchUnmatched(db, u3.id, pid(db, 'A'), { kind: 'mpn' }), /identifikátor/);
  assert.equal(count(db, 'unmatched_offers'), 1, 'při chybě se nic nezmění');
  assert.equal(count(db, 'product_aliases'), 2);
});

test('velký import (hromadná cesta nad 2000 záznamů) dává stejné výsledky jako malý', () => {
  const db = setup();
  const recs = [];
  for (let i = 0; i < 2100; i++) recs.push({ code: 'A', competitor: `Shop ${i % 700}`, price: 1000 - (i % 3) });
  recs.push({ ean: '8590000000001', competitor: 'Shop 1', price: 5 });
  recs.push({ ean: '9999999999994', competitor: 'Shop 1', price: 5 });
  const s = importOffers(db, recs, { now: T1 });
  assert.deepEqual(
    [s.received, s.matched, s.ambiguous, s.unmatched, s.created, s.duplicates, s.competitors_created],
    [2102, 2100, 1, 1, 700, 1400, 700]
  );
  assert.equal(db.prepare("SELECT MIN(price) AS m, MAX(price) AS x FROM offers").get().x, 998);
  const s2 = importOffers(db, recs, { now: T2, replace: 'all' });
  assert.deepEqual([s2.unchanged, s2.removed], [700, 0]);
});

test('runImport: nabídky z CSV s BOM bez sloupce konkurenta (defaults), duplicity, chyby řádků', () => {
  const db = openDb();
  importProducts(db, [{ code: 'SRA-001', ean: '8597315660484' }, { code: 'SAN 014 XS', ean: '8.59E+12' }, { code: 'MAX-028', ean: '8595234463384' }], { now: T1 });
  const r = runImport(db, { kind: 'offers', input: fx('konkurence-bom.csv'), mapping: { defaults: { competitor: 'VeloMarket.cz' } }, origin: 'upload', now: '2026-09-25T12:00:00Z' });
  const s = r.stats;
  assert.deepEqual([s.received, s.matched, s.unmatched, s.duplicates, s.created, s.competitors_created], [6, 3, 1, 1, 2, 1]);
  assert.deepEqual(
    s.errors.map((e) => e.row),
    [5, 5, 6]
  );
  const o = offers(db);
  const sra = o.find((x) => x.code === 'SRA-001');
  assert.deepEqual([sra.price, sra.in_stock, sra.delivery_days, sra.url, sra.observed_at], [12490, 0, 3, 'https://velo.example/p/1b', '2026-09-25T08:16:00.000Z']);
  const san = o.find((x) => x.code === 'SAN 014 XS');
  assert.deepEqual([san.price, san.in_stock, san.shipping], [107990, 0, 0]);
  assert.equal(db.prepare('SELECT match_key FROM unmatched_offers').get().match_key, 'ean:9999999999994');
});

test('runImport: Heureka-like XML s konkurentem v atributu a vnořený JSON', () => {
  const db = openDb();
  importProducts(db, [{ code: 'SRA-001', ean: '8597315660484' }, { code: 'MAX-028', ean: '8595234463384' }], { now: T1 });
  const now = '2026-09-25T12:00:00Z';
  const r = runImport(db, { kind: 'offers', input: fx('heureka-konkurence.xml'), now });
  assert.deepEqual([r.stats.received, r.stats.matched, r.stats.unmatched, r.stats.competitors_created], [4, 3, 1, 3]);
  let o = offers(db);
  assert.deepEqual(
    o.map((x) => [x.code, x.competitor, x.price, x.in_stock, x.delivery_days]),
    [
      ['MAX-028', 'VeloMarket.cz', 799, 1, 0], // „www.VeloMarket.cz“ = stejný konkurent
      ['SRA-001', 'KoloPointer.cz', 12790, 0, 3],
      ['SRA-001', 'VeloMarket.cz', 12490, 1, 0],
    ]
  );
  const u = db.prepare('SELECT * FROM unmatched_offers').get();
  assert.equal(u.match_key, 'code:NEEXISTUJE-1');
  assert.equal(u.name, 'Cizí produkt');
  const j = runImport(db, { kind: 'offers', input: fx('konkurence-vnorene.json'), now: '2026-09-25T13:00:00Z' });
  assert.deepEqual([j.stats.received, j.stats.matched, j.stats.duplicates, j.stats.updated, j.stats.created], [4, 4, 1, 2, 1]);
  o = offers(db);
  assert.equal(o.find((x) => x.code === 'SRA-001' && x.competitor === 'VeloMarket.cz').price, 12390);
  assert.equal(o.find((x) => x.code === 'MAX-028' && x.competitor === 'CykloDům.cz').in_stock, 1);
});
