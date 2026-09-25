'use strict';
// API: auditní log (SPEC §8).
//
//   GET /api/v1/audit   admin   ?limit (výchozí a max. 200), entity?, action? → {items: [{id, at, actor, action, entity,
//                               entity_id, detail (objekt | text)}]} – nejnovější první

const { parseJson } = require('../../db');
const { queryInt } = require('../http');

module.exports = {
  register(router) {
    router.get(
      '/api/v1/audit',
      (ctx) => {
        const limit = queryInt(ctx, 'limit', { def: 200, min: 1, max: 200 });
        const where = [];
        const args = [];
        if (ctx.query.entity) {
          where.push('entity = ?');
          args.push(String(ctx.query.entity));
        }
        if (ctx.query.action) {
          where.push('action = ?');
          args.push(String(ctx.query.action));
        }
        const items = ctx.db
          .prepare(`SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
          .all(...args, limit)
          .map((r) => ({ ...r, detail: parseJson(r.detail, r.detail) }));
        return { items };
      },
      { auth: 'admin' }
    );
  },
};
