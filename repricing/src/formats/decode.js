'use strict';
// Dekódování bajtů na text (UTF-8/16, windows-1250, ISO-8859-2, windows-1252) a detekce formátu souboru.
// Bez závislostí – tabulky jednobajtových kódování jsou vlastní (neznámé bajty podle WHATWG → řídicí znak U+0080–U+009F,
// takže se nikdy nic neztratí). Česká data z POHODY/Excelu bývají ve windows-1250 – viz heuristika v decodeBuffer().

const { isUtf8, isAscii } = require('node:buffer');

// Horní polovina (0x80–0xFF) jednobajtových kódování. Ověřeno proti oficiálním mapám Unicode/WHATWG
// (python3 bytes(range(128,256)).decode('cp1250') a TextDecoder s full-ICU – viz test/formats-decode.test.js).
const HIGH = {
  'windows-1250':
    '€\u0081‚\u0083„…†‡\u0088‰Š‹ŚŤŽŹ' +
    '\u0090‘’“”•–—\u0098™š›śťžź' +
    ' ˇ˘Ł¤Ą¦§¨©Ş«¬­®Ż' +
    '°±˛ł´µ¶·¸ąş»Ľ˝ľż' +
    'ŔÁÂĂÄĹĆÇČÉĘËĚÍÎĎ' +
    'ĐŃŇÓÔŐÖ×ŘŮÚŰÜÝŢß' +
    'ŕáâăäĺćçčéęëěíîď' +
    'đńňóôőö÷řůúűüýţ˙',
  'iso-8859-2':
    '\u0080\u0081\u0082\u0083\u0084\u0085\u0086\u0087\u0088\u0089\u008A\u008B\u008C\u008D\u008E\u008F' +
    '\u0090\u0091\u0092\u0093\u0094\u0095\u0096\u0097\u0098\u0099\u009A\u009B\u009C\u009D\u009E\u009F' +
    ' Ą˘Ł¤ĽŚ§¨ŠŞŤŹ­ŽŻ' +
    '°ą˛ł´ľśˇ¸šşťź˝žż' +
    'ŔÁÂĂÄĹĆÇČÉĘËĚÍÎĎ' +
    'ĐŃŇÓÔŐÖ×ŘŮÚŰÜÝŢß' +
    'ŕáâăäĺćçčéęëěíîď' +
    'đńňóôőö÷řůúűüýţ˙',
  'windows-1252':
    '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F' +
    '\u0090‘’“”•–—˜™š›œ\u009DžŸ' +
    ' ¡¢£¤¥¦§¨©ª«¬­®¯' +
    '°±²³´µ¶·¸¹º»¼½¾¿' +
    'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏ' +
    'ÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞß' +
    'àáâãäåæçèéêëìíîï' +
    'ðñòóôõö÷øùúûüýþÿ',
};

// Úplné tabulky 256 kódových jednotek UTF-16 (0x00–0x7F = ASCII). Všechny znaky leží v BMP.
const TABLES = {};
for (const [name, high] of Object.entries(HIGH)) {
  if (high.length !== 128) throw new Error(`Chybná tabulka kódování ${name}`);
  const t = new Uint16Array(256);
  for (let i = 0; i < 128; i++) t[i] = i;
  for (let i = 0; i < 128; i++) t[128 + i] = high.charCodeAt(i);
  TABLES[name] = t;
}

// Aliasy názvů kódování → kanonický název.
const ALIASES = new Map(
  Object.entries({
    'utf-8': ['utf8', 'utf-8', 'unicode-1-1-utf-8', 'x-unicode20utf8'],
    'utf-16le': ['utf-16le', 'utf16le', 'utf-16', 'utf16', 'ucs-2', 'ucs2', 'unicode', 'csunicode'],
    'utf-16be': ['utf-16be', 'utf16be', 'unicodefffe'],
    'windows-1250': ['windows-1250', 'cp1250', 'win1250', 'win-1250', 'x-cp1250', 'ms-ee', 'windows1250', 'cp-1250'],
    'iso-8859-2': ['iso-8859-2', 'iso8859-2', 'iso88592', 'iso_8859-2', 'iso_8859-2:1987', 'latin2', 'l2', 'csisolatin2', 'iso-ir-101'],
    // WHATWG: latin1 / iso-8859-1 / ascii se v praxi dekódují jako windows-1252 (nadmnožina).
    'windows-1252': ['windows-1252', 'cp1252', 'win1252', 'x-cp1252', 'latin1', 'l1', 'iso-8859-1', 'iso8859-1', 'iso88591', 'iso_8859-1', 'us-ascii', 'ascii', 'ansi_x3.4-1968', 'csisolatin1'],
  }).flatMap(([canon, list]) => list.map((a) => [a, canon]))
);

/**
 * Normalizuje název kódování („CP1250“, „Windows-1250“, „latin2“ …) na kanonický tvar.
 * @param {string} name
 * @returns {string|null} kanonický název, null pro prázdné/„auto“, jinak název malými písmeny (neznámé kódování)
 */
function normalizeEncoding(name) {
  if (name == null) return null;
  const n = String(name).trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!n || n === 'auto' || n === 'detect') return null;
  return ALIASES.get(n) || n;
}

function decodeSingleByte(buf, table) {
  if (isAscii(buf)) return buf.toString('latin1');
  // Po blocích 1 MB: bajt → kódová jednotka UTF-16 (little-endian zapisujeme ručně, nezávisle na platformě).
  const CHUNK = 1 << 20;
  const parts = [];
  const out = Buffer.allocUnsafe(Math.min(buf.length, CHUNK) * 2);
  for (let start = 0; start < buf.length; start += CHUNK) {
    const end = Math.min(buf.length, start + CHUNK);
    let o = 0;
    for (let i = start; i < end; i++) {
      const v = table[buf[i]];
      out[o++] = v & 0xff;
      out[o++] = v >> 8;
    }
    parts.push(out.toString('utf16le', 0, o));
  }
  return parts.length === 1 ? parts[0] : parts.join('');
}

function decodeUtf16(buf, bigEndian) {
  const n = buf.length - (buf.length % 2);
  if (!bigEndian) return buf.toString('utf16le', 0, n);
  const swapped = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i += 2) {
    swapped[i] = buf[i + 1];
    swapped[i + 1] = buf[i];
  }
  return swapped.toString('utf16le');
}

/** Dekóduje buffer daným kanonickým kódováním (bez BOM). */
function decodeWith(buf, enc) {
  switch (enc) {
    case 'utf-8':
      return buf.toString('utf8');
    case 'utf-16le':
      return decodeUtf16(buf, false);
    case 'utf-16be':
      return decodeUtf16(buf, true);
    case 'windows-1250':
    case 'iso-8859-2':
    case 'windows-1252':
      return decodeSingleByte(buf, TABLES[enc]);
    default: {
      // Ostatní kódování zkusíme přes vestavěný TextDecoder (Node s full-ICU).
      let dec;
      try {
        dec = new TextDecoder(enc);
      } catch {
        const err = new Error(`Nepodporované kódování „${enc}“ (podporováno: utf-8, utf-16, windows-1250, iso-8859-2, windows-1252)`);
        err.code = 'UNSUPPORTED_ENCODING';
        throw err;
      }
      return dec.decode(buf);
    }
  }
}

/** BOM na začátku bufferu → {encoding, length}. */
function sniffBom(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { encoding: 'utf-8', length: 3 };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { encoding: 'utf-16le', length: 2 };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { encoding: 'utf-16be', length: 2 };
  return null;
}

/** UTF-16 bez BOM poznáme podle „<\0?\0“ / „\0<\0?“ na začátku XML. */
function sniffUtf16NoBom(buf) {
  if (buf.length < 4) return null;
  if (buf[0] === 0x3c && buf[1] === 0 && buf[2] !== 0 && buf[3] === 0) return 'utf-16le';
  if (buf[0] === 0 && buf[1] === 0x3c && buf[2] === 0 && buf[3] !== 0) return 'utf-16be';
  return null;
}

function charsetFromContentType(contentType) {
  if (!contentType) return null;
  const m = /charset\s*=\s*"?([^";,\s]+)/i.exec(String(contentType));
  return m ? normalizeEncoding(m[1]) : null;
}

function encodingFromXmlDecl(buf) {
  const head = buf.subarray(0, 200).toString('latin1');
  const m = /^\s*<\?xml[^>]*?\sencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/.exec(head);
  return m ? normalizeEncoding(m[1]) : null;
}

/**
 * Projde bajty a spočítá platné vícebajtové UTF-8 sekvence a neplatné bajty.
 * Volá se jen když isUtf8() selže – rozhoduje, zda jde o UTF-8 s pár vadnými bajty, nebo o jednobajtové kódování.
 */
function utf8Stats(buf) {
  let valid = 0;
  let invalid = 0;
  const n = buf.length;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b < 0x80) continue;
    let need = 0;
    if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) need = 2;
    else if (b >= 0xf0 && b <= 0xf4) need = 3;
    else {
      invalid++;
      continue;
    }
    let ok = i + need < n;
    for (let k = 1; ok && k <= need; k++) if ((buf[i + k] & 0xc0) !== 0x80) ok = false;
    if (ok) {
      valid++;
      i += need;
    } else invalid++;
  }
  return { valid, invalid };
}

/**
 * Rozliší windows-1250 a ISO-8859-2 u českého textu:
 * bajty 0x80–0x9F jsou v ISO-8859-2 řídicí znaky (v textu se nevyskytují), ve windows-1250 jsou to Š Ť Ž š ť ž „ “ – €;
 * naopak Š Ť Ž š ť ž leží v ISO-8859-2 na 0xA9 0xAB 0xAE 0xB9 0xBB 0xBE (ve windows-1250 © « ® ą » ľ).
 */
function guessSingleByte(buf) {
  // Výchozí je windows-1250 (POHODA, Excel). ISO-8859-2 jen při kladném důkazu (data-17): bajty š/ž/Š/Ž na pozicích,
  // kde v cp1250 leží ą ľ © ® « », a to v kontextu písmen (Ž + „lutý“). ® / © za slovem („Shimano®“) a dvojice « »
  // naopak svědčí pro cp1250. Znaky 0x80–0x9F (š ž ť „ “ – v cp1250) vylučují ISO úplně.
  let c1 = 0;
  let iso = 0;
  let cp = 0;
  const n = Math.min(buf.length, 4 * 1024 * 1024);
  const letter = (x) => x !== undefined && ((x >= 0x41 && x <= 0x5a) || (x >= 0x61 && x <= 0x7a) || x >= 0xc0);
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b < 0x80) continue;
    if (b <= 0x9f) {
      c1++;
      continue;
    }
    const prev = i > 0 ? buf[i - 1] : undefined;
    const next = i + 1 < buf.length ? buf[i + 1] : undefined;
    if (b === 0xb9 || b === 0xbe) {
      // š / ž (ISO) vs. ą / ľ (cp1250) – v češtině téměř vždy š / ž uvnitř slova
      if (letter(prev) || letter(next)) iso++;
    } else if (b === 0xa9 || b === 0xae) {
      // Š / Ž na začátku slova vs. © / ® za slovem
      if (letter(next)) iso++;
      else cp++;
    } else if (b === 0xab) {
      // « … » na jednom řádku = uvozovky cp1250 (Ť … ť v ISO by bylo nepravděpodobné)
      for (let j = i + 1; j < Math.min(n, i + 80); j++) {
        if (buf[j] === 0x0a || buf[j] === 0x0d) break;
        if (buf[j] === 0xbb) {
          cp += 2;
          break;
        }
      }
    }
  }
  return c1 === 0 && iso > 0 && iso > cp ? 'iso-8859-2' : 'windows-1250';
}

/**
 * Dekóduje buffer na text.
 * Pořadí rozhodování: BOM (vždy vyhrává – je spolehlivý) → explicitní `encoding` → `charset=` z contentType →
 * `encoding="…"` z XML deklarace → UTF-8. Pokud bajty nejsou platné UTF-8 a vypadají jako jednobajtové kódování
 * (typicky CSV z POHODY/Excelu), použije se windows-1250 (resp. ISO-8859-2 podle heuristiky).
 * Nápověda z contentType/XML deklarace ohlašující jednobajtové kódování je ignorována, pokud je obsah platné UTF-8
 * s ne-ASCII znaky (častá chyba serverů/generátorů feedů); explicitní `encoding` se dodrží vždy.
 * @param {Buffer|Uint8Array|string} buf
 * @param {{encoding?: string, contentType?: string}} [opts]
 * @returns {string}
 */
function decodeBuffer(buf, opts = {}) {
  if (typeof buf === 'string') return buf.charCodeAt(0) === 0xfeff ? buf.slice(1) : buf;
  if (buf == null) return '';
  if (!Buffer.isBuffer(buf)) {
    if (buf instanceof ArrayBuffer) buf = Buffer.from(buf);
    else if (ArrayBuffer.isView(buf)) buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    else throw new TypeError('decodeBuffer: očekáván Buffer nebo řetězec');
  }
  const bom = sniffBom(buf);
  if (bom) return decodeWith(buf.subarray(bom.length), bom.encoding);

  const explicit = normalizeEncoding(opts.encoding);
  if (explicit) {
    if (explicit === 'utf-16le' && buf.length >= 2 && buf[0] === 0 && buf[1] !== 0) return decodeWith(buf, 'utf-16be');
    return decodeWith(buf, explicit);
  }

  const utf16 = sniffUtf16NoBom(buf);
  if (utf16) return decodeWith(buf, utf16);

  const hint = charsetFromContentType(opts.contentType) || encodingFromXmlDecl(buf);
  if (hint && hint !== 'utf-8') {
    if (hint === 'utf-16le' || hint === 'utf-16be') return decodeWith(buf, hint);
    // Deklarováno jednobajtové kódování, ale obsah je platné UTF-8 s diakritikou → věříme obsahu.
    if (!isAscii(buf) && isUtf8(buf)) return buf.toString('utf8');
    return decodeWith(buf, hint);
  }

  if (isUtf8(buf)) return buf.toString('utf8');
  const { valid, invalid } = utf8Stats(buf);
  // Převažují neplatné sekvence → nejde o UTF-8 (jen s pár vadnými bajty), ale o jednobajtové kódování.
  if (invalid > valid) return decodeWith(buf, guessSingleByte(buf));
  return buf.toString('utf8');
}

let reverse1250 = null;

/**
 * Zakóduje text do windows-1250 (pro exporty do POHODY). Nezobrazitelné znaky → „?“.
 * Text se předtím normalizuje do NFC (rozložené „e + ˇ“ → „ě“).
 * @param {string} str
 * @returns {Buffer}
 */
function encodeWindows1250(str) {
  if (!reverse1250) {
    reverse1250 = new Map();
    const t = TABLES['windows-1250'];
    for (let b = 0x80; b < 0x100; b++) {
      const cp = t[b];
      // nedefinované pozice (mapované na C1 řídicí znaky) zpětně nemapujeme – výsledkem je „?“
      if (cp >= 0x80 && cp <= 0x9f) continue;
      reverse1250.set(cp, b);
    }
  }
  const s = String(str ?? '').normalize('NFC');
  const out = Buffer.allocUnsafe(s.length);
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      out[o++] = c;
      continue;
    }
    // náhradní páry (emoji apod.) → jeden „?“
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
      out[o++] = 0x3f;
      continue;
    }
    const b = reverse1250.get(c);
    out[o++] = b === undefined ? 0x3f : b;
  }
  return out.subarray(0, o);
}

/**
 * Určí formát vstupu podle obsahu (a u prázdného obsahu podle přípony / Content-Type).
 * ZIP (PK) → 'xlsx'; první nemezerový znak `{`/`[` → 'json'; `<` → 'xml'; jinak 'csv'.
 * Starý binární Excel (.xls) a gzip vyhodí srozumitelnou chybu (code 'UNSUPPORTED_FORMAT').
 * @param {Buffer|string} input
 * @param {{contentType?: string, filename?: string}} [opts]
 * @returns {'json'|'xml'|'csv'|'xlsx'}
 */
function detectFormat(input, opts = {}) {
  let text;
  if (typeof input === 'string') {
    text = input.length > 4096 ? input.slice(0, 4096) : input;
  } else if (input && (Buffer.isBuffer(input) || ArrayBuffer.isView(input))) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5 || buf[2] === 7)) return 'xlsx';
    if (buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
      throw unsupported('Starý formát Excelu .xls (97–2003) není podporován – uložte soubor jako .xlsx nebo CSV.');
    }
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      throw unsupported('Soubor je komprimovaný gzipem – nahrajte rozbalený soubor (XML/CSV/JSON/XLSX).');
    }
    if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
      throw unsupported('PDF není podporovaný formát dat – použijte XML, CSV, JSON nebo XLSX.');
    }
    text = decodeBuffer(buf.subarray(0, 4096), { contentType: opts.contentType });
  } else {
    text = input == null ? '' : String(input);
  }
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0xfeff || c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0) continue;
    if (c === 0x7b || c === 0x5b) return 'json';
    if (c === 0x3c) return 'xml';
    return 'csv';
  }
  // Prázdný obsah – rozhodne přípona / Content-Type.
  const fn = String(opts.filename || '').toLowerCase();
  const ct = String(opts.contentType || '').toLowerCase();
  if (/\.xlsx$/.test(fn) || ct.includes('spreadsheetml')) return 'xlsx';
  if (/\.json$/.test(fn) || ct.includes('json')) return 'json';
  if (/\.xml$/.test(fn) || ct.includes('xml')) return 'xml';
  return 'csv';
}

function unsupported(message) {
  const err = new Error(message);
  err.code = 'UNSUPPORTED_FORMAT';
  return err;
}

module.exports = { decodeBuffer, encodeWindows1250, detectFormat, normalizeEncoding };
