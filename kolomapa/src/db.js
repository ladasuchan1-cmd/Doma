'use strict';
// Databáze Kolomapy (SQLite přes vestavěný node:sqlite) – schéma, migrace a pomocníci.
// Pravidla pro volající:
//  - node:sqlite neumí vázat boolean ani undefined → používejte 1/0 a null (viz bind()).
//  - Časy ukládáme jako ISO řetězce v UTC (nowIso()).
//  - JSON sloupce (params, features, est_factors, stats …) jsou TEXT; čtěte přes parseJson().

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

  -- Jeden řádek = jeden inzerát na jednom webu.
  CREATE TABLE listings (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,              -- bazos | sbazar | aukro | cyklobazar
    source_id TEXT NOT NULL,           -- ID inzerátu na webu
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,                  -- plný text z detailu (nebo zkrácený z výpisu, dokud detail nestáhneme)
    price_czk REAL,                    -- NULL = dohodou / v textu / aukce bez ceny
    price_note TEXT,                   -- „Dohodou“, „aukce – aktuální příhoz“, „Kup teď“ …
    posted_at TEXT,                    -- kdy inzerát vznikl / byl naposledy obnoven (podle webu)
    category_src TEXT,                 -- kategorie na webu
    location_text TEXT,                -- město / lokalita, jak ji uvádí web
    psc TEXT,
    okres TEXT,                        -- výsledek geolokace (okres podle obce / PSČ); text z webu je v src_okres (v4)
    kraj TEXT,                         -- kód kraje (PHA, STC, JHC, PLK, KVK, ULK, LBK, HKK, PAK, VYS, JHM, OLK, ZLK, MSK) z geolokace; text z webu v src_kraj
    lat REAL,                          -- zobrazená poloha (výsledek geolokace; viz src_lat/src_lon z v3)
    lon REAL,
    geo_precision TEXT,                -- exact | city | psc | okres | kraj | NULL
    photo_url TEXT,                    -- 1 hlavní fotka
    photo_count INTEGER,
    params TEXT NOT NULL DEFAULT '{}', -- strukturované údaje z webu (velikost rámu, rok, stav …)
    seller_type TEXT,                  -- private | company | NULL
    views INTEGER,
    -- klasifikace a vytěžené údaje
    is_bike INTEGER,                   -- 1 kolo, 0 není kolo (díly, oblečení …), NULL = neklasifikováno
    bike_type TEXT,                    -- mtb_hardtail | mtb_full | road | gravel | trekking | city | kids | bmx | dirt | ebike_mtb | ebike_trekking | ebike_city | ebike_road | other
    features TEXT NOT NULL DEFAULT '{}',
    -- nacenění
    est_czk REAL,
    est_low REAL,
    est_high REAL,
    est_confidence REAL,
    est_method TEXT,                   -- rules | comps | model | ai
    est_factors TEXT NOT NULL DEFAULT '[]',
    est_at TEXT,
    deal_ratio REAL,                   -- price_czk / est_czk (< 1 = levnější než tržní hodnota)
    max_buy_czk REAL,                  -- doporučená max. výkupní cena pro obchod
    ai_czk REAL,
    ai_low REAL,
    ai_high REAL,
    ai_condition TEXT,
    ai_notes TEXT,
    ai_model TEXT,
    ai_at TEXT,
    ai_input_hash TEXT,
    -- životní cyklus
    content_hash TEXT,                 -- otisk titulku + ceny + popisu (změna → přepočet)
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    detail_at TEXT,                    -- kdy jsme naposledy stáhli detail
    gone_at TEXT,                      -- kdy inzerát zmizel z webu (prodáno / smazáno); NULL = aktivní
    UNIQUE (source, source_id)
  );
  CREATE INDEX listings_active ON listings(gone_at, is_bike);
  CREATE INDEX listings_kraj ON listings(kraj);
  CREATE INDEX listings_seen ON listings(source, last_seen_at);

  CREATE TABLE price_history (
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    price_czk REAL,
    PRIMARY KEY (listing_id, at)
  );

  -- Vlastní prodeje obchodu (trénovací data); bez osobních údajů.
  CREATE TABLE sales (
    id INTEGER PRIMARY KEY,
    code TEXT,
    date TEXT,
    kind TEXT NOT NULL,                -- bazar | provereno
    title TEXT NOT NULL,
    size TEXT,
    brand TEXT,
    branch TEXT,
    price_czk REAL NOT NULL,           -- konečná prodejní cena vč. DPH
    cost_czk REAL,
    UNIQUE (code, date, title, price_czk)
  );

  CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,              -- running | ok | partial | error
    trigger TEXT,                      -- schedule | manual | cli | start
    stats TEXT NOT NULL DEFAULT '{}',
    error TEXT
  );
  `,
  // v2 – počítadlo celých průchodů, ve kterých inzerát chyběl (zmizelý = chybí 2× nebo web potvrdí smazání)
  `
  ALTER TABLE listings ADD COLUMN missed_scans INTEGER NOT NULL DEFAULT 0;
  `,
  // v3 – souřadnice dodané webem odděleně od zobrazených (lat/lon = výsledek geolokace) + jejich přesnost.
  // Weby dávají často jen střed PSČ / obce – 'exact' by vypnulo rozptyl pinů a piny by ležely na sobě.
  `
  ALTER TABLE listings ADD COLUMN src_lat REAL;
  ALTER TABLE listings ADD COLUMN src_lon REAL;
  ALTER TABLE listings ADD COLUMN src_geo_precision TEXT;
  UPDATE listings SET src_lat = lat, src_lon = lon, src_geo_precision = 'exact' WHERE geo_precision = 'exact';
  `,
  // v4 – okres a kraj tak, jak je uvádí web (src_okres / src_kraj), odděleně od výsledku geolokace (okres / kraj = kód).
  // Dřív zdroj přepsal kód kraje textem („Jihomoravský kraj“) a inzeráty bez nové geolokace zmizely z map krajů.
  // Okres/kraj v DB uvádějí ze zdrojů jen Sbazar a Cyklobazar (u ostatních je v okres/kraj jen výsledek geolokace);
  // inzeráty s textem místo kódu kraje se znovu geolokují.
  `
  ALTER TABLE listings ADD COLUMN src_okres TEXT;
  ALTER TABLE listings ADD COLUMN src_kraj TEXT;
  UPDATE listings SET src_okres = okres, src_kraj = kraj WHERE source IN ('sbazar', 'cyklobazar');
  UPDATE listings SET geo_precision = NULL
   WHERE kraj IS NOT NULL AND kraj NOT IN ('PHA', 'STC', 'JHC', 'PLK', 'KVK', 'ULK', 'LBK', 'HKK', 'PAK', 'VYS', 'JHM', 'OLK', 'ZLK', 'MSK');
  `,
];

function nowIso(d = new Date()) {
  return d.toISOString();
}

/** node:sqlite neumí undefined ani boolean. */
function bind(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  return v;
}

function parseJson(s, fallback = null) {
  if (s == null || s === '') return fallback;
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

/**
 * Otevře (a případně založí) databázi a provede migrace.
 * @param {string} file cesta k souboru nebo ':memory:'
 * @returns {DatabaseSync}
 */
function openDb(file) {
  if (file !== ':memory:') {
    const dir = path.dirname(file);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      throw new Error(`Nelze vytvořit adresář databáze ${dir}: ${e.message}`);
    }
  }
  let db;
  try {
    db = new DatabaseSync(file);
  } catch (e) {
    throw new Error(`Nelze otevřít databázi ${file}: ${e.message} – zkontrolujte, že adresář je zapisovatelný.`);
  }
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    // WAL po velkém běhu (nacenění přepíše tisíce řádků) nedržet na disku v plné velikosti
    db.exec('PRAGMA journal_size_limit = 16777216');
  }
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

/**
 * Migrace schématu. Server a tools/run.js mohou databázi otevřít současně: verze se proto čte znovu uvnitř zápisové
 * transakce (BEGIN IMMEDIATE) – migraci, kterou mezitím provedl jiný proces, nespustíme podruhé (ALTER TABLE by
 * selhal na „duplicate column“ a proces by nenastartoval).
 */
function migrate(db) {
  const userVersion = () => Number(db.prepare('PRAGMA user_version').get().user_version) || 0;
  while (userVersion() < MIGRATIONS.length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const v = userVersion();
      if (v < MIGRATIONS.length) {
        db.exec(MIGRATIONS[v]);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

/**
 * Zahájí transakci; vrací true, pokud už jedna běží (pak se má použít SAVEPOINT). db.isTransaction má node:sqlite
 * až od Node 22.16 / 24.0 – na starších (engines: >= 22.13) se to pozná podle chyby BEGIN uvnitř transakce.
 */
function beginOrNested(db) {
  if (typeof db.isTransaction === 'boolean') {
    if (db.isTransaction) return true;
    db.exec('BEGIN');
    return false;
  }
  try {
    db.exec('BEGIN');
    return false;
  } catch (e) {
    if (/within a transaction/i.test(String(e?.message))) return true;
    throw e;
  }
}

/** Spustí fn v transakci (vnořené volání použije SAVEPOINT). */
function tx(db, fn) {
  if (beginOrNested(db)) {
    const name = `sp_${Math.random().toString(36).slice(2, 10)}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const r = fn();
      db.exec(`RELEASE ${name}`);
      return r;
    } catch (e) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw e;
    }
  }
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? parseJson(row.value, fallback) : fallback;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

/** Řádek z tabulky listings → objekt pro API (JSON sloupce rozbalené). */
function listingFromRow(r) {
  if (!r) return null;
  return {
    ...r,
    params: parseJson(r.params, {}),
    features: parseJson(r.features, {}),
    est_factors: parseJson(r.est_factors, []),
  };
}

module.exports = { openDb, migrate, tx, bind, parseJson, nowIso, getSetting, setSetting, listingFromRow, MIGRATIONS };
