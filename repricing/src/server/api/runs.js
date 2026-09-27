'use strict';
// API: běhy přecenění (SPEC §8, engine §6.8).
//
//   POST /api/v1/runs       admin  {product_ids?: number[], dry_run?: bool} → {run_id, stats}
//                                  trigger 'api' při ověření tokenem, jinak 'manual'
//                                  dry_run: true = zkušební přecenění celé sady strategií BEZ ZÁPISU (ani běh, ani návrhy,
//                                  ani audit) → {run_id: null, dry_run: true, stats, sample: [≤ 200 rozhodnutí seřazených
//                                  podle |change_pct| sestupně; rozhodnutí + product {id, code, name, manufacturer, category}]}
//                                  product_ids se rozšíří o aktivní členy cenových skupin (když některá strategie sjednocuje)
//   GET  /api/v1/runs       read   ?page, limit (výchozí 50) → {items: [běh se stats objektem], total, page, limit}
//   GET  /api/v1/runs/:id   read   → běh + proposals: {pending, approved, rejected, exported, superseded}

const { parseJson } = require('../../db');
const { runPricing } = require('../../engine/run');
const { HttpError, intParam, paging, toHttpError } = require('../http');
const V = require('./_views');

const DRY_RUN_SAMPLE = 200;

/** Vzorek zkušebního běhu: rozhodnutí seřazená podle |change_pct| sestupně (bez změny % na konci) + údaje produktu. */
function drySample(db, decisions, limit = DRY_RUN_SAMPLE) {
  const key = (d) => (d.change_pct == null || !Number.isFinite(d.change_pct) ? -1 : Math.abs(d.change_pct));
  const top = decisions
    .map((d, i) => ({ d, i, k: key(d) }))
    .sort((a, b) => b.k - a.k || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.d);
  if (!top.length) return [];
  const rows = db
    .prepare('SELECT id, code, name, manufacturer, category FROM products WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(top.map((d) => d.product_id)));
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  return top.map((d) => ({ ...d, product: byId.get(d.product_id) || { id: d.product_id, code: null, name: null, manufacturer: null, category: null } }));
}

function runItem(row) {
  if (!row) return null;
  const started = Date.parse(row.started_at);
  const finished = row.finished_at ? Date.parse(row.finished_at) : NaN;
  return {
    id: row.id,
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    status: row.status,
    trigger: row.trigger,
    stats: parseJson(row.stats, {}) || {},
    error: row.error ?? null,
    duration_ms: Number.isFinite(started) && Number.isFinite(finished) ? finished - started : null,
  };
}

/** Poslední běh (pro přehled) nebo null. */
function lastRun(db) {
  return runItem(db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get());
}

module.exports = {
  register(router) {
    router.post(
      '/api/v1/runs',
      (ctx) => {
        const body = ctx.bodyType === 'empty' ? {} : V.bodyObject(ctx);
        let productIds;
        if (body.product_ids !== undefined && body.product_ids !== null) {
          productIds = V.idArray(body.product_ids, 'product_ids');
          if (!productIds.length) throw new HttpError(400, 'product_ids: prázdný seznam – vynechte ho pro přecenění všech produktů.');
        }
        for (const k of Object.keys(body)) if (k !== 'product_ids' && k !== 'dry_run') throw new HttpError(400, `Neznámé pole „${k}“ (povoleno: product_ids, dry_run).`);
        const dryRun = V.boolInput(body.dry_run, 'dry_run') === true;
        const trigger = ctx.via === 'token' ? 'api' : 'manual';
        if (dryRun) {
          // zkušební běh: nic se nezapisuje (ani běh, ani audit), cache se nemění
          let res;
          try {
            res = runPricing(ctx.db, { trigger, productIds, dryRun: true });
          } catch (e) {
            const h = toHttpError(e);
            if (h.status !== 500) throw h;
            throw new HttpError(500, `Zkušební přecenění selhalo: ${e.message}`);
          }
          return { run_id: null, dry_run: true, stats: res.stats, sample: drySample(ctx.db, res.decisions || []) };
        }
        let res;
        try {
          res = runPricing(ctx.db, { trigger, productIds });
        } catch (e) {
          V.invalidate(ctx.db, 'proposals');
          // Známé chyby zachovat (zamčená databáze jiným procesem → 503 + Retry-After, chyby vstupu → 4xx);
          // dřív se vše měnilo na 500, takže klient nepoznal, že stačí požadavek zopakovat.
          const h = toHttpError(e);
          if (h.status !== 500) throw h;
          throw new HttpError(500, `Přecenění selhalo: ${e.message}`);
        }
        ctx.audit({ action: 'run.start', entity: 'run', entity_id: res.run_id, detail: { trigger, products: res.stats.products, changes: res.stats.changes, product_ids: productIds ? productIds.slice(0, 100) : undefined } });
        V.invalidate(ctx.db, 'proposals');
        return { run_id: res.run_id, stats: res.stats };
      },
      { auth: 'admin' }
    );

    router.get(
      '/api/v1/runs',
      (ctx) => {
        const { page, limit, offset } = paging(ctx, { defaultLimit: 50, maxLimit: 500 });
        const total = ctx.db.prepare('SELECT count(*) AS c FROM runs').get().c;
        const items = ctx.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset).map(runItem);
        return { items, total, page, limit };
      },
      { auth: 'read' }
    );

    router.get(
      '/api/v1/runs/:id',
      (ctx) => {
        const id = intParam(ctx, 'id');
        const run = runItem(ctx.db.prepare('SELECT * FROM runs WHERE id = ?').get(id));
        if (!run) throw new HttpError(404, 'Běh přecenění nenalezen.');
        const proposals = { pending: 0, approved: 0, rejected: 0, exported: 0, superseded: 0 };
        for (const r of ctx.db.prepare('SELECT status, count(*) AS c FROM proposals WHERE run_id = ? GROUP BY status').all(id)) proposals[r.status] = r.c;
        return { ...run, proposals };
      },
      { auth: 'read' }
    );
  },
  runItem,
  lastRun,
  drySample,
};
