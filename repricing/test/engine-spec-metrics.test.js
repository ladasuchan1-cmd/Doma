'use strict';
// Nezávislé black-box testy src/engine/metrics.js podle SPEC §6.3.
// productView(product, offers, {now, settings}) → View ; FIELDS

const test = require('node:test');
const assert = require('node:assert');
const { engine, NOW, DEFAULT_SETTINGS, daysAgo, daysAhead, offer, market3, product, approx } = require('./engine-spec-helpers.js');

const MT = () => engine('metrics');
const view = (prodOver, offers, settings = DEFAULT_SETTINGS) => MT().productView(product(prodOver), offers, { now: NOW, settings });

test('productView: sloupce produktu + attrs jako objekt', () => {
  const v = view({ attrs: '{"N":"N7","imprese_30":120}' }, market3());
  assert.strictEqual(v.code, 'KOLO-1');
  assert.strictEqual(v.manufacturer, 'Scott');
  assert.strictEqual(v.category, 'Horská kola');
  assert.strictEqual(v.stock, 5);
  assert.strictEqual(v.price, 13490);
  assert.strictEqual(typeof v.attrs, 'object');
  assert.strictEqual(v.attrs.N, 'N7');
  assert.strictEqual(v.attrs.imprese_30, 120);
});

test('productView: marže, přirážka, zisk, hodnota skladu, pokrytí (13 490 Kč, nákup 8 000 bez DPH, DPH 21 %)', () => {
  const v = view({}, market3());
  assert.strictEqual(v.vat, 21);
  // net = 13490 / 1.21 = 11148.7603 ; marže = (11148.76 − 8000) / 11148.76 × 100 = 28.2427 → 28.24
  approx(v.margin_pct, 28.24, 0.006, 'margin_pct');
  // přirážka = 3148.76 / 8000 × 100 = 39.36
  approx(v.markup_pct, 39.36, 0.006, 'markup_pct');
  // zisk (bez DPH, na kus) = 11148.76 − 8000 = 3148.76
  approx(v.profit_abs, 3148.76, 0.01, 'profit_abs');
  // hodnota skladu = nákup × sklad = 8000 × 5 = 40 000
  approx(v.stock_value, 40000, 0.001, 'stock_value');
  // pokrytí = stock / (sales_30 / 30) = 5 / (3 / 30) = 50 dní
  approx(v.days_of_cover, 50, 0.001, 'days_of_cover');
});

test('productView: tržní metriky – výchozí filtr (zapnutí, čerství konkurenti)', () => {
  const offers = [
    ...market3(),
    offer('Bazar.cz', 9000, { enabled: false, in_stock: 0 }), // vypnutý → ignorovat
    offer('Stary.cz', 9500, { observed_at: daysAgo(10), in_stock: 0 }), // starší než 7 dní → ignorovat
  ];
  const v = view({}, offers);
  assert.strictEqual(v.market_count, 3);
  assert.strictEqual(v.market_min, 12990);
  assert.strictEqual(v.market_max, 14000);
  approx(v.market_avg, 13396.67, 0.006, 'market_avg');
  assert.strictEqual(v.market_median, 13200);
  assert.strictEqual(v.cheapest_competitor, 'VeloMarket.cz');
  // rank = 1 + |{12990, 13200} < 13490| = 3
  assert.strictEqual(v.rank, 3);
  assert.strictEqual(v.position, 'middle');
  // price_index = 13490 / 12990 × 100 = 103.849 → 1 dp = 103.8
  approx(v.price_index, 103.8, 0.001, 'price_index');
  // price_index_median = 13490 / 13200 × 100 = 102.197
  approx(v.price_index_median, 102.2, 0.051, 'price_index_median');
  // price_index_avg = 13490 / 13396.67 × 100 = 100.697
  approx(v.price_index_avg, 100.7, 0.051, 'price_index_avg');
  // gap_min_abs = 13490 − 12990 = 500
  approx(v.gap_min_abs, 500, 0.001, 'gap_min_abs');
  // SPEC-AMBIGUOUS: gap_min_pct – jmenovatel není uveden; čteme (price − min) / min × 100 = 500 / 12990 = 3.849 %
  // (= price_index − 100; souhlasí s presetem „gap_min_pct <= −5“ když jsme nejlevnější). Alternativa /price = 3.706 %.
  approx(v.gap_min_pct, 3.85, 0.051, 'gap_min_pct');
  // msrp_diff_pct = (13490 − 14990) / 14990 × 100 = −10.0067
  approx(v.msrp_diff_pct, -10.01, 0.051, 'msrp_diff_pct');
  // všechny 3 použité nabídky skladem (vypnutá a stará jsou mimo sklad, takže nezávisí na výkladu)
  assert.strictEqual(v.offers_instock, 3);
  // min trhu bez DPH = 12990 / 1.21 = 10735.54 > 8000 → false
  assert.strictEqual(v.min_below_cost, false);
  assert.strictEqual(v.lock_active, false);
  // price_changed_at před 30 dny
  approx(v.days_since_change, 30, 0.001, 'days_since_change');
});

test('productView: settings.metrics_in_stock_only řídí, zda se počítají nabídky mimo sklad', () => {
  const offers = () => [...market3(), offer('Vyprodano.cz', 11000, { in_stock: 0 })];
  // výchozí metrics_in_stock_only = false → nabídka mimo sklad se počítá
  const all = view({}, offers(), { ...DEFAULT_SETTINGS, metrics_in_stock_only: false });
  assert.strictEqual(all.market_count, 4);
  assert.strictEqual(all.market_min, 11000);
  assert.strictEqual(all.cheapest_competitor, 'Vyprodano.cz');
  const inStock = view({}, offers(), { ...DEFAULT_SETTINGS, metrics_in_stock_only: true });
  assert.strictEqual(inStock.market_count, 3);
  assert.strictEqual(inStock.market_min, 12990);
});

test('productView: doprava se do metrik nezapočítává', () => {
  const v = view({}, [offer('VeloMarket.cz', 12990, { shipping: 500 }), offer('Kolo-Shop.cz', 13200)]);
  assert.strictEqual(v.market_min, 12990);
});

test('productView: bez trhu → market_count 0, position no_data, rank/index null', () => {
  const v = view({}, []);
  assert.strictEqual(v.market_count, 0);
  assert.strictEqual(v.position, 'no_data');
  assert.ok(v.rank == null, 'rank null');
  assert.ok(v.market_min == null, 'market_min null');
  assert.ok(v.price_index == null, 'price_index null');
  assert.ok(v.gap_min_abs == null, 'gap_min_abs null');
  assert.ok(v.cheapest_competitor == null, 'cheapest_competitor null');
  assert.strictEqual(v.min_below_cost, false);
});

test('productView: position cheapest při ceně pod trhem, záporný gap', () => {
  // cena 12 000 < 12 990 → cheapest ; gap = −990 ; index = 12000 / 12990 × 100 = 92.379 → 92.4
  const v = view({ price: 12000 }, market3());
  assert.strictEqual(v.position, 'cheapest');
  assert.strictEqual(v.rank, 1);
  approx(v.gap_min_abs, -990, 0.001);
  approx(v.price_index, 92.4, 0.001);
  approx(v.gap_min_pct, -7.62, 0.051); // −990 / 12990 × 100 = −7.621
});

test('productView: min_below_cost – nejnižší cena trhu bez DPH < nákupní cena', () => {
  // 9000 / 1.21 = 7438.02 < 8000 → true
  const v = view({}, [offer('Levny.cz', 9000), ...market3()]);
  assert.strictEqual(v.min_below_cost, true);
  // 9800 / 1.21 = 8099.17 ≥ 8000 → false
  assert.strictEqual(view({}, [offer('Levny.cz', 9800)]).min_below_cost, false);
});

test('productView: lock_active = locked AND (locked_until null OR > now)', () => {
  assert.strictEqual(view({ locked: 1, locked_until: null }, []).lock_active, true);
  assert.strictEqual(view({ locked: 1, locked_until: daysAhead(1) }, []).lock_active, true);
  assert.strictEqual(view({ locked: 1, locked_until: daysAgo(1) }, []).lock_active, false);
  assert.strictEqual(view({ locked: 0, locked_until: daysAhead(1) }, []).lock_active, false);
  assert.strictEqual(view({ locked: 0, locked_until: null }, []).lock_active, false);
});

test('productView: days_of_cover null bez prodejů; days_since_change null bez změny', () => {
  assert.ok(view({ sales_30: 0 }, []).days_of_cover == null);
  assert.ok(view({ sales_30: null }, []).days_of_cover == null);
  assert.ok(view({ price_changed_at: null }, []).days_since_change == null);
  approx(view({ price_changed_at: daysAgo(10) }, []).days_since_change, 10, 0.001);
});

test('productView: vat – null → settings.vat_rate_default, jinak sazba produktu', () => {
  assert.strictEqual(view({ vat_rate: null }, []).vat, 21);
  const v12 = view({ vat_rate: 12 }, []);
  assert.strictEqual(v12.vat, 12);
  // net = 13490 / 1.12 = 12044.64 ; marže = 4044.64 / 12044.64 = 33.58 %
  approx(v12.margin_pct, 33.58, 0.006);
  const v10 = view({ vat_rate: null }, [], { ...DEFAULT_SETTINGS, vat_rate_default: 10 });
  assert.strictEqual(v10.vat, 10);
});

test('productView: bez nákupní ceny → margin_pct null, min_below_cost false', () => {
  const v = view({ purchase_price: null }, market3());
  assert.ok(v.margin_pct == null);
  assert.ok(v.markup_pct == null);
  assert.ok(!v.min_below_cost);
});

test('productView: now jako Date i jako ISO řetězec dává stejný výsledek', () => {
  const a = MT().productView(product(), market3(), { now: NOW, settings: DEFAULT_SETTINGS });
  const b = MT().productView(product(), market3(), { now: new Date(NOW), settings: DEFAULT_SETTINGS });
  assert.strictEqual(a.days_since_change, b.days_since_change);
  assert.strictEqual(a.market_count, b.market_count);
});

test('FIELDS: popis filtrovatelných polí {key, label, type, group}', () => {
  const { FIELDS } = MT();
  assert.ok(Array.isArray(FIELDS) && FIELDS.length > 10);
  const keys = new Set();
  for (const f of FIELDS) {
    assert.ok(typeof f.key === 'string' && f.key, 'key');
    assert.ok(typeof f.label === 'string' && f.label, `label pro ${f.key}`);
    assert.ok(['string', 'number', 'boolean', 'enum'].includes(f.type), `type pro ${f.key}: ${f.type}`);
    assert.ok(typeof f.group === 'string' && f.group, `group pro ${f.key}`);
    assert.ok(!keys.has(f.key), `duplicitní klíč ${f.key}`);
    keys.add(f.key);
  }
  const byKey = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
  for (const k of ['code', 'name', 'manufacturer', 'category', 'stock', 'price', 'margin_pct', 'price_index', 'gap_min_pct', 'market_count', 'days_of_cover', 'position', 'min_below_cost', 'lock_active']) {
    assert.ok(byKey[k], `FIELDS postrádá ${k}`);
  }
  assert.strictEqual(byKey.position.type, 'enum');
  assert.strictEqual(byKey.margin_pct.type, 'number');
  assert.strictEqual(byKey.market_count.type, 'number');
  assert.strictEqual(byKey.manufacturer.type, 'string');
  assert.strictEqual(byKey.min_below_cost.type, 'boolean');
  assert.strictEqual(byKey.lock_active.type, 'boolean');
});
