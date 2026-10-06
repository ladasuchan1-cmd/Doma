'use strict';
// Kontext požadavku ctx (SPEC kap. 3): req, res, tenant, db, theme, url, params, query, body, cookies, session,
// adminSession, csrfToken(), ip, render(), redirect(), json(), html(), notFound(), log, settings, requestId.
// Tělo (application/x-www-form-urlencoded nebo JSON) čte readBody() s limitem 256 KB → 413; jiný typ → 415.
// Odpovědi send()/html()/json()/text() se u textových typů od 1 KB komprimují gzip/brotli podle Accept-Encoding
// (stejně jako statika) a nesou Vary: Accept-Encoding.
// Vstup: { req, res, app, tenant, db, theme, params, opts, log, requestId, secure, ip }. Výstup: ctx.

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { createSession, parseCookies, serializeCookie, appendSetCookie } = require('./session');
const { HttpError } = require('./errors');
const { isCompressible, pickEncoding } = require('./static');
const { getSettings } = require('../tenants');
const { isHtml } = require('../render/html');

const COMPRESS_MIN_BYTES = 1024;

/**
 * Zkomprimuje tělo odpovědi podle Accept-Encoding (br > gzip), je-li typ textový a tělo dost velké.
 * Synchronně – dynamické stránky mají desítky KB, komprese trvá jednotky ms. Vrací { body, encoding|null }.
 */
function compressBody(buf, { acceptEncoding, contentType }) {
  if (!buf || buf.length < COMPRESS_MIN_BYTES || !isCompressible(contentType)) return { body: buf, encoding: null };
  const encoding = pickEncoding(acceptEncoding);
  if (encoding === 'br') return { body: zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }), encoding };
  if (encoding === 'gzip') return { body: zlib.gzipSync(buf, { level: 6 }), encoding };
  return { body: buf, encoding: null };
}

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

function limitText(limitBytes) {
  return limitBytes >= 1024 * 1024 ? `${Math.round((limitBytes / (1024 * 1024)) * 10) / 10} MB` : `${Math.round(limitBytes / 1024)} KB`;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * multipart/form-data (jen u rout s opts.multipart, např. nahrání loga v průvodci). Textová pole → string, soubory →
 * { filename, type, data: Buffer }; prázdné souborové pole → ''. Nejvýš 100 částí; poškozený formát → 400.
 */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
  const bad = () => new HttpError(400, 'Formulář se nepodařilo přečíst. Zkuste ho odeslat znovu.');
  if (!m) throw bad();
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const delimiter = Buffer.concat([Buffer.from('\r\n'), boundary]);
  const out = {};
  let pos = buf.indexOf(boundary);
  if (pos !== 0) throw bad();
  for (let parts = 0; ; parts++) {
    if (parts > 100) throw bad();
    pos += boundary.length;
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break; // „--“ = konec
    if (buf[pos] !== 0x0d || buf[pos + 1] !== 0x0a) throw bad();
    pos += 2;
    const headEnd = buf.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) throw bad();
    const head = buf.toString('utf8', pos, headEnd);
    const next = buf.indexOf(delimiter, headEnd + 4);
    if (next < 0) throw bad();
    const data = buf.subarray(headEnd + 4, next);
    const disp = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(head);
    const name = disp && /\bname="([^"]*)"/i.exec(disp[1]);
    if (name && !FORBIDDEN_KEYS.has(name[1])) {
      const filename = /\bfilename="([^"]*)"/i.exec(disp[1]);
      const ctype = /content-type:\s*([^\r\n;]+)/i.exec(head);
      let value;
      if (filename) value = filename[1] === '' && data.length === 0 ? '' : { filename: filename[1], type: ctype ? ctype[1].trim().toLowerCase() : 'application/octet-stream', data: Buffer.from(data) };
      else value = data.toString('utf8');
      const key = name[1];
      if (Object.hasOwn(out, key)) out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
      else out[key] = value;
    }
    pos = next + 2;
  }
  return out;
}

/** Načte a rozparsuje tělo požadavku (urlencoded, JSON; multipart jen s opts.multipart). */
async function readBody(req, { limitBytes, multipart = false }) {
  const method = req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return {};
  const rawType = String(req.headers['content-type'] || '');
  const type = rawType.split(';')[0].trim().toLowerCase();
  const declared = Number(req.headers['content-length']);
  const tooBig = () => new HttpError(413, `Odeslaná data jsou příliš velká (limit ${limitText(limitBytes)}).`);
  if (Number.isFinite(declared) && declared > limitBytes) throw tooBig();
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw tooBig();
    chunks.push(chunk);
  }
  if (!size) return {};
  if (type === 'multipart/form-data' && multipart) return parseMultipart(Buffer.concat(chunks), rawType);
  const text = Buffer.concat(chunks).toString('utf8');
  if (type === 'application/x-www-form-urlencoded' || type === '') {
    const out = {};
    for (const [k, v] of new URLSearchParams(text)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
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
  // init.config: konfigurace pro požadavek (u webu klienta s demo: false), jinak konfigurace aplikace
  const config = init.config || app.config;
  const ip = clientIp(req, { trustProxy: config.trustProxy });
  const ipHashValue = ipHash(ip, app.secret);
  let publicSession = null;
  let adminSession = null;
  let platformSession = null;
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
    // web klienta (průvodce) / náhledový provoz / povolená simulace plateb – server.js je nastaví podle tenanta
    klient: false,
    nahled: false,
    simulacePlateb: !!config.demo,
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
    get platformSession() {
      if (!platformSession) platformSession = createSession({ db, req, res, kind: 'platform', secure, ipHash: ipHashValue });
      return platformSession;
    },
    csrfToken() {
      return ctx.session.csrf();
    },
    platformCsrfToken() {
      return ctx.platformSession.csrf();
    },
    adminCsrfToken() {
      return ctx.adminSession.csrf();
    },
    async readBody() {
      ctx.body = await readBody(req, { limitBytes: ctx.routeOpts.bodyLimitBytes || config.bodyLimitBytes, multipart: !!ctx.routeOpts.multipart });
      return ctx.body;
    },
    setCookie(name, value, opts = {}) {
      appendSetCookie(res, serializeCookie(name, value, { secure: opts.secure ?? secure, ...opts }));
    },
    /** Nízkoúrovňové odeslání; textová těla komprimuje podle Accept-Encoding (Vary: Accept-Encoding). */
    send(status, headers, body) {
      if (finished) return;
      finished = true;
      let buf = body === null || body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
      res.statusCode = status;
      for (const [k, v] of Object.entries(headers || {})) if (v !== undefined) res.setHeader(k, v);
      if (buf && status !== 204 && status !== 304 && !res.getHeader('Content-Encoding')) {
        const contentType = res.getHeader('Content-Type');
        if (isCompressible(contentType)) res.setHeader('Vary', 'Accept-Encoding');
        const c = compressBody(buf, { acceptEncoding: req.headers['accept-encoding'], contentType });
        if (c.encoding) {
          res.setHeader('Content-Encoding', c.encoding);
          buf = c.body;
        }
      }
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

module.exports = { createContext, readBody, parseMultipart, clientIp, ipHash, queryObject, compressBody, COMPRESS_MIN_BYTES };
