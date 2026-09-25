'use strict';
// Integrační testy API: návrhy cen (seznam, filtry, řazení, souhrn, schvalování, ruční cena).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./api-routes-helpers');

test('API návrhy cen', async (t) => {
  const app = await H.startApp();
  t.after(() => app.stop());
  const seed = H.seedBasic(app.db);
  const P = seed.products;
  const s = app.session();
  const read = app.token(['read']);
  // druhá strategie jen pro segment Ležáky (vyšší priorita)
  H.insertStrategy(app.db, {
    name: 'Ležáky',
    segment_id: seed.segments.lezaky,
    priority: 10,
    config: { target: { mode: 'undercut_min', offset_pct: -5 }, limits: { min_margin_pct: 1, max_decrease_pct: 30, min_change_abs: 1, min_change_pct: 0 }, rounding: { mode: 'integer' } },
  });
  const run = await s.post('/api/v1/runs', {});
  assert.equal(run.status, 200);
  const runId = run.json.run_id;
  const byCode = async () => {
    const r = await s.get('/api/v1/proposals?status=all&limit=500');
    return Object.fromEntries(r.json.items.map((x) => [x.product.code, x]));
  };

  await t.test('seznam: tvar položky a souhrn', async () => {
    const r = await s.get('/api/v1/proposals');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ['items', 'limit', 'page', 'summary', 'total']);
    assert.ok(r.json.total >= 3);
    const it = r.json.items[0];
    for (const k of ['id', 'run_id', 'product_id', 'strategy_id', 'segment_id', 'old_price', 'new_price', 'change_pct', 'margin_before', 'margin_after', 'status', 'manual_price', 'flags', 'explain', 'product', 'strategy_name', 'segment_name', 'final_price', 'cheapest_competitor']) {
      assert.ok(k in it, `chybí ${k}`);
    }
    assert.deepEqual(Object.keys(it.product).sort(), ['active', 'category', 'code', 'ean', 'id', 'manufacturer', 'name', 'price', 'purchase_price', 'stock', 'vat_rate'].sort());
    assert.ok(Array.isArray(it.flags));
    assert.ok(Array.isArray(it.explain) && it.explain.length);
    assert.ok(r.json.items.every((x) => x.status === 'pending'), 'výchozí stav pending');
    assert.deepEqual(Object.keys(r.json.summary).sort(), ['approved', 'down', 'exported_today', 'pending', 'up']);
    assert.equal(r.json.summary.pending, r.json.total);
    assert.equal(r.json.summary.up + r.json.summary.down, r.json.total);
    const p1 = r.json.items.find((x) => x.product.code === 'P1');
    assert.equal(p1.strategy_name, 'Podstřel minimum');
    assert.equal(p1.cheapest_competitor, 'VeloMarket.cz');
    const p2 = r.json.items.find((x) => x.product.code === 'P2');
    assert.equal(p2.strategy_name, 'Ležáky');
    assert.equal(p2.segment_name, 'Ležáky');
  });

  await t.test('výchozí řazení: absolutní změna % sestupně; další řazení', async () => {
    let r = await s.get('/api/v1/proposals');
    const abs = r.json.items.map((x) => Math.abs(x.change_pct));
    assert.deepEqual(abs, [...abs].sort((a, b) => b - a));
    r = await s.get('/api/v1/proposals?sort=change_pct');
    const pct = r.json.items.map((x) => x.change_pct);
    assert.deepEqual(pct, [...pct].sort((a, b) => a - b));
    r = await s.get('/api/v1/proposals?sort=new_price&dir=desc');
    const np = r.json.items.map((x) => x.new_price);
    assert.deepEqual(np, [...np].sort((a, b) => b - a));
    r = await s.get('/api/v1/proposals?sort=code');
    const codes = r.json.items.map((x) => x.product.code);
    assert.deepEqual(codes, [...codes].sort());
    for (const sort of ['created_at', 'margin_after', 'name', 'manufacturer']) {
      r = await s.get(`/api/v1/proposals?sort=${sort}&dir=desc`);
      assert.equal(r.status, 200, sort);
    }
    assert.equal((await s.get('/api/v1/proposals?sort=heslo')).status, 400);
    assert.equal((await s.get('/api/v1/proposals?dir=dolu')).status, 400);
  });

  await t.test('filtry', async () => {
    let r = await s.get('/api/v1/proposals?direction=up');
    assert.ok(r.json.items.every((x) => x.new_price > x.old_price));
    assert.equal(r.json.summary.down, 0);
    r = await s.get('/api/v1/proposals?direction=down');
    assert.ok(r.json.total >= 1);
    assert.ok(r.json.items.every((x) => x.new_price < x.old_price));
    r = await s.get('/api/v1/proposals?q=aspero');
    assert.deepEqual(r.json.items.map((x) => x.product.code), ['P2']);
    r = await s.get('/api/v1/proposals?manufacturer=FOCUS');
    assert.deepEqual(r.json.items.map((x) => x.product.code), ['P1']);
    r = await s.get(`/api/v1/proposals?segment=${seed.segments.lezaky}`);
    assert.ok(r.json.items.every((x) => x.segment_id === seed.segments.lezaky));
    assert.ok(r.json.total >= 1);
    r = await s.get('/api/v1/proposals?segment=none');
    assert.ok(r.json.items.every((x) => x.segment_id === null));
    r = await s.get(`/api/v1/proposals?strategy=${seed.strategies.all}`);
    assert.ok(r.json.items.every((x) => x.strategy_name === 'Podstřel minimum'));
    r = await s.get(`/api/v1/proposals?run=${runId}&status=all`);
    assert.ok(r.json.items.every((x) => x.run_id === runId));
    r = await s.get('/api/v1/proposals?run=latest');
    assert.ok(r.json.total >= 1);
    r = await s.get('/api/v1/proposals?flag=floor');
    assert.ok(r.json.items.every((x) => x.flags.includes('floor')));
    r = await s.get(`/api/v1/proposals?product=${P.P1}`);
    assert.deepEqual(r.json.items.map((x) => x.product.code), ['P1']);
    r = await s.get('/api/v1/proposals?limit=1&page=2');
    assert.equal(r.json.items.length, 1);
    assert.equal(r.json.page, 2);
    for (const bad of ['status=hotovo', 'direction=sideways', 'run=x', 'strategy=-1', 'flag=a%20b']) {
      assert.equal((await s.get('/api/v1/proposals?' + bad)).status, 400, bad);
    }
  });

  await t.test('PATCH manual_price', async () => {
    const pr = (await byCode()).P1;
    let r = await s.patch(`/api/v1/proposals/${pr.id}`, { manual_price: 75000 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.manual_price, 75000);
    assert.equal(r.json.final_price, 75000);
    assert.equal(r.json.status, 'pending');
    assert.equal(r.json.final_change_pct, Math.round(((75000 - 79990) / 79990) * 10000) / 100);
    assert.equal(r.json.product.code, 'P1');
    const list = await s.get('/api/v1/products?q=P1');
    assert.equal(list.json.items[0].proposal.manual_price, 75000);
    assert.equal(list.json.items[0].proposal.final_price, 75000);
    r = await s.patch(`/api/v1/proposals/${pr.id}`, { manual_price: null });
    assert.equal(r.json.manual_price, null);
    assert.equal(r.json.final_price, r.json.new_price);
    for (const bad of [{ manual_price: 0 }, { manual_price: -10 }, { manual_price: 'levně' }, {}, { manual_price: 1, status: 'approved' }]) {
      r = await s.patch(`/api/v1/proposals/${pr.id}`, bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal((await s.patch('/api/v1/proposals/99999', { manual_price: 1 })).status, 404);
    assert.equal((await read.patch(`/api/v1/proposals/${pr.id}`, { manual_price: 1 })).status, 403);
  });

  await t.test('approve / reject podle ids', async () => {
    const m = await byCode();
    let r = await s.post('/api/v1/proposals/approve', { ids: [m.P1.id, m.P3.id] });
    assert.equal(r.status, 200);
    assert.equal(r.json.updated, 2);
    r = await s.post('/api/v1/proposals/approve', { ids: [m.P1.id] });
    assert.equal(r.json.updated, 0, 'už schválený se nepočítá');
    let x = await byCode();
    assert.equal(x.P1.status, 'approved');
    assert.equal(x.P1.decided_by, 'admin');
    assert.ok(x.P1.decided_at);
    r = await s.get('/api/v1/proposals');
    assert.equal(r.json.summary.approved, 2);
    // reject schváleného (neexportovaného) projde
    r = await s.post('/api/v1/proposals/reject', { ids: [m.P3.id] });
    assert.equal(r.json.updated, 1);
    x = await byCode();
    assert.equal(x.P3.status, 'rejected');
    // zamítnutý nelze upravit ani schválit
    assert.equal((await s.patch(`/api/v1/proposals/${m.P3.id}`, { manual_price: 1000 })).status, 409);
    r = await s.post('/api/v1/proposals/approve', { ids: [m.P3.id] });
    assert.equal(r.json.updated, 0);
    for (const bad of [{}, { ids: 'všechny' }, { ids: [0] }, { all: true, filter: 'x' }, { all: true, filter: { barva: 'modrá' } }]) {
      assert.equal((await s.post('/api/v1/proposals/approve', bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await read.post('/api/v1/proposals/approve', { ids: [m.P1.id] })).status, 403);
    const aud = app.db.prepare("SELECT * FROM audit WHERE action = 'proposals.approve'").all();
    assert.equal(aud.length, 1);
  });

  await t.test('approve all s filtrem, zamčené produkty se neschválí', async () => {
    // zamknout P4 → schválení podle filtru ho vynechá
    await s.patch(`/api/v1/products/${P.P4}`, { locked: true });
    let r = await s.post('/api/v1/proposals/approve', { all: true, filter: { segment: String(seed.segments.lezaky) } });
    assert.equal(r.status, 200);
    assert.equal(r.json.updated, 1); // P2
    assert.equal(r.json.skipped_locked, 1); // P4
    const x = await byCode();
    assert.equal(x.P2.status, 'approved');
    assert.equal(x.P4.status, 'pending');
    await s.patch(`/api/v1/products/${P.P4}`, { locked: false });
    // reject all s filtrem stavu approved → jen schválené
    r = await s.post('/api/v1/proposals/reject', { all: true, filter: { status: 'approved', q: 'aspero' } });
    assert.equal(r.json.updated, 1);
    assert.equal((await byCode()).P2.status, 'rejected');
    // approve all s filtrem stavu approved → nic (schvalují se jen čekající)
    r = await s.post('/api/v1/proposals/approve', { all: true, filter: { status: 'approved' } });
    assert.equal(r.json.updated, 0);
    // approve all bez filtru → všechny čekající
    const pending = (await s.get('/api/v1/proposals')).json.total;
    r = await s.post('/api/v1/proposals/approve', { all: true });
    assert.equal(r.json.updated, pending);
    assert.equal((await s.get('/api/v1/proposals')).json.total, 0);
  });

  await t.test('velké seznamy: stránkování v SQL dává stejné pořadí jako řazení v JS', async () => {
    const mod = require('../src/server/api/proposals');
    const expected = (await s.get('/api/v1/proposals?status=all&sort=new_price&dir=desc&limit=500')).json.items.map((x) => x.id);
    assert.ok(expected.length >= 3);
    const old = mod.LIMITS.jsSortMax;
    mod.LIMITS.jsSortMax = 1;
    try {
      const got = [];
      for (let page = 1; page <= Math.ceil(expected.length / 2); page++) {
        const r = await s.get(`/api/v1/proposals?status=all&sort=new_price&dir=desc&limit=2&page=${page}`);
        assert.equal(r.json.total, expected.length);
        got.push(...r.json.items.map((x) => x.id));
      }
      assert.deepEqual(got, expected);
      const r = await s.get('/api/v1/proposals?status=all&sort=code&limit=500');
      assert.equal(r.json.items.length, expected.length);
    } finally {
      mod.LIMITS.jsSortMax = old;
    }
  });

  await t.test('nový běh nahradí otevřené návrhy (superseded) a seznam produktů to vidí', async () => {
    const before = await s.get('/api/v1/products?has_proposal=1');
    assert.ok(before.json.total >= 1);
    const r = await s.post('/api/v1/runs', {});
    assert.equal(r.status, 200);
    const sup = await s.get('/api/v1/proposals?status=superseded');
    assert.ok(sup.json.total >= 1);
    const after = await s.get('/api/v1/products?has_proposal=1');
    assert.ok(after.json.items.every((x) => x.proposal.status === 'pending'));
  });
});
