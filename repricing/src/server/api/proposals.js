'use strict';
// API: návrhy cen (SPEC §8).
//
//   GET   /api/v1/proposals          read   ?status (pending|approved|rejected|exported|superseded|all, i čárkou oddělený
//                                           seznam; výchozí pending), run (id | latest), strategy (id | none),
//                                           segment (id | none), direction (up|down), flag, q, manufacturer, product (id),
//                                           sort (výchozí abs_change_pct desc), dir, page, limit (max 500)
//                                    → {items: [návrh + product{…} + strategy_name + segment_name + flags[] + explain[]
//                                        + final_price + final_change_pct + final_margin_pct + cheapest_competitor],
//                                       total, page, limit, summary: {pending, approved, exported_today, up, down}}
//   POST  /api/v1/proposals/approve  admin  {ids: [] | all: true, filter: {…stejné parametry…}} → {updated, skipped_locked}
//   POST  /api/v1/proposals/reject   admin  totéž → {updated}
//   PATCH /api/v1/proposals/:id      admin  {manual_price: číslo > 0 | null} → návrh (tvar položky seznamu)
//
// Rozhodnutí:
//  - Cena k exportu = manual_price ?? new_price. Směr (up/down), řazení podle změny a final_* pole počítají
//    s ruční cenou, uložené change_pct/margin_after zůstávají hodnotami navrženými strategií.
//  - Schválit lze jen „pending“; zamítnout „pending“ i „approved“ (tj. ještě neexportované).
//  - Schválení vynechá produkty s platným zámkem (zamčeno po vytvoření návrhu = ruční přebití, cenu neměnit);
//    počet vrací `skipped_locked`.

const { tx, nowIso, parseJson, getSettings } = require('../../db');
const { round, marginPct } = require('../../util/num');
const { isLockActive, pragueParts, parseDateTime } = require('../../engine/metrics');
const { HttpError, intParam, paging } = require('../http');
const V = require('./_views');

const FINAL = 'COALESCE(pr.manual_price, pr.new_price)';
const FINAL_PCT = `(CASE WHEN pr.manual_price IS NOT NULL AND pr.old_price > 0
  THEN ROUND((pr.manual_price - pr.old_price) * 100.0 / pr.old_price, 2) ELSE pr.change_pct END)`;

/** Povolená řazení (klíč → SQL výraz). */
const SORTS = {
  abs_change_pct: `ABS(${FINAL_PCT})`,
  change_pct: FINAL_PCT,
  change_abs: `(${FINAL} - pr.old_price)`,
  new_price: 'pr.new_price',
  final_price: FINAL,
  manual_price: 'pr.manual_price',
  old_price: 'pr.old_price',
  target_price: 'pr.target_price',
  margin_before: 'pr.margin_before',
  margin_after: 'pr.margin_after',
  market_min: 'pr.market_min',
  competitor_count: 'pr.competitor_count',
  rank_before: 'pr.rank_before',
  rank_after: 'pr.rank_after',
  created_at: 'pr.created_at',
  decided_at: 'pr.decided_at',
  exported_at: 'pr.exported_at',
  id: 'pr.id',
  run_id: 'pr.run_id',
  status: 'pr.status',
  code: 'p.code',
  name: 'p.name',
  manufacturer: 'p.manufacturer',
  category: 'p.category',
  stock: 'p.stock',
  strategy_name: 's.name',
  segment_name: 'g.name',
};
SORTS.strategy = SORTS.strategy_name;
SORTS.segment = SORTS.segment_name;

const FROM = `FROM proposals pr
  JOIN products p ON p.id = pr.product_id
  LEFT JOIN strategies s ON s.id = pr.strategy_id
  LEFT JOIN segments g ON g.id = pr.segment_id`;

const FILTER_KEYS = ['status', 'run', 'strategy', 'segment', 'direction', 'flag', 'q', 'manufacturer', 'product'];

function str(v) {
  if (v == null) return null;
  if (Array.isArray(v)) v = v[v.length - 1];
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Normalizuje filtr návrhů (z query nebo z body.filter) a ověří hodnoty.
 * @param {object} src
 * @param {{defaultStatus?: string|null}} [opts]
 * @returns {{statuses: string[]|null, run, strategy, segment, direction, flag, q, manufacturer, product}}
 */
function normalizeFilter(src = {}, { defaultStatus = 'pending' } = {}) {
  if (!V.isPlainObject(src)) throw new HttpError(400, 'Filtr návrhů musí být objekt.');
  const f = {};
  const status = str(src.status) ?? defaultStatus;
  if (status == null || status === 'all') f.statuses = null;
  else {
    f.statuses = [...new Set(status.split(',').map((x) => x.trim()).filter(Boolean))];
    for (const x of f.statuses) {
      if (!V.PROPOSAL_STATUSES.includes(x)) throw new HttpError(400, `Neznámý stav návrhu „${x}“ (povoleno: ${V.PROPOSAL_STATUSES.join(', ')}, all).`);
    }
  }
  const run = str(src.run);
  f.run = run == null ? null : run === 'latest' ? 'latest' : V.queryId(run, 'run');
  for (const k of ['strategy', 'segment']) {
    const v = str(src[k]);
    f[k] = v == null ? null : v === 'none' ? 'none' : V.queryId(v, k);
  }
  const dir = str(src.direction);
  if (dir != null && dir !== 'up' && dir !== 'down') throw new HttpError(400, 'Parametr „direction“ musí být up nebo down.');
  f.direction = dir;
  const flag = str(src.flag);
  if (flag != null && !/^[a-z0-9_]{1,64}$/i.test(flag)) throw new HttpError(400, 'Neplatný příznak v parametru „flag“.');
  f.flag = flag;
  f.q = str(src.q);
  f.manufacturer = str(src.manufacturer);
  const product = str(src.product);
  f.product = product == null ? null : V.queryId(product, 'product');
  return f;
}

/** WHERE podmínka a argumenty pro normalizovaný filtr. */
function whereOf(db, f, cache) {
  const where = [];
  const args = [];
  if (f.statuses) {
    where.push(`pr.status IN (${f.statuses.map(() => '?').join(', ')})`);
    args.push(...f.statuses);
  }
  if (f.run === 'latest') where.push("pr.run_id = (SELECT MAX(id) FROM runs WHERE status = 'done')");
  else if (f.run != null) {
    where.push('pr.run_id = ?');
    args.push(f.run);
  }
  for (const [k, col] of [
    ['strategy', 'pr.strategy_id'],
    ['segment', 'pr.segment_id'],
  ]) {
    if (f[k] === 'none') where.push(`${col} IS NULL`);
    else if (f[k] != null) {
      where.push(`${col} = ?`);
      args.push(f[k]);
    }
  }
  if (f.direction === 'up') where.push(`${FINAL} > pr.old_price`);
  if (f.direction === 'down') where.push(`${FINAL} < pr.old_price`);
  if (f.flag) {
    where.push('EXISTS (SELECT 1 FROM json_each(pr.flags) jf WHERE jf.value = ?)');
    args.push(f.flag);
  }
  if (f.product != null) {
    where.push('pr.product_id = ?');
    args.push(f.product);
  }
  if (f.q != null || f.manufacturer != null) {
    // hledání bez diakritiky → přes cache pohledů (stejná logika jako GET /products)
    const c = cache || V.getCache(db);
    const idx = V.matchProducts(c, { status: 'all', q: f.q, manufacturer: f.manufacturer });
    where.push('pr.product_id IN (SELECT value FROM json_each(?))');
    args.push(JSON.stringify(idx.map((i) => c.views[i].id)));
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

// Do LIMITS.jsSortMax návrhů se řadí v JS (česká kolace textů, čísla číselně); nad tím SQL ORDER BY + LIMIT
// (texty bez ohledu na velikost písmen, diakritika ale binárně) – ochrana paměti při status=all nad miliony návrhů.
const LIMITS = { jsSortMax: 60000 };
const TEXT_SORTS = new Set(['status', 'code', 'name', 'manufacturer', 'category', 'strategy_name', 'segment_name', 'strategy', 'segment', 'created_at', 'decided_at', 'exported_at']);

/**
 * Id návrhů odpovídajících filtru (seřazená) + počet a souhrn směrů.
 * @param {{sort?: string, dir?: 'asc'|'desc', cache?: object, offset?: number, limit?: number|null, maxAll?: number}} [opts]
 *   limit null = všechna id (schvalování „vše dle filtru“, XLSX); maxAll = při větším počtu vrátit jen počty (tooMany)
 * @returns {{ids: number[], total: number, up: number, down: number, paged?: boolean, tooMany?: boolean}}
 */
function selectIds(db, f, { sort = 'abs_change_pct', dir = 'desc', cache, offset = 0, limit = null, maxAll = Infinity } = {}) {
  const w = whereOf(db, f, cache);
  const expr = SORTS[sort];
  const agg = db
    .prepare(`SELECT count(*) AS c, COALESCE(SUM(${FINAL} > pr.old_price), 0) AS up, COALESCE(SUM(${FINAL} < pr.old_price), 0) AS down ${FROM} ${w.sql}`)
    .get(...w.args);
  const base = { total: agg.c, up: agg.up, down: agg.down };
  if (!agg.c) return { ids: [], ...base };
  if (limit == null && agg.c > maxAll) return { ids: [], ...base, tooMany: true };
  if (agg.c > LIMITS.jsSortMax && limit != null) {
    const coll = TEXT_SORTS.has(sort) ? ' COLLATE NOCASE' : '';
    const d = dir === 'desc' ? 'DESC' : 'ASC';
    const rows = db
      .prepare(`SELECT pr.id AS id ${FROM} ${w.sql} ORDER BY (${expr}) IS NULL, (${expr})${coll} ${d}, pr.id DESC LIMIT ? OFFSET ?`)
      .all(...w.args, limit, offset);
    return { ids: rows.map((r) => r.id), ...base, paged: true };
  }
  const rows = db.prepare(`SELECT pr.id AS id, ${expr} AS k ${FROM} ${w.sql} ORDER BY pr.id DESC`).all(...w.args);
  const order = V.sortIndices(
    rows.map((_, i) => i),
    (i) => rows[i].k,
    dir
  );
  return { ids: order.map((i) => rows[i].id), ...base };
}

/**
 * Plné položky návrhů pro daná id (ve stejném pořadí).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]} ids
 * @param {{cache?: object, settings?: object}} [opts]
 */
function proposalItems(db, ids, opts = {}) {
  if (!ids.length) return [];
  const settings = opts.settings || getSettings(db);
  const rows = db
    .prepare(
      `SELECT pr.*, p.code, p.name, p.ean, p.manufacturer, p.category, p.stock, p.purchase_price, p.price AS current_price,
              p.vat_rate, p.active, s.name AS strategy_name, g.name AS segment_name
       ${FROM} WHERE pr.id IN (SELECT value FROM json_each(?))`
    )
    .all(JSON.stringify(ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const cache = opts.cache || null;
  const out = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (r) out.push(toItem(r, cache, settings));
  }
  return out;
}

function toItem(r, cache, settings) {
  const final = r.manual_price ?? r.new_price;
  const vat = r.vat_rate ?? settings.vat_rate_default ?? 21;
  const finalPct = r.manual_price != null && r.old_price > 0 ? round(((final - r.old_price) / r.old_price) * 100, 2) : r.change_pct;
  let cheapest = null;
  if (cache) {
    const i = cache.byId.get(r.product_id);
    if (i !== undefined) cheapest = cache.views[i].cheapest_competitor ?? null;
  }
  return {
    id: r.id,
    run_id: r.run_id,
    product_id: r.product_id,
    strategy_id: r.strategy_id,
    segment_id: r.segment_id,
    old_price: r.old_price,
    new_price: r.new_price,
    target_price: r.target_price,
    reference_price: r.reference_price,
    market_min: r.market_min,
    competitor_count: r.competitor_count,
    rank_before: r.rank_before,
    rank_after: r.rank_after,
    margin_before: r.margin_before,
    margin_after: r.margin_after,
    change_abs: r.change_abs,
    change_pct: r.change_pct,
    status: r.status,
    flags: parseJson(r.flags, []) || [],
    explain: parseJson(r.explain, []) || [],
    manual_price: r.manual_price,
    created_at: r.created_at,
    decided_at: r.decided_at,
    decided_by: r.decided_by,
    exported_at: r.exported_at,
    export_id: r.export_id,
    product: {
      id: r.product_id,
      code: r.code,
      name: r.name,
      ean: r.ean,
      manufacturer: r.manufacturer,
      category: r.category,
      stock: r.stock,
      purchase_price: r.purchase_price,
      price: r.current_price,
      vat_rate: r.vat_rate,
      active: r.active,
    },
    strategy_name: r.strategy_name ?? null,
    segment_name: r.segment_name ?? null,
    final_price: final,
    final_change_pct: finalPct,
    final_margin_pct: r.manual_price != null ? marginPct(final, r.purchase_price > 0 ? r.purchase_price : null, vat) : r.margin_after,
    cheapest_competitor: cheapest,
  };
}

/** Začátek dnešního dne v Praze jako ISO UTC. */
function pragueTodayStartIso(now = new Date()) {
  const p = pragueParts(now);
  const pad = (n) => String(n).padStart(2, '0');
  return new Date(parseDateTime(`${p.year}-${pad(p.month)}-${pad(p.day)}`)).toISOString();
}

function sortParams(query) {
  const sort = str(query.sort) || 'abs_change_pct';
  if (!SORTS[sort]) throw new HttpError(400, `Neznámé řazení „${sort}“ (povoleno: ${Object.keys(SORTS).join(', ')}).`);
  const d = str(query.dir);
  if (d != null && d !== 'asc' && d !== 'desc') throw new HttpError(400, 'Parametr „dir“ musí být asc nebo desc.');
  const dir = d || (str(query.sort) ? 'asc' : 'desc');
  return { sort, dir };
}

/**
 * Seznam návrhů podle query (sdílí GET /proposals a GET /export/proposals.xlsx).
 * @param {{offset?: number, limit?: number|null, maxAll?: number}} [page] stránka (limit null = všechna id)
 * @returns {{ids: number[], total: number, up: number, down: number, paged?: boolean, cache: object}}
 */
function listIds(db, query, page = {}) {
  const f = normalizeFilter(query);
  const { sort, dir } = sortParams(query);
  const cache = V.getCache(db);
  return { ...selectIds(db, f, { sort, dir, cache, offset: page.offset ?? 0, limit: page.limit ?? null, maxAll: page.maxAll }), cache };
}

function summaryCounts(db, up, down) {
  const counts = { pending: 0, approved: 0 };
  for (const r of db.prepare("SELECT status, count(*) AS c FROM proposals WHERE status IN ('pending', 'approved') GROUP BY status").all()) counts[r.status] = r.c;
  const exportedToday = db.prepare("SELECT count(*) AS c FROM proposals WHERE status = 'exported' AND exported_at >= ?").get(pragueTodayStartIso()).c;
  return { pending: counts.pending, approved: counts.approved, exported_today: exportedToday, up, down };
}

/**
 * Změní stav návrhů (approve/reject) podle ids nebo filtru.
 * @returns {{updated: number, skipped_locked?: number, ids: number[]}}
 */
function decide(db, body, action, actor) {
  const allowed = action === 'approve' ? ['pending'] : ['pending', 'approved'];
  const target = action === 'approve' ? 'approved' : 'rejected';
  let candidates;
  if (body.all === true || body.all === 1 || body.all === '1' || body.all === 'true') {
    const src = body.filter == null ? {} : body.filter;
    if (!V.isPlainObject(src)) throw new HttpError(400, 'Pole „filter“ musí být objekt se stejnými parametry jako GET /proposals.');
    for (const k of Object.keys(src)) {
      if (!FILTER_KEYS.includes(k) && !['sort', 'dir', 'page', 'limit'].includes(k)) throw new HttpError(400, `Neznámý parametr filtru „${k}“.`);
    }
    const f = normalizeFilter(src, { defaultStatus: null });
    // jen stavy, které akce smí měnit (průnik s filtrem)
    f.statuses = f.statuses ? f.statuses.filter((s) => allowed.includes(s)) : allowed;
    if (!f.statuses.length) return { updated: 0, ids: [] };
    candidates = selectIds(db, f, { sort: 'id', dir: 'asc' }).ids;
  } else if (body.ids !== undefined) {
    candidates = V.idArray(body.ids, 'ids');
  } else {
    throw new HttpError(400, 'Zadejte „ids“ (pole id návrhů) nebo „all: true“ s filtrem.');
  }
  if (!candidates.length) return { updated: 0, ids: [] };

  const now = nowIso();
  return tx(db, () => {
    const rows = db
      .prepare(
        `SELECT pr.id, p.locked, p.locked_until FROM proposals pr JOIN products p ON p.id = pr.product_id
         WHERE pr.id IN (SELECT value FROM json_each(?)) AND pr.status IN (${allowed.map(() => '?').join(', ')})`
      )
      .all(JSON.stringify(candidates), ...allowed);
    let skippedLocked = 0;
    const ids = [];
    for (const r of rows) {
      if (action === 'approve' && isLockActive(r, now)) {
        skippedLocked++;
        continue;
      }
      ids.push(r.id);
    }
    let updated = 0;
    const upd = db.prepare(
      `UPDATE proposals SET status = ?, decided_at = ?, decided_by = ?
       WHERE id IN (SELECT value FROM json_each(?)) AND status IN (${allowed.map(() => '?').join(', ')})`
    );
    for (let i = 0; i < ids.length; i += 5000) {
      updated += Number(upd.run(target, now, actor, JSON.stringify(ids.slice(i, i + 5000)), ...allowed).changes);
    }
    const out = { updated, ids };
    if (action === 'approve') out.skipped_locked = skippedLocked;
    return out;
  });
}

module.exports = {
  register(router) {
    router.get(
      '/api/v1/proposals',
      (ctx) => {
        const { page, limit, offset } = paging(ctx, { defaultLimit: 50, maxLimit: 500 });
        const res = listIds(ctx.db, ctx.query, { offset, limit });
        const { up, down, cache } = res;
        const pageIds = res.paged ? res.ids : res.ids.slice(offset, offset + limit);
        return {
          items: proposalItems(ctx.db, pageIds, { cache }),
          total: res.total,
          page,
          limit,
          summary: summaryCounts(ctx.db, up, down),
        };
      },
      { auth: 'read' }
    );

    for (const action of ['approve', 'reject']) {
      router.post(
        `/api/v1/proposals/${action}`,
        (ctx) => {
          const body = V.bodyObject(ctx);
          const res = decide(ctx.db, body, action, ctx.user);
          if (res.updated) {
            ctx.audit({
              action: `proposals.${action}`,
              entity: 'proposal',
              detail: { count: res.updated, ids: res.ids.slice(0, 1000), all: !!body.all, filter: body.all ? body.filter ?? null : undefined, skipped_locked: res.skipped_locked },
            });
            V.invalidate(ctx.db, 'proposals');
          }
          const out = { updated: res.updated };
          if (action === 'approve') out.skipped_locked = res.skipped_locked || 0;
          return out;
        },
        { auth: 'admin' }
      );
    }

    router.patch(
      '/api/v1/proposals/:id',
      (ctx) => {
        const id = intParam(ctx, 'id');
        const body = V.bodyObject(ctx);
        if (!Object.prototype.hasOwnProperty.call(body, 'manual_price')) throw new HttpError(400, 'Zadejte „manual_price“ (kladné číslo, null ruší ruční cenu).');
        for (const k of Object.keys(body)) if (k !== 'manual_price') throw new HttpError(400, `Pole „${k}“ nelze měnit – upravit lze jen manual_price.`);
        const price = V.numberInput(body.manual_price, 'Ruční cena', { nullable: true, positive: true });
        const row = ctx.db.prepare('SELECT id, status, manual_price FROM proposals WHERE id = ?').get(id);
        if (!row) throw new HttpError(404, 'Návrh nenalezen.');
        if (row.status !== 'pending' && row.status !== 'approved') {
          throw new HttpError(409, `Návrh ve stavu „${row.status}“ už nelze upravit (jen čekající nebo schválený).`);
        }
        ctx.db.prepare('UPDATE proposals SET manual_price = ? WHERE id = ?').run(price == null ? null : round(price, 2), id);
        ctx.audit({ action: 'proposal.manual_price', entity: 'proposal', entity_id: id, detail: { from: row.manual_price, to: price == null ? null : round(price, 2) } });
        V.invalidate(ctx.db, 'proposals');
        return proposalItems(ctx.db, [id], { cache: V.getCache(ctx.db) })[0];
      },
      { auth: 'admin' }
    );
  },
  // sdílené s exports.js / products.js
  normalizeFilter,
  selectIds,
  listIds,
  proposalItems,
  pragueTodayStartIso,
  SORTS,
  FILTER_KEYS,
  LIMITS,
};
