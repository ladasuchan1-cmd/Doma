'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLocation, krajAt, krajFromText, jitter, KRAJ_POINT, KRAJE } = require('../src/geo');

test('krajAt: krajská města leží ve správném kraji, mimo ČR null', () => {
  assert.equal(krajAt(50.08, 14.42), 'PHA');
  assert.equal(krajAt(49.19, 16.6), 'JHM');
  assert.equal(krajAt(49.83, 18.28), 'MSK');
  assert.equal(krajAt(49.43, 15.22), 'VYS');
  assert.equal(krajAt(50.08, 12.37), 'KVK');
  assert.equal(krajAt(50.77, 15.05), 'LBK');
  assert.equal(krajAt(49.22, 17.67), 'ZLK');
  assert.equal(krajAt(52.52, 13.4), null); // Berlín
});

test('KRAJ_POINT: reprezentativní bod leží uvnitř svého kraje', () => {
  for (const [code, [lat, lon]] of Object.entries(KRAJ_POINT)) assert.equal(krajAt(lat, lon), code, code);
  assert.equal(Object.keys(KRAJE).length, 14);
});

test('krajFromText', () => {
  assert.equal(krajFromText('Jihomoravský kraj'), 'JHM');
  assert.equal(krajFromText('Kraj Vysočina'), 'VYS');
  assert.equal(krajFromText('Hlavní město Praha'), 'PHA');
  assert.equal(krajFromText('msk'), 'MSK');
  assert.equal(krajFromText('Brno'), null);
});

const CASES = [
  [{ locationText: 'Pelhřimov', psc: '393 01' }, 'VYS', 'Pelhřimov'],
  [{ locationText: 'Praha 4' }, 'PHA', 'Praha 4'],
  [{ locationText: 'Praha 4 - Chodov' }, 'PHA', 'Praha 4-Chodov'],
  [{ locationText: 'Brno - Královo Pole' }, 'JHM', 'Brno-Královo Pole'],
  [{ locationText: 'Ústí n. L.' }, 'ULK', 'Ústí nad Labem'],
  [{ locationText: 'Jablonec n. N.' }, 'LBK', 'Jablonec nad Nisou'],
  [{ locationText: 'Rožnov p. R.' }, 'ZLK', 'Rožnov pod Radhoštěm'],
  [{ locationText: 'Frýdek - Místek', psc: '73801' }, 'MSK', 'Frýdek-Místek'],
  [{ locationText: 'Brno, Jihomoravský kraj' }, 'JHM', 'Brno'],
  [{ locationText: 'Nová Ves', psc: '67171' }, 'JHM', 'Nová Ves'],
];

test('resolveLocation: obce, části, zkratky, PSČ', () => {
  for (const [loc, kraj, place] of CASES) {
    const r = resolveLocation(loc);
    assert.equal(r.kraj, kraj, JSON.stringify(loc));
    assert.equal(r.place, place, JSON.stringify(loc));
    assert.ok(['city', 'psc'].includes(r.precision));
    assert.ok(r.lat > 48 && r.lat < 52 && r.lon > 12 && r.lon < 19);
  }
});

test('resolveLocation: souřadnice z webu mají přednost', () => {
  const r = resolveLocation({ lat: 49.289978, lon: 16.575022, locationText: 'Brno venkov', psc: '664 31' });
  assert.equal(r.precision, 'exact');
  assert.equal(r.kraj, 'JHM');
});

test('resolveLocation: okres (Bazoš uvádí okres), kraj, nic', () => {
  const okres = resolveLocation({ locationText: 'Brno venkov' });
  assert.equal(okres.kraj, 'JHM');
  assert.equal(okres.precision, 'okres');
  const pv = resolveLocation({ locationText: 'Praha - východ' });
  assert.equal(pv.kraj, 'STC');
  const kraj = resolveLocation({ locationText: 'Kraj Vysočina' });
  assert.deepEqual([kraj.kraj, kraj.precision], ['VYS', 'kraj']);
  const none = resolveLocation({ locationText: 'xyzzy' });
  assert.equal(none.precision, null);
  assert.equal(none.lat, null);
});

test('resolveLocation: samotné PSČ', () => {
  const r = resolveLocation({ psc: '60200' });
  assert.equal(r.kraj, 'JHM');
  assert.equal(r.precision, 'psc');
});

test('jitter: deterministický, malý, u exact beze změny', () => {
  const a = jitter(49.4, 15.2, 'city', 'bazos:1');
  assert.deepEqual(a, jitter(49.4, 15.2, 'city', 'bazos:1'));
  assert.notDeepEqual(a, jitter(49.4, 15.2, 'city', 'bazos:2'));
  assert.ok(Math.abs(a[0] - 49.4) < 0.005 && Math.abs(a[1] - 15.2) < 0.01);
  assert.deepEqual(jitter(49.4, 15.2, 'exact', 'x'), [49.4, 15.2]);
});

test('resolveLocation: okresní štítek Bazoše + PSČ → PSČ', () => {
  const r = resolveLocation({ locationText: 'Praha - východ', psc: '25101' });
  assert.equal(r.kraj, 'STC');
  assert.equal(r.precision, 'psc');
});
