#!/usr/bin/env node
'use strict';
// Vývojový mock server pro UI Cenotvorby.
// Servíruje public/ se stejnými bezpečnostními hlavičkami jako skutečný server (SPEC §8) a odpovídá na všechny
// endpointy /api/v1 z SPEC §8 realistickými daty cykloobchodu (deterministicky generovanými). Stav je v paměti
// a mění se (schvalování, strategie, segmenty, import…), takže lze proklikat celé UI bez backendu.
//
// Použití:  node tools/ui-mock-server.js [--port=8090] [--host=127.0.0.1] [--latency=120] [--password=demo] [--autologin] [--extensions] [--verbose]
// Heslo pro přihlášení: demo (nebo --password). Nulové závislosti, jen node:*.
// Programově: const { createMockServer } = require('./tools/ui-mock-server.js');
//             const m = await createMockServer({ port: 0 }); … await m.close();

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseNumber, round, net, gross, marginPct, markupPct, median, mean } = require('../src/util/num.js');
const { fold, codeKey, eanKey, mpnKey, nameKey } = require('../src/util/keys.js');

const VERSION = '0.1.0-mock';
const DAY = 86400000;
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'";

// Kopie DEFAULT_SETTINGS ze src/db.js (mock záměrně nenačítá node:sqlite).
const DEFAULT_SETTINGS = {
  currency: 'CZK',
  vat_rate_default: 21,
  purchase_includes_vat: false,
  offer_max_age_days: 7,
  metrics_in_stock_only: false,
  export: {
    update_current_price: true,
    xml: { root: 'prices', item: 'item', fields: ['code', 'ean', 'name', 'price', 'old_price', 'vat_rate', 'currency', 'changed_at'] },
    pohoda: { ico: '', application: 'Cenotvorba', filter_by: 'code', price_level: '' },
    webhook: { url: '', format: 'json', headers: {}, auto_push: false, timeout_ms: 20000 },
    feed_scope: 'all',
  },
  schedule: { run_interval_minutes: 0, run_after_import: false, auto_push_after_run: false },
  retention_days: 180,
};

// Kopie výchozí konfigurace strategie (SPEC §6.5).
const DEFAULT_CONFIG = {
  target: { mode: 'undercut_min', offset_abs: 0, offset_pct: 0, rank: 1, competitor: null, markup_pct: null, fixed_price: null },
  competitors: { include: [], exclude: [], include_tags: [], exclude_tags: [], in_stock_only: true, include_shipping: false, max_age_days: null, outlier_pct: null, min_competitors: 1 },
  fallback: { mode: 'keep', markup_pct: null, offset_pct: 0 },
  limits: {
    min_margin_pct: 10, min_profit_abs: null, max_margin_pct: null, max_above_msrp_pct: 0, max_below_msrp_pct: null,
    max_decrease_pct: 10, max_increase_pct: 15, allow_increase: true, allow_decrease: true, min_change_pct: 0.5, min_change_abs: 5,
    respect_product_limits: true,
  },
  rounding: { mode: 'ending', direction: 'down', bands: [{ up_to: 1000, ending: 9 }, { up_to: 10000, ending: 90 }, { up_to: null, ending: 990 }] },
  stock: { zero_stock: 'reprice' },
  approval: { auto: false, auto_max_change_pct: 5 },
};

// Volitelná rozšíření konfigurace, která implementuje engine nad rámec SPEC §6.5 (src/engine/presets.js).
// Mock je vrací jen s volbou --extensions / { extensions: true } – výchozí chování odpovídá SPEC.
const EXTENSION_DEFAULTS = {
  conditions: {},
  schedule: { valid_from: null, valid_to: null, weekdays: [], hours: null },
  target: { step_pct: 5, every_days: 14, max_sales_30: 0 },
  competitors: { exclude_keywords: [] },
};

// ------------------------------------------------------------------ pomocníci

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
function deepMerge(base, over) {
  if (!isPlain(base) || !isPlain(over)) return over === undefined ? clone(base) : clone(over);
  const out = clone(base);
  for (const [k, v] of Object.entries(over)) out[k] = isPlain(v) && isPlain(base[k]) ? deepMerge(base[k], v) : clone(v);
  return out;
}
const iso = (ms) => new Date(ms).toISOString();

function slug(s) {
  return fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function eanWithCheck(digits12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits12[i]) * (i % 2 ? 3 : 1);
  return digits12 + ((10 - (sum % 10)) % 10);
}

function roundEnding(v) {
  // cenové konce …9 / …90 / …990 dolů (jako výchozí strategie)
  const bands = DEFAULT_CONFIG.rounding.bands;
  const b = bands.find((x) => x.up_to == null || v <= x.up_to);
  const step = 10 ** String(b.ending).length;
  let down = Math.floor((v - b.ending) / step) * step + b.ending;
  if (down <= 0) down += step;
  return down;
}

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// ------------------------------------------------------------------ katalog

const BIKES = [
  ['Trek', 'Marlin 5 Gen 3', 'Horská kola', 14990, ['S', 'M', 'L', 'XL']],
  ['Trek', 'Marlin 7 Gen 3', 'Horská kola', 21990, ['S', 'M', 'L']],
  ['Trek', 'Roscoe 7', 'Horská kola', 29990, ['M', 'L']],
  ['Trek', 'Fuel EX 8 Gen 6', 'Celoodpružená kola', 99990, ['M', 'L']],
  ['Trek', 'Domane AL 2 Gen 4', 'Silniční kola', 24990, ['54', '56']],
  ['Trek', 'Checkpoint ALR 5', 'Gravel kola', 54990, ['54', '56']],
  ['Trek', 'Rail 9.7 Gen 4', 'Elektrokola', 149990, ['M', 'L']],
  ['Specialized', 'Rockhopper Comp 29', 'Horská kola', 21490, ['M', 'L']],
  ['Specialized', 'Stumpjumper 15 Comp', 'Celoodpružená kola', 119990, ['S3', 'S4']],
  ['Specialized', 'Allez Sport', 'Silniční kola', 33990, ['54', '56']],
  ['Specialized', 'Diverge Sport Carbon', 'Gravel kola', 74990, ['54', '56']],
  ['Specialized', 'Turbo Vado 4.0', 'Elektrokola', 99990, ['M', 'L']],
  ['Cannondale', 'Trail 6', 'Horská kola', 16490, ['M', 'L']],
  ['Cannondale', 'Topstone 2', 'Gravel kola', 47990, ['M', 'L']],
  ['Cannondale', 'CAAD Optimo 1', 'Silniční kola', 37990, ['54', '56']],
  ['Santa Cruz', 'Heckler 9 C R', 'Elektrokola', 169990, ['M', 'L']],
  ['Santa Cruz', 'Chameleon D', 'Horská kola', 64990, ['M', 'L']],
  ['Santa Cruz', 'Tallboy C D', 'Celoodpružená kola', 119990, ['M']],
  ['Focus', 'JAM² 6.8', 'Elektrokola', 129990, ['M', 'L']],
  ['Focus', 'Whistler 3.6', 'Horská kola', 18990, ['M', 'L']],
  ['Focus', 'Atlas 6.8', 'Gravel kola', 46990, ['M']],
  ['Cervélo', 'Caledonia 5 105 Di2', 'Silniční kola', 109990, ['54', '56']],
  ['Kellys', 'Spider 70', 'Horská kola', 23990, ['M', 'L']],
  ['Kellys', 'Kiter 30', 'Dětská kola', 12990, ['24"']],
  ['Author', 'Ronin 29', 'Horská kola', 19990, ['17"', '19"']],
  ['Scott', 'Scale 970', 'Horská kola', 29990, ['M', 'L']],
  ['Scott', 'Addict 30', 'Silniční kola', 59990, ['54']],
];

const PARTS = [
  ['Shimano', 'Deore XT RD-M8100 přehazovačka 12s', 'Komponenty', 2690],
  ['Shimano', 'SLX BR-M7100 kotoučová brzda', 'Komponenty', 2290],
  ['Shimano', '105 ST-R7170 Di2 řadicí páky', 'Komponenty', 16990],
  ['SRAM', 'GX Eagle AXS přehazovačka', 'Komponenty', 9990],
  ['SRAM', 'NX Eagle kazeta 11-50', 'Komponenty', 1890],
  ['Continental', 'Grand Prix 5000 S TR 700x28C', 'Pláště', 1590],
  ['Schwalbe', 'Nobby Nic 29x2.40 Evo', 'Pláště', 1390],
  ['Maxxis', 'Minion DHF 29x2.50 WT', 'Pláště', 1490],
  ['Schwalbe', 'G-One Allround 40-622', 'Pláště', 1190],
  ['Fox', '36 Float Performance 29 150 mm', 'Odpružení', 22990],
  ['RockShox', 'Pike Ultimate 29 140 mm', 'Odpružení', 27990],
  ['RockShox', 'Deluxe Select+ 210x55', 'Odpružení', 8990],
  ['Garmin', 'Edge 840', 'Elektronika', 10990],
  ['Wahoo', 'Elemnt Bolt v2', 'Elektronika', 6990],
  ['Topeak', 'JoeBlow Sport III hustilka', 'Příslušenství', 1090],
  ['Abus', 'Granit X-Plus 540 zámek', 'Příslušenství', 2790],
  ['Elite', 'Suito-T trenažér', 'Trenažéry', 19990],
  ['Lezyne', 'Macro Drive 1400+ světlo', 'Příslušenství', 2290],
  ['Giro', 'Aether Spherical přilba', 'Přilby', 7490],
  ['Kryptonite', 'Evolution Mini-7 zámek', 'Příslušenství', 2190],
  ['Shimano', 'XC5 tretry', 'Obuv', 3290],
  ['Continental', 'Race 28 duše 700x20-25C', 'Duše', 199],
  ['Muc-Off', 'Nano Tech čistič 1 l', 'Údržba', 349],
  ['Park Tool', 'PCS-10.3 montážní stojan', 'Nářadí', 6490],
];

const BRAND_CODE = {
  Trek: 'TRK', Specialized: 'SPZ', Cannondale: 'CND', 'Santa Cruz': 'SCZ', Focus: 'FOC', Cervélo: 'CRV', Kellys: 'KLS', Author: 'AUT',
  Scott: 'SCO', Shimano: 'SHI', SRAM: 'SRM', Continental: 'CON', Schwalbe: 'SCH', Maxxis: 'MAX', Fox: 'FOX', RockShox: 'RSX',
  Garmin: 'GRM', Wahoo: 'WAH', Topeak: 'TOP', Abus: 'ABU', Elite: 'ELI', Lezyne: 'LEZ', Giro: 'GIR', Kryptonite: 'KRY',
  'Muc-Off': 'MUC', 'Park Tool': 'PRK',
};

const SUPPLIER = {
  Trek: 'Trek Bicycle CZ', Specialized: 'Specialized CZ', Cannondale: 'PON Bike CZ', 'Santa Cruz': 'PON Bike CZ', Focus: 'PON Bike CZ',
  Cervélo: 'PON Bike CZ', Kellys: 'Kellys Bicycles', Author: 'Author a.s.', Scott: 'Scott Sports CZ',
};

const OWNERS = ['Petr Novák', 'Jana Dvořáková', 'Martin Svoboda', 'Lucie Černá'];

const COMPETITORS = [
  { name: 'VeloMarket.cz', label: 'VeloMarket', tags: ['klíčový'], enabled: 1, share: 0.85, bias: -0.02 },
  { name: 'KoloExpres.cz', label: 'KoloExpres', tags: ['klíčový'], enabled: 1, share: 0.7, bias: 0 },
  { name: 'CykloSvět.cz', label: null, tags: [], enabled: 1, share: 0.55, bias: 0.03 },
  { name: 'BikeCentrum.cz', label: null, tags: [], enabled: 1, share: 0.5, bias: 0.04 },
  { name: 'Tržiště Sport', label: 'Tržiště Sport (marketplace)', tags: ['marketplace'], enabled: 1, share: 0.45, bias: -0.04 },
  { name: 'Kolárna Brno', label: null, tags: ['kamenná prodejna'], enabled: 1, share: 0.3, bias: 0.06 },
  { name: 'RideShop.cz', label: null, tags: [], enabled: 1, share: 0.35, bias: 0.02 },
  { name: 'LevnáKola.cz', label: null, tags: ['bazar'], enabled: 0, share: 0.25, bias: -0.15 },
];

// ------------------------------------------------------------------ generování stavu

function createState(opts = {}) {
  const now = opts.now ? new Date(opts.now).getTime() : Date.now();
  const rnd = mulberry32(opts.seed || 20260925);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const between = (a, b) => a + rnd() * (b - a);
  const st = {
    extensions: Boolean(opts.extensions),
    now: () => (opts.now ? new Date(opts.now).getTime() : Date.now()),
    t0: now,
    password: opts.password || 'demo',
    settings: clone(DEFAULT_SETTINGS),
    products: [],
    competitors: [],
    offers: [],
    unmatched: [],
    segments: [],
    strategies: [],
    runs: [],
    proposals: [],
    imports: [],
    sources: [],
    exports: [],
    tokens: [],
    audit: [],
    sessions: new Set(),
    seq: {},
  };
  st.nextId = (k) => {
    st.seq[k] = (st.seq[k] || 0) + 1;
    return st.seq[k];
  };

  // produkty
  const codes = new Set();
  const addProduct = (brand, model, category, msrp, size, isBike) => {
    const id = st.nextId('products');
    const modelCode = fold(model).replace(/[^a-z0-9 ]/g, '').split(' ').filter(Boolean).map((w) => (/\d/.test(w) ? w : w.slice(0, 3))).join('').toUpperCase().slice(0, 8);
    let code = BRAND_CODE[brand] + '-' + modelCode + (size ? '-' + size.replace(/"/g, '') : '');
    while (codes.has(code)) code += 'X';
    codes.add(code);
    const variantFactor = size && /^(XL|L|56|19|S4)/.test(size) ? 1 : 1;
    const msrpV = msrp * variantFactor;
    const priceFactor = pick([1, 1, 1, 0.97, 0.95, 0.93, 0.9]);
    const price = roundEnding(msrpV * priceFactor);
    const purchase = round((msrpV / 1.21) * between(0.6, 0.76), 2);
    const nClass = pick(['N0', 'N0', 'N1', 'N1', 'N2', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8']);
    const stock = rnd() < 0.18 ? 0 : Math.floor(between(1, isBike ? 7 : 25));
    const sales30 = Math.floor(between(0, isBike ? 5 : 14));
    const ean = eanWithCheck('859' + String(Math.floor(rnd() * 1e9)).padStart(9, '0'));
    const attrs = { N: nClass, imprese_30: Math.floor(between(40, isBike ? 3200 : 900)) };
    if (isBike) {
      attrs.sezona = pick(['2024', '2025', '2025', '2026', '2026']);
      attrs.barva = pick(['černá', 'modrá', 'zelená', 'šedá', 'červená', 'bílá']);
    }
    st.products.push({
      id,
      code,
      code_key: codeKey(code),
      ean,
      ean_key: eanKey(ean),
      mpn: brand.slice(0, 2).toUpperCase() + Math.floor(between(10000, 99999)),
      mpn_key: null,
      name: brand + ' ' + model + (size ? ', ' + (isBike && /^\d\d$/.test(size) ? 'vel. ' + size : size) : ''),
      manufacturer: brand,
      category,
      supplier: SUPPLIER[brand] || (brand === 'Shimano' ? 'Shimano CZ' : 'Cyklo Distribuce s.r.o.'),
      owner: isBike ? (['Elektrokola', 'Celoodpružená kola'].includes(category) ? OWNERS[1] : OWNERS[0]) : category === 'Příslušenství' || category === 'Elektronika' ? OWNERS[3] : OWNERS[2],
      purchase_price: rnd() < 0.03 ? null : purchase,
      price,
      vat_rate: 21,
      msrp: rnd() < 0.05 ? null : msrpV,
      stock,
      sales_30: sales30,
      sales_90: Math.floor(sales30 * between(2, 3.5)),
      attrs,
      active: 1,
      locked: 0,
      min_price: null,
      max_price: null,
      note: null,
      price_changed_at: iso(now - between(3, 60) * DAY),
      created_at: iso(now - 200 * DAY),
      updated_at: iso(now - between(0, 2) * DAY),
    });
    st.products[st.products.length - 1].mpn_key = mpnKey(st.products[st.products.length - 1].mpn);
  };
  for (const [brand, model, cat, msrp, sizes] of BIKES) for (const s of sizes) addProduct(brand, model, cat, msrp, s, true);
  for (const [brand, model, cat, msrp] of PARTS) addProduct(brand, model, cat, msrp, null, false);
  // pár ručních nastavení
  st.products[3].locked = 1;
  st.products[3].note = 'Cena dohodnutá s dodavatelem do konce sezóny.';
  st.products[10].min_price = st.products[10].price - 500;
  st.products[20].max_price = st.products[20].price + 1000;
  st.products[st.products.length - 1].active = 0;

  // konkurenti
  for (const c of COMPETITORS) {
    st.competitors.push({
      id: st.nextId('competitors'),
      name: c.name,
      name_key: nameKey(c.name),
      label: c.label,
      enabled: c.enabled,
      tags: [...c.tags],
      note: c.enabled ? null : 'Bazarové ceny – vypnuto.',
      created_at: iso(now - 180 * DAY),
      _share: c.share,
      _bias: c.bias,
    });
  }

  // nabídky
  for (const p of st.products) {
    if (rnd() < 0.08) continue; // bez konkurence
    for (const c of st.competitors) {
      if (rnd() > c._share) continue;
      const price = roundEnding(p.price * (1 + c._bias + between(-0.07, 0.07)));
      const ageDays = rnd() < 0.07 ? between(8, 20) : between(0.05, 5);
      const inStockR = rnd();
      const in_stock = inStockR < 0.8 ? 1 : inStockR < 0.92 ? 0 : null;
      const changed = rnd() < 0.3;
      st.offers.push({
        product_id: p.id,
        competitor_id: c.id,
        price,
        shipping: pick([0, 0, 0, 99, 129, 149]),
        in_stock,
        delivery_days: in_stock === 0 ? Math.floor(between(3, 15)) : in_stock === 1 ? 0 : null,
        url: 'https://' + slug(c.name) + '.example/p/' + slug(p.name),
        name: p.name.replace(', vel. ', ' ').replace(/,/g, ''),
        observed_at: iso(now - ageDays * DAY),
        first_seen_at: iso(now - between(20, 120) * DAY),
        prev_price: changed ? roundEnding(price * (1 + between(-0.06, 0.06))) : null,
        changed_at: changed ? iso(now - between(ageDays, ageDays + 6) * DAY) : null,
        source_id: 2,
      });
    }
  }

  // nespárované nabídky
  const unmatchedNames = [
    ['VeloMarket.cz', 'Trek Marlin 6 Gen 3 2026 M', '8592842099911', null, 17990],
    ['VeloMarket.cz', 'Shimano Deore M6100 kazeta 10-51', '4550170211335', 'CS-M6100', 1690],
    ['KoloExpres.cz', 'Specialized Rockhopper Sport 29 L', '0888818779900', null, 18490],
    ['CykloSvět.cz', 'Schwalbe Racing Ray 29x2.25', '4026495885123', '11654143', 1290],
    ['Tržiště Sport', 'KOLO TREK MARLIN 7 GEN3 VEL M MODRA', null, null, 20490],
    ['BikeCentrum.cz', 'Garmin Edge 540', '0753759310211', '010-02694-01', 7990],
    ['RideShop.cz', 'Fox 34 Float Performance 29 130', null, '910-20-812', 19990],
    ['Tržiště Sport', 'Continental GP5000 S TR 700x28 černá', '4019238080123', null, 1390],
  ];
  for (const [comp, name, ean, mpn, price] of unmatchedNames) {
    const c = st.competitors.find((x) => x.name === comp);
    const id = st.nextId('unmatched');
    st.unmatched.push({
      id,
      competitor_id: c.id,
      match_key: ean ? 'ean:' + eanKey(ean) : mpn ? 'mpn:' + mpnKey(mpn) : 'name:' + fold(name),
      code: null,
      ean,
      mpn,
      ext_id: 'X' + (1000 + id),
      name,
      price,
      url: 'https://' + slug(comp) + '.example/p/' + slug(name),
      raw: JSON.stringify({ name, ean, mpn, price, competitor: comp }),
      seen_count: Math.floor(between(1, 30)),
      first_seen_at: iso(now - between(5, 40) * DAY),
      last_seen_at: iso(now - between(0.1, 2) * DAY),
    });
  }

  // segmenty
  const seg = (name, description, filter, color) => {
    const s = { id: st.nextId('segments'), name, description, filter, color, created_at: iso(now - 90 * DAY), updated_at: iso(now - 10 * DAY) };
    st.segments.push(s);
    return s;
  };
  const sLezaky = seg('Ležáky N7/N8', 'Zboží skladem déle než 7 měsíců – doprodat.', { all: [{ field: 'attrs.N', op: 'in', value: ['N7', 'N8'] }] }, '#e34948');
  const sKey = seg('Klíčové značky', 'Trek, Specialized a Santa Cruz – držet konkurenceschopnou pozici.', { all: [{ field: 'manufacturer', op: 'in', value: ['Trek', 'Specialized', 'Santa Cruz'] }] }, '#2a78d6');
  const sNoMarket = seg('Bez konkurence', 'Produkty, které nikdo jiný nenabízí.', { all: [{ field: 'market_count', op: '=', value: 0 }] }, '#898781');
  const sParts = seg('Komponenty a díly', 'Díly, pláště a odpružení nebo cokoli levnějšího než 3 000 Kč.', { any: [{ field: 'category', op: 'in', value: ['Komponenty', 'Pláště', 'Odpružení', 'Duše'] }, { field: 'price', op: '<', value: 3000 }] }, '#1baf7a');
  seg('Elektrokola skladem', null, { all: [{ field: 'category', op: '=', value: 'Elektrokola' }, { field: 'stock', op: '>', value: 0 }] }, '#eda100');

  // strategie
  const strat = (name, description, segment, priority, enabled, config) => {
    st.strategies.push({ id: st.nextId('strategies'), name, description, segment_id: segment ? segment.id : null, priority, enabled, config: deepMerge(DEFAULT_CONFIG, config), created_at: iso(now - 80 * DAY), updated_at: iso(now - 5 * DAY) });
  };
  strat('Ležáky – doprodej', 'Podlézt nejnižší cenu o 1 %, marže stačí 3 %.', sLezaky, 10, 1, { target: { mode: 'undercut_min', offset_pct: -1 }, limits: { min_margin_pct: 3, max_decrease_pct: 15 } });
  strat('Klíčové značky – pozice 2', 'Držet se těsně pod druhým nejlevnějším, nikdy nad MOC.', sKey, 20, 1, { target: { mode: 'rank', rank: 2, offset_abs: -1 }, limits: { min_margin_pct: 18, max_above_msrp_pct: 0 }, competitors: { include_tags: ['klíčový'], min_competitors: 1 } });
  strat('Bez konkurence → MOC', 'Kde není konkurence, prodávat za doporučenou cenu.', sNoMarket, 30, 1, { target: { mode: 'msrp' }, limits: { min_margin_pct: 10 } });
  strat('Komponenty – medián trhu', 'Díly nastavit na medián trhu.', sParts, 40, 0, { target: { mode: 'market_median' }, limits: { min_margin_pct: 15 }, rounding: { mode: 'ending', direction: 'nearest', bands: [{ up_to: 1000, ending: 9 }, { up_to: null, ending: 90 }] } });
  strat('Výchozí – medián trhu −2 %', 'Všechny ostatní produkty.', null, 100, 1, { target: { mode: 'market_median', offset_pct: -2 }, limits: { min_margin_pct: 12 }, approval: { auto: true, auto_max_change_pct: 3 }, competitors: { exclude_tags: ['marketplace'] } });

  // zdroje
  st.sources.push(
    { id: st.nextId('sources'), name: 'POHODA – skladové zásoby (CSV)', kind: 'products', url: 'https://admin.example/export/zasoby.csv', method: 'GET', headers: {}, mapping: { fields: { code: 'Kód', name: 'Název', purchase_price: 'Nákupní cena', price: 'Prodejní cena', stock: 'Stav zásoby' }, csv: { delimiter: ';', decimal: ',', encoding: 'windows-1250' } }, options: { deactivate_missing: true }, interval_minutes: 360, enabled: 1, last_run_at: iso(now - 2.2 * 3600000), last_status: 'ok', last_message: '112 přijato, 3 aktualizováno', created_at: iso(now - 150 * DAY), updated_at: iso(now - 20 * DAY) },
    { id: st.nextId('sources'), name: 'Sběr cen konkurence (XML)', kind: 'offers', url: 'https://pricing-feed.example/cyklo/offers.xml', method: 'GET', headers: { Authorization: 'Bearer ***' }, mapping: { item_path: 'offers.offer', fields: { ean: 'ean', competitor: 'shop', price: 'price', shipping: 'delivery', availability: 'availability', url: 'url' } }, options: { replace: 'competitors' }, interval_minutes: 120, enabled: 1, last_run_at: iso(now - 47 * 60000), last_status: 'ok', last_message: '402 nabídek, 8 nespárováno', created_at: iso(now - 150 * DAY), updated_at: iso(now - 30 * DAY) },
    { id: st.nextId('sources'), name: 'Ruční ceník Kolárna Brno (XLSX)', kind: 'offers', url: null, method: 'GET', headers: {}, mapping: { fields: { code: 'Kód', price: 'Cena' }, defaults: { competitor: 'Kolárna Brno' } }, options: {}, interval_minutes: 0, enabled: 1, last_run_at: iso(now - 9 * DAY), last_status: 'error', last_message: 'Soubor neobsahuje sloupec „Cena“.', created_at: iso(now - 60 * DAY), updated_at: iso(now - 9 * DAY) }
  );

  // importy
  const imp = (kind, format, origin, sourceId, agoMin, status, stats, error) =>
    st.imports.push({ id: st.nextId('imports'), source_id: sourceId, kind, format, origin, started_at: iso(now - agoMin * 60000), finished_at: iso(now - agoMin * 60000 + 1800 + Math.floor(rnd() * 4000)), status, stats, error: error || null });
  for (let i = 12; i >= 0; i--) {
    if (i % 3 === 0) imp('products', 'csv', 'schedule', 1, i * 360 + 130, 'ok', { received: 112, created: i === 12 ? 112 : 0, updated: 3 + (i % 4), unchanged: 105, deactivated: 0, errors: [] });
    imp('offers', 'xml', i % 4 === 0 ? 'api' : 'schedule', 2, i * 120 + 47, i === 7 ? 'error' : 'ok', i === 7 ? {} : { received: 402 + i, matched: 390 + i, unmatched: 8, ambiguous: 0, created: 3, updated: 41 + i, unchanged: 346, stale: 0, duplicates: 4, removed: 1, competitors_created: 0, errors: [] }, i === 7 ? 'Zdroj vrátil HTTP 503 (Service Unavailable).' : null);
  }
  imp('offers', 'xlsx', 'upload', 3, 9 * 1440, 'error', { received: 0, errors: [{ row: 1, message: 'Chybí sloupec s cenou' }] }, 'Soubor neobsahuje sloupec „Cena“.');
  st.imports.sort((a, b) => a.started_at.localeCompare(b.started_at));
  st.imports.forEach((x, i) => { x.id = i + 1; });
  st.seq.imports = st.imports.length;

  // tokeny, audit, exporty
  st.tokens.push(
    { id: st.nextId('tokens'), name: 'Admin – stahování feedu', prefix: 'ct_7Hq2', scopes: ['export'], created_at: iso(now - 60 * DAY), last_used_at: iso(now - 25 * 60000), _token: 'ct_7Hq2mockmockmockmockmockmockmock' },
    { id: st.nextId('tokens'), name: 'Sběr cen – import', prefix: 'ct_Xk9p', scopes: ['import'], created_at: iso(now - 45 * DAY), last_used_at: iso(now - 47 * 60000), _token: 'ct_Xk9pmockmockmockmockmockmockmock' }
  );
  const exp = (agoMin, kind, target, count, status, detail) => st.exports.push({ id: st.nextId('exports'), created_at: iso(now - agoMin * 60000), kind, target, count, status, detail });
  exp(6 * 1440, 'feed', 'changes.json', 42, 'ok', null);
  exp(5 * 1440, 'ack', 'admin', 42, 'ok', null);
  exp(3 * 1440, 'webhook', 'https://admin.example/hooks/prices', 18, 'ok', 'HTTP 200 za 312 ms');
  exp(2 * 1440, 'webhook', 'https://admin.example/hooks/prices', 0, 'error', 'HTTP 502 Bad Gateway');
  exp(1440, 'pohoda', 'pohoda.xml', 12, 'ok', null);
  exp(180, 'feed', 'changes.xml', 7, 'ok', null);

  // běhy + návrhy
  for (let i = 5; i >= 1; i--) {
    const started = now - i * 1440 * 60000 + 8 * 3600000;
    st.runs.push({ id: st.nextId('runs'), started_at: iso(started), finished_at: iso(started + 2400), status: i === 4 ? 'error' : 'done', trigger: i % 2 ? 'schedule' : 'manual', stats: i === 4 ? {} : { products: 110, evaluated: 110, changes: 30 + i * 3, up: 9 + i, down: 21 + i * 2, no_change: 60, skipped: { locked: 1, no_market: 6 }, no_strategy: 0, auto_approved: 5, pending: 25 + i, by_strategy: {}, margin_impact_abs: -8200 - i * 900 }, error: i === 4 ? 'Chyba strategie #3: minimální marže ≥ 100 %.' : null });
  }
  doRun(st, { trigger: 'schedule', at: now - 3 * 3600000, statusMix: true });
  // historické návrhy (exportované / zamítnuté) z předchozího běhu
  const prevRun = st.runs[st.runs.length - 2];
  const prevProps = st.proposals.slice(0, 16);
  prevProps.forEach((p, i) => {
    const copy = { ...clone(p), id: st.nextId('proposals'), run_id: prevRun.id, created_at: prevRun.started_at };
    copy.status = i < 8 ? 'exported' : i < 12 ? 'rejected' : 'superseded';
    copy.decided_at = iso(new Date(prevRun.started_at).getTime() + 3600000);
    copy.decided_by = 'admin';
    if (copy.status === 'exported') {
      copy.exported_at = iso(new Date(prevRun.started_at).getTime() + 7200000);
      copy.export_id = 1;
    }
    st.proposals.push(copy);
  });

  for (let i = 0; i < 30; i++) {
    st.audit.push({ id: st.nextId('audit'), at: iso(now - i * 3.1 * 3600000), actor: i % 5 === 0 ? 'token:Sběr cen – import' : 'admin', action: pick(['proposals.approve', 'strategy.update', 'import.offers', 'export.feed', 'product.update', 'segment.update', 'run.manual']), entity: pick(['proposal', 'strategy', 'import', 'export', 'product']), entity_id: Math.floor(between(1, 80)), detail: null });
  }
  return st;
}

// ------------------------------------------------------------------ metriky (SPEC §6.3)

function productOffers(st, productId) {
  return st.offers.filter((o) => o.product_id === productId);
}

function engineOffer(st, o) {
  const c = st.competitors.find((x) => x.id === o.competitor_id) || {};
  return { competitor_id: o.competitor_id, competitor: c.name, label: c.label, tags: c.tags || [], enabled: Boolean(c.enabled), price: o.price, shipping: o.shipping, in_stock: o.in_stock, delivery_days: o.delivery_days, url: o.url, observed_at: o.observed_at };
}

function buildMarket(offers, filterCfg, ctx) {
  const f = { include: [], exclude: [], include_tags: [], exclude_tags: [], in_stock_only: true, include_shipping: false, max_age_days: null, outlier_pct: null, min_competitors: 1, ...(filterCfg || {}) };
  const maxAge = f.max_age_days ?? ctx.maxAgeDays;
  const inc = new Set((f.include || []).map(nameKey));
  const exc = new Set((f.exclude || []).map(nameKey));
  const used = [];
  const excluded = [];
  for (const o of offers) {
    const k = nameKey(o.competitor);
    let reason = null;
    if (!o.enabled) reason = 'disabled';
    else if (exc.has(k)) reason = 'excluded';
    else if (inc.size && !inc.has(k)) reason = 'not_included';
    else if ((f.include_tags || []).length && !o.tags.some((t) => f.include_tags.includes(t))) reason = 'tag';
    else if ((f.exclude_tags || []).length && o.tags.some((t) => f.exclude_tags.includes(t))) reason = 'tag';
    else if (f.in_stock_only && o.in_stock === 0) reason = 'out_of_stock';
    else if (maxAge != null && (ctx.now - new Date(o.observed_at).getTime()) / DAY > maxAge) reason = 'stale';
    if (reason) excluded.push({ offer: o, reason });
    else used.push({ ...o, effective: round(o.price + (f.include_shipping ? o.shipping || 0 : 0), 2) });
  }
  if (f.outlier_pct != null && used.length >= 3) {
    const med = median(used.map((o) => o.effective));
    for (let i = used.length - 1; i >= 0; i--) {
      if (used[i].effective < med * (1 - f.outlier_pct / 100)) excluded.push({ offer: used.splice(i, 1)[0], reason: 'outlier' });
    }
  }
  used.sort((a, b) => a.effective - b.effective || String(a.competitor).localeCompare(String(b.competitor)));
  const prices = used.map((o) => o.effective);
  return {
    offers: used,
    excluded,
    count: used.length,
    min: prices.length ? prices[0] : null,
    max: prices.length ? prices[prices.length - 1] : null,
    avg: prices.length ? round(mean(prices), 2) : null,
    median: prices.length ? round(median(prices), 2) : null,
    cheapest: used[0] || null,
    prices,
  };
}

function rankOf(price, m) {
  if (!m.count || price == null) return null;
  return 1 + m.prices.filter((p) => p < price).length;
}

function positionOf(price, m) {
  if (!m.count || price == null) return 'no_data';
  if (price <= m.min) return 'cheapest';
  if (price > m.max) return 'most_expensive';
  return 'middle';
}

function productView(st, p, ctx) {
  const vat = p.vat_rate ?? st.settings.vat_rate_default;
  const offers = productOffers(st, p.id).map((o) => engineOffer(st, o));
  const m = buildMarket(offers, { in_stock_only: st.settings.metrics_in_stock_only }, ctx);
  const price = p.price;
  const netPrice = net(price, vat);
  const v = {
    ...p,
    attrs: { ...p.attrs },
    vat,
    margin_pct: marginPct(price, p.purchase_price, vat),
    markup_pct: markupPct(price, p.purchase_price, vat),
    profit_abs: p.purchase_price != null && price != null ? round(netPrice - p.purchase_price, 2) : null,
    stock_value: p.purchase_price != null && p.stock != null ? round(p.purchase_price * p.stock, 2) : null,
    days_of_cover: p.sales_30 ? round(p.stock / (p.sales_30 / 30), 1) : null,
    market_count: m.count,
    market_min: m.min,
    market_max: m.max,
    market_avg: m.avg,
    market_median: m.median,
    cheapest_competitor: m.cheapest ? m.cheapest.competitor : null,
    rank: rankOf(price, m),
    position: positionOf(price, m),
    price_index: m.min ? round((price / m.min) * 100, 1) : null,
    price_index_median: m.median ? round((price / m.median) * 100, 1) : null,
    gap_min_abs: m.min != null ? round(price - m.min, 2) : null,
    gap_min_pct: m.min ? round(((price - m.min) / m.min) * 100, 2) : null,
    msrp_diff_pct: p.msrp ? round(((price - p.msrp) / p.msrp) * 100, 2) : null,
    offers_instock: offers.filter((o) => o.in_stock === 1 && o.enabled).length,
  };
  delete v.code_key;
  delete v.ean_key;
  delete v.mpn_key;
  return v;
}

function ctxOf(st) {
  return { now: st.now(), maxAgeDays: st.settings.offer_max_age_days };
}

function allViews(st, { status = 'active' } = {}) {
  const ctx = ctxOf(st);
  return st.products.filter((p) => (status === 'all' ? true : status === 'inactive' ? !p.active : p.active)).map((p) => productView(st, p, ctx));
}

// ------------------------------------------------------------------ filtr (SPEC §6.4)

function compileFilter(filter) {
  const num = (v) => (typeof v === 'number' ? v : parseNumber(v));
  const get = (view, field) => field.split('.').reduce((o, k) => (o == null ? undefined : o[k]), view);
  const cmpStr = (a) => fold(a);
  const walk = (f, pathStr) => {
    if (f == null || typeof f !== 'object' || Array.isArray(f)) throw new HttpError(400, 'Neplatný filtr: ' + pathStr + ' musí být objekt');
    if (typeof f.field === 'string') {
      const { field, op } = f;
      let value = f.value;
      const ops = ['=', '!=', '>', '>=', '<', '<=', 'in', 'not_in', 'contains', 'not_contains', 'starts_with', 'empty', 'not_empty', 'between', 'is_true', 'is_false'];
      if (!ops.includes(op)) throw new HttpError(400, 'Neplatný filtr: neznámý operátor „' + op + '“');
      if ((op === 'in' || op === 'not_in') && typeof value === 'string') value = value.split(',').map((s) => s.trim());
      return (view) => {
        const x = get(view, field);
        const missing = x == null || x === '';
        if (op === 'empty') return missing;
        if (op === 'not_empty') return !missing;
        if (missing) return ['!=', 'not_in', 'not_contains', 'is_false'].includes(op);
        switch (op) {
          case 'is_true': return x === true || x === 1 || x === '1' || fold(x) === 'true' || fold(x) === 'ano';
          case 'is_false': return !(x === true || x === 1 || x === '1' || fold(x) === 'true' || fold(x) === 'ano');
          case '=': case '!=': {
            const nx = num(x);
            const nv = num(value);
            const eq = nx != null && nv != null && typeof x === 'number' ? nx === nv : cmpStr(x) === cmpStr(value);
            return op === '=' ? eq : !eq;
          }
          case '>': case '>=': case '<': case '<=': {
            const nx = num(x);
            const nv = num(value);
            if (nx == null || nv == null) return false;
            return op === '>' ? nx > nv : op === '>=' ? nx >= nv : op === '<' ? nx < nv : nx <= nv;
          }
          case 'between': {
            const nx = num(x);
            if (!Array.isArray(value) || nx == null) return false;
            const a = num(value[0]);
            const b = num(value[1]);
            return a != null && b != null && nx >= a && nx <= b;
          }
          case 'in': case 'not_in': {
            const list = (Array.isArray(value) ? value : [value]).map(cmpStr);
            const hit = list.includes(cmpStr(x));
            return op === 'in' ? hit : !hit;
          }
          case 'contains': return cmpStr(x).includes(cmpStr(value));
          case 'not_contains': return !cmpStr(x).includes(cmpStr(value));
          case 'starts_with': return cmpStr(x).startsWith(cmpStr(value));
          default: return false;
        }
      };
    }
    if (Array.isArray(f.all)) {
      const fns = f.all.map((x, i) => walk(x, pathStr + '.all[' + i + ']'));
      return (v) => fns.every((fn) => fn(v));
    }
    if (Array.isArray(f.any)) {
      const fns = f.any.map((x, i) => walk(x, pathStr + '.any[' + i + ']'));
      return (v) => fns.some((fn) => fn(v));
    }
    if ('not' in f) {
      const fn = walk(f.not, pathStr + '.not');
      return (v) => !fn(v);
    }
    if (!Object.keys(f).length) return () => true;
    throw new HttpError(400, 'Neplatný filtr: neznámá struktura v ' + pathStr);
  };
  return walk(filter || {}, 'filtr');
}

function segmentIdsFor(st, view, compiled) {
  const out = [];
  for (const s of st.segments) {
    let fn = compiled && compiled.get(s.id);
    if (!fn) {
      try {
        fn = compileFilter(s.filter);
      } catch {
        fn = () => false;
      }
      if (compiled) compiled.set(s.id, fn);
    }
    if (fn(view)) out.push(s.id);
  }
  return out;
}

// ------------------------------------------------------------------ zjednodušený cenový engine (SPEC §6.7)

const money = (v) => (v == null ? '–' : Math.round(v).toLocaleString('cs-CZ').replace(/ /g, ' ') + ' Kč');
const pct = (v) => (v == null ? '–' : String(round(v, 2)).replace('.', ',') + ' %');

function roundPrice(value, rounding, direction) {
  const r = rounding || DEFAULT_CONFIG.rounding;
  if (r.mode === 'none') return { v: round(value, 2), up: round(value, 2), down: round(value, 2) };
  if (r.mode === 'integer') return { v: direction === 'up' ? Math.ceil(value) : direction === 'nearest' ? Math.round(value) : Math.floor(value), up: Math.ceil(value), down: Math.floor(value) };
  const bands = r.bands || [];
  const b = bands.find((x) => x.up_to == null || value <= x.up_to) || bands[bands.length - 1] || { ending: 0 };
  const step = b.step || (b.ending ? 10 ** String(b.ending).length : 1);
  let down = Math.floor((value - b.ending) / step + 1e-9) * step + b.ending;
  const up = Math.abs(down - value) < 1e-9 ? down : down + step;
  if (down <= 0) down = up;
  const dir = direction || r.direction || 'down';
  return { v: dir === 'up' ? up : dir === 'nearest' ? (value - down <= up - value ? down : up) : down, up, down, step };
}

function decide(st, product, offers, strategy, ctx) {
  const cfg = deepMerge(DEFAULT_CONFIG, strategy.config || {});
  const vat = product.vat_rate ?? st.settings.vat_rate_default;
  const cur = product.price;
  const explain = [];
  const flags = [];
  const d = {
    action: 'no_change', reason: null, product_id: product.id, strategy_id: strategy.id ?? null, segment_id: strategy.segment_id ?? null,
    old_price: cur, new_price: null, target_price: null, reference_price: null, floor: null, ceiling: null, market: null,
    rank_before: null, rank_after: null, margin_before: marginPct(cur, product.purchase_price, vat), margin_after: null,
    change_abs: null, change_pct: null, flags, explain, auto_approve: false,
  };
  const skip = (reason, text) => {
    explain.push({ step: 'result', text });
    return { ...d, action: 'skip', reason };
  };
  explain.push({ step: 'strategy', text: 'Strategie „' + (strategy.name || 'simulace') + '“' + (strategy.segment_id ? ' (segment #' + strategy.segment_id + ')' : ' (všechny produkty)') });
  if (product.locked) return skip('locked', 'Produkt je zamčený – cena se nemění.');
  let forced = null;
  if ((product.stock ?? 0) <= 0) {
    if (cfg.stock.zero_stock === 'skip') return skip('zero_stock', 'Nulový sklad – strategie produkty bez skladu nepřeceňuje.');
    if (cfg.stock.zero_stock === 'msrp') {
      if (!product.msrp) return skip('no_msrp', 'Nulový sklad → MOC, ale produkt nemá MOC.');
      forced = product.msrp;
      explain.push({ step: 'stock', text: 'Nulový sklad → cíl = MOC ' + money(product.msrp) });
    }
  }
  const m = buildMarket(offers, cfg.competitors, ctx);
  d.market = {
    count: m.count, min: m.min, max: m.max, avg: m.avg, median: m.median,
    cheapest: m.cheapest ? { competitor: m.cheapest.competitor, price: m.cheapest.effective } : null,
    used: m.offers.map((o) => ({ competitor: o.competitor, price: o.price, effective: o.effective, in_stock: o.in_stock })),
    excluded: m.excluded.map((x) => ({ competitor: x.offer.competitor, price: x.offer.price, reason: x.reason })),
  };
  d.rank_before = rankOf(cur, m);
  if (m.count) explain.push({ step: 'market', text: 'Nejnižší cena trhu: ' + money(m.min) + ' (' + m.cheapest.competitor + '), medián ' + money(m.median) + ', ' + m.count + ' ' + (m.count === 1 ? 'konkurent' : m.count < 5 ? 'konkurenti' : 'konkurentů') + (m.excluded.length ? '; vyřazeno ' + m.excluded.length : '') });
  else explain.push({ step: 'market', text: 'Žádná použitelná nabídka konkurence' + (m.excluded.length ? ' (vyřazeno ' + m.excluded.length + ')' : '') });
  const t = cfg.target;
  const marketModes = ['undercut_min', 'match_min', 'rank', 'market_avg', 'market_median', 'competitor'];
  let target = forced;
  let ref = null;
  if (target == null) {
    let insufficient = false;
    if (marketModes.includes(t.mode)) {
      if (m.count < (cfg.competitors.min_competitors || 1)) insufficient = true;
      else if (t.mode === 'undercut_min' || t.mode === 'match_min') ref = m.min;
      else if (t.mode === 'rank') ref = m.prices[Math.min(t.rank || 1, m.count) - 1];
      else if (t.mode === 'market_avg') ref = m.avg;
      else if (t.mode === 'market_median') ref = m.median;
      else if (t.mode === 'competitor') {
        const o = m.offers.find((x) => nameKey(x.competitor) === nameKey(t.competitor));
        if (o) ref = o.effective;
        else insufficient = true;
      }
    }
    if (insufficient) {
      flags.push('fallback');
      const fb = cfg.fallback;
      if (fb.mode === 'msrp') {
        if (!product.msrp) return skip('no_msrp', 'Náhradní režim MOC, ale produkt nemá MOC.');
        target = product.msrp * (1 + (fb.offset_pct || 0) / 100);
        explain.push({ step: 'fallback', text: 'Málo konkurence → náhradní režim: MOC ' + (fb.offset_pct ? pct(fb.offset_pct) : '') + ' → ' + money(target) });
      } else if (fb.mode === 'cost_plus') {
        if (product.purchase_price == null) return skip('no_cost', 'Náhradní režim nákup + přirážka, ale chybí nákupní cena.');
        target = gross(product.purchase_price * (1 + (fb.markup_pct || 0) / 100), vat);
        explain.push({ step: 'fallback', text: 'Málo konkurence → nákup + ' + pct(fb.markup_pct) + ' → ' + money(target) });
      } else {
        explain.push({ step: 'fallback', text: 'Málo konkurence → cena se ponechává' });
        if (cur == null) return skip('no_price', 'Chybí aktuální cena.');
        target = cur;
        d.reason = 'no_market';
      }
    } else if (ref != null) {
      d.reference_price = ref;
      target = t.mode === 'match_min' ? ref : ref * (1 + (t.offset_pct || 0) / 100) + (t.offset_abs || 0);
      const offTxt = t.mode === 'match_min' ? 'dorovnat' : [t.offset_pct ? pct(t.offset_pct) : null, t.offset_abs ? money(t.offset_abs) : null].filter(Boolean).join(' ') || 'bez posunu';
      explain.push({ step: 'target', text: 'Cíl: ' + offTxt + ' vůči ' + money(ref) + ' → ' + money(target) });
    } else if (t.mode === 'msrp') {
      if (!product.msrp) return skip('no_msrp', 'Produkt nemá doporučenou cenu (MOC).');
      d.reference_price = product.msrp;
      target = product.msrp * (1 + (t.offset_pct || 0) / 100) + (t.offset_abs || 0);
      explain.push({ step: 'target', text: 'Cíl: MOC ' + money(product.msrp) + (t.offset_pct ? ' ' + pct(t.offset_pct) : '') + ' → ' + money(target) });
    } else if (t.mode === 'cost_plus') {
      if (product.purchase_price == null) return skip('no_cost', 'Chybí nákupní cena.');
      target = gross(product.purchase_price * (1 + (t.markup_pct || 0) / 100), vat);
      explain.push({ step: 'target', text: 'Cíl: nákup ' + money(product.purchase_price) + ' + ' + pct(t.markup_pct) + ' → ' + money(target) + ' s DPH' });
    } else if (t.mode === 'keep') {
      if (cur == null) return skip('no_price', 'Chybí aktuální cena.');
      target = cur;
      explain.push({ step: 'target', text: 'Cíl: ponechat současnou cenu ' + money(cur) });
    } else if (t.mode === 'fixed') {
      target = t.fixed_price;
      explain.push({ step: 'target', text: 'Cíl: pevná cena ' + money(target) });
    }
  }
  if (target == null) return skip('no_market', 'Nelze určit cílovou cenu.');
  d.target_price = round(target, 2);
  // hranice
  const L = cfg.limits;
  const floors = [];
  const ceilings = [];
  if (product.purchase_price == null) flags.push('no_cost');
  else {
    if (L.min_margin_pct != null) floors.push([gross(product.purchase_price / (1 - L.min_margin_pct / 100), vat), 'Minimální marže ' + pct(L.min_margin_pct)]);
    if (L.min_profit_abs != null) floors.push([gross(product.purchase_price + L.min_profit_abs, vat), 'Minimální zisk ' + money(L.min_profit_abs)]);
    if (L.max_margin_pct != null) ceilings.push([gross(product.purchase_price / (1 - L.max_margin_pct / 100), vat), 'Maximální marže ' + pct(L.max_margin_pct)]);
  }
  if (product.msrp) {
    if (L.max_above_msrp_pct != null) ceilings.push([product.msrp * (1 + L.max_above_msrp_pct / 100), 'Strop MOC ' + money(product.msrp) + (L.max_above_msrp_pct ? ' +' + pct(L.max_above_msrp_pct) : '')]);
    if (L.max_below_msrp_pct != null) floors.push([product.msrp * (1 - L.max_below_msrp_pct / 100), 'Nejvýše ' + pct(L.max_below_msrp_pct) + ' pod MOC']);
  }
  if (L.respect_product_limits) {
    if (product.min_price != null) floors.push([product.min_price, 'Minimální cena produktu']);
    if (product.max_price != null) ceilings.push([product.max_price, 'Maximální cena produktu']);
  }
  const floor = floors.length ? floors.reduce((a, b) => (b[0] > a[0] ? b : a)) : null;
  const ceiling = ceilings.length ? ceilings.reduce((a, b) => (b[0] < a[0] ? b : a)) : null;
  d.floor = floor ? round(floor[0], 2) : null;
  d.ceiling = ceiling ? round(ceiling[0], 2) : null;
  if (floor) explain.push({ step: 'floor', text: floor[1] + ' → spodní hranice ' + money(floor[0]) });
  if (ceiling) explain.push({ step: 'ceiling', text: ceiling[1] + ' → horní hranice ' + money(ceiling[0]) });
  let price = target;
  if (cur != null) {
    const lo = !L.allow_decrease ? cur : L.max_decrease_pct != null ? cur * (1 - L.max_decrease_pct / 100) : -Infinity;
    const hi = !L.allow_increase ? cur : L.max_increase_pct != null ? cur * (1 + L.max_increase_pct / 100) : Infinity;
    if (price < lo || price > hi) {
      price = Math.min(hi, Math.max(lo, price));
      flags.push('change_limited');
      explain.push({ step: 'change_limit', text: 'Limit změny za přecenění (−' + pct(L.max_decrease_pct) + ' / +' + pct(L.max_increase_pct) + ') → ' + money(price) });
    }
  }
  if (ceiling && price > ceiling[0]) {
    price = ceiling[0];
    flags.push('ceiling');
  }
  if (floor && price < floor[0]) {
    price = floor[0];
    flags.push('floor');
    if (flags.includes('change_limited')) flags.push('floor_over_change_limit');
  }
  if (floor && ceiling && floor[0] > ceiling[0]) flags.push('limits_conflict');
  const r = roundPrice(price, cfg.rounding);
  let np = r.v;
  if (floor && np < floor[0]) np = r.up;
  if (ceiling && np > ceiling[0] && r.down >= (floor ? floor[0] : 0)) np = r.down;
  const bandTxt = cfg.rounding.mode === 'ending' ? 'konce …' + ((cfg.rounding.bands || []).find((b) => b.up_to == null || price <= b.up_to) || {}).ending : cfg.rounding.mode === 'integer' ? 'celé Kč' : 'haléře';
  explain.push({ step: 'rounding', text: 'Zaokrouhlení na ' + bandTxt + ' ' + (cfg.rounding.direction === 'up' ? 'nahoru' : cfg.rounding.direction === 'nearest' ? 'k nejbližší' : 'dolů') + ' → ' + money(np) });
  d.new_price = np;
  d.margin_after = marginPct(np, product.purchase_price, vat);
  d.rank_after = rankOf(np, m);
  if (cur != null) {
    d.change_abs = round(np - cur, 2);
    d.change_pct = round(((np - cur) / cur) * 100, 2);
    const within = (!floor || cur >= floor[0]) && (!ceiling || cur <= ceiling[0]);
    const thr = Math.max(L.min_change_abs || 0, (cur * (L.min_change_pct || 0)) / 100);
    if (np === cur) {
      explain.push({ step: 'result', text: 'Cena beze změny' });
      return { ...d, action: 'no_change', reason: d.reason || null };
    }
    if (Math.abs(np - cur) < thr && within) {
      explain.push({ step: 'threshold', text: 'Změna ' + money(np - cur) + ' je pod prahem ' + money(thr) + ' → beze změny' });
      return { ...d, action: 'no_change', reason: 'below_threshold' };
    }
  }
  if (product.purchase_price != null && net(np, vat) < product.purchase_price) flags.push('below_cost');
  if (d.change_pct != null && Math.abs(d.change_pct) > (cfg.approval.auto_max_change_pct ?? Infinity)) flags.push('big_change');
  d.auto_approve = Boolean(cfg.approval.auto) && !flags.some((f) => ['limits_conflict', 'floor_over_change_limit', 'below_cost', 'big_change'].includes(f));
  explain.push({ step: 'result', text: 'Nová cena ' + money(np) + ' (' + (d.change_pct > 0 ? '+' : '') + pct(d.change_pct) + ')' + (d.auto_approve ? ' – schváleno automaticky' : '') });
  return { ...d, action: 'change', reason: null };
}

function strategyFor(st, view, segIds) {
  const list = st.strategies.filter((s) => s.enabled).sort((a, b) => a.priority - b.priority || a.id - b.id);
  return list.find((s) => s.segment_id == null || segIds.includes(s.segment_id)) || null;
}

function evaluate(st, ctx, p, compiled) {
  const view = productView(st, p, ctx);
  const segIds = segmentIdsFor(st, view, compiled);
  const strategy = strategyFor(st, view, segIds);
  const offers = productOffers(st, p.id).map((o) => engineOffer(st, o));
  const decision = strategy ? decide(st, p, offers, strategy, ctx) : null;
  return { view, segIds, strategy, decision };
}

function emptyStats() {
  return { products: 0, evaluated: 0, changes: 0, up: 0, down: 0, no_change: 0, skipped: {}, no_strategy: 0, auto_approved: 0, pending: 0, by_strategy: {}, margin_impact_abs: 0 };
}

function addStats(stats, d, strategy, p, vat) {
  if (!d) {
    stats.no_strategy += 1;
    return;
  }
  stats.evaluated += 1;
  const bs = stats.by_strategy[strategy.id] || (stats.by_strategy[strategy.id] = { name: strategy.name, products: 0, changes: 0, up: 0, down: 0 });
  bs.products += 1;
  if (d.action === 'skip') stats.skipped[d.reason] = (stats.skipped[d.reason] || 0) + 1;
  else if (d.action === 'no_change') stats.no_change += 1;
  else {
    stats.changes += 1;
    bs.changes += 1;
    if (d.change_abs > 0) {
      stats.up += 1;
      bs.up += 1;
    } else {
      stats.down += 1;
      bs.down += 1;
    }
    stats.margin_impact_abs += net(d.new_price, vat) - net(d.old_price || 0, vat);
    if (d.auto_approve) stats.auto_approved += 1;
    else stats.pending += 1;
  }
}

function doRun(st, { trigger = 'manual', productIds, at, statusMix } = {}) {
  const ctx = { now: at || st.now(), maxAgeDays: st.settings.offer_max_age_days };
  const run = { id: st.nextId('runs'), started_at: iso(ctx.now), finished_at: null, status: 'running', trigger, stats: {}, error: null };
  const stats = emptyStats();
  const compiled = new Map();
  const targets = st.products.filter((p) => p.active && (!productIds || productIds.includes(p.id)));
  let n = 0;
  for (const p of targets) {
    stats.products += 1;
    const { strategy, decision } = evaluate(st, ctx, p, compiled);
    addStats(stats, decision, strategy, p, p.vat_rate ?? 21);
    // nahradit starší čekající/schválené návrhy produktu
    for (const old of st.proposals) if (old.product_id === p.id && (old.status === 'pending' || old.status === 'approved')) old.status = 'superseded';
    if (!decision || decision.action !== 'change') continue;
    n += 1;
    let status = decision.auto_approve ? 'approved' : 'pending';
    if (statusMix && status === 'pending' && n % 9 === 0) status = 'approved';
    st.proposals.push({
      id: st.nextId('proposals'),
      run_id: run.id,
      product_id: p.id,
      strategy_id: strategy.id,
      segment_id: strategy.segment_id,
      old_price: decision.old_price,
      new_price: decision.new_price,
      target_price: decision.target_price,
      reference_price: decision.reference_price,
      market_min: decision.market ? decision.market.min : null,
      competitor_count: decision.market ? decision.market.count : 0,
      rank_before: decision.rank_before,
      rank_after: decision.rank_after,
      margin_before: decision.margin_before,
      margin_after: decision.margin_after,
      change_abs: decision.change_abs,
      change_pct: decision.change_pct,
      status,
      flags: decision.flags,
      explain: decision.explain,
      manual_price: null,
      created_at: run.started_at,
      decided_at: status === 'approved' ? run.started_at : null,
      decided_by: status === 'approved' ? 'auto' : null,
      exported_at: null,
      export_id: null,
    });
  }
  stats.margin_impact_abs = round(stats.margin_impact_abs, 2);
  run.stats = stats;
  run.status = 'done';
  run.finished_at = iso(ctx.now + 1200 + targets.length * 3);
  st.runs.push(run);
  return run;
}

// ------------------------------------------------------------------ obohacení návrhů

function proposalRow(st, pr) {
  const p = st.products.find((x) => x.id === pr.product_id) || {};
  const s = st.strategies.find((x) => x.id === pr.strategy_id);
  const seg = st.segments.find((x) => x.id === pr.segment_id);
  return {
    ...pr,
    flags: [...(pr.flags || [])],
    explain: [...(pr.explain || [])],
    product: { code: p.code, name: p.name, manufacturer: p.manufacturer, category: p.category, stock: p.stock, purchase_price: p.purchase_price },
    strategy_name: s ? s.name : null,
    segment_name: seg ? seg.name : null,
  };
}

function filterProposals(st, q) {
  let list = st.proposals;
  const status = q.status || 'pending';
  if (status !== 'all') list = list.filter((p) => p.status === status);
  if (q.run) list = list.filter((p) => String(p.run_id) === String(q.run));
  if (q.strategy) list = list.filter((p) => String(p.strategy_id) === String(q.strategy));
  if (q.segment) list = list.filter((p) => String(p.segment_id) === String(q.segment));
  if (q.direction === 'up') list = list.filter((p) => p.change_abs > 0);
  if (q.direction === 'down') list = list.filter((p) => p.change_abs < 0);
  if (q.flag) list = list.filter((p) => (p.flags || []).includes(q.flag));
  if (q.manufacturer) list = list.filter((p) => fold(st.products.find((x) => x.id === p.product_id)?.manufacturer) === fold(q.manufacturer));
  if (q.q) {
    const f = fold(q.q);
    list = list.filter((pr) => {
      const p = st.products.find((x) => x.id === pr.product_id) || {};
      return fold(p.code).includes(f) || fold(p.name).includes(f) || fold(p.ean).includes(f);
    });
  }
  return list;
}

function sortList(list, sort, dir, getter) {
  const mul = dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    const va = getter(a, sort);
    const vb = getter(b, sort);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul;
    return String(va).localeCompare(String(vb), 'cs') * mul;
  });
}

function paginate(list, q, defLimit = 50, maxLimit = 500) {
  const limit = Math.max(1, Math.min(maxLimit, Number(q.limit) || defLimit));
  const page = Math.max(1, Number(q.page) || 1);
  return { items: list.slice((page - 1) * limit, page * limit), total: list.length, page, limit };
}

// ------------------------------------------------------------------ import (zjednodušené parsery)

function detectFormat(buf) {
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'xlsx';
  const s = buf.slice(0, 200).toString('utf8').replace(/^﻿/, '').trimStart();
  if (s[0] === '{' || s[0] === '[') return 'json';
  if (s[0] === '<') return 'xml';
  return 'csv';
}

function parseCsv(text, delimiter) {
  text = text.replace(/^﻿/, '');
  const firstLines = text.split(/\r?\n/).slice(0, 20).filter(Boolean);
  const delim = delimiter || [';', ',', '\t', '|'].map((d) => [d, firstLines.map((l) => l.split(d).length - 1)]).filter(([, c]) => c[0] > 0 && c.every((x) => x === c[0])).map(([d, c]) => [d, c[0]]).sort((a, b) => b[1] - a[1])[0]?.[0] || ';';
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim()));
  const headers = (nonEmpty[0] || []).map((hh, i) => hh.trim() || 'col_' + (i + 1));
  return { headers, delimiter: delim, rows: nonEmpty.slice(1).map((r) => Object.fromEntries(headers.map((hh, i) => [hh, (r[i] ?? '').trim()]))) };
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + '.' + k : k;
    if (Array.isArray(v)) {
      if (v.every((x) => x == null || typeof x !== 'object')) out[key] = v.join('|');
      else v.forEach((x, i) => flatten(x, key + '.' + i, out));
    } else if (v && typeof v === 'object') flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function jsonRecords(text, itemPath) {
  const data = JSON.parse(text);
  if (itemPath) {
    const v = itemPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
    return { records: Array.isArray(v) ? v : v ? [v] : [], itemPath };
  }
  if (Array.isArray(data)) return { records: data, itemPath: null };
  const queue = [[data, '']];
  while (queue.length) {
    const [o, p] = queue.shift();
    for (const [k, v] of Object.entries(o || {})) {
      if (Array.isArray(v) && v.some((x) => x && typeof x === 'object')) return { records: v, itemPath: p ? p + '.' + k : k };
      if (isPlain(v)) queue.push([v, p ? p + '.' + k : k]);
    }
  }
  return { records: [data], itemPath: null };
}

function xmlRecords(text, itemPath) {
  // jednoduchý tokenizér – mock pracuje jen s malými soubory
  const clean = text.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/gi, '');
  const re = /<(\/?)([\w:.-]+)([^>]*?)(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+)/g;
  const root = { name: '#', children: [], attrs: {}, text: '' };
  const stack = [root];
  let m;
  const dec = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  while ((m = re.exec(clean))) {
    if (m[2]) {
      const name = m[2].replace(/^[\w.-]+:/, '');
      if (m[1]) stack.pop();
      else {
        const attrs = {};
        for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1].replace(/^[\w.-]+:/, '')] = dec(a[2]);
        const node = { name, attrs, children: [], text: '' };
        stack[stack.length - 1].children.push(node);
        if (!m[4]) stack.push(node);
      }
    } else if (m[5] != null) stack[stack.length - 1].text += m[5];
    else if (m[6] && m[6].trim()) stack[stack.length - 1].text += dec(m[6].trim());
  }
  const toObj = (n) => {
    if (!n.children.length && !Object.keys(n.attrs).length) return n.text;
    const o = {};
    for (const [k, v] of Object.entries(n.attrs)) o['@' + k] = v;
    for (const c of n.children) {
      const v = toObj(c);
      if (c.name in o) o[c.name] = Array.isArray(o[c.name]) ? [...o[c.name], v] : [o[c.name], v];
      else o[c.name] = v;
    }
    if (n.text && n.children.length) o['#text'] = n.text;
    return o;
  };
  let best = null;
  const walk = (n, p) => {
    const counts = {};
    for (const c of n.children) counts[c.name] = (counts[c.name] || 0) + 1;
    for (const [name, cnt] of Object.entries(counts)) {
      const pp = p ? p + '.' + name : name;
      if (cnt > 1 && (!best || cnt > best.cnt || (cnt === best.cnt && pp.split('.').length > best.path.split('.').length))) best = { path: pp, cnt, parent: n, name };
    }
    for (const c of n.children) walk(c, p ? p + '.' + c.name : c.name);
  };
  walk(root, '');
  let path = itemPath || (best && best.path);
  if (!path) {
    const top = root.children[0];
    return { records: top ? [toObj(top)] : [], itemPath: null };
  }
  const parts = path.split('.');
  let nodes = [root];
  for (const part of parts) nodes = nodes.flatMap((n) => n.children.filter((c) => c.name === part));
  return { records: nodes.map(toObj), itemPath: path };
}

function extract(buf, mapping = {}) {
  const format = mapping.format && mapping.format !== 'auto' ? mapping.format : detectFormat(buf);
  let text = buf.toString('utf8');
  if (text.includes('�')) text = buf.toString('latin1');
  let records;
  let itemPath = null;
  let headers;
  if (format === 'json') ({ records, itemPath } = jsonRecords(text, mapping.item_path));
  else if (format === 'xml') ({ records, itemPath } = xmlRecords(text, mapping.item_path));
  else if (format === 'xlsx') {
    let readXlsx;
    try {
      ({ readXlsx } = require('../src/formats/xlsx.js'));
    } catch {
      throw new HttpError(415, 'Mock server neumí číst XLSX (modul src/formats/xlsx.js zatím chybí) – použijte CSV, JSON nebo XML.');
    }
    const r = readXlsx(buf, { sheet: mapping.xlsx?.sheet });
    records = r.rows;
    headers = r.headers;
  } else {
    const r = parseCsv(text, mapping.csv?.delimiter);
    records = r.rows;
    headers = r.headers;
  }
  const flat = records.map((r) => (isPlain(r) ? flatten(r) : { value: r }));
  if (!headers) {
    const set = new Set();
    for (const r of flat.slice(0, 1000)) for (const k of Object.keys(r)) set.add(k);
    headers = [...set];
  }
  return { format, itemPath, headers, records: flat };
}

const ALIASES = {
  code: ['code', 'kod', 'sku', 'katalog', 'katalogovecislo', 'productcode', 'itemid', 'idproduktu'],
  ean: ['ean', 'gtin', 'gtin13', 'barcode', 'carovykod'],
  mpn: ['mpn', 'productno', 'partnumber', 'kodvyrobce'],
  name: ['name', 'nazev', 'productname', 'product', 'title'],
  price: ['price', 'pricevat', 'cena', 'cenasdph', 'prodejnicena', 'sellingprice', 'currentprice'],
  purchase_price: ['purchaseprice', 'nakupnicena', 'nakup', 'cost', 'purchasingprice'],
  competitor: ['competitor', 'konkurent', 'shop', 'eshop', 'seller', 'obchod', 'retailer', 'domain', 'vendorname'],
  shipping: ['shipping', 'deliveryprice', 'doprava', 'postovne', 'delivery'],
  availability: ['availability', 'dostupnost', 'skladem', 'instock', 'deliverydate', 'stockstatus'],
  stock: ['stock', 'qty', 'quantity', 'count', 'mnozstvi', 'stav', 'stavskladu', 'sklademks', 'stavzasoby'],
  manufacturer: ['manufacturer', 'brand', 'vyrobce', 'znacka', 'producer'],
  category: ['category', 'kategorie', 'categorytext', 'group', 'skupina'],
  msrp: ['msrp', 'rrp', 'moc', 'doporucenacena', 'recommendedprice', 'standardprice'],
  vat_rate: ['vat', 'dph', 'sazbadph', 'vatrate', 'ratevat'],
  owner: ['owner', 'zodpovednaosoba', 'responsible', 'categorymanager', 'manager'],
  supplier: ['supplier', 'dodavatel'],
  url: ['url', 'link', 'odkaz'],
  observed_at: ['observedat', 'date', 'datum', 'timestamp', 'scrapedat', 'updatedat'],
  sales_30: ['sales30', 'prodej30', 'sales30d'],
  sales_90: ['sales90', 'prodej90', 'sales90d'],
  ext_id: ['extid', 'externalid', 'offerid'],
};

const CANON = {
  products: ['code', 'ean', 'mpn', 'name', 'manufacturer', 'category', 'supplier', 'owner', 'purchase_price', 'price', 'vat_rate', 'msrp', 'stock', 'sales_30', 'sales_90', 'active'],
  offers: ['code', 'ean', 'mpn', 'ext_id', 'competitor', 'price', 'shipping', 'availability', 'in_stock', 'delivery_days', 'stock_qty', 'url', 'name', 'observed_at'],
};
const NUMERIC = new Set(['purchase_price', 'price', 'vat_rate', 'msrp', 'stock', 'sales_30', 'sales_90', 'shipping', 'delivery_days', 'stock_qty']);

function suggestMapping(headers, kind) {
  const fields = {};
  const norm = (s) => fold(s).replace(/^[a-z]+:/, '').replace(/[^a-z0-9]/g, '');
  for (const canon of CANON[kind]) {
    const aliases = ALIASES[canon] || [canon.replace(/_/g, '')];
    const hit = headers.find((hh) => aliases.includes(norm(hh.split('.').pop())));
    if (hit) fields[canon] = hit;
  }
  return fields;
}

function applyMapping(rec, mapping, kind) {
  const fields = { ...suggestMapping(Object.keys(rec), kind), ...(mapping.fields || {}) };
  const out = {};
  const errors = [];
  for (const canon of CANON[kind]) {
    let v = fields[canon] ? rec[fields[canon]] : undefined;
    if ((v == null || v === '') && mapping.defaults && mapping.defaults[canon] != null && mapping.defaults[canon] !== '') v = mapping.defaults[canon];
    if (v == null || v === '') continue;
    if (NUMERIC.has(canon)) {
      const n = parseNumber(v, { decimal: mapping.csv?.decimal });
      if (n == null) errors.push('Pole „' + canon + '“: „' + v + '“ není číslo');
      else out[canon] = n;
    } else if (canon === 'availability') {
      const s = fold(v);
      out.in_stock = ['1', 'true', 'ano', 'yes', 'skladem', 'in stock', 'instock', 'in_stock', 'available', 'na sklade'].includes(s) ? 1 : ['0', 'false', 'ne', 'no', 'neni skladem', 'vyprodano', 'out of stock', 'na dotaz'].includes(s) ? 0 : null;
    } else out[canon] = String(v).trim();
  }
  if (kind === 'products') {
    if (!out.code) errors.push('Chybí kód produktu');
    const used = new Set(Object.values(fields));
    if (mapping.attrs !== 'none') {
      const attrs = {};
      for (const [k, v] of Object.entries(rec)) if (!used.has(k) && v !== '' && v != null) attrs[k] = /^-?\d+([.,]\d+)?$/.test(String(v)) ? parseNumber(v) : v;
      if (Object.keys(attrs).length) out.attrs = attrs;
    }
  } else {
    if (!out.competitor) errors.push('Chybí konkurent');
    if (!(out.price > 0)) errors.push('Chybí nebo neplatná cena');
    if (!out.code && !out.ean && !out.mpn && !out.ext_id && !out.name) errors.push('Chybí párovací klíč (kód, EAN, MPN, ID nebo název)');
  }
  return { value: errors.length ? null : out, errors };
}

function runImportMock(st, kind, buf, mapping, opts) {
  const ex = Array.isArray(opts.canonicalItems) ? { format: 'json', itemPath: null, headers: [], records: opts.canonicalItems } : extract(buf, mapping);
  const stats = kind === 'products'
    ? { received: 0, created: 0, updated: 0, unchanged: 0, deactivated: 0, errors: [] }
    : { received: 0, matched: 0, unmatched: 0, ambiguous: 0, created: 0, updated: 0, unchanged: 0, stale: 0, duplicates: 0, removed: 0, competitors_created: 0, errors: [] };
  const canonical = [];
  ex.records.forEach((rec, i) => {
    stats.received += 1;
    const { value, errors } = opts.canonicalItems ? { value: rec, errors: [] } : applyMapping(rec, mapping, kind);
    if (!value) {
      if (stats.errors.length < 100) stats.errors.push({ row: i + 1, message: errors.join('; ') });
      return;
    }
    canonical.push(value);
  });
  const now = st.now();
  if (!opts.dryRun) {
    for (const r of canonical) {
      if (kind === 'products') {
        const p = st.products.find((x) => x.code_key === codeKey(r.code));
        if (p) {
          let changed = false;
          for (const k of CANON.products) if (r[k] !== undefined && p[k] !== r[k]) { p[k] = r[k]; changed = true; }
          if (r.attrs) p.attrs = { ...p.attrs, ...r.attrs };
          if (changed) stats.updated += 1;
          else stats.unchanged += 1;
        } else {
          st.products.push({ id: st.nextId('products'), code: r.code, code_key: codeKey(r.code), ean: r.ean || null, ean_key: eanKey(r.ean), mpn: r.mpn || null, mpn_key: mpnKey(r.mpn), name: r.name || r.code, manufacturer: r.manufacturer || null, category: r.category || null, supplier: r.supplier || null, owner: r.owner || null, purchase_price: r.purchase_price ?? null, price: r.price ?? null, vat_rate: r.vat_rate ?? 21, msrp: r.msrp ?? null, stock: r.stock ?? null, sales_30: r.sales_30 ?? null, sales_90: r.sales_90 ?? null, attrs: r.attrs || {}, active: 1, locked: 0, min_price: null, max_price: null, note: null, price_changed_at: null, created_at: iso(now), updated_at: iso(now) });
          stats.created += 1;
        }
      } else {
        const p = st.products.find((x) => (r.code && x.code_key === codeKey(r.code)) || (r.ean && x.ean_key === eanKey(r.ean)) || (r.mpn && x.mpn_key === mpnKey(r.mpn)));
        let c = st.competitors.find((x) => x.name_key === nameKey(r.competitor));
        if (!c) {
          c = { id: st.nextId('competitors'), name: r.competitor, name_key: nameKey(r.competitor), label: null, enabled: 1, tags: [], note: null, created_at: iso(now) };
          st.competitors.push(c);
          stats.competitors_created += 1;
        }
        if (!p) {
          stats.unmatched += 1;
          st.unmatched.push({ id: st.nextId('unmatched'), competitor_id: c.id, match_key: r.ean ? 'ean:' + eanKey(r.ean) : 'name:' + fold(r.name), code: r.code || null, ean: r.ean || null, mpn: r.mpn || null, ext_id: r.ext_id || null, name: r.name || null, price: r.price, url: r.url || null, raw: JSON.stringify(r), seen_count: 1, first_seen_at: iso(now), last_seen_at: iso(now) });
          continue;
        }
        stats.matched += 1;
        const o = st.offers.find((x) => x.product_id === p.id && x.competitor_id === c.id);
        if (o) {
          if (o.price !== r.price) {
            o.prev_price = o.price;
            o.price = r.price;
            o.changed_at = iso(now);
            stats.updated += 1;
          } else stats.unchanged += 1;
          o.observed_at = iso(now);
          if (r.in_stock !== undefined) o.in_stock = r.in_stock;
        } else {
          st.offers.push({ product_id: p.id, competitor_id: c.id, price: r.price, shipping: r.shipping ?? null, in_stock: r.in_stock ?? null, delivery_days: r.delivery_days ?? null, url: r.url || null, name: r.name || null, observed_at: iso(now), first_seen_at: iso(now), prev_price: null, changed_at: null, source_id: opts.sourceId || null });
          stats.created += 1;
        }
      }
    }
  } else if (kind === 'offers') {
    for (const r of canonical) {
      const p = st.products.find((x) => (r.code && x.code_key === codeKey(r.code)) || (r.ean && x.ean_key === eanKey(r.ean)) || (r.mpn && x.mpn_key === mpnKey(r.mpn)));
      if (p) stats.matched += 1;
      else stats.unmatched += 1;
    }
  }
  let importId = null;
  if (!opts.dryRun) {
    importId = st.nextId('imports');
    st.imports.push({ id: importId, source_id: opts.sourceId || null, kind, format: ex.format, origin: opts.origin || 'upload', started_at: iso(now), finished_at: iso(now + 900), status: 'ok', stats, error: null });
  }
  const out = { import_id: importId, stats };
  if (opts.dryRun) out.preview = canonical.slice(0, 20);
  return out;
}

// ------------------------------------------------------------------ export

function exportRows(st, scope = 'approved') {
  const rows = [];
  const latestApproved = new Map();
  for (const pr of st.proposals) if (pr.status === 'approved') latestApproved.set(pr.product_id, pr);
  if (scope === 'approved') {
    for (const pr of latestApproved.values()) {
      const p = st.products.find((x) => x.id === pr.product_id);
      rows.push({ proposal_id: pr.id, product_id: p.id, code: p.code, ean: p.ean, name: p.name, manufacturer: p.manufacturer, price: pr.manual_price ?? pr.new_price, old_price: pr.old_price, change_pct: pr.change_pct, vat_rate: p.vat_rate, currency: 'CZK', changed_at: pr.decided_at || pr.created_at });
    }
  } else {
    for (const p of st.products.filter((x) => x.active)) {
      const pr = latestApproved.get(p.id);
      rows.push({ proposal_id: pr ? pr.id : null, product_id: p.id, code: p.code, ean: p.ean, name: p.name, manufacturer: p.manufacturer, price: pr ? pr.manual_price ?? pr.new_price : p.price, old_price: pr ? pr.old_price : null, change_pct: pr ? pr.change_pct : null, vat_rate: p.vat_rate, currency: 'CZK', changed_at: pr ? pr.decided_at : p.price_changed_at });
    }
  }
  return rows;
}

const escXml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function rowsBody(st, rows, format) {
  const generated = iso(st.now());
  if (format === 'json') return { body: JSON.stringify({ generated, count: rows.length, currency: 'CZK', items: rows }, null, 2), type: 'application/json; charset=utf-8' };
  if (format === 'xml') {
    const tpl = st.settings.export.xml;
    const fields = Array.isArray(tpl.fields) ? tpl.fields : Object.keys(tpl.fields);
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<${tpl.root} generated="${generated}" count="${rows.length}" currency="CZK">`];
    for (const r of rows) {
      lines.push(`  <${tpl.item}>`);
      for (const f of fields) lines.push(`    <${f}>${escXml(r[f])}</${f}>`);
      lines.push(`  </${tpl.item}>`);
    }
    lines.push(`</${tpl.root}>`);
    return { body: lines.join('\n') + '\n', type: 'application/xml; charset=utf-8' };
  }
  const cols = ['code', 'ean', 'name', 'price', 'old_price', 'change_pct', 'vat_rate', 'currency', 'changed_at'];
  const q = (v) => {
    const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v ?? '');
    return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return { body: '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => q(r[c])).join(';'))].join('\r\n') + '\r\n', type: 'text/csv; charset=utf-8' };
}

function markExported(st, proposalIds, kind, target) {
  const now = iso(st.now());
  const exp = { id: st.nextId('exports'), created_at: now, kind, target, count: 0, status: 'ok', detail: null };
  for (const pr of st.proposals) {
    if (proposalIds.includes(pr.id) && pr.status === 'approved') {
      pr.status = 'exported';
      pr.exported_at = now;
      pr.export_id = exp.id;
      exp.count += 1;
      if (st.settings.export.update_current_price) {
        const p = st.products.find((x) => x.id === pr.product_id);
        if (p) {
          p.price = pr.manual_price ?? pr.new_price;
          p.price_changed_at = now;
        }
      }
    }
  }
  st.exports.push(exp);
  return exp;
}

function xlsxOrCsv(st, name, columns, rows) {
  try {
    const { writeXlsx } = require('../src/formats/xlsx.js');
    const buf = writeXlsx([{ name: 'Data', columns, rows }]);
    return { status: 200, headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${name}.xlsx"` }, body: buf };
  } catch {
    // modul formats zatím neexistuje → CSV se správnou příponou
    const q = (v) => (/[;"\n]/.test(String(v ?? '')) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v ?? ''));
    const body = '﻿' + [columns.map((c) => q(c.label)).join(';'), ...rows.map((r) => columns.map((c) => q(r[c.key])).join(';'))].join('\r\n');
    return { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"`, 'X-Mock-Note': 'xlsx-fallback-csv' }, body };
  }
}

// ------------------------------------------------------------------ pole a facety

const BASE_FIELDS = [
  ['code', 'Kód', 'string', 'Produkt'], ['name', 'Název', 'string', 'Produkt'], ['ean', 'EAN', 'string', 'Produkt'], ['mpn', 'Kód výrobce (MPN)', 'string', 'Produkt'],
  ['manufacturer', 'Výrobce', 'string', 'Produkt'], ['category', 'Kategorie', 'string', 'Produkt'], ['supplier', 'Dodavatel', 'string', 'Produkt'], ['owner', 'Zodpovědná osoba', 'string', 'Produkt'],
  ['active', 'Aktivní', 'boolean', 'Produkt'], ['locked', 'Zamčený', 'boolean', 'Produkt'], ['note', 'Poznámka', 'string', 'Produkt'],
  ['price', 'Prodejní cena', 'number', 'Ceny a marže'], ['purchase_price', 'Nákupní cena', 'number', 'Ceny a marže'], ['msrp', 'MOC', 'number', 'Ceny a marže'],
  ['vat_rate', 'Sazba DPH', 'number', 'Ceny a marže'], ['margin_pct', 'Marže %', 'number', 'Ceny a marže'], ['markup_pct', 'Přirážka %', 'number', 'Ceny a marže'],
  ['profit_abs', 'Zisk na kus (Kč)', 'number', 'Ceny a marže'], ['msrp_diff_pct', 'Rozdíl proti MOC %', 'number', 'Ceny a marže'], ['min_price', 'Min. cena produktu', 'number', 'Ceny a marže'], ['max_price', 'Max. cena produktu', 'number', 'Ceny a marže'],
  ['stock', 'Sklad (ks)', 'number', 'Sklad a prodeje'], ['stock_value', 'Hodnota skladu', 'number', 'Sklad a prodeje'], ['sales_30', 'Prodeje 30 dní', 'number', 'Sklad a prodeje'],
  ['sales_90', 'Prodeje 90 dní', 'number', 'Sklad a prodeje'], ['days_of_cover', 'Zásoba na dní', 'number', 'Sklad a prodeje'],
  ['market_count', 'Počet konkurentů', 'number', 'Trh'], ['market_min', 'Nejnižší cena trhu', 'number', 'Trh'], ['market_max', 'Nejvyšší cena trhu', 'number', 'Trh'],
  ['market_avg', 'Průměrná cena trhu', 'number', 'Trh'], ['market_median', 'Medián trhu', 'number', 'Trh'], ['cheapest_competitor', 'Nejlevnější konkurent', 'string', 'Trh'],
  ['rank', 'Pořadí (1 = nejlevnější)', 'number', 'Trh'], ['position', 'Pozice', 'enum', 'Trh'], ['price_index', 'Cenový index vs. min.', 'number', 'Trh'],
  ['price_index_median', 'Cenový index vs. medián', 'number', 'Trh'], ['gap_min_abs', 'Rozdíl od min. (Kč)', 'number', 'Trh'], ['gap_min_pct', 'Rozdíl od min. %', 'number', 'Trh'],
  ['offers_instock', 'Nabídek skladem', 'number', 'Trh'],
];

function fieldsList(st) {
  const out = BASE_FIELDS.map(([key, label, type, group]) => (type === 'enum' ? { key, label, type, group, values: ['cheapest', 'middle', 'most_expensive', 'no_data'] } : { key, label, type, group }));
  const attrTypes = new Map();
  for (const p of st.products) for (const [k, v] of Object.entries(p.attrs || {})) {
    const t = typeof v === 'number' ? 'number' : 'string';
    const prev = attrTypes.get(k);
    attrTypes.set(k, prev && prev !== t ? 'string' : t);
  }
  for (const [k, t] of attrTypes) out.push({ key: 'attrs.' + k, label: k, type: t, group: 'Atributy' });
  return out;
}

function facetList(values) {
  const m = new Map();
  for (const v of values) if (v != null && v !== '') m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value), 'cs'));
}

function facets(st) {
  const act = st.products.filter((p) => p.active);
  const attrs = {};
  const keys = new Set(act.flatMap((p) => Object.keys(p.attrs || {})));
  for (const k of keys) {
    const list = facetList(act.map((p) => p.attrs[k]));
    if (list.length <= 200) attrs[k] = list.slice(0, 50);
  }
  return {
    manufacturers: facetList(act.map((p) => p.manufacturer)),
    categories: facetList(act.map((p) => p.category)),
    owners: facetList(act.map((p) => p.owner)),
    suppliers: facetList(act.map((p) => p.supplier)),
    attrs,
  };
}

// ------------------------------------------------------------------ historie (generovaná na míru)

function historyFor(st, p) {
  const now = st.now();
  const rnd = mulberry32(p.id * 7919);
  const our = [];
  let t = now - 120 * DAY;
  let price = roundEnding(p.price * (1 + (rnd() - 0.3) * 0.12));
  const lastChange = p.price_changed_at ? new Date(p.price_changed_at).getTime() : now - 3 * DAY;
  while (t < lastChange - DAY) {
    our.push({ id: our.length + 1, product_id: p.id, price, source: our.length ? (rnd() < 0.7 ? 'export' : 'manual') : 'import', ref_id: null, at: iso(t) });
    t += (8 + rnd() * 25) * DAY;
    price = roundEnding(price * (1 + (rnd() - 0.55) * 0.08));
  }
  our.push({ id: our.length + 1, product_id: p.id, price: p.price, source: 'export', ref_id: null, at: iso(lastChange) });
  const comp = [];
  for (const o of productOffers(st, p.id)) {
    const c = st.competitors.find((x) => x.id === o.competitor_id);
    const r2 = mulberry32(p.id * 131 + o.competitor_id);
    let tt = new Date(o.first_seen_at).getTime();
    let pp = roundEnding(o.price * (1 + (r2() - 0.4) * 0.1));
    const pts = [];
    while (tt < new Date(o.observed_at).getTime() - DAY) {
      pts.push({ price: pp, in_stock: r2() < 0.85 ? 1 : 0, observed_at: iso(tt) });
      tt += (4 + r2() * 16) * DAY;
      pp = roundEnding(pp * (1 + (r2() - 0.55) * 0.07));
    }
    pts.push({ price: o.price, in_stock: o.in_stock, observed_at: o.observed_at });
    for (const x of pts) comp.push({ id: comp.length + 1, product_id: p.id, competitor_id: o.competitor_id, competitor: c ? c.name : null, ...x });
  }
  comp.sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  return { our: our.slice(-200), competitors: comp.slice(-500) };
}

// ------------------------------------------------------------------ API

function dashboard(st) {
  const views = allViews(st);
  const withMarket = views.filter((v) => v.market_count > 0);
  const pos = { cheapest: 0, middle: 0, most_expensive: 0, no_data: 0 };
  for (const v of views) pos[v.position] += 1;
  const pending = st.proposals.filter((p) => p.status === 'pending');
  const approved = st.proposals.filter((p) => p.status === 'approved');
  const active = [...pending, ...approved];
  const weekAgo = st.now() - 7 * DAY;
  const byComp = st.competitors.map((c) => {
    const offs = st.offers.filter((o) => o.competitor_id === c.id);
    const cheaper = offs.filter((o) => {
      const p = st.products.find((x) => x.id === o.product_id);
      return p && o.price < p.price;
    }).length;
    return { name: c.name, offers: offs.length, cheaper_than_us_pct: offs.length ? round((cheaper / offs.length) * 100, 1) : null };
  }).sort((a, b) => b.offers - a.offers).slice(0, 10);
  const manus = new Map();
  for (const v of views) {
    const m = manus.get(v.manufacturer) || { manufacturer: v.manufacturer, products: 0, idx: [], cheapest: 0, withMarket: 0, margins: [] };
    m.products += 1;
    if (v.price_index != null) m.idx.push(v.price_index);
    if (v.market_count) m.withMarket += 1;
    if (v.position === 'cheapest') m.cheapest += 1;
    if (v.margin_pct != null) m.margins.push(v.margin_pct);
    manus.set(v.manufacturer, m);
  }
  const byManufacturer = [...manus.values()].sort((a, b) => b.products - a.products).slice(0, 15).map((m) => ({
    manufacturer: m.manufacturer, products: m.products, avg_index: m.idx.length ? round(mean(m.idx), 1) : null,
    cheapest_pct: m.withMarket ? round((m.cheapest / m.withMarket) * 100, 1) : null, avg_margin_pct: m.margins.length ? round(mean(m.margins), 1) : null,
  }));
  const alerts = [];
  for (const v of views) {
    if (v.margin_pct != null && v.margin_pct < 0) alerts.push({ type: 'below_cost', text: `${v.code} ${v.name}: prodáváme pod nákupní cenou (marže ${String(v.margin_pct).replace('.', ',')} %)`, product_id: v.id });
  }
  const undercut = st.offers.filter((o) => o.prev_price && o.price < o.prev_price * 0.9 && o.changed_at && st.now() - new Date(o.changed_at).getTime() < DAY * 1.5).slice(0, 3);
  for (const o of undercut) {
    const p = st.products.find((x) => x.id === o.product_id);
    const c = st.competitors.find((x) => x.id === o.competitor_id);
    alerts.push({ type: 'undercut', text: `${c.name} zlevnil ${p.name} o ${Math.round((1 - o.price / o.prev_price) * 100)} % na ${money(o.price)}`, product_id: p.id });
  }
  if (alerts.length < 3) {
    const v = views.find((x) => x.position === 'most_expensive' && x.gap_min_pct > 8);
    if (v) alerts.push({ type: 'undercut', text: `${v.cheapest_competitor} je u ${v.name} o ${String(round(v.gap_min_pct, 1)).replace('.', ',')} % levnější než my`, product_id: v.id });
  }
  const stale = st.offers.filter((o) => (st.now() - new Date(o.observed_at).getTime()) / DAY > st.settings.offer_max_age_days).length;
  if (stale) alerts.push({ type: 'stale', text: `${stale} nabídek konkurence je starších než ${st.settings.offer_max_age_days} dní – zkontrolujte zdroj dat.` });
  const errSrc = st.sources.find((s) => s.last_status === 'error');
  if (errSrc) alerts.push({ type: 'import_error', text: `Zdroj „${errSrc.name}“ skončil chybou: ${errSrc.last_message}` });
  const lastRun = st.runs[st.runs.length - 1] || null;
  return {
    products: { active: views.length, with_market: withMarket.length, without_market: views.length - withMarket.length, locked: views.filter((v) => v.locked).length },
    position: pos,
    price_index: {
      vs_min: withMarket.length ? round(mean(withMarket.map((v) => v.price_index)), 1) : null,
      vs_median: withMarket.length ? round(mean(withMarket.map((v) => v.price_index_median)), 1) : null,
    },
    proposals: {
      pending: pending.length,
      approved: approved.length,
      exported_7d: st.proposals.filter((p) => p.status === 'exported' && new Date(p.exported_at).getTime() > weekAgo).length,
      up: active.filter((p) => p.change_abs > 0).length,
      down: active.filter((p) => p.change_abs < 0).length,
      avg_change_pct: active.length ? round(mean(active.map((p) => p.change_pct)), 2) : null,
      margin_impact_abs: round(active.reduce((s, p) => s + (net(p.manual_price ?? p.new_price, 21) - net(p.old_price, 21)), 0), 2),
    },
    last_run: lastRun ? { ...lastRun } : null,
    last_imports: st.imports.slice(-5).reverse(),
    competitors: byComp,
    by_manufacturer: byManufacturer,
    alerts: alerts.slice(0, 8),
  };
}

function productsList(st, q) {
  let views = allViews(st, { status: q.status || 'active' });
  const compiled = new Map();
  const f = (v) => fold(v);
  if (q.q) {
    const s = f(q.q);
    views = views.filter((v) => f(v.code).includes(s) || f(v.name).includes(s) || f(v.ean).includes(s));
  }
  for (const k of ['manufacturer', 'category', 'owner', 'supplier', 'position']) if (q[k]) views = views.filter((v) => f(v[k]) === f(q[k]));
  if (q.filter) {
    let flt;
    try {
      flt = JSON.parse(q.filter);
    } catch {
      throw new HttpError(400, 'Parametr filter není platný JSON.');
    }
    const fn = compileFilter(flt);
    views = views.filter(fn);
  }
  const withSeg = views.map((v) => ({ v, segments: segmentIdsFor(st, v, compiled) }));
  let list = withSeg;
  if (q.segment) list = list.filter((x) => x.segments.includes(Number(q.segment)));
  const propOf = (id) => {
    const pr = [...st.proposals].reverse().find((p) => p.product_id === id && (p.status === 'pending' || p.status === 'approved'));
    return pr ? { id: pr.id, status: pr.status, new_price: pr.manual_price ?? pr.new_price, change_pct: pr.change_pct } : null;
  };
  let items = list.map((x) => ({ ...x.v, proposal: propOf(x.v.id), segments: x.segments }));
  if (q.has_proposal === '1') items = items.filter((x) => x.proposal);
  const sort = q.sort || 'code';
  items = sortList(items, sort, q.dir === 'desc' ? 'desc' : 'asc', (o, k) => k.split('.').reduce((a, kk) => (a == null ? undefined : a[kk]), o));
  return paginate(items, q, 50, 500);
}

function productDetail(st, id) {
  const p = st.products.find((x) => x.id === id);
  if (!p) throw new HttpError(404, 'Produkt nenalezen.');
  const ctx = ctxOf(st);
  const ev = evaluate(st, ctx, p, new Map());
  const offersEngine = productOffers(st, p.id).map((o) => engineOffer(st, o));
  const m = buildMarket(offersEngine, { in_stock_only: st.settings.metrics_in_stock_only }, ctx);
  const exReason = new Map(m.excluded.map((x) => [x.offer.competitor_id, x.reason]));
  const offers = productOffers(st, p.id).map((o) => {
    const c = st.competitors.find((x) => x.id === o.competitor_id) || {};
    return { ...o, competitor: c.name, label: c.label, competitor_enabled: c.enabled, tags: c.tags, excluded: exReason.get(o.competitor_id) || null };
  }).sort((a, b) => a.price - b.price);
  return {
    product: ev.view,
    offers,
    history: historyFor(st, p),
    explain: {
      view: ev.view,
      segments: ev.segIds.map((sid) => ({ id: sid, name: st.segments.find((s) => s.id === sid)?.name })),
      strategy: ev.strategy ? clone(ev.strategy) : null,
      decision: ev.decision,
    },
    proposals: st.proposals.filter((x) => x.product_id === p.id).slice(-20).reverse().map((x) => proposalRow(st, x)),
  };
}

function segmentOut(st, s, withCount) {
  const out = { ...clone(s) };
  if (withCount) {
    try {
      const fn = compileFilter(s.filter);
      out.count = allViews(st).filter(fn).length;
    } catch {
      out.count = null;
    }
  }
  return out;
}

function validateStrategyBody(b) {
  const errors = [];
  if (!b.name || !String(b.name).trim()) errors.push('Název strategie je povinný.');
  const cfg = deepMerge(DEFAULT_CONFIG, b.config || {});
  if (cfg.limits.min_margin_pct != null && cfg.limits.min_margin_pct >= 100) errors.push('Minimální marže musí být menší než 100 %.');
  if (cfg.target.mode === 'competitor' && !cfg.target.competitor) errors.push('Režim „konkurent“ vyžaduje název konkurenta.');
  if (!['undercut_min', 'match_min', 'rank', 'market_avg', 'market_median', 'competitor', 'msrp', 'cost_plus', 'keep', 'fixed'].includes(cfg.target.mode)) errors.push('Neznámý režim cíle.');
  if (errors.length) throw new HttpError(400, 'Neplatná strategie', errors);
  return cfg;
}

const PRESETS = [
  { key: 'lezaky', name: 'Ležáky N7/N8 – doprodej', description: 'Produkty skladem déle než 7 měsíců podlézt o 1 % pod nejnižší cenu, marže stačí 3 %, snížení max. 15 % za běh.', segment: { name: 'Ležáky N7/N8', filter: { all: [{ field: 'attrs.N', op: 'in', value: ['N7', 'N8'] }] } }, config: deepMerge(DEFAULT_CONFIG, { target: { mode: 'undercut_min', offset_pct: -1 }, limits: { min_margin_pct: 3, max_decrease_pct: 15 } }) },
  { key: 'klicove-znacky', name: 'Klíčové značky – držet pozici 2', description: 'Být druhý nejlevnější, minimální marže 18 %, nikdy nad MOC.', segment: { name: 'Klíčové značky', filter: { all: [{ field: 'manufacturer', op: 'in', value: ['Trek', 'Specialized'] }] } }, config: deepMerge(DEFAULT_CONFIG, { target: { mode: 'rank', rank: 2 }, limits: { min_margin_pct: 18, max_above_msrp_pct: 0 } }) },
  { key: 'bez-konkurence', name: 'Bez konkurence → MOC', description: 'Kde produkt nikdo jiný nenabízí, nastavit doporučenou cenu výrobce.', segment: { name: 'Bez konkurence', filter: { all: [{ field: 'market_count', op: '=', value: 0 }] } }, config: deepMerge(DEFAULT_CONFIG, { target: { mode: 'msrp' } }) },
  { key: 'vychozi', name: 'Výchozí – medián trhu −2 %', description: 'Všechny produkty 2 % pod mediánem trhu, minimální marže 12 %, změny do 3 % schválit automaticky.', segment: null, config: deepMerge(DEFAULT_CONFIG, { target: { mode: 'market_median', offset_pct: -2 }, limits: { min_margin_pct: 12 }, approval: { auto: true, auto_max_change_pct: 3 } }) },
];

function toNumId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Neplatné ID.');
  return n;
}

function buildRoutes(st) {
  const R = [];
  const add = (method, pattern, handler, auth = 'read') => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    R.push({ method, re, keys, handler, auth });
  };
  const audit = (ctx, action, entity, entity_id, detail) => st.audit.push({ id: st.nextId('audit'), at: iso(st.now()), actor: ctx.user, action, entity, entity_id, detail: detail ? JSON.stringify(detail) : null });

  add('GET', '/health', () => ({ ok: true, version: VERSION, time: iso(st.now()) }), 'public');
  add('POST', '/auth/login', (ctx) => {
    if (!ctx.body || ctx.body.password !== st.password) throw new HttpError(401, 'Nesprávné heslo.');
    const sid = crypto.randomBytes(12).toString('hex');
    st.sessions.add(sid);
    ctx.setCookie = `ct_session=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1209600`;
    return { ok: true };
  }, 'public');
  add('POST', '/auth/logout', (ctx) => {
    if (ctx.sid) st.sessions.delete(ctx.sid);
    ctx.setCookie = 'ct_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
    return { ok: true };
  }, 'public');
  add('GET', '/auth/me', (ctx) => ({ user: ctx.user, scopes: ctx.scopes, via: ctx.via }));
  add('GET', '/dashboard', () => dashboard(st));
  add('GET', '/fields', () => ({ fields: fieldsList(st) }));
  add('GET', '/products', (ctx) => productsList(st, ctx.query));
  add('GET', '/products/facets', () => facets(st));
  add('GET', '/products/:id', (ctx) => productDetail(st, toNumId(ctx.params.id)));
  add('PATCH', '/products/:id', (ctx) => {
    const p = st.products.find((x) => x.id === toNumId(ctx.params.id));
    if (!p) throw new HttpError(404, 'Produkt nenalezen.');
    const b = ctx.body || {};
    for (const k of ['min_price', 'max_price', 'price']) if (b[k] !== undefined && b[k] !== null && !(typeof b[k] === 'number' && b[k] > 0)) throw new HttpError(400, `Pole ${k} musí být kladné číslo nebo null.`);
    if (b.min_price != null && b.max_price != null && b.min_price > b.max_price) throw new HttpError(400, 'Minimální cena je vyšší než maximální.');
    if (b.locked !== undefined) p.locked = b.locked ? 1 : 0;
    if (b.min_price !== undefined) p.min_price = b.min_price;
    if (b.max_price !== undefined) p.max_price = b.max_price;
    if (b.note !== undefined) p.note = b.note || null;
    if (b.price != null && b.price !== p.price) {
      p.price = b.price;
      p.price_changed_at = iso(st.now());
    }
    p.updated_at = iso(st.now());
    audit(ctx, 'product.update', 'product', p.id, b);
    return productView(st, p, ctxOf(st));
  }, 'admin');

  add('GET', '/competitors', () => ({
    items: st.competitors.map((c) => {
      const offs = st.offers.filter((o) => o.competitor_id === c.id);
      const idx = [];
      let cheaper = 0;
      for (const o of offs) {
        const p = st.products.find((x) => x.id === o.product_id);
        if (!p || !p.price) continue;
        idx.push((o.price / p.price) * 100);
        if (o.price < p.price) cheaper += 1;
      }
      return { id: c.id, name: c.name, label: c.label, enabled: c.enabled, tags: [...c.tags], note: c.note, offers: offs.length, products_cheaper_than_us: cheaper, avg_index: idx.length ? round(mean(idx), 1) : null, last_seen_at: offs.length ? offs.map((o) => o.observed_at).sort().pop() : null };
    }),
  }));
  add('PATCH', '/competitors/:id', (ctx) => {
    const c = st.competitors.find((x) => x.id === toNumId(ctx.params.id));
    if (!c) throw new HttpError(404, 'Konkurent nenalezen.');
    const b = ctx.body || {};
    if (b.label !== undefined) c.label = b.label || null;
    if (b.enabled !== undefined) c.enabled = b.enabled ? 1 : 0;
    if (b.tags !== undefined) {
      if (!Array.isArray(b.tags)) throw new HttpError(400, 'Štítky musí být pole řetězců.');
      c.tags = b.tags.map(String).map((s) => s.trim()).filter(Boolean);
    }
    if (b.note !== undefined) c.note = b.note || null;
    audit(ctx, 'competitor.update', 'competitor', c.id, b);
    const out = { ...c };
    delete out._share;
    delete out._bias;
    return out;
  }, 'admin');

  // segmenty
  add('GET', '/segments', (ctx) => paginate(st.segments.map((s) => segmentOut(st, s, true)), { ...ctx.query, limit: ctx.query.limit || 500 }, 500));
  add('POST', '/segments/preview', (ctx) => {
    const filter = ctx.body?.filter ?? {};
    let fn;
    try {
      fn = compileFilter(filter);
    } catch (e) {
      return { count: 0, sample: [], errors: [e.message] };
    }
    const list = allViews(st).filter(fn);
    return { count: list.length, sample: list.slice(0, 20), errors: [] };
  });
  add('POST', '/segments', (ctx) => {
    const b = ctx.body || {};
    if (!b.name || !String(b.name).trim()) throw new HttpError(400, 'Název segmentu je povinný.');
    compileFilter(b.filter || {});
    const s = { id: st.nextId('segments'), name: String(b.name).trim(), description: b.description || null, filter: b.filter || {}, color: b.color || null, created_at: iso(st.now()), updated_at: iso(st.now()) };
    st.segments.push(s);
    audit(ctx, 'segment.create', 'segment', s.id);
    return segmentOut(st, s, true);
  }, 'admin');
  add('GET', '/segments/:id', (ctx) => {
    const s = st.segments.find((x) => x.id === toNumId(ctx.params.id));
    if (!s) throw new HttpError(404, 'Segment nenalezen.');
    return segmentOut(st, s, true);
  });
  add('PUT', '/segments/:id', (ctx) => {
    const s = st.segments.find((x) => x.id === toNumId(ctx.params.id));
    if (!s) throw new HttpError(404, 'Segment nenalezen.');
    const b = ctx.body || {};
    if (b.name !== undefined && !String(b.name).trim()) throw new HttpError(400, 'Název segmentu je povinný.');
    if (b.filter !== undefined) compileFilter(b.filter);
    for (const k of ['name', 'description', 'filter', 'color']) if (b[k] !== undefined) s[k] = b[k];
    s.updated_at = iso(st.now());
    audit(ctx, 'segment.update', 'segment', s.id);
    return segmentOut(st, s, true);
  }, 'admin');
  add('DELETE', '/segments/:id', (ctx) => {
    const id = toNumId(ctx.params.id);
    const used = st.strategies.filter((x) => x.segment_id === id);
    if (used.length) throw new HttpError(409, `Segment používá strategie „${used.map((x) => x.name).join('“, „')}“ – nejdřív ji upravte nebo smažte.`);
    const i = st.segments.findIndex((x) => x.id === id);
    if (i < 0) throw new HttpError(404, 'Segment nenalezen.');
    st.segments.splice(i, 1);
    audit(ctx, 'segment.delete', 'segment', id);
    return { ok: true };
  }, 'admin');

  // strategie (s rozšířeními enginu jen při --extensions)
  const extCfg = (cfg) => (st.extensions ? deepMerge(deepMerge(DEFAULT_CONFIG, EXTENSION_DEFAULTS), cfg) : clone(cfg));
  const stratOut = (s) => ({ ...clone(s), config: extCfg(s.config) });
  add('GET', '/strategies', (ctx) => paginate([...st.strategies].sort((a, b) => a.priority - b.priority || a.id - b.id).map(stratOut), { ...ctx.query, limit: ctx.query.limit || 500 }, 500));
  add('GET', '/strategies/presets', () => ({ items: PRESETS.map((p) => ({ ...clone(p), config: extCfg(p.config) })) }));
  add('POST', '/strategies/presets/:key', (ctx) => {
    const pr = PRESETS.find((x) => x.key === ctx.params.key);
    if (!pr) throw new HttpError(404, 'Předvolba nenalezena.');
    let segment = null;
    if (pr.segment) {
      segment = { id: st.nextId('segments'), name: pr.segment.name + (st.segments.some((x) => x.name === pr.segment.name) ? ' (' + st.seq.segments + ')' : ''), description: pr.description, filter: clone(pr.segment.filter), color: '#4a3aa7', created_at: iso(st.now()), updated_at: iso(st.now()) };
      st.segments.push(segment);
    }
    const s = { id: st.nextId('strategies'), name: pr.name, description: pr.description, segment_id: segment ? segment.id : null, priority: Math.max(0, ...st.strategies.map((x) => x.priority)) + 10, enabled: 0, config: clone(pr.config), created_at: iso(st.now()), updated_at: iso(st.now()) };
    st.strategies.push(s);
    audit(ctx, 'strategy.preset', 'strategy', s.id, { key: pr.key });
    return { strategy: stratOut(s), segment: segment ? segmentOut(st, segment, true) : null };
  }, 'admin');
  add('POST', '/strategies/reorder', (ctx) => {
    const ids = ctx.body?.ids;
    if (!Array.isArray(ids)) throw new HttpError(400, 'Očekáváno pole ids.');
    ids.forEach((id, i) => {
      const s = st.strategies.find((x) => x.id === Number(id));
      if (s) s.priority = (i + 1) * 10;
    });
    audit(ctx, 'strategy.reorder', 'strategy', null, { ids });
    return { ok: true, items: [...st.strategies].sort((a, b) => a.priority - b.priority).map(stratOut) };
  }, 'admin');
  add('POST', '/strategies', (ctx) => {
    const b = ctx.body || {};
    const config = validateStrategyBody(b);
    const s = { id: st.nextId('strategies'), name: String(b.name).trim(), description: b.description || null, segment_id: b.segment_id ?? null, priority: b.priority ?? Math.max(0, ...st.strategies.map((x) => x.priority)) + 10, enabled: b.enabled === false || b.enabled === 0 ? 0 : 1, config, created_at: iso(st.now()), updated_at: iso(st.now()) };
    st.strategies.push(s);
    audit(ctx, 'strategy.create', 'strategy', s.id);
    return stratOut(s);
  }, 'admin');
  add('GET', '/strategies/:id', (ctx) => {
    const s = st.strategies.find((x) => x.id === toNumId(ctx.params.id));
    if (!s) throw new HttpError(404, 'Strategie nenalezena.');
    return stratOut(s);
  });
  add('PUT', '/strategies/:id', (ctx) => {
    const s = st.strategies.find((x) => x.id === toNumId(ctx.params.id));
    if (!s) throw new HttpError(404, 'Strategie nenalezena.');
    const b = { ...stratOut(s), ...(ctx.body || {}) };
    const config = validateStrategyBody(b);
    Object.assign(s, { name: String(b.name).trim(), description: b.description || null, segment_id: b.segment_id ?? null, priority: b.priority ?? s.priority, enabled: b.enabled ? 1 : 0, config, updated_at: iso(st.now()) });
    audit(ctx, 'strategy.update', 'strategy', s.id);
    return stratOut(s);
  }, 'admin');
  add('DELETE', '/strategies/:id', (ctx) => {
    const id = toNumId(ctx.params.id);
    const i = st.strategies.findIndex((x) => x.id === id);
    if (i < 0) throw new HttpError(404, 'Strategie nenalezena.');
    st.strategies.splice(i, 1);
    audit(ctx, 'strategy.delete', 'strategy', id);
    return { ok: true };
  }, 'admin');

  add('POST', '/simulate', (ctx) => {
    const b = ctx.body || {};
    const config = deepMerge(DEFAULT_CONFIG, b.config || {});
    if (config.limits.min_margin_pct != null && config.limits.min_margin_pct >= 100) throw new HttpError(400, 'Neplatná konfigurace', ['Minimální marže musí být menší než 100 %.']);
    let fn = () => true;
    if (b.segment_id) {
      const s = st.segments.find((x) => x.id === Number(b.segment_id));
      if (!s) throw new HttpError(404, 'Segment nenalezen.');
      fn = compileFilter(s.filter);
    } else if (b.filter) fn = compileFilter(b.filter);
    const ctxE = ctxOf(st);
    const stats = emptyStats();
    const decisions = [];
    const strategy = { id: null, name: 'Simulace', segment_id: b.segment_id ?? null, config };
    const limit = Math.min(1000, Number(b.limit) || 200);
    for (const p of st.products.filter((x) => x.active)) {
      const v = productView(st, p, ctxE);
      if (!fn(v)) continue;
      stats.products += 1;
      const d = decide(st, p, productOffers(st, p.id).map((o) => engineOffer(st, o)), strategy, ctxE);
      addStats(stats, d, { id: 'sim', name: 'Simulace' }, p, p.vat_rate ?? 21);
      if (d.action !== 'no_change' && decisions.length < limit) decisions.push(d);
    }
    stats.margin_impact_abs = round(stats.margin_impact_abs, 2);
    return { stats, decisions };
  });

  add('POST', '/runs', (ctx) => {
    const ids = Array.isArray(ctx.body?.product_ids) ? ctx.body.product_ids.map(Number) : undefined;
    const run = doRun(st, { trigger: 'manual', productIds: ids });
    audit(ctx, 'run.manual', 'run', run.id);
    return { run_id: run.id, stats: run.stats };
  }, 'admin');
  add('GET', '/runs', (ctx) => paginate([...st.runs].reverse().map(clone), ctx.query, 50));
  add('GET', '/runs/:id', (ctx) => {
    const r = st.runs.find((x) => x.id === toNumId(ctx.params.id));
    if (!r) throw new HttpError(404, 'Běh nenalezen.');
    return clone(r);
  });

  // návrhy
  add('GET', '/proposals', (ctx) => {
    const q = ctx.query;
    const list = filterProposals(st, q);
    const sort = q.sort || 'abs_change_pct';
    const dir = q.dir || (q.sort ? 'asc' : 'desc');
    const getter = (pr, k) => {
      if (k === 'abs_change_pct') return pr.change_pct == null ? null : Math.abs(pr.change_pct);
      if (k === 'code' || k === 'name' || k === 'manufacturer') return st.products.find((x) => x.id === pr.product_id)?.[k];
      return pr[k];
    };
    const sorted = sortList(list, sort, dir, getter);
    const page = paginate(sorted, q, 50, 500);
    const today = new Date(st.now()).toISOString().slice(0, 10);
    return {
      ...page,
      items: page.items.map((p) => proposalRow(st, p)),
      summary: {
        pending: st.proposals.filter((p) => p.status === 'pending').length,
        approved: st.proposals.filter((p) => p.status === 'approved').length,
        exported_today: st.proposals.filter((p) => p.status === 'exported' && (p.exported_at || '').startsWith(today)).length,
        up: list.filter((p) => p.change_abs > 0).length,
        down: list.filter((p) => p.change_abs < 0).length,
      },
    };
  });
  const decideProposals = (ctx, status) => {
    const b = ctx.body || {};
    let targets;
    if (b.all) targets = filterProposals(st, { ...(b.filter || {}), status: 'pending' });
    else if (Array.isArray(b.ids)) targets = st.proposals.filter((p) => b.ids.map(Number).includes(p.id) && p.status === 'pending');
    else throw new HttpError(400, 'Zadejte ids nebo all.');
    const now = iso(st.now());
    for (const p of targets) {
      p.status = status;
      p.decided_at = now;
      p.decided_by = ctx.user;
    }
    audit(ctx, 'proposals.' + (status === 'approved' ? 'approve' : 'reject'), 'proposal', null, { count: targets.length });
    return { updated: targets.length };
  };
  add('POST', '/proposals/approve', (ctx) => decideProposals(ctx, 'approved'), 'admin');
  add('POST', '/proposals/reject', (ctx) => decideProposals(ctx, 'rejected'), 'admin');
  add('PATCH', '/proposals/:id', (ctx) => {
    const p = st.proposals.find((x) => x.id === toNumId(ctx.params.id));
    if (!p) throw new HttpError(404, 'Návrh nenalezen.');
    const mp = ctx.body?.manual_price;
    if (mp !== null && !(typeof mp === 'number' && mp > 0)) throw new HttpError(400, 'Ruční cena musí být kladné číslo (null ruší).');
    if (!['pending', 'approved'].includes(p.status)) throw new HttpError(409, 'Návrh už nelze upravit (stav ' + p.status + ').');
    p.manual_price = mp;
    audit(ctx, 'proposal.manual_price', 'proposal', p.id, { manual_price: mp });
    return proposalRow(st, p);
  }, 'admin');

  // import
  const parseMapping = (ctx) => {
    if (ctx.query.source) {
      const s = st.sources.find((x) => x.id === Number(ctx.query.source));
      if (!s) throw new HttpError(404, 'Zdroj nenalezen.');
      return { mapping: s.mapping || {}, source: s };
    }
    if (ctx.query.mapping) {
      try {
        return { mapping: JSON.parse(ctx.query.mapping) };
      } catch {
        throw new HttpError(400, 'Parametr mapping není platný JSON.');
      }
    }
    return { mapping: {} };
  };
  add('POST', '/import/preview', (ctx) => {
    const kind = ctx.query.kind === 'products' ? 'products' : ctx.query.kind === 'offers' ? 'offers' : null;
    if (!kind) throw new HttpError(400, 'Parametr kind musí být offers nebo products.');
    if (!ctx.rawBody || !ctx.rawBody.length) throw new HttpError(400, 'Prázdné tělo požadavku – pošlete soubor.');
    const { mapping } = parseMapping(ctx);
    const ex = extract(ctx.rawBody, mapping);
    const suggested = suggestMapping(ex.headers, kind);
    const errors = [];
    const canonical = ex.records.slice(0, 10).map((r, i) => {
      const res = applyMapping(r, mapping, kind);
      if (res.errors.length) errors.push({ row: i + 1, message: res.errors.join('; ') });
      return res.value;
    });
    return { format: ex.format, itemPath: ex.itemPath, headers: ex.headers, suggested, sample: ex.records.slice(0, 10), canonical, errors };
  }, 'import');
  const importHandler = (kind) => (ctx) => {
    const { mapping, source } = parseMapping(ctx);
    const dryRun = ctx.query.dry_run === '1' || ctx.query.dry_run === 'true';
    let canonicalItems = null;
    if (kind === 'offers' && ctx.isJson && ctx.body) {
      if (Array.isArray(ctx.body) && !ctx.query.mapping && !ctx.query.source) canonicalItems = ctx.body;
      else if (Array.isArray(ctx.body.items) && !ctx.query.mapping && !ctx.query.source) canonicalItems = ctx.body.items;
    }
    if (!canonicalItems && (!ctx.rawBody || !ctx.rawBody.length)) throw new HttpError(400, 'Prázdné tělo požadavku.');
    return runImportMock(st, kind, ctx.rawBody, mapping, { dryRun, canonicalItems, sourceId: source?.id, origin: ctx.via === 'token' ? 'api' : 'upload' });
  };
  add('POST', '/import/offers', importHandler('offers'), 'import');
  add('POST', '/import/products', importHandler('products'), 'import');
  add('GET', '/imports', () => ({ items: [...st.imports].reverse().slice(0, 100).map((x) => ({ ...clone(x), source_name: st.sources.find((s) => s.id === x.source_id)?.name || null })), total: Math.min(100, st.imports.length), page: 1, limit: 100 }));

  const sourceBody = (b, prev = {}) => {
    const out = { ...prev };
    for (const k of ['name', 'kind', 'url', 'method', 'headers', 'mapping', 'options', 'interval_minutes', 'enabled']) if (b[k] !== undefined) out[k] = b[k];
    if (!out.name || !String(out.name).trim()) throw new HttpError(400, 'Název zdroje je povinný.');
    if (!['offers', 'products'].includes(out.kind)) throw new HttpError(400, 'Druh zdroje musí být offers nebo products.');
    if (out.url && !/^https?:\/\//i.test(out.url)) throw new HttpError(400, 'URL musí začínat http:// nebo https://');
    out.enabled = out.enabled === false || out.enabled === 0 ? 0 : 1;
    out.interval_minutes = Number(out.interval_minutes) || 0;
    out.method = out.method || 'GET';
    out.headers = out.headers || {};
    out.mapping = out.mapping || {};
    out.options = out.options || {};
    return out;
  };
  add('GET', '/sources', (ctx) => paginate(st.sources.map(clone), { ...ctx.query, limit: 500 }, 500));
  add('POST', '/sources', (ctx) => {
    const s = { id: st.nextId('sources'), ...sourceBody(ctx.body || {}), last_run_at: null, last_status: null, last_message: null, created_at: iso(st.now()), updated_at: iso(st.now()) };
    st.sources.push(s);
    audit(ctx, 'source.create', 'source', s.id);
    return clone(s);
  }, 'admin');
  add('GET', '/sources/:id', (ctx) => {
    const s = st.sources.find((x) => x.id === toNumId(ctx.params.id));
    if (!s) throw new HttpError(404, 'Zdroj nenalezen.');
    return clone(s);
  });
  add('PUT', '/sources/:id', (ctx) => {
    const s = st.sources.find((x) => x.id === toNumId(ctx.params.id));
    if (!s) throw new HttpError(404, 'Zdroj nenalezen.');
    Object.assign(s, sourceBody(ctx.body || {}, s), { updated_at: iso(st.now()) });
    return clone(s);
  }, 'admin');
  add('DELETE', '/sources/:id', (ctx) => {
    const i = st.sources.findIndex((x) => x.id === toNumId(ctx.params.id));
    if (i < 0) throw new HttpError(404, 'Zdroj nenalezen.');
    st.sources.splice(i, 1);
    return { ok: true };
  }, 'admin');
  add('POST', '/sources/:id/run', (ctx) => {
    const s = st.sources.find((x) => x.id === toNumId(ctx.params.id));
    if (!s) throw new HttpError(404, 'Zdroj nenalezen.');
    if (!s.url) throw new HttpError(400, 'Zdroj nemá URL – data do něj posílejte přes API nebo nahráním souboru.');
    const now = iso(st.now());
    const stats = s.kind === 'offers' ? { received: 405, matched: 397, unmatched: 8, ambiguous: 0, created: 0, updated: 12, unchanged: 385, stale: 0, duplicates: 2, removed: 0, competitors_created: 0, errors: [] } : { received: 112, created: 0, updated: 2, unchanged: 110, deactivated: 0, errors: [] };
    const id = st.nextId('imports');
    st.imports.push({ id, source_id: s.id, kind: s.kind, format: s.kind === 'offers' ? 'xml' : 'csv', origin: 'manual', started_at: now, finished_at: now, status: 'ok', stats, error: null });
    Object.assign(s, { last_run_at: now, last_status: 'ok', last_message: `${stats.received} přijato, ${stats.updated} aktualizováno` });
    return { import_id: id, stats };
  }, 'admin');

  add('GET', '/unmatched', (ctx) => {
    let list = st.unmatched;
    if (ctx.query.competitor) list = list.filter((u) => String(u.competitor_id) === String(ctx.query.competitor) || fold(st.competitors.find((c) => c.id === u.competitor_id)?.name) === fold(ctx.query.competitor));
    if (ctx.query.q) {
      const f = fold(ctx.query.q);
      list = list.filter((u) => fold(u.name).includes(f) || fold(u.ean).includes(f) || fold(u.mpn).includes(f));
    }
    const page = paginate([...list].sort((a, b) => b.seen_count - a.seen_count), ctx.query, 50);
    return { ...page, items: page.items.map((u) => ({ ...u, competitor: st.competitors.find((c) => c.id === u.competitor_id)?.name || null })) };
  });
  add('POST', '/unmatched/:id/match', (ctx) => {
    const id = toNumId(ctx.params.id);
    const i = st.unmatched.findIndex((x) => x.id === id);
    if (i < 0) throw new HttpError(404, 'Nespárovaná nabídka nenalezena.');
    const p = st.products.find((x) => x.id === Number(ctx.body?.product_id));
    if (!p) throw new HttpError(400, 'Produkt nenalezen.');
    const u = st.unmatched[i];
    st.unmatched.splice(i, 1);
    st.offers = st.offers.filter((o) => !(o.product_id === p.id && o.competitor_id === u.competitor_id));
    st.offers.push({ product_id: p.id, competitor_id: u.competitor_id, price: u.price, shipping: null, in_stock: 1, delivery_days: 0, url: u.url, name: u.name, observed_at: u.last_seen_at, first_seen_at: u.first_seen_at, prev_price: null, changed_at: null, source_id: null });
    audit(ctx, 'unmatched.match', 'product', p.id, { unmatched_id: id });
    return { ok: true };
  }, 'admin');
  add('DELETE', '/unmatched/:id', (ctx) => {
    const i = st.unmatched.findIndex((x) => x.id === toNumId(ctx.params.id));
    if (i < 0) throw new HttpError(404, 'Nespárovaná nabídka nenalezena.');
    st.unmatched.splice(i, 1);
    return { ok: true };
  }, 'admin');

  // export
  add('GET', '/export/changes\\.(json|xml|csv)', (ctx) => {
    const format = ctx.params[0];
    const rows = exportRows(st, 'approved');
    const { body, type } = rowsBody(st, rows, format);
    const headers = { 'Content-Type': type };
    if (ctx.query.mark === '1') {
      const exp = markExported(st, rows.map((r) => r.proposal_id), 'feed', 'changes.' + format);
      headers['X-Export-Id'] = String(exp.id);
    }
    return { status: 200, headers, body };
  }, 'export');
  add('POST', '/export/ack', (ctx) => {
    const b = ctx.body || {};
    let ids = Array.isArray(b.proposal_ids) ? b.proposal_ids.map(Number) : [];
    if (Array.isArray(b.codes)) {
      const keys = new Set(b.codes.map(codeKey));
      for (const pr of st.proposals) if (pr.status === 'approved' && keys.has(st.products.find((p) => p.id === pr.product_id)?.code_key)) ids.push(pr.id);
    }
    if (!ids.length) throw new HttpError(400, 'Zadejte proposal_ids nebo codes.');
    const exp = markExported(st, ids, 'ack', 'api');
    return { export_id: exp.id, count: exp.count };
  }, 'export');
  add('GET', '/export/pohoda\\.xml', (ctx) => {
    const rows = exportRows(st, ctx.query.scope === 'all' ? 'all' : 'approved');
    const pc = st.settings.export.pohoda;
    const items = rows.map((r, i) => `  <dat:dataPackItem version="2.0" id="${i + 1}">\n    <stk:stock version="2.0">\n      <stk:actionType><stk:update><ftr:filter><ftr:${pc.filter_by === 'ean' ? 'EAN' : 'code'}>${escXml(pc.filter_by === 'ean' ? r.ean : r.code)}</ftr:${pc.filter_by === 'ean' ? 'EAN' : 'code'}></ftr:filter></stk:update></stk:actionType>\n      <stk:stockHeader><stk:sellingPrice payVAT="true">${r.price}</stk:sellingPrice></stk:stockHeader>\n    </stk:stock>\n  </dat:dataPackItem>`).join('\n');
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<dat:dataPack version="2.0" id="cenotvorba" ico="${escXml(pc.ico)}" application="${escXml(pc.application)}" note="Mock export" xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd" xmlns:stk="http://www.stormware.cz/schema/version_2/stock.xsd" xmlns:ftr="http://www.stormware.cz/schema/version_2/filter.xsd">\n${items}\n</dat:dataPack>\n`;
    const headers = { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': 'attachment; filename="pohoda-ceny.xml"' };
    if (ctx.query.mark === '1') headers['X-Export-Id'] = String(markExported(st, rows.map((r) => r.proposal_id).filter(Boolean), 'pohoda', 'pohoda.xml').id);
    return { status: 200, headers, body };
  }, 'export');
  add('GET', '/export/proposals\\.xlsx', (ctx) => {
    const list = filterProposals(st, ctx.query).map((p) => proposalRow(st, p));
    const rows = list.map((p) => ({ code: p.product.code, name: p.product.name, manufacturer: p.product.manufacturer, segment: p.segment_name, strategy: p.strategy_name, old_price: p.old_price, new_price: p.manual_price ?? p.new_price, change_pct: p.change_pct, margin_before: p.margin_before, margin_after: p.margin_after, market_min: p.market_min, status: p.status, flags: p.flags.join(', ') }));
    return xlsxOrCsv(st, 'navrhy-cen', [
      { key: 'code', label: 'Kód' }, { key: 'name', label: 'Název' }, { key: 'manufacturer', label: 'Výrobce' }, { key: 'segment', label: 'Segment' }, { key: 'strategy', label: 'Strategie' },
      { key: 'old_price', label: 'Stará cena', type: 'money' }, { key: 'new_price', label: 'Nová cena', type: 'money' }, { key: 'change_pct', label: 'Změna %', type: 'percent' },
      { key: 'margin_before', label: 'Marže před', type: 'percent' }, { key: 'margin_after', label: 'Marže po', type: 'percent' }, { key: 'market_min', label: 'Min. trh', type: 'money' },
      { key: 'status', label: 'Stav' }, { key: 'flags', label: 'Příznaky' },
    ], rows);
  });
  add('GET', '/export/pricelist\\.(json|xml|csv|xlsx)', (ctx) => {
    const format = ctx.params[0];
    const rows = exportRows(st, 'all');
    if (format === 'xlsx') return xlsxOrCsv(st, 'cenik', [{ key: 'code', label: 'Kód' }, { key: 'ean', label: 'EAN' }, { key: 'name', label: 'Název' }, { key: 'price', label: 'Cena', type: 'money' }, { key: 'vat_rate', label: 'DPH', type: 'number' }], rows);
    const { body, type } = rowsBody(st, rows, format);
    return { status: 200, headers: { 'Content-Type': type }, body };
  }, 'export');
  add('POST', '/export/push', (ctx) => {
    const wh = st.settings.export.webhook;
    if (!wh.url) throw new HttpError(400, 'Webhook není nastaven – zadejte URL v Nastavení → Export.');
    const rows = exportRows(st, 'approved');
    if (!rows.length) return { ok: true, status: 204, body: '', duration_ms: 0, export_id: null, count: 0 };
    const exp = markExported(st, rows.map((r) => r.proposal_id), 'webhook', wh.url);
    exp.detail = 'HTTP 200 za 287 ms';
    audit(ctx, 'export.push', 'export', exp.id);
    return { ok: true, status: 200, body: '{"ok":true,"received":' + rows.length + '}', duration_ms: 287, export_id: exp.id, count: exp.count };
  }, 'export');
  add('GET', '/exports', () => ({ items: [...st.exports].reverse().slice(0, 100).map(clone), total: st.exports.length, page: 1, limit: 100 }));

  add('GET', '/settings', () => clone(st.settings));
  add('PUT', '/settings', (ctx) => {
    const b = ctx.body;
    if (!isPlain(b)) throw new HttpError(400, 'Očekáván objekt nastavení.');
    for (const k of Object.keys(b)) if (k.startsWith('_')) throw new HttpError(400, 'Interní klíče nelze měnit.');
    if (b.vat_rate_default != null && !(b.vat_rate_default >= 0 && b.vat_rate_default < 100)) throw new HttpError(400, 'Sazba DPH musí být 0–99 %.');
    if (b.export?.webhook?.url && !/^https?:\/\//.test(b.export.webhook.url)) throw new HttpError(400, 'URL webhooku musí začínat http:// nebo https://');
    st.settings = deepMerge(st.settings, b);
    audit(ctx, 'settings.update', 'settings', null);
    return clone(st.settings);
  }, 'admin');
  add('POST', '/settings/password', (ctx) => {
    const b = ctx.body || {};
    if (b.current !== st.password) throw new HttpError(400, 'Současné heslo nesouhlasí.');
    if (!b.new || String(b.new).length < 8) throw new HttpError(400, 'Nové heslo musí mít alespoň 8 znaků.');
    st.password = String(b.new);
    return { ok: true };
  }, 'admin');
  add('GET', '/tokens', () => ({ items: st.tokens.map(({ _token, ...t }) => clone(t)) }), 'admin');
  add('POST', '/tokens', (ctx) => {
    const b = ctx.body || {};
    if (!b.name || !String(b.name).trim()) throw new HttpError(400, 'Název tokenu je povinný.');
    const scopes = Array.isArray(b.scopes) ? b.scopes.filter((s) => ['read', 'import', 'export', 'admin'].includes(s)) : [];
    if (!scopes.length) throw new HttpError(400, 'Vyberte alespoň jedno oprávnění.');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const token = 'ct_' + Array.from(crypto.randomBytes(32), (x) => alphabet[x % 62]).join('');
    const t = { id: st.nextId('tokens'), name: String(b.name).trim(), prefix: token.slice(0, 7), scopes, created_at: iso(st.now()), last_used_at: null, _token: token };
    st.tokens.push(t);
    audit(ctx, 'token.create', 'token', t.id);
    return { id: t.id, token, prefix: t.prefix, scopes };
  }, 'admin');
  add('DELETE', '/tokens/:id', (ctx) => {
    const i = st.tokens.findIndex((x) => x.id === toNumId(ctx.params.id));
    if (i < 0) throw new HttpError(404, 'Token nenalezen.');
    st.tokens.splice(i, 1);
    return { ok: true };
  }, 'admin');
  add('GET', '/audit', () => ({ items: [...st.audit].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200) }), 'admin');
  return R;
}

// ------------------------------------------------------------------ HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
}

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sendJson(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function readBody(req, max = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, 'Tělo požadavku je příliš velké.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(publicDir, urlPath, res) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir + path.sep) && file !== publicDir) return false;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Length': stat.size });
  fs.createReadStream(file).pipe(res);
  return true;
}

/**
 * Spustí mock server.
 * @param {{port?: number, host?: string, latency?: number, password?: string, autologin?: boolean, publicDir?: string, now?: string|Date, log?: Function, extensions?: boolean}} [opts]
 *   extensions = vracet konfiguraci strategií včetně rozšíření enginu (schedule, conditions, clearance, exclude_keywords)
 * @returns {Promise<{server: http.Server, url: string, port: number, state: object, close: () => Promise<void>}>}
 */
function createMockServer(opts = {}) {
  const publicDir = path.resolve(opts.publicDir || path.join(__dirname, '..', 'public'));
  const st = createState({ password: opts.password, now: opts.now, extensions: opts.extensions });
  const routes = buildRoutes(st);
  const latency = Number(opts.latency) || 0;
  const log = opts.log || (() => {});

  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      const isApi = p.startsWith('/api/v1/');
      const feed = /^\/feed\/(changes|prices)\.(xml|json|csv)$/.exec(p);
      if (!isApi && !feed) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Metoda není povolena.');
        if (serveStatic(publicDir, p, res)) return;
        if (p.startsWith('/api/')) throw new HttpError(404, 'Neznámý endpoint.');
        if (!serveStatic(publicDir, '/index.html', res)) throw new HttpError(404, 'Nenalezeno.');
        return;
      }
      if (latency) await new Promise((r) => setTimeout(r, latency));
      const query = Object.fromEntries(url.searchParams.entries());
      // autentizace
      const cookies = parseCookies(req.headers.cookie);
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1] || req.headers['x-api-key'] || (feed ? query.token : null);
      let user = null;
      let scopes = [];
      let via = null;
      let sid = null;
      if (cookies.ct_session && st.sessions.has(cookies.ct_session)) {
        user = 'admin';
        scopes = ['read', 'import', 'export', 'admin'];
        via = 'session';
        sid = cookies.ct_session;
      } else if (bearer) {
        const t = st.tokens.find((x) => x._token === bearer);
        if (t) {
          user = 'token:' + t.name;
          scopes = t.scopes.includes('admin') ? ['read', 'import', 'export', 'admin'] : [...new Set(['read', ...t.scopes])];
          via = 'token';
          t.last_used_at = iso(st.now());
        }
      } else if (opts.autologin) {
        user = 'admin';
        scopes = ['read', 'import', 'export', 'admin'];
        via = 'session';
      }
      if (feed) {
        if (!user || !scopes.includes('export')) throw new HttpError(401, 'Feed vyžaduje token s oprávněním export (?token=…).');
        const rows = exportRows(st, feed[1] === 'changes' ? 'approved' : 'all');
        const { body, type } = rowsBody(st, rows, feed[2]);
        const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
        if (feed[1] === 'changes' && query.mark === '1') headers['X-Export-Id'] = String(markExported(st, rows.map((r) => r.proposal_id), 'feed', 'feed/' + feed[1] + '.' + feed[2]).id);
        res.writeHead(200, headers);
        res.end(body);
        return;
      }
      const apiPath = p.slice('/api/v1'.length);
      const route = routes.find((r) => r.method === req.method && r.re.test(apiPath));
      if (!route) {
        const any = routes.some((r) => r.re.test(apiPath));
        throw new HttpError(any ? 405 : 404, any ? 'Metoda není povolena.' : 'Neznámý endpoint.');
      }
      if (route.auth !== 'public') {
        if (!user) throw new HttpError(401, 'Nepřihlášeno.');
        if (!scopes.includes(route.auth)) throw new HttpError(403, 'Chybí oprávnění „' + route.auth + '“.');
        // CSRF: požadavky s cookie (mimo GET) musí nést X-Requested-With
        if (via === 'session' && req.method !== 'GET' && req.headers['x-requested-with'] !== 'cenotvorba') throw new HttpError(403, 'Chybí hlavička X-Requested-With (ochrana CSRF).');
      }
      const m = route.re.exec(apiPath);
      const params = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      if (!route.keys.length && m.length > 1) for (let i = 1; i < m.length; i++) params[i - 1] = m[i];
      const raw = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      const ct = String(req.headers['content-type'] || '');
      let body = null;
      const isJson = ct.includes('application/json');
      if (isJson && raw.length) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new HttpError(400, 'Tělo požadavku není platný JSON.');
        }
      }
      const ctx = { req, res, params, query, body, rawBody: raw, isJson, user, scopes, via, sid, setCookie: null };
      const result = await route.handler(ctx);
      const extra = ctx.setCookie ? { 'Set-Cookie': ctx.setCookie } : {};
      if (result && result.status && result.headers && result.body !== undefined) {
        res.writeHead(result.status, { 'Cache-Control': 'no-store', ...result.headers, ...extra });
        res.end(result.body);
      } else sendJson(res, 200, result ?? { ok: true }, extra);
      log(req.method, p, 200);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error('[mock] chyba', e);
      log(req.method, p, status);
      if (!res.headersSent) sendJson(res, status, { error: { status, message: status === 500 ? 'Interní chyba serveru' : e.message, details: e.details || null } });
      else res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host || '127.0.0.1', () => {
      const addr = server.address();
      const url = `http://${addr.address === '::' ? 'localhost' : addr.address}:${addr.port}`;
      resolve({
        server,
        url,
        port: addr.port,
        state: st,
        close: () => new Promise((r) => {
          server.closeAllConnections?.();
          server.close(() => r());
        }),
      });
    });
  });
}

module.exports = { createMockServer, createState, compileFilter, decide, buildMarket, DEFAULT_CONFIG, DEFAULT_SETTINGS };

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }));
  createMockServer({
    port: Number(args.port || process.env.PORT || 8090),
    host: args.host || '127.0.0.1',
    latency: Number(args.latency || process.env.MOCK_LATENCY || 0),
    password: args.password || process.env.MOCK_PASSWORD || 'demo',
    autologin: Boolean(args.autologin),
    extensions: Boolean(args.extensions),
    log: args.verbose ? (m, p, s) => console.log(s, m, p) : undefined,
  }).then((m) => {
    console.log(`Cenotvorba – mock server UI běží na ${m.url}  (heslo: ${m.state.password})`);
  }, (e) => {
    console.error('Mock server se nepodařilo spustit:', e.message);
    process.exit(1);
  });
}
