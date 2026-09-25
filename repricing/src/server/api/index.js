'use strict';
// Registrace API rout.
//
// Každý modul v tomto adresáři má tvar:
//
//   'use strict';
//   const { HttpError, intParam } = require('../http');
//   module.exports = {
//     register(router, deps) {
//       router.get('/api/v1/products', async (ctx) => ({ items: [], total: 0, page: 1, limit: 50 }), { auth: 'read' });
//       router.patch('/api/v1/products/:id', async (ctx) => { const id = intParam(ctx); … }, { auth: 'admin' });
//     },
//   };
//
// deps = {db, config, log, …} (stejné objekty jako v ctx; handlery by ale měly používat ctx.db / ctx.config).
// Moduly jiných částí (engine, import, export) vyžadujte líně uvnitř handlerů nebo nahoře v modulu – chyba
// při načtení modulu se zaloguje a modul se přeskočí (ostatní API dál funguje).
// Chybějící soubor modulu se tiše přeskočí (API se dopisuje postupně).

const path = require('node:path');
const defaultLog = require('../../util/log');

const MODULES = [
  'dashboard',
  'products',
  'competitors',
  'segments',
  'strategies',
  'runs',
  'proposals',
  'imports',
  'sources',
  'unmatched',
  'exports',
  'feeds',
  'settings',
  'fields',
  'audit',
];

function moduleExists(name) {
  try {
    require.resolve(path.join(__dirname, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * Zaregistruje všechny API routy: nejdřív auth (přihlášení, tokeny, health), pak dostupné moduly z MODULES.
 * @param {object} router router z http.createRouter()
 * @param {{db?: object, config?: object, log?: object}} [deps]
 * @returns {{loaded: string[], missing: string[], failed: {name: string, error: string}[]}}
 */
function registerRoutes(router, deps = {}) {
  const log = deps.log || defaultLog;
  const result = { loaded: [], missing: [], failed: [] };

  require('./auth').register(router, deps);
  result.loaded.push('auth');

  for (const name of MODULES) {
    if (!moduleExists(name)) {
      result.missing.push(name);
      continue;
    }
    try {
      const mod = require(path.join(__dirname, name));
      if (!mod || typeof mod.register !== 'function') throw new Error(`modul neexportuje funkci register(router)`);
      mod.register(router, deps);
      result.loaded.push(name);
    } catch (err) {
      result.failed.push({ name, error: err.message });
      log.error(`API modul „${name}“ se nepodařilo načíst – jeho endpointy nebudou dostupné.`, err);
    }
  }

  // Přehled dostupných endpointů (pro vývojáře a integrace).
  router.get(
    '/api/v1',
    () => ({
      name: 'Cenotvorba API',
      modules: result.loaded,
      routes: router.list().filter((r) => r.path.startsWith('/api/') || r.path.startsWith('/feed/')),
    }),
    { auth: 'any' }
  );

  return result;
}

module.exports = { registerRoutes, MODULES };
