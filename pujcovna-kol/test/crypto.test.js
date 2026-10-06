'use strict';
// Testy src/crypto/*: scrypt hesla, šifrování polí, TOTP (RFC 6238 vektory), podepsané tokeny.
const test = require('node:test');
const assert = require('node:assert/strict');
const passwords = require('../src/crypto/passwords');
const { createFieldCrypto, normalizeEmail } = require('../src/crypto/fields');
const totp = require('../src/crypto/totp');
const tokens = require('../src/crypto/tokens');

test('scrypt: formát hashe a ověření', async () => {
  const hash = passwords.hashPassword('kolo-demo-2026');
  assert.match(hash, /^scrypt\$131072\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(await passwords.verifyPassword('kolo-demo-2026', hash), true);
  assert.equal(await passwords.verifyPassword('spatne', hash), false);
  assert.equal(await passwords.verifyPassword('', hash), false);
  assert.equal(await passwords.verifyPassword('kolo-demo-2026', 'nesmysl'), false);
  assert.equal(await passwords.verifyPassword('kolo-demo-2026', null), false);
  assert.equal(passwords.verifyPasswordSync('kolo-demo-2026', hash), true);
  assert.equal(passwords.needsRehash(hash), false);
});

test('scrypt: dva hashe téhož hesla se liší (salt) a slabší parametry chtějí rehash', async () => {
  const a = passwords.hashPassword('heslo123', { N: 16384 });
  const b = passwords.hashPassword('heslo123', { N: 16384 });
  assert.notEqual(a, b);
  assert.equal(await passwords.verifyPassword('heslo123', a), true);
  assert.equal(passwords.needsRehash(a), true);
  assert.equal(passwords.parseHash('scrypt$3$8$1$aa$bb'), null, 'N musí být mocnina dvou');
});

test('fields: round-trip, formát k1:, jiný klíč selže, manipulace selže', () => {
  const fc = createFieldCrypto('tajemstvi-pro-test-dlouhe-dost-0123456789');
  const other = createFieldCrypto('jine-tajemstvi-pro-test-dlouhe-0123456789');
  const enc = fc.enc('Jana Nováková');
  assert.match(enc, /^k1:[A-Za-z0-9+/]+=*$/);
  assert.ok(!enc.includes('Nováková'));
  assert.equal(fc.dec(enc), 'Jana Nováková');
  assert.notEqual(fc.enc('Jana Nováková'), enc, 'náhodný nonce');
  assert.throws(() => other.dec(enc), /dešifrovat/);
  const tampered = enc.slice(0, -4) + (enc.endsWith('A==') ? 'B==' : 'A==');
  assert.throws(() => fc.dec(tampered));
  assert.throws(() => fc.dec('k9:AAAA'), /Neznámá verze/);
  assert.equal(fc.enc(null), null);
  assert.equal(fc.dec(null), null);
  assert.equal(fc.isEncrypted(enc), true);
  assert.equal(fc.isEncrypted('Jana'), false);
});

test('fields: hmacEmail normalizuje a je deterministický', () => {
  const fc = createFieldCrypto('tajemstvi-pro-test-dlouhe-dost-0123456789');
  const a = fc.hmacEmail('  Jana.Novakova@Example.com ');
  const b = fc.hmacEmail('jana.novakova@example.com');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, fc.hmacEmail('jiny@example.com'));
  assert.equal(normalizeEmail(' A@B.cz '), 'a@b.cz');
  assert.throws(() => createFieldCrypto('kratke'), /16 znaků/);
});

test('totp: vektory RFC 6238 (SHA-1, secret 12345678901234567890)', () => {
  const secretB32 = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secretB32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  // Příloha B RFC 6238: 8místné kódy; 6místné = posledních 6 číslic
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [t, code8] of vectors) {
    assert.equal(totp.totp(secretB32, { time: t * 1000, digits: 8 }), code8, `T=${t}`);
    assert.equal(totp.totp(secretB32, { time: t * 1000 }), code8.slice(-6));
  }
});

test('totp: verify s tolerancí ±1 krok, base32 round-trip, otpauth URL', () => {
  const secret = totp.generateSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(totp.base32Encode(totp.base32Decode(secret)), secret);
  const now = 1_700_000_000_000;
  const code = totp.totp(secret, { time: now });
  assert.equal(totp.verify(secret, code, { time: now }), 0);
  assert.equal(totp.verify(secret, code, { time: now + 30_000 }), -1);
  assert.equal(totp.verify(secret, code, { time: now - 30_000 }), 1);
  assert.equal(totp.verify(secret, code, { time: now + 61_000 }), null);
  assert.equal(totp.verify(secret, '12345', { time: now }), null);
  assert.equal(totp.verify(secret, 'abcdef', { time: now }), null);
  const url = totp.otpauthUrl({ secret, label: 'demo@ksprehledy.cz', issuer: 'Půjčovna kol' });
  assert.ok(url.startsWith('otpauth://totp/P%C5%AFj%C4%8Dovna%20kol:demo%40ksprehledy.cz?'));
  assert.ok(url.includes(`secret=${secret}`));
  assert.ok(url.includes('algorithm=SHA1') && url.includes('digits=6') && url.includes('period=30'));
});

test('tokens: sign/verify, expirace, manipulace, randomId', () => {
  const secret = 'tajemstvi-pro-tokeny-dlouhe-dost-0123456789';
  const now = 1_700_000_000_000;
  const t = tokens.sign({ r: 42 }, 90 * 24 * 3600 * 1000, secret, { now });
  assert.match(t, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const payload = tokens.verify(t, secret, { now: now + 1000 });
  assert.equal(payload.r, 42);
  assert.equal(payload.iat, now);
  assert.equal(payload.exp, now + 90 * 24 * 3600 * 1000);
  assert.equal(tokens.verify(t, secret, { now: now + 91 * 24 * 3600 * 1000 }), null, 'prošlý');
  assert.equal(tokens.verify(t, 'jine-tajemstvi-dlouhe-dost-0123456789', { now }), null, 'jiný klíč');
  const [body, sig] = t.split('.');
  assert.equal(tokens.verify(body + '.' + sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A'), secret, { now }), null, 'poškozený podpis');
  const forgedBody = Buffer.from(JSON.stringify({ r: 43, iat: now, exp: now + 1000 })).toString('base64url');
  assert.equal(tokens.verify(forgedBody + '.' + sig, secret, { now }), null, 'podstrčený payload');
  assert.equal(tokens.verify('nesmysl', secret), null);
  assert.equal(tokens.verify('', secret), null);
  const noExp = tokens.sign({ a: 1 }, null, secret, { now });
  assert.equal(tokens.verify(noExp, secret, { now: now + 1e12 }).a, 1);
  assert.throws(() => tokens.sign({ a: 1 }, -5, secret));
  const id = tokens.randomId();
  assert.equal(id.length, 43);
  assert.notEqual(tokens.randomId(), id);
  assert.match(tokens.sha256('x'), /^[0-9a-f]{64}$/);
});
