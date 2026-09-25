// Model konfigurace strategie (SPEC §6.5) – výchozí hodnoty, popisky, nápověda,
// validace, klientské zaokrouhlení (náhled, SPEC §6.6) a lidsky čitelné shrnutí.
// Čistý modul bez DOM.

import { money, number, NBSP } from './format.js';
import { describeFilter, isEmptyFilter, validateFilter } from './filter-model.js';

/**
 * Výchozí konfigurace nové strategie – musí přesně odpovídat DEFAULT_CONFIG enginu (src/engine/presets.js).
 * Shodu hlídá test test/ui-strategy-sync.test.js (výchozí hodnoty i seznamy režimů).
 * Engine podporuje i časové okno (schedule), doplňující podmínky (conditions), doprodej (clearance),
 * vyloučení nabídek podle klíčových slov a záložní režim „next“ (propadnutí na další strategii).
 */
export const DEFAULT_CONFIG = Object.freeze({
  conditions: {},
  schedule: { valid_from: null, valid_to: null, weekdays: [], hours: null },
  target: {
    mode: 'undercut_min', offset_abs: 0, offset_pct: 0, rank: 1, competitor: null, markup_pct: null, fixed_price: null,
    step_pct: 5, every_days: 14, max_sales_30: 0,
  },
  competitors: {
    include: [], exclude: [], include_tags: [], exclude_tags: [],
    in_stock_only: true, include_shipping: false, max_age_days: null, outlier_pct: null, min_competitors: 1,
    exclude_keywords: [],
  },
  fallback: { mode: 'next', markup_pct: null, offset_pct: 0 },
  limits: {
    min_margin_pct: 10, min_profit_abs: null, max_margin_pct: null,
    max_above_msrp_pct: 0, max_below_msrp_pct: null,
    max_decrease_pct: 10, max_increase_pct: 15,
    allow_increase: true, allow_decrease: true,
    min_change_pct: 0.5, min_change_abs: 5,
    respect_product_limits: true,
  },
  rounding: {
    mode: 'ending', direction: 'down',
    bands: [{ up_to: 1000, ending: 9 }, { up_to: 10000, ending: 90 }, { up_to: null, ending: 990 }],
  },
  stock: { zero_stock: 'reprice' },
  approval: { auto: false, auto_max_change_pct: 5 },
});

export const WEEKDAYS = [
  { value: 1, short: 'Po', label: 'pondělí' },
  { value: 2, short: 'Út', label: 'úterý' },
  { value: 3, short: 'St', label: 'středa' },
  { value: 4, short: 'Čt', label: 'čtvrtek' },
  { value: 5, short: 'Pá', label: 'pátek' },
  { value: 6, short: 'So', label: 'sobota' },
  { value: 7, short: 'Ne', label: 'neděle' },
];

export const TARGET_MODES = [
  {
    value: 'undercut_min', label: 'Podlézt nejnižší cenu', market: true, offsets: true,
    help: 'Referencí je nejnižší cena konkurence. Posun určí, o kolik budete levnější: „Podlézt nejnižší cenu o 1 %“ z 10 000 Kč dá cíl 9 900 Kč, posun −10 Kč dá 9 990 Kč.',
  },
  {
    value: 'match_min', label: 'Dorovnat nejnižší cenu', market: true, offsets: false,
    help: 'Cílem je přesně nejnižší cena konkurence (posuny se ignorují). Po zaokrouhlení můžete vyjít o pár korun jinak.',
  },
  {
    value: 'rank', label: 'Držet pozici v žebříčku', market: true, offsets: true,
    help: 'Cílem je cena konkurenta na zvolené pozici (1 = nejlevnější nabídka). S posunem −1 Kč budete těsně pod ním. Když je konkurentů méně, vezme se ten poslední.',
  },
  {
    value: 'market_median', label: 'Medián trhu', market: true, offsets: true,
    help: 'Cílem je prostřední cena konkurence ± posun. Na rozdíl od průměru ji nevychýlí jeden extrémně levný nebo drahý obchod.',
  },
  {
    value: 'market_avg', label: 'Průměr trhu', market: true, offsets: true,
    help: 'Cílem je průměr cen konkurence ± posun. Hodí se, když nechcete bojovat o nejnižší cenu.',
  },
  {
    value: 'competitor', label: 'Konkrétní konkurent', market: true, offsets: true,
    help: 'Cílem je cena vybraného konkurenta ± posun. Když konkurent produkt nemá (nebo je vyřazen), použije se náhradní režim.',
  },
  {
    value: 'msrp', label: 'Doporučená cena (MOC)', market: false, offsets: true,
    help: 'Cílem je doporučená maloobchodní cena výrobce ± posun. Konkurence se nezohledňuje.',
  },
  {
    value: 'cost_plus', label: 'Nákup + přirážka', market: false, offsets: false,
    help: 'Cena bez DPH = nákupní cena × (1 + přirážka). Např. nákup 1 000 Kč a přirážka 40 % → 1 400 Kč bez DPH (1 694 Kč s DPH).',
  },
  {
    value: 'keep', label: 'Ponechat současnou cenu', market: false, offsets: false,
    help: 'Cena se nemění, strategie jen hlídá limity – např. zvedne cenu, která je pod minimální marží, nebo sníží cenu nad stropem MOC.',
  },
  {
    value: 'fixed', label: 'Pevná cena', market: false, offsets: false,
    help: 'Všem produktům, na které strategie platí, nastaví zadanou cenu s DPH (limity se přesto uplatní).',
  },
  {
    value: 'clearance', label: 'Doprodej – postupné slevy', market: false, offsets: false,
    help: 'Každých N dní zlevní o zadané %, dokud se produkt neprodává (prodeje za 30 dní nejvýše limit). Limity dál platí – např. min. marže 0 % a nejvýše 40 % pod MOC. Vhodné pro ležáky bez konkurence.',
  },
];

export const TARGET_MODE_MAP = Object.fromEntries(TARGET_MODES.map((m) => [m.value, m]));

export const FALLBACK_MODES = [
  { value: 'next', label: 'Propadnout na další strategii', help: 'Produkt převezme další použitelná strategie v pořadí (např. „Bez konkurence → MOC“). Když žádná nerozhodne, cena se nemění.' },
  { value: 'keep', label: 'Ponechat cenu', help: 'Cena zůstane; pokud porušuje limity (např. je pod minimální marží nebo nad MOC), upraví se na hranici.' },
  { value: 'msrp', label: 'Nastavit MOC ± posun', help: 'Cena = doporučená cena výrobce upravená o posun v %. Bez MOC produkt propadne na další strategii.' },
  { value: 'cost_plus', label: 'Nákup + přirážka', help: 'Cena bez DPH = nákupní cena × (1 + přirážka). Bez nákupní ceny produkt propadne na další strategii.' },
];

/** Co je „základ ceny“ jednotlivých režimů – když chybí, uplatní se náhradní režim (fallback). */
export const BASE_MISSING_TEXT = {
  undercut_min: 'málo konkurentů (méně než „Min. počet konkurentů“)',
  match_min: 'málo konkurentů (méně než „Min. počet konkurentů“)',
  rank: 'málo konkurentů (méně než „Min. počet konkurentů“)',
  market_avg: 'málo konkurentů (méně než „Min. počet konkurentů“)',
  market_median: 'málo konkurentů (méně než „Min. počet konkurentů“)',
  competitor: 'vybraný konkurent produkt nemá (nebo je vyřazen)',
  msrp: 'produkt nemá MOC',
  cost_plus: 'produkt nemá nákupní cenu',
  keep: 'produkt nemá aktuální cenu',
  clearance: 'produkt nemá aktuální cenu',
};

/** Režimy, u kterých může chybět základ ceny (u „fixed“ nikdy). */
export function usesFallback(mode) {
  return Object.prototype.hasOwnProperty.call(BASE_MISSING_TEXT, mode);
}

export const ZERO_STOCK_MODES = [
  { value: 'reprice', label: 'Přeceňovat normálně' },
  { value: 'skip', label: 'Nepřeceňovat' },
  { value: 'msrp', label: 'Nastavit MOC' },
];

export const ROUNDING_MODES = [
  { value: 'ending', label: 'Cenové konce (…9, …90, …990)' },
  { value: 'integer', label: 'Na celé koruny' },
  { value: 'none', label: 'Nezaokrouhlovat (haléře)' },
];

export const ROUNDING_DIRECTIONS = [
  { value: 'down', label: 'Dolů' },
  { value: 'nearest', label: 'K nejbližší' },
  { value: 'up', label: 'Nahoru' },
];

/** Nápověda k jednotlivým polím (klíč = cesta v konfiguraci). */
export const HELP = {
  'target.offset_pct': 'Posun v % z referenční ceny. Záporné = levněji (−1 = o 1 % pod referencí), kladné = dráž.',
  'target.offset_abs': 'Posun v Kč přičtený po procentním posunu. −10 = o 10 Kč levněji.',
  'target.rank': 'Požadovaná pozice mezi konkurenty; 1 = nejlevnější nabídka na trhu.',
  'target.competitor': 'Konkurent, jehož cenu sledujete.',
  'target.markup_pct': 'Přirážka k nákupní ceně bez DPH v %.',
  'target.fixed_price': 'Cena s DPH v Kč.',
  'competitors.include': 'Počítat jen s těmito konkurenty. Prázdné = všichni zapnutí konkurenti.',
  'competitors.exclude': 'Tito konkurenti se ignorují (např. bazary nebo obchody s nespolehlivými cenami).',
  'competitors.include_tags': 'Počítat jen s konkurenty s některým z těchto štítků (např. „klíčový“). Prázdné = bez omezení.',
  'competitors.exclude_tags': 'Konkurenti s těmito štítky se ignorují (např. „marketplace“).',
  'competitors.in_stock_only': 'Započítat jen nabídky skladem. Nabídky s neznámou dostupností se počítají jako skladem.',
  'competitors.include_shipping': 'K ceně konkurenta přičíst dopravu – srovnání „cena do košíku“.',
  'competitors.max_age_days': 'Ceny starší než zadaný počet dní se ignorují. Prázdné = výchozí hodnota z Nastavení.',
  'competitors.outlier_pct': 'Vyřadí nabídky levnější než medián o víc než zadané % (chyby v datech, bazary). Uplatní se až od 3 nabídek. Prázdné = vypnuto.',
  'competitors.min_competitors': 'Kolik započtených nabídek je potřeba. Při menším počtu se použije náhradní režim.',
  'fallback.mode': 'Co dělat, když chybí základ ceny – málo konkurentů, vybraný konkurent produkt nemá, chybí MOC, nákupní nebo aktuální cena.',
  'fallback.markup_pct': 'Přirážka k nákupní ceně bez DPH pro náhradní režim. Prázdné = přirážka z cíle ceny.',
  'fallback.offset_pct': 'Posun od MOC v % (−5 = o 5 % pod MOC).',
  'limits.min_margin_pct': 'Cena nikdy neklesne pod úroveň s touto marží (z ceny bez DPH). Nákup 1 000 Kč a 10 % → minimálně 1 111 Kč bez DPH (1 344 Kč s DPH).',
  'limits.min_profit_abs': 'Minimální zisk na kus v Kč bez DPH. Prázdné = bez limitu.',
  'limits.max_margin_pct': 'Strop marže – cena nepřekročí úroveň s touto marží. Prázdné = bez limitu.',
  'limits.max_above_msrp_pct': 'Strop vůči MOC: 0 = nikdy nad MOC, 5 = nejvýše o 5 % nad MOC. Prázdné = MOC cenu neomezuje.',
  'limits.max_below_msrp_pct': 'Spodní hranice vůči MOC: 30 = nikdy víc než 30 % pod MOC. Prázdné = bez limitu.',
  'limits.max_decrease_pct': 'Za jedno přecenění snížit cenu nejvýše o tolik %. Chrání před skokovým propadem. Prázdné = bez limitu.',
  'limits.max_increase_pct': 'Za jedno přecenění zvýšit cenu nejvýše o tolik %. Prázdné = bez limitu.',
  'limits.allow_increase': 'Vypnuto = cena se nezvýší (kromě vynucení spodní hranicí).',
  'limits.allow_decrease': 'Vypnuto = cena se nesníží (strop MOC nebo max. marže ji ale snížit mohou).',
  'limits.min_change_pct': 'Menší změny se ignorují, aby ceny zbytečně „necukaly“. Platí větší z obou prahů.',
  'limits.min_change_abs': 'Minimální změna v Kč.',
  'limits.respect_product_limits': 'Dodržet minimální a maximální cenu nastavenou u konkrétního produktu.',
  'rounding.mode': 'Jak zaokrouhlit vypočtenou cenu.',
  'rounding.direction': 'Dolů = nejbližší cenový bod pod cílem. Spodní hranice má vždy přednost – když by ji zaokrouhlení porušilo, zaokrouhlí se nahoru.',
  'rounding.bands': 'Pásma se vyhodnocují shora; první, do kterého cena spadá, určí konec. Konec 90 → …390, …490; konec 990 → 12 990, 13 990. Krok je nepovinný (výchozí 10 pro konec 9, 100 pro 90, 1000 pro 990).',
  'stock.zero_stock': 'Co dělat s produkty s nulovým nebo záporným skladem.',
  'approval.auto': 'Návrhy se rovnou schválí a půjdou do exportu. Nikdy se automaticky neschválí návrhy s příznakem konflikt limitů, pod nákupní cenou, velká změna nebo min. cena nad limit změny.',
  'approval.auto_max_change_pct': 'Automaticky schválit jen změny do ± tolika %. Větší změny dostanou příznak „Velká změna“ a čekají na člověka.',
  // rozšíření enginu
  'target.step_pct': 'O kolik % zlevnit v jednom kroku doprodeje.',
  'target.every_days': 'Jak často zlevnit – další krok až po uplynutí tolika dní od poslední změny ceny.',
  'target.max_sales_30': 'Zlevňovat, jen dokud se za 30 dní neprodá víc kusů (0 = jen zboží bez prodejů).',
  'competitors.exclude_keywords': 'Nabídky, jejichž název obsahuje některé z těchto slov (např. „bazar“, „použité“, „rozbaleno“), se ignorují.',
  'schedule.valid_from': 'Strategie platí od tohoto okamžiku. Prázdné = hned.',
  'schedule.valid_to': 'Strategie platí do tohoto okamžiku (např. konec akce). Prázdné = bez konce.',
  'schedule.weekdays': 'Jen ve vybrané dny. Nic nevybráno = každý den.',
  'schedule.hours': 'Jen v tomto rozmezí hodin (např. 18–24). Prázdné = celý den. Mimo okno produkt převezme další strategie.',
  conditions: 'Podmínky navíc k segmentu – strategie se použije jen na produkty, které je splní (např. sklad > 0, marže ≥ 15 %). Jinak produkt převezme další strategie.',
};

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

/** Hluboké sloučení (pole se nahrazují). */
export function deepMerge(base, over) {
  if (!isPlain(base) || !isPlain(over)) return over === undefined ? clone(base) : clone(over);
  const out = clone(base);
  for (const [k, v] of Object.entries(over)) out[k] = isPlain(v) && isPlain(base[k]) ? deepMerge(base[k], v) : clone(v);
  return out;
}

/**
 * Doplní konfiguraci výchozími hodnotami (stejně jako normalizeConfig enginu – pole se nahrazují).
 * @param {object} cfg
 */
export function mergeConfig(cfg) {
  const out = deepMerge(DEFAULT_CONFIG, isPlain(cfg) ? cfg : {});
  // null v sekci podmínek / okna = „bez omezení“ (engine ho normalizuje stejně)
  if (!isPlain(out.conditions)) out.conditions = {};
  if (!isPlain(out.schedule)) out.schedule = clone(DEFAULT_CONFIG.schedule);
  return out;
}

/** Čtení/zápis hodnoty podle cesty „limits.min_margin_pct“. */
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isPlain(o[keys[i]])) o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
  return obj;
}

// ------------------------------------------------------------------ zaokrouhlení (SPEC §6.6)

function digits(n) {
  return String(Math.trunc(Math.abs(n))).length;
}

/** Krok cenových bodů pásma. */
export function stepFor(band) {
  if (band && band.step != null && Number(band.step) > 0) return Number(band.step);
  const ending = Number(band?.ending ?? 0);
  if (!ending) return 1;
  return 10 ** digits(ending);
}

/** Pásmo pro danou cenu: první s value ≤ up_to (null = ∞), jinak poslední. */
export function bandFor(value, bands) {
  const list = Array.isArray(bands) ? bands : [];
  for (const b of list) if (b.up_to == null || value <= Number(b.up_to)) return b;
  return list[list.length - 1] || { up_to: null, ending: 0 };
}

const EPS = 1e-9;

/** Kandidáti zaokrouhlení {down, up}. */
export function priceCandidates(value, rounding) {
  const mode = rounding?.mode || 'ending';
  if (mode === 'none') {
    const v = Math.round(value * 100) / 100;
    return { down: v, up: v };
  }
  if (mode === 'integer') {
    let down = Math.floor(value + EPS);
    const up = Math.ceil(value - EPS);
    if (down <= 0) down = up;
    return { down, up };
  }
  const band = bandFor(value, rounding?.bands);
  const step = stepFor(band);
  const ending = Number(band.ending || 0);
  const k = Math.floor((value - ending) / step + EPS);
  let down = k * step + ending;
  let up = Math.abs(down - value) < EPS ? down : down + step;
  if (down > value + EPS) {
    up = down;
    down = down - step;
  }
  down = Math.round(down * 100) / 100;
  up = Math.round(up * 100) / 100;
  if (down <= 0) down = up;
  return { down, up };
}

/** Zaokrouhlí cenu podle nastavení (direction přebíjí rounding.direction). */
export function roundPrice(value, rounding, direction) {
  const dir = direction || rounding?.direction || 'down';
  const { down, up } = priceCandidates(value, rounding);
  if (dir === 'up') return up;
  if (dir === 'nearest') return value - down <= up - value ? down : up;
  return down;
}

// ------------------------------------------------------------------ validace

/** Klientská kontrola konfigurace → {errors, warnings} (české texty). */
export function validateConfig(cfg) {
  const c = mergeConfig(cfg);
  const errors = [];
  const warnings = [];
  const t = c.target;
  const num = (v) => v == null || (typeof v === 'number' && Number.isFinite(v));
  if (!TARGET_MODE_MAP[t.mode]) errors.push('Neznámý režim cíle „' + t.mode + '“.');
  if (t.mode === 'rank' && !(Number.isInteger(t.rank) && t.rank >= 1)) errors.push('Pozice v žebříčku musí být celé číslo ≥ 1.');
  if (t.mode === 'competitor' && !t.competitor) errors.push('Vyberte konkurenta, jehož cenu chcete sledovat.');
  if (t.mode === 'cost_plus' && t.markup_pct == null) errors.push('Zadejte přirážku k nákupní ceně.');
  if (t.mode === 'fixed' && !(t.fixed_price > 0)) errors.push('Zadejte pevnou cenu větší než 0.');
  if (c.fallback.mode === 'cost_plus' && c.fallback.markup_pct == null && t.markup_pct == null) {
    errors.push('Zadejte přirážku pro náhradní režim „Nákup + přirážka“.');
  }
  if (!FALLBACK_MODES.some((f) => f.value === c.fallback.mode)) errors.push('Neznámý náhradní režim „' + c.fallback.mode + '“.');
  const pctOk = (v) => v == null || (Number.isFinite(v) && v > -100 && v <= 1000);
  if (!pctOk(t.offset_pct)) errors.push('Posun v % musí být větší než −100 a nejvýše 1 000.');
  if (!pctOk(c.fallback.offset_pct)) errors.push('Posun od MOC v náhradním režimu musí být větší než −100 %.');
  if (t.markup_pct != null && !(t.markup_pct > -100)) errors.push('Přirážka musí být větší než −100 %.');
  const L = c.limits;
  for (const k of ['min_margin_pct', 'min_profit_abs', 'max_margin_pct', 'max_above_msrp_pct', 'max_below_msrp_pct', 'max_decrease_pct', 'max_increase_pct', 'min_change_pct', 'min_change_abs']) {
    if (!num(L[k])) errors.push('Limit „' + k + '“ musí být číslo nebo prázdný.');
  }
  if (L.min_margin_pct != null && !(L.min_margin_pct >= 0 && L.min_margin_pct < 100)) errors.push('Minimální marže musí být 0 až 99,9 %.');
  if (L.max_margin_pct != null && !(L.max_margin_pct >= 0 && L.max_margin_pct < 100)) errors.push('Maximální marže musí být 0 až 99,9 %.');
  if (L.min_margin_pct != null && L.max_margin_pct != null && L.min_margin_pct > L.max_margin_pct) {
    errors.push('Maximální marže nesmí být nižší než minimální.');
  }
  if (L.max_below_msrp_pct != null && !(L.max_below_msrp_pct >= 0 && L.max_below_msrp_pct < 100)) errors.push('Max. pod MOC musí být 0 až 99 %.');
  if (L.max_above_msrp_pct != null && !(L.max_above_msrp_pct > -100)) errors.push('Max. nad MOC musí být větší než −100 %.');
  if (L.min_change_pct != null && !(L.min_change_pct >= 0 && L.min_change_pct <= 100)) errors.push('Práh změny v % musí být 0 až 100.');
  if (L.min_change_abs != null && L.min_change_abs < 0) errors.push('Práh změny v Kč nesmí být záporný.');
  if (L.min_profit_abs != null && L.min_profit_abs < 0) errors.push('Minimální zisk nesmí být záporný.');
  if (L.max_decrease_pct != null && (L.max_decrease_pct < 0 || L.max_decrease_pct > 100)) errors.push('Max. snížení musí být mezi 0 a 100 %.');
  if (L.max_increase_pct != null && L.max_increase_pct < 0) errors.push('Max. zvýšení nesmí být záporné.');
  if (!L.allow_increase && !L.allow_decrease) warnings.push('Zdražování i zlevňování je vypnuté – strategie změní cenu jen při porušení limitů.');
  if (L.min_margin_pct == null && L.min_profit_abs == null) warnings.push('Bez minimální marže i minimálního zisku může cena klesnout až pod nákupní cenu.');
  const comp = c.competitors;
  if (!(Number.isInteger(comp.min_competitors) && comp.min_competitors >= 1)) errors.push('Minimální počet konkurentů musí být celé číslo ≥ 1.');
  if (comp.outlier_pct != null && !(comp.outlier_pct > 0 && comp.outlier_pct < 100)) errors.push('Práh podezřele nízké ceny musí být mezi 0 a 100 %.');
  if (comp.max_age_days != null && !(comp.max_age_days > 0)) errors.push('Stáří cen musí být kladné číslo dní.');
  const r = c.rounding;
  if (r.mode === 'ending') {
    const bands = Array.isArray(r.bands) ? r.bands : [];
    if (!bands.length) errors.push('Zadejte alespoň jedno pásmo zaokrouhlení.');
    let prev = -Infinity;
    bands.forEach((b, i) => {
      const n = i + 1;
      if (!(Number.isFinite(b.ending) && b.ending >= 0)) errors.push('Pásmo ' + n + ': konec musí být nezáporné číslo.');
      else if (b.ending >= stepFor(b)) errors.push('Pásmo ' + n + ': konec (' + b.ending + ') musí být menší než krok (' + stepFor(b) + ').');
      if (b.up_to != null) {
        if (!(b.up_to > prev)) errors.push('Pásmo ' + n + ': horní mez musí být rostoucí.');
        prev = b.up_to;
      } else if (i !== bands.length - 1) errors.push('Pásmo ' + n + ': pásmo bez horní meze musí být poslední.');
    });
    if (bands.length && bands[bands.length - 1].up_to != null) warnings.push('Poslední pásmo má horní mez – dražší ceny použijí poslední pásmo.');
  }
  if (c.approval.auto_max_change_pct != null && c.approval.auto_max_change_pct < 0) errors.push('Limit pro automatické schválení nesmí být záporný.');
  if (c.approval.auto && !(c.approval.auto_max_change_pct > 0)) warnings.push('Automatické schvalování bez limitu změny – zadejte max. změnu v %.');
  // doprodej, časové okno, doplňující podmínky
  if (!isEmptyFilter(c.conditions)) {
    for (const e of validateFilter(c.conditions, 'podmínky').errors) errors.push('Doplňující ' + e + '.');
  }
  if (t.mode === 'clearance') {
    if (!(t.step_pct > 0 && t.step_pct < 100)) errors.push('Krok doprodeje musí být mezi 0 a 100 %.');
    if (!(t.every_days >= 0)) errors.push('Interval doprodeje musí být nezáporný počet dní.');
    if (!(t.max_sales_30 >= 0)) errors.push('Limit prodejů musí být nezáporné číslo.');
  }
  const sch = c.schedule;
  if (sch && typeof sch === 'object') {
    const from = sch.valid_from ? Date.parse(sch.valid_from) : null;
    const to = sch.valid_to ? Date.parse(sch.valid_to) : null;
    if (sch.valid_from && Number.isNaN(from)) errors.push('Neplatné datum „platí od“.');
    if (sch.valid_to && Number.isNaN(to)) errors.push('Neplatné datum „platí do“.');
    if (from != null && to != null && from >= to) errors.push('„Platí od“ musí být dříve než „platí do“.');
    if (to != null && to < Date.now()) warnings.push('Platnost strategie už skončila – na nic se neuplatní.');
    if (sch.hours != null) {
      const hh = sch.hours;
      if (!(Array.isArray(hh) && hh.length === 2 && hh.every((x) => Number.isFinite(x) && x >= 0 && x <= 24) && hh[0] !== hh[1] && hh[0] < 24)) errors.push('Hodiny platnosti musí být od–do v rozsahu 0–24 a od ≠ do.');
    }
  }
  return { errors, warnings };
}

// ------------------------------------------------------------------ popis strategie

const REF_INSTR = {
  undercut_min: 'nejnižší cenou konkurence',
  match_min: 'nejnižší cenou konkurence',
  market_avg: 'průměrem trhu',
  market_median: 'mediánem trhu',
  msrp: 'doporučenou cenou (MOC)',
};
const REF_GEN = {
  undercut_min: 'nejnižší ceny konkurence',
  match_min: 'nejnižší ceny konkurence',
  market_avg: 'průměru trhu',
  market_median: 'mediánu trhu',
  msrp: 'doporučené ceny (MOC)',
};

function refInstr(t) {
  if (t.mode === 'rank') return 'cenou konkurenta na ' + (t.rank || 1) + '. místě';
  if (t.mode === 'competitor') return 'cenou konkurenta ' + (t.competitor || '(nevybrán)');
  return REF_INSTR[t.mode] || 'referenční cenou';
}
function refGen(t) {
  if (t.mode === 'rank') return 'ceny konkurenta na ' + (t.rank || 1) + '. místě';
  if (t.mode === 'competitor') return 'ceny konkurenta ' + (t.competitor || '(nevybrán)');
  return REF_GEN[t.mode] || 'referenční ceny';
}

function pctTxt(v) {
  return number(Math.abs(v), 2).replace(/,00$/, '').replace(/(,\d)0$/, '$1') + NBSP + '%';
}
function kcTxt(v) {
  return money(Math.abs(v));
}

/** „o 1 % pod nejnižší cenou konkurence“ / „na úrovni mediánu trhu“ / „posun +2 % −10 Kč od …“ */
export function offsetPhrase(t) {
  const p = Number(t.offset_pct) || 0;
  const a = Number(t.offset_abs) || 0;
  if (!p && !a) return 'na úrovni ' + refGen(t);
  const parts = [];
  if (p) parts.push(pctTxt(p));
  if (a) parts.push(kcTxt(a));
  const allNeg = (p <= 0 && a <= 0);
  const allPos = (p >= 0 && a >= 0);
  if (allNeg) return 'o ' + parts.join(' a ') + ' pod ' + refInstr(t);
  if (allPos) return 'o ' + parts.join(' a ') + ' nad ' + refInstr(t);
  const signed = [];
  if (p) signed.push((p > 0 ? '+' : '−') + pctTxt(p));
  if (a) signed.push((a > 0 ? '+' : '−') + kcTxt(a));
  return 'posun ' + signed.join(' ') + ' od ' + refGen(t);
}

/** Krátký popis cíle do seznamů: „Nejnižší cena −1 %“. */
export function describeTargetShort(cfg) {
  const t = mergeConfig(cfg).target;
  const off = () => {
    const out = [];
    if (Number(t.offset_pct)) out.push((t.offset_pct > 0 ? '+' : '−') + pctTxt(t.offset_pct));
    if (Number(t.offset_abs)) out.push((t.offset_abs > 0 ? '+' : '−') + kcTxt(t.offset_abs));
    return out.length ? ' ' + out.join(' ') : '';
  };
  switch (t.mode) {
    case 'undercut_min': return 'Nejnižší cena' + off();
    case 'match_min': return 'Dorovnat nejnižší cenu';
    case 'rank': return 'Pozice ' + (t.rank || 1) + off();
    case 'market_avg': return 'Průměr trhu' + off();
    case 'market_median': return 'Medián trhu' + off();
    case 'competitor': return (t.competitor || 'Konkurent') + off();
    case 'msrp': return 'MOC' + off();
    case 'cost_plus': return 'Nákup +' + (t.markup_pct != null ? pctTxt(t.markup_pct) : '?');
    case 'keep': return 'Ponechat cenu';
    case 'fixed': return 'Pevně ' + (t.fixed_price != null ? money(t.fixed_price) : '?');
    case 'clearance': return 'Doprodej −' + (t.step_pct != null ? pctTxt(t.step_pct) : '?') + ' / ' + (t.every_days ?? '?') + NBSP + 'd';
    default: return String(t.mode);
  }
}

function targetSentence(t) {
  switch (t.mode) {
    case 'undercut_min': {
      const p = Number(t.offset_pct) || 0;
      const a = Number(t.offset_abs) || 0;
      if (!p && !a) return 'nastaví cenu na úroveň nejnižší ceny konkurence';
      return 'nastaví cenu ' + offsetPhrase(t);
    }
    case 'match_min': return 'dorovná nejnižší cenu konkurence';
    case 'rank': {
      const p = Number(t.offset_pct) || 0;
      const a = Number(t.offset_abs) || 0;
      const where = (t.rank || 1) === 1 ? 'nejlevnějšího konkurenta' : 'konkurenta na ' + t.rank + '. místě';
      if (!p && !a) return 'srovná cenu s cenou ' + where;
      return 'drží cenu ' + offsetPhrase(t);
    }
    case 'market_avg':
    case 'market_median':
    case 'competitor':
    case 'msrp':
      return 'nastaví cenu ' + offsetPhrase(t);
    case 'cost_plus': return 'nastaví cenu = nákup + ' + (t.markup_pct != null ? pctTxt(t.markup_pct) : '? %') + ' (bez DPH)';
    case 'keep': return 'ponechá současnou cenu a jen hlídá limity';
    case 'fixed': return 'nastaví pevnou cenu ' + (t.fixed_price != null ? money(t.fixed_price) : '(nezadáno)');
    case 'clearance': return 'každých ' + (t.every_days ?? '?') + NBSP + 'dní zlevní o ' + (t.step_pct != null ? pctTxt(t.step_pct) : '? %') + ', dokud se za 30 dní neprodá víc než ' + (t.max_sales_30 ?? 0) + NBSP + 'ks';
    default: return 'nastaví cenu (režim ' + t.mode + ')';
  }
}

function listCz(arr) {
  const a = arr.map((x) => '„' + x + '“');
  if (a.length <= 1) return a.join('');
  return a.slice(0, -1).join(', ') + ' a ' + a[a.length - 1];
}

function marketSentence(c) {
  const parts = [];
  parts.push(c.in_stock_only ? 'jen nabídky skladem' : 'všechny nabídky včetně nedostupných');
  parts.push(c.include_shipping ? 'včetně dopravy' : 'bez dopravy');
  if (c.max_age_days != null) parts.push('ne starší než ' + c.max_age_days + NBSP + 'dní');
  if (c.outlier_pct != null) parts.push('bez nabídek o víc než ' + pctTxt(c.outlier_pct) + ' pod mediánem');
  const n = c.min_competitors || 1;
  parts.push(n === 1 ? 'stačí 1 konkurent' : 'alespoň ' + n + ' konkurenti');
  let s = 'Počítá ' + parts.join(', ');
  if (c.include?.length) s += '; jen konkurenti ' + listCz(c.include);
  if (c.exclude?.length) s += '; ignoruje ' + listCz(c.exclude);
  if (c.include_tags?.length) s += '; jen se štítkem ' + listCz(c.include_tags);
  if (c.exclude_tags?.length) s += '; bez štítku ' + listCz(c.exclude_tags);
  if (c.exclude_keywords?.length) s += '; ignoruje nabídky se slovy ' + listCz(c.exclude_keywords);
  return s + '.';
}

const BASE_MISSING_SHORT = {
  undercut_min: 'málo konkurentů', match_min: 'málo konkurentů', rank: 'málo konkurentů', market_avg: 'málo konkurentů', market_median: 'málo konkurentů',
  competitor: 'konkurent produkt nemá', msrp: 'chybí MOC', cost_plus: 'chybí nákupní cena', keep: 'chybí aktuální cena', clearance: 'chybí aktuální cena',
};

function fallbackSentence(f, mode) {
  const when = 'Když chybí základ ceny (' + (BASE_MISSING_SHORT[mode] || 'trh') + '), ';
  if (f.mode === 'msrp') {
    const p = Number(f.offset_pct) || 0;
    return when + 'nastaví MOC' + (p ? ' ' + (p > 0 ? '+' : '−') + pctTxt(p) : '') + '.';
  }
  if (f.mode === 'cost_plus') return when + 'nastaví nákup + ' + (f.markup_pct != null ? pctTxt(f.markup_pct) : 'přirážku z cíle') + '.';
  if (f.mode === 'keep') return when + 'cenu ponechá (jen ji srovná do limitů).';
  return when + 'produkt propadne na další strategii v pořadí.';
}

function limitsSentence(L) {
  const guards = [];
  if (L.min_margin_pct != null) guards.push('minimální marži ' + pctTxt(L.min_margin_pct));
  if (L.min_profit_abs != null) guards.push('minimální zisk ' + money(L.min_profit_abs) + ' na kus');
  if (L.max_margin_pct != null) guards.push('maximální marži ' + pctTxt(L.max_margin_pct));
  if (L.max_above_msrp_pct != null) guards.push(Number(L.max_above_msrp_pct) === 0 ? 'strop MOC' : 'strop MOC +' + pctTxt(L.max_above_msrp_pct));
  if (L.max_below_msrp_pct != null) guards.push('nejvýše ' + pctTxt(L.max_below_msrp_pct) + ' pod MOC');
  if (L.respect_product_limits) guards.push('min./max. cenu produktu');
  const out = [];
  out.push(guards.length ? 'Hlídá ' + guards.join(', ') + '.' : 'Nehlídá žádnou marži ani MOC – pozor na podnákladové ceny.');
  const ch = [];
  if (!L.allow_decrease) ch.push('nezlevňuje');
  else if (L.max_decrease_pct != null) ch.push('sníží nejvýše o ' + pctTxt(L.max_decrease_pct));
  if (!L.allow_increase) ch.push('nezdražuje');
  else if (L.max_increase_pct != null) ch.push('zvýší nejvýše o ' + pctTxt(L.max_increase_pct));
  if (ch.length) out.push('Za jedno přecenění ' + ch.join(' a ') + '.');
  const thr = [];
  if (Number(L.min_change_pct)) thr.push(pctTxt(L.min_change_pct));
  if (Number(L.min_change_abs)) thr.push(money(L.min_change_abs));
  if (thr.length) out.push('Změny menší než ' + thr.join(' nebo ') + ' ignoruje.');
  return out.join(' ');
}

function endingTxt(e) {
  return '…' + String(e);
}

function roundingSentence(r) {
  if (r.mode === 'none') return 'Cenu nezaokrouhluje.';
  const dir = r.direction === 'up' ? 'nahoru' : r.direction === 'nearest' ? 'k nejbližšímu bodu' : 'dolů';
  if (r.mode === 'integer') return 'Zaokrouhlí ' + dir + ' na celé koruny.';
  const bands = Array.isArray(r.bands) ? r.bands : [];
  if (!bands.length) return 'Zaokrouhlí ' + dir + '.';
  const parts = bands.map((b, i) => {
    if (b.up_to == null) return endingTxt(b.ending) + (i ? ' nad ' + money(bands[i - 1].up_to) : '');
    return endingTxt(b.ending) + ' do ' + money(b.up_to);
  });
  return 'Zaokrouhlí ' + dir + ' na konce ' + parts.join(', ') + '.';
}

function stockSentence(s) {
  if (s.zero_stock === 'skip') return 'Produkty bez skladu nepřeceňuje.';
  if (s.zero_stock === 'msrp') return 'Produktům bez skladu nastaví MOC.';
  return '';
}

function scheduleSentence(sch) {
  if (!sch || typeof sch !== 'object') return '';
  const parts = [];
  if (Array.isArray(sch.weekdays) && sch.weekdays.length && sch.weekdays.length < 7) {
    const names = WEEKDAYS.filter((d) => sch.weekdays.includes(d.value)).map((d) => d.short.toLowerCase());
    parts.push('jen ' + names.join(', '));
  }
  if (Array.isArray(sch.hours) && sch.hours.length === 2) parts.push('od ' + sch.hours[0] + ' do ' + sch.hours[1] + NBSP + 'h');
  const d = (v) => {
    const t = Date.parse(v);
    return Number.isNaN(t) ? String(v) : new Date(t).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  if (sch.valid_from) parts.push('od ' + d(sch.valid_from));
  if (sch.valid_to) parts.push('do ' + d(sch.valid_to));
  return parts.length ? 'Platí ' + parts.join(', ') + '; mimo toto okno produkt převezme další strategie.' : '';
}

function conditionsSentence(cond, fieldsMap) {
  if (!cond || typeof cond !== 'object' || isEmptyFilter(cond)) return '';
  return 'Navíc jen pro produkty, kde ' + describeFilter(cond, fieldsMap) + '.';
}

function approvalSentence(a) {
  if (a.auto) {
    return a.auto_max_change_pct != null
      ? 'Změny do ±' + pctTxt(a.auto_max_change_pct) + ' schválí automaticky, větší čekají na schválení.'
      : 'Návrhy schválí automaticky (kromě rizikových).';
  }
  return 'Všechny návrhy čekají na ruční schválení.';
}

/**
 * Lidsky čitelné shrnutí strategie v češtině.
 * @param {object} cfg konfigurace (doplní se výchozí)
 * @param {{segmentName?: string|null, fieldsMap?: Map}} [ctx] fieldsMap = popisky polí pro doplňující podmínky
 */
export function describeStrategy(cfg, ctx = {}) {
  const c = mergeConfig(cfg);
  const scope = ctx.segmentName ? 'Pro segment „' + ctx.segmentName + '“' : 'Pro všechny produkty';
  const mode = TARGET_MODE_MAP[c.target.mode];
  const sentences = [scope + ' ' + targetSentence(c.target) + '.'];
  const cond = conditionsSentence(c.conditions, ctx.fieldsMap);
  if (cond) sentences.push(cond);
  const sch = scheduleSentence(c.schedule);
  if (sch) sentences.push(sch);
  if (mode?.market) sentences.push(marketSentence(c.competitors));
  if (usesFallback(c.target.mode)) sentences.push(fallbackSentence(c.fallback, c.target.mode));
  sentences.push(limitsSentence(c.limits));
  sentences.push(roundingSentence(c.rounding));
  const st = stockSentence(c.stock);
  if (st) sentences.push(st);
  sentences.push(approvalSentence(c.approval));
  return sentences.join(' ');
}

/** Krátké shrnutí limitů pro seznam strategií. */
export function describeLimitsShort(cfg) {
  const L = mergeConfig(cfg).limits;
  const out = [];
  if (L.min_margin_pct != null) out.push('marže ≥ ' + pctTxt(L.min_margin_pct));
  if (L.max_above_msrp_pct != null) out.push(Number(L.max_above_msrp_pct) ? 'MOC +' + pctTxt(L.max_above_msrp_pct) : '≤ MOC');
  if (L.max_decrease_pct != null && L.allow_decrease) out.push('−' + pctTxt(L.max_decrease_pct));
  if (L.max_increase_pct != null && L.allow_increase) out.push('+' + pctTxt(L.max_increase_pct));
  return out.join(' · ');
}

// ------------------------------------------------------------------ krátké popisy do seznamu strategií

/** Krátké názvy běžných polí pro souhrny („pozice = nejlevnější a rozdíl ≤ −5 %“). */
const SHORT_FIELDS = {
  position: ['pozice', null], gap_min_pct: ['rozdíl', '%'], gap_min_abs: ['rozdíl', 'Kč'], margin_pct: ['marže', '%'],
  markup_pct: ['přirážka', '%'], price: ['cena', 'Kč'], purchase_price: ['nákup', 'Kč'], msrp: ['MOC', 'Kč'], stock: ['sklad', 'ks'],
  sales_30: ['prodej 30 d', 'ks'], sales_90: ['prodej 90 d', 'ks'], market_count: ['konkurentů', null], rank: ['pořadí', null],
  price_index: ['index', null], price_index_median: ['index k mediánu', null], msrp_diff_pct: ['rozdíl od MOC', '%'],
  days_since_change: ['dní od změny', null], days_of_cover: ['zásoba na dní', null], manufacturer: ['výrobce', null],
  category: ['kategorie', null], supplier: ['dodavatel', null], owner: ['odpovídá', null], has_stock: ['skladem', null],
  below_cost: ['pod nákupem', null], min_below_cost: ['konkurence pod naším nákupem', null], lock_active: ['zamčeno', null],
};
const SHORT_OPS = { '=': '=', '!=': '≠', '>': '>', '>=': '≥', '<': '<', '<=': '≤', in: '∈', not_in: '∉', contains: 'obsahuje', not_contains: 'neobsahuje', starts_with: 'začíná', empty: 'je prázdné', not_empty: 'je vyplněné' };
const POSITION_SHORT = { cheapest: 'nejlevnější', middle: 'uprostřed', most_expensive: 'nejdražší', no_data: 'bez dat' };

function shortField(key, fieldsMap) {
  if (SHORT_FIELDS[key]) return { label: SHORT_FIELDS[key][0], unit: SHORT_FIELDS[key][1] };
  const f = fieldsMap && (fieldsMap instanceof Map ? fieldsMap.get(key) : fieldsMap[key]);
  let label = f?.label || (String(key).startsWith('attrs.') ? String(key).slice(6) : String(key));
  if (f?.unit) label = label.replace(/\s*\((%|Kč|ks|dní)\)$/, '');
  if (!String(key).startsWith('attrs.')) label = label.charAt(0).toLowerCase() + label.slice(1);
  return { label, unit: f?.unit === 'Kč' || f?.unit === '%' || f?.unit === 'ks' ? f.unit : null };
}

function shortValue(field, unit, v) {
  if (field === 'position' && POSITION_SHORT[v]) return POSITION_SHORT[v];
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+([.,]\d+)?$/.test(v.trim()) ? Number(v.replace(',', '.')) : null;
  if (n != null && Number.isFinite(n)) {
    // bez jednotky (rok, pořadí, index) čtyřmístná čísla neseskupovat: „2026“, ne „2 026“
    if (!unit && Number.isInteger(n) && Math.abs(n) < 10000) return (n < 0 ? '−' : '') + Math.abs(n);
    return number(n, 2).replace(/,00$/, '').replace(/(,\d)0$/, '$1') + (unit ? NBSP + unit : '');
  }
  return String(v);
}

/**
 * Krátký popis doplňujících podmínek do seznamu: „pozice = nejlevnější a rozdíl ≤ −5 %“ ('' = bez podmínek).
 * @param {object} cond filtr (SPEC §6.4)
 * @param {Map|object} [fieldsMap] pole z /fields (popisky neznámých polí)
 */
export function describeConditionsShort(cond, fieldsMap) {
  if (!cond || typeof cond !== 'object' || isEmptyFilter(cond)) return '';
  const d = (x, top) => {
    if (x == null || typeof x !== 'object') return '';
    if (typeof x.field === 'string') {
      const { label, unit } = shortField(x.field, fieldsMap);
      if (x.op === 'is_true') return label;
      if (x.op === 'is_false') return 'ne ' + label;
      if (x.op === 'empty' || x.op === 'not_empty') return label + ' ' + SHORT_OPS[x.op];
      if (x.op === 'between' && Array.isArray(x.value)) return label + ' ' + shortValue(x.field, unit, x.value[0]) + '–' + shortValue(x.field, unit, x.value[1]);
      if (x.op === 'in' || x.op === 'not_in') {
        const vals = (Array.isArray(x.value) ? x.value : String(x.value ?? '').split(/[,;]/)).map((v) => shortValue(x.field, unit, typeof v === 'string' ? v.trim() : v));
        return label + (x.op === 'in' ? ' = ' : ' ≠ ') + vals.join(' / ');
      }
      return label + ' ' + (SHORT_OPS[x.op] || x.op) + ' ' + shortValue(x.field, unit, x.value);
    }
    const mode = Array.isArray(x.any) ? 'any' : Array.isArray(x.all) ? 'all' : null;
    if (mode) {
      const parts = x[mode].map((y) => d(y, false)).filter(Boolean);
      if (!parts.length) return mode === 'any' ? 'nic' : '';
      const s = parts.join(mode === 'any' ? ' nebo ' : ' a ');
      return top || parts.length === 1 ? s : '(' + s + ')';
    }
    if ('not' in x) {
      const inner = d(x.not, false);
      return inner ? 'ne (' + inner + ')' : '';
    }
    return '';
  };
  return d(cond, true);
}

function dayRanges(days) {
  const names = ['', 'po', 'út', 'st', 'čt', 'pá', 'so', 'ne'];
  const list = [...new Set(days.map(Number).filter((d) => d >= 1 && d <= 7))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    if (j - i >= 1) out.push(names[list[i]] + '–' + names[list[j]]);
    else out.push(names[list[i]]);
    i = j;
  }
  return out.join(', ');
}

function shortDateTime(v) {
  const t = Date.parse(v);
  if (Number.isNaN(t)) return String(v);
  const d = new Date(t);
  const date = d.getDate() + '.' + NBSP + (d.getMonth() + 1) + '.' + NBSP + d.getFullYear();
  return d.getHours() || d.getMinutes() ? date + ' ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0') : date;
}

/** Krátký popis časového okna: „so–ne, 18–24 h, do 31. 10. 2026“ ('' = platí stále). */
export function describeScheduleShort(sch) {
  if (!sch || typeof sch !== 'object') return '';
  const parts = [];
  if (Array.isArray(sch.weekdays) && sch.weekdays.length && sch.weekdays.length < 7) parts.push(dayRanges(sch.weekdays));
  if (Array.isArray(sch.hours) && sch.hours.length === 2) parts.push(sch.hours[0] + '–' + sch.hours[1] + NBSP + 'h');
  if (sch.valid_from) parts.push('od ' + shortDateTime(sch.valid_from));
  if (sch.valid_to) parts.push('do ' + shortDateTime(sch.valid_to));
  return parts.join(', ');
}

/** Stav časového okna vůči `now`: 'none' (bez okna) | 'future' | 'expired' | 'window' (jen některé dny/hodiny) | 'active'. */
export function scheduleState(sch, now = Date.now()) {
  if (!sch || typeof sch !== 'object') return 'none';
  const from = sch.valid_from ? Date.parse(sch.valid_from) : null;
  const to = sch.valid_to ? Date.parse(sch.valid_to) : null;
  const hasWindow = (Array.isArray(sch.weekdays) && sch.weekdays.length > 0 && sch.weekdays.length < 7) || (Array.isArray(sch.hours) && sch.hours.length === 2);
  if (from == null && to == null && !hasWindow) return 'none';
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (from != null && !Number.isNaN(from) && t < from) return 'future';
  if (to != null && !Number.isNaN(to) && t >= to) return 'expired';
  return hasWindow ? 'window' : 'active';
}

/** Ukázky zaokrouhlení pro náhled ve formuláři. */
export function roundingExamples(rounding, values = [449.5, 1234, 8765, 12345, 45678]) {
  return values.map((v) => ({ value: v, result: roundPrice(v, rounding) }));
}

