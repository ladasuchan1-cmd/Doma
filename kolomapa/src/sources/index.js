'use strict';
// Registr zdrojů inzerátů. Pořadí = pořadí stahování.

const SOURCES = {
  bazos: () => require('./bazos'),
  sbazar: () => require('./sbazar'),
  aukro: () => require('./aukro'),
  cyklobazar: () => require('./cyklobazar'),
};

const LABELS = { bazos: 'Bazoš', sbazar: 'Sbazar', aukro: 'Aukro', cyklobazar: 'Cyklobazar' };

/**
 * Načte moduly zapnutých zdrojů. Zdroj, který nejde načíst (chybí soubor / volitelná závislost), se přeskočí s varováním.
 * @param {string[]} keys
 * @param {{warn?: Function}} [log]
 * @returns {object[]}
 */
function loadSources(keys, log) {
  const out = [];
  for (const key of keys) {
    const load = SOURCES[key];
    if (!load) {
      log?.warn?.(`Neznámý zdroj „${key}“ – přeskakuji`);
      continue;
    }
    try {
      out.push(load());
    } catch (e) {
      log?.warn?.(`Zdroj ${LABELS[key] || key} nejde načíst – přeskakuji`, { error: e.message });
    }
  }
  return out;
}

module.exports = { loadSources, SOURCES, LABELS };
