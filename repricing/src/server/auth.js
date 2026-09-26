'use strict';
// Autentizace a autorizace (SPEC §8 server/auth.js).
//
// Heslo
//   - CENOTVORBA_PASSWORD (config.password) má přednost; jinak scrypt hash v settings '_password_hash'.
//   - Při prvním startu bez obojího se vygeneruje náhodné 16znakové heslo, uloží se jeho hash a initAuth ho vrátí
//     (server.js ho jednou vypíše do konzole).
//   - Formát hashe: 'scrypt$N$r$p$<salt base64url>$<hash base64url>'.
// Session
//   - cookie 'ct_session' = base64url(JSON {u, exp, pv}) + '.' + base64url(HMAC-SHA256(secret, payload)),
//     u = jméno zadané při přihlášení (C9, jen označení pro decided_by / audit – heslo je společné), jinak 'admin',
//     exp = unix čas v ms, platnost 14 dní (klouzavě obnovováno), HttpOnly, SameSite=Strict, Secure na HTTPS.
//   - pv = „verze hesla“ (HMAC z hashe hesla) → změna hesla zneplatní všechny starší session.
//   - tajemství: CENOTVORBA_SECRET (config.secret), jinak settings '_secret' (vygenerováno při prvním startu).
// API tokeny
//   - 'ct_' + 32 znaků base62; v DB jen sha256 hex (tokens.token_hash), prefix = prvních 7 znaků pro zobrazení.
//   - předání: 'Authorization: Bearer <token>', hlavička 'X-Api-Key', nebo query '?token=' (feedy).
//   - rozsahy: read | import | export | admin ('admin' zahrnuje všechny ostatní). Session = všechny rozsahy.
// CSRF
//   - požadavky ověřené cookie (ne GET/HEAD/OPTIONS) musí mít hlavičku 'X-Requested-With: cenotvorba'.
// Přihlášení
//   - max. 10 neúspěšných pokusů za 15 minut z jedné IP → 429.

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { getSetting, setSetting, nowIso, parseJson } = require('../db');

// HttpError žije v http.js, který naopak vyžaduje tento modul → líný require (žádný cyklus při načítání).
function httpError(status, message, details) {
  const { HttpError } = require('./http');
  return new HttpError(status, message, details);
}

const scryptAsync = promisify(crypto.scrypt);

const SESSION_COOKIE = 'ct_session';
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// Session se obnoví (nová cookie), když do vypršení zbývá méně než tato doba.
const SESSION_RENEW_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_USER = 'admin';
const SCOPES = ['read', 'import', 'export', 'admin'];
// Úrovně ověření použitelné v route option {auth}: 'public' | 'any' | rozsah | pole rozsahů (stačí kterýkoli).
const AUTH_LEVELS = ['public', 'any', ...SCOPES];
const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'cenotvorba';
const TOKEN_PREFIX = 'ct_';
const TOKEN_LENGTH = 32;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// Bez snadno zaměnitelných znaků (0/O, 1/l/I) – heslo se opisuje z konzole.
const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const MIN_PASSWORD_LENGTH = 8;
const LAST_USED_THROTTLE_MS = 60 * 1000;

// Stav per databáze (tajemství, verze hesla) – cache, aby se nečetlo z DB při každém požadavku.
const state = new WeakMap();

// ---------------------------------------------------------------------------------------------------------
// Pomocníci

function randomString(length, alphabet) {
  // Rejection sampling → rovnoměrné rozdělení bez modulo biasu.
  const out = [];
  const max = 256 - (256 % alphabet.length);
  while (out.length < length) {
    const bytes = crypto.randomBytes(length * 2);
    for (const b of bytes) {
      if (b < max) out.push(alphabet[b % alphabet.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/** Porovnání řetězců v konstantním čase (vzhledem k obsahu; délka se porovná zvlášť). */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // i při různé délce proběhne porovnání, ať se čas neliší podle toho, kde se řetězce rozcházejí
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function toMs(now) {
  if (now == null) return Date.now();
  if (typeof now === 'number') return now;
  return new Date(now).getTime();
}

// ---------------------------------------------------------------------------------------------------------
// Hesla

/** Vytvoří scrypt hash hesla (synchronně; ~50 ms). */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64url(salt)}$${b64url(hash)}`;
}

/** Ověří heslo proti uloženému hashi (asynchronně, neblokuje event loop). */
async function verifyPasswordHash(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (!N || !r || !p || !expected.length) return false;
  try {
    const actual = await scryptAsync(String(password), salt, expected.length, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Je heslo řízeno proměnnou prostředí CENOTVORBA_PASSWORD? */
function passwordFromEnv(config) {
  return !!(config && config.password);
}

/**
 * Ověří heslo pro přihlášení (env CENOTVORBA_PASSWORD, jinak hash v DB).
 * @returns {Promise<boolean>}
 */
async function verifyPassword(db, config, password) {
  if (typeof password !== 'string' || password === '') return false;
  if (passwordFromEnv(config)) {
    // porovnání otisků stejné délky v konstantním čase
    return safeEqual(sha256Hex(password), sha256Hex(config.password));
  }
  const stored = getSetting(db, '_password_hash', null);
  if (!stored) return false;
  return verifyPasswordHash(password, stored);
}

/**
 * Nastaví nové heslo (uloží hash do settings '_password_hash'). Zneplatní všechny existující session.
 * Pokud je heslo řízeno přes CENOTVORBA_PASSWORD, vyhodí HttpError 409.
 */
function setPassword(db, newPassword, config) {
  if (passwordFromEnv(config)) {
    throw httpError(409, 'Heslo je nastaveno proměnnou prostředí CENOTVORBA_PASSWORD – v aplikaci ho nelze změnit.');
  }
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
    throw httpError(400, `Nové heslo musí mít alespoň ${MIN_PASSWORD_LENGTH} znaků.`);
  }
  if (newPassword.length > 1024) throw httpError(400, 'Nové heslo je příliš dlouhé.');
  setSetting(db, '_password_hash', hashPassword(newPassword));
  const st = state.get(db);
  if (st) st.pv = null; // přepočítat při dalším použití
}

/** Vygeneruje náhodné heslo (16 znaků, bez zaměnitelných znaků). */
function generatePassword(length = 16) {
  return randomString(length, PASSWORD_ALPHABET);
}

// ---------------------------------------------------------------------------------------------------------
// Inicializace, tajemství

function getState(db) {
  let st = state.get(db);
  if (!st) {
    st = { secret: null, pv: null };
    state.set(db, st);
  }
  return st;
}

/** Tajemství pro HMAC session: config.secret, jinak settings '_secret' (vygeneruje a uloží, pokud chybí). */
function getSecret(db, config) {
  if (config && config.secret) return String(config.secret);
  const st = getState(db);
  if (st.secret) return st.secret;
  let secret = getSetting(db, '_secret', null);
  if (typeof secret !== 'string' || secret.length < 32) {
    secret = crypto.randomBytes(32).toString('hex');
    setSetting(db, '_secret', secret);
  }
  st.secret = secret;
  return secret;
}

/** „Verze hesla“ do session – mění se se změnou hesla, takže staré session přestanou platit. */
function passwordVersion(db, config) {
  const secret = getSecret(db, config);
  const st = getState(db);
  const source = passwordFromEnv(config) ? 'env:' + sha256Hex(config.password) : 'db:' + (getSetting(db, '_password_hash', '') || '');
  // cache podle zdroje (změna env hesla za běhu není možná, změna v DB nuluje st.pv)
  if (st.pv && st.pvSource === source) return st.pv;
  st.pv = crypto.createHmac('sha256', secret).update(source).digest('base64url').slice(0, 16);
  st.pvSource = source;
  return st.pv;
}

/**
 * Připraví autentizaci při startu: tajemství a heslo.
 * @returns {{generatedPassword: string|null, passwordSource: 'env'|'db'|'generated'}}
 */
function initAuth(db, config = {}) {
  getSecret(db, config);
  if (passwordFromEnv(config)) return { generatedPassword: null, passwordSource: 'env' };
  const stored = getSetting(db, '_password_hash', null);
  if (stored) return { generatedPassword: null, passwordSource: 'db' };
  const generatedPassword = generatePassword(16);
  setSetting(db, '_password_hash', hashPassword(generatedPassword));
  getState(db).pv = null;
  return { generatedPassword, passwordSource: 'generated' };
}

/** Vygeneruje a uloží nové heslo (pro `node server.js --reset-password`). */
function resetPassword(db) {
  const pw = generatePassword(16);
  setSetting(db, '_password_hash', hashPassword(pw));
  getState(db).pv = null;
  return pw;
}

// ---------------------------------------------------------------------------------------------------------
// Session cookie

/** Podepíše obsah session → hodnota cookie. */
function signSession(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', String(secret)).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * Ověří hodnotu cookie. Vrací payload, nebo null (poškozená / pozměněná / prošlá).
 * @param {string} value
 * @param {string} secret
 * @param {number|Date|string} [now]
 */
function verifySession(value, secret, now) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const dot = value.indexOf('.');
  if (dot <= 0 || dot !== value.lastIndexOf('.')) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = crypto.createHmac('sha256', String(secret)).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || typeof payload.u !== 'string' || typeof payload.exp !== 'number') return null;
  if (payload.exp <= toMs(now)) return null;
  return payload;
}

/** Rozparsuje hlavičku Cookie → objekt (první výskyt jména vyhrává). */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || Object.hasOwn(out, name)) continue;
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
    try {
      out[name] = decodeURIComponent(val);
    } catch {
      out[name] = val;
    }
  }
  return out;
}

/** Je požadavek přes HTTPS (přímo, nebo za důvěryhodnou proxy s X-Forwarded-Proto)? */
function isSecureRequest(req, config) {
  if (req.socket && req.socket.encrypted) return true;
  if (config && config.trustProxy) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    return proto === 'https';
  }
  return false;
}

/** Sestaví hlavičku Set-Cookie pro session. */
function sessionCookie(value, { secure = false, maxAgeMs = SESSION_TTL_MS } = {}) {
  const parts = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Hlavička Set-Cookie, která session smaže. */
function clearSessionCookie({ secure = false } = {}) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function appendSetCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  // stejnou cookie přepisujeme, jiné ponecháme
  const list = (prev == null ? [] : Array.isArray(prev) ? prev : [String(prev)]).filter((c) => !c.startsWith(SESSION_COOKIE + '='));
  list.push(cookie);
  res.setHeader('Set-Cookie', list);
}

/**
 * Jméno pro přihlášení (C9 – jen označení, kdo co schválil / změnil; NENÍ to ověření identity – heslo je společné).
 * Ořezané, 1–64 znaků, bez řídicích znaků; „auto“ (značka automatického schválení) a „token:…“ (API tokeny) jsou
 * vyhrazené. Chybějící / prázdné jméno → null (použije se „admin“).
 * @returns {{name: string|null, error: string|null}}
 */
function normalizeUserName(v) {
  if (v === undefined || v === null) return { name: null, error: null };
  if (typeof v !== 'string') return { name: null, error: 'Jméno musí být text.' };
  const s = v.trim();
  if (!s) return { name: null, error: null };
  if (s.length > 64) return { name: null, error: 'Jméno může mít nejvýše 64 znaků.' };
  // řídicí znaky (C0, DEL, C1) a oddělovače řádků/odstavců
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s)) return { name: null, error: 'Jméno nesmí obsahovat řídicí znaky ani konce řádků.' };
  if (s.toLowerCase() === 'auto' || /^token:/i.test(s)) return { name: null, error: 'Jméno „auto“ a jména začínající „token:“ jsou vyhrazená – zvolte jiné.' };
  return { name: s, error: null };
}

/**
 * Vytvoří session pro přihlášeného uživatele a nastaví cookie do odpovědi.
 * @param {object} ctx
 * @param {{now?: Date|number|string, user?: string|null}} [opts] user = jméno ze session / přihlášení (výchozí „admin“)
 */
function issueSession(ctx, { now, user } = {}) {
  const secret = getSecret(ctx.db, ctx.config);
  const exp = toMs(now) + SESSION_TTL_MS;
  const u = typeof user === 'string' && user ? user : SESSION_USER;
  const value = signSession({ u, exp, pv: passwordVersion(ctx.db, ctx.config) }, secret);
  appendSetCookie(ctx.res, sessionCookie(value, { secure: isSecureRequest(ctx.req, ctx.config) }));
  return { user: u, exp };
}

/** Smaže session cookie v prohlížeči. */
function clearSession(ctx) {
  appendSetCookie(ctx.res, clearSessionCookie({ secure: isSecureRequest(ctx.req, ctx.config) }));
}

// ---------------------------------------------------------------------------------------------------------
// API tokeny

function normalizeScopes(scopes) {
  let list = scopes;
  if (typeof list === 'string') list = list.split(/[\s,]+/);
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const s of list) {
    const v = String(s).trim().toLowerCase();
    if (!v) continue;
    if (!SCOPES.includes(v)) return null;
    if (!out.includes(v)) out.push(v);
  }
  return out.length ? SCOPES.filter((s) => out.includes(s)) : null;
}

/** Vygeneruje řetězec tokenu 'ct_' + 32 base62. */
function generateToken() {
  return TOKEN_PREFIX + randomString(TOKEN_LENGTH, BASE62);
}

/**
 * Vytvoří API token. Prostý token se vrací jen jednou – v DB je pouze jeho sha256.
 * @param {object} db
 * @param {{name: string, scopes: string[]|string}} opts
 * @returns {{id: number, token: string, prefix: string, scopes: string[], name: string, created_at: string}}
 */
function createToken(db, { name, scopes } = {}) {
  const nm = typeof name === 'string' ? name.trim() : '';
  if (!nm) throw httpError(400, 'Zadejte název tokenu.');
  if (nm.length > 100) throw httpError(400, 'Název tokenu může mít nejvýše 100 znaků.');
  const sc = normalizeScopes(scopes);
  if (!sc) throw httpError(400, `Neplatné rozsahy tokenu. Povolené: ${SCOPES.join(', ')}.`, { allowed: SCOPES });
  const token = generateToken();
  const prefix = token.slice(0, 7);
  const created_at = nowIso();
  const r = db
    .prepare('INSERT INTO tokens(name, token_hash, prefix, scopes, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(nm, sha256Hex(token), prefix, JSON.stringify(sc), created_at);
  return { id: Number(r.lastInsertRowid), token, prefix, scopes: sc, name: nm, created_at };
}

/** Seznam tokenů (bez hashů). */
function listTokens(db) {
  return db
    .prepare('SELECT id, name, prefix, scopes, created_at, last_used_at FROM tokens ORDER BY id')
    .all()
    .map((r) => ({ ...r, scopes: parseJson(r.scopes, []) }));
}

/** Smaže token. @returns {boolean} true = smazán */
function deleteToken(db, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return false;
  return db.prepare('DELETE FROM tokens WHERE id = ?').run(n).changes > 0;
}

/** Najde token podle prostého řetězce; aktualizuje last_used_at (nejvýše 1× za minutu). */
function findToken(db, token, now) {
  if (typeof token !== 'string') return null;
  token = token.trim();
  if (!token.startsWith(TOKEN_PREFIX) || token.length !== TOKEN_PREFIX.length + TOKEN_LENGTH) return null;
  const hash = sha256Hex(token);
  const row = db.prepare('SELECT id, name, prefix, scopes, token_hash, last_used_at FROM tokens WHERE token_hash = ?').get(hash);
  if (!row || !safeEqual(row.token_hash, hash)) return null;
  const nowMs = toMs(now);
  const last = row.last_used_at ? Date.parse(row.last_used_at) : NaN;
  if (!Number.isFinite(last) || nowMs - last >= LAST_USED_THROTTLE_MS) {
    try {
      db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(new Date(nowMs).toISOString(), row.id);
    } catch {
      /* např. DB zamčená – nevadí */
    }
  }
  return { id: row.id, name: row.name, prefix: row.prefix, scopes: normalizeScopes(parseJson(row.scopes, [])) || [] };
}

/** Vytáhne token z požadavku: Authorization Bearer → X-Api-Key → ?token=. */
function extractToken(req, query) {
  const authz = req.headers.authorization;
  if (typeof authz === 'string') {
    const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(authz);
    if (m) return m[1];
  }
  const key = req.headers['x-api-key'];
  if (typeof key === 'string' && key.trim()) return key.trim();
  if (query && typeof query.token === 'string' && query.token.trim()) return query.token.trim();
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Ověření požadavku

/**
 * Ověří požadavek. Token má přednost před cookie; neplatný předložený token se nezkouší nahradit cookie.
 * Nastaví ctx.authFailure ('invalid_token' | 'invalid_session' | null) pro srozumitelnou chybu 401.
 * @param {{req, db, config, query?, now?}} ctx
 * @returns {{user: string, scopes: string[], via: 'session'|'token', token?: {id, name, prefix}, session?: {exp}}|null}
 */
function authenticate(ctx) {
  const { req, db, config } = ctx;
  ctx.authFailure = null;
  const token = extractToken(req, ctx.query);
  if (token) {
    const t = findToken(db, token, ctx.now);
    if (!t) {
      ctx.authFailure = 'invalid_token';
      return null;
    }
    return { user: `token:${t.name}`, scopes: t.scopes, via: 'token', token: { id: t.id, name: t.name, prefix: t.prefix } };
  }
  const cookies = parseCookies(req.headers.cookie);
  const value = cookies[SESSION_COOKIE];
  if (!value) return null;
  const payload = verifySession(value, getSecret(db, config), ctx.now);
  if (!payload || payload.pv !== passwordVersion(db, config)) {
    ctx.authFailure = 'invalid_session';
    return null;
  }
  return { user: payload.u || SESSION_USER, scopes: [...SCOPES], via: 'session', session: { exp: payload.exp } };
}

/** Má sada rozsahů požadovaný rozsah? ('admin' zahrnuje vše). */
function hasScope(scopes, required) {
  if (required === 'public') return true;
  if (!Array.isArray(scopes) || !scopes.length) return false;
  if (required === 'any') return true;
  const need = Array.isArray(required) ? required : [required];
  return scopes.includes('admin') || need.some((s) => scopes.includes(s));
}

/**
 * Vyhodí HttpError 401 (nepřihlášen) / 403 (chybí rozsah), pokud ctx nesplňuje požadovanou úroveň.
 * @param {object} ctx
 * @param {'public'|'any'|'read'|'import'|'export'|'admin'|string[]} required
 */
function requireScope(ctx, required = 'read') {
  if (required === 'public') return;
  if (!ctx.user) {
    const msg =
      ctx.authFailure === 'invalid_token'
        ? 'Neplatný nebo zrušený API token.'
        : ctx.authFailure === 'invalid_session'
          ? 'Přihlášení vypršelo, přihlaste se prosím znovu.'
          : 'Nepřihlášeno – přihlaste se nebo použijte API token.';
    throw httpError(401, msg, { reason: ctx.authFailure || 'no_credentials' });
  }
  if (!hasScope(ctx.scopes, required)) {
    const need = Array.isArray(required) ? required.join(' nebo ') : required;
    throw httpError(403, `Nedostatečné oprávnění – vyžadován rozsah „${need}“.`, { required, scopes: ctx.scopes });
  }
}

/** CSRF: požadavek ověřený cookie, který není GET/HEAD/OPTIONS, musí mít X-Requested-With: cenotvorba. */
function checkCsrf(ctx) {
  if (ctx.via !== 'session') return;
  const m = ctx.req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return;
  const h = String(ctx.req.headers[CSRF_HEADER] || '').trim().toLowerCase();
  if (h !== CSRF_VALUE) {
    throw httpError(403, 'Chybí hlavička X-Requested-With: cenotvorba (ochrana proti CSRF).', { reason: 'csrf' });
  }
}

/** Je třeba session cookie obnovit (klouzavá platnost)? */
function shouldRenewSession(auth, now) {
  return !!(auth && auth.via === 'session' && auth.session && auth.session.exp - toMs(now) < SESSION_RENEW_MS);
}

// ---------------------------------------------------------------------------------------------------------
// Omezení pokusů o přihlášení

/**
 * In-memory limiter neúspěšných přihlášení (per IP).
 * @param {{max?: number, windowMs?: number}} [opts]
 */
function createLoginLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const fails = new Map(); // ip → [timestamps ms]

  function prune(ip, nowMs) {
    const list = fails.get(ip);
    if (!list) return [];
    const fresh = list.filter((t) => nowMs - t < windowMs);
    if (fresh.length) fails.set(ip, fresh);
    else fails.delete(ip);
    return fresh;
  }

  function sweep(nowMs) {
    if (fails.size < 1000) return;
    for (const ip of [...fails.keys()]) prune(ip, nowMs);
  }

  return {
    /** @returns {{limited: boolean, retryAfterSec: number, remaining: number}} */
    check(ip, now) {
      const nowMs = toMs(now);
      const list = prune(String(ip), nowMs);
      if (list.length >= max) {
        const retryAfterSec = Math.max(1, Math.ceil((list[list.length - max] + windowMs - nowMs) / 1000));
        return { limited: true, retryAfterSec, remaining: 0 };
      }
      return { limited: false, retryAfterSec: 0, remaining: max - list.length };
    },
    fail(ip, now) {
      const nowMs = toMs(now);
      sweep(nowMs);
      const list = prune(String(ip), nowMs);
      list.push(nowMs);
      fails.set(String(ip), list);
      return Math.max(0, max - list.length);
    },
    reset(ip) {
      fails.delete(String(ip));
    },
    size: () => fails.size,
    max,
    windowMs,
  };
}

module.exports = {
  // konstanty
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SESSION_USER,
  normalizeUserName,
  SCOPES,
  AUTH_LEVELS,
  CSRF_VALUE,
  MIN_PASSWORD_LENGTH,
  // start
  initAuth,
  resetPassword,
  getSecret,
  // hesla
  hashPassword,
  verifyPasswordHash,
  verifyPassword,
  setPassword,
  generatePassword,
  passwordFromEnv,
  // session
  signSession,
  verifySession,
  parseCookies,
  sessionCookie,
  clearSessionCookie,
  issueSession,
  clearSession,
  isSecureRequest,
  shouldRenewSession,
  // tokeny
  createToken,
  listTokens,
  deleteToken,
  findToken,
  extractToken,
  normalizeScopes,
  // autorizace
  authenticate,
  hasScope,
  requireScope,
  checkCsrf,
  createLoginLimiter,
  // interní, pro testy
  safeEqual,
  sha256Hex,
};
