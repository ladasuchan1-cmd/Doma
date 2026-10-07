// Ručně přidaná místa (prodejna, servis, naše pobočka…) a obraty firem zadané týmem – kontrola a normalizace
// záznamů, které ukládá server. UMD: v prohlížeči `MP.vlastni`, v Node require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.MP = root.MP || {}; root.MP.vlastni = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TYPY = [
    { key: 'prodejna', label: 'Prodejna kol' },
    { key: 'servis', label: 'Servis kol' },
    { key: 'pujcovna', label: 'Půjčovna kol' },
    { key: 'bazar', label: 'Bazar kol' },
    { key: 'retezec', label: 'Sportovní řetězec' },
    { key: 'nase', label: 'Naše prodejna / pobočka' },
    { key: 'jine', label: 'Jiné' },
  ];
  const TYP_KEYS = TYPY.map((t) => t.key);
  const SLUZBY = ['prodej', 'servis', 'pujcovna', 'ekola', 'bazar'];
  // ČR s rezervou (hranice: 48,55–51,06 s. š., 12,09–18,86 v. d.)
  const BBOX = { latMin: 48.4, latMax: 51.2, lonMin: 11.9, lonMax: 19.0 };

  function validIco(ico) {
    const s = String(ico == null ? '' : ico);
    if (!/^\d{8}$/.test(s) || s === '00000000') return false;
    let sum = 0;
    for (let i = 0; i < 7; i++) sum += Number(s[i]) * (8 - i);
    const rem = sum % 11;
    const check = rem === 0 ? 1 : rem === 1 ? 0 : 11 - rem;
    return check === Number(s[7]);
  }

  function normIco(v) {
    const s = String(v == null ? '' : v).replace(/\D/g, '');
    if (!s || s.length > 8) return '';
    const p = s.padStart(8, '0');
    return validIco(p) ? p : '';
  }

  function text(v, max) {
    return v == null ? '' : String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
  }

  function seznam(v, max, each) {
    const arr = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[;,\n]+/);
    return [...new Set(arr.map((x) => text(x, each || 200)).filter(Boolean))].slice(0, max);
  }

  function normWeb(u) {
    let s = text(u, 300);
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
    try {
      const url = new URL(s);
      return /^https?:$/.test(url.protocol) && url.hostname.includes('.') ? url.toString() : '';
    } catch (_e) {
      return '';
    }
  }

  function novyId() {
    let s = '';
    const abc = '0123456789abcdefghijklmnopqrstuvwxyz';
    const rnd = typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(10)) : Array.from({ length: 10 }, () => Math.floor(Math.random() * 256));
    for (const b of rnd) s += abc[b % 36];
    return 'v' + s;
  }

  // Vrací { misto } nebo { chyba }.
  function normalizeMisto(raw, id) {
    if (!raw || typeof raw !== 'object') return { chyba: 'Chybí údaje o místě.' };
    const nazev = text(raw.nazev, 200);
    if (!nazev) return { chyba: 'Vyplňte název.' };
    const lat = Number(raw.lat);
    const lon = Number(raw.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < BBOX.latMin || lat > BBOX.latMax || lon < BBOX.lonMin || lon > BBOX.lonMax) return { chyba: 'Poloha musí být v Česku (dohledejte adresu nebo klikněte do mapy).' };
    const ico = normIco(raw.ico);
    if (raw.ico && String(raw.ico).trim() && !ico) return { chyba: 'IČO nemá platný kontrolní součet.' };
    const sl = {};
    for (const k of SLUZBY) if (raw.sl && (raw.sl[k] === true || raw.sl[k] === 'ano')) sl[k] = true;
    const misto = {
      id: /^v[0-9a-z]{6,16}$/.test(String(id || raw.id || '')) ? String(id || raw.id) : novyId(),
      nazev,
      typ: TYP_KEYS.includes(raw.typ) ? raw.typ : 'prodejna',
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5,
      adresa: text(raw.adresa, 300),
      obec: text(raw.obec, 120),
      ico,
      tel: seznam(raw.tel, 4, 40),
      mail: seznam(raw.mail, 4, 120).filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)),
      web: seznam(raw.web, 3, 300).map(normWeb).filter(Boolean),
      poznamka: text(raw.poznamka, 2000),
      sl,
      kdo: text(raw.kdo, 60),
      vytvoreno: typeof raw.vytvoreno === 'string' && !Number.isNaN(Date.parse(raw.vytvoreno)) ? raw.vytvoreno : new Date().toISOString(),
      upraveno: new Date().toISOString(),
    };
    return { misto };
  }

  // Obrat firmy: { obrat (Kč), rok, zdroj, kdo, upraveno } nebo { chyba }.
  function normalizeObrat(raw) {
    if (!raw || typeof raw !== 'object') return { chyba: 'Chybí údaje.' };
    const obrat = Math.round(Number(raw.obrat));
    if (!Number.isFinite(obrat) || obrat < 0 || obrat > 1e12) return { chyba: 'Obrat musí být číslo v Kč (0 až 1 bilion).' };
    const rok = raw.rok == null || raw.rok === '' ? null : Math.round(Number(raw.rok));
    if (rok != null && (!Number.isFinite(rok) || rok < 1995 || rok > 2100)) return { chyba: 'Rok obratu je mimo rozsah.' };
    return { obrat: { obrat, rok, zdroj: text(raw.zdroj, 120), kdo: text(raw.kdo, 60), upraveno: typeof raw.upraveno === 'string' && !Number.isNaN(Date.parse(raw.upraveno)) ? raw.upraveno : new Date().toISOString() } };
  }

  return { TYPY, TYP_KEYS, SLUZBY, BBOX, validIco, normIco, normalizeMisto, normalizeObrat, novyId };
});
