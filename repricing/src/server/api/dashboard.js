'use strict';
// API: přehled (SPEC §8 „Dashboard response“).
//
//   GET /api/v1/dashboard   read →
//   { products: {active, with_market, without_market, locked},
//     position: {cheapest, middle, most_expensive, no_data},            // aktivní produkty
//     price_index: {vs_min, vs_median},                                 // průměr % jen za produkty s trhem
//     proposals: {pending, approved, exported_7d, up, down, avg_change_pct, margin_impact_abs},
//     last_run: běh|null, last_imports: importy[≤5] (+ source_name),
//     competitors: [{id, name, label, enabled, offers, cheaper_than_us_pct}] (zapnutí, top 10 podle počtu nabídek),
//     by_manufacturer: [{manufacturer, products, with_market, avg_index, cheapest_pct, avg_margin_pct}] (top 15),
//     alerts: [{type, severity, text, count, link, product_id?, items?}] }
//
// Pravidla:
//  - products.locked = produkty s platným zámkem (lock_active), ne jen příznakem locked.
//  - proposals.up/down/avg_change_pct/margin_impact_abs počítají otevřené návrhy (pending + approved) s cenou
//    k exportu (manual_price ?? new_price); margin_impact_abs = Σ (nová − stará cena) bez DPH za 1 ks.
//  - by_manufacturer: avg_index a cheapest_pct jen z produktů s trhem; avg_margin_pct z produktů se známou marží.
//  - alerts (typy dle SPEC): below_cost, zero_price, no_cost, competitor_drop, stale_offers, not_applied,
//    min_below_cost, unmatched; jen s počtem > 0, seřazeno error → warn → info. link = hash route UI.

const { parseJson } = require('../../db');
const { round } = require('../../util/num');
const { parseDateTime } = require('../../engine/metrics');
const V = require('./_views');
const { lastRun } = require('./runs');

const DAY_MS = 86400000;
const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };

const productsLink = (filter) => `#/produkty?filter=${encodeURIComponent(JSON.stringify(filter))}`;
const plural = (n, one, few, many) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many);
const int = (n) => Math.round(n).toLocaleString('cs-CZ');
const pct = (n) => `${String(round(n, 1)).replace('.', ',')} %`;

function avg(sum, n, d = 1) {
  return n ? round(sum / n, d) : null;
}

function proposalStats(db, settings) {
  const vat = settings.vat_rate_default ?? 21;
  const r = db
    .prepare(
      `SELECT
         COALESCE(SUM(pr.status = 'pending'), 0) AS pending,
         COALESCE(SUM(pr.status = 'approved'), 0) AS approved,
         COALESCE(SUM(COALESCE(pr.manual_price, pr.new_price) > pr.old_price), 0) AS up,
         COALESCE(SUM(COALESCE(pr.manual_price, pr.new_price) < pr.old_price), 0) AS down,
         AVG(CASE WHEN pr.old_price > 0 THEN (COALESCE(pr.manual_price, pr.new_price) - pr.old_price) * 100.0 / pr.old_price END) AS avg_pct,
         SUM(CASE WHEN pr.old_price IS NOT NULL
               THEN (COALESCE(pr.manual_price, pr.new_price) - pr.old_price) / (1 + COALESCE(p.vat_rate, ?) / 100.0) END) AS impact
       FROM proposals pr JOIN products p ON p.id = pr.product_id
       WHERE pr.status IN ('pending', 'approved')`
    )
    .get(vat);
  const weekAgo = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const exported7d = db.prepare("SELECT count(*) AS c FROM proposals WHERE status = 'exported' AND exported_at >= ?").get(weekAgo).c;
  return {
    pending: r.pending,
    approved: r.approved,
    exported_7d: exported7d,
    up: r.up,
    down: r.down,
    avg_change_pct: r.avg_pct == null ? null : round(r.avg_pct, 2),
    margin_impact_abs: r.impact == null ? 0 : round(r.impact, 2),
  };
}

function lastImports(db) {
  return db
    .prepare('SELECT i.*, s.name AS source_name FROM imports i LEFT JOIN sources s ON s.id = i.source_id ORDER BY i.id DESC LIMIT 5')
    .all()
    .map((r) => ({ ...r, stats: parseJson(r.stats, {}) || {} }));
}

function competitorsTop(db, cache) {
  return db
    .prepare('SELECT id, name, label, enabled FROM competitors')
    .all()
    .map((c) => {
      const s = cache.competitorStats.get(c.id);
      return { id: c.id, name: c.name, label: c.label ?? null, enabled: c.enabled === 1, offers: s ? s.offers : 0, cheaper_than_us_pct: s ? s.cheaper_than_us_pct : null };
    })
    // vypnutí konkurenti se v cenotvorbě ignorují → v přehledu je nezobrazujeme
    .filter((c) => c.enabled && c.offers > 0)
    .sort((a, b) => b.offers - a.offers || V.collator.compare(a.name, b.name))
    .slice(0, 10);
}

/** Konkurenti, kteří za posledních 24 h zlevnili o více než 10 %. */
function competitorDrops(db, now) {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const where = `FROM offers o JOIN competitors c ON c.id = o.competitor_id JOIN products p ON p.id = o.product_id
    WHERE c.enabled = 1 AND p.active = 1 AND o.prev_price > 0 AND o.price < o.prev_price * 0.9 AND o.changed_at >= ?`;
  const count = db.prepare(`SELECT count(*) AS c ${where}`).get(since).c;
  if (!count) return { count: 0, items: [] };
  const items = db
    .prepare(
      `SELECT o.product_id, p.code, p.name, c.name AS competitor, o.price, o.prev_price, o.changed_at,
              ROUND((o.prev_price - o.price) * 100.0 / o.prev_price, 1) AS drop_pct
       ${where} ORDER BY (o.prev_price - o.price) / o.prev_price DESC LIMIT 5`
    )
    .all(since)
    .map(V.plain);
  return { count, items };
}

/** Exportované ceny (před > 24 h), které poslední import katalogu nepotvrdil – admin je nepřevzal. */
function notApplied(db, now) {
  const before = new Date(now.getTime() - DAY_MS).toISOString();
  const rows = db
    .prepare(
      `WITH le AS (SELECT product_id, MAX(id) AS id FROM proposals WHERE status = 'exported' GROUP BY product_id)
       SELECT pr.id AS proposal_id, pr.product_id, p.code, p.name, COALESCE(pr.manual_price, pr.new_price) AS exported_price,
              p.price AS current_price, pr.exported_at
       FROM le JOIN proposals pr ON pr.id = le.id JOIN products p ON p.id = pr.product_id
       WHERE p.active = 1 AND pr.exported_at IS NOT NULL AND pr.exported_at <= ?
         AND (p.price IS NULL OR ABS(p.price - COALESCE(pr.manual_price, pr.new_price)) >= 0.005)
         AND (EXISTS (SELECT 1 FROM imports i WHERE i.kind = 'products' AND i.status = 'ok' AND i.finished_at > pr.exported_at)
              OR EXISTS (SELECT 1 FROM price_history h WHERE h.product_id = p.id AND h.source = 'import' AND h.at > pr.exported_at))
         AND NOT EXISTS (SELECT 1 FROM price_history h2 WHERE h2.product_id = p.id AND h2.source = 'manual' AND h2.at > pr.exported_at)
       ORDER BY pr.exported_at DESC`
    )
    .all(before)
    .map(V.plain);
  return { count: rows.length, items: rows.slice(0, 5) };
}

/** Kdy naposledy přišly ceny konkurence (úspěšný import nabídek, jinak nejnovější nabídka). */
function lastOfferData(db) {
  const imp = db.prepare("SELECT MAX(finished_at) AS m FROM imports WHERE kind = 'offers' AND status = 'ok'").get().m;
  const obs = db.prepare('SELECT MAX(observed_at) AS m, count(*) AS c FROM offers').get();
  const candidates = [imp, obs.m].map((x) => (x ? parseDateTime(x) : null)).filter((x) => x != null);
  return { at: candidates.length ? Math.max(...candidates) : null, offers: obs.c, imported: imp != null };
}

function buildAlerts(db, cache, agg, now) {
  const alerts = [];
  const add = (a) => {
    if (a.count > 0) alerts.push(a);
  };
  const settings = cache.settings;

  add({
    type: 'below_cost',
    severity: 'error',
    count: agg.belowCost.length,
    text: `${int(agg.belowCost.length)} ${plural(agg.belowCost.length, 'aktivní produkt prodáváme', 'aktivní produkty prodáváme', 'aktivních produktů prodáváme')} pod nákupní cenou.`,
    link: productsLink({ field: 'below_cost', op: 'is_true' }),
    ...(agg.belowCost.length === 1 ? { product_id: agg.belowCost[0] } : {}),
  });
  add({
    type: 'zero_price',
    severity: 'error',
    count: agg.zeroPrice.length,
    text: `${int(agg.zeroPrice.length)} ${plural(agg.zeroPrice.length, 'aktivní produkt nemá', 'aktivní produkty nemají', 'aktivních produktů nemá')} prodejní cenu (prázdná nebo 0).`,
    link: productsLink({ any: [{ field: 'price', op: 'empty' }, { field: 'price', op: '<=', value: 0 }] }),
    ...(agg.zeroPrice.length === 1 ? { product_id: agg.zeroPrice[0] } : {}),
  });

  const drops = competitorDrops(db, now);
  add({
    type: 'competitor_drop',
    severity: 'warn',
    count: drops.count,
    text: `${int(drops.count)} ${plural(drops.count, 'nabídka konkurence zlevnila', 'nabídky konkurence zlevnily', 'nabídek konkurence zlevnilo')} za posledních 24 h o více než 10 %${
      drops.items[0] ? ` (např. ${drops.items[0].competitor}: ${drops.items[0].name || drops.items[0].code} −${pct(drops.items[0].drop_pct)})` : ''
    }.`,
    link: '#/produkty?sort=gap_min_pct&dir=desc',
    items: drops.items,
    ...(drops.count === 1 ? { product_id: drops.items[0].product_id } : {}),
  });

  const maxAge = Number(settings.offer_max_age_days);
  if (maxAge > 0) {
    const last = lastOfferData(db);
    if (last.at != null && now.getTime() - last.at > maxAge * DAY_MS) {
      const days = Math.floor((now.getTime() - last.at) / DAY_MS);
      add({
        type: 'stale_offers',
        severity: 'warn',
        count: last.offers,
        days_since_import: days,
        text: `Ceny konkurence nepřišly ${int(days)} ${plural(days, 'den', 'dny', 'dní')} (limit ${int(maxAge)} ${plural(maxAge, 'den', 'dny', 'dní')}) – zastaralé nabídky se v cenotvorbě ignorují. Zkontrolujte zdroje dat.`,
        link: '#/import',
      });
    }
  }

  const na = notApplied(db, now);
  add({
    type: 'not_applied',
    severity: 'warn',
    count: na.count,
    text: `${int(na.count)} ${plural(na.count, 'exportovaná cena nebyla', 'exportované ceny nebyly', 'exportovaných cen nebylo')} v adminu použito – poslední import katalogu stále ukazuje jinou cenu.`,
    link: '#/navrhy?status=exported',
    items: na.items,
    ...(na.count === 1 ? { product_id: na.items[0].product_id } : {}),
  });
  add({
    type: 'no_cost',
    severity: 'warn',
    count: agg.noCost.length,
    text: `${int(agg.noCost.length)} ${plural(agg.noCost.length, 'aktivní produkt nemá', 'aktivní produkty nemají', 'aktivních produktů nemá')} nákupní cenu – marži nelze hlídat.`,
    link: productsLink({ any: [{ field: 'purchase_price', op: 'empty' }, { field: 'purchase_price', op: '<=', value: 0 }] }),
    ...(agg.noCost.length === 1 ? { product_id: agg.noCost[0] } : {}),
  });
  add({
    type: 'min_below_cost',
    severity: 'info',
    count: agg.minBelowCost.length,
    text: `U ${int(agg.minBelowCost.length)} ${plural(agg.minBelowCost.length, 'produktu', 'produktů', 'produktů')} prodává konkurence pod naší nákupní cenou – argument pro jednání s dodavatelem.`,
    link: productsLink({ field: 'min_below_cost', op: 'is_true' }),
    ...(agg.minBelowCost.length === 1 ? { product_id: agg.minBelowCost[0] } : {}),
  });
  const unmatched = db.prepare('SELECT count(*) AS c FROM unmatched_offers').get().c;
  add({
    type: 'unmatched',
    severity: 'info',
    count: unmatched,
    text: `${int(unmatched)} ${plural(unmatched, 'nabídka konkurence není spárovaná', 'nabídky konkurence nejsou spárované', 'nabídek konkurence není spárovaných')} s katalogem.`,
    link: '#/konkurence?tab=unmatched',
  });
  alerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return alerts;
}

function dashboard(db) {
  const cache = V.getCache(db);
  const now = new Date();
  const position = { cheapest: 0, middle: 0, most_expensive: 0, no_data: 0 };
  let withMarket = 0;
  let locked = 0;
  let idxMin = 0;
  let idxMinN = 0;
  let idxMed = 0;
  let idxMedN = 0;
  const agg = { belowCost: [], zeroPrice: [], noCost: [], minBelowCost: [] };
  const manu = new Map();
  for (const i of cache.active) {
    const v = cache.views[i];
    position[v.position] = (position[v.position] || 0) + 1;
    const hasMarket = v.market_count > 0;
    if (hasMarket) withMarket++;
    if (v.lock_active) locked++;
    if (hasMarket && v.price_index != null) {
      idxMin += v.price_index;
      idxMinN++;
    }
    if (hasMarket && v.price_index_median != null) {
      idxMed += v.price_index_median;
      idxMedN++;
    }
    if (v.below_cost) agg.belowCost.push(v.id);
    if (!(Number(v.price) > 0)) agg.zeroPrice.push(v.id);
    if (!(Number(v.purchase_price) > 0)) agg.noCost.push(v.id);
    if (v.min_below_cost) agg.minBelowCost.push(v.id);
    const key = v.manufacturer ?? null;
    let m = manu.get(key);
    if (!m) manu.set(key, (m = { manufacturer: key, products: 0, with_market: 0, idx: 0, idxN: 0, cheapest: 0, margin: 0, marginN: 0 }));
    m.products++;
    if (hasMarket) {
      m.with_market++;
      if (v.position === 'cheapest') m.cheapest++;
      if (v.price_index != null) {
        m.idx += v.price_index;
        m.idxN++;
      }
    }
    if (v.margin_pct != null) {
      m.margin += v.margin_pct;
      m.marginN++;
    }
  }
  const byManufacturer = [...manu.values()]
    .sort((a, b) => b.products - a.products || V.collator.compare(a.manufacturer ?? '', b.manufacturer ?? ''))
    .slice(0, 15)
    .map((m) => ({
      manufacturer: m.manufacturer,
      products: m.products,
      with_market: m.with_market,
      avg_index: avg(m.idx, m.idxN),
      cheapest_pct: m.with_market ? round((m.cheapest / m.with_market) * 100, 1) : null,
      avg_margin_pct: avg(m.margin, m.marginN),
    }));

  return {
    products: { active: cache.active.length, with_market: withMarket, without_market: cache.active.length - withMarket, locked },
    position,
    price_index: { vs_min: avg(idxMin, idxMinN), vs_median: avg(idxMed, idxMedN) },
    proposals: proposalStats(db, cache.settings),
    last_run: lastRun(db),
    last_imports: lastImports(db),
    competitors: competitorsTop(db, cache),
    by_manufacturer: byManufacturer,
    alerts: buildAlerts(db, cache, agg, now),
    generated_at: now.toISOString(),
  };
}

module.exports = {
  register(router) {
    router.get('/api/v1/dashboard', (ctx) => dashboard(ctx.db), { auth: 'read' });
  },
  dashboard,
};
