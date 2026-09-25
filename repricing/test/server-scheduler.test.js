'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { openDb, setSetting, getSetting } = require('../src/db');
const { startScheduler, retentionCleanup, RETENTION_KEY } = require('../src/server/scheduler');
const { memoryLogger } = require('./server-helpers');

const NOW = new Date('2026-09-25T12:00:00.000Z');
const minutesAgo = (m, from = NOW) => new Date(from.getTime() - m * 60000).toISOString();
const daysAgo = (d, from = NOW) => new Date(from.getTime() - d * 86400000).toISOString();

/** Falešné závislosti se záznamem volání. runPricing zapíše řádek do runs (jako skutečný engine). */
function fakeDeps(db, overrides = {}) {
  const calls = { dueSources: [], runSource: [], runPricing: [], exportRows: [], pushWebhook: [], markExported: [], logExport: [] };
  const deps = {
    dueSources: (d, now) => {
      calls.dueSources.push(now);
      return [];
    },
    runSource: async (d, id, opts) => {
      calls.runSource.push({ id, opts });
      return { import_id: id * 10, stats: { matched: 1 } };
    },
    runPricing: (d, opts) => {
      calls.runPricing.push(opts);
      const at = new Date(opts.now).toISOString();
      const r = db.prepare("INSERT INTO runs(started_at, finished_at, status, trigger, stats) VALUES (?, ?, 'done', ?, '{}')").run(at, at, opts.trigger);
      return { run_id: Number(r.lastInsertRowid), stats: { changes: 2, auto_approved: 1 } };
    },
    exportRows: (d, opts) => {
      calls.exportRows.push(opts);
      return [
        { proposal_id: 11, product_id: 1, code: 'A', price: 100 },
        { proposal_id: 12, product_id: 2, code: 'B', price: 200 },
        { proposal_id: 12, product_id: 2, code: 'B', price: 200 },
      ];
    },
    pushWebhook: async (rows, opts) => {
      calls.pushWebhook.push({ rows, opts });
      return { ok: true, status: 200, body: 'ok', duration_ms: 1 };
    },
    markExported: (d, ids, opts) => {
      calls.markExported.push({ ids, opts });
      return { export_id: 99, count: ids.length };
    },
    logExport: (d, entry) => {
      calls.logExport.push(entry);
    },
    ...overrides,
  };
  return { deps, calls };
}

function setup({ schedule, webhook, retention } = {}) {
  const db = openDb(':memory:');
  if (schedule) setSetting(db, 'schedule', schedule);
  if (webhook) setSetting(db, 'export', { webhook });
  if (retention !== undefined) setSetting(db, 'retention_days', retention);
  // úklid pro většinu testů „právě proběhl“, ať netestujeme dvě věci naráz
  setSetting(db, RETENTION_KEY, NOW.toISOString());
  return db;
}

function sched(db, deps, log = memoryLogger()) {
  return startScheduler({ db, config: {}, log, deps, autoStart: false });
}

// ---------------------------------------------------------------------------------------------------------

test('zdroje: splatné zdroje se načtou postupně (nikdy souběžně) s origin schedule', async () => {
  const db = setup();
  let active = 0;
  let maxActive = 0;
  const order = [];
  let dueNow = null;
  const { deps, calls } = fakeDeps(db, {
    dueSources: (d, now) => {
      dueNow = now;
      return [{ id: 1, name: 'Heureka', kind: 'offers' }, { id: 2, name: 'Katalog', kind: 'products' }, { id: 3, name: 'Zbozi', kind: 'offers' }];
    },
    runSource: async (d, id, opts) => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(id);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      assert.deepStrictEqual(opts, { origin: 'schedule' });
      if (id === 2) throw new Error('HTTP 500 ze zdroje');
      return { import_id: id };
    },
  });
  const s = sched(db, deps);
  const summary = await s.tick({ now: NOW });
  assert.deepStrictEqual(order, [1, 2, 3]);
  assert.strictEqual(maxActive, 1);
  assert.deepStrictEqual(summary.sources.map((x) => [x.id, x.ok]), [[1, true], [2, false], [3, true]]);
  assert.strictEqual(summary.sources[1].error, 'HTTP 500 ze zdroje');
  assert.strictEqual(calls.runPricing.length, 0, 'run_after_import je vypnuté');
  assert.strictEqual(dueNow.toISOString(), NOW.toISOString());
  db.close();
});

test('run_after_import: po úspěšném importu nabídek ze zdroje proběhne přecenění (trigger schedule)', async () => {
  const db = setup({ schedule: { run_after_import: true } });
  const { deps, calls } = fakeDeps(db, { dueSources: () => [{ id: 1, name: 'Heureka', kind: 'offers' }] });
  const s = sched(db, deps);
  const summary = await s.tick({ now: NOW });
  assert.strictEqual(calls.runPricing.length, 1);
  assert.strictEqual(calls.runPricing[0].trigger, 'schedule');
  assert.strictEqual(summary.run.reason, 'import');
  assert.strictEqual(summary.run.ok, true);
  assert.ok(summary.run.run_id > 0);
  db.close();
});

test('run_after_import: import ze zdroje dokončený až po začátku tiku nespustí v dalším tiku přecenění znovu (regrese)', async () => {
  // Skutečný runSource zapíše do imports finished_at = skutečný čas, tj. PO začátku tiku. Dřív dostal běh čas tiku
  // (starší než import) a příští tik přeceňoval kvůli témuž importu znovu – nadbytečný běh by označil čerstvě
  // schválené návrhy jako superseded.
  const db = setup({ schedule: { run_after_import: true } });
  let due = true;
  const { deps, calls } = fakeDeps(db, {
    dueSources: () => (due ? [{ id: 1, name: 'Heureka', kind: 'offers' }] : []),
    runSource: async () => {
      due = false;
      const fin = new Date(NOW.getTime() + 2500).toISOString();
      db.prepare("INSERT INTO imports(kind, origin, source_id, started_at, finished_at, status) VALUES ('offers', 'schedule', NULL, ?, ?, 'ok')").run(NOW.toISOString(), fin);
      return { import_id: 1, stats: { matched: 1 } };
    },
  });
  const s = sched(db, deps);
  const first = await s.tick({ now: NOW });
  assert.strictEqual(first.run.reason, 'import');
  assert.strictEqual(calls.runPricing.length, 1);
  // běh má čas nejdřív konce importu, který zpracoval
  assert.strictEqual(new Date(calls.runPricing[0].now).toISOString(), new Date(NOW.getTime() + 2500).toISOString());
  const second = await s.tick({ now: new Date(NOW.getTime() + 60000) });
  assert.strictEqual(second.run, null, 'stejný import nesmí spustit druhé přecenění');
  assert.strictEqual(calls.runPricing.length, 1);
  // ani po restartu plánovače (paměť pokusů prázdná – rozhoduje runs.started_at)
  const again = await sched(db, deps).tick({ now: new Date(NOW.getTime() + 120000) });
  assert.strictEqual(again.run, null);
  assert.strictEqual(calls.runPricing.length, 1);
  db.close();
});

test('run_after_import: import katalogu nebo neúspěšný import nabídek přecenění nespustí', async () => {
  for (const [src, res] of [
    [{ id: 1, kind: 'products' }, { import_id: 1 }],
    [{ id: 2, kind: 'offers' }, { ok: false, error: 'chyba' }],
    [{ id: 3, kind: 'offers' }, { status: 'error', error: 'x' }],
  ]) {
    const db = setup({ schedule: { run_after_import: true } });
    const { deps, calls } = fakeDeps(db, { dueSources: () => [src], runSource: async () => res });
    await sched(db, deps).tick({ now: NOW });
    assert.strictEqual(calls.runPricing.length, 0, JSON.stringify(src));
    db.close();
  }
  // vyhozená výjimka také ne
  const db = setup({ schedule: { run_after_import: true } });
  const { deps, calls } = fakeDeps(db, {
    dueSources: () => [{ id: 1, kind: 'offers' }],
    runSource: async () => {
      throw new Error('timeout');
    },
  });
  await sched(db, deps).tick({ now: NOW });
  assert.strictEqual(calls.runPricing.length, 0);
  db.close();
});

test('run_after_import: reaguje i na import nabídek přes API (tabulka imports), jen jednou', async () => {
  const db = setup({ schedule: { run_after_import: true } });
  db.prepare("INSERT INTO runs(started_at, finished_at, status, trigger) VALUES (?, ?, 'done', 'manual')").run(minutesAgo(30), minutesAgo(29));
  db.prepare("INSERT INTO imports(kind, origin, started_at, finished_at, status) VALUES ('offers', 'api', ?, ?, 'ok')").run(minutesAgo(5), minutesAgo(4));
  // neúspěšný a katalogový import se nepočítají
  db.prepare("INSERT INTO imports(kind, origin, started_at, finished_at, status) VALUES ('offers', 'api', ?, ?, 'error')").run(minutesAgo(3), minutesAgo(3));
  const { deps, calls } = fakeDeps(db);
  const s = sched(db, deps);
  let summary = await s.tick({ now: NOW });
  assert.strictEqual(calls.runPricing.length, 1);
  assert.strictEqual(summary.run.reason, 'import');
  summary = await s.tick({ now: new Date(NOW.getTime() + 60000) });
  assert.strictEqual(calls.runPricing.length, 1, 'bez nového importu se znovu nepřeceňuje');
  assert.strictEqual(summary.run, null);
  // nový import po posledním běhu → znovu
  db.prepare("INSERT INTO imports(kind, origin, started_at, finished_at, status) VALUES ('offers', 'upload', ?, ?, 'ok')").run(NOW.toISOString(), new Date(NOW.getTime() + 90000).toISOString());
  await s.tick({ now: new Date(NOW.getTime() + 120000) });
  assert.strictEqual(calls.runPricing.length, 2);
  db.close();
});

test('run_after_import: import starší než poslední přecenění nic nespustí; vypnuté nastavení také ne', async () => {
  let db = setup({ schedule: { run_after_import: true } });
  db.prepare("INSERT INTO imports(kind, origin, started_at, finished_at, status) VALUES ('offers', 'api', ?, ?, 'ok')").run(minutesAgo(50), minutesAgo(49));
  db.prepare("INSERT INTO runs(started_at, status, trigger) VALUES (?, 'done', 'manual')").run(minutesAgo(10));
  let f = fakeDeps(db);
  await sched(db, f.deps).tick({ now: NOW });
  assert.strictEqual(f.calls.runPricing.length, 0);
  db.close();

  db = setup({ schedule: { run_after_import: false } });
  db.prepare("INSERT INTO imports(kind, origin, started_at, finished_at, status) VALUES ('offers', 'api', ?, ?, 'ok')").run(minutesAgo(5), minutesAgo(4));
  f = fakeDeps(db);
  await sched(db, f.deps).tick({ now: NOW });
  assert.strictEqual(f.calls.runPricing.length, 0);
  db.close();
});

test('run_interval_minutes: přecenění, když je poslední běh starší než interval (jakýkoli trigger)', async () => {
  // žádný běh → hned
  let db = setup({ schedule: { run_interval_minutes: 60 } });
  let f = fakeDeps(db);
  let s = sched(db, f.deps);
  let summary = await s.tick({ now: NOW });
  assert.strictEqual(f.calls.runPricing.length, 1);
  assert.strictEqual(summary.run.reason, 'interval');
  // hned další tik → ne (běh právě proběhl)
  await s.tick({ now: new Date(NOW.getTime() + 60000) });
  assert.strictEqual(f.calls.runPricing.length, 1);
  // po 61 minutách → ano
  await s.tick({ now: new Date(NOW.getTime() + 61 * 60000) });
  assert.strictEqual(f.calls.runPricing.length, 2);
  db.close();

  // ruční běh před 10 min → ne; před 61 min → ano
  db = setup({ schedule: { run_interval_minutes: 60 } });
  db.prepare("INSERT INTO runs(started_at, status, trigger) VALUES (?, 'done', 'manual')").run(minutesAgo(10));
  f = fakeDeps(db);
  await sched(db, f.deps).tick({ now: NOW });
  assert.strictEqual(f.calls.runPricing.length, 0);
  db.close();

  db = setup({ schedule: { run_interval_minutes: 60 } });
  db.prepare("INSERT INTO runs(started_at, status, trigger) VALUES (?, 'done', 'manual')").run(minutesAgo(61));
  f = fakeDeps(db);
  await sched(db, f.deps).tick({ now: NOW });
  assert.strictEqual(f.calls.runPricing.length, 1);
  db.close();

  // interval 0 = vypnuto
  db = setup({ schedule: { run_interval_minutes: 0 } });
  f = fakeDeps(db);
  await sched(db, f.deps).tick({ now: NOW });
  assert.strictEqual(f.calls.runPricing.length, 0);
  db.close();
});

test('přecenění, které selže bez zápisu do runs, se neopakuje každý tik', async () => {
  const db = setup({ schedule: { run_interval_minutes: 30 } });
  const log = memoryLogger();
  let n = 0;
  const { deps } = fakeDeps(db, {
    runPricing: () => {
      n++;
      throw new Error('engine nedostupný');
    },
  });
  const s = sched(db, deps, log);
  const summary = await s.tick({ now: NOW });
  assert.strictEqual(summary.run.ok, false);
  assert.strictEqual(summary.run.error, 'engine nedostupný');
  assert.ok(log.records.some((r) => r.level === 'error' && /přecenění selhalo/.test(r.msg)));
  await s.tick({ now: new Date(NOW.getTime() + 60000) });
  assert.strictEqual(n, 1);
  await s.tick({ now: new Date(NOW.getTime() + 31 * 60000) });
  assert.strictEqual(n, 2);
  // opakovaná stejná chyba se loguje tišeji (debug)
  const errors = log.records.filter((r) => r.level === 'error' && /přecenění selhalo/.test(r.msg));
  assert.strictEqual(errors.length, 1);
  db.close();
});

test('auto push: po plánovaném přecenění odešle schválené změny a při úspěchu je označí', async () => {
  const db = setup({ schedule: { run_interval_minutes: 60, auto_push_after_run: true }, webhook: { url: 'http://127.0.0.1:9/hook', format: 'json', headers: { 'X-Key': 'a' } } });
  const { deps, calls } = fakeDeps(db);
  const summary = await sched(db, deps).tick({ now: NOW });
  assert.deepStrictEqual(calls.exportRows, [{ scope: 'approved' }]);
  assert.strictEqual(calls.pushWebhook.length, 1);
  assert.strictEqual(calls.pushWebhook[0].rows.length, 3);
  assert.strictEqual(calls.pushWebhook[0].opts.url, 'http://127.0.0.1:9/hook');
  assert.deepStrictEqual(calls.pushWebhook[0].opts.headers, { 'X-Key': 'a' });
  assert.ok(calls.pushWebhook[0].opts.template, 'šablona XML z nastavení');
  assert.strictEqual(calls.markExported.length, 1);
  assert.deepStrictEqual(calls.markExported[0].ids, [11, 12]);
  assert.strictEqual(calls.markExported[0].opts.kind, 'webhook');
  assert.strictEqual(calls.markExported[0].opts.target, 'http://127.0.0.1:9/hook');
  assert.strictEqual(calls.markExported[0].opts.actor, 'scheduler');
  assert.deepStrictEqual({ ok: summary.push.ok, count: summary.push.count, export_id: summary.push.export_id }, { ok: true, count: 3, export_id: 99 });
  db.close();
});

test('auto push: neúspěšný webhook nic neoznačí a zapíše chybu do logu exportů', async () => {
  const db = setup({ schedule: { run_interval_minutes: 60, auto_push_after_run: true }, webhook: { url: 'http://127.0.0.1:9/hook' } });
  const log = memoryLogger();
  const { deps, calls } = fakeDeps(db, { pushWebhook: async () => ({ ok: false, status: 502, body: 'Bad gateway', duration_ms: 3 }) });
  const summary = await sched(db, deps, log).tick({ now: NOW });
  assert.strictEqual(calls.markExported.length, 0);
  assert.strictEqual(summary.push.ok, false);
  assert.strictEqual(summary.push.status, 502);
  assert.strictEqual(calls.logExport.length, 1);
  assert.strictEqual(calls.logExport[0].status, 'error');
  assert.strictEqual(calls.logExport[0].kind, 'webhook');
  assert.ok(log.records.some((r) => r.level === 'warn' && /webhookem selhalo/.test(r.msg)));
  db.close();
});

test('auto push: vyhozená výjimka z pushWebhook je zachycena, nic se neoznačí', async () => {
  const db = setup({ schedule: { run_interval_minutes: 60, auto_push_after_run: true }, webhook: { url: 'http://x' } });
  const { deps, calls } = fakeDeps(db, {
    pushWebhook: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const summary = await sched(db, deps).tick({ now: NOW });
  assert.strictEqual(summary.push.ok, false);
  assert.strictEqual(calls.markExported.length, 0);
  db.close();
});

test('auto push: nic se neodesílá bez URL, bez změn, bez zapnutí, po neúspěšném běhu ani bez běhu', async () => {
  const cases = [
    { name: 'bez URL', schedule: { run_interval_minutes: 60, auto_push_after_run: true }, webhook: { url: '' } },
    { name: 'vypnuto', schedule: { run_interval_minutes: 60, auto_push_after_run: false }, webhook: { url: 'http://x' } },
    { name: 'bez běhu', schedule: { run_interval_minutes: 0, auto_push_after_run: true }, webhook: { url: 'http://x' } },
    {
      name: 'běh selhal',
      schedule: { run_interval_minutes: 60, auto_push_after_run: true },
      webhook: { url: 'http://x' },
      overrides: {
        runPricing: () => {
          throw new Error('x');
        },
      },
    },
    { name: 'bez změn', schedule: { run_interval_minutes: 60, auto_push_after_run: true }, webhook: { url: 'http://x' }, overrides: { exportRows: () => [] } },
  ];
  for (const c of cases) {
    const db = setup(c);
    const { deps, calls } = fakeDeps(db, c.overrides);
    await sched(db, deps).tick({ now: NOW });
    assert.strictEqual(calls.pushWebhook.length, 0, c.name);
    assert.strictEqual(calls.markExported.length, 0, c.name);
    db.close();
  }
  // export.webhook.auto_push (přepínač v nastavení exportu) funguje stejně jako schedule.auto_push_after_run
  const db = setup({ schedule: { run_interval_minutes: 60 }, webhook: { url: 'http://x', auto_push: true } });
  const { deps, calls } = fakeDeps(db);
  await sched(db, deps).tick({ now: NOW });
  assert.strictEqual(calls.pushWebhook.length, 1);
  db.close();
});

test('mutex: tiky se nepřekrývají', async () => {
  const db = setup();
  let release;
  const gate = new Promise((r) => (release = r));
  let dueCalls = 0;
  const { deps } = fakeDeps(db, {
    dueSources: () => {
      dueCalls++;
      return [{ id: 1, kind: 'offers' }];
    },
    runSource: async () => {
      await gate;
      return { import_id: 1 };
    },
  });
  const s = sched(db, deps);
  const p1 = s.tick({ now: NOW });
  const r2 = await s.tick({ now: NOW });
  assert.deepStrictEqual(r2, { skipped: 'running' });
  assert.strictEqual(s.status().running, true);
  release();
  const r1 = await p1;
  assert.strictEqual(r1.sources.length, 1);
  assert.strictEqual(dueCalls, 1);
  assert.strictEqual(s.status().running, false);
  const r3 = await s.tick({ now: NOW });
  assert.ok(!r3.skipped);
  db.close();
});

test('chyby kroků jsou zachyceny: dueSources vyhodí → tik pokračuje (úklid proběhne)', async () => {
  const db = setup({ retention: 30 });
  setSetting(db, RETENTION_KEY, daysAgo(2));
  const log = memoryLogger();
  const { deps } = fakeDeps(db, {
    dueSources: () => {
      throw new Error("Cannot find module '../import'");
    },
  });
  const summary = await sched(db, deps, log).tick({ now: NOW });
  assert.strictEqual(summary.errors[0].step, 'sources');
  assert.ok(summary.cleanup && !summary.cleanup.skipped);
  db.close();
});

test('výchozí závislosti: chybějící moduly import/engine/export neshodí plánovač', async () => {
  const db = setup({ schedule: { run_interval_minutes: 5 } });
  const log = memoryLogger();
  const s = startScheduler({ db, log, autoStart: false });
  const summary = await s.tick({ now: NOW });
  assert.ok(summary);
  assert.ok(Array.isArray(summary.errors));
  await s.stop();
  assert.deepStrictEqual(await s.tick(), { skipped: 'stopped' });
  db.close();
});

test('úklid: maže staré superseded/rejected návrhy, offer_history, audit a imports (reálná DB)', async () => {
  const db = setup({ retention: 30 });
  setSetting(db, RETENTION_KEY, null);
  const iso = NOW.toISOString();
  db.prepare("INSERT INTO products(id, code, code_key, created_at, updated_at) VALUES (1, 'A', 'A', ?, ?)").run(iso, iso);
  db.prepare("INSERT INTO competitors(id, name, name_key, created_at) VALUES (1, 'Shop', 'shop', ?)").run(iso);
  db.prepare("INSERT INTO runs(id, started_at, status, trigger) VALUES (1, ?, 'done', 'manual')").run(daysAgo(100));
  const addProposal = (status, created) =>
    db.prepare('INSERT INTO proposals(run_id, product_id, new_price, status, created_at) VALUES (1, 1, 100, ?, ?)').run(status, created);
  addProposal('superseded', daysAgo(40)); // smazat
  addProposal('rejected', daysAgo(31)); // smazat
  addProposal('superseded', daysAgo(10)); // nechat (mladý)
  addProposal('exported', daysAgo(90)); // nechat (exportované se nemažou)
  addProposal('pending', daysAgo(90)); // nechat
  addProposal('approved', daysAgo(90)); // nechat
  const addHist = (at) => db.prepare('INSERT INTO offer_history(product_id, competitor_id, price, observed_at) VALUES (1, 1, 100, ?)').run(at);
  addHist(daysAgo(45));
  addHist(daysAgo(5));
  db.prepare("INSERT INTO audit(at, action) VALUES (?, 'x')").run(daysAgo(60));
  db.prepare("INSERT INTO audit(at, action) VALUES (?, 'y')").run(daysAgo(1));
  db.prepare("INSERT INTO imports(kind, started_at, status) VALUES ('offers', ?, 'ok')").run(daysAgo(31));
  db.prepare("INSERT INTO imports(kind, started_at, status) VALUES ('offers', ?, 'ok')").run(daysAgo(29));

  const { deps } = fakeDeps(db);
  const s = sched(db, deps);
  const summary = await s.tick({ now: NOW });
  assert.deepStrictEqual({ ...summary.cleanup, cutoff: undefined }, { cutoff: undefined, proposals: 2, offer_history: 1, audit: 1, imports: 1 });
  assert.strictEqual(summary.cleanup.cutoff, daysAgo(30));
  assert.deepStrictEqual(
    db.prepare('SELECT status FROM proposals ORDER BY id').all().map((r) => r.status),
    ['superseded', 'exported', 'pending', 'approved']
  );
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM offer_history').get().c, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM audit').get().c, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM imports').get().c, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM runs').get().c, 1, 'běhy se nemažou (kaskáda na návrhy)');
  assert.strictEqual(getSetting(db, RETENTION_KEY, null), NOW.toISOString());

  // jednou denně: další tik za hodinu úklid nespustí, za 25 h ano
  let next = await s.tick({ now: new Date(NOW.getTime() + 3600000) });
  assert.strictEqual(next.cleanup, null);
  next = await s.tick({ now: new Date(NOW.getTime() + 25 * 3600000) });
  assert.ok(next.cleanup && !next.cleanup.skipped);
  db.close();
});

test('úklid: retention_days 0 / neplatné = nic nemazat', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO audit(at, action) VALUES (?, 'x')").run(daysAgo(5000));
  assert.deepStrictEqual(retentionCleanup(db, { days: 0, now: NOW }), { skipped: true });
  assert.deepStrictEqual(retentionCleanup(db, { days: null, now: NOW }), { skipped: true });
  assert.deepStrictEqual(retentionCleanup(db, { days: 'abc', now: NOW }), { skipped: true });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM audit').get().c, 1);
  const r = retentionCleanup(db, { days: 180, now: NOW });
  assert.strictEqual(r.audit, 1);
  db.close();
});

test('časovače: první tik po initialDelayMs, stop() počká na běžící tik', async () => {
  const db = setup();
  let ticks = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const { deps } = fakeDeps(db, {
    dueSources: async () => {
      ticks++;
      await gate;
      return [];
    },
  });
  const s = startScheduler({ db, log: memoryLogger(), deps, initialDelayMs: 5, intervalMs: 60000 });
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(ticks, 1);
  let stopped = false;
  const stopping = s.stop().then(() => (stopped = true));
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(stopped, false, 'stop čeká na dokončení tiku');
  release();
  await stopping;
  assert.strictEqual(stopped, true);
  db.close();
});

test('runPricing vrátí {error} → běh se bere jako neúspěšný, nic se neodesílá', async () => {
  const db = setup({ schedule: { run_interval_minutes: 60, auto_push_after_run: true }, webhook: { url: 'http://x' } });
  const { deps, calls } = fakeDeps(db, { runPricing: () => ({ run_id: 5, error: 'Neplatná strategie' }) });
  const summary = await sched(db, deps).tick({ now: NOW });
  assert.strictEqual(summary.run.ok, false);
  assert.strictEqual(summary.run.error, 'Neplatná strategie');
  assert.strictEqual(calls.pushWebhook.length, 0);
  db.close();
});
