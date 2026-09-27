'use strict';
// API: segmenty (SPEC §8, filtr §6.4).
//
//   GET    /api/v1/segments           read   ?page, limit (výchozí 500) → {items: [segment + count + strategies], total, page, limit}
//   POST   /api/v1/segments           admin  {name, description?, filter, color?} → segment (201)
//   GET    /api/v1/segments/:id       read   → segment + count + strategies
//   PUT    /api/v1/segments/:id       admin  {name?, description?, filter?, color?} (chybějící pole se nemění) → segment
//   DELETE /api/v1/segments/:id       admin  → {ok: true}; používá-li ho strategie → 409 se jmény strategií
//   POST   /api/v1/segments/preview   read   {filter, status?} → {count, sample: View[≤20], errors}
//
// segment = {id, name, description, filter (objekt), color, created_at, updated_at, count (aktivní produkty),
//            error (chyba uloženého filtru | null), strategies: [{id, name, enabled}]}

const { nowIso, parseJson } = require('../../db');
const { fold } = require('../../util/keys');
const { validateFilter, compileFilter } = require('../../engine/filter');
const { HttpError, intParam, paging } = require('../http');
const V = require('./_views');

const KEYS = ['name', 'description', 'filter', 'color'];
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,30}|(rgb|rgba|hsl|hsla)\([0-9.,%\s]+\))$/;

function strategiesBySegment(db) {
  const out = new Map();
  for (const r of db.prepare('SELECT id, name, enabled, segment_id FROM strategies WHERE segment_id IS NOT NULL ORDER BY priority, id').all()) {
    if (!out.has(r.segment_id)) out.set(r.segment_id, []);
    out.get(r.segment_id).push({ id: r.id, name: r.name, enabled: r.enabled === 1 });
  }
  return out;
}

function segmentItem(row, cache, strategies) {
  const g = cache.segments.byId.get(row.id);
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    filter: parseJson(row.filter, {}),
    color: row.color ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    count: cache.segments.counts.get(row.id) ?? 0,
    error: g ? g.error : null,
    strategies: strategies.get(row.id) || [],
  };
}

function getSegment(db, id) {
  const row = db.prepare('SELECT * FROM segments WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'Segment nenalezen.');
  return segmentItem(row, V.getCache(db), strategiesBySegment(db));
}

/** Validace těla segmentu; vrací hodnoty připravené k uložení (jen přítomná pole, při create všechna). */
function validateBody(db, body, { create, id = null }) {
  for (const k of Object.keys(body)) {
    if (!KEYS.includes(k) && !['id', 'count', 'created_at', 'updated_at', 'error', 'strategies'].includes(k)) {
      throw new HttpError(400, `Neznámé pole segmentu „${k}“ (povoleno: ${KEYS.join(', ')}).`);
    }
  }
  const out = {};
  const errors = [];
  if (create || body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) errors.push('Název segmentu je povinný.');
    else if (name.length > 200) errors.push('Název segmentu je příliš dlouhý (max. 200 znaků).');
    else {
      const key = fold(name);
      const dup = db.prepare('SELECT id, name FROM segments WHERE id IS NOT ?').all(id).find((r) => fold(r.name) === key);
      if (dup) throw new HttpError(409, `Segment s názvem „${dup.name}“ už existuje.`);
      out.name = name;
    }
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') errors.push('Popis musí být text.');
    else out.description = body.description == null || !body.description.trim() ? null : body.description.trim().slice(0, 5000);
  }
  if (create || body.filter !== undefined) {
    let f = body.filter === undefined || body.filter === null ? {} : body.filter;
    if (typeof f === 'string') {
      try {
        f = f.trim() ? JSON.parse(f) : {};
      } catch {
        errors.push('Filtr není platný JSON.');
        f = null;
      }
    }
    if (f !== null) {
      const v = validateFilter(f);
      if (!v.ok) errors.push(...v.errors);
      else out.filter = JSON.stringify(f);
    }
  }
  if (body.color !== undefined) {
    if (body.color === null || body.color === '') out.color = null;
    else if (typeof body.color !== 'string' || !COLOR_RE.test(body.color.trim())) errors.push('Barva musí být CSS barva, např. #4a3aa7.');
    else out.color = body.color.trim();
  }
  if (errors.length) throw new HttpError(400, `Neplatný segment: ${errors.join(' ')}`, errors);
  return out;
}

function preview(ctx) {
  const body = V.bodyObject(ctx);
  const status = body.status == null ? 'active' : String(body.status);
  if (!['active', 'inactive', 'all'].includes(status)) throw new HttpError(400, 'Pole „status“ musí být active, inactive nebo all.');
  let f = body.filter ?? {};
  const errors = [];
  if (typeof f === 'string') {
    try {
      f = f.trim() ? JSON.parse(f) : {};
    } catch {
      errors.push('Filtr není platný JSON.');
    }
  }
  let match = null;
  if (!errors.length) {
    const v = validateFilter(f);
    if (!v.ok) errors.push(...v.errors);
    else match = compileFilter(f);
  }
  // Neplatný filtr není chyba požadavku – náhled ho ukáže uživateli (živá kontrola v editoru).
  if (errors.length) return { count: 0, sample: [], errors };
  const cache = V.getCache(ctx.db);
  const idx = V.matchProducts(cache, { status, match }, V.sortedOrder(cache, 'code', 'asc'));
  return { count: idx.length, sample: idx.slice(0, 20).map((i) => ({ ...cache.views[i] })), errors: [] };
}

module.exports = {
  register(router) {
    router.get(
      '/api/v1/segments',
      (ctx) => {
        const { page, limit, offset } = paging(ctx, { defaultLimit: 500, maxLimit: 500 });
        const db = ctx.db;
        const cache = V.getCache(db);
        const strategies = strategiesBySegment(db);
        const all = db
          .prepare('SELECT * FROM segments')
          .all()
          .map((r) => segmentItem(r, cache, strategies))
          .sort((a, b) => V.collator.compare(a.name, b.name) || a.id - b.id);
        return { items: all.slice(offset, offset + limit), total: all.length, page, limit };
      },
      { auth: 'read' }
    );

    router.post('/api/v1/segments/preview', preview, { auth: 'read' });

    router.post(
      '/api/v1/segments',
      (ctx) => {
        const body = V.bodyObject(ctx);
        const v = validateBody(ctx.db, body, { create: true });
        const now = nowIso();
        const id = Number(
          ctx.db
            .prepare('INSERT INTO segments (name, description, filter, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(v.name, v.description ?? null, v.filter ?? '{}', v.color ?? null, now, now).lastInsertRowid
        );
        ctx.audit({ action: 'segment.create', entity: 'segment', entity_id: id, detail: { name: v.name } });
        V.invalidate(ctx.db, 'segments');
        ctx.status = 201;
        return getSegment(ctx.db, id);
      },
      { auth: 'admin' }
    );

    router.get('/api/v1/segments/:id', (ctx) => getSegment(ctx.db, intParam(ctx, 'id')), { auth: 'read' });

    router.put(
      '/api/v1/segments/:id',
      (ctx) => {
        const id = intParam(ctx, 'id');
        const body = V.bodyObject(ctx);
        const cur = ctx.db.prepare('SELECT * FROM segments WHERE id = ?').get(id);
        if (!cur) throw new HttpError(404, 'Segment nenalezen.');
        const v = validateBody(ctx.db, body, { create: false, id });
        const cols = Object.keys(v).filter((k) => v[k] !== cur[k]);
        if (cols.length) {
          const now = nowIso();
          ctx.db.prepare(`UPDATE segments SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => v[c]), now, id);
          ctx.audit({ action: 'segment.update', entity: 'segment', entity_id: id, detail: { name: v.name ?? cur.name, fields: cols } });
          V.invalidate(ctx.db, 'segments');
        }
        return getSegment(ctx.db, id);
      },
      { auth: 'admin' }
    );

    router.delete(
      '/api/v1/segments/:id',
      (ctx) => {
        const id = intParam(ctx, 'id');
        const cur = ctx.db.prepare('SELECT * FROM segments WHERE id = ?').get(id);
        if (!cur) throw new HttpError(404, 'Segment nenalezen.');
        const used = ctx.db.prepare('SELECT id, name FROM strategies WHERE segment_id = ? ORDER BY priority, id').all(id);
        if (used.length) {
          throw new HttpError(
            409,
            `Segment „${cur.name}“ nelze smazat – ${used.length === 1 ? 'používá ho strategie' : 'používají ho strategie'} ${used.map((s) => `„${s.name}“`).join(', ')}. Nejdřív strategii upravte nebo smažte.`,
            { strategies: used.map((s) => ({ id: s.id, name: s.name })) }
          );
        }
        ctx.db.prepare('DELETE FROM segments WHERE id = ?').run(id);
        ctx.audit({ action: 'segment.delete', entity: 'segment', entity_id: id, detail: { name: cur.name } });
        V.invalidate(ctx.db, 'segments');
        return { ok: true };
      },
      { auth: 'admin' }
    );
  },
  segmentItem,
  strategiesBySegment,
};
