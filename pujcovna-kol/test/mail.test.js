'use strict';
// Testy src/mail/templates.js a outbox.js: všech 5 šablon má předmět, text i HTML s escapováním; outbox ukládá jen
// to_hmac + šifrovanou adresu v payloadu, nikdy e-mail v čitelné podobě; hasMail / listForReservation / pending / markSent.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { memoryDb, ROOT } = require('./helpers');
const { loadTenant } = require('../src/tenants');
const { createFieldCrypto } = require('../src/crypto/fields');
const templates = require('../src/mail/templates');
const outbox = require('../src/mail/outbox');

const tenant = loadTenant(path.join(ROOT, 'tenants', 'demo'));
const fc = createFieldCrypto('test-secret-test-secret-test-secret-0123456789');
// format.money používá nezlomitelnou mezeru – pro čitelné regexy ji v testech normalizujeme
const nb = (s) => String(s).replace(/ /g, ' ');
const renderNb = (type, d) => {
  const out = templates.render(type, d);
  return { subject: nb(out.subject), text: nb(out.text), html: nb(out.html) };
};

const reservation = { id: 1, number: '2610000001', status: 'awaiting_fee', from_at: '2026-10-10T07:00:00.000Z', to_at: '2026-10-11T15:00:00.000Z', total_minor: 150000, fee_minor: 60000, paid_minor: 0, deposit_minor: 1000000, expires_at: '2026-10-03T10:00:00.000Z' };
const data = {
  tenant,
  settings: tenant.settings,
  baseUrl: 'https://ksprehledy.cz',
  reservation,
  customer: { name: 'Jana <Nováková>' },
  items: [{ typeName: 'Trek FX 2', size: 'M', qty: 2, amountMinor: 140000 }],
  accessories: [{ label: 'Přilba', qty: 1, amountMinor: 10000 }],
  manageUrl: 'https://ksprehledy.cz/rezervace/tok.en',
  icsUrl: 'https://ksprehledy.cz/rezervace/tok.en/kalendar.ics',
};

test('šablony: předmět, text, HTML (escapované), obsah odpovídá typu', () => {
  const created = renderNb('reservation_created', { ...data, payment: { amountMinor: 60000, iban: tenant.business.iban, vs: reservation.number } });
  assert.equal(created.subject, 'Rezervace č. 2610000001 – Půjčovna kol U Tří dubů');
  assert.match(created.text, /Jana <Nováková>/);
  assert.match(created.html, /Jana &lt;Nováková&gt;/, 'HTML escapuje jméno');
  assert.match(created.text, /do 3\. 10\. 2026 12:00/);
  assert.match(created.text, /IBAN CZ6508000000192000145399/);
  assert.match(created.text, /variabilní symbol 2610000001/);
  assert.match(created.text, /2× Trek FX 2 \(velikost M\)/);
  assert.match(created.text, /platný doklad totožnosti/);
  assert.match(created.text, /48 hodin/);
  assert.match(created.html, /<a href="https:\/\/ksprehledy.cz\/rezervace\/tok.en">/);
  assert.match(created.html, /^<!doctype html>/);
  assert.ok(!/ style="/.test(created.html));

  const paid = renderNb('payment_received', { ...data, reservation: { ...reservation, status: 'confirmed', paid_minor: 60000 }, payment: { amountMinor: 60000, method: 'card', at: '2026-10-01T10:00:00Z' }, document: { number: 'ZDD-2026-000001', url: 'https://ksprehledy.cz/doklady/ZDD-2026-000001' } });
  assert.match(paid.subject, /Platba přijata/);
  assert.match(paid.text, /600 Kč kartou online/);
  assert.match(paid.text, /Zbývá doplatit 900 Kč/);
  assert.match(paid.text, /ZDD-2026-000001/);

  const reminder = renderNb('reminder', { ...data, reservation: { ...reservation, status: 'confirmed', paid_minor: 60000 } });
  assert.match(reminder.subject, /Zítra vyzvednutí kol/);
  assert.match(reminder.text, /Masarykovo nám\. 1/);
  assert.match(reminder.text, /vratnou kauci 10 000 Kč/);
  assert.match(reminder.text, /doplatek 900 Kč/);

  const cancelled = renderNb('reservation_cancelled', { ...data, cancellation: { rule: 'forfeit', paidMinor: 60000, refundMinor: 0, forfeitMinor: 60000, freeHoursBefore: 48 }, cancelledBy: 'customer' });
  assert.match(cancelled.subject, /byla zrušena/);
  assert.match(cancelled.text, /600 Kč proto propadá/);
  const cancelledOp = renderNb('reservation_cancelled', { ...data, cancellation: { rule: 'operator', paidMinor: 60000, refundMinor: 60000, forfeitMinor: 0 }, cancelledBy: 'operator' });
  assert.match(cancelledOp.text, /půjčovna zrušila/);
  assert.match(cancelledOp.text, /Vracíme celý rezervační poplatek 600 Kč \(zrušení ze strany půjčovny\)/);

  const qr = renderNb('balance_qr', { ...data, payment: { amountMinor: 90000, iban: tenant.business.iban, vs: reservation.number, spayd: 'SPD*1.0*ACC:CZ65…', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' } });
  assert.match(qr.subject, /Doplatek 900 Kč/);
  assert.match(qr.text, /Variabilní symbol: 2610000001/);
  assert.match(qr.html, /data:image\/svg\+xml;base64,/);
  assert.throws(() => templates.render('neexistuje', data), /Neznámá e-mailová šablona/);
});

test('outbox.enqueue: to_hmac + payload.to_enc, žádný e-mail v čitelné podobě; pending / markSent / markFailed', () => {
  const db = memoryDb();
  const id = outbox.enqueue(db, { type: 'test', to: 'Jana.Novakova@example.com', subject: 'Předmět', text: 'Text', html: '<p>Html</p>', payload: { reservationId: 5 }, fieldCrypto: fc, now: '2026-10-01T10:00:00.000Z' });
  const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id);
  assert.equal(row.to_hmac, fc.hmacEmail('jana.novakova@example.com'));
  assert.equal(row.run_at, '2026-10-01T10:00:00.000Z');
  assert.ok(!JSON.stringify(row).toLowerCase().includes('novakova@example.com'), 'adresa nikde v čitelné podobě');
  assert.equal(fc.dec(JSON.parse(row.payload).to_enc), 'Jana.Novakova@example.com');
  assert.equal(JSON.parse(row.payload).reservationId, 5);
  assert.equal(outbox.hasMail(db, 'test', 5), true);
  assert.equal(outbox.hasMail(db, 'test', 6), false);
  assert.equal(outbox.listForReservation(db, 5).length, 1);
  assert.equal(outbox.pending(db, 10, '2026-10-01T10:00:00.000Z').length, 1);
  assert.equal(outbox.pending(db, 10, '2026-10-01T09:00:00.000Z').length, 0, 'run_at v budoucnu');
  outbox.markFailed(db, id, 'SMTP nedostupné');
  assert.equal(db.prepare('SELECT attempts, error FROM outbox WHERE id = ?').get(id).attempts, 1);
  outbox.markSent(db, id, '2026-10-01T10:05:00.000Z');
  const sent = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id);
  assert.equal(sent.sent_at, '2026-10-01T10:05:00.000Z');
  assert.equal(sent.error, null);
  assert.equal(outbox.pending(db, 10, '2026-10-02T10:00:00.000Z').length, 0);
  // bez adresáta (interní) a validace
  const internal = outbox.enqueue(db, { type: 'internal', subject: 'S', text: 'T', fieldCrypto: fc });
  assert.equal(db.prepare('SELECT to_hmac FROM outbox WHERE id = ?').get(internal).to_hmac, null);
  assert.throws(() => outbox.enqueue(db, { type: 'x', subject: '', text: 'T' }), /předmět/);
  assert.throws(() => outbox.enqueue(db, { type: 'x', to: 'a@b.cz', subject: 'S', text: 'T' }), /fieldCrypto/);
});

test('buildMailData dešifruje jméno jen do paměti; anonymizovaný zákazník → bez adresáta', () => {
  const db = memoryDb();
  db.prepare("INSERT INTO bike_types(id, slug, name, category, deposit_minor, fee_minor, value_minor) VALUES (1, 't', 'Trek', 'trek', 1, 1, 1)").run();
  db.prepare('INSERT INTO customers(id, email_hmac, email_enc, name_enc, created_at) VALUES (1, ?, ?, ?, ?)').run(fc.hmacEmail('a@example.com'), fc.enc('a@example.com'), fc.enc('Adam Test'), '2026-01-01T00:00:00.000Z');
  db.prepare("INSERT INTO reservations(id, number, status, customer_id, from_at, to_at, total_minor, fee_minor, created_at, updated_at) VALUES (1, '2610000001', 'confirmed', 1, '2026-10-10T07:00:00.000Z', '2026-10-11T15:00:00.000Z', 1000, 300, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO reservation_items(reservation_id, bike_type_id, size, unit_price_minor, fee_minor, accessories) VALUES (1, 1, 'M', 500, 150, '[{\"slug\":\"prilba\",\"label\":\"Přilba\",\"qty\":1,\"unitPriceMinor\":50,\"amountMinor\":100}]'), (1, 1, 'M', 500, 150, '[]')").run();
  const r = db.prepare('SELECT * FROM reservations WHERE id = 1').get();
  const { to, data } = outbox.buildMailData({ db, reservation: r, tenant, settings: tenant.settings, fieldCrypto: fc, baseUrl: 'https://ksprehledy.cz/', token: 'tok' });
  assert.equal(to, 'a@example.com');
  assert.equal(data.customer.name, 'Adam Test');
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].qty, 2);
  assert.equal(data.items[0].amountMinor, 1000);
  assert.equal(data.accessories[0].label, 'Přilba');
  assert.equal(data.manageUrl, 'https://ksprehledy.cz/rezervace/tok');
  const id = outbox.sendReservationMail(db, { type: 'reminder', reservation: r, tenant, settings: tenant.settings, fieldCrypto: fc, baseUrl: 'https://ksprehledy.cz', token: 'tok' });
  assert.ok(id);
  db.prepare("UPDATE customers SET anonymized_at = '2026-11-01T00:00:00.000Z' WHERE id = 1").run();
  assert.equal(outbox.sendReservationMail(db, { type: 'reminder', reservation: r, tenant, settings: tenant.settings, fieldCrypto: fc, baseUrl: 'https://ksprehledy.cz', token: 'tok' }), null);
});
