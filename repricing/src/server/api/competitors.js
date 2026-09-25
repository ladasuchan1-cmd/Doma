'use strict';
// API: konkurenti (SPEC §8).
//
//   GET   /api/v1/competitors      read   → {items: [{id, name, label, enabled, tags, note, created_at, offers,
//                                            products_cheaper_than_us, cheaper_than_us_pct, avg_index, last_seen_at}], total}
//   PATCH /api/v1/competitors/:id  admin  {label?, enabled?, tags?, note?} → konkurent (stejný tvar jako položka)
//
// Statistiky (z cache pohledů): offers = počet všech nabídek konkurenta; products_cheaper_than_us / avg_index jen
// vůči aktivním produktům s kladnou cenou (jejich cena bez dopravy / naše cena × 100).

const { parseJson } = require('../../db');
const { HttpError, intParam } = require('../http');
const V = require('./_views');

const PATCH_KEYS = ['label', 'enabled', 'tags', 'note'];

function competitorItem(row, stats) {
  const s = stats.get(row.id) || null;
  return {
    id: row.id,
    name: row.name,
    label: row.label ?? null,
    enabled: row.enabled === 1,
    tags: parseJson(row.tags, []) || [],
    note: row.note ?? null,
    created_at: row.created_at,
    offers: s ? s.offers : 0,
    products_cheaper_than_us: s ? s.products_cheaper_than_us : 0,
    cheaper_than_us_pct: s ? s.cheaper_than_us_pct : null,
    avg_index: s ? s.avg_index : null,
    last_seen_at: s ? s.last_seen_at : null,
  };
}

function listCompetitors(db) {
  const cache = V.getCache(db);
  const rows = db.prepare('SELECT * FROM competitors').all();
  const items = rows.map((r) => competitorItem(r, cache.competitorStats));
  items.sort((a, b) => V.collator.compare(a.label || a.name, b.label || b.name) || a.id - b.id);
  return items;
}

function parseTags(v) {
  if (v === null) return [];
  let list = v;
  if (typeof v === 'string') list = v.split(',');
  if (!Array.isArray(list)) throw new HttpError(400, 'Štítky (tags) musí být pole textů.');
  const out = [];
  for (const t of list) {
    if (t == null) continue;
    if (typeof t !== 'string' && typeof t !== 'number') throw new HttpError(400, 'Štítky (tags) musí být pole textů.');
    const s = String(t).trim();
    if (!s) continue;
    if (s.length > 50) throw new HttpError(400, `Štítek „${s.slice(0, 20)}…“ je příliš dlouhý (max. 50 znaků).`);
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > 50) throw new HttpError(400, 'Příliš mnoho štítků (max. 50).');
  return out;
}

module.exports = {
  register(router) {
    router.get(
      '/api/v1/competitors',
      (ctx) => {
        const items = listCompetitors(ctx.db);
        return { items, total: items.length };
      },
      { auth: 'read' }
    );

    router.patch(
      '/api/v1/competitors/:id',
      (ctx) => {
        const db = ctx.db;
        const id = intParam(ctx, 'id');
        const body = V.bodyObject(ctx);
        for (const k of Object.keys(body)) {
          if (!PATCH_KEYS.includes(k)) throw new HttpError(400, `Pole „${k}“ nelze měnit (povoleno: ${PATCH_KEYS.join(', ')}).`);
        }
        const cur = db.prepare('SELECT * FROM competitors WHERE id = ?').get(id);
        if (!cur) throw new HttpError(404, 'Konkurent nenalezen.');
        // statistiky nabídek nezávisí na label/enabled/tags → vezmeme je před zneplatněním cache (bez přestavby)
        const stats = V.getCache(db).competitorStats;
        const next = {};
        const label = V.textInput(body.label, 'Označení (label)', { nullable: true, max: 200 });
        if (label !== undefined) next.label = label;
        const enabled = V.boolInput(body.enabled, 'Zapnuto (enabled)');
        if (enabled !== undefined) next.enabled = enabled ? 1 : 0;
        if (body.tags !== undefined) next.tags = JSON.stringify(parseTags(body.tags));
        const note = V.textInput(body.note, 'Poznámka', { nullable: true, max: 5000 });
        if (note !== undefined) next.note = note;
        const changes = {};
        for (const [k, v] of Object.entries(next)) if (cur[k] !== v) changes[k] = { from: cur[k] ?? null, to: v };
        if (Object.keys(changes).length) {
          const cols = Object.keys(next);
          db.prepare(`UPDATE competitors SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => next[c]), id);
          ctx.audit({ action: 'competitor.update', entity: 'competitor', entity_id: id, detail: { name: cur.name, changes } });
          V.invalidate(db, 'views');
        }
        const row = db.prepare('SELECT * FROM competitors WHERE id = ?').get(id);
        return competitorItem(row, stats);
      },
      { auth: 'admin' }
    );
  },
  listCompetitors,
};
