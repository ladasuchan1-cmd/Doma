'use strict';
// tools/import-sales.js – opakovaný import nic nezdvojí (soubor i DB), osobní údaje se nezapíšou, srozumitelné chyby.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { writeXlsx } = require('../src/formats/xlsx');
const { storeSales, readExport, main } = require('../tools/import-sales');

/** Sešit ve tvaru exportu POHODY „Pohyby skladu“ (jen sloupce, které import čte, + osobní údaje). */
function pohodaXlsx(rows) {
  const keys = ['Agenda', 'Členění', 'Kód', 'Název', 'Datum', 'Pohyb', 'Množství', 'Částka', 'Vážená', 'Firma', 'Jméno', 'Výrobce'];
  return writeXlsx([{ name: 'Pohyby', columns: keys.map((key) => ({ key })), rows }]);
}
const row = (o) => ({
  Agenda: 'Prodejky',
  'Členění': 'sPRAHA/Nezařazeno',
  'Kód': 'B1',
  Datum: '2026-03-01',
  Pohyb: 'Výdej',
  'Množství': 1,
  'Vážená': 9000,
  Firma: 'Novák Cyklo s.r.o.',
  'Jméno': 'Jan Novák',
  'Výrobce': 'Giant',
  ...o,
});

function quiet(fn) {
  const out = [];
  const keep = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...a) => out.push(a.join(' '));
  try {
    return { result: fn(), out: out.join('\n') };
  } finally {
    [console.log, console.warn, console.error] = keep;
  }
}

test('import: dvakrát totéž (i překrývající se exporty) → nic se nezdvojí; jména a firmy se nezapíšou', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolomapa-import-'));
  try {
    const a = path.join(dir, 'leden až březen.xlsx'); // mezera i diakritika v cestě
    const b = path.join(dir, 'brezen-duben.xlsx');
    fs.writeFileSync(
      a,
      pohodaXlsx([
        row({ 'Název': 'Giant TCR silniční kolo @vel. M BAZAR', 'Částka': 16000 }),
        row({ 'Kód': 'P1', 'Název': 'Haibike Nduro 7 elektrokolo - Prověřeno@vel. L', 'Částka': 57842.98, Datum: '2026-03-02' }),
        row({ 'Kód': 'H1', 'Název': 'Leki hole BAZAR', 'Částka': 500 }),
      ])
    );
    fs.writeFileSync(
      b,
      pohodaXlsx([
        row({ 'Název': 'Giant TCR silniční kolo @vel. M BAZAR', 'Částka': 16000 }), // stejný prodej znovu
        row({ 'Kód': 'B2', 'Název': 'Author Spirit horské kolo BAZAR', 'Částka': 8000, Datum: '2026-04-10' }),
      ])
    );
    const trainingFile = path.join(dir, 'prodeje.json');
    const dbFile = path.join(dir, 'kolomapa.db');
    const opts = { trainingFile, dbFile };
    const r1 = quiet(() => main([a], opts));
    assert.equal(r1.result, 0, r1.out);
    assert.match(r1.out, /2 prodejů kol \(nových v training\/: 2, v DB: 2\); vyřazeno 1 nekol/);
    const after1 = fs.readFileSync(trainingFile, 'utf8');
    const r2 = quiet(() => main([a], opts));
    assert.equal(r2.result, 0);
    assert.match(r2.out, /nových v training\/: 0, v DB: 0/);
    assert.match(r2.out, /Nic nového/);
    assert.equal(fs.readFileSync(trainingFile, 'utf8'), after1, 'opakovaný import soubor nemění');
    const r3 = quiet(() => main([b, a], opts));
    assert.equal(r3.result, 0);
    const saved = JSON.parse(fs.readFileSync(trainingFile, 'utf8')).sales;
    assert.deepEqual(saved.map((s) => s.code), ['B1', 'P1', 'B2']);
    assert.equal(saved.find((s) => s.code === 'P1').priceCzk, 69990); // PROVĚŘENO = bez DPH × 1,21
    const db = openDb(dbFile);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 3);
    } finally {
      db.close();
    }
    const all = fs.readFileSync(trainingFile, 'utf8');
    for (const pii of ['Novák', 'Jan', 's.r.o.']) assert.ok(!all.includes(pii), `osobní údaj „${pii}“ v trénovacích datech`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('storeSales: prodej bez kódu / data se při opakovaném importu nezdvojí (NULL v UNIQUE)', () => {
  const db = openDb(':memory:');
  try {
    const sales = [
      { code: '', date: null, kind: 'bazar', title: 'Kolo bez karty', priceCzk: 5000, costCzk: 3000 },
      { code: 'K1', date: '2026-01-01', kind: 'bazar', title: 'Kolo', priceCzk: 7000, costCzk: 4000 },
    ];
    assert.equal(storeSales(db, sales), 2);
    assert.equal(storeSales(db, sales), 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 2);
  } finally {
    db.close();
  }
});

test('readExport: chybí soubor, starý .xls, CSV, poškozený soubor → česká rada; nic se nezapíše', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolomapa-import-'));
  try {
    assert.throws(() => readExport(path.join(dir, 'neni.xlsx')), /neexistuje – zkontrolujte cestu/);
    const xls = path.join(dir, 'stary.xls');
    fs.writeFileSync(xls, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]));
    assert.throws(() => readExport(xls), /starý formát Excelu \(\.xls\).*Sešit Excelu/);
    const csv = path.join(dir, 'export.csv');
    fs.writeFileSync(csv, 'Název;Částka\n');
    assert.throws(() => readExport(csv), /není sešit Excelu/);
    const broken = path.join(dir, 'rozbity.xlsx');
    fs.writeFileSync(broken, 'nic');
    assert.throws(() => readExport(broken), /nejde přečíst jako sešit Excelu/);
    assert.throws(() => readExport(dir), /je složka/);
    // chyba v jednom ze souborů → import nezačne (žádný soubor trénovacích dat ani DB)
    const ok = path.join(dir, 'ok.xlsx');
    fs.writeFileSync(ok, pohodaXlsx([row({ 'Název': 'Giant TCR silniční kolo BAZAR', 'Částka': 16000 })]));
    const trainingFile = path.join(dir, 'prodeje.json');
    assert.throws(() => quiet(() => main([ok, xls], { trainingFile, dbFile: path.join(dir, 'k.db') })), /starý formát/);
    assert.ok(!fs.existsSync(trainingFile));
    assert.ok(!fs.existsSync(path.join(dir, 'k.db')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main: --help, neznámý přepínač, export bez prodejů kol → varování', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolomapa-import-'));
  try {
    const help = quiet(() => main(['--help']));
    assert.equal(help.result, 0);
    assert.match(help.out, /Použití: npm run import-sales/);
    const bad = quiet(() => main(['--sead']));
    assert.equal(bad.result, 1);
    assert.match(bad.out, /Neznámý přepínač: --sead/);
    const empty = path.join(dir, 'jine.xlsx');
    fs.writeFileSync(empty, pohodaXlsx([row({ 'Název': 'Cyklopočítač Garmin BAZAR', 'Částka': 3000 })]));
    const r = quiet(() => main([empty], { trainingFile: path.join(dir, 'p.json'), dbFile: path.join(dir, 'k.db') }));
    assert.equal(r.result, 0);
    assert.match(r.out, /Pozor: v „jine.xlsx“ není žádný prodej kola/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('poškozený training/koloshop-prodeje.json (konflikt po git pull) → chyba, dosavadní prodeje se nepřepíšou', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolomapa-import-'));
  try {
    const xlsx = path.join(dir, 'export.xlsx');
    fs.writeFileSync(xlsx, pohodaXlsx([row({ 'Název': 'Giant TCR silniční kolo BAZAR', 'Částka': 16000 })]));
    const trainingFile = path.join(dir, 'prodeje.json');
    const broken = '{\n <<<<<<< HEAD\n "sales": []\n=======\n "sales": [{"code": "X"}]\n>>>>>>> main\n}\n';
    fs.writeFileSync(trainingFile, broken);
    assert.throws(() => quiet(() => main([xlsx], { trainingFile, dbFile: path.join(dir, 'k.db') })), /prodeje\.json je poškozený.*nic jsem nepřepsal/);
    assert.equal(fs.readFileSync(trainingFile, 'utf8'), broken);
    fs.writeFileSync(trainingFile, '{"sales": {"a": 1}}');
    assert.throws(() => quiet(() => main([xlsx], { trainingFile, dbFile: path.join(dir, 'k.db') })), /nemá očekávaný tvar/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
