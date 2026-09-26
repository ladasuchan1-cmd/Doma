'use strict';
// Regrese menších nálezů v seznamech a exportu:
//  - contract-9: odkazy „Import katalogu“ otevíraly průvodce v režimu cen konkurence,
//  - contract-11: „Uložit jako segment“ zahodil rychlé filtry (segment měl víc produktů, než bylo vidět),
//  - contract-17: odeslání webhookem bez schválených změn hlásilo „Odesláno“ / OK,
//  - contract-18: podtitulek „M zapnuto“ u konkurentů se po přepnutí neaktualizoval.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { installDom, makeCtx, text } = require('./ui-fake-dom.js');

const dom = installDom();
const PUB = path.join(__dirname, '..', 'public');
const view = (v) => import(pathToFileURL(path.join(PUB, 'views', v + '.js')).href);
const lib = (f) => import(pathToFileURL(path.join(PUB, 'lib', f)).href);

let approvedTotal = 0;
let pushReply = { ok: true, count: 0, status: null, export_id: null, marked: 0, skipped: 'no_changes', held: [] };
const pushes = [];
const competitors = [
  { id: 1, name: 'VeloMarket.cz', enabled: true, tags: [], offers: 10 },
  { id: 2, name: 'KoloExpres.cz', enabled: true, tags: [], offers: 5 },
];
dom.api({
  'GET /products/facets': { manufacturers: [{ value: 'Focus', count: 10 }], categories: [], owners: [], suppliers: [], attrs: {} },
  'GET /segments': { items: [{ id: 3, name: 'Ležáky', filter: { field: 'attrs.N', op: 'in', value: ['N7', 'N8'] }, count: 100 }] },
  'GET /fields': { fields: [{ key: 'manufacturer', label: 'Výrobce', type: 'string' }, { key: 'position', label: 'Pozice', type: 'enum' }] },
  'GET /products': { items: [], total: 0, page: 1, limit: 50 },
  'GET /dashboard': { products: { active: 0 } },
  'GET /proposals': () => ({ items: [], total: approvedTotal, page: 1, limit: 6, summary: { pending: 0, approved: approvedTotal } }),
  'GET /settings': { export: { webhook: { url: 'https://admin.example.cz/hook', format: 'json' }, pohoda: { encoding: 'windows-1250' } }, schedule: {} },
  'GET /exports': { items: [] },
  'POST /export/push': () => {
    pushes.push(1);
    return pushReply;
  },
  'GET /competitors': () => ({ items: competitors.map((c) => ({ ...c })) }),
  'PATCH /competitors/:id': (req) => ({ id: Number(req.params[0]), ...req.body }),
  'GET /unmatched': { items: [], total: 0 },
});

test('contract-9: import katalogu z Produktů i z úvodního průvodce otevře režim „Katalog produktů“', async () => {
  const products = await view('products');
  const ctx = makeCtx();
  const root = dom.root();
  await products.show(root, ctx);
  await dom.settle();
  const top = [...ctx.actionsEl.querySelectorAll('a')].find((a) => /Import katalogu/.test(a.textContent));
  assert.strictEqual(top.getAttribute('href'), '#/import?kind=products');
  const empty = root.querySelectorAll('a').find((a) => /Importovat katalog/.test(a.textContent));
  assert.strictEqual(empty.getAttribute('href'), '#/import?kind=products', 'prázdný stav');
  const dash = await view('dashboard');
  const droot = dom.root();
  await dash.show(droot, makeCtx());
  await dom.settle();
  const step = droot.querySelectorAll('a').find((a) => /Nahrajte katalog produktů/.test(a.textContent));
  assert.strictEqual(step.getAttribute('href'), '#/import?kind=products');
  const prices = droot.querySelectorAll('a').find((a) => /Pošlete ceny konkurence/.test(a.textContent));
  assert.strictEqual(prices.getAttribute('href'), '#/import', 'ceny konkurence zůstávají v režimu nabídek');
});

test('contract-11: quickFiltersToSegment převede rychlé filtry a řekne, co převést nejde', async () => {
  const { quickFiltersToSegment } = await lib('filter-model.js');
  const adv = { all: [{ field: 'attrs.N', op: 'in', value: ['N2', 'N3'] }, { any: [{ field: 'margin_pct', op: '<', value: 25.5 }, { field: 'stock', op: 'between', value: [2, 5] }] }] };
  const r = quickFiltersToSegment({ manufacturer: 'Focus', position: 'most_expensive', status: 'active' }, adv);
  assert.deepStrictEqual(r.dropped, []);
  assert.deepStrictEqual(r.filter, { all: [{ field: 'manufacturer', op: '=', value: 'Focus' }, { field: 'position', op: '=', value: 'most_expensive' }, ...adv.all] });
  // bez rychlých filtrů = jen pokročilý filtr beze změny
  assert.deepStrictEqual(quickFiltersToSegment({ status: 'active' }, adv).filter, adv);
  // segment → jeho filtr; více pozic → „je jedno z“; nepřevoditelné → dropped
  const segs = [{ id: 3, name: 'Ležáky', filter: { field: 'attrs.N', op: 'in', value: ['N7', 'N8'] } }];
  const r2 = quickFiltersToSegment({ segment: '3', position: 'cheapest,middle', q: 'marlin', has_proposal: true, status: 'all' }, null, segs);
  assert.deepStrictEqual(r2.filter, { all: [{ field: 'position', op: 'in', value: ['cheapest', 'middle'] }, { field: 'attrs.N', op: 'in', value: ['N7', 'N8'] }] });
  assert.strictEqual(r2.dropped.length, 3);
  assert.match(r2.dropped.join(' | '), /hledání „marlin“/);
});

test('contract-11: „Uložit jako segment“ v Produktech předá i rychlé filtry', async () => {
  const products = await view('products');
  const ctx = makeCtx({ query: { manufacturer: 'Focus', position: 'most_expensive', filter: JSON.stringify({ all: [{ field: 'attrs.N', op: 'in', value: ['N2', 'N3'] }] }) } });
  const root = dom.root();
  await products.show(root, ctx);
  await dom.settle();
  dom.click(root.querySelector('[data-action="save-as-segment"]'));
  await dom.settle();
  assert.strictEqual(dom.dialogs().length, 0, 'vše převoditelné → bez dotazu');
  const [hash] = ctx.calls.navigate.at(-1);
  const filter = JSON.parse(new URLSearchParams(hash.split('?')[1]).get('filter'));
  assert.deepStrictEqual(filter.all.slice(0, 2), [{ field: 'manufacturer', op: '=', value: 'Focus' }, { field: 'position', op: '=', value: 'most_expensive' }]);
  assert.strictEqual(filter.all.length, 3);
  // s hledáním: upozornění, že se nepřenese
  const ctx2 = makeCtx({ query: { q: 'marlin', filter: JSON.stringify({ field: 'stock', op: '>', value: 0 }) } });
  const root2 = dom.root();
  await products.show(root2, ctx2);
  await dom.settle();
  dom.click(root2.querySelector('[data-action="save-as-segment"]'));
  await dom.settle();
  const dlg = dom.dialogs().at(-1);
  assert.match(text(dlg), /nepřenesou se: hledání „marlin“/);
  dom.click(dlg.querySelector('[data-cancel]'));
  await dom.settle();
  assert.deepStrictEqual(ctx2.calls.navigate, []);
});

test('contract-17: bez schválených změn je odeslání vypnuté; odpověď „nic k odeslání“ není úspěch', async () => {
  approvedTotal = 0;
  const exp = await view('export');
  const root = dom.root();
  await exp.show(root, makeCtx());
  await dom.settle();
  const btn = root.querySelector('[data-action="push"]');
  assert.strictEqual(btn.disabled, true, 'nic ke schválení → tlačítko vypnuté');
  assert.match(btn.title, /Nic k odeslání/);
  // mezitím někdo schválil (UI má 1), server ale nic nenašel → neutrální výsledek
  approvedTotal = 1;
  const root2 = dom.root();
  await exp.show(root2, makeCtx());
  await dom.settle();
  const btn2 = root2.querySelector('[data-action="push"]');
  assert.strictEqual(btn2.disabled, false);
  pushReply = { ok: true, count: 0, status: null, export_id: null, marked: 0, skipped: 'no_changes', held: [{ proposal_id: 5, reason: 'price_changed' }] };
  dom.click(btn2);
  await dom.settle();
  dom.click(dom.dialogs().at(-1).querySelector('[data-confirm]'));
  approvedTotal = 0;
  await dom.settle();
  assert.strictEqual(pushes.length, 1);
  const toasts = dom.toasts().join(' | ');
  assert.doesNotMatch(toasts, /Odesláno: 0/);
  assert.match(toasts, /Nic se neodeslalo/);
  const result = text(root2.querySelector('[data-role="push-result"]'));
  assert.match(result, /Nic se neodeslalo/);
  assert.doesNotMatch(result, /Výsledek OK/);
  assert.match(result, /1 schválená změna zadržena/);
  assert.strictEqual(btn2.disabled, true, 'po obnovení počtu zase vypnuté');
});

test('contract-18: po vypnutí konkurenta se podtitulek „M zapnuto“ aktualizuje', async () => {
  const comp = await view('competitors');
  const ctx = makeCtx();
  const root = dom.root();
  await comp.show(root, ctx);
  await dom.settle();
  assert.match(ctx.calls.sub.at(-1), /2 zapnuto/);
  const sw = root.querySelector('[role="switch"][aria-label="Vypnout VeloMarket.cz"]');
  dom.click(sw);
  await dom.settle();
  assert.match(ctx.calls.sub.at(-1), /1 zapnuto/);
});
