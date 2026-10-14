'use strict';
// Výroba malých souborů XLSX pro testy (bez knihoven): ZIP s uloženými i komprimovanými částmi a listy z řádků.
const zlib = require('node:zlib');

function zip(soubory) {
  const casti = [];
  const adresar = [];
  let offset = 0;
  for (const f of soubory) {
    const jmeno = Buffer.from(f.jmeno, 'utf8');
    const data = Buffer.from(f.data, 'utf8');
    const kompr = f.ulozit ? data : zlib.deflateRawSync(data);
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;
    const metoda = f.ulozit ? 0 : 8;
    const mistni = Buffer.alloc(30);
    mistni.writeUInt32LE(0x04034b50, 0);
    mistni.writeUInt16LE(20, 4);
    mistni.writeUInt16LE(metoda, 8);
    mistni.writeUInt32LE(crc, 14);
    mistni.writeUInt32LE(kompr.length, 18);
    mistni.writeUInt32LE(data.length, 22);
    mistni.writeUInt16LE(jmeno.length, 26);
    casti.push(mistni, jmeno, kompr);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(metoda, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(kompr.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(jmeno.length, 28);
    c.writeUInt32LE(offset, 42);
    adresar.push(c, jmeno);
    offset += 30 + jmeno.length + kompr.length;
  }
  const cd = Buffer.concat(adresar);
  const konec = Buffer.alloc(22);
  konec.writeUInt32LE(0x06054b50, 0);
  konec.writeUInt16LE(soubory.length, 8);
  konec.writeUInt16LE(soubory.length, 10);
  konec.writeUInt32LE(cd.length, 12);
  konec.writeUInt32LE(offset, 16);
  return Buffer.concat([...casti, cd, konec]);
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sloupec = (i) => (i >= 26 ? sloupec(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));

// listy: [{ nazev, radky: string[][] }] → Buffer s XLSX (inline řetězce; čísla jako čísla).
function xlsx(listy) {
  const sheets = listy.map((l, i) => `<sheet name="${xml(l.nazev)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const rels = listy.map((_l, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  const soubory = [
    { jmeno: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', ulozit: true },
    { jmeno: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>` },
    { jmeno: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>` },
  ];
  listy.forEach((l, i) => {
    const rows = l.radky.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (v === '' ? '' : typeof v === 'number' ? `<c r="${sloupec(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${sloupec(ci)}${ri + 1}" t="inlineStr"><is><t>${xml(v)}</t></is></c>`)).join('')}</row>`).join('');
    soubory.push({ jmeno: `xl/worksheets/sheet${i + 1}.xml`, data: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>` });
  });
  return zip(soubory);
}

module.exports = { zip, xlsx };
