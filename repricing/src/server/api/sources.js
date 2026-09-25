'use strict';
// API: zdroje dat = uložené mapování + volitelně URL a interval stahování (SPEC §5 sources.js, §8).
//
//   GET    /api/v1/sources           read    → {items: [source], total, page: 1, limit}
//   POST   /api/v1/sources           admin   {name, kind, url?, method?, headers?, mapping?, options?, interval_minutes?, enabled?}
//                                            → 201 source
//   GET    /api/v1/sources/:id       read    → source
//   PUT    /api/v1/sources/:id       admin   stejné tělo; chybějící pole zůstávají beze změny (UI posílá celý objekt
//                                            z GET – neznámá pole jako id, last_run_at se ignorují) → source
//   DELETE /api/v1/sources/:id       admin   → {ok: true} (historie importů zůstane, imports.source_id = NULL)
//   POST   /api/v1/sources/:id/run   import  (admin zahrnuje vše) – stáhne URL a naimportuje (runSource, origin 'url')
//                                            → {ok: true, source_id, import_id, stats, format, duration_ms, source}
//                                            selhání stažení / importu → 502 {error: {message, details: {ok: false,
//                                            source_id, import_id, error, duration_ms}}} – chyba je už zapsaná
//                                            v imports (status error) i v sources.last_status/last_message.
//                                            Zdroj bez URL → 400 (nic se nezapisuje). Vypnutý zdroj lze spustit ručně.
//
// source = {id, name, kind, url, method, headers, mapping, options, interval_minutes, enabled (bool), last_run_at,
//           last_status, last_message, created_at, updated_at, next_run_at}
//
// Tajné údaje: hodnoty hlaviček jako Authorization / X-Api-Key / Cookie / *token* / *secret* …, heslo v URL
// (https://user:heslo@…), parametry URL jako ?key= / ?token= a klíče voleb jako password / token se ve výstupu maskují
// („Basic ••••“, „••••“). Při PUT se maskovaná hodnota, která se shoduje s maskou uložené hodnoty, nahradí původní
// uloženou hodnotou (UI posílá zpět, co dostalo). Maskovaná hodnota bez uloženého protějšku → 400.

const { nowIso, parseJson, audit } = require('../../db');
const { HttpError, intParam } = require('../http');
const { runSource } = require('../../import');
const { invalidateViews, mappingProblems, parseReplace, boolValue, isObj, KINDS } = require('./imports');

const MASK = '••••';
const METHODS = ['GET', 'POST'];
const MAX_INTERVAL_MINUTES = 525600; // rok
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SECRET_NAME_RE = /(auth|token|secret|passw|pwd|api[-_]?key|apikey|cookie|session|credential|signature|private|access[-_]?key)/i;
const SECRET_PARAM_RE = /^(key|pass|sig|hash|code)$|auth|token|secret|passw|pwd|api[-_]?key|apikey|signature|credential|access[-_]?key/i;
const AUTH_SCHEME_RE = /^(basic|bearer|token|digest|apikey|api-key|key|oauth|jwt|negotiate|ntlm|hmac|aws4-hmac-sha256)\s+\S/i;
const JSON_BODY_LIMIT_MB = 10;

// ---------------------------------------------------------------------------------------------------------
// Maskování tajných údajů

function isMasked(v) {
  return typeof v === 'string' && v.includes(MASK);
}

/** Maska hodnoty: „Basic ••••“ pro autorizační schéma, jinak „••••“. Prázdná hodnota zůstane prázdná. */
function maskValue(v) {
  if (v === null || v === undefined || v === '') return v;
  const s = String(v);
  const m = AUTH_SCHEME_RE.exec(s);
  return m ? `${m[1]} ${MASK}` : MASK;
}

/** Hlavičky pro výstup: tajné hodnoty maskované. */
function maskHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[k] = SECRET_NAME_RE.test(k) || k.toLowerCase() === 'cookie' ? maskValue(v) : v;
  return out;
}

/** Volby pro výstup: hodnoty klíčů s tajným názvem (i vnořené) maskované. */
function maskDeep(value, key) {
  if (Array.isArray(value)) return value.map((x) => maskDeep(x, key));
  if (isObj(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v, k);
    return out;
  }
  if (key && SECRET_NAME_RE.test(key) && (typeof value === 'string' || typeof value === 'number')) return maskValue(value);
  return value;
}

/** URL pro výstup: heslo v userinfo a tajné parametry dotazu nahrazené „••••“ (zbytek URL beze změny). */
function maskUrl(url) {
  if (!url) return url ?? null;
  let s = String(url);
  s = s.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#@]*)@/i, (all, scheme, userinfo) => {
    const i = userinfo.indexOf(':');
    if (i === -1) return all;
    return `${scheme}${userinfo.slice(0, i)}:${MASK}@`;
  });
  const q = s.indexOf('?');
  if (q === -1) return s;
  const hash = s.indexOf('#', q);
  const query = hash === -1 ? s.slice(q + 1) : s.slice(q + 1, hash);
  const masked = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      let name = pair.slice(0, eq);
      try {
        name = decodeURIComponent(name.replace(/\+/g, ' '));
      } catch {
        /* nechat surové */
      }
      return SECRET_PARAM_RE.test(name) && pair.length > eq + 1 ? `${pair.slice(0, eq)}=${MASK}` : pair;
    })
    .join('&');
  return s.slice(0, q + 1) + masked + (hash === -1 ? '' : s.slice(hash));
}

/** Obnoví maskované hodnoty hlaviček z uložených (jméno hlavičky bez ohledu na velikost písmen). */
function restoreHeaders(incoming, stored, errors) {
  const storedByLower = new Map(Object.entries(stored || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (!isMasked(v)) {
      out[k] = v;
      continue;
    }
    const prev = storedByLower.get(k.toLowerCase());
    if (prev !== undefined && maskValue(prev) === v) out[k] = prev;
    else errors.push({ field: `headers.${k}`, message: `Hodnota hlavičky „${k}“ je skrytá (${MASK}) – zadejte ji znovu celou.` });
  }
  return out;
}

/** Obnoví maskované hodnoty ve volbách (stejná cesta klíčů). */
function restoreDeep(incoming, stored, pathLabel, errors) {
  if (Array.isArray(incoming)) return incoming.map((x, i) => restoreDeep(x, Array.isArray(stored) ? stored[i] : undefined, `${pathLabel}[${i}]`, errors));
  if (isObj(incoming)) {
    const out = {};
    for (const [k, v] of Object.entries(incoming)) out[k] = restoreDeep(v, isObj(stored) ? stored[k] : undefined, `${pathLabel}.${k}`, errors);
    return out;
  }
  if (isMasked(incoming)) {
    if (stored !== undefined && stored !== null && maskValue(stored) === incoming) return stored;
    errors.push({ field: pathLabel, message: `Hodnota „${pathLabel}“ je skrytá (${MASK}) – zadejte ji znovu celou.` });
  }
  return incoming;
}

// ---------------------------------------------------------------------------------------------------------
// Výstup

function nextRunAt(row) {
  if (!row.enabled || !row.url || !(Number(row.interval_minutes) > 0)) return null;
  const last = row.last_run_at ? Date.parse(row.last_run_at) : NaN;
  if (!Number.isFinite(last)) return null; // ještě neběžel → plánovač ho vezme při nejbližším tiku
  return new Date(last + Number(row.interval_minutes) * 60000).toISOString();
}

/** Řádek tabulky sources → objekt API (JSON sloupce rozparsované, tajné údaje maskované). */
function presentSource(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    url: maskUrl(row.url),
    method: row.method || 'GET',
    headers: maskHeaders(parseJson(row.headers, {}) || {}),
    mapping: parseJson(row.mapping, {}) || {},
    options: maskDeep(parseJson(row.options, {}) || {}),
    interval_minutes: Number(row.interval_minutes) || 0,
    enabled: !!row.enabled,
    last_run_at: row.last_run_at ?? null,
    last_status: row.last_status ?? null,
    last_message: row.last_message ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    next_run_at: nextRunAt(row),
  };
}

function getRow(db, id) {
  const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, `Zdroj #${id} nebyl nalezen.`);
  return row;
}

// ---------------------------------------------------------------------------------------------------------
// Validace

function jsonObjectField(v, field, errors, label) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return {};
  let o = v;
  if (typeof v === 'string') {
    try {
      o = JSON.parse(v);
    } catch {
      errors.push({ field, message: `${label} není platný JSON.` });
      return undefined;
    }
  }
  if (!isObj(o)) {
    errors.push({ field, message: `${label} musí být JSON objekt.` });
    return undefined;
  }
  return o;
}

function validateUrl(v, errors) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') {
    errors.push({ field: 'url', message: 'URL musí být text.' });
    return undefined;
  }
  const s = v.trim();
  if (!s) return null;
  if (s.length > 4000) {
    errors.push({ field: 'url', message: 'URL je příliš dlouhá (max. 4000 znaků).' });
    return undefined;
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    errors.push({ field: 'url', message: `Neplatná URL „${s.slice(0, 200)}“.` });
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    errors.push({ field: 'url', message: 'URL musí začínat http:// nebo https://.' });
    return undefined;
  }
  return s;
}

function validateHeaders(h, errors) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (!HEADER_NAME_RE.test(k)) {
      errors.push({ field: `headers.${k}`, message: `Neplatný název HTTP hlavičky „${k}“.` });
      continue;
    }
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'object') {
      errors.push({ field: `headers.${k}`, message: `Hodnota hlavičky „${k}“ musí být text.` });
      continue;
    }
    const s = String(v);
    if (/[\r\n\0]/.test(s)) {
      errors.push({ field: `headers.${k}`, message: `Hodnota hlavičky „${k}“ nesmí obsahovat konec řádku.` });
      continue;
    }
    out[k] = s;
  }
  return out;
}

function validateOptions(o, kind, errors) {
  if (kind === 'offers' && o.replace !== undefined) {
    try {
      o.replace = parseReplace(o.replace);
    } catch (e) {
      errors.push({ field: 'options.replace', message: e.message });
    }
  }
  for (const key of ['max_age_days', 'maxAgeDays']) {
    const v = o[key];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) errors.push({ field: `options.${key}`, message: 'options.max_age_days musí být nezáporné číslo (dny).' });
    else o[key] = n;
  }
  for (const key of ['deactivate_missing', 'deactivateMissing']) {
    if (o[key] === undefined) continue;
    const v = o[key];
    if (typeof v === 'boolean') continue;
    const b = boolValue(v, null);
    if (b === null) errors.push({ field: `options.${key}`, message: 'options.deactivate_missing musí být true nebo false.' });
    else o[key] = b;
  }
  if (o.timeout_ms !== undefined && o.timeout_ms !== null) {
    const n = Number(o.timeout_ms);
    if (!Number.isFinite(n) || n <= 0) errors.push({ field: 'options.timeout_ms', message: 'options.timeout_ms musí být kladné číslo (milisekundy).' });
    else o.timeout_ms = n;
  }
  return o;
}

/**
 * Ověří a znormalizuje tělo POST/PUT. U PUT (`existing` = uložený řádek) chybějící pole zůstávají.
 * @returns {object} hodnoty sloupců k zápisu
 */
function sourceValues(body, existing) {
  if (!isObj(body)) throw new HttpError(400, 'Očekáván JSON objekt se zdrojem v těle požadavku.');
  const errors = [];
  const cur = existing
    ? {
        name: existing.name,
        kind: existing.kind,
        url: existing.url ?? null,
        method: existing.method || 'GET',
        headers: parseJson(existing.headers, {}) || {},
        mapping: parseJson(existing.mapping, {}) || {},
        options: parseJson(existing.options, {}) || {},
        interval_minutes: Number(existing.interval_minutes) || 0,
        enabled: existing.enabled ? 1 : 0,
      }
    : { name: undefined, kind: undefined, url: null, method: 'GET', headers: {}, mapping: {}, options: {}, interval_minutes: 0, enabled: 1 };
  const v = { ...cur };

  // název
  if (body.name !== undefined || !existing) {
    const name = typeof body.name === 'string' ? body.name.trim() : body.name == null ? '' : String(body.name).trim();
    if (!name) errors.push({ field: 'name', message: 'Zadejte název zdroje.' });
    else if (name.length > 200) errors.push({ field: 'name', message: 'Název zdroje je příliš dlouhý (max. 200 znaků).' });
    else v.name = name;
  }
  // druh
  if (body.kind !== undefined || !existing) {
    const k = typeof body.kind === 'string' ? body.kind.trim().toLowerCase() : '';
    if (!KINDS.includes(k)) errors.push({ field: 'kind', message: 'Druh zdroje (kind) musí být „offers“ (ceny konkurence) nebo „products“ (katalog).' });
    else v.kind = k;
  }
  // URL (maskovaná URL z GET → ponechat uloženou)
  if (body.url !== undefined) {
    if (isMasked(body.url) && existing && existing.url && maskUrl(existing.url) === String(body.url).trim()) v.url = existing.url;
    else if (isMasked(body.url)) errors.push({ field: 'url', message: `URL obsahuje skrytou hodnotu (${MASK}) – zadejte ji znovu celou.` });
    else {
      const u = validateUrl(body.url, errors);
      if (u !== undefined) v.url = u;
    }
  }
  // metoda
  if (body.method !== undefined) {
    const m = body.method == null || body.method === '' ? 'GET' : String(body.method).trim().toUpperCase();
    if (!METHODS.includes(m)) errors.push({ field: 'method', message: 'Metoda musí být GET nebo POST.' });
    else v.method = m;
  }
  // hlavičky
  if (body.headers !== undefined) {
    const h = jsonObjectField(body.headers, 'headers', errors, 'Hlavičky (headers)');
    if (h !== undefined) v.headers = validateHeaders(restoreHeaders(h, cur.headers, errors), errors);
  }
  // mapování (ověřuje se proti výslednému druhu)
  if (body.mapping !== undefined) {
    const m = jsonObjectField(body.mapping, 'mapping', errors, 'Mapování (mapping)');
    if (m !== undefined) v.mapping = m;
  }
  if (v.kind && (body.mapping !== undefined || body.kind !== undefined)) {
    for (const e of mappingProblems(v.mapping, v.kind)) errors.push(e);
  }
  // volby
  if (body.options !== undefined) {
    const o = jsonObjectField(body.options, 'options', errors, 'Volby (options)');
    if (o !== undefined) v.options = restoreDeep(o, cur.options, 'options', errors);
  }
  if (v.kind && (body.options !== undefined || body.kind !== undefined) && isObj(v.options)) v.options = validateOptions({ ...v.options }, v.kind, errors);
  // interval
  if (body.interval_minutes !== undefined) {
    const raw = body.interval_minutes;
    const n = raw === null || raw === '' ? 0 : typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 0) errors.push({ field: 'interval_minutes', message: 'Interval (interval_minutes) musí být celé číslo ≥ 0 (0 = jen ručně / přes API).' });
    else if (n > MAX_INTERVAL_MINUTES) errors.push({ field: 'interval_minutes', message: `Interval může být nejvýše ${MAX_INTERVAL_MINUTES} minut (rok).` });
    else v.interval_minutes = n;
  }
  // zapnuto
  if (body.enabled !== undefined) {
    const b = typeof body.enabled === 'boolean' ? body.enabled : boolValue(body.enabled, null);
    if (b === null) errors.push({ field: 'enabled', message: 'Hodnota enabled musí být true nebo false.' });
    else v.enabled = b ? 1 : 0;
  }

  if (errors.length) throw new HttpError(400, `Neplatný zdroj: ${errors.map((e) => e.message).join(' ')}`, { errors });
  return v;
}

function auditSafe(ctx, entry) {
  try {
    audit(ctx.db, { actor: ctx.user || null, ...entry });
  } catch {
    /* audit nesmí operaci shodit */
  }
}

// ---------------------------------------------------------------------------------------------------------
// Handlery

function listSources(ctx) {
  const rows = ctx.db.prepare('SELECT * FROM sources ORDER BY name COLLATE NOCASE, id').all();
  const items = rows.map(presentSource);
  return { items, total: items.length, page: 1, limit: Math.max(items.length, 1) };
}

function getSource(ctx) {
  return presentSource(getRow(ctx.db, intParam(ctx, 'id')));
}

function createSource(ctx) {
  const v = sourceValues(ctx.body, null);
  const now = nowIso();
  const r = ctx.db
    .prepare(
      `INSERT INTO sources (name, kind, url, method, headers, mapping, options, interval_minutes, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(v.name, v.kind, v.url, v.method, JSON.stringify(v.headers), JSON.stringify(v.mapping), JSON.stringify(v.options), v.interval_minutes, v.enabled, now, now);
  const id = Number(r.lastInsertRowid);
  const row = getRow(ctx.db, id);
  auditSafe(ctx, { action: 'source.create', entity: 'source', entity_id: id, detail: { name: v.name, kind: v.kind, url: maskUrl(v.url) } });
  ctx.status = 201;
  return presentSource(row);
}

function updateSource(ctx) {
  const id = intParam(ctx, 'id');
  const existing = getRow(ctx.db, id);
  const v = sourceValues(ctx.body, existing);
  ctx.db
    .prepare(
      `UPDATE sources SET name = ?, kind = ?, url = ?, method = ?, headers = ?, mapping = ?, options = ?, interval_minutes = ?, enabled = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(v.name, v.kind, v.url, v.method, JSON.stringify(v.headers), JSON.stringify(v.mapping), JSON.stringify(v.options), v.interval_minutes, v.enabled, nowIso(), id);
  auditSafe(ctx, { action: 'source.update', entity: 'source', entity_id: id, detail: { name: v.name, kind: v.kind, url: maskUrl(v.url), enabled: v.enabled } });
  return presentSource(getRow(ctx.db, id));
}

function deleteSource(ctx) {
  const id = intParam(ctx, 'id');
  const row = getRow(ctx.db, id);
  ctx.db.prepare('DELETE FROM sources WHERE id = ?').run(id);
  auditSafe(ctx, { action: 'source.delete', entity: 'source', entity_id: id, detail: { name: row.name, kind: row.kind } });
  return { ok: true };
}

async function runSourceHandler(ctx) {
  const id = intParam(ctx, 'id');
  const row = getRow(ctx.db, id);
  if (!row.url || !String(row.url).trim()) {
    throw new HttpError(400, `Zdroj „${row.name}“ nemá nastavenou URL – data do něj posílejte přes API (POST /api/v1/import/${row.kind}?source=${id}).`);
  }
  const result = await runSource(ctx.db, id, { origin: 'manual' });
  auditSafe(ctx, { action: 'source.run', entity: 'source', entity_id: id, detail: { ok: !!result.ok, import_id: result.import_id ?? null } });
  if (!result.ok) {
    // Chyba je už zaznamenaná (imports.status = error, sources.last_status = error). 502 = vzdálený zdroj
    // nevrátil použitelná data (UI zobrazí chybovou hlášku místo „načteno 0 záznamů“).
    throw new HttpError(502, result.error || 'Zdroj se nepodařilo stáhnout nebo naimportovat.', {
      ok: false,
      source_id: result.source_id ?? id,
      import_id: result.import_id ?? null,
      error: result.error || null,
      duration_ms: result.duration_ms ?? null,
    });
  }
  invalidateViews(ctx);
  return { ...result, source: presentSource(getRow(ctx.db, id)) };
}

function register(router) {
  const jsonOpts = { auth: 'admin', maxBodyMb: JSON_BODY_LIMIT_MB };
  router.get('/api/v1/sources', listSources, { auth: 'read' });
  router.post('/api/v1/sources', createSource, jsonOpts);
  router.get('/api/v1/sources/:id', getSource, { auth: 'read' });
  router.put('/api/v1/sources/:id', updateSource, jsonOpts);
  router.delete('/api/v1/sources/:id', deleteSource, { auth: 'admin' });
  router.post('/api/v1/sources/:id/run', runSourceHandler, { auth: ['admin', 'import'], maxBodyMb: 1 });
}

module.exports = { register, presentSource, maskUrl, maskHeaders, maskValue, maskDeep, MASK };
