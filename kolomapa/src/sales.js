'use strict';
// Import vlastních prodejů kol (export z POHODY – „Pohyby skladu“ / prodejky + vydané faktury) jako trénovací data
// pro nacenění.
//
// Pravidla (ověřeno na exportu 01–09/2026):
//  - BAZAR     = kolo vykoupené od zákazníka, prodané ve zvláštním režimu (§ 90 ZDPH) → „Částka“ je konečná cena.
//  - PROVĚŘENO = testovací / půjčovní / předváděcí kolo → „Částka“ je BEZ DPH, konečná cena = Částka × 1,21
//    (vychází kulaté maloobchodní ceny 59 999, 69 990, 99 999 …).
//  - Vratky (Množství < 0) ruší dřívější prodej stejného kódu → oba řádky vyřadíme.
//  - Nekola (hole, přilby, hodinky, převodníky …) se vyřadí.
//  - Osobní údaje (Jméno, Firma) se NEUKLÁDAJÍ – repozitář je veřejný.

const VAT = 0.21;

const NON_BIKE = /\b(hole|přilb|helm|hodinky|adapt[ée]r|převodník|lyže|lyžák|boty|tretry|dres|kalhoty|bunda|brýle|rukavice|pumpa|zámek|nosič|sedačka|světlo|computer|cyklopočítač|tachometr)/i;
const BIKE = /\b(kolo|kola|elektrokolo|e-?bike|bike|gravel|mtb|silni[čc]n|horsk|trek|kros|celoodpru|dětsk|odrážedl)/i;

/** Rozliší druh prodeje podle názvu. */
function saleKind(name) {
  const s = String(name || '');
  if (/bazar/i.test(s)) return 'bazar';
  if (/prov[ěe][řr]eno/i.test(s)) return 'provereno';
  return 'jine';
}

/** Očistí název od interních přípon („@vel. M“, „BAZAR“, „- Prověřeno“), velikost vrátí zvlášť. */
function cleanTitle(name) {
  let s = String(name || '');
  let size = null;
  const at = s.indexOf('@');
  if (at >= 0) {
    const tail = s.slice(at + 1);
    const m = tail.match(/(?:vel(?:ikost)?\.?\s*)?([^@]+)/i);
    if (m) size = m[1].replace(/\b(bazar|prov[ěe][řr]eno)\b/gi, '').trim() || null;
    s = s.slice(0, at);
  }
  s = s
    .replace(/[-–,]?\s*\b(bazar|prov[ěe][řr]eno)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/[\s,–-]+$/g, '')
    .trim();
  return { title: s, size };
}

function round(n) {
  return Math.round(Number(n) || 0);
}

/**
 * Převede řádky exportu na anonymizované záznamy prodejů kol.
 * @param {object[]} rows řádky z readXlsx (klíče = hlavičky POHODY)
 * @returns {{sales: object[], skipped: {nonBike: number, returned: number, other: number}}}
 */
function salesFromRows(rows) {
  const skipped = { nonBike: 0, returned: 0, other: 0 };
  const items = [];
  for (const r of rows) {
    const name = String(r['Název'] ?? r.Nazev ?? r.name ?? '').trim();
    if (!name) {
      skipped.other++;
      continue;
    }
    if (NON_BIKE.test(name) || !BIKE.test(name)) {
      skipped.nonBike++;
      continue;
    }
    const kind = saleKind(name);
    if (kind === 'jine') {
      skipped.other++;
      continue;
    }
    const qty = Number(r['Množství'] ?? r.qty ?? 1) || 0;
    const amount = Number(r['Částka'] ?? r.amount ?? 0) || 0;
    const cost = Number(r['Vážená'] ?? r.cost ?? 0) || 0;
    const { title, size } = cleanTitle(name);
    items.push({
      code: String(r['Kód'] ?? r.code ?? '').trim(),
      date: String(r.Datum ?? r.date ?? '').slice(0, 10) || null,
      kind,
      qty,
      title,
      size,
      brand: String(r['Výrobce'] ?? r.brand ?? '').trim() || null,
      branch: String(r['Členění'] ?? '').split('/')[0].replace(/^s/, '') || null,
      priceCzk: kind === 'provereno' ? round(amount * (1 + VAT)) : round(amount),
      // Nákupní (vážená) cena: u BAZARu výkupní cena od zákazníka, u PROVĚŘENO skladová cena bez DPH.
      costCzk: round(cost),
      amountRaw: amount,
    });
  }
  // Vratky: záporné množství ruší nejbližší předchozí prodej se stejným kódem a částkou.
  const sales = [];
  const out = items.filter((i) => i.qty > 0);
  for (const ret of items.filter((i) => i.qty < 0)) {
    const idx = out.findIndex((s) => s.code === ret.code && Math.abs(s.amountRaw - ret.amountRaw) < 1 && (!ret.date || !s.date || s.date <= ret.date));
    if (idx >= 0) {
      out.splice(idx, 1);
      skipped.returned += 2;
    } else skipped.returned++;
  }
  for (const s of out) {
    const { amountRaw, qty, ...rest } = s;
    sales.push(rest);
  }
  sales.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { sales, skipped };
}

/**
 * Souhrnné statistiky prodejů (marže BAZAR, poměr výkup/prodej) – používá nacenění pro „max. výkupní cenu“.
 * @param {object[]} sales
 */
function salesStats(sales) {
  const bazar = sales.filter((s) => s.kind === 'bazar' && s.priceCzk > 0 && s.costCzk > 0);
  const ratios = bazar.map((s) => s.costCzk / s.priceCzk).sort((a, b) => a - b);
  const median = (a) => (a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null);
  return {
    count: sales.length,
    bazarCount: bazar.length,
    proverenoCount: sales.filter((s) => s.kind === 'provereno').length,
    // Kolik % prodejní ceny obchod typicky platí při výkupu (medián).
    buyRatioMedian: median(ratios),
    buyRatioP25: ratios.length ? ratios[Math.floor(ratios.length * 0.25)] : null,
    buyRatioP75: ratios.length ? ratios[Math.floor(ratios.length * 0.75)] : null,
  };
}

module.exports = { salesFromRows, salesStats, saleKind, cleanTitle, VAT };
