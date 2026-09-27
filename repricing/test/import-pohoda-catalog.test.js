'use strict';
// Export katalogu z POHODY (Excel „Zásoby“): české hlavičky, stejná karta ve více členěních skladu, DPH z poměru cen,
// názvy variant s „@“ („boty modrá@vel. 45“) proti názvům z Heureky („boty modrá vel. 45“).
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { runImport, previewImport, importProducts, importOffers } = require('../src/import');

const NOW = '2026-09-27T10:00:00.000Z';
const HEAD = 'Kód;Název;Čárkód;Výrobce;Dodavatel;Nákupní;Vážená;Prodejní;Prodejní DPH;Dop MOC;Stav zásoby;Členění;Středisko;Zdraví zboží;Zodpovědná osoba';
const csv = (...rows) => [HEAD, ...rows].join('\n') + '\n';

test('návrh mapování pro hlavičky exportu zásob z POHODY', () => {
  const pv = previewImport({ kind: 'products', input: { text: csv('A1;Boty@vel. 45;4550170969790;Shimano;Paul Lange;1489;1489;1809,917;2190,003;2639;0;sSklad;;;Šenk') } });
  assert.equal(pv.suggested.code, 'Kód');
  assert.equal(pv.suggested.ean, 'Čárkód');
  assert.equal(pv.suggested.purchase_price, 'Nákupní');
  assert.equal(pv.suggested.price, 'Prodejní DPH');
  assert.equal(pv.suggested.price_net, 'Prodejní');
  assert.equal(pv.suggested.msrp, 'Dop MOC');
  assert.equal(pv.suggested.stock, 'Stav zásoby');
  assert.equal(pv.suggested.owner, 'Zodpovědná osoba');
});

test('sazba DPH z poměru Prodejní DPH / Prodejní – jen 0, 12 nebo 21 %', () => {
  const db = openDb();
  runImport(db, {
    kind: 'products',
    now: NOW,
    input: { text: csv('A;a;;;;100;;1000;1210;;1;sSklad;;;', 'B;b;;;;100;;1000;1120;;1;sSklad;;;', 'C;c;;;;100;;1000;1300;;1;sSklad;;;', 'D;d;;;;100;;100;100;;1;sSklad;;;') },
  });
  const vat = Object.fromEntries(db.prepare('SELECT code, vat_rate FROM products').all().map((r) => [r.code, r.vat_rate]));
  assert.deepEqual(vat, { A: 21, B: 12, C: null, D: 0 });
});

test('stejná karta ve více členěních skladu → součet stavu zásoby, jinak poslední řádek', () => {
  const db = openDb();
  const r = runImport(db, {
    kind: 'products',
    now: NOW,
    input: {
      text: csv(
        'X1;Přilba;;;;100;;;121;;2;sSklad;;;',
        'X1;Přilba;;;;100;;;121;;1;Provozní T/Teplice;;;',
        'X1;Přilba;;;;100;;;121;;3;sPRAHA/Nezařazeno;;;',
        'Y1;Plášť;;;;100;;;121;;5;sSklad;;;',
        'Y1;Plášť;;;;100;;;121;;7;sSklad;;;' // stejné členění = skutečná duplicita → platí poslední řádek
      ),
    },
  });
  const stock = Object.fromEntries(db.prepare('SELECT code, stock FROM products').all().map((p) => [p.code, p.stock]));
  assert.deepEqual(stock, { X1: 6, Y1: 7 });
  assert.deepEqual(r.stats.stock_merged, { codes: 1, rows: 2 });
  assert.ok(r.stats.errors.some((e) => /Y1 je v importu 2×/.test(e.message)));
});

test('sečtení skladu lze vynutit nebo vypnout', () => {
  const recs = () => [
    { code: 'A', stock: 1, attrs: { Sklad: 'hlavní' } },
    { code: 'A', stock: 2, attrs: { Sklad: 'hlavní' } },
  ];
  let db = openDb();
  importProducts(db, recs(), { now: NOW, sumDuplicateStock: true });
  assert.equal(db.prepare('SELECT stock FROM products').get().stock, 3);
  db = openDb();
  importProducts(db, [{ code: 'A', stock: 1, attrs: { Sklad: 'a' } }, { code: 'A', stock: 2, attrs: { Sklad: 'b' } }], { now: NOW, sumDuplicateStock: false });
  assert.equal(db.prepare('SELECT stock FROM products').get().stock, 2);
});

test('název varianty z POHODY s „@“ se spáruje s názvem z Heureky', () => {
  const db = openDb();
  importProducts(db, [{ code: 'SH-45', name: 'Shimano SH-GF400 pánské MTB boty modrá@vel. 45' }], { now: NOW });
  const s = importOffers(db, [{ competitor: 'kupkolo.cz', name: 'Shimano SH-GF400 pánské MTB boty modrá vel. 45', price: 2090 }], { now: NOW });
  assert.equal(s.matched, 1);
  assert.equal(s.matched_by_name, 1);
});

test('vážená nákupní cena má přednost u produktů skladem; služby se přeskočí', () => {
  const db = openDb();
  const r = runImport(db, {
    kind: 'products',
    now: NOW,
    input: {
      text: [
        'Typ;Kód;Název;Nákupní;Vážená;Prodejní DPH;Stav zásoby;Členění',
        'Karta;S1;Skladem;100;90;200;2;sSklad',
        'Karta;S1;Skladem;100;0;200;0;sPRAHA', // členění bez zásoby s váženou 0 – do průměru se nepočítá
        'Karta;S2;Skladem dvakrát;100;80;200;1;sSklad',
        'Karta;S2;Skladem dvakrát;100;110;200;3;sBRNO', // průměr vážený stavem: (80·1 + 110·3) / 4 = 102,5
        'Karta;N1;Bez zásoby;100;95;200;0;sSklad',
        'Služba;SV1;Servis kola;0;0;500;0;sSklad',
      ].join('\n'),
    },
  });
  const pp = Object.fromEntries(db.prepare('SELECT code, purchase_price FROM products').all().map((p) => [p.code, p.purchase_price]));
  assert.deepEqual(pp, { S1: 90, S2: 102.5, N1: 100 });
  assert.equal(r.stats.skipped_services, 1);
  assert.equal(previewImport({ kind: 'products', input: { text: 'Kód;Vážená\nA;1\n' } }).suggested.purchase_price_weighted, 'Vážená');
});
