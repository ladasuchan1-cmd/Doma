'use strict';
// Testy src/db.js: migrace, schema_version, pomocníci, transakce.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb, migrate, schemaVersion, MIGRATIONS, bind, parseJson, transaction, nowIso, getSetting, setSetting } = require('../src/db');

const EXPECTED_TABLES = [
  'meta', 'settings', 'users', 'sessions', 'bike_types', 'bikes', 'seasons', 'price_rules', 'closures', 'accessories', 'customers',
  'reservations', 'reservation_items', 'payments', 'bank_transactions', 'webhook_events', 'ledger_entries', 'documents', 'handovers',
  'content_pages', 'poi_overrides', 'audit_log', 'outbox',
];

test('migrace založí celé schéma a nastaví schema_version', () => {
  const db = openDb(':memory:');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  for (const t of EXPECTED_TABLES) assert.ok(tables.includes(t), `chybí tabulka ${t}`);
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, String(MIGRATIONS.length));
  // indexy
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
  assert.ok(idx.includes('customers_email'));
  assert.ok(idx.includes('reservations_range'));
  db.close();
});

test('opakovaná migrace je idempotentní', () => {
  const db = openDb(':memory:');
  assert.equal(migrate(db), MIGRATIONS.length);
  assert.equal(migrate(db), MIGRATIONS.length);
  db.close();
});

test('PRAGMA foreign_keys je zapnuté a CHECK omezení platí', () => {
  const db = openDb(':memory:');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.throws(() => db.prepare("INSERT INTO users(email, name, password_hash, role, created_at) VALUES ('a@b.cz', 'A', 'x', 'superuser', ?)").run(nowIso()), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO bikes(bike_type_id, inventory_code, size) VALUES (999, 'K-1', 'M')").run(), /FOREIGN KEY/);
  db.close();
});

test('bind převádí boolean a undefined', () => {
  assert.equal(bind(true), 1);
  assert.equal(bind(false), 0);
  assert.equal(bind(undefined), null);
  assert.equal(bind(null), null);
  assert.equal(bind('x'), 'x');
  assert.equal(bind(5), 5);
});

test('parseJson je bezpečný', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.equal(parseJson('nevalidní', 'fb'), 'fb');
  assert.equal(parseJson('', 'fb'), 'fb');
  assert.equal(parseJson(null, 'fb'), 'fb');
  assert.deepEqual(parseJson({ a: 2 }), { a: 2 });
});

test('transaction commituje a při chybě vrací zpět', () => {
  const db = openDb(':memory:');
  transaction(db, () => {
    db.prepare("INSERT INTO seasons(name, date_from, date_to) VALUES ('S', '2026-06-15', '2026-09-15')").run();
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seasons').get().n, 1);
  assert.throws(() =>
    transaction(db, () => {
      db.prepare("INSERT INTO seasons(name, date_from, date_to) VALUES ('T', '2026-01-01', '2026-01-02')").run();
      throw new Error('rollback test');
    })
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seasons').get().n, 1);
  // po rollbacku lze dál pracovat
  transaction(db, () => db.prepare("INSERT INTO seasons(name, date_from, date_to) VALUES ('U', '2026-01-01', '2026-01-02')").run());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seasons').get().n, 2);
  db.close();
});

test('settings pomocníci ukládají JSON', () => {
  const db = openDb(':memory:');
  setSetting(db, 'feeMinor', { default: 30000 });
  assert.deepEqual(getSetting(db, 'feeMinor'), { default: 30000 });
  setSetting(db, 'feeMinor', { default: 35000 });
  assert.equal(getSetting(db, 'feeMinor').default, 35000);
  assert.equal(getSetting(db, 'neni', 'fb'), 'fb');
  db.close();
});

test('nowIso vrací ISO UTC', () => {
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
