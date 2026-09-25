'use strict';
// API: export cen (SPEC §8, §7).
//
//   GET  /api/v1/export/changes.:format(json|xml|csv)        export  ?mark=1 → tělo ve formátu; při označení hlavička
//                                                                    X-Export-Id (jen když se něco označilo); vždy X-Export-Count
//   POST /api/v1/export/ack                                   export  {proposal_ids?: [], codes?: []} → {export_id, count, unknown_codes}
//   GET  /api/v1/export/pohoda.xml                            export  ?scope=approved|all, mark=1, encoding=windows-1250|utf-8
//                                                                    → POHODA XML (příloha); nic k exportu → 409 (POHODA_EMPTY)
//   GET  /api/v1/export/proposals.xlsx                        read    stejné filtry jako GET /proposals (výchozí status pending) → XLSX
//   GET  /api/v1/export/pricelist.:format(json|xml|csv|xlsx)  export  úplný ceník (scope all) → příloha
//   POST /api/v1/export/push                                  export  → výsledek pushWebhook + {count, export_id, marked}
//   GET  /api/v1/exports                                      read    ?page, limit (výchozí 100) → {items, total, page, limit}
//
// Označení exportu (mark / ack / push) mění stav návrhů na „exported“ a (dle nastavení) products.price → cache
// pohledů a návrhů se zneplatní.

const { parseJson } = require('../../db');
const { exportChanges, exportPohoda, pushChanges, ackExport } = require('../../export/apply');
const { proposalsXlsx } = require('../../export/xlsx-report');
const { pragueDate } = require('../../export/pohoda');
const { HttpError, paging, queryBool, raw } = require('../http');
const V = require('./_views');
const { listIds, proposalItems } = require('./proposals');

const MAX_XLSX_ROWS = 100000;

/** Odpověď se souborem (příloha nebo inline) + volitelné hlavičky exportu. */
function fileResponse(res, { attachment = true, headers = {} } = {}) {
  const h = { 'X-Export-Count': String(res.count ?? 0), ...headers };
  if (res.export_id != null) h['X-Export-Id'] = String(res.export_id);
  return raw({
    status: 200,
    body: Buffer.isBuffer(res.body) ? res.body : Buffer.from(String(res.body), 'utf8'),
    contentType: res.contentType,
    filename: attachment ? res.filename : undefined,
    headers: h,
  });
}

/** ?mark=1 – u HEAD se nikdy neoznačuje (klient by tělo s označenými změnami vůbec nedostal). */
function markRequested(ctx) {
  return ctx.method !== 'HEAD' && queryBool(ctx, 'mark', false);
}

/**
 * Změny / ceník ve formátu (sdílí i /feed/*).
 * @param {object} ctx
 * @param {{format: string, scope: 'approved'|'all', mark: boolean, kind: string, target: string, attachment: boolean}} o
 */
function sendChanges(ctx, o) {
  let res;
  try {
    res = exportChanges(ctx.db, { format: o.format, scope: o.scope, mark: o.mark, actor: ctx.user, kind: o.kind, target: o.target });
  } catch (e) {
    throw V.toClientError(e);
  }
  if (o.mark && res.marked) V.invalidate(ctx.db, 'views', 'proposals');
  return fileResponse(res, { attachment: o.attachment });
}

module.exports = {
  register(router) {
    router.get(
      '/api/v1/export/changes.:format(json|xml|csv)',
      (ctx) => sendChanges(ctx, { format: ctx.params.format, scope: 'approved', mark: markRequested(ctx), kind: ctx.params.format, target: 'api', attachment: true }),
      { auth: 'export' }
    );

    router.post(
      '/api/v1/export/ack',
      (ctx) => {
        const body = V.bodyObject(ctx);
        for (const k of Object.keys(body)) if (k !== 'proposal_ids' && k !== 'codes') throw new HttpError(400, `Neznámé pole „${k}“ (povoleno: proposal_ids, codes).`);
        const ids = body.proposal_ids == null ? [] : V.idArray(body.proposal_ids, 'proposal_ids');
        let codes = [];
        if (body.codes != null) {
          if (!Array.isArray(body.codes) || body.codes.some((c) => typeof c !== 'string' && typeof c !== 'number')) throw new HttpError(400, 'codes: očekáváno pole kódů produktů.');
          codes = body.codes.map((c) => String(c));
        }
        if (!ids.length && !codes.length) throw new HttpError(400, 'Zadejte proposal_ids nebo codes – co admin převzal.');
        let res;
        try {
          res = ackExport(ctx.db, { proposal_ids: ids, codes, actor: ctx.user, target: ctx.via === 'token' && ctx.token ? `token:${ctx.token.name}` : 'api' });
        } catch (e) {
          throw V.toClientError(e);
        }
        if (res.count) V.invalidate(ctx.db, 'views', 'proposals');
        return { export_id: res.export_id, count: res.count, proposal_ids: res.proposal_ids, unknown_codes: res.unknown_codes };
      },
      { auth: 'export' }
    );

    router.get(
      '/api/v1/export/pohoda.xml',
      (ctx) => {
        const scope = ctx.query.scope == null || ctx.query.scope === '' ? 'approved' : String(ctx.query.scope);
        if (scope !== 'approved' && scope !== 'all') throw new HttpError(400, 'Parametr „scope“ musí být approved nebo all.');
        let encoding;
        if (ctx.query.encoding != null && ctx.query.encoding !== '') {
          encoding = String(ctx.query.encoding).toLowerCase();
          if (encoding === 'cp1250' || encoding === 'windows1250') encoding = 'windows-1250';
          if (encoding === 'utf8') encoding = 'utf-8';
          if (encoding !== 'windows-1250' && encoding !== 'utf-8') throw new HttpError(400, 'Parametr „encoding“ musí být windows-1250 nebo utf-8.');
        }
        const mark = markRequested(ctx);
        let res;
        try {
          res = exportPohoda(ctx.db, { scope, mark, actor: ctx.user, encoding, target: 'pohoda.xml' });
        } catch (e) {
          if (e && e.code === 'POHODA_EMPTY') {
            throw new HttpError(409, `${e.message}. Nejdřív schvalte návrhy cen, nebo stáhněte celý ceník (scope=all).`, { code: 'POHODA_EMPTY', skipped: e.skipped || [] });
          }
          throw V.toClientError(e);
        }
        if (mark && res.export_id != null) V.invalidate(ctx.db, 'views', 'proposals');
        const headers = { 'X-Pohoda-Pack-Id': res.id, 'X-Pohoda-Skipped': String(res.skipped ? res.skipped.length : 0) };
        return fileResponse(res, { headers });
      },
      { auth: 'export' }
    );

    router.get(
      '/api/v1/export/proposals.xlsx',
      (ctx) => {
        const { ids, total, cache } = listIds(ctx.db, ctx.query, { maxAll: MAX_XLSX_ROWS });
        if (total > MAX_XLSX_ROWS) throw new HttpError(400, `Příliš mnoho návrhů pro XLSX (${total}); zužte filtr (max. ${MAX_XLSX_ROWS}).`);
        const items = [];
        for (let i = 0; i < ids.length; i += 2000) items.push(...proposalItems(ctx.db, ids.slice(i, i + 2000), { cache }));
        const body = proposalsXlsx(items);
        return raw({
          status: 200,
          body,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          filename: `navrhy-cen-${pragueDate(new Date())}.xlsx`,
          headers: { 'X-Export-Count': String(items.length) },
        });
      },
      { auth: 'read' }
    );

    router.get(
      '/api/v1/export/pricelist.:format(json|xml|csv|xlsx)',
      (ctx) => {
        if (markRequested(ctx)) throw new HttpError(400, 'Ceník nelze označit jako exportovaný (mark) – použijte export změn.');
        return sendChanges(ctx, { format: ctx.params.format, scope: 'all', mark: false, kind: ctx.params.format, target: 'pricelist', attachment: true });
      },
      { auth: 'export' }
    );

    router.post(
      '/api/v1/export/push',
      async (ctx) => {
        const res = await pushChanges(ctx.db, { actor: ctx.user });
        if (!res.ok && res.status == null && res.export_id == null && res.count === 0 && res.error) {
          // chybí URL webhooku – chyba nastavení, ne vzdáleného serveru
          throw new HttpError(400, res.error);
        }
        if (res.marked) V.invalidate(ctx.db, 'views', 'proposals');
        return res;
      },
      { auth: 'export' }
    );

    router.get(
      '/api/v1/exports',
      (ctx) => {
        const { page, limit, offset } = paging(ctx, { defaultLimit: 100, maxLimit: 500 });
        const total = ctx.db.prepare('SELECT count(*) AS c FROM exports').get().c;
        const items = ctx.db
          .prepare('SELECT * FROM exports ORDER BY id DESC LIMIT ? OFFSET ?')
          .all(limit, offset)
          .map((r) => ({ ...r, detail: parseJson(r.detail, r.detail) }));
        return { items, total, page, limit };
      },
      { auth: 'read' }
    );
  },
  sendChanges,
  markRequested,
};
