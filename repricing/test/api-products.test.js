'use strict';
// Integrační testy API: produkty (seznam, filtry, řazení, stránkování, facety, detail, PATCH) a oprávnění.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./api-routes-helpers');

test('API produkty', async (t) => {
  const app = await H.startApp();
  t.after(() => app.stop());
  const seed = H.seedBasic(app.db);
  const s = app.session();
  const P = seed.products;

  await t.test('seznam: tvar položky, výchozí aktivní produkty seřazené podle kódu', async () => {
    const r = await s.get('/api/v1/products');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ['items', 'limit', 'page', 'total']);
    assert.equal(r.json.total, 5); // P5 je neaktivní
    assert.equal(r.json.page, 1);
    assert.equal(r.json.limit, 50);
    assert.deepEqual(r.json.items.map((x) => x.code), ['P1', 'P2', 'P3', 'P4', 'P6']);
    const p1 = r.json.items[0];
    for (const k of ['id', 'code', 'name', 'price', 'purchase_price', 'margin_pct', 'market_min', 'market_count', 'price_index', 'position', 'rank', 'attrs', 'lock_active', 'proposal', 'segments']) {
      assert.ok(k in p1, `chybí ${k}`);
    }
    assert.equal(p1.market_count, 2, 'vypnutý konkurent se nepočítá');
    assert.equal(p1.market_min, 76990);
    assert.equal(p1.position, 'most_expensive');
    assert.equal(p1.proposal, null);
    assert.deepEqual(p1.segments, [seed.segments.focus]);
    assert.deepEqual(p1.attrs, { N: 'N2', sezona: 2026 });
  });

  await t.test('status inactive / all', async () => {
    let r = await s.get('/api/v1/products?status=inactive');
    assert.deepEqual(r.json.items.map((x) => x.code), ['P5']);
    r = await s.get('/api/v1/products?status=all');
    assert.equal(r.json.total, 6);
    r = await s.get('/api/v1/products?status=smazane');
    assert.equal(r.status, 400);
  });

  await t.test('hledání q bez diakritiky a velikosti písmen (kód, název, EAN)', async () => {
    let r = await s.get('/api/v1/products?q=' + encodeURIComponent('ASPERO'));
    assert.deepEqual(r.json.items.map((x) => x.code), ['P2']);
    r = await s.get('/api/v1/products?q=zluta');
    assert.deepEqual(r.json.items.map((x) => x.code), ['P6']);
    r = await s.get('/api/v1/products?q=8590000000035');
    assert.deepEqual(r.json.items.map((x) => x.code), ['P3']);
    r = await s.get('/api/v1/products?q=p4');
    assert.deepEqual(r.json.items.map((x) => x.code), ['P4']);
  });

  await t.test('facetové filtry: přesná shoda bez ohledu na velikost písmen a diakritiku', async () => {
    let r = await s.get('/api/v1/products?manufacturer=cervelo');
    assert.deepEqual(r.json.items.map((x) => x.code), ['P2']);
    r = await s.get('/api/v1/products?manufacturer=Cerv');
    assert.equal(r.json.total, 0, 'jen přesná shoda');
    r = await s.get('/api/v1/products?category=' + encodeURIComponent('příslušenství'));
    assert.deepEqual(r.json.items.map((x) => x.code), ['P4', 'P6']);
    r = await s.get('/api/v1/products?owner=LUCIE&supplier=abus%20cz');
    assert.deepEqual(r.json.items.map((x) => x.code), ['P4']);
  });

  await t.test('segment, pozice, filtr JSON', async () => {
    let r = await s.get(`/api/v1/products?segment=${seed.segments.lezaky}`);
    assert.deepEqual(r.json.items.map((x) => x.code), ['P2', 'P4']);
    r = await s.get('/api/v1/products?segment=999');
    assert.equal(r.status, 400);
    r = await s.get('/api/v1/products?segment=abc');
    assert.equal(r.status, 400);
    r = await s.get('/api/v1/products?position=cheapest');
    assert.deepEqual(r.json.items.map((x) => x.code), ['P2']);
    r = await s.get('/api/v1/products?position=no_data,cheapest');
    assert.deepEqual(r.json.items.map((x) => x.code), ['P2', 'P6']);
    r = await s.get('/api/v1/products?position=levne');
    assert.equal(r.status, 400);
    r = await s.get('/api/v1/products' + H.qs({ filter: { all: [{ field: 'margin_pct', op: '>', value: 20 }, { field: 'attrs.N', op: 'in', value: 'N1,N2' }] } }));
    assert.deepEqual(r.json.items.map((x) => x.code), ['P1', 'P3']);
    r = await s.get('/api/v1/products?filter=' + encodeURIComponent('{"field":'));
    assert.equal(r.status, 400);
    assert.match(r.json.error.message, /JSON/);
    r = await s.get('/api/v1/products' + H.qs({ filter: { field: 'price', op: 'podobne', value: 1 } }));
    assert.equal(r.status, 400);
    assert.match(r.json.error.message, /operátor/);
    assert.ok(Array.isArray(r.json.error.details));
  });

  await t.test('řazení: čísla číselně, texty česky, prázdné na konci, dir', async () => {
    let r = await s.get('/api/v1/products?sort=price&dir=desc');
    assert.deepEqual(r.json.items.map((x) => x.code), ['P1', 'P2', 'P4', 'P3', 'P6']);
    r = await s.get('/api/v1/products?sort=market_min');
    assert.deepEqual(r.json.items.map((x) => x.code), ['P3', 'P4', 'P2', 'P1', 'P6'], 'P6 bez trhu na konci');
    r = await s.get('/api/v1/products?sort=market_min&dir=desc');
    assert.equal(r.json.items.at(-1).code, 'P6', 'null i při desc na konci');
    r = await s.get('/api/v1/products?sort=manufacturer');
    assert.deepEqual(r.json.items.map((x) => x.manufacturer), ['Abus', 'Cervélo', 'Elite', 'Focus', 'Schwalbe']);
    r = await s.get('/api/v1/products?sort=name');
    // česká kolace: „Ž“ až za „S“
    assert.deepEqual(r.json.items.map((x) => x.code), ['P4', 'P2', 'P1', 'P3', 'P6']);
    r = await s.get('/api/v1/products?sort=attrs.sezona&dir=desc');
    assert.equal(r.json.items[0].attrs.sezona, 2026);
    assert.equal(r.json.items.at(-1).code, 'P6');
    r = await s.get('/api/v1/products?sort=neexistuje');
    assert.equal(r.status, 400);
    r = await s.get('/api/v1/products?dir=nahoru');
    assert.equal(r.status, 400);
  });

  await t.test('stránkování a limit (max 500)', async () => {
    let r = await s.get('/api/v1/products?limit=2&page=2');
    assert.deepEqual(r.json.items.map((x) => x.code), ['P3', 'P4']);
    assert.equal(r.json.total, 5);
    assert.equal(r.json.page, 2);
    assert.equal(r.json.limit, 2);
    r = await s.get('/api/v1/products?limit=10000');
    assert.equal(r.json.limit, 500);
    r = await s.get('/api/v1/products?page=x');
    assert.equal(r.status, 400);
  });

  await t.test('has_proposal a návrh v položce', async () => {
    const run = await s.post('/api/v1/runs', {});
    assert.equal(run.status, 200);
    const r = await s.get('/api/v1/products?has_proposal=1');
    assert.ok(r.json.total >= 1);
    for (const it of r.json.items) {
      assert.ok(it.proposal);
      assert.deepEqual(Object.keys(it.proposal).sort(), ['change_pct', 'final_change_pct', 'final_price', 'id', 'manual_price', 'new_price', 'status'].sort());
      assert.equal(it.proposal.status, 'pending');
    }
    const all = await s.get('/api/v1/products');
    assert.ok(all.json.total > r.json.total || all.json.items.every((x) => x.proposal));
    const sorted = await s.get('/api/v1/products?sort=proposal.change_pct&dir=asc');
    assert.equal(sorted.status, 200);
  });

  await t.test('facety', async () => {
    const r = await s.get('/api/v1/products/facets');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ['attrs', 'categories', 'manufacturers', 'owners', 'suppliers']);
    assert.deepEqual(r.json.categories[0], { value: 'Příslušenství', count: 2 });
    assert.ok(!r.json.manufacturers.some((m) => m.count === 2 && m.value === 'Focus'), 'neaktivní P5 se nepočítá');
    assert.ok(Array.isArray(r.json.attrs.N));
    assert.ok(r.json.attrs.N.find((x) => x.value === 'N7'));
  });

  await t.test('detail produktu', async () => {
    const r = await s.get(`/api/v1/products/${P.P1}`);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ['explain', 'history', 'offers', 'product', 'proposals']);
    assert.equal(r.json.product.code, 'P1');
    assert.equal(r.json.offers.length, 3);
    const off = r.json.offers.find((o) => o.competitor === 'Vypnutý.cz');
    assert.equal(off.excluded, 'disabled');
    assert.equal(off.competitor_enabled, false);
    assert.ok(off.excluded_label);
    const used = r.json.offers.find((o) => o.competitor === 'VeloMarket.cz');
    assert.equal(used.excluded, null);
    assert.deepEqual(used.tags, ['klíčový']);
    assert.ok(Array.isArray(r.json.history.our));
    assert.ok(Array.isArray(r.json.history.competitors));
    assert.ok(r.json.explain.view);
    assert.ok(Array.isArray(r.json.explain.segments));
    assert.equal(r.json.explain.strategy.name, 'Podstřel minimum');
    assert.ok(r.json.explain.decision);
    assert.ok(Array.isArray(r.json.proposals));
    assert.equal(r.json.proposals[0].product.code, 'P1');
    assert.ok(Array.isArray(r.json.proposals[0].flags));
    let x = await s.get('/api/v1/products/9999');
    assert.equal(x.status, 404);
    x = await s.get('/api/v1/products/abc');
    assert.equal(x.status, 400);
  });

  await t.test('PATCH: zámek, limity, poznámka, validace', async () => {
    let r = await s.patch(`/api/v1/products/${P.P3}`, { locked: true, min_price: 1000, max_price: 1500, note: '  Akce do konce měsíce  ' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.locked, 1);
    assert.equal(r.json.lock_active, true);
    assert.equal(r.json.min_price, 1000);
    assert.equal(r.json.max_price, 1500);
    assert.equal(r.json.note, 'Akce do konce měsíce');
    // seznam vidí změnu (cache se přepočítá)
    let list = await s.get('/api/v1/products?q=P3');
    assert.equal(list.json.items[0].lock_active, true);
    assert.equal(list.json.items[0].note, 'Akce do konce měsíce');
    list = await s.get('/api/v1/products' + H.qs({ filter: { field: 'lock_active', op: 'is_true' } }));
    assert.deepEqual(list.json.items.map((x) => x.code), ['P3']);

    r = await s.patch(`/api/v1/products/${P.P3}`, { locked: false, min_price: null });
    assert.equal(r.json.locked, 0);
    assert.equal(r.json.min_price, null);

    const future = new Date(Date.now() + 86400000).toISOString();
    r = await s.patch(`/api/v1/products/${P.P3}`, { locked_until: future });
    assert.equal(r.json.locked, 1, 'locked_until bez locked zamkne');
    assert.equal(r.json.locked_until, future);
    assert.equal(r.json.lock_active, true);
    r = await s.patch(`/api/v1/products/${P.P3}`, { locked_until: new Date(Date.now() - 86400000).toISOString() });
    assert.equal(r.json.lock_active, false, 'zámek s prošlým datem neplatí');

    for (const bad of [{ min_price: 0 }, { max_price: -5 }, { price: 'abc' }, { price: null }, { min_price: 2000, max_price: 1000 }, { locked: 'možná' }, { locked_until: 'zítra' }, { code: 'X' }]) {
      r = await s.patch(`/api/v1/products/${P.P3}`, bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.ok(r.json.error.message);
    }
    r = await s.patch('/api/v1/products/9999', { note: 'x' });
    assert.equal(r.status, 404);
  });

  await t.test('PATCH price = ruční změna ceny → price_history manual', async () => {
    const r = await s.patch(`/api/v1/products/${P.P6}`, { price: 249 });
    assert.equal(r.status, 200);
    assert.equal(r.json.price, 249);
    assert.ok(r.json.price_changed_at);
    const h = app.db.prepare('SELECT * FROM price_history WHERE product_id = ? ORDER BY id').all(P.P6);
    // dosavadní cena (výchozí záznam pro Omnibus lowest_30d) + ruční změna
    assert.equal(h.length, 2);
    assert.equal(h[0].source, 'import');
    assert.equal(h[1].source, 'manual');
    assert.equal(h[1].price, 249);
    const d = await s.get(`/api/v1/products/${P.P6}`);
    assert.equal(d.json.history.our.length, 2);
    assert.equal(d.json.product.price, 249);
    const list = await s.get('/api/v1/products?q=P6');
    assert.equal(list.json.items[0].price, 249);
    const audit = app.db.prepare("SELECT * FROM audit WHERE action = 'product.update' AND entity_id = ?").all(P.P6);
    assert.equal(audit.length, 1);
    assert.match(audit[0].detail, /"price"/);
  });

  await t.test('oprávnění: bez přihlášení 401, token read čte, ale nemění (403), CSRF', async () => {
    const anon = app.anon();
    let r = await anon.get('/api/v1/products');
    assert.equal(r.status, 401);
    const read = app.token(['read']);
    r = await read.get('/api/v1/products');
    assert.equal(r.status, 200);
    r = await read.get('/api/v1/products/facets');
    assert.equal(r.status, 200);
    r = await read.patch(`/api/v1/products/${P.P1}`, { note: 'x' });
    assert.equal(r.status, 403);
    const imp = app.token(['import']);
    r = await imp.get('/api/v1/products');
    assert.equal(r.status, 403);
    const admin = app.token(['admin']);
    r = await admin.patch(`/api/v1/products/${P.P1}`, { note: 'token' });
    assert.equal(r.status, 200);
    r = await s.patch(`/api/v1/products/${P.P1}`, { note: 'bez hlavičky' }, { csrf: false });
    assert.equal(r.status, 403);
  });
});
