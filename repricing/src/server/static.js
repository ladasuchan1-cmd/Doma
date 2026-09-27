'use strict';
// Servírování statických souborů UI (config.publicDir) – bezpečně (žádný průchod mimo adresář, žádné skryté
// soubory), se správnými MIME typy, ETagem a SPA fallbackem na index.html.
//
// Modul záměrně nezávisí na http.js (jinak by vznikl cyklus) – odesílání dělá funkce `send` předaná z http.js.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
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
  '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.wasm': 'application/wasm',
};

/** MIME typ podle přípony souboru (neznámé → application/octet-stream). */
function mimeType(filePath) {
  return MIME[path.extname(String(filePath)).toLowerCase()] || 'application/octet-stream';
}

/**
 * Má smysl odpověď komprimovat? (text, JSON, XML, JS, SVG, CSV …; ne xlsx/zip/obrázky/fonty – ty už komprimované jsou).
 * @param {string|number|string[]|undefined} contentType
 */
function isCompressible(contentType) {
  if (!contentType) return false;
  const ct = String(Array.isArray(contentType) ? contentType[0] : contentType)
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!ct) return false;
  if (ct.startsWith('text/')) return true;
  if (ct.endsWith('+json') || ct.endsWith('+xml')) return true;
  return [
    'application/json',
    'application/xml',
    'application/javascript',
    'application/x-javascript',
    'application/ecmascript',
    'application/csv',
    'application/x-ndjson',
    'application/wasm',
    'image/x-icon',
    'image/bmp',
  ].includes(ct);
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Převede URL cestu na absolutní cestu k souboru uvnitř rootDir, nebo vrátí null (neplatná / mimo root / skrytý soubor).
 * Nekontroluje existenci souboru.
 * @param {string} rootDir absolutní cesta k public adresáři
 * @param {string} urlPath pathname z URL (ještě procentově kódovaný)
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
  // „..“ i skryté soubory (.env, .git …) odmítáme ještě před normalizací
  if (segments.some((s) => s === '..' || s.startsWith('.'))) return null;
  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...segments);
  return isInside(root, target) ? target : null;
}

function weakEtag(stat) {
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

async function statFile(file) {
  try {
    const st = await fsp.stat(file);
    return st;
  } catch {
    return null;
  }
}

/** Najde soubor k odeslání; adresář → jeho index.html. Ověří, že reálná cesta (symlinky) zůstává v rootu. */
async function findFile(root, file) {
  let st = await statFile(file);
  if (st && st.isDirectory()) {
    file = path.join(file, 'index.html');
    st = await statFile(file);
  }
  if (!st || !st.isFile()) return null;
  try {
    const [realRoot, realFile] = await Promise.all([fsp.realpath(root), fsp.realpath(file)]);
    if (!isInside(realRoot, realFile)) return null;
  } catch {
    return null;
  }
  return { file, stat: st };
}

/**
 * Obslouží GET/HEAD na statický soubor.
 *  - index.html: `Cache-Control: no-cache` (bez ETagu → vždy čerstvý)
 *  - ostatní soubory: `Cache-Control: no-cache` + ETag, If-None-Match → 304
 *  - neexistující cesta bez přípony → SPA fallback na index.html (hash router UI)
 *  - neexistující cesta s příponou (…/chybi.js) → 404 (nikdy neposílat HTML místo skriptu)
 * @param {object} ctx kontext požadavku z http.js
 * @param {{publicDir: string, pathname: string, spaFallback?: boolean,
 *          send: (ctx, {status, headers, body}) => Promise<void>}} opts
 * @returns {Promise<boolean>} true = odpověď odeslána
 */
async function serveStatic(ctx, { publicDir, pathname, spaFallback = true, send }) {
  if (!publicDir) return false;
  const root = path.resolve(publicDir);
  const target = resolveStaticPath(root, pathname);
  const lastSegment = pathname.split('/').pop() || '';
  const hasExt = /\.[a-z0-9]{1,12}$/i.test(lastSegment);

  let found = target ? await findFile(root, target) : null;
  let isSpaFallback = false;
  if (!found) {
    // Neplatná cesta (traversal, skrytý soubor) nikdy nedostane fallback – odpověď 404.
    if (!target || hasExt || !spaFallback) return notFound(ctx, send);
    found = await findFile(root, path.join(root, 'index.html'));
    if (!found) return uiMissing(ctx, send);
    isSpaFallback = true;
  }

  const isIndex = path.basename(found.file).toLowerCase() === 'index.html';
  const headers = {
    'Content-Type': mimeType(found.file),
    'Cache-Control': 'no-cache',
    'Last-Modified': found.stat.mtime.toUTCString(),
  };
  if (!isIndex && !isSpaFallback) {
    const etag = weakEtag(found.stat);
    headers.ETag = etag;
    if (etagMatches(ctx.req.headers['if-none-match'], etag)) {
      await send(ctx, { status: 304, headers, body: null });
      return true;
    }
  }
  let body;
  try {
    body = await fsp.readFile(found.file);
  } catch {
    return notFound(ctx, send);
  }
  await send(ctx, { status: 200, headers, body });
  return true;
}

async function notFound(ctx, send) {
  await send(ctx, {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
    body: 'Soubor nenalezen.',
  });
  return true;
}

async function uiMissing(ctx, send) {
  await send(ctx, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
    body:
      '<!doctype html><html lang="cs"><meta charset="utf-8"><title>Cenotvorba</title>' +
      '<p>Uživatelské rozhraní není k dispozici (chybí public/index.html). API běží na <code>/api/v1</code>.</p></html>',
  });
  return true;
}

/** Existuje soubor synchronně? (pro diagnostiku při startu) */
function publicDirStatus(publicDir) {
  try {
    return fs.statSync(path.join(publicDir, 'index.html')).isFile();
  } catch {
    return false;
  }
}

module.exports = {
  MIME,
  mimeType,
  isCompressible,
  resolveStaticPath,
  serveStatic,
  etagMatches,
  publicDirStatus,
};
