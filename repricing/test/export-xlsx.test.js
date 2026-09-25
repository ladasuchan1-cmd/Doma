'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { proposalsXlsx, rowsXlsx } = require('../src/export/xlsx-report');
const { readXlsx, readZip } = require('../src/formats');

// Tvar jako z GET /api/v1/proposals: návrh + product {…} + strategy_name + segment_name + flags[] + explain[]
const PROPOSALS = [
  {
    id: 1,
    status: 'pending',
    old_price: 19990,
    new_price: 18990,
    manual_price: null,
    change_abs: -1000,
    change_pct: -5,
    margin_before: 22.5,
    margin_after: 18.25,
    market_min: 19190,
    competitor_count: 4,
    rank_before: 3,
    rank_after: 1,
    created_at: '2026-09-25T08:00:00.000Z',
    product: { code: 'KOLO-TREK-FX2-M', name: 'Trek FX 2 „M“', manufacturer: 'Trek', category: 'Kola', stock: 3, purchase_price: 12000 },
    strategy_name: 'Medián trhu −2 %',
    segment_name: 'Klíčové značky',
    flags: ['change_limited', 'big_change'],
    explain: [{ step: 'market', text: 'Nejnižší cena trhu' }],
    cheapest_competitor: 'VeloMarket',
  },
  {
    // zploštělá varianta + ruční cena + neznámý příznak + flags jako JSON řetězec
    id: 2,
    status: 'approved',
    code: 'PLAST-29',
    name: 'Plášť',
    manufacturer: 'Schwalbe',
    old_price: 949,
    new_price: 999,
    manual_price: 899,
    change_pct: 5.27,
    margin_before: 30,
    margin_after: 33,
    strategy_name: 'Medián trhu −2 %',
    segment_name: null,
    flags: '["floor","vlastni"]',
    market: { cheapest: { competitor: 'Kolo-shop.cz', price: 920 } },
  },
  {
    id: 3,
    status: 'exported',
    product: { code: 'HELMA', name: 'Přilba', manufacturer: 'Abus' },
    old_price: 2490,
    new_price: 2590,
    change_pct: 4.02,
    strategy_name: null,
    flags: [],
  },
];

test('proposalsXlsx: listy Návrhy a Souhrn, české hlavičky, hodnoty', () => {
  const buf = proposalsXlsx(PROPOSALS, { date: new Date('2026-09-25T10:00:00Z') });
  assert.ok(Buffer.isBuffer(buf));
  const wb = readXlsx(buf, { sheet: 'Návrhy' });
  assert.deepEqual(wb.sheets, ['Návrhy', 'Souhrn']);
  for (const h of ['Kód', 'Název', 'Výrobce', 'Segment', 'Strategie', 'Původní cena', 'Navržená cena', 'Ruční cena', 'Cena k exportu', 'Změna %', 'Marže před %', 'Marže po %', 'Minimum trhu', 'Nejlevnější konkurent', 'Pořadí před', 'Pořadí po', 'Stav', 'Příznaky']) {
    assert.ok(wb.headers.includes(h), `chybí sloupec ${h}`);
  }
  assert.equal(wb.rows.length, 3);
  const [a, b, c] = wb.rows;
  assert.equal(a['Kód'], 'KOLO-TREK-FX2-M');
  assert.equal(a['Název'], 'Trek FX 2 „M“');
  assert.equal(a['Segment'], 'Klíčové značky');
  assert.equal(a['Strategie'], 'Medián trhu −2 %');
  assert.equal(a['Původní cena'], 19990);
  assert.equal(a['Navržená cena'], 18990);
  assert.equal(a['Cena k exportu'], 18990);
  assert.equal(a['Změna %'], -5);
  assert.equal(a['Marže po %'], 18.25);
  assert.equal(a['Minimum trhu'], 19190);
  assert.equal(a['Nejlevnější konkurent'], 'VeloMarket');
  assert.equal(a['Pořadí před'], 3);
  assert.equal(a['Pořadí po'], 1);
  assert.equal(a['Stav'], 'Čeká na schválení');
  assert.equal(a['Příznaky'], 'omezeno limitem změny, velká změna');
  assert.equal(a['Vytvořeno'], '2026-09-25T10:00:00', 'datum v pražském čase');

  assert.equal(b['Kód'], 'PLAST-29');
  assert.equal(b['Ruční cena'], 899);
  assert.equal(b['Cena k exportu'], 899);
  assert.equal(b['Změna %'], -5.27, 'přepočet podle ruční ceny');
  assert.equal(b['Změna Kč'], -50);
  assert.equal(b['Nejlevnější konkurent'], 'Kolo-shop.cz');
  assert.equal(b['Příznaky'], 'spodní hranice, vlastni');
  assert.equal(b['Stav'], 'Schváleno');

  assert.equal(c['Stav'], 'Exportováno');
  assert.equal(c['Strategie'], '');
  assert.equal(c['Příznaky'], '');
});

test('proposalsXlsx: souhrn podle stavu a strategie', () => {
  const wb = readXlsx(proposalsXlsx(PROPOSALS), { sheet: 'Souhrn' });
  assert.deepEqual(wb.headers, ['Skupina', 'Hodnota', 'Počet návrhů', 'Zdražení', 'Zlevnění', 'Průměrná změna %', 'Součet změn Kč']);
  const rows = wb.rows.map((r) => [r['Skupina'], r['Hodnota'], r['Počet návrhů'], r['Zdražení'], r['Zlevnění']]);
  assert.deepEqual(rows, [
    ['Celkem', 'Všechny návrhy', 3, 1, 2],
    ['Stav', 'Čeká na schválení', 1, 0, 1],
    ['Stav', 'Schváleno', 1, 0, 1],
    ['Stav', 'Exportováno', 1, 1, 0],
    ['Strategie', 'Medián trhu −2 %', 2, 0, 2],
    ['Strategie', '(bez strategie)', 1, 1, 0],
  ]);
  const total = wb.rows[0];
  assert.equal(total['Průměrná změna %'], Math.round(((-5 - 5.27 + 4.02) / 3) * 100) / 100);
  assert.equal(total['Součet změn Kč'], -1000 - 50 + 100);
});

test('proposalsXlsx: formáty peněz a procent, prázdný vstup', () => {
  const buf = proposalsXlsx(PROPOSALS);
  const styles = readZip(buf).get('xl/styles.xml')().toString('utf8');
  // #,##0 je vestavěný formát Excelu č. 3 (bez vlastního numFmt)
  assert.ok(styles.includes('formatCode="#,##0"') || /<xf numFmtId="3"/.test(styles), 'formát peněz');
  assert.ok(styles.includes('formatCode="0.0&quot; %&quot;"'), 'formát procent');
  const empty = readXlsx(proposalsXlsx([]), { sheet: 'Návrhy' });
  assert.equal(empty.rows.length, 0);
  assert.ok(empty.headers.includes('Kód'));
  const sum = readXlsx(proposalsXlsx(null), { sheet: 'Souhrn' });
  assert.deepEqual(sum.rows.map((r) => r['Počet návrhů']), [0]);
});

test('rowsXlsx: ceník z řádků exportu', () => {
  const buf = rowsXlsx(
    [{ proposal_id: 5, product_id: 1, code: 'A', ean: '8591234567890', name: 'Kolo', manufacturer: 'Trek', price: 18990, old_price: 19990, change_pct: -5, vat_rate: 21, currency: 'CZK', changed_at: '2026-09-20T08:00:00.000Z', strategy: 'S', segment: null, lowest_30d: 17990 }],
    { sheet: 'Změny cen' }
  );
  const wb = readXlsx(buf);
  assert.deepEqual(wb.sheets, ['Změny cen']);
  const r = wb.rows[0];
  assert.equal(r['Kód'], 'A');
  assert.equal(r['EAN'], '8591234567890', 'EAN zůstává text');
  assert.equal(r['Cena s DPH'], 18990);
  assert.equal(r['Nejnižší cena za 30 dní'], 17990);
  assert.equal(r['Změněno'], '2026-09-20T10:00:00');
});
