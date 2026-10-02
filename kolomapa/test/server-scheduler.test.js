'use strict';
// Plánovač a správce běhů: nextRunAt (vč. změn času), single-flight, záznam chyb, zámek, denní běh.
// Časové zóna: Europe/Prague (kvůli testům letního/zimního času) – nastaveno před prvním použitím Date.
process.env.TZ = 'Europe/Prague';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/util/log');
const sch = require('../src/server/scheduler');

const log = createLogger({ level: 'silent' });
const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const S = { hour: 5, minute: 30 };

test('nextRunAt: dnes / zítra / přechod měsíce a roku / vypnuto', () => {
  assert.equal(sch.nextRunAt(local(2026, 10, 2, 4, 0), S).getTime(), local(2026, 10, 2, 5, 30).getTime());
  assert.equal(sch.nextRunAt(local(2026, 10, 2, 5, 30), S).getTime(), local(2026, 10, 3, 5, 30).getTime());
  assert.equal(sch.nextRunAt(local(2026, 10, 2, 5, 29), S).getTime(), local(2026, 10, 2, 5, 30).getTime());
  assert.equal(sch.nextRunAt(local(2026, 10, 2, 23, 59), S).getTime(), local(2026, 10, 3, 5, 30).getTime());
  assert.equal(sch.nextRunAt(local(2026, 10, 31, 6, 0), S).getTime(), local(2026, 11, 1, 5, 30).getTime());
  assert.equal(sch.nextRunAt(local(2026, 12, 31, 23, 0), S).getTime(), local(2027, 1, 1, 5, 30).getTime());
  assert.equal(sch.nextRunAt(local(2026, 10, 2), null), null);
  assert.equal(sch.nextRunAt(local(2026, 10, 2), { hour: 'x', minute: 0 }), null);
  assert.equal(sch.nextRunAt(local(2026, 10, 2, 0, 0), { hour: 0, minute: 0 }).getTime(), local(2026, 10, 3, 0, 0).getTime());
});

test('nextRunAt: změna času (Europe/Prague) – běh zůstává v 5:30 místního času', () => {
  // jaro 2026: 29. 3. ve 2:00 → 3:00 (den má 23 h)
  const spring = sch.nextRunAt(local(2026, 3, 28, 6, 0), S);
  assert.equal(spring.getDate(), 29);
  assert.equal(spring.getHours(), 5);
  assert.equal(spring.getMinutes(), 30);
  assert.equal(spring.getTime() - local(2026, 3, 28, 6, 0).getTime(), 22.5 * 3600 * 1000);
  // podzim 2026: 25. 10. ve 3:00 → 2:00 (den má 25 h)
  const autumn = sch.nextRunAt(local(2026, 10, 24, 6, 0), S);
  assert.equal(autumn.getDate(), 25);
  assert.equal(autumn.getHours(), 5);
  assert.equal(autumn.getTime() - local(2026, 10, 24, 6, 0).getTime(), 24.5 * 3600 * 1000);
  // neexistující čas 2:30 v den jarní změny → nejbližší platný (3:30), vždy v budoucnu
  const now = local(2026, 3, 29, 0, 30);
  const odd = sch.nextRunAt(now, { hour: 2, minute: 30 });
  assert.ok(odd > now);
  assert.equal(odd.getDate(), 29);
  assert.equal(odd.getHours(), 3);
});

test('hasGoodRunToday / lastGoodRunStart', () => {
  const db = openDb(':memory:');
  const now = local(2026, 10, 2, 12, 0);
  assert.equal(sch.hasGoodRunToday(db, now), false);
  assert.equal(sch.lastGoodRunStart(db), null);
  db.prepare("INSERT INTO runs (started_at, finished_at, status) VALUES (?, ?, 'ok')").run(local(2026, 10, 1, 5, 30).toISOString(), local(2026, 10, 1, 6, 0).toISOString());
  assert.equal(sch.hasGoodRunToday(db, now), false);
  db.prepare("INSERT INTO runs (started_at, finished_at, status) VALUES (?, ?, 'error')").run(local(2026, 10, 2, 5, 30).toISOString(), local(2026, 10, 2, 5, 31).toISOString());
  assert.equal(sch.hasGoodRunToday(db, now), false, 'chybný běh se nepočítá');
  db.prepare("INSERT INTO runs (started_at, finished_at, status) VALUES (?, ?, 'partial')").run(local(2026, 10, 2, 0, 10).toISOString(), local(2026, 10, 2, 1, 0).toISOString());
  assert.equal(sch.hasGoodRunToday(db, now), true);
  assert.equal(sch.lastGoodRunStart(db).getTime(), local(2026, 10, 2, 0, 10).getTime());
});

test('createRunner: jen jeden běh najednou, průběh, výsledek', async () => {
  const db = openDb(':memory:');
  const config = { ...loadConfig({}), dbFile: ':memory:' };
  let release;
  const gate = new Promise((r) => (release = r));
  const seen = [];
  const runner = createRunnerWith(db, config, async (o) => {
    seen.push(o.trigger);
    assert.ok(o.signal instanceof AbortSignal);
    o.onProgress('krok 1');
    o.onProgress('krok 2');
    await gate;
    return { status: 'partial', runId: 7 };
  });
  const a = runner.start('manual');
  assert.equal(a.started, true);
  const b = runner.start('schedule');
  assert.equal(b.started, false);
  assert.match(b.reason, /běží/);
  const st = runner.status();
  assert.equal(st.running, true);
  assert.equal(st.progress, 'krok 2');
  assert.deepEqual(
    st.messages.map((m) => m.msg),
    ['krok 1', 'krok 2']
  );
  assert.equal(runner.active(), true);
  release();
  const res = await a.promise;
  assert.equal(res.status, 'partial');
  assert.equal(runner.status().running, false);
  assert.equal(runner.status().lastResult.status, 'partial');
  assert.deepEqual(seen, ['manual']);
  assert.equal(runner.start('manual').started, true);
  await runner.wait();
});

test('createRunner: výjimka v běhu se zapíše jako neúspěšný běh', async () => {
  const db = openDb(':memory:');
  const config = { ...loadConfig({}), dbFile: ':memory:' };
  const runner = createRunnerWith(db, config, async () => {
    throw new Error('Cannot find module ./classify');
  });
  const r = runner.start('start');
  const res = await r.promise;
  assert.equal(res.status, 'error');
  const row = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.status, 'error');
  assert.equal(row.trigger, 'start');
  assert.match(row.error, /classify/);
  assert.ok(row.finished_at);
  assert.equal(runner.status().lastRun.status, 'error');
});

test('createRunner: abort() přeruší běh přes AbortSignal', async () => {
  const db = openDb(':memory:');
  const config = { ...loadConfig({}), dbFile: ':memory:' };
  const runner = createRunnerWith(db, config, (o) => new Promise((resolve) => o.signal.addEventListener('abort', () => resolve({ status: 'error', error: o.signal.reason.message }))));
  const r = runner.start('manual');
  runner.abort('Server se ukončuje.');
  const res = await r.promise;
  assert.equal(res.error, 'Server se ukončuje.');
});

test('runOnce: bez načitatelných zdrojů / modulů zapíše chybu (bez sítě)', async () => {
  const db = openDb(':memory:');
  const config = { ...loadConfig({}), dbFile: ':memory:', sources: [] };
  const res = await sch.runOnce({ db, config, log, trigger: 'cli', sources: [] });
  assert.equal(res.status, 'error');
  const row = db.prepare('SELECT * FROM runs').get();
  assert.equal(row.status, 'error');
  assert.equal(row.trigger, 'cli');
});

test('zámek běhu mezi procesy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolomapa-lock-'));
  const dbFile = path.join(dir, 'k.db');
  try {
    const a = sch.acquireRunLock(dbFile);
    assert.ok(!a.busy);
    const b = sch.acquireRunLock(dbFile);
    assert.ok(b.busy, 'druhý zámek musí být obsazený');
    assert.equal(b.busy.pid, process.pid);
    assert.equal(sch.lockHolder(dbFile).pid, process.pid);
    a.release();
    assert.equal(sch.lockHolder(dbFile), null);
    // zámek po spadlém procesu se převezme
    fs.writeFileSync(`${dbFile}.run-lock`, JSON.stringify({ pid: 2147483646, host: os.hostname(), startedAt: new Date().toISOString() }));
    assert.equal(sch.lockHolder(dbFile), null);
    const c = sch.acquireRunLock(dbFile);
    assert.ok(!c.busy);
    c.release();
    assert.equal(fs.existsSync(`${dbFile}.run-lock`), false);
    // živý PID, ale zámek je starší než spuštění počítače / než den (PID po restartu dostal jiný program) → mrtvý
    const lockOf = (ms) => JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date(Date.now() - ms).toISOString() });
    fs.writeFileSync(`${dbFile}.run-lock`, lockOf(os.uptime() * 1000 + 3600e3));
    assert.equal(sch.lockHolder(dbFile), null, 'zámek z doby před spuštěním počítače');
    fs.writeFileSync(`${dbFile}.run-lock`, lockOf(25 * 3600e3));
    assert.equal(sch.lockHolder(dbFile), null, 'zámek starší než den');
    fs.writeFileSync(`${dbFile}.run-lock`, lockOf(1000));
    assert.equal(sch.lockHolder(dbFile).pid, process.pid, 'čerstvý zámek živého procesu platí');
    fs.writeFileSync(`${dbFile}.run-lock`, JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: 'nesmysl' }));
    assert.equal(sch.lockHolder(dbFile), null, 'zámek bez platného času');
    fs.unlinkSync(`${dbFile}.run-lock`);
    // in-memory DB zámek nepotřebuje
    assert.ok(!sch.acquireRunLock(':memory:').busy);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startScheduler: plánovaný běh v čase, jen jednou; běh po startu jen když dnes neproběhl', async () => {
  const db = openDb(':memory:');
  let now = local(2026, 10, 2, 5, 0);
  const calls = [];
  const runner = { start: (t) => calls.push(t), isRunning: () => false, setNextScheduledAt() {} };
  const config = { schedule: S, runOnStart: true };
  const s = sch.startScheduler({ db, config, log, runner, now: () => now, tickMs: 5, initialDelayMs: 5 });
  try {
    assert.equal(s.nextRunAt().getTime(), local(2026, 10, 2, 5, 30).getTime());
    await sleep(30);
    assert.deepEqual(calls, ['start']); // dnes ještě neproběhlo
    now = local(2026, 10, 2, 5, 31);
    await sleep(40);
    assert.deepEqual(calls, ['start', 'schedule']);
    assert.equal(s.nextRunAt().getTime(), local(2026, 10, 3, 5, 30).getTime());
    await sleep(30);
    assert.equal(calls.length, 2);
  } finally {
    await s.stop();
  }

  // dnešní úspěšný běh → po startu nic; čerstvý běh (< 3 h) → plánovaný se přeskočí
  calls.length = 0;
  now = local(2026, 10, 3, 5, 0);
  db.prepare("INSERT INTO runs (started_at, finished_at, status) VALUES (?, ?, 'ok')").run(local(2026, 10, 3, 4, 0).toISOString(), local(2026, 10, 3, 4, 30).toISOString());
  const s2 = sch.startScheduler({ db, config, log, runner, now: () => now, tickMs: 5, initialDelayMs: 5 });
  try {
    await sleep(30);
    assert.deepEqual(calls, []);
    now = local(2026, 10, 3, 5, 31);
    await sleep(30);
    assert.deepEqual(calls, []);
    assert.equal(s2.nextRunAt().getTime(), local(2026, 10, 4, 5, 30).getTime());
  } finally {
    await s2.stop();
  }

  // vypnutý plánovač
  const s3 = sch.startScheduler({ db, config: { schedule: null, runOnStart: false }, log, runner, tickMs: 5 });
  assert.equal(s3.nextRunAt(), null);
  await s3.stop();
});

function createRunnerWith(db, config, runFn) {
  return sch.createRunner({ db, config, log, runFn });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
