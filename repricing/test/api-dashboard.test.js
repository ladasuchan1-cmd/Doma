'use strict';
// Integrační testy API: přehled (tvar + všechny typy upozornění), nastavení (GET/PUT, validace), audit.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./api-routes-helpers');
const { DEFAULT_SETTINGS, getSettings, nowIso } = require('../src/db');

const DAY = 86400000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

test('API přehled', async (t) => {
  const app = await H.startApp();
  t.after(() => app.stop());
  const s = app.session();

  await t.test('prázdná databáze: tvar odpovědi', async () => {
    const r = await s.get('/api/v1/dashboard');
    assert.equal(r.status, 200);
    for (const k of ['products', 'position', 'price_index', 'proposals', 'last_run', 'last_imports', 'competitors', 'by_manufacturer', 'alerts']) assert.ok(k in r.json, k);
    assert.deepEqual(r.json.products, { active: 0, with_market: 0, without_market: 0, locked: 0 });
    assert.deepEqual(r.json.position, { cheapest: 0, middle: 0, most_expensive: 0, no_data: 0 });
    assert.deepEqual(r.json.price_index, { vs_min: null, vs_median: null });
    assert.deepEqual(Object.keys(r.json.proposals).sort(), ['approved', 'avg_change_pct', 'down', 'exported_7d', 'margin_impact_abs', 'pending', 'up']);
    assert.equal(r.json.last_run, null);
    assert.deepEqual(r.json.last_imports, []);
    assert.deepEqual(r.json.alerts, []);
  });

  const seed = H.seedBasic(app.db);
  const P = seed.products;
  // produkt bez ceny, nespárovaná nabídka, zamčený produkt
  const pZero = H.insertProduct(app.db, { code: 'P7', name: 'Bez ceny', manufacturer: 'Focus', purchase_price: 100, price: null });
  app.db
    .prepare("INSERT INTO unmatched_offers (competitor_id, match_key, ean, name, price, first_seen_at, last_seen_at) VALUES (?, 'ean:123456789', '123456789', 'Neznámé kolo', 9990, ?, ?)")
    .run(seed.competitors.c1, nowIso(), nowIso());
  await s.patch(`/api/v1/products/${P.P2}`, { locked: true });

  await t.test('KPI, pozice, index, konkurenti, výrobci', async () => {
    const r = await s.get('/api/v1/dashboard');
    const d = r.json;
    assert.deepEqual(d.products, { active: 6, with_market: 4, without_market: 2, locked: 1 });
    assert.deepEqual(d.position, { cheapest: 1, middle: 0, most_expensive: 3, no_data: 2 });
    // průměr indexů produktů s trhem: P1 103,9; P2 97; P3 108,4; P4 110,1
    assert.equal(d.price_index.vs_min, Math.round(((103.9 + 97 + 108.4 + 110.1) / 4) * 10) / 10);
    assert.ok(d.price_index.vs_median > 0);
    assert.deepEqual(
      d.competitors.map((c) => c.name),
      ['KoloPointer.cz', 'VeloMarket.cz'],
      'vypnutý konkurent se nezobrazuje, řazeno podle počtu nabídek'
    );
    assert.deepEqual(Object.keys(d.competitors[0]).sort(), ['cheaper_than_us_pct', 'enabled', 'id', 'label', 'name', 'offers']);
    const focus = d.by_manufacturer.find((m) => m.manufacturer === 'Focus');
    assert.equal(focus.products, 2); // P1 + P7 (P5 neaktivní)
    assert.equal(focus.avg_index, 103.9);
    assert.equal(focus.cheapest_pct, 0);
    assert.deepEqual(Object.keys(focus).sort(), ['avg_index', 'avg_margin_pct', 'cheapest_pct', 'manufacturer', 'products', 'with_market']);
    assert.equal(d.by_manufacturer[0].manufacturer, 'Focus', 'seřazeno podle počtu produktů');
  });

  await t.test('upozornění: below_cost, zero_price, no_cost, competitor_drop, min_below_cost, unmatched', async () => {
    const d = (await s.get('/api/v1/dashboard')).json;
    const by = Object.fromEntries(d.alerts.map((a) => [a.type, a]));
    for (const a of d.alerts) {
      assert.ok(['info', 'warn', 'error'].includes(a.severity));
      assert.equal(typeof a.text, 'string');
      assert.ok(a.count > 0);
      assert.match(a.link, /^#\//);
    }
    assert.equal(by.below_cost.count, 1);
    assert.equal(by.below_cost.product_id, P.P4);
    assert.equal(by.below_cost.severity, 'error');
    assert.equal(by.zero_price.count, 1);
    assert.equal(by.zero_price.product_id, pZero);
    assert.equal(by.no_cost.count, 1);
    assert.equal(by.no_cost.product_id, P.P6);
    assert.equal(by.competitor_drop.count, 1);
    assert.equal(by.competitor_drop.items[0].competitor, 'VeloMarket.cz');
    assert.equal(by.competitor_drop.product_id, P.P3);
    assert.equal(by.min_below_cost.count, 1);
    assert.equal(by.min_below_cost.severity, 'info');
    assert.equal(by.unmatched.count, 1);
    assert.equal(by.unmatched.link, '#/konkurence?tab=unmatched');
    assert.equal(by.stale_offers, undefined);
    assert.equal(by.not_applied, undefined);
    // pořadí podle závažnosti
    const order = d.alerts.map((a) => a.severity);
    assert.deepEqual(order, [...order].sort((a, b) => ['error', 'warn', 'info'].indexOf(a) - ['error', 'warn', 'info'].indexOf(b)));
    // odkaz na produkty s filtrem funguje i jako dotaz API
    const filter = new URLSearchParams(by.below_cost.link.split('?')[1]).get('filter');
    const list = await s.get('/api/v1/products?filter=' + encodeURIComponent(filter));
    assert.deepEqual(list.json.items.map((x) => x.code), ['P4']);
  });

  await t.test('návrhy a poslední běh', async () => {
    await s.post('/api/v1/runs', {});
    const d = (await s.get('/api/v1/dashboard')).json;
    assert.ok(d.last_run);
    assert.equal(d.last_run.status, 'done');
    assert.equal(typeof d.last_run.stats, 'object');
    const pend = (await s.get('/api/v1/proposals')).json;
    assert.equal(d.proposals.pending, pend.total);
    assert.equal(d.proposals.up, pend.summary.up);
    assert.equal(d.proposals.down, pend.summary.down);
    assert.equal(typeof d.proposals.avg_change_pct, 'number');
    assert.equal(typeof d.proposals.margin_impact_abs, 'number');
    assert.equal(d.proposals.exported_7d, 0);
  });

  await t.test('upozornění not_applied (admin cenu nepřevzal) a exported_7d', async () => {
    const pr = (await s.get(`/api/v1/proposals?product=${P.P1}`)).json.items[0];
    await s.post('/api/v1/proposals/approve', { ids: [pr.id] });
    const exp = app.token(['export']);
    await exp.get('/api/v1/export/changes.json?mark=1');
    // export před 2 dny, pak import katalogu vrátil starou cenu
    const twoDays = ago(2 * DAY);
    app.db.prepare('UPDATE proposals SET exported_at = ? WHERE id = ?').run(twoDays, pr.id);
    app.db.prepare("UPDATE price_history SET at = ? WHERE product_id = ? AND source = 'export'").run(twoDays, P.P1);
    app.db.prepare('UPDATE products SET price = 79990, updated_at = ? WHERE id = ?').run(nowIso(), P.P1);
    app.db.prepare("INSERT INTO price_history (product_id, price, source, at) VALUES (?, 79990, 'import', ?)").run(P.P1, ago(DAY));
    const d = (await s.get('/api/v1/dashboard')).json;
    const na = d.alerts.find((a) => a.type === 'not_applied');
    assert.ok(na, JSON.stringify(d.alerts.map((a) => a.type)));
    assert.equal(na.count, 1);
    assert.equal(na.product_id, P.P1);
    assert.equal(na.items[0].exported_price, pr.new_price);
    assert.equal(d.proposals.exported_7d, 1);
    // ruční změna ceny po exportu → už to není „nepřevzato“
    app.db.prepare("INSERT INTO price_history (product_id, price, source, at) VALUES (?, 79990, 'manual', ?)").run(P.P1, nowIso());
    const d2 = (await s.get('/api/v1/dashboard')).json;
    assert.equal(d2.alerts.find((a) => a.type === 'not_applied'), undefined);
  });

  await t.test('upozornění stale_offers (žádný import cen konkurence déle než offer_max_age_days)', async () => {
    app.db.prepare('UPDATE offers SET observed_at = ?').run(ago(10 * DAY));
    let d = (await s.get('/api/v1/dashboard')).json;
    const st = d.alerts.find((a) => a.type === 'stale_offers');
    assert.ok(st);
    assert.equal(st.severity, 'warn');
    assert.equal(st.days_since_import, 10);
    assert.match(st.text, /10 dní/);
    // čerstvý import nabídek alert ruší
    app.db.prepare("INSERT INTO imports (kind, format, origin, started_at, finished_at, status) VALUES ('offers', 'json', 'api', ?, ?, 'ok')").run(nowIso(), nowIso());
    d = (await s.get('/api/v1/dashboard')).json;
    assert.equal(d.alerts.find((a) => a.type === 'stale_offers'), undefined);
    assert.ok(d.last_imports.length === 1 && d.last_imports[0].kind === 'offers');
    assert.equal(typeof d.last_imports[0].stats, 'object');
  });

  await t.test('oprávnění', async () => {
    assert.equal((await app.anon().get('/api/v1/dashboard')).status, 401);
    assert.equal((await app.token(['read']).get('/api/v1/dashboard')).status, 200);
  });
});

test('API nastavení a audit', async (t) => {
  const app = await H.startApp();
  t.after(() => app.stop());
  const s = app.session();
  const read = app.token(['read']);

  await t.test('GET /settings = výchozí nastavení bez interních klíčů', async () => {
    const r = await s.get('/api/v1/settings');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, DEFAULT_SETTINGS);
    assert.ok(!Object.keys(r.json).some((k) => k.startsWith('_')));
    assert.equal((await read.get('/api/v1/settings')).status, 200);
  });

  await t.test('PUT /settings: deep-merge, ukládání po klíčích, audit', async () => {
    let r = await s.put('/api/v1/settings', { vat_rate_default: 12, export: { pohoda: { ico: '12345678', filter_by: 'ean' }, xml: { fields: ['code', 'price'] } } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.vat_rate_default, 12);
    assert.equal(r.json.export.pohoda.ico, '12345678');
    assert.equal(r.json.export.pohoda.filter_by, 'ean');
    assert.equal(r.json.export.pohoda.application, 'Cenotvorba', 'ostatní klíče zůstaly');
    assert.equal(r.json.export.webhook.format, 'json');
    assert.deepEqual(r.json.export.xml.fields, ['code', 'price'], 'pole se nahrazuje celé');
    const keys = app.db.prepare("SELECT key FROM settings WHERE key NOT LIKE '\\_%' ESCAPE '\\' ORDER BY key").all().map((x) => x.key);
    assert.deepEqual(keys, ['export', 'vat_rate_default']);
    assert.deepEqual(getSettings(app.db), r.json);
    const aud = app.db.prepare("SELECT * FROM audit WHERE action = 'settings.update'").all();
    assert.equal(aud.length, 1);
    assert.deepEqual(JSON.parse(aud[0].detail).keys.sort(), ['export', 'vat_rate_default']);
    // beze změny se nic neukládá ani neaudituje
    r = await s.put('/api/v1/settings', { vat_rate_default: 12 });
    assert.equal(r.status, 200);
    assert.equal(app.db.prepare("SELECT count(*) AS c FROM audit WHERE action = 'settings.update'").get().c, 1);
    // celý objekt z GET (jako UI) projde
    r = await s.put('/api/v1/settings', (await s.get('/api/v1/settings')).json);
    assert.equal(r.status, 200);
    // XML šablona jako objekt {pole: element}
    r = await s.put('/api/v1/settings', { export: { xml: { root: 'ceny', item: 'polozka', fields: { code: 'KOD', price: 'CENA' } } } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.export.xml.fields, { code: 'KOD', price: 'CENA' });
  });

  await t.test('PUT /settings: hlavičky webhooku (null maže) a jejich skrytí pro read token', async () => {
    let r = await s.put('/api/v1/settings', { export: { webhook: { url: 'https://admin.example.cz/hook', headers: { Authorization: 'Bearer tajne', 'X-A': '1' } } } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.export.webhook.headers, { Authorization: 'Bearer tajne', 'X-A': '1' });
    r = await s.put('/api/v1/settings', { export: { webhook: { headers: { 'X-A': null } } } });
    assert.deepEqual(r.json.export.webhook.headers, { Authorization: 'Bearer tajne' });
    r = await read.get('/api/v1/settings');
    assert.deepEqual(r.json.export.webhook.headers, { Authorization: '***' });
    r = await s.get('/api/v1/settings');
    assert.deepEqual(r.json.export.webhook.headers, { Authorization: 'Bearer tajne' });
  });

  await t.test('PUT /settings: validace → 400 s českými chybami', async () => {
    const bad = [
      { vat_rate_default: 120 },
      { vat_rate_default: '21' },
      { offer_max_age_days: -1 },
      { retention_days: -5 },
      { retention_days: 1.5 },
      { purchase_includes_vat: 'ano' },
      { export: { webhook: { url: 'ftp://admin.example.cz' } } },
      { export: { webhook: { url: 'není url' } } },
      { export: { webhook: { format: 'yaml' } } },
      { export: { webhook: { headers: { 'Špatná hlavička': 'x' } } } },
      { export: { xml: { root: '1ceny' } } },
      { export: { xml: { item: 'xmlitem' } } },
      { export: { xml: { fields: ['cena'] } } },
      { export: { xml: { fields: { price: 'ne platné' } } } },
      { export: { xml: { fields: [] } } },
      { export: { pohoda: { filter_by: 'sku' } } },
      { export: { pohoda: { encoding: 'latin2' } } },
      { export: { pohoda: { ico: 'CZ123' } } },
      { schedule: { run_interval_minutes: -10 } },
      { neznamy_klic: 1 },
      { export: { neznamy: 1 } },
      { _password_hash: 'x' },
      { currency: 'koruny' },
      { export: 'nic' },
    ];
    for (const b of bad) {
      const r = await s.put('/api/v1/settings', b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.ok(Array.isArray(r.json.error.details) && r.json.error.details.length, JSON.stringify(b));
    }
    assert.equal((await s.put('/api/v1/settings', [1, 2])).status, 400);
    // nic z neplatných pokusů se neuložilo
    assert.equal((await s.get('/api/v1/settings')).json.vat_rate_default, 12);
    assert.equal((await read.put('/api/v1/settings', { vat_rate_default: 10 })).status, 403);
  });

  await t.test('prázdná URL webhooku je povolená, offer_max_age_days 0 také', async () => {
    const r = await s.put('/api/v1/settings', { offer_max_age_days: 0, export: { webhook: { url: '' } } });
    assert.equal(r.status, 200);
    assert.equal(r.json.offer_max_age_days, 0);
  });

  await t.test('GET /audit: jen admin, nejnovější první, detail jako objekt', async () => {
    assert.equal((await read.get('/api/v1/audit')).status, 403);
    const admin = app.token(['admin']);
    let r = await admin.get('/api/v1/audit');
    assert.equal(r.status, 200);
    assert.ok(r.json.items.length >= 3);
    const ids = r.json.items.map((x) => x.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
    const upd = r.json.items.find((x) => x.action === 'settings.update');
    assert.equal(typeof upd.detail, 'object');
    assert.equal(upd.actor, 'admin');
    r = await s.get('/api/v1/audit?action=settings.update&limit=1');
    assert.equal(r.json.items.length, 1);
    assert.equal(r.json.items[0].action, 'settings.update');
    r = await s.get('/api/v1/audit?limit=5000');
    assert.equal(r.status, 200);
    assert.ok(r.json.items.length <= 200);
  });
});
