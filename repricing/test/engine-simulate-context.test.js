'use strict';
// Zkušební přecenění celé sady (C2): runPricing({dryRun}) nic nezapisuje; simulace strategie v kontextu celé sady
// zapnutých strategií (simulate({strategy_id})) hlásí jen produkty, o kterých by strategie rozhodla.

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./engine-helpers');
const { runPricing, simulate } = require('../src/engine/run');

function setup() {
  const db = H.createDb();
  const c = H.insertCompetitor(db, { name: 'VeloMarket.cz' });
  const ids = {};
  const mk = (code, manufacturer, price, market) => {
    ids[code] = H.insertProduct(db, { code, manufacturer, price, purchase_price: 5000, msrp: null });
    if (market != null) H.insertOffer(db, ids[code], c, market);
  };
  mk('F1', 'Focus', 10000, 9800);
  mk('F2', 'Focus', 12000, 11500);
  mk('C1', 'Cannondale', 10000, 9500);
  mk('C2', 'Cannondale', 20000, 18000);
  mk('X', 'Kellys', 9000, null); // bez trhu
  const focus = H.insertSegment(db, 'Focus', { field: 'manufacturer', op: '=', value: 'Focus' });
  const A = H.insertStrategy(db, { name: 'Focus podstřel', segment_id: focus, priority: 10, config: H.looseConfig({ target: { mode: 'undercut_min', offset_pct: -1 } }) });
  const B = H.insertStrategy(db, { name: 'Všechno medián', priority: 20, config: H.looseConfig({ target: { mode: 'market_median', offset_pct: -2 }, fallback: { mode: 'next' } }) });
  const D = H.insertStrategy(db, { name: 'Vypnutá', priority: 5, enabled: 0, config: H.looseConfig({ target: { mode: 'match_min' }, fallback: { mode: 'next' } }) });
  return { db, ids, focus, A, B, D };
}

const codes = (res) => res.decisions.map((d) => d.code).sort();

test('C2 runPricing dryRun: celá sada strategií bez zápisu (běh, návrhy)', () => {
  const { db } = setup();
  const res = runPricing(db, { now: H.NOW, dryRun: true });
  assert.equal(res.run_id, null);
  assert.equal(res.stats.products, 5);
  assert.equal(res.stats.changes, 4);
  assert.equal(res.stats.by_strategy[String(1)].changes + res.stats.by_strategy[String(2)].changes, 4);
  assert.equal(res.decisions.length, 4, 'rozhodnutí všech produktů, o kterých nějaká strategie rozhodla (i beze změny)');
  assert.equal(res.stats.no_strategy, 1, 'X bez trhu – žádná strategie nerozhodla');
  assert.equal(db.prepare('SELECT count(*) AS c FROM runs').get().c, 0);
  assert.equal(db.prepare('SELECT count(*) AS c FROM proposals').get().c, 0);
  // skutečný běh pak dá stejné změny
  const real = runPricing(db, { now: H.NOW });
  assert.equal(real.stats.changes, res.stats.changes);
});

test('C2 simulate se strategy_id: upravený config v kontextu celé sady, jen produkty této strategie', () => {
  const { db, ids, B } = setup();
  const res = simulate(db, { strategy_id: B, config: H.looseConfig({ target: { mode: 'market_median', offset_pct: -5 }, fallback: { mode: 'next' } }), now: H.NOW });
  assert.deepEqual(res.errors, []);
  assert.equal(res.context, true);
  assert.deepEqual(codes(res), ['C1', 'C2'], 'Focus rozhodla dřívější strategie, X nemá trh');
  assert.equal(res.stats.claimed_by_earlier, 2);
  assert.equal(res.stats.fallthrough, 1, 'X: chybí trh → propadne');
  assert.equal(res.stats.products, 5);
  assert.equal(res.stats.evaluated, 2);
  assert.equal(res.stats.strategy, 'Všechno medián');
  // upravený config (−5 %) se opravdu použil
  const c1 = res.decisions.find((d) => d.product_id === ids.C1);
  assert.equal(c1.new_price, 9025);
  assert.equal(c1.strategy_id, B);
  // bez configu = uložený config strategie (−2 %)
  const saved = simulate(db, { strategy_id: B, now: H.NOW });
  assert.equal(saved.decisions.find((d) => d.product_id === ids.C1).new_price, 9310);
  // nic se nezapsalo
  assert.equal(db.prepare('SELECT count(*) AS c FROM proposals').get().c, 0);
});

test('C2 simulate se strategy_id: vypnutá strategie se vloží na místo své priority; priorita jde přepsat', () => {
  const { db, D, B } = setup();
  // D (priorita 5, vypnutá) by předběhla všechny → rozhodne o všech produktech s trhem
  const res = simulate(db, { strategy_id: D, now: H.NOW });
  assert.equal(res.context, true);
  assert.deepEqual(codes(res), ['C1', 'C2', 'F1', 'F2']);
  assert.equal(res.stats.claimed_by_earlier, 0);
  // B s prioritou 1 předběhne i strategii pro Focus
  const early = simulate(db, { strategy_id: B, priority: 1, now: H.NOW });
  assert.deepEqual(codes(early), ['C1', 'C2', 'F1', 'F2']);
  assert.equal(early.stats.claimed_by_earlier, 0);
});

test('C2 simulate se strategy_id: segment strategie omezuje počty; chyby', () => {
  const { db, A, focus } = setup();
  const res = simulate(db, { strategy_id: A, now: H.NOW });
  assert.deepEqual(codes(res), ['F1', 'F2']);
  assert.equal(res.stats.products, 2, 'jen produkty segmentu Focus');
  assert.equal(res.stats.claimed_by_earlier, 0);
  assert.equal(res.stats.segment, 'Focus');
  assert.ok(focus > 0);
  const bad = simulate(db, { strategy_id: 999, now: H.NOW });
  assert.equal(bad.context, true);
  assert.ok(bad.errors.length && /neexistuje/.test(bad.errors[0]));
  const badCfg = simulate(db, { strategy_id: A, config: { target: { mode: 'nesmysl' } }, now: H.NOW });
  assert.ok(badCfg.errors.length);
  // bez strategy_id: dosavadní chování (ad-hoc strategie nad rozsahem, ostatní strategie se ignorují)
  const adhoc = simulate(db, { config: H.looseConfig({ target: { mode: 'match_min' } }), now: H.NOW });
  assert.equal(adhoc.context, false);
  for (const code of ['C1', 'C2', 'F1', 'F2']) assert.ok(codes(adhoc).includes(code), code);
  assert.equal(adhoc.stats.claimed_by_earlier, undefined);
});
