'use strict';
// Formátování pro UI (česky, Europe/Prague): peníze z haléřů, data, časy, délky, otevírací doba.
// Vstup: haléře (integer), ISO řetězce / Date, km. Výstup: řetězce („390 Kč“, „12. 7. 2026“, „8:30“, „12,5 km“).

const TZ = 'Europe/Prague';
const LOCALE = 'cs-CZ';

const NBSP = ' ';
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS = { mon: 'Po', tue: 'Út', wed: 'St', thu: 'Čt', fri: 'Pá', sat: 'So', sun: 'Ne' };
const DAY_LABELS_LONG = { mon: 'pondělí', tue: 'úterý', wed: 'středa', thu: 'čtvrtek', fri: 'pátek', sat: 'sobota', sun: 'neděle' };

const numberWhole = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const numberTwo = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numberOne = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 0, maximumFractionDigits: 1 });

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    // „YYYY-MM-DD“ ber jako kalendářní den v Praze (ne UTC půlnoc)
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T12:00:00+02:00`);
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Peníze z haléřů: 39000 → „390 Kč“, 39050 → „390,50 Kč“, záporné „−50 Kč“. */
function money(minor, { unit = '' } = {}) {
  const n = Number(minor);
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  const whole = abs % 100 === 0;
  const txt = (whole ? numberWhole : numberTwo).format(abs / 100);
  return `${n < 0 ? '−' : ''}${txt}${NBSP}Kč${unit ? `${NBSP}/ ${unit}` : ''}`;
}

/** Datum „12. 7. 2026“. */
function date(value) {
  const d = toDate(value);
  if (!d) return '';
  return new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, day: 'numeric', month: 'numeric', year: 'numeric' }).format(d);
}

/** Datum slovy „12. července 2026“. */
function dateLong(value) {
  const d = toDate(value);
  if (!d) return '';
  return new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

/** Čas „8:30“. */
function time(value) {
  const d = toDate(value);
  if (!d) return '';
  return new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(d);
}

/** Datum a čas „12. 7. 2026 8:30“. */
function dateTime(value) {
  const d = toDate(value);
  if (!d) return '';
  return `${date(d)} ${time(d)}`;
}

/** Rozsah „12. 7. – 14. 7. 2026“ (stejný den → jen datum; s časy, pokud withTime). */
function dateRange(from, to, { withTime = false } = {}) {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return '';
  if (withTime) return `${dateTime(a)} – ${dateTime(b)}`;
  if (date(a) === date(b)) return date(a);
  const dayMonth = new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, day: 'numeric', month: 'numeric' });
  return `${dayMonth.format(a)} – ${date(b)}`;
}

/** Vzdálenost „12,5 km“ / „850 m“. */
function km(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (n < 1) return `${numberWhole.format(Math.round(n * 1000))}${NBSP}m`;
  return `${numberOne.format(n)}${NBSP}km`;
}

/** Číslo s českými oddělovači. */
function number(value, fractionDigits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return new Intl.NumberFormat(LOCALE, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(n);
}

/** Procenta „15 %“. */
function percent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return `${numberOne.format(n)}${NBSP}%`;
}

/** Skloňování: plural(3, 'den', 'dny', 'dní') → „3 dny“. */
function plural(n, one, few, many) {
  const a = Math.abs(Number(n));
  const word = a === 1 ? one : a >= 2 && a <= 4 ? few : many;
  return `${numberWhole.format(n)}${NBSP}${word}`;
}

/** Klíč dne v týdnu (mon…sun) pro datum v Praze. */
function dayKey(value) {
  const d = toDate(value);
  if (!d) return null;
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d).toLowerCase();
  return DAY_KEYS.includes(name) ? name : null;
}

/**
 * Otevírací doba sloučená do řádků: { mon: ['09:00','18:00'], … } →
 * [{ days: 'Po–Pá', hours: '9:00–18:00' }, { days: 'So–Ne', hours: '8:00–19:00' }, { days: 'St', hours: 'zavřeno' }]
 */
function openingHoursRows(openingHours = {}) {
  const fmt = (h) => (h ? h.replace(/^0(\d:)/, '$1') : '');
  const hoursText = (v) => (Array.isArray(v) && v.length === 2 && v[0] && v[1] ? `${fmt(v[0])}–${fmt(v[1])}` : 'zavřeno');
  const rows = [];
  for (const key of DAY_KEYS) {
    const text = hoursText(openingHours[key]);
    const last = rows[rows.length - 1];
    if (last && last.hours === text) {
      last.to = key;
    } else {
      rows.push({ from: key, to: key, hours: text });
    }
  }
  return rows.map((r) => ({ days: r.from === r.to ? DAY_LABELS[r.from] : `${DAY_LABELS[r.from]}–${DAY_LABELS[r.to]}`, hours: r.hours }));
}

/** „YYYY-MM-DD“ pro datum v Praze (pro <input type=date>). */
function isoDate(value) {
  const d = toDate(value);
  if (!d) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

module.exports = {
  TZ,
  LOCALE,
  NBSP,
  DAY_KEYS,
  DAY_LABELS,
  DAY_LABELS_LONG,
  money,
  date,
  dateLong,
  time,
  dateTime,
  dateRange,
  km,
  number,
  percent,
  plural,
  dayKey,
  openingHoursRows,
  isoDate,
  toDate,
};
