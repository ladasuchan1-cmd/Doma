'use strict';
// Filtry segmentů a podmínek strategií (SPEC §6.4).
//
//   Filter := {} | {"all": [Filter…]} | {"any": [Filter…]} | {"not": Filter} | {"field", "op", "value"}
//
// Sémantika:
//  - pole se hledá podle tečkové cesty (`attrs.N`); klíče atributů mohou samy obsahovat tečky
//    (`attrs.PARAM.Barva` → view.attrs['PARAM.Barva']), proto se zkouší nejdelší shoda klíče,
//  - řetězce se porovnávají bez ohledu na velikost písmen a diakritiku (fold),
//  - číselné operátory (> >= < <= between) převádějí obě strany přes parseNumber; nečíselná strana → false,
//  - chybějící/null/prázdná hodnota pole → všechny operátory false kromě empty, not_in, !=, not_contains, is_false.

const { fold } = require('../util/keys');
const { parseNumber } = require('../util/num');

const EPS = 1e-9;

/** Operátory s českými popisky (pro UI). */
const OPS = Object.freeze({
  '=': 'je rovno',
  '!=': 'není rovno',
  '>': 'je větší než',
  '>=': 'je větší nebo rovno',
  '<': 'je menší než',
  '<=': 'je menší nebo rovno',
  in: 'je jedním z',
  not_in: 'není žádným z',
  contains: 'obsahuje',
  not_contains: 'neobsahuje',
  starts_with: 'začíná na',
  empty: 'je prázdné',
  not_empty: 'není prázdné',
  between: 'je v rozsahu (včetně)',
  is_true: 'je pravda (ano)',
  is_false: 'je nepravda (ne)',
});

// Operátory, které na chybějící hodnotě vrací true
const TRUE_ON_MISSING = new Set(['empty', 'not_in', '!=', 'not_contains', 'is_false']);
const NO_VALUE_OPS = new Set(['empty', 'not_empty', 'is_true', 'is_false']);

class FilterError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'FilterError';
    this.errors = errors || [message];
    this.status = 400;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isMissing(v) {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'number') return !Number.isFinite(v);
  return false;
}

const TRUE_WORDS = new Set(['1', 'true', 'ano', 'yes', 'y', 'a', 'pravda', 'on']);
function truthy(v) {
  if (v === true) return true;
  if (v == null || v === false) return false;
  if (typeof v === 'number') return v !== 0 && Number.isFinite(v);
  return TRUE_WORDS.has(fold(v));
}

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return null;
  return parseNumber(v);
}

/** Předzpracovaná hodnota podmínky (fold/číslo spočítané jednou při kompilaci). */
function prep(b) {
  return { raw: b, isBool: typeof b === 'boolean', isNum: typeof b === 'number', bool: truthy(b), num: num(b), folded: fold(b) };
}

/** Rovnost hodnoty pole a hodnoty podmínky: boolean → pravdivost; číslo na jedné straně → číselně; jinak fold řetězců. */
function equalsPrep(a, pb) {
  if (typeof a === 'boolean' || pb.isBool) return truthy(a) === pb.bool;
  if (typeof a === 'number' || pb.isNum) {
    const x = num(a);
    if (x != null && pb.num != null) return Math.abs(x - pb.num) < EPS;
  }
  return fold(a) === pb.folded;
}

function toList(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
  }
  return [value];
}

/** Getter pro tečkovou cestu – zkouší nejdelší shodu klíče (klíče atributů mohou obsahovat tečky). */
function makeGetter(field) {
  if (!field.includes('.')) return (obj) => (obj == null ? undefined : obj[field]);
  const parts = field.split('.');
  const resolve = (obj, i) => {
    if (obj == null || typeof obj !== 'object') return undefined;
    for (let j = parts.length; j > i; j--) {
      const key = parts.slice(i, j).join('.');
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        if (j === parts.length) return obj[key];
        const r = resolve(obj[key], j);
        if (r !== undefined) return r;
      }
    }
    return undefined;
  };
  return (obj) => resolve(obj, 0);
}

// ---------------------------------------------------------------------------------------------
// Validace

function validateNode(node, path, errors, depth) {
  if (depth > 50) {
    errors.push(`${path}: filtr je příliš hluboko vnořený`);
    return;
  }
  if (node == null) return; // null = vše
  if (!isPlainObject(node)) {
    errors.push(`${path}: podmínka musí být objekt`);
    return;
  }
  const groupKeys = ['all', 'any', 'not'].filter((k) => k in node);
  if (groupKeys.length > 1) {
    errors.push(`${path}: skupina smí mít jen jeden z klíčů all / any / not`);
    return;
  }
  if (groupKeys.length === 1) {
    if ('field' in node || 'op' in node) {
      errors.push(`${path}: objekt nemůže být zároveň skupina a podmínka`);
      return;
    }
    const k = groupKeys[0];
    if (k === 'not') {
      if (!isPlainObject(node.not)) errors.push(`${path}.not: musí obsahovat jeden filtr (objekt)`);
      else validateNode(node.not, `${path}.not`, errors, depth + 1);
      return;
    }
    if (!Array.isArray(node[k])) {
      errors.push(`${path}.${k}: musí být pole podmínek`);
      return;
    }
    node[k].forEach((child, i) => {
      if (child == null) errors.push(`${path}.${k}[${i}]: prázdná podmínka`);
      else validateNode(child, `${path}.${k}[${i}]`, errors, depth + 1);
    });
    return;
  }
  const keys = Object.keys(node);
  if (!keys.length) return; // {} = vše
  if (!('field' in node) && !('op' in node)) {
    errors.push(`${path}: neznámá struktura filtru (očekáváno all / any / not nebo field + op)`);
    return;
  }
  if (typeof node.field !== 'string' || !node.field.trim()) errors.push(`${path}.field: chybí název pole`);
  if (typeof node.op !== 'string' || !Object.prototype.hasOwnProperty.call(OPS, node.op)) {
    errors.push(`${path}.op: neznámý operátor „${node.op}“ (povoleno: ${Object.keys(OPS).join(' ')})`);
    return;
  }
  const op = node.op;
  const v = node.value;
  if (NO_VALUE_OPS.has(op)) return;
  if (op === 'between') {
    // nečíselné meze nejsou chyba struktury – podmínka pak prostě neplatí (SPEC §6.4)
    const list = typeof v === 'string' ? v.split(/[;,]|\.\./).map((s) => s.trim()) : v;
    if (!Array.isArray(list) || list.length !== 2) errors.push(`${path}.value: operátor „between“ vyžaduje dvojici [od, do]`);
    return;
  }
  if (op === 'in' || op === 'not_in') {
    if (!(Array.isArray(v) || typeof v === 'string' || typeof v === 'number')) errors.push(`${path}.value: operátor „${op}“ vyžaduje seznam hodnot`);
    return;
  }
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '' && op !== '=' && op !== '!=')) {
    errors.push(`${path}.value: chybí hodnota pro operátor „${op}“`);
    return;
  }
  if (typeof v === 'object' && !Array.isArray(v)) errors.push(`${path}.value: hodnota nesmí být objekt`);
}

/**
 * Zkontroluje strukturu filtru.
 * @param {object|string|null} filter
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateFilter(filter) {
  const errors = [];
  let f = filter;
  if (typeof f === 'string') {
    if (f.trim() === '') f = {};
    else {
      try {
        f = JSON.parse(f);
      } catch {
        return { ok: false, errors: ['Filtr není platný JSON'] };
      }
    }
  }
  validateNode(f, 'filtr', errors, 0);
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------------------------
// Kompilace

function compileCond(node) {
  const get = makeGetter(node.field.trim());
  const op = node.op;
  const value = node.value;
  const missingResult = TRUE_ON_MISSING.has(op);
  let test;
  switch (op) {
    case '=': {
      const pv = prep(value);
      test = (x) => equalsPrep(x, pv);
      break;
    }
    case '!=': {
      const pv = prep(value);
      test = (x) => !equalsPrep(x, pv);
      break;
    }
    case '>':
    case '>=':
    case '<':
    case '<=': {
      const y = num(value);
      test = (x) => {
        const a = num(x);
        if (a == null || y == null) return false;
        if (op === '>') return a > y + EPS;
        if (op === '>=') return a >= y - EPS;
        if (op === '<') return a < y - EPS;
        return a <= y + EPS;
      };
      break;
    }
    case 'between': {
      const list = typeof value === 'string' ? value.split(/[;,]|\.\./).map((s) => s.trim()) : value;
      const a0 = num(list[0]);
      const b0 = num(list[1]);
      if (a0 == null || b0 == null) {
        test = () => false; // nečíselná mez → podmínka neplatí
        break;
      }
      const lo = Math.min(a0, b0);
      const hi = Math.max(a0, b0);
      test = (x) => {
        const a = num(x);
        return a != null && a >= lo - EPS && a <= hi + EPS;
      };
      break;
    }
    case 'in':
    case 'not_in': {
      const list = toList(value).map(prep);
      const allText = !list.some((p) => p.isBool || p.isNum);
      const one = (x) => {
        if (typeof x === 'string' && allText) {
          // rychlá cesta pro texty (stejná sémantika jako equalsPrep): fold hodnoty pole jen jednou
          const f = fold(x);
          return list.some((p) => f === p.folded);
        }
        return list.some((p) => equalsPrep(x, p));
      };
      const inList = (x) => (Array.isArray(x) ? x.some(one) : one(x));
      test = op === 'in' ? inList : (x) => !inList(x);
      break;
    }
    case 'contains':
    case 'not_contains': {
      const needle = fold(value);
      const has = (x) => (Array.isArray(x) ? x.some((e) => fold(e).includes(needle)) : fold(x).includes(needle));
      test = op === 'contains' ? has : (x) => !has(x);
      break;
    }
    case 'starts_with': {
      const needle = fold(value);
      test = (x) => (Array.isArray(x) ? x.some((e) => fold(e).startsWith(needle)) : fold(x).startsWith(needle));
      break;
    }
    case 'empty':
      return (view) => isMissing(get(view));
    case 'not_empty':
      return (view) => !isMissing(get(view));
    case 'is_true':
      test = (x) => truthy(x);
      break;
    case 'is_false':
      test = (x) => !truthy(x);
      break;
    default:
      throw new FilterError(`Neznámý operátor „${op}“`);
  }
  return (view) => {
    const x = get(view);
    if (isMissing(x)) return missingResult;
    return test(x);
  };
}

function compileNode(node) {
  if (node == null) return () => true;
  if ('all' in node) {
    const parts = node.all.map(compileNode);
    return (view) => {
      for (const p of parts) if (!p(view)) return false;
      return true;
    };
  }
  if ('any' in node) {
    const parts = node.any.map(compileNode);
    return (view) => {
      for (const p of parts) if (p(view)) return true;
      return false;
    };
  }
  if ('not' in node) {
    const inner = compileNode(node.not);
    return (view) => !inner(view);
  }
  if (!Object.keys(node).length) return () => true;
  return compileCond(node);
}

/**
 * Zkompiluje filtr do funkce (view) => boolean.
 * @param {object|string|null} filter
 * @throws {FilterError} při neplatné struktuře nebo operátoru
 */
function compileFilter(filter) {
  const { ok, errors } = validateFilter(filter);
  if (!ok) throw new FilterError(`Neplatný filtr: ${errors.join('; ')}`, errors);
  const f = typeof filter === 'string' ? (filter.trim() ? JSON.parse(filter) : {}) : filter;
  return compileNode(f);
}

/** true, pokud filtr odpovídá všemu (prázdný). */
function isEmptyFilter(filter) {
  if (filter == null) return true;
  if (typeof filter === 'string') return filter.trim() === '' || filter.trim() === '{}';
  if (!isPlainObject(filter)) return false;
  const keys = Object.keys(filter);
  return keys.length === 0 || (keys.length === 1 && Array.isArray(filter.all) && filter.all.length === 0);
}

module.exports = { compileFilter, validateFilter, isEmptyFilter, FilterError, OPS, makeGetter, truthy };
