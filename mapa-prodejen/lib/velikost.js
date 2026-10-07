// Velikost firmy – kategorie podle obratu (je-li známý: import nebo ruční zadání) a jinak podle počtu zaměstnanců,
// který ARES přebírá z registru ekonomických subjektů ČSÚ (měsíčně podle hlášení ČSSZ). Obrat samotný ARES
// neposkytuje – je jen v účetních závěrkách ve Sbírce listin (justice.cz) nebo v placených databázích.
// UMD: v prohlížeči `MP.velikost`, v Node require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.MP = root.MP || {}; root.MP.velikost = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Číselník ARES/RES „KategoriePoctuPracovniku“ (ověřeno 7. 10. 2026 přes /ciselniky-nazevniky/vyhledat).
  const ZAMESTNANCI = {
    '000': 'neuvedeno',
    110: 'bez zaměstnanců',
    120: '1–5 zaměstnanců',
    130: '6–9 zaměstnanců',
    210: '10–19 zaměstnanců',
    220: '20–24 zaměstnanců',
    230: '25–49 zaměstnanců',
    240: '50–99 zaměstnanců',
    310: '100–199 zaměstnanců',
    320: '200–249 zaměstnanců',
    330: '250–499 zaměstnanců',
    340: '500–999 zaměstnanců',
    410: '1 000–1 499 zaměstnanců',
    420: '1 500–1 999 zaměstnanců',
    430: '2 000–2 499 zaměstnanců',
    440: '2 500–2 999 zaměstnanců',
    450: '3 000–3 999 zaměstnanců',
    460: '4 000–4 999 zaměstnanců',
    470: '5 000–9 999 zaměstnanců',
    510: '10 000 a více zaměstnanců',
  };

  // Kategorie – hranice odpovídají trhu s koly (prodejna s 10 lidmi je v oboru už velká), ne definici MSP podle EU.
  const VELIKOSTI = [
    { key: 'velka', label: 'Velká', popis: '50 a více zaměstnanců nebo obrat nad 100 mil. Kč', barva: '#c2255c', r: 11 },
    { key: 'stredni', label: 'Střední', popis: '10–49 zaměstnanců nebo obrat 20–100 mil. Kč', barva: '#e8590c', r: 9 },
    { key: 'mala', label: 'Malá', popis: '1–9 zaměstnanců nebo obrat 3–20 mil. Kč', barva: '#2f9e44', r: 7.5 },
    { key: 'mikro', label: 'Mikro', popis: 'bez zaměstnanců (typicky OSVČ) nebo obrat do 3 mil. Kč', barva: '#1c7ed6', r: 6.5 },
    { key: 'neznama', label: 'Neznámá', popis: 'bez IČO, nebo firma počet zaměstnanců neuvádí a obrat neznáme', barva: '#868e96', r: 6 },
  ];
  const VELIKOST = Object.fromEntries(VELIKOSTI.map((v) => [v.key, v]));
  const PORADI = { velka: 0, stredni: 1, mala: 2, mikro: 3, neznama: 4 };

  // Hranice obratu v Kč (dolní mez kategorie).
  const OBRAT_HRANICE = { velka: 100e6, stredni: 20e6, mala: 3e6 };

  // Právní formy fyzických osob (podnikatel – OSVČ).
  const FORMY_FO = new Set(['100', '101', '102', '105', '107', '108', '424', '425']);

  function kodZam(kod) {
    if (kod == null || kod === '') return null;
    const s = String(kod).trim().padStart(3, '0');
    return Object.prototype.hasOwnProperty.call(ZAMESTNANCI, s) ? s : null;
  }

  function zamestnanciText(kod) {
    const k = kodZam(kod);
    return k ? ZAMESTNANCI[k] : '';
  }

  // Kategorie jen podle počtu zaměstnanců (null = neznámo).
  function zeZamestnancu(kod, forma) {
    const k = kodZam(kod);
    if (!k || k === '000') return FORMY_FO.has(String(forma || '')) ? 'mikro' : null;
    const n = Number(k);
    if (n === 110) return 'mikro';
    if (n <= 130) return 'mala';
    if (n <= 230) return 'stredni';
    return 'velka';
  }

  // Kategorie jen podle obratu v Kč (null = neznámo).
  function zObratu(kc) {
    if (kc == null || kc === '' || typeof kc === 'boolean') return null;
    const v = Number(kc);
    if (!Number.isFinite(v) || v < 0) return null;
    if (v >= OBRAT_HRANICE.velka) return 'velka';
    if (v >= OBRAT_HRANICE.stredni) return 'stredni';
    if (v >= OBRAT_HRANICE.mala) return 'mala';
    return 'mikro';
  }

  // Obrat zadaný člověkem: „45 mil“, „45 000 000“, „45,5 mil. Kč“, „1,2 mld“, „800 tis.“ → Kč (null = nečitelné).
  function parseObrat(raw, jednotka) {
    if (raw == null) return null;
    if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? scale(raw, jednotka) : null;
    let s = String(raw).toLowerCase().replace(/ /g, ' ').trim();
    if (!s) return null;
    // „k“ a „m“ jen jako samostatné značky (\b v JS nezná diakritiku – „kč“ by bral jako „k“)
    let mult = 1;
    if (/mld|miliard/.test(s)) mult = 1e9;
    else if (/mil|mio|(?<!\p{L})m(?!\p{L})/u.test(s)) mult = 1e6;
    else if (/tis|(?<!\p{L})k(?!\p{L})/u.test(s)) mult = 1e3;
    s = s.replace(/kč|czk|,-|mld\.?|miliard\p{L}*|mil\.?|milion\p{L}*|mio\.?|tis\.?|(?<!\p{L})[km](?!\p{L})/gu, ' ');
    s = s.replace(/\s+/g, '');
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.234.567,89
    else s = s.replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    const v = Number(s) * mult;
    if (!Number.isFinite(v)) return null;
    return mult === 1 ? scale(v, jednotka) : Math.round(v);
  }

  // Číslo bez jednotky v souboru „v tis. Kč“ / „v mil. Kč“.
  function scale(v, jednotka) {
    if (jednotka === 'tis') return Math.round(v * 1e3);
    if (jednotka === 'mil') return Math.round(v * 1e6);
    return Math.round(v);
  }

  function fmtObrat(kc) {
    const v = Number(kc);
    if (!Number.isFinite(v)) return '';
    if (v >= 1e9) return (v / 1e9).toLocaleString('cs-CZ', { maximumFractionDigits: 1 }) + ' mld. Kč';
    if (v >= 1e6) return (v / 1e6).toLocaleString('cs-CZ', { maximumFractionDigits: v >= 1e8 ? 0 : 1 }) + ' mil. Kč';
    if (v >= 1e3) return Math.round(v / 1e3).toLocaleString('cs-CZ') + ' tis. Kč';
    return Math.round(v).toLocaleString('cs-CZ') + ' Kč';
  }

  // Výsledná velikost: { key, duvod }. Vstup: { zam (kód ČSÚ), forma (kód právní formy), obrat (Kč), rok, ico }.
  function urci(o) {
    const x = o || {};
    const zObr = zObratu(x.obrat);
    if (zObr) return { key: zObr, duvod: 'obrat ' + fmtObrat(x.obrat) + (x.rok ? ' (' + x.rok + ')' : '') };
    const zZam = zeZamestnancu(x.zam, x.forma);
    if (zZam) {
      const k = kodZam(x.zam);
      if (!k || k === '000') return { key: zZam, duvod: 'podnikající fyzická osoba, zaměstnance neuvádí' };
      return { key: zZam, duvod: 'ČSÚ: ' + zamestnanciText(k) };
    }
    if (!x.ico) return { key: 'neznama', duvod: 'IČO zatím neznáme' };
    return { key: 'neznama', duvod: 'firma počet zaměstnanců neuvádí, obrat neznáme' };
  }

  return { ZAMESTNANCI, VELIKOSTI, VELIKOST, PORADI, OBRAT_HRANICE, FORMY_FO, zamestnanciText, zeZamestnancu, zObratu, parseObrat, fmtObrat, urci };
});
