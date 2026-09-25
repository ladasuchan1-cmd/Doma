// Formátování čísel, peněz, procent, dat a českých popisků.
// Čistý ES modul bez DOM – lze importovat i v Node testech.

export const NBSP = ' ';
export const DASH = '–';
export const MINUS = '−';

const nfCache = new Map();
function nf(minDec, maxDec) {
  const key = minDec + ':' + maxDec;
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: minDec, maximumFractionDigits: maxDec, useGrouping: true });
    nfCache.set(key, f);
  }
  return f;
}

/** Převede vstup na konečné číslo, jinak null. Přijímá i číselné řetězce („12.5“). */
export function toNum(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Zaokrouhlení bez chyb typu 1.005 → 1. */
export function round(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return n;
  const f = 10 ** d;
  return Math.round((n + Number.EPSILON * Math.sign(n)) * f) / f;
}

// Intl dává „-“ (spojovník); typograficky správně je mínus a skupiny oddělené pevnou mezerou.
function fixSigns(s) {
  return s.replace(/^-/, MINUS).replace(/[  ]/g, NBSP);
}

/** Číslo v české notaci („12 990“, „12,5“). */
export function number(v, decimals = 0, minDecimals = decimals) {
  const n = toNum(v);
  if (n == null) return DASH;
  const r = round(n, decimals);
  return fixSigns(nf(minDecimals, decimals).format(Object.is(r, -0) ? 0 : r));
}

/** Celé číslo s oddělením tisíců. */
export function int(v) {
  return number(v, 0);
}

/**
 * Peníze: „12 990 Kč“. Desetinná místa: výchozí 0 u celých částek, jinak 2.
 * @param {*} v
 * @param {{decimals?: number, currency?: string}} [opts]
 */
export function money(v, opts = {}) {
  const n = toNum(v);
  if (n == null) return DASH;
  const cur = opts.currency ?? 'Kč';
  const d = opts.decimals ?? (Number.isInteger(round(n, 2)) ? 0 : 2);
  return number(n, d) + (cur ? NBSP + cur : '');
}

/** Procenta: „12,5 %“. */
export function percent(v, decimals = 1) {
  const n = toNum(v);
  if (n == null) return DASH;
  return number(n, decimals) + NBSP + '%';
}

/** Znaménko pro změnu – plus, typografické mínus, nula bez znaménka. */
function signOf(n, decimals) {
  const r = round(n, decimals);
  if (r > 0) return '+';
  if (r < 0) return MINUS;
  return '';
}

/** „+3,2 %“, „−3,2 %“, „0,0 %“. */
export function signedPercent(v, decimals = 1) {
  const n = toNum(v);
  if (n == null) return DASH;
  return signOf(n, decimals) + number(Math.abs(n), decimals) + NBSP + '%';
}

/** „+120 Kč“, „−1 500 Kč“. */
export function signedMoney(v, opts = {}) {
  const n = toNum(v);
  if (n == null) return DASH;
  const d = opts.decimals ?? (Number.isInteger(round(n, 2)) ? 0 : 2);
  return signOf(n, d) + money(Math.abs(n), { ...opts, decimals: d });
}

/**
 * Informace o změně pro vykreslení: text se šipkou a CSS třída barvy.
 * @param {*} v hodnota změny (procenta nebo Kč)
 * @param {{kind?: 'pct'|'abs', decimals?: number}} [opts]
 * @returns {{text: string, arrow: string, cls: string, dir: 'up'|'down'|'zero'|'none'}}
 */
export function changeInfo(v, opts = {}) {
  const kind = opts.kind || 'pct';
  const n = toNum(v);
  if (n == null) return { text: DASH, arrow: '', cls: 'chg-none', dir: 'none' };
  const decimals = opts.decimals ?? (kind === 'pct' ? 1 : 0);
  const r = round(n, decimals);
  const dir = r > 0 ? 'up' : r < 0 ? 'down' : 'zero';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '•';
  const body = kind === 'pct' ? signedPercent(n, decimals) : signedMoney(n, { decimals });
  return { text: arrow + NBSP + body, arrow, cls: 'chg-' + dir, dir };
}

/** Cenový index (naše cena / trh × 100) s jedním desetinným místem. */
export function index(v) {
  return number(v, 1, 1);
}

/** Velikost souboru. */
export function bytes(n) {
  const v = toNum(n);
  if (v == null) return DASH;
  if (v < 1024) return int(v) + NBSP + 'B';
  if (v < 1024 * 1024) return number(v / 1024, 1) + NBSP + 'kB';
  if (v < 1024 ** 3) return number(v / 1024 / 1024, 1) + NBSP + 'MB';
  return number(v / 1024 ** 3, 2) + NBSP + 'GB';
}

/** Trvání v ms → „350 ms“, „1,2 s“, „2 min 5 s“. */
export function duration(ms) {
  const v = toNum(ms);
  if (v == null) return DASH;
  if (v < 1000) return int(v) + NBSP + 'ms';
  if (v < 60000) return number(v / 1000, 1) + NBSP + 's';
  const m = Math.floor(v / 60000);
  const s = Math.round((v % 60000) / 1000);
  return m + NBSP + 'min' + (s ? ' ' + s + NBSP + 's' : '');
}

/** České skloňování podle počtu: plural(5, 'produkt', 'produkty', 'produktů'). */
export function plural(n, one, few, many) {
  const a = Math.abs(toNum(n) ?? 0);
  if (!Number.isInteger(a)) return few;
  if (a === 1) return one;
  if (a >= 2 && a <= 4) return few;
  return many;
}

/** „5 produktů“, „1 produkt“, „2 produkty“. */
export function count(n, one, few, many) {
  return int(n) + NBSP + plural(n, one, few, many);
}

// ------------------------------------------------------------------ data a čas

function toDate(v) {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const dateFmt = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('cs-CZ', {
  day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const shortDateFmt = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric' });

/** „25. 9. 2026“ */
export function date(v) {
  const d = toDate(v);
  return d ? dateFmt.format(d).replace(/ /g, NBSP) : DASH;
}

/** „25. 9. 2026 14:03“ */
export function dateTime(v) {
  const d = toDate(v);
  return d ? dateTimeFmt.format(d).replace(/ /g, NBSP) : DASH;
}

/** „25. 9.“ – popisky os grafů. */
export function shortDate(v) {
  const d = toDate(v);
  return d ? shortDateFmt.format(d).replace(/ /g, NBSP) : DASH;
}

/**
 * Relativní čas: „právě teď“, „před 5 min“, „před 3 h“, „včera“, „před 4 dny“, „za 2 h“.
 * @param {*} v ISO řetězec / Date
 * @param {number|Date} [now]
 */
export function relTime(v, now = Date.now()) {
  const d = toDate(v);
  if (!d) return DASH;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const diff = nowMs - d.getTime();
  const future = diff < 0;
  const s = Math.abs(diff) / 1000;
  const wrap = (txt) => (future ? 'za ' : 'před ') + txt;
  if (s < 45) return future ? 'za okamžik' : 'právě teď';
  const min = Math.round(s / 60);
  if (min < 60) return wrap(min + NBSP + 'min');
  const hours = Math.round(s / 3600);
  if (hours < 24) return wrap(hours + NBSP + 'h');
  const days = Math.round(s / 86400);
  if (days === 1 && !future) return 'včera';
  if (days < 31) {
    if (future) return 'za ' + days + NBSP + plural(days, 'den', 'dny', 'dní');
    return 'před ' + days + NBSP + (days === 1 ? 'dnem' : 'dny');
  }
  const months = Math.round(days / 30.4);
  if (months < 12) {
    if (future) return 'za ' + months + NBSP + plural(months, 'měsíc', 'měsíce', 'měsíců');
    return 'před ' + months + NBSP + (months === 1 ? 'měsícem' : 'měsíci');
  }
  const years = Math.round(days / 365);
  if (future) return 'za ' + years + NBSP + plural(years, 'rok', 'roky', 'let');
  return years === 1 ? 'před rokem' : 'před ' + years + NBSP + 'lety';
}

/** Stáří záznamu krátce: „12 min“, „3 h“, „2 d“. */
export function age(v, now = Date.now()) {
  const d = toDate(v);
  if (!d) return DASH;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const s = Math.max(0, (nowMs - d.getTime()) / 1000);
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + NBSP + 'min';
  if (s < 86400) return Math.round(s / 3600) + NBSP + 'h';
  return Math.round(s / 86400) + NBSP + 'd';
}

/** Stáří ve dnech (desetinné), null když datum chybí. */
export function ageDays(v, now = Date.now()) {
  const d = toDate(v);
  if (!d) return null;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  return (nowMs - d.getTime()) / 86400000;
}

// ------------------------------------------------------------------ popisky

export const POSITION_LABELS = {
  cheapest: 'Nejlevnější',
  middle: 'Uprostřed',
  most_expensive: 'Nejdražší',
  no_data: 'Bez dat',
};

export const POSITION_ORDER = ['cheapest', 'middle', 'most_expensive', 'no_data'];

export function positionLabel(p) {
  return POSITION_LABELS[p] || (p ? String(p) : DASH);
}

/** Příznaky rozhodnutí (SPEC §6.7). */
export const FLAG_LABELS = {
  fallback: 'Náhradní režim',
  change_limited: 'Omezeno limitem změny',
  ceiling: 'Horní hranice',
  floor: 'Spodní hranice',
  limits_conflict: 'Konflikt limitů',
  floor_over_change_limit: 'Min. cena nad limit změny',
  no_cost: 'Chybí nákupní cena',
  below_cost: 'Pod nákupní cenou',
  big_change: 'Velká změna',
};

export const FLAG_HELP = {
  fallback: 'Trh nestačil (málo konkurentů nebo chybí zvolený konkurent) – použil se náhradní režim strategie.',
  change_limited: 'Cílová cena byla dál, než dovoluje maximální změna za jedno přecenění.',
  ceiling: 'Cena byla snížena na horní hranici (strop MOC, max. marže nebo max. cena produktu).',
  floor: 'Cena byla zvednuta na spodní hranici (min. marže, min. zisk, MOC nebo min. cena produktu).',
  limits_conflict: 'Spodní hranice je vyšší než horní – platí spodní hranice. Zkontrolujte limity.',
  floor_over_change_limit: 'Spodní hranice vynutila větší změnu, než dovoluje limit změny.',
  no_cost: 'Produkt nemá nákupní cenu – maržové limity nelze uplatnit.',
  below_cost: 'Nová cena bez DPH je nižší než nákupní cena.',
  big_change: 'Změna je větší než limit pro automatické schválení.',
};

export const FLAG_SEVERITY = {
  fallback: 'warning',
  change_limited: 'info',
  ceiling: 'info',
  floor: 'info',
  limits_conflict: 'danger',
  floor_over_change_limit: 'warning',
  no_cost: 'warning',
  below_cost: 'danger',
  big_change: 'warning',
};

export function flagLabel(f) {
  return FLAG_LABELS[f] || String(f);
}

/** Důvody přeskočení / nezměnění ceny. */
export const REASON_LABELS = {
  locked: 'Zamčený produkt',
  zero_stock: 'Nulový sklad',
  no_msrp: 'Chybí MOC',
  no_cost: 'Chybí nákupní cena',
  no_market: 'Bez konkurence',
  no_price: 'Chybí aktuální cena',
  below_threshold: 'Změna pod prahem',
  no_strategy: 'Bez strategie',
  same_price: 'Cena beze změny',
};

export function reasonLabel(r) {
  return REASON_LABELS[r] || (r ? String(r) : DASH);
}

/** Proč nabídka nebyla započtena do trhu (SPEC §6.2). */
export const EXCLUDED_LABELS = {
  disabled: 'Konkurent vypnut',
  excluded: 'Vyloučen strategií',
  not_included: 'Není mezi vybranými',
  tag: 'Vyloučen štítkem',
  out_of_stock: 'Není skladem',
  stale: 'Zastaralá cena',
  outlier: 'Podezřele nízká cena',
};

export function excludedLabel(r) {
  return EXCLUDED_LABELS[r] || (r ? String(r) : '');
}

export const ACTION_LABELS = {
  change: 'Změna ceny',
  no_change: 'Beze změny',
  skip: 'Přeskočeno',
};

export const STATUS_LABELS = {
  pending: 'Čeká',
  approved: 'Schváleno',
  rejected: 'Zamítnuto',
  exported: 'Exportováno',
  superseded: 'Nahrazeno',
};

export const STATUS_VARIANT = {
  pending: 'warning',
  approved: 'success',
  rejected: 'neutral',
  exported: 'info',
  superseded: 'neutral',
};

export function statusLabel(s) {
  return STATUS_LABELS[s] || (s ? String(s) : DASH);
}

/** Stavy importů, běhů a exportů. */
export const JOB_STATUS_LABELS = {
  ok: 'OK',
  done: 'Hotovo',
  running: 'Běží',
  error: 'Chyba',
  pending: 'Čeká',
};

export const JOB_STATUS_VARIANT = { ok: 'success', done: 'success', running: 'info', error: 'danger', pending: 'warning' };

export const TRIGGER_LABELS = { manual: 'Ručně', schedule: 'Plánovač', api: 'API' };
export const ORIGIN_LABELS = { upload: 'Nahraný soubor', api: 'API', url: 'URL', schedule: 'Plánovač', manual: 'Ručně' };
export const KIND_LABELS = { offers: 'Ceny konkurence', products: 'Katalog produktů' };
export const SCOPE_LABELS = { read: 'Čtení', import: 'Import', export: 'Export', admin: 'Správa' };
export const EXPORT_KIND_LABELS = {
  feed: 'Feed', pohoda: 'POHODA XML', webhook: 'Webhook', csv: 'CSV', xlsx: 'XLSX', json: 'JSON', xml: 'XML', ack: 'Potvrzení (ack)',
};

/** Dostupnost nabídky konkurence. */
export function availability(inStock, deliveryDays) {
  const d = toNum(deliveryDays);
  if (inStock === 1 || inStock === true) return d && d > 0 ? 'Skladem (' + d + NBSP + 'd)' : 'Skladem';
  if (inStock === 0 || inStock === false) {
    if (d != null && d > 0) return 'Do ' + d + NBSP + plural(d, 'dne', 'dnů', 'dnů');
    return 'Není skladem';
  }
  return 'Neznámo';
}

/** Zkrácení textu s výpustkou. */
export function truncate(s, n = 60) {
  if (s == null) return '';
  const str = String(s);
  return str.length > n ? str.slice(0, Math.max(1, n - 1)) + '…' : str;
}

/** Odstranění diakritiky a malá písmena (pro vyhledávání na klientu). */
export function fold(s) {
  if (s == null) return '';
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * Parsování čísla zadaného uživatelem („12 990“, „12,5“, „-3“). Prázdné → null, nesmysl → NaN.
 * @returns {number|null}
 */
export function parseInputNumber(s) {
  if (s == null) return null;
  if (typeof s === 'number') return Number.isFinite(s) ? s : NaN;
  let t = String(s).trim();
  if (!t) return null;
  t = t.replace(/[\s  ]/g, '').replace(/kč$/i, '').replace(/%$/, '').replace(MINUS, '-');
  if (/^-?\d+(,\d+)?$/.test(t)) t = t.replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/** Kroky vysvětlení rozhodnutí (explain[].step). */
export const STEP_LABELS = {
  strategy: 'Strategie',
  locked: 'Zámek',
  stock: 'Sklad',
  market: 'Trh',
  target: 'Cíl',
  reference: 'Reference',
  fallback: 'Náhradní režim',
  bounds: 'Hranice',
  limits: 'Limity',
  floor: 'Spodní hranice',
  ceiling: 'Horní hranice',
  change_limit: 'Limit změny',
  rounding: 'Zaokrouhlení',
  threshold: 'Práh změny',
  approval: 'Schválení',
  result: 'Výsledek',
};

export function stepLabel(s) {
  return STEP_LABELS[s] || (s ? String(s) : '');
}
