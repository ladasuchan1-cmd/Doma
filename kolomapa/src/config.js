'use strict';
// Konfigurace Kolomapy z proměnných prostředí a ze souboru nastaveni.txt.
//
// Soubor nastaveni.txt (ve složce kolomapa, řádky KLÍČ=hodnota, # = komentář) je pro Windows: proměnné prostředí
// se tam nastavují špatně. Načte se při prvním require('./src/config') do process.env; skutečné proměnné prostředí
// mají přednost. Vzor je v nastaveni-vzor.txt (start.cmd ho při prvním spuštění zkopíruje). Jiný soubor:
// KOLOMAPA_SETTINGS_FILE=cesta, vypnout: KOLOMAPA_SETTINGS_FILE=off. Relativní cesty (KOLOMAPA_DB, …) se berou
// vůči složce kolomapa – stejně z npm, z Plánovače úloh i z jiného adresáře.
//
//   PORT / KOLOMAPA_PORT        port HTTP serveru (výchozí 8090)
//   KOLOMAPA_HOST               adresa pro naslouchání (výchozí 127.0.0.1 – jen tento počítač; 0.0.0.0 = celá síť)
//   KOLOMAPA_ALLOWED_HOSTS      další jména serveru povolená bez hesla (čte server.js; ochrana proti DNS rebinding)
//   KOLOMAPA_DB                 soubor databáze (výchozí <projekt>/data/kolomapa.db; ':memory:' pro testy)
//   KOLOMAPA_PUBLIC_DIR         adresář s UI (výchozí <projekt>/public)
//   KOLOMAPA_SOURCES            zapnuté zdroje, čárkou (výchozí bazos,sbazar). Na vyžádání: aukro (robots.txt blokuje
//                               ClaudeBota) a cyklobazar (Cloudflare omezuje roboty; potřebuje Playwright, jde velmi
//                               pomalu a při ověření „jste člověk?“ se zastaví) – rozhodnutí je na provozovateli.
//   KOLOMAPA_SCHEDULE           čas denního běhu „HH:MM“ (i „5.30“) v místním čase (výchozí 05:30); „off“ = bez plánovače
//   KOLOMAPA_RUN_ON_START       1 = při startu serveru hned spustit stahování, pokud dnes ještě neproběhlo (výchozí 1)
//   KOLOMAPA_DELAY_MS           pauza mezi požadavky na jeden web v ms (výchozí 1200 – šetrné k webům)
//   KOLOMAPA_MAX_PAGES          max. stránek výpisu na kategorii za běh (výchozí 400; ochrana před nekonečným během)
//   KOLOMAPA_MAX_DETAILS        max. detailů inzerátů na zdroj za běh (výchozí podle zdroje: Bazoš 4000, Sbazar 2000,
//                               Aukro 300, Cyklobazar 120 – zbytek se dočte další dny; nastavení platí pro všechny,
//                               Cyklobazar ale nikdy víc než 300 za běh)
//   KOLOMAPA_FULL_SCAN_DAYS     jak často projít výpis celý (kvůli odhalení prodaných/smazaných) – dny (výchozí 1)
//   KOLOMAPA_SBAZAR_MAX_RESOLVE max. nových lokalit Sbazaru přeložených na souřadnice za běh (výchozí 400)
//   KOLOMAPA_MIN_PRICE          nové inzeráty s cenou pod touto hranicí se ignorují (výchozí 200 Kč – levná dětská kola)
//   KOLOMAPA_GONE_KEEP_DAYS     jak dlouho držet zmizelé inzeráty v DB (historie cen pro učení, výchozí 365)
//   KOLOMAPA_BROWSER            cesta k Chromiu pro Cyklobazar (výchozí: Chromium z balíčku playwright)
//   KOLOMAPA_BROWSER_ARGS       další argumenty prohlížeče oddělené mezerou (argumenty skrývající automatizaci se
//                               ignorují – viz src/sources/browser.js)
//   KOLOMAPA_CYKLOBAZAR_DELAY_MS        pauza mezi stránkami Cyklobazaru v ms (výchozí 20000, nejméně 10000 – při
//                               rychlejším stahování Cloudflare žádá ověření „jste člověk?“ a zdroj se na 12 h zastaví)
//   KOLOMAPA_CYKLOBAZAR_MAX_LIST_PAGES  max. stránek výpisu Cyklobazaru za běh (výchozí 60 ≈ 20 min; celý výpis má
//                               ~445 stránek ≈ 2,5 h, projde se proto postupně během několika dní; prodané/smazané
//                               inzeráty pozná zdroj ze sitemapy webu; 0 = jen sitemapa a detaily)
//   ANTHROPIC_API_KEY           klíč k Claude API – zapne AI nacenění podle fotky (jinak jen výpočetní model)
//   KOLOMAPA_AI_MODEL           model pro AI nacenění (výchozí claude-opus-5-5)
//   KOLOMAPA_AI_MAX_PER_RUN     max. AI nacenění za běh (výchozí 150 – hlídá útratu)
//   KOLOMAPA_AI_MIN_PRICE       AI nacení jen inzeráty s cenou od (výchozí 5000 Kč)
//   KOLOMAPA_BUY_MARGIN         cílová hrubá marže obchodu při výkupu: 0.35, „0,35“ i „35 %“ (výchozí z vlastních
//                               prodejů, jinak 0.35)
//   KOLOMAPA_STATIC_DIR         kam „npm run export“ zapíše statickou verzi mapy (výchozí <projekt>/dist)
//   KOLOMAPA_EXPORT_AFTER_RUN   1 = po každém běhu (server i tools/run.js) zapsat i statickou verzi (výchozí 0)
//   KOLOMAPA_PASSWORD           heslo pro přístup k webu (HTTP Basic, jméno libovolné); prázdné = bez hesla
//   KOLOMAPA_EVAL_DIR           data pro tools/eval-pricing.js (výchozí data/eval)
//   LOG_LEVEL                   debug | info | warn | error | silent
//
// Neplatná hodnota se nahradí výchozí a loadConfig() ji ohlásí česky v config.warnings (a při čtení z process.env
// i varováním v logu – jednou za běh procesu).

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_DIR = path.join(__dirname, '..');
const ALL_SOURCES = ['bazos', 'sbazar', 'aukro', 'cyklobazar'];
const DEFAULT_SOURCES = ['bazos', 'sbazar'];
const DEFAULT_SETTINGS_FILE = path.join(PROJECT_DIR, 'nastaveni.txt');

/** Všechny proměnné, kterým Kolomapa rozumí (kvůli upozornění na překlepy v nastaveni.txt). */
const KNOWN_KEYS = new Set([
  'PORT',
  'KOLOMAPA_PORT',
  'KOLOMAPA_HOST',
  'KOLOMAPA_ALLOWED_HOSTS',
  'KOLOMAPA_DB',
  'KOLOMAPA_PUBLIC_DIR',
  'KOLOMAPA_STATIC_DIR',
  'KOLOMAPA_EXPORT_AFTER_RUN',
  'KOLOMAPA_PASSWORD',
  'KOLOMAPA_SOURCES',
  'KOLOMAPA_SCHEDULE',
  'KOLOMAPA_RUN_ON_START',
  'KOLOMAPA_DELAY_MS',
  'KOLOMAPA_MAX_PAGES',
  'KOLOMAPA_MAX_DETAILS',
  'KOLOMAPA_FULL_SCAN_DAYS',
  'KOLOMAPA_SBAZAR_MAX_RESOLVE',
  'KOLOMAPA_MIN_PRICE',
  'KOLOMAPA_GONE_KEEP_DAYS',
  'KOLOMAPA_BROWSER',
  'KOLOMAPA_BROWSER_ARGS',
  'KOLOMAPA_CYKLOBAZAR_DELAY_MS',
  'KOLOMAPA_CYKLOBAZAR_MAX_LIST_PAGES',
  'ANTHROPIC_API_KEY',
  'KOLOMAPA_AI_MODEL',
  'KOLOMAPA_AI_MAX_PER_RUN',
  'KOLOMAPA_AI_MIN_PRICE',
  'KOLOMAPA_BUY_MARGIN',
  'KOLOMAPA_EVAL_DIR',
  'LOG_LEVEL',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
]);
const LOG_LEVELS = ['debug', 'info', 'warn', 'warning', 'error', 'silent', 'none', 'off'];

// ---------------------------------------------------------------------------------------------------------
// Verze Node.js – node:sqlite je bez přepínače až od 22.13 (a 23.4). Starší Node by spadl na nesrozumitelném
// „No such built-in module: node:sqlite“; tady to řekneme česky dřív, než se cokoli načte.

/**
 * @param {string} [version] např. '22.12.0'
 * @returns {string|null} česká zpráva, když verze nestačí, jinak null
 */
function nodeVersionProblem(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map((x) => Number.parseInt(x, 10));
  const ok = major > 23 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13);
  if (ok) return null;
  return (
    `Kolomapa potřebuje Node.js 22.13 nebo novější – tento počítač má ${version}. ` +
    'Stáhněte verzi LTS z https://nodejs.org, nainstalujte ji (stará se nahradí), zavřete toto okno a spusťte Kolomapu znovu.'
  );
}

// ---------------------------------------------------------------------------------------------------------
// Soubor nastaveni.txt

/**
 * Dekóduje textový soubor z Poznámkového bloku: UTF-8 (s BOM i bez), UTF-16 („Unicode“) nebo ANSI (windows-1250).
 * @param {Buffer} buf
 */
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const b = Buffer.from(buf.subarray(2));
    return b.swap16 && b.length % 2 === 0 ? b.swap16().toString('utf16le') : b.toString('latin1');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('windows-1250').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

const shorten = (s, n = 60) => {
  const t = String(s).trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Rozebere text nastavení: řádky KLÍČ=hodnota; # ; nebo rem = komentář; toleruje „set “/„export “ na začátku řádku
 * a hodnotu v uvozovkách. Klíče se převedou na velká písmena (ve Windows na velikosti nezáleží).
 * @param {string} text
 * @param {string} [name] jméno souboru do hlášek
 * @returns {{values: Record<string, string>, warnings: string[]}}
 */
function parseSettings(text, name = 'nastaveni.txt') {
  const values = {};
  const warnings = [];
  String(text || '')
    .split(/\r\n|\r|\n/)
    .forEach((raw, i) => {
      let line = raw.replace(/^﻿/, '').trim();
      if (!line || line.startsWith('#') || line.startsWith(';') || /^rem(\s|$)/i.test(line) || line.startsWith('::')) return;
      line = line.replace(/^(set|export)\s+/i, '');
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*)$/.exec(line);
      if (!m) {
        warnings.push(`${name}, řádek ${i + 1}: nerozumím „${shorten(raw)}“ – čekám KLÍČ=hodnota (řádek ignoruji).`);
        return;
      }
      const key = m[1].toUpperCase();
      let val = m[2].trim();
      if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) val = val.slice(1, -1);
      if (!KNOWN_KEYS.has(key)) {
        if (!key.startsWith('KOLOMAPA_')) {
          warnings.push(`${name}, řádek ${i + 1}: ${key} není nastavení Kolomapy (ignoruji).`);
          return;
        }
        warnings.push(`${name}, řádek ${i + 1}: neznámé nastavení ${key} – není to překlep? (seznam je v README.md)`);
      }
      values[key] = val;
    });
  return { values, warnings };
}

/**
 * Načte soubor nastavení do env (výchozí process.env). Hodnoty už nastavené (neprázdné) proměnné prostředí mají
 * přednost. Chybějící soubor není chyba.
 * @param {{file?: string|null, env?: Record<string, string|undefined>}} [o]
 * @returns {{file: string|null, applied: string[], warnings: string[]}}
 */
function applySettingsFile(o = {}) {
  const env = o.env || process.env;
  let file = o.file !== undefined ? o.file : envStr(env.KOLOMAPA_SETTINGS_FILE);
  if (file && /^(off|0|ne|no|false|none)$/i.test(file)) return { file: null, applied: [], warnings: [] };
  file = file ? path.resolve(PROJECT_DIR, file) : DEFAULT_SETTINGS_FILE;
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'ENOENT' && file === DEFAULT_SETTINGS_FILE) {
      // Windows s vypnutými příponami: z „nastaveni.txt“ v Průzkumníku vznikne snadno „nastaveni.txt.txt“.
      try {
        if (fs.existsSync(`${file}.txt`)) return { file: null, applied: [], warnings: [`Našel jsem „${path.basename(file)}.txt“ – přejmenujte ho na „${path.basename(file)}“, jinak se nenačte.`] };
      } catch {
        /* nic */
      }
      return { file: null, applied: [], warnings: [] };
    }
    return { file: null, applied: [], warnings: [`Soubor nastavení ${file} nejde přečíst (${e.code || e.message}) – používám výchozí nastavení.`] };
  }
  const { values, warnings } = parseSettings(decodeText(buf), path.basename(file));
  const applied = [];
  for (const [k, v] of Object.entries(values)) {
    if (env[k] != null && String(env[k]).trim() !== '') continue; // proměnná prostředí má přednost
    env[k] = v;
    applied.push(k);
  }
  return { file, applied, warnings };
}

// ---------------------------------------------------------------------------------------------------------
// Převody hodnot (bez hlášek – zpětně kompatibilní exporty)

function envBool(v, fallback) {
  if (v == null || String(v).trim() === '') return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'ano', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'ne', 'off'].includes(s)) return false;
  return fallback;
}

function envInt(v, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (v == null || String(v).trim() === '') return fallback;
  const n = Number(String(v).trim().replace(/[\s ]/g, ''));
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function envNumber(v, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (v == null || String(v).trim() === '') return fallback;
  const n = Number(String(v).trim().replace(/[\s ]/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function envStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

const OFF_RE = /^(off|0|ne|no|false|vyp|vypnuto)$/i;

/** „05:30“, „5:30“, „5.30“ (i se sekundami) → {hour, minute}; null = text neodpovídá. */
function matchTime(s) {
  const m = String(s).trim().match(/^(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function parseSchedule(v) {
  const s = envStr(v);
  if (s && OFF_RE.test(s)) return null;
  return matchTime(s || '05:30') || { hour: 5, minute: 30 };
}

/** „Bazoš“, „www.sbazar.cz“, „SBAZAR“ → klíč zdroje. */
function sourceKey(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\.cz\/?$/, '');
}

function splitSources(s) {
  return s
    .split(/[\s,;+]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseSources(v) {
  const s = envStr(v);
  if (!s) return DEFAULT_SOURCES.slice();
  if (/^(all|vse|vše|vsechny|všechny)$/i.test(s)) return ALL_SOURCES.slice();
  const want = splitSources(s).map(sourceKey);
  const picked = ALL_SOURCES.filter((k) => want.includes(k));
  return picked.length ? picked : DEFAULT_SOURCES.slice();
}

// ---------------------------------------------------------------------------------------------------------
// loadConfig

const printed = new Set();
let settingsInfo = { file: null, applied: [], warnings: [] };

/**
 * Načte konfiguraci z proměnných prostředí.
 * @param {Record<string, string|undefined>} [env]
 * @returns {object} konfigurace; `warnings` = české hlášky o neplatných hodnotách (nahrazených výchozími)
 */
function loadConfig(env = process.env) {
  const fromProcess = env === process.env;
  env = env || {};
  const warnings = fromProcess ? [...settingsInfo.warnings] : [];
  const bad = (name, raw, expected, used) =>
    warnings.push(`${name}=„${shorten(raw, 40)}“ neplatí – ${expected}. Používám ${used}.`);

  const int = (name, fallback, range = {}, expected) => {
    const raw = env[name];
    const v = envInt(raw, undefined, range);
    if (v !== undefined) return v;
    if (envStr(raw) != null) {
      const lim = [range.min != null && range.min !== -Infinity ? `od ${range.min}` : null, range.max != null && range.max !== Infinity ? `do ${range.max}` : null].filter(Boolean).join(' ');
      bad(name, raw, expected || `čekám celé číslo${lim ? ` ${lim}` : ''}`, fallback == null ? 'výchozí hodnotu' : String(fallback));
    }
    return fallback;
  };
  const num = (name, fallback, range = {}) => {
    const raw = env[name];
    const v = envNumber(raw, undefined, range);
    if (v !== undefined) return v;
    if (envStr(raw) != null) bad(name, raw, 'čekám číslo', fallback == null ? 'výchozí hodnotu' : String(fallback));
    return fallback;
  };
  const bool = (name, fallback) => {
    const raw = env[name];
    const v = envBool(raw, undefined);
    if (v !== undefined) return v;
    if (envStr(raw) != null) bad(name, raw, 'čekám 1 nebo 0 (ano / ne)', fallback ? '1' : '0');
    return fallback;
  };
  const dir = (name, fallback) => {
    const s = envStr(env[name]);
    return s ? path.resolve(PROJECT_DIR, s) : fallback;
  };

  let dbFile = envStr(env.KOLOMAPA_DB);
  if (!dbFile) dbFile = path.join(PROJECT_DIR, 'data', 'kolomapa.db');
  else if (dbFile !== ':memory:') dbFile = path.resolve(PROJECT_DIR, dbFile);

  // port: KOLOMAPA_PORT má přednost před PORT
  const portRange = { min: 0, max: 65535 };
  const port = int('KOLOMAPA_PORT', int('PORT', 8090, portRange, 'čekám číslo portu 1–65535'), portRange, 'čekám číslo portu 1–65535');

  // zdroje
  const srcRaw = envStr(env.KOLOMAPA_SOURCES);
  const sources = parseSources(srcRaw);
  if (srcRaw && !/^(all|vse|vše|vsechny|všechny)$/i.test(srcRaw)) {
    const unknown = splitSources(srcRaw).filter((x) => !ALL_SOURCES.includes(sourceKey(x)));
    if (unknown.length) {
      warnings.push(
        `KOLOMAPA_SOURCES: neznám ${unknown.map((x) => `„${shorten(x, 20)}“`).join(', ')} – povolené jsou ${ALL_SOURCES.join(', ')} nebo all. ` +
          `Stahuji z: ${sources.join(', ')}.`
      );
    }
  }

  // plán
  const schedRaw = envStr(env.KOLOMAPA_SCHEDULE);
  const schedule = parseSchedule(schedRaw);
  if (schedRaw && !OFF_RE.test(schedRaw) && !matchTime(schedRaw)) bad('KOLOMAPA_SCHEDULE', schedRaw, 'čekám čas HH:MM (např. 05:30) nebo off', '05:30');

  // marže: 0.35, „0,35“, „35“, „35 %“
  let buyMargin = null;
  const bmRaw = envStr(env.KOLOMAPA_BUY_MARGIN);
  if (bmRaw) {
    const pct = /%\s*$/.test(bmRaw);
    let v = envNumber(bmRaw.replace(/%\s*$/, ''), null);
    if (v != null && (pct || v > 1)) v /= 100;
    if (v != null && v >= 0 && v <= 0.95) buyMargin = Math.round(v * 10000) / 10000;
    else bad('KOLOMAPA_BUY_MARGIN', bmRaw, 'čekám marži 0–95 % (např. 35 % nebo 0,35)', 'marži z vlastních prodejů');
  }

  const logRaw = envStr(env.LOG_LEVEL);
  if (logRaw && !LOG_LEVELS.includes(logRaw.toLowerCase())) bad('LOG_LEVEL', logRaw, 'čekám debug, info, warn, error nebo silent', 'info');

  const aiKey = envStr(env.ANTHROPIC_API_KEY);
  const config = {
    projectDir: PROJECT_DIR,
    port,
    host: envStr(env.KOLOMAPA_HOST) || '127.0.0.1',
    dbFile,
    publicDir: dir('KOLOMAPA_PUBLIC_DIR', path.join(PROJECT_DIR, 'public')),
    staticDir: dir('KOLOMAPA_STATIC_DIR', path.join(PROJECT_DIR, 'dist')),
    exportAfterRun: bool('KOLOMAPA_EXPORT_AFTER_RUN', false),
    password: envStr(env.KOLOMAPA_PASSWORD),
    sources,
    schedule,
    runOnStart: bool('KOLOMAPA_RUN_ON_START', true),
    delayMs: int('KOLOMAPA_DELAY_MS', 1200, { min: 0, max: 60000 }),
    maxPages: int('KOLOMAPA_MAX_PAGES', 400, { min: 1, max: 100000 }),
    maxDetails: int('KOLOMAPA_MAX_DETAILS', null, { min: 0, max: 1000000 }),
    fullScanDays: int('KOLOMAPA_FULL_SCAN_DAYS', 1, { min: 1, max: 60 }),
    minPrice: num('KOLOMAPA_MIN_PRICE', 200, { min: 0 }),
    sbazarMaxResolve: int('KOLOMAPA_SBAZAR_MAX_RESOLVE', 400, { min: 0, max: 100000 }),
    goneKeepDays: int('KOLOMAPA_GONE_KEEP_DAYS', 365, { min: 1, max: 10000 }),
    browserPath: envStr(env.KOLOMAPA_BROWSER),
    browserArgs: (envStr(env.KOLOMAPA_BROWSER_ARGS) || '').split(/\s+/).filter(Boolean),
    // Cyklobazar (za Cloudflare): pauza mezi stránkami nikdy pod 10 s, limit stránek výpisu na běh
    cyklobazarDelayMs: Math.max(10000, int('KOLOMAPA_CYKLOBAZAR_DELAY_MS', 20000, { min: 0, max: 600000 })),
    cyklobazarMaxListPages: int('KOLOMAPA_CYKLOBAZAR_MAX_LIST_PAGES', 60, { min: 0, max: 1000 }),
    ai: {
      enabled: !!aiKey,
      apiKey: aiKey,
      model: envStr(env.KOLOMAPA_AI_MODEL) || 'claude-opus-5-5',
      maxPerRun: int('KOLOMAPA_AI_MAX_PER_RUN', 150, { min: 0, max: 100000 }),
      minPrice: num('KOLOMAPA_AI_MIN_PRICE', 5000, { min: 0 }),
    },
    buyMargin,
    logLevel: logRaw || 'info',
    settingsFile: fromProcess ? settingsInfo.file : null,
    warnings,
  };
  if (fromProcess && warnings.length) emitWarnings(warnings);
  return config;
}

/** Vypíše varování do logu – každé jen jednou za běh procesu (loadConfig se volá víckrát). */
function emitWarnings(list) {
  const fresh = list.filter((w) => !printed.has(w));
  if (!fresh.length) return;
  let log;
  try {
    log = require('./util/log');
  } catch {
    log = { warn: (m) => process.stderr.write(`${m}\n`) };
  }
  for (const w of fresh) {
    printed.add(w);
    log.warn(`Nastavení: ${w}`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Při načtení modulu: kontrola verze Node.js a nastaveni.txt → process.env (jen mimo testy node --test).

// node:sqlite při načtení hlásí „ExperimentalWarning: SQLite is an experimental feature…“ – pro majitele obchodu
// matoucí (vypadá jako chyba). npm skripty ho vypínají přepínačem --disable-warning; tady i pro přímé
// `node server.js` / `node tools/run.js` (start.cmd, stahnout.cmd, Plánovač úloh). Jiná varování zůstávají.
if (!process.emitWarning.__kolomapa) {
  const original = process.emitWarning;
  const filtered = function emitWarning(warning, ...rest) {
    const msg = typeof warning === 'string' ? warning : warning && warning.message;
    if (/^SQLite is an experimental feature/i.test(String(msg || ''))) return undefined;
    return original.call(this, warning, ...rest);
  };
  filtered.__kolomapa = true;
  process.emitWarning = filtered;
}

const NODE_PROBLEM = nodeVersionProblem();
if (NODE_PROBLEM) {
  process.stderr.write(`\n${NODE_PROBLEM}\n\n`);
  process.exit(1);
}
if (!process.env.NODE_TEST_CONTEXT) {
  try {
    settingsInfo = applySettingsFile();
  } catch (e) {
    settingsInfo = { file: null, applied: [], warnings: [`Soubor nastavení nejde načíst: ${e.message}`] };
  }
}

module.exports = {
  loadConfig,
  ALL_SOURCES,
  DEFAULT_SOURCES,
  PROJECT_DIR,
  DEFAULT_SETTINGS_FILE,
  KNOWN_KEYS,
  envBool,
  envInt,
  envNumber,
  envStr,
  parseSchedule,
  parseSources,
  parseSettings,
  applySettingsFile,
  decodeText,
  nodeVersionProblem,
};
