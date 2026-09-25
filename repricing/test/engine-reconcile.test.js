'use strict';
// Regresní testy z revize peněžních chyb enginu (reconcile implementace × black-box testů SPEC).
// Každý test popisuje chybu, kterou chytá; hodnoty jsou dopočítané v komentářích.
// Výchozí produkt (engine-spec-helpers): cena 13 490, nákup 8 000 bez DPH, DPH 21 %, MOC 14 990 → floor 10 755,56.

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, market3, offer, product, NOW, DEFAULT_SETTINGS, hasFlag, engine } = require('./engine-spec-helpers.js');

const AUTO20 = { auto: true, auto_max_change_pct: 20 };

// ---------------------------------------------------------------------------------------------
// 1. Zaokrouhlení u hranice pásem nesmí skončit nad stropem, když v mezích existuje cenový bod.
//    Chyba: hodnota 1 030 (strop) je v pásmu …90 → body 990 / 1 090. 990 < podlaha 995 → doslovný krok 7
//    vzal 1 090 = NAD stropem MOC 1 030, přestože bod 999 (pásmo …9, do 1 000 Kč) leží v [995; 1 030].

test('regrese: hranice pásem – strop 1 030, podlaha 995 → 999 (ne 1 090 nad stropem)', () => {
  // podlaha = max(min. marže 500/0,9×1,21 = 672,23 ; min_price 995) = 995 ; strop = MOC 1 030 (+0 %)
  // cíl 1 100 → strop 1 030 → pásmo …90: 990 (pod podlahou) / 1 090 (nad stropem) → bod 999 z pásma …9
  const p = { price: 1200, purchase_price: 500, msrp: 1030, min_price: 995 };
  const c = { target: { mode: 'fixed', fixed_price: 1100 }, limits: { max_decrease_pct: null } };
  const d = decide(p, [], c);
  assert.equal(d.action, 'change');
  assert.equal(d.floor, 995);
  assert.equal(d.ceiling, 1030);
  assert.equal(d.new_price, 999);
  assert.ok(!hasFlag(d, 'limits_conflict'), `flags: ${d.flags}`);
  // totéž pro produkt bez aktuální ceny
  const d2 = decide({ ...p, price: null }, [], c);
  assert.equal(d2.new_price, 999);
});

// ---------------------------------------------------------------------------------------------
// 2. Horní hranice vynutí snížení nad limit změny → příznak ceiling_over_change_limit, nikdy auto-schválení.
//    Chyba: SPEC řadí strop až po limitu změny (správně), ale takové snížení nic neoznačilo – s auto_max 20 %
//    se automaticky schválilo −11,1 %, i když strategie dovoluje pokles jen o 3 %.

test('regrese: strop pod limitem poklesu → ceiling_over_change_limit a žádné auto-schválení', () => {
  // MOC 12 000 = strop ; limit poklesu 3 % → 13 085,3 ; cíl 12 990 → 13 085,3 → strop 12 000 → dolů 11 990
  // změna (11 990 − 13 490) / 13 490 = −11,12 % < auto_max 20 % → dřív auto_approve = true
  const d = decide({ msrp: 12000 }, market3(), { limits: { max_decrease_pct: 3 }, approval: AUTO20 });
  assert.equal(d.action, 'change');
  assert.equal(d.new_price, 11990);
  assert.equal(d.change_pct, -11.12);
  assert.ok(hasFlag(d, 'ceiling'));
  assert.ok(hasFlag(d, 'ceiling_over_change_limit'), `flags: ${d.flags}`);
  assert.ok(!hasFlag(d, 'big_change'));
  assert.equal(d.auto_approve, false);
});

test('regrese: strop sníží cenu, i když strategie snižování zakazuje → ceiling_over_change_limit', () => {
  const d = decide({ msrp: 12000 }, market3(), { limits: { allow_decrease: false }, approval: AUTO20 });
  assert.equal(d.new_price, 11990); // SPEC: strop se uplatní po omezení změny
  assert.ok(hasFlag(d, 'ceiling_over_change_limit'), `flags: ${d.flags}`);
  assert.equal(d.auto_approve, false);
  assert.ok(d.explain.some((e) => /snižování nepovoluje/.test(e.text)));
});

test('regrese (kontrola): snížení stropem v rámci limitu příznak nemá a auto-schválení zůstává', () => {
  // limit poklesu 15 % → 11 466,5 ≤ 11 990 → v limitu
  const d = decide({ msrp: 12000 }, market3(), { limits: { max_decrease_pct: 15 }, approval: AUTO20 });
  assert.equal(d.new_price, 11990);
  assert.ok(!hasFlag(d, 'ceiling_over_change_limit'), `flags: ${d.flags}`);
  assert.equal(d.auto_approve, true);
});

// ---------------------------------------------------------------------------------------------
// 3. Mezi podlahou a stropem není žádný cenový bod. Původně (doslovný SPEC krok 7) vyhrála podlaha zaokrouhlená
//    nahoru → cena NAD stropem. Rozhodnutí vedoucího (jako Disivo): limity mají přednost před zakončením →
//    nezaokrouhlená cena v celých korunách uvnitř [podlaha, strop], příznak rounding_skipped (neblokuje).

test('regrese: žádný bod mezi podlahou a stropem → nezaokrouhlená cena uvnitř limitů', () => {
  // podlaha = min_price 13 300 ; strop = max_price 13 400 ; body …990: 12 990 (pod podlahou), 13 990 (nad stropem)
  const d = decide({ min_price: 13300, max_price: 13400 }, market3(), { target: { mode: 'fixed', fixed_price: 13300 }, approval: AUTO20 });
  assert.equal(d.action, 'change');
  assert.equal(d.new_price, 13300);
  assert.ok(d.new_price >= d.floor && d.new_price <= d.ceiling);
  assert.ok(hasFlag(d, 'rounding_skipped'), `flags: ${d.flags}`);
  assert.ok(!hasFlag(d, 'limits_conflict'), `flags: ${d.flags}`);
});

test('regrese: skutečný konflikt (podlaha nad stropem) → podlaha vyhrává, limits_conflict, bez auto-schválení', () => {
  const d = decide({ min_price: 13500, max_price: 13400 }, market3(), { target: { mode: 'fixed', fixed_price: 13300 }, approval: AUTO20 });
  assert.equal(d.action, 'change');
  assert.ok(d.new_price >= 13500);
  assert.ok(hasFlag(d, 'limits_conflict'), `flags: ${d.flags}`);
  assert.equal(d.auto_approve, false);
});

// ---------------------------------------------------------------------------------------------
// 4. Důvod „žádný vhodný cenový bod“ místo zavádějícího „below_threshold“.
//    Cíl 12 000 z 12 500, limit poklesu 1 % → 12 375; body …990: 11 990 (pod limitem), 12 990 (zdražení).

test('regrese: zaokrouhlení nenajde bod v limitu ani ve směru změny → no_change „no_price_point“', () => {
  const d = decide({ price: 12500 }, [offer('VeloMarket.cz', 12000)], { target: { mode: 'match_min' }, limits: { max_decrease_pct: 1 } });
  assert.equal(d.action, 'no_change');
  assert.equal(d.reason, 'no_price_point');
  assert.equal(d.new_price, 12500);
  assert.equal(engine('pricing').REASON_LABELS.no_price_point.length > 0, true);
});

// ---------------------------------------------------------------------------------------------
// 5. Neplatná sazba DPH. Chyba: záporné DPH snížilo maržovou podlahu (8000/0,9 × 0,79 = 7 022) a zároveň
//    oklamalo kontrolu below_cost (net = cena / 0,79 > cena) → hrozilo automatické snížení pod nákupní cenu.

test('regrese: záporná / ≥ 100 % sazba DPH → skip invalid_vat', () => {
  for (const vat of [-21, -0.01, 100, 2100]) {
    const d = decide({ vat_rate: vat }, market3(), { approval: AUTO20 });
    assert.equal(d.action, 'skip', `DPH ${vat}`);
    assert.equal(d.reason, 'invalid_vat');
    assert.equal(d.auto_approve, false);
    assert.equal(d.margin_before, null);
  }
  // výchozí sazba z nastavení se kontroluje stejně
  const d = decide({ vat_rate: null }, market3(), {}, { settings: { ...DEFAULT_SETTINGS, vat_rate_default: -5 } });
  assert.equal(d.reason, 'invalid_vat');
  // 0 % je platná sazba (neplátce DPH): floor = 8 000 / 0,9 = 8 888,89
  const z = decide({ vat_rate: 0 }, market3(), {});
  assert.equal(z.action, 'change');
  assert.equal(z.floor, 8888.89);
});

// ---------------------------------------------------------------------------------------------
// 6. Čísla v textové podobě. Chyba: nákupní cena „8000“ se brala jako chybějící → maržová podlaha tiše
//    vypadla; aktuální cena „13490“ jako chybějící → neplatily limity změny. vat_rate true → DPH 1 %.

test('regrese: číselné řetězce v řádku produktu = stejné rozhodnutí jako čísla', () => {
  const a = decide({}, market3(), {});
  const b = decide({ price: '13490', purchase_price: '8000', msrp: '14990', stock: '5' }, market3(), {});
  for (const k of ['action', 'old_price', 'new_price', 'floor', 'ceiling', 'margin_before', 'margin_after', 'change_pct']) {
    assert.deepEqual(b[k], a[k], k);
  }
  assert.ok(!hasFlag(b, 'no_cost'));
  // boolean není sazba DPH → výchozí 21 % (floor 10 755,56), ne 1 %
  assert.equal(decide({ vat_rate: true }, market3(), {}).floor, 10755.56);
  // prázdný řetězec = chybějící údaj
  assert.ok(hasFlag(decide({ purchase_price: ' ' }, market3(), {}), 'no_cost'));
});

test('regrese: productView počítá marži i z číselných řetězců (stejně jako cenotvorba)', () => {
  const { productView } = engine('metrics');
  const v = productView(product({ price: '13490', purchase_price: '8000', stock: ' ' }), market3(), { now: NOW, settings: DEFAULT_SETTINGS });
  // (13 490 / 1,21 − 8 000) / (13 490 / 1,21) × 100 = 28,24 %
  assert.equal(v.margin_pct, 28.24);
  assert.equal(v.stock_value, null, 'prázdný sklad není 0 ks');
});

// ---------------------------------------------------------------------------------------------
// 7. Doprava. Chyba: záporná doprava (chyba feedu) snižovala efektivní cenu konkurenta a tím náš cíl;
//    doprava jako text „99“ se tiše ignorovala (efektivní cena nižší, než ve skutečnosti je).

test('regrese: záporná doprava se nepřičítá, číselný řetězec ano', () => {
  const { buildMarket } = engine('market');
  const m = buildMarket(
    [offer('VeloMarket.cz', 12990, { shipping: -500 }), offer('Kolo-Shop.cz', 13200, { shipping: '99' }), offer('BikeStore.cz', 14000, { shipping: true })],
    { include_shipping: true },
    { now: NOW, maxAgeDays: 7 }
  );
  assert.deepEqual(m.prices, [12990, 13299, 14000]);
  const d = decide({}, [offer('VeloMarket.cz', 12990, { shipping: -500 })], { competitors: { include_shipping: true } });
  assert.equal(d.reference_price, 12990);
});

// ---------------------------------------------------------------------------------------------
// 8. Vlastnosti (property test) nad pevně nasazenými náhodnými vstupy – peněžní invarianty SPEC §6.7:
//    nikdy pod podlahou; nad stropem jen bez cenového bodu v mezích; při aktuální ceně v mezích žádné
//    porušení limitu změny ani obrácení směru; auto-schválení nikdy s blokujícím příznakem, nad stropem,
//    za limitem změny, bez aktuální ceny ani při snížení bez nákupní ceny.

test('regrese: peněžní invarianty computePrice na 20 000 náhodných vstupech', () => {
  const { computePrice } = engine('pricing');
  const { stepFor } = engine('rounding');
  const { normalizeConfig } = engine('presets');
  let seed = 20260925;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const maybe = (pr, v) => (rnd() < pr ? v : null);
  const r2 = (x) => Math.round(x * 100) / 100;
  const pointExists = (R, lo, hi) => {
    if (R.mode === 'none') return Math.ceil(lo * 100 - 1e-7) <= Math.floor(hi * 100 + 1e-7);
    if (R.mode === 'integer') return Math.max(1, Math.ceil(lo - 1e-9)) <= Math.floor(hi + 1e-9);
    let prev = 0;
    for (const b of R.bands) {
      const st = stepFor(b);
      const top = b.up_to == null ? Infinity : b.up_to;
      const a = Math.max(lo, prev);
      const z = Math.min(hi, top);
      if (a <= z) {
        const x = Math.ceil((a - b.ending) / st - 1e-9) * st + b.ending;
        if (x <= z + 1e-9 && x > 0) return true;
      }
      prev = top;
    }
    return false;
  };
  const BLOCK = ['limits_conflict', 'floor_over_change_limit', 'ceiling_over_change_limit', 'below_cost', 'big_change'];
  let changes = 0;
  for (let i = 0; i < 20000; i++) {
    const base = pick([89, 499, 999, 1000, 1001, 1500, 5990, 9999, 10000, 10001, 13490, 25990, 99990]);
    const cur = maybe(0.95, r2(base * (0.7 + rnd() * 0.6)));
    const vat = pick([21, 12, 0, null]);
    const purchase = maybe(0.85, r2(base * (0.3 + rnd() * 0.6)));
    const prod = {
      id: 1,
      price: cur,
      purchase_price: purchase,
      vat_rate: vat,
      msrp: maybe(0.8, r2(base * (0.9 + rnd() * 0.4))),
      stock: pick([5, 0, null]),
      sales_30: pick([0, 3, null]),
      min_price: maybe(0.15, r2(base * (0.6 + rnd() * 0.5))),
      max_price: maybe(0.15, r2(base * (0.8 + rnd() * 0.6))),
      price_changed_at: maybe(0.5, '2026-08-01T00:00:00Z'),
      locked: 0,
    };
    const offers = [];
    const nOff = Math.floor(rnd() * 5);
    for (let k = 0; k < nOff; k++) {
      offers.push({ competitor: 'C' + k, label: null, tags: [], enabled: true, price: r2(base * (0.6 + rnd() * 0.7)), shipping: pick([null, 0, 99]), in_stock: pick([1, 0, null]), observed_at: NOW });
    }
    const { config, errors } = normalizeConfig({
      target: {
        mode: pick(['undercut_min', 'match_min', 'rank', 'market_avg', 'market_median', 'msrp', 'cost_plus', 'keep', 'fixed', 'clearance', 'competitor']),
        offset_pct: pick([0, -1, -3, 2]),
        offset_abs: pick([0, -10, 10, -500]),
        rank: pick([1, 2, 3, 5]),
        competitor: 'C1',
        markup_pct: pick([10, 30, 50]),
        fixed_price: r2(base * (0.6 + rnd() * 0.8)),
        step_pct: pick([5, 15, 30]),
      },
      fallback: { mode: pick(['next', 'keep', 'msrp', 'cost_plus']), markup_pct: 20, offset_pct: pick([0, -5]) },
      limits: {
        min_margin_pct: pick([10, 0, 25, null, 60]),
        min_profit_abs: pick([null, 500]),
        max_margin_pct: pick([null, 30, 70]),
        max_above_msrp_pct: pick([0, 5, null, -3]),
        max_below_msrp_pct: pick([null, 12, 40]),
        max_decrease_pct: pick([10, 3, 1, null, 50]),
        max_increase_pct: pick([15, 2, null]),
        allow_increase: rnd() < 0.85,
        allow_decrease: rnd() < 0.85,
        min_change_pct: pick([0.5, 0, 2]),
        min_change_abs: pick([5, 0, 100]),
        respect_product_limits: rnd() < 0.8,
      },
      rounding: pick([
        { mode: 'ending', direction: pick(['down', 'up', 'nearest']) },
        { mode: 'none' },
        { mode: 'integer', direction: pick(['down', 'up', 'nearest']) },
        { mode: 'ending', direction: 'down', bands: [{ up_to: null, ending: 9 }] },
      ]),
      competitors: { in_stock_only: rnd() < 0.7, include_shipping: rnd() < 0.3, min_competitors: pick([1, 2]) },
      stock: { zero_stock: pick(['reprice', 'skip', 'msrp']) },
      approval: { auto: rnd() < 0.7, auto_max_change_pct: pick([5, 20, null]) },
    });
    if (errors.length) continue; // např. max_margin < min_margin – taková strategie se nepoužije vůbec
    const d = computePrice(prod, offers, { id: 1, name: 'S', config }, { now: NOW });
    const ctx = () => JSON.stringify({ i, prod, offers, config, d: { action: d.action, new: d.new_price, floor: d.floor, ceiling: d.ceiling, flags: d.flags } });
    // zprávu (JSON kontextu) skládat jen při selhání – jinak by test zbytečně zpomalila
    const check = (cond, what) => {
      if (!cond) assert.fail(`${what}: ${ctx()}`);
    };
    if (d.action !== 'change') {
      check(d.auto_approve === false, 'auto-schválení bez změny');
      continue;
    }
    changes += 1;
    const np = d.new_price;
    const L = config.limits;
    check(Number.isFinite(np) && np > 0, 'neplatná cena');
    if (d.floor != null) check(np >= d.floor - 1e-6, 'pod podlahou');
    if (d.ceiling != null && np > d.ceiling + 1e-6) {
      check(d.floor != null && (d.floor > d.ceiling || !pointExists(config.rounding, d.floor, d.ceiling)), 'nad stropem, i když bod v mezích existuje');
      check(hasFlag(d, 'limits_conflict'), 'nad stropem bez limits_conflict');
    }
    if (cur != null) {
      let lo = L.max_decrease_pct != null ? cur * (1 - L.max_decrease_pct / 100) : -Infinity;
      let hi = L.max_increase_pct != null ? cur * (1 + L.max_increase_pct / 100) : Infinity;
      if (!L.allow_decrease) lo = Math.max(lo, cur);
      if (!L.allow_increase) hi = Math.min(hi, cur);
      const within = (d.floor == null || cur >= d.floor - 1e-9) && (d.ceiling == null || cur <= d.ceiling + 1e-9);
      const conflict = d.floor != null && d.ceiling != null && d.floor > d.ceiling;
      const beyond = np < lo - 1e-6 || np > hi + 1e-6;
      if (within && !conflict) {
        check(!beyond, 'limit změny porušen, ač aktuální cena je v mezích');
        const dirT = Math.sign(d.target_price - cur);
        if (dirT !== 0) check(Math.sign(np - cur) === dirT, 'obrácený směr změny');
      }
      if (beyond) check(d.auto_approve === false, 'auto-schválení za limitem změny');
      if (hasFlag(d, 'no_cost') && np < cur) check(d.auto_approve === false, 'auto-snížení bez nákupní ceny');
    } else {
      check(d.auto_approve === false, 'auto-schválení bez aktuální ceny');
    }
    if (d.auto_approve) {
      check(!d.flags.some((f) => BLOCK.includes(f)), 'auto-schválení s blokujícím příznakem');
      if (d.ceiling != null) check(np <= d.ceiling + 1e-6, 'auto-schválení nad stropem');
    }
  }
  assert.ok(changes > 5000, `málo změn (${changes}) – test by nic neověřil`);
});

