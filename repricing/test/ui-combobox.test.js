'use strict';
// Regrese contract-3: našeptávač v „čipových“ vstupech (filtr segmentu, štítky konkurentů, pole XML feedu).
//  - Enter do 120 ms po posledním úhozu (debounce ještě neproběhl) nesmí vybrat zastaralou první položku,
//  - prázdný seznam návrhů nesmí nechat „aktivní“ starou položku – Enter pak přidá napsanou hodnotu.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { installDom } = require('./ui-fake-dom.js');

const dom = installDom();
const lib = (f) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'lib', f)).href);

const TAGS = ['klíčový', 'marketplace', 'bazar', 'kamenná prodejna', 'zahraniční'];

async function chips(opts) {
  const { chipsInput } = await lib('chips.js');
  const c = chipsInput(opts);
  dom.root().appendChild(c.el);
  return c;
}

test('rychlé psaní + Enter přidá napsaný štítek, ne zastaralou první položku seznamu', async () => {
  const c = await chips({ values: [], suggestions: TAGS });
  c.input.focus();
  await dom.settle(); // seznam se otevře se všemi štítky a zvýrazní „klíčový“
  assert.ok(c.el.querySelector('.cb-item.is-active'), 'po fokusu je zvýrazněná první položka');
  dom.type(c.input, 'bazar'); // debounce 120 ms ještě neproběhl
  dom.key(c.input, 'Enter');
  assert.deepStrictEqual(c.getValues(), ['bazar']);
  assert.strictEqual(c.input.value, '');
  // druhá hodnota stejně rychle (seznam je po výběru zavřený)
  dom.type(c.input, 'marketplace');
  dom.key(c.input, 'Enter');
  assert.deepStrictEqual(c.getValues(), ['bazar', 'marketplace']);
});

test('rychlé psaní části názvu + Enter vybere shodu stejně jako při pomalém psaní', async () => {
  const c = await chips({ values: [], suggestions: TAGS });
  c.input.focus();
  await dom.settle();
  dom.type(c.input, 'market'); // otevřený seznam ukazuje ještě všechny štítky
  dom.key(c.input, 'Enter');
  assert.deepStrictEqual(c.getValues(), ['marketplace']);
});

test('prázdný seznam návrhů: Enter přidá zadanou hodnotu (dřív nepřidal nic)', async () => {
  const c = await chips({ values: [], suggestions: TAGS });
  c.input.focus();
  await dom.settle();
  dom.type(c.input, 'outlet');
  await dom.settle(40); // debounce doběhl → „Enter přidá zadanou hodnotu“
  assert.match(c.el.querySelector('.cb-list').textContent, /Enter přidá zadanou hodnotu/);
  assert.strictEqual(c.el.querySelector('.cb-item.is-active'), null, 'nic není zvýrazněné');
  dom.key(c.input, 'Enter');
  assert.deepStrictEqual(c.getValues(), ['outlet']);
  assert.strictEqual(c.input.value, '');
});

test('filtr segmentu „je jedno z“: N7, N8 rychle za sebou → přesně [N7, N8]', async () => {
  const sugg = ['N0', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8'].map((v, i) => ({ value: v, count: 100 - i }));
  const c = await chips({ values: [], suggestions: sugg });
  c.input.focus();
  await dom.settle();
  dom.type(c.input, 'N7');
  dom.key(c.input, 'Enter');
  dom.type(c.input, 'N8');
  dom.key(c.input, 'Enter');
  assert.deepStrictEqual(c.getValues(), ['N7', 'N8']);
});

test('allowNew:false (pole XML feedu) – neznámá hodnota se nepřidá a nevybere se ani zastaralý návrh', async () => {
  const c = await chips({ values: ['code'], suggestions: ['code', 'ean', 'manufacturer', 'price'], allowNew: false });
  c.input.focus();
  await dom.settle();
  dom.type(c.input, 'nesmysl');
  dom.key(c.input, 'Enter');
  assert.deepStrictEqual(c.getValues(), ['code']);
});

test('asynchronní zdroj: Enter před doběhnutím hledání nevybere položku ze starého seznamu', async () => {
  const { combobox } = await lib('combobox.js');
  const host = dom.root();
  const input = dom.document.createElement('input');
  host.appendChild(input);
  const picked = [];
  const all = ['Specialized', 'Scott', 'Trek'];
  combobox(input, {
    source: (q) => new Promise((r) => setTimeout(() => r(all.filter((x) => x.toLowerCase().includes(q.toLowerCase())).map((v) => ({ value: v, label: v }))), 5)),
    onPick: (it) => picked.push(it.value),
  });
  input.focus();
  await dom.settle(10);
  assert.ok(host.querySelector('.cb-item.is-active'));
  dom.type(input, 'Tre');
  const ev = dom.key(input, 'Enter');
  assert.deepStrictEqual(picked, [], 'stará položka „Specialized“ se nevybrala');
  assert.strictEqual(ev.defaultPrevented, false, 'Enter zůstal volajícímu');
  await dom.settle(10);
  assert.strictEqual(host.querySelector('.cb-item.is-active')?.textContent, 'Trek', 'po doběhnutí je zvýrazněná nová shoda');
});
