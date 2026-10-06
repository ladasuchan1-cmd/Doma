'use strict';
// TOTP podle RFC 6238 (HMAC-SHA1, krok 30 s, 6 číslic) nad HOTP (RFC 4226) – pro 2FA admina.
// Funkce: generateSecret() (20 B, base32), base32Encode/Decode, hotp(secret, counter), totp(secret, { time }),
// verify(secret, code, { window: 1 }) – tolerance ±1 krok, otpauthUrl({ secret, label, issuer }).
// Vstup: secret jako base32 řetězec (bez paddingu, velká písmena; malá i mezery tolerujeme).

const crypto = require('node:crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULTS = Object.freeze({ step: 30, digits: 6, algorithm: 'sha1', window: 1 });

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str || '')
    .toUpperCase()
    .replace(/[\s=-]/g, '');
  if (!clean) return Buffer.alloc(0);
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Neplatný znak base32: „${ch}“`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Náhodný secret (20 B = 160 bitů, doporučení RFC 4226) jako base32. */
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** HOTP (RFC 4226) pro daný čítač. secret: base32 string nebo Buffer. */
function hotp(secret, counter, { digits = DEFAULTS.digits, algorithm = DEFAULTS.algorithm } = {}) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  const msg = Buffer.alloc(8);
  // 64bitový čítač big-endian (BigInt kvůli hodnotám > 2^32)
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac(algorithm, key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Číslo kroku pro čas (ms od epochy nebo Date). */
function timeStep(time, step = DEFAULTS.step) {
  const ms = time instanceof Date ? time.getTime() : typeof time === 'number' ? time : Date.now();
  return Math.floor(ms / 1000 / step);
}

/** TOTP kód pro čas `time` (ms / Date, výchozí teď). */
function totp(secret, { time, step = DEFAULTS.step, digits = DEFAULTS.digits, algorithm = DEFAULTS.algorithm } = {}) {
  return hotp(secret, timeStep(time, step), { digits, algorithm });
}

/**
 * Ověří kód s tolerancí ±window kroků. Vrací posun kroku (−1/0/+1), nebo null při neshodě.
 * Porovnání v konstantním čase.
 */
function verify(secret, code, { time, step = DEFAULTS.step, digits = DEFAULTS.digits, algorithm = DEFAULTS.algorithm, window = DEFAULTS.window } = {}) {
  const input = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d+$/.test(input) || input.length !== digits) return null;
  const base = timeStep(time, step);
  let matched = null;
  for (let delta = -window; delta <= window; delta++) {
    const expected = hotp(secret, base + delta, { digits, algorithm });
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(input)) && matched === null) matched = delta;
  }
  return matched;
}

/** otpauth:// URL pro QR kód v autentikátoru. */
function otpauthUrl({ secret, label, issuer, digits = DEFAULTS.digits, step = DEFAULTS.step, algorithm = DEFAULTS.algorithm }) {
  if (!secret || !label) throw new Error('otpauthUrl vyžaduje secret a label.');
  const issuerPart = issuer ? `${encodeURIComponent(issuer)}:` : '';
  const params = new URLSearchParams({ secret: String(secret).toUpperCase().replace(/=+$/, ''), algorithm: algorithm.toUpperCase(), digits: String(digits), period: String(step) });
  if (issuer) params.set('issuer', issuer);
  return `otpauth://totp/${issuerPart}${encodeURIComponent(label)}?${params.toString()}`;
}

module.exports = { DEFAULTS, base32Encode, base32Decode, generateSecret, hotp, totp, verify, otpauthUrl, timeStep };
