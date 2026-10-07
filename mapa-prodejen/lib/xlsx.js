// Čtení prvního listu XLSX bez knihoven (pro import objednávek a obratů v prohlížeči). ZIP se čte přes centrální
// adresář, rozbalení dodá volající: v prohlížeči DecompressionStream('deflate-raw'), v Node zlib.inflateRawSync.
// Vrací pole řádků (pole buněk: text / číslo / „YYYY-MM-DD“ u buněk formátovaných jako datum).
// UMD: v prohlížeči `MP.xlsx`, v Node require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.MP = root.MP || {}; root.MP.xlsx = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_ENTRY = 200 * 1024 * 1024;
  const MAX_ROWS = 500000;

  // Výchozí rozbalení: DecompressionStream (prohlížeč, Node 18+).
  async function inflateRawStream(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Prohlížeč neumí rozbalit XLSX – uložte soubor jako CSV.');
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function u16(dv, o) {
    return dv.getUint16(o, true);
  }
  function u32(dv, o) {
    return dv.getUint32(o, true);
  }

  function readZip(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 22) throw new Error('Soubor není platný XLSX (příliš krátký).');
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
      if (u32(dv, i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Soubor není platný XLSX (není to ZIP archiv). Starý formát .xls uložte jako .xlsx nebo CSV.');
    const total = u16(dv, eocd + 10);
    let p = u32(dv, eocd + 16);
    const entries = new Map();
    const dec = new TextDecoder('utf-8');
    for (let n = 0; n < total; n++) {
      if (p + 46 > bytes.length || u32(dv, p) !== 0x02014b50) throw new Error('Poškozený XLSX (centrální adresář).');
      const flags = u16(dv, p + 8);
      const method = u16(dv, p + 10);
      const csize = u32(dv, p + 20);
      const usize = u32(dv, p + 24);
      const nameLen = u16(dv, p + 28);
      const extraLen = u16(dv, p + 30);
      const commentLen = u16(dv, p + 32);
      const local = u32(dv, p + 42);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (flags & 1) throw new Error('XLSX je zašifrovaný heslem – uložte ho bez hesla.');
      entries.set(name, { method, csize, usize, local });
    }
    return { bytes, dv, entries };
  }

  async function entryText(zip, name, inflate) {
    let e = zip.entries.get(name);
    if (!e) {
      const lower = name.toLowerCase();
      for (const [k, v] of zip.entries) if (k.toLowerCase() === lower) e = v;
    }
    if (!e) return null;
    if (e.usize > MAX_ENTRY) throw new Error('List XLSX je po rozbalení příliš velký.');
    const lo = e.local;
    if (u32(zip.dv, lo) !== 0x04034b50) throw new Error('Poškozený XLSX (lokální hlavička).');
    const start = lo + 30 + u16(zip.dv, lo + 26) + u16(zip.dv, lo + 28);
    const raw = zip.bytes.subarray(start, start + e.csize);
    let data;
    if (e.method === 0) data = raw;
    else if (e.method === 8) data = await (inflate || inflateRawStream)(raw);
    else throw new Error('Nepodporovaná komprese XLSX (' + e.method + ').');
    return new TextDecoder('utf-8').decode(data);
  }

  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function unxml(s) {
    return s
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
          const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return Number.isFinite(code) ? String.fromCodePoint(code) : m;
        }
        return ENT[e.toLowerCase()] != null ? ENT[e.toLowerCase()] : m;
      })
      .replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  }

  // Text všech <t> uvnitř úseku (sdílený řetězec může mít více běhů formátování <r><t>…</t></r>).
  function textOf(xml) {
    let out = '';
    const re = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>|<(?:\w+:)?t\s*\/>/g;
    let m;
    while ((m = re.exec(xml))) if (m[1] != null) out += m[1];
    return unxml(out);
  }

  function sharedStrings(xml) {
    const out = [];
    if (!xml) return out;
    const re = /<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>|<(?:\w+:)?si\s*\/>/g;
    let m;
    while ((m = re.exec(xml))) {
      // fonetické přepisy (rPh) do textu nepatří
      out.push(m[1] ? textOf(m[1].replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '')) : '');
    }
    return out;
  }

  const BUILTIN_DATE = new Set([14, 15, 16, 17, 22, 27, 30, 36, 50, 57]);

  // Indexy stylů (cellXfs), které formátují datum.
  function dateStyles(xml) {
    const out = new Set();
    if (!xml) return out;
    const custom = new Map();
    for (const m of xml.matchAll(/<(?:\w+:)?numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) custom.set(Number(m[1]), unxml(m[2]));
    const xfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(xml);
    if (!xfs) return out;
    let i = 0;
    for (const m of xfs[1].matchAll(/<(?:\w+:)?xf\b([^>]*?)\/?>/g)) {
      const id = Number((/numFmtId="(\d+)"/.exec(m[1]) || [])[1]);
      const code = custom.get(id);
      const isDate = BUILTIN_DATE.has(id) || (code && /[dy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')) && !/^[#0.,\s%]+$/.test(code));
      if (isDate) out.add(i);
      i++;
    }
    return out;
  }

  function colIndex(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const c = ref.charCodeAt(i);
      if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
      else break;
    }
    return n - 1;
  }

  function serialDate(v) {
    if (!Number.isFinite(v) || v < 1 || v > 2958465) return v;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }

  function parseSheet(xml, shared, dates) {
    const rows = [];
    const rowRe = /<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>|<(?:\w+:)?row\b[^>]*\/>/g;
    const cellRe = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
    let rm;
    let nextRow = 0;
    while ((rm = rowRe.exec(xml))) {
      if (rows.length >= MAX_ROWS) break;
      const rAttr = /\br="(\d+)"/.exec(rm[1] || '');
      const ri = rAttr ? Number(rAttr[1]) - 1 : nextRow;
      while (rows.length < ri) rows.push([]);
      nextRow = ri + 1;
      const row = [];
      let cm;
      let nextCol = 0;
      const body = rm[2] || '';
      cellRe.lastIndex = 0;
      while ((cm = cellRe.exec(body))) {
        const attrs = cm[1];
        const inner = cm[2] || '';
        const ref = /\br="([A-Z]+)\d*"/.exec(attrs);
        const ci = ref ? colIndex(ref[1]) : nextCol;
        nextCol = ci + 1;
        const t = (/\bt="(\w+)"/.exec(attrs) || [])[1] || 'n';
        const s = Number((/\bs="(\d+)"/.exec(attrs) || [])[1] || 0);
        const vm = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner);
        const v = vm ? unxml(vm[1]) : null;
        let val = null;
        if (t === 's') val = v != null ? shared[Number(v)] ?? '' : '';
        else if (t === 'inlineStr') val = textOf(inner);
        else if (t === 'str' || t === 'e') val = v != null ? v : '';
        else if (t === 'b') val = v === '1' ? 'ano' : 'ne';
        else if (v != null && v !== '') {
          const num = Number(v);
          val = Number.isFinite(num) ? (dates.has(s) ? serialDate(num) : num) : v;
        }
        while (row.length < ci) row.push(null);
        row[ci] = val;
      }
      rows[ri] = row;
    }
    return rows;
  }

  // Cesta k prvnímu listu podle workbook.xml a jeho vztahů.
  async function firstSheetPath(zip, inflate) {
    const wb = await entryText(zip, 'xl/workbook.xml', inflate);
    const rels = await entryText(zip, 'xl/_rels/workbook.xml.rels', inflate);
    if (wb && rels) {
      const sheet = /<(?:\w+:)?sheet\b[^>]*\br:id="([^"]+)"/.exec(wb) || /<(?:\w+:)?sheet\b[^>]*\bid="([^"]+)"/.exec(wb);
      if (sheet) {
        const re = new RegExp('<Relationship\\b[^>]*Id="' + sheet[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>');
        const rel = re.exec(rels);
        const target = rel && /Target="([^"]+)"/.exec(rel[0]);
        if (target) {
          const t = target[1].replace(/^\/?xl\//, '').replace(/^\//, '');
          return 'xl/' + t;
        }
      }
    }
    for (const name of zip.entries.keys()) if (/^xl\/worksheets\/sheet\d*\.xml$/i.test(name)) return name;
    return null;
  }

  // Hlavní funkce: ArrayBuffer/Uint8Array → Promise<pole řádků>.
  async function readXlsx(buf, opts) {
    const inflate = opts && opts.inflate;
    const zip = readZip(buf);
    const sheetPath = await firstSheetPath(zip, inflate);
    if (!sheetPath) throw new Error('V souboru XLSX není žádný list.');
    const [ss, styles, sheet] = await Promise.all([entryText(zip, 'xl/sharedStrings.xml', inflate), entryText(zip, 'xl/styles.xml', inflate), entryText(zip, sheetPath, inflate)]);
    if (sheet == null) throw new Error('List ' + sheetPath + ' v souboru chybí.');
    return parseSheet(sheet, sharedStrings(ss), dateStyles(styles));
  }

  // XLSX poznáme podle podpisu ZIP („PK\x03\x04“) na začátku souboru.
  function isXlsx(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4;
  }

  // Text jedné položky libovolného ZIP archivu (sestavení dat: GeoNames).
  async function zipEntryText(buf, name, inflate) {
    return entryText(readZip(buf), name, inflate);
  }

  return { readXlsx, isXlsx, parseSheet, sharedStrings, dateStyles, zipEntryText };
});
