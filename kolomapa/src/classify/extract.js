'use strict';
// Vytěžení údajů o kole z textu inzerátu (titulek + popis + parametry webu).
// Všechny regulární výrazy pracují nad „složeným“ textem (malá písmena, bez diakritiky, stejná délka jako originál –
// viz prep()), takže pozice shody platí i v původním textu (potřebné např. pro velikost rámu „M“ jen velkým písmenem).

const { fold, keyOf, parseCzk } = require('../util/text');

/**
 * Připraví text: NFC, složení znaků po jednom (stejná délka), sjednocené uvozovky/palce.
 * @param {string} s
 * @returns {{orig: string, f: string}}
 */
function prep(s) {
  const orig = String(s ?? '').normalize('NFC');
  let f = '';
  for (const ch of orig) {
    let x = fold(ch);
    if (x.length !== ch.length) x = x.length > ch.length ? x.slice(0, ch.length) : x.padEnd(ch.length, ' ');
    f += x;
  }
  // palce a uvozovky: ″ “ ” „ ˝ ˇ → ", ’ ´ ` → '
  f = f.replace(/[″“”„˝ˇ]/g, '"').replace(/[’´`‘]/g, "'").replace(/[   ]/g, ' ');
  return { orig, f };
}

/** Parametry webu → mapa složený klíč → hodnota (string). */
function normParams(params) {
  const out = {};
  if (!params || typeof params !== 'object') return out;
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    const val = Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
    out[keyOf(k)] = val;
  }
  return out;
}

/** Najde hodnotu parametru podle (složených) klíčů, i podle začátku klíče. */
function param(p, ...keys) {
  for (const k of keys) if (p[k] != null && p[k] !== '') return p[k];
  for (const k of keys) {
    for (const pk of Object.keys(p)) if (pk.startsWith(k) && p[pk] !== '') return p[pk];
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Rok modelu

const NEG_YEAR_CTX = /(servis|baterii|baterie|baterka|zaruk|zaruc|stk|vymen|vymeni|plast|sezon|tlumic|vidlic|retez|naposledy|platnost|do konce|kupon|faktur[ay]? z|prohlidk|garancn|repas|nove brzdy|nova|nove|novy|novou)\W{0,12}$/;
const UNIT_AFTER = /^\s*(km|kc|,-|mm|cm|wh|w\b|nm|g\b|kg|ks|x\d|eur|€|cykl|let|hod|m\b|mah|ah|v\b|\.\d|,\d|\d|\/\d{2}\b|-\d)/;

/**
 * Rok modelu: params > výslovně („r.v. 2021“, „model 2022“, „MY23“) > titulek > „koupeno 2020“ > popis u slov o kole.
 * @returns {{modelYear?: number, vintageYear?: number, yearSource?: string}}
 */
function extractYear(title, desc, p, now) {
  const cur = now.getFullYear();
  const ok = (y) => y >= 2005 && y <= cur + 1;
  const res = {};
  const pv = param(p, 'rok vyroby', 'modelovy rok', 'rok modelu', 'rocnik', 'rok');
  if (pv) {
    const m = String(pv).match(/(19[5-9]\d|20[0-3]\d)/);
    if (m) {
      const y = Number(m[1]);
      if (ok(y)) return { modelYear: y, yearSource: 'params' };
      if (y < 2005) return { vintageYear: y, yearSource: 'params' };
    }
  }
  const texts = [
    ['title', title.f],
    ['desc', desc.f],
  ];
  // 1) výslovné značky
  const EXPL = /(?:\br\s*\.?\s*v\s*\.?|\brv\s*\.?|\brok\s+vyroby|\brok\s+vyr\.?|\brocnik|\bmodelov\w*\s+rok\w*|\bmodel(?:\s+rok)?|\bmodel\s*year|\bmy|\bm\s*\.\s*y\s*\.|\bz\s+roku|\broku|\brok|\br\s*\.)\s*[:\-–]?\s*'?(19[5-9]\d|20[0-3]\d|\d{2})\b/g;
  for (const [src, t] of texts) {
    for (const m of t.matchAll(EXPL)) {
      let y = Number(m[1]);
      const marker = m[0].slice(0, m[0].length - m[1].length);
      if (m[1].length === 2) {
        if (!/\bmy|m\s*\.\s*y|r\s*\.?\s*v|\brv/.test(marker)) continue;
        y = 2000 + y;
      }
      const before = t.slice(Math.max(0, m.index - 40), m.index);
      if (NEG_YEAR_CTX.test(before)) continue;
      if (UNIT_AFTER.test(t.slice(m.index + m[0].length, m.index + m[0].length + 4))) continue;
      if (/\bmodel\b/.test(marker) && m[1].length === 4 && !ok(y)) continue;
      if (ok(y)) return { modelYear: y, yearSource: src === 'title' ? 'title' : 'explicit' };
      if (y >= 1950 && y < 2005 && !/\bmodel/.test(marker)) {
        res.vintageYear = y;
        res.yearSource = 'explicit';
        return res;
      }
    }
  }
  // 2) holý rok v titulku
  for (const m of title.f.matchAll(/(?<![\d.,/:-])(19[5-9]\d|20[0-3]\d)(?![\d])/g)) {
    const y = Number(m[1]);
    const after = title.f.slice(m.index + 4, m.index + 9);
    if (UNIT_AFTER.test(after)) continue;
    const before = title.f.slice(Math.max(0, m.index - 30), m.index);
    if (NEG_YEAR_CTX.test(before)) continue;
    if (ok(y)) return { modelYear: y, yearSource: 'title' };
    if (y >= 1950 && y < 2005 && /(favorit|eska|retro|veteran|histor|starozit|sberatel|velamos|ukrajina|liberta|dukla|r\.?\s*v)/.test(title.f)) {
      return { vintageYear: y, yearSource: 'title' };
    }
  }
  // 3) „koupeno 2020“, „zakoupeno 05/2021“, „pořízeno v roce 2019“
  const PURCH = /(koupen\w*|zakoupen\w*|kupovan\w*|kupen[oaey]\b|porizen\w*|nakoupen\w*|koupil\w*|kupoval\w*|kupovane|od noveho|nove v roce|nove z roku)[^\d\n]{0,25}(?:\d{1,2}\s*[./]\s*){0,2}(20[0-3]\d)\b/g;
  for (const m of desc.f.matchAll(PURCH)) {
    const y = Number(m[2]);
    if (ok(y)) return { modelYear: y, yearSource: 'purchase' };
  }
  for (const m of title.f.matchAll(PURCH)) {
    const y = Number(m[2]);
    if (ok(y)) return { modelYear: y, yearSource: 'purchase' };
  }
  // 4) holý rok v popisu blízko slov o kole
  const BIKECTX = /(kolo|kola|ram|model|elektrokolo|bike|verze|edice|sezon)/;
  for (const m of desc.f.matchAll(/(?<![\d.,/:-])(20[0-3]\d)(?![\d])/g)) {
    const y = Number(m[1]);
    if (!ok(y)) continue;
    const after = desc.f.slice(m.index + 4, m.index + 9);
    if (UNIT_AFTER.test(after)) continue;
    const before = desc.f.slice(Math.max(0, m.index - 40), m.index);
    if (NEG_YEAR_CTX.test(before)) continue;
    if (/\d{1,2}\s*[./]\s*$/.test(before)) continue; // datum (např. 13.5.2025) bez slova „koupeno“
    const ctx = desc.f.slice(Math.max(0, m.index - 40), m.index + 30);
    if (BIKECTX.test(ctx)) return { modelYear: y, yearSource: 'text' };
  }
  return res;
}

// ---------------------------------------------------------------------------------------------------------------
// Velikost kol

const WHEEL_VALUES = { 12: '12', 14: '14', 16: '16', 18: '18', 20: '20', 24: '24', 26: '26', 27.5: '27.5', 28: '28', 29: '29' };

function normWheel(raw) {
  const s = String(raw).replace(',', '.').replace(/\s+/g, '');
  if (/^650b?$/.test(s) || s === '650') return '27.5';
  if (/^700/.test(s)) return '28';
  const n = Number(s.replace(/[^\d.]/g, ''));
  return WHEEL_VALUES[n] || null;
}

/**
 * Velikost kol z textu: „29\"“, „27,5“, „650b“, „700c“, „kola 26“, „29x2.35“, „29er“, parametry „Průměr kol“.
 * @returns {{wheelSize?: string, mullet?: boolean}}
 */
function extractWheel(title, desc, p, { kidsHint = false } = {}) {
  const pv = param(p, 'prumer kol', 'velikost kol', 'velikost kola', 'prumer kola', 'velikost rafku', 'kola');
  if (pv) {
    const m = String(pv).replace(',', '.').match(/(650\s*b|700\s*c?|27\.5|\d{2})/i);
    const w = m && normWheel(fold(m[1]));
    if (w) return { wheelSize: w };
  }
  const cands = [];
  const scan = (t, src) => {
    const add = (idx, raw, weight) => {
      const w = normWheel(raw);
      if (!w) return;
      // velikost rámu v palcích („rám 20\"“, „vel. 18\"“) není velikost kol
      const before = t.slice(Math.max(0, idx - 14), idx);
      if (/(ram\w*|vel\w*|velikost|size|frame|vyska\w*)\s*[:.]?\s*$/.test(before) && weight < 3) {
        // u dětských kol „velikost 16“ = velikost kol
        if (!(kidsHint && /vel\w*\s*[:.]?\s*$/.test(before) && !/ram\w*\s*(vel\w*)?\s*[:.]?\s*$/.test(before) && ['12', '14', '16', '20', '24'].includes(w))) return;
      }
      if (w === '18' && weight < 3) return;
      cands.push({ w, weight: weight + (src === 'title' ? 0.5 : 0), idx, src });
    };
    // „kola 29“, „ráfky 26\"“, „pláště 27,5“, „průměr kol 28“
    for (const m of t.matchAll(/\b(?:kola|kol|kolo|rafky|rafek|rafk\w*|plaste|plast|pneu\w*|prumer kol\w*|velikost kol\w*|wheels?)\s*(?:o\s+prumeru\s+)?[:\-]?\s*(12|14|16|18|20|24|26|27[.,]5|28|29|650\s*b|700\s*c?)(?![\d.,]\d)/g)) add(m.index + m[0].length - m[1].length, m[1], 3);
    // pneu rozměr „29x2.35“, „700x28c“, „26 x 2,1“
    for (const m of t.matchAll(/(?<![\d.,])(12|14|16|18|20|24|26|27[.,]5|28|29|700)\s*x\s*\d/g)) add(m.index, m[1], 3);
    // „29er“, „27,5+“
    for (const m of t.matchAll(/(?<![\d.,])(26|27[.,]5|29)\s*(?:er\b|\+)/g)) add(m.index, m[1], 3);
    // dětská kola: „velikost 16“, „vel. 20“
    if (kidsHint) for (const m of t.matchAll(/\bvel(?:ikost\w*)?\.?\s*(12|14|16|20|24)(?![\d.,]?\d)(?!\s*(?:cm|mm|let|kg))/g)) add(m.index + m[0].length - m[1].length, m[1], 2);
    // „650b“, „700c“
    for (const m of t.matchAll(/(?<![\d.,])(650\s*b|700\s*c)\b/g)) add(m.index, m[1], 3);
    // palce: 29" 29'' 29 palců 29 inch
    for (const m of t.matchAll(/(?<![\d.,])(12|14|16|18|20|24|26|27[.,]5|28|29)\s*(?:"|''|'|\s?palc\w*|\s?inch\w*|\s?in\b|\s?col\b)/g)) {
      // desetinné velikosti rámu (17,5" 19,5") sem nespadnou – 27,5 je jediné povolené desetinné
      add(m.index, m[1], 2);
    }
  };
  scan(title.f, 'title');
  scan(desc.f, 'desc');
  // holé číslo v titulku („Dětské kolo 16“, „Woom 4 20“, „Kolo 26 velikost M“)
  if (!cands.length) {
    for (const m of title.f.matchAll(/(?<![\d.,/])(12|14|16|20|24|26|27[.,]5|28|29)(?![\d.,]?\d)(?!\s*(?:kg|km|kc|cm|mm|let|ks|x\d|%))/g)) {
      const before = title.f.slice(Math.max(0, m.index - 14), m.index);
      if (/(ram\w*|vel\w*|velikost|size|frame|vyska\w*)\s*[:.]?\s*$/.test(before)) continue;
      const w = normWheel(m[1]);
      if (!w) continue;
      if (['12', '14', '16', '20', '24'].includes(w) && !kidsHint && !/\b(detsk|kids|junior|bmx|odraz|chlapeck|divci|holcic|klucic)/.test(title.f + ' ' + desc.f.slice(0, 200))) continue;
      cands.push({ w, weight: 1, idx: m.index, src: 'title' });
    }
  }
  if (!cands.length) return {};
  cands.sort((a, b) => b.weight - a.weight || (a.src === b.src ? a.idx - b.idx : a.src === 'title' ? -1 : 1));
  const out = { wheelSize: cands[0].w };
  const big = new Set(cands.filter((c) => c.weight >= 2 && ['27.5', '29'].includes(c.w)).map((c) => c.w));
  if (big.size === 2 || /\b(mullet|mx|mixed wheel)\b/.test(title.f + ' ' + desc.f)) {
    if (big.size === 2 || out.wheelSize === '29' || out.wheelSize === '27.5') {
      out.wheelSize = '29';
      out.mullet = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Velikost rámu

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL'];

function labelFromInch(inch) {
  if (inch < 14) return 'XS';
  if (inch < 16.5) return 'S';
  if (inch < 18.5) return 'M';
  if (inch < 20.5) return 'L';
  if (inch < 22.5) return 'XL';
  return 'XXL';
}

function labelFromCm(cm, road) {
  if (!road) return labelFromInch(cm / 2.54);
  if (cm < 50) return 'XS';
  if (cm < 53) return 'S';
  if (cm < 55.5) return 'M';
  if (cm < 57.5) return 'L';
  if (cm < 60.5) return 'XL';
  return 'XXL';
}

function normLetter(s) {
  const x = String(s).toUpperCase().replace(/\s+/g, '');
  const sw = x.match(/^S([1-6])$/);
  if (sw) return ['XS', 'S', 'M', 'L', 'XL', 'XXL'][Number(sw[1]) - 1];
  if (/^(XXS|XS|S|M|L|XL|XXL)$/.test(x)) return x;
  const two = x.match(/^(XXS|XS|S|M|L|XL|XXL)\/(XXS|XS|S|M|L|XL|XXL)$/);
  if (two) return `${two[1]}/${two[2]}`;
  return null;
}

/**
 * Velikost rámu: písmena (S/M/L…), Specialized S1–S6, cm (silniční) nebo palce (MTB). Vrací normalizovaný štítek a surovou hodnotu.
 * @returns {{frameSize?: string, frameSizeRaw?: string}}
 */
function extractFrameSize(title, desc, p, roadish) {
  const fromValue = (raw) => {
    const s = fold(String(raw)).trim();
    const l = s.match(/\b(xxs|xs|s|m|l|xl|xxl|s[1-6])(?:\s*\/\s*(xxs|xs|s|m|l|xl|xxl))?\b/);
    if (l) {
      const lab = normLetter(l[2] ? `${l[1]}/${l[2]}` : l[1]);
      if (lab) return { frameSize: lab, frameSizeRaw: String(raw).trim() };
    }
    const n = s.match(/(\d{2}(?:[.,]\d)?)\s*(cm|"|''|palc\w*|in\b)?/);
    if (n) {
      const v = Number(n[1].replace(',', '.'));
      const unit = n[2] || '';
      if (unit === 'cm' || v >= 40) {
        if (v >= 38 && v <= 66) return { frameSize: labelFromCm(v, roadish || v >= 47), frameSizeRaw: `${v} cm` };
      } else if (v >= 12 && v <= 24) return { frameSize: labelFromInch(v), frameSizeRaw: `${v}"` };
    }
    return null;
  };
  const pv = param(p, 'velikost ramu', 'velikost', 'ram', 'frame size', 'vyska ramu');
  if (pv) {
    const r = fromValue(pv);
    if (r) return r;
  }
  const PREFIX = /(?:\bvel(?:ikost)?\.?\s*(?:ramu|ram)?|\bram(?:u|em)?\s*(?:o\s*velikosti|vel\.?|velikost)?|\bsize|\bframe(?:\s*size)?|\bvelikosti)\s*[:\-]?\s*/g;
  for (const t of [title, desc]) {
    for (const m of t.f.matchAll(PREFIX)) {
      const start = m.index + m[0].length;
      const tail = t.f.slice(start, start + 14);
      const origTail = t.orig.slice(start, start + 14);
      let mm = tail.match(/^(xxs|xs|s|m|l|xl|xxl|s[1-6])(?:\s*\/\s*(xxs|xs|s|m|l|xl|xxl))?(?![a-z0-9])/);
      if (mm) {
        // jednopísmenné „s“ / „m“ za „vel.“ jen když v originále není předložka („velikost s košíkem“)
        if (/^[sm]$/.test(mm[1]) && !mm[2] && /^[sm]\s+[a-z]{3,}/.test(tail) && origTail[0] === origTail[0].toLowerCase()) continue;
        const lab = normLetter(mm[2] ? `${mm[1]}/${mm[2]}` : mm[1]);
        if (lab) return { frameSize: lab, frameSizeRaw: origTail.slice(0, mm[0].length).trim() };
      }
      mm = tail.match(/^(\d{2}(?:[.,]\d)?)\s*(cm|"|''|'|palc\w*|in\b)?/);
      if (mm) {
        const v = Number(mm[1].replace(',', '.'));
        const unit = mm[2] || '';
        if (unit === 'cm' || (v >= 44 && v <= 64 && unit === '')) {
          if (v >= 38 && v <= 66) return { frameSize: labelFromCm(v, roadish || (unit === '' && v >= 47)), frameSizeRaw: `${v} cm` };
        } else if (v >= 13 && v <= 23 && (unit !== '' || /ram/.test(m[0])) && !(unit === '' && [14, 16, 20].includes(v) && !/ram/.test(m[0]))) {
          return { frameSize: labelFromInch(v), frameSizeRaw: `${v}"` };
        } else if (v >= 13 && v <= 23 && unit === '' && ![14, 16, 20].includes(v)) {
          return { frameSize: labelFromInch(v), frameSizeRaw: `${v}"` };
        }
      }
    }
  }
  // samostatné písmeno velikosti v titulku – jen velkými písmeny v originále („Trek Slash 8, L“, „(M)“)
  const re = /(?:^|[\s,(/|;-])(XXS|XS|S|M|L|XL|XXL|S\/M|M\/L|L\/XL|XS\/S|S[1-6])(?=$|[\s,)/|;.!])/g;
  let last = null;
  for (const m of title.orig.matchAll(re)) {
    const after = title.orig.slice(m.index + m[0].length, m.index + m[0].length + 7);
    if (/^[\s-]*works/i.test(after)) continue; // S-Works
    if (/^\s*(kit|line|class|klass|serie|series|type)\b/i.test(after)) continue;
    last = m;
  }
  if (last) {
    const lab = normLetter(last[1]);
    if (lab) return { frameSize: lab, frameSizeRaw: last[1] };
  }
  // „54 cm“ / „rám 19\"“ bez prefixu v titulku
  const cm = title.f.match(/(?<![\d.,])(4[4-9]|5\d|6[0-4])\s*cm\b/);
  if (cm) return { frameSize: labelFromCm(Number(cm[1]), true), frameSizeRaw: `${cm[1]} cm` };
  const inch = title.f.match(/(?<![\d.,])(1[3-9]|2[0-3])[.,]5\s*(?:"|''|palc)/);
  if (inch) {
    const v = Number(inch[0].match(/\d+[.,]5/)[0].replace(',', '.'));
    return { frameSize: labelFromInch(v), frameSizeRaw: `${v}"` };
  }
  return {};
}

// ---------------------------------------------------------------------------------------------------------------
// Materiál, odpružení

function extractMaterial(title, desc, p) {
  const pv = param(p, 'material ramu', 'materal ramu', 'material', 'ram material');
  if (pv) {
    const v = fold(pv);
    if (/karbon|carbon|uhlik/.test(v)) return 'carbon';
    if (/hlinik|alu|dural/.test(v)) return 'alu';
    if (/ocel|steel|chrom/.test(v)) return 'steel';
    if (/titan/.test(v)) return 'titanium';
  }
  const COMP = '(sedlovk\\w*|riditk\\w*|kola|kol|rafk\\w*|zapleten\\w*|vidlic\\w*|klik\\w*|sedl\\w*|predstav\\w*|prevodnik\\w*|lahev|kosik\\w*|bryle|helm\\w*|tretr\\w*|blatnik\\w*|rohy|pedal\\w*|naboj\\w*|vyplet\\w*|kryt\\w*)';
  const compRe = new RegExp(`\\b(karbonov\\w*|carbon\\w*|celokarbon\\w*)\\s+${COMP}\\b|\\b${COMP}\\s+(z\\s+)?(karbon\\w*|carbon\\w*)`, 'g');
  const isCarbon = (t) => {
    const stripped = t.replace(compRe, ' ');
    return /\b(karbon\w*|carbon|celokarbon\w*|cf|uhlikov\w*|fact\s*\d+m|oclv|hi\s*mod|advanced\s+(pro|sl|\d)|crb|c\s*:\s*6[28]|tcr advanced|supersix|sl\s*carbon)\b/.test(stripped);
  };
  const ALU = /\b(hlinik\w*|alu\b|alum\w*|aluminium|aluminum|dural\w*|al\s*60\d\d|al\s*70\d\d|6061|7005|6066|7075|smartform|a1\b|caad\d*|premium aluminium|m\d premium)\b/;
  const STEEL = /\b(ocel\w*|chromoly|cromo|cro\s*mo|crmo|reynolds\s*\d{3}|columbus|steel|chromolybden\w*)\b/;
  const TI = /\b(titan\w*|titanium)\b/;
  // titulek má přednost (prodejci tam píší to podstatné)
  const tt = title.f;
  if (TI.test(tt)) return 'titanium';
  if (isCarbon(tt)) return 'carbon';
  if (/\b(hlinik\w*|alu\b|dural\w*)/.test(tt)) return 'alu';
  if (STEEL.test(tt)) return 'steel';
  const d = desc.f;
  // „rám karbon“, „karbonový rám“, „rám: hliník“
  const frameCtx = d.match(/\bram\w*\s*[:\-]?\s*(?:je\s+)?(?:z\s+)?(karbon\w*|carbon|uhlik\w*|hlinik\w*|alu\w*|dural\w*|ocel\w*|chromoly|cromo|titan\w*)|\b(karbonov\w*|carbon\w*|uhlikov\w*|hlinikov\w*|alu\w*|duralov\w*|ocelov\w*|titanov\w*|chromoly)\s+ram/);
  if (frameCtx) {
    const w = frameCtx[1] || frameCtx[2];
    if (/karbon|carbon|uhlik/.test(w)) return 'carbon';
    if (/hlinik|alu|dural/.test(w)) return 'alu';
    if (/ocel|chromoly|cromo/.test(w)) return 'steel';
    if (/titan/.test(w)) return 'titanium';
  }
  if (TI.test(d)) return 'titanium';
  if (isCarbon(d.slice(0, 400))) return 'carbon';
  if (ALU.test(d)) return 'alu';
  if (STEEL.test(d)) return 'steel';
  return null;
}

const FULL_RE = /\b(celoodpruz\w*|celo\s*odpruz\w*|celoperov\w*|celopero|fully|full\s*suspension|fullsuspension|dvojite odpruzeni|zadni tlumic\w*|tlumic\w*\s+(fox|rock\s*shox|rockshox|dvo|ohlins|marzocchi|cane\s*creek|manitou|x\s*fusion|suntour)\b[^.\n]{0,25}(float|deluxe|monarch|vivid|dpx|dhx|dps|coil|super deluxe|air|x2|inline|ds|r\b)|zdvih\w*\s+\d{2,3}\s*\/\s*\d{2,3}|\d{3}\s*\/\s*\d{3}\s*mm|\d{2,3}\s*mm\s*(vpredu|vepredu)\s*[/,a ]+\s*\d{2,3}\s*mm\s*vzadu|zadni zdvih|zdvih vzadu|fsr|enduro|downhill)\b/;
const HT_RE = /\b(hardtail\w*|odpruzen\w*\s+vidlic\w*|odpruzenou vidlic\w*|predni odpruzeni|pevna zadni stavba|ht\b)/;
const RIGID_RE = /\b(bez odpruzeni|neodpruzen\w*|pevna vidlice|pevnou vidlici|rigid|karbonova vidlice|ocelova vidlice|bezodpruzeni)\b/;

function extractSuspension(title, desc, p) {
  const pv = param(p, 'odpruzeni', 'typ odpruzeni');
  if (pv) {
    const v = fold(pv);
    if (/celo|full|plne|oboj/.test(v)) return 'full';
    if (/predni|vidlic|hardtail/.test(v)) return 'hardtail';
    if (/bez|zadne|neodpruz|rigid/.test(v)) return 'rigid';
  }
  if (FULL_RE.test(title.f)) return 'full';
  if (/\b(hardtail|ht)\b/.test(title.f)) return 'hardtail';
  if (FULL_RE.test(desc.f)) return 'full';
  if (HT_RE.test(desc.f)) return 'hardtail';
  if (RIGID_RE.test(title.f + ' ' + desc.f)) return 'rigid';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Elektro: motor, baterie

const MOTORS = [
  // [regex, název, třída]
  [/\bperformance\s*(line\s*)?cx\b|\bbosch\s*cx\b|\bcx\s*(gen|race|smart)|\bcx\s*85\s*nm|\bbosch\s*performance\s*line\s*cx/, 'Bosch Performance CX', 'premium'],
  [/\bbosch\s*(performance\s*)?(line\s*)?sx\b|\bperformance\s*line\s*sx\b/, 'Bosch SX', 'premium'],
  [/\bperformance\s*line\s*speed\b/, 'Bosch Performance Speed', 'premium'],
  [/\bperformance\s*line\b|\bbosch\s*performance\b/, 'Bosch Performance', 'premium'],
  [/\bactive\s*line\s*plus\b|\bactive\s*plus\b/, 'Bosch Active Plus', 'mid'],
  [/\bactive\s*line\b/, 'Bosch Active', 'mid'],
  [/\bcargo\s*line\b/, 'Bosch Cargo Line', 'premium'],
  [/\bbosch\b/, 'Bosch', 'premium'],
  [/\bep\s*-?\s*8\b|\bep\s*-?\s*80[01]\b|\bep8\b|\bep801\b|\bep800\b/, 'Shimano EP8', 'premium'],
  [/\bep\s*-?\s*6\b|\bep\s*-?\s*600\b|\bep6\b/, 'Shimano EP6', 'mid'],
  [/\be\s*-?\s*8000\b/, 'Shimano E8000', 'premium'],
  [/\be\s*-?\s*7000\b/, 'Shimano E7000', 'mid'],
  [/\be\s*-?\s*6100\b|\be\s*-?\s*6000\b|\be\s*-?\s*6001\b/, 'Shimano E6100', 'mid'],
  [/\be\s*-?\s*5000\b|\be\s*-?\s*5080\b/, 'Shimano E5000', 'mid'],
  [/\bshimano\s*steps\b|\bsteps\b/, 'Shimano Steps', 'mid'],
  [/\bpw\s*-?\s*x\s*3\b|\bpwx3\b/, 'Yamaha PW-X3', 'premium'],
  [/\bpw\s*-?\s*x\s*2\b|\bpwx2\b/, 'Yamaha PW-X2', 'premium'],
  [/\bpw\s*-?\s*x\b|\bpwx\b/, 'Yamaha PW-X', 'premium'],
  [/\bpw\s*-?\s*(st|se|ts|ce|s)\b/, 'Yamaha PW', 'mid'],
  [/\bsyncdrive\s*pro\b/, 'Yamaha SyncDrive Pro', 'premium'],
  [/\bsyncdrive\b/, 'Yamaha SyncDrive', 'mid'],
  [/\byamaha\b/, 'Yamaha', 'mid'],
  [/\bspecialized\s*sl\s*1\.\d|\bsl\s*1\.[12]\b/, 'Specialized SL', 'premium'],
  [/\b(turbo\s*)?full\s*power\s*(2|3)\.\d|\bspecialized\s*(2\.\d|3\.\d)\b|\bturbo\s*(2|3)\.\d/, 'Specialized (Brose)', 'premium'],
  [/\bbrose\b/, 'Brose', 'premium'],
  [/\btq\s*-?\s*hpr\s*\d*|\bhpr\s*50\b|\btq\b/, 'TQ', 'premium'],
  [/\bfazua\b/, 'Fazua', 'premium'],
  [/\bavinox\b|\bdji\b/, 'DJI Avinox', 'premium'],
  [/\bpinion\s*mgu\b/, 'Pinion MGU', 'premium'],
  [/\bpanasonic\b/, 'Panasonic', 'mid'],
  [/\bbafang\b|\bm\s*-?\s*(400|500|510|600|620)\b|\bbbs\s*0?[123]\b|\bbbshd\b/, 'Bafang', 'mid'],
  [/\bananda\b/, 'Ananda', 'mid'],
  [/\bmahle\b|\bebikemotion\b|\bx\s*35\b/, 'Mahle', 'mid'],
  [/\bsuntour\s*hesc\b|\bhesc\b/, 'Suntour HESC', 'mid'],
  [/\b(stredov\w*|centraln\w*)\s+motor\w*|\bmotor\w*\s+(ve\s+)?stred\w*/, 'středový motor', 'mid'],
  [/\b(motor\w*\s+v\s+(zadnim|prednim)\s+(kole|naboji)|nabojov\w*\s+motor\w*|(zadni|predni)\s+motor\w*|motor\w*\s+v\s+naboji|hub\s*motor|zadni\s+nabojovy)\b/, 'motor v náboji', 'hub'],
];

/** @returns {{motor?: string, motorClass?: string}} */
function extractMotor(title, desc, p) {
  const pv = param(p, 'motor', 'typ motoru', 'pohon', 'umisteni motoru');
  const texts = [title.f, pv ? fold(pv) : '', desc.f];
  for (const t of texts) {
    if (!t) continue;
    for (const [re, name, cls] of MOTORS) if (re.test(t)) return { motor: name, motorClass: cls };
  }
  return {};
}

/** Kapacita baterie ve Wh (150–2000): „625 Wh“, „PowerTube 750“, „36V 14Ah“, „M2-700“. */
function extractBattery(title, desc, p) {
  const pv = param(p, 'kapacita baterie', 'baterie', 'akumulator', 'kapacita akumulatoru');
  const cands = [];
  for (const t of [title.f, pv ? fold(pv) : '', desc.f]) {
    if (!t) continue;
    for (const m of t.matchAll(/(?<![\d.,])(\d{3,4})\s*-?\s*wh\b/g)) cands.push(Number(m[1]));
    if (cands.length) break;
    for (const m of t.matchAll(/\b(?:powertube|powerpack|power\s*tube|power\s*pack|m2\s*-?|baterie|baterii|akumulator\w*)\s*(\d{3})\b/g)) cands.push(Number(m[1]));
    if (cands.length) break;
    let va = t.match(/\b(24|36|48|52)\s*v\b[^\d\n]{0,12}?(\d{1,2}(?:[.,]\d)?)\s*ah\b/);
    let volts = va ? Number(va[1]) : null;
    let amps = va ? Number(va[2].replace(',', '.')) : null;
    if (!va) {
      va = t.match(/\b(\d{1,2}(?:[.,]\d)?)\s*ah\b[^\d\n]{0,12}?(24|36|48|52)\s*v\b/);
      if (va) {
        amps = Number(va[1].replace(',', '.'));
        volts = Number(va[2]);
      }
    }
    if (va) {
      const wh = Math.round(volts * amps);
      if (wh >= 150 && wh <= 2000) cands.push(wh);
    }
    if (cands.length) break;
  }
  const ok = cands.filter((w) => w >= 150 && w <= 2000);
  if (!ok.length) return null;
  // více baterií („2× 500 Wh“, „625 + 250 Wh range extender“) → největší jednotlivá
  return Math.max(...ok);
}

// ---------------------------------------------------------------------------------------------------------------
// Sada komponent (groupset)

// [regex, název, tier (1–6)] – pořadí: specifičtější první
const GROUPSETS = [
  [/\bdura\s*-?\s*ace\b|\bdurace\b|\br9[12]\d0\b|\b9[01]\d0\b(?=.*shimano)/, 'Shimano Dura-Ace', 6],
  [/\bultegra\b|\br8[01]\d0\b|\br81[57]0\b|\b6800\b|\b6870\b/, 'Shimano Ultegra', 5],
  [/\bxtr\b|\bm9[01]\d0\b/, 'Shimano XTR', 6],
  [/\bdeore\s*xt\b|\bxt\b(?!\s*-?\s*r)|\bm8[01]\d0\b|\bm8000\b/, 'Shimano XT', 5],
  [/\bsaint\b/, 'Shimano Saint', 5],
  [/\bslx\b|\bm7[01]\d0\b/, 'Shimano SLX', 4],
  [/\bzee\b/, 'Shimano Zee', 4],
  [/\bgrx\s*-?\s*(rx\s*)?8\d\d\b|\bgrx\s*di2\b/, 'Shimano GRX 800', 5],
  [/\bgrx\s*-?\s*(rx\s*)?6\d\d\b/, 'Shimano GRX 600', 4],
  [/\bgrx\s*-?\s*(rx\s*)?4\d\d\b/, 'Shimano GRX 400', 3],
  [/\bgrx\b/, 'Shimano GRX', 4],
  [/\b(shimano\s*)?105\s*(di2|r7\d00|5800|5700)\b|\bshimano\s*105\b|\b105\s*(ka|tka|ky|ce)\b|\b(sada|komponent\w*|osazen\w*|kompletni|full|skupina|rada|radi|radic\w*|razeni|prehaz\w*|group\w*)\s*(shimano\s*)?105\b|\br7[01][057]0\b|\b5800\b/, 'Shimano 105', 4],
  [/\btiagra\b|\b4700\b|\b4[67]00\b(?=.*shimano)/, 'Shimano Tiagra', 3],
  [/\bsora\b|\br3000\b|\b3500\b(?=.*shimano)/, 'Shimano Sora', 2],
  [/\bclaris\b|\br2000\b/, 'Shimano Claris', 1],
  [/\bcues\b/, 'Shimano Cues', 2.5],
  [/\bdeore\b|\bm[56][01]\d0\b|\bm6000\b|\bm5100\b/, 'Shimano Deore', 3],
  [/\balivio\b|\bm4[01]\d0\b/, 'Shimano Alivio', 2],
  [/\bacera\b|\bm3[01]\d0\b/, 'Shimano Acera', 2],
  [/\baltus\b|\bm2[01]\d0\b/, 'Shimano Altus', 1],
  [/\btourney\b|\btx\s*-?\s*\d{2,3}\b|\bty\s*-?\s*\d{3}\b/, 'Shimano Tourney', 1],
  [/\bsram\s*xx\s*sl\b|\bxx\s*sl\b|\bxx\s*1\b|\bxx1\b|\bsram\s*xx\b|\bxx\s*(eagle|t\s*-?\s*type|axs)\b/, 'SRAM XX', 6],
  [/\bx\s*0\s*1\b|\bx01\b|\bx\s*0\s*(eagle|t\s*-?\s*type|axs|dh)\b|\bsram\s*x\s*0\b|\bx0\b/, 'SRAM X01', 5],
  [/\bgx\b/, 'SRAM GX', 4],
  [/\bnx\b/, 'SRAM NX', 3],
  [/\bsx\s*eagle\b|\bsram\s*sx\b/, 'SRAM SX', 2],
  [/\bsram\s*x\s*9\b|\bx\s*9\b(?=[^\n]{0,30}sram)|\bsram\s*x9\b/, 'SRAM X9', 4],
  [/\bsram\s*x\s*7\b|\bsram\s*x7\b/, 'SRAM X7', 3],
  [/\bsram\s*x\s*[345]\b/, 'SRAM X5', 2],
  [/\bsram\s*red\b|\bred\s*(axs|etap|e\s*tap|22)\b/, 'SRAM Red', 6],
  [/\bsram\s*force\b|\bforce\s*(axs|etap|e\s*tap|22|1\b|cx1|xplr)/, 'SRAM Force', 5],
  [/\bsram\s*rival\b|\brival\s*(axs|etap|e\s*tap|22|1\b|xplr)/, 'SRAM Rival', 4],
  [/\bsram\s*apex\b|\bapex\s*(axs|1\b|xplr|eagle)/, 'SRAM Apex', 3],
  [/\beagle\b/, 'SRAM Eagle', 3],
  [/\bsuper\s*record\b/, 'Campagnolo Super Record', 6],
  [/\b(campagnolo|campa)\s*record\b|\brecord\s*eps\b/, 'Campagnolo Record', 5.5],
  [/\bchorus\b/, 'Campagnolo Chorus', 5],
  [/\bekar\b/, 'Campagnolo Ekar', 4.5],
  [/\bpotenza\b/, 'Campagnolo Potenza', 4],
  [/\bcentaur\b/, 'Campagnolo Centaur', 4],
  [/\bathena\b/, 'Campagnolo Athena', 4],
  [/\bveloce\b/, 'Campagnolo Veloce', 3],
  [/\bmicro\s*shift\b|\bmicroshift\b|\badvent\s*x?\b/, 'microSHIFT', 2],
];

const GS_CTX = /(prehaz\w*|prehazk\w*|\brd\b|radic\w*|razeni|radi\b|sada|skupin\w*|group\w*|komponent\w*|osazen\w*|vybav\w*|full|kompletn\w*|pohon|prevod\w*)[^\n]{0,25}$/;

/** @returns {{groupset?: string, groupsetTier?: number, electronic?: boolean}} */
function extractGroupset(title, desc, p) {
  const pv = param(p, 'sada komponent', 'radici sada', 'komponenty', 'groupset', 'sada', 'prehazovacka', 'razeni');
  const scanText = (t) => {
    const found = [];
    for (const [re, name, tier] of GROUPSETS) {
      const g = new RegExp(re.source, 'g');
      for (const m of t.matchAll(g)) {
        // „XT“ v „XTC“ apod. řeší \b; „Deore“ v „Deore XT“ – přeskočit, pokud za ním je XT/XTR
        if (name === 'Shimano Deore' && /^\s*xt/.test(t.slice(m.index + m[0].length, m.index + m[0].length + 4))) continue;
        if (name === 'SRAM GX' && /\b(bosch|motor)\b/.test(t.slice(Math.max(0, m.index - 12), m.index))) continue;
        const ctx = GS_CTX.test(t.slice(Math.max(0, m.index - 40), m.index));
        found.push({ name, tier, idx: m.index, ctx });
      }
    }
    return found;
  };
  let electronic = /\b(di2|axs|e\s*-?\s*tap|etap|eps)\b/.test(title.f + ' ' + desc.f + ' ' + (pv ? fold(pv) : ''));
  let pick = null;
  if (pv) {
    const f = scanText(fold(pv));
    if (f.length) pick = f.sort((a, b) => b.tier - a.tier)[0];
  }
  if (!pick) {
    const t = scanText(title.f);
    if (t.length) pick = t.sort((a, b) => b.tier - a.tier)[0];
  }
  if (!pick) {
    const d = scanText(desc.f);
    if (d.length) {
      const withCtx = d.filter((x) => x.ctx);
      const pool = withCtx.length ? withCtx : d;
      const counts = new Map();
      for (const x of pool) counts.set(x.name, (counts.get(x.name) || 0) + 1);
      pool.sort((a, b) => counts.get(b.name) - counts.get(a.name) || b.tier - a.tier);
      pick = pool[0];
    }
  }
  if (!pick) return electronic ? { electronic: true } : {};
  let tier = pick.tier;
  if (electronic && tier >= 3) tier = Math.min(6, tier + 0.5);
  return { groupset: pick.name, groupsetTier: tier, ...(electronic ? { electronic: true } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------
// Stav

const NEGATION_BEFORE = /\b(ne(ni|ma|jsou|bylo|byl|byla)|bez|zadn[eayaou]\w*|nikdy|nijak\w*|ani)\s+(\w+\s+){0,2}$/;

function negated(t, idx) {
  return NEGATION_BEFORE.test(t.slice(Math.max(0, idx - 30), idx));
}

const COND_LEVELS = ['new', 'like_new', 'very_good', 'good', 'fair', 'poor', 'parts'];

// [regex, úroveň] – vyhodnocuje se nad titulkem i popisem
const COND_PATTERNS = [
  [/\b(na\s+(nahradni\s+)?dily|na\s+nd\b|cena\s+(je\s+)?za\s+dily|jen\s+na\s+dily|pouze\s+na\s+dily|prask\w*\s+ram|ram\s+(je\s+)?prask\w*|prasklin\w*\s+(na\s+)?ram\w*|zlomen\w*\s+ram|ram\s+zlomen\w*)/, 'parts'],
  [/\b(na\s+opravu|k\s+oprave|nepojizd\w*|nefunkcn\w*|na\s+renovaci|k\s+renovaci|ke\s+zprovozneni|nutna\s+oprava|potrebuje\s+opravu|poskozen\w*|rozbit\w*|ohnut\w*\s+(ram|vidlic)|po\s+nehode|po\s+pade|vadn\w*\s+(motor|baterie|ram))/, 'poor'],
  [/\b(potrebuje\s+(servis|serizeni|seridit|nove)|nutny\s+servis|nutn\w*\s+(vymen\w*|servis\w*|serizeni)|potreba\s+(servis\w*|serid\w*|vymen\w*)|opotreben\w*|horsi\s+stav|rezav\w*|rez\b|zrezl\w*|odren\w*|stav\s+odpovida\s+(veku|stari)|odpovidajici\s+(veku|stari)|cetne\s+(skrabance|odrenin\w*)|vetsi\s+(skrabance|odreniny))/, 'fair'],
  [/\b(dobry\s+stav|dobrem\s+stavu|bezne\s+(opotreben\w*|znamky|stopy|oderky|skrab\w*)|drobne\s+(oderky|skrab\w*|vady|kosmet\w*|odreniny)|kosmetick\w*\s+(vady|oderky|skrab\w*)|plne\s+funkcni|funkcni|pojizdn\w*|stav\s+dle\s+foto|znamky\s+pouzivani|stopy\s+pouzivani|pouzivan\w*|jezden\w*)/, 'good'],
  [/\b(velmi\s+dobr\w*\s+stav\w*|vyborn\w*\s+stav\w*|velmi\s+pekn\w*\s+stav\w*|pekn\w*\s+stav\w*|krasn\w*\s+stav\w*|super\s+stav\w*|zachoval\w*|velmi\s+zachoval\w*|bez\s+(skrab\w*|oderek|vad\b|vady|poskozeni|investic)|malo\s+(jezden\w*|pouzivan\w*|jete)|bezvadn\w*\s+stav\w*|bezvadn\w*|udrzovan\w*|pravidelne\s+servis\w*|v\s+pekn\w*\s+stavu)/, 'very_good'],
  [/\b(jako\s+nov\w*|zanovn\w*|temer\s+nov\w*|skoro\s+nov\w*|takrka\s+nov\w*|prakticky\s+nov\w*|minimalne\s+(jezden\w*|pouzivan\w*|jete)|top\s+stav\w*|perfektn\w*\s+stav\w*|stav\s+nove\w*|nejezden\w*|nejete|neojet\w*|najet\w*\s+(jen\s+|pouze\s+|cca\s+|asi\s+|max\.?\s+)?\d{1,3}\s*km|ujet\w*\s+(jen\s+|pouze\s+|cca\s+)?\d{1,3}\s*km|par\s+km|nekolik\s+km|1\s*x\s+jet\w*|temer\s+nejet\w*|temer\s+nepouzit\w*)/, 'like_new'],
  [/\b(zcela\s+nov\w*|uplne\s+nov\w*|nove,?\s+nepouzit\w*|nepouzit\w*|nerozbalen\w*|v\s+puvodnim\s+baleni|v\s+originalnim\s+baleni|zabalen\w*|kolo\s+je\s+nove|nove\s+kolo|novy\s+bicykl|nove\s+elektrokolo|nove\s+v\s+krabici|nova\s+kola|novinka\s+20\d\d|skladem)/, 'new'],
];

const PARAM_COND = [
  [/na\s+dily|poskoz|nefunk/, 'parts'],
  [/opotreb|horsi|silne\s+pouz/, 'fair'],
  [/^nove?\b|^nov[ya]\b|novy|nove zbozi|^novy|^nova|\bnew\b/, 'new'],
  [/jako nove|zanovn|rozbal|mirne pouz|temer nove|vystaven/, 'like_new'],
  [/velmi dobr|vyborn|vyborny/, 'very_good'],
  [/dobr/, 'good'],
  [/pouzit|pouzivan|used/, 'good'],
];

/**
 * Stav kola z parametrů a textu (s ohledem na negaci „není poškozené“).
 * @returns {string|null} new|like_new|very_good|good|fair|poor|parts
 */
function extractCondition(title, desc, p) {
  const pv = param(p, 'stav', 'stav zbozi', 'stav kola', 'condition');
  let fromParam = null;
  if (pv) {
    const v = fold(pv);
    for (const [re, lvl] of PARAM_COND) if (re.test(v)) {
      fromParam = lvl;
      break;
    }
  }
  const hits = new Set();
  for (const t of [title.f, desc.f]) {
    for (const [re, lvl] of COND_PATTERNS) {
      const g = new RegExp(re.source, 'g');
      for (const m of t.matchAll(g)) {
        if (negated(t, m.index)) continue;
        // „nové pláště / nový řetěz“ není stav kola; „nové kolo“ ano – vzory pro 'new' jsou úzké
        hits.add(lvl);
      }
    }
  }
  // Titulek „Nové …“ / „NOVÉ“ na začátku = nové kolo (prodejce)
  if (/^\s*(nov[eyaá]\w*|nove|novy|nova)\b(?!\s+(plast|duse|retez|brzd|sedl|riditk|baterie|nabijec))/.test(title.f) || /\b(nove|novy)\s*$/.test(title.f)) hits.add('new');
  let best = null;
  for (const lvl of ['new', 'like_new', 'very_good', 'good']) if (hits.has(lvl)) {
    best = lvl;
    break;
  }
  if (fromParam && fromParam !== 'good') best = fromParam;
  else if (fromParam === 'good' && !best) best = 'good';
  if (hits.has('parts')) return 'parts';
  if (hits.has('poor')) return 'poor';
  if (hits.has('fair')) {
    if (!best) return 'fair';
    if (COND_LEVELS.indexOf(best) < COND_LEVELS.indexOf('good')) return 'good';
  }
  // „jezdeno“/„používané“ samo o sobě neznamená horší stav, než co prodejce výslovně napsal
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Původní cena, doklad, záruka, obchod

const ORIG_MARKERS = /(?:puvodni\s+cen\w*|puv\.?\s*cen\w*|porizovac\w*\s+cen\w*|nakupni\s+cen\w*|katalogov\w*\s+cen\w*|doporucen\w*\s+(maloobchodni\s+)?cen\w*|cena\s+(noveho|nove|novych|v\s+obchode)|\bmoc\b|\bpc\b|\bp\s*\.\s*c\s*\.?|nove\s+(stalo|stoji|stal\w*|za|kupovano\s+za)|nova\s+stala|novy\s+stal|stalo\s+(nove|me|mne)|kupovan\w*\s+(za|v\s+cene)|koupen\w*\s+(za|v\s+cene)|zakoupen\w*\s+(za|v\s+cene)|porizen\w*\s+(za|v\s+cene)|v\s+obchode\s+(stoji|za|stalo)|aktualni\s+cena\s+(noveho|nove)|cena\s+nov\w*\s+kol\w*|orig\w*\s+cen\w*|retail|msrp|prodejni\s+cena\s+(prodejce|v\s+obchode|nove|noveho)|za\s+nove\s+jsem\s+dal\w*|dal\w*\s+jsem\s+za\s+n\w*|stalo\s+mne|stalo\s+me)/g;

/** „původní cena 45 000“, „PC 45k“, „nové za 45 tis.“ → 45000 (Kč; EUR × 25). */
function extractOriginalPrice(title, desc, priceCzk) {
  for (const t of [desc.f, title.f]) {
    for (const m of t.matchAll(ORIG_MARKERS)) {
      const tail = t.slice(m.index + m[0].length, m.index + m[0].length + 32);
      const mm = tail.match(/^\s*(?:je|byla|bylo|byl|cca|asi|pres|okolo|kolem|:|=|-|–|bez\s+mala|necelych|skoro|temer)?\s*(?:je|byla|cca|asi|pres)?\s*[:=]?\s*(\d{1,3}(?:[ . ]\d{3})+|\d+(?:[.,]\d+)?)\s*(tis\w*\.?|tisic\w*|k\b|000|,-|kc|czk|eur|€|e\b)?/);
      if (!mm) continue;
      let n;
      const unit = (mm[2] || '').toLowerCase();
      const num = mm[1];
      if (/^tis|^k$/.test(unit)) n = Number(num.replace(/\s/g, '').replace(',', '.')) * 1000;
      else n = Number(num.replace(/[ . ]/g, '').replace(',', '.'));
      if (/eur|€|^e$/.test(unit)) n *= 25;
      if (!Number.isFinite(n)) continue;
      if (n < 300 && n >= 1 && /^\d+([.,]\d)?$/.test(num) && !unit) n *= 1000; // „PC 45“ = 45 tis.
      n = Math.round(n);
      if (n < 1000 || n > 800000) continue;
      if (priceCzk && priceCzk > 300 && n < priceCzk * 0.8) continue;
      return n;
    }
  }
  return null;
}

function extractReceipt(t) {
  if (/\b(bez\s+(dokladu|uctenky|faktury|papiru)|doklad\w*\s+(nemam|chybi|neni|ztracen)|nemam\s+(doklad|uctenk|faktur))/.test(t)) return false;
  if (/\b(doklad\w*\s+(o\s+koupi|o\s+nakupu|k\s+dispozici|mam|je|samozrejmost)|s\s+dokladem|vcetne\s+dokladu|uctenk\w*|faktur\w*|zarucni\s+list|paragon\w*|doklad\w*|nakupni\s+doklad)/.test(t)) return true;
  return null;
}

function extractWarranty(t) {
  if (/\b(bez\s+(zaruky|zaruk|garance)|zaruka\s+(skoncil\w*|vyprsel\w*|uz\s+neni|jiz\s+neni)|po\s+zaruce)/.test(t)) return false;
  if (/\b(v\s+zaruce|zaruk\w*\s+(do|jeste|stale|plati|zbyva|\d)|zbyva\w*\s+zaruk\w*|jeste\s+zaruk\w*|stale\s+(je\s+)?v\s+zaruce|zaruka\s+\d+\s*(rok|let|mes)|\d+\s*(roky|let|mesic\w*)\s+zaruk\w*|garanc\w*\s+do|zaruc\w*\s+(do|list))/.test(t)) return true;
  return null;
}

const SHOP_PATTERNS = [
  /\bzaruka\s+(2\s*roky|24\s*mes\w*|dva\s+roky)/,
  /\b(moznost\s+splat\w*|na\s+splatky|splatky|leasing|financovani)\b/,
  /\b(skladem|ihned\s+k\s+odberu|dodani\s+do|dodaci\s+lhut\w*|expedujeme|expedice)\b/,
  /\b(nase\s+prodejn\w*|nasi\s+prodejn\w*|na\s+prodejne|prodejna|kamenn\w*\s+prodejn\w*|showroom|e\s*-?\s*shop|eshop|internetov\w*\s+obchod)\b/,
  /\b(www\.|https?:\/\/)(?![^\s]*(bazos|sbazar|aukro|cyklobazar|youtube|facebook|instagram|strava|google))/,
  /\b(ico|dic|platce\s+dph|faktur\w*\s+s\s+dph|odpocet\s+dph|vcetne\s+dph|bez\s+dph|cena\s+s\s+dph)\b/,
  /\b(nabizime|v\s+nasi\s+nabidce|nase\s+nabidka|objednav\w*|zasilame|dopravu\s+zajistime|doprava\s+zdarma|vyprodej\w*|akce|akcni\s+cena|sleva\s+\d+\s*%|zlevneno|vyprodej\s+skladu)\b/,
  /\b(predvadec\w*|testovac\w*\s+kol\w*|demo\s+kol\w*|testovaci\s+flotil\w*|z\s+pujcovny)\b/,
  /\b(novy\s+model|nove\s+v\s+krabici|nerozbalen\w*|zabalen\w*\s+v\s+krabici|primo\s+od\s+vyrobce|od\s+vyrobce|oficialni\s+(prodejce|dealer|distributor)|autorizovan\w*\s+(prodejce|dealer|servis))\b/,
];

/** Odhad, zda inzerát podává obchod / dealer (typicky nová kola s fakturou a zárukou). */
function detectShop(title, desc, sellerType) {
  let score = 0;
  if (sellerType === 'company') score += 2;
  const t = title.f + '\n' + desc.f;
  for (const re of SHOP_PATTERNS) if (re.test(t)) score++;
  if (/\b(nove|novy|nova)\b/.test(title.f) && /\bfaktur/.test(t)) score++;
  return score >= 2;
}

module.exports = {
  prep,
  normParams,
  param,
  extractYear,
  extractWheel,
  extractFrameSize,
  extractMaterial,
  extractSuspension,
  extractMotor,
  extractBattery,
  extractGroupset,
  extractCondition,
  extractOriginalPrice,
  extractReceipt,
  extractWarranty,
  detectShop,
  negated,
  normWheel,
  labelFromCm,
  labelFromInch,
  SIZE_ORDER,
  COND_LEVELS,
  MOTORS,
  GROUPSETS,
  FULL_RE,
  parseCzk,
};
