// Kolomapa – webové rozhraní (vanilla JS, bez sestavování). Funguje nad serverem (server.js) i jako statická
// stránka (tools/export-static.js) – proto jen RELATIVNÍ adresy (data/summary.json …), nikdy „/data/…“.
//
// Členění: konstanty → pomocníci (DOM, formátování) → stav → načítání dat → mapa (kraje, piny) → panel (přehled,
// kraj, filtry, seznam) → detail → běh stahování (jen server) → navigace (#/KRAJ/ID) → start.
//
// BEZPEČNOST: data inzerátů jsou nedůvěryhodná – nikdy innerHTML; DOM se staví přes textContent / setAttribute
// a odkazy i obrázky jen s http(s) adresou (safeUrl).
'use strict';

(function () {
  // =========================================================================================== konstanty

  const KRAJE = {
    PHA: ['Hlavní město Praha', 'Praha'],
    STC: ['Středočeský kraj', 'Středočeský'],
    JHC: ['Jihočeský kraj', 'Jihočeský'],
    PLK: ['Plzeňský kraj', 'Plzeňský'],
    KVK: ['Karlovarský kraj', 'Karlovarský'],
    ULK: ['Ústecký kraj', 'Ústecký'],
    LBK: ['Liberecký kraj', 'Liberecký'],
    HKK: ['Královéhradecký kraj', 'Královéhradecký'],
    PAK: ['Pardubický kraj', 'Pardubický'],
    VYS: ['Kraj Vysočina', 'Vysočina'],
    JHM: ['Jihomoravský kraj', 'Jihomoravský'],
    OLK: ['Olomoucký kraj', 'Olomoucký'],
    ZLK: ['Zlínský kraj', 'Zlínský'],
    MSK: ['Moravskoslezský kraj', 'Moravskoslezský'],
  };
  // Ručně zvolené body pro popisky (vizuální střed kraje; Středočeský mimo Prahu).
  const LABEL_AT = {
    PHA: [50.06, 14.47],
    STC: [49.74, 14.72],
    JHC: [49.08, 14.43],
    PLK: [49.6, 13.22],
    KVK: [50.2, 12.8],
    ULK: [50.47, 13.92],
    LBK: [50.74, 15.03],
    HKK: [50.4, 15.88],
    PAK: [49.86, 16.12],
    VYS: [49.4, 15.62],
    JHM: [49.04, 16.62],
    OLK: [49.82, 17.13],
    ZLK: [49.17, 17.78],
    MSK: [49.8, 18.12],
  };
  const SOURCE_LABELS = { bazos: 'Bazoš', sbazar: 'Sbazar', aukro: 'Aukro', cyklobazar: 'Cyklobazar' };
  const BIKE_TYPES = {
    mtb_hardtail: 'horské – hardtail',
    mtb_full: 'horské – celoodpružené',
    road: 'silniční',
    gravel: 'gravel',
    cyclocross: 'cyklokros',
    trekking: 'trekové',
    cross: 'krosové',
    city: 'městské',
    kids: 'dětské',
    balance: 'odrážedlo',
    bmx: 'BMX',
    dirt: 'dirt',
    fatbike: 'fatbike',
    folding: 'skládací',
    cargo: 'nákladní',
    tandem: 'tandem',
    ebike_mtb: 'elektro horské – hardtail',
    ebike_mtb_full: 'elektro horské – celoodpružené',
    ebike_trekking: 'elektro trekové',
    ebike_city: 'elektro městské',
    ebike_road: 'elektro silniční',
    ebike_cargo: 'elektro nákladní',
    ebike_kids: 'elektro dětské',
    other: 'jiné',
  };
  const TYPE_GROUPS = [
    { key: 'mtb', label: 'Horská', types: ['mtb_hardtail', 'mtb_full', 'dirt', 'fatbike'] },
    { key: 'road', label: 'Silniční a gravel', types: ['road', 'gravel', 'cyclocross'] },
    { key: 'ebike', label: 'Elektrokola', types: [] },
    { key: 'kids', label: 'Dětská', types: ['kids', 'balance'] },
    { key: 'trek', label: 'Trek, město, kros', types: ['trekking', 'cross', 'city', 'folding'] },
    { key: 'other', label: 'Ostatní', types: [] },
  ];
  const CONDITION = { new: 'nové', like_new: 'jako nové', very_good: 'velmi dobrý', good: 'dobrý', fair: 'opotřebené', poor: 'špatný', parts: 'na díly' };
  const MATERIAL = { carbon: 'karbon', alu: 'hliník', steel: 'ocel', titanium: 'titan' };
  const METHOD = { ai: 'AI podle fotky', model: 'model', rules: 'pravidla', comps: 'srovnatelné inzeráty' };
  const PRECISION = {
    exact: 'přesně podle inzerátu',
    city: 'střed obce',
    psc: 'přibližně – podle PSČ',
    okres: 'přibližně – podle okresu',
    kraj: 'jen kraj – poloha velmi přibližná',
  };
  const SORTS = [
    ['deal', 'Nejvýhodnější'],
    ['new', 'Nejnovější'],
    ['cheap', 'Nejlevnější'],
    ['expensive', 'Nejdražší'],
    ['discount', 'Největší sleva vs. odhad'],
  ];
  const PAGE = 60;
  const POLL_MS = 3000;
  const DEFAULT_THRESHOLDS = { deal: 0.85, high: 1.15, minConfidence: 0.45, newHours: 36 };
  const CR_BOUNDS = [
    [48.55, 12.09],
    [51.06, 18.86],
  ];

  // =========================================================================================== pomocníci

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    bolt: ['M13.5 2 4.5 13.5h6.2L9.8 22l9.2-12h-6.3z', true],
    down: ['M12 5v14M6 13l6 6 6-6'],
    up: ['M12 19V5M6 11l6-6 6 6'],
    dash: ['M6 12h12'],
    back: ['M15 18l-6-6 6-6'],
    close: ['M6 6l12 12M18 6 6 18'],
    external: ['M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
    download: ['M12 4v11M8 11l4 4 4-4M5 20h14'],
    filter: ['M4 6h16M7 12h10M10 18h4'],
    warn: ['M12 3.5 2.5 20h19L12 3.5zM12 10v4.5M12 17.3v.2'],
    search: ['M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.8-4.8'],
    bike: ['M5.5 17.5a3.5 3.5 0 1 0 0-.01zM18.5 17.5a3.5 3.5 0 1 0 0-.01zM5.5 17.5 9 10h7l2.5 7.5M9 10l3.2 7.5H5.5M14.5 6.5H17l-1 3.5'],
    map: ['M9 4 3 6.5v13.5L9 17.5l6 2.5 6-2.5V4l-6 2.5L9 4zM9 4v13.5M15 6.5V20'],
  };

  /** SVG ikona (důvěryhodné konstanty z ICONS). */
  function icon(name, cls) {
    const [d, filled] = ICONS[name];
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    s.setAttribute('class', 'ic' + (filled ? ' ic--fill' : '') + (cls ? ' ' + cls : ''));
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    s.append(p);
    return s;
  }

  /** Jen absolutní http(s) adresa, jinak null. */
  function safeUrl(u) {
    if (typeof u !== 'string') return null;
    const s = u.trim();
    if (!/^https?:\/\//i.test(s)) return null;
    try {
      const url = new URL(s);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  }

  /**
   * Vytvoří element. props: class, text, dataset, on<událost>, ostatní → setAttribute (href/src jen přes safeUrl,
   * kromě interních „#…“). Děti: Node | string | number | null.
   */
  function el(tag, props, ...children) {
    const e = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = String(v);
        else if (k === 'dataset') Object.assign(e.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (k === 'href' || k === 'src') {
          const s = String(v);
          const u = s.startsWith('#') ? s : safeUrl(s);
          if (u) e.setAttribute(k, u);
        } else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      e.append(c instanceof Node ? c : String(c));
    }
    return e;
  }

  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat('cs-CZ');
  const fmtNum = (v) => nf.format(Math.round(Number(v) || 0));
  const fmtCzk = (v) => (v == null || !Number.isFinite(Number(v)) ? '–' : `${fmtNum(v)} Kč`);
  const dateFmt = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });
  const dateTimeFmt = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const timeFmt = new Intl.DateTimeFormat('cs-CZ', { hour: 'numeric', minute: '2-digit' });
  const fmtDate = (iso) => (iso && Number.isFinite(Date.parse(iso)) ? dateFmt.format(new Date(iso)) : '–');

  /** „dnes 5:47“, „včera 5:47“, jinak datum s časem. */
  function fmtWhen(iso) {
    if (!iso) return '–';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '–';
    const now = new Date();
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (same(d, now)) return `dnes ${timeFmt.format(d)}`;
    if (same(d, y)) return `včera ${timeFmt.format(d)}`;
    return dateTimeFmt.format(d);
  }

  /** Relativní stáří („před 3 dny“). */
  function ago(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    const h = (Date.now() - t) / 3600000;
    if (h < 1) return 'před chvílí';
    if (h < 24) return `před ${Math.floor(h)} h`;
    const d = Math.floor(h / 24);
    if (d === 1) return 'včera';
    if (d < 7) return `před ${d} dny`;
    if (d < 14) return 'před týdnem';
    if (d < 31) return `před ${Math.floor(d / 7)} týdny`;
    const m = Math.floor(d / 30.4);
    if (m <= 1) return 'před měsícem';
    if (m < 12) return `před ${m} měsíci`;
    return 'před víc než rokem';
  }

  /** Malá písmena bez diakritiky (pro hledání). */
  const fold = (s) =>
    String(s ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();

  /** České tvary: plural(n, 'kolo', 'kola', 'kol'). */
  const plural = (n, one, few, many) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many);

  const storage = {
    get(k, fallback) {
      try {
        const v = localStorage.getItem('kolomapa.' + k);
        return v == null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem('kolomapa.' + k, JSON.stringify(v));
      } catch {
        /* soukromé okno / zakázané úložiště */
      }
    },
  };

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 4500);
  }

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const isMobile = () => window.matchMedia('(max-width: 899px)').matches;

  // =========================================================================================== stav

  const state = {
    summary: null,
    mode: 'static',
    thresholds: DEFAULT_THRESHOLDS,
    geo: null,
    kraj: null, // kód zobrazeného kraje, null = celá ČR
    krajCache: new Map(), // kód → Promise<data kraje>
    listings: [],
    byId: new Map(),
    filtered: [],
    shown: 0,
    filters: { q: '', sourcesOff: new Set(), groups: new Set(), min: '', max: '', deals: false, fresh: false },
    filtersOpen: storage.get('filtersOpen', false),
    sort: storage.get('sort', 'deal'),
    tab: storage.get('tab', 'deals'),
    selectedId: null,
    detailCtrl: null,
    navSeq: 0,
    run: { timer: null, wasRunning: false },
    breaks: [],
  };

  // =========================================================================================== klasifikace nabídky

  /** good | fair | high | unsure | none */
  function dealClass(l) {
    const t = state.thresholds;
    if (l.d == null || !(l.p > 0)) return 'none';
    if ((l.ec ?? 0) < t.minConfidence) return 'unsure';
    if (l.d <= t.deal) return 'good';
    if (l.d > t.high) return 'high';
    return 'fair';
  }

  const isNew = (l) => !!(l.f && state.summary && l.f >= state.summary.newSince);
  const isEbike = (l) => !!(l.eb || (l.bt && l.bt.startsWith('ebike')));

  function typeGroup(l) {
    if (isEbike(l)) return 'ebike';
    for (const g of TYPE_GROUPS) if (g.types.includes(l.bt)) return g.key;
    return 'other';
  }

  /** Odznak „−24 % pod odhadem“ (barva + šipka + text – nikdy jen barva). */
  function dealBadge(l) {
    const c = dealClass(l);
    if (c === 'none') return null;
    const pct = Math.round(Math.abs(1 - l.d) * 100);
    if (c === 'unsure') return el('span', { class: 'badge', title: 'Odhad tržní ceny má nízkou jistotu' }, 'nejistý odhad');
    if (c === 'good') return el('span', { class: 'badge badge--good' }, icon('down'), `${pct} % pod odhadem`);
    if (c === 'high') return el('span', { class: 'badge badge--high' }, icon('up'), `${pct} % nad odhadem`);
    return el('span', { class: 'badge badge--fair', title: `${l.d < 1 ? '−' : '+'}${pct} % proti odhadu` }, icon('dash'), 'běžná cena');
  }

  const sourceLabel = (s) => state.summary?.sources?.[s]?.label || SOURCE_LABELS[s] || s || '';
  const krajName = (k) => (KRAJE[k] ? KRAJE[k][0] : k || '');

  // =========================================================================================== načítání dat

  async function fetchJson(url, opts = {}) {
    const r = await fetch(url, { cache: 'no-cache', ...opts });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try {
        const j = await r.json();
        if (j && j.error) msg = j.error;
      } catch {
        /* není JSON */
      }
      const e = new Error(msg);
      e.status = r.status;
      throw e;
    }
    return r.json();
  }

  function loadKraj(code) {
    if (!state.krajCache.has(code)) {
      const p = fetchJson(`data/kraj/${code}.json`).catch((e) => {
        state.krajCache.delete(code);
        throw e;
      });
      state.krajCache.set(code, p);
    }
    return state.krajCache.get(code);
  }

  async function loadSummary() {
    const s = await fetchJson('data/summary.json');
    state.summary = s;
    state.mode = s.mode === 'server' ? 'server' : 'static';
    state.thresholds = { ...DEFAULT_THRESHOLDS, ...(s.thresholds || {}) };
    return s;
  }

  // =========================================================================================== mapa

  let map = null;
  let krajLayer = null;
  let labelLayer = null;
  let cluster = null;
  const markers = new Map(); // id → L.Marker
  const krajLayers = new Map(); // kód → vrstva polygonu
  let hoverKraj = null;
  let pinsReady = Promise.resolve(); // dokončení (postupného) přidávání pinů do shluků
  let pinsReadyResolve = null;

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  /**
   * Počká, až mapa doanimuje (Leaflet během animace zoomu další požadavky na zoom tiše zahodí). Animace začíná až
   * v dalším snímku (requestAnimationFrame), proto nejdřív jeden snímek počkat.
   */
  async function whenMapIdle() {
    await nextFrame();
    return new Promise((resolve) => {
      if (!map._animatingZoom && !(map._panAnim && map._panAnim._inProgress)) return resolve();
      const done = () => {
        clearTimeout(t);
        map.off('moveend', done);
        resolve();
      };
      const t = setTimeout(done, 900);
      map.on('moveend', done);
    });
  }

  /** Změna pohledu mapy až po doběhnutí rozběhnuté animace. */
  function fitTo(bounds, padding) {
    whenMapIdle().then(() => map.fitBounds(bounds, { padding }));
  }

  function initMap() {
    map = L.map('map', {
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      minZoom: 6,
      maxZoom: 18,
      maxBounds: [
        [46.8, 9.5],
        [52.8, 21.5],
      ],
      maxBoundsViscosity: 0.8,
      worldCopyJump: false,
    });
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(map);
    map.attributionControl.addAttribution(
      'Geodata &copy; <a href="https://www.geonames.org/" target="_blank" rel="noopener">GeoNames</a>, <a href="https://www.cuzk.cz/" target="_blank" rel="noopener">ČÚZK</a> (CC BY 4.0)'
    );
    map.fitBounds(CR_BOUNDS, { padding: [8, 8] });
    map.createPane('krajePane').style.zIndex = 390;
    map.on('zoomend', updateZoomClass);
    updateZoomClass();

    cluster = L.markerClusterGroup({
      maxClusterRadius: (z) => (z >= 13 ? 34 : 48),
      disableClusteringAtZoom: 16, // na úrovni ulic už jednotlivé piny (a „ukázat pin“ nezoomuje až na 18)
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      chunkedLoading: true,
      chunkProgress(done, total) {
        if (done >= total && pinsReadyResolve) {
          pinsReadyResolve();
          pinsReadyResolve = null;
        }
      },
      iconCreateFunction: clusterIcon,
    });
    map.addLayer(cluster);

    $('btn-cr').prepend(icon('back'));
    $('btn-cr').addEventListener('click', () => navigate(null));
    // změna světlého/tmavého režimu → přebarvit vrstvy počítané v JS
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
      styleKraje();
      renderLegend();
    });
  }

  function updateZoomClass() {
    const c = map.getContainer();
    c.classList.toggle('map--far', map.getZoom() < 7.25 || c.clientWidth < 560);
  }

  /** „Hezká“ čísla pro hranice tříd choropletu. */
  function niceNumber(v) {
    if (v <= 10) return Math.max(1, Math.round(v));
    const p = 10 ** Math.floor(Math.log10(v));
    const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    let best = steps[0];
    for (const s of steps) if (Math.abs(s * p - v) < Math.abs(best * p - v)) best = s;
    return best * p;
  }

  /** Hranice tříd (kvantily nenulových počtů, zaokrouhlené). Vrací rostoucí pole, max. 4 hranice = 5 tříd. */
  function computeBreaks(counts) {
    const vals = counts.filter((c) => c > 0).sort((a, b) => a - b);
    if (vals.length < 2 || vals[0] === vals[vals.length - 1]) return [];
    const out = [];
    for (const q of [0.2, 0.4, 0.6, 0.8]) {
      const b = niceNumber(vals[Math.min(vals.length - 1, Math.floor(q * vals.length))]);
      if (b > vals[0] && b <= vals[vals.length - 1] && !out.includes(b) && (!out.length || b > out[out.length - 1])) out.push(b);
    }
    return out;
  }

  function seqColors(nClasses) {
    const ramp = ['--seq-0', '--seq-1', '--seq-2', '--seq-3', '--seq-4'].map(css);
    if (nClasses <= 1) return [ramp[3]];
    // rovnoměrně vybrat kroky z pětistupňové škály
    return Array.from({ length: nClasses }, (_, i) => ramp[Math.round((i * (ramp.length - 1)) / (nClasses - 1))]);
  }

  function krajColor(count) {
    if (!count) return css('--seq-empty');
    const colors = seqColors(state.breaks.length + 1);
    let i = 0;
    while (i < state.breaks.length && count >= state.breaks[i]) i++;
    return colors[i];
  }

  function krajStyle(feature) {
    const code = feature.properties.code;
    const k = state.summary?.kraje?.[code];
    const line = css('--kraj-line');
    if (state.kraj) {
      if (code === state.kraj) return { pane: 'krajePane', color: css('--kraj-sel'), weight: 2.5, opacity: 0.9, fillColor: css('--accent'), fillOpacity: 0.04 };
      return { pane: 'krajePane', color: line, weight: 1, opacity: 0.9, fillColor: css('--kraj-dim'), fillOpacity: 0.55 };
    }
    return { pane: 'krajePane', color: line, weight: 1.2, opacity: 1, fillColor: krajColor(k ? k.count : 0), fillOpacity: Number(css('--fill-opacity')) || 0.72 };
  }

  function styleKraje() {
    if (!krajLayer) return;
    krajLayer.setStyle(krajStyle);
    if (hoverKraj) highlightKraj(hoverKraj, true);
  }

  function highlightKraj(layer, on) {
    if (on) {
      layer.setStyle({ color: css('--kraj-hl'), weight: state.kraj && layer.feature.properties.code === state.kraj ? 2.5 : 2.2, opacity: 1 });
      layer.bringToFront();
    } else krajLayer.resetStyle(layer);
  }

  function krajTooltip(code) {
    const k = state.summary?.kraje?.[code] || { count: 0, deals: 0 };
    return el(
      'div',
      { class: 'tip' },
      el('b', { text: krajName(code) }),
      el('span', { text: `${fmtNum(k.count)} ${plural(k.count, 'kolo', 'kola', 'kol')} (${fmtNum(k.deals)} ${plural(k.deals, 'výhodné', 'výhodná', 'výhodných')})` })
    );
  }

  function buildKrajLayer() {
    krajLayer = L.geoJSON(state.geo, {
      style: krajStyle,
      onEachFeature(feature, layer) {
        const code = feature.properties.code;
        krajLayers.set(code, layer);
        layer.bindTooltip(() => krajTooltip(code), { sticky: true, direction: 'top', offset: [0, -8], opacity: 1 });
        // nad právě otevřeným krajem tooltip nepotřebujeme (zakrýval by piny)
        layer.on('tooltipopen', () => {
          if (state.kraj === code) layer.closeTooltip();
        });
        layer.on({
          mouseover() {
            hoverKraj = layer;
            highlightKraj(layer, true);
          },
          mouseout() {
            hoverKraj = null;
            highlightKraj(layer, false);
          },
          click() {
            if (state.kraj !== code) navigate(code);
          },
        });
      },
    }).addTo(map);
    labelLayer = L.layerGroup().addTo(map);
    renderLabels();
  }

  function renderLabels() {
    labelLayer.clearLayers();
    for (const code of Object.keys(KRAJE)) {
      const k = state.summary?.kraje?.[code] || { count: 0 };
      const inner = el(
        'div',
        { class: 'kraj-label__inner', title: `${krajName(code)} – zobrazit inzeráty` },
        el('span', { class: 'kraj-label__n', text: fmtNum(k.count) }),
        el('span', { class: 'kraj-label__name', text: KRAJE[code][1] })
      );
      const m = L.marker(LABEL_AT[code], {
        icon: L.divIcon({ className: 'kraj-label', html: inner, iconSize: null }),
        keyboard: false,
        interactive: true,
        zIndexOffset: -1000,
      });
      m.on('click', () => navigate(code));
      m.on('mouseover', () => krajLayers.get(code) && highlightKraj(krajLayers.get(code), true));
      m.on('mouseout', () => krajLayers.get(code) && highlightKraj(krajLayers.get(code), false));
      labelLayer.addLayer(m);
    }
  }

  // ------------------------------------------------------------------------------- piny

  function pinSize(c) {
    return c === 'good' ? 22 : c === 'fair' ? 16 : c === 'high' ? 15 : 12;
  }

  function pinIcon(l) {
    const c = dealClass(l);
    const visual = c === 'unsure' ? 'none' : c;
    const s = pinSize(visual);
    const dot = el('span', { class: 'pin__dot' });
    if (visual === 'good') dot.append(icon('down'));
    else if (visual === 'high') dot.append(icon('up'));
    const wrap = el('span', null, dot, isEbike(l) ? el('span', { class: 'pin__bolt' }, icon('bolt')) : null);
    return L.divIcon({ className: `pin pin--${visual}`, html: wrap, iconSize: [s, s], iconAnchor: [s / 2, s / 2], tooltipAnchor: [0, -s / 2] });
  }

  function pinTooltip(l) {
    const price = l.p > 0 ? fmtCzk(l.p) : l.pn || 'cena neuvedena';
    const badge = dealBadge(l);
    return el('div', { class: 'tip' }, el('b', { text: price }), el('span', { text: l.t }), badge ? el('span', null, badge) : null);
  }

  function getMarker(l) {
    let m = markers.get(l.id);
    if (m) return m;
    m = L.marker([l.la, l.lo], { icon: pinIcon(l), keyboard: true, riseOnHover: true, dealClass: dealClass(l) });
    m.bindTooltip(() => pinTooltip(l), { direction: 'top', opacity: 1 });
    m.on('click', () => navigate(state.kraj || l.k, l.id));
    m.on('add', () => {
      const e = m.getElement();
      if (!e) return;
      e.setAttribute('aria-label', `${l.t} – ${l.p > 0 ? fmtCzk(l.p) : l.pn || 'cena neuvedena'}`);
      e.classList.toggle('is-selected', state.selectedId === l.id);
    });
    m.on('mouseover', () => setCardHighlight(l.id, true));
    m.on('mouseout', () => setCardHighlight(l.id, false));
    markers.set(l.id, m);
    return m;
  }

  function clusterIcon(c) {
    const n = c.getChildCount();
    const deals = c.getAllChildMarkers().reduce((a, m) => a + (m.options.dealClass === 'good' ? 1 : 0), 0);
    const s = n < 10 ? 32 : n < 50 ? 38 : n < 200 ? 44 : 50;
    const inner = el('span', { class: 'cluster__inner' }, fmtNum(n), deals ? el('span', { class: 'cluster__deals', title: `${deals} výhodných`, text: String(deals) }) : null);
    return L.divIcon({ className: 'cluster', html: el('span', null, inner), iconSize: [s, s], iconAnchor: [s / 2, s / 2] });
  }

  function renderPins() {
    cluster.clearLayers();
    pinsReadyResolve?.();
    pinsReadyResolve = null;
    const list = state.kraj ? state.filtered.filter((l) => l.la != null && l.lo != null).map(getMarker) : [];
    if (!list.length) {
      pinsReady = Promise.resolve();
      return;
    }
    pinsReady = new Promise((resolve) => {
      pinsReadyResolve = resolve;
      setTimeout(resolve, 4000); // pojistka
    });
    cluster.addLayers(list);
  }

  /** Zvýrazní pin (nebo shluk, ve kterém je) při najetí na kartu v seznamu. */
  function setPinHighlight(id, on) {
    const m = markers.get(id);
    if (!m || !cluster.hasLayer(m)) return;
    const vis = cluster.getVisibleParent(m);
    const e = vis && vis.getElement ? vis.getElement() : null;
    if (e) e.classList.toggle('is-hl', on);
    if (vis === m) m.setZIndexOffset(on ? 1000 : 0);
  }

  function setSelectedPin(id) {
    for (const e of document.querySelectorAll('.pin.is-selected')) e.classList.remove('is-selected');
    const m = id != null ? markers.get(id) : null;
    if (m && m.getElement()) {
      m.getElement().classList.add('is-selected');
      m.setZIndexOffset(2000);
    }
  }

  /** Posune mapu tak, aby pin nebyl schovaný pod spodním panelem (mobil). */
  function keepVisible(latlng) {
    if (!isMobile()) return;
    const rect = map.getContainer().getBoundingClientRect();
    const sheet = $('detail').getBoundingClientRect();
    const top = Math.max(rect.top, document.querySelector('.topbar').getBoundingClientRect().bottom);
    const bottom = Math.min(rect.bottom, sheet.top || rect.bottom);
    if (bottom - top < 60) return;
    const target = (top + bottom) / 2 - rect.top;
    const pt = map.latLngToContainerPoint(latlng);
    map.panBy([0, pt.y - target], { animate: true });
  }

  async function focusListingOnMap(l) {
    await pinsReady;
    await whenMapIdle();
    if (state.selectedId !== l.id) return;
    const m = markers.get(l.id);
    if (m && cluster.hasLayer(m) && m.__parent) {
      cluster.zoomToShowLayer(m, () => {
        if (state.selectedId !== l.id) return;
        setSelectedPin(l.id);
        keepVisible(m.getLatLng());
      });
    } else if (l.la != null) {
      map.setView([l.la, l.lo], Math.max(map.getZoom(), 12));
      keepVisible(L.latLng(l.la, l.lo));
    }
  }

  // ------------------------------------------------------------------------------- legenda

  function legendPin(cls, arrow, label, bolt) {
    const s = cls === 'none' ? 12 : 14;
    const dot = el('span', { class: 'pin__dot' });
    if (arrow) dot.append(icon(arrow));
    const p = el('span', { class: `legend__pin pin pin--${cls}`, 'aria-hidden': 'true' }, bolt ? el('span', { class: 'pin__bolt' }, icon('bolt')) : dot);
    p.style.width = p.style.height = `${s}px`;
    if (bolt) {
      p.firstChild.style.position = 'static';
    }
    return el('span', { class: 'legend__item' }, p, label);
  }

  function renderLegend() {
    const lg = $('legend');
    lg.replaceChildren();
    if (!state.summary) return;
    if (state.kraj) {
      const t = state.thresholds;
      const short = isMobile();
      const dealPct = Math.round((1 - t.deal) * 100);
      const highPct = Math.round((t.high - 1) * 100);
      if (!short) lg.append(el('div', { class: 'legend__title', text: 'Cena proti odhadu' }));
      lg.append(
        el(
          'div',
          { class: 'legend__items' },
          legendPin('good', 'down', short ? `výhodná ≤ −${dealPct} %` : `výhodná (≤ −${dealPct} %)`),
          legendPin('fair', null, short ? 'běžná' : 'běžná cena'),
          legendPin('high', 'up', short ? `dražší > +${highPct} %` : `předražená (> +${highPct} %)`),
          legendPin('none', null, short ? 'bez odhadu' : 'bez odhadu / nejistý'),
          legendPin('none', null, short ? 'e-kolo' : 'elektrokolo', true)
        )
      );
      return;
    }
    const counts = Object.values(state.summary.kraje || {}).map((k) => k.count);
    const total = counts.reduce((a, b) => a + b, 0);
    lg.append(el('div', { class: 'legend__title', text: 'Počet kol v kraji' }));
    if (!total) {
      lg.append(el('div', { text: 'Zatím žádná data' }));
      return;
    }
    const br = state.breaks;
    const colors = seqColors(br.length + 1);
    const steps = [];
    if (counts.some((c) => !c)) steps.push([css('--seq-empty'), '0']);
    const minPos = Math.min(...counts.filter((c) => c > 0));
    const maxV = Math.max(...counts);
    for (let i = 0; i <= br.length; i++) {
      const lo = i === 0 ? minPos : br[i - 1];
      const hi = i < br.length ? br[i] - 1 : maxV;
      const label = i === br.length ? (lo === hi ? fmtNum(lo) : `${fmtNum(lo)}+`) : lo === hi ? fmtNum(lo) : `${fmtNum(lo)}–${fmtNum(hi)}`;
      steps.push([colors[i], label]);
    }
    lg.append(
      el(
        'div',
        { class: 'legend__scale' },
        steps.map(([c, label]) => {
          const sw = el('span', { class: 'legend__swatch' });
          sw.style.background = c;
          return el('span', { class: 'legend__step' }, sw, el('span', { text: label }));
        })
      )
    );
  }

  // =========================================================================================== horní lišta

  function renderStatus(run) {
    const s = state.summary;
    const box = $('status');
    box.replaceChildren();
    if (!s) return;
    const t = s.totals || {};
    const stat = (n, label, cls) => el('span', { class: 'stat ' + (cls || '') }, el('b', { class: 'num', text: fmtNum(n) }), label);
    if (run && run.running) {
      box.append(el('span', { class: 'pill pill--running', text: 'Stahuji' }), el('span', { class: 'run-text', text: run.progress || 'Spouštím…' }));
    } else {
      const lr = s.lastRun;
      // na úzkém displeji jen jeden štítek (upozornění na demo data je i v panelu)
      if (s.demo) box.append(el('span', { class: 'pill pill--demo' + (lr ? ' hide-xs' : ''), title: 'Ukázková data vložená nástrojem tools/demo-data.js', text: 'Demo data' }));
      if (lr) {
        const label = { ok: 'Aktuální', partial: 'Částečně', error: 'Chyba' }[lr.status] || lr.status;
        const errs = Object.entries(lr.stats?.sources || {})
          .filter(([, v]) => v && v.error)
          .map(([k, v]) => `${sourceLabel(k)}: ${v.error}`);
        const title = [lr.error, ...errs].filter(Boolean).join('\n') || `Poslední stažení ${fmtWhen(lr.finishedAt || lr.startedAt)}`;
        box.append(el('span', { class: `pill pill--${lr.status}`, title, text: label }));
        box.append(el('span', { class: 'hide-xs', text: `${state.mode === 'static' ? 'Data k' : 'Staženo'} ${fmtWhen(lr.finishedAt || lr.startedAt)}` }));
      } else if (!s.demo) {
        box.append(el('span', { class: 'pill', text: 'Zatím nestaženo' }));
      }
      if (state.mode === 'static' && !lr) box.append(el('span', { class: 'hide-xs', text: `Export ${fmtWhen(s.generatedAt)}` }));
    }
    box.append(
      el('span', { class: 'sep hide-sm' }),
      stat(t.bikes, plural(t.bikes, 'kolo', 'kola', 'kol'), 'hide-sm'),
      stat(t.deals, plural(t.deals, 'výhodné', 'výhodná', 'výhodných'), 'hide-sm'),
      stat(t.newToday, plural(t.newToday, 'nové', 'nová', 'nových'), 'hide-sm')
    );
  }

  function renderRunButton(run) {
    const box = $('run-actions');
    box.replaceChildren();
    if (state.mode !== 'server') return;
    const running = !!(run && run.running);
    const btn = el(
      'button',
      { type: 'button', class: 'btn btn--primary btn--run', disabled: running, title: running ? 'Stahování právě běží' : 'Stáhnout nové inzeráty ze všech webů' },
      running ? el('span', { class: 'spinner', 'aria-hidden': 'true' }) : icon('download'),
      el('span', { text: running ? 'Stahuji…' : 'Stáhnout teď' })
    );
    btn.addEventListener('click', startRun);
    box.append(btn);
  }

  // =========================================================================================== panel – přehled ČR

  function card(l, { showKraj = false } = {}) {
    const thumb = el('span', { class: 'thumb' }, icon('bike'));
    const photo = safeUrl(l.ph);
    if (photo) {
      const img = el('img', { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', src: photo });
      img.addEventListener('error', () => img.remove());
      thumb.append(img);
    }
    const priceEl = l.p > 0 ? el('span', { class: 'card__price', text: fmtCzk(l.p) }) : el('span', { class: 'card__price card__price--none', text: l.pn || 'Cena neuvedena' });
    const est = l.ai?.e ?? l.e;
    const when = ago(l.ps || l.f);
    const place = showKraj && l.k ? [l.c, KRAJE[l.k]?.[1]].filter(Boolean).join(', ') : l.c;
    const meta = [est ? `odhad ${fmtCzk(est)}` : null, place, sourceLabel(l.s), when]
      .filter(Boolean)
      .join(' · ');
    const btn = el(
      'button',
      { type: 'button', class: 'card' + (state.selectedId === l.id ? ' is-selected' : ''), dataset: { id: String(l.id) } },
      thumb,
      el(
        'span',
        { class: 'card__body' },
        el('span', { class: 'card__title' }, isNew(l) ? el('span', { class: 'new-tag', text: 'NOVÉ' }) : null, isEbike(l) ? el('span', { class: 'tag-eb', title: 'Elektrokolo' }, icon('bolt')) : null, l.t),
        el('span', { class: 'card__price-row' }, priceEl, dealBadge(l)),
        el('span', { class: 'card__meta', text: meta })
      )
    );
    btn.addEventListener('click', () => navigate(l.k || state.kraj, l.id));
    btn.addEventListener('mouseenter', () => setPinHighlight(l.id, true));
    btn.addEventListener('mouseleave', () => setPinHighlight(l.id, false));
    btn.addEventListener('focus', () => setPinHighlight(l.id, true));
    btn.addEventListener('blur', () => setPinHighlight(l.id, false));
    return el('li', null, btn);
  }

  function setCardHighlight(id, on) {
    const c = document.querySelector(`.card[data-id="${CSS.escape(String(id))}"]`);
    if (c) c.classList.toggle('is-hl', on);
  }

  function emptyDataHint() {
    const hint = el('div', { class: 'empty' }, el('b', { text: 'Zatím žádné inzeráty' }));
    if (state.mode === 'server') hint.append(el('div', { text: 'Spusťte stahování tlačítkem „Stáhnout teď“, nebo pro vyzkoušení vložte ukázková data: ' }), el('code', { text: 'npm run demo' }));
    else hint.append(el('div', { text: 'Statická verze neobsahuje žádná data – vytvořte export znovu po stažení inzerátů.' }));
    return hint;
  }

  function renderOverview() {
    const s = state.summary;
    const panel = $('panel');
    const t = s.totals || {};
    const head = el(
      'div',
      { class: 'phead' },
      el('h1', { text: 'Celá Česká republika' }),
      el(
        'div',
        { class: 'phead__sub' },
        `${fmtNum(t.bikes)} ${plural(t.bikes, 'kolo', 'kola', 'kol')} na prodej · ${fmtNum(t.deals)} ${plural(t.deals, 'výhodné', 'výhodná', 'výhodných')} · ${fmtNum(t.newToday)} ${plural(t.newToday, 'nové', 'nová', 'nových')} za ${state.thresholds.newHours} h`
      )
    );
    const nodes = [head];
    if (s.demo) {
      nodes.push(
        el(
          'div',
          { class: 'notice' },
          icon('warn'),
          el('span', null, 'Ukázková (demo) data – nejde o skutečné inzeráty. Smažete je příkazem ', el('code', { class: 'nowrap', text: 'npm run demo -- --clear' }), '.')
        )
      );
    }
    if (!t.bikes) {
      nodes.push(emptyDataHint());
      panel.replaceChildren(...nodes);
      return;
    }
    for (const l of s.topDeals || []) if (!state.byId.has(l.id)) state.byId.set(l.id, l);
    const tabBtn = (key, label) => {
      const b = el('button', { type: 'button', class: 'tab', role: 'tab', id: `tab-${key}`, 'aria-selected': String(state.tab === key), 'aria-controls': 'tabpanel' }, label);
      b.addEventListener('click', () => {
        state.tab = key;
        storage.set('tab', key);
        renderOverview();
      });
      return b;
    };
    nodes.push(el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Přehled' }, tabBtn('deals', 'Nejvýhodnější v ČR'), tabBtn('kraje', 'Kraje')));
    const body = el('div', { id: 'tabpanel', role: 'tabpanel', 'aria-labelledby': `tab-${state.tab}` });
    if (state.tab === 'kraje') body.append(krajTable(), sourcesNote());
    else body.append(...topDealsList());
    nodes.push(body);
    panel.replaceChildren(...nodes);
  }

  function topDealsList() {
    const deals = state.summary.topDeals || [];
    if (!deals.length) {
      return [el('div', { class: 'empty' }, el('b', { text: 'Žádné výhodné nabídky' }), el('div', { text: 'Žádný inzerát teď není výrazně pod odhadem tržní ceny s dostatečnou jistotou.' }))];
    }
    const t = state.thresholds;
    return [
      el('p', { class: 'section-title', text: `Cena aspoň ${Math.round((1 - t.deal) * 100)} % pod odhadem` }),
      el(
        'ul',
        { class: 'cards' },
        deals.map((l) => card(l, { showKraj: true }))
      ),
    ];
  }

  function krajTable() {
    const s = state.summary;
    const rows = Object.entries(s.kraje || {}).sort((a, b) => b[1].count - a[1].count);
    const tbody = el('tbody');
    for (const [code, k] of rows) {
      const sw = el('span', { class: 'kswatch' });
      sw.style.background = krajColor(k.count);
      const link = el('button', { type: 'button', class: 'klink' }, sw, k.name || krajName(code));
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        navigate(code);
      });
      const tr = el(
        'tr',
        null,
        el('td', null, link),
        el('td', { text: fmtNum(k.count) }),
        el('td', { class: k.deals ? 'deals-n' : '', text: fmtNum(k.deals) }),
        el('td', { text: fmtNum(k.newToday) }),
        el('td', { text: k.medianPrice ? fmtCzk(k.medianPrice) : '–' })
      );
      tr.addEventListener('click', () => navigate(code));
      tr.addEventListener('mouseenter', () => krajLayers.get(code) && highlightKraj(krajLayers.get(code), true));
      tr.addEventListener('mouseleave', () => krajLayers.get(code) && highlightKraj(krajLayers.get(code), false));
      tbody.append(tr);
    }
    return el(
      'table',
      { class: 'ktable' },
      el('thead', null, el('tr', null, el('th', { text: 'Kraj' }), el('th', { text: 'Kol' }), el('th', { text: 'Výhodných' }), el('th', { text: 'Nových' }), el('th', { text: 'Medián ceny' }))),
      tbody
    );
  }

  function sourcesNote() {
    const s = state.summary;
    const parts = Object.entries(s.sources || {})
      .filter(([, v]) => v.count > 0)
      .map(([k, v]) => `${v.label || sourceLabel(k)} ${fmtNum(v.count)}`);
    return el(
      'div',
      { class: 'foot-note' },
      parts.length ? el('div', { text: `Zdroje: ${parts.join(' · ')}` }) : null,
      s.unlocated ? el('div', { text: `Bez určené polohy (nejsou na mapě): ${fmtNum(s.unlocated)}` }) : null,
      el('div', { text: `Medián ceny = prostřední cena inzerátů kol v kraji. „Nové“ = poprvé viděné za posledních ${state.thresholds.newHours} h.` })
    );
  }

  // =========================================================================================== panel – kraj

  function activeFilterCount() {
    const f = state.filters;
    return f.sourcesOff.size + f.groups.size + (f.min !== '' ? 1 : 0) + (f.max !== '' ? 1 : 0) + (f.deals ? 1 : 0) + (f.fresh ? 1 : 0);
  }

  function renderKrajPanel(loading) {
    const code = state.kraj;
    const k = state.summary?.kraje?.[code] || { count: 0, deals: 0 };
    const back = el('button', { type: 'button', class: 'btn btn--ghost btn--sm back' }, icon('back'), 'Celá ČR');
    back.addEventListener('click', () => navigate(null));
    const head = el(
      'div',
      { class: 'phead' },
      el('div', { class: 'phead__top' }, back),
      el('h1', { text: krajName(code) }),
      el('div', { class: 'phead__sub' }, `${fmtNum(k.count)} ${plural(k.count, 'kolo', 'kola', 'kol')} · ${fmtNum(k.deals)} ${plural(k.deals, 'výhodné', 'výhodná', 'výhodných')} · ${fmtNum(k.newToday)} ${plural(k.newToday, 'nové', 'nová', 'nových')}`)
    );
    const panel = $('panel');
    if (loading) {
      panel.replaceChildren(head, el('div', { class: 'loading' }, el('span', { class: 'spinner' }), 'Načítám inzeráty…'));
      return;
    }
    panel.replaceChildren(head, buildToolbar(), el('ul', { class: 'cards', id: 'cards', 'aria-label': 'Inzeráty' }), el('div', { class: 'more', id: 'more' }));
  }

  function buildToolbar() {
    const f = state.filters;
    const search = el('input', { class: 'input', type: 'search', placeholder: 'Hledat značku, model…', 'aria-label': 'Hledat v inzerátech', value: f.q });
    search.value = f.q;
    let deb = null;
    search.addEventListener('input', () => {
      clearTimeout(deb);
      deb = setTimeout(() => {
        f.q = search.value;
        applyFilters();
      }, 160);
    });
    const sort = el('select', { class: 'select', 'aria-label': 'Řazení' }, SORTS.map(([k, label]) => el('option', { value: k, text: label })));
    sort.value = state.sort;
    sort.addEventListener('change', () => {
      state.sort = sort.value;
      storage.set('sort', state.sort);
      applyFilters();
    });
    const n = activeFilterCount();
    const toggle = el(
      'button',
      { type: 'button', class: 'btn btn--sm', 'aria-expanded': String(state.filtersOpen), 'aria-controls': 'filters' },
      icon('filter'),
      'Filtry',
      n ? el('span', { class: 'fbadge', text: String(n) }) : null
    );
    toggle.addEventListener('click', () => {
      state.filtersOpen = !state.filtersOpen;
      storage.set('filtersOpen', state.filtersOpen);
      $('filters').hidden = !state.filtersOpen;
      toggle.setAttribute('aria-expanded', String(state.filtersOpen));
    });
    const filters = buildFilters();
    filters.hidden = !state.filtersOpen;
    const reset = el('button', { type: 'button', class: 'linkbtn', id: 'reset', hidden: !n }, 'Zrušit filtry');
    reset.addEventListener('click', () => {
      Object.assign(state.filters, { q: '', sourcesOff: new Set(), groups: new Set(), min: '', max: '', deals: false, fresh: false });
      renderKrajPanel(false);
      applyFilters();
    });
    return el(
      'div',
      { class: 'toolbar' },
      el('div', { class: 'toolbar__row' }, el('label', { class: 'search' }, icon('search'), search)),
      el('div', { class: 'toolbar__row' }, toggle, sort),
      filters,
      el('div', { class: 'resultbar' }, el('span', { id: 'result-count', 'aria-live': 'polite' }), reset)
    );
  }

  function buildFilters() {
    const f = state.filters;
    const counts = { src: {}, grp: {} };
    for (const l of state.listings) {
      counts.src[l.s] = (counts.src[l.s] || 0) + 1;
      const g = typeGroup(l);
      counts.grp[g] = (counts.grp[g] || 0) + 1;
    }
    const srcKeys = [...new Set([...Object.keys(state.summary?.sources || {}), ...Object.keys(counts.src)])].filter((k) => counts.src[k]);
    const sources = el(
      'div',
      { class: 'chips' },
      srcKeys.map((k) => {
        const cb = el('input', { type: 'checkbox', checked: !f.sourcesOff.has(k) });
        cb.checked = !f.sourcesOff.has(k);
        cb.addEventListener('change', () => {
          if (cb.checked) f.sourcesOff.delete(k);
          else f.sourcesOff.add(k);
          onFiltersChanged();
        });
        return el('label', { class: 'chip' }, cb, sourceLabel(k), el('span', { class: 'count', text: fmtNum(counts.src[k]) }));
      })
    );
    const groups = el(
      'div',
      { class: 'chips' },
      TYPE_GROUPS.filter((g) => counts.grp[g.key]).map((g) => {
        const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(f.groups.has(g.key)) }, g.label, el('span', { class: 'count', text: fmtNum(counts.grp[g.key]) }));
        b.addEventListener('click', () => {
          if (f.groups.has(g.key)) f.groups.delete(g.key);
          else f.groups.add(g.key);
          b.setAttribute('aria-pressed', String(f.groups.has(g.key)));
          onFiltersChanged();
        });
        return b;
      })
    );
    const priceInput = (key, ph) => {
      const i = el('input', { class: 'input', type: 'number', inputmode: 'numeric', min: '0', step: '500', placeholder: ph, 'aria-label': `Cena ${ph} (Kč)` });
      i.value = f[key];
      i.addEventListener('input', () => {
        f[key] = i.value.trim();
        onFiltersChanged();
      });
      return i;
    };
    const toggle = (key, label) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!f[key];
      cb.addEventListener('change', () => {
        f[key] = cb.checked;
        onFiltersChanged();
      });
      return el('label', { class: 'toggle' }, cb, label);
    };
    return el(
      'div',
      { class: 'filters', id: 'filters' },
      el('div', { class: 'fgroup' }, el('span', { class: 'fgroup__label', text: 'Zdroj' }), sources),
      el('div', { class: 'fgroup' }, el('span', { class: 'fgroup__label', text: 'Typ kola' }), groups),
      el('div', { class: 'fgroup' }, el('span', { class: 'fgroup__label', text: 'Cena (Kč)' }), el('div', { class: 'price-range' }, priceInput('min', 'od'), '–', priceInput('max', 'do'))),
      el('div', { class: 'toggles' }, toggle('deals', 'Jen výhodné'), toggle('fresh', `Jen nové (${state.thresholds.newHours} h)`))
    );
  }

  let filterDeb = null;
  function onFiltersChanged() {
    clearTimeout(filterDeb);
    filterDeb = setTimeout(() => {
      applyFilters();
      const n = activeFilterCount();
      const btn = document.querySelector('.toolbar [aria-controls="filters"]');
      if (btn) {
        btn.querySelector('.fbadge')?.remove();
        if (n) btn.append(el('span', { class: 'fbadge', text: String(n) }));
      }
      const reset = $('reset');
      if (reset) reset.hidden = !n && !state.filters.q;
    }, 120);
  }

  const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

  function applyFilters() {
    const f = state.filters;
    const q = fold(f.q).split(/\s+/).filter(Boolean);
    const min = num(f.min);
    const max = num(f.max);
    state.filtered = state.listings.filter((l) => {
      if (f.sourcesOff.size && f.sourcesOff.has(l.s)) return false;
      if (f.groups.size && !f.groups.has(typeGroup(l))) return false;
      if (min != null && !(l.p >= min)) return false;
      if (max != null && !(l.p <= max)) return false;
      if (f.deals && dealClass(l) !== 'good') return false;
      if (f.fresh && !isNew(l)) return false;
      if (q.length) {
        if (!l._hay) l._hay = fold([l.t, l.b, l.m].filter(Boolean).join(' '));
        if (!q.every((t) => l._hay.includes(t))) return false;
      }
      return true;
    });
    sortListings(state.filtered);
    state.shown = 0;
    const ul = $('cards');
    if (ul) ul.replaceChildren();
    renderMore();
    renderPins();
    const rc = $('result-count');
    if (rc) {
      const n = state.filtered.length;
      rc.textContent = n === state.listings.length ? `${fmtNum(n)} ${plural(n, 'inzerát', 'inzeráty', 'inzerátů')}` : `${fmtNum(n)} z ${fmtNum(state.listings.length)}`;
    }
    const reset = $('reset');
    if (reset) reset.hidden = !activeFilterCount() && !f.q;
  }

  function sortListings(arr) {
    const last = (v, dir) => (v == null || Number.isNaN(v) ? Infinity : dir * v);
    const by = {
      deal: (l) => {
        const c = dealClass(l);
        return c === 'none' ? Infinity : c === 'unsure' ? 10 + l.d : l.d;
      },
      new: (l) => {
        const t = Date.parse(l.ps || l.f || '');
        return Number.isFinite(t) ? -t : Infinity;
      },
      cheap: (l) => last(l.p > 0 ? l.p : null, 1),
      expensive: (l) => last(l.p > 0 ? l.p : null, -1),
      discount: (l) => {
        const e = l.ai?.e ?? l.e;
        return l.p > 0 && e ? -(e - l.p) : Infinity;
      },
    }[state.sort] || ((l) => l.d ?? Infinity);
    for (const l of arr) l._k = by(l);
    arr.sort((a, b) => a._k - b._k || (a.id > b.id ? -1 : 1));
  }

  function renderMore() {
    const ul = $('cards');
    const more = $('more');
    if (!ul || !more) return;
    const next = state.filtered.slice(state.shown, state.shown + PAGE);
    ul.append(...next.map((l) => card(l)));
    state.shown += next.length;
    more.replaceChildren();
    if (!state.filtered.length) {
      more.append(
        el(
          'div',
          { class: 'empty' },
          el('b', { text: state.listings.length ? 'Nic neodpovídá filtrům' : 'V kraji teď nejsou žádné inzeráty kol' }),
          state.listings.length ? el('div', { text: 'Zkuste filtry uvolnit nebo zrušit.' }) : null
        )
      );
      return;
    }
    if (state.shown < state.filtered.length) {
      const b = el('button', { type: 'button', class: 'btn' }, `Zobrazit další (${fmtNum(state.filtered.length - state.shown)})`);
      b.addEventListener('click', renderMore);
      more.append(b);
      // automatické dočtení při doscrollování
      if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            io.disconnect();
            if (b.isConnected) renderMore();
          }
        });
        io.observe(b);
      }
    }
  }

  // =========================================================================================== detail

  function chip(label, value) {
    if (value == null || value === '') return null;
    return el('span', { class: 'fchip' }, el('span', { text: label }), String(value));
  }

  function section(title, ...content) {
    const items = content.flat().filter(Boolean);
    if (!items.length) return null;
    return el('section', { class: 'dsec' }, el('h3', { text: title }), ...items);
  }

  function confidenceLabel(c) {
    if (c == null) return null;
    const pct = Math.round(c * 100);
    const word = c >= 0.75 ? 'vysoká' : c >= 0.5 ? 'střední' : 'nízká';
    const bar = el('span', { class: 'conf__bar', 'aria-hidden': 'true' }, el('i'));
    bar.firstChild.style.width = `${pct}%`;
    return el('span', { class: 'conf' }, bar, `jistota ${word} (${pct} %)`);
  }

  function estimateBox(l) {
    const ai = l.ai && l.ai.e ? l.ai : null;
    const e = ai ? ai.e : l.e;
    if (!e) {
      return el('div', { class: 'box' }, el('div', { class: 'box__label', text: 'Odhad tržní ceny' }), el('div', { class: 'box__sub', text: 'Pro tento inzerát zatím odhad nemáme (chybí cena nebo údaje o kole).' }));
    }
    const lo = ai ? ai.l : l.el;
    const hi = ai ? ai.h : l.eh;
    const method = ai ? METHOD.ai : METHOD[l.em] || l.em || null;
    const box = el(
      'div',
      { class: 'box' },
      el('div', { class: 'box__label', text: 'Odhad tržní ceny' }),
      el('div', { class: 'box__value' }, fmtCzk(e), lo && hi ? el('small', { text: ` (${fmtNum(lo)}–${fmtNum(hi)} Kč)` }) : null),
      el('div', { class: 'box__sub' }, ai ? null : confidenceLabel(l.ec), ai ? null : method ? ` · metoda: ${method}` : null, ai ? `metoda: ${method}` : null)
    );
    if (ai) {
      if (ai.c) box.append(el('div', { class: 'box__sub', text: `Stav podle AI: ${CONDITION[ai.c] || ai.c}` }));
      if (ai.n) box.append(el('p', { class: 'ai-notes', text: ai.n }));
      if (l.e) box.append(el('div', { class: 'box__sub' }, `Výpočetní model: ${fmtCzk(l.e)}`, l.el && l.eh ? ` (${fmtNum(l.el)}–${fmtNum(l.eh)} Kč)` : '', ' · ', confidenceLabel(l.ec)));
    }
    return box;
  }

  function renderDetail(l) {
    const d = $('detail');
    const close = el('button', { type: 'button', class: 'btn btn--ghost btn--icon', 'aria-label': 'Zavřít detail' }, icon('close'));
    close.addEventListener('click', closeDetailNav);
    const back = el('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, icon('back'), state.kraj ? 'Zpět na seznam' : 'Zpět');
    back.addEventListener('click', closeDetailNav);

    const photoUrl = safeUrl(l.ph);
    let photo = null;
    if (photoUrl) {
      const img = el('img', { alt: `Fotka: ${l.t}`, referrerpolicy: 'no-referrer', decoding: 'async', src: photoUrl });
      photo = el('figure', { class: 'detail__photo' }, img);
      img.addEventListener('error', () => photo.remove());
    }
    const priceRow = el(
      'div',
      { class: 'detail__price' },
      l.p > 0 ? el('span', { class: 'big num', text: fmtCzk(l.p) }) : el('span', { class: 'note', text: l.pn || 'Cena neuvedena' }),
      dealBadge(l),
      l.p > 0 && l.pn ? el('span', { class: 'muted', text: l.pn }) : null
    );
    const buy = l.mb
      ? el(
          'div',
          { class: 'box box--buy' },
          el('div', null, el('div', { class: 'box__label', text: 'Max. výkupní cena pro obchod' }), el('div', { class: 'box__sub', text: 'aby po prodeji zůstala cílová marže' })),
          el('div', { class: 'box__value num', text: fmtCzk(l.mb) })
        )
      : null;
    const chips = el(
      'div',
      { class: 'fchips' },
      chip('Typ', BIKE_TYPES[l.bt] || null),
      chip('Značka', l.b),
      chip('Model', l.m),
      chip('Rok', l.y),
      chip('Kola', l.ws),
      chip('Rám', l.fs),
      chip('Materiál', MATERIAL[l.mat] || l.mat),
      chip('Motor', l.mo || (isEbike(l) ? 'elektrokolo' : null)),
      chip('Baterie', l.wh ? `${fmtNum(l.wh)} Wh` : null),
      chip('Sada', l.gs),
      chip('Stav', CONDITION[l.cond] || l.cond)
    );
    const warnings = l.w && l.w.length ? el('div', { class: 'alert', role: 'note' }, icon('warn'), el('ul', null, l.w.map((w) => el('li', { text: w })))) : null;
    const factors = section('Proč tento odhad', l.fx && l.fx.length ? el('ul', null, l.fx.map((x) => el('li', { text: x }))) : null);
    const location = section(
      'Poloha',
      el('p', null, l.c || krajName(l.k) || 'neuvedeno', l.k && l.c ? el('span', { class: 'muted', text: ` · ${krajName(l.k)}` }) : null),
      l.g ? el('p', { class: 'muted', text: `Na mapě: ${PRECISION[l.g] || l.g}` }) : el('p', { class: 'muted', text: 'Polohu se nepodařilo určit – inzerát není na mapě.' })
    );
    const facts = [
      `${sourceLabel(l.s)}`,
      l.ps ? `vloženo ${fmtDate(l.ps)}` : null,
      l.f ? `u nás poprvé ${fmtDate(l.f)}` : null,
      l.v != null ? `${fmtNum(l.v)} zobrazení` : null,
      l.st === 'company' ? 'prodává firma' : l.st === 'private' ? 'soukromý prodejce' : null,
    ].filter(Boolean);
    const info = section('Inzerát', el('p', { text: facts.join(' · ') }));
    const desc = l.de ? el('div', { class: 'desc', id: 'desc', text: l.de }) : null;
    let descSec = null;
    if (desc) {
      const toggle = el('button', { type: 'button', class: 'linkbtn', hidden: true }, 'Zobrazit celý popis');
      toggle.addEventListener('click', () => {
        const clamped = desc.classList.toggle('is-clamped');
        toggle.textContent = clamped ? 'Zobrazit celý popis' : 'Skrýt popis';
      });
      descSec = section('Popis', desc, toggle);
      requestAnimationFrame(() => {
        if (desc.scrollHeight > 160) {
          desc.classList.add('is-clamped');
          toggle.hidden = false;
        }
      });
    }
    const paramsSec = paramsTable(l.pa);
    const history = el('div', { id: 'history' });
    const url = safeUrl(l.u);
    const foot = url
      ? el(
          'div',
          { class: 'detail__foot' },
          el('a', { class: 'btn btn--primary', href: url, target: '_blank', rel: 'noopener noreferrer' }, `Otevřít inzerát na ${sourceLabel(l.s)}`, icon('external'))
        )
      : null;
    const title = el('h2', { id: 'detail-title', tabindex: '-1', text: l.t });
    const parts = [
      el('div', { class: 'sheet-handle', 'aria-hidden': 'true' }),
      el('div', { class: 'detail__bar' }, back, close),
      el(
        'div',
        { class: 'detail__scroll' },
        photo,
        el(
          'div',
          { class: 'detail__body' },
          el('div', null, title, el('div', { class: 'detail__where', text: [l.c, sourceLabel(l.s), ago(l.ps || l.f)].filter(Boolean).join(' · ') })),
          priceRow,
          estimateBox(l),
          buy,
          chips.childNodes.length ? chips : null,
          warnings,
          factors,
          location,
          info,
          descSec,
          paramsSec,
          history
        )
      ),
      foot,
    ];
    d.replaceChildren(...parts.filter(Boolean));
    d.hidden = false;
    d.scrollTop = 0;
    title.focus({ preventScroll: true });
  }

  function paramsTable(pa) {
    if (!pa || typeof pa !== 'object') return null;
    const rows = Object.entries(pa).filter(([k, v]) => k !== 'demo' && v != null && v !== '' && typeof v !== 'object');
    if (!rows.length) return null;
    return section('Parametry z inzerátu', el('table', { class: 'params' }, el('tbody', null, rows.map(([k, v]) => el('tr', null, el('th', { text: k }), el('td', { text: String(v) }))))));
  }

  /** Server: plný popis a historie ceny z /api/listing/:id. */
  async function loadFullDetail(id) {
    if (state.mode !== 'server') return;
    state.detailCtrl?.abort();
    const ctrl = new AbortController();
    state.detailCtrl = ctrl;
    let full;
    try {
      full = await fetchJson(`api/listing/${encodeURIComponent(id)}`, { signal: ctrl.signal, cache: 'no-store' });
    } catch {
      return;
    }
    if (ctrl.signal.aborted || state.selectedId !== id) return;
    const desc = $('desc');
    if (desc && full.description && full.description.length > desc.textContent.length) desc.textContent = full.description;
    const box = $('history');
    const h = (full.history || []).filter((x) => x.price != null);
    if (box && h.length > 1) {
      const rows = h.map((x, i) => {
        const prev = i ? h[i - 1].price : null;
        const diff = prev != null ? x.price - prev : 0;
        return el(
          'div',
          { class: 'history__row' },
          el('span', { text: fmtDate(x.at) }),
          el(
            'span',
            null,
            fmtCzk(x.price),
            diff ? el('span', { class: diff < 0 ? 'history__drop' : 'history__rise', text: ` (${diff < 0 ? '−' : '+'}${fmtNum(Math.abs(diff))} Kč)` }) : null
          )
        );
      });
      const first = h[0].price;
      const lastP = h[h.length - 1].price;
      const sub = lastP < first ? el('p', { class: 'history__drop', text: `Zlevněno celkem o ${fmtNum(first - lastP)} Kč (${Math.round(((first - lastP) / first) * 100)} %)` }) : null;
      box.replaceChildren(section('Vývoj ceny', sub, el('div', { class: 'history' }, rows)));
    }
  }

  function openDetail(id) {
    const l = state.byId.get(id);
    if (!l) {
      toast('Inzerát už v nabídce není (prodán nebo smazán).');
      navigate(state.kraj, null, true);
      return;
    }
    state.selectedId = id;
    for (const c of document.querySelectorAll('.card.is-selected')) c.classList.remove('is-selected');
    document.querySelector(`.card[data-id="${CSS.escape(String(id))}"]`)?.classList.add('is-selected');
    renderDetail(l);
    if (isMobile()) window.scrollTo({ top: 0, behavior: 'smooth' });
    if (state.kraj) focusListingOnMap(l);
    loadFullDetail(id);
  }

  function closeDetail() {
    const wasOpen = state.selectedId;
    state.selectedId = null;
    state.detailCtrl?.abort();
    $('detail').hidden = true;
    $('detail').replaceChildren();
    setSelectedPin(null);
    for (const c of document.querySelectorAll('.card.is-selected')) c.classList.remove('is-selected');
    if (wasOpen != null) {
      const c = document.querySelector(`.card[data-id="${CSS.escape(String(wasOpen))}"]`);
      if (c && !isMobile()) c.focus({ preventScroll: false });
    }
  }

  function closeDetailNav() {
    navigate(state.kraj, null);
  }

  // =========================================================================================== běh stahování (server)

  async function startRun() {
    try {
      const r = await fetch('api/run', { method: 'POST', headers: { 'X-Requested-With': 'kolomapa' } });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409) toast(j.error || 'Stahování už běží.');
      else if (!r.ok) {
        toast(j.error || `Stahování nejde spustit (HTTP ${r.status}).`);
        return;
      } else toast('Stahování spuštěno – může trvat desítky minut.');
      state.run.wasRunning = true;
      pollRun(true);
    } catch {
      toast('Server neodpovídá.');
    }
  }

  async function pollRun(immediate) {
    clearTimeout(state.run.timer);
    if (state.mode !== 'server') return;
    let st;
    try {
      st = await fetchJson('api/run', { cache: 'no-store' });
    } catch {
      state.run.timer = setTimeout(pollRun, POLL_MS * 3);
      return;
    }
    renderStatus(st);
    renderRunButton(st);
    if (st.running) {
      state.run.wasRunning = true;
      state.run.timer = setTimeout(pollRun, POLL_MS);
    } else if (state.run.wasRunning) {
      state.run.wasRunning = false;
      const lr = st.lastRun;
      toast(lr && lr.status === 'error' ? `Stahování skončilo chybou: ${lr.error || ''}` : 'Stahování dokončeno – data jsou aktuální.');
      await reloadData();
      renderStatus(null);
    } else if (immediate) {
      renderStatus(null);
    }
  }

  async function reloadData() {
    try {
      await loadSummary();
    } catch {
      return;
    }
    state.krajCache.clear();
    markers.clear();
    state.breaks = computeBreaks(Object.values(state.summary.kraje || {}).map((k) => k.count));
    styleKraje();
    renderLabels();
    renderLegend();
    const { kraj, id } = parseHash();
    state.kraj = null;
    await applyRoute(kraj, id);
  }

  // =========================================================================================== navigace

  function parseHash() {
    // #/JHM, #/JHM/123, #/CR/123 (inzerát bez kraje z přehledu ČR)
    const m = /^#\/?([A-Za-z]{2,3})?(?:\/(\d+))?$/.exec(location.hash || '');
    const kraj = m && m[1] && KRAJE[m[1].toUpperCase()] ? m[1].toUpperCase() : null;
    const id = m && m[2] ? Number(m[2]) : null;
    return { kraj, id };
  }

  /** Změní adresu (#/KRAJ/ID) → hashchange → applyRoute. replace = bez nového záznamu v historii. */
  function navigate(kraj, id, replace) {
    const h = '#/' + (kraj || (id != null ? 'CR' : '')) + (id != null ? `/${id}` : '');
    if (location.hash === h) {
      applyRoute();
      return;
    }
    if (replace) {
      history.replaceState(null, '', h);
      applyRoute();
    } else location.hash = h;
  }

  async function enterKraj(code) {
    const seq = ++state.navSeq;
    state.kraj = code;
    closeDetail();
    styleKraje();
    map.removeLayer(labelLayer);
    $('btn-cr').hidden = false;
    renderLegend();
    const layer = krajLayers.get(code);
    if (layer) fitTo(layer.getBounds(), isMobile() ? [12, 12] : [28, 28]);
    layer?.closeTooltip();
    renderKrajPanel(true);
    $('panel').scrollTop = 0;
    let data;
    try {
      data = await loadKraj(code);
    } catch (e) {
      if (seq !== state.navSeq) return false;
      $('panel').replaceChildren(
        el('div', { class: 'empty' }, el('b', { text: 'Inzeráty kraje se nepodařilo načíst' }), el('div', { text: e.message })),
        el('div', { class: 'more' }, el('button', { type: 'button', class: 'btn', onclick: () => enterKraj(code) }, 'Zkusit znovu'))
      );
      return false;
    }
    if (seq !== state.navSeq) return false;
    state.listings = data.listings || [];
    state.byId = new Map(state.listings.map((l) => [l.id, l]));
    renderKrajPanel(false);
    applyFilters();
    return true;
  }

  function exitKraj() {
    state.navSeq++;
    state.kraj = null;
    closeDetail();
    cluster.clearLayers();
    styleKraje();
    if (!map.hasLayer(labelLayer)) map.addLayer(labelLayer);
    $('btn-cr').hidden = true;
    renderLegend();
    fitTo(CR_BOUNDS, [8, 8]);
    state.byId = new Map();
    renderOverview();
  }

  async function applyRoute(krajArg, idArg) {
    const r = krajArg !== undefined ? { kraj: krajArg, id: idArg } : parseHash();
    if (r.kraj !== state.kraj || (r.kraj && !state.listings.length && !state.krajCache.has(r.kraj))) {
      if (r.kraj) {
        const ok = await enterKraj(r.kraj);
        if (!ok) return;
      } else exitKraj();
    } else if (!r.kraj && !$('panel').firstChild) renderOverview();
    if (r.id != null) openDetail(r.id);
    else if (state.selectedId != null) closeDetail();
  }

  // =========================================================================================== start

  async function init() {
    if (!window.L || !L.markerClusterGroup) {
      $('panel').replaceChildren(el('div', { class: 'empty' }, el('b', { text: 'Mapová knihovna se nenačetla' }), el('div', { text: 'Chybí soubory ve vendor/ (Leaflet).' })));
      return;
    }
    initMap();
    $('panel').replaceChildren(el('div', { class: 'loading' }, el('span', { class: 'spinner' }), 'Načítám data…'));
    let geo;
    try {
      [, geo] = await Promise.all([loadSummary(), fetchJson('data/kraje.geojson', { cache: 'default' })]);
    } catch (e) {
      const fileHint = location.protocol === 'file:' ? 'Stránku otevřete přes webový server – prohlížeč nedovolí načíst data přímo ze souboru.' : e.message;
      $('panel').replaceChildren(
        el('div', { class: 'empty' }, el('b', { text: 'Data se nepodařilo načíst' }), el('div', { text: fileHint })),
        el('div', { class: 'more' }, el('button', { type: 'button', class: 'btn', onclick: () => location.reload() }, 'Načíst znovu'))
      );
      return;
    }
    state.geo = geo;
    state.breaks = computeBreaks(Object.values(state.summary.kraje || {}).map((k) => k.count));
    buildKrajLayer();
    renderStatus(null);
    renderRunButton(null);
    renderLegend();
    window.addEventListener('hashchange', () => applyRoute());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.selectedId != null) closeDetailNav();
    });
    let wasMobile = isMobile();
    window.addEventListener('resize', () => {
      map.invalidateSize();
      updateZoomClass();
      if (wasMobile !== isMobile()) {
        wasMobile = isMobile();
        renderLegend();
      }
    });
    if (!parseHash().kraj) renderOverview();
    await applyRoute();
    if (state.mode === 'server') pollRun(false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
