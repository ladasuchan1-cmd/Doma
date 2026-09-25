'use strict';
// Pomocníci pro testy exportu (test/export-*.test.js). Sám o sobě není testem.
// Databázi plníme přímo SQL – testy exportu nezávisí na modulu engine.

const { openDb } = require('../src/db');

const NOW = '2026-09-25T10:00:00.000Z';
const T0 = '2026-09-20T08:00:00.000Z';

/** Posun ISO času o d dní (záporně = do minulosti). */
function daysAgo(d, from = NOW) {
  return new Date(new Date(from).getTime() - d * 86400000).toISOString();
}

function freshDb() {
  return openDb(':memory:');
}

/**
 * Vloží produkt. Vrací id.
 * @param {object} db
 * @param {object} p {code, ean?, name?, manufacturer?, price?, vat_rate?, active?, purchase_price?, price_changed_at?}
 */
function addProduct(db, p) {
  const code = p.code;
  const r = db
    .prepare(
      `INSERT INTO products (code, code_key, ean, ean_key, name, manufacturer, price, vat_rate, purchase_price, active, price_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      code,
      String(code).trim().toUpperCase().replace(/\s+/g, ''),
      p.ean ?? null,
      p.ean ? String(p.ean).replace(/^0+/, '') : null,
      p.name ?? `Produkt ${code}`,
      p.manufacturer ?? 'Trek',
      p.price ?? null,
      p.vat_rate ?? null,
      p.purchase_price ?? null,
      p.active ?? 1,
      p.price_changed_at ?? null,
      T0,
      T0
    );
  return Number(r.lastInsertRowid);
}

function addSegment(db, name) {
  return Number(db.prepare("INSERT INTO segments (name, filter, created_at, updated_at) VALUES (?, '{}', ?, ?)").run(name, T0, T0).lastInsertRowid);
}

function addStrategy(db, name, segmentId = null) {
  return Number(
    db.prepare("INSERT INTO strategies (name, segment_id, priority, enabled, config, created_at, updated_at) VALUES (?, ?, 10, 1, '{}', ?, ?)").run(name, segmentId, T0, T0)
      .lastInsertRowid
  );
}

function addRun(db, at = T0) {
  return Number(db.prepare("INSERT INTO runs (started_at, finished_at, status, trigger, stats) VALUES (?, ?, 'done', 'manual', '{}')").run(at, at).lastInsertRowid);
}

/**
 * Vloží návrh. Vrací id.
 * @param {object} p {run_id, product_id, old_price, new_price, status='approved', manual_price?, strategy_id?, segment_id?, change_pct?, created_at?, decided_at?}
 */
function addProposal(db, p) {
  const oldPrice = p.old_price ?? null;
  const change = p.change_pct !== undefined ? p.change_pct : oldPrice ? Math.round(((p.new_price - oldPrice) / oldPrice) * 10000) / 100 : null;
  const r = db
    .prepare(
      `INSERT INTO proposals (run_id, product_id, strategy_id, segment_id, old_price, new_price, change_abs, change_pct, status, flags, explain,
         manual_price, created_at, decided_at, decided_by, market_min, competitor_count, rank_before, rank_after, margin_before, margin_after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      p.run_id,
      p.product_id,
      p.strategy_id ?? null,
      p.segment_id ?? null,
      oldPrice,
      p.new_price,
      oldPrice != null ? p.new_price - oldPrice : null,
      change,
      p.status ?? 'approved',
      JSON.stringify(p.flags ?? []),
      p.manual_price ?? null,
      p.created_at ?? T0,
      p.decided_at ?? (p.status === 'pending' ? null : T0),
      p.decided_by ?? null,
      p.market_min ?? null,
      p.competitor_count ?? null,
      p.rank_before ?? null,
      p.rank_after ?? null,
      p.margin_before ?? null,
      p.margin_after ?? null
    );
  return Number(r.lastInsertRowid);
}

function addHistory(db, productId, price, at, source = 'import') {
  db.prepare('INSERT INTO price_history (product_id, price, source, at) VALUES (?, ?, ?, ?)').run(productId, price, source, at);
}

/**
 * Typická sada dat: 4 aktivní produkty + 1 neaktivní, strategie/segment, schválené i čekající návrhy.
 * @returns {object} id vytvořených záznamů
 */
function seedBasic(db) {
  const seg = addSegment(db, 'Ležáky N7/N8');
  const strat = addStrategy(db, 'Medián trhu −2 %', seg);
  const run1 = addRun(db, '2026-09-19T08:00:00.000Z');
  const run2 = addRun(db, T0);
  const a = addProduct(db, { code: 'KOLO-TREK-FX2-M', ean: '8591234567890', name: 'Trek FX 2 M', price: 19990, vat_rate: 21, price_changed_at: daysAgo(40) });
  const b = addProduct(db, { code: 'PLAST-SCHW-29-2.35', ean: '4026495999999', name: 'Schwalbe Nobby Nic 29×2,35', manufacturer: 'Schwalbe', price: 949, vat_rate: 21 });
  const c = addProduct(db, { code: 'HELMA-ABUS', ean: null, name: 'Přilba Abus', manufacturer: 'Abus', price: 2490 });
  const d = addProduct(db, { code: 'BEZ-CENY', name: 'Produkt bez ceny', price: null });
  const e = addProduct(db, { code: 'NEAKTIVNI', name: 'Neaktivní produkt', price: 5000, active: 0 });
  // starší schválený návrh pro A (v reálu by byl superseded – test „jen nejnovější“)
  const pOldA = addProposal(db, { run_id: run1, product_id: a, old_price: 19990, new_price: 19490, strategy_id: strat, segment_id: seg });
  const pA = addProposal(db, { run_id: run2, product_id: a, old_price: 19990, new_price: 18990, strategy_id: strat, segment_id: seg });
  const pB = addProposal(db, { run_id: run2, product_id: b, old_price: 949, new_price: 999, manual_price: 899, strategy_id: strat });
  const pC = addProposal(db, { run_id: run2, product_id: c, old_price: 2490, new_price: 2390, status: 'pending', strategy_id: strat });
  const pE = addProposal(db, { run_id: run2, product_id: e, old_price: 5000, new_price: 4500, strategy_id: strat });
  return { seg, strat, run1, run2, a, b, c, d, e, pOldA, pA, pB, pC, pE };
}

module.exports = { NOW, T0, daysAgo, freshDb, addProduct, addSegment, addStrategy, addRun, addProposal, addHistory, seedBasic };
