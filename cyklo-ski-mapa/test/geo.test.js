'use strict';
// Testy geometrie (lib/geo.js): WKT, zjednodušení, bod v polygonu, vzdálenosti, mřížkový index.
const test = require('node:test');
const assert = require('node:assert');
const geo = require('../lib/geo.js');

test('parseWkt – bod, linie, polygon, kolekce', () => {
  assert.deepStrictEqual(geo.parseWkt('POINT(14.5 50.1)').points, [[14.5, 50.1]]);
  const l = geo.parseWkt('LINESTRING(14 50, 14.1 50.1, 14.2 50.2)');
  assert.strictEqual(l.lines.length, 1);
  assert.strictEqual(l.lines[0].length, 3);
  const p = geo.parseWkt('POLYGON((0 0, 1 0, 1 1, 0 1, 0 0),(0.2 0.2, 0.4 0.2, 0.4 0.4, 0.2 0.2))');
  assert.strictEqual(p.polygons.length, 1);
  assert.strictEqual(p.polygons[0].length, 2);
  const gc = geo.parseWkt('GEOMETRYCOLLECTION(POINT(1 2),LINESTRING(1 2,3 4),LINESTRING(3 4,5 6,7 8))');
  assert.strictEqual(gc.points.length, 1);
  assert.strictEqual(gc.lines.length, 2);
  assert.strictEqual(gc.lines[1].length, 3);
  const mp = geo.parseWkt('MULTIPOLYGON(((0 0,1 0,1 1,0 0)),((2 2,3 2,3 3,2 2)))');
  assert.strictEqual(mp.polygons.length, 2);
  assert.deepStrictEqual(geo.parseWkt('POINT EMPTY'), { points: [], lines: [], polygons: [] });
  assert.deepStrictEqual(geo.parseWkt(''), { points: [], lines: [], polygons: [] });
  assert.deepStrictEqual(geo.parseWkt('"POINT(1 2)"').points, []); // uvozovky nejsou WKT – nic nespadne
});

test('haversine a délka linie', () => {
  // Praha – Brno ≈ 185 km
  const d = geo.haversineM(50.0755, 14.4378, 49.1951, 16.6068);
  assert.ok(d > 180000 && d < 190000, String(d));
  const km = geo.lineLengthKm([[14.4378, 50.0755], [16.6068, 49.1951]]);
  assert.ok(Math.abs(km - d / 1000) < 1e-9);
  assert.strictEqual(geo.lineLengthKm([[1, 1]]), 0);
});

test('vzdálenost bodu od úsečky v metrech', () => {
  // bod 0.01° severně od úsečky na 50° s. š. ≈ 1113 m
  const d = geo.distToSegmentM(14.5, 50.01, 14.4, 50, 14.6, 50);
  assert.ok(Math.abs(d - 1113.2) < 5, String(d));
  // bod za koncem úsečky – vzdálenost ke konci, ne k přímce
  const d2 = geo.distToSegmentM(14.7, 50, 14.4, 50, 14.6, 50);
  const expect = geo.haversineM(50, 14.7, 50, 14.6);
  assert.ok(Math.abs(d2 - expect) / expect < 0.01, `${d2} vs ${expect}`);
});

test('simplify – zachová koncové body a vrcholy nad tolerancí', () => {
  const line = [];
  for (let i = 0; i <= 100; i++) line.push([14 + i * 0.001, 50 + (i % 2 ? 0.00001 : 0)]); // téměř přímka s drobným šumem
  line[50] = [14.05, 50.01]; // výrazný vrchol (≈1,1 km)
  const s = geo.simplify(line, 30);
  assert.deepStrictEqual(s[0], line[0]);
  assert.deepStrictEqual(s[s.length - 1], line[100]);
  assert.ok(s.some((p) => p[0] === 14.05 && p[1] === 50.01));
  assert.ok(s.length < 10, String(s.length));
  assert.deepStrictEqual(geo.simplify([[1, 1], [2, 2]], 10), [[1, 1], [2, 2]]);
  assert.strictEqual(geo.simplify(line, 0).length, line.length);
});

test('bod v polygonu včetně díry a MultiPolygonu', () => {
  const rings = [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
  ];
  assert.ok(geo.pointInPolygon(1, 1, rings));
  assert.ok(!geo.pointInPolygon(5, 5, rings)); // v díře
  assert.ok(!geo.pointInPolygon(11, 5, rings));
  const multi = { type: 'MultiPolygon', coordinates: [[rings[0]], [[[20, 20], [30, 20], [30, 30], [20, 20]]]] };
  assert.ok(geo.pointInGeometry(25, 22, multi));
  assert.ok(!geo.pointInGeometry(15, 15, multi));
  assert.ok(geo.pointInGeometry(1, 1, { type: 'Polygon', coordinates: rings }));
  assert.ok(!geo.pointInGeometry(1, 1, null));
});

test('bbox a těžiště', () => {
  const b = geo.bboxOf([[1, 2], [3, -1], [0, 5]]);
  assert.deepStrictEqual(b, [0, -1, 3, 5]);
  assert.ok(geo.bboxContains(b, 1, 1));
  assert.ok(!geo.bboxContains(b, 4, 1));
  const gb = geo.bboxOfGeometry({ type: 'MultiPolygon', coordinates: [[[[0, 0], [2, 0], [2, 2], [0, 0]]], [[[5, 5], [6, 5], [6, 7], [5, 5]]]] });
  assert.deepStrictEqual(gb, [0, 0, 6, 7]);
  const c = geo.centroid(geo.parseWkt('POLYGON((0 0,2 0,2 2,0 2,0 0))'));
  assert.ok(Math.abs(c[0] - 1) < 1e-9 && Math.abs(c[1] - 1) < 1e-9);
  const cl = geo.centroid(geo.parseWkt('LINESTRING(0 0,2 2)'));
  assert.deepStrictEqual(cl, [1, 1]);
  assert.deepStrictEqual(geo.centroid(geo.parseWkt('POINT(3 4)')), [3, 4]);
  assert.strictEqual(geo.centroid(geo.parseWkt('')), null);
});

test('SegmentGrid – nejbližší linie a linie v okruhu', () => {
  const grid = new geo.SegmentGrid(0.02);
  grid.addLine([[14.0, 50.0], [14.2, 50.0]], 'A'); // rovnoběžka 50°
  grid.addLine([[14.0, 50.05], [14.2, 50.05]], 'B'); // o 0,05° severněji (≈5,6 km)
  const near = grid.nearest(14.1, 50.005, 10000);
  assert.strictEqual(near.ref, 'A');
  assert.ok(Math.abs(near.dist - 556.6) < 5, String(near.dist));
  const within = grid.within(14.1, 50.005, 10000);
  assert.deepStrictEqual([...within.keys()].sort(), ['A', 'B']);
  assert.ok(within.get('B') > 4900 && within.get('B') < 5100, String(within.get('B')));
  assert.strictEqual(grid.nearest(14.1, 50.005, 300), null);
  assert.strictEqual(grid.within(16, 48, 1000).size, 0);
  assert.strictEqual(grid.count, 2);
});

test('toLatLng a round', () => {
  assert.deepStrictEqual(geo.toLatLng([[14.123456789, 50.987654321]]), [[50.98765, 14.12346]]);
  assert.strictEqual(geo.round(1.23456789, 3), 1.235);
});
