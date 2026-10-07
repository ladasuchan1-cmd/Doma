'use strict';
// Testy ručně přidaných míst a obratů (lib/vlastni.js).
const test = require('node:test');
const assert = require('node:assert');
const v = require('../lib/vlastni.js');

test('IČO: kontrolní součet a doplnění nul', () => {
  assert.strictEqual(v.normIco('3148807'), '03148807');
  assert.strictEqual(v.normIco('270 82 440'), '27082440');
  assert.strictEqual(v.normIco('27082441'), '');
  assert.strictEqual(v.normIco(''), '');
  assert.ok(v.validIco('00006947'));
  assert.ok(!v.validIco('00000000'));
});

test('ruční místo: povinný název a poloha v ČR, očištění polí', () => {
  assert.match(v.normalizeMisto({ lat: 50, lon: 14 }).chyba, /název/);
  assert.match(v.normalizeMisto({ nazev: 'X', lat: 40, lon: 14 }).chyba, /Česku/);
  assert.match(v.normalizeMisto({ nazev: 'X', lat: 50, lon: 14, ico: '12345678' }).chyba, /IČO/);
  const { misto } = v.normalizeMisto({
    nazev: '  Cyklo Test  ',
    typ: 'nesmysl',
    lat: 50.123456789,
    lon: 14.5,
    ico: '3148807',
    tel: '+420 777 111 222; +420 777 111 222',
    mail: 'a@b.cz, spatny',
    web: 'cyklotest.cz',
    sl: { servis: true, ekola: 'ano', hack: true },
    poznamka: 'x'.repeat(3000),
    zlo: 1,
  });
  assert.strictEqual(misto.nazev, 'Cyklo Test');
  assert.strictEqual(misto.typ, 'prodejna');
  assert.strictEqual(misto.lat, 50.12346);
  assert.strictEqual(misto.ico, '03148807');
  assert.deepStrictEqual(misto.tel, ['+420 777 111 222']);
  assert.deepStrictEqual(misto.mail, ['a@b.cz']);
  assert.deepStrictEqual(misto.web, ['https://cyklotest.cz/']);
  assert.deepStrictEqual(misto.sl, { servis: true, ekola: true });
  assert.strictEqual(misto.poznamka.length, 2000);
  assert.strictEqual(misto.zlo, undefined);
  assert.match(misto.id, /^v[0-9a-z]{10}$/);
  assert.strictEqual(v.normalizeMisto({ nazev: 'X', lat: 50, lon: 14 }, 'vabcdef12').misto.id, 'vabcdef12');
});

test('obrat: číslo v Kč a rozumný rok', () => {
  assert.deepStrictEqual(Object.keys(v.normalizeObrat({ obrat: 45e6, rok: 2024, zdroj: 'závěrka' }).obrat).sort(), ['kdo', 'obrat', 'rok', 'upraveno', 'zdroj']);
  assert.strictEqual(v.normalizeObrat({ obrat: '1000', rok: '' }).obrat.rok, null);
  assert.ok(v.normalizeObrat({ obrat: -1 }).chyba);
  assert.ok(v.normalizeObrat({ obrat: 'hodně' }).chyba);
  assert.ok(v.normalizeObrat({ obrat: 1, rok: 1900 }).chyba);
});
