'use strict';
// Šifrování citlivých polí v DB (AES-256-GCM) a HMAC otisk e-mailu pro vyhledávání/deduplikaci (SPEC kap. 2).
//   enc(plaintext) → 'k1:' + base64(nonce(12) | ciphertext | tag(16))
//   dec(stored)    → plaintext; při poškození / jiném klíči vyhodí chybu
//   hmacEmail(email) → hex HMAC-SHA256 z lowercase, trimmed e-mailu
// Klíče se odvozují HKDF-SHA256 z tajemství PK_SECRET: info 'fields-v1' (šifrování), 'email-hmac-v1' (otisk).
// Prefix 'k1' = verze klíče (umožní budoucí rotaci: nový prefix, dec() zkusí podle prefixu).
// Vstup: tajemství (string/Buffer). Výstup: objekt { enc, dec, hmacEmail, isEncrypted }.

const crypto = require('node:crypto');

const KEY_VERSION = 'k1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function deriveKey(secret, info) {
  if (secret === undefined || secret === null || String(secret).length < 16) throw new Error('Tajemství pro šifrování polí musí mít alespoň 16 znaků.');
  const ikm = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, KEY_BYTES));
}

/** Vytvoří šifrovací objekt pro dané tajemství. */
function createFieldCrypto(secret) {
  const keys = { [KEY_VERSION]: deriveKey(secret, 'fields-v1') };
  const hmacKey = deriveKey(secret, 'email-hmac-v1');

  function enc(plaintext) {
    if (plaintext === null || plaintext === undefined) return null;
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', keys[KEY_VERSION], nonce);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${KEY_VERSION}:${Buffer.concat([nonce, ct, tag]).toString('base64')}`;
  }

  function dec(stored) {
    if (stored === null || stored === undefined) return null;
    const s = String(stored);
    const colon = s.indexOf(':');
    if (colon <= 0) throw new Error('Šifrované pole má neplatný formát.');
    const version = s.slice(0, colon);
    const key = keys[version];
    if (!key) throw new Error(`Neznámá verze klíče „${version}“.`);
    const buf = Buffer.from(s.slice(colon + 1), 'base64');
    if (buf.length < NONCE_BYTES + TAG_BYTES) throw new Error('Šifrované pole je příliš krátké.');
    const nonce = buf.subarray(0, NONCE_BYTES);
    const tag = buf.subarray(buf.length - TAG_BYTES);
    const ct = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Šifrované pole nelze dešifrovat (poškozená data nebo jiný klíč).');
    }
  }

  function hmacEmail(email) {
    const normalized = String(email ?? '').trim().toLowerCase();
    return crypto.createHmac('sha256', hmacKey).update(normalized).digest('hex');
  }

  function isEncrypted(value) {
    return typeof value === 'string' && /^k\d+:[A-Za-z0-9+/]+=*$/.test(value);
  }

  return { enc, dec, hmacEmail, isEncrypted, keyVersion: KEY_VERSION };
}

/** Normalizace e-mailu stejná jako v hmacEmail (pro porovnání / uložení). */
function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

module.exports = { createFieldCrypto, normalizeEmail, KEY_VERSION };
