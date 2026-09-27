'use strict';
// Cenové skupiny (C3): velikosti / barvy jednoho modelu (products.group_code) dostanou od strategie s group.align
// jednu cenu – nejvyšší / nejnižší / medián výsledných cen členů, v mezích všech členů.

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./engine-helpers');
const { runPricing, simulate, explainProduct } = require('../src/engine/run');
const { alignGroups, groupKey } = require('../src/engine/groups');
const { normalizeConfig } = require('../src/engine/presets');
const { FLAG_LABELS, BLOCKING_FLAGS } = require('../src/engine/pricing');
const engine = require('../src/engine');

const GROUP = 'FOC-JAM-2026';
const BASE = {
  target: { mode: 'undercut_min', offset_pct: -1 },
  limits: { min_margin_pct: 5, max_above_msrp_pct: 0, max_decrease_pct: 20, max_increase_pct: 20 },
  approval: { auto: true, auto_max_change_pct: 3 },
};

/**
 * Model kola ve 3 velikostech (stejná MOC a nákup, různé aktuální ceny i trh):
 *  S 79 990 (trh 80 000 → 78 990), M 76 990 (trh 78 000 → beze změny), L 74 990 (trh 76 000 → beze změny)
 */
function setup({ align = 'max', config = {}, products = {} } = {}) {
  const db = H.createDb();
  const comp = H.insertCompetitor(db, { name: 'VeloMarket.cz' });
  const mk = (code, price, min, extra = {}) => {
    const id = H.insertProduct(db, { code, price, purchase_price: 50000, msrp: 84990, group_code: GROUP, manufacturer: 'Focus', ...extra, ...(products[code] || {}) });
    H.insertOffer(db, id, comp, min);
    return id;
  };
  const ids = { S: mk('JAM-S', 79990, 80000), M: mk('JAM-M', 76990, 78000), L: mk('JAM-L', 74990, 76000) };
  const strategyId = H.insertStrategy(db, { name: 'Pozice', config: { ...BASE, ...config, group: { align } } });
  return { db, comp, ids, strategyId, mk };
}

function proposals(db) {
  const out = {};
  for (const r of db.prepare('SELECT * FROM proposals ORDER BY id').all()) {
    out[r.product_id] = { ...r, flags: JSON.parse(r.flags), explain: JSON.parse(r.explain) };
  }
  return out;
}

test('C3 config: group.align – výchozí off, validace režimu, popisky příznaků', () => {
  assert.deepEqual(normalizeConfig({}).config.group, { align: 'off' });
  for (const align of ['off', 'min', 'max', 'median']) {
    const r = normalizeConfig({ group: { align } });
    assert.deepEqual(r.errors, [], align);
    assert.equal(r.config.group.align, align);
  }
  assert.ok(normalizeConfig({ group: { align: 'nejvyssi' } }).errors.some((e) => /group\.align/.test(e)));
  assert.ok(normalizeConfig({ group: 'max' }).errors.some((e) => /group/.test(e)));
  assert.equal(FLAG_LABELS.group_aligned, 'sjednoceno ve skupině');
  assert.equal(FLAG_LABELS.group_conflict, 'skupinu nelze sjednotit (limity)');
  assert.deepEqual(engine.GROUP_ALIGN_MODES, ['off', 'min', 'max', 'median']);
  assert.equal(typeof engine.alignGroups, 'function');
  // klíč skupiny jako kód: bez mezer, velká písmena; prázdný = žádná skupina
  assert.equal(groupKey({ group_code: ' foc-jam 2026 ' }), groupKey({ group_code: 'FOC-JAM2026' }));
  assert.equal(groupKey({ group_code: '' }), null);
  assert.equal(groupKey({ group_code: null }), null);
  assert.equal(groupKey({}), null);
});

test('C3 přecenění: režim max – všechny velikosti na nejvyšší výslednou cenu, přepočet změny a automatického schválení', () => {
  const { db, ids } = setup({ align: 'max' });
  const r = runPricing(db, { now: H.NOW });
  assert.deepEqual(r.stats.groups, { aligned: 1, conflicts: 0, members: 3 });
  assert.equal(r.stats.changes, 3);
  assert.equal(r.stats.flags.group_aligned, 3);
  const p = proposals(db);
  for (const k of ['S', 'M', 'L']) {
    const x = p[ids[k]];
    assert.ok(x, `návrh pro ${k}`);
    assert.equal(x.new_price, 78990, k);
    assert.ok(x.flags.includes('group_aligned'), k);
    const step = x.explain.find((s) => s.step === 'group');
    assert.ok(step, `${k}: krok vysvětlení skupiny`);
    assert.match(step.text, /^Sjednoceno ve skupině FOC-JAM-2026 \(3 produkty, režim nejvyšší\) → 78\s990 Kč/);
  }
  // S: 79 990 → 78 990 (−1,25 %) a M: 76 990 → 78 990 (+2,6 %) auto; L: +5,33 % = velká změna → ruční schválení
  assert.equal(p[ids.S].status, 'approved');
  assert.equal(p[ids.M].status, 'approved');
  assert.equal(p[ids.M].change_pct, 2.6);
  assert.equal(p[ids.L].status, 'pending');
  assert.ok(p[ids.L].flags.includes('big_change'));
  assert.equal(p[ids.L].change_abs, 4000);
  assert.ok(p[ids.L].margin_after > p[ids.L].margin_before);
  assert.ok(p[ids.L].explain.some((s) => s.step === 'approval' && /velká změna/.test(s.text)));
});

test('C3 přecenění: režim median a min; člen na sjednocené ceně zůstává beze změny', () => {
  {
    const { db, ids } = setup({ align: 'median' });
    const r = runPricing(db, { now: H.NOW });
    assert.deepEqual(r.stats.groups, { aligned: 1, conflicts: 0, members: 3 });
    const p = proposals(db);
    assert.equal(p[ids.S].new_price, 76990);
    assert.equal(p[ids.L].new_price, 76990);
    assert.equal(p[ids.M], undefined, 'M už cenu skupiny má → žádný návrh');
    assert.match(p[ids.S].explain.find((s) => s.step === 'group').text, /režim medián\) → 76\s990 Kč/);
  }
  {
    const { db, ids } = setup({ align: 'min' });
    runPricing(db, { now: H.NOW });
    const p = proposals(db);
    assert.equal(p[ids.S].new_price, 74990);
    assert.equal(p[ids.M].new_price, 74990);
    assert.equal(p[ids.L], undefined);
    assert.match(p[ids.S].explain.find((s) => s.step === 'group').text, /režim nejnižší\)/);
  }
});

test('C3: align off (výchozí) – každá velikost zvlášť', () => {
  const { db, ids } = setup({ align: 'off' });
  const r = runPricing(db, { now: H.NOW });
  assert.deepEqual(r.stats.groups, { aligned: 0, conflicts: 0, members: 0 });
  const p = proposals(db);
  assert.equal(p[ids.S].new_price, 78990);
  assert.equal(p[ids.M], undefined);
  assert.ok(!p[ids.S].flags.includes('group_aligned'));
});

test('C3: sjednocená cena blízko aktuální ceny člena → beze změny (práh minimální změny)', () => {
  // M stojí 78 900 – sjednocená cena 78 990 je o 90 Kč výš, pod prahem 0,5 % → žádný návrh pro M
  const { db, ids } = setup({ align: 'max', products: { 'JAM-M': { price: 78900 } } });
  const r = runPricing(db, { now: H.NOW });
  const p = proposals(db);
  assert.equal(p[ids.M], undefined);
  assert.equal(p[ids.S].new_price, 78990);
  assert.equal(p[ids.L].new_price, 78990);
  assert.ok(r.stats.no_change_reasons.below_threshold >= 1);
});

test('C3: skupina se dělí podle strategií; přeskočený (zamčený) člen drží cenu a je ve vysvětlení', () => {
  const { db, ids, mk } = setup({ align: 'max' });
  // XL: ležák → rozhoduje o něm jiná strategie (vyšší priorita) → do skupiny této strategie nepatří
  const xl = mk('JAM-XL', 69990, 70000, { attrs: { N: 'N8' } });
  const seg = H.insertSegment(db, 'Ležáky', { field: 'attrs.N', op: '=', value: 'N8' });
  H.insertStrategy(db, { name: 'Doprodej', segment_id: seg, priority: 10, config: { target: { mode: 'undercut_min', offset_pct: -5 }, limits: { min_margin_pct: 1, max_decrease_pct: 30 } } });
  // XS: zamčený → skip locked, cenu drží, do výpočtu nejde
  const xs = mk('JAM-XS', 99990, 70000, { locked: 1 });
  const r = runPricing(db, { now: H.NOW });
  assert.deepEqual(r.stats.groups, { aligned: 1, conflicts: 0, members: 3 });
  const p = proposals(db);
  assert.equal(p[ids.S].new_price, 78990, 'max ze S/M/L, zamčená XS (99 990) se nepočítá');
  assert.ok(p[xl], 'XL přeceněna doprodejem');
  assert.notEqual(p[xl].new_price, 78990);
  assert.ok(!p[xl].flags.includes('group_aligned'));
  assert.equal(p[xs], undefined);
  const text = p[ids.S].explain.find((s) => s.step === 'group').text;
  assert.match(text, /1 člen \(JAM-XS – přeskočeno\)/);
  assert.equal(r.stats.skipped.locked, 1);
});

test('C3: limity členů nejdou sjednotit → příznak group_conflict, ceny zůstávají samostatné', () => {
  // L má minimální cenu 90 000 → spodní hranice skupiny je nad MOC (horní hranice 84 990 ostatních)
  const { db, ids } = setup({ align: 'max', products: { 'JAM-L': { min_price: 90000, msrp: 99990 } } });
  const r = runPricing(db, { now: H.NOW });
  assert.deepEqual(r.stats.groups, { aligned: 0, conflicts: 1, members: 0 });
  const p = proposals(db);
  assert.equal(p[ids.S].new_price, 78990, 'S má svou individuální cenu');
  assert.ok(p[ids.S].flags.includes('group_conflict'));
  assert.ok(!p[ids.S].flags.includes('group_aligned'));
  assert.ok(p[ids.L].flags.includes('group_conflict'));
  assert.equal(p[ids.L].new_price, 90990, 'L zvednuta nad svou minimální cenu (nejbližší bod …990)');
  assert.match(p[ids.S].explain.find((s) => s.step === 'group').text, /nelze sjednotit.*ceny zůstávají samostatné/);
  // S (−1,25 %) by se samostatně schválila automaticky (limit 3 %) – s konfliktem skupiny nikdy
  assert.equal(p[ids.S].status, 'pending', 'group_conflict se nikdy neschvaluje automaticky');
  assert.equal(p[ids.S].decided_by, null);
  const approval = p[ids.S].explain.filter((s) => s.step === 'approval');
  assert.equal(approval.length, 1);
  assert.equal(approval[0].text, 'Nutné ruční schválení: skupinu nelze sjednotit (limity)');
  // L už ruční schválení vyžadovala – důvod se připojí
  assert.match(p[ids.L].explain.find((s) => s.step === 'approval').text, /^Nutné ruční schválení: .*velká změna.*, skupinu nelze sjednotit \(limity\)$/);
  assert.equal(r.stats.auto_approved, 0);
  assert.ok(BLOCKING_FLAGS.includes('group_conflict'), 'hromadné „Schválit vše“ návrh s konfliktem skupiny vynechá (RISKY_FLAGS)');
});

test('C3: přecenění vybraných produktů zahrne všechny aktivní členy jejich skupiny', () => {
  const { db, ids } = setup({ align: 'max' });
  const r = runPricing(db, { now: H.NOW, productIds: [ids.L] });
  assert.equal(r.stats.products, 3);
  assert.equal(proposals(db)[ids.L].new_price, 78990);
  // neaktivní člen se nepřidá
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(ids.S);
  const r2 = runPricing(db, { now: H.NOW, productIds: [ids.L], dryRun: true });
  assert.equal(r2.stats.products, 2);
  // bez strategie se sjednocením se výběr nerozšiřuje
  db.prepare("UPDATE strategies SET config = json_set(config, '$.group.align', 'off')").run();
  assert.equal(runPricing(db, { now: H.NOW, productIds: [ids.L], dryRun: true }).stats.products, 1);
});

test('C3: detail produktu (explainProduct) a simulace ukazují sjednocenou cenu', () => {
  const { db, ids } = setup({ align: 'max' });
  const ex = explainProduct(db, ids.L, { now: H.NOW });
  assert.equal(ex.decision.action, 'change');
  assert.equal(ex.decision.new_price, 78990);
  assert.ok(ex.decision.flags.includes('group_aligned'));
  assert.deepEqual(ex.decision.group, { code: GROUP, align: 'max', members: 3, price: 78990, conflict: false });
  assert.ok(ex.decision.explain.some((s) => s.step === 'group'));

  const sim = simulate(db, { config: { ...BASE, group: { align: 'max' } }, now: H.NOW });
  assert.deepEqual(sim.errors, []);
  assert.deepEqual(sim.stats.groups, { aligned: 1, conflicts: 0, members: 3 });
  assert.equal(sim.decisions.length, 3);
  assert.ok(sim.decisions.every((d) => d.new_price === 78990 && d.flags.includes('group_aligned')));
  const simOff = simulate(db, { config: BASE, now: H.NOW });
  assert.equal(simOff.decisions.length, 1);
});

test('C3 alignGroups: cena skupiny se zvedne na spodní hranici členů a zaokrouhlí do intervalu', () => {
  const strategy = { config: { rounding: { mode: 'ending', direction: 'down', bands: [{ up_to: null, ending: 990 }] }, group: { align: 'max' } } };
  const dec = (price, cur, floor, ceiling) => ({
    action: 'change', reason: null, old_price: cur, new_price: price, floor, ceiling, flags: [], explain: [], market: { count: 0, used: [] },
    margin_before: null, margin_after: null, rank_before: null, rank_after: null, change_abs: price - cur, change_pct: 0, auto_approve: false,
  });
  // max 72 000, ale spodní hranice člena A je 75 000 → 75 000 → dolů 74 990 je pod hranicí → nahoru 75 990
  const items = [
    { product: { id: 1, code: 'A', group_code: 'G1' }, decision: dec(70000, 71000, 75000, null), strategy },
    { product: { id: 2, code: 'B', group_code: 'g1' }, decision: dec(72000, 73000, 60000, null), strategy },
  ];
  const out = alignGroups(items, { settings: {} });
  assert.deepEqual(out, { aligned: 1, conflicts: 0, members: 2 });
  for (const it of items) assert.equal(it.decision.new_price, 75990);
  assert.match(items[0].decision.explain.find((s) => s.step === 'group').text, /zvednuto na spodní hranici skupiny 75\s000 Kč/);
  assert.equal(items[0].decision.flags.includes('below_cost'), false);
});

test('C3 alignGroups: mezi hranicemi skupiny není cenový bod → nezaokrouhlená cena v celých korunách', () => {
  const strategy = { config: { rounding: { mode: 'ending', direction: 'down', bands: [{ up_to: null, ending: 990 }] }, group: { align: 'max' } } };
  const dec = (price, cur, floor, ceiling) => ({
    action: 'change', reason: null, old_price: cur, new_price: price, floor, ceiling, flags: [], explain: [], market: { count: 0, used: [] },
    margin_before: null, margin_after: null, rank_before: null, rank_after: null, change_abs: 0, change_pct: 0, auto_approve: false,
  });
  // interval [78 200, 78 500] – body …990 (77 990 / 78 990) leží mimo → 78 300 (max) bez zaokrouhlení
  const items = [
    { product: { id: 1, code: 'A', group_code: 'G' }, decision: dec(78100.4, 80000, 78200, 90000), strategy },
    { product: { id: 2, code: 'B', group_code: 'G' }, decision: dec(78300.4, 80000, 70000, 78500), strategy },
  ];
  alignGroups(items, { settings: {} });
  for (const it of items) assert.equal(it.decision.new_price, 78300);
  assert.match(items[1].decision.explain.find((s) => s.step === 'group').text, /není cenový bod → bez zaokrouhlení/);
  // členové různých strategií se nesjednocují; skupina s jediným členem také ne
  const other = { config: { group: { align: 'max' } } };
  const solo = [
    { product: { id: 3, code: 'C', group_code: 'H' }, decision: dec(1000, 1100, null, null), strategy },
    { product: { id: 4, code: 'D', group_code: 'H' }, decision: dec(2000, 2100, null, null), strategy: other },
  ];
  assert.deepEqual(alignGroups(solo, {}), { aligned: 0, conflicts: 0, members: 0 });
  assert.equal(solo[0].decision.new_price, 1000);
});

test('C3: sjednocená cena mimo limit změny člena → upozornění a nikdy automatické schválení', () => {
  // L 74 990 → 78 990 = +5,33 % > max. zvýšení 5 %; automatické schválení až do 10 %
  const { db, ids } = setup({ align: 'max', config: { limits: { ...BASE.limits, max_increase_pct: 5 }, approval: { auto: true, auto_max_change_pct: 10 } } });
  runPricing(db, { now: H.NOW });
  const p = proposals(db);
  assert.equal(p[ids.L].new_price, 78990);
  assert.equal(p[ids.L].status, 'pending');
  assert.ok(p[ids.L].explain.some((s) => s.step === 'warning' && /mimo limit změny/.test(s.text)));
  assert.ok(p[ids.L].explain.some((s) => s.step === 'approval' && /mimo limit změny strategie/.test(s.text)));
  assert.equal(p[ids.M].status, 'approved', 'M (+2,6 %) je v limitu → automaticky');
  assert.ok(!p[ids.M].explain.some((s) => s.step === 'warning'));
});

test('C3 demo data: velikosti jednoho modelu kola sdílí group_code (stejná MOC); předvolba klíčových značek sjednocuje na max', () => {
  const { generateDemo, seedDatabase } = require('../tools/demo-data');
  const { STRATEGY_PRESETS } = require('../src/engine/presets');
  const demo = generateDemo({ products: 400, seed: 3, now: new Date(H.NOW) });
  const groups = new Map();
  for (const p of demo.products) {
    if (/kola$|Gravel/.test(p.category)) assert.ok(p.group_code, `${p.code}: kolo má skupinu`);
    else assert.equal(p.group_code, null, `${p.code}: díly skupinu nemají`);
    if (!p.group_code) continue;
    const list = groups.get(p.group_code) || [];
    list.push(p);
    groups.set(p.group_code, list);
  }
  assert.ok([...groups.values()].some((l) => l.length >= 2), 'aspoň jedna skupina s více velikostmi');
  for (const [code, list] of groups) {
    assert.match(code, /^[A-Z]{3}-[A-Z0-9-]+-20\d\d(-\d+)?$/);
    assert.equal(new Set(list.map((p) => p.msrp)).size, 1, `${code}: jedna MOC`);
    assert.equal(new Set(list.map((p) => p.manufacturer)).size, 1, `${code}: jeden výrobce`);
    // velikosti jednoho modelu mají stejný nákup; prodejní cena stejná, nanejvýš jedna velikost ve vlastní slevě
    assert.equal(new Set(list.map((p) => p.purchase_price)).size, 1, `${code}: jeden nákup`);
    assert.ok(new Set(list.map((p) => p.price)).size <= 2, `${code}: ceny velikostí ${list.map((p) => p.price)}`);
  }
  // ukázkový katalog nese skupinu ve sloupci „Model“ (alias kanonického pole group_code)
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { writeExampleFiles } = require('../tools/demo-data');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cenotvorba-ex-'));
  try {
    writeExampleFiles(dir, demo);
    const head = fs.readFileSync(path.join(dir, 'katalog.csv'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0].split(';');
    assert.ok(head.includes('Model'), head.join(';'));
    const { suggestMapping } = require('../src/import');
    assert.equal(suggestMapping(head, 'products').fields.group_code, 'Model');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const preset = STRATEGY_PRESETS.find((p) => p.key === 'key_brands_rank2');
  assert.equal(preset.name, 'Klíčové značky – držet pozici 2');
  assert.equal(preset.config.group.align, 'max');
  // naplnění databáze + přecenění: bez konfliktů skupin
  const db = H.createDb();
  seedDatabase(db, demo, { now: new Date(H.NOW) });
  const r = runPricing(db, { now: H.NOW, dryRun: true });
  assert.ok(r.stats.groups.aligned > 0);
  assert.equal(r.stats.groups.conflicts, 0);
});

test('C3 simulace v kontextu: stats.groups počítá jen skupiny simulované strategie', () => {
  // dřívější strategie (priorita 10, align max) sjednotí skupinu FOC-JAM-2026; simulovaná (align off) nic nesjednocuje
  const { db, strategyId, mk } = setup({ align: 'max' });
  const focus = H.insertSegment(db, 'Focus', { field: 'manufacturer', op: '=', value: 'Focus' });
  db.prepare('UPDATE strategies SET priority = 10, segment_id = ? WHERE id = ?').run(focus, strategyId);
  const seg = H.insertSegment(db, 'Kellys', { field: 'manufacturer', op: '=', value: 'Kellys' });
  const later = H.insertStrategy(db, { name: 'Kellys', segment_id: seg, priority: 20, config: { ...BASE, group: { align: 'off' } } });
  mk('K-1', 20990, 20000, { manufacturer: 'Kellys', group_code: 'KEL-GATOR-2026', msrp: 22990, purchase_price: 12000 });
  mk('K-2', 21990, 20500, { manufacturer: 'Kellys', group_code: 'KEL-GATOR-2026', msrp: 22990, purchase_price: 12000 });
  const off = simulate(db, { strategy_id: later, now: H.NOW });
  assert.deepEqual(off.errors, []);
  assert.equal(off.context, true);
  assert.deepEqual(off.stats.groups, { aligned: 0, conflicts: 0, members: 0 }, 'dřívější strategie se simulované nepřičítá');
  assert.ok(off.decisions.every((d) => !d.flags.includes('group_aligned')));
  // simulovaná strategie se sjednocením → jen její skupina
  const on = simulate(db, { strategy_id: later, config: { ...BASE, group: { align: 'max' } }, now: H.NOW });
  assert.deepEqual(on.stats.groups, { aligned: 1, conflicts: 0, members: 2 });
  assert.ok(on.decisions.every((d) => d.group && d.group.code === 'KEL-GATOR-2026'));
  // a sama dřívější strategie v kontextu hlásí svou skupinu
  assert.deepEqual(simulate(db, { strategy_id: strategyId, now: H.NOW }).stats.groups, { aligned: 1, conflicts: 0, members: 3 });
});

test('C3 peníze: sjednocená cena nikdy pod spodní hranicí ani nad horní hranicí žádného člena, konflikt nikdy auto', () => {
  // náhodné skupiny (deterministický generátor) – vlastnosti musí platit pro každé sjednocení
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const roundings = [
    { mode: 'ending', direction: 'down', bands: [{ up_to: 1000, ending: 9 }, { up_to: null, ending: 990 }] },
    { mode: 'ending', direction: 'up', bands: [{ up_to: null, ending: 90 }] },
    { mode: 'ending', direction: 'nearest', bands: [{ up_to: null, ending: 990 }] },
    { mode: 'integer', direction: 'down' },
    { mode: 'none', direction: 'down' },
  ];
  let aligned = 0;
  let conflicts = 0;
  for (let iter = 0; iter < 400; iter++) {
    const align = ['min', 'max', 'median'][iter % 3];
    const strategy = { config: { rounding: roundings[iter % roundings.length], approval: { auto: true, auto_max_change_pct: 50 }, limits: { max_increase_pct: 30, max_decrease_pct: 30 }, group: { align } } };
    const n = 2 + Math.floor(rand() * 4);
    const items = [];
    for (let i = 0; i < n; i++) {
      const cur = Math.round(5000 + rand() * 20000);
      const floor = rand() < 0.8 ? Math.round((cur * (0.7 + rand() * 0.3)) * 100) / 100 : null;
      const ceiling = rand() < 0.6 ? Math.round((cur * (1 + rand() * 0.3)) * 100) / 100 : null;
      const change = rand() < 0.7;
      let price = change ? Math.round(cur * (0.85 + rand() * 0.3)) : cur;
      if (floor != null && price < floor) price = Math.ceil(floor);
      if (ceiling != null && price > ceiling && (floor == null || Math.floor(ceiling) >= floor)) price = Math.floor(ceiling);
      items.push({
        product: { id: i + 1, code: `P${i}`, group_code: 'G', purchase_price: null, vat_rate: 21 },
        strategy,
        decision: {
          action: change && price !== cur ? 'change' : 'no_change', reason: change && price !== cur ? null : 'same_price',
          old_price: cur, new_price: price, floor, ceiling, flags: [], market: { count: 0, used: [] },
          explain: [{ step: 'approval', text: 'Automaticky schváleno' }], auto_approve: change && price !== cur,
          margin_before: null, margin_after: null, rank_before: null, rank_after: null, change_abs: price - cur, change_pct: ((price - cur) / cur) * 100,
        },
      });
    }
    const floors = items.map((x) => x.decision.floor).filter((v) => v != null);
    const ceilings = items.map((x) => x.decision.ceiling).filter((v) => v != null);
    const lo = floors.length ? Math.max(...floors) : null;
    const hi = ceilings.length ? Math.min(...ceilings) : null;
    const out = alignGroups(items, { settings: {} });
    if (out.conflicts) {
      conflicts += 1;
      assert.ok(lo != null && hi != null && lo > hi, `iterace ${iter}: konflikt jen při prázdném intervalu`);
      for (const { decision: d } of items) {
        assert.equal(d.auto_approve, false, `iterace ${iter}: konflikt skupiny nikdy auto`);
        assert.ok(d.flags.includes('group_conflict'));
      }
      continue;
    }
    assert.equal(out.aligned, 1, `iterace ${iter}`);
    aligned += 1;
    const gp = items[0].decision.group.price;
    if (lo != null) assert.ok(gp >= lo - 1e-9, `iterace ${iter}: cena skupiny ${gp} pod spodní hranicí ${lo}`);
    if (hi != null) assert.ok(gp <= hi + 1e-9, `iterace ${iter}: cena skupiny ${gp} nad horní hranicí ${hi}`);
    for (const { decision: d } of items) {
      const res = d.action === 'change' ? d.new_price : d.old_price;
      // člen s cenou (výsledná cena) – nikdy pod svou spodní / nad svou horní hranicí
      if (d.floor != null) assert.ok(res >= d.floor - 1e-9, `iterace ${iter}: ${res} pod spodní hranicí člena ${d.floor}`);
      if (d.ceiling != null && d.action === 'change') assert.ok(res <= d.ceiling + 1e-9, `iterace ${iter}: ${res} nad horní hranicí člena ${d.ceiling}`);
      if (d.action === 'change') assert.equal(d.new_price, gp);
      if (d.auto_approve) assert.ok(Math.abs(d.new_price - d.old_price) <= d.old_price * 0.3 + 0.01, `iterace ${iter}: auto-schválení jen v limitu změny`);
    }
  }
  assert.ok(aligned > 100 && conflicts > 5, `pokrytí: ${aligned} sjednocení, ${conflicts} konfliktů`);
});
