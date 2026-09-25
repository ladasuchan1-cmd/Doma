'use strict';
// Testy vývojového mock serveru UI (tools/ui-mock-server.js): bezpečnostní hlavičky, statické soubory,
// přihlášení, CSRF a tvary odpovědí podle SPEC §8.
const test = require('node:test');
const assert = require('node:assert');
const { createMockServer } = require('../tools/ui-mock-server.js');

let m;
let cookie;
const H = () => ({ cookie, 'x-requested-with': 'cenotvorba', 'content-type': 'application/json' });
const api = (p, init = {}) => fetch(m.url + '/api/v1' + p, { ...init, headers: { ...H(), ...(init.headers || {}) } });
const json = async (p, init) => {
  const r = await api(p, init);
  return { status: r.status, body: await r.json(), headers: r.headers };
};

test.before(async () => {
  m = await createMockServer({ port: 0, password: 'tajne' });
});
test.after(async () => {
  await m.close();
});

test('statické soubory, SPA fallback a bezpečnostní hlavičky', async () => {
  const r = await fetch(m.url + '/');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.strictEqual(r.headers.get('content-security-policy'), "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'");
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
  assert.match(await r.text(), /<script type="module" src="app.js">/);
  const js = await fetch(m.url + '/lib/format.js');
  assert.match(js.headers.get('content-type'), /javascript/);
  const spa = await fetch(m.url + '/neco/jineho');
  assert.match(await spa.text(), /<div id="app">/);
  const trav = await fetch(m.url + '/..%2f..%2fpackage.json');
  assert.ok(!(await trav.text()).includes('"cenotvorba"'), 'path traversal');
  const unknown = await fetch(m.url + '/api/v1/neexistuje', { headers: { cookie: cookie || '' } });
  assert.ok([401, 404].includes(unknown.status));
});

test('přihlášení, 401 bez session a CSRF ochrana', async () => {
  let r = await fetch(m.url + '/api/v1/products');
  assert.strictEqual(r.status, 401);
  assert.strictEqual((await r.json()).error.status, 401);
  r = await fetch(m.url + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'spatne' }) });
  assert.strictEqual(r.status, 401);
  assert.match((await r.json()).error.message, /heslo/i);
  r = await fetch(m.url + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'tajne' }) });
  assert.strictEqual(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  const me = await json('/auth/me');
  assert.deepStrictEqual(me.body, { user: 'admin', scopes: ['read', 'import', 'export', 'admin'], via: 'session' });
  // bez X-Requested-With → 403
  r = await fetch(m.url + '/api/v1/proposals/approve', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"ids":[1]}' });
  assert.strictEqual(r.status, 403);
});

test('dashboard, fields, facets – tvary odpovědí', async () => {
  const d = (await json('/dashboard')).body;
  for (const k of ['products', 'position', 'price_index', 'proposals', 'last_run', 'last_imports', 'competitors', 'by_manufacturer', 'alerts']) assert.ok(k in d, k);
  assert.deepStrictEqual(Object.keys(d.position).sort(), ['cheapest', 'middle', 'most_expensive', 'no_data']);
  assert.ok(d.products.active > 50);
  const f = (await json('/fields')).body.fields;
  assert.ok(f.find((x) => x.key === 'position' && x.type === 'enum'));
  assert.ok(f.find((x) => x.key === 'attrs.N' && x.group === 'Atributy'));
  const fc = (await json('/products/facets')).body;
  assert.ok(Array.isArray(fc.manufacturers) && fc.manufacturers[0].value && fc.manufacturers[0].count);
  assert.ok(fc.attrs.N.length);
});

test('produkty: seznam, filtr, řazení, detail, úprava', async () => {
  const l = (await json('/products?limit=5&sort=price&dir=desc')).body;
  assert.deepStrictEqual(Object.keys(l).sort(), ['items', 'limit', 'page', 'total']);
  assert.strictEqual(l.items.length, 5);
  assert.ok(l.items[0].price >= l.items[1].price);
  assert.ok('proposal' in l.items[0] && Array.isArray(l.items[0].segments));
  const flt = encodeURIComponent(JSON.stringify({ all: [{ field: 'manufacturer', op: 'in', value: ['trek'] }] }));
  const t = (await json('/products?limit=500&filter=' + flt)).body;
  assert.ok(t.total > 0 && t.items.every((p) => p.manufacturer === 'Trek'));
  const ids = (await json('/products?status=all&limit=500&filter=' + encodeURIComponent(JSON.stringify({ field: 'id', op: 'in', value: [1, 2] })))).body;
  assert.deepStrictEqual(ids.items.map((p) => p.id).sort(), [1, 2]);
  const det = (await json('/products/1')).body;
  for (const k of ['product', 'offers', 'history', 'explain', 'proposals']) assert.ok(k in det, k);
  assert.ok(Array.isArray(det.history.our) && Array.isArray(det.history.competitors));
  assert.ok('decision' in det.explain && 'segments' in det.explain);
  const upd = await json('/products/1', { method: 'PATCH', body: JSON.stringify({ min_price: 1000, locked: true }) });
  assert.strictEqual(upd.status, 200);
  assert.strictEqual(upd.body.locked, 1);
  assert.strictEqual((await json('/products/1', { method: 'PATCH', body: JSON.stringify({ min_price: -5 }) })).status, 400);
  assert.strictEqual((await json('/products/99999')).status, 404);
});

test('návrhy: seznam se summary, schválení, ruční cena, XLSX', async () => {
  const l = (await json('/proposals?limit=3')).body;
  for (const k of ['items', 'total', 'page', 'limit', 'summary']) assert.ok(k in l, k);
  for (const k of ['pending', 'approved', 'exported_today', 'up', 'down']) assert.ok(k in l.summary, k);
  const p = l.items[0];
  assert.strictEqual(p.status, 'pending');
  assert.ok(p.product && p.product.code && Array.isArray(p.flags) && Array.isArray(p.explain));
  assert.ok(Math.abs(l.items[0].change_pct) >= Math.abs(l.items[1].change_pct), 'výchozí řazení abs_change_pct desc');
  const man = await json('/proposals/' + p.id, { method: 'PATCH', body: JSON.stringify({ manual_price: 999 }) });
  assert.strictEqual(man.body.manual_price, 999);
  const ap = await json('/proposals/approve', { method: 'POST', body: JSON.stringify({ ids: [p.id] }) });
  assert.deepStrictEqual(ap.body, { updated: 1 });
  const again = await json('/proposals/approve', { method: 'POST', body: JSON.stringify({ ids: [p.id] }) });
  assert.deepStrictEqual(again.body, { updated: 0 }, 'jen čekající');
  const before = (await json('/proposals?limit=1&direction=up')).body.total;
  const all = await json('/proposals/approve', { method: 'POST', body: JSON.stringify({ all: true, filter: { direction: 'up' } }) });
  assert.strictEqual(all.body.updated, before);
  const x = await api('/export/proposals.xlsx?status=approved');
  assert.strictEqual(x.status, 200);
  assert.match(x.headers.get('content-disposition'), /attachment/);
});

test('strategie, předvolby, simulace, přecenění, segmenty', async () => {
  const s = (await json('/strategies')).body.items;
  assert.ok(s.length >= 4 && s[0].config.target);
  const ro = await json('/strategies/reorder', { method: 'POST', body: JSON.stringify({ ids: s.map((x) => x.id).reverse() }) });
  assert.strictEqual(ro.status, 200);
  assert.strictEqual((await json('/strategies/' + s[0].id)).body.priority, s.length * 10);
  const bad = await json('/strategies', { method: 'POST', body: JSON.stringify({ name: 'x', config: { limits: { min_margin_pct: 100 } } }) });
  assert.strictEqual(bad.status, 400);
  assert.ok(Array.isArray(bad.body.error.details));
  const pr = (await json('/strategies/presets')).body.items;
  assert.ok(pr.length >= 4 && pr.every((x) => x.key && x.name && x.config));
  const created = (await json('/strategies/presets/' + pr[0].key, { method: 'POST', body: '{}' })).body;
  assert.ok(created.strategy.id && created.segment.id);
  const sim = (await json('/simulate', { method: 'POST', body: JSON.stringify({ config: { target: { mode: 'match_min' } }, segment_id: 2 }) })).body;
  assert.ok(sim.stats.products > 0 && Array.isArray(sim.decisions));
  assert.ok(sim.decisions.every((d) => d.action !== 'no_change' && Array.isArray(d.explain)));
  const run = (await json('/runs', { method: 'POST', body: '{}' })).body;
  assert.ok(run.run_id && run.stats.evaluated > 0);
  const prev = (await json('/segments/preview', { method: 'POST', body: JSON.stringify({ filter: { all: [{ field: 'market_count', op: '=', value: 0 }] } }) })).body;
  assert.deepStrictEqual(Object.keys(prev).sort(), ['count', 'errors', 'sample']);
  const badPrev = (await json('/segments/preview', { method: 'POST', body: JSON.stringify({ filter: { all: [{ field: 'a', op: '~' }] } }) })).body;
  assert.ok(badPrev.errors.length);
  const del = await json('/segments/1', { method: 'DELETE' });
  assert.strictEqual(del.status, 409, 'segment používaný strategií nelze smazat');
});

test('import: náhled CSV a zkušební/ostrý import', async () => {
  const csv = 'EAN;Obchod;Cena s DPH\n' + '8599999000011;VeloMarket.cz;20 490 Kč\n' + 'XYZ;KoloExpres.cz;abc\n';
  const pv = await fetch(m.url + '/api/v1/import/preview?kind=offers', { method: 'POST', headers: { cookie, 'x-requested-with': 'cenotvorba', 'content-type': 'text/csv' }, body: csv });
  const p = await pv.json();
  assert.strictEqual(p.format, 'csv');
  assert.deepStrictEqual(p.headers, ['EAN', 'Obchod', 'Cena s DPH']);
  assert.deepStrictEqual(p.suggested, { ean: 'EAN', price: 'Cena s DPH', competitor: 'Obchod' });
  assert.strictEqual(p.canonical[0].price, 20490);
  assert.strictEqual(p.errors.length, 1);
  const dry = await (await fetch(m.url + '/api/v1/import/offers?dry_run=1', { method: 'POST', headers: { cookie, 'x-requested-with': 'cenotvorba', 'content-type': 'text/csv' }, body: csv })).json();
  assert.strictEqual(dry.import_id, null);
  assert.strictEqual(dry.stats.received, 2);
  const js = await json('/import/offers', { method: 'POST', body: JSON.stringify({ items: [{ code: 'TRK-MAR7GEN3-M', competitor: 'Nový obchod', price: 19990 }] }) });
  assert.ok(js.body.import_id);
  assert.strictEqual(js.body.stats.competitors_created, 1);
  const log = (await json('/imports')).body.items;
  assert.strictEqual(log[0].id, js.body.import_id);
});

test('tvary odpovědí jako skutečné API: konfigurace strategií, booleany, final_price, upozornění, tried', async () => {
  const s = (await json('/strategies/1')).body;
  assert.deepStrictEqual(s.config.schedule, { valid_from: null, valid_to: null, weekdays: [], hours: null });
  assert.deepStrictEqual(s.config.competitors.exclude_keywords, []);
  assert.strictEqual(typeof s.enabled, 'boolean');
  const list = (await json('/strategies')).body.items;
  assert.ok(list.some((x) => x.config.conditions && Object.keys(x.config.conditions).length), 'strategie s podmínkami');
  assert.ok(list.some((x) => x.config.schedule.weekdays.length), 'strategie s časovým oknem');
  const comps = (await json('/competitors')).body.items;
  assert.ok(comps.every((c) => typeof c.enabled === 'boolean'));
  const props = (await json('/proposals?limit=5')).body.items;
  for (const pr of props) {
    assert.strictEqual(pr.final_price, pr.manual_price ?? pr.new_price);
    assert.ok('final_change_pct' in pr && 'final_margin_pct' in pr && 'vat_rate' in pr.product);
  }
  const d = (await json('/dashboard')).body;
  const types = new Set(['below_cost', 'no_cost', 'zero_price', 'competitor_drop', 'stale_offers', 'not_applied', 'min_below_cost', 'unmatched']);
  assert.ok(d.alerts.length > 0);
  for (const a of d.alerts) {
    assert.ok(types.has(a.type), 'typ upozornění ' + a.type);
    assert.ok(['error', 'warn', 'info'].includes(a.severity));
    assert.ok(a.count > 0 && a.text && (!a.link || a.link.startsWith('#/')));
  }
  const detail = (await json('/products/1')).body;
  assert.ok(Array.isArray(detail.explain.tried) && detail.explain.tried.length > 0);
  assert.strictEqual(typeof detail.product.lock_active, 'boolean');
});

test('export, feed s tokenem, tokeny, nastavení, audit', async () => {
  const tok = (await json('/tokens', { method: 'POST', body: JSON.stringify({ name: 'feed', scopes: ['export'] }) })).body;
  assert.match(tok.token, /^ct_[A-Za-z0-9]{32}$/);
  assert.strictEqual(tok.prefix, tok.token.slice(0, 7));
  const list = (await json('/tokens')).body.items;
  assert.ok(list.every((t) => !('token' in t) && !('_token' in t)), 'tokeny se nevrací');
  let r = await fetch(m.url + '/feed/changes.json');
  assert.strictEqual(r.status, 401);
  r = await fetch(m.url + '/feed/changes.json?token=' + tok.token);
  const feed = await r.json();
  assert.ok(Array.isArray(feed.items) && 'generated' in feed && feed.currency === 'CZK');
  r = await fetch(m.url + '/api/v1/export/changes.csv', { headers: { authorization: 'Bearer ' + tok.token } });
  const buf = Buffer.from(await r.arrayBuffer());
  assert.deepStrictEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'CSV s BOM pro Excel');
  assert.match(buf.toString('utf8').slice(1), /^code;ean;name;price/);
  const s = await json('/settings', { method: 'PUT', body: JSON.stringify({ export: { webhook: { url: 'https://admin.example/hook' } } }) });
  assert.strictEqual(s.body.export.webhook.url, 'https://admin.example/hook');
  assert.strictEqual(s.body.export.xml.root, 'prices', 'deep merge zachová ostatní');
  const push = (await json('/export/push', { method: 'POST', body: '{}' })).body;
  assert.strictEqual(push.ok, true);
  const exps = (await json('/exports')).body.items;
  assert.strictEqual(exps[0].kind, 'webhook');
  assert.ok((await json('/audit')).body.items.length > 0);
  assert.strictEqual((await json('/settings/password', { method: 'POST', body: JSON.stringify({ current: 'x', new: '12345678' }) })).status, 400);
});
