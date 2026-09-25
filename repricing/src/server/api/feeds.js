'use strict';
// Feedy pro admin (SPEC §8) – bez prefixu /api/v1, ověření tokenem v ?token= (nebo hlavičkou), rozsah export.
//
//   GET /feed/changes.(xml|json|csv)   schválené změny (scope approved); ?mark=1 → označí jako exportované
//                                      (kind 'feed'), hlavička X-Export-Id
//   GET /feed/prices.(xml|json|csv)    úplný ceník (scope all); mark není povolen (400)
//   jiný název → 404
//
// Feed se vrací inline (bez Content-Disposition) – je určen ke stahování programem.
// Pozn.: nastavení export.feed_scope se zde nepoužívá – rozsah určuje název feedu (changes / prices).

const { HttpError } = require('../http');
const { sendChanges, markRequested } = require('./exports');

const FEEDS = new Map([
  ['changes', 'approved'],
  ['prices', 'all'],
]);

module.exports = {
  register(router) {
    router.get(
      '/feed/:name.:ext(xml|json|csv)',
      (ctx) => {
        const name = ctx.params.name;
        const scope = FEEDS.get(name);
        if (!scope) throw new HttpError(404, `Neznámý feed „${name}“ (dostupné: changes, prices).`);
        const mark = markRequested(ctx);
        if (mark && name !== 'changes') throw new HttpError(400, 'Parametr mark je povolen jen pro feed changes.');
        return sendChanges(ctx, { format: ctx.params.ext, scope, mark, kind: 'feed', target: `feed/${name}.${ctx.params.ext}`, attachment: false });
      },
      { auth: 'export' }
    );
  },
};
