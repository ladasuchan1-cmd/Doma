'use strict';
// Dostupnost podle dodací lhůty (C7): strategie s in_stock_only a competitors.max_delivery_days počítá i nabídky,
// které nejsou skladem, ale dodají do N dní (delivery_days ≤ max_delivery_days).

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMarket, deliversInTime } = require('../src/engine/market');
const { computePrice } = require('../src/engine/pricing');
const { normalizeConfig, DEFAULT_CONFIG } = require('../src/engine/presets');
const { runPricing } = require('../src/engine/run');
const H = require('./engine-helpers');

const ctx = { now: H.NOW, maxAgeDays: 7 };
const reasons = (m) => Object.fromEntries(m.excluded.map((e) => [e.offer.competitor, e.reason]));

test('C7 market: nabídka „není skladem“ s dodáním do limitu se počítá, pozdější / neznámá ne', () => {
  const offers = [
    H.offer('Skladem', 10000, { in_stock: 1, delivery_days: 0 }),
    H.offer('Do3', 9500, { in_stock: 0, delivery_days: 3 }),
    H.offer('Do5', 9000, { in_stock: 0, delivery_days: 5 }),
    H.offer('Nevime', 8800, { in_stock: 0, delivery_days: null }),
    H.offer('Neznamo', 9900, { in_stock: null, delivery_days: null }),
  ];
  // bez limitu: jen skladem (null = neznámo = skladem)
  let m = buildMarket(offers, { in_stock_only: true }, ctx);
  assert.deepEqual(m.offers.map((o) => o.competitor).sort(), ['Neznamo', 'Skladem']);
  assert.deepEqual(reasons(m), { Do3: 'out_of_stock', Do5: 'out_of_stock', Nevime: 'out_of_stock' });
  // limit 3 dny: Do3 se počítá (a je nejlevnější)
  m = buildMarket(offers, { in_stock_only: true, max_delivery_days: 3 }, ctx);
  assert.deepEqual(m.offers.map((o) => o.competitor), ['Do3', 'Neznamo', 'Skladem']);
  assert.equal(m.min, 9500);
  assert.deepEqual(reasons(m), { Do5: 'out_of_stock', Nevime: 'out_of_stock' });
  // limit 0 dní = jen „dodá hned“
  m = buildMarket([H.offer('Hned', 100, { in_stock: 0, delivery_days: 0 })], { in_stock_only: true, max_delivery_days: 0 }, ctx);
  assert.equal(m.count, 1);
  // bez in_stock_only rozhoduje jen cena – limit dodání nic nevylučuje
  m = buildMarket(offers, { in_stock_only: false, max_delivery_days: 3 }, ctx);
  assert.equal(m.count, 5);
  // pomocná funkce
  assert.equal(deliversInTime({ delivery_days: 2 }, { max_delivery_days: 2 }), true);
  assert.equal(deliversInTime({ delivery_days: '2' }, { max_delivery_days: 2 }), true);
  assert.equal(deliversInTime({ delivery_days: 3 }, { max_delivery_days: 2 }), false);
  assert.equal(deliversInTime({ delivery_days: -1 }, { max_delivery_days: 2 }), false);
  assert.equal(deliversInTime({ delivery_days: null }, { max_delivery_days: 2 }), false);
  assert.equal(deliversInTime({ delivery_days: 1 }, { max_delivery_days: null }), false);
});

test('C7 config: competitors.max_delivery_days – výchozí null, nezáporné číslo, jinak chyba', () => {
  assert.equal(DEFAULT_CONFIG.competitors.max_delivery_days, null);
  assert.equal(normalizeConfig({}).config.competitors.max_delivery_days, null);
  const ok = normalizeConfig({ competitors: { max_delivery_days: 3 } });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.config.competitors.max_delivery_days, 3);
  assert.deepEqual(normalizeConfig({ competitors: { max_delivery_days: 0 } }).errors, []);
  assert.deepEqual(normalizeConfig({ competitors: { max_delivery_days: null } }).errors, []);
  for (const bad of [-1, 'tři', 1000]) {
    assert.ok(normalizeConfig({ competitors: { max_delivery_days: bad } }).errors.some((e) => /max_delivery_days/.test(e)), String(bad));
  }
});

test('C7 computePrice: trh z nabídek do N dní, vysvětlení zmiňuje dodací lhůtu', () => {
  const offers = [H.offer('A', 11000, { in_stock: 1 }), H.offer('B', 10500, { in_stock: 0, delivery_days: 2 })];
  const strategy = (comp) => ({ id: 1, name: 'S', config: H.looseConfig({ target: { mode: 'undercut_min', offset_abs: -10 }, competitors: comp }) });
  const p = H.product({ price: 12000, purchase_price: 5000, msrp: null });
  let d = computePrice(p, offers, strategy({ in_stock_only: true }), { now: H.NOW });
  assert.equal(d.reference_price, 11000);
  assert.ok(!d.explain.some((s) => /dodáním do/.test(s.text)));
  d = computePrice(p, offers, strategy({ in_stock_only: true, max_delivery_days: 3 }), { now: H.NOW });
  assert.equal(d.reference_price, 10500);
  assert.equal(d.new_price, 10490);
  const txt = d.explain.map((s) => s.text).join('\n');
  assert.match(txt, /nabídky s dodáním do 3 dnů/);
  assert.match(txt, /1 nabídka není skladem, ale dodá včas/);
  d = computePrice(p, offers, strategy({ in_stock_only: true, max_delivery_days: 1 }), { now: H.NOW });
  assert.equal(d.reference_price, 11000);
  assert.match(d.explain.map((s) => s.text).join('\n'), /s dodáním do 1 dne/);
});

test('C7 přecenění: delivery_days z importu nabídek se v běhu použije', () => {
  const db = H.createDb();
  const a = H.insertCompetitor(db, { name: 'Skladem.cz' });
  const b = H.insertCompetitor(db, { name: 'UDodavatele.cz' });
  const id = H.insertProduct(db, { code: 'K1', price: 12000, purchase_price: 5000, msrp: null });
  H.insertOffer(db, id, a, 11000);
  H.insertOffer(db, id, b, 10500, { in_stock: 0, delivery_days: 3 });
  const sid = H.insertStrategy(db, { name: 'S', config: H.looseConfig({ target: { mode: 'undercut_min', offset_abs: -10 }, competitors: { in_stock_only: true, max_delivery_days: 3 } }) });
  runPricing(db, { now: H.NOW });
  assert.equal(db.prepare('SELECT new_price FROM proposals').get().new_price, 10490);
  db.prepare("UPDATE strategies SET config = json_set(config, '$.competitors.max_delivery_days', 2) WHERE id = ?").run(sid);
  runPricing(db, { now: H.NOW });
  assert.equal(db.prepare("SELECT new_price FROM proposals WHERE status = 'pending'").get().new_price, 10990);
});
