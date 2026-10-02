'use strict';
// HTTP rozhraní Kolomapy nad node:http (bez frameworku).
//
//   GET  /                         UI (public/index.html) + statické soubory z config.publicDir
//   GET  /data/summary.json        přehled ČR (data.buildSummary, mode 'server')
//   GET  /data/kraj/<KOD>.json     inzeráty kraje (data.buildKraj); neplatný kód → 400, neznámý → 404
//   GET  /data/kraje.geojson       hranice krajů (src/geo/data/kraje.geojson)
//   GET  /api/listing/:id          plný detail inzerátu + historie ceny
//   GET  /api/run                  stav běhu (běží?, průběh, poslední běh, příští plánovaný)
//   POST /api/run                  spustí stahování hned (202), když už běží → 409. Vyžaduje hlavičku
//                                  X-Requested-With: kolomapa (ochrana proti CSRF – prohlížeč ji cizímu webu nepošle).
//
// Volitelné heslo (config.password, KOLOMAPA_PASSWORD) → HTTP Basic, jméno libovolné, porovnání v konstantním čase.
// Odpovědi: bezpečnostní hlavičky, gzip pro textové typy, ETag + 304 pro data, dlouhá cache pro public/vendor/.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const defaultLog = require('../util/log');
const data = require('./data');

const gzipAsync = promisify(zlib.gzip);
const GZIP_MIN_BYTES = 1024;
const GEOJSON_FILE = path.join(__dirname, '..', 'geo', 'data', 'kraje.geojson');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// Fotky inzerátů a dlaždice mapy jsou z cizích domén (img-src https:); skripty a data jen z vlastního serveru.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https: http:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  // Dlaždice OpenStreetMap vyžadují Referer (pravidla používání); fotky inzerátů si nastavují no-referrer samy.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
};

class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message česká zpráva pro uživatele
   */
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** MIME typ podle přípony. */
function mimeType(file) {
  return MIME[path.extname(String(file)).toLowerCase()] || 'application/octet-stream';
}

function isCompressible(ct) {
  const t = String(ct || '').split(';')[0].trim();
  return t.startsWith('text/') || t.endsWith('json') || t.endsWith('+xml') || t === 'image/svg+xml' || t === 'application/javascript';
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * URL cesta → absolutní cesta uvnitř rootDir, nebo null (neplatné kódování, „..“, skryté soubory, zpětná lomítka).
 * @param {string} rootDir
 * @param {string} urlPath pathname (ještě procentově kódovaný)
 * @returns {string|null}
 */
function resolveStaticPath(rootDir, urlPath) {
  if (typeof urlPath !== 'string' || !urlPath.startsWith('/')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((s) => s === '..' || s.startsWith('.'))) return null;
  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...segments);
  return isInside(root, target) ? target : null;
}

/** Porovnání hesla v konstantním čase (přes SHA-256, aby délka neprozradila nic). */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Ověří hlavičku Authorization: Basic … proti heslu (jméno se ignoruje). */
function checkBasicAuth(header, password) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(String(header || ''));
  let pass = '';
  if (m) {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    pass = i >= 0 ? decoded.slice(i + 1) : '';
  }
  // porovnat vždy (i bez hlavičky), ať odpověď trvá stejně
  const ok = safeEqual(pass, password);
  return !!m && ok;
}

function etagOf(buf) {
  return `W/"${crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 27)}"`;
}

function etagMatches(header, etag) {
  if (!header) return false;
  const strip = (t) => t.trim().replace(/^W\//, '');
  return String(header)
    .split(',')
    .some((t) => t.trim() === '*' || strip(t) === strip(etag));
}

/**
 * Vytvoří obsluhu požadavků.
 * @param {{db, config, log?, runner?: {start: Function, status: Function}}} o runner = správce běhů
 *   (scheduler.createRunner); bez něj /api/run vrací 503
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
function createApp({ db, config, log = defaultLog, runner = null }) {
  const publicDir = config.publicDir ? path.resolve(config.publicDir) : null;
  let geojsonCache = null;

  async function send(req, res, { status = 200, headers = {}, body = null, etag = false }) {
    const h = { ...SECURITY_HEADERS, ...headers };
    let buf = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    if (buf && etag) {
      const tag = etagOf(buf);
      h.ETag = tag;
      if (status === 200 && etagMatches(req.headers['if-none-match'], tag)) {
        res.writeHead(304, h);
        res.end();
        return;
      }
    }
    if (buf && buf.length >= GZIP_MIN_BYTES && isCompressible(h['Content-Type']) && /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) {
      buf = await gzipAsync(buf, { level: 6 });
      h['Content-Encoding'] = 'gzip';
      h.Vary = 'Accept-Encoding';
    } else if (buf && isCompressible(h['Content-Type'])) h.Vary = 'Accept-Encoding';
    if (buf) h['Content-Length'] = buf.length;
    res.writeHead(status, h);
    res.end(req.method === 'HEAD' || !buf ? undefined : buf);
  }

  const sendJson = (req, res, status, obj, extra = {}) =>
    send(req, res, {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra.headers },
      body: Buffer.from(JSON.stringify(obj)),
      etag: extra.etag,
    });

  // ETag se počítá z obsahu bez generatedAt (čas sestavení se mění s každým požadavkem) → 304, když se data nezměnila.
  async function sendData(req, res, obj) {
    const tag = etagOf(Buffer.from(JSON.stringify({ ...obj, generatedAt: null })));
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: tag };
    if (etagMatches(req.headers['if-none-match'], tag)) {
      res.writeHead(304, { ...SECURITY_HEADERS, ...headers });
      res.end();
      return;
    }
    return send(req, res, { status: 200, headers, body: Buffer.from(JSON.stringify(obj)) });
  }

  async function serveStatic(req, res, pathname) {
    if (!publicDir) throw new HttpError(404, 'Nenalezeno.');
    const target = resolveStaticPath(publicDir, pathname === '/' ? '/index.html' : pathname);
    if (!target) throw new HttpError(404, 'Soubor nenalezen.');
    let file = target;
    let st = await fsp.stat(file).catch(() => null);
    if (st && st.isDirectory()) {
      file = path.join(file, 'index.html');
      st = await fsp.stat(file).catch(() => null);
    }
    if (!st || !st.isFile()) {
      if (pathname === '/' || pathname === '/index.html') {
        return send(req, res, {
          status: 404,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
          body: '<!doctype html><meta charset="utf-8"><title>Kolomapa</title><p>Uživatelské rozhraní chybí (public/index.html). Data jsou na <code>/data/summary.json</code>.</p>',
        });
      }
      throw new HttpError(404, 'Soubor nenalezen.');
    }
    // Symlinky nesmí vést ven z public/
    const [realRoot, realFile] = await Promise.all([fsp.realpath(publicDir), fsp.realpath(file)]).catch(() => [null, null]);
    if (!realRoot || !isInside(realRoot, realFile)) throw new HttpError(404, 'Soubor nenalezen.');
    const rel = path.relative(publicDir, file).split(path.sep).join('/');
    const isVendor = rel.startsWith('vendor/');
    const tag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': mimeType(file),
      'Cache-Control': isVendor ? 'public, max-age=604800' : 'no-cache',
      'Last-Modified': st.mtime.toUTCString(),
      ETag: tag,
    };
    if (etagMatches(req.headers['if-none-match'], tag)) {
      res.writeHead(304, { ...SECURITY_HEADERS, ...headers });
      res.end();
      return;
    }
    const body = await fsp.readFile(file);
    return send(req, res, { status: 200, headers, body });
  }

  async function route(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    const isGet = m === 'GET' || m === 'HEAD';

    if (p === '/data/summary.json') {
      if (!isGet) throw new HttpError(405, 'Metoda není povolena.');
      return sendData(req, res, data.buildSummary(db, { mode: 'server' }));
    }
    let mm = /^\/data\/kraj\/([^/]*)\.json$/.exec(p);
    if (mm || p.startsWith('/data/kraj/')) {
      if (!isGet) throw new HttpError(405, 'Metoda není povolena.');
      const code = mm ? mm[1] : '';
      if (!/^[A-Za-z]{3}$/.test(code)) throw new HttpError(400, 'Neplatný kód kraje.');
      const out = data.buildKraj(db, code.toUpperCase());
      if (!out) throw new HttpError(404, 'Neznámý kraj.');
      return sendData(req, res, out);
    }
    if (p === '/data/kraje.geojson') {
      if (!isGet) throw new HttpError(405, 'Metoda není povolena.');
      if (!geojsonCache) geojsonCache = await fsp.readFile(GEOJSON_FILE);
      return send(req, res, {
        status: 200,
        headers: { 'Content-Type': MIME['.geojson'], 'Cache-Control': 'public, max-age=86400' },
        body: geojsonCache,
        etag: true,
      });
    }
    mm = /^\/api\/listing\/([^/]+)$/.exec(p);
    if (mm) {
      if (!isGet) throw new HttpError(405, 'Metoda není povolena.');
      if (!/^\d{1,15}$/.test(mm[1])) throw new HttpError(400, 'Neplatné ID inzerátu.');
      const l = data.buildListing(db, Number(mm[1]));
      if (!l) throw new HttpError(404, 'Inzerát nenalezen.');
      return sendJson(req, res, 200, l);
    }
    if (p === '/api/run') {
      if (!runner) throw new HttpError(503, 'Stahování není na tomto serveru k dispozici.');
      if (isGet) return sendJson(req, res, 200, runner.status());
      if (m !== 'POST') throw new HttpError(405, 'Metoda není povolena.');
      if (String(req.headers['x-requested-with'] || '').toLowerCase() !== 'kolomapa') {
        throw new HttpError(403, 'Chybí hlavička X-Requested-With: kolomapa.');
      }
      const r = runner.start('manual');
      if (!r.started) return sendJson(req, res, 409, { error: r.reason || 'Stahování už běží.', status: runner.status() });
      return sendJson(req, res, 202, { started: true, status: runner.status() });
    }
    if (p.startsWith('/api/') || p === '/api') throw new HttpError(404, 'Nenalezeno.');
    if (!isGet) throw new HttpError(405, 'Metoda není povolena.');
    return serveStatic(req, res, p);
  }

  return async function handler(req, res) {
    req.resume(); // tělo požadavku nepotřebujeme
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      url = null;
    }
    try {
      if (!url) throw new HttpError(400, 'Neplatná adresa.');
      if (config.password && !checkBasicAuth(req.headers.authorization, config.password)) {
        res.writeHead(401, {
          ...SECURITY_HEADERS,
          'WWW-Authenticate': 'Basic realm="Kolomapa", charset="UTF-8"',
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end('Přihlaste se heslem Kolomapy.');
        return;
      }
      await route(req, res, url);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) log.error('Chyba při obsluze požadavku', { url: req.url, error: e });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const message = status >= 500 ? 'Interní chyba serveru.' : e.message;
      const wantsJson = !url || url.pathname.startsWith('/api/') || url.pathname.startsWith('/data/');
      const headers = { 'Cache-Control': 'no-store' };
      if (status === 405) headers.Allow = url && url.pathname === '/api/run' ? 'GET, HEAD, POST' : 'GET, HEAD';
      try {
        if (wantsJson) await sendJson(req, res, status, { error: message }, { headers });
        else await send(req, res, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers }, body: message });
      } catch {
        res.destroy();
      }
    }
  };
}

/** Existuje public/index.html? (diagnostika při startu serveru) */
function publicDirStatus(dir) {
  try {
    return fs.statSync(path.join(dir, 'index.html')).isFile();
  } catch {
    return false;
  }
}

module.exports = { createApp, resolveStaticPath, checkBasicAuth, safeEqual, mimeType, publicDirStatus, HttpError, SECURITY_HEADERS, GEOJSON_FILE };
