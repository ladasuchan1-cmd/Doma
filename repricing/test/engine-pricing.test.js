'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computePrice, formatMoney, formatPct } = require('../src/engine/pricing.js');
const { normalizeConfig } = require('../src/engine/presets.js');
const { marginPct } = require('../src/util/num.js');
const { NOW, offer, product, looseConfig } = require('./engine-helpers.js');

const NBSP = ' ';
const daysAgo = (d) => new Date(Date.parse(NOW) - d * 86400000).toISOString();
const MARKET = [offer('A', 9000), offer('B', 9500), offer('C', 10500), offer('D', 12000)]; // min 9000, median 10000, avg 10250

/** computePrice s volnými limity a bez zaokrouhlení (pokud config neurčí jinak). */
function cp(p, offers, cfg, { loose = true, settings } = {}) {
  const config = loose ? looseConfig(cfg) : cfg;
  return computePrice(product(p), offers, { id: 7, name: 'Test', segment_id: 3, config }, { now: NOW, settings });
}
const texts = (d) => d.explain.map((e) => e.text).join('\n');

// ---------------------------------------------------------------------------------------------
// Tvar rozhodnutí a vysvětlení

test('pricing: tvar rozhodnutí dle SPEC §6.7', () => {
  const d = cp({}, MARKET, { target: { mode: 'match_min' } });
  for (const k of ['action', 'reason', 'product_id', 'strategy_id', 'segment_id', 'old_price', 'new_price', 'target_price', 'reference_price', 'floor', 'ceiling', 'market', 'rank_before', 'rank_after', 'margin_before', 'margin_after', 'change_abs', 'change_pct', 'flags', 'explain', 'auto_approve'])
    assert.ok(k in d, `chybí ${k}`);
  assert.equal(d.action, 'change');
  assert.equal(d.reason, null);
  assert.equal(d.product_id, 1);
  assert.equal(d.strategy_id, 7);
  assert.equal(d.segment_id, 3);
  assert.equal(d.old_price, 10000);
  assert.equal(d.new_price, 9000);
  assert.equal(d.target_price, 9000);
  assert.equal(d.reference_price, 9000);
  assert.equal(d.change_abs, -1000);
  assert.equal(d.change_pct, -10);
  assert.equal(d.rank_before, 3);
  assert.equal(d.rank_after, 1);
  assert.equal(d.margin_before, marginPct(10000, 6000, 21));
  assert.equal(d.margin_after, marginPct(9000, 6000, 21));
  assert.deepEqual(Object.keys(d.market).sort(), ['avg', 'cheapest', 'count', 'excluded', 'max', 'median', 'min', 'used'].sort());
  assert.deepEqual(d.market.cheapest, { competitor: 'A', price: 9000, effective: 9000 });
  assert.equal(d.market.used.length, 4);
  assert.deepEqual(d.market.used[0], { competitor: 'A', price: 9000, effective: 9000, in_stock: 1 });
  assert.ok(Array.isArray(d.flags));
  assert.ok(d.explain.every((e) => typeof e.step === 'string' && typeof e.text === 'string'));
  assert.equal(typeof d.auto_approve, 'boolean');
});

test('pricing: formátování peněz a procent česky (NBSP jako oddělovač tisíců)', () => {
  assert.equal(formatMoney(12490), `12${NBSP}490 Kč`);
  assert.equal(formatMoney(12490.5), `12${NBSP}490,50 Kč`);
  assert.equal(formatMoney(999), '999 Kč');
  assert.equal(formatMoney(-0.001), '0 Kč');
  assert.equal(formatMoney(null), '–');
  assert.equal(formatPct(1.5), '1,5 %');
  assert.equal(formatPct(12), '12 %');
  assert.equal(formatPct(-2.345), '-2,35 %');
});

test('pricing: vysvětlení obsahuje trh, cíl, hranici a zaokrouhlení česky', () => {
  const offers = [offer('VeloMarket', 12490), offer('B', 12990), offer('C', 13490), offer('D', 13990), offer('E', 14990), offer('X', 9000, { in_stock: 0 })];
  const d = computePrice(product({ price: 12990, purchase_price: 9500, msrp: 14990 }), offers, { id: 1, name: 'Výchozí', config: { target: { offset_pct: -1 }, limits: { min_margin_pct: 12 } } }, { now: NOW });
  const t = texts(d);
  assert.match(t, new RegExp(`Nejnižší cena trhu: 12${NBSP}490 Kč \\(VeloMarket\\), 5 konkurentů`));
  assert.match(t, /Vyřazeno nabídek: 1 – není skladem \(1\)/);
  assert.match(t, new RegExp(`o 1 % levněji → 12${NBSP}365,10 Kč`));
  assert.match(t, new RegExp(`Minimální marže 12 % → spodní hranice 13${NBSP}062,50 Kč`));
  assert.match(t, /Cena zvednuta na spodní hranici/);
  assert.match(t, /Zaokrouhlení na …990 dolů/);
  assert.match(t, /Strategie „Výchozí“/);
  // podlaha 13 062,50 → zaokrouhlení dolů 12 990 je pod ní → nahoru 13 990
  assert.equal(d.floor, 13062.5);
  assert.equal(d.new_price, 13990);
  assert.ok(d.flags.includes('floor'));
});

// ---------------------------------------------------------------------------------------------
// Režimy cíle

test('pricing: undercut_min s procentním i absolutním posunem', () => {
  assert.equal(cp({}, MARKET, { target: { mode: 'undercut_min', offset_pct: -1 } }).new_price, 8910);
  assert.equal(cp({}, MARKET, { target: { mode: 'undercut_min', offset_abs: -10 } }).new_price, 8990);
  assert.equal(cp({}, MARKET, { target: { mode: 'undercut_min', offset_pct: -1, offset_abs: -10 } }).new_price, 8900);
  assert.equal(cp({}, MARKET, { target: { mode: 'undercut_min', offset_pct: 2 } }).new_price, 9180);
});

test('pricing: match_min posun ignoruje', () => {
  const d = cp({}, MARKET, { target: { mode: 'match_min', offset_pct: -5, offset_abs: -100 } });
  assert.equal(d.new_price, 9000);
  assert.equal(d.reference_price, 9000);
});

test('pricing: rank – pozice, posun, remízy a pozice za počtem konkurentů', () => {
  assert.equal(cp({}, MARKET, { target: { mode: 'rank', rank: 2 } }).new_price, 9500);
  assert.equal(cp({}, MARKET, { target: { mode: 'rank', rank: 2, offset_abs: -10 } }).new_price, 9490);
  assert.equal(cp({}, MARKET, { target: { mode: 'rank', rank: 1 } }).new_price, 9000);
  const beyond = cp({}, MARKET, { target: { mode: 'rank', rank: 10 } });
  assert.equal(beyond.new_price, 12000, 'rank > count → nejdražší');
  assert.match(texts(beyond), /konkurentů je jen 4/);
  const ties = [offer('A', 9000), offer('B', 9000), offer('C', 9500)];
  assert.equal(cp({}, ties, { target: { mode: 'rank', rank: 2 } }).new_price, 9000);
  assert.equal(cp({}, ties, { target: { mode: 'rank', rank: 3 } }).new_price, 9500);
  const d = cp({}, MARKET, { target: { mode: 'rank', rank: 2, offset_abs: -1 } });
  assert.equal(d.rank_after, 2);
});

test('pricing: market_avg a market_median', () => {
  assert.equal(cp({}, MARKET, { target: { mode: 'market_avg' } }).new_price, 10250);
  assert.equal(cp({}, MARKET, { target: { mode: 'market_avg', offset_pct: -2 } }).new_price, 10045);
  assert.equal(cp({ price: 11000 }, MARKET, { target: { mode: 'market_median' } }).new_price, 10000);
  const d = cp({ price: 11000 }, MARKET, { target: { mode: 'market_median', offset_pct: -2 } });
  assert.equal(d.reference_price, 10000);
  assert.equal(d.new_price, 9800);
});

test('pricing: competitor – podle jména (nameKey) nebo popisku; chybí → propadnutí', () => {
  const offers = [...MARKET, offer('www.Kolo-Shop.cz', 10990, { label: 'Kolo Shop' })];
  assert.equal(cp({}, offers, { target: { mode: 'competitor', competitor: 'kolo-shop.cz', offset_abs: -1 } }).new_price, 10989);
  assert.equal(cp({}, offers, { target: { mode: 'competitor', competitor: 'KOLO SHOP' } }).new_price, 10990);
  const missing = cp({}, MARKET, { target: { mode: 'competitor', competitor: 'Nikdo' } });
  assert.equal(missing.action, 'skip');
  assert.equal(missing.reason, 'fallthrough');
  assert.equal(missing.base_missing, 'no_competitor');
  // konkurent je v trhu, ale neskladem → nepoužitelný
  const oos = cp({}, [offer('K', 9000, { in_stock: 0 }), offer('L', 9500)], { target: { mode: 'competitor', competitor: 'K' } });
  assert.equal(oos.base_missing, 'no_competitor');
});

test('pricing: msrp s posunem; bez MOC → propadnutí no_msrp', () => {
  assert.equal(cp({}, [], { target: { mode: 'msrp' } }).new_price, 12000);
  assert.equal(cp({}, [], { target: { mode: 'msrp', offset_pct: -10 } }).new_price, 10800);
  const d = cp({ msrp: null }, MARKET, { target: { mode: 'msrp' } });
  assert.equal(d.reason, 'fallthrough');
  assert.equal(d.base_missing, 'no_msrp');
});

test('pricing: cost_plus = gross(nákup × (1 + přirážka)); bez nákupu → no_cost', () => {
  const d = cp({}, [], { target: { mode: 'cost_plus', markup_pct: 30 } });
  assert.equal(d.new_price, 9438); // 6000 × 1,3 × 1,21
  assert.equal(d.reference_price, 7260);
  const vat12 = cp({ vat_rate: 12 }, [], { target: { mode: 'cost_plus', markup_pct: 50 } });
  assert.equal(vat12.new_price, 10080);
  assert.equal(cp({ purchase_price: null }, [], { target: { mode: 'cost_plus', markup_pct: 30 } }).base_missing, 'no_cost');
});

test('pricing: keep – v mezích beze změny, mimo meze úprava', () => {
  const d = cp({}, MARKET, { target: { mode: 'keep' } });
  assert.equal(d.action, 'no_change');
  assert.equal(d.reason, 'keep');
  assert.equal(d.new_price, 10000);
  const low = cp({ price: 7000 }, MARKET, { target: { mode: 'keep' }, limits: { min_margin_pct: 20 } });
  assert.equal(low.action, 'change');
  assert.equal(low.new_price, 9075);
  assert.ok(low.flags.includes('floor'));
  assert.equal(cp({ price: null }, [], { target: { mode: 'keep' } }).base_missing, 'no_price');
});

test('pricing: fixed', () => {
  const d = cp({}, MARKET, { target: { mode: 'fixed', fixed_price: 8888 } });
  assert.equal(d.new_price, 8888);
  assert.equal(d.target_price, 8888);
});

test('pricing: clearance – krok slevy, čekání, vynucení limitem', () => {
  const cfg = { target: { mode: 'clearance', step_pct: 5, every_days: 14, max_sales_30: 0 } };
  // nikdy neměněno = krok je na řadě
  let d = cp({ sales_30: 0, price_changed_at: null }, [], cfg);
  assert.equal(d.action, 'change');
  assert.equal(d.new_price, 9500);
  // přesně 14 dní → na řadě
  d = cp({ sales_30: 0, price_changed_at: daysAgo(14) }, [], cfg);
  assert.equal(d.new_price, 9500);
  // 13,9 dne → čeká
  d = cp({ sales_30: 0, price_changed_at: daysAgo(13.9) }, [], cfg);
  assert.equal(d.action, 'no_change');
  assert.equal(d.reason, 'clearance_wait');
  // prodává se → čeká
  d = cp({ sales_30: 2, price_changed_at: daysAgo(30) }, [], cfg);
  assert.equal(d.reason, 'clearance_wait');
  assert.match(texts(d), /prodává/);
  // sales_30 null = 0
  assert.equal(cp({ sales_30: null }, [], cfg).new_price, 9500);
  // čeká, ale aktuální cena porušuje strop MOC → vynucená změna
  d = cp({ sales_30: 5, price: 13000, msrp: 12000 }, [], { ...cfg, limits: { max_above_msrp_pct: 0 } });
  assert.equal(d.action, 'change');
  assert.equal(d.new_price, 12000);
  assert.ok(d.flags.includes('ceiling'));
  // bez aktuální ceny → propadnutí
  assert.equal(cp({ price: null, sales_30: 0 }, [], cfg).base_missing, 'no_price');
  // podlaha zastaví další slevy
  d = cp({ sales_30: 0, price: 9100 }, [], { ...cfg, limits: { min_margin_pct: 20 } });
  assert.equal(d.new_price, 9075);
});

// ---------------------------------------------------------------------------------------------
// Záložní postupy

test('pricing: fallback next → skip fallthrough s base_missing', () => {
  const d = cp({}, [], { target: { mode: 'undercut_min' } });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'fallthrough');
  assert.equal(d.base_missing, 'no_market');
  assert.equal(d.new_price, null);
  const few = cp({}, MARKET.slice(0, 2), { target: { mode: 'market_median' }, competitors: { min_competitors: 3 } });
  assert.equal(few.base_missing, 'no_market');
  assert.match(texts(few), /alespoň 3/);
});

test('pricing: fallback keep → no_change no_market; porušení limitu → úprava', () => {
  const d = cp({}, [], { target: { mode: 'undercut_min' }, fallback: { mode: 'keep' } });
  assert.equal(d.action, 'no_change');
  assert.equal(d.reason, 'no_market');
  assert.ok(d.flags.includes('fallback'));
  const over = cp({ max_price: 9000 }, [], { target: { mode: 'undercut_min' }, fallback: { mode: 'keep' } });
  assert.equal(over.action, 'change');
  assert.equal(over.new_price, 9000);
  assert.ok(over.flags.includes('fallback'));
  assert.ok(over.flags.includes('ceiling'));
  // keep bez aktuální ceny → propadnutí
  assert.equal(cp({ price: null }, [], { target: { mode: 'undercut_min' }, fallback: { mode: 'keep' } }).reason, 'fallthrough');
});

test('pricing: fallback msrp a cost_plus; chybí-li i jejich základ → propadnutí', () => {
  let d = cp({}, [], { target: { mode: 'undercut_min' }, fallback: { mode: 'msrp', offset_pct: -5 } });
  assert.equal(d.new_price, 11400);
  assert.ok(d.flags.includes('fallback'));
  d = cp({ msrp: null }, [], { target: { mode: 'undercut_min' }, fallback: { mode: 'msrp' } });
  assert.equal(d.reason, 'fallthrough');
  assert.equal(d.base_missing, 'no_market');
  d = cp({}, [], { target: { mode: 'undercut_min' }, fallback: { mode: 'cost_plus', markup_pct: 25 } });
  assert.equal(d.new_price, 9075);
  assert.ok(d.flags.includes('fallback'));
  d = cp({ purchase_price: null }, [], { target: { mode: 'undercut_min' }, fallback: { mode: 'cost_plus', markup_pct: 25 } });
  assert.equal(d.reason, 'fallthrough');
  // msrp režim bez MOC + fallback cost_plus s přirážkou z cíle
  d = cp({ msrp: null }, [], { target: { mode: 'msrp', markup_pct: 10 }, fallback: { mode: 'cost_plus' } });
  assert.equal(d.new_price, 7986);
});

// ---------------------------------------------------------------------------------------------
// Hranice (guardrails)

test('pricing: minimální marže → podlaha a přesná marže po změně', () => {
  const d = cp({}, [offer('A', 8000)], { target: { mode: 'match_min' }, limits: { min_margin_pct: 20 } });
  assert.equal(d.floor, 9075);
  assert.equal(d.new_price, 9075);
  assert.deepEqual(d.flags, ['floor']);
  assert.equal(d.margin_after, 20);
  // podlaha se zaokrouhluje na haléře nahoru – marže nikdy pod minimum
  const e = cp({ purchase_price: 7777 }, [offer('A', 5000)], { target: { mode: 'match_min' }, limits: { min_margin_pct: 13 } });
  assert.ok(e.margin_after >= 13, String(e.margin_after));
  assert.ok(e.new_price >= (7777 / 0.87) * 1.21 - 1e-9);
});

test('pricing: minimální zisk, MOC podlaha, ruční min. cena', () => {
  assert.equal(cp({}, [offer('A', 5000)], { target: { mode: 'match_min' }, limits: { min_profit_abs: 1000 } }).new_price, 8470);
  assert.equal(cp({}, [offer('A', 5000)], { target: { mode: 'match_min' }, limits: { max_below_msrp_pct: 30 } }).new_price, 8400);
  assert.equal(cp({ min_price: 9999 }, [offer('A', 5000)], { target: { mode: 'match_min' } }).new_price, 9999);
  assert.equal(cp({ min_price: 9999 }, [offer('A', 5000)], { target: { mode: 'match_min' }, limits: { respect_product_limits: false } }).new_price, 5000);
  // nejvyšší podlaha vyhrává
  const d = cp({ min_price: 8000 }, [offer('A', 5000)], { target: { mode: 'match_min' }, limits: { min_margin_pct: 20, min_profit_abs: 1000, max_below_msrp_pct: 30 } });
  assert.equal(d.floor, 9075);
  assert.equal(d.new_price, 9075);
});

test('pricing: stropy – MOC, max. marže, ruční max. cena', () => {
  let d = cp({}, [offer('A', 13000)], { target: { mode: 'match_min' }, limits: { max_above_msrp_pct: 0 } });
  assert.equal(d.new_price, 12000);
  assert.deepEqual(d.flags, ['ceiling']);
  assert.equal(cp({}, [offer('A', 13000)], { target: { mode: 'match_min' }, limits: { max_above_msrp_pct: 5 } }).new_price, 12600);
  d = cp({}, [offer('A', 11000)], { target: { mode: 'match_min' }, limits: { max_margin_pct: 30 } });
  assert.equal(d.ceiling, 10371.42);
  assert.equal(d.new_price, 10371.42);
  assert.equal(cp({ max_price: 9500 }, [offer('A', 11000)], { target: { mode: 'match_min' } }).new_price, 9500);
  // bez MOC není MOC strop
  assert.equal(cp({ msrp: null }, [offer('A', 13000)], { target: { mode: 'match_min' }, limits: { max_above_msrp_pct: 0 } }).new_price, 13000);
});

test('pricing: podlaha vždy vyhrává nad stropem (limits_conflict)', () => {
  let d = cp({ min_price: 11000, max_price: 10500 }, [offer('A', 9000)], { target: { mode: 'match_min' } });
  assert.equal(d.new_price, 11000);
  assert.ok(d.flags.includes('limits_conflict'));
  assert.ok(d.flags.includes('floor'));
  d = cp({ min_price: 11000, max_price: 10500 }, [offer('A', 12000)], { target: { mode: 'match_min' } });
  assert.equal(d.new_price, 11000);
  assert.deepEqual(d.flags.sort(), ['ceiling', 'floor', 'limits_conflict']);
  // i po zaokrouhlení: dolů 10 990 < podlaha → nahoru 11 990 (nad stropem, ale podlaha vyhrává)
  d = cp({ min_price: 11000, max_price: 10500 }, [offer('A', 12000)], { target: { mode: 'match_min' }, rounding: { mode: 'ending', direction: 'down', bands: [{ up_to: null, ending: 990 }] } });
  assert.equal(d.new_price, 11990);
  assert.equal(d.auto_approve, false);
});

test('pricing: omezení změny (max. pokles/nárůst) → change_limited', () => {
  let d = cp({}, [offer('A', 5000)], { target: { mode: 'match_min' }, limits: { max_decrease_pct: 10 } });
  assert.equal(d.new_price, 9000);
  assert.deepEqual(d.flags, ['change_limited']);
  d = cp({}, [offer('A', 20000)], { target: { mode: 'match_min' }, limits: { max_increase_pct: 15 } });
  assert.equal(d.new_price, 11500);
  assert.deepEqual(d.flags, ['change_limited']);
  // v limitu → bez příznaku
  d = cp({}, [offer('A', 9500)], { target: { mode: 'match_min' }, limits: { max_decrease_pct: 10 } });
  assert.deepEqual(d.flags, []);
});

test('pricing: strop přebije limit změny, podlaha přebije limit změny (floor_over_change_limit)', () => {
  let d = cp({ max_price: 8500 }, [offer('A', 9500)], { target: { mode: 'match_min' }, limits: { max_decrease_pct: 10 } });
  assert.equal(d.new_price, 8500);
  assert.ok(d.flags.includes('ceiling'));
  d = cp({ price: 8000, purchase_price: 7000 }, [offer('A', 8000)], { target: { mode: 'match_min' }, limits: { min_margin_pct: 10, max_increase_pct: 5 }, approval: { auto: true, auto_max_change_pct: 50 } });
  assert.equal(d.floor, 9411.12);
  assert.equal(d.new_price, 9411.12);
  assert.ok(d.flags.includes('floor'));
  assert.ok(d.flags.includes('floor_over_change_limit'));
  assert.equal(d.auto_approve, false);
});

test('pricing: allow_increase / allow_decrease = false', () => {
  let d = cp({}, [offer('A', 12000)], { target: { mode: 'match_min' }, limits: { allow_increase: false } });
  assert.equal(d.action, 'no_change');
  assert.equal(d.new_price, 10000);
  d = cp({}, [offer('A', 8000)], { target: { mode: 'match_min' }, limits: { allow_decrease: false } });
  assert.equal(d.action, 'no_change');
  // snížení stále povoleno, když zakážeme jen zvýšení
  assert.equal(cp({}, [offer('A', 8000)], { target: { mode: 'match_min' }, limits: { allow_increase: false } }).new_price, 8000);
  // zákaz zvýšení nepřebije podlahu
  d = cp({ price: 8000, purchase_price: 7000 }, [offer('A', 12000)], { target: { mode: 'match_min' }, limits: { allow_increase: false, min_margin_pct: 10 } });
  assert.equal(d.new_price, 9411.12);
  assert.ok(d.flags.includes('floor_over_change_limit'));
  // zákaz snížení nepřebije strop
  d = cp({ max_price: 9000 }, [offer('A', 8000)], { target: { mode: 'match_min' }, limits: { allow_decrease: false } });
  assert.equal(d.new_price, 9000);
  // zákaz zvýšení platí i po zaokrouhlení nahoru (cena 10 000 není cenový bod)
  d = cp({}, [offer('A', 12000)], { target: { mode: 'match_min' }, limits: { allow_increase: false }, rounding: { mode: 'ending', direction: 'up', bands: [{ up_to: null, ending: 9 }] } });
  assert.equal(d.action, 'no_change');
  assert.equal(d.new_price, 10000);
});

test('pricing: chybějící nákupní cena → no_cost, bez podlahy marže, žádné automatické snížení', () => {
  const auto = { auto: true, auto_max_change_pct: 50 };
  let d = cp({ purchase_price: null }, [offer('A', 5000)], { target: { mode: 'match_min' }, limits: { min_margin_pct: 20 }, approval: auto });
  assert.equal(d.new_price, 5000);
  assert.ok(d.flags.includes('no_cost'));
  assert.equal(d.floor, null);
  assert.equal(d.auto_approve, false, 'snížení bez nákupní ceny se neschvaluje automaticky');
  d = cp({ purchase_price: null }, [offer('A', 10300)], { target: { mode: 'match_min' }, approval: auto });
  assert.equal(d.auto_approve, true, 'zvýšení bez nákupní ceny smí projít');
  assert.ok(d.flags.includes('no_cost'));
  // nákupní cena 0 = chybí
  assert.ok(cp({ purchase_price: 0 }, [offer('A', 5000)], { target: { mode: 'match_min' } }).flags.includes('no_cost'));
});

test('pricing: below_cost když chybí podlaha marže', () => {
  const d = cp({}, [offer('A', 7000)], { target: { mode: 'match_min' }, approval: { auto: true, auto_max_change_pct: 100 } });
  assert.ok(d.flags.includes('below_cost')); // 7000 / 1,21 = 5785 < 6000
  assert.equal(d.auto_approve, false);
  assert.match(texts(d), /pod nákupní cenou/);
  assert.ok(!cp({}, [offer('A', 7260)], { target: { mode: 'match_min' } }).flags.includes('below_cost'), 'přesně nákup = není pod');
});

// ---------------------------------------------------------------------------------------------
// Prahy

test('pricing: prahy minimální změny', () => {
  const lim = (x) => ({ target: { mode: 'match_min' }, limits: { min_change_abs: 5, min_change_pct: 0.5, ...x } });
  let d = cp({}, [offer('A', 9996)], lim({ min_change_pct: 0 }));
  assert.equal(d.action, 'no_change');
  assert.equal(d.reason, 'below_threshold');
  assert.equal(d.new_price, 10000);
  d = cp({}, [offer('A', 9960)], lim());
  assert.equal(d.reason, 'below_threshold', '40 Kč < 0,5 % z 10 000');
  d = cp({}, [offer('A', 9950)], lim());
  assert.equal(d.action, 'change', 'přesně na prahu = změna');
  d = cp({}, [offer('A', 10004)], lim({ min_change_pct: 0 }));
  assert.equal(d.reason, 'below_threshold');
  // pod prahem, ale aktuální cena porušuje podlahu → změna
  d = cp({ price: 9000, min_price: 9010 }, [offer('A', 9005)], lim());
  assert.equal(d.action, 'change');
  assert.equal(d.new_price, 9010);
  // stejná cena s nulovými prahy
  d = cp({}, [offer('A', 10000)], { target: { mode: 'match_min' } });
  assert.equal(d.action, 'no_change');
  assert.equal(d.reason, 'same_price');
});

// ---------------------------------------------------------------------------------------------
// Zaokrouhlení v kontextu hranic

const BANDS = { mode: 'ending', direction: 'down', bands: [{ up_to: 1000, ending: 9 }, { up_to: 10000, ending: 90 }, { up_to: null, ending: 990 }] };

test('pricing: zaokrouhlení pod podlahu → nahoru', () => {
  const d = cp({}, [offer('A', 8000)], { target: { mode: 'match_min' }, limits: { min_margin_pct: 20 }, rounding: BANDS });
  assert.equal(d.floor, 9075);
  assert.equal(d.new_price, 9090);
  assert.match(texts(d), /pod spodní hranicí → nahoru/);
});

test('pricing: zaokrouhlení nahoru nad strop → dolů, je-li nad podlahou', () => {
  const up = { ...BANDS, direction: 'up' };
  let d = cp({ msrp: 11950 }, [offer('A', 11940)], { target: { mode: 'match_min' }, limits: { max_above_msrp_pct: 0 }, rounding: up });
  assert.equal(d.new_price, 10990);
  // dolní kandidát (10 990) pod podlahou 11 500, horní (11 990) nad stropem 11 950 → limity mají přednost před
  // zakončením: nezaokrouhlená cena uvnitř [11 500; 11 950] co nejblíž cíli → 11 940 (rounding_skipped)
  d = cp({ msrp: 11950, min_price: 11500 }, [offer('A', 11940)], { target: { mode: 'match_min' }, limits: { max_above_msrp_pct: 0 }, rounding: up });
  assert.equal(d.new_price, 11940);
  assert.ok(d.flags.includes('rounding_skipped'));
});

test('pricing: zaokrouhlení nepřekročí limit změny ani neobrátí směr', () => {
  // cíl −8,3 %, dolů na …990 by bylo −11,1 % (limit 10 %) → nahoru 12 990
  const offers = [offer('VeloMarket', 12490), offer('B', 12990)];
  let d = computePrice(product({ price: 13490, purchase_price: 8000, msrp: 14990 }), offers, { id: 1, name: 'S', config: { target: { offset_pct: -1 } } }, { now: NOW });
  assert.equal(d.new_price, 12990);
  assert.ok(d.change_pct >= -10);
  // žádný bod v limitu a opačný směr → ponechat aktuální cenu
  d = cp({ price: 12500 }, [offer('A', 12000)], { target: { mode: 'match_min' }, limits: { max_decrease_pct: 1 }, rounding: BANDS });
  assert.equal(d.action, 'no_change');
  assert.equal(d.new_price, 12500);
  // cíl rovný aktuální ceně (mimo cenový bod) se nezaokrouhluje
  d = cp({ price: 12490 }, [offer('A', 12490)], { target: { mode: 'match_min' }, rounding: BANDS });
  assert.equal(d.action, 'no_change');
  assert.equal(d.reason, 'same_price');
});

test('pricing: zaokrouhlení proti nastavenému směru jen kvůli hranici/limitu, jinak ponechat cenu', () => {
  const up = { ...BANDS, direction: 'up' };
  // snížení 13 490 → 13 100, směr nahoru: 13 990 by zdražilo, 12 990 by bylo pod cílem → ponechat 13 490
  let d = cp({ price: 13490 }, [], { target: { mode: 'fixed', fixed_price: 13100 }, rounding: up });
  assert.equal(d.action, 'no_change');
  assert.equal(d.new_price, 13490);
  assert.match(texts(d), /obrátilo směr změny/);
  // zvýšení 13 490 → 13 600, směr dolů: 12 990 by zlevnilo → ponechat
  d = cp({ price: 13490 }, [], { target: { mode: 'fixed', fixed_price: 13600 }, rounding: BANDS });
  assert.equal(d.action, 'no_change');
  // nahoru nad strop → dolů (SPEC krok 7), pokud neobrací směr
  d = cp({ price: 13490, max_price: 13500 }, [], { target: { mode: 'fixed', fixed_price: 13400 }, rounding: up });
  assert.equal(d.new_price, 12990);
});

test('pricing: formatMoney/formatPct jsou shodné s Intl cs-CZ', () => {
  const nf0 = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nfp = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 });
  const values = [0, 1, 9, 99, 999, 1000, 1249, 12490, 12490.5, 12365.1, 999999.99, 1234567.891, -1, -1249.5, 0.005, 10755.555, 1e9 + 0.25];
  for (let x = -3000; x < 3000000; x += 7919.37) values.push(x);
  for (const v of values) {
    const r = Math.round((v + Number.EPSILON * Math.sign(v)) * 100) / 100;
    const expected = `${(Number.isInteger(r) ? nf0 : nf2).format(r === 0 ? 0 : r)} Kč`;
    assert.equal(formatMoney(v), expected, String(v));
    assert.equal(formatPct(v / 1000), `${nfp.format(Math.round((v / 1000 + Number.EPSILON * Math.sign(v)) * 100) / 100 || 0)} %`, String(v / 1000));
  }
});

test('pricing: směr nearest', () => {
  const near = { ...BANDS, direction: 'nearest' };
  assert.equal(cp({}, [offer('A', 9460)], { target: { mode: 'match_min' }, rounding: near }).new_price, 9490);
  assert.equal(cp({}, [offer('A', 9430)], { target: { mode: 'match_min' }, rounding: near }).new_price, 9390);
});

test('pricing: výchozí config (bez volných limitů) – typický případ', () => {
  const d = computePrice(product({ price: 13490, purchase_price: 8000, msrp: 14990 }), [offer('A', 13290), offer('B', 13990)], { id: 1, name: 'S', config: {} }, { now: NOW });
  // cíl 13 290 → dolů 12 990 (−3,7 %, v limitu 10 %)
  assert.equal(d.new_price, 12990);
  assert.equal(d.action, 'change');
  assert.equal(d.auto_approve, false);
});

// ---------------------------------------------------------------------------------------------
// Zámek a sklad

test('pricing: zámek (locked_until)', () => {
  let d = cp({ locked: 1 }, MARKET, { target: { mode: 'match_min' } });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'locked');
  assert.equal(d.new_price, null);
  assert.ok(d.market.count > 0, 'trh se vyplní i u přeskočených');
  d = cp({ locked: 1, locked_until: '2026-10-01T00:00:00Z' }, MARKET, { target: { mode: 'match_min' } });
  assert.equal(d.reason, 'locked');
  assert.match(texts(d), /zamčena do/);
  d = cp({ locked: 1, locked_until: '2026-09-01T00:00:00Z' }, MARKET, { target: { mode: 'match_min' } });
  assert.equal(d.action, 'change', 'zámek vypršel');
});

test('pricing: nulový sklad – reprice / skip / msrp', () => {
  assert.equal(cp({ stock: 0 }, MARKET, { target: { mode: 'match_min' } }).action, 'change');
  let d = cp({ stock: 0 }, MARKET, { target: { mode: 'match_min' }, stock: { zero_stock: 'skip' } });
  assert.equal(d.reason, 'zero_stock');
  d = cp({ stock: -2 }, MARKET, { target: { mode: 'match_min' }, stock: { zero_stock: 'skip' } });
  assert.equal(d.reason, 'zero_stock');
  assert.equal(cp({ stock: null }, MARKET, { target: { mode: 'match_min' }, stock: { zero_stock: 'skip' } }).action, 'change', 'neznámý sklad = přecenit');
  d = cp({ stock: 0 }, MARKET, { target: { mode: 'match_min' }, stock: { zero_stock: 'msrp' } });
  assert.equal(d.new_price, 12000);
  assert.equal(d.reference_price, 12000);
  d = cp({ stock: 0, msrp: null }, MARKET, { target: { mode: 'match_min' }, stock: { zero_stock: 'msrp' } });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'no_msrp');
  assert.equal(cp({ stock: 3 }, MARKET, { target: { mode: 'match_min' }, stock: { zero_stock: 'msrp' } }).new_price, 9000);
});

// ---------------------------------------------------------------------------------------------
// Automatické schválení

test('pricing: automatické schválení a příznak big_change', () => {
  const auto = (x = {}) => ({ target: { mode: 'match_min' }, approval: { auto: true, auto_max_change_pct: 5, ...x } });
  let d = cp({}, [offer('A', 9800)], auto());
  assert.equal(d.auto_approve, true);
  assert.deepEqual(d.flags, []);
  assert.match(texts(d), /Automaticky schváleno/);
  d = cp({}, [offer('A', 9000)], auto());
  assert.ok(d.flags.includes('big_change'));
  assert.equal(d.auto_approve, false);
  assert.match(texts(d), /velká změna/);
  d = cp({}, [offer('A', 9500)], auto());
  assert.equal(d.auto_approve, true, 'přesně 5 % není víc než 5 %');
  d = cp({}, [offer('A', 9000)], auto({ auto_max_change_pct: null }));
  assert.equal(d.auto_approve, true);
  assert.ok(!d.flags.includes('big_change'));
  d = cp({}, [offer('A', 9800)], { target: { mode: 'match_min' }, approval: { auto: false } });
  assert.equal(d.auto_approve, false);
  d = cp({}, [offer('A', 9000)], { target: { mode: 'match_min' }, approval: { auto: false, auto_max_change_pct: 5 } });
  assert.ok(d.flags.includes('big_change'), 'příznak se nastaví i bez automatického schvalování');
  // produkt bez ceny se automaticky neschvaluje
  d = cp({ price: null }, [offer('A', 9000)], auto());
  assert.equal(d.action, 'change');
  assert.equal(d.old_price, null);
  assert.equal(d.change_pct, null);
  assert.equal(d.auto_approve, false);
  // no_change se neschvaluje
  assert.equal(cp({}, [offer('A', 10000)], auto()).auto_approve, false);
});

// ---------------------------------------------------------------------------------------------
// Ostatní

test('pricing: filtr konkurence strategie se použije (vyřazené v rozhodnutí)', () => {
  const offers = [offer('Alza', 8000, { tags: ['marketplace'] }), offer('B', 9000), offer('C', 9500, { in_stock: 0 }), offer('D', 7000, { name: 'Kolo bazar' })];
  const d = cp({}, offers, { target: { mode: 'match_min' }, competitors: { exclude_tags: ['marketplace'], exclude_keywords: ['bazar'] } });
  assert.equal(d.new_price, 9000);
  assert.deepEqual(
    d.market.excluded.map((e) => [e.competitor, e.reason]),
    [
      ['Alza', 'tag'],
      ['C', 'out_of_stock'],
      ['D', 'keyword'],
    ]
  );
  // doprava
  const s = cp({}, [offer('A', 9000, { shipping: 150 }), offer('B', 9100, { shipping: 0 })], { target: { mode: 'match_min' }, competitors: { include_shipping: true } });
  assert.equal(s.new_price, 9100);
});

test('pricing: neplatná konfigurace → skip invalid_config', () => {
  const d = computePrice(product(), MARKET, { id: 1, name: 'X', config: { limits: { min_margin_pct: 100 } } }, { now: NOW });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'invalid_config');
  assert.match(texts(d), /min_margin_pct/);
  const e = computePrice(product(), MARKET, { id: 1, name: 'X', config: { target: { mode: 'podle nálady' } } }, { now: NOW });
  assert.equal(e.reason, 'invalid_config');
});

test('pricing: předem normalizovaný config i nastavení DPH z ctx', () => {
  const { config } = normalizeConfig(looseConfig({ target: { mode: 'cost_plus', markup_pct: 10 } }));
  const d = computePrice(product({ vat_rate: null }), [], { id: 1, config }, { now: NOW, settings: { vat_rate_default: 12 } });
  assert.equal(d.new_price, 7392); // 6000 × 1,1 × 1,12
});

test('pricing: stáří nabídek podle nastavení offer_max_age_days', () => {
  const offers = [offer('A', 8000, { observed_at: daysAgo(3) }), offer('B', 9000)];
  assert.equal(cp({}, offers, { target: { mode: 'match_min' } }).new_price, 8000);
  assert.equal(cp({}, offers, { target: { mode: 'match_min' } }, { settings: { offer_max_age_days: 2 } }).new_price, 9000);
  assert.equal(cp({}, offers, { target: { mode: 'match_min' }, competitors: { max_age_days: 1 } }).new_price, 9000);
});
