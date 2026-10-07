'use strict';
// Testy čtení XLSX bez knihoven (lib/xlsx.js) – sešit se složí v testu (ZIP s komprimovanými i nekomprimovanými
// položkami, sdílené řetězce, vložený text, datum podle stylu, prázdné buňky).
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const x = require('../lib/xlsx.js');

function zip(entries) {
  const parts = [];
  const central = [];
  let off = 0;
  for (const [name, text, deflate] of entries) {
    const data = Buffer.from(text, 'utf8');
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const nm = Buffer.from(name);
    const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nm.length, 26);
    parts.push(lh, nm, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nm.length, 28);
    ch.writeUInt32LE(off, 42);
    central.push(ch, nm);
    off += 30 + nm.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

const WB = '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Obj" sheetId="1" r:id="rId7"/></sheets></workbook>';
const RELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/list1.xml"/></Relationships>';
const SS = '<sst><si><t>PSČ</t></si><si><r><t>Dodací </t></r><r><t>město</t></r></si><si><t>Brno &amp; okolí</t></si><si><t>Datum</t></si></sst>';
const STYLES = '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="d\\.m\\.yyyy"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="4"/></cellXfs></styleSheet>';
const SHEET = '<worksheet><sheetData>' +
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>3</v></c></row>' +
  '<row r="2"><c r="A2"><v>60200</v></c><c r="B2" t="s"><v>2</v></c><c r="C2" t="inlineStr"><is><t>vložený</t></is></c><c r="D2" s="1"><v>45730</v></c><c r="E2" s="2"><v>1234.5</v></c></row>' +
  '<row r="4"><c r="B4" t="str"><v>vzorec</v></c><c r="C4" t="b"><v>1</v></c></row>' +
  '</sheetData></worksheet>';

const inflate = async (b) => zlib.inflateRawSync(Buffer.from(b));

test('XLSX: první list podle workbooku, sdílené řetězce, datum, prázdné řádky', async () => {
  const buf = zip([
    ['[Content_Types].xml', '<Types/>', false],
    ['xl/workbook.xml', WB, true],
    ['xl/_rels/workbook.xml.rels', RELS, false],
    ['xl/sharedStrings.xml', SS, true],
    ['xl/styles.xml', STYLES, true],
    ['xl/worksheets/list1.xml', SHEET, true],
  ]);
  assert.ok(x.isXlsx(buf));
  const rows = await x.readXlsx(buf, { inflate });
  assert.deepStrictEqual(rows[0], ['PSČ', 'Dodací město', null, 'Datum']);
  assert.deepStrictEqual(rows[1], [60200, 'Brno & okolí', 'vložený', '2025-03-14', 1234.5]);
  assert.deepStrictEqual(rows[2], []);
  assert.deepStrictEqual(rows[3], [null, 'vzorec', 'ano']);
});

test('XLSX: chybné soubory dají srozumitelnou chybu', async () => {
  assert.ok(!x.isXlsx(Buffer.from('PSČ;počet\n')));
  await assert.rejects(x.readXlsx(Buffer.from('nejde o zip, jen text dost dlouhý na hlavičku'), { inflate }), /není platný XLSX/);
  const bezListu = zip([['xl/workbook.xml', '<workbook/>', false]]);
  await assert.rejects(x.readXlsx(bezListu, { inflate }), /není žádný list/);
});

test('ZIP: text položky (GeoNames v sestavení dat)', async () => {
  const buf = zip([['CZ.txt', 'CZ\t602 00\tBrno', true]]);
  assert.strictEqual(await x.zipEntryText(buf, 'CZ.txt', inflate), 'CZ\t602 00\tBrno');
  assert.strictEqual(await x.zipEntryText(buf, 'chybi.txt', inflate), null);
});
