'use strict';
// Normalizace identifikátorů pro párování (kód, EAN, MPN, název konkurenta).
// Stejné funkce MUSÍ používat import katalogu, import nabídek i ruční párování.

/** Odstraní diakritiku, převede na malá písmena, sjednotí mezery. */
function fold(s) {
  if (s == null) return '';
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Náš kód (Pohoda „Kód“ / katalogové číslo): ořezat, velká písmena, bez vnitřních mezer. */
function codeKey(s) {
  if (s == null) return null;
  const k = String(s).trim().toUpperCase().replace(/\s+/g, '');
  return k || null;
}

/**
 * EAN/GTIN: jen číslice, bez úvodních nul (GTIN-14 „0…“ = EAN-13, UPC-12 = EAN-13 s nulou).
 * Vrací null pro prázdné / zjevně neplatné (méně než 6 číslic, samé nuly).
 */
function eanKey(s) {
  if (s == null) return null;
  let str = String(s).trim();
  // čísla z Excelu mohou přijít jako 8.59E+12 → převést bez ztráty
  if (/^\d+(\.\d+)?e\+\d+$/i.test(str)) {
    const n = Number(str);
    if (Number.isFinite(n)) str = BigInt(Math.round(n)).toString();
  }
  const digits = str.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 14) return null;
  const k = digits.replace(/^0+/, '');
  return k.length >= 6 ? k : null;
}

/** Kód výrobce (MPN): velká písmena, bez mezer, pomlček, teček a lomítek. */
function mpnKey(s) {
  if (s == null) return null;
  const k = String(s).toUpperCase().replace(/[\s\-_./\\]+/g, '');
  return k || null;
}

/** Klíč jména konkurenta – „Kolo-Shop.cz“, „kolo-shop.cz “ a „KOLO-SHOP.CZ“ jsou jeden konkurent. */
function nameKey(s) {
  const f = fold(s);
  return f ? f.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '') : null;
}

module.exports = { fold, codeKey, eanKey, mpnKey, nameKey };
