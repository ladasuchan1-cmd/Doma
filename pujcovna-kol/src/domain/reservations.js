'use strict';
// Rezervace (SPEC kap. 9): vytvoření v transakci BEGIN IMMEDIATE, stavový automat, číslo rezervace (= VS), token správy.
//
//   create({ db, tenant, settings, fieldCrypto, secret, draft, ipHash, baseUrl, now })
//       draft = { fromAt, toAt, items: [{ typeId, size, qty }], accessories: [{ slug, qty }],
//                 customer: { name, email, phone }, consents: { termsVersion, marketing } }
//       → { reservation, token, items }   (status awaiting_fee, e-mail „potvrzení rezervace“ do outboxu)
//       Uvnitř transakce se dostupnost spočítá znovu (availability.assertAvailable) a teprve pak se vkládá;
//       při nedostatku vyhodí AvailabilityError („Kolo mezitím někdo rezervoval“).
//
//   transition(db, reservationId, event, meta)  → { reservation, changed, cancellation? }
//       události: create (draft→awaiting_fee), fee_paid (awaiting_fee→confirmed), expire (awaiting_fee→expired),
//       check_out (confirmed→checked_out), return (checked_out→returned), close (returned→closed),
//       cancel_by_customer / cancel_by_operator (awaiting_fee|confirmed→cancelled_*), no_show (confirmed→no_show).
//       Každý přechod: version+1 (optimistický zámek), audit_log, ledger_entries / payments (vratky), e-maily do outboxu
//       (jen když meta.mail = { fieldCrypto, tenant, settings, baseUrl, secret }). Opakovaný stejný event = no-op
//       ({ changed: false }); nepovolený přechod vyhodí TransitionError.
//       meta (nikdy PII): userId, ipHash, now, amountMinor, paymentId, note, items: [{ itemId, bikeId }],
//       depositMinor, depositMethod, damageMinor, depositCapturedMinor, depositReleasedMinor, balancePaidMinor, settings.
//
//   nextNumber(db, now) → 'RRMM' + 6 číslic sekvence v měsíci (např. 2610000001)
//   tokenFor(reservation, secret) / verifyToken({ db, token, secret, now }) – podepsaný token (90 dní) deterministicky
//       z created_at, v DB jen token_hash (sha256) → odkaz lze zneplatnit smazáním otisku.
//   get, getByNumber, loadDetail (položky, zákazník bez PII, platby, ledger, doklady, e-maily)
//   recordPayment(db, {...}) – pomocný zápis řádku payments (demo / simulace); ostrý zápis dělá src/payments/*.
//   runMaintenance({ db, tenant, settings, fieldCrypto, baseUrl, secret, now, log }) – expirace awaiting_fee po expires_at,
//       no_show po to_at bez výdeje, připomínky den před (outbox type 'reminder').

const { nowIso, transaction, parseJson } = require('../db');
const tokens = require('../crypto/tokens');
const availability = require('./availability');
const pricing = require('./pricing');
const cancellation = require('./cancellation');
const outbox = require('../mail/outbox');

const TOKEN_TTL_MS = 90 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

const STATES = Object.freeze(['draft', 'awaiting_fee', 'confirmed', 'checked_out', 'returned', 'closed', 'expired', 'cancelled_by_customer', 'cancelled_by_operator', 'no_show']);

const TRANSITIONS = Object.freeze({
  create: { from: ['draft'], to: 'awaiting_fee' },
  fee_paid: { from: ['awaiting_fee'], to: 'confirmed' },
  expire: { from: ['awaiting_fee'], to: 'expired' },
  check_out: { from: ['confirmed'], to: 'checked_out' },
  return: { from: ['checked_out'], to: 'returned' },
  close: { from: ['returned'], to: 'closed' },
  cancel_by_customer: { from: ['awaiting_fee', 'confirmed'], to: 'cancelled_by_customer' },
  cancel_by_operator: { from: ['awaiting_fee', 'confirmed'], to: 'cancelled_by_operator' },
  no_show: { from: ['confirmed'], to: 'no_show' },
});

const STATUS_LABELS = Object.freeze({
  draft: 'Rozepsaná',
  awaiting_fee: 'Čeká na poplatek',
  confirmed: 'Potvrzená',
  checked_out: 'Vydaná',
  returned: 'Vrácená',
  closed: 'Uzavřená',
  expired: 'Propadlá (nezaplaceno)',
  cancelled_by_customer: 'Zrušená zákazníkem',
  cancelled_by_operator: 'Zrušená půjčovnou',
  no_show: 'Nevyzvednutá',
});

const STATUS_TONES = Object.freeze({
  draft: 'neutral',
  awaiting_fee: 'warning',
  confirmed: 'success',
  checked_out: 'info',
  returned: 'info',
  closed: 'neutral',
  expired: 'danger',
  cancelled_by_customer: 'danger',
  cancelled_by_operator: 'danger',
  no_show: 'danger',
});

/** Stavy, ve kterých zákazník může rezervaci zrušit. */
const CANCELLABLE = Object.freeze(['awaiting_fee', 'confirmed']);

class TransitionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'TransitionError';
    this.details = details || null;
  }
}

class NotFoundError extends Error {
  constructor(message = 'Rezervace nebyla nalezena.') {
    super(message);
    this.name = 'NotFoundError';
  }
}

function iso(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  if (value) return new Date(value).toISOString();
  return nowIso();
}

/** Spustí fn v transakci, pokud už jedna neběží (node:sqlite neumí vnořené BEGIN). */
function inTransaction(db, fn) {
  if (db.isTransaction) return fn(db);
  return transaction(db, fn);
}

// ---------------------------------------------------------------------------------------------------------
// Čtení

function get(db, id) {
  return db.prepare('SELECT * FROM reservations WHERE id = ?').get(Number(id)) || null;
}

function getByNumber(db, number) {
  return db.prepare('SELECT * FROM reservations WHERE number = ?').get(String(number)) || null;
}

/** Detail pro stránky: položky, příslušenství, platby, ledger, doklady, e-maily (bez PII zákazníka). */
function loadDetail(db, reservation) {
  const { items, accessories, rows } = outbox.loadItems(db, reservation.id);
  const payments = db.prepare('SELECT * FROM payments WHERE reservation_id = ? ORDER BY id').all(reservation.id);
  const ledger = db.prepare('SELECT * FROM ledger_entries WHERE reservation_id = ? ORDER BY id').all(reservation.id);
  const documents = db.prepare('SELECT id, type, number, issued_at FROM documents WHERE reservation_id = ? ORDER BY id').all(reservation.id);
  const mails = outbox.listForReservation(db, reservation.id);
  const paidMinor = Number(reservation.paid_minor) || 0;
  return { reservation, items, itemRows: rows, accessories, payments, ledger, documents, mails, balanceMinor: Math.max(0, Number(reservation.total_minor) - paidMinor) };
}

// ---------------------------------------------------------------------------------------------------------
// Číslo rezervace a token

/** 'RRMM' + 6-místná sekvence v rámci měsíce (Praha). Volat v transakci. */
function nextNumber(db, now = new Date()) {
  const local = availability.utcToLocal(now instanceof Date ? now : new Date(now));
  const prefix = `${local.date.slice(2, 4)}${local.date.slice(5, 7)}`;
  const last = db.prepare("SELECT number FROM reservations WHERE number LIKE ? || '%' ORDER BY number DESC LIMIT 1").get(prefix);
  const seq = last ? Number(String(last.number).slice(4)) + 1 : 1;
  if (seq > 999999) throw new Error('Vyčerpána číselná řada rezervací pro tento měsíc.');
  return `${prefix}${String(seq).padStart(6, '0')}`;
}

/** Deterministický token správy rezervace (z id a created_at) – lze kdykoli znovu odvodit pro e-maily. */
function tokenFor(reservation, secret) {
  const createdAt = Date.parse(reservation.created_at);
  if (!Number.isFinite(createdAt)) throw new Error('Rezervace nemá platný created_at.');
  return tokens.sign({ r: Number(reservation.id) }, TOKEN_TTL_MS, secret, { now: createdAt });
}

/** Ověří token: podpis + expirace + shoda otisku s reservations.token_hash. Vrací řádek rezervace nebo null. */
function verifyToken({ db, token, secret, now = Date.now() }) {
  const payload = tokens.verify(token, secret, { now: typeof now === 'number' ? now : new Date(now).getTime() });
  if (!payload || !Number.isInteger(payload.r)) return null;
  const r = get(db, payload.r);
  if (!r || !r.token_hash) return null;
  if (!tokens.safeEqual(tokens.sha256(token), r.token_hash)) return null;
  return r;
}

// ---------------------------------------------------------------------------------------------------------
// Pomocné zápisy

function audit(db, { now, userId = null, action, entity = 'reservation', entityId, meta = null, ipHash = null }) {
  db.prepare('INSERT INTO audit_log(at, user_id, action, entity, entity_id, meta, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    now,
    userId,
    action,
    entity,
    entityId === undefined || entityId === null ? null : String(entityId),
    meta ? JSON.stringify(meta) : null,
    ipHash
  );
}

function ledger(db, { reservationId, type, amountMinor, paymentId = null, note = null, now }) {
  const r = db.prepare('INSERT INTO ledger_entries(reservation_id, type, amount_minor, payment_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    Number(reservationId),
    type,
    Math.round(Number(amountMinor)),
    paymentId,
    note,
    now
  );
  return Number(r.lastInsertRowid);
}

/** Pomocný zápis platby (demo simulace, na místě). Ostré platby zapisuje src/payments/*. */
function recordPayment(db, { reservationId, purpose, method, provider, providerRef = null, amountMinor, capturedMinor = null, status, idempotencyKey = null, vs = null, spayd = null, now = nowIso() }) {
  const r = db
    .prepare(
      `INSERT INTO payments(reservation_id, purpose, method, provider, provider_ref, amount_minor, captured_minor, status, idempotency_key, vs, spayd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(Number(reservationId), purpose, method, provider, providerRef, Math.round(Number(amountMinor)), capturedMinor === null ? (status === 'paid' ? Math.round(Number(amountMinor)) : 0) : Math.round(Number(capturedMinor)), status, idempotencyKey, vs, spayd, now, now);
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(r.lastInsertRowid));
}

/** Vratka: řádek payments purpose='refund' původní metodou (karta/mock → refunded; převod → pending) + ledger refund. */
function refund(db, { reservation, amountMinor, event, now, note }) {
  if (!(amountMinor > 0)) return null;
  const original = db.prepare("SELECT * FROM payments WHERE reservation_id = ? AND purpose IN ('fee', 'balance') AND status = 'paid' ORDER BY id DESC LIMIT 1").get(reservation.id);
  const method = original ? original.method : 'bank_transfer';
  const provider = original ? original.provider : 'manual';
  const status = method === 'card' ? 'refunded' : 'pending';
  const key = `refund:${reservation.id}:${event}`;
  const existing = db.prepare('SELECT * FROM payments WHERE idempotency_key = ?').get(key);
  const payment =
    existing ||
    recordPayment(db, { reservationId: reservation.id, purpose: 'refund', method, provider, providerRef: original ? original.provider_ref : null, amountMinor, capturedMinor: 0, status, idempotencyKey: key, vs: reservation.number, now });
  ledger(db, { reservationId: reservation.id, type: 'refund', amountMinor, paymentId: payment.id, note: note || (status === 'pending' ? 'Vratka převodem – čeká na potvrzení obsluhou' : 'Vratka na kartu'), now });
  return payment;
}

// ---------------------------------------------------------------------------------------------------------
// Vytvoření

function upsertCustomer(db, { fieldCrypto, customer, consents, now }) {
  const email = String(customer.email || '').trim();
  const hmac = fieldCrypto.hmacEmail(email);
  const existing = db.prepare('SELECT id FROM customers WHERE email_hmac = ? AND anonymized_at IS NULL ORDER BY id DESC LIMIT 1').get(hmac);
  const marketingAt = consents && consents.marketing ? now : null;
  if (existing) {
    db.prepare('UPDATE customers SET name_enc = ?, phone_enc = ?, email_enc = ?, marketing_consent_at = COALESCE(?, marketing_consent_at) WHERE id = ?').run(
      fieldCrypto.enc(customer.name),
      customer.phone ? fieldCrypto.enc(customer.phone) : null,
      fieldCrypto.enc(email),
      marketingAt,
      existing.id
    );
    return existing.id;
  }
  const r = db.prepare('INSERT INTO customers(email_hmac, email_enc, name_enc, phone_enc, marketing_consent_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    hmac,
    fieldCrypto.enc(email),
    fieldCrypto.enc(customer.name),
    customer.phone ? fieldCrypto.enc(customer.phone) : null,
    marketingAt,
    now
  );
  return Number(r.lastInsertRowid);
}

/** Expirace čekání na poplatek: now + transferExpiryHours, nejpozději však začátek pronájmu (min. 30 min od teď). */
function feeExpiry({ now, fromAt, settings }) {
  const hours = Number(settings && settings.transferExpiryHours) > 0 ? Number(settings.transferExpiryHours) : 48;
  const nowMs = new Date(now).getTime();
  let exp = nowMs + hours * 3600 * 1000;
  const from = new Date(fromAt).getTime();
  if (exp > from) exp = Math.max(nowMs + 30 * 60 * 1000, from);
  return new Date(exp).toISOString();
}

/**
 * Vytvoří rezervaci (awaiting_fee) v jedné transakci: kontrola dostupnosti → zákazník → rezervace → položky → audit → e-mail.
 */
function create({ db, tenant, settings = {}, fieldCrypto, secret, draft, ipHash = null, baseUrl = '', now = new Date(), log = null, sendMail = true }) {
  if (!draft || !draft.fromAt || !draft.toAt) throw new TransitionError('Chybí termín rezervace.');
  if (!draft.customer || !draft.customer.email || !draft.customer.name) throw new TransitionError('Chybí údaje zákazníka.');
  const nowStr = iso(now);
  const fromAt = iso(draft.fromAt);
  const toAt = iso(draft.toAt);
  const items = (draft.items || []).map((it) => ({ typeId: Number(it.typeId), size: String(it.size), qty: Math.floor(Number(it.qty) || 0) })).filter((it) => it.qty > 0);
  if (!items.length) throw new TransitionError('Vyberte prosím alespoň jedno kolo.');
  const accessories = (draft.accessories || []).map((a) => ({ slug: String(a.slug), qty: Math.floor(Number(a.qty) || 0) })).filter((a) => a.qty > 0);

  return inTransaction(db, () => {
    availability.assertAvailable({ db, items, fromAt, toAt, settings });
    let totalMinor = 0;
    let feeMinor = 0;
    let depositMinor = 0;
    const rows = [];
    for (const it of items) {
      const q = pricing.quote({ db, typeId: it.typeId, fromAt, toAt, qty: it.qty, accessories: [] });
      const perBike = Math.round(q.bikesMinor / it.qty);
      const perFee = Math.round(q.feeMinor / it.qty);
      totalMinor += q.bikesMinor;
      feeMinor += q.feeMinor;
      depositMinor += q.depositMinor;
      for (let i = 0; i < it.qty; i++) rows.push({ typeId: it.typeId, size: it.size, unitPriceMinor: perBike, feeMinor: perFee, accessories: [] });
    }
    const days = pricing.lengthOf(fromAt, toAt).days;
    const acc = pricing.accessoriesQuote({ db, accessories, days });
    totalMinor += acc.amountMinor;
    if (acc.lines.length) rows[0].accessories = acc.lines.map((l) => ({ slug: l.slug, label: l.label, qty: l.qty, unitPriceMinor: l.unitPriceMinor, amountMinor: l.amountMinor }));

    const customerId = upsertCustomer(db, { fieldCrypto, customer: draft.customer, consents: draft.consents || {}, now: nowStr });
    const number = nextNumber(db, now);
    const expiresAt = feeExpiry({ now: nowStr, fromAt, settings });
    const termsVersion = (draft.consents && draft.consents.termsVersion) || (tenant && tenant.legal && tenant.legal.version) || null;
    const ins = db
      .prepare(
        `INSERT INTO reservations(number, status, customer_id, from_at, to_at, total_minor, fee_minor, paid_minor, deposit_minor, terms_version, consent_at,
           consent_ip_hash, id_doc_ack_at, expires_at, note, token_hash, version, created_at, updated_at)
         VALUES (?, 'awaiting_fee', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`
      )
      .run(number, customerId, fromAt, toAt, totalMinor, feeMinor, depositMinor, termsVersion, nowStr, ipHash, nowStr, expiresAt, draft.note || null, nowStr, nowStr);
    const id = Number(ins.lastInsertRowid);
    const reservationForToken = { id, created_at: nowStr };
    const token = tokenFor(reservationForToken, secret);
    db.prepare('UPDATE reservations SET token_hash = ? WHERE id = ?').run(tokens.sha256(token), id);
    const insItem = db.prepare('INSERT INTO reservation_items(reservation_id, bike_type_id, size, bike_id, unit_price_minor, fee_minor, accessories) VALUES (?, ?, ?, NULL, ?, ?, ?)');
    for (const r of rows) insItem.run(id, r.typeId, r.size, r.unitPriceMinor, r.feeMinor, JSON.stringify(r.accessories));
    audit(db, { now: nowStr, action: 'reservation.create', entityId: id, ipHash, meta: { number, status: 'awaiting_fee', items: rows.length, totalMinor, feeMinor } });
    const reservation = get(db, id);
    if (sendMail && fieldCrypto) {
      const b = tenant && tenant.business ? tenant.business : {};
      outbox.sendReservationMail(db, {
        type: 'reservation_created',
        reservation,
        tenant,
        settings,
        fieldCrypto,
        baseUrl,
        token,
        now: nowStr,
        extra: { payment: { amountMinor: feeMinor, iban: b.iban || null, accountNumber: b.accountNumber || null, vs: number } },
      });
    }
    if (log) log.info('Rezervace vytvořena', { reservationId: id, number, items: rows.length });
    return { reservation, token, items: rows };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Stavový automat

/** Vedlejší efekty přechodu; vrací { updates, auditMeta, mail: [{ type, extra }] }. */
function applyEvent(db, r, event, meta, now) {
  const updates = {};
  const auditMeta = { from: r.status, event };
  const mails = [];
  const settings = meta.settings || {};
  switch (event) {
    case 'create':
      break;
    case 'fee_paid': {
      const amount = meta.amountMinor === undefined || meta.amountMinor === null ? Number(r.fee_minor) : Math.round(Number(meta.amountMinor));
      updates.paid_minor = Number(r.paid_minor) + amount;
      updates.expires_at = null;
      if (meta.note) updates.note = r.note ? `${r.note}\n${meta.note}` : meta.note;
      if (amount > 0) ledger(db, { reservationId: r.id, type: 'fee_paid', amountMinor: amount, paymentId: meta.paymentId || null, note: meta.note || null, now });
      auditMeta.amountMinor = amount;
      auditMeta.paymentId = meta.paymentId || null;
      if (amount > 0) {
        const payment = meta.paymentId ? db.prepare('SELECT * FROM payments WHERE id = ?').get(meta.paymentId) : null;
        mails.push({ type: 'payment_received', extra: { payment: { amountMinor: amount, method: payment ? payment.method : meta.method || null, at: now }, payload: { paymentId: meta.paymentId || null } } });
      }
      break;
    }
    case 'expire':
      auditMeta.expiresAt = r.expires_at;
      break;
    case 'check_out': {
      if (Array.isArray(meta.items)) {
        const upd = db.prepare('UPDATE reservation_items SET bike_id = ? WHERE id = ? AND reservation_id = ?');
        for (const it of meta.items) if (it && it.itemId) upd.run(it.bikeId || null, Number(it.itemId), r.id);
        auditMeta.bikesAssigned = meta.items.filter((it) => it && it.bikeId).length;
      }
      if (meta.depositMinor !== undefined && meta.depositMinor !== null) {
        updates.deposit_minor = Math.round(Number(meta.depositMinor));
        updates.deposit_method = meta.depositMethod || null;
        if (updates.deposit_minor > 0) ledger(db, { reservationId: r.id, type: 'deposit_held', amountMinor: updates.deposit_minor, paymentId: meta.paymentId || null, note: meta.depositMethod ? `Kauce ${meta.depositMethod}` : null, now });
        auditMeta.depositMinor = updates.deposit_minor;
        auditMeta.depositMethod = meta.depositMethod || null;
      }
      if (meta.balancePaidMinor > 0) {
        updates.paid_minor = Number(r.paid_minor) + Math.round(Number(meta.balancePaidMinor));
        ledger(db, { reservationId: r.id, type: 'balance_paid', amountMinor: Math.round(Number(meta.balancePaidMinor)), paymentId: meta.balancePaymentId || null, note: meta.balanceMethod ? `Doplatek ${meta.balanceMethod}` : null, now });
        auditMeta.balancePaidMinor = Math.round(Number(meta.balancePaidMinor));
      }
      if (meta.note) updates.note = r.note ? `${r.note}\n${meta.note}` : meta.note;
      break;
    }
    case 'return': {
      if (meta.damageMinor > 0) {
        ledger(db, { reservationId: r.id, type: 'damage', amountMinor: Math.round(Number(meta.damageMinor)), note: meta.note || 'Poškození při vrácení', now });
        auditMeta.damageMinor = Math.round(Number(meta.damageMinor));
      }
      if (meta.note) updates.note = r.note ? `${r.note}\n${meta.note}` : meta.note;
      break;
    }
    case 'close': {
      if (meta.balancePaidMinor > 0) {
        updates.paid_minor = Number(r.paid_minor) + Math.round(Number(meta.balancePaidMinor));
        ledger(db, { reservationId: r.id, type: 'balance_paid', amountMinor: Math.round(Number(meta.balancePaidMinor)), paymentId: meta.balancePaymentId || null, note: meta.balanceMethod ? `Doplatek ${meta.balanceMethod}` : null, now });
        auditMeta.balancePaidMinor = Math.round(Number(meta.balancePaidMinor));
      }
      if (meta.depositCapturedMinor > 0) {
        ledger(db, { reservationId: r.id, type: 'deposit_captured', amountMinor: Math.round(Number(meta.depositCapturedMinor)), paymentId: meta.paymentId || null, note: meta.note || 'Stržení z kauce', now });
        auditMeta.depositCapturedMinor = Math.round(Number(meta.depositCapturedMinor));
      }
      const released = meta.depositReleasedMinor !== undefined && meta.depositReleasedMinor !== null ? Math.round(Number(meta.depositReleasedMinor)) : Math.max(0, Number(r.deposit_minor) - (Number(meta.depositCapturedMinor) || 0));
      if (released > 0 && Number(r.deposit_minor) > 0) {
        ledger(db, { reservationId: r.id, type: 'deposit_released', amountMinor: released, paymentId: meta.paymentId || null, note: 'Kauce uvolněna', now });
        auditMeta.depositReleasedMinor = released;
      }
      break;
    }
    case 'cancel_by_customer': {
      const q = cancellation.quote({ reservation: r, now, settings });
      if (q.forfeitMinor > 0) ledger(db, { reservationId: r.id, type: 'fee_forfeited', amountMinor: q.forfeitMinor, note: `Storno méně než ${q.freeHoursBefore} h před začátkem`, now });
      if (q.refundMinor > 0) refund(db, { reservation: r, amountMinor: q.refundMinor, event, now });
      updates.expires_at = null;
      Object.assign(auditMeta, { rule: q.rule, hoursBefore: q.hoursBefore, refundMinor: q.refundMinor, forfeitMinor: q.forfeitMinor });
      if (meta.note) updates.note = r.note ? `${r.note}\n${meta.note}` : meta.note;
      mails.push({ type: 'reservation_cancelled', extra: { cancellation: q, cancelledBy: 'customer' } });
      auditMeta.cancellation = q;
      break;
    }
    case 'cancel_by_operator': {
      const q = cancellation.operatorQuote({ reservation: r });
      if (q.refundMinor > 0) refund(db, { reservation: r, amountMinor: q.refundMinor, event, now, note: 'Zrušení půjčovnou – plná vratka' });
      updates.expires_at = null;
      Object.assign(auditMeta, { rule: q.rule, refundMinor: q.refundMinor });
      if (meta.note) updates.note = r.note ? `${r.note}\n${meta.note}` : meta.note;
      mails.push({ type: 'reservation_cancelled', extra: { cancellation: q, cancelledBy: 'operator' } });
      auditMeta.cancellation = q;
      break;
    }
    case 'no_show': {
      const paid = Number(r.paid_minor) || 0;
      if (paid > 0) ledger(db, { reservationId: r.id, type: 'fee_forfeited', amountMinor: paid, note: 'Nevyzvednuto – poplatek propadá', now });
      auditMeta.forfeitMinor = paid;
      break;
    }
    default:
      throw new TransitionError(`Neznámá událost „${event}“.`);
  }
  return { updates, auditMeta, mails };
}

/**
 * Provede přechod stavového automatu.
 * @returns {{ reservation: object, changed: boolean, cancellation?: object }}
 */
function transition(db, reservationId, event, meta = {}) {
  const def = TRANSITIONS[event];
  if (!def) throw new TransitionError(`Neznámá událost „${event}“.`);
  const now = iso(meta.now);
  return inTransaction(db, () => {
    const r = get(db, reservationId);
    if (!r) throw new NotFoundError();
    if (r.status === def.to) return { reservation: r, changed: false };
    if (!def.from.includes(r.status)) {
      throw new TransitionError(`Přechod „${event}“ není ze stavu „${STATUS_LABELS[r.status] || r.status}“ povolen.`, { from: r.status, event, allowedFrom: def.from });
    }
    const { updates, auditMeta, mails } = applyEvent(db, r, event, meta, now);
    const cols = ['status = ?', 'version = version + 1', 'updated_at = ?'];
    const vals = [def.to, now];
    for (const [k, v] of Object.entries(updates)) {
      cols.push(`${k} = ?`);
      vals.push(v === undefined ? null : v);
    }
    vals.push(r.id, r.version);
    const res = db.prepare(`UPDATE reservations SET ${cols.join(', ')} WHERE id = ? AND version = ?`).run(...vals);
    if (Number(res.changes) !== 1) throw new TransitionError('Rezervaci mezitím změnil někdo jiný. Načtěte ji prosím znovu.', { reason: 'version_conflict' });
    audit(db, { now, userId: meta.userId || null, action: `reservation.${event}`, entityId: r.id, ipHash: meta.ipHash || null, meta: { ...auditMeta, to: def.to, version: r.version + 1 } });
    const updated = get(db, r.id);
    if (meta.mail && meta.mail.fieldCrypto && mails.length) {
      const token = meta.mail.secret ? tokenFor(updated, meta.mail.secret) : meta.mail.token || null;
      for (const m of mails) {
        outbox.sendReservationMail(db, {
          type: m.type,
          reservation: updated,
          tenant: meta.mail.tenant,
          settings: meta.mail.settings || settingsOf(meta),
          fieldCrypto: meta.mail.fieldCrypto,
          baseUrl: meta.mail.baseUrl || '',
          token,
          extra: m.extra,
          now,
        });
      }
    }
    return { reservation: updated, changed: true, cancellation: auditMeta.cancellation || undefined };
  });
}

function settingsOf(meta) {
  return meta.settings || {};
}

/** Výpočet storna pro zobrazení (bez zápisu). */
function cancellationQuote(reservation, { now = new Date(), settings = {} } = {}) {
  return cancellation.quote({ reservation, now, settings });
}

// ---------------------------------------------------------------------------------------------------------
// Údržba (joby)

/**
 * Expirace awaiting_fee po expires_at, no_show po to_at bez výdeje, připomínky den před (jednou).
 * @returns {{ expired: number, noShow: number, reminders: number }}
 */
function runMaintenance({ db, tenant, settings = {}, fieldCrypto, baseUrl = '', secret, now = new Date(), log = null }) {
  const nowStr = iso(now);
  const mail = fieldCrypto && secret ? { fieldCrypto, tenant, settings, baseUrl, secret } : null;
  const result = { expired: 0, noShow: 0, reminders: 0 };
  for (const row of db.prepare("SELECT id FROM reservations WHERE status = 'awaiting_fee' AND expires_at IS NOT NULL AND expires_at <= ?").all(nowStr)) {
    try {
      if (transition(db, row.id, 'expire', { now: nowStr, settings }).changed) result.expired++;
    } catch (e) {
      if (log) log.warn('Expirace rezervace selhala', { reservationId: row.id, error: e.message });
    }
  }
  for (const row of db.prepare("SELECT id FROM reservations WHERE status = 'confirmed' AND to_at <= ?").all(nowStr)) {
    try {
      if (transition(db, row.id, 'no_show', { now: nowStr, settings }).changed) result.noShow++;
    } catch (e) {
      if (log) log.warn('Označení no-show selhalo', { reservationId: row.id, error: e.message });
    }
  }
  if (mail) {
    const until = new Date(new Date(nowStr).getTime() + DAY_MS).toISOString();
    for (const r of db.prepare("SELECT * FROM reservations WHERE status = 'confirmed' AND from_at > ? AND from_at <= ?").all(nowStr, until)) {
      if (outbox.hasMail(db, 'reminder', r.id)) continue;
      try {
        const id = outbox.sendReservationMail(db, { type: 'reminder', reservation: r, tenant, settings, fieldCrypto, baseUrl, token: tokenFor(r, secret), now: nowStr });
        if (id) result.reminders++;
      } catch (e) {
        if (log) log.warn('Připomínka selhala', { reservationId: r.id, error: e.message });
      }
    }
  }
  if (log && (result.expired || result.noShow || result.reminders)) log.info('Údržba rezervací', result);
  return result;
}

module.exports = {
  STATES,
  TRANSITIONS,
  STATUS_LABELS,
  STATUS_TONES,
  CANCELLABLE,
  TOKEN_TTL_MS,
  TransitionError,
  NotFoundError,
  AvailabilityError: availability.AvailabilityError,
  get,
  getByNumber,
  loadDetail,
  nextNumber,
  tokenFor,
  verifyToken,
  create,
  transition,
  cancellationQuote,
  recordPayment,
  ledger,
  audit,
  feeExpiry,
  runMaintenance,
  inTransaction,
};
