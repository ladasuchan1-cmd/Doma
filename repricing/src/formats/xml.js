'use strict';
// XML bez závislostí: vlastní tokenizér (indexOf + průchod znaků, žádné regexy přes celý dokument),
// stavba stromu, JSON pohled, proudové čtení záznamů z velkých feedů (200 MB+) a zapisovač XML.
//
// Model uzlu: {name, attrs: {[k]: string}, children: Node[], text: string}
//  - text = spojený text a CDATA přímých potomků, oříznutý o XML bílé znaky (mezera, tab, CR, LF) – pokud trim !== false.
//  - Jmenné prostory: ve výchozím stavu se prefix odstraní (g:price → price); deklarace xmlns / xmlns:* se pak
//    vynechají (po odstranění prefixů nemají význam). keepNs: true ponechá plné názvy i deklarace.
//  - Entity: &amp; &lt; &gt; &quot; &apos;, číselné &#123; &#x1F;, a běžné HTML entity (&nbsp; …), které se ve feedech
//    objevují; neznámé entity a osamocené „&“ zůstanou v textu doslova (nic se tiše neztratí). Vlastní entity z DOCTYPE
//    se záměrně nerozvíjejí (ochrana proti „billion laughs“).

const { decodeBuffer } = require('./decode');

class XmlError extends Error {
  /**
   * @param {string} message popis chyby (česky)
   * @param {number} [line] řádek (od 1)
   * @param {number} [column] sloupec (od 1)
   * @param {number} [offset] pozice ve vstupu (od 0)
   */
  constructor(message, line, column, offset) {
    super(line ? `Neplatné XML (řádek ${line}, sloupec ${column}): ${message}` : `Neplatné XML: ${message}`);
    this.name = 'XmlError';
    this.code = 'XML_INVALID';
    this.reason = message;
    this.line = line || null;
    this.column = column || null;
    this.offset = offset ?? null;
  }
}

/** Řádek a sloupec (od 1) pro pozici v řetězci – počítá se líně, jen při chybě. */
function lineCol(str, offset) {
  let line = 1;
  let lastNl = -1;
  let i = str.indexOf('\n');
  while (i !== -1 && i < offset) {
    line++;
    lastNl = i;
    i = str.indexOf('\n', i + 1);
  }
  return { line, column: offset - lastNl };
}

function fail(str, offset, message) {
  const { line, column } = lineCol(str, Math.min(offset, str.length));
  return new XmlError(message, line, column, offset);
}

// ---------------------------------------------------------------------------------------------------------------
// Entity

const ENTITIES = new Map(
  Object.entries({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    // HTML entity, které generátory feedů občas „protlačí“ do XML
    nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', bdquo: '„', ldquo: '“',
    rdquo: '”', lsquo: '‘', rsquo: '’', sbquo: '‚', laquo: '«', raquo: '»',
    euro: '€', copy: '©', reg: '®', trade: '™', deg: '°', times: '×',
    shy: '­', middot: '·', bull: '•', frac12: '½', plusmn: '±', micro: 'µ',
  })
);

const ENTITY_RE = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{0,31});/g;

function replaceEntity(m, e) {
  if (e.charCodeAt(0) === 35 /* # */) {
    const cp = e.charCodeAt(1) === 120 || e.charCodeAt(1) === 88 ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) return String.fromCodePoint(cp);
    return m;
  }
  const v = ENTITIES.get(e);
  return v === undefined ? m : v;
}

/** Dekóduje entity a normalizuje konce řádků (CRLF/CR → LF) podle XML 1.0. */
function decodeText(s) {
  if (s.indexOf('\r') !== -1) s = s.replace(/\r\n?/g, '\n');
  if (s.indexOf('&') !== -1) s = s.replace(ENTITY_RE, replaceEntity);
  return s;
}

/** Hodnota atributu: entity + normalizace bílých znaků (tab/CR/LF → mezera) podle XML 1.0. */
function decodeAttr(s) {
  if (/[\t\n\r]/.test(s)) s = s.replace(/\r\n|[\t\n\r]/g, ' ');
  if (s.indexOf('&') !== -1) s = s.replace(ENTITY_RE, replaceEntity);
  return s;
}

function isXmlSpace(c) {
  return c === 32 || c === 10 || c === 9 || c === 13;
}

/** Ořízne XML bílé znaky (ne NBSP) z obou stran. */
function trimXml(s) {
  let a = 0;
  let b = s.length;
  while (a < b && isXmlSpace(s.charCodeAt(a))) a++;
  while (b > a && isXmlSpace(s.charCodeAt(b - 1))) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

function isBlank(str, start, end) {
  for (let i = start; i < end; i++) if (!isXmlSpace(str.charCodeAt(i))) return false;
  return true;
}

function localName(qname) {
  const i = qname.indexOf(':');
  return i === -1 ? qname : qname.slice(i + 1);
}

// ---------------------------------------------------------------------------------------------------------------
// Tokenizér

/**
 * Nízkoúrovňový tokenizér. Volá handler:
 *   h.open(name, attrs)  – začátek elementu (u <x/> následuje ihned h.close)
 *   h.close(name)        – konec elementu
 *   h.text(str, start, end) – surový úsek textu uvnitř elementu (volitelné; dekódovat přes decodeText)
 *   h.cdata(text)        – obsah CDATA (volitelné)
 * Pokud handler nastaví h.stop = true, tokenizace skončí (bez kontroly konce dokumentu).
 * @param {string} str
 * @param {object} h handler
 * @param {{keepNs?: boolean, partial?: boolean, maxDepth?: number}} [opts] partial = vstup je jen začátek dokumentu
 *   (neukončené elementy nevadí); maxDepth = max. hloubka zanoření (výchozí 1000)
 */
function tokenizeXml(str, h, opts = {}) {
  const keepNs = !!opts.keepNs;
  const partial = !!opts.partial;
  // ochrana před zásobníkem (rekurzivní xmlToObject) u patologických dokumentů; reálné feedy mají hloubku do ~20
  const maxDepth = opts.maxDepth || 1000;
  const len = str.length;
  const hasText = typeof h.text === 'function';
  const hasCdata = typeof h.cdata === 'function';
  const stack = []; // kvalifikované názvy otevřených elementů
  let rootDone = false;
  let pos = str.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (pos < len) {
    const lt = str.indexOf('<', pos);
    const textEnd = lt === -1 ? len : lt;
    if (textEnd > pos) {
      if (stack.length === 0) {
        if (!isBlank(str, pos, textEnd)) {
          let p = pos;
          while (isXmlSpace(str.charCodeAt(p))) p++;
          throw fail(str, p, rootDone ? 'text za koncem kořenového elementu' : 'text před kořenovým elementem');
        }
      } else if (hasText) h.text(str, pos, textEnd);
    }
    if (lt === -1) break;
    const c = str.charCodeAt(lt + 1);

    if (c === 47 /* / */) {
      // koncový tag
      const gt = str.indexOf('>', lt + 2);
      if (gt === -1) {
        if (partial) break;
        throw fail(str, lt, 'neukončený koncový tag');
      }
      let a = lt + 2;
      let b = gt;
      while (b > a && isXmlSpace(str.charCodeAt(b - 1))) b--;
      const qname = str.slice(a, b);
      if (stack.length === 0) throw fail(str, lt, `koncový tag </${qname}> bez odpovídajícího počátečního tagu`);
      const open = stack.pop();
      if (open !== qname) throw fail(str, lt, `neočekávaný koncový tag </${qname}>, očekáván </${open}>`);
      h.close(keepNs ? qname : localName(qname));
      if (stack.length === 0) rootDone = true;
      pos = gt + 1;
      if (h.stop) return;
      continue;
    }

    if (c === 33 /* ! */) {
      if (str.startsWith('--', lt + 2)) {
        const end = str.indexOf('-->', lt + 4);
        if (end === -1) {
          if (partial) break;
          throw fail(str, lt, 'neukončený komentář <!--');
        }
        pos = end + 3;
        continue;
      }
      if (str.startsWith('[CDATA[', lt + 2)) {
        const end = str.indexOf(']]>', lt + 9);
        if (end === -1) {
          if (partial) break;
          throw fail(str, lt, 'neukončená sekce CDATA');
        }
        if (stack.length === 0) throw fail(str, lt, 'CDATA mimo kořenový element');
        if (hasCdata) h.cdata(str.slice(lt + 9, end));
        pos = end + 3;
        continue;
      }
      if (str.startsWith('DOCTYPE', lt + 2)) {
        if (stack.length || rootDone) throw fail(str, lt, 'DOCTYPE musí být před kořenovým elementem');
        const end = skipDoctype(str, lt + 9);
        if (end === -1) {
          if (partial) break;
          throw fail(str, lt, 'neukončená deklarace DOCTYPE');
        }
        pos = end;
        continue;
      }
      throw fail(str, lt, 'neznámá deklarace <!…');
    }

    if (c === 63 /* ? */) {
      const end = str.indexOf('?>', lt + 2);
      if (end === -1) {
        if (partial) break;
        throw fail(str, lt, 'neukončená instrukce <?…?>');
      }
      pos = end + 2;
      continue;
    }

    // počáteční tag
    let i = lt + 1;
    const nameStart = i;
    for (; i < len; i++) {
      const ch = str.charCodeAt(i);
      if (ch === 62 /* > */ || ch === 47 /* / */ || isXmlSpace(ch)) break;
    }
    if (i >= len) {
      if (partial) break;
      throw fail(str, lt, 'neukončený tag');
    }
    const qname = str.slice(nameStart, i);
    if (!qname || !isNameStart(qname.charCodeAt(0)) || qname.indexOf('<') !== -1) {
      throw fail(str, lt, lt + 1 >= len ? 'neočekávaný konec dokumentu' : `neplatný název elementu za „<“ (znak „${str[lt + 1] || ''}“)`);
    }
    if (stack.length === 0 && rootDone) throw fail(str, lt, `druhý kořenový element <${qname}>`);
    const attrs = {};
    let selfClosing = false;
    for (;;) {
      let ch = str.charCodeAt(i);
      while (isXmlSpace(ch)) ch = str.charCodeAt(++i);
      if (ch === 62 /* > */) {
        i++;
        break;
      }
      if (ch === 47 /* / */) {
        if (str.charCodeAt(i + 1) !== 62) throw fail(str, i, `očekáváno „/>“ v tagu <${qname}>`);
        selfClosing = true;
        i += 2;
        break;
      }
      if (i >= len) {
        if (partial) return;
        throw fail(str, lt, `neukončený tag <${qname}>`);
      }
      // název atributu
      const an = i;
      while (i < len) {
        ch = str.charCodeAt(i);
        if (ch === 61 /* = */ || ch === 62 || ch === 47 || isXmlSpace(ch)) break;
        i++;
      }
      const aname = str.slice(an, i);
      if (!aname) throw fail(str, an, `neplatný název atributu v tagu <${qname}>`);
      while (isXmlSpace(str.charCodeAt(i))) i++;
      if (str.charCodeAt(i) !== 61) {
        if (i >= len && partial) return;
        throw fail(str, an, `atribut „${aname}“ v tagu <${qname}> nemá hodnotu`);
      }
      i++;
      while (isXmlSpace(str.charCodeAt(i))) i++;
      const q = str.charCodeAt(i);
      if (q !== 34 && q !== 39) {
        if (i >= len && partial) return;
        throw fail(str, i, `hodnota atributu „${aname}“ musí být v uvozovkách`);
      }
      const vend = str.indexOf(q === 34 ? '"' : "'", i + 1);
      if (vend === -1) {
        if (partial) return;
        throw fail(str, i, `neukončená hodnota atributu „${aname}“`);
      }
      const value = decodeAttr(str.slice(i + 1, vend));
      i = vend + 1;
      let key = aname;
      if (!keepNs) {
        if (aname === 'xmlns' || aname.startsWith('xmlns:')) continue;
        const ln = localName(aname);
        // kolize po odstranění prefixu (a:id + b:id) → druhý si ponechá plný název, aby se data neztratila
        key = ln && !Object.hasOwn(attrs, ln) ? ln : aname;
      }
      if (Object.hasOwn(attrs, key)) throw fail(str, an, `duplicitní atribut „${aname}“ v tagu <${qname}>`);
      if (key === '__proto__') Object.defineProperty(attrs, key, { value, enumerable: true, writable: true, configurable: true });
      else attrs[key] = value;
    }
    const name = keepNs ? qname : localName(qname);
    h.open(name, attrs);
    if (selfClosing) {
      h.close(name);
      if (stack.length === 0) rootDone = true;
    } else {
      if (stack.length >= maxDepth) throw fail(str, lt, `příliš hluboké zanoření elementů (více než ${maxDepth})`);
      stack.push(qname);
    }
    pos = i;
    if (h.stop) return;
  }

  if (!partial) {
    if (stack.length) throw fail(str, len, `neočekávaný konec dokumentu – chybí </${stack[stack.length - 1]}>`);
    if (!rootDone) throw new XmlError('dokument neobsahuje žádný element', 1, 1, 0);
  }
}

function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58 || c >= 0xc0;
}

/** Přeskočí <!DOCTYPE …> včetně interní podmnožiny […]; vrací pozici za „>“ nebo -1. */
function skipDoctype(str, i) {
  const len = str.length;
  let depth = 0;
  while (i < len) {
    const ch = str.charCodeAt(i);
    if (ch === 34 || ch === 39) {
      const e = str.indexOf(ch === 34 ? '"' : "'", i + 1);
      if (e === -1) return -1;
      i = e + 1;
      continue;
    }
    if (ch === 60 /* < */ && str.startsWith('<!--', i)) {
      const e = str.indexOf('-->', i + 4);
      if (e === -1) return -1;
      i = e + 3;
      continue;
    }
    if (ch === 91 /* [ */) depth++;
    else if (ch === 93 /* ] */) depth--;
    else if (ch === 62 /* > */ && depth <= 0) return i + 1;
    i++;
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------------------------
// Strom

function toStr(input, opts) {
  if (typeof input === 'string') return input;
  if (input && (Buffer.isBuffer(input) || ArrayBuffer.isView(input))) return decodeBuffer(input, opts);
  throw new TypeError('XML: očekáván řetězec nebo Buffer');
}

/**
 * Handler, který staví strom uzlů. Používá ho parseXml i streamRecords (pro zachycený záznam).
 */
class TreeBuilder {
  constructor(trim) {
    this.trim = trim;
    this.stack = [];
    this.root = null;
    this.textParts = []; // pro každý otevřený uzel pole úseků textu (null = zatím žádný)
  }
  open(name, attrs) {
    const node = { name, attrs, children: [], text: '' };
    const n = this.stack.length;
    if (n) this.stack[n - 1].children.push(node);
    else this.root = node;
    this.stack.push(node);
    this.textParts.push(null);
    return node;
  }
  close() {
    const node = this.stack.pop();
    const parts = this.textParts.pop();
    if (parts !== null) {
      const t = parts.length === 1 ? parts[0] : parts.join('');
      node.text = this.trim ? trimXml(t) : t;
    }
    return node;
  }
  addText(s) {
    const i = this.textParts.length - 1;
    const parts = this.textParts[i];
    if (parts === null) this.textParts[i] = [s];
    else parts.push(s);
  }
  text(str, start, end) {
    // čistě bílé úseky mezi elementy při ořezávání nepotřebujeme
    if (this.trim && isBlank(str, start, end)) return;
    this.addText(decodeText(str.slice(start, end)));
  }
  cdata(s) {
    this.addText(s);
  }
}

/**
 * Rozparsuje XML dokument do stromu.
 * @param {string|Buffer} str
 * @param {{keepNs?: boolean, trim?: boolean}} [opts]
 * @returns {{name: string, attrs: Object<string,string>, children: Array, text: string}} kořenový element
 * @throws {XmlError}
 */
function parseXml(str, opts = {}) {
  const s = toStr(str, opts);
  const b = new TreeBuilder(opts.trim !== false);
  tokenizeXml(s, b, { keepNs: opts.keepNs });
  return b.root;
}

function setOwn(obj, key, value) {
  if (key === '__proto__') Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  else obj[key] = value;
}

/**
 * JSON pohled na uzel: atributy jako `@název`, opakované potomky → pole, element jen s textem → řetězec,
 * atributy + text → {'@a': …, '#text': …}, prázdný element → ''.
 * @param {object} node
 * @returns {object|string}
 */
function xmlToObject(node) {
  const children = node.children;
  const attrs = node.attrs;
  let hasAttrs = false;
  for (const _k in attrs) {
    hasAttrs = true;
    break;
  }
  if (!hasAttrs && children.length === 0) return node.text;
  const out = {};
  if (hasAttrs) for (const k of Object.keys(attrs)) out['@' + k] = attrs[k];
  for (let i = 0; i < children.length; i++) {
    const ch = children[i];
    const v = xmlToObject(ch);
    const k = ch.name;
    if (!Object.hasOwn(out, k)) setOwn(out, k, v);
    else {
      const prev = out[k];
      // hodnoty z xmlToObject nejsou nikdy pole → pole znamená, že už jde o opakovaný element
      if (Array.isArray(prev)) prev.push(v);
      else out[k] = [prev, v];
    }
  }
  if (node.text !== '') out['#text'] = node.text;
  return out;
}

function splitPath(path, keepNs) {
  const parts = String(path)
    .replace(/^[./]+|[./]+$/g, '')
    .split(/[./]/)
    .filter(Boolean);
  return keepNs ? parts : parts.map(localName);
}

/**
 * Proudově projde dokument a pro každý element na cestě `itemPath` (např. `SHOP.SHOPITEM`) zavolá
 * `onRecord(xmlToObject(element), index)`. Strom se staví jen pro aktuální záznam.
 * Bez itemPath se použije detectItemPath(); když nic nenajde, záznamem je kořenový element.
 * Pokud onRecord vrátí `false`, čtení skončí (hodí se pro náhled). Volba `limit` omezí počet záznamů.
 * @param {string|Buffer} str
 * @param {{itemPath?: string, keepNs?: boolean, trim?: boolean, limit?: number}} opts
 * @param {(record: object, index: number) => (void|boolean)} onRecord
 * @returns {number} počet záznamů
 * @throws {XmlError}
 */
function streamRecords(str, opts, onRecord) {
  if (typeof opts === 'function') {
    onRecord = opts;
    opts = {};
  }
  opts = opts || {};
  const s = toStr(str, opts);
  const keepNs = !!opts.keepNs;
  let itemPath = opts.itemPath || opts.item_path || null;
  if (!itemPath) itemPath = detectItemPath(s, { keepNs });
  const parts = itemPath ? splitPath(itemPath, keepNs) : null;
  const target = parts ? parts.length : 1;
  const limit = opts.limit > 0 ? opts.limit : Infinity;
  const trim = opts.trim !== false;

  let depth = 0;
  let matchDepth = 0;
  let count = 0;
  let builder = null; // TreeBuilder zachyceného záznamu
  let captureDepth = -1;

  const h = {
    stop: false,
    open(name, attrs) {
      if (builder !== null) {
        builder.open(name, attrs);
      } else if (matchDepth === depth && (parts === null ? depth === 0 : parts[depth] === name)) {
        matchDepth = depth + 1;
        if (matchDepth === target) {
          builder = new TreeBuilder(trim);
          builder.open(name, attrs);
          captureDepth = depth;
        }
      }
      depth++;
    },
    close() {
      depth--;
      if (builder !== null) {
        const node = builder.close();
        if (depth === captureDepth) {
          builder = null;
          const idx = count++;
          if (onRecord(xmlToObject(node), idx) === false || count >= limit) h.stop = true;
        }
      }
      if (matchDepth > depth) matchDepth = depth;
    },
    text(str2, start, end) {
      if (builder !== null) builder.text(str2, start, end);
    },
    cdata(t) {
      if (builder !== null) builder.cdata(t);
    },
  };
  tokenizeXml(s, h, { keepNs });
  return count;
}

// Názvy, které typicky označují jednu položku feedu (pro dokument, kde se nic neopakuje).
const KNOWN_ITEM_NAMES = new Set(
  ['shopitem', 'item', 'product', 'produkt', 'offer', 'entry', 'datapackitem', 'stock', 'record', 'row', 'polozka', 'zbozi', 'responsepackitem'].map(
    (s) => s.toLowerCase()
  )
);

/**
 * Odhadne cestu k opakujícímu se záznamu (např. `SHOP.SHOPITEM`, `rss.channel.item`, `dataPack.dataPackItem`).
 * Z prvních ~2 MB spočítá pro každou cestu nejvyšší počet stejnojmenných sourozenců pod jedním rodičem.
 * Kandidát = opakuje se (≥ 2×) a je „záznamový“ (má potomky nebo atributy). Pokud je kandidát uvnitř jiného
 * kandidáta, vyhrává vnější (PARAM uvnitř SHOPITEM, offer uvnitř product → záznamem je SHOPITEM / product).
 * Mezi zbylými rozhoduje počet opakování, při shodě hlubší cesta.
 * Když se nic neopakuje, vrátí nejmělčí element se známým názvem položky (SHOPITEM, item, product…), jinak null.
 * @param {string|Buffer} str
 * @param {{keepNs?: boolean, sampleSize?: number}} [opts]
 * @returns {string|null}
 */
function detectItemPath(str, opts = {}) {
  const sampleSize = opts.sampleSize || 2 * 1024 * 1024;
  let s;
  if (typeof str === 'string') s = str;
  else s = decodeBuffer(Buffer.isBuffer(str) ? str.subarray(0, sampleSize + 16) : Buffer.from(str).subarray(0, sampleSize + 16));
  if (s.length > sampleSize) {
    const cut = s.lastIndexOf('>', sampleSize);
    s = s.slice(0, cut + 1);
  }
  const stats = new Map(); // path → {path, depth, parent, max, recordLike, order}
  const frames = []; // {path, counts: Map}
  const h = {
    open(name, attrs) {
      const parent = frames.length ? frames[frames.length - 1] : null;
      const path = parent ? parent.path + '.' + name : name;
      let st = stats.get(path);
      if (!st) {
        st = { path, depth: frames.length, parent: parent ? parent.path : null, max: 0, recordLike: false, order: stats.size };
        stats.set(path, st);
      }
      if (parent) {
        const c = (parent.counts.get(name) || 0) + 1;
        parent.counts.set(name, c);
        if (c > st.max) st.max = c;
        stats.get(parent.path).recordLike = true;
      } else st.max = 1;
      for (const _k in attrs) {
        st.recordLike = true;
        break;
      }
      frames.push({ path, counts: new Map() });
    },
    close() {
      frames.pop();
    },
  };
  try {
    tokenizeXml(s, h, { keepNs: opts.keepNs, partial: true });
  } catch (e) {
    if (!(e instanceof XmlError)) throw e;
    // vadný dokument – rozhodneme z toho, co se stihlo načíst (chybu nahlásí až samotné čtení)
  }
  const cands = [...stats.values()].filter((st) => st.max >= 2 && st.recordLike);
  const alive = cands.filter((d) => !cands.some((a) => a !== d && d.path.startsWith(a.path + '.')));
  if (alive.length) {
    alive.sort((a, b) => b.max - a.max || b.depth - a.depth || a.order - b.order);
    return alive[0].path;
  }
  let best = null;
  for (const st of stats.values()) {
    if (st.depth === 0) continue;
    const ln = st.path.slice(st.path.lastIndexOf('.') + 1);
    if (KNOWN_ITEM_NAMES.has(localName(ln).toLowerCase()) && (!best || st.depth < best.depth)) best = st;
  }
  return best ? best.path : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Zápis

// Znaky mimo XML 1.0 (řídicí znaky kromě TAB/LF/CR, osamocené náhradní páry, U+FFFE/U+FFFF) – při zápisu se vypouštějí.
const INVALID_XML_CHARS = /[^\t\n\r\x20-퟿-�\u{10000}-\u{10FFFF}]/gu;
const ESCAPE_TEXT_RE = /[&<>"'\r]/g;
const ESCAPE_ATTR_RE = /[&<>"'\r\n\t]/g;
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\r': '&#13;', '\n': '&#10;', '\t': '&#9;' };
const escChar = (c) => ESC[c];

function stringify(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return String(v);
}

/**
 * Escapuje text pro XML (& < > " ' a CR) a odstraní znaky, které XML 1.0 nepovoluje.
 * @param {*} s
 * @returns {string}
 */
function escapeXml(s) {
  const str = stringify(s);
  return str.replace(INVALID_XML_CHARS, '').replace(ESCAPE_TEXT_RE, escChar);
}

/** Jako escapeXml, navíc zachová tab/LF v hodnotě atributu (jinak by je parser převedl na mezery). */
function escapeAttr(s) {
  return stringify(s).replace(INVALID_XML_CHARS, '').replace(ESCAPE_ATTR_RE, escChar);
}

function attrString(attrs) {
  if (!attrs) return '';
  let out = '';
  for (const k of Object.keys(attrs)) {
    const v = attrs[k];
    if (v === undefined || v === null) continue;
    out += ' ' + k + '="' + escapeAttr(typeof v === 'boolean' ? String(v) : v) + '"';
  }
  return out;
}

/**
 * Sestaví element jako řetězec (bez odsazení).
 * `content`: řetězec/číslo = text (escapuje se), pole = potomci (už hotové XML řetězce, null se přeskočí),
 * null/undefined/'' = prázdný element `<name/>`.
 * @param {string} name
 * @param {object|null} [attrs]
 * @param {Array<string>|string|number|null} [content]
 * @returns {string}
 */
function el(name, attrs, content) {
  const a = attrString(attrs);
  if (Array.isArray(content)) {
    const inner = content.filter((c) => c != null && c !== '').join('');
    return inner ? `<${name}${a}>${inner}</${name}>` : `<${name}${a}/>`;
  }
  const t = content == null ? '' : typeof content === 'boolean' ? String(content) : escapeXml(content);
  return t === '' ? `<${name}${a}/>` : `<${name}${a}>${t}</${name}>`;
}

/**
 * Jednoduchý zapisovač XML s odsazením 2 mezery a deklarací `<?xml version="1.0" encoding="UTF-8"?>`.
 * @example
 *   const w = new XmlWriter(); w.open('prices', {count: 1}); w.open('item'); w.leaf('code', 'A1'); w.close(); w.close();
 *   w.toString();
 */
class XmlWriter {
  /** @param {{declaration?: boolean|string, indent?: string}} [opts] declaration: false = bez deklarace, řetězec = vlastní */
  constructor(opts = {}) {
    this.indent = opts.indent ?? '  ';
    this.parts = [];
    this.stack = [];
    if (opts.declaration !== false) {
      this.parts.push(typeof opts.declaration === 'string' ? opts.declaration : '<?xml version="1.0" encoding="UTF-8"?>', '\n');
    }
  }
  pad() {
    return this.indent.repeat(this.stack.length);
  }
  /** Otevře element. */
  open(name, attrs) {
    this.parts.push(this.pad(), '<', name, attrString(attrs), '>\n');
    this.stack.push(name);
    return this;
  }
  /** Element s textem na jednom řádku; null/undefined/'' → `<name/>`. */
  leaf(name, text, attrs) {
    const t = text == null ? '' : typeof text === 'boolean' ? String(text) : escapeXml(text);
    if (t === '') this.parts.push(this.pad(), '<', name, attrString(attrs), '/>\n');
    else this.parts.push(this.pad(), '<', name, attrString(attrs), '>', t, '</', name, '>\n');
    return this;
  }
  /** Vloží hotový XML fragment (neescapuje se!) na aktuální úroveň odsazení. */
  raw(xml) {
    this.parts.push(this.pad(), xml, '\n');
    return this;
  }
  /** Komentář (sekvence „--“ se nahradí „- -“). */
  comment(text) {
    this.parts.push(this.pad(), '<!-- ', stringify(text).replace(INVALID_XML_CHARS, '').replace(/--/g, '- -'), ' -->\n');
    return this;
  }
  /** Uzavře naposledy otevřený element. */
  close() {
    const name = this.stack.pop();
    if (name === undefined) throw new Error('XmlWriter: není co uzavřít');
    this.parts.push(this.pad(), '</', name, '>\n');
    return this;
  }
  /** Výsledný dokument; neuzavřené elementy se uzavřou (stav zapisovače se nemění). */
  toString() {
    let tail = '';
    for (let d = this.stack.length - 1; d >= 0; d--) tail += this.indent.repeat(d) + '</' + this.stack[d] + '>\n';
    return this.parts.join('') + tail;
  }
}

module.exports = {
  parseXml,
  xmlToObject,
  streamRecords,
  detectItemPath,
  escapeXml,
  el,
  XmlWriter,
  XmlError,
  // nízkoúrovňové API (používá xlsx.js)
  tokenizeXml,
  decodeText,
};
