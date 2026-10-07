'use strict';
// Přihlášení přes Cloudflare Access (Zero Trust) – jako ostatní aplikace na ksprehledy.cz.
//
// Kolomapa stojí za Cloudflare (tunel nebo proxy). Cloudflare Access ověří e-mail (jen @koloshop.cz) a každému
// propuštěnému požadavku přidá podepsaný JWT v hlavičce Cf-Access-Jwt-Assertion (a v cookie CF_Authorization).
// Server JWT ověřuje sám – kdo by Cloudflare obešel a šel na server přímo, bez platného tokenu nic nedostane:
//   - podpis RS256 veřejným klíčem týmu z https://<tým>.cloudflareaccess.com/cdn-cgi/access/certs (JWKS),
//   - vydavatel (iss) = https://<tým>.cloudflareaccess.com,
//   - aplikace (aud) = AUD tag aplikace Kolomapa v Cloudflare Access (token pro jinou aplikaci týmu neplatí),
//   - platnost (exp, nbf) s tolerancí minuty,
//   - e-mail podle pravidel KOLOMAPA_CF_ACCESS_EMAILS („@koloshop.cz“ = celá doména, nebo konkrétní adresy).
// Bez závislostí: veřejný klíč z JWK i ověření podpisu umí node:crypto.

const crypto = require('node:crypto');

const CLOCK_SKEW_S = 60;
const KEYS_TTL_MS = 60 * 60 * 1000; // klíče týmu se obnovují po hodině (Cloudflare je střídá zhruba po 6 týdnech)
const REFETCH_MIN_MS = 60 * 1000; // neznámé „kid“ → znovu stáhnout nejvýš jednou za minutu
const RETRY_EMPTY_MS = 5 * 1000; // klíče se ještě nikdy nepodařilo stáhnout → další pokus nejdřív za 5 s
const LOGOUT_PATH = '/cdn-cgi/access/logout';

/**
 * Tým Cloudflare Access → doména týmu. „bold-dust-a2b5“, „bold-dust-a2b5.cloudflareaccess.com“ i
 * „https://bold-dust-a2b5.cloudflareaccess.com/“ → „bold-dust-a2b5.cloudflareaccess.com“; nesmysl → null.
 * @param {string|null|undefined} team
 * @returns {string|null}
 */
function teamDomain(team) {
  let t = String(team || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!t) return null;
  if (!t.includes('.')) t += '.cloudflareaccess.com';
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(t) ? t : null;
}

/**
 * „@koloshop.cz, jan@firma.cz“ → ['@koloshop.cz', 'jan@firma.cz'] (malými písmeny). Pravidlo „@doména“ pustí celou
 * doménu (přesně – ne poddomény ani „evilkoloshop.cz“), jinak jen celou adresu. „koloshop.cz“ bez zavináče = doména.
 * @param {string|null|undefined} src
 * @returns {string[]}
 */
function parseEmailRules(src) {
  const out = [];
  for (let r of String(src || '').split(/[\s,;]+/)) {
    r = r.trim().toLowerCase();
    if (!r) continue;
    if (!r.includes('@')) r = '@' + r;
    if (/^[^@\s]*@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(r) && !out.includes(r)) out.push(r);
  }
  return out;
}

/** Je e-mail povolený pravidly? Prázdná pravidla = rozhoduje jen politika v Cloudflare Access. */
function emailAllowed(email, rules) {
  if (!rules.length) return true;
  const e = String(email || '')
    .trim()
    .toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(e)) return false;
  return rules.some((r) => (r.startsWith('@') ? e.endsWith(r) : e === r));
}

/** Hodnota cookie z hlavičky Cookie. */
function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Token z požadavku: hlavička Cf-Access-Jwt-Assertion (přidává Cloudflare), jinak cookie CF_Authorization. */
function tokenFromRequest(req) {
  const h = req.headers['cf-access-jwt-assertion'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  return cookieValue(req.headers.cookie, 'CF_Authorization');
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/**
 * Ověřovač tokenů Cloudflare Access.
 * @param {{team: string, aud: string, emails?: string, fetchImpl?: Function, now?: () => number, log?: object}} o
 *   team = tým (bold-dust-a2b5), aud = AUD tag aplikace (víc oddělených čárkou), emails = povolené e-maily/domény.
 * @returns {{verify: (token: string) => Promise<{ok: boolean, status?: number, reason?: string, email?: string|null, name?: string|null}>,
 *   refresh: () => Promise<number>, issuer: string, certsUrl: string, auds: string[], rules: string[], logoutPath: string}}
 */
function createAccessVerifier({ team, aud, emails, fetchImpl = globalThis.fetch, now = () => Date.now(), log } = {}) {
  const domain = teamDomain(team);
  if (!domain) throw new Error(`Cloudflare Access: neplatný tým „${team || ''}“ (čekám např. bold-dust-a2b5)`);
  const auds = String(aud || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!auds.length) throw new Error('Cloudflare Access: chybí AUD tag aplikace (KOLOMAPA_CF_ACCESS_AUD)');
  const issuer = `https://${domain}`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  const rules = parseEmailRules(emails);

  let keys = new Map(); // kid → KeyObject
  let fetchedAt = 0;
  let lastTry = -Infinity;
  let inflight = null;

  /** Stáhne klíče týmu (JWKS). Vrací počet klíčů; při chybě vyhodí výjimku a ponechá dosavadní klíče. */
  function refresh() {
    if (inflight) return inflight;
    lastTry = now();
    inflight = (async () => {
      const res = await fetchImpl(certsUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const next = new Map();
      for (const jwk of Array.isArray(body && body.keys) ? body.keys : []) {
        if (!jwk || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
        try {
          next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
        } catch {
          /* poškozený klíč přeskočit */
        }
      }
      if (!next.size) throw new Error('odpověď neobsahuje žádný klíč RSA');
      keys = next;
      fetchedAt = now();
      return next.size;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function keyFor(kid) {
    const t = now();
    const stale = !fetchedAt || t - fetchedAt > KEYS_TTL_MS;
    const wait = fetchedAt ? REFETCH_MIN_MS : RETRY_EMPTY_MS;
    if ((stale || !keys.has(kid)) && t - lastTry >= wait) {
      try {
        await refresh();
      } catch (e) {
        if (!keys.size) throw e;
        log?.warn?.(`Cloudflare Access: klíče týmu nejde obnovit (${e.message}) – ověřuji dosavadními`);
      }
    } else if (!keys.size && inflight) {
      await inflight.catch(() => {});
    }
    if (!keys.size) throw new Error(fetchedAt ? 'žádný klíč' : 'klíče týmu zatím nejsou stažené');
    return keys.get(kid) || null;
  }

  const deny = (reason, extra) => ({ ok: false, status: 403, reason, ...extra });

  /**
   * Ověří token. ok → {ok: true, email, name}; jinak {ok: false, status (403, 503 = klíče nejde stáhnout), reason}.
   * @param {string} token
   */
  async function verify(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return deny('neplatný token');
    let header;
    let payload;
    try {
      header = b64json(parts[0]);
      payload = b64json(parts[1]);
    } catch {
      return deny('neplatný token');
    }
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') return deny('nepodporovaný podpis tokenu');
    if (!payload || typeof payload !== 'object') return deny('neplatný token');
    let key;
    try {
      key = await keyFor(header.kid);
    } catch (e) {
      return { ok: false, status: 503, reason: `klíče Cloudflare Access nejde stáhnout (${e.message})` };
    }
    if (!key) return deny('token je podepsaný neznámým klíčem');
    let sigOk = false;
    try {
      sigOk = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    } catch {
      sigOk = false;
    }
    if (!sigOk) return deny('podpis tokenu nesedí');
    if (payload.iss !== issuer) return deny('token vydal jiný tým Cloudflare Access');
    const tokenAud = (Array.isArray(payload.aud) ? payload.aud : [payload.aud]).map((a) => String(a).toLowerCase());
    if (!tokenAud.some((a) => auds.includes(a))) return deny('token je pro jinou aplikaci');
    const t = now() / 1000;
    if (!(Number(payload.exp) > t - CLOCK_SKEW_S)) return deny('přihlášení vypršelo');
    if (payload.nbf != null && !(Number(payload.nbf) <= t + CLOCK_SKEW_S)) return deny('token ještě neplatí');
    const email = typeof payload.email === 'string' && payload.email.trim() ? payload.email.trim().toLowerCase() : null;
    if (rules.length && !emailAllowed(email, rules)) {
      return deny(email ? `e-mail ${email} nemá do Kolomapy přístup` : 'přihlášení bez e-mailu nemá do Kolomapy přístup', { email });
    }
    const name = email || (typeof payload.common_name === 'string' ? payload.common_name : null) || (typeof payload.sub === 'string' ? payload.sub : null);
    return { ok: true, email, name };
  }

  return { verify, refresh, issuer, certsUrl, auds, rules, logoutPath: LOGOUT_PATH };
}

module.exports = { createAccessVerifier, teamDomain, parseEmailRules, emailAllowed, tokenFromRequest, cookieValue, LOGOUT_PATH };
