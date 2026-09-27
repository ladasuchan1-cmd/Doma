'use strict';
// Jednoduchý logger: jeden řádek na záznam, ISO čas v UTC, úroveň, zpráva a volitelná metadata jako JSON.
//   2026-09-25T20:57:00.000Z INFO  Server běží {"url":"http://localhost:8080"}
// Úroveň se nastavuje proměnnou prostředí LOG_LEVEL (debug | info | warn | error | silent), výchozí info.
// debug/info jdou na stdout, warn/error na stderr.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function normalizeLevel(level, fallback = 'info') {
  const l = String(level ?? '').trim().toLowerCase();
  if (l === 'warning') return 'warn';
  if (l === 'none' || l === 'off') return 'silent';
  return Object.hasOwn(LEVELS, l) ? l : fallback;
}

/** Převede chybu na serializovatelný objekt (zpráva + stack v jednom řádku JSONu). */
function serializeError(err) {
  const out = { message: err.message, name: err.name };
  if (err.code) out.code = err.code;
  if (err.status) out.status = err.status;
  if (err.stack) out.stack = err.stack;
  return out;
}

function safeStringify(meta) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(meta, (key, value) => {
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Error) return serializeError(value);
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[cyklus]';
        seen.add(value);
      }
      return value;
    });
  } catch (e) {
    return JSON.stringify({ log_error: `Metadata nelze serializovat: ${e.message}` });
  }
}

/**
 * Vytvoří logger.
 * @param {{level?: string, stdout?: {write: Function}, stderr?: {write: Function}, now?: () => Date}} [opts]
 */
function createLogger(opts = {}) {
  let level = normalizeLevel(opts.level ?? process.env.LOG_LEVEL);
  const out = opts.stdout || process.stdout;
  const err = opts.stderr || process.stderr;
  const now = opts.now || (() => new Date());

  function write(lvl, msg, meta) {
    if (LEVELS[lvl] < LEVELS[level]) return;
    let line = `${now().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${String(msg).replace(/\r?\n/g, ' ⏎ ')}`;
    if (meta !== undefined) {
      const m = meta instanceof Error ? serializeError(meta) : meta;
      line += ' ' + safeStringify(m);
    }
    try {
      (LEVELS[lvl] >= LEVELS.warn ? err : out).write(line + '\n');
    } catch {
      /* zápis logu nesmí nikdy shodit proces */
    }
  }

  return {
    debug: (msg, meta) => write('debug', msg, meta),
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
    setLevel(l) {
      level = normalizeLevel(l, level);
    },
    getLevel: () => level,
    isEnabled: (l) => LEVELS[normalizeLevel(l)] >= LEVELS[level],
  };
}

const defaultLogger = createLogger();

module.exports = {
  ...defaultLogger,
  createLogger,
  LEVELS,
  // setLevel/getLevel výchozího loggeru musí pracovat nad jeho stavem – rozprostření výše to zachovává (closure).
};
