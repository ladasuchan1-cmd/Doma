'use strict';
// Export nových prodejních cen do POHODY jako XML dataPack (SPEC §7 pohoda.js, závazně podle docs/POHODA.md).
//
//  - bez cenové hladiny: agenda Zásoby – stk:stock / stk:actionType / stk:update / ftr:filter / ftr:code|ftr:EAN
//    + stk:stockHeader / stk:sellingPrice payVAT="true" (cena S DPH; bez atributu by POHODA brala cenu bez DPH!)
//  - s cenovou hladinou: agenda Slevy – dis:discount / dis:discountStockItem / dis:stockItem / typ:stockItem / typ:ids|typ:EAN
//    + dis:discounts / dis:discountsItem / dis:filter / dis:priceLevel / typ:ids + dis:price
//  - výchozí kódování windows-1250 (deklarace „Windows-1250“ + bajty přes encodeWindows1250), volitelně UTF-8.
//  - řádky bez klíče filtru (kód / EAN) nebo bez kladné ceny se vynechají a vrátí v `skipped`.
//  - prázdný balík XSD nepovoluje (dat:dataPack musí mít aspoň jednu dat:dataPackItem) → když není co zapsat,
//    vyhodí se chyba s code 'POHODA_EMPTY', status 409 a polem `skipped`.
//  - filtr podle EAN: POHODA odmítne aktualizaci, když EAN odpovídá více zásobám. Pokud stejný EAN nese víc našich
//    produktů, vynecháme všechny (důvod duplicate_ean) – nelze určit, kterou zásobu aktualizovat.

const crypto = require('node:crypto');
const { escapeXml, encodeWindows1250 } = require('../formats');
const { round } = require('../util/num');

const NS_BASE = 'http://www.stormware.cz/schema/version_2/';
const NS = {
  dat: NS_BASE + 'data.xsd',
  stk: NS_BASE + 'stock.xsd',
  ftr: NS_BASE + 'filter.xsd',
  typ: NS_BASE + 'type.xsd',
  dis: NS_BASE + 'discount.xsd',
};

const MAX_ID = 64; // dataPack/@id a dataPackItem/@id – max 64 znaků
const MAX_APPLICATION = 100;

const SKIP_REASONS = {
  no_code: 'chybí kód zásoby',
  no_ean: 'chybí EAN',
  duplicate_ean: 'stejný EAN má více produktů – POHODA by aktualizaci odmítla',
  invalid_price: 'chybí kladná cena',
};

function normalizeEncoding(v) {
  const s = String(v ?? 'windows-1250').trim().toLowerCase().replace(/_/g, '-');
  if (s === '' || s === 'windows-1250' || s === 'cp1250' || s === 'win1250' || s === 'windows1250') return 'windows-1250';
  if (s === 'utf-8' || s === 'utf8') return 'utf-8';
  throw new Error(`Nepodporované kódování POHODA XML „${v}“ (povoleno: windows-1250, utf-8)`);
}

function normalizeFilterBy(v) {
  const s = String(v ?? 'code').trim().toLowerCase();
  if (s === '' || s === 'code' || s === 'kod' || s === 'kód') return 'code';
  if (s === 'ean') return 'ean';
  throw new Error(`Neplatný způsob párování zásob v POHODĚ „${v}“ (povoleno: code, ean)`);
}

/** Datum yyyymmdd v pražském čase. */
function pragueDate(now) {
  const d = now == null ? new Date() : now instanceof Date ? now : new Date(now);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return get('year') + get('month') + get('day');
}

/**
 * Id balíku: `cenotvorba-<yyyymmdd>-<id exportu (4 číslice) | náhodný hex>`.
 * @param {{id?: string, export_id?: number, now?: Date|string}} opts
 */
function packId(opts = {}) {
  if (opts.id != null && String(opts.id).trim() !== '') return String(opts.id).trim().slice(0, MAX_ID);
  const suffix = opts.export_id != null ? String(opts.export_id).padStart(4, '0') : crypto.randomBytes(4).toString('hex');
  return `cenotvorba-${pragueDate(opts.now)}-${suffix}`.slice(0, MAX_ID);
}

/** České skloňování „položka“. */
function itemsWord(n) {
  if (n === 1) return 'položka';
  if (n >= 2 && n <= 4) return 'položky';
  return 'položek';
}

/** Číslo jako prostý desetinný zápis s tečkou (xsd:double), bez oddělovačů tisíců a exponentu. */
function num(v) {
  const n = round(Number(v), 2);
  if (!Number.isFinite(n)) return '';
  let s = String(n);
  if (/e/i.test(s)) s = n.toFixed(2).replace(/\.?0+$/, '');
  return s;
}

function trimmed(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * Sestaví POHODA XML a vrátí vše potřebné pro odpověď API.
 * @param {object[]} rows řádky z exportRows (používá code, ean, price, product_id, proposal_id)
 * @param {{ico?: string, application?: string, filter_by?: 'code'|'ean', price_level?: string, note?: string,
 *   id?: string, export_id?: number, encoding?: 'windows-1250'|'utf-8', now?: Date|string}} [opts]
 * @returns {{xml: string, buffer: Buffer, id: string, count: number, encoding: string, contentType: string,
 *   rows: object[], skipped: Array<{product_id, proposal_id, code, ean, reason, message}>}}
 */
function buildPohodaXml(rows, opts = {}) {
  rows = rows || [];
  const encoding = normalizeEncoding(opts.encoding);
  const filterBy = normalizeFilterBy(opts.filter_by ?? opts.filterBy);
  const priceLevel = trimmed(opts.price_level ?? opts.priceLevel);
  const ico = trimmed(opts.ico).replace(/\s+/g, '');
  const application = (trimmed(opts.application) || 'Cenotvorba').slice(0, MAX_APPLICATION);
  const id = packId(opts);

  // výběr řádků
  const skipped = [];
  const skip = (r, reason) =>
    skipped.push({ product_id: r.product_id ?? null, proposal_id: r.proposal_id ?? null, code: r.code ?? null, ean: r.ean ?? null, reason, message: SKIP_REASONS[reason] });
  const candidates = [];
  for (const r of rows) {
    if (!r) continue;
    const key = trimmed(filterBy === 'ean' ? r.ean : r.code);
    if (!key) {
      skip(r, filterBy === 'ean' ? 'no_ean' : 'no_code');
      continue;
    }
    const price = Number(r.price);
    if (r.price == null || !Number.isFinite(price) || !(price > 0)) {
      skip(r, 'invalid_price');
      continue;
    }
    candidates.push({ row: r, key, price });
  }
  let used = candidates;
  if (filterBy === 'ean') {
    const counts = new Map();
    for (const c of candidates) counts.set(c.key, (counts.get(c.key) || 0) + 1);
    used = [];
    for (const c of candidates) {
      if (counts.get(c.key) > 1) skip(c.row, 'duplicate_ean');
      else used.push(c);
    }
  }

  if (!used.length) {
    // XSD vyžaduje v dat:dataPack aspoň jednu položku – prázdný balík by POHODA odmítla.
    const e = new Error(
      skipped.length
        ? `Žádná položka nejde exportovat do POHODY (vynecháno ${skipped.length}: ${[...new Set(skipped.map((x) => x.message))].join(', ')})`
        : 'Žádné změny cen k exportu do POHODY'
    );
    e.code = 'POHODA_EMPTY';
    e.status = 409;
    e.skipped = skipped;
    throw e;
  }

  const note = opts.note != null && trimmed(opts.note) !== ''
    ? trimmed(opts.note)
    : priceLevel
      ? `Přecenění – cenová hladina ${priceLevel}`
      : `Přecenění – ${used.length} ${itemsWord(used.length)}`;

  const nsKeys = priceLevel ? ['dat', 'dis', 'typ'] : ['dat', 'stk', 'ftr', 'typ'];
  const rootAttrs = { version: '2.0', id };
  if (ico) rootAttrs.ico = ico;
  rootAttrs.application = application;
  rootAttrs.note = note;

  const lines = [];
  const attrs = (o) => Object.entries(o).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('');
  lines.push(`<?xml version="1.0" encoding="${encoding === 'utf-8' ? 'UTF-8' : 'Windows-1250'}"?>`);
  // xmlns deklarace po dvou na řádek – stejné rozložení jako ukázky v docs/POHODA.md
  const nsLines = [];
  for (let i = 0; i < nsKeys.length; i += 2) {
    nsLines.push('  ' + nsKeys.slice(i, i + 2).map((k) => `xmlns:${k}="${NS[k]}"`).join(' '));
  }
  lines.push(`<dat:dataPack${attrs(rootAttrs)}\n${nsLines.join('\n')}>`);

  const ind = (n) => '  '.repeat(n);
  const leaf = (depth, name, text, a) => lines.push(`${ind(depth)}<${name}${a ? attrs(a) : ''}>${escapeXml(text)}</${name}>`);
  const open = (depth, name, a) => lines.push(`${ind(depth)}<${name}${a ? attrs(a) : ''}>`);
  const close = (depth, name) => lines.push(`${ind(depth)}</${name}>`);

  used.forEach((c, i) => {
    const itemId = ('CT-' + String(i + 1).padStart(6, '0')).slice(0, MAX_ID);
    open(1, 'dat:dataPackItem', { version: '2.0', id: itemId });
    if (!priceLevel) {
      open(2, 'stk:stock', { version: '2.0' });
      open(3, 'stk:actionType');
      open(4, 'stk:update');
      open(5, 'ftr:filter');
      leaf(6, filterBy === 'ean' ? 'ftr:EAN' : 'ftr:code', c.key);
      close(5, 'ftr:filter');
      close(4, 'stk:update');
      close(3, 'stk:actionType');
      open(3, 'stk:stockHeader');
      leaf(4, 'stk:sellingPrice', num(c.price), { payVAT: 'true' });
      close(3, 'stk:stockHeader');
      close(2, 'stk:stock');
    } else {
      open(2, 'dis:discount', { version: '2.0' });
      open(3, 'dis:discountStockItem');
      open(4, 'dis:stockItem');
      open(5, 'typ:stockItem');
      leaf(6, filterBy === 'ean' ? 'typ:EAN' : 'typ:ids', c.key);
      close(5, 'typ:stockItem');
      close(4, 'dis:stockItem');
      open(4, 'dis:discounts');
      open(5, 'dis:discountsItem');
      open(6, 'dis:filter');
      open(7, 'dis:priceLevel');
      leaf(8, 'typ:ids', priceLevel);
      close(7, 'dis:priceLevel');
      close(6, 'dis:filter');
      leaf(6, 'dis:price', num(c.price));
      close(5, 'dis:discountsItem');
      close(4, 'dis:discounts');
      close(3, 'dis:discountStockItem');
      close(2, 'dis:discount');
    }
    close(1, 'dat:dataPackItem');
  });
  lines.push('</dat:dataPack>');
  const xml = lines.join('\n') + '\n';
  const buffer = encoding === 'utf-8' ? Buffer.from(xml, 'utf8') : encodeWindows1250(xml);
  return {
    xml,
    buffer,
    id,
    count: used.length,
    encoding,
    contentType: `application/xml; charset=${encoding}`,
    rows: used.map((c) => c.row),
    skipped,
  };
}

/**
 * POHODA XML jako Buffer v cílovém kódování (výchozí windows-1250).
 * Vynechané řádky vrací jen buildPohodaXml (pole `skipped`).
 * @param {object[]} rows
 * @param {object} [opts] viz buildPohodaXml
 * @returns {Buffer}
 */
function toPohodaXml(rows, opts = {}) {
  return buildPohodaXml(rows, opts).buffer;
}

/**
 * Totéž jako toPohodaXml, ale vrací řetězec před zakódováním (deklarace odpovídá zvolenému kódování).
 * @returns {string}
 */
function toPohodaXmlString(rows, opts = {}) {
  return buildPohodaXml(rows, opts).xml;
}

module.exports = { toPohodaXml, toPohodaXmlString, buildPohodaXml, packId, pragueDate, POHODA_NS: NS, SKIP_REASONS };
