'use strict';
// Testy src/domain/reservations.js a cancellation.js: číslo rezervace, token (podpis, expirace, otisk), create (zápis
// zákazníka šifrovaně, položky, audit, e-mail), stavový automat (povolené / nepovolené přechody, idempotence, version),
// storno před/po lhůtě (ledger fee_forfeited / refund), no_show, údržbové joby (expirace, no-show, připomínka).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { memoryDb, ROOT } = require('./helpers');
const { loadTenant } = require('../src/tenants');
const { createFieldCrypto } = require('../src/crypto/fields');
const tokens = require('../src/crypto/tokens');
const reservations = require('../src/domain/reservations');
const cancellation = require('../src/domain/cancellation');

const tenant = loadTenant(path.join(ROOT, 'tenants', 'demo'));
const settings = { ...tenant.settings };
const SECRET = 'test-secret-test-secret-test-secret-0123456789';
const fc = createFieldCrypto(SECRET);
const mail = { fieldCrypto: fc, tenant, settings, baseUrl: 'https://ksprehledy.cz', secret: SECRET };

function fixture() {
  const db = memoryDb();
  db.prepare("INSERT INTO bike_types(id, slug, name, category, sizes, deposit_minor, fee_minor, value_minor) VALUES (1, 'trek', 'Trek FX 2', 'trek', '[\"S\",\"M\"]', 500000, 30000, 2500000)").run();
  db.prepare("INSERT INTO bikes(bike_type_id, inventory_code, size) VALUES (1, 'T1', 'M'), (1, 'T2', 'M'), (1, 'T3', 'S')").run();
  db.prepare("INSERT INTO price_rules(bike_type_id, unit, from_qty, price_minor) VALUES (1, 'day', 1, 39000), (1, 'day', 2, 35000), (1, 'hour', 1, 9000)").run();
  db.prepare("INSERT INTO accessories(slug, name, price_minor, stock) VALUES ('prilba', 'Přilba', 5000, 10)").run();
  return db;
}

const FROM = '2026-10-10T07:00:00.000Z';
const TO = '2026-10-11T15:00:00.000Z';
const NOW = new Date('2026-10-01T10:00:00.000Z');

function draft(overrides = {}) {
  return { fromAt: FROM, toAt: TO, items: [{ typeId: 1, size: 'M', qty: 2 }], accessories: [{ slug: 'prilba', qty: 1 }], customer: { name: 'Jana Nováková', email: 'Jana.Novakova@example.com', phone: '+420 777 000 001' }, consents: { termsVersion: '1.0', marketing: true }, ...overrides };
}

function createOne(db, overrides = {}, now = NOW) {
  return reservations.create({ db, tenant, settings, fieldCrypto: fc, secret: SECRET, draft: draft(overrides), ipHash: 'iphash', baseUrl: 'https://ksprehledy.cz', now });
}

test('nextNumber: RRMM + 6 číslic, sekvence v rámci měsíce', () => {
  const db = fixture();
  assert.equal(reservations.nextNumber(db, new Date('2026-07-15T10:00:00Z')), '2607000001');
  const { reservation } = createOne(db, {}, new Date('2026-07-15T10:00:00Z'));
  assert.equal(reservation.number, '2607000001');
  assert.equal(reservations.nextNumber(db, new Date('2026-07-20T10:00:00Z')), '2607000002');
  assert.equal(reservations.nextNumber(db, new Date('2026-08-01T10:00:00Z')), '2608000001');
  // půlnoc UTC = už další den v Praze → měsíc podle Prahy
  assert.equal(reservations.nextNumber(db, new Date('2026-07-31T22:30:00Z')), '2608000001');
});

test('create: awaiting_fee, ceny, položky per kus, zákazník šifrovaně + HMAC, souhlasy, audit, e-mail do outboxu', () => {
  const db = fixture();
  const { reservation: r, token, items } = createOne(db);
  assert.equal(r.status, 'awaiting_fee');
  assert.equal(r.version, 1);
  assert.equal(r.total_minor, 2 * 2 * 35000 + 2 * 5000, '2 kola × 2 dny à 350 + přilba 2 dny');
  assert.equal(r.fee_minor, 60000);
  assert.equal(r.deposit_minor, 1000000);
  assert.equal(r.paid_minor, 0);
  assert.equal(r.terms_version, '1.0');
  assert.equal(r.consent_at, NOW.toISOString());
  assert.equal(r.id_doc_ack_at, NOW.toISOString());
  assert.equal(r.consent_ip_hash, 'iphash');
  assert.equal(r.expires_at, '2026-10-03T10:00:00.000Z', 'now + 48 h');
  assert.equal(items.length, 2);
  const rows = db.prepare('SELECT * FROM reservation_items WHERE reservation_id = ? ORDER BY id').all(r.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].unit_price_minor, 70000);
  assert.equal(rows[0].fee_minor, 30000);
  assert.equal(JSON.parse(rows[0].accessories)[0].slug, 'prilba');
  assert.equal(JSON.parse(rows[1].accessories).length, 0);
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(r.customer_id);
  assert.ok(fc.isEncrypted(c.name_enc));
  assert.ok(!c.name_enc.includes('Nováková'));
  assert.equal(fc.dec(c.name_enc), 'Jana Nováková');
  assert.equal(c.email_hmac, fc.hmacEmail('jana.novakova@example.com'));
  assert.equal(fc.dec(c.phone_enc), '+420 777 000 001');
  assert.equal(c.marketing_consent_at, NOW.toISOString());
  assert.equal(c.id_doc_type, null, 'doklad se zapisuje až při výdeji');
  // token
  assert.ok(token.includes('.'));
  assert.equal(r.token_hash, tokens.sha256(token));
  assert.equal(reservations.tokenFor(r, SECRET), token, 'token je deterministický (znovu odvoditelný pro e-maily)');
  assert.equal(reservations.verifyToken({ db, token, secret: SECRET, now: NOW.getTime() }).id, r.id);
  assert.equal(reservations.verifyToken({ db, token: token + 'x', secret: SECRET, now: NOW.getTime() }), null);
  assert.equal(reservations.verifyToken({ db, token, secret: 'jine-tajemstvi-jine-tajemstvi-123', now: NOW.getTime() }), null);
  assert.equal(reservations.verifyToken({ db, token, secret: SECRET, now: NOW.getTime() + 91 * 86400000 }), null, 'po 90 dnech neplatný');
  db.prepare('UPDATE reservations SET token_hash = NULL WHERE id = ?').run(r.id);
  assert.equal(reservations.verifyToken({ db, token, secret: SECRET, now: NOW.getTime() }), null, 'bez otisku v DB neplatný (zneplatnění)');
  // audit a outbox
  const audit = db.prepare("SELECT * FROM audit_log WHERE action = 'reservation.create'").get();
  assert.ok(audit);
  assert.equal(audit.entity_id, String(r.id));
  assert.ok(!audit.meta.includes('Nováková'));
  const mailRow = db.prepare("SELECT * FROM outbox WHERE type = 'reservation_created'").get();
  assert.ok(mailRow);
  assert.equal(mailRow.to_hmac, fc.hmacEmail('jana.novakova@example.com'));
  assert.match(mailRow.subject, /Rezervace č\. \d{10}/);
  assert.match(mailRow.body_text, /variabilní symbol 2610000001/);
  assert.match(mailRow.body_html, new RegExp(`/rezervace/${token.replace(/[-_]/g, '.')}`));
  assert.equal(fc.dec(JSON.parse(mailRow.payload).to_enc), 'Jana.Novakova@example.com');
  // druhá rezervace téhož e-mailu → stejný zákazník (dedup přes HMAC)
  const second = createOne(db, { items: [{ typeId: 1, size: 'S', qty: 1 }], accessories: [], customer: { name: 'Jana Nováková', email: 'jana.novakova@example.com', phone: '+420 777 000 002' } });
  assert.equal(second.reservation.customer_id, r.customer_id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1);
});

test('create: validace vstupu a expirace u blízkého termínu', () => {
  const db = fixture();
  assert.throws(() => createOne(db, { items: [] }), /alespoň jedno kolo/);
  assert.throws(() => createOne(db, { customer: { name: 'X', email: '' } }), /údaje zákazníka/);
  const soon = createOne(db, { fromAt: '2026-10-01T12:00:00.000Z', toAt: '2026-10-01T16:00:00.000Z' });
  assert.equal(soon.reservation.expires_at, '2026-10-01T12:00:00.000Z', 'nejpozději začátek pronájmu');
  const verySoon = createOne(db, { fromAt: '2026-10-01T10:10:00.000Z', toAt: '2026-10-01T16:00:00.000Z', items: [{ typeId: 1, size: 'S', qty: 1 }], accessories: [] });
  assert.equal(verySoon.reservation.expires_at, '2026-10-01T10:30:00.000Z', 'minimálně 30 minut');
});

test('stavový automat: povolené přechody, version+1, audit, idempotence, nepovolené přechody', () => {
  const db = fixture();
  const { reservation: r } = createOne(db);
  const pay = reservations.recordPayment(db, { reservationId: r.id, purpose: 'fee', method: 'card', provider: 'mock', amountMinor: r.fee_minor, status: 'paid', idempotencyKey: 'k1', vs: r.number, now: NOW.toISOString() });
  // nepovolené z awaiting_fee
  for (const ev of ['check_out', 'return', 'close', 'no_show']) assert.throws(() => reservations.transition(db, r.id, ev, { now: NOW }), reservations.TransitionError, ev);
  assert.throws(() => reservations.transition(db, r.id, 'neexistuje', { now: NOW }), /Neznámá událost/);
  assert.throws(() => reservations.transition(db, 999, 'fee_paid', { now: NOW }), reservations.NotFoundError);
  const t1 = reservations.transition(db, r.id, 'fee_paid', { paymentId: pay.id, now: NOW, settings, mail });
  assert.equal(t1.changed, true);
  assert.equal(t1.reservation.status, 'confirmed');
  assert.equal(t1.reservation.version, 2);
  assert.equal(t1.reservation.paid_minor, 60000);
  assert.equal(t1.reservation.expires_at, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE type = 'fee_paid' AND amount_minor = 60000 AND payment_id = ?").get(pay.id).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type = 'payment_received'").get().n, 1);
  // idempotence: stejný event znovu = no-op bez dalšího ledgeru / auditu / e-mailu
  const t2 = reservations.transition(db, r.id, 'fee_paid', { paymentId: pay.id, now: NOW, settings, mail });
  assert.equal(t2.changed, false);
  assert.equal(t2.reservation.version, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE type = 'fee_paid'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type = 'payment_received'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'reservation.fee_paid'").get().n, 1);
  // nepovolené z confirmed
  for (const ev of ['expire', 'return', 'close']) assert.throws(() => reservations.transition(db, r.id, ev, { now: NOW }), reservations.TransitionError, ev);
  // výdej s přiřazením kol a kaucí
  const items = db.prepare('SELECT id FROM reservation_items WHERE reservation_id = ?').all(r.id);
  const bikes = db.prepare("SELECT id FROM bikes WHERE size = 'M'").all();
  const t3 = reservations.transition(db, r.id, 'check_out', { items: [{ itemId: items[0].id, bikeId: bikes[0].id }, { itemId: items[1].id, bikeId: bikes[1].id }], depositMinor: 1000000, depositMethod: 'card', balancePaidMinor: t1.reservation.total_minor - 60000, balanceMethod: 'terminal', userId: 7, now: '2026-10-10T07:05:00.000Z', settings });
  assert.equal(t3.reservation.status, 'checked_out');
  assert.equal(t3.reservation.version, 3);
  assert.equal(t3.reservation.deposit_method, 'card');
  assert.equal(t3.reservation.paid_minor, t1.reservation.total_minor);
  assert.equal(db.prepare('SELECT bike_id FROM reservation_items WHERE id = ?').get(items[0].id).bike_id, bikes[0].id);
  assert.equal(db.prepare("SELECT user_id FROM audit_log WHERE action = 'reservation.check_out'").get().user_id, 7);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE type IN ('deposit_held', 'balance_paid')").get().n, 2);
  assert.throws(() => reservations.transition(db, r.id, 'cancel_by_customer', { now: NOW }), reservations.TransitionError, 'vydanou nelze stornovat');
  const t4 = reservations.transition(db, r.id, 'return', { damageMinor: 50000, note: 'škrábanec', now: '2026-10-11T15:00:00.000Z', settings });
  assert.equal(t4.reservation.status, 'returned');
  assert.equal(db.prepare("SELECT amount_minor FROM ledger_entries WHERE type = 'damage'").get().amount_minor, 50000);
  const t5 = reservations.transition(db, r.id, 'close', { depositCapturedMinor: 50000, now: '2026-10-11T15:10:00.000Z', settings });
  assert.equal(t5.reservation.status, 'closed');
  assert.equal(t5.reservation.version, 5);
  assert.equal(db.prepare("SELECT amount_minor FROM ledger_entries WHERE type = 'deposit_captured'").get().amount_minor, 50000);
  assert.equal(db.prepare("SELECT amount_minor FROM ledger_entries WHERE type = 'deposit_released'").get().amount_minor, 950000);
  assert.equal(reservations.transition(db, r.id, 'close', { now: NOW }).changed, false, 'close znovu = no-op');
  // konflikt verzí (někdo změnil řádek mezitím)
  const { reservation: r2 } = createOne(db, { items: [{ typeId: 1, size: 'S', qty: 1 }], accessories: [] });
  db.prepare('UPDATE reservations SET version = version + 1 WHERE id = ?').run(r2.id);
  const fresh = reservations.get(db, r2.id);
  assert.equal(fresh.version, 2);
  assert.equal(reservations.transition(db, r2.id, 'expire', { now: NOW }).reservation.version, 3);
});

test('storno: před lhůtou plná vratka (payments refund + ledger refund), po lhůtě fee_forfeited; operátor vždy vrací', () => {
  const db = fixture();
  const make = (size) => {
    const { reservation: r } = createOne(db, { items: [{ typeId: 1, size, qty: 1 }], accessories: [] });
    const pay = reservations.recordPayment(db, { reservationId: r.id, purpose: 'fee', method: 'card', provider: 'mock', amountMinor: r.fee_minor, status: 'paid', idempotencyKey: `k-${r.id}`, vs: r.number, now: NOW.toISOString() });
    return reservations.transition(db, r.id, 'fee_paid', { paymentId: pay.id, now: NOW, settings }).reservation;
  };
  const early = make('M');
  const q1 = cancellation.quote({ reservation: early, now: new Date('2026-10-08T06:59:00Z'), settings });
  assert.equal(q1.rule, 'free');
  assert.equal(q1.refundMinor, 30000);
  assert.equal(q1.forfeitMinor, 0);
  assert.equal(q1.deadlineAt, '2026-10-08T07:00:00.000Z');
  assert.match(cancellation.describe(q1).replace(/\u00a0/g, ' '), /vracíme celý rezervační poplatek 300 Kč/);
  const c1 = reservations.transition(db, early.id, 'cancel_by_customer', { now: '2026-10-08T06:59:00.000Z', settings, mail });
  assert.equal(c1.reservation.status, 'cancelled_by_customer');
  assert.equal(c1.cancellation.rule, 'free');
  const refund = db.prepare("SELECT * FROM payments WHERE reservation_id = ? AND purpose = 'refund'").get(early.id);
  assert.ok(refund);
  assert.equal(refund.method, 'card');
  assert.equal(refund.status, 'refunded', 'karta (mock) → okamžitě refunded');
  assert.equal(refund.amount_minor, 30000);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE reservation_id = ? AND type = 'refund' AND amount_minor = 30000").get(early.id).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE reservation_id = ? AND type = 'fee_forfeited'").get(early.id).n, 0);
  const mailRow = db.prepare("SELECT * FROM outbox WHERE type = 'reservation_cancelled' AND json_extract(payload, '$.reservationId') = ?").get(early.id);
  assert.match(mailRow.body_text.replace(/\u00a0/g, ' '), /Vracíme celý rezervační poplatek 300 Kč/);
  assert.equal(reservations.transition(db, early.id, 'cancel_by_customer', { now: NOW, settings }).changed, false, 'opakované storno = no-op');

  const late = make('M');
  const q2 = cancellation.quote({ reservation: late, now: new Date('2026-10-08T07:01:00Z'), settings });
  assert.equal(q2.rule, 'forfeit');
  assert.equal(q2.refundMinor, 0);
  assert.equal(q2.forfeitMinor, 30000);
  assert.match(cancellation.describe(q2), /propadá/);
  const c2 = reservations.transition(db, late.id, 'cancel_by_customer', { now: '2026-10-09T10:00:00.000Z', settings, mail });
  assert.equal(c2.reservation.status, 'cancelled_by_customer');
  assert.equal(db.prepare("SELECT amount_minor FROM ledger_entries WHERE reservation_id = ? AND type = 'fee_forfeited'").get(late.id).amount_minor, 30000);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM payments WHERE reservation_id = ? AND purpose = 'refund'").get(late.id).n, 0);
  assert.match(db.prepare("SELECT body_text FROM outbox WHERE type = 'reservation_cancelled' AND json_extract(payload, '$.reservationId') = ?").get(late.id).body_text, /propadá/);

  // jiná lhůta ze settings
  const q3 = cancellation.quote({ reservation: late, now: new Date('2026-10-09T06:00:00Z'), settings: { cancellation: { freeHoursBefore: 24 } } });
  assert.equal(q3.rule, 'free');
  assert.equal(cancellation.quote({ reservation: { from_at: FROM, paid_minor: 0 }, now: new Date('2026-10-10T06:00:00Z'), settings }).forfeitMinor, 0, 'nezaplaceno → nic nepropadá');

  // operátor: po lhůtě i tak plná vratka; převod → refund pending
  const { reservation: r3 } = createOne(db, { items: [{ typeId: 1, size: 'S', qty: 1 }], accessories: [] });
  const payBank = reservations.recordPayment(db, { reservationId: r3.id, purpose: 'fee', method: 'bank_transfer', provider: 'fio-mock', amountMinor: 30000, status: 'paid', idempotencyKey: `kb-${r3.id}`, vs: r3.number, now: NOW.toISOString() });
  reservations.transition(db, r3.id, 'fee_paid', { paymentId: payBank.id, now: NOW, settings });
  const c3 = reservations.transition(db, r3.id, 'cancel_by_operator', { now: '2026-10-10T06:00:00.000Z', settings, mail, userId: 1 });
  assert.equal(c3.reservation.status, 'cancelled_by_operator');
  const refund3 = db.prepare("SELECT * FROM payments WHERE reservation_id = ? AND purpose = 'refund'").get(r3.id);
  assert.equal(refund3.status, 'pending', 'převod → čeká na potvrzení v adminu');
  assert.equal(refund3.method, 'bank_transfer');
  assert.equal(refund3.amount_minor, 30000);
});

test('no_show propadá poplatek; expire; runMaintenance (expirace, no-show, připomínka jednou)', () => {
  const db = fixture();
  const { reservation: a } = createOne(db, { items: [{ typeId: 1, size: 'M', qty: 1 }], accessories: [] });
  const payA = reservations.recordPayment(db, { reservationId: a.id, purpose: 'fee', method: 'card', provider: 'mock', amountMinor: 30000, status: 'paid', idempotencyKey: 'a', vs: a.number, now: NOW.toISOString() });
  reservations.transition(db, a.id, 'fee_paid', { paymentId: payA.id, now: NOW, settings });
  // b čeká na poplatek (expires 3. 10.)
  const { reservation: b } = createOne(db, { items: [{ typeId: 1, size: 'M', qty: 1 }], accessories: [] });
  // c potvrzená na zítra (připomínka)
  const { reservation: c } = createOne(db, { fromAt: '2026-10-02T07:00:00.000Z', toAt: '2026-10-02T15:00:00.000Z', items: [{ typeId: 1, size: 'S', qty: 1 }], accessories: [] });
  const payC = reservations.recordPayment(db, { reservationId: c.id, purpose: 'fee', method: 'card', provider: 'mock', amountMinor: 30000, status: 'paid', idempotencyKey: 'c', vs: c.number, now: NOW.toISOString() });
  reservations.transition(db, c.id, 'fee_paid', { paymentId: payC.id, now: NOW, settings });

  let res = reservations.runMaintenance({ db, tenant, settings, fieldCrypto: fc, baseUrl: 'https://ksprehledy.cz', secret: SECRET, now: new Date('2026-10-01T12:00:00Z') });
  assert.deepEqual(res, { expired: 0, noShow: 0, reminders: 1 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type = 'reminder'").get().n, 1);
  assert.match(db.prepare("SELECT body_text FROM outbox WHERE type = 'reminder'").get().body_text, /platný doklad totožnosti/);
  res = reservations.runMaintenance({ db, tenant, settings, fieldCrypto: fc, baseUrl: 'https://ksprehledy.cz', secret: SECRET, now: new Date('2026-10-01T13:00:00Z') });
  assert.equal(res.reminders, 0, 'připomínka se neposílá dvakrát');
  res = reservations.runMaintenance({ db, tenant, settings, fieldCrypto: fc, baseUrl: 'https://ksprehledy.cz', secret: SECRET, now: new Date('2026-10-03T10:00:01Z') });
  assert.equal(res.expired, 1);
  assert.equal(reservations.get(db, b.id).status, 'expired');
  assert.equal(res.noShow, 1, 'c skončila 2. 10. bez výdeje');
  assert.equal(reservations.get(db, c.id).status, 'no_show');
  assert.equal(db.prepare("SELECT amount_minor FROM ledger_entries WHERE reservation_id = ? AND type = 'fee_forfeited'").get(c.id).amount_minor, 30000);
  res = reservations.runMaintenance({ db, tenant, settings, fieldCrypto: fc, baseUrl: 'https://ksprehledy.cz', secret: SECRET, now: new Date('2026-10-12T10:00:00Z') });
  assert.equal(res.noShow, 1, 'a skončila 11. 10. bez výdeje');
  assert.equal(reservations.get(db, a.id).status, 'no_show');
  assert.equal(reservations.transition(db, a.id, 'no_show', { now: NOW }).changed, false);
  assert.equal(reservations.loadDetail(db, reservations.get(db, a.id)).ledger.length, 2);
});
