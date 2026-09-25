'use strict';
// XLSX (Office Open XML) bez závislostí: čtení listu do řádků a zápis sešitu pro Excel / LibreOffice.
// Čtení listu jde přes nízkoúrovňový tokenizér (bez stavby stromu) – i list s desítkami tisíc řádků je paměťově v pořádku.

const path = require('node:path');
const { readZip, writeZip } = require('./zip');
const { decodeBuffer } = require('./decode');
const { parseXml, tokenizeXml, decodeText, escapeXml } = require('./xml');
const { normalizeHeaders, fillMissing } = require('./csv');

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function xlsxError(message, code = 'XLSX_INVALID') {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------------------------------------------
// Pomocné funkce

/** Index sloupce (od 0) z odkazu buňky „AB12“. */
function colIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
    else break;
  }
  return n - 1;
}

/** Název sloupce z indexu (0 → A, 26 → AA). */
function colName(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** OOXML escapování řídicích znaků „_x000D_“ → znak. */
function unescapeOoxml(s) {
  if (s.indexOf('_x') === -1) return s;
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function escapeOoxmlText(s) {
  // literální „_xHHHH_“ v textu je nutné chránit, jinak by ho Excel dekódoval
  return /_x[0-9A-Fa-f]{4}_/.test(s) ? s.replace(/_(x[0-9A-Fa-f]{4}_)/g, '_x005F_$1') : s;
}

function readPart(zip, name) {
  let fn = zip.get(name);
  if (!fn) {
    // některé generátory mají jinou velikost písmen v názvech
    const lower = name.toLowerCase();
    for (const [k, v] of zip) {
      if (k.toLowerCase() === lower) {
        fn = v;
        break;
      }
    }
  }
  return fn ? decodeBuffer(fn()) : null;
}

function resolveTarget(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  return path.posix.normalize(path.posix.join(baseDir, target)).replace(/^\/+/, '');
}

function relsFor(zip, partName) {
  const dir = path.posix.dirname(partName);
  const relsName = (dir === '.' ? '' : dir + '/') + '_rels/' + path.posix.basename(partName) + '.rels';
  const xml = readPart(zip, relsName);
  const out = [];
  if (!xml) return out;
  const root = parseXml(xml);
  for (const r of root.children) {
    if (r.name !== 'Relationship') continue;
    if ((r.attrs.TargetMode || '').toLowerCase() === 'external') continue;
    out.push({ id: r.attrs.Id, type: r.attrs.Type || '', target: resolveTarget(dir === '.' ? '' : dir, r.attrs.Target || '') });
  }
  return out;
}

const endsWithType = (rel, t) => rel.type.endsWith('/' + t);

// Vestavěné formáty čísel, které jsou datum/čas (ECMA-376 18.8.30).
const BUILTIN_DATE = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]);
const BUILTIN_TIME = new Set([18, 19, 20, 21, 32, 33, 45, 46, 47, 55, 56]);

/**
 * Rozpozná, zda formátovací kód čísla zobrazuje datum/čas.
 * @returns {'date'|'datetime'|'time'|null}
 */
function classifyFormat(code) {
  if (!code) return null;
  let s = String(code)
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/[_*]./g, '');
  const elapsed = /\[(h+|m+|s+)\]/i.test(s);
  s = s.replace(/\[[^\]]*\]/g, '').split(';')[0];
  s = s.replace(/general/gi, '').replace(/am\/pm|a\/p/gi, 'h');
  const hasDay = /[dy]/i.test(s);
  const hasM = /m/i.test(s);
  const hasTime = /[hs]/i.test(s) || elapsed;
  const isDate = hasDay || (hasM && !hasTime);
  if (isDate) return hasTime ? 'datetime' : 'date';
  if (hasTime) return 'time';
  return null;
}

const DAY_MS = 86400000;
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

const pad2 = (n) => (n < 10 ? '0' : '') + n;

/** Excel sériové číslo → ISO řetězec (bez časové zóny – Excel zóny nezná). */
function serialToIso(serial, kind, date1904) {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) return serial;
  if (kind === 'time') {
    if (serial >= 1) return serial; // doba trvání [h]:mm – ponechat číslo
    const secs = Math.round(serial * 86400) % 86400;
    return `${pad2(Math.floor(secs / 3600))}:${pad2(Math.floor((secs % 3600) / 60))}:${pad2(secs % 60)}`;
  }
  let days = Math.floor(serial);
  let secs = Math.round((serial - days) * 86400);
  if (secs >= 86400) {
    days++;
    secs -= 86400;
  }
  let ms;
  if (date1904) ms = EPOCH_1904 + days * DAY_MS;
  else ms = EPOCH_1900 + (days < 60 ? days + 1 : days) * DAY_MS; // chyba Lotus 1-2-3: 29. 2. 1900 neexistuje
  const d = new Date(ms + secs * 1000);
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  if (kind === 'date' && secs === 0) return date;
  return `${date}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** Hodnota z <v> → číslo; Excel ukládá max. 15 platných číslic, šum 0.30000000000000004 odstraníme. */
function toNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return v.length > 15 && !Number.isInteger(n) ? Number(n.toPrecision(15)) : n;
}

// ---------------------------------------------------------------------------------------------------------------
// Čtení

function readSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  let inSi = false;
  let inT = false;
  let rph = 0;
  let cur = '';
  tokenizeXml(xml, {
    open(name) {
      if (name === 'si') {
        inSi = true;
        cur = '';
      } else if (name === 'rPh') rph++;
      else if (name === 't' && inSi && rph === 0) inT = true;
    },
    close(name) {
      if (name === 'si') {
        out.push(unescapeOoxml(cur));
        inSi = false;
      } else if (name === 'rPh') rph--;
      else if (name === 't') inT = false;
    },
    text(str, s, e) {
      if (inT) cur += decodeText(str.slice(s, e));
    },
    cdata(t) {
      if (inT) cur += t;
    },
  });
  return out;
}

/** Pro každý index stylu buňky (cellXfs) druh data/času nebo null. */
function readDateStyles(xml) {
  const kinds = [];
  if (!xml) return kinds;
  const root = parseXml(xml);
  const custom = new Map();
  const numFmts = root.children.find((c) => c.name === 'numFmts');
  if (numFmts) for (const f of numFmts.children) if (f.name === 'numFmt') custom.set(Number(f.attrs.numFmtId), f.attrs.formatCode || '');
  const cellXfs = root.children.find((c) => c.name === 'cellXfs');
  if (cellXfs) {
    for (const xf of cellXfs.children) {
      if (xf.name !== 'xf') continue;
      const id = Number(xf.attrs.numFmtId || 0);
      let kind = null;
      if (custom.has(id)) kind = classifyFormat(custom.get(id));
      else if (BUILTIN_DATE.has(id)) kind = id === 22 ? 'datetime' : 'date';
      else if (BUILTIN_TIME.has(id)) kind = 'time';
      kinds.push(kind);
    }
  }
  return kinds;
}

function isEmptyValue(v) {
  return v === undefined || v === null || v === '' || (typeof v === 'string' && v.trim() === '');
}

function headerCell(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

/**
 * Přečte list sešitu XLSX.
 * @param {Buffer} buf
 * @param {{sheet?: string|number, headerRow?: number}} [opts]
 *   sheet: název listu nebo index od 0 (výchozí = první viditelný list);
 *   headerRow: číslo řádku s hlavičkou (od 1); výchozí = první neprázdný řádek.
 * @returns {{sheets: string[], sheet: string, headers: string[], rows: object[]}}
 *   Hodnoty: text, číslo, boolean; datum podle stylu → ISO řetězec „YYYY-MM-DD“ / „YYYY-MM-DDTHH:MM:SS“,
 *   chyby vzorců jako text („#N/A“), vzorce jako uložená hodnota. Prázdné buňky → ''.
 */
function readXlsx(buf, opts = {}) {
  const zip = readZip(buf);
  let wbPath = 'xl/workbook.xml';
  const rootRel = relsFor(zip, '').find((r) => endsWithType(r, 'officeDocument'));
  if (rootRel) wbPath = rootRel.target;
  const wbXml = readPart(zip, wbPath);
  if (!wbXml) throw xlsxError('Soubor není sešit Excelu XLSX (chybí xl/workbook.xml).');
  const wb = parseXml(wbXml);
  const wbDir = path.posix.dirname(wbPath) === '.' ? '' : path.posix.dirname(wbPath);
  const inWbDir = (f) => (wbDir ? `${wbDir}/${f}` : f);
  const rels = relsFor(zip, wbPath);
  const relById = new Map(rels.map((r) => [r.id, r]));

  const pr = wb.children.find((c) => c.name === 'workbookPr');
  const date1904 = !!pr && /^(1|true)$/i.test(pr.attrs.date1904 || '');
  const sheetsEl = wb.children.find((c) => c.name === 'sheets');
  const sheetList = (sheetsEl ? sheetsEl.children : [])
    .filter((c) => c.name === 'sheet')
    .map((c) => ({ name: c.attrs.name || '', state: c.attrs.state || 'visible', rid: c.attrs.id || c.attrs['r:id'] }));
  if (!sheetList.length) throw xlsxError('Sešit neobsahuje žádný list.');
  const names = sheetList.map((s) => s.name);

  let chosen = null;
  const want = opts.sheet;
  if (want === undefined || want === null || want === '') {
    chosen = sheetList.find((s) => s.state === 'visible') || sheetList[0];
  } else if (typeof want === 'number') {
    chosen = sheetList[want];
  } else {
    const w = String(want);
    chosen =
      sheetList.find((s) => s.name === w) ||
      sheetList.find((s) => s.name.trim().toLowerCase() === w.trim().toLowerCase()) ||
      (/^\d+$/.test(w.trim()) ? sheetList[Number(w.trim())] : undefined);
  }
  if (!chosen) throw xlsxError(`List „${want}“ v sešitu neexistuje (listy: ${names.join(', ')}).`, 'XLSX_SHEET_NOT_FOUND');

  const rel = relById.get(chosen.rid);
  let sheetPath = rel ? rel.target : null;
  if (!sheetPath) {
    // bez vazby zkusíme konvenční název
    const idx = sheetList.indexOf(chosen) + 1;
    sheetPath = inWbDir(`worksheets/sheet${idx}.xml`);
  }
  const sheetXml = readPart(zip, sheetPath);
  if (sheetXml == null) throw xlsxError(`V sešitu chybí data listu „${chosen.name}“ (${sheetPath}).`);

  const sstRel = rels.find((r) => endsWithType(r, 'sharedStrings'));
  const sst = readSharedStrings(readPart(zip, sstRel ? sstRel.target : inWbDir('sharedStrings.xml')));
  const stylesRel = rels.find((r) => endsWithType(r, 'styles'));
  const dateKinds = readDateStyles(readPart(zip, stylesRel ? stylesRel.target : inWbDir('styles.xml')));

  const headerRowOpt = opts.headerRow ?? opts.header_row;
  const headerRowNo = headerRowOpt ? Math.max(1, parseInt(headerRowOpt, 10) || 1) : null;
  let headers = null;
  let used = null;
  let initialCols = 0;
  const rows = [];

  function flushRow(rowNum, cells) {
    if (headers === null) {
      if (headerRowNo !== null && rowNum < headerRowNo) return;
      let empty = true;
      for (let k = 0; k < cells.length; k++) if (!isEmptyValue(cells[k])) empty = false;
      if (empty) return;
      const hc = new Array(cells.length);
      for (let k = 0; k < cells.length; k++) hc[k] = headerCell(cells[k]);
      headers = normalizeHeaders(hc);
      used = new Set(headers);
      initialCols = headers.length;
      return;
    }
    let empty = true;
    for (let k = 0; k < cells.length; k++) {
      if (!isEmptyValue(cells[k])) {
        empty = false;
        break;
      }
    }
    if (empty) return;
    const o = {};
    const nh = headers.length;
    for (let k = 0; k < nh; k++) {
      const v = cells[k];
      setOwn(o, headers[k], v === undefined ? '' : v);
    }
    for (let k = nh; k < cells.length; k++) {
      if (isEmptyValue(cells[k])) continue;
      while (headers.length <= k) {
        let name = `col_${headers.length + 1}`;
        for (let n = 2; used.has(name); n++) name = `col_${headers.length + 1}_${n}`;
        used.add(name);
        headers.push(name);
      }
      setOwn(o, headers[k], cells[k]);
    }
    rows.push(o);
  }

  let inData = false;
  let cells = null;
  let rowNum = 0;
  let col = -1;
  let cType = 'n';
  let cStyle = 0;
  let inV = false;
  let hasV = false;
  let v = '';
  let inIs = false;
  let inT = false;
  let rph = 0;
  let t = '';

  function cellValue() {
    if (cType === 'inlineStr') return unescapeOoxml(t);
    if (!hasV) return '';
    switch (cType) {
      case 's': {
        const s = sst[parseInt(v, 10)];
        return s === undefined ? '' : s;
      }
      case 'str':
        return unescapeOoxml(v);
      case 'b':
        return v.trim() === '1' || v.trim().toLowerCase() === 'true';
      case 'e':
        return v.trim();
      case 'd':
        return v.trim();
      default: {
        const vs = v.trim();
        if (vs === '') return '';
        const n = toNumber(vs);
        if (n === null) return vs;
        const kind = dateKinds[cStyle];
        return kind ? serialToIso(n, kind, date1904) : n;
      }
    }
  }

  tokenizeXml(sheetXml, {
    open(name, attrs) {
      switch (name) {
        case 'sheetData':
          inData = true;
          break;
        case 'row':
          if (!inData) break;
          rowNum = attrs.r ? parseInt(attrs.r, 10) : rowNum + 1;
          cells = [];
          col = -1;
          break;
        case 'c':
          if (cells === null) break;
          col = attrs.r ? colIndex(attrs.r) : col + 1;
          if (col < 0) col = 0;
          cType = attrs.t || 'n';
          cStyle = attrs.s ? parseInt(attrs.s, 10) || 0 : 0;
          hasV = false;
          v = '';
          t = '';
          break;
        case 'v':
          inV = true;
          hasV = true;
          break;
        case 'is':
          inIs = true;
          break;
        case 't':
          if (inIs && rph === 0) inT = true;
          break;
        case 'rPh':
          rph++;
          break;
        default:
      }
    },
    close(name) {
      switch (name) {
        case 'v':
          inV = false;
          break;
        case 't':
          inT = false;
          break;
        case 'is':
          inIs = false;
          break;
        case 'rPh':
          rph--;
          break;
        case 'c':
          if (cells !== null) cells[col] = cellValue();
          break;
        case 'row':
          if (cells !== null) flushRow(rowNum, cells);
          cells = null;
          break;
        case 'sheetData':
          inData = false;
          break;
        default:
      }
    },
    text(str, s, e) {
      if (inV) v += decodeText(str.slice(s, e));
      else if (inT) t += decodeText(str.slice(s, e));
    },
    cdata(x) {
      if (inV) v += x;
      else if (inT) t += x;
    },
  });

  if (headers && headers.length > initialCols) fillMissing(rows, headers, initialCols);
  return { sheets: names, sheet: chosen.name, headers: headers || [], rows };
}

function setOwn(obj, key, value) {
  if (key === '__proto__') Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  else obj[key] = value;
}

// ---------------------------------------------------------------------------------------------------------------
// Zápis

const BUILTIN_FMT = new Map([
  ['General', 0],
  ['0', 1],
  ['0.00', 2],
  ['#,##0', 3],
  ['#,##0.00', 4],
  ['0%', 9],
  ['0.00%', 10],
  ['@', 49],
]);
const FMT_DATE = 14; // krátké datum podle národního prostředí (v CZ Excelu „25.09.2026“)
const FMT_DATETIME = 22; // datum a čas podle národního prostředí
const TYPE_FORMAT = { money: '#,##0', percent: '0.0" %"', number: 'General', string: 'General' };

class Styles {
  constructor() {
    this.numFmts = new Map(); // kód → id (vlastní od 164)
    this.xfs = [{ numFmtId: 0, fontId: 0, fillId: 0 }]; // 0 = výchozí
    this.keys = new Map([['0|0|0', 0]]);
    this.header = this.xf(0, 1, 2);
  }
  fmtId(code) {
    if (typeof code === 'number') return code;
    if (BUILTIN_FMT.has(code)) return BUILTIN_FMT.get(code);
    if (!this.numFmts.has(code)) this.numFmts.set(code, 164 + this.numFmts.size);
    return this.numFmts.get(code);
  }
  xf(numFmtId, fontId = 0, fillId = 0) {
    const key = `${numFmtId}|${fontId}|${fillId}`;
    if (!this.keys.has(key)) {
      this.keys.set(key, this.xfs.length);
      this.xfs.push({ numFmtId, fontId, fillId });
    }
    return this.keys.get(key);
  }
  forFormat(code) {
    return this.xf(this.fmtId(code));
  }
  toXml() {
    const fmts = [...this.numFmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escapeXml(code)}"/>`);
    const xfs = this.xfs.map((x) => {
      let a = `<xf numFmtId="${x.numFmtId}" fontId="${x.fontId}" fillId="${x.fillId}" borderId="0" xfId="0"`;
      if (x.numFmtId) a += ' applyNumberFormat="1"';
      if (x.fontId) a += ' applyFont="1"';
      if (x.fillId) a += ' applyFill="1"';
      return a + '/>';
    });
    return (
      XML_DECL +
      `<styleSheet xmlns="${MAIN_NS}">` +
      (fmts.length ? `<numFmts count="${fmts.length}">${fmts.join('')}</numFmts>` : '') +
      '<fonts count="2">' +
      // bez odkazů na motiv (theme) – sešit žádný motiv neobsahuje
      '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
      '</fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
      '</styleSheet>'
    );
  }
}

/** Neplatné znaky v názvu listu nahradí „_“, zkrátí na 31 znaků, zajistí unikátnost. */
function sheetNames(list) {
  const used = new Set();
  return list.map((s, i) => {
    let name = String(s?.name ?? '')
      .replace(/[[\]:*?/\\]/g, '_')
      .replace(/[\u0000-\u001f]/g, '')
      .replace(/^'+|'+$/g, '')
      .trim();
    if (!name) name = `List${i + 1}`;
    name = Array.from(name).slice(0, 31).join('');
    let cand = name;
    for (let n = 2; used.has(cand.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      cand = Array.from(name).slice(0, 31 - suffix.length).join('') + suffix;
    }
    used.add(cand.toLowerCase());
    return cand;
  });
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Části data/času v zóně tz (pro převod UTC časů na místní čas pro Excel). */
function zonedParts(ms, tz) {
  try {
    const f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const p = {};
    for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
    return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
  } catch {
    const d = new Date(ms);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
  }
}

/**
 * Datum (Date nebo ISO řetězec) → {serial, time: bool} nebo null.
 * Časy s údajem o zóně (…Z, +02:00) i objekty Date se převedou na místní čas v `tz` (výchozí Europe/Prague).
 */
function toSerial(v, tz) {
  let p;
  let hasTime;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    p = zonedParts(v.getTime(), tz);
    hasTime = p.h !== 0 || p.mi !== 0 || p.s !== 0;
  } else if (typeof v === 'string') {
    const m = ISO_DATE_RE.exec(v.trim());
    if (!m) return null;
    if (m[4] === undefined) {
      p = { y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0, s: 0 };
      hasTime = false;
    } else if (m[7]) {
      const ms = Date.parse(v.trim().replace(' ', 'T'));
      if (Number.isNaN(ms)) return null;
      p = zonedParts(ms, tz);
      hasTime = true;
    } else {
      p = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0) };
      hasTime = true;
    }
  } else return null;
  const ms = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  if (Number.isNaN(ms)) return null;
  const serial = (ms - EPOCH_1900) / DAY_MS;
  if (serial < 61) return null; // před 1. 3. 1900 Excel data nezobrazí správně
  return { serial, time: hasTime };
}

const NUMERIC_RE = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const MAX_CELL_CHARS = 32767;

function numStr(n) {
  // bez exponentu u běžných hodnot; Excel čte i „1E+21“
  return String(n);
}

/**
 * Vytvoří sešit XLSX. Hlavička je tučná a ukotvená, s automatickým filtrem; formáty čísel dle typu sloupce:
 * money `#,##0`, percent `0.0" %"` (hodnota už je v procentech, 12.5 → „12,5 %“), date = krátké datum,
 * number/string = obecný. Volitelně `format` (vlastní formátovací kód Excelu) a `width` (znaky) u sloupce.
 * Text delší než 32 767 znaků (limit Excelu) se zkrátí.
 * @param {Array<{name: string, columns?: Array<{key: string, label?: string, width?: number,
 *   type?: 'string'|'number'|'money'|'percent'|'date', format?: string}>, rows: object[]}>} sheets
 * @param {{timeZone?: string, creator?: string, date?: Date}} [opts]
 * @returns {Buffer}
 */
function writeXlsx(sheets, opts = {}) {
  if (!Array.isArray(sheets)) sheets = [sheets];
  if (!sheets.length) sheets = [{ name: 'List1', columns: [], rows: [] }];
  const tz = opts.timeZone || 'Europe/Prague';
  const styles = new Styles();
  const sst = new Map();
  let sstCount = 0;
  const sstIndex = (s) => {
    sstCount++;
    let i = sst.get(s);
    if (i === undefined) {
      i = sst.size;
      sst.set(s, i);
    }
    return i;
  };
  const dateStyle = styles.xf(FMT_DATE);
  const dateTimeStyle = styles.xf(FMT_DATETIME);
  const names = sheetNames(sheets);
  const files = [];
  const definedNames = [];

  sheets.forEach((sheet, si) => {
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    let columns = sheet.columns;
    if (!columns || !columns.length) {
      const keys = new Set();
      for (const r of rows.slice(0, 1000)) for (const k of Object.keys(r || {})) keys.add(k);
      columns = [...keys].map((key) => ({ key }));
    }
    const cols = columns.map((c) => (typeof c === 'string' ? { key: c } : c));
    const colStyle = cols.map((c) => {
      const fmt = c.format || TYPE_FORMAT[c.type] || 'General';
      return fmt === 'General' ? 0 : styles.forFormat(fmt);
    });
    const letters = cols.map((_, i) => colName(i));
    const widths = cols.map((c) => Math.max(String(c.label ?? c.key ?? '').length + 3, 6));

    const out = [];
    // hlavička
    out.push('<row r="1">');
    cols.forEach((c, i) => {
      const label = String(c.label ?? c.key ?? '');
      out.push(`<c r="${letters[i]}1" t="s" s="${styles.header}"><v>${sstIndex(sanitizeText(label))}</v></c>`);
    });
    out.push('</row>');

    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri] || {};
      const rn = ri + 2;
      out.push(`<row r="${rn}">`);
      for (let ci = 0; ci < cols.length; ci++) {
        const c = cols[ci];
        const raw = typeof c.get === 'function' ? c.get(row) : row[c.key];
        const xml = cellXml(`${letters[ci]}${rn}`, raw, c.type, colStyle[ci]);
        if (xml) {
          out.push(xml);
          if (ri < 500) {
            const w = displayLength(raw, c.type);
            if (w + 2 > widths[ci]) widths[ci] = w + 2;
          }
        }
      }
      out.push('</row>');
    }

    function cellXml(ref, v, type, style) {
      if (v === undefined || v === null || v === '') return '';
      const s = style ? ` s="${style}"` : '';
      if (typeof v === 'boolean') return `<c r="${ref}" t="b"${s}><v>${v ? 1 : 0}</v></c>`;
      if (type === 'date' || v instanceof Date) {
        const d = toSerial(v, tz);
        if (d) {
          const st = style || (d.time ? dateTimeStyle : dateStyle);
          return `<c r="${ref}" s="${st}"><v>${numStr(d.serial)}</v></c>`;
        }
        if (v instanceof Date) return '';
      }
      if (typeof v === 'number' || typeof v === 'bigint') {
        const n = Number(v);
        if (!Number.isFinite(n)) return '';
        return `<c r="${ref}"${s}><v>${numStr(n)}</v></c>`;
      }
      let str = typeof v === 'object' ? JSON.stringify(v) : String(v);
      if ((type === 'number' || type === 'money' || type === 'percent') && NUMERIC_RE.test(str.trim())) {
        return `<c r="${ref}"${s}><v>${numStr(Number(str.trim()))}</v></c>`;
      }
      str = sanitizeText(str);
      if (str === '') return '';
      return `<c r="${ref}" t="s"${s}><v>${sstIndex(str)}</v></c>`;
    }

    const lastCol = letters.length ? letters[letters.length - 1] : 'A';
    const lastRow = rows.length + 1;
    const ref = `A1:${lastCol}${lastRow}`;
    const colsXml = cols.length
      ? '<cols>' +
        cols
          .map((c, i) => {
            const w = c.width > 0 ? c.width : Math.min(Math.max(widths[i], 8), 60);
            return `<col min="${i + 1}" max="${i + 1}" width="${Math.round(w * 100) / 100}" customWidth="1"/>`;
          })
          .join('') +
        '</cols>'
      : '';
    const xml =
      XML_DECL +
      `<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
      `<dimension ref="${cols.length ? ref : 'A1'}"/>` +
      `<sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ''}>` +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      colsXml +
      `<sheetData>${out.join('')}</sheetData>` +
      (cols.length ? `<autoFilter ref="${ref}"/>` : '') +
      '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
      '</worksheet>';
    files.push({ name: `xl/worksheets/sheet${si + 1}.xml`, data: xml });
    if (cols.length) {
      const quoted = `'${names[si].replace(/'/g, "''")}'`;
      definedNames.push(
        `<definedName name="_xlnm._FilterDatabase" localSheetId="${si}" hidden="1">${escapeXml(`${quoted}!$A$1:$${lastCol}$${lastRow}`)}</definedName>`
      );
    }
  });

  const sstXml =
    XML_DECL +
    `<sst xmlns="${MAIN_NS}" count="${sstCount}" uniqueCount="${sst.size}">` +
    [...sst.keys()].map((s) => `<si><t xml:space="preserve">${escapeXml(escapeOoxmlText(s))}</t></si>`).join('') +
    '</sst>';

  const workbookXml =
    XML_DECL +
    `<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    '<workbookPr/>' +
    '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="15000" activeTab="0"/></bookViews>' +
    '<sheets>' +
    names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    '</sheets>' +
    (definedNames.length ? `<definedNames>${definedNames.join('')}</definedNames>` : '') +
    '<calcPr calcId="191029"/>' +
    '</workbook>';

  const n = names.length;
  const wbRels =
    XML_DECL +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    names
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
      )
      .join('') +
    `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    '</Relationships>';

  const rootRels =
    XML_DECL +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';

  const created = (opts.date ? new Date(opts.date) : new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const coreXml =
    XML_DECL +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:creator>${escapeXml(opts.creator || 'Cenotvorba')}</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>` +
    '</cp:coreProperties>';
  const appXml =
    XML_DECL +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Cenotvorba</Application></Properties>';

  const contentTypes =
    XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    names
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      )
      .join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';

  return writeZip(
    [
      { name: '[Content_Types].xml', data: contentTypes },
      { name: '_rels/.rels', data: rootRels },
      { name: 'docProps/core.xml', data: coreXml },
      { name: 'docProps/app.xml', data: appXml },
      { name: 'xl/workbook.xml', data: workbookXml },
      { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
      { name: 'xl/styles.xml', data: styles.toXml() },
      { name: 'xl/sharedStrings.xml', data: sstXml },
      ...files,
    ],
    { date: opts.date }
  );
}

const INVALID_XML_CHARS = /[^\t\n\r\x20-퟿-�\u{10000}-\u{10FFFF}]/gu;

function sanitizeText(s) {
  let out = s.replace(INVALID_XML_CHARS, '');
  if (out.length > MAX_CELL_CHARS) out = out.slice(0, MAX_CELL_CHARS);
  return out;
}

function displayLength(v, type) {
  if (v == null) return 0;
  if (typeof v === 'number') {
    if (type === 'money') return Math.round(v).toLocaleString('cs-CZ').length + 1;
    return String(Math.round(v * 100) / 100).length;
  }
  if (type === 'date' || v instanceof Date) return 16;
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  let max = 0;
  for (const line of s.split('\n')) if (line.length > max) max = line.length;
  return max;
}

module.exports = { readXlsx, writeXlsx, serialToIso, classifyFormat, colName, colIndex };
