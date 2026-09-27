'use strict';
// Ukázková data: realistický katalog cyklo-obchodu + nabídky (smyšlených) konkurentů.
//
//   node tools/demo-data.js                 # naplní databázi (CENOTVORBA_DB nebo ./data/cenotvorba.db)
//   node tools/demo-data.js --db demo.db --products 1500
//   node tools/demo-data.js --files examples/   # jen zapíše ukázkové vstupní soubory (JSON/CSV/XML)
//
// Generátor je deterministický (stejné --seed → stejná data), takže se hodí i do testů.

const fs = require('node:fs');
const path = require('node:path');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATEGORIES = [
  { name: 'Horská kola', msrp: [18990, 129990], vat: 21, brands: ['Cannondale', 'Santa Cruz', 'Focus', 'Kellys', 'Author'], models: ['Trail', 'Scalpel', 'Habit', 'Jam', 'Thron', 'Hightower', 'Tallboy', 'Gator', 'Revolt'] },
  { name: 'Silniční kola', msrp: [24990, 249990], vat: 21, brands: ['Cervélo', 'Cannondale', 'Focus'], models: ['Caledonia', 'Soloist', 'SuperSix EVO', 'Synapse', 'Izalco Max', 'Paralane', 'R5', 'S5'] },
  { name: 'Gravel', msrp: [29990, 159990], vat: 21, brands: ['Cervélo', 'Cannondale', 'Focus', 'Santa Cruz'], models: ['Áspero', 'Topstone', 'Atlas', 'Stigmata', 'Topstone Carbon'] },
  { name: 'E-kola', msrp: [59990, 219990], vat: 21, brands: ['Cannondale', 'Focus', 'Santa Cruz', 'Kellys'], models: ['Moterra', 'Jam²', 'Thron²', 'Heckler', 'Tractive', 'Aventura²'] },
  { name: 'Komponenty', msrp: [490, 24990], vat: 21, brands: ['Shimano', 'SRAM', 'RockShox', 'Fox'], models: ['Deore XT kazeta', 'GX Eagle řetěz', 'Pike Ultimate', 'Float DPS', 'SLX brzdy', 'XTR kliky', 'Code RSC'] },
  { name: 'Pláště', msrp: [590, 2490], vat: 21, brands: ['Continental', 'Schwalbe', 'Maxxis'], models: ['Grand Prix 5000', 'Nobby Nic', 'Minion DHF', 'G-One Allround', 'Race King', 'Rekon'] },
  { name: 'Příslušenství', msrp: [290, 14990], vat: 21, brands: ['Garmin', 'Abus', 'Lezyne', 'Topeak'], models: ['Edge 540', 'Varia RTL515', 'Bordo 6500', 'Macro Drive', 'JoeBlow Sport', 'Mini pumpa'] },
  { name: 'Helmy', msrp: [1290, 7990], vat: 21, brands: ['Abus', 'POC', 'Giro'], models: ['Moventor', 'Ventral', 'Aventus', 'Tectal', 'Hex'] },
];

const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const COLORS = ['černá', 'bílá', 'zelená', 'modrá', 'šedá', 'červená'];
const OWNERS = ['Jana Nováková', 'Petr Svoboda', 'Lucie Dvořáková'];
const SUPPLIERS = { Cannondale: 'PON Bike CZ', 'Santa Cruz': 'PON Bike CZ', Focus: 'PON Bike CZ', Cervélo: 'PON Bike CZ', Kellys: 'Kellys Bicycles', Author: 'Author', Shimano: 'Paul Lange', SRAM: 'Sportful Trade', RockShox: 'Sportful Trade', Fox: 'Fox Europe', Continental: 'Continental CZ', Schwalbe: 'Schwalbe CZ', Maxxis: 'Maxxis CZ', Garmin: 'Garmin CZ', Abus: 'Abus CZ', Lezyne: 'Lezyne EU', Topeak: 'Topeak EU', POC: 'POC Sports', Giro: 'Vista Outdoor' };

// Smyšlení konkurenti – bias = typická cenová hladina vůči MOC, coverage = podíl sortimentu, který nabízí.
const COMPETITORS = [
  { name: 'VeloMarket.cz', bias: 0.9, coverage: 0.75, stock: 0.85 },
  { name: 'KoloPointer.cz', bias: 0.94, coverage: 0.6, stock: 0.8 },
  { name: 'CykloDům.cz', bias: 0.97, coverage: 0.5, stock: 0.9 },
  { name: 'BikeRanger.cz', bias: 0.88, coverage: 0.45, stock: 0.6 },
  { name: 'SpeedKola.cz', bias: 1.0, coverage: 0.35, stock: 0.95 },
  { name: 'HoryNaKole.cz', bias: 0.92, coverage: 0.4, stock: 0.7 },
  { name: 'MegaSportík.cz', bias: 0.86, coverage: 0.3, stock: 0.75 },
];

function roundEnding(v) {
  if (v < 1000) return Math.max(9, Math.floor(v / 10) * 10 + 9);
  if (v < 10000) return Math.floor(v / 100) * 100 + 90;
  return Math.floor(v / 1000) * 1000 + 990;
}

/** „Topstone Carbon“ → „TOPSTONE-CARBON“, „Áspero“ → „ASPERO“ (kód skupiny bez diakritiky). */
function slug(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function ean13(rand) {
  let digits = '859';
  for (let i = 0; i < 9; i++) digits += Math.floor(rand() * 10);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (i % 2 ? 3 : 1);
  return digits + ((10 - (sum % 10)) % 10);
}

/**
 * @param {{products?: number, seed?: number, now?: Date}} [opts]
 * @returns {{products: object[], offers: object[], competitors: string[]}} kanonické záznamy (SPEC §3)
 */
function generateDemo({ products: count = 600, seed = 42, now = new Date() } = {}) {
  const rand = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const between = (a, b) => a + (b - a) * rand();
  const products = [];
  const offers = [];
  const groupSeen = new Map(); // základ kódu skupiny → počet modelů
  let n = 0;
  while (products.length < count) {
    const cat = pick(CATEGORIES);
    const brand = pick(cat.brands);
    const model = pick(cat.models);
    const isBike = /kola$/i.test(cat.name) || cat.name === 'Gravel';
    const year = pick([2024, 2025, 2025, 2026, 2026, 2026]);
    const logMin = Math.log(cat.msrp[0]);
    const logMax = Math.log(cat.msrp[1]);
    const msrp = roundEnding(Math.exp(between(logMin, logMax)));
    const variants = isBike ? SIZES.slice(0, 2 + Math.floor(rand() * 4)) : [null];
    const color = pick(COLORS);
    // cenová skupina: velikosti jednoho modelu kola (značka-model-rok, např. CAN-TOPSTONE-2026) – strategie s group.align
    // jim dá jednu cenu. Generátor může stejnou značku+model+rok vylosovat znovu (jiná MOC, jiná barva) → další
    // model dostane pořadové číslo (CAN-TOPSTONE-2026-2), skupina = vždy velikosti téhož modelu se stejnou MOC.
    let groupCode = null;
    if (isBike) {
      const base = `${slug(brand).slice(0, 3)}-${slug(model)}-${year}`;
      const k = (groupSeen.get(base) || 0) + 1;
      groupSeen.set(base, k);
      groupCode = k === 1 ? base : `${base}-${k}`;
    }
    // Velikosti jednoho modelu mají ve skutečnosti stejný nákup i prodejní cenu a konkurence je nabízí za (skoro)
    // stejnou cenu. Hodnoty modelu určí první velikost; další velikosti je převezmou (náhodná čísla se čerpají dál
    // stejně, takže ostatní data i ukázkové soubory zůstávají stejné). Občas je jedna velikost ve vlastní slevě
    // (doprodej velikosti) – přesně to sjednocení ve skupině (group.align) srovná.
    let variantBase = null;
    for (const size of variants) {
      if (products.length >= count) break;
      n += 1;
      const code = `${brand.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()}-${String(100000 + n * 7).slice(1)}${size ? '-' + size : ''}`;
      let purchase = Math.round((msrp / 1.21) * between(0.58, 0.74));
      const priceFactor = pick([1, 1, 0.95, 0.92, 0.9, 0.85]);
      let price = roundEnding(msrp * priceFactor);
      if (isBike) {
        if (!variantBase) variantBase = { purchase, price, factors: new Map() };
        else {
          purchase = variantBase.purchase;
          price = priceFactor === 0.85 ? roundEnding(variantBase.price * 0.95) : variantBase.price;
        }
      }
      // stáří zásoby N0–N8 (N7/N8 = ležáky), u starších modelových roků vyšší
      const ageClass = Math.min(8, Math.max(0, Math.round((2026 - year) * 2.5 + between(-1, 3))));
      const stock = rand() < 0.15 ? 0 : Math.ceil(between(1, isBike ? 6 : 25));
      const sales30 = ageClass >= 7 ? (rand() < 0.7 ? 0 : 1) : Math.floor(between(0, isBike ? 4 : 20));
      const p = {
        code,
        ean: ean13(rand),
        mpn: `${model.replace(/\s+/g, '').toUpperCase().slice(0, 6)}${year % 100}${size || ''}`,
        name: `${brand} ${model}${isBike ? ` ${year}` : ''}${size ? ` vel. ${size}` : ''}${isBike ? ` (${color})` : ''}`,
        manufacturer: brand,
        category: cat.name,
        group_code: groupCode,
        supplier: SUPPLIERS[brand] || 'Ostatní',
        owner: OWNERS[CATEGORIES.indexOf(cat) % OWNERS.length],
        purchase_price: purchase,
        price,
        vat_rate: cat.vat,
        msrp,
        stock,
        sales_30: sales30,
        sales_90: sales30 * 3 + Math.floor(between(0, 3)),
        attrs: {
          N: `N${ageClass}`,
          sezona: year,
          imprese_30: Math.floor(between(20, isBike ? 4000 : 1500)),
          abc: pick(['A', 'B', 'B', 'C', 'C']),
        },
      };
      products.push(p);
      for (const c of COMPETITORS) {
        if (rand() > c.coverage) continue;
        let factor = c.bias * between(0.94, 1.06);
        if (variantBase) {
          // stejný model u konkurenta: ceny velikostí se liší jen málo (±1,5 %)
          const base = variantBase.factors.get(c.name);
          if (base == null) variantBase.factors.set(c.name, factor);
          else factor = base * (1 + (factor / c.bias - 1) * 0.25);
        }
        // občas výrazná akce nebo chyba v datech (outlier)
        if (rand() < 0.02) factor *= 0.55;
        const cPrice = Math.min(roundEnding(msrp * factor), Math.round(msrp * 1.05));
        const hoursAgo = Math.floor(between(0, 72));
        offers.push({
          code: p.code,
          ean: p.ean,
          competitor: c.name,
          price: cPrice,
          shipping: isBike ? 0 : pick([0, 79, 99, 129]),
          in_stock: rand() < c.stock ? 1 : 0,
          url: `https://${c.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')}/p/${p.ean}`,
          name: p.name,
          observed_at: new Date(now.getTime() - hoursAgo * 3600e3).toISOString(),
        });
      }
    }
  }
  return { products, offers, competitors: COMPETITORS.map((c) => c.name) };
}

function csvCell(v) {
  if (v == null) return '';
  const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Zapíše ukázkové vstupní soubory ve formátech, které nástroj umí importovat. */
function writeExampleFiles(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const some = data.products.slice(0, 40);
  const codes = new Set(some.map((p) => p.code));
  const someOffers = data.offers.filter((o) => codes.has(o.code));

  // 1) Katalog jako CSV exportovaný z Pohody/Excelu (středník, desetinná čárka, české hlavičky)
  // „Model“ = skupina velikostí jednoho kola (kanonické pole group_code, alias „model“)
  const head = ['Kód', 'EAN', 'Název', 'Výrobce', 'Kategorie', 'Model', 'Dodavatel', 'Zodpovědná osoba', 'Nákupní cena', 'Prodejní cena s DPH', 'Sazba DPH', 'MOC', 'Stav skladu', 'Prodej 30 dní', 'N', 'Sezóna', 'Imprese 30'];
  const lines = [head.join(';')];
  for (const p of some) {
    lines.push([p.code, p.ean, p.name, p.manufacturer, p.category, p.group_code, p.supplier, p.owner, p.purchase_price, p.price, p.vat_rate, p.msrp, p.stock, p.sales_30, p.attrs.N, p.attrs.sezona, p.attrs.imprese_30].map(csvCell).join(';'));
  }
  fs.writeFileSync(path.join(dir, 'katalog.csv'), '﻿' + lines.join('\r\n') + '\r\n');

  // 2) Konkurence jako plochý JSON (1 řádek = produkt × konkurent)
  // bez observed_at → čas zjištění = okamžik importu (pevné datum by po týdnu vypadalo jako zastaralá data)
  fs.writeFileSync(path.join(dir, 'konkurence.json'), JSON.stringify({ items: someOffers.map((o) => ({ ean: o.ean, competitor: o.competitor, price: o.price, shipping: o.shipping, in_stock: !!o.in_stock, url: o.url })) }, null, 2) + '\n');

  // 3) Konkurence jako vnořený JSON (produkt → nabídky)
  const nested = some.map((p) => ({
    code: p.code,
    ean: p.ean,
    offers: someOffers.filter((o) => o.code === p.code).map((o) => ({ shop: o.competitor, price: `${o.price.toLocaleString('cs-CZ')} Kč`, stock: o.in_stock ? 'skladem' : 'na dotaz' })),
  }));
  fs.writeFileSync(path.join(dir, 'konkurence-vnorene.json'), JSON.stringify({ products: nested }, null, 2) + '\n');

  // 4) Konkurence jako XML (atributy + elementy)
  const x = ['<?xml version="1.0" encoding="UTF-8"?>', '<prices>'];
  for (const o of someOffers) {
    x.push(`  <offer shop="${xmlEsc(o.competitor)}">`, `    <ean>${o.ean}</ean>`, `    <price>${o.price}</price>`, `    <shipping>${o.shipping}</shipping>`, `    <availability>${o.in_stock ? 'in stock' : 'out of stock'}</availability>`, `    <url>${xmlEsc(o.url)}</url>`, '  </offer>');
  }
  x.push('</prices>');
  fs.writeFileSync(path.join(dir, 'konkurence.xml'), x.join('\n') + '\n');

  // 5) Konkurence jako CSV
  const cl = ['ean;konkurent;cena;doprava;skladem;url'];
  for (const o of someOffers) cl.push([o.ean, o.competitor, o.price, o.shipping, o.in_stock ? 'ano' : 'ne', o.url].map(csvCell).join(';'));
  fs.writeFileSync(path.join(dir, 'konkurence.csv'), '﻿' + cl.join('\r\n') + '\r\n');
  return ['katalog.csv', 'konkurence.json', 'konkurence-vnorene.json', 'konkurence.xml', 'konkurence.csv'];
}

/** Naplní databázi ukázkovými daty přes běžný importní modul (stejná cesta jako API). */
function seedDatabase(db, data, { now = new Date(), withStrategies = true } = {}) {
  const { importProducts, importOffers } = require('../src/import');
  const productStats = importProducts(db, data.products, { now });
  const offerStats = importOffers(db, data.offers, { now });
  // záznam do logu importů, aby přehled a historie importů ukázaly, odkud data jsou
  const ts = new Date(now).toISOString();
  const logImport = db.prepare("INSERT INTO imports(kind, format, origin, started_at, finished_at, status, stats) VALUES (?, 'json', 'api', ?, ?, 'ok', ?)");
  logImport.run('products', ts, ts, JSON.stringify(productStats));
  logImport.run('offers', ts, ts, JSON.stringify(offerStats));
  let strategies = 0;
  if (withStrategies && db.prepare('SELECT COUNT(*) AS c FROM strategies').get().c === 0) {
    const { STRATEGY_PRESETS } = require('../src/engine/presets');
    const ts = new Date(now).toISOString();
    let priority = 10;
    for (const preset of STRATEGY_PRESETS) {
      let segmentId = null;
      if (preset.segment) {
        segmentId = Number(
          db.prepare('INSERT INTO segments(name, description, filter, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(preset.segment.name, preset.segment.description || null, JSON.stringify(preset.segment.filter || {}), ts, ts).lastInsertRowid
        );
      }
      const enabled = preset.enabled === false ? 0 : 1;
      db.prepare('INSERT INTO strategies(name, description, segment_id, priority, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(preset.name, preset.description || null, segmentId, priority, enabled, JSON.stringify(preset.config || {}), ts, ts);
      priority += 10;
      strategies += 1;
    }
  }
  return { products: productStats, offers: offerStats, strategies };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = generateDemo({ products: Number(args.products) || 600, seed: Number(args.seed) || 42 });
  if (args.files) {
    const written = writeExampleFiles(path.resolve(String(args.files)), data);
    console.log(`Zapsáno do ${args.files}: ${written.join(', ')}`);
    return;
  }
  const { openDb } = require('../src/db');
  const file = typeof args.db === 'string' ? args.db : process.env.CENOTVORBA_DB || './data/cenotvorba.db';
  const db = openDb(file);
  const res = seedDatabase(db, data);
  console.log(`Databáze ${file}: produkty ${JSON.stringify(res.products)}; nabídky ${JSON.stringify(res.offers)}; strategie ${res.strategies}`);
  if (!args['no-run']) {
    const { runPricing } = require('../src/engine/run');
    const r = runPricing(db, { trigger: 'manual' });
    console.log(`Přecenění #${r.run_id}: ${JSON.stringify(r.stats)}`);
  }
  db.close();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { generateDemo, writeExampleFiles, seedDatabase, COMPETITORS };
