'use strict';
// Testy pravidel sestavení dat (tools/build-data.js): typ místa z OSM, výběr firem z ARES, IČO z webu, duplicity.
const test = require('node:test');
const assert = require('node:assert');
const b = require('../tools/build-data.js');

test('typ místa z OSM tagů', () => {
  assert.strictEqual(b.typOsm({ shop: 'bicycle', name: 'Cyklo X' }), 'prodejna');
  assert.strictEqual(b.typOsm({ shop: 'bicycle', 'service:bicycle:retail': 'no', 'service:bicycle:repair': 'yes' }), 'servis');
  assert.strictEqual(b.typOsm({ shop: 'bicycle', 'service:bicycle:repair': 'only' }), 'servis');
  assert.strictEqual(b.typOsm({ shop: 'bicycle', 'service:bicycle:second_hand': 'only' }), 'bazar');
  assert.strictEqual(b.typOsm({ shop: 'sports', name: 'SPORTISIMO Brno' }), 'retezec');
  assert.strictEqual(b.typOsm({ amenity: 'bicycle_rental', name: 'Půjčovna kol Lednice' }), 'pujcovna');
  assert.strictEqual(b.typOsm({ amenity: 'bicycle_rental', bicycle_rental: 'docking_station', name: 'Stanice' }), null);
  assert.strictEqual(b.typOsm({ amenity: 'bicycle_rental', network: 'nextbike', name: 'Nextbike 123' }), null);
  assert.strictEqual(b.typOsm({ amenity: 'bicycle_rental' }), null); // bez názvu
  assert.strictEqual(b.typOsm({ shop: 'rental', name: 'Půjčovna nářadí', rental: 'tools' }), null);
  assert.strictEqual(b.typOsm({ shop: 'rental', name: 'Rent', rental: 'bicycle;ski' }), 'pujcovna');
  assert.strictEqual(b.typOsm({ amenity: 'bicycle_repair_station', 'service:bicycle:repair': 'yes' }), null);
  assert.strictEqual(b.typOsm({ shop: 'motorcycle', 'service:bicycle:repair': 'yes' }), 'servis');
});

test('firmy z ARES: kola v názvu ano, spolky, ozubená kola a příjmení Kola ne', () => {
  const s = (obchodniJmeno, pravniForma, czNace) => ({ obchodniJmeno, pravniForma, czNace: czNace || [] });
  assert.ok(b.relevantniAres(s('CYKLO Kučera, s.r.o.', '112')));
  assert.ok(b.relevantniAres(s('Kola Bárta s.r.o.', '112')));
  assert.ok(b.relevantniAres(s('Jízdní kola CZ s. r. o.', '112')));
  assert.ok(b.relevantniAres(s('VELO CZ s.r.o.', '112', ['46900'])));
  assert.ok(!b.relevantniAres(s('VELO - MONT, s.r.o.', '112', ['41000'])));
  assert.ok(!b.relevantniAres(s('JH CYKLO TEAM TŘEBOŇ z.s.', '706')));
  assert.ok(!b.relevantniAres(s('Ozubená kola s.r.o.', '112', ['47'])));
  assert.ok(!b.relevantniAres(s('Martin Kola', '101', ['952'])));
  assert.ok(!b.relevantniAres(s('Café VELO Cukrovar s.r.o.', '112', ['47'])));
  assert.ok(!b.relevantniAres(s('Cykloservis Tomáš Binar s.r.o. "v likvidaci"', '112')));
  assert.ok(!b.relevantniAres({ ...s('Cyklo Old s.r.o.', '112'), datumZaniku: '2020-01-01' }));
});

test('podobnost názvů bez právní formy a výplňových slov', () => {
  assert.strictEqual(b.nameSim('Cyklo Kučera', 'CYKLO Kučera, s.r.o.'), 1);
  assert.strictEqual(b.nameSim('Bike Shop', 'Bike s.r.o.'), 0);
  assert.ok(b.nameSim('Kola Bárta Praha', 'Kola Bárta s.r.o.') >= 0.99);
});

test('IČO z webu: cizí IČO (ČOI, banka, opakované) se ignoruje, rozhodne shoda názvu', () => {
  const firmy = {
    '00020869': { nazev: 'Česká obchodní inspekce', forma: '325' },
    11111111: { nazev: 'Banka a.s.', forma: '121', nace: ['64190'] },
    22222222: { nazev: 'Cyklo Novák s.r.o.', forma: '112' },
    33333333: { nazev: 'Webdesign s.r.o.', forma: '112' },
  };
  const m = { nazev: 'Cyklo Novák' };
  const w = (ico) => ({ stav: 'ok', web: 'https://www.cyklonovak.cz/', ico });
  assert.strictEqual(b.vyberIcoZWebu(m, w(['00020869', '33333333', '22222222']), firmy, new Set()), '22222222');
  assert.strictEqual(b.vyberIcoZWebu(m, w(['00020869']), firmy, new Set()), null);
  assert.strictEqual(b.vyberIcoZWebu(m, w(['11111111']), firmy, new Set()), null);
  assert.strictEqual(b.vyberIcoZWebu(m, w(['33333333']), firmy, new Set()), '33333333'); // jediné IČO na webu
  assert.strictEqual(b.vyberIcoZWebu(m, w(['33333333', '44444444']), firmy, new Set()), null); // víc IČO bez shody
  assert.strictEqual(b.vyberIcoZWebu(m, w(['22222222']), firmy, new Set(['22222222'])), null); // IČO na 3+ webech
  assert.ok(b.CIZI_ICO.has('00020869'));
});

test('sloučení duplicit z OSM: stejný název do 200 m', () => {
  const mk = (id, lat, extra) => ({ id, nazev: 'Bikestore.cz', lat, lon: 14.3, sl: {}, tel: [], mail: [], web: [], fb: [], ...extra });
  const out = b.sloucitDuplicity([mk('n1', 50.0, { tel: ['+420 111 222 333'] }), mk('w2', 50.001, { web: ['https://bikestore.cz/'], sl: { servis: 'osm' } }), mk('n3', 50.1)]);
  assert.strictEqual(out.length, 2);
  const a = out.find((m) => m.id === 'w2');
  assert.deepStrictEqual(a.tel, ['+420 111 222 333']);
  assert.strictEqual(a.sl.servis, 'osm');
});
