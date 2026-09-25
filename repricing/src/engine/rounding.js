'use strict';
// Zaokrouhlení prodejních cen na cenové body (…9, …90, …990 apod.) – SPEC §6.6.
//
// Režimy:
//   none    – jen na haléře (2 desetinná místa), směr se neuplatní (roundPrice),
//             kandidáti down/up jsou nejbližší haléř dolů/nahoru (pro hlídání spodní hranice)
//   integer – celé koruny, uplatní se směr (down/up/nearest)
//   ending  – cenové body k × step + ending (k ≥ 0) podle pásma, do kterého cena spadá
//
// Pásmo = první pásmo s value ≤ up_to (null = ∞). Pokud cena přesáhne všechna pásma
// (poslední up_to není null), použije se poslední pásmo – konzervativní volba, aby se cena
// vždy zaokrouhlila podle nějakého pravidla.

const { round } = require('../util/num');

const EPS = 1e-9;

/** Výchozí pásma: do 1000 Kč na …9, do 10 000 Kč na …90, nad to na …990. */
const DEFAULT_BANDS = Object.freeze([
  Object.freeze({ up_to: 1000, ending: 9 }),
  Object.freeze({ up_to: 10000, ending: 90 }),
  Object.freeze({ up_to: null, ending: 990 }),
]);

const MODES = ['none', 'integer', 'ending'];
const DIRECTIONS = ['down', 'up', 'nearest'];

/**
 * Krok cenových bodů pásma: band.step, jinak 10^(počet číslic konce).
 * ending 0 → 1 (celé koruny), 9 → 10, 90/99 → 100, 490/990/999 → 1000; konec < 1 (např. 0,9) → 1.
 */
function stepFor(band) {
  if (band && band.step != null && Number(band.step) > 0) return Number(band.step);
  const ending = Number(band && band.ending) || 0;
  if (ending < 1) return 1;
  return 10 ** String(Math.trunc(ending)).length;
}

function pickBand(value, bands) {
  const list = Array.isArray(bands) && bands.length ? bands : DEFAULT_BANDS;
  for (const b of list) {
    if (b.up_to == null || value <= Number(b.up_to) + EPS) return b;
  }
  return list[list.length - 1];
}

/** Popis pásma pro vysvětlení: „…90“, „celé koruny“, „100 × k + 50“. */
function describeBand(band) {
  const step = stepFor(band);
  const ending = Number(band.ending) || 0;
  if (step === 1 && ending === 0) return 'celé koruny';
  const digits = Math.round(Math.log10(step));
  if (step >= 10 && 10 ** digits === step && Number.isInteger(ending)) {
    return '…' + String(ending).padStart(digits, '0');
  }
  return `${step} × k + ${ending}`;
}

function modeOf(rounding) {
  const m = rounding && rounding.mode;
  return MODES.includes(m) ? m : 'ending';
}

/**
 * Kandidáti zaokrouhlení: nejbližší cenový bod dolů a nahoru.
 * down ≤ value ≤ up; pokud by down vyšel ≤ 0, použije se up (cena nesmí být nulová).
 * @param {number} value
 * @param {{mode?: string, bands?: Array<{up_to: number|null, ending: number, step?: number}>}} rounding
 * @returns {{down: number, up: number}|{down: null, up: null}}
 */
function priceCandidates(value, rounding) {
  if (value == null || !Number.isFinite(value)) return { down: null, up: null };
  const mode = modeOf(rounding);
  let down;
  let up;
  if (mode === 'none') {
    down = Math.floor(value * 100 + EPS * 100) / 100;
    up = Math.ceil(value * 100 - EPS * 100) / 100;
    down = round(down, 2);
    up = round(up, 2);
    if (up <= 0) up = 0.01;
  } else {
    const band = mode === 'integer' ? { ending: 0, step: 1 } : pickBand(value, rounding && rounding.bands);
    const step = stepFor(band);
    const ending = Number(band.ending) || 0;
    const kDown = Math.floor((value - ending) / step + EPS);
    let kUp = Math.ceil((value - ending) / step - EPS);
    if (kUp < 0) kUp = 0;
    up = round(kUp * step + ending, 2);
    if (up <= 0) up = round(step + ending, 2); // ending 0 a hodnota ≤ 0 → první kladný bod
    down = kDown >= 0 ? round(kDown * step + ending, 2) : null;
  }
  if (down == null || down <= 0) down = up;
  return { down, up };
}

/**
 * Zaokrouhlí cenu podle nastavení.
 * @param {number} value
 * @param {{mode?: string, direction?: string, bands?: Array}} rounding
 * @param {'down'|'up'|'nearest'} [direction] přebije rounding.direction (výchozí 'down')
 * @returns {number|null}
 */
function roundPrice(value, rounding, direction) {
  if (value == null || !Number.isFinite(value)) return null;
  const mode = modeOf(rounding);
  const { down, up } = priceCandidates(value, rounding);
  if (mode === 'none') {
    const r = round(value, 2);
    return r > 0 ? r : up;
  }
  const dir = direction || (rounding && rounding.direction) || 'down';
  if (dir === 'up') return up;
  if (dir === 'nearest') {
    // remíza → dolů
    return up - value < value - down - EPS ? up : down;
  }
  return down;
}

/** Text pro vysvětlení: „Zaokrouhlení na …90 dolů“. */
function describeRounding(value, rounding, direction) {
  const mode = modeOf(rounding);
  const dir = direction || (rounding && rounding.direction) || 'down';
  const dirText = dir === 'up' ? 'nahoru' : dir === 'nearest' ? 'k nejbližšímu bodu' : 'dolů';
  if (mode === 'none') return 'Zaokrouhlení na haléře';
  if (mode === 'integer') return `Zaokrouhlení na celé koruny ${dirText}`;
  return `Zaokrouhlení na ${describeBand(pickBand(value, rounding && rounding.bands))} ${dirText}`;
}

/**
 * Kontrola nastavení zaokrouhlení (používá normalizeConfig).
 * @returns {string[]} chyby česky
 */
function validateRounding(rounding) {
  const errors = [];
  if (rounding == null || typeof rounding !== 'object' || Array.isArray(rounding)) return ['rounding: musí být objekt'];
  if (!MODES.includes(rounding.mode)) errors.push(`rounding.mode: neznámý režim „${rounding.mode}“ (povoleno: ${MODES.join(', ')})`);
  if (!DIRECTIONS.includes(rounding.direction)) errors.push(`rounding.direction: neznámý směr „${rounding.direction}“ (povoleno: ${DIRECTIONS.join(', ')})`);
  const bands = rounding.bands;
  if (rounding.mode === 'ending' && (!Array.isArray(bands) || !bands.length)) {
    errors.push('rounding.bands: režim „ending“ vyžaduje alespoň jedno pásmo');
    return errors;
  }
  if (bands == null) return errors;
  if (!Array.isArray(bands)) {
    errors.push('rounding.bands: musí být pole');
    return errors;
  }
  let prev = -Infinity;
  bands.forEach((b, i) => {
    const p = `rounding.bands[${i}]`;
    if (b == null || typeof b !== 'object') {
      errors.push(`${p}: musí být objekt {up_to, ending, step?}`);
      return;
    }
    if (b.up_to != null && !(typeof b.up_to === 'number' && Number.isFinite(b.up_to) && b.up_to > 0)) errors.push(`${p}.up_to: musí být kladné číslo nebo null`);
    if (!(typeof b.ending === 'number' && Number.isFinite(b.ending) && b.ending >= 0)) errors.push(`${p}.ending: musí být nezáporné číslo`);
    if (b.step != null && !(typeof b.step === 'number' && Number.isFinite(b.step) && b.step > 0)) errors.push(`${p}.step: musí být kladné číslo`);
    if (typeof b.ending === 'number' && b.ending >= stepFor(b)) errors.push(`${p}: konec ${b.ending} musí být menší než krok ${stepFor(b)}`);
    if (b.up_to == null) {
      if (i !== bands.length - 1) errors.push(`${p}.up_to: null (bez horní meze) smí mít jen poslední pásmo`);
    } else if (typeof b.up_to === 'number') {
      if (b.up_to <= prev) errors.push(`${p}.up_to: pásma musí být seřazena vzestupně podle up_to`);
      prev = b.up_to;
    }
  });
  return errors;
}

module.exports = {
  roundPrice,
  priceCandidates,
  describeRounding,
  describeBand,
  validateRounding,
  stepFor,
  pickBand,
  DEFAULT_BANDS,
  MODES,
  DIRECTIONS,
};
