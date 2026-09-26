'use strict';
// C6 „Jen aktualizovat existující produkty“ v průvodci importu (create_missing=0, přeskočené neznámé kódy ve výsledku,
// Skupina / model v mapování) a C8 opětovné stažení doručených změn v historii exportů.
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

const uploads = [];
const sources = [];
const UNKNOWN = Array.from({ length: 50 }, (_, i) => 'NEZNAMY-' + (i + 1));
dom.api({
  'POST /import/preview': () => ({
    format: 'csv', headers: ['Kód', 'Název', 'Prodejní cena s DPH', 'Nadřazený kód'],
    sample: [{ Kód: 'A', Název: 'Kolo', 'Prodejní cena s DPH': '100', 'Nadřazený kód': 'KOLO-X' }],
    canonical: [{ code: 'A', name: 'Kolo', price: 100, group_code: 'KOLO-X' }],
    suggested: { code: 'Kód', name: 'Název', price: 'Prodejní cena s DPH', group_code: 'Nadřazený kód' }, errors: [],
  }),
  'POST /import/products': (req) => {
    uploads.push(req.query);
    const only = req.query.create_missing === '0';
    return { import_id: req.query.dry_run ? null : 9, stats: { received: 120, created: only ? 0 : 70, updated: 50, unchanged: 0, deactivated: 0, ...(only ? { skipped_unknown: 70, unknown_codes: UNKNOWN } : {}), errors: [] } };
  },
  'POST /sources': (req) => {
    sources.push(req.body);
    return { id: 4, ...req.body };
  },
  'GET /sources': { items: [] },
  'GET /imports': { items: [] },
  'GET /products': { items: [], total: 1500, page: 1, limit: 1 },
  // export
  'GET /proposals': { items: [], total: 0, page: 1, limit: 6, summary: { pending: 0, approved: 0 } },
  'GET /settings': { export: { webhook: { url: '', format: 'json' }, pohoda: { encoding: 'windows-1250' } }, schedule: {} },
  'GET /exports': {
    items: [
      { id: 12, created_at: '2026-09-26T07:00:00Z', kind: 'feed', target: 'feed/changes.json', count: 14, status: 'ok', detail: null, redownload: true },
      { id: 11, created_at: '2026-09-25T07:00:00Z', kind: 'webhook', target: 'https://admin.example.cz/hook', count: 0, status: 'error', detail: 'HTTP 502', redownload: false },
    ],
    total: 2, page: 1, limit: 100,
  },
});

async function loadedWizard() {
  const { show } = await view('import');
  const root = dom.root();
  await show(root, makeCtx({ query: { kind: 'products' } }));
  const ta = root.querySelector('textarea');
  ta.value = 'Kód;Název;Prodejní cena s DPH;Nadřazený kód\nA;Kolo;100;KOLO-X';
  dom.click(dom.byText('Načíst vložená data', root, 'button'));
  await dom.settle();
  return root;
}
const checkByLabel = (root, re) => root.querySelectorAll('label.check').find((l) => re.test(l.textContent))?.querySelector('input');

test('import-model: Skupina / model v kanonických polích katalogu, přeskočené neznámé kódy', async () => {
  const m = await lib('import-model.js');
  const g = m.CANONICAL.products.find((f) => f.key === 'group_code');
  assert.ok(g, 'group_code v mapování katalogu');
  assert.strictEqual(g.label, 'Skupina / model');
  assert.ok(!m.CANONICAL.offers.some((f) => f.key === 'group_code'), 'u nabídek konkurence ne');
  assert.strictEqual(m.unknownCodesInfo({ created: 3 }), null);
  assert.deepStrictEqual(m.unknownCodesInfo({ skipped_unknown: 70, unknown_codes: ['A', 'B'] }), { count: 70, codes: ['A', 'B'], more: 68 });
  assert.deepStrictEqual(m.unknownCodesInfo({ unknown_codes: ['A'] }), { count: 1, codes: ['A'], more: 0 });
  assert.ok(m.statsList({ skipped_unknown: 3, unknown_codes: ['A'] }).some((s) => s.key === 'skipped_unknown' && s.label === 'Přeskočeno – neznámý kód' && s.value === 3));
  // sloupce zapsané do existujícího atributu („Imprese 30“ → imprese_30) – nikdy [object Object] ve statistikách
  assert.deepStrictEqual(m.attrsMergedList({ attrs_merged: { 'Imprese 30': 'imprese_30', X: 'X' } }), [['Imprese 30', 'imprese_30']]);
  assert.deepStrictEqual(m.attrsMergedList({}), []);
  assert.deepStrictEqual(m.attrsMergedList({ attrs_merged: ['x'] }), []);
  assert.ok(!m.statsList({ attrs_merged: { a: 'b' } }).some((s) => s.key === 'attrs_merged'));
});

test('C6: „Jen aktualizovat existující produkty“ → create_missing=0, výsledek ukáže přeskočené neznámé kódy', async () => {
  uploads.length = 0;
  const root = await loadedWizard();
  assert.match(text(root), /Skupina \/ model/, 'Skupina / model v mapování');
  const only = checkByLabel(root, /Jen aktualizovat existující produkty \(nezakládat nové\)/);
  assert.ok(only, 'volba jen aktualizovat');
  // bez volby se create_missing neposílá
  dom.click(root.querySelector('[data-action="dry-run"]'));
  await dom.settle();
  assert.strictEqual(uploads.at(-1).create_missing, undefined);
  only.checked = true;
  dom.change(only);
  dom.click(root.querySelector('[data-action="import"]'));
  await dom.settle();
  const q = uploads.at(-1);
  assert.strictEqual(q.create_missing, '0');
  assert.strictEqual(q.dry_run, undefined);
  const stat = root.querySelector('[data-stat="skipped_unknown"]');
  assert.ok(stat, 'dlaždice přeskočených');
  assert.match(text(stat), /Přeskočeno – neznámý kód\s*70/);
  const box = root.querySelector('[data-role="unknown-codes"]');
  assert.ok(box, 'seznam neznámých kódů');
  const t = norm(text(box));
  assert.match(t, /nezaloženo 70 produktů/);
  assert.match(t, /NEZNAMY-1, NEZNAMY-2/);
  assert.match(t, /Zobrazeno prvních 50/);
  assert.match(t, /a další 20/);
});

test('C6: uložení zdroje s „jen aktualizovat“ uloží options.create_missing = false', async () => {
  sources.length = 0;
  const root = await loadedWizard();
  const only = checkByLabel(root, /Jen aktualizovat existující produkty/);
  only.checked = true;
  dom.change(only);
  const saveSrc = dom.byText('Uložit mapování jako zdroj', root, 'button');
  assert.ok(saveSrc, 'tlačítko Uložit mapování jako zdroj');
  dom.click(saveSrc);
  await dom.settle();
  const dlg = dom.dialogs().at(-1);
  dom.type(dlg.querySelector('input'), 'Katalog z adminu');
  dom.click(dlg.querySelector('[data-action="save-source"]'));
  await dom.settle();
  assert.strictEqual(sources.length, 1);
  assert.deepStrictEqual(sources[0].options, { create_missing: false });
  assert.strictEqual(sources[0].kind, 'products');
});

test('C8: historie exportů nabízí znovu stažení JSON / XML / CSV jen u exportů s doručenými změnami', async () => {
  const { show } = await view('export');
  const root = dom.root();
  await show(root, makeCtx());
  await dom.settle();
  const cell = root.querySelector('[data-redownload="12"]');
  assert.ok(cell, 'odkazy u exportu #12');
  const links = cell.querySelectorAll('a');
  assert.deepStrictEqual(links.map((a) => text(a)), ['JSON', 'XML', 'CSV']);
  assert.deepStrictEqual(links.map((a) => a.getAttribute('href')), ['/api/v1/exports/12/changes.json', '/api/v1/exports/12/changes.xml', '/api/v1/exports/12/changes.csv']);
  assert.strictEqual(root.querySelector('[data-redownload="11"]'), null, 'neúspěšný export bez změn nic nenabízí');
  // návod pro admin: mark=1 není bezpečné opakovat → znovu stažení / ceník
  assert.match(text(root), /mark=1 není bezpečný pro opakování/);
  assert.match(text(root), /\/api\/v1\/exports\/\{id\}\/changes\.json/);
});
