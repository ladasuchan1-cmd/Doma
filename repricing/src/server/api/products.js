'use strict';
// API: produkty (SPEC §8).
//
//   GET   /api/v1/products          read   ?q, manufacturer, category, owner, supplier, segment (id), position
//                                          (i čárkou oddělený seznam), has_proposal=1, status (active|inactive|all),
//                                          filter (JSON Filter §6.4), sort (libovolné pole View, attrs.X, proposal.*),
//                                          dir, page, limit (max 500)
//                                   → {items: [View + proposal{id, status, new_price, change_pct, manual_price,
//                                       final_price, final_change_pct}|null + segments[id]], total, page, limit}
//   GET   /api/v1/products/facets   read   → {manufacturers, categories, owners, suppliers: [{value, count}], attrs: {klíč: […]}}
//   GET   /api/v1/products/:id      read   → {product, offers, history: {our, competitors}, explain, proposals}
//   PATCH /api/v1/products/:id      admin  {locked?, locked_until?, min_price?, max_price?, note?, price?} → product (View)
//
// Seznam, facety a počty běží nad cache pohledů (_views.js) – 30 000 produktů: studený požadavek ~1 s, teplý ms.

const { tx, nowIso, getSettings, parseJson } = require('../../db');
const { round } = require('../../util/num');
const { loadProducts, loadOffers, explainProduct } = require('../../engine/run');
const { productView, parseDateTime } = require('../../engine/metrics');
const { buildMarket, prepareFilter, EXCLUDE_REASONS } = require('../../engine/market');
const { HttpError, intParam, paging, queryBool } = require('../http');
const V = require('./_views');
const { proposalItems } = require('./proposals');

const POSITIONS = ['cheapest', 'middle', 'most_expensive', 'no_data'];
const PATCH_KEYS = ['locked', 'locked_until', 'min_price', 'max_price', 'note', 'price'];

function listProducts(ctx) {
  const q = ctx.query;
  const status = q.status == null || q.status === '' ? 'active' : String(q.status);
  if (!['active', 'inactive', 'all'].includes(status)) throw new HttpError(400, 'Parametr „status“ musí být active, inactive nebo all.');
  const sort = q.sort == null || q.sort === '' ? 'code' : String(q.sort);
  const dir = q.dir == null || q.dir === '' ? 'asc' : String(q.dir);
  if (dir !== 'asc' && dir !== 'desc') throw new HttpError(400, 'Parametr „dir“ musí být asc nebo desc.');
  const { page, limit, offset } = paging(ctx, { defaultLimit: 50, maxLimit: 500 });
  const { match } = V.parseFilterInput(q.filter);
  let position = null;
  if (q.position != null && q.position !== '') {
    position = String(q.position);
    for (const p of position.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!POSITIONS.includes(p)) throw new HttpError(400, `Neznámá pozice „${p}“ (povoleno: ${POSITIONS.join(', ')}).`);
    }
  }
  const segment = q.segment != null && q.segment !== '' ? V.queryId(q.segment, 'segment') : null;

  const cache = V.getCache(ctx.db);
  if (segment != null && !cache.segments.byId.has(segment)) throw new HttpError(400, `Segment ${segment} neexistuje.`);
  if (!V.isKnownViewField(cache, sort)) throw new HttpError(400, `Nelze řadit podle „${sort}“ – neznámé pole.`);
  const order = V.sortedOrder(cache, sort, dir);
  const idx = V.matchProducts(
    cache,
    {
      status,
      q: q.q,
      manufacturer: q.manufacturer,
      category: q.category,
      owner: q.owner,
      supplier: q.supplier,
      position,
      segment,
      has_proposal: queryBool(ctx, 'has_proposal', false),
      match,
    },
    order
  );
  return {
    items: idx.slice(offset, offset + limit).map((i) => V.productItem(cache, i)),
    total: idx.length,
    page,
    limit,
  };
}

/** Čerstvý pohled na jeden produkt (bez cache – po zápisu). */
function singleView(db, id) {
  const [p] = loadProducts(db, { productIds: [id], activeOnly: false });
  if (!p) return null;
  const offers = loadOffers(db, [id]).get(id) || [];
  return productView(p, offers, { now: new Date(), settings: getSettings(db) });
}

function productDetail(ctx) {
  const db = ctx.db;
  const id = intParam(ctx, 'id');
  const now = new Date();
  const ex = explainProduct(db, id, { now });
  if (!ex) throw new HttpError(404, 'Produkt nenalezen.');
  const settings = getSettings(db);

  // nabídky + důvod vyřazení z výchozího trhu pro metriky (stejný filtr jako productView)
  const engineOffers = loadOffers(db, [id]).get(id) || [];
  const market = buildMarket(engineOffers, prepareFilter({ in_stock_only: !!settings.metrics_in_stock_only }), {
    now,
    maxAgeDays: settings.offer_max_age_days,
  });
  const excluded = new Map(market.excluded.map((e) => [e.offer.competitor_id, e.reason]));
  const nowMs = now.getTime();
  const offers = db
    .prepare(
      `SELECT o.*, c.name AS competitor, c.label, c.enabled AS competitor_enabled, c.tags
       FROM offers o JOIN competitors c ON c.id = o.competitor_id
       WHERE o.product_id = ? ORDER BY o.price, c.name`
    )
    .all(id)
    .map((o) => {
      const reason = excluded.get(o.competitor_id) || null;
      const t = parseDateTime(o.observed_at);
      return {
        ...o,
        competitor_enabled: o.competitor_enabled === 1,
        tags: parseJson(o.tags, []) || [],
        excluded: reason,
        excluded_label: reason ? EXCLUDE_REASONS[reason] || reason : null,
        used: !reason,
        age_days: t == null ? null : round((nowMs - t) / 86400000, 1),
      };
    });

  const our = db
    .prepare('SELECT id, price, source, ref_id, at FROM price_history WHERE product_id = ? ORDER BY at DESC, id DESC LIMIT 200')
    .all(id)
    .map(V.plain)
    .reverse();
  const competitors = db
    .prepare(
      `SELECT h.id, h.competitor_id, c.name AS competitor, c.label, h.price, h.in_stock, h.observed_at
       FROM offer_history h JOIN competitors c ON c.id = h.competitor_id
       WHERE h.product_id = ? ORDER BY h.observed_at DESC, h.id DESC LIMIT 500`
    )
    .all(id)
    .map(V.plain)
    .reverse();

  const propIds = db.prepare('SELECT id FROM proposals WHERE product_id = ? ORDER BY id DESC LIMIT 20').all(id).map((r) => r.id);
  const proposals = proposalItems(db, propIds, { settings });
  const open = proposals.find((p) => p.status === 'pending' || p.status === 'approved') || null;

  return {
    product: {
      ...ex.view,
      proposal: open
        ? { id: open.id, status: open.status, new_price: open.new_price, change_pct: open.change_pct, manual_price: open.manual_price, final_price: open.final_price, final_change_pct: open.final_change_pct }
        : null,
      segments: ex.segments.map((s) => s.id),
    },
    offers,
    history: { our, competitors },
    explain: ex,
    proposals,
  };
}

function patchProduct(ctx) {
  const db = ctx.db;
  const id = intParam(ctx, 'id');
  const body = V.bodyObject(ctx);
  for (const k of Object.keys(body)) {
    if (!PATCH_KEYS.includes(k)) throw new HttpError(400, `Pole „${k}“ nelze měnit (povoleno: ${PATCH_KEYS.join(', ')}).`);
  }
  const cur = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!cur) throw new HttpError(404, 'Produkt nenalezen.');

  const next = {};
  const locked = V.boolInput(body.locked, 'Zámek (locked)');
  if (locked !== undefined) next.locked = locked ? 1 : 0;
  if (body.locked_until !== undefined) {
    if (body.locked_until === null || body.locked_until === '') next.locked_until = null;
    else {
      const t = typeof body.locked_until === 'string' ? parseDateTime(body.locked_until) : null;
      if (t == null) throw new HttpError(400, 'Zamčeno do (locked_until): neplatné datum – použijte ISO formát, např. 2026-12-31T23:59:59Z.');
      next.locked_until = new Date(t).toISOString();
      // „zamknout do“ bez výslovného locked = zamknout (ruční přebití s koncem platnosti)
      if (locked === undefined) next.locked = 1;
    }
  }
  const minPrice = V.numberInput(body.min_price, 'Minimální cena', { nullable: true, positive: true });
  const maxPrice = V.numberInput(body.max_price, 'Maximální cena', { nullable: true, positive: true });
  if (minPrice !== undefined) next.min_price = minPrice == null ? null : round(minPrice, 2);
  if (maxPrice !== undefined) next.max_price = maxPrice == null ? null : round(maxPrice, 2);
  const effMin = next.min_price !== undefined ? next.min_price : cur.min_price;
  const effMax = next.max_price !== undefined ? next.max_price : cur.max_price;
  if (effMin != null && effMax != null && effMin > effMax) throw new HttpError(400, 'Minimální cena nesmí být vyšší než maximální cena.');
  const note = V.textInput(body.note, 'Poznámka', { nullable: true, max: 5000 });
  if (note !== undefined) next.note = note;
  const price = V.numberInput(body.price, 'Cena', { positive: true });
  const now = nowIso();
  let priceChanged = false;
  if (price !== undefined) {
    const p = round(price, 2);
    if (cur.price == null || Math.abs(cur.price - p) >= 0.005) {
      next.price = p;
      next.price_changed_at = now;
      priceChanged = true;
    }
  }

  const changes = {};
  for (const [k, v] of Object.entries(next)) if (cur[k] !== v) changes[k] = { from: cur[k] ?? null, to: v };
  if (Object.keys(changes).length) {
    tx(db, () => {
      const cols = Object.keys(next);
      db.prepare(`UPDATE products SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => next[c]), now, id);
      if (priceChanged) db.prepare("INSERT INTO price_history (product_id, price, source, ref_id, at) VALUES (?, ?, 'manual', NULL, ?)").run(id, next.price, now);
    });
    ctx.audit({ action: 'product.update', entity: 'product', entity_id: id, detail: { code: cur.code, changes } });
    V.invalidate(db, 'views');
  }
  return singleView(db, id);
}

module.exports = {
  register(router) {
    router.get('/api/v1/products', listProducts, { auth: 'read' });
    router.get('/api/v1/products/facets', (ctx) => V.facetsOf(V.getCache(ctx.db)), { auth: 'read' });
    router.get('/api/v1/products/:id', productDetail, { auth: 'read' });
    router.patch('/api/v1/products/:id', patchProduct, { auth: 'admin' });
  },
  listProducts,
};
