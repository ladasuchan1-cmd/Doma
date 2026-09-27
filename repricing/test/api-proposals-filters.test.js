'use strict';
// Integrační testy API: filtry návrhů podle produktu (C4 – owner, category, supplier, product_segment, filter)
// a zrušení schválení (C5 – POST /proposals/unapprove).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./api-routes-helpers');

test('API C4/C5: filtry návrhů a zrušení schválení', async (t) => {
  const app = await H.startApp();
  t.after(() => app.stop());
  const seed = H.seedBasic(app.db);
  const s = app.session();
  const read = app.token(['read']);
  await s.post('/api/v1/runs', {});
  const codes = async (q) => {
    const r = await s.get('/api/v1/proposals' + H.qs({ status: 'all', ...q }));
    assert.equal(r.status, 200, r.text);
    return r.json.items.map((x) => x.product.code).sort();
  };
  const byCode = async () => Object.fromEntries((await s.get('/api/v1/proposals?status=all&limit=500')).json.items.map((x) => [x.product.code, x]));

  await t.test('GET /proposals: owner, category, supplier – přesná shoda bez ohledu na velikost písmen', async () => {
    assert.deepEqual(await codes({}), ['P1', 'P2', 'P3', 'P4']);
    assert.deepEqual(await codes({ owner: 'lucie' }), ['P3', 'P4']);
    assert.deepEqual(await codes({ owner: 'Luc' }), [], 'přesná shoda, ne podřetězec');
    assert.deepEqual(await codes({ category: 'GRAVEL' }), ['P2']);
    assert.deepEqual(await codes({ category: 'prislusenstvi' }), ['P4'], 'bez diakritiky');
    assert.deepEqual(await codes({ supplier: 'pon' }), ['P1', 'P2']);
    assert.deepEqual(await codes({ supplier: 'pon', owner: 'Petr' }), ['P2']);
  });

  await t.test('GET /proposals: product_segment (kterýkoli segment produktu) vs. segment (rozhodující strategie)', async () => {
    // strategie „Podstřel minimum“ nemá segment → segment návrhů je null; produkt P2 ale do segmentu Ležáky patří
    assert.deepEqual(await codes({ product_segment: seed.segments.lezaky }), ['P2', 'P4']);
    assert.deepEqual(await codes({ product_segment: seed.segments.focus }), ['P1']);
    assert.deepEqual(await codes({ segment: seed.segments.lezaky }), []);
    assert.deepEqual(await codes({ product_segment: 99999 }), []);
    assert.equal((await s.get('/api/v1/proposals?product_segment=abc')).status, 400);
  });

  await t.test('GET /proposals: filter (Filter JSON nad pohledem produktu); neplatný → 400', async () => {
    assert.deepEqual(await codes({ filter: { field: 'price', op: '>', value: 10000 } }), ['P1', 'P2']);
    assert.deepEqual(await codes({ filter: { all: [{ field: 'attrs.N', op: 'in', value: ['N7', 'N8'] }, { field: 'manufacturer', op: '=', value: 'abus' }] } }), ['P4']);
    assert.deepEqual(await codes({ filter: {} }), ['P1', 'P2', 'P3', 'P4'], 'prázdný filtr = vše');
    let r = await s.get('/api/v1/proposals?filter=' + encodeURIComponent('{nejson'));
    assert.equal(r.status, 400);
    assert.match(r.json.error.message, /JSON/);
    r = await s.get('/api/v1/proposals' + H.qs({ filter: { field: 'price', op: 'jako', value: 1 } }));
    assert.equal(r.status, 400);
    assert.match(r.json.error.message, /Neplatný filtr/);
    // read token stačí
    assert.equal((await read.get('/api/v1/proposals' + H.qs({ owner: 'Jana' }))).status, 200);
  });

  await t.test('approve / reject {all: true, filter} s novými filtry', async () => {
    let r = await s.post('/api/v1/proposals/approve', { all: true, filter: { supplier: 'PON', filter: { field: 'manufacturer', op: '=', value: 'Focus' } }, include_flagged: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.updated, 1);
    let m = await byCode();
    assert.equal(m.P1.status, 'approved');
    assert.equal(m.P2.status, 'pending');
    r = await s.post('/api/v1/proposals/approve', { all: true, filter: { filter: '{rozbité' } });
    assert.equal(r.status, 400);
    r = await s.post('/api/v1/proposals/reject', { all: true, filter: { product_segment: seed.segments.lezaky, owner: 'Lucie' } });
    assert.equal(r.json.updated, 1);
    m = await byCode();
    assert.equal(m.P4.status, 'rejected');
    assert.equal(m.P2.status, 'pending');
  });

  await t.test('POST /proposals/unapprove: schválené → pending, jen neexportované; {updated}', async () => {
    let m = await byCode();
    // schválit P2 a P3 (P1 už schválený)
    let r = await s.post('/api/v1/proposals/approve', { ids: [m.P2.id, m.P3.id] });
    assert.equal(r.json.updated, 2);
    r = await s.post('/api/v1/proposals/unapprove', { ids: [m.P1.id, m.P4.id] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { updated: 1 }, 'zamítnutý P4 se nemění');
    m = await byCode();
    assert.equal(m.P1.status, 'pending');
    assert.ok(m.P1.decided_by, 'kdo schválení zrušil');
    // hromadně podle filtru s kontrolou expect
    r = await s.post('/api/v1/proposals/unapprove', { all: true, filter: { supplier: 'PON' }, expect: { count: 5 } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.details.code, 'PROPOSALS_CHANGED');
    r = await s.post('/api/v1/proposals/unapprove', { all: true, filter: { supplier: 'PON' }, expect: { count: 1 } });
    assert.deepEqual(r.json, { updated: 1 });
    m = await byCode();
    assert.equal(m.P2.status, 'pending');
    assert.equal(m.P3.status, 'approved');
    // exportovaný návrh se vrátit nedá
    const exp = app.token(['export']);
    const feed = await exp.get('/api/v1/export/changes.json?mark=1');
    assert.equal(feed.json.count, 1);
    r = await s.post('/api/v1/proposals/unapprove', { ids: [m.P3.id] });
    assert.deepEqual(r.json, { updated: 0 });
    assert.equal((await byCode()).P3.status, 'exported');
    // audit, oprávnění, validace
    const audit = await s.get('/api/v1/audit');
    assert.ok(audit.json.items.some((a) => a.action === 'proposals.unapprove'));
    assert.equal((await read.post('/api/v1/proposals/unapprove', { ids: [m.P1.id] })).status, 403);
    assert.equal((await s.post('/api/v1/proposals/unapprove', {})).status, 400);
  });

  await t.test('zrušené schválení: další přecenění stejný návrh ponechá čekat (neschválí ho automaticky)', async () => {
    // strategie s automatickým schválením – P1 by se jinak schválil sám
    app.db.prepare("UPDATE strategies SET config = json_set(config, '$.approval.auto', json('true'), '$.approval.auto_max_change_pct', 50) WHERE id = ?").run(seed.strategies.all);
    let r = await s.post('/api/v1/runs', {});
    assert.equal(r.status, 200);
    let m = await byCode();
    const p1 = m.P1;
    assert.equal(p1.status, 'pending', 'ručně vrácený návrh zůstal čekat');
    assert.ok(r.json.stats.kept >= 1);
    assert.equal(m.P4.status, 'rejected', 'zamítnutou cenu (paměť zamítnutí) běh znovu nenavrhne');
    // schválit → zrušit schválení → přecenění: pořád týž návrh a čeká
    r = await s.post('/api/v1/proposals/approve', { ids: [p1.id] });
    assert.equal(r.json.updated, 1);
    r = await s.post('/api/v1/proposals/unapprove', { ids: [p1.id] });
    assert.equal(r.json.updated, 1);
    await s.post('/api/v1/runs', {});
    m = await byCode();
    assert.equal(m.P1.id, p1.id);
    assert.equal(m.P1.status, 'pending');
  });
});
