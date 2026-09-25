'use strict';
// Pomocníci pro testy enginu (není to testovací soubor – nekončí na .test.js).

const { openDb, nowIso } = require('../src/db.js');
const { nameKey, codeKey } = require('../src/util/keys.js');

const NOW = '2026-09-25T10:00:00.000Z'; // pátek 12:00 v Praze (letní čas)

/** Nabídka konkurence ve tvaru SPEC §6.1. */
function offer(competitor, price, extra = {}) {
  return {
    competitor_id: extra.competitor_id ?? null,
    competitor,
    label: null,
    tags: [],
    enabled: true,
    price,
    shipping: null,
    in_stock: 1,
    delivery_days: 0,
    url: null,
    name: null,
    observed_at: NOW,
    ...extra,
  };
}

/** Produkt s rozumnými výchozími hodnotami. */
function product(extra = {}) {
  return {
    id: 1,
    code: 'P1',
    name: 'Kolo',
    manufacturer: 'Focus',
    price: 10000,
    purchase_price: 6000,
    vat_rate: 21,
    msrp: 12000,
    stock: 5,
    sales_30: 1,
    sales_90: 3,
    attrs: {},
    active: 1,
    locked: 0,
    locked_until: null,
    min_price: null,
    max_price: null,
    price_changed_at: null,
    ...extra,
  };
}

// Volné limity a bez zaokrouhlení – pro testy čistého výpočtu cíle
const LOOSE = {
  min_margin_pct: null,
  max_above_msrp_pct: null,
  max_decrease_pct: null,
  max_increase_pct: null,
  min_change_pct: 0,
  min_change_abs: 0,
};
const NO_ROUND = { mode: 'none', direction: 'down' };

function looseConfig(over = {}) {
  return {
    ...over,
    limits: { ...LOOSE, ...(over.limits || {}) },
    rounding: over.rounding || NO_ROUND,
    approval: { auto_max_change_pct: null, ...(over.approval || {}) },
  };
}

// ---------------------------------------------------------------------------------------------
// DB

function createDb() {
  return openDb(':memory:');
}

function insertCompetitor(db, { name, label = null, enabled = 1, tags = [] }) {
  return Number(
    db
      .prepare('INSERT INTO competitors (name, name_key, label, enabled, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, nameKey(name), label, enabled ? 1 : 0, JSON.stringify(tags), NOW).lastInsertRowid
  );
}

function insertProduct(db, p) {
  const row = {
    code: p.code,
    code_key: codeKey(p.code),
    ean: p.ean ?? null,
    name: p.name ?? p.code,
    manufacturer: p.manufacturer ?? null,
    category: p.category ?? null,
    purchase_price: p.purchase_price ?? null,
    price: p.price ?? null,
    vat_rate: p.vat_rate ?? 21,
    msrp: p.msrp ?? null,
    stock: p.stock ?? 5,
    sales_30: p.sales_30 ?? 0,
    sales_90: p.sales_90 ?? 0,
    attrs: JSON.stringify(p.attrs || {}),
    active: p.active ?? 1,
    locked: p.locked ?? 0,
    locked_until: p.locked_until ?? null,
    min_price: p.min_price ?? null,
    max_price: p.max_price ?? null,
    price_changed_at: p.price_changed_at ?? null,
  };
  const cols = Object.keys(row);
  return Number(
    db
      .prepare(`INSERT INTO products (${cols.join(', ')}, created_at, updated_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`)
      .run(...Object.values(row), NOW, NOW).lastInsertRowid
  );
}

function insertOffer(db, productId, competitorId, price, extra = {}) {
  db.prepare(
    'INSERT INTO offers (product_id, competitor_id, price, shipping, in_stock, delivery_days, url, name, observed_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(productId, competitorId, price, extra.shipping ?? null, extra.in_stock === undefined ? 1 : extra.in_stock, null, null, extra.name ?? null, extra.observed_at ?? NOW, NOW);
}

function insertSegment(db, name, filter) {
  return Number(db.prepare('INSERT INTO segments (name, filter, created_at, updated_at) VALUES (?, ?, ?, ?)').run(name, JSON.stringify(filter), NOW, NOW).lastInsertRowid);
}

function insertStrategy(db, { name, segment_id = null, priority = 100, enabled = 1, config = {} }) {
  return Number(
    db
      .prepare('INSERT INTO strategies (name, segment_id, priority, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, segment_id, priority, enabled ? 1 : 0, typeof config === 'string' ? config : JSON.stringify(config), NOW, NOW).lastInsertRowid
  );
}

module.exports = {
  NOW,
  offer,
  product,
  LOOSE,
  NO_ROUND,
  looseConfig,
  createDb,
  insertCompetitor,
  insertProduct,
  insertOffer,
  insertSegment,
  insertStrategy,
  nowIso,
};
