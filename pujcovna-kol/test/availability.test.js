'use strict';
// Testy src/domain/availability.js: překryv s bufferem, blokující stavy, mapa dostupnosti, zavírací dny a otevírací doba,
// validace termínu, převod času Praha ↔ UTC, souběh (dvě rezervace posledního kola v transakci → druhá selže).
const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryDb, ROOT } = require('./helpers');
const path = require('node:path');
const { transaction } = require('../src/db');
const { loadTenant } = require('../src/tenants');
const { createFieldCrypto } = require('../src/crypto/fields');
const av = require('../src/domain/availability');
const reservations = require('../src/domain/reservations');

const tenant = loadTenant(path.join(ROOT, 'tenants', 'demo'));
const settings = { ...tenant.settings };
const SECRET = 'test-secret-test-secret-test-secret-0123456789';

function fixture() {
  const db = memoryDb();
  db.prepare("INSERT INTO bike_types(id, slug, name, category, sizes, deposit_minor, fee_minor, value_minor) VALUES (1, 'trek', 'Trek', 'trek', '[\"S\",\"M\"]', 500000, 30000, 2500000)").run();
  db.prepare("INSERT INTO bikes(bike_type_id, inventory_code, size, status) VALUES (1, 'T1', 'M', 'available'), (1, 'T2', 'M', 'available'), (1, 'T3', 'S', 'available'), (1, 'T4', 'S', 'maintenance')").run();
  db.prepare("INSERT INTO price_rules(bike_type_id, unit, from_qty, price_minor) VALUES (1, 'day', 1, 39000), (1, 'hour', 1, 9000)").run();
  db.prepare("INSERT INTO closures(date_from, date_to, reason) VALUES ('2026-12-24', '2026-12-26', 'Vánoce')").run();
  return db;
}

function addReservation(db, { status = 'confirmed', from, to, size = 'M', qty = 1 }) {
  const now = '2026-01-01T00:00:00.000Z';
  const r = db
    .prepare("INSERT INTO reservations(number, status, from_at, to_at, total_minor, fee_minor, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?)")
    .run(`26010${String(db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n + 1).padStart(5, '0')}`, status, from, to, now, now);
  const id = Number(r.lastInsertRowid);
  for (let i = 0; i < qty; i++) db.prepare("INSERT INTO reservation_items(reservation_id, bike_type_id, size, unit_price_minor, fee_minor) VALUES (?, 1, ?, 39000, 30000)").run(id, size);
  return id;
}

test('available: počet kusů minus překrývající se položky v blokujících stavech; údržba se nepočítá', () => {
  const db = fixture();
  const from = '2026-07-10T07:00:00.000Z';
  const to = '2026-07-11T15:00:00.000Z';
  assert.equal(av.available({ db, typeId: 1, size: 'M', fromAt: from, toAt: to, settings }), 2);
  assert.equal(av.available({ db, typeId: 1, size: 'S', fromAt: from, toAt: to, settings }), 1, 'kolo v údržbě se nepočítá');
  addReservation(db, { status: 'confirmed', from, to, size: 'M' });
  assert.equal(av.available({ db, typeId: 1, size: 'M', fromAt: from, toAt: to, settings }), 1);
  for (const s of ['awaiting_fee', 'checked_out']) {
    addReservation(db, { status: s, from, to, size: 'M' });
  }
  assert.equal(av.available({ db, typeId: 1, size: 'M', fromAt: from, toAt: to, settings }), 0);
  // neblokující stavy
  for (const s of ['expired', 'cancelled_by_customer', 'cancelled_by_operator', 'no_show', 'returned', 'closed']) addReservation(db, { status: s, from, to, size: 'S' });
  assert.equal(av.available({ db, typeId: 1, size: 'S', fromAt: from, toAt: to, settings }), 1);
  assert.equal(av.available({ db, typeId: 1, size: 'XL', fromAt: from, toAt: to, settings }), 0, 'neexistující velikost');
});

test('překryv a buffer: rezervace končící 30 min před začátkem blokuje při bufferu 60 min, ne při 0', () => {
  const db = fixture();
  addReservation(db, { from: '2026-07-10T07:00:00.000Z', to: '2026-07-10T09:30:00.000Z', size: 'M' });
  const from = '2026-07-10T10:00:00.000Z';
  const to = '2026-07-10T15:00:00.000Z';
  assert.equal(av.available({ db, typeId: 1, size: 'M', fromAt: from, toAt: to, settings: { bufferMinutes: 60 } }), 1);
  assert.equal(av.available({ db, typeId: 1, size: 'M', fromAt: from, toAt: to, settings: { bufferMinutes: 0 } }), 2);
  assert.equal(av.available({ db, typeId: 1, size: 'M', fromAt: from, toAt: to, settings: { bufferMinutes: 30 } }), 2, 'konec + 30 min = začátek → bez překryvu (polootevřený interval)');
  // rezervace po termínu
  addReservation(db, { from: '2026-07-10T15:30:00.000Z', to: '2026-07-10T18:00:00.000Z', size: 'M' });
  assert.equal(av.available({ db, typeId: 1, size: 'M', fromAt: from, toAt: to, settings: { bufferMinutes: 60 } }), 0);
  assert.equal(av.available({ db, typeId: 1, size: 'M', fromAt: from, toAt: to, settings: { bufferMinutes: 0 } }), 2);
  // zcela mimo
  assert.equal(av.available({ db, typeId: 1, size: 'M', fromAt: '2026-07-12T07:00:00.000Z', toAt: '2026-07-12T15:00:00.000Z', settings }), 2);
  // excludeReservationId
  const id = addReservation(db, { from, to, size: 'M', qty: 2 });
  assert.equal(av.available({ db, typeId: 1, size: 'M', fromAt: from, toAt: to, settings: { bufferMinutes: 0 } }), 0);
  assert.equal(av.available({ db, typeId: 1, size: 'M', fromAt: from, toAt: to, settings: { bufferMinutes: 0 }, excludeReservationId: id }), 2);
});

test('availabilityMap vrací všechny aktivní typy a velikosti (0 pro velikosti bez kusů)', () => {
  const db = fixture();
  addReservation(db, { from: '2026-07-10T07:00:00.000Z', to: '2026-07-11T15:00:00.000Z', size: 'M' });
  const map = av.availabilityMap({ db, fromAt: '2026-07-10T07:00:00.000Z', toAt: '2026-07-11T15:00:00.000Z', settings });
  assert.deepEqual(map, { 1: { S: 1, M: 1 } });
  db.prepare("INSERT INTO bike_types(id, slug, name, category, sizes, deposit_minor, fee_minor, value_minor, active) VALUES (2, 'kids', 'Kids', 'kids', '[\"20\\\"\"]', 1, 1, 1, 1)").run();
  const map2 = av.availabilityMap({ db, fromAt: '2026-07-10T07:00:00.000Z', toAt: '2026-07-11T15:00:00.000Z', settings });
  assert.deepEqual(map2[2], { '20"': 0 });
  assert.deepEqual(av.availabilityMap({ db, fromAt: '2026-07-10T07:00:00.000Z', toAt: '2026-07-11T15:00:00.000Z', settings, typeId: 1 }), { 1: { S: 1, M: 1 } });
});

test('zavírací dny a otevírací doba: closures (plná data i MM-DD), dny bez otevírací doby, blockedDates, sloty', () => {
  const db = fixture();
  assert.equal(av.isClosedDay(db, tenant, '2026-12-25'), true);
  assert.equal(av.isClosedDay(db, tenant, '2026-12-27'), false);
  assert.deepEqual(av.closedInfo(db, tenant, '2026-12-24'), { closed: true, reason: 'Vánoce' });
  db.prepare("INSERT INTO closures(date_from, date_to, reason) VALUES ('01-01', '01-01', 'Nový rok')").run();
  assert.equal(av.isClosedDay(db, tenant, '2027-01-01'), true);
  const t2 = { ...tenant, openingHours: { ...tenant.openingHours, mon: [] } };
  assert.equal(av.isClosedDay(db, t2, '2026-07-13'), true, 'pondělí bez otevírací doby je zavřeno');
  assert.deepEqual(av.openingHoursFor(tenant, '2026-07-11'), ['08:00', '19:00']);
  assert.deepEqual(av.openingHoursFor(tenant, '2026-07-13'), ['09:00', '18:00']);
  const blocked = av.blockedDates({ db, tenant, from: '2026-12-20', to: '2026-12-31' });
  assert.deepEqual(blocked, ['2026-12-24', '2026-12-25', '2026-12-26']);
  assert.equal(av.timeSlots('09:00', '18:00').length, 19);
  assert.equal(av.timeSlots('09:00', '18:00')[1], '09:30');
  const all = av.allTimeSlots(tenant);
  assert.equal(all[0], '08:00');
  assert.equal(all[all.length - 1], '19:00');
});

test('otevírací doba z adminu (settings.openingHours) přepisuje tenant.json: null = zavřeno, chybějící den = výchozí', () => {
  const db = fixture();
  const s = { ...settings, openingHours: { mon: null, sat: ['10:00', '16:00'] } };
  const eff = av.effectiveOpeningHours(tenant, s);
  assert.equal(eff.mon, null, 'pondělí zavřeno');
  assert.deepEqual(eff.sat, ['10:00', '16:00'], 'sobota přepsaná');
  assert.deepEqual(eff.tue, ['09:00', '18:00'], 'úterý z tenant.json');
  assert.deepEqual(Object.keys(eff), ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  // bez settings beze změny (zpětná kompatibilita)
  assert.deepEqual(av.effectiveOpeningHours(tenant), tenant.openingHours);
  assert.deepEqual(av.effectiveOpeningHours(tenant, { openingHours: null }), tenant.openingHours);
  // 2026-07-13 je pondělí
  assert.deepEqual(av.openingHoursFor(tenant, '2026-07-13'), ['09:00', '18:00']);
  assert.equal(av.openingHoursFor(tenant, '2026-07-13', s), null);
  assert.equal(av.isClosedDay(db, tenant, '2026-07-13', s), true);
  assert.deepEqual(av.closedInfo(db, tenant, '2026-07-13', s), { closed: true, reason: 'Zavírací den' });
  assert.equal(av.isClosedDay(db, tenant, '2026-07-13'), false);
  // blockedDates: každé pondělí v rozsahu
  const blocked = av.blockedDates({ db, tenant, settings: s, from: '2026-07-06', to: '2026-07-19' });
  assert.deepEqual(blocked, ['2026-07-06', '2026-07-13']);
  assert.deepEqual(av.blockedDates({ db, tenant, from: '2026-07-06', to: '2026-07-19' }), []);
  // sloty: sobota 10–16 + všední 9–18 + neděle 8–19 → stále 08:00…19:00; při zkrácení všech dní se zúží
  const narrow = { openingHours: { mon: ['10:00', '15:00'], tue: ['10:00', '15:00'], wed: ['10:00', '15:00'], thu: ['10:00', '15:00'], fri: ['10:00', '15:00'], sat: null, sun: null } };
  const slots = av.allTimeSlots(tenant, { settings: narrow });
  assert.equal(slots[0], '10:00');
  assert.equal(slots[slots.length - 1], '15:00');
  assert.equal(av.allTimeSlots(tenant, 60).length, 12, 'číselný druhý parametr = krok (zpětně kompatibilní)');
  // validateRange a termFromDates respektují settings
  const now = new Date('2026-07-01T10:00:00Z');
  const v = av.validateRange({ db, tenant, settings: s, fromAt: av.localToUtc('2026-07-13', '09:00'), toAt: av.localToUtc('2026-07-14', '17:00'), now });
  assert.match(v.errors.od, /zavřeno \(Zavírací den\)/);
  assert.equal(av.validateRange({ db, tenant, settings, fromAt: av.localToUtc('2026-07-13', '09:00'), toAt: av.localToUtc('2026-07-14', '17:00'), now }).ok, true);
  const sat = av.validateRange({ db, tenant, settings: s, fromAt: av.localToUtc('2026-07-11', '09:00'), toAt: av.localToUtc('2026-07-11', '15:00'), now });
  assert.match(sat.errors.od, /10:00–16:00/);
  assert.equal(av.termFromDates({ tenant, settings: s, od: '2026-07-11', do: '2026-07-11' }).odCas, '10:00');
  assert.equal(av.termFromDates({ tenant, od: '2026-07-11', do: '2026-07-11' }).odCas, '08:00');
});

test('převod času Praha ↔ UTC včetně letního času', () => {
  assert.equal(av.localToUtc('2026-07-12', '09:00').toISOString(), '2026-07-12T07:00:00.000Z');
  assert.equal(av.localToUtc('2026-01-12', '09:00').toISOString(), '2026-01-12T08:00:00.000Z');
  assert.deepEqual(av.utcToLocal('2026-07-12T07:00:00.000Z'), { date: '2026-07-12', time: '09:00', dayKey: 'sun', minutes: 540 });
  assert.equal(av.utcToLocal('2026-12-31T23:30:00.000Z').date, '2027-01-01');
  assert.equal(av.addDays('2026-02-27', 3), '2026-03-02');
  assert.throws(() => av.localToUtc('2026-13-01', '09:00'), /Neplatné datum/);
  assert.throws(() => av.localToUtc('2026-07-12', '25:00'), /Neplatný čas/);
  const t = av.termFromDates({ tenant, od: '2026-07-11', do: '2026-07-13' });
  assert.equal(t.odCas, '08:00', 'sobota otevírá v 8');
  assert.equal(t.doCas, '18:00', 'pondělí zavírá v 18');
  assert.equal(av.termFromDates({ tenant, od: '2026-07-13', do: '2026-07-11' }), null);
});

test('validateRange: minulost, konec před začátkem, zavřený den, mimo otevírací dobu, max. délka', () => {
  const db = fixture();
  const now = new Date('2026-07-01T10:00:00Z');
  const ok = av.validateRange({ db, tenant, settings, fromAt: av.localToUtc('2026-07-10', '09:00'), toAt: av.localToUtc('2026-07-11', '17:00'), now });
  assert.equal(ok.ok, true);
  assert.match(av.validateRange({ db, tenant, settings, fromAt: av.localToUtc('2026-06-10', '09:00'), toAt: av.localToUtc('2026-06-11', '17:00'), now }).errors.od, /uplynul/);
  assert.match(av.validateRange({ db, tenant, settings, fromAt: av.localToUtc('2026-07-11', '09:00'), toAt: av.localToUtc('2026-07-10', '17:00'), now }).errors.do, /po vyzvednutí/);
  assert.match(av.validateRange({ db, tenant, settings, fromAt: av.localToUtc('2026-12-24', '09:00'), toAt: av.localToUtc('2026-12-27', '17:00'), now }).errors.od, /zavřeno/);
  assert.match(av.validateRange({ db, tenant, settings, fromAt: av.localToUtc('2026-07-13', '08:00'), toAt: av.localToUtc('2026-07-13', '17:00'), now }).errors.od, /otevírací době/);
  assert.match(av.validateRange({ db, tenant, settings, fromAt: av.localToUtc('2026-07-13', '09:00'), toAt: av.localToUtc('2026-07-13', '18:30'), now }).errors.do, /otevírací době/);
  assert.match(av.validateRange({ db, tenant, settings, fromAt: av.localToUtc('2026-07-10', '09:00'), toAt: av.localToUtc('2026-08-20', '17:00'), now }).errors.do, /Nejdelší/);
  assert.equal(av.validateRange({ db, tenant, settings, fromAt: 'x', toAt: 'y' }).ok, false);
});

test('souběh: dvě rezervace posledního kola – druhá v transakci selže (assertAvailable + create)', () => {
  const db = fixture();
  const fc = createFieldCrypto(SECRET);
  const fromAt = '2026-07-10T07:00:00.000Z';
  const toAt = '2026-07-11T15:00:00.000Z';
  const draft = (email) => ({ fromAt, toAt, items: [{ typeId: 1, size: 'S', qty: 1 }], customer: { name: 'Test Osoba', email, phone: '+420777000000' }, consents: { termsVersion: '1.0' } });
  // S má jediný dostupný kus (T3; T4 je v údržbě)
  const first = reservations.create({ db, tenant, settings, fieldCrypto: fc, secret: SECRET, draft: draft('a@example.com'), now: new Date('2026-07-01T10:00:00Z'), sendMail: false });
  assert.equal(first.reservation.status, 'awaiting_fee');
  assert.throws(() => reservations.create({ db, tenant, settings, fieldCrypto: fc, secret: SECRET, draft: draft('b@example.com'), now: new Date('2026-07-01T10:00:01Z'), sendMail: false }), (e) => e instanceof av.AvailabilityError && /mezitím někdo rezervoval/.test(e.message) && e.details.available === 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n, 1, 'druhá rezervace se nezapsala (ROLLBACK)');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1, 'ani zákazník druhé rezervace');
  // kontrola uvnitř vlastní transakce BEGIN IMMEDIATE
  assert.throws(() => transaction(db, () => av.assertAvailable({ db, items: [{ typeId: 1, size: 'S', qty: 1 }], fromAt, toAt, settings })), av.AvailabilityError);
  assert.equal(transaction(db, () => av.assertAvailable({ db, items: [{ typeId: 1, size: 'M', qty: 2 }], fromAt, toAt, settings })), true);
  assert.throws(() => av.assertAvailable({ db, items: [], fromAt, toAt, settings }), /alespoň jedno kolo/);
});
