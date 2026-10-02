'use strict';
// Spouštění denního běhu (stažení → klasifikace → poloha → nacenění).
//
//   runOnce(opts)          jeden běh pipeline (líně načte src/pipeline.js, zdroje, HTTP klienta a prohlížeč);
//                          používá ho server i tools/run.js. Chráněno zámkovým souborem vedle databáze, takže
//                          server a cron (tools/run.js) nikdy nestahují současně.
//   createRunner(opts)     „single-flight“ správce běhů pro server: nejvýš jeden běh, průběh (zprávy) pro GET /api/run,
//                          přerušení přes AbortController při ukončení serveru.
//   startScheduler(opts)   denní běh v config.schedule {hour, minute} MÍSTNÍHO času (null = vypnuto) a běh po startu
//                          (config.runOnStart), pokud dnes ještě úspěšně neproběhl.
//   nextRunAt(now, sched)  čistá funkce – čas příštího plánovaného běhu (místní čas, bezpečné přes změny času).

const fs = require('node:fs');
const os = require('node:os');
const { nowIso, parseJson } = require('../db');
const defaultLog = require('../util/log');

const MAX_MESSAGES = 40;
/** Plánovaný běh se přeskočí, pokud úspěšný běh začal před méně než MIN_GAP_MS (např. ruční „Stáhnout teď“). */
const MIN_GAP_MS = 3 * 3600 * 1000;

// ---------------------------------------------------------------------------------------------------------
// Čas

/**
 * Příští plánovaný běh: dnes v hour:minute místního času, pokud ten okamžik ještě nenastal, jinak zítra.
 * Počítá se přes místní kalendářní datum (new Date(y, m, d, h, min)), takže změna letního/zimního času
 * neposune běh o hodinu. Neexistující čas (např. 2:30 při jarní změně) JS posune na nejbližší platný.
 * @param {Date} now
 * @param {{hour: number, minute: number}|null} schedule
 * @returns {Date|null}
 */
function nextRunAt(now, schedule) {
  if (!schedule || !Number.isInteger(schedule.hour) || !Number.isInteger(schedule.minute)) return null;
  const t = now instanceof Date ? now : new Date(now);
  let d = new Date(t.getFullYear(), t.getMonth(), t.getDate(), schedule.hour, schedule.minute, 0, 0);
  if (d.getTime() <= t.getTime()) d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, schedule.hour, schedule.minute, 0, 0);
  return d;
}

/** Stejný místní kalendářní den? */
function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Začátek posledního úspěšného (ok / partial) běhu jako Date, nebo null. */
function lastGoodRunStart(db) {
  const r = db.prepare("SELECT started_at FROM runs WHERE status IN ('ok', 'partial') ORDER BY id DESC LIMIT 1").get();
  const t = r ? Date.parse(r.started_at) : NaN;
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Proběhl dnes (místní datum) úspěšný nebo částečný běh? */
function hasGoodRunToday(db, now = new Date()) {
  const rows = db.prepare("SELECT started_at FROM runs WHERE status IN ('ok', 'partial') ORDER BY id DESC LIMIT 5").all();
  return rows.some((r) => {
    const t = Date.parse(r.started_at);
    return Number.isFinite(t) && sameLocalDay(new Date(t), now);
  });
}

// ---------------------------------------------------------------------------------------------------------
// Zámek mezi procesy (server × tools/run.js nad stejnou databází)

function lockPath(dbFile) {
  return !dbFile || dbFile === ':memory:' ? null : `${dbFile}.run-lock`;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Kdo drží zámek běhu? {pid, host, startedAt} živého procesu, jinak null (zámek chybí nebo je po pádu).
 * @param {string} dbFile
 */
function lockHolder(dbFile) {
  const file = lockPath(dbFile);
  if (!file) return null;
  let info;
  try {
    info = parseJson(fs.readFileSync(file, 'utf8'), null);
  } catch {
    return null;
  }
  if (!info || typeof info !== 'object') return null;
  // Zámek z jiného počítače (sdílený disk) nejde ověřit – bereme ho vážně 12 h.
  if (info.host && info.host !== os.hostname()) return Date.now() - Date.parse(info.startedAt) < 12 * 3600 * 1000 ? info : null;
  return pidAlive(info.pid) ? info : null;
}

/**
 * Získá zámek běhu. Vrací {release()} nebo {busy: info} když běží jiný proces.
 * @param {string} dbFile
 */
function acquireRunLock(dbFile) {
  const file = lockPath(dbFile);
  if (!file) return { release() {} };
  const info = { pid: process.pid, host: os.hostname(), startedAt: nowIso() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(info), { flag: 'wx' });
      return {
        release() {
          try {
            const cur = parseJson(fs.readFileSync(file, 'utf8'), null);
            if (cur && cur.pid === process.pid) fs.unlinkSync(file);
          } catch {
            /* zámek už neexistuje */
          }
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = lockHolder(dbFile);
      if (holder) return { busy: holder };
      try {
        fs.unlinkSync(file); // zámek po spadlém procesu
      } catch {
        /* mezitím ho smazal někdo jiný */
      }
    }
  }
  return { busy: { pid: null, host: null, startedAt: null } };
}

// ---------------------------------------------------------------------------------------------------------
// Jeden běh

/** Zapíše do tabulky runs neúspěšný běh (když se pipeline vůbec nespustila). */
function recordFailedRun(db, trigger, message) {
  const at = nowIso();
  const id = Number(
    db.prepare("INSERT INTO runs (started_at, finished_at, status, trigger, stats, error) VALUES (?, ?, 'error', ?, '{}', ?)").run(at, at, trigger || 'manual', message)
      .lastInsertRowid
  );
  return { runId: id, status: 'error', stats: {}, error: message };
}

/**
 * Jeden běh pipeline. Moduly se načítají až tady (líně) – server tak nastartuje, i když scrapery / klasifikace /
 * nacenění ještě chybí; chyba se pak zapíše jako neúspěšný běh.
 * @param {{db, config, log?, signal?: AbortSignal, trigger?: string, onProgress?: Function,
 *          sources?: string[], full?: boolean, maxDetails?: number, maxPages?: number,
 *          exportAfter?: boolean}} o
 * @returns {Promise<{runId?: number, status: 'ok'|'partial'|'error'|'busy', stats?: object, error?: string|null,
 *          exported?: object}>}
 */
async function runOnce(o) {
  const { db, log = defaultLog, signal, trigger = 'manual', onProgress } = o;
  const config = { ...o.config };
  if (o.full) config.fullScanDays = 0; // vynutí celý průchod výpisů (odhalí prodané / smazané)
  if (Number.isInteger(o.maxDetails) && o.maxDetails >= 0) config.maxDetails = o.maxDetails;
  if (Number.isInteger(o.maxPages) && o.maxPages > 0) config.maxPages = o.maxPages;
  const keys = Array.isArray(o.sources) && o.sources.length ? o.sources : config.sources;

  const lock = acquireRunLock(config.dbFile);
  if (lock.busy) {
    const b = lock.busy;
    return { status: 'busy', error: `Už běží jiné stahování${b.pid ? ` (proces ${b.pid}${b.startedAt ? `, od ${b.startedAt}` : ''})` : ''}.` };
  }
  let browserMod = null;
  try {
    let runPipeline;
    let loadSources;
    let createHttp;
    try {
      ({ runPipeline } = require('../pipeline'));
      ({ loadSources } = require('../sources'));
      ({ createHttp } = require('../util/http'));
    } catch (e) {
      const msg = String(e.message).split('\n')[0]; // bez „Require stack“
      log.error('Nelze načíst moduly pro stahování', { error: msg });
      return recordFailedRun(db, trigger, `Nelze načíst moduly pro stahování: ${msg}`);
    }
    const sources = loadSources(keys, log);
    if (!sources.length) return recordFailedRun(db, trigger, `Žádný ze zdrojů (${keys.join(', ') || '–'}) nejde načíst.`);
    const http = createHttp({ delayMs: config.delayMs, userAgent: config.userAgent || undefined, log, signal });
    const getBrowser = async () => {
      if (!browserMod) {
        try {
          browserMod = require('../sources/browser');
        } catch (e) {
          throw new Error(`Prohlížeč pro Cyklobazar není k dispozici (src/sources/browser.js): ${e.message}`);
        }
      }
      if (typeof browserMod.getBrowser !== 'function') throw new Error('src/sources/browser.js neexportuje getBrowser()');
      return browserMod.getBrowser({ config, log });
    };
    const result = await runPipeline({ db, config, log, sources, signal, trigger, http, getBrowser, onProgress });
    const exportAfter = o.exportAfter ?? config.exportAfterRun;
    if (exportAfter && (result.status === 'ok' || result.status === 'partial')) {
      try {
        onProgress?.('Zapisuji statickou verzi mapy…');
        const { exportStatic } = require('../../tools/export-static');
        result.exported = await exportStatic({ db, config, log });
      } catch (e) {
        log.warn('Statický export po běhu selhal', { error: e.message });
        result.exportError = e.message;
      }
    }
    return result;
  } finally {
    if (browserMod && typeof browserMod.closeBrowser === 'function') {
      try {
        await browserMod.closeBrowser();
      } catch (e) {
        log.debug?.('Prohlížeč se nepodařilo zavřít', { error: e.message });
      }
    }
    lock.release();
  }
}

// ---------------------------------------------------------------------------------------------------------
// Správce běhů (server)

/**
 * Vytvoří správce běhů – nejvýš jeden běh najednou, průběh pro UI.
 * @param {{db, config, log?, runFn?: (o: object) => Promise<object>, now?: () => Date}} opts
 *   runFn – vlastní funkce běhu (testy); výchozí runOnce
 */
function createRunner({ db, config, log = defaultLog, runFn = runOnce, now = () => new Date() }) {
  let current = null; // {trigger, startedAt, messages, controller, promise}
  let lastResult = null;
  let nextScheduledAt = null;

  function status() {
    let lastRun = null;
    try {
      const r = db.prepare('SELECT * FROM runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get();
      if (r) lastRun = { id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, trigger: r.trigger, stats: parseJson(r.stats, {}), error: r.error || null };
    } catch {
      /* DB zavřená při ukončování */
    }
    const external = current ? null : lockHolder(config.dbFile);
    return {
      running: !!current || !!external,
      trigger: current ? current.trigger : external ? 'external' : null,
      startedAt: current ? current.startedAt : external ? external.startedAt : null,
      progress: current ? current.messages.at(-1)?.msg || 'Spouštím…' : external ? 'Stahuje jiný proces (tools/run.js)…' : null,
      messages: current ? current.messages.slice(-20) : [],
      lastRun,
      lastResult,
      nextScheduledAt: nextScheduledAt ? nextScheduledAt.toISOString() : null,
    };
  }

  /**
   * Spustí běh, pokud žádný neběží.
   * @param {string} [trigger] schedule | manual | start
   * @param {object} [extra] další volby pro runFn (sources, full …)
   * @returns {{started: boolean, reason?: string, promise?: Promise<object>}}
   */
  function start(trigger = 'manual', extra = {}) {
    if (current) return { started: false, reason: 'Stahování už běží.' };
    const external = lockHolder(config.dbFile);
    if (external) return { started: false, reason: `Stahování už běží v jiném procesu (PID ${external.pid}).` };
    const controller = new AbortController();
    const run = { trigger, startedAt: now().toISOString(), messages: [], controller, promise: null };
    const onProgress = (msg) => {
      run.messages.push({ at: now().toISOString(), msg: String(msg) });
      if (run.messages.length > MAX_MESSAGES) run.messages.splice(0, run.messages.length - MAX_MESSAGES);
    };
    current = run;
    log.info('Spouštím stahování', { trigger });
    run.promise = (async () => {
      let res;
      try {
        res = await runFn({ db, config, log, signal: controller.signal, trigger, onProgress, ...extra });
      } catch (e) {
        log.error('Běh skončil výjimkou', { error: e.message });
        try {
          res = recordFailedRun(db, trigger, e.message);
        } catch {
          res = { status: 'error', error: e.message };
        }
      }
      res = res || { status: 'error', error: 'Běh nevrátil výsledek.' };
      lastResult = { status: res.status, error: res.error || null, runId: res.runId ?? null, finishedAt: now().toISOString(), trigger };
      if (res.status === 'error' || res.status === 'busy') log.warn('Stahování neskončilo úspěšně', { status: res.status, error: res.error });
      else log.info('Stahování dokončeno', { status: res.status });
      current = null;
      return res;
    })();
    return { started: true, promise: run.promise };
  }

  return {
    start,
    status,
    isRunning: () => !!current || !!lockHolder(config.dbFile),
    /** Běží stahování v tomto procesu? */
    active: () => !!current,
    /** Přeruší běžící běh (AbortController). */
    abort(reason = 'Přerušeno') {
      if (current) current.controller.abort(new Error(reason));
    },
    /** Počká na doběhnutí aktuálního běhu (nebo max. timeoutMs). */
    async wait(timeoutMs = 0) {
      if (!current) return;
      const p = current.promise.catch(() => {});
      if (!timeoutMs) return p;
      let t;
      await Promise.race([p, new Promise((r) => (t = setTimeout(r, timeoutMs)))]);
      clearTimeout(t);
    },
    setNextScheduledAt(d) {
      nextScheduledAt = d || null;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Plánovač

/**
 * Spustí plánovač. Kontroluje hodiny každých tickMs (výchozí 30 s) – po probuzení počítače z uspání tak plánovaný
 * běh doběhne hned. Plánovaný běh se přeskočí, když už něco běží nebo úspěšný běh začal před < 3 h.
 * @param {{db, config, log?, runner, now?: () => Date, tickMs?: number, initialDelayMs?: number}} o
 * @returns {{stop: () => Promise<void>, nextRunAt: () => Date|null}}
 */
function startScheduler({ db, config, log = defaultLog, runner, now = () => new Date(), tickMs = 30000, initialDelayMs = 5000 }) {
  let stopped = false;
  let next = nextRunAt(now(), config.schedule);
  runner.setNextScheduledAt?.(next);
  if (next) log.info(`Plánovač: denní stahování v ${String(config.schedule.hour).padStart(2, '0')}:${String(config.schedule.minute).padStart(2, '0')}`, { next: next.toISOString() });
  else log.info('Plánovač je vypnutý (KOLOMAPA_SCHEDULE=off).');

  const tick = () => {
    if (stopped || !next) return;
    const t = now();
    if (t.getTime() < next.getTime()) return;
    try {
      const last = lastGoodRunStart(db);
      if (runner.isRunning()) log.info('Plánované stahování přeskočeno – už běží jiné.');
      else if (last && t.getTime() - last.getTime() < MIN_GAP_MS) log.info('Plánované stahování přeskočeno – data jsou čerstvá.', { lastRun: last.toISOString() });
      else runner.start('schedule');
    } catch (e) {
      log.error('Plánovač: chyba při spuštění běhu', { error: e.message });
    }
    next = nextRunAt(t, config.schedule);
    runner.setNextScheduledAt?.(next);
  };
  const interval = setInterval(tick, tickMs);
  interval.unref?.();

  let startTimer = null;
  if (config.runOnStart) {
    startTimer = setTimeout(() => {
      if (stopped) return;
      try {
        if (hasGoodRunToday(db, now())) log.info('Dnešní stahování už proběhlo – po startu nespouštím.');
        else runner.start('start');
      } catch (e) {
        log.error('Plánovač: chyba při spuštění běhu po startu', { error: e.message });
      }
    }, initialDelayMs);
    startTimer.unref?.();
  }

  return {
    nextRunAt: () => next,
    async stop() {
      stopped = true;
      clearInterval(interval);
      if (startTimer) clearTimeout(startTimer);
    },
  };
}

module.exports = {
  nextRunAt,
  sameLocalDay,
  hasGoodRunToday,
  lastGoodRunStart,
  acquireRunLock,
  lockHolder,
  recordFailedRun,
  runOnce,
  createRunner,
  startScheduler,
  MIN_GAP_MS,
};
