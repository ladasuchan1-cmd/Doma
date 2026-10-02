'use strict';
// Klasifikace inzerátu: je to kolo? jaký typ? + vytěžení údajů (značka, model, rok, velikosti, motor, stav …).
//
// Princip rozhodnutí kolo × nekolo (titulek je hlavní zdroj, popis jen doplňuje):
//  1. poptávka („Koupím …“) a služby (půjčovna, servis) → nekolo;
//  2. fráze „na kolo / pro kola / za kolo“ se zamaskují (příslušenství PRO kolo);
//  3. v titulku se hledá první „nekolo“ podstatné jméno (helma, sedačka, nosič, vidlice, trenažér …) a první silný
//     důkaz kola (kolo, elektrokolo, MTB, BMX, značka + známý model …) – vyhrává to, co je dřív;
//  4. „zapletená / přední kola“, kola značek ráfků → díl; „Rám …“ na začátku → kolo, ale jen rám (isFrameOnly);
//  5. bez důkazů v titulku rozhodne začátek popisu, pak kategorie webu (v cyklo-kategoriích „Ostatní“ = nekolo).

const { keyOf, fold } = require('../util/text');
const { BRANDS } = require('./brands');
const K = require('./keywords');
const X = require('./extract');

/** Zvýšit při změně logiky → pipeline překlasifikuje všechny inzeráty. */
const CLASSIFIER_VERSION = '2026-10-02.1';

const BIKE_TYPES = [
  'mtb_hardtail', 'mtb_full', 'road', 'gravel', 'cyclocross', 'trekking', 'cross', 'city', 'kids', 'balance', 'bmx', 'dirt', 'fatbike',
  'folding', 'cargo', 'tandem', 'ebike_mtb', 'ebike_mtb_full', 'ebike_trekking', 'ebike_city', 'ebike_road', 'ebike_cargo', 'ebike_kids', 'other',
];

// ---------------------------------------------------------------------------------------------------------------
// Značky – jeden velký regulární výraz nad složeným textem

const ALIAS_TO_BRAND = new Map();
let BRAND_RE;
{
  const parts = [];
  for (const b of BRANDS) {
    b._models = (b.models || []).map(([re, type]) => [new RegExp(re), type]);
    for (const a of b.aliases) {
      const k = keyOf(a);
      if (!k) continue;
      if (!ALIAS_TO_BRAND.has(k)) ALIAS_TO_BRAND.set(k, b);
      parts.push(k);
    }
  }
  parts.sort((a, b) => b.length - a.length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const src = parts.map((p) => p.split(' ').map(esc).join('[^a-z0-9\\n]{0,5}')).join('|');
  BRAND_RE = new RegExp(`(?<![a-z0-9])(?:${src})(?![a-z0-9])`, 'g');
}

/**
 * Najde značky v textu (prep()). Vrací [{brand, idx, end}] v pořadí výskytu.
 * Aliasy „strict“ (běžná slova) jen s velkým počátečním písmenem v originále.
 */
function findBrands(t) {
  const out = [];
  for (const m of t.f.matchAll(BRAND_RE)) {
    const b = ALIAS_TO_BRAND.get(keyOf(m[0]));
    if (!b) continue;
    if (b.strict) {
      const ch = t.orig[m.index];
      if (!ch || ch === ch.toLowerCase()) continue;
    }
    // „Fox“ jako součást „Leader Fox“ je vyřešené delším aliasem; „GT“ ve „GT Line“ apod. zanedbáváme
    out.push({ brand: b, idx: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return out;
}

/** Brand-specifická nápověda typu podle modelu. */
function modelHint(brand, text) {
  if (!brand || !brand._models) return null;
  const k = keyOf(text);
  for (const [re, type] of brand._models) {
    if (re.source === '.') return { type, generic: true };
    if (re.test(k)) return { type, generic: false };
  }
  return null;
}

const MODEL_STOP = new Set(
  ('vel velikost velikosti ram ramu ramem kolo kola kol horske horsky horska silnicni elektrokolo elektrokola ebike e bike damske panske detske ' +
    'juniorske prodam prodej prodavam nabizim nove novy nova novou zanovni top super stav cena model r rv rok roku sleva zaruka zarukou vc vcetne s se na ' +
    'pro a i v z za do po jako bez mtb celoodpruzene celoodpruzeny hardtail kolo kolu bike biky velikost vel. size frame + nebo vymenim vymena ' +
    'pansky damsky detsky cerna cerne cerny bila bile bily modra modre modry cervena cervene cerveny zelena zelene zeleny seda sede sedy zluta zlute zluty oranzova ' +
    'oranzove fialova fialove ruzova ruzove stribrna stribrne black white red blue green grey gray silver yellow orange purple matt matte gloss lesk mat ' +
    'jen pouze levne levně akce elektro elektricke krosove trekingove trekove mestske gravelove skladaci dalsi vic info')
    .split(/\s+/)
);

/** Model = 1–4 slova za značkou v titulku (bez barev, velikostí, roku, obecných slov). */
function extractModel(t, hit) {
  let s = t.orig.slice(hit.end);
  s = s.replace(/^[\s,.:;\-–|/'"]+/, '');
  const cut = s.search(/[,|()[\];!?–—]|\s-\s|\s\/\s|\.\s|\s\+|\+\s|\n/);
  if (cut >= 0) s = s.slice(0, cut);
  const out = [];
  for (const raw of s.split(/\s+/)) {
    const tok = raw.replace(/["'″“”]+$/g, '');
    if (!tok) continue;
    const k = keyOf(tok);
    if (!k) break;
    if (MODEL_STOP.has(k) || /^vel\b|^vel\s?\d|^velikost/.test(k)) break;
    if (/^(19|20)\d\d$/.test(k)) break;
    if (/^(r v|rv|my)(\s?\d|$)/.test(k)) break;
    if (/^\d{2,3}\s?(cm|mm|kg|km|wh|nm)$/.test(k)) break;
    if (out.length && /^(12|14|16|20|24|26|27 5|27|28|29)$/.test(k) && /["″”']|palc/.test(raw + s.slice(s.indexOf(raw) + raw.length, s.indexOf(raw) + raw.length + 2))) break;
    if (/^(27,5|27\.5)/.test(tok)) break;
    if (out.length && /^(XXS|XS|S|M|L|XL|XXL|S\/M|M\/L)$/.test(tok)) break;
    // malými písmeny psané české slovo s diakritikou = konec modelu („Author Traction pěkné kolo“)
    if (/[ěščřžýáíéůúňťď]/.test(tok) && tok === tok.toLowerCase()) break;
    out.push(tok);
    if (out.length >= 4) break;
  }
  let model = out.join(' ').replace(/[\s.,:-]+$/, '').trim();
  if (!model || model.length < 2) return null;
  if (model === model.toUpperCase() && /[A-Z]{4,}/.test(model)) {
    // „STUMPJUMPER COMP“ → „Stumpjumper Comp“ (zkratky do 3 znaků ponecháme)
    model = model
      .split(' ')
      .map((w) => (w.length <= 3 || /\d/.test(w) ? w : w[0] + w.slice(1).toLowerCase()))
      .join(' ');
  }
  return model;
}

// ---------------------------------------------------------------------------------------------------------------
// Kategorie webu

/** Kategorie webu → {kind: 'bike'|'mixed'|'nonbike'|'frames'|'unknown', type, ebike, kids, weakType}. */
function categoryInfo(categorySrc, source) {
  const c = keyOf(categorySrc || '');
  if (!c) return { kind: 'unknown' };
  const info = { kind: 'unknown', type: null, ebike: false, kids: false, weakType: false };
  if (/\bramy\b|\bram\b|\bramove sady\b/.test(c)) info.kind = 'frames';
  else if (/(komponent|\bdily\b|nahradni|doplnk|prislusenstvi|obleceni|helmy|prilby|tretry|naradi|nosice|trenazer|cyklocomputer|cyklopocitac|svetla|zamky|brasny|sedacky|voziky)/.test(c)) info.kind = 'nonbike';
  else if (/(ostatni|^cyklistika$|^sport$|kolobezk|vse ostatni|^ostatni)/.test(c)) info.kind = 'mixed';
  else if (/(kola|kolo|bicykl|bmx|elektrokol|horsk|silnicn|gravel|trek|kros|mestsk|odrazedl|e bike|ebike|fatbike|tandem|cargo)/.test(c)) info.kind = 'bike';
  if (/kolobez/.test(c) && info.kind === 'bike') info.kind = 'mixed';
  if (/elektrokol|e bike|ebike|elektro/.test(c)) info.ebike = true;
  if (/detsk|odrazedl|junior/.test(c)) info.kids = true;
  if (/odrazedl/.test(c)) info.type = 'balance';
  else if (/detsk/.test(c)) info.type = 'kids';
  else if (/bmx/.test(c)) info.type = 'bmx';
  else if (/celoodpruz|full/.test(c)) info.type = 'mtb_full';
  else if (/hardtail/.test(c)) info.type = 'mtb_hardtail';
  else if (/horsk|mtb/.test(c)) info.type = 'mtb_hardtail';
  else if (/gravel/.test(c)) info.type = 'gravel';
  else if (/cyklokros/.test(c)) info.type = 'cyclocross';
  else if (/silnicn/.test(c)) {
    info.type = 'road';
    // Bazoš má v „Silniční kola“ prakticky všechna kola (trekingová, městská, dětská, Favority…)
    info.weakType = source === 'bazos';
  } else if (/trek/.test(c)) info.type = 'trekking';
  else if (/kros|cross/.test(c)) info.type = 'cross';
  else if (/mestsk|city/.test(c)) info.type = 'city';
  else if (/skladac/.test(c)) info.type = 'folding';
  else if (/cargo|nakladn/.test(c)) info.type = 'cargo';
  else if (/fat/.test(c)) info.type = 'fatbike';
  return info;
}

// ---------------------------------------------------------------------------------------------------------------
// Typ kola

const TYPE_WORDS = [
  ['balance', /\b(odrazedl\w*|odrazadl\w*|odrazel\w*|balance\s*bike|laufrad\w*|bez\s+pedalu)\b/],
  ['bmx', /\bbmx\w*\b|\bfreestyle\s+kol\w*/],
  ['dirt', /\b(dirt\s*jump\w*|dirtjump\w*|dirt|dirtov\w*|dirtak\w*|4x|four\s*cross|pumptrack\w*|slopestyle|street\s+kol\w*|biketrial\w*|trialov\w*|trial)\b/],
  ['fatbike', /\b(fat\s?bike\w*|fatbik\w*|fat)\b/],
  ['tandem', /\b(tandem\w*|dvojkol\w*)\b/],
  ['cargo', /\b(cargo|nakladn\w*\s+kol\w*|long\s*john|bakfiets|longtail|nakladni\s+elektrokol\w*)\b/],
  ['folding', /\b(skladac\w*|skladack\w*|folding|brompton|dahon)\b/],
  ['cyclocross', /\b(cyklokros\w*|cyclocross|cyklo\s+kros\w*)\b/],
  ['gravel', /\b(gravel\w*|gravl\w*|allroad|all\s*road)\b/],
  ['road', /\b(silnicni|silnick[ayu]|silnicak\w*|road\s*bike|triatlon\w*|casovk\w*|aero\s+kol\w*|zavodni\s+kol\w*|drahov\w*|beran\w*\s+riditk\w*)\b/],
  ['mtb_full', /\b(celoodpruz\w*|celo\s*odpruz\w*|celoperov\w*|celopero|fully|full\s*suspension|enduro|downhill|freeride|dh|all\s*mountain|allmountain|sjezd\w*)\b/],
  ['mtb_hardtail', /\b(hardtail\w*|ht|horsk\w*|mtb|horak\w*|xc|cross\s*country|29er)\b/],
  ['trekking', /\b(treking\w*|trekking\w*|trekov\w*|cestovn\w*|touring|turistick\w*)\b/],
  ['cross', /\b(krosov\w*|crossov\w*|crosov\w*|kros|cross|fitness|hybrid\w*|crosstrail)\b/],
  ['city', /\b(mestsk\w*|city|holandsk\w*|dutch|cruiser|kosik\w*|singlespeed|single\s*speed|fixie|fixed\s*gear|komfortn\w*|nizk\w*\s+nastup\w*|retro|veteran\w*|historick\w*)\b/],
];

// v popisu jen jednoznačné obraty (popis často zmiňuje i jiné typy: „silniční pláště“, „jezdím po silnici“)
const DESC_TYPE_WORDS = [
  ['balance', /\b(odrazedl\w*|odrazadl\w*|balance\s*bike)\b/],
  ['bmx', /\bbmx\b/],
  ['fatbike', /\b(fat\s?bike\w*|fatbik\w*)\b/],
  ['cargo', /\b(cargo\s*kol\w*|nakladn\w*\s+kol\w*|long\s*john|bakfiets)\b/],
  ['folding', /\b(skladac\w*\s+kol\w*|skladack\w*)\b/],
  ['cyclocross', /\b(cyklokros\w*|cyclocross)\b/],
  ['gravel', /\b(gravel\w*)\b/],
  ['road', /\b(silnicni\s+kol\w*|silnick[ayu]|silnicak\w*)\b/],
  ['mtb_full', /\b(celoodpruz\w*|celoperov\w*|celopero|fully|full\s*suspension|enduro\s+kol\w*|downhill\w*|zadni\s+tlumic\w*)\b/],
  ['mtb_hardtail', /\b(hardtail\w*|horsk\w*\s+kol\w*|mtb|horak\w*)\b/],
  ['trekking', /\b(treking\w*\s+kol\w*|trekking\w*|trekov\w*\s+kol\w*|cestovn\w*\s+kol\w*)\b/],
  ['cross', /\b(krosov\w*\s+kol\w*|crossov\w*\s+kol\w*)\b/],
  ['city', /\b(mestsk\w*\s+kol\w*|holandsk\w*|s\s+kosikem)\b/],
];

const SPECIAL_TYPES = new Set(['balance', 'bmx', 'dirt', 'fatbike', 'tandem', 'cargo', 'folding']);

function firstType(text, table) {
  let best = null;
  // speciální typy (skládačka, BMX, fatbike …) mají přednost před obecnými slovy („Retro kolo skládačka“)
  for (const [type, re] of table) {
    if (!SPECIAL_TYPES.has(type)) continue;
    const m = text.match(re);
    if (m && (best === null || m.index < best.idx)) best = { type, idx: m.index };
  }
  if (best) return best.type;
  for (const [type, re] of table) {
    const m = text.match(re);
    if (m && (best === null || m.index < best.idx)) best = { type, idx: m.index };
  }
  return best ? best.type : null;
}

function typeFromParams(p) {
  const v = X.param(p, 'typ kola', 'druh kola', 'kategorie', 'typ', 'druh', 'urceni');
  if (!v) return null;
  const f = ` ${fold(v)} `;
  const t = firstType(f, TYPE_WORDS);
  if (t) return t;
  if (/detsk/.test(f)) return 'kids';
  return null;
}

const KIDS_RE = /\b(detsk\w*|pro\s+det\w*|dite|deti|junior\w*|juniorsk\w*|kids?|chlapeck\w*|divci|holcic\w*|klucic\w*|pro\s+(kluka|holku|holcicku|chlapce|divku|kluky|holky|syna|dceru)|(od|pro|do)\s+\d{1,2}\s*(let|roku)|\d{1,2}\s*-\s*\d{1,2}\s*let)\b/;
const DESC_KIDS_RE = /\b(detsk\w*\s+kol\w*|pro\s+deti|(od|pro)\s+\d{1,2}\s*(let|roku)|\d{1,2}\s*-\s*\d{1,2}\s*let|vek\w*\s+\d{1,2}\s*-\s*\d{1,2}|vyska\s+(ditete|postavy)\s+\d{2,3}\s*-\s*1[0-4]\d\s*cm)\b/;

function ebikeVariant(base, hints) {
  switch (base) {
    case 'mtb_full':
      return 'ebike_mtb_full';
    case 'mtb_hardtail':
    case 'dirt':
    case 'fatbike':
      return 'ebike_mtb';
    case 'road':
    case 'gravel':
    case 'cyclocross':
      return 'ebike_road';
    case 'trekking':
    case 'cross':
    case 'tandem':
      return 'ebike_trekking';
    case 'city':
    case 'folding':
    case 'bmx':
      return 'ebike_city';
    case 'cargo':
      return 'ebike_cargo';
    case 'kids':
    case 'balance':
      return 'ebike_kids';
    default:
      if (base && base.startsWith('ebike_')) return base;
      if (hints.full) return 'ebike_mtb_full';
      if (hints.mtb) return 'ebike_mtb';
      return 'ebike_trekking';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pomocníci pro rozhodnutí kolo × nekolo

function maskNeutral(f) {
  return f.replace(K.NEUTRAL_RE, (m) => ' '.repeat(m.length));
}

function firstNonBike(f) {
  let best = null;
  for (const [group, label, src] of NB_COMPILED) {
    const m = f.match(src);
    if (m && (best === null || m.index < best.idx)) best = { group, label, idx: m.index, word: m[0] };
  }
  return best;
}
const NB_COMPILED = K.NON_BIKE_GROUPS.map(([g, label, src]) => [g, label, new RegExp(`\\b${src}`)]);

function firstStrong(f) {
  K.BIKE_STRONG_RE.lastIndex = 0;
  const m = K.BIKE_STRONG_RE.exec(f);
  return m ? { idx: m.index, word: m[0] } : null;
}

function anyWeak(f) {
  K.BIKE_WEAK_RE.lastIndex = 0;
  const m = K.BIKE_WEAK_RE.exec(f);
  return m ? { idx: m.index, word: m[0] } : null;
}

const FRAME_HEAD_RE = /^\s*[!*\s]*((prodam|prodej|prodavam|nabizim|predam|top|super|novy|nova|nove|zanovni|karbonovy|karbonovy|carbonovy|carbon|hlinikovy|alu|ocelovy|titanovy|mtb|silnicni|gravelovy|gravel|enduro|downhill|dh|xc|trail|horsky|celoodpruzeny|dirtovy|dirt|bmx|cyklokrosovy)\s+){0,3}(ram|ramy|ramova\s+sada|ramovou\s+sadu|ram\s+kola|frameset|frame)\b/;
const FRAME_ANY_RE = /\b(ramova\s+sada|ramovou\s+sadu|frameset|ram\s*\+\s*vidlice|ram\s+s\s+vidlici|ram\s+a\s+vidlice|ram\s+vcetne\s+(vidlice|tlumice)|samotny\s+ram|pouze\s+ram|jen\s+ram|ram\s+bez\s+komponent\w*|ram\s+\+\s+tlumic)\b/;

const MULTI_RE = /\b((2|3|4|5|6|dve|tri|ctyri|par)\s*(x\s*|ks\s+)?(jizdni\s+|detsk\w*\s+|horsk\w*\s+)?(kola|kol|elektrokola|bicykly)|kola\s+\d\s*ks|(pansk|damsk|detsk|chlapeck|divci)\w*\s+(a|\+|i|,)\s+(pansk|damsk|detsk|chlapeck|divci)\w*\s+kol\w*|jizdni\s+kola|kola\s*-\s*\d|sada\s+kol\s+pro\s+rodinu|kola\s+(damska|panska|detska)|vice\s+kol)\b/;

const EBIKE_STRONG_RE = /\b(elektrokol\w*|elektro\s*kol\w*|e\s?-?\s?bike\w*|ebike\w*|e\s?-?\s?kolo|el\s?\.?\s?kol\w*|elektricke\s+kolo|elektricky\s+bicykl|pedelec|e\s?-?\s?mtb|emtb|elektro|s\s+motorem|motor\s+(bosch|shimano|yamaha|brose|bafang|panasonic)|e\s?-?\s?gravel)\b/;
const EBIKE_NEG_RE = /\b(neni\s+elektr\w*|nejedna\s+se\s+o\s+elektr\w*|bez\s+motoru|neni\s+(to\s+)?e\s?-?\s?bike|zadne\s+elektro|neelektricke)\b/;

const WARN = {
  stolen: 'Možná ukradené – chybí doklad a cena je podezřele nízká',
  frameCrack: 'Prasklý rám',
  service: 'Nutný servis',
  parts: 'Cena je za díly',
  placeholder: 'Cena je jen symbolická (pod 300 Kč) – skutečnou cenu je třeba zjistit',
  frameOnly: 'Prodává se jen rám (bez komponentů)',
  multi: 'Více kol v jednom inzerátu – cena může být za všechna',
  battery: 'Problém s baterií / motorem',
  noBattery: 'Bez baterie',
  shop: 'Prodává obchod / nové kolo – cena je spíš maloobchodní',
  noReceipt: 'Bez dokladu o koupi',
};

/**
 * Klasifikuje inzerát.
 * @param {{source?: string, title: string, description?: string, params?: object, categorySrc?: string, priceCzk?: number|null, sellerType?: string|null}} input
 * @param {{now?: Date|string|number}} [opts] `now` pro výpočet stáří (testy)
 * @returns {{isBike: boolean, bikeType: string|null, reason: string, features: object}}
 */
function classifyListing(input, opts = {}) {
  const now = opts.now != null ? new Date(opts.now) : new Date();
  const title = X.prep(input?.title || '');
  const desc = X.prep(String(input?.description || '').slice(0, 6000));
  const p = X.normParams(input?.params);
  const cat = categoryInfo(input?.categorySrc, input?.source);
  const price = Number.isFinite(Number(input?.priceCzk)) && input?.priceCzk != null ? Number(input.priceCzk) : null;
  const tMask = maskNeutral(title.f);
  const dMask = maskNeutral(desc.f);

  const brandHits = findBrands(title);
  const descBrandHits = brandHits.length ? [] : findBrands({ f: desc.f.slice(0, 600), orig: desc.orig.slice(0, 600) });
  const paramBrand = X.param(p, 'znacka', 'vyrobce', 'brand', 'znacka kola');
  let brandHit = brandHits[0] || null;
  let brandFrom = brandHit ? 'title' : null;
  if (!brandHit && paramBrand) {
    const pb = findBrands(X.prep(paramBrand));
    const pb2 = pb.length ? pb : findBrands({ ...X.prep(paramBrand), orig: String(paramBrand).toUpperCase() });
    if (pb2.length) {
      brandHit = { ...pb2[0], idx: -1, end: -1 };
      brandFrom = 'params';
    }
  }
  if (!brandHit && descBrandHits.length) {
    brandHit = descBrandHits[0];
    brandFrom = 'desc';
  }
  const brand = brandHit ? brandHit.brand : null;
  let hint = null;
  if (brand) {
    if (brandFrom === 'title') hint = modelHint(brand, title.f.slice(brandHit.end, brandHit.end + 60));
    else if (brandFrom === 'desc') hint = modelHint(brand, desc.f.slice(brandHit.end, brandHit.end + 50));
    const pm = X.param(p, 'model');
    if ((!hint || hint.generic) && pm) hint = modelHint(brand, fold(pm)) || hint;
  }

  const base = { brand: brand ? brand.name : undefined, brandTier: brand ? brand.tier : undefined };
  const nonBike = (reason, extra = {}) => ({ isBike: false, bikeType: null, reason, features: clean({ ...base, ...extra }) });

  // 1) poptávka, služba
  if (K.WANTED_RE.test(title.f) || /^\s*(koupim|kupim|shanim|hledam|poptavam|vykoupim)\b/.test(desc.f)) return nonBike('poptávka');
  if (K.SERVICE_RE.test(title.f)) return nonBike('služba (půjčovna / servis / doprava)');

  // 2) kolo × nekolo z titulku
  let isBike = null;
  let reason = '';
  let isFrameOnly = false;
  const nb = firstNonBike(tMask);
  const strong = firstStrong(tMask);
  let strongIdx = strong ? strong.idx : null;
  if (brand && brandFrom === 'title' && hint && !hint.generic) strongIdx = strongIdx == null ? brandHit.idx : Math.min(strongIdx, brandHit.idx);
  const weak = anyWeak(tMask);
  const trike = /\b(trikolk\w*|trojkolk\w*|tricykl\w*|trikolov\w*)\b/.test(title.f);

  if (trike && !(nb && nb.group === 'scooter')) {
    if (/\b(senior\w*|dospel\w*|elektr\w*|nakladn\w*|cargo)\b|(?<![\d.,])(24|26|28)(?![\d.,]?\d)/.test(title.f + ' ' + desc.f.slice(0, 300)) && !/\b(drift\w*|hrack\w*|detsk\w*\s+trikolk\w*)\b/.test(title.f)) {
      isBike = true;
      reason = 'tříkolka pro dospělé';
    } else return nonBike('tříkolka / hračka');
  }
  if (isBike === null && FRAME_HEAD_RE.test(tMask) && !(strong && strong.idx < tMask.search(/\b(ram|ramy|ramova|ramovou|frameset|frame)\b/))) {
    isBike = true;
    isFrameOnly = true;
    reason = 'jen rám';
  }
  if (isBike === null && FRAME_ANY_RE.test(tMask) && !(strong && /^(kolo|elektrokolo)/.test(strong.word))) {
    isBike = true;
    isFrameOnly = true;
    reason = 'jen rám';
  }
  if (isBike === null && strong && /^(kolo|kola|kol)$/.test(strong.word.trim())) {
    // „zapletená kola“, „přední kolo“, „kola Mavic Ksyrium“ = díl
    const wheelPart = K.WHEEL_PART_RE.test(tMask);
    const wheelBrand = K.WHEEL_BRAND_RE.test(title.f) && !brand && !weak;
    if (wheelPart || wheelBrand) {
      const other = tMask.replace(K.WHEEL_PART_RE, (m) => ' '.repeat(m.length));
      const s2 = firstStrong(other);
      if (!s2 || wheelBrand) return nonBike('zapletená kola / díl');
    }
  }
  if (isBike === null && nb) {
    // „MTB boty“, „Freeride kalhoty“, „Enduro helma“, „Gravel brašna“ – typové slovo jako přívlastek nekola
    const adjLike = strong && strong.idx === strongIdx && /^(mtb|e\s?-?\s?mtb|emtb|freeride\w*|enduro|downhill\w*|gravel\w*|gravl\w*|bmx\w*|dirt\w*|silnick\w*|fully|e\s?-?\s?bike\w*|ebike\w*|bike|biky|bikes|celoodpruz\w*|hardtail\w*|cyklokros\w*|triatlonov\w*|casovkov\w*|tandem\w*)$/.test(strong.word.trim());
    if (adjLike && nb.idx > strong.idx && nb.idx - (strong.idx + strong.word.length) <= 14 && !/\b(kolo|kola|elektrokol\w*)\b/.test(tMask.slice(strong.idx, nb.idx))) {
      return nonBike(nb.label, { nonBikeGroup: nb.group });
    }
    if (strongIdx != null && strongIdx < nb.idx) {
      isBike = true;
      reason = 'kolo (titulek)';
    } else return nonBike(nb.label, { nonBikeGroup: nb.group });
  }
  if (isBike === null && strongIdx != null) {
    isBike = true;
    reason = brand && hint && !hint.generic && !strong ? 'kolo (značka + model)' : 'kolo (titulek)';
  }
  if (isBike === null && brand && brandFrom === 'title') {
    if (K.NONBIKE_BRAND_RE.test(title.f.slice(0, brandHit.idx))) return nonBike('příslušenství / díl (značka)');
    // jen značka bez modelu a za pár stovek mimo kategorii kol = spíš doplněk (helma Kellys Dare, dres Author …)
    if (price != null && price < 500 && cat.kind !== 'bike' && brand.kind !== 'vintage' && !(hint && !hint.generic) && !weak) return nonBike('neurčeno (jen značka, nízká cena)');
    isBike = true;
    reason = 'kolo (značka)';
  }
  if (isBike === null && K.NONBIKE_BRAND_RE.test(title.f)) return nonBike('příslušenství / díl (značka)');
  if (isBike === null && weak) {
    isBike = true;
    reason = 'kolo (titulek)';
  }
  if (isBike === null && cat.kind !== 'nonbike' && /(?<![\d.,])(12|14|16|20|24|26|27[.,]5|28|29)\s*("|''|palc\w*)/.test(tMask)) {
    isBike = true;
    reason = 'kolo (velikost kol v titulku)';
  }
  if (isBike === null) {
    // bez důkazů v titulku → začátek popisu, pak kategorie
    const d0 = dMask.slice(0, 400);
    const dnb = firstNonBike(d0);
    const ds = firstStrong(d0);
    if (ds && (!dnb || ds.idx < dnb.idx)) {
      isBike = true;
      reason = 'kolo (popis)';
    } else if (dnb && (!ds || dnb.idx < ds.idx) && cat.kind !== 'bike') {
      return nonBike(dnb.label, { nonBikeGroup: dnb.group });
    } else if (cat.kind === 'frames') {
      isBike = true;
      isFrameOnly = true;
      reason = 'jen rám (kategorie)';
    } else if (cat.kind === 'bike' && (price == null || price >= 500)) {
      isBike = true;
      reason = 'kolo (kategorie)';
    } else if (brand) {
      isBike = true;
      reason = 'kolo (značka v popisu)';
    } else return nonBike(cat.kind === 'nonbike' ? 'příslušenství (kategorie)' : 'neurčeno (bez znaků kola)');
  }
  if (cat.kind === 'nonbike' && !strong && !(brand && hint && !hint.generic) && !isFrameOnly) return nonBike('příslušenství (kategorie)');
  if (cat.kind === 'frames' && !strong) isFrameOnly = true;

  // 3) vytěžení údajů
  const features = { ...base };
  const warnings = [];
  const all = title.f + '\n' + desc.f;

  // e-kolo
  let eScore = 0;
  if (EBIKE_STRONG_RE.test(title.f)) eScore += 4;
  else if (EBIKE_STRONG_RE.test(desc.f.slice(0, 1500))) eScore += 2;
  if (cat.ebike) eScore += 2;
  if (brand && (brand.kind === 'ebike' || brand.kind === 'cheap_ebike')) eScore += 2;
  if (hint && /^ebike_/.test(hint.type)) eScore += hint.generic ? 2 : 4;
  const motor = X.extractMotor(title, desc, p);
  const batteryWh = X.extractBattery(title, desc, p);
  if (motor.motor && motor.motor !== 'středový motor') eScore += 2;
  if (batteryWh) eScore += 2;
  if (X.param(p, 'delka dojezdu', 'dojezd', 'kapacita baterie', 'motor', 'baterie')) eScore += 3;
  if (/\b(hybrid|hybride|e\s?-?\s?\w+\s+hybrid)\b/.test(title.f) && brand && /Cube|Ghost|Radon/.test(brand.name)) eScore += 3;
  if (EBIKE_NEG_RE.test(all)) eScore -= 10;
  if (brand && brand.kind === 'ebike' && eScore <= 2 && price != null && price < 6000 && !cat.ebike) eScore -= 1;
  const isEbike = eScore >= 2;
  if (isEbike) {
    features.isEbike = true;
    if (motor.motor) {
      features.motor = motor.motor;
      features.motorClass = motor.motorClass;
    }
    if (batteryWh) features.batteryWh = batteryWh;
    // díl k elektrokolu („Elektrokolo Bosch baterie“ za 500 Kč)
    const ePart = /\b(bateri\w*|akumulator\w*|nabijec\w*|nabijeck\w*|motor\b|displej\w*|display|ovladac\w*|cip\b|tuning\w*|prestavb\w*|powertube|powerpack)\b/.test(tMask.replace(/\b(bez|s|se|vcetne|plus|\+)\s+(bateri\w*|nabijec\w*|nabijeck\w*|akumulator\w*)/g, ' '));
    if (ePart && price != null && price < 4000) return nonBike('díl k elektrokolu');
  } else if (brand && brand.kind === 'cheap_ebike') features.isEbike = true;

  // kola, typ
  const tKids = tMask.replace(/\bdetsk\w*\s+(cyklo)?(sedack|helm|prilb|sedadl|vozik|tyc|nosic|kresilk)\w*/g, ' ');
  const adultWheel = /\b(damsk|pansk)\w*/.test(title.f) && /(?<![\d.,])(26|27[.,]5|28|29)(?![\d])/.test(title.f);
  const kidsWords = (KIDS_RE.test(tKids) && !adultWheel) || /detsk/.test(fold(X.param(p, 'urceni', 'pro koho', 'typ') || '')) || cat.kids;
  const wheel = X.extractWheel(title, desc, p, { kidsHint: kidsWords || (brand && brand.kind === 'kids') || (hint && (hint.type === 'kids' || hint.type === 'balance')) });
  if (wheel.wheelSize) features.wheelSize = wheel.wheelSize;
  if (wheel.mullet) features.mullet = true;
  const susp = X.extractSuspension(title, desc, p);

  let bikeType = null;
  const titleType = firstType(` ${tMask} `, TYPE_WORDS);
  const paramType = typeFromParams(p);
  const descType = firstType(` ${dMask.slice(0, 2500)} `, DESC_TYPE_WORDS);
  const hintType = hint ? hint.type : null;
  const special = ['bmx', 'dirt', 'fatbike', 'tandem', 'cargo', 'folding', 'balance'];
  const ws = wheel.wheelSize ? Number(wheel.wheelSize) : null;
  const smallWheel = ws != null && ws <= 20;
  let kids =
    kidsWords ||
    (brand && brand.kind === 'kids') ||
    hintType === 'kids' ||
    hintType === 'ebike_kids' ||
    (smallWheel && !['bmx', 'dirt', 'folding', 'cargo', 'tandem'].includes(titleType || hintType || paramType)) ||
    (ws === 24 && !titleType && !['mtb_full', 'road', 'gravel', 'city', 'trekking', 'cross', 'folding', 'bmx'].includes(hintType)) ||
    (!titleType && !hintType && DESC_KIDS_RE.test(desc.f.slice(0, 600)));
  if (titleType === 'balance' || hintType === 'balance' || paramType === 'balance' || cat.type === 'balance') bikeType = 'balance';
  else if (titleType && special.includes(titleType)) bikeType = titleType;
  else if (kids) bikeType = 'kids';
  else if (titleType) {
    bikeType = titleType;
    // „Horské kolo Trek Slash“ → upřesnit podle modelu
    if (/^mtb_/.test(titleType) && hintType && /mtb/.test(hintType)) {
      bikeType = /full/.test(hintType) ? 'mtb_full' : 'mtb_hardtail';
      if (/\b(ht|hardtail)\b/.test(tMask)) bikeType = 'mtb_hardtail';
    }
    else if (titleType === 'mtb_hardtail' && hintType && ['dirt', 'fatbike'].includes(hintType)) bikeType = hintType;
    else if (['cross', 'city', 'trekking'].includes(titleType) && hintType && ['gravel', 'road', 'cyclocross'].includes(hintType)) bikeType = hintType;
  } else if (hintType) bikeType = hintType === 'ebike_kids' ? 'kids' : hintType;
  else if (brand && brand.kind === 'road') bikeType = 'road';
  else if (brand && brand.kind === 'bmx') bikeType = 'bmx';
  else if (brand && brand.kind === 'folding') bikeType = 'folding';
  else if (paramType) bikeType = paramType;
  else if (descType) bikeType = descType;
  else if (cat.type && !(cat.weakType && cat.type === 'road')) bikeType = cat.type;
  else bikeType = 'other';
  if (bikeType === 'kids' && ws === 24 && /\b(bmx)\b/.test(all)) bikeType = 'bmx';
  if (bikeType === 'mtb_hardtail' && susp === 'full') bikeType = 'mtb_full';
  if (bikeType === 'other' && susp === 'full') bikeType = 'mtb_full';
  if (isEbike) {
    const mtbHints = { full: susp === 'full', mtb: ['27.5', '29'].includes(wheel.wheelSize) && (susp === 'hardtail' || /horsk|mtb/.test(all)) };
    bikeType = ebikeVariant(bikeType === 'other' ? null : bikeType, mtbHints);
    if (bikeType === 'ebike_mtb' && susp === 'full') bikeType = 'ebike_mtb_full';
  } else if (bikeType && bikeType.startsWith('ebike_')) {
    // nápověda modelu říká e-kolo, ale text a kategorie ne
    const back = { ebike_mtb_full: 'mtb_full', ebike_mtb: 'mtb_hardtail', ebike_trekking: 'trekking', ebike_city: 'city', ebike_road: 'road', ebike_cargo: 'cargo', ebike_kids: 'kids' };
    bikeType = back[bikeType] || 'other';
  }
  if (reason === 'tříkolka pro dospělé') bikeType = isEbike ? 'ebike_city' : 'other';
  if (!BIKE_TYPES.includes(bikeType)) bikeType = 'other';
  if (bikeType === 'kids' || bikeType === 'balance' || bikeType === 'ebike_kids') {
    if (wheel.wheelSize) features.kidsWheel = wheel.wheelSize;
  }

  // značka, model
  if (brandHit) {
    const model = brandFrom === 'title' ? extractModel(title, brandHit) : brandFrom === 'desc' ? extractModel({ orig: desc.orig.slice(0, 600) }, brandHit) : X.param(p, 'model');
    if (model) features.model = String(model).slice(0, 60);
  } else {
    const pm = X.param(p, 'model');
    if (pm) features.model = String(pm).slice(0, 60);
  }

  // rok, stáří
  const yr = X.extractYear(title, desc, p, now);
  if (yr.modelYear) {
    features.modelYear = yr.modelYear;
    features.ageYears = Math.max(0, now.getFullYear() - yr.modelYear);
    features.yearSource = yr.yearSource;
  } else if (yr.vintageYear) {
    features.vintageYear = yr.vintageYear;
    features.ageYears = now.getFullYear() - yr.vintageYear;
    features.isVintage = true;
  }
  if (brand && brand.kind === 'vintage') features.isVintage = true;
  if (/\b(retro|veteran\w*|historick\w*|starozitn\w*|sberatelsk\w*|vintage)\b/.test(title.f)) features.isVintage = true;

  // velikost rámu
  const roadish = ['road', 'gravel', 'cyclocross', 'ebike_road'].includes(bikeType);
  if (bikeType !== 'kids' && bikeType !== 'balance') {
    const fs = X.extractFrameSize(title, desc, p, roadish);
    if (fs.frameSize) {
      features.frameSize = fs.frameSize;
      features.frameSizeRaw = fs.frameSizeRaw;
    }
  }

  const material = X.extractMaterial(title, desc, p);
  if (material) features.material = material;
  let suspension = susp;
  if (!suspension) {
    if (/mtb_full$/.test(bikeType)) suspension = 'full';
    else if (/^(mtb_hardtail|ebike_mtb)$/.test(bikeType)) suspension = 'hardtail';
    else if (['road', 'gravel', 'cyclocross', 'ebike_road', 'bmx'].includes(bikeType)) suspension = 'rigid';
  }
  if (/mtb_full$/.test(bikeType)) suspension = 'full';
  if (suspension) features.suspension = suspension;

  const gs = X.extractGroupset(title, desc, p);
  if (gs.groupset) {
    features.groupset = gs.groupset;
    features.groupsetTier = gs.groupsetTier;
  }
  if (gs.electronic) features.electronicShifting = true;

  const cond = X.extractCondition(title, desc, p);
  if (cond) features.condition = cond;
  const orig = X.extractOriginalPrice(title, desc, price);
  if (orig) features.originalPriceCzk = orig;
  const receipt = X.extractReceipt(all);
  if (receipt != null) features.hasReceipt = receipt;
  const warranty = X.extractWarranty(all + ' ' + fold(X.param(p, 'doba zaruky mesicu', 'zaruka', 'doba zaruky') || ''));
  if (warranty != null) features.warranty = warranty;
  if (X.param(p, 'doba zaruky mesicu', 'doba zaruky') && Number(String(X.param(p, 'doba zaruky mesicu', 'doba zaruky')).replace(/\D/g, '')) >= 12) features.warranty = true;
  const isShop = X.detectShop(title, desc, input?.sellerType);
  if (isShop) features.isShop = true;
  if (isFrameOnly) features.isFrameOnly = true;
  if (MULTI_RE.test(tMask) || (strong && strong.word.trim() === 'kola' && strong.idx < 12 && !/^\s*kola\s+\d/.test(tMask.slice(strong.idx)) && !brand)) features.isMulti = true;
  if (price != null && price < 300) features.pricePlaceholder = true;

  // varování
  if (/\b(prask\w*\s+ram|ram\s+(je\s+)?prask\w*|prasklin\w*\s+(na\s+)?ram\w*|zlomen\w*\s+ram|ram\s+zlomen\w*)/.test(all)) {
    const m = all.match(/\b(prask\w*\s+ram|ram\s+(je\s+)?prask\w*|prasklin\w*\s+(na\s+)?ram\w*|zlomen\w*\s+ram|ram\s+zlomen\w*)/);
    if (m && !X.negated(all, m.index)) warnings.push(WARN.frameCrack);
  }
  if (/\b(nutn\w*\s+servis\w*|potrebuje\s+(servis|opravu|serizeni)|potreba\s+servis\w*|nutn\w*\s+oprav\w*|nutna\s+vymena|ceka\s+na\s+servis)/.test(all)) warnings.push(WARN.service);
  if (cond === 'parts') warnings.push(WARN.parts);
  if (features.pricePlaceholder) warnings.push(WARN.placeholder);
  if (isFrameOnly) warnings.push(WARN.frameOnly);
  if (features.isMulti) warnings.push(WARN.multi);
  if (isEbike) {
    if (/\b(bez\s+baterie|baterie\s+(chybi|neni\s+soucasti)|chybi\s+baterie|bez\s+aku)/.test(all)) warnings.push(WARN.noBattery);
    else if (/\b(baterie\s+(nefunkcn\w*|nedrzi|vadn\w*|odesl\w*|slab\w*|na\s+vymenu)|vadn\w*\s+bateri\w*|nefunkcn\w*\s+(motor|baterie|displej)|motor\s+(nefunguje|nejede|vadny))/.test(all)) warnings.push(WARN.battery);
  }
  if (isShop) warnings.push(WARN.shop);
  // podezřele levné: drahá značka / původní cena vs. cena, bez dokladu
  if (price != null && price >= 300 && features.hasReceipt !== true && !isFrameOnly && !features.isMulti && cond !== 'parts' && cond !== 'poor') {
    const age = features.ageYears;
    const susOrig = orig && price < orig * 0.25 && (age == null || age <= 4);
    const adult = !['kids', 'balance', 'ebike_kids'].includes(bikeType);
    const susBrand = adult && brand && brand.tier >= 4 && (age == null ? false : age <= 4) && price < (isEbike ? 15000 : 8000);
    const susEbike = isEbike && adult && age != null && age <= 3 && price < 8000 && (!brand || brand.tier >= 2) && brand?.kind !== 'cheap_ebike';
    if (susOrig || susBrand || susEbike) warnings.push(WARN.stolen);
    else if (features.hasReceipt === false && brand && brand.tier >= 4) warnings.push(WARN.noReceipt);
  }
  if (warnings.length) features.warnings = [...new Set(warnings)];

  return { isBike: true, bikeType, reason, features: clean(features) };
}

function clean(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

module.exports = { classifyListing, CLASSIFIER_VERSION, BIKE_TYPES, categoryInfo, findBrands, extractModel, WARN };
