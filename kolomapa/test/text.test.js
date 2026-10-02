'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('../src/util/text');

test('parseCzk', () => {
  assert.equal(t.parseCzk('170 000 Kč'), 170000);
  assert.equal(t.parseCzk('12.500,-'), 12500);
  assert.equal(t.parseCzk('12 tis.'), 12000);
  assert.equal(t.parseCzk('45k'), 45000);
  assert.equal(t.parseCzk('Dohodou'), null);
  assert.equal(t.parseCzk('  8 990 Kč'), 8990);
  assert.equal(t.parseCzk(3000), 3000);
});

test('htmlToText / decodeEntities', () => {
  assert.equal(t.htmlToText('a<br>b&nbsp;c &amp; d<p>e</p>'), 'a\nb c & d\ne');
  assert.equal(t.decodeEntities('&#353;&#x161;&quot;'), 'šš"');
});

test('fold, keyOf, parseCzDate, parsePsc, hash, truncate', () => {
  assert.equal(t.fold('Ústí nad Labem'), 'usti nad labem');
  assert.equal(t.keyOf('Brno - Královo Pole!'), 'brno kralovo pole');
  assert.equal(t.parseCzDate('[2.10. 2026]'), '2026-10-02');
  assert.equal(t.parsePsc('Pelhřimov 393 01'), '39301');
  assert.equal(t.parsePsc('12'), null);
  assert.equal(t.hash('a'), t.hash('a'));
  assert.notEqual(t.hash('a'), t.hash('b'));
  assert.equal(t.truncate('jedna dva tři čtyři', 10), 'jedna dva…');
});

test('scrubContacts: skryje telefony a e-maily, ceny a roky nechá', () => {
  const s = t.scrubContacts('Volejte 777 123 456 nebo +420 602-111-222, mail jan.novak@seznam.cz. Cena 12 500 Kč, rok 2021, 150 000 Kč, rám 19".');
  assert.ok(!s.includes('777 123 456'));
  assert.ok(!s.includes('602-111-222'));
  assert.ok(!s.includes('seznam.cz'));
  assert.ok(s.includes('12 500 Kč') && s.includes('2021') && s.includes('150 000 Kč'));
  assert.equal(t.scrubContacts(null), null);
});
