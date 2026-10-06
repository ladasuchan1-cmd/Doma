'use strict';
// Testy src/http/ratelimit.js – token bucket.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter, PROFILES } = require('../src/http/ratelimit');

test('ratelimit: profily podle SPEC', () => {
  assert.deepEqual(PROFILES.public, { limit: 300, windowMs: 15 * 60 * 1000 });
  assert.deepEqual(PROFILES.reservation, { limit: 60, windowMs: 15 * 60 * 1000 });
  assert.deepEqual(PROFILES.login, { limit: 10, windowMs: 15 * 60 * 1000 });
  assert.deepEqual(PROFILES.api, { limit: 120, windowMs: 60 * 1000 });
});

test('ratelimit: login 10 požadavků projde, 11. je odmítnut, po čase se doplní', () => {
  const rl = createRateLimiter();
  const now = 1_700_000_000_000;
  for (let i = 0; i < 10; i++) assert.equal(rl.consume('1.2.3.4', 'login', now).allowed, true, `pokus ${i + 1}`);
  const denied = rl.consume('1.2.3.4', 'login', now);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSec >= 1 && denied.retryAfterSec <= 90, `retryAfter ${denied.retryAfterSec}`);
  // jiná IP a jiný klíč nejsou dotčeny
  assert.equal(rl.consume('5.6.7.8', 'login', now).allowed, true);
  assert.equal(rl.consume('1.2.3.4', 'public', now).allowed, true);
  // po 90 s se doplní jeden token (15 min / 10)
  assert.equal(rl.consume('1.2.3.4', 'login', now + 90_000).allowed, true);
  assert.equal(rl.consume('1.2.3.4', 'login', now + 90_000).allowed, false);
  // po celém okně (od posledního odběru) plná kapacita
  for (let i = 0; i < 10; i++) assert.equal(rl.consume('1.2.3.4', 'login', now + 30 * 60_000).allowed, true, `po okně ${i + 1}`);
  assert.equal(rl.consume('1.2.3.4', 'login', now + 30 * 60_000).allowed, false);
  rl.reset('1.2.3.4', 'login');
  assert.equal(rl.consume('1.2.3.4', 'login', now + 30 * 60_000).allowed, true);
});

test('ratelimit: neznámý profil se chová jako public', () => {
  const rl = createRateLimiter();
  assert.equal(rl.consume('1.1.1.1', 'neznamy', 0).limit, 300);
});
