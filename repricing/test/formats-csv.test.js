'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseCsv, toCsv, detectDelimiter, normalizeHeaders } = require('../src/formats/csv.js');
const { encodeWindows1250 } = require('../src/formats/decode.js');

test('CZ Excel: středník, desetinná čárka, víceřádková buňka, cp1250 bajty', () => {
  const text =
    'Kód;Název;Nákupní cena;Cena s DPH;Poznámka\r\n' +
    'KOLO-001;Horské kolo Žluťoučký kůň;8 264,46;12 990,00;"Víceřádková\r\npoznámka; se středníkem"\r\n' +
    'KOLO-002;"Kolo ""Ďábel"" XL";45000;69 990,50;\r\n';
  const buf = encodeWindows1250(text);
  const { headers, rows, delimiter } = parseCsv(buf);
  assert.strictEqual(delimiter, ';');
  assert.deepStrictEqual(headers, ['Kód', 'Název', 'Nákupní cena', 'Cena s DPH', 'Poznámka']);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0], {
    Kód: 'KOLO-001',
    Název: 'Horské kolo Žluťoučký kůň',
    'Nákupní cena': '8 264,46',
    'Cena s DPH': '12 990,00',
    Poznámka: 'Víceřádková\r\npoznámka; se středníkem',
  });
  assert.strictEqual(rows[1].Název, 'Kolo "Ďábel" XL');
  assert.strictEqual(rows[1].Poznámka, '');
  // explicitní kódování
  assert.strictEqual(parseCsv(buf, { encoding: 'windows-1250' }).rows[0].Název, 'Horské kolo Žluťoučký kůň');
});

test('čárkové CSV s desetinnou tečkou a uvozovkami', () => {
  const { headers, rows, delimiter } = parseCsv('code,name,price\nA1,"Kolo, horské",12990.50\nA2,Helma,1290\n');
  assert.strictEqual(delimiter, ',');
  assert.deepStrictEqual(headers, ['code', 'name', 'price']);
  assert.deepStrictEqual(rows, [
    { code: 'A1', name: 'Kolo, horské', price: '12990.50' },
    { code: 'A2', name: 'Helma', price: '1290' },
  ]);
});

test('TSV a svislítko', () => {
  assert.deepStrictEqual(parseCsv('a\tb\tc\n1\t2,5\t3\n').rows, [{ a: '1', b: '2,5', c: '3' }]);
  assert.strictEqual(parseCsv('a\tb\n1\t2\n').delimiter, '\t');
  assert.deepStrictEqual(parseCsv('a|b\n1|2\n').rows, [{ a: '1', b: '2' }]);
  assert.deepStrictEqual(parseCsv('a;b\n1;2\n', { delimiter: 'tab' }).headers, ['a;b']);
});

test('autodetekce: středník vs. desetinné čárky v datech', () => {
  // čárka by dala nekonzistentní počet polí (hlavička 1, řádky 2–3)
  assert.strictEqual(detectDelimiter('kod;nazev;cena\nA;Kolo;12990,50\nB;Helma, černá;1290,00\n'), ';');
  // v hlavičce čárka, ale středníků je víc a konzistentně
  assert.strictEqual(detectDelimiter('kod;nazev, popis;cena\nA;Kolo;12990,5\n'), ';');
  assert.strictEqual(detectDelimiter('a,b,c\n1,"x;y",3\n'), ',');
  assert.strictEqual(detectDelimiter('jediny_sloupec\n1\n2\n'), ';');
  // koncové prázdné buňky (Excel „;;;“) konzistenci nerozbijí
  assert.strictEqual(detectDelimiter('a;b;c\n1;2;3;;;\n4;5;6\n'), ';');
});

test('hlavička na 3. řádku, řádky před ní se přeskočí', () => {
  const csv = 'Ceník konkurence;;\nvygenerováno 25.9.2026;;\nKód;Cena;Konkurent\nA1;100;Kola.cz\nA2;200;Bike.cz\n';
  const { headers, rows } = parseCsv(csv, { headerRow: 3 });
  assert.deepStrictEqual(headers, ['Kód', 'Cena', 'Konkurent']);
  assert.deepStrictEqual(rows[1], { Kód: 'A2', Cena: '200', Konkurent: 'Bike.cz' });
  // header_row (snake_case z mapování) a CRLF / CR konce řádků
  assert.deepStrictEqual(parseCsv('x\r\ny\rKód;Cena\r\nA;1', { header_row: 3 }).rows, [{ Kód: 'A', Cena: '1' }]);
  // prázdný řádek na místě hlavičky → hlavičkou je první neprázdný řádek za ním
  assert.deepStrictEqual(parseCsv('titulek\n\n\na;b\n1;2\n', { headerRow: 2 }).headers, ['a', 'b']);
});

test('duplicitní a prázdné hlavičky, bílé znaky a BOM v hlavičce', () => {
  const { headers, rows } = parseCsv('﻿ Kód ;Cena;;Cena;Cena;"Cena\ns DPH"\nA;1;x;2;3;4\n');
  assert.deepStrictEqual(headers, ['Kód', 'Cena', 'col_3', 'Cena_2', 'Cena_3', 'Cena s DPH']);
  assert.deepStrictEqual(rows[0], { Kód: 'A', Cena: '1', col_3: 'x', Cena_2: '2', Cena_3: '3', 'Cena s DPH': '4' });
  assert.deepStrictEqual(normalizeHeaders(['a', 'a', 'a_2', '', null, 5]), ['a', 'a_2', 'a_2_2', 'col_4', 'col_5', '5']);
});

test('prázdné řádky a koncové prázdné řádky', () => {
  const csv = 'a;b\n1;2\n\n;\n3;4\n\n\n\n';
  assert.deepStrictEqual(parseCsv(csv).rows, [
    { a: '1', b: '2' },
    { a: '3', b: '4' },
  ]);
  const keep = parseCsv(csv, { skipEmpty: false }).rows;
  assert.deepStrictEqual(keep, [
    { a: '1', b: '2' },
    { a: '', b: '' },
    { a: '', b: '' },
    { a: '3', b: '4' },
  ]);
});

test('kratší a delší řádky: chybějící buňky "" , neprázdné navíc → col_N ve všech řádcích', () => {
  const { headers, rows } = parseCsv('a;b;c\n1\n2;3;4;;navíc\n5;6;7;\n');
  assert.deepStrictEqual(headers, ['a', 'b', 'c', 'col_4', 'col_5']);
  assert.deepStrictEqual(rows[0], { a: '1', b: '', c: '', col_4: '', col_5: '' });
  assert.deepStrictEqual(rows[1], { a: '2', b: '3', c: '4', col_4: '', col_5: 'navíc' });
  assert.deepStrictEqual(rows[2], { a: '5', b: '6', c: '7', col_4: '', col_5: '' });
});

test('uvozovky: "" uvnitř, znaky za uzavírací uvozovkou, neukončené uvozovky', () => {
  assert.deepStrictEqual(parseCsv('a;b\n"x""y";"z"w\n').rows, [{ a: 'x"y', b: 'zw' }]);
  // neukončená uvozovka se bere doslova – data se neztratí
  assert.deepStrictEqual(parseCsv('a;b\n"26 kolo;x\n3;4\n').rows, [
    { a: '"26 kolo', b: 'x' },
    { a: '3', b: '4' },
  ]);
  // uvozovka uprostřed pole je literál
  assert.deepStrictEqual(parseCsv('a;b\nkolo 26";x\n').rows, [{ a: 'kolo 26"', b: 'x' }]);
  // oddělovač na konci souboru bez nového řádku
  assert.deepStrictEqual(parseCsv('a;b\n1;').rows, [{ a: '1', b: '' }]);
});

test('Excel řádek „sep=;“ určuje oddělovač a přeskočí se', () => {
  const r = parseCsv('sep=,\r\na;b,c\r\n1;2,3\r\n');
  assert.strictEqual(r.delimiter, ',');
  assert.deepStrictEqual(r.rows, [{ 'a;b': '1;2', c: '3' }]);
  assert.deepStrictEqual(parseCsv('\uFEFFsep=;\ntitulek\nx;y\n1;2', { headerRow: 2 }).rows, [{ x: '1', y: '2' }]);
});

test('prázdný vstup, jen hlavička, hlavička __proto__', () => {
  assert.deepStrictEqual(parseCsv(''), { headers: [], rows: [], delimiter: ';' });
  assert.deepStrictEqual(parseCsv('a;b\r\n').rows, []);
  const { rows } = parseCsv('__proto__;b\nx;1\n');
  assert.strictEqual(Object.getOwnPropertyDescriptor(rows[0], '__proto__').value, 'x');
  assert.strictEqual(Object.getPrototypeOf(rows[0]), Object.prototype);
});

test('toCsv: CZ Excel formát (BOM, středník, desetinná čárka, CRLF, uvozovky)', () => {
  const rows = [
    { code: 'A1', name: 'Kolo "Trek"; horské', price: 12990.5, pct: -3.25, ok: true, at: new Date('2026-09-25T10:00:00Z'), n: null },
    { code: '00123', name: ' mezera', price: 1e21, pct: 0.0000001, ok: false, at: undefined, n: { a: 1 } },
  ];
  const cols = [
    { key: 'code', label: 'Kód' },
    { key: 'name', label: 'Název' },
    { key: 'price', label: 'Cena' },
    { key: 'pct', label: 'Změna %' },
    { key: 'ok' },
    { key: 'at' },
    { key: 'n' },
  ];
  const out = toCsv(rows, cols);
  assert.strictEqual(
    out,
    '﻿Kód;Název;Cena;Změna %;ok;at;n\r\n' +
      'A1;"Kolo ""Trek""; horské";12990,5;-3,25;1;2026-09-25T10:00:00.000Z;\r\n' +
      '00123;" mezera";1000000000000000000000;0,0000001;0;;"{""a"":1}"\r\n'
  );
  const en = toCsv([{ a: 1.5, b: 'x,y' }], [{ key: 'a' }, { key: 'b' }], { delimiter: ',', decimal: '.', bom: false });
  assert.strictEqual(en, 'a,b\r\n1.5,"x,y"\r\n');
  // výchozí sloupce = klíče řádků
  assert.strictEqual(toCsv([{ x: 1 }, { y: 2 }], null, { bom: false }), 'x;y\r\n1;\r\n;2\r\n');
  assert.strictEqual(toCsv([], [{ key: 'a', label: 'A' }], { bom: false }), 'A\r\n');
});

test('toCsv → parseCsv roundtrip', () => {
  const rows = [
    { code: 'A;1', name: 'Víceřádkový\r\ntext "s uvozovkami"', price: '12 990,50' },
    { code: 'B', name: '', price: '1' },
  ];
  const cols = [{ key: 'code' }, { key: 'name' }, { key: 'price' }];
  assert.deepStrictEqual(parseCsv(toCsv(rows, cols)).rows, rows);
  assert.deepStrictEqual(parseCsv(toCsv(rows, cols, { delimiter: '\t' })).rows, rows);
});

test('výkon: 200 000 řádků', () => {
  const lines = ['kod;ean;konkurent;cena;skladem'];
  for (let i = 0; i < 200000; i++) lines.push(`K${i};859${String(i).padStart(10, '0')};Kola ${i % 8}.cz;${1000 + (i % 5000)},50;1`);
  const text = lines.join('\r\n');
  const t0 = Date.now();
  const { rows } = parseCsv(text);
  const ms = Date.now() - t0;
  assert.strictEqual(rows.length, 200000);
  assert.strictEqual(rows[199999].kod, 'K199999');
  assert.ok(ms < 5000, `parseCsv trval ${ms} ms`);
});
