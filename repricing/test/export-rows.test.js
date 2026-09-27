'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { exportRows, ROW_FIELDS } = require('../src/export/rows');
const { setSetting } = require('../src/db');
const h = require('./export-helpers');

test('scope approved: nejnovější schválený návrh aktivních produktů, názvy strategie a segmentu', () => {
  const db = h.freshDb();
  const s = h.seedBasic(db);
  const rows = exportRows(db, { scope: 'approved', now: h.NOW });
  assert.deepEqual(
    rows.map((r) => r.code),
    ['KOLO-TREK-FX2-M', 'PLAST-SCHW-29-2.35']
  );
  const [a, b] = rows;
  assert.deepEqual(Object.keys(a), ROW_FIELDS);
  assert.equal(a.proposal_id, s.pA, 'starší schválený návrh se nepoužije');
  assert.equal(a.product_id, s.a);
  assert.equal(a.price, 18990);
  assert.equal(a.old_price, 19990);
  assert.equal(a.change_pct, -5);
  assert.equal(a.strategy, 'Medián trhu −2 %');
  assert.equal(a.segment, 'Ležáky N7/N8');
  assert.equal(a.currency, 'CZK');
  assert.equal(a.vat_rate, 21);
  assert.equal(a.ean, '8591234567890');
  assert.equal(a.name, 'Trek FX 2 M');
  assert.equal(a.changed_at, h.T0);
  // ruční cena má přednost, procento se přepočítá
  assert.equal(b.proposal_id, s.pB);
  assert.equal(b.price, 899);
  assert.equal(b.change_pct, -5.27);
  assert.equal(b.segment, null);
  assert.equal(b.manufacturer, 'Schwalbe');
});

test('scope approved: filtr ids a productIds; exportované/čekající/neaktivní se nevrací', () => {
  const db = h.freshDb();
  const s = h.seedBasic(db);
  assert.deepEqual(exportRows(db, { ids: [s.pB], now: h.NOW }).map((r) => r.proposal_id), [s.pB]);
  assert.deepEqual(exportRows(db, { ids: [String(s.pB), 'x'], now: h.NOW }).map((r) => r.proposal_id), [s.pB], 'id jako řetězce');
  assert.deepEqual(exportRows(db, { ids: [s.pOldA], now: h.NOW }), [], 'starší návrh téhož produktu nikdy');
  assert.deepEqual(exportRows(db, { ids: [s.pC, s.pE], now: h.NOW }), [], 'pending a neaktivní ne');
  assert.deepEqual(exportRows(db, { productIds: [s.a], now: h.NOW }).map((r) => r.code), ['KOLO-TREK-FX2-M']);
  assert.deepEqual(exportRows(db, { ids: [], now: h.NOW }), []);

  db.prepare("UPDATE proposals SET status = 'exported', exported_at = ? WHERE id IN (?, ?)").run(h.NOW, s.pA, s.pOldA);
  assert.deepEqual(exportRows(db, { now: h.NOW }).map((r) => r.proposal_id), [s.pB]);
});

test('scope all: úplný ceník aktivních produktů, cena z návrhu jinak aktuální', () => {
  const db = h.freshDb();
  const s = h.seedBasic(db);
  setSetting(db, 'currency', 'EUR');
  setSetting(db, 'vat_rate_default', 12);
  const rows = exportRows(db, { scope: 'all', now: h.NOW });
  assert.deepEqual(
    rows.map((r) => r.code),
    ['HELMA-ABUS', 'KOLO-TREK-FX2-M', 'PLAST-SCHW-29-2.35'],
    'bez ceny a neaktivní se vynechají'
  );
  const c = rows[0];
  assert.equal(c.proposal_id, null, 'čekající návrh se nepoužije');
  assert.equal(c.price, 2490);
  assert.equal(c.old_price, 2490);
  assert.equal(c.change_pct, 0);
  assert.equal(c.strategy, null);
  assert.equal(c.segment, null);
  assert.equal(c.vat_rate, 12, 'výchozí DPH z nastavení');
  assert.equal(c.currency, 'EUR');
  assert.equal(rows[1].proposal_id, s.pA);
  assert.equal(rows[1].price, 18990);
  assert.equal(rows[2].price, 899);
  assert.deepEqual(exportRows(db, { scope: 'all', productIds: [s.c, s.e], now: h.NOW }).map((r) => r.code), ['HELMA-ABUS']);
});

test('lowest_30d: historie v okně, cena platná na začátku okna, aktuální cena; budoucnost se ignoruje', () => {
  const db = h.freshDb();
  const run = h.addRun(db);
  // A: 17 990 platila od −45 do −20 dní → byla platná i na začátku 30denního okna
  const a = h.addProduct(db, { code: 'A', price: 19990 });
  h.addHistory(db, a, 18490, h.daysAgo(60));
  h.addHistory(db, a, 17990, h.daysAgo(45));
  h.addHistory(db, a, 19990, h.daysAgo(20));
  h.addProposal(db, { run_id: run, product_id: a, old_price: 19990, new_price: 16990 });
  // B: stará nízká cena přebitá ještě před oknem se nepočítá; v okně 1500; budoucí 1000 ne
  const b = h.addProduct(db, { code: 'B', price: 1800 });
  h.addHistory(db, b, 1200, h.daysAgo(40));
  h.addHistory(db, b, 1700, h.daysAgo(35));
  h.addHistory(db, b, 1500, h.daysAgo(15), 'export');
  h.addHistory(db, b, 1800, h.daysAgo(5), 'manual');
  h.addHistory(db, b, 1000, h.daysAgo(-1));
  // C: bez historie → aktuální cena
  const c = h.addProduct(db, { code: 'C', price: 700 });
  // D: aktuální cena nižší než historie
  const d = h.addProduct(db, { code: 'D', price: 650 });
  h.addHistory(db, d, 800, h.daysAgo(3));
  // E: změna přesně na hranici okna se počítá
  const e = h.addProduct(db, { code: 'E', price: 999 });
  h.addHistory(db, e, 555, h.daysAgo(30));

  const rows = exportRows(db, { scope: 'all', now: h.NOW });
  const by = Object.fromEntries(rows.map((r) => [r.code, r.lowest_30d]));
  assert.equal(by.A, 17990);
  assert.equal(by.B, 1500);
  assert.equal(by.C, 700);
  assert.equal(by.D, 650);
  assert.equal(by.E, 555);
  // nová (exportovaná) cena 16 990 se do nejnižší ceny nezapočítá
  assert.equal(exportRows(db, { now: h.NOW })[0].lowest_30d, 17990);
  // 17 990 platila do −20 dní: o 9 dní později ještě na začátku okna platila, o 11 dní později už ne
  assert.equal(exportRows(db, { scope: 'all', now: h.daysAgo(-9) }).find((r) => r.code === 'A').lowest_30d, 17990);
  assert.equal(exportRows(db, { scope: 'all', now: h.daysAgo(-11) }).find((r) => r.code === 'A').lowest_30d, 19990);
});

test('řádky bez kladné ceny se nevyexportují; v ceníku nahradí aktuální cena', () => {
  const db = h.freshDb();
  const run = h.addRun(db);
  const a = h.addProduct(db, { code: 'A', price: 1000 });
  const pa = h.addProposal(db, { run_id: run, product_id: a, old_price: 1000, new_price: 900, manual_price: 0 });
  assert.deepEqual(exportRows(db, { now: h.NOW }), []);
  const all = exportRows(db, { scope: 'all', now: h.NOW });
  assert.equal(all.length, 1);
  assert.equal(all[0].price, 1000);
  assert.equal(all[0].proposal_id, null);
  assert.ok(pa);
});

test('neplatný rozsah → chyba; prázdná databáze → prázdné pole', () => {
  const db = h.freshDb();
  assert.throws(() => exportRows(db, { scope: 'nic' }), /Neplatný rozsah/);
  assert.deepEqual(exportRows(db), []);
  assert.deepEqual(exportRows(db, { scope: 'all' }), []);
});
