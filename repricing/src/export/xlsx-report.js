'use strict';
// XLSX reporty (SPEC §7 xlsx-report.js): návrhy cen pro kontrolu v Excelu a úplný ceník.

const { writeXlsx } = require('../formats');
const { changePct } = require('./rows');

const STATUS_LABELS = {
  pending: 'Čeká na schválení',
  approved: 'Schváleno',
  rejected: 'Zamítnuto',
  exported: 'Exportováno',
  superseded: 'Nahrazeno novějším',
};

// Popisky příznaků přebíráme z enginu (jediný zdroj pravdy), aby nové příznaky nikdy neskončily jako kódy.
const FLAG_LABELS = Object.freeze({ ...require('../engine/pricing').FLAG_LABELS, ...require('../util/proposals').HUMAN_FLAG_LABELS });

/** Pole návrhu – z API přijde produkt buď vnořený (`product: {code, …}`), nebo zploštělý. */
function pick(p, key) {
  if (p[key] !== undefined && p[key] !== null) return p[key];
  if (p.product && typeof p.product === 'object' && p.product[key] !== undefined) return p.product[key];
  return null;
}

function flagsOf(p) {
  let f = p.flags;
  if (typeof f === 'string') {
    try {
      f = JSON.parse(f);
    } catch {
      f = f ? f.split(',') : [];
    }
  }
  return Array.isArray(f) ? f.filter((x) => x != null && x !== '').map(String) : [];
}

function cheapestOf(p) {
  if (p.cheapest_competitor != null) return p.cheapest_competitor;
  const c = p.market && p.market.cheapest;
  if (c && typeof c === 'object') return c.competitor ?? null;
  return null;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Normalizovaný řádek listu „Návrhy“. */
function proposalRow(p) {
  const oldPrice = num(p.old_price);
  const newPrice = num(p.new_price);
  const manual = num(p.manual_price);
  const final = manual ?? newPrice;
  const change = manual != null ? changePct(oldPrice, final) ?? num(p.change_pct) : num(p.change_pct) ?? changePct(oldPrice, final);
  const flags = flagsOf(p);
  return {
    id: num(p.id),
    code: pick(p, 'code'),
    name: pick(p, 'name'),
    manufacturer: pick(p, 'manufacturer'),
    category: pick(p, 'category'),
    segment: p.segment_name ?? p.segment ?? null,
    strategy: p.strategy_name ?? p.strategy ?? null,
    old_price: oldPrice,
    new_price: newPrice,
    manual_price: manual,
    final_price: final,
    change_abs: oldPrice != null && final != null ? Math.round((final - oldPrice) * 100) / 100 : num(p.change_abs),
    change_pct: change,
    margin_before: num(p.margin_before),
    margin_after: num(p.margin_after),
    market_min: num(p.market_min),
    competitor_count: num(p.competitor_count),
    cheapest: cheapestOf(p),
    rank_before: num(p.rank_before),
    rank_after: num(p.rank_after),
    status: STATUS_LABELS[p.status] || p.status || null,
    status_code: p.status || null,
    flags: flags.map((f) => FLAG_LABELS[f] || f).join(', ') || null,
    created_at: p.created_at || null,
  };
}

const PROPOSAL_COLUMNS = [
  { key: 'code', label: 'Kód', width: 18 },
  { key: 'name', label: 'Název', width: 40 },
  { key: 'manufacturer', label: 'Výrobce', width: 16 },
  { key: 'segment', label: 'Segment', width: 18 },
  { key: 'strategy', label: 'Strategie', width: 22 },
  { key: 'old_price', label: 'Původní cena', type: 'money' },
  { key: 'new_price', label: 'Navržená cena', type: 'money' },
  { key: 'manual_price', label: 'Ruční cena', type: 'money' },
  { key: 'final_price', label: 'Cena k exportu', type: 'money' },
  { key: 'change_abs', label: 'Změna Kč', type: 'money' },
  { key: 'change_pct', label: 'Změna %', type: 'percent' },
  { key: 'margin_before', label: 'Marže před %', type: 'percent' },
  { key: 'margin_after', label: 'Marže po %', type: 'percent' },
  { key: 'market_min', label: 'Minimum trhu', type: 'money' },
  { key: 'competitor_count', label: 'Počet konkurentů', type: 'number' },
  { key: 'cheapest', label: 'Nejlevnější konkurent', width: 20 },
  { key: 'rank_before', label: 'Pořadí před', type: 'number' },
  { key: 'rank_after', label: 'Pořadí po', type: 'number' },
  { key: 'status', label: 'Stav', width: 18 },
  { key: 'flags', label: 'Příznaky', width: 30 },
  { key: 'created_at', label: 'Vytvořeno', type: 'date' },
];

const SUMMARY_COLUMNS = [
  { key: 'group', label: 'Skupina', width: 12 },
  { key: 'value', label: 'Hodnota', width: 30 },
  { key: 'count', label: 'Počet návrhů', type: 'number' },
  { key: 'up', label: 'Zdražení', type: 'number' },
  { key: 'down', label: 'Zlevnění', type: 'number' },
  { key: 'avg_change_pct', label: 'Průměrná změna %', type: 'percent' },
  { key: 'change_abs_sum', label: 'Součet změn Kč', type: 'money' },
];

function summarize(rows) {
  const bucket = () => ({ count: 0, up: 0, down: 0, pctSum: 0, pctN: 0, absSum: 0 });
  const add = (b, r) => {
    b.count++;
    if (r.change_abs > 0) b.up++;
    else if (r.change_abs < 0) b.down++;
    if (r.change_pct != null) {
      b.pctSum += r.change_pct;
      b.pctN++;
    }
    if (r.change_abs != null) b.absSum += r.change_abs;
  };
  const out = (group, value, b) => ({
    group,
    value,
    count: b.count,
    up: b.up,
    down: b.down,
    avg_change_pct: b.pctN ? Math.round((b.pctSum / b.pctN) * 100) / 100 : null,
    change_abs_sum: Math.round(b.absSum * 100) / 100,
  });
  const total = bucket();
  const byStatus = new Map();
  const byStrategy = new Map();
  for (const r of rows) {
    add(total, r);
    const s = r.status || '—';
    if (!byStatus.has(s)) byStatus.set(s, bucket());
    add(byStatus.get(s), r);
    const st = r.strategy || '(bez strategie)';
    if (!byStrategy.has(st)) byStrategy.set(st, bucket());
    add(byStrategy.get(st), r);
  }
  const statusOrder = Object.values(STATUS_LABELS);
  const statusKeys = [...byStatus.keys()].sort((a, b) => {
    const ia = statusOrder.indexOf(a);
    const ib = statusOrder.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'cs');
  });
  const strategyKeys = [...byStrategy.keys()].sort((a, b) => byStrategy.get(b).count - byStrategy.get(a).count || a.localeCompare(b, 'cs'));
  return [
    out('Celkem', 'Všechny návrhy', total),
    ...statusKeys.map((k) => out('Stav', k, byStatus.get(k))),
    ...strategyKeys.map((k) => out('Strategie', k, byStrategy.get(k))),
  ];
}

/**
 * XLSX s návrhy cen: list „Návrhy“ (jeden řádek na návrh) a „Souhrn“ (počty podle stavu a strategie).
 * @param {object[]} proposals řádky jako z GET /api/v1/proposals (návrh + product {code, name, manufacturer, …}
 *   nebo zploštělá pole + strategy_name, segment_name, flags[])
 * @param {{date?: Date}} [opts] předá se do writeXlsx (deterministický výstup v testech)
 * @returns {Buffer}
 */
function proposalsXlsx(proposals, opts = {}) {
  const rows = (proposals || []).filter(Boolean).map(proposalRow);
  return writeXlsx(
    [
      { name: 'Návrhy', columns: PROPOSAL_COLUMNS, rows },
      { name: 'Souhrn', columns: SUMMARY_COLUMNS, rows: summarize(rows) },
    ],
    { creator: 'Cenotvorba', ...opts }
  );
}

const PRICELIST_COLUMNS = [
  { key: 'code', label: 'Kód', width: 18 },
  { key: 'ean', label: 'EAN', width: 15 },
  { key: 'name', label: 'Název', width: 40 },
  { key: 'manufacturer', label: 'Výrobce', width: 16 },
  { key: 'price', label: 'Cena s DPH', type: 'money' },
  { key: 'old_price', label: 'Původní cena', type: 'money' },
  { key: 'change_pct', label: 'Změna %', type: 'percent' },
  { key: 'lowest_30d', label: 'Nejnižší cena za 30 dní', type: 'money' },
  { key: 'vat_rate', label: 'DPH %', type: 'number' },
  { key: 'currency', label: 'Měna' },
  { key: 'strategy', label: 'Strategie', width: 22 },
  { key: 'segment', label: 'Segment', width: 18 },
  { key: 'changed_at', label: 'Změněno', type: 'date' },
  { key: 'proposal_id', label: 'ID návrhu', type: 'number' },
];

/**
 * XLSX ceník / změny z řádků exportRows (list „Ceník“).
 * @param {object[]} rows
 * @param {{sheet?: string, date?: Date}} [opts]
 * @returns {Buffer}
 */
function rowsXlsx(rows, opts = {}) {
  const { sheet = 'Ceník', ...rest } = opts;
  return writeXlsx([{ name: sheet, columns: PRICELIST_COLUMNS, rows: rows || [] }], { creator: 'Cenotvorba', ...rest });
}

module.exports = { proposalsXlsx, rowsXlsx, STATUS_LABELS, FLAG_LABELS };
