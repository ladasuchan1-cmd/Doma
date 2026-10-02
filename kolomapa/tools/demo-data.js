#!/usr/bin/env node
'use strict';
// UKÁZKOVÁ (DEMO) data pro vývoj a vyzkoušení UI, dokud nefungují skutečné scrapery.
//
//   node tools/demo-data.js [--count=400] [--seed=42] [--db=SOUBOR]   vloží demo inzeráty (staré demo nahradí)
//   node tools/demo-data.js --clear [--db=SOUBOR]                      smaže všechny demo inzeráty (npm run demo-clear)
//
// Inzeráty jsou vymyšlené (značky a modely skutečné, ceny přibližné), rozložené do všech 14 krajů do skutečných
// obcí ze src/geo/data/places.json. Poznáte je podle params.demo = "1" a odkazu s „#demo-…“. Nemají fotky.
// Nikdy je nepouštějte do databáze, ze které se dělá veřejný export, aniž byste je pak smazali (--clear).
// Do databáze se skutečnými inzeráty je nástroj nevloží (demo ceny by se míchaly do učení modelu) – jen s --force;
// pro vyzkoušení UI použijte samostatnou databázi: node tools/demo-data.js --db=data/demo.db a KOLOMAPA_DB=data/demo.db.

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { openDb, tx, nowIso } = require('../src/db');

const HOMEPAGES = {
  bazos: 'https://kolo.bazos.cz/',
  sbazar: 'https://www.sbazar.cz/',
  aukro: 'https://aukro.cz/',
  cyklobazar: 'https://www.cyklobazar.cz/',
};

// Podíl inzerátů podle krajů (zhruba podle počtu obyvatel).
const KRAJ_WEIGHTS = { PHA: 15, STC: 13, JHM: 12, MSK: 11, ULK: 7, JHC: 6, PLK: 6, OLK: 6, ZLK: 5.5, HKK: 5, VYS: 5, PAK: 5, LBK: 4.5, KVK: 2.5 };
const SOURCE_WEIGHTS = { bazos: 45, sbazar: 25, aukro: 14, cyklobazar: 16 };

// [značka, model, typ, cena nového kola Kč, materiál, kola, sada, tier značky, {ebike: [motor, Wh]}]
const CATALOG = [
  ['Specialized', 'Rockhopper Comp 29', 'mtb_hardtail', 22000, 'alu', '29"', 'Shimano Deore', 4],
  ['Specialized', 'Chisel Comp', 'mtb_hardtail', 55000, 'alu', '29"', 'Shimano SLX', 4],
  ['Trek', 'Marlin 7', 'mtb_hardtail', 26000, 'alu', '29"', 'Shimano Deore', 4],
  ['Trek', 'X-Caliber 8', 'mtb_hardtail', 36000, 'alu', '29"', 'Shimano Deore', 4],
  ['Giant', 'Talon 1', 'mtb_hardtail', 21000, 'alu', '27,5"', 'Shimano Deore', 3],
  ['Cube', 'Reaction Pro', 'mtb_hardtail', 33000, 'alu', '29"', 'Shimano Deore', 3],
  ['Superior', 'XC 879', 'mtb_hardtail', 25000, 'alu', '29"', 'Shimano Deore', 3],
  ['Author', 'Spirit', 'mtb_hardtail', 18000, 'alu', '29"', 'Shimano Alivio', 2],
  ['Rock Machine', 'Manhattan 90-29', 'mtb_hardtail', 30000, 'alu', '29"', 'Shimano Deore', 3],
  ['Kellys', 'Gate 70', 'mtb_hardtail', 25000, 'alu', '29"', 'Shimano Deore', 3],
  ['Scott', 'Scale 970', 'mtb_hardtail', 30000, 'alu', '29"', 'Shimano Deore', 4],
  ['Canyon', 'Grand Canyon 7', 'mtb_hardtail', 30000, 'alu', '29"', 'Shimano Deore', 4],
  ['Specialized', 'Stumpjumper Comp Alloy', 'mtb_full', 95000, 'alu', '29"', 'SRAM GX Eagle', 4],
  ['Specialized', 'Stumpjumper EVO Expert', 'mtb_full', 145000, 'carbon', '29"', 'SRAM X01 Eagle', 4],
  ['Trek', 'Fuel EX 8', 'mtb_full', 100000, 'alu', '29"', 'Shimano XT', 4],
  ['Canyon', 'Spectral 125 AL 6', 'mtb_full', 75000, 'alu', '29"', 'Shimano SLX', 4],
  ['Santa Cruz', 'Hightower C R', 'mtb_full', 140000, 'carbon', '29"', 'SRAM NX Eagle', 5],
  ['Scott', 'Spark 960', 'mtb_full', 70000, 'alu', '29"', 'Shimano Deore', 4],
  ['Cube', 'Stereo 140 HPC Race', 'mtb_full', 85000, 'carbon', '29"', 'Shimano XT', 3],
  ['Giant', 'Trance X 29 2', 'mtb_full', 80000, 'alu', '29"', 'Shimano SLX', 3],
  ['Specialized', 'Allez Sport', 'road', 30000, 'alu', '28"', 'Shimano Tiagra', 4],
  ['Specialized', 'Tarmac SL7 Comp', 'road', 110000, 'carbon', '28"', 'Shimano 105 Di2', 4],
  ['Trek', 'Émonda SL 5', 'road', 75000, 'carbon', '28"', 'Shimano 105', 4],
  ['Canyon', 'Endurace CF 7', 'road', 60000, 'carbon', '28"', 'Shimano 105', 4],
  ['Giant', 'TCR Advanced 2', 'road', 55000, 'carbon', '28"', 'Shimano 105', 3],
  ['Cannondale', 'CAAD13 105', 'road', 45000, 'alu', '28"', 'Shimano 105', 4],
  ['Scott', 'Addict 30', 'road', 65000, 'carbon', '28"', 'Shimano 105', 4],
  ['Canyon', 'Grizl CF SL 7', 'gravel', 60000, 'carbon', '28"', 'Shimano GRX', 4],
  ['Specialized', 'Diverge E5 Comp', 'gravel', 55000, 'alu', '28"', 'Shimano GRX', 4],
  ['Cube', 'Nuroad Pro', 'gravel', 30000, 'alu', '28"', 'Shimano GRX', 3],
  ['Giant', 'Revolt 1', 'gravel', 40000, 'alu', '28"', 'Shimano GRX', 3],
  ['Superior', 'X-Road Team Issue', 'gravel', 50000, 'carbon', '28"', 'Shimano GRX', 3],
  ['Cube', 'Nature EXC', 'trekking', 25000, 'alu', '28"', 'Shimano Deore', 3],
  ['Author', 'Ronin', 'cross', 14000, 'alu', '28"', 'Shimano Altus', 2],
  ['Kellys', 'Phanatic 30', 'cross', 18000, 'alu', '28"', 'Shimano Alivio', 3],
  ['Trek', 'FX 3 Disc', 'cross', 25000, 'alu', '28"', 'Shimano Deore', 4],
  ['Gazelle', 'Orange C7', 'city', 30000, 'alu', '28"', 'Shimano Nexus 7', 3],
  ['Electra', 'Townie 7D', 'city', 15000, 'alu', '26"', 'Shimano Tourney', 2],
  ['Specialized', 'Riprock 24', 'kids', 13000, 'alu', '24"', null, 4],
  ['Kellys', 'Lumi 30', 'kids', 9000, 'alu', '24"', 'Shimano Tourney', 3],
  ['Woom', '4', 'kids', 13000, 'alu', '20"', null, 4],
  ['Early Rider', 'Belter 16', 'kids', 9000, 'alu', '16"', null, 3],
  ['Puky', 'LR 1L', 'balance', 3000, 'steel', '12"', null, 3],
  ['Specialized', 'Turbo Levo Comp', 'ebike_mtb_full', 180000, 'alu', '29"', 'SRAM GX Eagle', 4, ['Specialized 2.2', 700]],
  ['Trek', 'Rail 7', 'ebike_mtb_full', 160000, 'alu', '29"', 'SRAM NX Eagle', 4, ['Bosch Performance CX', 750]],
  ['Cube', 'Stereo Hybrid 140 HPC', 'ebike_mtb_full', 130000, 'carbon', '29"', 'Shimano Deore', 3, ['Bosch Performance CX', 750]],
  ['Haibike', 'AllMtn 6', 'ebike_mtb_full', 140000, 'alu', '29"', 'Shimano XT', 3, ['Yamaha PW-X3', 720]],
  ['Cube', 'Reaction Hybrid Pro 625', 'ebike_mtb', 75000, 'alu', '29"', 'Shimano Deore', 3, ['Bosch Performance CX', 625]],
  ['Kellys', 'Tygon R50', 'ebike_mtb_full', 80000, 'alu', '27,5"', 'Shimano Deore', 3, ['Shimano EP8', 720]],
  ['Cube', 'Kathmandu Hybrid SLX 750', 'ebike_trekking', 110000, 'alu', '28"', 'Shimano SLX', 3, ['Bosch Performance CX', 750]],
  ['Gazelle', 'Ultimate C380 HMB', 'ebike_city', 95000, 'alu', '28"', 'Enviolo', 3, ['Bosch Performance', 500]],
  ['Specialized', 'Turbo Vado 4.0', 'ebike_trekking', 100000, 'alu', '28"', 'Shimano Deore', 4, ['Specialized 2.0', 710]],
  ['Crussis', 'e-Cross 1.10', 'ebike_trekking', 40000, 'alu', '28"', 'Shimano Altus', 2, ['Bafang', 522]],
  ['Specialized', 'Turbo Creo SL Comp', 'ebike_road', 150000, 'carbon', '28"', 'Shimano 105', 4, ['Specialized SL 1.1', 320]],
  ['Mongoose', 'Legion L40', 'bmx', 9000, 'steel', '20"', null, 2],
  ['NS Bikes', 'Movement 2', 'dirt', 20000, 'steel', '26"', null, 3],
  ['Brompton', 'C Line Explore', 'folding', 45000, 'steel', '16"', 'Brompton 6s', 4],
];

const NON_BIKES = [
  ['Cyklistická helma Giro Fixture MIPS, vel. M', 900],
  ['Pláště Schwalbe Nobby Nic 29x2.4 – 2 ks', 1200],
  ['Odpružená vidlice RockShox Pike Ultimate 29', 9500],
  ['Tretry Shimano XC5, vel. 43', 1500],
  ['Nosič kol na tažné zařízení Thule EasyFold XT 2', 12000],
  ['Sada kol DT Swiss XM 1700 29"', 8500],
];

const CONDITIONS = [
  ['new', 0.02, 'nové', 0.95],
  ['like_new', 0.15, 'jako nové', 1.0],
  ['very_good', 0.35, 'velmi dobrý', 0.92],
  ['good', 0.3, 'dobrý', 0.82],
  ['fair', 0.13, 'opotřebené', 0.68],
  ['poor', 0.05, 'špatný', 0.5],
];

const COND_SENTENCES = {
  new: 'Kolo je nové, nejeté, jen vyzkoušené kolem domu. Záruka u prodejce.',
  like_new: 'Kolo je ve stavu jako nové, najeto jen pár set kilometrů, bez škrábanců.',
  very_good: 'Kolo je ve velmi dobrém stavu, pravidelně servisované, jen drobné oděrky od používání.',
  good: 'Kolo je v dobrém stavu, běžné stopy používání, vše funkční.',
  fair: 'Kolo je opotřebené – řetěz a kazeta by chtěly vyměnit, brzdy fungují.',
  poor: 'Kolo potřebuje servis: přehazovačka seřídit, plášť prasklý, rám drobné škrábance.',
};

const EXTRA_SENTENCES = [
  'Nové pláště a brzdové destičky.',
  'Loni kompletní servis tlumičů.',
  'Doklad o koupi k dispozici.',
  'Prodávám, protože jsem přešel na větší rám.',
  'Možnost výměny za silniční kolo.',
  'K tomu dám zdarma pedály a blatníky.',
  'Pouze osobní odběr, neposílám.',
  'Při rychlém jednání sleva.',
];

const AI_NOTES = [
  'Na fotce je vidět opotřebený převodník a řetěz, jinak kolo působí zachovale.',
  'Kolo vypadá velmi zachovale, rám bez viditelných škrábanců; tlumič podle popisu nedávno v servisu.',
  'Fotka je v nízké kvalitě – stav nelze spolehlivě posoudit, odhad je konzervativní.',
  'Na fotce jsou novější pláště a sedlo, než odpovídá výbavě modelu – mírně zvyšuje hodnotu.',
];

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

function weighted(rand, entries) {
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let x = rand() * total;
  for (const [v, w] of entries) {
    x -= w;
    if (x <= 0) return v;
  }
  return entries[entries.length - 1][0];
}

const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];
const between = (rand, a, b) => a + rand() * (b - a);
const roundTo = (v, step) => Math.round(v / step) * step;

/** Cena „jako z inzerátu“: 18 900, 25 000, 7 490 … */
function askingPrice(rand, v) {
  if (v < 5000) return roundTo(v, 100) - (rand() < 0.4 ? 10 : 0);
  const base = roundTo(v, v < 30000 ? 500 : 1000);
  return rand() < 0.35 ? base - 100 : base;
}

function frameSizeFor(rand, type) {
  if (type === 'kids' || type === 'balance' || type === 'bmx') return null;
  if (type === 'road' || type === 'ebike_road' || type === 'gravel') return `${pick(rand, [50, 52, 54, 56, 58])} cm`;
  if (type === 'folding' || type === 'dirt') return null;
  return weighted(rand, [['S', 2], ['M', 4], ['L', 4], ['XL', 1.5]]);
}

function loadPlaces() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'geo', 'data', 'places.json'), 'utf8'));
  const byKraj = {};
  for (const [n, k, o, lat, lon, pop] of raw) {
    if (!k || pop < 2500 || (/\d/.test(n) && !/^Praha \d/.test(n))) continue;
    (byKraj[k] ||= []).push({ n, o, lat, lon, pop });
  }
  return byKraj;
}

function titleFor(rand, it) {
  const { brand, model, year, size, wheel, type, wh } = it;
  const vel = size ? `, vel. ${size}` : '';
  if (type === 'kids') return `Dětské kolo ${brand} ${model}${model.includes(wheel.replace('"', '')) ? '' : ` ${wheel}`}`;
  if (type === 'balance') return `Odrážedlo ${brand} ${model}`;
  if (type.startsWith('ebike')) return pick(rand, [`Elektrokolo ${brand} ${model} ${wh} Wh${vel}`, `${brand} ${model} ${year}${vel}`, `E-bike ${brand} ${model} (${year})`]);
  return pick(rand, [
    `${brand} ${model} ${year}${vel}`,
    `${brand} ${model} (${year}) – ${wheel}${vel}`,
    `Prodám ${brand} ${model}${size ? `, rám ${size}` : ''}`,
    `${brand} ${model} ${wheel}${vel}`,
  ]);
}

/**
 * Vygeneruje demo inzeráty (deterministicky podle seed).
 * @param {{count?: number, seed?: number, now?: Date}} [o]
 * @returns {object[]} řádky pro tabulku listings (+ _history)
 */
function generateDemo({ count = 400, seed = 42, now = new Date() } = {}) {
  const rand = mulberry32(seed);
  const places = loadPlaces();
  const krajEntries = Object.entries(KRAJ_WEIGHTS).filter(([k]) => places[k] && places[k].length);
  const rows = [];
  const nowMs = now.getTime();
  const iso = (ms) => new Date(Math.min(ms, nowMs)).toISOString();
  for (let i = 1; i <= count; i++) {
    // první kolo každého kraje zaručeně, zbytek podle vah
    const kraj = i <= krajEntries.length ? krajEntries[i - 1][0] : weighted(rand, krajEntries);
    const town = weighted(rand, places[kraj].slice(0, 120).map((p) => [p, Math.pow(p.pop, 0.6)]));
    const source = weighted(rand, Object.entries(SOURCE_WEIGHTS));
    const sid = `demo-${i}`;
    const postedMs = nowMs - Math.floor(between(rand, 0, 40) * 86400000);
    let firstSeenMs = Math.min(nowMs - 60000, postedMs + Math.floor(between(rand, 0, 1) * 86400000));
    if (rand() < 0.12) firstSeenMs = nowMs - Math.floor(between(rand, 0.1, 30) * 3600000); // nové za posledních 36 h
    const base = {
      source,
      source_id: sid,
      url: `${HOMEPAGES[source]}#${sid}`,
      posted_at: iso(Math.min(postedMs, firstSeenMs)),
      first_seen_at: iso(firstSeenMs),
      last_seen_at: iso(nowMs - 3600000),
      detail_at: iso(firstSeenMs),
      gone_at: rand() < 0.04 ? iso(nowMs - Math.floor(between(rand, 1, 10) * 86400000)) : null,
      photo_url: null,
      photo_count: null,
      category_src: source === 'bazos' ? 'Kola' : source === 'aukro' ? 'Sport a turistika › Cyklistika › Jízdní kola' : 'Jízdní kola',
      seller_type: rand() < (source === 'cyklobazar' ? 0.35 : 0.12) ? 'company' : 'private',
      views: source === 'bazos' || source === 'sbazar' ? Math.floor(between(rand, 15, 1800)) : null,
    };
    // poloha
    let lat = town.lat;
    let lon = town.lon;
    let precision = weighted(rand, [['city', 70], ['psc', 15], ['exact', 10], ['okres', 5]]);
    let locationText = town.n;
    if (precision === 'exact') {
      lat += between(rand, -0.012, 0.012);
      lon += between(rand, -0.018, 0.018);
    } else if (precision === 'okres') {
      locationText = `okres ${town.o || town.n}`;
    }
    let krajCode = kraj;
    if (rand() < 0.015) {
      lat = null;
      lon = null;
      precision = null;
      krajCode = null;
      locationText = 'Česká republika';
    }
    Object.assign(base, { lat, lon, geo_precision: precision, location_text: locationText, kraj: krajCode, okres: precision ? town.o || null : null });

    // není kolo
    if (rand() < 0.05) {
      const [title, price] = pick(rand, NON_BIKES);
      rows.push({
        ...base,
        title,
        description: `${title}. Prodám, nepotřebuji. Stav dobrý, osobní předání – ${town.n}.`,
        price_czk: askingPrice(rand, price * between(rand, 0.6, 1.1)),
        params: { demo: '1' },
        is_bike: 0,
        bike_type: null,
        features: { warnings: [] },
      });
      continue;
    }

    const [brand, model, type, newPrice, material, wheel, groupset, tier, ebike] = pick(rand, CATALOG);
    const year = Math.min(now.getFullYear(), Math.round(between(rand, 2014, now.getFullYear() + 0.4)));
    const age = Math.max(0, now.getFullYear() - year);
    const [cond, , condLabel, condFactor] = weighted(rand, CONDITIONS.map((c) => [c, c[1]]));
    const size = frameSizeFor(rand, type);
    const wh = ebike ? ebike[1] : null;
    const title = titleFor(rand, { brand, model, year, size, wheel, type, wh });
    const depreciation = Math.max(0.15, (age === 0 ? 0.85 : 0.8) * Math.pow(0.86, Math.max(0, age - 1)));
    const carbonBonus = material === 'carbon' ? 1.08 : 1;
    const estRaw = newPrice * depreciation * condFactor * carbonBonus * between(rand, 0.92, 1.08);
    const hasEstimate = rand() > 0.07;
    const est = hasEstimate ? roundTo(estRaw, estRaw < 20000 ? 500 : 1000) : null;
    const confidence = hasEstimate ? Math.round(between(rand, tier >= 4 ? 0.5 : 0.32, 0.93) * 100) / 100 : null;
    const spread = confidence ? 0.32 - confidence * 0.22 : 0;
    const ratio = weighted(rand, [[between(rand, 0.5, 0.85), 13], [between(rand, 0.86, 1.14), 62], [between(rand, 1.16, 1.65), 25]]);
    let price = askingPrice(rand, (est || estRaw) * ratio);
    let priceNote = null;
    if (rand() < 0.03) {
      price = null;
      priceNote = 'Dohodou';
    } else if (source === 'aukro' && rand() < 0.3) priceNote = rand() < 0.5 ? 'Aukce – aktuální příhoz' : 'Kup teď';
    const method = !hasEstimate ? null : weighted(rand, [['model', 55], ['rules', 25], ['comps', 12], ['ai', 8]]);
    const dealRatio = price && est ? Math.round((price / est) * 1000) / 1000 : null;

    const factors = [];
    if (est) {
      factors.push(`Cena nového kola ${brand} ${model}: přibližně ${newPrice.toLocaleString('cs-CZ')} Kč`);
      factors.push(`Stáří ${age} ${age === 1 ? 'rok' : age >= 2 && age <= 4 ? 'roky' : 'let'}: −${Math.round((1 - depreciation) * 100)} %`);
      factors.push(`Stav „${condLabel}“: ${condFactor >= 1 ? '+0' : `−${Math.round((1 - condFactor) * 100)}`} %`);
      if (material === 'carbon') factors.push('Karbonový rám: +8 %');
      if (ebike) factors.push(`Elektrokolo – motor ${ebike[0]}, baterie ${ebike[1]} Wh`);
      if (method === 'comps') factors.push(`Srovnatelné inzeráty: ${Math.floor(between(rand, 4, 25))} ks, medián ${roundTo(est * between(rand, 0.95, 1.05), 500).toLocaleString('cs-CZ')} Kč`);
      if (tier >= 4) factors.push('Prémiová značka – drží hodnotu lépe než průměr');
    }
    const warnings = [];
    if (dealRatio != null && dealRatio < 0.6) warnings.push('Cena je výrazně pod tržní hodnotou – ověřte původ kola (doklad o koupi, výrobní číslo rámu).');
    if (rand() < 0.05) warnings.push('V popisu chybí rok výroby – odhad je méně přesný.');
    if (ebike && rand() < 0.15) warnings.push('Stav baterie není v inzerátu uveden – nechte si ukázat diagnostiku.');
    if (cond === 'poor') warnings.push('Prodejce uvádí vady – počítejte s náklady na servis.');

    const params = { demo: '1' };
    if (source === 'aukro' || source === 'cyklobazar') {
      if (size) params['Velikost rámu'] = size;
      params['Rok výroby'] = String(year);
      params['Velikost kol'] = wheel;
      params['Stav'] = condLabel;
      if (ebike) params['Kapacita baterie'] = `${ebike[1]} Wh`;
    }
    const description = [
      `Prodám ${brand} ${model} z roku ${year}${size ? `, velikost rámu ${size}` : ''}, kola ${wheel}.`,
      COND_SENTENCES[cond],
      groupset ? `Sada ${groupset}${ebike ? `, motor ${ebike[0]}, baterie ${ebike[1]} Wh` : ''}.` : ebike ? `Motor ${ebike[0]}, baterie ${ebike[1]} Wh.` : null,
      pick(rand, EXTRA_SENTENCES),
      '',
      `Lokalita: ${town.n}, možnost projetí. Volejte nebo pište přes inzerát.`,
    ]
      .filter((x) => x != null)
      .join('\n');

    const ai = method === 'ai' || (est && rand() < 0.06);
    const row = {
      ...base,
      title,
      description,
      price_czk: price,
      price_note: priceNote,
      params,
      is_bike: 1,
      bike_type: type,
      features: {
        brand,
        brandTier: tier,
        model,
        modelYear: year,
        ageYears: age,
        wheelSize: wheel,
        frameSize: size,
        material,
        suspension: type.includes('full') ? 'full' : type.includes('mtb') ? 'hardtail' : 'rigid',
        isEbike: !!ebike,
        motor: ebike ? ebike[0] : undefined,
        batteryWh: wh || undefined,
        groupset: groupset || undefined,
        condition: cond,
        warnings,
      },
      est_czk: est,
      est_low: est ? roundTo(est * (1 - spread), 500) : null,
      est_high: est ? roundTo(est * (1 + spread), 500) : null,
      est_confidence: confidence,
      est_method: method === 'ai' ? 'model' : method,
      est_factors: factors,
      est_at: est ? iso(nowMs - 3600000) : null,
      deal_ratio: dealRatio,
      max_buy_czk: est ? roundTo(est * 0.62, 100) : null,
    };
    if (ai) {
      const aiEst = roundTo(est * between(rand, 0.9, 1.1), 500);
      Object.assign(row, {
        ai_czk: aiEst,
        ai_low: roundTo(aiEst * 0.88, 500),
        ai_high: roundTo(aiEst * 1.12, 500),
        ai_condition: cond,
        ai_notes: pick(rand, AI_NOTES),
        ai_model: 'demo',
        ai_at: iso(nowMs - 3600000),
      });
    }
    // historie ceny: u části inzerátů zlevnění
    row._history = [];
    if (price && rand() < 0.14) {
      const older = askingPrice(rand, price * between(rand, 1.06, 1.25));
      row._history.push({ at: row.first_seen_at, price: older });
      row._history.push({ at: iso(Math.max(firstSeenMs + 86400000, nowMs - 2 * 86400000)), price });
    } else if (price) row._history.push({ at: row.first_seen_at, price });
    rows.push(row);
  }
  return rows;
}

const COLUMNS = [
  'source', 'source_id', 'url', 'title', 'description', 'price_czk', 'price_note', 'posted_at', 'category_src', 'location_text', 'okres', 'kraj',
  'lat', 'lon', 'geo_precision', 'photo_url', 'photo_count', 'params', 'seller_type', 'views', 'is_bike', 'bike_type', 'features', 'est_czk', 'est_low',
  'est_high', 'est_confidence', 'est_method', 'est_factors', 'est_at', 'deal_ratio', 'max_buy_czk', 'ai_czk', 'ai_low', 'ai_high', 'ai_condition',
  'ai_notes', 'ai_model', 'ai_at', 'first_seen_at', 'last_seen_at', 'detail_at', 'gone_at',
];

/** Počet skutečných (ne-demo) inzerátů v DB. */
function realListingCount(db) {
  return Number(
    db.prepare("SELECT COUNT(*) AS n FROM listings WHERE NOT (json_valid(params) AND json_extract(params, '$.demo') IS NOT NULL AND json_extract(params, '$.demo') = '1')").get().n
  );
}

/** Smaže demo inzeráty (params.demo = "1"). Vrací počet. */
function clearDemo(db) {
  return Number(db.prepare("DELETE FROM listings WHERE json_valid(params) AND json_extract(params, '$.demo') = '1'").run().changes);
}

/**
 * Vloží demo inzeráty (předchozí demo smaže).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{count?: number, seed?: number, now?: Date}} [o]
 * @returns {{inserted: number, removed: number}}
 */
function seedDemo(db, o = {}) {
  const rows = generateDemo(o);
  const ins = db.prepare(`INSERT INTO listings (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`);
  const hist = db.prepare('INSERT OR IGNORE INTO price_history (listing_id, at, price_czk) VALUES (?, ?, ?)');
  const toDb = (v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v !== null && typeof v === 'object') return JSON.stringify(v, (k, x) => (x === undefined ? undefined : x));
    return v;
  };
  return tx(db, () => {
    const removed = clearDemo(db);
    for (const r of rows) {
      const r2 = { ...r, params: r.params || {}, features: r.features || {}, est_factors: r.est_factors || [] };
      const id = Number(ins.run(...COLUMNS.map((c) => toDb(r2[c]))).lastInsertRowid);
      for (const h of r._history || []) hist.run(id, h.at, h.price);
    }
    return { inserted: rows.length, removed };
  });
}

function main(argv) {
  const args = Object.fromEntries(
    argv.map((a) => {
      const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
      return m ? [m[1], m[2] ?? true] : [a, true];
    })
  );
  if (args.help || args.h) {
    console.log('Použití: node tools/demo-data.js [--count=400] [--seed=42] [--db=SOUBOR] [--force] | --clear');
    return 0;
  }
  const config = loadConfig(process.env);
  const dbFile = typeof args.db === 'string' ? path.resolve(args.db) : config.dbFile;
  const db = openDb(dbFile);
  try {
    if (args.clear) {
      const n = clearDemo(db);
      console.log(`Smazáno ${n} demo inzerátů z ${dbFile}.`);
      return 0;
    }
    const real = realListingCount(db);
    if (real > 0 && !args.force) {
      console.error(
        [
          '',
          `  Databáze ${dbFile} už obsahuje ${real} skutečných inzerátů – ukázková data do ní nevložím`,
          '  (vymyšlené ceny by se míchaly do učení odhadu cen a do exportu).',
          '  Pro vyzkoušení použijte samostatnou databázi:  node tools/demo-data.js --db=data/demo.db',
          '  a spusťte server s ní (v nastaveni.txt řádek KOLOMAPA_DB=data/demo.db).  Vynutit: --force',
          '',
        ].join('\n')
      );
      return 1;
    }
    const count = Math.max(14, Math.min(20000, Number(args.count) || 400));
    const seed = Number.isFinite(Number(args.seed)) ? Number(args.seed) : 42;
    const r = seedDemo(db, { count, seed });
    console.log('');
    console.log('  POZOR: vloženy UKÁZKOVÉ (DEMO) inzeráty – nejsou skutečné!');
    console.log(`  ${r.inserted} demo inzerátů do ${dbFile}${r.removed ? ` (nahrazeno ${r.removed} starších)` : ''}.`);
    console.log('  Poznáte je podle params.demo = "1" a odkazu „#demo-…“. Smažete je: npm run demo-clear');
    console.log(`  Stav k ${nowIso()}.`);
    console.log('');
    return 0;
  } finally {
    db.close();
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { generateDemo, seedDemo, clearDemo, realListingCount, main };
