'use strict';
// Statické soubory z public/ (SPEC kap. 3): jen povolené prefixy (base.css, themes/, css/, js/, fonts/, img/, vendor/,
// admin/ + favicon.svg, robots.txt), MIME tabulka, Cache-Control (immutable pro /vendor/ a /fonts/, 1 h jinde),
// ETag + 304, gzip/brotli pro textové typy podle Accept-Encoding, žádný listing adresářů, zákaz „..“ a skrytých souborů.
// URL stylů/skriptů v HTML nesou ?v=<verze> (assetUrl) – query se při hledání souboru ignoruje.
// Vstup: req, res, { publicDir, pathname }. Výstup: Promise<boolean> (true = odpověď odeslána).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.gpx': 'application/gpx+xml; charset=utf-8',
  '.ics': 'text/calendar; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
});

const ALLOWED_PREFIXES = ['/themes/', '/css/', '/js/', '/fonts/', '/img/', '/vendor/', '/admin/'];
const ALLOWED_FILES = new Set(['/base.css', '/favicon.svg', '/favicon.ico', '/robots.txt']);
const IMMUTABLE_PREFIXES = ['/vendor/', '/fonts/'];
const COMPRESS_MIN_BYTES = 1024;

function mimeType(file) {
  return MIME[path.extname(String(file)).toLowerCase()] || 'application/octet-stream';
}

function isCompressible(contentType) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!ct) return false;
  if (ct.startsWith('text/')) return true;
  if (ct.endsWith('+json') || ct.endsWith('+xml')) return true;
  return ['application/json', 'application/xml', 'image/svg+xml', 'application/manifest+json'].includes(ct);
}

/** Patří cesta mezi veřejně servírované? */
function isAllowedPath(pathname) {
  return ALLOWED_FILES.has(pathname) || ALLOWED_PREFIXES.some((p) => pathname.startsWith(p));
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Převede URL cestu na absolutní cestu k souboru v rootDir, nebo null (traversal, skryté soubory, neplatné znaky). */
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
  if (segments.some((s) => s === '..' || s === '.' || s.startsWith('.'))) return null;
  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...segments);
  return isInside(root, target) ? target : null;
}

function etagFor(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch) return false;
  const strip = (t) => t.trim().replace(/^W\//, '');
  const want = strip(etag);
  return String(ifNoneMatch)
    .split(',')
    .some((t) => t.trim() === '*' || strip(t) === want);
}

/** Vybere kódování podle Accept-Encoding: br > gzip > null. */
function pickEncoding(acceptEncoding) {
  const ae = String(acceptEncoding || '').toLowerCase();
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return null;
}

/**
 * Obslouží GET/HEAD statického souboru. Vrací true, pokud odpověď odeslala (včetně 404 pro povolené prefixy
 * s neexistujícím souborem), false pokud cesta není statická (má pokračovat router).
 */
async function serveStatic(req, res, { publicDir, pathname }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!isAllowedPath(pathname)) return false;
  const root = path.resolve(publicDir);
  const target = resolveStaticPath(root, pathname);
  let stat = null;
  if (target) {
    try {
      stat = await fsp.stat(target);
      const [realRoot, realFile] = await Promise.all([fsp.realpath(root), fsp.realpath(target)]);
      if (!isInside(realRoot, realFile)) stat = null;
    } catch {
      stat = null;
    }
  }
  if (!stat || !stat.isFile()) {
    // Prefix /admin/ sdílí statika (public/admin/*.js) se stránkami administrace (/admin/rezervace, …):
    // neexistující soubor pod /admin/ proto propadá do routeru (admin 6. 10., viz docs/TODO-INTEGRACE.md).
    if (pathname.startsWith('/admin/')) return false;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : 'Soubor nenalezen.');
    return true;
  }
  const type = mimeType(target);
  const immutable = IMMUTABLE_PREFIXES.some((p) => pathname.startsWith(p));
  const headers = {
    'Content-Type': type,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    'Last-Modified': stat.mtime.toUTCString(),
    ETag: etagFor(stat),
    Vary: 'Accept-Encoding',
  };
  if (etagMatches(req.headers['if-none-match'], headers.ETag)) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  const encoding = isCompressible(type) && stat.size >= COMPRESS_MIN_BYTES ? pickEncoding(req.headers['accept-encoding']) : null;
  if (encoding) headers['Content-Encoding'] = encoding;
  else headers['Content-Length'] = String(stat.size);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  const source = fs.createReadStream(target);
  try {
    if (encoding === 'br') await pipeline(source, zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }), res);
    else if (encoding === 'gzip') await pipeline(source, zlib.createGzip({ level: 6 }), res);
    else await pipeline(source, res);
  } catch {
    // klient odpojen uprostřed přenosu – nic
    res.destroy();
  }
  return true;
}

/** mtime souboru v public/ (pro ?v= bez APP_VERSION) – synchronně, cache v paměti. */
const mtimeCache = new Map();
function assetVersion(publicDir, urlPath, appVersion) {
  if (appVersion && appVersion !== '0.0.0') return appVersion;
  if (mtimeCache.has(urlPath)) return mtimeCache.get(urlPath);
  let v = '0';
  try {
    v = Math.floor(fs.statSync(path.join(publicDir, urlPath)).mtimeMs).toString(36);
  } catch {
    /* soubor neexistuje → '0' */
  }
  mtimeCache.set(urlPath, v);
  return v;
}

/** URL statického souboru s ?v=. */
function assetUrl(urlPath, { publicDir, version } = {}) {
  const v = publicDir ? assetVersion(publicDir, urlPath, version) : version || '0';
  return `${urlPath}?v=${encodeURIComponent(v)}`;
}

module.exports = { MIME, ALLOWED_PREFIXES, ALLOWED_FILES, mimeType, isCompressible, isAllowedPath, resolveStaticPath, etagMatches, pickEncoding, serveStatic, assetUrl };
