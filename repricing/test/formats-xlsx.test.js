'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readXlsx, writeXlsx, serialToIso, classifyFormat, colName, colIndex } = require('../src/formats/xlsx.js');
const { readZip, writeZip } = require('../src/formats/zip.js');
const { parseXml } = require('../src/formats/xml.js');
const { parseCsv } = require('../src/formats/csv.js');

// Fixtures vytvořené LibreOffice 24.2 (soubory třetí strany – sdílené řetězce, styly, čísla, vzorce):
//   soffice --headless --infilter='CSV:59,34,76,1,,1029,false,true' --convert-to xlsx libreoffice-cz.csv
//   soffice --headless --convert-to xlsx libreoffice-rich.fods   (skrytý list, vzorce, formátovaný text, datum, hlavička na ř. 3)
const FIXTURES = path.join(__dirname, 'fixtures', 'formats');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

const PROPOSALS = {
  name: 'Návrhy',
  columns: [
    { key: 'code', label: 'Kód', type: 'string' },
    { key: 'name', label: 'Název' },
    { key: 'old', label: 'Stará cena', type: 'money' },
    { key: 'new', label: 'Nová cena', type: 'money', width: 14 },
    { key: 'pct', label: 'Změna %', type: 'percent' },
    { key: 'margin', label: 'Marže', type: 'number', format: '0.00' },
    { key: 'at', label: 'Vytvořeno', type: 'date' },
    { key: 'day', label: 'Den', type: 'date' },
    { key: 'ok', label: 'Auto' },
    { key: 'flags', label: 'Příznaky' },
  ],
  rows: [
    {
      code: '00123',
      name: 'Kolo „Žluťoučký kůň“ & <spol>\nřádek 2',
      old: 12990,
      new: 12490.5,
      pct: -3.85,
      margin: 18.254,
      at: '2026-09-25T10:30:00Z',
      day: '2026-09-25',
      ok: true,
      flags: ['floor', 'big_change'],
    },
    { code: 'KOLO-2', name: '_x0041_ doslova', old: '1290', new: null, pct: 'n/a', margin: undefined, at: new Date('2026-01-15T00:00:00+01:00'), day: 'neplatné', ok: false },
    { code: 'KOLO-3', name: '', old: Number.NaN, new: 0, pct: 0 },
  ],
};

test('writeXlsx → readXlsx roundtrip (typy, datumy, texty, boolean)', () => {
  const buf = writeXlsx([PROPOSALS, { name: 'Souhrn', rows: [{ stav: 'pending', počet: 3 }] }], { date: new Date('2026-09-25T12:00:00Z') });
  const r = readXlsx(buf);
  assert.deepStrictEqual(r.sheets, ['Návrhy', 'Souhrn']);
  assert.strictEqual(r.sheet, 'Návrhy');
  assert.deepStrictEqual(r.headers, ['Kód', 'Název', 'Stará cena', 'Nová cena', 'Změna %', 'Marže', 'Vytvořeno', 'Den', 'Auto', 'Příznaky']);
  assert.strictEqual(r.rows.length, 3);
  assert.deepStrictEqual(r.rows[0], {
    Kód: '00123', // text zůstane textem (úvodní nuly)
    Název: 'Kolo „Žluťoučký kůň“ & <spol>\nřádek 2',
    'Stará cena': 12990,
    'Nová cena': 12490.5,
    'Změna %': -3.85,
    Marže: 18.254,
    Vytvořeno: '2026-09-25T12:30:00', // UTC → místní čas Europe/Prague (Excel časové zóny nezná)
    Den: '2026-09-25',
    Auto: true,
    Příznaky: '["floor","big_change"]',
  });
  assert.strictEqual(r.rows[1].Název, '_x0041_ doslova');
  assert.strictEqual(r.rows[1]['Stará cena'], 1290); // číselný řetězec v peněžním sloupci → číslo
  assert.strictEqual(r.rows[1]['Nová cena'], '');
  assert.strictEqual(r.rows[1]['Změna %'], 'n/a');
  assert.strictEqual(r.rows[1].Vytvořeno, '2026-01-15');
  assert.strictEqual(r.rows[1].Den, 'neplatné');
  assert.strictEqual(r.rows[1].Auto, false);
  assert.strictEqual(r.rows[2]['Stará cena'], ''); // NaN → prázdná buňka
  assert.strictEqual(r.rows[2]['Nová cena'], 0);
  const s2 = readXlsx(buf, { sheet: 'souhrn' });
  assert.deepStrictEqual(s2.rows, [{ stav: 'pending', počet: 3 }]);
  assert.deepStrictEqual(readXlsx(buf, { sheet: 1 }).rows, s2.rows);
  assert.deepStrictEqual(readXlsx(buf, { sheet: '1' }).rows, s2.rows);
  assert.throws(() => readXlsx(buf, { sheet: 'Neexistuje' }), (e) => e.code === 'XLSX_SHEET_NOT_FOUND' && /Návrhy, Souhrn/.test(e.message));
});

test('writeXlsx: struktura – tučná ukotvená hlavička, autofiltr, formáty, šířky, názvy listů', () => {
  const buf = writeXlsx([PROPOSALS, { name: 'Příliš dlouhý název listu: [test] */?\\ konec', rows: [] }, { name: 'návrhy', rows: [] }, { name: '', rows: [] }]);
  const zip = readZip(buf);
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/sharedStrings.xml', 'docProps/core.xml', 'docProps/app.xml']) {
    assert.ok(zip.has(part), part);
    parseXml(zip.get(part)()); // každá část je platné XML
  }
  const wb = parseXml(zip.get('xl/workbook.xml')());
  const names = wb.children.find((c) => c.name === 'sheets').children.map((s) => s.attrs.name);
  assert.deepStrictEqual(names, ['Návrhy', 'Příliš dlouhý název listu_ _tes', 'návrhy (2)', 'List4']);
  assert.ok(names.every((n) => n.length <= 31));
  const defined = wb.children.find((c) => c.name === 'definedNames').children[0];
  assert.strictEqual(defined.attrs.name, '_xlnm._FilterDatabase');
  assert.strictEqual(defined.text, "'Návrhy'!$A$1:$J$4");

  const sheetXml = zip.get('xl/worksheets/sheet1.xml')().toString();
  const sheet = parseXml(sheetXml);
  const pane = sheet.children.find((c) => c.name === 'sheetViews').children[0].children.find((c) => c.name === 'pane');
  assert.deepStrictEqual(pane.attrs, { ySplit: '1', topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' });
  assert.strictEqual(sheet.children.find((c) => c.name === 'autoFilter').attrs.ref, 'A1:J4');
  assert.strictEqual(sheet.children.find((c) => c.name === 'dimension').attrs.ref, 'A1:J4');
  const cols = sheet.children.find((c) => c.name === 'cols').children;
  assert.strictEqual(cols.length, 10);
  assert.strictEqual(cols[3].attrs.width, '14'); // explicitní šířka
  assert.ok(Number(cols[1].attrs.width) > 20, 'šířka podle obsahu');

  const styles = parseXml(zip.get('xl/styles.xml')());
  const fmts = styles.children.find((c) => c.name === 'numFmts').children.map((f) => f.attrs.formatCode);
  assert.ok(fmts.includes('0.0" %"'));
  const xfs = styles.children.find((c) => c.name === 'cellXfs').children;
  const row1 = sheet.children.find((c) => c.name === 'sheetData').children[0];
  const headerXf = xfs[Number(row1.children[0].attrs.s)];
  assert.strictEqual(headerXf.attrs.fontId, '1'); // tučné písmo
  const fonts = styles.children.find((c) => c.name === 'fonts').children;
  assert.ok(fonts[1].children.some((c) => c.name === 'b'));
  const row2 = sheet.children.find((c) => c.name === 'sheetData').children[1];
  const xfOf = (ref) => xfs[Number(row2.children.find((c) => c.attrs.r === ref).attrs.s || 0)];
  assert.strictEqual(xfOf('C2').attrs.numFmtId, '3'); // #,##0
  const pctId = xfOf('E2').attrs.numFmtId;
  assert.strictEqual(styles.children.find((c) => c.name === 'numFmts').children.find((f) => f.attrs.numFmtId === pctId).attrs.formatCode, '0.0" %"');
  assert.strictEqual(xfOf('F2').attrs.numFmtId, '2'); // vlastní formát 0.00 = vestavěný 2
  assert.strictEqual(xfOf('G2').attrs.numFmtId, '22'); // datum a čas
  assert.strictEqual(xfOf('H2').attrs.numFmtId, '14'); // datum
});

test('writeXlsx: bez definice sloupců, prázdný list, neplatné XML znaky a dlouhý text', () => {
  const long = 'x'.repeat(40000);
  const buf = writeXlsx({ name: 'Data', rows: [{ a: 1, b: 'ok\u0001\u0008' }, { a: 2, c: long }] });
  const r = readXlsx(buf);
  assert.deepStrictEqual(r.headers, ['a', 'b', 'c']);
  assert.strictEqual(r.rows[0].b, 'ok');
  assert.strictEqual(r.rows[1].c.length, 32767); // limit buňky Excelu
  const empty = readXlsx(writeXlsx([{ name: 'Prázdný', columns: [{ key: 'a', label: 'A' }], rows: [] }]));
  assert.deepStrictEqual(empty, { sheets: ['Prázdný'], sheet: 'Prázdný', headers: ['A'], rows: [] });
  assert.deepStrictEqual(readXlsx(writeXlsx([])).headers, []);
});

test('readXlsx: soubor z LibreOffice (CSV → XLSX)', () => {
  const r = readXlsx(fixture('libreoffice-cz.xlsx'));
  assert.deepStrictEqual(r.sheets, ['libreoffice-cz']);
  assert.deepStrictEqual(r.headers, ['Kód', 'Název', 'Výrobce', 'Nákupní cena', 'Cena s DPH', 'Marže %', 'Skladem', 'Datum', 'EAN', 'Poznámka']);
  assert.strictEqual(r.rows.length, 3);
  assert.deepStrictEqual(r.rows[0], {
    Kód: 'KOLO-001',
    Název: 'Horské kolo Žluťoučký kůň',
    Výrobce: 'Specialized',
    'Nákupní cena': 8264.46,
    'Cena s DPH': 12990,
    'Marže %': 0.225, // procentní formát v Excelu = podíl
    Skladem: 5,
    Datum: '2026-09-25', // styl mm/dd/yy → ISO
    EAN: 8590000000017,
    Poznámka: 'Víceřádková\npoznámka',
  });
  assert.strictEqual(r.rows[1]['Cena s DPH'], 69990.5);
  assert.strictEqual(r.rows[1].Datum, '2026-01-01');
  assert.strictEqual(r.rows[1].Poznámka, '');
  assert.strictEqual(r.rows[2].Název, 'Kolo "Úpěl" & spol. <b>');
  assert.strictEqual(r.rows[2]['Nákupní cena'], '');
  assert.strictEqual(r.rows[2].Datum, '2025-12-31T14:30:00'); // datum a čas
  assert.strictEqual(r.rows[2].Poznámka, 'ŠČŘŽÝÁÍÉ ěščřžýáíé');
  // stejná data jako zdrojové CSV
  const csv = parseCsv(fixture('libreoffice-cz.csv'));
  assert.deepStrictEqual(csv.headers, r.headers);
  assert.strictEqual(csv.rows[2].Poznámka, r.rows[2].Poznámka);
});

test('readXlsx: soubor z LibreOffice (skrytý list, vzorce, formátovaný text, hlavička na 3. řádku)', () => {
  const buf = fixture('libreoffice-rich.xlsx');
  const r = readXlsx(buf, { headerRow: 3 });
  assert.deepStrictEqual(r.sheets, ['Pomocný', 'Ceník']);
  assert.strictEqual(r.sheet, 'Ceník'); // první viditelný list
  assert.deepStrictEqual(r.headers, ['Kód', 'Název', 'col_3', 'Cena', 'Cena_2', 'Skladem', 'Datum', 'Chyba', 'col_9']);
  assert.deepStrictEqual(r.rows[0], {
    Kód: 'KOLO-001',
    Název: 'Kolo Žluťoučký kůň', // rich text – běhy spojené
    col_3: '',
    Cena: 12990.5, // formát #,##0.00 "Kč" není datum
    Cena_2: 25981, // vzorec =D4*2 → uložená hodnota
    Skladem: 1,
    Datum: '2026-09-25', // vlastní formát d.m.yyyy
    Chyba: '#DIV/0!', // chyba vzorce jako text
    col_9: '', // sloupec přibyl až na dalším řádku – doplněn i sem
  });
  assert.strictEqual(r.rows[1].Název, 'Silniční kolo'); // t="str" (textový výsledek vzorce)
  assert.strictEqual(r.rows[1].Cena_2, 0.3); // 0.1 + 0.2 bez šumu
  assert.strictEqual(r.rows[1].col_9, 'navíc');
  assert.strictEqual(r.rows.length, 3); // prázdný řádek 6 přeskočen
  assert.strictEqual(r.rows[2].Kód, 'KOLO-003');
  assert.strictEqual(r.rows[2].Cena, 100);
  // bez headerRow je hlavičkou první neprázdný řádek (titulek)
  const t = readXlsx(buf);
  assert.strictEqual(t.headers[0], 'Ceník konkurence – export 2026');
  // skrytý list lze vybrat explicitně
  assert.deepStrictEqual(readXlsx(buf, { sheet: 'Pomocný' }).headers, ['skrytý list']);
});

test('readXlsx: inline řetězce, chybějící odkazy buněk, sdílené řetězce s rPh, 1904, prefixy x:', () => {
  const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>
<x:row><x:c t="inlineStr"><x:is><x:t>Kód</x:t></x:is></x:c><x:c t="inlineStr"><x:is><x:r><x:t xml:space="preserve">Cena </x:t></x:r><x:r><x:t>s DPH</x:t></x:r></x:is></x:c><x:c t="s"><x:v>0</x:v></x:c><x:c t="inlineStr"><x:is><x:t>Datum</x:t></x:is></x:c></x:row>
<x:row><x:c><x:v>1</x:v></x:c><x:c><x:v>12990.000000000002</x:v></x:c><x:c t="b"><x:v>0</x:v></x:c><x:c s="1"><x:v>0</x:v></x:c></x:row>
<x:row r="5"><x:c r="B5" t="s"><x:v>1</x:v></x:c><x:c r="D5" s="1"><x:v>44000.5</x:v></x:c></x:row>
</x:sheetData></x:worksheet>`;
  const sst = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Jméno</t><rPh sb="0" eb="1"><t>ジ</t></rPh></si><si><t>a_x000D_b &amp; c</t></si></sst>`;
  const styles = `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="170" formatCode="[$-405]d\\.\\ mmmm\\ yyyy;@"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="170"/></cellXfs></styleSheet>`;
  const wb = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="1"/><sheets><sheet name="Data" sheetId="7" r:id="rIdX"/></sheets></workbook>`;
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/listy/data.xml"/><Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="strings.xml"/><Relationship Id="rIdT" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styly.xml"/></Relationships>`;
  const rootRels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const buf = writeZip([
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: wb },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/listy/data.xml', data: sheet },
    { name: 'xl/strings.xml', data: sst },
    { name: 'xl/styly.xml', data: styles },
  ]);
  const r = readXlsx(buf);
  assert.deepStrictEqual(r.headers, ['Kód', 'Cena s DPH', 'Jméno', 'Datum']);
  assert.deepStrictEqual(r.rows[0], { Kód: 1, 'Cena s DPH': 12990, Jméno: false, Datum: '1904-01-01' });
  assert.deepStrictEqual(r.rows[1], { Kód: '', 'Cena s DPH': 'a\rb & c', Jméno: '', Datum: '2024-06-19T12:00:00' });
});

test('readXlsx: chyby – není XLSX, ZIP bez sešitu', () => {
  assert.throws(() => readXlsx(Buffer.from('a;b\n1;2\n')), (e) => e.code === 'ZIP_INVALID');
  assert.throws(() => readXlsx(writeZip([{ name: 'data.csv', data: 'a;b' }])), /není sešit Excelu/);
});

test('serialToIso a classifyFormat', () => {
  assert.strictEqual(serialToIso(1, 'date'), '1900-01-01');
  assert.strictEqual(serialToIso(59, 'date'), '1900-02-28');
  assert.strictEqual(serialToIso(61, 'date'), '1900-03-01');
  assert.strictEqual(serialToIso(46290, 'date'), '2026-09-25');
  assert.strictEqual(serialToIso(46290.75, 'date'), '2026-09-25T18:00:00');
  assert.strictEqual(serialToIso(46290.999999, 'datetime'), '2026-09-26T00:00:00');
  assert.strictEqual(serialToIso(0.5, 'time'), '12:00:00');
  assert.strictEqual(serialToIso(1.5, 'time'), 1.5); // doba trvání > 1 den zůstane číslem
  assert.strictEqual(serialToIso(0, 'date', true), '1904-01-01');
  assert.strictEqual(serialToIso(-1, 'date'), -1);
  assert.strictEqual(classifyFormat('d.m.yyyy'), 'date');
  assert.strictEqual(classifyFormat('[$-405]d\\.\\ mmmm\\ yyyy;@'), 'date');
  assert.strictEqual(classifyFormat('mm/dd/yy\\ hh:mm\\ AM/PM'), 'datetime');
  assert.strictEqual(classifyFormat('h:mm:ss'), 'time');
  assert.strictEqual(classifyFormat('[h]:mm'), 'time');
  assert.strictEqual(classifyFormat('mmm-yy'), 'date');
  assert.strictEqual(classifyFormat('#,##0.00\\ "Kč"'), null);
  assert.strictEqual(classifyFormat('#,##0.00 [$Kč-405];[Red]-#,##0.00 [$Kč-405]'), null);
  assert.strictEqual(classifyFormat('0.0" %"'), null);
  assert.strictEqual(classifyFormat('General'), null);
  assert.strictEqual(classifyFormat('0.00E+00'), null);
  assert.deepStrictEqual([0, 25, 26, 701, 702].map(colName), ['A', 'Z', 'AA', 'ZZ', 'AAA']);
  assert.deepStrictEqual(['A1', 'Z9', 'AA10', 'ZZ1', 'AAA1'].map(colIndex), [0, 25, 26, 701, 702]);
});

test('readXlsx: list s 20 000 řádky – čas a paměť', () => {
  const rows = [];
  for (let i = 0; i < 20000; i++) {
    rows.push({
      code: `KOLO-${i}`,
      name: `Horské kolo Žluťoučký kůň ${i}`,
      manufacturer: ['Trek', 'Specialized', 'Cannondale', 'Santa Cruz'][i % 4],
      price: 10000 + i,
      purchase: (10000 + i) / 1.5,
      stock: i % 7,
      ean: `859${String(i).padStart(10, '0')}`,
      date: '2026-09-25',
    });
  }
  const columns = [
    { key: 'code', label: 'Kód' },
    { key: 'name', label: 'Název' },
    { key: 'manufacturer', label: 'Výrobce' },
    { key: 'price', label: 'Cena', type: 'money' },
    { key: 'purchase', label: 'Nákup', type: 'number' },
    { key: 'stock', label: 'Sklad', type: 'number' },
    { key: 'ean', label: 'EAN', type: 'string' },
    { key: 'date', label: 'Datum', type: 'date' },
  ];
  let t0 = Date.now();
  const buf = writeXlsx([{ name: 'Katalog', columns, rows }]);
  const writeMs = Date.now() - t0;
  if (global.gc) global.gc();
  const heap0 = process.memoryUsage().heapUsed;
  t0 = Date.now();
  const r = readXlsx(buf);
  const readMs = Date.now() - t0;
  const heapDelta = (process.memoryUsage().heapUsed - heap0) / 1048576;
  assert.strictEqual(r.rows.length, 20000);
  assert.deepStrictEqual(r.rows[19999], {
    Kód: 'KOLO-19999',
    Název: 'Horské kolo Žluťoučký kůň 19999',
    Výrobce: 'Santa Cruz',
    Cena: 29999,
    Nákup: 19999.3333333333, // 15 platných číslic jako Excel
    Sklad: 19999 % 7,
    EAN: '8590000019999',
    Datum: '2026-09-25',
  });
  assert.ok(writeMs < 5000, `writeXlsx ${writeMs} ms`);
  assert.ok(readMs < 5000, `readXlsx ${readMs} ms`);
  assert.ok(heapDelta < 300, `paměť ${heapDelta.toFixed(0)} MB`);
});

// Interoperabilita: LibreOffice musí výstup writeXlsx otevřít. Test se přeskočí, když soffice chybí
// (nebo nemá modul Calc). Vypnout lze přes CENOTVORBA_SKIP_SOFFICE=1.
test('LibreOffice otevře výstup writeXlsx (volitelné, vyžaduje soffice)', { timeout: 180000 }, (t) => {
  if (process.env.CENOTVORBA_SKIP_SOFFICE) return t.skip('vypnuto proměnnou CENOTVORBA_SKIP_SOFFICE');
  const which = spawnSync('sh', ['-c', 'command -v soffice || command -v libreoffice'], { encoding: 'utf8' });
  const bin = which.status === 0 ? which.stdout.trim().split('\n')[0] : null;
  if (!bin) return t.skip('soffice není nainstalován');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cenotvorba-lo-'));
  try {
    const convert = (file) =>
      spawnSync(
        bin,
        [
          `-env:UserInstallation=file://${path.join(dir, 'profile')}`,
          '--headless',
          '--convert-to',
          'csv:Text - txt - csv (StarCalc):59,34,76,1,,0,false,true,false,false,false,-1',
          '--outdir',
          path.join(dir, 'out'),
          file,
        ],
        { encoding: 'utf8', timeout: 120000 }
      );
    const file = path.join(dir, 'navrhy.xlsx');
    fs.writeFileSync(file, writeXlsx([PROPOSALS, { name: 'Souhrn', rows: [{ stav: 'pending', počet: 3 }] }]));
    convert(file);
    const outDir = path.join(dir, 'out');
    // názvy výstupů obsahují název listu v kódování, které nemusí být UTF-8 → pracujeme s bajty
    const outputs = fs.existsSync(outDir) ? fs.readdirSync(outDir, { encoding: 'buffer' }) : [];
    if (!outputs.length) {
      // Funguje LibreOffice vůbec? Zkusíme soubor, který sám vytvořil.
      const ref = path.join(dir, 'ref.xlsx');
      fs.copyFileSync(path.join(FIXTURES, 'libreoffice-cz.xlsx'), ref);
      convert(ref);
      const refOk = fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0;
      if (!refOk) return t.skip('soffice nedokáže převádět sešity (chybí modul Calc?)');
      assert.fail('LibreOffice nedokázal otevřít výstup writeXlsx');
    }
    const first = outputs.find((f) => !f.toString('latin1').includes('Souhrn'));
    const csv = parseCsv(fs.readFileSync(Buffer.concat([Buffer.from(outDir + path.sep), first])), { delimiter: ';' });
    assert.deepStrictEqual(csv.headers.slice(0, 5), ['Kód', 'Název', 'Stará cena', 'Nová cena', 'Změna %']);
    assert.strictEqual(csv.rows[0].Kód, '00123');
    assert.strictEqual(csv.rows[0].Název, 'Kolo „Žluťoučký kůň“ & <spol>\nřádek 2');
    assert.strictEqual(csv.rows[0]['Nová cena'], '12490.5');
    assert.strictEqual(csv.rows[1].Název, '_x0041_ doslova');
    assert.strictEqual(outputs.length, 2, 'oba listy');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
