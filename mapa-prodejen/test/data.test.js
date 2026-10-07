'use strict';
// Konzistence vygenerovaných dat (data/*.js): id, poloha v ČR, okresy a kraje, firmy k IČO, PSČ a obce, meta.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { readDataset } = require('../tools/lib/data-io.js');
const stav = require('../lib/stav.js');
const velikost = require('../lib/velikost.js');

const DATA = path.join(__dirname, '..', 'data');
const TYPY = ['prodejna', 'servis', 'pujcovna', 'bazar', 'retezec', 'firma'];
const SLUZBY = ['prodej', 'servis', 'pujcovna', 'ekola', 'bazar', 'eshop'];

test('data mapy prodejen jsou konzistentní', () => {
  const hranice = readDataset(DATA, 'hranice');
  const mista = readDataset(DATA, 'mista');
  const firmy = readDataset(DATA, 'firmy');
  const weby = readDataset(DATA, 'weby');
  const psc = readDataset(DATA, 'psc');
  const obce = readDataset(DATA, 'obce');
  const meta = readDataset(DATA, 'meta');
  assert.ok(hranice && mista && firmy && weby && psc && obce && meta, 'chybí data/*.js – npm run build-data');

  assert.strictEqual(hranice.kraje.features.length, 14);
  assert.strictEqual(hranice.okresy.features.length, 77); // 76 okresů + Praha
  const okresy = new Set(hranice.okresy.features.map((f) => f.properties.kod));
  const kraje = new Set(hranice.kraje.features.map((f) => f.properties.kod));
  for (const o of hranice.okresy.features) assert.ok(kraje.has(o.properties.kraj), 'okres bez kraje ' + o.properties.nazev);

  assert.ok(mista.length > 800, 'málo míst: ' + mista.length);
  const ids = new Set();
  for (const m of mista) {
    assert.ok(stav.isValidId(m.id), 'neplatné id ' + m.id);
    assert.ok(!ids.has(m.id), 'duplicitní id ' + m.id);
    ids.add(m.id);
    assert.ok(m.nazev, 'bez názvu ' + m.id);
    assert.ok(TYPY.includes(m.typ), 'neznámý typ ' + m.typ);
    assert.ok(m.lat > 48.5 && m.lat < 51.1 && m.lon > 12 && m.lon < 18.9, 'mimo ČR ' + m.id);
    assert.ok(okresy.has(m.okres) && kraje.has(m.kraj), 'místo mimo okres ' + m.id);
    assert.strictEqual(m.zdroj === 'ares', m.id[0] === 'a', 'zdroj/id ' + m.id);
    for (const k of Object.keys(m.sl || {})) assert.ok(SLUZBY.includes(k), 'neznámá služba ' + k);
    if (m.ico) {
      assert.match(m.ico, /^\d{8}$/);
      assert.ok(['osm', 'web', 'nazev', 'odhad', 'ares'].includes(m.icoZdroj), 'zdroj IČO ' + m.id);
    }
    for (const k of ['tel', 'mail', 'web', 'fb']) if (m[k]) assert.ok(Array.isArray(m[k]) && m[k].length, k + ' ' + m.id);
  }
  // každé IČO firmy z ARES (místo v sídle) má firmu; firmy mají známou velikost
  for (const m of mista) if (m.zdroj === 'ares') assert.ok(firmy[m.ico], 'firma chybí ' + m.ico);
  for (const [ico, f] of Object.entries(firmy)) {
    assert.strictEqual(f.ico, ico);
    assert.ok(velikost.VELIKOST[f.velikost], 'velikost ' + ico);
    assert.ok(f.nazev);
  }
  for (const [id, w] of Object.entries(weby)) {
    assert.ok(ids.has(id), 'web k neznámému místu ' + id);
    assert.ok(['ok', 'chyba'].includes(w.stav));
  }
  // PSČ → [lat, lon, okres, obec, kód obce]; obce → [název, okres, lat, lon, obyvatel, PSČ, kód]
  const pscKeys = Object.keys(psc);
  assert.ok(pscKeys.length > 2500);
  for (const k of pscKeys) {
    const p = psc[k];
    assert.match(k, /^[1-7]\d{4}$/);
    assert.ok(p[0] > 48.5 && p[0] < 51.1 && p[1] > 12 && p[1] < 18.9, 'PSČ mimo ČR ' + k);
    assert.ok(okresy.has(p[2]), 'PSČ bez okresu ' + k);
    assert.ok(p[3] && Number.isInteger(p[4]), 'PSČ bez obce ' + k);
  }
  assert.strictEqual(psc['60200'][3], 'Brno');
  assert.strictEqual(psc['11000'][3], 'Praha');
  assert.ok(obce.length > 6000);
  for (const o of obce) {
    assert.ok(okresy.has(o[1]), 'obec bez okresu ' + o[0]);
    assert.ok(!o[5] || psc[o[5]], 'obec s neznámým PSČ ' + o[0]);
  }
  assert.strictEqual(obce[0][0], 'Praha');
  assert.strictEqual(meta.pocty.mista, mista.length);
  assert.strictEqual(meta.pocty.firmy, Object.keys(firmy).length);
  assert.ok(Array.isArray(meta.zdroje) && meta.zdroje.length >= 4);
});
