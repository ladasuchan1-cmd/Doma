'use strict';
// Nezávislé black-box testy cenotvorby – src/engine/pricing.js computePrice() podle SPEC §6.5 a §6.7.
// Testy jsou psané jen ze SPEC (implementaci nečtou). Výpočty jsou rozepsané v komentářích.
//
// Standardní situace (není-li uvedeno jinak):
//   produkt: cena 13 490 Kč s DPH, nákup 8 000 Kč bez DPH, DPH 21 %, MOC 14 990, sklad 5, sales_30 3,
//            cena naposledy změněna před 30 dny
//   trh:     VeloMarket.cz 12 990, Kolo-Shop.cz 13 200, BikeStore.cz 14 000 (vše skladem, 1 den staré)
//   výchozí min. marže 10 % → floor = 8000 / 0.9 × 1.21 = 10 755,56 (nijak neomezuje ceny kolem 12–13 tis.)
//
// „ISO“ konfigurace izoluje sledovanou věc: bez limitů změny, bez stropu MOC, bez prahu, zaokrouhlení 'none'.

const test = require('node:test');
const assert = require('node:assert');
const { deepMerge } = require('../src/db.js');
const H = require('./engine-spec-helpers.js');
const { NOW, daysAgo, daysAhead, offer, market3, decide, approx, hasFlag, OPEN, OPEN_LIMITS, R_NONE, R_INT, DEFAULT_SETTINGS } = H;

const ISO = { limits: OPEN, rounding: R_NONE };
const iso = (over) => deepMerge(structuredClone(ISO), over);
const FLOOR10 = 8000 / 0.9 * 1.21; // 10 755,555…

function assertChange(d, newPrice, tol = 0.001) {
  assert.strictEqual(d.action, 'change', `očekávána změna, dostali jsme ${d.action}/${d.reason}`);
  approx(d.new_price, newPrice, tol, 'new_price');
}
function assertSkip(d, reason) {
  assert.strictEqual(d.action, 'skip', `očekáván skip, dostali jsme ${d.action}/${d.reason}`);
  assert.strictEqual(d.reason, reason);
}
function assertNoChange(d, reason) {
  assert.strictEqual(d.action, 'no_change', `očekáváno no_change, dostali jsme ${d.action}/${d.reason} (${d.new_price})`);
  if (reason !== undefined) assert.strictEqual(d.reason, reason);
}
function assertFallthrough(d, baseMissing) {
  assertSkip(d, 'fallthrough');
  assert.strictEqual(d.base_missing, baseMissing);
}

// =====================================================================================================
// 1. Režimy cíle (§6.7 krok 4)
// =====================================================================================================

test('cíl undercut_min offset_pct −1: ref 12 990 → 12 990 × 0,99 = 12 860,1', () => {
  const d = decide({}, market3(), iso({ target: { mode: 'undercut_min', offset_pct: -1 } }));
  assertChange(d, 12860.1);
  assert.strictEqual(d.reference_price, 12990);
  approx(d.target_price, 12860.1, 0.001, 'target_price');
});

test('cíl undercut_min offset_abs −10: 12 990 − 10 = 12 980', () => {
  const d = decide({}, market3(), iso({ target: { mode: 'undercut_min', offset_abs: -10 } }));
  assertChange(d, 12980);
});

test('cíl undercut_min offset_pct −1 a offset_abs −10: 12 990 × 0,99 − 10 = 12 850,1', () => {
  const d = decide({}, market3(), iso({ target: { mode: 'undercut_min', offset_pct: -1, offset_abs: -10 } }));
  assertChange(d, 12850.1);
});

test('cíl match_min ignoruje offsety: 12 990', () => {
  const d = decide({}, market3(), iso({ target: { mode: 'match_min', offset_pct: -5, offset_abs: -100 } }));
  assertChange(d, 12990);
  assert.strictEqual(d.reference_price, 12990);
});

test('cíl rank 2: ref = prices[1] = 13 200; −10 Kč → 13 190', () => {
  const d = decide({}, market3(), iso({ target: { mode: 'rank', rank: 2, offset_abs: -10 } }));
  assertChange(d, 13190);
  assert.strictEqual(d.reference_price, 13200);
});

test('cíl rank 5 při 3 konkurentech: ref = prices[min(5,3) − 1] = 14 000; −10 → 13 990', () => {
  const d = decide({}, market3(), iso({ target: { mode: 'rank', rank: 5, offset_abs: -10 } }));
  assertChange(d, 13990);
  assert.strictEqual(d.reference_price, 14000);
});

test('cíl rank 1 = nejlevnější: ref 12 990; −1 % → 12 860,1', () => {
  const d = decide({}, market3(), iso({ target: { mode: 'rank', rank: 1, offset_pct: -1 } }));
  assertChange(d, 12860.1);
});

test('cíl market_avg: (12 990 + 13 200 + 14 000) / 3 = 13 396,67', () => {
  const d = decide({}, market3(), iso({ target: { mode: 'market_avg' } }));
  assertChange(d, 13396.67, 0.006);
  approx(d.reference_price, 13396.67, 0.006, 'reference_price');
});

test('cíl market_median −2 %: 13 200 × 0,98 = 12 936', () => {
  const d = decide({}, market3(), iso({ target: { mode: 'market_median', offset_pct: -2 } }));
  assertChange(d, 12936);
  assert.strictEqual(d.reference_price, 13200);
});

test('cíl competitor (jméno přes nameKey): Kolo-Shop.cz 13 200 − 1 = 13 199', () => {
  const d = decide({}, market3(), iso({ target: { mode: 'competitor', competitor: 'www.KOLO-SHOP.cz', offset_abs: -1 } }));
  assertChange(d, 13199);
  assert.strictEqual(d.reference_price, 13200);
});

test('cíl competitor používá efektivní cenu (s dopravou při include_shipping)', () => {
  const offers = [offer('VeloMarket.cz', 12990), offer('Kolo-Shop.cz', 13000, { shipping: 150 }), offer('BikeStore.cz', 14000)];
  // efektivní Kolo-Shop = 13 000 + 150 = 13 150 ; −1 % → 13 018,5
  const d = decide({}, offers, iso({ target: { mode: 'competitor', competitor: 'Kolo-Shop.cz', offset_pct: -1 }, competitors: { include_shipping: true } }));
  assertChange(d, 13018.5);
  assert.strictEqual(d.reference_price, 13150);
});

test('cíl msrp −5 %: 14 990 × 0,95 = 14 240,5', () => {
  const d = decide({}, market3(), iso({ target: { mode: 'msrp', offset_pct: -5 } }));
  assertChange(d, 14240.5);
  assert.strictEqual(d.reference_price, 14990);
});

test('cíl msrp nepotřebuje trh', () => {
  const d = decide({}, [], iso({ target: { mode: 'msrp', offset_pct: -5 } }));
  assertChange(d, 14240.5);
});

test('cíl cost_plus 50 %: gross(8000 × 1,5) = 12 000 × 1,21 = 14 520; DPH 12 % → 13 440', () => {
  const d = decide({}, [], iso({ target: { mode: 'cost_plus', markup_pct: 50 } }));
  assertChange(d, 14520);
  const d12 = decide({ vat_rate: 12 }, [], iso({ target: { mode: 'cost_plus', markup_pct: 50 } }));
  assertChange(d12, 13440);
});

test('cíl keep: cíl = současná cena → no_change', () => {
  const d = decide({}, market3(), iso({ target: { mode: 'keep' } }));
  assertNoChange(d);
});

test('cíl fixed: 11 990', () => {
  const d = decide({}, market3(), iso({ target: { mode: 'fixed', fixed_price: 11990 } }));
  assertChange(d, 11990);
  approx(d.target_price, 11990, 0.001);
});

test('offsety platí jen pro režimy s referencí – fixed a cost_plus je ignorují', () => {
  // §6.7: „For reference-based modes: target = ref × (1 + offset_pct/100) + offset_abs“; fixed/cost_plus mají „target =“.
  const f = decide({}, market3(), iso({ target: { mode: 'fixed', fixed_price: 11990, offset_pct: -10, offset_abs: -100 } }));
  assertChange(f, 11990);
  const c = decide({}, [], iso({ target: { mode: 'cost_plus', markup_pct: 50, offset_pct: -10, offset_abs: -100 } }));
  assertChange(c, 14520);
});

// ---------- clearance ----------

const CLEAR = { mode: 'clearance', step_pct: 5, every_days: 14, max_sales_30: 0 };

test('clearance: splatné (změna před 20 dny, sales_30 0) → 13 490 × 0,95 = 12 815,5; nepotřebuje trh', () => {
  const d = decide({ sales_30: 0, price_changed_at: daysAgo(20) }, [], iso({ target: CLEAR }));
  assertChange(d, 12815.5);
});

test('clearance: přesně every_days (14 dní) → splatné (>=)', () => {
  const d = decide({ sales_30: 0, price_changed_at: daysAgo(14) }, [], iso({ target: CLEAR }));
  assertChange(d, 12815.5);
});

test('clearance: cena nikdy neměněna (price_changed_at null) → splatné', () => {
  const d = decide({ sales_30: 0, price_changed_at: null }, [], iso({ target: CLEAR }));
  assertChange(d, 12815.5);
});

test('clearance: sales_30 null se bere jako 0 → splatné', () => {
  const d = decide({ sales_30: null, price_changed_at: daysAgo(20) }, [], iso({ target: CLEAR }));
  assertChange(d, 12815.5);
});

test('clearance: sales_30 = max_sales_30 → splatné (<=)', () => {
  const d = decide({ sales_30: 2, price_changed_at: daysAgo(20) }, [], iso({ target: { ...CLEAR, max_sales_30: 2 } }));
  assertChange(d, 12815.5);
});

test('clearance: změna před 5 dny → no_change clearance_wait', () => {
  const d = decide({ sales_30: 0, price_changed_at: daysAgo(5) }, [], iso({ target: CLEAR }));
  assertNoChange(d, 'clearance_wait');
});

test('clearance: produkt se prodává (sales_30 2 > 0) → no_change clearance_wait', () => {
  const d = decide({ sales_30: 2, price_changed_at: daysAgo(20) }, [], iso({ target: CLEAR }));
  assertNoChange(d, 'clearance_wait');
});

test('clearance: čekání, ale současná cena porušuje strop (max_price 13 000) → vynucená změna na 13 000', () => {
  const d = decide({ sales_30: 0, price_changed_at: daysAgo(5), max_price: 13000 }, [], iso({ target: CLEAR }));
  assertChange(d, 13000);
});

test('clearance: čekání, ale současná cena pod spodní hranicí (min_price 13 600) → vynucená změna na 13 600', () => {
  const d = decide({ sales_30: 0, price_changed_at: daysAgo(5), min_price: 13600 }, [], iso({ target: CLEAR }));
  assertChange(d, 13600);
});

// =====================================================================================================
// 2. Nedostupná cenová základna a fallback (§3.5, §6.7 krok 4)
// =====================================================================================================

const UNDERCUT = { mode: 'undercut_min', offset_pct: -1 };

test('fallback next: bez nabídek → skip fallthrough, base_missing no_market', () => {
  const d = decide({}, [], iso({ target: UNDERCUT }));
  assertFallthrough(d, 'no_market');
});

test('fallback next: počet použitelných nabídek < min_competitors → no_market', () => {
  // B je mimo sklad → zbývá 1 nabídka < 2
  const offers = [offer('VeloMarket.cz', 12990), offer('Kolo-Shop.cz', 13200, { in_stock: 0 })];
  const d = decide({}, offers, iso({ target: UNDERCUT, competitors: { min_competitors: 2 } }));
  assertFallthrough(d, 'no_market');
});

test('fallback next: rank při 2 konkurentech a min_competitors 3 → no_market', () => {
  const d = decide({}, market3().slice(0, 2), iso({ target: { mode: 'rank', rank: 2 }, competitors: { min_competitors: 3 } }));
  assertFallthrough(d, 'no_market');
});

test('fallback next: všechny nabídky vyřazené (vypnuté / staré / mimo sklad) → no_market', () => {
  const offers = [
    offer('VeloMarket.cz', 12990, { enabled: false }),
    offer('Kolo-Shop.cz', 13200, { observed_at: daysAgo(30) }),
    offer('BikeStore.cz', 14000, { in_stock: 0 }),
  ];
  const d = decide({}, offers, iso({ target: UNDERCUT }));
  assertFallthrough(d, 'no_market');
});

test('fallback next: jmenovaný konkurent chybí → no_competitor', () => {
  const d = decide({}, market3(), iso({ target: { mode: 'competitor', competitor: 'Neexistuje.cz' } }));
  assertFallthrough(d, 'no_competitor');
});

test('fallback next: jmenovaný konkurent je vyřazen filtrem (mimo sklad) → no_competitor', () => {
  // SPEC-AMBIGUOUS: „that competitor's effective price“ – bereme jen z POUŽITÝCH nabídek (po filtru konkurence);
  // cena konkurenta, který zboží nemá skladem, není konzervativně platnou referencí.
  const offers = [offer('VeloMarket.cz', 12990), offer('Kolo-Shop.cz', 9000, { in_stock: 0 })];
  const d = decide({}, offers, iso({ target: { mode: 'competitor', competitor: 'Kolo-Shop.cz' } }));
  assertFallthrough(d, 'no_competitor');
});

test('fallback next: režim msrp bez MOC → no_msrp', () => {
  const d = decide({ msrp: null }, market3(), iso({ target: { mode: 'msrp' } }));
  assertFallthrough(d, 'no_msrp');
});

test('fallback next: cost_plus bez nákupní ceny → no_cost', () => {
  const d = decide({ purchase_price: null }, market3(), iso({ target: { mode: 'cost_plus', markup_pct: 30 } }));
  assertFallthrough(d, 'no_cost');
});

test('fallback next: keep / clearance bez současné ceny → no_price', () => {
  assertFallthrough(decide({ price: null }, market3(), iso({ target: { mode: 'keep' } })), 'no_price');
  assertFallthrough(decide({ price: null, sales_30: 0 }, [], iso({ target: CLEAR })), 'no_price');
});

test('fallback keep: bez trhu → no_change reason no_market', () => {
  const d = decide({}, [], iso({ target: UNDERCUT, fallback: { mode: 'keep' } }));
  assertNoChange(d, 'no_market');
});

test('fallback keep: bez trhu, ale cena nad stropem (max_price 13 000) → změna na 13 000, příznaky fallback + ceiling', () => {
  const d = decide({ max_price: 13000 }, [], iso({ target: UNDERCUT, fallback: { mode: 'keep' } }));
  assertChange(d, 13000);
  assert.ok(hasFlag(d, 'fallback'), `flags: ${d.flags}`);
  assert.ok(hasFlag(d, 'ceiling'), `flags: ${d.flags}`);
});

test('fallback keep: bez trhu, ale cena pod spodní hranicí → zvýšení na floor', () => {
  // nákup 12 000 → floor = 12000 / 0.9 × 1.21 = 16 133,33 > 13 490 → cíl = současná cena → floor → 16 133,34 (2 dp nahoru)
  const d = decide({ purchase_price: 12000 }, [], iso({ target: UNDERCUT, fallback: { mode: 'keep' } }));
  assertChange(d, 16133.34, 0.011);
  assert.ok(d.new_price >= 12000 / 0.9 * 1.21 - 1e-9, 'nová cena nesmí být pod floor');
  assert.ok(hasFlag(d, 'floor'), `flags: ${d.flags}`);
  assert.ok(hasFlag(d, 'fallback'), `flags: ${d.flags}`);
});

test('fallback msrp: MOC × (1 + fallback.offset_pct/100) = 14 990 × 0,95 = 14 240,5 (ne target.offset_pct)', () => {
  const d = decide({}, [], iso({ target: UNDERCUT, fallback: { mode: 'msrp', offset_pct: -5 } }));
  assertChange(d, 14240.5);
  assert.ok(hasFlag(d, 'fallback'), `flags: ${d.flags}`);
});

test('fallback msrp i pro chybějícího jmenovaného konkurenta', () => {
  const d = decide({}, market3(), iso({ target: { mode: 'competitor', competitor: 'Neexistuje.cz' }, fallback: { mode: 'msrp', offset_pct: -5 } }));
  assertChange(d, 14240.5);
  assert.ok(hasFlag(d, 'fallback'));
});

test('fallback msrp bez MOC → skip fallthrough', () => {
  const d = decide({ msrp: null }, [], iso({ target: UNDERCUT, fallback: { mode: 'msrp', offset_pct: -5 } }));
  assertSkip(d, 'fallthrough');
});

test('fallback cost_plus: gross(8000 × 1,4) = 11 200 × 1,21 = 13 552 (fallback.markup_pct, ne target.markup_pct)', () => {
  const d = decide({}, [], iso({ target: { ...UNDERCUT, markup_pct: 10 }, fallback: { mode: 'cost_plus', markup_pct: 40 } }));
  assertChange(d, 13552);
  assert.ok(hasFlag(d, 'fallback'), `flags: ${d.flags}`);
});

test('fallback cost_plus bez nákupní ceny → skip fallthrough', () => {
  const d = decide({ purchase_price: null }, [], iso({ target: UNDERCUT, fallback: { mode: 'cost_plus', markup_pct: 40 } }));
  assertSkip(d, 'fallthrough');
});

test('použití fallbacku nenastane, když je základna dostupná (žádný příznak fallback)', () => {
  const d = decide({}, market3(), iso({ target: UNDERCUT, fallback: { mode: 'msrp', offset_pct: -5 } }));
  assertChange(d, 12860.1);
  assert.ok(!hasFlag(d, 'fallback'));
});

// =====================================================================================================
// 3. Sklad a zámek (§6.7 kroky 1–2)
// =====================================================================================================

test('zero_stock skip: sklad 0 → skip zero_stock; záporný sklad také', () => {
  assertSkip(decide({ stock: 0 }, market3(), iso({ target: UNDERCUT, stock: { zero_stock: 'skip' } })), 'zero_stock');
  assertSkip(decide({ stock: -2 }, market3(), iso({ target: UNDERCUT, stock: { zero_stock: 'skip' } })), 'zero_stock');
});

test('zero_stock skip: kladný sklad → běžné přecenění', () => {
  const d = decide({ stock: 3 }, market3(), iso({ target: UNDERCUT, stock: { zero_stock: 'skip' } }));
  assertChange(d, 12860.1);
});

test('zero_stock reprice (výchozí): sklad 0 → běžné přecenění', () => {
  const d = decide({ stock: 0 }, market3(), iso({ target: UNDERCUT }));
  assertChange(d, 12860.1);
});

test('zero_stock msrp: sklad 0 → cíl = MOC 14 990 (s výchozími limity a zaokrouhlením)', () => {
  // výchozí limity: strop MOC 14 990, max. zvýšení 15 % (15 513,5) ; 14 990 je cenový bod (…990) → 14 990
  const d = decide({ stock: 0 }, market3(), { target: UNDERCUT, stock: { zero_stock: 'msrp' } });
  assertChange(d, 14990);
});

test('zero_stock msrp bez MOC → skip no_msrp', () => {
  const d = decide({ stock: 0, msrp: null }, market3(), iso({ target: UNDERCUT, stock: { zero_stock: 'msrp' } }));
  assertSkip(d, 'no_msrp');
});

test('zámek: locked = 1, locked_until null → skip locked', () => {
  assertSkip(decide({ locked: 1, locked_until: null }, market3(), iso({ target: UNDERCUT })), 'locked');
});

test('zámek: locked_until v budoucnu → skip locked', () => {
  assertSkip(decide({ locked: 1, locked_until: daysAhead(1) }, market3(), iso({ target: UNDERCUT })), 'locked');
});

test('zámek: locked_until v minulosti → zámek vypršel, přeceňuje se', () => {
  assertChange(decide({ locked: 1, locked_until: daysAgo(1) }, market3(), iso({ target: UNDERCUT })), 12860.1);
});

test('zámek: locked = 0 s locked_until v budoucnu → není zamčeno', () => {
  assertChange(decide({ locked: 0, locked_until: daysAhead(5) }, market3(), iso({ target: UNDERCUT })), 12860.1);
});

test('zámek má přednost před zero_stock i před chybějící základnou', () => {
  assertSkip(decide({ locked: 1, stock: 0 }, market3(), iso({ target: UNDERCUT, stock: { zero_stock: 'skip' } })), 'locked');
  assertSkip(decide({ locked: 1 }, [], iso({ target: UNDERCUT })), 'locked');
});

test('zero_stock skip má přednost před chybějící základnou', () => {
  assertSkip(decide({ stock: 0 }, [], iso({ target: UNDERCUT, stock: { zero_stock: 'skip' } })), 'zero_stock');
});

// =====================================================================================================
// 4. Hranice – floor a ceiling (§6.7 krok 5)
// =====================================================================================================

test('floor z min. marže 20 %: 8000 / 0,8 × 1,21 = 12 100; cíl 11 691 → 12 100', () => {
  // undercut −10 %: 12 990 × 0,9 = 11 691 < 12 100
  const d = decide({}, market3(), iso({ target: { mode: 'undercut_min', offset_pct: -10 }, limits: { min_margin_pct: 20 } }));
  assertChange(d, 12100);
  approx(d.floor, 12100, 0.01, 'floor');
  assert.ok(hasFlag(d, 'floor'), `flags: ${d.flags}`);
});

test('floor z min. zisku: gross(8000 + 3000) = 13 310', () => {
  const d = decide({}, market3(), iso({ target: UNDERCUT, limits: { min_profit_abs: 3000 } }));
  assertChange(d, 13310);
  approx(d.floor, 13310, 0.01, 'floor');
});

test('floor z MOC: max_below_msrp_pct 12 → 14 990 × 0,88 = 13 191,2', () => {
  const d = decide({}, market3(), iso({ target: UNDERCUT, limits: { max_below_msrp_pct: 12 } }));
  assertChange(d, 13191.2, 0.011);
  approx(d.floor, 13191.2, 0.01, 'floor');
});

test('floor z products.min_price (respect_product_limits) a jeho vypnutí', () => {
  assertChange(decide({ min_price: 13000 }, market3(), iso({ target: UNDERCUT })), 13000);
  assertChange(decide({ min_price: 13000 }, market3(), iso({ target: UNDERCUT, limits: { respect_product_limits: false } })), 12860.1);
});

test('floor = maximum ze všech složek', () => {
  // marže 20 % → 12 100 ; zisk 2 500 → gross(10 500) = 12 705 ; MOC −12 % → 13 191,2 ; min_price 13 000 → max = 13 191,2
  const d = decide({ min_price: 13000 }, market3(), iso({ target: UNDERCUT, limits: { min_margin_pct: 20, min_profit_abs: 2500, max_below_msrp_pct: 12 } }));
  assertChange(d, 13191.2, 0.011);
  approx(d.floor, 13191.2, 0.01, 'floor');
});

test('floor používá DPH produktu: DPH 12 %, marže 20 % → 8000 / 0,8 × 1,12 = 11 200', () => {
  // undercut −15 %: 12 990 × 0,85 = 11 041,5 < 11 200
  const d = decide({ vat_rate: 12 }, market3(), iso({ target: { mode: 'undercut_min', offset_pct: -15 }, limits: { min_margin_pct: 20 } }));
  assertChange(d, 11200, 0.011);
});

test('floor: DPH null → settings.vat_rate_default (21 %) → 12 100', () => {
  const d = decide({ vat_rate: null }, market3(), iso({ target: { mode: 'undercut_min', offset_pct: -10 }, limits: { min_margin_pct: 20 } }));
  assertChange(d, 12100);
});

test('ceiling z MOC: max_above_msrp_pct 0 → 14 990; 5 → 15 739,5', () => {
  const d0 = decide({}, market3(), iso({ target: { mode: 'fixed', fixed_price: 16000 }, limits: { max_above_msrp_pct: 0 } }));
  assertChange(d0, 14990);
  approx(d0.ceiling, 14990, 0.01, 'ceiling');
  assert.ok(hasFlag(d0, 'ceiling'), `flags: ${d0.flags}`);
  const d5 = decide({}, market3(), iso({ target: { mode: 'fixed', fixed_price: 16000 }, limits: { max_above_msrp_pct: 5 } }));
  assertChange(d5, 15739.5);
});

test('ceiling: max_above_msrp_pct null → žádný strop MOC', () => {
  const d = decide({}, market3(), iso({ target: { mode: 'fixed', fixed_price: 16000 } }));
  assertChange(d, 16000);
  assert.ok(!hasFlag(d, 'ceiling'));
});

test('ceiling: bez MOC produktu se strop MOC neuplatní', () => {
  const d = decide({ msrp: null }, market3(), iso({ target: { mode: 'fixed', fixed_price: 16000 }, limits: { max_above_msrp_pct: 0 } }));
  assertChange(d, 16000);
});

test('ceiling z max. marže 30 %: 8000 / 0,7 × 1,21 = 13 828,57', () => {
  // SPEC-AMBIGUOUS: vzorec „max-margin ceiling“ není rozepsán; analogicky k floor = gross(purchase / (1 − M/100)).
  const d = decide({}, market3(), iso({ target: { mode: 'fixed', fixed_price: 15000 }, limits: { max_margin_pct: 30 } }));
  assertChange(d, 13828.57, 0.011);
  approx(d.ceiling, 13828.57, 0.01, 'ceiling');
});

test('ceiling z products.max_price a jeho vypnutí', () => {
  assertChange(decide({ max_price: 13000 }, market3(), iso({ target: { mode: 'fixed', fixed_price: 15000 } })), 13000);
  assertChange(decide({ max_price: 13000 }, market3(), iso({ target: { mode: 'fixed', fixed_price: 15000 }, limits: { respect_product_limits: false } })), 15000);
});

test('ceiling = minimum ze všech složek', () => {
  // MOC 14 990 ; max_price 14 500 ; max. marže 40 % → 8000 / 0,6 × 1,21 = 16 133,33 → min = 14 500
  const d = decide({ max_price: 14500 }, market3(), iso({ target: { mode: 'fixed', fixed_price: 16000 }, limits: { max_above_msrp_pct: 0, max_margin_pct: 40 } }));
  assertChange(d, 14500);
  approx(d.ceiling, 14500, 0.01, 'ceiling');
});

test('bez nákupní ceny: maržové hranice se přeskočí, příznak no_cost', () => {
  // min. marže 20 % i min. zisk 1000 se bez nákupu nedají spočítat → cíl 12 860,1 projde
  const d = decide({ purchase_price: null }, market3(), iso({ target: UNDERCUT, limits: { min_margin_pct: 20, min_profit_abs: 1000 } }));
  assertChange(d, 12860.1);
  assert.ok(hasFlag(d, 'no_cost'), `flags: ${d.flags}`);
  assert.ok(d.margin_before == null && d.margin_after == null);
});

test('bez nákupní ceny: MOC floor a min_price platí dál', () => {
  const d = decide({ purchase_price: null, min_price: 13100 }, market3(), iso({ target: UNDERCUT }));
  assertChange(d, 13100);
  assert.ok(hasFlag(d, 'no_cost'));
});

test('min_margin_pct ≥ 100 → neplatná konfigurace (výjimka nebo jiná akce než change)', () => {
  let d;
  try {
    d = decide({}, market3(), iso({ target: UNDERCUT, limits: { min_margin_pct: 100 } }));
  } catch (e) {
    assert.ok(e instanceof Error);
    return;
  }
  // SPEC: „m ≥ 100 → invalid config error“ – pokud computePrice nevyhazuje, nesmí vrátit změnu ceny.
  assert.notStrictEqual(d.action, 'change', 'při neplatné min. marži se cena nesmí měnit');
});

// =====================================================================================================
// 5. Pořadí: limity změny → ceiling → floor; floor vždy vyhrává (§6.7 krok 6); zaokrouhlení 'integer'
// =====================================================================================================

test('limit poklesu 10 %: cíl 11 000 → 13 490 × 0,9 = 12 141, příznak change_limited', () => {
  const d = decide({}, market3(), { target: { mode: 'fixed', fixed_price: 11000 }, rounding: R_INT });
  assertChange(d, 12141);
  assert.ok(hasFlag(d, 'change_limited'), `flags: ${d.flags}`);
});

test('limit zvýšení 15 %: cíl 16 000 → 13 490 × 1,15 = 15 513,5 → celé Kč dolů 15 513', () => {
  const d = decide({}, market3(), { target: { mode: 'fixed', fixed_price: 16000 }, limits: { max_above_msrp_pct: null }, rounding: R_INT });
  assertChange(d, 15513);
  assert.ok(hasFlag(d, 'change_limited'), `flags: ${d.flags}`);
});

test('limity změny → potom ceiling: 11 000 → 12 141 → max_price 12 000 → 12 000', () => {
  const d = decide({ max_price: 12000 }, market3(), { target: { mode: 'fixed', fixed_price: 11000 }, rounding: R_INT });
  assertChange(d, 12000);
  assert.ok(hasFlag(d, 'change_limited'), `flags: ${d.flags}`);
  assert.ok(hasFlag(d, 'ceiling'), `flags: ${d.flags}`);
});

test('floor > ceiling → limits_conflict a vyhrává floor (12 907 i nad max_price 12 500)', () => {
  // marže 25 % → floor = 8000 / 0,75 × 1,21 = 12 906,67 ; ceiling = min(14 990, 12 500) = 12 500
  // cíl 12 000 → ceiling ok → floor → 12 906,67 → celé Kč dolů 12 906 < floor → up 12 907 ; 12 907 > ceiling, ale down < floor → 12 907
  const d = decide({ max_price: 12500 }, market3(), {
    target: { mode: 'fixed', fixed_price: 12000 },
    limits: { min_margin_pct: 25, max_decrease_pct: null },
    rounding: R_INT,
  });
  assertChange(d, 12907);
  assert.ok(hasFlag(d, 'limits_conflict'), `flags: ${d.flags}`);
  assert.ok(hasFlag(d, 'floor'), `flags: ${d.flags}`);
});

test('min_price > max_price → limits_conflict, výsledek = min_price', () => {
  // floor = max(10 755,56 ; 13 000) = 13 000 ; ceiling = min(14 990 ; 12 000) = 12 000 ; cíl 12 500 → 12 000 → 13 000
  const d = decide({ min_price: 13000, max_price: 12000 }, market3(), iso({ target: { mode: 'fixed', fixed_price: 12500 } }));
  assertChange(d, 13000);
  assert.ok(hasFlag(d, 'limits_conflict'), `flags: ${d.flags}`);
});

test('floor přes limit změny → floor_over_change_limit (floor vyhrává nad max. zvýšením)', () => {
  // nákup 11 000, marže 10 % → floor = 11000 / 0,9 × 1,21 = 14 788,89 ; max. zvýšení 5 % → 14 164,5
  // cíl 13 000 → limity ok (≥ 12 141) → ceiling 14 990 ok → floor 14 788,89 (> 14 164,5) → celé Kč: 14 788 < floor → 14 789
  const d = decide({ purchase_price: 11000 }, market3(), { target: { mode: 'fixed', fixed_price: 13000 }, limits: { max_increase_pct: 5 }, rounding: R_INT });
  assertChange(d, 14789);
  assert.ok(hasFlag(d, 'floor'), `flags: ${d.flags}`);
  assert.ok(hasFlag(d, 'floor_over_change_limit'), `flags: ${d.flags}`);
});

test('floor v mezích limitu změny → jen floor, bez floor_over_change_limit a bez change_limited', () => {
  // marže 20 % → floor 12 100 ; max. pokles 15 % → 13 490 × 0,85 = 11 466,5 ; cíl 12 990 × 0,9 = 11 691 (≥ 11 466,5) → floor 12 100
  const d = decide({}, market3(), {
    target: { mode: 'undercut_min', offset_pct: -10 },
    limits: { min_margin_pct: 20, max_decrease_pct: 15 },
    rounding: R_INT,
  });
  assertChange(d, 12100);
  assert.ok(hasFlag(d, 'floor'), `flags: ${d.flags}`);
  assert.ok(!hasFlag(d, 'floor_over_change_limit'), `flags: ${d.flags}`);
  assert.ok(!hasFlag(d, 'change_limited'), `flags: ${d.flags}`);
});

test('allow_decrease false: nižší cíl → no_change', () => {
  const d = decide({}, market3(), { target: { mode: 'fixed', fixed_price: 12000 }, limits: { ...OPEN, allow_decrease: false }, rounding: R_INT });
  assertNoChange(d);
});

test('allow_increase false: vyšší cíl → no_change', () => {
  const d = decide({}, market3(), { target: { mode: 'fixed', fixed_price: 14000 }, limits: { ...OPEN, allow_increase: false }, rounding: R_INT });
  assertNoChange(d);
});

test('allow_increase false, ale současná cena pod floor → floor vyhrává (zvýšení 16 134)', () => {
  // nákup 12 000 → floor 16 133,33 ; keep → cíl 13 490 → floor → celé Kč: 16 133 < floor → 16 134
  const d = decide({ purchase_price: 12000 }, market3(), { target: { mode: 'keep' }, limits: { ...OPEN, allow_increase: false }, rounding: R_INT });
  assertChange(d, 16134);
});

test('allow_decrease false, ale cena nad stropem → ceiling se aplikuje po limitech změny (13 000)', () => {
  // cíl 12 000 → allow_decrease false drží 13 490 → ceiling max_price 13 000 → 13 000
  const d = decide({ max_price: 13000 }, market3(), { target: { mode: 'fixed', fixed_price: 12000 }, limits: { ...OPEN, allow_decrease: false }, rounding: R_INT });
  assertChange(d, 13000);
  assert.ok(hasFlag(d, 'ceiling'), `flags: ${d.flags}`);
});

// =====================================================================================================
// 6. Zaokrouhlení a jeho interakce s floor/ceiling (§6.6, §6.7 krok 7) – výchozí pásma …9 / …90 / …990
// =====================================================================================================

test('PŘÍKLAD ZE ZADÁNÍ: min. marže 20 %, undercut −1 % → 12 860,1 → dolů 11 990 < floor 12 100 → up 12 990', () => {
  // floor = 8000 / (1 − 0,2) × 1,21 = 12 100 ; limity: pokles 10 % → 12 141 ≤ 12 860,1 ; strop MOC 14 990
  // zaokrouhlení pásmo >10 000 (…990) dolů: 11 990 < 12 100 → kandidát nahoru 12 990
  const d = decide({}, market3(), { target: { mode: 'undercut_min', offset_pct: -1 }, limits: { min_margin_pct: 20 } });
  assertChange(d, 12990);
  assert.strictEqual(d.new_price, 12990);
  approx(d.target_price, 12860.1, 0.001, 'target_price');
  approx(d.floor, 12100, 0.01, 'floor');
  approx(d.ceiling, 14990, 0.01, 'ceiling');
});

test('zaokrouhlení dolů bez kolize s floor: 12 860,1 → 11 990', () => {
  // výchozí marže 10 % (floor 10 755,56), bez limitu poklesu
  const d = decide({}, market3(), { target: UNDERCUT, limits: { max_decrease_pct: null } });
  assertChange(d, 11990);
  assert.strictEqual(d.new_price, 11990);
});

test('zaokrouhlení nearest: 12 860,1 → 12 990 (129,9 < 870,1)', () => {
  const d = decide({}, market3(), { target: UNDERCUT, rounding: { direction: 'nearest' } });
  assertChange(d, 12990);
});

test('zaokrouhlení up: fixed 13 600 → 13 990', () => {
  // zvýšení 13 490 → 13 600 → nahoru na bod …990 = 13 990 (≤ strop MOC 14 990, ≤ +15 %)
  const d = decide({}, market3(), { target: { mode: 'fixed', fixed_price: 13600 }, rounding: { direction: 'up' } });
  assertChange(d, 13990);
});

test('zaokrouhlení dolů nesmí obrátit zamýšlené zvýšení na snížení (konzervativně)', () => {
  // SPEC-AMBIGUOUS: krok 7 neřeší obrácení směru změny. Cíl 13 600 (zvýšení z 13 490) se výchozím zaokrouhlením
  // …990 dolů změní na 12 990 = SNÍŽENÍ o 500 Kč, které strategie nechtěla. Konzervativně („never lower a price“):
  // výsledek nesmí být pod současnou cenou (buď 13 990, nebo ponechání 13 490).
  const d = decide({}, market3(), { target: { mode: 'fixed', fixed_price: 13600 } });
  assert.ok(d.action !== 'change' || d.new_price >= 13490, `zaokrouhlení snížilo cenu na ${d.new_price}`);
});

test('zaokrouhlení up nesmí skončit pod cílem (fixed 13 100, směr up)', () => {
  // SPEC-AMBIGUOUS: doslovně podle kroku 7: 13 100 → nahoru 13 990 (≤ strop 14 990) → 13 990 (obrátí snížení na zvýšení).
  // Alternativa „neobracet směr změny“ by vzala 12 990 – tedy cenu NIŽŠÍ než cíl i než konfigurované zaokrouhlení nahoru.
  // Konzervativní (peněžně bezpečné) čtení: při direction 'up' nesmí výsledek klesnout pod cíl 13 100
  // (přijatelné je 13 990 dle SPEC, případně ponechání 13 490).
  const d = decide({}, market3(), { target: { mode: 'fixed', fixed_price: 13100 }, rounding: { direction: 'up' } });
  assert.ok(d.action !== 'change' || d.new_price >= 13100, `zaokrouhlení nahoru dalo ${d.new_price} < cíl 13 100`);
});

test('zaokrouhlení nad ceiling a down ≥ floor → vezme se down: up 13 990 > max_price 13 500 → 12 990', () => {
  const d = decide({ max_price: 13500 }, market3(), { target: { mode: 'fixed', fixed_price: 13400 }, rounding: { direction: 'up' } });
  assertChange(d, 12990);
});

test('zaokrouhlení: down < floor i up > ceiling → nezaokrouhlená cena uvnitř limitů (12 920)', () => {
  // marže 25 % → floor 12 906,67 ; ceiling 12 950 ; cíl 12 920 → dolů 11 990 < floor, nahoru 12 990 > ceiling.
  // Změna SPEC (rozhodnutí vedoucího, jako Disivo): limity mají přednost před zakončením → 12 920 (celé Kč).
  const d = decide({ max_price: 12950 }, market3(), { target: { mode: 'fixed', fixed_price: 12920 }, limits: { min_margin_pct: 25 } });
  assertChange(d, 12920);
  assert.ok(d.new_price >= 8000 / 0.75 * 1.21 && d.new_price <= 12950);
  assert.ok(d.flags.includes('rounding_skipped'));
});

test('malé ceny – pásmo …9: 899 Kč, trh 849/869, −1 % → 840,51 → 839', () => {
  // floor = 400 / 0,9 × 1,21 = 537,78 ; pokles max 10 % → 809,1 ; bez MOC → bez stropu
  const d = decide({ price: 899, purchase_price: 400, msrp: null }, [offer('VeloMarket.cz', 849), offer('Kolo-Shop.cz', 869)], { target: UNDERCUT });
  assertChange(d, 839);
});

test('střední ceny – pásmo …90: 5 990 Kč, trh 5 690/5 800, −1 % → 5 633,1 → 5 590', () => {
  // floor = 3000 / 0,9 × 1,21 = 4 033,33 ; pokles max 10 % → 5 391 ; strop MOC 6 490
  const d = decide({ price: 5990, purchase_price: 3000, msrp: 6490 }, [offer('VeloMarket.cz', 5690), offer('Kolo-Shop.cz', 5800)], { target: UNDERCUT });
  assertChange(d, 5590);
});

test('zaokrouhlení dolů nesmí prorazit limit poklesu (konzervativně)', () => {
  // SPEC-AMBIGUOUS: krok 7 hlídá po zaokrouhlení jen floor/ceiling. Cíl 12 990 − 10 = 12 980 → dolů 11 990,
  // což je pokles 11,1 % > max_decrease_pct 10 % (hranice 12 141). Konzervativní čtení („never lower a price below
  // guardrails“): výsledek musí zůstat ≥ 12 141 → jediný bod pásma …990 je 12 990.
  const d = decide({}, market3(), { target: { mode: 'undercut_min', offset_abs: -10 } });
  assert.strictEqual(d.action, 'change');
  assert.ok(d.new_price >= 12141, `nová cena ${d.new_price} je pod limitem poklesu 12 141`);
  assert.strictEqual(d.new_price, 12990);
});

// =====================================================================================================
// 7. Práh minimální změny (§6.7 krok 8) – threshold = max(min_change_abs, cur × min_change_pct / 100)
// =====================================================================================================

test('práh: rozdíl 40 < max(5 ; 13 490 × 0,5 % = 67,45) → no_change below_threshold', () => {
  const d = decide({}, market3(), { target: { mode: 'fixed', fixed_price: 13450 }, limits: OPEN_LIMITS, rounding: R_NONE });
  assertNoChange(d, 'below_threshold');
});

test('práh: rozdíl 90 ≥ 67,45 → změna', () => {
  const d = decide({}, market3(), { target: { mode: 'fixed', fixed_price: 13400 }, limits: OPEN_LIMITS, rounding: R_NONE });
  assertChange(d, 13400);
});

test('práh: min_change_abs 100 → rozdíl 90 no_change, rozdíl přesně 100 je změna (ne <)', () => {
  const lim = { ...OPEN_LIMITS, min_change_abs: 100, min_change_pct: 0 };
  assertNoChange(decide({}, market3(), { target: { mode: 'fixed', fixed_price: 13400 }, limits: lim, rounding: R_NONE }), 'below_threshold');
  assertChange(decide({}, market3(), { target: { mode: 'fixed', fixed_price: 13390 }, limits: lim, rounding: R_NONE }), 13390);
});

test('práh: min_change_pct 1 % → 134,9 Kč; rozdíl 130 no_change, 135 změna', () => {
  const lim = { ...OPEN_LIMITS, min_change_abs: 5, min_change_pct: 1 };
  assertNoChange(decide({}, market3(), { target: { mode: 'fixed', fixed_price: 13360 }, limits: lim, rounding: R_NONE }), 'below_threshold');
  assertChange(decide({}, market3(), { target: { mode: 'fixed', fixed_price: 13355 }, limits: lim, rounding: R_NONE }), 13355);
});

test('práh se neuplatní, když je současná cena nad stropem (13 490 > max_price 13 470 → 13 470)', () => {
  const d = decide({ max_price: 13470 }, market3(), { target: { mode: 'fixed', fixed_price: 13480 }, limits: OPEN_LIMITS, rounding: R_NONE });
  assertChange(d, 13470);
});

test('práh se neuplatní, když je současná cena pod floor (keep, min_price 13 500 → 13 500)', () => {
  const d = decide({ min_price: 13500 }, market3(), { target: { mode: 'keep' }, limits: OPEN_LIMITS, rounding: R_NONE });
  assertChange(d, 13500);
});

test('nová cena = současná → no_change (i s nulovým prahem)', () => {
  const d = decide({}, market3(), iso({ target: { mode: 'fixed', fixed_price: 13490 } }));
  assertNoChange(d);
});

// =====================================================================================================
// 8. Výstupní metriky, tvar rozhodnutí, vysvětlení (§6.7 krok 9, Decision shape)
// =====================================================================================================

test('rozhodnutí: kompletní tvar a metriky na příkladu ze zadání (13 490 → 12 990)', () => {
  const d = decide({}, [...market3(), offer('Vyprodano.cz', 9000, { in_stock: 0 })], {
    target: { mode: 'undercut_min', offset_pct: -1 },
    limits: { min_margin_pct: 20 },
  });
  assert.strictEqual(d.action, 'change');
  assert.strictEqual(d.product_id, 1);
  assert.strictEqual(d.strategy_id, 7);
  assert.ok(d.segment_id == null);
  assert.strictEqual(d.old_price, 13490);
  assert.strictEqual(d.new_price, 12990);
  assert.strictEqual(d.reference_price, 12990);
  // trh
  assert.strictEqual(d.market.count, 3);
  assert.strictEqual(d.market.min, 12990);
  assert.strictEqual(d.market.max, 14000);
  approx(d.market.avg, 13396.67, 0.006);
  assert.strictEqual(d.market.median, 13200);
  assert.strictEqual(d.market.cheapest.competitor, 'VeloMarket.cz');
  assert.strictEqual(d.market.cheapest.price, 12990);
  assert.strictEqual(d.market.used.length, 3);
  for (const u of d.market.used) for (const k of ['competitor', 'price', 'effective', 'in_stock']) assert.ok(k in u, `used.${k}`);
  const ex = d.market.excluded.find((e) => e.competitor === 'Vyprodano.cz');
  assert.ok(ex, 'vyřazená nabídka v market.excluded');
  assert.strictEqual(ex.price, 9000);
  assert.strictEqual(ex.reason, 'out_of_stock');
  // pořadí: před = 1 + |{12 990 ; 13 200} < 13 490| = 3 ; po = 1 + |{} < 12 990| = 1
  assert.strictEqual(d.rank_before, 3);
  assert.strictEqual(d.rank_after, 1);
  // marže: před (13 490/1,21 − 8000)/(13 490/1,21) = 28,24 % ; po (12 990/1,21 = 10 735,54) → 25,48 %
  approx(d.margin_before, 28.24, 0.006);
  approx(d.margin_after, 25.48, 0.006);
  // změna −500 Kč ; −500 / 13 490 × 100 = −3,7064 → −3,71
  approx(d.change_abs, -500, 0.001);
  assert.strictEqual(d.change_pct, -3.71);
  assert.ok(Array.isArray(d.flags));
  for (const f of ['big_change', 'below_cost', 'limits_conflict', 'floor_over_change_limit', 'no_cost']) assert.ok(!hasFlag(d, f), `neočekávaný příznak ${f}`);
  assert.strictEqual(d.auto_approve, false); // approval.auto výchozí false
  // vysvětlení (česky, peníze přes toLocaleString('cs-CZ') + „Kč“)
  assert.ok(Array.isArray(d.explain) && d.explain.length >= 3);
  for (const e of d.explain) assert.ok(typeof e.step === 'string' && typeof e.text === 'string' && e.text.length > 0);
  const all = d.explain.map((e) => e.text).join('\n');
  assert.ok(all.includes((12990).toLocaleString('cs-CZ')), `vysvětlení má obsahovat „${(12990).toLocaleString('cs-CZ')}“`);
  assert.ok(all.includes('Kč'));
});

test('rozhodnutí typu skip i no_change mají vysvětlení', () => {
  const s = decide({ locked: 1 }, market3(), iso({ target: UNDERCUT }));
  assert.ok(Array.isArray(s.explain) && s.explain.length >= 1);
  const n = decide({ sales_30: 5 }, [], iso({ target: CLEAR }));
  assert.ok(Array.isArray(n.explain) && n.explain.length >= 1);
});

test('příznak below_cost: čistá nová cena < nákup (9 000 / 1,21 = 7 438 < 8 000)', () => {
  // SPEC-AMBIGUOUS: min_margin_pct null chápeme jako „bez maržové spodní hranice“ (analogicky k min_profit_abs null).
  const d = decide({}, market3(), iso({ target: { mode: 'fixed', fixed_price: 9000 }, limits: { min_margin_pct: null }, approval: { auto: true, auto_max_change_pct: 50 } }));
  assertChange(d, 9000);
  assert.ok(hasFlag(d, 'below_cost'), `flags: ${d.flags}`);
  assert.strictEqual(d.auto_approve, false);
});

test('příznak big_change: |change_pct| > auto_max_change_pct', () => {
  // 12 500 vs 13 490 → −7,34 % > 5
  const d = decide({}, market3(), iso({ target: { mode: 'fixed', fixed_price: 12500 }, approval: { auto: true } }));
  assert.strictEqual(d.change_pct, -7.34);
  assert.ok(hasFlag(d, 'big_change'));
  assert.strictEqual(d.auto_approve, false);
  // s auto_max 10 % už není big_change → auto_approve
  const d10 = decide({}, market3(), iso({ target: { mode: 'fixed', fixed_price: 12500 }, approval: { auto: true, auto_max_change_pct: 10 } }));
  assert.ok(!hasFlag(d10, 'big_change'));
  assert.strictEqual(d10.auto_approve, true);
});

test('big_change: změna přesně −5,00 % není > 5 → auto_approve', () => {
  // 12 815,5 vs 13 490 → −674,5 / 13 490 = −5 %
  const d = decide({}, market3(), iso({ target: { mode: 'fixed', fixed_price: 12815.5 }, approval: { auto: true, auto_max_change_pct: 5 } }));
  assert.strictEqual(d.change_pct, -5);
  assert.ok(!hasFlag(d, 'big_change'), `flags: ${d.flags}`);
  assert.strictEqual(d.auto_approve, true);
});

test('computePrice přijímá now jako Date i jako ISO řetězec', () => {
  const a = decide({ price_changed_at: daysAgo(20), sales_30: 0 }, market3(), iso({ target: CLEAR }), { now: NOW });
  const b = decide({ price_changed_at: daysAgo(20), sales_30: 0 }, market3(), iso({ target: CLEAR }), { now: new Date(NOW) });
  assert.strictEqual(a.action, b.action);
  assert.strictEqual(a.new_price, b.new_price);
});

// =====================================================================================================
// 9. Automatické schválení (§6.7 krok 10)
// =====================================================================================================

test('auto_approve: approval.auto true a malá změna (−3,71 %) → true', () => {
  const d = decide({}, market3(), { target: UNDERCUT, limits: { min_margin_pct: 20 }, approval: { auto: true } });
  assertChange(d, 12990);
  assert.strictEqual(d.auto_approve, true);
});

test('auto_approve: approval.auto false → vždy false', () => {
  const d = decide({}, market3(), { target: UNDERCUT, limits: { min_margin_pct: 20 }, approval: { auto: false } });
  assert.strictEqual(d.auto_approve, false);
});

test('auto_approve: limits_conflict blokuje', () => {
  const d = decide({ max_price: 12500 }, market3(), {
    target: { mode: 'fixed', fixed_price: 12000 },
    limits: { min_margin_pct: 25, max_decrease_pct: null },
    rounding: R_INT,
    approval: { auto: true, auto_max_change_pct: 50 },
  });
  assert.ok(hasFlag(d, 'limits_conflict'));
  assert.strictEqual(d.auto_approve, false);
});

test('auto_approve: floor_over_change_limit blokuje', () => {
  const d = decide({ purchase_price: 11000 }, market3(), {
    target: { mode: 'fixed', fixed_price: 13000 },
    limits: { max_increase_pct: 5 },
    rounding: R_INT,
    approval: { auto: true, auto_max_change_pct: 50 },
  });
  assert.ok(hasFlag(d, 'floor_over_change_limit'));
  assert.strictEqual(d.auto_approve, false);
});

test('auto_approve: bez nákupní ceny a snížení ceny → nikdy automaticky', () => {
  // 12 860,1 vs 13 490 = −4,67 % (pod auto_max 5 %) ; jediná překážka je no_cost + pokles
  const d = decide({ purchase_price: null }, market3(), iso({ target: UNDERCUT, approval: { auto: true, auto_max_change_pct: 5 } }));
  assertChange(d, 12860.1);
  assert.ok(hasFlag(d, 'no_cost'));
  assert.ok(!hasFlag(d, 'big_change'));
  assert.strictEqual(d.auto_approve, false);
});

test('auto_approve: bez nákupní ceny a zvýšení ceny → smí automaticky', () => {
  // 13 800 vs 13 490 = +2,30 %
  const d = decide({ purchase_price: null }, market3(), iso({ target: { mode: 'fixed', fixed_price: 13800 }, approval: { auto: true, auto_max_change_pct: 5 } }));
  assertChange(d, 13800);
  assert.ok(hasFlag(d, 'no_cost'));
  assert.strictEqual(d.auto_approve, true);
});

test('auto_approve: floor / ceiling / change_limited / fallback samy neblokují', () => {
  // floor 12 100 v mezích limitů (viz test výše), změna 13 490 → 12 100 = −10,30 % ; auto_max 50
  const d = decide({}, market3(), {
    target: { mode: 'undercut_min', offset_pct: -10 },
    limits: { min_margin_pct: 20, max_decrease_pct: 15 },
    rounding: R_INT,
    approval: { auto: true, auto_max_change_pct: 50 },
  });
  assert.ok(hasFlag(d, 'floor'));
  assert.strictEqual(d.auto_approve, true);
  const f = decide({}, [], iso({ target: UNDERCUT, fallback: { mode: 'msrp', offset_pct: -5 }, approval: { auto: true, auto_max_change_pct: 50 } }));
  assert.ok(hasFlag(f, 'fallback'));
  assert.strictEqual(f.auto_approve, true);
});

// =====================================================================================================
// 10. Filtrování trhu uvnitř computePrice (§6.2 přes config.competitors)
// =====================================================================================================

test('trh: vypnutý konkurent se ignoruje (9 000 od vypnutého → min 12 990)', () => {
  const d = decide({}, [...market3(), offer('Bazar.cz', 9000, { enabled: false })], iso({ target: UNDERCUT }));
  assertChange(d, 12860.1);
  assert.strictEqual(d.market.count, 3);
});

test('trh: exclude_keywords („bazar“, „použit“) vyřadí nabídky podle názvu', () => {
  const offers = [
    ...market3(),
    offer('Levne-kolo.cz', 9000, { name: 'Scott Aspect 950 – BAZAR' }),
    offer('Ojete.cz', 9500, { name: 'Použité kolo Scott Aspect 950' }),
  ];
  const d = decide({}, offers, iso({ target: UNDERCUT, competitors: { exclude_keywords: ['bazar', 'použit'] } }));
  assertChange(d, 12860.1);
  assert.strictEqual(d.market.count, 3);
});

test('trh: stará nabídka (10 dní > offer_max_age_days 7) se ignoruje', () => {
  const d = decide({}, [...market3(), offer('Stary.cz', 9000, { observed_at: daysAgo(10) })], iso({ target: UNDERCUT }));
  assertChange(d, 12860.1);
});

test('trh: competitors.max_age_days přebíjí nastavení', () => {
  // nabídka 12 990 stará 5 dní; max_age_days 3 → vyřazena → min 13 200 → −1 % = 13 068
  const offers = [offer('VeloMarket.cz', 12990, { observed_at: daysAgo(5) }), offer('Kolo-Shop.cz', 13200), offer('BikeStore.cz', 14000)];
  const d = decide({}, offers, iso({ target: UNDERCUT, competitors: { max_age_days: 3 } }));
  assertChange(d, 13068);
});

test('trh: settings.offer_max_age_days se použije, když max_age_days je null', () => {
  // nastavení 3 dny → nabídka 5 dní stará se vyřadí
  const offers = [offer('VeloMarket.cz', 12990, { observed_at: daysAgo(5) }), offer('Kolo-Shop.cz', 13200)];
  const d = decide({}, offers, iso({ target: UNDERCUT }), { settings: { ...DEFAULT_SETTINGS, offer_max_age_days: 3 } });
  assertChange(d, 13068);
});

test('trh: mimo sklad (in_stock 0) se ignoruje, neznámá dostupnost (null) se počítá', () => {
  // min použitých = 12 000 (null = skladem) → −1 % = 11 880
  const offers = [...market3(), offer('Vyprodano.cz', 9000, { in_stock: 0 }), offer('Nevime.cz', 12000, { in_stock: null })];
  const d = decide({}, offers, iso({ target: UNDERCUT }));
  assertChange(d, 11880);
});

test('trh: in_stock_only false → i nabídka mimo sklad je reference', () => {
  // min = 12 500 (mimo sklad) → −1 % = 12 375
  const d = decide({}, [...market3(), offer('Vyprodano.cz', 12500, { in_stock: 0 })], iso({ target: UNDERCUT, competitors: { in_stock_only: false } }));
  assertChange(d, 12375);
});

test('trh: include_shipping → reference = cena + doprava', () => {
  // A 12 990 + 200 = 13 190 ; B 13 200 ; C 14 000 → min 13 190 → −1 % = 13 058,1
  const offers = [offer('VeloMarket.cz', 12990, { shipping: 200 }), offer('Kolo-Shop.cz', 13200), offer('BikeStore.cz', 14000)];
  const d = decide({}, offers, iso({ target: UNDERCUT, competitors: { include_shipping: true } }));
  assertChange(d, 13058.1);
  assert.strictEqual(d.reference_price, 13190);
});

test('trh: outlier_pct 30 vyřadí podezřele levnou nabídku (5 000 < 13 095 × 0,7)', () => {
  const offers = [offer('Levny.cz', 5000), ...market3()];
  const d = decide({}, offers, iso({ target: UNDERCUT, competitors: { outlier_pct: 30 } }));
  assertChange(d, 12860.1);
  const ex = d.market.excluded.find((e) => e.competitor === 'Levny.cz');
  assert.ok(ex && ex.reason === 'outlier');
});

test('trh: bez outlier_pct táhne levná nabídka cenu až na floor (10 755,56)', () => {
  // min 5 000 → −1 % = 4 950 < floor 10 755,56 → floor ; zaokrouhlení 'none' → 10 755,56
  const d = decide({}, [offer('Levny.cz', 5000), ...market3()], iso({ target: UNDERCUT }));
  assertChange(d, 10755.56, 0.011);
  assert.ok(d.new_price >= FLOOR10 - 1e-9);
  assert.ok(hasFlag(d, 'floor'));
});

test('trh: include / exclude / tagy konkurentů', () => {
  // jen BikeStore → 14 000 × 0,99 = 13 860
  assertChange(decide({}, market3(), iso({ target: UNDERCUT, competitors: { include: ['bikestore.cz'] } })), 13860);
  // bez VeloMarketu → min 13 200 → 13 068
  assertChange(decide({}, market3(), iso({ target: UNDERCUT, competitors: { exclude: ['VELOMARKET.CZ'] } })), 13068);
  const tagged = [offer('VeloMarket.cz', 12990, { tags: ['marketplace'] }), offer('Kolo-Shop.cz', 13200, { tags: ['klíčový'] }), offer('BikeStore.cz', 14000)];
  assertChange(decide({}, tagged, iso({ target: UNDERCUT, competitors: { exclude_tags: ['marketplace'] } })), 13068);
  assertChange(decide({}, tagged.map((o) => ({ ...o })), iso({ target: UNDERCUT, competitors: { include_tags: ['klíčový'] } })), 13068);
});

// =====================================================================================================
// 11. Okrajové případy (konzervativní chování)
// =====================================================================================================

test('produkt bez současné ceny: dostane cenu, limity změny ani práh se neuplatní', () => {
  // cena null, pevná cena 11 990 (bod …990), výchozí limity → 11 990 ; old_price null
  const d = decide({ price: null }, market3(), { target: { mode: 'fixed', fixed_price: 11990 } });
  assertChange(d, 11990);
  assert.ok(d.old_price == null);
  // undercut −1 % bez současné ceny → 12 860,1 → dolů 11 990 (floor 10 755,56)
  const u = decide({ price: null }, market3(), { target: UNDERCUT });
  assertChange(u, 11990);
});

test('zaokrouhlení vrátí přesně současnou cenu → no_change', () => {
  // současná 12 990, cíl 13 100 → dolů na …990 = 12 990 = současná cena
  const d = decide({ price: 12990 }, market3(), { target: { mode: 'fixed', fixed_price: 13100 } });
  assertNoChange(d);
});

test('MOC floor bez MOC produktu se přeskočí', () => {
  const d = decide({ msrp: null }, market3(), iso({ target: UNDERCUT, limits: { max_below_msrp_pct: 12 } }));
  assertChange(d, 12860.1);
});

test('nikdy nenavrhnout cenu ≤ 0 (záporný cíl bez jakékoli spodní hranice)', () => {
  // SPEC-AMBIGUOUS: bez nákupu, MOC, min_price a limitů změny není žádný floor; cíl 12 990 − 20 000 = −7 010.
  // Konzervativně nesmí vzniknout návrh s nekladnou cenou (ať už skip/no_change, nebo kladná cena).
  for (const rounding of [R_NONE, R_INT, {}]) {
    const d = decide({ purchase_price: null, msrp: null }, market3(), { target: { mode: 'undercut_min', offset_abs: -20000 }, limits: OPEN, rounding });
    assert.ok(d.action !== 'change' || d.new_price > 0, `navržena cena ${d.new_price} (${JSON.stringify(rounding)})`);
  }
});

test('fixed bez fixed_price → žádná změna ceny', () => {
  // SPEC-AMBIGUOUS: chybějící fixed_price není mezi „base unavailable“; konzervativně se cena nesmí změnit (ani na 0).
  const d = decide({}, market3(), iso({ target: { mode: 'fixed', fixed_price: null } }));
  assert.notStrictEqual(d.action, 'change', `fixed_price null vedlo ke změně na ${d.new_price}`);
});

test('auto_approve je false u rozhodnutí bez změny', () => {
  const d = decide({}, market3(), iso({ target: { mode: 'keep' }, approval: { auto: true } }));
  assertNoChange(d);
  assert.ok(!d.auto_approve);
});

test('zero_stock msrp: MOC cíl prochází limity – max. zvýšení 5 % → 14 164,5 → dolů 13 990', () => {
  const d = decide({ stock: 0 }, market3(), { target: UNDERCUT, stock: { zero_stock: 'msrp' }, limits: { max_increase_pct: 5 } });
  assertChange(d, 13990);
  assert.ok(hasFlag(d, 'change_limited'), `flags: ${d.flags}`);
});

test('clearance: limit poklesu omezí krok slevy (15 % → max 10 % = 12 141)', () => {
  const d = decide({ sales_30: 0, price_changed_at: daysAgo(30) }, [], { target: { ...CLEAR, step_pct: 15 }, rounding: R_INT });
  assertChange(d, 12141);
  assert.ok(hasFlag(d, 'change_limited'));
});

test('floor přesně na cenovém bodu – plovoucí čárka nesmí posunout cenu o celý krok', () => {
  // DPH 12 %, nákup 3 135, min. marže 12 % → floor = 3135 / 0,88 × 1,12 = 3 990 PŘESNĚ
  // (v IEEE 754 vyjde 3990.0000000000005). Cíl 3 800 × 0,99 = 3 762 → floor 3 990 → bod …90 = 3 990 (marže přesně 12 %).
  // Chybné porovnání „3990 < 3990.0000000000005“ by vzalo up kandidáta 4 090 (o 100 Kč výš).
  const p = { price: 4490, purchase_price: 3135, vat_rate: 12, msrp: null };
  const offers = [offer('VeloMarket.cz', 3800), offer('Kolo-Shop.cz', 3900)];
  const d = decide(p, offers, { target: UNDERCUT, limits: { min_margin_pct: 12, max_decrease_pct: null } });
  assertChange(d, 3990);
  assert.strictEqual(d.new_price, 3990);
  const di = decide(p, offers, { target: UNDERCUT, limits: { min_margin_pct: 12, max_decrease_pct: null }, rounding: R_INT });
  assert.strictEqual(di.new_price, 3990);
});
