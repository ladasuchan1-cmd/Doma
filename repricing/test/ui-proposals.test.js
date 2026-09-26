'use strict';
// Regrese pohledu Návrhy cen (public/views/proposals.js) a modelu návrhu (public/lib/proposal-model.js):
//  - contract-2: po změně ceny produktu (import katalogu, ruční změna) ukazoval návrh starou „Starou cenu“ a změnu %,
//  - contract-10: schválený návrh nešlo v UI zamítnout (ani jednotlivě, ani hromadně),
//  - contract-12: ruční cena s překlepem (1 234,50 místo 123 450) se uložila jen s úspěšným toastem.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { installDom, makeCtx, text } = require('./ui-fake-dom.js');

const dom = installDom();
const PUB = path.join(__dirname, '..', 'public');
const view = () => import(pathToFileURL(path.join(PUB, 'views', 'proposals.js')).href);
const model = () => import(pathToFileURL(path.join(PUB, 'lib', 'proposal-model.js')).href);
const norm = (s) => String(s).replace(/[  ]/g, ' ').replace(/−/g, '-');

function proposal(o = {}) {
  const base = {
    id: 3770, product_id: 77, status: 'pending', old_price: 102990, new_price: 110990, manual_price: null, change_pct: 7.77, change_abs: 8000,
    final_price: 110990, final_change_pct: 7.77, final_margin_pct: 20, margin_before: 15, margin_after: 20, flags: [], explain: [],
    created_at: '2026-09-25T08:00:00Z', decided_at: null, strategy_name: 'Výchozí', segment_name: null,
    product: { id: 77, code: 'CER-10493-XS', name: 'Cervélo Caledonia, XS', price: 102990, purchase_price: 70000, vat_rate: 21, stock: 2 },
  };
  return { ...base, ...o, product: { ...base.product, ...(o.product || {}) } };
}

let items = [];
const posts = [];
const patches = [];
dom.api({
  'GET /strategies': { items: [] },
  'GET /segments': { items: [] },
  'GET /products/facets': { manufacturers: [] },
  'GET /proposals': (req) => {
    const st = req.query.status || 'pending';
    const list = st === 'all' ? items : items.filter((p) => p.status === st);
    return { items: list, total: list.length, page: 1, limit: 50, max_id: list.reduce((m, p) => Math.max(m, p.id), 0) || null, flagged: 0, summary: { pending: items.filter((p) => p.status === 'pending').length, approved: items.filter((p) => p.status === 'approved').length, exported_today: 0, up: 1, down: 0 } };
  },
  'POST /proposals/approve': (req) => {
    posts.push(['approve', req.body]);
    return { updated: (req.body.ids || []).length, skipped_locked: 0, skipped_inactive: 0, skipped_flagged: 0 };
  },
  'POST /proposals/reject': (req) => {
    posts.push(['reject', req.body]);
    return { updated: req.body.ids ? req.body.ids.length : items.filter((p) => p.status === req.body.filter?.status).length };
  },
  'PATCH /proposals/:id': (req) => {
    patches.push(req.body);
    const v = req.body.manual_price;
    if (v != null && v < 50000 && req.body.confirm !== true) {
      return dom.apiError(409, 'Ruční cena vyžaduje potvrzení.', { code: 'MANUAL_PRICE_CONFIRM', reasons: ['cena bez DPH 1 020,25 Kč je pod nákupní cenou 70 000 Kč', 'cena se mění o -98,8 % oproti 102 990 Kč'], flags: ['manual', 'manual_below_cost', 'big_manual_change'] });
    }
    const p = items.find((x) => String(x.id) === req.params[0]);
    return { ...p, manual_price: v, final_price: v ?? p.new_price, status: p.status === 'approved' ? 'pending' : p.status, flags: v != null && req.body.confirm ? ['manual', 'manual_below_cost'] : ['manual'] };
  },
});

async function render(query = {}) {
  const { show } = await view();
  const ctx = makeCtx({ query });
  const root = dom.root();
  await show(root, ctx);
  await dom.settle();
  return { root, ctx };
}

test('model: změna výchozí ceny, zobrazená změna a hromadné stavy', async () => {
  const m = await model();
  const p = proposal({ product: { price: 133887 } });
  assert.deepStrictEqual(m.basePriceChange(p), { from: 102990, to: 133887, taken: false });
  assert.strictEqual(m.basePrice(p), 133887);
  const d = m.displayChange(p);
  assert.strictEqual(d.pct, -17.1);
  assert.strictEqual(d.abs, -22897);
  // beze změny ceny = původní hodnoty z API
  assert.strictEqual(m.basePriceChange(proposal()), null);
  assert.strictEqual(m.displayChange(proposal()).pct, 7.77);
  // exportovaný / nahrazený návrh se neporovnává (cena se změnila právě exportem)
  assert.strictEqual(m.basePriceChange(proposal({ status: 'exported', product: { price: 110990 } })), null);
  // admin už cenu převzal (aktuální = cena k exportu) → taken
  assert.strictEqual(m.basePriceChange(proposal({ product: { price: 110990 } })).taken, true);
  assert.deepStrictEqual(m.staleProposals([p, proposal({ id: 2, product: { price: 110990 } }), proposal({ id: 3 })]).map((x) => x.id), [3770]);
  assert.strictEqual(m.isSelectableProposal({ status: 'approved' }), true);
  assert.strictEqual(m.isSelectableProposal({ status: 'exported' }), false);
  assert.strictEqual(m.bulkStatus('reject', 'approved'), 'approved');
  assert.strictEqual(m.bulkStatus('reject', 'all'), 'pending');
  assert.strictEqual(m.bulkStatus('approve', 'approved'), null);
  assert.strictEqual(m.bulkStatus('reject', 'exported'), null);
});

test('contract-2: návrh ze staré ceny ukazuje aktuální cenu, varování a změnu proti ní; schválení se ptá', async () => {
  items = [proposal({ product: { price: 133887 } })];
  posts.length = 0;
  const { root } = await render();
  const row = root.querySelector('tr[data-key="3770"]');
  assert.ok(row, 'řádek návrhu');
  const t = norm(text(row));
  assert.match(t, /133 887 Kč/, 'aktuální cena produktu');
  assert.match(t, /cena se změnila/);
  assert.match(t, /návrh ze 102 990 Kč/);
  assert.match(t, /-17,1 %/, 'změna proti aktuální ceně');
  assert.doesNotMatch(t, /\+7,8 %/, 'ne zastaralá změna z návrhu');
  assert.ok(root.querySelector('[data-action="reprice-stale"]'), 'nabídka přecenit dotčené produkty');
  // schválení řádku: potvrzení kvůli staré ceně, Zrušit nic neodešle
  dom.click(row.querySelector('[data-action="approve-row"]'));
  await dom.settle();
  let dlg = dom.dialogs().at(-1);
  assert.ok(dlg);
  assert.match(norm(text(dlg)), /CER-10493-XS: návrh ze 102 990 Kč, teď 133 887 Kč/);
  dom.click(dlg.querySelector('[data-cancel]'));
  await dom.settle();
  assert.deepStrictEqual(posts, []);
  dom.click(root.querySelector('tr[data-key="3770"] [data-action="approve-row"]'));
  await dom.settle();
  dlg = dom.dialogs().at(-1);
  dom.click(dlg.querySelector('[data-confirm]'));
  await dom.settle();
  assert.deepStrictEqual(posts, [['approve', { ids: [3770] }]]);
});

test('contract-2: „Přecenit tyto produkty“ přecení jen dotčené produkty', async () => {
  items = [proposal({ product: { price: 133887 } }), proposal({ id: 3771, product_id: 78, product: { id: 78, code: 'X', price: 102990 } })];
  const { root, ctx } = await render();
  dom.click(root.querySelector('[data-action="reprice-stale"]'));
  await dom.settle();
  assert.deepStrictEqual(ctx.calls.runPricing, [{ productIds: [77] }]);
});

test('contract-10: schválený návrh lze vybrat a zamítnout (řádek i „Zamítnout vše“ na záložce Schváleno)', async () => {
  items = [proposal({ id: 10, status: 'approved', decided_at: '2026-09-26T08:00:00Z', decided_by: 'auto', product: { price: 102990 } }), proposal({ id: 11, status: 'approved', decided_at: '2026-09-26T08:00:00Z' })];
  posts.length = 0;
  const { root, ctx } = await render({ status: 'approved' });
  const row = root.querySelector('tr[data-key="10"]');
  assert.ok(row.querySelector('input[type="checkbox"]'), 'schválený řádek jde vybrat');
  const rejectAll = ctx.actionsEl.querySelector('[data-action="reject-all"]');
  assert.strictEqual(rejectAll.disabled, false, 'Zamítnout vše je na záložce Schváleno dostupné');
  assert.strictEqual(ctx.actionsEl.querySelector('[data-action="approve-all"]').disabled, true);
  dom.click(row.querySelector('[data-action="reject-approved-row"]'));
  await dom.settle();
  let dlg = dom.dialogs().at(-1);
  assert.match(text(dlg), /Zrušit schválení návrhu CER-10493-XS/);
  dom.click(dlg.querySelector('[data-confirm]'));
  await dom.settle();
  assert.deepStrictEqual(posts.at(-1), ['reject', { ids: [10] }]);
  // hromadně: filtr se stavem approved + expect z výpisu
  dom.click(rejectAll);
  await dom.settle();
  dlg = dom.dialogs().at(-1);
  assert.match(text(dlg), /Zamítnout všechny 2 schválené \(neexportované\) návrhy odpovídající aktuálnímu filtru/);
  dom.click(dlg.querySelector('[data-confirm]'));
  await dom.settle();
  const [kind, body] = posts.at(-1);
  assert.strictEqual(kind, 'reject');
  assert.strictEqual(body.all, true);
  assert.strictEqual(body.filter.status, 'approved');
  assert.deepStrictEqual(body.expect, { count: 2, max_id: 11 });
});

test('contract-12: překlep v ruční ceně → potvrzení s důvody; Zrušit neuloží, potvrzení pošle confirm', async () => {
  items = [proposal()];
  patches.length = 0;
  const { root } = await render();
  const edit = () => {
    dom.click(root.querySelector('tr[data-key="3770"] .price-edit'));
    return root.querySelector('tr[data-key="3770"] .inline-edit input');
  };
  let inp = edit();
  inp.value = '1234,5';
  dom.key(inp, 'Enter');
  await dom.settle();
  let dlg = dom.dialogs().at(-1);
  assert.ok(dlg, 'potvrzení rizikové ruční ceny');
  assert.match(norm(text(dlg)), /pod nákupní cenou 70 000 Kč/);
  assert.match(norm(text(dlg)), /-98,8 %/);
  assert.deepStrictEqual(patches, [{ manual_price: 1234.5 }]);
  dom.click(dlg.querySelector('[data-cancel]'));
  await dom.settle();
  assert.strictEqual(patches.length, 1, 'po Zrušit se nic dalšího neodeslalo');
  assert.ok(!dom.toasts().some((t) => /Ruční cena uložena/.test(t)), 'žádný úspěšný toast');
  inp = root.querySelector('tr[data-key="3770"] .inline-edit input') || edit();
  inp.value = '1234,5';
  dom.key(inp, 'Enter');
  await dom.settle();
  dlg = dom.dialogs().at(-1);
  dom.click(dlg.querySelector('[data-confirm]'));
  await dom.settle();
  assert.deepStrictEqual(patches.at(-1), { manual_price: 1234.5, confirm: true });
  assert.ok(dom.toasts().some((t) => /Ruční cena uložena/.test(norm(t))));
});

test('contract-12: úprava ceny schváleného návrhu hlásí návrat ke schválení', async () => {
  items = [proposal({ status: 'approved', decided_at: '2026-09-26T08:00:00Z' })];
  const { root } = await render({ status: 'approved' });
  dom.click(root.querySelector('tr[data-key="3770"] .price-edit'));
  const inp = root.querySelector('tr[data-key="3770"] .inline-edit input');
  inp.value = '109990';
  dom.key(inp, 'Enter');
  await dom.settle();
  assert.ok(dom.toasts().some((t) => /návrh se vrátil ke schválení/.test(t)), dom.toasts().join(' | '));
});

// ------------------------------------------------------------------ C4 filtry podle produktu, C5 vrátit ke schválení
const apiLib = () => import(pathToFileURL(path.join(PUB, 'lib', 'api.js')).href);

async function renderWithFacets(query = {}) {
  (await apiLib()).invalidate();
  dom.api({
    'GET /segments': { items: [{ id: 3, name: 'Ležáky', count: 40 }, { id: 5, name: 'Klíčové značky', count: 300 }] },
    'GET /products/facets': { manufacturers: [{ value: 'Trek', count: 10 }], owners: [{ value: 'Jana Dvořáková', count: 30 }, { value: 'Petr', count: 5 }], categories: [{ value: 'Horská kola', count: 25 }], suppliers: [] },
    'POST /proposals/unapprove': (req) => {
      posts.push(['unapprove', req.body]);
      return { updated: req.body.ids ? req.body.ids.length : items.filter((p) => p.status === 'approved').length };
    },
  });
  return render(query);
}

test('C4: filtry Zodpovědná osoba, Kategorie, Segment produktu; „Segment strategie“ zůstává zvlášť', async () => {
  items = [proposal()];
  dom.requests.length = 0;
  const { root, ctx } = await renderWithFacets({ owner: 'Jana Dvořáková' });
  const sel = (k) => root.querySelector(`select[data-filter="${k}"]`);
  assert.ok(sel('owner') && sel('category') && sel('product_segment') && sel('segment'));
  assert.strictEqual(sel('segment').getAttribute('aria-label'), 'Segment strategie');
  assert.strictEqual(sel('product_segment').getAttribute('aria-label'), 'Segment produktu');
  assert.deepStrictEqual(sel('product_segment').querySelectorAll('option').map((o) => text(o)), ['Segment produktu: vše', 'Ležáky', 'Klíčové značky']);
  assert.strictEqual(sel('owner').value, 'Jana Dvořáková', 'hodnota z URL');
  const lastGet = () => dom.requests.filter((r) => r.method === 'GET' && r.path === '/proposals').at(-1).query;
  assert.strictEqual(lastGet().owner, 'Jana Dvořáková');
  sel('category').value = 'Horská kola';
  dom.change(sel('category'));
  await dom.settle();
  sel('product_segment').value = '5';
  dom.change(sel('product_segment'));
  await dom.settle();
  assert.deepStrictEqual([lastGet().owner, lastGet().category, lastGet().product_segment], ['Jana Dvořáková', 'Horská kola', '5']);
  assert.strictEqual(ctx.calls.query.at(-1).product_segment, '5', 'filtr je v adrese stránky');
  // „Schválit vše dle filtru“ pošle i nové filtry
  posts.length = 0;
  dom.click(ctx.actionsEl.querySelector('[data-action="approve-all"]'));
  await dom.settle();
  const dlg = dom.dialogs().at(-1);
  assert.match(text(dlg), /Filtr: segment produktu Klíčové značky, zodpovědná osoba Jana Dvořáková, kategorie Horská kola/);
  dom.click(dlg.querySelector('[data-confirm]'));
  await dom.settle();
  const [kind, body] = posts.at(-1);
  assert.strictEqual(kind, 'approve');
  assert.deepStrictEqual({ ...body.filter }, { status: 'pending', owner: 'Jana Dvořáková', category: 'Horská kola', product_segment: '5' });
});

test('C4: filtr nad produkty a dodavatel z URL (bez vlastního výběru) jsou vidět jako štítky a jdou zrušit', async () => {
  items = [proposal()];
  const flt = JSON.stringify({ field: 'group_code', op: '=', value: 'TRK-MARLIN7' });
  const { root } = await renderWithFacets({ supplier: 'Cyklo Distribuce s.r.o.', filter: flt });
  const pills = root.querySelector('[data-role="extra-filters"]');
  assert.strictEqual(pills.hidden, false);
  assert.match(text(pills), /Dodavatel: Cyklo Distribuce s\.r\.o\./);
  assert.match(text(pills), /Filtr produktů:/);
  const lastGet = () => dom.requests.filter((r) => r.method === 'GET' && r.path === '/proposals').at(-1).query;
  assert.strictEqual(lastGet().filter, flt);
  assert.strictEqual(lastGet().supplier, 'Cyklo Distribuce s.r.o.');
  dom.click(pills.querySelector('button[aria-label^="Zrušit filtr Dodavatel"]'));
  await dom.settle();
  assert.strictEqual(lastGet().supplier, undefined);
  assert.strictEqual(lastGet().filter, flt, 'filtr produktů zůstal');
});

test('C5: schválený návrh „Vrátit ke schválení“ – řádek, výběr i vše dle filtru na záložce Schváleno', async () => {
  items = [
    proposal({ id: 20, status: 'approved', decided_at: '2026-09-26T08:00:00Z', decided_by: 'Jana' }),
    proposal({ id: 21, status: 'approved', decided_at: '2026-09-26T08:00:00Z', decided_by: 'auto' }),
  ];
  posts.length = 0;
  const { root, ctx } = await renderWithFacets({ status: 'approved', owner: 'Petr' });
  const row = root.querySelector('tr[data-key="20"]');
  dom.click(row.querySelector('[data-action="unapprove-row"]'));
  await dom.settle();
  assert.deepStrictEqual(posts.at(-1), ['unapprove', { ids: [20] }]);
  assert.ok(dom.toasts().some((t) => /Vráceno ke schválení: 1/.test(t.replace(/[ ]/g, ' '))), dom.toasts().join(' | '));
  // výběr → „Vrátit ke schválení“ v liště hromadných akcí
  const cb = root.querySelector('tr[data-key="21"] input[type="checkbox"]');
  cb.checked = true;
  dom.change(cb);
  const bulkBtn = root.querySelector('[data-action="unapprove-selected"]');
  assert.strictEqual(bulkBtn.hidden, false);
  dom.click(bulkBtn);
  await dom.settle();
  assert.deepStrictEqual(posts.at(-1), ['unapprove', { ids: [21] }]);
  // vše dle filtru – jen schválené, s filtrem a expect
  const allBtn = ctx.actionsEl.querySelector('[data-action="unapprove-all"]');
  assert.strictEqual(allBtn.hidden, false);
  assert.strictEqual(allBtn.disabled, false);
  dom.click(allBtn);
  await dom.settle();
  const dlg = dom.dialogs().at(-1);
  assert.match(text(dlg), /Vrátit ke schválení všechny 2 schválené \(neexportované\) návrhy odpovídající aktuálnímu filtru/);
  assert.match(text(dlg), /do exportu .* nepůjdou/);
  dom.click(dlg.querySelector('[data-confirm]'));
  await dom.settle();
  const [kind, body] = posts.at(-1);
  assert.strictEqual(kind, 'unapprove');
  assert.strictEqual(body.all, true);
  assert.deepStrictEqual({ ...body.filter }, { status: 'approved', owner: 'Petr' });
  assert.deepStrictEqual(body.expect, { count: 2, max_id: 21 });
});

test('C5: na záložce Čeká se „Vrátit vše ke schválení“ nenabízí; exportovaný návrh vrátit nejde', async () => {
  const m = await model();
  assert.strictEqual(m.bulkStatus('unapprove', 'pending'), null);
  assert.strictEqual(m.bulkStatus('unapprove', 'approved'), 'approved');
  assert.strictEqual(m.bulkStatus('unapprove', 'all'), 'approved');
  assert.strictEqual(m.isUnapprovable({ status: 'approved' }), true);
  assert.strictEqual(m.isUnapprovable({ status: 'approved', exported_at: '2026-09-26T08:00:00Z' }), false);
  assert.strictEqual(m.isUnapprovable({ status: 'exported' }), false);
  items = [proposal()];
  const { root, ctx } = await renderWithFacets();
  assert.strictEqual(ctx.actionsEl.querySelector('[data-action="unapprove-all"]').hidden, true);
  assert.strictEqual(root.querySelector('[data-action="unapprove-row"]'), null);
});
