'use strict';
// Integrační testy API: konkurenti, segmenty, strategie (CRUD, pořadí, předvolby), simulace, pole, běhy.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./api-routes-helpers');
const { STRATEGY_PRESETS } = require('../src/engine/presets');

test('API konkurenti, segmenty, strategie, simulace, běhy', async (t) => {
  const app = await H.startApp();
  t.after(() => app.stop());
  const seed = H.seedBasic(app.db);
  const s = app.session();
  const read = app.token(['read']);

  await t.test('GET /competitors se statistikami', async () => {
    const r = await s.get('/api/v1/competitors');
    assert.equal(r.status, 200);
    assert.equal(r.json.items.length, 3);
    const velo = r.json.items.find((c) => c.name === 'VeloMarket.cz');
    for (const k of ['id', 'name', 'label', 'enabled', 'tags', 'note', 'offers', 'products_cheaper_than_us', 'avg_index', 'last_seen_at']) assert.ok(k in velo, k);
    assert.equal(velo.offers, 3);
    // P1 76990 < 79990, P2 66990 > 64990, P3 1190 < 1290 → 2 levnější
    assert.equal(velo.products_cheaper_than_us, 2);
    assert.equal(velo.avg_index, Math.round(((76990 / 79990 + 66990 / 64990 + 1190 / 1290) / 3) * 1000) / 10);
    assert.equal(velo.enabled, true);
    assert.deepEqual(velo.tags, ['klíčový']);
    assert.ok(velo.last_seen_at);
  });

  await t.test('PATCH /competitors/:id', async () => {
    const id = seed.competitors.c2;
    let r = await s.patch(`/api/v1/competitors/${id}`, { label: 'Kolo Pointer', enabled: false, tags: ['marketplace', ' marketplace ', 'akce'], note: 'Pozor na bazar' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.label, 'Kolo Pointer');
    assert.equal(r.json.enabled, false);
    assert.deepEqual(r.json.tags, ['marketplace', 'akce']);
    assert.equal(r.json.note, 'Pozor na bazar');
    assert.equal(r.json.offers, 3);
    // vypnutý konkurent se nezapočítává do trhu produktů
    let p = await s.get('/api/v1/products?q=P1');
    assert.equal(p.json.items[0].market_count, 1);
    r = await s.patch(`/api/v1/competitors/${id}`, { enabled: true, label: null });
    assert.equal(r.json.enabled, true);
    assert.equal(r.json.label, null);
    p = await s.get('/api/v1/products?q=P1');
    assert.equal(p.json.items[0].market_count, 2);
    for (const bad of [{ tags: 'a'.repeat(60) }, { tags: [{}] }, { enabled: 'snad' }, { name: 'jiné' }]) {
      r = await s.patch(`/api/v1/competitors/${id}`, bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal((await s.patch('/api/v1/competitors/999', { note: 'x' })).status, 404);
    assert.equal((await read.patch(`/api/v1/competitors/${id}`, { note: 'x' })).status, 403);
  });

  let segId;
  await t.test('segmenty: seznam s počty, vytvoření, validace, úprava', async () => {
    let r = await s.get('/api/v1/segments');
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 2);
    assert.ok('page' in r.json && 'limit' in r.json);
    const lez = r.json.items.find((x) => x.name === 'Ležáky');
    assert.equal(lez.count, 2);
    assert.deepEqual(lez.filter, { field: 'attrs.N', op: 'in', value: ['N7', 'N8'] });

    r = await s.post('/api/v1/segments', { name: 'Drahá kola', description: 'nad 50 tisíc', filter: { field: 'price', op: '>=', value: 50000 }, color: '#4a3aa7' });
    assert.equal(r.status, 201, r.text);
    segId = r.json.id;
    assert.equal(r.json.count, 2); // P1, P2 (P5 neaktivní)
    assert.equal(r.json.color, '#4a3aa7');
    assert.deepEqual(r.json.strategies, []);

    for (const bad of [
      { name: '', filter: {} },
      { name: 'X', filter: { field: 'price', op: 'kolem', value: 1 } },
      { name: 'X', filter: '{"all": ' },
      { name: 'X', filter: { all: 'nic' } },
      { name: 'X', filter: {}, color: 'url(javascript:alert(1))' },
    ]) {
      r = await s.post('/api/v1/segments', bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.ok(Array.isArray(r.json.error.details) && r.json.error.details.length, 'details = seznam chyb');
    }
    r = await s.post('/api/v1/segments', { name: 'drahá KOLA', filter: {} });
    assert.equal(r.status, 409, 'duplicitní název');

    r = await s.put(`/api/v1/segments/${segId}`, { filter: { field: 'price', op: '>=', value: 70000 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.count, 1);
    assert.equal(r.json.name, 'Drahá kola');
    r = await s.get(`/api/v1/segments/${segId}`);
    assert.equal(r.json.count, 1);
    // produkty vidí nové členství
    const p = await s.get(`/api/v1/products?segment=${segId}`);
    assert.deepEqual(p.json.items.map((x) => x.code), ['P1']);
    assert.equal((await s.get('/api/v1/segments/999')).status, 404);
    assert.equal((await s.put('/api/v1/segments/999', { name: 'x' })).status, 404);
  });

  await t.test('POST /segments/preview', async () => {
    let r = await read.post('/api/v1/segments/preview', { filter: { field: 'category', op: '=', value: 'prislusenstvi' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.count, 2);
    assert.equal(r.json.sample.length, 2);
    assert.deepEqual(r.json.errors, []);
    assert.ok('margin_pct' in r.json.sample[0], 'vzorek = View');
    r = await s.post('/api/v1/segments/preview', { filter: { field: 'x', op: '??' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.count, 0);
    assert.ok(r.json.errors.length);
    r = await s.post('/api/v1/segments/preview', { filter: {} });
    assert.equal(r.json.count, 5);
  });

  let st1;
  let st2;
  await t.test('strategie: CRUD, normalizace konfigurace, chyby 400 s details', async () => {
    let r = await s.get('/api/v1/strategies');
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 1);
    assert.equal(r.json.items[0].config.target.mode, 'undercut_min');
    assert.equal(r.json.items[0].config.approval.auto, false, 'doplněné výchozí hodnoty');

    r = await s.post('/api/v1/strategies', { name: 'Ležáky doprodej', segment_id: seed.segments.lezaky, priority: 10, config: { target: { mode: 'undercut_min', offset_pct: -2 }, limits: { min_margin_pct: 3 } } });
    assert.equal(r.status, 201, r.text);
    st1 = r.json;
    assert.equal(st1.segment_name, 'Ležáky');
    assert.equal(st1.enabled, true);
    assert.equal(st1.config.limits.min_margin_pct, 3);
    assert.equal(st1.config.limits.max_decrease_pct, 10);
    const stored = JSON.parse(app.db.prepare('SELECT config FROM strategies WHERE id = ?').get(st1.id).config);
    assert.equal(stored.rounding.mode, 'ending', 'ukládá se normalizovaný config');

    r = await s.post('/api/v1/strategies', { name: 'Bez priority', config: {} });
    st2 = r.json;
    assert.equal(st2.priority, 110, 'na konec seznamu');

    r = await s.post('/api/v1/strategies', { name: 'Špatná', config: { target: { mode: 'nejlepší' }, limits: { min_margin_pct: 'hodně' } } });
    assert.equal(r.status, 400);
    assert.ok(Array.isArray(r.json.error.details));
    assert.ok(r.json.error.details.length >= 2);
    assert.ok(r.json.error.details.some((e) => e.includes('target.mode')));
    r = await s.post('/api/v1/strategies', { name: 'X', segment_id: 999, config: {} });
    assert.equal(r.status, 400);
    r = await s.post('/api/v1/strategies', { config: {} });
    assert.equal(r.status, 400);
    r = await s.post('/api/v1/strategies', { name: 'X', config: {}, foo: 1 });
    assert.equal(r.status, 400);

    r = await s.put(`/api/v1/strategies/${st2.id}`, { enabled: false, description: 'vypnutá' });
    assert.equal(r.status, 200);
    assert.equal(r.json.enabled, false);
    assert.equal(r.json.description, 'vypnutá');
    assert.equal(r.json.name, 'Bez priority');
    r = await s.put(`/api/v1/strategies/${st2.id}`, { config: { conditions: { field: 'position', op: 'je' } } });
    assert.equal(r.status, 400);
    assert.ok(r.json.error.details.some((e) => e.startsWith('conditions')));
    r = await s.get(`/api/v1/strategies/${st1.id}`);
    assert.equal(r.json.name, 'Ležáky doprodej');
    assert.equal((await s.get('/api/v1/strategies/999')).status, 404);

    r = await s.get('/api/v1/strategies');
    assert.deepEqual(r.json.items.map((x) => x.id), [st1.id, seed.strategies.all, st2.id], 'podle priority');
  });

  await t.test('segment používaný strategií nelze smazat (409 se jménem strategie)', async () => {
    let r = await s.del(`/api/v1/segments/${seed.segments.lezaky}`);
    assert.equal(r.status, 409);
    assert.match(r.json.error.message, /Ležáky doprodej/);
    assert.deepEqual(r.json.error.details.strategies.map((x) => x.id), [st1.id]);
    r = await s.get(`/api/v1/segments/${seed.segments.lezaky}`);
    assert.deepEqual(r.json.strategies.map((x) => x.name), ['Ležáky doprodej']);
    r = await s.del(`/api/v1/segments/${segId}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.equal((await s.del(`/api/v1/segments/${segId}`)).status, 404);
  });

  await t.test('POST /strategies/reorder', async () => {
    let r = await s.post('/api/v1/strategies/reorder', { ids: [st2.id, st1.id] });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.items.map((x) => [x.id, x.priority]), [
      [st2.id, 10],
      [st1.id, 20],
      [seed.strategies.all, 30],
    ]);
    r = await s.post('/api/v1/strategies/reorder', { ids: [999] });
    assert.equal(r.status, 400);
    r = await s.post('/api/v1/strategies/reorder', { ids: 'a' });
    assert.equal(r.status, 400);
    r = await s.post('/api/v1/strategies/reorder', { ids: [st1.id, st1.id] });
    assert.equal(r.status, 400);
  });

  await t.test('předvolby', async () => {
    let r = await read.get('/api/v1/strategies/presets');
    assert.equal(r.status, 200);
    assert.equal(r.json.items.length, STRATEGY_PRESETS.length);
    assert.ok(r.json.items.every((p) => p.key && p.name && p.config));
    const withSeg = STRATEGY_PRESETS.find((p) => p.segment && p.enabled !== false);
    const before = await s.get('/api/v1/strategies');
    r = await s.post(`/api/v1/strategies/presets/${withSeg.key}`);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.strategy.name, withSeg.name);
    assert.equal(r.json.strategy.enabled, true);
    assert.equal(r.json.segment.name, withSeg.segment.name);
    assert.equal(r.json.segment_created, true);
    assert.equal(r.json.strategy.segment_id, r.json.segment.id);
    const maxPrio = Math.max(...before.json.items.map((x) => x.priority));
    assert.ok(r.json.strategy.priority > maxPrio, 'na konec seznamu');
    // podruhé: segment se znovu použije, strategie dostane odlišený název
    const r2 = await s.post(`/api/v1/strategies/presets/${withSeg.key}`);
    assert.equal(r2.json.segment.id, r.json.segment.id);
    assert.equal(r2.json.segment_created, false);
    assert.equal(r2.json.strategy.name, `${withSeg.name} (2)`);
    const disabled = STRATEGY_PRESETS.find((p) => p.enabled === false);
    if (disabled) {
      const r3 = await s.post(`/api/v1/strategies/presets/${disabled.key}`);
      assert.equal(r3.json.strategy.enabled, false, 'vypnutá dle předvolby');
    }
    const noSeg = STRATEGY_PRESETS.find((p) => !p.segment);
    const r4 = await s.post(`/api/v1/strategies/presets/${noSeg.key}`);
    assert.equal(r4.json.segment, null);
    assert.equal(r4.json.strategy.segment_id, null);
    assert.equal((await s.post('/api/v1/strategies/presets/neexistuje')).status, 404);
    assert.equal((await read.post(`/api/v1/strategies/presets/${noSeg.key}`)).status, 403);
    // úklid: smazat strategie z předvoleb (ať neovlivní další testy)
    for (const id of [r.json.strategy.id, r2.json.strategy.id, r4.json.strategy.id]) assert.equal((await s.del(`/api/v1/strategies/${id}`)).status, 200);
    const all = await s.get('/api/v1/strategies');
    for (const x of all.json.items) if (![st1.id, st2.id, seed.strategies.all].includes(x.id)) await s.del(`/api/v1/strategies/${x.id}`);
  });

  await t.test('POST /simulate', async () => {
    let r = await read.post('/api/v1/simulate', { config: { target: { mode: 'match_min' }, limits: { min_margin_pct: 0, max_above_msrp_pct: null, min_change_abs: 1, min_change_pct: 0 }, rounding: { mode: 'none' } }, limit: 10 });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.stats);
    assert.ok(Array.isArray(r.json.decisions));
    assert.deepEqual(r.json.errors, []);
    const d1 = r.json.decisions.find((d) => d.product_id === seed.products.P1);
    assert.equal(d1.new_price, 76990);
    assert.equal(d1.product.code, 'P1');
    // nic se nezapsalo
    assert.equal(app.db.prepare('SELECT count(*) AS c FROM proposals').get().c, 0);
    r = await s.post('/api/v1/simulate', { config: { target: { mode: 'match_min' } }, segment_id: seed.segments.focus });
    assert.equal(r.status, 200);
    assert.ok(r.json.decisions.every((d) => d.product_id === seed.products.P1));
    r = await s.post('/api/v1/simulate', { config: { target: { mode: 'match_min' } }, filter: { field: 'manufacturer', op: '=', value: 'abus' } });
    assert.equal(r.status, 200);
    assert.ok(r.json.decisions.every((d) => d.product_id === seed.products.P4));
    r = await s.post('/api/v1/simulate', { config: { target: { mode: 'nic' } } });
    assert.equal(r.status, 400);
    assert.ok(r.json.error.details.length);
    r = await s.post('/api/v1/simulate', { config: {}, filter: { field: 'a', op: '?' } });
    assert.equal(r.status, 400);
    r = await s.post('/api/v1/simulate', { config: {}, segment_id: 999 });
    assert.equal(r.status, 400);
  });

  await t.test('GET /fields = FIELDS + attrs.*', async () => {
    const r = await read.get('/api/v1/fields');
    assert.equal(r.status, 200);
    const keys = r.json.fields.map((f) => f.key);
    for (const k of ['code', 'margin_pct', 'position', 'attrs.N', 'attrs.sezona']) assert.ok(keys.includes(k), k);
    const sez = r.json.fields.find((f) => f.key === 'attrs.sezona');
    assert.equal(sez.type, 'number');
    assert.equal(r.json.fields.find((f) => f.key === 'attrs.N').type, 'string');
    assert.equal(r.json.fields.find((f) => f.key === 'position').type, 'enum');
  });

  await t.test('běhy: POST /runs (manual/api), GET /runs, GET /runs/:id', async () => {
    let r = await s.post('/api/v1/runs', {});
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.run_id);
    assert.ok(r.json.stats.products >= 1);
    const run1 = r.json.run_id;
    const admin = app.token(['admin']);
    r = await admin.post('/api/v1/runs', { product_ids: [seed.products.P1] });
    assert.equal(r.status, 200);
    assert.equal(r.json.stats.products, 1);
    const run2 = r.json.run_id;
    r = await s.get('/api/v1/runs');
    assert.equal(r.json.total, 2);
    assert.deepEqual(r.json.items.map((x) => x.id), [run2, run1]);
    assert.equal(r.json.items[0].trigger, 'api');
    assert.equal(r.json.items[1].trigger, 'manual');
    assert.equal(typeof r.json.items[0].stats, 'object');
    r = await s.get('/api/v1/runs?limit=1');
    assert.equal(r.json.items.length, 1);
    r = await s.get(`/api/v1/runs/${run1}`);
    assert.equal(r.json.id, run1);
    assert.equal(r.json.status, 'done');
    assert.ok(r.json.proposals.pending + r.json.proposals.superseded >= 1);
    assert.equal((await s.get('/api/v1/runs/999')).status, 404);
    assert.equal((await s.post('/api/v1/runs', { product_ids: 'vše' })).status, 400);
    assert.equal((await s.post('/api/v1/runs', { product_ids: [] })).status, 400);
    assert.equal((await read.post('/api/v1/runs', {})).status, 403);
    const exp = app.token(['export']);
    assert.equal((await exp.post('/api/v1/runs', {})).status, 403);
  });
});
