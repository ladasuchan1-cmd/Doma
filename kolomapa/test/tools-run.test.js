'use strict';
// tools/run.js – argumenty a čitelné shrnutí běhu.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, formatSummary } = require('../tools/run');

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['--sources=bazos,sbazar', '--full', '--max-details=10']), { sources: 'bazos,sbazar', full: true, 'max-details': '10' });
  assert.throws(() => parseArgs(['bazos']), /Neznámý argument/);
});

test('formatSummary: zdroje, zpracování, chyby', () => {
  const text = formatSummary(
    {
      status: 'partial',
      stats: {
        sources: {
          bazos: { scanned: 1234, new: 56, changed: 7, details: 50, gone: 3, detailErrors: 0, mode: 'full', complete: true, error: null },
          aukro: { scanned: 0, new: 0, changed: 0, details: 0, gone: 0, mode: 'incremental', complete: false, error: 'HTTP 403' },
        },
        classified: 60,
        geocoded: 58,
        priced: 1200,
        pruned: 2,
      },
    },
    125000
  );
  assert.match(text, /částečně/);
  assert.match(text, /2 min 5 s/);
  assert.match(text, /Bazoš\s+1\s234 prošlo · 56 nových/);
  assert.match(text, /celý výpis/);
  assert.match(text, /Aukro .*jen novinky/);
  assert.match(text, /! HTTP 403/);
  assert.match(text, /60 klasifikováno · 58 s nově určenou polohou · 1\s200 naceněno · 2 starých smazáno/);
  assert.match(formatSummary({ status: 'error', error: 'Nelze načíst moduly' }, 500), /CHYBA[\s\S]*Nelze načíst moduly/);
});
