'use strict';
// Výkon API nad 30 000 produkty × 8 konkurentů: seznam produktů studený < 1,5 s, teplý < 200 ms.
// Na pomalém stroji lze aserce času vypnout proměnnou CI_SLOW (test sám poběží a ověří správnost).
const test = require('node:test');
const assert = require('node:assert/strict');
const { tx, nowIso } = require('../src/db');
const H = require('./api-routes-helpers');

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

function seedLarge(db) {
  const rand = rng(11);
  const now = nowIso();
  const comps = [];
  for (let i = 0; i < COMPETITORS; i++) comps.push(H.insertCompetitor(db, `Konkurent${i}.cz`));
  const brands = ['Cannondale', 'Santa Cruz', 'Focus', 'Kellys', 'Shimano', 'SRAM', 'Abus', 'POC', 'Cervélo', 'Schwalbe'];
  tx(db, () => {
    const ip = db.prepare(
      `INSERT INTO products (code, code_key, ean, ean_key, name, manufacturer, category, owner, supplier, purchase_price, price, vat_rate, msrp,
         stock, sales_30, sales_90, attrs, active, price_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 21, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    );
    const io = db.prepare('INSERT INTO offers (product_id, competitor_id, price, shipping, in_stock, observed_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (let i = 1; i <= PRODUCTS; i++) {
      const msrp = Math.round(500 + rand() * 60000);
      const purchase = Math.round((msrp / 1.21) * (0.55 + rand() * 0.2));
      const price = Math.round(msrp * (0.85 + rand() * 0.2));
      const code = `K${String(i).padStart(6, '0')}`;
      const attrs = JSON.stringify({ N: `N${Math.floor(rand() * 9)}`, sezona: 2024 + Math.floor(rand() * 3) });
      const id = Number(
        ip.run(code, code, String(8590000000000 + i), String(8590000000000 + i), `Kolo Žluťoučké ${i}`, brands[i % brands.length], `Kategorie ${i % 12}`, `Osoba ${i % 3}`, `Dodavatel ${i % 5}`, purchase, price, msrp, Math.floor(rand() * 10), Math.floor(rand() * 4), 3, attrs, '2026-08-01T00:00:00Z', now, now).lastInsertRowid
      );
      for (const c of comps) io.run(id, c, Math.round(msrp * (0.8 + rand() * 0.3)), rand() < 0.3 ? 99 : 0, rand() < 0.85 ? 1 : 0, now, now);
    }
  });
  H.insertSegment(db, 'Ležáky', { field: 'attrs.N', op: 'in', value: ['N7', 'N8'] });
  H.insertSegment(db, 'Drahé', { field: 'price', op: '>', value: 40000 });
}

test('výkon: GET /products nad 30 000 produkty', { timeout: 180000 }, async (t) => {
  const app = await H.startApp();
  t.after(() => app.stop());
  seedLarge(app.db);
  const s = app.session();
  const timed = async (path) => {
    const t0 = performance.now();
    const r = await s.get(path);
    return { r, ms: performance.now() - t0 };
  };

  const cold = await timed('/api/v1/products?limit=50');
  assert.equal(cold.r.status, 200);
  assert.equal(cold.r.json.total, PRODUCTS);
  assert.equal(cold.r.json.items[0].code, 'K000001');
  assert.equal(cold.r.json.items[0].market_count > 0, true);

  const warm = [];
  for (let i = 0; i < 5; i++) warm.push((await timed('/api/v1/products?limit=50')).ms);
  const warmMs = Math.min(...warm);

  // teplé varianty: jiné řazení, hledání, filtr, segment
  const variants = {};
  for (const p of [
    '/api/v1/products?limit=50&sort=name&dir=desc',
    '/api/v1/products?limit=50&sort=margin_pct',
    '/api/v1/products?limit=50&q=zlutoucke%2012',
    '/api/v1/products?limit=500&filter=' + encodeURIComponent(JSON.stringify({ field: 'margin_pct', op: '<', value: 20 })),
    '/api/v1/products?limit=50&segment=1&manufacturer=focus',
  ]) {
    await s.get(p); // první řazení podle nového pole se cachuje
    const x = await timed(p);
    assert.equal(x.r.status, 200, p);
    variants[p] = x.ms;
  }
  const dash = await timed('/api/v1/dashboard');
  assert.equal(dash.r.json.products.active, PRODUCTS);
  const segs = await timed('/api/v1/segments');
  assert.equal(segs.r.json.items.length, 2);

  const info = `studený ${Math.round(cold.ms)} ms, teplý ${Math.round(warmMs)} ms, varianty ${Object.values(variants).map(Math.round).join('/')} ms, přehled ${Math.round(dash.ms)} ms`;
  t.diagnostic(info);
  if (process.env.CI_SLOW) return;
  assert.ok(cold.ms < 1500, `studený seznam trval ${Math.round(cold.ms)} ms (limit 1500 ms)`);
  assert.ok(warmMs < 200, `teplý seznam trval ${Math.round(warmMs)} ms (limit 200 ms)`);
  for (const [p, ms] of Object.entries(variants)) assert.ok(ms < 200, `${p}: ${Math.round(ms)} ms (limit 200 ms)`);
});
