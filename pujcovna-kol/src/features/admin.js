'use strict';
// Feature „admin“ (SPEC kap. 13): administrace půjčovny na /admin/… – vlastní admin session (__Host-pk_adm, SameSite=Strict,
// idle 30 min / 8 h), přihlášení e-mail + heslo (scrypt) + TOTP je-li zapnuto, zámek účtu po 10 neúspěšných pokusech na
// 15 min (users.failed_logins / locked_until), rate limit „login“, CSRF (synchronizer token admin session + Origin), role
// owner / staff (staff bez Nastavení a uživatelů), každá změna → audit_log. Stránky renderované serverem v layoutu
// (tělo .admin, vlastní admin navigace) + progresivní JS v public/admin/.
//
//   GET  /admin/login, POST /admin/login, GET/POST /admin/login/2fa, POST /admin/logout
//   GET  /admin                                   Dnes
//   GET  /admin/rezervace[?stav&od&do&q]           seznam · GET /admin/rezervace/:id detail (dešifrovaná pole zákazníka – audit)
//   POST /admin/rezervace/:id/{potvrdit-platbu|kola|doklad|kauce|doplatek|vydat|vratit|uzavrit|storno|no-show}
//        – stavy se mění VÝHRADNĚ přes require('../domain/reservations').transition(db, id, event, meta)
//   GET  /admin/kalendar[?od&dny]                  timeline typů / kusů
//   GET  /admin/kola, /admin/kola/typ/:id|novy, /admin/kola/kus/:id|novy, /admin/kola/stitky[?typ|kus]  + POST CRUD
//   GET  /admin/cenik + POST /admin/cenik/{typ/:id|sezona|sezona/:id/smazat|prislusenstvi[/:id]}
//   GET  /admin/platby + POST /admin/platby/{simulace|sparovat|vratka/:id/potvrdit}   (modul plateb přes try/catch)
//   GET  /admin/emaily, /admin/emaily/:id
//   GET  /admin/zakaznici[?email], /admin/zakaznici/:id, /admin/zakaznici/:id/export.json + POST anonymizovat / doklad-smazat
//   GET  /admin/obsah + POST /admin/obsah/texty, /admin/obsah/poi/:id
//   GET  /admin/nastaveni (owner) + POST /admin/nastaveni (sekce rezervace | pravni | retence | oteviraci), /zavreno[/:id/smazat], /uzivatele[/:id]
//   GET  /admin/ucet, /admin/ucet/2fa + POST /admin/ucet/heslo, /admin/ucet/2fa, /admin/ucet/2fa/vypnout
//   GET  /admin/audit, GET /admin/doklady/:number (tisková stránka dokladu)
// Job admin-id-doc-retention: po uplynutí customers.id_doc_delete_after smaže číslo dokladu (audit).
// Log nikdy neobsahuje jméno, e-mail, telefon, číslo dokladu, heslo ani kód – jen id záznamů.

const fs = require('node:fs');
const path = require('node:path');
const { nowIso, parseJson, transaction, setSetting } = require('../db');
const { publicBaseUrl, getSettings } = require('../tenants');
const { HttpError } = require('../http/errors');
const { verifyPassword, hashPassword } = require('../crypto/passwords');
const { normalizeEmail } = require('../crypto/fields');
const totp = require('../crypto/totp');
const qrcode = require('../vendor/qrcode');
const format = require('../render/format');
const { html, raw } = require('../render/html');
const reservations = require('../domain/reservations');
const availability = require('../domain/availability');
const cancellation = require('../domain/cancellation');
const pricing = require('../domain/pricing');
const outbox = require('../mail/outbox');
const pages = require('../render/pages/admin');

const s = pages.shared;
const LOCK_AFTER = 10;
const LOCK_MS = 15 * 60 * 1000;
const TOTP_PENDING_MS = 10 * 60 * 1000;
const PAGE_SIZE = 50;
const ACTIVE_STATES = ['awaiting_fee', 'confirmed', 'checked_out', 'returned'];
const CANCELLED_STATES = ['expired', 'cancelled_by_customer', 'cancelled_by_operator', 'no_show'];
const GENERIC_LOGIN_ERROR = 'Nesprávný e-mail nebo heslo.';
const PHOTO_DIR = path.join(__dirname, '..', '..', 'public', 'img', 'demo', 'kola');
const DOC_PREFIX = Object.freeze({ contract: 'SML', handover: 'PP', return_protocol: 'VP' });

// ---------------------------------------------------------------------------------------------------------
// Volitelné moduly (platby, doklady) – vznikají souběžně; bez nich admin funguje s omezením

function optional(name) {
  try {
    // eslint-disable-next-line global-require
    return require(name);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(path.basename(name))) return null;
    throw e;
  }
}

function modules() {
  const provider = optional('../payments/provider');
  const fio = optional('../payments/fio-mock');
  const documents = optional('../domain/documents');
  const bank = optional('../payments/bank-transfer');
  return { provider: provider && typeof provider.createPayment === 'function' ? provider : null, fio: fio && typeof fio.simulateIncoming === 'function' ? fio : null, documents: documents && typeof documents.issue === 'function' ? documents : null, bank };
}

// ---------------------------------------------------------------------------------------------------------
// Pomocníci

function str(v) {
  return typeof v === 'string' ? v.trim() : Array.isArray(v) ? str(v[0]) : '';
}

function checked(v) {
  return v === '1' || v === 'on' || v === 'true' || (Array.isArray(v) && v.some(checked));
}

/** Částka v Kč (text, čárka i tečka) → haléře; neplatná → null. */
function parseKc(v) {
  const t = str(v).replace(/\s+/g, '').replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function intOr(v, fallback) {
  const n = Number(str(v));
  return Number.isInteger(n) ? n : fallback;
}

function baseUrlOf(ctx) {
  return publicBaseUrl(ctx.tenant, { host: ctx.req.headers.host, secure: ctx.secure });
}

function mailDeps(ctx) {
  return { fieldCrypto: ctx.app.fieldCrypto, tenant: ctx.tenant, settings: ctx.settings, baseUrl: baseUrlOf(ctx), secret: ctx.app.secret };
}

function audit(ctx, action, { entity = null, entityId = null, meta = null, userId } = {}) {
  ctx.db
    .prepare('INSERT INTO audit_log(at, user_id, action, entity, entity_id, meta, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(nowIso(), userId !== undefined ? userId : ctx.user ? ctx.user.id : null, action, entity, entityId === null || entityId === undefined ? null : String(entityId), meta ? JSON.stringify(meta) : null, ctx.ipHash);
}

function flash(ctx, tone, text) {
  ctx.adminSession.set('flash', { tone, html: html`${text}`.toString() });
}

function takeFlash(ctx) {
  const f = ctx.adminSession.get('flash');
  if (f) ctx.adminSession.delete('flash');
  return f || null;
}

function dec(ctx, value) {
  try {
    return value ? ctx.app.fieldCrypto.dec(value) : '';
  } catch {
    return '';
  }
}

/** Vyrenderuje admin stránku (shell v layoutu). */
function render(ctx, body, { title, status = 200, lead, actions, wide, flash: explicitFlash } = {}) {
  const flashMsg = explicitFlash || takeFlash(ctx);
  const user = ctx.user || null;
  const shellHtml = s.shell({ title, body, user, path: ctx.url.pathname, flash: flashMsg, demo: !!ctx.config.demo, csrf: ctx.adminCsrfToken(), tenant: ctx.tenant, lead, actions, wide });
  ctx.render(() => ({ title: `${title} · Administrace`, body: shellHtml, noindex: true, bodyClass: 'admin' }), {}, { feature: 'admin', status });
}

function currentUser(ctx) {
  const id = ctx.adminSession.userId();
  if (!id) return null;
  const u = ctx.db.prepare('SELECT id, email, name, role, totp_enabled, disabled, last_login_at, created_at FROM users WHERE id = ?').get(Number(id));
  if (!u || u.disabled) return null;
  return u;
}

/** Obal handleru: vyžaduje přihlášení (GET → 303 na login), volitelně roli owner. */
function guard(handler, { role } = {}) {
  return async (ctx) => {
    const user = currentUser(ctx);
    if (!user) {
      if (ctx.req.method === 'GET' || ctx.req.method === 'HEAD') return ctx.redirect(`/admin/login?zpet=${encodeURIComponent(ctx.url.pathname + (ctx.url.search || ''))}`);
      throw new HttpError(403, 'Přihlášení vypršelo. Přihlaste se prosím znovu.');
    }
    if (role === 'owner' && user.role !== 'owner') throw new HttpError(403, 'Tato část administrace je dostupná jen majiteli půjčovny (role owner).');
    ctx.user = user;
    return handler(ctx);
  };
}

function reservationOr404(ctx) {
  const id = Number(ctx.params.id);
  const r = Number.isInteger(id) ? reservations.get(ctx.db, id) : null;
  if (!r) throw new HttpError(404, 'Rezervace nebyla nalezena.');
  return r;
}

function back(ctx, r, hash = '') {
  return ctx.redirect(`/admin/rezervace/${r.id}${hash}`);
}

function friendlyError(e) {
  if (e instanceof reservations.TransitionError || e instanceof availability.AvailabilityError || e instanceof pricing.PricingError) return e.message;
  if (e && (e.name === 'PaymentError' || e.name === 'DocumentError')) return e.message;
  return null;
}

/**
 * Chyba vstupu formuláře akce rezervace (nekonzistentní kombinace polí): odpověď 422 s detailem rezervace a
 * vysvětlením v hlášce, bez přesměrování – obsluha vidí formulář i chybu zároveň. Nic se nezapisuje.
 */
class ActionInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ActionInputError';
    this.status = 422;
  }
}

/** Spustí akci; doménové chyby → flash danger + redirect zpět, chyby vstupu → 422 s detailem, ostatní propadnou (500). */
async function tryAction(ctx, r, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ActionInputError && r) {
      ctx.log.warn('Admin akce odmítnuta (422)', { reservationId: r.id, path: ctx.url.pathname, error: e.message });
      return renderDetail(ctx, reservations.get(ctx.db, r.id) || r, { status: 422, flash: { tone: 'danger', html: html`${e.message}`.toString() } });
    }
    const msg = friendlyError(e) || (e && e.code === 'SQLITE_CONSTRAINT' ? 'Operaci nelze provést (porušení integrity dat).' : null);
    if (!msg) throw e;
    ctx.log.warn('Admin akce odmítnuta', { reservationId: r ? r.id : null, path: ctx.url.pathname, error: e.message });
    flash(ctx, 'danger', msg);
    return r ? back(ctx, r) : ctx.redirect(ctx.safePath(ctx.req.headers.referer ? new URL(ctx.req.headers.referer, baseUrlOf(ctx)).pathname : '/admin', '/admin'));
  }
}

// ---------------------------------------------------------------------------------------------------------
// Přihlášení

let dummyHash = null;
function getDummyHash() {
  if (!dummyHash) dummyHash = hashPassword('nespravne-heslo-pro-vyrovnani-casu');
  return dummyHash;
}

function renderLogin(ctx, { error, email, zpet, status = 200 }) {
  const body = pages.login.login({ csrf: ctx.adminCsrfToken(), error, email, zpet, demo: !!ctx.config.demo, demoEmail: ctx.config.adminUser, demoPassword: ctx.config.adminPassword });
  ctx.render(() => ({ title: 'Přihlášení · Administrace', body, noindex: true, bodyClass: 'admin admin--login' }), {}, { feature: 'admin', status });
}

async function loginGet(ctx) {
  if (currentUser(ctx)) return ctx.redirect('/admin');
  return renderLogin(ctx, { zpet: ctx.safePath(ctx.query.zpet, '/admin') });
}

function registerFailure(ctx, user, reason) {
  const failed = Number(user.failed_logins) + 1;
  const locked = failed >= LOCK_AFTER ? new Date(Date.now() + LOCK_MS).toISOString() : null;
  ctx.db.prepare('UPDATE users SET failed_logins = ?, locked_until = COALESCE(?, locked_until) WHERE id = ?').run(failed, locked, user.id);
  audit(ctx, locked ? 'auth.lockout' : 'auth.fail', { entity: 'user', entityId: user.id, meta: { reason, failed }, userId: null });
  ctx.log.warn('Neúspěšné přihlášení', { userId: user.id, failed, locked: !!locked, reason });
  return locked;
}

function completeLogin(ctx, user, zpet, { via }) {
  ctx.adminSession.regenerate();
  ctx.adminSession.delete('totpPending');
  ctx.adminSession.setUser(user.id);
  ctx.db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
  if (ctx.app.rateLimiter) ctx.app.rateLimiter.reset(ctx.ip, 'login');
  audit(ctx, 'auth.login', { entity: 'user', entityId: user.id, meta: { via, role: user.role }, userId: user.id });
  ctx.log.info('Admin přihlášen', { userId: user.id, via });
  return ctx.redirect(ctx.safePath(zpet, '/admin'));
}

async function loginPost(ctx) {
  const email = normalizeEmail(ctx.body.email);
  const password = typeof ctx.body.heslo === 'string' ? ctx.body.heslo : '';
  const zpet = ctx.safePath(ctx.body.zpet, '/admin');
  const fail = (error, status = 401) => renderLogin(ctx, { error, email, zpet, status });
  if (!email || !password) return fail('Zadejte e-mail a heslo.', 422);
  const user = ctx.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    await verifyPassword(password, getDummyHash()); // vyrovnání času odpovědi
    audit(ctx, 'auth.fail', { entity: 'user', meta: { reason: 'unknown_user' }, userId: null });
    return fail(GENERIC_LOGIN_ERROR);
  }
  if (user.disabled) return fail('Účet je zablokovaný. Kontaktujte majitele půjčovny.', 403);
  if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
    audit(ctx, 'auth.locked_attempt', { entity: 'user', entityId: user.id, userId: null });
    return fail(`Účet je dočasně uzamčen po opakovaných neúspěšných pokusech. Zkuste to znovu po ${format.time(user.locked_until)}.`, 403);
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    const locked = registerFailure(ctx, user, 'bad_password');
    return fail(locked ? `Účet byl po ${LOCK_AFTER} neúspěšných pokusech uzamčen na 15 minut.` : GENERIC_LOGIN_ERROR, locked ? 403 : 401);
  }
  if (user.totp_enabled) {
    ctx.adminSession.set('totpPending', { userId: user.id, zpet, at: Date.now() });
    return ctx.redirect('/admin/login/2fa');
  }
  return completeLogin(ctx, user, zpet, { via: 'password' });
}

function pendingTotpUser(ctx) {
  const p = ctx.adminSession.get('totpPending');
  if (!p || !p.userId || Date.now() - Number(p.at) > TOTP_PENDING_MS) return null;
  const user = ctx.db.prepare('SELECT * FROM users WHERE id = ? AND disabled = 0 AND totp_enabled = 1').get(Number(p.userId));
  return user ? { user, zpet: p.zpet } : null;
}

function renderTotp(ctx, { error, zpet, status = 200 }) {
  ctx.render(() => ({ title: 'Ověření · Administrace', body: pages.login.totp({ csrf: ctx.adminCsrfToken(), error, zpet }), noindex: true, bodyClass: 'admin admin--login' }), {}, { feature: 'admin', status });
}

async function totpGet(ctx) {
  const p = pendingTotpUser(ctx);
  if (!p) return ctx.redirect('/admin/login');
  return renderTotp(ctx, { zpet: p.zpet });
}

async function totpPost(ctx) {
  const p = pendingTotpUser(ctx);
  if (!p) return ctx.redirect('/admin/login');
  if (p.user.locked_until && Date.parse(p.user.locked_until) > Date.now()) {
    ctx.adminSession.delete('totpPending');
    return renderLogin(ctx, { error: 'Účet je dočasně uzamčen.', zpet: p.zpet, status: 403 });
  }
  const secret = dec(ctx, p.user.totp_secret_enc);
  const delta = secret ? totp.verify(secret, str(ctx.body.kod)) : null;
  if (delta === null) {
    const locked = registerFailure(ctx, p.user, 'bad_totp');
    if (locked) {
      ctx.adminSession.delete('totpPending');
      return renderLogin(ctx, { error: `Účet byl po ${LOCK_AFTER} neúspěšných pokusech uzamčen na 15 minut.`, zpet: p.zpet, status: 403 });
    }
    return renderTotp(ctx, { error: 'Kód nesouhlasí. Zkontrolujte čas v telefonu a zadejte aktuální kód.', zpet: p.zpet, status: 401 });
  }
  return completeLogin(ctx, p.user, p.zpet, { via: 'password+totp' });
}

async function logoutPost(ctx) {
  const user = currentUser(ctx);
  if (user) audit(ctx, 'auth.logout', { entity: 'user', entityId: user.id, userId: user.id });
  ctx.adminSession.destroy();
  return ctx.redirect('/admin/login');
}

// ---------------------------------------------------------------------------------------------------------
// Dnes

function withItems(db, rows) {
  const stmt = db.prepare(
    `SELECT i.bike_type_id, i.size, COUNT(*) AS qty, t.name AS type_name FROM reservation_items i JOIN bike_types t ON t.id = i.bike_type_id
     WHERE i.reservation_id = ? GROUP BY i.bike_type_id, i.size ORDER BY t.sort, t.name, i.size`
  );
  return rows.map((r) => ({ ...r, items: stmt.all(r.id).map((x) => ({ typeName: x.type_name, size: x.size, qty: Number(x.qty) })) }));
}

async function dnesGet(ctx) {
  const db = ctx.db;
  const today = availability.utcToLocal(new Date()).date;
  const start = availability.localToUtc(today, '00:00').toISOString();
  const end = availability.localToUtc(availability.addDays(today, 1), '00:00').toISOString();
  const now = nowIso();
  const checkouts = withItems(db, db.prepare("SELECT * FROM reservations WHERE status = 'confirmed' AND from_at < ? AND to_at > ? ORDER BY from_at").all(end, now)).map((r) => ({ ...r, flags: r.from_at < start ? s.c.badge('zpožděný výdej', 'warning') : '' }));
  const returns = withItems(db, db.prepare("SELECT * FROM reservations WHERE status = 'checked_out' AND to_at < ? ORDER BY to_at").all(end)).map((r) => ({ ...r, flags: r.to_at < now ? s.c.badge('po termínu', 'danger') : '' }));
  const awaitingFee = db.prepare("SELECT * FROM reservations WHERE status = 'awaiting_fee' ORDER BY expires_at").all();
  const unmatched = db.prepare('SELECT * FROM bank_transactions WHERE matched_payment_id IS NULL AND amount_minor > 0 ORDER BY booked_at DESC LIMIT 20').all();
  const depositsToRelease = db
    .prepare("SELECT p.*, r.number, r.status, r.id AS id FROM payments p JOIN reservations r ON r.id = p.reservation_id WHERE p.purpose = 'deposit_hold' AND p.status = 'authorized' AND r.status IN ('returned', 'closed', 'cancelled_by_operator', 'cancelled_by_customer', 'no_show') ORDER BY p.created_at")
    .all();
  const pendingRefunds = db.prepare("SELECT p.*, r.number, r.id AS id FROM payments p JOIN reservations r ON r.id = p.reservation_id WHERE p.purpose = 'refund' AND p.status = 'pending' ORDER BY p.created_at").all();
  const mails = db.prepare("SELECT id, type, subject, created_at, sent_at, json_extract(payload, '$.number') AS number FROM outbox ORDER BY id DESC LIMIT 8").all();
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM reservations GROUP BY status').all().map((x) => [x.status, Number(x.n)]));
  render(ctx, pages.dnes.dnes({ today, checkouts, returns, awaitingFee, unmatched, depositsToRelease, pendingRefunds, mails, counts, modules: { fio: !!modules().fio } }), { title: 'Dnes', lead: `${ctx.tenant.name} · ${format.dateLong(new Date())}` });
}

// ---------------------------------------------------------------------------------------------------------
// Rezervace – seznam a detail

async function rezervaceList(ctx) {
  const q = ctx.query;
  const filters = { q: str(q.q).replace(/\s+/g, ''), stav: str(q.stav), od: str(q.od), do: str(q.do) };
  const where = [];
  const args = [];
  if (filters.q) {
    where.push('number LIKE ?');
    args.push(`%${filters.q}%`);
  }
  if (filters.stav === 'aktivni') where.push(`status IN (${ACTIVE_STATES.map(() => '?').join(',')})`), args.push(...ACTIVE_STATES);
  else if (filters.stav === 'cancelled') where.push(`status IN (${CANCELLED_STATES.map(() => '?').join(',')})`), args.push(...CANCELLED_STATES);
  else if (filters.stav && reservations.STATES.includes(filters.stav)) where.push('status = ?'), args.push(filters.stav);
  if (/^\d{4}-\d{2}-\d{2}$/.test(filters.od)) where.push('to_at >= ?'), args.push(availability.localToUtc(filters.od, '00:00').toISOString());
  if (/^\d{4}-\d{2}-\d{2}$/.test(filters.do)) where.push('from_at < ?'), args.push(availability.localToUtc(availability.addDays(filters.do, 1), '00:00').toISOString());
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM reservations ${sql}`).get(...args).n;
  const pages_ = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(pages_, Math.max(1, intOr(q.strana, 1)));
  const rows = withItems(ctx.db, ctx.db.prepare(`SELECT * FROM reservations ${sql} ORDER BY from_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE));
  const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
  render(ctx, pages.rezervace.list({ rows, filters, total, page, pages: pages_, href: `/admin/rezervace${params.toString() ? `?${params}` : ''}` }), { title: 'Rezervace', actions: html`<a class="btn btn--secondary btn--sm" href="/admin/kalendar">Kalendář</a>` });
}

/** Dešifrovaný zákazník rezervace (jen pro detail; volající audituje). */
function loadCustomer(ctx, customerId) {
  if (!customerId) return null;
  const c = ctx.db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(customerId));
  if (!c) return null;
  if (c.anonymized_at) return { id: c.id, anonymized: true, anonymizedAt: c.anonymized_at };
  const docNumber = dec(ctx, c.id_doc_number_enc);
  return {
    id: c.id,
    anonymized: false,
    name: dec(ctx, c.name_enc),
    email: dec(ctx, c.email_enc),
    phone: dec(ctx, c.phone_enc),
    address: dec(ctx, c.address_enc),
    idDocType: c.id_doc_type || null,
    idDocNumber: docNumber,
    idDocMasked: docNumber ? `•••••${docNumber.slice(-3)}` : '',
    idDocConsentAt: c.id_doc_consent_at,
    idDocDeleteAfter: c.id_doc_delete_after,
    marketingConsentAt: c.marketing_consent_at,
    createdAt: c.created_at,
  };
}

/** Saldo z ledgeru (modul plateb) nebo ručně z řádků ledger_entries. */
function balanceOf(db, r, ledgerRows) {
  const ledger = optional('../payments/ledger');
  if (ledger && typeof ledger.balance === 'function') return ledger.balance(db, r.id);
  const sums = {};
  for (const row of ledgerRows) sums[row.type] = (sums[row.type] || 0) + Number(row.amount_minor);
  const g = (t) => sums[t] || 0;
  const paidMinor = g('fee_paid') + g('balance_paid') - g('refund');
  const closed = CANCELLED_STATES.includes(r.status);
  return { totalMinor: Number(r.total_minor), paidMinor, feePaidMinor: g('fee_paid'), balancePaidMinor: g('balance_paid'), depositHeldMinor: g('deposit_held'), depositCapturedMinor: g('deposit_captured'), depositReleasedMinor: g('deposit_released'), refundedMinor: g('refund'), forfeitedMinor: g('fee_forfeited'), damageMinor: g('damage'), dueMinor: closed ? 0 : Math.max(0, Number(r.total_minor) + g('damage') - paidMinor - g('deposit_captured')) };
}

/** Volné kusy pro položku (typ + velikost, bez kolize s jinou rezervací včetně bufferu). */
function candidateBikes(ctx, r, row) {
  const b = availability.bufferMs(ctx.settings);
  const toPlus = new Date(new Date(r.to_at).getTime() + b).toISOString();
  const fromMinus = new Date(new Date(r.from_at).getTime() - b).toISOString();
  const states = availability.BLOCKING_STATES.map((x) => `'${x}'`).join(',');
  return ctx.db
    .prepare(
      `SELECT b.* FROM bikes b WHERE b.bike_type_id = ? AND b.size = ? AND b.status = 'available'
       AND b.id NOT IN (SELECT i.bike_id FROM reservation_items i JOIN reservations x ON x.id = i.reservation_id
                        WHERE i.bike_id IS NOT NULL AND x.id != ? AND x.status IN (${states}) AND x.from_at < ? AND x.to_at > ?)
       ORDER BY b.inventory_code`
    )
    .all(row.bike_type_id, row.size, r.id, toPlus, fromMinus);
}

function activeHold(db, r) {
  return db.prepare("SELECT * FROM payments WHERE reservation_id = ? AND purpose = 'deposit_hold' AND status = 'authorized' ORDER BY id DESC LIMIT 1").get(r.id) || null;
}

/** Zaplacené doplatky, které ještě nejsou v ledgeru (zapíše je přechod check_out / close). */
function unledgeredBalance(db, r) {
  const rows = db.prepare("SELECT p.* FROM payments p WHERE p.reservation_id = ? AND p.purpose = 'balance' AND p.status = 'paid' AND NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.payment_id = p.id)").all(r.id);
  return { sumMinor: rows.reduce((a, p) => a + Number(p.captured_minor || p.amount_minor), 0), rows };
}

function detailData(ctx, r) {
  const detail = reservations.loadDetail(ctx.db, r);
  const customer = loadCustomer(ctx, r.customer_id);
  if (customer && !customer.anonymized) audit(ctx, 'customer.view', { entity: 'customer', entityId: customer.id, meta: { reservationId: r.id, fields: ['name', 'email', 'phone', 'id_doc_masked'] } });
  const bikesById = Object.fromEntries(ctx.db.prepare('SELECT * FROM bikes').all().map((b) => [b.id, b]));
  const candidates = {};
  if (['awaiting_fee', 'confirmed'].includes(r.status)) for (const row of detail.itemRows) candidates[row.id] = candidateBikes(ctx, r, row);
  const handovers = ctx.db.prepare('SELECT h.*, u.name AS by_name FROM handovers h LEFT JOIN users u ON u.id = h.by_user_id WHERE h.reservation_id = ? ORDER BY h.at').all(r.id);
  const now = new Date();
  const balance = balanceOf(ctx.db, r, detail.ledger);
  const d = {
    r,
    detail,
    customer,
    balance,
    // dlužná částka po odečtení doplatků už zapsaných (hotově / terminálem), ale do ledgeru promítnutých až při výdeji / uzavření
    outstandingMinor: Math.max(0, balance.dueMinor - unledgeredBalance(ctx.db, r).sumMinor),
    hold: activeHold(ctx.db, r),
    candidates,
    bikesById,
    handovers,
    days: pricing.lengthOf(r.from_at, r.to_at).days,
    operatorQuote: cancellation.operatorQuote({ reservation: r }),
    customerQuote: ['awaiting_fee', 'confirmed'].includes(r.status) ? cancellation.quote({ reservation: r, now, settings: ctx.settings }) : null,
    csrf: ctx.adminCsrfToken(),
    modules: Object.fromEntries(Object.entries(modules()).map(([k, v]) => [k, !!v])),
    settings: ctx.settings,
    now,
  };
  d.actionList = pages.rezervace.actions(d);
  return d;
}

/** Vyrenderuje detail rezervace (GET i odpověď 422 z akce). flash: explicitní hláška místo session flash. */
function renderDetail(ctx, r, { status = 200, flash: explicitFlash } = {}) {
  const d = detailData(ctx, r);
  return render(ctx, pages.rezervace.detail(d), { title: `Rezervace ${r.number}`, status, lead: `${s.format.dateTime(r.from_at)} – ${s.format.dateTime(r.to_at)}`, actions: html`<a class="btn btn--ghost btn--sm" href="/admin/rezervace">← Seznam</a> <a class="btn btn--ghost btn--sm" href="/admin/kalendar?od=${availability.utcToLocal(r.from_at).date}">Kalendář</a>`, wide: true, flash: explicitFlash || undefined });
}

async function rezervaceDetail(ctx) {
  const r = reservationOr404(ctx);
  let extra = null;
  if (ctx.query.kauce === '1') {
    const hold = activeHold(ctx.db, r);
    extra = hold ? { tone: 'success', html: html`Preautorizace kauce ${format.money(hold.amount_minor)} proběhla (ref. ${hold.provider_ref || hold.id}).`.toString() } : { tone: 'warning', html: html`Preautorizace kauce zatím není potvrzená – zkontrolujte stav platby níže.`.toString() };
  }
  renderDetail(ctx, r, { flash: extra });
}

// ---------------------------------------------------------------------------------------------------------
// Rezervace – akce

async function potvrditPlatbuPost(ctx) {
  const r = reservationOr404(ctx);
  return tryAction(ctx, r, () => {
    if (r.status !== 'awaiting_fee') throw new reservations.TransitionError('Rezervace už na poplatek nečeká.');
    const method = ['cash', 'terminal', 'bank_transfer'].includes(str(ctx.body.metoda)) ? str(ctx.body.metoda) : 'cash';
    const amount = parseKc(ctx.body.castka) ?? Number(r.fee_minor);
    if (!(amount > 0)) throw new reservations.TransitionError('Částka musí být kladná.');
    const now = nowIso();
    transaction(ctx.db, () => {
      const pay = reservations.recordPayment(ctx.db, { reservationId: r.id, purpose: 'fee', method, provider: 'manual', amountMinor: amount, status: 'paid', idempotencyKey: `manual:${r.id}:fee:${Date.now()}`, vs: r.number, now });
      reservations.transition(ctx.db, r.id, 'fee_paid', { paymentId: pay.id, amountMinor: amount, method, userId: ctx.user.id, ipHash: ctx.ipHash, settings: ctx.settings, mail: mailDeps(ctx), now, note: `Poplatek přijat ${s.METHOD_LABELS[method] || method} (zapsala obsluha)` });
    });
    syncDocuments(ctx, r.id);
    flash(ctx, 'success', `Poplatek ${format.money(amount)} zapsán, rezervace potvrzena.`);
    return back(ctx, r);
  });
}

/** Ověří a vrátí přiřazení kusů z těla (item_<id> → bikeId). */
function parseAssignments(ctx, r, rows, { requireAll }) {
  const out = [];
  const used = new Set();
  for (const row of rows) {
    const raw_ = str(ctx.body[`item_${row.id}`]);
    if (!raw_) {
      // pole chybí úplně (formulář ho neobsahoval) → ponechat stávající; prázdná hodnota → odebrat přiřazení
      const present = Object.hasOwn(ctx.body, `item_${row.id}`);
      const keep = present ? null : row.bike_id;
      if (requireAll && !keep) throw new reservations.TransitionError(`Položce ${row.type_name} (${row.size}) chybí přiřazený kus.`);
      out.push({ itemId: row.id, bikeId: keep });
      continue;
    }
    const bikeId = Number(raw_);
    if (used.has(bikeId)) throw new reservations.TransitionError('Jeden kus nelze přiřadit dvěma položkám.');
    const ok = row.bike_id === bikeId || candidateBikes(ctx, r, row).some((b) => b.id === bikeId);
    if (!ok) throw new reservations.TransitionError(`Kus č. ${bikeId} není volný pro položku ${row.type_name} (${row.size}) – kolize s jinou rezervací, jiná velikost nebo kus není k dispozici.`);
    used.add(bikeId);
    out.push({ itemId: row.id, bikeId });
  }
  return out;
}

function applyAssignments(ctx, r, assignments) {
  const upd = ctx.db.prepare('UPDATE reservation_items SET bike_id = ? WHERE id = ? AND reservation_id = ?');
  for (const a of assignments) upd.run(a.bikeId, a.itemId, r.id);
  audit(ctx, 'reservation.assign_bikes', { entity: 'reservation', entityId: r.id, meta: { items: assignments } });
}

async function kolaPost(ctx) {
  const r = reservationOr404(ctx);
  return tryAction(ctx, r, () => {
    if (!['awaiting_fee', 'confirmed'].includes(r.status)) throw new reservations.TransitionError('Kola lze přiřazovat jen u potvrzené rezervace před výdejem.');
    const { rows } = outbox.loadItems(ctx.db, r.id);
    const assignments = parseAssignments(ctx, r, rows, { requireAll: false });
    transaction(ctx.db, () => applyAssignments(ctx, r, assignments));
    flash(ctx, 'success', `Přiřazení kusů uloženo (${assignments.filter((a) => a.bikeId).length} z ${rows.length}).`);
    return back(ctx, r);
  });
}

function recordIdDoc(ctx, r, customerId, { type, number }) {
  const retention = Number(ctx.settings.idDocRetentionDays) > 0 ? Number(ctx.settings.idDocRetentionDays) : 30;
  const base = Math.max(Date.now(), new Date(r.to_at).getTime());
  const deleteAfter = new Date(base + retention * 86400000).toISOString();
  const now = nowIso();
  ctx.db.prepare('UPDATE customers SET id_doc_type = ?, id_doc_number_enc = ?, id_doc_consent_at = ?, id_doc_delete_after = ? WHERE id = ? AND anonymized_at IS NULL').run(type, ctx.app.fieldCrypto.enc(number), now, deleteAfter, customerId);
  audit(ctx, 'customer.id_doc_recorded', { entity: 'customer', entityId: customerId, meta: { reservationId: r.id, type, deleteAfter } });
  return deleteAfter;
}

async function dokladPost(ctx) {
  const r = reservationOr404(ctx);
  return tryAction(ctx, r, () => {
    if (!r.customer_id) throw new reservations.TransitionError('Rezervace nemá zákazníka.');
    const type = s.ID_DOC_TYPES[str(ctx.body.typ)];
    const number = str(ctx.body.cislo).replace(/\s+/g, '').toUpperCase();
    if (!type) throw new reservations.TransitionError('Vyberte typ dokladu.');
    if (!/^[A-Z0-9]{4,20}$/.test(number)) throw new reservations.TransitionError('Číslo dokladu musí mít 4–20 písmen a číslic.');
    if (!checked(ctx.body.souhlas)) throw new reservations.TransitionError('Potvrďte, že zákazník doklad předložil a souhlasí se zápisem.');
    const deleteAfter = recordIdDoc(ctx, r, r.customer_id, { type, number });
    flash(ctx, 'success', `Doklad (${type}) zapsán; číslo se automaticky smaže po ${format.date(deleteAfter)}.`);
    return back(ctx, r);
  });
}

/** Zapíše kauci hotově / terminálem (bez brány): řádek payments authorized. */
async function recordManualHold(ctx, r, { method, amount }) {
  const mods = modules();
  if (mods.provider) {
    const res = await mods.provider.createPayment({ db: ctx.db, reservation: r, purpose: 'deposit_hold', method, amountMinor: amount, capture: 'manual', tenant: ctx.tenant, settings: ctx.settings, ctx, userId: ctx.user.id });
    return res && res.payment ? res.payment : activeHold(ctx.db, r);
  }
  const pay = reservations.recordPayment(ctx.db, { reservationId: r.id, purpose: 'deposit_hold', method, provider: 'manual', amountMinor: amount, capturedMinor: 0, status: 'authorized', idempotencyKey: `manual:${r.id}:deposit:${Date.now()}`, vs: r.number });
  audit(ctx, 'payment.create', { entity: 'reservation', entityId: r.id, meta: { paymentId: pay.id, purpose: 'deposit_hold', method, amountMinor: amount, provider: 'manual' } });
  return pay;
}

async function kaucePost(ctx) {
  const r = reservationOr404(ctx);
  return tryAction(ctx, r, async () => {
    if (!['confirmed', 'checked_out'].includes(r.status)) throw new reservations.TransitionError('Kauci lze zapsat jen u potvrzené nebo vydané rezervace.');
    if (activeHold(ctx.db, r)) throw new reservations.TransitionError('Kauce už je složena.');
    const method = str(ctx.body.metoda);
    const amount = parseKc(ctx.body.castka) ?? Number(r.deposit_minor);
    if (!(amount > 0)) throw new reservations.TransitionError('Výše kauce musí být kladná.');
    if (method === 'card') {
      const mods = modules();
      if (!mods.provider) {
        flash(ctx, 'warning', 'Modul plateb zatím není k dispozici – preautorizaci kartou nelze založit. Zapište kauci hotově nebo terminálem.');
        return back(ctx, r);
      }
      const res = await mods.provider.createPayment({ db: ctx.db, reservation: r, purpose: 'deposit_hold', method: 'card', amountMinor: amount, capture: 'manual', returnUrl: `${baseUrlOf(ctx)}/admin/rezervace/${r.id}?kauce=1`, tenant: ctx.tenant, settings: ctx.settings, ctx, userId: ctx.user.id });
      if (res && res.redirectUrl) {
        flash(ctx, 'info', html`Preautorizace kauce ${format.money(amount)} založena – dokončete ji v simulační bráně: <a href="${res.redirectUrl}">otevřít bránu</a>.`);
        return ctx.redirect(res.redirectUrl.startsWith('/') ? res.redirectUrl : new URL(res.redirectUrl).pathname + new URL(res.redirectUrl).search);
      }
      throw new reservations.TransitionError('Bránu se nepodařilo založit.');
    }
    if (!['cash', 'terminal'].includes(method)) throw new reservations.TransitionError('Neznámá forma kauce.');
    const pay = await recordManualHold(ctx, r, { method, amount });
    audit(ctx, 'reservation.deposit_recorded', { entity: 'reservation', entityId: r.id, meta: { paymentId: pay ? pay.id : null, method, amountMinor: amount } });
    flash(ctx, 'success', `Kauce ${format.money(amount)} (${s.METHOD_LABELS[method]}) zapsána; při výdeji se potvrdí ve smlouvě.`);
    return back(ctx, r);
  });
}

/** Zapíše doplatek hotově / terminálem jako platbu paid; do ledgeru a paid_minor ho dostane přechod check_out / close. */
function recordManualBalance(ctx, r, { method, amount }) {
  const pay = reservations.recordPayment(ctx.db, { reservationId: r.id, purpose: 'balance', method, provider: 'manual', amountMinor: amount, status: 'paid', idempotencyKey: `manual:${r.id}:balance:${Date.now()}`, vs: r.number });
  audit(ctx, 'reservation.balance_recorded', { entity: 'reservation', entityId: r.id, meta: { paymentId: pay.id, method, amountMinor: amount } });
  return pay;
}

async function doplatekPost(ctx) {
  const r = reservationOr404(ctx);
  return tryAction(ctx, r, async () => {
    if (!['confirmed', 'checked_out', 'returned'].includes(r.status)) throw new reservations.TransitionError('Doplatek lze zapsat jen u aktivní rezervace.');
    const method = str(ctx.body.metoda);
    const amount = parseKc(ctx.body.castka);
    if (!(amount > 0)) throw new reservations.TransitionError('Částka doplatku musí být kladná.');
    if (method === 'cash' || method === 'terminal') {
      recordManualBalance(ctx, r, { method, amount });
      flash(ctx, 'success', `Doplatek ${format.money(amount)} (${s.METHOD_LABELS[method]}) zapsán – do vyúčtování se promítne při výdeji / uzavření.`);
      return back(ctx, r);
    }
    const mods = modules();
    if (!mods.provider) {
      flash(ctx, 'warning', 'Modul plateb zatím není k dispozici – doplatek kartou nebo převodem nelze založit.');
      return back(ctx, r);
    }
    if (method === 'card') {
      const res = await mods.provider.createPayment({ db: ctx.db, reservation: r, purpose: 'balance', method: 'card', amountMinor: amount, capture: 'auto', returnUrl: `${baseUrlOf(ctx)}/admin/rezervace/${r.id}`, tenant: ctx.tenant, settings: ctx.settings, ctx, userId: ctx.user.id });
      if (res && res.redirectUrl) return ctx.redirect(res.redirectUrl.startsWith('/') ? res.redirectUrl : new URL(res.redirectUrl).pathname + new URL(res.redirectUrl).search);
      throw new reservations.TransitionError('Bránu se nepodařilo založit.');
    }
    if (method === 'bank_transfer') {
      const res = await mods.provider.createPayment({ db: ctx.db, reservation: r, purpose: 'balance', method: 'bank_transfer', amountMinor: amount, capture: 'auto', tenant: ctx.tenant, settings: ctx.settings, ctx, userId: ctx.user.id });
      flash(ctx, 'info', html`Platba převodem založena: ${format.money(amount)}, VS <strong>${res.vs || r.number}</strong>, IBAN <span class="mono">${res.iban || ''}</span>. QR kód je v seznamu plateb; příchozí převod se spáruje automaticky.`);
      return back(ctx, r, '#platby');
    }
    throw new reservations.TransitionError('Neznámá forma doplatku.');
  });
}

function operatorOf(ctx) {
  return { id: ctx.user.id, name: ctx.user.name };
}

/** Smlouva / protokol: přes domain/documents, bez něj přes pravni.renderLegal + vlastní zápis do documents. */
function issueLegalDoc(ctx, r, kind, { customer, bikes, extra = {}, now }) {
  const mods = modules();
  if (mods.documents) {
    return mods.documents.issueContract(ctx.db, { reservation: r, kind, tenant: ctx.tenant, settings: ctx.settings, fieldCrypto: ctx.app.fieldCrypto, customer: customer && !customer.anonymized ? { name: customer.name, email: customer.email, phone: customer.phone, address: customer.address, idDocType: customer.idDocType, idDocNumberMasked: customer.idDocMasked } : null, operator: operatorOf(ctx), bikes, legal: extra, now });
  }
  const pravni = require('./pravni');
  const params = { ...pravni.legalParams(ctx.tenant, ctx.settings), REZERVACE_CISLO: r.number, REZERVACE_DATUM: format.dateTime(r.created_at), NAJEM_OD: format.dateTime(r.from_at), NAJEM_DO: format.dateTime(r.to_at), CENA_CELKEM: format.money(r.total_minor), KAUCE_CELKEM: format.money(r.deposit_minor), OBSLUHA_JMENO: ctx.user.name, VRACENI_OBSLUHA_JMENO: ctx.user.name, PREDANI_CAS: format.dateTime(now), VRACENI_CAS: format.dateTime(now), ...extra };
  if (customer && !customer.anonymized) Object.assign(params, { NAJEMCE_JMENO: customer.name, NAJEMCE_EMAIL: customer.email, NAJEMCE_TELEFON: customer.phone || '…………', NAJEMCE_DOKLAD_TYP: customer.idDocType || '…………', NAJEMCE_DOKLAD_CISLO_TISK: customer.idDocMasked || '…………' });
  const assigned = (bikes || []).filter((b) => b.bikeId).map((b) => ctx.db.prepare('SELECT b.inventory_code, b.size, t.name FROM bikes b JOIN bike_types t ON t.id = b.bike_type_id WHERE b.id = ?').get(b.bikeId)).filter(Boolean);
  if (assigned.length) Object.assign(params, { KOLO_TYP: assigned.map((b) => b.name).join('; '), KOLO_INVENTARNI_KOD: assigned.map((b) => b.inventory_code).join('; '), KOLO_VELIKOST: assigned.map((b) => b.size).join('; ') });
  const opts = kind === 'contract' ? { omitHeadings: [/^ČÁST D/] } : kind === 'handover' ? { only: [/^ČÁST B/, /^B\.\d/] } : { only: [/^ČÁST C/, /^C\.\d/] };
  const doc = pravni.renderLegal('smlouva-o-najmu-a-predavaci-protokol', params, opts);
  return transaction(ctx.db, () => {
    const prefix = DOC_PREFIX[kind];
    const year = new Date(now).getFullYear();
    const last = ctx.db.prepare('SELECT number FROM documents WHERE number LIKE ? ORDER BY number DESC LIMIT 1').get(`${prefix}-${year}-%`);
    const seq = last ? Number(String(last.number).slice(prefix.length + 6)) + 1 : 1;
    const number = `${prefix}-${year}-${String(seq).padStart(6, '0')}`;
    const htmlStr = html`<article class="doc doc--${kind}" data-number="${number}"><header class="doc__head"><p class="doc__kind">${s.DOC_LABELS[kind]}</p><h1 class="doc__title">č. ${number}</h1><p class="doc__subtitle">Rezervace č. ${r.number}</p></header><section class="doc__body doc__legal">${raw(doc.html)}</section></article>`.toString();
    const ins = ctx.db.prepare('INSERT INTO documents(reservation_id, type, number, issued_at, html, data) VALUES (?, ?, ?, ?, ?, ?)').run(r.id, kind, number, now, htmlStr, JSON.stringify({ reservationNumber: r.number, missing: doc.missing, fallback: 'pravni.renderLegal' }));
    return { id: Number(ins.lastInsertRowid), number, type: kind, html: htmlStr, issuedAt: now };
  });
}

/** Doplní chybějící doklady k platbám (modul dokladů), tiše. */
function syncDocuments(ctx, reservationId) {
  const mods = modules();
  if (!mods.documents || typeof mods.documents.syncReservation !== 'function') return [];
  try {
    return mods.documents.syncReservation(ctx.db, reservationId, { tenant: ctx.tenant, settings: ctx.settings, fieldCrypto: ctx.app.fieldCrypto, now: nowIso(), log: ctx.log });
  } catch (e) {
    ctx.log.warn('Doplnění dokladů selhalo', { reservationId, error: e.message });
    return [];
  }
}

async function vydatPost(ctx) {
  const r = reservationOr404(ctx);
  return tryAction(ctx, r, async () => {
    if (r.status !== 'confirmed') throw new reservations.TransitionError(`Vydat lze jen potvrzenou rezervaci (nyní „${reservations.STATUS_LABELS[r.status]}“).`);
    if (!checked(ctx.body.potvrzeni)) throw new reservations.TransitionError('Potvrďte, že zákazník předložil doklad, převzal kola a podepsal protokol.');
    const customer = loadCustomer(ctx, r.customer_id);
    if (!customer || customer.anonymized || !customer.idDocType || !customer.idDocNumber || !customer.idDocConsentAt) throw new reservations.TransitionError('Před výdejem je nutné zapsat typ a číslo dokladu totožnosti (podmínka nájmu).');
    const { rows } = outbox.loadItems(ctx.db, r.id);
    const assignments = parseAssignments(ctx, r, rows, { requireAll: true });
    let hold = activeHold(ctx.db, r);
    const now = nowIso();
    let balancePay = null;
    const result = await (async () => {
      if (!hold) {
        const method = str(ctx.body.kauce_metoda);
        const amount = parseKc(ctx.body.kauce_castka) ?? Number(r.deposit_minor);
        if (!['cash', 'terminal'].includes(method)) throw new reservations.TransitionError('Kauce není složena – zvolte hotově nebo terminál, nebo nejdřív proveďte preautorizaci kartou.');
        if (!(amount > 0)) throw new reservations.TransitionError('Výše kauce musí být kladná.');
        hold = await recordManualHold(ctx, r, { method, amount });
      }
      const dMethod = str(ctx.body.doplatek_metoda);
      const dAmount = parseKc(ctx.body.doplatek_castka);
      if (['cash', 'terminal'].includes(dMethod) && dAmount > 0) balancePay = recordManualBalance(ctx, r, { method: dMethod, amount: dAmount });
      return transaction(ctx.db, () => {
        applyAssignments(ctx, r, assignments);
        const bal = unledgeredBalance(ctx.db, r);
        const res = reservations.transition(ctx.db, r.id, 'check_out', {
          items: assignments,
          depositMinor: hold ? Number(hold.amount_minor) : 0,
          depositMethod: hold ? hold.method : null,
          paymentId: hold ? hold.id : null,
          balancePaidMinor: bal.sumMinor,
          balancePaymentId: bal.rows[0] ? bal.rows[0].id : null,
          balanceMethod: bal.rows.length ? bal.rows.map((p) => s.METHOD_LABELS[p.method] || p.method).join(', ') : null,
          note: str(ctx.body.poznamka) ? `Výdej: ${str(ctx.body.poznamka)}` : null,
          userId: ctx.user.id,
          ipHash: ctx.ipHash,
          settings: ctx.settings,
          mail: mailDeps(ctx),
          now,
        });
        ctx.db.prepare('INSERT INTO handovers(reservation_id, type, at, by_user_id, condition, damage_minor, note) VALUES (?, ?, ?, ?, ?, 0, ?)').run(r.id, 'pickup', now, ctx.user.id, JSON.stringify({ bikes: assignments.map((a) => a.bikeId), deposit: hold ? { paymentId: hold.id, method: hold.method, amountMinor: Number(hold.amount_minor) } : null }), str(ctx.body.poznamka) || null);
        return res;
      });
    })();
    let contract = null;
    try {
      contract = issueLegalDoc(ctx, result.reservation, 'contract', { customer, bikes: assignments, now });
      audit(ctx, 'document.issue', { entity: 'reservation', entityId: r.id, meta: { type: 'contract', number: contract.number } });
    } catch (e) {
      ctx.log.warn('Smlouvu se nepodařilo vystavit', { reservationId: r.id, error: e.message });
    }
    syncDocuments(ctx, r.id);
    ctx.log.info('Rezervace vydána', { reservationId: r.id, bikes: assignments.length, balancePaymentId: balancePay ? balancePay.id : null });
    flash(ctx, 'success', contract ? html`Kola vydána. Smlouva a předávací protokol č. <a href="/admin/doklady/${encodeURIComponent(contract.number)}" target="_blank" rel="noopener">${contract.number}</a> – vytiskněte a nechte podepsat.` : 'Kola vydána (smlouvu se nepodařilo vystavit – zkontrolujte log).');
    return back(ctx, r);
  });
}

async function vratitPost(ctx) {
  const r = reservationOr404(ctx);
  return tryAction(ctx, r, () => {
    if (r.status !== 'checked_out') throw new reservations.TransitionError('Vrátit lze jen vydanou rezervaci.');
    const state = str(ctx.body.stav) || 'ok';
    const damage = parseKc(ctx.body.poskozeni) || 0;
    const note = str(ctx.body.poznamka);
    const stateLabel = { ok: 'v pořádku', poskozeno: 'poškozeno', spinave: 'znečištěno', chybi: 'chybí příslušenství' }[state] || state;
    const now = nowIso();
    const { rows } = outbox.loadItems(ctx.db, r.id);
    const res = transaction(ctx.db, () => {
      const out = reservations.transition(ctx.db, r.id, 'return', { damageMinor: damage, note: [`Vrácení: ${stateLabel}`, note].filter(Boolean).join(' – '), userId: ctx.user.id, ipHash: ctx.ipHash, settings: ctx.settings, mail: mailDeps(ctx), now });
      ctx.db.prepare('INSERT INTO handovers(reservation_id, type, at, by_user_id, condition, damage_minor, note) VALUES (?, ?, ?, ?, ?, ?, ?)').run(r.id, 'return', now, ctx.user.id, JSON.stringify({ state, bikes: rows.map((x) => x.bike_id).filter(Boolean) }), damage, note || null);
      if (checked(ctx.body.servis)) {
        const ids = rows.map((x) => x.bike_id).filter(Boolean);
        for (const id of ids) ctx.db.prepare("UPDATE bikes SET status = 'maintenance', note = COALESCE(note, '') || ? WHERE id = ?").run(`\nServis po rezervaci ${r.number} (${format.date(now)})`, id);
        if (ids.length) audit(ctx, 'bike.maintenance', { entity: 'reservation', entityId: r.id, meta: { bikeIds: ids } });
      }
      return out;
    });
    try {
      const customer = loadCustomer(ctx, r.customer_id);
      const doc = issueLegalDoc(ctx, res.reservation, 'return_protocol', { customer, bikes: rows.map((x) => ({ itemId: x.id, bikeId: x.bike_id })), extra: { KOLO_VRACENI_STAV: stateLabel, KOLO_VRACENI_POSKOZENI: damage > 0 ? note || 'poškození' : 'bez poškození', SKODA_POPIS: damage > 0 ? note || 'poškození' : '…………', SKODA_CASTKA: format.money(damage), VYUCTOVANI_CELKEM: format.money(damage) }, now });
      audit(ctx, 'document.issue', { entity: 'reservation', entityId: r.id, meta: { type: 'return_protocol', number: doc.number } });
    } catch (e) {
      ctx.log.warn('Protokol o vrácení se nepodařilo vystavit', { reservationId: r.id, error: e.message });
    }
    flash(ctx, 'success', `Vrácení zapsáno (${stateLabel}${damage ? `, poškození ${format.money(damage)}` : ''}). Nyní rezervaci uzavřete a vypořádejte kauci.`);
    return back(ctx, r);
  });
}

async function uzavritPost(ctx) {
  const r = reservationOr404(ctx);
  return tryAction(ctx, r, async () => {
    if (r.status !== 'returned') throw new reservations.TransitionError('Uzavřít lze jen vrácenou rezervaci.');
    const hold = activeHold(ctx.db, r);
    const maxCapture = hold ? Number(hold.amount_minor) : Number(r.deposit_minor);
    const action = str(ctx.body.kauce_akce) === 'strhnout' ? 'strhnout' : 'uvolnit';
    let captured = action === 'strhnout' ? parseKc(ctx.body.strhnout_castka) ?? 0 : 0;
    if (captured > maxCapture) throw new reservations.TransitionError(`Strhnout lze nejvýše ${format.money(maxCapture)}.`);
    if (action === 'strhnout' && !(captured > 0)) throw new reservations.TransitionError('Zadejte částku ke stržení, nebo zvolte uvolnění kauce.');
    const dMethod = str(ctx.body.doplatek_metoda);
    const dAmount = ['cash', 'terminal'].includes(dMethod) ? (parseKc(ctx.body.doplatek_castka) ?? 0) : 0;
    // Ochrana před dvojím inkasem škody (nález QA): dlužná částka (nájemné + škoda − zaplaceno − doplatky zapsané,
    // ale ještě nezaúčtované) se smí uhradit stržením z kauce a doplatkem jen dohromady nejvýše jednou.
    const outstanding = Math.max(0, balanceOf(ctx.db, r, reservations.loadDetail(ctx.db, r).ledger).dueMinor - unledgeredBalance(ctx.db, r).sumMinor);
    if (captured + dAmount > outstanding) {
      const parts = [captured > 0 ? `stržení z kauce ${format.money(captured)}` : null, dAmount > 0 ? `doplatek ${format.money(dAmount)} (${s.METHOD_LABELS[dMethod]})` : null].filter(Boolean);
      const fix = outstanding === 0 ? 'Vše je už uhrazeno – kauci uvolněte a doplatek nechte „Neuhrazen“.' : dAmount > 0 ? `Škodu zapište jen jednou: buď ji strhněte z kauce, nebo ji zákazník doplatí. Snižte doplatek na ${format.money(Math.max(0, outstanding - captured))}, nebo zvolte „Neuhrazen“.` : `Strhnout lze nejvýše ${format.money(outstanding)}.`;
      throw new ActionInputError(`Vypořádání by vedlo k přeplatku: zbývá uhradit ${format.money(outstanding)}, ale ${parts.join(' a ')} dávají dohromady ${format.money(captured + dAmount)}. ${fix}`);
    }
    if (dAmount > 0) recordManualBalance(ctx, r, { method: dMethod, amount: dAmount });
    const now = nowIso();
    const mods = modules();
    if (hold) {
      if (mods.provider) {
        if (captured > 0) mods.provider.capture({ db: ctx.db, payment: hold, amountMinor: captured, now, userId: ctx.user.id, ipHash: ctx.ipHash, log: ctx.log });
        else mods.provider.cancelHold({ db: ctx.db, payment: hold, now, userId: ctx.user.id, ipHash: ctx.ipHash, log: ctx.log, reason: 'close' });
      } else {
        ctx.db.prepare('UPDATE payments SET status = ?, captured_minor = ?, updated_at = ? WHERE id = ?').run(captured === 0 ? 'released' : captured >= maxCapture ? 'captured' : 'partially_captured', captured, now, hold.id);
        audit(ctx, captured > 0 ? 'payment.capture' : 'payment.release', { entity: 'reservation', entityId: r.id, meta: { paymentId: hold.id, capturedMinor: captured } });
      }
    }
    const res = transaction(ctx.db, () => {
      const bal = unledgeredBalance(ctx.db, r);
      return reservations.transition(ctx.db, r.id, 'close', {
        depositCapturedMinor: captured,
        paymentId: hold ? hold.id : null,
        balancePaidMinor: bal.sumMinor,
        balancePaymentId: bal.rows[0] ? bal.rows[0].id : null,
        balanceMethod: bal.rows.length ? bal.rows.map((p) => s.METHOD_LABELS[p.method] || p.method).join(', ') : null,
        note: str(ctx.body.poznamka) ? `Uzavření: ${str(ctx.body.poznamka)}` : captured > 0 ? `Z kauce strženo ${format.money(captured)}` : null,
        userId: ctx.user.id,
        ipHash: ctx.ipHash,
        settings: ctx.settings,
        mail: mailDeps(ctx),
        now,
      });
    });
    let finalDoc = null;
    if (mods.documents && typeof mods.documents.issueFinal === 'function') {
      try {
        syncDocuments(ctx, r.id);
        finalDoc = mods.documents.issueFinal(ctx.db, { reservation: res.reservation, tenant: ctx.tenant, settings: ctx.settings, fieldCrypto: ctx.app.fieldCrypto, now });
        audit(ctx, 'document.issue', { entity: 'reservation', entityId: r.id, meta: { type: 'final_doc', number: finalDoc.number } });
      } catch (e) {
        ctx.log.warn('Konečný doklad se nepodařilo vystavit', { reservationId: r.id, error: e.message });
      }
    }
    flash(ctx, 'success', html`Rezervace uzavřena – kauce ${captured > 0 ? html`stržena ${format.money(captured)}, zbytek uvolněn` : 'uvolněna'}.${finalDoc ? html` Konečný doklad č. <a href="/admin/doklady/${encodeURIComponent(finalDoc.number)}" target="_blank" rel="noopener">${finalDoc.number}</a>.` : mods.documents ? '' : ' (Modul dokladů není k dispozici – konečný doklad se nevystavil.)'}`);
    return back(ctx, r);
  });
}

async function stornoPost(ctx) {
  const r = reservationOr404(ctx);
  return tryAction(ctx, r, () => {
    const reason = str(ctx.body.duvod);
    if (reason.length < 3) throw new reservations.TransitionError('Uveďte důvod storna (alespoň 3 znaky).');
    const res = reservations.transition(ctx.db, r.id, 'cancel_by_operator', { note: `Storno půjčovnou: ${reason}`, userId: ctx.user.id, ipHash: ctx.ipHash, settings: ctx.settings, mail: mailDeps(ctx) });
    const q = res.cancellation || cancellation.operatorQuote({ reservation: r });
    flash(ctx, 'success', `Rezervace stornována. ${cancellation.describe(q)}`);
    return back(ctx, r);
  });
}

async function noShowPost(ctx) {
  const r = reservationOr404(ctx);
  return tryAction(ctx, r, () => {
    reservations.transition(ctx.db, r.id, 'no_show', { userId: ctx.user.id, ipHash: ctx.ipHash, settings: ctx.settings, mail: mailDeps(ctx) });
    flash(ctx, 'success', 'Rezervace označena jako nevyzvednutá – poplatek propadá.');
    return back(ctx, r);
  });
}

// ---------------------------------------------------------------------------------------------------------
// Doklady (tisk)

async function dokladGet(ctx) {
  const number = str(ctx.params.number).replace(/\.html$/, '');
  const doc = ctx.db.prepare('SELECT * FROM documents WHERE number = ?').get(number);
  if (!doc) throw new HttpError(404, 'Doklad nebyl nalezen.');
  audit(ctx, 'document.view', { entity: 'reservation', entityId: doc.reservation_id, meta: { number: doc.number, type: doc.type } });
  const mods = modules();
  const title = `${s.DOC_LABELS[doc.type] || doc.type} ${doc.number}`;
  if (mods.documents && typeof mods.documents.wrapPrint === 'function') return ctx.html(mods.documents.wrapPrint(doc.html, { title }));
  const page = `<!doctype html>\n${html`<html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><link rel="stylesheet" href="/base.css"><link rel="stylesheet" href="/css/pravni.css"><link rel="stylesheet" href="/css/admin.css"></head><body class="doc-print"><main class="container legal-doc">${raw(doc.html)}</main></body></html>`}`;
  return ctx.html(page);
}

// ---------------------------------------------------------------------------------------------------------
// Kalendář

const CAL_LENGTHS = [7, 14, 21, 28];

async function kalendarGet(ctx) {
  const today = availability.utcToLocal(new Date()).date;
  const start = /^\d{4}-\d{2}-\d{2}$/.test(str(ctx.query.od)) ? str(ctx.query.od) : today;
  const length = CAL_LENGTHS.includes(intOr(ctx.query.dny, 14)) ? intOr(ctx.query.dny, 14) : 14;
  const days = [];
  for (let i = 0; i < length; i++) days.push(availability.addDays(start, i));
  const startIso = availability.localToUtc(start, '00:00').toISOString();
  const endIso = availability.localToUtc(availability.addDays(start, length), '00:00').toISOString();
  const states = ['awaiting_fee', 'confirmed', 'checked_out', 'returned'];
  const rows = ctx.db
    .prepare(
      `SELECT i.id AS item_id, i.bike_type_id, i.size, i.bike_id, r.id AS reservation_id, r.number, r.status, r.from_at, r.to_at
       FROM reservation_items i JOIN reservations r ON r.id = i.reservation_id
       WHERE r.status IN (${states.map(() => '?').join(',')}) AND r.from_at < ? AND r.to_at > ? ORDER BY r.from_at`
    )
    .all(...states, endIso, startIso);
  const utcDay = (dateStr) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const startDay = utcDay(start);
  const dayIndex = (iso) => Math.round((utcDay(availability.utcToLocal(iso).date) - startDay) / 86400000);
  const mkBar = (x, label) => {
    const from = dayIndex(x.from_at);
    const to = dayIndex(x.to_at);
    return { fromIndex: Math.max(0, from), toIndex: Math.min(length - 1, to), cutStart: from < 0, cutEnd: to > length - 1, status: x.status, label, title: `${x.number} · ${reservations.STATUS_LABELS[x.status]} · ${format.dateTime(x.from_at)} – ${format.dateTime(x.to_at)}`, href: `/admin/rezervace/${x.reservation_id}` };
  };
  const types = ctx.db.prepare('SELECT * FROM bike_types WHERE active = 1 ORDER BY sort, name').all();
  const bikes = ctx.db.prepare("SELECT * FROM bikes WHERE status != 'retired' ORDER BY inventory_code").all();
  const groups = types.map((type) => {
    const mine = rows.filter((x) => x.bike_type_id === type.id);
    const perReservation = new Map();
    for (const x of mine) {
      const key = x.reservation_id;
      if (!perReservation.has(key)) perReservation.set(key, { ...x, qty: 0 });
      perReservation.get(key).qty += 1;
    }
    const bars = [...perReservation.values()].map((x) => mkBar(x, `${x.number} · ${x.qty}×`));
    const typeBikes = bikes.filter((b) => b.bike_type_id === type.id).map((bike) => ({ bike, bars: mine.filter((x) => x.bike_id === bike.id).map((x) => mkBar(x, x.number)) }));
    const unassigned = mine.filter((x) => !x.bike_id).map((x) => mkBar(x, `${x.number} (${x.size})`));
    return { type, bars, bikes: typeBikes, unassigned };
  });
  render(ctx, pages.kalendar.kalendar({ start, days, groups, today, lengths: CAL_LENGTHS, length }), { title: 'Kalendář obsazenosti', wide: true, lead: `${format.date(days[0])} – ${format.date(days[days.length - 1])}` });
}

// ---------------------------------------------------------------------------------------------------------
// Kola

function typeRow(row) {
  return row ? { ...row, sizes: parseJson(row.sizes, []), photos: parseJson(row.photos, []), specs: parseJson(row.specs, {}) } : null;
}

function listTypes(db) {
  return db.prepare('SELECT * FROM bike_types ORDER BY sort, name').all().map(typeRow);
}

function photosAvailable() {
  try {
    return fs
      .readdirSync(PHOTO_DIR)
      .filter((f) => /\.(jpe?g|png|webp|avif)$/i.test(f))
      .sort()
      .map((file) => ({ file, src: `/img/demo/kola/${file}` }));
  } catch {
    return [];
  }
}

async function kolaGet(ctx) {
  const types = listTypes(ctx.db).map((t) => ({ ...t, bikeCount: ctx.db.prepare("SELECT COUNT(*) AS n FROM bikes WHERE bike_type_id = ? AND status != 'retired'").get(t.id).n, fromPrice: pricing.fromPrice(ctx.db, t.id) }));
  const bikes = ctx.db.prepare('SELECT b.*, t.name AS type_name FROM bikes b JOIN bike_types t ON t.id = b.bike_type_id ORDER BY t.sort, t.name, b.inventory_code').all();
  render(ctx, pages.kola.list({ types, bikes, csrf: ctx.adminCsrfToken() }), { title: 'Kola' });
}

function slugify(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function parseTypeBody(ctx, existing) {
  const b = ctx.body;
  const errors = {};
  const name = str(b.name);
  if (name.length < 2) errors.name = 'Zadejte název.';
  let slug = slugify(str(b.slug)) || slugify(name);
  if (!slug) errors.slug = 'Neplatný slug.';
  const category = Object.hasOwn(s.CATEGORY_LABELS, str(b.category)) ? str(b.category) : 'trek';
  const sizes = str(b.sizes)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (!sizes.length) errors.sizes = 'Zadejte alespoň jednu velikost.';
  const deposit = parseKc(b.deposit);
  const fee = parseKc(b.fee);
  const value = parseKc(b.value);
  if (deposit === null) errors.deposit = 'Zadejte kauci.';
  if (fee === null) errors.fee = 'Zadejte poplatek.';
  if (value === null) errors.value = 'Zadejte hodnotu.';
  const specs = {};
  for (const line of str(b.specs).split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) specs[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const selected = new Set((Array.isArray(b.photos) ? b.photos : b.photos ? [b.photos] : []).map(String));
  const available = new Set(photosAvailable().map((p) => p.src));
  const keep = (existing ? existing.photos : []).filter((p) => selected.has(typeof p === 'string' ? p : p.src));
  const keptSrc = new Set(keep.map((p) => (typeof p === 'string' ? p : p.src)));
  const photos = [...keep, ...[...selected].filter((src) => available.has(src) && !keptSrc.has(src)).map((src) => ({ src, alt: name, author: 'viz public/img/demo/kola/ATTRIBUTION.md', license: 'CC BY' }))];
  const dup = ctx.db.prepare('SELECT id FROM bike_types WHERE slug = ? AND id != ?').get(slug, existing ? existing.id : -1);
  if (dup) errors.slug = 'Slug už používá jiný typ.';
  return { errors, values: { name, slug, category, sizes, deposit_minor: deposit, fee_minor: fee, value_minor: value, sort: intOr(b.sort, 0), description: str(b.description), specs, photos, active: checked(b.active) ? 1 : 0 } };
}

async function typFormGet(ctx) {
  const isNew = ctx.params.id === 'novy';
  const type = isNew ? null : typeRow(ctx.db.prepare('SELECT * FROM bike_types WHERE id = ?').get(Number(ctx.params.id)));
  if (!isNew && !type) throw new HttpError(404, 'Typ kola nebyl nalezen.');
  render(ctx, pages.kola.typeForm({ type, photosAvailable: photosAvailable(), csrf: ctx.adminCsrfToken() }), { title: type ? type.name : 'Nový typ kola', actions: html`<a class="btn btn--ghost btn--sm" href="/admin/kola">← Kola</a>` });
}

async function typPost(ctx) {
  const isNew = !ctx.params.id;
  const existing = isNew ? null : typeRow(ctx.db.prepare('SELECT * FROM bike_types WHERE id = ?').get(Number(ctx.params.id)));
  if (!isNew && !existing) throw new HttpError(404, 'Typ kola nebyl nalezen.');
  const { errors, values } = parseTypeBody(ctx, existing);
  if (Object.keys(errors).length) {
    return render(ctx, pages.kola.typeForm({ type: { ...(existing || {}), ...values }, photosAvailable: photosAvailable(), csrf: ctx.adminCsrfToken(), errors }), { title: existing ? existing.name : 'Nový typ kola', status: 422 });
  }
  const v = values;
  let id;
  if (existing) {
    ctx.db.prepare('UPDATE bike_types SET slug = ?, name = ?, category = ?, description = ?, photos = ?, sizes = ?, specs = ?, deposit_minor = ?, fee_minor = ?, value_minor = ?, active = ?, sort = ? WHERE id = ?').run(v.slug, v.name, v.category, v.description || null, JSON.stringify(v.photos), JSON.stringify(v.sizes), JSON.stringify(v.specs), v.deposit_minor, v.fee_minor, v.value_minor, v.active, v.sort, existing.id);
    id = existing.id;
  } else {
    id = Number(ctx.db.prepare('INSERT INTO bike_types(slug, name, category, description, photos, sizes, specs, deposit_minor, fee_minor, value_minor, active, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(v.slug, v.name, v.category, v.description || null, JSON.stringify(v.photos), JSON.stringify(v.sizes), JSON.stringify(v.specs), v.deposit_minor, v.fee_minor, v.value_minor, v.active, v.sort).lastInsertRowid);
  }
  audit(ctx, existing ? 'bike_type.update' : 'bike_type.create', { entity: 'bike_type', entityId: id, meta: { slug: v.slug, sizes: v.sizes, depositMinor: v.deposit_minor, feeMinor: v.fee_minor, active: v.active } });
  flash(ctx, 'success', `Typ „${v.name}“ uložen.${existing ? '' : ' Doplňte ceník a kusy.'}`);
  return ctx.redirect(existing ? `/admin/kola/typ/${id}` : `/admin/cenik#typ-${id}`);
}

async function kusFormGet(ctx) {
  const isNew = ctx.params.id === 'novy';
  const bike = isNew ? null : ctx.db.prepare('SELECT * FROM bikes WHERE id = ?').get(Number(ctx.params.id));
  if (!isNew && !bike) throw new HttpError(404, 'Kus nebyl nalezen.');
  const types = listTypes(ctx.db).filter((t) => t.active || (bike && bike.bike_type_id === t.id));
  render(ctx, pages.kola.bikeForm({ bike, types, csrf: ctx.adminCsrfToken(), preselectedType: intOr(ctx.query.typ, null), frameNo: bike ? dec(ctx, bike.frame_no_enc) : '' }), { title: bike ? `Kus ${bike.inventory_code}` : 'Nový kus', actions: html`<a class="btn btn--ghost btn--sm" href="/admin/kola">← Kola</a>` });
}

async function kusPost(ctx) {
  const isNew = !ctx.params.id;
  const existing = isNew ? null : ctx.db.prepare('SELECT * FROM bikes WHERE id = ?').get(Number(ctx.params.id));
  if (!isNew && !existing) throw new HttpError(404, 'Kus nebyl nalezen.');
  const b = ctx.body;
  const errors = {};
  const type = typeRow(ctx.db.prepare('SELECT * FROM bike_types WHERE id = ?').get(intOr(b.bike_type_id, -1)));
  if (!type) errors.bike_type_id = 'Vyberte typ.';
  const code = str(b.inventory_code).toUpperCase();
  if (!/^[A-Z0-9._-]{2,20}$/.test(code)) errors.inventory_code = 'Kód: 2–20 znaků (písmena, číslice, . _ -).';
  else if (ctx.db.prepare('SELECT id FROM bikes WHERE inventory_code = ? AND id != ?').get(code, existing ? existing.id : -1)) errors.inventory_code = 'Tento kód už má jiný kus.';
  const size = str(b.size);
  if (type && !type.sizes.includes(size)) errors.size = `Velikost musí být jedna z: ${type.sizes.join(', ')}.`;
  const status = Object.hasOwn(s.BIKE_STATUS, str(b.status)) ? str(b.status) : 'available';
  const frameNo = str(b.frame_no);
  if (Object.keys(errors).length) {
    const types = listTypes(ctx.db);
    return render(ctx, pages.kola.bikeForm({ bike: { ...(existing || {}), bike_type_id: type ? type.id : null, inventory_code: code, size, status, note: str(b.note) }, types, csrf: ctx.adminCsrfToken(), errors, frameNo }), { title: existing ? `Kus ${existing.inventory_code}` : 'Nový kus', status: 422 });
  }
  const frameEnc = frameNo ? ctx.app.fieldCrypto.enc(frameNo) : existing ? existing.frame_no_enc : null;
  let id;
  if (existing) {
    ctx.db.prepare('UPDATE bikes SET bike_type_id = ?, inventory_code = ?, size = ?, frame_no_enc = ?, status = ?, note = ? WHERE id = ?').run(type.id, code, size, frameEnc, status, str(b.note) || null, existing.id);
    id = existing.id;
  } else {
    id = Number(ctx.db.prepare('INSERT INTO bikes(bike_type_id, inventory_code, size, frame_no_enc, status, note) VALUES (?, ?, ?, ?, ?, ?)').run(type.id, code, size, frameEnc, status, str(b.note) || null).lastInsertRowid);
  }
  audit(ctx, existing ? 'bike.update' : 'bike.create', { entity: 'bike', entityId: id, meta: { inventoryCode: code, typeId: type.id, size, status } });
  flash(ctx, 'success', `Kus ${code} uložen.`);
  return ctx.redirect('/admin/kola');
}

async function kusStavPost(ctx) {
  const bike = ctx.db.prepare('SELECT * FROM bikes WHERE id = ?').get(Number(ctx.params.id));
  if (!bike) throw new HttpError(404, 'Kus nebyl nalezen.');
  const status = str(ctx.body.status);
  if (!Object.hasOwn(s.BIKE_STATUS, status)) throw new HttpError(400, 'Neznámý stav.');
  ctx.db.prepare('UPDATE bikes SET status = ? WHERE id = ?').run(status, bike.id);
  audit(ctx, 'bike.status', { entity: 'bike', entityId: bike.id, meta: { from: bike.status, to: status } });
  flash(ctx, 'success', `${bike.inventory_code}: ${s.BIKE_STATUS[status][0]}.`);
  return ctx.redirect('/admin/kola');
}

/** QR kód inventárního kódu (SVG, ECC M) – obsahem je URL karty kusu, aby sken otevřel administraci. */
function qrSvgFor(text) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text), 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize: 3, margin: 8, scalable: true }).replace('<svg ', '<svg class="qr-svg" shape-rendering="crispEdges" ');
}

async function stitkyGet(ctx) {
  const typ = intOr(ctx.query.typ, null);
  const kus = intOr(ctx.query.kus, null);
  const where = kus ? 'WHERE b.id = ?' : typ ? 'WHERE b.bike_type_id = ? AND b.status != \'retired\'' : "WHERE b.status != 'retired'";
  const args = kus ? [kus] : typ ? [typ] : [];
  const bikes = ctx.db.prepare(`SELECT b.*, t.name AS type_name FROM bikes b JOIN bike_types t ON t.id = b.bike_type_id ${where} ORDER BY t.sort, b.inventory_code`).all(...args);
  const base = baseUrlOf(ctx);
  const labels = bikes.map((bike) => ({ bike, typeName: bike.type_name, qrSvg: qrSvgFor(`${base}/admin/kola/kus/${bike.id}?kod=${encodeURIComponent(bike.inventory_code)}`) }));
  render(ctx, pages.kola.labels({ labels, title: ctx.tenant.name }), { title: 'QR štítky', lead: `${labels.length} štítků`, actions: html`<a class="btn btn--ghost btn--sm" href="/admin/kola">← Kola</a>`, wide: true });
}

// ---------------------------------------------------------------------------------------------------------
// Ceník

async function cenikGet(ctx) {
  const types = listTypes(ctx.db)
    .filter((t) => t.active)
    .map((type) => {
      const table = pricing.priceTable(ctx.db, type.id);
      // doplnit chybějící sezóny, aby šly ceny zadat
      for (const se of ctx.db.prepare('SELECT * FROM seasons ORDER BY date_from').all()) if (!table.some((g) => g.season && g.season.id === se.id)) table.push({ season: se, tiers: {}, hour: null, halfday: null });
      return { type, table };
    });
  const seasons = ctx.db.prepare('SELECT * FROM seasons ORDER BY date_from').all();
  const accessories = ctx.db.prepare('SELECT * FROM accessories ORDER BY active DESC, price_minor DESC, name').all();
  render(ctx, pages.cenik.cenik({ types, seasons, accessories, csrf: ctx.adminCsrfToken() }), { title: 'Ceník', lead: 'Pásma podle délky pronájmu, sezóny a příslušenství. Veřejný ceník: /cenik.', wide: true });
}

async function cenikTypPost(ctx) {
  const type = ctx.db.prepare('SELECT * FROM bike_types WHERE id = ?').get(Number(ctx.params.id));
  if (!type) throw new HttpError(404, 'Typ kola nebyl nalezen.');
  const seasons = new Set(ctx.db.prepare('SELECT id FROM seasons').all().map((x) => x.id));
  const rules = [];
  for (const [key, val] of Object.entries(ctx.body)) {
    const m = /^p_(\d+)_(day|hour|halfday)_(\d+)$/.exec(key);
    if (!m) continue;
    const seasonId = Number(m[1]) === 0 ? null : Number(m[1]);
    if (seasonId !== null && !seasons.has(seasonId)) continue;
    const minor = parseKc(val);
    if (minor === null) continue;
    rules.push({ seasonId, unit: m[2], fromQty: m[2] === 'day' ? Number(m[3]) : 1, minor });
  }
  if (!rules.some((r) => r.seasonId === null && r.unit === 'day' && r.fromQty === 1)) {
    flash(ctx, 'danger', 'Základní cena za 1 den (mimo sezónu) je povinná.');
    return ctx.redirect(`/admin/cenik#typ-${type.id}`);
  }
  transaction(ctx.db, () => {
    ctx.db.prepare('DELETE FROM price_rules WHERE bike_type_id = ?').run(type.id);
    const ins = ctx.db.prepare('INSERT INTO price_rules(bike_type_id, season_id, unit, from_qty, price_minor) VALUES (?, ?, ?, ?, ?)');
    for (const r of rules) ins.run(type.id, r.seasonId, r.unit, r.fromQty, r.minor);
  });
  audit(ctx, 'price_rules.update', { entity: 'bike_type', entityId: type.id, meta: { rules: rules.length } });
  flash(ctx, 'success', `Ceník typu „${type.name}“ uložen (${rules.length} pravidel).`);
  return ctx.redirect(`/admin/cenik#typ-${type.id}`);
}

async function sezonaPost(ctx) {
  const name = str(ctx.body.name);
  const from = str(ctx.body.date_from);
  const to = str(ctx.body.date_to);
  if (name.length < 2 || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) {
    flash(ctx, 'danger', 'Zadejte název a platný rozsah dat sezóny.');
    return ctx.redirect('/admin/cenik');
  }
  const id = Number(ctx.db.prepare('INSERT INTO seasons(name, date_from, date_to) VALUES (?, ?, ?)').run(name, from, to).lastInsertRowid);
  audit(ctx, 'season.create', { entity: 'season', entityId: id, meta: { name, from, to } });
  flash(ctx, 'success', `Sezóna „${name}“ přidána – doplňte sezónní ceny u typů.`);
  return ctx.redirect('/admin/cenik');
}

async function sezonaSmazatPost(ctx) {
  const se = ctx.db.prepare('SELECT * FROM seasons WHERE id = ?').get(Number(ctx.params.id));
  if (!se) throw new HttpError(404, 'Sezóna nebyla nalezena.');
  transaction(ctx.db, () => {
    ctx.db.prepare('DELETE FROM price_rules WHERE season_id = ?').run(se.id);
    ctx.db.prepare('DELETE FROM seasons WHERE id = ?').run(se.id);
  });
  audit(ctx, 'season.delete', { entity: 'season', entityId: se.id, meta: { name: se.name } });
  flash(ctx, 'success', `Sezóna „${se.name}“ smazána.`);
  return ctx.redirect('/admin/cenik');
}

async function prislusenstviPost(ctx) {
  const existing = ctx.params.id ? ctx.db.prepare('SELECT * FROM accessories WHERE id = ?').get(Number(ctx.params.id)) : null;
  if (ctx.params.id && !existing) throw new HttpError(404, 'Příslušenství nebylo nalezeno.');
  const name = str(ctx.body.name);
  const price = parseKc(ctx.body.price);
  const stock = intOr(ctx.body.stock, null);
  if (name.length < 2 || price === null || stock === null || stock < 0) {
    flash(ctx, 'danger', 'Zadejte název, cenu a počet kusů skladem.');
    return ctx.redirect('/admin/cenik');
  }
  if (existing) {
    ctx.db.prepare('UPDATE accessories SET name = ?, price_minor = ?, stock = ?, active = ? WHERE id = ?').run(name, price, stock, checked(ctx.body.active) ? 1 : 0, existing.id);
    audit(ctx, 'accessory.update', { entity: 'accessory', entityId: existing.id, meta: { name, priceMinor: price, stock, active: checked(ctx.body.active) } });
  } else {
    let slug = slugify(name);
    if (ctx.db.prepare('SELECT id FROM accessories WHERE slug = ?').get(slug)) slug = `${slug}-${Date.now().toString(36)}`;
    const id = Number(ctx.db.prepare('INSERT INTO accessories(slug, name, price_minor, stock, active) VALUES (?, ?, ?, ?, 1)').run(slug, name, price, stock).lastInsertRowid);
    audit(ctx, 'accessory.create', { entity: 'accessory', entityId: id, meta: { slug, priceMinor: price, stock } });
  }
  flash(ctx, 'success', `Příslušenství „${name}“ uloženo.`);
  return ctx.redirect('/admin/cenik');
}

// ---------------------------------------------------------------------------------------------------------
// Platby

async function platbyGet(ctx) {
  const q = ctx.query;
  const filters = { ucel: str(q.ucel), metoda: str(q.metoda), stav: str(q.stav), vs: str(q.vs).replace(/\D/g, '') };
  const where = [];
  const args = [];
  if (Object.hasOwn(s.PURPOSE_LABELS, filters.ucel)) where.push('p.purpose = ?'), args.push(filters.ucel);
  if (Object.hasOwn(s.METHOD_LABELS, filters.metoda)) where.push('p.method = ?'), args.push(filters.metoda);
  if (Object.hasOwn(s.PAYMENT_STATUS, filters.stav)) where.push('p.status = ?'), args.push(filters.stav);
  if (filters.vs) where.push('(p.vs LIKE ? OR r.number LIKE ?)'), args.push(`%${filters.vs}%`, `%${filters.vs}%`);
  const rows = ctx.db.prepare(`SELECT p.*, r.number, r.id AS id FROM payments p JOIN reservations r ON r.id = p.reservation_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.updated_at DESC, p.id DESC LIMIT 300`).all(...args);
  const sumPaid = rows.filter((p) => ['paid', 'captured', 'partially_captured'].includes(p.status) && p.purpose !== 'refund').reduce((a, p) => a + Number(p.purpose === 'deposit_hold' ? p.captured_minor : p.captured_minor || p.amount_minor), 0);
  const unmatched = ctx.db.prepare('SELECT * FROM bank_transactions WHERE matched_payment_id IS NULL AND amount_minor > 0 ORDER BY booked_at DESC, id DESC').all();
  const pendingTransfers = ctx.db.prepare("SELECT p.*, r.number FROM payments p JOIN reservations r ON r.id = p.reservation_id WHERE p.method = 'bank_transfer' AND p.purpose IN ('fee','balance') AND p.status IN ('pending','created') ORDER BY p.created_at DESC").all();
  const pendingRefunds = ctx.db.prepare("SELECT p.*, r.number, r.id AS id FROM payments p JOIN reservations r ON r.id = p.reservation_id WHERE p.purpose = 'refund' AND p.status = 'pending' ORDER BY p.created_at").all();
  render(ctx, pages.platby.platby({ rows, filters, unmatched, pendingTransfers, pendingRefunds, csrf: ctx.adminCsrfToken(), modules: { fio: !!modules().fio, provider: !!modules().provider }, sumPaid }), { title: 'Platby', wide: true });
}

function paymentDeps(ctx) {
  return { tenant: ctx.tenant, settings: ctx.settings, fieldCrypto: ctx.app.fieldCrypto, secret: ctx.app.secret, baseUrl: baseUrlOf(ctx), log: ctx.log, userId: ctx.user.id, ipHash: ctx.ipHash };
}

async function simulacePost(ctx) {
  const mods = modules();
  if (!mods.fio) {
    flash(ctx, 'warning', 'Modul plateb (fio-mock) zatím není k dispozici.');
    return ctx.redirect('/admin/platby');
  }
  const amount = parseKc(ctx.body.castka);
  const vs = str(ctx.body.vs).replace(/\D/g, '');
  if (!(amount > 0)) {
    flash(ctx, 'danger', 'Zadejte kladnou částku.');
    return ctx.redirect('/admin/platby');
  }
  try {
    const { tx, result } = mods.fio.simulateIncoming({ db: ctx.db, amountMinor: amount, vs: vs || null, msg: str(ctx.body.zprava) || (vs ? `Rezervace ${vs}` : null), counterAccount: '123456789/0100', counterName: 'Simulace (demo)', ...paymentDeps(ctx) });
    audit(ctx, 'bank.simulate_incoming', { entity: 'bank_transaction', entityId: tx.id, meta: { amountMinor: amount, vs: vs || null, outcome: result.outcome, reason: result.reason || null } });
    const text = { paid: `Platba ${format.money(amount)} (VS ${vs}) spárována a vypořádána.`, overpaid: `Platba ${format.money(amount)} spárována – přeplatek evidován jako kredit.`, partial: `Platba ${format.money(amount)} spárována jako částečná úhrada – zákazníkovi odešel QR na zbytek.`, unmatched: `Platba ${format.money(amount)} zařazena mezi nespárované (${result.reason || 'bez shody'}) – přiřaďte ji ručně.` }[result.outcome] || `Výsledek: ${result.outcome}.`;
    flash(ctx, result.outcome === 'unmatched' ? 'warning' : 'success', text);
  } catch (e) {
    ctx.log.warn('Simulace převodu selhala', { error: e.message });
    flash(ctx, 'danger', `Simulace selhala: ${e.message}`);
  }
  return ctx.redirect('/admin/platby');
}

async function sparovatPost(ctx) {
  const mods = modules();
  if (!mods.fio || typeof mods.fio.manualMatch !== 'function') {
    flash(ctx, 'warning', 'Ruční párování vyžaduje modul plateb (fio-mock).');
    return ctx.redirect('/admin/platby');
  }
  try {
    const res = mods.fio.manualMatch(ctx.db, str(ctx.body.tx), intOr(ctx.body.platba, -1), paymentDeps(ctx));
    flash(ctx, 'success', `Pohyb přiřazen (${res.outcome}).`);
  } catch (e) {
    flash(ctx, 'danger', `Přiřazení selhalo: ${e.message}`);
  }
  return ctx.redirect('/admin/platby');
}

async function vratkaPotvrditPost(ctx) {
  const p = ctx.db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(ctx.params.id));
  if (!p || p.purpose !== 'refund') throw new HttpError(404, 'Vratka nebyla nalezena.');
  const mods = modules();
  try {
    if (mods.provider && typeof mods.provider.confirmRefund === 'function') mods.provider.confirmRefund({ db: ctx.db, payment: p, ...paymentDeps(ctx) });
    else {
      if (p.status !== 'pending') throw new Error(`Vratku ve stavu „${p.status}“ nelze potvrdit.`);
      ctx.db.prepare("UPDATE payments SET status = 'refunded', updated_at = ? WHERE id = ?").run(nowIso(), p.id);
      audit(ctx, 'payment.refund_confirmed', { entity: 'reservation', entityId: p.reservation_id, meta: { refundId: p.id, amountMinor: Number(p.amount_minor) } });
    }
    flash(ctx, 'success', `Vratka ${format.money(p.amount_minor)} potvrzena jako odeslaná.`);
  } catch (e) {
    flash(ctx, 'danger', e.message);
  }
  return ctx.redirect('/admin/platby');
}

// ---------------------------------------------------------------------------------------------------------
// E-maily

async function emailyList(ctx) {
  const q = ctx.query;
  const filters = { typ: str(q.typ), stav: str(q.stav), q: str(q.q).replace(/\D/g, '') };
  const where = [];
  const args = [];
  if (filters.typ) where.push('type = ?'), args.push(filters.typ);
  if (filters.stav === 'fronta') where.push('sent_at IS NULL AND error IS NULL');
  else if (filters.stav === 'odeslano') where.push('sent_at IS NOT NULL');
  else if (filters.stav === 'chyba') where.push('error IS NOT NULL');
  if (filters.q) where.push("json_extract(payload, '$.number') LIKE ?"), args.push(`%${filters.q}%`);
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM outbox ${sql}`).get(...args).n;
  const pages_ = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(pages_, Math.max(1, intOr(q.strana, 1)));
  const rows = ctx.db.prepare(`SELECT id, type, subject, created_at, sent_at, attempts, error, json_extract(payload, '$.reservationId') AS reservationId, json_extract(payload, '$.number') AS number FROM outbox ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  const types = ctx.db.prepare('SELECT DISTINCT type FROM outbox ORDER BY type').all().map((x) => x.type);
  const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
  render(ctx, pages.emaily.list({ rows, filters, page, pages: pages_, total, types, href: `/admin/emaily${params.toString() ? `?${params}` : ''}` }), { title: 'E-maily' });
}

async function emailDetail(ctx) {
  const mail = ctx.db.prepare('SELECT * FROM outbox WHERE id = ?').get(Number(ctx.params.id));
  if (!mail) throw new HttpError(404, 'E-mail nebyl nalezen.');
  const payload = parseJson(mail.payload, {}) || {};
  delete payload.to_enc;
  render(ctx, pages.emaily.detail({ mail, payload }), { title: `E-mail #${mail.id}`, lead: mail.subject, actions: html`<a class="btn btn--ghost btn--sm" href="/admin/emaily">← Outbox</a>` });
}

// ---------------------------------------------------------------------------------------------------------
// Zákazníci

function customerRows(db, where, args) {
  return db.prepare(`SELECT c.id, c.created_at, c.id_doc_type, c.id_doc_delete_after, c.marketing_consent_at, c.anonymized_at, (SELECT COUNT(*) FROM reservations r WHERE r.customer_id = c.id) AS reservations FROM customers c ${where} ORDER BY c.id DESC LIMIT 50`).all(...args);
}

async function zakazniciList(ctx) {
  const email = normalizeEmail(ctx.query.email);
  let rows = [];
  if (email) {
    rows = customerRows(ctx.db, 'WHERE c.email_hmac = ?', [ctx.app.fieldCrypto.hmacEmail(email)]);
    audit(ctx, 'customer.search', { meta: { found: rows.length } });
  }
  const recent = customerRows(ctx.db, '', []).slice(0, 20);
  render(ctx, pages.zakaznici.list({ rows, email, recent, csrf: ctx.adminCsrfToken() }), { title: 'Zákazníci' });
}

function customerOr404(ctx) {
  const cst = loadCustomer(ctx, Number(ctx.params.id));
  if (!cst) throw new HttpError(404, 'Zákazník nebyl nalezen.');
  return cst;
}

async function zakaznikDetail(ctx) {
  const cst = customerOr404(ctx);
  if (!cst.anonymized) audit(ctx, 'customer.view', { entity: 'customer', entityId: cst.id, meta: { fields: ['name', 'email', 'phone', 'address', 'id_doc_masked'] } });
  const list = ctx.db.prepare('SELECT * FROM reservations WHERE customer_id = ? ORDER BY from_at DESC').all(cst.id);
  const active = list.filter((r) => ACTIVE_STATES.includes(r.status)).length;
  render(ctx, pages.zakaznici.detail({ customer: cst, reservations: list, csrf: ctx.adminCsrfToken(), activeReservations: active }), { title: `Zákazník #${cst.id}`, actions: html`<a class="btn btn--ghost btn--sm" href="/admin/zakaznici">← Zákazníci</a>` });
}

async function zakaznikExport(ctx) {
  const cst = customerOr404(ctx);
  if (cst.anonymized) throw new HttpError(404, 'Zákazník byl anonymizován.');
  audit(ctx, 'customer.export', { entity: 'customer', entityId: cst.id });
  const list = ctx.db.prepare('SELECT number, status, from_at, to_at, total_minor, fee_minor, paid_minor, deposit_minor, terms_version, consent_at, id_doc_ack_at, created_at FROM reservations WHERE customer_id = ? ORDER BY id').all(cst.id);
  ctx.res.setHeader('Content-Disposition', `attachment; filename="zakaznik-${cst.id}.json"`);
  ctx.json({ exportedAt: nowIso(), tenant: ctx.tenant.name, customer: { id: cst.id, name: cst.name, email: cst.email, phone: cst.phone || null, address: cst.address || null, idDocType: cst.idDocType, idDocNumber: cst.idDocNumber || null, idDocConsentAt: cst.idDocConsentAt, idDocDeleteAfter: cst.idDocDeleteAfter, marketingConsentAt: cst.marketingConsentAt, createdAt: cst.createdAt }, reservations: list });
}

async function zakaznikAnonymizovat(ctx) {
  const cst = customerOr404(ctx);
  if (cst.anonymized) return ctx.redirect(`/admin/zakaznici/${cst.id}`);
  const active = ctx.db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE customer_id = ? AND status IN (${ACTIVE_STATES.map(() => '?').join(',')})`).get(cst.id, ...ACTIVE_STATES).n;
  if (active > 0) {
    flash(ctx, 'danger', 'Zákazníka s aktivní rezervací nelze anonymizovat – nejdřív rezervace uzavřete nebo stornujte.');
    return ctx.redirect(`/admin/zakaznici/${cst.id}`);
  }
  const fc = ctx.app.fieldCrypto;
  const now = nowIso();
  transaction(ctx.db, () => {
    const hmac = ctx.db.prepare('SELECT email_hmac FROM customers WHERE id = ?').get(cst.id).email_hmac;
    ctx.db.prepare('UPDATE customers SET email_hmac = ?, email_enc = ?, name_enc = ?, phone_enc = NULL, address_enc = NULL, birth_date_enc = NULL, id_doc_type = NULL, id_doc_number_enc = NULL, id_doc_consent_at = NULL, id_doc_delete_after = NULL, marketing_consent_at = NULL, anonymized_at = ? WHERE id = ?').run(`anon:${cst.id}`, fc.enc('anonymizovano@invalid'), fc.enc('Anonymizovaný zákazník'), now, cst.id);
    ctx.db.prepare("UPDATE outbox SET to_hmac = NULL, payload = json_remove(payload, '$.to_enc') WHERE to_hmac = ?").run(hmac);
    audit(ctx, 'customer.anonymize', { entity: 'customer', entityId: cst.id });
  });
  ctx.log.info('Zákazník anonymizován', { customerId: cst.id });
  flash(ctx, 'success', 'Osobní údaje zákazníka byly anonymizovány.');
  return ctx.redirect(`/admin/zakaznici/${cst.id}`);
}

async function zakaznikDokladSmazat(ctx) {
  const cst = customerOr404(ctx);
  ctx.db.prepare('UPDATE customers SET id_doc_type = NULL, id_doc_number_enc = NULL, id_doc_delete_after = NULL WHERE id = ?').run(cst.id);
  audit(ctx, 'customer.id_doc_deleted', { entity: 'customer', entityId: cst.id, meta: { reason: 'manual' } });
  flash(ctx, 'success', 'Číslo dokladu totožnosti bylo smazáno.');
  return ctx.redirect(`/admin/zakaznici/${cst.id}`);
}

// ---------------------------------------------------------------------------------------------------------
// Obsah

async function obsahGet(ctx) {
  const texts = (ctx.settings && ctx.settings.texts) || {};
  const defaults = ctx.tenant.texts || {};
  let pois = [];
  try {
    const mapa = require('./mapa');
    const okoli = mapa.loadOkoli(ctx.tenant);
    const overrides = new Map(ctx.db.prepare('SELECT * FROM poi_overrides').all().map((o) => [String(o.poi_id), o]));
    pois = ((okoli && okoli.pois) || []).map((p, idx) => ({ ...p, idx, image: p.image && p.image.file ? { src: `/okoli/img/${encodeURIComponent(p.image.file)}` } : null, override: overrides.get(String(p.id)) || null }));
  } catch (e) {
    ctx.log.warn('Zajímavosti nelze načíst', { error: e.message });
  }
  render(ctx, pages.obsah.obsah({ texts, defaults, pois, csrf: ctx.adminCsrfToken() }), { title: 'Obsah' });
}

async function textyPost(ctx) {
  const texts = {};
  for (const [key] of pages.obsah.TEXT_FIELDS) {
    const v = str(ctx.body[key]);
    if (v) texts[key] = v.slice(0, 2000);
  }
  setSetting(ctx.db, 'texts', texts);
  audit(ctx, 'settings.update', { entity: 'settings', entityId: 'texts', meta: { keys: Object.keys(texts) } });
  flash(ctx, 'success', 'Texty uloženy.');
  return ctx.redirect('/admin/obsah');
}

async function poiPost(ctx) {
  const id = str(ctx.params.id);
  if (!/^Q\d{1,12}$/.test(id) && !/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new HttpError(400, 'Neplatné id zajímavosti.');
  if (checked(ctx.body.reset)) {
    ctx.db.prepare('DELETE FROM poi_overrides WHERE poi_id = ?').run(id);
    audit(ctx, 'poi.reset', { entity: 'poi', entityId: id });
    flash(ctx, 'success', `Úpravy zajímavosti ${id} zrušeny.`);
    return ctx.redirect('/admin/obsah');
  }
  const hidden = checked(ctx.body.hidden) ? 1 : 0;
  const sort = str(ctx.body.sort) === '' ? null : intOr(ctx.body.sort, null);
  const text = str(ctx.body.custom_text).slice(0, 1000) || null;
  ctx.db.prepare('INSERT INTO poi_overrides(poi_id, hidden, custom_text, sort) VALUES (?, ?, ?, ?) ON CONFLICT(poi_id) DO UPDATE SET hidden = excluded.hidden, custom_text = excluded.custom_text, sort = excluded.sort').run(id, hidden, text, sort);
  audit(ctx, 'poi.override', { entity: 'poi', entityId: id, meta: { hidden, sort, customText: !!text } });
  flash(ctx, 'success', `Zajímavost ${id} uložena.`);
  return ctx.redirect('/admin/obsah');
}

// ---------------------------------------------------------------------------------------------------------
// Nastavení (owner)

const GATEWAYS = [{ value: 'mock', label: 'Simulační brána (demo)' }];
const MATCHERS = [{ value: 'fio-mock', label: 'Simulace Fio API (demo)' }];

async function nastaveniGet(ctx) {
  const users = ctx.db.prepare('SELECT id, email, name, role, totp_enabled, failed_logins, locked_until, disabled, last_login_at, created_at FROM users ORDER BY id').all();
  const closures = ctx.db.prepare('SELECT * FROM closures ORDER BY date_from').all();
  const openingHours = (ctx.settings && ctx.settings.openingHours) || ctx.tenant.openingHours || {};
  render(ctx, pages.nastaveni.nastaveni({ settings: ctx.settings, openingHours, closures, users, me: ctx.user, csrf: ctx.adminCsrfToken(), gateways: GATEWAYS, matchers: MATCHERS }), { title: 'Nastavení', lead: 'Změny platí okamžitě; výchozí hodnoty pochází z tenant.json.' });
}

function saveSettings(ctx, values) {
  for (const [k, v] of Object.entries(values)) setSetting(ctx.db, k, v);
  audit(ctx, 'settings.update', { entity: 'settings', meta: values });
}

async function nastaveniPost(ctx) {
  const b = ctx.body;
  const sekce = str(b.sekce);
  const errors = [];
  const num = (v, min, label) => {
    const n = Number(str(v));
    if (!Number.isFinite(n) || n < min) errors.push(label);
    return n;
  };
  const values = {};
  if (sekce === 'rezervace') {
    const feeDefault = parseKc(b.fee_default);
    const feeEbike = parseKc(b.fee_ebike);
    if (feeDefault === null || feeEbike === null) errors.push('poplatek');
    values.feeMinor = { default: feeDefault, ebike: feeEbike };
    values.cancellation = { freeHoursBefore: num(b.free_hours, 0, 'storno lhůta') };
    values.bufferMinutes = num(b.buffer, 0, 'buffer');
    values.transferExpiryHours = num(b.transfer_hours, 1, 'lhůta převodu');
    values.preauthMaxDays = num(b.preauth_days, 1, 'preautorizace');
    values.maxRentalDays = num(b.max_days, 1, 'max. délka');
    values.paymentToleranceMinor = parseKc(b.tolerance) ?? 500;
    values.vatRate = num(b.vat_rate, 0, 'DPH');
    values.gateway = GATEWAYS.some((g) => g.value === str(b.gateway)) ? str(b.gateway) : 'mock';
    values.bankMatcher = MATCHERS.some((m) => m.value === str(b.bank_matcher)) ? str(b.bank_matcher) : 'fio-mock';
    values.allowPayOnSite = checked(b.allow_on_site);
    if (str(b.accepted_docs)) values.acceptedIdDocs = str(b.accepted_docs).slice(0, 120);
  } else if (sekce === 'pravni') {
    // varianty právních textů – klíče čte legalParams (features/pravni.js); prázdný text = výchozí znění
    const opt = (v, key, fallback) => (pages.nastaveni.LEGAL_OPTIONS[key].some((o) => o.value === str(v)) ? str(v) : fallback);
    const text = (v, max) => str(v).slice(0, max);
    values.accountingMode = opt(b.accounting_mode, 'accountingMode', '');
    values.signatureMode = opt(b.signature_mode, 'signatureMode', 'obrazovka');
    values.idDocPrint = opt(b.id_doc_print, 'idDocPrint', 'maskovane');
    values.secondIdDoc = checked(b.second_id_doc);
    values.recordBirthAddress = checked(b.record_birth_address);
    values.gpsTrackers = checked(b.gps_trackers);
    values.insurance = text(b.insurance, 120);
    values.chargingFlatMinor = parseKc(b.charging_flat) ?? 0;
    values.terminalProvider = text(b.terminal_provider, 80);
    values.accountantName = text(b.accountant_name, 120);
    values.accountantRole = text(b.accountant_role, 60);
    values.balanceBeforePickup = checked(b.balance_before_pickup);
    values.earlyReturnRefund = checked(b.early_return_refund);
    values.analyticsTool = text(b.analytics_tool, 80);
    values.analyticsProvider = text(b.analytics_provider, 120);
    values.analyticsCookiesTable = text(b.analytics_cookies_table, 4000);
    values.transferOutsideEu = checked(b.transfer_outside_eu);
    values.transferOutsideEuText = text(b.transfer_outside_eu_text, 2000);
  } else if (sekce === 'retence') {
    values.idDocRetentionDays = num(b.id_doc_days, 1, 'retence dokladu');
    values.reservationRetentionDays = num(b.reservation_days, 1, 'retence rezervací');
    values.contractRetentionYears = num(b.contract_years, 1, 'retence smluv');
    values.logRetentionDays = num(b.log_days, 1, 'retence logů');
  } else if (sekce === 'oteviraci') {
    const oh = {};
    for (const d of format.DAY_KEYS) {
      const from = str(b[`oh_${d}_from`]);
      const to = str(b[`oh_${d}_to`]);
      if (from && to) {
        if (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to) || to <= from) errors.push(`otevírací doba ${format.DAY_LABELS[d]}`);
        oh[d] = [from, to];
      } else oh[d] = null;
    }
    values.openingHours = oh;
  } else throw new HttpError(400, 'Neznámá sekce nastavení.');
  if (errors.length) {
    flash(ctx, 'danger', `Nastavení nebylo uloženo – zkontrolujte: ${errors.join(', ')}.`);
    return ctx.redirect('/admin/nastaveni');
  }
  saveSettings(ctx, values);
  flash(ctx, 'success', 'Nastavení uloženo.');
  return ctx.redirect('/admin/nastaveni');
}

async function zavrenoPost(ctx) {
  const from = str(ctx.body.date_from);
  const to = str(ctx.body.date_to) || from;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) {
    flash(ctx, 'danger', 'Zadejte platný rozsah dat.');
    return ctx.redirect('/admin/nastaveni');
  }
  const id = Number(ctx.db.prepare('INSERT INTO closures(date_from, date_to, reason) VALUES (?, ?, ?)').run(from, to, str(ctx.body.reason) || null).lastInsertRowid);
  audit(ctx, 'closure.create', { entity: 'closure', entityId: id, meta: { from, to } });
  flash(ctx, 'success', 'Zavírací dny přidány.');
  return ctx.redirect('/admin/nastaveni');
}

async function zavrenoSmazatPost(ctx) {
  const row = ctx.db.prepare('SELECT * FROM closures WHERE id = ?').get(Number(ctx.params.id));
  if (!row) throw new HttpError(404, 'Záznam nebyl nalezen.');
  ctx.db.prepare('DELETE FROM closures WHERE id = ?').run(row.id);
  audit(ctx, 'closure.delete', { entity: 'closure', entityId: row.id, meta: { from: row.date_from, to: row.date_to } });
  flash(ctx, 'success', 'Zavírací den smazán.');
  return ctx.redirect('/admin/nastaveni');
}

function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 10 && pw.length <= 200;
}

async function uzivatelePost(ctx) {
  const email = normalizeEmail(ctx.body.email);
  const name = str(ctx.body.name);
  const role = Object.hasOwn(s.ROLE_LABELS, str(ctx.body.role)) ? str(ctx.body.role) : 'staff';
  const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || name.length < 2 || !validPassword(password)) {
    flash(ctx, 'danger', 'Zadejte platný e-mail, jméno a heslo (min. 10 znaků).');
    return ctx.redirect('/admin/nastaveni');
  }
  if (ctx.db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    flash(ctx, 'danger', 'Uživatel s tímto e-mailem už existuje.');
    return ctx.redirect('/admin/nastaveni');
  }
  const id = Number(ctx.db.prepare('INSERT INTO users(email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(email, name, hashPassword(password), role, nowIso()).lastInsertRowid);
  audit(ctx, 'user.create', { entity: 'user', entityId: id, meta: { role } });
  flash(ctx, 'success', `Uživatel ${name} (${s.ROLE_LABELS[role]}) přidán.`);
  return ctx.redirect('/admin/nastaveni');
}

async function uzivatelPost(ctx) {
  const u = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(ctx.params.id));
  if (!u) throw new HttpError(404, 'Uživatel nebyl nalezen.');
  const akce = str(ctx.body.akce) || 'ulozit';
  const self = u.id === ctx.user.id;
  if (akce === 'odemknout') {
    ctx.db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(u.id);
    audit(ctx, 'user.unlock', { entity: 'user', entityId: u.id });
    flash(ctx, 'success', `Účet ${u.email} odemčen.`);
  } else if (akce === 'zablokovat' || akce === 'povolit') {
    if (self) throw new HttpError(400, 'Vlastní účet nelze zablokovat.');
    ctx.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(akce === 'zablokovat' ? 1 : 0, u.id);
    if (akce === 'zablokovat') ctx.db.prepare("DELETE FROM sessions WHERE kind = 'admin' AND user_id = ?").run(u.id);
    audit(ctx, akce === 'zablokovat' ? 'user.disable' : 'user.enable', { entity: 'user', entityId: u.id });
    flash(ctx, 'success', `Účet ${u.email} ${akce === 'zablokovat' ? 'zablokován' : 'povolen'}.`);
  } else if (akce === 'vypnout-2fa') {
    ctx.db.prepare('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL WHERE id = ?').run(u.id);
    audit(ctx, 'user.totp_disable', { entity: 'user', entityId: u.id, meta: { by: 'owner' } });
    flash(ctx, 'success', `2FA účtu ${u.email} vypnuto.`);
  } else {
    const role = Object.hasOwn(s.ROLE_LABELS, str(ctx.body.role)) ? str(ctx.body.role) : u.role;
    const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
    if (password && !validPassword(password)) {
      flash(ctx, 'danger', 'Heslo musí mít 10–200 znaků.');
      return ctx.redirect('/admin/nastaveni');
    }
    if (!self && role !== u.role) {
      if (u.role === 'owner' && ctx.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled = 0").get().n <= 1) {
        flash(ctx, 'danger', 'Poslednímu majiteli nelze odebrat roli.');
        return ctx.redirect('/admin/nastaveni');
      }
      ctx.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
      audit(ctx, 'user.role', { entity: 'user', entityId: u.id, meta: { from: u.role, to: role } });
    }
    if (password) {
      ctx.db.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(hashPassword(password), u.id);
      if (!self) ctx.db.prepare("DELETE FROM sessions WHERE kind = 'admin' AND user_id = ?").run(u.id);
      audit(ctx, 'user.password_reset', { entity: 'user', entityId: u.id, meta: { by: self ? 'self' : 'owner' } });
    }
    flash(ctx, 'success', `Uživatel ${u.email} uložen.`);
  }
  return ctx.redirect('/admin/nastaveni');
}

// ---------------------------------------------------------------------------------------------------------
// Účet (všichni): heslo, 2FA

async function ucetGet(ctx) {
  render(ctx, pages.nastaveni.ucet({ me: ctx.user, csrf: ctx.adminCsrfToken(), setup: null, issuer: ctx.tenant.name }), { title: 'Můj účet', lead: `${ctx.user.name} · ${ctx.user.email}` });
}

async function hesloPost(ctx) {
  const u = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
  const ok = await verifyPassword(typeof ctx.body.stare === 'string' ? ctx.body.stare : '', u.password_hash);
  if (!ok) flash(ctx, 'danger', 'Současné heslo nesouhlasí.');
  else if (!validPassword(ctx.body.nove) || ctx.body.nove !== ctx.body.nove2) flash(ctx, 'danger', 'Nové heslo musí mít alespoň 10 znaků a obě pole se musí shodovat.');
  else {
    ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(ctx.body.nove), u.id);
    audit(ctx, 'user.password_change', { entity: 'user', entityId: u.id });
    flash(ctx, 'success', 'Heslo změněno.');
  }
  return ctx.redirect('/admin/ucet');
}

async function totpSetupGet(ctx) {
  if (ctx.user.totp_enabled) return ctx.redirect('/admin/ucet');
  let secret = ctx.adminSession.get('totpSetup');
  if (!secret || typeof secret !== 'string') {
    secret = totp.generateSecret();
    ctx.adminSession.set('totpSetup', secret);
  }
  const otpauth = totp.otpauthUrl({ secret, label: ctx.user.email, issuer: ctx.tenant.name });
  render(ctx, pages.nastaveni.ucet({ me: ctx.user, csrf: ctx.adminCsrfToken(), setup: { secret, otpauth, qrSvg: qrSvgFor(otpauth) }, issuer: ctx.tenant.name }), { title: 'Zapnout 2FA' });
}

async function totpEnablePost(ctx) {
  const secret = ctx.adminSession.get('totpSetup');
  if (!secret) return ctx.redirect('/admin/ucet/2fa');
  if (totp.verify(secret, str(ctx.body.kod)) === null) {
    flash(ctx, 'danger', 'Kód nesouhlasí – zkuste aktuální kód z autentikátoru.');
    return ctx.redirect('/admin/ucet/2fa');
  }
  ctx.db.prepare('UPDATE users SET totp_secret_enc = ?, totp_enabled = 1 WHERE id = ?').run(ctx.app.fieldCrypto.enc(secret), ctx.user.id);
  ctx.adminSession.delete('totpSetup');
  audit(ctx, 'user.totp_enable', { entity: 'user', entityId: ctx.user.id });
  flash(ctx, 'success', 'Dvoufázové ověření je zapnuté. Při příštím přihlášení zadáte i kód z autentikátoru.');
  return ctx.redirect('/admin/ucet');
}

async function totpDisablePost(ctx) {
  const u = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
  const secret = dec(ctx, u.totp_secret_enc);
  if (!u.totp_enabled || !secret || totp.verify(secret, str(ctx.body.kod)) === null) {
    flash(ctx, 'danger', 'Kód nesouhlasí – 2FA zůstává zapnuté.');
    return ctx.redirect('/admin/ucet');
  }
  ctx.db.prepare('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL WHERE id = ?').run(u.id);
  audit(ctx, 'user.totp_disable', { entity: 'user', entityId: u.id, meta: { by: 'self' } });
  flash(ctx, 'success', 'Dvoufázové ověření vypnuto.');
  return ctx.redirect('/admin/ucet');
}

// ---------------------------------------------------------------------------------------------------------
// Audit

async function auditGet(ctx) {
  const q = ctx.query;
  const filters = { akce: str(q.akce), entita: str(q.entita), od: str(q.od) };
  const where = [];
  const args = [];
  if (filters.akce) where.push('a.action = ?'), args.push(filters.akce);
  const em = /^([a-z_]+)\s*#?\s*(\S+)?$/i.exec(filters.entita);
  if (em) {
    where.push('a.entity = ?'), args.push(em[1]);
    if (em[2]) where.push('a.entity_id = ?'), args.push(em[2]);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(filters.od)) where.push('a.at >= ?'), args.push(availability.localToUtc(filters.od, '00:00').toISOString());
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_log a ${sql}`).get(...args).n;
  const size = 100;
  const pages_ = Math.max(1, Math.ceil(total / size));
  const page = Math.min(pages_, Math.max(1, intOr(q.strana, 1)));
  const rows = ctx.db
    .prepare(`SELECT a.*, u.email AS user_email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${sql} ORDER BY a.id DESC LIMIT ? OFFSET ?`)
    .all(...args, size, (page - 1) * size)
    .map((r) => ({ ...r, metaPretty: r.meta ? JSON.stringify(parseJson(r.meta, r.meta), null, 1) : '' }));
  const actions = ctx.db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map((x) => x.action);
  const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
  render(ctx, pages.audit.audit({ rows, filters, actions, page, pages: pages_, total, href: `/admin/audit${params.toString() ? `?${params}` : ''}` }), { title: 'Audit', wide: true });
}

// ---------------------------------------------------------------------------------------------------------
// Job: retence čísel dokladů totožnosti

async function idDocRetentionJob(deps) {
  const { tenants, dbs, log } = deps;
  const now = nowIso();
  for (const tenant of tenants || []) {
    const db = dbs.get(tenant.slug);
    if (!db) continue;
    try {
      const rows = db.prepare('SELECT id FROM customers WHERE id_doc_number_enc IS NOT NULL AND id_doc_delete_after IS NOT NULL AND id_doc_delete_after <= ?').all(now);
      for (const row of rows) {
        db.prepare('UPDATE customers SET id_doc_type = NULL, id_doc_number_enc = NULL, id_doc_delete_after = NULL WHERE id = ?').run(row.id);
        db.prepare('INSERT INTO audit_log(at, user_id, action, entity, entity_id, meta, ip_hash) VALUES (?, NULL, ?, ?, ?, ?, NULL)').run(now, 'customer.id_doc_deleted', 'customer', String(row.id), JSON.stringify({ reason: 'retention' }));
      }
      if (rows.length && log) log.info('Retence dokladů totožnosti', { tenant: tenant.slug, deleted: rows.length });
    } catch (e) {
      if (log) log.error('Retence dokladů selhala', { tenant: tenant.slug, error: e.message });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Routy

const GET = { rateLimit: 'public' };
const POST = { csrf: true, csrfSession: 'admin', rateLimit: 'public' };
const LOGIN = { csrf: true, csrfSession: 'admin', rateLimit: 'login' };
const g = (fn) => guard(fn);
const owner = (fn) => guard(fn, { role: 'owner' });

module.exports = {
  name: 'admin',
  routes: [
    ['GET', '/admin/login', loginGet, GET],
    ['POST', '/admin/login', loginPost, LOGIN],
    ['GET', '/admin/login/2fa', totpGet, GET],
    ['POST', '/admin/login/2fa', totpPost, LOGIN],
    ['POST', '/admin/logout', logoutPost, POST],

    ['GET', '/admin', g(dnesGet), GET],
    ['GET', '/admin/rezervace', g(rezervaceList), GET],
    ['GET', '/admin/rezervace/:id', g(rezervaceDetail), GET],
    ['POST', '/admin/rezervace/:id/potvrdit-platbu', g(potvrditPlatbuPost), POST],
    ['POST', '/admin/rezervace/:id/kola', g(kolaPost), POST],
    ['POST', '/admin/rezervace/:id/doklad', g(dokladPost), POST],
    ['POST', '/admin/rezervace/:id/kauce', g(kaucePost), POST],
    ['POST', '/admin/rezervace/:id/doplatek', g(doplatekPost), POST],
    ['POST', '/admin/rezervace/:id/vydat', g(vydatPost), POST],
    ['POST', '/admin/rezervace/:id/vratit', g(vratitPost), POST],
    ['POST', '/admin/rezervace/:id/uzavrit', g(uzavritPost), POST],
    ['POST', '/admin/rezervace/:id/storno', g(stornoPost), POST],
    ['POST', '/admin/rezervace/:id/no-show', g(noShowPost), POST],
    ['GET', '/admin/doklady/:number', g(dokladGet), GET],

    ['GET', '/admin/kalendar', g(kalendarGet), GET],

    ['GET', '/admin/kola', g(kolaGet), GET],
    ['GET', '/admin/kola/stitky', g(stitkyGet), GET],
    ['GET', '/admin/kola/typ/:id', g(typFormGet), GET],
    ['POST', '/admin/kola/typ', g(typPost), POST],
    ['POST', '/admin/kola/typ/:id', g(typPost), POST],
    ['GET', '/admin/kola/kus/:id', g(kusFormGet), GET],
    ['POST', '/admin/kola/kus', g(kusPost), POST],
    ['POST', '/admin/kola/kus/:id', g(kusPost), POST],
    ['POST', '/admin/kola/kus/:id/stav', g(kusStavPost), POST],

    ['GET', '/admin/cenik', g(cenikGet), GET],
    ['POST', '/admin/cenik/typ/:id', g(cenikTypPost), POST],
    ['POST', '/admin/cenik/sezona', g(sezonaPost), POST],
    ['POST', '/admin/cenik/sezona/:id/smazat', g(sezonaSmazatPost), POST],
    ['POST', '/admin/cenik/prislusenstvi', g(prislusenstviPost), POST],
    ['POST', '/admin/cenik/prislusenstvi/:id', g(prislusenstviPost), POST],

    ['GET', '/admin/platby', g(platbyGet), GET],
    ['POST', '/admin/platby/simulace', g(simulacePost), POST],
    ['POST', '/admin/platby/sparovat', g(sparovatPost), POST],
    ['POST', '/admin/platby/vratka/:id/potvrdit', g(vratkaPotvrditPost), POST],

    ['GET', '/admin/emaily', g(emailyList), GET],
    ['GET', '/admin/emaily/:id', g(emailDetail), GET],

    ['GET', '/admin/zakaznici', g(zakazniciList), GET],
    ['GET', '/admin/zakaznici/:id', g(zakaznikDetail), GET],
    ['GET', '/admin/zakaznici/:id/export.json', g(zakaznikExport), GET],
    ['POST', '/admin/zakaznici/:id/anonymizovat', g(zakaznikAnonymizovat), POST],
    ['POST', '/admin/zakaznici/:id/doklad-smazat', g(zakaznikDokladSmazat), POST],

    ['GET', '/admin/obsah', g(obsahGet), GET],
    ['POST', '/admin/obsah/texty', g(textyPost), POST],
    ['POST', '/admin/obsah/poi/:id', g(poiPost), POST],

    ['GET', '/admin/nastaveni', owner(nastaveniGet), GET],
    ['POST', '/admin/nastaveni', owner(nastaveniPost), POST],
    ['POST', '/admin/nastaveni/zavreno', owner(zavrenoPost), POST],
    ['POST', '/admin/nastaveni/zavreno/:id/smazat', owner(zavrenoSmazatPost), POST],
    ['POST', '/admin/nastaveni/uzivatele', owner(uzivatelePost), POST],
    ['POST', '/admin/nastaveni/uzivatele/:id', owner(uzivatelPost), POST],

    ['GET', '/admin/ucet', g(ucetGet), GET],
    ['POST', '/admin/ucet/heslo', g(hesloPost), POST],
    ['GET', '/admin/ucet/2fa', g(totpSetupGet), GET],
    ['POST', '/admin/ucet/2fa', g(totpEnablePost), POST],
    ['POST', '/admin/ucet/2fa/vypnout', g(totpDisablePost), POST],

    ['GET', '/admin/audit', g(auditGet), GET],
  ],
  nav: [],
  css: ['/css/admin.css'],
  js: ['/admin/dom.js', '/admin/toast.js', '/admin/modal.js', '/admin/table.js', '/admin/admin.js'],
  jobs: [{ name: 'admin-id-doc-retention', everyMs: 60 * 60 * 1000, fn: idDocRetentionJob }],
  // pro testy
  guard,
  currentUser,
  parseKc,
  modules,
  LOCK_AFTER,
  LOCK_MS,
  qrSvgFor,
  idDocRetentionJob,
  getSettings,
};
