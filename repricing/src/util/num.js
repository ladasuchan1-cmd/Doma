'use strict';
// Čísla a peníze: parsování českých/anglických formátů a zaokrouhlení.

/**
 * Převede „12 990 Kč“, „12.990,-“, „12,990.00“, „1234.00 CZK“, „12 990,50“, 12990 → číslo.
 *
 * Heuristika bez vynuceného oddělovače (jediný oddělovač v čísle):
 *  - „12.990“ (tečka + přesně 3 číslice) = tisíce (české exporty) – jen pokud dotThousands !== false; XML a JSON
 *    (xsd:double) mají tečku vždy desetinnou, tam se volá s dotThousands: false („1299.000“ = 1299, ne 1 299 000),
 *  - „1,234“ = tisíce – jen pokud commaThousands !== false; český CSV (oddělovač „;“) má čárku vždy desetinnou
 *    („123,456“ = 123,456 – nákupní ceny přepočtené z EUR mívají 3 desetinná místa),
 *  - skupina tisíců nikdy nezačíná nulou: „0,125“ = 0,125 a „0.999“ = 0,999.
 * Měna: „Kč“ a „CZK“ se odstraní; jiná měna (EUR, €, $, USD) = null – cenu v cizí měně nelze tiše brát jako Kč.
 * @param {*} v vstup
 * @param {{decimal?: ','|'.', dotThousands?: boolean, commaThousands?: boolean}} [opts] decimal = vynucený desetinný
 *   oddělovač (jinak heuristika)
 * @returns {number|null}
 */
function parseNumber(v, opts = {}) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return null;
  let s = String(v).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  // odstranit měnu Kč/CZK, mezery (vč. NBSP a úzkých mezer), apostrofy, koncové ",-" / ".-";
  // EUR / € / $ / USD se neodstraňují → hodnota v cizí měně není číslo (money-13)
  s = s
    .replace(/[   \s']/g, '')
    .replace(/(kč|czk|%|,-|\.-|–|—)$/gi, '')
    .replace(/^(kč|czk)/gi, '')
    .replace(/,-$|\.-$/, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (/e[+-]?\d+$/i.test(s) && /^\d+(\.\d+)?e[+-]?\d+$/i.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? (negative ? -n : n) : null;
  }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let dec = null;
  if (opts.decimal === ',' || opts.decimal === '.') {
    dec = opts.decimal;
  } else if (lastComma >= 0 && lastDot >= 0) {
    dec = lastComma > lastDot ? ',' : '.';
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    const count = s.split(sep).length - 1;
    const after = s.length - s.lastIndexOf(sep) - 1;
    const intPart = s.slice(0, s.indexOf(sep));
    // „12,5“ / „12.50“ = desetinné; „12.990“ / „1,234,567“ = tisíce (víc oddělovačů nebo přesně 3 číslice)
    if (count > 1) dec = null; // všechny jsou oddělovače tisíců
    else if (/^0/.test(intPart)) dec = sep; // „0,125“ / „0.999“ – skupina tisíců nezačíná nulou
    else if (after === 3 && sep === '.' && opts.dotThousands !== false) dec = null; // „12.990“ – v CZ exportech tisíce
    else if (after === 3 && sep === ',' && opts.commaThousands !== false && /^\d{1,3},\d{3}$/.test(s)) dec = null; // „1,234“ – tisíce
    else dec = sep;
  }
  let normalized;
  if (dec) {
    const thousands = dec === ',' ? '.' : ',';
    const parts = s.split(thousands).join('');
    const idx = parts.lastIndexOf(dec);
    // bez desetinného oddělovače je číslo celé („12990“ s vynucenou čárkou) – dřív z něj vznikalo 1299.1299
    normalized = idx < 0 ? parts : parts.slice(0, idx).split(dec).join('') + '.' + parts.slice(idx + 1);
  } else {
    normalized = s.replace(/[.,]/g, '');
  }
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Zaokrouhlení na n desetinných míst bez chyb typu 1.005 → 1. */
function round(n, decimals = 2) {
  if (n == null || !Number.isFinite(n)) return n;
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON * Math.sign(n)) * f) / f;
}

/** Cena s DPH → bez DPH. */
function net(gross, vatRate) {
  if (gross == null) return null;
  return gross / (1 + (vatRate || 0) / 100);
}

/** Cena bez DPH → s DPH. */
function gross(netPrice, vatRate) {
  if (netPrice == null) return null;
  return netPrice * (1 + (vatRate || 0) / 100);
}

/**
 * Marže v % z prodejní ceny bez DPH: (cena_bez_DPH − nákup) / cena_bez_DPH × 100.
 * @returns {number|null}
 */
function marginPct(priceGross, purchaseNet, vatRate) {
  if (priceGross == null || purchaseNet == null || priceGross <= 0) return null;
  const n = net(priceGross, vatRate);
  return round(((n - purchaseNet) / n) * 100, 2);
}

/** Přirážka v % z nákupní ceny: (cena_bez_DPH − nákup) / nákup × 100. */
function markupPct(priceGross, purchaseNet, vatRate) {
  if (priceGross == null || purchaseNet == null || purchaseNet <= 0) return null;
  return round(((net(priceGross, vatRate) - purchaseNet) / purchaseNet) * 100, 2);
}

function median(values) {
  const a = values.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function mean(values) {
  const a = values.filter((x) => Number.isFinite(x));
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}

module.exports = { parseNumber, round, net, gross, marginPct, markupPct, median, mean };
