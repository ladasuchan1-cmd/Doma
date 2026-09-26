'use strict';
// Regrese app.js (celá SPA nad falešným DOM a falešným API):
//  - contract-1: potvrzení „Spustit přecenění“ výslovně říká, kolik SCHVÁLENÝCH neexportovaných návrhů běh nahradí,
//    a výsledek běhu ukazuje stats.superseded („Nahrazeno“),
//  - contract-15: otevřený dialog se při navigaci (Zpět / změna hashe) zavře a nezůstane nad jinou stránkou.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { installDom, text } = require('./ui-fake-dom.js');

const dom = installDom();
const PUB = path.join(__dirname, '..', 'public');
const runs = [];
let approved = 56;

dom.api({
  'GET /auth/me': { user: 'admin', scopes: ['read', 'import', 'export', 'admin'], via: 'session' },
  'GET /health': { ok: true, version: 'test' },
  'GET /proposals': (req) => ({ items: [], total: req.query.status === 'approved' ? approved : 10, page: 1, limit: 1, summary: { pending: 10, approved, exported_today: 0, up: 0, down: 0 } }),
  'GET /dashboard': { products: { active: 0 } },
  'POST /runs': (req) => {
    runs.push(req.body);
    return { run_id: 42, stats: { products: 1500, evaluated: 1500, changes: 133, up: 60, down: 73, no_change: 1300, skipped: {}, pending: 120, auto_approved: 13, superseded: 58, margin_impact_abs: 1000, by_strategy: {} } };
  },
});

let app;
test.before(async () => {
  const el = dom.document.createElement('div');
  el.setAttribute('id', 'app');
  dom.document.body.appendChild(el);
  dom.location.hash = '#/prehled';
  app = await import(pathToFileURL(path.join(PUB, 'app.js')).href);
  await dom.settle();
});

test('Spustit přecenění: potvrzení jmenuje počet schválených návrhů, které se zruší (danger)', async () => {
  approved = 56;
  const p = app.runPricing();
  await dom.settle();
  const dlg = dom.dialogs().at(-1);
  assert.ok(dlg, 'potvrzovací dialog');
  const t = text(dlg);
  assert.match(t, /Čeká 56 schválených, dosud neexportovaných návrhů/);
  assert.match(t, /jinak ho nahradí nový návrh a schválení se ztratí/);
  assert.ok(dlg.querySelector('[data-role="supersede-warning"]'));
  assert.ok(dlg.querySelector('[data-confirm].btn-danger'), 'potvrzení je nebezpečná akce');
  assert.match(text(dlg.querySelector('[data-confirm]')), /Přesto přecenit/);
  dom.click(dlg.querySelector('[data-confirm]'));
  const res = await p;
  assert.strictEqual(res.run_id, 42);
  assert.strictEqual(runs.length, 1);
  // výsledek běhu ukazuje, kolik návrhů bylo nahrazeno
  await dom.settle();
  const result = dom.dialogs().at(-1);
  assert.match(text(result), /Přecenění dokončeno/);
  const kpi = result.querySelectorAll('.kpi').find((k) => /Nahrazeno/.test(k.textContent));
  assert.ok(kpi, 'dlaždice Nahrazeno');
  assert.match(text(kpi), /58/);
  dom.click(dom.byText('Zavřít', result, 'button'));
});

test('bez schválených návrhů: běžné potvrzení bez varování', async () => {
  approved = 0;
  const p = app.runPricing();
  await dom.settle();
  const dlg = dom.dialogs().at(-1);
  assert.strictEqual(dlg.querySelector('[data-role="supersede-warning"]'), null);
  assert.ok(dlg.querySelector('[data-confirm].btn-primary'));
  dom.click(dlg.querySelector('[data-cancel]'));
  assert.strictEqual(await p, null);
  assert.strictEqual(runs.length, 1, 'zrušeno – nic se nespustilo');
});

test('quiet běh (přepočet produktu) hlásí počet nahrazených návrhů', async () => {
  await app.runPricing({ productIds: [5], skipConfirm: true, quiet: true });
  await dom.settle();
  assert.ok(dom.toasts().some((t) => /Přecenění dokončeno · 58 starších návrhů nahrazeno/.test(t.replace(/\s+/g, ' '))), dom.toasts().join(' | '));
});

test('navigace (Zpět / nový hash) zavře otevřený dialog předchozí stránky', async () => {
  const { openModal, confirmDialog } = await import(pathToFileURL(path.join(PUB, 'lib', 'modal.js')).href);
  const m = openModal({ title: 'Konkurent VeloMarket.cz', body: 'x' });
  const c = confirmDialog({ message: 'Opravdu?' });
  assert.strictEqual(dom.dialogs().length, 2);
  dom.location.hash = '#/neexistuje';
  await dom.settle();
  assert.strictEqual(dom.dialogs().length, 0, 'žádný dialog nezůstal otevřený');
  assert.strictEqual(m.el.isConnected, false);
  assert.strictEqual(await c, false, 'potvrzení se při odchodu vyhodnotí jako zrušené');
});

test('runStatsView: „Nahrazeno“ jen u ostrého běhu, ne u simulace', async () => {
  const { runStatsView } = await import(pathToFileURL(path.join(PUB, 'lib', 'run-stats.js')).href);
  const run = runStatsView({ superseded: 3, kept: 7, held_by_human: 2 });
  const k = run.querySelectorAll('.kpi').find((x) => /Nahrazeno/.test(x.textContent));
  assert.ok(k);
  assert.match(text(k), /3/);
  assert.match(text(k), /ponecháno beze změny 7/);
  assert.match(text(run), /2 návrhy čekají na nové schválení/);
  const sim = runStatsView({ superseded: 3 }, { simulate: true });
  assert.ok(!sim.querySelectorAll('.kpi').some((x) => /Nahrazeno/.test(x.textContent)));
});
