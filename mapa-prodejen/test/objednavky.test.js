'use strict';
// Testy zpracování exportu objednávek (lib/objednavky.js): rozpoznání sloupců, PSČ, částky, data, součty, ochrana
// osobních údajů při ukládání.
const test = require('node:test');
const assert = require('node:assert');
const o = require('../lib/objednavky.js');
const csv = require('../lib/csv.js');

test('rozpoznání sloupců – doručovací PSČ má přednost před fakturačním', () => {
  const rows = [['Export objednávek'], [], ['Číslo objednávky', 'Datum vytvoření', 'Fakturační PSČ', 'Dodací PSČ', 'Dodací město', 'Země', 'Cena bez DPH', 'Celkem s DPH', 'Stav']];
  const d = o.detectColumns(rows);
  assert.strictEqual(d.hlavicka, 2);
  assert.deepStrictEqual(d.sloupce, { psc: 3, mesto: 4, zeme: 5, datum: 1, castka: 7, stav: 8, id: 0 });
  const agg = o.detectColumns([['PSČ', 'Počet objednávek']]);
  assert.deepStrictEqual(agg.sloupce, { psc: 0, pocet: 1 });
  assert.strictEqual(o.detectColumns([['a', 'b']]).hlavicka, -1);
});

test('PSČ, země, částky a data', () => {
  assert.strictEqual(o.normPsc('602 00'), '60200');
  assert.strictEqual(o.normPsc(60200), '60200');
  assert.strictEqual(o.normPsc('CZ-11000'), '11000');
  assert.strictEqual(o.normPsc('811 01'), null); // Slovensko
  assert.strictEqual(o.normPsc('1100'), null);
  assert.ok(o.jeCesko(''));
  assert.ok(o.jeCesko('Česká republika'));
  assert.ok(o.jeCesko('CZ'));
  assert.ok(!o.jeCesko('Slovensko'));
  assert.strictEqual(o.normCastka('12 345,50 Kč'), 12345.5);
  assert.strictEqual(o.normCastka('1.234,5'), 1234.5);
  assert.strictEqual(o.normCastka('1,234.5'), 1234.5);
  assert.strictEqual(o.normCastka(99), 99);
  assert.strictEqual(o.normCastka('zdarma'), null);
  assert.strictEqual(o.normDatum('14.03.2025'), '2025-03-14');
  assert.strictEqual(o.normDatum('4. 3. 2025 10:22'), '2025-03-04');
  assert.strictEqual(o.normDatum('2025-03-14T10:00:00'), '2025-03-14');
  assert.strictEqual(o.normDatum(45730), '2025-03-14');
  assert.strictEqual(o.normDatum('včera'), null);
});

test('součty: export po položkách, storno a zahraničí po objednávkách, částka jednou za objednávku', () => {
  const text = [
    'Objednávka;Datum;PSČ;Město;Země;Celkem;Stav',
    '1;01.02.2025;602 00;Brno;CZ;1 000 Kč;Vyřízeno',
    '1;01.02.2025;602 00;Brno;CZ;1 000 Kč;Vyřízeno', // stejná objednávka, celková cena opakovaná
    '2;03.02.2025;602 00;Brno;CZ;500;Vyřízeno',
    '2;03.02.2025;602 00;Brno;CZ;300;Vyřízeno', // položky s vlastní cenou → sečíst
    '3;05.02.2025;110 00;Praha;CZ;200;Stornováno',
    '3;05.02.2025;110 00;Praha;CZ;200;Stornováno',
    '4;06.02.2025;811 01;Bratislava;SK;900;Vyřízeno',
    '5;07.02.2025;;Liberec;CZ;100;Vyřízeno',
    '6;08.02.2025;;;CZ;100;Vyřízeno',
  ].join('\n');
  const rows = csv.parse(text);
  const d = o.detectColumns(rows);
  const s = o.secti(rows, d.sloupce, { odRadku: d.hlavicka + 1 });
  assert.strictEqual(s.objednavek, 3);
  assert.deepStrictEqual(s.psc['60200'], { n: 2, kc: 1800 });
  assert.strictEqual(s.storno, 1);
  assert.strictEqual(s.zahranici, 1);
  assert.strictEqual(s.bezAdresy, 1);
  assert.deepStrictEqual(s.mesta.liberec, { n: 1, kc: 100, nazev: 'Liberec' });
  assert.strictEqual(s.od, '2025-02-01');
  assert.strictEqual(s.do, '2025-02-07');
  const pscData = { 60200: [49.2, 16.6, 3702, 'Brno', 582786], 46001: [50.77, 15.05, 3505, 'Liberec', 563889] };
  const prir = o.priradit(s, pscData, new Map([['liberec', '46001']]));
  assert.deepStrictEqual(prir.psc, { 60200: { n: 2, kc: 1800 }, 46001: { n: 1, kc: 100 } });
  const ds = o.dataset(prir, s, { soubor: 'export.csv', kdo: 'lada' });
  assert.strictEqual(ds.objednavek, 3);
  assert.strictEqual(ds.nezarazeno, 1);
  assert.deepStrictEqual(ds.mista[0], { psc: '60200', n: 2, kc: 1800 });
});

test('hotový přehled PSČ; počet', () => {
  const rows = csv.parse('PSČ;Počet objednávek\n602 00;12\n110 00;30\n999 99;1\n');
  const d = o.detectColumns(rows);
  const s = o.secti(rows, d.sloupce, { odRadku: 1 });
  assert.ok(s.sectene);
  assert.strictEqual(s.objednavek, 42);
  assert.deepStrictEqual(s.psc['11000'], { n: 30, kc: 0 });
  assert.strictEqual(s.zahranici, 1); // 999 99 = slovenské PSČ
});

test('validace datasetu pro server – jen PSČ, počet, částka', () => {
  const ok = o.validovat({ mista: [{ psc: '60200', n: 3, kc: 1000 }, { psc: '60200', n: 9 }, { psc: '81101', n: 1 }, { psc: '11000', n: 0 }], od: '2025-01-01', do: 'x', nezarazeno: -5 });
  assert.deepStrictEqual(ok.data.mista, [{ psc: '60200', n: 3, kc: 1000 }]);
  assert.strictEqual(ok.data.objednavek, 3);
  assert.strictEqual(ok.data.do, null);
  assert.strictEqual(ok.data.nezarazeno, 0);
  assert.match(o.validovat({ mista: [{ psc: '60200', n: 1, jmeno: 'Jan' }] }).chyba, /osobní údaje/);
  assert.ok(o.validovat({}).chyba);
  assert.ok(o.validovat({ mista: new Array(20001).fill({ psc: '60200', n: 1 }) }).chyba);
});
