// Výběr sloupců tabulky produktů: pole z GET /fields (včetně attrs.* a group_code), uložení výběru v localStorage
// (per prohlížeč) a v URL (?cols=…, sdílitelný odkaz), čtení hodnot podle cesty s tečkami a formátování podle
// typu pole. Čistý modul bez DOM – localStorage jen přes try/catch (soukromé okno, zakázané úložiště).

import { money, percent, int, number, dateTime, POSITION_LABELS, DASH, truncate, toNum } from './format.js';

/** Klíč v localStorage. */
export const COLS_STORAGE_KEY = 'ct-products-cols';

/** Výchozí sloupce (pořadí) – odpovídají původní pevné tabulce produktů. */
export const DEFAULT_COLUMNS = Object.freeze(['code', 'name', 'manufacturer', 'stock', 'purchase_price', 'price', 'margin_pct', 'market_min', 'price_index', 'position', 'market_count', 'proposal']);

/** Sloupce, které v /fields nejsou (vykreslí je pohled sám). */
export const EXTRA_COLUMNS = Object.freeze([
  { key: 'proposal', label: 'Návrh ceny', group: 'Cenotvorba', type: 'special', sortable: false },
]);

/** Sloupec, který nejde skrýt (odkaz na detail, hlavička karty na mobilu). */
export const REQUIRED_COLUMN = 'name';

/** Nejvíc sloupců najednou (URL i tabulka musí zůstat rozumné). */
export const MAX_COLUMNS = 40;

// Klíče atributů mohou obsahovat čárku – v URL ji (a %) zakódujeme, ať jde seznam rozdělit čárkou.
const encKey = (k) => String(k).replace(/%/g, '%25').replace(/,/g, '%2C');
function decKey(k) {
  return String(k).replace(/%2C/gi, ',').replace(/%25/g, '%');
}

/**
 * Seznam klíčů z URL / úložiště → unikátní pole (bez prázdných, nejvýš MAX_COLUMNS). Povinný sloupec doplní.
 * @param {string|string[]|null|undefined} v „code,name,attrs.N“ nebo pole
 * @returns {string[]|null} null = nic použitelného
 */
export function parseCols(v) {
  let list;
  if (Array.isArray(v)) list = v.map(String);
  else if (typeof v === 'string' && v.trim()) list = v.split(',').map(decKey);
  else return null;
  const out = [];
  for (const raw of list) {
    const k = raw.trim();
    if (!k || k.length > 200 || out.includes(k)) continue;
    out.push(k);
    if (out.length >= MAX_COLUMNS) break;
  }
  if (!out.length) return null;
  if (!out.includes(REQUIRED_COLUMN)) out.unshift(REQUIRED_COLUMN);
  return out;
}

/** Pole klíčů → hodnota parametru cols. */
export function serializeCols(cols) {
  return (Array.isArray(cols) ? cols : []).map(encKey).join(',');
}

/** Stejný výběr jako výchozí (pak se do URL ani úložiště nic nepíše). */
export function isDefaultCols(cols) {
  return Array.isArray(cols) && cols.length === DEFAULT_COLUMNS.length && cols.every((k, i) => k === DEFAULT_COLUMNS[i]);
}

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** Uložený výběr z localStorage (null = nic / nečitelné / úložiště nedostupné). */
export function loadStoredCols(key = COLS_STORAGE_KEY) {
  try {
    const s = storage();
    const raw = s ? s.getItem(key) : null;
    if (!raw) return null;
    return parseCols(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Uloží výběr (výchozí = smaže). Vrací true, když se zápis povedl. */
export function saveStoredCols(cols, key = COLS_STORAGE_KEY) {
  try {
    const s = storage();
    if (!s) return false;
    if (!cols || isDefaultCols(cols)) s.removeItem(key);
    else s.setItem(key, JSON.stringify(cols));
    return true;
  } catch {
    return false;
  }
}

/**
 * Výběr sloupců pro zobrazení: URL má přednost (sdílený odkaz), pak localStorage, pak výchozí.
 * @param {{url?: string|null, stored?: string[]|null}} o
 * @returns {{cols: string[], source: 'url'|'storage'|'default'}}
 */
export function resolveCols(o = {}) {
  const fromUrl = parseCols(o.url);
  if (fromUrl) return { cols: fromUrl, source: 'url' };
  const stored = o.stored === undefined ? loadStoredCols() : parseCols(o.stored);
  if (stored) return { cols: stored, source: 'storage' };
  return { cols: [...DEFAULT_COLUMNS], source: 'default' };
}

/**
 * Hodnota pole řádku podle klíče s tečkami („attrs.N“, „proposal.status“). Atributy mohou mít v názvu tečku
 * („attrs.PARAM.Barva“ = attrs['PARAM.Barva']) – zkusí se obojí.
 */
export function valueAt(row, key) {
  if (row == null || !key) return undefined;
  const k = String(key);
  if (!k.includes('.')) return row[k];
  const nested = k.split('.').reduce((o, part) => (o == null ? undefined : o[part]), row);
  if (nested !== undefined) return nested;
  if (k.startsWith('attrs.') && row.attrs && typeof row.attrs === 'object') return row.attrs[k.slice(6)];
  return undefined;
}

const DATE_KEY = /(_at|_until)$/;

/**
 * Způsob formátování pole podle typu a jednotky z /fields.
 * @param {{key: string, type?: string, unit?: string}} f
 * @returns {'money'|'percent'|'int'|'days'|'number'|'bool'|'enum'|'date'|'text'}
 */
export function fieldFormat(f) {
  if (!f) return 'text';
  const type = f.type || 'string';
  if (type === 'number') {
    if (f.unit === 'Kč') return 'money';
    if (f.unit === '%') return 'percent';
    if (f.unit === 'ks') return 'int';
    if (f.unit === 'dní') return 'days';
    return 'number';
  }
  if (type === 'boolean') return 'bool';
  if (type === 'enum') return 'enum';
  if (DATE_KEY.test(String(f.key || ''))) return 'date';
  return 'text';
}

/** Je formát číselný (zarovnání vpravo, řazení sestupně jako první)? */
export function isNumericFormat(fmt) {
  return ['money', 'percent', 'int', 'days', 'number'].includes(fmt);
}

function boolOf(v) {
  if (v === true || v === 1 || v === '1') return true;
  if (v === false || v === 0 || v === '0') return false;
  const s = String(v).trim().toLowerCase();
  if (['true', 'ano', 'yes'].includes(s)) return true;
  if (['false', 'ne', 'no'].includes(s)) return false;
  return null;
}

/**
 * Hodnota pole jako text podle typu pole (české formáty, „–“ pro prázdné).
 * @param {{key: string, type?: string, unit?: string, value_labels?: object}} f pole z /fields
 * @param {*} v
 */
export function formatFieldValue(f, v) {
  if (v == null || v === '') return DASH;
  const fmt = fieldFormat(f);
  switch (fmt) {
    case 'money': return money(v);
    case 'percent': return percent(v);
    case 'int': return int(v);
    case 'days': return toNum(v) == null ? String(v) : number(v, 1);
    case 'number': {
      const n = toNum(v);
      if (n == null) return String(v);
      return Number.isInteger(n) ? int(n) : number(n, 2);
    }
    case 'bool': {
      const b = boolOf(v);
      return b == null ? String(v) : b ? 'ano' : 'ne';
    }
    case 'enum': return (f.value_labels && f.value_labels[v]) || (f.key === 'position' ? POSITION_LABELS[v] : null) || String(v);
    case 'date': return dateTime(v);
    default:
      if (typeof v === 'object') return truncate(JSON.stringify(v), 80);
      return truncate(String(v), 80);
  }
}

/**
 * Pole, ze kterých lze vybírat: /fields + zvláštní sloupce, seskupené podle group (pořadí skupin jako v /fields).
 * @param {object[]} fields pole z GET /fields
 * @returns {{group: string, fields: object[]}[]}
 */
export function pickerGroups(fields) {
  const groups = new Map();
  for (const f of [...(Array.isArray(fields) ? fields : []), ...EXTRA_COLUMNS]) {
    if (!f || !f.key) continue;
    const g = f.group || 'Ostatní';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(f);
  }
  return [...groups.entries()].map(([group, list]) => ({ group, fields: list }));
}

/** Posune sloupec v pořadí o delta (−1 nahoru, +1 dolů). Vrací nové pole. */
export function moveCol(cols, key, delta) {
  const out = [...cols];
  const i = out.indexOf(key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Přidá / odebere sloupec (povinný sloupec nejde odebrat, nový jde na konec). */
export function toggleCol(cols, key, on) {
  const has = cols.includes(key);
  if (on && !has) return cols.length >= MAX_COLUMNS ? [...cols] : [...cols, key];
  if (!on && has && key !== REQUIRED_COLUMN) return cols.filter((k) => k !== key);
  return [...cols];
}
