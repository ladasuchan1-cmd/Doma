'use strict';
// Podepsané tokeny s expirací (HMAC-SHA256) pro odkazy „správa rezervace“ a podobně + náhodná ID.
//   sign(payload, ttlMs, secret) → '<base64url(JSON)>.<base64url(HMAC)>'; do payloadu se přidá exp (ms) a iat
//   verify(token, secret, { now }) → payload (objekt) nebo null (neplatný podpis / prošlý / poškozený)
//   randomId(bytes = 32) → base64url náhodných bajtů
//   sha256(value) → hex otisk (pro uložení otisku tokenu do DB)
// Klíč se odvozuje HKDF-SHA256 z tajemství s info 'tokens-v1', aby se nepoužíval týž klíč jako pro šifrování polí.

const crypto = require('node:crypto');

const MAX_TOKEN_LENGTH = 4096;

function deriveKey(secret) {
  if (secret === undefined || secret === null || String(secret).length < 16) throw new Error('Tajemství pro tokeny musí mít alespoň 16 znaků.');
  const ikm = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), 'tokens-v1', 32));
}

function hmac(body, secret) {
  return crypto.createHmac('sha256', deriveKey(secret)).update(body).digest('base64url');
}

/** Porovnání v konstantním čase (různá délka → false, ale porovnání proběhne). */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Podepíše payload. ttlMs = doba platnosti v ms (null = bez expirace – používat jen výjimečně).
 * @param {object} payload
 * @param {number|null} ttlMs
 * @param {string} secret
 * @param {{now?: number}} [opts]
 */
function sign(payload, ttlMs, secret, { now = Date.now() } = {}) {
  if (!payload || typeof payload !== 'object') throw new Error('Payload tokenu musí být objekt.');
  const data = { ...payload, iat: now };
  if (ttlMs !== null && ttlMs !== undefined) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('ttlMs musí být kladné číslo.');
    data.exp = now + ttlMs;
  }
  const body = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  return `${body}.${hmac(body, secret)}`;
}

/** Ověří token; vrací payload (včetně iat/exp) nebo null. */
function verify(token, secret, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  if (!safeEqual(sig, hmac(body, secret))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (payload.exp !== undefined && (typeof payload.exp !== 'number' || payload.exp <= now)) return null;
  return payload;
}

/** Náhodné ID (base64url). 32 B → 43 znaků. */
function randomId(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** SHA-256 hex otisk (pro uložení otisku tokenu / session id do DB). */
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = { sign, verify, randomId, sha256, safeEqual };
