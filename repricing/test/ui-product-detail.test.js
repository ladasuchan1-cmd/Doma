'use strict';
// Regrese contract-1 v detailu produktu: „Přepočítat“ nahradí schválený (neexportovaný) návrh i ruční cenu –
// dřív bez jakéhokoli dotazu (skipConfirm + quiet). Teď se při takovém návrhu ukáže danger potvrzení.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { installDom, makeCtx, text } = require('./ui-fake-dom.js');

const dom = installDom();
const PUB = path.join(__dirname, '..', 'public');
const view = () => import(pathToFileURL(path.join(PUB, 'views', 'product-detail.js')).href);
const lib = (f) => import(pathToFileURL(path.join(PUB, 'lib', f)).href);

let proposals = [];
dom.api({
  'GET /products/:id': (req) => ({
    product: { id: Number(req.params[0]), code: 'CER-04578-L', name: 'Cervélo Áspero, L', price: 86990, purchase_price: 60000, vat: 21, stock: 2, active: 1, locked: 0, lock_active: false, created_at: '2026-01-01T00:00:00Z' },
    offers: [],
    history: { our: [], competitors: [] },
    explain: { decision: null, strategy: null, segments: [], tried: [] },
    proposals,
  }),
});

async function render() {
  const { show } = await view();
  const ctx = makeCtx({ params: { id: '654' } });
  await show(dom.root(), ctx);
  await dom.settle();
  return ctx;
}

test('proposalAtRisk: jen schválený neexportovaný návrh (čekající s ruční cenou se přenese, o nic nepřijde)', async () => {
  const { proposalAtRisk } = await lib('proposal-model.js');
  assert.strictEqual(proposalAtRisk([]), null);
  assert.strictEqual(proposalAtRisk([{ status: 'pending', new_price: 100, manual_price: null }]), null);
  assert.strictEqual(proposalAtRisk([{ status: 'pending', new_price: 100, manual_price: 95 }]), null);
  assert.strictEqual(proposalAtRisk([{ status: 'exported', manual_price: 90 }, { status: 'superseded', manual_price: 80 }]), null);
  assert.strictEqual(proposalAtRisk([{ id: 1, status: 'approved', new_price: 100 }]).id, 1);
  assert.strictEqual(proposalAtRisk([{ id: 2, status: 'approved', new_price: 100, manual_price: 95 }]).id, 2);
});

test('Přepočítat se schváleným návrhem s ruční cenou → danger potvrzení; Zrušit nic nespustí', async () => {
  proposals = [{ id: 547, status: 'approved', old_price: 86990, new_price: 99990, manual_price: 99980, final_price: 99980, final_change_pct: 14.94, flags: [], created_at: '2026-09-25T08:00:00Z' }];
  const ctx = await render();
  const btn = ctx.actionsEl.querySelector('[data-action="reprice-one"]');
  assert.ok(btn);
  dom.click(btn);
  await dom.settle();
  let dlg = dom.dialogs().at(-1);
  assert.ok(dlg, 'potvrzení před přepočtem');
  assert.match(text(dlg), /schválený, dosud neexportovaný návrh 99 980 Kč \(ruční cena\)/);
  assert.match(text(dlg), /schválení se ztratí – ruční cena se do nového návrhu přenese, ale musí se znovu schválit/);
  assert.ok(dlg.querySelector('[data-confirm].btn-danger'));
  dom.click(dlg.querySelector('[data-cancel]'));
  await dom.settle();
  assert.deepStrictEqual(ctx.calls.runPricing, [], 'po Zrušit se nepřeceňovalo');
  dom.click(btn);
  await dom.settle();
  dlg = dom.dialogs().at(-1);
  dom.click(dlg.querySelector('[data-confirm]'));
  await dom.settle();
  assert.deepStrictEqual(ctx.calls.runPricing, [{ productIds: [654], skipConfirm: true, quiet: true }]);
});

test('Přepočítat bez schváleného návrhu (jen čekající, i s ruční cenou) → rovnou přepočet bez dialogu', async () => {
  proposals = [{ id: 548, status: 'pending', old_price: 86990, new_price: 88990, manual_price: 87990, flags: [], created_at: '2026-09-25T08:00:00Z' }];
  const ctx = await render();
  dom.click(ctx.actionsEl.querySelector('[data-action="reprice-one"]'));
  await dom.settle();
  assert.strictEqual(dom.dialogs().length, 0);
  assert.strictEqual(ctx.calls.runPricing.length, 1);
});
