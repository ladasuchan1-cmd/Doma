'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadContext, evaluateProduct, runPricing, simulate, explainProduct, latestProposal } = require('../src/engine/run.js');
const { NOW, createDb, insertCompetitor, insertProduct, insertOffer, insertSegment, insertStrategy, looseConfig } = require('./engine-helpers.js');

const count = (db, sql, ...args) => db.prepare(sql).get(...args).c;
const proposalsOf = (db, productId) => db.prepare('SELECT * FROM proposals WHERE product_id = ? ORDER BY id').all(productId);

/**
 * Scénář:
 *  p1 N7, trh 9000/9500 (+ vypnutý konkurent 5000) → Ležáky: −1 % pod min → 8910, auto schváleno
 *  p2 N8, bez trhu → Ležáky propadne (next) → Výchozí: bez trhu → fallback MOC 11 000
 *  p3 bez N, trh 5200 → Výchozí match_min → 5200
 *  p4 trh = naše cena → beze změny
 *  p5 zamčený → skip locked
 *  p6 neaktivní → nevyhodnocuje se
 *  p7 bez trhu i MOC → obě strategie propadnou → no_strategy
 */
function seed() {
  const db = createDb();
  const A = insertCompetitor(db, { name: 'VeloMarket.cz' });
  const B = insertCompetitor(db, { name: 'KoloShop.cz' });
  const C = insertCompetitor(db, { name: 'Vypnutý.cz', enabled: 0 });
  const ids = {};
  ids.p1 = insertProduct(db, { code: 'N7-1', price: 10000, purchase_price: 6000, msrp: 12000, attrs: { N: 'N7' } });
  ids.p2 = insertProduct(db, { code: 'N7-2', price: 10000, purchase_price: 6000, msrp: 11000, attrs: { N: 'N8' } });
  ids.p3 = insertProduct(db, { code: 'STD-1', price: 5000, purchase_price: 3000, msrp: 6000 });
  ids.p4 = insertProduct(db, { code: 'STD-2', price: 8000, purchase_price: 5000, msrp: 9000 });
  ids.p5 = insertProduct(db, { code: 'LOCK', price: 7000, purchase_price: 4000, locked: 1 });
  ids.p6 = insertProduct(db, { code: 'OFF', price: 7000, purchase_price: 4000, active: 0 });
  ids.p7 = insertProduct(db, { code: 'NOCOST', price: 4000 });
  insertOffer(db, ids.p1, A, 9000);
  insertOffer(db, ids.p1, B, 9500);
  insertOffer(db, ids.p1, C, 5000);
  insertOffer(db, ids.p3, A, 5200);
  insertOffer(db, ids.p4, A, 8000);
  insertOffer(db, ids.p5, A, 6000);
  insertOffer(db, ids.p6, A, 1);
  const segN = insertSegment(db, 'Ležáky N7/N8', { field: 'attrs.N', op: 'in', value: ['N7', 'N8'] });
  const st1 = insertStrategy(db, { name: 'Ležáky', segment_id: segN, priority: 10, config: looseConfig({ target: { mode: 'undercut_min', offset_pct: -1 }, approval: { auto: true, auto_max_change_pct: 15 } }) });
  const st2 = insertStrategy(db, { name: 'Výchozí', priority: 20, config: looseConfig({ target: { mode: 'match_min' }, fallback: { mode: 'msrp' } }) });
  const st0 = insertStrategy(db, { name: 'Vypnutá', priority: 1, enabled: 0, config: looseConfig({ target: { mode: 'fixed', fixed_price: 1 } }) });
  return { db, A, B, C, ids, segN, st1, st2, st0 };
}

test('run: loadContext – nastavení, segmenty, zapnuté strategie seřazené podle priority a id', () => {
  const { db, segN, st1, st2 } = seed();
  const later = insertStrategy(db, { name: 'Stejná priorita', priority: 10, config: {} });
  const badSeg = insertSegment(db, 'Rozbitý', { field: 'x', op: 'like', value: 1 });
  const ctx = loadContext(db, { now: NOW });
  assert.deepEqual(
    ctx.strategies.map((s) => s.id),
    [st1, later, st2]
  );
  assert.equal(ctx.settings.vat_rate_default, 21);
  assert.equal(ctx.segments.length, 2);
  assert.equal(typeof ctx.segmentById.get(segN).match, 'function');
  const bad = ctx.segmentById.get(badSeg);
  assert.ok(bad.error);
  assert.equal(bad.match({ x: 1 }), false, 'neplatný filtr segmentu neodpovídá ničemu');
  assert.equal(ctx.competitors.length, 3);
  assert.deepEqual(ctx.competitors[0].tags, []);
  assert.ok(ctx.now instanceof Date);
});

test('run: evaluateProduct – segment, propadnutí přes 2 strategie s vysvětlením, žádná strategie', () => {
  const { db, ids, segN, st1, st2 } = seed();
  const ctx = loadContext(db, { now: NOW });
  const prod = (id) => db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  // p2: Ležáky propadne (chybí trh) → Výchozí (fallback MOC)
  let r = evaluateProduct(ctx, prod(ids.p2), []);
  assert.deepEqual(r.segmentIds, [segN]);
  assert.equal(r.strategy.id, st2);
  assert.equal(r.decision.action, 'change');
  assert.equal(r.decision.new_price, 11000);
  assert.deepEqual(r.decision.flags, ['fallback']);
  assert.deepEqual(
    r.tried.map((t) => [t.strategy_id, t.result]),
    [
      [st1, 'fallthrough'],
      [st2, 'decided'],
    ]
  );
  assert.equal(r.decision.explain[0].step, 'fallthrough');
  assert.match(r.decision.explain[0].text, /^Strategie „Ležáky“ nepoužita: chybí trh/);
  // p3: mimo segment Ležáků
  r = evaluateProduct(ctx, prod(ids.p3), [{ competitor: 'X', price: 5200, in_stock: 1, enabled: true, tags: [], observed_at: NOW }]);
  assert.equal(r.tried[0].result, 'not_applicable');
  assert.equal(r.tried[0].code, 'segment');
  assert.equal(r.strategy.id, st2);
  assert.equal(r.decision.new_price, 5200);
  // p7: obě propadnou → žádná strategie
  r = evaluateProduct(ctx, prod(ids.p7), []);
  assert.equal(r.strategy, null);
  assert.equal(r.decision, null);
  assert.deepEqual(
    r.tried.map((t) => t.result),
    ['not_applicable', 'fallthrough']
  );
  assert.equal(r.lastFallthrough.reason, 'fallthrough');
});

test('run: podmínky a časové okno určují použitelnost strategie', () => {
  const db = createDb();
  const A = insertCompetitor(db, { name: 'A' });
  const p = insertProduct(db, { code: 'X', price: 9000, purchase_price: 5000, msrp: 12000 });
  const q = insertProduct(db, { code: 'Y', price: 11000, purchase_price: 5000, msrp: 12000 });
  insertOffer(db, p, A, 10000);
  insertOffer(db, q, A, 10000);
  const weekend = insertStrategy(db, { name: 'Víkend', priority: 1, config: looseConfig({ schedule: { weekdays: [6, 7] }, target: { mode: 'fixed', fixed_price: 7777 } }) });
  const recovery = insertStrategy(db, { name: 'Návrat marže', priority: 2, config: looseConfig({ conditions: { field: 'position', op: '=', value: 'cheapest' }, target: { mode: 'undercut_min', offset_abs: -10 } }) });
  const def = insertStrategy(db, { name: 'Výchozí', priority: 3, config: looseConfig({ target: { mode: 'keep' } }) });
  // pátek
  let res = runPricing(db, { now: NOW, dryRun: true });
  const byProduct = (r, id) => r.decisions.find((d) => d.product_id === id);
  assert.equal(byProduct(res, p).strategy_id, recovery, 'jsme nejlevnější → návrat marže');
  assert.equal(byProduct(res, p).new_price, 9990);
  assert.equal(byProduct(res, q).strategy_id, def, 'nejsme nejlevnější → podmínka nesplněna');
  const ctx = loadContext(db, { now: NOW });
  const t = evaluateProduct(ctx, db.prepare('SELECT * FROM products WHERE id = ?').get(q), []).tried;
  assert.deepEqual(
    t.map((x) => x.code),
    ['schedule', 'conditions', 'no_change']
  );
  // sobota v Praze
  res = runPricing(db, { now: '2026-09-26T08:00:00Z', dryRun: true });
  assert.equal(byProduct(res, p).strategy_id, weekend);
  assert.equal(byProduct(res, p).new_price, 7777);
  assert.equal(byProduct(res, q).strategy_id, weekend);
});

test('run: neplatná strategie v segmentu produktu → skip invalid_config (nepoužije se obecnější)', () => {
  const { db, ids, segN } = seed();
  const bad = insertStrategy(db, { name: 'Rozbitá', segment_id: segN, priority: 5, config: '{"limits":{"min_margin_pct":150}}' });
  const res = runPricing(db, { now: NOW, dryRun: true });
  const d = res.decisions.find((x) => x.product_id === ids.p1);
  assert.equal(d.strategy_id, bad);
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'invalid_config');
  assert.match(d.explain.map((e) => e.text).join(' '), /min_margin_pct/);
  // mimo segment se neplatná strategie neuplatní
  assert.equal(res.decisions.find((x) => x.product_id === ids.p3).action, 'change');
  assert.equal(res.stats.skipped.invalid_config, 2);
});

test('run: runPricing – běh, návrhy, automatické schválení a statistiky', () => {
  const { db, ids, st1, st2 } = seed();
  const res = runPricing(db, { trigger: 'api', now: NOW });
  assert.ok(res.run_id > 0);
  assert.equal(res.decisions, undefined);
  const s = res.stats;
  assert.equal(s.products, 6);
  assert.equal(s.evaluated, 5);
  assert.equal(s.changes, 3);
  assert.equal(s.up, 2);
  assert.equal(s.down, 1);
  assert.equal(s.no_change, 1);
  assert.deepEqual(s.skipped, { locked: 1 });
  assert.equal(s.no_strategy, 1);
  assert.equal(s.fallthrough, 2);
  assert.equal(s.auto_approved, 1);
  assert.equal(s.pending, 2);
  assert.deepEqual(s.by_strategy, {
    [st1]: { name: 'Ležáky', products: 1, changes: 1, up: 0, down: 1 },
    [st2]: { name: 'Výchozí', products: 4, changes: 2, up: 2, down: 0 },
  });
  assert.equal(s.margin_impact_abs, 90.91); // (−1090 + 1000 + 200) / 1,21
  assert.equal(s.superseded, 0);

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(res.run_id);
  assert.equal(run.status, 'done');
  assert.equal(run.trigger, 'api');
  assert.equal(run.started_at, NOW);
  assert.ok(run.finished_at);
  assert.equal(JSON.parse(run.stats).changes, 3);

  assert.equal(count(db, 'SELECT COUNT(*) c FROM proposals'), 3);
  const [p1] = proposalsOf(db, ids.p1);
  assert.equal(p1.status, 'approved');
  assert.equal(p1.decided_by, 'auto');
  assert.equal(p1.decided_at, NOW);
  assert.equal(p1.old_price, 10000);
  assert.equal(p1.new_price, 8910);
  assert.equal(p1.target_price, 8910);
  assert.equal(p1.reference_price, 9000);
  assert.equal(p1.market_min, 9000);
  assert.equal(p1.competitor_count, 2, 'vypnutý konkurent se nepočítá');
  assert.equal(p1.rank_before, 3);
  assert.equal(p1.rank_after, 1);
  assert.equal(p1.change_abs, -1090);
  assert.equal(p1.change_pct, -10.9);
  assert.equal(p1.strategy_id, st1);
  assert.ok(p1.segment_id > 0);
  assert.deepEqual(JSON.parse(p1.flags), []);
  assert.ok(JSON.parse(p1.explain).some((e) => /Automaticky schváleno/.test(e.text)));
  const [p2] = proposalsOf(db, ids.p2);
  assert.equal(p2.status, 'pending');
  assert.equal(p2.decided_at, null);
  assert.deepEqual(JSON.parse(p2.flags), ['fallback']);
  assert.equal(p2.segment_id, null);
  assert.equal(proposalsOf(db, ids.p3)[0].new_price, 5200);
  for (const k of ['p4', 'p5', 'p6', 'p7']) assert.equal(proposalsOf(db, ids[k]).length, 0, k);
});

test('run: supersede – starší pending/approved návrhy vyhodnocených produktů', () => {
  const { db, ids } = seed();
  const r1 = runPricing(db, { now: NOW }).run_id;
  const [p1a] = proposalsOf(db, ids.p1); // approved (auto)
  const [p2a] = proposalsOf(db, ids.p2);
  const [p3a] = proposalsOf(db, ids.p3);
  db.prepare("UPDATE proposals SET status = 'exported', exported_at = ? WHERE id = ?").run(NOW, p2a.id);
  const ins = db.prepare("INSERT INTO proposals (run_id, product_id, new_price, status, created_at) VALUES (?, ?, ?, ?, ?)");
  const p4old = Number(ins.run(r1, ids.p4, 7990, 'approved', NOW).lastInsertRowid); // p4 teď beze změny
  const p5rej = Number(ins.run(r1, ids.p5, 6990, 'rejected', NOW).lastInsertRowid);
  const p6old = Number(ins.run(r1, ids.p6, 6990, 'pending', NOW).lastInsertRowid); // neaktivní produkt

  const res2 = runPricing(db, { now: NOW });
  const st = (id) => db.prepare('SELECT status FROM proposals WHERE id = ?').get(id).status;
  // stejné rozhodnutí → stejný návrh se ponechá (přesune do nového běhu), stav zůstane (ops-1)
  assert.equal(st(p1a.id), 'approved');
  assert.equal(st(p2a.id), 'exported', 'exportované zůstávají');
  assert.equal(st(p3a.id), 'pending');
  assert.equal(st(p4old), 'superseded', 'produkt, který teď nemá změnu');
  assert.equal(st(p5rej), 'rejected');
  assert.equal(st(p6old), 'superseded', 'neaktivní produkt: úplný běh jeho návrh zneplatní (money-4)');
  assert.equal(res2.stats.superseded, 2);
  assert.equal(res2.stats.kept, 2);
  assert.equal(proposalsOf(db, ids.p1).filter((p) => p.run_id === res2.run_id).length, 1);
  assert.equal(proposalsOf(db, ids.p1).length, 1, 'žádná kopie návrhu');

  // běh omezený na p3 (jiná aktuální cena → jiný návrh) nahradí jen návrhy p3
  db.prepare('UPDATE products SET price = price + 100 WHERE id = ?').run(ids.p3);
  const res3 = runPricing(db, { now: NOW, productIds: [ids.p3] });
  assert.equal(res3.stats.products, 1);
  assert.equal(res3.stats.superseded, 1);
  const p1new = proposalsOf(db, ids.p1).find((p) => p.run_id === res2.run_id);
  assert.equal(p1new.status, 'approved');
  const p3list = proposalsOf(db, ids.p3);
  assert.equal(p3list.at(-1).run_id, res3.run_id);
  assert.equal(p3list.at(-1).status, 'pending');
  assert.equal(p3list.at(-2).status, 'superseded');
});

test('run: productIds omezuje běh (neaktivní produkty se nevyhodnocují ani na vyžádání)', () => {
  const { db, ids } = seed();
  const res = runPricing(db, { now: NOW, productIds: [ids.p1, ids.p6, 99999] });
  assert.equal(res.stats.products, 1);
  assert.equal(res.stats.changes, 1);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM proposals'), 1);
  const empty = runPricing(db, { now: NOW, productIds: [] });
  assert.equal(empty.stats.products, 0);
});

test('run: dryRun nic nezapisuje a vrací rozhodnutí', () => {
  const { db, ids } = seed();
  runPricing(db, { now: NOW });
  const runsBefore = count(db, 'SELECT COUNT(*) c FROM runs');
  const snapshot = JSON.stringify(db.prepare('SELECT * FROM proposals ORDER BY id').all());
  const res = runPricing(db, { now: NOW, dryRun: true });
  assert.equal(res.run_id, null);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM runs'), runsBefore);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM proposals ORDER BY id').all()), snapshot);
  assert.equal(res.decisions.length, 5);
  assert.equal(res.stats.changes, 3);
  assert.equal(res.decisions.find((d) => d.product_id === ids.p1).new_price, 8910);
});

test('run: chyba během běhu → vše vráceno, běh zapsán se stavem error', () => {
  const { db } = seed();
  db.exec('DROP TABLE proposals');
  assert.throws(() => runPricing(db, { now: NOW, trigger: 'schedule' }), /proposals/);
  const runs = db.prepare('SELECT * FROM runs').all();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'error');
  assert.equal(runs[0].trigger, 'schedule');
  assert.match(runs[0].error, /proposals/);
  assert.ok(runs[0].finished_at);
});

test('run: simulate – ad-hoc strategie nad segmentem / filtrem, bez zápisu', () => {
  const { db, ids, segN } = seed();
  const cfg = looseConfig({ target: { mode: 'match_min' } });
  let res = simulate(db, { config: cfg, segment_id: segN, now: NOW });
  assert.deepEqual(res.errors, []);
  assert.equal(res.stats.products, 2);
  assert.equal(res.stats.changes, 1);
  assert.equal(res.stats.down, 1);
  assert.equal(res.stats.avg_change_pct, -10);
  assert.deepEqual(res.stats.skipped, { fallthrough: 1 });
  assert.equal(res.stats.margin_impact_abs, -826.45);
  assert.equal(res.decisions.length, 2);
  assert.equal(res.decisions[0].code, 'N7-1');
  assert.equal(res.decisions[0].action, 'change');
  assert.equal(res.decisions[0].segment_id, segN);
  assert.equal(res.decisions[1].code, 'N7-2');
  assert.equal(res.decisions[1].reason, 'fallthrough');
  assert.equal(count(db, 'SELECT COUNT(*) c FROM proposals'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM runs'), 0);

  // filtr místo segmentu; ostatní strategie (Ležáky, Výchozí) se ignorují
  res = simulate(db, { config: looseConfig({ target: { mode: 'match_min' }, approval: { auto: true, auto_max_change_pct: 3 } }), filter: { field: 'code', op: 'starts_with', value: 'STD' }, now: NOW });
  assert.equal(res.stats.products, 2);
  assert.equal(res.stats.changes, 1);
  assert.equal(res.stats.no_change, 1);
  assert.deepEqual(res.stats.flags, { big_change: 1 });
  assert.equal(res.stats.auto_approved, 0);
  assert.equal(res.decisions[0].code, 'STD-1');
  assert.equal(res.decisions[0].new_price, 5200);

  // bez rozsahu = všechny aktivní produkty; limit
  res = simulate(db, { config: cfg, limit: 1, now: NOW });
  assert.equal(res.stats.products, 6);
  // limit zvlášť pro změny a přeskočené (contract-6) – přeskočené se nesmí odříznout za změnami
  assert.equal(res.decisions.filter((d) => d.action === 'change').length, 1);
  assert.equal(res.decisions.filter((d) => d.action === 'skip').length, 1);
  assert.equal(res.truncated.changes, true);
  assert.equal(res.stats.skipped.locked, 1);

  // podmínky strategie v simulaci
  res = simulate(db, { config: looseConfig({ target: { mode: 'match_min' }, conditions: { field: 'code', op: '=', value: 'N7-1' } }), now: NOW });
  assert.equal(res.stats.changes, 1);
  assert.equal(res.stats.skipped.conditions, 5);

  // chyby
  assert.ok(simulate(db, { config: { limits: { min_margin_pct: 200 } } }).errors.length > 0);
  assert.ok(simulate(db, { config: {}, segment_id: 12345 }).errors[0].includes('neexistuje'));
  assert.ok(simulate(db, { config: {}, filter: { field: 'x', op: '??' } }).errors.length > 0);
  assert.ok(ids.p1);
});

test('run: explainProduct a latestProposal', () => {
  const { db, ids, segN, st1, st2 } = seed();
  const e = explainProduct(db, ids.p2, { now: NOW });
  assert.equal(e.view.code, 'N7-2');
  assert.equal(e.view.market_count, 0);
  assert.deepEqual(e.segments, [{ id: segN, name: 'Ležáky N7/N8' }]);
  assert.equal(e.strategy.id, st2);
  assert.equal(e.strategy.name, 'Výchozí');
  assert.equal(e.decision.new_price, 11000);
  assert.equal(e.tried[0].strategy_id, st1);
  assert.equal(e.tried[0].result, 'fallthrough');
  assert.ok(JSON.stringify(e)); // serializovatelné (bez funkcí v datech)
  const off = explainProduct(db, ids.p6, { now: NOW });
  assert.equal(off.view.active, 0, 'i neaktivní produkt lze vysvětlit');
  const none = explainProduct(db, ids.p7, { now: NOW });
  assert.equal(none.strategy, null);
  assert.equal(none.decision.reason, 'fallthrough');
  assert.equal(explainProduct(db, 424242, { now: NOW }), null);

  assert.equal(latestProposal(db, ids.p1), null);
  runPricing(db, { now: NOW });
  runPricing(db, { now: NOW });
  const lp = latestProposal(db, ids.p1);
  assert.equal(lp.status, 'approved');
  assert.deepEqual(lp.flags, []);
  assert.ok(Array.isArray(lp.explain) && lp.explain.length > 3);
  assert.equal(lp.run_id, db.prepare('SELECT MAX(id) m FROM runs').get().m);
});

test('run: evaluateProduct se „syrovými“ řádky strategií a segmentů (podmínky se neignorují)', () => {
  const { db, ids, segN } = seed();
  const rows = db.prepare('SELECT * FROM strategies ORDER BY priority, id').all();
  const cond = { id: 99, name: 'Jen levné', segment_id: null, priority: 0, enabled: 1, config: JSON.stringify(looseConfig({ conditions: { field: 'price', op: '<', value: 100 }, target: { mode: 'fixed', fixed_price: 1 } })) };
  const ctx = { now: NOW, settings: {}, segments: db.prepare('SELECT * FROM segments').all(), strategies: [cond, ...rows] };
  const p1 = db.prepare('SELECT * FROM products WHERE id = ?').get(ids.p1);
  const offers = [{ competitor: 'A', price: 9000, in_stock: 1, enabled: true, tags: [], observed_at: NOW }];
  const r = evaluateProduct(ctx, p1, offers);
  assert.deepEqual(r.segmentIds, [segN]);
  assert.deepEqual(
    r.tried.map((t) => t.code),
    ['conditions', 'disabled', 'change']
  );
  assert.equal(r.decision.new_price, 8910);
});
