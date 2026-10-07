'use strict';
// Testy modelu stavu spolupráce (lib/stav.js).
const test = require('node:test');
const assert = require('node:assert');
const s = require('../lib/stav.js');

test('prázdný záznam a isEmpty', () => {
  const r = s.emptyRecord();
  assert.ok(s.isEmpty(r));
  assert.ok(!s.isEmpty({ ...r, vytipovano: true }));
  assert.ok(!s.isEmpty({ ...r, poznamka: 'x' }));
  assert.ok(!s.isEmpty({ ...r, skryto: true }));
  assert.ok(!s.isEmpty({ ...r, spoluprace: 'servis' }));
  assert.ok(s.isEmpty({ ...r, poznamka: '   ' }));
});

test('toggleStav zapíše datum a partner / nemá zájem se vylučují', () => {
  let r = s.toggleStav(null, 'vytipovano', true, '2026-10-07T08:00:00Z');
  assert.strictEqual(r.vytipovano, true);
  assert.strictEqual(r.datumy.vytipovano, '2026-10-07');
  r = s.toggleStav(r, 'partner', true, '2026-10-08T08:00:00Z');
  r = s.toggleStav(r, 'odmitl', true, '2026-10-09T08:00:00Z');
  assert.strictEqual(r.odmitl, true);
  assert.strictEqual(r.partner, false);
  assert.strictEqual(r.datumy.partner, undefined);
  r = s.toggleStav(r, 'partner', true, '2026-10-10T08:00:00Z');
  assert.strictEqual(r.partner, true);
  assert.strictEqual(r.odmitl, false);
  assert.strictEqual(s.faze(r), 'partner');
  r = s.toggleStav(r, 'vytipovano', false);
  assert.strictEqual(r.datumy.vytipovano, undefined);
  assert.throws(() => s.toggleStav(r, 'neco', true));
});

test('setPole: IČO jen číslice, typ spolupráce z číselníku, skrytí', () => {
  let r = s.setPole(null, 'ico', ' 031 48 807 ');
  assert.strictEqual(r.ico, '03148807');
  r = s.setPole(r, 'spoluprace', 'vydej');
  assert.strictEqual(r.spoluprace, 'vydej');
  r = s.setPole(r, 'spoluprace', 'nesmysl');
  assert.strictEqual(r.spoluprace, '');
  r = s.setPole(r, 'skryto', true);
  assert.strictEqual(r.skryto, true);
  assert.throws(() => s.setPole(r, 'heslo', 'x'));
});

test('normalizeRecord zahodí neznámé klíče a ořízne délky', () => {
  const r = s.normalizeRecord({ partner: 'true', poznamka: 'x'.repeat(5000), zlo: '<script>', datumy: { partner: '2026-01-02T00:00', volano: 'nesmysl' }, kdo: 'a'.repeat(100) });
  assert.strictEqual(r.partner, true);
  assert.strictEqual(r.poznamka.length, 4000);
  assert.strictEqual(r.zlo, undefined);
  assert.deepStrictEqual(r.datumy, { partner: '2026-01-02' });
  assert.strictEqual(r.kdo.length, 60);
});

test('merge: vyhraje novější úprava, prázdné záznamy zmizí', () => {
  const a = { n1: { ...s.emptyRecord(), vytipovano: true, upraveno: '2026-10-01T10:00:00Z' }, n2: { ...s.emptyRecord(), poznamka: 'a', upraveno: '2026-10-05T10:00:00Z' } };
  const b = { n1: { ...s.emptyRecord(), osloveno: true, upraveno: '2026-10-02T10:00:00Z' }, n2: { ...s.emptyRecord(), poznamka: 'b', upraveno: '2026-10-04T10:00:00Z' }, n3: s.emptyRecord() };
  const m = s.merge(a, b);
  assert.strictEqual(m.n1.osloveno, true);
  assert.strictEqual(m.n1.vytipovano, false);
  assert.strictEqual(m.n2.poznamka, 'a');
  assert.ok(!('n3' in m));
});

test('platná id míst: OSM, firma z ARES, ručně přidané', () => {
  for (const id of ['n123', 'w5', 'r77', 'a03148807', 'vabc123xyz']) assert.ok(s.isValidId(id), id);
  for (const id of ['x1', 'a123', 'n', 'v12', '../etc', 'n1;rm', 'vABCDEFG']) assert.ok(!s.isValidId(id), id);
});

test('export / import JSON a sloučení', () => {
  const st = { n1: s.toggleStav(null, 'partner', true), bad: { partner: true } };
  const ex = s.exportJson(st);
  assert.strictEqual(ex.app, 'mapa-prodejen');
  assert.deepStrictEqual(Object.keys(ex.stav), ['n1']);
  const im = s.importJson(JSON.parse(JSON.stringify(ex)));
  assert.strictEqual(im.pocet, 1);
  assert.ok(s.importJson(null).chyba);
  assert.ok(s.importJson({ app: 'x' }).chyba);
});

test('efektivní kontakt: ruční > OSM > web', () => {
  const misto = { tel: ['+420 111 222 333'], mail: [], web: ['https://a.cz/'], ico: '03148807' };
  const web = { stav: 'ok', emaily: ['info@a.cz', 'b@a.cz', 'c@a.cz'], telefony: ['+420 999 888 777'], web: 'https://a.cz/' };
  let e = s.efektivni(misto, null, web);
  assert.strictEqual(e.telefon, '+420 111 222 333');
  assert.strictEqual(e.email, 'info@a.cz, b@a.cz');
  assert.strictEqual(e.ico, '03148807');
  e = s.efektivni(misto, { ...s.emptyRecord(), telefon: '+420 777 000 111', ico: '27082440' }, web);
  assert.strictEqual(e.telefon, '+420 777 000 111');
  assert.strictEqual(e.ico, '27082440');
  e = s.efektivni({ tel: [], mail: [] }, null, { stav: 'chyba', emaily: ['x@y.cz'] });
  assert.strictEqual(e.email, '');
});
