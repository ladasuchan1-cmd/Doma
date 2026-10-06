'use strict';
// Testy src/domain/pricing.js: délka pronájmu (hodiny / půlden / dny), pásma, sezóna per den, příslušenství per den,
// poplatek a kauce per kolo, fallback bez hodinové sazby, tabulka ceníku, chyby.
const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryDb } = require('./helpers');
const pricing = require('../src/domain/pricing');

function fixture() {
  const db = memoryDb();
  db.prepare("INSERT INTO bike_types(id, slug, name, category, sizes, deposit_minor, fee_minor, value_minor) VALUES (1, 'trek', 'Trek', 'trek', '[\"S\",\"M\"]', 500000, 30000, 2500000)").run();
  db.prepare("INSERT INTO bike_types(id, slug, name, category, sizes, deposit_minor, fee_minor, value_minor) VALUES (2, 'ebike', 'E-kolo', 'ebike', '[\"M\"]', 1000000, 50000, 7500000)").run();
  db.prepare("INSERT INTO seasons(id, name, date_from, date_to) VALUES (1, 'Hlavní sezóna', '2026-06-15', '2026-09-15')").run();
  const ins = db.prepare('INSERT INTO price_rules(bike_type_id, season_id, unit, from_qty, price_minor) VALUES (?, ?, ?, ?, ?)');
  for (const [q, p] of [[1, 39000], [2, 35000], [4, 32000], [7, 29000]]) ins.run(1, null, 'day', q, p);
  ins.run(1, null, 'hour', 1, 9000);
  ins.run(1, null, 'halfday', 1, 25000);
  for (const [q, p] of [[1, 45000], [2, 40000], [4, 37000], [7, 33000]]) ins.run(1, 1, 'day', q, p);
  // e-kolo: jen denní sazby, bez hodinové / půldenní
  for (const [q, p] of [[1, 89000], [2, 79000]]) ins.run(2, null, 'day', q, p);
  db.prepare("INSERT INTO accessories(slug, name, price_minor, stock) VALUES ('prilba', 'Přilba', 5000, 10), ('vozik', 'Vozík', 25000, 1), ('zamek', 'Zámek', 0, 20)").run();
  return db;
}

test('lengthOf: ≤ 4 h hodiny, ≤ 6 h půlden, jinak celé dny (ceil)', () => {
  assert.deepEqual(pricing.lengthOf('2026-05-01T08:00:00Z', '2026-05-01T10:30:00Z'), { hours: 2.5, unit: 'hour', units: 3, days: 1 });
  assert.equal(pricing.lengthOf('2026-05-01T08:00:00Z', '2026-05-01T12:00:00Z').unit, 'hour');
  assert.deepEqual(pricing.lengthOf('2026-05-01T08:00:00Z', '2026-05-01T14:00:00Z'), { hours: 6, unit: 'halfday', units: 1, days: 1 });
  assert.equal(pricing.lengthOf('2026-05-01T08:00:00Z', '2026-05-01T15:00:00Z').unit, 'day');
  assert.equal(pricing.lengthOf('2026-05-01T08:00:00Z', '2026-05-02T08:00:00Z').days, 1);
  assert.equal(pricing.lengthOf('2026-05-01T08:00:00Z', '2026-05-02T08:00:01Z').days, 2);
  assert.equal(pricing.lengthOf('2026-05-01T07:00:00Z', '2026-05-07T15:00:00Z').days, 7);
  assert.throws(() => pricing.lengthOf('2026-05-01T08:00:00Z', '2026-05-01T08:00:00Z'), pricing.PricingError);
});

test('pásma podle počtu dní: 1 / 2–3 / 4–6 / 7+', () => {
  const db = fixture();
  const q = (days) => pricing.quote({ db, typeId: 1, fromAt: '2026-05-01T07:00:00Z', toAt: new Date(Date.parse('2026-05-01T07:00:00Z') + days * 86400000 - 3600000).toISOString() });
  assert.equal(q(1).totalMinor, 39000);
  assert.equal(q(2).totalMinor, 2 * 35000);
  assert.equal(q(3).totalMinor, 3 * 35000);
  assert.equal(q(4).totalMinor, 4 * 32000);
  assert.equal(q(6).totalMinor, 6 * 32000);
  assert.equal(q(7).totalMinor, 7 * 29000);
  assert.equal(q(10).totalMinor, 10 * 29000);
  assert.equal(q(3).unit, 'day');
  assert.equal(q(3).unitPriceMinor, 35000);
  assert.equal(q(3).breakdown.length, 1);
  assert.equal(q(3).breakdown[0].tier, 2);
});

test('hodinová a půldenní sazba; fallback na den bez hodinové sazby', () => {
  const db = fixture();
  const hour = pricing.quote({ db, typeId: 1, fromAt: '2026-05-01T08:00:00Z', toAt: '2026-05-01T10:30:00Z' });
  assert.equal(hour.unit, 'hour');
  assert.equal(hour.units, 3);
  assert.equal(hour.totalMinor, 27000);
  const half = pricing.quote({ db, typeId: 1, fromAt: '2026-05-01T08:00:00Z', toAt: '2026-05-01T13:30:00Z' });
  assert.equal(half.unit, 'halfday');
  assert.equal(half.totalMinor, 25000);
  const eHour = pricing.quote({ db, typeId: 2, fromAt: '2026-05-01T08:00:00Z', toAt: '2026-05-01T10:00:00Z' });
  assert.equal(eHour.unit, 'day', 'e-kolo bez hodinové sazby se účtuje jako den');
  assert.equal(eHour.totalMinor, 89000);
});

test('sezóna se vyhodnocuje per den a má přednost; pásmo podle celkového počtu dní', () => {
  const db = fixture();
  // 13. 6. – 16. 6. 15:00 = 4 dny: 2 mimo sezónu (pásmo 4–6 = 320) + 2 v sezóně (pásmo 4–6 = 370)
  const q = pricing.quote({ db, typeId: 1, fromAt: '2026-06-13T07:00:00Z', toAt: '2026-06-16T13:00:00Z', qty: 2 });
  assert.equal(q.days, 4);
  assert.equal(q.breakdown.length, 2);
  assert.equal(q.breakdown[0].units, 2);
  assert.equal(q.breakdown[0].unitPriceMinor, 32000);
  assert.equal(q.breakdown[0].season, null);
  assert.equal(q.breakdown[1].units, 2);
  assert.equal(q.breakdown[1].unitPriceMinor, 37000);
  assert.equal(q.breakdown[1].season, 'Hlavní sezóna');
  assert.equal(q.bikesMinor, 2 * (2 * 32000 + 2 * 37000));
  // celé v sezóně, 1 den
  const s = pricing.quote({ db, typeId: 1, fromAt: '2026-07-10T07:00:00Z', toAt: '2026-07-10T16:00:00Z' });
  assert.equal(s.totalMinor, 45000);
  // sezóna s opakujícím se MM-DD
  db.prepare("UPDATE seasons SET date_from = '06-15', date_to = '09-15' WHERE id = 1").run();
  assert.equal(pricing.quote({ db, typeId: 1, fromAt: '2027-07-10T07:00:00Z', toAt: '2027-07-10T16:00:00Z' }).totalMinor, 45000);
  assert.equal(pricing.inSeason({ date_from: '12-20', date_to: '01-05' }, '2026-12-31'), true);
  assert.equal(pricing.inSeason({ date_from: '12-20', date_to: '01-05' }, '2026-06-01'), false);
});

test('příslušenství per den, poplatek a kauce per kolo, breakdown', () => {
  const db = fixture();
  const q = pricing.quote({ db, typeId: 1, fromAt: '2026-05-01T07:00:00Z', toAt: '2026-05-03T15:00:00Z', qty: 3, accessories: [{ slug: 'prilba', qty: 2 }, { slug: 'zamek', qty: 3 }] });
  assert.equal(q.days, 3);
  assert.equal(q.bikesMinor, 3 * 3 * 35000);
  assert.equal(q.accessoriesMinor, 2 * 5000 * 3);
  assert.equal(q.totalMinor, q.bikesMinor + q.accessoriesMinor);
  assert.equal(q.feeMinor, 3 * 30000);
  assert.equal(q.depositMinor, 3 * 500000);
  const acc = q.breakdown.filter((b) => b.kind === 'accessory');
  assert.equal(acc.length, 2);
  assert.equal(acc[0].label, 'Přilba');
  assert.equal(acc[0].amountMinor, 30000);
  assert.equal(acc[1].amountMinor, 0);
  assert.throws(() => pricing.quote({ db, typeId: 1, fromAt: '2026-05-01T07:00:00Z', toAt: '2026-05-02T07:00:00Z', accessories: [{ slug: 'vozik', qty: 2 }] }), /není k dispozici/);
  assert.throws(() => pricing.quote({ db, typeId: 1, fromAt: '2026-05-01T07:00:00Z', toAt: '2026-05-02T07:00:00Z', accessories: [{ slug: 'neni', qty: 1 }] }), /není v nabídce/);
});

test('chyby: neznámý typ, bez ceníku, qty < 1', () => {
  const db = fixture();
  assert.throws(() => pricing.quote({ db, typeId: 99, fromAt: '2026-05-01T07:00:00Z', toAt: '2026-05-02T07:00:00Z' }), /nebyl nalezen/);
  assert.throws(() => pricing.quote({ db, typeId: 1, fromAt: '2026-05-01T07:00:00Z', toAt: '2026-05-02T07:00:00Z', qty: 0 }), /alespoň 1/);
  db.prepare("INSERT INTO bike_types(id, slug, name, category, deposit_minor, fee_minor, value_minor) VALUES (3, 'x', 'X', 'city', 1, 1, 1)").run();
  assert.throws(() => pricing.quote({ db, typeId: 3, fromAt: '2026-05-01T07:00:00Z', toAt: '2026-05-02T07:00:00Z' }), /ceník/);
});

test('fromPrice, priceTable a mergeSeasonRows', () => {
  const db = fixture();
  assert.equal(pricing.fromPrice(db, 1), 29000);
  assert.equal(pricing.fromPrice(db, 2), 79000);
  const table = pricing.priceTable(db, 1);
  assert.equal(table.length, 2);
  assert.equal(table[0].season, null);
  assert.deepEqual(table[0].tiers, { 1: 39000, 2: 35000, 4: 32000, 7: 29000 });
  assert.equal(table[0].hour, 9000);
  assert.equal(table[0].halfday, 25000);
  assert.equal(table[1].season.name, 'Hlavní sezóna');
  assert.equal(table[1].hour, null);
  db.prepare("INSERT INTO seasons(id, name, date_from, date_to) VALUES (2, 'Hlavní sezóna', '2027-06-15', '2027-09-15')").run();
  for (const [q, p] of [[1, 45000], [2, 40000], [4, 37000], [7, 33000]]) db.prepare('INSERT INTO price_rules(bike_type_id, season_id, unit, from_qty, price_minor) VALUES (1, 2, ?, ?, ?)').run('day', q, p);
  const merged = pricing.mergeSeasonRows(pricing.priceTable(db, 1));
  assert.equal(merged.length, 2, 'dvě sezóny stejného názvu a cen se sloučí');
  assert.equal(merged[1].ranges.length, 2);
});
