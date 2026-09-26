'use strict';
// Simulace a nové volby strategie (C2, C3, C7):
//  - „Simulovat celé přecenění“ (POST /runs {dry_run: true}) ukáže statistiky a největší změny, nic neuloží,
//  - editor strategie simuluje uloženou strategii v kontextu celé sady (strategy_id, priority) a ukáže
//    „Produkty zabrané dřívějšími strategiemi: N“; nová strategie se simuluje samostatně (bez strategy_id),
//  - formulář: „Sjednotit cenu ve skupině“ (group.align) a „Započítat i dodání do X dnů“ (competitors.max_delivery_days),
//  - popisky nových příznaků / důvodů (group_aligned, group_conflict, rejected_before) ve statistikách.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { installDom, makeCtx, text } = require('./ui-fake-dom.js');

const dom = installDom();
const PUB = path.join(__dirname, '..', 'public');
const view = (v) => import(pathToFileURL(path.join(PUB, 'views', v + '.js')).href);
const lib = (f) => import(pathToFileURL(path.join(PUB, 'lib', f)).href);
const norm = (s) => String(s).replace(/[  ]/g, ' ');

const EMPTY_SCHEDULE = { valid_from: null, valid_to: null, weekdays: [], hours: null };
const STRATEGIES = [
  { id: 1, name: 'Ležáky N7/N8', priority: 10, enabled: true, segment_id: 2, config: { conditions: {}, schedule: EMPTY_SCHEDULE, target: { mode: 'match_min' } } },
  { id: 3, name: 'Klíčové značky – držet pozici 2', priority: 20, enabled: true, segment_id: 5, config: { conditions: {}, schedule: EMPTY_SCHEDULE, target: { mode: 'rank', rank: 2 }, group: { align: 'max' }, competitors: { in_stock_only: true, max_delivery_days: 3 } } },
  { id: 4, name: 'Výchozí – medián trhu −2 %', priority: 80, enabled: true, segment_id: null, config: { conditions: {}, schedule: EMPTY_SCHEDULE, target: { mode: 'market_median', offset_pct: -2 } } },
];
const posts = [];
const RUN_STATS = {
  products: 1500, evaluated: 1480, changes: 212, up: 80, down: 132, no_change: 1200, no_change_reasons: { below_threshold: 1100, rejected_before: 7 },
  skipped: { locked: 3 }, no_strategy: 20, fallthrough: 4, auto_approved: 50, pending: 162, flags: { group_aligned: 24, group_conflict: 2 },
  by_strategy: { 3: { name: 'Klíčové značky – držet pozici 2', products: 300, changes: 60, up: 20, down: 40 }, 4: { name: 'Výchozí – medián trhu −2 %', products: 1180, changes: 152, up: 60, down: 92 } },
  margin_impact_abs: -18250.5,
};

dom.api({
  'GET /strategies/presets': { items: [] },
  'GET /strategies/:id': (req) => STRATEGIES.find((s) => String(s.id) === req.params[0]) || dom.apiError(404, 'Strategie nenalezena.'),
  'GET /strategies': { items: STRATEGIES },
  'GET /segments': { items: [{ id: 2, name: 'Ležáky', count: 100 }, { id: 5, name: 'Klíčové značky', count: 320 }] },
  'GET /competitors': { items: [] },
  'GET /fields': { fields: [{ key: 'stock', label: 'Sklad', type: 'number', group: 'Sklad' }] },
  'GET /products/facets': { manufacturers: [], categories: [], owners: [], suppliers: [], attrs: {} },
  'GET /runs': { items: [], total: 0 },
  'GET /dashboard': { products: { active: 1500 } },
  'POST /runs': (req) => {
    posts.push(['runs', req.body]);
    return {
      run_id: null, dry_run: true, stats: RUN_STATS,
      sample: [
        { action: 'change', product_id: 11, strategy_id: 3, old_price: 24990, new_price: 21990, change_pct: -12.0, change_abs: -3000, margin_before: 22, margin_after: 12.1, flags: ['group_aligned', 'big_change'], explain: [{ step: 'group', text: 'Sjednoceno ve skupině TRK-MARLIN7 (3 produkty, režim nejvyšší) → 21 990 Kč' }], product: { id: 11, code: 'TRK-MAR7-M', name: 'Trek Marlin 7, M', manufacturer: 'Trek', category: 'Horská kola' } },
        { action: 'change', product_id: 12, strategy_id: 4, old_price: 1290, new_price: 1349, change_pct: 4.57, change_abs: 59, margin_before: 18, margin_after: 21.3, flags: [], explain: [], product: { id: 12, code: 'SHI-XT', name: 'Shimano XT kazeta', manufacturer: 'Shimano', category: 'Díly' } },
      ],
    };
  },
  'POST /simulate': (req) => {
    posts.push(['simulate', req.body]);
    const context = req.body.strategy_id != null;
    return {
      context,
      // kontextová simulace hlásí jen skupiny simulované strategie – strategie 1 (group.align off) žádné
      stats: { products: 180, evaluated: 180, changes: 40, up: 10, down: 30, no_change: 140, skipped: {}, margin_impact_abs: -5200, groups: Number(req.body.strategy_id) === 1 ? { aligned: 0, conflicts: 0, members: 0 } : { aligned: 5, conflicts: 0, members: 14 }, ...(context ? { claimed_by_earlier: 37 } : {}) },
      decisions: [], errors: [], truncated: {},
    };
  },
  'GET /products': { items: [], total: 0 },
});

test('Strategie: „Simulovat celé přecenění“ pošle dry_run a ukáže statistiky i největší změny (nic se neuloží)', async () => {
  posts.length = 0;
  const { show } = await view('strategies');
  const root = dom.root();
  const ctx = makeCtx();
  await show(root, ctx);
  await dom.settle();
  const btn = ctx.actionsEl.querySelector('[data-action="dry-run"]');
  assert.ok(btn, 'tlačítko v horní liště');
  assert.match(text(btn), /Simulovat celé přecenění/);
  dom.click(btn);
  await dom.settle();
  assert.deepStrictEqual(posts, [['runs', { dry_run: true }]]);
  const card = root.querySelector('[data-card="dry-run"]');
  assert.ok(card, 'karta s výsledkem simulace');
  const t = norm(text(card));
  assert.match(t, /Nic se neuložilo/);
  assert.match(t, /Změn ceny\s*212/);
  assert.match(t, /Stejná cena byla nedávno zamítnuta: 7/, 'C1: důvod beze změny s českým popiskem');
  assert.match(t, /Sjednoceno ve skupině: 24/, 'C3: příznak s českým popiskem');
  assert.match(t, /Skupinu nelze sjednotit \(limity\): 2/);
  assert.match(t, /Největší změny \(2 z 212\)/);
  assert.match(t, /Trek Marlin 7, M/);
  assert.match(t, /TRK-MAR7-M · Trek · Horská kola/);
  assert.match(t, /Klíčové značky – držet pozici 2/, 'strategie podle strategy_id');
  // zavření karty
  dom.click(dom.byText('Zavřít', card, 'button'));
  assert.strictEqual(root.querySelector('[data-card="dry-run"]'), null);
  assert.deepStrictEqual(ctx.calls.runPricing, [], 'ostré přecenění se nespustilo');
});

test('Strategie: seznam ukazuje sjednocení skupiny u strategie', async () => {
  const { show } = await view('strategies');
  const root = dom.root();
  await show(root, makeCtx());
  await dom.settle();
  const metas = root.querySelectorAll('[data-meta="group"]').map((e) => text(e));
  assert.deepStrictEqual(metas, ['Skupina: nejvyšší cena']);
});

test('Editor: uložená strategie se simuluje v kontextu sady (strategy_id + priorita) a ukáže zabrané produkty', async () => {
  posts.length = 0;
  const { show } = await view('strategy-edit');
  const root = dom.root();
  await show(root, makeCtx({ params: { id: '3' } }));
  await dom.settle();
  dom.click(root.querySelector('[data-action="simulate"]'));
  await dom.settle();
  const [kind, body] = posts.at(-1);
  assert.strictEqual(kind, 'simulate');
  assert.strictEqual(body.strategy_id, 3);
  assert.strictEqual(body.priority, 20);
  assert.strictEqual(body.segment_id, 5);
  assert.strictEqual(body.config.group.align, 'max');
  const note = root.querySelector('[data-role="simulation-note"]');
  assert.match(text(note), /počítá s pořadím strategií jako skutečné přecenění/);
  assert.match(text(note), /Ležáky N7\/N8/, 'odkaz na dřívější strategii');
  assert.strictEqual(text(root.querySelector('[data-role="claimed"]')), 'Produkty zabrané dřívějšími strategiemi: 37');
  assert.match(text(root.querySelector('[data-card="simulation"]')), /v pořadí s ostatními zapnutými strategiemi/);
  assert.match(norm(text(root.querySelector('[data-card="simulation"] [data-role="groups"]'))), /5 skupin sjednoceno \(14 produktů\)/);
});

test('Editor: kontextová simulace strategie bez sjednocení neukazuje souhrn skupin (server hlásí jen skupiny této strategie)', async () => {
  const { show } = await view('strategy-edit');
  const root = dom.root();
  await show(root, makeCtx({ params: { id: '1' } }));
  await dom.settle();
  dom.click(root.querySelector('[data-action="simulate"]'));
  await dom.settle();
  assert.strictEqual(posts.at(-1)[1].strategy_id, 1);
  assert.ok(root.querySelector('[data-card="simulation"] [data-role="claimed"]'));
  assert.strictEqual(root.querySelector('[data-card="simulation"] [data-role="groups"]'), null);
});

test('Editor: nová strategie se simuluje samostatně (bez strategy_id)', async () => {
  posts.length = 0;
  const { show } = await view('strategy-edit');
  const root = dom.root();
  await show(root, makeCtx({ params: { id: 'nova' } }));
  await dom.settle();
  dom.click(root.querySelector('[data-action="simulate"]'));
  await dom.settle();
  const [, body] = posts.at(-1);
  assert.strictEqual('strategy_id' in body, false);
  assert.strictEqual(root.querySelector('[data-role="claimed"]'), null);
  assert.match(text(root.querySelector('[data-role="simulation-note"]')), /samostatně/);
});

test('Formulář strategie: sjednocení skupiny a dodání do X dnů', async () => {
  const { strategyForm } = await lib('strategy-form.js');
  const changes = [];
  const f = strategyForm({ config: { competitors: { in_stock_only: true } }, segments: [], competitors: [], fields: [], onChange: (c) => changes.push(c) });
  document.body.appendChild(f.el);
  const sel = f.el.querySelector('[data-path="group.align"]');
  assert.ok(sel, 'výběr sjednocení');
  assert.deepStrictEqual(sel.querySelectorAll('option').map((o) => o.value), ['off', 'max', 'min', 'median']);
  assert.strictEqual(sel.value, 'off');
  assert.match(text(f.sections.group), /Sjednotit cenu ve skupině \(velikosti \/ barvy\)/);
  assert.match(text(f.sections.group), /Každá varianta/, 'nápověda k vybranému režimu');
  sel.value = 'median';
  dom.change(sel);
  assert.strictEqual(f.getConfig().group.align, 'median');
  assert.match(text(f.sections.group), /prostřední z vypočtených cen/);
  // dodání do X dnů – jen s „Jen nabídky skladem“
  const dd = f.el.querySelector('[data-field="max-delivery-days"]');
  assert.ok(dd, 'pole Započítat i dodání do X dnů');
  assert.match(text(dd), /Započítat i dodání do X dnů/);
  assert.strictEqual(dd.hidden, false);
  const inp = dd.querySelector('input');
  dom.type(inp, '3');
  assert.strictEqual(f.getConfig().competitors.max_delivery_days, 3);
  dom.type(inp, '');
  assert.strictEqual(f.getConfig().competitors.max_delivery_days, null, 'prázdné = vypnuto');
  dom.type(inp, '-2');
  assert.strictEqual(inp.getAttribute('aria-invalid'), 'true', 'záporné číslo je chyba');
  dom.click(f.el.querySelector('[data-path="competitors.in_stock_only"]'));
  assert.strictEqual(f.getConfig().competitors.in_stock_only, false);
  assert.strictEqual(dd.hidden, true, 'bez „Jen nabídky skladem“ se pole skryje');
});

test('strategy-model: validace a popis nových voleb', async () => {
  const m = await lib('strategy-model.js');
  const ok = m.validateConfig(m.mergeConfig({ group: { align: 'max' }, competitors: { max_delivery_days: 3 } }));
  assert.deepStrictEqual(ok.errors, []);
  assert.ok(m.validateConfig(m.mergeConfig({ group: { align: 'vse' } })).errors.some((e) => /režim sjednocení/.test(e)));
  assert.ok(m.validateConfig(m.mergeConfig({ competitors: { max_delivery_days: -1 } })).errors.some((e) => /Dodání do X dnů/.test(e)));
  assert.ok(m.validateConfig(m.mergeConfig({ competitors: { in_stock_only: false, max_delivery_days: 3 } })).warnings.some((w) => /Jen nabídky skladem/.test(w)));
  const desc = norm(m.describeStrategy(m.mergeConfig({ group: { align: 'max' }, competitors: { max_delivery_days: 3 } })));
  assert.match(desc, /nabídky skladem nebo s dodáním do 3 dnů/);
  assert.match(desc, /sjednotí na nejvyšší/);
  assert.strictEqual(m.describeGroupShort({ group: { align: 'median' } }), 'Skupina: medián');
  assert.strictEqual(m.describeGroupShort({}), '');
  assert.deepStrictEqual(m.mergeConfig({ group: 'min' }).group, { align: 'min' }, 'krátký zápis');
});

test('runStatsView: souhrn sjednocení skupin (stats.groups)', async () => {
  const { runStatsView } = await lib('run-stats.js');
  const el = runStatsView({ products: 10, changes: 4, groups: { aligned: 3, conflicts: 1, members: 8 } });
  document.body.appendChild(el);
  assert.strictEqual(norm(text(el.querySelector('[data-role="groups"]'))), 'Skupiny variant:3 skupiny sjednoceny (8 produktů) · 1 skupinu nelze sjednotit (limity variant se nepřekrývají)');
  assert.strictEqual(runStatsView({ groups: { aligned: 0, conflicts: 0, members: 0 } }).querySelector('[data-role="groups"]'), null);
});
