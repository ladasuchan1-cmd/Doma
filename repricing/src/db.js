'use strict';
// Databáze (SQLite přes vestavěný node:sqlite) – schéma, migrace a drobné pomocníky.
// Pravidla pro volající:
//  - node:sqlite neumí vázat boolean ani undefined → používejte 1/0 a null (viz bind()).
//  - Časy ukládáme jako ISO řetězce v UTC (nowIso()).
//  - JSON sloupce (attrs, config, filter, flags, explain, stats, …) jsou TEXT; čtěte přes parseJson().

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  // v1 – základní schéma
  `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL,
    code_key TEXT NOT NULL UNIQUE,
    ean TEXT, ean_key TEXT,
    mpn TEXT, mpn_key TEXT,
    name TEXT,
    manufacturer TEXT,
    category TEXT,
    supplier TEXT,
    owner TEXT,
    purchase_price REAL,
    price REAL,
    vat_rate REAL,
    msrp REAL,
    stock REAL,
    sales_30 REAL,
    sales_90 REAL,
    attrs TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1,
    locked INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,               -- NULL = zamčeno natrvalo (pokud locked = 1)
    min_price REAL,
    max_price REAL,
    note TEXT,
    price_changed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX products_ean_key ON products(ean_key);
  CREATE INDEX products_mpn_key ON products(mpn_key);
  CREATE INDEX products_manufacturer ON products(manufacturer);

  CREATE TABLE competitors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    label TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    tags TEXT NOT NULL DEFAULT '[]',
    note TEXT,
    created_at TEXT NOT NULL
  );

  -- Ruční/odvozené párování cizích identifikátorů na náš produkt.
  -- competitor_id = 0 → platí pro všechny konkurenty.
  CREATE TABLE product_aliases (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,              -- 'code' | 'ean' | 'mpn' | 'ext' | 'name'
    value_key TEXT NOT NULL,
    competitor_id INTEGER NOT NULL DEFAULT 0,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    UNIQUE (kind, value_key, competitor_id)
  );

  -- Aktuální nabídka konkurenta pro náš produkt (1 řádek na dvojici).
  CREATE TABLE offers (
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    competitor_id INTEGER NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
    price REAL NOT NULL,
    shipping REAL,
    in_stock INTEGER,                -- 1 / 0 / NULL = neznámo
    delivery_days REAL,
    url TEXT,
    name TEXT,
    observed_at TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    prev_price REAL,
    changed_at TEXT,
    source_id INTEGER,
    PRIMARY KEY (product_id, competitor_id)
  );
  CREATE INDEX offers_competitor ON offers(competitor_id);

  -- Historie konkurenčních cen – zapisuje se jen při změně ceny nebo dostupnosti.
  CREATE TABLE offer_history (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    competitor_id INTEGER NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
    price REAL NOT NULL,
    in_stock INTEGER,
    observed_at TEXT NOT NULL
  );
  CREATE INDEX offer_history_pc ON offer_history(product_id, competitor_id, observed_at);

  -- Nabídky, které se nepodařilo spárovat s naším katalogem.
  CREATE TABLE unmatched_offers (
    id INTEGER PRIMARY KEY,
    competitor_id INTEGER REFERENCES competitors(id) ON DELETE CASCADE,
    match_key TEXT NOT NULL,
    code TEXT, ean TEXT, mpn TEXT, ext_id TEXT,
    name TEXT,
    price REAL,
    url TEXT,
    raw TEXT,
    seen_count INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    UNIQUE (competitor_id, match_key)
  );

  -- Historie našich cen (export, import z katalogu, ruční změna).
  CREATE TABLE price_history (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    price REAL NOT NULL,
    source TEXT NOT NULL,            -- 'import' | 'export' | 'manual'
    ref_id INTEGER,
    at TEXT NOT NULL
  );
  CREATE INDEX price_history_product ON price_history(product_id, at);

  CREATE TABLE segments (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    filter TEXT NOT NULL DEFAULT '{}',
    color TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- segment_id NULL = strategie platí pro všechny produkty.
  -- Segment používaný strategií nelze smazat (RESTRICT) – jinak by strategie nečekaně začala platit na vše.
  CREATE TABLE strategies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    segment_id INTEGER REFERENCES segments(id) ON DELETE RESTRICT,
    priority INTEGER NOT NULL DEFAULT 100,
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,            -- 'running' | 'done' | 'error'
    trigger TEXT NOT NULL,           -- 'manual' | 'schedule' | 'api'
    stats TEXT NOT NULL DEFAULT '{}',
    error TEXT
  );

  CREATE TABLE proposals (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    strategy_id INTEGER,
    segment_id INTEGER,
    old_price REAL,
    new_price REAL NOT NULL,
    target_price REAL,
    reference_price REAL,
    market_min REAL,
    competitor_count INTEGER,
    rank_before INTEGER,
    rank_after INTEGER,
    margin_before REAL,
    margin_after REAL,
    change_abs REAL,
    change_pct REAL,
    status TEXT NOT NULL,            -- 'pending' | 'approved' | 'rejected' | 'exported' | 'superseded'
    flags TEXT NOT NULL DEFAULT '[]',
    explain TEXT NOT NULL DEFAULT '[]',
    manual_price REAL,
    created_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT,
    exported_at TEXT,
    export_id INTEGER
  );
  CREATE INDEX proposals_status ON proposals(status);
  CREATE INDEX proposals_product ON proposals(product_id, id);
  CREATE INDEX proposals_run ON proposals(run_id);

  CREATE TABLE exports (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,              -- 'feed' | 'pohoda' | 'webhook' | 'csv' | 'xlsx' | 'json' | 'xml' | 'ack'
    target TEXT,
    count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,            -- 'ok' | 'error' | 'pending'
    detail TEXT
  );

  -- Zdroj dat = mapování polí + volitelně URL a interval stahování.
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,              -- 'offers' | 'products'
    url TEXT,
    method TEXT NOT NULL DEFAULT 'GET',
    headers TEXT NOT NULL DEFAULT '{}',
    mapping TEXT NOT NULL DEFAULT '{}',
    options TEXT NOT NULL DEFAULT '{}',
    interval_minutes INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    last_status TEXT,
    last_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE imports (
    id INTEGER PRIMARY KEY,
    source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,              -- 'offers' | 'products'
    format TEXT,
    origin TEXT,                     -- 'upload' | 'api' | 'url' | 'schedule'
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,            -- 'running' | 'ok' | 'error'
    stats TEXT NOT NULL DEFAULT '{}',
    error TEXT
  );

  CREATE TABLE tokens (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    actor TEXT,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id INTEGER,
    detail TEXT
  );
  CREATE INDEX audit_at ON audit(at);
  `,
  // v2 – „doručeno“: cena a čas, kdy byl schválený návrh naposledy vydán (feed / export / ceník bez označení).
  // Potvrzení převzetí (POST /export/ack) podle kódů pak označí přesně to, co admin dostal – ne novější návrh,
  // který mezitím vznikl (přecenění mezi stažením a potvrzením) a který admin nikdy neviděl.
  `
  ALTER TABLE proposals ADD COLUMN served_price REAL;
  ALTER TABLE proposals ADD COLUMN served_at TEXT;
  `,
];

const DEFAULT_SETTINGS = {
  currency: 'CZK',
  vat_rate_default: 21,
  // Nákupní ceny v katalogu jsou bez DPH (standard Pohody). true = importované nákupní ceny obsahují DPH.
  purchase_includes_vat: false,
  // Nabídky konkurence starší než N dní se v cenotvorbě ignorují.
  offer_max_age_days: 7,
  // Metriky trhu v přehledech (ne ve strategiích) počítat jen z nabídek skladem.
  metrics_in_stock_only: false,
  export: {
    // Po exportu/ack přepsat products.price novou cenou a zapsat do historie.
    update_current_price: true,
    xml: { root: 'prices', item: 'item', fields: ['code', 'ean', 'name', 'price', 'old_price', 'vat_rate', 'currency', 'changed_at'] },
    // price_level_includes_vat: ceny zvolené cenové hladiny v POHODĚ jsou s DPH (true) / bez DPH (false)
    pohoda: { ico: '', application: 'Cenotvorba', filter_by: 'code', price_level: '', price_level_includes_vat: true, encoding: 'windows-1250' },
    webhook: { url: '', format: 'json', headers: {}, auto_push: false, timeout_ms: 20000 },
  },
  schedule: {
    // 0 = vypnuto. Automatické přecenění každých N minut.
    run_interval_minutes: 0,
    // Po úspěšném importu nabídek spustit přecenění.
    run_after_import: false,
    // Po přecenění automaticky odeslat schválené změny webhookem.
    auto_push_after_run: false,
  },
  retention_days: 180,
  // Nahrazené (superseded) návrhy jsou jen historie – mažou se dřív (nejvýše retention_days).
  retention_superseded_days: 14,
};

function nowIso(d) {
  return (d ? new Date(d) : new Date()).toISOString();
}

function parseJson(text, fallback) {
  if (text == null || text === '') return fallback;
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function json(value) {
  return JSON.stringify(value ?? null);
}

// Převod hodnoty na typ, který node:sqlite umí navázat.
function bind(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

function bindAll(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = bind(v);
  return out;
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  let version = row ? Number(row.value) : 0;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version];
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      version += 1;
      db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(version));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return version;
}

/**
 * Otevře (a případně vytvoří) databázi a aplikuje migrace.
 * @param {string} [file] cesta k souboru, ':memory:' (výchozí) pro testy
 * @returns {import('node:sqlite').DatabaseSync}
 */
function openDb(file = ':memory:') {
  let db;
  try {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    db = new DatabaseSync(file);
    // první zápisová operace ověří i právo zápisu do adresáře (WAL, -shm)
    if (file !== ':memory:') db.exec('PRAGMA user_version');
  } catch (e) {
    // „unable to open database file“ bez cesty nic neřekne – typicky bind mount v Dockeru s právy roota (ops-12)
    if (file === ':memory:') throw e;
    const abs = path.resolve(file);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const err = new Error(
      `Nelze otevřít databázi ${abs}${uid != null ? ` (uživatel uid ${uid})` : ''}: ${e.message} – zkontrolujte, že adresář ${path.dirname(abs)} existuje ` +
        `a je zapisovatelný (v Dockeru s připojeným adresářem např. „chown 1000:1000 ${path.dirname(abs)}“ nebo docker run --user).`
    );
    err.code = e.code || 'DB_OPEN_FAILED';
    err.cause = e;
    throw err;
  }
  if (file !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    // WAL po velké transakci (import, přecenění, úklid) se na disku zkrátí na nejvýše 64 MB (ops-5)
    db.exec('PRAGMA journal_size_limit = 67108864');
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db);
  return db;
}

const txDepth = new WeakMap();

/**
 * Spustí fn uvnitř transakce. Vnořená volání používají SAVEPOINT.
 * fn musí být synchronní (node:sqlite je synchronní) – async funkce by transakci neudržela.
 */
function tx(db, fn) {
  const depth = txDepth.get(db) || 0;
  const sp = `sp_${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  txDepth.set(db, depth + 1);
  try {
    const result = fn();
    if (result && typeof result.then === 'function') throw new Error('tx(): fn nesmí být async');
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return result;
  } catch (e) {
    try {
      db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    } catch {
      /* transakce už mohla být ukončena */
    }
    throw e;
  } finally {
    txDepth.set(db, depth);
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

/** Vrátí všechna nastavení sloučená s výchozími hodnotami. */
function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  let out = DEFAULT_SETTINGS;
  for (const r of rows) {
    if (r.key.startsWith('_')) continue; // interní klíče (hash hesla, tajemství)
    out = deepMerge(out, { [r.key]: parseJson(r.value, null) });
  }
  return out;
}

function getSetting(db, key, fallback) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!r) return key in DEFAULT_SETTINGS ? DEFAULT_SETTINGS[key] : fallback;
  return parseJson(r.value, fallback);
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, json(value));
}

function audit(db, { actor = null, action, entity = null, entity_id = null, detail = null }) {
  db.prepare('INSERT INTO audit(at, actor, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)').run(
    nowIso(),
    actor,
    action,
    entity,
    entity_id,
    detail == null ? null : typeof detail === 'string' ? detail : json(detail)
  );
}

module.exports = {
  openDb,
  migrate,
  tx,
  nowIso,
  parseJson,
  json,
  bind,
  bindAll,
  getSettings,
  getSetting,
  setSetting,
  deepMerge,
  audit,
  DEFAULT_SETTINGS,
  SCHEMA_VERSION: MIGRATIONS.length,
};
