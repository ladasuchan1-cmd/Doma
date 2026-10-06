'use strict';
// Rámec pro periodické úlohy (SPEC kap. 3): jobs.register(name, everyMs, fn) a spuštění při startu.
// Konkrétní úlohy (expirace rezervací, auto-uvolnění kauce, retence, noční reset dema) dodávají feature moduly přes
// exports.jobs = [{ name, everyMs, fn }] – loader v server.js je zaregistruje. fn(deps) dostane
// { config, log, tenants, dbs, secret, fieldCrypto, now } a může být async; výjimky se zalogují, úloha běží dál.
// start() vrací Promise, která se splní po dokončení prvních běhů všech úloh (testy nečekají „na čas“); každý dokončený
// běh navíc vyvolá událost 'done' ({ name, ms, error }) na jobs.events (EventEmitter) a 'idle', když žádná úloha neběží.
// Vstup: { log }. Výstup: { register, start, stop, runNow, list, events, whenIdle, started }.

const { EventEmitter } = require('node:events');

const MIN_INTERVAL_MS = 1000;

function createJobs({ log } = {}) {
  const jobs = new Map(); // name → { name, everyMs, fn, timer, runs, lastRunAt, lastError, running }
  const events = new EventEmitter();
  let deps = null;
  let started = false;
  let runningCount = 0;

  function register(name, everyMs, fn) {
    if (!name || typeof name !== 'string') throw new Error('Job musí mít název.');
    if (!Number.isFinite(everyMs) || everyMs < MIN_INTERVAL_MS) throw new Error(`Job „${name}“: everyMs musí být ≥ ${MIN_INTERVAL_MS}.`);
    if (typeof fn !== 'function') throw new Error(`Job „${name}“: fn musí být funkce.`);
    if (jobs.has(name)) throw new Error(`Job „${name}“ je už zaregistrovaný.`);
    const job = { name, everyMs, fn, timer: null, runs: 0, lastRunAt: null, lastError: null, running: false };
    jobs.set(name, job);
    if (started) schedule(job);
    return job;
  }

  async function run(job) {
    if (job.running) return;
    job.running = true;
    runningCount++;
    const startedAt = Date.now();
    try {
      await job.fn(deps || {});
      job.lastError = null;
      if (log) log.debug('Job dokončen', { job: job.name, ms: Date.now() - startedAt });
    } catch (e) {
      job.lastError = e && e.message ? e.message : String(e);
      if (log) log.error('Job selhal', { job: job.name, error: job.lastError });
    } finally {
      job.running = false;
      job.runs++;
      job.lastRunAt = new Date().toISOString();
      runningCount--;
      events.emit('done', { name: job.name, ms: Date.now() - startedAt, error: job.lastError });
      if (runningCount === 0) events.emit('idle');
    }
  }

  /** První běh hned po startu (asynchronně, aby nezdržel listen), pak každých everyMs. Vrací Promise prvního běhu. */
  function schedule(job) {
    if (job.timer) return Promise.resolve();
    const first = new Promise((resolve) => setImmediate(() => run(job).then(resolve, resolve)));
    job.timer = setInterval(() => run(job), job.everyMs);
    if (typeof job.timer.unref === 'function') job.timer.unref();
    return first;
  }

  /** Spustí všechny úlohy; vrací Promise splněnou po dokončení jejich prvních běhů. */
  function start(dependencies) {
    deps = dependencies || {};
    started = true;
    const firsts = [...jobs.values()].map((job) => schedule(job));
    if (log && jobs.size) log.info('Jobs spuštěny', { count: jobs.size, names: [...jobs.keys()] });
    return Promise.all(firsts).then(() => undefined);
  }

  /** Promise splněná, až neběží žádná úloha (hned, pokud žádná neběží). */
  function whenIdle() {
    if (runningCount === 0) return Promise.resolve();
    return new Promise((resolve) => events.once('idle', resolve));
  }

  function stop() {
    for (const job of jobs.values()) {
      if (job.timer) clearInterval(job.timer);
      job.timer = null;
    }
    started = false;
  }

  async function runNow(name) {
    const job = jobs.get(name);
    if (!job) throw new Error(`Job „${name}“ neexistuje.`);
    await run(job);
    return job;
  }

  function list() {
    return [...jobs.values()].map((j) => ({ name: j.name, everyMs: j.everyMs, runs: j.runs, lastRunAt: j.lastRunAt, lastError: j.lastError }));
  }

  return { register, start, stop, runNow, list, whenIdle, events, get started() { return started; } };
}

module.exports = { createJobs, MIN_INTERVAL_MS };
