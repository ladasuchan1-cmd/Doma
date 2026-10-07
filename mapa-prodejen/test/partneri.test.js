'use strict';
// Testy hledání partnerů (lib/partneri.js): vzdálenosti, mřížka, poptávka v okolí, skóre, obce, bílá místa.
const test = require('node:test');
const assert = require('node:assert');
const p = require('../lib/partneri.js');

test('vzdálenost Praha – Brno ≈ 185 km', () => {
  const d = p.km(50.0875, 14.4214, 49.1951, 16.6068);
  assert.ok(d > 180 && d < 190, String(d));
  assert.strictEqual(p.km(49, 16, 49, 16), 0);
});

test('mřížka: body v okruhu seřazené podle vzdálenosti, nejbližší', () => {
  const body = [
    { id: 'a', lat: 50.0, lon: 14.0 },
    { id: 'b', lat: 50.05, lon: 14.0 }, // ~5,6 km
    { id: 'c', lat: 50.2, lon: 14.0 }, // ~22 km
    { id: 'd', lat: 49.0, lon: 17.0 },
  ];
  const g = p.mrizka(body);
  const r = g.okruh(50.0, 14.0, 10);
  assert.deepStrictEqual(r.map(([b]) => b.id), ['a', 'b']);
  assert.ok(Math.abs(r[1][1] - 5.56) < 0.1);
  assert.strictEqual(g.nejblizsi(50.19, 14.0, 5)[0].id, 'c');
  assert.strictEqual(g.nejblizsi(48.0, 12.0, 5), null);
  assert.strictEqual(g.size, 4);
});

test('poptávka: součet objednávek do okruhu', () => {
  const g = p.mrizka([
    { lat: 50.0, lon: 14.0, n: 10, kc: 1000 },
    { lat: 50.05, lon: 14.0, n: 5, kc: 500 },
    { lat: 50.5, lon: 14.0, n: 100, kc: 0 },
  ]);
  assert.deepStrictEqual(p.poptavka(50.0, 14.0, g, 15), { n: 15, kc: 1500 });
  assert.deepStrictEqual(p.poptavka(50.0, 14.0, g, 1), { n: 10, kc: 1000 });
});

test('skóre: složky a součet 0–100', () => {
  const max = p.skore({ poptavka: 100, maxPoptavka: 100, servis: true, partnerKm: null, radiusKm: 15, email: true, telefon: true });
  assert.strictEqual(max.body, 100);
  assert.strictEqual(max.slozky[0].label, 'Objednávky v okolí');
  assert.strictEqual(p.skore({ poptavka: 1, maxPoptavka: 1, popisek: 'Zákazníci v okolí' }).slozky[0].label, 'Zákazníci v okolí');
  assert.deepStrictEqual(max.slozky.map((s) => s.key), ['poptavka', 'servis', 'pokryti', 'kontakt']);
  const min = p.skore({ poptavka: 0, maxPoptavka: 100, servis: false, partnerKm: 0, radiusKm: 15 });
  assert.strictEqual(min.body, 0);
  const mid = p.skore({ poptavka: 25, maxPoptavka: 100, servis: null, partnerKm: 7.5, radiusKm: 15, email: true });
  assert.strictEqual(mid.slozky[0].body, 25); // 50 × √0,25
  assert.strictEqual(mid.slozky[1].body, 8);
  assert.strictEqual(mid.slozky[2].body, 10);
  assert.strictEqual(mid.slozky[3].body, 6);
  assert.strictEqual(mid.body, 49);
});

test('obce z PSČ a bílá místa', () => {
  const psc = {
    60200: [49.2, 16.6, 3702, 'Brno', 582786],
    61200: [49.22, 16.58, 3702, 'Brno', 582786],
    26601: [49.97, 14.07, 3202, 'Beroun', 531057],
  };
  const { obce, nezname } = p.obce([{ psc: '60200', n: 3, kc: 300 }, { psc: '61200', n: 1, kc: 100 }, { psc: '26601', n: 2 }, { psc: '99999', n: 7 }], psc);
  assert.strictEqual(nezname, 7);
  assert.strictEqual(obce[0].nazev, 'Brno');
  assert.strictEqual(obce[0].key, '582786');
  assert.strictEqual(obce[0].n, 4);
  assert.strictEqual(obce[0].kc, 400);
  assert.ok(Math.abs(obce[0].lat - 49.205) < 0.001);
  assert.deepStrictEqual(obce[0].psc, ['60200', '61200']);
  const kryti = p.mrizka([{ lat: 49.2, lon: 16.6 }]);
  const bila = p.bilaMista(obce, kryti, 15, 2);
  assert.deepStrictEqual(bila.map((o) => o.nazev), ['Beroun']);
  assert.deepStrictEqual(p.bilaMista(obce, p.mrizka([]), 15, 3).map((o) => o.nazev), ['Brno']);
});
