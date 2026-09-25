'use strict';
// Testy mapování (SPEC §5 mapping.js): kanonická pole, návrh mapování (aliasy), převody hodnot, dostupnost, data.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CANONICAL,
  suggestMapping,
  compileMapping,
  applyMapping,
  normalizeAvailability,
  parseDate,
  parseBool,
  parseVat,
  normalizeCode,
  normalizeMappingArg,
  ImportError,
} = require('../src/import');

const sug = (headers, kind) => suggestMapping(headers, kind).fields;
const map = (rec, mapping, kind, ctx) => applyMapping(rec, mapping || {}, kind, ctx);

test('CANONICAL: pole produktů a nabídek s českými popisky', () => {
  const pk = CANONICAL.products.map((f) => f.key);
  for (const k of ['code', 'ean', 'mpn', 'name', 'manufacturer', 'category', 'supplier', 'owner', 'purchase_price', 'price', 'vat_rate', 'msrp', 'stock', 'sales_30', 'sales_90', 'active']) {
    assert.ok(pk.includes(k), k);
  }
  const ok = CANONICAL.offers.map((f) => f.key);
  for (const k of ['code', 'ean', 'mpn', 'ext_id', 'competitor', 'price', 'shipping', 'availability', 'in_stock', 'delivery_days', 'stock_qty', 'url', 'name', 'observed_at']) {
    assert.ok(ok.includes(k), k);
  }
  for (const f of [...CANONICAL.products, ...CANONICAL.offers]) {
    assert.equal(typeof f.label, 'string');
    assert.ok(f.label.length > 2, f.key);
  }
  assert.equal(CANONICAL.products.find((f) => f.key === 'code').required, true);
  assert.equal(CANONICAL.offers.find((f) => f.key === 'competitor').required, true);
  assert.equal(CANONICAL.offers.find((f) => f.key === 'price').required, true);
  // pole spravovaná aplikací jsou označena
  for (const k of ['locked', 'locked_until', 'min_price', 'max_price', 'note']) assert.equal(CANONICAL.products.find((f) => f.key === k).manual, true, k);
  assert.match(CANONICAL.products.find((f) => f.key === 'price').label, /Prodejní cena/);
});

test('suggestMapping: český katalog z POHODY/Excelu', () => {
  const f = sug(
    ['Kód', 'EAN', 'Název', 'Výrobce', 'Kategorie', 'Dodavatel', 'Zodpovědná osoba', 'Nákupní cena', 'Prodejní cena s DPH', 'Sazba DPH', 'MOC', 'Stav skladu', 'Prodej 30 dní', 'Prodej 90 dní', 'N', 'Sezóna'],
    'products'
  );
  assert.deepEqual(f, {
    code: 'Kód',
    name: 'Název',
    ean: 'EAN',
    manufacturer: 'Výrobce',
    category: 'Kategorie',
    supplier: 'Dodavatel',
    owner: 'Zodpovědná osoba',
    purchase_price: 'Nákupní cena',
    price: 'Prodejní cena s DPH',
    vat_rate: 'Sazba DPH',
    msrp: 'MOC',
    stock: 'Stav skladu',
    sales_30: 'Prodej 30 dní',
    sales_90: 'Prodej 90 dní',
  });
});

test('suggestMapping: aliasy ze SPEC (produkty)', () => {
  const cases = [
    ['code', ['code', 'kod', 'sku', 'katalog', 'katalogove_cislo', 'product_code', 'item_id', 'itemid', 'id_produktu', 'SKU', 'Kat. číslo']],
    ['ean', ['ean', 'gtin', 'gtin13', 'barcode', 'carovy_kod', 'Čárový kód', 'GTIN-13']],
    ['mpn', ['mpn', 'productno', 'part_number', 'kod_vyrobce', 'partnumber', 'Kód výrobce', 'PRODUCTNO']],
    ['name', ['name', 'nazev', 'productname', 'product', 'title', 'PRODUCTNAME', 'Název zboží']],
    ['price', ['price', 'price_vat', 'cena', 'cena_s_dph', 'prodejni_cena', 'sellingprice', 'current_price', 'PRICE_VAT', 'Cena s DPH', 'Cena (Kč)']],
    ['purchase_price', ['purchase_price', 'nakupni_cena', 'nakup', 'cost', 'purchasingprice', 'Nákupní cena bez DPH']],
    ['stock', ['stock', 'qty', 'quantity', 'count', 'mnozstvi', 'stav', 'stav_skladu', 'skladem_ks', 'Množství']],
    ['manufacturer', ['manufacturer', 'brand', 'vyrobce', 'znacka', 'producer', 'Značka']],
    ['category', ['category', 'kategorie', 'categorytext', 'group', 'skupina', 'CATEGORYTEXT']],
    ['msrp', ['msrp', 'rrp', 'moc', 'doporucena_cena', 'recommended_price', 'standard_price', 'Doporučená cena']],
    ['vat_rate', ['vat', 'dph', 'sazba_dph', 'vat_rate', 'ratevat', 'DPH %']],
    ['owner', ['owner', 'zodpovedna_osoba', 'responsible', 'category_manager', 'manager']],
    ['supplier', ['supplier', 'dodavatel']],
    ['sales_30', ['prodej_30', 'sales_30d', 'sales_30', 'Prodeje 30 dní']],
    ['sales_90', ['prodej_90', 'sales_90d', 'sales_90']],
    ['active', ['active', 'aktivni', 'Aktivní']],
  ];
  for (const [field, headers] of cases) {
    for (const h of headers) assert.equal(sug([h, 'nesouvisející sloupec'], 'products')[field], h, `${h} → ${field}`);
  }
});

test('suggestMapping: aliasy ze SPEC (nabídky)', () => {
  const cases = [
    ['competitor', ['competitor', 'konkurent', 'shop', 'eshop', 'seller', 'obchod', 'retailer', 'domain', 'vendor_name', '@shop', 'Konkurent']],
    ['shipping', ['shipping', 'delivery_price', 'doprava', 'postovne', 'DELIVERY_PRICE', 'Poštovné']],
    ['availability', ['availability', 'dostupnost', 'skladem', 'delivery_date', 'stock_status', 'DELIVERY_DATE', 'Dostupnost']],
    ['url', ['url', 'link', 'odkaz', 'URL']],
    ['observed_at', ['observed_at', 'date', 'datum', 'timestamp', 'scraped_at', 'updated_at', 'Datum zjištění']],
    ['ext_id', ['ext_id', 'external_id', 'offer_id']],
    ['in_stock', ['in_stock', 'instock', 'is_in_stock']],
    ['delivery_days', ['delivery_days', 'dodaci_doba', 'Dodací doba']],
    ['stock_qty', ['stock_qty', 'quantity', 'pocet_ks']],
  ];
  for (const [field, headers] of cases) {
    for (const h of headers) assert.equal(sug([h, 'cena', 'nesouvisející'], 'offers')[field], h, `${h} → ${field}`);
  }
});

test('suggestMapping: Google Merchant jako náš katalog (g:id → code jen bez lepší varianty)', () => {
  // formats odstraní prefix g:, ale i s ním (keepNs) musí návrh fungovat
  for (const p of ['', 'g:']) {
    const f = sug([`${p}id`, `${p}title`, `${p}link`, `${p}price`, `${p}sale_price`, `${p}gtin`, `${p}brand`, `${p}mpn`, `${p}product_type`, `${p}shipping.${p}price`], 'products');
    assert.equal(f.code, `${p}id`);
    assert.equal(f.price, `${p}price`);
    assert.equal(f.ean, `${p}gtin`);
    assert.equal(f.manufacturer, `${p}brand`);
    assert.equal(f.name, `${p}title`);
    assert.equal(f.category, `${p}product_type`);
  }
  // lepší kód než id vyhrává
  assert.equal(sug(['id', 'sku', 'price'], 'products').code, 'sku');
  // u nabídek je id identifikátorem poskytovatele, ne naším kódem
  const o = sug(['id', 'shop', 'price'], 'offers');
  assert.equal(o.code, undefined);
  assert.equal(o.ext_id, 'id');
});

test('suggestMapping: vnořené klíče a přednosti', () => {
  // holý klíč potomka vyhrává nad prefixovaným; cena dopravy není cena
  const f = sug(['code', 'offers.shop', 'offers.price', 'shop', 'price', 'shipping.price'], 'offers');
  assert.equal(f.price, 'price');
  assert.equal(f.competitor, 'shop');
  assert.equal(f.shipping, 'shipping.price');
  // PRICE_VAT má přednost před PRICE (bez DPH)
  assert.equal(sug(['PRICE', 'PRICE_VAT'], 'products').price, 'PRICE_VAT');
  // konkurent jako atribut rodičovského elementu
  const g = sug(['competitor.@name', 'name', 'price', 'ean'], 'offers');
  assert.equal(g.competitor, 'competitor.@name');
  assert.equal(g.name, 'name');
  // POHODA stockHeader.*
  const p = sug(['stockHeader.id', 'stockHeader.code', 'stockHeader.EAN', 'stockHeader.sellingPrice', 'stockHeader.purchasingPrice', 'stockHeader.count', 'stockHeader.sellingRateVAT'], 'products');
  assert.deepEqual(
    [p.code, p.ean, p.price, p.purchase_price, p.stock, p.vat_rate],
    ['stockHeader.code', 'stockHeader.EAN', 'stockHeader.sellingPrice', 'stockHeader.purchasingPrice', 'stockHeader.count', 'stockHeader.sellingRateVAT']
  );
});

test('suggestMapping: jeden sloupec = jedno pole, přesný kanonický název vyhrává, pole aplikace se nenavrhují', () => {
  const f = sug(['in_stock', 'availability', 'delivery_days'], 'offers');
  assert.equal(f.in_stock, 'in_stock');
  assert.equal(f.availability, 'availability');
  assert.equal(f.delivery_days, 'delivery_days');
  const values = Object.values(sug(['skladem', 'stock', 'qty'], 'products'));
  assert.equal(new Set(values).size, values.length);
  const p = sug(['code', 'note', 'locked', 'min_price', 'max_price', 'locked_until', 'Poznámka'], 'products');
  assert.deepEqual(p, { code: 'code' });
  assert.deepEqual(sug([], 'offers'), {});
  assert.throws(() => sug(['x'], 'foo'), ImportError);
});

test('compileMapping: výslovné mapování vyhrává, null vypne návrh, hledání bez ohledu na velikost písmen', () => {
  const cm = compileMapping({ fields: { price: 'cena_akce', ean: 'EAN', competitor: null } }, ['ean', 'cena', 'cena_akce', 'shop'], 'offers');
  assert.equal(cm.fields.price, 'cena_akce');
  assert.equal(cm.fields.ean, 'ean'); // „EAN“ dohledáno jako „ean“
  assert.equal(cm.fields.competitor, undefined); // vypnuto i přesto, že „shop“ existuje
  assert.ok(!Object.values(cm.fields).includes('cena')); // „cena“ se nenavrhne jinam
  const cm2 = compileMapping({ fields: { price: 'neexistuje' }, suggest: false }, ['cena'], 'offers');
  assert.deepEqual(cm2.missing, ['neexistuje']);
  assert.deepEqual(Object.keys(cm2.fields), ['price']);
  const cm3 = compileMapping({ fields: { bogus: 'x' }, defaults: { nope: 1 } }, [], 'offers');
  assert.deepEqual(cm3.unknownFields.sort(), ['bogus', 'nope']);
  assert.throws(() => normalizeMappingArg('{nevalidní'), ImportError);
  assert.deepEqual(normalizeMappingArg('{"fields":{"price":"c"}}'), { fields: { price: 'c' } });
  assert.deepEqual(normalizeMappingArg(null), {});
});

test('applyMapping: čísla v českých a anglických formátech', () => {
  const cases = [
    ['12 990 Kč', 12990],
    ['12.990,-', 12990],
    ['12 990,50', 12990.5],
    ['1,299.90', 1299.9],
    ['12990.00 CZK', 12990],
    ['1 299,- Kč', 1299],
    [12990, 12990],
    [' 12 990 Kč', 12990],
    ['8.59E+3', 8590],
  ];
  for (const [input, expected] of cases) {
    const { value } = map({ code: 'A', price: input }, {}, 'products');
    assert.equal(value.price, expected, String(input));
  }
  // vynucená desetinná čárka (mapping.csv.decimal)
  assert.equal(map({ code: 'A', price: '1.234' }, { csv: { decimal: '.' } }, 'products').value.price, 1.234);
  assert.equal(map({ code: 'A', price: '1.234' }, {}, 'products').value.price, 1234);
});

test('applyMapping: kódy – EAN z Excelu, čísla, mezery', () => {
  const { value } = map({ code: 12345, ean: '8.59E+12', mpn: ' XTR M9100 ' }, {}, 'products');
  assert.equal(value.code, '12345');
  assert.equal(value.ean, '8590000000000');
  assert.equal(value.mpn, 'XTR M9100');
  assert.equal(map({ code: 'A', ean: 8591234567890 }, {}, 'products').value.ean, '8591234567890');
  assert.equal(map({ code: '123.0' }, {}, 'products').value.code, '123');
  assert.equal(map({ code: '  SAN 014 XS  ' }, {}, 'products').value.code, 'SAN 014 XS');
  assert.equal(normalizeCode('​ABC​'), 'ABC');
  assert.equal(normalizeCode(''), null);
  assert.equal(normalizeCode(true), null);
});

test('applyMapping: DPH, texty, prázdné hodnoty, chybějící klíče', () => {
  const { value } = map({ code: 'A', dph: '21 %', name: '  Kolo \n  Trail ', manufacturer: '', category: null }, {}, 'products');
  assert.equal(value.vat_rate, 21);
  assert.equal(value.name, 'Kolo Trail');
  assert.equal(value.manufacturer, null); // prázdná buňka = smazat
  assert.equal(value.category, null);
  assert.ok(!('supplier' in value)); // sloupec vůbec není → pole se nemění
  for (const [v, exp] of [['high', 21], ['low', 12], ['none', 0], [0.21, 21], ['15', 15], ['12 %', 12], ['Základní', 21]]) assert.equal(parseVat(v), exp, String(v));
  assert.equal(parseVat('abc'), null);
  assert.equal(parseVat(150), null);
  const bad = map({ code: 'A', dph: 'abc', stock: 'hodně' }, {}, 'products');
  assert.ok(bad.value, 'neplatná nepovinná pole nezahodí celý řádek');
  assert.ok(!('vat_rate' in bad.value) && !('stock' in bad.value));
  assert.equal(bad.errors.length, 2);
});

test('applyMapping: výchozí hodnoty (defaults) – chybějící sloupec konkurenta', () => {
  const { value, errors } = map({ ean: '8591234567890', cena: '1 490 Kč' }, { defaults: { competitor: 'VeloMarket.cz' } }, 'offers');
  assert.deepEqual(errors, []);
  assert.equal(value.competitor, 'VeloMarket.cz');
  assert.equal(value.price, 1490);
  // prázdná buňka → výchozí hodnota
  assert.equal(map({ shop: '', ean: '8591234567890', price: 10 }, { defaults: { competitor: 'X' } }, 'offers').value.competitor, 'X');
  // hodnota ve sloupci má přednost před výchozí
  assert.equal(map({ shop: 'Y', ean: '8591234567890', price: 10 }, { defaults: { competitor: 'X' } }, 'offers').value.competitor, 'Y');
});

test('applyMapping: povinná pole nabídek → value null s českou chybou', () => {
  let r = map({ ean: '8591234567890', price: 100 }, {}, 'offers');
  assert.equal(r.value, null);
  assert.match(r.errors[0], /konkurent/i);
  r = map({ ean: '8591234567890', shop: 'X' }, {}, 'offers');
  assert.equal(r.value, null);
  assert.ok(r.errors.includes('Chybí cena'));
  r = map({ ean: '8591234567890', shop: 'X', price: 'na dotaz' }, {}, 'offers');
  assert.equal(r.value, null);
  assert.match(r.errors[0], /Neplatná cena/);
  r = map({ ean: '8591234567890', shop: 'X', price: 0 }, {}, 'offers');
  assert.equal(r.value, null);
  r = map({ ean: '8591234567890', shop: 'X', price: '-10' }, {}, 'offers');
  assert.equal(r.value, null);
  r = map({ shop: 'X', price: 10 }, {}, 'offers');
  assert.equal(r.value, null);
  assert.match(r.errors[0], /párovací klíč/);
  r = map({ name: 'Jen název', shop: 'X', price: 10 }, {}, 'offers');
  assert.ok(r.value, 'název stačí jako párovací klíč (přes alias)');
  r = map({ Kod: '', ean: '1' }, {}, 'products');
  assert.equal(r.value, null);
  assert.deepEqual(r.errors, ['Chybí kód produktu']);
});

test('applyMapping: dostupnost nabídek – availability, in_stock, delivery_days, stock_qty', () => {
  const base = { ean: '8591234567890', shop: 'X', price: 100 };
  const cases = [
    [{ availability: 'skladem' }, 1, 0],
    [{ availability: 'není skladem' }, 0, null],
    [{ dostupnost: 'do 3 dnů' }, 0, 3],
    [{ DELIVERY_DATE: '0' }, 1, 0],
    [{ DELIVERY_DATE: '1' }, 0, 1], // Heureka: číslo = dny, i „1“
    [{ DELIVERY_DATE: 5 }, 0, 5],
    [{ skladem: 'ano' }, 1, 0],
    [{ skladem: '0' }, 0, null], // „0“ jako ne jen u sloupce typu ano/ne
    [{ skladem: '1' }, 1, 0],
    [{ in_stock: true }, 1, 0],
    [{ in_stock: 'false' }, 0, null],
    [{ in_stock: 0 }, 0, null],
    [{ delivery_days: '2' }, 0, 2],
    [{ delivery_days: 0 }, 1, 0],
    [{ stock_qty: '5' }, 1, 0],
    [{ stock_qty: 0 }, 0, null],
    [{ availability: 'na dotaz', stock_qty: 3 }, 1, 0], // kusy skladem přebijí text
    [{ availability: 'skladem', in_stock: 'ne' }, 0, 0], // výslovné skladem ano/ne má přednost
    [{ stock: 'skladem' }, 1, 0], // vnořené nabídky: „stock“ jako text
    [{ stock: 7 }, 1, 0], // … nebo jako kusy
    [{ stock: '0' }, 0, null],
  ];
  for (const [extra, inStock, days] of cases) {
    const { value, errors } = map({ ...base, ...extra }, {}, 'offers');
    assert.ok(value, JSON.stringify(extra) + ' ' + errors);
    assert.equal(value.in_stock, inStock, JSON.stringify(extra));
    assert.equal(value.delivery_days, days, JSON.stringify(extra));
  }
  // bez sloupců dostupnosti se in_stock nenastavuje (nepřepíše uloženou hodnotu)
  const { value } = map(base, {}, 'offers');
  assert.ok(!('in_stock' in value) && !('delivery_days' in value));
  // nerozpoznaný text → null + varování, řádek se přesto naimportuje
  const r = map({ ...base, availability: 'viz web' }, {}, 'offers');
  assert.ok(r.value);
  assert.equal(r.value.in_stock, null);
  assert.match(r.errors[0], /nerozpoznaná hodnota/);
});

test('applyMapping: observed_at a výchozí hodnota dostupnosti', () => {
  const { value } = map({ ean: '8591234567890', shop: 'X', price: 100, datum: '25.9.2026 14:30' }, {}, 'offers');
  assert.equal(value.observed_at, '2026-09-25T12:30:00.000Z');
  const d = map({ ean: '8591234567890', shop: 'X', price: 100 }, { defaults: { in_stock: 1 } }, 'offers').value;
  assert.equal(d.in_stock, 1);
  const bad = map({ ean: '8591234567890', shop: 'X', price: 100, datum: 'včera' }, {}, 'offers');
  assert.ok(bad.value);
  assert.ok(!('observed_at' in bad.value));
  assert.match(bad.errors[0], /neplatné datum/);
});

test('applyMapping: attrs u produktů – nenamapované sloupce, čísla, úvodní nuly, none, výběr', () => {
  const rec = { Kód: 'A', N: 'N7', Sezóna: '2026', 'Imprese 30': '1 194', Podíl: '12,5', Kód2: '0123', Prázdný: '', 'PARAM.Barva': 'černá', Popis: 'x'.repeat(5000), Bool: true };
  const { value } = map(rec, {}, 'products');
  assert.equal(value.code, 'A');
  assert.deepEqual(value.attrs, { N: 'N7', Sezóna: 2026, 'Imprese 30': '1 194', Podíl: 12.5, Kód2: '0123', Prázdný: null, 'PARAM.Barva': 'černá', Bool: true });
  assert.ok(!('attrs' in map(rec, { attrs: 'none' }, 'products').value));
  assert.deepEqual(map(rec, { attrs: ['N', 'Sezóna'] }, 'products').value.attrs, { N: 'N7', Sezóna: 2026 });
  // namapované sloupce do attrs nepatří
  assert.ok(!('Kód' in value.attrs));
  // nabídky attrs nemají
  assert.ok(!('attrs' in map({ ean: '8591234567890', shop: 'X', price: 1, foo: 'bar' }, {}, 'offers').value));
});

test('applyMapping: pole spravovaná aplikací jen při výslovném mapování; price_net', () => {
  const rec = { code: 'A', note: 'z importu', min_price: '100', locked: 'ano' };
  const plain = map(rec, {}, 'products').value;
  assert.ok(!('note' in plain) && !('min_price' in plain) && !('locked' in plain));
  assert.equal(plain.attrs.note, 'z importu'); // skončí v atributech, nepřepíše poznámku
  const explicit = map(rec, { fields: { note: 'note', min_price: 'min_price', locked: 'locked' } }, 'products').value;
  assert.equal(explicit.note, 'z importu');
  assert.equal(explicit.min_price, 100);
  assert.equal(explicit.locked, 1);
  assert.equal(map({ code: 'A', price: 100 }, { price_net: true }, 'products').value.price_is_net, true);
  assert.equal(map({ ean: '8591234567890', shop: 'X', price: 100 }, { price_net: true }, 'offers').value.price_is_net, true);
});

test('applyMapping: výčet zdrojových klíčů (první neprázdný) a předkompilované mapování', () => {
  const mapping = { fields: { price: ['PRICE_ACTION', 'PRICE_VAT'] } };
  const cm = compileMapping(mapping, ['ITEM_ID', 'PRICE_ACTION', 'PRICE_VAT', '@shop'], 'offers');
  assert.equal(applyMapping({ ITEM_ID: 'A', PRICE_ACTION: '', PRICE_VAT: '100', '@shop': 'X' }, mapping, 'offers', { compiled: cm }).value.price, 100);
  assert.equal(applyMapping({ ITEM_ID: 'A', PRICE_ACTION: '90', PRICE_VAT: '100', '@shop': 'X' }, mapping, 'offers', { compiled: cm }).value.price, 90);
});

test('normalizeAvailability: slovník a tvary ze SPEC', () => {
  const inStock = [true, '1', 'ano', 'Ano', 'yes', 'skladem', 'Skladem', 'SKLADEM', 'in stock', 'instock', 'in_stock', 'InStock', 'available', 'na skladě', 'Na skladě',
    'http://schema.org/InStock', 'https://schema.org/InStock', 'Skladem > 5 ks', 'skladem (3 ks)', 'ihned', 'k dispozici', 'In Stock!'];
  for (const v of inStock) assert.deepEqual(normalizeAvailability(v), { in_stock: 1, delivery_days: 0 }, String(v));
  const out = [false, 'ne', 'no', 'není skladem', 'Není skladem', 'vyprodáno', 'Vyprodáno', 'out of stock', 'outofstock', 'out_of_stock', 'OutOfStock', 'na dotaz',
    'nedostupné', 'preorder', 'pre-order', 'předobjednávka', 'Předobjednávka', 'na objednávku', 'sold out', 'discontinued', 'backorder'];
  for (const v of out) assert.deepEqual(normalizeAvailability(v), { in_stock: 0, delivery_days: null }, String(v));
  const days = [['do 3 dnů', 3], ['3 dny', 3], ['3 dní', 3], ['Do 5 pracovních dnů', 5], ['2-5 dní', 5], ['2 – 3 dny', 3], ['1 týden', 7], ['2 týdny', 14], ['48 hodin', 2],
    ['do 24 hod', 1], ['zítra', 1], [3, 3], ['7', 7], ['14 days', 14]];
  for (const [v, d] of days) assert.deepEqual(normalizeAvailability(v), { in_stock: 0, delivery_days: d }, String(v));
  // 0 dní = skladem (Heureka DELIVERY_DATE 0)
  assert.deepEqual(normalizeAvailability('0'), { in_stock: 1, delivery_days: 0 });
  assert.deepEqual(normalizeAvailability(0), { in_stock: 1, delivery_days: 0 });
  assert.deepEqual(normalizeAvailability('dnes'), { in_stock: 1, delivery_days: 0 });
  // „0“ jako NE jen u sloupce typu ano/ne
  assert.deepEqual(normalizeAvailability('0', { hint: 'bool' }), { in_stock: 0, delivery_days: null });
  assert.deepEqual(normalizeAvailability('0', { field: 'skladem' }), { in_stock: 0, delivery_days: null });
  assert.deepEqual(normalizeAvailability('0', { field: 'is_available' }), { in_stock: 0, delivery_days: null });
  assert.deepEqual(normalizeAvailability('1', { field: 'DELIVERY_DATE' }), { in_stock: 0, delivery_days: 1 });
  // počet kusů
  assert.deepEqual(normalizeAvailability(12, { field: 'stock_qty' }), { in_stock: 1, delivery_days: 0 });
  assert.deepEqual(normalizeAvailability('0', { field: 'quantity' }), { in_stock: 0, delivery_days: null });
  // dodavatel ≠ skladem
  assert.deepEqual(normalizeAvailability('Skladem u dodavatele'), { in_stock: 0, delivery_days: null });
  assert.deepEqual(normalizeAvailability('skladem u dodavatele (do 4 dnů)'), { in_stock: 0, delivery_days: 4 });
  // datum dodání
  assert.deepEqual(normalizeAvailability('2026-10-05', { now: '2026-09-25T12:00:00Z' }), { in_stock: 0, delivery_days: 10 });
  assert.deepEqual(normalizeAvailability('2026-09-20', { now: '2026-09-25T12:00:00Z' }), { in_stock: 1, delivery_days: 0 });
  // neznámé
  for (const v of [null, undefined, '', '   ', 'blabla', {}]) assert.deepEqual(normalizeAvailability(v), { in_stock: null, delivery_days: null }, String(v));
});

test('parseDate: ISO, české formáty, unix, Excel, RFC 2822, letní/zimní čas', () => {
  assert.equal(parseDate('2026-09-25T10:00:00Z'), '2026-09-25T10:00:00.000Z');
  assert.equal(parseDate('2026-09-25T10:00:00+02:00'), '2026-09-25T08:00:00.000Z');
  assert.equal(parseDate('2026-09-25T10:00:00.123-0100'), '2026-09-25T11:00:00.123Z');
  // bez zóny = čas v Praze (léto UTC+2, zima UTC+1)
  assert.equal(parseDate('2026-07-01 12:00'), '2026-07-01T10:00:00.000Z');
  assert.equal(parseDate('2026-01-15T12:00:00'), '2026-01-15T11:00:00.000Z');
  assert.equal(parseDate('2026-09-25'), '2026-09-24T22:00:00.000Z');
  assert.equal(parseDate('25.9.2026'), '2026-09-24T22:00:00.000Z');
  assert.equal(parseDate('25. 9. 2026 14:30'), '2026-09-25T12:30:00.000Z');
  assert.equal(parseDate('01.12.2026 08:05:09'), '2026-12-01T07:05:09.000Z');
  assert.equal(parseDate('25/09/2026'), '2026-09-24T22:00:00.000Z');
  // přechod na letní čas 29. 3. 2026 v 2:00 → 3:00
  assert.equal(parseDate('2026-03-29 01:30'), '2026-03-29T00:30:00.000Z');
  assert.equal(parseDate('2026-03-29 03:30'), '2026-03-29T01:30:00.000Z');
  // unix sekundy / ms, číslo i text
  assert.equal(parseDate(1790000000), '2026-09-21T14:13:20.000Z');
  assert.equal(parseDate('1790000000'), '2026-09-21T14:13:20.000Z');
  assert.equal(parseDate(1790000000123), '2026-09-21T14:13:20.123Z');
  assert.equal(parseDate('1790000000123'), '2026-09-21T14:13:20.123Z');
  // Excel sériové číslo (46290 = 25. 9. 2026), s časem
  assert.equal(parseDate(46290), '2026-09-24T22:00:00.000Z');
  assert.equal(parseDate(46290.5), '2026-09-25T10:00:00.000Z');
  assert.equal(parseDate('Fri, 25 Sep 2026 10:00:00 GMT'), '2026-09-25T10:00:00.000Z');
  assert.equal(parseDate(new Date('2026-09-25T10:00:00Z')), '2026-09-25T10:00:00.000Z');
  for (const bad of ['', null, undefined, 'včera', '31.2.2026', '2026-13-01', '99', 12, 'abc def', '1.1.1900', {}]) assert.equal(parseDate(bad), null, String(bad));
});

test('parseBool', () => {
  for (const v of [true, 1, '1', 'ano', 'Ano', 'yes', 'true', 'A', 'aktivní', 'active', 'x']) assert.equal(parseBool(v), 1, String(v));
  for (const v of [false, 0, '0', 'ne', 'NE', 'no', 'false', 'neaktivní', 'inactive']) assert.equal(parseBool(v), 0, String(v));
  for (const v of [null, undefined, '', 'možná', NaN]) assert.equal(parseBool(v), null, String(v));
});
