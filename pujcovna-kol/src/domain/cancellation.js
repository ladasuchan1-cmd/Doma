'use strict';
// Storno engine (SPEC kap. 9, rozhodnutí zadavatele 2): jediná lhůta per půjčovna – settings.cancellation.freeHoursBefore
// (výchozí 48 h). Zrušení zákazníkem nejméně `freeHoursBefore` hodin před začátkem → vrácení celého zaplaceného
// poplatku; později (nebo nevyzvednutí) → celý propadá (ledger fee_forfeited zapisuje reservations.transition).
// Zrušení ze strany půjčovny → vždy plná vratka.
//   quote({ reservation, now, settings })      → { hoursBefore, refundMinor, forfeitMinor, rule: 'free'|'forfeit', freeHoursBefore,
//                                                  deadlineAt, paidMinor }
//   operatorQuote({ reservation })              → { refundMinor: paid, forfeitMinor: 0, rule: 'operator' }
//   describe(q)                                 → česká věta pro UI / e-mail
// Vstup: řádek reservations (from_at ISO, paid_minor), now (Date|ISO), settings. Peníze v haléřích.

const format = require('../render/format');

const DEFAULT_FREE_HOURS = 48;
const HOUR_MS = 3600 * 1000;

function freeHours(settings) {
  const v = settings && settings.cancellation ? Number(settings.cancellation.freeHoursBefore) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_FREE_HOURS;
}

/** Výpočet storna zákazníkem. */
function quote({ reservation, now = new Date(), settings = {} }) {
  if (!reservation || !reservation.from_at) throw new Error('Pro výpočet storna chybí rezervace.');
  const from = new Date(reservation.from_at).getTime();
  const at = (now instanceof Date ? now : new Date(now)).getTime();
  if (Number.isNaN(from) || Number.isNaN(at)) throw new Error('Neplatný čas pro výpočet storna.');
  const limit = freeHours(settings);
  const hoursBefore = (from - at) / HOUR_MS;
  const paidMinor = Math.max(0, Number(reservation.paid_minor) || 0);
  const free = hoursBefore >= limit;
  return {
    rule: free ? 'free' : 'forfeit',
    hoursBefore: Math.round(hoursBefore * 100) / 100,
    freeHoursBefore: limit,
    deadlineAt: new Date(from - limit * HOUR_MS).toISOString(),
    paidMinor,
    refundMinor: free ? paidMinor : 0,
    forfeitMinor: free ? 0 : paidMinor,
  };
}

/** Zrušení půjčovnou – vždy plná vratka. */
function operatorQuote({ reservation }) {
  const paidMinor = Math.max(0, Number(reservation.paid_minor) || 0);
  return { rule: 'operator', hoursBefore: null, freeHoursBefore: null, deadlineAt: null, paidMinor, refundMinor: paidMinor, forfeitMinor: 0 };
}

/** Lidsky čitelný popis výsledku. */
function describe(q) {
  if (q.rule === 'operator') return q.refundMinor > 0 ? `Rezervaci zrušila půjčovna – vracíme celý zaplacený poplatek ${format.money(q.refundMinor)}.` : 'Rezervaci zrušila půjčovna. Poplatek nebyl uhrazen, nic se nevrací.';
  if (q.paidMinor === 0) return `Poplatek zatím nebyl uhrazen – zrušení je bez poplatku.`;
  if (q.rule === 'free') return `Rušíte nejméně ${q.freeHoursBefore} hodin před začátkem – vracíme celý rezervační poplatek ${format.money(q.refundMinor)}.`;
  return `Rušíte méně než ${q.freeHoursBefore} hodin před začátkem (lhůta uplynula ${format.dateTime(q.deadlineAt)}) – rezervační poplatek ${format.money(q.forfeitMinor)} propadá jako úplata za zajištění termínu.`;
}

/** Krátký popis pravidla pro ceník / podmínky. */
function ruleText(settings) {
  const h = freeHours(settings);
  return `Zrušení nejméně ${h} hodin před začátkem pronájmu: vracíme celý rezervační poplatek. Pozdější zrušení nebo nevyzvednutí: poplatek propadá. Při řádném využití se poplatek započítá na nájemné.`;
}

module.exports = { quote, operatorQuote, describe, ruleText, freeHours, DEFAULT_FREE_HOURS };
