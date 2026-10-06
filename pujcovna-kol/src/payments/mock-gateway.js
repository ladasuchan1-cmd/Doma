'use strict';
// Simulační platební brána (SPEC kap. 10, provider „mock“). Chová se jako redirect brána typu Comgate: založení platby
// → přesměrování na stránku brány (/simulace-brany/:paymentId?sig=…) → zákazník Zaplatí / Zamítne / Zruší → brána
// nastaví stav (zdroj pravdy = řádek payments, dostupný jen přes podepsaný odkaz) → pošle interní notifikaci
// POST /platby/notifikace/mock se sdíleným tajemstvím → handler (provider.processMockNotification) stav znovu načte
// přes getStatus a teprve pak posune rezervaci. Žádné peníze se nepřevádějí.
//   create({ db, reservation, purpose, amountMinor, capture, returnUrl, baseUrl, secret, idempotencyKey, now })
//       → { payment, redirectUrl }        (status created, provider mock, provider_ref MOCK-…)
//   redirectUrlFor({ payment, returnUrl, capture, baseUrl, secret, now }) → URL simulační stránky s podepsaným sig
//   verifySig({ sig, paymentId, secret, now }) → { p, ret, cap, exp } | null      (HMAC token, platnost 2 h)
//   getStatus({ db, payment }) → { status, amountMinor, capturedMinor, providerRef }   (čerstvě z DB)
//   simulate({ db, payment, action: 'pay'|'decline'|'cancel', capture, now }) → { payment, event }
//   capture({ db, payment, amountMinor, now }) / cancelHold({ db, payment, now }) / refund({ db, payment, amountMinor, now, idempotencyKey })
//   gatewaySecret(secret, tenantSlug) → per-tenant tajemství notifikací (HKDF z PK_SECRET), verifySecret(provided, expected)
//   sendNotification({ url, host, body, timeoutMs }) → Promise<{ status, body }>  (interní HTTP POST JSON)
// Vstup: db tenanta, tajemství aplikace (PK_SECRET). Nikdy nelogovat secret ani tokeny.

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { nowIso } = require('../db');
const tokens = require('../crypto/tokens');

const PROVIDER = 'mock';
const SIG_TTL_MS = 2 * 3600 * 1000;
const NOTIFY_PATH = '/platby/notifikace/mock';

function iso(v) {
  return v ? (v instanceof Date ? v.toISOString() : new Date(v).toISOString()) : nowIso();
}

function loadPayment(db, id) {
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(id)) || null;
}

function update(db, id, fields, now) {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE payments SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => fields[c]), now, Number(id));
  return loadPayment(db, id);
}

/** Per-tenant tajemství pro notifikace (odvozeno HKDF, nikde se neukládá v čitelné podobě). */
function gatewaySecret(secret, tenantSlug) {
  if (!secret || String(secret).length < 16) throw new Error('Tajemství aplikace musí mít alespoň 16 znaků.');
  const ikm = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), `mock-gateway-v1:${tenantSlug || 'default'}`, 32)).toString('hex');
}

/** Porovnání tajemství v konstantním čase. */
function verifySecret(provided, expected) {
  if (typeof provided !== 'string' || !provided) return false;
  return tokens.safeEqual(provided, expected);
}

/**
 * Odkaz na simulační stránku. Simulační brána běží na témže hostu, proto vrací RELATIVNÍ cestu (ctx.redirect přijímá jen
 * relativní cesty – ochrana před open redirect); absolutní URL vrátí jen s { absolute: true }.
 */
function redirectUrlFor({ payment, returnUrl, capture, baseUrl, secret, now = Date.now(), absolute = false }) {
  const sig = tokens.sign({ p: Number(payment.id), ret: String(returnUrl || '/'), cap: capture === 'manual' ? 'manual' : 'auto' }, SIG_TTL_MS, secret, { now: typeof now === 'number' ? now : new Date(now).getTime() });
  const pathPart = `/simulace-brany/${payment.id}?sig=${encodeURIComponent(sig)}`;
  return absolute ? `${String(baseUrl || '').replace(/\/+$/, '')}${pathPart}` : pathPart;
}

function verifySig({ sig, paymentId, secret, now = Date.now() }) {
  const payload = tokens.verify(String(sig || ''), secret, { now: typeof now === 'number' ? now : new Date(now).getTime() });
  if (!payload || Number(payload.p) !== Number(paymentId)) return null;
  return payload;
}

/** Založí platbu u „brány“: řádek payments (created) a odkaz na simulační stránku. */
function create({ db, reservation, purpose, amountMinor, capture = 'auto', returnUrl, baseUrl, secret, idempotencyKey, now }) {
  const at = iso(now);
  const ref = `MOCK-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const amount = Math.round(Number(amountMinor));
  const r = db
    .prepare(
      `INSERT INTO payments(reservation_id, purpose, method, provider, provider_ref, amount_minor, captured_minor, status, idempotency_key, vs, spayd, created_at, updated_at)
       VALUES (?, ?, 'card', ?, ?, ?, 0, 'created', ?, ?, NULL, ?, ?)`
    )
    .run(reservation.id, purpose, PROVIDER, ref, amount, idempotencyKey || null, reservation.number, at, at);
  const payment = loadPayment(db, r.lastInsertRowid);
  return { payment, redirectUrl: redirectUrlFor({ payment, returnUrl, capture, baseUrl, secret, now: new Date(at).getTime() }) };
}

/** Stav platby ze zdroje pravdy (u mocku tabulka payments). */
function getStatus({ db, payment }) {
  const fresh = loadPayment(db, payment.id);
  if (!fresh) return null;
  return { status: fresh.status, amountMinor: Number(fresh.amount_minor), capturedMinor: Number(fresh.captured_minor), providerRef: fresh.provider_ref, purpose: fresh.purpose, payment: fresh };
}

/**
 * Akce zákazníka na simulační stránce. Z neterminálního stavu (created/pending):
 *   pay → paid (capture auto) nebo authorized (capture manual) · decline → failed · cancel → failed (event cancelled).
 * V terminálním stavu nic nemění (event null).
 */
function simulate({ db, payment, action, capture = 'auto', now }) {
  const at = iso(now);
  const fresh = loadPayment(db, payment.id);
  if (!fresh) throw new Error('Platba nenalezena.');
  if (!['created', 'pending'].includes(fresh.status)) return { payment: fresh, event: null };
  if (action === 'pay') {
    const manual = capture === 'manual' || fresh.purpose === 'deposit_hold';
    const updated = manual ? update(db, fresh.id, { status: 'authorized', captured_minor: 0 }, at) : update(db, fresh.id, { status: 'paid', captured_minor: fresh.amount_minor }, at);
    return { payment: updated, event: manual ? 'authorized' : 'paid' };
  }
  if (action === 'decline') return { payment: update(db, fresh.id, { status: 'failed' }, at), event: 'failed' };
  if (action === 'cancel') return { payment: update(db, fresh.id, { status: 'failed' }, at), event: 'cancelled' };
  throw new Error(`Neznámá akce brány „${action}“.`);
}

/** Stržení z preautorizace (plné nebo částečné). */
function capture({ db, payment, amountMinor, now }) {
  const at = iso(now);
  const fresh = loadPayment(db, payment.id);
  if (!fresh) throw new Error('Platba nenalezena.');
  if (fresh.status !== 'authorized') throw new Error(`Strhnout lze jen preautorizovanou platbu (stav „${fresh.status}“).`);
  const amount = amountMinor === undefined || amountMinor === null ? Number(fresh.amount_minor) : Math.round(Number(amountMinor));
  if (!(amount >= 0) || amount > Number(fresh.amount_minor)) throw new Error('Částka ke stržení musí být 0 až výše blokace.');
  if (amount === 0) return update(db, fresh.id, { status: 'released', captured_minor: 0 }, at);
  return update(db, fresh.id, { status: amount === Number(fresh.amount_minor) ? 'captured' : 'partially_captured', captured_minor: amount }, at);
}

/** Uvolnění preautorizace bez stržení. */
function cancelHold({ db, payment, now }) {
  const at = iso(now);
  const fresh = loadPayment(db, payment.id);
  if (!fresh) throw new Error('Platba nenalezena.');
  if (fresh.status === 'released') return fresh;
  if (fresh.status !== 'authorized') throw new Error(`Uvolnit lze jen preautorizovanou platbu (stav „${fresh.status}“).`);
  return update(db, fresh.id, { status: 'released', captured_minor: 0 }, at);
}

/** Vratka zaplacené platby (okamžitě refunded). Vrací { refund, payment }. */
function refund({ db, payment, amountMinor, now, idempotencyKey }) {
  const at = iso(now);
  const fresh = loadPayment(db, payment.id);
  if (!fresh) throw new Error('Platba nenalezena.');
  if (!['paid', 'captured', 'partially_captured', 'partially_refunded'].includes(fresh.status)) throw new Error(`Vrátit lze jen zaplacenou platbu (stav „${fresh.status}“).`);
  const paidTotal = fresh.status === 'paid' || fresh.status === 'partially_refunded' ? Number(fresh.amount_minor) : Number(fresh.captured_minor);
  const already = db.prepare("SELECT COALESCE(SUM(amount_minor), 0) AS s FROM payments WHERE purpose = 'refund' AND provider = ? AND provider_ref LIKE ? AND status = 'refunded'").get(PROVIDER, `${fresh.provider_ref}-RF%`).s;
  const amount = Math.round(Number(amountMinor));
  if (!(amount > 0) || amount + Number(already) > paidTotal) throw new Error('Částka vratky překračuje zaplacenou částku.');
  if (idempotencyKey) {
    const existing = db.prepare('SELECT * FROM payments WHERE idempotency_key = ?').get(idempotencyKey);
    if (existing) return { refund: existing, payment: fresh };
  }
  const ref = `${fresh.provider_ref}-RF${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const r = db
    .prepare(
      `INSERT INTO payments(reservation_id, purpose, method, provider, provider_ref, amount_minor, captured_minor, status, idempotency_key, vs, spayd, created_at, updated_at)
       VALUES (?, 'refund', 'card', ?, ?, ?, 0, 'refunded', ?, ?, NULL, ?, ?)`
    )
    .run(fresh.reservation_id, PROVIDER, ref, amount, idempotencyKey || null, fresh.vs, at, at);
  const refundRow = loadPayment(db, r.lastInsertRowid);
  const total = Number(already) + amount;
  const updated = update(db, fresh.id, { status: total >= paidTotal ? 'refunded' : 'partially_refunded' }, at);
  return { refund: refundRow, payment: updated };
}

/** Interní notifikace (JSON POST). url = absolutní adresa, host = hlavička Host pro výběr tenanta. */
function sendNotification({ url, host, body, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(
      { host: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: target.pathname + target.search, method: 'POST', headers: { host: host || target.host, 'content-type': 'application/json', 'content-length': String(data.length), 'user-agent': 'pk-mock-gateway/1.0' }, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('Notifikace vypršela.')));
    req.on('error', reject);
    req.end(data);
  });
}

module.exports = { PROVIDER, NOTIFY_PATH, SIG_TTL_MS, create, redirectUrlFor, verifySig, getStatus, simulate, capture, cancelHold, refund, gatewaySecret, verifySecret, sendNotification, loadPayment };
