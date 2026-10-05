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
//                                  X-Requested-With: kolomapa (ochrana proti CSRF – prohlížeč ji cizímu webu nepošle
//                                  bez preflightu, který server nepovolí) a odmítá Sec-Fetch-Site ≠ same-origin.
//
// Volitelné heslo (config.password, KOLOMAPA_PASSWORD) → HTTP Basic, jméno libovolné, porovnání v konstantním čase,
// po AUTH_MAX_FAILS špatných pokusech z jedné IP adresy 429 na AUTH_WINDOW_MS (hádání hesla v síti). Za reverzní proxy
// na stejném serveru (Caddy, nginx) přicházejí všechny požadavky z 127.0.0.1 → s config.trustProxy
// (KOLOMAPA_TRUST_PROXY=1) se adresa návštěvníka bere z poslední položky X-Forwarded-For, jinak by jeden útočník
// zablokoval všechny.
// Bez hesla server přijímá jen hlavičku Host s IP adresou, localhost, jednoslovným jménem nebo neveřejnou doménou
// (.local, .lan, .home.arpa …) či jménem z config.allowedHosts (KOLOMAPA_ALLOWED_HOSTS) – ochrana proti DNS rebinding
// (cizí web by jinak přes vlastní doménu přeloženou na 127.0.0.1 četl data a spouštěl stahování).
// Odpovědi: bezpečnostní hlavičky, gzip pro textové typy, ETag + 304 pro data, dlouhá cache pro public/vendor/.
// Data (/data/*.json) se sestavují synchronně (stovky ms nad desítkami tisíc inzerátů) → drží se v paměti, dokud se
// databáze nezmění (PRAGMA data_version + total_changes()), takže opakované požadavky neblokují server.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const defaultLog = require('../util/log');
const data = require('./data');

const gzipAsync = promisify(zlib.gzip);
const GZIP_MIN_BYTES = 1024;
const GEOJSON_FILE = path.join(__dirname, '..', 'geo', 'data', 'kraje.geojson');
/** Žádný endpoint tělo požadavku nepotřebuje – větší tělo se odmítne (413) a spojení zavře. */
const MAX_BODY_BYTES = 64 * 1024;
/** Kolik špatných hesel z jedné IP adresy za AUTH_WINDOW_MS, než server začne odpovídat 429. */
const AUTH_MAX_FAILS = 10;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_TRACK_MAX = 10000;
/** Neveřejné domény (nejdou zaregistrovat ve veřejném DNS → nejde přes ně DNS rebinding). */
const PRIVATE_HOST_SUFFIXES = ['.localhost', '.local', '.lan', '.home', '.home.arpa', '.internal', '.intranet', '.corp', '.localdomain'];

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

// Fotky inzerátů a dlaždice mapy jsou z cizích domén (img-src https:); skripty, styly a data jen z vlastního serveru.
// Styly bez 'unsafe-inline': UI i Leaflet nastavují styly jen přes CSSOM (element.style), což CSP nezakazuje.
// Stejná politika (bez frame-ancestors, které v <meta> nefunguje) je v public/index.html pro statický export.
const CSP =
  "default-src 'self'; img-src 'self' data: https: http:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
  "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  // Dlaždice OpenStreetMap vyžadují Referer (pravidla používání); fotky inzerátů si nastavují no-referrer samy.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message česká zpráva pro uživatele
   * @param {object} [headers] další hlavičky odpovědi
   */
  constructor(status, message, headers = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.headers = headers;
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

/** Přijímá klient gzip? (Accept-Encoding s gzip nebo * a q > 0) */
function acceptsGzip(header) {
  for (const part of String(header || '').toLowerCase().split(',')) {
    const [coding, ...params] = part.trim().split(';');
    if (coding.trim() !== 'gzip' && coding.trim() !== '*') continue;
    const q = params.map((p) => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(p)).find(Boolean);
    if (!q || Number(q[1]) > 0) return true;
  }
  return false;
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
  if (segments.some((s) => s === '..' || s.startsWith('.') || s.includes(':'))) return null;
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

/**
 * Adresa z tohoto počítače nebo z neveřejné sítě (reverzní proxy na stejném serveru, Caddy v Docker síti „web“):
 * 127.0.0.0/8, ::1, 10/8, 172.16/12, 192.168/16, fc00::/7, fe80::/10 – i IPv4 mapovaná do IPv6 (::ffff:…).
 */
function isPrivatePeer(ip) {
  let s = String(ip || '').toLowerCase();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  if (s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80:')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(s);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * IP adresa návštěvníka. S trustProxy a požadavkem z tohoto počítače či neveřejné sítě (reverzní proxy na stejném
 * serveru nebo v téže Docker síti) poslední položka X-Forwarded-For – tu přidává proxy, předchozí si klient může
 * vymyslet. Jinak adresa spojení. Přímé spojení z internetu hlavičku nikdy nepoužije.
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy
 */
function clientIp(req, trustProxy) {
  const peer = req.socket.remoteAddress || '';
  if (!trustProxy || !isPrivatePeer(peer)) return peer;
  const list = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const last = list[list.length - 1];
  return last && net.isIP(last) ? last : peer;
}

/** Jméno serveru z hlavičky Host (malými písmeny, bez portu, bez [] u IPv6 a koncové tečky); null = nesmyslná. */
function hostName(header) {
  const h = String(header).trim().toLowerCase();
  if (h.startsWith('[')) {
    const i = h.indexOf(']');
    return i > 1 && /^(:\d*)?$/.test(h.slice(i + 1)) ? h.slice(1, i) : null;
  }
  const name = h.replace(/:\d*$/, '').replace(/\.$/, '');
  return /^[a-z0-9._-]+$/.test(name) ? name : null;
}

/**
 * Smí server odpovědět na požadavek s touto hlavičkou Host, když nemá heslo? (ochrana proti DNS rebinding)
 * Povolené: chybějící Host (HTTP/1.0), IP adresa, localhost, jednoslovné jméno počítače, neveřejné domény
 * (.local, .lan, .home.arpa, .internal …) a jména z `allowed` („*“ = cokoli).
 * @param {string|undefined} header
 * @param {Set<string>} [allowed] malými písmeny
 */
function hostAllowed(header, allowed = new Set()) {
  if (header == null || header === '') return true;
  const name = hostName(header);
  if (!name) return false;
  if (allowed.has('*') || allowed.has(name)) return true;
  if (net.isIP(name)) return true;
  if (name === 'localhost' || !name.includes('.')) return true;
  return PRIVATE_HOST_SUFFIXES.some((s) => name.endsWith(s));
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

/** Položka cache odpovědí: tělo, ETag a (líně) gzip. */
function cacheEntry(raw, etag) {
  return { raw, etag, gz: null };
}

/**
 * Vytvoří obsluhu požadavků.
 * @param {{db, config, log?, runner?: {start: Function, status: Function}, now?: () => Date}} o runner = správce běhů
 *   (scheduler.createRunner); bez něj /api/run vrací 503. config.allowedHosts = další povolená jména serveru
 *   (bez hesla), viz hostAllowed. now = hodiny (testy).
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
function createApp({ db, config, log = defaultLog, runner = null, now: clock = () => new Date() }) {
  const publicDir = config.publicDir ? path.resolve(config.publicDir) : null;
  const allowedHosts = new Set(
    [...(Array.isArray(config.allowedHosts) ? config.allowedHosts : []), os.hostname(), config.host]
      .filter((h) => typeof h === 'string' && h.trim())
      .map((h) => h.trim().toLowerCase())
  );
  let geojsonEntry = null;

  // ------------------------------------------------------------------ cache sestavených dat
  const dataCache = new Map(); // klíč → {tag, entry: cacheEntry}
  let cacheVersion = null;
  let versionStmts = null;

  /** Verze obsahu databáze: mění ji zápis jiného spojení (data_version) i tohoto spojení (total_changes). */
  function dbVersion() {
    try {
      if (db.isTransaction) return null; // rozpracovaná transakce se může vrátit (ROLLBACK) → necachovat
      if (!versionStmts) versionStmts = [db.prepare('PRAGMA data_version'), db.prepare('SELECT total_changes() AS n')];
      return `${versionStmts[0].get().data_version}:${versionStmts[1].get().n}`;
    } catch {
      versionStmts = null;
      return null;
    }
  }

  /** Objekt dat → položka cache. ETag se počítá bez generatedAt (čas sestavení se mění s každým sestavením). */
  function dataEntry(obj) {
    return cacheEntry(Buffer.from(JSON.stringify(obj)), etagOf(Buffer.from(JSON.stringify({ ...obj, generatedAt: null }))));
  }

  /**
   * Data z cache, pokud se databáze od sestavení nezměnila (a sedí `tag`, např. časové okno); jinak build() a uložit.
   * Na klíč je vždy nejvýš jedna položka (paměť je omezená počtem klíčů: přehled + 14 krajů).
   */
  function cachedData(key, tag, build) {
    const v = dbVersion();
    if (v == null) {
      dataCache.clear();
      cacheVersion = null;
      const obj = build();
      return obj ? dataEntry(obj) : null;
    }
    if (v !== cacheVersion) {
      dataCache.clear();
      cacheVersion = v;
    }
    const hit = dataCache.get(key);
    if (hit && hit.tag === tag) return hit.entry;
    const obj = build();
    const entry = obj ? dataEntry(obj) : null;
    dataCache.set(key, { tag, entry });
    return entry;
  }

  // ------------------------------------------------------------------ hesla – omezení hádání
  const authFails = new Map(); // ip → {count, first}

  /** Kolik ms ještě trvá blokace IP adresy (0 = neblokovaná). */
  function authBlockedFor(ip, now) {
    const f = authFails.get(ip);
    if (!f) return 0;
    if (now - f.first >= AUTH_WINDOW_MS) {
      authFails.delete(ip);
      return 0;
    }
    return f.count >= AUTH_MAX_FAILS ? f.first + AUTH_WINDOW_MS - now : 0;
  }

  function authFailed(ip, now) {
    let f = authFails.get(ip);
    if (!f || now - f.first >= AUTH_WINDOW_MS) {
      authFails.delete(ip);
      f = { count: 0, first: now };
      authFails.set(ip, f);
    }
    f.count++;
    if (f.count === AUTH_MAX_FAILS) log.warn('Mnoho špatných hesel – adresa dočasně blokována', { ip, minut: Math.round(AUTH_WINDOW_MS / 60000) });
    if (authFails.size > AUTH_TRACK_MAX) {
      for (const [k, v] of authFails) if (now - v.first >= AUTH_WINDOW_MS) authFails.delete(k);
      // pořád moc (útok z mnoha adres) → zahodit nejstarší záznamy (Map drží pořadí vložení)
      for (const k of authFails.keys()) {
        if (authFails.size <= AUTH_TRACK_MAX) break;
        authFails.delete(k);
      }
    }
  }

  // ------------------------------------------------------------------ odpovědi

  /** 304 Not Modified se stejnými hlavičkami pro cache jako 200 (včetně Vary). */
  function notModified(res, headers) {
    const h = { ...SECURITY_HEADERS, ...headers };
    if (isCompressible(h['Content-Type'])) h.Vary = 'Accept-Encoding';
    res.writeHead(304, h);
    res.end();
  }

  async function send(req, res, { status = 200, headers = {}, body = null, etag = false }) {
    const h = { ...SECURITY_HEADERS, ...headers };
    let buf = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    if (buf && etag) {
      const tag = etagOf(buf);
      h.ETag = tag;
      if (status === 200 && etagMatches(req.headers['if-none-match'], tag)) return notModified(res, h);
    }
    const compressible = isCompressible(h['Content-Type']);
    if (compressible) h.Vary = 'Accept-Encoding';
    if (buf && compressible && buf.length >= GZIP_MIN_BYTES && req.method !== 'HEAD' && acceptsGzip(req.headers['accept-encoding'])) {
      buf = await gzipAsync(buf, { level: 6 });
      h['Content-Encoding'] = 'gzip';
    }
    if (buf) h['Content-Length'] = buf.length;
    res.writeHead(status, h);
    res.end(req.method === 'HEAD' || !buf ? undefined : buf);
  }

  /** Odpověď z položky cache (ETag/304, gzip spočítaný jednou a sdílený). */
  async function sendEntry(req, res, entry, headers) {
    const h = { ...SECURITY_HEADERS, ...headers, ETag: entry.etag, Vary: 'Accept-Encoding' };
    if (etagMatches(req.headers['if-none-match'], entry.etag)) return notModified(res, h);
    let buf = entry.raw;
    if (buf.length >= GZIP_MIN_BYTES && acceptsGzip(req.headers['accept-encoding'])) {
      if (!entry.gz) {
        entry.gz = gzipAsync(entry.raw, { level: 6 }).catch((e) => {
          entry.gz = null;
          throw e;
        });
      }
      buf = await entry.gz;
      h['Content-Encoding'] = 'gzip';
    }
    h['Content-Length'] = buf.length;
    res.writeHead(200, h);
    res.end(req.method === 'HEAD' ? undefined : buf);
  }

  const sendJson = (req, res, status, obj, extra = {}) =>
    send(req, res, {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra.headers },
      body: Buffer.from(JSON.stringify(obj)),
      etag: extra.etag,
    });

  const DATA_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' };

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
    if (etagMatches(req.headers['if-none-match'], tag)) return notModified(res, headers);
    const body = await fsp.readFile(file);
    return send(req, res, { status: 200, headers, body });
  }

  async function route(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    const isGet = m === 'GET' || m === 'HEAD';

    if (p === '/data/summary.json') {
      if (!isGet) throw new HttpError(405, 'Metoda není povolena.');
      const now = clock();
      // přehled závisí i na čase („nové“ za 36 h, zaokrouhleno na 10 min) → klíč s 10min oknem
      const entry = cachedData('summary', Math.floor(now.getTime() / 600000), () => data.buildSummary(db, { mode: 'server', now }));
      return sendEntry(req, res, entry, DATA_HEADERS);
    }
    let mm = /^\/data\/kraj\/([^/]*)\.json$/.exec(p);
    if (mm || p.startsWith('/data/kraj/')) {
      if (!isGet) throw new HttpError(405, 'Metoda není povolena.');
      const code = mm ? mm[1] : '';
      if (!/^[A-Za-z]{3}$/.test(code)) throw new HttpError(400, 'Neplatný kód kraje.');
      const k = code.toUpperCase();
      if (!data.KRAJ_CODES.includes(k)) throw new HttpError(404, 'Neznámý kraj.');
      const entry = cachedData(`kraj:${k}`, 0, () => data.buildKraj(db, k));
      if (!entry) throw new HttpError(404, 'Neznámý kraj.');
      return sendEntry(req, res, entry, DATA_HEADERS);
    }
    if (p === '/data/kraje.geojson') {
      if (!isGet) throw new HttpError(405, 'Metoda není povolena.');
      if (!geojsonEntry) {
        const raw = await fsp.readFile(GEOJSON_FILE);
        geojsonEntry = cacheEntry(raw, etagOf(raw));
      }
      return sendEntry(req, res, geojsonEntry, { 'Content-Type': MIME['.geojson'], 'Cache-Control': 'public, max-age=86400' });
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
      // Prohlížeče posílají Sec-Fetch-Site; tlačítko v UI je vždy same-origin (i za reverzní proxy).
      const site = req.headers['sec-fetch-site'];
      if (site && String(site).toLowerCase() !== 'same-origin') throw new HttpError(403, 'Stahování lze spustit jen z Kolomapy samotné.');
      const r = runner.start('manual');
      if (!r.started) return sendJson(req, res, 409, { error: r.reason || 'Stahování už běží.', status: runner.status() });
      return sendJson(req, res, 202, { started: true, status: runner.status() });
    }
    if (p.startsWith('/api/') || p === '/api') throw new HttpError(404, 'Nenalezeno.');
    if (!isGet) throw new HttpError(405, 'Metoda není povolena.');
    return serveStatic(req, res, p);
  }

  return async function handler(req, res) {
    // Tělo požadavku nepotřebujeme: zahodit, ale ne neomezeně (jinak by šlo server zaměstnat nekonečným uploadem).
    let received = 0;
    req.on('data', (c) => {
      received += c.length;
      if (received > MAX_BODY_BYTES) req.socket.destroy();
    });
    req.on('error', () => {});
    req.resume();
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      url = null;
    }
    try {
      if (!url) throw new HttpError(400, 'Neplatná adresa.');
      if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
        throw new HttpError(413, 'Požadavek je příliš velký.', { Connection: 'close' });
      }
      if (!config.password && !hostAllowed(req.headers.host, allowedHosts)) {
        throw new HttpError(
          403,
          'Neznámá adresa serveru (hlavička Host) – ochrana proti DNS rebinding. Otevřete Kolomapu přes IP adresu nebo localhost, ' +
            'nebo nastavte heslo (KOLOMAPA_PASSWORD), případně povolte jméno serveru v KOLOMAPA_ALLOWED_HOSTS.'
        );
      }
      if (config.password) {
        const ip = clientIp(req, !!config.trustProxy);
        const now = Date.now();
        const blocked = authBlockedFor(ip, now);
        if (blocked > 0) {
          const min = Math.ceil(blocked / 60000);
          throw new HttpError(429, `Příliš mnoho neúspěšných pokusů o přihlášení – zkuste to znovu za ${min} min.`, { 'Retry-After': String(Math.ceil(blocked / 1000)) });
        }
        if (!checkBasicAuth(req.headers.authorization, config.password)) {
          if (req.headers.authorization) authFailed(ip, now);
          res.writeHead(401, {
            ...SECURITY_HEADERS,
            'WWW-Authenticate': 'Basic realm="Kolomapa", charset="UTF-8"',
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(req.method === 'HEAD' ? undefined : 'Přihlaste se heslem Kolomapy.');
          return;
        }
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
      const wantsJson = !!url && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/data/'));
      const headers = { 'Cache-Control': 'no-store', ...(e instanceof HttpError && e.headers ? e.headers : {}) };
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

module.exports = {
  createApp,
  clientIp,
  resolveStaticPath,
  checkBasicAuth,
  safeEqual,
  hostAllowed,
  acceptsGzip,
  mimeType,
  publicDirStatus,
  HttpError,
  SECURITY_HEADERS,
  CSP,
  GEOJSON_FILE,
  MAX_BODY_BYTES,
  AUTH_MAX_FAILS,
  AUTH_WINDOW_MS,
};
