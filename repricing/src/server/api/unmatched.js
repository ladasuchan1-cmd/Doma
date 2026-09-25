'use strict';
// API: nespárované nabídky konkurence (SPEC §5 offers.js – unmatched_offers, matchUnmatched; §8).
//
//   GET    /api/v1/unmatched              read   ?competitor=<id|název>, q=<text v názvu/EAN/kódu/MPN/ID>, reason=not_found|ambiguous,
//                                                sort=last_seen_at|first_seen_at|seen_count|price|name|competitor, dir=asc|desc, page, limit (50, max 500)
//          → {items: [{id, competitor_id, competitor, competitor_label, match_key, code, ean, mpn, ext_id, name, price, url,
//                      seen_count, first_seen_at, last_seen_at, reason, candidates: [{id, code, name, ean, active}], raw}],
//             total, page, limit}
//             raw = uložený kanonický záznam včetně `_reason` a `_candidates` (rozparsovaný JSON)
//   POST   /api/v1/unmatched/:id/match    admin  {product_id} nebo {code} (+ volitelně kind: ean|mpn|ext|code|name = druh aliasu)
//          → {ok: true, product_id, alias: {kind, value_key, competitor_id}, stats}
//            vytvoří alias (příští importy spárují automaticky), nabídku znovu naimportuje a řádek smaže; 404 = nabídka / produkt neexistuje
//   DELETE /api/v1/unmatched/:id          admin  → {ok: true}; 404 = neexistuje

const { parseJson, audit } = require('../../db');
const { HttpError, intParam, paging } = require('../http');
const { fold, nameKey, codeKey } = require('../../util/keys');
const { matchUnmatched } = require('../../import');
const { invalidateViews, isObj } = require('./imports');

const REASONS = ['not_found', 'ambiguous'];
const SORTS = {
  last_seen_at: 'u.last_seen_at',
  first_seen_at: 'u.first_seen_at',
  seen_count: 'u.seen_count',
  price: 'u.price',
  name: 'u.name COLLATE NOCASE',
  competitor: 'c.name COLLATE NOCASE',
};
const FOLD_FN = 'ct_unmatched_fold';
const withFold = new WeakSet();

/** Zaregistruje v SQLite funkci fold() (bez diakritiky, malá písmena) pro hledání; false = nelze (starší Node). */
function ensureFold(db) {
  if (withFold.has(db)) return true;
  if (typeof db.function !== 'function') return false;
  try {
    db.function(FOLD_FN, { deterministic: true }, (s) => (s == null ? '' : fold(s)));
    withFold.add(db);
    return true;
  } catch {
    return false;
  }
}

function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}

function auditSafe(ctx, entry) {
  try {
    audit(ctx.db, { actor: ctx.user || null, ...entry });
  } catch {
    /* audit nesmí operaci shodit */
  }
}

function listUnmatched(ctx) {
  const db = ctx.db;
  const { page, limit, offset } = paging(ctx, { defaultLimit: 50, maxLimit: 500 });
  const where = [];
  const args = [];

  const comp = ctx.query.competitor != null ? String(ctx.query.competitor).trim() : '';
  if (comp) {
    if (/^\d+$/.test(comp)) {
      where.push('u.competitor_id = ?');
      args.push(Number(comp));
    } else {
      where.push('(c.name_key = ? OR c.name = ? OR c.label = ?)');
      args.push(nameKey(comp) || comp, comp, comp);
    }
  }

  const q = ctx.query.q != null ? String(ctx.query.q).trim() : '';
  if (q) {
    const raw = `%${likeEscape(q)}%`;
    const conds = ["COALESCE(u.ean, '') LIKE ? ESCAPE '\\'", "COALESCE(u.code, '') LIKE ? ESCAPE '\\'", "COALESCE(u.mpn, '') LIKE ? ESCAPE '\\'", "COALESCE(u.ext_id, '') LIKE ? ESCAPE '\\'", "u.match_key LIKE ? ESCAPE '\\'"];
    const condArgs = [raw, raw, raw, raw, raw];
    if (ensureFold(db)) {
      conds.push(`${FOLD_FN}(u.name) LIKE ? ESCAPE '\\'`);
      condArgs.push(`%${likeEscape(fold(q))}%`);
    } else {
      conds.push("COALESCE(u.name, '') LIKE ? ESCAPE '\\'");
      condArgs.push(raw);
    }
    const ck = codeKey(q);
    if (ck && ck !== q) {
      conds.push("UPPER(COALESCE(u.code, '')) LIKE ? ESCAPE '\\'");
      condArgs.push(`%${likeEscape(ck)}%`);
    }
    where.push(`(${conds.join(' OR ')})`);
    args.push(...condArgs);
  }

  const reason = ctx.query.reason != null ? String(ctx.query.reason).trim().toLowerCase() : '';
  if (reason && reason !== 'all') {
    if (!REASONS.includes(reason)) throw new HttpError(400, 'Parametr „reason“ musí být „not_found“ (nenalezeno) nebo „ambiguous“ (nejednoznačné).', { field: 'reason' });
    where.push("(CASE WHEN json_valid(u.raw) THEN json_extract(u.raw, '$._reason') END) = ?");
    args.push(reason);
  }

  const sortKey = ctx.query.sort ? String(ctx.query.sort).trim() : 'last_seen_at';
  if (!SORTS[sortKey]) throw new HttpError(400, `Neznámé řazení „${sortKey}“ (povoleno: ${Object.keys(SORTS).join(', ')}).`, { field: 'sort' });
  const dirRaw = ctx.query.dir ? String(ctx.query.dir).trim().toLowerCase() : sortKey === 'name' || sortKey === 'competitor' ? 'asc' : 'desc';
  if (dirRaw !== 'asc' && dirRaw !== 'desc') throw new HttpError(400, 'Parametr „dir“ musí být asc nebo desc.', { field: 'dir' });
  const dir = dirRaw.toUpperCase();

  const from = 'FROM unmatched_offers u LEFT JOIN competitors c ON c.id = u.competitor_id';
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(db.prepare(`SELECT COUNT(*) AS n ${from} ${w}`).get(...args).n);
  const rows = db
    .prepare(`SELECT u.*, c.name AS competitor_name, c.label AS competitor_label ${from} ${w} ORDER BY ${SORTS[sortKey]} ${dir}, u.id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset);

  // kandidáti (nejednoznačné EAN/MPN) – jedním dotazem pro celou stránku
  const parsed = rows.map((r) => {
    const raw = parseJson(r.raw, null);
    return { r, raw: isObj(raw) ? raw : {} };
  });
  const candIds = new Set();
  for (const { raw } of parsed) if (Array.isArray(raw._candidates)) for (const id of raw._candidates) if (Number.isInteger(id)) candIds.add(id);
  const candMap = new Map();
  if (candIds.size) {
    const ids = [...candIds];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const list = db.prepare(`SELECT id, code, name, ean, active FROM products WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk);
      for (const p of list) candMap.set(p.id, { id: p.id, code: p.code, name: p.name, ean: p.ean, active: !!p.active });
    }
  }

  const items = parsed.map(({ r, raw }) => ({
    id: r.id,
    competitor_id: r.competitor_id ?? null,
    competitor: r.competitor_name ?? null,
    competitor_label: r.competitor_label ?? null,
    match_key: r.match_key,
    code: r.code ?? null,
    ean: r.ean ?? null,
    mpn: r.mpn ?? null,
    ext_id: r.ext_id ?? null,
    name: r.name ?? null,
    price: r.price ?? null,
    url: r.url ?? null,
    seen_count: r.seen_count,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    reason: typeof raw._reason === 'string' ? raw._reason : 'not_found',
    candidates: Array.isArray(raw._candidates) ? raw._candidates.map((id) => candMap.get(id)).filter(Boolean) : [],
    raw,
  }));
  return { items, total, page, limit };
}

function matchHandler(ctx) {
  const id = intParam(ctx, 'id');
  const body = ctx.body;
  if (!isObj(body)) throw new HttpError(400, 'Očekáván JSON objekt {product_id} v těle požadavku.');
  let productId = null;
  const pid = body.product_id;
  if (pid !== undefined && pid !== null && pid !== '') {
    const n = typeof pid === 'number' ? pid : typeof pid === 'string' && /^\s*\d+\s*$/.test(pid) ? Number(pid) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, 'product_id musí být kladné celé číslo (ID produktu).', { field: 'product_id' });
    productId = n;
  } else if (body.code != null && String(body.code).trim() !== '') {
    const p = ctx.db.prepare('SELECT id FROM products WHERE code_key = ?').get(codeKey(body.code));
    if (!p) throw new HttpError(404, `Produkt s kódem „${String(body.code).trim()}“ nebyl nalezen.`);
    productId = p.id;
  } else {
    throw new HttpError(400, 'Zadejte product_id (nebo code) produktu, se kterým se má nabídka spárovat.', { field: 'product_id' });
  }
  let kind;
  if (body.kind !== undefined && body.kind !== null && body.kind !== '') {
    kind = String(body.kind).trim().toLowerCase();
    if (!['ean', 'mpn', 'ext', 'ext_id', 'code', 'name'].includes(kind)) {
      throw new HttpError(400, 'kind (druh aliasu) musí být ean, mpn, ext, code nebo name.', { field: 'kind' });
    }
  }
  const before = ctx.db.prepare('SELECT competitor_id, match_key, name FROM unmatched_offers WHERE id = ?').get(id);
  // matchUnmatched vyhodí ImportError 404 (nabídka / produkt neexistuje) nebo 400 (chybí identifikátor) → HTTP podle status
  const res = matchUnmatched(ctx.db, id, productId, { kind, now: ctx.now });
  auditSafe(ctx, {
    action: 'unmatched.match',
    entity: 'unmatched_offer',
    entity_id: id,
    detail: { product_id: res.product_id, alias: res.alias, competitor_id: before ? before.competitor_id : null, match_key: before ? before.match_key : null },
  });
  invalidateViews(ctx);
  return { ...res, ok: true };
}

function deleteHandler(ctx) {
  const id = intParam(ctx, 'id');
  const row = ctx.db.prepare('SELECT id, competitor_id, match_key FROM unmatched_offers WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, `Nespárovaná nabídka #${id} nebyla nalezena.`);
  ctx.db.prepare('DELETE FROM unmatched_offers WHERE id = ?').run(id);
  auditSafe(ctx, { action: 'unmatched.delete', entity: 'unmatched_offer', entity_id: id, detail: { competitor_id: row.competitor_id, match_key: row.match_key } });
  invalidateViews(ctx);
  return { ok: true };
}

function register(router) {
  router.get('/api/v1/unmatched', listUnmatched, { auth: 'read' });
  router.post('/api/v1/unmatched/:id/match', matchHandler, { auth: 'admin', maxBodyMb: 1 });
  router.delete('/api/v1/unmatched/:id', deleteHandler, { auth: 'admin' });
}

module.exports = { register };
