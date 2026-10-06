'use strict';
// Simulace bankovního API Fio + párování příchozích plateb podle VS (SPEC kap. 10, rešerše 02 kap. 2). Stejné rozhraní
// bude mít budoucí fio.js (poller /last/ → bank_transactions → match). V demu příchozí pohyb vkládá admin tlačítkem
// „Simulovat příchozí převod“ nebo demo stránka /simulace-banky.
//   simulateIncoming({ db, amountMinor, vs, msg, counterAccount, counterName, bookedAt, tenant, settings, fieldCrypto,
//                      secret, baseUrl, now, log }) → { tx, result }     (tx_id náhodné UNIQUE, source 'fio-mock')
//   match(db, deps) → { matched: [], partial: [], unmatched: [] }      projde všechny nespárované pohyby
//   matchOne(db, tx, deps) → { outcome: 'paid'|'overpaid'|'partial'|'unmatched', reason?, payment?, settled? }
//       podle VS → platba převodem pending → paid (settle → transition fee_paid); tolerance ±settings.paymentToleranceMinor
//       (výchozí 500 h = 5 Kč); přeplatek → paid, přijatá částka celá v ledgeru s poznámkou „kredit“; nedoplatek → platba
//       zůstává pending, captured_minor = přijato, e-mail balance_qr s QR na zbytek; bez shody (nebo rezervace už nečeká)
//       → nespárováno (matched_payment_id NULL) pro ruční přiřazení v adminu
//   listUnmatched(db) → nespárované pohyby; manualMatch(db, txId, paymentId, deps) → ruční přiřazení (admin)
//   importTransaction(db, { txId, bookedAt, amountMinor, vs, msg, counterAccount, counterName, raw, source }) → tx | null (duplicita)
// Vstup: db tenanta, peníze v haléřích. Log bez údajů protistrany.

const crypto = require('node:crypto');
const { nowIso } = require('../db');
const reservations = require('../domain/reservations');
const outbox = require('../mail/outbox');
const bank = require('./bank-transfer');

const SOURCE = 'fio-mock';
const DEFAULT_TOLERANCE_MINOR = 500;

function iso(v) {
  return v ? (v instanceof Date ? v.toISOString() : new Date(v).toISOString()) : nowIso();
}

function digits(v) {
  return String(v ?? '').replace(/\D/g, '');
}

function tolerance(settings) {
  const t = settings && settings.paymentToleranceMinor !== undefined ? Number(settings.paymentToleranceMinor) : DEFAULT_TOLERANCE_MINOR;
  return Number.isFinite(t) && t >= 0 ? Math.round(t) : DEFAULT_TOLERANCE_MINOR;
}

/** Vloží pohyb (idempotentně podle tx_id). Vrací řádek, nebo null při duplicitě. */
function importTransaction(db, { txId, bookedAt, amountMinor, vs = null, msg = null, counterAccount = null, counterName = null, raw = null, source = SOURCE }) {
  const amount = Math.round(Number(amountMinor));
  if (!Number.isFinite(amount) || amount === 0) throw new Error('Částka pohybu musí být nenulová.');
  const ins = db
    .prepare('INSERT OR IGNORE INTO bank_transactions(source, tx_id, booked_at, amount_minor, vs, msg, counter_account, counter_name, matched_payment_id, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
    .run(source, String(txId), iso(bookedAt), amount, vs ? digits(vs) || null : null, msg ? String(msg).slice(0, 140) : null, counterAccount || null, counterName || null, raw ? (typeof raw === 'string' ? raw : JSON.stringify(raw)) : null);
  if (Number(ins.changes) === 0) return null;
  return db.prepare('SELECT * FROM bank_transactions WHERE tx_id = ?').get(String(txId));
}

function findPaymentByVs(db, vs) {
  if (!vs) return null;
  return db.prepare("SELECT * FROM payments WHERE vs = ? AND method = 'bank_transfer' AND purpose IN ('fee', 'balance') AND status IN ('pending', 'created') ORDER BY id DESC LIMIT 1").get(vs) || null;
}

/** Přiřadí pohyb k platbě a vypořádá (plná / přeplatek / částečná úhrada). */
function apply(db, tx, payment, deps = {}) {
  const provider = require('./provider');
  const { tenant, settings = {}, fieldCrypto = null, secret = null, baseUrl = '', log = null, userId = null } = deps;
  const at = iso(deps.now);
  const fresh = provider.loadPayment(db, payment.id);
  const reservation = reservations.get(db, fresh.reservation_id);
  const received = Number(fresh.captured_minor || 0) + Number(tx.amount_minor);
  const expected = Number(fresh.amount_minor);
  const tol = tolerance(settings);
  db.prepare('UPDATE bank_transactions SET matched_payment_id = ? WHERE id = ?').run(fresh.id, tx.id);
  if (received >= expected - tol) {
    const diff = received - expected;
    const note = diff > tol ? `Přeplatek ${(diff / 100).toFixed(2)} Kč evidován jako kredit k započtení na doplatek` : diff !== 0 ? `Přijato ${(received / 100).toFixed(2)} Kč (rozdíl ${(diff / 100).toFixed(2)} Kč v toleranci ±${(tol / 100).toFixed(2)} Kč)` : null;
    db.prepare("UPDATE payments SET status = 'paid', captured_minor = ?, provider_ref = COALESCE(provider_ref, ?), updated_at = ? WHERE id = ?").run(received, tx.tx_id, at, fresh.id);
    const settled = provider.settle({ db, payment: fresh, tenant, settings, fieldCrypto, secret, baseUrl, now: at, log, userId, note });
    if (log) log.info('Příchozí převod spárován', { txId: tx.tx_id, paymentId: fresh.id, reservationId: fresh.reservation_id, outcome: diff > tol ? 'overpaid' : 'paid' });
    return { outcome: diff > tol ? 'overpaid' : 'paid', payment: provider.loadPayment(db, fresh.id), settled, diffMinor: diff };
  }
  // nedoplatek: platba zůstává pending, QR na zbytek
  const remaining = expected - received;
  let spayd = fresh.spayd;
  try {
    spayd = bank.spayd({ iban: provider.tenantIban(tenant), amountMinor: remaining, vs: fresh.vs || reservation.number, msg: `Rezervace ${reservation.number} doplatek`, dueDate: reservation.expires_at || undefined });
  } catch {
    /* bez IBAN necháme původní SPAYD */
  }
  db.prepare("UPDATE payments SET status = 'pending', captured_minor = ?, spayd = ?, provider_ref = COALESCE(provider_ref, ?), updated_at = ? WHERE id = ?").run(received, spayd, tx.tx_id, at, fresh.id);
  reservations.audit(db, { now: at, userId, action: 'payment.partial', entity: 'reservation', entityId: fresh.reservation_id, meta: { paymentId: fresh.id, receivedMinor: received, expectedMinor: expected, remainingMinor: remaining } });
  let mailId = null;
  if (fieldCrypto && secret && reservation) {
    const b = (tenant && tenant.business) || {};
    mailId = outbox.sendReservationMail(db, {
      type: 'balance_qr',
      reservation,
      tenant,
      settings,
      fieldCrypto,
      baseUrl,
      token: reservations.tokenFor(reservation, secret),
      now: at,
      extra: { payment: { amountMinor: remaining, iban: b.iban || null, accountNumber: b.accountNumber || null, vs: fresh.vs || reservation.number, spayd, qrSvg: spayd ? bank.qrSvg(spayd) : null, expiresAt: reservation.expires_at }, payload: { paymentId: fresh.id, remainingMinor: remaining } },
    });
  }
  if (log) log.info('Příchozí převod – nedoplatek', { txId: tx.tx_id, paymentId: fresh.id, remainingMinor: remaining });
  return { outcome: 'partial', payment: provider.loadPayment(db, fresh.id), remainingMinor: remaining, mailId };
}

/** Pokusí se spárovat jeden pohyb. */
function matchOne(db, tx, deps = {}) {
  if (tx.matched_payment_id) return { outcome: 'already_matched', payment: provider().loadPayment(db, tx.matched_payment_id) };
  if (Number(tx.amount_minor) <= 0) return { outcome: 'unmatched', reason: 'outgoing' };
  let vs = digits(tx.vs);
  if (!vs && tx.msg) {
    const m = /\b(\d{10})\b/.exec(String(tx.msg));
    if (m) vs = m[1];
  }
  if (!vs) return { outcome: 'unmatched', reason: 'no_vs' };
  const payment = findPaymentByVs(db, vs);
  if (!payment) return { outcome: 'unmatched', reason: 'no_pending_payment' };
  const reservation = reservations.get(db, payment.reservation_id);
  if (!reservation) return { outcome: 'unmatched', reason: 'no_reservation' };
  if (payment.purpose === 'fee' && reservation.status !== 'awaiting_fee') return { outcome: 'unmatched', reason: `reservation_${reservation.status}` };
  if (payment.purpose === 'balance' && !['confirmed', 'checked_out', 'returned'].includes(reservation.status)) return { outcome: 'unmatched', reason: `reservation_${reservation.status}` };
  return apply(db, tx, payment, deps);
}

function provider() {
  return require('./provider');
}

/** Projde všechny nespárované pohyby. */
function match(db, deps = {}) {
  const out = { matched: [], partial: [], unmatched: [] };
  for (const tx of db.prepare('SELECT * FROM bank_transactions WHERE matched_payment_id IS NULL AND amount_minor > 0 ORDER BY id').all()) {
    let res;
    try {
      res = matchOne(db, tx, deps);
    } catch (e) {
      res = { outcome: 'unmatched', reason: `error: ${e.message}` };
      if (deps.log) deps.log.warn('Párování pohybu selhalo', { txId: tx.tx_id, error: e.message });
    }
    const entry = { txId: tx.tx_id, ...res };
    if (res.outcome === 'paid' || res.outcome === 'overpaid') out.matched.push(entry);
    else if (res.outcome === 'partial') out.partial.push(entry);
    else out.unmatched.push(entry);
  }
  return out;
}

/** Simulace příchozí platby (admin / demo). */
function simulateIncoming({ db, amountMinor, vs, msg = null, counterAccount = null, counterName = null, bookedAt, ...deps }) {
  const amount = Math.round(Number(amountMinor));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Částka příchozí platby musí být kladná.');
  const txId = `${SOURCE.toUpperCase()}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const tx = importTransaction(db, { txId, bookedAt: bookedAt || deps.now, amountMinor: amount, vs, msg, counterAccount, counterName, raw: { simulated: true } });
  const result = matchOne(db, tx, deps);
  if (deps.log) deps.log.info('Simulovaný příchozí převod', { txId, amountMinor: amount, outcome: result.outcome, reason: result.reason || null });
  return { tx: db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(tx.id), result };
}

/** Nespárované příchozí pohyby (fronta pro admin). */
function listUnmatched(db) {
  return db.prepare('SELECT * FROM bank_transactions WHERE matched_payment_id IS NULL AND amount_minor > 0 ORDER BY booked_at DESC, id DESC').all();
}

/** Ruční přiřazení pohybu k platbě převodem (admin). */
function manualMatch(db, txId, paymentId, deps = {}) {
  const tx = db.prepare('SELECT * FROM bank_transactions WHERE tx_id = ? OR id = ?').get(String(txId), Number(txId) || -1);
  if (!tx) throw new Error('Bankovní pohyb nenalezen.');
  if (tx.matched_payment_id) throw new Error('Pohyb je už spárovaný.');
  const payment = provider().loadPayment(db, paymentId);
  if (!payment) throw new Error('Platba nenalezena.');
  if (payment.method !== 'bank_transfer' || !['pending', 'created'].includes(payment.status)) throw new Error('Pohyb lze přiřadit jen k čekající platbě převodem.');
  const reservation = reservations.get(db, payment.reservation_id);
  if (payment.purpose === 'fee' && (!reservation || reservation.status !== 'awaiting_fee')) throw new Error('Rezervace už na poplatek nečeká – platbu vraťte nebo rezervaci obnovte.');
  const res = apply(db, tx, payment, deps);
  reservations.audit(db, { now: iso(deps.now), userId: deps.userId || null, action: 'payment.manual_match', entity: 'reservation', entityId: payment.reservation_id, meta: { paymentId: payment.id, txId: tx.tx_id, outcome: res.outcome } });
  return res;
}

module.exports = { SOURCE, DEFAULT_TOLERANCE_MINOR, importTransaction, simulateIncoming, match, matchOne, listUnmatched, manualMatch, tolerance, findPaymentByVs };
