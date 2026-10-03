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
//     množství dat (< MIN_TRAIN kol) jediný zdroj;
//  d) druhý stupeň – boosting rozhodovacích stromů (gbdt.js) nad zbytkovou chybou a)–c): učí se kombinace, které
//     lineární model nezachytí (stáří × třída značky, e-kolo × baterie × stáří, kdy věřit srovnatelným, pravidlům
//     a původní ceně), a podobné titulky (k nejbližších podle vážených slov – i bez přesné shody značky a modelu).
//     Učí se na odložených odhadech a)–c) (3× křížová validace při tréninku).
// Inzeráty, které jsou v trénovacích datech (všechny aktivní), se naceňují tou třetinou modelu, která jejich cenu
// neviděla (cross-fitting) – jinak by odhad částečně opisoval vlastní cenu a výhodné nabídky by vypadaly méně výhodně.
// 5× křížová validace na 22 866 kolech z Bazoše (skupiny podle titulku), typická chyba (MdAPE) proti inzerovaným
// cenám: celkem 41,2 % → 38,8 %, bez srovnatelných 48,8 → 46,9 %, ≥ 3 srovnatelné 27,7 → 26,0 %; vlastní prodeje
// BAZAR 29,7 → 26,9 %; rozpětí pokrývá ~80 % cen v každé rodině kol (dřív silničky 75 %, e-kola 87 %).
// Výsledek je na úrovni INZEROVANÝCH cen → převod na SKUTEČNÉ prodejní ceny kalibrací na vlastní prodeje obchodu
// (BAZAR, medián skutečná / odhad) kombinovanou s apriorním poměrem kb.askToSale.
// Rozpětí (low/high) a jistota vycházejí z rozdělení chyb na odložených datech (3násobná křížová validace při
// tréninku) podle „třídy důkazů“ (značka? model? rok? srovnatelné?). Jistota = odhadnutá pravděpodobnost, že
// inzerovaná cena srovnatelného kola leží v ±35 % odhadu (CONF_TOLERANCE). Inzerované ceny samy kolísají, takže
// ±35 % proti inzerátům odpovídá zhruba ±25 % proti skutečné hodnotě; práh UI 0,45 tak odděluje identifikovaná
// kola (značka + model / rok / srovnatelné) od obecných inzerátů („Dámské kolo“).

const fs = require('node:fs');
const path = require('node:path');
const { tx, nowIso, parseJson } = require('../db');
const { keyOf } = require('../util/text');
const { classifyListing } = require('../classify');
const { toCsr, huberRidge, median } = require('./ridge');
const { fitBoost, predictBoost } = require('./gbdt');
const KB = require('./kb.json');

const MODEL_VERSION = 2;
/** Tolerance pro jistotu odhadu (viz výše). */
const CONF_TOLERANCE = 0.35;
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
  // základ modelu: první neobecné slovo („stumpjumper“); u čistě číselných modelů („Woom 4“, „Superior 969“) číslo
  const first = toks.find((t) => !MODEL_GENERIC.has(t) && !/^\d+$/.test(t)) || toks.find((t) => /^\d+$/.test(t)) || null;
  return { first, toks };
}

/** Zástupné texty za skryté kontakty („[telefon skryt]“, „[jméno skryto]“) – nejsou vlastností kola. */
const SCRUB_PLACEHOLDER_RX = /\[[^\]]{1,30}\bskryt[oéa]?\]/gi;

function titleTokens(title) {
  const out = new Set();
  for (const t of keyOf(String(title ?? '').replace(SCRUB_PLACEHOLDER_RX, ' ')).split(' ')) {
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
    // jiná výbava / úroveň modelu (9.6 × 9.9, Comp × S-Works) je podstatný rozdíl
    for (const t of e.toks) if (t !== mt.first && !mt.toks.includes(t) && /\d|^(s|works|sworks|pro|expert|comp|elite|team|sl|slr|race|base|sport|evo|carbon|cf|al)$/.test(t)) score -= 1;
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

// ---------------------------------------------------------------------------------------------------------------
// Podobné titulky (k nejbližších podle vážených slov) – i bez přesné shody značky a modelu

const KNN_K = 10;
const KNN_MAX_DF = 0.05; // slova ve víc než 5 % titulků neslouží k hledání kandidátů (jen ke skóre)

function knnGroup(it) {
  const fam = familyOf(it.bikeType);
  return fam === 'kids' ? 'k' : fam === 'ebike' ? 'e' : 'a';
}

/** Index titulků: slovo → položky, idf. */
function buildKnn(items) {
  const docs = items.map((it) => ({ id: it.id, toks: titleTokens(it.title), lp: Math.log(it.price), g: knnGroup(it) }));
  const df = new Map();
  for (const d of docs) for (const t of d.toks) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length;
  const idf = new Map();
  for (const [t, c] of df) idf.set(t, Math.log(1 + N / c));
  const post = new Map();
  docs.forEach((d, i) => {
    let nn = 0;
    for (const t of d.toks) nn += idf.get(t) ** 2;
    d.norm = Math.sqrt(nn) || 1;
    for (const t of d.toks) {
      if (df.get(t) > KNN_MAX_DF * N) continue;
      if (!post.has(t)) post.set(t, []);
      post.get(t).push(i);
    }
  });
  return { docs, idf, post, N };
}

/** Nejpodobnější titulky ve stejné skupině (dospělá / dětská / e-kola) → {lp, top, n} nebo null. */
function queryKnn(knn, it) {
  if (!knn) return null;
  const toks = titleTokens(it.title);
  if (!toks.length) return null;
  const g = knnGroup(it);
  let qn = 0;
  for (const t of toks) qn += (knn.idf.get(t) ?? Math.log(1 + knn.N)) ** 2;
  qn = Math.sqrt(qn) || 1;
  const acc = new Map();
  for (const t of toks) {
    const list = knn.post.get(t);
    if (!list) continue;
    const w = knn.idf.get(t) ** 2;
    for (const i of list) acc.set(i, (acc.get(i) || 0) + w);
  }
  // příspěvek častých slov (bez seznamu) dopočítat jen u nalezených kandidátů
  const common = toks.filter((t) => knn.idf.has(t) && !knn.post.has(t));
  const res = [];
  for (const [i, dot0] of acc) {
    const d = knn.docs[i];
    if (d.g !== g || (it.id != null && d.id === it.id)) continue;
    let dot = dot0;
    if (common.length) for (const t of common) if (d.toks.includes(t)) dot += knn.idf.get(t) ** 2;
    res.push([dot / (qn * d.norm), d.lp]);
  }
  if (!res.length) return null;
  res.sort((a, b) => b[0] - a[0]);
  const top = res.slice(0, KNN_K);
  let sw = 0;
  let sl = 0;
  for (const [sim, lp] of top) {
    const w = sim * sim;
    sw += w;
    sl += w * lp;
  }
  return { lp: sw > 0 ? sl / sw : NaN, top: top[0][0], n: top.filter(([sim]) => sim >= 0.5).length };
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
// Druhý stupeň (boosting stromů nad zbytkovou chybou prvního stupně)

const FAM_CODE = { mtb: 0, road: 1, ebike: 2, kids: 3, other: 4 };
const TYPE_CODES = Object.keys(TYPE_LABEL);
const MAT_CODE = { steel: 1, alu: 2, carbon: 3, titanium: 4 };
const COND_CODE = { parts: 0, poor: 1, fair: 2, good: 3, very_good: 4, like_new: 5, new: 6 };
const MOTOR_CODE = { hub: 1, mid: 2, premium: 3 };
const SUSP_CODE = { rigid: 0, hardtail: 1, full: 2 };
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
};

/** Příznaky druhého stupně: výsledek prvního stupně (odhad, srovnatelné, pravidla) + vlastnosti kola. */
function boostFeatures(it, r) {
  const f = it.f;
  const compLp = r.comps.length
    ? weightedMedian(
        r.comps.map((c) => Math.log(c.entry.price)),
        r.comps.map((c) => c.score)
      )
    : NaN;
  return [
    r.lp,
    r.modelLp != null ? r.modelLp - r.lp : NaN,
    r.comps.length,
    compLp - r.lp,
    r.comps.length ? r.comps[0].score : NaN,
    Math.log(r.rules.value) - r.lp,
    FAM_CODE[familyOf(it.bikeType)],
    TYPE_CODES.indexOf(it.bikeType || 'other'),
    num(f.brandTier),
    num(f.ageYears),
    num(f.groupsetTier),
    MAT_CODE[f.material] ?? NaN,
    num(f.wheelSize),
    num(f.kidsWheel),
    MOTOR_CODE[f.motorClass] ?? NaN,
    num(f.batteryWh),
    COND_CODE[f.condition] ?? NaN,
    f.originalPriceCzk ? Math.log(f.originalPriceCzk) - r.lp : NaN,
    f.isFrameOnly ? 1 : 0,
    f.isShop ? 1 : 0,
    f.isVintage ? 1 : 0,
    f.hasReceipt === true ? 1 : 0,
    f.warranty === true ? 1 : 0,
    f.electronicShifting ? 1 : 0,
    f.brand ? 1 : 0,
    modelTokens(it).first ? 1 : 0,
    SUSP_CODE[f.suspension] ?? NaN,
    titleTokens(it.title).length,
    r.knn ? r.knn.lp - r.lp : NaN,
    r.knn ? r.knn.top : NaN,
    r.knn ? r.knn.n : 0,
  ];
}

/**
 * Nastavení boostingu. 5× křížová validace: 500 stromů / lr 0,03, hloubka 5 i hloubka 3 vycházejí v rámci šumu
 * stejně (38,7–39,3 % celkem) – ponechána menší a rychlejší varianta.
 */
const BOOST = { trees: 250, depth: 4, lr: 0.05, minLeaf: 40, subsample: 0.8, l2: 5, delta: 0.4 };

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
  const knn = buildKnn(items);
  // průměrný příspěvek skupin (pro vysvětlení „proti průměrnému inzerátu“)
  const groupMean = {};
  for (const r of items) {
    for (const [j, v, g] of featurize(r, vocab)) groupMean[g] = (groupMean[g] || 0) + fit.beta[j] * v;
  }
  for (const g of Object.keys(groupMean)) groupMean[g] /= items.length;
  return { vocab, beta: fit.beta, sigma: fit.sigma, comps, knn, groupMean, n: items.length };
}

const FAM_CHAR = { mtb: 'm', road: 'r', ebike: 'e', kids: 'k', other: 'o' };

/** Třída důkazů (značka, model, rok, srovnatelné) + rodina kola (rozpětí se u silniček a dětských kol liší). */
function evidenceKey(it, nComps) {
  const f = it.f;
  return `${f.brand ? 'B' : '-'}${modelTokens(it).first ? 'M' : '-'}${f.modelYear ? 'Y' : '-'}${nComps >= 3 ? 'C' : nComps > 0 ? 'c' : '-'}${FAM_CHAR[familyOf(it.bikeType)]}`;
}

/** Log-odhad na úrovni inzerovaných cen (bez kalibrace) + diagnostika. */
// Váha přímého přitažení k cenám ≥ 3 srovnatelných (× n/(n+2)). 5× CV na 10 676 kolech z Bazoše:
// 0 → MdAPE (≥3 srovnatelné) 28,8 %, 0,3 → 27,1 %, 0,5 → 26,3 %, 0,7 → 26,4 % (a horší vlastní prodeje BAZAR).
// blendMinComps 3 → 1: MdAPE u inzerátů s 1–2 srovnatelnými 33,9 % → 32,1 %, celkem 42,5 % → 42,3 %, BAZAR beze změny.
const TUNE = { compBlend: 0.5, blendMinComps: 1 };

/**
 * @param {object} core model prvního stupně (srovnatelné a podobné titulky)
 * @param {object} it normalizovaný inzerát
 * @param {{useComps?: boolean, rulesWeight?: number, kb?: object, ridge?: object}} [o] ridge = jiná regrese (část
 *   modelu, která inzerát neviděla – viz cross-fitting v trainFromRows), jinak core
 */
function rawLogEstimate(core, it, { useComps = true, rulesWeight = 0.1, kb = KB, ridge = null } = {}) {
  const rc = ridge || core;
  const x = featurize(it, rc.vocab);
  let lp = 0;
  const contrib = {};
  for (const [j, v, g] of x) {
    lp += rc.beta[j] * v;
    contrib[g] = (contrib[g] || 0) + rc.beta[j] * v;
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
      // Při srovnatelných inzerátech přitáhnout odhad i přímo k jejich cenám: posun reziduí nevyrovná slova v titulku,
      // která mají jen tento inzerát („gen 2“, „2.0“) – model pak ujede nahoru, přestože podobná kola stojí méně.
      if (comps.length >= TUNE.blendMinComps && TUNE.compBlend > 0) {
        const compLp = weightedMedian(
          comps.map((c) => Math.log(c.entry.price)),
          comps.map((c) => c.score)
        );
        const wc = TUNE.compBlend * (comps.length / (comps.length + 2));
        lp = (1 - wc) * lp + wc * compLp;
      }
    }
  }
  const rules = rulesEstimate(it, kb);
  let wr = rulesWeight;
  if (it.f.originalPriceCzk) wr += 0.1;
  if (!it.f.brand && !it.f.modelYear) wr += 0.05;
  if (comps.length >= 3) wr *= 0.5;
  lp = (1 - wr) * lp + wr * Math.log(rules.value);
  return { lp, modelLp, compShift, comps, rules, contrib, wr, knn: core.knn ? queryKnn(core.knn, it) : null, groupMean: rc.groupMean };
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
    if (key.length > 4) {
      add(key.slice(0, 4), resid);
      add(`${key[0]}${key[3] === 'C' ? 'C' : '-'}${key[4]}`, resid);
    }
    add(`${key[0]}${key[3] === 'C' ? 'C' : '-'}`, resid);
    add('*', resid);
  }
  const out = {};
  for (const [k, arr] of groups) {
    if (arr.length < 25 && k !== '*') continue;
    const s = arr.slice().sort((a, b) => a - b);
    const within = arr.filter((r) => Math.abs(Math.exp(r) - 1) <= CONF_TOLERANCE).length / arr.length;
    out[k] = { n: arr.length, q10: quantile(s, 0.1), q90: quantile(s, 0.9), med: quantile(s, 0.5), within };
  }
  return out;
}

function spreadFor(stats, key) {
  const coarse = `${key[0]}${key[3] === 'C' ? 'C' : '-'}`;
  return (
    stats[key] ||
    (key.length > 4 && (stats[key.slice(0, 4)] || stats[coarse + key[4]])) ||
    stats[coarse] ||
    stats['*'] || { q10: -0.45, q90: 0.4, med: 0, within: 0.4, n: 0 }
  );
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
    booster: null,
    cross: null,
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
      const oof = [];
      model.cross = { cores: [], foldOf: new Map() };
      for (let k = 0; k < K; k++) {
        const train = items.filter((_, i) => i % K !== k);
        const test = items.filter((_, i) => i % K === k);
        const core = fitCore(train, { useTokens: o.useTokens !== false });
        model.cross.cores.push({ vocab: core.vocab, beta: core.beta, groupMean: core.groupMean });
        for (const it of test) {
          if (it.id != null) model.cross.foldOf.set(it.id, k);
          const r = rawLogEstimate(core, it, { useComps: model.useComps, rulesWeight: model.rulesWeight, kb });
          oof.push({ id: it.id, key: evidenceKey(it, r.comps.length), resid: Math.log(it.price) - r.lp, x: boostFeatures(it, r), w: rowWeight(it) });
        }
      }
      const boostOpts = { ...BOOST, ...(o.boost || {}) };
      if (o.boost !== false && oof.length >= 1000) {
        // poctivé chyby po boostingu: boosting učený bez dané třetiny
        model.cross.boosters = [];
        model.cross.boostOf = new Map();
        for (let k = 0; k < K; k++) {
          const tr = oof.filter((_, i) => i % K !== k);
          const bm = fitBoost(tr.map((x) => x.x), tr.map((x) => x.resid), { ...boostOpts, weights: tr.map((x) => x.w) });
          model.cross.boosters.push(bm);
          oof.forEach((x, i) => {
            if (i % K !== k) return;
            recs.push({ key: x.key, resid: x.resid - clamp(predictBoost(bm, x.x), -0.8, 0.8) });
            if (x.id != null) model.cross.boostOf.set(x.id, k);
          });
        }
        model.booster = fitBoost(oof.map((x) => x.x), oof.map((x) => x.resid), { ...boostOpts, weights: oof.map((x) => x.w) });
      } else for (const x of oof) recs.push({ key: x.key, resid: x.resid });
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
    model.spread = recs.length >= 25 ? spreadStats(recs) : { '*': { q10: -0.55, q90: 0.5, med: 0, within: 0.35, n: recs.length } };
  }
  // kalibrace na vlastní prodeje + výkupní poměr
  model.calibration = calibrate(model, o.sales || [], kb);
  model.buyRatio = buyRatioFrom(o.sales || [], o.config, kb);
  model.summary = {
    mode: model.mode,
    bikes: all.length,
    trained: items.length,
    features: model.core?.vocab ? model.core.vocab.index.size : 0,
    trees: model.booster ? model.booster.trees.length : 0,
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
  if (model.mode === 'model') {
    // Inzerát z trénovacích dat nacenit regresí, která jeho cenu neviděla – jinak by odhad částečně opisoval
    // vlastní cenu a výhodné nabídky by vypadaly méně výhodně (cross-fitting).
    const k = it.id != null && model.cross ? model.cross.foldOf.get(it.id) : undefined;
    const ridge = k != null ? model.cross.cores[k] : null;
    const r = rawLogEstimate(model.core, it, { useComps: model.useComps, rulesWeight: model.rulesWeight, kb: model.kb, ridge });
    r.boost = 0;
    if (model.booster) {
      const kb = it.id != null && model.cross?.boostOf ? model.cross.boostOf.get(it.id) : undefined;
      const booster = kb != null ? model.cross.boosters[kb] : model.booster;
      r.boost = clamp(predictBoost(booster, boostFeatures(it, r)), -0.8, 0.8);
      r.lp += r.boost;
    }
    return r;
  }
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
function loadSales(db, file = TRAINING_SALES_FILE) {
  let rows = [];
  try {
    rows = db
      .prepare('SELECT kind, date, title, size, brand, price_czk, cost_czk FROM sales ORDER BY date, id')
      .all()
      .map((r) => ({ kind: r.kind, date: r.date, title: r.title, size: r.size, brand: r.brand, priceCzk: r.price_czk, costCzk: r.cost_czk }));
  } catch {
    // tabulka nemusí existovat (starší DB) – použije se jen soubor
  }
  let fromFile = [];
  try {
    fromFile = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).sales || [];
  } catch {
    /* soubor chybí / je poškozený */
  }
  if (!Array.isArray(fromFile)) fromFile = [];
  // Sjednocení DB a souboru: import nového exportu do čerstvé DB uloží jen nové prodeje, starší jsou jen v souboru.
  // Stejný prodej (datum, název, cena) v obou se započte jednou; opakované stejné prodeje téhož dne zůstanou.
  const key = (x) => [x.date || '', x.title, x.priceCzk].join('|');
  const inDb = new Map();
  for (const r of rows) inDb.set(key(r), (inDb.get(key(r)) || 0) + 1);
  for (const x of fromFile) {
    if (!x || typeof x !== 'object' || !x.title || !(Number(x.priceCzk) > 0)) continue;
    const k = key(x);
    if (inDb.get(k) > 0) inDb.set(k, inDb.get(k) - 1);
    else rows.push(x);
  }
  return rows;
}

/**
 * Naučí model nacenění z databáze (aktivní i zmizelé inzeráty kol) a zkalibruje ho na vlastní prodeje.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{config?: object, log?: object, salesFile?: string}} [o] salesFile = jiný soubor vlastních prodejů (testy)
 * @returns {object} model s `summary`
 */
function trainModel(db, { config, log, salesFile } = {}) {
  // Ukázková data (npm run demo) se z učení vynechají, jakmile jsou v DB skutečné inzeráty – jinak by vymyšlené
  // ceny zkreslily odhady. V samostatné demo DB se učí z nich (aby ukázka měla odhady).
  // nikdy NULL (řádky bez params / s neplatným JSON nejsou demo) – jinak by NOT (…) skutečné inzeráty vyřadil
  const DEMO = "IFNULL(json_extract(CASE WHEN json_valid(params) THEN params END, '$.demo'), '') = '1'";
  const real = db.prepare(`SELECT 1 FROM listings WHERE is_bike = 1 AND NOT (${DEMO}) LIMIT 1`).get();
  const rows = db
    .prepare(
      `SELECT id, source, url, title, price_czk, is_bike, bike_type, features, gone_at FROM listings
        WHERE is_bike = 1 AND price_czk IS NOT NULL${real ? ` AND NOT (${DEMO})` : ''}`
    )
    .all();
  return trainFromRows(rows, { sales: loadSales(db, salesFile), config, log });
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
  let confidence = sp.within;
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
      const d = v - ((r.groupMean || model.core.groupMean)[g] || 0);
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
  if (Math.abs(r.boost || 0) >= 0.08) factors.push(`Doladění podle kombinace vlastností a podobných titulků: ${pct(Math.exp(r.boost) - 1)}`);
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
      if (
        dealRatio != null &&
        dealRatio < 0.45 &&
        e.confidence >= 0.4 &&
        f.hasReceipt !== true &&
        (f.brandTier || 0) >= 3 &&
        familyOf(row.bike_type) !== 'kids' &&
        !['parts', 'poor'].includes(f.condition) &&
        !f.isFrameOnly
      )
        factors.unshift(SUSPICIOUS);
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
  CONF_TOLERANCE,
  TYPE_LABEL,
  COND_LABEL,
  // pro evaluaci
  _internal: { fitCore, rawLogEstimate, askingLog, trainable, evidenceKey, spreadStats, findCompEntries, calibrate, boostFeatures, buildKnn, queryKnn, LAMBDA, MIN_COUNT, TUNE, BOOST },
};
