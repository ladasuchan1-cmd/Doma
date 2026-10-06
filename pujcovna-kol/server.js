'use strict';
// Půjčovna kol – vstupní bod serveru (SPEC kap. 3).
//   node --disable-warning=ExperimentalWarning server.js
// Start: loadConfig → tajemství → tenanty → DB + migrace + settings → admin z env → (demo: prázdná tabulka bike_types
//        → automaticky seed z tools/demo-data.js, bez resetu; vypne PK_DEMO_AUTOSEED=0) → features (src/features/*.js)
//        → jobs → listen. Health: GET /api/health → { ok, version, tenant, theme }.
// Export start(options) pro testy (test/helpers.js): vrací { server, port, url, app, stop }.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadConfig, ensureSecret } = require('./src/config');
const defaultLog = require('./src/log');
const { openTenantDb, nowIso } = require('./src/db');
const { loadTenants, resolveTenant, themeForHost, seedSettings } = require('./src/tenants');
const { isTheme } = require('./src/themes');
const { createFieldCrypto } = require('./src/crypto/fields');
const { hashPassword, generatePassword } = require('./src/crypto/passwords');
const { createRouter } = require('./src/http/router');
const { createContext } = require('./src/http/context');
const { applySecurityHeaders, isSecureRequest } = require('./src/http/headers');
const { createRateLimiter } = require('./src/http/ratelimit');
const { serveStatic, mimeType } = require('./src/http/static');
const csrf = require('./src/http/csrf');
const { HttpError, sendErrorPage, serverError } = require('./src/http/errors');
const { parseCookies, purgeExpired } = require('./src/http/session');
const { createJobs } = require('./src/jobs');
const klienti = require('./src/klienti');

const DESIGN_COOKIE = '__Host-pk_design';
const FEATURES_DIR = path.join(__dirname, 'src', 'features');

// ---------------------------------------------------------------------------------------------------------
// Features

/**
 * Načte všechny src/features/*.js (chybějící adresář / soubory ignoruje), zaregistruje routy, navigaci a jobs.
 * @returns {{ features: object, nav: object[], jobs: object[], loaded: string[] }}
 */
function loadFeatures({ config, log, router, dir = FEATURES_DIR }) {
  const features = {};
  const nav = [];
  const jobs = [];
  const loaded = [];
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .sort();
  } catch {
    return { features, nav, jobs, loaded };
  }
  for (const file of files) {
    const full = path.join(dir, file);
    let mod;
    try {
      mod = require(full);
    } catch (e) {
      log.error('Feature modul nelze načíst', { file, error: e.message });
      continue;
    }
    if (!mod || typeof mod !== 'object' || !mod.name) {
      log.warn('Feature modul bez name – přeskočen', { file });
      continue;
    }
    if (mod.demoOnly && !config.demo) continue;
    if (features[mod.name]) {
      log.warn('Duplicitní feature – přeskočena', { file, name: mod.name });
      continue;
    }
    features[mod.name] = { name: mod.name, css: Array.isArray(mod.css) ? mod.css : [], js: Array.isArray(mod.js) ? mod.js : [], module: mod };
    for (const route of mod.routes || []) {
      const [method, pattern, handler, opts] = route;
      router.add(method, pattern, handler, { ...(opts || {}), feature: mod.name });
    }
    for (const item of mod.nav || []) nav.push({ ...item, feature: mod.name });
    for (const job of mod.jobs || []) jobs.push({ ...job, feature: mod.name });
    loaded.push(mod.name);
  }
  nav.sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || String(a.label).localeCompare(String(b.label), 'cs'));
  return { features, nav, jobs, loaded };
}

// ---------------------------------------------------------------------------------------------------------
// Admin při prvním startu

/** Není-li žádný uživatel, vytvoří admina z env (PK_ADMIN_USER / PK_ADMIN_PASSWORD). Vrací vygenerované heslo, nebo null. */
function ensureAdmin(db, config) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return { created: false, generatedPassword: null };
  const password = config.adminPassword || generatePassword(16);
  db.prepare('INSERT INTO users(email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
    String(config.adminUser).trim().toLowerCase(),
    'Správce',
    hashPassword(password),
    'owner',
    nowIso()
  );
  return { created: true, generatedPassword: config.adminPassword ? null : password };
}

/**
 * Demo režim: je-li tabulka bike_types prázdná (první start, nový svazek), naplní demo data z tools/demo-data.js
 * (idempotentně, bez resetu). Chyba seedu server nezastaví – jen se zaloguje.
 * @returns {Promise<boolean>} true, pokud se seedovalo
 */
async function autoSeedDemo({ db, tenant, config, fieldCrypto, log }) {
  if (!config.demo || !config.demoAutoSeed) return false;
  let empty;
  try {
    empty = db.prepare('SELECT COUNT(*) AS n FROM bike_types').get().n === 0;
  } catch {
    return false;
  }
  if (!empty) return false;
  try {
    const demoData = require('./tools/demo-data');
    const startedAt = Date.now();
    await demoData.seed({ db, tenant, config, fieldCrypto, reset: false, log });
    log.info('Demo data automaticky naplněna (tabulka bike_types byla prázdná)', { tenant: tenant.slug, ms: Date.now() - startedAt });
    return true;
  } catch (e) {
    log.error('Automatické naplnění demo dat selhalo – server startuje bez nich (spusťte npm run demo-data)', { tenant: tenant.slug, error: e.message });
    return false;
  }
}

function printPasswordBanner(email, password) {
  const line = '='.repeat(64);
  console.log(['', line, '  Půjčovna kol – první spuštění: vytvořen účet správce', '', `  Přihlašovací e-mail:  ${email}`, `  Heslo:                ${password}`, '', '  Heslo si uložte – znovu se už nezobrazí.', line, ''].join('\n'));
}

// ---------------------------------------------------------------------------------------------------------
// Aplikace (request handler)

function resolveTheme({ tenant, hostHeader, cookies, url, demo }) {
  if (demo) {
    const q = url.searchParams.get('design');
    if (isTheme(q)) return q;
    const c = cookies[DESIGN_COOKIE];
    if (isTheme(c)) return c;
  }
  return themeForHost(tenant, hostHeader);
}

function sendPlain(res, status, text) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

/**
 * Vytvoří aplikaci: request listener s připojenými závislostmi.
 * @param {{config, log, tenants, dbs: Map, secret, fieldCrypto, router, features, nav}} deps
 */
function createApp(deps) {
  const { config, log, tenants, dbs, router } = deps;
  const rateLimiter = createRateLimiter();
  const clientConfig = Object.freeze({ ...config, demo: false });

  async function handle(req, res) {
    const requestId = crypto.randomBytes(6).toString('base64url');
    const secure = isSecureRequest(req, config);
    applySecurityHeaders(res, { secure });
    const hostHeader = req.headers.host || 'localhost';
    let url;
    try {
      url = new URL(req.url || '/', `${secure ? 'https' : 'http'}://${hostHeader.replace(/[^A-Za-z0-9.:\-[\]]/g, '') || 'localhost'}`);
    } catch {
      return sendPlain(res, 400, 'Neplatná adresa.');
    }
    const reqLog = log.child({ rid: requestId });

    const tenant = resolveTenant(tenants, hostHeader, { demo: config.demo });
    if (!tenant) return sendPlain(res, 404, 'Půjčovna nenalezena.');
    const db = dbs.get(tenant.slug);
    // Web klienta (založený průvodcem) nikdy nedostane demo chování ukázkové půjčovny (veřejné demo heslo,
    // přepínač designů, noční reset); v náhledovém provozu má jen simulované platby a pruh „náhledový provoz“.
    const isClient = klienti.isClientTenant(tenant);
    const reqConfig = isClient && config.demo ? clientConfig : config;
    if (isClient && tenant.stav === 'pozastaven' && url.pathname !== '/api/health') {
      res.setHeader('Retry-After', '86400');
      return sendPlain(res, 503, 'Web půjčovny je dočasně mimo provoz.');
    }

    // statické soubory
    if (await serveStatic(req, res, { publicDir: config.publicDir, pathname: url.pathname })) return undefined;
    const logoMatch = /^\/tenant\/(logo\.(?:svg|png|jpg|webp))$/.exec(url.pathname);
    if (logoMatch && (req.method === 'GET' || req.method === 'HEAD')) return serveTenantFile(req, res, tenant, logoMatch[1]);

    const cookies = parseCookies(req.headers.cookie);
    const theme = resolveTheme({ tenant, hostHeader, cookies, url, demo: reqConfig.demo });
    const matched = router.match(req.method, url.pathname);
    const ctx = createContext({ req, res, app, config: reqConfig, tenant, db, theme, url, params: matched.params || {}, opts: matched.opts || {}, log: reqLog, requestId, secure });
    ctx.klient = isClient;
    ctx.nahled = isClient && tenant.stav === 'nahled';
    ctx.simulacePlateb = !!reqConfig.demo || ctx.nahled;

    try {
      if (matched.status === 404) throw new HttpError(404);
      if (matched.status === 405) {
        res.setHeader('Allow', matched.allow.join(', '));
        throw new HttpError(405);
      }
      const rlKey = matched.opts.rateLimit || (url.pathname.startsWith('/api/') ? 'api' : 'public');
      const rl = rateLimiter.consume(ctx.ip, rlKey);
      if (!rl.allowed) {
        res.setHeader('Retry-After', String(rl.retryAfterSec));
        throw new HttpError(429, `Příliš mnoho požadavků. Zkuste to znovu za ${rl.retryAfterSec} s.`);
      }
      if (csrf.UNSAFE_METHODS.has(req.method)) await ctx.readBody();
      if (matched.opts.csrf) csrf.verify(ctx, { sessionKind: matched.opts.csrfSession || 'public' });
      await matched.handler(ctx);
      if (!ctx.finished) {
        reqLog.warn('Handler neodeslal odpověď', { path: url.pathname });
        throw new HttpError(500);
      }
    } catch (e) {
      if (ctx.finished) {
        reqLog.error('Chyba po odeslání odpovědi', { error: e && e.message });
        return undefined;
      }
      if (e instanceof HttpError) {
        if (e.status >= 500) return serverError(ctx, e);
        if (e.status === 403 || e.status === 429) reqLog.warn('Požadavek odmítnut', { status: e.status, path: url.pathname, reason: e.details && e.details.reason });
        return sendErrorPage(ctx, e.status, { message: e.expose ? e.message : undefined });
      }
      return serverError(ctx, e);
    }
    return undefined;
  }

  function serveTenantFile(req, res, tenant, name) {
    const file = path.join(tenant.dir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return sendPlain(res, 404, 'Soubor nenalezen.');
    }
    res.writeHead(200, { 'Content-Type': mimeType(file), 'Content-Length': String(stat.size), 'Cache-Control': 'public, max-age=3600', 'Last-Modified': stat.mtime.toUTCString() });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file).pipe(res);
  }

  const app = (req, res) => {
    handle(req, res).catch((e) => {
      log.error('Neočekávaná chyba v request handleru', { error: e && e.message });
      if (!res.headersSent) sendPlain(res, 500, 'Chyba serveru.');
      else res.destroy();
    });
  };
  Object.assign(app, deps, { rateLimiter, now: () => Date.now() });
  return app;
}

// ---------------------------------------------------------------------------------------------------------
// Start

/**
 * Spustí server.
 * @param {{env?: object, quiet?: boolean, log?: object, port?: number, host?: string, startJobs?: boolean, autoSeed?: boolean, featuresDir?: string}} [options]
 */
async function start(options = {}) {
  const config = { ...loadConfig(options.env || process.env) };
  if (options.port !== undefined) config.port = options.port;
  if (options.host !== undefined) config.host = options.host;
  const log = options.log || defaultLog;
  if (!options.log && typeof log.setLevel === 'function' && options.env) log.setLevel(config.logLevel);

  const secret = ensureSecret(config);
  const fieldCrypto = createFieldCrypto(secret);
  const tenants = loadTenants(config.tenantsDir);
  const dbs = new Map();
  const platformDb = klienti.openPlatformDb(config.dataDir);
  const loadedClients = klienti.loadClientTenants(config.klientiDir);
  for (const err of loadedClients.errors) log.error('Web klienta nelze načíst – přeskočen', err);
  for (const t of loadedClients.tenants) {
    if (tenants.some((x) => x.slug === t.slug || x.hosts.some((h) => t.hosts.includes(h)))) {
      log.error('Web klienta koliduje se slugem nebo hostem jiného tenanta – přeskočen', { slug: t.slug });
      continue;
    }
    const db = openTenantDb(t.slug, config.dataDir);
    seedSettings(db, t);
    dbs.set(t.slug, db);
  }
  for (const tenant of tenants) {
    const db = openTenantDb(tenant.slug, config.dataDir);
    const seeded = seedSettings(db, tenant);
    if (seeded) log.info('Výchozí nastavení zkopírováno do DB', { tenant: tenant.slug, keys: seeded });
    const admin = ensureAdmin(db, config);
    if (admin.created) {
      log.info('Vytvořen výchozí účet správce', { tenant: tenant.slug });
      if (admin.generatedPassword && !options.quiet) printPasswordBanner(config.adminUser, admin.generatedPassword);
    }
    if (options.autoSeed !== false) await autoSeedDemo({ db, tenant, config, fieldCrypto, log });
    dbs.set(tenant.slug, db);
  }
  // klienti až za tenanty z repa (ti mají při shodě hostu přednost); seznam hostů pro Caddy (deploy/vedle-mapy.sh)
  for (const t of loadedClients.tenants) if (dbs.has(t.slug) && !tenants.includes(t)) tenants.push(t);
  try {
    klienti.writeCaddyHosts(config.dataDir, tenants);
  } catch (e) {
    log.error('Seznam hostů klientů pro Caddy nelze zapsat', { error: e.message });
  }
  if (loadedClients.tenants.length) log.info('Weby klientů načteny', { klienti: tenants.filter(klienti.isClientTenant).map((t) => t.slug) });

  const router = createRouter();
  router.add(
    'GET',
    '/api/health',
    async (ctx) => {
      ctx.json({ ok: true, version: config.version, tenant: ctx.tenant.slug, theme: ctx.theme, demo: !!config.demo });
    },
    { rateLimit: 'api', feature: 'kostra' }
  );
  const { features, nav, jobs: featureJobs, loaded } = loadFeatures({ config, log, router, dir: options.featuresDir });
  log.info('Features načteny', { features: loaded });

  const app = createApp({ config, log, tenants, dbs, secret, fieldCrypto, router, features, nav, platformDb });

  const jobs = createJobs({ log });
  jobs.register('sessions-purge', 15 * 60 * 1000, ({ dbs: all }) => {
    let n = 0;
    for (const db of all.values()) n += purgeExpired(db);
    if (n) log.info('Prošlé session smazány', { count: n });
  });
  if (config.demo && config.resetDemoHour !== null) {
    let lastResetDay = null;
    jobs.register('demo-reset', 10 * 60 * 1000, async (d) => {
      const now = new Date();
      const prague = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', hour: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
      const get = (t) => prague.find((p) => p.type === t).value;
      const day = `${get('year')}-${get('month')}-${get('day')}`;
      if (Number(get('hour')) % 24 !== config.resetDemoHour || lastResetDay === day) return;
      lastResetDay = day;
      const demoData = require('./tools/demo-data');
      for (const tenant of d.tenants.filter((t) => !klienti.isClientTenant(t))) await demoData.seed({ db: d.dbs.get(tenant.slug), tenant, config: d.config, fieldCrypto: d.fieldCrypto, reset: true, log });
      log.info('Noční reset demo dat proveden');
    });
  }
  for (const job of featureJobs) jobs.register(job.name, job.everyMs, job.fn);
  app.jobs = jobs;

  const server = http.createServer(app);
  server.requestTimeout = 60 * 1000;
  server.headersTimeout = 30 * 1000;
  server.keepAliveTimeout = 5 * 1000;
  server.on('clientError', (err, socket) => {
    try {
      if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    } catch {
      /* nic */
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  server.on('error', (e) => log.error('Chyba HTTP serveru', { error: e.message }));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : config.port;
  const displayHost = !config.host || config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  const url = `http://${displayHost}:${port}`;
  log.info('Půjčovna kol běží', { url, demo: config.demo, tenants: tenants.map((t) => t.slug), version: config.version });

  if (options.startJobs !== false) jobs.start({ config, log, tenants, dbs, secret, fieldCrypto, now: () => Date.now() });

  let stopping = null;
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      jobs.stop();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        const t = setTimeout(() => {
          server.closeAllConnections?.();
          resolve();
        }, 5000);
        t.unref();
      });
      for (const db of [...dbs.values(), platformDb]) {
        try {
          db.close();
        } catch {
          /* nic */
        }
      }
    })();
    return stopping;
  };

  return { server, port, url, app, config, tenants, dbs, secret, fieldCrypto, jobs, platformDb, stop };
}

async function main() {
  const log = defaultLog;
  process.on('unhandledRejection', (reason) => log.error('Neošetřené odmítnutí promise', { error: reason instanceof Error ? reason.message : String(reason) }));
  let instance;
  try {
    instance = await start();
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') log.error(`Port je obsazený (${e.port ?? ''}). Nastavte jiný přes PORT.`);
    else log.error('Server se nepodařilo spustit', { error: e.message, stack: e.stack });
    process.exitCode = 1;
    return;
  }
  let shuttingDown = false;
  const shutdown = async (signal, code = 0) => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log.info(`Přijat ${signal}, ukončuji server…`);
    try {
      await instance.stop();
      process.exit(code);
    } catch (e) {
      log.error('Chyba při ukončování', { error: e.message });
      process.exit(1);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    log.error('Nezachycená výjimka – server se ukončuje', { error: err.message, stack: err.stack });
    if (!shuttingDown) shutdown('uncaughtException', 1);
    else process.exit(1);
  });
}

if (require.main === module) main();

module.exports = { start, createApp, loadFeatures, ensureAdmin, autoSeedDemo, resolveTheme, DESIGN_COOKIE };
