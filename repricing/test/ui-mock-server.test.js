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
  assert.ok(f.find((x) => x.key === 'attrs.N' && x.group === 'Vlastní atributy'));
  assert.ok(f.find((x) => x.key === 'group_code' && x.group === 'Produkt'), 'C3: skupina / model');
  assert.strictEqual(f.find((x) => x.key === 'price').unit, 'Kč');
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
  const l = (await json('/proposals?limit=30')).body;
  for (const k of ['items', 'total', 'page', 'limit', 'summary']) assert.ok(k in l, k);
  for (const k of ['pending', 'approved', 'exported_today', 'up', 'down']) assert.ok(k in l.summary, k);
  // návrh dražšího produktu – ruční cena 999 Kč je u něj „velká změna“ (překlep?)
  const p = l.items.find((x) => x.old_price >= 3000);
  assert.ok(p, 'návrh s cenou nad 3 000 Kč');
  assert.strictEqual(p.status, 'pending');
  assert.ok(p.product && p.product.code && Array.isArray(p.flags) && Array.isArray(p.explain));
  assert.ok(Math.abs(l.items[0].change_pct) >= Math.abs(l.items[1].change_pct), 'výchozí řazení abs_change_pct desc');
  // riziková ruční cena (velká změna – překlep?) bez potvrzení → 409 MANUAL_PRICE_CONFIRM jako skutečné API
  const risky = await json('/proposals/' + p.id, { method: 'PATCH', body: JSON.stringify({ manual_price: 999 }) });
  assert.strictEqual(risky.status, 409);
  assert.strictEqual(risky.body.error.details.code, 'MANUAL_PRICE_CONFIRM');
  assert.ok(risky.body.error.details.reasons.length);
  const man = await json('/proposals/' + p.id, { method: 'PATCH', body: JSON.stringify({ manual_price: 999, confirm: true }) });
  assert.strictEqual(man.body.manual_price, 999);
  const ap = await json('/proposals/approve', { method: 'POST', body: JSON.stringify({ ids: [p.id] }) });
  assert.deepStrictEqual(ap.body, { updated: 1 });
  const again = await json('/proposals/approve', { method: 'POST', body: JSON.stringify({ ids: [p.id] }) });
  assert.deepStrictEqual(again.body, { updated: 0 }, 'jen čekající');
  // schválený (neexportovaný) návrh jde zamítnout – jako skutečné API (contract-10)
  const rej = await json('/proposals/reject', { method: 'POST', body: JSON.stringify({ ids: [p.id] }) });
  assert.deepStrictEqual(rej.body, { updated: 1 });
  assert.strictEqual((await json('/proposals?status=rejected&limit=500')).body.items.some((x) => x.id === p.id), true);
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

// ------------------------------------------------------------------ nový kontrakt C1–C10
test('C9: jméno při přihlášení → /auth/me, decided_by a audit; neplatné jméno 400', async () => {
  const bad = await fetch(m.url + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'tajne', name: 'auto' }) });
  assert.strictEqual(bad.status, 400);
  const r = await fetch(m.url + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'tajne', name: '  Jana Dvořáková ' }) });
  assert.strictEqual(r.status, 200);
  const jana = r.headers.get('set-cookie').split(';')[0];
  const J = (p, init = {}) => fetch(m.url + '/api/v1' + p, { ...init, headers: { cookie: jana, 'x-requested-with': 'cenotvorba', 'content-type': 'application/json' } }).then(async (x) => ({ status: x.status, body: await x.json() }));
  assert.strictEqual((await J('/auth/me')).body.user, 'Jana Dvořáková');
  const p = (await J('/proposals?limit=1')).body.items[0];
  assert.deepStrictEqual((await J('/proposals/approve', { method: 'POST', body: JSON.stringify({ ids: [p.id] }) })).body, { updated: 1 });
  const after = (await J('/proposals?status=approved&limit=500')).body.items.find((x) => x.id === p.id);
  assert.strictEqual(after.decided_by, 'Jana Dvořáková');
  assert.strictEqual((await J('/audit')).body.items.some((a) => a.actor === 'Jana Dvořáková' && a.action === 'proposals.approve'), true);
  // C5: vrátit ke schválení
  assert.deepStrictEqual((await J('/proposals/unapprove', { method: 'POST', body: JSON.stringify({ ids: [p.id] }) })).body, { updated: 1 });
  const back = (await J('/proposals?status=pending&limit=500')).body.items.find((x) => x.id === p.id);
  assert.ok(back && back.decided_at == null && back.decided_by == null, 'znovu čeká, rozhodnutí smazané');
  assert.deepStrictEqual((await J('/proposals/unapprove', { method: 'POST', body: JSON.stringify({ ids: [p.id] }) })).body, { updated: 0 }, 'jen schválené');
});

test('C3/C1: pole group_code, řazení podle atributu a skupiny, sjednocení skupin v přecenění', async () => {
  const f = (await json('/fields')).body.fields;
  assert.ok(f.some((x) => x.key === 'sales_30' && x.unit === 'ks') && f.some((x) => x.key === 'msrp' && x.unit === 'Kč'));
  const byAttr = (await json('/products?limit=10&sort=attrs.N&dir=desc')).body.items.map((x) => x.attrs.N).filter(Boolean);
  assert.deepStrictEqual(byAttr, [...byAttr].sort().reverse(), 'řazení podle attrs.N');
  const byGroup = (await json('/products?limit=500&sort=group_code')).body.items;
  assert.ok(byGroup.some((x) => x.group_code), 'kola mají skupinu / model');
  const g = byGroup.find((x) => x.group_code).group_code;
  const members = (await json('/products?limit=500&filter=' + encodeURIComponent(JSON.stringify({ field: 'group_code', op: '=', value: g })))).body.items;
  assert.ok(members.length >= 2 && members.every((x) => x.group_code === g), 'filtr podle skupiny');
  // čerstvá data (předchozí testy mění pořadí strategií): „Klíčové značky“ sjednocují velikosti na nejvyšší cenu
  const fresh = await createMockServer({ port: 0, autologin: true });
  try {
    const dry = await (await fetch(fresh.url + '/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'cenotvorba' }, body: JSON.stringify({ dry_run: true }) })).json();
    assert.ok(dry.stats.flags.group_aligned > 0, 'strategie se sjednocením skupin');
    const aligned = dry.sample.filter((d) => d.flags.includes('group_aligned'));
    assert.ok(aligned.length > 0 && aligned.every((d) => d.group && d.group.code && d.explain.some((e) => e.step === 'group' && /^Sjednoceno ve skupině /.test(e.text))));
    const byGroup = new Map();
    for (const d of aligned) byGroup.set(d.group.code, [...(byGroup.get(d.group.code) || []), d.new_price]);
    for (const prices of byGroup.values()) assert.strictEqual(new Set(prices).size, 1, 'varianty jednoho modelu mají stejnou cenu');
  } finally {
    await fresh.close();
  }
});

test('C2: simulace celého přecenění nic nezapíše; kontextová simulace strategie hlásí zabrané produkty', async () => {
  const runsBefore = (await json('/runs')).body.total;
  const propsBefore = (await json('/proposals?status=all&limit=1')).body.total;
  const dry = await json('/runs', { method: 'POST', body: JSON.stringify({ dry_run: true }) });
  assert.strictEqual(dry.status, 200);
  assert.strictEqual(dry.body.run_id, null);
  assert.strictEqual(dry.body.dry_run, true);
  assert.ok(dry.body.stats.products > 0 && dry.body.sample.length > 0 && dry.body.sample.length <= 200);
  const pcts = dry.body.sample.map((d) => Math.abs(d.change_pct));
  assert.deepStrictEqual(pcts, [...pcts].sort((a, b) => b - a), 'seřazeno podle |change_pct| sestupně');
  assert.deepStrictEqual(Object.keys(dry.body.sample[0].product).sort(), ['category', 'code', 'id', 'manufacturer', 'name']);
  assert.strictEqual((await json('/runs')).body.total, runsBefore, 'žádný běh');
  assert.strictEqual((await json('/proposals?status=all&limit=1')).body.total, propsBefore, 'žádné návrhy');
  assert.strictEqual((await json('/runs', { method: 'POST', body: JSON.stringify({ dry_run: 'ano' }) })).status, 400);
  const strategies = (await json('/strategies')).body.items;
  const later = strategies.filter((s) => s.enabled).sort((a, b) => a.priority - b.priority).at(-1);
  const ctxSim = (await json('/simulate', { method: 'POST', body: JSON.stringify({ strategy_id: later.id, config: later.config }) })).body;
  assert.strictEqual(ctxSim.context, true);
  assert.ok(Number.isInteger(ctxSim.stats.claimed_by_earlier));
  assert.ok(ctxSim.decisions.every((d) => d.strategy_id === later.id));
  const plain = (await json('/simulate', { method: 'POST', body: JSON.stringify({ config: later.config }) })).body;
  assert.strictEqual(plain.context, false);
  assert.strictEqual('claimed_by_earlier' in plain.stats, false);
  assert.strictEqual((await json('/simulate', { method: 'POST', body: JSON.stringify({ strategy_id: 99999, config: {} }) })).status, 400);
});

test('C4: filtry návrhů podle produktu (osoba, kategorie, dodavatel, segment produktu, filtr) i pro hromadné akce', async () => {
  const all = (await json('/proposals?limit=500')).body;
  const owner = all.items.find((x) => x.product && x.product.code) && (await json('/products/facets')).body.owners[0].value;
  const byOwner = (await json('/proposals?limit=500&owner=' + encodeURIComponent(owner.toUpperCase()))).body;
  assert.ok(byOwner.total > 0 && byOwner.total < all.total, 'osoba bez ohledu na velikost písmen');
  const seg = (await json('/segments')).body.items[0];
  const bySeg = (await json('/proposals?limit=500&product_segment=' + seg.id)).body;
  assert.ok(bySeg.total <= all.total);
  assert.strictEqual((await json('/proposals?product_segment=99999')).body.total, 0, 'neznámý segment = nic');
  assert.strictEqual((await json('/proposals?filter=' + encodeURIComponent('{nejde'))).status, 400);
  const flt = encodeURIComponent(JSON.stringify({ field: 'stock', op: '>', value: 0 }));
  const inStock = (await json('/proposals?limit=500&filter=' + flt)).body;
  assert.ok(inStock.items.every((x) => x.product.stock > 0));
  // hromadné zamítnutí jen pro osobu
  const rej = await json('/proposals/reject', { method: 'POST', body: JSON.stringify({ all: true, filter: { status: 'pending', owner }, expect: { count: byOwner.total, max_id: byOwner.max_id } }) });
  assert.strictEqual(rej.body.updated, byOwner.total);
  assert.strictEqual((await json('/proposals?owner=' + encodeURIComponent(owner))).body.total, 0);
});

test('C1: zamítnutá cena se v dalším přecenění znovu nenavrhne (rejected_before); reject_memory_days 0 = vypnuto', async () => {
  const p = (await json('/proposals?limit=1')).body.items[0];
  await json('/proposals/reject', { method: 'POST', body: JSON.stringify({ ids: [p.id] }) });
  const run = (await json('/runs', { method: 'POST', body: JSON.stringify({ product_ids: [p.product_id] }) })).body;
  assert.strictEqual(run.stats.changes, 0);
  assert.strictEqual(run.stats.no_change_reasons.rejected_before, 1);
  assert.strictEqual((await json('/settings', { method: 'PUT', body: JSON.stringify({ reject_memory_days: 400 }) })).status, 400);
  assert.strictEqual((await json('/settings', { method: 'PUT', body: JSON.stringify({ reject_memory_days: 0 }) })).body.reject_memory_days, 0);
  const run2 = (await json('/runs', { method: 'POST', body: JSON.stringify({ product_ids: [p.product_id] }) })).body;
  assert.strictEqual(run2.stats.changes, 1, 'bez paměti se cena navrhne znovu');
  await json('/settings', { method: 'PUT', body: JSON.stringify({ reject_memory_days: 14 }) });
});

test('C6: import katalogu jen pro existující produkty (create_missing=0)', async () => {
  const csv = 'Kód;Název;Cena\nTRK-MAR7GEN3-M;Trek Marlin 7;20990\nNEZNAMY-1;Nový;1000\nNEZNAMY-2;Nový 2;1000\n';
  const post = (q) => fetch(m.url + '/api/v1/import/products' + q, { method: 'POST', headers: { cookie, 'x-requested-with': 'cenotvorba', 'content-type': 'text/csv' }, body: csv }).then(async (x) => ({ status: x.status, body: await x.json() }));
  const r = await post('?create_missing=0');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.stats.created, 0);
  assert.strictEqual(r.body.stats.skipped_unknown, 2);
  assert.deepStrictEqual(r.body.stats.unknown_codes, ['NEZNAMY-1', 'NEZNAMY-2']);
  assert.strictEqual((await json('/products?q=NEZNAMY')).body.total, 0);
  assert.strictEqual((await post('?create_missing=nevim')).status, 400);
});

test('C8: historie exportů – redownload a znovu stažení doručených změn (json/xml/csv), 404 bez řádků', async () => {
  const exps = (await json('/exports')).body.items;
  const withRows = exps.find((e) => e.redownload);
  assert.ok(withRows, 'export s doručenými změnami');
  assert.ok(exps.every((e) => typeof e.redownload === 'boolean'));
  const tok = (await json('/tokens', { method: 'POST', body: JSON.stringify({ name: 'admin feed', scopes: ['export'] }) })).body.token;
  const get = (p, t = tok) => fetch(m.url + '/api/v1' + p, { headers: { authorization: 'Bearer ' + t } });
  const jr = await get('/exports/' + withRows.id + '/changes.json');
  assert.strictEqual(jr.status, 200);
  assert.strictEqual(jr.headers.get('x-export-id'), String(withRows.id));
  const body = await jr.json();
  assert.ok(body.items.length > 0 && body.items.every((i) => i.proposal_id && i.code && i.price > 0));
  assert.match(await (await get('/exports/' + withRows.id + '/changes.xml')).text(), /<prices /);
  assert.match(await (await get('/exports/' + withRows.id + '/changes.csv')).text(), /^﻿?code;ean;name;price/);
  const without = exps.find((e) => !e.redownload);
  assert.strictEqual((await get('/exports/' + without.id + '/changes.json')).status, 404);
  assert.strictEqual((await get('/exports/99999/changes.json')).status, 404);
  const readTok = (await json('/tokens', { method: 'POST', body: JSON.stringify({ name: 'jen čtení', scopes: ['read'] }) })).body.token;
  assert.strictEqual((await get('/exports/' + withRows.id + '/changes.json', readTok)).status, 403, 'vyžaduje oprávnění export');
});

test('C10: nastavení obsahuje paměť zamítnutí, uchování nahrazených a ceny hladiny s DPH', async () => {
  const s = (await json('/settings')).body;
  assert.strictEqual(s.reject_memory_days, 14);
  assert.strictEqual(s.retention_superseded_days, 14);
  assert.strictEqual(s.export.pohoda.price_level_includes_vat, true);
  assert.strictEqual((await json('/settings', { method: 'PUT', body: JSON.stringify({ retention_superseded_days: 0 }) })).status, 400);
  assert.strictEqual((await json('/settings', { method: 'PUT', body: JSON.stringify({ export: { pohoda: { price_level_includes_vat: 'ano' } } }) })).status, 400);
});
