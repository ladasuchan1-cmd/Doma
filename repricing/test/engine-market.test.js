'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMarket, rankOf, positionOf, findCompetitorOffer } = require('../src/engine/market.js');
const { NOW, offer } = require('./engine-helpers.js');

const ctx = { now: NOW, maxAgeDays: 7 };
const daysAgo = (d) => new Date(Date.parse(NOW) - d * 86400000).toISOString();
const reasons = (m) => Object.fromEntries(m.excluded.map((e) => [e.offer.competitor, e.reason]));

test('market: statistiky a řazení podle efektivní ceny, pak jména', () => {
  const m = buildMarket([offer('Cyklo', 12990), offer('Beta', 11990), offer('Alfa', 12990), offer('Delta', 13500)], {}, ctx);
  assert.equal(m.count, 4);
  assert.deepEqual(
    m.offers.map((o) => o.competitor),
    ['Beta', 'Alfa', 'Cyklo', 'Delta']
  );
  assert.deepEqual(m.prices, [11990, 12990, 12990, 13500]);
  assert.equal(m.min, 11990);
  assert.equal(m.max, 13500);
  assert.equal(m.avg, 12867.5);
  assert.equal(m.median, 12990);
  assert.equal(m.cheapest.competitor, 'Beta');
  assert.deepEqual(m.excluded, []);
});

test('market: prázdný trh', () => {
  const m = buildMarket([], {}, ctx);
  assert.equal(m.count, 0);
  assert.equal(m.min, null);
  assert.equal(m.median, null);
  assert.equal(m.cheapest, null);
  assert.equal(rankOf(1000, m), null);
  assert.equal(positionOf(1000, m), 'no_data');
});

test('market: vypnutý konkurent (enabled false / 0)', () => {
  const m = buildMarket([offer('A', 100, { enabled: false }), offer('B', 110, { enabled: 0 }), offer('C', 120)], {}, ctx);
  assert.equal(m.count, 1);
  assert.deepEqual(reasons(m), { A: 'disabled', B: 'disabled' });
});

test('market: include / exclude podle nameKey (www, velikost písmen, popisek)', () => {
  const offers = [offer('www.VeloMarket.cz', 100), offer('Kolo-Shop.cz', 110), offer('SportX', 120, { label: 'Sport X Praha' })];
  let m = buildMarket(offers, { exclude: ['velomarket.cz'] }, ctx);
  assert.deepEqual(reasons(m), { 'www.VeloMarket.cz': 'excluded' });
  m = buildMarket(offers, { include: ['KOLO-SHOP.CZ ', 'sport x praha'] }, ctx);
  assert.deepEqual(
    m.offers.map((o) => o.competitor),
    ['Kolo-Shop.cz', 'SportX']
  );
  assert.equal(reasons(m)['www.VeloMarket.cz'], 'not_included');
  // exclude má přednost před include
  m = buildMarket(offers, { include: ['kolo-shop.cz'], exclude: ['kolo-shop.cz'] }, ctx);
  assert.equal(reasons(m)['Kolo-Shop.cz'], 'excluded');
});

test('market: štítky (include_tags / exclude_tags, bez diakritiky)', () => {
  const offers = [offer('A', 100, { tags: ['marketplace'] }), offer('B', 110, { tags: ['Klíčový'] }), offer('C', 120, { tags: [] })];
  let m = buildMarket(offers, { exclude_tags: ['MARKETPLACE'] }, ctx);
  assert.deepEqual(reasons(m), { A: 'tag' });
  m = buildMarket(offers, { include_tags: ['klicovy'] }, ctx);
  assert.deepEqual(
    m.offers.map((o) => o.competitor),
    ['B']
  );
  assert.deepEqual(reasons(m), { A: 'tag', C: 'tag' });
});

test('market: klíčová slova v názvu nabídky (bazar, použité…)', () => {
  const offers = [offer('A', 50, { name: 'Kolo XY – BAZAR' }), offer('B', 60, { name: 'Kolo XY použité' }), offer('C', 100, { name: 'Kolo XY' }), offer('D', 110)];
  const m = buildMarket(offers, { exclude_keywords: ['bazar', 'Použit'] }, ctx);
  assert.deepEqual(reasons(m), { A: 'keyword', B: 'keyword' });
  assert.equal(m.min, 100);
});

test('market: neskladem vyřazeno, neznámá dostupnost se počítá jako skladem', () => {
  const offers = [offer('A', 90, { in_stock: 0 }), offer('B', 100, { in_stock: null }), offer('C', 110, { in_stock: 1 })];
  let m = buildMarket(offers, {}, ctx);
  assert.deepEqual(reasons(m), { A: 'out_of_stock' });
  assert.equal(m.min, 100);
  m = buildMarket(offers, { in_stock_only: false }, ctx);
  assert.equal(m.count, 3);
  assert.equal(m.min, 90);
});

test('market: zastaralé nabídky (max_age_days z ctx i ze strategie; bez observed_at = čerstvé)', () => {
  const offers = [offer('A', 90, { observed_at: daysAgo(8) }), offer('B', 100, { observed_at: daysAgo(6.9) }), offer('C', 110, { observed_at: undefined })];
  let m = buildMarket(offers, {}, ctx);
  assert.deepEqual(reasons(m), { A: 'stale' });
  m = buildMarket(offers, { max_age_days: 3 }, ctx);
  assert.deepEqual(reasons(m), { A: 'stale', B: 'stale' });
  m = buildMarket(offers, { max_age_days: 30 }, ctx);
  assert.equal(m.count, 3);
  m = buildMarket(offers, {}, { now: NOW, maxAgeDays: null });
  assert.equal(m.count, 3, 'bez limitu stáří');
  m = buildMarket([offer('X', 10, { observed_at: 'nesmysl' })], {}, ctx);
  assert.deepEqual(reasons(m), { X: 'stale' }, 'nečitelné datum = konzervativně zastaralé');
});

test('market: odlehlé hodnoty jen při ≥ 3 nabídkách', () => {
  const three = [offer('A', 5000), offer('B', 10000), offer('C', 10200)];
  let m = buildMarket(three, { outlier_pct: 30 }, ctx);
  assert.deepEqual(reasons(m), { A: 'outlier' });
  assert.equal(m.excluded[0].offer, three[0], 'vyřazená nabídka = původní objekt');
  assert.equal(m.min, 10000);
  m = buildMarket(three.slice(0, 2), { outlier_pct: 30 }, ctx);
  assert.equal(m.count, 2, 'dvě nabídky → outliery se nevyřazují');
  assert.equal(m.min, 5000);
  // hranice: price < median × (1 − pct/100) – rovnost se nevyřazuje
  m = buildMarket([offer('A', 7000), offer('B', 10000), offer('C', 10200)], { outlier_pct: 30 }, ctx);
  assert.equal(m.count, 3);
  // outliery se počítají až po ostatních vyřazeních (zde po vyřazení neskladem zbudou 2)
  m = buildMarket([offer('A', 5000), offer('B', 10000), offer('C', 10200, { in_stock: 0 })], { outlier_pct: 30 }, ctx);
  assert.equal(m.count, 2);
  assert.deepEqual(reasons(m), { C: 'out_of_stock' });
  // bez outlier_pct nic
  m = buildMarket(three, {}, ctx);
  assert.equal(m.count, 3);
});

test('market: doprava v efektivní ceně jen s include_shipping', () => {
  const offers = [offer('A', 1000, { shipping: 99 }), offer('B', 1050, { shipping: 0 }), offer('C', 1020, { shipping: null })];
  let m = buildMarket(offers, {}, ctx);
  assert.equal(m.min, 1000);
  m = buildMarket(offers, { include_shipping: true }, ctx);
  assert.deepEqual(m.prices, [1020, 1050, 1099]);
  assert.equal(m.cheapest.competitor, 'C');
  assert.equal(m.offers.find((o) => o.competitor === 'A').effective, 1099);
  assert.equal(m.offers.find((o) => o.competitor === 'A').price, 1000);
});

test('market: neplatná cena se vyřadí', () => {
  const m = buildMarket([offer('A', 0), offer('B', -5), offer('C', NaN), offer('D', 100)], {}, ctx);
  assert.equal(m.count, 1);
  assert.deepEqual(new Set(Object.values(reasons(m))), new Set(['invalid_price']));
});

test('market: pořadí (rank) a pozice včetně remíz', () => {
  const m = buildMarket([offer('A', 1000), offer('B', 1000), offer('C', 1200)], {}, ctx);
  assert.equal(rankOf(900, m), 1);
  assert.equal(rankOf(1000, m), 1, 'shodná cena s nejlevnějším = 1. místo');
  assert.equal(rankOf(1000.004, m), 1, 'porovnání na haléře');
  assert.equal(rankOf(1100, m), 3);
  assert.equal(rankOf(1200, m), 3);
  assert.equal(rankOf(1300, m), 4);
  assert.equal(rankOf(null, m), null);
  assert.equal(positionOf(900, m), 'cheapest');
  assert.equal(positionOf(1000, m), 'cheapest');
  assert.equal(positionOf(1100, m), 'middle');
  assert.equal(positionOf(1200, m), 'middle', 'rovno maximu není nejdražší');
  assert.equal(positionOf(1200.01, m), 'most_expensive');
  assert.equal(positionOf(null, m), 'no_data');
  const one = buildMarket([offer('A', 1000)], {}, ctx);
  assert.equal(positionOf(1000, one), 'cheapest');
  assert.equal(positionOf(1000.5, one), 'most_expensive');
});

test('market: dohledání konkurenta', () => {
  const m = buildMarket([offer('VeloMarket.cz', 1000), offer('Kolo', 1100, { label: 'Kolo Praha' })], {}, ctx);
  assert.equal(findCompetitorOffer(m, 'https://www.velomarket.cz/').competitor, 'VeloMarket.cz');
  assert.equal(findCompetitorOffer(m, 'kolo praha').competitor, 'Kolo');
  assert.equal(findCompetitorOffer(m, 'Nikdo'), null);
});

test('market: filtr se nemutuje a lze ho měnit mezi voláními', () => {
  const f = { exclude: ['A'] };
  const offers = [offer('A', 100), offer('B', 110)];
  assert.equal(buildMarket(offers, f, ctx).count, 1);
  f.exclude = [];
  assert.equal(buildMarket(offers, f, ctx).count, 2);
  assert.deepEqual(f, { exclude: [] });
});
