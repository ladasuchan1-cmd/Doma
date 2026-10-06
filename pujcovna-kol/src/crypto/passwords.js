'use strict';
// Hesla: scrypt hash a ověření (SPEC kap. 2, PLAN kap. 7: N = 2^17, r = 8, p = 1).
// Formát uloženého hashe: 'scrypt$N$r$p$<salt base64url>$<hash base64url>'.
// Vstup: heslo (string). Výstup: hash (string) / boolean. Ověření je asynchronní, aby neblokovalo event loop;
// pro skripty (demo-data) je k dispozici i synchronní varianta.

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(crypto.scrypt);

const SCRYPT = Object.freeze({ N: 2 ** 17, r: 8, p: 1, keylen: 32, saltBytes: 16 });
const MAX_PASSWORD_LENGTH = 1024;

function maxmem(N, r) {
  return 128 * N * r + 1024 * 1024;
}

function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0 || !Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) return null;
  if (N > 2 ** 20 || r > 32 || p > 16) return null; // ochrana proti DoS podstrčeným hashem
  const salt = Buffer.from(parts[4], 'base64url');
  const hash = Buffer.from(parts[5], 'base64url');
  if (!salt.length || !hash.length) return null;
  return { N, r, p, salt, hash };
}

function checkPasswordInput(password) {
  if (typeof password !== 'string' || password.length === 0) return false;
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  return true;
}

/** Vytvoří scrypt hash hesla (synchronně; při N = 2^17 cca 100–200 ms). */
function hashPassword(password, params = SCRYPT) {
  if (!checkPasswordInput(password)) throw new Error('Heslo musí být neprázdný řetězec do 1024 znaků.');
  const { N, r, p, keylen } = { ...SCRYPT, ...params };
  const salt = crypto.randomBytes(SCRYPT.saltBytes);
  const hash = crypto.scryptSync(password, salt, keylen, { N, r, p, maxmem: maxmem(N, r) });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** Ověří heslo proti hashi (asynchronně). Neplatný formát / špatné heslo → false, nikdy výjimka. */
async function verifyPassword(password, stored) {
  if (!checkPasswordInput(password)) return false;
  const parsed = parseHash(stored);
  if (!parsed) return false;
  try {
    const actual = await scryptAsync(password, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: maxmem(parsed.N, parsed.r),
    });
    return crypto.timingSafeEqual(actual, parsed.hash);
  } catch {
    return false;
  }
}

/** Synchronní ověření (jen pro skripty a testy). */
function verifyPasswordSync(password, stored) {
  if (!checkPasswordInput(password)) return false;
  const parsed = parseHash(stored);
  if (!parsed) return false;
  try {
    const actual = crypto.scryptSync(password, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: maxmem(parsed.N, parsed.r),
    });
    return crypto.timingSafeEqual(actual, parsed.hash);
  } catch {
    return false;
  }
}

/** Má hash slabší parametry než aktuální SCRYPT (→ po úspěšném přihlášení přehashovat)? */
function needsRehash(stored) {
  const parsed = parseHash(stored);
  if (!parsed) return true;
  return parsed.N < SCRYPT.N || parsed.r < SCRYPT.r || parsed.p < SCRYPT.p || parsed.hash.length < SCRYPT.keylen;
}

/** Náhodné heslo bez snadno zaměnitelných znaků (0/O, 1/l/I) – pro první start bez PK_ADMIN_PASSWORD. */
function generatePassword(length = 16) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const out = [];
  const max = 256 - (256 % alphabet.length);
  while (out.length < length) {
    for (const b of crypto.randomBytes(length * 2)) {
      if (b < max) out.push(alphabet[b % alphabet.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

module.exports = { SCRYPT, hashPassword, verifyPassword, verifyPasswordSync, needsRehash, parseHash, generatePassword };
