'use strict';
// Integrační testy API (C2): zkušební přecenění celé sady (POST /runs {dry_run}) a simulace strategie v kontextu
// celé sady (POST /simulate {strategy_id}).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./api-routes-helpers');

test('API C2: zkušební přecenění a simulace v kontextu', async (t) => {
  const app = await H.startApp();
  t.after(() => app.stop());
  const seed = H.seedBasic(app.db);
  const s = app.session();
  const read = app.token(['read']);
  const admin = app.token(['admin']);
  const count = (table) => app.db.prepare(`SELECT count(*) AS c FROM ${table}`).get().c;

  await t.test('POST /runs {dry_run: true}: nic se nezapíše, vzorek seřazený podle |změny %|', async () => {
    const auditBefore = count('audit');
    const r = await s.post('/api/v1/runs', { dry_run: true });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json).sort(), ['dry_run', 'run_id', 'sample', 'stats']);
    assert.equal(r.json.run_id, null);
    assert.equal(r.json.dry_run, true);
    assert.equal(r.json.stats.products, 5, 'aktivní produkty');
    assert.equal(r.json.stats.changes, 4);
    assert.ok(r.json.stats.by_strategy);
    const sample = r.json.sample;
    assert.equal(sample.length, 4);
    const abs = sample.map((d) => Math.abs(d.change_pct));
    assert.deepEqual(abs, [...abs].sort((a, b) => b - a));
    for (const d of sample) {
      assert.deepEqual(Object.keys(d.product).sort(), ['category', 'code', 'id', 'manufacturer', 'name']);
      assert.equal(d.product.id, d.product_id);
      for (const k of ['action', 'reason', 'old_price', 'new_price', 'change_pct', 'flags', 'explain', 'strategy_id', 'market', 'auto_approve']) assert.ok(k in d, k);
    }
    assert.equal(sample[0].product.code, 'P4');
    assert.equal(sample[0].product.category, 'Příslušenství');
    assert.equal(count('runs'), 0);
    assert.equal(count('proposals'), 0);
    assert.equal(count('audit'), auditBefore, 'zkušební běh se neaudituje');
  });

  await t.test('dry_run s product_ids, dry_run false = běžný běh, validace', async () => {
    let r = await s.post('/api/v1/runs', { dry_run: true, product_ids: [seed.products.P1] });
    assert.equal(r.status, 200);
    assert.equal(r.json.stats.products, 1);
    assert.deepEqual(r.json.sample.map((d) => d.product.code), ['P1']);
    r = await s.post('/api/v1/runs', { dry_run: 'možná' });
    assert.equal(r.status, 400);
    r = await read.post('/api/v1/runs', { dry_run: true });
    assert.equal(r.status, 403, 'zkušební běh jen pro admin');
    r = await admin.post('/api/v1/runs', { dry_run: true });
    assert.equal(r.status, 200);
    assert.equal(count('runs'), 0);
    r = await s.post('/api/v1/runs', { dry_run: false });
    assert.equal(r.status, 200);
    assert.ok(r.json.run_id > 0);
    assert.equal(r.json.dry_run, undefined);
    assert.equal(count('runs'), 1);
  });

  await t.test('POST /simulate se strategy_id: kontext celé sady, claimed_by_earlier', async () => {
    // strategie pro Focus s vyšší prioritou před záchytnou „Podstřel minimum“ (priorita 100)
    const focus = H.insertStrategy(app.db, { name: 'Focus držet', segment_id: seed.segments.focus, priority: 10, config: { target: { mode: 'match_min' }, rounding: { mode: 'integer' } } });
    const all = seed.strategies.all;
    let r = await read.post('/api/v1/simulate', { strategy_id: all, config: { target: { mode: 'undercut_min', offset_pct: -3 }, limits: { min_margin_pct: 1, max_decrease_pct: 30, max_increase_pct: 30, max_above_msrp_pct: null }, rounding: { mode: 'integer' } } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.context, true);
    assert.equal(r.json.stats.claimed_by_earlier, 1, 'P1 (Focus) rozhodla dřívější strategie');
    const codes = r.json.decisions.map((d) => d.product.code).sort();
    assert.ok(!codes.includes('P1'));
    assert.ok(codes.includes('P3'));
    assert.ok(r.json.decisions.every((d) => d.strategy_id === all));
    assert.ok(r.json.truncated && typeof r.json.truncated.changes_total === 'number');
    // bez strategy_id: dosavadní chování
    r = await read.post('/api/v1/simulate', { config: { target: { mode: 'match_min' } } });
    assert.equal(r.status, 200);
    assert.equal(r.json.context, false);
    assert.equal(r.json.stats.claimed_by_earlier, undefined);
    // uložená konfigurace strategie, když config chybí; vypnutá strategie se vloží podle priority
    app.db.prepare('UPDATE strategies SET enabled = 0 WHERE id = ?').run(focus);
    r = await read.post('/api/v1/simulate', { strategy_id: focus });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.context, true);
    assert.deepEqual(r.json.decisions.map((d) => d.product.code), ['P1']);
    // chyby
    r = await read.post('/api/v1/simulate', { strategy_id: 99999 });
    assert.equal(r.status, 400);
    assert.match(r.json.error.message, /neexistuje/);
    r = await read.post('/api/v1/simulate', { strategy_id: 'abc' });
    assert.equal(r.status, 400);
    r = await read.post('/api/v1/simulate', { strategy_id: all, config: { target: { mode: 'nesmysl' } } });
    assert.equal(r.status, 400);
    // simulace nic nezapisuje
    const before = count('proposals');
    await read.post('/api/v1/simulate', { strategy_id: all });
    assert.equal(count('proposals'), before);
  });
});
