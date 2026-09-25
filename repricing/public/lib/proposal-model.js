// Návrh ceny (řádek GET /proposals, products[].proposal) – cena, která se opravdu exportuje.
// SPEC §3.6: exportuje se manual_price ?? new_price; API posílá hotové final_price / final_change_pct / final_margin_pct.
// Čistý modul bez DOM.

import { toNum, round } from './format.js';

function prod(r) {
  return r.product || { code: r.code, name: r.name, manufacturer: r.manufacturer, purchase_price: r.purchase_price, vat_rate: r.vat_rate };
}

/** Cena, která se opravdu exportuje: final_price z API, jinak ruční cena, jinak navržená (SPEC §3.6). */
export function finalPrice(r) {
  return toNum(r.final_price) ?? toNum(r.manual_price) ?? toNum(r.new_price);
}

/** Změna v % vůči staré ceně pro exportovanou cenu. */
export function finalChangePct(r) {
  if (r.final_change_pct != null) return toNum(r.final_change_pct);
  const fp = finalPrice(r);
  const old = toNum(r.old_price);
  if (!isManual(r)) return toNum(r.change_pct);
  return fp != null && old ? round(((fp - old) / old) * 100, 2) : null;
}

/**
 * Marže po změně pro exportovanou cenu (final_margin_pct z API, jinak dopočet z DPH produktu).
 * @param {object} r návrh
 * @param {number} [defaultVat=21] sazba DPH, když produkt žádnou nemá
 */
export function finalMargin(r, defaultVat = 21) {
  if (r.final_margin_pct !== undefined && r.final_margin_pct !== null) return toNum(r.final_margin_pct);
  if (!isManual(r)) return toNum(r.margin_after);
  const p = prod(r);
  const purchase = toNum(p.purchase_price ?? r.purchase_price);
  const vat = toNum(p.vat_rate ?? r.vat_rate) ?? defaultVat;
  const price = toNum(r.manual_price);
  if (purchase == null || purchase <= 0 || !price) return null;
  const net = price / (1 + vat / 100);
  return round(((net - purchase) / net) * 100, 2);
}

/** true, když se exportuje ruční cena místo navržené. */
export function isManual(r) {
  return r != null && r.manual_price != null && r.manual_price !== '';
}
