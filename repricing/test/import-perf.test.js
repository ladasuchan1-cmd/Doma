'use strict';
// Výkon importu (SPEC §10): 200 000 nabídek z CSV (celá cesta extractRecords → applyMapping → importOffers) do 20 s.
// Při CI_SLOW=1 se měří, ale časový limit se nekontroluje.

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { importProducts, runImport } = require('../src/import');

const PRODUCTS = 30000;
const OFFERS = 200000;
const COMPETITORS = ['VeloMarket.cz', 'KoloPointer.cz', 'CykloDům.cz', 'BikeRanger.cz', 'SpeedKola.cz', 'HoryNaKole.cz', 'MegaSportík.cz', 'Kola-Brno.cz'];
const LIMIT_MS = 20000;

function ean(i) {
  return String(8590000000000 + i * 7);
}

function offersCsv(round) {
  const lines = ['EAN;Konkurent;Cena;Doprava;Dostupnost;URL;Zjištěno'];
  for (let i = 0; i < OFFERS; i++) {
    const p = i % PRODUCTS;
    const c = Math.floor(i / PRODUCTS) % COMPETITORS.length;
    const price = 500 + ((p * 37 + c * 11 + (round && i % 10 === 0 ? 5 : 0)) % 90000);
    const priceText = `${price.toLocaleString('cs-CZ')} Kč`;
    const stock = (p + c) % 5 === 0 ? 'na dotaz' : 'skladem';
    lines.push(`${ean(p)};${COMPETITORS[c]};${priceText};${c % 3 ? 99 : 0};${stock};https://${c}.example/p/${p};25.09.2026 1${round}:00`);
  }
  return lines.join('\r\n') + '\r\n';
}

test(`výkon: import ${OFFERS.toLocaleString("cs-CZ")} nabídek (CSV → DB) do ${LIMIT_MS / 1000} s`, { timeout: 180000 }, (t) => {
  const db = openDb();
  const products = [];
  for (let i = 0; i < PRODUCTS; i++) products.push({ code: `P-${i}`, ean: ean(i), name: `Produkt ${i}`, price: 1000 + i, purchase_price: 600 + i, vat_rate: 21 });
  const tp = Date.now();
  const ps = importProducts(db, products, { now: '2026-09-25T08:00:00Z' });
  const productsMs = Date.now() - tp;
  assert.equal(ps.created, PRODUCTS);

  const csv1 = offersCsv(0);
  const t1 = Date.now();
  const r1 = runImport(db, { kind: 'offers', input: { buffer: Buffer.from(csv1, 'utf8'), filename: 'offers.csv' }, origin: 'api', now: '2026-09-25T10:00:00Z' });
  const firstMs = Date.now() - t1;
  assert.equal(r1.stats.received, OFFERS);
  assert.equal(r1.stats.matched, OFFERS);
  assert.equal(r1.stats.created, OFFERS);
  assert.equal(r1.stats.errors.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM offers').get().c, OFFERS);

  // druhý běh: aktualizace (10 % cen se změní), nahrazení po konkurentech
  const csv2 = offersCsv(1);
  const t2 = Date.now();
  const r2 = runImport(db, { kind: 'offers', input: { text: csv2 }, options: { replace: 'competitors' }, origin: 'api', now: '2026-09-25T12:00:00Z' });
  const secondMs = Date.now() - t2;
  assert.equal(r2.stats.matched, OFFERS);
  assert.equal(r2.stats.updated + r2.stats.unchanged, OFFERS);
  assert.ok(r2.stats.updated >= OFFERS / 10);
  assert.equal(r2.stats.removed, 0);

  const msg = `katalog ${PRODUCTS}: ${productsMs} ms; nabídky nové: ${firstMs} ms; aktualizace: ${secondMs} ms`;
  t.diagnostic(msg);
  if (!process.env.CI_SLOW) {
    assert.ok(firstMs < LIMIT_MS, `první import trval ${firstMs} ms (limit ${LIMIT_MS} ms)`);
    assert.ok(secondMs < LIMIT_MS, `aktualizace trvala ${secondMs} ms (limit ${LIMIT_MS} ms)`);
  }
});
