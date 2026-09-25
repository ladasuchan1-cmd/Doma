'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { productView, FIELDS, FIELD_GROUPS, discoverAttrFields, scheduleActive, parseDateTime, pragueParts, isLockActive } = require('../src/engine/metrics.js');
const { compileFilter } = require('../src/engine/filter.js');
const { NOW, offer, product } = require('./engine-helpers.js');

const daysAgo = (d) => new Date(Date.parse(NOW) - d * 86400000).toISOString();

test('metrics: marže, zisk, hodnota skladu, zásoba', () => {
  const v = productView(product({ price: 12100, purchase_price: 7000, vat_rate: 21, stock: 6, sales_30: 3 }), [], { now: NOW });
  assert.equal(v.vat, 21);
  assert.equal(v.margin_pct, 30); // net 10000
  assert.equal(v.markup_pct, 42.86);
  assert.equal(v.profit_abs, 3000);
  assert.equal(v.stock_value, 42000);
  assert.equal(v.days_of_cover, 60);
  assert.equal(v.has_stock, true);
  assert.equal(v.below_cost, false);
  const z = productView(product({ sales_30: 0, purchase_price: null, vat_rate: null }), [], { now: NOW, settings: { vat_rate_default: 12 } });
  assert.equal(z.days_of_cover, null, 'bez prodejů není zásoba na dny');
  assert.equal(z.margin_pct, null);
  assert.equal(z.profit_abs, null);
  assert.equal(z.vat, 12, 'výchozí sazba z nastavení');
  const zero = productView(product({ purchase_price: 0 }), [], { now: NOW });
  assert.equal(zero.margin_pct, null, 'nákup 0 = chybějící údaj');
  assert.equal(productView(product({ price: 5000, purchase_price: 6000 }), [], { now: NOW }).below_cost, true);
});

test('metrics: trh, pořadí, pozice, indexy', () => {
  const offers = [offer('A', 9000), offer('B', 10000), offer('C', 11000), offer('D', 8000, { in_stock: 0 }), offer('E', 7000, { enabled: false }), offer('F', 6000, { observed_at: daysAgo(10) })];
  const v = productView(product({ price: 10000, msrp: 12500 }), offers, { now: NOW });
  // výchozí metriky: vč. neskladem (metrics_in_stock_only = false), bez vypnutých a zastaralých
  assert.equal(v.market_count, 4);
  assert.equal(v.offers_count, 4);
  assert.equal(v.offers_instock, 3);
  assert.equal(v.market_min, 8000);
  assert.equal(v.market_max, 11000);
  assert.equal(v.market_avg, 9500);
  assert.equal(v.market_median, 9500);
  assert.equal(v.cheapest_competitor, 'D');
  assert.equal(v.rank, 3);
  assert.equal(v.position, 'middle');
  assert.equal(v.price_index, 125);
  assert.equal(v.price_index_median, 105.3);
  assert.equal(v.price_index_avg, 105.3);
  assert.equal(v.gap_min_abs, 2000);
  assert.equal(v.gap_min_pct, 25);
  assert.equal(v.msrp_diff_pct, -20);
  const s = productView(product({ price: 10000 }), offers, { now: NOW, settings: { metrics_in_stock_only: true } });
  assert.equal(s.market_count, 3);
  assert.equal(s.offers_count, 4);
  assert.equal(s.market_min, 9000);
  const none = productView(product(), [], { now: NOW });
  assert.equal(none.position, 'no_data');
  assert.equal(none.rank, null);
  assert.equal(none.price_index, null);
  assert.equal(none.cheapest_competitor, null);
});

test('metrics: min_below_cost (konkurence pod naším nákupem)', () => {
  const v = productView(product({ purchase_price: 8000, vat_rate: 21 }), [offer('A', 9600)], { now: NOW });
  assert.equal(v.min_below_cost, true); // 9600 / 1.21 = 7933,88 < 8000
  const w = productView(product({ purchase_price: 7900, vat_rate: 21 }), [offer('A', 9600)], { now: NOW });
  assert.equal(w.min_below_cost, false);
});

test('metrics: zámek s expirací a dny od změny ceny', () => {
  assert.equal(productView(product({ locked: 1 }), [], { now: NOW }).lock_active, true);
  assert.equal(productView(product({ locked: 1, locked_until: '2026-09-26T00:00:00Z' }), [], { now: NOW }).lock_active, true);
  assert.equal(productView(product({ locked: 1, locked_until: '2026-09-25T09:59:59Z' }), [], { now: NOW }).lock_active, false);
  assert.equal(productView(product({ locked: 0, locked_until: '2027-01-01T00:00:00Z' }), [], { now: NOW }).lock_active, false);
  assert.equal(isLockActive({ locked: 1, locked_until: 'nesmysl' }, NOW), true, 'nečitelné datum = zamčeno');
  assert.equal(productView(product({ price_changed_at: daysAgo(13.9) }), [], { now: NOW }).days_since_change, 13);
  assert.equal(productView(product({ price_changed_at: daysAgo(14) }), [], { now: NOW }).days_since_change, 14);
  assert.equal(productView(product({ price_changed_at: null }), [], { now: NOW }).days_since_change, null);
});

test('metrics: attrs z JSON textu a filtr nad pohledem', () => {
  const v = productView(product({ attrs: '{"N":"N8","sezona":2023}' }), [offer('A', 12000)], { now: NOW });
  assert.deepEqual(v.attrs, { N: 'N8', sezona: 2023 });
  assert.equal(compileFilter({ all: [{ field: 'attrs.N', op: 'in', value: ['N7', 'N8'] }, { field: 'position', op: '=', value: 'cheapest' }] })(v), true);
  assert.deepEqual(productView(product({ attrs: 'rozbité' }), [], { now: NOW }).attrs, {});
});

test('metrics: FIELDS pokrývá sloupce produktu i všechny metriky', () => {
  const keys = new Set(FIELDS.map((f) => f.key));
  const required = [
    'code', 'ean', 'mpn', 'name', 'manufacturer', 'category', 'supplier', 'owner', 'purchase_price', 'price', 'vat_rate', 'msrp',
    'stock', 'sales_30', 'sales_90', 'active', 'locked', 'locked_until', 'min_price', 'max_price', 'note', 'price_changed_at',
    'vat', 'margin_pct', 'markup_pct', 'profit_abs', 'stock_value', 'days_of_cover', 'market_count', 'market_min', 'market_max',
    'market_avg', 'market_median', 'cheapest_competitor', 'rank', 'position', 'price_index', 'price_index_median', 'gap_min_abs',
    'gap_min_pct', 'msrp_diff_pct', 'offers_instock', 'price_index_avg', 'min_below_cost', 'lock_active', 'days_since_change',
  ];
  for (const k of required) assert.ok(keys.has(k), `FIELDS chybí ${k}`);
  // každá hodnota pohledu (kromě attrs a interních sloupců) je popsána
  const v = productView(product(), [offer('A', 9000)], { now: NOW });
  for (const k of Object.keys(v)) {
    if (['attrs', 'code_key', 'ean_key', 'mpn_key'].includes(k)) continue;
    assert.ok(keys.has(k), `pole pohledu ${k} není ve FIELDS`);
  }
  for (const f of FIELDS) {
    assert.ok(f.label && /[a-zá-ž]/i.test(f.label), f.key);
    assert.ok(['string', 'number', 'boolean', 'enum'].includes(f.type), f.key);
    assert.ok(FIELD_GROUPS.includes(f.group), f.key);
  }
  assert.equal(keys.size, FIELDS.length, 'duplicitní klíče');
  const posField = FIELDS.find((f) => f.key === 'position');
  assert.equal(posField.type, 'enum');
  assert.deepEqual([...posField.values], ['cheapest', 'middle', 'most_expensive', 'no_data']);
  assert.equal(FIELDS.find((f) => f.key === 'min_below_cost').type, 'boolean');
  assert.equal(FIELDS.find((f) => f.key === 'margin_pct').group, 'Ceny a marže');
  assert.equal(FIELDS.find((f) => f.key === 'market_min').group, 'Trh');
  assert.equal(FIELDS.find((f) => f.key === 'stock').group, 'Sklad a prodeje');
});

test('metrics: discoverAttrFields odhadne typ', () => {
  const f = discoverAttrFields([{ N: 'N7', imprese_30: 150, akce: true }, '{"N":"N1","imprese_30":20,"mix":1}', { mix: 'a' }]);
  assert.deepEqual(
    f.map((x) => [x.key, x.type, x.group]),
    [
      ['attrs.akce', 'boolean', 'Vlastní atributy'],
      ['attrs.imprese_30', 'number', 'Vlastní atributy'],
      ['attrs.mix', 'string', 'Vlastní atributy'],
      ['attrs.N', 'string', 'Vlastní atributy'],
    ]
  );
});

test('schedule: dny v týdnu a hodiny v čase Europe/Prague (letní i zimní čas)', () => {
  // 2026-09-25 je pátek; 22:30 UTC = sobota 00:30 v Praze (UTC+2)
  assert.equal(pragueParts('2026-09-25T22:30:00Z').weekday, 6);
  assert.equal(pragueParts('2026-09-25T22:30:00Z').hour, 0);
  assert.equal(scheduleActive({ weekdays: [6, 7] }, '2026-09-25T21:59:00Z'), false, 'pátek 23:59 Praha');
  assert.equal(scheduleActive({ weekdays: [6, 7] }, '2026-09-25T22:00:00Z'), true, 'sobota 00:00 Praha');
  assert.equal(scheduleActive({ hours: [18, 24] }, '2026-09-25T15:59:00Z'), false, '17:59 Praha');
  assert.equal(scheduleActive({ hours: [18, 24] }, '2026-09-25T16:00:00Z'), true, '18:00 Praha');
  assert.equal(scheduleActive({ hours: [18, 24] }, '2026-09-25T21:59:59Z'), true, '23:59:59 Praha');
  // zimní čas: 17:00 UTC v prosinci = 18:00 Praha (UTC+1)
  assert.equal(scheduleActive({ hours: [18, 24] }, '2026-12-01T17:00:00Z'), true);
  assert.equal(scheduleActive({ hours: [18, 24] }, '2026-12-01T16:59:00Z'), false);
  // přes půlnoc
  assert.equal(scheduleActive({ hours: [22, 6] }, '2026-12-01T03:00:00Z'), true, '04:00 Praha');
  assert.equal(scheduleActive({ hours: [22, 6] }, '2026-12-01T11:00:00Z'), false);
  assert.equal(scheduleActive(null, NOW), true);
  assert.equal(scheduleActive({ valid_from: null, valid_to: null, weekdays: [], hours: null }, NOW), true);
});

test('schedule: platnost od (včetně) / do (bez), čas bez zóny = Praha', () => {
  const s = { valid_from: '2026-09-25T10:00:00Z', valid_to: '2026-09-26T10:00:00Z' };
  assert.equal(scheduleActive(s, '2026-09-25T09:59:59Z'), false);
  assert.equal(scheduleActive(s, '2026-09-25T10:00:00Z'), true);
  assert.equal(scheduleActive(s, '2026-09-26T09:59:59Z'), true);
  assert.equal(scheduleActive(s, '2026-09-26T10:00:00Z'), false);
  assert.equal(parseDateTime('2026-09-25T12:00'), Date.parse('2026-09-25T10:00:00Z'), 'letní čas UTC+2');
  assert.equal(parseDateTime('2026-12-24'), Date.parse('2026-12-23T23:00:00Z'), 'zimní čas UTC+1');
  assert.equal(scheduleActive({ valid_from: '2026-09-25T12:00' }, '2026-09-25T09:59:00Z'), false);
  assert.equal(scheduleActive({ valid_from: '2026-09-25T12:00' }, '2026-09-25T10:00:00Z'), true);
  assert.equal(parseDateTime('nesmysl'), null);
});
