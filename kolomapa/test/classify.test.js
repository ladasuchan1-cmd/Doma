'use strict';
// Klasifikace inzerátů: kolo × nekolo, typ kola a vytěžení údajů z realistických českých titulků a popisů.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { classifyListing, CLASSIFIER_VERSION, BIKE_TYPES } = require('../src/classify');
const { parseCzk } = require('../src/util/text');

const NOW = '2026-10-02T12:00:00Z';
const C = (title, o = {}) => classifyListing({ source: 'bazos', title, description: o.d || '', params: o.params, categorySrc: o.cat ?? 'Horská kola', priceCzk: o.price ?? null, sellerType: o.seller }, { now: NOW });

test('verze klasifikátoru a taxonomie typů', () => {
  assert.equal(typeof CLASSIFIER_VERSION, 'string');
  for (const t of ['mtb_hardtail', 'mtb_full', 'road', 'gravel', 'kids', 'balance', 'ebike_mtb_full', 'ebike_trekking', 'other']) assert.ok(BIKE_TYPES.includes(t));
});

test('značky: aliasy, překlepy, víceslovné a S-Works', () => {
  const cases = [
    ['Specialised Stumpjumper Comp', 'Specialized'],
    ['S-Works Tarmac SL7', 'Specialized'],
    ['Canondale Trail 5 vel. M', 'Cannondale'],
    ["Kelly's Spider 30 horské kolo", 'Kellys'],
    ['Pánské kolo LEADFER FOX DAFT', 'Leader Fox'],
    ['Elektrokolo Crusis e-Atland 7.8', 'Crussis'],
    ['Rockmachine Blizzard 70', 'Rock Machine'],
    ['SANTA CRUZ Nomad CC', 'Santa Cruz'],
    ['Early Rider Belter 16', 'Early Rider'],
    ['Rockrider ST 520', 'Rockrider'],
    ['Focus Jam2 6.9 elektrokolo', 'Focus'],
    ['Riese & Müller Load 75', 'Riese & Müller'],
    ['Cervelo R5 Ultegra', 'Cervélo'],
    ['4ever Virtus 29', '4ever'],
  ];
  for (const [t, brand] of cases) assert.equal(C(t).features.brand, brand, t);
  // běžné slovo „focus“ malými písmeny není značka
  assert.equal(C('Horské kolo, focus na pohodlí').features.brand, undefined);
  assert.equal(C('Trek Slash 8').features.brandTier, 4);
  assert.equal(C('Woom 3').features.brandTier, 5);
});

test('model, rok, velikost rámu a typ z titulku', () => {
  const r = C('Trek Fuel EX 8 2021 vel. L', { price: 45000 });
  assert.equal(r.isBike, true);
  assert.equal(r.bikeType, 'mtb_full');
  assert.equal(r.features.model, 'Fuel EX 8');
  assert.equal(r.features.modelYear, 2021);
  assert.equal(r.features.ageYears, 5);
  assert.equal(r.features.frameSize, 'L');
  const s = C('SANTA CRUZ, V10 8 CC, S KIT, MX, L', { price: 139000 });
  assert.equal(s.features.frameSize, 'L');
  assert.equal(s.features.model, 'V10 8 CC');
  assert.equal(s.bikeType, 'mtb_full');
  assert.equal(C('Scott Addict Gravel 30', { cat: 'Silniční kola' }).bikeType, 'gravel');
  assert.equal(C('Giant TCR Advanced 2, Ultegra Di2 12s', { cat: 'Silniční kola' }).bikeType, 'road');
  assert.equal(C('Cannondale Habit HT 2 horské kolo').bikeType, 'mtb_hardtail');
});

test('rok modelu: r.v., model, MY, koupeno; ne servis/kilometry', () => {
  assert.equal(C('Kolo Author', { d: 'Prodám kolo r.v. 2019, málo jeté.' }).features.modelYear, 2019);
  assert.equal(C('Kolo Cube Stereo', { d: 'Modelový rok 2022, vel. L' }).features.modelYear, 2022);
  assert.equal(C('Canyon Spectral MY23').features.modelYear, 2023);
  assert.equal(C('Horské kolo Merida', { d: 'Kolo jsem koupil v roce 2020 v obchodě, najeto málo.' }).features.modelYear, 2020);
  assert.equal(C('Horské kolo Merida', { d: 'Zakoupeno 05/2021, doklad mám.' }).features.modelYear, 2021);
  const x = C('Horské kolo Kellys', { d: 'Najeto 2000 km, servis 2024, nové pláště 2025.' });
  assert.equal(x.features.modelYear, undefined);
  assert.equal(C('Dospělé horské kolo MaxBike', { d: 'Prodám asi 7 let staré horské kolo.' }).features.ageYears, 7);
  const v = C('Favorit r.v. 1956', { cat: 'Silniční kola' });
  assert.equal(v.features.vintageYear, 1956);
  assert.equal(v.features.isVintage, true);
  assert.equal(v.features.modelYear, undefined);
});

test('velikost kol: 27,5 / 650b / 700c / 29er, osy 12x148 nejsou kola', () => {
  assert.equal(C('Horské kolo Kellys 27,5"').features.wheelSize, '27.5');
  assert.equal(C('Gravel Marin Nicasio 650b', { cat: 'Silniční kola' }).features.wheelSize, '27.5');
  assert.equal(C('Silniční kolo Merida', { cat: 'Silniční kola', d: 'pláště 700x25c' }).features.wheelSize, '28');
  assert.equal(C('Trek Stache 29er').features.wheelSize, '29');
  assert.equal(C('Elektrokolo Haibike AllMtn CF 9', { cat: 'Elektrokola', d: 'rám karbon, kola 29", zadní osa Boost 12x148' }).features.wheelSize, '29');
  const kid = C('Dětské kolo Author Jet 16"', { cat: 'Ostatní cyklistika' });
  assert.equal(kid.bikeType, 'kids');
  assert.equal(kid.features.kidsWheel, '16');
});

test('velikost rámu: cm, palce, S1–S6, písmena', () => {
  assert.equal(C('Silniční kolo Author', { cat: 'Silniční kola', d: 'Velikost rámu 54cm.' }).features.frameSize, 'M');
  assert.equal(C('Horské kolo Superior', { d: 'rám 19", kola 29"' }).features.frameSize, 'L');
  assert.equal(C('Specialized Stumpjumper EVO S4').features.frameSize, 'L');
  assert.equal(C('Cube Reaction (M)').features.frameSize, 'M');
  assert.equal(C('Kolo Cube Aim', { d: 'velikost rámu 17,5"' }).features.frameSizeRaw, '17.5"');
});

test('e-kolo: motor, baterie, podtyp', () => {
  const a = C('Elektrokolo Kellys Tayen R10 P', { cat: 'Elektrokola', d: 'Motor Bosch Performance CX, baterie 625 Wh, rok 2022.' });
  assert.equal(a.bikeType, 'ebike_mtb');
  assert.equal(a.features.isEbike, true);
  assert.equal(a.features.motor, 'Bosch Performance CX');
  assert.equal(a.features.batteryWh, 625);
  assert.equal(C('Haibike AllMtn 7', { cat: 'Elektrokola' }).bikeType, 'ebike_mtb_full');
  assert.equal(C('Elektrokolo Crussis e-Cross 7.8', { cat: 'Elektrokola' }).bikeType, 'ebike_trekking');
  assert.equal(C('Elektrokolo', { cat: 'Elektrokola', d: 'Motor Shimano EP801, baterie 36V 14Ah' }).features.motor, 'Shimano EP8');
  assert.equal(C('Elektrokolo', { cat: 'Elektrokola', d: 'baterie 36V 14Ah' }).features.batteryWh, 504);
  assert.equal(C('Elektrokolo Giant Trance X E+ 2', { cat: 'Elektrokola', d: 'Yamaha PW-X3, 750Wh' }).features.motor, 'Yamaha PW-X3');
  assert.equal(C('Specialized Turbo Levo Comp', { cat: 'Elektrokola' }).bikeType, 'ebike_mtb_full');
  assert.equal(C('Horské kolo Trek Marlin 7').features.isEbike, undefined);
});

test('sada komponent a třída', () => {
  const g = (d, t = 'Horské kolo Merida') => C(t, { d }).features;
  assert.deepEqual([g('Přehazovačka Shimano Deore XT, brzdy SLX').groupset, g('Přehazovačka Shimano Deore XT').groupsetTier], ['Shimano XT', 5]);
  assert.equal(g('řazení SRAM GX Eagle 1x12').groupset, 'SRAM GX');
  assert.equal(g('', 'Silniční kolo Giant TCR Ultegra').groupsetTier, 5);
  assert.equal(g('sada Shimano 105 Di2').groupsetTier, 4.5);
  assert.equal(g('', 'Giant XTC Advanced 29').groupset, undefined); // XTC není XT
  assert.equal(g('105 kg nosnost').groupset, undefined);
});

test('stav kola včetně negace, opotřebení a dílů', () => {
  assert.equal(C('Kolo Author', { d: 'Kolo je jako nové, najeto 50 km.' }).features.condition, 'like_new');
  assert.equal(C('Kolo Author', { d: 'Rám není poškozený, velmi dobrý stav.' }).features.condition, 'very_good');
  assert.equal(C('Kolo Author', { d: 'Prakticky nepoužité.' }).features.condition, 'like_new');
  const p = C('Leader Fox Maxx 20" – na náhradní díly/renovaci', { cat: 'Horská kola', price: 500 });
  assert.equal(p.features.condition, 'parts');
  assert.ok(p.features.warnings.includes('Cena je za díly'));
  const s = C('Kolo Kellys', { d: 'Dobrý stav, potřebuje servis brzd.' });
  assert.equal(s.features.condition, 'good');
  assert.ok(s.features.warnings.includes('Nutný servis'));
  const cr = C('Kolo Kellys', { d: 'Bohužel prasklý rám u hlavové trubky.' });
  assert.ok(cr.features.warnings.includes('Prasklý rám'));
  assert.equal(C('Nové kolo Author Solution 2025', { price: 15000 }).features.condition, 'new');
});

test('původní cena, doklad, záruka, obchod', () => {
  const o = (d, price = 20000) => C('Horské kolo Trek', { d, price }).features.originalPriceCzk;
  assert.equal(o('Původní cena 45 000 Kč, nyní 20 000.'), 45000);
  assert.equal(o('PC 45k'), 45000);
  assert.equal(o('Nové za 45 tis., prodávám kvůli stěhování.'), 45000);
  assert.equal(o('Kupováno za 32.990,- Kč'), 32990);
  assert.equal(o('Najeto 1500 km, zachovalé.'), undefined);
  const f = C('Horské kolo Trek', { d: 'Doklad o koupi k dispozici, v záruce do 2027.' }).features;
  assert.equal(f.hasReceipt, true);
  assert.equal(f.warranty, true);
  assert.equal(C('Horské kolo Trek', { d: 'Bez dokladu.' }).features.hasReceipt, false);
  const shop = C('Nové elektrokolo Apache Matto 2026', { cat: 'Elektrokola', d: 'Nové kolo, záruka 2 roky, faktura s DPH, možnost splátek, skladem.' });
  assert.equal(shop.features.isShop, true);
  assert.equal(shop.features.condition, 'new');
});

test('nekola ve smíšené kategorii (díly, oblečení, nosiče, trenažéry, vozíky, koloběžky, motorky)', () => {
  const no = [
    'Vidlice RockShox Pike 150 mm',
    'Zapletená kola DT Swiss XM 1700',
    'Kola Mavic Ksyrium',
    'Pláště Schwalbe Nobby Nic 29x2.35',
    'Cyklistický dres Castelli vel. L',
    'Helma POC Kortal Race MIPS',
    'MTB boty tretry Five Ten',
    'Trenažér Elite Direto XR',
    'Spinningové kolo Brother',
    'Nosič kol Thule VeloSpace na tažné',
    'Dětská sedačka na kolo Hamax',
    'Vozík za kolo Croozer Kid',
    'Koloběžka Yedoo Mau',
    'Elektrická koloběžka Xiaomi Pro 2',
    'Pitbike 125 ccm',
    'Motorové kolo s benzínovým motorem',
    'Baterie Bosch PowerTube 625',
    'Zadní náboj Shimano XT FH-M8010',
    'Canyon Handlebar Bag',
    'Tyč na kolo',
  ];
  for (const t of no) {
    const r = C(t, { cat: 'Ostatní cyklistika', price: 1500 });
    assert.equal(r.isBike, false, `${t} → ${r.reason}`);
    assert.equal(r.bikeType, null);
  }
});

test('poptávky a služby nejsou kola', () => {
  assert.equal(C('Koupím horské kolo Trek', { cat: 'Horská kola' }).reason, 'poptávka');
  assert.equal(C('Sháním odrážedlo pro syna', { cat: 'Ostatní cyklistika' }).reason, 'poptávka');
  assert.equal(C('KOUPÍM BMX', { cat: 'Ostatní cyklistika' }).isBike, false);
  assert.equal(C('Půjčovna elektrokol Šumava', { cat: 'Elektrokola' }).isBike, false);
  assert.equal(C('Servis kol Praha 4 – rychle a levně', { cat: 'Ostatní cyklistika' }).isBike, false);
  // „po servisu“ ve skutečném inzerátu kola nevadí
  assert.equal(C('Kolo Author po servisu', { cat: 'Horská kola' }).isBike, true);
});

test('jen rám: kolo s příznakem isFrameOnly', () => {
  const r = C('Rám Santa Cruz Nomad carbon vel. L', { price: 30000 });
  assert.equal(r.isBike, true);
  assert.equal(r.features.isFrameOnly, true);
  assert.equal(r.bikeType, 'mtb_full');
  assert.ok(r.features.warnings.some((w) => /jen rám/i.test(w)));
  // „rám 19“ v titulku kola není „jen rám“
  assert.equal(C('Horské kolo Author, rám 19"').features.isFrameOnly, undefined);
});

test('dětská kola a odrážedla', () => {
  const w = C('Woom 4 20" modré', { cat: 'Ostatní cyklistika', price: 6000 });
  assert.equal(w.bikeType, 'kids');
  assert.equal(w.features.kidsWheel, '20');
  assert.equal(C('Odrážedlo Puky LR M', { cat: 'Ostatní cyklistika' }).bikeType, 'balance');
  assert.equal(C('Dětské kolo 16"', { cat: 'Ostatní cyklistika' }).bikeType, 'kids');
  assert.equal(C('Jízdní kolo Rock Machine Storm', { d: 'Dětské jízdní kolo vel. 24 v krásném stavu.' }).bikeType, 'kids');
  assert.equal(C('Kolo Merida i s dětskou sedačkou', { cat: 'Ostatní cyklistika' }).bikeType, 'other');
  assert.equal(C('BMX GT Performer 20.5', { cat: 'Ostatní cyklistika' }).bikeType, 'bmx');
});

test('parametry webu (Cyklobazar / Aukro) mají přednost a čtou se bez ohledu na diakritiku', () => {
  const r = C('Prodám kolo', {
    cat: 'Horská kola',
    params: { 'Velikost rámu': 'L', 'Rok výroby': '2021', Stav: 'Velmi dobrý', 'Značka': 'Specialized', 'Velikost kol': '29"', 'Materiál rámu': 'Karbon' },
  });
  assert.equal(r.features.brand, 'Specialized');
  assert.equal(r.features.modelYear, 2021);
  assert.equal(r.features.frameSize, 'L');
  assert.equal(r.features.wheelSize, '29');
  assert.equal(r.features.material, 'carbon');
  assert.equal(r.features.condition, 'very_good');
  const a = C('Author Traction – horské kolo 26", rám 19", modré + zadní nosič', {
    cat: 'Jízdní kola',
    params: { 'Materíál rámu': 'Dural', 'Průměr kol': '26″', 'Odpružení': 'Odpružená přední vidlice', 'Stav zboží': 'Použité', 'Značka': 'Author' },
  });
  assert.equal(a.isBike, true);
  assert.equal(a.features.material, 'alu');
  assert.equal(a.features.wheelSize, '26');
  assert.equal(a.features.suspension, 'hardtail');
  assert.equal(a.features.condition, 'good');
});

test('placeholder cena, více kol, podezřele levné bez dokladu', () => {
  const p = C('Horské kolo Specialized Rockhopper', { price: 1 });
  assert.equal(p.features.pricePlaceholder, true);
  assert.ok(p.features.warnings.some((w) => /symbolick/.test(w)));
  assert.equal(C('2x dámské kolo', { cat: 'Silniční kola' }).features.isMulti, true);
  const s = C('Specialized Stumpjumper Expert 2024', { price: 4500, d: 'Prodám rychle, bez dokladu.' });
  assert.ok(s.features.warnings.includes('Možná ukradené – chybí doklad a cena je podezřele nízká'));
});

test('ručně označené titulky z „Ostatní cyklistika“: přesnost ≥ 95 %', () => {
  const { labels } = require(path.join(__dirname, 'fixtures', 'classify-labels.json'));
  let ok = 0;
  let n = 0;
  for (const [title, lab] of Object.entries(labels)) {
    const r = classifyListing({ source: 'bazos', title, categorySrc: 'Ostatní cyklistika', priceCzk: parseCzk(lab.price) }, { now: NOW });
    n++;
    if (r.isBike === lab.isBike) ok++;
  }
  assert.ok(n >= 150);
  assert.ok(ok / n >= 0.95, `přesnost ${ok}/${n}`);
});
