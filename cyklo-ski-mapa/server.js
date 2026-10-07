#!/usr/bin/env node
'use strict';
// Server pro web: servíruje aplikaci, hlídá přihlášení a ukládá sdílený stav oslovení do data/stav.json,
// aby ho vidělo celé obchodní oddělení. Bez něj aplikace funguje i z disku (file://) s uložením v prohlížeči.
//
//   node server.js            # http://localhost:8090
//
// Proměnné prostředí (viz .env.example):
//   PORT                port (8090)
//   CSM_STAV            soubor se stavem oslovení (./data/stav.json); vedle něj se uloží .secret pro podpis cookie
//   CSM_USERS           uživatelé „jmeno:heslo;jmeno2:heslo2“ – každá změna pak nese, kdo ji udělal
//   CSM_PASSWORD        jedno společné heslo (uživatel „tým“), když CSM_USERS nejsou
//   CSM_AUTH=0          vypne přihlášení (jen pro vývoj / vnitřní síť)
//   CSM_SECRET          klíč pro podpis session cookie (jinak se vygeneruje a uloží do .secret)
//   CSM_SESSION_DAYS    platnost přihlášení ve dnech (30)
//   CSM_TRUST_PROXY=1   za reverzní proxy (Caddy/nginx): cookie Secure podle X-Forwarded-Proto, IP z X-Forwarded-For
//   CSM_TOKEN           Bearer token pro externí skripty na /api (bez přihlášení)
//
// API: GET /api/stav · PUT /api/stav (sloučení) · GET/PUT/DELETE /api/stav/<id> · GET /api/me · GET /api/health
// Bez nastaveného hesla ani uživatelů se při startu vygeneruje náhodné heslo a vypíše do konzole.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const stavLib = require('./lib/stav.js');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8090);
const STAV_FILE = path.resolve(process.env.CSM_STAV || path.join(ROOT, 'data', 'stav.json'));
const TOKEN = process.env.CSM_TOKEN || '';
const TRUST_PROXY = process.env.CSM_TRUST_PROXY === '1';
const SESSION_DAYS = Math.max(1, Number(process.env.CSM_SESSION_DAYS || 30));
const AUTH_ON = process.env.CSM_AUTH !== '0';
const MAX_BODY = 2 * 1024 * 1024;
const COOKIE = 'csm_session';
const APP_VERSION = process.env.APP_VERSION || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.md', '.txt']);

// ---------------------------------------------------------------- uživatelé
// „jana:heslo;petr:heslo2“ (oddělovač ; , nebo nový řádek) → Map(jméno → heslo)
function parseUsers(src) {
  const out = new Map();
  for (const part of String(src || '').split(/[;\n,]+/)) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const pass = part.slice(i + 1).trim();
    if (name && pass) out.set(name.slice(0, 60).toLowerCase(), pass); // jméno bez ohledu na velikost písmen
  }
  return out;
}

const USERS = parseUsers(process.env.CSM_USERS);
let GENERATED_PASSWORD = null;
if (AUTH_ON && !USERS.size) {
  if (process.env.CSM_PASSWORD) USERS.set(process.env.CSM_USER || 'tým', process.env.CSM_PASSWORD);
  else {
    GENERATED_PASSWORD = crypto.randomBytes(9).toString('base64url');
    USERS.set('tým', GENERATED_PASSWORD);
  }
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkLogin(name, pass) {
  const expected = USERS.get(String(name || '').trim().toLowerCase());
  if (expected == null) {
    safeEqual('x', String(pass || '')); // stejný čas i pro neznámé jméno
    return false;
  }
  return safeEqual(expected, String(pass || ''));
}

// ---------------------------------------------------------------- session cookie
function loadSecret() {
  if (process.env.CSM_SECRET) return process.env.CSM_SECRET;
  const file = path.join(path.dirname(STAV_FILE), '.secret');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch (_e) { /* není – vytvoříme */ }
  const s = crypto.randomBytes(32).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, s, { mode: 0o600 });
  } catch (e) {
    console.error('Nelze uložit tajný klíč do ' + file + ' (' + e.message + ') – přihlášení nepřežije restart. Nastavte CSM_SECRET.');
  }
  return s;
}
const SECRET = AUTH_ON ? loadSecret() : '';

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function makeSession(user) {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + SESSION_DAYS * 86400000 }), 'utf8').toString('base64url');
  return payload + '.' + sign(payload);
}

function readSession(req) {
  const raw = req.headers.cookie || '';
  const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)').exec(raw);
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.u || !data.exp || data.exp < Date.now()) return null;
    if (!USERS.has(data.u)) return null; // odebraný uživatel přestane platit hned
    return { user: data.u };
  } catch (_e) {
    return null;
  }
}

function isHttps(req) {
  if (TRUST_PROXY) return (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return Boolean(req.socket.encrypted);
}

function cookieHeader(value, req, maxAge) {
  const parts = [COOKIE + '=' + value, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + maxAge];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '?';
}

// Brzda proti hádání hesla: 10 neúspěchů z jedné adresy za 15 minut → 429.
const failures = new Map();
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.since > 15 * 60000) {
    failures.delete(ip);
    return false;
  }
  return f.count >= 10;
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > 15 * 60000) failures.set(ip, { count: 1, since: Date.now() });
  else f.count++;
}

// ---------------------------------------------------------------- stav
let stav = loadStav();
let writeTimer = null;

function loadStav() {
  try {
    if (!fs.existsSync(STAV_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(STAV_FILE, 'utf8'));
    return stavLib.importJson(parsed).stav || {};
  } catch (e) {
    console.error('Nelze načíst ' + STAV_FILE + ': ' + e.message + ' – začínám s prázdným stavem.');
    return {};
  }
}

function scheduleWrite() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(writeStav, 300);
}

function writeStav() {
  try {
    fs.mkdirSync(path.dirname(STAV_FILE), { recursive: true });
    const tmp = STAV_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(stavLib.exportJson(stav), null, 1));
    fs.renameSync(tmp, STAV_FILE);
  } catch (e) {
    console.error('Zápis stavu selhal: ' + e.message);
  }
}

// Jde do složky se stavem zapisovat? (bind mount s cizím vlastníkem by stav tiše ztrácel)
function dataWritable() {
  try {
    fs.mkdirSync(path.dirname(STAV_FILE), { recursive: true });
    fs.accessSync(path.dirname(STAV_FILE), fs.constants.W_OK);
    if (fs.existsSync(STAV_FILE)) fs.accessSync(STAV_FILE, fs.constants.W_OK);
    return true;
  } catch (_e) {
    return false;
  }
}

// ---------------------------------------------------------------- http pomocné
function baseHeaders(extra) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://*.tile-cyclosm.openstreetmap.fr https://*.tile.opentopomap.org; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    ...(extra || {}),
  };
}

function send(res, status, body, type, extra) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, baseHeaders({ 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data), ...(extra || {}) }));
  res.end(data);
}

function redirect(res, location, extra) {
  res.writeHead(302, baseHeaders({ Location: location, 'Cache-Control': 'no-store', ...(extra || {}) }));
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Tělo požadavku je příliš velké'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// jen relativní cesta v rámci webu (žádné //cizi.web), smí nést i #kraj=…
function safeNext(v) {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return '/';
  return v.slice(0, 600).replace(/[\r\n]/g, '');
}

// ---------------------------------------------------------------- přihlášení
function loginPage(opts) {
  const o = opts || {};
  return `<!doctype html>
<html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>Přihlášení – Cyklo &amp; Ski mapa</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{color-scheme:light dark;--bg:#eef1f5;--surface:#fff;--text:#15181d;--muted:#6f7784;--border:#c9cfd8;--primary:#1f5fbf;--danger:#c42f2f}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--surface:#171b21;--text:#e8ebf0;--muted:#858e9b;--border:#3a434f;--primary:#5b9cf5;--danger:#ef6b6b}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text)}
form{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:28px 28px 22px;width:min(380px,calc(100vw - 32px));box-shadow:0 4px 24px rgba(16,24,40,.12)}
h1{margin:0 0 4px;font-size:20px}p{margin:0 0 18px;color:var(--muted);font-size:13.5px}
label{display:block;font-size:12.5px;color:var(--muted);margin:10px 0 4px}
input{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font:inherit}
button{margin-top:16px;width:100%;padding:10px;border:0;border-radius:8px;background:var(--primary);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:var(--danger);font-size:13px;margin:10px 0 0}
</style></head><body>
<form method="post" action="/login" autocomplete="on">
<h1>🚲⛷️ Cyklo &amp; Ski mapa</h1><p>Přihlaste se – kontakty a stav oslovení jsou interní.</p>
<input type="hidden" name="next" value="${esc(o.next || '/')}">
<label for="jmeno">Jméno</label><input id="jmeno" name="jmeno" required autofocus autocomplete="username" value="${esc(o.jmeno || (USERS.size === 1 ? [...USERS.keys()][0] : ''))}">
<label for="heslo">Heslo</label><input id="heslo" name="heslo" type="password" required autocomplete="current-password">
${o.chyba ? `<div class="err">${esc(o.chyba)}</div>` : ''}
<button type="submit">Přihlásit</button>
</form><script src="/login.js"></script></body></html>`;
}

async function handleLogin(req, res, url) {
  if (req.method === 'GET') return send(res, 200, loginPage({ next: safeNext(url.searchParams.get('next')) }), 'text/html; charset=utf-8');
  if (req.method !== 'POST') return send(res, 405, { chyba: 'Nepodporovaná metoda' });
  const ip = clientIp(req);
  const form = new URLSearchParams(await readBody(req));
  const next = safeNext(form.get('next'));
  if (tooManyFailures(ip)) return send(res, 429, loginPage({ next, jmeno: form.get('jmeno'), chyba: 'Příliš mnoho pokusů. Zkuste to za 15 minut.' }), 'text/html; charset=utf-8');
  if (!checkLogin(form.get('jmeno'), form.get('heslo'))) {
    noteFailure(ip);
    return send(res, 401, loginPage({ next, jmeno: form.get('jmeno'), chyba: 'Nesprávné jméno nebo heslo.' }), 'text/html; charset=utf-8');
  }
  failures.delete(ip);
  const user = String(form.get('jmeno')).trim().toLowerCase();
  return redirect(res, next, { 'Set-Cookie': cookieHeader(makeSession(user), req, SESSION_DAYS * 86400) });
}

function handleLogout(req, res) {
  return redirect(res, '/login', { 'Set-Cookie': cookieHeader('', req, 0) });
}

// kdo volá: session, Bearer token (uživatel „api“) nebo nic
function identify(req) {
  if (!AUTH_ON) return { user: '', via: 'off' };
  if (TOKEN && req.headers.authorization === 'Bearer ' + TOKEN) return { user: 'api', via: 'token' };
  const s = readSession(req);
  return s ? { user: s.user, via: 'session' } : null;
}

// ---------------------------------------------------------------- API
async function handleApi(req, res, url, who) {
  if (url.pathname === '/api/health') {
    const zapis = dataWritable();
    return send(res, zapis ? 200 : 503, { ok: zapis, zaznamu: Object.keys(stav).length, zapis, verze: APP_VERSION || undefined, ...(zapis ? {} : { chyba: 'Do složky se stavem (' + path.dirname(STAV_FILE) + ') nejde zapisovat' }) });
  }
  if (!who) return send(res, 401, { chyba: 'Nepřihlášeno' });
  if (url.pathname === '/api/me') return send(res, 200, { jmeno: who.user, prihlaseni: AUTH_ON, verze: APP_VERSION || undefined });
  if (url.pathname === '/api/stav') {
    if (req.method === 'GET') return send(res, 200, stavLib.exportJson(stav));
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const im = stavLib.importJson(body);
      if (im.chyba) return send(res, 400, { chyba: im.chyba });
      for (const r of Object.values(im.stav)) if (!r.kdo && who.user) r.kdo = who.user;
      stav = stavLib.merge(stav, im.stav);
      scheduleWrite();
      return send(res, 200, { ok: true, zaznamu: Object.keys(stav).length });
    }
    return send(res, 405, { chyba: 'Nepodporovaná metoda' });
  }
  const m = /^\/api\/stav\/([^/]+)$/.exec(url.pathname);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!stavLib.isValidId(id)) return send(res, 400, { chyba: 'Neplatné id' });
    if (req.method === 'GET') return send(res, 200, stav[id] || stavLib.emptyRecord());
    if (req.method === 'PUT') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const rec = stavLib.normalizeRecord(body);
      if (who.user) rec.kdo = who.user;
      if (stavLib.isEmpty(rec)) delete stav[id];
      else stav[id] = rec;
      scheduleWrite();
      return send(res, 200, { ok: true, kdo: rec.kdo || '' });
    }
    if (req.method === 'DELETE') {
      delete stav[id];
      scheduleWrite();
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { chyba: 'Nepodporovaná metoda' });
  }
  return send(res, 404, { chyba: 'Neznámá cesta' });
}

// ---------------------------------------------------------------- statické soubory
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + path.sep) || p.includes('/.') || /^\/(cache|test|tools|node_modules|deploy)\//.test(p) || /^\/(server\.js|deploy\.sh|Dockerfile|package\.json|package-lock\.json|README\.md|NASAZENI\.md)$/.test(p) || file === STAV_FILE) {
    return send(res, 404, 'Nenalezeno', 'text/plain; charset=utf-8');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Nenalezeno', 'text/plain; charset=utf-8');
    const ext = path.extname(file).toLowerCase();
    const lastMod = new Date(Math.floor(st.mtimeMs / 1000) * 1000);
    const ims = req.headers['if-modified-since'];
    if (ims && !Number.isNaN(Date.parse(ims)) && Date.parse(ims) >= lastMod.getTime()) {
      res.writeHead(304, baseHeaders({ 'Last-Modified': lastMod.toUTCString() }));
      return res.end();
    }
    const headers = baseHeaders({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Last-Modified': lastMod.toUTCString(), 'Cache-Control': ext === '.html' ? 'no-cache' : 'private, max-age=300, must-revalidate' /* private: statika je za přihlášením – cache na okraji (Cloudflare) ji nesmí podat nepřihlášeným */, Vary: 'Accept-Encoding' });
    const gzip = COMPRESSIBLE.has(ext) && st.size > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (gzip) headers['Content-Encoding'] = 'gzip';
    else headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    if (gzip) stream.pipe(zlib.createGzip({ level: 6 })).pipe(res);
    else stream.pipe(res);
  });
}

// cesty dostupné bez přihlášení
function isPublic(p) {
  return p === '/login' || p === '/logout' || p === '/api/health' || p === '/favicon.svg' || p === '/login.js';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/login' && AUTH_ON) return await handleLogin(req, res, url);
    if (url.pathname === '/logout') return handleLogout(req, res);
    const who = identify(req);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, who);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { chyba: 'Nepodporovaná metoda' });
    if (!who && !isPublic(url.pathname)) {
      if (/\.(js|css|png|svg|json|map)$/.test(url.pathname)) return send(res, 401, 'Nepřihlášeno', 'text/plain; charset=utf-8');
      return redirect(res, '/login?next=' + encodeURIComponent(url.pathname + url.search));
    }
    if (url.pathname === '/login') return redirect(res, '/'); // přihlášení vypnuté
    return serveStatic(req, res, url);
  } catch (e) {
    send(res, e instanceof SyntaxError ? 400 : 500, { chyba: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Cyklo & Ski mapa běží na http://localhost:${PORT}  (stav oslovení: ${STAV_FILE}, ${Object.keys(stav).length} záznamů${APP_VERSION ? ', verze ' + APP_VERSION : ''})`);
    if (!dataWritable()) console.error(`CHYBA: do složky ${path.dirname(STAV_FILE)} nejde zapisovat – stav oslovení by se po restartu ztratil (práva / vlastník svazku).`);
    if (!AUTH_ON) console.log('Přihlášení je VYPNUTÉ (CSM_AUTH=0) – jen pro vývoj nebo vnitřní síť.');
    else if (GENERATED_PASSWORD) console.log(`Není nastavené CSM_USERS ani CSM_PASSWORD – dočasné heslo pro uživatele „tým“: ${GENERATED_PASSWORD}\n(při každém startu jiné; nastavte ho v .env)`);
    else console.log(`Přihlášení zapnuté, uživatelé: ${[...USERS.keys()].join(', ')}`);
  });
  const stop = () => {
    clearTimeout(writeTimer);
    writeStav();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { server, handleApi, loadStav, writeStav, parseUsers, safeNext, STAV_FILE, AUTH_ON };
