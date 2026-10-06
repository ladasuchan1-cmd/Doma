'use strict';
// JSON logger bez osobních údajů. Jeden řádek na záznam:
//   {"t":"2026-10-06T08:00:00.000Z","level":"info","msg":"Server běží","port":8092}
// Úroveň: LOG_LEVEL (debug | info | warn | error | silent), výchozí info. debug/info → stdout, warn/error → stderr.
// Bezpečnostní síť: klíče metadat, které typicky nesou PII nebo tajemství (email, phone, password, token, cookie, …),
// se před zápisem nahradí textem „[redigováno]“. Volající přesto nikdy nemá PII do logu posílat.
// child(bindings) vrátí logger, který ke každému záznamu přidá pevná pole (např. request id).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const SENSITIVE_KEYS = new Set([
  'email', 'e_mail', 'mail', 'to', 'phone', 'tel', 'telefon', 'password', 'passwd', 'heslo', 'secret', 'token', 'cookie',
  'cookies', 'authorization', 'set-cookie', 'firstname', 'lastname', 'fullname', 'customername', 'customer_name', 'jmeno',
  'iddocnumber', 'id_doc_number', 'id_doc_number_enc', 'doc_number', 'iban', 'address', 'adresa', 'birth_date', 'birthdate',
  'csrf', '_csrf', 'x-csrf-token', 'totp', 'totp_secret', 'code', 'body',
]);

function normalizeLevel(level, fallback = 'info') {
  const l = String(level ?? '').trim().toLowerCase();
  if (l === 'warning') return 'warn';
  if (l === 'none' || l === 'off') return 'silent';
  return Object.hasOwn(LEVELS, l) ? l : fallback;
}

function serializeError(err) {
  const out = { message: err.message, name: err.name };
  if (err.code) out.code = err.code;
  if (err.status) out.status = err.status;
  if (err.stack) out.stack = err.stack;
  return out;
}

/** Rekurzivně odstraní hodnoty citlivých klíčů (do hloubky 6). */
function redact(value, depth = 0) {
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) return depth > 6 ? '[…]' : value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    if (depth > 6) return '[…]';
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.has(String(k).toLowerCase()) ? '[redigováno]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function safeStringify(obj) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(obj, (key, value) => {
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
 * @param {{level?: string, stdout?: {write: Function}, stderr?: {write: Function}, now?: () => Date, bindings?: object}} [opts]
 */
function createLogger(opts = {}) {
  let level = normalizeLevel(opts.level ?? process.env.LOG_LEVEL);
  const out = opts.stdout || process.stdout;
  const err = opts.stderr || process.stderr;
  const now = opts.now || (() => new Date());
  const bindings = opts.bindings || {};

  function write(lvl, msg, meta) {
    if (LEVELS[lvl] < LEVELS[level]) return;
    const record = { t: now().toISOString(), level: lvl, msg: String(msg), ...bindings };
    if (meta !== undefined) {
      const m = redact(meta);
      if (m && typeof m === 'object' && !Array.isArray(m)) Object.assign(record, m);
      else record.meta = m;
    }
    try {
      (LEVELS[lvl] >= LEVELS.warn ? err : out).write(safeStringify(record) + '\n');
    } catch {
      /* zápis logu nesmí nikdy shodit proces */
    }
  }

  const logger = {
    debug: (msg, meta) => write('debug', msg, meta),
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
    setLevel(l) {
      level = normalizeLevel(l, level);
    },
    getLevel: () => level,
    child(extra) {
      return createLogger({ ...opts, level, bindings: { ...bindings, ...redact(extra || {}) } });
    },
  };
  return logger;
}

const defaultLogger = createLogger();

module.exports = { ...defaultLogger, createLogger, redact, LEVELS };
