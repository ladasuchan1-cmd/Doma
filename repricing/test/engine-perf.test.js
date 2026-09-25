'use strict';
// Výkon: přecenění 30 000 produktů × 8 konkurentů musí doběhnout do 5 s (SPEC §10).
// Na pomalých strojích lze aserci času vypnout proměnnou CI_SLOW (test samotný poběží).
const test = require('node:test');
const assert = require('node:assert/strict');
const { tx } = require('../src/db.js');
const { runPricing } = require('../src/engine/run.js');
const { STRATEGY_PRESETS } = require('../src/engine/presets.js');
const { NOW, createDb, insertCompetitor, insertSegment, insertStrategy } = require('./engine-helpers.js');

const PRODUCTS = 30000;
const COMPETITORS = 8;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('perf: runPricing 30 000 produktů × 8 konkurentů < 5 s', { timeout: 120000 }, () => {
  const db = createDb();
  const rand = rng(7);
  const comp = [];
  for (let i = 0; i < COMPETITORS; i++) comp.push(insertCompetitor(db, { name: `Konkurent${i}.cz`, tags: i % 3 === 0 ? ['marketplace'] : [] }));
  const brands = ['Cannondale', 'Santa Cruz', 'Focus', 'Kellys', 'Shimano', 'SRAM', 'Abus', 'POC'];
  tx(db, () => {
    const ip = db.prepare(
      `INSERT INTO products (code, code_key, name, manufacturer, category, purchase_price, price, vat_rate, msrp, stock, sales_30, sales_90, attrs, active, price_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 21, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    );
    const io = db.prepare('INSERT INTO offers (product_id, competitor_id, price, shipping, in_stock, observed_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (let i = 1; i <= PRODUCTS; i++) {
      const msrp = Math.round(500 + rand() * 60000);
      const purchase = Math.round((msrp / 1.21) * (0.55 + rand() * 0.2));
      const price = Math.round(msrp * (0.85 + rand() * 0.2));
      const code = `P${i}`;
      const attrs = JSON.stringify({ N: `N${Math.floor(rand() * 9)}`, sezona: 2024 + Math.floor(rand() * 3) });
      const stock = Math.floor(rand() * 10);
      const sales30 = Math.floor(rand() * 4);
      const id = Number(
        ip.run(code, code, `Produkt ${i}`, brands[i % brands.length], 'Kola', purchase, price, msrp, stock, sales30, sales30 * 3, attrs, i % 5 ? '2026-08-01T00:00:00Z' : null, NOW, NOW).lastInsertRowid
      );
      for (const c of comp) {
        const observed = rand() < 0.05 ? '2026-09-01T00:00:00Z' : NOW; // 5 % zastaralých
        io.run(id, c, Math.round(msrp * (0.8 + rand() * 0.3)), rand() < 0.3 ? 99 : 0, rand() < 0.85 ? 1 : 0, observed, NOW);
      }
    }
  });
  // realistická sada strategií = předvolby (všechny zapnuté, aby se vyhodnotily i podmínky a časové okno)
  let prio = 10;
  for (const p of STRATEGY_PRESETS) {
    const seg = p.segment ? insertSegment(db, p.segment.name, p.segment.filter) : null;
    insertStrategy(db, { name: p.name, segment_id: seg, priority: prio, config: p.config });
    prio += 10;
  }
  const t0 = performance.now();
  const res = runPricing(db, { now: NOW });
  const ms = performance.now() - t0;
  assert.equal(res.stats.products, PRODUCTS);
  assert.ok(res.stats.changes > 1000, `změn ${res.stats.changes}`);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM proposals').get().c, res.stats.changes);
  test.diagnostic?.(`runPricing ${PRODUCTS} × ${COMPETITORS}: ${Math.round(ms)} ms, změn ${res.stats.changes}`);
  console.log(`# runPricing ${PRODUCTS} × ${COMPETITORS}: ${Math.round(ms)} ms, změn ${res.stats.changes}, auto ${res.stats.auto_approved}`);
  if (process.env.CI_SLOW) return; // na pomalém CI jen informativně
  assert.ok(ms < 5000, `přecenění trvalo ${Math.round(ms)} ms (limit 5000 ms)`);

  // druhý běh (supersede 30 000 produktů) musí být také rychlý
  const t1 = performance.now();
  const res2 = runPricing(db, { now: NOW });
  const ms2 = performance.now() - t1;
  assert.equal(res2.stats.superseded, res.stats.changes);
  assert.ok(ms2 < 5000, `druhý běh trval ${Math.round(ms2)} ms`);
});
