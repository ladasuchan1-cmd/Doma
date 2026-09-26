'use strict';
// Spuštění importu (log v tabulce `imports`), náhled, stahování zdrojů z URL a plánování (SPEC §5 sources.js).

const { tx, nowIso, parseJson } = require('../db');
const { extractRecords } = require('./records');
const { ImportError, compileMapping, applyMapping, normalizeMappingArg } = require('./mapping');
const { importProducts } = require('./products');
const { importOffers } = require('./offers');

const MAX_ERRORS = 100;
const KEEP_ERRORS = MAX_ERRORS * 2; // z každého zdroje chyb stačí prvních N (řazení podle řádku)
const PREVIEW_ROWS = 10;
const DRY_RUN_PREVIEW = 20;
const FETCH_TIMEOUT_MS = 60 * 1000;
const FETCH_MAX_BYTES = 500 * 1024 * 1024;
const DUE_SLACK_MS = 30 * 1000; // plánovač tiká po minutě – zdroj s intervalem 60 min nemá čekat 61 min

const ROLLBACK = Symbol('dry-run-rollback');

function kindOf(kind) {
  if (kind !== 'products' && kind !== 'offers') throw new ImportError(`Druh importu musí být „offers“ nebo „products“ (zadáno „${kind}“).`);
  return kind;
}

function boolOpt(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'yes' || v === 'ano';
}

/** Zakládat neznámé produkty? Chybějící hodnota = ano; ne jen při výslovném false / 0 / „ne“. */
function createOpt(v) {
  if (v === undefined || v === null || v === '') return true;
  return !(v === false || v === 0 || ['0', 'false', 'no', 'ne', 'off'].includes(String(v).trim().toLowerCase()));
}

/** Volby importu z API / zdroje (snake_case i camelCase). */
function importOptions(kind, options = {}) {
  const o = options && typeof options === 'object' ? options : {};
  if (kind === 'products') {
    return {
      deactivateMissing: boolOpt(o.deactivateMissing ?? o.deactivate_missing),
      // vypnout i víc než polovinu katalogu najednou (jinak se deaktivace přeskočí jako podezřelá)
      forceDeactivate: boolOpt(o.forceDeactivate ?? o.force_deactivate),
      // false = „jen aktualizovat existující produkty“ (neznámé kódy se nezakládají); výchozí true
      createMissing: createOpt(o.createMissing ?? o.create_missing),
    };
  }
  const maxAge = o.maxAgeDays ?? o.max_age_days;
  return {
    replace: o.replace === undefined || o.replace === null ? false : o.replace,
    maxAgeDays: maxAge == null || maxAge === '' ? undefined : Number(maxAge),
  };
}

/**
 * Sloučí a seřadí chyby (mapování + import): nejdřív obecné zprávy (row null, např. „deaktivace přeskočena“),
 * pak podle řádku; nejvýše 100 položek, při větším počtu je poslední souhrnná „… a dalších N“.
 * @param {object[]} all zachycené chyby (každý zdroj nejvýše 2× MAX_ERRORS, v pořadí řádků)
 * @param {number} total skutečný počet chyb a varování
 */
function finalizeErrors(all, total = all.length) {
  const general = all.filter((e) => e.row == null);
  const rows = all.filter((e) => e.row != null).sort((a, b) => a.row - b.row);
  const merged = [...general, ...rows];
  if (total <= MAX_ERRORS && merged.length <= MAX_ERRORS) return merged;
  const out = merged.slice(0, MAX_ERRORS - 1);
  out.push({ row: null, message: `… a dalších ${total - out.length} chyb a varování (zobrazeno prvních ${out.length})` });
  return out;
}

/**
 * Přemapuje záznamy na kanonické. Vrací {canonical, rowNumbers, errors, compiled}.
 * Chyby nesou číslo záznamu (od 1, po rozložení vnořených nabídek).
 */
/** Kontext rozpoznaného vstupu pro compileMapping (čtení čísel podle formátu, vnořené nabídky). */
function mappingCtx(ex) {
  return { format: ex.format, delimiter: ex.delimiter, nested: !!ex.offersPath };
}

// Pole, bez kterých import nemá smysl – chybí-li jejich VÝSLOVNĚ namapovaný sloupec, import selže (data-12).
const REQUIRED_COLUMNS = { products: ['code'], offers: ['price', 'competitor'] };
const MATCH_FIELDS = ['code', 'ean', 'mpn', 'ext_id', 'name'];

/**
 * Výslovně namapované sloupce, které ve vstupu nejsou (přejmenovaný sloupec u dodavatele / v šabloně POHODY).
 * Dřív se tiše ignorovaly a pole (nákupní cena, sklad, dostupnost) zamrzla na staré hodnotě. Teď: varování u každého
 * sloupce; u povinných / párovacích polí CSV a XLSX (hlavičky jsou úplné) chyba importu.
 * @returns {object[]} obecné chyby/varování {row: null, message, warning}
 */
function missingColumnErrors(compiled, mapping, kind, ex) {
  if (!compiled.missing.length) return [];
  const explicit = mapping && mapping.fields && typeof mapping.fields === 'object' ? mapping.fields : {};
  const missing = new Set(compiled.missing);
  const fieldsMissing = [];
  for (const [canon, src] of Object.entries(explicit)) {
    const list = Array.isArray(src) ? src : [src];
    if (list.length && list.every((k) => typeof k === 'string' && missing.has(k))) fieldsMissing.push(canon);
  }
  const tabular = ex.format === 'csv' || ex.format === 'xlsx';
  const required = REQUIRED_COLUMNS[kind].filter((f) => fieldsMissing.includes(f) && !(compiled.defaults && compiled.defaults[f] !== undefined));
  const matchMapped = MATCH_FIELDS.filter((f) => compiled.fields[f] !== undefined);
  const allMatchMissing = kind === 'offers' && matchMapped.length > 0 && matchMapped.every((f) => fieldsMissing.includes(f));
  if (tabular && (required.length || allMatchMissing)) {
    throw new ImportError(
      `Ve vstupu chybí sloupce z mapování: ${compiled.missing.map((k) => `„${k}“`).join(', ')} – bez nich import nelze provést. Upravte mapování zdroje.`,
      { code: 'MAPPING_COLUMN_MISSING', details: { missing: compiled.missing } }
    );
  }
  return compiled.missing.map((key) => ({ row: null, message: `Sloupec „${key}“ z mapování ve vstupu není – pole se nemění.`, warning: true }));
}

function mapRecords(ex, mapping, kind, now) {
  const compiled = compileMapping(mapping, ex.headers, kind, mappingCtx(ex));
  const canonical = [];
  const rowNumbers = [];
  const errors = missingColumnErrors(compiled, mapping, kind, ex);
  let errorCount = errors.length;
  // konkurenti chybných řádků (nabídky) – u nich se nesmí mazat „chybějící“ nabídky (replace; data-9)
  const failedCompetitors = new Set();
  let failedUnknown = 0;
  const recs = ex.records;
  for (let i = 0; i < recs.length; i++) {
    const res = applyMapping(recs[i], mapping, kind, { compiled, now, offersPath: ex.offersPath });
    const { value, errors: errs } = res;
    for (const message of errs) {
      errorCount++;
      if (errors.length < KEEP_ERRORS) errors.push(value ? { row: i + 1, message, warning: true } : { row: i + 1, message });
    }
    if (value) {
      canonical.push(value);
      rowNumbers.push(i + 1);
    } else if (kind === 'offers') {
      if (res.competitor) failedCompetitors.add(res.competitor);
      else failedUnknown++;
    }
  }
  return { canonical, rowNumbers, errors, errorCount, compiled, failedCompetitors, failedUnknown };
}

function emptyStats(kind) {
  return kind === 'products'
    ? { received: 0, created: 0, updated: 0, unchanged: 0, deactivated: 0, superseded: 0, errors: [] }
    : { received: 0, matched: 0, unmatched: 0, ambiguous: 0, created: 0, updated: 0, unchanged: 0, stale: 0, duplicates: 0, removed: 0, competitors_created: 0, errors: [] };
}

/**
 * Spustí import: extractRecords → applyMapping → importProducts / importOffers v jedné transakci a zapíše log do `imports`
 * (`running` → `ok` / `error`). Při chybě vyhodí výjimku (ImportError = chyba vstupu, HTTP 400) s `import_id`.
 * dryRun: žádný zápis (ani do `imports`) – import se provede v transakci, která se vrátí zpět, takže statistiky
 * ukazují, co by se stalo (spárováno, nově založeno…); `preview` = prvních 20 kanonických záznamů.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{kind: 'products'|'offers', input: object|Buffer|string, mapping?: object|string, options?: object,
 *          sourceId?: number|null, origin?: string, dryRun?: boolean, now?: Date|string, createMissing?: boolean}} params
 *   options: products {deactivate_missing, force_deactivate, create_missing (výchozí true)}, offers {replace: false|'competitors'|'all', max_age_days};
 *   createMissing: false = jen aktualizovat existující produkty (totéž jako options.create_missing = false, má přednost)
 * @returns {{import_id: number|null, stats: object, preview?: object[], format: string, itemPath: string|null}}
 */
function runImport(db, params = {}) {
  const { input, options = {}, sourceId = null, origin = 'api', dryRun = false, now } = params;
  const kind = kindOf(params.kind);
  const mapping = normalizeMappingArg(params.mapping);
  const nowStr = nowIso(now);
  let importId = null;
  let format = null;
  if (!dryRun) {
    importId = Number(
      db
        .prepare("INSERT INTO imports (source_id, kind, format, origin, started_at, status, stats) VALUES (?, ?, NULL, ?, ?, 'running', '{}')")
        .run(sourceId ?? null, kind, origin ?? null, nowStr).lastInsertRowid
    );
  }
  try {
    const ex = extractRecords(input, mapping, { kind });
    format = ex.format;
    if (!ex.records.length) {
      throw new ImportError('Ve vstupu nebyly nalezeny žádné záznamy (zkontrolujte formát, oddělovač a cestu k položkám item_path).', { code: 'NO_RECORDS' });
    }
    const mapped = mapRecords(ex, mapping, kind, nowStr);
    const importErrors = [];
    let importErrorCount = 0;
    const onError = (row, message, extra) => {
      importErrorCount++;
      if (importErrors.length < KEEP_ERRORS || row == null) importErrors.push(extra ? { row, message, ...extra } : { row, message });
    };
    const allErrors = () => finalizeErrors([...mapped.errors, ...importErrors], mapped.errorCount + importErrorCount);
    const opts = { ...importOptions(kind, options), sourceId: sourceId ?? null, now: nowStr, importId, rowNumbers: mapped.rowNumbers, onError };
    // runImport({createMissing: false}) – „jen aktualizovat“ i jako přímá volba (přebije options.create_missing)
    if (kind === 'products' && params.createMissing !== undefined) opts.createMissing = createOpt(params.createMissing);
    if (kind === 'offers') {
      opts.failedCompetitors = mapped.failedCompetitors;
      opts.failedUnknown = mapped.failedUnknown;
    }
    const run = () => (kind === 'products' ? importProducts(db, mapped.canonical, opts) : importOffers(db, mapped.canonical, opts));

    let stats;
    if (dryRun) {
      try {
        tx(db, () => {
          stats = run();
          throw ROLLBACK;
        });
      } catch (e) {
        if (e !== ROLLBACK) throw e;
      }
    } else {
      stats = tx(db, () => {
        const s = run();
        s.received = ex.records.length;
        s.errors = allErrors();
        db.prepare("UPDATE imports SET status = 'ok', format = ?, finished_at = ?, stats = ? WHERE id = ?").run(format, nowIso(), JSON.stringify(s), importId);
        return s;
      });
    }
    stats.received = ex.records.length;
    stats.errors = allErrors();
    const out = { import_id: importId, stats, format, itemPath: ex.itemPath };
    if (dryRun) {
      out.preview = mapped.canonical.slice(0, DRY_RUN_PREVIEW);
      out.fields = mapped.compiled.fields;
    }
    return out;
  } catch (e) {
    if (importId != null) {
      try {
        db.prepare("UPDATE imports SET status = 'error', format = ?, finished_at = ?, error = ? WHERE id = ?").run(format, nowIso(), String(e && e.message ? e.message : e).slice(0, 2000), importId);
      } catch {
        /* log importu nesmí zakrýt původní chybu */
      }
      if (e && typeof e === 'object') e.import_id = importId;
    }
    throw e;
  }
}

/**
 * Náhled importu bez databáze: formát, hlavičky, navržené (efektivní) mapování, ukázka plochých a kanonických záznamů.
 * @param {{input: object|Buffer|string, mapping?: object|string, kind: 'products'|'offers', now?: Date|string}} params
 * @returns {{format, itemPath, offersPath, headers: string[], suggested: Object<string,string>, sample: object[], canonical: (object|null)[],
 *           errors: {row: number|null, message: string}[], truncated: boolean}}
 */
function previewImport(params = {}) {
  const kind = kindOf(params.kind);
  const mapping = normalizeMappingArg(params.mapping);
  const ex = extractRecords(params.input, mapping, { kind, limit: 1000 });
  const compiled = compileMapping(mapping, ex.headers, kind, mappingCtx(ex));
  const sample = ex.records.slice(0, PREVIEW_ROWS);
  const errors = [];
  if (ex.context && ex.context.length) {
    errors.push({ row: null, message: `Z obálky souboru se do všech záznamů dědí: ${ex.context.map((k) => `„${k}“`).join(', ')}.`, warning: true });
  }
  for (const key of compiled.missing) errors.push({ row: null, message: `Sloupec „${key}“ z mapování ve vstupu není.` });
  for (const key of compiled.unknownFields) errors.push({ row: null, message: `Neznámé kanonické pole „${key}“ v mapování (ignorováno).` });
  if (!ex.records.length) errors.push({ row: null, message: 'Ve vstupu nebyly nalezeny žádné záznamy.' });
  const canonical = sample.map((r, i) => {
    const { value, errors: errs } = applyMapping(r, mapping, kind, { compiled, now: params.now, offersPath: ex.offersPath });
    for (const message of errs) errors.push(value ? { row: i + 1, message, warning: true } : { row: i + 1, message });
    return value;
  });
  const suggested = {};
  for (const [k, v] of Object.entries(compiled.fields)) suggested[k] = Array.isArray(v) ? v[0] : v;
  return {
    format: ex.format,
    itemPath: ex.itemPath,
    offersPath: ex.offersPath,
    headers: ex.headers,
    suggested,
    sample,
    canonical,
    errors,
    truncated: ex.truncated,
    context: ex.context || [],
  };
}

// ---------------------------------------------------------------------------------------------------------
// Stahování

function parseMaybeJson(v, fallback) {
  if (v == null || v === '') return fallback;
  if (typeof v === 'string') return parseJson(v, fallback);
  return v;
}

function fetchError(message, extra = {}) {
  const e = new Error(message);
  e.name = 'FetchError';
  Object.assign(e, extra);
  return e;
}

const MAX_REDIRECTS = 5;

/**
 * Stáhne data zdroje. GET (nebo `method`), hlavičky z `headers` (JSON), přihlašovací údaje v URL → Basic auth,
 * přesměrování (nejvýše 5) se následují ručně: na JINÝ původ (host/port/schéma) se už nepošlou nastavené hlavičky
 * zdroje ani Authorization – API klíč feedu nesmí odejít na cizí server (security-4; fetch s redirect 'follow'
 * vlastní hlavičky jako X-Api-Key přeposílal). Časový limit 60 s (AbortSignal.timeout), max. 500 MB (hlídá se už
 * při čtení těla). Ne-2xx → chyba s `status`.
 * @param {{url: string, method?: string, headers?: object|string, options?: object|string}} source
 * @param {{timeoutMs?: number, maxBytes?: number, fetch?: Function}} [opts]
 * @returns {Promise<{buffer: Buffer, contentType: string|null, status: number, url: string, filename: string|null}>}
 */
async function fetchSource(source, opts = {}) {
  if (!source || !source.url) throw new ImportError('Zdroj nemá nastavenou URL.', { code: 'NO_URL' });
  const options = parseMaybeJson(source.options, {}) || {};
  const timeoutMs = Number(opts.timeoutMs ?? options.timeout_ms) > 0 ? Number(opts.timeoutMs ?? options.timeout_ms) : FETCH_TIMEOUT_MS;
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : FETCH_MAX_BYTES;
  const fetchImpl = opts.fetch || globalThis.fetch;
  let url;
  try {
    url = new URL(String(source.url).trim());
  } catch {
    throw new ImportError(`Neplatná URL zdroje „${source.url}“.`, { code: 'BAD_URL' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ImportError('URL zdroje musí začínat http:// nebo https://.', { code: 'BAD_URL' });
  const headers = {};
  const secretHeaders = new Set(); // hlavičky, které smí jen na původní server (nastavené u zdroje + Authorization)
  const h = parseMaybeJson(source.headers, {});
  if (h && typeof h === 'object' && !Array.isArray(h)) {
    for (const [k, v] of Object.entries(h)) {
      if (v != null && v !== '') {
        headers[k] = String(v);
        secretHeaders.add(k);
      }
    }
  }
  if (url.username || url.password) {
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) {
      const cred = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
      headers.Authorization = 'Basic ' + Buffer.from(cred).toString('base64');
      secretHeaders.add('Authorization');
    }
    url.username = '';
    url.password = '';
  }
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept')) headers.Accept = 'application/json, application/xml, text/xml, text/csv, */*';
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) headers['User-Agent'] = 'Cenotvorba/1.0 (repricing)';
  const method = String(source.method || 'GET').toUpperCase();
  let body;
  if (options.body != null && method !== 'GET' && method !== 'HEAD') {
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    if (typeof options.body !== 'string' && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const safeUrl = url.toString();
  const timeoutMsg = `Vypršel časový limit ${Math.round(timeoutMs / 1000)} s při stahování ${safeUrl}.`;
  let res;
  let current = url;
  let curMethod = method;
  let curBody = body;
  let curHeaders = headers;
  const origin = url.origin;
  try {
    for (let hop = 0; ; hop++) {
      res = await fetchImpl(current, { method: curMethod, headers: curHeaders, body: curBody, redirect: 'manual', signal });
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const location = res.headers.get('location');
      try {
        await res.body?.cancel();
      } catch {
        /* tělo přesměrování nás nezajímá */
      }
      if (!location) break;
      if (hop >= MAX_REDIRECTS) throw fetchError(`Zdroj ${safeUrl}: příliš mnoho přesměrování.`, { code: 'FETCH_FAILED' });
      const next = new URL(location, current);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw fetchError(`Zdroj ${safeUrl} přesměroval na nepodporovanou adresu.`, { code: 'FETCH_FAILED' });
      if (next.origin !== origin) {
        // jiný server: bez tajných hlaviček (API klíč, token, Basic auth)
        curHeaders = Object.fromEntries(Object.entries(curHeaders).filter(([k]) => !secretHeaders.has(k) && !/^(authorization|cookie|proxy-authorization)$/i.test(k)));
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && curMethod === 'POST')) {
        curMethod = 'GET';
        curBody = undefined;
      }
      current = next;
    }
  } catch (e) {
    if (e && e.name === 'FetchError') throw e;
    if (signal.aborted || (e && (e.name === 'TimeoutError' || e.name === 'AbortError'))) throw fetchError(timeoutMsg, { code: 'FETCH_TIMEOUT' });
    const cause = e && e.cause && e.cause.message ? e.cause.message : e && e.message ? e.message : String(e);
    throw fetchError(`Zdroj ${safeUrl} nelze stáhnout: ${cause}`, { code: 'FETCH_FAILED' });
  }
  if (!res.ok) {
    let snippet = '';
    try {
      snippet = (await res.text()).slice(0, 200).replace(/\s+/g, ' ').trim();
    } catch {
      /* tělo chybové odpovědi nás nezajímá */
    }
    throw fetchError(`Stažení zdroje selhalo: HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}${snippet ? ` – ${snippet}` : ''}`, {
      code: 'FETCH_HTTP_ERROR',
      status: res.status,
    });
  }
  const tooBig = `Zdroj je větší než povolený limit ${Math.round(maxBytes / 1024 / 1024)} MB.`;
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignorovat */
    }
    throw fetchError(tooBig, { code: 'FETCH_TOO_LARGE' });
  }
  const chunks = [];
  let total = 0;
  try {
    if (res.body) {
      for await (const chunk of res.body) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          try {
            await res.body.cancel();
          } catch {
            /* ignorovat */
          }
          throw fetchError(tooBig, { code: 'FETCH_TOO_LARGE' });
        }
        chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      }
    }
  } catch (e) {
    if (e && e.code === 'FETCH_TOO_LARGE') throw e;
    if (signal.aborted || (e && (e.name === 'TimeoutError' || e.name === 'AbortError'))) throw fetchError(timeoutMsg, { code: 'FETCH_TIMEOUT' });
    throw fetchError(`Chyba při čtení dat ze zdroje ${safeUrl}: ${e && e.message ? e.message : e}`, { code: 'FETCH_FAILED' });
  }
  const buffer = Buffer.concat(chunks, total);
  const finalUrl = (res.url && res.url !== '' ? res.url : null) || current.toString();
  let filename = null;
  try {
    const last = new URL(finalUrl).pathname.split('/').filter(Boolean).pop();
    filename = last ? decodeURIComponent(last) : null;
  } catch {
    filename = null;
  }
  const cd = res.headers.get('content-disposition');
  const m = cd && /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  if (m) filename = decodeURIComponent(m[1]);
  return { buffer, contentType: res.headers.get('content-type'), status: res.status, url: finalUrl, filename };
}

function summaryMessage(kind, stats) {
  const n = (v) => Number(v || 0).toLocaleString('cs-CZ');
  const errs = Array.isArray(stats.errors) ? stats.errors.filter((e) => !e.warning).length : 0;
  if (kind === 'products') {
    const unknown = stats.skipped_unknown ? `, neznámých kódů přeskočeno ${n(stats.skipped_unknown)}` : '';
    return `Přijato ${n(stats.received)}, nových ${n(stats.created)}, změněno ${n(stats.updated)}, beze změny ${n(stats.unchanged)}, deaktivováno ${n(stats.deactivated)}${unknown}, chyb ${n(errs)}`;
  }
  return `Přijato ${n(stats.received)}, spárováno ${n(stats.matched)}, nespárováno ${n(stats.unmatched + stats.ambiguous)}, nových ${n(stats.created)}, změněno ${n(stats.updated)}, zastaralých ${n(stats.stale)}, odstraněno ${n(stats.removed)}, chyb ${n(errs)}`;
}

/**
 * Stáhne zdroj a naimportuje ho; zapíše sources.last_run_at / last_status ('ok' | 'error') / last_message.
 * Chyby stažení i importu nevyhazuje – vrátí {ok: false, error} (a zaloguje je do `imports`). Neexistující zdroj → výjimka (404).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} sourceId
 * @param {{origin?: 'schedule'|'manual', now?: Date|string, fetch?: Function, timeoutMs?: number, maxBytes?: number}} [opts]
 * @returns {Promise<{ok: boolean, source_id: number, import_id: number|null, stats?: object, error?: string, duration_ms: number}>}
 */
// Právě stahované zdroje (db → Set id). Plánovač a ruční „Spustit“ (nebo dvojklik) by jinak stahovaly a držely
// v paměti tentýž velký feed dvakrát (ops-6).
const RUNNING = new WeakMap();

async function runSource(db, sourceId, opts = {}) {
  const origin = opts.origin === 'schedule' ? 'schedule' : 'url';
  const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(Number(sourceId));
  if (!src) throw new ImportError('Zdroj nebyl nalezen.', { status: 404, code: 'NOT_FOUND' });
  let running = RUNNING.get(db);
  if (!running) RUNNING.set(db, (running = new Set()));
  if (running.has(src.id)) {
    return { ok: false, source_id: src.id, import_id: null, error: 'Zdroj se právě načítá – počkejte na dokončení.', busy: true, duration_ms: 0 };
  }
  running.add(src.id);
  try {
    return await runSourceOnce(db, src, origin, opts);
  } finally {
    running.delete(src.id);
  }
}

async function runSourceOnce(db, src, origin, opts) {
  const startedAt = nowIso(opts.now);
  const t0 = Date.now();
  // Pokus se zapíše PŘED stažením: kdyby import shodil proces (nedostatek paměti…), zdroj by byl po restartu hned
  // znovu „splatný“ a server by padal dokola (ops-2). Takhle platí interval i po pádu.
  db.prepare("UPDATE sources SET last_run_at = ?, last_status = 'running' WHERE id = ?").run(startedAt, src.id);
  let result;
  try {
    if (!src.url) throw new ImportError('Zdroj nemá nastavenou URL – data lze do něj jen posílat přes API.', { code: 'NO_URL' });
    const fetched = await fetchSource(src, opts);
    const r = runImport(db, {
      kind: src.kind,
      input: { buffer: fetched.buffer, contentType: fetched.contentType, filename: fetched.filename },
      mapping: parseJson(src.mapping, {}) || {},
      options: parseJson(src.options, {}) || {},
      sourceId: src.id,
      origin,
      now: opts.now,
    });
    result = { ok: true, source_id: src.id, import_id: r.import_id, stats: r.stats, format: r.format };
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    let importId = e && e.import_id != null ? e.import_id : null;
    if (importId == null) {
      // chyba před importem (stažení) – i ta patří do logu importů
      try {
        importId = Number(
          db
            .prepare("INSERT INTO imports (source_id, kind, format, origin, started_at, finished_at, status, stats, error) VALUES (?, ?, NULL, ?, ?, ?, 'error', '{}', ?)")
            .run(src.id, src.kind === 'products' ? 'products' : 'offers', origin, startedAt, nowIso(), message.slice(0, 2000)).lastInsertRowid
        );
      } catch {
        importId = null;
      }
    }
    result = { ok: false, source_id: src.id, import_id: importId, error: message };
  }
  result.duration_ms = Date.now() - t0;
  const lastMessage = result.ok ? summaryMessage(src.kind, result.stats) : result.error;
  db.prepare('UPDATE sources SET last_run_at = ?, last_status = ?, last_message = ? WHERE id = ?').run(
    startedAt,
    result.ok ? 'ok' : 'error',
    String(lastMessage).slice(0, 2000),
    src.id
  );
  return result;
}

/**
 * Zdroje ke stažení: zapnuté, s URL, interval > 0 a poslední běh starší než interval (nikdy nespuštěné první).
 * Tolerance 30 s, aby minutový plánovač nesklouzl o celý tik.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Date|string} [now]
 * @returns {object[]} řádky tabulky sources
 */
function dueSources(db, now) {
  const nowMs = Date.parse(nowIso(now));
  const rows = db
    .prepare("SELECT * FROM sources WHERE enabled = 1 AND url IS NOT NULL AND TRIM(url) <> '' AND interval_minutes > 0 ORDER BY last_run_at IS NOT NULL, last_run_at, id")
    .all();
  const out = [];
  for (const r of rows) {
    let last = r.last_run_at ? Date.parse(r.last_run_at) : NaN;
    // poslední běh víc než hodinu v budoucnosti = hodiny serveru se posunuly zpět → jako by neběžel (ops-10)
    if (Number.isFinite(last) && last > nowMs + 3600000) last = NaN;
    if (!Number.isFinite(last) || last + r.interval_minutes * 60000 - DUE_SLACK_MS <= nowMs) out.push({ ...r });
  }
  return out;
}

module.exports = { runImport, previewImport, fetchSource, runSource, dueSources, summaryMessage };
