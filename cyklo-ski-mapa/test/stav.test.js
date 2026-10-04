'use strict';
// Testy modelu stavu oslovení (lib/stav.js).
const test = require('node:test');
const assert = require('node:assert');
const stav = require('../lib/stav.js');

test('prázdný záznam a isEmpty', () => {
  const r = stav.emptyRecord();
  assert.ok(stav.isEmpty(r));
  assert.ok(stav.isEmpty(null));
  assert.ok(!stav.isEmpty({ ...r, kontaktovat: true }));
  assert.ok(!stav.isEmpty({ ...r, poznamka: 'x' }));
  assert.ok(!stav.isEmpty({ ...r, pujcovna: 'ano' }));
  assert.ok(stav.isEmpty({ ...r, poznamka: '   ' }));
});

test('normalizeRecord – zahodí neznámé klíče, srovná typy, ořízne délky', () => {
  const r = stav.normalizeRecord({ kontaktovat: 'true', nabidka: 1, volano: 'ne', cizi: 1, poznamka: 'a'.repeat(5000), pujcovna: 'možná', datumy: { kontaktovat: '2026-10-03T10:00:00Z', volano: '2026-01-01' }, upraveno: 'nesmysl' });
  assert.strictEqual(r.kontaktovat, true);
  assert.strictEqual(r.nabidka, true);
  assert.strictEqual(r.volano, false);
  assert.strictEqual(r.cizi, undefined);
  assert.strictEqual(r.poznamka.length, 4000);
  assert.strictEqual(r.pujcovna, '');
  assert.deepStrictEqual(r.datumy, { kontaktovat: '2026-10-03' }); // datum jen u zaškrtnutého stavu
  assert.strictEqual(r.upraveno, null);
  assert.strictEqual(r.kdo, '');
  assert.strictEqual(stav.normalizeRecord({ kdo: 'Jana' }).kdo, 'Jana');
  assert.strictEqual(stav.normalizeRecord({ kdo: 'x'.repeat(100) }).kdo.length, 60);
});

test('toggleStav a setPole zapisují datum a upraveno', () => {
  const now = '2026-10-03T12:00:00.000Z';
  let r = stav.toggleStav(stav.emptyRecord(), 'nabidka', true, now);
  assert.strictEqual(r.nabidka, true);
  assert.strictEqual(r.datumy.nabidka, '2026-10-03');
  assert.strictEqual(r.upraveno, now);
  r = stav.toggleStav(r, 'nabidka', false, '2026-10-04T12:00:00.000Z');
  assert.strictEqual(r.nabidka, false);
  assert.strictEqual(r.datumy.nabidka, undefined);
  r = stav.setPole(r, 'telefon', '+420 603 123 456', now);
  assert.strictEqual(r.telefon, '+420 603 123 456');
  r = stav.setPole(r, 'pujcovna', 'ano', now);
  assert.strictEqual(r.pujcovna, 'ano');
  r = stav.setPole(r, 'pujcovna', 'x', now);
  assert.strictEqual(r.pujcovna, '');
  assert.throws(() => stav.toggleStav(r, 'neznamy', true));
  assert.throws(() => stav.setPole(r, 'neznamy', 1));
});

test('merge – vyhrává novější upraveno, prázdné záznamy se zahodí', () => {
  const a = { n1: { ...stav.emptyRecord(), kontaktovat: true, upraveno: '2026-10-01T00:00:00Z' }, n2: { ...stav.emptyRecord(), poznamka: 'lokální', upraveno: '2026-10-03T00:00:00Z' }, n3: stav.emptyRecord() };
  const b = { n1: { ...stav.emptyRecord(), volano: true, upraveno: '2026-10-02T00:00:00Z' }, n2: { ...stav.emptyRecord(), poznamka: 'server', upraveno: '2026-10-02T00:00:00Z' }, n4: { ...stav.emptyRecord(), navsteva: true } };
  const m = stav.merge(a, b);
  assert.strictEqual(m.n1.volano, true);
  assert.strictEqual(m.n1.kontaktovat, false);
  assert.strictEqual(m.n2.poznamka, 'lokální');
  assert.strictEqual(m.n3, undefined);
  assert.strictEqual(m.n4.navsteva, true);
  assert.deepStrictEqual(stav.merge(null, null), {});
});

test('summary', () => {
  const s = stav.summary({ a: { ...stav.emptyRecord(), kontaktovat: true, volano: true }, b: { ...stav.emptyRecord(), kontaktovat: true }, c: stav.emptyRecord() });
  assert.deepStrictEqual(s, { celkem: 2, kontaktovat: 2, nabidka: 0, volano: 1, navsteva: 0 });
});

test('export a import JSON – round-trip, cizí id a odpad se vynechají', () => {
  const data = { n1: { ...stav.emptyRecord(), nabidka: true, poznamka: 'x' }, 'osk-abc': { ...stav.emptyRecord(), kontaktovat: true }, špatné: { kontaktovat: true }, n2: stav.emptyRecord() };
  const ex = stav.exportJson(data, { zarizeni: 'test' });
  assert.strictEqual(ex.app, 'cyklo-ski-mapa');
  assert.strictEqual(ex.zarizeni, 'test');
  assert.deepStrictEqual(Object.keys(ex.stav).sort(), ['n1', 'osk-abc']);
  const im = stav.importJson(JSON.parse(JSON.stringify(ex)));
  assert.strictEqual(im.chyba, null);
  assert.strictEqual(im.pocet, 2);
  assert.strictEqual(im.stav.n1.nabidka, true);
  // holý objekt bez obálky také projde
  assert.strictEqual(stav.importJson({ n5: { volano: true } }).pocet, 1);
  assert.ok(stav.importJson(null).chyba);
  assert.ok(stav.importJson({ app: 'cyklo-ski-mapa' }).chyba);
});

test('efektivni – ruční údaj > OSM > web', () => {
  const misto = { pujcovna: null, operator: 'OSM operátor', telefon: ['+420 111 111 111'], email: [], web: ['https://osm.cz/'], social: [] };
  const rec = { ...stav.emptyRecord(), telefon: '+420 222 222 222' };
  const enrich = { emaily: ['info@web.cz'], telefony: ['+420 333 333 333'], ares: { nazev: 'Firma s.r.o.' }, pujcovna: { kola: true, lyze: false }, web: 'https://web.cz/' };
  const e = stav.efektivni(misto, rec, enrich);
  assert.strictEqual(e.telefon, '+420 222 222 222');
  assert.strictEqual(e.provozovatel, 'OSM operátor');
  assert.strictEqual(e.email, 'info@web.cz');
  assert.strictEqual(e.web, 'https://osm.cz/');
  assert.strictEqual(e.pujcovna, 'ano?');
  const e2 = stav.efektivni({ ...misto, operator: null, web: [] }, null, enrich);
  assert.strictEqual(e2.provozovatel, 'Firma s.r.o.');
  assert.strictEqual(e2.web, 'https://web.cz/');
  assert.strictEqual(e2.telefon, '+420 111 111 111');
});
