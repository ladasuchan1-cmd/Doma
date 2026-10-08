// Mapa prodejen a servisů kol – logika aplikace: mapa ČR (kraje → okresy), prodejny, servisy, půjčovny a firmy
// z ARES rozlišené podle typu a velikosti (ČSÚ / obrat), filtry, seznam, detail s firmou a webem, stav spolupráce,
// objednávky e-shopu podle obcí (bubliny, kraje/okresy), hledání partnerů a bílých míst, tabulka a export.
// Data týmu (stav, objednávky, ručně přidaná místa, obraty, naše firma) se ukládají na server (server.js),
// bez něj do prohlížeče.
(function () {
  'use strict';

  const D = window.MP_DATA || {};
  const geo = window.MP.geo;
  const csvLib = window.MP.csv;
  const stavLib = window.MP.stav;
  const vel = window.MP.velikost;
  const objLib = window.MP.objednavky;
  const par = window.MP.partneri;
  const vlastni = window.MP.vlastni;
  const xlsx = window.MP.xlsx;
  const $ = (sel, root) => (root || document).querySelector(sel);

  if (!D.hranice || !D.mista) {
    $('#boot').textContent = 'Chybí datové soubory data/*.js – spusťte `npm run build-data`.';
    return;
  }

  // ================================================================== data a indexy
  const kraje = D.hranice.kraje.features;
  const okresy = D.hranice.okresy.features;
  const krajByKod = new Map(kraje.map((f) => [f.properties.kod, f]));
  const okresByKod = new Map(okresy.map((f) => [f.properties.kod, f]));
  const okresyByKraj = new Map();
  for (const o of okresy) {
    if (!okresyByKraj.has(o.properties.kraj)) okresyByKraj.set(o.properties.kraj, []);
    okresyByKraj.get(o.properties.kraj).push(o);
  }
  const krajOkresu = (kod) => (okresByKod.get(kod) ? okresByKod.get(kod).properties.kraj : null);
  const meta = D.meta || {};
  const firmyData = D.firmy || {};
  const weby = D.weby || {};
  const pscData = D.psc || {};
  const obceData = D.obce || [];

  // počet obyvatel okresu (součet sídel z GeoNames – orientační)
  const popOkresu = new Map();
  for (const o of obceData) popOkresu.set(o[1], (popOkresu.get(o[1]) || 0) + (o[4] || 0));
  const popObce = new Map(obceData.map((o) => [o[6] ? String(o[6]) : o[0] + '|' + o[1], o[4]]));
  // obce podle názvu (pro objednávky jen s názvem obce): jmenovci, části názvů, zkratky, vodítka „u Brna“;
  // index si sám vede i města, u kterých se píše část („Ostrava-Poruba“, „Praha 6 - Dejvice“, „Liberec XXV“)
  const obecIndex = objLib.indexObci(obceData, pscData);

  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');

  function okresName(kod) {
    const o = okresByKod.get(kod);
    return o ? o.properties.nazev : '';
  }
  function krajName(kod) {
    const k = krajByKod.get(kod);
    return k ? k.properties.nazev : '';
  }

  // ================================================================== číselníky
  const TYPY = [
    { key: 'prodejna', label: 'Prodejny kol', one: 'Prodejna kol', hex: '#1f5fbf' },
    { key: 'servis', label: 'Servisy kol', one: 'Servis kol', hex: '#0b7285' },
    { key: 'pujcovna', label: 'Půjčovny kol', one: 'Půjčovna kol', hex: '#2b8a3e' },
    { key: 'bazar', label: 'Bazary kol', one: 'Bazar kol', hex: '#a05a00' },
    { key: 'retezec', label: 'Sportovní řetězce', one: 'Sportovní řetězec', hex: '#7048b0' },
    { key: 'firma', label: 'Firmy z ARES (sídlo)', one: 'Firma z ARES – sídlo', hex: '#6c757d' },
    { key: 'nase', label: 'Naše prodejny', one: 'Naše prodejna', hex: '#e03131' },
    { key: 'jine', label: 'Jiné (ručně)', one: 'Jiné', hex: '#495057' },
  ];
  const TYP = Object.fromEntries(TYPY.map((t) => [t.key, t]));
  const VEL = vel.VELIKOST;
  const SLUZBY = [
    { key: 'servis', label: 'Servis' },
    { key: 'ekola', label: 'E-kola' },
    { key: 'pujcovna', label: 'Půjčovna' },
    { key: 'bazar', label: 'Bazar / výkup' },
    { key: 'eshop', label: 'E-shop' },
  ];
  const ZDROJ_SL = { osm: 'OSM', web: 'web', nazev: 'název firmy', rucne: 'ručně' };
  const STAV_BARVA = Object.fromEntries(stavLib.STAVY.map((s) => [s.key, s.barva]));
  const PRAVNI_FORMA = { 101: 'fyzická osoba (živnost)', 105: 'fyzická osoba (jiné podnikání)', 107: 'zemědělský podnikatel', 111: 'veřejná obchodní společnost', 112: 's.r.o.', 113: 'komanditní společnost', 121: 'akciová společnost', 141: 'obecně prospěšná společnost', 205: 'družstvo', 301: 'státní podnik', 325: 'organizační složka státu', 331: 'příspěvková organizace', 421: 'odštěpný závod zahraniční osoby', 424: 'zahraniční fyzická osoba', 706: 'spolek', 736: 'pobočný spolek', 801: 'obec' };
  const pravniForma = (kod) => (kod ? PRAVNI_FORMA[Number(kod)] || 'právní forma ' + kod : '');

  // ================================================================== stav aplikace
  const state = {
    scope: { kraj: null, okres: null },
    view: 'map',
    tab: 'mista',
    selected: null, // { type: 'misto' | 'obec', id }
    filters: {
      typy: new Set(TYPY.map((t) => t.key)),
      velikosti: new Set(vel.VELIKOSTI.map((v) => v.key)),
      sluzby: new Set(),
      znacka: '',
      kontakt: 'vse',
      stav: 'vse',
      bezNazvu: false,
      skryte: false,
      q: '',
    },
    barva: 'velikost',
    obj: { bubliny: true, choropleth: true, naObyv: false, radiusKm: 15, minN: 5, jenBezPartnera: false, jenServis: false, metrika: null },
    sort: 'nazev',
    mestaSort: 'n',
    listLimit: 150,
    tableSort: { key: 'nazev', dir: 1 },
    tableLimit: 500,
    stav: {},
    vlastni: {}, // ručně přidaná místa (id → záznam)
    obraty: {}, // IČO → { obrat, rok, zdroj, kdo, upraveno }
    firmyServer: {}, // IČO → firma dohledaná na serveru (ruční IČO)
    nastaveni: { naseIco: [] },
    objednavky: null, // dataset součtů podle PSČ (objednávky, zákazníci, aktivní zákazníci, částka)
    server: { on: false, user: '', registry: false },
    saveTimers: new Map(),
    pick: null, // výběr polohy v mapě pro nové místo
    cekaVyber: null, // výběr z adresy (#obec=…), který čeká na data ze serveru
  };

  // ================================================================== úložiště (server / prohlížeč)
  const LS = { stav: 'mp.stav.v1', vlastni: 'mp.vlastni.v1', obraty: 'mp.obraty.v1', obj: 'mp.objednavky.v1', nastaveni: 'mp.nastaveni.v1', theme: 'mp.theme', ui: 'mp.ui.v1' };
  function lsGet(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_e) {
      return null;
    }
  }
  function lsSet(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      toast('Nepodařilo se uložit do prohlížeče: ' + e.message);
    }
  }
  function saveLocalStav() {
    lsSet(LS.stav, stavLib.exportJson(state.stav));
  }
  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    if (res.status === 401) {
      toast('Přihlášení vypršelo – obnovte stránku a přihlaste se.');
      throw new Error('Nepřihlášeno');
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.chyba || 'HTTP ' + res.status);
    return j;
  }

  async function connectServer() {
    if (location.protocol === 'file:') return;
    let res;
    try {
      res = await fetch('api/stav', { signal: AbortSignal.timeout(5000) });
    } catch (_e) {
      return;
    }
    if (res.status === 401) {
      location.href = 'login?next=' + encodeURIComponent(location.pathname + location.search + location.hash);
      return;
    }
    if (!res.ok) return;
    try {
      const me = await api('GET', 'api/me');
      state.server.user = me.jmeno || '';
      state.server.registry = Boolean(me.registry);
      if (me.prihlaseni && me.jmeno) {
        $('#user-name').textContent = me.jmeno;
        $('#user-box').classList.remove('hidden');
      }
    } catch (_e) { /* bez přihlášení */ }
    const remote = stavLib.importJson(await res.json()).stav || {};
    const merged = stavLib.merge(state.stav, remote);
    const toPush = Object.entries(merged).filter(([id, r]) => JSON.stringify(remote[id] || null) !== JSON.stringify(r));
    state.stav = merged;
    saveLocalStav();
    state.server.on = true;
    for (const [id, r] of toPush) pushRecord(id, r);
    const [mistaJ, obratyJ, firmyJ, objJ, nastJ] = await Promise.all([
      api('GET', 'api/mista').catch(() => null),
      api('GET', 'api/obraty').catch(() => null),
      api('GET', 'api/firmy').catch(() => null),
      api('GET', 'api/objednavky').catch(() => null),
      api('GET', 'api/nastaveni').catch(() => null),
    ]);
    if (mistaJ) state.vlastni = Object.fromEntries((mistaJ.mista || []).map((m) => [m.id, m]));
    if (obratyJ) state.obraty = obratyJ.obraty || {};
    if (firmyJ) state.firmyServer = firmyJ.firmy || {};
    if (objJ && objJ.mista && objJ.mista.length) state.objednavky = objJ;
    else if (objJ) state.objednavky = null;
    if (nastJ) state.nastaveni = { naseIco: nastJ.naseIco || [] };
    rebuild();
    const ceka = state.cekaVyber;
    state.cekaVyber = null;
    if (ceka && (ceka.type === 'misto' ? mistoById.has(ceka.id) : obj.obecByKey.has(ceka.id))) select(ceka.type, ceka.id);
    else renderAll();
    $('#meta-line').title = 'Data týmu se sdílí přes server.';
  }

  async function pushRecord(id, rec) {
    if (!state.server.on) return;
    try {
      const j = await api('PUT', 'api/stav/' + encodeURIComponent(id), rec);
      if (j && j.kdo && state.stav[id]) state.stav[id].kdo = j.kdo;
    } catch (e) {
      toast('Server nedostupný – změna je zatím jen v tomto prohlížeči (' + e.message + ').');
    }
  }

  function updateRecord(id, mutate) {
    const prev = state.stav[id] || stavLib.emptyRecord();
    const next = mutate(prev);
    if (stavLib.isEmpty(next)) delete state.stav[id];
    else state.stav[id] = next;
    saveLocalStav();
    clearTimeout(state.saveTimers.get(id));
    state.saveTimers.set(id, setTimeout(() => pushRecord(id, stavLib.isEmpty(next) ? stavLib.emptyRecord() : next), 600));
    const m = mistoById.get(id);
    if (m) derive(m);
    invalidate();
    refreshMarker(id);
    renderFilters();
    renderCrumbs();
    if (state.view === 'table') renderTable();
  }
  function recordOf(id) {
    return state.stav[id] || null;
  }

  // ================================================================== místa (data + ručně přidaná) a odvozené údaje
  let mista = [];
  let mistoById = new Map();
  let znackyVse = [];

  function vlastniNaMisto(v) {
    const loc = najdiOkres(v.lon, v.lat);
    const sl = {};
    for (const k of vlastni.SLUZBY) if (v.sl && v.sl[k]) sl[k] = 'rucne';
    return {
      id: v.id,
      zdroj: 'vlastni',
      typ: v.typ || 'prodejna',
      nazev: v.nazev,
      lat: v.lat,
      lon: v.lon,
      okres: loc ? loc.okres : null,
      kraj: loc ? loc.kraj : null,
      obec: v.obec || null,
      adresa: v.adresa || null,
      tel: v.tel || [],
      mail: v.mail || [],
      web: v.web || [],
      sl,
      ico: v.ico || null,
      icoZdroj: v.ico ? 'rucne' : null,
      popis: v.poznamka || null,
      kdo: v.kdo,
      vytvoreno: v.vytvoreno,
    };
  }

  // Okres a kraj bodu (pro ručně přidaná místa) – bod v polygonu okresu.
  function najdiOkres(lon, lat) {
    for (const o of okresy) {
      if (geo.pointInGeometry(lon, lat, o.geometry)) return { okres: o.properties.kod, kraj: o.properties.kraj };
    }
    let best = null;
    for (const o of okresy) {
      const c = o.properties.stred;
      const d = geo.haversineM(lat, lon, c[0], c[1]);
      if (!best || d < best.d) best = { d, okres: o.properties.kod, kraj: o.properties.kraj };
    }
    return best;
  }

  function firmaPodleIco(ico) {
    if (!ico) return null;
    return state.firmyServer[ico] || firmyData[ico] || null;
  }

  // Odvozené údaje místa: platné IČO (ruční má přednost), firma, velikost, typ (naše firma), služby, hledání.
  function derive(m) {
    const r = state.stav[m.id];
    m._ico = (r && r.ico && vlastni.validIco(r.ico) ? r.ico : '') || m.ico || '';
    m._firma = firmaPodleIco(m._ico);
    const ob = m._ico ? state.obraty[m._ico] : null;
    m._obrat = ob || null;
    m._vel = vel.urci({ zam: m._firma && m._firma.zam, forma: m._firma && m._firma.forma, obrat: ob && ob.obrat, rok: ob && ob.rok, ico: m._ico });
    m._typ = m._ico && state.nastaveni.naseIco.includes(m._ico) ? 'nase' : m.typ;
    m._skryto = Boolean(r && r.skryto);
    m._faze = stavLib.faze(r);
    const w = weby[m.id];
    m._znacky = [...new Set([...(m.znacka ? [m.znacka] : []), ...((w && w.stav === 'ok' && w.znacky) || [])])];
    m._q = norm([m.nazev, m.obec, m.adresa, m._ico, m._firma && m._firma.nazev, m._znacky.join(' '), okresName(m.okres), (m.web || []).join(' '), TYP[m._typ] ? TYP[m._typ].one : ''].join(' | '));
  }

  function rebuild() {
    mista = D.mista.concat(Object.values(state.vlastni).map(vlastniNaMisto));
    mistoById = new Map(mista.map((m) => [m.id, m]));
    for (const m of mista) derive(m);
    const icoPocet = new Map();
    for (const m of mista) if (m._ico) icoPocet.set(m._ico, (icoPocet.get(m._ico) || 0) + 1);
    for (const m of mista) m._mist = m._ico ? icoPocet.get(m._ico) : 1;
    const zn = new Map();
    for (const m of mista) for (const z of m._znacky) zn.set(z, (zn.get(z) || 0) + 1);
    znackyVse = [...zn].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'cs'));
    markerCache.clear();
    prepocitejObjednavky();
    invalidate();
  }

  // Služba místa: { ano: true/false/null, zdroj }.
  function sluzba(m, k) {
    const v = m.sl ? m.sl[k] : null;
    if (!v) return { ano: null, zdroj: null };
    if (v === 'ne') return { ano: false, zdroj: 'OSM' };
    return { ano: true, zdroj: ZDROJ_SL[v] || v };
  }

  // Kontakt místa (ruční > OSM / ruční místo > web).
  function kontakt(m) {
    return stavLib.efektivni(m, state.stav[m.id], weby[m.id]);
  }

  // ================================================================== objednávky, poptávka, partneři
  // Co se v mapě počítá: objednávky, zákazníci nebo aktivní zákazníci (podle toho, co tabulka obsahovala).
  function metrikyDat() {
    return state.objednavky ? objLib.metrikyDatasetu(state.objednavky) : ['n'];
  }
  function metrika() {
    const m = metrikyDat();
    return m.includes(state.obj.metrika) ? state.obj.metrika : m[0];
  }
  // popisky vybrané veličiny: nadpis „Zákazníci“, mn „zákazníků“, instr „zákazníky“, kratce „zák.“
  function J() {
    return objLib.METRIKA[metrika()];
  }
  function popisDatasetu(d) {
    const casti = objLib.metrikyDatasetu(d).map((k) => `${fmtN(objLib.soucetDatasetu(d, k))} ${objLib.METRIKA[k].mn}`);
    if (d.castky) casti.push(vel.fmtObrat(objLib.soucetDatasetu(d, 'kc')));
    return `${casti.join(', ')} z ${fmtN(d.mista.length)} PSČ`;
  }

  let obj = { body: [], grid: null, obce: [], obecByKey: new Map(), vse: new Map(), poOkresech: new Map(), poKrajich: new Map(), celkem: 0, nezname: 0, kryti: [], krytiGrid: null, maxPop: 1 };

  function prepocitejObjednavky() {
    const d = state.objednavky;
    obj = { body: [], grid: null, obce: [], obecByKey: new Map(), vse: new Map(), poOkresech: new Map(), poKrajich: new Map(), celkem: 0, nezname: 0, kryti: [], krytiGrid: null, maxPop: 1 };
    if (d && Array.isArray(d.mista)) {
      const k = metrika();
      const mista = [];
      for (const x of d.mista) {
        const p = pscData[x.psc];
        const v = Number(x[k]) || 0;
        if (p) {
          // všechny veličiny po obcích (detail obce ukáže objednávky i zákazníky)
          const key = par.obecKey(p);
          const t = obj.vse.get(key) || { n: 0, zak: 0, akt: 0, kc: 0 };
          for (const m of ['n', 'zak', 'akt', 'kc']) t[m] += Number(x[m]) || 0;
          obj.vse.set(key, t);
        }
        if (v <= 0) continue;
        if (!p) {
          obj.nezname += v;
          continue;
        }
        mista.push({ psc: x.psc, n: v, kc: x.kc || 0 });
        obj.body.push({ psc: x.psc, lat: p[0], lon: p[1], okres: p[2], n: v, kc: x.kc || 0 });
        obj.celkem += v;
        obj.poOkresech.set(p[2], (obj.poOkresech.get(p[2]) || 0) + v);
        const kr = krajOkresu(p[2]);
        obj.poKrajich.set(kr, (obj.poKrajich.get(kr) || 0) + v);
      }
      obj.grid = par.mrizka(obj.body);
      const o = par.obce(mista, pscData);
      obj.obce = o.obce.map((x) => ({ ...x, kraj: krajOkresu(x.okres), pop: popObce.get(x.key) || 0 }));
      obj.obecByKey = new Map(obj.obce.map((x) => [x.key, x]));
    }
    prepocitejPokryti();
  }

  // Pokrytí = partneři (stav „Partner“) a naše prodejny. Pak poptávka a skóre u každého místa.
  function prepocitejPokryti() {
    obj.kryti = mista.filter((m) => m._faze === 'partner' || m._typ === 'nase');
    obj.krytiGrid = par.mrizka(obj.kryti);
    const R = state.obj.radiusKm;
    let max = 1;
    for (const m of mista) {
      m._pop = obj.grid ? par.poptavka(m.lat, m.lon, obj.grid, R) : { n: 0, kc: 0 };
      if (jeKandidat(m) && m._pop.n > max) max = m._pop.n;
    }
    obj.maxPop = max;
    for (const m of mista) m._skore = skoreMista(m);
    for (const o of obj.obce) {
      const nb = obj.krytiGrid.nejblizsi(o.lat, o.lon, Math.max(R * 4, 60));
      o.partnerKm = nb ? nb[1] : null;
      o.pokryto = nb ? nb[1] <= R : false;
    }
    invalidate();
  }

  // Kandidát na partnera: prodejna / servis / půjčovna / bazar / firma, ne řetězec, ne naše, ne skryté, ne odmítnuto.
  function jeKandidat(m) {
    if (m._skryto || m._typ === 'nase' || m._typ === 'retezec' || m._typ === 'jine') return false;
    if (m._faze === 'odmitl') return false;
    return true;
  }

  function skoreMista(m) {
    const R = state.obj.radiusKm;
    let partnerKm = null;
    if (obj.krytiGrid && obj.krytiGrid.size) {
      const near = obj.krytiGrid.okruh(m.lat, m.lon, R * 3).filter(([x]) => x.id !== m.id);
      if (near.length) partnerKm = near[0][1];
    }
    const k = kontakt(m);
    const s = sluzba(m, 'servis');
    return par.skore({ poptavka: m._pop ? m._pop.n : 0, maxPoptavka: obj.maxPop, popisek: J().nadpis + ' v okolí', servis: s.ano, partnerKm, radiusKm: R, email: Boolean(k.email), telefon: Boolean(k.telefon) });
  }

  // ================================================================== filtrování
  function inScope(kraj, okres) {
    if (state.scope.okres != null) return okres === state.scope.okres;
    if (state.scope.kraj != null) return kraj === state.scope.kraj;
    return true;
  }

  function passesFilters(m, ignoreScope) {
    const f = state.filters;
    if (!ignoreScope && !inScope(m.kraj, m.okres)) return false;
    if (!f.typy.has(m._typ)) return false;
    if (!f.velikosti.has(m._vel.key)) return false;
    if (!f.bezNazvu && m.bezNazvu) return false;
    if (!f.skryte && m._skryto) return false;
    for (const k of f.sluzby) if (sluzba(m, k).ano !== true) return false;
    if (f.znacka && !m._znacky.includes(f.znacka)) return false;
    if (f.kontakt !== 'vse') {
      const k = kontakt(m);
      if (f.kontakt === 'email' && !k.email) return false;
      if (f.kontakt === 'telefon' && !k.telefon) return false;
      if (f.kontakt === 'jakykoli' && !k.email && !k.telefon) return false;
      if (f.kontakt === 'zadny' && (k.email || k.telefon)) return false;
    }
    if (f.stav !== 'vse') {
      const r = state.stav[m.id];
      const has = Boolean(r && stavLib.STAV_KEYS.some((k) => r[k]));
      if (f.stav === 'sestavem' && !has) return false;
      if (f.stav === 'bezstavu' && has) return false;
      if (f.stav === 'rozpracovano' && !(has && !r.partner && !r.odmitl)) return false;
      if (stavLib.STAV_KEYS.includes(f.stav) && !(r && r[f.stav])) return false;
    }
    if (f.q && !m._q.includes(f.q)) return false;
    return true;
  }

  let cache = { key: null, mista: null };
  let cacheGen = 0;
  function invalidate() {
    cacheGen++;
  }
  function visible() {
    const f = state.filters;
    const key = JSON.stringify([cacheGen, state.scope, [...f.typy], [...f.velikosti], [...f.sluzby], f.znacka, f.kontakt, f.stav, f.bezNazvu, f.skryte, f.q]);
    if (cache.key === key) return cache;
    cache = { key, mista: mista.filter((m) => passesFilters(m, false)) };
    return cache;
  }

  // ================================================================== mapa
  let map;
  let krajeLayer;
  let okresyLayer;
  let labelsLayer;
  let objLayer;
  let mistaLayer;
  let odznakyLayer;
  let highlightLayer;
  const markerCache = new Map();
  const canvas = L.canvas({ padding: 0.3 });

  function initMap() {
    map = L.map('map', { zoomControl: true, preferCanvas: true, minZoom: 6, maxZoom: 19 });
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">přispěvatelé OpenStreetMap</a>', className: 'base-tiles' });
    const seda = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">přispěvatelé OpenStreetMap</a>', className: 'base-tiles tiles-gray' });
    const cyclosm = L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '<a href="https://www.cyclosm.org">CyclOSM</a> | &copy; přispěvatelé OpenStreetMap', className: 'base-tiles' });
    seda.addTo(map);
    L.control.layers({ 'Mapa šedá (OSM)': seda, 'Mapa barevná (OSM)': osm, 'Cyklomapa (CyclOSM)': cyclosm }, null, { position: 'topright', collapsed: true }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    krajeLayer = L.geoJSON(null, { style: krajStyle, onEachFeature: onKraj }).addTo(map);
    okresyLayer = L.geoJSON(null, { style: okresStyle, onEachFeature: onOkres }).addTo(map);
    labelsLayer = L.layerGroup().addTo(map);
    objLayer = L.layerGroup().addTo(map);
    mistaLayer = L.layerGroup().addTo(map);
    odznakyLayer = L.layerGroup().addTo(map);
    highlightLayer = L.layerGroup().addTo(map);
    map.fitBounds(L.geoJSON(D.hranice.kraje).getBounds(), { padding: [10, 10] });
    map.on('zoomend', () => {
      for (const [id, mk] of markerCache) {
        const m = mistoById.get(id);
        if (m) mk.setRadius(polomer(m));
      }
      if (choroplethOn()) {
        krajeLayer.setStyle(krajStyle);
        okresyLayer.setStyle(okresStyle);
      }
      renderObjednavky();
    });
    map.on('click', (e) => {
      if (!state.pick) return;
      const p = state.pick;
      state.pick = null;
      $('#map-wrap').classList.remove('picking');
      p.draft.lat = Math.round(e.latlng.lat * 1e5) / 1e5;
      p.draft.lon = Math.round(e.latlng.lng * 1e5) / 1e5;
      p.draft.polohaZdroj = 'mapa';
      openMistoModal(p.draft, p.id);
    });
  }

  // barva kraje / okresu podle objednávek (sekvenční škála)
  const SKALA = ['#fff4e6', '#ffd8a8', '#ffa94d', '#f76707', '#c2410c'];
  function objHodnota(level, kod) {
    const n = level === 'kraj' ? obj.poKrajich.get(kod) || 0 : obj.poOkresech.get(kod) || 0;
    if (!state.obj.naObyv) return n;
    let pop = 0;
    if (level === 'kraj') for (const o of okresyByKraj.get(kod) || []) pop += popOkresu.get(o.properties.kod) || 0;
    else pop = popOkresu.get(kod) || 0;
    return pop ? (n / pop) * 1000 : 0;
  }
  function skalaFor(level) {
    const items = level === 'kraj' ? kraje : okresyByKraj.get(state.scope.kraj) || [];
    const vals = items.map((f) => objHodnota(level, f.properties.kod)).filter((v) => v > 0).sort((a, b) => a - b);
    if (!vals.length) return null;
    const q = [0.2, 0.4, 0.6, 0.8].map((p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))]);
    return (v) => (v <= 0 ? null : SKALA[q.filter((t) => v > t).length]);
  }
  let skalaKraj = null;
  let skalaOkres = null;
  function choroplethOn() {
    return Boolean(state.objednavky && state.obj.choropleth && obj.celkem);
  }
  // výplň podle objednávek slábne s přiblížením, ať nepřekryje mapu
  function choroOpacity() {
    const z = map ? map.getZoom() : 7;
    return z <= 7 ? 0.5 : z <= 8 ? 0.42 : z <= 9 ? 0.32 : z <= 11 ? 0.2 : 0.1;
  }
  function krajStyle(f) {
    const active = state.scope.kraj == null || state.scope.kraj === f.properties.kod;
    const fill = choroplethOn() && state.scope.kraj == null && skalaKraj ? skalaKraj(objHodnota('kraj', f.properties.kod)) : null;
    return { color: '#1b2430', weight: state.scope.kraj == null ? 1.4 : 2.2, opacity: active ? 0.85 : 0.35, fillColor: fill || '#1f5fbf', fillOpacity: fill ? choroOpacity() : state.scope.kraj == null ? 0.05 : active ? 0 : 0.02 };
  }
  function okresStyle(f) {
    const active = state.scope.okres == null || state.scope.okres === f.properties.kod;
    const fill = choroplethOn() && skalaOkres ? skalaOkres(objHodnota('okres', f.properties.kod)) : null;
    return { color: '#1b2430', weight: 1, opacity: active ? 0.75 : 0.3, fillColor: fill || '#1f5fbf', fillOpacity: fill ? (state.scope.okres == null || active ? choroOpacity() : 0.12) : state.scope.okres == null ? 0.04 : active ? 0 : 0.02, dashArray: '4 3' };
  }
  function onKraj(f, layer) {
    layer.on({
      click: () => setScope(f.properties.kod, null),
      mouseover: (e) => {
        if (state.scope.kraj != null) return;
        e.target.setStyle({ weight: 2.6 });
      },
      mouseout: (e) => krajeLayer.resetStyle(e.target),
    });
    layer.bindTooltip(() => `<b>${esc(f.properties.nazev)}</b><br>${areaTooltip('kraj', f.properties.kod)}`, { sticky: true });
  }
  function onOkres(f, layer) {
    layer.on({
      click: () => setScope(f.properties.kraj, f.properties.kod),
      mouseover: (e) => {
        if (state.scope.okres != null) return;
        e.target.setStyle({ weight: 2 });
      },
      mouseout: (e) => okresyLayer.resetStyle(e.target),
    });
    layer.bindTooltip(() => `<b>${esc(f.properties.nazev)}</b><br>${areaTooltip('okres', f.properties.kod)}`, { sticky: true });
  }
  function countFor(level, kod) {
    let n = 0;
    for (const m of mista) if ((level === 'kraj' ? m.kraj : m.okres) === kod && passesFilters(m, true)) n++;
    return n;
  }
  function areaTooltip(level, kod) {
    const parts = [`${fmtN(countFor(level, kod))} míst ve výběru`];
    if (state.objednavky && obj.celkem) {
      const n = level === 'kraj' ? obj.poKrajich.get(kod) || 0 : obj.poOkresech.get(kod) || 0;
      parts.push(`${fmtN(n)} ${J().mn} (${fmtPct(n / obj.celkem)})`);
      if (state.obj.naObyv) parts.push(`${objHodnota(level, kod).toFixed(1).replace('.', ',')} na 1 000 obyvatel (orientačně)`);
    }
    return parts.join('<br>');
  }

  function renderBoundaries() {
    krajeLayer.clearLayers();
    okresyLayer.clearLayers();
    labelsLayer.clearLayers();
    skalaKraj = choroplethOn() ? skalaFor('kraj') : null;
    skalaOkres = choroplethOn() && state.scope.kraj != null ? skalaFor('okres') : null;
    krajeLayer.addData({ type: 'FeatureCollection', features: kraje });
    if (state.scope.kraj != null) okresyLayer.addData({ type: 'FeatureCollection', features: okresyByKraj.get(state.scope.kraj) || [] });
    const items = state.scope.kraj == null ? kraje : okresyByKraj.get(state.scope.kraj) || [];
    const level = state.scope.kraj == null ? 'kraj' : 'okres';
    if (state.scope.okres != null) return;
    for (const f of items) {
      const short = level === 'kraj' ? f.properties.nazev.replace(/ kraj$/, '').replace(/^Kraj /, '') : f.properties.nazev;
      const n = countFor(level, f.properties.kod);
      const o = state.objednavky && obj.celkem ? (level === 'kraj' ? obj.poKrajich.get(f.properties.kod) : obj.poOkresech.get(f.properties.kod)) || 0 : null;
      const icon = L.divIcon({ className: 'area-label', html: `<div class="lbl">${esc(short)}<small>${fmtN(n)} míst${o != null ? ' · ' + fmtN(o) + ' ' + J().kratce : ''}</small></div>`, iconSize: [140, 30], iconAnchor: [70, 15] });
      labelsLayer.addLayer(L.marker(f.properties.stred, { icon, interactive: false, keyboard: false }));
    }
  }

  function barvaMista(m) {
    if (state.barva === 'typ') return TYP[m._typ] ? TYP[m._typ].hex : '#495057';
    if (state.barva === 'stav') return m._faze ? STAV_BARVA[m._faze] : '#adb5bd';
    return VEL[m._vel.key].barva;
  }
  // Tečka místa: velikost podle kategorie firmy (menší při pohledu na celou ČR), barva podle zvoleného režimu,
  // okraj podle stavu spolupráce; sídla firem z ARES (provozovna může být jinde) jsou průhlednější s čárkovaným okrajem.
  function polomer(m) {
    const z = map ? map.getZoom() : 7;
    const k = z <= 7 ? 0.55 : z <= 8 ? 0.7 : z <= 10 ? 0.85 : 1;
    return Math.max(2.5, VEL[m._vel.key].r * k);
  }
  function stylMista(m) {
    const ares = m.zdroj === 'ares';
    return {
      renderer: canvas,
      radius: polomer(m),
      fillColor: barvaMista(m),
      fillOpacity: ares ? 0.5 : 0.92,
      color: m._faze && state.barva !== 'stav' ? STAV_BARVA[m._faze] : '#ffffff',
      weight: m._faze ? 2.5 : 1.2,
      opacity: 1,
      dashArray: ares && !m._faze ? '2 2' : null,
    };
  }
  function markerFor(m) {
    let mk = markerCache.get(m.id);
    if (!mk) {
      mk = L.circleMarker([m.lat, m.lon], stylMista(m));
      mk.bindTooltip(() => `<b>${esc(m.nazev)}</b><br>${esc(TYP[m._typ].one)} · ${esc(VEL[m._vel.key].label)}${m.obec ? ' · ' + esc(m.obec) : ''}${state.objednavky && m._pop && m._pop.n ? '<br>' + fmtN(m._pop.n) + ' ' + J().mn + ' do ' + state.obj.radiusKm + ' km' : ''}`);
      mk.on('click', () => select('misto', m.id, false));
      markerCache.set(m.id, mk);
    }
    return mk;
  }
  function refreshMarker(id) {
    const mk = markerCache.get(id);
    const m = mistoById.get(id);
    if (mk && m) mk.setStyle(stylMista(m));
    renderOdznaky();
  }
  function renderMista() {
    mistaLayer.clearLayers();
    const v = visible().mista;
    // větší a důležitější nakonec, ať jsou navrchu
    const order = v.slice().sort((a, b) => vel.PORADI[b._vel.key] - vel.PORADI[a._vel.key] || (a._faze ? 1 : 0) - (b._faze ? 1 : 0));
    for (const m of order) mistaLayer.addLayer(markerFor(m));
    renderOdznaky();
  }
  // odznaky nad tečkami: ★ partner, ⌂ naše prodejna
  function renderOdznaky() {
    odznakyLayer.clearLayers();
    for (const m of visible().mista) {
      const partner = m._faze === 'partner';
      if (!partner && m._typ !== 'nase') continue;
      const icon = L.divIcon({ className: '', html: `<div class="odznak ${partner ? 'partner' : 'nase'}">${partner ? '★' : '⌂'}</div>`, iconSize: [18, 18], iconAnchor: [9, 22] });
      const mk = L.marker([m.lat, m.lon], { icon, zIndexOffset: 700, keyboard: false });
      mk.bindTooltip(`<b>${esc(m.nazev)}</b><br>${partner ? 'Partner' : 'Naše prodejna'}`);
      mk.on('click', () => select('misto', m.id, false));
      odznakyLayer.addLayer(mk);
    }
  }

  // bubliny obcí podle objednávek (červený okraj = bez partnera / naší prodejny v okruhu)
  function renderObjednavky() {
    objLayer.clearLayers();
    if (!state.objednavky || !state.obj.bubliny || !obj.obce.length) return;
    const maxN = obj.obce[0].n || 1;
    const z = map.getZoom();
    const k = z <= 7 ? 0.7 : z <= 9 ? 0.85 : 1;
    // na celou ČR jen 250 obcí s nejvíc objednávkami (a všechna bílá místa), v kraji a okrese všechny
    const limit = state.scope.kraj == null ? 250 : Infinity;
    let shown = 0;
    for (const o of obj.obce) {
      if (!inScope(o.kraj, o.okres)) continue;
      const bilaObec = !o.pokryto && o.n >= state.obj.minN;
      if (shown >= limit && !bilaObec) continue;
      shown++;
      const r = Math.max(2.5, Math.min(40, (3 + 28 * Math.sqrt(o.n / maxN)) * k));
      const bila = bilaObec;
      const sel = state.selected && state.selected.type === 'obec' && state.selected.id === o.key;
      const c = L.circleMarker([o.lat, o.lon], { renderer: canvas, radius: r, color: bila ? '#c92a2a' : '#c2410c', weight: sel ? 3 : bila ? 1.6 : 0.8, dashArray: bila ? '3 3' : null, fillColor: '#f76707', fillOpacity: 0.28, opacity: 0.9 });
      c.bindTooltip(`<b>${esc(o.nazev)}</b> (${esc(okresName(o.okres))})<br>${fmtN(o.n)} ${J().mn}${o.kc ? ' · ' + esc(vel.fmtObrat(o.kc)) : ''}${o.pop >= 1000 ? '<br>' + ((o.n / o.pop) * 1000).toFixed(1).replace('.', ',') + ' na 1 000 obyvatel' : ''}<br>${o.pokryto ? 'partner / naše prodejna do ' + state.obj.radiusKm + ' km' : '<b style="color:#c92a2a">bez partnera do ' + state.obj.radiusKm + ' km</b>'}`, { sticky: true });
      c.on('click', () => select('obec', o.key, false));
      objLayer.addLayer(c);
    }
  }

  function renderHighlight() {
    highlightLayer.clearLayers();
    const s = state.selected;
    if (!s) return;
    const R = state.obj.radiusKm * 1000;
    if (s.type === 'misto') {
      const m = mistoById.get(s.id);
      if (!m) return;
      highlightLayer.addLayer(L.circleMarker([m.lat, m.lon], { radius: 18, color: '#1f5fbf', weight: 2.5, fill: false, interactive: false }));
      if (state.objednavky) highlightLayer.addLayer(L.circle([m.lat, m.lon], { radius: R, color: '#1f5fbf', weight: 1.2, dashArray: '5 5', fillOpacity: 0.04, interactive: false }));
    } else if (s.type === 'obec') {
      const o = obj.obecByKey.get(s.id);
      if (!o) return;
      highlightLayer.addLayer(L.circle([o.lat, o.lon], { radius: R, color: '#c2410c', weight: 1.5, dashArray: '5 5', fillOpacity: 0.05, interactive: false }));
    }
  }

  // ================================================================== scope (ČR → kraj → okres)
  function setScope(kraj, okres, keepSelection) {
    state.scope = { kraj: kraj == null ? null : Number(kraj), okres: okres == null ? null : Number(okres) };
    if (!keepSelection) state.selected = null;
    state.listLimit = 150;
    let bounds;
    if (state.scope.okres != null) bounds = L.geoJSON(okresByKod.get(state.scope.okres)).getBounds();
    else if (state.scope.kraj != null) bounds = L.geoJSON(krajByKod.get(state.scope.kraj)).getBounds();
    else bounds = L.geoJSON(D.hranice.kraje).getBounds();
    map.fitBounds(bounds, { padding: [16, 16] });
    renderAll();
    writeHash();
  }

  // ================================================================== výběr
  function select(type, id, fly) {
    state.selected = { type, id };
    if (fly !== false) {
      if (type === 'misto') {
        const m = mistoById.get(id);
        if (m) {
          if (!inScope(m.kraj, m.okres)) state.scope = { kraj: m.kraj, okres: m.okres };
          map.setView([m.lat, m.lon], Math.max(map.getZoom(), 13));
        }
      } else if (type === 'obec') {
        const o = obj.obecByKey.get(id);
        if (o) {
          if (!inScope(o.kraj, o.okres)) state.scope = { kraj: o.kraj, okres: null };
          map.setView([o.lat, o.lon], Math.max(map.getZoom(), 10));
        }
      }
    }
    renderAll();
    writeHash();
  }
  function clearSelection() {
    state.selected = null;
    renderAll();
    writeHash();
  }

  // ================================================================== URL hash
  function writeHash() {
    const p = new URLSearchParams();
    if (state.scope.kraj != null) p.set('kraj', state.scope.kraj);
    if (state.scope.okres != null) p.set('okres', state.scope.okres);
    if (state.selected) p.set(state.selected.type, state.selected.id);
    if (state.tab !== 'mista') p.set('tab', state.tab);
    if (state.view === 'table') p.set('view', 'table');
    const h = p.toString();
    if ('#' + h !== location.hash) history.replaceState(null, '', h ? '#' + h : location.pathname + location.search);
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.replace(/^#/, ''));
    const kraj = p.get('kraj');
    const okres = p.get('okres');
    if (kraj && krajByKod.has(Number(kraj))) state.scope.kraj = Number(kraj);
    if (okres && okresByKod.has(Number(okres))) {
      state.scope.okres = Number(okres);
      state.scope.kraj = okresByKod.get(Number(okres)).properties.kraj;
    }
    const mid = p.get('misto');
    if (mid) state.selected = { type: 'misto', id: mid };
    const oid = p.get('obec');
    if (oid) state.selected = { type: 'obec', id: oid };
    if (['mista', 'partneri', 'mesta'].includes(p.get('tab'))) state.tab = p.get('tab');
    if (p.get('view') === 'table') state.view = 'table';
  }

  // ================================================================== vykreslení
  function renderAll() {
    renderBoundaries();
    renderObjednavky();
    renderMista();
    renderHighlight();
    renderCrumbs();
    renderFilters();
    renderSide();
    if (state.view === 'table') renderTable();
    $('#btn-view').textContent = state.view === 'table' ? 'Mapa' : 'Tabulka';
    $('#table-wrap').classList.toggle('hidden', state.view !== 'table');
    $('#legend').classList.toggle('hidden', state.view === 'table');
    renderLegend();
  }

  function renderCrumbs() {
    const el = $('#crumbs');
    const parts = [];
    const v = visible();
    parts.push(crumb('Česká republika', state.scope.kraj == null, () => setScope(null, null)));
    if (state.scope.kraj != null) {
      parts.push('<span class="crumb-sep">›</span>');
      parts.push(crumb(krajName(state.scope.kraj), state.scope.okres == null, () => setScope(state.scope.kraj, null)));
    }
    if (state.scope.okres != null) {
      parts.push('<span class="crumb-sep">›</span>');
      parts.push(crumb(okresName(state.scope.okres), true, null));
    }
    const krajSel = `<select class="select nav-sel" id="nav-kraj" aria-label="Kraj"><option value="">– vybrat kraj –</option>${kraje.map((k) => `<option value="${k.properties.kod}" ${state.scope.kraj === k.properties.kod ? 'selected' : ''}>${esc(k.properties.nazev)}</option>`).join('')}</select>`;
    const okresSel = state.scope.kraj != null ? `<select class="select nav-sel" id="nav-okres" aria-label="Okres"><option value="">– celý kraj –</option>${(okresyByKraj.get(state.scope.kraj) || []).map((o) => `<option value="${o.properties.kod}" ${state.scope.okres === o.properties.kod ? 'selected' : ''}>${esc(o.properties.nazev)}</option>`).join('')}</select>` : '';
    el.innerHTML = parts.map((p) => (typeof p === 'string' ? p : p.html)).join('') + krajSel + okresSel + `<span class="muted small" style="margin-left:10px">${fmtN(v.mista.length)} míst</span>`;
    let i = 0;
    for (const p of parts) {
      if (typeof p === 'string') continue;
      const b = el.querySelectorAll('.crumb')[i++];
      if (p.onClick) b.addEventListener('click', p.onClick);
    }
    $('#nav-kraj').addEventListener('change', (e) => setScope(e.target.value ? Number(e.target.value) : null, null));
    const os = $('#nav-okres');
    if (os) os.addEventListener('change', (e) => setScope(state.scope.kraj, e.target.value ? Number(e.target.value) : null));
    const ml = $('#meta-line');
    const d = state.objednavky;
    ml.textContent = (meta.vytvoreno ? `data k ${new Date(meta.vytvoreno).toLocaleDateString('cs-CZ')}` : '') + (d ? ` · ${J().nadpis.toLowerCase()} ${d.od && d.do ? fmtDate(d.od) + '–' + fmtDate(d.do) : fmtN(objLib.soucetDatasetu(d, metrika()))}` : '');
  }
  function crumb(label, current, onClick) {
    return { html: `<button type="button" class="crumb" ${current ? 'aria-current="page"' : ''}>${esc(label)}</button>`, onClick: current ? null : onClick };
  }

  function renderLegend() {
    const el = $('#legend');
    const items = [];
    if (state.barva === 'velikost') for (const v of vel.VELIKOSTI) items.push(`<span class="item" title="${esc(v.popis)}"><span class="swatch dot" style="background:${v.barva};width:${Math.round(v.r * 1.6)}px;height:${Math.round(v.r * 1.6)}px"></span>${esc(v.label)}</span>`);
    else if (state.barva === 'typ') for (const t of TYPY) if (state.filters.typy.has(t.key)) items.push(`<span class="item"><span class="swatch dot" style="background:${t.hex}"></span>${esc(t.label)}</span>`);
    else {
      for (const s of stavLib.STAVY) items.push(`<span class="item"><span class="swatch dot" style="background:${s.barva}"></span>${esc(s.short)}</span>`);
      items.push('<span class="item"><span class="swatch dot" style="background:#adb5bd"></span>bez stavu</span>');
    }
    items.push('<span class="item"><span class="swatch dot" style="background:#868e9980;border:1px dashed #555"></span>sídlo firmy z ARES</span>');
    items.push('<span class="item"><span class="odznak partner" style="position:static">★</span>partner</span>');
    if (mista.some((m) => m._typ === 'nase')) items.push('<span class="item"><span class="odznak nase" style="position:static">⌂</span>naše prodejna</span>');
    if (state.objednavky && (state.obj.bubliny || state.obj.choropleth)) {
      items.push(`<span class="item"><span class="swatch dot" style="background:#f7670755;border:1px solid #c2410c"></span>${esc(J().nadpis.toLowerCase())} v obci</span>`);
      items.push(`<span class="item"><span class="swatch dot" style="background:#f7670733;border:1.5px dashed #c92a2a"></span>bez partnera do ${state.obj.radiusKm} km</span>`);
    }
    el.innerHTML = items.join('');
  }

  // ------------------------------------------------------------------ filtry (levý panel)
  let filtersBuilt = false;
  function renderFilters() {
    const root = $('#filters');
    const f = state.filters;
    const v = visible();
    if (!filtersBuilt) {
      root.innerHTML = `
        <div class="fgroup"><h3>Ve výběru</h3><div class="summary" id="summary"></div></div>
        <div class="fgroup"><h3>Barva značek podle</h3>
          <div class="seg" id="seg-barva"><button type="button" data-barva="velikost">velikosti</button><button type="button" data-barva="typ">typu</button><button type="button" data-barva="stav">spolupráce</button></div>
        </div>
        <div class="fgroup"><h3>Typ</h3>
          ${TYPY.map((t) => `<label class="check"><input type="checkbox" data-typ="${t.key}"><span class="swatch dot" style="background:${t.hex}"></span>${esc(t.label)}<span class="cnt" data-cnt-typ="${t.key}"></span></label>`).join('')}
        </div>
        <div class="fgroup"><h3>Velikost firmy</h3>
          ${vel.VELIKOSTI.map((x) => `<label class="check" title="${esc(x.popis)}"><input type="checkbox" data-vel="${x.key}"><span class="swatch dot" style="background:${x.barva}"></span>${esc(x.label)}<span class="cnt" data-cnt-vel="${x.key}"></span></label>`).join('')}
          <div class="muted small">Podle obratu (máme-li ho), jinak podle počtu zaměstnanců z ARES (ČSÚ). Najeďte myší na kategorii.</div>
        </div>
        <div class="fgroup"><h3>Musí nabízet</h3>
          ${SLUZBY.map((s) => `<label class="check"><input type="checkbox" data-sl="${s.key}">${esc(s.label)}<span class="cnt" data-cnt-sl="${s.key}"></span></label>`).join('')}
          <div class="muted small">Z OpenStreetMap a z textu webu prodejny.</div>
        </div>
        <div class="fgroup"><h3>Značka kol</h3><select class="select" id="f-znacka"></select></div>
        <div class="fgroup"><h3>Kontakt</h3>
          <select class="select" id="f-kontakt">
            <option value="vse">Vše</option><option value="jakykoli">S e-mailem nebo telefonem</option><option value="email">S e-mailem</option><option value="telefon">S telefonem</option><option value="zadny">Bez kontaktu</option>
          </select>
        </div>
        <div class="fgroup"><h3>Spolupráce</h3>
          <select class="select" id="f-stav">
            <option value="vse">Vše</option><option value="bezstavu">Bez stavu</option><option value="sestavem">S jakýmkoli stavem</option><option value="rozpracovano">Rozpracované (ne partner, ne odmítl)</option>
            ${stavLib.STAVY.map((s) => `<option value="${s.key}">${esc(s.label)}</option>`).join('')}
          </select>
          <label class="check small"><input type="checkbox" id="f-beznazvu">Zobrazit i místa bez názvu</label>
          <label class="check small"><input type="checkbox" id="f-skryte">Zobrazit i skrytá („není prodejna“)</label>
        </div>
        <div class="fgroup" id="fg-obj"></div>
        <div class="fgroup small muted" id="fg-sources"></div>`;
      filtersBuilt = true;
      root.addEventListener('change', onFilterChange);
      root.addEventListener('input', onFilterInput);
      root.querySelectorAll('#seg-barva button').forEach((b) => b.addEventListener('click', () => {
        state.barva = b.dataset.barva;
        markerCache.clear();
        saveUi();
        renderAll();
      }));
    }
    root.querySelectorAll('[data-typ]').forEach((i) => (i.checked = f.typy.has(i.dataset.typ)));
    root.querySelectorAll('[data-vel]').forEach((i) => (i.checked = f.velikosti.has(i.dataset.vel)));
    root.querySelectorAll('[data-sl]').forEach((i) => (i.checked = f.sluzby.has(i.dataset.sl)));
    root.querySelectorAll('#seg-barva button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.barva === state.barva)));
    $('#f-znacka').innerHTML = `<option value="">Všechny</option>${znackyVse.map(([z, n]) => `<option value="${esc(z)}">${esc(z)} (${n})</option>`).join('')}`;
    $('#f-znacka').value = f.znacka;
    $('#f-kontakt').value = f.kontakt;
    $('#f-stav').value = f.stav;
    $('#f-beznazvu').checked = f.bezNazvu;
    $('#f-skryte').checked = f.skryte;
    // počty: u každé volby kolik míst by bylo vidět s ostatními filtry
    const byTyp = {};
    const byVel = {};
    const bySl = {};
    for (const m of v.mista) {
      byTyp[m._typ] = (byTyp[m._typ] || 0) + 1;
      byVel[m._vel.key] = (byVel[m._vel.key] || 0) + 1;
      for (const s of SLUZBY) if (sluzba(m, s.key).ano === true) bySl[s.key] = (bySl[s.key] || 0) + 1;
    }
    root.querySelectorAll('[data-cnt-typ]').forEach((e) => (e.textContent = fmtN(byTyp[e.dataset.cntTyp] || 0)));
    root.querySelectorAll('[data-cnt-vel]').forEach((e) => (e.textContent = fmtN(byVel[e.dataset.cntVel] || 0)));
    root.querySelectorAll('[data-cnt-sl]').forEach((e) => (e.textContent = fmtN(bySl[e.dataset.cntSl] || 0)));
    const sum = stavLib.summary(Object.fromEntries(v.mista.filter((m) => state.stav[m.id]).map((m) => [m.id, state.stav[m.id]])));
    const sIco = v.mista.filter((m) => m._ico).length;
    $('#summary').innerHTML = `
      <div class="stat"><b>${fmtN(v.mista.length)}</b><span>míst</span></div>
      <div class="stat"><b>${fmtN(sIco)}</b><span>s IČO (velikost)</span></div>
      <div class="stat"><b>${fmtN(bySl.servis || 0)}</b><span>se servisem</span></div>
      <div class="stat"><b style="color:${STAV_BARVA.partner}">${fmtN(sum.partner)}</b><span>partnerů</span></div>
      <div class="stat"><b style="color:${STAV_BARVA.vytipovano}">${fmtN(sum.vytipovano)}</b><span>vytipováno</span></div>
      <div class="stat"><b style="color:${STAV_BARVA.osloveno}">${fmtN(sum.osloveno + sum.volano + sum.schuzka - 0)}</b><span>osloveno / voláno / schůzka</span></div>`;
    renderObjFilters();
    $('#fg-sources').innerHTML = `Zdroje: ${(meta.zdroje || []).map((z) => `<a href="${esc(z.url)}" target="_blank" rel="noopener">${esc(z.nazev)}</a>`).join(' · ')}.<br>Stav spolupráce, objednávky a ručně přidaná místa se ukládají ${state.server.on ? 'na server (sdílí celý tým)' : 'jen do tohoto prohlížeče'}.`;
  }

  function renderObjFilters() {
    const el = $('#fg-obj');
    const d = state.objednavky;
    if (!d) {
      el.innerHTML = `<h3>Objednávky a zákazníci</h3><div class="muted small">Zatím nenahrané. Tlačítkem <b>Objednávky</b> vložte tabulku z Excelu (i kontingenční) nebo nahrajte export z e-shopu – mapa ukáže obce podle počtu objednávek či zákazníků a seřadí kandidáty na partnery.</div>`;
      return;
    }
    const o = state.obj;
    const j = J();
    const volby = metrikyDat();
    el.innerHTML = `<h3>${esc(j.nadpis)} (${fmtN(obj.celkem)})</h3>
      ${volby.length > 1 ? `<label class="small muted" for="o-metrika">Počítat v mapě</label><select class="select" id="o-metrika" style="margin-bottom:6px">${volby.map((k) => `<option value="${k}" ${k === metrika() ? 'selected' : ''}>${esc(objLib.METRIKA[k].nadpis)} (${fmtN(objLib.soucetDatasetu(d, k))})</option>`).join('')}</select>` : ''}
      <label class="check"><input type="checkbox" id="o-bubliny" ${o.bubliny ? 'checked' : ''}><span class="swatch dot" style="background:#f7670788;border:1px solid #c2410c"></span>Obce podle počtu ${esc(j.mn)}</label>
      <label class="check"><input type="checkbox" id="o-choro" ${o.choropleth ? 'checked' : ''}><span class="swatch" style="background:linear-gradient(90deg,${SKALA.join(',')})"></span>Kraje / okresy podle ${esc(j.mn)}</label>
      <label class="check sub small"><input type="checkbox" id="o-obyv" ${o.naObyv ? 'checked' : ''}>na 1 000 obyvatel (orientačně)</label>
      <div class="stack-sm" style="margin-top:8px"><label class="small">Okruh partnera / poptávky: <b id="o-r-val">${o.radiusKm}</b> km</label><input type="range" class="range" id="o-r" min="5" max="50" step="5" value="${o.radiusKm}"></div>
      <div class="stack-sm" style="margin-top:6px"><label class="small">Bílé místo = obec s aspoň <b id="o-min-val">${o.minN}</b> ${esc(j.instr)} bez partnera v okruhu</label><input type="range" class="range" id="o-min" min="1" max="50" step="1" value="${o.minN}"></div>`;
  }

  function onFilterChange(e) {
    const t = e.target;
    const f = state.filters;
    if (t.dataset.typ) toggleSet(f.typy, t.dataset.typ, t.checked);
    else if (t.dataset.vel) toggleSet(f.velikosti, t.dataset.vel, t.checked);
    else if (t.dataset.sl) toggleSet(f.sluzby, t.dataset.sl, t.checked);
    else if (t.id === 'f-znacka') f.znacka = t.value;
    else if (t.id === 'f-kontakt') f.kontakt = t.value;
    else if (t.id === 'f-stav') f.stav = t.value;
    else if (t.id === 'f-beznazvu') f.bezNazvu = t.checked;
    else if (t.id === 'f-skryte') f.skryte = t.checked;
    else if (t.id === 'o-bubliny') state.obj.bubliny = t.checked;
    else if (t.id === 'o-choro') state.obj.choropleth = t.checked;
    else if (t.id === 'o-obyv') state.obj.naObyv = t.checked;
    else if (t.id === 'o-metrika') {
      state.obj.metrika = t.value;
      prepocitejObjednavky();
      markerCache.clear();
    } else if (t.id === 'o-r') {
      state.obj.radiusKm = Number(t.value);
      prepocitejPokryti();
      markerCache.clear();
    } else if (t.id === 'o-min') state.obj.minN = Number(t.value);
    else return;
    state.listLimit = 150;
    saveUi();
    renderAll();
  }
  function onFilterInput(e) {
    const t = e.target;
    if (t.id === 'o-r') $('#o-r-val').textContent = t.value;
    if (t.id === 'o-min') $('#o-min-val').textContent = t.value;
  }
  function toggleSet(set, key, on) {
    if (on) set.add(key);
    else set.delete(key);
  }

  // ------------------------------------------------------------------ pravý panel: záložky + seznamy
  function renderSide() {
    const v = visible();
    const tabs = $('#side-tabs');
    const nObce = obj.obce.filter((o) => inScope(o.kraj, o.okres)).length;
    tabs.innerHTML = [
      ['mista', 'Místa', v.mista.length],
      ['partneri', 'Partneři', v.mista.filter(jeKandidat).length],
      ['mesta', 'Města', nObce],
    ]
      .map(([k, l, n]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${state.tab === k}">${l}<span class="cnt">${fmtN(n)}</span></button>`)
      .join('');
    tabs.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      state.selected = null;
      state.listLimit = 150;
      renderAll();
      writeHash();
    }));
    const detail = $('#side-detail');
    const list = $('#side-list');
    if (state.selected) {
      detail.classList.remove('hidden');
      list.classList.add('hidden');
      renderDetail();
    } else {
      detail.classList.add('hidden');
      list.classList.remove('hidden');
      if (state.tab === 'partneri') renderPartneri();
      else if (state.tab === 'mesta') renderMesta();
      else renderList();
    }
  }

  function moreBtn(total) {
    return total > state.listLimit ? `<button type="button" class="more" id="more">Zobrazit dalších ${fmtN(Math.min(300, total - state.listLimit))} (z ${fmtN(total - state.listLimit)})</button>` : '';
  }
  function bindList(list, rerender) {
    list.querySelectorAll('.list-item').forEach((el) => el.addEventListener('click', (e) => {
      if (e.target.closest('[data-akce]')) return;
      select(el.dataset.type, el.dataset.id);
    }));
    const more = $('#more', list);
    if (more) more.addEventListener('click', () => {
      state.listLimit += 300;
      rerender();
    });
    list.querySelectorAll('[data-akce="vytipovat"]').forEach((b) => b.addEventListener('click', () => {
      updateRecord(b.dataset.id, (prev) => stavLib.toggleStav(prev, 'vytipovano', true));
      toast('Vytipováno: ' + (mistoById.get(b.dataset.id) || {}).nazev);
      rerender();
    }));
  }

  function renderList() {
    const v = visible();
    const list = $('#side-list');
    const items = sortMista(v.mista.slice());
    let html = `<div class="toolbar"><select class="select" id="sort-sel" aria-label="Řazení">
        <option value="nazev">podle názvu</option>
        <option value="velikost">podle velikosti</option>
        <option value="poptavka" ${state.objednavky ? '' : 'disabled'}>podle ${esc(J().mn)} v okolí</option>
        <option value="skore" ${state.objednavky ? '' : 'disabled'}>podle skóre partnera</option>
        <option value="stav">podle stavu spolupráce</option>
        <option value="typ">podle typu</option>
      </select><span class="muted small">${fmtN(items.length)} míst</span></div>`;
    if (!items.length) html += emptyHtml('Žádná místa neodpovídají filtrům.');
    for (const m of items.slice(0, state.listLimit)) html += mistoRow(m);
    html += moreBtn(items.length);
    list.innerHTML = html;
    const ss = $('#sort-sel');
    ss.value = state.sort;
    ss.addEventListener('change', () => {
      state.sort = ss.value;
      saveUi();
      renderList();
    });
    bindList(list, renderList);
  }
  function sortMista(arr) {
    const s = state.sort;
    const byName = (a, b) => a.nazev.localeCompare(b.nazev, 'cs');
    const fazeRank = { partner: 0, schuzka: 1, volano: 2, osloveno: 3, vytipovano: 4, odmitl: 6 };
    if (s === 'velikost') arr.sort((a, b) => vel.PORADI[a._vel.key] - vel.PORADI[b._vel.key] || (b._obrat ? b._obrat.obrat : 0) - (a._obrat ? a._obrat.obrat : 0) || byName(a, b));
    else if (s === 'poptavka') arr.sort((a, b) => (b._pop ? b._pop.n : 0) - (a._pop ? a._pop.n : 0) || byName(a, b));
    else if (s === 'skore') arr.sort((a, b) => b._skore.body - a._skore.body || byName(a, b));
    else if (s === 'stav') arr.sort((a, b) => (fazeRank[a._faze] ?? 5) - (fazeRank[b._faze] ?? 5) || byName(a, b));
    else if (s === 'typ') arr.sort((a, b) => TYPY.findIndex((t) => t.key === a._typ) - TYPY.findIndex((t) => t.key === b._typ) || byName(a, b));
    else arr.sort(byName);
    return arr;
  }
  function emptyHtml(text) {
    return `<div class="empty">${esc(text)}</div>`;
  }
  function stavBadges(id) {
    const r = state.stav[id];
    if (!r) return '';
    return stavLib.STAVY.filter((s) => r[s.key]).map((s) => `<span class="badge" style="background:${s.barva}22;color:${s.barva}">${esc(s.short)}</span>`).join('') + (r.skryto ? '<span class="badge danger">skryto</span>' : '');
  }
  // IČO odhadnuté podle jména a obce (a ne potvrzené ručně) → velikost s otazníkem
  function icoOdhad(m) {
    return m.icoZdroj === 'odhad' && m._ico === m.ico && !((recordOf(m.id) || {}).ico);
  }
  function velBadge(m) {
    const v = VEL[m._vel.key];
    const odhad = icoOdhad(m) && m._vel.key !== 'neznama';
    return `<span class="badge" style="background:${v.barva}22;color:${v.barva}" title="${esc(m._vel.duvod)}${odhad ? ' – IČO odhadnuto podle jména a obce, ověřte' : ''}">${esc(v.label)}${odhad ? '?' : ''}${m._mist >= 3 ? ' · ' + m._mist + ' prodejen' : ''}</span>`;
  }
  function slBadges(m) {
    return SLUZBY.filter((s) => sluzba(m, s.key).ano === true).map((s) => `<span class="badge info" title="podle: ${esc(sluzba(m, s.key).zdroj)}">${esc(s.label.toLowerCase())}</span>`).join('');
  }
  function mistoRow(m, extra) {
    const sel = state.selected && state.selected.type === 'misto' && state.selected.id === m.id;
    const sub = [TYP[m._typ].one, m.obec || okresName(m.okres), m._firma && m._firma.nazev && norm(m._firma.nazev) !== norm(m.nazev) ? m._firma.nazev : null].filter(Boolean).join(' · ');
    const right = extra != null ? extra : state.objednavky && m._pop ? `${fmtN(m._pop.n)} ${J().kratce}` : '';
    return `<div class="list-item${sel ? ' sel' : ''}" data-type="misto" data-id="${esc(m.id)}">
      <span class="dot${m.zdroj === 'ares' ? ' sq' : ''}" style="background:${barvaMista(m)}"></span>
      <span class="name">${esc(m.nazev)}</span>
      <span class="dist">${right}</span>
      <span class="sub">${esc(sub)}</span>
      <span class="badges">${velBadge(m)}${slBadges(m)}${stavBadges(m.id)}</span>
    </div>`;
  }

  // Partneři: kandidáti seřazení podle skóre
  function renderPartneri() {
    const list = $('#side-list');
    const R = state.obj.radiusKm;
    let items = visible().mista.filter(jeKandidat).filter((m) => m._faze !== 'partner');
    if (state.obj.jenBezPartnera) items = items.filter((m) => !m._skore.slozky.some((s) => s.key === 'pokryti' && s.body < 20));
    if (state.obj.jenServis) items = items.filter((m) => sluzba(m, 'servis').ano === true);
    items.sort((a, b) => b._skore.body - a._skore.body || a.nazev.localeCompare(b.nazev, 'cs'));
    const partneri = visible().mista.filter((m) => m._faze === 'partner').length;
    let html = `<div class="toolbar wrap">
      <label class="check small"><input type="checkbox" id="p-bez" ${state.obj.jenBezPartnera ? 'checked' : ''}>jen bez partnera do ${R} km</label>
      <label class="check small"><input type="checkbox" id="p-servis" ${state.obj.jenServis ? 'checked' : ''}>jen se servisem</label>
      <span class="muted small">${fmtN(items.length)} kandidátů · ${fmtN(partneri)} partnerů</span></div>`;
    if (!state.objednavky) html += `<div class="callout small" style="margin:10px 12px">Bez objednávek se řadí jen podle servisu, kontaktu a pokrytí. Nahrajte objednávky nebo zákazníky (tlačítko <b>Objednávky</b>) – skóre pak zohlední poptávku do ${R} km.</div>`;
    if (!items.length) html += emptyHtml('Žádní kandidáti – upravte filtry.');
    items.slice(0, state.listLimit).forEach((m, i) => {
      const sk = m._skore;
      const bar = sk.slozky.map((s) => `<span class="sk-${s.key}" style="width:${s.body}%" title="${esc(s.label)}: ${s.body} z ${s.max} b."></span>`).join('');
      html += `<div class="list-item cand" data-type="misto" data-id="${esc(m.id)}">
        <span class="rank">${i + 1}</span>
        <span class="name">${esc(m.nazev)}</span>
        <span class="dist"><b>${sk.body}</b> b.</span>
        <span class="sub">${esc([TYP[m._typ].one, m.obec || okresName(m.okres)].filter(Boolean).join(' · '))}${state.objednavky ? ` · ${fmtN(m._pop.n)} ${J().kratce} do ${R} km` : ''}</span>
        <span class="skbar">${bar}</span>
        <span class="badges">${velBadge(m)}${slBadges(m)}${stavBadges(m.id)}${m._faze ? '' : `<button type="button" class="btn btn-sm" data-akce="vytipovat" data-id="${esc(m.id)}">Vytipovat</button>`}</span>
      </div>`;
    });
    html += moreBtn(items.length);
    html += `<div class="muted small" style="padding:10px 12px">Skóre (0–100): ${esc(J().nadpis.toLowerCase())} do ${R} km (50 b.), servis (20 b.), žádný partner ani naše prodejna v okolí (20 b.), kontakt (10 b.). Okruh nastavíte vlevo v části Objednávky. Partner = stav „Partner – spolupráce domluvena“.</div>`;
    list.innerHTML = html;
    $('#p-bez').addEventListener('change', (e) => {
      state.obj.jenBezPartnera = e.target.checked;
      renderPartneri();
    });
    $('#p-servis').addEventListener('change', (e) => {
      state.obj.jenServis = e.target.checked;
      renderPartneri();
    });
    bindList(list, renderPartneri);
  }

  // Města podle objednávek
  function renderMesta() {
    const list = $('#side-list');
    const R = state.obj.radiusKm;
    if (!state.objednavky) {
      list.innerHTML = `<div class="empty">Objednávky ani zákazníci zatím nejsou nahraní.<br><br><button type="button" class="btn btn-primary" id="mesta-nahrat">Nahrát objednávky / zákazníky</button><br><br><span class="small">Vložte tabulku z Excelu (i kontingenční, obce nebo PSČ s počty) nebo export z e-shopu (CSV, XLSX). Na server se ukládají jen součty podle PSČ.</span></div>`;
      $('#mesta-nahrat').addEventListener('click', openObjModal);
      return;
    }
    let items = obj.obce.filter((o) => inScope(o.kraj, o.okres));
    const s = state.mestaSort;
    if (s === 'bila') items = items.filter((o) => !o.pokryto && o.n >= state.obj.minN);
    if (s === 'naObyv') items = items.filter((o) => o.pop >= 1000).sort((a, b) => b.n / b.pop - a.n / a.pop);
    const celkem = items.reduce((a, o) => a + o.n, 0);
    let html = `<div class="toolbar"><select class="select" id="mesta-sort">
      <option value="n">podle počtu ${esc(J().mn)}</option>
      <option value="bila">jen bílá místa (bez partnera do ${R} km)</option>
      <option value="naObyv">na 1 000 obyvatel (obce nad 1 000 obyv.)</option>
    </select><span class="muted small">${fmtN(items.length)} obcí · ${fmtN(celkem)} ${esc(J().kratce)}</span></div>`;
    if (!items.length) html += emptyHtml('Žádné obce.');
    for (const o of items.slice(0, state.listLimit)) {
      const sel = state.selected && state.selected.type === 'obec' && state.selected.id === o.key;
      const kolem = mista.filter((m) => jeKandidat(m) && par.km(o.lat, o.lon, m.lat, m.lon) <= R).length;
      html += `<div class="list-item${sel ? ' sel' : ''}" data-type="obec" data-id="${esc(o.key)}">
        <span class="dot" style="background:${o.pokryto ? '#f76707' : '#c92a2a'}"></span>
        <span class="name">${esc(o.nazev)}</span>
        <span class="dist"><b>${fmtN(o.n)}</b> ${esc(J().kratce)}</span>
        <span class="sub">${esc(okresName(o.okres))}${o.kc ? ' · ' + esc(vel.fmtObrat(o.kc)) : ''}${o.pop >= 1000 ? ' · ' + ((o.n / o.pop) * 1000).toFixed(1).replace('.', ',') + ' / 1 000 obyv.' : ''}</span>
        <span class="badges">${o.pokryto ? `<span class="badge ok">partner ${fmtKm(o.partnerKm * 1000)}</span>` : `<span class="badge danger">bez partnera do ${R} km</span>`}<span class="badge">${fmtN(kolem)} prodejen/servisů do ${R} km</span></span>
      </div>`;
    }
    html += moreBtn(items.length);
    list.innerHTML = html;
    const ms = $('#mesta-sort');
    ms.value = s;
    ms.addEventListener('change', () => {
      state.mestaSort = ms.value;
      state.listLimit = 150;
      renderAll();
    });
    bindList(list, renderMesta);
  }

  // ------------------------------------------------------------------ detail
  function renderDetail() {
    const root = $('#side-detail');
    const s = state.selected;
    if (!s) return;
    if (s.type === 'obec') renderObecDetail(root, obj.obecByKey.get(s.id));
    else renderMistoDetail(root, mistoById.get(s.id));
    root.scrollTop = 0;
  }
  function backBtn() {
    return '<button type="button" class="btn btn-sm" id="back">‹ Seznam</button>';
  }
  function bindBack(root) {
    const b = $('#back', root);
    if (b) b.addEventListener('click', clearSelection);
    root.querySelectorAll('[data-go-type]').forEach((el) => el.addEventListener('click', () => select(el.dataset.goType, el.dataset.goId)));
  }
  function linkify(url) {
    if (!url) return '';
    return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>`;
  }
  function telLinks(arr) {
    return arr.map((t) => `<a href="tel:${esc(t.replace(/\s/g, ''))}">${esc(t)}</a>`).join(', ');
  }
  function mailLinks(arr) {
    return arr.map((e) => `<a href="mailto:${esc(e)}">${esc(e)}</a>`).join(', ');
  }
  function searchLinks(m) {
    const q = encodeURIComponent([m.nazev, m.obec || okresName(m.okres)].filter(Boolean).join(' '));
    const ico = m._ico;
    return `<div class="links">
      <a href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener">Google</a>
      <a href="https://www.firmy.cz/?q=${q}" target="_blank" rel="noopener">Firmy.cz</a>
      <a href="https://mapy.cz/zakladni?q=${q}" target="_blank" rel="noopener">Mapy.cz</a>
      ${ico ? `<a href="https://ares.gov.cz/ekonomicke-subjekty?ico=${ico}" target="_blank" rel="noopener">ARES</a>
      <a href="https://or.justice.cz/ias/ui/rejstrik-$firma?ico=${ico}" target="_blank" rel="noopener">Justice – účetní závěrky</a>
      <a href="https://rejstrik-firem.kurzy.cz/${ico}/" target="_blank" rel="noopener">Kurzy.cz (obrat)</a>` : `<a href="https://ares.gov.cz/ekonomicke-subjekty?obchodniJmeno=${encodeURIComponent(m.nazev)}" target="_blank" rel="noopener">ARES</a>`}
    </div>`;
  }

  function renderMistoDetail(root, m) {
    if (!m) {
      root.innerHTML = `<div class="detail-head"><h2>Místo nenalezeno</h2>${backBtn()}</div>`;
      bindBack(root);
      return;
    }
    const r = recordOf(m.id) || stavLib.emptyRecord();
    const w = weby[m.id];
    const k = kontakt(m);
    const t = TYP[m._typ];
    const zdroj = m.zdroj === 'osm' ? `<a href="https://www.openstreetmap.org/${esc(m.osm)}" target="_blank" rel="noopener">OpenStreetMap ${esc(m.osm)}</a>` : m.zdroj === 'ares' ? 'ARES – sídlo firmy (provozovna může být jinde)' : `ručně přidáno${m.kdo ? ' (' + esc(m.kdo) + (m.vytvoreno ? ', ' + esc(fmtDate(m.vytvoreno)) : '') + ')' : ''}`;
    root.innerHTML = `
      <div class="detail-head"><h2>${esc(m.nazev)}</h2>${backBtn()}</div>
      <div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:10px">
        <span class="badge" style="background:${t.hex}22;color:${t.hex}">${esc(t.one)}</span>${velBadge(m)}${slBadges(m)}${stavBadges(m.id)}
      </div>
      <dl class="kv">
        <dt>Adresa</dt><dd>${esc(m.adresa || m.obec || '—')}</dd>
        <dt>Okres / kraj</dt><dd>${esc(okresName(m.okres))} · ${esc(krajName(m.kraj))}</dd>
        <dt>Telefon</dt><dd>${k.telefon ? telLinks(k.telefon.split(/,\s*/)) : '—'}</dd>
        <dt>E-mail</dt><dd>${k.email ? mailLinks(k.email.split(/,\s*/)) : '—'}</dd>
        <dt>Web</dt><dd>${(m.web || []).map(linkify).join('<br>') || (k.web ? linkify(k.web) : '—')}${(m.fb || []).length ? '<br>' + m.fb.map(linkify).join('<br>') : ''}</dd>
        ${m.oteviraci ? `<dt>Otevírací doba</dt><dd class="small">${esc(m.oteviraci)}</dd>` : ''}
        ${m.popis ? `<dt>Popis</dt><dd class="small">${esc(m.popis)}</dd>` : ''}
        <dt>Služby</dt><dd class="small">${SLUZBY.map((s) => { const x = sluzba(m, s.key); return x.ano === true ? `<b>${esc(s.label)}</b> <span class="muted">(${esc(x.zdroj)})</span>` : x.ano === false ? `<s>${esc(s.label)}</s> <span class="muted">(OSM)</span>` : null; }).filter(Boolean).join(', ') || '<span class="muted">nevíme</span>'}</dd>
        ${m._znacky.length ? `<dt>Značky</dt><dd class="small">${esc(m._znacky.join(', '))}</dd>` : ''}
        <dt>Zdroj</dt><dd class="small">${zdroj} · <a href="https://mapy.cz/zakladni?x=${m.lon}&y=${m.lat}&z=17&source=coor&id=${m.lon}%2C${m.lat}" target="_blank" rel="noopener">Mapy.cz</a></dd>
      </dl>
      ${m.zdroj === 'vlastni' ? `<div class="row" style="margin-top:8px"><button type="button" class="btn btn-sm" id="v-upravit">Upravit místo</button><button type="button" class="btn btn-sm btn-ghost" id="v-smazat">Smazat místo</button></div>` : ''}
      <div class="section"><h3>Firma a velikost</h3>${firmaHtml(m)}</div>
      ${state.objednavky ? `<div class="section"><h3>${esc(J().nadpis)} v okolí (do ${state.obj.radiusKm} km)</h3>${okoliObjHtml(m)}</div>` : ''}
      <div class="section"><h3>Další prodejny a servisy do 5 km</h3>${konkurenceHtml(m)}</div>
      <div class="section"><h3>Z webu (automaticky)</h3>${webHtml(m, w)}</div>
      <div class="section"><h3>Hledat na webu</h3>${searchLinks(m)}</div>
      <div class="section"><h3>Spolupráce</h3>${crmFormHtml(m, r, k)}</div>`;
    bindBack(root);
    bindFirma(root, m);
    bindCrmForm(root, m);
    const up = $('#v-upravit', root);
    if (up) up.addEventListener('click', () => openMistoModal({ ...state.vlastni[m.id] }, m.id));
    const del = $('#v-smazat', root);
    if (del) del.addEventListener('click', () => smazatVlastni(m.id));
    root.querySelectorAll('.list-item').forEach((el) => el.addEventListener('click', () => select(el.dataset.type, el.dataset.id)));
  }

  function firmaHtml(m) {
    const f = m._firma;
    const ob = m._obrat;
    const v = VEL[m._vel.key];
    const velikostRadek = `<dt>Velikost</dt><dd><span class="badge" style="background:${v.barva}22;color:${v.barva}">${esc(v.label)}</span> <span class="small muted">${esc(m._vel.duvod)}</span></dd>`;
    const obratForm = m._ico
      ? `<div class="row obrat-form" style="margin-top:8px;flex-wrap:wrap">
          <input class="input" id="obrat-val" style="width:150px" placeholder="obrat, např. 45 mil" value="${ob ? esc(String(ob.obrat)) : ''}">
          <input class="input" id="obrat-rok" style="width:80px" placeholder="rok" value="${ob && ob.rok ? esc(String(ob.rok)) : ''}">
          <button type="button" class="btn btn-sm" id="obrat-save">${ob ? 'Uložit obrat' : 'Doplnit obrat'}</button>
          ${ob ? '<button type="button" class="btn btn-sm btn-ghost" id="obrat-del">Smazat</button>' : ''}
        </div><div class="hint small muted">Obrat najdete v účetní závěrce (odkaz Justice níže) nebo na Kurzy.cz. Hromadně: Data → Obraty firem.</div>`
      : '';
    const icoForm = `<div class="row" style="margin-top:8px;flex-wrap:wrap"><input class="input" id="ico-val" style="width:130px" inputmode="numeric" placeholder="IČO" value="${esc((recordOf(m.id) || {}).ico || '')}"><button type="button" class="btn btn-sm" id="ico-save">${m._ico ? 'Změnit IČO' : 'Přiřadit IČO'}</button></div><div class="hint small muted">IČO bývá dole na webu prodejny nebo v obchodních podmínkách. ${state.server.registry ? 'Firma se pak dohledá v ARES.' : 'Údaje z ARES se doplní, až bude IČO v datech (server bez ARES).'}</div>`;
    if (!m._ico) return `<dl class="kv">${velikostRadek}</dl><div class="muted small" style="margin-top:6px">IČO zatím neznáme – z webu ani z ARES se nepodařilo spárovat.</div>${icoForm}`;
    if (!f) return `<dl class="kv"><dt>IČO</dt><dd>${esc(m._ico)}</dd>${velikostRadek}</dl><div class="muted small">Firma zatím není načtená z ARES.</div>${obratForm}${icoForm}`;
    const roky = f.vznik ? Math.floor((Date.now() - Date.parse(f.vznik)) / (365.25 * 86400000)) : null;
    const dalsi = m._mist > 1 ? mista.filter((x) => x._ico === m._ico && x.id !== m.id) : [];
    return `<dl class="kv">
        <dt>Firma</dt><dd><b>${esc(f.nazev)}</b></dd>
        <dt>IČO</dt><dd>${esc(m._ico)} <span class="muted small">(${esc({ osm: 'z OSM', web: 'z webu prodejny', nazev: 'podle shody názvu', odhad: 'odhad podle jména a obce – ověřte', ares: 'z ARES', rucne: 'zadáno ručně' }[(recordOf(m.id) || {}).ico ? 'rucne' : m.icoZdroj] || '')})</span></dd>
        <dt>Právní forma</dt><dd>${esc(pravniForma(f.forma))}${f.dph ? ' · plátce DPH' : ''}</dd>
        <dt>Sídlo</dt><dd class="small">${esc(f.sidlo || '—')}</dd>
        ${f.vznik ? `<dt>Vznik</dt><dd>${esc(fmtDate(f.vznik))}${roky != null ? ` <span class="muted small">(${roky} let)</span>` : ''}</dd>` : ''}
        <dt>Zaměstnanci</dt><dd>${esc(vel.zamestnanciText(f.zam) || 'neuvedeno')} <span class="muted small">(ČSÚ)</span></dd>
        <dt>Obrat</dt><dd>${ob ? `<b>${esc(vel.fmtObrat(ob.obrat))}</b>${ob.rok ? ' (' + ob.rok + ')' : ''} <span class="muted small">${esc([ob.zdroj, ob.kdo].filter(Boolean).join(', '))}</span>` : '<span class="muted">neznáme</span>'}</dd>
        ${velikostRadek}
        ${f.naceHlavni ? `<dt>Hlavní činnost</dt><dd class="small">CZ-NACE ${esc(f.naceHlavni)}</dd>` : ''}
        ${dalsi.length ? `<dt>Další místa</dt><dd class="small">${dalsi.slice(0, 12).map((x) => `<a href="#" data-go-type="misto" data-go-id="${esc(x.id)}">${esc(x.nazev)}${x.obec ? ' (' + esc(x.obec) + ')' : ''}</a>`).join(', ')}${dalsi.length > 12 ? ' …' : ''}</dd>` : ''}
      </dl>${obratForm}${icoForm}`;
  }

  function bindFirma(root, m) {
    root.querySelectorAll('a[data-go-type]').forEach((a) => a.addEventListener('click', (e) => e.preventDefault()));
    const save = $('#obrat-save', root);
    if (save) save.addEventListener('click', async () => {
      const kc = vel.parseObrat($('#obrat-val', root).value);
      if (kc == null) return toast('Obrat nejde přečíst – zadejte např. „45 mil“ nebo „45000000“.');
      const rokRaw = $('#obrat-rok', root).value.trim();
      await ulozObrat(m._ico, { obrat: kc, rok: rokRaw ? Number(rokRaw) : null, zdroj: 'ručně' });
    });
    const del = $('#obrat-del', root);
    if (del) del.addEventListener('click', () => ulozObrat(m._ico, null));
    const icoSave = $('#ico-save', root);
    if (icoSave) icoSave.addEventListener('click', async () => {
      const raw = $('#ico-val', root).value.trim();
      const ico = raw ? vlastni.normIco(raw) : '';
      if (raw && !ico) return toast('IČO nemá platný kontrolní součet.');
      updateRecord(m.id, (prev) => stavLib.setPole(prev, 'ico', ico));
      if (ico && !firmaPodleIco(ico)) await nactiFirmu(ico);
      rebuild();
      renderAll();
    });
  }

  async function nactiFirmu(ico) {
    if (!state.server.on || !state.server.registry) return null;
    try {
      const j = await api('GET', 'api/firma/' + ico);
      state.firmyServer[ico] = { ...j.firma, souradnice: j.souradnice || undefined };
      toast('Firma z ARES: ' + j.firma.nazev);
      return j;
    } catch (e) {
      toast(e.message);
      return null;
    }
  }

  async function ulozObrat(ico, rec) {
    if (!ico) return;
    if (rec) {
      const n = vlastni.normalizeObrat({ ...rec, kdo: state.server.user });
      if (n.chyba) return toast(n.chyba);
      state.obraty[ico] = n.obrat;
    } else delete state.obraty[ico];
    if (state.server.on) {
      try {
        if (rec) await api('PUT', 'api/obraty/' + ico, rec);
        else await api('DELETE', 'api/obraty/' + ico);
      } catch (e) {
        toast('Obrat se na server neuložil: ' + e.message);
      }
    } else lsSet(LS.obraty, state.obraty);
    rebuild();
    renderAll();
    toast(rec ? 'Obrat uložen.' : 'Obrat smazán.');
  }

  function okoliObjHtml(m) {
    const R = state.obj.radiusKm;
    const near = obj.grid ? obj.grid.okruh(m.lat, m.lon, R) : [];
    const n = near.reduce((s, [b]) => s + b.n, 0);
    const kc = near.reduce((s, [b]) => s + (b.kc || 0), 0);
    const obce = new Map();
    const nazvy = new Map();
    for (const [b] of near) {
      const p = pscData[b.psc];
      const key = par.obecKey(p);
      nazvy.set(key, p[3]);
      obce.set(key, (obce.get(key) || 0) + b.n);
    }
    const top = [...obce].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const sk = m._skore;
    return `<div class="row" style="gap:16px;flex-wrap:wrap"><div class="stat"><b>${fmtN(n)}</b><span>${esc(J().mn)} (${fmtPct(n / Math.max(1, obj.celkem))} všech)</span></div>${kc ? `<div class="stat"><b>${esc(vel.fmtObrat(kc))}</b><span>za objednávky</span></div>` : ''}<div class="stat"><b>${sk.body}</b><span>skóre partnera</span></div></div>
      ${top.length ? `<div class="small" style="margin-top:6px">${top.map(([key, c]) => `<a href="#" data-go-type="obec" data-go-id="${esc(key)}">${esc(nazvy.get(key))}</a> ${fmtN(c)}`).join(' · ')}</div>` : ''}
      <ul class="near-list small" style="margin-top:6px">${sk.slozky.map((s) => `<li><span>${esc(s.label)}</span><span class="nowrap">${s.body} / ${s.max} b.</span></li>`).join('')}</ul>`;
  }

  function konkurenceHtml(m) {
    const near = mista
      .filter((x) => x.id !== m.id && !x._skryto && x._typ !== 'firma' && Math.abs(x.lat - m.lat) < 0.06 && Math.abs(x.lon - m.lon) < 0.09)
      .map((x) => [x, par.km(m.lat, m.lon, x.lat, x.lon)])
      .filter(([, d]) => d <= 5)
      .sort((a, b) => a[1] - b[1]);
    if (!near.length) return '<div class="muted small">Do 5 km žádná další prodejna ani servis v datech.</div>';
    return near.slice(0, 10).map(([x, d]) => mistoRow(x, fmtKm(d * 1000))).join('') + (near.length > 10 ? `<div class="muted small" style="padding:6px 0">… a dalších ${near.length - 10}</div>` : '');
  }

  function webHtml(m, w) {
    if (!(m.web || []).length) return '<div class="muted small">Místo nemá v datech web – zkuste odkazy níže.</div>';
    if (!w) return '<div class="muted small">Web ještě nebyl projitý (proběhne při příští obnově dat).</div>';
    if (w.stav !== 'ok') return `<div class="muted small">Web ${esc(w.web)} se nepodařilo načíst (${esc(w.chyba || 'chyba')}) – ${esc(fmtDate(w.kdy))}.</div>`;
    const parts = [];
    if (w.emaily && w.emaily.length) parts.push(`<div><b>E-maily:</b> ${mailLinks(w.emaily)}</div>`);
    if (w.telefony && w.telefony.length) parts.push(`<div><b>Telefony:</b> ${telLinks(w.telefony)}</div>`);
    if (w.ico && w.ico.length) parts.push(`<div><b>IČO na webu:</b> ${esc(w.ico.join(', '))}</div>`);
    if (w.provozovatel) parts.push(`<div><b>Provozovatel (text webu):</b> ${esc(w.provozovatel)}</div>`);
    const sl = w.sluzby || {};
    const found = SLUZBY.filter((s) => sl[s.key]).map((s) => s.label);
    parts.push(`<div><b>Web zmiňuje:</b> ${found.length ? esc(found.join(', ')) : 'nic z servis / e-kola / půjčovna / bazar / e-shop'}</div>`);
    for (const [key, txt] of Object.entries(w.ukazky || {})) if (txt) parts.push(`<div class="snippet">${esc(key)}: „…${esc(txt)}…“</div>`);
    if (w.znacky && w.znacky.length) parts.push(`<div><b>Značky:</b> ${esc(w.znacky.join(', '))}</div>`);
    return `<div class="enrich">${parts.join('')}<div class="muted small" style="margin-top:6px">${esc(w.web)} · ${w.stranky} str. · ${esc(fmtDate(w.kdy))}</div></div>
      <div class="row" style="margin-top:8px"><button type="button" class="btn btn-sm" id="take-web">Převzít kontakty do spolupráce</button><span class="muted small">doplní jen prázdná pole</span></div>`;
  }

  function crmFormHtml(m, r, k) {
    return `
      <div id="crm-states">${stavLib.STAVY.map((s) => `<label class="state-check${r[s.key] ? ' on' : ''}"><input type="checkbox" data-stav="${s.key}" ${r[s.key] ? 'checked' : ''}><span class="swatch dot" style="background:${s.barva}"></span><span>${esc(s.label)}</span><span class="date">${r.datumy && r.datumy[s.key] ? esc(fmtDate(r.datumy[s.key])) : ''}</span></label>`).join('')}</div>
      <div class="field"><label>Typ spolupráce</label><select class="select" data-pole="spoluprace">${stavLib.SPOLUPRACE.map((s) => `<option value="${s.key}" ${r.spoluprace === s.key ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select></div>
      <div class="field"><label>Poznámka</label><textarea class="input" rows="3" data-pole="poznamka" placeholder="Kdo, kdy, co domluveno, podmínky…">${esc(r.poznamka)}</textarea></div>
      <div class="field"><label>Kontaktní osoba</label><input class="input" data-pole="osoba" value="${esc(r.osoba)}" placeholder="jméno, funkce"></div>
      <div class="field"><label>Telefon</label><input class="input" data-pole="telefon" value="${esc(r.telefon)}" placeholder="${esc(k.telefon || '')}"></div>
      <div class="field"><label>E-mail</label><input class="input" data-pole="email" value="${esc(r.email)}" placeholder="${esc(k.email || '')}"></div>
      <div class="field"><label>Web</label><input class="input" data-pole="web" value="${esc(r.web)}" placeholder="${esc(k.web || '')}"><span class="hint">Šedé hodnoty jsou z dat (OSM / web); vlastní zápis má přednost.</span></div>
      <label class="check small"><input type="checkbox" id="crm-skryto" ${r.skryto ? 'checked' : ''}>Skrýt z mapy – není to prodejna ani servis kol</label>
      <div class="row between" style="margin-top:6px"><span class="saved" id="saved">${r.upraveno ? 'Uloženo ' + esc(fmtDateTime(r.upraveno)) + (r.kdo ? ' · ' + esc(r.kdo) : '') : ''}</span>${stavLib.isEmpty(r) ? '' : '<button type="button" class="btn btn-sm btn-ghost" id="crm-clear">Smazat záznam</button>'}</div>`;
  }
  function bindCrmForm(root, m) {
    const id = m.id;
    root.querySelectorAll('[data-stav]').forEach((i) => i.addEventListener('change', () => {
      updateRecord(id, (prev) => stavLib.toggleStav(prev, i.dataset.stav, i.checked));
      if (i.dataset.stav === 'partner' || i.dataset.stav === 'odmitl') {
        prepocitejPokryti();
        renderAll();
        return;
      }
      renderDetail();
    }));
    root.querySelectorAll('[data-pole]').forEach((i) => {
      const handler = debounce(() => {
        updateRecord(id, (prev) => stavLib.setPole(prev, i.dataset.pole, i.value));
        markSaved(root);
      }, 400);
      i.addEventListener('input', handler);
      i.addEventListener('change', handler);
    });
    const sk = $('#crm-skryto', root);
    if (sk) sk.addEventListener('change', () => {
      updateRecord(id, (prev) => stavLib.setPole(prev, 'skryto', sk.checked));
      toast(sk.checked ? 'Místo je skryté (zobrazíte ho filtrem „Zobrazit i skrytá“).' : 'Místo je zase vidět.');
      renderAll();
    });
    const clear = $('#crm-clear', root);
    if (clear) clear.addEventListener('click', () => {
      if (!confirm('Smazat stav spolupráce, poznámku i ruční kontakty u tohoto místa?')) return;
      updateRecord(id, () => stavLib.emptyRecord());
      rebuild();
      renderAll();
    });
    const take = $('#take-web', root);
    const w = weby[id];
    if (take && w) take.addEventListener('click', () => {
      updateRecord(id, (prev) => {
        let next = stavLib.normalizeRecord(prev);
        const now = new Date().toISOString();
        if (!next.telefon && !(m.tel || []).length && w.telefony && w.telefony.length) next = stavLib.setPole(next, 'telefon', w.telefony.slice(0, 2).join(', '), now);
        if (!next.email && !(m.mail || []).length && w.emaily && w.emaily.length) next = stavLib.setPole(next, 'email', w.emaily.slice(0, 2).join(', '), now);
        return next;
      });
      renderDetail();
      toast('Kontakty z webu převzaty.');
    });
  }
  function markSaved(root) {
    const el = $('#saved', root);
    if (el) el.textContent = 'Uloženo ' + fmtDateTime(new Date().toISOString()) + (state.server.user ? ' · ' + state.server.user : '');
  }

  function renderObecDetail(root, o) {
    if (!o) {
      root.innerHTML = `<div class="detail-head"><h2>Obec nenalezena</h2>${backBtn()}</div><div class="muted">Objednávky se možná změnily.</div>`;
      bindBack(root);
      return;
    }
    const R = state.obj.radiusKm;
    const kandidati = mista
      .filter((m) => !m._skryto && m._typ !== 'retezec' && Math.abs(m.lat - o.lat) < R / 100 && Math.abs(m.lon - o.lon) < R / 60)
      .map((m) => [m, par.km(o.lat, o.lon, m.lat, m.lon)])
      .filter(([, d]) => d <= R)
      .sort((a, b) => (b[0]._faze === 'partner') - (a[0]._faze === 'partner') || b[0]._skore.body - a[0]._skore.body || a[1] - b[1]);
    const popTxt = o.pop >= 1000 ? `<div class="stat"><b>${((o.n / o.pop) * 1000).toFixed(1).replace('.', ',')}</b><span>na 1 000 obyvatel (${fmtN(o.pop)} obyv.)</span></div>` : '';
    root.innerHTML = `
      <div class="detail-head"><h2>${esc(o.nazev)}</h2>${backBtn()}</div>
      <div class="muted small" style="margin-bottom:8px">${esc(okresName(o.okres))} · ${esc(krajName(o.kraj))} · PSČ ${esc(o.psc.slice(0, 8).join(', '))}${o.psc.length > 8 ? ' …' : ''}</div>
      <div class="summary">
        <div class="stat"><b>${fmtN(o.n)}</b><span>${esc(J().mn)} (${fmtPct(o.n / Math.max(1, obj.celkem))})</span></div>
        ${metrikyDat().filter((k) => k !== metrika()).map((k) => `<div class="stat"><b>${fmtN((obj.vse.get(o.key) || {})[k])}</b><span>${esc(objLib.METRIKA[k].mn)}</span></div>`).join('')}
        ${o.kc ? `<div class="stat"><b>${esc(vel.fmtObrat(o.kc))}</b><span>hodnota objednávek</span></div>` : ''}
        ${popTxt}
        <div class="stat"><b style="color:${o.pokryto ? 'var(--success)' : 'var(--danger)'}">${o.partnerKm != null ? fmtKm(o.partnerKm * 1000) : '—'}</b><span>k nejbližšímu partnerovi / naší prodejně</span></div>
      </div>
      <div class="section"><h3>Prodejny a servisy do ${R} km (${fmtN(kandidati.length)}) – seřazeno podle skóre</h3>
        ${kandidati.length ? kandidati.slice(0, 60).map(([m, d]) => mistoRow(m, `${fmtKm(d * 1000)} · ${m._skore.body} b.`)).join('') : '<div class="muted small">V okruhu není žádná prodejna ani servis v datech. Zkuste větší okruh, nebo přidejte místo ručně (+ Místo).</div>'}
      </div>`;
    bindBack(root);
    root.querySelectorAll('.list-item').forEach((el) => el.addEventListener('click', () => select(el.dataset.type, el.dataset.id)));
  }

  // ------------------------------------------------------------------ tabulka
  const ANO = (b) => (b === true ? 'ano' : b === false ? 'ne' : '');
  const COLUMNS = [
    { key: 'nazev', label: 'Název', get: (m) => m.nazev },
    { key: 'typ', label: 'Typ', get: (m) => TYP[m._typ].one },
    { key: 'velikost', label: 'Velikost', get: (m) => VEL[m._vel.key].label, sortGet: (m) => vel.PORADI[m._vel.key] },
    { key: 'duvod', label: 'Velikost podle', get: (m) => m._vel.duvod },
    { key: 'zam', label: 'Zaměstnanci (ČSÚ)', get: (m) => (m._firma ? vel.zamestnanciText(m._firma.zam) : '') },
    { key: 'obrat', label: 'Obrat (Kč)', get: (m) => (m._obrat ? String(m._obrat.obrat) : ''), sortGet: (m) => (m._obrat ? m._obrat.obrat : -1) },
    { key: 'obratRok', label: 'Obrat – rok', get: (m) => (m._obrat && m._obrat.rok ? String(m._obrat.rok) : '') },
    { key: 'ico', label: 'IČO', get: (m) => m._ico },
    { key: 'firma', label: 'Firma (ARES)', get: (m) => (m._firma ? m._firma.nazev : '') },
    { key: 'forma', label: 'Právní forma', get: (m) => (m._firma ? pravniForma(m._firma.forma) : '') },
    { key: 'mist', label: 'Míst firmy', get: (m) => (m._ico ? String(m._mist) : ''), sortGet: (m) => m._mist },
    { key: 'obec', label: 'Obec', get: (m) => m.obec || '' },
    { key: 'adresa', label: 'Adresa', get: (m) => m.adresa || '' },
    { key: 'okres', label: 'Okres', get: (m) => okresName(m.okres) },
    { key: 'kraj', label: 'Kraj', get: (m) => krajName(m.kraj) },
    { key: 'telefon', label: 'Telefon', get: (m) => kontakt(m).telefon },
    { key: 'email', label: 'E-mail', get: (m) => kontakt(m).email },
    { key: 'web', label: 'Web', get: (m) => kontakt(m).web },
    ...SLUZBY.map((s) => ({ key: 'sl_' + s.key, label: s.label, get: (m) => ANO(sluzba(m, s.key).ano) })),
    { key: 'znacky', label: 'Značky', get: (m) => m._znacky.join(', '), wrap: true },
    { key: 'poptavka', get label() { return J().nadpis + ' v okolí'; }, get: (m) => (state.objednavky && m._pop ? String(m._pop.n) : ''), sortGet: (m) => (m._pop ? m._pop.n : 0) },
    { key: 'skore', label: 'Skóre partnera', get: (m) => String(m._skore ? m._skore.body : ''), sortGet: (m) => (m._skore ? m._skore.body : 0) },
    ...stavLib.STAVY.map((s) => ({ key: s.key, label: s.label, stav: true, get: (m) => (state.stav[m.id] && state.stav[m.id][s.key] ? 'ano' + (state.stav[m.id].datumy[s.key] ? ' (' + fmtDate(state.stav[m.id].datumy[s.key]) + ')' : '') : ''), sortGet: (m) => (state.stav[m.id] && state.stav[m.id][s.key] ? 0 : 1) })),
    { key: 'spoluprace', label: 'Typ spolupráce', get: (m) => { const r = state.stav[m.id]; const s = r && stavLib.SPOLUPRACE.find((x) => x.key === r.spoluprace); return s && s.key ? s.label : ''; } },
    { key: 'osoba', label: 'Kontaktní osoba', get: (m) => (state.stav[m.id] ? state.stav[m.id].osoba : '') },
    { key: 'poznamka', label: 'Poznámka', get: (m) => (state.stav[m.id] ? state.stav[m.id].poznamka : ''), wrap: true },
    { key: 'kdo', label: 'Upravil', get: (m) => (state.stav[m.id] ? state.stav[m.id].kdo || '' : '') },
    { key: 'upraveno', label: 'Upraveno', get: (m) => (state.stav[m.id] && state.stav[m.id].upraveno ? fmtDateTime(state.stav[m.id].upraveno) : ''), sortGet: (m) => (state.stav[m.id] && state.stav[m.id].upraveno ? Date.parse(state.stav[m.id].upraveno) : 0) },
    { key: 'zdroj', label: 'Zdroj', get: (m) => (m.zdroj === 'osm' ? 'https://www.openstreetmap.org/' + m.osm : m.zdroj === 'ares' ? 'ARES (sídlo)' : 'ručně') },
    { key: 'lat', label: 'Zem. šířka', get: (m) => String(m.lat) },
    { key: 'lon', label: 'Zem. délka', get: (m) => String(m.lon) },
  ];
  function sortedTable() {
    const { key, dir } = state.tableSort;
    const col = COLUMNS.find((c) => c.key === key) || COLUMNS[0];
    const get = col.sortGet || col.get;
    const arr = visible().mista.slice();
    arr.sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (typeof va === 'number' || typeof vb === 'number') return (va - vb) * dir || a.nazev.localeCompare(b.nazev, 'cs');
      return String(va).localeCompare(String(vb), 'cs') * dir || a.nazev.localeCompare(b.nazev, 'cs');
    });
    return arr;
  }
  function renderTable() {
    const wrap = $('#table-wrap');
    const rows = sortedTable();
    const limit = Math.min(rows.length, state.tableLimit);
    const head = COLUMNS.map((c) => `<th data-col="${c.key}" class="${state.tableSort.key === c.key ? 'sorted' : ''}">${esc(c.label)}${state.tableSort.key === c.key ? (state.tableSort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
    const body = rows
      .slice(0, limit)
      .map((m) => `<tr>${COLUMNS.map((c) => {
        if (c.stav) {
          const r = state.stav[m.id];
          return `<td><input type="checkbox" data-stav="${c.key}" data-id="${esc(m.id)}" ${r && r[c.key] ? 'checked' : ''} aria-label="${esc(c.label)}"></td>`;
        }
        const v = c.get(m);
        if (c.key === 'nazev') return `<td><button type="button" class="name-btn" data-open="${esc(m.id)}">${esc(v)}</button></td>`;
        if ((c.key === 'web' || c.key === 'zdroj') && /^https?:/.test(v)) return `<td><a href="${esc(v)}" target="_blank" rel="noopener">${esc(trunc(v.replace(/^https?:\/\/(www\.)?/, ''), 40))}</a></td>`;
        if (c.key === 'velikost') return `<td><span class="swatch dot" style="background:${VEL[m._vel.key].barva}"></span> ${esc(v)}</td>`;
        return `<td class="${c.wrap ? 'wrap' : ''}">${esc(c.wrap ? trunc(v, 160) : v)}</td>`;
      }).join('')}</tr>`)
      .join('');
    wrap.innerHTML = `<div class="toolbar"><b>${fmtN(rows.length)} míst</b><span class="muted small">zobrazeno ${fmtN(limit)} · klik na záhlaví řadí · zaškrtávátka se rovnou ukládají</span>${rows.length > limit ? '<button type="button" class="btn btn-sm" id="table-more">Zobrazit dalších 500</button>' : ''}<span style="flex:1"></span><button type="button" class="btn btn-sm" id="table-export">Export CSV (${fmtN(rows.length)})</button></div>
      <table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    wrap.querySelectorAll('th').forEach((th) => th.addEventListener('click', () => {
      const k = th.dataset.col;
      if (state.tableSort.key === k) state.tableSort.dir *= -1;
      else state.tableSort = { key: k, dir: ['velikost', 'obrat', 'poptavka', 'skore', 'mist'].includes(k) ? (k === 'velikost' ? 1 : -1) : 1 };
      renderTable();
    }));
    wrap.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
      state.view = 'map';
      select('misto', b.dataset.open);
      setTimeout(() => map.invalidateSize(), 50);
    }));
    wrap.querySelectorAll('input[data-stav]').forEach((i) => i.addEventListener('change', () => {
      updateRecord(i.dataset.id, (prev) => stavLib.toggleStav(prev, i.dataset.stav, i.checked));
      if (i.dataset.stav === 'partner') prepocitejPokryti();
    }));
    const more = $('#table-more');
    if (more) more.addEventListener('click', () => {
      state.tableLimit += 500;
      renderTable();
    });
    $('#table-export').addEventListener('click', exportCsv);
  }

  function scopeName() {
    return state.scope.okres != null ? okresName(state.scope.okres) : state.scope.kraj != null ? krajName(state.scope.kraj) : 'CR';
  }
  function exportCsv() {
    const rows = state.view === 'table' ? sortedTable() : sortMista(visible().mista.slice());
    const data = [COLUMNS.map((c) => c.label)];
    for (const m of rows) data.push(COLUMNS.map((c) => c.get(m)));
    download(`prodejny-${norm(scopeName()).replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.csv`, csvLib.serialize(data), 'text/csv;charset=utf-8');
    toast(`Exportováno ${fmtN(rows.length)} míst.`);
  }

  // ================================================================== OBJEDNÁVKY – import (jen součty podle PSČ)
  function openObjModal() {
    const d = state.objednavky;
    const body = `
      ${d ? `<div class="callout small" style="margin-bottom:10px"><b>Nahráno:</b> ${esc(popisDatasetu(d))}${d.nazev ? ` – „${esc(d.nazev)}“` : ''}${d.od && d.do ? `, období ${esc(fmtDate(d.od))} – ${esc(fmtDate(d.do))}` : ''}${d.soubor && d.soubor !== d.nazev ? `, zdroj ${esc(d.soubor)}` : ''}${d.kdo ? `, nahrál(a) ${esc(d.kdo)}` : ''}${d.nahrano ? ' ' + esc(fmtDateTime(d.nahrano)) : ''}.${d.nezarazeno ? ` Nepřiřazeno ${fmtN(d.nezarazeno)}.` : ''}${d.zahranici ? ` Zahraničí ${fmtN(d.zahranici)} (vynecháno).` : ''}${d.storno ? ` Stornováno ${fmtN(d.storno)} (vynecháno).` : ''}${d.nepreneseno ? ` Nepřeneseno ${fmtN(d.nepreneseno)} (vynecháno).` : ''}</div>` : ''}
      <p class="small"><b>Tabulka z Excelu:</b> označte ji celou – i s nadpisem a filtry kontingenční tabulky, klidně obě tabulky vedle sebe – <b>Ctrl+C</b> a sem <b>Ctrl+V</b>. Stačí sloupec <b>PSČ</b> nebo <b>obec</b> a počty: objednávek, zákazníků nebo aktivních zákazníků, případně hodnota v Kč. <b>Export z e-shopu</b> nebo z POHODY (CSV, XLSX) nahrajte tlačítkem – stačí PSČ doručovací adresy, pomůže číslo objednávky, datum, částka, stav (storna se vynechají) a Přeneseno. Víc souborů (např. rok 2025 a 2026) vyberte najednou – sečtou se a stejná objednávka se počítá jednou.</p>
      <textarea class="input mono" id="obj-paste" rows="4" wrap="off" spellcheck="false" aria-label="Vložit tabulku z Excelu" placeholder="Sem vložte tabulku z Excelu (Ctrl+V)…"></textarea>
      <div class="row" style="flex-wrap:wrap;gap:8px;margin:8px 0 10px">
        <button type="button" class="btn" id="obj-paste-ok">Načíst vloženou tabulku</button>
        <label class="btn btn-primary">Vybrat soubory… <input type="file" id="obj-file" multiple accept=".csv,.txt,.tsv,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden></label>
        ${d ? '<button type="button" class="btn" id="obj-csv">Stáhnout součty (CSV)</button><button type="button" class="btn btn-ghost" id="obj-del">Smazat nahrané</button>' : ''}
      </div>
      <div class="callout small"><b>Soukromí:</b> tabulka se zpracuje jen v tomto prohlížeči. Na server se pošlou jen součty podle PSČ (počty a částka) – žádná jména, adresy, e-maily ani čísla objednávek.</div>
      <div id="obj-preview"></div>`;
    const md = openModal('Objednávky a zákazníci', body, 'wide');
    const ta = $('#obj-paste', md.el);
    const nactiVlozene = () => {
      const text = ta.value;
      if (!text.trim()) {
        $('#obj-preview', md.el).innerHTML = '<div class="callout warn" style="margin-top:10px">Pole je prázdné – v Excelu tabulku označte, Ctrl+C a sem Ctrl+V.</div>';
        return;
      }
      objNahled(md, 'vloženo ze schránky', csvLib.parse(text, text.includes('\t') ? '\t' : undefined));
    };
    ta.addEventListener('paste', () => setTimeout(nactiVlozene, 0));
    $('#obj-paste-ok', md.el).addEventListener('click', nactiVlozene);
    $('#obj-file', md.el).addEventListener('change', async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      const el = $('#obj-preview', md.el);
      el.innerHTML = `<div class="small muted" style="margin-top:10px">Načítám ${files.length > 1 ? `soubory (${files.length})` : 'soubor'}…</div>`;
      try {
        if (files.length === 1) {
          objNahled(md, files[0].name, await nactiTabulku(files[0]));
          return;
        }
        const tabulky = [];
        for (const f of files) tabulky.push({ nazev: f.name, rows: await nactiTabulku(f) });
        const sp = objLib.spojitTabulky(tabulky);
        if (sp.chyba) throw new Error(sp.chyba);
        objNahled(md, files.map((f) => f.name.replace(/\.[^.]+$/, '')).join(' + '), sp.rows, `Spojeno ze ${sp.soubory} souborů do jedné tabulky – sloupce podle záhlaví každého souboru`);
      } catch (err) {
        el.innerHTML = `<div class="callout warn">${esc(err.message)}</div>`;
      }
    });
    const csvB = $('#obj-csv', md.el);
    if (csvB) csvB.addEventListener('click', () => {
      const met = objLib.metrikyDatasetu(d);
      const rows = [['PSČ', 'Obec', 'Okres', ...met.map((k) => objLib.METRIKA[k].nadpis), ...(d.castky ? ['Částka (Kč)'] : [])]];
      for (const x of d.mista) {
        const p = pscData[x.psc];
        rows.push([x.psc, p ? p[3] : '', p ? okresName(p[2]) : '', ...met.map((k) => String(x[k] || 0)), ...(d.castky ? [String(x.kc || 0)] : [])]);
      }
      download(`objednavky-psc-${new Date().toISOString().slice(0, 10)}.csv`, csvLib.serialize(rows), 'text/csv;charset=utf-8');
    });
    const delB = $('#obj-del', md.el);
    if (delB) delB.addEventListener('click', async () => {
      if (!confirm('Smazat nahrané objednávky / zákazníky (pro celý tým)?')) return;
      try {
        if (state.server.on) await api('DELETE', 'api/objednavky');
        else lsSet(LS.obj, null);
        state.objednavky = null;
        prepocitejObjednavky();
        md.close();
        renderAll();
        toast('Objednávky smazány.');
      } catch (err) {
        toast(err.message);
      }
    });
  }

  // CSV / XLSX → pole řádků
  async function nactiTabulku(file) {
    if (file.size > 60 * 1024 * 1024) throw new Error('Soubor je větší než 60 MB – zkraťte období nebo vyexportujte jen sloupce PSČ, město, datum, částka.');
    const buf = await file.arrayBuffer();
    if (xlsx.isXlsx(buf)) return xlsx.readXlsx(buf);
    if (/\.xls$/i.test(file.name)) throw new Error('Starý formát .xls neumím – v Excelu ho uložte jako .xlsx nebo CSV.');
    const bytes = new Uint8Array(buf);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_e) {
      text = new TextDecoder('windows-1250').decode(bytes); // export z POHODY / Excelu v češtině
    }
    return csvLib.parse(text);
  }

  // Náhled importu: nalezené tabulky (u dvou vedle sebe volba „obě dohromady“ / jen jedna), sloupce k opravě,
  // výsledek po přiřazení k obcím, kontrolní součty proti řádku „Celkový součet“ a seznam nepřiřazených obcí.
  // spojeno = popis tabulky spojené z víc souborů (místo „Tabulka ve sloupcích…“).
  function objNahled(md, zdroj, rows, spojeno) {
    const el = $('#obj-preview', md.el);
    let bloky = objLib.rozpoznat(rows);
    const rucne = !bloky.length;
    if (rucne) {
      // záhlaví se nenašlo – sloupce se vyberou ručně, první řádek = záhlaví
      const sirka = Math.max(1, ...rows.slice(0, 50).map((r) => (r ? r.length : 0)));
      bloky = [{ index: 0, hlavicka: 0, od: 0, do: sirka - 1, sloupce: {}, nazvy: Array.from({ length: sirka }, (_, i) => String((rows[0] || [])[i] == null ? '' : rows[0][i])), ciselne: new Set(), maPsc: false }];
    }
    const sloupce = Object.fromEntries(bloky.map((b) => [b.index, { ...b.sloupce }]));
    let volba = null;
    let jenPrenesene = false; // objednávky s Přeneseno = ne vynechat
    let otevreno = rucne; // rozbalená volba sloupců zůstane rozbalená i po překreslení
    const nadpis = objLib.nadpisTabulky(rows, rucne ? [] : bloky) || zdroj.replace(/\.[^.]+$/, '');
    const pis = objLib.pismeno;
    const rozsah = (b) => (b.od === b.do ? pis(b.od) : `${pis(b.od)}–${pis(b.do)}`);
    const popisBloku = (b) => {
      const sl = sloupce[b.index];
      return ['mesto', 'psc', 'zeme', 'pocet', 'zak', 'akt', 'castka', 'prenes', 'id'].filter((k) => sl[k] != null).map((k) => b.nazvy[sl[k] - b.od] || objLib.SLOUPCE[k].label).join(' · ');
    };
    const vyberHtml = (b) => {
      const sl = sloupce[b.index];
      const opts = (sel) => `<option value="">—</option>${b.nazvy.map((n, i) => `<option value="${b.od + i}" ${sel === b.od + i ? 'selected' : ''}>${esc(pis(b.od + i))}: ${esc(trunc(n || '(bez názvu)', 28))}</option>`).join('')}`;
      return `<div class="map-grid" style="margin-top:6px">${Object.entries(objLib.SLOUPCE).map(([k, def]) => `<label class="small">${esc(def.label)}<select class="select" data-blok="${b.index}" data-sl="${k}">${opts(sl[k])}</select></label>`).join('')}</div>`;
    };
    // počty ve všech veličinách tabulky: „9 749 obj. · 30 939 zák.“
    const vic = (e, met) => met.map((k) => `${fmtN(Math.round(e[k] || 0))} ${objLib.METRIKA[k].kratce}`).join(' · ');
    const render = () => {
      for (const b of bloky) b.maPsc = sloupce[b.index].psc != null;
      const r = objLib.zpracovat(rows, { bloky, volba, sloupce, pscData, obecIndex, jenPrenesene, meta: { soubor: zdroj, kdo: state.server.user } });
      volba = r.volba;
      const pouzite = volba === 'spojit' ? bloky : [bloky[volba]];
      const ds = r.dataset;
      const prir = r.prirazeno;
      const met = r.souhrn.metriky;
      const hl = met[0];
      const j = objLib.METRIKA[hl];
      const obce = par.obce(ds.mista.map((x) => ({ psc: x.psc, n: x[hl] || 0, kc: x.kc || 0 })).filter((x) => x.n > 0), pscData).obce;
      const stat = (b, s) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`;
      const stats = [
        ...met.map((k) => stat(fmtN(objLib.soucetDatasetu(ds, k)), `${esc(objLib.METRIKA[k].mn)} přiřazeno k obcím`)),
        ds.castky ? stat(esc(vel.fmtObrat(objLib.soucetDatasetu(ds, 'kc'))), 'hodnota objednávek') : '',
        stat(fmtN(ds.mista.length), `PSČ · ${fmtN(obce.length)} obcí`),
        stat(esc(vic(prir.zahranici, met)), 'zahraničí (vynecháno)'),
        stat(esc(vic(prir.nezarazeno, met)), 'nepřiřazeno (bez obce / neznámá obec)'),
        prir.opraveno[hl] ? stat(esc(vic(prir.opraveno, met)), 'opravená PSČ (4 číslice, chybná země)') : '',
        prir.podleNazvu[hl] ? stat(esc(vic(prir.podleNazvu, met)), 'podle názvu obce (bez PSČ)') : '',
        r.souhrn.storno && r.souhrn.storno.n ? stat(fmtN(r.souhrn.storno.n), 'storno (vynecháno)') : '',
        r.souhrn.kopie ? stat(fmtN(r.souhrn.kopie), 'kopie téže objednávky (počítá se jednou)') : '',
        r.souhrn.nepreneseno && r.souhrn.nepreneseno.n ? stat(fmtN(r.souhrn.nepreneseno.n), jenPrenesene ? 'nepřeneseno (vynecháno)' : 'z toho nepřeneseno (započteno)') : '',
        ds.od && ds.do ? stat(esc(fmtDate(ds.od)) + '–' + esc(fmtDate(ds.do)), 'období') : '',
      ].filter(Boolean);
      const kde = (k) => (k.blok === 'spojeno' ? 'Obě tabulky dohromady' : `Tabulka ${rozsah(bloky[k.blok])}`);
      const kontroly = r.kontroly
        .map((k) => (k.ok
          ? `<div class="small" style="color:var(--success)">✓ ${esc(kde(k))}: součet řádků ${fmtN(k.radky)} = řádek „Celkový součet“ (${esc(objLib.METRIKA[k.metrika].mn)})</div>`
          : `<div class="callout warn small" style="margin-top:6px">⚠ ${esc(kde(k))}: součet řádků ${fmtN(k.radky)} ≠ „Celkový součet“ ${fmtN(k.celkem)} (${esc(objLib.METRIKA[k.metrika].mn)}). Zkontrolujte sloupce, případně vyberte jen jednu tabulku.</div>`))
        .join('');
      const nepr = prir.neprirazene.filter((x) => x.nazev && x[hl]);
      const bez = prir.neprirazene.find((x) => !x.nazev);
      const radioTab = bloky.length > 1
        ? `<div class="stack-sm">${r.lzeSpojit ? `<label class="check"><input type="radio" name="obj-volba" value="spojit" ${volba === 'spojit' ? 'checked' : ''}>Obě tabulky dohromady (doporučeno) – obce z tabulky ${esc(rozsah(bloky.find((b) => !b.maPsc)))}, velká města rozepsaná podle PSČ z tabulky ${esc(rozsah(bloky.find((b) => b.maPsc)))}</label>` : ''}
            ${bloky.map((b) => `<label class="check"><input type="radio" name="obj-volba" value="${b.index}" ${volba === b.index ? 'checked' : ''}>Jen tabulka ${esc(rozsah(b))}: ${esc(popisBloku(b)) || '—'}</label>`).join('')}</div>`
        : `<div class="small">${rucne ? '' : spojeno ? `${esc(spojeno)}: ${esc(popisBloku(bloky[0]))}` : `Tabulka ve sloupcích ${esc(rozsah(bloky[0]))}, záhlaví na řádku ${bloky[0].hlavicka + 1}: ${esc(popisBloku(bloky[0]))}`}</div>`;
      el.innerHTML = `
        <div class="section"><h3>Tabulka (${fmtN(r.souhrn.radku)} řádků s daty)</h3>
          ${rucne ? '<div class="callout warn small">Nenašel jsem záhlaví se sloupcem PSČ nebo obec (hledám „PSČ“, „Dodací PSČ“, „Obec“, „Město“, „ZIP“ v prvních 60 řádcích). Vyberte sloupce ručně – první řádek se bere jako záhlaví.</div>' : ''}
          ${radioTab}
          ${pouzite.map((b) => `<details ${otevreno ? 'open' : ''} style="margin-top:6px"><summary class="small">Sloupce tabulky ${esc(rozsah(b))} – rozpoznáno podle záhlaví, opravte, když nesedí</summary>${vyberHtml(b)}</details>`).join('')}
          ${pouzite.some((b) => sloupce[b.index].prenes != null) ? `<label class="check small" style="margin-top:6px"><input type="checkbox" id="obj-jen-prenesene" ${jenPrenesene ? 'checked' : ''}>Jen přenesené (vyřízené) objednávky – nepřenesené vynechat</label>` : ''}
          ${volba === 'spojit' && r.prekryto ? `<div class="small muted" style="margin-top:6px">Města rozepsaná podle PSČ (${fmtN(r.prekryto)}) se z tabulky obcí nepočítají, aby nebyla dvakrát.</div>` : ''}
        </div>
        <div class="section"><h3>Výsledek</h3>
          <div class="summary" style="grid-template-columns:repeat(3,1fr)">${stats.join('')}</div>
          <div style="margin-top:8px">${kontroly}</div>
          ${r.rozdily.length ? `<div class="callout warn small" style="margin-top:6px">⚠ Levá a pravá tabulka nesedí (jiné filtry?): ${r.rozdily.slice(0, 8).map((x) => `${esc(x.nazev)} ${fmtN(x.obec)} × ${fmtN(x.psc)}`).join(' · ')}. Nastavte v obou tabulkách stejné filtry, nebo vyberte jen jednu tabulku.</div>` : ''}
          ${bez || nepr.length ? `<div class="small" style="margin-top:8px"><b>Nepřiřazeno:</b> ${bez ? `bez obce i PSČ (neuvedeno) ${esc(vic(bez, met))}` : ''}${bez && nepr.length ? ' · ' : ''}${nepr.length ? 'neznámé obce: ' + nepr.slice(0, 25).map((x) => `${esc(trunc(x.nazev, 40))} ${fmtN(x[hl])}`).join(' · ') + (nepr.length > 25 ? ' …' : '') : ''}</div>` : ''}
          ${obce.length ? `<div class="small" style="margin-top:8px"><b>Nejvíc ${esc(j.mn)}:</b> ${obce.slice(0, 10).map((o) => `${esc(o.nazev)} ${fmtN(o.n)}`).join(' · ')}</div>` : ''}
          <div class="row" style="margin-top:12px;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-primary" id="obj-save" ${ds.mista.length ? '' : 'disabled'}>${state.server.on ? 'Uložit pro tým' : 'Uložit v tomto prohlížeči'}</button>
            <input class="input" id="obj-nazev" style="width:320px;max-width:100%" placeholder="popis, např. zákazníci 2025" value="${esc(nadpis)}">
          </div>
          <div class="small muted" style="margin-top:6px">Uložení nahradí dosud nahraná data. V mapě pak vlevo přepnete, co se počítá${met.length > 1 ? ` (${esc(met.map((k) => objLib.METRIKA[k].nadpis.toLowerCase()).join(', '))})` : ''}.</div>
        </div>`;
      el.querySelectorAll('details').forEach((dt) => dt.addEventListener('toggle', () => {
        otevreno = dt.open;
      }));
      el.querySelectorAll('input[name="obj-volba"]').forEach((i) => i.addEventListener('change', () => {
        volba = i.value === 'spojit' ? 'spojit' : Number(i.value);
        render();
      }));
      const jp = $('#obj-jen-prenesene', el);
      if (jp) jp.addEventListener('change', () => {
        jenPrenesene = jp.checked;
        render();
      });
      el.querySelectorAll('select[data-sl]').forEach((s) => s.addEventListener('change', () => {
        const sl = sloupce[Number(s.dataset.blok)];
        if (s.value === '') delete sl[s.dataset.sl];
        else sl[s.dataset.sl] = Number(s.value);
        render();
      }));
      $('#obj-save', md.el).addEventListener('click', async () => {
        ds.nazev = $('#obj-nazev', md.el).value;
        try {
          if (state.server.on) await api('PUT', 'api/objednavky', ds);
          else lsSet(LS.obj, ds);
          state.objednavky = ds;
          state.obj.bubliny = true;
          state.obj.choropleth = true;
          prepocitejObjednavky();
          markerCache.clear();
          md.close();
          state.tab = 'mesta';
          renderAll();
          writeHash();
          toast(`Uloženo: ${popisDatasetu(ds)}.`);
        } catch (err) {
          toast('Uložení selhalo: ' + err.message);
        }
      });
    };
    render();
  }

  // ================================================================== RUČNĚ PŘIDANÁ MÍSTA
  function openMistoModal(draft, id) {
    const d = draft || { typ: 'prodejna', sl: {} };
    const body = `
      <div class="field"><label>IČO (nepovinné)</label><div class="row"><input class="input" id="m-ico" inputmode="numeric" value="${esc(d.ico || '')}" style="width:140px"><button type="button" class="btn btn-sm" id="m-ares" ${state.server.registry ? '' : 'disabled title="Dohledání v ARES funguje jen přes server"'}>Načíst z ARES</button></div><span class="hint">Doplní název, adresu sídla a polohu.</span></div>
      <div class="field"><label>Název *</label><input class="input" id="m-nazev" value="${esc(d.nazev || '')}"></div>
      <div class="field"><label>Typ</label><select class="select" id="m-typ">${vlastni.TYPY.map((t) => `<option value="${t.key}" ${d.typ === t.key ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></div>
      <div class="field"><label>Adresa</label><div class="row"><input class="input" id="m-adresa" value="${esc(d.adresa || '')}" placeholder="ulice číslo, obec"><button type="button" class="btn btn-sm" id="m-najit" ${state.server.registry ? '' : 'disabled'}>Najít</button></div><div id="m-kandidati"></div></div>
      <div class="field"><label>Poloha *</label><div class="row"><span id="m-poloha" class="small">${d.lat ? `${d.lat}, ${d.lon}${d.polohaZdroj === 'mapa' ? ' (z mapy)' : ''}` : '<span class="muted">zatím nezadaná</span>'}</span><button type="button" class="btn btn-sm" id="m-mapa">Vybrat v mapě</button></div></div>
      <div class="field"><label>Obec</label><input class="input" id="m-obec" value="${esc(d.obec || '')}"></div>
      <div class="field"><label>Telefon</label><input class="input" id="m-tel" value="${esc((d.tel || []).join(', '))}"></div>
      <div class="field"><label>E-mail</label><input class="input" id="m-mail" value="${esc((d.mail || []).join(', '))}"></div>
      <div class="field"><label>Web</label><input class="input" id="m-web" value="${esc((d.web || []).join(', '))}"></div>
      <div class="field"><label>Nabízí</label><div class="row" style="flex-wrap:wrap">${vlastni.SLUZBY.map((k) => `<label class="check small"><input type="checkbox" data-msl="${k}" ${d.sl && d.sl[k] ? 'checked' : ''}>${esc({ prodej: 'prodej kol', servis: 'servis', pujcovna: 'půjčovna', ekola: 'e-kola', bazar: 'bazar' }[k])}</label>`).join('')}</div></div>
      <div class="field"><label>Poznámka</label><textarea class="input" id="m-pozn" rows="2">${esc(d.poznamka || '')}</textarea></div>
      <div class="row between"><span class="muted small">${state.server.on ? 'Uloží se pro celý tým.' : 'Uloží se jen v tomto prohlížeči.'}</span><button type="button" class="btn btn-primary" id="m-ulozit">${id ? 'Uložit změny' : 'Přidat místo'}</button></div>`;
    const md = openModal(id ? 'Upravit místo' : 'Přidat místo', body);
    const read = () => {
      d.ico = $('#m-ico', md.el).value.trim();
      d.nazev = $('#m-nazev', md.el).value.trim();
      d.typ = $('#m-typ', md.el).value;
      d.adresa = $('#m-adresa', md.el).value.trim();
      d.obec = $('#m-obec', md.el).value.trim();
      d.tel = $('#m-tel', md.el).value;
      d.mail = $('#m-mail', md.el).value;
      d.web = $('#m-web', md.el).value;
      d.poznamka = $('#m-pozn', md.el).value;
      d.sl = {};
      md.el.querySelectorAll('[data-msl]').forEach((c) => {
        if (c.checked) d.sl[c.dataset.msl] = true;
      });
      return d;
    };
    const setPoloha = (lat, lon, zdroj) => {
      d.lat = lat;
      d.lon = lon;
      d.polohaZdroj = zdroj;
      $('#m-poloha', md.el).textContent = `${lat}, ${lon}${zdroj === 'mapa' ? ' (z mapy)' : zdroj ? ' (' + zdroj + ')' : ''}`;
    };
    $('#m-ares', md.el).addEventListener('click', async (e) => {
      const ico = vlastni.normIco($('#m-ico', md.el).value);
      if (!ico) return toast('IČO nemá platný kontrolní součet.');
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Hledám v ARES…';
      const j = await nactiFirmu(ico);
      btn.disabled = false;
      btn.textContent = 'Načíst z ARES';
      if (!j) return;
      const f = j.firma;
      if (!$('#m-nazev', md.el).value.trim()) $('#m-nazev', md.el).value = f.nazev;
      if (!$('#m-adresa', md.el).value.trim()) $('#m-adresa', md.el).value = f.sidlo || '';
      if (!$('#m-obec', md.el).value.trim()) $('#m-obec', md.el).value = f.obec || '';
      $('#m-ico', md.el).value = ico;
      if (j.souradnice && !d.lat) setPoloha(j.souradnice[0], j.souradnice[1], 'sídlo z ARES');
    });
    $('#m-najit', md.el).addEventListener('click', async () => {
      const q = $('#m-adresa', md.el).value.trim();
      if (q.length < 3) return toast('Zadejte adresu.');
      try {
        const j = await api('GET', 'api/geokoduj?q=' + encodeURIComponent(q));
        const box = $('#m-kandidati', md.el);
        if (!j.kandidati.length) {
          box.innerHTML = '<div class="small muted">Adresa nenalezena – zkuste jiný zápis nebo „Vybrat v mapě“.</div>';
          return;
        }
        box.innerHTML = j.kandidati.map((c, i) => `<button type="button" class="link-btn small" data-k="${i}">${esc(c.adresa)}</button>`).join('');
        box.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => {
          const c = j.kandidati[Number(b.dataset.k)];
          $('#m-adresa', md.el).value = c.adresa;
          const obec = /,\s*\d{3}\s?\d{2}\s+(.+)$/.exec(c.adresa);
          if (obec && !$('#m-obec', md.el).value.trim()) $('#m-obec', md.el).value = obec[1].replace(/\s+\d+$/, '');
          setPoloha(c.lat, c.lon, 'RÚIAN');
          box.innerHTML = '';
        }));
      } catch (err) {
        toast(err.message);
      }
    });
    $('#m-mapa', md.el).addEventListener('click', () => {
      read();
      md.close();
      state.pick = { draft: d, id };
      if (state.view === 'table') {
        state.view = 'map';
        renderAll();
      }
      $('#map-wrap').classList.add('picking');
      toast('Klikněte do mapy na místo prodejny.');
    });
    $('#m-ulozit', md.el).addEventListener('click', async () => {
      read();
      const n = vlastni.normalizeMisto({ ...d, kdo: state.server.user }, id);
      if (n.chyba) return toast(n.chyba);
      try {
        let saved = n.misto;
        if (state.server.on) {
          const j = id ? await api('PUT', 'api/mista/' + id, n.misto) : await api('POST', 'api/mista', n.misto);
          saved = j.misto;
        } else {
          state.vlastni[saved.id] = saved;
          lsSet(LS.vlastni, state.vlastni);
        }
        state.vlastni[saved.id] = saved;
        if (saved.ico && !firmaPodleIco(saved.ico)) await nactiFirmu(saved.ico);
        md.close();
        rebuild();
        select('misto', saved.id);
        toast(id ? 'Místo upraveno.' : 'Místo přidáno.');
      } catch (err) {
        toast('Uložení selhalo: ' + err.message);
      }
    });
  }

  async function smazatVlastni(id) {
    if (!confirm('Smazat ručně přidané místo (pro celý tým)? Stav spolupráce u něj zůstane v záloze.')) return;
    try {
      if (state.server.on) await api('DELETE', 'api/mista/' + id);
      delete state.vlastni[id];
      if (!state.server.on) lsSet(LS.vlastni, state.vlastni);
      state.selected = null;
      rebuild();
      renderAll();
      toast('Místo smazáno.');
    } catch (err) {
      toast(err.message);
    }
  }

  // ================================================================== DATA: export, záloha, obraty, naše firma
  function openDataModal() {
    const sum = stavLib.summary(state.stav);
    const nObr = Object.keys(state.obraty).length;
    const koloshop = Object.entries(firmyData).find(([, f]) => /^koloshop\b/i.test(f.nazev || ''));
    const body = `
      <div class="section" style="margin-top:0;border-top:0;padding-top:0"><h3>Export</h3>
        <div class="row" style="flex-wrap:wrap;gap:8px"><button type="button" class="btn" id="d-csv">Aktuální výběr (CSV, ${fmtN(visible().mista.length)} míst)</button><button type="button" class="btn" id="d-csv-stav">Všechna místa se stavem spolupráce (CSV)</button></div>
      </div>
      <div class="section"><h3>Stav spolupráce – záloha</h3>
        <p class="small">${fmtN(sum.celkem)} míst se záznamem (${fmtN(sum.partner)} partnerů). ${state.server.on ? 'Sdílí se přes server; server ho zálohuje denně.' : 'Uloženo jen v tomto prohlížeči – zálohujte!'} Při načtení zálohy se záznamy sloučí (vyhraje novější).</p>
        <div class="row" style="flex-wrap:wrap;gap:8px"><button type="button" class="btn" id="d-zaloha">Uložit zálohu (JSON)</button><label class="btn">Načíst zálohu… <input type="file" id="d-nacist" accept="application/json,.json" hidden></label></div>
      </div>
      <div class="section"><h3>Obraty firem (${fmtN(nObr)})</h3>
        <p class="small">ARES obrat neuvádí – je v účetních závěrkách ve Sbírce listin (justice.cz) nebo v placených databázích (Merk, Cribis, Albertina…). Nahrajte tabulku <b>IČO; obrat; rok</b> (CSV/XLSX, obrat v Kč nebo „45 mil“, volitelně sloupec „jednotka“ tis./mil.). Velikost firmy se pak určí podle obratu.</p>
        <div class="row" style="flex-wrap:wrap;gap:8px"><label class="btn">Nahrát obraty… <input type="file" id="d-obraty" accept=".csv,.txt,.xlsx" hidden></label><button type="button" class="btn btn-ghost" id="d-obraty-vzor">Vzor tabulky (CSV se všemi IČO z mapy)</button></div>
        <div id="d-obraty-vysledek"></div>
      </div>
      <div class="section"><h3>Naše firma</h3>
        <p class="small">IČO naší firmy – její prodejny se na mapě označí ⌂ a počítají se jako pokrytí (bílá místa jsou tam, kde není partner ani naše prodejna).</p>
        <div class="row"><input class="input" id="d-nase" value="${esc(state.nastaveni.naseIco.join(', '))}" placeholder="IČO, více oddělte čárkou"><button type="button" class="btn" id="d-nase-ulozit">Uložit</button></div>
        ${!state.nastaveni.naseIco.length && koloshop ? `<div class="callout small" style="margin-top:8px">V datech je <b>${esc(koloshop[1].nazev)}</b> (IČO ${esc(koloshop[0])}, ${fmtN(koloshop[1].mist || 0)} prodejny). Je to naše firma? <button type="button" class="btn btn-sm" id="d-nase-koloshop">Ano, nastavit</button></div>` : ''}
      </div>
      <div class="section"><h3>O datech</h3>
        <p class="small">Prodejny, servisy a půjčovny z OpenStreetMap, firmy s koly v názvu z ARES (místo = sídlo), velikost z ARES/ČSÚ (kategorie počtu zaměstnanců), kontakty a služby z webů prodejen. Data k ${meta.vytvoreno ? esc(fmtDate(meta.vytvoreno)) : '—'}, obnova 1. den v měsíci. Chybí-li prodejna, přidejte ji tlačítkem <b>+ Místo</b>.</p>
      </div>`;
    const md = openModal('Data', body, 'wide');
    $('#d-csv', md.el).addEventListener('click', exportCsv);
    $('#d-csv-stav', md.el).addEventListener('click', () => {
      const data = [COLUMNS.map((c) => c.label)];
      for (const id of Object.keys(state.stav)) {
        const m = mistoById.get(id);
        if (m) data.push(COLUMNS.map((c) => c.get(m)));
      }
      download(`spoluprace-${new Date().toISOString().slice(0, 10)}.csv`, csvLib.serialize(data), 'text/csv;charset=utf-8');
    });
    $('#d-zaloha', md.el).addEventListener('click', () => download(`stav-spoluprace-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(stavLib.exportJson(state.stav), null, 1), 'application/json'));
    $('#d-nacist', md.el).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const im = stavLib.importJson(JSON.parse(await file.text()));
        if (im.chyba) throw new Error(im.chyba);
        state.stav = stavLib.merge(state.stav, im.stav);
        saveLocalStav();
        if (state.server.on) await api('PUT', 'api/stav', stavLib.exportJson(im.stav));
        rebuild();
        renderAll();
        md.close();
        toast(`Načteno ${fmtN(im.pocet)} záznamů.`);
      } catch (err) {
        toast('Import se nezdařil: ' + err.message);
      }
    });
    $('#d-obraty', md.el).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const rows = await nactiTabulku(file);
        const obraty = obratyZTabulky(rows);
        const n = Object.keys(obraty).length;
        if (!n) throw new Error('V tabulce jsem nenašel sloupce IČO a obrat (záhlaví „IČO“, „Obrat“ / „Tržby“ / „Výnosy“, volitelně „Rok“ a „Jednotka“).');
        if (state.server.on) {
          const j = await api('PUT', 'api/obraty', { obraty });
          $('#d-obraty-vysledek', md.el).innerHTML = `<div class="callout small">Uloženo ${fmtN(j.ulozeno)} obratů.${j.chyby && j.chyby.length ? ' Vynecháno: ' + esc(j.chyby.join('; ')) : ''}</div>`;
        } else {
          Object.assign(state.obraty, obraty);
          lsSet(LS.obraty, state.obraty);
          $('#d-obraty-vysledek', md.el).innerHTML = `<div class="callout small">Uloženo ${fmtN(n)} obratů v tomto prohlížeči.</div>`;
        }
        Object.assign(state.obraty, obraty);
        rebuild();
        renderAll();
      } catch (err) {
        $('#d-obraty-vysledek', md.el).innerHTML = `<div class="callout warn small">${esc(err.message)}</div>`;
      }
    });
    $('#d-obraty-vzor', md.el).addEventListener('click', () => {
      const rows = [['IČO', 'Firma', 'Obrat (Kč)', 'Rok', 'Zdroj']];
      const seen = new Set();
      for (const m of mista) {
        if (!m._ico || seen.has(m._ico)) continue;
        seen.add(m._ico);
        const ob = state.obraty[m._ico];
        rows.push([m._ico, m._firma ? m._firma.nazev : m.nazev, ob ? String(ob.obrat) : '', ob && ob.rok ? String(ob.rok) : '', ob ? ob.zdroj || '' : '']);
      }
      download('obraty-firem.csv', csvLib.serialize(rows), 'text/csv;charset=utf-8');
    });
    const ulozNase = async (list) => {
      const naseIco = list.map((x) => vlastni.normIco(x)).filter(Boolean);
      state.nastaveni = { naseIco };
      try {
        if (state.server.on) await api('PUT', 'api/nastaveni', state.nastaveni);
        else lsSet(LS.nastaveni, state.nastaveni);
      } catch (err) {
        toast(err.message);
      }
      rebuild();
      renderAll();
      md.close();
      toast(naseIco.length ? 'Naše firma uložena (' + naseIco.join(', ') + ').' : 'Naše firma zrušena.');
    };
    $('#d-nase-ulozit', md.el).addEventListener('click', () => ulozNase($('#d-nase', md.el).value.split(/[,;\s]+/).filter(Boolean)));
    const ks = $('#d-nase-koloshop', md.el);
    if (ks) ks.addEventListener('click', () => ulozNase([koloshop[0]]));
  }

  // Tabulka obratů → { IČO: { obrat (Kč), rok, zdroj } }
  function obratyZTabulky(rows) {
    let h = -1;
    let col = {};
    for (let r = 0; r < Math.min(rows.length, 15); r++) {
      const head = (rows[r] || []).map((x) => objLib.fold(x));
      const ico = head.findIndex((x) => /^(ico|ic|ic o|identifikacni cislo)\b/.test(x));
      const obrat = head.findIndex((x) => /(obrat|trzby|vynosy|trzba|revenue|turnover)/.test(x));
      if (ico >= 0 && obrat >= 0) {
        h = r;
        col = { ico, obrat, rok: head.findIndex((x) => /^(rok|year|obdobi)\b/.test(x)), jednotka: head.findIndex((x) => /^(jednotka|mena|unit)\b/.test(x)), zdroj: head.findIndex((x) => /^zdroj\b/.test(x)) };
        const hn = head[obrat];
        col.vychoziJednotka = /\btis\b|v tis/.test(hn) ? 'tis' : /\bmil\b|v mil/.test(hn) ? 'mil' : null;
        break;
      }
    }
    const out = {};
    if (h < 0) return out;
    for (let r = h + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const ico = vlastni.normIco(row[col.ico]);
      if (!ico) continue;
      const jedn = col.jednotka >= 0 ? (/tis/i.test(String(row[col.jednotka] || '')) ? 'tis' : /mil/i.test(String(row[col.jednotka] || '')) ? 'mil' : col.vychoziJednotka) : col.vychoziJednotka;
      const kc = vel.parseObrat(row[col.obrat], jedn);
      if (kc == null) continue;
      const rok = col.rok >= 0 && /^\d{4}$/.test(String(row[col.rok] || '').trim()) ? Number(String(row[col.rok]).trim()) : null;
      out[ico] = { obrat: kc, rok, zdroj: col.zdroj >= 0 && row[col.zdroj] ? String(row[col.zdroj]).slice(0, 120) : 'import' };
    }
    return out;
  }

  // ================================================================== pomocné UI
  function openModal(title, bodyHtml, size) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-back"><div class="modal${size === 'wide' ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2><button type="button" class="btn btn-icon btn-ghost" id="modal-close" aria-label="Zavřít">✕</button></header><div class="content">${bodyHtml}</div></div></div>`;
    const el = root.firstElementChild;
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    function close() {
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey);
    }
    $('#modal-close', el).addEventListener('click', close);
    el.addEventListener('mousedown', (e) => {
      if (e.target === el) close();
    });
    document.addEventListener('keydown', onKey);
    return { el, close };
  }
  let toastTimer;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
  }
  function download(name, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function fmtN(n) {
    return Number(n || 0).toLocaleString('cs-CZ');
  }
  function fmtPct(x) {
    if (!Number.isFinite(x)) return '';
    return (x * 100).toLocaleString('cs-CZ', { maximumFractionDigits: x < 0.01 ? 2 : 1 }) + ' %';
  }
  function fmtKm(m) {
    if (m == null) return '';
    return m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('cs-CZ');
  }
  function fmtDateTime(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' });
  }
  function trunc(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  // ================================================================== motiv a nastavení zobrazení
  function applyTheme(theme) {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
    lsSet(LS.theme, theme || null);
  }
  function currentTheme() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function saveUi() {
    lsSet(LS.ui, { barva: state.barva, sort: state.sort, radiusKm: state.obj.radiusKm, minN: state.obj.minN, bubliny: state.obj.bubliny, choropleth: state.obj.choropleth, naObyv: state.obj.naObyv, metrika: state.obj.metrika });
  }
  function loadUi() {
    const u = lsGet(LS.ui);
    if (!u) return;
    if (['velikost', 'typ', 'stav'].includes(u.barva)) state.barva = u.barva;
    if (typeof u.sort === 'string') state.sort = u.sort;
    if (u.radiusKm >= 5 && u.radiusKm <= 50) state.obj.radiusKm = u.radiusKm;
    if (u.minN >= 1 && u.minN <= 50) state.obj.minN = u.minN;
    for (const k of ['bubliny', 'choropleth', 'naObyv']) if (typeof u[k] === 'boolean') state.obj[k] = u[k];
    if (objLib.METRIKA[u.metrika]) state.obj.metrika = u.metrika;
  }

  // ================================================================== start
  function init() {
    applyTheme(lsGet(LS.theme) || null);
    loadUi();
    const st = lsGet(LS.stav);
    state.stav = (st && stavLib.importJson(st).stav) || {};
    state.vlastni = lsGet(LS.vlastni) || {};
    state.obraty = lsGet(LS.obraty) || {};
    state.nastaveni = lsGet(LS.nastaveni) || { naseIco: [] };
    state.objednavky = lsGet(LS.obj);
    if (state.objednavky && !objLib.validovat(state.objednavky).data) state.objednavky = null;
    readHash();
    initMap();
    rebuild();
    $('#boot').remove();
    if (state.scope.kraj != null || state.selected) {
      const sel = state.selected;
      state.selected = null;
      setScope(state.scope.kraj, state.scope.okres, false);
      if (sel && (sel.type === 'misto' ? mistoById.has(sel.id) : obj.obecByKey.has(sel.id))) select(sel.type, sel.id);
      else if (sel) state.cekaVyber = sel; // obec z objednávek / ručně přidané místo – vybere se po načtení ze serveru
    } else renderAll();

    $('#search').addEventListener('input', debounce((e) => {
      state.filters.q = norm(e.target.value.trim());
      state.listLimit = 150;
      if (state.selected) state.selected = null;
      state.tab = 'mista';
      renderAll();
    }, 250));
    $('#btn-view').addEventListener('click', () => {
      state.view = state.view === 'table' ? 'map' : 'table';
      renderAll();
      writeHash();
      if (state.view === 'map') setTimeout(() => map.invalidateSize(), 50);
    });
    $('#btn-obj').addEventListener('click', openObjModal);
    $('#btn-add').addEventListener('click', () => openMistoModal(null, null));
    $('#btn-data').addEventListener('click', openDataModal);
    $('#btn-theme').addEventListener('click', () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.pick) {
        const p = state.pick;
        state.pick = null;
        $('#map-wrap').classList.remove('picking');
        openMistoModal(p.draft, p.id);
        return;
      }
      if (e.key === 'Escape' && state.selected && !$('#modal-root').firstElementChild) clearSelection();
      if (e.key === '/' && document.activeElement && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
        e.preventDefault();
        $('#search').focus();
      }
    });
    window.addEventListener('hashchange', () => {
      const before = JSON.stringify([state.scope, state.selected, state.tab]);
      state.scope = { kraj: null, okres: null };
      state.selected = null;
      readHash();
      if (JSON.stringify([state.scope, state.selected, state.tab]) !== before) {
        const sel = state.selected;
        state.selected = null;
        setScope(state.scope.kraj, state.scope.okres, false);
        if (sel) select(sel.type, sel.id);
      }
    });
    connectServer();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
