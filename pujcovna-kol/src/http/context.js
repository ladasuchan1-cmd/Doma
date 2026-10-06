'use strict';
// Kontext požadavku ctx (SPEC kap. 3): req, res, tenant, db, theme, url, params, query, body, cookies, session,
// adminSession, csrfToken(), ip, render(), redirect(), json(), html(), notFound(), log, settings, requestId.
// Tělo (application/x-www-form-urlencoded nebo JSON) čte readBody() s limitem 256 KB → 413; jiný typ → 415.
// Vstup: { req, res, app, tenant, db, theme, params, opts, log, requestId, secure, ip }. Výstup: ctx.

const crypto = require('node:crypto');
const { createSession, parseCookies, serializeCookie, appendSetCookie } = require('./session');
const { HttpError } = require('./errors');
const { getSettings } = require('../tenants');
const { isHtml } = require('../render/html');

function clientIp(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (xff.length) return xff[xff.length - 1]; // poslední = přidaný naší proxy (Caddy)
  }
  return (req.socket && req.socket.remoteAddress) || '0.0.0.0';
}

function ipHash(ip, secret) {
  return crypto.createHmac('sha256', String(secret)).update(String(ip)).digest('hex').slice(0, 32);
}

function queryObject(searchParams) {
  const out = {};
  for (const [k, v] of searchParams) out[k] = v; // poslední výskyt vyhrává
  return out;
}

/** Načte a rozparsuje tělo požadavku. */
async function readBody(req, { limitBytes }) {
  const method = req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return {};
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limitBytes) throw new HttpError(413, 'Odeslaná data jsou příliš velká (limit 256 KB).');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, 'Odeslaná data jsou příliš velká (limit 256 KB).');
    chunks.push(chunk);
  }
  if (!size) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (type === 'application/x-www-form-urlencoded' || type === '') {
    const out = {};
    for (const [k, v] of new URLSearchParams(text)) {
      if (Object.hasOwn(out, k)) out[k] = Array.isArray(out[k]) ? [...out[k], v] : [out[k], v];
      else out[k] = v;
    }
    return out;
  }
  if (type === 'application/json') {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      throw new HttpError(400, 'Tělo požadavku není platný JSON.');
    }
  }
  throw new HttpError(415, 'Nepodporovaný formát dat. Použijte formulář nebo JSON.');
}

/**
 * Vytvoří ctx.
 * @param {{req, res, app, tenant, db, theme, params?, opts?, log, requestId, secure, url}} init
 */
function createContext(init) {
  const { req, res, app, tenant, db, theme, log, requestId, secure, url } = init;
  const config = app.config;
  const ip = clientIp(req, { trustProxy: config.trustProxy });
  const ipHashValue = ipHash(ip, app.secret);
  let publicSession = null;
  let adminSession = null;
  let settingsCache = null;
  let finished = false;

  const ctx = {
    req,
    res,
    app,
    config,
    tenant,
    db,
    theme,
    url,
    params: init.params || {},
    query: queryObject(url.searchParams),
    body: {},
    cookies: parseCookies(req.headers.cookie),
    ip,
    ipHash: ipHashValue,
    secure,
    requestId,
    log,
    routeOpts: init.opts || {},
    get finished() {
      return finished;
    },
    /** Efektivní nastavení půjčovny (tenant.json + tabulka settings), cache per požadavek. */
    get settings() {
      if (!settingsCache) settingsCache = getSettings(db, tenant);
      return settingsCache;
    },
    get session() {
      if (!publicSession) publicSession = createSession({ db, req, res, kind: 'public', secure, ipHash: ipHashValue });
      return publicSession;
    },
    get adminSession() {
      if (!adminSession) adminSession = createSession({ db, req, res, kind: 'admin', secure, ipHash: ipHashValue });
      return adminSession;
    },
    csrfToken() {
      return ctx.session.csrf();
    },
    adminCsrfToken() {
      return ctx.adminSession.csrf();
    },
    async readBody() {
      ctx.body = await readBody(req, { limitBytes: config.bodyLimitBytes });
      return ctx.body;
    },
    setCookie(name, value, opts = {}) {
      appendSetCookie(res, serializeCookie(name, value, { secure: opts.secure ?? secure, ...opts }));
    },
    /** Nízkoúrovňové odeslání. */
    send(status, headers, body) {
      if (finished) return;
      finished = true;
      const buf = body === null || body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
      res.statusCode = status;
      for (const [k, v] of Object.entries(headers || {})) if (v !== undefined) res.setHeader(k, v);
      if (buf) res.setHeader('Content-Length', String(buf.length));
      if (req.method === 'HEAD' || !buf) res.end();
      else res.end(buf);
    },
    html(string, status = 200) {
      ctx.send(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, String(string));
    },
    json(obj, status = 200) {
      ctx.send(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(obj));
    },
    text(string, status = 200, type = 'text/plain; charset=utf-8') {
      ctx.send(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }, String(string));
    },
    redirect(location, status = 303) {
      const loc = String(location || '/');
      // jen relativní cesty nebo absolutní URL na náš host – ochrana před open redirect
      const safe = loc.startsWith('/') && !loc.startsWith('//') ? loc : '/';
      ctx.send(status, { Location: safe, 'Cache-Control': 'no-store' }, null);
    },
    /**
     * Vyrenderuje stránku v layoutu. pageFn(data, ctx) vrací Html (tělo) nebo { title, body, description, jsonLd, canonicalPath }.
     * @param {Function} pageFn
     * @param {object} data
     * @param {{status?: number, title?: string, feature?: string, description?: string, jsonLd?: object, canonicalPath?: string, noindex?: boolean}} [opts]
     */
    render(pageFn, data = {}, opts = {}) {
      const { layout } = require('../render/layout');
      const page = typeof pageFn === 'function' ? pageFn(data, ctx) : pageFn;
      const spec = isHtml(page) || typeof page === 'string' ? { body: page } : page || {};
      const out = layout(ctx, {
        title: opts.title || spec.title || '',
        description: opts.description || spec.description || '',
        body: spec.body,
        feature: opts.feature || spec.feature || ctx.routeOpts.feature,
        jsonLd: opts.jsonLd || spec.jsonLd || null,
        canonicalPath: opts.canonicalPath || spec.canonicalPath,
        noindex: opts.noindex || spec.noindex || false,
        bodyClass: opts.bodyClass || spec.bodyClass || '',
      });
      ctx.html(out, opts.status || 200);
    },
    notFound(message) {
      throw new HttpError(404, message || 'Stránka nenalezena.');
    },
    /** Vrátí relativní cestu, nebo fallback (pro parametr „zpet“). */
    safePath(value, fallback = '/') {
      const s = String(value || '');
      return s.startsWith('/') && !s.startsWith('//') && !/[\r\n]/.test(s) ? s : fallback;
    },
  };
  return ctx;
}

module.exports = { createContext, readBody, clientIp, ipHash, queryObject };
