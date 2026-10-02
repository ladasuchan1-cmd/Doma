'use strict';
// Nacenění kol: tržní hodnota (za kolik se kolo skutečně prodá), rozpětí, jistota, vysvětlení, výhodnost inzerátu
// a doporučená max. výkupní cena pro obchod.
//
// Odhad se skládá ze tří zdrojů:
//  a) naučený model – robustní (Huberova) ridge regrese log(ceny) nad inzerovanými cenami z DB (aktivní i zmizelé
//     inzeráty; zmizelé = pravděpodobně prodané, mají vyšší váhu). Příznaky: typ kola, třída značky + odchylky
//     častých značek, sada komponent, stáří, materiál, motor a baterie e-kol, velikost kol (děti), stav, původní cena
//     z textu, příznaky (jen rám, obchod, retro …) a slova z titulků (modely: „stumpjumper“, „levo“, „woom“ …);
//  b) srovnatelné inzeráty – stejná značka + model (± rok): medián jejich odchylky od modelu posune odhad
//     („náhodný efekt“ modelu kola, smrštěný podle počtu shod);
//  c) pravidla z kb.json – cena nového kola × amortizace × stav (nebo původní cena z textu); slabá váha, při malém
//     množství dat (< MIN_TRAIN kol) jediný zdroj.
// Výsledek je na úrovni INZEROVANÝCH cen → převod na SKUTEČNÉ prodejní ceny kalibrací na vlastní prodeje obchodu
// (BAZAR, medián skutečná / odhad) kombinovanou s apriorním poměrem kb.askToSale.
// Rozpětí (low/high) a jistota vycházejí z rozdělení chyb na odložených datech (3násobná křížová validace při
// tréninku) podle „třídy důkazů“ (značka? model? rok? srovnatelné?). Jistota = odhadnutá pravděpodobnost, že
// skutečná cena leží v ±25 % odhadu.

const fs = require('node:fs');
const path = require('node:path');
const { tx, nowIso, parseJson } = require('../db');
const { keyOf } = require('../util/text');
const { classifyListing } = require('../classify');
const { toCsr, huberRidge, median } = require('./ridge');
const KB = require('./kb.json');

const MODEL_VERSION = 1;
/** Pod tento počet použitelných kol se model neučí a naceňuje se jen podle pravidel. */
const MIN_TRAIN = 300;
const TRAINING_SALES_FILE = path.join(__dirname, '..', '..', 'training', 'koloshop-prodeje.json');

// Penalizace (λ) skupin příznaků – vyšší = silnější smrštění k průměru (laděno křížovou validací, viz tools/eval-pricing.js)
const LAMBDA = {
  b0: 0,
  type: 1,
  tier: 1,
  brand: 2,
  brandE: 4,
  gs: 1,
  gsf: 3,
  age: 1,
  eage: 2,
  kage: 2,
  mat: 1,
  motor: 2,
  bat: 2,
  kw: 1,
  wh: 2,
  cond: 1,
  flag: 2,
  orig: 0.5,
  tok: 4,
  bm: 3,
  src: 3,
};
const MIN_COUNT = { brand: 3, brandE: 5, tok: 4, bm: 3 };

const TYPE_LABEL = {
  mtb_hardtail: 'horské kolo (hardtail)',
  mtb_full: 'celoodpružené horské kolo',
  road: 'silniční kolo',
  gravel: 'gravel',
  cyclocross: 'cyklokrosové kolo',
  trekking: 'trekingové kolo',
  cross: 'krosové kolo',
  city: 'městské kolo',
  kids: 'dětské kolo',
  balance: 'odrážedlo',
  bmx: 'BMX',
  dirt: 'dirt / street',
  fatbike: 'fatbike',
  folding: 'skládací kolo',
  cargo: 'nákladní kolo',
  tandem: 'tandem',
  ebike_mtb: 'horské elektrokolo',
  ebike_mtb_full: 'celoodpružené elektrokolo',
  ebike_trekking: 'trekingové / krosové elektrokolo',
  ebike_city: 'městské elektrokolo',
  ebike_road: 'silniční / gravel elektrokolo',
  ebike_cargo: 'nákladní elektrokolo',
  ebike_kids: 'dětské elektrokolo',
  other: 'kolo (typ neurčen)',
};
const COND_LABEL = { new: 'nové', like_new: 'jako nové', very_good: 'velmi dobrý', good: 'dobrý', fair: 'opotřebené', poor: 'špatný', parts: 'na díly' };

const TOKEN_STOP = new Set(
  'prodam prodej prodavam kolo kola jizdni na a s se v ve z za do pro i nove novy nova vel velikost ram ramu cm kc top super stav cena levne horske silnicni elektrokolo damske panske detske the and'.split(' ')
);
const MODEL_GENERIC = new Set(
  'turbo e s works sworks carbon karbon pro comp expert elite sport team race sl al cf advanced hybrid new nove novy model 29 27 5 26 28 mx fsr ltd edition evo plus jr junior lady wmn women damske damsky men pansky'.split(' ')
);

// ---------------------------------------------------------------------------------------------------------------
// Pomocníci

const fmtCzk = (n) => `${Math.round(n).toLocaleString('cs-CZ').replace(/ /g, ' ')} Kč`;
const fmtNum = (n, d = 2) => Number(n).toFixed(d).replace('.', ',');
const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)} %`;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** Zaokrouhlení odhadu na „lidské“ částky. */
function roundCzk(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 2000) return Math.round(n / 50) * 50;
  if (n < 10000) return Math.round(n / 100) * 100;
  if (n < 50000) return Math.round(n / 500) * 500;
  return Math.round(n / 1000) * 1000;
}

/**
 * Cena, kterou nelze brát vážně (placeholder): < 300 Kč, 1234, 12345, 99999999 …
 * @param {number|null} p
 */
function isPlaceholderPrice(p) {
  if (p == null || !Number.isFinite(Number(p))) return true;
  const n = Number(p);
  if (n < 300 || n >= 2000000) return true;
  const s = String(Math.round(n));
  return /^(1234|12345|123456|1111+|9999+|11111+)$/.test(s);
}

function familyOf(type) {
  if (!type) return 'other';
  if (type === 'kids' || type === 'balance' || type === 'ebike_kids') return 'kids';
  if (type.startsWith('ebike_')) return 'ebike';
  if (type === 'road' || type === 'gravel' || type === 'cyclocross') return 'road';
  if (type.startsWith('mtb_') || type === 'dirt' || type === 'fatbike') return 'mtb';
  return 'other';
}

function ageBucket(a) {
  if (a == null) return 'none';
  if (a <= 0) return '0';
  if (a <= 1) return '1';
  if (a <= 2) return '2';
  if (a <= 3) return '3';
  if (a <= 5) return '4-5';
  if (a <= 7) return '6-7';
  if (a <= 10) return '8-10';
  if (a <= 15) return '11-15';
  if (a <= 25) return '16-25';
  return '26+';
}

function kidsWheelKey(w) {
  if (!w) return 'unknown';
  const n = Number(w);
  if (n <= 12) return '12';
  if (n <= 14) return '14';
  if (n <= 16) return '16';
  if (n <= 20) return '20';
  if (n <= 24) return '24';
  return '26+';
}

function interp(curve, x) {
  const pts = Object.entries(curve)
    .map(([k, v]) => [Number(k), v])
    .filter(([k]) => Number.isFinite(k))
    .sort((a, b) => a[0] - b[0]);
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

/**
 * Sjednotí řádek z DB / objekt inzerátu na interní tvar.
 * Neklasifikovaný inzerát (bez features) se klasifikuje za běhu.
 */
function normItem(l) {
  if (l && l._norm) return l;
  let f = typeof l.features === 'string' ? parseJson(l.features, {}) : l.features || {};
  let bikeType = l.bike_type ?? l.bikeType ?? null;
  let isBike = l.is_bike ?? l.isBike;
  const price = l.price_czk ?? l.priceCzk ?? null;
  if ((!f || !Object.keys(f).length || isBike == null) && l.title) {
    const c = classifyListing({
      source: l.source,
      title: l.title,
      description: l.description,
      params: typeof l.params === 'string' ? parseJson(l.params, {}) : l.params,
      categorySrc: l.category_src ?? l.categorySrc,
      priceCzk: price,
      sellerType: l.seller_type ?? l.sellerType,
    });
    f = c.features;
    bikeType = c.bikeType;
    isBike = c.isBike ? 1 : 0;
  }
  return {
    id: l.id ?? null,
    title: l.title || '',
    url: l.url || null,
    source: l.source || null,
    price: price == null ? null : Number(price),
    bikeType: bikeType || (isBike ? 'other' : null),
    isBike: isBike === true || isBike === 1,
    gone: !!(l.gone_at ?? l.goneAt),
    f: f || {},
    _norm: true,
  };
}

function modelTokens(it) {
  const m = keyOf(it.f.model || '');
  if (!m) return { first: null, toks: [] };
  const toks = m.split(' ').filter(Boolean);
  const first = toks.find((t) => !MODEL_GENERIC.has(t) && !/^\d+$/.test(t)) || null;
  return { first, toks };
}

function titleTokens(title) {
  const out = new Set();
  for (const t of keyOf(title).split(' ')) {
    if (!t || TOKEN_STOP.has(t)) continue;
    if (t.length < 2 && !/\d/.test(t)) continue;
    if (/^(19|20)\d\d$/.test(t)) continue;
    if (/^\d{5,}$/.test(t)) continue;
    out.add(t);
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------------------------
// Pravidla (kb.json)

/**
 * Odhad podle pravidel: cena nového (typ × třída značky, sada komponent, e-kolo) nebo původní cena z textu
 * × amortizace podle stáří × stav × (jen rám / retro / obchod). Úroveň inzerovaných cen.
 * @returns {{value: number, factors: string[], newPrice: number}}
 */
function rulesEstimate(it, kb = KB) {
  const f = it.f;
  const type = it.bikeType || 'other';
  const fam = familyOf(type);
  const tier = clamp(Math.round(f.brandTier || 2), 1, 5);
  const factors = [];
  let newP;
  if (type === 'kids' || type === 'ebike_kids') {
    newP = kb.kidsNewPrice[kidsWheelKey(f.kidsWheel || f.wheelSize)][tier - 1];
    if (type === 'ebike_kids') newP = Math.max(newP * 2.5, kb.newPrice.ebike_kids[tier - 1]);
  } else newP = (kb.newPrice[type] || kb.newPrice.other)[tier - 1];
  const gsTable = fam === 'ebike' ? kb.groupsetNewPrice.ebike : kb.groupsetNewPrice[type] || (fam === 'road' ? kb.groupsetNewPrice.road : fam === 'mtb' ? kb.groupsetNewPrice.mtb_hardtail : null);
  if (f.groupsetTier && gsTable && fam !== 'kids') {
    const g = interp(gsTable, f.groupsetTier);
    newP = Math.sqrt(newP * g);
  }
  if (fam === 'ebike') {
    const mc = kb.ebike.motorClass[f.motorClass] || 1;
    newP *= mc;
    if (f.batteryWh) newP *= clamp(1 + (kb.ebike.batteryPer100Wh * (f.batteryWh - kb.ebike.batteryRefWh)) / 100, 0.8, 1.3);
  }
  if (f.material === 'carbon' && fam !== 'kids') newP *= 1.25;
  let base = newP;
  if (f.originalPriceCzk) {
    base = Math.exp(0.75 * Math.log(f.originalPriceCzk) + 0.25 * Math.log(newP));
    factors.push(`Původní cena ${fmtCzk(f.originalPriceCzk)} (z textu)`);
  }
  const premiumKids = fam === 'kids' && tier >= 4;
  const curveKey = fam === 'ebike' ? 'ebike' : fam === 'kids' ? (premiumKids ? 'kidsPremium' : 'kids') : 'default';
  const dep = f.ageYears != null ? interp(kb.depreciation[curveKey], f.ageYears) : kb.depreciation.unknownAge[curveKey] ?? kb.depreciation.unknownAge.default;
  let v = base * dep;
  const cm = kb.condition[f.condition] ?? 1;
  v *= cm;
  if (f.isFrameOnly) v *= kb.frameOnly;
  if (f.isVintage) v *= kb.vintage;
  if (f.isShop) v *= kb.shop;
  return { value: Math.max(150, v), factors, newPrice: newP };
}

// ---------------------------------------------------------------------------------------------------------------
// Příznaky regrese

/** Surové příznaky jednoho inzerátu: [název, hodnota, skupina]. */
function rawFeatures(it) {
  const f = it.f;
  const type = it.bikeType || 'other';
  const fam = familyOf(type);
  const out = [['b0', 1, 'b0'], [`type:${type}`, 1, 'type']];
  out.push([`tier:${f.brandTier || 'none'}`, 1, 'tier']);
  if (f.brand) {
    out.push([`brand:${f.brand}`, 1, 'brand']);
    if (fam === 'ebike') out.push([`brandE:${f.brand}`, 1, 'brandE']);
  }
  const gs = f.groupsetTier ? String(Math.round(f.groupsetTier)) : 'none';
  out.push([`gs:${gs}`, 1, 'gs']);
  if (f.groupsetTier) out.push([`gsf:${fam}:${gs}`, 1, 'gsf']);
  const ab = ageBucket(f.ageYears);
  out.push([`age:${ab}`, 1, 'age']);
  if (fam === 'ebike') out.push([`eage:${ab}`, 1, 'eage']);
  if (fam === 'kids') out.push([`kage:${ab}`, 1, 'kage']);
  out.push([`mat:${f.material || 'none'}`, 1, 'mat']);
  if (fam === 'ebike') {
    out.push([`motor:${f.motorClass || 'none'}`, 1, 'motor']);
    if (f.batteryWh) out.push(['bat', clamp((f.batteryWh - 500) / 250, -1.5, 2.5), 'bat']);
    else out.push(['bat:none', 1, 'bat']);
  }
  if (fam === 'kids') out.push([`kw:${kidsWheelKey(f.kidsWheel || f.wheelSize)}`, 1, 'kw']);
  else out.push([`wh:${f.wheelSize || 'none'}`, 1, 'wh']);
  out.push([`cond:${f.condition || 'none'}`, 1, 'cond']);
  if (f.isFrameOnly) out.push(['frame', 1, 'flag']);
  if (f.isShop) out.push(['shop', 1, 'flag']);
  if (f.isVintage) out.push(['vintage', 1, 'flag']);
  if (f.hasReceipt === true) out.push(['receipt', 1, 'flag']);
  if (f.warranty === true) out.push(['warranty', 1, 'flag']);
  if (f.electronicShifting) out.push(['elec', 1, 'flag']);
  if (f.originalPriceCzk) out.push(['orig', Math.log(f.originalPriceCzk) - 10.2, 'orig']);
  else out.push(['orig:none', 1, 'orig']);
  if (it.source) out.push([`src:${it.source}`, 1, 'src']);
  const toks = titleTokens(it.title);
  const w = toks.length ? 1 / Math.sqrt(Math.max(1, toks.length / 4)) : 0;
  for (const t of toks) out.push([`tok:${t}`, w, 'tok']);
  if (process.env.KM_BIGRAMS) {
    const seq = keyOf(it.title).split(' ').filter((t) => t && !TOKEN_STOP.has(t));
    for (let i = 0; i + 1 < seq.length; i++) out.push([`bi:${seq[i]}_${seq[i + 1]}`, w, 'tok']);
  }
  const mt = modelTokens(it);
  if (f.brand && mt.first) out.push([`bm:${keyOf(f.brand)}|${mt.first}`, 1, 'bm']);
  return out;
}

function buildVocab(items, { minCount = MIN_COUNT, lambda = LAMBDA } = {}) {
  const counts = new Map();
  for (const it of items) for (const [name, , g] of rawFeatures(it)) {
    if (!(g in minCount)) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const index = new Map();
  const groups = [];
  const lam = [];
  for (const it of items) {
    for (const [name, , g] of rawFeatures(it)) {
      if (index.has(name)) continue;
      if (g in minCount && (counts.get(name) || 0) < minCount[g]) continue;
      index.set(name, index.size);
      groups.push(g);
      lam.push(lambda[g] ?? 1);
    }
  }
  return { index, groups, lambda: Float64Array.from(lam) };
}

function featurize(it, vocab) {
  const row = [];
  for (const [name, v, g] of rawFeatures(it)) {
    const j = vocab.index.get(name);
    if (j != null) row.push([j, v, g]);
  }
  return row;
}

// ---------------------------------------------------------------------------------------------------------------
// Srovnatelné inzeráty

function buildCompIndex(entries) {
  const byBrand = new Map();
  for (const e of entries) {
    if (!e.brandKey) continue;
    if (!byBrand.has(e.brandKey)) byBrand.set(e.brandKey, []);
    byBrand.get(e.brandKey).push(e);
  }
  return byBrand;
}

function compEntry(it, resid) {
  const mt = modelTokens(it);
  return {
    id: it.id,
    brandKey: it.f.brand ? keyOf(it.f.brand) : null,
    first: mt.first,
    toks: new Set(mt.toks),
    year: it.f.modelYear || null,
    ebike: familyOf(it.bikeType) === 'ebike',
    kids: familyOf(it.bikeType) === 'kids',
    frame: !!it.f.isFrameOnly,
    price: it.price,
    resid,
    title: it.title,
    url: it.url,
    gone: it.gone,
  };
}

/**
 * Najde srovnatelné inzeráty: stejná značka, stejný základ modelu (např. „stumpjumper“), e-kolo × kolo, ± rok.
 * @returns {Array<{entry: object, score: number}>}
 */
function findCompEntries(index, it, n = 12) {
  if (!index || !it.f.brand) return [];
  const list = index.get(keyOf(it.f.brand));
  if (!list) return [];
  const mt = modelTokens(it);
  if (!mt.first) return [];
  const ebike = familyOf(it.bikeType) === 'ebike';
  const kids = familyOf(it.bikeType) === 'kids';
  const frame = !!it.f.isFrameOnly;
  const year = it.f.modelYear || null;
  const out = [];
  for (const e of list) {
    if (e.first !== mt.first) continue;
    if (it.id != null && e.id === it.id) continue;
    if (e.ebike !== ebike || e.kids !== kids || e.frame !== frame) continue;
    let score = 3;
    for (const t of mt.toks) if (t !== mt.first && e.toks.has(t)) score += 1;
    for (const t of e.toks) if (t !== mt.first && !mt.toks.includes(t) && /\d|^(s|works|sworks|pro|expert|comp|elite|team|sl|race|base|sport|evo)$/.test(t)) score -= 0.5;
    if (year && e.year) {
      const dy = Math.abs(year - e.year);
      if (dy > 4) continue;
      score -= dy * 0.5;
    } else if (year || e.year) score -= 0.5;
    if (score < 2) continue;
    out.push({ entry: e, score });
  }
  out.sort((a, b) => b.score - a.score || (b.entry.gone ? 1 : 0) - (a.entry.gone ? 1 : 0));
  return out.slice(0, n);
}

function weightedMedian(vals, weights) {
  const arr = vals.map((v, i) => [v, weights[i]]).sort((a, b) => a[0] - b[0]);
  const tot = arr.reduce((s, x) => s + x[1], 0);
  let acc = 0;
  for (const [v, w] of arr) {
    acc += w;
    if (acc >= tot / 2) return v;
  }
  return arr.length ? arr[arr.length - 1][0] : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Trénink

function trainable(it, kb = KB) {
  if (!it.isBike || !it.bikeType || it.price == null) return false;
  if (it.f.isMulti || it.f.pricePlaceholder) return false;
  if (isPlaceholderPrice(it.price)) return false;
  const fam = familyOf(it.bikeType);
  const min = fam === 'ebike' && it.bikeType !== 'ebike_kids' ? kb.minTrainPrice.ebike : it.bikeType === 'balance' ? kb.minTrainPrice.balance : fam === 'kids' ? kb.minTrainPrice.kids : kb.minTrainPrice.default;
  return it.price >= min && it.price <= kb.maxTrainPrice;
}

function rowWeight(it) {
  let w = it.gone ? 1.3 : 1;
  if (it.f.isShop) w *= 0.8;
  return w;
}

/** Jádro: naučí regresi na položkách, vrátí koeficienty, slovník a index srovnatelných. */
function fitCore(items, { lambda = LAMBDA, minCount = MIN_COUNT, useTokens = true } = {}) {
  const lam = useTokens ? lambda : { ...lambda };
  const mc = useTokens ? minCount : { ...minCount, tok: Infinity, bm: Infinity };
  const vocab = buildVocab(items, { minCount: mc, lambda: lam });
  const rows = items.map((it) => featurize(it, vocab).map(([j, v]) => [j, v]));
  const X = toCsr(rows, vocab.index.size);
  const y = Float64Array.from(items.map((it) => Math.log(it.price)));
  const w = Float64Array.from(items.map(rowWeight));
  const fit = huberRidge(X, y, w, vocab.lambda);
  const comps = buildCompIndex(items.map((it, i) => compEntry(it, fit.resid[i])));
  // průměrný příspěvek skupin (pro vysvětlení „proti průměrnému inzerátu“)
  const groupMean = {};
  for (const r of items) {
    for (const [j, v, g] of featurize(r, vocab)) groupMean[g] = (groupMean[g] || 0) + fit.beta[j] * v;
  }
  for (const g of Object.keys(groupMean)) groupMean[g] /= items.length;
  return { vocab, beta: fit.beta, sigma: fit.sigma, comps, groupMean, n: items.length };
}

function evidenceKey(it, nComps) {
  const f = it.f;
  return `${f.brand ? 'B' : '-'}${modelTokens(it).first ? 'M' : '-'}${f.modelYear ? 'Y' : '-'}${nComps >= 3 ? 'C' : nComps > 0 ? 'c' : '-'}`;
}

/** Log-odhad na úrovni inzerovaných cen (bez kalibrace) + diagnostika. */
function rawLogEstimate(core, it, { useComps = true, rulesWeight = 0.1, kb = KB } = {}) {
  const x = featurize(it, core.vocab);
  let lp = 0;
  const contrib = {};
  for (const [j, v, g] of x) {
    lp += core.beta[j] * v;
    contrib[g] = (contrib[g] || 0) + core.beta[j] * v;
  }
  const modelLp = lp;
  let comps = [];
  let compShift = 0;
  if (useComps) {
    comps = findCompEntries(core.comps, it, 12);
    if (comps.length) {
      const med = weightedMedian(
        comps.map((c) => c.entry.resid),
        comps.map((c) => c.score)
      );
      const shrink = comps.length / (comps.length + 2);
      compShift = clamp(med * shrink, -1, 1);
      lp += compShift;
    }
  }
  const rules = rulesEstimate(it, kb);
  let wr = rulesWeight;
  if (it.f.originalPriceCzk) wr += 0.1;
  if (!it.f.brand && !it.f.modelYear) wr += 0.05;
  if (comps.length >= 3) wr *= 0.5;
  lp = (1 - wr) * lp + wr * Math.log(rules.value);
  return { lp, modelLp, compShift, comps, rules, contrib, wr };
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Statistiky chyb podle třídy důkazů → rozpětí a jistota. */
function spreadStats(records) {
  const groups = new Map();
  const add = (k, r) => {
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  };
  for (const { key, resid } of records) {
    add(key, resid);
    add(`${key[0]}${key[3] === 'C' ? 'C' : '-'}`, resid);
    add('*', resid);
  }
  const out = {};
  for (const [k, arr] of groups) {
    if (arr.length < 25 && k !== '*') continue;
    const s = arr.slice().sort((a, b) => a - b);
    const within = arr.filter((r) => Math.abs(Math.exp(r) - 1) <= 0.25).length / arr.length;
    out[k] = { n: arr.length, q10: quantile(s, 0.1), q90: quantile(s, 0.9), med: quantile(s, 0.5), within25: within };
  }
  return out;
}

function spreadFor(stats, key) {
  return stats[key] || stats[`${key[0]}${key[3] === 'C' ? 'C' : '-'}`] || stats['*'] || { q10: -0.45, q90: 0.4, med: 0, within25: 0.35, n: 0 };
}

/**
 * Naučí model z (již normalizovaných) položek. Pro testy a evaluaci; v aplikaci volá trainModel(db).
 * @param {object[]} rawItems řádky z DB nebo objekty inzerátů
 * @param {{sales?: object[], config?: object, log?: object, oof?: boolean, useTokens?: boolean, useComps?: boolean, rulesWeight?: number, kb?: object}} [o]
 */
function trainFromRows(rawItems, o = {}) {
  const t0 = Date.now();
  const kb = o.kb || KB;
  const all = rawItems.map(normItem).filter((it) => it.isBike);
  const items = all.filter((it) => trainable(it, kb));
  const model = {
    version: MODEL_VERSION,
    trainedAt: new Date().toISOString(),
    kb,
    mode: items.length >= MIN_TRAIN ? 'model' : 'rules',
    useComps: o.useComps !== false,
    rulesWeight: o.rulesWeight ?? 0.1,
    core: null,
    spread: null,
    calibration: null,
    buyRatio: null,
    summary: null,
  };
  if (model.mode === 'model') {
    model.core = fitCore(items, { useTokens: o.useTokens !== false });
    // odložené chyby (3× křížová validace) pro rozpětí a jistotu
    const recs = [];
    if (o.oof !== false) {
      const K = 3;
      for (let k = 0; k < K; k++) {
        const train = items.filter((_, i) => i % K !== k);
        const test = items.filter((_, i) => i % K === k);
        const core = fitCore(train, { useTokens: o.useTokens !== false });
        for (const it of test) {
          const r = rawLogEstimate(core, it, { useComps: model.useComps, rulesWeight: model.rulesWeight, kb });
          recs.push({ key: evidenceKey(it, r.comps.length), resid: Math.log(it.price) - r.lp });
        }
      }
    } else {
      for (const it of items) {
        const r = rawLogEstimate(model.core, it, { useComps: false, rulesWeight: model.rulesWeight, kb });
        recs.push({ key: evidenceKey(it, 0), resid: (Math.log(it.price) - r.lp) * 1.15 });
      }
    }
    model.spread = spreadStats(recs);
  } else {
    // málo dat: srovnatelné jen z cen (bez modelu), rozpětí z pravidel
    model.core = { comps: buildCompIndex(items.map((it) => compEntry(it, 0))), vocab: null, beta: null };
    const recs = items.map((it) => ({ key: evidenceKey(it, 0), resid: Math.log(it.price) - Math.log(rulesEstimate(it, kb).value) }));
    model.spread = recs.length >= 25 ? spreadStats(recs) : { '*': { q10: -0.55, q90: 0.5, med: 0, within25: 0.3, n: recs.length } };
  }
  // kalibrace na vlastní prodeje + výkupní poměr
  model.calibration = calibrate(model, o.sales || [], kb);
  model.buyRatio = buyRatioFrom(o.sales || [], o.config, kb);
  model.summary = {
    mode: model.mode,
    bikes: all.length,
    trained: items.length,
    features: model.core?.vocab ? model.core.vocab.index.size : 0,
    sigma: model.core?.sigma != null ? Number(model.core.sigma.toFixed(3)) : null,
    calibration: Number(model.calibration.factor.toFixed(3)),
    shopRatio: model.calibration.shopRatio != null ? Number(model.calibration.shopRatio.toFixed(3)) : null,
    salesUsed: model.calibration.n,
    buyRatio: Number(model.buyRatio.toFixed(3)),
    ms: Date.now() - t0,
  };
  o.log?.info?.('Model nacenění naučen', model.summary);
  return model;
}

/** Odhad na úrovni inzerovaných cen (log), použitelný i bez kalibrace. */
function askingLog(model, it) {
  if (model.mode === 'model') return rawLogEstimate(model.core, it, { useComps: model.useComps, rulesWeight: model.rulesWeight, kb: model.kb });
  const rules = rulesEstimate(it, model.kb);
  let lp = Math.log(rules.value);
  const comps = model.useComps ? findCompEntries(model.core.comps, it, 12) : [];
  let compShift = 0;
  if (comps.length >= 2) {
    const med = median(comps.map((c) => Math.log(c.entry.price)));
    const w = comps.length / (comps.length + 2);
    compShift = w * (med - lp);
    lp += compShift;
  }
  return { lp, modelLp: null, compShift, comps, rules, contrib: {}, wr: 1 };
}

/**
 * Kalibrace na skutečné prodeje obchodu: pro každý BAZAR prodej odhad z titulku → medián skutečná / odhad,
 * zkombinovaný s apriorním kb.askToSale (váha priorWeight) a oříznutý.
 */
function calibrate(model, sales, kb = KB) {
  const prior = kb.askToSale;
  const ratios = [];
  const details = [];
  for (const s of sales || []) {
    if (s.kind !== 'bazar' || !(s.priceCzk >= 500)) continue;
    const title = s.size ? `${s.title} vel. ${s.size}` : s.title;
    const c = classifyListing({ title, categorySrc: null, priceCzk: null });
    if (!c.isBike) continue;
    const it = normItem({ title, features: c.features, bike_type: c.bikeType, is_bike: 1, price_czk: null });
    const r = askingLog(model, it);
    const pred = Math.exp(r.lp);
    ratios.push(s.priceCzk / pred);
    details.push({ title: s.title, actual: s.priceCzk, predictedAsking: Math.round(pred) });
  }
  const n = ratios.length;
  const shopRatio = n ? median(ratios) : null;
  const k = kb.calibration.priorWeight;
  let factor = n ? Math.exp((n * Math.log(clamp(shopRatio, 0.3, 2)) + k * Math.log(prior)) / (n + k)) : prior;
  factor = clamp(factor, kb.calibration.min, kb.calibration.max);
  return { factor, shopRatio, n, prior, details };
}

function buyRatioFrom(sales, config, kb = KB) {
  if (config && config.buyMargin != null && Number.isFinite(Number(config.buyMargin))) return clamp(1 - Number(config.buyMargin), 0.05, 1);
  const r = (sales || []).filter((s) => s.kind === 'bazar' && s.priceCzk > 0 && s.costCzk > 0).map((s) => s.costCzk / s.priceCzk);
  if (r.length >= 5) return clamp(median(r), 0.3, 0.9);
  return kb.buyRatio;
}

/** Prodeje obchodu: tabulka sales, jinak training/koloshop-prodeje.json. */
function loadSales(db) {
  try {
    const rows = db.prepare('SELECT kind, title, size, brand, price_czk, cost_czk FROM sales').all();
    if (rows.length) return rows.map((r) => ({ kind: r.kind, title: r.title, size: r.size, brand: r.brand, priceCzk: r.price_czk, costCzk: r.cost_czk }));
  } catch {
    // tabulka nemusí existovat (starší DB) – použije se soubor
  }
  try {
    return JSON.parse(fs.readFileSync(TRAINING_SALES_FILE, 'utf8')).sales || [];
  } catch {
    return [];
  }
}

/**
 * Naučí model nacenění z databáze (aktivní i zmizelé inzeráty kol) a zkalibruje ho na vlastní prodeje.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{config?: object, log?: object}} [o]
 * @returns {object} model s `summary`
 */
function trainModel(db, { config, log } = {}) {
  const rows = db
    .prepare('SELECT id, source, url, title, price_czk, is_bike, bike_type, features, gone_at FROM listings WHERE is_bike = 1 AND price_czk IS NOT NULL')
    .all();
  return trainFromRows(rows, { sales: loadSales(db), config, log });
}

// ---------------------------------------------------------------------------------------------------------------
// Odhad

const GROUP_LABEL = {
  brand: 'Značka',
  brandE: 'Značka (e-kola)',
  tier: 'Třída značky',
  gs: 'Sada komponent',
  gsf: 'Sada komponent',
  age: 'Stáří',
  eage: 'Stáří e-kola',
  kage: 'Stáří',
  mat: 'Materiál rámu',
  motor: 'Motor',
  bat: 'Baterie',
  kw: 'Velikost kol',
  wh: 'Velikost kol',
  cond: 'Stav',
  flag: 'Ostatní údaje',
  orig: 'Původní cena',
  tok: 'Model / slova v titulku',
  bm: 'Model',
};

/**
 * Nacení jeden inzerát.
 * @param {object} model z trainModel / trainFromRows
 * @param {object} listing řádek z DB (features JSON) nebo objekt {title, price_czk, bike_type, features}
 * @returns {{estCzk: number, low: number, high: number, confidence: number, method: 'comps'|'model'|'rules', factors: string[]}|null}
 */
function estimate(model, listing) {
  const it = normItem(listing);
  if (!it.isBike) return null;
  const f = it.f;
  const r = askingLog(model, it);
  const cal = model.calibration?.factor ?? KB.askToSale;
  const lp = r.lp + Math.log(cal);
  const nComps = r.comps.length;
  const sp = spreadFor(model.spread || {}, evidenceKey(it, nComps));
  // medián chyb ≈ 0 díky robustní regresi; rozpětí = 10. a 90. percentil odložených chyb
  const est = Math.exp(lp);
  const low = Math.exp(lp + Math.min(-0.08, sp.q10));
  const high = Math.exp(lp + Math.max(0.08, sp.q90));
  let confidence = sp.within25;
  if (model.mode === 'rules') confidence = Math.min(confidence, 0.4);
  if (f.isMulti) confidence *= 0.5;
  if (f.isFrameOnly) confidence *= 0.8;
  if (it.bikeType === 'other') confidence *= 0.85;
  confidence = clamp(confidence, 0.05, 0.95);
  const method = model.mode === 'rules' ? (nComps >= 3 ? 'comps' : 'rules') : nComps >= 3 ? 'comps' : 'model';

  // vysvětlení
  const factors = [];
  const typeLabel = TYPE_LABEL[it.bikeType] || it.bikeType;
  const head = [f.brand, f.model].filter(Boolean).join(' ');
  factors.push(head ? `${head} – ${typeLabel}` : `Typ: ${typeLabel}`);
  if (nComps) {
    const prices = r.comps.map((c) => c.entry.price).sort((a, b) => a - b);
    const med = prices.length % 2 ? prices[prices.length >> 1] : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;
    factors.push(`Podobné inzeráty (${nComps}×): medián ${fmtCzk(med)}`);
  }
  if (f.modelYear) factors.push(`Rok ${f.modelYear} → stáří ${f.ageYears} ${f.ageYears === 1 ? 'rok' : f.ageYears >= 2 && f.ageYears <= 4 ? 'roky' : 'let'}`);
  else if (f.vintageYear) factors.push(`Retro kolo (rok ${f.vintageYear})`);
  else factors.push('Rok výroby neuveden – počítá se s typickým stářím');
  if (f.originalPriceCzk) factors.push(`Původní cena ${fmtCzk(f.originalPriceCzk)} (z textu)`);
  if (f.condition) factors.push(`Stav: ${COND_LABEL[f.condition] || f.condition}`);
  if (f.groupset) factors.push(`Sada ${f.groupset} (třída ${fmtNum(f.groupsetTier, f.groupsetTier % 1 ? 1 : 0)}/6)`);
  if (familyOf(it.bikeType) === 'ebike') {
    const e = [f.motor ? `motor ${f.motor}` : null, f.batteryWh ? `baterie ${f.batteryWh} Wh` : null].filter(Boolean);
    if (e.length) factors.push(e.join(', ').replace(/^./, (c) => c.toUpperCase()));
  }
  if (model.mode === 'model') {
    // největší vlivy proti průměrnému inzerátu
    const eff = [];
    for (const [g, v] of Object.entries(r.contrib)) {
      if (!GROUP_LABEL[g] || g === 'tier') continue;
      const d = v - (model.core.groupMean[g] || 0);
      if (Math.abs(d) >= 0.08) eff.push([g, d]);
    }
    eff.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const seen = new Set();
    const parts = [];
    for (const [g, d] of eff) {
      const lab = GROUP_LABEL[g];
      if (seen.has(lab)) continue;
      seen.add(lab);
      parts.push(`${lab} ${pct(Math.exp(d) - 1)}`);
      if (parts.length >= 3) break;
    }
    if (parts.length) factors.push(`Vliv proti průměrnému inzerátu: ${parts.join(', ')}`);
  } else factors.push('Odhad podle pravidel (v databázi je zatím málo kol pro naučený model)');
  if (f.isFrameOnly) factors.push('Jen rám – hodnota rámu, ne celého kola');
  if (f.isMulti) factors.push('Inzerát nabízí více kol – odhad je za jedno kolo');
  factors.push(`Kalibrace na vlastní prodeje obchodu: ×${fmtNum(cal)}`);

  return {
    estCzk: roundCzk(est),
    low: roundCzk(low),
    high: roundCzk(high),
    confidence: Number(confidence.toFixed(2)),
    method,
    factors,
  };
}

/**
 * Srovnatelné inzeráty pro daný inzerát (pro AI a UI).
 * @returns {Array<{title: string, price: number, url: string|null, sold: boolean}>}
 */
function comparables(model, listing, n = 8) {
  const it = normItem(listing);
  if (!it.isBike || !model?.core?.comps) return [];
  const found = findCompEntries(model.core.comps, it, n);
  return found.map(({ entry }) => ({ title: entry.title, price: entry.price, url: entry.url, sold: !!entry.gone, year: entry.year }));
}

// ---------------------------------------------------------------------------------------------------------------
// Zápis do DB

/** Výhodnost a max. výkupní cena vůči referenčnímu odhadu (AI, je-li aktuální, jinak model). */
function dealFields(row, refCzk, buyRatio) {
  const f = typeof row.features === 'string' ? parseJson(row.features, {}) : row.features || {};
  const price = row.price_czk;
  const dealRatio = refCzk > 0 && price != null && !isPlaceholderPrice(price) && !f.isMulti ? Number((price / refCzk).toFixed(3)) : null;
  const maxBuy = refCzk > 0 ? roundCzk(refCzk * buyRatio) : null;
  return { dealRatio, maxBuy };
}

/** Referenční hodnota: AI odhad, pokud je aktuální (ai_input_hash = content_hash), jinak odhad modelu. */
function referenceCzk(row, estCzk) {
  if (row.ai_czk > 0 && row.ai_input_hash && row.ai_input_hash === row.content_hash) return row.ai_czk;
  return estCzk;
}

/**
 * Přepočítá deal_ratio a max_buy_czk jednoho inzerátu (např. po uložení AI nacenění).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {{buyRatio?: number, config?: object}} [o]
 */
function refreshDeal(db, id, { buyRatio, config } = {}) {
  const row = db.prepare('SELECT id, price_czk, features, est_czk, ai_czk, ai_input_hash, content_hash FROM listings WHERE id = ?').get(id);
  if (!row) return null;
  const br = buyRatio ?? buyRatioFrom(loadSales(db), config);
  const ref = referenceCzk(row, row.est_czk);
  const { dealRatio, maxBuy } = dealFields(row, ref, br);
  db.prepare('UPDATE listings SET deal_ratio = ?, max_buy_czk = ? WHERE id = ?').run(dealRatio, maxBuy, id);
  return { dealRatio, maxBuy };
}

const SUSPICIOUS = 'Pozor: cena je hluboko pod tržní hodnotou a chybí doklad – ověřte původ kola';

/**
 * Nacení všechny aktivní inzeráty kol (est_*, deal_ratio, max_buy_czk); u nekol odhady smaže.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} model
 * @param {{config?: object}} [o]
 * @returns {number} počet naceněných inzerátů
 */
function priceAll(db, model, { config } = {}) {
  const rows = db
    .prepare('SELECT id, source, url, title, price_czk, is_bike, bike_type, features, content_hash, ai_czk, ai_input_hash, est_czk FROM listings WHERE gone_at IS NULL')
    .all();
  const buyRatio = config && config.buyMargin != null ? buyRatioFrom([], config) : model.buyRatio ?? KB.buyRatio;
  const at = nowIso();
  const upd = db.prepare(
    'UPDATE listings SET est_czk = ?, est_low = ?, est_high = ?, est_confidence = ?, est_method = ?, est_factors = ?, est_at = ?, deal_ratio = ?, max_buy_czk = ? WHERE id = ?'
  );
  const clear = db.prepare(
    "UPDATE listings SET est_czk = NULL, est_low = NULL, est_high = NULL, est_confidence = NULL, est_method = NULL, est_factors = '[]', est_at = NULL, deal_ratio = NULL, max_buy_czk = NULL WHERE id = ?"
  );
  let n = 0;
  tx(db, () => {
    for (const row of rows) {
      if (row.is_bike !== 1) {
        if (row.est_czk != null) clear.run(row.id);
        continue;
      }
      const e = estimate(model, row);
      if (!e || !e.estCzk) {
        clear.run(row.id);
        continue;
      }
      const ref = referenceCzk(row, e.estCzk);
      const { dealRatio, maxBuy } = dealFields(row, ref, buyRatio);
      const f = parseJson(row.features, {});
      const factors = e.factors.slice();
      if (dealRatio != null && dealRatio < 0.45 && f.hasReceipt !== true && (f.brandTier || 0) >= 3 && familyOf(row.bike_type) !== 'kids' && f.condition !== 'parts') factors.unshift(SUSPICIOUS);
      upd.run(e.estCzk, e.low, e.high, e.confidence, e.method, JSON.stringify(factors), at, dealRatio, maxBuy, row.id);
      n++;
    }
  });
  return n;
}

module.exports = {
  trainModel,
  trainFromRows,
  estimate,
  priceAll,
  comparables,
  refreshDeal,
  referenceCzk,
  dealFields,
  rulesEstimate,
  isPlaceholderPrice,
  loadSales,
  buyRatioFrom,
  normItem,
  familyOf,
  roundCzk,
  MIN_TRAIN,
  MODEL_VERSION,
  TYPE_LABEL,
  COND_LABEL,
  // pro evaluaci
  _internal: { fitCore, rawLogEstimate, askingLog, trainable, evidenceKey, spreadStats, findCompEntries, calibrate, LAMBDA, MIN_COUNT },
};
