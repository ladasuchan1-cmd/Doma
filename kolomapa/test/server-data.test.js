'use strict';
// Data pro UI: buildSummary / buildKraj / buildListing nad in-memory databází.

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { jitter, KRAJE } = require('../src/geo');
const data = require('../src/server/data');
const { insertListing, sampleDb } = require('./server-helpers');

test('buildSummary: prázdná databáze má všech 14 krajů s nulami', () => {
  const db = openDb(':memory:');
  const s = data.buildSummary(db, { mode: 'static' });
  assert.equal(s.mode, 'static');
  assert.equal(s.lastRun, null);
  assert.deepEqual(Object.keys(s.kraje).sort(), Object.keys(KRAJE).sort());
  for (const k of Object.values(s.kraje)) {
    assert.equal(k.count, 0);
    assert.equal(k.deals, 0);
    assert.equal(k.medianPrice, null);
    assert.ok(k.name);
  }
  assert.deepEqual(s.topDeals, []);
  assert.equal(s.totals.bikes, 0);
  assert.equal(s.unlocated, 0);
  assert.equal(s.demo, 0);
  assert.equal(s.sources.bazos.label, 'Bazoš');
  assert.equal(data.buildSummary(db).mode, 'server');
});

test('buildSummary: součty, kraje, zdroje, nejvýhodnější nabídky', () => {
  const { db, ids } = sampleDb();
  const s = data.buildSummary(db);
  assert.equal(s.totals.active, 7); // vč. „nekola“, bez zmizelého
  assert.equal(s.totals.bikes, 6);
  assert.equal(s.totals.deals, 2); // dealJhm + dealPha (lowConf se nepočítá)
  assert.equal(s.kraje.JHM.count, 2);
  assert.equal(s.kraje.JHM.deals, 1);
  assert.equal(s.kraje.JHM.medianPrice, 30000);
  assert.equal(s.kraje.PHA.count, 2);
  assert.equal(s.kraje.PHA.deals, 1);
  assert.equal(s.kraje.STC.count, 1);
  assert.equal(s.kraje.MSK.count, 0);
  assert.equal(s.unlocated, 1);
  assert.equal(s.sources.sbazar.count, 1);
  assert.equal(s.sources.cyklobazar.count, 1);
  assert.deepEqual(
    s.topDeals.map((l) => l.id),
    [ids.dealJhm, ids.dealPha]
  );
  assert.equal(s.topDeals[0].k, 'JHM');
  assert.equal(s.thresholds.deal, data.DEAL_RATIO);
  assert.ok(s.newSince < s.generatedAt);
});

test('buildSummary: topDeals řadí podle deal_ratio a respektují limit', () => {
  const db = openDb(':memory:');
  const ratios = [0.8, 0.3, 0.6, 0.5, 0.84, 0.9];
  for (const d of ratios) insertListing(db, { deal_ratio: d, est_confidence: 0.9 });
  const s = data.buildSummary(db, { topDeals: 3 });
  assert.deepEqual(
    s.topDeals.map((l) => l.d),
    [0.3, 0.5, 0.6]
  );
  assert.equal(data.buildSummary(db).topDeals.length, 5); // 0.9 není výhodná
});

test('buildSummary: lastRun = poslední dokončený běh, nové od prvního běhu', () => {
  const db = openDb(':memory:');
  const now = new Date('2026-10-02T12:00:00Z');
  db.prepare("INSERT INTO runs (started_at, finished_at, status, trigger, stats) VALUES (?, ?, 'ok', 'cli', '{\"classified\":5}')").run('2026-10-02T03:00:00Z', '2026-10-02T04:00:00Z');
  db.prepare("INSERT INTO runs (started_at, status, trigger) VALUES (?, 'running', 'manual')").run('2026-10-02T11:00:00Z');
  insertListing(db, { first_seen_at: '2026-10-02T03:30:00Z' }); // z prvního běhu → není „nové“
  insertListing(db, { first_seen_at: '2026-10-02T11:30:00Z' }); // po prvním běhu → nové
  const s = data.buildSummary(db, { now });
  assert.equal(s.lastRun.status, 'ok');
  assert.equal(s.lastRun.stats.classified, 5);
  assert.equal(s.lastRun.finishedAt, '2026-10-02T04:00:00Z');
  assert.equal(s.newSince, '2026-10-02T04:00:00.000Z');
  assert.equal(s.totals.newToday, 1);
  assert.equal(s.kraje.JHM.newToday, 1);
});

test('buildKraj: jen aktivní kola daného kraje, kompaktní klíče bez prázdných hodnot', () => {
  const { db, ids } = sampleDb();
  const k = data.buildKraj(db, 'JHM');
  assert.equal(k.kraj, 'JHM');
  assert.equal(k.name, 'Jihomoravský kraj');
  assert.deepEqual(k.listings.map((l) => l.id).sort((a, b) => a - b), [ids.dealJhm, ids.highJhm].sort((a, b) => a - b));
  const l = k.listings.find((x) => x.id === ids.dealJhm);
  for (const key of ['id', 's', 'u', 't', 'p', 'la', 'lo', 'g', 'c', 'bt', 'b', 'm', 'y', 'e', 'el', 'eh', 'ec', 'em', 'd', 'mb', 'fx', 'f', 'de']) {
    assert.ok(key in l, `chybí klíč ${key}`);
  }
  for (const [key, v] of Object.entries(l)) {
    assert.ok(v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length), `prázdná hodnota u ${key}`);
  }
  assert.equal(l.s, 'bazos');
  assert.equal(l.b, 'Trek');
  assert.equal(l.y, 2021);
  assert.equal(l.d, 0.5);
  assert.deepEqual(l.fx, ['Stáří 4 roky: −40 %']);
  assert.equal('pa' in l, false); // prázdné params se vynechají
  assert.equal('ph' in l, false);
  assert.equal(data.buildKraj(db, 'jhm').listings.length, 2);
  assert.equal(data.buildKraj(db, 'XXX'), null);
  assert.equal(data.buildKraj(db, ''), null);
  assert.equal(data.buildKraj(db, 'MSK').listings.length, 0);
});

test('buildKraj: souřadnice prošlé jitter() jsou deterministické a zaokrouhlené na 5 míst', () => {
  const { db, ids } = sampleDb();
  const a = data.buildKraj(db, 'JHM').listings.find((x) => x.id === ids.dealJhm);
  const b = data.buildKraj(db, 'JHM').listings.find((x) => x.id === ids.dealJhm);
  assert.equal(a.la, b.la);
  assert.equal(a.lo, b.lo);
  const [la, lo] = jitter(49.1951, 16.6068, 'city', 'bazos:111');
  assert.equal(a.la, Math.round(la * 1e5) / 1e5);
  assert.equal(a.lo, Math.round(lo * 1e5) / 1e5);
  assert.notEqual(a.la, 49.1951); // posunuto (obec)
  assert.ok(Math.abs(a.la - 49.1951) < 0.01 && Math.abs(a.lo - 16.6068) < 0.01);
  // přesná poloha se neposouvá
  const db2 = openDb(':memory:');
  const id = insertListing(db2, { geo_precision: 'exact', lat: 49.123456789, lon: 16.987654321 });
  const e = data.buildKraj(db2, 'JHM').listings.find((x) => x.id === id);
  assert.equal(e.la, 49.12346);
  assert.equal(e.lo, 16.98765);
});

test('compactListing: nebezpečné URL zahodí, popis zkrátí, AI a varování přenese', () => {
  const { db, ids } = sampleDb();
  const evil = data.buildKraj(db, 'STC').listings.find((x) => x.id === ids.evil);
  assert.equal('u' in evil, false);
  assert.equal('ph' in evil, false);
  assert.equal(evil.t, '<img src=x onerror=alert(1)>'); // text se nemění – UI ho vkládá přes textContent
  const long = 'slovo '.repeat(600);
  const id = insertListing(db, {
    description: long,
    photo_url: 'https://img.bazos.cz/1.jpg',
    ai_czk: 15000,
    ai_low: 13000,
    ai_high: 17000,
    ai_condition: 'good',
    ai_notes: 'Opotřebený řetěz.',
    ai_input_hash: 'obsah-1',
    content_hash: 'obsah-1',
    features: { brand: 'Cube', isEbike: true, batteryWh: 625, motor: 'Bosch CX', warnings: ['Chybí doklad.'], wheelSize: '29"', frameSize: 'L', material: 'alu', groupset: 'Shimano Deore', condition: 'good' },
    params: { 'Velikost rámu': 'L' },
    views: 0,
  });
  const l = data.buildKraj(db, 'JHM').listings.find((x) => x.id === id);
  assert.ok(l.de.length <= data.DESC_MAX + 1);
  assert.ok(l.de.endsWith('…'));
  assert.equal(l.ph, 'https://img.bazos.cz/1.jpg');
  assert.deepEqual(l.ai, { e: 15000, l: 13000, h: 17000, c: 'good', n: 'Opotřebený řetěz.' });
  // inzerát se po AI nacenění změnil → zastaralý AI odhad se neposílá (výhodnost se počítá z modelu)
  db.prepare("UPDATE listings SET content_hash = 'obsah-2' WHERE id = ?").run(id);
  assert.equal('ai' in data.buildKraj(db, 'JHM').listings.find((x) => x.id === id), false);
  db.prepare("UPDATE listings SET content_hash = 'obsah-1' WHERE id = ?").run(id);
  assert.equal(l.eb, true);
  assert.equal(l.wh, 625);
  assert.equal(l.mo, 'Bosch CX');
  assert.deepEqual(l.w, ['Chybí doklad.']);
  assert.deepEqual(l.pa, { 'Velikost rámu': 'L' });
  assert.equal(l.v, 0); // nula se nevynechává
  assert.equal(l.ws, '29"');
  assert.equal(l.mat, 'alu');
  assert.equal(l.cond, 'good');
  assert.equal(l.gs, 'Shimano Deore');
});

test('buildListing: plný řádek + historie ceny, bez interních otisků', () => {
  const db = openDb(':memory:');
  const id = insertListing(db, { description: 'Dlouhý plný popis.', content_hash: 'abc' });
  db.prepare('INSERT INTO price_history (listing_id, at, price_czk) VALUES (?, ?, ?), (?, ?, ?)').run(id, '2026-09-01T00:00:00Z', 12000, id, '2026-09-10T00:00:00Z', 10000);
  const l = data.buildListing(db, id);
  assert.equal(l.id, id);
  assert.equal(l.description, 'Dlouhý plný popis.');
  assert.deepEqual(l.history, [
    { at: '2026-09-01T00:00:00Z', price: 12000 },
    { at: '2026-09-10T00:00:00Z', price: 10000 },
  ]);
  assert.equal(l.kraj_name, 'Jihomoravský kraj');
  assert.equal('content_hash' in l, false);
  assert.equal(typeof l.features, 'object');
  assert.equal(data.buildListing(db, 999999), null);
});

test('isDeal a truncate', () => {
  assert.equal(data.isDeal({ price_czk: 8000, est_czk: 10000, deal_ratio: 0.8, est_confidence: 0.5, est_method: 'comps' }), true);
  // bez srovnatelných / AI jen s vysokou jistotou
  assert.equal(data.isDeal({ price_czk: 8000, est_czk: 10000, deal_ratio: 0.8, est_confidence: 0.5, est_method: 'model' }), false);
  assert.equal(data.isDeal({ price_czk: 8000, est_czk: 10000, deal_ratio: 0.8, est_confidence: 0.65, est_method: 'model' }), true);
  assert.equal(
    data.isDeal({ price_czk: 8000, est_czk: 10000, deal_ratio: 0.8, est_confidence: 0.5, est_method: 'model', ai_czk: 11000, ai_input_hash: 'h', content_hash: 'h' }),
    true
  );
  // podezřele levné (pod 30 % odhadu) není výhodná nabídka
  assert.equal(data.isDeal({ price_czk: 2000, est_czk: 10000, deal_ratio: 0.2, est_confidence: 0.7, est_method: 'comps' }), false);
  assert.equal(data.isDeal({ price_czk: 8000, est_czk: 10000, deal_ratio: 0.8, est_confidence: 0.2 }), false);
  assert.equal(data.isDeal({ price_czk: null, est_czk: 10000, deal_ratio: 0.8, est_confidence: 0.9 }), false);
  assert.equal(data.truncate('krátký'), 'krátký');
  assert.equal(data.truncate(null), null);
  assert.equal(data.safeUrl('https://a.cz/x'), 'https://a.cz/x');
  assert.equal(data.safeUrl('ftp://a.cz/x'), null);
  assert.equal(data.safeUrl(' javascript:alert(1)'), null);
});

test('buildSummary: výhodné jen s podloženým odhadem; nejvýhodnější podle úspory × jistota; podezřele levné mimo', () => {
  const db = openDb(':memory:');
  // model bez srovnatelných s jistotou 0,5 → není výhodná
  insertListing(db, { price_czk: 8000, est_czk: 16000, deal_ratio: 0.5, est_confidence: 0.5, est_method: 'model' });
  // srovnatelné inzeráty → výhodná; úspora 40 000 × 0,7
  const big = insertListing(db, { price_czk: 60000, est_czk: 100000, deal_ratio: 0.6, est_confidence: 0.7, est_method: 'comps' });
  // menší úspora, nižší poměr → až druhá
  const small = insertListing(db, { price_czk: 3000, est_czk: 9000, deal_ratio: 0.33, est_confidence: 0.7, est_method: 'comps' });
  // aktuální AI odhad podloží i model
  const ai = insertListing(db, { price_czk: 5000, est_czk: 8000, deal_ratio: 0.625, est_confidence: 0.5, est_method: 'model', ai_czk: 9000, ai_input_hash: 'x', content_hash: 'x' });
  // podezřele levné (pod 30 %) se nepočítá
  insertListing(db, { price_czk: 500, est_czk: 20000, deal_ratio: 0.025, est_confidence: 0.8, est_method: 'comps' });
  const s = data.buildSummary(db);
  assert.equal(s.totals.deals, 3);
  assert.deepEqual(s.topDeals.map((l) => l.id), [big, small, ai]);
  assert.equal(s.thresholds.suspicious, data.SUSPICIOUS_RATIO);
  assert.equal(s.thresholds.evidenceConfidence, data.EVIDENCE_CONFIDENCE);
});
