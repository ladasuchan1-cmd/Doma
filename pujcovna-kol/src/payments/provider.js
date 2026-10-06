'use strict';
// Rozhraní PaymentProvider + registry podle tenant.settings (SPEC kap. 10, rešerše 02 kap. 6). Jediné místo, které
// zakládá platby a po jejich doručení posouvá rezervaci – vždy přes require('../domain/reservations').transition(),
// nikdy přímou změnou stavu. Každá platba = řádek payments s idempotency_key.
//
//   createPayment({ db, reservation, purpose: fee|balance|deposit_hold, method: card|bank_transfer|cash|terminal,
//                   amountMinor, capture: auto|manual, returnUrl, tenant, settings, ctx, baseUrl, secret, now, userId })
//       → { payment, redirectUrl? (karta → simulační brána), spayd?, qrSvg?, iban?, accountNumber?, vs?, expiresAt? (převod) }
//       Neuzavřená platba téže rezervace/účelu/metody se znovu použije (nový odkaz / tytéž údaje k převodu).
//       Hotově / terminál (na místě) → provider manual, poplatek/doplatek ihned paid + vypořádání, kauce authorized.
//   getStatus({ db, payment })        → { status, amountMinor, capturedMinor, providerRef } ze zdroje pravdy brány
//   capture({ db, payment, amountMinor, … }) / cancelHold({ db, payment, … }) – preautorizace kauce (admin při vrácení);
//       ledger deposit_captured/deposit_released zapisuje reservations.transition('close', { depositCapturedMinor, … })
//   refund({ db, payment, amountMinor, reason, … }) → { refund, payment }  (karta mock → refunded ihned; převod → pending
//       do potvrzení confirmRefund()); ledger refund + opravný doklad k vratce zdaněného poplatku
//   settle({ db, payment, tenant, settings, fieldCrypto, secret, baseUrl, now, log, ipHash, userId, note })
//       – zaplacený poplatek → transition fee_paid + doklad (documents.issueForPayment) + e-mail „platba přijata“ s odkazem
//         na doklad; zaplacený doplatek → ledger balance_paid + doklad (přechod pro doplatek zatím neexistuje, viz TODO);
//         kauce authorized → audit. Idempotentní (opakované volání nic nemění).
//   processMockNotification({ db, tenant, settings, body, secret, … }) → { ok, code, duplicate?, status?, settled? }
//       – ověří secret (timingSafeEqual), zapíše webhook_events (UNIQUE provider+event_id, duplicita = no-op), stav ZNOVU
//         načte přes getStatus a teprve pak volá settle. Částka/stav z těla notifikace se nikdy nepoužijí.
//   runMaintenance({ db, tenant, settings, fieldCrypto, secret, baseUrl, now, log }) – job: dohnání ztracených notifikací,
//       expirace opuštěných plateb, auto-uvolnění preautorizací (preauthMaxDays; demo preauthWarnMinutes/preauthReleaseMinutes)
//       s interním e-mailem obsluze, doplnění dokladů.
//   gatewayFor(settings) / matcherFor(settings) – registry: gateway 'mock', bankMatcher 'fio-mock'.
// Vstup: db tenanta; peníze v haléřích; časy ISO UTC. Log nikdy neobsahuje tajemství ani údaje zákazníka.

const { nowIso, parseJson } = require('../db');
const reservations = require('../domain/reservations');
const documents = require('../domain/documents');
const outbox = require('../mail/outbox');
const { publicBaseUrl } = require('../tenants');
const ledger = require('./ledger');
const bank = require('./bank-transfer');
const mock = require('./mock-gateway');

const PURPOSES = Object.freeze(['fee', 'balance', 'deposit_hold']);
const METHODS = Object.freeze(['card', 'bank_transfer', 'cash', 'terminal']);
const GATEWAYS = Object.freeze({ mock });
const MANUAL = 'manual';
const CREATED_TTL_MS = 2 * 3600 * 1000;
const DAY_MS = 86400000;
const OPEN_RESERVATION = new Set(['awaiting_fee', 'confirmed', 'checked_out', 'returned']);

class PaymentError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'PaymentError';
    this.details = details || null;
  }
}

function iso(v) {
  return v ? (v instanceof Date ? v.toISOString() : new Date(v).toISOString()) : nowIso();
}

function loadPayment(db, id) {
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(id)) || null;
}

function updatePayment(db, id, fields, now) {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE payments SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => fields[c]), now, Number(id));
  return loadPayment(db, id);
}

function gatewayFor(settings) {
  const name = (settings && settings.gateway) || 'mock';
  const gw = GATEWAYS[name];
  if (!gw) throw new PaymentError(`Platební brána „${name}“ není k dispozici.`);
  return gw;
}

function matcherFor(settings) {
  const name = (settings && settings.bankMatcher) || 'fio-mock';
  if (name === 'fio-mock') return require('./fio-mock');
  throw new PaymentError(`Párování banky „${name}“ není k dispozici.`);
}

function audit(db, { now, userId = null, action, reservationId, meta, ipHash = null }) {
  reservations.audit(db, { now, userId, action, entity: 'reservation', entityId: reservationId, meta, ipHash });
}

function tenantIban(tenant) {
  const b = (tenant && tenant.business) || {};
  if (b.iban && bank.validateIban(b.iban)) return String(b.iban).replace(/\s+/g, '').toUpperCase();
  if (b.accountNumber) return bank.ibanFromCzAccount(b.accountNumber);
  throw new PaymentError('Půjčovna nemá nastavený bankovní účet (business.iban / accountNumber).');
}

function depsOf(opts) {
  const ctx = opts.ctx || null;
  const app = ctx && ctx.app ? ctx.app : {};
  return {
    secret: opts.secret || app.secret || null,
    fieldCrypto: opts.fieldCrypto || app.fieldCrypto || null,
    baseUrl: opts.baseUrl || (ctx ? publicBaseUrl(opts.tenant, { host: ctx.req.headers.host, secure: ctx.secure }) : opts.tenant ? publicBaseUrl(opts.tenant) : ''),
    ipHash: opts.ipHash || (ctx ? ctx.ipHash : null),
    log: opts.log || (ctx ? ctx.log : null),
    userId: opts.userId || null,
  };
}

/** Údaje k převodu (IBAN, SPAYD, QR) pro platbu převodem. */
function transferBundle({ tenant, reservation, payment, expiresAt }) {
  const b = (tenant && tenant.business) || {};
  const iban = tenantIban(tenant);
  const remaining = Math.max(0, Number(payment.amount_minor) - Number(payment.captured_minor || 0));
  const spayd = payment.spayd || bank.spayd({ iban, amountMinor: remaining, vs: payment.vs || reservation.number, msg: `Rezervace ${reservation.number}`, dueDate: expiresAt || undefined });
  return { spayd, qrSvg: bank.qrSvg(spayd), iban, accountNumber: b.accountNumber || null, vs: payment.vs || reservation.number, expiresAt: expiresAt || null };
}

/**
 * Založí platbu. Viz hlavička souboru.
 */
async function createPayment(opts) {
  const { db, reservation, purpose = 'fee', method, capture = 'auto', returnUrl, tenant, settings = {} } = opts;
  if (!db || !reservation || !reservation.id) throw new PaymentError('Chybí rezervace.');
  if (!PURPOSES.includes(purpose)) throw new PaymentError(`Neznámý účel platby „${purpose}“.`);
  if (!METHODS.includes(method)) throw new PaymentError(`Neznámá platební metoda „${method}“.`);
  const amount = Math.round(Number(opts.amountMinor));
  if (!Number.isFinite(amount) || amount <= 0) throw new PaymentError('Částka platby musí být kladná.');
  const now = iso(opts.now);
  const deps = depsOf(opts);
  const r = reservations.get(db, reservation.id);
  if (!r) throw new PaymentError('Rezervace nebyla nalezena.');
  const captureMode = purpose === 'deposit_hold' || capture === 'manual' ? 'manual' : 'auto';

  // znovupoužití neuzavřené platby
  const reusable = db
    .prepare("SELECT * FROM payments WHERE reservation_id = ? AND purpose = ? AND method = ? AND status IN ('created', 'pending') ORDER BY id DESC LIMIT 1")
    .get(r.id, purpose, method);
  if (reusable && Number(reusable.amount_minor) === amount) {
    if (method === 'card' && reusable.provider === mock.PROVIDER) {
      if (!deps.secret) throw new PaymentError('Chybí tajemství pro podpis odkazu brány.');
      return { payment: reusable, redirectUrl: mock.redirectUrlFor({ payment: reusable, returnUrl, capture: captureMode, baseUrl: deps.baseUrl, secret: deps.secret, now: new Date(now).getTime() }), reused: true };
    }
    if (method === 'bank_transfer') return { payment: reusable, ...transferBundle({ tenant, reservation: r, payment: reusable, expiresAt: purpose === 'fee' ? r.expires_at : null }), reused: true };
  }

  const seq = db.prepare('SELECT COUNT(*) AS n FROM payments WHERE reservation_id = ? AND purpose = ? AND method = ?').get(r.id, purpose, method).n + 1;

  if (method === 'card') {
    const gw = gatewayFor(settings);
    if (!deps.secret) throw new PaymentError('Chybí tajemství pro podpis odkazu brány.');
    const provider = gw.PROVIDER || settings.gateway || 'mock';
    const key = `${provider}:${r.id}:${purpose}:card:${seq}`;
    const created = gw.create({ db, reservation: r, purpose, amountMinor: amount, capture: captureMode, returnUrl, baseUrl: deps.baseUrl, secret: deps.secret, idempotencyKey: key, now });
    audit(db, { now, userId: deps.userId, action: 'payment.create', reservationId: r.id, ipHash: deps.ipHash, meta: { paymentId: created.payment.id, purpose, method, amountMinor: amount, provider, capture: captureMode } });
    if (deps.log) deps.log.info('Platba založena', { reservationId: r.id, paymentId: created.payment.id, purpose, method, provider });
    return created;
  }

  if (method === 'bank_transfer') {
    const provider = settings.bankMatcher || 'fio-mock';
    const hours = Number(settings.transferExpiryHours) > 0 ? Number(settings.transferExpiryHours) : 48;
    const expiresAt = purpose === 'fee' ? r.expires_at || reservations.feeExpiry({ now, fromAt: r.from_at, settings }) : new Date(new Date(now).getTime() + hours * 3600 * 1000).toISOString();
    const iban = tenantIban(tenant);
    const spayd = bank.spayd({ iban, amountMinor: amount, vs: r.number, msg: `Rezervace ${r.number}`, dueDate: expiresAt });
    const key = `${provider}:${r.id}:${purpose}:bank_transfer:${seq}`;
    const ins = db
      .prepare(
        `INSERT INTO payments(reservation_id, purpose, method, provider, provider_ref, amount_minor, captured_minor, status, idempotency_key, vs, spayd, created_at, updated_at)
         VALUES (?, ?, 'bank_transfer', ?, NULL, ?, 0, 'pending', ?, ?, ?, ?, ?)`
      )
      .run(r.id, purpose, provider, amount, key, r.number, spayd, now, now);
    const payment = loadPayment(db, ins.lastInsertRowid);
    if (purpose === 'fee' && !r.expires_at && r.status === 'awaiting_fee') {
      // pojistka: create() expiraci nastavuje; kdyby chyběla, nastavíme ji, aby job rezervací mohl expirovat
      db.prepare('UPDATE reservations SET expires_at = ? WHERE id = ? AND expires_at IS NULL').run(expiresAt, r.id);
    }
    audit(db, { now, userId: deps.userId, action: 'payment.create', reservationId: r.id, ipHash: deps.ipHash, meta: { paymentId: payment.id, purpose, method, amountMinor: amount, provider } });
    if (deps.log) deps.log.info('Platba převodem založena', { reservationId: r.id, paymentId: payment.id, purpose });
    return { payment, ...transferBundle({ tenant, reservation: r, payment, expiresAt }) };
  }

  // hotově / terminál – na místě, zapisuje obsluha
  const key = `${MANUAL}:${r.id}:${purpose}:${method}:${seq}`;
  const hold = purpose === 'deposit_hold';
  const ins = db
    .prepare(
      `INSERT INTO payments(reservation_id, purpose, method, provider, provider_ref, amount_minor, captured_minor, status, idempotency_key, vs, spayd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
    )
    .run(r.id, purpose, method, MANUAL, opts.providerRef || null, amount, hold ? 0 : amount, hold ? 'authorized' : 'paid', key, r.number, now, now);
  const payment = loadPayment(db, ins.lastInsertRowid);
  audit(db, { now, userId: deps.userId, action: 'payment.create', reservationId: r.id, ipHash: deps.ipHash, meta: { paymentId: payment.id, purpose, method, amountMinor: amount, provider: MANUAL } });
  const settled = hold ? null : settle({ db, payment, tenant, settings, ...deps, now, note: opts.note });
  return { payment: loadPayment(db, payment.id), settled };
}

/** Stav platby ze zdroje pravdy. */
function getStatus({ db, payment }) {
  const fresh = loadPayment(db, payment.id);
  if (!fresh) return null;
  if (fresh.provider === mock.PROVIDER) return mock.getStatus({ db, payment: fresh });
  return { status: fresh.status, amountMinor: Number(fresh.amount_minor), capturedMinor: Number(fresh.captured_minor), providerRef: fresh.provider_ref, purpose: fresh.purpose, payment: fresh };
}

/** Stržení (části) preautorizované kauce. Ledger zapisuje přechod close. */
function capture({ db, payment, amountMinor, now, userId = null, ipHash = null, log = null }) {
  const at = iso(now);
  const fresh = loadPayment(db, payment.id);
  if (!fresh) throw new PaymentError('Platba nenalezena.');
  let updated;
  if (fresh.provider === mock.PROVIDER) updated = mock.capture({ db, payment: fresh, amountMinor, now: at });
  else {
    if (fresh.status !== 'authorized') throw new PaymentError(`Strhnout lze jen složenou kauci (stav „${fresh.status}“).`);
    const amount = amountMinor === undefined || amountMinor === null ? Number(fresh.amount_minor) : Math.round(Number(amountMinor));
    if (!(amount >= 0) || amount > Number(fresh.amount_minor)) throw new PaymentError('Částka ke stržení musí být 0 až výše kauce.');
    updated = updatePayment(db, fresh.id, { status: amount === 0 ? 'released' : amount === Number(fresh.amount_minor) ? 'captured' : 'partially_captured', captured_minor: amount }, at);
  }
  audit(db, { now: at, userId, action: 'payment.capture', reservationId: fresh.reservation_id, ipHash, meta: { paymentId: fresh.id, capturedMinor: Number(updated.captured_minor), status: updated.status } });
  if (log) log.info('Kauce stržena', { paymentId: fresh.id, capturedMinor: Number(updated.captured_minor) });
  return updated;
}

/** Uvolnění preautorizace bez stržení. */
function cancelHold({ db, payment, now, userId = null, ipHash = null, log = null, reason = null }) {
  const at = iso(now);
  const fresh = loadPayment(db, payment.id);
  if (!fresh) throw new PaymentError('Platba nenalezena.');
  let updated;
  if (fresh.provider === mock.PROVIDER) updated = mock.cancelHold({ db, payment: fresh, now: at });
  else {
    if (fresh.status === 'released') return fresh;
    if (fresh.status !== 'authorized') throw new PaymentError(`Uvolnit lze jen složenou kauci (stav „${fresh.status}“).`);
    updated = updatePayment(db, fresh.id, { status: 'released', captured_minor: 0 }, at);
  }
  audit(db, { now: at, userId, action: 'payment.release', reservationId: fresh.reservation_id, ipHash, meta: { paymentId: fresh.id, reason } });
  if (log) log.info('Kauce uvolněna', { paymentId: fresh.id, reason });
  return updated;
}

/**
 * Vratka zaplacené platby (admin). Karta (mock) → refunded ihned; převod / hotově → řádek pending do potvrzení obsluhou.
 * Zapíše ledger refund; k vratce poplatku se zdaněným dokladem vystaví opravný doklad (až po provedení vratky).
 */
function refund({ db, payment, amountMinor, reason = null, tenant, settings = {}, fieldCrypto = null, now, userId = null, ipHash = null, log = null }) {
  const at = iso(now);
  const fresh = loadPayment(db, payment.id);
  if (!fresh) throw new PaymentError('Platba nenalezena.');
  if (!['fee', 'balance'].includes(fresh.purpose)) throw new PaymentError('Vratku lze provést jen u poplatku nebo doplatku (kauce se uvolňuje).');
  const amount = Math.round(Number(amountMinor === undefined || amountMinor === null ? fresh.amount_minor : amountMinor));
  if (!(amount > 0)) throw new PaymentError('Částka vratky musí být kladná.');
  const r = reservations.get(db, fresh.reservation_id);
  const seq = db.prepare("SELECT COUNT(*) AS n FROM payments WHERE reservation_id = ? AND purpose = 'refund'").get(fresh.reservation_id).n + 1;
  const key = `refund:${fresh.reservation_id}:${fresh.id}:${seq}`;
  let refundRow;
  if (fresh.provider === mock.PROVIDER) {
    const res = mock.refund({ db, payment: fresh, amountMinor: amount, now: at, idempotencyKey: key });
    refundRow = res.refund;
  } else {
    if (!['paid', 'partially_refunded'].includes(fresh.status)) throw new PaymentError(`Vrátit lze jen zaplacenou platbu (stav „${fresh.status}“).`);
    const already = db.prepare("SELECT COALESCE(SUM(amount_minor), 0) AS s FROM payments WHERE purpose = 'refund' AND idempotency_key LIKE ?").get(`refund:${fresh.reservation_id}:${fresh.id}:%`).s;
    if (amount + Number(already) > Number(fresh.amount_minor)) throw new PaymentError('Částka vratky překračuje zaplacenou částku.');
    const method = fresh.method === 'card' ? 'card' : 'bank_transfer';
    const ins = db
      .prepare(
        `INSERT INTO payments(reservation_id, purpose, method, provider, provider_ref, amount_minor, captured_minor, status, idempotency_key, vs, spayd, created_at, updated_at)
         VALUES (?, 'refund', ?, ?, ?, ?, 0, 'pending', ?, ?, NULL, ?, ?)`
      )
      .run(fresh.reservation_id, method, MANUAL, fresh.provider_ref, amount, key, fresh.vs, at, at);
    refundRow = loadPayment(db, ins.lastInsertRowid);
    updatePayment(db, fresh.id, { status: amount + Number(already) >= Number(fresh.amount_minor) ? 'refunded' : 'partially_refunded' }, at);
  }
  ledger.add(db, { reservationId: fresh.reservation_id, type: 'refund', amountMinor: amount, paymentId: refundRow.id, note: reason || (refundRow.status === 'refunded' ? 'Vratka na kartu' : 'Vratka převodem – čeká na potvrzení obsluhou'), now: at });
  audit(db, { now: at, userId, action: 'payment.refund', reservationId: fresh.reservation_id, ipHash, meta: { paymentId: fresh.id, refundId: refundRow.id, amountMinor: amount, status: refundRow.status, reason } });
  let document = null;
  if (refundRow.status === 'refunded' && fresh.purpose === 'fee' && r && tenant) {
    try {
      document = documents.issueCreditNote(db, { reservation: r, refund: refundRow, tenant, settings, fieldCrypto, now: at, reason });
    } catch (e) {
      if (log) log.warn('Opravný doklad k vratce se nepodařilo vystavit', { reservationId: fresh.reservation_id, error: e.message });
    }
  }
  if (log) log.info('Vratka zapsána', { reservationId: fresh.reservation_id, refundId: refundRow.id, amountMinor: amount, status: refundRow.status });
  return { refund: refundRow, payment: loadPayment(db, fresh.id), document };
}

/** Potvrzení odeslané vratky převodem (admin): pending → refunded + opravný doklad. */
function confirmRefund({ db, payment, tenant, settings = {}, fieldCrypto = null, now, userId = null, ipHash = null, log = null }) {
  const at = iso(now);
  const fresh = loadPayment(db, payment.id);
  if (!fresh || fresh.purpose !== 'refund') throw new PaymentError('Nejde o vratku.');
  if (fresh.status === 'refunded') return { refund: fresh, document: null };
  if (fresh.status !== 'pending') throw new PaymentError(`Vratku ve stavu „${fresh.status}“ nelze potvrdit.`);
  const updated = updatePayment(db, fresh.id, { status: 'refunded' }, at);
  audit(db, { now: at, userId, action: 'payment.refund_confirmed', reservationId: fresh.reservation_id, ipHash, meta: { refundId: fresh.id, amountMinor: Number(fresh.amount_minor) } });
  let document = null;
  const r = reservations.get(db, fresh.reservation_id);
  if (r && tenant) {
    try {
      document = documents.issueCreditNote(db, { reservation: r, refund: updated, tenant, settings, fieldCrypto, now: at });
    } catch (e) {
      if (log) log.warn('Opravný doklad k vratce se nepodařilo vystavit', { reservationId: fresh.reservation_id, error: e.message });
    }
  }
  return { refund: updated, document };
}

/**
 * Vypořádání doručené platby (po ověření stavu u brány / spárování převodu). Idempotentní.
 * @returns {{ settled: boolean, reason?: string, reservation?: object, document?: object, mailId?: number|null }}
 */
function settle({ db, payment, tenant, settings = {}, fieldCrypto = null, secret = null, baseUrl = '', now, log = null, ipHash = null, userId = null, note = null }) {
  const at = iso(now);
  const p = loadPayment(db, payment.id);
  if (!p) throw new PaymentError('Platba nenalezena.');
  const r = reservations.get(db, p.reservation_id);
  if (!r) throw new PaymentError('Rezervace platby nenalezena.');
  const amount = Number(p.captured_minor) > 0 && p.status === 'paid' ? Number(p.captured_minor) : Number(p.amount_minor);

  if (p.purpose === 'fee') {
    if (p.status !== 'paid') {
      if (p.status === 'failed') audit(db, { now: at, userId, action: 'payment.failed', reservationId: r.id, ipHash, meta: { paymentId: p.id, method: p.method } });
      return { settled: false, reason: `payment_${p.status}` };
    }
    if (r.status !== 'awaiting_fee') {
      const already = !!db.prepare("SELECT 1 FROM ledger_entries WHERE reservation_id = ? AND type = 'fee_paid' AND payment_id = ?").get(r.id, p.id);
      if (!already) {
        audit(db, { now: at, userId, action: r.status === 'confirmed' || r.status === 'checked_out' ? 'payment.duplicate' : 'payment.orphan', reservationId: r.id, ipHash, meta: { paymentId: p.id, amountMinor: amount, reservationStatus: r.status } });
        if (log) log.warn('Zaplacený poplatek k rezervaci, která na něj nečeká', { reservationId: r.id, paymentId: p.id, status: r.status });
      }
      return { settled: false, reason: `reservation_${r.status}`, reservation: r };
    }
    const res = reservations.transition(db, r.id, 'fee_paid', { paymentId: p.id, amountMinor: amount, method: p.method, settings, now: at, ipHash, userId, note });
    // ostatní rozpracované platby poplatku (např. čekající převod, když zákazník nakonec zaplatil kartou) už nejsou potřeba
    db.prepare("UPDATE payments SET status = 'expired', updated_at = ? WHERE reservation_id = ? AND purpose = 'fee' AND id <> ? AND status IN ('created', 'pending')").run(at, r.id, p.id);
    let document = null;
    try {
      document = documents.issueForPayment(db, { reservation: res.reservation, payment: p, tenant, settings, fieldCrypto, now: at });
    } catch (e) {
      if (log) log.warn('Doklad k platbě se nepodařilo vystavit', { reservationId: r.id, paymentId: p.id, error: e.message });
    }
    let mailId = null;
    if (fieldCrypto && secret && !outbox.hasMail(db, 'payment_received', r.id)) {
      const token = reservations.tokenFor(res.reservation, secret);
      const base = String(baseUrl || '').replace(/\/+$/, '');
      mailId = outbox.sendReservationMail(db, {
        type: 'payment_received',
        reservation: res.reservation,
        tenant,
        settings,
        fieldCrypto,
        baseUrl: base,
        token,
        now: at,
        extra: { payment: { amountMinor: amount, method: p.method, at }, document: document ? { number: document.number, url: `${base}/doklady/${encodeURIComponent(document.number)}?t=${encodeURIComponent(token)}` } : undefined, payload: { paymentId: p.id, documentNumber: document ? document.number : null } },
      });
    }
    if (log) log.info('Poplatek vypořádán', { reservationId: r.id, paymentId: p.id, amountMinor: amount, document: document ? document.number : null });
    return { settled: true, reservation: res.reservation, document, mailId };
  }

  if (p.purpose === 'balance') {
    if (p.status !== 'paid') return { settled: false, reason: `payment_${p.status}` };
    const exists = db.prepare("SELECT 1 FROM ledger_entries WHERE reservation_id = ? AND type = 'balance_paid' AND payment_id = ?").get(r.id, p.id);
    if (exists) return { settled: false, reason: 'already_settled', reservation: r };
    ledger.add(db, { reservationId: r.id, type: 'balance_paid', amountMinor: amount, paymentId: p.id, note: note || `Doplatek ${documents.METHOD_LABELS[p.method] || p.method}`, now: at });
    audit(db, { now: at, userId, action: 'payment.balance_paid', reservationId: r.id, ipHash, meta: { paymentId: p.id, amountMinor: amount, method: p.method } });
    let document = null;
    try {
      document = documents.issueForPayment(db, { reservation: r, payment: p, tenant, settings, fieldCrypto, now: at });
    } catch (e) {
      if (log) log.warn('Doklad k doplatku se nepodařilo vystavit', { reservationId: r.id, paymentId: p.id, error: e.message });
    }
    if (log) log.info('Doplatek vypořádán', { reservationId: r.id, paymentId: p.id, amountMinor: amount });
    return { settled: true, reservation: r, document };
  }

  if (p.purpose === 'deposit_hold') {
    if (p.status === 'authorized') {
      const seen = db.prepare("SELECT 1 FROM audit_log WHERE action = 'payment.authorized' AND json_extract(meta, '$.paymentId') = ?").get(p.id);
      if (!seen) audit(db, { now: at, userId, action: 'payment.authorized', reservationId: r.id, ipHash, meta: { paymentId: p.id, amountMinor: Number(p.amount_minor), method: p.method } });
      return { settled: true, reservation: r };
    }
    if (p.status === 'failed') audit(db, { now: at, userId, action: 'payment.failed', reservationId: r.id, ipHash, meta: { paymentId: p.id, purpose: 'deposit_hold' } });
    return { settled: false, reason: `payment_${p.status}` };
  }
  return { settled: false, reason: 'unsupported_purpose' };
}

/**
 * Zpracování notifikace simulační brány. Tělo: { transId, status, secret } – ničemu z něj se nevěří kromě identifikace
 * transakce; secret se ověřuje v konstantním čase; stav se čte přes getStatus().
 */
function processMockNotification({ db, tenant, settings = {}, body, secret, fieldCrypto = null, baseUrl = '', now, log = null, ipHash = null }) {
  const at = iso(now);
  const b = body && typeof body === 'object' ? body : {};
  const transId = typeof b.transId === 'string' ? b.transId.trim() : '';
  if (!/^[A-Z0-9-]{4,64}$/.test(transId)) return { ok: false, code: 400, error: 'Chybí nebo je neplatné transId.' };
  const expected = mock.gatewaySecret(secret, tenant.slug);
  if (!mock.verifySecret(typeof b.secret === 'string' ? b.secret : '', expected)) {
    if (log) log.warn('Notifikace brány s neplatným tajemstvím odmítnuta', { transId });
    return { ok: false, code: 403, error: 'Neplatné tajemství notifikace.' };
  }
  const payment = db.prepare('SELECT * FROM payments WHERE provider = ? AND provider_ref = ?').get(mock.PROVIDER, transId);
  if (!payment) return { ok: false, code: 404, error: 'Neznámá transakce.' };
  const claimed = String(b.status || '')
    .toLowerCase()
    .replace(/[^a-z_]/g, '')
    .slice(0, 32) || 'unknown';
  // Skutečný stav se čte u brány; event_id = mock:<transId>:<skutečný stav>, takže stejná událost je no-op,
  // ale předčasná / podvržená notifikace (tvrdící „paid“ u nezaplacené platby) nezablokuje pozdější skutečné zaplacení.
  const real = getStatus({ db, payment });
  const eventId = `mock:${transId}:${real.status}`;
  const ins = db.prepare('INSERT OR IGNORE INTO webhook_events(provider, event_id, payload, received_at) VALUES (?, ?, ?, ?)').run(mock.PROVIDER, eventId, JSON.stringify({ transId, claimed, status: real.status }), at);
  if (Number(ins.changes) === 0) {
    if (log) log.info('Duplicitní notifikace brány ignorována', { transId, status: real.status });
    return { ok: true, code: 200, duplicate: true, status: real.status };
  }
  const result = settle({ db, payment, tenant, settings, fieldCrypto, secret, baseUrl, now: at, log, ipHash });
  db.prepare('UPDATE webhook_events SET processed_at = ? WHERE provider = ? AND event_id = ?').run(nowIso(), mock.PROVIDER, eventId);
  if (log) log.info('Notifikace brány zpracována', { transId, claimed, real: real.status, settled: result.settled, reason: result.reason || null });
  return { ok: true, code: 200, status: real.status, settled: result.settled, reason: result.reason };
}

// ---------------------------------------------------------------------------------------------------------
// Údržba (job)

function preauthWindows(settings = {}) {
  const releaseMs = Number(settings.preauthReleaseMinutes) > 0 ? Number(settings.preauthReleaseMinutes) * 60000 : (Number(settings.preauthMaxDays) > 0 ? Number(settings.preauthMaxDays) : 7) * DAY_MS;
  const warnMs = Number(settings.preauthWarnMinutes) > 0 ? Number(settings.preauthWarnMinutes) * 60000 : Math.max(releaseMs - 2 * DAY_MS, Math.round(releaseMs * 0.7));
  return { releaseMs, warnMs: Math.min(warnMs, releaseMs) };
}

function internalMail(db, { type, tenant, fieldCrypto, subject, text, payload, now }) {
  const to = tenant && tenant.business && tenant.business.email && fieldCrypto ? tenant.business.email : null;
  return outbox.enqueue(db, { type, to, subject, text, payload: { ...payload, internal: true }, fieldCrypto, now });
}

function hasInternalMail(db, type, paymentId) {
  return !!db.prepare("SELECT 1 FROM outbox WHERE type = ? AND json_extract(payload, '$.paymentId') = ?").get(type, Number(paymentId));
}

/**
 * Pravidelná údržba plateb. Vrací počty provedených akcí.
 */
function runMaintenance({ db, tenant, settings = {}, fieldCrypto = null, secret = null, baseUrl = '', now = new Date(), log = null }) {
  const at = iso(now);
  const t = new Date(at).getTime();
  const out = { settled: 0, expiredCreated: 0, expiredTransfers: 0, preauthWarned: 0, preauthReleased: 0, documents: 0 };

  // 1) ztracené notifikace: zaplacené mock poplatky u rezervací čekajících na poplatek
  for (const p of db.prepare("SELECT p.* FROM payments p JOIN reservations r ON r.id = p.reservation_id WHERE p.provider = ? AND p.purpose = 'fee' AND p.status = 'paid' AND r.status = 'awaiting_fee'").all(mock.PROVIDER)) {
    try {
      if (settle({ db, payment: p, tenant, settings, fieldCrypto, secret, baseUrl, now: at, log, note: 'Doplněno údržbou (notifikace brány nedorazila)' }).settled) out.settled++;
    } catch (e) {
      if (log) log.warn('Dohnání platby selhalo', { paymentId: p.id, error: e.message });
    }
  }
  // 2) opuštěné platby u brány (created > 2 h)
  const createdBefore = new Date(t - CREATED_TTL_MS).toISOString();
  out.expiredCreated = Number(db.prepare("UPDATE payments SET status = 'expired', updated_at = ? WHERE provider = ? AND status = 'created' AND created_at <= ?").run(at, mock.PROVIDER, createdBefore).changes);
  // 3) převody čekající u rezervací, které už nejsou otevřené (expirované / zrušené)
  const openList = [...OPEN_RESERVATION].map((s) => `'${s}'`).join(', ');
  out.expiredTransfers = Number(db.prepare(`UPDATE payments SET status = 'expired', updated_at = ? WHERE method = 'bank_transfer' AND purpose IN ('fee','balance') AND status IN ('pending','created') AND reservation_id IN (SELECT id FROM reservations WHERE status NOT IN (${openList}))`).run(at).changes);
  // 4) preautorizace kauce: upozornění a auto-uvolnění
  const { releaseMs, warnMs } = preauthWindows(settings);
  for (const p of db.prepare("SELECT * FROM payments WHERE purpose = 'deposit_hold' AND method = 'card' AND status = 'authorized'").all()) {
    const age = t - new Date(p.updated_at || p.created_at).getTime();
    const r = reservations.get(db, p.reservation_id);
    if (age >= releaseMs) {
      try {
        cancelHold({ db, payment: p, now: at, reason: 'auto_release', log });
        out.preauthReleased++;
        if (!hasInternalMail(db, 'internal_preauth_released', p.id)) {
          internalMail(db, { type: 'internal_preauth_released', tenant, fieldCrypto, now: at, payload: { paymentId: p.id, reservationId: p.reservation_id, number: r ? r.number : null }, subject: `Preautorizace kauce k rezervaci č. ${r ? r.number : p.reservation_id} byla automaticky uvolněna`, text: `Blokace kauce ${(Number(p.amount_minor) / 100).toFixed(2)} Kč (platba č. ${p.id}, ref. ${p.provider_ref}) k rezervaci č. ${r ? r.number : p.reservation_id} dosáhla maximální doby platnosti a byla automaticky uvolněna. Je-li kolo stále venku, složte kauci znovu (nová preautorizace, hotově nebo terminálem).` });
        }
      } catch (e) {
        if (log) log.warn('Auto-uvolnění preautorizace selhalo', { paymentId: p.id, error: e.message });
      }
    } else if (age >= warnMs && !hasInternalMail(db, 'internal_preauth_warning', p.id)) {
      const releaseAt = new Date(new Date(p.updated_at || p.created_at).getTime() + releaseMs).toISOString();
      internalMail(db, { type: 'internal_preauth_warning', tenant, fieldCrypto, now: at, payload: { paymentId: p.id, reservationId: p.reservation_id, number: r ? r.number : null, releaseAt }, subject: `Preautorizace kauce k rezervaci č. ${r ? r.number : p.reservation_id} brzy vyprší`, text: `Blokace kauce ${(Number(p.amount_minor) / 100).toFixed(2)} Kč (platba č. ${p.id}, ref. ${p.provider_ref}) k rezervaci č. ${r ? r.number : p.reservation_id} bude automaticky uvolněna ${releaseAt}. Pokud kola nebudou do té doby vrácena a kauce vypořádána, zajistěte novou kauci.` });
      out.preauthWarned++;
    }
  }
  // 5) chybějící doklady
  try {
    out.documents = documents.syncAll(db, { tenant, settings, fieldCrypto, now: at, log });
  } catch (e) {
    if (log) log.warn('Doplnění dokladů selhalo', { error: e.message });
  }
  if (log && Object.values(out).some((n) => n > 0)) log.info('Údržba plateb', out);
  return out;
}

module.exports = {
  PURPOSES,
  METHODS,
  GATEWAYS,
  MANUAL,
  CREATED_TTL_MS,
  PaymentError,
  gatewayFor,
  matcherFor,
  createPayment,
  getStatus,
  capture,
  cancelHold,
  refund,
  confirmRefund,
  settle,
  processMockNotification,
  runMaintenance,
  preauthWindows,
  transferBundle,
  tenantIban,
  loadPayment,
  parseJson,
};
