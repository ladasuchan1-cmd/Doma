'use strict';
// Import „jen aktualizovat“ (C6) a pole group_code (C3) v importu katalogu.

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { importProducts, runImport, suggestMapping, applyMapping, CANONICAL } = require('../src/import');
const { FIELDS } = require('../src/engine/metrics');

const T1 = '2026-09-20T10:00:00.000Z';
const T2 = '2026-09-25T10:00:00.000Z';

function product(db, code) {
  const r = db.prepare('SELECT * FROM products WHERE code_key = ?').get(code);
  return r ? { ...r, attrs: JSON.parse(r.attrs) } : null;
}

function seed() {
  const db = openDb();
  importProducts(db, [
    { code: 'A-1', name: 'Kolo A', price: 10990, attrs: { N: 'N2' } },
    { code: 'B-2', name: 'Kolo B', price: 20990 },
  ], { now: T1 });
  return db;
}

test('C6 importProducts createMissing=false: neznámé kódy se nezakládají, jen spočítají', () => {
  const db = seed();
  const s = importProducts(
    db,
    [
      { code: 'A-1', attrs: { imprese_30: 1200 } },
      { code: 'NOVY-1', attrs: { imprese_30: 5 } },
      { code: 'b-2', attrs: { imprese_30: 800 } },
      { code: 'NOVY-2', name: 'Neznámý', price: 100 },
      { code: 'novy-1', attrs: { imprese_30: 6 } }, // duplicita neznámého kódu → počítá se jednou
    ],
    { now: T2, createMissing: false }
  );
  assert.equal(s.created, 0);
  assert.equal(s.updated, 2);
  assert.equal(s.skipped_unknown, 2);
  assert.deepEqual(s.unknown_codes, ['NOVY-1', 'NOVY-2']);
  assert.deepEqual(s.errors, []);
  assert.equal(db.prepare('SELECT count(*) AS c FROM products').get().c, 2);
  // metriky se doplnily do attrs, ostatní pole zůstala
  const a = product(db, 'A-1');
  assert.deepEqual(a.attrs, { N: 'N2', imprese_30: 1200 });
  assert.equal(a.name, 'Kolo A');
  assert.equal(a.price, 10990);
  // výchozí režim zakládá a nové statistiky nemá
  const d = importProducts(db, [{ code: 'NOVY-1', name: 'Nový' }], { now: T2 });
  assert.equal(d.created, 1);
  assert.equal(d.skipped_unknown, undefined);
});

test('C6: unknown_codes nejvýše 50, skipped_unknown celkový počet', () => {
  const db = seed();
  const recs = Array.from({ length: 60 }, (_, i) => ({ code: `X-${i}`, attrs: { imprese_30: i } }));
  const s = importProducts(db, recs, { now: T2, createMissing: false });
  assert.equal(s.skipped_unknown, 60);
  assert.equal(s.unknown_codes.length, 50);
  assert.equal(s.unknown_codes[0], 'X-0');
});

test('C6 runImport: options.create_missing=false, přímá volba createMissing i zkušební běh (CSV kód + imprese)', () => {
  const csv = 'kod;imprese_30\nA-1;1500\nNEZNAMY;42\nB-2;900\n';
  {
    const db = seed();
    const r = runImport(db, { kind: 'products', input: { text: csv, filename: 'metriky.csv' }, options: { create_missing: false }, now: T2 });
    assert.equal(r.stats.created, 0);
    assert.equal(r.stats.updated, 2);
    assert.equal(r.stats.skipped_unknown, 1);
    assert.deepEqual(r.stats.unknown_codes, ['NEZNAMY']);
    assert.equal(product(db, 'A-1').attrs.imprese_30, 1500);
    assert.equal(product(db, 'NEZNAMY'), null);
    const log = db.prepare('SELECT stats FROM imports WHERE id = ?').get(r.import_id);
    assert.equal(JSON.parse(log.stats).skipped_unknown, 1);
  }
  {
    const db = seed();
    const r = runImport(db, { kind: 'products', input: { text: csv, filename: 'metriky.csv' }, createMissing: false, now: T2 });
    assert.equal(r.stats.skipped_unknown, 1);
    assert.equal(product(db, 'NEZNAMY'), null);
    // přímá volba přebije options
    const r2 = runImport(db, { kind: 'products', input: { text: csv, filename: 'metriky.csv' }, options: { create_missing: true }, createMissing: false, now: T2 });
    assert.equal(r2.stats.created, 0);
  }
  {
    const db = seed();
    for (const v of ['0', 'false', 'ne', false, 0]) {
      const r = runImport(db, { kind: 'products', input: { text: csv, filename: 'metriky.csv' }, options: { createMissing: v }, dryRun: true, now: T2 });
      assert.equal(r.stats.skipped_unknown, 1, String(v));
      assert.equal(r.stats.created, 0, String(v));
    }
    assert.equal(product(db, 'NEZNAMY'), null, 'zkušební běh nic nezapsal');
    // chybějící / true = zakládat
    const r = runImport(db, { kind: 'products', input: { text: csv, filename: 'metriky.csv' }, options: {}, now: T2 });
    assert.equal(r.stats.created, 1);
  }
});

test('C3 import: pole group_code (kanonické, aliasy, normalizace, porovnání změn)', () => {
  const f = CANONICAL.products.find((x) => x.key === 'group_code');
  assert.ok(f);
  assert.equal(f.label, 'Skupina / model');
  const field = FIELDS.find((x) => x.key === 'group_code');
  assert.deepEqual({ ...field }, { ...field, key: 'group_code', label: 'Skupina / model', type: 'string', group: 'Produkt' });
  for (const h of ['group_code', 'model', 'model_code', 'nadrazeny_kod', 'Nadřazený kód', 'nadrazenykod', 'parent_code', 'parentcode', 'group_id', 'item_group_id', 'itemgroupid', 'g:item_group_id']) {
    const m = suggestMapping(['code', 'name', h], 'products');
    assert.equal(m.fields.group_code, h, h);
  }
  const v = applyMapping({ kod: 'A-1', model: ' FOC-JAM-2026 ' }, { fields: { code: 'kod', group_code: 'model' } }, 'products');
  assert.equal(v.value.group_code, 'FOC-JAM-2026');

  const db = seed();
  let s = importProducts(db, [{ code: 'A-1', group_code: 'FOC-JAM-2026' }, { code: 'C-3', name: 'Kolo C', group_code: 'FOC-JAM-2026' }], { now: T2 });
  assert.equal(s.updated, 1);
  assert.equal(s.created, 1);
  assert.equal(product(db, 'A-1').group_code, 'FOC-JAM-2026');
  assert.equal(product(db, 'C-3').group_code, 'FOC-JAM-2026');
  s = importProducts(db, [{ code: 'A-1', group_code: 'FOC-JAM-2026' }], { now: T2 });
  assert.equal(s.unchanged, 1);
  s = importProducts(db, [{ code: 'A-1', group_code: '' }], { now: T2 });
  assert.equal(s.updated, 1);
  assert.equal(product(db, 'A-1').group_code, null);
  // index pro skupiny existuje
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'products_group_code'").get());
});

test('C6 atributy: sloupec „Imprese 30“ zapíše do existujícího atributu imprese_30 (ne druhý souběžný atribut)', () => {
  const db = openDb();
  importProducts(db, [
    { code: 'A-1', name: 'Kolo A', attrs: { N: 'N2', imprese_30: 100, sezona: 2025 } },
    { code: 'B-2', name: 'Kolo B', attrs: { imprese_30: 50 } },
  ], { now: T1 });
  // Disivo export „Kód;Imprese 30;Sezóna“ přes mapování CSV (nenamapované sloupce → attrs)
  const csv = 'Kód;Imprese 30;Sezóna;Nový Sloupec\nA-1;4321;2026;x\nB-2;1234;;y\nNEZNAMY;5;;z\n';
  const res = runImport(db, { kind: 'products', input: { text: csv, filename: 'imprese.csv' }, createMissing: false, now: T2 });
  const s = res.stats;
  assert.deepEqual(s.attrs_merged, { 'Imprese 30': 'imprese_30', 'Sezóna': 'sezona' });
  assert.equal(s.updated, 2);
  assert.equal(s.skipped_unknown, 1);
  assert.deepEqual(product(db, 'A-1').attrs, { N: 'N2', imprese_30: 4321, sezona: 2026, 'Nový Sloupec': 'x' });
  // prázdná buňka = smazat atribut (i přes sloučený název)
  assert.deepEqual(product(db, 'B-2').attrs, { imprese_30: 1234, 'Nový Sloupec': 'y' });
  // nový atribut si drží zápis ze zdroje; další import jiným zápisem jde do něj
  const s2 = importProducts(db, [{ code: 'A-1', attrs: { nový_sloupec: 'q' } }], { now: T2 });
  assert.deepEqual(s2.attrs_merged, { nový_sloupec: 'Nový Sloupec' });
  assert.equal(product(db, 'A-1').attrs['Nový Sloupec'], 'q');
  // stejný zápis → nic se nehlásí
  const s3 = importProducts(db, [{ code: 'A-1', attrs: { imprese_30: 7 } }], { now: T2 });
  assert.equal(s3.attrs_merged, undefined);
});
