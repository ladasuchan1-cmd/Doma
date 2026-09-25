'use strict';
// API: import dat (katalog produktů, ceny konkurence) a historie importů (SPEC §5, §8).
//
//   POST /api/v1/import/preview   import       surové tělo + ?kind=offers|products [&source=ID] [&mapping=JSON] [&filename=]
//        → {kind, source_id, mapping, format, itemPath, offersPath, headers, suggested, sample, canonical, errors, truncated}
//   POST /api/v1/import/offers    import       surové tělo + ?source=ID, mapping=JSON, replace=competitors|all,
//                                              max_age_days=N, dry_run=1, filename=
//        → {ok, import_id, kind, dry_run, source_id, format, item_path, stats[, preview, fields]}
//   POST /api/v1/import/products  import       surové tělo + ?source=ID, mapping=JSON, deactivate_missing=1, dry_run=1, filename=
//        → totéž (stats katalogu)
//   GET  /api/v1/imports          read|import  ?kind, status, source, origin, page, limit (výchozí 100, max 500)
//        → {items: [{id, source_id, source_name, kind, format, origin, started_at, finished_at, duration_ms, status, stats, error}], total, page, limit}
//   GET  /api/v1/imports/:id      read|import  → jeden záznam (stejný tvar)
//
// Tělo požadavku: libovolný formát (JSON / XML / CSV / XLSX / ZIP s jedním datovým souborem / gzip), rozpozná se
// podle obsahu. Content-Type slouží jen jako nápověda kódování (charset). Přijímá se i multipart/form-data
// (curl -F file=@ceny.csv) – vezme se první souborová část; textová pole formuláře (mapping, replace, …) doplní
// chybějící parametry z query. JSON pole kanonických nabídek ([…] nebo {items: […]}) funguje bez mapování –
// kanonické názvy klíčů se namapují samy na sebe (suggestMapping).
//
// Chyby:
//  - chyba vstupu (formát, prázdný soubor, neplatné mapování/parametr) → 400 s českou zprávou; pokud už vznikl
//    záznam v `imports`, je jeho id v `details.import_id` (záznam má stav `error`);
//  - ostrý import, ve kterém není ani jeden platný řádek (např. chybí sloupec s cenou), → 400
//    {details: {import_id, stats, errors, headers, suggested}} a záznam importu se označí jako `error`
//    (nic se nezapsalo – zapisují se jen platné řádky). Zkušební import (dry_run) vrací v tomto případě 200 se statistikou;
//  - neočekávaná chyba → 500 s `details.import_id`.
// Po úspěšném ostrém importu se zneplatní cache přehledů (src/server/api/_views.js, pokud existuje).
// Import přes zdroj bez URL (data se do něj jen posílají) aktualizuje i sources.last_run_at / last_status / last_message;
// u zdrojů s URL se tyto sloupce nemění – řídí se jimi plánovač stahování.

const fs = require('node:fs');
const path = require('node:path');
const { parseJson, deepMerge, nowIso } = require('../../db');
const { HttpError, intParam, paging, toHttpError } = require('../http');
const { runImport, previewImport, normalizeMappingArg, canonicalKeys, summaryMessage } = require('../../import');

const KINDS = ['offers', 'products'];
const KIND_LABELS = { offers: 'ceny konkurence', products: 'katalog produktů' };
const IMPORT_STATUSES = ['running', 'ok', 'error'];
const IMPORT_ORIGINS = ['upload', 'api', 'url', 'schedule'];
const MAPPING_FORMATS = new Set(['auto', 'json', 'xml', 'csv', 'xlsx', 'tsv', 'txt', 'ndjson', 'jsonl', 'xls']);
// Import ve stavu „running“ starší než tohle je pozůstatek pádu / restartu (runImport je synchronní – v běžícím
// procesu stav „running“ nikdo jiný nevidí).
const STALE_RUNNING_MS = 6 * 60 * 60 * 1000;
const VIEWS_FILE = path.join(__dirname, '_views.js');

// ---------------------------------------------------------------------------------------------------------
// Sdílení pomocníci (používají je i sources.js a unmatched.js)

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v);
}

/**
 * Zneplatní cache přehledů (dashboard, produkty…), pokud modul _views.js existuje a exportuje funkci invalidate.
 * Chyba nikdy nepropadne volajícímu.
 * @returns {boolean} true = cache zneplatněna
 */
function invalidateViews(ctx) {
  try {
    if (!fs.existsSync(VIEWS_FILE)) return false;
    const views = require(VIEWS_FILE);
    const fn = views && ['invalidate', 'invalidateViews', 'invalidateCache'].map((k) => views[k]).find((f) => typeof f === 'function');
    if (!fn) return false;
    fn(ctx.db);
    return true;
  } catch (e) {
    try {
      ctx.log.warn('Cache přehledů se nepodařilo zneplatnit', { error: e && e.message });
    } catch {
      /* nic */
    }
    return false;
  }
}

/** Logická hodnota parametru (query / pole formuláře): 1/true/yes/ano/on (i prázdná hodnota) → true. */
function boolValue(v, def = false) {
  if (v === undefined || v === null) return def;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (s === '' || ['1', 'true', 'yes', 'ano', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'ne', 'off'].includes(s)) return false;
  return def;
}

/** Druh importu z parametru; prázdný → null, neplatný → 400. */
function parseKind(v, name = 'kind') {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const k = String(v).trim().toLowerCase();
  if (!KINDS.includes(k)) throw new HttpError(400, `Parametr „${name}“ musí být „offers“ (ceny konkurence) nebo „products“ (katalog).`, { field: name });
  return k;
}

/**
 * Problémy mapování pro daný druh importu (neznámá kanonická pole, špatné typy). Prázdné pole = v pořádku.
 * @param {object} m mapování (objekt)
 * @param {'offers'|'products'} kind
 * @returns {{field: string, message: string}[]}
 */
function mappingProblems(m, kind) {
  const errors = [];
  if (!isObj(m)) return [{ field: 'mapping', message: 'Mapování musí být JSON objekt.' }];
  const allowed = new Set(canonicalKeys(kind));
  const unknown = [];
  if (m.fields !== undefined && m.fields !== null) {
    if (!isObj(m.fields)) errors.push({ field: 'mapping.fields', message: 'mapping.fields musí být objekt {kanonické pole: sloupec}.' });
    else {
      for (const [k, v] of Object.entries(m.fields)) {
        if (!allowed.has(k)) unknown.push(k);
        const okValue = v === null || v === false || typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
        if (!okValue) errors.push({ field: `mapping.fields.${k}`, message: `Zdroj pole „${k}“ musí být název sloupce (text), pole názvů nebo null.` });
      }
    }
  }
  if (m.defaults !== undefined && m.defaults !== null) {
    if (!isObj(m.defaults)) errors.push({ field: 'mapping.defaults', message: 'mapping.defaults musí být objekt {kanonické pole: hodnota}.' });
    else {
      for (const [k, v] of Object.entries(m.defaults)) {
        if (!allowed.has(k)) unknown.push(k);
        if (v !== null && typeof v === 'object') errors.push({ field: `mapping.defaults.${k}`, message: `Výchozí hodnota pole „${k}“ musí být text, číslo nebo logická hodnota.` });
      }
    }
  }
  if (unknown.length) {
    const list = [...new Set(unknown)];
    errors.push({
      field: 'mapping.fields',
      message: `Neznámá pole v mapování pro ${KIND_LABELS[kind]}: ${list.join(', ')}. Povolená pole: ${[...allowed].join(', ')}.`,
    });
  }
  if (m.format !== undefined && m.format !== null && m.format !== '' && !MAPPING_FORMATS.has(String(m.format).toLowerCase())) {
    errors.push({ field: 'mapping.format', message: `Neznámý formát „${m.format}“ (povoleno: auto, json, xml, csv, xlsx).` });
  }
  for (const key of ['csv', 'xlsx']) {
    if (m[key] !== undefined && m[key] !== null && !isObj(m[key])) errors.push({ field: `mapping.${key}`, message: `mapping.${key} musí být objekt.` });
  }
  for (const key of ['item_path', 'offers_path']) {
    const v = m[key];
    if (v !== undefined && v !== null && v !== false && typeof v !== 'string') errors.push({ field: `mapping.${key}`, message: `mapping.${key} musí být text (cesta, např. SHOP.SHOPITEM).` });
  }
  return errors;
}

/** Ověří mapování, jinak HttpError 400 s {errors}. */
function assertMapping(m, kind) {
  const errors = mappingProblems(m, kind);
  if (errors.length) throw new HttpError(400, `Neplatné mapování: ${errors.map((e) => e.message).join(' ')}`, { errors });
}

/** Mapování z parametru (JSON text / objekt); neplatný JSON → 400. */
function mappingArg(v) {
  try {
    return normalizeMappingArg(v);
  } catch (e) {
    throw new HttpError(400, e && e.message ? e.message : 'Mapování není platný JSON objekt.', { field: 'mapping' });
  }
}

/** Načte zdroj podle ID z parametru (surový řádek + rozparsované mapping/options). Prázdné → null. */
function loadSourceParam(db, raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s) || Number(s) <= 0 || !Number.isSafeInteger(Number(s))) {
    throw new HttpError(400, 'Parametr „source“ musí být ID zdroje (kladné celé číslo).', { field: 'source' });
  }
  const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(Number(s));
  if (!row) throw new HttpError(404, `Zdroj #${s} nebyl nalezen.`);
  return { ...row, mapping: parseJson(row.mapping, {}) || {}, options: parseJson(row.options, {}) || {} };
}

// ---------------------------------------------------------------------------------------------------------
// Vstup požadavku

/** Název souboru z hlavičky X-Filename nebo Content-Disposition (nápověda formátu, např. pro ZIP). */
function headerFilename(req) {
  const x = req.headers['x-filename'];
  if (x) {
    try {
      return decodeURIComponent(String(x));
    } catch {
      return String(x);
    }
  }
  const cd = req.headers['content-disposition'];
  const m = cd && /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(String(cd));
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  return null;
}

/**
 * Minimální parser multipart/form-data (jen pro nahrání souboru přes curl -F / HTML formulář).
 * @returns {{name: string|null, filename: string|null, contentType: string|null, data: Buffer}[]}
 */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!m) throw new HttpError(400, 'V hlavičce multipart/form-data chybí boundary.');
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const delimiter = Buffer.concat([Buffer.from('\r\n'), boundary]);
  const parts = [];
  let pos = buf.indexOf(boundary);
  if (pos === -1) throw new HttpError(400, 'Tělo multipart/form-data neodpovídá deklarované hranici (boundary).');
  while (pos !== -1) {
    let start = pos + boundary.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; // závěrečné „--boundary--“
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    const next = buf.indexOf(delimiter, start);
    if (next === -1) break;
    const part = buf.subarray(start, next);
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd !== -1) {
      const headers = {};
      for (const line of part.subarray(0, headEnd).toString('utf8').split('\r\n')) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const cd = headers['content-disposition'] || '';
      const name = /\bname="([^"]*)"/i.exec(cd);
      const fnStar = /\bfilename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
      const fn = /\bfilename="([^"]*)"/i.exec(cd);
      let filename = null;
      if (fnStar) {
        try {
          filename = decodeURIComponent(fnStar[1].trim().replace(/^"|"$/g, ''));
        } catch {
          filename = fnStar[1];
        }
      } else if (fn) filename = fn[1];
      parts.push({ name: name ? name[1] : null, filename, contentType: headers['content-type'] || null, data: part.subarray(headEnd + 4) });
    }
    pos = next + 2;
  }
  return parts;
}

/**
 * Data importu z požadavku: surové tělo (ctx.rawBody), nebo soubor z multipart/form-data.
 * @returns {{input: {buffer: Buffer, contentType: string|null, filename: string|null}, fields: Object<string, string>}}
 */
function requestInput(ctx) {
  const ctHeader = String(ctx.req.headers['content-type'] || '');
  let buffer = ctx.rawBody;
  let contentType = ctHeader || null;
  let filename = (ctx.query.filename && String(ctx.query.filename).trim()) || headerFilename(ctx.req) || null;
  const fields = {};
  if (/^multipart\/form-data/i.test(ctHeader) && buffer && buffer.length) {
    const parts = parseMultipart(buffer, ctHeader);
    const file = parts.find((p) => p.filename != null) || parts.find((p) => ['file', 'data', 'soubor'].includes(String(p.name).toLowerCase()));
    for (const p of parts) if (p !== file && p.name && p.filename == null && p.name !== '__proto__') fields[p.name] = p.data.toString('utf8');
    if (!file) throw new HttpError(400, 'V multipart/form-data chybí soubor (pole „file“).');
    buffer = file.data;
    contentType = file.contentType;
    filename = filename || file.filename || null;
  }
  if (!buffer || !buffer.length) {
    throw new HttpError(400, 'Tělo požadavku je prázdné – pošlete data (JSON, XML, CSV nebo XLSX) přímo v těle požadavku.');
  }
  return { input: { buffer, contentType, filename }, fields };
}

// ---------------------------------------------------------------------------------------------------------
// Volby importu

function parseReplace(v) {
  if (v === undefined || v === null || v === false) return false;
  const s = String(v).trim().toLowerCase();
  if (['', '0', 'false', 'no', 'ne', 'none', 'off'].includes(s)) return false;
  if (s === 'competitors' || s === 'all') return s;
  throw new HttpError(400, 'Parametr „replace“ musí být „competitors“ (nahradit nabídky konkurentů z dávky) nebo „all“ (nahradit všechny nabídky).', { field: 'replace' });
}

function parseMaxAge(v) {
  const s = String(v).trim();
  const n = Number(s.replace(',', '.'));
  if (s === '' || !Number.isFinite(n) || n < 0) throw new HttpError(400, 'Parametr „max_age_days“ musí být nezáporné číslo (počet dní).', { field: 'max_age_days' });
  return n;
}

/** Volby importu: volby zdroje, přepsané parametry požadavku. */
function importOptions(kind, source, q) {
  const o = source && isObj(source.options) ? { ...source.options } : {};
  if (kind === 'offers') {
    if (q.replace !== undefined) o.replace = parseReplace(q.replace);
    else if (o.replace !== undefined) o.replace = parseReplace(o.replace);
    if (q.max_age_days !== undefined && String(q.max_age_days).trim() !== '') {
      delete o.maxAgeDays;
      o.max_age_days = parseMaxAge(q.max_age_days);
    }
  } else if (q.deactivate_missing !== undefined) {
    delete o.deactivateMissing;
    o.deactivate_missing = boolValue(q.deactivate_missing);
  }
  return o;
}

/** Počet platných (zpracovaných) řádků ze statistik importu. */
function validRows(kind, st) {
  const n = (k) => Number(st && st[k]) || 0;
  return kind === 'offers' ? n('matched') + n('unmatched') + n('ambiguous') : n('created') + n('updated') + n('unchanged');
}

/** Zapíše výsledek importu ke zdroji bez URL (zdroj „jen pro příjem dat“). */
function recordPushSource(db, source, kind, ok, statsOrMessage, now) {
  if (!source || (source.url && String(source.url).trim())) return;
  try {
    const msg = ok ? summaryMessage(kind, statsOrMessage) : String(statsOrMessage || 'Import selhal');
    db.prepare('UPDATE sources SET last_run_at = ?, last_status = ?, last_message = ? WHERE id = ?').run(nowIso(now), ok ? 'ok' : 'error', msg.slice(0, 2000), source.id);
  } catch {
    /* stav zdroje je jen informativní */
  }
}

/** Převede chybu importu na HttpError; zachová import_id a kód chyby v details. */
function importFailure(ctx, e) {
  const importId = e && e.import_id != null ? e.import_id : null;
  const h = toHttpError(e, { exposeInternal: true });
  if (h.status >= 500) ctx.log.error(`Import selhal${importId != null ? ` (import #${importId})` : ''}`, e instanceof Error ? e : { error: String(e) });
  let details = {};
  if (isObj(h.details)) details = { ...h.details };
  else if (h.details != null) details.info = h.details;
  if (e && typeof e.code === 'string' && !details.code && h.status < 500) details.code = e.code;
  if (importId != null) details.import_id = importId;
  const message = h.status === 500 ? `Import se nezdařil kvůli interní chybě${importId != null ? ` (import #${importId})` : ''}.` : h.message;
  return new HttpError(h.status, message, Object.keys(details).length ? details : null, { headers: h.headers || undefined });
}

// ---------------------------------------------------------------------------------------------------------
// Handlery

async function previewHandler(ctx) {
  const { input, fields } = requestInput(ctx);
  const q = { ...fields, ...ctx.query };
  const source = loadSourceParam(ctx.db, q.source);
  let kind = parseKind(q.kind);
  if (source && kind && kind !== source.kind) {
    throw new HttpError(400, `Zdroj #${source.id} „${source.name}“ je určen pro ${KIND_LABELS[source.kind] || source.kind}, ne pro ${KIND_LABELS[kind]}.`, { source_kind: source.kind });
  }
  kind = kind || (source && KINDS.includes(source.kind) ? source.kind : null);
  if (!kind) throw new HttpError(400, 'Zadejte druh importu: ?kind=offers (ceny konkurence) nebo ?kind=products (katalog produktů).', { field: 'kind' });
  let mapping = source && isObj(source.mapping) ? source.mapping : {};
  if (q.mapping !== undefined && q.mapping !== '') mapping = deepMerge(mapping, mappingArg(q.mapping));
  let p;
  try {
    p = previewImport({ input, mapping, kind, now: ctx.now });
  } catch (e) {
    throw importFailure(ctx, e);
  }
  return { kind, source_id: source ? source.id : null, mapping, ...p };
}

async function importHandler(ctx, kind) {
  const { input, fields } = requestInput(ctx);
  const q = { ...fields, ...ctx.query };
  const source = loadSourceParam(ctx.db, q.source);
  if (source && source.kind !== kind) {
    throw new HttpError(400, `Zdroj #${source.id} „${source.name}“ je určen pro ${KIND_LABELS[source.kind] || source.kind}, ne pro ${KIND_LABELS[kind]}.`, { source_kind: source.kind });
  }
  let mapping = source && isObj(source.mapping) ? source.mapping : {};
  if (q.mapping !== undefined && q.mapping !== '') mapping = deepMerge(mapping, mappingArg(q.mapping));
  assertMapping(mapping, kind);
  const options = importOptions(kind, source, q);
  const dryRun = boolValue(q.dry_run);
  const origin = ctx.via === 'session' ? 'upload' : 'api';

  let res;
  try {
    res = runImport(ctx.db, { kind, input, mapping, options, sourceId: source ? source.id : null, origin, dryRun, now: ctx.now });
  } catch (e) {
    if (!dryRun) recordPushSource(ctx.db, source, kind, false, e && e.message, ctx.now);
    throw importFailure(ctx, e);
  }
  const stats = res.stats;

  if (!dryRun && Number(stats.received) > 0 && validRows(kind, stats) === 0) {
    // Nic se nezapsalo (neplatné řádky se přeskakují) – import označíme jako chybný a vrátíme 400 s nápovědou.
    const hard = (Array.isArray(stats.errors) ? stats.errors : []).filter((e) => !e.warning);
    const first = hard.find((e) => e.row != null) || hard[0];
    const example = first ? ` (např. ${first.row != null ? `řádek ${first.row}: ` : ''}${first.message})` : '';
    const n = Number(stats.received);
    const all = n === 1 ? 'jediný záznam obsahuje' : n >= 2 && n <= 4 ? `všechny ${n} záznamy obsahují` : `všech ${n.toLocaleString('cs-CZ')} záznamů obsahuje`;
    const message = `Žádný záznam nebyl naimportován – ${all} chybu${example}. Zkontrolujte mapování polí.`;
    if (res.import_id != null) {
      try {
        ctx.db.prepare("UPDATE imports SET status = 'error', error = ? WHERE id = ?").run(message.slice(0, 2000), res.import_id);
      } catch {
        /* log importu je informativní */
      }
    }
    recordPushSource(ctx.db, source, kind, false, message, ctx.now);
    const { errors: rowErrors, ...counts } = stats;
    const details = { import_id: res.import_id, kind, format: res.format, stats: counts, errors: rowErrors };
    try {
      const p = previewImport({ input, mapping, kind, now: ctx.now });
      details.headers = p.headers.slice(0, 200);
      details.suggested = p.suggested;
    } catch {
      /* nápověda je nepovinná */
    }
    throw new HttpError(400, message, details);
  }

  if (!dryRun) {
    recordPushSource(ctx.db, source, kind, true, stats, ctx.now);
    invalidateViews(ctx);
  }
  const out = {
    ok: true,
    import_id: res.import_id,
    kind,
    dry_run: dryRun,
    source_id: source ? source.id : null,
    format: res.format,
    item_path: res.itemPath ?? null,
    stats,
  };
  if (dryRun) {
    out.preview = res.preview;
    out.fields = res.fields;
  }
  return out;
}

function presentImport(row, nowMs) {
  const stats = parseJson(row.stats, {}) || {};
  let status = row.status;
  let error = row.error ?? null;
  const started = Date.parse(row.started_at);
  const finished = row.finished_at ? Date.parse(row.finished_at) : NaN;
  const out = {
    id: row.id,
    source_id: row.source_id ?? null,
    source_name: row.source_name ?? null,
    kind: row.kind,
    format: row.format ?? null,
    origin: row.origin ?? null,
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    duration_ms: Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : null,
    status,
    stats: isObj(stats) ? stats : {},
    error,
  };
  if (status === 'running' && Number.isFinite(started) && nowMs - started > STALE_RUNNING_MS) {
    status = 'error';
    error = error || 'Import nebyl dokončen (byl přerušen – např. restartem serveru).';
    out.status = status;
    out.error = error;
    out.interrupted = true;
  }
  return out;
}

async function listImports(ctx) {
  const { page, limit, offset } = paging(ctx, { defaultLimit: 100, maxLimit: 500 });
  const where = [];
  const args = [];
  const kind = parseKind(ctx.query.kind);
  if (kind) {
    where.push('i.kind = ?');
    args.push(kind);
  }
  const status = ctx.query.status != null ? String(ctx.query.status).trim().toLowerCase() : '';
  if (status && status !== 'all') {
    if (!IMPORT_STATUSES.includes(status)) throw new HttpError(400, 'Parametr „status“ musí být running, ok nebo error.', { field: 'status' });
    where.push('i.status = ?');
    args.push(status);
  }
  const origin = ctx.query.origin != null ? String(ctx.query.origin).trim().toLowerCase() : '';
  if (origin) {
    if (!IMPORT_ORIGINS.includes(origin)) throw new HttpError(400, `Parametr „origin“ musí být jedno z: ${IMPORT_ORIGINS.join(', ')}.`, { field: 'origin' });
    where.push('i.origin = ?');
    args.push(origin);
  }
  const src = ctx.query.source != null ? String(ctx.query.source).trim() : '';
  if (src) {
    if (!/^\d+$/.test(src)) throw new HttpError(400, 'Parametr „source“ musí být ID zdroje.', { field: 'source' });
    where.push('i.source_id = ?');
    args.push(Number(src));
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(ctx.db.prepare(`SELECT COUNT(*) AS n FROM imports i ${w}`).get(...args).n);
  const rows = ctx.db
    .prepare(`SELECT i.*, s.name AS source_name FROM imports i LEFT JOIN sources s ON s.id = i.source_id ${w} ORDER BY i.id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset);
  const nowMs = ctx.now instanceof Date ? ctx.now.getTime() : Date.now();
  return { items: rows.map((r) => presentImport(r, nowMs)), total, page, limit };
}

async function getImport(ctx) {
  const id = intParam(ctx, 'id');
  const row = ctx.db.prepare('SELECT i.*, s.name AS source_name FROM imports i LEFT JOIN sources s ON s.id = i.source_id WHERE i.id = ?').get(id);
  if (!row) throw new HttpError(404, `Import #${id} nebyl nalezen.`);
  return presentImport(row, ctx.now instanceof Date ? ctx.now.getTime() : Date.now());
}

/**
 * @param {object} router
 * @param {{config?: {maxBodyMb?: number}}} [deps]
 */
function register(router, deps = {}) {
  // Importy smí mít velké tělo (výchozí limit konfigurace je 300 MB) – nastaveno výslovně, aby případné snížení
  // výchozího limitu pro ostatní routy importy neomezilo.
  const maxBodyMb = Number(deps.config && deps.config.maxBodyMb) > 0 ? Number(deps.config.maxBodyMb) : 300;
  router.post('/api/v1/import/preview', previewHandler, { auth: 'import', maxBodyMb });
  router.post('/api/v1/import/offers', (ctx) => importHandler(ctx, 'offers'), { auth: 'import', maxBodyMb });
  router.post('/api/v1/import/products', (ctx) => importHandler(ctx, 'products'), { auth: 'import', maxBodyMb });
  router.get('/api/v1/imports', listImports, { auth: ['read', 'import'] });
  router.get('/api/v1/imports/:id', getImport, { auth: ['read', 'import'] });
}

module.exports = {
  register,
  // pomocníci pro sources.js / unmatched.js a testy
  invalidateViews,
  mappingProblems,
  assertMapping,
  parseReplace,
  parseKind,
  boolValue,
  parseMultipart,
  presentImport,
  isObj,
  KINDS,
  KIND_LABELS,
};
