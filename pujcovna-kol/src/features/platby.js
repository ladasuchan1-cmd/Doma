'use strict';
// Feature „platby“ (SPEC kap. 9 a 10): simulační platební brána, notifikace brány, doklady, demo simulace banky,
// údržba plateb (job). Doménová logika je v src/payments/* a src/domain/documents.js – zde jen HTTP vrstva.
//   GET  /simulace-brany/:paymentId?sig=…   stránka „brány“ (podepsaný odkaz z provider.createPayment, platnost 2 h)
//   POST /simulace-brany/:paymentId         akce zaplatit / zamitnout / zrusit (CSRF + sig) → nastaví stav platby,
//                                           pošle interní notifikaci POST /platby/notifikace/mock (loopback, hlavička Host
//                                           původního požadavku) a vrátí zákazníka na returnUrl (jen relativní cesta)
//   POST /platby/notifikace/mock            JSON { transId, status, secret } → provider.processMockNotification
//                                           (secret timingSafeEqual, webhook_events UNIQUE, stav znovu přes getStatus)
//   GET  /doklady/:number[.html]            doklad: vyžaduje admin session, nebo ?t=<token správy rezervace> té rezervace;
//                                           jinak 404. Varianta .html = samostatná tisková stránka
//   GET/POST /simulace-banky                jen PK_DEMO=1: simulace příchozího převodu (fio-mock.simulateIncoming)
//   job payments-maintenance (60 s)         provider.runMaintenance: ztracené notifikace, expirace, preautorizace, doklady
// Export pro admin: provider, fioMock, documents, isAdmin(ctx), tokenOf(ctx, reservation).
// Log nikdy neobsahuje tajemství brány, tokeny ani údaje zákazníka – jen id plateb/rezervací.

const { nowIso } = require('../db');
const { publicBaseUrl, getSettings } = require('../tenants');
const { HttpError } = require('../http/errors');
const { assetUrl } = require('../http/static');
const reservations = require('../domain/reservations');
const documents = require('../domain/documents');
const provider = require('../payments/provider');
const mock = require('../payments/mock-gateway');
const fioMock = require('../payments/fio-mock');
const page = require('../render/pages/platby');

function baseUrlOf(ctx) {
  return publicBaseUrl(ctx.tenant, { host: ctx.req.headers.host, secure: ctx.secure });
}

function assetsOf(ctx) {
  const asset = (p) => assetUrl(p, { publicDir: ctx.config.publicDir, version: ctx.config.version });
  return { base: asset('/base.css'), platby: asset('/css/platby.css') };
}

/** Je požadavek z přihlášené admin session? */
function isAdmin(ctx) {
  try {
    return !!ctx.adminSession.userId();
  } catch {
    return false;
  }
}

/** Návratová adresa z tokenu brány → bezpečná relativní cesta na našem hostu. */
function safeReturnPath(ctx, ret) {
  const s = String(ret || '');
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  try {
    const u = new URL(s);
    const host = String(ctx.req.headers.host || '').toLowerCase();
    if (u.host.toLowerCase() === host) return u.pathname + u.search;
  } catch {
    /* není URL */
  }
  return '/';
}

function paymentOf(ctx) {
  const id = Number(ctx.params.paymentId);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Platba nebyla nalezena.');
  const payment = provider.loadPayment(ctx.db, id);
  if (!payment || payment.provider !== mock.PROVIDER) throw new HttpError(404, 'Platba nebyla nalezena.');
  return payment;
}

// ---------------------------------------------------------------------------------------------------------
// Simulační brána

async function gatewayGet(ctx) {
  const payment = paymentOf(ctx);
  const reservation = reservations.get(ctx.db, payment.reservation_id);
  const assets = assetsOf(ctx);
  const sig = String(ctx.query.sig || '');
  const payload = mock.verifySig({ sig, paymentId: payment.id, secret: ctx.app.secret });
  if (!payload) {
    ctx.log.warn('Simulační brána: neplatný podpis odkazu', { paymentId: payment.id });
    return ctx.html(page.result({ payment: null, event: 'invalid', returnPath: '/', assets, message: 'Odkaz na platbu je neplatný nebo vypršel (platí 2 hodiny). Vraťte se do správy rezervace a platbu založte znovu.' }), 403);
  }
  const returnPath = safeReturnPath(ctx, payload.ret);
  if (!['created', 'pending'].includes(payment.status)) {
    return ctx.html(page.result({ payment, reservation, tenant: ctx.tenant, event: 'done', returnPath, assets }));
  }
  return ctx.html(page.gateway({ csrf: ctx.csrfToken(), payment, reservation, tenant: ctx.tenant, sig, action: `/simulace-brany/${payment.id}`, assets }));
}

/** Interní notifikace na vlastní server (loopback) – jako skutečná brána volá náš endpoint. */
async function notifySelf(ctx, { payment, status }) {
  const port = ctx.req.socket && ctx.req.socket.localPort;
  if (!port) return { ok: false, error: 'bez portu' };
  const url = `http://127.0.0.1:${port}${mock.NOTIFY_PATH}`;
  try {
    const res = await mock.sendNotification({ url, host: ctx.req.headers.host, body: { transId: payment.provider_ref, status, secret: mock.gatewaySecret(ctx.app.secret, ctx.tenant.slug), merchant: ctx.tenant.slug }, timeoutMs: 8000 });
    ctx.log.info('Simulační brána: notifikace odeslána', { paymentId: payment.id, status, httpStatus: res.status });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (e) {
    ctx.log.warn('Simulační brána: notifikaci se nepodařilo doručit (dohoní údržba)', { paymentId: payment.id, error: e.message });
    return { ok: false, error: e.message };
  }
}

async function gatewayPost(ctx) {
  const payment = paymentOf(ctx);
  const reservation = reservations.get(ctx.db, payment.reservation_id);
  const assets = assetsOf(ctx);
  const sig = String(ctx.body.sig || '');
  const payload = mock.verifySig({ sig, paymentId: payment.id, secret: ctx.app.secret });
  if (!payload) throw new HttpError(403, 'Odkaz na platbu je neplatný nebo vypršel.');
  const returnPath = safeReturnPath(ctx, payload.ret);
  const akce = String(ctx.body.akce || '');
  const action = { zaplatit: 'pay', zamitnout: 'decline', zrusit: 'cancel' }[akce];
  if (!action) throw new HttpError(400, 'Neznámá akce brány.');
  const { payment: updated, event } = mock.simulate({ db: ctx.db, payment, action, capture: payload.cap, now: nowIso() });
  if (!event) return ctx.html(page.result({ payment: updated, reservation, tenant: ctx.tenant, event: 'done', returnPath, assets }));
  ctx.log.info('Simulační brána: akce zákazníka', { paymentId: payment.id, event });
  await notifySelf(ctx, { payment: updated, status: event === 'cancelled' ? 'cancelled' : updated.status });
  if (event === 'paid' || event === 'authorized') return ctx.redirect(returnPath);
  return ctx.html(page.result({ payment: updated, reservation, tenant: ctx.tenant, event, returnPath, assets }));
}

// ---------------------------------------------------------------------------------------------------------
// Notifikace

async function notificationPost(ctx) {
  const result = provider.processMockNotification({ db: ctx.db, tenant: ctx.tenant, settings: ctx.settings, body: ctx.body, secret: ctx.app.secret, fieldCrypto: ctx.app.fieldCrypto, baseUrl: baseUrlOf(ctx), now: nowIso(), log: ctx.log, ipHash: ctx.ipHash });
  ctx.json({ ok: result.ok, code: result.code, duplicate: result.duplicate || false, status: result.status || null, settled: result.settled || false, error: result.error || null }, result.code || 200);
}

// ---------------------------------------------------------------------------------------------------------
// Doklady

async function dokladGet(ctx) {
  let number = String(ctx.params.number || '');
  const print = number.endsWith('.html');
  if (print) number = number.slice(0, -5);
  if (!/^[A-Z]{2,4}-\d{4}-\d{6}$/.test(number)) throw new HttpError(404, 'Doklad nebyl nalezen.');
  const doc = documents.get(ctx.db, number);
  if (!doc) throw new HttpError(404, 'Doklad nebyl nalezen.');
  const reservation = reservations.get(ctx.db, doc.reservation_id);
  const token = typeof ctx.query.t === 'string' ? ctx.query.t : null;
  let allowed = isAdmin(ctx);
  if (!allowed && token) {
    const r = reservations.verifyToken({ db: ctx.db, token, secret: ctx.app.secret });
    allowed = !!(r && r.id === doc.reservation_id);
  }
  if (!allowed) {
    ctx.log.warn('Doklad: přístup odmítnut', { number });
    throw new HttpError(404, 'Doklad nebyl nalezen.');
  }
  if (print) {
    return ctx.send(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, documents.wrapPrint(doc.html, { title: `${page.DOC_LABELS[doc.type] || 'Doklad'} ${doc.number}`, cssHref: assetUrl('/css/doklady.css', { publicDir: ctx.config.publicDir, version: ctx.config.version }) }));
  }
  const q = token ? `?t=${encodeURIComponent(token)}` : '';
  return ctx.render(page.documentPage, { doc, reservation, printHref: `/doklady/${encodeURIComponent(doc.number)}.html${q}`, backHref: token ? `/rezervace/${encodeURIComponent(token)}` : isAdmin(ctx) ? `/admin/rezervace/${doc.reservation_id}` : null, demo: !!ctx.simulacePlateb }, { feature: 'platby', noindex: true });
}

// ---------------------------------------------------------------------------------------------------------
// Demo simulace banky

function requireDemo(ctx) {
  if (!ctx.simulacePlateb) throw new HttpError(404, 'Stránka nenalezena.');
}

function bankSimData(ctx) {
  const pending = ctx.db
    .prepare(
      `SELECT p.vs, p.amount_minor, p.captured_minor, r.number, r.expires_at FROM payments p JOIN reservations r ON r.id = p.reservation_id
       WHERE p.method = 'bank_transfer' AND p.status = 'pending'
         AND ((p.purpose = 'fee' AND r.status = 'awaiting_fee') OR (p.purpose = 'balance' AND r.status IN ('confirmed', 'checked_out', 'returned')))
       ORDER BY p.id DESC LIMIT 12`
    )
    .all();
  return { pending, unmatched: fioMock.listUnmatched(ctx.db) };
}

async function bankSimGet(ctx) {
  requireDemo(ctx);
  ctx.render(page.bankSim, { csrf: ctx.csrfToken(), values: { vs: String(ctx.query.vs || ''), castka: String(ctx.query.castka || '') }, tenant: ctx.tenant, ...bankSimData(ctx) }, { feature: 'platby', noindex: true });
}

function parseKc(value) {
  const s = String(value || '')
    .replace(/\s+/g, '')
    .replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

async function bankSimPost(ctx) {
  requireDemo(ctx);
  const values = { castka: String(ctx.body.castka || '').trim(), vs: String(ctx.body.vs || '').trim(), zprava: String(ctx.body.zprava || '').trim().slice(0, 60), protiucet: String(ctx.body.protiucet || '').trim().slice(0, 40) };
  const errors = {};
  const amount = parseKc(values.castka);
  if (amount === null || amount <= 0 || amount > 100000000) errors.castka = 'Zadejte částku v Kč (např. 1000 nebo 995,50).';
  if (!/^\d{1,10}$/.test(values.vs)) errors.vs = 'Variabilní symbol je 1–10 číslic.';
  if (Object.keys(errors).length) return ctx.render(page.bankSim, { csrf: ctx.csrfToken(), values, errors, tenant: ctx.tenant, ...bankSimData(ctx) }, { feature: 'platby', noindex: true, status: 422 });
  const outcome = fioMock.simulateIncoming({ db: ctx.db, amountMinor: amount, vs: values.vs, msg: values.zprava || null, counterAccount: values.protiucet || null, tenant: ctx.tenant, settings: ctx.settings, fieldCrypto: ctx.app.fieldCrypto, secret: ctx.app.secret, baseUrl: baseUrlOf(ctx), now: nowIso(), log: ctx.log, ipHash: ctx.ipHash });
  return ctx.render(page.bankSim, { csrf: ctx.csrfToken(), values: { protiucet: values.protiucet }, outcome, tenant: ctx.tenant, ...bankSimData(ctx) }, { feature: 'platby', noindex: true });
}

// ---------------------------------------------------------------------------------------------------------
// Job

async function maintenanceJob(deps) {
  const { tenants, dbs, fieldCrypto, secret, log } = deps;
  for (const tenant of tenants || []) {
    const db = dbs.get(tenant.slug);
    if (!db) continue;
    try {
      provider.runMaintenance({ db, tenant, settings: getSettings(db, tenant), fieldCrypto, secret, baseUrl: publicBaseUrl(tenant), now: new Date(), log });
    } catch (e) {
      if (log) log.error('Údržba plateb selhala', { tenant: tenant.slug, error: e.message });
    }
  }
}

module.exports = {
  name: 'platby',
  routes: [
    ['GET', '/simulace-brany/:paymentId', gatewayGet, { rateLimit: 'public' }],
    ['POST', '/simulace-brany/:paymentId', gatewayPost, { csrf: true, rateLimit: 'reservation' }],
    ['POST', '/platby/notifikace/mock', notificationPost, { rateLimit: 'api' }],
    ['GET', '/doklady/:number', dokladGet, { rateLimit: 'public' }],
    ['GET', '/simulace-banky', bankSimGet, { rateLimit: 'public' }],
    ['POST', '/simulace-banky', bankSimPost, { csrf: true, rateLimit: 'reservation' }],
  ],
  nav: [],
  css: ['/css/platby.css', '/css/doklady.css'],
  js: [],
  jobs: [{ name: 'payments-maintenance', everyMs: 60 * 1000, fn: maintenanceJob }],
  // pro admin a testy
  provider,
  fioMock,
  documents,
  isAdmin,
  safeReturnPath,
  parseKc,
};
