'use strict';
// Bankovní převod (SPEC kap. 10, rešerše docs/vyzkum/02-platby-cr.md kap. 1): české číslo účtu → IBAN, řetězec
// QR Platby (SPAYD) a QR kód jako SVG přes vendorovaný qrcode-generator (ECC M).
//   ibanFromCzAccount('19-2000145399/0800') → 'CZ6508000000192000145399'  (prefix-číslo/kód banky, kontrola mod 97)
//   validateIban(iban) → true/false (ISO 13616 mod 97 == 1, bez mezer, velká písmena)
//   spayd({ iban, amountMinor, vs, msg, dueDate, ss, ks, bic }) → 'SPD*1.0*ACC:…*AM:450.00*CC:CZK*X-VS:…*MSG:…*DT:YYYYMMDD'
//       MSG bez diakritiky, velkými písmeny, max 60 znaků, hvězdička → %2A; AM s tečkou a 2 desetinnými místy; DT z ISO data.
//   parseSpayd(str) → { version, ACC, AM, CC, 'X-VS', MSG, DT, … } (pro testy a admin)
//   qrSvg(payload, { cellSize, margin }) → string '<svg …>' bez inline stylů (atributy fill/stroke), třída qr-svg
//   isAlphanumeric(str) → vejde se do znakové sady QR Alphanumeric (menší kód)?
// Vstup: peníze v haléřích. Výstup: čisté řetězce (bez HTML escapování – volající vkládá přes html``/raw()).

const qrcode = require('../vendor/qrcode');

const SPAYD_VERSION = '1.0';
const MSG_MAX = 60;
const ALNUM_RE = /^[0-9A-Z $%*+\-./:]*$/;

function digitsOnly(s) {
  return String(s ?? '').replace(/\D/g, '');
}

/** Zbytek po dělení 97 pro dlouhé číselné řetězce (po částech). */
function mod97(numeric) {
  let rem = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    rem = Number(String(rem) + numeric.slice(i, i + 7)) % 97;
  }
  return rem;
}

/** Písmena → číslice (A=10 … Z=35) pro výpočet IBAN. */
function lettersToDigits(s) {
  return String(s)
    .toUpperCase()
    .replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
}

/**
 * Převede české číslo účtu („předčíslí-číslo/kód banky“, předčíslí volitelné) na IBAN.
 * @param {string} account např. '19-2000145399/0800' nebo '2000145399/0800'
 */
function ibanFromCzAccount(account) {
  const m = /^\s*(?:(\d{1,6})\s*-\s*)?(\d{1,10})\s*\/\s*(\d{4})\s*$/.exec(String(account ?? ''));
  if (!m) throw new Error(`Neplatné číslo účtu „${account}“ – očekávám předčíslí-číslo/kód banky.`);
  const prefix = m[1] || '0';
  const number = m[2];
  const bank = m[3];
  if (!czWeightOk(prefix, [10, 5, 8, 4, 2, 1]) || !czWeightOk(number, [6, 3, 7, 9, 10, 5, 8, 4, 2, 1])) {
    throw new Error(`Číslo účtu „${account}“ neprošlo kontrolou modulo 11.`);
  }
  const bban = bank + prefix.padStart(6, '0') + number.padStart(10, '0');
  const check = 98 - mod97(bban + lettersToDigits('CZ') + '00');
  return `CZ${String(check).padStart(2, '0')}${bban}`;
}

/** Kontrola modulo 11 českých čísel účtů (váhy zprava). */
function czWeightOk(part, weights) {
  const padded = part.padStart(weights.length, '0');
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += Number(padded[i]) * weights[i];
  return sum % 11 === 0;
}

/** Ověří IBAN (délka 15–34, jen A–Z0–9, mod 97 == 1). */
function validateIban(iban) {
  const s = String(iban ?? '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  return mod97(lettersToDigits(s.slice(4) + s.slice(0, 4))) === 1;
}

/** Odstraní diakritiku a znaky mimo bezpečnou sadu, velká písmena, max délka. */
function sanitizeMsg(msg, max = MSG_MAX) {
  const ascii = String(msg ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '')
    .toUpperCase()
    .replace(/\*/g, '%2A')
    .replace(/\s+/g, ' ')
    .trim();
  return ascii.length > max ? ascii.slice(0, max).trim() : ascii;
}

/** Datum (ISO řetězec / Date) → YYYYMMDD (v Europe/Prague). */
function spaydDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}${get('month')}${get('day')}`;
}

/**
 * Sestaví řetězec SPAYD podle specifikace ČBA (qr-platba.cz).
 * @param {{iban: string, amountMinor: number, vs?: string|number, msg?: string, dueDate?: string|Date, ss?: string, ks?: string, bic?: string}} p
 */
function spayd({ iban, amountMinor, vs, msg, dueDate, ss, ks, bic } = {}) {
  const acc = String(iban ?? '').replace(/\s+/g, '').toUpperCase();
  if (!validateIban(acc)) throw new Error('SPAYD: neplatný IBAN.');
  const amount = Math.round(Number(amountMinor));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('SPAYD: částka musí být kladná (haléře).');
  const parts = [`SPD*${SPAYD_VERSION}`, `ACC:${acc}${bic ? `+${String(bic).toUpperCase()}` : ''}`, `AM:${(amount / 100).toFixed(2)}`, 'CC:CZK'];
  const vsDigits = digitsOnly(vs);
  if (vsDigits) {
    if (vsDigits.length > 10) throw new Error('SPAYD: variabilní symbol má nejvýše 10 číslic.');
    parts.push(`X-VS:${vsDigits}`);
  }
  const ssDigits = digitsOnly(ss);
  if (ssDigits) parts.push(`X-SS:${ssDigits.slice(0, 10)}`);
  const ksDigits = digitsOnly(ks);
  if (ksDigits) parts.push(`X-KS:${ksDigits.slice(0, 10)}`);
  const message = sanitizeMsg(msg);
  if (message) parts.push(`MSG:${message}`);
  const dt = dueDate ? spaydDate(dueDate) : null;
  if (dt) parts.push(`DT:${dt}`);
  return parts.join('*');
}

/** Rozloží SPAYD řetězec na objekt (klíče jako v specifikaci, version). */
function parseSpayd(str) {
  const s = String(str ?? '');
  if (!s.startsWith('SPD*')) throw new Error('Nejde o SPAYD řetězec.');
  const parts = s.split('*');
  const out = { version: parts[1] };
  for (const p of parts.slice(2)) {
    const i = p.indexOf(':');
    if (i <= 0) continue;
    out[p.slice(0, i)] = p.slice(i + 1).replace(/%2A/g, '*');
  }
  return out;
}

function isAlphanumeric(str) {
  return ALNUM_RE.test(String(str));
}

/**
 * QR kód jako SVG (ECC M). Režim Alphanumeric, vejde-li se payload do jeho sady (menší kód), jinak Byte.
 * Výstup je čistý <svg> s viewBox (škálovatelný), bez inline stylů; třída qr-svg.
 */
function qrSvg(payload, { cellSize = 4, margin = 16, scalable = true } = {}) {
  const data = String(payload ?? '');
  if (!data) throw new Error('QR: prázdný obsah.');
  const qr = qrcode(0, 'M');
  qr.addData(data, isAlphanumeric(data) ? 'Alphanumeric' : 'Byte');
  qr.make();
  const svg = qr.createSvgTag({ cellSize, margin, scalable });
  return svg.replace('<svg ', '<svg class="qr-svg" shape-rendering="crispEdges" ').replace(/\s+>/g, '>');
}

module.exports = { ibanFromCzAccount, validateIban, spayd, parseSpayd, qrSvg, sanitizeMsg, spaydDate, isAlphanumeric, mod97, SPAYD_VERSION, MSG_MAX };
