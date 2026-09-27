'use strict';
// Feedy změn cen / ceníku pro admin (SPEC §7 feeds.js): XML podle šablony, JSON, CSV (český Excel).

const { XmlWriter, toCsv: formatCsv } = require('../formats');
const { nowIso, DEFAULT_SETTINGS } = require('../db');
const { ROW_FIELDS, ROW_LABELS } = require('./rows');

const DEFAULT_TEMPLATE = DEFAULT_SETTINGS.export.xml;
const KNOWN = new Set(ROW_FIELDS);

// Platné jméno XML elementu bez jmenného prostoru (prefix „g:“ by vyžadoval deklaraci xmlns → nepovolujeme).
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const isName = (s) => typeof s === 'string' && NAME_RE.test(s) && !/^xml/i.test(s);

/**
 * Normalizuje pole šablony na [[pole, element]]. Pole mimo ROW_FIELDS se ignorují; neplatný název elementu
 * se nahradí názvem pole (vždy platný). Duplicitní pole se vypíší jen jednou.
 * @param {string[]|Object<string,string>|undefined} fields
 * @returns {Array<[string, string]>}
 */
function templateFields(fields) {
  let pairs;
  if (Array.isArray(fields)) pairs = fields.map((f) => [String(f).trim(), String(f).trim()]);
  else if (fields && typeof fields === 'object') pairs = Object.entries(fields).map(([k, v]) => [String(k).trim(), v == null || v === '' || v === true ? String(k).trim() : String(v).trim()]);
  else pairs = DEFAULT_TEMPLATE.fields.map((f) => [f, f]);
  const seen = new Set();
  const out = [];
  for (const [field, elName] of pairs) {
    if (!KNOWN.has(field) || seen.has(field)) continue;
    seen.add(field);
    out.push([field, isName(elName) ? elName : field]);
  }
  return out;
}

function currencyOf(rows, opts) {
  return opts.currency || (rows[0] && rows[0].currency) || 'CZK';
}

/**
 * XML feed podle šablony `settings.export.xml` = {root, item, fields}.
 * Kořen dostane atributy generated (ISO UTC), count (počet položek) a currency.
 * Prázdná hodnota (null) → prázdný element `<ean/>`; čísla s desetinnou tečkou.
 * @param {object[]} rows řádky z exportRows
 * @param {{root?: string, item?: string, fields?: string[]|Object<string,string>}} [template]
 * @param {{now?: Date|string, currency?: string}} [opts]
 * @returns {string}
 */
function toXml(rows, template, opts = {}) {
  rows = rows || [];
  const t = template || {};
  const root = isName(t.root) ? t.root : DEFAULT_TEMPLATE.root;
  let item = isName(t.item) ? t.item : DEFAULT_TEMPLATE.item;
  if (item === root) item = DEFAULT_TEMPLATE.item === root ? 'item' : DEFAULT_TEMPLATE.item;
  const fields = templateFields(t.fields);
  const w = new XmlWriter();
  w.open(root, { generated: nowIso(opts.now), count: rows.length, currency: currencyOf(rows, opts) });
  for (const r of rows) {
    w.open(item);
    for (const [field, elName] of fields) w.leaf(elName, r[field]);
    w.close();
  }
  w.close();
  return w.toString();
}

/**
 * JSON feed: {generated, count, currency, items: rows} (objekt – serializaci dělá volající).
 * @param {object[]} rows
 * @param {{now?: Date|string, currency?: string}} [opts]
 */
function toJson(rows, opts = {}) {
  rows = rows || [];
  return { generated: nowIso(opts.now), count: rows.length, currency: currencyOf(rows, opts), items: rows };
}

/**
 * CSV pro český Excel: oddělovač „;“, desetinná čárka, BOM, CRLF.
 * @param {object[]} rows
 * @param {{fields?: string[]|Object<string,string>, labels?: boolean, delimiter?: string, decimal?: string, bom?: boolean}} [opts]
 *   fields = výběr/přejmenování sloupců (jako u XML šablony; výchozí všechna pole řádku),
 *   labels = české hlavičky místo klíčů (pro lidi; strojům ponechte klíče).
 * @returns {string}
 */
function toCsv(rows, opts = {}) {
  const fields = opts.fields ? templateFields(opts.fields) : ROW_FIELDS.map((f) => [f, f]);
  const columns = fields.map(([key, label]) => ({ key, label: opts.labels ? ROW_LABELS[key] : label }));
  return formatCsv(rows || [], columns, {
    delimiter: opts.delimiter ?? ';',
    decimal: opts.decimal ?? ',',
    bom: opts.bom !== false,
  });
}

module.exports = { toXml, toJson, toCsv, templateFields };
