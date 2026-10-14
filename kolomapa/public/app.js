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
  // Filtry podle typu: tři nezávislé rozměry odvozené z bike_type a vytěžených údajů – kategorie, pohon, odpružení –
  // aby šlo zaškrtnout „horská“ + „celoodpružená“ + „elektrokola“ zároveň a libovolně kombinovat.
  const CATEGORIES = [
    { key: 'mtb', label: 'Horská', types: ['mtb_hardtail', 'mtb_full', 'ebike_mtb', 'ebike_mtb_full'] },
    { key: 'road', label: 'Silniční', types: ['road', 'ebike_road'] },
    { key: 'gravel', label: 'Gravel a cyklokros', types: ['gravel', 'cyclocross'] },
    { key: 'trek', label: 'Trekingová a krosová', types: ['trekking', 'cross', 'ebike_trekking'] },
    { key: 'city', label: 'Městská a skládací', types: ['city', 'folding', 'ebike_city'] },
    { key: 'kids', label: 'Dětská', types: ['kids', 'balance', 'ebike_kids'] },
    { key: 'bmx', label: 'BMX, dirt, fatbike', types: ['bmx', 'dirt', 'fatbike'] },
    { key: 'cargo', label: 'Nákladní a tandem', types: ['cargo', 'tandem', 'ebike_cargo'] },
    { key: 'other', label: 'Ostatní', types: [] },
  ];
  const DRIVES = [
    { key: 'classic', label: 'Klasická' },
    { key: 'ebike', label: 'Elektrokola' },
  ];
  const SUSPENSIONS = [
    { key: 'full', label: 'Celoodpružená' },
    { key: 'hardtail', label: 'Přední odpružení' },
    { key: 'rigid', label: 'Bez odpružení' },
    { key: 'unknown', label: 'Neuvedeno' },
  ];
  const SUSP_LABEL = { full: 'celoodpružené', hardtail: 'přední odpružení (hardtail)', rigid: 'bez odpružení' };
  // Značka motoru z vytěženého názvu („Bosch Performance CX“ → Bosch); jen u elektrokol. Obecný popis bez značky
  // („středový motor“, „motor v náboji“) se počítá jako neuvedená značka.
  const MOTOR_BRANDS = [
    ['Bosch', /^bosch/i],
    ['Shimano', /^shimano/i],
    ['Yamaha', /^yamaha/i],
    ['Specialized / Brose', /^(specialized|brose)/i],
    ['Bafang', /^bafang/i],
    ['Fazua', /^fazua/i],
    ['TQ', /^tq/i],
    ['Mahle', /^mahle/i],
    ['Panasonic', /^panasonic/i],
    ['DJI Avinox', /^dji/i],
  ];
  const MOTOR_OTHER = 'Jiná značka';
  const MOTOR_UNKNOWN = 'Neuvedený';
  const MOTOR_GENERIC = /^(středový motor|motor v náboji)$/;
  // Stáří inzerátu v hodinách – podle data vložení na web; když ho web neuvádí, podle prvního nalezení Kolomapou
  const AGES = [
    { key: '24', label: '24 hodin' },
    { key: '72', label: '3 dny' },
    { key: '168', label: '7 dní' },
    { key: '336', label: '14 dní' },
    { key: '720', label: '30 dní' },
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
  const SORT_NEAR = ['near', 'Nejblíž hledanému místu'];
  // Stav výkupu (jen se serverem, sdílený celým obchodem): pořadí, jak výkup jde po sobě. Ve filtru i „Neřešené“.
  const MARKS = [
    { key: 'contacted', label: 'Osloveno', icon: 'phone', hint: 'Prodávajícího jsme kontaktovali (telefon, zpráva)' },
    { key: 'scheduled', label: 'Domluveno', icon: 'calendar', hint: 'Domluvená prohlídka nebo výkup' },
    { key: 'bought', label: 'Koupeno', icon: 'check', hint: 'Kolo jsme vykoupili' },
    { key: 'rejected', label: 'Nechceme', icon: 'ban', hint: 'Nechceme řešit – nevyplatí se, podezřelé, prodáno jinde…' },
  ];
  const MARK_BY_KEY = Object.fromEntries(MARKS.map((m) => [m.key, m]));
  const MARK_FILTERS = [{ key: 'none', label: 'Neřešené' }, ...MARKS];
  const MARKS_POLL_MS = 60000;
  const NOTE_MAX = 500;
  const PAGE = 60;
  const POLL_MS = 3000;
  const DEFAULT_THRESHOLDS = { deal: 0.85, suspicious: 0.3, evidenceConfidence: 0.6, high: 1.15, minConfidence: 0.45, newHours: 36 };
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
    phone: ['M6.6 3.5h3l1.4 4.2-2 1.4a12 12 0 0 0 5.9 5.9l1.4-2 4.2 1.4v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z'],
    calendar: ['M5 6h14v14H5zM5 10h14M9 3.5V7M15 3.5V7'],
    check: ['M5 12.5l4.5 4.5L19 7.5'],
    ban: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM6 6l12 12'],
    pin: ['M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21zM12 7.3a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
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

  // Filtry se pamatují (localStorage) – obchod si jednou zaškrtne, co prodává, a mapa to drží; hledaný text ne.
  const SET_FILTERS = ['sourcesOff', 'cats', 'drive', 'susp', 'motors', 'marks'];
  const EMPTY_FILTERS = () => ({ q: '', sourcesOff: new Set(), cats: new Set(), drive: new Set(), susp: new Set(), motors: new Set(), marks: new Set(), age: '', min: '', max: '', deals: false, fresh: false });
  function loadFilters() {
    const f = EMPTY_FILTERS();
    const saved = storage.get('filters', null);
    if (!saved || typeof saved !== 'object') return f;
    for (const k of SET_FILTERS) if (Array.isArray(saved[k])) f[k] = new Set(saved[k].filter((v) => typeof v === 'string'));
    for (const k of ['age', 'min', 'max']) if (typeof saved[k] === 'string') f[k] = saved[k];
    for (const k of ['deals', 'fresh']) if (typeof saved[k] === 'boolean') f[k] = saved[k];
    return f;
  }
  function saveFilters() {
    const f = state.filters;
    const out = {};
    for (const k of SET_FILTERS) out[k] = [...f[k]];
    for (const k of ['age', 'min', 'max', 'deals', 'fresh']) out[k] = f[k];
    storage.set('filters', out);
  }

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
    filters: loadFilters(),
    filtersOpen: storage.get('filtersOpen', false),
    onlyVisible: storage.get('onlyVisible', true), // seznam jen z inzerátů v zobrazené části mapy (piny zůstávají všechny)
    listed: [], // state.filtered omezené na výřez mapy (když onlyVisible)
    keepListUntil: 0, // po kliknutí na kartu mapa přijíždí k pinu – seznam se při tom nepřepočítává
    sort: storage.get('sort', 'deal'),
    tab: storage.get('tab', 'deals'),
    selectedId: null,
    detailCtrl: null,
    navSeq: 0,
    run: { timer: null, wasRunning: false },
    breaks: [],
    marks: new Map(), // id inzerátu → stav výkupu {s, n, by, at, t, p, k, c, la, lo, gone} (server, /api/marks)
    markKeys: new Map(), // klíč titulku → id inzerátů se stavem (rozpoznání znovu vloženého kola)
    marksSig: '',
    marksTimer: null,
    markSaving: false,
    searchPoint: null, // hledané místo {lat, lon, label} – značka na mapě, vzdálenost a řazení „nejblíž“
    searchMarker: null,
    pendingView: null, // po vstupu do kraje přiblížit sem místo celého kraje (hledání místa)
  };

  // =========================================================================================== klasifikace nabídky

  /** good | fair | high | suspicious | unsure | none */
  function dealClass(l) {
    const t = state.thresholds;
    if (l.d == null || !(l.p > 0)) return 'none';
    if ((l.ec ?? 0) < t.minConfidence) return 'unsure';
    // hluboko pod odhadem = spíš díly, zástupná cena, překlep nebo podvod než výhodná koupě
    if (l.d < (t.suspicious ?? 0.3)) return 'suspicious';
    if (l.d <= t.deal) {
      // „výhodné“ jen s podloženým odhadem (srovnatelné inzeráty / AI / vysoká jistota), jinak nejisté
      const backed = l.em === 'comps' || !!l.ai?.e || (l.ec ?? 0) >= (t.evidenceConfidence ?? 0.6);
      return backed ? 'good' : 'unsure';
    }
    if (l.d > t.high) return 'high';
    return 'fair';
  }

  const isNew = (l) => !!(l.f && state.summary && l.f >= state.summary.newSince);
  const isEbike = (l) => !!(l.eb || (l.bt && l.bt.startsWith('ebike')));

  function category(l) {
    for (const c of CATEGORIES) if (c.types.includes(l.bt)) return c.key;
    return 'other';
  }
  const drive = (l) => (isEbike(l) ? 'ebike' : 'classic');
  const suspension = (l) => l.su || (/mtb_full$/.test(l.bt || '') ? 'full' : /^(mtb_hardtail|ebike_mtb)$/.test(l.bt || '') ? 'hardtail' : 'unknown');
  function motorBrand(l) {
    if (!isEbike(l)) return null;
    if (!l.mo || MOTOR_GENERIC.test(l.mo)) return MOTOR_UNKNOWN;
    for (const [name, re] of MOTOR_BRANDS) if (re.test(l.mo)) return name;
    return MOTOR_OTHER;
  }
  const listingTime = (l) => Date.parse(l.ps || l.f || '') || 0;
  const withinHours = (l, hours, now) => {
    const t = listingTime(l);
    return !!t && now - t <= Number(hours) * 3600e3;
  };

  /** Odznak „−24 % pod odhadem“ (barva + šipka + text – nikdy jen barva). */
  function dealBadge(l) {
    const c = dealClass(l);
    if (c === 'none') return null;
    const pct = Math.round(Math.abs(1 - l.d) * 100);
    if (c === 'unsure') return el('span', { class: 'badge', title: 'Odhad tržní ceny má nízkou jistotu' }, 'nejistý odhad');
    if (c === 'suspicious')
      return el(
        'span',
        { class: 'badge badge--suspicious', title: 'Cena je hluboko pod odhadem – často jde o díly, zástupnou cenu, překlep nebo podvod. Ověřte inzerát.' },
        '? podezřele levné'
      );
    if (c === 'good') return el('span', { class: 'badge badge--good' }, icon('down'), `${pct} % pod odhadem`);
    if (c === 'high') return el('span', { class: 'badge badge--high' }, icon('up'), `${pct} % nad odhadem`);
    return el('span', { class: 'badge badge--fair', title: `${l.d < 1 ? '−' : '+'}${pct} % proti odhadu` }, icon('dash'), 'běžná cena');
  }

  const sourceLabel = (s) => state.summary?.sources?.[s]?.label || SOURCE_LABELS[s] || s || '';
  const krajName = (k) => (KRAJE[k] ? KRAJE[k][0] : k || '');

  /** Vzdálenost dvou bodů vzdušnou čarou v km. */
  function distKm(aLat, aLon, bLat, bLon) {
    const r = Math.PI / 180;
    const h = Math.sin(((bLat - aLat) * r) / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLon - aLon) * r) / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  const kmFmt = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 1 });
  const fmtKm = (km) => (km < 1 ? 'do 1 km' : `${km < 10 ? kmFmt.format(km) : fmtNum(km)} km`);
  /** Vzdálenost inzerátu od hledaného místa (km) nebo null. */
  const distToSearch = (l) => (state.searchPoint && l.la != null && l.lo != null ? distKm(state.searchPoint.lat, state.searchPoint.lon, l.la, l.lo) : null);

  // =========================================================================================== stav výkupu (server)

  const marksOn = () => state.mode === 'server';
  const markOf = (l) => (l && marksOn() ? state.marks.get(l.id) || null : null);
  const markKey = (l) => markOf(l)?.s || 'none';
  /** „Nikol · dnes 9:12“ */
  const markWho = (m) => [m.by || null, fmtWhen(m.at)].filter(Boolean).join(' · ');

  /** Čip se stavem výkupu (karta, tooltip pinu, historie); null = bez stavu. */
  function markChip(m) {
    const def = m && MARK_BY_KEY[m.s];
    if (!def) return null;
    return el('span', { class: `mk mk--${m.s}`, title: `${def.label} – ${markWho(m)}${m.n ? `\n${m.n}` : ''}` }, icon(def.icon), def.label);
  }

  /** Klíč titulku pro rozpoznání stejného kola v novém inzerátu: bez diakritiky, interpunkce a mezer navíc. */
  const titleKey = (t) =>
    fold(t)
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  function rebuildMarkIndex() {
    state.markKeys = new Map();
    for (const [id, m] of state.marks) {
      const k = m.t ? titleKey(m.t) : '';
      if (k.length < 8) continue; // „Kolo“, „Prodám kolo“ – příliš obecné
      if (!state.markKeys.has(k)) state.markKeys.set(k, []);
      state.markKeys.get(k).push(id);
    }
  }

  /**
   * Inzerát bez stavu, který nejspíš nabízí kolo, které už obchod řešil – prodávající ho vložil znovu pod novým
   * inzerátem: stejný titulek i značka (a model, je-li u obou), do 15 km a cena ±30 %. Bez značky ne – „Dětské kolo
   * 20"“ je v každém okrese několikrát. Vrací {id, m} nebo null.
   */
  function similarMarked(l) {
    if (!l || !marksOn() || state.marks.has(l.id) || !state.markKeys.size || !l.t || !l.b) return null;
    const ids = state.markKeys.get(titleKey(l.t));
    if (!ids) return null;
    for (const id of ids) {
      const m = state.marks.get(id);
      if (!m || id === l.id || !m.b || fold(m.b) !== fold(l.b)) continue;
      if (m.m && l.m && fold(m.m) !== fold(l.m)) continue;
      if (m.la != null && l.la != null && distKm(m.la, m.lo, l.la, l.lo) > 15) continue;
      if (m.p > 0 && l.p > 0 && Math.abs(m.p - l.p) / Math.max(m.p, l.p) > 0.3) continue;
      return { id, m };
    }
    return null;
  }

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
    map.on('moveend', onMapMoved);
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
    return c === 'good' ? 22 : c === 'fair' ? 16 : c === 'high' ? 15 : c === 'suspicious' ? 15 : 12;
  }

  function pinIcon(l) {
    const c = dealClass(l);
    const visual = c === 'unsure' ? 'none' : c;
    // podezřele levné: šedý pin s otazníkem (není to výhodná nabídka, dokud se neověří)
    const s = pinSize(visual);
    const dot = el('span', { class: 'pin__dot' });
    if (visual === 'good') dot.append(icon('down'));
    else if (visual === 'suspicious') dot.append(el('span', { class: 'pin__q', text: '?' }));
    else if (visual === 'high') dot.append(icon('up'));
    // stav výkupu: odznak vpravo dole; „koupeno“ a „nechceme“ navíc zašedlé – už to nejsou příležitosti
    const mk = markOf(l);
    const wrap = el('span', null, dot, isEbike(l) ? el('span', { class: 'pin__bolt' }, icon('bolt')) : null, mk ? el('span', { class: 'pin__mk' }, icon(MARK_BY_KEY[mk.s].icon)) : null);
    return L.divIcon({ className: `pin pin--${visual}${mk ? ` pin--mk pin--mk-${mk.s}` : ''}`, html: wrap, iconSize: [s, s], iconAnchor: [s / 2, s / 2], tooltipAnchor: [0, -s / 2] });
  }

  /** Třída pro počet výhodných ve shluku: koupené a nechtěné se nepočítají. */
  function pinDealClass(l) {
    const mk = markOf(l);
    return mk && (mk.s === 'bought' || mk.s === 'rejected') ? 'handled' : dealClass(l);
  }

  function pinTooltip(l) {
    const price = l.p > 0 ? fmtCzk(l.p) : l.pn || 'cena neuvedena';
    const badge = dealBadge(l);
    const mk = markOf(l);
    return el(
      'div',
      { class: 'tip' },
      el('b', { text: price }),
      el('span', { text: l.t }),
      badge ? el('span', null, badge) : null,
      mk ? el('span', { class: 'tip__mk' }, markChip(mk), ` ${markWho(mk)}`) : null
    );
  }

  function pinLabel(l) {
    const mk = markOf(l);
    return `${l.t} – ${l.p > 0 ? fmtCzk(l.p) : l.pn || 'cena neuvedena'}${mk ? ` – ${MARK_BY_KEY[mk.s].label}` : ''}`;
  }

  function getMarker(l) {
    let m = markers.get(l.id);
    if (m) return m;
    m = L.marker([l.la, l.lo], { icon: pinIcon(l), keyboard: true, riseOnHover: true, dealClass: pinDealClass(l) });
    m.bindTooltip(() => pinTooltip(l), { direction: 'top', opacity: 1 });
    m.on('click', () => navigate(state.kraj || l.k, l.id));
    m.on('add', () => {
      const e = m.getElement();
      if (!e) return;
      e.setAttribute('aria-label', pinLabel(l));
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
    state.keepListUntil = Date.now() + 2500; // cesta mapy k pinu není změna výřezu od uživatele
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
    else if (cls === 'suspicious') dot.append(el('span', { class: 'pin__q', text: '?' }));
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
          legendPin('suspicious', null, short ? 'podezřelá' : 'podezřele levná (ověřit)'),
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

  /** Kdo je přihlášený (Cloudflare Access) – e-mail a odhlášení v horní liště; bez přihlášení přes Cloudflare nic. */
  async function loadMe() {
    try {
      const r = await fetch('api/me', { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!r.ok) return;
      const me = await r.json();
      const box = $('user');
      if (!box || !me || typeof me.user !== 'string' || !me.user) return;
      const parts = [el('span', { class: 'topbar__email', text: me.user, title: 'Přihlášen přes Cloudflare Access' })];
      if (typeof me.logout === 'string' && me.logout.startsWith('/')) {
        const out = new URL(me.logout, location.href); // odhlášení Cloudflare Access na stejné doméně
        if (out.origin === location.origin) parts.push(el('a', { class: 'linkbtn', href: out.href }, 'Odhlásit'));
      }
      box.replaceChildren(...parts);
      box.hidden = false;
    } catch {
      /* statická verze / bez sítě – nic */
    }
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
    const dist = distToSearch(l);
    const meta = [dist != null ? fmtKm(dist) : null, est ? `odhad ${fmtCzk(est)}` : null, place, sourceLabel(l.s), when]
      .filter(Boolean)
      .join(' · ');
    const mk = markOf(l);
    const sim = mk ? null : similarMarked(l);
    const marks = mk
      ? el('span', { class: 'card__marks' }, markChip(mk), el('span', { class: 'card__who', text: markWho(mk) }))
      : sim
        ? el('span', { class: 'card__marks' }, el('span', { class: 'mk mk--dup', title: `Stejný titulek jako inzerát, který už jste řešili: ${MARK_BY_KEY[sim.m.s].label} – ${markWho(sim.m)}` }, icon('warn'), 'možná už řešené'))
        : null;
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'card' + (state.selectedId === l.id ? ' is-selected' : '') + (mk && (mk.s === 'bought' || mk.s === 'rejected') ? ' card--done' : ''),
        dataset: { id: String(l.id), ...(showKraj ? { showKraj: '1' } : {}) },
      },
      thumb,
      el(
        'span',
        { class: 'card__body' },
        el('span', { class: 'card__title' }, isNew(l) ? el('span', { class: 'new-tag', text: 'NOVÉ' }) : null, isEbike(l) ? el('span', { class: 'tag-eb', title: 'Elektrokolo' }, icon('bolt')) : null, l.t),
        el('span', { class: 'card__price-row' }, priceEl, dealBadge(l)),
        marks,
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
    return (
      f.sourcesOff.size +
      f.cats.size +
      f.drive.size +
      f.susp.size +
      f.motors.size +
      (marksOn() ? f.marks.size : 0) +
      (f.age ? 1 : 0) +
      (f.min !== '' ? 1 : 0) +
      (f.max !== '' ? 1 : 0) +
      (f.deals ? 1 : 0) +
      (f.fresh ? 1 : 0)
    );
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
    const sort = el('select', { class: 'select', id: 'sort', 'aria-label': 'Řazení' });
    fillSortOptions(sort);
    sort.addEventListener('change', () => {
      state.sort = sort.value;
      if (state.sort !== 'near') storage.set('sort', state.sort); // „nejblíž“ platí jen pro hledané místo
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
    const filters = buildFilters();
    filters.hidden = !state.filtersOpen;
    filters.append(filtersFoot());
    const active = el('div', { class: 'chips chips--active', id: 'active-filters', 'aria-label': 'Zapnuté filtry' });
    const syncOpen = () => {
      $('filters').hidden = !state.filtersOpen;
      toggle.setAttribute('aria-expanded', String(state.filtersOpen));
      renderActiveFilters();
    };
    toggle.addEventListener('click', () => {
      state.filtersOpen = !state.filtersOpen;
      storage.set('filtersOpen', state.filtersOpen);
      syncOpen();
    });

    const reset = el('button', { type: 'button', class: 'linkbtn', id: 'reset', hidden: !n }, 'Zrušit filtry');
    reset.addEventListener('click', () => {
      Object.assign(state.filters, EMPTY_FILTERS());
      saveFilters();
      renderKrajPanel(false);
      applyFilters();
    });
    // Seznam jen z výřezu mapy: přiblížíte město a vlevo dole vidíte, co je tam k mání; piny zůstávají všude.
    const vis = el('input', { type: 'checkbox', id: 'only-visible' });
    vis.checked = !!state.onlyVisible;
    vis.addEventListener('change', () => {
      state.onlyVisible = vis.checked;
      storage.set('onlyVisible', state.onlyVisible);
      applyFilters();
    });
    return el(
      'div',
      { class: 'toolbar' },
      el('div', { class: 'toolbar__row' }, el('label', { class: 'search' }, icon('search'), search)),
      el('div', { class: 'toolbar__row' }, toggle, sort),
      active,
      filters,
      el('div', { class: 'resultbar' }, el('span', { id: 'result-count', 'aria-live': 'polite' }), reset),
      el('label', { class: 'toggle toggle--sm' }, vis, 'Jen kola v zobrazené části mapy')
    );
  }

  /** Patička panelu filtrů s tlačítkem „Skrýt filtry“. */
  function filtersFoot() {
    const hide = el('button', { type: 'button', class: 'btn btn--sm', id: 'hide-filters' }, 'Skrýt filtry');
    hide.addEventListener('click', () => {
      state.filtersOpen = false;
      storage.set('filtersOpen', false);
      const f = $('filters');
      if (f) f.hidden = true;
      document.querySelector('.toolbar [aria-controls="filters"]')?.setAttribute('aria-expanded', 'false');
      renderActiveFilters();
    });
    return el('div', { class: 'filters__foot' }, hide);
  }

  /** Panel filtrů znovu (počty u „Stav výkupu“ po změně stavů); otevřenost a fokus zůstanou. */
  function rebuildFilters() {
    const old = $('filters');
    if (!old || old.contains(document.activeElement)) return; // právě v něm píše (cena) – nepřekreslovat pod rukama
    const fresh = buildFilters();
    fresh.hidden = old.hidden;
    fresh.append(filtersFoot());
    old.replaceWith(fresh);
  }

  /** Volby řazení; „Nejblíž hledanému místu“ jen při hledaném místě. */
  function fillSortOptions(sel) {
    const opts = state.searchPoint ? [SORT_NEAR, ...SORTS] : SORTS;
    if (state.sort === 'near' && !state.searchPoint) state.sort = storage.get('sort', 'deal');
    sel.replaceChildren(...opts.map(([k, label]) => el('option', { value: k, text: label })));
    sel.value = state.sort;
  }

  /** Zapnuté filtry jako čipy s křížkem – vidět i při skrytém panelu filtrů; křížek filtr zruší. */
  function activeFilterItems() {
    const f = state.filters;
    const items = [];
    const setItems = (setKey, defs) => {
      for (const key of f[setKey]) {
        const d = defs.find((x) => x.key === key);
        items.push({ label: d ? d.label : key, remove: () => f[setKey].delete(key) });
      }
    };
    if (marksOn()) for (const k of f.marks) items.push({ label: `stav: ${(MARK_FILTERS.find((x) => x.key === k) || { label: k }).label.toLowerCase()}`, remove: () => f.marks.delete(k) });
    for (const k of f.sourcesOff) items.push({ label: `bez: ${sourceLabel(k)}`, remove: () => f.sourcesOff.delete(k) });
    setItems('cats', CATEGORIES);
    setItems('drive', DRIVES);
    setItems('susp', SUSPENSIONS);
    for (const k of f.motors) items.push({ label: `motor ${k}`, remove: () => f.motors.delete(k) });
    if (f.age) items.push({ label: `do ${(AGES.find((a) => a.key === f.age) || { label: `${f.age} h` }).label}`, remove: () => (f.age = '') });
    if (f.min !== '') items.push({ label: `od ${fmtNum(f.min)} Kč`, remove: () => (f.min = '') });
    if (f.max !== '') items.push({ label: `do ${fmtNum(f.max)} Kč`, remove: () => (f.max = '') });
    if (f.deals) items.push({ label: 'jen výhodné', remove: () => (f.deals = false) });
    if (f.fresh) items.push({ label: 'jen nové', remove: () => (f.fresh = false) });
    return items;
  }
  function renderActiveFilters() {
    const box = $('active-filters');
    if (!box) return;
    const items = state.filtersOpen ? [] : activeFilterItems();
    box.hidden = !items.length;
    box.replaceChildren(
      ...items.map((it) => {
        const b = el('button', { type: 'button', class: 'chip chip--active', title: 'Zrušit tento filtr', 'aria-label': `Zrušit filtr ${it.label}` }, it.label, el('span', { class: 'x', 'aria-hidden': 'true', text: '×' }));
        b.addEventListener('click', () => {
          it.remove();
          saveFilters();
          renderKrajPanel(false);
          applyFilters();
        });
        return b;
      })
    );
  }

  function buildFilters() {
    const f = state.filters;
    const now = Date.now();
    const counts = { src: {}, cat: {}, drive: {}, susp: {}, motor: {}, age: {}, mark: {} };
    const inc = (o, k) => {
      if (k != null) o[k] = (o[k] || 0) + 1;
    };
    for (const l of state.listings) {
      inc(counts.src, l.s);
      inc(counts.cat, category(l));
      inc(counts.drive, drive(l));
      inc(counts.susp, suspension(l));
      inc(counts.motor, motorBrand(l));
      inc(counts.mark, markKey(l));
      for (const a of AGES) if (withinHours(l, a.key, now)) inc(counts.age, a.key);
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
    /** Zaškrtávací čipy (více najednou) nad množinou f[setKey]; jen položky, které v kraji jsou. */
    const chipSet = (items, setKey, countOf, showZero = false) =>
      el(
        'div',
        { class: 'chips', role: 'group' },
        items
          .filter((it) => showZero || countOf[it.key])
          .map((it) => {
            const set = f[setKey];
            const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(set.has(it.key)) }, it.label, el('span', { class: 'count', text: fmtNum(countOf[it.key] || 0) }));
            b.addEventListener('click', () => {
              if (set.has(it.key)) set.delete(it.key);
              else set.add(it.key);
              b.setAttribute('aria-pressed', String(set.has(it.key)));
              onFiltersChanged();
            });
            return b;
          })
      );
    /** Stáří: jedna volba (nebo žádná = vše) */
    const ageChips = el(
      'div',
      { class: 'chips', role: 'radiogroup', 'aria-label': 'Stáří inzerátu' },
      AGES.map((a) => {
        const b = el('button', { type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(f.age === a.key), 'aria-pressed': String(f.age === a.key) }, a.label, el('span', { class: 'count', text: fmtNum(counts.age[a.key] || 0) }));
        b.addEventListener('click', () => {
          f.age = f.age === a.key ? '' : a.key;
          for (const x of ageChips.querySelectorAll('.chip')) {
            x.setAttribute('aria-checked', String(x === b && f.age !== ''));
            x.setAttribute('aria-pressed', String(x === b && f.age !== ''));
          }
          onFiltersChanged();
        });
        return b;
      })
    );
    const motorItems = [...MOTOR_BRANDS.map(([name]) => ({ key: name, label: name })), { key: MOTOR_OTHER, label: MOTOR_OTHER }, { key: MOTOR_UNKNOWN, label: MOTOR_UNKNOWN }];
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
    const group = (label, body, hint) => el('div', { class: 'fgroup' }, el('span', { class: 'fgroup__label', text: label }), body, hint ? el('span', { class: 'fgroup__hint', text: hint }) : null);
    return el(
      'div',
      { class: 'filters', id: 'filters' },
      marksOn() ? group('Stav výkupu', chipSet(MARK_FILTERS, 'marks', counts.mark, true), 'Sdílený pro celý obchod – nastavíte ho v detailu inzerátu. „Neřešené“ = zatím bez stavu.') : null,
      group('Zdroj', sources),
      group('Typ kola', chipSet(CATEGORIES, 'cats', counts.cat)),
      group('Pohon', chipSet(DRIVES, 'drive', counts.drive)),
      group('Odpružení', chipSet(SUSPENSIONS, 'susp', counts.susp)),
      counts.drive.ebike ? group('Motor (elektrokola)', chipSet(motorItems, 'motors', counts.motor), 'Podle textu inzerátu; výběr motoru omezí výsledky na elektrokola.') : null,
      group('Stáří inzerátu', ageChips, 'Podle data vložení na web; když ho web neuvádí, podle toho, kdy inzerát poprvé našla Kolomapa. Bez výběru se zobrazí vše, co je na webu stále aktivní.'),
      group('Cena (Kč)', el('div', { class: 'price-range' }, priceInput('min', 'od'), '–', priceInput('max', 'do'))),
      el('div', { class: 'toggles' }, toggle('deals', 'Jen výhodné'), toggle('fresh', `Jen nové (${state.thresholds.newHours} h)`))
    );
  }

  let filterDeb = null;
  function onFiltersChanged() {
    clearTimeout(filterDeb);
    filterDeb = setTimeout(() => {
      applyFilters();
      saveFilters();
      renderActiveFilters();
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
    const now = Date.now();
    state.filtered = state.listings.filter((l) => {
      if (f.sourcesOff.size && f.sourcesOff.has(l.s)) return false;
      if (f.cats.size && !f.cats.has(category(l))) return false;
      if (f.drive.size && !f.drive.has(drive(l))) return false;
      if (f.susp.size && !f.susp.has(suspension(l))) return false;
      if (f.motors.size && !f.motors.has(motorBrand(l))) return false;
      if (f.marks.size && marksOn() && !f.marks.has(markKey(l))) return false;
      if (f.age && !withinHours(l, f.age, now)) return false;
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
    renderPins();
    renderList();
    const reset = $('reset');
    if (reset) reset.hidden = !activeFilterCount() && !f.q;
    renderActiveFilters();
  }

  /**
   * Inzeráty z state.filtered v zobrazené části mapy. Inzeráty bez polohy nejde umístit – ukážou se, jen dokud je
   * vidět celý kraj (jinak by počet „v zobrazené části“ nikdy nedosáhl počtu v kraji).
   */
  function inViewport(list) {
    if (!map || !state.kraj) return list;
    const b = map.getBounds();
    const layer = krajLayers.get(state.kraj);
    const wholeKraj = !!layer && b.contains(layer.getBounds());
    return list.filter((l) => (l.la != null && l.lo != null ? b.contains([l.la, l.lo]) : wholeKraj));
  }

  /** Seznam vlevo (karty) a počet – ze state.filtered, při „jen v zobrazené části mapy“ jen z výřezu. */
  function renderList() {
    state.listed = state.onlyVisible ? inViewport(state.filtered) : state.filtered;
    state.shown = 0;
    const ul = $('cards');
    if (ul) ul.replaceChildren();
    renderMore();
    const rc = $('result-count');
    if (rc) {
      const n = state.filtered.length;
      const all = n === state.listings.length;
      const base = all ? `${fmtNum(n)} ${plural(n, 'inzerát', 'inzeráty', 'inzerátů')}` : `${fmtNum(n)} z ${fmtNum(state.listings.length)}`;
      rc.textContent = state.listed.length === n ? base : `${fmtNum(state.listed.length)} v zobrazené části mapy · ${base}${all ? ' v kraji' : ''}`;
    }
  }

  let mapMoveDeb = null;
  function onMapMoved() {
    if (!state.kraj || !state.onlyVisible) return;
    if (Date.now() < state.keepListUntil) {
      state.keepListUntil = Date.now() + 500; // animace (zoom k pinu) jede ve víc krocích – počkat na její konec
      return;
    }
    clearTimeout(mapMoveDeb);
    mapMoveDeb = setTimeout(() => {
      if (!state.kraj || !state.onlyVisible) return;
      const next = inViewport(state.filtered);
      if (next.length === state.listed.length && next.every((l, i) => l === state.listed[i])) return;
      renderList();
    }, 150);
  }

  function sortListings(arr) {
    const last = (v, dir) => (v == null || Number.isNaN(v) ? Infinity : dir * v);
    const by = {
      deal: (l) => {
        const c = dealClass(l);
        if (c === 'good') {
          // výhodné: podle očekávané úspory v Kč vážené jistotou (nejnižší poměr vynáší spíš chyby odhadu)
          const e = l.ai?.e ?? l.e;
          return -((e - l.p) * (l.ec ?? 0.5)) / 1e9;
        }
        return c === 'none' ? Infinity : c === 'unsure' ? 10 + l.d : c === 'suspicious' ? 5 + l.d : l.d;
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
      near: (l) => distToSearch(l) ?? Infinity,
    }[state.sort] || ((l) => l.d ?? Infinity);
    for (const l of arr) l._k = by(l);
    arr.sort((a, b) => a._k - b._k || (a.id > b.id ? -1 : 1));
  }

  function renderMore() {
    const ul = $('cards');
    const more = $('more');
    if (!ul || !more) return;
    const list = state.listed;
    const next = list.slice(state.shown, state.shown + PAGE);
    ul.append(...next.map((l) => card(l)));
    state.shown += next.length;
    more.replaceChildren();
    if (!list.length) {
      const viewportOnly = state.filtered.length > 0; // filtry něco pustily, jen to není v zobrazené části mapy
      more.append(
        el(
          'div',
          { class: 'empty' },
          el('b', { text: viewportOnly ? 'V zobrazené části mapy nic není' : state.listings.length ? 'Nic neodpovídá filtrům' : 'V kraji teď nejsou žádné inzeráty kol' }),
          viewportOnly ? el('div', { text: 'Oddalte mapu, posuňte ji k pinům, nebo vypněte „Jen kola v zobrazené části mapy“.' }) : state.listings.length ? el('div', { text: 'Zkuste filtry uvolnit nebo zrušit.' }) : null
        )
      );
      return;
    }
    if (state.shown < list.length) {
      const b = el('button', { type: 'button', class: 'btn' }, `Zobrazit další (${fmtNum(list.length - state.shown)})`);
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
      chip('Odpružení', SUSP_LABEL[l.su] || null),
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
          markBox(l),
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
    if (marksOn()) {
      markLog = { id, log: Array.isArray(full.markLog) ? full.markLog : [] };
      // stav z detailu je čerstvější než seznam (ten se stahuje jednou za minutu)
      if ((full.mark?.at ?? null) !== (state.marks.get(id)?.at ?? null)) setLocalMark(id, full.mark || null);
      else renderMarkBox(state.byId.get(id), noteDraft());
    }
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

  // =========================================================================================== stav výkupu – detail, ukládání, obnova

  let markLog = { id: null, log: [] }; // historie stavu otevřeného inzerátu

  function markBox(l) {
    if (!marksOn()) return null;
    const box = el('section', { class: 'mkbox', id: 'markbox', 'aria-label': 'Stav výkupu' });
    fillMarkBox(box, l, null);
    return box;
  }

  function renderMarkBox(l, draft) {
    const box = $('markbox');
    if (box && l && state.selectedId === l.id) fillMarkBox(box, l, draft);
  }

  /** Rozepsaná poznámka v otevřeném detailu (null = uživatel nepsal → zobrazí se uložená). */
  function noteDraft() {
    const ta = document.querySelector('#markbox textarea');
    return ta && ta.dataset.dirty === '1' ? ta.value : null;
  }

  function fillMarkBox(box, l, draft) {
    const m = markOf(l);
    const busy = state.markSaving;
    const note = el('textarea', {
      class: 'input mkbox__note',
      rows: '2',
      maxlength: String(NOTE_MAX),
      placeholder: m ? 'Poznámka pro kolegy – např. „odmítl 26 tis., zkusit znovu 20. 10.“' : 'Poznámka (nepovinná) – uloží se spolu se stavem',
      'aria-label': 'Poznámka ke stavu výkupu',
    });
    note.value = draft != null ? draft : m?.n || '';
    if (draft != null) note.dataset.dirty = '1';
    const save = el('button', { type: 'button', class: 'btn btn--sm' }, 'Uložit poznámku');
    const syncSave = () => {
      const cur = markOf(l);
      save.hidden = !cur;
      save.disabled = busy || !cur || note.value.trim() === (cur.n || '');
    };
    note.addEventListener('input', () => {
      note.dataset.dirty = '1';
      syncSave();
    });
    note.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !save.disabled && !save.hidden) {
        e.preventDefault();
        save.click();
      }
    });
    save.addEventListener('click', () => {
      const cur = markOf(l);
      if (cur) saveMark(l, cur.s, note.value);
    });
    syncSave();
    const seg = el(
      'div',
      { class: 'mkbox__seg', role: 'group', 'aria-label': 'Nastavit stav výkupu' },
      MARKS.map((d) => {
        const on = m?.s === d.key;
        const b = el('button', { type: 'button', class: `mkbtn mkbtn--${d.key}`, 'aria-pressed': String(on), title: d.hint, disabled: busy }, icon(d.icon), d.label);
        b.addEventListener('click', () => {
          if (!on) saveMark(l, d.key, note.value);
        });
        return b;
      })
    );
    const clear = m ? el('button', { type: 'button', class: 'linkbtn mkbox__clear', disabled: busy }, 'Zrušit stav') : null;
    if (clear) clear.addEventListener('click', () => saveMark(l, null, ''));
    // prodávající vložil stejné kolo znovu pod novým inzerátem?
    const sim = m ? null : similarMarked(l);
    let dup = null;
    if (sim) {
      const name = `„${sim.m.t}“`;
      let link;
      if (sim.m.gone) link = el('span', { text: `${name} (už není na webu)` });
      else {
        link = el('button', { type: 'button', class: 'linkbtn' }, name);
        link.addEventListener('click', () => navigate(sim.m.k || state.kraj, sim.id));
      }
      dup = el(
        'div',
        { class: 'alert alert--soft', role: 'note' },
        icon('warn'),
        el('span', null, 'Možná stejné kolo, které už jste řešili: ', link, ` – ${MARK_BY_KEY[sim.m.s].label}, ${markWho(sim.m)}${sim.m.n ? ` („${sim.m.n}“)` : ''}.`)
      );
    }
    box.replaceChildren(
      el('div', { class: 'mkbox__head' }, el('span', { class: 'box__label', text: 'Stav výkupu' }), el('span', { class: 'mkbox__who', text: m ? markWho(m) : 'zatím nikdo neřešil' })),
      seg,
      dup || '',
      note,
      el('div', { class: 'mkbox__actions' }, save, clear, busy ? el('span', { class: 'spinner', role: 'status', 'aria-label': 'Ukládám' }) : null),
      (markLog.id === l.id && markLogEl(markLog.log)) || ''
    );
  }

  function markLogEl(log) {
    if (!Array.isArray(log) || !log.length) return null;
    return el(
      'details',
      { class: 'mkbox__hist' },
      el('summary', { text: `Historie změn (${log.length})` }),
      el(
        'ol',
        null,
        log.map((x) =>
          el(
            'li',
            null,
            el('span', { class: 'mkbox__when', text: fmtWhen(x.at) }),
            x.s && MARK_BY_KEY[x.s] ? markChip(x) : el('span', { class: 'muted', text: 'stav zrušen' }),
            x.by ? el('span', { class: 'muted', text: x.by }) : null,
            x.n ? el('div', { class: 'mkbox__lognote', text: x.n }) : null
          )
        )
      )
    );
  }

  /** Uloží stav (status null = zrušit) na server; souběh s kolegou → aktuální stav a upozornění. */
  async function saveMark(l, status, note) {
    if (state.markSaving) return;
    const cur = markOf(l);
    state.markSaving = true;
    renderMarkBox(l, note);
    let keepDraft = true;
    try {
      const r = await fetch(`api/marks/${encodeURIComponent(l.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'kolomapa' },
        body: JSON.stringify({ status: status || null, note: status ? note : null, expect: cur ? cur.at : null }),
        cache: 'no-store',
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409) {
        if (Array.isArray(j.log)) markLog = { id: l.id, log: j.log };
        setLocalMark(l.id, j.mark || null);
        toast(
          j.mark
            ? `Mezitím ${j.mark.by || 'kolega'} nastavil(a) „${MARK_BY_KEY[j.mark.s]?.label || j.mark.s}“ – zkontrolujte a případně změňte znovu.`
            : 'Stav mezitím někdo zrušil – zkontrolujte a případně nastavte znovu.'
        );
      } else if (!r.ok) {
        toast(j.error || `Stav se nepodařilo uložit (HTTP ${r.status}).`);
      } else {
        keepDraft = false;
        if (Array.isArray(j.log)) markLog = { id: l.id, log: j.log };
        setLocalMark(l.id, j.mark || null);
        toast(status ? `Uloženo: ${MARK_BY_KEY[status].label}${j.mark?.n ? ' s poznámkou' : ''}` : 'Stav výkupu zrušen.');
      }
    } catch {
      toast('Server neodpovídá – stav se neuložil.');
    } finally {
      state.markSaving = false;
      renderMarkBox(l, keepDraft && note !== (markOf(l)?.n || '') ? note : null);
    }
  }

  /** Stavy ze serveru (při startu, každou minutu a po návratu do okna) – vidět, co mezitím řešili kolegové. */
  async function loadMarks() {
    clearTimeout(state.marksTimer);
    if (!marksOn()) return;
    state.marksAt = Date.now();
    try {
      const j = await fetchJson('api/marks', { cache: 'no-cache' });
      applyMarks(Array.isArray(j.marks) ? j.marks : []);
    } catch {
      /* server dočasně nedostupný – další pokus za minutu */
    }
    state.marksTimer = setTimeout(loadMarks, MARKS_POLL_MS);
  }

  function applyMarks(list) {
    const sig = list.map((m) => `${m.id}:${m.at}`).join(',');
    if (sig === state.marksSig) return;
    state.marksSig = sig;
    const next = new Map();
    for (const m of list) if (m && Number.isFinite(m.id) && MARK_BY_KEY[m.s]) next.set(m.id, m);
    const changed = new Set();
    for (const [id, m] of next) if (state.marks.get(id)?.at !== m.at) changed.add(id);
    for (const id of state.marks.keys()) if (!next.has(id)) changed.add(id);
    const keys = new Set([...changed].map((id) => titleKey((next.get(id) || state.marks.get(id))?.t || '')));
    state.marks = next;
    rebuildMarkIndex();
    onMarksChanged(changed, keys);
  }

  /** Jeden stav po vlastním uložení nebo z detailu (údaje pro rozpoznání znovu vloženého kola doplní z inzerátu). */
  function setLocalMark(id, mark) {
    const prev = state.marks.get(id);
    if ((prev?.at ?? null) === (mark?.at ?? null)) return;
    const l = state.byId.get(id);
    const src = prev || l || {};
    if (mark) state.marks.set(id, { id, t: src.t, b: src.b, m: src.m, p: src.p, k: src.k, c: src.c, la: src.la, lo: src.lo, ...mark });
    else state.marks.delete(id);
    state.marksSig = ''; // příští seznam ze serveru se převezme celý
    rebuildMarkIndex();
    onMarksChanged(new Set([id]), new Set([titleKey(src.t || '')]));
  }

  /** Překreslí, čeho se změna stavů týká: piny, karty (i se stejným titulkem), otevřený detail. */
  function onMarksChanged(ids, keys = new Set()) {
    if (!ids.size) return;
    for (const id of ids) {
      const l = state.byId.get(id);
      const m = markers.get(id);
      if (!l || !m) continue;
      m.setIcon(pinIcon(l));
      m.options.dealClass = pinDealClass(l);
      m.getElement()?.setAttribute('aria-label', pinLabel(l));
      if (cluster.hasLayer(m)) cluster.refreshClusters(m);
    }
    if (state.selectedId != null && ids.has(state.selectedId)) setSelectedPin(state.selectedId);
    keys.delete('');
    if (state.kraj && state.listings.length) rebuildFilters();
    if (state.kraj && state.filters.marks.size) applyFilters();
    else refreshCards((l) => ids.has(l.id) || keys.has(titleKey(l.t || '')));
    const sel = state.selectedId != null ? state.byId.get(state.selectedId) : null;
    if (sel && (ids.has(sel.id) || keys.has(titleKey(sel.t || '')))) {
      renderMarkBox(sel, noteDraft());
      if (ids.has(sel.id) && !state.markSaving) loadMarkLog(sel.id);
    }
  }

  function refreshCards(pred) {
    for (const c of document.querySelectorAll('.card[data-id]')) {
      const l = state.byId.get(Number(c.dataset.id));
      const li = c.closest('li');
      if (!l || !li || !pred(l)) continue;
      li.replaceWith(card(l, { showKraj: c.dataset.showKraj === '1' }));
    }
  }

  async function loadMarkLog(id) {
    try {
      const j = await fetchJson(`api/marks/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (state.selectedId !== id) return;
      markLog = { id, log: Array.isArray(j.log) ? j.log : [] };
      renderMarkBox(state.byId.get(id), noteDraft());
    } catch {
      /* historie počká na další otevření */
    }
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

  // =========================================================================================== hledání místa na mapě (server)

  /** Kód kraje pro bod (point-in-polygon nad hranicemi krajů), null = mimo ČR. */
  function krajAtPoint(lat, lon) {
    const inRing = (ring) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    for (const f of state.geo?.features || []) {
      const g = f.geometry;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of polys) if (inRing(poly[0]) && !poly.slice(1).some(inRing)) return f.properties.code;
    }
    return null;
  }

  /**
   * Značka hledaného místa, vzdálenosti v seznamu a řazení „nejblíž“. refresh = hned přepočítat seznam (při přechodu
   * do jiného kraje ne – nový kraj se vykreslí sám).
   */
  function setSearchPoint(p, refresh = true) {
    state.searchMarker?.remove();
    state.searchPoint = p;
    const inner = el('span', { class: 'searchpin__inner' }, icon('pin'));
    const m = L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className: 'searchpin', html: inner, iconSize: [30, 34], iconAnchor: [15, 32], tooltipAnchor: [0, -30] }),
      zIndexOffset: 5000,
      keyboard: false,
    });
    m.bindTooltip(() => el('div', { class: 'tip' }, el('b', { text: p.label }), p.sub ? el('span', { text: p.sub }) : null), { direction: 'top', opacity: 1 });
    m.on('add', () => m.getElement()?.setAttribute('aria-label', `Hledané místo: ${p.label}`));
    m.addTo(map);
    state.searchMarker = m;
    state.sort = 'near';
    if (refresh) afterSearchPointChange();
  }

  function clearSearchPoint() {
    if (!state.searchPoint && !state.searchMarker) return;
    state.searchMarker?.remove();
    state.searchMarker = null;
    state.searchPoint = null;
    if (state.sort === 'near') state.sort = storage.get('sort', 'deal');
    afterSearchPointChange();
  }

  function afterSearchPointChange() {
    const sel = $('sort');
    if (sel) fillSortOptions(sel);
    if (state.kraj && state.listings.length) applyFilters();
    else refreshCards(() => true);
  }

  /** Přesun mapy na vybrané místo: do jeho kraje (načte inzeráty) a přiblížit; kraj = celý kraj. */
  function goToPlace(r) {
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const kraj = r.kraj && KRAJE[r.kraj] ? r.kraj : krajAtPoint(lat, lon);
    if (r.kind === 'kraj') {
      clearSearchPoint();
      if (kraj) navigate(kraj);
      return;
    }
    setSearchPoint({ lat, lon, label: r.label, sub: r.sub || '' }, !kraj || state.kraj === kraj);
    // adresa zblízka, obec s okolím (seznam „v zobrazené části mapy“ pak ukáže kola kolem)
    const zoom = Math.min(Number(r.zoom) || 13, r.kind === 'adresa' ? 14.5 : 13);
    if (!kraj) {
      whenMapIdle().then(() => map.setView([lat, lon], zoom));
      toast('Místo leží mimo Českou republiku – inzeráty tam Kolomapa nemá.');
      return;
    }
    if (state.kraj !== kraj) {
      state.pendingView = { center: [lat, lon], zoom };
      navigate(kraj);
      return;
    }
    if (state.selectedId != null) navigate(kraj, null);
    state.keepListUntil = 0;
    whenMapIdle().then(() => map.setView([lat, lon], zoom));
  }

  /** Souřadnice „49.195, 16.606“ (i s čárkou místo tečky ve tvaru „49,195 16,606“). */
  function parseCoords(q) {
    const m = /^\s*(-?\d{1,2}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/.exec(q);
    if (!m) return null;
    const lat = Number(m[1].replace(',', '.'));
    const lon = Number(m[2].replace(',', '.'));
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || !/[.,]/.test(m[1])) return null;
    return { label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, sub: 'souřadnice', lat, lon, kraj: null, kind: 'adresa', zoom: 14 };
  }

  /**
   * Vyhledávací pole nad mapou: při psaní našeptává obce, části obcí, kraje a PSČ (/api/places, bez internetu),
   * Enter nebo „Hledat adresu“ najde ulici a číslo (/api/geocode – OpenStreetMap). Klávesy: šipky, Enter, Esc.
   */
  function buildMapSearch() {
    if (state.mode !== 'server' || $('mapsearch')) return;
    const input = el('input', {
      class: 'mapsearch__input',
      id: 'mapsearch-input',
      type: 'search',
      placeholder: 'Hledat místo, adresu nebo PSČ…',
      'aria-label': 'Hledat místo na mapě (obec, adresa, PSČ)',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
      'aria-controls': 'mapsearch-list',
      autocomplete: 'off',
      spellcheck: 'false',
      enterkeyhint: 'search',
      maxlength: '120',
    });
    const clear = el('button', { type: 'button', class: 'mapsearch__clear', 'aria-label': 'Zrušit hledané místo', title: 'Zrušit hledané místo', hidden: true }, icon('close'));
    const list = el('ul', { class: 'mapsearch__list', id: 'mapsearch-list', role: 'listbox', 'aria-label': 'Nalezená místa', hidden: true });
    const box = el('div', { class: 'mapsearch', id: 'mapsearch', role: 'search' }, el('span', { class: 'mapsearch__ic' }, icon('search')), input, clear, list);
    document.querySelector('.mapwrap').append(box);

    let items = [];
    let itemsFor = null; // dotaz, ke kterému patří items (Enter před doběhnutím našeptávače)
    let active = -1;
    let seq = 0;
    let deb = null;
    let geocoderOn = true;
    let note = null; // řádek se stavem (hledám…, nic nenalezeno, chyba)
    let attribution = null;

    const open = () => {
      list.hidden = !items.length && !note;
      input.setAttribute('aria-expanded', String(!list.hidden));
    };
    const close = () => {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    };
    const syncClear = () => {
      clear.hidden = !input.value && !state.searchPoint;
    };
    const kindIcon = (it) => (it.kind === 'action' ? 'search' : it.kind === 'kraj' ? 'map' : 'pin');
    function render() {
      list.replaceChildren(
        ...items.map((it, i) => {
          const li = el(
            'li',
            { id: `mapsearch-opt-${i}`, role: 'option', class: `mapsearch__opt mapsearch__opt--${it.kind}`, 'aria-selected': String(i === active) },
            el('span', { class: 'mapsearch__oic' }, icon(kindIcon(it))),
            el('span', { class: 'mapsearch__otext' }, el('span', { class: 'mapsearch__olabel', text: it.label }), it.sub ? el('span', { class: 'mapsearch__osub', text: it.sub }) : null)
          );
          li.addEventListener('mousedown', (e) => e.preventDefault()); // fokus zůstane v poli
          li.addEventListener('click', () => choose(it));
          return li;
        }),
        ...(note ? [el('li', { class: 'mapsearch__note', role: 'presentation', text: note })] : []),
        ...(attribution ? [el('li', { class: 'mapsearch__attr', role: 'presentation', text: attribution })] : [])
      );
      if (active >= 0) input.setAttribute('aria-activedescendant', `mapsearch-opt-${active}`);
      else input.removeAttribute('aria-activedescendant');
      open();
    }
    const addressAction = (q) => (geocoderOn && q.trim().length >= 3 ? [{ kind: 'action', label: `Hledat adresu „${q.trim()}“`, sub: 'ulice a číslo – OpenStreetMap' }] : []);

    async function suggest() {
      const q = input.value.trim();
      const my = ++seq;
      attribution = null;
      note = null;
      active = -1;
      if (q.length < 2) {
        items = [];
        itemsFor = q;
        close();
        return;
      }
      const coords = parseCoords(q);
      if (coords) {
        items = [coords];
        itemsFor = q;
        render();
        return;
      }
      let res;
      try {
        res = await fetchJson(`api/places?q=${encodeURIComponent(q)}`, { cache: 'default' });
      } catch (e) {
        if (my !== seq) return;
        items = addressAction(q);
        note = `Hledání míst nefunguje: ${e.message}`;
        render();
        return;
      }
      if (my !== seq) return;
      geocoderOn = res.geocoder !== false;
      items = [...(Array.isArray(res.results) ? res.results : []), ...addressAction(q)];
      itemsFor = q;
      if (!items.length) note = 'Nic takového neznám – zkuste obec, část obce nebo PSČ.';
      render();
    }

    async function searchAddress(q) {
      const my = ++seq;
      items = [];
      note = 'Hledám adresu…';
      attribution = null;
      active = -1;
      render();
      let res;
      try {
        res = await fetchJson(`api/geocode?q=${encodeURIComponent(q)}`, { cache: 'default' });
      } catch (e) {
        if (my !== seq) return;
        note = e.message || 'Hledání adres teď nefunguje.';
        render();
        return;
      }
      if (my !== seq) return;
      items = Array.isArray(res.results) ? res.results : [];
      itemsFor = q;
      attribution = res.attribution || null;
      note = items.length ? null : 'Adresu se nepodařilo najít – zkuste přidat obec („Kounicova 10, Brno“), nebo hledejte obec či PSČ.';
      if (items.length === 1) return choose(items[0]);
      render();
    }

    function choose(it) {
      if (!it) return;
      if (it.kind === 'action') return searchAddress(input.value.trim());
      input.value = it.label;
      close();
      syncClear();
      goToPlace(it);
      if (isMobile()) input.blur();
    }

    input.addEventListener('input', () => {
      syncClear();
      clearTimeout(deb);
      deb = setTimeout(suggest, 150);
    });
    input.addEventListener('focus', () => {
      if (items.length || note) open();
    });
    input.addEventListener('blur', () => setTimeout(close, 120));
    input.addEventListener('keydown', async (e) => {
      const n = items.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!n) return;
        e.preventDefault();
        if (list.hidden) open();
        active = e.key === 'ArrowDown' ? (active + 1) % n : active <= 0 ? n - 1 : active - 1;
        render();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(deb);
        const q = input.value.trim();
        if (active >= 0 && items[active] && itemsFor === q) return choose(items[active]);
        if (q.length < 2) return;
        const coords = parseCoords(q);
        if (coords) return choose(coords);
        if (itemsFor !== q) await suggest(); // Enter dřív, než doběhl našeptávač
        if (input.value.trim() !== q) return;
        // přesná shoda obce / PSČ → tam; adresa (číslo domu, čárka) → vyhledávač adres; jinak první našeptaná obec
        const places = items.filter((it) => it.kind !== 'action');
        const exact = places.find((it) => fold(it.label).replace(/\s+/g, '') === fold(q).replace(/\s+/g, ''));
        if (exact) return choose(exact);
        if (geocoderOn && q.length >= 3 && (/\d|,/.test(q) || !places.length)) return searchAddress(q);
        if (places.length) return choose(places[0]);
      } else if (e.key === 'Escape') {
        if (!list.hidden) {
          e.preventDefault();
          close();
        } else if (input.value) {
          e.preventDefault();
          input.value = '';
          syncClear();
        }
      }
    });
    clear.addEventListener('click', () => {
      input.value = '';
      items = [];
      note = null;
      close();
      clearSearchPoint();
      syncClear();
      input.focus();
    });
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
    const pv = state.pendingView; // hledané místo: rovnou k němu, ne na celý kraj
    state.pendingView = null;
    if (pv) whenMapIdle().then(() => map.setView(pv.center, pv.zoom));
    else if (layer) fitTo(layer.getBounds(), isMobile() ? [12, 12] : [28, 28]);
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
    if (state.mode === 'server') {
      buildMapSearch();
      loadMarks();
      // po návratu do okna hned ukázat, co mezitím řešili kolegové
      window.addEventListener('focus', () => {
        if (Date.now() - (state.marksAt || 0) > 10000) loadMarks();
      });
    }
    if (!parseHash().kraj) renderOverview();
    await applyRoute();
    if (state.mode === 'server') {
      pollRun(false);
      loadMe();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
