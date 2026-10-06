'use strict';
// Ochrana proti CSRF (SPEC kap. 3): synchronizer token per session (hidden input _csrf nebo hlavička X-CSRF-Token)
// + u každého POST/PUT/PATCH/DELETE kontrola původu: hlavička Origin musí odpovídat hostu, nebo Sec-Fetch-Site
// ∈ {same-origin, none}. Chybí-li obě hlavičky, požadavek odmítneme (prohlížeče je u formulářů posílají vždy).
// Vstup: ctx (req, body, session, host). Výstup: verify(ctx) vyhodí HttpError 403 s českou hláškou.

const { safeEqual } = require('../crypto/tokens');
const { HttpError } = require('./errors');

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TOKEN_FIELD = '_csrf';
const TOKEN_HEADER = 'x-csrf-token';

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Ověří původ požadavku. Vrací { ok: true } nebo { ok: false, reason }.
 * @param {object} req
 * @param {string} host hodnota hlavičky Host požadavku (s portem)
 */
function checkOrigin(req, host) {
  const origin = req.headers.origin;
  const expected = String(host || '').toLowerCase();
  if (origin && origin !== 'null') {
    const h = hostOf(origin);
    if (h && h === expected) return { ok: true };
    return { ok: false, reason: 'origin_mismatch' };
  }
  const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (sfs === 'same-origin' || sfs === 'none') return { ok: true };
  if (sfs) return { ok: false, reason: 'cross_site' };
  if (origin === 'null') return { ok: false, reason: 'origin_null' };
  return { ok: false, reason: 'no_origin' };
}

/** Vytáhne token z těla (_csrf) nebo hlavičky (X-CSRF-Token). */
function extractToken(ctx) {
  const fromBody = ctx.body && typeof ctx.body === 'object' ? ctx.body[TOKEN_FIELD] : undefined;
  if (typeof fromBody === 'string' && fromBody) return fromBody;
  const fromHeader = ctx.req.headers[TOKEN_HEADER];
  if (typeof fromHeader === 'string' && fromHeader) return fromHeader;
  return null;
}

/**
 * Ověří CSRF u nebezpečné metody: původ + token oproti session (public, nebo admin, pokud opts.sessionKind = 'admin').
 * Bezpečné metody (GET/HEAD/OPTIONS) projdou vždy.
 */
function verify(ctx, { sessionKind = 'public' } = {}) {
  if (!UNSAFE_METHODS.has(ctx.req.method)) return;
  const origin = checkOrigin(ctx.req, ctx.req.headers.host);
  if (!origin.ok) {
    throw new HttpError(403, 'Požadavek byl odeslán z jiné stránky nebo bez údaje o původu. Zkuste formulář odeslat znovu.', { reason: origin.reason });
  }
  const session = sessionKind === 'admin' ? ctx.adminSession : ctx.session;
  const expected = session ? session.peekCsrf() : null;
  const provided = extractToken(ctx);
  if (!expected || !provided || !safeEqual(provided, expected)) {
    throw new HttpError(403, 'Formulář vypršel nebo chybí bezpečnostní token. Načtěte stránku znovu a odešlete formulář ještě jednou.', {
      reason: expected ? 'token_mismatch' : 'no_session',
    });
  }
}

module.exports = { verify, checkOrigin, extractToken, TOKEN_FIELD, TOKEN_HEADER, UNSAFE_METHODS };
