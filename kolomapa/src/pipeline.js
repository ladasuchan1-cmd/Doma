'use strict';
// Denní běh: stáhnout inzeráty ze všech zdrojů → uložit → doplnit detaily → klasifikovat (kolo? jaké?) →
// geolokovat → nacenit (model + volitelně AI) → označit zmizelé (prodané/smazané) → uklidit staré.
//
// Kontrakt zdroje (src/sources/<key>.js):
//   key, label, homepage, requiresBrowser
//   async scan(ctx) → {complete: boolean}
//       Projde výpis (nejnovější první) a každý inzerát předá přes `await ctx.emit(item)`, které vrátí
//       {isNew, changed}. Zdroj může skončit dřív (inkrementální režim: ctx.mode === 'incremental', když už
//       dlouho potkává jen známé inzeráty). complete = true jen když prošel výpis CELÝ → nenalezené inzeráty
//       se pak označí jako zmizelé.
//   async detail(ctx, listing) → partial item | null
//       Doplní plný popis, parametry, fotku, polohu. null = inzerát už neexistuje (→ gone_at).
//   Položka (item) – normalizovaná pole (camelCase): sourceId*, url*, title*, description, priceCzk, priceNote,
//       postedAt, categorySrc, locationText, psc, okres, kraj, lat, lon, photoUrl, photoCount, params,
//       sellerType, views, detailComplete (true = položka už obsahuje vše z detailu).

const { tx, nowIso, bind, parseJson } = require('./db');
const { hash } = require('./util/text');
const { classifyListing, CLASSIFIER_VERSION } = require('./classify');
const { resolveLocation } = require('./geo');
const pricing = require('./pricing');

const FIELD_MAP = {
  url: 'url',
  title: 'title',
  description: 'description',
  priceCzk: 'price_czk',
  priceNote: 'price_note',
  postedAt: 'posted_at',
  categorySrc: 'category_src',
  locationText: 'location_text',
  psc: 'psc',
  okres: 'okres',
  kraj: 'kraj',
  lat: 'lat',
  lon: 'lon',
  photoUrl: 'photo_url',
  photoCount: 'photo_count',
  params: 'params',
  sellerType: 'seller_type',
  views: 'views',
};

function contentHash(row) {
  return hash([row.title, row.price_czk, row.description, JSON.stringify(row.params || {})].join('\u0001'));
}

/**
 * Uloží (vloží / aktualizuje) položku ze zdroje. Vrací {id, isNew, changed}.
 * Prázdné hodnoty z výpisu nepřepisují hodnoty z detailu (výpis má např. zkrácený popis).
 */
function upsertItem(db, source, item, at, { fromDetail = false } = {}) {
  if (!item || !item.sourceId || !item.url || !item.title) throw new Error(`Neúplná položka ze zdroje ${source}`);
  const existing = db.prepare('SELECT * FROM listings WHERE source = ? AND source_id = ?').get(source, String(item.sourceId));
  const row = {};
  for (const [k, col] of Object.entries(FIELD_MAP)) {
    if (item[k] === undefined) continue;
    let v = item[k];
    if (k === 'params') v = JSON.stringify(v && typeof v === 'object' ? v : {});
    row[col] = v;
  }
  if (!existing) {
    row.source = source;
    row.source_id = String(item.sourceId);
    row.first_seen_at = at;
    row.last_seen_at = at;
    if (item.detailComplete || fromDetail) row.detail_at = at;
    row.content_hash = contentHash({ ...row, params: parseJson(row.params, {}) });
    const cols = Object.keys(row);
    const info = db.prepare(`INSERT INTO listings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => bind(row[c])));
    const id = Number(info.lastInsertRowid);
    if (row.price_czk != null) db.prepare('INSERT OR IGNORE INTO price_history (listing_id, at, price_czk) VALUES (?, ?, ?)').run(id, at, row.price_czk);
    return { id, isNew: true, changed: true };
  }
  // Výpis má zkrácený popis – nepřepisovat plný popis z detailu kratším textem.
  if (!fromDetail && !item.detailComplete && existing.detail_at && row.description != null) {
    const prev = existing.description || '';
    const cur = String(row.description);
    const stem = cur.replace(/\s*(…|\.\.\.)\s*$/, '');
    if (prev.length >= cur.length && prev.startsWith(stem.slice(0, Math.max(0, stem.length - 3)))) delete row.description;
  }
  // Prázdné hodnoty nemažou známé údaje
  for (const col of Object.keys(row)) if (row[col] == null || row[col] === '' || row[col] === '{}') delete row[col];
  const merged = { ...existing, ...row, params: parseJson(row.params ?? existing.params, {}) };
  const newHash = contentHash(merged);
  const changed = newHash !== existing.content_hash;
  row.content_hash = newHash;
  row.last_seen_at = at;
  row.gone_at = null;
  row.missed_scans = 0;
  if (item.detailComplete || fromDetail) row.detail_at = at;
  // Změna obsahu u inzerátu s detailem → detail stáhnout znovu (mohl se změnit popis)
  else if (changed && existing.detail_at && row.description === undefined && row.title !== undefined && row.title !== existing.title) row.detail_at = null;
  const cols = Object.keys(row);
  db.prepare(`UPDATE listings SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => bind(row[c])), existing.id);
  if (row.price_czk != null && row.price_czk !== existing.price_czk) {
    db.prepare('INSERT OR IGNORE INTO price_history (listing_id, at, price_czk) VALUES (?, ?, ?)').run(existing.id, at, row.price_czk);
  }
  return { id: existing.id, isNew: false, changed };
}

/** Klasifikace + vytěžení údajů pro inzeráty bez klasifikace nebo se změněným obsahem / starší verzí klasifikátoru. */
function classifyPending(db, { all = false } = {}) {
  const rows = db
    .prepare(`SELECT id, source, title, description, params, category_src, price_czk, seller_type, content_hash, features FROM listings WHERE gone_at IS NULL`)
    .all();
  const upd = db.prepare('UPDATE listings SET is_bike = ?, bike_type = ?, features = ? WHERE id = ?');
  let n = 0;
  tx(db, () => {
    for (const r of rows) {
      const f = parseJson(r.features, {});
      if (!all && f._v === CLASSIFIER_VERSION && f._h === r.content_hash) continue;
      const c = classifyListing({
        source: r.source,
        title: r.title,
        description: r.description,
        params: parseJson(r.params, {}),
        categorySrc: r.category_src,
        priceCzk: r.price_czk,
        sellerType: r.seller_type,
      });
      const features = { ...c.features, _v: CLASSIFIER_VERSION, _h: r.content_hash, _reason: c.reason };
      upd.run(c.isBike ? 1 : 0, c.bikeType || null, JSON.stringify(features), r.id);
      n++;
    }
  });
  return n;
}

/** Geolokace inzerátů bez souřadnic (nebo s nižší přesností, pokud web mezitím přidal PSČ/souřadnice). */
function geocodePending(db) {
  const rows = db
    .prepare('SELECT id, location_text, psc, okres, kraj, lat, lon, geo_precision FROM listings WHERE gone_at IS NULL AND (geo_precision IS NULL OR geo_precision NOT IN (\'exact\'))')
    .all();
  const upd = db.prepare('UPDATE listings SET lat = ?, lon = ?, kraj = ?, okres = ?, geo_precision = ? WHERE id = ?');
  let n = 0;
  tx(db, () => {
    for (const r of rows) {
      // Souřadnice z webu (lat/lon) mají přednost; jinak PSČ + text lokality.
      const hasExact = r.lat != null && r.lon != null && (r.geo_precision == null || r.geo_precision === 'exact');
      const g = resolveLocation({
        lat: hasExact ? r.lat : null,
        lon: hasExact ? r.lon : null,
        psc: r.psc,
        locationText: r.location_text,
        okres: r.okres,
        kraj: r.kraj,
      });
      if (!g.precision) {
        if (r.geo_precision != null) upd.run(null, null, r.kraj, r.okres, null, r.id);
        continue;
      }
      if (g.precision === r.geo_precision && g.lat === r.lat && g.lon === r.lon) continue;
      upd.run(g.lat, g.lon, g.kraj, g.okres || r.okres || null, g.precision, r.id);
      n++;
    }
  });
  return n;
}

/**
 * Po úplném průchodu výpisu: inzeráty, které v něm chyběly (seenIds = id řádků viděných v tomto průchodu). Stránkování po offsetu se během průchodu posouvá
 * (mazání inzerátů), proto jedno chybění nestačí: zmizelý = chyběl ve 2 průchodech po sobě, nebo zdroj smazání
 * potvrdí přes confirmGone(ctx, listing) → true (smazáno) | false (existuje) | null (nevím).
 */
async function markMissing(db, src, ctx, seenIds, { log, signal } = {}) {
  const missing = db
    .prepare('SELECT * FROM listings WHERE source = ? AND gone_at IS NULL')
    .all(src.key)
    .filter((r) => !seenIds.has(r.id));
  const setGone = db.prepare('UPDATE listings SET gone_at = ?, missed_scans = missed_scans + 1 WHERE id = ?');
  const bump = db.prepare('UPDATE listings SET missed_scans = missed_scans + 1 WHERE id = ?');
  const seen = db.prepare('UPDATE listings SET missed_scans = 0, last_seen_at = ? WHERE id = ?');
  const maxConfirm = ctx.config?.maxConfirmGone ?? 400;
  let gone = 0;
  let confirms = 0;
  for (const row of missing) {
    if (signal?.aborted) break;
    if (row.missed_scans + 1 >= 2) {
      setGone.run(nowIso(), row.id);
      gone++;
      continue;
    }
    if (typeof src.confirmGone === 'function' && confirms < maxConfirm) {
      confirms++;
      let r = null;
      try {
        r = await src.confirmGone(ctx, { ...row, params: parseJson(row.params, {}) });
      } catch (e) {
        log?.debug?.(`${src.label}: ověření zmizení selhalo`, { url: row.url, error: e.message });
      }
      if (r === true) {
        setGone.run(nowIso(), row.id);
        gone++;
      } else if (r === false) seen.run(nowIso(), row.id);
      else bump.run(row.id);
    } else bump.run(row.id);
  }
  return gone;
}

/**
 * Hlavní běh.
 * @param {{db, config, log, sources: object[], signal?: AbortSignal, trigger?: string, http?: object,
 *          getBrowser?: Function, onProgress?: Function}} o
 */
async function runPipeline(o) {
  const { db, config, log } = o;
  const startedAt = nowIso();
  const runId = Number(db.prepare("INSERT INTO runs (started_at, status, trigger) VALUES (?, 'running', ?)").run(startedAt, o.trigger || 'manual').lastInsertRowid);
  const stats = { sources: {}, classified: 0, geocoded: 0, priced: 0, ai: 0, gone: 0, pruned: 0 };
  const progress = (msg, meta) => {
    log?.info?.(msg, meta);
    o.onProgress?.(msg, meta);
  };
  let status = 'ok';
  let error = null;
  try {
    for (const src of o.sources) {
      if (o.signal?.aborted) throw o.signal.reason || new Error('Přerušeno');
      const s = { scanned: 0, new: 0, changed: 0, details: 0, detailErrors: 0, gone: 0, complete: false, mode: null, error: null };
      stats.sources[src.key] = s;
      const lastFull = db.prepare("SELECT value FROM settings WHERE key = ?").get(`lastFullScan:${src.key}`);
      const lastFullAt = lastFull ? parseJson(lastFull.value, null) : null;
      const fullDue = !lastFullAt || Date.parse(startedAt) - Date.parse(lastFullAt) >= (config.fullScanDays * 24 - 2) * 3600 * 1000;
      s.mode = fullDue ? 'full' : 'incremental';
      const seenIds = new Set();
      const ctx = {
        http: o.http,
        getBrowser: o.getBrowser,
        log,
        config,
        signal: o.signal,
        mode: s.mode,
        maxPages: config.maxPages,
        minPrice: config.minPrice,
        isKnown: (sourceId) => db.prepare('SELECT id, price_czk, title, detail_at, gone_at FROM listings WHERE source = ? AND source_id = ?').get(src.key, String(sourceId)) || null,
        emit: async (item) => {
          s.scanned++;
          const r = upsertItem(db, src.key, item, nowIso());
          seenIds.add(r.id);
          if (r.isNew) s.new++;
          else if (r.changed) s.changed++;
          if (s.scanned % 500 === 0) progress(`${src.label}: ${s.scanned} inzerátů`, { new: s.new });
          return r;
        },
      };
      progress(`${src.label}: stahuji výpis (${s.mode === 'full' ? 'celý' : 'jen novinky'})…`);
      try {
        const res = (await src.scan(ctx)) || {};
        s.complete = !!res.complete;
      } catch (e) {
        if (o.signal?.aborted) throw e;
        s.error = e.message;
        status = 'partial';
        log?.warn?.(`${src.label}: výpis selhal`, { error: e.message });
      }
      // Detaily: nové / změněné inzeráty, nejnovější první, s limitem na běh.
      if (src.detail && config.maxDetails > 0 && !o.signal?.aborted) {
        const todo = db
          .prepare('SELECT * FROM listings WHERE source = ? AND gone_at IS NULL AND detail_at IS NULL ORDER BY COALESCE(posted_at, first_seen_at) DESC LIMIT ?')
          .all(src.key, config.maxDetails);
        if (todo.length) progress(`${src.label}: stahuji detaily ${todo.length} inzerátů…`);
        for (const row of todo) {
          if (o.signal?.aborted) break;
          try {
            const d = await src.detail(ctx, { ...row, params: parseJson(row.params, {}) });
            if (d === null) {
              db.prepare('UPDATE listings SET gone_at = ? WHERE id = ?').run(nowIso(), row.id);
              s.gone++;
            } else if (d) {
              upsertItem(db, src.key, { ...d, sourceId: row.source_id, url: d.url || row.url, title: d.title || row.title }, nowIso(), { fromDetail: true });
              s.details++;
            }
          } catch (e) {
            if (o.signal?.aborted) break;
            s.detailErrors++;
            log?.debug?.(`${src.label}: detail selhal`, { url: row.url, error: e.message });
            if (s.detailErrors >= 25 && s.detailErrors > s.details) {
              log?.warn?.(`${src.label}: příliš mnoho chyb detailu, končím s detaily pro tento běh`);
              break;
            }
          }
        }
      }
      if (s.complete && s.mode === 'full' && !s.error) {
        s.gone += await markMissing(db, src, ctx, seenIds, { log, signal: o.signal });
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`lastFullScan:${src.key}`, JSON.stringify(startedAt));
      }
      stats.gone += s.gone;
      progress(`${src.label}: hotovo`, s);
    }

    progress('Klasifikuji inzeráty…');
    stats.classified = classifyPending(db);
    progress('Určuji polohu…');
    stats.geocoded = geocodePending(db);
    progress('Naceňuji…');
    const model = pricing.trainModel(db, { config, log });
    stats.model = model.summary;
    stats.priced = pricing.priceAll(db, model, { config });
    if (config.ai?.enabled && config.ai.maxPerRun > 0 && !o.signal?.aborted) {
      progress('AI nacenění podle fotek…');
      try {
        const ai = require('./pricing/ai');
        stats.ai = await ai.valuatePending(db, { config, log, signal: o.signal, model });
      } catch (e) {
        status = 'partial';
        stats.aiError = e.message;
        log?.warn?.('AI nacenění selhalo', { error: e.message });
      }
    }
    // Úklid: zmizelé inzeráty starší než goneKeepDays
    const cutoff = new Date(Date.parse(startedAt) - config.goneKeepDays * 86400000).toISOString();
    stats.pruned = Number(db.prepare('DELETE FROM listings WHERE gone_at IS NOT NULL AND gone_at < ?').run(cutoff).changes);
    if (Object.values(stats.sources).some((s) => s.error)) status = 'partial';
  } catch (e) {
    status = 'error';
    error = e.message;
    log?.error?.('Běh selhal', { error: e });
  }
  db.prepare('UPDATE runs SET finished_at = ?, status = ?, stats = ?, error = ? WHERE id = ?').run(nowIso(), status, JSON.stringify(stats), error, runId);
  return { runId, status, stats, error };
}

module.exports = { runPipeline, upsertItem, classifyPending, geocodePending, contentHash, markMissing };
