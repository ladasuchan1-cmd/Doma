'use strict';
// Regresní testy „peněžních“ pojistek životního cyklu návrhu (nálezy money-1 … money-9, ops-1, ops-4).
// Výchozí stav: BIKE-1 za 10 000 Kč (nákup 6 000 bez DPH), jediná nabídka 9 700 Kč, strategie „podstřel minimum −1 %“
// s automatickým schválením do 5 % → přecenění vytvoří automaticky schválený návrh 9 603 Kč.

const test = require('node:test');
const assert = require('node:assert');
const H = require('./api-routes-helpers');
const { runPricing } = require('../src/engine/run');
const { pushChanges, markExported } = require('../src/export/apply');
const { exportRowsDetailed } = require('../src/export/rows');

const CONFIG = {
  target: { mode: 'undercut_min', offset_pct: -1 },
  limits: { min_margin_pct: 5, max_decrease_pct: 20, max_increase_pct: 20, max_above_msrp_pct: null, min_change_pct: 0, min_change_abs: 1 },
  rounding: { mode: 'integer', direction: 'down' },
  approval: { auto: true, auto_max_change_pct: 5 },
};

async function setup(t, { auto = true } = {}) {
  const app = await H.startApp();
  t.after(() => app.stop());
  const db = app.db;
  const comp = H.insertCompetitor(db, 'VeloMarket.cz');
  const pid = H.insertProduct(db, { code: 'BIKE-1', name: 'Kolo', purchase_price: 6000, price: 10000, vat_rate: 21 });
  const other = H.insertProduct(db, { code: 'BIKE-2', name: 'Kolo 2', purchase_price: 6000, price: 10000, vat_rate: 21 });
  H.insertOffer(db, pid, comp, 9700);
  H.insertStrategy(db, { name: 'Podstřel', config: { ...CONFIG, approval: { auto, auto_max_change_pct: 5 } } });
  const s = app.session();
  const exp = app.token(['export']);
  const run = async () => {
    const r = await s.post('/api/v1/runs', {});
    assert.equal(r.status, 200, r.text);
    return r.json;
  };
  const proposal = (id) => db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  const open = () => db.prepare("SELECT * FROM proposals WHERE product_id = ? AND status IN ('pending', 'approved') ORDER BY id").all(pid);
  const price = () => db.prepare('SELECT price FROM products WHERE id = ?').get(pid).price;
  const feed = async () => {
    const r = await exp.get('/api/v1/export/changes.json');
    assert.equal(r.status, 200, r.text);
    return r;
  };
  await run();
  const [first] = open();
  assert.equal(first.status, auto ? 'approved' : 'pending');
  assert.equal(first.new_price, 9603);
  return { app, db, s, exp, pid, other, comp, run, proposal, open, price, feed, first };
}

test('money-1: zámek po automatickém schválení – návrh se neexportuje (feed, POHODA, ack)', async (t) => {
  const c = await setup(t);
  const r = await c.s.patch(`/api/v1/products/${c.pid}`, { locked: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(c.proposal(c.first.id).status, 'superseded', 'zámek zneplatní otevřený návrh');
  const f = await c.feed();
  assert.equal(f.json.count, 0);
  assert.equal((await c.exp.get('/api/v1/export/pohoda.xml')).status, 409);
  const ack = await c.exp.post('/api/v1/export/ack', { codes: ['BIKE-1'] });
  assert.equal(ack.json.count, 0);
  assert.equal(c.price(), 10000);
});

test('money-1: zámek nastavený mimo API (starší data) – export návrh zadrží, mark ani ack ho neoznačí', async (t) => {
  const c = await setup(t);
  c.db.prepare('UPDATE products SET locked = 1 WHERE id = ?').run(c.pid);
  const f = await c.exp.get('/api/v1/export/changes.json?mark=1');
  assert.equal(f.json.count, 0);
  assert.equal(f.headers.get('x-export-held'), '1');
  const detailed = exportRowsDetailed(c.db);
  assert.equal(detailed.held[0].reason, 'locked');
  const ack = await c.exp.post('/api/v1/export/ack', { proposal_ids: [c.first.id] });
  assert.equal(ack.json.count, 0);
  assert.equal(ack.json.skipped[0].reason, 'locked');
  assert.equal(c.proposal(c.first.id).status, 'approved');
  assert.equal(c.price(), 10000);
  const px = await c.exp.get('/api/v1/export/pohoda.xml');
  assert.equal(px.status, 409);
  assert.ok(px.json.error.details.skipped.some((x) => x.reason === 'held_locked'));
});

test('money-2: ruční změna ceny produktu zneplatní návrh; feed nevrátí starou cenu ani po mark', async (t) => {
  const c = await setup(t);
  const r = await c.s.patch(`/api/v1/products/${c.pid}`, { price: 8490 });
  assert.equal(r.status, 200, r.text);
  assert.equal(c.proposal(c.first.id).status, 'superseded');
  const f = await c.exp.get('/api/v1/export/changes.json?mark=1');
  assert.equal(f.json.count, 0);
  assert.equal(c.price(), 8490, 'ruční cena zůstává');
});

test('money-2: změna ceny v DB bez zneplatnění (starší data) → řádek zadržen s důvodem price_changed', async (t) => {
  const c = await setup(t);
  c.db.prepare('UPDATE products SET price = 7990 WHERE id = ?').run(c.pid);
  const { rows, held } = exportRowsDetailed(c.db);
  assert.equal(rows.length, 0);
  assert.deepEqual(held.map((h) => h.reason), ['price_changed']);
  // úplný ceník: místo zadrženého návrhu aktuální cena
  const all = exportRowsDetailed(c.db, { scope: 'all' }).rows.find((x) => x.code === 'BIKE-1');
  assert.equal(all.price, 7990);
  assert.equal(all.proposal_id, null);
});

test('money-2/3: import katalogu s novou cenou / nákupní cenou zneplatní návrh; stejná cena (admin převzal) ho ponechá', async (t) => {
  const c = await setup(t);
  const imp = c.app.token(['import']);
  // cena z katalogu = cena návrhu (admin ji už nasadil) → návrh zůstává a lze potvrdit převzetí
  let r = await imp.post('/api/v1/import/products', 'code;price;purchase_price\nBIKE-1;9603;6000\n', { headers: { 'Content-Type': 'text/csv' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(c.proposal(c.first.id).status, 'approved');
  assert.equal((await c.feed()).json.count, 1, 'návrh s cenou rovnou aktuální ceně jde dál (idempotentní)');
  // vyšší nákupní cena → cena návrhu je pod nákladem → návrh se zneplatní
  r = await imp.post('/api/v1/import/products', 'code;price;purchase_price\nBIKE-1;9603;9000\n', { headers: { 'Content-Type': 'text/csv' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.stats.superseded, 1);
  assert.equal(c.proposal(c.first.id).status, 'superseded');
  assert.equal((await c.feed()).json.count, 0);
});

test('money-3: min./max. cena a nákupní cena – export zadrží cenu mimo meze; PATCH min_price návrh zneplatní', async (t) => {
  const c = await setup(t);
  c.db.prepare('UPDATE products SET min_price = 9900 WHERE id = ?').run(c.pid);
  assert.deepEqual(exportRowsDetailed(c.db).held.map((h) => h.reason), ['below_min']);
  c.db.prepare('UPDATE products SET min_price = NULL, max_price = 9000 WHERE id = ?').run(c.pid);
  assert.deepEqual(exportRowsDetailed(c.db).held.map((h) => h.reason), ['above_max']);
  c.db.prepare('UPDATE products SET max_price = NULL, purchase_price = 9000 WHERE id = ?').run(c.pid);
  assert.deepEqual(exportRowsDetailed(c.db).held.map((h) => h.reason), ['below_cost']);
  c.db.prepare('UPDATE products SET purchase_price = 6000 WHERE id = ?').run(c.pid);
  assert.equal(exportRowsDetailed(c.db).rows.length, 1);
  const r = await c.s.patch(`/api/v1/products/${c.pid}`, { min_price: 9900 });
  assert.equal(r.status, 200, r.text);
  assert.equal(c.proposal(c.first.id).status, 'superseded');
});

test('money-4: deaktivace importem zneplatní návrh – po reaktivaci se starý návrh nevyexportuje; neaktivní nejde schválit', async (t) => {
  const c = await setup(t);
  const imp = c.app.token(['import']);
  let r = await imp.post('/api/v1/import/products?deactivate_missing=1&force_deactivate=1', 'code;price\nBIKE-2;10000\n', { headers: { 'Content-Type': 'text/csv' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.stats.deactivated, 1);
  assert.equal(c.proposal(c.first.id).status, 'superseded');
  r = await imp.post('/api/v1/import/products?deactivate_missing=1', 'code;price\nBIKE-1;10000\nBIKE-2;10000\n', { headers: { 'Content-Type': 'text/csv' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(c.db.prepare('SELECT active FROM products WHERE id = ?').get(c.pid).active, 1);
  assert.equal((await c.feed()).json.count, 0);
  // čekající návrh neaktivního produktu nejde schválit
  const run = c.db.prepare('SELECT MAX(id) AS id FROM runs').get().id;
  const pend = Number(
    c.db
      .prepare("INSERT INTO proposals (run_id, product_id, old_price, new_price, status, created_at) VALUES (?, ?, 10000, 9500, 'pending', ?)")
      .run(run, c.other, new Date().toISOString()).lastInsertRowid
  );
  c.db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(c.other);
  r = await c.s.post('/api/v1/proposals/approve', { ids: [pend] });
  assert.equal(r.json.updated, 0);
  assert.equal(r.json.skipped_inactive, 1);
});

test('money-4: deactivate_missing, který by vypnul víc než polovinu katalogu, se bez force_deactivate neprovede', async (t) => {
  const c = await setup(t);
  const imp = c.app.token(['import']);
  const r = await imp.post('/api/v1/import/products?deactivate_missing=1', 'code;price\nNOVY-1;500\n', { headers: { 'Content-Type': 'text/csv' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.stats.deactivated, 0);
  assert.ok(r.json.stats.errors.some((e) => /force_deactivate/.test(e.message)));
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM products WHERE active = 1').get().n, 3);
});

test('money-5: přecenění mezi stažením feedu a potvrzením – ack podle kódu označí DORUČENÝ návrh, ne nový', async (t) => {
  const c = await setup(t);
  const pulled = await c.exp.get('/feed/changes.json');
  assert.equal(pulled.json.items[0].price, 9603);
  // konkurent zdražil, přecenění nahradí návrh 1 novým automaticky schváleným 9 553
  c.db.prepare('UPDATE offers SET price = 9650 WHERE product_id = ?').run(c.pid);
  await c.run();
  const [second] = c.open();
  assert.notEqual(second.id, c.first.id);
  assert.equal(second.new_price, 9553);
  assert.equal(c.proposal(c.first.id).status, 'superseded');
  const ack = await c.exp.post('/api/v1/export/ack', { codes: ['BIKE-1'] });
  assert.equal(ack.status, 200, ack.text);
  assert.deepEqual(ack.json.proposal_ids, [c.first.id]);
  assert.equal(c.price(), 9603, 'zapsaná je cena, kterou admin skutečně dostal');
  assert.equal(c.proposal(c.first.id).status, 'exported');
  assert.equal(c.proposal(second.id).status, 'approved', 'nový návrh admin neviděl – zůstává');
  // nový návrh vycházel z 10 000 → po potvrzení 9 603 je zastaralý (zadržen, přecení se znovu)
  const f = await c.feed();
  assert.equal(f.json.count, 0);
  assert.equal(f.headers.get('x-export-held'), '1');
});

test('money-5: ack s cenou (items) – nesouhlasí-li doručená cena s návrhem, nic se neoznačí', async (t) => {
  const c = await setup(t);
  let ack = await c.exp.post('/api/v1/export/ack', { items: [{ code: 'BIKE-1', price: 9553 }] });
  assert.equal(ack.status, 200, ack.text);
  assert.equal(ack.json.count, 0);
  assert.equal(ack.json.mismatched[0].reason, 'price_mismatch');
  assert.equal(ack.json.mismatched[0].current_price, 9603);
  ack = await c.exp.post('/api/v1/export/ack', { items: [{ code: 'BIKE-1', price: 9603 }] });
  assert.equal(ack.json.count, 1);
  assert.equal(c.price(), 9603);
  assert.equal((await c.exp.post('/api/v1/export/ack', { items: [{ code: 'BIKE-1' }] })).status, 400);
});

test('money-6: ruční cena změněná po stažení feedu – ack podle id nezapíše cenu, kterou admin nemá', async (t) => {
  const c = await setup(t);
  await c.exp.get('/feed/changes.json');
  // změna přímo v DB (PATCH by návrh vrátil ke schválení) – simulace úpravy mezi stažením a potvrzením
  c.db.prepare('UPDATE proposals SET manual_price = 7000 WHERE id = ?').run(c.first.id);
  const ack = await c.exp.post('/api/v1/export/ack', { proposal_ids: [c.first.id] });
  assert.equal(ack.json.count, 0);
  assert.equal(ack.json.mismatched[0].reason, 'changed_since_delivery');
  assert.equal(c.price(), 10000);
  assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM price_history WHERE source = 'export'").get().n, 0);
});

test('ops-4 / money-6: ruční cena změněná během odesílání webhooku – návrh se neoznačí, cena produktu se nezmění', async (t) => {
  const c = await setup(t);
  const res = await pushChanges(c.db, {
    webhook: { url: 'http://127.0.0.1:9/hook' },
    push: async (rows) => {
      assert.equal(rows[0].price, 9603);
      c.db.prepare('UPDATE proposals SET manual_price = 77777 WHERE id = ?').run(c.first.id);
      return { ok: true, status: 200 };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.marked, 0);
  assert.equal(res.not_marked[0].reason, 'changed_since_delivery');
  assert.equal(c.proposal(c.first.id).status, 'approved', 'odešle se znovu s novou cenou');
  assert.equal(c.price(), 10000);
  // markExported s doručenou cenou zapíše doručenou cenu
  c.db.prepare('UPDATE proposals SET manual_price = NULL WHERE id = ?').run(c.first.id);
  const m = markExported(c.db, [c.first.id], { delivered: new Map([[c.first.id, 9603]]) });
  assert.equal(m.count, 1);
  assert.equal(c.price(), 9603);
});

test('money-7: ruční cena – riziková vyžaduje potvrzení, schválený návrh se vrací ke schválení, zámek ji zakáže', async (t) => {
  const c = await setup(t);
  let r = await c.s.patch(`/api/v1/proposals/${c.first.id}`, { manual_price: 1 });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.error.details.code, 'MANUAL_PRICE_CONFIRM');
  assert.ok(r.json.error.details.flags.includes('manual_below_cost'));
  assert.ok(r.json.error.details.flags.includes('big_manual_change'));
  assert.equal(c.proposal(c.first.id).manual_price, null, 'bez potvrzení se nic neuložilo');
  r = await c.s.patch(`/api/v1/proposals/${c.first.id}`, { manual_price: 1, confirm: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'pending', 'upravený schválený návrh jde znovu ke schválení');
  assert.ok(r.json.flags.includes('manual_below_cost'));
  assert.equal((await c.feed()).json.count, 0);
  // bezpečná ruční cena bez potvrzení
  r = await c.s.patch(`/api/v1/proposals/${c.first.id}`, { manual_price: 9500 });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.flags.filter((f) => f !== 'manual'), []);
  // zrušení ruční ceny odebere její příznaky
  r = await c.s.patch(`/api/v1/proposals/${c.first.id}`, { manual_price: null });
  assert.deepEqual(r.json.flags, []);
  c.db.prepare('UPDATE products SET locked = 1 WHERE id = ?').run(c.pid);
  r = await c.s.patch(`/api/v1/proposals/${c.first.id}`, { manual_price: 9500 });
  assert.equal(r.status, 409);
});

test('money-7: vědomě schválená ruční cena pod nákupem projde exportem', async (t) => {
  const c = await setup(t);
  await c.s.patch(`/api/v1/proposals/${c.first.id}`, { manual_price: 6500, confirm: true });
  await c.s.post('/api/v1/proposals/approve', { ids: [c.first.id] });
  const f = await c.feed();
  assert.equal(f.json.count, 1);
  assert.equal(f.json.items[0].price, 6500);
});

test('money-8: zamítnutou cenu další běh znovu automaticky neschválí; ruční cenu přenese a nechá ke schválení', async (t) => {
  {
    const c = await setup(t);
    // bez paměti zamítnutí (reject_memory_days = 0) vznikne stejný návrh znovu – jen čeká na ruční schválení
    assert.equal((await c.s.put('/api/v1/settings', { reject_memory_days: 0 })).status, 200);
    let r = await c.s.post('/api/v1/proposals/reject', { ids: [c.first.id] });
    assert.equal(r.json.updated, 1);
    const res = runPricing(c.db, { trigger: 'schedule' });
    const [again] = c.open();
    assert.equal(again.new_price, 9603);
    assert.equal(again.status, 'pending', 'stejná zamítnutá cena se automaticky neschválí');
    assert.ok(JSON.parse(again.flags).includes('previously_rejected'));
    assert.equal(res.stats.held_by_human, 1);
    // ruční cena na schváleném návrhu: nový běh (jiný trh) ji převezme a nechá ke schválení
    await c.s.patch(`/api/v1/proposals/${again.id}`, { manual_price: 9990 });
    await c.s.post('/api/v1/proposals/approve', { ids: [again.id] });
    c.db.prepare('UPDATE offers SET price = 9650 WHERE product_id = ?').run(c.pid);
    runPricing(c.db, { trigger: 'schedule' });
    const [carried] = c.open();
    assert.notEqual(carried.id, again.id);
    assert.equal(carried.manual_price, 9990);
    assert.equal(carried.status, 'pending');
    assert.ok(JSON.parse(carried.flags).includes('manual_carried'));
    r = await c.feed();
    assert.equal(r.json.count, 0, 'automaticky se neodeslalo nic');
  }
});

test('ops-1: ruční schválení a ruční cena přežijí běh se stejným výsledkem', async (t) => {
  const app = await H.startApp();
  t.after(() => app.stop());
  const comp = H.insertCompetitor(app.db, 'VeloMarket.cz');
  const pid = H.insertProduct(app.db, { code: 'BIKE-1', purchase_price: 6000, price: 10000 });
  H.insertOffer(app.db, pid, comp, 9700);
  H.insertStrategy(app.db, { name: 'Podstřel', config: { ...CONFIG, approval: { auto: false } } });
  const s = app.session();
  await s.post('/api/v1/runs', {});
  const [p] = app.db.prepare('SELECT * FROM proposals').all();
  assert.equal(p.status, 'pending');
  await s.post('/api/v1/proposals/approve', { ids: [p.id] });
  // nesouvisející import nabídek + běh (jako plánovač s run_after_import)
  const other = H.insertProduct(app.db, { code: 'JINY', purchase_price: 100, price: 300 });
  H.insertOffer(app.db, other, comp, 250);
  const res = runPricing(app.db, { trigger: 'schedule' });
  assert.equal(res.stats.kept, 1);
  const after = app.db.prepare('SELECT * FROM proposals WHERE id = ?').get(p.id);
  assert.equal(after.status, 'approved');
  assert.equal(after.decided_by, 'admin');
  assert.equal(after.run_id, res.run_id);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM proposals WHERE product_id = ?').get(pid).n, 1, 'žádná kopie');
});

test('money-9: „schválit vše“ s expect odmítne změněný seznam; rizikové návrhy vynechá bez include_flagged', async (t) => {
  const c = await setup(t, { auto: false });
  const list = (await c.s.get('/api/v1/proposals')).json;
  assert.equal(list.total, 1);
  // mezitím konkurent zlevnil o 40 % → nový čekající návrh s velkou změnou
  c.db.prepare('UPDATE offers SET price = 5500 WHERE product_id = ?').run(c.pid);
  await c.run();
  let r = await c.s.post('/api/v1/proposals/approve', { all: true, filter: { status: 'pending' }, expect: { count: list.total, max_id: list.max_id } });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.error.details.code, 'PROPOSALS_CHANGED');
  r = await c.s.post('/api/v1/proposals/approve', { all: true, filter: { status: 'pending' } });
  assert.equal(r.json.updated, 0);
  assert.equal(r.json.skipped_flagged, 1);
  assert.equal((await c.feed()).json.count, 0);
  const fresh = (await c.s.get('/api/v1/proposals')).json;
  assert.equal(fresh.flagged, 1);
  r = await c.s.post('/api/v1/proposals/approve', { all: true, include_flagged: true, expect: { count: fresh.total, max_id: fresh.max_id } });
  assert.equal(r.json.updated, 1);
});
