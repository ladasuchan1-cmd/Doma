'use strict';
// In-memory token bucket per „ip + klíč“ (SPEC kap. 3):
//   public 300 / 15 min · reservation 60 / 15 min · login 10 / 15 min · api 120 / min
// consume(ip, key, now) → { allowed, remaining, retryAfterSec }. Kbelík má kapacitu = limit a doplňuje se plynule
// rychlostí limit/okno. Zámek účtu po neúspěšných přihlášeních řeší feature admin v tabulce users.
// Vstup: volitelně vlastní profily (testy). Paměť: záznamy starší než 2× okno se při průchodu promažou.

const MINUTE = 60 * 1000;

const PROFILES = Object.freeze({
  public: Object.freeze({ limit: 300, windowMs: 15 * MINUTE }),
  reservation: Object.freeze({ limit: 60, windowMs: 15 * MINUTE }),
  login: Object.freeze({ limit: 10, windowMs: 15 * MINUTE }),
  api: Object.freeze({ limit: 120, windowMs: MINUTE }),
});

function createRateLimiter(profiles = PROFILES) {
  const buckets = new Map(); // `${key}|${ip}` → { tokens, updatedAt }
  let lastSweep = 0;

  function sweep(now) {
    if (now - lastSweep < MINUTE && buckets.size < 10000) return;
    lastSweep = now;
    for (const [k, b] of buckets) {
      if (now - b.updatedAt > 2 * b.windowMs) buckets.delete(k);
    }
  }

  /**
   * Odebere jeden token. Neznámý profil → public.
   * @returns {{allowed: boolean, remaining: number, retryAfterSec: number, limit: number}}
   */
  function consume(ip, key = 'public', now = Date.now()) {
    const profile = profiles[key] || profiles.public;
    const id = `${key}|${ip}`;
    sweep(now);
    let b = buckets.get(id);
    if (!b) {
      b = { tokens: profile.limit, updatedAt: now, windowMs: profile.windowMs };
      buckets.set(id, b);
    } else {
      const elapsed = Math.max(0, now - b.updatedAt);
      b.tokens = Math.min(profile.limit, b.tokens + (elapsed * profile.limit) / profile.windowMs);
      b.updatedAt = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, remaining: Math.floor(b.tokens), retryAfterSec: 0, limit: profile.limit };
    }
    const msPerToken = profile.windowMs / profile.limit;
    const retryAfterSec = Math.max(1, Math.ceil(((1 - b.tokens) * msPerToken) / 1000));
    return { allowed: false, remaining: 0, retryAfterSec, limit: profile.limit };
  }

  /** Vrátí token (např. po úspěšném přihlášení se neúspěchy nepočítají). */
  function reset(ip, key) {
    buckets.delete(`${key}|${ip}`);
  }

  return { consume, reset, size: () => buckets.size, profiles };
}

module.exports = { PROFILES, createRateLimiter };
