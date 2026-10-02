'use strict';
// Data pro UI (mapa, seznam, detail) z databáze. Stejné tvary vrací živý server (/data/*.json) i statický export
// (tools/export-static.js), takže frontend v public/ funguje beze změny v obou režimech.
//
//   buildSummary(db, {mode})  → přehled ČR: poslední běh, součty, 14 krajů, zdroje, nejvýhodnější nabídky
//   buildKraj(db, code)       → všechny aktivní inzeráty kol v kraji jako kompaktní objekty (krátké klíče)
//   buildListing(db, id)      → plný řádek inzerátu + historie ceny (jen server)
//
// Kompaktní inzerát (klíče s prázdnou hodnotou se vynechávají, aby JSON krajů zůstal malý):
//   id, s zdroj, k kraj, u url, t titulek, p cena, pn poznámka k ceně, la/lo souřadnice (posunuté jitter() –
//   inzeráty z jedné obce se nepřekrývají), g přesnost polohy, c místo, ph fotka, bt typ kola, b značka, m model,
//   y rok, ws kola, fs rám, mat materiál, eb elektrokolo, mo motor, wh baterie Wh, gs sada, cond stav,
//   e/el/eh/ec/em odhad (cena, dolní, horní mez, jistota 0–1, metoda), d cena/odhad, mb max. výkupní cena,
//   ai {e, l, h, c stav, n poznámky}, fx faktory odhadu, w varování, f poprvé viděn, ps vložen, v zobrazení,
//   st typ prodejce, de popis (zkrácený), pa parametry z webu.

const { parseJson, listingFromRow } = require('../db');
const { KRAJE, jitter } = require('../geo');
const { LABELS } = require('../sources');

/** Výhodná nabídka: cena / odhad ≤ DEAL_RATIO při jistotě odhadu ≥ MIN_CONFIDENCE. */
const DEAL_RATIO = 0.85;
/** Předražená nabídka: cena / odhad > HIGH_RATIO. */
const HIGH_RATIO = 1.15;
/** Minimální jistota odhadu, aby se inzerát počítal mezi výhodné / předražené. */
const MIN_CONFIDENCE = 0.45;
/** „Nové“ = poprvé viděné za posledních NEW_HOURS hodin (denní běh + rezerva). */
const NEW_HOURS = 36;
/** Kolik nejvýhodnějších nabídek ČR poslat v přehledu. */
const TOP_DEALS = 150;
/** Maximální délka popisu v kompaktním inzerátu (plný popis vrací /api/listing/:id). */
const DESC_MAX = 1500;

const KRAJ_CODES = Object.keys(KRAJE);

function isEmpty(v) {
  if (v == null || v === '' || v === false) return true;
  if (typeof v === 'number') return !Number.isFinite(v);
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function put(o, key, v) {
  if (!isEmpty(v)) o[key] = v;
}

/** Jen absolutní http(s) odkazy (data z webů jsou nedůvěryhodná). */
function safeUrl(u) {
  if (typeof u !== 'string') return null;
  const s = u.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const url = new URL(s);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

const round = (v, digits = 0) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** Zkrátí text na max znaků (na hranici slova) a přidá „…“. */
function truncate(s, max = DESC_MAX) {
  if (s == null) return null;
  const t = String(s).trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.8 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function strArray(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const x of v) {
    if (x == null) continue;
    if (typeof x === 'string') {
      if (x.trim()) out.push(x.trim());
    } else if (typeof x === 'object') {
      const t = x.text ?? x.label ?? x.reason ?? null;
      if (t) out.push(String(t));
    } else out.push(String(x));
  }
  return out;
}

/**
 * Je řádek výhodnou nabídkou? (stejné pravidlo používá UI přes summary.thresholds)
 * @param {{price_czk?: number, est_czk?: number, deal_ratio?: number, est_confidence?: number}} r
 */
function isDeal(r) {
  return r.price_czk > 0 && r.est_czk > 0 && r.deal_ratio != null && r.deal_ratio <= DEAL_RATIO && (r.est_confidence ?? 0) >= MIN_CONFIDENCE;
}

/**
 * Řádek tabulky listings → kompaktní objekt pro UI.
 * @param {object} r řádek z DB (JSON sloupce jako text nebo už rozbalené)
 * @returns {object}
 */
function compactListing(r) {
  const f = parseJson(r.features, {}) || {};
  const o = {};
  put(o, 'id', r.id);
  put(o, 's', r.source);
  put(o, 'k', r.kraj);
  put(o, 'u', safeUrl(r.url));
  put(o, 't', str(r.title));
  put(o, 'p', round(r.price_czk));
  put(o, 'pn', str(r.price_note));
  if (r.lat != null && r.lon != null && Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon))) {
    const [la, lo] = jitter(Number(r.lat), Number(r.lon), r.geo_precision, `${r.source}:${r.source_id}`);
    o.la = round(la, 5);
    o.lo = round(lo, 5);
  }
  put(o, 'g', r.geo_precision);
  put(o, 'c', str(r.location_text));
  put(o, 'ph', safeUrl(r.photo_url));
  put(o, 'bt', r.bike_type);
  put(o, 'b', str(f.brand));
  put(o, 'm', str(f.model));
  put(o, 'y', round(f.modelYear));
  put(o, 'ws', str(f.wheelSize));
  put(o, 'fs', str(f.frameSize));
  put(o, 'mat', str(f.material));
  if (f.isEbike) o.eb = true;
  put(o, 'mo', str(f.motor));
  put(o, 'wh', round(f.batteryWh));
  put(o, 'gs', str(f.groupset));
  put(o, 'cond', str(f.condition));
  put(o, 'e', round(r.est_czk));
  put(o, 'el', round(r.est_low));
  put(o, 'eh', round(r.est_high));
  put(o, 'ec', round(r.est_confidence, 2));
  put(o, 'em', r.est_method);
  put(o, 'd', round(r.deal_ratio, 3));
  put(o, 'mb', round(r.max_buy_czk));
  if (r.ai_czk != null) {
    const ai = {};
    put(ai, 'e', round(r.ai_czk));
    put(ai, 'l', round(r.ai_low));
    put(ai, 'h', round(r.ai_high));
    put(ai, 'c', str(r.ai_condition));
    put(ai, 'n', str(r.ai_notes));
    put(o, 'ai', ai);
  }
  put(o, 'fx', strArray(parseJson(r.est_factors, [])));
  put(o, 'w', strArray(f.warnings));
  put(o, 'f', r.first_seen_at);
  put(o, 'ps', r.posted_at);
  if (r.views != null && Number.isFinite(Number(r.views))) o.v = Number(r.views);
  put(o, 'st', r.seller_type);
  put(o, 'de', truncate(r.description));
  const pa = parseJson(r.params, {});
  if (pa && typeof pa === 'object' && !Array.isArray(pa)) put(o, 'pa', pa);
  return o;
}

function median(nums) {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function runFromRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    trigger: r.trigger,
    stats: parseJson(r.stats, {}),
    error: r.error || null,
  };
}

/** Poslední dokončený běh (ok / partial / error) nebo null. */
function lastFinishedRun(db) {
  return runFromRow(db.prepare('SELECT * FROM runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get());
}

/**
 * Od kdy je inzerát „nový“: max(teď − NEW_HOURS, konec prvního úspěšného běhu). Inzeráty z úplně prvního
 * stažení tak nejsou všechny „nové“.
 */
function newSinceIso(db, now) {
  // zaokrouhleno na 10 minut dolů – přehled se pak mezi požadavky nemění (ETag / 304)
  const windowStart = Math.floor((now.getTime() - NEW_HOURS * 3600 * 1000) / 600000) * 600000;
  const first = db.prepare("SELECT finished_at FROM runs WHERE status IN ('ok', 'partial') AND finished_at IS NOT NULL ORDER BY id ASC LIMIT 1").get();
  const baseline = first ? Date.parse(first.finished_at) : NaN;
  return new Date(Number.isFinite(baseline) ? Math.max(windowStart, baseline) : windowStart).toISOString();
}

/**
 * Přehled pro mapu ČR.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{mode?: 'server'|'static', now?: Date, topDeals?: number}} [opts]
 */
function buildSummary(db, { mode = 'server', now = new Date(), topDeals = TOP_DEALS } = {}) {
  const newSince = newSinceIso(db, now);
  const kraje = {};
  for (const code of KRAJ_CODES) kraje[code] = { name: KRAJE[code], count: 0, deals: 0, newToday: 0, medianPrice: null };
  const prices = Object.fromEntries(KRAJ_CODES.map((c) => [c, []]));
  const sources = {};
  for (const [key, label] of Object.entries(LABELS)) sources[key] = { label, count: 0 };
  const totals = { active: 0, bikes: 0, deals: 0, newToday: 0, withPhoto: 0 };
  let unlocated = 0;

  totals.active = Number(db.prepare('SELECT COUNT(*) AS n FROM listings WHERE gone_at IS NULL').get().n);
  const rows = db
    .prepare(
      `SELECT source, kraj, lat, lon, price_czk, est_czk, deal_ratio, est_confidence, first_seen_at, photo_url
         FROM listings WHERE gone_at IS NULL AND is_bike = 1`
    )
    .all();
  for (const r of rows) {
    totals.bikes++;
    const deal = isDeal(r);
    const isNew = r.first_seen_at && r.first_seen_at >= newSince;
    if (deal) totals.deals++;
    if (isNew) totals.newToday++;
    if (r.photo_url) totals.withPhoto++;
    if (!sources[r.source]) sources[r.source] = { label: r.source, count: 0 };
    sources[r.source].count++;
    if (r.lat == null || r.lon == null) unlocated++;
    const k = kraje[r.kraj];
    if (!k) continue;
    k.count++;
    if (deal) k.deals++;
    if (isNew) k.newToday++;
    if (r.price_czk > 0) prices[r.kraj].push(r.price_czk);
  }
  for (const code of KRAJ_CODES) {
    const m = median(prices[code]);
    kraje[code].medianPrice = m == null ? null : Math.round(m / 100) * 100;
  }

  const top = db
    .prepare(
      `SELECT * FROM listings
        WHERE gone_at IS NULL AND is_bike = 1 AND price_czk > 0 AND est_czk > 0 AND deal_ratio IS NOT NULL
          AND est_confidence >= ? AND deal_ratio <= ?
        ORDER BY deal_ratio ASC, est_confidence DESC, id ASC
        LIMIT ?`
    )
    .all(MIN_CONFIDENCE, DEAL_RATIO, topDeals)
    .map(compactListing);

  const demo = Number(
    db.prepare("SELECT COUNT(*) AS n FROM listings WHERE gone_at IS NULL AND json_valid(params) AND json_extract(params, '$.demo') = '1'").get().n
  );

  return {
    generatedAt: now.toISOString(),
    mode: mode === 'static' ? 'static' : 'server',
    lastRun: lastFinishedRun(db),
    totals,
    kraje,
    sources,
    topDeals: top,
    unlocated,
    newSince,
    demo: demo > 0 ? demo : 0,
    thresholds: { deal: DEAL_RATIO, high: HIGH_RATIO, minConfidence: MIN_CONFIDENCE, newHours: NEW_HOURS },
  };
}

/**
 * Inzeráty jednoho kraje (aktivní kola).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} code kód kraje (PHA, STC, … – viz geo.KRAJE)
 * @param {{now?: Date}} [opts]
 * @returns {{kraj: string, name: string, generatedAt: string, listings: object[]}|null} null = neznámý kraj
 */
function buildKraj(db, code, { now = new Date() } = {}) {
  const k = String(code || '').toUpperCase();
  if (!Object.hasOwn(KRAJE, k)) return null;
  const listings = db
    .prepare('SELECT * FROM listings WHERE gone_at IS NULL AND is_bike = 1 AND kraj = ? ORDER BY first_seen_at DESC, id DESC')
    .all(k)
    .map(compactListing);
  return { kraj: k, name: KRAJE[k], generatedAt: now.toISOString(), listings };
}

/**
 * Plný detail inzerátu (všechny sloupce, JSON rozbalený) + historie ceny.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @returns {object|null}
 */
function buildListing(db, id) {
  const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(Number(id));
  if (!row) return null;
  const l = listingFromRow(row);
  delete l.content_hash;
  delete l.ai_input_hash;
  l.url = safeUrl(l.url);
  l.photo_url = safeUrl(l.photo_url);
  l.kraj_name = l.kraj && KRAJE[l.kraj] ? KRAJE[l.kraj] : null;
  l.history = db
    .prepare('SELECT at, price_czk FROM price_history WHERE listing_id = ? ORDER BY at ASC')
    .all(row.id)
    .map((h) => ({ at: h.at, price: h.price_czk }));
  return l;
}

module.exports = {
  buildSummary,
  buildKraj,
  buildListing,
  compactListing,
  isDeal,
  safeUrl,
  truncate,
  KRAJ_CODES,
  DEAL_RATIO,
  HIGH_RATIO,
  MIN_CONFIDENCE,
  NEW_HOURS,
  TOP_DEALS,
  DESC_MAX,
};
