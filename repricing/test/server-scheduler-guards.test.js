'use strict';
// Regresní testy plánovače: úklid nahrazených návrhů a nespárovaných nabídek (ops-5, ops-11), posun hodin (ops-10),
// přecenění na hranici časového okna strategie (ops-9) a označení jen doručených cen po webhooku (ops-4).
const test = require('node:test');
const assert = require('node:assert');
const { openDb, setSetting } = require('../src/db');
const { startScheduler, retentionCleanup, RETENTION_KEY } = require('../src/server/scheduler');
const { dueSources } = require('../src/import/sources');
const { memoryLogger } = require('./server-helpers');

const NOW = new Date('2026-09-25T12:00:00.000Z'); // pátek 14:00 v Praze
const daysAgo = (d, from = NOW) => new Date(from.getTime() - d * 86400000).toISOString();

function baseDb() {
  const db = openDb(':memory:');
  setSetting(db, RETENTION_KEY, NOW.toISOString());
  return db;
}

function fakeDeps(db) {
  const calls = { runPricing: [], markExported: [] };
  return {
    calls,
    deps: {
      dueSources: () => [],
      runSource: async () => ({ stats: {} }),
      runPricing: (d, opts) => {
        calls.runPricing.push(opts);
        const at = new Date(opts.now).toISOString();
        const r = db.prepare("INSERT INTO runs(started_at, finished_at, status, trigger, stats) VALUES (?, ?, 'done', ?, '{}')").run(at, at, opts.trigger);
        return { run_id: Number(r.lastInsertRowid), stats: {} };
      },
      exportRows: () => [{ proposal_id: 5, product_id: 1, code: 'A', price: 123 }],
      pushWebhook: async () => ({ ok: true, status: 200 }),
      markExported: (d, ids, opts) => {
        calls.markExported.push({ ids, opts });
        return { export_id: 1, count: ids.length };
      },
      logExport: () => {},
    },
  };
}

test('ops-5 / ops-11: úklid maže nahrazené návrhy po 14 dnech a nespárované nabídky neviděné 30 dní', () => {
  const db = baseDb();
  const iso = NOW.toISOString();
  db.prepare("INSERT INTO products(id, code, code_key, created_at, updated_at) VALUES (1, 'A', 'A', ?, ?)").run(iso, iso);
  db.prepare("INSERT INTO competitors(id, name, name_key, created_at) VALUES (1, 'Shop', 'shop', ?)").run(iso);
  db.prepare("INSERT INTO runs(id, started_at, status, trigger) VALUES (1, ?, 'done', 'manual')").run(daysAgo(100));
  const addProposal = (status, created) => db.prepare('INSERT INTO proposals(run_id, product_id, new_price, status, created_at) VALUES (1, 1, 100, ?, ?)').run(status, created);
  addProposal('superseded', daysAgo(20)); // smazat (nad 14 dní)
  addProposal('superseded', daysAgo(10)); // nechat
  addProposal('rejected', daysAgo(20)); // nechat (zamítnuté drží retention_days)
  const addUnmatched = (key, seen) =>
    db.prepare("INSERT INTO unmatched_offers(competitor_id, match_key, price, raw, seen_count, first_seen_at, last_seen_at) VALUES (1, ?, 100, '{}', 1, ?, ?)").run(key, seen, seen);
  addUnmatched('ean:1', daysAgo(45)); // smazat
  addUnmatched('ean:2', daysAgo(5)); // nechat
  const r = retentionCleanup(db, { days: 180, now: NOW });
  assert.strictEqual(r.proposals, 1);
  assert.strictEqual(r.unmatched_offers, 1);
  assert.deepStrictEqual(db.prepare('SELECT status FROM proposals ORDER BY id').all().map((x) => x.status), ['superseded', 'rejected']);
  assert.deepStrictEqual(db.prepare('SELECT match_key FROM unmatched_offers').all().map((x) => x.match_key), ['ean:2']);
  // vlastní horizont (nastavení retention_superseded_days) a nikdy delší než retention_days
  assert.strictEqual(retentionCleanup(db, { days: 180, supersededDays: 5, now: NOW }).proposals, 1);
  db.close();
});

test('ops-5: úklid maže po dávkách (víc než jedna dávka)', () => {
  const db = baseDb();
  const iso = NOW.toISOString();
  db.prepare("INSERT INTO audit(at, action) SELECT ?, 'x' FROM (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 25000) SELECT n FROM c)").run(daysAgo(400));
  db.prepare("INSERT INTO audit(at, action) VALUES (?, 'nový')").run(iso);
  assert.strictEqual(retentionCleanup(db, { days: 30, now: NOW }).audit, 25000);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM audit').get().c, 1);
  db.close();
});

test('ops-10: běh a zdroj s časem v budoucnosti (posun hodin) nezastaví plánované přecenění ani stahování', async () => {
  const db = baseDb();
  setSetting(db, 'schedule', { run_interval_minutes: 60 });
  db.prepare("INSERT INTO runs(started_at, finished_at, status, trigger, stats) VALUES (?, ?, 'done', 'manual', '{}')").run('2027-09-26T00:00:00.000Z', '2027-09-26T00:00:00.000Z');
  const now = new Date().toISOString();
  db.prepare("INSERT INTO sources(name, kind, url, interval_minutes, enabled, last_run_at, created_at, updated_at) VALUES ('Feed', 'offers', 'http://x/feed.xml', 60, 1, ?, ?, ?)").run('2027-09-26T00:00:00.000Z', now, now);
  const { deps, calls } = fakeDeps(db);
  const log = memoryLogger();
  const s = startScheduler({ db, log, deps, autoStart: false });
  const summary = await s.tick({ now: NOW });
  assert.strictEqual(summary.run && summary.run.reason, 'interval');
  assert.strictEqual(calls.runPricing.length, 1);
  assert.strictEqual(dueSources(db, NOW).length, 1, 'zdroj s last_run_at v budoucnosti je splatný');
  await s.stop();
  db.close();
});

test('ops-9: přecenění na hranici časového okna strategie (bez intervalu i bez importu)', async () => {
  const db = baseDb();
  const iso = NOW.toISOString();
  // okno 18–24 h (Praha); poslední běh v 8:00 Praha
  db.prepare("INSERT INTO strategies(name, priority, enabled, config, created_at, updated_at) VALUES ('Večer', 10, 1, ?, ?, ?)").run(JSON.stringify({ schedule: { hours: [18, 24] } }), iso, iso);
  db.prepare("INSERT INTO runs(started_at, finished_at, status, trigger, stats) VALUES (?, ?, 'done', 'manual', '{}')").run('2026-09-25T06:00:00.000Z', '2026-09-25T06:00:00.000Z');
  const { deps, calls } = fakeDeps(db);
  const s = startScheduler({ db, log: memoryLogger(), deps, autoStart: false });
  // 14:00 Praha – okno pořád zavřené → nic
  let sum = await s.tick({ now: NOW });
  assert.strictEqual(sum.run, null);
  // 18:05 Praha – okno se otevřelo → běh 'window'
  sum = await s.tick({ now: new Date('2026-09-25T16:05:00.000Z') });
  assert.strictEqual(sum.run && sum.run.reason, 'window');
  // 18:10 – bez změny → nic
  sum = await s.tick({ now: new Date('2026-09-25T16:10:00.000Z') });
  assert.strictEqual(sum.run, null);
  // 00:05 další den – okno se zavřelo → běh
  sum = await s.tick({ now: new Date('2026-09-25T22:05:00.000Z') });
  assert.strictEqual(sum.run && sum.run.reason, 'window');
  assert.strictEqual(calls.runPricing.length, 2);
  await s.stop();
  db.close();
});

test('ops-4: automatické odeslání předá markExported doručené ceny (delivered)', async () => {
  const db = baseDb();
  setSetting(db, 'schedule', { run_interval_minutes: 60, auto_push_after_run: true });
  setSetting(db, 'export', { webhook: { url: 'http://127.0.0.1:9/hook' } });
  const { deps, calls } = fakeDeps(db);
  const s = startScheduler({ db, log: memoryLogger(), deps, autoStart: false });
  await s.tick({ now: NOW });
  assert.strictEqual(calls.markExported.length, 1);
  const delivered = calls.markExported[0].opts.delivered;
  assert.ok(Array.isArray(delivered) && delivered[0].proposal_id === 5 && delivered[0].price === 123);
  await s.stop();
  db.close();
});
