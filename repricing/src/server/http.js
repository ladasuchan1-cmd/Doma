'use strict';
// Minimalistický HTTP framework nad node:http (SPEC §8 server/http.js).
//
// ── Router ─────────────────────────────────────────────────────────────────────────────────────────────
//   const router = createRouter();
//   router.get('/api/v1/products/:id', handler, { auth: 'read' });
//   router.get('/feed/:name.:ext(xml|json|csv)', handler, { auth: 'export' });
//   Vzory: ':param' (segment bez '/'), ':param(regex)' (vlastní omezení), víc parametrů v segmentu
//   ('changes.:format'), '*' jako poslední segment (zbytek cesty → params['*']).
//   Při shodě více vzorů vyhrává specifičtější (literál > literál+parametr > parametr > '*'), pak dřívější registrace.
//   HEAD se automaticky obslouží GET routou (bez těla). Cesta se shoduje bez koncového lomítka.
//   Volba auth: 'public' | 'any' (jakékoli přihlášení/token) | 'read' (výchozí) | 'import' | 'export' | 'admin'
//               | pole rozsahů (stačí kterýkoli). Další volby: maxBodyMb (přebije config.maxBodyMb).
//
// ── Handler ────────────────────────────────────────────────────────────────────────────────────────────
//   async (ctx) => result
//   ctx = { req, res, db, config, log, method, path, params, query, queryAll, body, rawBody, bodyType, contentType,
//           user, scopes, via, token, ip, now, status, route, settings(), audit({action, entity, entity_id, detail}),
//           setHeader(name, value) }
//   - params: řetězce (dekódované). Pro číselné ID použijte intParam(ctx, 'id').
//   - query: objekt, opakovaný klíč → poslední hodnota; queryAll: {klíč: [hodnoty]}. Parametr 'token' je odstraněn.
//   - rawBody: Buffer (vždy; prázdný Buffer, když tělo chybí). Pro importy souborů VŽDY používejte rawBody.
//   - body (líně parsováno při prvním přístupu):
//       application/json, *+json          → JSON (neplatný JSON → HttpError 400 při přístupu k ctx.body)
//       text/*, */xml, *+xml, */csv       → string (dekódováno dle charset / XML deklarace)
//       x-www-form-urlencoded / bez typu  → JSON, pokud tělo začíná '{' nebo '[' a jde parsovat; jinak objekt
//                                           z formuláře (urlencoded) nebo string (bez typu; binární data → Buffer)
//       cokoli jiného (xlsx, octet-stream, zip …) → Buffer (= rawBody)
//       prázdné tělo                      → {} (bezpečná destrukturalizace)
//     bodyType: 'empty' | 'json' | 'text' | 'form' | 'raw'.
//   - Tělo požadavku může být komprimované (Content-Encoding: gzip | deflate | br) – rozbalí se automaticky.
//
//   Návratová hodnota handleru:
//     objekt / pole / číslo / null       → JSON, status ctx.status ?? 200
//     undefined                          → pokud už handler odpověděl (sendJson/sendBuffer/…), nic; jinak 204
//     string                             → text/plain; charset=utf-8
//     Buffer / Uint8Array                → application/octet-stream
//     Readable stream                    → proud (application/octet-stream, není-li nastaveno jinak)
//     raw({status, headers, body, contentType, filename}) → přesně řízená odpověď ({__raw: true, …})
//   Chyby: throw new HttpError(status, 'Česká zpráva', details?) → {error: {status, message, details}}.
//   Neznámé chyby → 500 „Interní chyba serveru“ (stack do logu).
//
// ── Odpovědi ───────────────────────────────────────────────────────────────────────────────────────────
//   Gzip pro komprimovatelné typy > 2 KB, když to klient povolí (Accept-Encoding). Bezpečnostní hlavičky vždy.
//   Odpovědi /api/* a /feed/* mají výchozí Cache-Control: no-store (handler může přepsat).

const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream');
const { getSettings, audit: dbAudit } = require('../db');
const defaultLog = require('../util/log');
const { isCompressible, serveStatic } = require('./static');
const authModule = require('./auth');

const gzipAsync = promisify(zlib.gzip);
const GZIP_MIN_BYTES = 2048;
const EMPTY = Buffer.alloc(0);
const ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const API_PREFIXES = ['/api/', '/feed/'];

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

const STATUS_MESSAGES = {
  400: 'Neplatný požadavek.',
  401: 'Nepřihlášeno.',
  403: 'Přístup odepřen.',
  404: 'Nenalezeno.',
  405: 'Metoda není povolena.',
  408: 'Vypršel čas požadavku.',
  409: 'Konflikt s aktuálním stavem dat.',
  413: 'Tělo požadavku je příliš velké.',
  415: 'Nepodporovaný typ obsahu.',
  422: 'Data nelze zpracovat.',
  429: 'Příliš mnoho požadavků, zkuste to později.',
  500: 'Interní chyba serveru',
  502: 'Chyba vzdáleného serveru.',
  503: 'Služba je dočasně nedostupná.',
  504: 'Vzdálený server neodpověděl včas.',
};

// Chyby jiných modulů, které znamenají chybný vstup od klienta (→ 400 s jejich zprávou).
const CLIENT_ERROR_NAMES = new Set([
  'FilterError',
  'XmlError',
  'CsvError',
  'ZipError',
  'XlsxError',
  'ValidationError',
  'MappingError',
  'ImportError',
  'ConfigError',
  'StrategyError',
]);

// ---------------------------------------------------------------------------------------------------------
// Chyby

class HttpError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} [message] česká zpráva pro uživatele
   * @param {*} [details] strukturované podrobnosti (např. seznam chyb validace)
   * @param {{headers?: Record<string, string|number>}} [opts] hlavičky přidané k chybové odpovědi
   */
  constructor(status = 500, message, details, opts = {}) {
    const st = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
    super(message || STATUS_MESSAGES[st] || 'Chyba');
    this.name = 'HttpError';
    this.status = st;
    this.details = details === undefined ? null : details;
    this.expose = st < 500;
    this.headers = opts.headers || null;
  }
}

/** Převede libovolnou chybu na HttpError (neznámé → 500). */
function toHttpError(err, { exposeInternal = false } = {}) {
  if (err instanceof HttpError) return err;
  if (err && err.name === 'HttpError' && Number.isInteger(err.status)) {
    return new HttpError(err.status, err.message, err.details, { headers: err.headers });
  }
  if (err && err.expose === true && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    return new HttpError(err.status, err.message, err.details ?? err.errors);
  }
  if (err && CLIENT_ERROR_NAMES.has(err.name)) {
    const details = err.details ?? err.errors ?? (err.line != null ? { line: err.line, column: err.column } : null);
    return new HttpError(400, err.message || STATUS_MESSAGES[400], details);
  }
  if (err instanceof SyntaxError && /JSON/i.test(err.message)) {
    return new HttpError(400, 'Neplatný JSON.', { message: err.message });
  }
  if (err && err.code === 'ERR_SQLITE_ERROR') {
    if (/constraint failed/i.test(err.message)) {
      return new HttpError(409, 'Operace je v konfliktu s existujícími daty (omezení databáze).', { message: err.message });
    }
    if (/database is locked|SQLITE_BUSY/i.test(err.message)) {
      return new HttpError(503, 'Databáze je právě zaneprázdněná, zkuste to prosím znovu.', null, { headers: { 'Retry-After': 5 } });
    }
  }
  const e = new HttpError(500, STATUS_MESSAGES[500], exposeInternal && err && err.message ? { message: err.message } : null);
  return e;
}

// ---------------------------------------------------------------------------------------------------------
// Router

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Zkompiluje vzor cesty na regulární výraz. */
function compilePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.startsWith('/')) {
    throw new TypeError(`Vzor cesty musí začínat '/': ${pattern}`);
  }
  const p = pattern.length > 1 ? pattern.replace(/\/+$/, '') : pattern;
  const segs = p === '/' ? [] : p.slice(1).split('/');
  const keys = [];
  const score = [];
  let re = '';
  segs.forEach((seg, i) => {
    if (seg === '*') {
      if (i !== segs.length - 1) throw new TypeError(`'*' smí být jen posledním segmentem: ${pattern}`);
      keys.push('*');
      score.push(0);
      re += '(?:/(.*))?';
      return;
    }
    const tokenRe = /:([A-Za-z_][A-Za-z0-9_]*)(\((?:[^()\\]|\\.)+\))?/g;
    let out = '';
    let last = 0;
    let hasParam = false;
    let hasLit = false;
    let m;
    while ((m = tokenRe.exec(seg))) {
      if (m.index > last) {
        out += escapeRe(seg.slice(last, m.index));
        hasLit = true;
      }
      if (keys.includes(m[1])) throw new TypeError(`Parametr '${m[1]}' je ve vzoru dvakrát: ${pattern}`);
      keys.push(m[1]);
      hasParam = true;
      const custom = m[2] ? m[2].slice(1, -1) : null;
      const isLastInSeg = tokenRe.lastIndex === seg.length;
      out += '(' + (custom ? `(?:${custom})` : isLastInSeg ? '[^/]+' : '[^/]+?') + ')';
      last = tokenRe.lastIndex;
    }
    if (last < seg.length) {
      out += escapeRe(seg.slice(last));
      hasLit = true;
    }
    re += '/' + out;
    score.push(hasParam ? (hasLit ? 2 : 1) : 3);
  });
  return { regex: new RegExp('^' + (re || '/') + '$'), keys, score };
}

function compareScore(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

function validateAuthOption(auth, pattern) {
  const ok = (v) => authModule.AUTH_LEVELS.includes(v);
  if (Array.isArray(auth) ? auth.length && auth.every((v) => authModule.SCOPES.includes(v)) : ok(auth)) return;
  throw new TypeError(`Neplatná volba auth '${JSON.stringify(auth)}' pro ${pattern} (povoleno: ${authModule.AUTH_LEVELS.join(', ')} nebo pole rozsahů)`);
}

/**
 * Vytvoří router.
 * @param {{log?: object}} [opts]
 */
function createRouter({ log = defaultLog } = {}) {
  const routes = [];

  function add(method, pattern, handler, opts = {}) {
    const m = String(method).toUpperCase();
    if (m !== '*' && !ROUTE_METHODS.includes(m)) throw new TypeError(`Nepodporovaná metoda ${method}`);
    if (typeof handler !== 'function') throw new TypeError(`Handler pro ${m} ${pattern} musí být funkce`);
    const options = { ...(opts || {}) };
    const auth = options.auth === undefined ? 'read' : options.auth;
    validateAuthOption(auth, pattern);
    const compiled = compilePattern(pattern);
    const dup = routes.find((r) => r.method === m && r.regex.source === compiled.regex.source);
    if (dup) {
      // První registrace vyhrává (např. auth modul registruje /settings/password dřív než modul settings).
      log.warn(`Route ${m} ${pattern} je už zaregistrovaná (${dup.pattern}) – druhá registrace se ignoruje.`);
      return api;
    }
    routes.push({ method: m, pattern, handler, auth, opts: options, ...compiled, index: routes.length });
    return api;
  }

  /**
   * Najde routu. @returns {{route: object|null, params: object|null, allowed: string[]}}
   * (allowed = metody, které pro tuto cestu existují, když metoda nesedí → 405)
   */
  function match(method, path) {
    const m = String(method).toUpperCase();
    let best = null;
    let bestExec = null;
    const allowed = new Set();
    for (const r of routes) {
      const ex = r.regex.exec(path);
      if (!ex) continue;
      const methodOk = r.method === '*' || r.method === m || (m === 'HEAD' && r.method === 'GET');
      if (!methodOk) {
        allowed.add(r.method);
        continue;
      }
      if (!best || compareScore(r.score, best.score) > 0) {
        best = r;
        bestExec = ex;
      }
    }
    if (!best) return { route: null, params: null, allowed: [...allowed] };
    const params = {};
    best.keys.forEach((k, i) => {
      const v = bestExec[i + 1];
      if (v === undefined) return;
      try {
        params[k] = decodeURIComponent(v);
      } catch {
        throw new HttpError(400, `Neplatné kódování parametru „${k}“ v cestě.`);
      }
    });
    return { route: best, params, allowed: [...allowed] };
  }

  const api = {
    add,
    get: (p, h, o) => add('GET', p, h, o),
    post: (p, h, o) => add('POST', p, h, o),
    put: (p, h, o) => add('PUT', p, h, o),
    patch: (p, h, o) => add('PATCH', p, h, o),
    delete: (p, h, o) => add('DELETE', p, h, o),
    all: (p, h, o) => add('*', p, h, o),
    match,
    /** Seznam rout pro diagnostiku: [{method, path, auth}] */
    list: () => routes.map((r) => ({ method: r.method, path: r.pattern, auth: r.auth })),
    routes,
  };
  return api;
}

// ---------------------------------------------------------------------------------------------------------
// Pomocníci pro odpovědi

function jsonReplacer(key, value) {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  return value;
}

function acceptsGzip(header) {
  if (!header) return false;
  let gzipQ = null;
  let starQ = null;
  for (const part of String(header).split(',')) {
    const [rawName, ...params] = part.split(';');
    const name = rawName.trim().toLowerCase();
    let q = 1;
    for (const prm of params) {
      const mm = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(prm);
      if (mm) q = Number(mm[1]);
    }
    if (name === 'gzip' || name === 'x-gzip') gzipQ = q;
    else if (name === '*') starQ = q;
  }
  if (gzipQ !== null) return gzipQ > 0;
  return starQ !== null && starQ > 0;
}

function addVary(res, field) {
  const prev = res.getHeader('Vary');
  if (!prev) return res.setHeader('Vary', field);
  const list = String(prev)
    .split(',')
    .map((s) => s.trim().toLowerCase());
  if (!list.includes(field.toLowerCase()) && !list.includes('*')) res.setHeader('Vary', `${prev}, ${field}`);
}

function isStream(v) {
  return v != null && typeof v === 'object' && typeof v.pipe === 'function' && typeof v.on === 'function';
}

/**
 * Hodnota Content-Disposition s ASCII fallbackem a RFC 5987 filename* (české názvy souborů).
 * @param {string} filename
 * @param {'attachment'|'inline'} [type]
 */
function contentDisposition(filename, type = 'attachment') {
  const name = String(filename ?? 'soubor')
    .replace(/[\r\n\t\0]/g, ' ')
    .replace(/[/\\]/g, '_')
    .trim() || 'soubor';
  const ascii = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["%\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function logOf(ctx) {
  return (ctx && ctx.log) || defaultLog;
}

/**
 * Nízkoúrovňové odeslání odpovědi (všechny ostatní pomocníky volají tuto funkci). Nikdy nevyhazuje.
 * @param {object} ctx
 * @param {{status?: number, headers?: object, body?: string|Buffer|Uint8Array|object|null|import('stream').Readable,
 *          contentType?: string, filename?: string, inline?: boolean, compress?: boolean, length?: number}} opts
 * @returns {Promise<boolean>} true = odesláno
 */
async function send(ctx, opts = {}) {
  const { req, res } = ctx;
  if (ctx.responded || res.headersSent || res.writableEnded || res.destroyed) return false;
  ctx.responded = true;
  try {
    const status = opts.status ?? 200;
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) {
        if (v === undefined || v === null) continue;
        res.setHeader(k, typeof v === 'number' ? String(v) : v);
      }
    }
    if (opts.contentType) res.setHeader('Content-Type', opts.contentType);
    if (opts.filename) res.setHeader('Content-Disposition', contentDisposition(opts.filename, opts.inline ? 'inline' : 'attachment'));

    let body = opts.body;
    if (isStream(body)) return await sendStreamInternal(ctx, status, body, opts);

    let buf;
    if (body == null) buf = EMPTY;
    else if (Buffer.isBuffer(body)) buf = body;
    else if (body instanceof Uint8Array) buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    else if (typeof body === 'string') buf = Buffer.from(body, 'utf8');
    else {
      buf = Buffer.from(JSON.stringify(body, jsonReplacer), 'utf8');
      if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }

    const noBody = status === 204 || status === 304 || (status >= 100 && status < 200);
    if (noBody) {
      res.removeHeader('Content-Length');
      if (status === 204) res.removeHeader('Content-Type');
      res.writeHead(status);
      res.end();
      return true;
    }
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/octet-stream');
    const ct = res.getHeader('Content-Type');
    const compressible = isCompressible(ct);
    if (compressible) addVary(res, 'Accept-Encoding');
    if (
      opts.compress !== false &&
      req.method !== 'HEAD' &&
      compressible &&
      buf.length > GZIP_MIN_BYTES &&
      !res.getHeader('Content-Encoding') &&
      acceptsGzip(req.headers['accept-encoding'])
    ) {
      buf = await gzipAsync(buf);
      res.setHeader('Content-Encoding', 'gzip');
    }
    if (res.destroyed) return false;
    res.setHeader('Content-Length', String(buf.length));
    res.writeHead(status);
    res.end(req.method === 'HEAD' ? undefined : buf);
    return true;
  } catch (err) {
    logOf(ctx).warn('Odpověď se nepodařilo odeslat', { path: ctx.path, error: err.message });
    try {
      res.destroy();
    } catch {
      /* nic */
    }
    return false;
  }
}

async function sendStreamInternal(ctx, status, stream, opts) {
  const { req, res } = ctx;
  if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/octet-stream');
  const ct = res.getHeader('Content-Type');
  const compressible = isCompressible(ct);
  if (compressible) addVary(res, 'Accept-Encoding');
  if (req.method === 'HEAD') {
    if (opts.length != null) res.setHeader('Content-Length', String(opts.length));
    res.writeHead(status);
    res.end();
    if (typeof stream.destroy === 'function') stream.destroy();
    return true;
  }
  const gz =
    opts.compress !== false &&
    compressible &&
    !res.getHeader('Content-Encoding') &&
    (opts.length == null || opts.length > GZIP_MIN_BYTES) &&
    acceptsGzip(req.headers['accept-encoding']);
  if (gz) {
    res.setHeader('Content-Encoding', 'gzip');
    res.removeHeader('Content-Length');
  } else if (opts.length != null) {
    res.setHeader('Content-Length', String(opts.length));
  }
  res.writeHead(status);
  const chain = gz ? [stream, zlib.createGzip(), res] : [stream, res];
  await new Promise((resolve) => {
    pipeline(...chain, (err) => {
      if (err && !res.destroyed && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        logOf(ctx).warn('Chyba při streamování odpovědi', { path: ctx.path, error: err.message });
      }
      resolve();
    });
  });
  return true;
}

function normalizeOpts(opts) {
  if (typeof opts === 'number') return { status: opts };
  return opts || {};
}

/**
 * Odešle JSON. @param {object} ctx @param {*} data @param {number|{status?, headers?, pretty?}} [opts]
 */
function sendJson(ctx, data, opts) {
  const o = normalizeOpts(opts);
  const pretty = o.pretty ?? (ctx.query && (ctx.query.pretty === '1' || ctx.query.pretty === 'true'));
  const text = JSON.stringify(data === undefined ? null : data, jsonReplacer, pretty ? 2 : undefined);
  return send(ctx, { ...o, body: text, contentType: o.contentType || 'application/json; charset=utf-8' });
}

/** Odešle text. @param {{status?, headers?, contentType?, filename?}} [opts] (výchozí text/plain; charset=utf-8) */
function sendText(ctx, text, opts) {
  const o = normalizeOpts(opts);
  return send(ctx, { ...o, body: String(text ?? ''), contentType: o.contentType || 'text/plain; charset=utf-8' });
}

/**
 * Odešle Buffer (soubor ke stažení, XML feed, XLSX …).
 * @param {object} ctx
 * @param {Buffer|Uint8Array|string} buf
 * @param {{status?: number, headers?: object, contentType?: string, filename?: string, inline?: boolean, compress?: boolean}} [opts]
 *   filename → Content-Disposition: attachment (inline: true → inline) s RFC 5987 filename* pro diakritiku.
 */
function sendBuffer(ctx, buf, opts) {
  const o = normalizeOpts(opts);
  return send(ctx, { ...o, body: buf ?? EMPTY, contentType: o.contentType || 'application/octet-stream' });
}

/** Odešle proud (Readable). @param {{contentType?, filename?, length?, status?, headers?}} [opts] */
function sendStream(ctx, stream, opts) {
  const o = normalizeOpts(opts);
  return send(ctx, { ...o, body: stream });
}

/** Odešle soubor z disku (streamuje). */
async function sendFile(ctx, filePath, opts) {
  const fs = require('node:fs');
  const { mimeType } = require('./static');
  const o = normalizeOpts(opts);
  let st;
  try {
    st = await fs.promises.stat(filePath);
  } catch {
    throw new HttpError(404, 'Soubor nenalezen.');
  }
  if (!st.isFile()) throw new HttpError(404, 'Soubor nenalezen.');
  return send(ctx, { ...o, body: fs.createReadStream(filePath), length: st.size, contentType: o.contentType || mimeType(filePath) });
}

/** Přesměrování. */
function redirect(ctx, location, status = 302) {
  return send(ctx, {
    status,
    headers: { Location: location },
    body: `Přesměrováno na ${location}`,
    contentType: 'text/plain; charset=utf-8',
  });
}

/**
 * Obálka pro plně řízenou odpověď vracenou z handleru: `return raw({status: 201, body: xml, contentType: 'application/xml'})`.
 * @param {{status?: number, headers?: object, body?: *, contentType?: string, filename?: string, inline?: boolean, compress?: boolean}} opts
 */
function raw(opts = {}) {
  return { __raw: true, ...opts };
}

// ---------------------------------------------------------------------------------------------------------
// Pomocníci pro parametry

/** Kladné celé číslo z parametru cesty, jinak HttpError 400. */
function intParam(ctx, name = 'id') {
  const v = ctx.params ? ctx.params[name] : undefined;
  const n = Number(v);
  if (typeof v !== 'string' || !/^\d+$/.test(v) || !Number.isSafeInteger(n) || n <= 0) {
    throw new HttpError(400, `Neplatný parametr „${name}“ – očekáváno kladné celé číslo.`);
  }
  return n;
}

/** Celé číslo z query (s výchozí hodnotou a oříznutím do rozsahu). Nečíselná hodnota → 400. */
function queryInt(ctx, name, { def = null, min = -Infinity, max = Infinity } = {}) {
  const v = ctx.query ? ctx.query[name] : undefined;
  if (v == null || String(v).trim() === '') return def;
  const n = Number(String(v).trim());
  if (!Number.isInteger(n)) throw new HttpError(400, `Parametr „${name}“ musí být celé číslo.`);
  return Math.min(max, Math.max(min, n));
}

/** Logická hodnota z query: 1/true/yes/ano/on (i prázdná hodnota „?mark“) → true; 0/false/no/ne/off → false. */
function queryBool(ctx, name, def = false) {
  const v = ctx.query ? ctx.query[name] : undefined;
  if (v === undefined) return def;
  const s = String(v).trim().toLowerCase();
  if (s === '' || ['1', 'true', 'yes', 'ano', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'ne', 'off'].includes(s)) return false;
  return def;
}

/** Stránkování z query page/limit → {page, limit, offset}. */
function paging(ctx, { defaultLimit = 50, maxLimit = 500 } = {}) {
  const page = queryInt(ctx, 'page', { def: 1, min: 1 });
  const limit = queryInt(ctx, 'limit', { def: defaultLimit, min: 1, max: maxLimit });
  return { page, limit, offset: (page - 1) * limit };
}

// ---------------------------------------------------------------------------------------------------------
// Požadavek: URL, IP, tělo

function parseUrl(rawUrl) {
  let url = rawUrl || '/';
  if (/^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      url = u.pathname + u.search;
    } catch {
      throw new HttpError(400, 'Neplatná URL požadavku.');
    }
  }
  const q = url.indexOf('?');
  let pathname = q >= 0 ? url.slice(0, q) : url;
  const search = q >= 0 ? url.slice(q + 1) : '';
  const h = pathname.indexOf('#');
  if (h >= 0) pathname = pathname.slice(0, h);
  if (!pathname.startsWith('/')) throw new HttpError(400, 'Neplatná cesta požadavku.');
  pathname = pathname.replace(/\/{2,}/g, '/');
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  return { pathname, search };
}

function parseQuery(search) {
  const query = Object.create(null);
  const queryAll = Object.create(null);
  const sp = new URLSearchParams(search);
  for (const [k, v] of sp) {
    query[k] = v;
    (queryAll[k] ||= []).push(v);
  }
  // obyčejné objekty (ne null-prototype), ať handlery mohou volat query.hasOwnProperty apod.
  return { query: { ...query }, queryAll: { ...queryAll } };
}

/** IP klienta; za důvěryhodnou proxy poslední položka X-Forwarded-For (přidaná naší proxy). */
function clientIp(req, config) {
  if (config && config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const parts = String(xff)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    const xr = req.headers['x-real-ip'];
    if (xr) return String(xr).trim();
  }
  let ip = (req.socket && req.socket.remoteAddress) || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip || 'unknown';
}

function isApiPath(pathname) {
  return pathname === '/api' || pathname === '/feed' || API_PREFIXES.some((p) => pathname.startsWith(p));
}

class ClientAbortError extends Error {
  constructor() {
    super('Klient přerušil spojení');
    this.name = 'ClientAbortError';
    this.clientAbort = true;
  }
}

function tooLarge(limitBytes) {
  const mb = limitBytes / (1024 * 1024);
  const shown = mb >= 1 ? `${Math.round(mb * 10) / 10} MB` : `${Math.round(limitBytes / 1024)} kB`;
  return new HttpError(413, `Tělo požadavku je příliš velké (limit ${shown}).`, { limit_bytes: limitBytes }, { headers: { Connection: 'close' } });
}

/** Načte tělo požadavku do Bufferu s limitem velikosti. */
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const cl = req.headers['content-length'];
    if (cl != null && Number(cl) > limitBytes) {
      reject(tooLarge(limitBytes));
      return;
    }
    // Pozor: req.complete může být true i když data ještě leží v bufferu streamu → rozhoduje jen readableEnded.
    if (req.readableEnded) {
      resolve(EMPTY);
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('close', onClose);
      req.removeListener('error', onError);
      fn(v);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        // zbytek těla necháme zahodit (Node po odeslání odpovědi požadavek „dump“-ne; Connection: close)
        finish(reject, tooLarge(limitBytes));
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(resolve, chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size));
    const onClose = () => {
      if (!req.complete) finish(reject, new ClientAbortError());
    };
    const onError = () => finish(reject, new ClientAbortError());
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('close', onClose);
    req.on('error', onError);
  });
}

const DECOMPRESSORS = {
  gzip: promisify(zlib.gunzip),
  'x-gzip': promisify(zlib.gunzip),
  deflate: promisify(zlib.inflate),
  br: promisify(zlib.brotliDecompress),
};

async function decodeContentEncoding(req, buf, limitBytes) {
  const enc = String(req.headers['content-encoding'] || '')
    .trim()
    .toLowerCase();
  if (!enc || enc === 'identity' || !buf.length) return buf;
  const fn = DECOMPRESSORS[enc];
  if (!fn) throw new HttpError(415, `Nepodporované kódování těla požadavku: ${enc}.`);
  try {
    return await fn(buf, { maxOutputLength: Math.max(1, Math.min(limitBytes, require('node:buffer').constants.MAX_LENGTH)) });
  } catch (e) {
    if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError)) throw tooLarge(limitBytes);
    throw new HttpError(400, 'Tělo požadavku nelze dekomprimovat.', { message: e.message });
  }
}

function parseContentType(header) {
  const h = String(header || '');
  const [type, ...params] = h.split(';');
  let charset = null;
  for (const p of params) {
    const m = /^\s*charset\s*=\s*"?([^";\s]+)"?\s*$/i.exec(p);
    if (m) charset = m[1].toLowerCase();
  }
  return { type: type.trim().toLowerCase(), charset, raw: h };
}

function isJsonType(t) {
  return t === 'application/json' || t === 'text/json' || t.endsWith('+json');
}

function isTextType(t) {
  return (
    t.startsWith('text/') ||
    t === 'application/xml' ||
    t.endsWith('+xml') ||
    t === 'application/csv' ||
    t === 'application/x-csv' ||
    t === 'application/javascript' ||
    t === 'application/x-ndjson'
  );
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Dekóduje text těla: formats/decode (pokud existuje) → charset z Content-Type → UTF-8. */
function decodeText(buf, ct) {
  let decodeBuffer = null;
  try {
    ({ decodeBuffer } = require('../formats/decode'));
  } catch {
    decodeBuffer = null; // modul formátů zatím nemusí existovat
  }
  if (typeof decodeBuffer === 'function') {
    try {
      const s = decodeBuffer(buf, { contentType: ct.raw });
      if (typeof s === 'string') return stripBom(s);
    } catch {
      /* spadneme na TextDecoder */
    }
  }
  let label = ct.charset || 'utf-8';
  try {
    return stripBom(new TextDecoder(label).decode(buf));
  } catch {
    label = 'utf-8';
  }
  return stripBom(new TextDecoder(label).decode(buf));
}

function firstSignificantByte(buf) {
  let i = 0;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3;
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++;
  return i < buf.length ? buf[i] : -1;
}

function looksBinary(buf) {
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return true; // PK – zip/xlsx
  const n = Math.min(buf.length, 1024);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// Klíče „__proto__“ z těla zahodíme – obrana proti prototype pollution při následném slučování objektů.
function safeReviver(key, value) {
  return key === '__proto__' ? undefined : value;
}

// Výchozí limit JSON těla parsovaného do ctx.body (config.maxJsonMb) – hluboko pod limity V8 (security-1).
const DEFAULT_JSON_LIMIT = 32 * 1024 * 1024;

function jsonTooLarge(limit) {
  return new HttpError(
    413,
    `JSON v těle požadavku je příliš velký (limit ${Math.round((limit / 1024 / 1024) * 10) / 10} MB). Velká data posílejte jako import (POST /api/v1/import/…).`,
    { limit_bytes: limit },
    { headers: { Connection: 'close' } }
  );
}

function parseJsonBody(buf, ct, limit = DEFAULT_JSON_LIMIT) {
  // Kontrola PŘED dekódováním a JSON.parse: JSON.parse pole se stovkami milionů prvků shodí celý proces
  // nezachytitelnou chybou V8 („Fatal JavaScript invalid size error“) – try/catch ho nezachrání.
  if (buf.length > limit) throw jsonTooLarge(limit);
  const text = decodeText(buf, ct);
  try {
    return JSON.parse(text, safeReviver);
  } catch (e) {
    throw new HttpError(400, 'Neplatný JSON v těle požadavku.', { message: e.message });
  }
}

/** Připojí k ctx líně parsované ctx.body a ctx.bodyType. opts.jsonLimit = max. bajtů JSON těla. */
function attachBody(ctx, opts = {}) {
  const jsonLimit = opts.jsonLimit > 0 ? opts.jsonLimit : DEFAULT_JSON_LIMIT;
  const ct = parseContentType(ctx.req.headers['content-type']);
  ctx.contentType = ct.type;
  const buf = ctx.rawBody;
  let kind;
  if (!buf.length) kind = 'empty';
  else if (isJsonType(ct.type)) kind = 'json';
  else if (ct.type === 'application/x-www-form-urlencoded' || ct.type === '') {
    const first = firstSignificantByte(buf);
    if (first === 0x7b || first === 0x5b) kind = 'sniff-json';
    else if (ct.type === '') kind = looksBinary(buf) ? 'raw' : 'text';
    else kind = first === 0x3c ? 'text' : 'form';
  } else if (isTextType(ct.type)) kind = 'text';
  else kind = 'raw';

  let computed = false;
  let value;
  let bodyType = kind === 'sniff-json' ? 'json' : kind;
  const compute = () => {
    switch (kind) {
      case 'empty':
        return {};
      case 'json':
        return parseJsonBody(buf, ct, jsonLimit);
      case 'sniff-json': {
        if (buf.length > jsonLimit) throw jsonTooLarge(jsonLimit);
        const text = decodeText(buf, ct);
        try {
          return JSON.parse(text, safeReviver);
        } catch {
          bodyType = 'text';
          return text;
        }
      }
      case 'form': {
        const out = Object.create(null);
        for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) if (k !== '__proto__') out[k] = v;
        return { ...out };
      }
      case 'text':
        return decodeText(buf, ct);
      default:
        return buf;
    }
  };
  Object.defineProperty(ctx, 'body', {
    enumerable: true,
    configurable: true,
    get() {
      if (!computed) {
        value = compute();
        computed = true;
      }
      return value;
    },
    set(v) {
      value = v;
      computed = true;
    },
  });
  Object.defineProperty(ctx, 'bodyType', {
    enumerable: true,
    configurable: true,
    get: () => bodyType,
  });
}

// ---------------------------------------------------------------------------------------------------------
// Aplikace

function applySecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

/** Výsledek handleru → odpověď. */
async function respond(ctx, result) {
  if (ctx.responded || ctx.res.headersSent || ctx.res.writableEnded) return;
  if (result === undefined) return send(ctx, { status: ctx.status && ctx.status !== 200 ? ctx.status : 204 });
  if (result && typeof result === 'object' && result.__raw === true) {
    const { __raw, ...opts } = result;
    if (opts.body !== undefined && opts.body !== null && typeof opts.body === 'object' && !Buffer.isBuffer(opts.body) && !(opts.body instanceof Uint8Array) && !isStream(opts.body)) {
      return sendJson(ctx, opts.body, opts);
    }
    return send(ctx, opts);
  }
  if (Buffer.isBuffer(result) || result instanceof Uint8Array) return sendBuffer(ctx, result, { status: ctx.status });
  if (typeof result === 'string') return sendText(ctx, result, { status: ctx.status });
  if (isStream(result)) return sendStream(ctx, result, { status: ctx.status });
  return sendJson(ctx, result, { status: ctx.status ?? 200 });
}

async function handleError(ctx, err) {
  const { req, res } = ctx;
  const log = logOf(ctx);
  if (err && err.clientAbort) {
    log.debug('Klient přerušil spojení', { path: ctx.path });
    return;
  }
  if (ctx.responded || res.headersSent || res.writableEnded || res.destroyed) {
    if (!res.destroyed && !res.writableEnded) {
      log.error(`Chyba po odeslání hlaviček: ${req.method} ${ctx.path}`, err);
      try {
        res.destroy();
      } catch {
        /* nic */
      }
    }
    return;
  }
  // Text interní chyby (např. hláška SQLite) jen pro správce – ne pro tokeny read/import/export (security-5).
  const httpErr = toHttpError(err, { exposeInternal: !!ctx.user && Array.isArray(ctx.scopes) && ctx.scopes.includes('admin') });
  if (httpErr.status >= 500) {
    log.error(`${req.method} ${ctx.path} → ${httpErr.status}: ${err && err.message}`, { stack: err && err.stack, ip: ctx.ip, user: ctx.user });
  } else {
    log.debug(`${req.method} ${ctx.path} → ${httpErr.status}: ${httpErr.message}`);
  }
  const headers = { 'Cache-Control': 'no-store', ...(httpErr.headers || {}) };
  if (httpErr.status === 401) headers['WWW-Authenticate'] = 'Bearer realm="cenotvorba"';
  // Chybová odpověď nesmí nést hlavičky, které handler nastavil pro úspěšnou odpověď.
  for (const h of ['Content-Disposition', 'Content-Encoding', 'Content-Length', 'ETag', 'Last-Modified']) {
    try {
      res.removeHeader(h);
    } catch {
      /* nic */
    }
  }
  await sendJson(ctx, { error: { status: httpErr.status, message: httpErr.message, details: httpErr.details ?? null } }, { status: httpErr.status, headers });
}

/**
 * Vytvoří HTTP aplikaci – funkci (req, res) pro http.createServer.
 * @param {{db: object, config?: object, log?: object, router?: object, setup?: (router) => void, api?: boolean,
 *          deps?: object, clock?: () => Date}} opts
 *   - api: false → nezaregistruje API routy (pro testy frameworku); setup(router) → vlastní routy navíc.
 * @returns {Function & {router, config, db, apiModules}}
 */
function createApp({ db, config = {}, log = defaultLog, router, setup, api = true, deps = {}, clock } = {}) {
  const cfg = { maxBodyMb: 300, maxJsonMb: 32, publicDir: null, trustProxy: false, ...config };
  const r = router || createRouter({ log });
  let apiModules = null;
  if (api) apiModules = require('./api').registerRoutes(r, { db, config: cfg, log, ...deps });
  if (typeof setup === 'function') setup(r);

  const app = function cenotvorbaApp(req, res) {
    handleRequest({ db, config: cfg, log, router: r, clock }, req, res).catch((err) => {
      // poslední záchrana – sem by se nic nemělo dostat
      log.error('Neošetřená chyba v obsluze požadavku', err);
      try {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: { status: 500, message: STATUS_MESSAGES[500], details: null } }));
        } else res.destroy();
      } catch {
        /* nic */
      }
    });
  };
  app.router = r;
  app.config = cfg;
  app.db = db;
  app.apiModules = apiModules;
  return app;
}

async function handleRequest(app, req, res) {
  const { db, config, log, router, clock } = app;
  const started = process.hrtime.bigint();
  const noop = () => {};
  req.on('error', noop);
  res.on('error', noop);
  applySecurityHeaders(res);

  const ctx = {
    req,
    res,
    db,
    config,
    log,
    method: String(req.method || 'GET').toUpperCase(),
    path: '/',
    params: {},
    query: {},
    queryAll: {},
    rawBody: EMPTY,
    contentType: '',
    user: null,
    scopes: [],
    via: null,
    token: null,
    session: null,
    authFailure: null,
    ip: clientIp(req, config),
    now: clock ? clock() : new Date(),
    status: undefined,
    route: null,
    responded: false,
    settings: () => getSettings(db),
    setHeader: (name, value) => res.setHeader(name, value),
    audit: ({ action, entity = null, entity_id = null, detail = null }) =>
      dbAudit(db, { actor: ctx.user || 'anonymous', action, entity, entity_id, detail }),
  };
  // Dokud se tělo nenačte, je ctx.body prázdný objekt.
  ctx.body = {};
  ctx.bodyType = 'empty';

  res.on('finish', () => {
    if (log.isEnabled && !log.isEnabled('debug')) return;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    log.debug(`${ctx.method} ${ctx.path} → ${res.statusCode} (${ms.toFixed(1)} ms)`, { ip: ctx.ip, via: ctx.via });
  });

  try {
    const { pathname, search } = parseUrl(req.url);
    ctx.path = pathname;
    const q = parseQuery(search);
    ctx.query = q.query;
    ctx.queryAll = q.queryAll;
    const apiPath = isApiPath(pathname);
    if (apiPath) res.setHeader('Cache-Control', 'no-store');

    const match = router.match(ctx.method, pathname);
    if (!match.route) {
      if (match.allowed.length) {
        const allow = [...new Set([...match.allowed, ...(match.allowed.includes('GET') ? ['HEAD'] : []), 'OPTIONS'])].filter((m) => m !== '*');
        if (ctx.method === 'OPTIONS') {
          await send(ctx, { status: 204, headers: { Allow: allow.join(', ') } });
          return;
        }
        throw new HttpError(405, `Metoda ${ctx.method} není pro ${pathname} povolena.`, { allowed: allow }, { headers: { Allow: allow.join(', ') } });
      }
      if (apiPath) throw new HttpError(404, `Neznámý endpoint: ${ctx.method} ${pathname}`);
      if (ctx.method === 'GET' || ctx.method === 'HEAD') {
        await serveStatic(ctx, { publicDir: config.publicDir, pathname, send });
        if (!ctx.responded) throw new HttpError(404, 'Nenalezeno.');
        return;
      }
      throw new HttpError(404, 'Nenalezeno.');
    }

    const route = match.route;
    ctx.route = route;
    ctx.params = match.params;

    // 1) ověření (hlavičky/cookie) – ještě před čtením těla, aby neověřený klient nemohl posílat stovky MB
    const auth = authModule.authenticate(ctx);
    if (auth) {
      ctx.user = auth.user;
      ctx.scopes = auth.scopes;
      ctx.via = auth.via;
      ctx.token = auth.token || null;
      ctx.session = auth.session || null;
    }
    delete ctx.query.token;
    delete ctx.queryAll.token;
    authModule.requireScope(ctx, route.auth);
    if (auth) authModule.checkCsrf(ctx);
    if (authModule.shouldRenewSession(auth, ctx.now)) authModule.issueSession(ctx, { now: ctx.now });

    // 2) tělo
    const maxMb = route.opts.maxBodyMb ?? (route.auth === 'public' ? Math.min(1, config.maxBodyMb) : config.maxBodyMb);
    let limitBytes = Math.max(0, Math.floor(Number(maxMb) * 1024 * 1024));
    const jsonLimit = Math.floor(Number(config.maxJsonMb ?? 32) * 1024 * 1024);
    // Běžná JSON API (bez vlastního limitu – ne importy souborů): tělo ani jeho dekomprese nesmí přesáhnout limit JSON
    // (security-1 – jinak by se stovky MB načetly/rozbalily do paměti jen proto, aby je JSON.parse odmítl).
    if (route.opts.maxBodyMb == null && isJsonType(parseContentType(req.headers['content-type']).type)) limitBytes = Math.min(limitBytes, jsonLimit);
    let body = await readBody(req, limitBytes);
    body = await decodeContentEncoding(req, body, limitBytes);
    ctx.rawBody = body;
    attachBody(ctx, { jsonLimit });

    // 3) handler
    const result = await route.handler(ctx);
    await respond(ctx, result);
  } catch (err) {
    await handleError(ctx, err);
  }
}

module.exports = {
  createRouter,
  createApp,
  HttpError,
  toHttpError,
  send,
  sendJson,
  sendText,
  sendBuffer,
  sendStream,
  sendFile,
  redirect,
  raw,
  contentDisposition,
  intParam,
  queryInt,
  queryBool,
  paging,
  // interní – export pro testy a pokročilé použití
  compilePattern,
  acceptsGzip,
  parseUrl,
  parseQuery,
  readBody,
  clientIp,
  isApiPath,
  SECURITY_HEADERS,
  STATUS_MESSAGES,
  GZIP_MIN_BYTES,
};
