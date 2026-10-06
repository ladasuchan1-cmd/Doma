'use strict';
// Pomocníci pro testy (SPEC kap. 1): spustí server na náhodném portu s dočasným PK_DATA a kopií tenants/demo
// v dočasném PK_TENANTS, vrátí fetch s cookie jar + CSRF helperem a funkci stop().
//   const srv = await startServer(); const res = await srv.fetch('/'); … await srv.stop();
// fetch přidává hlavičku Origin u POST/PUT/PATCH/DELETE (jako prohlížeč; vypne init.noOrigin), sleduje Set-Cookie
// (jedna doména), umožňuje přepsat Host (přes node:http – globální fetch to neumí) a nesleduje přesměrování.
// Výchozí env vypíná automatické naplnění demo dat při startu (PK_DEMO_AUTOSEED=0) – test si data naplní sám, nebo
// předá env { PK_DEMO_AUTOSEED: '1' }.
// Vstup: { env } (přepisy proměnných prostředí), { startJobs }. Výstup: { url, port, fetch, csrf, stop, db, dataDir, tenantsDir, app, instance }.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { createLogger } = require('../src/log');

const ROOT = path.resolve(__dirname, '..');
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Jednoduchý cookie jar (ignoruje Domain/Path – testy běží proti jedinému hostu). */
function createCookieJar() {
  const cookies = new Map();
  return {
    store(setCookieHeaders) {
      for (const sc of setCookieHeaders || []) {
        const [pair, ...attrs] = sc.split(';');
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        const maxAge = attrs.map((a) => a.trim().toLowerCase()).find((a) => a.startsWith('max-age='));
        if ((maxAge && Number(maxAge.slice(8)) <= 0) || value === '') cookies.delete(name);
        else cookies.set(name, decodeURIComponent(value));
      }
    },
    header() {
      return [...cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    },
    get(name) {
      return cookies.get(name);
    },
    set(name, value) {
      cookies.set(name, value);
    },
    clear() {
      cookies.clear();
    },
    all() {
      return Object.fromEntries(cookies);
    },
  };
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Vytvoří dočasné adresáře (data + tenants s kopií demo) a vrátí env pro server. */
function tempEnv(overrides = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-test-'));
  const dataDir = path.join(base, 'data');
  const tenantsDir = path.join(base, 'tenants');
  copyDir(path.join(ROOT, 'tenants', 'demo'), path.join(tenantsDir, 'demo'));
  const env = {
    PK_DATA: dataDir,
    PK_TENANTS: tenantsDir,
    PK_DEMO: '1',
    PK_TRUST_PROXY: '0',
    PK_SECRET: 'test-secret-test-secret-test-secret-0123456789',
    PK_RESET_DEMO_HOUR: '',
    PK_DEMO_AUTOSEED: '0', // testy začínají s prázdnou DB; demo data si test naplní sám (tools/demo-data seed())
    APP_VERSION: 'test',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
  return { base, dataDir, tenantsDir, env };
}

/**
 * Spustí server pro test.
 * @param {{env?: object, startJobs?: boolean, log?: object}} [opts]
 */
async function startServer(opts = {}) {
  const { base, dataDir, tenantsDir, env } = tempEnv(opts.env);
  const { start } = require('../server');
  const log = opts.log || createLogger({ level: 'silent' });
  const instance = await start({ env, port: 0, host: '127.0.0.1', quiet: true, log, startJobs: opts.startJobs === true });
  const jar = createCookieJar();
  const url = instance.url;

  /**
   * HTTP požadavek přes node:http (globální fetch neumí přepsat hlavičku Host). Vrací objekt kompatibilní s Response:
   * status, headers (Headers včetně getSetCookie), text(), json(). Přesměrování se nesledují.
   */
  function doFetch(pathOrUrl, init = {}) {
    const target = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : url + pathOrUrl);
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
    const cookie = jar.header();
    if (cookie && !headers.cookie) headers.cookie = cookie;
    const method = (init.method || 'GET').toUpperCase();
    if (UNSAFE.has(method) && !headers.origin && init.noOrigin !== true) headers.origin = url;
    let body = init.body;
    if (body && typeof body === 'object' && !(body instanceof URLSearchParams) && !Buffer.isBuffer(body) && typeof body !== 'string') {
      body = new URLSearchParams(body);
    }
    if (body instanceof URLSearchParams) {
      body = body.toString();
      if (!headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    if (body !== undefined && body !== null) headers['content-length'] = String(Buffer.byteLength(body));
    return new Promise((resolve, reject) => {
      const req = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const setCookies = res.headers['set-cookie'] || [];
          jar.store(setCookies);
          const pairs = [];
          for (const [k, v] of Object.entries(res.headers)) {
            if (k === 'set-cookie') for (const c of v) pairs.push([k, c]);
            else pairs.push([k, Array.isArray(v) ? v.join(', ') : v]);
          }
          const h = new Headers(pairs);
          let decoded = raw;
          const enc = res.headers['content-encoding'];
          if (raw.length && enc === 'gzip') decoded = zlib.gunzipSync(raw);
          else if (raw.length && enc === 'br') decoded = zlib.brotliDecompressSync(raw);
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            headers: h,
            text: async () => decoded.toString('utf8'),
            json: async () => JSON.parse(decoded.toString('utf8')),
            arrayBuffer: async () => decoded,
          });
        });
      });
      req.on('error', reject);
      if (body !== undefined && body !== null) req.write(body);
      req.end();
    });
  }

  /** Načte stránku a vrátí CSRF token z hidden inputu _csrf (založí session). */
  async function csrf(pathname = '/kontakt') {
    const res = await doFetch(pathname);
    const html = await res.text();
    const m = /name="_csrf" value="([^"]+)"/.exec(html);
    if (!m) throw new Error(`Na ${pathname} není CSRF token.`);
    return m[1];
  }

  async function stop() {
    await instance.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }

  return {
    url,
    port: instance.port,
    fetch: doFetch,
    csrf,
    jar,
    stop,
    db: instance.dbs.get('demo'),
    dbs: instance.dbs,
    dataDir,
    tenantsDir,
    tenant: instance.tenants.find((t) => t.slug === 'demo'),
    app: instance.app,
    instance,
    env,
  };
}

/** Otevře DB v paměti s migracemi (pro jednotkové testy). */
function memoryDb() {
  const { openDb } = require('../src/db');
  return openDb(':memory:');
}

/** Minimální mock req/res pro jednotkové testy session/context. */
function mockReqRes({ method = 'GET', url = '/', headers = {}, host = 'localhost:8092' } = {}) {
  const req = { method, url, headers: { host, ...headers }, socket: { remoteAddress: '127.0.0.1', encrypted: false } };
  const res = {
    headers: {},
    statusCode: 200,
    body: null,
    ended: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return this.headers[k.toLowerCase()];
    },
    removeHeader(k) {
      delete this.headers[k.toLowerCase()];
    },
    writeHead(status, headers) {
      this.statusCode = status;
      for (const [k, v] of Object.entries(headers || {})) this.setHeader(k, v);
    },
    end(body) {
      this.body = body;
      this.ended = true;
    },
  };
  return { req, res };
}

module.exports = { startServer, tempEnv, createCookieJar, memoryDb, mockReqRes, ROOT };
