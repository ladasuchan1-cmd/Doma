'use strict';
// Konfigurace Kolomapy z proměnných prostředí.
//
//   PORT / KOLOMAPA_PORT        port HTTP serveru (výchozí 8090)
//   KOLOMAPA_HOST               adresa pro naslouchání (výchozí 127.0.0.1 – jen tento počítač; 0.0.0.0 = celá síť)
//   KOLOMAPA_DB                 soubor databáze (výchozí <projekt>/data/kolomapa.db; ':memory:' pro testy)
//   KOLOMAPA_PUBLIC_DIR         adresář s UI (výchozí <projekt>/public)
//   KOLOMAPA_SOURCES            zapnuté zdroje, čárkou (výchozí bazos,sbazar,cyklobazar; aukro jen na vyžádání –
//                               jeho robots.txt blokuje ClaudeBota, rozhodnutí je na provozovateli)
//   KOLOMAPA_SCHEDULE           čas denního běhu „HH:MM“ v místním čase (výchozí 05:30); „off“ = bez plánovače
//   KOLOMAPA_RUN_ON_START       1 = při startu serveru hned spustit stahování, pokud dnes ještě neproběhlo (výchozí 1)
//   KOLOMAPA_DELAY_MS           pauza mezi požadavky na jeden web v ms (výchozí 1200 – šetrné k webům)
//   KOLOMAPA_MAX_PAGES          max. stránek výpisu na kategorii za běh (výchozí 400; ochrana před nekonečným během)
//   KOLOMAPA_MAX_DETAILS        max. detailů inzerátů na zdroj za běh (výchozí 1500; zbytek se dočte další dny)
//   KOLOMAPA_FULL_SCAN_DAYS     jak často projít výpis celý (kvůli odhalení prodaných/smazaných) – dny (výchozí 1)
//   KOLOMAPA_MIN_PRICE          inzeráty s cenou pod touto hranicí se ignorují (výchozí 500 Kč)
//   KOLOMAPA_GONE_KEEP_DAYS     jak dlouho držet zmizelé inzeráty v DB (historie cen pro učení, výchozí 365)
//   KOLOMAPA_BROWSER            cesta k Chromiu pro Cyklobazar (výchozí: Chromium z balíčku playwright)
//   KOLOMAPA_BROWSER_ARGS       další argumenty prohlížeče oddělené mezerou
//   ANTHROPIC_API_KEY           klíč k Claude API – zapne AI nacenění podle fotky (jinak jen výpočetní model)
//   KOLOMAPA_AI_MODEL           model pro AI nacenění (výchozí claude-opus-5-5)
//   KOLOMAPA_AI_MAX_PER_RUN     max. AI nacenění za běh (výchozí 150 – hlídá útratu)
//   KOLOMAPA_AI_MIN_PRICE       AI nacení jen inzeráty s cenou od (výchozí 5000 Kč)
//   KOLOMAPA_BUY_MARGIN         cílová hrubá marže obchodu při výkupu (výchozí z vlastních prodejů, jinak 0.35)
//   KOLOMAPA_STATIC_DIR         kam „npm run export“ zapíše statickou verzi mapy (výchozí <projekt>/dist)
//   KOLOMAPA_EXPORT_AFTER_RUN   1 = po každém běhu (server i tools/run.js) zapsat i statickou verzi (výchozí 0)
//   KOLOMAPA_PASSWORD           heslo pro přístup k webu (HTTP Basic, jméno libovolné); prázdné = bez hesla
//   LOG_LEVEL                   debug | info | warn | error | silent

const path = require('node:path');

const PROJECT_DIR = path.join(__dirname, '..');
const ALL_SOURCES = ['bazos', 'sbazar', 'aukro', 'cyklobazar'];
const DEFAULT_SOURCES = ['bazos', 'sbazar', 'cyklobazar'];

function envBool(v, fallback) {
  if (v == null || String(v).trim() === '') return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'ano', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'ne', 'off'].includes(s)) return false;
  return fallback;
}

function envInt(v, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (v == null || String(v).trim() === '') return fallback;
  const n = Number(String(v).trim());
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function envNumber(v, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (v == null || String(v).trim() === '') return fallback;
  const n = Number(String(v).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function envStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function parseSchedule(v) {
  const s = envStr(v);
  if (s && /^(off|0|ne|no|false)$/i.test(s)) return null;
  const m = (s || '05:30').match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { hour: 5, minute: 30 };
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function parseSources(v) {
  const s = envStr(v);
  if (!s) return DEFAULT_SOURCES.slice();
  if (/^(all|vse|vše)$/i.test(s)) return ALL_SOURCES.slice();
  const want = s
    .split(/[\s,;]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return ALL_SOURCES.filter((k) => want.includes(k));
}

/**
 * Načte konfiguraci z proměnných prostředí.
 * @param {Record<string, string|undefined>} [env]
 */
function loadConfig(env = process.env) {
  env = env || {};
  let dbFile = envStr(env.KOLOMAPA_DB);
  if (!dbFile) dbFile = path.join(PROJECT_DIR, 'data', 'kolomapa.db');
  else if (dbFile !== ':memory:') dbFile = path.resolve(dbFile);
  const aiKey = envStr(env.ANTHROPIC_API_KEY);
  return {
    projectDir: PROJECT_DIR,
    port: envInt(env.KOLOMAPA_PORT, envInt(env.PORT, 8090, { min: 0, max: 65535 }), { min: 0, max: 65535 }),
    host: envStr(env.KOLOMAPA_HOST) || '127.0.0.1',
    dbFile,
    publicDir: path.resolve(envStr(env.KOLOMAPA_PUBLIC_DIR) || path.join(PROJECT_DIR, 'public')),
    staticDir: path.resolve(envStr(env.KOLOMAPA_STATIC_DIR) || path.join(PROJECT_DIR, 'dist')),
    exportAfterRun: envBool(env.KOLOMAPA_EXPORT_AFTER_RUN, false),
    password: envStr(env.KOLOMAPA_PASSWORD),
    sources: parseSources(env.KOLOMAPA_SOURCES),
    schedule: parseSchedule(env.KOLOMAPA_SCHEDULE),
    runOnStart: envBool(env.KOLOMAPA_RUN_ON_START, true),
    delayMs: envInt(env.KOLOMAPA_DELAY_MS, 1200, { min: 0, max: 60000 }),
    maxPages: envInt(env.KOLOMAPA_MAX_PAGES, 400, { min: 1, max: 100000 }),
    maxDetails: envInt(env.KOLOMAPA_MAX_DETAILS, 1500, { min: 0, max: 1000000 }),
    fullScanDays: envInt(env.KOLOMAPA_FULL_SCAN_DAYS, 1, { min: 1, max: 60 }),
    minPrice: envNumber(env.KOLOMAPA_MIN_PRICE, 500, { min: 0 }),
    goneKeepDays: envInt(env.KOLOMAPA_GONE_KEEP_DAYS, 365, { min: 1, max: 10000 }),
    browserPath: envStr(env.KOLOMAPA_BROWSER),
    browserArgs: (envStr(env.KOLOMAPA_BROWSER_ARGS) || '').split(/\s+/).filter(Boolean),
    ai: {
      enabled: !!aiKey,
      apiKey: aiKey,
      model: envStr(env.KOLOMAPA_AI_MODEL) || 'claude-opus-5-5',
      maxPerRun: envInt(env.KOLOMAPA_AI_MAX_PER_RUN, 150, { min: 0, max: 100000 }),
      minPrice: envNumber(env.KOLOMAPA_AI_MIN_PRICE, 5000, { min: 0 }),
    },
    buyMargin: envNumber(env.KOLOMAPA_BUY_MARGIN, null, { min: 0, max: 0.95 }),
    logLevel: envStr(env.LOG_LEVEL) || 'info',
  };
}

module.exports = { loadConfig, ALL_SOURCES, DEFAULT_SOURCES, PROJECT_DIR, envBool, envInt, envNumber, envStr, parseSchedule, parseSources };
