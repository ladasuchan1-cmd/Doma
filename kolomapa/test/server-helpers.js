'use strict';
// Pomocníci pro testy serveru, dat a exportu: in-memory databáze s několika inzeráty.

const { openDb, bind } = require('../src/db');

let seq = 0;

/**
 * Vloží inzerát (rozumné výchozí hodnoty, přepisy v `o`). Vrací id.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} o sloupce tabulky listings (features/params/est_factors mohou být objekty)
 */
function insertListing(db, o = {}) {
  seq++;
  const now = new Date().toISOString();
  const row = {
    source: 'bazos',
    source_id: `t-${seq}`,
    url: `https://kolo.bazos.cz/inzerat/${seq}/`,
    title: `Testovací kolo ${seq}`,
    description: 'Popis kola.',
    price_czk: 10000,
    location_text: 'Brno',
    kraj: 'JHM',
    lat: 49.1951,
    lon: 16.6068,
    geo_precision: 'city',
    params: {},
    is_bike: 1,
    bike_type: 'mtb_hardtail',
    features: { brand: 'Trek', model: 'Marlin 7', modelYear: 2021 },
    est_czk: 12000,
    est_low: 10000,
    est_high: 14000,
    est_confidence: 0.7,
    est_method: 'model',
    est_factors: ['Stáří 4 roky: −40 %'],
    deal_ratio: 10000 / 12000,
    max_buy_czk: 7400,
    first_seen_at: now,
    last_seen_at: now,
    ...o,
  };
  const cols = Object.keys(row);
  const info = db.prepare(`INSERT INTO listings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => bind(row[c])));
  return Number(info.lastInsertRowid);
}

/** In-memory DB se sadou inzerátů pro testy. Vrací {db, ids}. */
function sampleDb() {
  const db = openDb(':memory:');
  const ids = {};
  ids.dealJhm = insertListing(db, { title: 'Specialized Stumpjumper Comp Alloy 2021, vel. L', price_czk: 30000, est_czk: 60000, deal_ratio: 0.5, est_confidence: 0.8, source: 'bazos', source_id: '111' });
  ids.highJhm = insertListing(db, { price_czk: 30000, est_czk: 20000, deal_ratio: 1.5, est_confidence: 0.9, source: 'sbazar', source_id: '222' });
  ids.notBike = insertListing(db, { is_bike: 0, title: 'Helma Giro' });
  ids.gone = insertListing(db, { gone_at: new Date().toISOString(), deal_ratio: 0.4, est_confidence: 0.9 });
  ids.lowConfPha = insertListing(db, { kraj: 'PHA', lat: 50.08, lon: 14.42, deal_ratio: 0.7, est_confidence: 0.3, location_text: 'Praha 4' });
  ids.dealPha = insertListing(db, { kraj: 'PHA', lat: 50.08, lon: 14.42, price_czk: 16000, est_czk: 20000, deal_ratio: 0.8, est_confidence: 0.6, source: 'aukro' });
  ids.unlocated = insertListing(db, { kraj: null, lat: null, lon: null, geo_precision: null, location_text: 'Česko', deal_ratio: 1 });
  ids.evil = insertListing(db, {
    kraj: 'STC',
    lat: 50.0,
    lon: 14.8,
    url: 'javascript:alert(1)',
    photo_url: 'javascript:alert(2)',
    title: '<img src=x onerror=alert(1)>',
    source: 'cyklobazar',
    deal_ratio: null,
    est_czk: null,
  });
  return { db, ids };
}

module.exports = { insertListing, sampleDb };
