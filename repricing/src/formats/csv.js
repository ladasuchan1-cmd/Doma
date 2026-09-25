'use strict';
// CSV bez závislostí: čtení (RFC 4180, autodetekce oddělovače, CZ Excel styl se středníkem) a zápis pro Excel.

const { decodeBuffer } = require('./decode');

const DELIMITERS = [';', ',', '\t', '|'];

/**
 * Normalizuje hlavičky (sdíleno s XLSX): ořízne bílé znaky a BOM, víceřádkovou hlavičku spojí mezerou,
 * prázdnou nahradí `col_N` (N = pořadí sloupce od 1), duplicitní přejmenuje na `název_2`, `název_3` …
 * @param {Array<*>} cells
 * @returns {string[]}
 */
function normalizeHeaders(cells) {
  const used = new Set();
  const out = [];
  for (let i = 0; i < cells.length; i++) {
    out.push(uniqueHeader(headerText(cells[i]), i, used));
  }
  return out;
}

function headerText(v) {
  if (v == null) return '';
  return String(v)
    .replace(/^﻿/, '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
}

function uniqueHeader(name, index, used) {
  let base = name || `col_${index + 1}`;
  let cand = base;
  for (let n = 2; used.has(cand); n++) cand = `${base}_${n}`;
  used.add(cand);
  return cand;
}

/**
 * Rozdělí text na záznamy (pole buněk). Uvozovky podle RFC 4180 („""“ = uvozovka, nové řádky uvnitř uvozovek),
 * konce řádků \r\n, \n i \r. Neukončené uvozovky se tolerují – uvozovka se pak bere doslova (žádná data se neztratí).
 * @param {string} str
 * @param {string} delim
 * @param {number} start offset
 * @param {number} maxRecords max. počet záznamů (Infinity = vše)
 * @param {(cells: string[]) => void} onRecord
 */
function parseRecords(str, delim, start, maxRecords, onRecord) {
  const len = str.length;
  const dc = delim.charCodeAt(0);
  let i = start;
  let row = [];
  let count = 0;
  while (i < len && count < maxRecords) {
    let c = str.charCodeAt(i);
    let val;
    if (c === 34 /* " */) {
      let j = i + 1;
      let acc = '';
      let closed = false;
      for (;;) {
        const q = str.indexOf('"', j);
        if (q === -1) break;
        if (str.charCodeAt(q + 1) === 34) {
          acc += str.slice(j, q + 1);
          j = q + 2;
          continue;
        }
        acc += str.slice(j, q);
        j = q + 1;
        closed = true;
        break;
      }
      if (closed) {
        // znaky mezi uzavírací uvozovkou a oddělovačem (nestandardní) připojíme doslova
        let k = j;
        while (k < len) {
          const ch = str.charCodeAt(k);
          if (ch === dc || ch === 10 || ch === 13) break;
          k++;
        }
        if (k > j) acc += str.slice(j, k);
        val = acc;
        i = k;
      } else {
        // neukončené uvozovky → pole čteme jako neuvozované
        let k = i + 1;
        while (k < len) {
          const ch = str.charCodeAt(k);
          if (ch === dc || ch === 10 || ch === 13) break;
          k++;
        }
        val = str.slice(i, k);
        i = k;
      }
    } else {
      let k = i;
      while (k < len) {
        const ch = str.charCodeAt(k);
        if (ch === dc || ch === 10 || ch === 13) break;
        k++;
      }
      val = str.slice(i, k);
      i = k;
    }
    row.push(val);
    if (i >= len) break;
    c = str.charCodeAt(i);
    if (c === dc) {
      i++;
      if (i >= len) row.push(''); // oddělovač na úplném konci → prázdná poslední buňka
      continue;
    }
    // konec řádku
    i++;
    if (c === 13 && str.charCodeAt(i) === 10) i++;
    onRecord(row);
    count++;
    row = [];
  }
  if (row.length && count < maxRecords) onRecord(row);
  return i;
}

/** Offset začátku n-tého fyzického řádku (od 1). */
function lineOffset(str, lineNo) {
  let i = 0;
  for (let n = 1; n < lineNo; n++) {
    const a = str.indexOf('\n', i);
    const b = str.indexOf('\r', i);
    if (a === -1 && b === -1) return str.length;
    if (b !== -1 && (a === -1 || b < a)) i = str.charCodeAt(b + 1) === 10 ? b + 2 : b + 1;
    else i = a + 1;
  }
  return i;
}

function isEmptyRecord(cells) {
  for (let i = 0; i < cells.length; i++) if (cells[i].trim() !== '') return false;
  return true;
}

/**
 * Autodetekce oddělovače mezi ; , TAB | – podle konzistence počtu polí na prvních 20 neprázdných záznamech
 * (od začátku textu). Při shodě vyhrává více sloupců, pak pořadí ; , TAB |.
 * @param {string} str text od řádku s hlavičkou
 * @returns {string}
 */
function detectDelimiter(str) {
  const sample = str.length > 256 * 1024 ? str.slice(0, 256 * 1024) : str;
  let best = null;
  for (let di = 0; di < DELIMITERS.length; di++) {
    const d = DELIMITERS[di];
    if (sample.indexOf(d) === -1) continue;
    const recs = [];
    parseRecords(sample, d, 0, 200, (r) => {
      if (recs.length < 20 && !isEmptyRecord(r)) recs.push(r);
    });
    if (!recs.length) continue;
    const n0 = recs[0].length;
    if (n0 < 2) continue;
    let ok = 0;
    for (const r of recs) {
      if (r.length === n0) ok++;
      else if (r.length > n0 && r.slice(n0).every((c) => c.trim() === '')) ok++;
      else if (r.length < n0 && r === recs[recs.length - 1]) ok += 0.5; // poslední (možná useknutý) záznam vzorku
    }
    const score = ok / recs.length;
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && n0 > best.n0)) best = { d, score, n0 };
  }
  return best ? best.d : ';';
}

/**
 * Přečte CSV.
 * @param {string|Buffer} str text (Buffer se dekóduje přes decodeBuffer – i windows-1250)
 * @param {{delimiter?: string, headerRow?: number, skipEmpty?: boolean, encoding?: string}} [opts]
 *   headerRow = řádek s hlavičkou (od 1; řádky před ním se přeskočí). Počítají se fyzické řádky, stejně jako v Excelu.
 *   Je-li řádek hlavičky prázdný, použije se první neprázdný řádek za ním.
 * @returns {{headers: string[], rows: object[], delimiter: string}}
 */
function parseCsv(str, opts = {}) {
  let s = typeof str === 'string' ? str : decodeBuffer(str, { encoding: opts.encoding });
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  // Excel: první řádek „sep=;“ určuje oddělovač a není součástí dat (do headerRow se nepočítá)
  let sepHint = null;
  const sep = /^sep=(.)[ \t]*(\r\n|\n|\r|$)/.exec(s.slice(0, 16));
  if (sep) {
    sepHint = sep[1];
    s = s.slice(sep[0].length);
  }
  const headerRow = Math.max(1, parseInt(opts.headerRow ?? opts.header_row ?? 1, 10) || 1);
  const skipEmpty = opts.skipEmpty !== false;
  // prázdné řádky na místě hlavičky přeskočí parseRecords níže (hlavičkou je první neprázdný záznam)
  const start = lineOffset(s, headerRow);
  let delimiter = opts.delimiter || sepHint;
  if (delimiter === 'tab' || delimiter === '\\t') delimiter = '\t';
  if (!delimiter || delimiter === 'auto') delimiter = detectDelimiter(s.slice(start, start + 256 * 1024));
  if (delimiter.length !== 1) throw new Error(`Oddělovač CSV musí být jeden znak (zadáno „${delimiter}“)`);

  let headers = null;
  let nh = 0;
  const used = new Set();
  const rows = [];
  let pendingEmpty = 0; // prázdné řádky se při skipEmpty=false přidají až když za nimi něco je (koncové se zahodí)
  parseRecords(s, delimiter, start, Infinity, (cells) => {
    if (headers === null) {
      if (isEmptyRecord(cells)) return;
      headers = normalizeHeaders(cells);
      nh = headers.length;
      for (const h of headers) used.add(h);
      return;
    }
    const empty = isEmptyRecord(cells);
    if (empty) {
      if (!skipEmpty) pendingEmpty++;
      return;
    }
    while (pendingEmpty > 0) {
      const o = {};
      for (let k = 0; k < nh; k++) setOwn(o, headers[k], '');
      rows.push(o);
      pendingEmpty--;
    }
    const o = {};
    const n = cells.length;
    for (let k = 0; k < nh; k++) setOwn(o, headers[k], k < n ? cells[k] : '');
    // buňky za posledním sloupcem hlavičky: neprázdné dostanou vlastní sloupec col_N (data se neztratí)
    for (let k = nh; k < n; k++) {
      if (cells[k].trim() === '') continue;
      while (headers.length <= k) {
        const idx = headers.length;
        headers.push(uniqueHeader('', idx, used));
      }
      setOwn(o, headers[k], cells[k]);
    }
    rows.push(o);
  });
  if (headers && headers.length > nh) fillMissing(rows, headers, nh);
  return { headers: headers || [], rows, delimiter };
}

/** Když přibyly sloupce col_N až během čtení, doplní je do dřívějších řádků jako '' (všechny řádky mají stejné klíče). */
function fillMissing(rows, headers, from) {
  for (const r of rows) {
    for (let k = from; k < headers.length; k++) if (!Object.hasOwn(r, headers[k])) setOwn(r, headers[k], '');
  }
}

function setOwn(obj, key, value) {
  if (key === '__proto__') Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  else obj[key] = value;
}

function formatNumber(n, decimal) {
  if (!Number.isFinite(n)) return '';
  let s = String(n);
  if (/e/i.test(s)) {
    // bez exponentu (1e21 apod.); malá čísla s dostatečnou přesností
    s = Math.abs(n) >= 1 ? BigInt(Math.round(n)).toString() : n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
  }
  return decimal === '.' ? s : s.replace('.', decimal);
}

/**
 * Zapíše CSV přátelské k českému Excelu: středník, desetinná čárka, BOM, CRLF, uvozovky jen když je potřeba.
 * null/undefined → prázdná buňka, boolean → 1/0, Date → ISO, objekt/pole → JSON.
 * @param {object[]} rows
 * @param {Array<{key: string, label?: string}>} [columns] výchozí = klíče prvního řádku
 * @param {{delimiter?: string, bom?: boolean, decimal?: string, newline?: string, header?: boolean}} [opts]
 * @returns {string}
 */
function toCsv(rows, columns, opts = {}) {
  const delimiter = opts.delimiter ?? ';';
  const bom = opts.bom !== false;
  const decimal = opts.decimal ?? ',';
  const nl = opts.newline ?? '\r\n';
  rows = rows || [];
  if (!columns || !columns.length) {
    const keys = new Set();
    for (const r of rows.slice(0, 1000)) for (const k of Object.keys(r || {})) keys.add(k);
    columns = [...keys].map((key) => ({ key }));
  }
  const cols = columns.map((c) => (typeof c === 'string' ? { key: c } : c));
  const needs = new RegExp(`[${escapeRe(delimiter)}"\\r\\n]|^\\s|\\s$`);
  const cell = (v) => {
    let s;
    if (v == null) return '';
    if (typeof v === 'number') s = formatNumber(v, decimal);
    else if (typeof v === 'boolean') s = v ? '1' : '0';
    else if (typeof v === 'bigint') s = v.toString();
    else if (v instanceof Date) s = Number.isNaN(v.getTime()) ? '' : v.toISOString();
    else if (typeof v === 'object') s = JSON.stringify(v);
    else s = String(v);
    return needs.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [];
  if (opts.header !== false) lines.push(cols.map((c) => cell(c.label ?? c.key)).join(delimiter));
  for (const r of rows) {
    const row = r || {};
    lines.push(cols.map((c) => cell(typeof c.get === 'function' ? c.get(row) : row[c.key])).join(delimiter));
  }
  return (bom ? '﻿' : '') + lines.join(nl) + (lines.length ? nl : '');
}

function escapeRe(s) {
  return s.replace(/[\\^$.*+?()[\]{}|-]/g, '\\$&');
}

module.exports = { parseCsv, toCsv, detectDelimiter, normalizeHeaders, fillMissing };
