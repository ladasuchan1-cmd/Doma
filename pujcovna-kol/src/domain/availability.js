'use strict';
// Dostupnost kol (SPEC kap. 9) + otevírací doba a zavírací dny + převod místního času (Europe/Prague) ↔ UTC.
//   available({ db, typeId, size, fromAt, toAt, settings, excludeReservationId })
//       = počet bikes typu/velikosti se status='available' − počet reservation_items téhož typu a velikosti, jejichž
//         rezervace je ve stavu awaiting_fee | confirmed | checked_out a interval [from_at − buffer, to_at + buffer)
//         se překrývá s [fromAt, toAt). buffer = settings.bufferMinutes (výchozí 60).
//   availabilityMap({ db, fromAt, toAt, settings, typeId? }) → { [typeId]: { [size]: n } } pro aktivní typy
//   assertAvailable({ db, items, fromAt, toAt, settings }) – kontrola všech položek [{ typeId, size, qty }] najednou;
//       při nedostatku vyhodí AvailabilityError („Kolo mezitím někdo rezervoval“). Volat uvnitř transaction(db, …)
//       (BEGIN IMMEDIATE) těsně před INSERTem – SQLite má jediného zapisovatele, dvě souběžné rezervace posledního
//       kola tak nemohou projít obě.
//   Otevírací doba: effectiveOpeningHours(tenant, settings) → { mon: ['09:00','18:00'] | null, … } – výchozí z tenant.json
//       přepsaná hodnotami z adminu (settings.openingHours; null = zavřeno); openingHoursFor(tenant, dateIso, settings)
//       → ['09:00','18:00'] | null; isClosedDay(db, tenant, dateIso, settings); blockedDates({ db, tenant, settings, from, to })
//       → ['YYYY-MM-DD', …] pro kalendář; timeSlots(open, close, step); allTimeSlots(tenant, { settings, stepMinutes });
//       validateRange({ db, tenant, settings, fromAt, toAt, now }) → { ok, errors }
//   Čas: localToUtc('2026-07-12', '09:00') → Date (UTC) podle Prahy; utcToLocal(iso) → { date, time, dayKey }.
// Vstupy: db tenanta, tenant (openingHours), settings (openingHours, bufferMinutes, maxRentalDays), časy ISO UTC.
// Parametr settings je všude volitelný – bez něj platí jen tenant.openingHours (zpětně kompatibilní).

const format = require('../render/format');

const BLOCKING_STATES = Object.freeze(['awaiting_fee', 'confirmed', 'checked_out']);
const DEFAULT_BUFFER_MINUTES = 60;
const DEFAULT_MAX_RENTAL_DAYS = 30;
const SLOT_MINUTES = 30;
const DAY_MS = 24 * 3600 * 1000;

class AvailabilityError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'AvailabilityError';
    this.details = details || null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Čas: Praha ↔ UTC

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: format.TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});

/** Části okamžiku v pražském čase: { date: 'YYYY-MM-DD', time: 'HH:MM', dayKey: 'mon'…'sun', minutes } */
function utcToLocal(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const parts = partsFormatter.formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  const hour = get('hour') === '24' ? '00' : get('hour');
  const weekday = get('weekday').toLowerCase().slice(0, 3);
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${hour}:${get('minute')}`, dayKey: weekday, minutes: Number(hour) * 60 + Number(get('minute')) };
}

/** Posun Prahy vůči UTC v minutách v daném okamžiku. */
function offsetMinutesAt(utcMs) {
  const local = utcToLocal(new Date(utcMs));
  const [y, m, d] = local.date.split('-').map(Number);
  const [hh, mm] = local.time.split(':').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, hh, mm, 0);
  return Math.round((asUtc - Math.floor(utcMs / 60000) * 60000) / 60000);
}

/** Místní datum + čas (Praha) → Date v UTC. Neexistující čas při přechodu na letní čas se posune o hodinu dál. */
function localToUtc(dateIso, timeHHMM = '00:00') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateIso))) throw new AvailabilityError('Neplatné datum.');
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(timeHHMM));
  if (!t) throw new AvailabilityError('Neplatný čas.');
  const [y, m, d] = String(dateIso).split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31 || new Date(Date.UTC(y, m - 1, d)).getUTCMonth() !== m - 1) throw new AvailabilityError('Neplatné datum.');
  const hh = Number(t[1]);
  const mm = Number(t[2]);
  if (hh > 23 || mm > 59) throw new AvailabilityError('Neplatný čas.');
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  let guess = naive - offsetMinutesAt(naive) * 60000;
  guess = naive - offsetMinutesAt(guess) * 60000; // druhá iterace kvůli hranici DST
  return new Date(guess);
}

/** Přičte dny ke dni YYYY-MM-DD (kalendářně, bez DST problémů). */
function addDays(dateIso, n) {
  const [y, m, d] = String(dateIso).split('-').map(Number);
  return format.isoDate(new Date(Date.UTC(y, m - 1, d + n, 12)));
}

// ---------------------------------------------------------------------------------------------------------
// Otevírací doba a zavírací dny

/** Platný zápis dne: ['HH:MM', 'HH:MM'] s neprázdnými hodnotami; cokoli jiného (null, [], chybí) = zavřeno. */
function normalizeDay(v) {
  return Array.isArray(v) && v.length === 2 && v[0] && v[1] ? [String(v[0]), String(v[1])] : null;
}

/**
 * Efektivní otevírací doba: tenant.openingHours (výchozí z tenant.json) přepsaná klíči ze settings.openingHours
 * (admin → Nastavení; `null` u dne = zavřeno). Vrací { mon: ['09:00','18:00'] | null, …, sun } pro všech 7 dní.
 */
function effectiveOpeningHours(tenant, settings) {
  const base = tenant && tenant.openingHours && typeof tenant.openingHours === 'object' ? tenant.openingHours : {};
  const over = settings && settings.openingHours && typeof settings.openingHours === 'object' ? settings.openingHours : {};
  const out = {};
  for (const key of format.DAY_KEYS) out[key] = normalizeDay(Object.hasOwn(over, key) ? over[key] : base[key]);
  return out;
}

/** Otevírací doba pro den (['09:00','18:00']) nebo null (zavřeno / nenastaveno). */
function openingHoursFor(tenant, dateIso, settings) {
  const key = format.dayKey(dateIso);
  return key ? effectiveOpeningHours(tenant, settings)[key] : null;
}

/** Zavírací dny (tabulka closures): plná data YYYY-MM-DD nebo opakující se MM-DD. */
function closureFor(db, dateIso) {
  const rows = db.prepare('SELECT * FROM closures').all();
  for (const c of rows) {
    const from = String(c.date_from || '');
    const to = String(c.date_to || from);
    if (/^\d{2}-\d{2}$/.test(from)) {
      const md = dateIso.slice(5);
      const hit = from <= to ? md >= from && md <= to : md >= from || md <= to;
      if (hit) return c;
    } else if (dateIso >= from && dateIso <= to) return c;
  }
  return null;
}

/** Je den zavřený (zavírací den, nebo bez otevírací doby)? Vrací { closed, reason } */
function closedInfo(db, tenant, dateIso, settings) {
  const closure = closureFor(db, dateIso);
  if (closure) return { closed: true, reason: closure.reason || 'Zavřeno' };
  if (!openingHoursFor(tenant, dateIso, settings)) return { closed: true, reason: 'Zavírací den' };
  return { closed: false, reason: null };
}

function isClosedDay(db, tenant, dateIso, settings) {
  return closedInfo(db, tenant, dateIso, settings).closed;
}

/** Seznam zavřených dní v rozsahu (výchozí dnes … +365 dní) – pro data-blocked kalendáře. */
function blockedDates({ db, tenant, settings, from, to, now = new Date() }) {
  const start = from || format.isoDate(now);
  const end = to || addDays(start, 365);
  const hours = effectiveOpeningHours(tenant, settings);
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const key = format.dayKey(d);
    if (closureFor(db, d) || !key || !hours[key]) out.push(d);
  }
  return out;
}

/** Půlhodinové sloty mezi open a close včetně (['09:00', '09:30', …, '18:00']). */
function timeSlots(open, close, stepMinutes = SLOT_MINUTES) {
  const toMin = (s) => {
    const [h, m] = String(s).split(':').map(Number);
    return h * 60 + m;
  };
  const a = toMin(open);
  const b = toMin(close);
  const out = [];
  for (let t = a; t <= b; t += stepMinutes) out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  return out;
}

/**
 * Všechny sloty napříč týdnem (sjednocení otevíracích dob) – pro select bez znalosti data.
 * Druhý parametr: číslo (krok v minutách, zpětně kompatibilní) nebo { settings, stepMinutes }.
 */
function allTimeSlots(tenant, opts) {
  const o = typeof opts === 'number' ? { stepMinutes: opts } : opts || {};
  const stepMinutes = Number(o.stepMinutes) > 0 ? Number(o.stepMinutes) : SLOT_MINUTES;
  const hours = effectiveOpeningHours(tenant, o.settings);
  const set = new Set();
  for (const key of format.DAY_KEYS) {
    const v = hours[key];
    if (v) for (const s of timeSlots(v[0], v[1], stepMinutes)) set.add(s);
  }
  return [...set].sort();
}

/** Je okamžik v otevírací době dne (včetně krajních časů)? */
function isWithinOpening(tenant, local, settings) {
  const hours = openingHoursFor(tenant, local.date, settings);
  if (!hours) return false;
  const toMin = (s) => {
    const [h, m] = String(s).split(':').map(Number);
    return h * 60 + m;
  };
  return local.minutes >= toMin(hours[0]) && local.minutes <= toMin(hours[1]);
}

/**
 * Validace termínu: začátek v budoucnu, konec po začátku, oba v otevírací době otevřeného dne, max. délka.
 * @returns {{ ok: boolean, errors: { od?: string, do?: string, obecne?: string }, fromAt?: Date, toAt?: Date }}
 */
function validateRange({ db, tenant, settings = {}, fromAt, toAt, now = new Date() }) {
  const errors = {};
  const from = fromAt instanceof Date ? fromAt : new Date(fromAt);
  const to = toAt instanceof Date ? toAt : new Date(toAt);
  if (Number.isNaN(from.getTime())) errors.od = 'Zadejte prosím datum a čas vyzvednutí.';
  if (Number.isNaN(to.getTime())) errors.do = 'Zadejte prosím datum a čas vrácení.';
  if (Object.keys(errors).length) return { ok: false, errors };
  if (from.getTime() < now.getTime() - 60000) errors.od = 'Termín vyzvednutí už uplynul. Vyberte prosím pozdější čas.';
  if (to.getTime() <= from.getTime()) errors.do = 'Vrácení musí být po vyzvednutí.';
  const maxDays = Number(settings.maxRentalDays) > 0 ? Number(settings.maxRentalDays) : DEFAULT_MAX_RENTAL_DAYS;
  if (to.getTime() - from.getTime() > maxDays * DAY_MS) errors.do = `Nejdelší pronájem online je ${format.plural(maxDays, 'den', 'dny', 'dní')}. Pro delší termín nás prosím kontaktujte.`;
  const lf = utcToLocal(from);
  const lt = utcToLocal(to);
  if (!errors.od) {
    const ci = closedInfo(db, tenant, lf.date, settings);
    if (ci.closed) errors.od = `${format.date(lf.date)} máme zavřeno (${ci.reason}). Vyberte prosím jiný den vyzvednutí.`;
    else if (!isWithinOpening(tenant, lf, settings)) {
      const h = openingHoursFor(tenant, lf.date, settings);
      errors.od = `Vyzvednutí je možné jen v otevírací době (${format.date(lf.date)}: ${h[0]}–${h[1]}).`;
    }
  }
  if (!errors.do) {
    const ci = closedInfo(db, tenant, lt.date, settings);
    if (ci.closed) errors.do = `${format.date(lt.date)} máme zavřeno (${ci.reason}). Vyberte prosím jiný den vrácení.`;
    else if (!isWithinOpening(tenant, lt, settings)) {
      const h = openingHoursFor(tenant, lt.date, settings);
      errors.do = `Vrácení je možné jen v otevírací době (${format.date(lt.date)}: ${h[0]}–${h[1]}).`;
    }
  }
  return { ok: !Object.keys(errors).length, errors, fromAt: from, toAt: to };
}

/**
 * Termín z formulářových hodnot: od/do (YYYY-MM-DD) + volitelné časy HH:MM; bez času se použije otevírací doba
 * (začátek dne vyzvednutí, konec dne vrácení; zavřený den → 09:00 / 18:00). Vrací { fromAt, toAt, od, do, odCas, doCas }
 * nebo null při neplatném vstupu. settings (volitelné) = otevírací doba z adminu.
 */
function termFromDates({ tenant, settings, od, do: doDate, odCas, doCas }) {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const timeRe = /^\d{2}:\d{2}$/;
  if (!dateRe.test(String(od || '')) || !dateRe.test(String(doDate || ''))) return null;
  const hoursFrom = openingHoursFor(tenant, od, settings) || ['09:00', '18:00'];
  const hoursTo = openingHoursFor(tenant, doDate, settings) || ['09:00', '18:00'];
  const tFrom = timeRe.test(String(odCas || '')) ? odCas : hoursFrom[0];
  const tTo = timeRe.test(String(doCas || '')) ? doCas : hoursTo[1];
  try {
    const fromAt = localToUtc(od, tFrom);
    const toAt = localToUtc(doDate, tTo);
    if (!(toAt > fromAt)) return null;
    return { fromAt, toAt, od, do: doDate, odCas: tFrom, doCas: tTo };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Dostupnost

function bufferMs(settings) {
  const min = settings && Number.isFinite(Number(settings.bufferMinutes)) ? Number(settings.bufferMinutes) : DEFAULT_BUFFER_MINUTES;
  return Math.max(0, min) * 60000;
}

function iso(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new AvailabilityError('Neplatný čas termínu.');
  return d.toISOString();
}

/** Hranice překryvu rozšířené o buffer: existující [r.from − b, r.to + b) ∩ [from, to) ≠ ∅ ⇔ r.from < to + b ∧ r.to > from − b */
function overlapBounds(fromAt, toAt, settings) {
  const b = bufferMs(settings);
  const from = new Date(fromAt).getTime();
  const to = new Date(toAt).getTime();
  if (!(to > from)) throw new AvailabilityError('Konec termínu musí být po začátku.');
  return { toPlus: new Date(to + b).toISOString(), fromMinus: new Date(from - b).toISOString() };
}

const STATES_SQL = BLOCKING_STATES.map((s) => `'${s}'`).join(', ');

/** Počet volných kol daného typu a velikosti v termínu. */
function available({ db, typeId, size, fromAt, toAt, settings = {}, excludeReservationId = null }) {
  const total = db.prepare("SELECT COUNT(*) AS n FROM bikes WHERE bike_type_id = ? AND size = ? AND status = 'available'").get(Number(typeId), String(size)).n;
  if (!total) return 0;
  const { toPlus, fromMinus } = overlapBounds(iso(fromAt), iso(toAt), settings);
  const busy = db
    .prepare(
      `SELECT COUNT(*) AS n FROM reservation_items i JOIN reservations r ON r.id = i.reservation_id
       WHERE i.bike_type_id = ? AND i.size = ? AND r.status IN (${STATES_SQL}) AND r.from_at < ? AND r.to_at > ? AND (? IS NULL OR r.id != ?)`
    )
    .get(Number(typeId), String(size), toPlus, fromMinus, excludeReservationId, excludeReservationId).n;
  return Math.max(0, Number(total) - Number(busy));
}

/** Mapa dostupnosti { [typeId]: { [size]: n } } pro aktivní typy (nebo jeden typ). Velikosti bez kusů mají 0. */
function availabilityMap({ db, fromAt, toAt, settings = {}, typeId = null, excludeReservationId = null }) {
  const { toPlus, fromMinus } = overlapBounds(iso(fromAt), iso(toAt), settings);
  const types = db.prepare(`SELECT id, sizes FROM bike_types WHERE active = 1 ${typeId ? 'AND id = ?' : ''}`).all(...(typeId ? [Number(typeId)] : []));
  const totals = db.prepare("SELECT bike_type_id, size, COUNT(*) AS n FROM bikes WHERE status = 'available' GROUP BY bike_type_id, size").all();
  const busy = db
    .prepare(
      `SELECT i.bike_type_id, i.size, COUNT(*) AS n FROM reservation_items i JOIN reservations r ON r.id = i.reservation_id
       WHERE r.status IN (${STATES_SQL}) AND r.from_at < ? AND r.to_at > ? AND (? IS NULL OR r.id != ?) GROUP BY i.bike_type_id, i.size`
    )
    .all(toPlus, fromMinus, excludeReservationId, excludeReservationId);
  const out = {};
  for (const t of types) {
    out[t.id] = {};
    let sizes = [];
    try {
      sizes = JSON.parse(t.sizes || '[]');
    } catch {
      sizes = [];
    }
    for (const s of sizes) out[t.id][s] = 0;
  }
  for (const row of totals) {
    if (!out[row.bike_type_id]) continue;
    out[row.bike_type_id][row.size] = Number(row.n);
  }
  for (const row of busy) {
    if (!out[row.bike_type_id] || out[row.bike_type_id][row.size] === undefined) continue;
    out[row.bike_type_id][row.size] = Math.max(0, out[row.bike_type_id][row.size] - Number(row.n));
  }
  return out;
}

/**
 * Ověří, že všechny položky [{ typeId, size, qty }] jsou dostupné (součet qty stejného typu+velikosti).
 * Vyhodí AvailabilityError s details { typeId, size, requested, available }.
 */
function assertAvailable({ db, items, fromAt, toAt, settings = {}, excludeReservationId = null }) {
  const wanted = new Map();
  for (const it of items || []) {
    const qty = Math.floor(Number(it.qty));
    if (!qty || qty < 1) continue;
    const key = `${Number(it.typeId)}|${String(it.size)}`;
    wanted.set(key, (wanted.get(key) || 0) + qty);
  }
  if (!wanted.size) throw new AvailabilityError('Vyberte prosím alespoň jedno kolo.');
  for (const [key, qty] of wanted) {
    const [typeId, size] = key.split('|');
    const n = available({ db, typeId: Number(typeId), size, fromAt, toAt, settings, excludeReservationId });
    if (n < qty) {
      throw new AvailabilityError('Kolo mezitím někdo rezervoval. Vyberte prosím jiný termín, velikost nebo počet.', { typeId: Number(typeId), size, requested: qty, available: n });
    }
  }
  return true;
}

module.exports = {
  BLOCKING_STATES,
  DEFAULT_BUFFER_MINUTES,
  DEFAULT_MAX_RENTAL_DAYS,
  SLOT_MINUTES,
  AvailabilityError,
  utcToLocal,
  localToUtc,
  addDays,
  effectiveOpeningHours,
  openingHoursFor,
  closureFor,
  closedInfo,
  isClosedDay,
  blockedDates,
  timeSlots,
  allTimeSlots,
  isWithinOpening,
  validateRange,
  termFromDates,
  bufferMs,
  available,
  availabilityMap,
  assertAvailable,
};
