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

/** Otevřený návrh = čeká na schválení nebo je schválený a ještě neexportovaný. */
export function isOpen(r) {
  return r != null && (r.status === 'pending' || r.status === 'approved');
}

/**
 * Schválený (neexportovaný) návrh, o jehož schválení může přepočet produktu připravit (contract-1). Přecenění
 * (SPEC §3.6) ponechá otevřený návrh jen tehdy, když vyjde stejná cena; jinak ho nahradí („Nahrazeno“) novým
 * návrhem – ruční cena se do něj přenese, ale schválení se ztratí a návrh znovu čeká. Čekající návrh (i s ruční
 * cenou) tedy o nic nepřijde, schválený ano. Vrací takový návrh, jinak null.
 * @param {object[]} proposals návrhy produktu (GET /products/:id → proposals)
 */
export function proposalAtRisk(proposals) {
  const list = Array.isArray(proposals) ? proposals : [];
  return list.find((p) => isOpen(p) && p.status === 'approved') || null;
}

// ------------------------------------------------------------------ výchozí cena návrhu (contract-2)

const CENT = 0.005;

/** Aktuální cena produktu u řádku návrhu (GET /proposals → product.price). */
export function currentPrice(r) {
  return toNum(r?.product?.price ?? r?.current_price);
}

/**
 * Otevřený návrh vznikl při jiné ceně produktu, než je teď (import katalogu z POHODY, ruční změna ceny).
 * Jeho old_price a změna v % pak neodpovídají tomu, co schválení opravdu udělá.
 * @param {object} r návrh
 * @param {number|null} [current] aktuální cena produktu (výchozí product.price z API)
 * @returns {{from: number, to: number, taken: boolean}|null} from = cena při vzniku návrhu, to = aktuální cena,
 *   taken = aktuální cena už odpovídá ceně k exportu (admin ji převzal) – jinak null
 */
export function basePriceChange(r, current = currentPrice(r)) {
  if (!isOpen(r)) return null;
  const from = toNum(r.old_price);
  const to = toNum(current);
  if (from == null || to == null || Math.abs(to - from) < CENT) return null;
  const fp = finalPrice(r);
  return { from, to, taken: fp != null && Math.abs(fp - to) < CENT };
}

/** Výchozí cena pro zobrazení změny: aktuální cena produktu, když se od návrhu změnila, jinak old_price. */
export function basePrice(r, current) {
  const ch = basePriceChange(r, current === undefined ? currentPrice(r) : current);
  return ch ? ch.to : toNum(r.old_price);
}

/** Změna v % (a Kč), kterou schválení opravdu udělá – proti aktuální ceně, když se od návrhu změnila. */
export function displayChange(r, current) {
  const ch = basePriceChange(r, current === undefined ? currentPrice(r) : current);
  const fp = finalPrice(r);
  if (!ch) {
    const old = toNum(r.old_price);
    return { pct: finalChangePct(r), abs: fp != null && old != null ? round(fp - old, 2) : toNum(r.change_abs) };
  }
  return { pct: fp != null && ch.to ? round(((fp - ch.to) / ch.to) * 100, 2) : null, abs: fp != null ? round(fp - ch.to, 2) : null };
}

/** Návrhy (otevřené), které vznikly při jiné ceně produktu a ještě nebyly převzaty. */
export function staleProposals(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    const ch = basePriceChange(r);
    return ch && !ch.taken;
  });
}

// ------------------------------------------------------------------ rozhodování (contract-10)

/** Řádek lze vybrat k hromadné akci: čekající (schválit/zamítnout) i schválený neexportovaný (zamítnout). */
export function isSelectableProposal(r) {
  return isOpen(r);
}

/**
 * Stav, na který se omezí hromadné „… vše dle filtru“: schvalovat jde jen čekající; zamítat čekající,
 * na záložce Schváleno schválené (API zamítne i schválené, dokud nejsou exportované).
 * @param {'approve'|'reject'} kind
 * @param {string} tab aktuální filtr stavu (pending | approved | all | …)
 * @returns {'pending'|'approved'|null} null = na této záložce hromadná akce nedává smysl
 */
export function bulkStatus(kind, tab) {
  if (kind === 'approve') return tab === 'pending' || tab === 'all' ? 'pending' : null;
  if (tab === 'approved') return 'approved';
  return tab === 'pending' || tab === 'all' ? 'pending' : null;
}
