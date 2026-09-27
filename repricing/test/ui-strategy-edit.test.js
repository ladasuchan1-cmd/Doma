'use strict';
// Regrese editoru strategie a segmentu:
//  - contract-5: simulace hodnotí strategii samostatně (ignoruje pořadí) – UI to teď říká a varuje, když je dřív
//    v pořadí výchozí strategie pro všechny produkty (tato se pak téměř neuplatní),
//  - contract-20: po přejmenování se hned aktualizuje titulek a drobečková navigace (strategie i segment).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { installDom, makeCtx, text } = require('./ui-fake-dom.js');

const dom = installDom();
const PUB = path.join(__dirname, '..', 'public');
const view = (v) => import(pathToFileURL(path.join(PUB, 'views', v + '.js')).href);
const lib = (f) => import(pathToFileURL(path.join(PUB, 'lib', f)).href);

const EMPTY_SCHEDULE = { valid_from: null, valid_to: null, weekdays: [], hours: null };
const STRATEGIES = [
  { id: 1, name: 'Ležáky N7/N8', priority: 10, enabled: true, segment_id: 2, config: { conditions: {}, schedule: EMPTY_SCHEDULE, target: { mode: 'match_min' } } },
  { id: 4, name: 'Výchozí – medián trhu −2 %', priority: 80, enabled: true, segment_id: null, config: { conditions: {}, schedule: EMPTY_SCHEDULE, target: { mode: 'market_median', offset_pct: -2 } } },
  { id: 9, name: 'Kopie výchozí', priority: 90, enabled: true, segment_id: null, config: { conditions: {}, schedule: EMPTY_SCHEDULE, target: { mode: 'market_median' } } },
];
const puts = [];

dom.api({
  'GET /strategies/:id': (req) => STRATEGIES.find((s) => String(s.id) === req.params[0]) || dom.apiError(404, 'Strategie nenalezena.'),
  'GET /strategies': { items: STRATEGIES },
  'GET /segments': { items: [{ id: 2, name: 'Ležáky', count: 100 }] },
  'GET /segments/:id': (req) => ({ id: Number(req.params[0]), name: 'Ležáky', description: null, color: '#2a78d6', filter: { all: [{ field: 'attrs.N', op: 'in', value: ['N7', 'N8'] }] }, count: 100 }),
  'POST /segments/preview': { count: 100, sample: [], errors: [] },
  'PUT /segments/:id': (req) => ({ id: Number(req.params[0]), ...req.body, count: 100 }),
  'GET /competitors': { items: [] },
  'GET /fields': { fields: [{ key: 'attrs.N', label: 'N', type: 'string', group: 'Atributy' }, { key: 'stock', label: 'Sklad', type: 'number', group: 'Sklad' }] },
  'GET /products/facets': { manufacturers: [], categories: [], owners: [], suppliers: [], attrs: {} },
  'POST /simulate': { stats: { products: 1500, evaluated: 1500, changes: 133, up: 60, down: 73, no_change: 1367, skipped: {}, margin_impact_abs: 620651 }, decisions: [], errors: [] },
  'PUT /strategies/:id': (req) => {
    puts.push(req.body);
    return { ...STRATEGIES.find((s) => String(s.id) === req.params[0]), ...req.body };
  },
  'GET /products': { items: [], total: 0 },
});

test('precedingStrategies: pořadí priorita → id, jen zapnuté, pozná výchozí strategii bez segmentu', async () => {
  const { precedingStrategies } = await lib('strategy-model.js');
  const r = precedingStrategies(STRATEGIES, { id: 9, priority: 90 });
  assert.deepStrictEqual(r.list.map((s) => s.id), [1, 4]);
  assert.strictEqual(r.catchAll.id, 4);
  // první v pořadí: nic před ní
  assert.deepStrictEqual(precedingStrategies(STRATEGIES, { id: 1, priority: 10 }).list, []);
  // nová strategie bez priority jde na konec
  assert.deepStrictEqual(precedingStrategies(STRATEGIES, { id: null, priority: null }).list.map((s) => s.id), [1, 4, 9]);
  // vypnutá výchozí se nepočítá; výchozí s časovým oknem není „pro všechny“
  const off = STRATEGIES.map((s) => (s.id === 4 ? { ...s, enabled: false } : s));
  assert.strictEqual(precedingStrategies(off, { id: 9, priority: 90 }).catchAll, null);
  const windowed = STRATEGIES.map((s) => (s.id === 4 ? { ...s, config: { ...s.config, schedule: { ...EMPTY_SCHEDULE, weekdays: [6, 7] } } } : s));
  assert.strictEqual(precedingStrategies(windowed, { id: 9, priority: 90 }).catchAll, null);
});

test('simulace strategie za výchozí strategií: upozornění, že ignoruje pořadí a téměř se neuplatní', async () => {
  const { show } = await view('strategy-edit');
  const root = dom.root();
  const ctx = makeCtx({ params: { id: '9' } });
  await show(root, ctx);
  await dom.settle();
  // varování už v shrnutí (před simulací)
  const order = root.querySelector('[data-role="order-warning"]');
  assert.match(text(order), /Výchozí – medián trhu −2 %/);
  assert.match(text(order), /téměř neuplatní/);
  dom.click(root.querySelector('[data-action="simulate"]'));
  await dom.settle();
  const note = root.querySelector('[data-role="simulation-note"]');
  assert.ok(note, 'u výsledku simulace je vysvětlení');
  assert.match(text(note), /Simulace hodnotí tuto strategii samostatně a ostatní strategie ignoruje/);
  assert.match(text(note), /skutečný dopad bude menší/);
  assert.match(text(note), /převezme skoro všechny produkty/);
  assert.match(text(root.querySelector('[data-card="simulation"]')), /bez ohledu na pořadí/);
});

test('první strategie v pořadí: bez varování o výchozí strategii', async () => {
  const { show } = await view('strategy-edit');
  const root = dom.root();
  await show(root, makeCtx({ params: { id: '1' } }));
  await dom.settle();
  assert.strictEqual(text(root.querySelector('[data-role="order-warning"]')), '');
  dom.click(root.querySelector('[data-action="simulate"]'));
  await dom.settle();
  assert.match(text(root.querySelector('[data-role="simulation-note"]')), /Před touto strategií není žádná zapnutá strategie/);
});

test('contract-20: přejmenování strategie aktualizuje titulek i drobečkovou navigaci', async () => {
  const { show } = await view('strategy-edit');
  const root = dom.root();
  const ctx = makeCtx({ params: { id: '1' } });
  await show(root, ctx);
  await dom.settle();
  dom.type(root.querySelector('[data-field="name"]'), 'Víkendová akce X');
  dom.click(root.querySelector('[data-action="save-strategy"]'));
  await dom.settle();
  assert.strictEqual(puts.at(-1).name, 'Víkendová akce X');
  const [title, crumb] = ctx.calls.title.at(-1);
  assert.strictEqual(title, 'Víkendová akce X');
  assert.strictEqual(text(crumb), 'Strategie / Víkendová akce X');
});

test('contract-20: přejmenování segmentu aktualizuje titulek i drobečkovou navigaci', async () => {
  const { show } = await view('segment-edit');
  const root = dom.root();
  const ctx = makeCtx({ params: { id: '2' } });
  await show(root, ctx);
  await dom.settle();
  dom.type(root.querySelector('[data-field="name"]'), 'Ležáky 2026');
  const save = root.querySelectorAll('button').find((b) => /Uložit/.test(b.textContent));
  dom.click(save);
  await dom.settle();
  const [title, crumb] = ctx.calls.title.at(-1);
  assert.strictEqual(title, 'Ležáky 2026');
  assert.strictEqual(text(crumb), 'Segmenty / Ležáky 2026');
});
