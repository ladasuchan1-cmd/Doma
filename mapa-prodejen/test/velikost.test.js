'use strict';
// Testy kategorie velikosti firmy (lib/velikost.js).
const test = require('node:test');
const assert = require('node:assert');
const v = require('../lib/velikost.js');

test('kategorie podle počtu zaměstnanců (číselník ČSÚ)', () => {
  assert.strictEqual(v.zeZamestnancu('110'), 'mikro');
  assert.strictEqual(v.zeZamestnancu('120'), 'mala');
  assert.strictEqual(v.zeZamestnancu('130'), 'mala');
  assert.strictEqual(v.zeZamestnancu('210'), 'stredni');
  assert.strictEqual(v.zeZamestnancu('230'), 'stredni');
  assert.strictEqual(v.zeZamestnancu('240'), 'velka');
  assert.strictEqual(v.zeZamestnancu('510'), 'velka');
  assert.strictEqual(v.zeZamestnancu(120), 'mala');
  assert.strictEqual(v.zeZamestnancu('000', '112'), null);
  assert.strictEqual(v.zeZamestnancu('000', '101'), 'mikro'); // OSVČ bez údaje
  assert.strictEqual(v.zeZamestnancu(null, null), null);
  assert.strictEqual(v.zeZamestnancu('999'), null);
  assert.strictEqual(v.zamestnanciText('230'), '25–49 zaměstnanců');
  assert.strictEqual(v.zamestnanciText(''), '');
});

test('kategorie podle obratu – prázdný obrat není 0 Kč', () => {
  assert.strictEqual(v.zObratu(null), null);
  assert.strictEqual(v.zObratu(undefined), null);
  assert.strictEqual(v.zObratu(''), null);
  assert.strictEqual(v.zObratu(0), 'mikro');
  assert.strictEqual(v.zObratu(2.9e6), 'mikro');
  assert.strictEqual(v.zObratu(3e6), 'mala');
  assert.strictEqual(v.zObratu(20e6), 'stredni');
  assert.strictEqual(v.zObratu(100e6), 'velka');
  assert.strictEqual(v.zObratu(-5), null);
});

test('čtení obratu zadaného člověkem', () => {
  assert.strictEqual(v.parseObrat('45 mil'), 45e6);
  assert.strictEqual(v.parseObrat('45,5 mil. Kč'), 45.5e6);
  assert.strictEqual(v.parseObrat('1,2 mld'), 1.2e9);
  assert.strictEqual(v.parseObrat('800 tis.'), 800e3);
  assert.strictEqual(v.parseObrat('12 345 678'), 12345678);
  assert.strictEqual(v.parseObrat('1.234.567,89 Kč'), 1234568);
  assert.strictEqual(v.parseObrat('4,5', 'mil'), 4.5e6);
  assert.strictEqual(v.parseObrat(12345, 'tis'), 12345000);
  assert.strictEqual(v.parseObrat('nevím'), null);
  assert.strictEqual(v.parseObrat(''), null);
  assert.strictEqual(v.fmtObrat(45.5e6), '45,5 mil. Kč');
});

test('výsledná velikost: obrat má přednost, důvod je čitelný', () => {
  let r = v.urci({ zam: '120', forma: '112', obrat: 150e6, rok: 2024, ico: '1' });
  assert.strictEqual(r.key, 'velka');
  assert.match(r.duvod, /obrat .*2024/);
  r = v.urci({ zam: '210', forma: '112', ico: '1' });
  assert.deepStrictEqual(r, { key: 'stredni', duvod: 'ČSÚ: 10–19 zaměstnanců' });
  r = v.urci({ zam: null, forma: null, obrat: null, ico: '' });
  assert.strictEqual(r.key, 'neznama');
  r = v.urci({ zam: '000', forma: '112', ico: '1' });
  assert.strictEqual(r.key, 'neznama');
  r = v.urci({ zam: '000', forma: '101', ico: '1' });
  assert.strictEqual(r.key, 'mikro');
  assert.strictEqual(v.VELIKOSTI.length, 5);
});
