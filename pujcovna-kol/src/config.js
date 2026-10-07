'use strict';
// Konfigurace aplikace z proměnných prostředí (SPEC kap. 3) + cesty a konstanty.
// Vstup: objekt env (výchozí process.env). Výstup: zamrzlý objekt config.
//
//   PORT                 port HTTP serveru (8092)
//   HOST                 adresa, na které server poslouchá (0.0.0.0)
//   PK_DATA              datový adresář – DB per tenant, .secret (./data)
//   PK_TENANTS           adresář s tenanty tenants/<slug>/tenant.json (./tenants)
//   PK_DEMO              1 = demo režim (přepínač designu, simulace plateb, demo přihlášení, noční reset) (1)
//   PK_TRUST_PROXY       1 = za reverzní proxy (IP z X-Forwarded-For, Secure cookies podle X-Forwarded-Proto) (0)
//   PK_SECRET            klíč pro HMAC a šifrování polí; chybí-li, vygeneruje se do $PK_DATA/.secret (práva 600)
//   PK_ADMIN_USER        e-mail výchozího admina při prvním startu (v demu demo@ksprehledy.cz)
//   PK_ADMIN_PASSWORD    heslo výchozího admina (v demu pevné kolo-demo-2026, jinak náhodné vytištěné do konzole)
//   PK_RESET_DEMO_HOUR   hodina nočního resetu demo dat (3); prázdný řetězec = vypnuto
//   PK_DEMO_AUTOSEED     1 = v demo režimu při startu naplnit demo data, je-li tabulka bike_types prázdná (1); 0 = ne
//   PK_KLIENTI_DOMENA    doména, pod kterou průvodce zakládá weby klientů (<slug>.<doména>); výchozí PK_DOMAIN, jinak
//                        ksprehledy.cz. Weby klientů leží v $PK_DATA/klienti/<slug>/ (tenant.json, logo) – přežijí nasazení.
//   PK_PLATFORMA_HESLO   heslo do správy platformy /platforma (pozvánky do průvodce, přehled klientů); min. 12 znaků.
//                        Bez něj je /platforma vypnutá (404) a pozvánky jdou jen nástrojem tools/pozvanka.js.
//   PK_SMTP_HOST         SMTP server pro odesílání e-mailů provozovateli (poptávky, kontaktní formulář); bez něj se nic
//                        neodesílá a e-maily zůstávají ve frontě (admin → E-maily). Např. smtp.cesky-hosting.cz.
//   PK_SMTP_PORT         port (465 = implicitní TLS, 587 = STARTTLS); výchozí 465
//   PK_SMTP_SECURE       tls | starttls (výchozí podle portu); none jen pro localhost (testy)
//   PK_SMTP_USER / PK_SMTP_PASS   přihlášení ke schránce (heslo lze i v base64 jako PK_SMTP_PASS_B64 – tak ho píše nasazení); PK_SMTP_FROM odesílatel (výchozí PK_SMTP_USER)
//   APP_VERSION          verze aplikace do patičky a ?v= u statických souborů (výchozí z package.json)
//   LOG_LEVEL            debug | info | warn | error | silent (info)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_PORT = 8092;
const DEMO_ADMIN_EMAIL = 'demo@ksprehledy.cz';
const DEMO_ADMIN_PASSWORD = 'kolo-demo-2026';
const BODY_LIMIT_BYTES = 256 * 1024;

function envBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'ano';
}

function envInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** SMTP z env (PK_SMTP_*); bez hostitele nebo odesílatele null = odesílání vypnuté. */
function smtpConfig(env) {
  const host = String(env.PK_SMTP_HOST || '').trim();
  const from = String(env.PK_SMTP_FROM || env.PK_SMTP_USER || '').trim();
  if (!host || !from) return null;
  const port = envInt(env.PK_SMTP_PORT, 465);
  const sec = String(env.PK_SMTP_SECURE || '').trim().toLowerCase();
  return Object.freeze({
    host,
    port,
    secure: ['tls', 'starttls', 'none'].includes(sec) ? sec : port === 465 ? 'tls' : 'starttls',
    user: String(env.PK_SMTP_USER || '').trim() || null,
    pass: env.PK_SMTP_PASS ? String(env.PK_SMTP_PASS) : env.PK_SMTP_PASS_B64 ? Buffer.from(String(env.PK_SMTP_PASS_B64), 'base64').toString('utf8') : null,
    from,
    fromName: String(env.PK_SMTP_FROM_NAME || '').trim() || null,
    helo: String(env.PK_DOMAIN || 'localhost').trim(),
  });
}

/**
 * Načte konfiguraci z env.
 * @param {NodeJS.ProcessEnv} [env]
 */
function loadConfig(env = process.env) {
  const demo = envBool(env.PK_DEMO, true);
  const dataDir = path.resolve(ROOT_DIR, env.PK_DATA || './data');
  const tenantsDir = path.resolve(ROOT_DIR, env.PK_TENANTS || './tenants');
  const resetHourRaw = env.PK_RESET_DEMO_HOUR;
  const resetDemoHour = resetHourRaw === '' ? null : envInt(resetHourRaw, 3);
  return Object.freeze({
    rootDir: ROOT_DIR,
    publicDir: path.join(ROOT_DIR, 'public'),
    legalDir: path.join(ROOT_DIR, 'legal'),
    port: envInt(env.PORT, DEFAULT_PORT),
    host: env.HOST || '0.0.0.0',
    dataDir,
    tenantsDir,
    demo,
    trustProxy: envBool(env.PK_TRUST_PROXY, false),
    secret: env.PK_SECRET || null,
    adminUser: env.PK_ADMIN_USER || (demo ? DEMO_ADMIN_EMAIL : 'admin@example.com'),
    adminPassword: env.PK_ADMIN_PASSWORD || (demo ? DEMO_ADMIN_PASSWORD : null),
    resetDemoHour,
    demoAutoSeed: demo && envBool(env.PK_DEMO_AUTOSEED, true),
    version: env.APP_VERSION || packageVersion(),
    logLevel: env.LOG_LEVEL || 'info',
    bodyLimitBytes: BODY_LIMIT_BYTES,
    klientiDir: path.join(dataDir, 'klienti'),
    klientiDomena: String(env.PK_KLIENTI_DOMENA || env.PK_DOMAIN || 'ksprehledy.cz').trim().toLowerCase().replace(/^\.+|\.+$/g, ''),
    smtp: smtpConfig(env),
    platformaHeslo: env.PK_PLATFORMA_HESLO && String(env.PK_PLATFORMA_HESLO).length >= 12 ? String(env.PK_PLATFORMA_HESLO) : null,
  });
}

/**
 * Vrátí tajný klíč: config.secret, jinak $PK_DATA/.secret (vytvoří s právy 600, pokud neexistuje).
 * @returns {string} hex řetězec (≥ 64 znaků) nebo hodnota PK_SECRET
 */
function ensureSecret(config) {
  if (config.secret) return String(config.secret);
  const file = path.join(config.dataDir, '.secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* neexistuje → vygenerujeme */
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* např. Windows – práva neřešíme */
  }
  return secret;
}

module.exports = { loadConfig, ensureSecret, ROOT_DIR, DEFAULT_PORT, DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD, BODY_LIMIT_BYTES };
