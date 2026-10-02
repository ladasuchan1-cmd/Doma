'use strict';
// Nacenění na malé syntetické databázi (deterministické): trénink, odhad, srovnatelné, kalibrace, zápis do DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb, parseJson } = require('../src/db');
const pricing = require('../src/pricing');

// [značka, tier, model, typ, cena nového]
const MODELS = [
  ['Trek', 4, 'Slash 8', 'mtb_full', 90000],
  ['Trek', 4, 'Marlin 7', 'mtb_hardtail', 30000],
  ['Specialized', 4, 'Stumpjumper Comp', 'mtb_full', 100000],
  ['Author', 2, 'Traction', 'mtb_hardtail', 20000],
  ['Author', 2, 'Solution', 'mtb_hardtail', 15000],
  ['Superior', 3, 'XC 879', 'mtb_hardtail', 22000],
  ['Woom', 5, '4', 'kids', 12000],
  ['Rock Machine', 2, 'Thunder', 'kids', 7000],
  ['Giant', 3, 'TCR Advanced 2', 'road', 55000],
  ['Kellys', 3, 'Phanatic 30', 'cross', 18000],
];
const truth = (newP, age, cond = 1) => newP * 0.8 * Math.pow(0.88, age) * cond;

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

function synthRows(n = 420, seed = 1) {
  const rnd = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const rows = [];
  for (let i = 0; i < n; i++) {
    const [brand, tier, model, type, newP] = MODELS[i % MODELS.length];
    const age = Math.floor(rnd() * 9);
    const year = 2026 - age;
    const price = Math.round(truth(newP, age) * Math.exp(0.15 * gauss()) / 100) * 100;
    rows.push({
      id: i + 1,
      source: 'bazos',
      url: `https://example.cz/${i + 1}`,
      title: `${brand} ${model} ${year}`,
      price_czk: price,
      is_bike: 1,
      bike_type: type,
      features: { brand, brandTier: tier, model, modelYear: year, ageYears: age, ...(type === 'kids' ? { kidsWheel: model === '4' ? '20' : '24' } : {}) },
    });
  }
  return rows;
}

function insertRows(db, rows) {
  const ins = db.prepare(
    `INSERT INTO listings (id, source, source_id, url, title, price_czk, is_bike, bike_type, features, content_hash, first_seen_at, last_seen_at, photo_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', ?)`
  );
  for (const r of rows) ins.run(r.id, r.source, String(r.id), r.url, r.title, r.price_czk, r.is_bike, r.bike_type, JSON.stringify(r.features), `h${r.id}`, `https://img.example.cz/${r.id}.jpg`);
}

const item = (title, type, features, price = null) => ({ title, bike_type: type, is_bike: 1, price_czk: price, features });

test('model se naučí na syntetických datech a odhaduje rozumně', () => {
  const model = pricing.trainFromRows(synthRows(), { sales: [] });
  assert.equal(model.mode, 'model');
  assert.equal(model.summary.trained, 420);
  assert.equal(model.calibration.factor, 0.9); // bez prodejů = apriorní askToSale
  const e = pricing.estimate(model, item('Trek Slash 8 2022', 'mtb_full', { brand: 'Trek', brandTier: 4, model: 'Slash 8', modelYear: 2022, ageYears: 4 }));
  const expected = truth(90000, 4) * 0.9;
  assert.ok(Math.abs(e.estCzk / expected - 1) < 0.2, `odhad ${e.estCzk} vs ${Math.round(expected)}`);
  assert.ok(e.low < e.estCzk && e.estCzk < e.high);
  assert.ok(e.confidence > 0 && e.confidence <= 0.95);
  assert.equal(e.method, 'comps');
  assert.ok(e.factors.some((f) => /^Podobné inzeráty \(\d+×\): medián [\d ]+ Kč$/.test(f)), e.factors.join(' | '));
  assert.ok(e.factors.some((f) => f === 'Rok 2022 → stáří 4 roky'));
  assert.ok(e.factors.some((f) => /^Kalibrace na vlastní prodeje obchodu: ×0,90$/.test(f)));
  // starší = levnější, lepší stav = dražší
  const old = pricing.estimate(model, item('Trek Slash 8 2018', 'mtb_full', { brand: 'Trek', brandTier: 4, model: 'Slash 8', modelYear: 2018, ageYears: 8 }));
  assert.ok(old.estCzk < e.estCzk);
  const kids = pricing.estimate(model, item('Woom 4 2024', 'kids', { brand: 'Woom', brandTier: 5, model: '4', modelYear: 2024, ageYears: 2, kidsWheel: '20' }));
  assert.ok(Math.abs(kids.estCzk / (truth(12000, 2) * 0.9) - 1) < 0.25, `woom ${kids.estCzk}`);
});

test('trénink je deterministický', () => {
  const rows = synthRows(300, 7);
  const it = item('Author Traction 2023', 'mtb_hardtail', { brand: 'Author', brandTier: 2, model: 'Traction', modelYear: 2023, ageYears: 3 });
  const a = pricing.estimate(pricing.trainFromRows(rows, { sales: [] }), it);
  const b = pricing.estimate(pricing.trainFromRows(rows, { sales: [] }), it);
  assert.deepEqual(a, b);
});

test('placeholder ceny se do tréninku nepočítají', () => {
  const rows = synthRows(400, 3);
  rows.push({ ...rows[0], id: 9001, price_czk: 1 }, { ...rows[1], id: 9002, price_czk: 123456 }, { ...rows[2], id: 9003, price_czk: 99999999 });
  rows.push({ ...rows[3], id: 9004, features: { ...rows[3].features, isMulti: true } });
  const model = pricing.trainFromRows(rows, { sales: [] });
  assert.equal(model.summary.trained, 400);
  assert.equal(model.summary.bikes, 404);
  for (const p of [null, 0, 1, 99, 123456, 1234, 99999999]) assert.equal(pricing.isPlaceholderPrice(p), true, String(p));
  for (const p of [300, 4500, 25000]) assert.equal(pricing.isPlaceholderPrice(p), false, String(p));
});

test('málo dat → pravidla z kb.json (a srovnatelné z cen)', () => {
  const model = pricing.trainFromRows(synthRows(60, 5), { sales: [] });
  assert.equal(model.mode, 'rules');
  const e = pricing.estimate(model, item('Kellys Phanatic 30 2023', 'cross', { brand: 'Kellys', brandTier: 3, model: 'Phanatic 30', modelYear: 2023, ageYears: 3 }));
  assert.ok(['rules', 'comps'].includes(e.method));
  assert.ok(e.estCzk > 3000 && e.estCzk < 30000, String(e.estCzk));
  assert.ok(e.confidence <= 0.4);
  const r = pricing.estimate(model, item('Kolo Author', 'mtb_hardtail', { brand: 'Author', brandTier: 2 }));
  assert.equal(r.method, 'rules');
  assert.ok(r.factors.some((f) => /pravidel/.test(f)));
  // původní cena z textu se v pravidlech projeví
  const withOrig = pricing.rulesEstimate(pricing.normItem(item('Kolo', 'mtb_hardtail', { brandTier: 2, originalPriceCzk: 60000, ageYears: 1 })));
  const noOrig = pricing.rulesEstimate(pricing.normItem(item('Kolo', 'mtb_hardtail', { brandTier: 2, ageYears: 1 })));
  assert.ok(withOrig.value > noOrig.value * 1.8);
  assert.ok(withOrig.factors.includes('Původní cena 60 000 Kč (z textu)'));
});

test('kalibrace na vlastní prodeje: posun k realizovaným cenám, oříznutá', () => {
  const rows = synthRows();
  const sale = (title, price) => ({ kind: 'bazar', title, priceCzk: price, costCzk: Math.round(price * 0.6) });
  // obchod prodává za ~70 % odhadu (vzhledem k inzerovaným cenám)
  const base = pricing.trainFromRows(rows, { sales: [], oof: false });
  const asking = (t) => Math.exp(pricing._internal.askingLog(base, pricing.normItem(t)).lp);
  const titles = ['Trek Slash 8 celoodpružené horské kolo', 'Author Traction horské kolo', 'Woom 4 dětské kolo', 'Giant TCR Advanced 2 silniční kolo', 'Kellys Phanatic 30 krosové kolo', 'Superior XC 879 horské kolo'];
  const { classifyListing } = require('../src/classify');
  const sales = titles.map((t) => {
    const c = classifyListing({ title: t });
    return sale(t, Math.round(asking({ title: t, features: c.features, bike_type: c.bikeType, is_bike: 1 }) * 0.7));
  });
  const m = pricing.trainFromRows(rows, { sales, oof: false });
  assert.equal(m.calibration.n, 6);
  assert.ok(Math.abs(m.calibration.shopRatio - 0.7) < 0.05, String(m.calibration.shopRatio));
  assert.ok(m.calibration.factor < 0.9 && m.calibration.factor > 0.7, String(m.calibration.factor));
  assert.ok(Math.abs(m.buyRatio - 0.6) < 0.01);
  // extrémní poměr → oříznutí na kb.calibration.min
  const crazy = sales.map((s) => ({ ...s, priceCzk: Math.round(s.priceCzk * 0.15) }));
  const m2 = pricing.trainFromRows(rows, { sales: [...crazy, ...crazy], oof: false });
  assert.equal(m2.calibration.factor, 0.6);
  // KOLOMAPA_BUY_MARGIN má přednost před prodeji
  const m3 = pricing.trainFromRows(rows, { sales, oof: false, config: { buyMargin: 0.4 } });
  assert.equal(m3.buyRatio, 0.6);
});

test('priceAll zapíše est_*, deal_ratio, max_buy_czk; nekola vyčistí; placeholder bez deal_ratio', () => {
  const db = openDb(':memory:');
  const rows = synthRows(400, 11);
  rows.push({ id: 5001, source: 'bazos', url: 'https://example.cz/5001', title: 'Trek Slash 8 2022', price_czk: 1, is_bike: 1, bike_type: 'mtb_full', features: { brand: 'Trek', brandTier: 4, model: 'Slash 8', modelYear: 2022, ageYears: 4, pricePlaceholder: true } });
  rows.push({ id: 5002, source: 'bazos', url: 'https://example.cz/5002', title: 'Helma POC', price_czk: 900, is_bike: 0, bike_type: null, features: {} });
  insertRows(db, rows);
  db.prepare("UPDATE listings SET est_czk = 1234, est_factors = '[\"x\"]' WHERE id = 5002").run();
  db.prepare("INSERT INTO sales (kind, title, price_czk, cost_czk) VALUES ('bazar', 'Trek Slash 8 celoodpružené horské kolo', 40000, 26000)").run();
  const model = pricing.trainModel(db, { config: {}, salesFile: '/neexistuje/prodeje.json' });
  assert.equal(model.mode, 'model');
  assert.equal(model.calibration.n, 1); // prodej z tabulky sales
  const n = pricing.priceAll(db, model, { config: {} });
  assert.equal(n, 401);
  const r = db.prepare('SELECT * FROM listings WHERE id = 1').get();
  assert.ok(r.est_czk > 0 && r.est_low < r.est_czk && r.est_high > r.est_czk);
  assert.ok(['comps', 'model'].includes(r.est_method));
  assert.ok(r.est_confidence > 0 && r.est_confidence < 1);
  assert.ok(Array.isArray(parseJson(r.est_factors)) && parseJson(r.est_factors).every((f) => typeof f === 'string'));
  assert.ok(r.est_at);
  assert.ok(Math.abs(r.deal_ratio - r.price_czk / r.est_czk) < 0.002);
  assert.equal(r.max_buy_czk, pricing.roundCzk(r.est_czk * model.buyRatio));
  const ph = db.prepare('SELECT est_czk, deal_ratio, max_buy_czk FROM listings WHERE id = 5001').get();
  assert.ok(ph.est_czk > 0);
  assert.equal(ph.deal_ratio, null);
  assert.ok(ph.max_buy_czk > 0);
  const nb = db.prepare('SELECT est_czk, est_factors, deal_ratio FROM listings WHERE id = 5002').get();
  assert.deepEqual([nb.est_czk, nb.est_factors, nb.deal_ratio], [null, '[]', null]);
  // výkupní marže z konfigurace
  pricing.priceAll(db, model, { config: { buyMargin: 0.5 } });
  const r2 = db.prepare('SELECT est_czk, max_buy_czk FROM listings WHERE id = 1').get();
  assert.equal(r2.max_buy_czk, pricing.roundCzk(r2.est_czk * 0.5));
});

test('aktuální AI odhad má přednost pro deal_ratio a max_buy_czk (est_* zůstává z modelu)', () => {
  const db = openDb(':memory:');
  insertRows(db, synthRows(400, 13));
  const model = pricing.trainFromRows(db.prepare('SELECT * FROM listings').all(), { sales: [] });
  // AI je aktuální (hash sedí) u id 1, zastaralá u id 2
  db.prepare("UPDATE listings SET ai_czk = 50000, ai_input_hash = content_hash WHERE id = 1").run();
  db.prepare("UPDATE listings SET ai_czk = 50000, ai_input_hash = 'stary' WHERE id = 2").run();
  pricing.priceAll(db, model, {});
  const a = db.prepare('SELECT price_czk, est_czk, deal_ratio, max_buy_czk FROM listings WHERE id = 1').get();
  assert.ok(Math.abs(a.deal_ratio - a.price_czk / 50000) < 0.002);
  assert.equal(a.max_buy_czk, pricing.roundCzk(50000 * model.buyRatio));
  assert.notEqual(a.est_czk, 50000);
  const b = db.prepare('SELECT price_czk, est_czk, deal_ratio FROM listings WHERE id = 2').get();
  assert.ok(Math.abs(b.deal_ratio - b.price_czk / b.est_czk) < 0.002);
  // refreshDeal po uložení AI
  db.prepare("UPDATE listings SET ai_czk = 20000, ai_input_hash = content_hash WHERE id = 2").run();
  const d = pricing.refreshDeal(db, 2, { buyRatio: 0.65 });
  const b2 = db.prepare('SELECT price_czk, deal_ratio, max_buy_czk FROM listings WHERE id = 2').get();
  assert.ok(Math.abs(b2.deal_ratio - b2.price_czk / 20000) < 0.002);
  assert.equal(b2.max_buy_czk, 13000);
  assert.equal(d.maxBuy, 13000);
});

test('srovnatelné inzeráty pro AI a UI', () => {
  const model = pricing.trainFromRows(synthRows(), { sales: [] });
  const comps = pricing.comparables(model, item('Specialized Stumpjumper Comp 2021', 'mtb_full', { brand: 'Specialized', brandTier: 4, model: 'Stumpjumper Comp', modelYear: 2021, ageYears: 5 }), 5);
  assert.equal(comps.length, 5);
  for (const c of comps) {
    assert.match(c.title, /^Specialized Stumpjumper Comp/);
    assert.ok(c.price > 0);
    assert.match(c.url, /^https:\/\/example\.cz\//);
  }
  assert.deepEqual(pricing.comparables(model, item('Kolo', 'other', {}), 5), []);
});

test('loadSales: sjednotí tabulku sales a training/ (stejný prodej jednou, opakované prodeje téhož dne zůstanou)', () => {
  const os = require('node:os');
  const fsx = require('node:fs');
  const pathx = require('node:path');
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'kolomapa-sales-'));
  try {
    const file = pathx.join(dir, 'prodeje.json');
    const sale = (date, title, priceCzk) => ({ kind: 'bazar', date, title, priceCzk });
    fsx.writeFileSync(
      file,
      '\uFEFF' + JSON.stringify({ sales: [sale('2025-03-01', 'Trek Marlin 7', 15000), sale('2026-05-01', 'Kellys Spider 10', 9000), sale('2026-05-01', 'Kellys Spider 10', 9000), { title: 'bez ceny' }] })
    );
    const db = openDb(':memory:');
    // čerstvá DB po importu nového exportu: jen novější prodeje (jeden z nich je i v souboru)
    const ins = db.prepare("INSERT INTO sales (kind, date, title, price_czk) VALUES ('bazar', ?, ?, ?)");
    ins.run('2026-05-01', 'Kellys Spider 10', 9000);
    ins.run('2026-09-01', 'Cube Reaction', 21000);
    const all = pricing.loadSales(db, file);
    assert.deepEqual(all.map((x) => `${x.date} ${x.title}`).sort(), [
      '2025-03-01 Trek Marlin 7',
      '2026-05-01 Kellys Spider 10',
      '2026-05-01 Kellys Spider 10',
      '2026-09-01 Cube Reaction',
    ]);
    assert.equal(pricing.loadSales(db, pathx.join(dir, 'chybi.json')).length, 2, 'bez souboru jen DB');
  } finally {
    fsx.rmSync(dir, { recursive: true, force: true });
  }
});

test('trainModel: ukázková data se z učení vynechají, jakmile jsou v DB skutečné inzeráty', () => {
  const db = openDb(':memory:');
  const rows = synthRows(200, 5);
  insertRows(db, rows);
  const base = pricing.trainModel(db, { config: {}, salesFile: '/neexistuje/prodeje.json' });
  // stejná kola jako demo s nesmyslnými cenami → model se nesmí změnit
  const demo = synthRows(200, 5).map((r, i) => ({ ...r, id: 10000 + i, url: `https://example.cz/demo/${i}`, price_czk: r.price_czk * 10 }));
  insertRows(db, demo);
  db.prepare("UPDATE listings SET params = '{\"demo\":\"1\"}' WHERE id >= 10000").run();
  const withDemo = pricing.trainModel(db, { config: {}, salesFile: '/neexistuje/prodeje.json' });
  const { ms: _a, ...a } = withDemo.summary;
  const { ms: _b, ...b } = base.summary;
  assert.equal(a.bikes, 200);
  assert.deepEqual(a, b);
  // samostatná demo DB (jen ukázková data) se z nich učí, aby ukázka měla odhady
  db.prepare('DELETE FROM listings WHERE id < 10000').run();
  assert.equal(pricing.trainModel(db, { config: {}, salesFile: '/neexistuje/prodeje.json' }).summary.bikes, 200);
});
