'use strict';
// API: návrhy cen (SPEC §8).
//
//   GET   /api/v1/proposals          read   ?status (pending|approved|rejected|exported|superseded|all, i čárkou oddělený
//                                           seznam; výchozí pending), run (id | latest), strategy (id | none),
//                                           segment (id | none – segment ROZHODUJÍCÍ strategie), direction (up|down), flag, q,
//                                           manufacturer, owner, category, supplier (přesná shoda bez ohledu na velikost písmen
//                                           a diakritiku), product_segment (id segmentu, do kterého produkt patří – kterýkoli),
//                                           filter (Filter JSON nad pohledem produktu, SPEC §6.4; neplatný → 400), product (id),
//                                           sort (výchozí abs_change_pct desc), dir, page, limit (max 500)
//                                    → {items: [návrh + product{…} + strategy_name + segment_name + flags[] + explain[]
//                                        + final_price + final_change_pct + final_margin_pct + cheapest_competitor],
//                                       total, page, limit, summary: {pending, approved, exported_today, up, down}}
//                                       + max_id (nejvyšší id návrhu ve filtru) a flagged (kolik z nich má rizikový příznak)
//   POST  /api/v1/proposals/approve  admin  {ids: [] | all: true, filter: {…stejné parametry…}, expect?: {count, max_id},
//                                            include_flagged?: bool} → {updated, skipped_locked, skipped_inactive, skipped_flagged}
//   POST  /api/v1/proposals/reject   admin  totéž → {updated}
//   POST  /api/v1/proposals/unapprove admin {ids | all: true, filter?, expect?} → {updated} – schválené a neexportované
//                                           návrhy zpět do „pending“ (decided_at/decided_by = kdo schválení zrušil,
//                                           údaj o vydání served_* se smaže; přecenění stejný návrh nechá čekat)
//   PATCH /api/v1/proposals/:id      admin  {manual_price: číslo > 0 | null, confirm?: true} → návrh (tvar položky seznamu)
//
// Rozhodnutí:
//  - Cena k exportu = manual_price ?? new_price. Směr (up/down), řazení podle změny a final_* pole počítají
//    s ruční cenou, uložené change_pct/margin_after zůstávají hodnotami navrženými strategií.
//  - Schválit lze jen „pending“; zamítnout „pending“ i „approved“ (tj. ještě neexportované).
//  - Schválení vynechá produkty s platným zámkem (zamčeno po vytvoření návrhu = ruční přebití, cenu neměnit);
//    počet vrací `skipped_locked`. Stejně tak neaktivní produkty (`skipped_inactive`).
//  - „Schválit vše dle filtru“ (all: true) vybírá návrhy až v okamžiku požadavku. Aby se neschválilo něco, co uživatel
//    neviděl (mezitím proběhlo přecenění), klient pošle `expect: {count, max_id}` z výpisu, který zobrazil – když
//    výběr nesedí, vrátí se 409 (money-9). Návrhy s rizikovým příznakem (RISKY_FLAGS – pod nákupem, velká změna,
//    konflikt limitů, ruční cena mimo meze…) hromadné schválení vynechá, pokud není `include_flagged: true`
//    (počet `skipped_flagged`). Výslovně vybraná `ids` se schvalují vždy (uživatel je viděl jednotlivě).
//  - Ruční cena (PATCH, money-7): kontroluje se proti nákupní ceně, min./max. ceně produktu a velikosti změny.
//    Riziková cena bez `confirm: true` → 409 (code MANUAL_PRICE_CONFIRM, details.reasons); s potvrzením se uloží
//    a návrh dostane příznaky (manual, manual_below_cost, below_min, above_max, big_manual_change). Úprava
//    schváleného návrhu ho vrací do stavu „pending“ – upravenou cenu musí někdo znovu schválit (nejde rovnou ven).
//    U zamčeného produktu ruční cenu měnit nelze (409).

const { tx, nowIso, parseJson, getSettings } = require('../../db');
const { round, marginPct, net } = require('../../util/num');
const { BLOCKING_FLAGS } = require('../../engine/pricing');
const { isEmptyFilter } = require('../../engine/filter');
const { MANUAL_FLAGS, CENT } = require('../../util/proposals');
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

/** Příznaky, kvůli kterým hromadné „schválit vše“ návrh vynechá (bez include_flagged). */
const RISKY_FLAGS = Object.freeze([...BLOCKING_FLAGS, 'manual_below_cost', 'below_min', 'above_max', 'big_manual_change', 'previously_rejected']);
const RISKY_SQL = `EXISTS (SELECT 1 FROM json_each(pr.flags) jf WHERE jf.value IN (${RISKY_FLAGS.map((f) => `'${f}'`).join(', ')}))`;

/** Ruční cena se odchyluje od původní o víc než tolik procent → vyžaduje potvrzení. */
const MANUAL_BIG_CHANGE_PCT = 50;

const FROM = `FROM proposals pr
  JOIN products p ON p.id = pr.product_id
  LEFT JOIN strategies s ON s.id = pr.strategy_id
  LEFT JOIN segments g ON g.id = pr.segment_id`;

const FILTER_KEYS = ['status', 'run', 'strategy', 'segment', 'direction', 'flag', 'q', 'manufacturer', 'owner', 'category', 'supplier', 'product_segment', 'filter', 'product'];

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
 * @returns {{statuses: string[]|null, run, strategy, segment, direction, flag, q, manufacturer, owner, category, supplier,
 *   product_segment, filter, match, product}}
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
  for (const k of ['manufacturer', 'owner', 'category', 'supplier']) f[k] = str(src[k]);
  const ps = str(src.product_segment);
  f.product_segment = ps == null ? null : V.queryId(ps, 'product_segment');
  // filtr nad pohledem produktu (JSON text z query nebo objekt z těla) – neplatný → 400
  const raw = Array.isArray(src.filter) ? src.filter[src.filter.length - 1] : src.filter;
  const parsed = V.parseFilterInput(raw === '' ? null : raw, 'filter');
  f.filter = parsed.filter;
  f.match = parsed.filter && !isEmptyFilter(parsed.filter) ? parsed.match : null;
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
  if (f.q != null || f.manufacturer != null || f.owner != null || f.category != null || f.supplier != null || f.product_segment != null || f.match) {
    // hledání bez diakritiky, segment produktu a filtr nad pohledem → přes cache pohledů (stejná logika jako GET /products)
    const c = cache || V.getCache(db);
    const idx = V.matchProducts(c, {
      status: 'all',
      q: f.q,
      manufacturer: f.manufacturer,
      owner: f.owner,
      category: f.category,
      supplier: f.supplier,
      segment: f.product_segment,
      match: f.match || null,
    });
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
    .prepare(
      `SELECT count(*) AS c, COALESCE(SUM(${FINAL} > pr.old_price), 0) AS up, COALESCE(SUM(${FINAL} < pr.old_price), 0) AS down,
              MAX(pr.id) AS max_id, COALESCE(SUM(${RISKY_SQL}), 0) AS flagged ${FROM} ${w.sql}`
    )
    .get(...w.args);
  const base = { total: agg.c, up: agg.up, down: agg.down, max_id: agg.max_id ?? null, flagged: agg.flagged };
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
  // Object.hasOwn: zděděné vlastnosti objektu (constructor, toString, __proto__…) nejsou povolená řazení (security-5)
  if (!Object.hasOwn(SORTS, sort)) throw new HttpError(400, `Neznámé řazení „${sort}“ (povoleno: ${Object.keys(SORTS).join(', ')}).`);
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
 * Změní stav návrhů (approve / reject / unapprove) podle ids nebo filtru.
 * @returns {{updated: number, skipped_locked?: number, skipped_inactive?: number, skipped_flagged?: number, ids: number[]}}
 */
function decide(db, body, action, actor) {
  // unapprove (C5): schválený a dosud neexportovaný návrh zpět ke schválení
  const allowed = action === 'approve' ? ['pending'] : action === 'unapprove' ? ['approved'] : ['pending', 'approved'];
  const target = action === 'approve' ? 'approved' : action === 'unapprove' ? 'pending' : 'rejected';
  const all = body.all === true || body.all === 1 || body.all === '1' || body.all === 'true';
  let candidates;
  let skippedFlagged = 0;
  if (all) {
    const src = body.filter == null ? {} : body.filter;
    if (!V.isPlainObject(src)) throw new HttpError(400, 'Pole „filter“ musí být objekt se stejnými parametry jako GET /proposals.');
    for (const k of Object.keys(src)) {
      if (!FILTER_KEYS.includes(k) && !['sort', 'dir', 'page', 'limit'].includes(k)) throw new HttpError(400, `Neznámý parametr filtru „${k}“.`);
    }
    const f = normalizeFilter(src, { defaultStatus: null });
    // jen stavy, které akce smí měnit (průnik s filtrem)
    f.statuses = f.statuses ? f.statuses.filter((s) => allowed.includes(s)) : allowed;
    if (!f.statuses.length) return { updated: 0, ids: [] };
    const sel = selectIds(db, f, { sort: 'id', dir: 'asc' });
    candidates = sel.ids;
    // Výběr se od zobrazeného seznamu liší (mezitím proběhlo přecenění / jiný uživatel) → nic neměnit
    if (body.expect != null) {
      if (!V.isPlainObject(body.expect)) throw new HttpError(400, 'Pole „expect“ musí být objekt {count, max_id}.');
      const count = body.expect.count == null ? null : Number(body.expect.count);
      const maxId = body.expect.max_id == null ? null : Number(body.expect.max_id);
      const cur = candidates.length ? Math.max(...candidates) : null;
      if ((count != null && count !== candidates.length) || (maxId != null && cur != null && cur > maxId)) {
        throw new HttpError(409, 'Seznam návrhů se mezitím změnil (nové přecenění nebo jiný uživatel) – obnovte stránku a zkontrolujte ho.', {
          code: 'PROPOSALS_CHANGED',
          expected: { count, max_id: maxId },
          actual: { count: candidates.length, max_id: cur },
        });
      }
    }
    if (action === 'approve' && !(body.include_flagged === true || body.include_flagged === 1 || body.include_flagged === '1' || body.include_flagged === 'true')) {
      // rizikové návrhy hromadně neschvalovat – jen po jednom (nebo s výslovným include_flagged)
      const flagged = new Set();
      for (let i = 0; i < candidates.length; i += 20000) {
        for (const r of db
          .prepare(`SELECT pr.id FROM proposals pr WHERE pr.id IN (SELECT value FROM json_each(?)) AND ${RISKY_SQL}`)
          .all(JSON.stringify(candidates.slice(i, i + 20000)))) {
          flagged.add(r.id);
        }
      }
      skippedFlagged = flagged.size;
      if (flagged.size) candidates = candidates.filter((id) => !flagged.has(id));
    }
  } else if (body.ids !== undefined) {
    candidates = V.idArray(body.ids, 'ids');
  } else {
    throw new HttpError(400, 'Zadejte „ids“ (pole id návrhů) nebo „all: true“ s filtrem.');
  }
  const withSkips = (o) => (action === 'approve' ? { skipped_locked: 0, skipped_inactive: 0, skipped_flagged: skippedFlagged, ...o } : o);
  if (!candidates.length) return withSkips({ updated: 0, ids: [] });

  const now = nowIso();
  return tx(db, () => {
    const rows = db
      .prepare(
        `SELECT pr.id, p.locked, p.locked_until, p.active FROM proposals pr JOIN products p ON p.id = pr.product_id
         WHERE pr.id IN (SELECT value FROM json_each(?)) AND pr.status IN (${allowed.map(() => '?').join(', ')})`
      )
      .all(JSON.stringify(candidates), ...allowed);
    let skippedLocked = 0;
    let skippedInactive = 0;
    const ids = [];
    for (const r of rows) {
      if (action === 'approve' && isLockActive(r, now)) {
        skippedLocked++;
        continue;
      }
      if (action === 'approve' && !r.active) {
        // neaktivní produkt se neexportuje – schválený návrh by „čekal“ na reaktivaci a pak odešel se starou cenou
        skippedInactive++;
        continue;
      }
      ids.push(r.id);
    }
    let updated = 0;
    // Zrušení schválení (C5): návrh zpět do „pending“; decided_at / decided_by = kdo a kdy schválení zrušil (lidské
    // rozhodnutí – další přecenění stejný návrh ponechá čekat a znovu ho automaticky neschválí). Údaj o vydání
    // (served_*) se smaže – admin návrh nesmí převzít, dokud ho někdo znovu neschválí (potvrzení podle kódu ho neoznačí).
    const upd =
      action === 'unapprove'
        ? db.prepare(
            `UPDATE proposals SET status = ?, decided_at = ?, decided_by = ?, served_price = NULL, served_at = NULL
             WHERE id IN (SELECT value FROM json_each(?)) AND status IN (${allowed.map(() => '?').join(', ')}) AND exported_at IS NULL`
          )
        : db.prepare(
            `UPDATE proposals SET status = ?, decided_at = ?, decided_by = ?
             WHERE id IN (SELECT value FROM json_each(?)) AND status IN (${allowed.map(() => '?').join(', ')})`
          );
    for (let i = 0; i < ids.length; i += 5000) {
      const chunk = JSON.stringify(ids.slice(i, i + 5000));
      updated += Number(upd.run(target, now, actor, chunk, ...allowed).changes);
    }
    return withSkips({ updated, ids, skipped_locked: skippedLocked, skipped_inactive: skippedInactive });
  });
}

/**
 * Riziko ruční ceny proti aktuálnímu stavu produktu.
 * @returns {{flags: string[], reasons: string[]}} flags = příznaky k uložení, reasons = české popisy (vyžadují potvrzení)
 */
function manualPriceRisks(price, row, settings) {
  const flags = ['manual'];
  const reasons = [];
  const vat = row.vat_rate ?? settings.vat_rate_default ?? 21;
  const fmt = (v) => `${round(v, 2).toLocaleString('cs-CZ')} Kč`;
  if (row.purchase_price > 0 && net(price, vat) < row.purchase_price - CENT) {
    flags.push('manual_below_cost');
    reasons.push(`cena bez DPH ${fmt(net(price, vat))} je pod nákupní cenou ${fmt(row.purchase_price)}`);
  }
  if (row.min_price != null && price < row.min_price - CENT) {
    flags.push('below_min');
    reasons.push(`cena je pod minimální cenou produktu ${fmt(row.min_price)}`);
  }
  if (row.max_price != null && price > row.max_price + CENT) {
    flags.push('above_max');
    reasons.push(`cena je nad maximální cenou produktu ${fmt(row.max_price)}`);
  }
  const base = row.old_price > 0 ? row.old_price : row.current_price > 0 ? row.current_price : null;
  if (base && Math.abs(price / base - 1) * 100 > MANUAL_BIG_CHANGE_PCT) {
    flags.push('big_manual_change');
    reasons.push(`cena se mění o ${round((price / base - 1) * 100, 1).toLocaleString('cs-CZ')} % oproti ${fmt(base)}`);
  }
  return { flags, reasons };
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
          // pro „schválit vše“: klient pošle expect {count: total, max_id} a ví, kolik rizikových se vynechá
          max_id: res.max_id ?? null,
          flagged: res.flagged ?? 0,
          summary: summaryCounts(ctx.db, up, down),
        };
      },
      { auth: 'read' }
    );

    for (const action of ['approve', 'reject', 'unapprove']) {
      router.post(
        `/api/v1/proposals/${action}`,
        (ctx) => {
          const body = V.bodyObject(ctx);
          const res = decide(ctx.db, body, action, ctx.user);
          if (res.updated) {
            ctx.audit({
              action: `proposals.${action}`,
              entity: 'proposal',
              detail: {
                count: res.updated,
                ids: res.ids.slice(0, 1000),
                all: !!body.all,
                filter: body.all ? body.filter ?? null : undefined,
                skipped_locked: res.skipped_locked,
                skipped_inactive: res.skipped_inactive,
                skipped_flagged: res.skipped_flagged,
              },
            });
            V.invalidate(ctx.db, 'proposals');
          }
          const out = { updated: res.updated };
          if (action === 'approve') {
            out.skipped_locked = res.skipped_locked || 0;
            out.skipped_inactive = res.skipped_inactive || 0;
            out.skipped_flagged = res.skipped_flagged || 0;
          }
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
        for (const k of Object.keys(body)) {
          if (k !== 'manual_price' && k !== 'confirm') throw new HttpError(400, `Pole „${k}“ nelze měnit – upravit lze jen manual_price (s volitelným confirm).`);
        }
        const confirm = body.confirm === true || body.confirm === 1 || body.confirm === '1' || body.confirm === 'true';
        const price = V.numberInput(body.manual_price, 'Ruční cena', { nullable: true, positive: true });
        const value = price == null ? null : round(price, 2);
        const db = ctx.db;
        const row = db
          .prepare(
            `SELECT pr.id, pr.status, pr.manual_price, pr.old_price, pr.new_price, pr.flags, p.price AS current_price, p.purchase_price,
                    p.vat_rate, p.min_price, p.max_price, p.locked, p.locked_until
             FROM proposals pr JOIN products p ON p.id = pr.product_id WHERE pr.id = ?`
          )
          .get(id);
        if (!row) throw new HttpError(404, 'Návrh nenalezen.');
        if (row.status !== 'pending' && row.status !== 'approved') {
          throw new HttpError(409, `Návrh ve stavu „${row.status}“ už nelze upravit (jen čekající nebo schválený).`);
        }
        const now = nowIso();
        if (isLockActive(row, now)) throw new HttpError(409, 'Cena produktu je zamčená – ruční cenu návrhu nelze měnit. Nejdřív produkt odemkněte.', { code: 'PRODUCT_LOCKED' });
        const engineFlags = (parseJson(row.flags, []) || []).filter((f) => !MANUAL_FLAGS.includes(f));
        let flags = engineFlags;
        if (value != null) {
          const risk = manualPriceRisks(value, row, getSettings(db));
          if (risk.reasons.length && !confirm) {
            throw new HttpError(409, `Ruční cena ${value.toLocaleString('cs-CZ')} Kč vyžaduje potvrzení: ${risk.reasons.join('; ')}.`, {
              code: 'MANUAL_PRICE_CONFIRM',
              reasons: risk.reasons,
              flags: risk.flags,
            });
          }
          flags = [...engineFlags, ...risk.flags];
        }
        // Změna ceny schváleného návrhu = nové rozhodnutí → zpět ke schválení (nesmí odejít ven bez druhého pohledu)
        const reopen = row.status === 'approved' && !(value == null ? row.manual_price == null : row.manual_price != null && Math.abs(row.manual_price - value) < CENT);
        tx(db, () => {
          db.prepare(
            `UPDATE proposals SET manual_price = ?, flags = ?${reopen ? ", status = 'pending', decided_at = NULL, decided_by = NULL" : ''} WHERE id = ?`
          ).run(value, JSON.stringify(flags), id);
        });
        ctx.audit({
          action: 'proposal.manual_price',
          entity: 'proposal',
          entity_id: id,
          detail: { from: row.manual_price, to: value, confirmed: confirm || undefined, reopened: reopen || undefined },
        });
        V.invalidate(db, 'proposals');
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
  RISKY_FLAGS,
  FILTER_KEYS,
  LIMITS,
};
