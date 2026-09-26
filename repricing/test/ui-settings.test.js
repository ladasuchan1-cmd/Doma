'use strict';
// Regrese pohledu Nastavení (public/views/settings.js):
//  - contract-13: neplatné číslo se tiše zahodilo a „Nastavení uloženo“ tvrdilo opak,
//  - contract-14: Tab z názvu webhook hlavičky překreslil řádky → fokus na <body> a napsaná hodnota se ztratila,
//  - contract-16: XML šablona nešla doplnit o strategy / segment / lowest_30d (pole serveru ROW_FIELDS),
//  - contract-19: formulář změny hesla se nabízel, i když heslo pochází z CENOTVORBA_PASSWORD (server vrací 409).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { installDom, makeCtx, text } = require('./ui-fake-dom.js');
const { ROW_FIELDS } = require('../src/export/rows.js');

const dom = installDom();
const PUB = path.join(__dirname, '..', 'public');
const view = () => import(pathToFileURL(path.join(PUB, 'views', 'settings.js')).href);

const SETTINGS = {
  currency: 'CZK',
  vat_rate_default: 21,
  purchase_includes_vat: false,
  offer_max_age_days: 7,
  metrics_in_stock_only: false,
  export: {
    update_current_price: true,
    xml: { root: 'prices', item: 'item', fields: ['code', 'ean', 'name', 'price'] },
    pohoda: { ico: '', application: 'Cenotvorba', filter_by: 'code', price_level: '', encoding: 'windows-1250' },
    webhook: { url: '', format: 'json', headers: {}, auto_push: false, timeout_ms: 20000 },
  },
  schedule: { run_interval_minutes: 0, run_after_import: false, auto_push_after_run: false },
  retention_days: 180,
};
const puts = [];
dom.api({
  'GET /settings': () => JSON.parse(JSON.stringify(SETTINGS)),
  'PUT /settings': (req) => {
    puts.push(req.body);
    return { ...SETTINGS, ...req.body };
  },
  'GET /tokens': { items: [] },
});

async function render(query = {}, me) {
  const { show } = await view();
  const root = dom.root();
  const ctx = makeCtx({ query, ...(me ? { me } : {}) });
  await show(root, ctx);
  await dom.settle();
  return root;
}

const fieldInput = (root, label) => {
  const f = root.querySelectorAll('.field').find((x) => x.querySelector('.field-label')?.textContent.startsWith(label));
  return f && f.querySelector('input');
};
const saveBtn = (root) => root.querySelector('[data-action="save-settings"]');

test('contract-13: neplatné číslo zablokuje uložení s chybou; po opravě se uloží', async () => {
  puts.length = 0;
  const root = await render();
  const age = fieldInput(root, 'Max. stáří cen konkurence');
  assert.ok(age);
  assert.match(text(age.closest('.field')), /Povoleno: celé číslo, alespoň 1/, 'pravidlo je vidět u pole');
  dom.type(age, '0');
  assert.ok(age.classList.contains('is-invalid'));
  assert.match(text(age.closest('.field')), /Neplatná hodnota/);
  dom.type(fieldInput(root, 'URL webhooku'), 'https://admin.example.cz/hook');
  dom.click(saveBtn(root));
  await dom.settle();
  assert.deepStrictEqual(puts, [], 'nic se neuložilo');
  assert.ok(dom.toasts().some((t) => /Opravte zvýrazněná pole: Max. stáří cen konkurence/.test(t)), dom.toasts().join(' | '));
  assert.ok(!dom.toasts().some((t) => /Nastavení uloženo/.test(t)));
  assert.strictEqual(dom.document.activeElement, age, 'fokus na neplatném poli');
  // samotná neplatná hodnota (bez jiné změny) drží lištu s uložením viditelnou
  dom.type(age, '14');
  dom.click(saveBtn(root));
  await dom.settle();
  assert.strictEqual(puts.length, 1);
  assert.strictEqual(puts[0].offer_max_age_days, 14);
  assert.strictEqual(puts[0].export.webhook.url, 'https://admin.example.cz/hook');
});

test('contract-14: Tab z názvu hlavičky nezničí pole hodnoty; název i hodnota se uloží', async () => {
  puts.length = 0;
  const root = await render();
  dom.click(dom.byText('Přidat hlavičku', root, 'button'));
  const [nameIn] = root.querySelectorAll('input[aria-label="Název hlavičky"]');
  let valIn = root.querySelector('input[aria-label="Hodnota hlavičky X-Header"]');
  dom.type(nameIn, 'X-Api-Key');
  // Tab: change na názvu, fokus přejde na hodnotu
  dom.change(nameIn);
  valIn.focus();
  assert.strictEqual(valIn.isConnected, true, 'pole hodnoty zůstalo v dokumentu');
  assert.strictEqual(dom.document.activeElement, valIn, 'fokus je na hodnotě, ne na <body>');
  assert.strictEqual(valIn.getAttribute('aria-label'), 'Hodnota hlavičky X-Api-Key');
  dom.type(valIn, 'abc123');
  valIn = root.querySelector('input[aria-label="Hodnota hlavičky X-Api-Key"]');
  assert.strictEqual(valIn.value, 'abc123');
  dom.click(saveBtn(root));
  await dom.settle();
  assert.strictEqual(puts.length, 1);
  assert.strictEqual(puts[0].export.webhook.headers['X-Api-Key'], 'abc123');
});

test('contract-14: duplicitní nebo prázdný název hlavičky se nepřijme (hlavička nezmizí)', async () => {
  const root = await render();
  dom.click(dom.byText('Přidat hlavičku', root, 'button'));
  dom.click(dom.byText('Přidat hlavičku', root, 'button'));
  const names = root.querySelectorAll('input[aria-label="Název hlavičky"]');
  assert.strictEqual(names.length, 2);
  dom.type(names[1], 'X-Header');
  dom.change(names[1]);
  assert.strictEqual(names[1].value, 'X-Header-2', 'duplicitní název vrácen');
  dom.type(names[0], '');
  dom.change(names[0]);
  assert.strictEqual(names[0].value, 'X-Header', 'prázdný název vrácen');
  assert.strictEqual(root.querySelectorAll('input[aria-label="Název hlavičky"]').length, 2);
});

test('contract-16: XML šablona nabízí všechna pole exportu serveru (i lowest_30d, strategy, segment)', async () => {
  const { XML_FIELDS } = await view();
  for (const f of ROW_FIELDS) assert.ok(XML_FIELDS.includes(f), 'chybí pole ' + f);
  const root = await render();
  const chipsInput = root.querySelector('input.chips-input');
  chipsInput.focus();
  await dom.settle();
  dom.type(chipsInput, 'lowest_30d');
  dom.key(chipsInput, 'Enter');
  await dom.settle();
  const chips = root.querySelectorAll('.chip-text').map((c) => c.textContent);
  assert.ok(chips.includes('lowest_30d'), chips.join(','));
  assert.match(text(root.querySelector('.code')), /<lowest_30d>20990<\/lowest_30d>/, 'náhled XML s ukázkovou hodnotou');
});

test('contract-19: heslo z CENOTVORBA_PASSWORD → místo formuláře vysvětlení', async () => {
  const root = await render({ tab: 'heslo' }, { user: 'admin', scopes: ['admin'], password_from_env: true });
  assert.strictEqual(root.querySelector('input[type="password"]'), null, 'žádný formulář');
  assert.match(text(root), /Heslo je nastavené proměnnou prostředí CENOTVORBA_PASSWORD/);
  const root2 = await render({ tab: 'heslo' }, { user: 'admin', scopes: ['admin'], password_from_env: false });
  assert.strictEqual(root2.querySelectorAll('input[type="password"]').length, 3, 'bez proměnné prostředí formulář zůstává');
});

test('contract-1: nastavení plánování varuje, že přecenění nahradí i schválené neexportované návrhy', async () => {
  const root = await render();
  const warn = root.querySelector('[data-role="schedule-warning"]');
  assert.ok(warn);
  assert.match(text(warn), /i schválené, dosud neexportované; jejich schválení se ztratí/);
});
