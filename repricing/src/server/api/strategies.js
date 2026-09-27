'use strict';
// API: cenové strategie, předvolby a simulace (SPEC §8, konfigurace §6.5).
//
//   GET    /api/v1/strategies                read   → {items: [strategie], total, page, limit} (podle priority, id)
//   POST   /api/v1/strategies                admin  {name, description?, segment_id?, priority?, enabled?, config} → strategie (201)
//   GET    /api/v1/strategies/:id            read   → strategie
//   PUT    /api/v1/strategies/:id            admin  (chybějící pole se nemění; config se nahrazuje celý) → strategie
//   DELETE /api/v1/strategies/:id            admin  → {ok: true}
//   POST   /api/v1/strategies/reorder        admin  {ids: [...]} → priority 10, 20, 30… (neuvedené za nimi) → {ok, items}
//   GET    /api/v1/strategies/presets        read   → {items: STRATEGY_PRESETS}
//   POST   /api/v1/strategies/presets/:key   admin  → {strategy, segment|null, segment_created, warning|null} (201) – strategie
//                                                   vzniká VYPNUTÁ; cílená se zařadí před záchytnou strategii pro všechny produkty
//   POST   /api/v1/simulate                  read   {config, segment_id?, filter?, limit?} → simulate() {stats, decisions, truncated, errors,
//                                                   context: false} (decisions = až `limit` změn + až `limit` přeskočených)
//                                                   {strategy_id, config?, segment_id?, priority?, limit?} → simulace v kontextu celé
//                                                   sady zapnutých strategií (upravený config nahradí uložený; vypnutá strategie se vloží
//                                                   na místo své priority) – jen produkty, o kterých rozhodla tato strategie;
//                                                   context: true, stats.claimed_by_earlier = produkty segmentu zabrané dřívější strategií
//
// strategie = {id, name, description, segment_id, segment_name, priority, enabled (bool), config (normalizovaný),
//              config_errors: string[], created_at, updated_at}
// Neplatný config → 400, details = seznam chyb z normalizeConfig (česky). Ukládá se normalizovaný config.

const { tx, nowIso, parseJson } = require('../../db');
const { normalizeConfig, STRATEGY_PRESETS } = require('../../engine/presets');
const { simulate } = require('../../engine/run');
const { isEmptyFilter } = require('../../engine/filter');
const { HttpError, intParam, paging } = require('../http');
const V = require('./_views');

const KEYS = ['name', 'description', 'segment_id', 'priority', 'enabled', 'config'];
const READ_ONLY = ['id', 'segment_name', 'created_at', 'updated_at', 'config_errors'];

const SELECT = `SELECT st.*, g.name AS segment_name FROM strategies st LEFT JOIN segments g ON g.id = st.segment_id`;

function strategyItem(row) {
  const { config, errors } = normalizeConfig(parseJson(row.config, {}));
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    segment_id: row.segment_id ?? null,
    segment_name: row.segment_name ?? null,
    priority: row.priority,
    enabled: row.enabled === 1,
    config,
    config_errors: errors,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getStrategy(db, id) {
  const row = db.prepare(`${SELECT} WHERE st.id = ?`).get(id);
  if (!row) throw new HttpError(404, 'Strategie nenalezena.');
  return strategyItem(row);
}

function listAll(db) {
  return db.prepare(`${SELECT} ORDER BY st.priority, st.id`).all().map(strategyItem);
}

function nextPriority(db) {
  const r = db.prepare('SELECT MAX(priority) AS m FROM strategies').get();
  return r.m == null ? 10 : Math.floor(r.m / 10) * 10 + 10;
}

/** Ověří konfiguraci; neplatná → 400 se seznamem chyb. Vrací normalizovaný config. */
function checkConfig(input) {
  if (input !== undefined && input !== null && typeof input !== 'string' && !V.isPlainObject(input)) {
    throw new HttpError(400, 'Neplatná konfigurace strategie: config musí být objekt.', ['config: musí být objekt']);
  }
  const { config, errors } = normalizeConfig(input ?? {});
  if (errors.length) throw new HttpError(400, `Neplatná konfigurace strategie: ${errors.join('; ')}`, errors);
  return config;
}

function validateBody(db, body, { create }) {
  for (const k of Object.keys(body)) {
    if (!KEYS.includes(k) && !READ_ONLY.includes(k)) throw new HttpError(400, `Neznámé pole strategie „${k}“ (povoleno: ${KEYS.join(', ')}).`);
  }
  const out = {};
  if (create || body.name !== undefined) out.name = V.textInput(body.name ?? null, 'Název strategie', { nullable: false, max: 200 });
  if (body.description !== undefined) out.description = V.textInput(body.description, 'Popis', { nullable: true, max: 5000 });
  if (body.segment_id !== undefined) {
    const sid = V.numberInput(body.segment_id, 'Segment', { nullable: true, integer: true, positive: true });
    if (sid != null && !db.prepare('SELECT 1 FROM segments WHERE id = ?').get(sid)) throw new HttpError(400, `Segment ${sid} neexistuje.`);
    out.segment_id = sid;
  }
  if (body.priority !== undefined && body.priority !== null) {
    out.priority = V.numberInput(body.priority, 'Priorita', { integer: true, min: -1000000, max: 1000000 });
  }
  if (body.enabled !== undefined) out.enabled = V.boolInput(body.enabled, 'Zapnuto (enabled)') ? 1 : 0;
  if (create || body.config !== undefined) out.config = JSON.stringify(checkConfig(body.config));
  return out;
}

/** Unikátní název (přidá „ (2)“, „ (3)“ …). */
function uniqueName(db, table, name) {
  const exists = db.prepare(`SELECT 1 FROM ${table} WHERE name = ?`);
  if (!exists.get(name)) return name;
  for (let i = 2; i < 1000; i++) {
    const n = `${name} (${i})`;
    if (!exists.get(n)) return n;
  }
  return `${name} (${Date.now()})`;
}

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (V.isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

function applyPreset(ctx, key) {
  const db = ctx.db;
  const preset = STRATEGY_PRESETS.find((p) => p.key === key);
  if (!preset) throw new HttpError(404, `Předvolba „${key}“ neexistuje.`);
  const config = checkConfig(structuredClone(preset.config));
  const now = nowIso();
  const res = tx(db, () => {
    let segmentId = null;
    let segmentCreated = false;
    if (preset.segment) {
      const filterJson = JSON.stringify(canonical(preset.segment.filter || {}));
      // stejný segment (název i filtr) už existuje → použít ho, jinak založit (případně s odlišeným názvem)
      const same = db
        .prepare('SELECT id, filter FROM segments WHERE name = ?')
        .all(preset.segment.name)
        .find((r) => JSON.stringify(canonical(parseJson(r.filter, {}))) === filterJson);
      if (same) segmentId = same.id;
      else {
        const name = uniqueName(db, 'segments', preset.segment.name);
        segmentId = Number(
          db
            .prepare('INSERT INTO segments (name, description, filter, color, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)')
            .run(name, preset.segment.description || null, JSON.stringify(preset.segment.filter || {}), now, now).lastInsertRowid
        );
        segmentCreated = true;
      }
    }
    const name = uniqueName(db, 'strategies', preset.name);
    // Pořadí: za zapnutou „záchytnou“ strategií (bez segmentu a podmínek – platí pro všechny produkty) by se nová
    // strategie nikdy nepoužila. Cílená předvolba se proto zařadí PŘED ni (ostatní se posunou o 10); záchytná
    // předvolba zůstane na konci s upozorněním (contract-4).
    const catchAllOf = (row) => row.segment_id == null && isEmptyFilter(normalizeConfig(row.config).config.conditions || {});
    const catchAll = db.prepare('SELECT id, name, priority, segment_id, config FROM strategies WHERE enabled = 1 ORDER BY priority, id').all().find(catchAllOf) || null;
    const targeted = !(segmentId == null && isEmptyFilter(config.conditions || {}));
    let priority = nextPriority(db);
    let warning = null;
    if (catchAll && targeted) {
      db.prepare('UPDATE strategies SET priority = priority + 10, updated_at = ? WHERE priority >= ?').run(now, catchAll.priority);
      priority = catchAll.priority;
      warning = `Strategie je zařazena před strategií „${catchAll.name}“, která platí pro všechny produkty – jinak by se nikdy nepoužila.`;
    } else if (catchAll) {
      warning = `Strategie je až za strategií „${catchAll.name}“, která platí pro všechny produkty – nepoužije se, dokud ji nepřesunete výš.`;
    }
    // Předvolba vzniká VYPNUTÁ (jak slibuje UI): nejdřív zkontrolovat a nasimulovat, pak zapnout (contract-4).
    const id = Number(
      db
        .prepare('INSERT INTO strategies (name, description, segment_id, priority, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
        .run(name, preset.description || null, segmentId, priority, JSON.stringify(config), now, now).lastInsertRowid
    );
    return { id, segmentId, segmentCreated, warning };
  });
  ctx.audit({ action: 'strategy.preset', entity: 'strategy', entity_id: res.id, detail: { key, segment_id: res.segmentId, segment_created: res.segmentCreated } });
  V.invalidate(db, 'segments');
  let segment = null;
  if (res.segmentId != null) {
    const { segmentItem, strategiesBySegment } = require('./segments');
    const row = db.prepare('SELECT * FROM segments WHERE id = ?').get(res.segmentId);
    segment = segmentItem(row, V.getCache(db), strategiesBySegment(db));
  }
  ctx.status = 201;
  return { strategy: getStrategy(db, res.id), segment, segment_created: res.segmentCreated, warning: res.warning };
}

function runSimulation(ctx) {
  const db = ctx.db;
  const body = V.bodyObject(ctx);
  // strategy_id → simulace v kontextu celé sady strategií (C2); config je volitelný (chybí = uložený config strategie)
  const strategyId = body.strategy_id === undefined || body.strategy_id === null || body.strategy_id === '' ? null : V.numberInput(body.strategy_id, 'Strategie (strategy_id)', { integer: true, positive: true });
  if (strategyId != null && !db.prepare('SELECT 1 FROM strategies WHERE id = ?').get(strategyId)) throw new HttpError(400, `Strategie ${strategyId} neexistuje.`);
  const config = strategyId != null && (body.config === undefined || body.config === null) ? undefined : checkConfig(body.config);
  const segmentId = body.segment_id === undefined ? (strategyId != null ? undefined : null) : V.numberInput(body.segment_id, 'Segment', { nullable: true, integer: true, positive: true });
  if (segmentId != null && !db.prepare('SELECT 1 FROM segments WHERE id = ?').get(segmentId)) throw new HttpError(400, `Segment ${segmentId} neexistuje.`);
  let filter = null;
  if (strategyId == null && segmentId == null && body.filter != null && body.filter !== '') filter = V.parseFilterInput(body.filter).filter;
  const priority = strategyId != null && body.priority !== undefined && body.priority !== null ? V.numberInput(body.priority, 'Priorita', { integer: true, min: -1000000, max: 1000000 }) : undefined;
  const limit = body.limit === undefined || body.limit === null ? 200 : V.numberInput(body.limit, 'Limit', { integer: true, min: 1, max: 1000 });
  const res = simulate(db, { config, segment_id: segmentId, filter, limit, name: typeof body.name === 'string' ? body.name : undefined, strategy_id: strategyId, priority });
  if (res.errors && res.errors.length) throw new HttpError(400, `Simulaci nelze spustit: ${res.errors.join('; ')}`, res.errors);
  return {
    stats: res.stats,
    decisions: res.decisions.map((d) => ({ ...d, product: { id: d.product_id, code: d.code ?? null, name: d.name ?? null, manufacturer: d.manufacturer ?? null } })),
    truncated: res.truncated,
    errors: [],
    context: res.context === true,
  };
}

module.exports = {
  register(router) {
    router.get(
      '/api/v1/strategies',
      (ctx) => {
        const { page, limit, offset } = paging(ctx, { defaultLimit: 500, maxLimit: 500 });
        const all = listAll(ctx.db);
        return { items: all.slice(offset, offset + limit), total: all.length, page, limit };
      },
      { auth: 'read' }
    );

    router.get('/api/v1/strategies/presets', () => ({ items: structuredClone(STRATEGY_PRESETS) }), { auth: 'read' });
    router.post('/api/v1/strategies/presets/:key', (ctx) => applyPreset(ctx, ctx.params.key), { auth: 'admin' });

    router.post(
      '/api/v1/strategies/reorder',
      (ctx) => {
        const db = ctx.db;
        const body = V.bodyObject(ctx);
        const ids = V.idArray(body.ids, 'ids');
        if (Array.isArray(body.ids) && ids.length !== body.ids.length) throw new HttpError(400, 'ids: id strategií se nesmí opakovat.');
        const current = db.prepare('SELECT id FROM strategies ORDER BY priority, id').all().map((r) => r.id);
        const known = new Set(current);
        const unknown = ids.filter((id) => !known.has(id));
        if (unknown.length) throw new HttpError(400, `Neznámé strategie: ${unknown.join(', ')}.`);
        const listed = new Set(ids);
        const order = [...ids, ...current.filter((id) => !listed.has(id))];
        tx(db, () => {
          const upd = db.prepare('UPDATE strategies SET priority = ?, updated_at = ? WHERE id = ?');
          const now = nowIso();
          order.forEach((id, i) => upd.run((i + 1) * 10, now, id));
        });
        ctx.audit({ action: 'strategy.reorder', entity: 'strategy', detail: { ids: order } });
        return { ok: true, items: listAll(db) };
      },
      { auth: 'admin' }
    );

    router.post(
      '/api/v1/strategies',
      (ctx) => {
        const db = ctx.db;
        const v = validateBody(db, V.bodyObject(ctx), { create: true });
        const now = nowIso();
        const id = Number(
          db
            .prepare('INSERT INTO strategies (name, description, segment_id, priority, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(v.name, v.description ?? null, v.segment_id ?? null, v.priority ?? nextPriority(db), v.enabled ?? 1, v.config, now, now).lastInsertRowid
        );
        ctx.audit({ action: 'strategy.create', entity: 'strategy', entity_id: id, detail: { name: v.name } });
        ctx.status = 201;
        return getStrategy(db, id);
      },
      { auth: 'admin' }
    );

    router.get('/api/v1/strategies/:id', (ctx) => getStrategy(ctx.db, intParam(ctx, 'id')), { auth: 'read' });

    router.put(
      '/api/v1/strategies/:id',
      (ctx) => {
        const db = ctx.db;
        const id = intParam(ctx, 'id');
        const cur = db.prepare('SELECT * FROM strategies WHERE id = ?').get(id);
        if (!cur) throw new HttpError(404, 'Strategie nenalezena.');
        const v = validateBody(db, V.bodyObject(ctx), { create: false });
        const cols = Object.keys(v).filter((k) => v[k] !== cur[k]);
        if (cols.length) {
          db.prepare(`UPDATE strategies SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => v[c]), nowIso(), id);
          ctx.audit({ action: 'strategy.update', entity: 'strategy', entity_id: id, detail: { name: v.name ?? cur.name, fields: cols } });
        }
        return getStrategy(db, id);
      },
      { auth: 'admin' }
    );

    router.delete(
      '/api/v1/strategies/:id',
      (ctx) => {
        const id = intParam(ctx, 'id');
        const cur = ctx.db.prepare('SELECT id, name FROM strategies WHERE id = ?').get(id);
        if (!cur) throw new HttpError(404, 'Strategie nenalezena.');
        ctx.db.prepare('DELETE FROM strategies WHERE id = ?').run(id);
        ctx.audit({ action: 'strategy.delete', entity: 'strategy', entity_id: id, detail: { name: cur.name } });
        return { ok: true };
      },
      { auth: 'admin' }
    );

    router.post('/api/v1/simulate', runSimulation, { auth: 'read' });
  },
  strategyItem,
};
