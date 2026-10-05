// Cyklo & Ski mapa – logika aplikace: interaktivní mapa ČR (kraje → okresy), vrstvy cyklotras, cyklostezek,
// skiareálů a sjezdovek, místa v okolí (ubytování, půjčovny/obchody, infocentra), filtry, seznam, detail,
// evidence oslovení (stav + poznámka + ruční kontakty) s uložením do prohlížeče a volitelně na server (server.js).
(function () {
  'use strict';

  const D = window.CSM_DATA || {};
  const geo = window.CSM.geo;
  const csvLib = window.CSM.csv;
  const contacts = window.CSM.contacts;
  const stavLib = window.CSM.stav;
  const $ = (sel, root) => (root || document).querySelector(sel);

  if (!D.hranice || !D.mista || !D.trasy || !D.ski) {
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
  const mista = D.mista;
  const trasy = D.trasy;
  const arealy = D.ski.arealy;
  const sjezdovky = D.ski.sjezdovky;
  const vleky = D.ski.vleky;
  const enrich = D.enrich || {};
  const meta = D.meta || {};
  const mistoById = new Map(mista.map((m) => [m.id, m]));
  const trasaById = new Map(trasy.map((t) => [t.id, t]));
  const arealById = new Map(arealy.map((a) => [a.id, a]));
  const sjezdovkyByAreal = new Map();
  for (const s of sjezdovky) {
    if (!s.areal) continue;
    if (!sjezdovkyByAreal.has(s.areal)) sjezdovkyByAreal.set(s.areal, []);
    sjezdovkyByAreal.get(s.areal).push(s);
  }
  const vlekyByAreal = new Map();
  for (const v of vleky) {
    if (!v.areal) continue;
    if (!vlekyByAreal.has(v.areal)) vlekyByAreal.set(v.areal, []);
    vlekyByAreal.get(v.areal).push(v);
  }
  // místa v okolí trasy / areálu (obrácený index)
  const mistaByTrasa = new Map();
  const mistaByAreal = new Map();
  for (const m of mista) {
    for (const [tid, d] of m.blizko.trasy) {
      if (!mistaByTrasa.has(tid)) mistaByTrasa.set(tid, []);
      mistaByTrasa.get(tid).push([m, d]);
    }
    for (const [aid, d] of m.blizko.ski) {
      if (!mistaByAreal.has(aid)) mistaByAreal.set(aid, []);
      mistaByAreal.get(aid).push([m, d]);
    }
  }
  for (const arr of mistaByTrasa.values()) arr.sort((a, b) => a[1] - b[1]);
  for (const arr of mistaByAreal.values()) arr.sort((a, b) => a[1] - b[1]);

  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
  for (const m of mista) m._q = norm([m.nazev, m.obec, m.adresa, m.operator, m.typLabel, okresName(m.okres), (m.web || []).join(' ')].join(' | '));
  for (const t of trasy) t._q = norm([t.label, t.ref, t.popis, t.operator].join(' | '));
  for (const a of arealy) a._q = norm([a.nazev, a.operator, okresName(a.okres)].join(' | '));

  function okresName(kod) {
    const o = okresByKod.get(kod);
    return o ? o.properties.nazev : '';
  }
  function krajName(kod) {
    const k = krajByKod.get(kod);
    return k ? k.properties.nazev : '';
  }

  const SKUPINY = [
    { key: 'ubytovani', label: 'Ubytování', color: 'var(--c-ubytovani)', hex: '#1f5fbf' },
    { key: 'pujcovna', label: 'Půjčovny, cyklo a sport obchody', color: 'var(--c-pujcovna)', hex: '#2b8a3e' },
    { key: 'infocentrum', label: 'Infocentra', color: 'var(--c-info)', hex: '#e67700' },
  ];
  const SKUPINA = Object.fromEntries(SKUPINY.map((s) => [s.key, s]));
  const TYPY = [];
  {
    const seen = new Map();
    for (const m of mista) {
      const k = m.typ;
      if (!seen.has(k)) seen.set(k, { key: k, label: m.typLabel, skupina: m.skupina, n: 0 });
      seen.get(k).n++;
    }
    TYPY.push(...[...seen.values()].sort((a, b) => a.skupina.localeCompare(b.skupina) || b.n - a.n));
  }
  const DRUHY_TRAS = [
    { key: 'cyklotrasa', label: 'Cyklotrasy (značené)', hex: '#d9480f' },
    { key: 'cyklostezka', label: 'Cyklostezky (pojmenované)', hex: '#c2410c' },
    { key: 'mtb', label: 'MTB trasy', hex: '#7c3aed' },
  ];
  const DRUH = Object.fromEntries(DRUHY_TRAS.map((d) => [d.key, d]));
  const SIT_LABEL = { icn: 'mezinárodní (EuroVelo)', ncn: 'dálková', rcn: 'regionální', lcn: 'místní' };
  const SKI_HEX = '#0b7285';
  // kódy právní formy z ARES (nejčastější)
  const PRAVNI_FORMA = { 100: 'podnikající fyzická osoba', 101: 'fyzická osoba (živnost)', 102: 'zemědělský podnikatel', 105: 'fyzická osoba (jiné podnikání)', 107: 'zemědělský podnikatel – FO', 108: 'fyzická osoba (živnost + jiné)', 111: 'veřejná obchodní společnost', 112: 's.r.o.', 113: 'veřejná obchodní společnost', 116: 'komanditní společnost', 117: 'nadace', 118: 'nadační fond', 121: 'akciová společnost', 141: 'obecně prospěšná společnost', 161: 'ústav', 205: 'družstvo', 301: 'státní podnik', 331: 'příspěvková organizace', 421: 'odštěpný závod zahraniční osoby', 422: 'zahraniční osoba', 601: 'vysoká škola', 701: 'spolek', 706: 'pobočný spolek', 721: 'církevní organizace', 801: 'obec', 804: 'kraj', 906: 'zájmové sdružení právnických osob' };
  function pravniForma(kod) {
    if (kod == null || kod === '') return '';
    return PRAVNI_FORMA[Number(kod)] || ('právní forma ' + kod);
  }

  // ================================================================== stav aplikace
  const state = {
    scope: { kraj: null, okres: null },
    view: 'map',
    tab: 'mista',
    selected: null, // { type: 'misto'|'trasa'|'ski', id }
    filters: {
      druhy: new Set(['cyklotrasa', 'cyklostezka']),
      ski: true,
      skupiny: new Set(['ubytovani', 'pujcovna', 'infocentrum']),
      typyOff: new Set(),
      okoli: 'vse',
      okoliTrasyKm: 2,
      okoliSkiKm: 5,
      pujcovna: 'vse',
      stav: 'vse',
      bezNazvu: false,
      vseTrasyCR: false,
      znackyCR: false,
      q: '',
    },
    stav: {},
    sort: 'nazev',
    listLimit: 150,
    tableSort: { key: 'nazev', dir: 1 },
    server: { on: false, url: 'api/stav', user: '' },
    saveTimers: new Map(),
  };

  // ================================================================== úložiště stavu oslovení
  const LS_KEY = 'csm.stav.v1';
  function loadLocal() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return stavLib.importJson(parsed).stav || {};
    } catch (_e) {
      return {};
    }
  }
  function saveLocal() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(stavLib.exportJson(state.stav)));
    } catch (e) {
      toast('Nepodařilo se uložit do prohlížeče: ' + e.message);
    }
  }
  async function connectServer() {
    if (location.protocol === 'file:') return;
    try {
      const res = await fetch(state.server.url, { signal: AbortSignal.timeout(4000) });
      if (res.status === 401) {
        location.href = 'login?next=' + encodeURIComponent(location.pathname + location.search + location.hash);
        return;
      }
      if (!res.ok) return;
      try {
        const me = await (await fetch('api/me', { signal: AbortSignal.timeout(4000) })).json();
        if (me && me.prihlaseni && me.jmeno) {
          state.server.user = me.jmeno;
          $('#user-name').textContent = me.jmeno;
          $('#user-box').classList.remove('hidden');
        }
      } catch (_e) { /* bez přihlášení */ }
      const json = await res.json();
      const remote = stavLib.importJson(json).stav || {};
      const merged = stavLib.merge(state.stav, remote);
      // co má lokál navíc/novější → poslat na server
      const toPush = Object.entries(merged).filter(([id, r]) => JSON.stringify(remote[id] || null) !== JSON.stringify(r));
      state.stav = merged;
      saveLocal();
      state.server.on = true;
      for (const [id, r] of toPush) await pushRecord(id, r);
      renderAll();
      $('#meta-line').title = 'Stav oslovení se sdílí přes server (' + Object.keys(merged).length + ' záznamů).';
      toast('Připojeno k serveru – stav oslovení je sdílený.');
    } catch (_e) {
      state.server.on = false;
    }
  }
  async function pushRecord(id, rec) {
    if (!state.server.on) return;
    try {
      const res = await fetch(state.server.url + '/' + encodeURIComponent(id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec) });
      if (res.status === 401) {
        toast('Přihlášení vypršelo – obnovte stránku a přihlaste se.');
        return;
      }
      if (res.ok && state.stav[id]) {
        const j = await res.json().catch(() => null);
        if (j && j.kdo) state.stav[id].kdo = j.kdo;
      }
    } catch (_e) {
      toast('Server nedostupný – změna je zatím jen v tomto prohlížeči.');
    }
  }
  function updateRecord(id, mutate) {
    const prev = state.stav[id] || stavLib.emptyRecord();
    const next = mutate(prev);
    if (stavLib.isEmpty(next)) delete state.stav[id];
    else state.stav[id] = next;
    saveLocal();
    clearTimeout(state.saveTimers.get(id));
    state.saveTimers.set(id, setTimeout(() => pushRecord(id, stavLib.isEmpty(next) ? stavLib.emptyRecord() : next), 600));
    refreshMarker(id);
    renderFilters();
    renderCrumbsAndLabels();
    if (state.view === 'table') renderTable();
  }
  function recordOf(id) {
    return state.stav[id] || null;
  }
  function hasState(id) {
    const r = state.stav[id];
    return Boolean(r && stavLib.STAV_KEYS.some((k) => r[k]));
  }

  // ================================================================== filtrování
  function inScope(kraj, okres) {
    if (state.scope.okres != null) return okres === state.scope.okres;
    if (state.scope.kraj != null) return kraj === state.scope.kraj;
    return true;
  }
  function inScopeList(krajeArr, okresyArr) {
    if (state.scope.okres != null) return okresyArr.includes(state.scope.okres);
    if (state.scope.kraj != null) return krajeArr.includes(state.scope.kraj);
    return true;
  }

  function passesFilters(m, ignoreScope) {
    const f = state.filters;
    if (!ignoreScope && !inScope(m.kraj, m.okres)) return false;
    if (!f.skupiny.has(m.skupina)) return false;
    if (f.typyOff.has(m.typ)) return false;
    if (!f.bezNazvu && m.bezNazvu) return false;
    if (f.okoli === 'trasy') {
      const n = m.blizko.trasy[0];
      if (!n || n[1] > f.okoliTrasyKm * 1000) return false;
    } else if (f.okoli === 'ski') {
      const n = m.blizko.ski[0];
      if (!n || n[1] > f.okoliSkiKm * 1000) return false;
    }
    if (f.pujcovna !== 'vse') {
      const p = efektivniPujcovna(m);
      if (f.pujcovna === 'ano' && !(p === 'ano' || p === 'ano?')) return false;
      if (f.pujcovna === 'ne' && p !== 'ne') return false;
      if (f.pujcovna === 'neznamo' && p !== '') return false;
    }
    if (f.stav !== 'vse') {
      const r = state.stav[m.id];
      const has = Boolean(r && stavLib.STAV_KEYS.some((k) => r[k]));
      if (f.stav === 'sestavem' && !has) return false;
      if (f.stav === 'bezstavu' && has) return false;
      if (f.stav === 'neosloveno' && !(r && r.kontaktovat && !r.nabidka && !r.volano && !r.navsteva)) return false;
      if (stavLib.STAV_KEYS.includes(f.stav) && !(r && r[f.stav])) return false;
    }
    if (f.q && !m._q.includes(f.q)) return false;
    return true;
  }
  function efektivniPujcovna(m) {
    return stavLib.efektivni(m, state.stav[m.id], enrich[m.id]).pujcovna;
  }

  let cache = { key: null, mista: null, trasy: null, ski: null };
  function cacheKey() {
    const f = state.filters;
    return JSON.stringify([state.scope, [...f.druhy], f.ski, [...f.skupiny], [...f.typyOff], f.okoli, f.okoliTrasyKm, f.okoliSkiKm, f.pujcovna, f.stav, f.bezNazvu, f.vseTrasyCR, f.znackyCR, f.q, Object.keys(state.stav).length]);
  }
  function visible() {
    const key = cacheKey();
    if (cache.key === key) return cache;
    const f = state.filters;
    const vm = mista.filter((m) => passesFilters(m, false));
    let vt = trasy.filter((t) => f.druhy.has(t.druh) && inScopeList(t.kraje, t.okresy) && (!f.q || t._q.includes(f.q)));
    const vs = f.ski ? arealy.filter((a) => inScope(a.kraj, a.okres) && (!f.q || a._q.includes(f.q))) : [];
    cache = { key, mista: vm, trasy: vt, ski: vs };
    return cache;
  }
  // trasy k vykreslení (na úrovni ČR jen dálkové + cyklostezky, pokud není zapnuto vše)
  function trasyNaMapu(vt) {
    if (state.scope.kraj != null || state.filters.vseTrasyCR || state.filters.q) return vt;
    return vt.filter((t) => t.druh === 'cyklostezka' || t.sit === 'icn' || t.sit === 'ncn');
  }

  // ================================================================== mapa
  let map;
  let baseLayers;
  let krajeLayer;
  let okresyLayer;
  let labelsLayer;
  let trasyLayer;
  let pistesLayer;
  let skiLayer;
  let mistaLayer;
  let highlightLayer;
  const markerCache = new Map();
  const canvas = L.canvas({ padding: 0.3 });

  function initMap() {
    map = L.map('map', { zoomControl: true, preferCanvas: true, minZoom: 6, maxZoom: 19, worldCopyJump: false });
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">přispěvatelé OpenStreetMap</a>', className: 'base-tiles' });
    const cyclosm = L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '<a href="https://www.cyclosm.org">CyclOSM</a> | &copy; přispěvatelé OpenStreetMap', className: 'base-tiles' });
    const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '<a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA) | &copy; přispěvatelé OpenStreetMap', className: 'base-tiles' });
    baseLayers = { 'Mapa (OSM)': osm, 'Cyklomapa (CyclOSM)': cyclosm, 'Turistická (OpenTopoMap)': topo };
    osm.addTo(map);
    L.control.layers(baseLayers, null, { position: 'topright', collapsed: true }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);

    krajeLayer = L.geoJSON(null, { style: krajStyle, onEachFeature: onKraj }).addTo(map);
    okresyLayer = L.geoJSON(null, { style: okresStyle, onEachFeature: onOkres }).addTo(map);
    labelsLayer = L.layerGroup().addTo(map);
    trasyLayer = L.layerGroup().addTo(map);
    pistesLayer = L.layerGroup().addTo(map);
    skiLayer = L.layerGroup().addTo(map);
    highlightLayer = L.layerGroup().addTo(map);
    mistaLayer = L.markerClusterGroup
      ? L.markerClusterGroup({ chunkedLoading: true, disableClusteringAtZoom: 14, maxClusterRadius: 50, spiderfyOnMaxZoom: true, showCoverageOnHover: false })
      : L.layerGroup();
    mistaLayer.addTo(map);
    map.fitBounds(L.geoJSON(D.hranice.kraje).getBounds(), { padding: [10, 10] });
    map.on('zoomend', () => {
      renderPistes();
    });
  }

  function krajStyle(f) {
    const active = state.scope.kraj == null || state.scope.kraj === f.properties.kod;
    return { color: '#1b2430', weight: state.scope.kraj == null ? 1.6 : 2.2, opacity: active ? 0.9 : 0.35, fillColor: '#1f5fbf', fillOpacity: state.scope.kraj == null ? 0.07 : active ? 0 : 0.02, dashArray: null };
  }
  function okresStyle(f) {
    const active = state.scope.okres == null || state.scope.okres === f.properties.kod;
    return { color: '#1b2430', weight: 1, opacity: active ? 0.75 : 0.3, fillColor: '#1f5fbf', fillOpacity: state.scope.okres == null ? 0.05 : active ? 0 : 0.02, dashArray: '4 3' };
  }
  function onKraj(f, layer) {
    layer.on({
      click: () => setScope(f.properties.kod, null),
      mouseover: (e) => {
        if (state.scope.kraj != null) return;
        e.target.setStyle({ fillOpacity: 0.18, weight: 2.4 });
      },
      mouseout: (e) => krajeLayer.resetStyle(e.target),
    });
    layer.bindTooltip(() => `<b>${esc(f.properties.nazev)}</b><br>${countsText(countsFor('kraj', f.properties.kod))}`, { sticky: true });
  }
  function onOkres(f, layer) {
    layer.on({
      click: () => setScope(f.properties.kraj, f.properties.kod),
      mouseover: (e) => {
        if (state.scope.okres != null) return;
        e.target.setStyle({ fillOpacity: 0.18, weight: 2 });
      },
      mouseout: (e) => okresyLayer.resetStyle(e.target),
    });
    layer.bindTooltip(() => `<b>${esc(f.properties.nazev)}</b><br>${countsText(countsFor('okres', f.properties.kod))}`, { sticky: true });
  }

  // počty viditelných objektů v kraji/okrese (bez ohledu na aktuální scope, ale s ostatními filtry)
  function countsFor(level, kod) {
    const f = state.filters;
    const c = { mista: 0, trasy: 0, ski: 0 };
    for (const m of mista) if ((level === 'kraj' ? m.kraj : m.okres) === kod && passesFilters(m, true)) c.mista++;
    for (const t of trasy) if (f.druhy.has(t.druh) && (level === 'kraj' ? t.kraje : t.okresy).includes(kod) && (!f.q || t._q.includes(f.q))) c.trasy++;
    if (f.ski) for (const a of arealy) if ((level === 'kraj' ? a.kraj : a.okres) === kod && (!f.q || a._q.includes(f.q))) c.ski++;
    return c;
  }
  function countsText(c) {
    return `${fmtN(c.mista)} míst · ${fmtN(c.trasy)} tras · ${fmtN(c.ski)} skiareálů`;
  }

  function renderBoundaries() {
    krajeLayer.clearLayers();
    okresyLayer.clearLayers();
    labelsLayer.clearLayers();
    krajeLayer.addData({ type: 'FeatureCollection', features: kraje });
    if (state.scope.kraj != null) {
      okresyLayer.addData({ type: 'FeatureCollection', features: okresyByKraj.get(state.scope.kraj) || [] });
    }
    // popisky s počty
    const items = state.scope.kraj == null ? kraje : okresyByKraj.get(state.scope.kraj) || [];
    const level = state.scope.kraj == null ? 'kraj' : 'okres';
    for (const f of items) {
      const c = countsFor(level, f.properties.kod);
      const short = level === 'kraj' ? f.properties.nazev.replace(/ kraj$/, '').replace(/^Kraj /, '') : f.properties.nazev;
      const icon = L.divIcon({ className: 'area-label', html: `<div class="lbl">${esc(short)}<small>${fmtN(c.mista)} míst</small></div>`, iconSize: [120, 30], iconAnchor: [60, 15] });
      const mk = L.marker(f.properties.stred, { icon, interactive: false, keyboard: false });
      labelsLayer.addLayer(mk);
    }
  }

  function renderTrasy() {
    trasyLayer.clearLayers();
    const vt = trasyNaMapu(visible().trasy);
    for (const t of vt) {
      const sel = state.selected && state.selected.type === 'trasa' && state.selected.id === t.id;
      const line = L.polyline(t.geom, { renderer: canvas, color: DRUH[t.druh].hex, weight: sel ? 6 : t.sit === 'icn' || t.sit === 'ncn' ? 3 : 2.2, opacity: sel ? 1 : 0.8, interactive: true });
      line.bindTooltip(`<b>${esc(t.label)}</b><br>${esc(trasaSub(t))}`, { sticky: true });
      line.on('click', () => select('trasa', t.id, false));
      trasyLayer.addLayer(line);
    }
  }

  // na úrovni ČR se značky míst a areálů nekreslí (překrývaly by kraje) – leda při hledání nebo na přání
  function znackyViditelne() {
    return state.scope.kraj != null || state.filters.znackyCR || Boolean(state.filters.q);
  }

  function renderSki() {
    skiLayer.clearLayers();
    if (!znackyViditelne()) {
      pistesLayer.clearLayers();
      return;
    }
    for (const a of visible().ski) {
      const sel = state.selected && state.selected.type === 'ski' && state.selected.id === a.id;
      const icon = L.divIcon({ className: '', html: `<div class="marker-ski${sel ? ' sel' : ''}${hasState(a.id) ? ' has-state' : ''}" title="${esc(a.nazev)}">⛷</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
      const mk = L.marker([a.lat, a.lon], { icon, zIndexOffset: 500 });
      mk.bindTooltip(`<b>${esc(a.nazev)}</b><br>${esc(skiSub(a))}`);
      mk.on('click', () => select('ski', a.id, false));
      skiLayer.addLayer(mk);
    }
    renderPistes();
  }

  function renderPistes() {
    pistesLayer.clearLayers();
    if (!state.filters.ski) return;
    const zoom = map.getZoom();
    if (zoom < 11 && state.scope.okres == null) return;
    const ids = new Set(visible().ski.map((a) => a.id));
    const bounds = map.getBounds().pad(0.2);
    for (const s of sjezdovky) {
      if (!s.areal || !ids.has(s.areal)) continue;
      const p = s.geom[0][0];
      if (!bounds.contains(p)) continue;
      const line = L.polyline(s.geom, { renderer: canvas, color: SKI_HEX, weight: 3, opacity: 0.85 });
      line.bindTooltip(`<b>${esc(s.nazev || 'Sjezdovka')}</b>${s.obtiznost ? ' · ' + esc(s.obtiznost) : ''} · ${s.delkaKm} km`, { sticky: true });
      line.on('click', () => select('ski', s.areal, false));
      pistesLayer.addLayer(line);
    }
    for (const v of vleky) {
      if (!v.areal || !ids.has(v.areal)) continue;
      const p = v.geom[0][0];
      if (!bounds.contains(p)) continue;
      const line = L.polyline(v.geom, { renderer: canvas, color: '#495057', weight: 1.5, opacity: 0.8, dashArray: '3 4' });
      line.bindTooltip(`${esc(v.nazev || 'Vlek / lanovka')} (${esc(v.typ)})`, { sticky: true });
      pistesLayer.addLayer(line);
    }
  }

  function markerFor(m) {
    let mk = markerCache.get(m.id);
    if (!mk) {
      mk = L.marker([m.lat, m.lon], { icon: pinIcon(m), title: m.nazev });
      mk.bindTooltip(() => `<b>${esc(m.nazev)}</b><br>${esc(m.typLabel)}${m.obec ? ' · ' + esc(m.obec) : ''}`);
      mk.on('click', () => select('misto', m.id, false));
      mk._mistoId = m.id;
      markerCache.set(m.id, mk);
    }
    return mk;
  }
  function pinIcon(m) {
    const sel = state.selected && state.selected.type === 'misto' && state.selected.id === m.id;
    const size = sel ? 20 : 14;
    const hex = SKUPINA[m.skupina].hex;
    return L.divIcon({ className: '', html: `<div class="marker-pin${sel ? ' sel' : ''}${hasState(m.id) ? ' has-state' : ''}" style="background:${hex}"></div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  }
  function refreshMarker(id) {
    const mk = markerCache.get(id);
    const m = mistoById.get(id);
    if (mk && m) mk.setIcon(pinIcon(m));
    if (arealById.has(id)) renderSki();
  }

  function renderMista() {
    mistaLayer.clearLayers();
    if (!znackyViditelne()) return;
    const vm = visible().mista;
    const markers = vm.map(markerFor);
    if (mistaLayer.addLayers) mistaLayer.addLayers(markers);
    else for (const mk of markers) mistaLayer.addLayer(mk);
  }

  function renderHighlight() {
    highlightLayer.clearLayers();
    const s = state.selected;
    if (!s) return;
    if (s.type === 'misto') {
      const m = mistoById.get(s.id);
      if (!m) return;
      // okruh „okolí“ a čáry k nejbližší trase / areálu
      const t = m.blizko.trasy[0] && trasaById.get(m.blizko.trasy[0][0]);
      if (t) highlightLayer.addLayer(L.polyline(t.geom, { renderer: canvas, color: '#ff922b', weight: 6, opacity: 0.55, interactive: false }));
      highlightLayer.addLayer(L.circleMarker([m.lat, m.lon], { radius: 16, color: '#1f5fbf', weight: 2, fill: false, interactive: false }));
    } else if (s.type === 'trasa') {
      const t = trasaById.get(s.id);
      if (t) highlightLayer.addLayer(L.polyline(t.geom, { renderer: canvas, color: '#ffd43b', weight: 9, opacity: 0.6, interactive: false }));
    } else if (s.type === 'ski') {
      const a = arealById.get(s.id);
      if (a && a.polygon) for (const ring of a.polygon) highlightLayer.addLayer(L.polygon(ring, { color: SKI_HEX, weight: 2, fillOpacity: 0.12, interactive: false }));
      if (a) highlightLayer.addLayer(L.circle([a.lat, a.lon], { radius: state.filters.okoliSkiKm * 1000, color: SKI_HEX, weight: 1, dashArray: '4 4', fillOpacity: 0.03, interactive: false }));
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
          if (!inScope(m.kraj, m.okres)) {
            state.scope = { kraj: m.kraj, okres: m.okres };
          }
          map.setView([m.lat, m.lon], Math.max(map.getZoom(), 14));
        }
      } else if (type === 'trasa') {
        const t = trasaById.get(id);
        if (t && t.bbox) {
          if (!inScopeList(t.kraje, t.okresy)) state.scope = { kraj: t.kraje[0] || null, okres: null };
          map.fitBounds([[t.bbox[0], t.bbox[1]], [t.bbox[2], t.bbox[3]]], { padding: [30, 30] });
        }
      } else if (type === 'ski') {
        const a = arealById.get(id);
        if (a) {
          if (!inScope(a.kraj, a.okres)) state.scope = { kraj: a.kraj, okres: a.okres };
          map.setView([a.lat, a.lon], Math.max(map.getZoom(), 13));
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
    if (state.view === 'table') p.set('view', 'table');
    const h = p.toString();
    if (('#' + h) !== location.hash) history.replaceState(null, '', h ? '#' + h : location.pathname + location.search);
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
    for (const type of ['misto', 'trasa', 'ski']) {
      const id = p.get(type);
      if (id && (type === 'misto' ? mistoById : type === 'trasa' ? trasaById : arealById).has(id)) state.selected = { type, id };
    }
    if (p.get('view') === 'table') state.view = 'table';
  }

  // ================================================================== vykreslení
  function renderAll() {
    renderBoundaries();
    renderTrasy();
    renderSki();
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
  function renderCrumbsAndLabels() {
    renderBoundaries();
    renderCrumbs();
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
    el.innerHTML = parts.map((p) => (typeof p === 'string' ? p : p.html)).join('') + krajSel + okresSel + `<span class="muted small" style="margin-left:10px">${fmtN(v.mista.length)} míst · ${fmtN(v.trasy.length)} tras · ${fmtN(v.ski.length)} skiareálů</span>`;
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
    ml.textContent = meta.vytvoreno ? `data OSM k ${new Date(meta.vytvoreno).toLocaleDateString('cs-CZ')}` : '';
    let hint = $('#map-hint');
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'map-hint';
      hint.className = 'map-hint';
      $('#map-wrap').appendChild(hint);
    }
    hint.textContent = state.scope.kraj == null && !znackyViditelne() ? 'Klikněte na kraj, potom na okres – zobrazí se místa v okolí tras a sjezdovek.' : state.scope.okres == null && state.scope.kraj != null ? 'Klikněte na okres nebo na značku. Zpět přes drobečkovou navigaci nahoře.' : '';
    hint.classList.toggle('hidden', !hint.textContent);
  }
  function crumb(label, current, onClick) {
    return { html: `<button type="button" class="crumb" ${current ? 'aria-current="page"' : ''}>${esc(label)}</button>`, onClick: current ? null : onClick };
  }

  function renderLegend() {
    const el = $('#legend');
    const f = state.filters;
    const items = [];
    for (const d of DRUHY_TRAS) if (f.druhy.has(d.key)) items.push(`<span class="item"><span class="swatch line" style="background:${d.hex}"></span>${esc(d.label.split(' (')[0])}</span>`);
    if (f.ski) items.push(`<span class="item"><span class="marker-ski" style="width:16px;height:16px;font-size:10px;border-width:1px">⛷</span>Skiareál / sjezdovka</span>`);
    for (const s of SKUPINY) if (f.skupiny.has(s.key)) items.push(`<span class="item"><span class="swatch dot" style="background:${s.hex}"></span>${esc(s.label)}</span>`);
    items.push('<span class="item"><span class="swatch dot" style="background:#888;border:2px solid #ffd43b;box-sizing:border-box"></span>má stav oslovení</span>');
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
        <div class="fgroup" id="fg-summary"><h3>Ve výběru</h3><div class="summary" id="summary"></div></div>
        <div class="fgroup"><h3>Trasy a sjezdovky</h3>
          ${DRUHY_TRAS.map((d) => `<label class="check"><input type="checkbox" data-druh="${d.key}"><span class="swatch line" style="background:${d.hex}"></span>${esc(d.label)}<span class="cnt" data-cnt-druh="${d.key}"></span></label>`).join('')}
          <label class="check"><input type="checkbox" id="f-ski"><span class="swatch" style="background:${SKI_HEX}"></span>Skiareály a sjezdovky<span class="cnt" id="cnt-ski"></span></label>
          <label class="check sub small"><input type="checkbox" id="f-vsetrasy">Všechny trasy i na úrovni ČR (pomalejší)</label>
          <label class="check sub small"><input type="checkbox" id="f-znackycr">Značky míst a skiareálů i na úrovni ČR</label>
        </div>
        <div class="fgroup"><h3>Místa v okolí</h3>
          ${SKUPINY.map((s) => `<label class="check"><input type="checkbox" data-skupina="${s.key}"><span class="swatch dot" style="background:${s.hex}"></span>${esc(s.label)}<span class="cnt" data-cnt-skupina="${s.key}"></span></label>
            <div class="sub-typy" data-sub="${s.key}">${TYPY.filter((t) => t.skupina === s.key).map((t) => `<label class="check sub"><input type="checkbox" data-typ="${t.key}">${esc(t.label)}<span class="cnt" data-cnt-typ="${t.key}"></span></label>`).join('')}</div>`).join('')}
          <label class="check small"><input type="checkbox" id="f-beznazvu">Zobrazit i místa bez názvu</label>
        </div>
        <div class="fgroup"><h3>Jen místa v okolí</h3>
          <div class="seg" id="seg-okoli"><button type="button" data-okoli="vse">Vše</button><button type="button" data-okoli="trasy">u cyklotras</button><button type="button" data-okoli="ski">u skiareálů</button></div>
          <div id="okoli-trasy" class="stack-sm" style="margin-top:8px"><label class="small">do <b id="okoli-trasy-km"></b> km od nejbližší cyklotrasy</label><input type="range" class="range" id="f-okoli-trasy" min="0.25" max="3" step="0.25"></div>
          <div id="okoli-ski" class="stack-sm" style="margin-top:8px"><label class="small">do <b id="okoli-ski-km"></b> km od nejbližšího skiareálu</label><input type="range" class="range" id="f-okoli-ski" min="1" max="15" step="1"></div>
        </div>
        <div class="fgroup"><h3>Půjčovna</h3>
          <select class="select" id="f-pujcovna">
            <option value="vse">Vše</option>
            <option value="ano">Provozuje půjčovnu (ano / podle webu)</option>
            <option value="ne">Neprovozuje</option>
            <option value="neznamo">Neznámo</option>
          </select>
        </div>
        <div class="fgroup"><h3>Stav oslovení</h3>
          <select class="select" id="f-stav">
            <option value="vse">Vše</option>
            <option value="bezstavu">Bez stavu</option>
            <option value="sestavem">S jakýmkoli stavem</option>
            <option value="neosloveno">Chceme kontaktovat – zatím neosloveno</option>
            ${stavLib.STAVY.map((s) => `<option value="${s.key}">${esc(s.label)}</option>`).join('')}
          </select>
        </div>
        <div class="fgroup small muted" id="fg-sources"></div>`;
      filtersBuilt = true;
      root.addEventListener('change', onFilterChange);
      root.addEventListener('input', onFilterInput);
      root.querySelectorAll('#seg-okoli button').forEach((b) => b.addEventListener('click', () => {
        f.okoli = b.dataset.okoli;
        afterFilterChange();
      }));
      $('#fg-sources').innerHTML = `Zdroje: ${(meta.zdroje || []).map((z) => `<a href="${esc(z.url)}" target="_blank" rel="noopener">${esc(z.nazev)}</a>`).join(' · ')}. Stav oslovení se ukládá do tohoto prohlížeče${state.server.on ? ' a na server' : ''}; zálohu uděláte tlačítkem „Stav oslovení“.`;
    }
    // hodnoty
    root.querySelectorAll('[data-druh]').forEach((i) => (i.checked = f.druhy.has(i.dataset.druh)));
    $('#f-ski').checked = f.ski;
    $('#f-vsetrasy').checked = f.vseTrasyCR;
    $('#f-znackycr').checked = f.znackyCR;
    root.querySelectorAll('[data-skupina]').forEach((i) => (i.checked = f.skupiny.has(i.dataset.skupina)));
    root.querySelectorAll('[data-sub]').forEach((d) => d.classList.toggle('hidden', !f.skupiny.has(d.dataset.sub)));
    root.querySelectorAll('[data-typ]').forEach((i) => (i.checked = !f.typyOff.has(i.dataset.typ)));
    $('#f-beznazvu').checked = f.bezNazvu;
    root.querySelectorAll('#seg-okoli button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.okoli === f.okoli)));
    $('#okoli-trasy').classList.toggle('hidden', f.okoli !== 'trasy');
    $('#okoli-ski').classList.toggle('hidden', f.okoli !== 'ski');
    $('#f-okoli-trasy').value = f.okoliTrasyKm;
    $('#okoli-trasy-km').textContent = f.okoliTrasyKm;
    $('#f-okoli-ski').value = f.okoliSkiKm;
    $('#okoli-ski-km').textContent = f.okoliSkiKm;
    $('#f-pujcovna').value = f.pujcovna;
    $('#f-stav').value = f.stav;
    // počty ve výběru
    const byDruh = {};
    for (const t of v.trasy) byDruh[t.druh] = (byDruh[t.druh] || 0) + 1;
    root.querySelectorAll('[data-cnt-druh]').forEach((e) => (e.textContent = f.druhy.has(e.dataset.cntDruh) ? fmtN(byDruh[e.dataset.cntDruh] || 0) : ''));
    $('#cnt-ski').textContent = f.ski ? fmtN(v.ski.length) : '';
    const bySk = {};
    const byTyp = {};
    for (const m of v.mista) {
      bySk[m.skupina] = (bySk[m.skupina] || 0) + 1;
      byTyp[m.typ] = (byTyp[m.typ] || 0) + 1;
    }
    root.querySelectorAll('[data-cnt-skupina]').forEach((e) => (e.textContent = f.skupiny.has(e.dataset.cntSkupina) ? fmtN(bySk[e.dataset.cntSkupina] || 0) : ''));
    root.querySelectorAll('[data-cnt-typ]').forEach((e) => (e.textContent = fmtN(byTyp[e.dataset.cntTyp] || 0)));
    const sum = stavLib.summary(Object.fromEntries(v.mista.filter((m) => state.stav[m.id]).map((m) => [m.id, state.stav[m.id]])));
    const pujc = v.mista.filter((m) => /^ano/.test(efektivniPujcovna(m))).length;
    $('#summary').innerHTML = `
      <div class="stat"><b>${fmtN(v.mista.length)}</b><span>míst</span></div>
      <div class="stat"><b>${fmtN(pujc)}</b><span>s půjčovnou</span></div>
      ${stavLib.STAVY.map((s) => `<div class="stat"><b style="color:${s.barva}">${fmtN(sum[s.key])}</b><span>${esc(s.short)}</span></div>`).join('')}`;
  }
  function onFilterChange(e) {
    const t = e.target;
    const f = state.filters;
    if (t.dataset.druh) {
      if (t.checked) f.druhy.add(t.dataset.druh);
      else f.druhy.delete(t.dataset.druh);
    } else if (t.id === 'f-ski') f.ski = t.checked;
    else if (t.id === 'f-vsetrasy') f.vseTrasyCR = t.checked;
    else if (t.id === 'f-znackycr') f.znackyCR = t.checked;
    else if (t.dataset.skupina) {
      if (t.checked) f.skupiny.add(t.dataset.skupina);
      else f.skupiny.delete(t.dataset.skupina);
    } else if (t.dataset.typ) {
      if (t.checked) f.typyOff.delete(t.dataset.typ);
      else f.typyOff.add(t.dataset.typ);
    } else if (t.id === 'f-beznazvu') f.bezNazvu = t.checked;
    else if (t.id === 'f-pujcovna') f.pujcovna = t.value;
    else if (t.id === 'f-stav') f.stav = t.value;
    else if (t.id === 'f-okoli-trasy') f.okoliTrasyKm = Number(t.value);
    else if (t.id === 'f-okoli-ski') f.okoliSkiKm = Number(t.value);
    else return;
    afterFilterChange();
  }
  function onFilterInput(e) {
    const t = e.target;
    if (t.id === 'f-okoli-trasy') $('#okoli-trasy-km').textContent = t.value;
    if (t.id === 'f-okoli-ski') $('#okoli-ski-km').textContent = t.value;
  }
  function afterFilterChange() {
    state.listLimit = 150;
    renderAll();
  }

  // ------------------------------------------------------------------ pravý panel: záložky + seznam
  function renderSide() {
    const v = visible();
    const tabs = $('#side-tabs');
    tabs.innerHTML = [
      ['mista', 'Místa', v.mista.length],
      ['trasy', 'Trasy', v.trasy.length],
      ['ski', 'Skiareály', v.ski.length],
    ]
      .map(([k, l, n]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${state.tab === k}">${l}<span class="cnt">${fmtN(n)}</span></button>`)
      .join('');
    tabs.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      state.selected = null;
      state.listLimit = 150;
      renderAll();
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
      renderList();
    }
  }

  function renderList() {
    const v = visible();
    const list = $('#side-list');
    let items;
    let html = '';
    const sortSel = `<select class="select" id="sort-sel" aria-label="Řazení">
        <option value="nazev">podle názvu</option>
        <option value="trasa">podle vzdálenosti od cyklotrasy</option>
        <option value="ski">podle vzdálenosti od skiareálu</option>
        <option value="stav">podle stavu oslovení</option>
        <option value="typ">podle typu</option>
      </select>`;
    if (state.tab === 'mista') {
      items = sortMista(v.mista.slice());
      html += `<div class="toolbar">${sortSel}<span class="muted small">${fmtN(items.length)} míst</span></div>`;
      if (!items.length) html += emptyHtml('Žádná místa neodpovídají filtrům.');
      for (const m of items.slice(0, state.listLimit)) html += mistoRow(m);
      if (items.length > state.listLimit) html += `<button type="button" class="more" id="more">Zobrazit dalších ${fmtN(Math.min(300, items.length - state.listLimit))} (z ${fmtN(items.length - state.listLimit)})</button>`;
    } else if (state.tab === 'trasy') {
      items = v.trasy.slice().sort((a, b) => (a.druh === b.druh ? 0 : a.druh === 'cyklostezka' ? 1 : -1) || sitRank(a) - sitRank(b) || a.label.localeCompare(b.label, 'cs'));
      html += `<div class="toolbar"><span class="muted small">${fmtN(items.length)} tras · seřazeno podle významu a názvu</span></div>`;
      if (!items.length) html += emptyHtml('Žádné trasy ve výběru.');
      for (const t of items.slice(0, state.listLimit)) html += trasaRow(t);
      if (items.length > state.listLimit) html += `<button type="button" class="more" id="more">Zobrazit další</button>`;
    } else {
      items = v.ski.slice().sort((a, b) => (b.sjezdovky.pocet + b.vleky.pocet) - (a.sjezdovky.pocet + a.vleky.pocet) || a.nazev.localeCompare(b.nazev, 'cs'));
      html += `<div class="toolbar"><span class="muted small">${fmtN(items.length)} skiareálů · seřazeno podle velikosti</span></div>`;
      if (!items.length) html += emptyHtml('Žádné skiareály ve výběru.');
      for (const a of items.slice(0, state.listLimit)) html += skiRow(a);
      if (items.length > state.listLimit) html += `<button type="button" class="more" id="more">Zobrazit další</button>`;
    }
    list.innerHTML = html;
    const ss = $('#sort-sel');
    if (ss) {
      ss.value = state.sort;
      ss.addEventListener('change', () => {
        state.sort = ss.value;
        renderList();
      });
    }
    list.querySelectorAll('.list-item').forEach((el) => el.addEventListener('click', () => select(el.dataset.type, el.dataset.id)));
    const more = $('#more');
    if (more) more.addEventListener('click', () => {
      state.listLimit += 300;
      renderList();
    });
  }
  function sitRank(t) {
    return { icn: 0, ncn: 1, rcn: 2, lcn: 3 }[t.sit] ?? 4;
  }
  function sortMista(arr) {
    const s = state.sort;
    const dist = (m, k) => (m.blizko[k][0] ? m.blizko[k][0][1] : Infinity);
    const stavRank = (m) => {
      const r = state.stav[m.id];
      if (!r) return 9;
      if (r.navsteva) return 0;
      if (r.volano) return 1;
      if (r.nabidka) return 2;
      if (r.kontaktovat) return 3;
      return 8;
    };
    if (s === 'trasa') arr.sort((a, b) => dist(a, 'trasy') - dist(b, 'trasy') || a.nazev.localeCompare(b.nazev, 'cs'));
    else if (s === 'ski') arr.sort((a, b) => dist(a, 'ski') - dist(b, 'ski') || a.nazev.localeCompare(b.nazev, 'cs'));
    else if (s === 'stav') arr.sort((a, b) => stavRank(a) - stavRank(b) || a.nazev.localeCompare(b.nazev, 'cs'));
    else if (s === 'typ') arr.sort((a, b) => a.typLabel.localeCompare(b.typLabel, 'cs') || a.nazev.localeCompare(b.nazev, 'cs'));
    else arr.sort((a, b) => a.nazev.localeCompare(b.nazev, 'cs'));
    return arr;
  }
  function emptyHtml(text) {
    return `<div class="empty">${esc(text)}</div>`;
  }
  function stavBadges(id) {
    const r = state.stav[id];
    if (!r) return '';
    return stavLib.STAVY.filter((s) => r[s.key]).map((s) => `<span class="badge" style="background:${s.barva}22;color:${s.barva}">${esc(s.short)}</span>`).join('');
  }
  function pujcovnaBadge(m) {
    const p = efektivniPujcovna(m);
    if (p === 'ano') return '<span class="badge ok">půjčovna</span>';
    if (p === 'ano?') return '<span class="badge warn" title="Podle textu webu – ověřit">půjčovna?</span>';
    if (p === 'ne') return '<span class="badge">bez půjčovny</span>';
    return '';
  }
  function mistoRow(m) {
    const sel = state.selected && state.selected.type === 'misto' && state.selected.id === m.id;
    const near = m.blizko.trasy[0];
    const nearSki = m.blizko.ski[0];
    const sub = [m.typLabel, m.obec || okresName(m.okres)].filter(Boolean).join(' · ');
    const dist = near ? `${fmtKm(near[1])} od trasy` : nearSki ? `${fmtKm(nearSki[1])} od skiareálu` : '';
    return `<div class="list-item${sel ? ' sel' : ''}" data-type="misto" data-id="${m.id}">
      <span class="dot" style="background:${SKUPINA[m.skupina].hex}"></span>
      <span class="name">${esc(m.nazev)}</span>
      <span class="dist">${esc(dist)}</span>
      <span class="sub">${esc(sub)}</span>
      <span class="badges">${pujcovnaBadge(m)}${stavBadges(m.id)}${m.telefon.length || m.email.length ? '<span class="badge info">kontakt</span>' : enrich[m.id] && enrich[m.id].stav === 'ok' && (enrich[m.id].emaily.length || enrich[m.id].telefony.length) ? '<span class="badge info">kontakt z webu</span>' : ''}</span>
    </div>`;
  }
  function trasaSub(t) {
    return [DRUH[t.druh].label.split(' (')[0], t.sit ? SIT_LABEL[t.sit] : null, t.delkaKm ? `${fmtKm(t.delkaKm * 1000)}` : null].filter(Boolean).join(' · ');
  }
  function trasaRow(t) {
    const sel = state.selected && state.selected.type === 'trasa' && state.selected.id === t.id;
    const n = (mistaByTrasa.get(t.id) || []).length;
    return `<div class="list-item${sel ? ' sel' : ''}" data-type="trasa" data-id="${t.id}">
      <span class="dot line" style="background:${DRUH[t.druh].hex}"></span>
      <span class="name">${esc(t.label)}</span>
      <span class="dist">${fmtN(n)} míst</span>
      <span class="sub">${esc(trasaSub(t))}${t.popis ? ' · ' + esc(trunc(t.popis, 60)) : ''}</span>
    </div>`;
  }
  function skiSub(a) {
    const parts = [];
    if (a.sjezdovky.pocet) parts.push(`${a.sjezdovky.pocet} sjezdovek (${a.sjezdovky.km} km)`);
    if (a.vleky.pocet) parts.push(`${a.vleky.pocet} vleků/lanovek`);
    if (a.stav && a.stav !== 'operating' && a.stav !== 'unknown') parts.push(a.stav);
    parts.push(okresName(a.okres));
    return parts.filter(Boolean).join(' · ');
  }
  function skiRow(a) {
    const sel = state.selected && state.selected.type === 'ski' && state.selected.id === a.id;
    const n = (mistaByAreal.get(a.id) || []).length;
    return `<div class="list-item${sel ? ' sel' : ''}" data-type="ski" data-id="${a.id}">
      <span class="dot" style="background:${SKI_HEX};border-radius:3px"></span>
      <span class="name">${esc(a.nazev)}</span>
      <span class="dist">${fmtN(n)} míst</span>
      <span class="sub">${esc(skiSub(a))}</span>
      <span class="badges">${stavBadges(a.id)}</span>
    </div>`;
  }

  // ------------------------------------------------------------------ detail
  function renderDetail() {
    const root = $('#side-detail');
    const s = state.selected;
    if (!s) return;
    if (s.type === 'misto') renderMistoDetail(root, mistoById.get(s.id));
    else if (s.type === 'trasa') renderTrasaDetail(root, trasaById.get(s.id));
    else renderSkiDetail(root, arealById.get(s.id));
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
  function searchLinks(name, obec) {
    const q = encodeURIComponent([name, obec].filter(Boolean).join(' '));
    const qn = encodeURIComponent(name);
    return `<div class="links">
      <a href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener">Google</a>
      <a href="https://www.google.com/search?q=${encodeURIComponent([name, obec, 'půjčovna kol'].filter(Boolean).join(' '))}" target="_blank" rel="noopener">Google: půjčovna kol</a>
      <a href="https://www.firmy.cz/?q=${q}" target="_blank" rel="noopener">Firmy.cz</a>
      <a href="https://mapy.cz/zakladni?q=${q}" target="_blank" rel="noopener">Mapy.cz</a>
      <a href="https://ares.gov.cz/ekonomicke-subjekty?obchodniJmeno=${qn}" target="_blank" rel="noopener">ARES</a>
      <a href="https://www.seznam.cz/?q=${q}" target="_blank" rel="noopener">Seznam</a>
    </div>`;
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

  function renderMistoDetail(root, m) {
    if (!m) return;
    const r = recordOf(m.id) || stavLib.emptyRecord();
    const en = enrich[m.id];
    const ef = stavLib.efektivni(m, r, en);
    const osmUrl = 'https://www.openstreetmap.org/' + m.osm;
    const nearT = m.blizko.trasy.map(([id, d]) => [trasaById.get(id), d]).filter((x) => x[0]);
    const nearS = m.blizko.ski.map(([id, d]) => [arealById.get(id), d]).filter((x) => x[0]);
    root.innerHTML = `
      <div class="detail-head"><h2>${esc(m.nazev)}</h2>${backBtn()}</div>
      <div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:10px">
        <span class="badge" style="background:${SKUPINA[m.skupina].hex}22;color:${SKUPINA[m.skupina].hex}">${esc(m.typLabel)}</span>
        ${pujcovnaBadge(m)}${stavBadges(m.id)}
        ${m.stitky.length > 1 ? m.stitky.slice(1).map((s) => `<span class="badge">${esc(s)}</span>`).join('') : ''}
      </div>
      <dl class="kv">
        <dt>Adresa</dt><dd>${esc(m.adresa || m.obec || '—')}</dd>
        <dt>Okres / kraj</dt><dd>${esc(okresName(m.okres))} · ${esc(krajName(m.kraj))}</dd>
        <dt>Provozovatel</dt><dd>${esc(ef.provozovatel || '—')}${en && en.ares && en.ares.nazev && !r.provozovatel && !m.operator ? ' <span class="muted small">(ARES podle IČO z webu)</span>' : ''}</dd>
        <dt>Telefon</dt><dd>${ef.telefon ? telLinks(ef.telefon.split(/,\s*/)) : '—'}</dd>
        <dt>E-mail</dt><dd>${ef.email ? mailLinks(ef.email.split(/,\s*/)) : '—'}</dd>
        <dt>Web</dt><dd>${m.web.map(linkify).join('<br>') || (ef.web ? linkify(ef.web) : '—')}${m.social.length ? '<br>' + m.social.map(linkify).join('<br>') : ''}</dd>
        <dt>Půjčovna</dt><dd>${pujcovnaText(m, r, en)}</dd>
        ${m.hvezdy ? `<dt>Hvězdy</dt><dd>${'★'.repeat(Math.min(5, Math.round(m.hvezdy)))}</dd>` : ''}
        ${m.kapacita ? `<dt>Kapacita</dt><dd>${esc(String(m.kapacita))}</dd>` : ''}
        ${m.oteviraci ? `<dt>Otevírací doba</dt><dd class="small">${esc(m.oteviraci)}</dd>` : ''}
        ${m.popis ? `<dt>Popis</dt><dd class="small">${esc(m.popis)}</dd>` : ''}
        <dt>Zdroj</dt><dd class="small"><a href="${esc(osmUrl)}" target="_blank" rel="noopener">OpenStreetMap ${esc(m.osm)}</a> · <a href="https://mapy.cz/zakladni?x=${m.lon}&y=${m.lat}&z=16&source=coor&id=${m.lon}%2C${m.lat}" target="_blank" rel="noopener">Mapy.cz</a></dd>
      </dl>

      <div class="section"><h3>V okolí</h3>
        ${nearT.length ? `<ul class="near-list">${nearT.map(([t, d]) => `<li><button type="button" data-go-type="trasa" data-go-id="${t.id}">${esc(t.label)}</button><span class="muted nowrap">${fmtKm(d)}</span></li>`).join('')}</ul>` : '<div class="muted small">Žádná cyklotrasa do 3 km.</div>'}
        ${nearS.length ? `<ul class="near-list" style="margin-top:6px">${nearS.map(([a, d]) => `<li><button type="button" data-go-type="ski" data-go-id="${a.id}">⛷ ${esc(a.nazev)}</button><span class="muted nowrap">${fmtKm(d)}</span></li>`).join('')}</ul>` : '<div class="muted small" style="margin-top:6px">Žádný skiareál do 15 km.</div>'}
      </div>

      <div class="section"><h3>Z webu (automaticky)</h3>${enrichHtml(m, en)}</div>

      <div class="section"><h3>Hledat na webu</h3>${searchLinks(m.nazev, m.obec || okresName(m.okres))}</div>

      <div class="section"><h3>Kontakt a stav oslovení</h3>${crmFormHtml(m.id, r, ef)}</div>`;
    bindBack(root);
    bindCrmForm(root, m.id, m, en);
  }
  function pujcovnaText(m, r, en) {
    if (r.pujcovna === 'ano') return 'ano <span class="muted small">(ručně zadáno)</span>';
    if (r.pujcovna === 'ne') return 'ne <span class="muted small">(ručně zadáno)</span>';
    if (m.pujcovna === 'ano') return `ano <span class="muted small">(OSM${m.pujcovnaDruh.length ? ': ' + esc(m.pujcovnaDruh.join(', ')) : ''})</span>`;
    if (m.pujcovna === 'ne') return 'ne <span class="muted small">(OSM)</span>';
    if (en && en.pujcovna && (en.pujcovna.kola || en.pujcovna.lyze)) return `pravděpodobně ano <span class="muted small">(web zmiňuje půjčovnu ${[en.pujcovna.kola ? 'kol' : null, en.pujcovna.lyze ? 'lyží' : null].filter(Boolean).join(' a ')})</span>`;
    return '<span class="muted">neznámo</span>';
  }
  function enrichHtml(m, en) {
    if (!m.web.length) return '<div class="muted small">Místo nemá v OSM uvedený web – zkuste odkazy níže.</div>';
    if (!en) return '<div class="muted small">Web ještě nebyl projitý (spusťte <code>npm run enrich</code>).</div>';
    if (en.stav !== 'ok') return `<div class="muted small">Web ${esc(en.web || m.web[0])} se nepodařilo načíst (${esc(en.chyba || 'chyba')}) – ${esc(fmtDate(en.kdy))}.</div>`;
    const parts = [];
    if (en.emaily && en.emaily.length) parts.push(`<div><b>E-maily:</b> ${mailLinks(en.emaily)}</div>`);
    if (en.telefony && en.telefony.length) parts.push(`<div><b>Telefony:</b> ${telLinks(en.telefony)}</div>`);
    if (en.ares && en.ares.nazev) parts.push(`<div><b>Firma (ARES):</b> ${esc(en.ares.nazev)}${en.ares.forma ? ' · ' + esc(pravniForma(en.ares.forma)) : ''}${en.ares.sidlo ? '<br><span class="muted small">' + esc(en.ares.sidlo) + '</span>' : ''} <span class="muted small">IČO ${esc(en.ares.ico)}</span></div>`);
    else if (en.ico && en.ico.length) parts.push(`<div><b>IČO:</b> ${esc(en.ico.join(', '))}</div>`);
    if (en.provozovatel) parts.push(`<div><b>Provozovatel (text webu):</b> ${esc(en.provozovatel)}</div>`);
    if (en.pujcovna) {
      const p = en.pujcovna;
      if (p.kola || p.lyze) parts.push(`<div><b>Půjčovna:</b> web zmiňuje půjčovnu ${[p.kola ? 'kol' : null, p.lyze ? 'lyží' : null].filter(Boolean).join(' a ')}${p.ukazky.length ? p.ukazky.map((u) => `<div class="snippet">„…${esc(u)}…“</div>`).join('') : ''}</div>`);
      else if (p.obecne) parts.push(`<div><b>Půjčovna:</b> web zmiňuje půjčování (nejasné čeho)${p.ukazky.length ? `<div class="snippet">„…${esc(p.ukazky[0])}…“</div>` : ''}</div>`);
      else parts.push('<div><b>Půjčovna:</b> web ji nezmiňuje</div>');
    }
    if (!parts.length) parts.push('<div class="muted">Na webu se nepodařilo nic vytěžit.</div>');
    return `<div class="enrich">${parts.join('')}<div class="muted small" style="margin-top:6px">${esc(en.web)} · ${en.stranky} str. · ${esc(fmtDate(en.kdy))}</div></div>
      <div class="row" style="margin-top:8px"><button type="button" class="btn btn-sm" id="take-enrich">Převzít do kontaktů</button><span class="muted small">doplní jen prázdná pole</span></div>`;
  }

  function crmFormHtml(id, r, ef) {
    return `
      <div id="crm-states">${stavLib.STAVY.map((s) => `<label class="state-check${r[s.key] ? ' on' : ''}"><input type="checkbox" data-stav="${s.key}" ${r[s.key] ? 'checked' : ''}><span>${esc(s.label)}</span><span class="date">${r.datumy && r.datumy[s.key] ? esc(fmtDate(r.datumy[s.key])) : ''}</span></label>`).join('')}</div>
      <div class="field"><label>Poznámka</label><textarea class="input" rows="3" data-pole="poznamka" placeholder="Kdo, kdy, co domluveno…">${esc(r.poznamka)}</textarea></div>
      <div class="field"><label>Provozuje půjčovnu</label><select class="select" data-pole="pujcovna"><option value="">neznámo / podle dat</option><option value="ano" ${r.pujcovna === 'ano' ? 'selected' : ''}>ano</option><option value="ne" ${r.pujcovna === 'ne' ? 'selected' : ''}>ne</option></select></div>
      <div class="field"><label>Provozovatel (jméno / firma)</label><input class="input" data-pole="provozovatel" value="${esc(r.provozovatel)}" placeholder="${esc(ef.provozovatel || '')}"></div>
      <div class="field"><label>Telefon</label><input class="input" data-pole="telefon" value="${esc(r.telefon)}" placeholder="${esc(ef.telefon || '')}"></div>
      <div class="field"><label>E-mail</label><input class="input" data-pole="email" value="${esc(r.email)}" placeholder="${esc(ef.email || '')}"></div>
      <div class="field"><label>Web</label><input class="input" data-pole="web" value="${esc(r.web)}" placeholder="${esc(ef.web || '')}"><span class="hint">Šedě předvyplněné hodnoty jsou z dat (OSM / web); vlastní zápis má přednost.</span></div>
      <div class="row between"><span class="saved" id="saved">${r.upraveno ? 'Uloženo ' + esc(fmtDateTime(r.upraveno)) + (r.kdo ? ' · ' + esc(r.kdo) : '') : ''}</span>${stavLib.isEmpty(r) ? '' : '<button type="button" class="btn btn-sm btn-ghost" id="crm-clear">Smazat záznam</button>'}</div>`;
  }
  function bindCrmForm(root, id, m, en) {
    root.querySelectorAll('[data-stav]').forEach((i) => i.addEventListener('change', () => {
      updateRecord(id, (prev) => stavLib.toggleStav(prev, i.dataset.stav, i.checked));
      const lab = i.closest('.state-check');
      lab.classList.toggle('on', i.checked);
      lab.querySelector('.date').textContent = i.checked ? fmtDate(new Date().toISOString()) : '';
      markSaved(root);
    }));
    root.querySelectorAll('[data-pole]').forEach((i) => {
      const handler = debounce(() => {
        updateRecord(id, (prev) => stavLib.setPole(prev, i.dataset.pole, i.value));
        markSaved(root);
      }, 400);
      i.addEventListener('input', handler);
      i.addEventListener('change', handler);
    });
    const clear = $('#crm-clear', root);
    if (clear) clear.addEventListener('click', () => {
      if (!confirm('Smazat stav oslovení, poznámku i ruční kontakty u tohoto místa?')) return;
      updateRecord(id, () => stavLib.emptyRecord());
      renderDetail();
    });
    const take = $('#take-enrich', root);
    if (take && m && en) take.addEventListener('click', () => {
      updateRecord(id, (prev) => {
        let next = stavLib.normalizeRecord(prev);
        const now = new Date().toISOString();
        if (!next.provozovatel && !m.operator && en.ares && en.ares.nazev) next = stavLib.setPole(next, 'provozovatel', en.ares.nazev, now);
        else if (!next.provozovatel && !m.operator && en.provozovatel) next = stavLib.setPole(next, 'provozovatel', en.provozovatel, now);
        if (!next.telefon && !m.telefon.length && en.telefony && en.telefony.length) next = stavLib.setPole(next, 'telefon', en.telefony.slice(0, 2).join(', '), now);
        if (!next.email && !m.email.length && en.emaily && en.emaily.length) next = stavLib.setPole(next, 'email', en.emaily.slice(0, 2).join(', '), now);
        if (!next.pujcovna && !m.pujcovna && en.pujcovna && (en.pujcovna.kola || en.pujcovna.lyze)) next = stavLib.setPole(next, 'pujcovna', 'ano', now);
        return next;
      });
      renderDetail();
      toast('Údaje z webu převzaty.');
    });
  }
  function markSaved(root) {
    const el = $('#saved', root);
    if (el) el.textContent = 'Uloženo ' + fmtDateTime(new Date().toISOString()) + (state.server.user ? ' · ' + state.server.user : '');
  }

  function renderTrasaDetail(root, t) {
    if (!t) return;
    const near = (mistaByTrasa.get(t.id) || []).filter(([m]) => passesFilters(m, true));
    const osmUrl = 'https://www.openstreetmap.org/' + t.osm;
    root.innerHTML = `
      <div class="detail-head"><h2>${esc(t.label)}</h2>${backBtn()}</div>
      <div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:10px"><span class="badge" style="background:${DRUH[t.druh].hex}22;color:${DRUH[t.druh].hex}">${esc(DRUH[t.druh].label.split(' (')[0])}</span>${t.sit ? `<span class="badge">${esc(SIT_LABEL[t.sit] || t.sit)}</span>` : ''}</div>
      <dl class="kv">
        ${t.ref ? `<dt>Číslo</dt><dd>${esc(t.ref)}</dd>` : ''}
        <dt>Délka</dt><dd>${t.delkaKm ? t.delkaKm + ' km' : '—'}</dd>
        ${t.popis ? `<dt>Popis</dt><dd>${esc(t.popis)}</dd>` : ''}
        ${t.operator ? `<dt>Správce</dt><dd>${esc(t.operator)}</dd>` : ''}
        ${t.web ? `<dt>Web</dt><dd>${linkify(t.web)}</dd>` : ''}
        <dt>Okresy</dt><dd class="small">${t.okresy.map(okresName).filter(Boolean).join(', ') || '—'}</dd>
        <dt>Zdroj</dt><dd class="small"><a href="${esc(osmUrl)}" target="_blank" rel="noopener">OpenStreetMap ${esc(t.osm)}</a>${t.useku ? ` (${t.useku} úseků)` : ''}</dd>
      </dl>
      <div class="section"><h3>Místa do 3 km od trasy (${fmtN(near.length)})</h3>
        ${near.length ? near.slice(0, 200).map(([m, d]) => `<div class="list-item" data-type="misto" data-id="${m.id}"><span class="dot" style="background:${SKUPINA[m.skupina].hex}"></span><span class="name">${esc(m.nazev)}</span><span class="dist">${fmtKm(d)}</span><span class="sub">${esc([m.typLabel, m.obec].filter(Boolean).join(' · '))}</span><span class="badges">${pujcovnaBadge(m)}${stavBadges(m.id)}</span></div>`).join('') : '<div class="muted small">Žádná místa podle aktuálních filtrů.</div>'}
        ${near.length > 200 ? `<div class="muted small" style="padding:8px 0">… a dalších ${fmtN(near.length - 200)}; zúžte filtry nebo oblast.</div>` : ''}
      </div>`;
    bindBack(root);
    root.querySelectorAll('.list-item').forEach((el) => el.addEventListener('click', () => select(el.dataset.type, el.dataset.id)));
  }

  function renderSkiDetail(root, a) {
    if (!a) return;
    const r = recordOf(a.id) || stavLib.emptyRecord();
    const near = (mistaByAreal.get(a.id) || []).filter(([m]) => passesFilters(m, true));
    const pistes = sjezdovkyByAreal.get(a.id) || [];
    const lifts = vlekyByAreal.get(a.id) || [];
    const obt = Object.entries(a.sjezdovky.obtiznost || {}).filter(([, n]) => n).map(([k, n]) => `${k}: ${n}`).join(', ');
    const ef = { provozovatel: r.provozovatel || a.operator || '', telefon: r.telefon || a.telefon || '', email: r.email || a.email || '', web: r.web || a.web[0] || '' };
    root.innerHTML = `
      <div class="detail-head"><h2>⛷ ${esc(a.nazev)}</h2>${backBtn()}</div>
      <div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:10px"><span class="badge" style="background:${SKI_HEX}22;color:${SKI_HEX}">Skiareál</span>${a.stav && a.stav !== 'unknown' ? `<span class="badge">${esc(a.stav === 'operating' ? 'v provozu' : a.stav)}</span>` : ''}${stavBadges(a.id)}</div>
      <dl class="kv">
        <dt>Sjezdovky</dt><dd>${a.sjezdovky.pocet ? `${a.sjezdovky.pocet} (${a.sjezdovky.km} km)${obt ? '<br><span class="small muted">' + esc(obt) + '</span>' : ''}` : '—'}</dd>
        <dt>Vleky / lanovky</dt><dd>${a.vleky.pocet || '—'}${a.vleky.typy && Object.keys(a.vleky.typy).length ? ' <span class="small muted">(' + esc(Object.entries(a.vleky.typy).map(([k, n]) => `${k} ${n}`).join(', ')) + ')</span>' : ''}</dd>
        ${a.vyska ? `<dt>Nadm. výška</dt><dd>${a.vyska[0]}–${a.vyska[1]} m</dd>` : ''}
        <dt>Okres / kraj</dt><dd>${esc(okresName(a.okres))} · ${esc(krajName(a.kraj))}</dd>
        <dt>Provozovatel</dt><dd>${esc(ef.provozovatel || '—')}</dd>
        <dt>Telefon</dt><dd>${ef.telefon ? telLinks([ef.telefon]) : '—'}</dd>
        <dt>E-mail</dt><dd>${ef.email ? mailLinks([ef.email]) : '—'}</dd>
        <dt>Web</dt><dd>${a.web.map(linkify).join('<br>') || '—'}</dd>
        <dt>Zdroj</dt><dd class="small">${a.osm ? `<a href="https://www.openstreetmap.org/${esc(a.osm)}" target="_blank" rel="noopener">OpenStreetMap</a> · ` : ''}${a.zdroj === 'openskimap' ? '<a href="https://openskimap.org/" target="_blank" rel="noopener">OpenSkiMap</a>' : 'OSM sjezdovky'}</dd>
      </dl>
      ${pistes.length ? `<div class="section"><h3>Sjezdovky (${pistes.length})</h3><div class="small">${pistes.map((p) => `${esc(p.nazev || 'bez názvu')}${p.obtiznost ? ' <span class="muted">(' + esc(p.obtiznost) + ')</span>' : ''} ${p.delkaKm} km`).join(' · ')}</div>${lifts.length ? `<div class="small muted" style="margin-top:4px">Vleky: ${lifts.map((l) => esc(l.nazev || l.typ)).join(', ')}</div>` : ''}</div>` : ''}
      <div class="section"><h3>Místa do ${state.filters.okoliSkiKm} km (${fmtN(near.filter(([, d]) => d <= state.filters.okoliSkiKm * 1000).length)})</h3>
        ${near.length ? near.filter(([, d]) => d <= state.filters.okoliSkiKm * 1000).slice(0, 200).map(([m, d]) => `<div class="list-item" data-type="misto" data-id="${m.id}"><span class="dot" style="background:${SKUPINA[m.skupina].hex}"></span><span class="name">${esc(m.nazev)}</span><span class="dist">${fmtKm(d)}</span><span class="sub">${esc([m.typLabel, m.obec].filter(Boolean).join(' · '))}</span><span class="badges">${pujcovnaBadge(m)}${stavBadges(m.id)}</span></div>`).join('') : '<div class="muted small">Žádná místa podle aktuálních filtrů.</div>'}
        <div class="muted small" style="padding:6px 0">Okruh nastavíte posuvníkem „u skiareálů“ ve filtrech.</div>
      </div>
      <div class="section"><h3>Hledat na webu</h3>${searchLinks(a.nazev, okresName(a.okres))}</div>
      <div class="section"><h3>Kontakt a stav oslovení (provozovatel areálu)</h3>${crmFormHtml(a.id, r, ef)}</div>`;
    bindBack(root);
    root.querySelectorAll('.list-item').forEach((el) => el.addEventListener('click', () => select(el.dataset.type, el.dataset.id)));
    bindCrmForm(root, a.id, null, null);
  }

  // ------------------------------------------------------------------ tabulka
  const COLUMNS = [
    { key: 'nazev', label: 'Název', get: (m) => m.nazev },
    { key: 'typ', label: 'Typ', get: (m) => m.typLabel },
    { key: 'obec', label: 'Obec', get: (m) => m.obec || '' },
    { key: 'adresa', label: 'Adresa', get: (m) => m.adresa || '' },
    { key: 'okres', label: 'Okres', get: (m) => okresName(m.okres) },
    { key: 'kraj', label: 'Kraj', get: (m) => krajName(m.kraj) },
    { key: 'pujcovna', label: 'Půjčovna', get: (m) => ({ ano: 'ano', 'ano?': 'podle webu', ne: 'ne', '': '' })[efektivniPujcovna(m)] || '' },
    { key: 'provozovatel', label: 'Provozovatel', get: (m) => ef(m).provozovatel },
    { key: 'telefon', label: 'Telefon', get: (m) => ef(m).telefon },
    { key: 'email', label: 'E-mail', get: (m) => ef(m).email },
    { key: 'web', label: 'Web', get: (m) => ef(m).web },
    { key: 'trasa', label: 'Nejbližší cyklotrasa', get: (m) => (m.blizko.trasy[0] ? (trasaById.get(m.blizko.trasy[0][0]) || {}).label || '' : ''), sortGet: (m) => (m.blizko.trasy[0] ? m.blizko.trasy[0][1] : Infinity) },
    { key: 'trasaKm', label: 'km od trasy', get: (m) => (m.blizko.trasy[0] ? (m.blizko.trasy[0][1] / 1000).toFixed(1).replace('.', ',') : ''), sortGet: (m) => (m.blizko.trasy[0] ? m.blizko.trasy[0][1] : Infinity) },
    { key: 'ski', label: 'Nejbližší skiareál', get: (m) => (m.blizko.ski[0] ? (arealById.get(m.blizko.ski[0][0]) || {}).nazev || '' : ''), sortGet: (m) => (m.blizko.ski[0] ? m.blizko.ski[0][1] : Infinity) },
    { key: 'skiKm', label: 'km od skiareálu', get: (m) => (m.blizko.ski[0] ? (m.blizko.ski[0][1] / 1000).toFixed(1).replace('.', ',') : ''), sortGet: (m) => (m.blizko.ski[0] ? m.blizko.ski[0][1] : Infinity) },
    ...stavLib.STAVY.map((s) => ({ key: s.key, label: s.label, stav: true, get: (m) => (state.stav[m.id] && state.stav[m.id][s.key] ? 'ano' + (state.stav[m.id].datumy[s.key] ? ' (' + fmtDate(state.stav[m.id].datumy[s.key]) + ')' : '') : ''), sortGet: (m) => (state.stav[m.id] && state.stav[m.id][s.key] ? 0 : 1) })),
    { key: 'poznamka', label: 'Poznámka', get: (m) => (state.stav[m.id] ? state.stav[m.id].poznamka : ''), wrap: true },
    { key: 'kdo', label: 'Upravil', get: (m) => (state.stav[m.id] ? state.stav[m.id].kdo || '' : '') },
    { key: 'upraveno', label: 'Upraveno', get: (m) => (state.stav[m.id] && state.stav[m.id].upraveno ? fmtDateTime(state.stav[m.id].upraveno) : ''), sortGet: (m) => (state.stav[m.id] && state.stav[m.id].upraveno ? Date.parse(state.stav[m.id].upraveno) : 0) },
    { key: 'osm', label: 'OSM', get: (m) => 'https://www.openstreetmap.org/' + m.osm },
    { key: 'lat', label: 'Zem. šířka', get: (m) => String(m.lat) },
    { key: 'lon', label: 'Zem. délka', get: (m) => String(m.lon) },
  ];
  function ef(m) {
    return stavLib.efektivni(m, state.stav[m.id], enrich[m.id]);
  }
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
    const limit = Math.min(rows.length, state.tableLimit || 500);
    const head = COLUMNS.map((c) => `<th data-col="${c.key}" class="${state.tableSort.key === c.key ? 'sorted' : ''}">${esc(c.label)}${state.tableSort.key === c.key ? (state.tableSort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
    const body = rows.slice(0, limit).map((m) => `<tr data-id="${m.id}">${COLUMNS.map((c) => {
      if (c.stav) {
        const r = state.stav[m.id];
        return `<td><input type="checkbox" data-stav="${c.key}" data-id="${m.id}" ${r && r[c.key] ? 'checked' : ''} aria-label="${esc(c.label)}"></td>`;
      }
      const v = c.get(m);
      if (c.key === 'nazev') return `<td><button type="button" class="name-btn" data-open="${m.id}">${esc(v)}</button></td>`;
      if (c.key === 'web' || c.key === 'osm') return `<td>${v ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(trunc(v.replace(/^https?:\/\/(www\.)?/, ''), 40))}</a>` : ''}</td>`;
      return `<td class="${c.wrap ? 'wrap' : ''}">${esc(c.wrap ? trunc(v, 160) : v)}</td>`;
    }).join('')}</tr>`).join('');
    wrap.innerHTML = `<div class="toolbar"><b>${fmtN(rows.length)} míst</b><span class="muted small">zobrazeno ${fmtN(limit)} · klik na záhlaví řadí · zaškrtávátka se rovnou ukládají</span>${rows.length > limit ? `<button type="button" class="btn btn-sm" id="table-more">Zobrazit dalších 500</button>` : ''}<span style="flex:1"></span><button type="button" class="btn btn-sm" id="table-export">Export CSV (${fmtN(rows.length)})</button></div>
      <table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    wrap.querySelectorAll('th').forEach((th) => th.addEventListener('click', () => {
      const k = th.dataset.col;
      if (state.tableSort.key === k) state.tableSort.dir *= -1;
      else state.tableSort = { key: k, dir: 1 };
      renderTable();
    }));
    wrap.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
      state.view = 'map';
      select('misto', b.dataset.open);
    }));
    wrap.querySelectorAll('input[data-stav]').forEach((i) => i.addEventListener('change', () => {
      updateRecord(i.dataset.id, (prev) => stavLib.toggleStav(prev, i.dataset.stav, i.checked));
    }));
    const more = $('#table-more');
    if (more) more.addEventListener('click', () => {
      state.tableLimit = (state.tableLimit || 500) + 500;
      renderTable();
    });
    $('#table-export').addEventListener('click', exportCsv);
  }

  function exportCsv() {
    const rows = state.view === 'table' ? sortedTable() : sortMista(visible().mista.slice());
    const data = [COLUMNS.map((c) => c.label)];
    for (const m of rows) data.push(COLUMNS.map((c) => c.get(m)));
    const scope = state.scope.okres != null ? okresName(state.scope.okres) : state.scope.kraj != null ? krajName(state.scope.kraj) : 'CR';
    download(`mista-${norm(scope).replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.csv`, csvLib.serialize(data), 'text/csv;charset=utf-8');
    toast(`Exportováno ${fmtN(rows.length)} míst.`);
  }

  // ------------------------------------------------------------------ stav oslovení: záloha / načtení
  function openStavModal() {
    const sum = stavLib.summary(state.stav);
    const body = `
      <p>Stav oslovení (${fmtN(sum.celkem)} míst se záznamem) je uložený v tomto prohlížeči${state.server.on ? ' a sdílený přes server' : ''}.
      Zálohu nebo přenos do jiného počítače uděláte souborem JSON. Při načtení se záznamy sloučí – u každého místa vyhraje novější úprava.</p>
      <div class="row" style="flex-wrap:wrap;gap:8px;margin:12px 0">
        <button type="button" class="btn btn-primary" id="stav-export">Uložit zálohu (JSON)</button>
        <label class="btn">Načíst soubor… <input type="file" id="stav-import" accept="application/json,.json" hidden></label>
        <button type="button" class="btn" id="stav-csv">Export všech záznamů (CSV)</button>
      </div>
      <div class="callout warn small">Smazání dat prohlížeče (cookies, úložiště) stav vymaže – zálohujte si ho. Pro sdílení v týmu spusťte <code>npm start</code> (server.js) a otevřete aplikaci přes něj.</div>`;
    const m = openModal('Stav oslovení – záloha a sdílení', body);
    $('#stav-export', m).addEventListener('click', () => {
      download(`stav-osloveni-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(stavLib.exportJson(state.stav), null, 1), 'application/json');
      toast('Záloha uložena.');
    });
    $('#stav-import', m).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const im = stavLib.importJson(parsed);
        if (im.chyba) throw new Error(im.chyba);
        const before = Object.keys(state.stav).length;
        state.stav = stavLib.merge(state.stav, im.stav);
        saveLocal();
        if (state.server.on) for (const [id, r] of Object.entries(im.stav)) pushRecord(id, r);
        markerCache.clear();
        renderAll();
        toast(`Načteno ${fmtN(im.pocet)} záznamů (celkem ${fmtN(Object.keys(state.stav).length)}, předtím ${fmtN(before)}).`);
        m.close();
      } catch (err) {
        toast('Import se nezdařil: ' + err.message);
      }
    });
    $('#stav-csv', m).addEventListener('click', () => {
      const ids = Object.keys(state.stav);
      const data = [COLUMNS.map((c) => c.label)];
      for (const id of ids) {
        const mm = mistoById.get(id);
        if (mm) data.push(COLUMNS.map((c) => c.get(mm)));
        else if (arealById.has(id)) {
          const a = arealById.get(id);
          const r = state.stav[id];
          data.push(COLUMNS.map((c) => (c.key === 'nazev' ? '⛷ ' + a.nazev : c.key === 'typ' ? 'Skiareál' : c.key === 'okres' ? okresName(a.okres) : c.key === 'kraj' ? krajName(a.kraj) : c.stav ? (r[c.key] ? 'ano' : '') : c.key === 'poznamka' ? r.poznamka : c.key === 'kdo' ? r.kdo || '' : c.key === 'upraveno' ? (r.upraveno ? fmtDateTime(r.upraveno) : '') : c.key === 'provozovatel' ? r.provozovatel || a.operator || '' : c.key === 'telefon' ? r.telefon || a.telefon || '' : c.key === 'email' ? r.email || a.email || '' : c.key === 'web' ? r.web || a.web[0] || '' : c.key === 'lat' ? String(a.lat) : c.key === 'lon' ? String(a.lon) : '')));
        }
      }
      download(`stav-osloveni-${new Date().toISOString().slice(0, 10)}.csv`, csvLib.serialize(data), 'text/csv;charset=utf-8');
    });
  }

  // ================================================================== pomocné UI
  function openModal(title, bodyHtml) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2><button type="button" class="btn btn-icon btn-ghost" id="modal-close" aria-label="Zavřít">✕</button></header><div class="content">${bodyHtml}</div></div></div>`;
    const el = root.firstElementChild;
    const close = () => (root.innerHTML = '');
    $('#modal-close', el).addEventListener('click', close);
    el.addEventListener('click', (e) => {
      if (e.target === el) close();
    });
    const onKey = (e) => {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
    return { el, close };
  }
  let toastTimer;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
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

  // ================================================================== motiv
  function applyTheme(theme) {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
    try {
      if (theme) localStorage.setItem('csm.theme', theme);
      else localStorage.removeItem('csm.theme');
    } catch (_e) { /* soukromý režim */ }
  }
  function currentTheme() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // ================================================================== start
  function init() {
    try {
      applyTheme(localStorage.getItem('csm.theme') || null);
    } catch (_e) { /* ignorovat */ }
    state.stav = loadLocal();
    readHash();
    initMap();
    $('#boot').remove();
    if (state.scope.kraj != null || state.selected) {
      const sel = state.selected;
      state.selected = null;
      setScope(state.scope.kraj, state.scope.okres, false);
      if (sel) select(sel.type, sel.id);
    } else renderAll();

    $('#search').addEventListener('input', debounce((e) => {
      state.filters.q = norm(e.target.value.trim());
      state.listLimit = 150;
      if (state.selected) state.selected = null;
      renderAll();
    }, 250));
    $('#btn-view').addEventListener('click', () => {
      state.view = state.view === 'table' ? 'map' : 'table';
      renderAll();
      writeHash();
      if (state.view === 'map') setTimeout(() => map.invalidateSize(), 50);
    });
    $('#btn-export').addEventListener('click', exportCsv);
    $('#btn-stav').addEventListener('click', openStavModal);
    $('#btn-theme').addEventListener('click', () => {
      applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.selected && !$('#modal-root').firstElementChild) clearSelection();
      if (e.key === '/' && document.activeElement && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault();
        $('#search').focus();
      }
    });
    window.addEventListener('hashchange', () => {
      const before = JSON.stringify([state.scope, state.selected]);
      state.scope = { kraj: null, okres: null };
      state.selected = null;
      readHash();
      if (JSON.stringify([state.scope, state.selected]) !== before) {
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
