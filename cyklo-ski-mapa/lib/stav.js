// Stav oslovení (CRM) – model záznamu k místu: čtyři zaškrtávací stavy, poznámka a ručně doplněné kontakty
// (provozuje půjčovnu, provozovatel, telefon, e-mail, web). Sloučení dvou úložišť, import/export.
// UMD: v prohlížeči `CSM.stav`, v Node require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.CSM = root.CSM || {}; root.CSM.stav = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STAVY = [
    { key: 'kontaktovat', label: 'Chceme kontaktovat', short: 'Kontaktovat', barva: '#2466cc' },
    { key: 'nabidka', label: 'Proběhl nabídkový e-mail', short: 'Nabídka', barva: '#8f5b00' },
    { key: 'volano', label: 'Volali jsme', short: 'Voláno', barva: '#6b3fa0' },
    { key: 'navsteva', label: 'Osobní návštěva proběhla', short: 'Návštěva', barva: '#1a7f37' },
  ];
  const STAV_KEYS = STAVY.map((s) => s.key);
  const TEXT_POLE = ['poznamka', 'provozovatel', 'telefon', 'email', 'web'];
  const PUJCOVNA = ['', 'ano', 'ne'];
  const VERZE = 1;

  function emptyRecord() {
    const r = { poznamka: '', pujcovna: '', provozovatel: '', telefon: '', email: '', web: '', datumy: {}, upraveno: null };
    for (const k of STAV_KEYS) r[k] = false;
    return r;
  }

  // Záznam bez jakékoli informace (nemá smysl ukládat).
  function isEmpty(r) {
    if (!r) return true;
    if (STAV_KEYS.some((k) => r[k])) return false;
    if (TEXT_POLE.some((k) => r[k] && String(r[k]).trim())) return false;
    if (r.pujcovna) return false;
    return true;
  }

  // Očistí záznam z importu / úložiště na známý tvar (neznámé klíče zahodí, typy srovná).
  function normalizeRecord(raw) {
    const r = emptyRecord();
    if (!raw || typeof raw !== 'object') return r;
    for (const k of STAV_KEYS) r[k] = raw[k] === true || raw[k] === 1 || raw[k] === 'true';
    for (const k of TEXT_POLE) r[k] = raw[k] == null ? '' : String(raw[k]).slice(0, k === 'poznamka' ? 4000 : 300);
    r.pujcovna = PUJCOVNA.includes(raw.pujcovna) ? raw.pujcovna : '';
    if (raw.datumy && typeof raw.datumy === 'object') {
      for (const k of STAV_KEYS) if (r[k] && typeof raw.datumy[k] === 'string') r.datumy[k] = raw.datumy[k].slice(0, 10);
    }
    r.upraveno = typeof raw.upraveno === 'string' && !Number.isNaN(Date.parse(raw.upraveno)) ? raw.upraveno : null;
    return r;
  }

  // Přepne stav (zaškrtnutí) a zapíše datum; vrací nový záznam.
  function toggleStav(r, key, on, now) {
    if (!STAV_KEYS.includes(key)) throw new Error('Neznámý stav ' + key);
    const next = normalizeRecord(r);
    const d = now ? new Date(now) : new Date();
    next[key] = Boolean(on);
    if (on) next.datumy[key] = d.toISOString().slice(0, 10);
    else delete next.datumy[key];
    next.upraveno = d.toISOString();
    return next;
  }

  // Nastaví textové pole / půjčovnu; vrací nový záznam.
  function setPole(r, key, value, now) {
    if (!TEXT_POLE.includes(key) && key !== 'pujcovna') throw new Error('Neznámé pole ' + key);
    const next = normalizeRecord(r);
    if (key === 'pujcovna') next.pujcovna = PUJCOVNA.includes(value) ? value : '';
    else next[key] = value == null ? '' : String(value);
    next.upraveno = (now ? new Date(now) : new Date()).toISOString();
    return next;
  }

  // Sloučení dvou úložišť (např. lokální ↔ server): u každého místa vyhraje novější `upraveno`.
  function merge(a, b) {
    const out = {};
    const ids = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const id of ids) {
      const ra = a && a[id] ? normalizeRecord(a[id]) : null;
      const rb = b && b[id] ? normalizeRecord(b[id]) : null;
      let pick;
      if (ra && rb) pick = Date.parse(rb.upraveno || 0) > Date.parse(ra.upraveno || 0) ? rb : ra;
      else pick = ra || rb;
      if (pick && !isEmpty(pick)) out[id] = pick;
    }
    return out;
  }

  // Souhrn počtů podle stavů.
  function summary(stav) {
    const s = { celkem: 0 };
    for (const k of STAV_KEYS) s[k] = 0;
    for (const r of Object.values(stav || {})) {
      if (isEmpty(r)) continue;
      s.celkem++;
      for (const k of STAV_KEYS) if (r[k]) s[k]++;
    }
    return s;
  }

  // Platné id místa / trasy / areálu (OSM n/w/r, cyklostezka c, skupina sjezdovek g, OpenSkiMap osk-).
  function isValidId(id) {
    return /^[nwrcg]\d+$/.test(id) || /^osk-[\w-]+$/.test(id);
  }

  // Obálka pro export/import JSON souboru se stavem.
  function exportJson(stav, meta) {
    const data = {};
    for (const [id, r] of Object.entries(stav || {})) {
      if (!isValidId(id)) continue;
      const n = normalizeRecord(r);
      if (!isEmpty(n)) data[id] = n;
    }
    return { app: 'cyklo-ski-mapa', verze: VERZE, exportovano: new Date().toISOString(), ...(meta || {}), stav: data };
  }

  // Import: vrátí { stav, pocet, chyba }.
  function importJson(obj) {
    if (!obj || typeof obj !== 'object') return { stav: null, pocet: 0, chyba: 'Soubor neobsahuje platný JSON objekt.' };
    const src = obj.stav && typeof obj.stav === 'object' ? obj.stav : obj.app ? null : obj;
    if (!src) return { stav: null, pocet: 0, chyba: 'Soubor neobsahuje položku „stav“.' };
    const out = {};
    for (const [id, r] of Object.entries(src)) {
      if (!isValidId(id)) continue;
      const n = normalizeRecord(r);
      if (!isEmpty(n)) out[id] = n;
    }
    return { stav: out, pocet: Object.keys(out).length, chyba: null };
  }

  // Výsledný kontakt: ruční údaj má přednost, pak OSM, pak web (obohacení).
  function efektivni(misto, rec, enrich) {
    const r = rec || emptyRecord();
    const e = enrich || null;
    const first = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : '');
    return {
      pujcovna: r.pujcovna || misto.pujcovna || (e && e.pujcovna && (e.pujcovna.kola || e.pujcovna.lyze) ? 'ano?' : '') || '',
      provozovatel: r.provozovatel || misto.operator || (e && e.ares && e.ares.nazev) || (e && e.provozovatel) || '',
      telefon: r.telefon || (misto.telefon || []).join(', ') || (e ? (e.telefony || []).join(', ') : ''),
      email: r.email || (misto.email || []).join(', ') || (e ? (e.emaily || []).join(', ') : ''),
      web: r.web || first(misto.web) || (e && e.web) || first(misto.social) || '',
    };
  }

  return { STAVY, STAV_KEYS, TEXT_POLE, PUJCOVNA, VERZE, isValidId, emptyRecord, isEmpty, normalizeRecord, toggleStav, setPole, merge, summary, exportJson, importJson, efektivni };
});
