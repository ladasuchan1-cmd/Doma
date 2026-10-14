'use strict';
// Testy pomocných funkcí zdrojů dat (tools/lib/sources.js) – bez sítě.
const test = require('node:test');
const assert = require('node:assert');
const src = require('../tools/lib/sources.js');

test('planetDatum – datum snímku planety z popisu indexu QLeveru', () => {
  const popis = 'OpenStreetMap, PBF from https://planet.openstreetmap.org/pbf/planet-260921.osm.pbf, converted to RDF TTL and enhanced by DE-9IM triples using osm2rdf';
  assert.strictEqual(src.planetDatum(popis), '2026-09-21');
  assert.strictEqual(src.planetDatum('planet-251231.osm.pbf'), '2025-12-31');
  assert.strictEqual(src.planetDatum(''), null);
  assert.strictEqual(src.planetDatum(undefined), null);
  assert.strictEqual(src.planetDatum('planet-latest.osm.pbf'), null);
  assert.strictEqual(src.planetDatum('planet-261321.osm.pbf'), null); // měsíc 13
  assert.strictEqual(src.planetDatum('planet-260900.osm.pbf'), null); // den 0
});

test('qleverStatsUrl – statistiky ze stejného endpointu jako dotazy', () => {
  assert.strictEqual(src.qleverStatsUrl(), `${src.QLEVER_ENDPOINT}?cmd=stats`);
});
