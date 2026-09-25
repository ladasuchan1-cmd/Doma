'use strict';
// Konfigurace serveru z proměnných prostředí (SPEC §8 config.js).
//
//   PORT / CENOTVORBA_PORT     port HTTP serveru (výchozí 8080; CENOTVORBA_PORT má přednost před PORT)
//   CENOTVORBA_HOST            adresa pro naslouchání (výchozí 0.0.0.0)
//   CENOTVORBA_DB              soubor databáze (výchozí <projekt>/data/cenotvorba.db; ':memory:' pro testy)
//   CENOTVORBA_PASSWORD        heslo pro přihlášení (přebíjí heslo uložené v databázi)
//   CENOTVORBA_SECRET          tajemství pro podpis session cookie (jinak se vygeneruje a uloží do DB)
//   CENOTVORBA_MAX_BODY_MB     maximální velikost těla požadavku v MB (výchozí 300)
//   CENOTVORBA_PUBLIC_DIR      adresář s UI (výchozí <projekt>/public)
//   CENOTVORBA_TRUST_PROXY     1 = server běží za reverzní proxy (X-Forwarded-For / X-Forwarded-Proto)
//   CENOTVORBA_SCHEDULER       0 = vypnout plánovač (stahování zdrojů, automatické přecenění, úklid)
//   LOG_LEVEL                  debug | info | warn | error | silent

const path = require('node:path');

const PROJECT_DIR = path.join(__dirname, '..');

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

function envNumber(v, fallback, { min = -Infinity } = {}) {
  if (v == null || String(v).trim() === '') return fallback;
  const n = Number(String(v).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= min) return fallback;
  return n;
}

function envStr(v) {
  if (v == null) return null;
  const s = String(v);
  return s.trim() === '' ? null : s;
}

/**
 * Načte konfiguraci z proměnných prostředí.
 * @param {Record<string, string|undefined>} [env]
 * @returns {{port: number, host: string, dbFile: string, password: string|null, secret: string|null,
 *   maxBodyMb: number, publicDir: string, trustProxy: boolean, schedulerEnabled: boolean, logLevel: string}}
 */
function loadConfig(env = process.env) {
  env = env || {};
  const port = envInt(env.CENOTVORBA_PORT, envInt(env.PORT, 8080, { min: 0, max: 65535 }), { min: 0, max: 65535 });
  let dbFile = envStr(env.CENOTVORBA_DB);
  // Výchozí DB je relativní k adresáři projektu (ne k aktuálnímu adresáři), aby „node repricing/server.js“
  // spuštěný odjinud nezaložil novou prázdnou databázi. Explicitní relativní cesta se bere od cwd.
  if (!dbFile) dbFile = path.join(PROJECT_DIR, 'data', 'cenotvorba.db');
  else if (dbFile !== ':memory:') dbFile = path.resolve(dbFile);
  return {
    port,
    host: envStr(env.CENOTVORBA_HOST) || '0.0.0.0',
    dbFile,
    // heslo nikdy neořezáváme – mezery na okrajích mohou být záměrné
    password: env.CENOTVORBA_PASSWORD != null && env.CENOTVORBA_PASSWORD !== '' ? String(env.CENOTVORBA_PASSWORD) : null,
    secret: envStr(env.CENOTVORBA_SECRET),
    maxBodyMb: envNumber(env.CENOTVORBA_MAX_BODY_MB, 300, { min: 0 }),
    publicDir: path.resolve(envStr(env.CENOTVORBA_PUBLIC_DIR) || path.join(PROJECT_DIR, 'public')),
    trustProxy: envBool(env.CENOTVORBA_TRUST_PROXY, false),
    schedulerEnabled: envBool(env.CENOTVORBA_SCHEDULER, true),
    logLevel: envStr(env.LOG_LEVEL) || 'info',
  };
}

module.exports = { loadConfig, PROJECT_DIR, envBool };
