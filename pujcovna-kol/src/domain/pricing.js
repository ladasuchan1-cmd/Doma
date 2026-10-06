'use strict';
// Ceník (SPEC kap. 9): cena za typ kola a termín.
//   lengthOf(fromAt, toAt)  → { hours, unit: 'hour'|'halfday'|'day', units, days }
//                              ≤ 4 h = hodiny (unit hour × počet hodin), ≤ 6 h = půlden, jinak celé dny (ceil hodin / 24)
//   quote({ db, typeId, fromAt, toAt, qty, accessories })
//                            → { days, unit, units, unitPriceMinor, bikesMinor, accessoriesMinor, totalMinor, feeMinor,
//                                depositMinor, breakdown[] }
//     pásma price_rules.from_qty (1 den, 2–3, 4–6, 7+) se vybírají podle celkového počtu dní; sezóna (tabulka seasons)
//     se vyhodnocuje per den – existuje-li pravidlo se season_id pro daný den, má přednost před pravidlem bez sezóny.
//     Příslušenství (accessories: [{ slug, qty }]) se počítá per den. Poplatek = bike_types.fee_minor × qty,
//     kauce = bike_types.deposit_minor × qty.
//   accessoriesQuote({ db, accessories, days }) → { amountMinor, lines[] }
//   priceTable(db, typeId) → řádky pro ceník (mimo sezónu + každá sezóna) s pásmy a jednotkami hour/halfday
//   fromPrice(db, typeId) → nejnižší denní cena mimo sezónu (haléře) nebo null
// Peníze v haléřích, časy ISO UTC; dny se počítají v kalendáři Europe/Prague.

const { parseJson } = require('../db');
const format = require('../render/format');

const HOUR_MS = 3600 * 1000;
const UNIT_LABELS = Object.freeze({ hour: 'hodina', halfday: 'půlden', day: 'den' });
const TIER_LABELS = Object.freeze({ 1: '1 den', 2: '2–3 dny', 4: '4–6 dní', 7: '7 a více dní' });

class PricingError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'PricingError';
    this.details = details || null;
  }
}

function toDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new PricingError('Neplatný čas termínu.');
  return d;
}

/** Délka pronájmu: jednotka a počet jednotek. */
function lengthOf(fromAt, toAt) {
  const from = toDate(fromAt);
  const to = toDate(toAt);
  const ms = to.getTime() - from.getTime();
  if (ms <= 0) throw new PricingError('Konec pronájmu musí být po jeho začátku.');
  const hours = ms / HOUR_MS;
  if (hours <= 4) return { hours, unit: 'hour', units: Math.max(1, Math.ceil(hours - 1e-9)), days: 1 };
  if (hours <= 6) return { hours, unit: 'halfday', units: 1, days: 1 };
  const days = Math.max(1, Math.ceil(hours / 24 - 1e-9));
  return { hours, unit: 'day', units: days, days };
}

/** Kalendářní dny (YYYY-MM-DD, Praha), které pronájem pokrývá – jeden za každý započatý den. */
function daysOf(fromAt, toAt, days) {
  const first = format.isoDate(toDate(fromAt));
  const [y, m, d] = first.split('-').map(Number);
  const out = [];
  for (let i = 0; i < days; i++) out.push(format.isoDate(new Date(Date.UTC(y, m - 1, d + i, 12))));
  return out;
}

/** Je datum (YYYY-MM-DD) v sezóně? Sezóna může mít plné datum (YYYY-MM-DD) nebo opakující se MM-DD. */
function inSeason(season, dateIso) {
  const from = String(season.date_from || '');
  const to = String(season.date_to || '');
  if (/^\d{2}-\d{2}$/.test(from) && /^\d{2}-\d{2}$/.test(to)) {
    const md = dateIso.slice(5);
    return from <= to ? md >= from && md <= to : md >= from || md <= to; // přes Nový rok
  }
  return dateIso >= from && dateIso <= to;
}

function seasonFor(seasons, dateIso) {
  return seasons.find((s) => inSeason(s, dateIso)) || null;
}

/** Pravidlo pro jednotku a počet dní: největší from_qty ≤ days; nejdřív sezónní, pak bez sezóny. */
function pickRule(rules, { unit, days, seasonId }) {
  const candidates = (sid) =>
    rules
      .filter((r) => r.unit === unit && (r.season_id ?? null) === sid && Number(r.from_qty) <= days)
      .sort((a, b) => Number(b.from_qty) - Number(a.from_qty));
  if (seasonId !== null && seasonId !== undefined) {
    const s = candidates(seasonId);
    if (s.length) return s[0];
  }
  const base = candidates(null);
  return base.length ? base[0] : null;
}

function loadType(db, typeId) {
  const row = db.prepare('SELECT * FROM bike_types WHERE id = ?').get(Number(typeId));
  if (!row) throw new PricingError('Typ kola nebyl nalezen.', { typeId });
  return { ...row, sizes: parseJson(row.sizes, []), photos: parseJson(row.photos, []), specs: parseJson(row.specs, {}) };
}

/** Příslušenství per den. accessories: [{ slug, qty }]. */
function accessoriesQuote({ db, accessories = [], days = 1 }) {
  const lines = [];
  let amountMinor = 0;
  for (const a of accessories || []) {
    const qty = Math.max(0, Math.floor(Number(a.qty) || 0));
    if (!qty || !a.slug) continue;
    const row = db.prepare('SELECT * FROM accessories WHERE slug = ? AND active = 1').get(String(a.slug));
    if (!row) throw new PricingError('Příslušenství není v nabídce.', { slug: String(a.slug) });
    if (qty > Number(row.stock)) throw new PricingError(`Příslušenství „${row.name}“ není k dispozici v požadovaném počtu (skladem ${row.stock}).`, { slug: row.slug });
    const amount = Number(row.price_minor) * qty * days;
    amountMinor += amount;
    lines.push({
      kind: 'accessory',
      slug: row.slug,
      label: row.name,
      qty,
      units: days,
      unit: 'day',
      unitPriceMinor: Number(row.price_minor),
      amountMinor: amount,
    });
  }
  return { amountMinor, lines };
}

/**
 * Cenová nabídka za typ kola a termín.
 * @param {{db: object, typeId: number, fromAt: string|Date, toAt: string|Date, qty?: number, accessories?: Array<{slug: string, qty: number}>}} opts
 */
function quote({ db, typeId, fromAt, toAt, qty = 1, accessories = [] }) {
  const count = Math.floor(Number(qty));
  if (!Number.isFinite(count) || count < 1) throw new PricingError('Počet kol musí být alespoň 1.');
  const type = loadType(db, typeId);
  const len = lengthOf(fromAt, toAt);
  const rules = db.prepare('SELECT * FROM price_rules WHERE bike_type_id = ?').all(type.id);
  if (!rules.length) throw new PricingError(`Pro typ „${type.name}“ není nastaven ceník.`, { typeId: type.id });
  const seasons = db.prepare('SELECT * FROM seasons').all();
  const breakdown = [];
  let bikesMinor = 0;
  let unit = len.unit;
  let units = len.units;
  let unitPriceMinor = null;

  if (len.unit === 'day') {
    // per den: sezóna má přednost; dny se seskupí do souvislých úseků se stejnou cenou
    const dates = daysOf(fromAt, toAt, len.days);
    let segment = null;
    for (const date of dates) {
      const season = seasonFor(seasons, date);
      const rule = pickRule(rules, { unit: 'day', days: len.days, seasonId: season ? season.id : null });
      if (!rule) throw new PricingError(`Pro typ „${type.name}“ chybí denní sazba.`, { typeId: type.id });
      const inSeasonRule = (rule.season_id ?? null) !== null;
      const key = `${rule.id}`;
      if (!segment || segment.key !== key) {
        segment = { key, kind: 'bike', typeId: type.id, label: type.name, qty: count, units: 0, unit: 'day', unitPriceMinor: Number(rule.price_minor), amountMinor: 0, season: inSeasonRule ? season.name : null, tier: Number(rule.from_qty), from: date, to: date };
        breakdown.push(segment);
      }
      segment.units += 1;
      segment.to = date;
      segment.amountMinor = segment.unitPriceMinor * segment.units * count;
    }
    for (const s of breakdown) {
      bikesMinor += s.amountMinor;
      delete s.key;
    }
    unitPriceMinor = breakdown[0].unitPriceMinor;
  } else {
    const firstDay = format.isoDate(toDate(fromAt));
    const season = seasonFor(seasons, firstDay);
    let rule = pickRule(rules, { unit: len.unit, days: 1, seasonId: season ? season.id : null });
    if (!rule) {
      // bez hodinové / půldenní sazby se účtuje jeden den
      rule = pickRule(rules, { unit: 'day', days: 1, seasonId: season ? season.id : null });
      if (!rule) throw new PricingError(`Pro typ „${type.name}“ chybí denní sazba.`, { typeId: type.id });
      unit = 'day';
      units = 1;
    }
    unitPriceMinor = Number(rule.price_minor);
    bikesMinor = unitPriceMinor * units * count;
    breakdown.push({ kind: 'bike', typeId: type.id, label: type.name, qty: count, units, unit, unitPriceMinor, amountMinor: bikesMinor, season: (rule.season_id ?? null) !== null && season ? season.name : null, tier: 1, from: firstDay, to: firstDay });
  }

  const acc = accessoriesQuote({ db, accessories, days: len.days });
  breakdown.push(...acc.lines);
  const feeMinor = Number(type.fee_minor) * count;
  const depositMinor = Number(type.deposit_minor) * count;
  return {
    typeId: type.id,
    typeName: type.name,
    qty: count,
    days: len.days,
    hours: len.hours,
    unit,
    units,
    unitLabel: UNIT_LABELS[unit],
    unitPriceMinor,
    bikesMinor,
    accessoriesMinor: acc.amountMinor,
    totalMinor: bikesMinor + acc.amountMinor,
    feeMinor,
    depositMinor,
    breakdown,
  };
}

/** Nejnižší denní cena mimo sezónu (pro „od … Kč/den“). */
function fromPrice(db, typeId) {
  const row = db.prepare("SELECT MIN(price_minor) AS m FROM price_rules WHERE bike_type_id = ? AND unit = 'day' AND season_id IS NULL").get(Number(typeId));
  return row && row.m !== null ? Number(row.m) : null;
}

/**
 * Tabulka ceníku typu: [{ season: null|{id,name,date_from,date_to}, tiers: { 1: minor, 2: minor, 4: minor, 7: minor }, hour, halfday }]
 * Chybějící sezónní hodnota se nedoplňuje (ceník zobrazí „–“ / převezme základ – řeší volající).
 */
function priceTable(db, typeId) {
  const rules = db.prepare('SELECT * FROM price_rules WHERE bike_type_id = ? ORDER BY season_id, unit, from_qty').all(Number(typeId));
  const seasons = db.prepare('SELECT * FROM seasons ORDER BY date_from').all();
  const groups = new Map();
  const ensure = (sid) => {
    const key = sid === null ? 'base' : String(sid);
    if (!groups.has(key)) groups.set(key, { season: sid === null ? null : seasons.find((s) => s.id === sid) || { id: sid, name: 'Sezóna' }, tiers: {}, hour: null, halfday: null });
    return groups.get(key);
  };
  ensure(null);
  for (const r of rules) {
    const g = ensure(r.season_id ?? null);
    if (r.unit === 'day') g.tiers[Number(r.from_qty)] = Number(r.price_minor);
    else g[r.unit] = Number(r.price_minor);
  }
  return [...groups.values()];
}

/** Sloučí sezóny stejného názvu pro ceník (např. „Hlavní sezóna“ 2026 a 2027 → jeden řádek s více rozsahy). */
function mergeSeasonRows(rows) {
  const out = [];
  for (const r of rows) {
    if (!r.season) {
      out.push({ ...r, ranges: [] });
      continue;
    }
    const same = out.find((o) => o.season && o.season.name === r.season.name && JSON.stringify(o.tiers) === JSON.stringify(r.tiers) && o.hour === r.hour && o.halfday === r.halfday);
    const range = { from: r.season.date_from, to: r.season.date_to };
    if (same) same.ranges.push(range);
    else out.push({ ...r, ranges: [range] });
  }
  return out;
}

module.exports = { quote, lengthOf, daysOf, accessoriesQuote, fromPrice, priceTable, mergeSeasonRows, pickRule, inSeason, seasonFor, loadType, PricingError, UNIT_LABELS, TIER_LABELS };
