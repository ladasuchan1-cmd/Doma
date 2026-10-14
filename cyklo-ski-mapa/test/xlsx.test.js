'use strict';
// Testy čtení XLSX bez knihoven (lib/xlsx.js) nad malými soubory vyrobenými v testu.
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const x = require('../lib/xlsx.js');
const { zip, xlsx } = require('./fixtures/xlsx-vyroba.js');

const inflate = (d) => zlib.inflateRawSync(d);

test('sdílené řetězce, formátovaný text, entity, inline řetězce, čísla, logické hodnoty a mezery v řádcích', async () => {
  const soubor = zip([
    { jmeno: 'xl/workbook.xml', data: '<workbook xmlns:r="r"><sheets><sheet name="Ústecký kraj" sheetId="1" r:id="rId1"/><sheet name="Jinde" sheetId="2" r:id="rId2"/></sheets></workbook>' },
    { jmeno: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/druhy.xml"/></Relationships>', ulozit: true },
    { jmeno: 'xl/sharedStrings.xml', data: '<sst><si><t>Název</t></si><si><r><t>Hotel </t></r><r><t xml:space="preserve">U &amp; Lípy</t></r></si><si><t>ano (14. 10. 2026)</t><rPh><t>fonetika</t></rPh></si><si/></sst>' },
    { jmeno: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>OSM</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>9.8000000000000007</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" s="1"/><c r="E2" t="s"><v>2</v></c></row><row r="4"><c r="B4" t="str"><v>&lt;vzorec&gt;</v></c></row></sheetData></worksheet>' },
    { jmeno: 'xl/worksheets/druhy.xml', data: '<x:worksheet xmlns:x="m"><x:sheetData><x:row><x:c t="inlineStr"><x:is><x:t>a</x:t></x:is></x:c><x:c><x:v>2</x:v></x:c></x:row></x:sheetData></x:worksheet>' },
  ]);
  const listy = await x.nactiXlsx(soubor, inflate);
  assert.deepStrictEqual(listy.map((l) => l.nazev), ['Ústecký kraj', 'Jinde']);
  assert.deepStrictEqual(listy[0].radky, [
    ['Název', '', 'OSM'],
    ['Hotel U & Lípy', '9.8000000000000007', 'TRUE', '', 'ano (14. 10. 2026)'],
    [],
    ['', '<vzorec>'],
  ]);
  assert.deepStrictEqual(listy[1].radky, [['a', '2']]);
});

test('soubor vyrobený pro import: víc listů, inflate přes Promise', async () => {
  const soubor = xlsx([{ nazev: 'A', radky: [['OSM', 'Poznámka'], ['https://www.openstreetmap.org/node/1', 'ahoj']] }, { nazev: 'B', radky: [] }]);
  const listy = await x.nactiXlsx(new Uint8Array(soubor).buffer, async (d) => inflate(d));
  assert.deepStrictEqual(listy[0].radky, [['OSM', 'Poznámka'], ['https://www.openstreetmap.org/node/1', 'ahoj']]);
  assert.deepStrictEqual(listy[1].radky, []);
});

test('srozumitelné chyby: není ZIP, ZIP bez sešitu', async () => {
  await assert.rejects(x.nactiXlsx(Buffer.from('Název;OSM\r\n'), inflate), /není tabulka Excelu/);
  await assert.rejects(x.nactiXlsx(zip([{ jmeno: 'a.txt', data: 'x' }]), inflate), /chybí xl\/workbook\.xml/);
});

test('indexSloupce', () => {
  assert.strictEqual(x.indexSloupce('A1'), 0);
  assert.strictEqual(x.indexSloupce('Z9'), 25);
  assert.strictEqual(x.indexSloupce('AA10'), 26);
  assert.strictEqual(x.indexSloupce('XFD1'), 16383);
});
