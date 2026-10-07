'use strict';
// Úřední registry pro mapu prodejen (jen Node – sestavení dat i server): ARES (firmy, sídla, CZ-NACE), RES
// (kategorie počtu zaměstnanců od ČSÚ) a RÚIAN (souřadnice adresních míst a geokódování adres). Bez závislostí.

const ARES = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest';
const RUIAN = 'https://ags.cuzk.cz/arcgis/rest/services/RUIAN/MapServer';
const GEOCODE = 'https://ags.cuzk.cz/arcgis/rest/services/RUIAN/Vyhledavaci_sluzba_nad_daty_RUIAN/MapServer/exts/GeocodeSOE/findAddressCandidates';
const UA = 'mapa-prodejen/0.1 (+https://github.com/ladasuchan1-cmd/Doma)';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function req(url, opts) {
  const o = opts || {};
  const res = await fetch(url, {
    method: o.method || 'GET',
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(o.body ? { 'Content-Type': 'application/json' } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
    signal: AbortSignal.timeout(o.timeoutMs || 20000),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${url.replace(/\?.*/, '').slice(0, 100)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Opakování při přetížení (429) a chybách serveru; 4xx kromě 429 se neopakuje.
async function retry(fn, tries) {
  let last;
  for (let i = 0; i < (tries || 4); i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (e.status && e.status < 500 && e.status !== 429) throw e;
      await sleep(1500 * 2 ** i);
    }
  }
  throw last;
}

// IČO – 8 číslic s kontrolním součtem (mod 11).
function validIco(ico) {
  const s = String(ico == null ? '' : ico).replace(/\s/g, '').padStart(8, '0');
  if (!/^\d{8}$/.test(s) || s === '00000000') return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(s[i]) * (8 - i);
  const rem = sum % 11;
  const check = rem === 0 ? 1 : rem === 1 ? 0 : 11 - rem;
  return check === Number(s[7]);
}

function normIco(ico) {
  const s = String(ico == null ? '' : ico).replace(/\D/g, '');
  if (!s || s.length > 8) return null;
  const p = s.padStart(8, '0');
  return validIco(p) ? p : null;
}

// Vyhledání subjektů (POST /ekonomicke-subjekty/vyhledat). ARES hledá v obchodním jméně celá slova.
async function hledat(filtr, start, pocet) {
  return retry(() => req(`${ARES}/ekonomicke-subjekty/vyhledat`, { method: 'POST', body: { ...filtr, start: start || 0, pocet: pocet || 100 }, timeoutMs: 30000 }));
}

// Všechny výsledky hledání (po stránkách po 100, ARES vrací nejvýš 1000).
async function hledatVse(filtr, log) {
  const out = [];
  let start = 0;
  for (;;) {
    const j = await hledat(filtr, start, 100);
    const arr = (j && j.ekonomickeSubjekty) || [];
    out.push(...arr);
    const total = (j && j.pocetCelkem) || 0;
    start += arr.length;
    if (!arr.length || start >= total || start >= 1000) {
      if (total > 1000 && log) log(`  ARES: dotaz ${JSON.stringify(filtr)} má ${total} výsledků, načteno jen prvních 1000`);
      break;
    }
    await sleep(300);
  }
  return out;
}

async function subjekt(ico) {
  return retry(() => req(`${ARES}/ekonomicke-subjekty/${ico}`));
}

async function res(ico) {
  const j = await retry(() => req(`${ARES}/ekonomicke-subjekty-res/${ico}`));
  if (!j || !Array.isArray(j.zaznamy) || !j.zaznamy.length) return null;
  return j.zaznamy.find((z) => z.primarniZaznam) || j.zaznamy[0];
}

const AKTIVNI = (s) => !s || s === 'AKTIVNI';

// Záznam ARES (základní) + RES → jednotný tvar firmy pro mapu.
function firma(zakl, resZaznam) {
  if (!zakl || !zakl.ico) return null;
  const s = zakl.sidlo || {};
  const reg = zakl.seznamRegistraci || {};
  const stat = (resZaznam && resZaznam.statistickeUdaje) || {};
  const nace = (resZaznam && resZaznam.czNace2008) || zakl.czNace2008 || zakl.czNace || [];
  let okres = Number(s.kodOkresu) || null;
  const kraj = Number(s.kodKraje) || null;
  if (!okres && kraj === 19) okres = 3100; // Praha nemá v RÚIAN okres
  const zanikla = Boolean(zakl.datumZaniku) || (reg.stavZdrojeRes && !AKTIVNI(reg.stavZdrojeRes) && reg.stavZdrojeVr !== 'AKTIVNI' && reg.stavZdrojeRzp !== 'AKTIVNI');
  return {
    ico: zakl.ico,
    nazev: zakl.obchodniJmeno || '',
    forma: zakl.pravniForma || '',
    sidlo: s.textovaAdresa || [zakl.adresaDorucovaci && zakl.adresaDorucovaci.radekAdresy1, zakl.adresaDorucovaci && zakl.adresaDorucovaci.radekAdresy3].filter(Boolean).join(', ') || '',
    obec: s.nazevObce || '',
    psc: s.psc ? String(s.psc).padStart(5, '0') : '',
    okres,
    kraj,
    am: Number(s.kodAdresnihoMista) || null,
    vznik: zakl.datumVzniku || null,
    zanik: zakl.datumZaniku || null,
    zanikla,
    likvidace: /v likvidaci|v konkurzu|v insolvenci/i.test(zakl.obchodniJmeno || ''),
    nace: [...new Set(nace.map(String))].slice(0, 20),
    naceHlavni: (resZaznam && (resZaznam.czNacePrevazujici2008 || resZaznam.czNacePrevazujici)) || null,
    zam: stat.kategoriePoctuPracovniku || null,
    dph: reg.stavZdrojeDph === 'AKTIVNI',
    aktualizace: zakl.datumAktualizace || null,
  };
}

// Firma podle IČO (základ + RES) – pro server při ručním doplnění IČO.
async function firmaPodleIco(ico) {
  const i = normIco(ico);
  if (!i) return null;
  const zakl = await subjekt(i);
  if (!zakl) return null;
  let r = null;
  try {
    r = await res(i);
  } catch (_e) {
    r = null;
  }
  return firma(zakl, r);
}

// Souřadnice adresních míst RÚIAN podle kódů → Map(kód → [lat, lon]).
async function adresniMista(kody) {
  const out = new Map();
  const list = [...new Set(kody.map(Number).filter((k) => Number.isInteger(k) && k > 0))];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const q = new URLSearchParams({ where: `kod IN (${chunk.join(',')})`, outFields: 'kod', outSR: '4326', returnGeometry: 'true', f: 'json' });
    const j = await retry(() => req(`${RUIAN}/1/query?${q}`, { timeoutMs: 60000 }));
    for (const f of (j && j.features) || []) {
      if (f.geometry && Number.isFinite(f.geometry.x)) out.set(Number(f.attributes.kod), [Math.round(f.geometry.y * 1e5) / 1e5, Math.round(f.geometry.x * 1e5) / 1e5]);
    }
    if (i + 100 < list.length) await sleep(150);
  }
  return out;
}

// Geokódování textové adresy (vyhledávací služba RÚIAN) → [{ adresa, lat, lon, skore, typ }].
async function geokoduj(adresa, max) {
  const q = new URLSearchParams({ SingleLine: String(adresa).slice(0, 200), outSR: '4326', maxLocations: String(max || 5), f: 'json' });
  const j = await retry(() => req(`${GEOCODE}?${q}`), 2);
  return ((j && j.candidates) || [])
    .filter((c) => c.location && Number.isFinite(c.location.x) && Number.isFinite(c.location.y))
    .map((c) => ({ adresa: c.address, lat: Math.round(c.location.y * 1e5) / 1e5, lon: Math.round(c.location.x * 1e5) / 1e5, skore: c.score, typ: (c.attributes && c.attributes.Type) || '' }));
}

module.exports = { ARES, RUIAN, GEOCODE, validIco, normIco, hledat, hledatVse, subjekt, res, firma, firmaPodleIco, adresniMista, geokoduj, retry, sleep };
