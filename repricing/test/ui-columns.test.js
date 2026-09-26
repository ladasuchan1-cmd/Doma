'use strict';
// Výběr sloupců tabulky Produkty (public/lib/columns.js + public/views/products.js):
//  - sloupce z GET /fields (i attrs.*, group_code, sales_30, msrp, owner…), výběr v localStorage a v URL ?cols=,
//  - řazení na serveru podle klíče pole (sort=attrs.N), hodnota podle cesty s tečkami, formát podle typu pole,
//  - nedostupné úložiště (soukromé okno) ani neznámé pole stránku nerozbijí.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { installDom, makeCtx, text } = require('./ui-fake-dom.js');

const dom = installDom();
const PUB = path.join(__dirname, '..', 'public');
const lib = () => import(pathToFileURL(path.join(PUB, 'lib', 'columns.js')).href);
const view = () => import(pathToFileURL(path.join(PUB, 'views', 'products.js')).href);
const norm = (s) => String(s).replace(/[\u00a0\u202f]/g, ' ');

const FIELDS = [
  { key: 'code', label: 'Kód', type: 'string', group: 'Produkt' },
  { key: 'name', label: 'Název', type: 'string', group: 'Produkt' },
  { key: 'owner', label: 'Zodpovědná osoba', type: 'string', group: 'Produkt' },
  { key: 'group_code', label: 'Skupina / model', type: 'string', group: 'Produkt' },
  { key: 'lock_active', label: 'Zámek platí', type: 'boolean', group: 'Produkt' },
  { key: 'price', label: 'Prodejní cena s DPH', type: 'number', group: 'Ceny a marže', unit: 'Kč' },
  { key: 'msrp', label: 'MOC (doporučená cena)', type: 'number', group: 'Ceny a marže', unit: 'Kč' },
  { key: 'margin_pct', label: 'Marže', type: 'number', group: 'Ceny a marže', unit: '%' },
  { key: 'price_changed_at', label: 'Poslední změna ceny', type: 'string', group: 'Ceny a marže' },
  { key: 'position', label: 'Pozice na trhu', type: 'enum', group: 'Trh', value_labels: { cheapest: 'Nejlevnější', middle: 'Uprostřed' } },
  { key: 'sales_30', label: 'Prodej za 30 dní (ks)', type: 'number', group: 'Sklad a prodeje', unit: 'ks' },
  { key: 'days_of_cover', label: 'Zásoba na počet dní', type: 'number', group: 'Sklad a prodeje', unit: 'dní' },
  { key: 'attrs.N', label: 'N', type: 'string', group: 'Vlastní atributy' },
  { key: 'attrs.imprese_30', label: 'imprese_30', type: 'number', group: 'Vlastní atributy' },
  { key: 'attrs.PARAM.Barva', label: 'PARAM.Barva', type: 'string', group: 'Vlastní atributy' },
];

test('parseCols / serializeCols: pořadí, duplicity, povinný název, čárka v názvu atributu', async () => {
  const c = await lib();
  assert.deepStrictEqual(c.parseCols('code,price,code'), ['name', 'code', 'price'], 'povinný sloupec název se doplní, duplicita pryč');
  assert.strictEqual(c.parseCols(''), null);
  assert.strictEqual(c.parseCols(null), null);
  const cols = ['name', 'attrs.Velikost, rám', 'attrs.100%'];
  const s = c.serializeCols(cols);
  assert.ok(!s.includes('Velikost,') && s.split(',').length === 3, 'čárka v klíči je zakódovaná: ' + s);
  assert.deepStrictEqual(c.parseCols(s), cols, 'tam a zpět beze změny');
  assert.strictEqual(c.parseCols(Array.from({ length: 80 }, (_, i) => 'attrs.a' + i)).length, c.MAX_COLUMNS);
  assert.strictEqual(c.isDefaultCols([...c.DEFAULT_COLUMNS]), true);
  assert.strictEqual(c.isDefaultCols(['name']), false);
});

test('resolveCols: URL > localStorage > výchozí; nedostupné úložiště nevadí', async () => {
  const c = await lib();
  localStorage.removeItem(c.COLS_STORAGE_KEY);
  assert.strictEqual(c.resolveCols({}).source, 'default');
  assert.strictEqual(c.saveStoredCols(['name', 'owner']), true);
  assert.deepStrictEqual(c.resolveCols({}), { cols: ['name', 'owner'], source: 'storage' });
  assert.deepStrictEqual(c.resolveCols({ url: 'code,name' }), { cols: ['code', 'name'], source: 'url' });
  // výchozí výběr se neukládá (smaže uložený)
  c.saveStoredCols([...c.DEFAULT_COLUMNS]);
  assert.strictEqual(localStorage.getItem(c.COLS_STORAGE_KEY), null);
  // rozbitý JSON v úložišti → výchozí
  localStorage.setItem(c.COLS_STORAGE_KEY, '{nejde');
  assert.strictEqual(c.resolveCols({}).source, 'default');
  // soukromé okno: přístup k úložišti hází
  const orig = { get: localStorage.getItem, set: localStorage.setItem };
  localStorage.getItem = () => {
    throw new Error('SecurityError');
  };
  localStorage.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  try {
    assert.strictEqual(c.loadStoredCols(), null);
    assert.strictEqual(c.saveStoredCols(['name', 'msrp']), false);
    assert.strictEqual(c.resolveCols({}).source, 'default');
  } finally {
    localStorage.getItem = orig.get;
    localStorage.setItem = orig.set;
    localStorage.removeItem(c.COLS_STORAGE_KEY);
  }
});

test('valueAt a formatFieldValue: cesta s tečkami (i tečka v názvu atributu), formát podle typu a jednotky', async () => {
  const c = await lib();
  const row = { price: 12990, attrs: { N: 'N7', 'PARAM.Barva': 'černá', imprese_30: 1234 }, proposal: { status: 'pending' } };
  assert.strictEqual(c.valueAt(row, 'attrs.N'), 'N7');
  assert.strictEqual(c.valueAt(row, 'attrs.PARAM.Barva'), 'černá', 'atribut s tečkou v názvu');
  assert.strictEqual(c.valueAt(row, 'proposal.status'), 'pending');
  assert.strictEqual(c.valueAt(row, 'attrs.chybi'), undefined);
  const F = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
  assert.strictEqual(norm(c.formatFieldValue(F.price, 12990)), '12 990 Kč');
  assert.strictEqual(norm(c.formatFieldValue(F.margin_pct, 18.456)), '18,5 %');
  assert.strictEqual(norm(c.formatFieldValue(F.sales_30, 1200)), '1 200');
  assert.strictEqual(c.formatFieldValue(F.lock_active, true), 'ano');
  assert.strictEqual(c.formatFieldValue(F.lock_active, 0), 'ne');
  assert.strictEqual(c.formatFieldValue(F.position, 'cheapest'), 'Nejlevnější');
  assert.strictEqual(c.formatFieldValue(F['attrs.N'], 'N7'), 'N7');
  assert.strictEqual(norm(c.formatFieldValue(F['attrs.imprese_30'], 1234)), '1 234');
  assert.strictEqual(c.formatFieldValue(F.msrp, null), '–');
  assert.strictEqual(c.formatFieldValue(F.group_code, ''), '–');
  assert.match(c.formatFieldValue(F.price_changed_at, '2026-09-20T08:00:00Z'), /2026/);
  assert.strictEqual(c.fieldFormat(F.days_of_cover), 'days');
  assert.strictEqual(c.isNumericFormat(c.fieldFormat(F.price)), true);
  assert.strictEqual(c.isNumericFormat(c.fieldFormat(F.owner)), false);
});

test('toggleCol / moveCol / pickerGroups', async () => {
  const c = await lib();
  let cols = ['name', 'code'];
  cols = c.toggleCol(cols, 'group_code', true);
  assert.deepStrictEqual(cols, ['name', 'code', 'group_code']);
  assert.deepStrictEqual(c.toggleCol(cols, 'name', false), cols, 'název nejde skrýt');
  assert.deepStrictEqual(c.moveCol(cols, 'group_code', -1), ['name', 'group_code', 'code']);
  assert.deepStrictEqual(c.moveCol(cols, 'name', -1), cols, 'první nejde výš');
  const groups = c.pickerGroups(FIELDS);
  assert.deepStrictEqual(groups.map((g) => g.group), ['Produkt', 'Ceny a marže', 'Trh', 'Sklad a prodeje', 'Vlastní atributy', 'Cenotvorba']);
  assert.ok(groups.find((g) => g.group === 'Cenotvorba').fields.some((f) => f.key === 'proposal'), 'sloupec Návrh ceny');
});

// ------------------------------------------------------------------ pohled Produkty
const requests = [];
dom.api({
  'GET /products/facets': { manufacturers: [], categories: [], owners: [], suppliers: [], attrs: {} },
  'GET /segments': { items: [] },
  'GET /fields': { fields: FIELDS },
  'GET /products': (req) => {
    requests.push(req.query);
    return {
      items: [
        { id: 7, code: 'TRK-MAR5-M', name: 'Trek Marlin 5, M', manufacturer: 'Trek', owner: 'Jana', group_code: 'TRK-MARLIN5-2026', price: 13990, msrp: 14990, margin_pct: 21.4, sales_30: 3, position: 'cheapest', attrs: { N: 'N2', imprese_30: 4521, 'PARAM.Barva': 'modrá' }, proposal: null, segments: [] },
      ],
      total: 1, page: 1, limit: 50,
    };
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
const headers = (root) => root.querySelectorAll('thead th').map((th) => text(th));

test('Produkty: sloupce z URL ?cols= (atributy, skupina, MOC), hodnoty podle typu, řazení podle klíče pole na serveru', async () => {
  localStorage.removeItem('ct-products-cols');
  requests.length = 0;
  const { root } = await render({ cols: 'code,name,group_code,msrp,attrs.N,attrs.imprese_30,attrs.PARAM.Barva,owner' });
  assert.deepStrictEqual(headers(root), ['Kód', 'Název', 'Skupina / model', 'MOC (doporučená cena)', 'N', 'imprese_30', 'PARAM.Barva', 'Zodpovědná osoba']);
  const row = root.querySelector('tr[data-key="7"]');
  const t = norm(text(row));
  assert.match(t, /TRK-MARLIN5-2026/);
  assert.match(t, /14 990 Kč/, 'MOC jako peníze');
  assert.match(t, /4 521/, 'číselný atribut s oddělovačem tisíců');
  assert.match(t, /modrá/, 'atribut s tečkou v názvu');
  assert.match(t, /Jana/);
  // řazení: klik na hlavičku číselného atributu → sort=attrs.imprese_30, nejdřív sestupně
  const th = root.querySelectorAll('thead th').find((x) => text(x) === 'imprese_30');
  dom.click(th.querySelector('button'));
  await dom.settle();
  assert.strictEqual(requests.at(-1).sort, 'attrs.imprese_30');
  assert.strictEqual(requests.at(-1).dir, 'desc');
  const thN = root.querySelectorAll('thead th').find((x) => text(x) === 'N');
  dom.click(thN.querySelector('button'));
  await dom.settle();
  assert.strictEqual(requests.at(-1).sort, 'attrs.N');
  assert.strictEqual(requests.at(-1).dir, 'asc', 'textové pole nejdřív vzestupně');
});

test('Produkty: výběr sloupců v dialogu → tabulka, localStorage i URL; výchozí sloupce smažou uložený výběr', async () => {
  localStorage.removeItem('ct-products-cols');
  const { root, ctx } = await render();
  assert.ok(headers(root).includes('Návrh'), 'výchozí sloupce');
  const btn = root.querySelector('[data-action="columns"]');
  assert.ok(btn, 'tlačítko Sloupce');
  dom.click(btn);
  await dom.settle();
  const dlg = dom.dialogs().at(-1);
  assert.ok(dlg, 'dialog výběru sloupců');
  assert.match(text(dlg), /Vlastní atributy/);
  // hledání polí
  dom.type(dlg.querySelector('input[type="search"]'), 'za 30');
  const boxes = dlg.querySelectorAll('input[data-col]');
  assert.deepStrictEqual(boxes.map((b) => b.dataset.col), ['sales_30'], 'hledání zúží seznam');
  boxes[0].checked = true;
  dom.change(boxes[0]);
  dom.type(dlg.querySelector('input[type="search"]'), '');
  const grp = dlg.querySelector('input[data-col="group_code"]');
  grp.checked = true;
  dom.change(grp);
  dom.click(dlg.querySelector('[data-action="apply-columns"]'));
  await dom.settle();
  const hs = headers(root);
  assert.ok(hs.includes('Prodej za 30 dní (ks)') && hs.includes('Skupina / model'), hs.join(' | '));
  const stored = JSON.parse(localStorage.getItem('ct-products-cols'));
  assert.deepStrictEqual(stored.slice(-2), ['sales_30', 'group_code']);
  assert.match(ctx.calls.query.at(-1).cols, /sales_30,group_code$/, 'výběr je i v adrese stránky');
  // nová návštěva bez ?cols= → uložený výběr
  const again = await render();
  assert.ok(headers(again.root).includes('Skupina / model'));
  // výchozí sloupce
  dom.click(again.root.querySelector('[data-action="columns"]'));
  await dom.settle();
  const dlg2 = dom.dialogs().at(-1);
  dom.click(dlg2.querySelector('[data-action="reset-columns"]'));
  dom.click(dlg2.querySelector('[data-action="apply-columns"]'));
  await dom.settle();
  assert.strictEqual(localStorage.getItem('ct-products-cols'), null);
  assert.strictEqual(again.ctx.calls.query.at(-1).cols, null, 'výchozí výběr se do URL nepíše');
});

test('Produkty: neznámé pole v ?cols= se vynechá a řazení podle neznámého pole spadne na kód (API by vrátilo 400)', async () => {
  requests.length = 0;
  const { root } = await render({ cols: 'name,attrs.zmizely,price', sort: 'attrs.zmizely', dir: 'desc' });
  assert.deepStrictEqual(headers(root), ['Název', 'Cena']);
  assert.strictEqual(requests.at(-1).sort, 'code');
  assert.strictEqual(requests.at(-1).dir, 'asc');
});
