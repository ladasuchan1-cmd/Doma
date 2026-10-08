#!/usr/bin/env node
'use strict';
// Server mapy prodejen a servisů kol: servíruje aplikaci, hlídá přihlášení a ukládá sdílená data týmu do
// složky MP_DATA – stav spolupráce (stav.json), součty objednávek podle PSČ (objednavky.json), ručně přidaná
// místa (mista.json), obraty firem (obraty.json) a firmy dohledané v ARES (firmy.json). Bez něj aplikace funguje
// i z disku (file://), jen se stav ukládá do prohlížeče a nejde dohledávat v ARES ani nahrát objednávky pro tým.
//
//   node server.js            # http://localhost:8094
//
// Proměnné prostředí (viz .env.example):
//   PORT                port (8094)
//   MP_DATA             složka se sdílenými daty (./server-data); vedle nich .secret pro podpis cookie
//   MP_USERS            uživatelé „jmeno:heslo;jmeno2:heslo2“ – každá změna pak nese, kdo ji udělal
//   MP_PASSWORD         jedno společné heslo (uživatel „tým“), když MP_USERS nejsou
//   MP_AUTH=0           vypne přihlášení (jen pro vývoj / vnitřní síť)
//   MP_SECRET           klíč pro podpis session cookie (jinak se vygeneruje a uloží do .secret)
//   MP_SESSION_DAYS     platnost přihlášení ve dnech (30)
//   MP_TRUST_PROXY=1    za reverzní proxy (Caddy): cookie Secure podle X-Forwarded-Proto, IP z X-Forwarded-For
//   MP_TOKEN            Bearer token pro skripty (zálohy) na /api bez přihlášení
//   MP_REGISTRY=0       nedohledávat v ARES / RÚIAN (server bez přístupu ven)
//   ANTHROPIC_API_KEY   klíč Claude API – zapne asistenta mapy; MP_AI_MODEL (claude-opus-5-5), MP_AI_EFFORT (low)
//
// API: /api/health · /api/me · /api/stav[/<id>] · /api/objednavky · /api/mista[/<id>] · /api/obraty[/<ico>] · /api/nastaveni
//      · /api/firmy · /api/firma/<ico> (ARES + RES + souřadnice sídla) · /api/geokoduj?q=adresa (RÚIAN)
//      · /api/asistent (POST – jedno kolo konverzace s asistentem přes Claude API)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const stavLib = require('./lib/stav.js');
const objLib = require('./lib/objednavky.js');
const vlastni = require('./lib/vlastni.js');
const velikost = require('./lib/velikost.js');
const registry = require('./lib/ares.js');
const asistent = require('./lib/asistent-server.js');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8094);
const DATA_DIR = path.resolve(process.env.MP_DATA || path.join(ROOT, 'server-data'));
const TOKEN = process.env.MP_TOKEN || '';
const TRUST_PROXY = process.env.MP_TRUST_PROXY === '1';
const SESSION_DAYS = Math.max(1, Number(process.env.MP_SESSION_DAYS || 30));
const AUTH_ON = process.env.MP_AUTH !== '0';
const REGISTRY_ON = process.env.MP_REGISTRY !== '0';
const MAX_BODY = 4 * 1024 * 1024;
const COOKIE = 'mp_session';
const APP_VERSION = process.env.APP_VERSION || '';
const FIRMA_TTL_MS = 30 * 86400000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt']);

// ---------------------------------------------------------------- uživatelé
// „jana:heslo;petr:heslo2“ (oddělovač ; , nebo nový řádek) → Map(jméno malými písmeny → heslo)
function parseUsers(src) {
  const out = new Map();
  for (const part of String(src || '').split(/[;\n,]+/)) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const pass = part.slice(i + 1).trim();
    if (name && pass) out.set(name.slice(0, 60).toLowerCase(), pass);
  }
  return out;
}

const USERS = parseUsers(process.env.MP_USERS);
let GENERATED_PASSWORD = null;
if (AUTH_ON && !USERS.size) {
  if (process.env.MP_PASSWORD) USERS.set(process.env.MP_USER || 'tým', process.env.MP_PASSWORD);
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
    safeEqual('x', String(pass || ''));
    return false;
  }
  return safeEqual(expected, String(pass || ''));
}

// ---------------------------------------------------------------- session cookie
function loadSecret() {
  if (process.env.MP_SECRET) return process.env.MP_SECRET;
  const file = path.join(DATA_DIR, '.secret');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch (_e) { /* není – vytvoříme */ }
  const s = crypto.randomBytes(32).toString('base64url');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, s, { mode: 0o600 });
  } catch (e) {
    console.error('Nelze uložit tajný klíč do ' + file + ' (' + e.message + ') – přihlášení nepřežije restart. Nastavte MP_SECRET.');
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

// Brzda dotazů do ARES / RÚIAN: 60 za minutu na uživatele (registry nesmíme zahltit).
const lookups = new Map();
// Asistent (Claude API stojí peníze): 60 volání za 10 minut a 600 za den na uživatele. Jedna otázka bývá 2–3 volání.
const asks = new Map();
function tooManyAsks(user) {
  const now = Date.now();
  const arr = (asks.get(user) || []).filter((t) => now - t < 86400000);
  if (arr.length >= 600 || arr.filter((t) => now - t < 600000).length >= 60) {
    asks.set(user, arr);
    return true;
  }
  arr.push(now);
  asks.set(user, arr);
  return false;
}

function tooManyLookups(user) {
  const now = Date.now();
  const arr = (lookups.get(user) || []).filter((t) => now - t < 60000);
  if (arr.length >= 60) {
    lookups.set(user, arr);
    return true;
  }
  arr.push(now);
  lookups.set(user, arr);
  return false;
}

// ---------------------------------------------------------------- úložiště (JSON soubory v DATA_DIR)
// Zápis je atomický (tmp + rename) a odložený o 300 ms, aby série změn nepsala soubor stokrát.
function makeStore(name, empty, load, dump) {
  const file = path.join(DATA_DIR, name);
  let value = empty();
  let timer = null;
  try {
    if (fs.existsSync(file)) value = load(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    console.error(`Nelze načíst ${file}: ${e.message} – začínám s prázdným (původní soubor zůstává jako ${name}.chybny).`);
    try {
      fs.copyFileSync(file, file + '.chybny');
    } catch (_e) { /* nic */ }
    value = empty();
  }
  function write() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(dump ? dump(value) : value, null, 1));
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error(`Zápis ${file} selhal: ${e.message}`);
    }
  }
  return {
    get: () => value,
    set(v) {
      value = v;
      clearTimeout(timer);
      timer = setTimeout(write, 300);
    },
    flush() {
      clearTimeout(timer);
      write();
    },
    file,
  };
}

const stavStore = makeStore('stav.json', () => ({}), (j) => stavLib.importJson(j).stav || {}, (v) => stavLib.exportJson(v));
const objStore = makeStore('objednavky.json', () => null, (j) => (j && j.mista ? objLib.validovat(j).data || null : null));
const mistaStore = makeStore('mista.json', () => ({}), (j) => {
  const out = {};
  for (const m of Object.values((j && j.mista) || {})) {
    const n = vlastni.normalizeMisto(m, m && m.id);
    if (n.misto) out[n.misto.id] = { ...n.misto, kdo: m.kdo || '', vytvoreno: m.vytvoreno || n.misto.vytvoreno, upraveno: m.upraveno || n.misto.upraveno };
  }
  return out;
}, (v) => ({ app: 'mapa-prodejen', mista: v }));
const obratyStore = makeStore('obraty.json', () => ({}), (j) => {
  const out = {};
  for (const [ico, r] of Object.entries((j && j.obraty) || {})) {
    const n = vlastni.normalizeObrat(r);
    if (vlastni.validIco(ico) && n.obrat) out[ico] = n.obrat;
  }
  return out;
}, (v) => ({ app: 'mapa-prodejen', obraty: v }));
const firmyStore = makeStore('firmy.json', () => ({}), (j) => (j && j.firmy && typeof j.firmy === 'object' ? j.firmy : {}), (v) => ({ app: 'mapa-prodejen', firmy: v }));
// Nastavení týmu: IČO naší firmy (naše prodejny = pokrytí při hledání bílých míst).
function normNastaveni(j) {
  const ico = (Array.isArray(j && j.naseIco) ? j.naseIco : []).map((x) => vlastni.normIco(x)).filter(Boolean);
  return { naseIco: [...new Set(ico)].slice(0, 20) };
}
const nastaveniStore = makeStore('nastaveni.json', () => ({ naseIco: [] }), normNastaveni);
const STORES = [stavStore, objStore, mistaStore, obratyStore, firmyStore, nastaveniStore];

// Jde do datové složky zapisovat? (svazek s cizím vlastníkem by data tiše ztrácel)
function dataWritable() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    for (const s of STORES) if (fs.existsSync(s.file)) fs.accessSync(s.file, fs.constants.W_OK);
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
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://*.tile-cyclosm.openstreetmap.fr; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    ...(extra || {}),
  };
}

function send(res, status, body, type, extra) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, baseHeaders({ 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data), ...(extra || {}) }));
  res.end(data);
}

// JSON odpověď, větší gzipem (součty objednávek, seznam míst)
function sendJson(req, res, status, obj) {
  const data = Buffer.from(JSON.stringify(obj));
  if (data.length > 2048 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    const gz = zlib.gzipSync(data, { level: 6 });
    res.writeHead(status, baseHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Encoding': 'gzip', 'Content-Length': gz.length, Vary: 'Accept-Encoding' }));
    return res.end(gz);
  }
  return send(res, status, data, 'application/json; charset=utf-8');
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
        reject(Object.assign(new Error('Tělo požadavku je příliš velké'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  return JSON.parse(text || '{}');
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
<title>Přihlášení – Mapa prodejen a servisů kol</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
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
<h1>🚲 Mapa prodejen a servisů kol</h1><p>Přihlaste se – kontakty, objednávky a stav spolupráce jsou interní.</p>
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

// ---------------------------------------------------------------- registry (ARES, RÚIAN)
const pending = new Map(); // IČO → probíhající dotaz (dva klienti naráz = jeden dotaz do ARES)

async function firmaSouradnice(ico) {
  const cache = firmyStore.get();
  const c = cache[ico];
  if (c && c.kdy && Date.now() - Date.parse(c.kdy) < FIRMA_TTL_MS) return c;
  if (pending.has(ico)) return pending.get(ico);
  const p = (async () => {
    const firma = await registry.firmaPodleIco(ico);
    if (!firma) return null;
    let souradnice = null;
    if (firma.am) {
      try {
        const am = await registry.adresniMista([firma.am]);
        souradnice = am.get(firma.am) || null;
      } catch (_e) {
        souradnice = null;
      }
    }
    if (!souradnice && firma.sidlo) {
      try {
        const g = await registry.geokoduj(firma.sidlo, 1);
        if (g[0] && g[0].skore >= 90) souradnice = [g[0].lat, g[0].lon];
      } catch (_e) { /* bez souřadnic */ }
    }
    firma.velikost = velikost.urci({ zam: firma.zam, forma: firma.forma, ico }).key;
    const rec = { kdy: new Date().toISOString(), firma, souradnice };
    const next = { ...firmyStore.get(), [ico]: rec };
    firmyStore.set(next);
    return rec;
  })();
  pending.set(ico, p);
  try {
    return await p;
  } finally {
    pending.delete(ico);
  }
}

// ---------------------------------------------------------------- API
async function handleApi(req, res, url, who) {
  const p = url.pathname;
  if (p === '/api/health') {
    const zapis = dataWritable();
    const o = objStore.get();
    return send(res, zapis ? 200 : 503, {
      ok: zapis,
      zapis,
      verze: APP_VERSION || undefined,
      zaznamu: Object.keys(stavStore.get()).length,
      mist: Object.keys(mistaStore.get()).length,
      obratu: Object.keys(obratyStore.get()).length,
      objednavek: o ? o.objednavek : 0,
      ...(zapis ? {} : { chyba: 'Do datové složky (' + DATA_DIR + ') nejde zapisovat' }),
    });
  }
  if (!who) return send(res, 401, { chyba: 'Nepřihlášeno' });
  if (p === '/api/me') return send(res, 200, { jmeno: who.user, prihlaseni: AUTH_ON, registry: REGISTRY_ON, asistent: asistent.nastaveni().zapnuto, verze: APP_VERSION || undefined });

  // ---- asistent (Claude): prohlížeč posílá celou konverzaci, server přidá prompt a nástroje, drží klíč API
  if (p === '/api/asistent') {
    if (req.method !== 'POST') return send(res, 405, { chyba: 'Nepodporovaná metoda' });
    if (!asistent.nastaveni().zapnuto) return send(res, 503, { chyba: 'Asistent není zapnutý – na serveru chybí klíč Claude API (ANTHROPIC_API_KEY).' });
    if (tooManyAsks(who.user || clientIp(req))) return send(res, 429, { chyba: 'Příliš mnoho dotazů na asistenta – zkuste to za pár minut.' });
    const body = await readJson(req);
    const v = asistent.overZpravy(body && body.messages);
    if (v.chyba) return send(res, 400, { chyba: v.chyba });
    try {
      const r = await asistent.zeptat(v.zpravy);
      const u = r.usage || {};
      console.log(`asistent: ${who.user || '-'} ${r.model} ${r.stop_reason} vstup ${u.input_tokens || 0} (+${u.cache_read_input_tokens || 0} z cache) výstup ${u.output_tokens || 0}`);
      return send(res, 200, { content: r.content, stop_reason: r.stop_reason, stop_details: r.stop_details, model: r.model });
    } catch (e) {
      const c = asistent.chyba(e);
      console.error('asistent: chyba', c.status, e && e.message ? e.message.slice(0, 300) : '');
      return send(res, c.status, { chyba: c.chyba });
    }
  }

  // ---- stav spolupráce
  if (p === '/api/stav') {
    if (req.method === 'GET') return sendJson(req, res, 200, stavLib.exportJson(stavStore.get()));
    if (req.method === 'PUT' || req.method === 'POST') {
      const im = stavLib.importJson(await readJson(req));
      if (im.chyba) return send(res, 400, { chyba: im.chyba });
      for (const r of Object.values(im.stav)) if (!r.kdo && who.user) r.kdo = who.user;
      stavStore.set(stavLib.merge(stavStore.get(), im.stav));
      return send(res, 200, { ok: true, zaznamu: Object.keys(stavStore.get()).length });
    }
    return send(res, 405, { chyba: 'Nepodporovaná metoda' });
  }
  let m = /^\/api\/stav\/([^/]+)$/.exec(p);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!stavLib.isValidId(id)) return send(res, 400, { chyba: 'Neplatné id' });
    const all = stavStore.get();
    if (req.method === 'GET') return send(res, 200, all[id] || stavLib.emptyRecord());
    if (req.method === 'PUT') {
      const rec = stavLib.normalizeRecord(await readJson(req));
      if (who.user) rec.kdo = who.user;
      const next = { ...all };
      if (stavLib.isEmpty(rec)) delete next[id];
      else next[id] = rec;
      stavStore.set(next);
      return send(res, 200, { ok: true, kdo: rec.kdo || '' });
    }
    if (req.method === 'DELETE') {
      const next = { ...all };
      delete next[id];
      stavStore.set(next);
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { chyba: 'Nepodporovaná metoda' });
  }

  // ---- objednávky (jen součty podle PSČ)
  if (p === '/api/objednavky') {
    if (req.method === 'GET') return sendJson(req, res, 200, objStore.get() || { mista: [], objednavek: 0 });
    if (req.method === 'PUT') {
      const v = objLib.validovat(await readJson(req));
      if (v.chyba) return send(res, 400, { chyba: v.chyba });
      v.data.kdo = who.user || v.data.kdo;
      v.data.nahrano = new Date().toISOString();
      objStore.set(v.data);
      return send(res, 200, { ok: true, objednavek: v.data.objednavek, psc: v.data.mista.length });
    }
    if (req.method === 'DELETE') {
      objStore.set(null);
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { chyba: 'Nepodporovaná metoda' });
  }

  // ---- ručně přidaná místa
  if (p === '/api/mista') {
    if (req.method === 'GET') return sendJson(req, res, 200, { mista: Object.values(mistaStore.get()) });
    if (req.method === 'POST') {
      const n = vlastni.normalizeMisto(await readJson(req));
      if (n.chyba) return send(res, 400, { chyba: n.chyba });
      if (Object.keys(mistaStore.get()).length >= 5000) return send(res, 400, { chyba: 'Příliš mnoho ručně přidaných míst (5 000).' });
      n.misto.kdo = who.user;
      mistaStore.set({ ...mistaStore.get(), [n.misto.id]: n.misto });
      return send(res, 200, { ok: true, misto: n.misto });
    }
    return send(res, 405, { chyba: 'Nepodporovaná metoda' });
  }
  m = /^\/api\/mista\/(v[0-9a-z]{6,16})$/.exec(p);
  if (m) {
    const id = m[1];
    const all = mistaStore.get();
    if (req.method === 'PUT') {
      if (!all[id]) return send(res, 404, { chyba: 'Místo neexistuje' });
      const n = vlastni.normalizeMisto({ ...(await readJson(req)), vytvoreno: all[id].vytvoreno }, id);
      if (n.chyba) return send(res, 400, { chyba: n.chyba });
      n.misto.kdo = who.user;
      mistaStore.set({ ...all, [id]: n.misto });
      return send(res, 200, { ok: true, misto: n.misto });
    }
    if (req.method === 'DELETE') {
      const next = { ...all };
      delete next[id];
      mistaStore.set(next);
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { chyba: 'Nepodporovaná metoda' });
  }

  // ---- obraty firem (import z účetních závěrek / placených databází, ruční zadání)
  if (p === '/api/obraty') {
    if (req.method === 'GET') return sendJson(req, res, 200, { obraty: obratyStore.get() });
    if (req.method === 'PUT') {
      const body = await readJson(req);
      const src = body && typeof body.obraty === 'object' ? body.obraty : null;
      if (!src) return send(res, 400, { chyba: 'Chybí položka „obraty“.' });
      const next = { ...obratyStore.get() };
      let n = 0;
      const chyby = [];
      for (const [ico, r] of Object.entries(src).slice(0, 20000)) {
        const i = vlastni.normIco(ico);
        const o = vlastni.normalizeObrat({ ...r, kdo: who.user });
        if (!i || o.chyba) {
          if (chyby.length < 20) chyby.push(ico + ': ' + (o.chyba || 'neplatné IČO'));
          continue;
        }
        next[i] = o.obrat;
        n++;
      }
      obratyStore.set(next);
      return send(res, 200, { ok: true, ulozeno: n, chyby });
    }
    return send(res, 405, { chyba: 'Nepodporovaná metoda' });
  }
  m = /^\/api\/obraty\/(\d{8})$/.exec(p);
  if (m) {
    const ico = m[1];
    if (!vlastni.validIco(ico)) return send(res, 400, { chyba: 'Neplatné IČO' });
    if (req.method === 'PUT') {
      const o = vlastni.normalizeObrat({ ...(await readJson(req)), kdo: who.user });
      if (o.chyba) return send(res, 400, { chyba: o.chyba });
      obratyStore.set({ ...obratyStore.get(), [ico]: o.obrat });
      return send(res, 200, { ok: true, obrat: o.obrat });
    }
    if (req.method === 'DELETE') {
      const next = { ...obratyStore.get() };
      delete next[ico];
      obratyStore.set(next);
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { chyba: 'Nepodporovaná metoda' });
  }

  // ---- nastavení týmu
  if (p === '/api/nastaveni') {
    if (req.method === 'GET') return send(res, 200, nastaveniStore.get());
    if (req.method === 'PUT') {
      const n = normNastaveni(await readJson(req));
      nastaveniStore.set(n);
      return send(res, 200, { ok: true, ...n });
    }
    return send(res, 405, { chyba: 'Nepodporovaná metoda' });
  }

  // ---- firmy dohledané v ARES (sdílené pro všechny)
  if (p === '/api/firmy' && req.method === 'GET') {
    const out = {};
    for (const [ico, r] of Object.entries(firmyStore.get())) if (r && r.firma) out[ico] = { ...r.firma, souradnice: r.souradnice || undefined, kdy: r.kdy };
    return sendJson(req, res, 200, { firmy: out });
  }
  m = /^\/api\/firma\/(\d{1,8})$/.exec(p);
  if (m && req.method === 'GET') {
    const ico = vlastni.normIco(m[1]);
    if (!ico) return send(res, 400, { chyba: 'IČO nemá platný kontrolní součet.' });
    if (!REGISTRY_ON) return send(res, 503, { chyba: 'Dohledání v ARES je na tomto serveru vypnuté.' });
    if (tooManyLookups(who.user || clientIp(req))) return send(res, 429, { chyba: 'Příliš mnoho dotazů do ARES – zkuste to za minutu.' });
    try {
      const r = await firmaSouradnice(ico);
      if (!r) return send(res, 404, { chyba: 'Firma s IČO ' + ico + ' v ARES není.' });
      return send(res, 200, { firma: r.firma, souradnice: r.souradnice, kdy: r.kdy });
    } catch (e) {
      return send(res, 502, { chyba: 'ARES neodpovídá (' + e.message + '). Zkuste to později.' });
    }
  }
  if (p === '/api/geokoduj' && req.method === 'GET') {
    const q = String(url.searchParams.get('q') || '').trim();
    if (q.length < 3) return send(res, 400, { chyba: 'Zadejte adresu (aspoň obec).' });
    if (!REGISTRY_ON) return send(res, 503, { chyba: 'Dohledání adres je na tomto serveru vypnuté.' });
    if (tooManyLookups(who.user || clientIp(req))) return send(res, 429, { chyba: 'Příliš mnoho dotazů – zkuste to za minutu.' });
    try {
      return send(res, 200, { kandidati: await registry.geokoduj(q, 6) });
    } catch (e) {
      return send(res, 502, { chyba: 'Vyhledávání adres (RÚIAN) neodpovídá (' + e.message + ').' });
    }
  }
  return send(res, 404, { chyba: 'Neznámá cesta' });
}

// ---------------------------------------------------------------- statické soubory
const BLOCKED = /^\/(cache|test|tools|node_modules|deploy|docs|server-data)\//;
const BLOCKED_FILES = /^\/(server\.js|Dockerfile|package\.json|package-lock\.json|README\.md|NASAZENI\.md|lib\/ares\.js|lib\/asistent-server\.js)$/;

function serveStatic(req, res, url) {
  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch (_e) {
    return send(res, 400, 'Neplatná cesta', 'text/plain; charset=utf-8');
  }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + path.sep) || p.includes('/.') || p.includes('\0') || BLOCKED.test(p) || BLOCKED_FILES.test(p) || file.startsWith(DATA_DIR + path.sep)) {
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
    // private: statika je za přihlášením – cache na okraji (Cloudflare) ji nesmí podat nepřihlášeným
    const headers = baseHeaders({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Last-Modified': lastMod.toUTCString(), 'Cache-Control': ext === '.html' ? 'no-cache' : 'private, max-age=300, must-revalidate', Vary: 'Accept-Encoding' });
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
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (_e) {
    return send(res, 400, { chyba: 'Neplatná adresa' });
  }
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
    const status = e.status || (e instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error(e);
    if (!res.headersSent) send(res, status, { chyba: e instanceof SyntaxError ? 'Neplatný JSON' : e.message });
  }
});

function flushAll() {
  for (const s of STORES) s.flush();
}

if (require.main === module) {
  server.listen(PORT, () => {
    const o = objStore.get();
    console.log(`Mapa prodejen běží na http://localhost:${PORT}  (data: ${DATA_DIR}; stav ${Object.keys(stavStore.get()).length}, vlastní místa ${Object.keys(mistaStore.get()).length}, obraty ${Object.keys(obratyStore.get()).length}, objednávek ${o ? o.objednavek : 0}${APP_VERSION ? ', verze ' + APP_VERSION : ''})`);
    if (!dataWritable()) console.error(`CHYBA: do složky ${DATA_DIR} nejde zapisovat – data týmu by se po restartu ztratila (práva / vlastník svazku).`);
    if (!AUTH_ON) console.log('Přihlášení je VYPNUTÉ (MP_AUTH=0) – jen pro vývoj nebo vnitřní síť.');
    else if (GENERATED_PASSWORD) console.log(`Není nastavené MP_USERS ani MP_PASSWORD – dočasné heslo pro uživatele „tým“: ${GENERATED_PASSWORD}\n(při každém startu jiné; nastavte ho v .env)`);
    else console.log(`Přihlášení zapnuté, uživatelé: ${[...USERS.keys()].join(', ')}`);
    if (!REGISTRY_ON) console.log('Dohledání v ARES a RÚIAN je vypnuté (MP_REGISTRY=0).');
  });
  const stop = () => {
    flushAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { server, handleApi, parseUsers, safeNext, flushAll, DATA_DIR, AUTH_ON, stores: { stavStore, objStore, mistaStore, obratyStore, firmyStore, nastaveniStore } };
