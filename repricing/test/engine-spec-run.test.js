'use strict';
// Nezávislé black-box testy src/engine/run.js podle SPEC §3.5, §3.6 a §6.8.
// loadContext, evaluateProduct, runPricing, simulate, explainProduct, latestProposal

const test = require('node:test');
const assert = require('node:assert');
const H = require('./engine-spec-helpers.js');
const { NOW, daysAgo, daysAhead, engine, cfg, offer, market3, approx, openDb, ins, insProduct, insCompetitor, insOffer, insSegment, insStrategy, count } = H;

const RUN = () => engine('run');

// Strategie „S1“: podstřelit nejlevnějšího o 1 %, min. marže 20 %, auto-schválení do 5 %.
const S1CFG = { target: { mode: 'undercut_min', offset_pct: -1 }, limits: { min_margin_pct: 20 }, approval: { auto: true, auto_max_change_pct: 5 } };

/**
 * Základní katalog:
 *  P1 KOLO-1 Scott, 13 490, nákup 8 000, MOC 14 990 ; trh VM 12 990, KS 13 200, BS 14 000 (+ vypnutý Bazar 9 000)
 *     S1 → 12 860,1 → dolů 11 990 < floor 12 100 → 12 990 ; −3,71 % → auto-schváleno
 *  P2 KOLO-2 Trek, 32 990, nákup 20 000, MOC 34 990 ; trh VM 31 990, KS 33 490 (+ BS 25 000 starý 10 dní → ignorovat)
 *     S1 → 31 990 × 0,99 = 31 670,1 ; floor 20000/0,8×1,21 = 30 250 ; pokles max 10 % → 29 691 ; dolů → 30 990 ≥ floor
 *     → 30 990 ; −2 000 / 32 990 = −6,06 % > 5 → big_change → pending
 *  P3 KOLO-3 Scott, zamčený → skip locked
 *  P4 KOLO-4 neaktivní → nevyhodnocuje se
 */
function baseDb() {
  const db = openDb(':memory:');
  const p1 = insProduct(db, { code: 'KOLO-1' });
  const p2 = insProduct(db, {
    code: 'KOLO-2',
    name: 'Trek Domane AL 4',
    manufacturer: 'Trek',
    category: 'Silniční kola',
    purchase_price: 20000,
    price: 32990,
    msrp: 34990,
    stock: 2,
    attrs: '{"N":"N7"}',
  });
  const p3 = insProduct(db, { code: 'KOLO-3', name: 'Scott Scale 970', purchase_price: 5000, price: 9990, msrp: 9990, stock: 1, locked: 1 });
  const p4 = insProduct(db, { code: 'KOLO-4', name: 'Scott vyřazené', active: 0 });
  const vm = insCompetitor(db, 'VeloMarket.cz');
  const ks = insCompetitor(db, 'Kolo-Shop.cz', { tags: '["marketplace"]' });
  const bs = insCompetitor(db, 'BikeStore.cz');
  const bz = insCompetitor(db, 'Bazar.cz', { enabled: 0 });
  insOffer(db, p1, vm, 12990);
  insOffer(db, p1, ks, 13200);
  insOffer(db, p1, bs, 14000);
  insOffer(db, p1, bz, 9000);
  insOffer(db, p2, vm, 31990);
  insOffer(db, p2, ks, 33490);
  insOffer(db, p2, bs, 25000, { observed_at: daysAgo(10) });
  insOffer(db, p3, vm, 9490);
  insOffer(db, p4, vm, 9000);
  return { db, p1, p2, p3, p4, vm, ks, bs, bz };
}

const proposalsOf = (db, runId) => db.prepare('SELECT * FROM proposals WHERE run_id = ? ORDER BY product_id').all(runId).map((r) => ({ ...r }));
const statusOf = (db, id) => db.prepare('SELECT status FROM proposals WHERE id = ?').get(id).status;
const productRow = (db, id) => ({ ...db.prepare('SELECT * FROM products WHERE id = ?').get(id) });

function insRun(db, over = {}) {
  return ins(db, 'runs', { started_at: daysAgo(2), finished_at: daysAgo(2), status: 'done', trigger: 'manual', stats: '{}', ...over });
}
function insProposal(db, runId, productId, status, over = {}) {
  return ins(db, 'proposals', {
    run_id: runId,
    product_id: productId,
    strategy_id: null,
    old_price: 13490,
    new_price: 12490,
    status,
    flags: '[]',
    explain: '[]',
    created_at: daysAgo(2),
    ...over,
  });
}

// =====================================================================================================
// runPricing
// =====================================================================================================

test('runPricing: statistiky běhu (změny, směr, skipy, auto-schválení, by_strategy, dopad na marži)', () => {
  const { db, p1, p2 } = baseDb();
  const s1 = insStrategy(db, 'Podstřelit nejlevnějšího', cfg(S1CFG), { priority: 10 });
  const res = RUN().runPricing(db, { now: NOW });
  assert.ok(Number(res.run_id) > 0, 'run_id');
  const st = res.stats;
  for (const k of ['products', 'evaluated', 'changes', 'up', 'down', 'no_change', 'skipped', 'no_strategy', 'fallthrough', 'auto_approved', 'pending', 'by_strategy', 'margin_impact_abs']) {
    assert.ok(k in st, `stats.${k} chybí`);
  }
  // SPEC-AMBIGUOUS: „products“ / „evaluated“ – bereme počet aktivních produktů v běhu (P1, P2, P3; P4 je neaktivní).
  assert.strictEqual(st.products, 3);
  assert.strictEqual(st.evaluated, 3);
  assert.strictEqual(st.changes, 2);
  assert.strictEqual(st.up, 0);
  assert.strictEqual(st.down, 2);
  assert.strictEqual(st.no_change, 0);
  assert.strictEqual(st.skipped.locked, 1);
  assert.strictEqual(st.no_strategy, 0);
  assert.strictEqual(st.fallthrough, 0);
  assert.strictEqual(st.auto_approved, 1);
  assert.strictEqual(st.pending, 1);
  const bs = st.by_strategy[s1];
  assert.ok(bs, 'by_strategy[s1]');
  assert.strictEqual(bs.name, 'Podstřelit nejlevnějšího');
  assert.strictEqual(bs.changes, 2);
  assert.strictEqual(bs.up, 0);
  assert.strictEqual(bs.down, 2);
  // Σ (net new − net old) = (12 990 − 13 490)/1,21 + (30 990 − 32 990)/1,21 = −2 500 / 1,21 = −2 066,12
  approx(st.margin_impact_abs, -2066.12, 0.02, 'margin_impact_abs');
  assert.ok(p1 && p2);
});

test('runPricing: zapíše runs a proposals (pending / approved) s metrikami', () => {
  const { db, p1, p2 } = baseDb();
  const s1 = insStrategy(db, 'Podstřelit nejlevnějšího', cfg(S1CFG), { priority: 10 });
  const res = RUN().runPricing(db, { now: NOW });
  const run = { ...db.prepare('SELECT * FROM runs WHERE id = ?').get(res.run_id) };
  assert.strictEqual(run.status, 'done');
  assert.strictEqual(run.trigger, 'manual');
  assert.ok(run.finished_at);
  assert.strictEqual(JSON.parse(run.stats).changes, 2);

  const props = proposalsOf(db, res.run_id);
  assert.strictEqual(props.length, 2, 'ukládají se jen změny (P1, P2)');
  const [a, b] = props;
  assert.strictEqual(a.product_id, p1);
  assert.strictEqual(a.status, 'approved');
  assert.strictEqual(a.strategy_id, s1);
  assert.strictEqual(a.segment_id, null);
  assert.strictEqual(a.old_price, 13490);
  assert.strictEqual(a.new_price, 12990);
  approx(a.target_price, 12860.1, 0.001, 'target_price');
  assert.strictEqual(a.reference_price, 12990);
  // vypnutý Bazar (9 000) se nepočítá → min 12 990, 3 konkurenti
  assert.strictEqual(a.market_min, 12990);
  assert.strictEqual(a.competitor_count, 3);
  assert.strictEqual(a.rank_before, 3);
  assert.strictEqual(a.rank_after, 1);
  approx(a.margin_before, 28.24, 0.006);
  approx(a.margin_after, 25.48, 0.006);
  approx(a.change_abs, -500, 0.001);
  assert.strictEqual(a.change_pct, -3.71);
  assert.ok(Array.isArray(JSON.parse(a.flags)));
  const explain = JSON.parse(a.explain);
  assert.ok(Array.isArray(explain) && explain.length > 0);
  assert.ok(explain.every((e) => typeof e.text === 'string'));

  assert.strictEqual(b.product_id, p2);
  assert.strictEqual(b.status, 'pending');
  assert.strictEqual(b.new_price, 30990);
  // starý BikeStore (25 000, 10 dní) se nepočítá → min 31 990, 2 konkurenti
  assert.strictEqual(b.market_min, 31990);
  assert.strictEqual(b.competitor_count, 2);
  assert.strictEqual(b.change_pct, -6.06);
  assert.ok(JSON.parse(b.flags).includes('big_change'));
});

test('runPricing: trigger se uloží do runs', () => {
  const { db } = baseDb();
  insStrategy(db, 'S1', cfg(S1CFG));
  const res = RUN().runPricing(db, { now: NOW, trigger: 'schedule' });
  assert.strictEqual(db.prepare('SELECT trigger FROM runs WHERE id = ?').get(res.run_id).trigger, 'schedule');
});

test('runPricing: nový běh označí starší pending + approved (neexportované) jako superseded, exported/rejected ne', () => {
  const { db, p1, p2 } = baseDb();
  insStrategy(db, 'S1', cfg(S1CFG), { priority: 10 });
  const old = insRun(db);
  const pend = insProposal(db, old, p1, 'pending');
  const appr = insProposal(db, old, p1, 'approved', { decided_at: daysAgo(2), decided_by: 'admin' });
  const expd = insProposal(db, old, p1, 'exported', { exported_at: daysAgo(1), export_id: 1 });
  const rej = insProposal(db, old, p1, 'rejected', { decided_at: daysAgo(2) });
  const otherPend = insProposal(db, old, p2, 'pending', { old_price: 32990, new_price: 31990 });
  const res = RUN().runPricing(db, { now: NOW, productIds: [p1] });
  assert.strictEqual(statusOf(db, pend), 'superseded');
  assert.strictEqual(statusOf(db, appr), 'superseded');
  assert.strictEqual(statusOf(db, expd), 'exported');
  assert.strictEqual(statusOf(db, rej), 'rejected');
  // P2 nebyl v tomto běhu vyhodnocen → jeho návrh zůstává
  assert.strictEqual(statusOf(db, otherPend), 'pending');
  const props = proposalsOf(db, res.run_id);
  assert.strictEqual(props.length, 1);
  assert.strictEqual(props[0].product_id, p1);
  assert.strictEqual(props[0].status, 'approved');
});

test('runPricing: druhý běh nahradí návrhy prvního běhu', () => {
  const { db } = baseDb();
  insStrategy(db, 'S1', cfg(S1CFG), { priority: 10 });
  const r1 = RUN().runPricing(db, { now: NOW });
  const r2 = RUN().runPricing(db, { now: NOW });
  assert.notStrictEqual(r1.run_id, r2.run_id);
  const first = proposalsOf(db, r1.run_id);
  assert.strictEqual(first.length, 2);
  assert.ok(first.every((p) => p.status === 'superseded'), JSON.stringify(first.map((p) => p.status)));
  const second = proposalsOf(db, r2.run_id);
  assert.deepStrictEqual(second.map((p) => p.status), ['approved', 'pending']);
});

test('runPricing: superseded platí i pro vyhodnocený produkt, u kterého nový běh nenavrhl změnu', () => {
  // §3.6: „A new run marks all older pending and approved (not exported) proposals of every evaluated product as superseded.“
  const { db, p1 } = baseDb();
  insStrategy(db, 'Držet cenu', cfg({ target: { mode: 'keep' } }));
  const old = insRun(db);
  const pend = insProposal(db, old, p1, 'pending');
  const res = RUN().runPricing(db, { now: NOW });
  assert.strictEqual(res.stats.changes, 0);
  assert.strictEqual(res.stats.no_change, 2); // P1, P2 (P3 zamčený)
  assert.strictEqual(res.stats.skipped.locked, 1);
  assert.strictEqual(proposalsOf(db, res.run_id).length, 0, 'no_change se neukládá jako návrh');
  assert.strictEqual(statusOf(db, pend), 'superseded');
});

test('runPricing: neaktivní produkt se nevyhodnocuje a jeho návrhy zůstávají', () => {
  const { db, p4 } = baseDb();
  insStrategy(db, 'S1', cfg(S1CFG));
  const old = insRun(db);
  const pend = insProposal(db, old, p4, 'pending');
  const res = RUN().runPricing(db, { now: NOW });
  assert.ok(!proposalsOf(db, res.run_id).some((p) => p.product_id === p4));
  assert.strictEqual(statusOf(db, pend), 'pending');
});

test('runPricing: productIds omezí běh na vybrané produkty', () => {
  const { db, p2 } = baseDb();
  insStrategy(db, 'S1', cfg(S1CFG));
  const res = RUN().runPricing(db, { now: NOW, productIds: [p2] });
  const props = proposalsOf(db, res.run_id);
  assert.deepStrictEqual(props.map((p) => p.product_id), [p2]);
  assert.strictEqual(res.stats.changes, 1);
  assert.strictEqual(res.stats.down, 1);
  assert.ok(!res.stats.skipped.locked, 'zamčený P3 nebyl v běhu');
});

test('runPricing dryRun: žádné zápisy (runs, proposals, superseded), run_id null, statistiky spočítané', () => {
  const { db, p1 } = baseDb();
  insStrategy(db, 'S1', cfg(S1CFG));
  const old = insRun(db);
  const pend = insProposal(db, old, p1, 'pending');
  const runsBefore = count(db, 'SELECT count(*) c FROM runs');
  const propsBefore = count(db, 'SELECT count(*) c FROM proposals');
  const res = RUN().runPricing(db, { now: NOW, dryRun: true });
  assert.ok(res.run_id == null);
  assert.strictEqual(res.stats.changes, 2);
  assert.strictEqual(count(db, 'SELECT count(*) c FROM runs'), runsBefore);
  assert.strictEqual(count(db, 'SELECT count(*) c FROM proposals'), propsBefore);
  assert.strictEqual(statusOf(db, pend), 'pending');
  if (Array.isArray(res.decisions)) {
    const d = res.decisions.find((x) => x.product_id === p1);
    assert.ok(d && d.new_price === 12990);
  }
});

test('runPricing: zvýšení cen – stats.up a kladný margin_impact_abs', () => {
  // cíl MOC: P1 13 490 → 14 990 (+11,12 % ≤ 15 %) ; P2 32 990 → 34 990 (+6,06 %) ; oba jsou body …990
  // margin_impact = (1 500 + 2 000) / 1,21 = 2 892,56
  const { db } = baseDb();
  const s = insStrategy(db, 'Na MOC', cfg({ target: { mode: 'msrp' } }));
  const res = RUN().runPricing(db, { now: NOW });
  assert.strictEqual(res.stats.up, 2);
  assert.strictEqual(res.stats.down, 0);
  assert.strictEqual(res.stats.changes, 2);
  assert.strictEqual(res.stats.pending, 2); // approval.auto výchozí false
  assert.strictEqual(res.stats.auto_approved, 0);
  assert.strictEqual(res.stats.by_strategy[s].up, 2);
  approx(res.stats.margin_impact_abs, 2892.56, 0.02);
  assert.deepStrictEqual(proposalsOf(db, res.run_id).map((p) => p.new_price), [14990, 34990]);
});

test('runPricing: fall-through mezi dvěma strategiemi (fallback next) a no_strategy', () => {
  // SA (priorita 10): konkrétní konkurent „Neexistuje.cz“, fallback next → vždy propadne
  // SB (priorita 20): medián trhu −2 %, min. marže 20 %
  //   P1: medián 13 200 × 0,98 = 12 936 → dolů 11 990 < floor 12 100 → 12 990
  //   P2: medián (31 990 + 33 490)/2 = 32 740 × 0,98 = 32 085,2 → dolů 31 990 (≥ 30 250, ≥ 29 691) → 31 990 (−3,03 %)
  //   P3: zamčený – SA je použitelná a computePrice vrátí skip locked (zámek je krok 1, před cenovou základnou)
  //   P5: bez nabídek a bez MOC → SA propadne (no_competitor), SB propadne (no_market) → no_strategy
  const { db, p1, p2 } = baseDb();
  const p5 = insProduct(db, { code: 'KOLO-5', name: 'Author Solution', manufacturer: 'Author', msrp: null });
  const sa = insStrategy(db, 'Hlídat Neexistuje.cz', cfg({ target: { mode: 'competitor', competitor: 'Neexistuje.cz' }, fallback: { mode: 'next' } }), { priority: 10 });
  const sb = insStrategy(db, 'Medián −2 %', cfg({ target: { mode: 'market_median', offset_pct: -2 }, limits: { min_margin_pct: 20 } }), { priority: 20 });
  const res = RUN().runPricing(db, { now: NOW });
  const st = res.stats;
  assert.strictEqual(st.changes, 2);
  assert.strictEqual(st.fallthrough, 3, 'P1, P2, P5 – aspoň jedna strategie propadla');
  assert.strictEqual(st.no_strategy, 1, 'P5');
  assert.strictEqual(st.skipped.locked, 1, 'P3');
  assert.strictEqual(st.by_strategy[sb].changes, 2);
  assert.ok(!st.by_strategy[sa] || !st.by_strategy[sa].changes);
  const props = proposalsOf(db, res.run_id);
  assert.deepStrictEqual(props.map((p) => [p.product_id, p.strategy_id, p.new_price]), [
    [p1, sb, 12990],
    [p2, sb, 31990],
  ]);
  assert.ok(!props.some((p) => p.product_id === p5));
  // vysvětlení začíná informací o nepoužité strategii
  const ex = JSON.parse(props[0].explain);
  assert.ok(ex[0].text.includes('Hlídat Neexistuje.cz'), `první krok vysvětlení: ${ex[0].text}`);
});

test('runPricing: segment strategie nesedí → no_strategy', () => {
  const { db, p2 } = baseDb();
  const trek = insSegment(db, 'Trek', { field: 'manufacturer', op: '=', value: 'trek' });
  insStrategy(db, 'Jen Trek', cfg(S1CFG), { segment_id: trek });
  const res = RUN().runPricing(db, { now: NOW });
  // P1 a P3 (Scott) nemají použitelnou strategii; zámek P3 se kontroluje až v computePrice (§6.7 krok 0/1)
  assert.strictEqual(res.stats.no_strategy, 2);
  assert.strictEqual(res.stats.changes, 1);
  const props = proposalsOf(db, res.run_id);
  assert.deepStrictEqual(props.map((p) => p.product_id), [p2]);
  assert.strictEqual(props[0].segment_id, trek);
});

test('runPricing: vypnutá strategie se ignoruje, pořadí podle priority (shoda → nižší id)', () => {
  const { db, p1 } = baseDb();
  insStrategy(db, 'Vypnutá MOC', cfg({ target: { mode: 'msrp' } }), { priority: 1, enabled: 0 });
  const lowId = insStrategy(db, 'Fixní 11 990 (nižší id)', cfg({ target: { mode: 'fixed', fixed_price: 11990 }, limits: { max_decrease_pct: null } }), { priority: 50 });
  const highId = insStrategy(db, 'S1 (vyšší id)', cfg(S1CFG), { priority: 50 });
  assert.ok(lowId < highId);
  const res = RUN().runPricing(db, { now: NOW, productIds: [p1] });
  const props = proposalsOf(db, res.run_id);
  // shoda priority 50 → rozhoduje nižší id ; 11 990 je bod pásma …990, bez limitu poklesu, nad floor 10 755,56
  assert.strictEqual(props[0].strategy_id, lowId);
  assert.strictEqual(props[0].new_price, 11990);
});

test('runPricing: tagy konkurentů z tabulky competitors (exclude_tags)', () => {
  // Kolo-Shop má tag „marketplace“ → vyřazen → P1 trh VM 12 990 + BS 14 000 (2 konkurenti)
  const { db, p1 } = baseDb();
  insStrategy(db, 'Bez marketplace', cfg({ ...S1CFG, competitors: { exclude_tags: ['marketplace'] } }));
  const res = RUN().runPricing(db, { now: NOW, productIds: [p1] });
  const [p] = proposalsOf(db, res.run_id);
  assert.strictEqual(p.competitor_count, 2);
  assert.strictEqual(p.market_min, 12990);
  assert.strictEqual(p.new_price, 12990);
});

test('runPricing: částečná konfigurace uložená v DB se doplní výchozími hodnotami', () => {
  // SPEC-AMBIGUOUS: API ukládá config normalizovaný, ale engine by měl být odolný – bereme, že run.js
  // konfiguraci normalizuje (normalizeConfig). Bez výchozího zaokrouhlení by P1 skončil na 12 860,1 místo 12 990.
  const { db, p1 } = baseDb();
  insStrategy(db, 'Částečná', { target: { mode: 'undercut_min', offset_pct: -1 }, limits: { min_margin_pct: 20 } });
  const res = RUN().runPricing(db, { now: NOW, productIds: [p1] });
  const [p] = proposalsOf(db, res.run_id);
  assert.strictEqual(p.new_price, 12990);
});

test('latestProposal: vrátí poslední návrh produktu', () => {
  const { db, p1 } = baseDb();
  insStrategy(db, 'S1', cfg(S1CFG));
  const res = RUN().runPricing(db, { now: NOW });
  const lp = RUN().latestProposal(db, p1);
  assert.ok(lp);
  assert.strictEqual(lp.new_price, 12990);
  assert.strictEqual(lp.run_id, res.run_id);
});

// =====================================================================================================
// loadContext + evaluateProduct (§3.5)
// =====================================================================================================

function ctxAt(db, now) {
  const ctx = RUN().loadContext(db, { now });
  // SPEC uvádí jen {settings, segments, strategies, competitors}; evaluateProduct potřebuje „teď“ – doplníme ctx.now,
  // pokud ho implementace sama neuložila (nepřepisujeme).
  if (ctx.now === undefined) ctx.now = now;
  return ctx;
}
function evalAt(db, productId, offers, now = NOW) {
  return RUN().evaluateProduct(ctxAt(db, now), productRow(db, productId), offers);
}
const sizeOf = (x) => (Array.isArray(x) ? x.length : x instanceof Map ? x.size : Object.keys(x || {}).length);

test('loadContext: strategie jen zapnuté, seřazené podle priority a id; segmenty zkompilované', () => {
  const { db } = baseDb();
  insSegment(db, 'Scott', { field: 'manufacturer', op: '=', value: 'Scott' });
  insSegment(db, 'Trek', { field: 'manufacturer', op: '=', value: 'Trek' });
  const a = insStrategy(db, 'A', cfg({}), { priority: 20 });
  const b = insStrategy(db, 'B', cfg({}), { priority: 10 });
  const c = insStrategy(db, 'C', cfg({}), { priority: 10 });
  insStrategy(db, 'D vypnutá', cfg({}), { priority: 1, enabled: 0 });
  const ctx = RUN().loadContext(db, { now: NOW });
  assert.ok(ctx.settings && ctx.settings.vat_rate_default === 21);
  assert.deepStrictEqual(ctx.strategies.map((s) => s.id), [b, c, a]);
  assert.strictEqual(sizeOf(ctx.segments), 2);
  assert.ok(ctx.competitors, 'competitors');
});

test('evaluateProduct: segmentIds, nepoužitelná strategie (segment) → další strategie rozhoduje', () => {
  const { db, p1 } = baseDb();
  const segScott = insSegment(db, 'Scott', { field: 'manufacturer', op: '=', value: 'scott' });
  insSegment(db, 'Trek', { field: 'manufacturer', op: '=', value: 'trek' });
  const segMtb = insSegment(db, 'Horská kola', { field: 'category', op: '=', value: 'horska kola' });
  const trek = db.prepare("SELECT id FROM segments WHERE name = 'Trek'").get().id;
  const sTrek = insStrategy(db, 'Jen Trek', cfg({ target: { mode: 'msrp' } }), { priority: 10, segment_id: trek });
  const sAll = insStrategy(db, 'Všechno', cfg(S1CFG), { priority: 20 });
  const r = evalAt(db, p1, market3());
  assert.deepStrictEqual([...r.segmentIds].sort((x, y) => x - y), [segScott, segMtb].sort((x, y) => x - y));
  assert.strictEqual(r.view.code, 'KOLO-1');
  assert.strictEqual(r.strategy.id, sAll);
  assert.strictEqual(r.decision.new_price, 12990);
  assert.deepStrictEqual(r.tried.map((t) => [t.strategy_id, t.result]), [
    [sTrek, 'not_applicable'],
    [sAll, 'decided'],
  ]);
});

test('evaluateProduct: fall-through – tried, rozhodující strategie a vysvětlení „Strategie X nepoužita“', () => {
  const { db, p1 } = baseDb();
  const sa = insStrategy(db, 'Hlídat Neexistuje.cz', cfg({ target: { mode: 'competitor', competitor: 'Neexistuje.cz' } }), { priority: 10 });
  const sb = insStrategy(db, 'Medián −2 %', cfg({ target: { mode: 'market_median', offset_pct: -2 }, limits: { min_margin_pct: 20 } }), { priority: 20 });
  const r = evalAt(db, p1, market3());
  assert.deepStrictEqual(r.tried.map((t) => [t.strategy_id, t.result]), [
    [sa, 'fallthrough'],
    [sb, 'decided'],
  ]);
  assert.strictEqual(r.strategy.id, sb);
  assert.strictEqual(r.decision.strategy_id, sb);
  assert.strictEqual(r.decision.new_price, 12990);
  assert.ok(r.decision.explain[0].text.includes('Hlídat Neexistuje.cz'), r.decision.explain[0].text);
  assert.match(r.decision.explain[0].text, /nepoužit/i);
  for (const t of r.tried) assert.ok(typeof t.name === 'string' && t.name.length > 0, 'tried[].name');
});

test('evaluateProduct: fallback keep strategii nepropadne – rozhodne no_change no_market', () => {
  const { db, p1 } = baseDb();
  const sa = insStrategy(db, 'Podstřelit, jinak držet', cfg({ target: { mode: 'undercut_min' }, fallback: { mode: 'keep' } }), { priority: 10 });
  insStrategy(db, 'MOC', cfg({ target: { mode: 'msrp' } }), { priority: 20 });
  const r = evalAt(db, p1, []);
  assert.strictEqual(r.strategy.id, sa);
  assert.strictEqual(r.decision.action, 'no_change');
  assert.strictEqual(r.decision.reason, 'no_market');
  assert.strictEqual(r.tried[r.tried.length - 1].result, 'decided');
  assert.ok(!r.tried.some((t) => t.result === 'fallthrough'));
});

test('runPricing: zero_stock skip → stats.skipped.zero_stock', () => {
  const { db, p2 } = baseDb();
  db.prepare('UPDATE products SET stock = 0 WHERE id = ?').run(p2);
  insStrategy(db, 'S1 bez nulového skladu', cfg({ ...S1CFG, stock: { zero_stock: 'skip' } }));
  const res = RUN().runPricing(db, { now: NOW });
  assert.strictEqual(res.stats.skipped.zero_stock, 1);
  assert.strictEqual(res.stats.skipped.locked, 1);
  assert.strictEqual(res.stats.changes, 1);
  assert.ok(!proposalsOf(db, res.run_id).some((p) => p.product_id === p2));
});

test('evaluateProduct: všechny strategie propadnou → strategy null (no_strategy)', () => {
  const { db, p1 } = baseDb();
  insStrategy(db, 'Podstřelit', cfg({ target: { mode: 'undercut_min' } }), { priority: 10 });
  const r = evalAt(db, p1, []);
  assert.ok(r.strategy == null);
  assert.strictEqual(r.tried[0].result, 'fallthrough');
});

test('evaluateProduct: conditions nad pohledem produktu (position = cheapest)', () => {
  const { db, p1 } = baseDb();
  const cond = insStrategy(
    db,
    'Návrat marže',
    cfg({ conditions: { field: 'position', op: '=', value: 'cheapest' }, target: { mode: 'fixed', fixed_price: 13990 } }),
    { priority: 10 }
  );
  const base = insStrategy(db, 'Držet', cfg({ target: { mode: 'keep' } }), { priority: 20 });
  // 13 490 vs trh 12 990 / 13 200 / 14 000 → middle → podmínka neplatí
  const r1 = evalAt(db, p1, market3());
  assert.strictEqual(r1.strategy.id, base);
  assert.strictEqual(r1.tried[0].result, 'not_applicable');
  // trh 14 000 / 14 500 → cheapest → podmínka platí
  const r2 = evalAt(db, p1, [offer('BikeStore.cz', 14000), offer('Kolo-Shop.cz', 14500)]);
  assert.strictEqual(r2.strategy.id, cond);
});

test('evaluateProduct: conditions all [position = cheapest, gap_min_pct <= −5] (preset návrat marže)', () => {
  const { db, p1 } = baseDb();
  const cond = insStrategy(
    db,
    'Návrat marže',
    cfg({
      conditions: { all: [{ field: 'position', op: '=', value: 'cheapest' }, { field: 'gap_min_pct', op: '<=', value: -5 }] },
      target: { mode: 'undercut_min', offset_pct: -1 },
    }),
    { priority: 10 }
  );
  const base = insStrategy(db, 'Držet', cfg({ target: { mode: 'keep' } }), { priority: 20 });
  // min 14 500: gap = (13 490 − 14 500) / 14 500 = −6,97 % → platí
  assert.strictEqual(evalAt(db, p1, [offer('A.cz', 14500), offer('B.cz', 15000)]).strategy.id, cond);
  // min 13 900: gap = −2,95 % → neplatí
  assert.strictEqual(evalAt(db, p1, [offer('A.cz', 13900), offer('B.cz', 15000)]).strategy.id, base);
});

test('evaluateProduct: segment AND conditions', () => {
  const { db, p1 } = baseDb();
  const trek = insSegment(db, 'Trek', { field: 'manufacturer', op: '=', value: 'trek' });
  insStrategy(db, 'Trek + cokoli', cfg({ conditions: { field: 'stock', op: '>', value: 0 }, target: { mode: 'msrp' } }), { priority: 10, segment_id: trek });
  const base = insStrategy(db, 'Držet', cfg({ target: { mode: 'keep' } }), { priority: 20 });
  assert.strictEqual(evalAt(db, p1, market3()).strategy.id, base);
});

// ---------- schedule (Europe/Prague) ----------

function scheduleCase(schedule, now) {
  const { db, p1 } = baseDb();
  const sched = insStrategy(db, 'Akce', cfg({ schedule, target: { mode: 'fixed', fixed_price: 12990 } }), { priority: 10 });
  const base = insStrategy(db, 'Držet', cfg({ target: { mode: 'keep' } }), { priority: 20 });
  const r = evalAt(db, p1, [], now);
  assert.ok(r.strategy, 'nějaká strategie musí rozhodnout');
  return r.strategy.id === sched ? 'akce' : r.strategy.id === base ? 'zaklad' : 'jina';
}
const SCH = (over) => ({ valid_from: null, valid_to: null, weekdays: [], hours: null, ...over });

test('schedule: výchozí (bez omezení) → vždy aktivní', () => {
  assert.strictEqual(scheduleCase(SCH({}), NOW), 'akce');
});

test('schedule: valid_from včetně, valid_to bez', () => {
  assert.strictEqual(scheduleCase(SCH({ valid_from: daysAhead(1) }), NOW), 'zaklad');
  assert.strictEqual(scheduleCase(SCH({ valid_from: NOW }), NOW), 'akce');
  assert.strictEqual(scheduleCase(SCH({ valid_to: NOW }), NOW), 'zaklad');
  assert.strictEqual(scheduleCase(SCH({ valid_from: daysAgo(1), valid_to: daysAhead(1) }), NOW), 'akce');
  assert.strictEqual(scheduleCase(SCH({ valid_from: daysAgo(3), valid_to: daysAgo(1) }), NOW), 'zaklad');
});

test('schedule: weekdays 1 = po … 7 = ne v pražském čase', () => {
  // NOW = pátek 25. 9. 2026 12:00 Praha
  assert.strictEqual(scheduleCase(SCH({ weekdays: [5] }), NOW), 'akce');
  assert.strictEqual(scheduleCase(SCH({ weekdays: [1, 2, 3, 4] }), NOW), 'zaklad');
  // 2026-09-27T10:00Z = neděle → 7
  assert.strictEqual(scheduleCase(SCH({ weekdays: [7] }), '2026-09-27T10:00:00.000Z'), 'akce');
  assert.strictEqual(scheduleCase(SCH({ weekdays: [1, 2, 3, 4, 5, 6] }), '2026-09-27T10:00:00.000Z'), 'zaklad');
});

test('schedule: weekdays přes půlnoc – 2026-09-25T22:30Z je v Praze už sobota 00:30', () => {
  const t = '2026-09-25T22:30:00.000Z'; // UTC pátek, Praha (CEST, UTC+2) sobota
  assert.strictEqual(scheduleCase(SCH({ weekdays: [6] }), t), 'akce');
  assert.strictEqual(scheduleCase(SCH({ weekdays: [5] }), t), 'zaklad');
  assert.strictEqual(scheduleCase(SCH({ weekdays: [6, 7] }), t), 'akce');
});

test('schedule: hours [od, do) v pražském čase (letní čas CEST)', () => {
  // 16:30Z = 18:30 Praha → v [18, 24)
  assert.strictEqual(scheduleCase(SCH({ hours: [18, 24] }), '2026-09-25T16:30:00.000Z'), 'akce');
  // 15:30Z = 17:30 Praha → mimo
  assert.strictEqual(scheduleCase(SCH({ hours: [18, 24] }), '2026-09-25T15:30:00.000Z'), 'zaklad');
  // 22:30Z = 00:30 Praha (další den) → mimo, přestože v UTC by byla 22. hodina
  assert.strictEqual(scheduleCase(SCH({ hours: [18, 24] }), '2026-09-25T22:30:00.000Z'), 'zaklad');
  // konec intervalu je vyloučen: NOW = 12:00 Praha, [8, 12) → mimo ; 11:59 → uvnitř
  assert.strictEqual(scheduleCase(SCH({ hours: [8, 12] }), NOW), 'zaklad');
  assert.strictEqual(scheduleCase(SCH({ hours: [8, 12] }), '2026-09-25T09:59:00.000Z'), 'akce');
});

test('schedule: hours v zimním čase (CET, UTC+1)', () => {
  // 2026-01-15T17:30Z = 18:30 Praha → uvnitř [18, 24) ; 16:30Z = 17:30 Praha → mimo
  assert.strictEqual(scheduleCase(SCH({ hours: [18, 24] }), '2026-01-15T17:30:00.000Z'), 'akce');
  assert.strictEqual(scheduleCase(SCH({ hours: [18, 24] }), '2026-01-15T16:30:00.000Z'), 'zaklad');
});

test('schedule: kombinace weekdays + hours (víkendový večer)', () => {
  // sobota 26. 9. 2026 17:00Z = 19:00 Praha
  assert.strictEqual(scheduleCase(SCH({ weekdays: [6, 7], hours: [18, 24] }), '2026-09-26T17:00:00.000Z'), 'akce');
  // sobota 10:00 Praha → mimo hodiny
  assert.strictEqual(scheduleCase(SCH({ weekdays: [6, 7], hours: [18, 24] }), '2026-09-26T08:00:00.000Z'), 'zaklad');
  // pátek 19:00 Praha → mimo dny
  assert.strictEqual(scheduleCase(SCH({ weekdays: [6, 7], hours: [18, 24] }), '2026-09-25T17:00:00.000Z'), 'zaklad');
});

test('schedule přes runPricing: strategie mimo okno → no_strategy', () => {
  const { db, p1 } = baseDb();
  insStrategy(db, 'Jen o víkendu', cfg({ ...S1CFG, schedule: { weekdays: [6, 7] } }));
  const fri = RUN().runPricing(db, { now: NOW, productIds: [p1] }); // pátek
  assert.strictEqual(fri.stats.no_strategy, 1);
  assert.strictEqual(fri.stats.changes, 0);
  const sat = RUN().runPricing(db, { now: '2026-09-25T22:30:00.000Z', productIds: [p1] }); // sobota 00:30 Praha
  assert.strictEqual(sat.stats.changes, 1);
});

// =====================================================================================================
// simulate + explainProduct
// =====================================================================================================

test('simulate: filtr produktů, rozhodnutí (změny + skipy), žádné zápisy', () => {
  const { db, p1, p2, p3, p4 } = baseDb();
  const old = insRun(db);
  const pend = insProposal(db, old, p1, 'pending');
  const before = [count(db, 'SELECT count(*) c FROM runs'), count(db, 'SELECT count(*) c FROM proposals')];
  const res = RUN().simulate(db, { config: cfg(S1CFG), filter: { field: 'manufacturer', op: '=', value: 'Scott' }, now: NOW });
  assert.deepStrictEqual([count(db, 'SELECT count(*) c FROM runs'), count(db, 'SELECT count(*) c FROM proposals')], before);
  assert.strictEqual(statusOf(db, pend), 'pending');
  assert.strictEqual(res.stats.changes, 1);
  assert.strictEqual(res.stats.skipped.locked, 1);
  const byProduct = new Map(res.decisions.map((d) => [d.product_id, d]));
  assert.strictEqual(byProduct.get(p1).action, 'change');
  assert.strictEqual(byProduct.get(p1).new_price, 12990);
  assert.strictEqual(byProduct.get(p3).action, 'skip');
  assert.strictEqual(byProduct.get(p3).reason, 'locked');
  assert.ok(!byProduct.has(p2), 'Trek neodpovídá filtru');
  assert.ok(!byProduct.has(p4), 'neaktivní produkt');
});

test('simulate: segment_id, bez filtru = všechny aktivní, limit', () => {
  const { db, p2 } = baseDb();
  const trek = insSegment(db, 'Trek', { field: 'manufacturer', op: '=', value: 'Trek' });
  const r1 = RUN().simulate(db, { config: cfg(S1CFG), segment_id: trek, now: NOW });
  assert.deepStrictEqual(r1.decisions.map((d) => [d.product_id, d.new_price]), [[p2, 30990]]);
  const r2 = RUN().simulate(db, { config: cfg(S1CFG), now: NOW });
  assert.strictEqual(r2.stats.changes, 2);
  assert.strictEqual(r2.decisions.length, 3); // 2 změny + 1 skip
  const r3 = RUN().simulate(db, { config: cfg(S1CFG), now: NOW, limit: 1 });
  assert.ok(r3.decisions.length <= 1);
  assert.strictEqual(count(db, 'SELECT count(*) c FROM runs'), 0);
});

test('explainProduct: pohled, segmenty, strategie a rozhodnutí bez zápisů', () => {
  const { db, p1 } = baseDb();
  const segScott = insSegment(db, 'Scott', { field: 'manufacturer', op: '=', value: 'Scott' });
  insSegment(db, 'Trek', { field: 'manufacturer', op: '=', value: 'Trek' });
  const s1 = insStrategy(db, 'S1', cfg(S1CFG));
  const r = RUN().explainProduct(db, p1, { now: NOW });
  assert.strictEqual(r.view.code, 'KOLO-1');
  assert.strictEqual(r.view.market_count, 3);
  assert.deepStrictEqual(r.segments.map((s) => ({ id: s.id, name: s.name })), [{ id: segScott, name: 'Scott' }]);
  assert.strictEqual(r.strategy.id, s1);
  assert.strictEqual(r.decision.new_price, 12990);
  assert.strictEqual(count(db, 'SELECT count(*) c FROM runs'), 0);
  assert.strictEqual(count(db, 'SELECT count(*) c FROM proposals'), 0);
});

test('explainProduct: bez použitelné strategie → strategy i decision null', () => {
  const { db, p1 } = baseDb();
  const r = RUN().explainProduct(db, p1, { now: NOW });
  assert.ok(r.strategy == null);
  assert.ok(r.decision == null);
  assert.strictEqual(r.view.code, 'KOLO-1');
});

// =====================================================================================================
// Doplňkové scénáře
// =====================================================================================================

test('runPricing: segment nad tržní metrikou pohledu (market_count = 0 → MOC)', () => {
  // P5 bez nabídek: segment „Bez konkurence“ → cíl MOC 15 990 (bez limitu zvýšení, strop MOC 15 990, bod …990)
  // P1 s trhem: segment nesedí → S1 → 12 990
  const { db, p1 } = baseDb();
  const p5 = insProduct(db, { code: 'KOLO-5', name: 'Author Solution', manufacturer: 'Author', msrp: 15990 });
  const seg = insSegment(db, 'Bez konkurence', { field: 'market_count', op: '=', value: 0 });
  const sMsrp = insStrategy(db, 'Bez konkurence → MOC', cfg({ target: { mode: 'msrp' }, limits: { max_increase_pct: null } }), { priority: 10, segment_id: seg });
  const s1 = insStrategy(db, 'S1', cfg(S1CFG), { priority: 20 });
  const res = RUN().runPricing(db, { now: NOW, productIds: [p1, p5] });
  const props = proposalsOf(db, res.run_id);
  assert.deepStrictEqual(props.map((p) => [p.product_id, p.strategy_id, p.new_price]), [
    [p1, s1, 12990],
    [p5, sMsrp, 15990],
  ]);
  assert.strictEqual(props[1].segment_id, seg);
});

test('runPricing: vypršelý zámek (locked_until v minulosti) → produkt se přeceňuje', () => {
  const { db, p3 } = baseDb();
  db.prepare('UPDATE products SET locked = 1, locked_until = ? WHERE id = ?').run(daysAgo(1), p3);
  insStrategy(db, 'S1', cfg(S1CFG));
  const res = RUN().runPricing(db, { now: NOW, productIds: [p3] });
  // P3: 9 990, nákup 5 000, trh VM 9 490 → −1 % = 9 395,1 ; floor 20 % = 5000/0,8×1,21 = 7 562,5 ;
  // pokles max 10 % → 8 991 ; pásmo ≤ 10 000 (…90) dolů → 9 390 ; −600 / 9 990 = −6,01 % → big_change → pending
  assert.ok(!res.stats.skipped.locked);
  const [p] = proposalsOf(db, res.run_id);
  assert.strictEqual(p.product_id, p3);
  assert.strictEqual(p.new_price, 9390);
  assert.strictEqual(p.status, 'pending');
});

test('runPricing: zámek s locked_until v budoucnu → skip locked', () => {
  const { db, p3 } = baseDb();
  db.prepare('UPDATE products SET locked = 1, locked_until = ? WHERE id = ?').run(daysAhead(3), p3);
  insStrategy(db, 'S1', cfg(S1CFG));
  const res = RUN().runPricing(db, { now: NOW, productIds: [p3] });
  assert.strictEqual(res.stats.skipped.locked, 1);
  assert.strictEqual(proposalsOf(db, res.run_id).length, 0);
});

test('runPricing: neaktivní produkt se nepřeceňuje ani při explicitním productIds', () => {
  // SPEC-AMBIGUOUS: „A run evaluates all active products“ + productIds jako filtr → neaktivní ani na vyžádání
  // (konzervativně: cena vyřazeného produktu se neexportuje).
  const { db, p4 } = baseDb();
  insStrategy(db, 'S1', cfg(S1CFG));
  const res = RUN().runPricing(db, { now: NOW, productIds: [p4] });
  assert.strictEqual(proposalsOf(db, res.run_id).length, 0);
});

test('runPricing: výkon – 30 000 produktů × 8 konkurentů pod 5 s (SPEC §10)', () => {
  const db = openDb(':memory:');
  const comps = [];
  for (let c = 0; c < 8; c++) comps.push(insCompetitor(db, `Konkurent-${c}.cz`));
  const insP = db.prepare(
    `INSERT INTO products (code, code_key, name, manufacturer, purchase_price, price, vat_rate, msrp, stock, sales_30, attrs, active, locked, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 21, ?, 3, 1, '{"N":"N2"}', 1, 0, ?, ?)`
  );
  const insO = db.prepare('INSERT INTO offers (product_id, competitor_id, price, in_stock, observed_at, first_seen_at) VALUES (?, ?, ?, 1, ?, ?)');
  const obs = daysAgo(1);
  db.exec('BEGIN');
  for (let i = 1; i <= 30000; i++) {
    const base = 1000 + (i % 500) * 50;
    const id = Number(insP.run(`P${i}`, `P${i}`, `Produkt ${i}`, `Výrobce ${i % 40}`, base * 0.5, base, base * 1.1, obs, obs).lastInsertRowid);
    for (let c = 0; c < 8; c++) insO.run(id, comps[c], base * (0.9 + c * 0.03), obs, obs);
  }
  db.exec('COMMIT');
  insStrategy(db, 'Výchozí', cfg({ target: { mode: 'market_median', offset_pct: -2 }, limits: { min_margin_pct: 12 } }));
  const t0 = Date.now();
  const res = RUN().runPricing(db, { now: NOW });
  const ms = Date.now() - t0;
  assert.strictEqual(res.stats.products, 30000);
  assert.ok(ms < 5000, `běh trval ${ms} ms`);
});

test('runPricing: neplatný filtr segmentu nesmí strategii rozšířit na celý katalog', () => {
  // Konzervativně: segment, který nejde zkompilovat, neodpovídá ničemu (nebo běh selže) – nikdy „vše“.
  const { db } = baseDb();
  const bad = insSegment(db, 'Rozbitý', { field: 'manufacturer', op: 'like', value: 'Scott' });
  const s = insStrategy(db, 'Na rozbitém segmentu', cfg({ target: { mode: 'fixed', fixed_price: 9990 }, limits: { max_decrease_pct: null } }), { segment_id: bad });
  let res;
  try {
    res = RUN().runPricing(db, { now: NOW });
  } catch {
    return; // selhání běhu je přijatelné
  }
  if (res.run_id != null) assert.ok(!proposalsOf(db, res.run_id).some((p) => p.strategy_id === s), 'rozbitý segment přecenil produkty');
  assert.strictEqual(res.stats.changes, 0);
});

test('runPricing: neplatné conditions strategie nesmí strategii rozšířit na vše', () => {
  const { db } = baseDb();
  const s = insStrategy(db, 'Rozbité podmínky', cfg({ conditions: { any: 'nesmysl' }, target: { mode: 'fixed', fixed_price: 9990 }, limits: { max_decrease_pct: null } }));
  let res;
  try {
    res = RUN().runPricing(db, { now: NOW });
  } catch {
    return;
  }
  if (res.run_id != null) assert.ok(!proposalsOf(db, res.run_id).some((p) => p.strategy_id === s), 'rozbité conditions přecenily produkty');
});

test('runPricing: nastavení offer_max_age_days z DB se použije pro stáří nabídek', () => {
  // setting 3 dny ; VeloMarket u P1 je 5 dní starý → vyřazen → trh KS 13 200 + BS 14 000
  // 13 200 × 0,99 = 13 068 → dolů 12 990 (≥ floor 12 100, ≥ 12 141) → 12 990 ; competitor_count 2, market_min 13 200
  const { db, p1, vm } = baseDb();
  require('../src/db.js').setSetting(db, 'offer_max_age_days', 3);
  db.prepare('UPDATE offers SET observed_at = ? WHERE product_id = ? AND competitor_id = ?').run(daysAgo(5), p1, vm);
  insStrategy(db, 'S1', cfg(S1CFG));
  const res = RUN().runPricing(db, { now: NOW, productIds: [p1] });
  const [p] = proposalsOf(db, res.run_id);
  assert.strictEqual(p.competitor_count, 2);
  assert.strictEqual(p.market_min, 13200);
  assert.strictEqual(p.new_price, 12990);
});
