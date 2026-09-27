'use strict';
// Nezávislé black-box testy src/engine/market.js podle SPEC §6.2.
// buildMarket(offers, filter, {now, maxAgeDays}) → Market ; rankOf(price, market) ; positionOf(price, market)

const test = require('node:test');
const assert = require('node:assert');
const { engine, NOW, daysAgo, offer, market3, SPEC_DEFAULT_CONFIG } = require('./engine-spec-helpers.js');

const M = () => engine('market');
const CTX = { now: NOW, maxAgeDays: 7 };
/** Plný filtr konkurence (výchozí hodnoty §6.5 + přepsání). */
const F = (over = {}) => ({ ...structuredClone(SPEC_DEFAULT_CONFIG.competitors), ...over });

const names = (m) => m.offers.map((o) => o.competitor);
const reasonOf = (m, competitor) => {
  const e = m.excluded.find((x) => x.offer && x.offer.competitor === competitor);
  return e ? e.reason : undefined;
};

test('market: statistiky trhu 12 990 / 13 200 / 14 000', () => {
  const m = M().buildMarket(market3(), F(), CTX);
  assert.strictEqual(m.count, 3);
  assert.strictEqual(m.min, 12990);
  assert.strictEqual(m.max, 14000);
  // avg = (12990 + 13200 + 14000) / 3 = 40190 / 3 = 13396.666… → 2 dp = 13396.67
  assert.strictEqual(m.avg, 13396.67);
  assert.strictEqual(m.median, 13200);
  assert.deepStrictEqual(m.prices, [12990, 13200, 14000]);
  assert.strictEqual(m.cheapest.competitor, 'VeloMarket.cz');
  assert.deepStrictEqual(names(m), ['VeloMarket.cz', 'Kolo-Shop.cz', 'BikeStore.cz']);
  assert.deepStrictEqual(m.excluded, []);
});

test('market: řazení podle efektivní ceny, při shodě podle jména', () => {
  const m = M().buildMarket([offer('Zeta.cz', 13000), offer('Alfa.cz', 13000), offer('Beta.cz', 12000)], F(), CTX);
  assert.deepStrictEqual(names(m), ['Beta.cz', 'Alfa.cz', 'Zeta.cz']);
  // medián 12000, 13000, 13000 → 13000
  assert.strictEqual(m.median, 13000);
});

test('market: medián sudého počtu nabídek = průměr dvou prostředních', () => {
  const m = M().buildMarket([offer('A.cz', 31990), offer('B.cz', 33490)], F(), CTX);
  // (31990 + 33490) / 2 = 32740
  assert.strictEqual(m.median, 32740);
  assert.strictEqual(m.avg, 32740);
});

test('market: vypnutý konkurent → excluded „disabled“', () => {
  const m = M().buildMarket([...market3(), offer('Bazar.cz', 9000, { enabled: false })], F(), CTX);
  assert.strictEqual(m.count, 3);
  assert.strictEqual(m.min, 12990);
  assert.strictEqual(reasonOf(m, 'Bazar.cz'), 'disabled');
});

test('market: exclude podle jména přes nameKey (velikost písmen, www, schéma) → „excluded“', () => {
  const m = M().buildMarket(market3(), F({ exclude: ['HTTPS://WWW.KOLO-SHOP.CZ/'] }), CTX);
  assert.deepStrictEqual(names(m), ['VeloMarket.cz', 'BikeStore.cz']);
  assert.strictEqual(reasonOf(m, 'Kolo-Shop.cz'), 'excluded');
});

test('market: include podle jména → ostatní „not_included“', () => {
  const m = M().buildMarket(market3(), F({ include: ['https://www.velomarket.cz/'] }), CTX);
  assert.deepStrictEqual(names(m), ['VeloMarket.cz']);
  assert.strictEqual(reasonOf(m, 'Kolo-Shop.cz'), 'not_included');
  assert.strictEqual(reasonOf(m, 'BikeStore.cz'), 'not_included');
  assert.strictEqual(m.count, 1);
});

test('market: exclude_tags / include_tags → „tag“', () => {
  const offers = () => [
    offer('VeloMarket.cz', 12990, { tags: ['marketplace'] }),
    offer('Kolo-Shop.cz', 13200, { tags: ['klíčový'] }),
    offer('BikeStore.cz', 14000, { tags: [] }),
  ];
  const ex = M().buildMarket(offers(), F({ exclude_tags: ['marketplace'] }), CTX);
  assert.deepStrictEqual(names(ex), ['Kolo-Shop.cz', 'BikeStore.cz']);
  assert.strictEqual(reasonOf(ex, 'VeloMarket.cz'), 'tag');
  assert.strictEqual(ex.min, 13200);

  const inc = M().buildMarket(offers(), F({ include_tags: ['klíčový'] }), CTX);
  assert.deepStrictEqual(names(inc), ['Kolo-Shop.cz']);
  assert.strictEqual(reasonOf(inc, 'VeloMarket.cz'), 'tag');
  assert.strictEqual(reasonOf(inc, 'BikeStore.cz'), 'tag');
});

test('market: in_stock === 0 → „out_of_stock“; null (neznámo) se počítá jako skladem', () => {
  const offers = () => [
    offer('VeloMarket.cz', 9000, { in_stock: 0 }),
    offer('Kolo-Shop.cz', 12000, { in_stock: null }),
    offer('BikeStore.cz', 14000, { in_stock: 1 }),
  ];
  const m = M().buildMarket(offers(), F(), CTX);
  assert.deepStrictEqual(names(m), ['Kolo-Shop.cz', 'BikeStore.cz']);
  assert.strictEqual(reasonOf(m, 'VeloMarket.cz'), 'out_of_stock');
  assert.strictEqual(m.min, 12000);

  // in_stock_only: false → i nabídka mimo sklad se použije
  const all = M().buildMarket(offers(), F({ in_stock_only: false }), CTX);
  assert.strictEqual(all.count, 3);
  assert.strictEqual(all.min, 9000);
});

test('market: stará nabídka (observed_at starší než max_age_days) → „stale“; filtr přebíjí ctx.maxAgeDays', () => {
  const offers = () => [
    offer('VeloMarket.cz', 9000, { observed_at: daysAgo(8) }), // 8 dní > 7 → stale
    offer('Kolo-Shop.cz', 12000, { observed_at: daysAgo(5) }), // 5 dní ≤ 7 → OK ; > 3 → stale při max_age_days 3
    offer('BikeStore.cz', 14000, { observed_at: daysAgo(2) }),
  ];
  const m = M().buildMarket(offers(), F(), CTX);
  assert.deepStrictEqual(names(m), ['Kolo-Shop.cz', 'BikeStore.cz']);
  assert.strictEqual(reasonOf(m, 'VeloMarket.cz'), 'stale');

  const m3 = M().buildMarket(offers(), F({ max_age_days: 3 }), CTX);
  assert.deepStrictEqual(names(m3), ['BikeStore.cz']);
  assert.strictEqual(reasonOf(m3, 'Kolo-Shop.cz'), 'stale');

  // ctx.maxAgeDays 30, filtr null → použije se ctx → vše čerstvé
  const m30 = M().buildMarket(offers(), F({ max_age_days: null }), { now: NOW, maxAgeDays: 30 });
  assert.strictEqual(m30.count, 3);
});

test('market: outlier – cena < medián × (1 − outlier_pct/100) při ≥ 3 zbývajících nabídkách', () => {
  // 5000, 12990, 13200, 14000 → medián (12990 + 13200) / 2 = 13095 → práh 13095 × 0.7 = 9166.5 → 5000 je outlier
  const m = M().buildMarket([offer('Levny.cz', 5000), ...market3()], F({ outlier_pct: 30 }), CTX);
  assert.strictEqual(reasonOf(m, 'Levny.cz'), 'outlier');
  assert.strictEqual(m.count, 3);
  assert.strictEqual(m.min, 12990);

  // přesně 3 nabídky: 5000, 10000, 10400 → medián 10000 → práh 7000 → 5000 outlier
  // SPEC-AMBIGUOUS: „≥ 3 offers remain“ čteme jako počet PŘED vyřazením outlierů (po ostatních vyřazeních).
  const m3 = M().buildMarket([offer('Levny.cz', 5000), offer('B.cz', 10000), offer('C.cz', 10400)], F({ outlier_pct: 30 }), CTX);
  assert.strictEqual(reasonOf(m3, 'Levny.cz'), 'outlier');
  assert.strictEqual(m3.min, 10000);
});

test('market: outlier se nevyhodnocuje při < 3 zbývajících nabídkách (po ostatních vyřazeních)', () => {
  // dvě nabídky: 5000 a 10000 → i když 5000 < 7500 × 0.7, nevyřadí se
  const m2 = M().buildMarket([offer('Levny.cz', 5000), offer('B.cz', 10000)], F({ outlier_pct: 30 }), CTX);
  assert.strictEqual(m2.count, 2);
  assert.strictEqual(m2.min, 5000);
  // tři nabídky, ale jedna mimo sklad → zbývají 2 → outlier se neuplatní
  const m3 = M().buildMarket(
    [offer('Levny.cz', 5000), offer('B.cz', 10000), offer('C.cz', 10200, { in_stock: 0 })],
    F({ outlier_pct: 30 }),
    CTX
  );
  assert.strictEqual(m3.count, 2);
  assert.strictEqual(m3.min, 5000);
  assert.strictEqual(reasonOf(m3, 'C.cz'), 'out_of_stock');
});

test('market: outlier_pct null (výchozí) → žádné vyřazení outlierů', () => {
  const m = M().buildMarket([offer('Levny.cz', 5000), ...market3()], F(), CTX);
  assert.strictEqual(m.count, 4);
  assert.strictEqual(m.min, 5000);
});

test('market: include_shipping → effective = price + (shipping || 0)', () => {
  const offers = () => [
    offer('VeloMarket.cz', 12990, { shipping: 200 }), // 13190
    offer('Kolo-Shop.cz', 13100, { shipping: null }), // 13100
    offer('BikeStore.cz', 13000, { shipping: 99.5 }), // 13099.5
  ];
  const m = M().buildMarket(offers(), F({ include_shipping: true }), CTX);
  assert.deepStrictEqual(m.prices, [13099.5, 13100, 13190]);
  assert.strictEqual(m.min, 13099.5);
  assert.strictEqual(m.cheapest.competitor, 'BikeStore.cz');
  assert.deepStrictEqual(names(m), ['BikeStore.cz', 'Kolo-Shop.cz', 'VeloMarket.cz']);
  // (13099.5 + 13100 + 13190) / 3 = 13129.8333 → 13129.83
  assert.strictEqual(m.avg, 13129.83);

  // bez include_shipping (výchozí false) se doprava ignoruje
  const m0 = M().buildMarket(offers(), F(), CTX);
  assert.deepStrictEqual(m0.prices, [12990, 13000, 13100]);
  assert.strictEqual(m0.cheapest.competitor, 'VeloMarket.cz');
});

test('market: prázdný trh → count 0, cheapest null, prices []', () => {
  const m = M().buildMarket([], F(), CTX);
  assert.strictEqual(m.count, 0);
  assert.strictEqual(m.cheapest, null);
  assert.deepStrictEqual(m.prices, []);
  assert.ok(m.min == null, 'min má být null');
  assert.ok(m.max == null, 'max má být null');
  // všechny nabídky vyřazené → také prázdný trh
  const m2 = M().buildMarket([offer('A.cz', 100, { in_stock: 0 })], F(), CTX);
  assert.strictEqual(m2.count, 0);
  assert.strictEqual(m2.excluded.length, 1);
});

test('market: exclude_keywords – název nabídky obsahuje klíčové slovo (fold, bez diakritiky)', () => {
  const offers = () => [
    offer('VeloMarket.cz', 9000, { name: 'Scott Aspect 950 – BAZAR' }),
    offer('Ojete.cz', 9500, { name: 'POUŽITÉ kolo Scott Aspect' }),
    ...market3().slice(1),
  ];
  // klíčová slova: „bazar“ a „pouzit“ (bez diakritiky – fold na obou stranách)
  const m = M().buildMarket(offers(), F({ exclude_keywords: ['bazar', 'pouzit'] }), CTX);
  assert.deepStrictEqual(m.prices, [13200, 14000]);
  // SPEC-AMBIGUOUS: důvod vyřazení pro exclude_keywords není v §6.2 vyjmenován – ověřujeme jen, že je v excluded.
  assert.ok(m.excluded.some((e) => e.offer.price === 9000), 'nabídka BAZAR má být v excluded');
  assert.ok(m.excluded.some((e) => e.offer.price === 9500), 'nabídka POUŽITÉ má být v excluded');
  for (const e of m.excluded) assert.ok(typeof e.reason === 'string' && e.reason.length > 0);
});

test('market: pořadí důvodů – vypnutý konkurent má přednost', () => {
  // SPEC-AMBIGUOUS: SPEC nestanoví prioritu důvodů; bereme pořadí výčtu v §6.2 (disabled první).
  const m = M().buildMarket([offer('Bazar.cz', 9000, { enabled: false, in_stock: 0, observed_at: daysAgo(30) })], F(), CTX);
  assert.strictEqual(reasonOf(m, 'Bazar.cz'), 'disabled');
});

test('market: částečný filtr je doplněn výchozími hodnotami (in_stock_only = true)', () => {
  // SPEC-AMBIGUOUS: „filter (strategy competitors config, normalized with defaults)“ – čteme tak, že buildMarket
  // doplní chybějící klíče výchozími hodnotami (konzervativně: mimo sklad se nepočítá).
  const m = M().buildMarket([offer('A.cz', 9000, { in_stock: 0 }), offer('B.cz', 12000)], {}, CTX);
  assert.strictEqual(m.count, 1);
  assert.strictEqual(m.min, 12000);
});

test('rankOf: 1 + počet použitých nabídek s efektivní cenou < price; shoda se nepočítá', () => {
  const { buildMarket, rankOf } = M();
  const m = buildMarket(market3(), F(), CTX);
  assert.strictEqual(rankOf(12000, m), 1);
  assert.strictEqual(rankOf(12990, m), 1); // shoda s nejlevnějším → stále 1
  assert.strictEqual(rankOf(13000, m), 2);
  assert.strictEqual(rankOf(13200, m), 2); // shoda s 2. → 2
  assert.strictEqual(rankOf(13490, m), 3);
  assert.strictEqual(rankOf(14000, m), 3);
  assert.strictEqual(rankOf(15000, m), 4);
  assert.strictEqual(rankOf(13000, buildMarket([], F(), CTX)), null);
});

test('rankOf: počítá s efektivní cenou včetně dopravy, jen s použitými nabídkami', () => {
  const { buildMarket, rankOf } = M();
  const m = buildMarket(
    [offer('A.cz', 12900, { shipping: 200 }), offer('B.cz', 13000), offer('C.cz', 9000, { in_stock: 0 })],
    F({ include_shipping: true }),
    CTX
  );
  // efektivní: A 13100, B 13000 ; C vyřazen → rankOf(13050) = 1 + |{13000}| = 2
  assert.strictEqual(rankOf(13050, m), 2);
  assert.strictEqual(rankOf(12000, m), 1);
});

test('positionOf: cheapest (≤ min) / middle / most_expensive (> max) / no_data', () => {
  const { buildMarket, positionOf } = M();
  const m = buildMarket(market3(), F(), CTX);
  assert.strictEqual(positionOf(12000, m), 'cheapest');
  assert.strictEqual(positionOf(12990, m), 'cheapest'); // shoda s min → cheapest
  assert.strictEqual(positionOf(13000, m), 'middle');
  assert.strictEqual(positionOf(14000, m), 'middle'); // shoda s max není „> max“
  assert.strictEqual(positionOf(14001, m), 'most_expensive');
  assert.strictEqual(positionOf(13000, buildMarket([], F(), CTX)), 'no_data');
  // jeden konkurent: „middle“ nemůže nastat
  const one = buildMarket([offer('A.cz', 10000)], F(), CTX);
  assert.strictEqual(positionOf(9999, one), 'cheapest');
  assert.strictEqual(positionOf(10000, one), 'cheapest');
  assert.strictEqual(positionOf(10001, one), 'most_expensive');
});

test('market: exclude_keywords s nabídkou bez názvu (name null) → nabídka zůstává', () => {
  const m = M().buildMarket([offer('A.cz', 12990, { name: null }), offer('B.cz', 13200)], F({ exclude_keywords: ['bazar'] }), CTX);
  assert.strictEqual(m.count, 2);
});

test('market: enabled jako 0/1 z databáze – 0 znamená vypnutý', () => {
  // SPEC §6.1 říká enabled: bool; run.js by měl převést, ale market musí být odolný i vůči 0/1 (jinak by vypnutý konkurent tlačil cenu).
  const m = M().buildMarket([offer('A.cz', 9000, { enabled: 0 }), offer('B.cz', 13200, { enabled: 1 })], F(), CTX);
  assert.strictEqual(m.count, 1);
  assert.strictEqual(m.min, 13200);
});
