'use strict';
// Plánovač (SPEC §8 server/scheduler.js). Jeden „tik“ (každých 60 s, první 5 s po startu):
//   1. zdroje s URL, jejichž interval uplynul (dueSources) → postupně runSource (origin 'schedule')
//   2. přecenění (runPricing, trigger 'schedule'), pokud
//        a) schedule.run_after_import a v tomto tiku uspěl import nabídek ze zdroje, NEBO od posledního přecenění
//           doběhl úspěšný import nabídek jinou cestou (API push / upload – tabulka imports), nebo
//        b) schedule.run_interval_minutes > 0 a poslední běh (tabulka runs, jakýkoli trigger) je starší.
//      Za jeden tik proběhne nejvýše jedno přecenění.
//   3. po úspěšném plánovaném přecenění, pokud je zapnuto automatické odeslání (schedule.auto_push_after_run
//      nebo export.webhook.auto_push) a je nastavena URL webhooku: exportRows(scope 'approved') → pushWebhook →
//      při úspěchu markExported (kind 'webhook'); při neúspěchu se nic neoznačí (a zapíše se chybový export log).
//   4. jednou denně úklid: superseded/rejected návrhy, offer_history, audit a imports starší než retention_days.
// Tiky se nikdy nepřekrývají (mutex); všechny chyby se zalogují, proces nikdy nespadne.

const { getSettings, getSetting, setSetting, tx } = require('../db');
const defaultLog = require('../util/log');

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_KEY = '_retention_last_at';

/** Výchozí závislosti – líné require, aby plánovač šel načíst i bez hotových modulů import/engine/export. */
function defaultDeps() {
  return {
    dueSources: (db, now) => require('../import').dueSources(db, now),
    runSource: (db, id, opts) => require('../import').runSource(db, id, opts),
    runPricing: (db, opts) => require('../engine/run').runPricing(db, opts),
    exportRows: (db, opts) => require('../export/rows').exportRows(db, opts),
    pushWebhook: (rows, opts) => require('../export/webhook').pushWebhook(rows, opts),
    markExported: (db, ids, opts) => require('../export/apply').markExported(db, ids, opts),
    logExport: (db, entry) => {
      const mod = require('../export/apply');
      return typeof mod.logExport === 'function' ? mod.logExport(db, entry) : null;
    },
  };
}

function toMs(v) {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Vrátí výsledek runSource jako neúspěch? (vyhození výjimky se řeší zvlášť) */
function isFailedResult(res) {
  if (!res || typeof res !== 'object') return false;
  if (res.ok === false) return true;
  if (res.status === 'error') return true;
  if (res.error && !res.stats) return true;
  return false;
}

/**
 * Smaže stará data podle retention_days. Běží v transakci.
 * @param {object} db
 * @param {{days: number, now?: Date|string}} opts
 * @returns {{skipped?: boolean, cutoff?: string, proposals?: number, offer_history?: number, audit?: number, imports?: number}}
 */
function retentionCleanup(db, { days, now } = {}) {
  const d = Number(days);
  // 0 / null / nesmysl = uchovávat navždy (nic nemazat)
  if (!Number.isFinite(d) || d <= 0) return { skipped: true };
  const nowMs = toMs(now) ?? Date.now();
  const cutoff = new Date(nowMs - d * DAY_MS).toISOString();
  const out = tx(db, () => ({
    cutoff,
    proposals: db.prepare("DELETE FROM proposals WHERE status IN ('superseded', 'rejected') AND created_at < ?").run(cutoff).changes,
    offer_history: db.prepare('DELETE FROM offer_history WHERE observed_at < ?').run(cutoff).changes,
    audit: db.prepare('DELETE FROM audit WHERE at < ?').run(cutoff).changes,
    imports: db.prepare('DELETE FROM imports WHERE started_at < ?').run(cutoff).changes,
  }));
  try {
    db.exec('PRAGMA optimize');
  } catch {
    /* nevadí */
  }
  return out;
}

/** Čas začátku posledního přecenění (ms) nebo null. */
function lastRunStartedMs(db) {
  const r = db.prepare('SELECT MAX(started_at) AS t FROM runs').get();
  return toMs(r && r.t);
}

/** Čas dokončení posledního úspěšného importu nabídek (ms) nebo null. */
function lastOfferImportMs(db) {
  const r = db.prepare("SELECT MAX(COALESCE(finished_at, started_at)) AS t FROM imports WHERE kind = 'offers' AND status = 'ok'").get();
  return toMs(r && r.t);
}

/**
 * Odešle schválené změny webhookem a při úspěchu je označí jako exportované.
 * @returns {Promise<{ok: boolean, count: number, status?: number|null, export_id?: number|null, marked?: number, skipped?: string, error?: string}>}
 */
async function autoPush({ db, deps, webhook, template, now, log = defaultLog }) {
  const rows = (await deps.exportRows(db, { scope: 'approved' })) || [];
  if (!rows.length) return { ok: true, count: 0, skipped: 'no_changes' };
  const res = await deps.pushWebhook(rows, { ...webhook, template });
  if (res && res.ok) {
    const ids = [...new Set(rows.map((r) => r.proposal_id).filter((id) => id != null))];
    const marked = ids.length ? await deps.markExported(db, ids, { kind: 'webhook', target: webhook.url, actor: 'scheduler', now }) : null;
    log.info(`Plánovač: ${rows.length} změn cen odesláno webhookem`, { status: res.status, export_id: marked ? marked.export_id : null });
    return { ok: true, count: rows.length, status: res.status ?? null, export_id: marked ? marked.export_id ?? null : null, marked: marked ? marked.count ?? ids.length : 0 };
  }
  const status = res ? res.status ?? null : null;
  const body = res ? res.body ?? res.error ?? null : null;
  log.warn('Plánovač: odeslání změn webhookem selhalo – návrhy zůstávají schválené a zkusí se znovu po dalším přecenění', { status, body: typeof body === 'string' ? body.slice(0, 300) : body });
  try {
    if (typeof deps.logExport === 'function') {
      await deps.logExport(db, { kind: 'webhook', target: webhook.url, count: rows.length, status: 'error', detail: { status, body, trigger: 'schedule' } });
    }
  } catch (e) {
    log.debug('Plánovač: chybu exportu nelze zapsat do logu exportů', { error: e.message });
  }
  return { ok: false, count: rows.length, status, error: typeof body === 'string' ? body.slice(0, 300) : 'Webhook selhal' };
}

/**
 * Spustí plánovač.
 * @param {{db: object, config?: object, log?: object, deps?: object, intervalMs?: number, initialDelayMs?: number,
 *          clock?: () => Date, autoStart?: boolean}} opts
 *   deps (vše volitelné, výchozí = líné require skutečných modulů): dueSources(db, now), runSource(db, id, {origin}),
 *   runPricing(db, {trigger, now}), exportRows(db, {scope}), pushWebhook(rows, opts), markExported(db, ids, opts),
 *   logExport(db, entry).
 *   autoStart: false → žádné časovače (jen ruční tick(), pro testy).
 * @returns {{stop: () => Promise<void>, tick: (opts?: {now?: Date|string}) => Promise<object>, status: () => object}}
 */
function startScheduler({ db, config = {}, log = defaultLog, deps, intervalMs = 60000, initialDelayMs = 5000, clock, autoStart = true } = {}) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  let busy = false;
  let current = null;
  let stopped = false;
  let lastAttemptMs = 0; // poslední pokus o plánované přecenění (i neúspěšný) – ochrana proti smyčce při chybě
  let lastSummary = null;
  let lastTickAt = null;
  const lastErrors = new Map(); // krok → poslední chybová zpráva (opakované chyby logujeme tišeji)
  const timers = [];

  function logError(step, message, err) {
    const text = err && err.message ? err.message : String(err);
    if (lastErrors.get(step) === text) log.debug(message, { error: text });
    else log.error(message, err);
    lastErrors.set(step, text);
  }
  const clearError = (step) => lastErrors.delete(step);

  async function doTick(now) {
    const nowMs = now.getTime();
    const summary = { at: now.toISOString(), sources: [], run: null, push: null, cleanup: null, errors: [] };

    let settings;
    try {
      settings = getSettings(db);
    } catch (e) {
      logError('settings', 'Plánovač: nelze načíst nastavení', e);
      summary.errors.push({ step: 'settings', error: e.message });
      return summary;
    }
    const sched = settings.schedule || {};

    // 1) zdroje dat s URL
    let offersImported = false;
    let due = [];
    try {
      due = (await d.dueSources(db, now)) || [];
      clearError('sources');
    } catch (e) {
      logError('sources', 'Plánovač: nelze zjistit zdroje ke stažení', e);
      summary.errors.push({ step: 'sources', error: e.message });
    }
    for (const src of due) {
      if (stopped) break;
      const t0 = Date.now();
      try {
        const res = await d.runSource(db, src.id, { origin: 'schedule' });
        const ok = !isFailedResult(res);
        summary.sources.push({ id: src.id, name: src.name ?? null, kind: src.kind ?? null, ok, import_id: res && res.import_id != null ? res.import_id : null });
        if (ok && src.kind === 'offers') offersImported = true;
        const meta = { id: src.id, ms: Date.now() - t0 };
        if (ok) log.info(`Plánovač: zdroj „${src.name ?? src.id}“ načten`, meta);
        else log.warn(`Plánovač: import ze zdroje „${src.name ?? src.id}“ skončil chybou`, { ...meta, error: res && (res.error || res.message) });
      } catch (e) {
        summary.sources.push({ id: src.id, name: src.name ?? null, kind: src.kind ?? null, ok: false, error: e.message });
        log.warn(`Plánovač: zdroj „${src.name ?? src.id}“ se nepodařilo načíst`, { id: src.id, error: e.message });
      }
    }

    // 2) přecenění
    let reason = null;
    try {
      const lastRun = lastRunStartedMs(db);
      const since = Math.max(lastRun ?? 0, lastAttemptMs);
      if (sched.run_after_import) {
        if (offersImported) reason = 'import';
        else {
          const lastImport = lastOfferImportMs(db);
          if (lastImport != null && lastImport > since) reason = 'import';
        }
      }
      const interval = Number(sched.run_interval_minutes) || 0;
      if (!reason && interval > 0 && (!since || nowMs - since >= interval * 60 * 1000)) reason = 'interval';
    } catch (e) {
      logError('decide', 'Plánovač: nelze zjistit stav posledního přecenění', e);
      summary.errors.push({ step: 'decide', error: e.message });
    }

    if (reason && !stopped) {
      lastAttemptMs = nowMs;
      try {
        const result = await d.runPricing(db, { trigger: 'schedule', now });
        if (result && (result.ok === false || result.error)) {
          throw new Error(typeof result.error === 'string' ? result.error : 'Přecenění skončilo chybou');
        }
        summary.run = { reason, ok: true, run_id: result && result.run_id != null ? result.run_id : null, stats: (result && result.stats) || null };
        const st = (result && result.stats) || {};
        log.info(`Plánovač: přecenění dokončeno (${reason === 'import' ? 'po importu nabídek' : 'interval'})`, {
          run_id: summary.run.run_id,
          changes: st.changes,
          auto_approved: st.auto_approved,
        });
        clearError('run');
      } catch (e) {
        summary.run = { reason, ok: false, error: e.message };
        logError('run', 'Plánovač: přecenění selhalo', e);
      }
    }

    // 3) automatické odeslání schválených změn
    if (summary.run && summary.run.ok && !stopped) {
      const webhook = (settings.export && settings.export.webhook) || {};
      const enabled = !!(sched.auto_push_after_run || webhook.auto_push);
      if (enabled && webhook.url) {
        try {
          summary.push = await autoPush({ db, deps: d, webhook, template: settings.export && settings.export.xml, now, log });
          clearError('push');
        } catch (e) {
          summary.push = { ok: false, error: e.message };
          logError('push', 'Plánovač: automatické odeslání změn selhalo', e);
        }
      } else if (enabled && !webhook.url) {
        summary.push = { ok: false, skipped: 'no_url' };
        log.debug('Plánovač: automatické odeslání je zapnuté, ale chybí URL webhooku');
      }
    }

    // 4) denní úklid
    try {
      const lastCleanup = toMs(getSetting(db, RETENTION_KEY, null));
      if (lastCleanup == null || nowMs - lastCleanup >= DAY_MS || lastCleanup > nowMs + DAY_MS) {
        summary.cleanup = retentionCleanup(db, { days: settings.retention_days, now });
        setSetting(db, RETENTION_KEY, now.toISOString());
        if (!summary.cleanup.skipped) {
          const c = summary.cleanup;
          const total = c.proposals + c.offer_history + c.audit + c.imports;
          (total ? log.info : log.debug)('Plánovač: úklid starých dat dokončen', c);
        }
      }
      clearError('cleanup');
    } catch (e) {
      logError('cleanup', 'Plánovač: úklid starých dat selhal', e);
      summary.errors.push({ step: 'cleanup', error: e.message });
    }

    return summary;
  }

  /**
   * Jeden průchod plánovače. Když už jiný běží, vrátí {skipped: 'running'} (nečeká).
   * @param {{now?: Date|string}} [opts]
   */
  async function tick(opts = {}) {
    if (stopped) return { skipped: 'stopped' };
    if (busy) return { skipped: 'running' };
    busy = true;
    const now = opts.now ? new Date(opts.now) : clock ? clock() : new Date();
    lastTickAt = now.toISOString();
    current = (async () => {
      try {
        lastSummary = await doTick(now);
        return lastSummary;
      } catch (e) {
        // doTick chyby odchytává po krocích; tohle je jen pojistka
        log.error('Plánovač: neočekávaná chyba', e);
        return { at: now.toISOString(), errors: [{ step: 'tick', error: e.message }] };
      } finally {
        busy = false;
        current = null;
      }
    })();
    return current;
  }

  function fire() {
    tick().catch((e) => log.error('Plánovač: neočekávaná chyba', e));
  }

  if (autoStart) {
    const t1 = setTimeout(fire, Math.max(0, initialDelayMs));
    const t2 = setInterval(fire, Math.max(1000, intervalMs));
    t1.unref?.();
    t2.unref?.();
    timers.push(t1, t2);
  }

  return {
    tick,
    /** Zastaví časovače a počká na dokončení běžícího tiku. */
    async stop() {
      stopped = true;
      for (const t of timers) {
        clearTimeout(t);
        clearInterval(t);
      }
      timers.length = 0;
      if (current) {
        try {
          await current;
        } catch {
          /* nic */
        }
      }
    },
    status: () => ({ running: busy, stopped, last_tick_at: lastTickAt, last: lastSummary }),
  };
}

module.exports = { startScheduler, retentionCleanup, autoPush, defaultDeps, RETENTION_KEY };
