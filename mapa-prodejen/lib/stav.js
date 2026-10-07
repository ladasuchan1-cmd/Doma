// Stav spolupráce (CRM) – model záznamu k místu: šest zaškrtávacích stavů od „vytipovaný“ po „partner“ /
// „nemá zájem“, poznámka, typ spolupráce a ručně doplněné kontakty (kontaktní osoba, telefon, e-mail, web, IČO).
// Sloučení dvou úložišť (prohlížeč ↔ server), import/export. Vychází z Cyklo & Ski mapy (stejný princip sloučení).
// UMD: v prohlížeči `MP.stav`, v Node require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.MP = root.MP || {}; root.MP.stav = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STAVY = [
    { key: 'vytipovano', label: 'Vytipovaný – chceme oslovit', short: 'Vytipováno', barva: '#2466cc' },
    { key: 'osloveno', label: 'Osloven (e-mail / nabídka)', short: 'Osloveno', barva: '#8f5b00' },
    { key: 'volano', label: 'Volali jsme', short: 'Voláno', barva: '#6b3fa0' },
    { key: 'schuzka', label: 'Schůzka / návštěva proběhla', short: 'Schůzka', barva: '#0b7285' },
    { key: 'partner', label: 'Partner – spolupráce domluvena', short: 'Partner', barva: '#1a7f37' },
    { key: 'odmitl', label: 'Nemá zájem', short: 'Nemá zájem', barva: '#c42f2f' },
  ];
  const STAV_KEYS = STAVY.map((s) => s.key);
  const TEXT_POLE = ['poznamka', 'osoba', 'telefon', 'email', 'web', 'ico'];
  const SPOLUPRACE = [
    { key: '', label: '—' },
    { key: 'servis', label: 'Servis (montáž, záruční prohlídky, reklamace)' },
    { key: 'vydej', label: 'Výdejní místo' },
    { key: 'prodej', label: 'Prodej / odběratel' },
    { key: 'jine', label: 'Jiné' },
  ];
  const SPOLUPRACE_KEYS = SPOLUPRACE.map((s) => s.key);
  const VERZE = 1;

  function emptyRecord() {
    const r = { poznamka: '', osoba: '', telefon: '', email: '', web: '', ico: '', spoluprace: '', skryto: false, datumy: {}, upraveno: null, kdo: '' };
    for (const k of STAV_KEYS) r[k] = false;
    return r;
  }

  // Záznam bez jakékoli informace (nemá smysl ukládat).
  function isEmpty(r) {
    if (!r) return true;
    if (STAV_KEYS.some((k) => r[k])) return false;
    if (TEXT_POLE.some((k) => r[k] && String(r[k]).trim())) return false;
    if (r.spoluprace || r.skryto) return false;
    return true;
  }

  // Očistí záznam z importu / úložiště na známý tvar (neznámé klíče zahodí, typy srovná).
  function normalizeRecord(raw) {
    const r = emptyRecord();
    if (!raw || typeof raw !== 'object') return r;
    for (const k of STAV_KEYS) r[k] = raw[k] === true || raw[k] === 1 || raw[k] === 'true';
    for (const k of TEXT_POLE) r[k] = raw[k] == null ? '' : String(raw[k]).slice(0, k === 'poznamka' ? 4000 : 300);
    r.ico = r.ico.replace(/\D/g, '').slice(0, 8);
    r.spoluprace = SPOLUPRACE_KEYS.includes(raw.spoluprace) ? raw.spoluprace : '';
    r.skryto = raw.skryto === true || raw.skryto === 1 || raw.skryto === 'true';
    if (raw.datumy && typeof raw.datumy === 'object') {
      for (const k of STAV_KEYS) if (r[k] && typeof raw.datumy[k] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw.datumy[k])) r.datumy[k] = raw.datumy[k].slice(0, 10);
    }
    r.upraveno = typeof raw.upraveno === 'string' && !Number.isNaN(Date.parse(raw.upraveno)) ? raw.upraveno : null;
    r.kdo = raw.kdo == null ? '' : String(raw.kdo).slice(0, 60);
    return r;
  }

  // Přepne stav (zaškrtnutí) a zapíše datum; vrací nový záznam. „Partner“ a „Nemá zájem“ se vylučují.
  function toggleStav(r, key, on, now) {
    if (!STAV_KEYS.includes(key)) throw new Error('Neznámý stav ' + key);
    const next = normalizeRecord(r);
    const d = now ? new Date(now) : new Date();
    next[key] = Boolean(on);
    if (on) next.datumy[key] = d.toISOString().slice(0, 10);
    else delete next.datumy[key];
    if (on && key === 'partner' && next.odmitl) {
      next.odmitl = false;
      delete next.datumy.odmitl;
    }
    if (on && key === 'odmitl' && next.partner) {
      next.partner = false;
      delete next.datumy.partner;
    }
    next.upraveno = d.toISOString();
    return next;
  }

  // Nastaví textové pole / typ spolupráce / skrytí („není prodejna ani servis kol“); vrací nový záznam.
  function setPole(r, key, value, now) {
    if (!TEXT_POLE.includes(key) && key !== 'spoluprace' && key !== 'skryto') throw new Error('Neznámé pole ' + key);
    const next = normalizeRecord(r);
    if (key === 'spoluprace') next.spoluprace = SPOLUPRACE_KEYS.includes(value) ? value : '';
    else if (key === 'skryto') next.skryto = value === true || value === 'true' || value === 1;
    else if (key === 'ico') next.ico = String(value == null ? '' : value).replace(/\D/g, '').slice(0, 8);
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

  // Nejpokročilejší stav záznamu (pro řazení a barvu): partner > schůzka > voláno > osloveno > vytipováno; odmítl zvlášť.
  function faze(r) {
    if (!r) return null;
    if (r.partner) return 'partner';
    if (r.odmitl) return 'odmitl';
    for (const k of ['schuzka', 'volano', 'osloveno', 'vytipovano']) if (r[k]) return k;
    return null;
  }

  // Platné id místa: OSM (n/w/r + číslo), firma z ARES (a + IČO), ručně přidané místo (v + 6–16 znaků).
  function isValidId(id) {
    return typeof id === 'string' && (/^[nwr]\d{1,15}$/.test(id) || /^a\d{8}$/.test(id) || /^v[0-9a-z]{6,16}$/.test(id));
  }

  // Obálka pro export/import JSON souboru se stavem.
  function exportJson(stav, meta) {
    const data = {};
    for (const [id, r] of Object.entries(stav || {})) {
      if (!isValidId(id)) continue;
      const n = normalizeRecord(r);
      if (!isEmpty(n)) data[id] = n;
    }
    return { app: 'mapa-prodejen', verze: VERZE, exportovano: new Date().toISOString(), ...(meta || {}), stav: data };
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

  // Výsledný kontakt místa: ruční údaj má přednost, pak OSM / ručně přidané místo, pak web.
  function efektivni(misto, rec, web) {
    const r = rec || emptyRecord();
    const w = web && web.stav === 'ok' ? web : null;
    const first = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : '');
    return {
      osoba: r.osoba || '',
      telefon: r.telefon || (misto.tel || []).join(', ') || (w ? (w.telefony || []).slice(0, 2).join(', ') : ''),
      email: r.email || (misto.mail || []).join(', ') || (w ? (w.emaily || []).slice(0, 2).join(', ') : ''),
      web: r.web || first(misto.web) || (w && w.web) || first(misto.fb) || '',
      ico: r.ico || misto.ico || '',
    };
  }

  return { STAVY, STAV_KEYS, TEXT_POLE, SPOLUPRACE, VERZE, isValidId, emptyRecord, isEmpty, normalizeRecord, toggleStav, setPole, merge, summary, faze, exportJson, importJson, efektivni };
});
