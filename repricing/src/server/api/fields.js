'use strict';
// API: pole pro filtry segmentů a podmínky strategií (SPEC §8, §6.3).
//
//   GET /api/v1/fields   read   → {fields: [{key, label, type, group, unit?, values?, options?}]}
//                               = FIELDS enginu + attrs.* objevené z dat produktů (typ odhadnut z hodnot)

const V = require('./_views');

module.exports = {
  register(router) {
    router.get('/api/v1/fields', (ctx) => ({ fields: V.fieldsOf(V.getCache(ctx.db)) }), { auth: 'read' });
  },
};
