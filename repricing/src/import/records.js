'use strict';
// Načtení záznamů ze vstupu (JSON / XML / CSV / XLSX) a jejich zploštění na tečkové klíče (SPEC §5 records.js).
//
//  - JSON: pole na mapping.item_path, kořenové pole, první neprázdné pole objektů (do šířky), jinak jeden objekt.
//          Neplatný JSON zkusí ještě NDJSON (jeden objekt na řádek).
//  - XML:  proudově přes streamRecords (item_path nebo detectItemPath).
//  - CSV / XLSX: řádky jako objekty podle hlavičky.
//  - gzip se rozbalí; ZIP bez sešitu Excelu s jedním datovým souborem se rozbalí také.
//  - Zploštění: `a.b.c`, atributy `@x`, text elementu s atributy pod klíčem elementu, pole primitiv spojená „|“,
//    páry název–hodnota (Heureka PARAM{PARAM_NAME, VAL}, <param name="Barva">…</param>) jako `PARAM.Barva`.
//  - Vnořené nabídky: pole objektů s cenou (nebo mapping.offers_path) → každý prvek je samostatný řádek,
//    zdědí pole rodiče; klíče potomka jsou jako `<offers_path>.<klíč>` i jako holé `<klíč>` (potomek vyhrává).

const zlib = require('node:zlib');
const formats = require('../formats');
const { ImportError, keyForms } = require('./mapping');

const MAX_UNZIPPED = 600 * 1024 * 1024;
const HEADER_SAMPLE = 1000;
const OFFERS_SCAN = 200;
// Nejvyšší povolené zanoření záznamu při zploštění. Rekurze v flattenInto by na patologicky zanořeném JSONu
// (např. 5 000× „[“) přetekla zásobník (RangeError → HTTP 500); XML parser má vlastní limit 1 000 úrovní.
// Skutečná data mají jednotky až desítky úrovní.
const MAX_FLATTEN_DEPTH = 200;

const FORMAT_LABELS = { json: 'JSON', xml: 'XML', csv: 'CSV', xlsx: 'XLSX' };

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Date);
}

function isPrimitive(v) {
  return v === null || v === undefined || typeof v !== 'object' || v instanceof Date;
}

function setOwn(obj, key, value) {
  if (key === '__proto__') Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  else obj[key] = value;
}

function primitiveValue(v) {
  if (v instanceof Date) return v.toISOString();
  return v === undefined ? null : v;
}

// --- páry název/hodnota (Heureka PARAM) ------------------------------------------------------------------

const PAIR_NAME_KEYS = new Set(['param_name', 'paramname', 'name', 'nazev', 'key', '@name', 'attribute_name', 'attributename', 'label']);
const PAIR_VALUE_KEYS = new Set(['val', 'value', 'hodnota', '#text', 'attribute_value', 'attributevalue']);
const PAIR_EXTRA_KEYS = new Set(['unit', '@unit', 'jednotka', 'units']);

/** Vrátí [jméno, hodnota] pro objekt typu {PARAM_NAME: 'Barva', VAL: 'černá'}, jinak null. */
function pairOf(o) {
  let name;
  let value;
  let n = 0;
  for (const k in o) {
    if (!Object.hasOwn(o, k)) continue;
    n++;
    if (n > 3) return null;
    const lk = k.toLowerCase();
    const v = o[k];
    if (name === undefined && PAIR_NAME_KEYS.has(lk)) {
      if (!isPrimitive(v) || v === null || String(v).trim() === '') return null;
      name = String(v).trim();
    } else if (value === undefined && PAIR_VALUE_KEYS.has(lk)) {
      if (!isPrimitive(v)) return null;
      value = v;
    } else if (!PAIR_EXTRA_KEYS.has(lk)) return null;
  }
  if (name === undefined || value === undefined) return null;
  return [name, value];
}

// --- zploštění --------------------------------------------------------------------------------------------

function put(out, key, value) {
  if (Object.hasOwn(out, key)) {
    const prev = out[key];
    if (prev === null || prev === '') setOwn(out, key, value);
    else if (value !== null && value !== '') setOwn(out, key, `${prev}|${value}`);
  } else setOwn(out, key, value);
}

function flattenInto(out, value, path, depth = 0) {
  if (depth > MAX_FLATTEN_DEPTH) {
    throw new ImportError(`Záznam je příliš hluboko zanořený (více než ${MAX_FLATTEN_DEPTH} úrovní) – zkontrolujte strukturu souboru.`, { code: 'IMPORT_TOO_DEEP' });
  }
  if (isPrimitive(value)) {
    setOwn(out, path || 'value', primitiveValue(value));
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      if (path) setOwn(out, path, '');
      return;
    }
    let allPrim = true;
    for (let i = 0; i < value.length; i++) {
      if (!isPrimitive(value[i])) {
        allPrim = false;
        break;
      }
    }
    if (allPrim) {
      if (value.length === 1) setOwn(out, path || 'value', primitiveValue(value[0]));
      else setOwn(out, path || 'value', value.map((x) => (x == null ? '' : String(primitiveValue(x)))).join('|'));
      return;
    }
    if (value.length === 1) {
      flattenInto(out, value[0], path, depth + 1);
      return;
    }
    // páry název–hodnota
    if (path && value.every((x) => isPlain(x) && pairOf(x))) {
      for (const x of value) {
        const [name, v] = pairOf(x);
        put(out, `${path}.${name}`, primitiveValue(v));
      }
      return;
    }
    // pole objektů → každý podklíč jako hodnoty spojené „|“ (zarovnané podle pořadí prvků)
    const subs = value.map((x) => {
      const o = {};
      flattenInto(o, x, '', depth + 1);
      return o;
    });
    const keys = [];
    const seen = new Set();
    for (const s of subs)
      for (const k of Object.keys(s))
        if (!seen.has(k)) {
          seen.add(k);
          keys.push(k);
        }
    for (const k of keys) {
      const full = path ? (k === 'value' ? path : `${path}.${k}`) : k;
      setOwn(out, full, subs.map((s) => (s[k] == null ? '' : String(s[k]))).join('|'));
    }
    return;
  }
  // objekt
  if (path) {
    const pair = pairOf(value);
    if (pair) {
      put(out, `${path}.${pair[0]}`, primitiveValue(pair[1]));
      return;
    }
  }
  let any = false;
  for (const k in value) {
    if (!Object.hasOwn(value, k)) continue;
    any = true;
    const v = value[k];
    if (k === '#text') {
      setOwn(out, path || '#text', primitiveValue(v));
      continue;
    }
    flattenInto(out, v, path ? `${path}.${k}` : k, depth + 1);
  }
  if (!any && path) setOwn(out, path, '');
}

/**
 * Zploští záznam na tečkové klíče.
 * @param {*} record
 * @returns {object}
 */
function flattenRecord(record) {
  const out = {};
  if (isPlain(record)) flattenInto(out, record, '');
  else if (Array.isArray(record)) flattenInto(out, record, 'value');
  else setOwn(out, 'value', primitiveValue(record));
  return out;
}

// --- cesty ------------------------------------------------------------------------------------------------

function splitPath(p) {
  return String(p)
    .trim()
    .replace(/^\$\.?/, '')
    .replace(/\[\*?\]/g, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split(/[./]/)
    .filter(Boolean);
}

function getPath(obj, segs) {
  let cur = obj;
  for (const s of segs) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(s)) return undefined;
      cur = cur[Number(s)];
    } else if (typeof cur === 'object') {
      if (!Object.hasOwn(cur, s)) return undefined;
      cur = cur[s];
    } else return undefined;
  }
  return cur;
}

/** Kopie objektu bez hodnoty na cestě (pro dědění polí rodiče). */
function withoutPath(obj, segs) {
  if (!isPlain(obj) || !segs.length) return obj;
  const out = {};
  for (const k in obj) {
    if (!Object.hasOwn(obj, k)) continue;
    if (k === segs[0]) {
      if (segs.length > 1 && isPlain(obj[k])) {
        const rest = withoutPath(obj[k], segs.slice(1));
        // prázdný obal (<OFFERS> bez ničeho dalšího) se nevrací jako prázdný sloupec
        if (Object.keys(rest).length) setOwn(out, k, rest);
      }
      continue;
    }
    setOwn(out, k, obj[k]);
  }
  return out;
}

// --- vnořené nabídky ----------------------------------------------------------------------------------------

const PRICE_LIKE = new Set([
  'price', 'pricevat', 'pricewithvat', 'priceinclvat', 'priceincvat', 'pricegross', 'cena', 'cenasdph', 'cenavcdph', 'cenavcetnedph', 'prodejnicena',
  'sellingprice', 'offerprice', 'competitorprice', 'cenakonkurence', 'currentprice',
]);
const ID_LIKE = new Set(['code', 'kod', 'sku', 'ean', 'gtin', 'itemid', 'id', 'productno', 'mpn', 'productcode']);
// pole, která nejsou nabídkami ani variantami (doprava, splátky, daně)
const NOT_OFFERS = /shipping|delivery|doprav|postovn|installment|splatk|tax|dph|vat|discount|sleva|bundle/;

function hasKeyLike(o, set) {
  for (const k in o) {
    if (!Object.hasOwn(o, k)) continue;
    const f = keyForms(k);
    if (f && set.has(f.last)) return true;
  }
  return false;
}

/** Najde cesty polí objektů, jejichž prvky obsahují cenu (případně i identifikátor). */
function collectOfferPaths(value, path, paths, needId, depth) {
  if (depth > 8 || !isPlain(value)) return;
  for (const k in value) {
    if (!Object.hasOwn(value, k)) continue;
    const v = value[k];
    const p = path ? `${path}.${k}` : k;
    if (Array.isArray(v)) {
      const f = keyForms(p);
      if (f && NOT_OFFERS.test(f.full)) continue;
      const objs = v.filter(isPlain);
      if (objs.length && objs.some((o) => hasKeyLike(o, PRICE_LIKE) && (!needId || hasKeyLike(o, ID_LIKE)))) paths.add(p);
    } else if (isPlain(v)) collectOfferPaths(v, p, paths, needId, depth + 1);
  }
}

function detectOffersPath(records, kind) {
  const paths = new Set();
  const n = Math.min(records.length, OFFERS_SCAN);
  for (let i = 0; i < n; i++) collectOfferPaths(records[i], '', paths, kind === 'products', 0);
  return paths.size === 1 ? [...paths][0] : null;
}

const COMPETITOR_ELEMENT = /^(competitor|konkurent|shop|eshop|seller|obchod|retailer|merchant|store|prodejce)$/;

/**
 * Rozloží záznam s vnořenými nabídkami na řádky.
 * @param {object} record surový záznam (před zploštěním)
 * @param {string[]} segs cesta k poli nabídek
 * @param {string} offersPath
 * @param {string|null} kind
 * @param {string|null} elementName název XML elementu záznamu (pro `competitor.@name`)
 * @param {(flat: object) => void} emit
 */
function explodeRecord(record, segs, offersPath, kind, elementName, emit) {
  const v = isPlain(record) ? getPath(record, segs) : undefined;
  let children;
  if (Array.isArray(v)) children = v.filter(isPlain);
  else if (isPlain(v)) children = [v];
  else children = [];
  if (!children.length) {
    // nabídky: záznam bez nabídek nic nepřináší; produkty/varianty: rodič zůstane jako řádek
    if (kind === 'offers') return 0;
    emit(flattenRecord(record));
    return 1;
  }
  const parent = flattenRecord(withoutPath(record, segs));
  // atributy elementu záznamu (např. <competitor name="X"> s vnořenými nabídkami) i jako `competitor.@name`
  if (elementName && COMPETITOR_ELEMENT.test(String(elementName).toLowerCase())) {
    for (const k of Object.keys(parent)) if (k.startsWith('@')) setOwn(parent, `${elementName}.${k}`, parent[k]);
  }
  for (const child of children) {
    const c = flattenRecord(child);
    const row = { ...parent };
    for (const k in c) setOwn(row, `${offersPath}.${k}`, c[k]);
    for (const k in c) setOwn(row, k, c[k]);
    emit(row);
  }
  return children.length;
}

// --- vstup ------------------------------------------------------------------------------------------------

function isGzip(buf) {
  return Buffer.isBuffer(buf) && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function gunzip(buf) {
  try {
    return zlib.gunzipSync(buf, { maxOutputLength: MAX_UNZIPPED });
  } catch (e) {
    throw new ImportError(`Soubor gzip nelze rozbalit: ${e.message}`, { code: 'GZIP_INVALID' });
  }
}

function normalizeInput(input) {
  if (input == null) throw new ImportError('Chybí vstupní data.', { code: 'EMPTY_INPUT' });
  if (Buffer.isBuffer(input)) return { buffer: input };
  if (typeof input === 'string') return { text: input };
  if (input instanceof Uint8Array) return { buffer: Buffer.from(input.buffer, input.byteOffset, input.byteLength) };
  if (typeof input !== 'object') throw new ImportError('Neplatný vstup importu.', { code: 'EMPTY_INPUT' });
  const out = { ...input };
  if (out.buffer && !Buffer.isBuffer(out.buffer)) {
    if (out.buffer instanceof Uint8Array) out.buffer = Buffer.from(out.buffer.buffer, out.buffer.byteOffset, out.buffer.byteLength);
    else if (out.buffer instanceof ArrayBuffer) out.buffer = Buffer.from(out.buffer);
  }
  return out;
}

function wrapFormatError(e, format) {
  if (e instanceof ImportError) return e;
  const label = FORMAT_LABELS[format];
  const details = e && e.line != null ? { line: e.line, column: e.column } : e && e.code ? { code: e.code } : undefined;
  const msg = e && e.message ? e.message : String(e);
  return new ImportError(label ? `Soubor nelze načíst jako ${label}: ${msg}` : msg, { code: (e && e.code) || 'FORMAT_INVALID', details });
}

const DATA_EXT = /\.(xml|csv|tsv|txt|json|ndjson|jsonl|xlsx)$/i;

/** ZIP, který není sešitem Excelu: vezme jediný (nebo první) datový soubor uvnitř. */
function unzipDataFile(buf) {
  let entries;
  try {
    entries = formats.readZip(buf);
  } catch (e) {
    throw wrapFormatError(e, 'xlsx');
  }
  if (entries.has('xl/workbook.xml') || entries.has('[Content_Types].xml')) return null;
  const names = [...entries.keys()].filter((n) => !n.endsWith('/') && !/(^|\/)(__MACOSX|\.)/.test(n) && DATA_EXT.test(n));
  if (!names.length) throw new ImportError('Archiv ZIP neobsahuje sešit Excelu ani datový soubor (XML/CSV/JSON).', { code: 'ZIP_NO_DATA' });
  const name = names[0];
  return { buffer: entries.get(name)(), filename: name.split('/').pop() };
}

// --- JSON ---------------------------------------------------------------------------------------------------

function parseJsonText(text) {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(t);
  } catch (e) {
    // NDJSON / JSON Lines
    const lines = t.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length > 1 && lines.every((l) => /^\s*[{[]/.test(l))) {
      try {
        return lines.map((l) => JSON.parse(l));
      } catch {
        /* níže */
      }
    }
    throw new ImportError(`Neplatný JSON: ${e.message}`, { code: 'JSON_INVALID' });
  }
}

function locateJsonRecords(root, itemPath) {
  if (itemPath) {
    const segs = splitPath(itemPath);
    const v = segs.length ? getPath(root, segs) : root;
    if (v === undefined) throw new ImportError(`Cesta k záznamům „${itemPath}“ v JSON neexistuje.`, { code: 'ITEM_PATH_NOT_FOUND' });
    return { records: Array.isArray(v) ? v : [v], itemPath: segs.join('.') || null, segs };
  }
  if (Array.isArray(root)) return { records: root, itemPath: null, segs: [] };
  if (!isPlain(root)) return { records: [root], itemPath: null, segs: [] };
  // do šířky: první neprázdné pole objektů, jinak první neprázdné pole, jinak objekt sám
  const queue = [{ value: root, segs: [] }];
  let anyArray = null;
  for (let qi = 0; qi < queue.length && qi < 10000; qi++) {
    const { value, segs } = queue[qi];
    for (const k in value) {
      if (!Object.hasOwn(value, k)) continue;
      const v = value[k];
      const s = [...segs, k];
      if (Array.isArray(v)) {
        if (v.length && v.some(isPlain)) return { records: v, itemPath: s.join('.'), segs: s };
        if (v.length && !anyArray) anyArray = { records: v, itemPath: s.join('.'), segs: s };
      } else if (isPlain(v)) queue.push({ value: v, segs: s });
    }
  }
  if (anyArray) return anyArray;
  return { records: [root], itemPath: null, segs: [] };
}

/** Pole polí s hlavičkou v prvním řádku ([["ean","cena"],["859…",100]]) → objekty. */
function arrayRowsToObjects(records) {
  if (records.length < 2 || !records.every(Array.isArray)) return records;
  const head = records[0];
  if (!head.length || !head.every((h) => typeof h === 'string')) return records;
  const headers = formats.normalizeHeaders(head);
  return records.slice(1).map((row) => {
    const o = {};
    for (let i = 0; i < headers.length; i++) setOwn(o, headers[i], i < row.length ? row[i] : '');
    return o;
  });
}

/** Primitivní hodnoty kořene (mimo pole záznamů) – dědí je nabídky ({shop: 'X', items: [...]}). */
function rootContext(root, segs) {
  if (!isPlain(root) || !segs.length) return null;
  const flat = flattenRecord(withoutPath(root, segs));
  const out = {};
  let n = 0;
  for (const k of Object.keys(flat)) {
    const v = flat[k];
    if (v === null || v === '' || (typeof v === 'string' && v.length > 200)) continue;
    setOwn(out, k, v);
    if (++n >= 50) break;
  }
  return n ? out : null;
}

// --- XML ----------------------------------------------------------------------------------------------------

/** Atributy kořenového elementu (<prices shop="X">) – dědí je nabídky. */
function xmlRootAttrs(text) {
  let attrs = null;
  const h = {
    stop: false,
    open(name, a) {
      attrs = a;
      h.stop = true;
    },
    close() {},
  };
  try {
    formats.tokenizeXml(text.length > 65536 ? text.slice(0, 65536) : text, h, { partial: true });
  } catch {
    return null;
  }
  if (!attrs) return null;
  const out = {};
  let n = 0;
  for (const k of Object.keys(attrs)) {
    if (/^xmlns(:|$)/.test(k) || /^(xsi:)?schemaLocation$/.test(k) || k === 'version') continue;
    setOwn(out, '@' + k, attrs[k]);
    n++;
  }
  return n ? out : null;
}

// --- hlavní funkce ---------------------------------------------------------------------------------------

/**
 * Načte záznamy ze vstupu.
 * @param {{buffer?: Buffer, text?: string, contentType?: string, filename?: string, records?: object[]}|Buffer|string} input
 *   records = už načtené objekty (např. JSON tělo API) – jen se zploští
 * @param {object} [mapping] {format, item_path, offers_path, csv: {delimiter, decimal, encoding, header_row}, xlsx: {sheet, header_row}, encoding}
 * @param {{kind?: 'products'|'offers', limit?: number}} [opts] kind ovlivní vnořené nabídky a dědění z kořene;
 *   limit = max. počet zdrojových záznamů (náhled)
 * @returns {{format: string, itemPath: string|null, offersPath: string|null, records: object[], headers: string[], truncated: boolean}}
 */
function extractRecords(input, mapping = {}, opts = {}) {
  const m = mapping && typeof mapping === 'object' ? mapping : {};
  const kind = opts.kind || null;
  const limit = opts.limit > 0 ? opts.limit : Infinity;
  const inp = normalizeInput(input);
  let format;
  let itemPath = null;
  let source = []; // surové záznamy (před zploštěním) – JSON / XML
  let flatRows = null; // CSV / XLSX – už ploché
  let headers = null;
  let context = null;
  let elementName = null;
  let truncated = false;

  if (Array.isArray(inp.records)) {
    format = 'json';
    source = arrayRowsToObjects(inp.records);
  } else {
    let buffer = inp.buffer;
    let text = typeof inp.text === 'string' ? inp.text : null;
    const filename = inp.filename;
    if (buffer && isGzip(buffer)) buffer = gunzip(buffer);
    if (!buffer && text == null) throw new ImportError('Chybí vstupní data (buffer nebo text).', { code: 'EMPTY_INPUT' });
    if ((buffer && buffer.length === 0) || (text != null && text.trim() === '')) throw new ImportError('Soubor je prázdný.', { code: 'EMPTY_INPUT' });

    const wanted = m.format && m.format !== 'auto' ? String(m.format).toLowerCase() : null;
    const encoding = (m.csv && m.csv.encoding) || m.encoding || undefined;
    try {
      if (wanted) {
        format = { tsv: 'csv', txt: 'csv', ndjson: 'json', jsonl: 'json', xls: 'xlsx' }[wanted] || wanted;
        if (!FORMAT_LABELS[format]) throw new ImportError(`Neznámý formát „${m.format}“ (podporováno: json, xml, csv, xlsx).`, { code: 'UNSUPPORTED_FORMAT' });
      } else format = formats.detectFormat(buffer || text, { contentType: inp.contentType, filename });
    } catch (e) {
      throw wrapFormatError(e, 'auto');
    }
    if (format === 'xlsx' && buffer) {
      const inner = unzipDataFile(buffer);
      if (inner) {
        return extractRecords({ buffer: inner.buffer, filename: inner.filename }, m.format === 'xlsx' ? { ...m, format: 'auto' } : m, opts);
      }
    }
    if (format === 'xlsx') {
      if (!buffer) throw new ImportError('XLSX je binární formát – pošlete soubor jako Buffer, ne jako text.', { code: 'FORMAT_INVALID' });
      const x = m.xlsx || {};
      const headerRow = x.header_row ?? x.headerRow ?? (m.csv && m.csv.header_row) ?? undefined;
      try {
        const r = formats.readXlsx(buffer, { sheet: x.sheet === '' ? undefined : x.sheet, headerRow: headerRow ? Number(headerRow) : undefined });
        flatRows = r.rows;
        headers = r.headers;
      } catch (e) {
        throw wrapFormatError(e, 'xlsx');
      }
    } else {
      if (text == null) {
        try {
          text = formats.decodeBuffer(buffer, { encoding, contentType: inp.contentType });
        } catch (e) {
          throw wrapFormatError(e, format);
        }
      } else if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      if (format === 'csv') {
        const c = m.csv || {};
        const delimiter = wanted === 'tsv' ? '\t' : c.delimiter || undefined;
        try {
          const r = formats.parseCsv(text, { delimiter, headerRow: c.header_row ?? c.headerRow });
          flatRows = r.rows;
          headers = r.headers;
        } catch (e) {
          throw wrapFormatError(e, 'csv');
        }
      } else if (format === 'json') {
        const root = parseJsonText(text);
        const loc = locateJsonRecords(root, m.item_path);
        itemPath = loc.itemPath;
        source = arrayRowsToObjects(loc.records);
        if (kind === 'offers') context = rootContext(root, loc.segs);
      } else if (format === 'xml') {
        try {
          // bez nalezené cesty je záznamem celý kořenový element (dokument s jediným záznamem)
          itemPath = m.item_path || formats.detectItemPath(text) || null;
          const cnt = formats.streamRecords(text, { itemPath: itemPath || undefined, limit: Number.isFinite(limit) ? limit + 1 : undefined }, (rec) => {
            // atribut version (POHODA: <lStk:stock version="2.0">) je technický údaj, ne vlastnost položky
            if (rec && typeof rec === 'object' && Object.hasOwn(rec, '@version')) delete rec['@version'];
            source.push(rec);
          });
          if (m.item_path && cnt === 0) {
            throw new ImportError(`V XML nejsou žádné elementy na cestě „${m.item_path}“.`, { code: 'ITEM_PATH_NOT_FOUND' });
          }
        } catch (e) {
          throw wrapFormatError(e, 'xml');
        }
        const segs = String(itemPath || '').split(/[./]/).filter(Boolean);
        elementName = segs.length ? segs[segs.length - 1].replace(/^.*:/, '') : null;
        if (kind === 'offers' && segs.length > 1) context = xmlRootAttrs(text);
      }
    }
  }

  if (source.length > limit) {
    source = source.slice(0, limit);
    truncated = true;
  }
  if (flatRows && flatRows.length > limit) {
    flatRows = flatRows.slice(0, limit);
    truncated = true;
  }

  let records;
  let offersPath = null;
  if (flatRows) {
    records = flatRows;
  } else {
    records = [];
    const op = m.offers_path;
    if (op === false || op === 'none' || op === '') offersPath = null;
    else if (op && op !== 'auto') offersPath = splitPath(op).join('.');
    else offersPath = detectOffersPath(source, kind);
    const segs = offersPath ? offersPath.split('.') : null;
    const emit = context
      ? (row) => {
          const merged = { ...context };
          for (const k in row) setOwn(merged, k, row[k]);
          records.push(merged);
        }
      : (row) => records.push(row);
    for (const rec of source) {
      if (segs) explodeRecord(rec, segs, offersPath, kind, elementName, emit);
      else emit(flattenRecord(rec));
    }
  }

  if (!headers) {
    headers = [];
    const seen = new Set();
    const n = Math.min(records.length, HEADER_SAMPLE);
    for (let i = 0; i < n; i++) {
      for (const k in records[i]) {
        if (!seen.has(k)) {
          seen.add(k);
          headers.push(k);
        }
      }
    }
  }
  return { format, itemPath, offersPath, records, headers, truncated };
}

module.exports = { extractRecords, flattenRecord, detectOffersPath, splitPath, getPath };
