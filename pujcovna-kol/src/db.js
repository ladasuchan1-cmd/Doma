'use strict';
// Databáze per tenant (SQLite přes vestavěný node:sqlite) – schéma, migrace a drobné pomocníky (SPEC kap. 4).
// Pravidla pro volající:
//  - node:sqlite neumí vázat boolean ani undefined → používejte bind() (boolean → 1/0, undefined → null).
//  - Časy ukládáme jako ISO řetězce v UTC (nowIso()); peníze v haléřích (*_minor, INTEGER).
//  - JSON sloupce (photos, sizes, specs, data, payload, meta, …) jsou TEXT; čtěte přes parseJson().
//  - Zápisy, které musí být atomické (kontrola dostupnosti + vložení), obalte transaction(db, fn) – BEGIN IMMEDIATE.
// Vstup: slug tenanta + datový adresář (openTenantDb) nebo cesta k souboru / ':memory:' (openDb).

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  // v1 – kompletní schéma dema (SPEC kap. 4). Všechny tabulky zakládá kostra; features je jen používají.
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner','staff')),
    totp_secret_enc TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    disabled INTEGER NOT NULL DEFAULT 0,
    last_login_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('public','admin')),
    user_id INTEGER REFERENCES users(id),
    data TEXT NOT NULL DEFAULT '{}',
    csrf TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip_hash TEXT
  );

  CREATE TABLE bike_types (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('mtb','trek','ebike','kids','gravel','city')),
    description TEXT,
    photos TEXT NOT NULL DEFAULT '[]',
    sizes TEXT NOT NULL DEFAULT '[]',
    specs TEXT NOT NULL DEFAULT '{}',
    deposit_minor INTEGER NOT NULL,
    fee_minor INTEGER NOT NULL,
    value_minor INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE bikes (
    id INTEGER PRIMARY KEY,
    bike_type_id INTEGER NOT NULL REFERENCES bike_types(id),
    inventory_code TEXT NOT NULL UNIQUE,
    size TEXT NOT NULL,
    frame_no_enc TEXT,
    status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','maintenance','retired')),
    note TEXT
  );

  CREATE TABLE seasons (id INTEGER PRIMARY KEY, name TEXT NOT NULL, date_from TEXT NOT NULL, date_to TEXT NOT NULL);

  CREATE TABLE price_rules (
    id INTEGER PRIMARY KEY,
    bike_type_id INTEGER NOT NULL REFERENCES bike_types(id),
    season_id INTEGER REFERENCES seasons(id),
    unit TEXT NOT NULL CHECK (unit IN ('hour','halfday','day')),
    from_qty INTEGER NOT NULL DEFAULT 1,
    price_minor INTEGER NOT NULL
  );

  CREATE TABLE closures (id INTEGER PRIMARY KEY, date_from TEXT NOT NULL, date_to TEXT NOT NULL, reason TEXT);

  CREATE TABLE accessories (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    price_minor INTEGER NOT NULL,
    stock INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    email_hmac TEXT NOT NULL,
    email_enc TEXT NOT NULL,
    name_enc TEXT NOT NULL,
    phone_enc TEXT,
    address_enc TEXT,
    birth_date_enc TEXT,
    id_doc_type TEXT,
    id_doc_number_enc TEXT,
    id_doc_consent_at TEXT,
    id_doc_delete_after TEXT,
    marketing_consent_at TEXT,
    created_at TEXT NOT NULL,
    anonymized_at TEXT
  );
  CREATE INDEX customers_email ON customers(email_hmac);

  CREATE TABLE reservations (
    id INTEGER PRIMARY KEY,
    number TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN
      ('draft','awaiting_fee','confirmed','checked_out','returned','closed','expired','cancelled_by_customer','cancelled_by_operator','no_show')),
    customer_id INTEGER REFERENCES customers(id),
    from_at TEXT NOT NULL,
    to_at TEXT NOT NULL,
    total_minor INTEGER NOT NULL,
    fee_minor INTEGER NOT NULL,
    paid_minor INTEGER NOT NULL DEFAULT 0,
    deposit_minor INTEGER NOT NULL DEFAULT 0,
    deposit_method TEXT,
    terms_version TEXT,
    consent_at TEXT,
    consent_ip_hash TEXT,
    id_doc_ack_at TEXT,
    expires_at TEXT,
    note TEXT,
    token_hash TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX reservations_range ON reservations(from_at, to_at, status);

  CREATE TABLE reservation_items (
    id INTEGER PRIMARY KEY,
    reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    bike_type_id INTEGER NOT NULL REFERENCES bike_types(id),
    size TEXT NOT NULL,
    bike_id INTEGER REFERENCES bikes(id),
    unit_price_minor INTEGER NOT NULL,
    fee_minor INTEGER NOT NULL,
    accessories TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE payments (
    id INTEGER PRIMARY KEY,
    reservation_id INTEGER NOT NULL REFERENCES reservations(id),
    purpose TEXT NOT NULL CHECK (purpose IN ('fee','balance','deposit_hold','refund')),
    method TEXT NOT NULL CHECK (method IN ('card','bank_transfer','cash','terminal')),
    provider TEXT NOT NULL,
    provider_ref TEXT,
    amount_minor INTEGER NOT NULL,
    captured_minor INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN
      ('created','pending','paid','authorized','captured','partially_captured','released','failed','expired','refunded','partially_refunded')),
    idempotency_key TEXT UNIQUE,
    vs TEXT,
    spayd TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE bank_transactions (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    tx_id TEXT NOT NULL UNIQUE,
    booked_at TEXT NOT NULL,
    amount_minor INTEGER NOT NULL,
    vs TEXT,
    msg TEXT,
    counter_account TEXT,
    counter_name TEXT,
    matched_payment_id INTEGER REFERENCES payments(id),
    raw TEXT
  );

  CREATE TABLE webhook_events (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    event_id TEXT NOT NULL,
    payload TEXT,
    received_at TEXT NOT NULL,
    processed_at TEXT,
    UNIQUE (provider, event_id)
  );

  CREATE TABLE ledger_entries (
    id INTEGER PRIMARY KEY,
    reservation_id INTEGER NOT NULL REFERENCES reservations(id),
    type TEXT NOT NULL CHECK (type IN
      ('fee_paid','balance_paid','deposit_held','deposit_captured','deposit_released','refund','fee_forfeited','damage')),
    amount_minor INTEGER NOT NULL,
    payment_id INTEGER REFERENCES payments(id),
    note TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    reservation_id INTEGER NOT NULL REFERENCES reservations(id),
    type TEXT NOT NULL CHECK (type IN
      ('receipt','simplified_tax_doc','tax_doc','final_doc','credit_note','contract','handover','return_protocol')),
    number TEXT NOT NULL UNIQUE,
    issued_at TEXT NOT NULL,
    html TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE handovers (
    id INTEGER PRIMARY KEY,
    reservation_id INTEGER NOT NULL REFERENCES reservations(id),
    type TEXT NOT NULL CHECK (type IN ('pickup','return')),
    at TEXT NOT NULL,
    by_user_id INTEGER REFERENCES users(id),
    condition TEXT NOT NULL DEFAULT '{}',
    damage_minor INTEGER NOT NULL DEFAULT 0,
    note TEXT
  );

  CREATE TABLE content_pages (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    body_md TEXT NOT NULL,
    published_at TEXT,
    UNIQUE (slug, version)
  );

  CREATE TABLE poi_overrides (poi_id TEXT PRIMARY KEY, hidden INTEGER NOT NULL DEFAULT 0, custom_text TEXT, sort INTEGER);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    user_id INTEGER,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id TEXT,
    meta TEXT,
    ip_hash TEXT
  );

  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    to_hmac TEXT,
    subject TEXT NOT NULL,
    body_text TEXT NOT NULL,
    body_html TEXT,
    payload TEXT,
    run_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at TEXT,
    error TEXT,
    created_at TEXT NOT NULL
  );
  `,
];

/** Aktuální čas jako ISO 8601 UTC. */
function nowIso() {
  return new Date().toISOString();
}

/** Převede hodnotu na typ, který node:sqlite umí vázat: boolean → 1/0, undefined → null, objekty beze změny. */
function bind(value) {
  if (value === undefined) return null;
  if (value === true) return 1;
  if (value === false) return 0;
  return value;
}

/** Bezpečný JSON.parse – při chybě nebo prázdném vstupu vrátí fallback. */
function parseJson(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback;
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Spustí fn v transakci BEGIN IMMEDIATE (jediný zapisovatel → kontrola + zápis jsou atomické).
 * Výjimka z fn → ROLLBACK a znovu vyhození. Vrací návratovou hodnotu fn.
 */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* transakce už mohla být zrušena (např. SQLITE_BUSY) */
    }
    throw e;
  }
}

/** Přečte verzi schématu z meta.schema_version (0 = prázdná DB). */
function schemaVersion(db) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return row ? Number(row.value) || 0 : 0;
}

/** Aplikuje chybějící migrace; každou v transakci. Vrací výslednou verzi. */
function migrate(db) {
  let version = schemaVersion(db);
  for (let i = version; i < MIGRATIONS.length; i++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[i]);
      db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
        String(i + 1)
      );
    });
    version = i + 1;
  }
  return version;
}

/** Otevře (a případně vytvoří) databázi v souboru nebo ':memory:' a spustí migrace. */
function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

/** Cesta k DB tenanta: <dataDir>/tenants/<slug>.db */
function tenantDbPath(slug, dataDir) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(String(slug))) throw new Error(`Neplatný slug tenanta: ${slug}`);
  return path.join(dataDir, 'tenants', `${slug}.db`);
}

/** Otevře DB tenanta (WAL, foreign_keys, busy_timeout) a spustí migrace. */
function openTenantDb(slug, dataDir) {
  return openDb(tenantDbPath(slug, dataDir));
}

/** Pomocníci pro tabulku settings (JSON hodnoty). */
function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? parseJson(row.value, fallback) : fallback;
}

function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run(key, JSON.stringify(value), nowIso());
}

module.exports = {
  MIGRATIONS,
  nowIso,
  bind,
  parseJson,
  transaction,
  migrate,
  schemaVersion,
  openDb,
  openTenantDb,
  tenantDbPath,
  getSetting,
  setSetting,
};
