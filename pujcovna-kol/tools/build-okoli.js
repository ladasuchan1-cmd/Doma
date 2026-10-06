'use strict';
// Sestavení výřezu okolí půjčovny: tenants/<slug>/okoli.json + tenants/<slug>/okoli/img/<qid>.jpg (SPEC kap. 12).
//   node --disable-warning=ExperimentalWarning tools/build-okoli.js --tenant demo [--force] [--offline] [--max-pois 20]
//
// Vstupy:
//   tenants/<slug>/tenant.json        location { lat, lon, radiusKm }
//   ../cyklo-ski-mapa/data/trasy.js   trasy z OpenStreetMap (ODbL) – přepsat proměnnou CSM_TRASY nebo --trasy <cesta>
//   Wikidata SPARQL (SERVICE wikibase:around; záložně query-main.wikidata.org a QLever), cs.wikipedia (extracts),
//   Wikimedia Commons (imageinfo + extmetadata; jen CC0 / CC BY / CC BY-SA), náhledy 800 px z upload.wikimedia.org
//   MAPY_API_KEY (volitelně) – převýšení tras z Mapy.cz Elevation API; bez klíče elevation: null
// Výstup: okoli.json { generatedAt, center, radiusKm, routes[], pois[] } (formát viz SPEC kap. 12) a ATTRIBUTION.md u obrázků.
// Síť: stažené odpovědi se cachují v cache/okoli/<slug>/ (není v gitu); --force cache ignoruje, --offline nic nestahuje.
// Za HTTPS proxy (HTTPS_PROXY) se použije tunel CONNECT; 429/503 se opakují podle Retry-After. Při selhání zdroje
// skript skončí s chybou a vysvětlením (data jsou součást dema a commitují se do gitu).
// Bez npm závislostí; funkce jsou exportované pro testy (require nespouští main()).

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const geo = require('../src/geo');

const ROOT = path.resolve(__dirname, '..');
const USER_AGENT = 'pujcovna-kol-build-okoli/0.1 (https://ksprehledy.cz; info@ksprehledy.cz) node';
const API_PAUSE_MS = 1500; // rozestup mezi volání Wikimedia API (šetrnost k limitům)
const MAX_ROUTE_POINTS = 400;
const CLIP_EXTRA_KM = 5;
const MIN_CLIPPED_KM = 0.3; // kratší výřez (trasa jen těsně míjí okruh) nemá pro návštěvníka smysl
// CC0 1.0, CC BY 4.0, CC BY-SA 3.0, včetně portovaných variant („CC BY-SA 3.0 de“); nic jiného (ani Public domain)
const ALLOWED_LICENSES = /^(CC0(\s*1\.0)?|CC BY(-SA)?(\s*\d\.\d(\s*[a-z]{2}(-[a-z]+)?)?)?)$/i;

// Typy zajímavostí: třída Wikidata → { key, label, weight }. Váha 1–5 vstupuje do skóre; cap omezuje počet v top 20.
const POI_CLASSES = {
  Q23413: { key: 'hrad', label: 'Hrad', weight: 5 },
  Q751876: { key: 'zamek', label: 'Zámek', weight: 5 },
  Q16560: { key: 'zamek', label: 'Palác', weight: 4 },
  Q109607: { key: 'zricenina', label: 'Zřícenina', weight: 4 },
  Q17715832: { key: 'zricenina', label: 'Zřícenina hradu', weight: 4 },
  Q44613: { key: 'klaster', label: 'Klášter', weight: 4 },
  Q33506: { key: 'muzeum', label: 'Muzeum', weight: 4 },
  Q207694: { key: 'muzeum', label: 'Muzeum umění', weight: 4 },
  Q1440300: { key: 'rozhledna', label: 'Rozhledna', weight: 5 },
  Q6017969: { key: 'vyhlidka', label: 'Vyhlídka', weight: 4 },
  Q12518: { key: 'vez', label: 'Věž', weight: 3 },
  Q16970: { key: 'kostel', label: 'Kostel', weight: 2 },
  Q2977: { key: 'kostel', label: 'Katedrála', weight: 3 },
  Q108325: { key: 'kaple', label: 'Kaple', weight: 1 },
  Q34627: { key: 'synagoga', label: 'Synagoga', weight: 3 },
  Q381885: { key: 'hrobka', label: 'Hrobka', weight: 4 },
  Q3253281: { key: 'rybnik', label: 'Rybník', weight: 3 },
  Q1265665: { key: 'rybnik', label: 'Rybník', weight: 3 },
  Q131681: { key: 'rybnik', label: 'Přehradní nádrž', weight: 2 },
  Q179049: { key: 'priroda', label: 'Přírodní rezervace', weight: 3 },
  Q473972: { key: 'priroda', label: 'Chráněné území', weight: 2 },
  Q22698: { key: 'priroda', label: 'Park', weight: 2 },
  Q8502: { key: 'priroda', label: 'Vrch', weight: 2 },
  Q35509: { key: 'priroda', label: 'Jeskyně', weight: 3 },
  Q174782: { key: 'namesti', label: 'Náměstí', weight: 3 },
  Q4989906: { key: 'pamatka', label: 'Pomník', weight: 1 },
  Q839954: { key: 'pamatka', label: 'Archeologická lokalita', weight: 2 },
  Q12280: { key: 'pamatka', label: 'Most', weight: 2 },
  Q570116: { key: 'atrakce', label: 'Turistická atrakce', weight: 3 },
};
const TYPE_CAPS = { rybnik: 5, kostel: 3, kaple: 1, priroda: 3, namesti: 2, pamatka: 1, vez: 3 };
const DEFAULT_TYPE_CAP = 4;

// ------------------------------------------------------------------------------------------------ pomocné
function log(...args) {
  process.stderr.write(`[build-okoli] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const out = { tenant: null, force: false, offline: false, maxPois: 20, trasy: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant') out.tenant = argv[++i];
    else if (a === '--force') out.force = true;
    else if (a === '--offline') out.offline = true;
    else if (a === '--max-pois') out.maxPois = Math.max(1, Number(argv[++i]) || 20);
    else if (a === '--trasy') out.trasy = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/** Odstraní HTML značky a zbytečné bílé znaky (Artist z Commons bývá HTML). */
function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Zkrátí text na max. 2 věty / ~320 znaků. */
function twoSentences(text, maxLen = 320) {
  let t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  const parts = t.match(/[^.!?]+[.!?]+(\s|$)/g);
  if (parts && parts.length) t = parts.slice(0, 2).join('').trim();
  if (t.length > maxLen) t = t.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
  return t;
}

function round(v, places = 5) {
  return geo.round(v, places);
}

// ------------------------------------------------------------------------------------------------- HTTP
function proxyFor(url) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) return null;
  const host = new URL(url).hostname;
  const noProxy = String(process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (noProxy.some((n) => n === '*' || host === n || host.endsWith(n.startsWith('.') ? n : `.${n}`))) return null;
  return proxy;
}

/** Otevře tunel CONNECT přes HTTP proxy a vrátí TLS socket k cílovému hostu. */
function tunnelSocket(proxyUrl, host, port) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const headers = { Host: `${host}:${port}` };
    if (p.username) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64');
    const req = http.request({ host: p.hostname, port: Number(p.port) || 80, method: 'CONNECT', path: `${host}:${port}`, headers });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT ${host}:${port} → ${res.statusCode}`));
        return;
      }
      const secure = tls.connect({ socket, servername: host });
      secure.once('secureConnect', () => resolve(secure));
      secure.once('error', reject);
    });
    req.once('error', reject);
    req.end();
  });
}

/**
 * HTTPS GET s podporou proxy a přesměrování. Vrací { status, headers, body (Buffer) }.
 */
async function httpGet(url, { headers = {}, timeoutMs = 90000, redirects = 4 } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error(`Jen https URL: ${url}`);
  const port = Number(u.port) || 443;
  const proxy = proxyFor(url);
  const socket = proxy ? await tunnelSocket(proxy, u.hostname, port) : null;
  const res = await new Promise((resolve, reject) => {
    const opts = {
      host: u.hostname,
      port,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity', ...headers },
      servername: u.hostname,
      timeout: timeoutMs,
    };
    if (socket) {
      opts.agent = false;
      opts.createConnection = () => socket;
    }
    const req = https.request(opts, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
      r.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout ${timeoutMs} ms: ${url}`)));
    req.on('error', reject);
    req.end();
  });
  if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location && redirects > 0) {
    return httpGet(new URL(res.headers.location, url).toString(), { headers, timeoutMs, redirects: redirects - 1 });
  }
  return res;
}

/** GET s opakováním při 429/5xx (Retry-After), max. 8 pokusů. */
async function fetchRetry(url, { headers = {}, attempts = 8, label = '' } = {}) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await httpGet(url, { headers });
      if (res.status === 429 || res.status === 503 || res.status === 502 || res.status === 504) {
        const ra = Number(res.headers['retry-after']);
        const wait = Math.min(180, Math.max(5, Number.isFinite(ra) && ra > 0 ? ra + 1 : 10 * i));
        log(`${label || url}: HTTP ${res.status}, čekám ${wait} s (pokus ${i}/${attempts})`);
        await sleep(wait * 1000);
        continue;
      }
      if (res.status >= 400) throw new Error(`HTTP ${res.status} pro ${url}: ${res.body.toString('utf8').slice(0, 200)}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (/^HTTP 4\d\d/.test(e.message)) throw e;
      log(`${label || url}: ${e.message} (pokus ${i}/${attempts})`);
      await sleep(Math.min(60, 5 * i) * 1000);
    }
  }
  throw lastErr || new Error(`Nepodařilo se stáhnout ${url}`);
}

// ------------------------------------------------------------------------------------------------ cache
function createCache(dir, { force = false, offline = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    /** Textová cache: vrátí uložený text, nebo zavolá loader a výsledek uloží. */
    async text(name, loader) {
      const file = path.join(dir, name);
      if (!force && fs.existsSync(file) && fs.statSync(file).size > 0) return fs.readFileSync(file, 'utf8');
      if (offline) throw new Error(`Offline režim a v cache chybí ${name}`);
      const text = await loader();
      fs.writeFileSync(file, text);
      return text;
    },
    async json(name, loader) {
      return JSON.parse(await this.text(name, loader));
    },
  };
}

// ------------------------------------------------------------------------------------------------ trasy
/** Načte ../cyklo-ski-mapa/data/trasy.js (odřízne `window.CSM_DATA.trasy = ` a `;`). */
function loadTrasy(file) {
  const src = fs.readFileSync(file, 'utf8');
  const marker = 'window.CSM_DATA.trasy = ';
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`${file}: nenalezeno „${marker}“`);
  const json = src
    .slice(at + marker.length)
    .trim()
    .replace(/;\s*$/, '');
  const data = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error(`${file}: očekáváno pole tras`);
  return data;
}

/** Protíná bbox [minLat, minLon, maxLat, maxLon] kruh o poloměru radiusKm kolem center { lat, lon }? */
function bboxIntersectsCircle(bbox, center, radiusKm) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return false;
  const lat = Math.max(bbox[0], Math.min(center.lat, bbox[2]));
  const lon = Math.max(bbox[1], Math.min(center.lon, bbox[3]));
  return geo.haversineM(center.lat, center.lon, lat, lon) / 1000 <= radiusKm;
}

/** Trasy, jejichž bbox protíná kruh. */
function selectRoutes(trasy, center, radiusKm) {
  return trasy.filter((t) => t && Array.isArray(t.geom) && bboxIntersectsCircle(t.bbox || bboxOfGeom(t.geom), center, radiusKm));
}

/** bbox [minLat, minLon, maxLat, maxLon] z geom [[ [lat,lon], … ], …]. */
function bboxOfGeom(geom) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const seg of geom) {
    for (const [lat, lon] of seg) {
      if (lat < b[0]) b[0] = lat;
      if (lon < b[1]) b[1] = lon;
      if (lat > b[2]) b[2] = lat;
      if (lon > b[3]) b[3] = lon;
    }
  }
  return b;
}

/** Ořízne geom na souvislé úseky bodů do maxKm od center (úseky s < 2 body se vynechají). */
function clipGeom(geom, center, maxKm) {
  const out = [];
  for (const seg of geom) {
    let run = [];
    for (const pt of seg) {
      const inside = geo.haversineM(center.lat, center.lon, pt[0], pt[1]) / 1000 <= maxKm;
      if (inside) run.push(pt);
      else {
        if (run.length >= 2) out.push(run);
        run = [];
      }
    }
    if (run.length >= 2) out.push(run);
  }
  return out;
}

function countPoints(geom) {
  return geom.reduce((n, s) => n + s.length, 0);
}

/** Délka geom [[ [lat,lon], … ], …] v km. */
function geomLengthKm(geom) {
  let km = 0;
  for (const seg of geom) km += geo.lineLengthKm(seg.map(([lat, lon]) => [lon, lat]));
  return km;
}

function ptKey(pt) {
  return `${round(pt[0])},${round(pt[1])}`;
}

/**
 * Spojí navazující úseky do souvislých linií (zdrojová data mají geom rozsekaný po OSM cestách, často 2 body na úsek).
 * Hladově řetězí úseky podle shodných koncových bodů, úsek se smí otočit.
 */
function mergeSegments(geom) {
  const segs = geom.filter((s) => Array.isArray(s) && s.length >= 2).map((s) => s.slice());
  const used = new Array(segs.length).fill(false);
  const byStart = new Map();
  const byEnd = new Map();
  segs.forEach((s, i) => {
    const ks = ptKey(s[0]);
    const ke = ptKey(s[s.length - 1]);
    if (!byStart.has(ks)) byStart.set(ks, []);
    byStart.get(ks).push(i);
    if (!byEnd.has(ke)) byEnd.set(ke, []);
    byEnd.get(ke).push(i);
  });
  const takeFrom = (map, key) => {
    const arr = map.get(key);
    if (!arr) return -1;
    while (arr.length) {
      const i = arr.shift();
      if (!used[i]) return i;
    }
    return -1;
  };
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let line = segs[i];
    // dopředu
    for (;;) {
      const end = ptKey(line[line.length - 1]);
      let j = takeFrom(byStart, end);
      let reversed = false;
      if (j < 0) {
        j = takeFrom(byEnd, end);
        reversed = true;
      }
      if (j < 0) break;
      used[j] = true;
      const add = reversed ? segs[j].slice().reverse() : segs[j];
      line = line.concat(add.slice(1));
    }
    // dozadu
    for (;;) {
      const start = ptKey(line[0]);
      let j = takeFrom(byEnd, start);
      let reversed = false;
      if (j < 0) {
        j = takeFrom(byStart, start);
        reversed = true;
      }
      if (j < 0) break;
      used[j] = true;
      const add = reversed ? segs[j].slice().reverse() : segs[j];
      line = add.slice(0, -1).concat(line);
    }
    out.push(line);
  }
  return out;
}

/** Zjednoduší geom (spojení úseků + Douglas–Peucker) tak, aby měl nejvýše maxPoints bodů; souřadnice zaokrouhlí na 5 míst. */
function simplifyGeom(geom, maxPoints = MAX_ROUTE_POINTS, startTolM = 25) {
  const merged = mergeSegments(geom);
  let tol = startTolM;
  let current = merged.map((seg) => seg.map(([lat, lon]) => [round(lat), round(lon)]));
  while (countPoints(current) > maxPoints && tol < 5000) {
    current = merged
      .map((seg) => geo.simplify(seg.map(([lat, lon]) => [lon, lat]), tol).map(([lon, lat]) => [round(lat), round(lon)]))
      .filter((seg) => seg.length >= 2);
    tol *= 1.6;
  }
  // stále moc bodů (mnoho krátkých nenavazujících úseků) → vynechat nejkratší úseky
  if (countPoints(current) > maxPoints) {
    current.sort((a, b) => geo.lineLengthKm(b.map(([lat, lon]) => [lon, lat])) - geo.lineLengthKm(a.map(([lat, lon]) => [lon, lat])));
    const kept = [];
    let n = 0;
    for (const seg of current) {
      if (n + seg.length > maxPoints) break;
      kept.push(seg);
      n += seg.length;
    }
    current = kept;
  }
  return current;
}

/** Síť trasy pro vrstvy a filtr: mtb | cyklostezka | icn | ncn | rcn | lcn (fallback podle počtu číslic v ref). */
function networkOf(t) {
  if (t.druh === 'mtb') return 'mtb';
  if (t.druh === 'cyklostezka') return 'cyklostezka';
  if (['icn', 'ncn', 'rcn', 'lcn'].includes(t.sit)) return t.sit;
  const ref = String(t.ref || '').trim();
  if (/^\d{1,3}$/.test(ref)) return 'ncn';
  if (/^\d{4}$/.test(ref)) return 'rcn';
  return 'lcn';
}

/** Záznam trasy do okoli.json. */
function routeRecord(t, center, radiusKm) {
  const clipped = clipGeom(t.geom, center, radiusKm + CLIP_EXTRA_KM);
  if (!clipped.length) return null;
  const clippedKm = geomLengthKm(clipped);
  if (clippedKm < MIN_CLIPPED_KM) return null;
  const geom = simplifyGeom(clipped);
  return {
    id: t.id,
    nazev: t.nazev || t.label || (t.ref ? `Cyklotrasa ${t.ref}` : 'Trasa'),
    ref: t.ref || null,
    sit: t.sit || null,
    net: networkOf(t),
    druh: t.druh,
    delkaKm: Math.round(clippedKm * 10) / 10,
    delkaCelkemKm: typeof t.delkaKm === 'number' ? t.delkaKm : Math.round(geomLengthKm(t.geom) * 10) / 10,
    osm: t.osm || null,
    geom,
    bbox: bboxOfGeom(geom).map((v) => round(v, 4)),
    elevation: null,
  };
}

/** Mřížkový index úseček tras (pro blízkost zajímavostí k trase). */
function buildGrid(routes) {
  const grid = new geo.SegmentGrid(0.02);
  for (const r of routes) for (const seg of r.geom) grid.addLine(seg.map(([lat, lon]) => [lon, lat]), r.id);
  return grid;
}

// ------------------------------------------------------------------------------------------- Wikidata
const WIKIDATA_ENDPOINTS = [
  { url: 'https://query.wikidata.org/sparql', kind: 'wdqs' },
  { url: 'https://query-main.wikidata.org/sparql', kind: 'wdqs' },
  { url: 'https://qlever.cs.uni-freiburg.de/api/wikidata', kind: 'qlever' },
];

function sparqlQuery(kind, center, radiusKm) {
  const classes = Object.keys(POI_CLASSES)
    .map((q) => `wd:${q}`)
    .join(' ');
  if (kind === 'wdqs') {
    return `SELECT ?item ?itemLabel ?class ?loc ?image ?article ?sitelinks WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?loc .
    bd:serviceParam wikibase:center "Point(${center.lon} ${center.lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm}" .
  }
  VALUES ?class { ${classes} }
  ?item wdt:P31 ?class .
  OPTIONAL { ?item wdt:P18 ?image }
  OPTIONAL { ?item wikibase:sitelinks ?sitelinks }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://cs.wikipedia.org/> . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "cs,en". }
}`;
  }
  // QLever: bez SERVICE wikibase:around – obdélník přes geof:latitude/longitude, kruh se dořeže lokálně
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.cos((center.lat * Math.PI) / 180));
  return `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX schema: <http://schema.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX geof: <http://www.opengis.net/def/function/geosparql/>
SELECT ?item ?itemLabel ?class ?loc ?image ?article ?sitelinks WHERE {
  VALUES ?class { ${classes} }
  ?item wdt:P31 ?class .
  ?item wdt:P625 ?loc .
  FILTER(geof:latitude(?loc) > ${center.lat - dLat} && geof:latitude(?loc) < ${center.lat + dLat} && geof:longitude(?loc) > ${center.lon - dLon} && geof:longitude(?loc) < ${center.lon + dLon})
  OPTIONAL { ?item wdt:P18 ?image }
  OPTIONAL { ?item wikibase:sitelinks ?sitelinks }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://cs.wikipedia.org/> . }
  OPTIONAL { ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel) = "cs") }
}`;
}

/** Stáhne kandidáty z Wikidat; zkouší endpointy postupně, vrací { endpoint, bindings }. */
async function fetchWikidata(center, radiusKm) {
  const errors = [];
  for (const ep of WIKIDATA_ENDPOINTS) {
    try {
      const q = sparqlQuery(ep.kind, center, radiusKm);
      const url = `${ep.url}?format=json&query=${encodeURIComponent(q)}`;
      log(`Wikidata: ${ep.url}`);
      const res = await fetchRetry(url, { headers: { Accept: 'application/sparql-results+json' }, attempts: 3, label: ep.url });
      const text = res.body.toString('utf8');
      const data = JSON.parse(text);
      if (!data.results || !Array.isArray(data.results.bindings)) throw new Error('neočekávaný formát odpovědi');
      return { endpoint: ep.url, text };
    } catch (e) {
      errors.push(`${ep.url}: ${e.message}`);
      log(`Wikidata selhalo: ${e.message}`);
    }
  }
  throw new Error(`Wikidata nedostupná ze všech endpointů:\n  ${errors.join('\n  ')}`);
}

function parseWktPoint(wkt) {
  const m = /Point\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i.exec(String(wkt || ''));
  return m ? { lon: Number(m[1]), lat: Number(m[2]) } : null;
}

function qidOf(iri) {
  const m = /(Q\d+)$/.exec(String(iri || ''));
  return m ? m[1] : null;
}

/** Název souboru Commons z hodnoty P18 (Special:FilePath/…). */
function commonsFileTitle(imageIri) {
  const s = String(imageIri || '');
  const at = s.indexOf('Special:FilePath/');
  let name = at >= 0 ? s.slice(at + 'Special:FilePath/'.length) : s.split('/').pop();
  try {
    name = decodeURIComponent(name);
  } catch {
    /* ponechat */
  }
  name = name.replace(/_/g, ' ').trim();
  return name ? `File:${name}` : null;
}

/** Název článku z URL cs.wikipedia. */
function wikiTitleFromUrl(url) {
  const m = /\/wiki\/(.+)$/.exec(String(url || ''));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).replace(/_/g, ' ');
  } catch {
    return m[1].replace(/_/g, ' ');
  }
}

/** Seskupí SPARQL řádky podle položky a určí typ (třída s nejvyšší váhou). */
function groupCandidates(bindings, center, radiusKm) {
  const items = new Map();
  for (const r of bindings) {
    const id = qidOf(r.item && r.item.value);
    if (!id) continue;
    let it = items.get(id);
    if (!it) {
      const loc = parseWktPoint(r.loc && r.loc.value);
      if (!loc) continue;
      it = { id, name: r.itemLabel ? r.itemLabel.value : id, lat: loc.lat, lon: loc.lon, classes: new Set(), image: null, article: null, sitelinks: 0 };
      items.set(id, it);
    }
    const cls = qidOf(r.class && r.class.value);
    if (cls) it.classes.add(cls);
    if (r.image && r.image.value) it.image = r.image.value;
    if (r.article && r.article.value) it.article = r.article.value;
    if (r.sitelinks && r.sitelinks.value) it.sitelinks = Math.max(it.sitelinks, Number(r.sitelinks.value) || 0);
    if (r.itemLabel && r.itemLabel.value && !/^Q\d+$/.test(r.itemLabel.value)) it.name = r.itemLabel.value;
  }
  const out = [];
  for (const it of items.values()) {
    const distanceKm = geo.haversineM(center.lat, center.lon, it.lat, it.lon) / 1000;
    if (distanceKm > radiusKm) continue;
    let best = null;
    for (const c of it.classes) {
      const def = POI_CLASSES[c];
      if (def && (!best || def.weight > best.weight)) best = def;
    }
    if (!best) continue;
    out.push({
      id: it.id,
      name: it.name,
      lat: round(it.lat),
      lon: round(it.lon),
      distanceKm: Math.round(distanceKm * 10) / 10,
      typeKey: best.key,
      type: best.label,
      typeWeight: best.weight,
      classes: [...it.classes],
      imageTitle: commonsFileTitle(it.image),
      wikipediaUrl: it.article,
      wikipediaTitle: wikiTitleFromUrl(it.article),
      sitelinks: it.sitelinks,
    });
  }
  return out;
}

/**
 * Skóre zajímavosti: typ (váha ×2) + cs článek (+3) + obrázek (+3) + blízkost k půjčovně (0–4) + blízkost k trase
 * (≤ 300 m +2, ≤ 1 km +1) + známost podle počtu sitelinks (0–2).
 */
function scorePoi(poi, { radiusKm, nearRouteM }) {
  let s = (poi.typeWeight || 1) * 2;
  if (poi.wikipediaUrl) s += 3;
  if (poi.imageTitle) s += 3;
  const d = Math.min(Math.max(poi.distanceKm || 0, 0), radiusKm);
  s += 4 * (1 - d / radiusKm);
  if (nearRouteM !== null && nearRouteM !== undefined) {
    if (nearRouteM <= 300) s += 2;
    else if (nearRouteM <= 1000) s += 1;
  }
  s += Math.min(10, poi.sitelinks || 0) / 5;
  return Math.round(s * 100) / 100;
}

/** Výběr top N s omezením počtu na typ (rozmanitost); kandidáti už seřazení podle skóre. */
function pickDiverse(sorted, n, caps = TYPE_CAPS) {
  const out = [];
  const perType = {};
  for (const p of sorted) {
    if (out.length >= n) break;
    const cap = caps[p.typeKey] ?? DEFAULT_TYPE_CAP;
    if ((perType[p.typeKey] || 0) >= cap) continue;
    perType[p.typeKey] = (perType[p.typeKey] || 0) + 1;
    out.push(p);
  }
  if (out.length < n) for (const p of sorted) if (out.length < n && !out.includes(p)) out.push(p);
  return out;
}

// ---------------------------------------------------------------------------------- Wikipedia / Commons
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Úvodní 2 věty článků cs.wikipedia; vrací Map(title → text). */
async function fetchExtracts(titles, cache) {
  const out = new Map();
  const batches = chunk(titles, 20);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const key = `extracts-${hashKey(batch.join('|'))}.json`;
    const data = await cache.json(key, async () => {
      const url = `https://cs.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&prop=extracts&exintro=1&explaintext=1&exsentences=2&exlimit=20&redirects=1&titles=${encodeURIComponent(batch.join('|'))}`;
      const res = await fetchRetry(url, { label: `cs.wikipedia extracts ${i + 1}/${batches.length}` });
      await sleep(API_PAUSE_MS);
      return res.body.toString('utf8');
    });
    const q = (data && data.query) || {};
    const alias = new Map();
    for (const n of q.normalized || []) alias.set(n.to, n.from);
    for (const r of q.redirects || []) alias.set(r.to, alias.get(r.from) || r.from);
    for (const p of q.pages || []) {
      if (!p.extract) continue;
      const original = alias.get(p.title) || p.title;
      out.set(original, p.extract);
      out.set(p.title, p.extract);
    }
  }
  return out;
}

/** Metadata obrázků z Commons; vrací Map(File:… → { thumbUrl, url, descriptionUrl, mime, author, license, licenseUrl, width, height }). */
async function fetchImageInfo(fileTitles, cache) {
  const out = new Map();
  const batches = chunk(fileTitles, 50);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const key = `imageinfo-${hashKey(batch.join('|'))}.json`;
    const data = await cache.json(key, async () => {
      const params = new URLSearchParams({
        action: 'query',
        format: 'json',
        formatversion: '2',
        prop: 'imageinfo',
        iiprop: 'extmetadata|url|mime|size',
        iiurlwidth: '800',
        iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|Credit|AttributionRequired',
        titles: batch.join('|'),
      });
      const res = await fetchRetry(`https://commons.wikimedia.org/w/api.php?${params}`, { label: `Commons imageinfo ${i + 1}/${batches.length}` });
      await sleep(API_PAUSE_MS);
      return res.body.toString('utf8');
    });
    const q = (data && data.query) || {};
    const alias = new Map();
    for (const n of q.normalized || []) alias.set(n.to, n.from);
    for (const p of q.pages || []) {
      const ii = p.imageinfo && p.imageinfo[0];
      if (!ii) continue;
      const m = ii.extmetadata || {};
      const info = {
        title: p.title,
        thumbUrl: ii.thumburl || null,
        url: ii.url || null,
        descriptionUrl: ii.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
        mime: ii.mime || null,
        width: ii.thumbwidth || null,
        height: ii.thumbheight || null,
        author: stripHtml(m.Artist && m.Artist.value).slice(0, 120) || null,
        license: stripHtml(m.LicenseShortName && m.LicenseShortName.value) || null,
        licenseUrl: (m.LicenseUrl && m.LicenseUrl.value) || null,
      };
      out.set(p.title, info);
      const original = alias.get(p.title);
      if (original) out.set(original, info);
    }
  }
  return out;
}

function hashKey(s) {
  // krátký stabilní klíč pro název cache souboru (FNV-1a 32 bit)
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Je licence obrázku povolená (CC0 / CC BY / CC BY-SA)? */
function licenseAllowed(license) {
  return ALLOWED_LICENSES.test(String(license || '').trim());
}

function licenseUrlFor(license, fallback) {
  if (fallback) return fallback;
  const l = String(license || '').toUpperCase();
  if (/^CC0/.test(l)) return 'https://creativecommons.org/publicdomain/zero/1.0/';
  const m = /^CC (BY(?:-SA)?)\s*(\d\.\d)?/.exec(l);
  if (m) return `https://creativecommons.org/licenses/${m[1].toLowerCase()}/${m[2] || '4.0'}/`;
  return null;
}

/** Stáhne náhled 800 px do souboru (jen image/jpeg). Vrací true při úspěchu. */
async function downloadThumb(info, file, { force = false, offline = false } = {}) {
  if (!force && fs.existsSync(file) && fs.statSync(file).size > 1000) return true;
  if (offline) return false;
  if (!info.thumbUrl) return false;
  const res = await fetchRetry(info.thumbUrl, { label: `náhled ${info.title}`, attempts: 4 });
  const type = String(res.headers['content-type'] || '');
  if (!/image\/jpeg/.test(type) || res.body.length < 1000) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, res.body);
  await sleep(400);
  return true;
}

// ---------------------------------------------------------------------------------------- převýšení
/** Vzorkování bodů podél geom každých ~stepM metrů (vrací [[lat,lon], …]). */
function sampleAlong(geom, stepM = 50, maxPoints = 1200) {
  const out = [];
  for (const seg of geom) {
    let carry = 0;
    out.push(seg[0]);
    for (let i = 1; i < seg.length; i++) {
      const [lat1, lon1] = seg[i - 1];
      const [lat2, lon2] = seg[i];
      const d = geo.haversineM(lat1, lon1, lat2, lon2);
      let pos = stepM - carry;
      while (pos < d) {
        const f = pos / d;
        out.push([lat1 + (lat2 - lat1) * f, lon1 + (lon2 - lon1) * f]);
        pos += stepM;
      }
      carry = d - (pos - stepM);
    }
    out.push(seg[seg.length - 1]);
  }
  if (out.length > maxPoints) {
    const step = out.length / maxPoints;
    const reduced = [];
    for (let i = 0; i < maxPoints; i++) reduced.push(out[Math.floor(i * step)]);
    return reduced;
  }
  return out;
}

/** Převýšení z řady výšek: medián 3 a prahová hystereze 5 m. */
function elevationStats(heights) {
  const hs = heights.filter((h) => Number.isFinite(h));
  if (hs.length < 2) return null;
  const smooth = hs.map((h, i) => {
    const a = hs[Math.max(0, i - 1)];
    const b = hs[Math.min(hs.length - 1, i + 1)];
    return [a, h, b].sort((x, y) => x - y)[1];
  });
  let up = 0;
  let down = 0;
  let ref = smooth[0];
  for (const h of smooth) {
    const diff = h - ref;
    if (diff >= 5) {
      up += diff;
      ref = h;
    } else if (diff <= -5) {
      down += -diff;
      ref = h;
    }
  }
  return { up: Math.round(up), down: Math.round(down), min: Math.round(Math.min(...smooth)), max: Math.round(Math.max(...smooth)), samples: hs.length };
}

/** Převýšení trasy přes Mapy.cz Elevation API (max. 256 bodů na dotaz). */
async function elevationFor(route, apiKey, cache) {
  const samples = sampleAlong(route.geom);
  const heights = [];
  const batches = chunk(samples, 256);
  for (let i = 0; i < batches.length; i++) {
    const positions = batches[i].map(([lat, lon]) => `${round(lon)},${round(lat)}`).join(';');
    const key = `elevation-${route.id}-${i}.json`;
    const data = await cache.json(key, async () => {
      const url = `https://api.mapy.com/v1/elevation?lang=cs&positions=${encodeURIComponent(positions)}`;
      const res = await fetchRetry(url, { headers: { 'X-Mapy-Api-Key': apiKey, Accept: 'application/json' }, attempts: 3, label: `elevation ${route.id}` });
      return res.body.toString('utf8');
    });
    for (const it of data.items || []) heights.push(Number(it.elevation));
  }
  return elevationStats(heights);
}

// ------------------------------------------------------------------------------------------------ hlavní
function tenantPaths(slug) {
  const tenantsDir = process.env.PK_TENANTS ? path.resolve(ROOT, process.env.PK_TENANTS) : path.join(ROOT, 'tenants');
  const dir = path.join(tenantsDir, slug);
  return { dir, file: path.join(dir, 'tenant.json'), out: path.join(dir, 'okoli.json'), imgDir: path.join(dir, 'okoli', 'img') };
}

function attributionMarkdown(pois, generatedAt) {
  const lines = [
    '# Attribution obrázků zajímavostí (okolí)',
    '',
    `Vygenerováno \`tools/build-okoli.js\` ${generatedAt}. Náhledy 800 px z Wikimedia Commons, jen licence CC0 / CC BY / CC BY-SA.`,
    'Texty: úvod článků cs.wikipedia.org (CC BY-SA 4.0), data: Wikidata (CC0).',
    '',
    '| Soubor | Zajímavost | Autor | Licence | Zdroj |',
    '|---|---|---|---|---|',
  ];
  for (const p of pois) {
    if (!p.image) continue;
    lines.push(`| ${p.image.file} | ${p.name} (${p.id}) | ${p.image.author || '–'} | [${p.image.license}](${p.image.licenseUrl || ''}) | ${p.image.sourceUrl} |`);
  }
  return lines.join('\n') + '\n';
}

async function build(opts) {
  const slug = opts.tenant;
  const paths = tenantPaths(slug);
  if (!fs.existsSync(paths.file)) throw new Error(`Tenant „${slug}“ nenalezen (${paths.file}).`);
  const tenant = JSON.parse(fs.readFileSync(paths.file, 'utf8'));
  const loc = tenant.location || {};
  const center = { lat: Number(loc.lat), lon: Number(loc.lon) };
  const radiusKm = Number(loc.radiusKm) || 25;
  if (!Number.isFinite(center.lat) || !Number.isFinite(center.lon)) throw new Error(`${paths.file}: chybí location.lat/lon`);
  const cache = createCache(path.join(ROOT, 'cache', 'okoli', slug), { force: opts.force, offline: opts.offline });
  const trasyFile = opts.trasy || process.env.CSM_TRASY || path.resolve(ROOT, '..', 'cyklo-ski-mapa', 'data', 'trasy.js');

  // 1) trasy
  if (!fs.existsSync(trasyFile)) throw new Error(`Soubor s trasami nenalezen: ${trasyFile} (nastavte CSM_TRASY nebo --trasy).`);
  log(`Trasy: ${trasyFile}`);
  const trasy = loadTrasy(trasyFile);
  const selected = selectRoutes(trasy, center, radiusKm);
  const routes = selected
    .map((t) => routeRecord(t, center, radiusKm))
    .filter(Boolean)
    .sort((a, b) => a.nazev.localeCompare(b.nazev, 'cs'));
  log(`Tras celkem ${trasy.length}, v okruhu ${radiusKm} km: ${routes.length}, bodů ${countPoints(routes.flatMap((r) => r.geom))}`);
  const grid = buildGrid(routes);

  // 2) zajímavosti – Wikidata
  const wd = await cache.json('wikidata.json', async () => (await fetchWikidata(center, radiusKm)).text);
  const candidates = groupCandidates(wd.results.bindings, center, radiusKm);
  log(`Wikidata: ${wd.results.bindings.length} řádků, ${candidates.length} kandidátů v kruhu`);
  for (const c of candidates) {
    const near = grid.nearest(c.lon, c.lat, 2000);
    c.nearRouteM = near ? Math.round(near.dist) : null;
    c.nearRouteId = near ? near.ref : null;
    c.score = scorePoi(c, { radiusKm, nearRouteM: c.nearRouteM });
  }
  const pool = candidates.filter((c) => c.wikipediaUrl && c.imageTitle && c.wikipediaTitle).sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm);
  const shortlist = pickDiverse(pool, Math.min(pool.length, opts.maxPois * 4), Object.fromEntries(Object.entries(TYPE_CAPS).map(([k, v]) => [k, v * 2])));
  log(`Kandidátů s článkem a obrázkem: ${pool.length}, do užšího výběru: ${shortlist.length}`);

  // 3) texty a licence
  const extracts = await fetchExtracts(shortlist.map((c) => c.wikipediaTitle), cache);
  const images = await fetchImageInfo(shortlist.map((c) => c.imageTitle), cache);
  const ready = [];
  for (const c of shortlist) {
    const summary = twoSentences(extracts.get(c.wikipediaTitle));
    const info = images.get(c.imageTitle);
    if (!summary || summary.length < 40) {
      log(`vynecháno ${c.id} ${c.name}: chybí úvod článku`);
      continue;
    }
    if (!info || !info.thumbUrl) {
      log(`vynecháno ${c.id} ${c.name}: obrázek bez metadat`);
      continue;
    }
    if (!licenseAllowed(info.license)) {
      log(`vynecháno ${c.id} ${c.name}: licence „${info.license}“ není CC0/CC BY/CC BY-SA`);
      continue;
    }
    if (info.mime && info.mime !== 'image/jpeg') {
      log(`vynecháno ${c.id} ${c.name}: obrázek ${info.mime} (bereme jen JPEG)`);
      continue;
    }
    ready.push({ ...c, summary, imageInfo: info });
  }

  // 4) top N s rozmanitostí + stažení náhledů (při selhání stažení bereme dalšího kandidáta)
  const ordered = pickDiverse(ready, ready.length);
  const pois = [];
  fs.mkdirSync(paths.imgDir, { recursive: true });
  for (const c of ordered) {
    if (pois.length >= opts.maxPois) break;
    const file = `${c.id}.jpg`;
    let ok = false;
    try {
      ok = await downloadThumb(c.imageInfo, path.join(paths.imgDir, file), opts);
    } catch (e) {
      log(`stažení ${c.imageInfo.title} selhalo: ${e.message}`);
    }
    if (!ok) continue;
    pois.push({
      id: c.id,
      name: c.name,
      type: c.type,
      typeKey: c.typeKey,
      lat: c.lat,
      lon: c.lon,
      distanceKm: c.distanceKm,
      nearRouteM: c.nearRouteM,
      nearRouteId: c.nearRouteId,
      score: c.score,
      summary: c.summary,
      wikipediaUrl: c.wikipediaUrl,
      wikidataUrl: `https://www.wikidata.org/wiki/${c.id}`,
      image: {
        file,
        title: c.imageInfo.title,
        author: c.imageInfo.author || 'neznámý autor',
        license: c.imageInfo.license,
        licenseUrl: licenseUrlFor(c.imageInfo.license, c.imageInfo.licenseUrl),
        sourceUrl: c.imageInfo.descriptionUrl,
        width: c.imageInfo.width,
        height: c.imageInfo.height,
      },
    });
  }
  pois.sort((a, b) => a.distanceKm - b.distanceKm || a.name.localeCompare(b.name, 'cs'));
  if (pois.length < opts.maxPois) log(`Upozornění: jen ${pois.length} zajímavostí splnilo podmínky (cíl ${opts.maxPois}).`);

  // úklid obrázků, které už nejsou v seznamu
  const keep = new Set(pois.map((p) => p.image.file));
  for (const f of fs.readdirSync(paths.imgDir)) if (/^Q\d+\.jpg$/.test(f) && !keep.has(f)) fs.unlinkSync(path.join(paths.imgDir, f));

  // 5) převýšení (jen s klíčem)
  const apiKey = process.env.MAPY_API_KEY;
  let elevationSource = null;
  if (apiKey && !opts.offline) {
    elevationSource = 'Mapy.cz Elevation API';
    for (const r of routes) {
      try {
        r.elevation = await elevationFor(r, apiKey, cache);
      } catch (e) {
        log(`převýšení ${r.id} selhalo: ${e.message}`);
      }
    }
  } else log('MAPY_API_KEY není nastaven – převýšení tras zůstává null.');

  const generatedAt = new Date().toISOString();
  const out = {
    generatedAt,
    tenant: slug,
    center,
    radiusKm,
    sources: {
      routes: 'OpenStreetMap (ODbL) – výřez z cyklo-ski-mapa/data/trasy.js',
      pois: 'Wikidata (CC0), cs.wikipedia.org – úvody článků (CC BY-SA 4.0), Wikimedia Commons – obrázky s uvedenou licencí',
      elevation: elevationSource,
    },
    routes,
    pois,
  };
  fs.mkdirSync(path.dirname(paths.out), { recursive: true });
  fs.writeFileSync(paths.out, JSON.stringify(out) + '\n');
  fs.writeFileSync(path.join(paths.imgDir, 'ATTRIBUTION.md'), attributionMarkdown(pois, generatedAt));
  log(`Hotovo: ${paths.out} (${(fs.statSync(paths.out).size / 1024).toFixed(0)} kB), tras ${routes.length}, zajímavostí ${pois.length}`);
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.tenant) {
    process.stdout.write('Použití: node tools/build-okoli.js --tenant <slug> [--force] [--offline] [--max-pois 20] [--trasy cesta/trasy.js]\n');
    process.exitCode = opts.help ? 0 : 2;
    return;
  }
  try {
    await build(opts);
  } catch (e) {
    log(`CHYBA: ${e.message}`);
    log('Data okolí se nepodařilo sestavit. Zkontrolujte síť (Wikidata, cs.wikipedia, commons.wikimedia.org, upload.wikimedia.org), případně spusťte znovu – odpovědi jsou v cache/okoli/.');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  POI_CLASSES,
  TYPE_CAPS,
  ALLOWED_LICENSES,
  parseArgs,
  stripHtml,
  twoSentences,
  loadTrasy,
  bboxIntersectsCircle,
  selectRoutes,
  bboxOfGeom,
  clipGeom,
  countPoints,
  geomLengthKm,
  mergeSegments,
  simplifyGeom,
  networkOf,
  routeRecord,
  buildGrid,
  sparqlQuery,
  parseWktPoint,
  commonsFileTitle,
  wikiTitleFromUrl,
  groupCandidates,
  scorePoi,
  pickDiverse,
  licenseAllowed,
  licenseUrlFor,
  sampleAlong,
  elevationStats,
  attributionMarkdown,
  httpGet,
  fetchRetry,
  build,
};
