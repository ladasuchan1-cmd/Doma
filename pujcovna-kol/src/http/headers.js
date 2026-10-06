'use strict';
// Bezpečnostní hlavičky (SPEC kap. 3) – nastavují se na každou odpověď. HSTS jen za proxy / na https.
// Žádná hlavička Server / X-Powered-By (node:http ji sám neposílá).
// Vstup: res, { secure }. Výstup: nastavené hlavičky; export konstanty CSP pro testy.

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data: https://*.tile.openstreetmap.fr https://tile.openstreetmap.org https://*.tile.opentopomap.org https://api.mapy.cz",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https://payments.comgate.cz",
  "object-src 'none'",
].join('; ');

const HSTS = 'max-age=300';

const STATIC_HEADERS = Object.freeze({
  'Content-Security-Policy': CSP,
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
});

/** Je požadavek přes HTTPS (přímo, nebo za důvěryhodnou proxy s X-Forwarded-Proto: https)? */
function isSecureRequest(req, { trustProxy = false } = {}) {
  if (req.socket && req.socket.encrypted) return true;
  if (trustProxy) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    return proto === 'https';
  }
  return false;
}

/** Nastaví bezpečnostní hlavičky na odpověď. */
function applySecurityHeaders(res, { secure = false } = {}) {
  for (const [k, v] of Object.entries(STATIC_HEADERS)) res.setHeader(k, v);
  if (secure) res.setHeader('Strict-Transport-Security', HSTS);
  res.removeHeader('X-Powered-By');
}

module.exports = { CSP, HSTS, STATIC_HEADERS, applySecurityHeaders, isSecureRequest };
