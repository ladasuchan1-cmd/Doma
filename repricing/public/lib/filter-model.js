// Model filtru segmentů (SPEC §6.4) – převod JSON ↔ editovatelný strom, validace, český popis.
// Čistý modul bez DOM.

import { parseInputNumber, number as fmtNumber, POSITION_LABELS } from './format.js';

export const OP_LABELS = {
  '=': 'je rovno',
  '!=': 'není rovno',
  '>': 'je větší než',
  '>=': 'je alespoň',
  '<': 'je menší než',
  '<=': 'je nejvýše',
  in: 'je jedno z',
  not_in: 'není žádné z',
  contains: 'obsahuje',
  not_contains: 'neobsahuje',
  starts_with: 'začíná na',
  empty: 'je prázdné',
  not_empty: 'je vyplněné',
  between: 'je mezi',
  is_true: 'ano',
  is_false: 'ne',
};

export const ALL_OPS = Object.keys(OP_LABELS);

export const OPS_BY_TYPE = {
  string: ['=', '!=', 'in', 'not_in', 'contains', 'not_contains', 'starts_with', 'empty', 'not_empty'],
  number: ['>=', '<=', '>', '<', '=', '!=', 'between', 'in', 'not_in', 'empty', 'not_empty'],
  enum: ['=', '!=', 'in', 'not_in', 'empty', 'not_empty'],
  boolean: ['is_true', 'is_false'],
};

export const NO_VALUE_OPS = new Set(['empty', 'not_empty', 'is_true', 'is_false']);
export const LIST_OPS = new Set(['in', 'not_in']);

/** Známé hodnoty výčtových polí, pokud je /fields neposílá. */
export const KNOWN_ENUMS = {
  position: Object.keys(POSITION_LABELS).map((v) => ({ value: v, label: POSITION_LABELS[v] })),
};

export function opsFor(type) {
  return OPS_BY_TYPE[type] || OPS_BY_TYPE.string;
}

export function defaultOp(type) {
  return opsFor(type)[0];
}

let nodeCounter = 0;
function nid() {
  nodeCounter += 1;
  return 'n' + nodeCounter;
}

export function newGroup(mode = 'all') {
  return { kind: 'group', id: nid(), mode, negate: false, items: [] };
}

export function newCond(field = '', op = '', value = '') {
  return { kind: 'cond', id: nid(), field, op, value };
}

function isCond(f) {
  return f && typeof f === 'object' && !Array.isArray(f) && typeof f.field === 'string';
}

function toNode(f) {
  if (f == null || typeof f !== 'object' || Array.isArray(f)) return newGroup('all');
  if (isCond(f)) return newCond(f.field, f.op || '=', f.value === undefined ? '' : f.value);
  if (Array.isArray(f.all) || Array.isArray(f.any)) {
    const mode = Array.isArray(f.any) ? 'any' : 'all';
    const g = newGroup(mode);
    g.items = f[mode].map(toNode);
    return g;
  }
  if ('not' in f) {
    const inner = toNode(f.not);
    if (inner.kind === 'group') {
      inner.negate = !inner.negate;
      return inner;
    }
    const g = newGroup('all');
    g.negate = true;
    g.items = [inner];
    return g;
  }
  return newGroup('all'); // {} = vše
}

/** JSON filtr → strom pro editor. Kořen je vždy skupina. */
export function toModel(filter) {
  const node = toNode(filter);
  if (node.kind === 'group') return node;
  const g = newGroup('all');
  g.items = [node];
  return g;
}

/** Rozdělí seznam hodnot „Trek, Specialized; Scott“ → pole. */
export function parseList(v) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x.trim() : x)).filter((x) => x !== '' && x != null);
  if (v == null) return [];
  return String(v)
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Normalizuje hodnotu podmínky podle operátoru a typu pole.
 * @returns {{ok: boolean, value?: any, error?: string}}
 */
export function normalizeValue(op, value, type) {
  if (NO_VALUE_OPS.has(op)) return { ok: true, value: undefined };
  if (LIST_OPS.has(op)) {
    let list = parseList(value);
    if (type === 'number') {
      const nums = list.map((x) => parseInputNumber(x));
      if (nums.some((n) => n == null || Number.isNaN(n))) return { ok: false, error: 'Seznam obsahuje nečíselnou hodnotu' };
      list = nums;
    }
    list = [...new Set(list)];
    if (!list.length) return { ok: false, error: 'Zadejte alespoň jednu hodnotu' };
    return { ok: true, value: list };
  }
  if (op === 'between') {
    const arr = Array.isArray(value) ? value : parseList(value);
    const a = parseInputNumber(arr[0]);
    const b = parseInputNumber(arr[1]);
    if (a == null || b == null || Number.isNaN(a) || Number.isNaN(b)) return { ok: false, error: 'Zadejte obě meze rozsahu' };
    return { ok: true, value: a <= b ? [a, b] : [b, a] };
  }
  if (type === 'number' || ['>', '>=', '<', '<='].includes(op)) {
    const n = parseInputNumber(value);
    if (n == null || Number.isNaN(n)) return { ok: false, error: 'Zadejte číslo' };
    return { ok: true, value: n };
  }
  const s = value == null ? '' : String(value).trim();
  if (!s) return { ok: false, error: 'Zadejte hodnotu' };
  return { ok: true, value: s };
}

function fieldType(fieldsMap, key) {
  const f = fieldsMap && (fieldsMap instanceof Map ? fieldsMap.get(key) : fieldsMap[key]);
  if (f && f.type) return f.type;
  return 'string';
}

function condToJson(c, fieldsMap, errors, strict) {
  if (!c.field) {
    errors.push({ id: c.id, message: 'Vyberte pole' });
    return null;
  }
  const type = fieldType(fieldsMap, c.field);
  const op = c.op || defaultOp(type);
  const norm = normalizeValue(op, c.value, type);
  if (!norm.ok) {
    errors.push({ id: c.id, message: norm.error });
    if (strict) return null;
    return null;
  }
  const out = { field: c.field, op };
  if (norm.value !== undefined) out.value = norm.value;
  return out;
}

function groupToJson(g, fieldsMap, errors, strict, isRoot) {
  const items = [];
  for (const it of g.items) {
    const j = it.kind === 'group' ? groupToJson(it, fieldsMap, errors, strict, false) : condToJson(it, fieldsMap, errors, strict);
    if (j) items.push(j);
  }
  if (!items.length) {
    if (isRoot) return g.negate ? { not: {} } : {};
    return null; // prázdná vnořená skupina se vynechá
  }
  const body = { [g.mode === 'any' ? 'any' : 'all']: items };
  return g.negate ? { not: body } : body;
}

/**
 * Strom → JSON filtr. Neúplné podmínky se vynechají a vrátí se v errors (id uzlu + zpráva).
 * @returns {{filter: object, errors: {id: string, message: string}[]}}
 */
export function fromModel(model, fieldsMap, { strict = false } = {}) {
  const errors = [];
  const filter = groupToJson(model, fieldsMap, errors, strict, true) || {};
  return { filter, errors };
}

/** Je filtr prázdný (= všechny produkty)? */
export function isEmptyFilter(f) {
  if (f == null || typeof f !== 'object') return true;
  if (isCond(f)) return false;
  const keys = Object.keys(f);
  if (!keys.length) return true;
  if (Array.isArray(f.all)) return f.all.every(isEmptyFilter);
  return false;
}

/** Počet podmínek ve filtru. */
export function countConditions(f) {
  if (f == null || typeof f !== 'object') return 0;
  if (isCond(f)) return 1;
  if (Array.isArray(f.all)) return f.all.reduce((s, x) => s + countConditions(x), 0);
  if (Array.isArray(f.any)) return f.any.reduce((s, x) => s + countConditions(x), 0);
  if (f.not) return countConditions(f.not);
  return 0;
}

/** Klientská validace JSON filtru (struktura + operátory). */
export function validateFilter(f, path = 'filtr') {
  const errors = [];
  const walk = (x, p) => {
    if (x == null || typeof x !== 'object' || Array.isArray(x)) {
      errors.push(p + ': očekáván objekt');
      return;
    }
    if (isCond(x)) {
      if (!ALL_OPS.includes(x.op)) errors.push(p + ': neznámý operátor „' + x.op + '“');
      else if (!NO_VALUE_OPS.has(x.op) && x.value === undefined) errors.push(p + ': chybí hodnota');
      if (x.op === 'between' && !(Array.isArray(x.value) && x.value.length === 2)) errors.push(p + ': „mezi“ vyžaduje dvě hodnoty');
      return;
    }
    const keys = Object.keys(x);
    if (!keys.length) return;
    if (Array.isArray(x.all)) x.all.forEach((y, i) => walk(y, p + '.all[' + i + ']'));
    else if (Array.isArray(x.any)) x.any.forEach((y, i) => walk(y, p + '.any[' + i + ']'));
    else if ('not' in x) walk(x.not, p + '.not');
    else errors.push(p + ': neznámá struktura (' + keys.join(', ') + ')');
  };
  walk(f, path);
  return { ok: errors.length === 0, errors };
}

function fieldLabel(fieldsMap, key) {
  const f = fieldsMap && (fieldsMap instanceof Map ? fieldsMap.get(key) : fieldsMap[key]);
  if (f && f.label) return f.label;
  if (key.startsWith('attrs.')) return key.slice(6);
  return key;
}

function valueText(field, v) {
  if (typeof v === 'number') return fmtNumber(v, 2).replace(/,00$/, '');
  if (field === 'position' && POSITION_LABELS[v]) return POSITION_LABELS[v];
  return '„' + String(v) + '“';
}

function joinCz(list, conj) {
  if (list.length <= 1) return list.join('');
  return list.slice(0, -1).join(', ') + ' ' + conj + ' ' + list[list.length - 1];
}

/**
 * Lidsky čitelný český popis filtru.
 * describeFilter({all:[{field:'manufacturer',op:'in',value:['Trek','Scott']}]}) → „Výrobce je jedno z „Trek“ nebo „Scott““
 */
export function describeFilter(f, fieldsMap) {
  const d = (x, top) => {
    if (x == null || typeof x !== 'object') return '';
    if (isCond(x)) {
      const label = fieldLabel(fieldsMap, x.field);
      const op = OP_LABELS[x.op] || x.op;
      if (NO_VALUE_OPS.has(x.op)) {
        if (x.op === 'is_true') return label + ': ano';
        if (x.op === 'is_false') return label + ': ne';
        return label + ' ' + op;
      }
      if (LIST_OPS.has(x.op)) {
        const vals = parseList(x.value).map((v) => valueText(x.field, v));
        return label + ' ' + op + ' ' + joinCz(vals, 'nebo');
      }
      if (x.op === 'between' && Array.isArray(x.value)) {
        return label + ' je mezi ' + valueText(x.field, x.value[0]) + ' a ' + valueText(x.field, x.value[1]);
      }
      return label + ' ' + op + ' ' + valueText(x.field, x.value);
    }
    if (Array.isArray(x.all) || Array.isArray(x.any)) {
      const mode = Array.isArray(x.any) ? 'any' : 'all';
      const parts = x[mode].map((y) => d(y, false)).filter(Boolean);
      if (!parts.length) return mode === 'any' ? 'nic' : '';
      if (parts.length === 1) return parts[0];
      const s = parts.join(mode === 'any' ? ' nebo ' : ' a zároveň ');
      return top ? s : '(' + s + ')';
    }
    if ('not' in x) {
      const inner = d(x.not, false);
      return inner ? 'neplatí, že ' + inner : 'nic';
    }
    return '';
  };
  const s = d(f, true);
  return s || 'Všechny produkty';
}
