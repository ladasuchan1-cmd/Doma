'use strict';
// Řádky pro export cen (SPEC §7 rows.js) – společný podklad pro feedy, webhook, POHODA XML a XLSX ceník.
//
// Row = {proposal_id|null, product_id, code, ean, name, manufacturer, price (cena k exportu), old_price, change_pct,
//        vat_rate, currency, changed_at, strategy (název|null), segment (název|null), lowest_30d}
//
// Rozhodnutí (konzervativní výklad SPEC):
//  - Exportují se jen AKTIVNÍ produkty. Schválený návrh neaktivního produktu zůstane „approved“ a do exportu nejde.
//  - Z návrhů se bere jen NEJNOVĚJŠÍ schválený (neexportovaný) návrh produktu (nejvyšší id). Filtr `ids` se použije
//    až potom – starší schválený návrh téhož produktu se tak nikdy nevyexportuje, i kdyby o něj volající požádal.
//    Schválený návrh, po kterém už byl vyexportován NOVĚJŠÍ návrh téhož produktu, je zastaralý a také se nepoužije
//    (jinak by po exportu nejnovější ceny „vyplaval“ starší schválený návrh a přepsal ji starou cenou).
//  - Řádek bez kladné ceny (chybí cena produktu, ruční cena 0 …) se do exportu NEZAŘADÍ – odeslat do adminu cenu 0
//    nebo prázdnou cenu by bylo nebezpečné. Takový návrh zůstane ve stavu „approved“ a je vidět v UI.
//  - lowest_30d (Omnibus, § 12a zákona o ochraně spotřebitele) = nejnižší naše cena za 30 dní před `now`:
//    minimum z (a) záznamů price_history v okně [now − 30 dní, now], (b) posledního záznamu PŘED začátkem okna
//    (ta cena ještě na začátku okna platila) a (c) aktuální ceny produktu. Novou (exportovanou) cenu nezahrnuje.

const { getSettings, nowIso } = require('../db');
const { round } = require('../util/num');

/** Pořadí a názvy polí řádku exportu (i výchozí sloupce CSV/JSON). */
const ROW_FIELDS = [
  'proposal_id',
  'product_id',
  'code',
  'ean',
  'name',
  'manufacturer',
  'price',
  'old_price',
  'change_pct',
  'vat_rate',
  'currency',
  'changed_at',
  'strategy',
  'segment',
  'lowest_30d',
];

/** České popisky polí (hlavičky CSV/XLSX pro lidi). */
const ROW_LABELS = {
  proposal_id: 'ID návrhu',
  product_id: 'ID produktu',
  code: 'Kód',
  ean: 'EAN',
  name: 'Název',
  manufacturer: 'Výrobce',
  price: 'Nová cena',
  old_price: 'Původní cena',
  change_pct: 'Změna %',
  vat_rate: 'DPH %',
  currency: 'Měna',
  changed_at: 'Změněno',
  strategy: 'Strategie',
  segment: 'Segment',
  lowest_30d: 'Nejnižší cena za 30 dní',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const OMNIBUS_DAYS = 30;

function toDate(now) {
  if (now == null) return new Date();
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) throw new Error(`Neplatné datum: ${now}`);
  return d;
}

/** Normalizuje seznam id (čísla i řetězce, duplicity pryč, neplatné zahodit). null = bez filtru. */
function idList(v) {
  if (v == null) return null;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = new Set();
  for (const x of arr) {
    const n = Number(typeof x === 'string' ? x.trim() : x);
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return [...out];
}

function money(v) {
  return v == null || !Number.isFinite(Number(v)) ? null : round(Number(v), 2);
}

/** Změna v % mezi starou a novou cenou (2 desetinná místa) nebo null. */
function changePct(oldPrice, newPrice) {
  if (oldPrice == null || newPrice == null || !(oldPrice > 0)) return null;
  return round(((newPrice - oldPrice) / oldPrice) * 100, 2);
}

/**
 * Nejnižší ceny za 30 dní před `now` pro všechny produkty (Map product_id → cena).
 * Aktuální cenu produktu přidává volající.
 */
function lowestPrices(db, now, productIds = null) {
  const to = nowIso(now);
  const from = nowIso(new Date(now.getTime() - OMNIBUS_DAYS * DAY_MS));
  const out = new Map();
  // omezení na konkrétní produkty (malé exporty změn nemusí procházet celou historii)
  const only = productIds ? ' AND product_id IN (SELECT value FROM json_each(?))' : '';
  const extra = productIds ? [JSON.stringify(productIds)] : [];
  const put = (id, price) => {
    if (price == null || !(price > 0)) return;
    const cur = out.get(id);
    if (cur === undefined || price < cur) out.set(id, price);
  };
  // (a) změny v okně
  for (const r of db
    .prepare(`SELECT product_id, MIN(price) AS price FROM price_history WHERE price > 0 AND at >= ? AND at <= ?${only} GROUP BY product_id`)
    .all(from, to, ...extra)) {
    put(r.product_id, r.price);
  }
  // (b) cena platná na začátku okna = poslední záznam před oknem
  for (const r of db
    .prepare(
      `SELECT product_id, price FROM (
         SELECT product_id, price, ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY at DESC, id DESC) AS rn
         FROM price_history WHERE at < ?${only}
       ) WHERE rn = 1`
    )
    .all(from, ...extra)) {
    put(r.product_id, r.price);
  }
  return out;
}

const PRODUCT_COLS = `p.id AS product_id, p.code, p.ean, p.name, p.manufacturer, p.price AS current_price, p.vat_rate,
  p.price_changed_at, p.code_key`;

/**
 * SQL podmínka „návrh `pr` je nejnovější schválený návrh svého produktu a žádný novější návrh téhož produktu
 * už nebyl exportován“ (sdílí ji exportRows i potvrzení podle kódů v apply.js).
 */
const LATEST_APPROVED_SQL = `pr.id = (SELECT MAX(x.id) FROM proposals x WHERE x.product_id = pr.product_id AND x.status = 'approved' AND x.exported_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM proposals y WHERE y.product_id = pr.product_id AND y.status = 'exported' AND y.id > pr.id)`;

/**
 * Nejnovější schválený (neexportovaný) návrh každého aktivního produktu.
 * @returns {Map<number, object>} product_id → řádek návrhu (+ strategy_name, segment_name)
 */
function latestApproved(db, productIds) {
  const params = [];
  let where = '';
  if (productIds) {
    where = ' AND p.id IN (SELECT value FROM json_each(?))';
    params.push(JSON.stringify(productIds));
  }
  const rows = db
    .prepare(
      `SELECT pr.id AS proposal_id, pr.product_id, pr.old_price, pr.new_price, pr.manual_price, pr.change_pct,
              pr.created_at, pr.decided_at, s.name AS strategy_name, g.name AS segment_name
       FROM proposals pr
       JOIN products p ON p.id = pr.product_id AND p.active = 1
       LEFT JOIN strategies s ON s.id = pr.strategy_id
       LEFT JOIN segments g ON g.id = pr.segment_id
       WHERE pr.status = 'approved' AND pr.exported_at IS NULL
         AND ${LATEST_APPROVED_SQL}${where}`
    )
    .all(...params);
  const out = new Map();
  for (const r of rows) out.set(r.product_id, r);
  return out;
}

function buildRow(product, proposal, ctx) {
  const current = product.current_price;
  let price;
  let oldPrice;
  let pct;
  let changedAt;
  if (proposal) {
    price = money(proposal.manual_price ?? proposal.new_price);
    oldPrice = money(proposal.old_price ?? current);
    // Ruční cena mění procento změny oproti uloženému návrhu → přepočet; bez staré ceny necháme uložené.
    pct = changePct(oldPrice, price);
    if (pct == null && proposal.manual_price == null) pct = proposal.change_pct ?? null;
    changedAt = proposal.decided_at || proposal.created_at || null;
  } else {
    price = money(current);
    oldPrice = price;
    pct = price == null ? null : 0;
    changedAt = product.price_changed_at || null;
  }
  if (price == null || !(price > 0)) return null;

  let lowest = ctx.lowest.get(product.product_id);
  if (current != null && current > 0 && (lowest === undefined || current < lowest)) lowest = current;

  return {
    proposal_id: proposal ? proposal.proposal_id : null,
    product_id: product.product_id,
    code: product.code,
    ean: product.ean ?? null,
    name: product.name ?? null,
    manufacturer: product.manufacturer ?? null,
    price,
    old_price: oldPrice,
    change_pct: pct,
    vat_rate: product.vat_rate ?? ctx.vatDefault ?? null,
    currency: ctx.currency,
    changed_at: changedAt,
    strategy: proposal ? proposal.strategy_name ?? null : null,
    segment: proposal ? proposal.segment_name ?? null : null,
    lowest_30d: lowest === undefined ? null : money(lowest),
  };
}

/**
 * Řádky exportu cen.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{scope?: 'approved'|'all', ids?: number[], productIds?: number[], now?: Date|string}} [opts]
 *   scope 'approved' (výchozí) = nejnovější schválený neexportovaný návrh každého aktivního produktu;
 *   scope 'all' = úplný ceník všech aktivních produktů (cena ze schváleného návrhu, jinak aktuální cena).
 *   ids = id návrhů (jen pro scope 'approved'), productIds = omezení na produkty.
 * @returns {Array<object>} řádky seřazené podle kódu
 */
function exportRows(db, opts = {}) {
  const scope = opts.scope ?? 'approved';
  if (scope !== 'approved' && scope !== 'all') throw new Error(`Neplatný rozsah exportu „${scope}“ (povoleno: approved, all)`);
  const now = toDate(opts.now);
  const ids = idList(opts.ids);
  const productIds = idList(opts.productIds);
  const settings = getSettings(db);
  const ctx = {
    currency: settings.currency || 'CZK',
    vatDefault: settings.vat_rate_default ?? null,
    lowest: null,
  };

  const proposals = latestApproved(db, productIds);
  const out = [];

  if (scope === 'approved') {
    if (!proposals.size) return out;
    const idSet = ids ? new Set(ids) : null;
    const wanted = [...proposals.values()].filter((p) => !idSet || idSet.has(p.proposal_id));
    if (!wanted.length) return out;
    ctx.lowest = lowestPrices(db, now, wanted.map((p) => p.product_id));
    const products = db
      .prepare(`SELECT ${PRODUCT_COLS} FROM products p WHERE p.active = 1 AND p.id IN (SELECT value FROM json_each(?)) ORDER BY p.code_key`)
      .all(JSON.stringify(wanted.map((p) => p.product_id)));
    for (const product of products) {
      const row = buildRow(product, proposals.get(product.product_id), ctx);
      if (row) out.push(row);
    }
    return out;
  }

  ctx.lowest = lowestPrices(db, now, productIds);
  const params = [];
  let where = 'p.active = 1';
  if (productIds) {
    where += ' AND p.id IN (SELECT value FROM json_each(?))';
    params.push(JSON.stringify(productIds));
  }
  for (const product of db.prepare(`SELECT ${PRODUCT_COLS} FROM products p WHERE ${where} ORDER BY p.code_key`).all(...params)) {
    const proposal = proposals.get(product.product_id) || null;
    // Návrh s neplatnou cenou (např. ruční cena 0) v úplném ceníku nahradí aktuální cena produktu.
    const row = (proposal && buildRow(product, proposal, ctx)) || buildRow(product, null, ctx);
    if (row) out.push(row);
  }
  return out;
}

module.exports = { exportRows, ROW_FIELDS, ROW_LABELS, LATEST_APPROVED_SQL, changePct, idList };
