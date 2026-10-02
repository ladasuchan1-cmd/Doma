'use strict';
// Evaluace klasifikátoru a nacenění na reálných datech (bez stahování – čte připravené soubory).
//
//   node tools/eval-pricing.js [--list bazos_list.jsonl] [--details bazos_details.jsonl] [--folds 5] [--seed 7]
//   (výchozí adresář s daty: $KOLOMAPA_EVAL_DIR nebo data/eval/)
//
// Formát dat: JSON Lines.
//   list:    {id, title, price_formatted ('12 500 Kč' | 'Dohodou' …), category, locality, from, views, url, topped}
//   details: {id, description, price, price_type, zip_code, locality, latitude, longitude, category, images, listCategory, params?}
//
// Výstup: počty kolo × nekolo, přesnost na ručně označených titulcích (test/fixtures/classify-labels.json),
// 40 náhodných rozhodnutí z „Ostatní cyklistika“, 5× křížová validace nacenění na inzerovaných cenách
// (MdAPE a podíl odhadů v ±25 % podle typu, s / bez srovnatelných), pokrytí rozpětí a kalibrace jistoty,
// a vyhodnocení na skutečných prodejích obchodu (training/koloshop-prodeje.json).

process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');
const { openDb, parseJson } = require('../src/db');
const { upsertItem, classifyPending } = require('../src/pipeline');
const { classifyListing } = require('../src/classify');
const pricing = require('../src/pricing');
const { parseCzk, parseCzDate, hash } = require('../src/util/text');

const { _internal: P } = pricing;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const dir = process.env.KOLOMAPA_EVAL_DIR || path.join(__dirname, '..', 'data', 'eval');
const listFile = arg('list', path.join(dir, 'bazos_list.jsonl'));
const detailsFile = arg('details', path.join(dir, 'bazos_details.jsonl'));
const FOLDS = Number(arg('folds', 5));
let seed = Number(arg('seed', 7));
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const NOW = new Date(arg('now', '2026-10-02T12:00:00Z'));

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // poškozený řádek (soubor se může zrovna zapisovat)
    }
  }
  return out;
}

const pctS = (x) => `${(x * 100).toFixed(1)} %`;
const med = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function main() {
  const list = readJsonl(listFile);
  if (!list.length) {
    console.error(`Chybí data: ${listFile}\nPoužití: node tools/eval-pricing.js --list <bazos_list.jsonl> --details <bazos_details.jsonl>`);
    process.exit(1);
  }
  const details = new Map(readJsonl(detailsFile).map((d) => [String(d.id), d]));
  console.log(`Data: ${list.length} inzerátů z výpisu, ${details.size} s detailem\n`);

  // --- 1) DB v paměti + klasifikace přes pipeline
  const db = openDb(':memory:');
  const t0 = Date.now();
  const at = NOW.toISOString();
  db.exec('BEGIN');
  for (const r of list) {
    const d = details.get(String(r.id));
    const priceText = d?.price_formatted || r.price_formatted;
    const price = /\d/.test(String(priceText || '')) ? parseCzk(priceText) : null;
    upsertItem(
      db,
      'bazos',
      {
        sourceId: String(r.id),
        url: r.url || `https://www.bazos.cz/inzerat/${r.id}/`,
        title: r.title,
        description: d?.description || null,
        priceCzk: price,
        priceNote: price == null ? priceText || null : null,
        postedAt: r.from ? new Date(String(r.from).replace(' ', 'T')).toISOString?.() || null : null,
        categorySrc: d?.listCategory || r.category,
        locationText: d?.locality || r.locality || null,
        views: Number(r.views) || null,
        photoUrl: d?.images?.[0] || r.image_thumbnail || null,
        params: d?.params || {},
      },
      at
    );
  }
  db.exec('COMMIT');
  classifyPending(db, { all: true });
  console.log(`Uloženo a klasifikováno za ${Date.now() - t0} ms`);

  // --- 2) Klasifikace: počty
  const rows = db.prepare('SELECT id, source, url, title, description, price_czk, category_src, is_bike, bike_type, features, gone_at FROM listings').all();
  const byCat = {};
  for (const r of rows) {
    const c = (byCat[r.category_src] ||= { bike: 0, nonBike: 0, types: {}, reasons: {} });
    const f = parseJson(r.features, {});
    if (r.is_bike) {
      c.bike++;
      c.types[r.bike_type] = (c.types[r.bike_type] || 0) + 1;
    } else {
      c.nonBike++;
      c.reasons[f._reason] = (c.reasons[f._reason] || 0) + 1;
    }
  }
  console.log('\n=== Klasifikace podle kategorie Bazoše ===');
  for (const [cat, c] of Object.entries(byCat)) {
    console.log(`${pad(cat, 20)} kola ${lpad(c.bike, 5)}  nekola ${lpad(c.nonBike, 5)}  (${pctS(c.bike / (c.bike + c.nonBike))} kol)`);
    console.log(`   typy: ${Object.entries(c.types).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    console.log(`   nekola: ${Object.entries(c.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }

  // ručně označené titulky
  const labelsFile = path.join(__dirname, '..', 'test', 'fixtures', 'classify-labels.json');
  for (const lf of [labelsFile, labelsFile.replace('.json', '-holdout.json')]) {
    if (!fs.existsSync(lf)) continue;
    const L = JSON.parse(fs.readFileSync(lf, 'utf8')).labels;
    let ok = 0;
    let n = 0;
    let tOk = 0;
    let tN = 0;
    const cm = { tp: 0, fp: 0, fn: 0, tn: 0 };
    const misses = [];
    const lenient = { other: ['city', 'trekking', 'cross', 'road', 'other'], dirt: ['dirt', 'mtb_hardtail'], trekking: ['trekking', 'cross'], cross: ['cross', 'trekking'] };
    for (const [title, lab] of Object.entries(L)) {
      const c = classifyListing({ source: 'bazos', title, categorySrc: lab.category || 'Ostatní cyklistika', priceCzk: parseCzk(lab.price) });
      n++;
      if (c.isBike === lab.isBike) ok++;
      else misses.push(`${lab.isBike ? 'mělo být KOLO' : 'mělo být nekolo'}: ${title} (${c.reason})`);
      if (lab.isBike && c.isBike) cm.tp++;
      else if (!lab.isBike && c.isBike) cm.fp++;
      else if (lab.isBike && !c.isBike) cm.fn++;
      else cm.tn++;
      if (lab.isBike && c.isBike) {
        tN++;
        if (c.bikeType === lab.bikeType || lab.bikeType === 'any' || (lab.bikeType === 'ebike' && /^ebike_/.test(c.bikeType)) || (lenient[lab.bikeType] || []).includes(c.bikeType)) tOk++;
        else misses.push(`typ ${lab.bikeType} → ${c.bikeType}: ${title}`);
      }
    }
    console.log(`\n=== Ručně označené titulky (${path.basename(lf)}) ===`);
    console.log(`kolo × nekolo: přesnost ${ok}/${n} = ${pctS(ok / n)}; precision ${pctS(cm.tp / (cm.tp + cm.fp))}, recall ${pctS(cm.tp / (cm.tp + cm.fn))}; typ kola ${tOk}/${tN} = ${pctS(tOk / Math.max(1, tN))}`);
    for (const m of misses) console.log(`   ✗ ${m}`);
  }

  // 40 náhodných rozhodnutí z „Ostatní cyklistika“
  console.log('\n=== 40 náhodných rozhodnutí – Ostatní cyklistika ===');
  const ost = rows.filter((r) => r.category_src === 'Ostatní cyklistika');
  const sample = ost.map((r) => [rnd(), r]).sort((a, b) => a[0] - b[0]).slice(0, 40).map((x) => x[1]);
  for (const r of sample) {
    const f = parseJson(r.features, {});
    console.log(`${r.is_bike ? 'KOLO  ' : 'nekolo'} ${pad(r.bike_type || '', 14)} ${lpad(r.price_czk ?? '-', 7)} | ${pad(r.title.slice(0, 60), 60)} | ${f._reason}${f.brand ? ` | ${f.brand}` : ''}`);
  }

  // --- 3) Křížová validace nacenění (inzerované ceny)
  const bikeRows = rows.filter((r) => r.is_bike === 1 && r.price_czk != null);
  const items = bikeRows.map(pricing.normItem).filter((it) => P.trainable(it));
  const withDesc = new Set(bikeRows.filter((r) => r.description && r.description.length > 30).map((r) => r.id));
  console.log(`\n=== Nacenění: ${FOLDS}× křížová validace na inzerovaných cenách (${items.length} použitelných kol z ${bikeRows.length}) ===`);
  const fold = (it) => parseInt(hash(String(it.id)), 16) % FOLDS;
  const variants = {
    'model+srovnatelné': { useComps: true },
    'jen model': { useComps: false },
    'model bez slov z titulku': { useComps: true, useTokens: false },
  };
  const res = {};
  const covRecs = [];
  let tTrain = 0;
  for (let k = 0; k < FOLDS; k++) {
    const train = items.filter((it) => fold(it) !== k);
    const test = items.filter((it) => fold(it) === k);
    const t1 = Date.now();
    const model = pricing.trainFromRows(train, { sales: [], oof: true });
    tTrain += Date.now() - t1;
    const coreNoTok = P.fitCore(train, { useTokens: false });
    for (const it of test) {
      const truth = Math.log(it.price);
      const out = {
        'model+srovnatelné': P.rawLogEstimate(model.core, it, { useComps: true }),
        'jen model': P.rawLogEstimate(model.core, it, { useComps: false }),
        'model bez slov z titulku': P.rawLogEstimate(coreNoTok, it, { useComps: true }),
        'jen pravidla (kb.json)': { lp: Math.log(pricing.rulesEstimate(it).value), comps: [] },
      };
      for (const [name, r] of Object.entries(out)) {
        (res[name] ||= []).push({ type: it.bikeType, ape: Math.abs(Math.exp(r.lp - truth) - 1), comps: r.comps.length, brand: !!it.f.brand, model: !!it.f.model, desc: withDesc.has(it.id) });
      }
      // pokrytí rozpětí a kalibrace jistoty (na úrovni inzerovaných cen → bez kalibrační konstanty)
      const e = pricing.estimate({ ...model, calibration: { factor: 1 } }, it);
      const lowA = e.low;
      const highA = e.high;
      covRecs.push({ conf: e.confidence, within: Math.abs(Math.exp(out['model+srovnatelné'].lp) / it.price - 1) <= pricing.CONF_TOLERANCE, covered: it.price >= lowA && it.price <= highA, method: e.method });
    }
    process.stdout.write(`  fold ${k + 1}/${FOLDS} hotov\r`);
  }
  console.log(`  trénink: průměrně ${Math.round(tTrain / FOLDS)} ms na model (vč. 3× vnitřní CV pro rozpětí)        `);
  const summarize = (arr) => ({ n: arr.length, mdape: med(arr.map((x) => x.ape)), w25: arr.filter((x) => x.ape <= 0.25).length / Math.max(1, arr.length) });
  const types = [...new Set(items.map((it) => it.bikeType))].sort((a, b) => items.filter((i) => i.bikeType === b).length - items.filter((i) => i.bikeType === a).length);
  const names = Object.keys(res);
  console.log(`\n${pad('typ kola', 16)} ${lpad('n', 5)} | ${names.map((n) => pad(`${n} MdAPE / ±25 %`, 34)).join('| ')}`);
  for (const t of ['*', ...types]) {
    const cells = names.map((n) => {
      const arr = t === '*' ? res[n] : res[n].filter((x) => x.type === t);
      const s = summarize(arr);
      return pad(`${pctS(s.mdape)} / ${pctS(s.w25)}`, 34);
    });
    const cnt = t === '*' ? items.length : items.filter((i) => i.bikeType === t).length;
    if (cnt < 10) continue;
    console.log(`${pad(t === '*' ? 'VŠE' : t, 16)} ${lpad(cnt, 5)} | ${cells.join('| ')}`);
  }
  const withC = res['model+srovnatelné'].filter((x) => x.comps >= 3);
  const withC1 = res['model+srovnatelné'].filter((x) => x.comps >= 1 && x.comps < 3);
  const noBrand = res['model+srovnatelné'].filter((x) => !x.brand);
  const bm = res['model+srovnatelné'].filter((x) => x.brand && x.model);
  const dsc = res['model+srovnatelné'].filter((x) => x.desc);
  const dscNo = res['jen model'].filter((x) => x.desc);
  console.log(`\nPodle důkazů (model+srovnatelné): ≥3 srovnatelné ${withC.length}× MdAPE ${pctS(summarize(withC).mdape)} (±25 %: ${pctS(summarize(withC).w25)}); 1–2 srovnatelné ${withC1.length}× ${pctS(summarize(withC1).mdape)}; značka+model ${bm.length}× ${pctS(summarize(bm).mdape)}; bez značky ${noBrand.length}× ${pctS(summarize(noBrand).mdape)}`);
  console.log(`S plným popisem (detail): ${dsc.length}× MdAPE ${pctS(summarize(dsc).mdape)} (±25 %: ${pctS(summarize(dsc).w25)}); jen model ${pctS(summarize(dscNo).mdape)}`);
  // pokrytí intervalu a kalibrace jistoty
  const cov = covRecs.filter((r) => r.covered).length / covRecs.length;
  console.log(`Pokrytí rozpětí low–high (cíl 80 %): ${pctS(cov)}`);
  console.log(`Kalibrace jistoty (jistota ≈ pravděpodobnost, že inzerovaná cena leží v ±${pricing.CONF_TOLERANCE * 100} % odhadu); podíl s jistotou ≥ 0,45: ${pctS(covRecs.filter((r) => r.conf >= 0.45).length / covRecs.length)}`);
  for (const [a, b] of [[0, 0.3], [0.3, 0.45], [0.45, 0.6], [0.6, 0.75], [0.75, 1.01]]) {
    const g = covRecs.filter((r) => r.conf >= a && r.conf < b);
    if (!g.length) continue;
    const meanConf = g.reduce((s, r) => s + r.conf, 0) / g.length;
    console.log(`   jistota ${a.toFixed(2)}–${Math.min(1, b).toFixed(2)}: ${lpad(g.length, 5)}× průměr ${meanConf.toFixed(2)}, skutečně v toleranci: ${pctS(g.filter((r) => r.within).length / g.length)}`);
  }

  // --- 4) Vlastní prodeje obchodu (skutečné prodejní ceny)
  const sales = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'training', 'koloshop-prodeje.json'), 'utf8')).sales;
  const full = pricing.trainFromRows(items, { sales, oof: true });
  console.log(`\n=== Vlastní prodeje obchodu (${sales.length}) ===`);
  console.log(`Model: ${JSON.stringify(full.summary)}`);
  const cal = full.calibration;
  console.log(`Kalibrace: medián skutečná / inzerovaná-odhad u BAZAR = ${cal.shopRatio?.toFixed(3)} (n = ${cal.n}), apriorno ${cal.prior}, výsledný faktor ×${cal.factor.toFixed(3)}; výkupní poměr ${full.buyRatio.toFixed(3)}`);
  const rowsOut = [];
  for (const kind of ['bazar', 'provereno']) {
    const apes = [];
    const apesAsk = [];
    for (let i = 0; i < sales.length; i++) {
      const s = sales[i];
      if (s.kind !== kind) continue;
      const title = s.size ? `${s.title} vel. ${s.size}` : s.title;
      const c = classifyListing({ title, priceCzk: null });
      if (!c.isBike) continue;
      const it = pricing.normItem({ title, features: c.features, bike_type: c.bikeType, is_bike: 1 });
      const asking = Math.exp(P.askingLog(full, it).lp);
      // leave-one-out kalibrace (bez tohoto prodeje)
      const others = sales.filter((_, j) => j !== i);
      const calLoo = kind === 'bazar' ? P.calibrate(full, others).factor : cal.factor;
      const pred = asking * calLoo;
      apes.push(Math.abs(pred / s.priceCzk - 1));
      apesAsk.push(Math.abs(asking / s.priceCzk - 1));
      rowsOut.push(`${pad(kind, 9)} ${lpad(s.priceCzk, 7)} ${lpad(Math.round(pred), 7)} ${lpad(`${((pred / s.priceCzk - 1) * 100).toFixed(0)} %`, 6)} | ${s.title.slice(0, 55)} [${c.bikeType}${c.features.modelYear ? ` ${c.features.modelYear}` : ''}]`);
    }
    console.log(`${kind.toUpperCase()}: ${apes.length} kol, MdAPE ${pctS(med(apes))} (bez kalibrace ${pctS(med(apesAsk))}), v ±25 %: ${pctS(apes.filter((a) => a <= 0.25).length / apes.length)}`);
  }
  console.log(`\n${pad('druh', 9)} ${lpad('skut.', 7)} ${lpad('odhad', 7)} ${lpad('chyba', 6)} | titulek`);
  for (const r of rowsOut) console.log(r);
}

main();
