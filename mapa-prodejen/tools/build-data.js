#!/usr/bin/env node
'use strict';
// Sestavení dat mapy prodejen a servisů kol:
//   1. hranice krajů a okresů (ČÚZK RÚIAN),
//   2. prodejny, servisy a půjčovny kol z OpenStreetMap (Overpass, po částech),
//   3. firmy z ARES, které mají kola v obchodním jméně (cyklo, bike, kola, velo …),
//   4. weby prodejen: e-maily, telefony, IČO, služby (servis, e-kola, půjčovna, bazar, e-shop), značky,
//   5. IČO → ARES + RES (kategorie počtu zaměstnanců od ČSÚ) → velikost firmy,
//   6. firmy z ARES bez prodejny v OSM → místo v sídle (souřadnice adresního místa RÚIAN),
//   7. PSČ (GeoNames) přiřazená k obcím podle hranic obcí RÚIAN – pro objednávky podle obcí.
// Výstup: data/hranice.js, mista.js, firmy.js, weby.js, psc.js, obce.js, meta.js (window.MP_DATA.<název>).
//
//   node tools/build-data.js                  # použije cache/, chybějící zdroje stáhne, weby projde (hotové přeskočí)
//   node tools/build-data.js --fetch          # vše stáhne znovu (OSM, ARES, hranice, PSČ) a weby projde znovu
//   node tools/build-data.js --bez-webu       # bez průchodu webů (použije, co je v cache)
//   node tools/build-data.js --web-limit 50   # projde jen 50 dosud neprojitých webů
//
// Bez závislostí (Node 22+). Slušnost k webům: 1 požadavek najednou na doménu, celkem MP_CONCURRENCY (8).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const geo = require('../lib/geo.js');
const contacts = require('../lib/contacts.js');
const velikost = require('../lib/velikost.js');
const xlsx = require('../lib/xlsx.js');
const ares = require('../lib/ares.js');
const src = require('./lib/sources.js');
const { writeDataset } = require('./lib/data-io.js');

const args = parseArgs(process.argv.slice(2));
const ROOT = path.join(__dirname, '..');
const CACHE = path.resolve(args.cache || process.env.MP_CACHE || path.join(ROOT, 'cache'));
const OUT = path.resolve(args.out || path.join(ROOT, 'data'));
const FORCE = Boolean(args.fetch);
const ARES_MAX_DNI = Number(args.aresDni || 30);
const WEB_MAX_DNI = FORCE ? 0 : Number(args.webDni || 45);
const CONCURRENCY = Number(process.env.MP_CONCURRENCY || args.concurrency || 8);
const TOL_BOUNDARY_M = 60;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fetch') out.fetch = true;
    else if (a === '--bez-webu') out.bezWebu = true;
    else if (a === '--web-limit') out.webLimit = Number(argv[++i]);
    else if (a === '--web-dni') out.webDni = Number(argv[++i]);
    else if (a === '--ares-dni') out.aresDni = Number(argv[++i]);
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--cache') out.cache = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('node tools/build-data.js [--fetch] [--bez-webu] [--web-limit N] [--web-dni N] [--ares-dni N] [--concurrency N] [--cache DIR] [--out DIR]');
      process.exit(0);
    }
  }
  return out;
}

function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

// ------------------------------------------------------------------ cache
function cachePath(name) {
  return path.join(CACHE, name);
}

async function cached(name, loader, opts) {
  const file = cachePath(name);
  const maxAgeMs = opts && opts.maxAgeDays != null ? opts.maxAgeDays * 86400000 : Infinity;
  if (!FORCE && fs.existsSync(file) && fs.statSync(file).size > 0 && Date.now() - fs.statSync(file).mtimeMs < maxAgeMs) return fs.readFileSync(file);
  log('stahuji', name);
  const data = await loader();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return Buffer.isBuffer(data) ? data : Buffer.from(String(data));
}

function readJsonCache(name) {
  try {
    return JSON.parse(fs.readFileSync(cachePath(name), 'utf8'));
  } catch (_e) {
    return null;
  }
}

function writeJsonCache(name, value) {
  const file = cachePath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

// ------------------------------------------------------- pomocné funkce
function clean(s) {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t ? t : null;
}

function uniq(arr) {
  return [...new Set(arr.filter((x) => x != null && x !== ''))];
}

function fold(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Název firmy/prodejny na porovnatelná slova: bez právní formy, diakritiky a výplňových slov.
const STOP = new Set(['s', 'r', 'o', 'sro', 'spol', 'a', 'as', 'k', 'v', 'z', 'zs', 'ops', 'se', 'cz', 'eu', 'com', 'www', 'the', 'and', 'a', 'shop', 'eshop', 'prodejna', 'servis', 'sport', 'sports', 'cyklo', 'bike', 'bikes', 'kola', 'kolo', 'centrum', 'center', 'praha', 'brno']);
function nameTokens(s) {
  return fold(String(s || '').replace(/\b(s\.\s?r\.\s?o\.|spol\.\s?s\s?r\.\s?o\.|a\.\s?s\.|v\.\s?o\.\s?s\.|k\.\s?s\.|z\.\s?s\.)/gi, ' '))
    .split(' ')
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

function nameSim(a, b) {
  const A = new Set(nameTokens(a));
  const B = new Set(nameTokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

const OSM_PREFIX = { node: 'n', way: 'w', relation: 'r' };

// ------------------------------------------------------------- hranice
function simplifyGeometry(geometry, tolM) {
  const simp = (ring) => {
    const s = geo.simplify(ring, tolM);
    return s.length >= 4 ? s : ring;
  };
  if (geometry.type === 'Polygon') return { type: 'Polygon', coordinates: geometry.coordinates.map(simp) };
  if (geometry.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: geometry.coordinates.map((poly) => poly.map(simp)) };
  return geometry;
}

function roundGeometry(geometry, places) {
  const r = (c) => (typeof c[0] === 'number' ? [geo.round(c[0], places), geo.round(c[1], places)] : c.map(r));
  return { type: geometry.type, coordinates: r(geometry.coordinates) };
}

function labelPoint(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const biggest = polys.reduce((b, p) => (p[0].length > (b ? b[0].length : 0) ? p : b), null);
  const c = geo.centroid({ polygons: [biggest], lines: [], points: [] });
  return [geo.round(c[1], 4), geo.round(c[0], 4)];
}

async function buildHranice() {
  const krajeRaw = JSON.parse(await cached('kraje_cuzk.geojson', () => src.retry(() => src.fetchText(src.cuzkUrl(17)))));
  const okresyRaw = JSON.parse(await cached('okresy_cuzk.geojson', () => src.retry(() => src.fetchText(src.cuzkUrl(15)))));
  const kraje = krajeRaw.features
    .map((f) => ({
      type: 'Feature',
      properties: { kod: Number(f.properties.kod), nazev: f.properties.nazev, stred: labelPoint(f.geometry) },
      geometry: roundGeometry(simplifyGeometry(f.geometry, TOL_BOUNDARY_M), 4),
      _full: f.geometry,
    }))
    .sort((a, b) => a.properties.nazev.localeCompare(b.properties.nazev, 'cs'));
  const okresy = okresyRaw.features
    .map((f) => ({
      type: 'Feature',
      properties: { kod: Number(f.properties.kod), nazev: f.properties.nazev, kraj: Number(f.properties.vusc), stred: labelPoint(f.geometry) },
      geometry: roundGeometry(simplifyGeometry(f.geometry, TOL_BOUNDARY_M), 4),
      _full: f.geometry,
    }))
    .sort((a, b) => a.properties.nazev.localeCompare(b.properties.nazev, 'cs'));
  const krajByKod = new Map(kraje.map((k) => [k.properties.kod, k]));
  for (const o of okresy) if (!krajByKod.has(o.properties.kraj)) throw new Error(`Okres ${o.properties.nazev} má neznámý kraj ${o.properties.kraj}`);
  // RÚIAN vede Prahu jen jako kraj (VÚSC 19) → okres 3100 z geometrie kraje
  for (const k of kraje) {
    if (okresy.some((o) => o.properties.kraj === k.properties.kod)) continue;
    okresy.push({ type: 'Feature', properties: { kod: k.properties.kod === 19 ? 3100 : k.properties.kod * 100, nazev: k.properties.nazev, kraj: k.properties.kod, stred: k.properties.stred }, geometry: k.geometry, _full: k._full });
  }
  okresy.sort((a, b) => a.properties.nazev.localeCompare(b.properties.nazev, 'cs'));
  log(`hranice: ${kraje.length} krajů, ${okresy.length} okresů`);
  return { kraje, okresy };
}

function makeLocator(hranice) {
  const items = hranice.okresy.map((o) => ({ kod: o.properties.kod, kraj: o.properties.kraj, bbox: geo.bboxOfGeometry(o._full), geom: o._full, simple: o.geometry }));
  return function locate(lon, lat) {
    for (const it of items) {
      if (!geo.bboxContains(it.bbox, lon, lat)) continue;
      if (geo.pointInGeometry(lon, lat, it.geom)) return { okres: it.kod, kraj: it.kraj };
    }
    let best = null;
    for (const it of items) {
      if (lon < it.bbox[0] - 0.02 || lon > it.bbox[2] + 0.02 || lat < it.bbox[1] - 0.02 || lat > it.bbox[3] + 0.02) continue;
      const d = distToGeometryM(lon, lat, it.simple);
      if (d < 500 && (!best || d < best.d)) best = { d, okres: it.kod, kraj: it.kraj };
    }
    return best ? { okres: best.okres, kraj: best.kraj } : null;
  };
}

function distToGeometryM(lon, lat, geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let best = Infinity;
  for (const poly of polys) {
    const ring = poly[0];
    for (let i = 1; i < ring.length; i++) {
      const d = geo.distToSegmentM(lon, lat, ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1]);
      if (d < best) best = d;
    }
  }
  return best;
}

// ------------------------------------------------------- PSČ a obce (GeoNames)
const PRAHA_ADMIN1 = '52'; // GeoNames admin1 Prahy
const PRAHA_KOD = 554782; // kód obce Praha v RÚIAN

// RÚIAN – hranice obcí (vrstva 12), po stránkách po 1 000. Jen pro sestavení: do mapy jdou názvy a středy obcí.
async function loadObceRuian() {
  const raw = await cached('obce_ruian.json', async () => {
    const feats = [];
    for (let off = 0; off < 20000; off += 1000) {
      const q = new URLSearchParams({ where: '1=1', outFields: 'kod,nazev,okres', outSR: '4326', f: 'geojson', maxAllowableOffset: '0.0008', geometryPrecision: '5', returnGeometry: 'true', resultOffset: String(off), resultRecordCount: '1000', orderByFields: 'kod' });
      const j = JSON.parse(await src.retry(() => src.fetchText(`${src.CUZK_RUIAN}/12/query?${q}`, { timeoutMs: 180000 })));
      feats.push(...(j.features || []));
      if (!j.features || j.features.length < 1000) break;
    }
    return JSON.stringify({ type: 'FeatureCollection', features: feats });
  });
  const fc = JSON.parse(raw.toString('utf8'));
  const obce = fc.features
    .filter((f) => f.geometry && f.properties && f.properties.kod)
    .map((f) => ({ kod: Number(f.properties.kod), nazev: f.properties.nazev, okres: Number(f.properties.okres) || null, geom: f.geometry, bbox: geo.bboxOfGeometry(f.geometry) }));
  log(`RÚIAN obce: ${obce.length}`);
  return obce;
}

// Obec bodu (bod v polygonu, mřížka 0,1° jako předfiltr; mimo hranice nejbližší obec do 1 km).
function makeObecLocator(obce) {
  const cell = 0.1;
  const grid = new Map();
  for (const o of obce) {
    for (let i = Math.floor(o.bbox[1] / cell); i <= Math.floor(o.bbox[3] / cell); i++) {
      for (let j = Math.floor(o.bbox[0] / cell); j <= Math.floor(o.bbox[2] / cell); j++) {
        const k = i + ':' + j;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(o);
      }
    }
  }
  return function obecAt(lon, lat) {
    const arr = grid.get(Math.floor(lat / cell) + ':' + Math.floor(lon / cell)) || [];
    for (const o of arr) if (geo.bboxContains(o.bbox, lon, lat) && geo.pointInGeometry(lon, lat, o.geom)) return o;
    let best = null;
    for (const o of arr) {
      const d = distToGeometryM(lon, lat, o.geom);
      if (d < 1000 && (!best || d < best.d)) best = { d, o };
    }
    return best ? best.o : null;
  };
}

// PSČ (GeoNames) → poloha, okres a obec podle hranic obcí RÚIAN: PSČ patří obci, do které padne nejvíc jeho míst
// (u velkých měst GeoNames uvádí jen čtvrti – „Nové Sady“, „Místek“ –, polygon obce je spolehlivě sečte do města).
// Počet obyvatel obcí z GeoNames (orientační, u malých obcí často chybí).
async function buildPscObce(locate, obceRuian, obecAt) {
  const pscZip = await cached('geonames_psc.zip', () => src.retry(() => src.fetchBuffer(src.GEONAMES_PSC, { timeoutMs: 120000 })));
  const dumpZip = await cached('geonames_cz.zip', () => src.retry(() => src.fetchBuffer(src.GEONAMES_MISTA, { timeoutMs: 180000 })));
  const unzip = (buf, name) => zipText(buf, name, async (b) => zlib.inflateRawSync(Buffer.from(b)));

  const popObce = new Map(); // kód obce → počet obyvatel (největší sídlo stejného jména v obci)
  const prazskaMista = new Map(); // pražské čtvrti z GeoNames: fold(název) → [lat, lon]
  for (const f of (await unzip(dumpZip, 'CZ.txt')).split('\n').map((l) => l.split('\t'))) {
    if (f.length < 15 || f[6] !== 'P') continue;
    if (f[10] === PRAHA_ADMIN1 && !prazskaMista.has(fold(f[1]))) prazskaMista.set(fold(f[1]), [Number(f[4]), Number(f[5])]);
    if (/^(PPLH|PPLQ|PPLW|PPLX)$/.test(f[7])) continue;
    const pop = Number(f[14]) || 0;
    if (!pop) continue;
    const o = obecAt(Number(f[5]), Number(f[4]));
    if (!o) continue;
    let name = f[1];
    if (f[7] === 'PPLC') name = 'Praha';
    if (name === 'Pilsen') name = 'Plzeň';
    if (fold(name) !== fold(o.nazev)) continue; // jen sídlo, které se jmenuje jako obec (ne část obce)
    if ((popObce.get(o.kod) || 0) < pop) popObce.set(o.kod, pop);
  }

  const byPsc = new Map();
  for (const f of (await unzip(pscZip, 'CZ.txt')).split('\n').map((l) => l.split('\t'))) {
    if (f.length < 11) continue;
    const psc = f[1].replace(/\s+/g, '');
    if (!/^\d{5}$/.test(psc)) continue;
    if (!byPsc.has(psc)) byPsc.set(psc, []);
    const x = { name: f[2], lat: Number(f[9]), lon: Number(f[10]), presne: f[11] === '4', praha: f[4] === PRAHA_ADMIN1 };
    // GeoNames dává některým pražským PSČ souřadnice stejnojmenné vesnice jinde („156 00 Zbraslav“ u Dolního
    // Dvořiště, „153 00 Radotín“, „197 00 Kbely“) – pražské místo mimo Prahu se dohledá mezi pražskými čtvrtěmi
    const o = x.praha ? obecAt(x.lon, x.lat) : null;
    const ctvrt = x.praha && (!o || o.kod !== PRAHA_KOD) && prazskaMista.get(fold(x.name.replace(/^Praha\s*\d+\s*-\s*/i, '')));
    if (ctvrt) [x.lat, x.lon, x.presne] = [ctvrt[0], ctvrt[1], true];
    byPsc.get(psc).push(x);
  }
  // obce podle jména – místo „Plzeň 3-Vnitřní Město“ patří Plzni, i když má v GeoNames nepřesné souřadnice
  const obceByName = new Map();
  for (const o of obceRuian) {
    const k = fold(o.nazev);
    if (!obceByName.has(k)) obceByName.set(k, []);
    obceByName.get(k).push(o);
  }
  const obecPodleJmena = (name, lat, lon) => {
    const kand = [name];
    const i = name.lastIndexOf('-');
    if (i > 0) kand.push(name.slice(0, i).trim());
    for (const n of kand.slice()) {
      const bez = n.replace(/\s+(\d+|[IVX]+)$/u, '').trim();
      if (bez !== n) kand.push(bez);
    }
    for (const k of kand) {
      let best = null;
      for (const o of obceByName.get(fold(k)) || []) {
        const c = [(o.bbox[1] + o.bbox[3]) / 2, (o.bbox[0] + o.bbox[2]) / 2];
        const d = geo.haversineM(lat, lon, c[0], c[1]);
        if (d < 25000 && (!best || d < best.d)) best = { d, o };
      }
      if (best) return best.o;
    }
    return null;
  };
  const psc = {};
  const pscObce = new Map(); // kód obce → [PSČ, počet míst]
  let bezObce = 0;
  for (const [kod, list] of byPsc) {
    // hlas každého místa PSČ: obec stejného jména (váha 3), jinak obec pod souřadnicemi (přesné 2, přibližné 1)
    const tally = new Map();
    for (const x of list) {
      const podJmenem = obecPodleJmena(x.name, x.lat, x.lon);
      const podBodem = obecAt(x.lon, x.lat);
      const o = podJmenem || podBodem;
      if (!o) continue;
      const t = tally.get(o.kod) || { o, n: 0, pts: new Set() };
      t.n += podJmenem ? 3 : x.presne ? 2 : 1;
      if (podBodem && podBodem.kod === o.kod) t.pts.add(`${x.lat},${x.lon}`);
      tally.set(o.kod, t);
    }
    if (!tally.size) {
      bezObce++;
      continue;
    }
    // pošta je v největší obci svého obvodu: skóre = hlasy × počet obyvatel („741 01“ = Nový Jičín, ne Starý Jičín,
    // jehož části PSČ obsluhuje); Praha jen tehdy, když jsou pražská místa většinou
    const prazskych = list.filter((x) => x.praha).length;
    const kandidati = [...tally.values()].filter((t) => t.o.kod !== PRAHA_KOD || prazskych * 2 >= list.length);
    const main = (kandidati.length ? kandidati : [...tally.values()]).sort((a, b) => b.n * Math.max(50, popObce.get(b.o.kod) || 0) - a.n * Math.max(50, popObce.get(a.o.kod) || 0))[0];
    // poloha = průměr míst uvnitř obce; když žádné neleží uvnitř (nepřesné souřadnice), střed obce
    const pts = main.pts.size ? [...main.pts].map((v) => v.split(',').map(Number)) : [labelPoint(main.o.geom)];
    const lat = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const lon = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const loc = locate(lon, lat);
    const okres = (loc && loc.okres) || main.o.okres;
    psc[kod] = [geo.round(lat, 4), geo.round(lon, 4), okres, main.o.nazev, main.o.kod];
    const prev = pscObce.get(main.o.kod);
    if (!prev || main.n > prev[1]) pscObce.set(main.o.kod, [kod, main.n]);
  }
  // obce do mapy: název, okres, střed, počet obyvatel (GeoNames), PSČ (pro objednávky jen s názvem obce), kód RÚIAN
  const obce = obceRuian
    .map((o) => {
      const c = labelPoint(o.geom);
      const loc = locate(c[1], c[0]);
      let p = pscObce.get(o.kod);
      if (!p) {
        let best = null;
        for (const [k, v] of Object.entries(psc)) {
          const d = (v[0] - c[0]) ** 2 + ((v[1] - c[1]) * 0.64) ** 2;
          if (!best || d < best.d) best = { d, k };
        }
        p = best ? [best.k] : [null];
      }
      return [o.nazev, (loc && loc.okres) || o.okres, c[0], c[1], popObce.get(o.kod) || 0, p[0], o.kod];
    })
    .sort((a, b) => b[4] - a[4] || a[0].localeCompare(b[0], 'cs'));
  log(`PSČ: ${Object.keys(psc).length} (bez obce ${bezObce}), obce: ${obce.length} (s počtem obyvatel ${obce.filter((o) => o[4] > 0).length})`);
  return { psc, obce };
}

async function zipText(buf, name, inflate) {
  // obecný ZIP přes čtečku z lib/xlsx.js (stejný formát)
  const rows = await xlsx.zipEntryText(buf, name, inflate);
  if (rows == null) throw new Error('V archivu chybí ' + name);
  return rows;
}

// ------------------------------------------------------------- OSM
const SDILENA_KOLA = /nextbike|rekola|lime\b|bolt\b|freebike|pilsen bike|scoobike|velonet|kolonka|bike\s?sharing|sdílen|sdilen|homeport|antee|rekolo/i;
const RETEZCE = /decathlon|sportisimo|hervis|intersport|a3\s?sport|sportissimo/i;

function yes(v) {
  return v != null && /^(yes|only|true|\d+)$/i.test(String(v));
}
function no(v) {
  return v != null && /^(no|false)$/i.test(String(v));
}
function sv(v) {
  return yes(v) ? 'osm' : no(v) ? 'ne' : null;
}

function typOsm(t) {
  const name = `${t.name || ''} ${t.brand || ''} ${t.operator || ''}`;
  if (t.amenity === 'bicycle_repair_station') return null;
  if ((t.shop === 'sports' || t.shop === 'outdoor' || t.shop === 'bicycle') && RETEZCE.test(name)) return 'retezec';
  if (t.shop === 'bicycle') {
    const second = t['service:bicycle:second_hand'] || t.second_hand;
    if (/^only$/i.test(second || '')) return 'bazar';
    if (/^only$/i.test(t['service:bicycle:repair'] || '') || (no(t['service:bicycle:retail']) && yes(t['service:bicycle:repair']))) return 'servis';
    if (no(t['service:bicycle:retail']) && yes(t['service:bicycle:rental'])) return 'pujcovna';
    return 'prodejna';
  }
  if (t.amenity === 'bicycle_rental' || t.shop === 'rental') {
    if (/docking_station|dropoff_point/i.test(t.bicycle_rental || '')) return null;
    // shop=rental půjčuje cokoli (auta, nářadí) – jen s jasnou vazbou na kola
    if (t.amenity !== 'bicycle_rental' && !/bicycle|bike|kolo|kola/i.test(`${t.rental || ''} ${name}`) && !yes(t['service:bicycle:rental'])) return null;
    if (SDILENA_KOLA.test(`${name} ${t.network || ''}`)) return null;
    if (!t.name) return null;
    return 'pujcovna';
  }
  if (yes(t['service:bicycle:repair'])) return 'servis';
  if (yes(t['service:bicycle:retail']) || (t.shop === 'sports' && /cycling|bicycle|mtb|bmx/i.test(t.sport || ''))) return 'prodejna';
  if (yes(t['service:bicycle:rental'])) return t.name ? 'pujcovna' : null;
  return null;
}

const TYP_LABEL = { prodejna: 'Prodejna kol', servis: 'Servis kol', pujcovna: 'Půjčovna kol', bazar: 'Bazar kol', retezec: 'Sportovní řetězec', firma: 'Firma z ARES (sídlo)' };

async function loadOsm(locate) {
  const elements = new Map();
  for (const [key, selector] of Object.entries(src.OSM_DOTAZY)) {
    const raw = await cached(`osm_${key}.json`, async () => JSON.stringify(await src.overpass(selector, log)), { maxAgeDays: FORCE ? 0 : 20 });
    const json = JSON.parse(raw.toString('utf8'));
    for (const e of json.elements || []) elements.set(e.type + '/' + e.id, e);
    log(`OSM ${key}: ${json.elements.length}`);
  }
  const mista = [];
  let vynechano = 0;
  for (const e of elements.values()) {
    const t = e.tags || {};
    const typ = typOsm(t);
    if (!typ) {
      vynechano++;
      continue;
    }
    const lat = e.lat != null ? e.lat : e.center && e.center.lat;
    const lon = e.lon != null ? e.lon : e.center && e.center.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const loc = locate(lon, lat);
    if (!loc) continue; // mimo ČR (přeshraniční prvky z Overpass area)
    let nazev = clean(t.name) || clean(t['name:cs']) || clean(t.brand) || clean(t.operator);
    if (nazev && (/^[\d\s\-/.,]+$/.test(nazev) || nazev.length < 2)) nazev = null;
    const tel = uniq([t.phone, t['contact:phone'], t.mobile, t['contact:mobile']].flatMap((v) => (v ? String(v).split(/[;,]/) : [])).map((v) => contacts.normalizePhone(v)));
    const mail = uniq([t.email, t['contact:email']].flatMap((v) => (v ? String(v).toLowerCase().split(/[;,\s]+/) : [])).filter((x) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(x)));
    const web = uniq([t.website, t['contact:website'], t.url].map((v) => contacts.normalizeWebsite(v))).filter((u) => !contacts.isSocialUrl(u));
    const fb = uniq([t['contact:facebook'], t.facebook, t['contact:instagram']].map((v) => (v && /^https?:/i.test(v) ? contacts.normalizeWebsite(v) : v && /^[\w.-]+$/.test(v) ? 'https://www.facebook.com/' + v : null)));
    for (const w of [t.website, t['contact:website']]) {
      const n = contacts.normalizeWebsite(w);
      if (n && contacts.isSocialUrl(n) && !fb.includes(n)) fb.push(n);
    }
    const ulice = [clean(t['addr:street']) || clean(t['addr:place']), [clean(t['addr:conscriptionnumber']), clean(t['addr:streetnumber'])].filter(Boolean).join('/') || clean(t['addr:housenumber'])].filter(Boolean).join(' ');
    const obec = clean(t['addr:city']) || clean(t['addr:place']) || clean(t['addr:suburb']);
    const ico = ares.normIco(t['ref:ico'] || t['ref:IČO'] || t.ico || t['company:ico'] || t['ref:company'] || '');
    mista.push({
      id: OSM_PREFIX[e.type] + e.id,
      zdroj: 'osm',
      typ,
      nazev: nazev || `${TYP_LABEL[typ]} bez názvu`,
      bezNazvu: !nazev || undefined,
      lat: geo.round(lat, 5),
      lon: geo.round(lon, 5),
      okres: loc.okres,
      kraj: loc.kraj,
      obec,
      adresa: [ulice, [clean(t['addr:postcode']), obec].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null,
      tel,
      mail,
      web,
      fb,
      oteviraci: clean(t.opening_hours),
      popis: clean(t.description),
      znacka: clean(t.brand),
      sl: {
        prodej: typ === 'prodejna' || typ === 'retezec' ? sv(t['service:bicycle:retail']) || 'osm' : sv(t['service:bicycle:retail']),
        servis: typ === 'servis' ? 'osm' : sv(t['service:bicycle:repair']),
        pujcovna: typ === 'pujcovna' ? 'osm' : sv(t['service:bicycle:rental']),
        ekola: sv(t['service:bicycle:ebike'] || t['service:bicycle:electric']),
        bazar: typ === 'bazar' ? 'osm' : sv(t['service:bicycle:second_hand'] || t.second_hand),
      },
      ico: ico || null,
      icoZdroj: ico ? 'osm' : null,
      osm: `${e.type}/${e.id}`,
    });
  }
  const sloucene = sloucitDuplicity(mista);
  log(`OSM místa: ${sloucene.length} (vynecháno ${vynechano}: stojany na opravy, sdílená kola, prvky bez typu; sloučeno duplicit ${mista.length - sloucene.length})`);
  return sloucene;
}

// Stejná prodejna v OSM dvakrát (bod i budova, dva zápisy): stejný název do 200 m → jedno místo se sjednocenými
// kontakty; zůstává záznam s více údaji.
function sloucitDuplicity(mista) {
  const info = (m) => (m.tel || []).length + (m.mail || []).length + (m.web || []).length * 2 + (m.adresa ? 1 : 0) + (m.oteviraci ? 1 : 0) + Object.values(m.sl).filter(Boolean).length;
  const byName = new Map();
  for (const m of mista) {
    if (m.bezNazvu) continue;
    const k = fold(m.nazev);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(m);
  }
  const pryc = new Set();
  for (const arr of byName.values()) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => info(b) - info(a));
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      if (pryc.has(a.id)) continue;
      for (let j = i + 1; j < arr.length; j++) {
        const b = arr[j];
        if (pryc.has(b.id) || geo.haversineM(a.lat, a.lon, b.lat, b.lon) > 200) continue;
        for (const k of ['tel', 'mail', 'web', 'fb']) a[k] = uniq([...(a[k] || []), ...(b[k] || [])]);
        for (const k of Object.keys(b.sl)) if (!a.sl[k] || (a.sl[k] === 'ne' && b.sl[k] === 'osm')) a.sl[k] = a.sl[k] || b.sl[k];
        for (const k of ['adresa', 'obec', 'oteviraci', 'popis', 'znacka', 'ico', 'icoZdroj']) if (a[k] == null && b[k] != null) a[k] = b[k];
        pryc.add(b.id);
      }
    }
  }
  return mista.filter((m) => !pryc.has(m.id));
}

// ------------------------------------------------------------- ARES – firmy s koly v názvu
// ARES hledá v obchodním jméně celá slova, proto výčet tvarů. Výsledky se čistí podle právní formy a slov,
// která prozrazují spolek, závod, restauraci nebo „ozubená kola“.
const ARES_SLOVA = ['kolo', 'kola', 'kol', 'cyklo', 'cykloservis', 'cyklosport', 'cyklocentrum', 'cykloshop', 'cyklobazar', 'cyklopůjčovna', 'cyklopujcovna', 'cyklosvět', 'cyklotech', 'cyklopoint', 'cykloprodejna', 'bike', 'bikes', 'biking', 'bikeshop', 'bikeservis', 'bikecentrum', 'ebike', 'e-bike', 'elektrokola', 'elektrokolo', 'kolárna', 'kolarna', 'velo', 'bicykl', 'bicykly', 'cycling', 'cycles', 'cycle', 'kolosport', 'koloshop', 'koloservis', 'bicycle', 'bicycles', 'mtb'];
const FORMY_FIREM = new Set(['101', '105', '107', '111', '112', '113', '121', '205', '421', '424', '425', '501']);
const FORMY_FO = new Set(['101', '105', '107', '424']);
// Hranice slov s diakritikou (\b v JS bere jen ASCII, „ozubená“ by nenašel).
const W0 = '(?<![\\p{L}\\p{N}])';
const W1 = '(?![\\p{L}\\p{N}])';
const slova = (alt) => new RegExp(W0 + '(' + alt + ')' + W1, 'iu');
const NE_PRODEJNA = slova('team|tým|tym|klub|club|spolek|sdružení|sdruzeni|závod\\p{L}*|zavod\\p{L}*|maraton|marathon|pohár|pohar|tours?|cyklostezk\\p{L}*|cyklotras\\p{L}*|stezk\\p{L}*|trails?|nadace|nadační|nadacni|akademie|academy|škola|skola|school|kavárna|kavarna|café|cafe|caffe|bistro|restaurant\\p{L}*|restaurace|beers?|pub|food|hotel|penzion|pension|ubytování|camp|kemp|ozuben\\p{L}*|vodní|mlýn|mlyn|kolonie|koloniál|kolowrat|kolotoč|kolotoc|kolorit|parkoviště|park|hasič\\p{L}*|tělocvič\\p{L}*|sokol|orel|unie|asociace|svaz|federace|festival|event\\p{L}*|consulting|reality|properties|development|projekt|rezidence|vila|divadlo|zastavárna|zastavarna|stavby|stavební|auto|autoservis|pneu\\p{L}*|alu|disky?|kolej\\p{L}*|stavebnin\\p{L}*|velodrom|velorex|veletrh|media|marketing|invest|holding|management|promotion|agency|evidence|football|scouting|solar|kick');
// Slovo, které jasně patří ke kolům (stačí samo).
const SILNE_KOLO = slova('cyklo\\p{L}*|bike\\p{L}*|e-?bike\\p{L}*|elektrokol\\p{L}*|kolárn\\p{L}*|kolarn\\p{L}*|bicykl\\p{L}*');
// „kola/kolo“ s kontextem („Jízdní kola CZ“, „servis kol“, „Kola Bárta“ na začátku názvu).
const KONTEXT_KOLA = new RegExp(W0 + '(jízdní|jizdni|dětská|detska|lehká|lehka|horská|horska|karbonová|karbonova|elektro|servis\\p{L}*|prodej\\p{L}*|půjčovna|pujcovna|opravy|svět|svet|ráj|raj|bazar|spolehlivá|spolehliva|další|dalsi)\\s+kol[ao]?' + W1 + '|' + W0 + 'kol[ao]\\s+(sport|servis|shop|centrum|bike)' + W1 + '|^\\s*kol[ao]' + W1 + '\\s*[-–]?\\s*[\\p{Lu}0-9]', 'iu');
// Slova, která kola znamenat můžou a nemusí – stačí jen s předmětem činnosti obchod / opravy / půjčovna / výroba.
const NEJASNE_KOLO = slova('kol[ao]|velo|cycl\\p{L}*|bicycle\\p{L}*|mtb');
const NACE_KOLA = (nace) => (nace || []).some((c) => /^(47|46|95|30|77|G)/.test(String(c)) || /^323/.test(String(c)));

async function aresHledani() {
  const name = 'ares_hledani.json';
  let cache = !FORCE && readJsonCache(name);
  if (cache && Date.now() - Date.parse(cache.kdy) > ARES_MAX_DNI * 86400000) cache = null;
  if (cache) {
    log(`ARES hledání z cache: ${cache.subjekty.length} subjektů (${cache.kdy.slice(0, 10)})`);
    return cache.subjekty;
  }
  const by = new Map();
  for (const slovo of ARES_SLOVA) {
    try {
      const arr = await ares.hledatVse({ obchodniJmeno: slovo }, log);
      let pridano = 0;
      for (const s of arr) {
        if (!s.ico || by.has(s.ico)) continue;
        by.set(s.ico, s);
        pridano++;
      }
      log(`ARES „${slovo}“: ${arr.length} (nových ${pridano})`);
    } catch (e) {
      log(`ARES „${slovo}“: chyba ${e.message}`);
    }
    await ares.sleep(400);
  }
  const subjekty = [...by.values()];
  writeJsonCache(name, { kdy: new Date().toISOString(), subjekty });
  return subjekty;
}

function relevantniAres(s) {
  const nazev = s.obchodniJmeno || '';
  const forma = String(s.pravniForma || '');
  if (!FORMY_FIREM.has(forma)) return false;
  if (s.datumZaniku) return false;
  if (/v likvidaci|v konkurzu|v insolvenci/i.test(nazev)) return false;
  const reg = s.seznamRegistraci || {};
  if (reg.stavZdrojeRes === 'ZANIKLY' && reg.stavZdrojeVr !== 'AKTIVNI' && reg.stavZdrojeRzp !== 'AKTIVNI') return false;
  if (NE_PRODEJNA.test(nazev)) return false;
  // „Martin Kola“ – podnikatel s příjmením Kola, ne prodejna
  if (FORMY_FO.has(forma) && /^\s*\p{Lu}\p{Ll}+\s+Kol[ao]\s*$/u.test(nazev)) return false;
  if (SILNE_KOLO.test(nazev) || KONTEXT_KOLA.test(nazev)) return true;
  return NEJASNE_KOLO.test(nazev) && NACE_KOLA(s.czNace2008 || s.czNace);
}

// Prodejna z OSM bez IČO: ARES podle nejvýraznějšího slova názvu v obci prodejny („Cyklo Hloch“ v Olomouci →
// „Ctirad Hloch“). Bere se jen jediný kandidát: podnikatel, aktivní, celé slovo názvu ve jménu firmy a obchod /
// opravy / půjčovna v CZ-NACE nebo kola v názvu. Výsledek je odhad (icoZdroj „odhad“) – mapa ho tak i ukazuje.
// Slova, podle kterých nejde firmu poznat („Cyklo Point“ ≠ „ICE Point 112 s.r.o.“).
const OBECNA_SLOVA = new Set(['cyklosport', 'cykloservis', 'cyklocentrum', 'cykloshop', 'bikeshop', 'bikeservis', 'point', 'house', 'store', 'service', 'servis', 'team', 'city', 'center', 'centre', 'park', 'market', 'plus', 'profi', 'euro', 'trade', 'group', 'sport', 'sports', 'outdoor', 'rent', 'rental', 'moto', 'auto', 'elektro', 'velo', 'bikes', 'cycles', 'cycling', 'shop', 'eshop', 'praha', 'brno', 'ostrava', 'plzen', 'olomouc', 'liberec', 'jizdni', 'jizdnich', 'style', 'statek', 'statku', 'mike', 'lipno', 'garden', 'holiday', 'holidays']);

async function aresPodleNazvu(mista, obecAt) {
  const cacheName = 'ares_nazev.json';
  let cache = (!FORCE && readJsonCache(cacheName)) || {};
  const out = new Map(); // id místa → IČO
  let dotazu = 0;
  for (const m of mista) {
    if (m.ico || m.bezNazvu || m.zdroj !== 'osm' || !['prodejna', 'servis', 'pujcovna', 'bazar'].includes(m.typ)) continue;
    const tok = nameTokens(m.nazev).filter((t) => t.length >= 4 && !OBECNA_SLOVA.has(t)).sort((a, b) => b.length - a.length)[0];
    const o = obecAt(m.lon, m.lat);
    if (!tok || !o) continue;
    const key = tok + '|' + o.kod;
    let c = cache[key];
    if (c && Date.now() - Date.parse(c.kdy) > ARES_MAX_DNI * 86400000) c = null;
    if (!c) {
      try {
        const j = await ares.hledat({ obchodniJmeno: tok, sidlo: { kodObce: o.kod } }, 0, 50);
        const subj = (j && j.ekonomickeSubjekty) || [];
        c = cache[key] = {
          kdy: new Date().toISOString(),
          celkem: (j && j.pocetCelkem) || 0,
          subjekty: subj.map((x) => ({ ico: x.ico, obchodniJmeno: x.obchodniJmeno, pravniForma: x.pravniForma, czNace: x.czNace2008 || x.czNace || [], datumZaniku: x.datumZaniku || null })),
        };
        dotazu++;
        if (dotazu % 50 === 0) writeJsonCache(cacheName, cache);
        await ares.sleep(300);
      } catch (e) {
        log(`  ARES podle názvu „${tok}“: ${e.message}`);
        continue;
      }
    }
    if (c.celkem > 50) continue; // příliš obecné slovo
    const kand = c.subjekty.filter((x) =>
      x.ico && !x.datumZaniku && FORMY_FIREM.has(String(x.pravniForma || '')) && !/v likvidaci/i.test(x.obchodniJmeno || '') &&
      !NE_PRODEJNA.test(x.obchodniJmeno || '') && nameSim(m.nazev, x.obchodniJmeno) >= 0.99 &&
      (NACE_KOLA(x.czNace) || SILNE_KOLO.test(x.obchodniJmeno) || KONTEXT_KOLA.test(x.obchodniJmeno)));
    if (kand.length === 1) out.set(m.id, kand[0].ico);
  }
  writeJsonCache(cacheName, cache);
  log(`ARES podle názvu a obce: ${out.size} odhadnutých IČO (${dotazu} nových dotazů)`);
  return out;
}

// ------------------------------------------------------------- weby
function webCacheName(url) {
  return 'web/' + crypto.createHash('sha1').update(url).digest('hex').slice(0, 20) + '.json';
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 mapa-prodejen/0.1 (+https://github.com/ladasuchan1-cmd/Doma)';

async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'cs,sk;q=0.9,en;q=0.7' }, redirect: 'follow', signal: ctrl.signal });
    const type = res.headers.get('content-type') || '';
    if (!res.ok) return { ok: false, status: res.status, url: res.url };
    if (!/html|xml|text\/plain/i.test(type)) return { ok: false, url: res.url, chyba: 'není HTML (' + type.split(';')[0] + ')' };
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total > 1.5 * 1024 * 1024) {
        ctrl.abort();
        break;
      }
    }
    return { ok: true, url: res.url, html: decodeHtml(Buffer.concat(chunks), type) };
  } catch (e) {
    return { ok: false, chyba: e.name === 'AbortError' ? 'vypršel čas' : e.cause && e.cause.code ? e.cause.code : e.message };
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtml(buf, contentType) {
  let charset = (/charset=([\w-]+)/i.exec(contentType) || [])[1];
  if (!charset) charset = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1')) || [])[1];
  charset = (charset || 'utf-8').toLowerCase();
  if (/^(windows-1250|cp1250|iso-8859-2|latin2)$/.test(charset)) {
    try {
      return new TextDecoder(charset === 'cp1250' ? 'windows-1250' : charset).decode(buf);
    } catch (_e) {
      return buf.toString('utf8');
    }
  }
  return buf.toString('utf8');
}

async function projdiWeb(url) {
  const out = { web: url, stav: 'ok', chyba: null, kdy: new Date().toISOString(), stranky: 0, emaily: [], telefony: [], ico: [], provozovatel: null, sluzby: null, znacky: [] };
  const first = await fetchPage(url);
  if (!first.ok) {
    out.stav = 'chyba';
    out.chyba = first.chyba || (first.status ? 'HTTP ' + first.status : 'nedostupné');
    return out;
  }
  out.web = first.url || url;
  out.stranky = 1;
  const htmls = [first.html];
  for (const l of contacts.findInfoLinks(first.html, out.web, 3)) {
    const p = await fetchPage(l);
    if (p.ok) {
      out.stranky++;
      htmls.push(p.html);
    }
  }
  const html = htmls.join('\n');
  const text = htmls.map((h) => contacts.stripHtml(h)).join('\n');
  out.emaily = contacts.extractEmails(html).slice(0, 6);
  out.telefony = contacts.extractPhones(html).slice(0, 6);
  out.ico = contacts.extractIco(text).slice(0, 4);
  out.provozovatel = contacts.extractOperator(text);
  const sl = contacts.detectSluzby(text, html);
  out.sluzby = { prodej: sl.prodej, servis: sl.servis, ekola: sl.ekola, pujcovna: sl.pujcovna, bazar: sl.bazar, eshop: sl.eshop };
  out.ukazky = sl.ukazky;
  out.znacky = contacts.detectZnacky(text);
  return out;
}

async function projdiWeby(mista) {
  const weby = {};
  const todo = [];
  for (const m of mista) {
    const url = (m.web || [])[0];
    if (!url) continue;
    const c = readJsonCache(webCacheName(url));
    const stari = c ? Date.now() - Date.parse(c.kdy) : Infinity;
    // čerstvý výsledek platí; nedostupný web se zkouší znovu po týdnu
    if (c && stari < WEB_MAX_DNI * 86400000 && !(c.stav === 'chyba' && stari > 7 * 86400000)) {
      weby[m.id] = c;
      continue;
    }
    if (c) weby[m.id] = c; // starý výsledek platí, dokud nedoběhne nový
    todo.push({ m, url });
  }
  if (args.bezWebu) {
    log(`weby: ${Object.keys(weby).length} z cache, ${todo.length} neprojitých (--bez-webu)`);
    return weby;
  }
  let list = todo;
  if (args.webLimit) list = list.slice(0, args.webLimit);
  log(`weby: ${Object.keys(weby).length} z cache, ke stažení ${list.length}, souběžnost ${CONCURRENCY}`);
  const byUrl = new Map();
  const hostBusy = new Set();
  const queue = list.slice();
  let done = 0;
  let chyb = 0;
  const started = Date.now();
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      const host = contacts.hostOf(item.url) || item.url;
      if (hostBusy.has(host)) {
        queue.push(item);
        await src.sleep(150);
        continue;
      }
      hostBusy.add(host);
      try {
        let res = byUrl.get(item.url);
        if (!res) {
          res = await projdiWeb(item.url).catch((e) => ({ web: item.url, stav: 'chyba', chyba: e.message, kdy: new Date().toISOString() }));
          byUrl.set(item.url, res);
          writeJsonCache(webCacheName(item.url), res);
        }
        weby[item.m.id] = res;
        done++;
        if (res.stav !== 'ok') chyb++;
        if (done % 50 === 0) log(`  weby ${done}/${list.length} (chyb ${chyb}, ${(done / ((Date.now() - started) / 1000)).toFixed(1)}/s)`);
      } finally {
        hostBusy.delete(host);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  log(`weby hotovo: ${done} staženo (${chyb} nedostupných), celkem s výsledkem ${Object.keys(weby).length}`);
  return weby;
}

// ------------------------------------------------------------- ARES detail + RES (cache po IČO)
async function nactiFirmy(icos, hity) {
  const firmy = {};
  const list = [...icos];
  let stazeno = 0;
  let chyb = 0;
  for (const ico of list) {
    const name = `ares/${ico}.json`;
    let c = readJsonCache(name);
    if (c && (FORCE || Date.now() - Date.parse(c.kdy) > ARES_MAX_DNI * 86400000)) c = null;
    if (!c) {
      try {
        const zakl = hity.get(ico) || (await ares.subjekt(ico));
        let r = null;
        if (zakl) {
          try {
            r = await ares.res(ico);
          } catch (_e) {
            r = null;
          }
        }
        c = { kdy: new Date().toISOString(), zakl: zakl || null, res: r };
        writeJsonCache(name, c);
        stazeno++;
        await ares.sleep(200);
      } catch (e) {
        chyb++;
        log(`  ARES ${ico}: ${e.message}`);
        continue;
      }
    }
    if (!c.zakl) continue;
    const f = ares.firma(c.zakl, c.res);
    if (f) firmy[ico] = f;
    if ((stazeno + 1) % 100 === 0) log(`  ARES/RES: staženo ${stazeno}`);
  }
  log(`firmy (ARES + RES): ${Object.keys(firmy).length} (staženo nově ${stazeno}, chyb ${chyb})`);
  return firmy;
}

// ------------------------------------------------------------- propojení míst s firmami
// IČO, která na webech e-shopů bývají, ale patří někomu jinému: dozor (ČOI, ÚOOÚ), platby, doprava, platformy.
const CIZI_ICO = new Set([
  '00020869', // Česká obchodní inspekce (mimosoudní řešení sporů)
  '70837627', // Úřad pro ochranu osobních údajů
  '00006947', // Ministerstvo financí
  '28408306', // Zásilkovna
  '47114983', // Česká pošta
  '25194798', // PPL CZ
  '27924505', // Comgate
  '28935675', // Shoptet
  '26168685', // Seznam.cz
  '45317054', // Komerční banka
  '45244782', // Česká spořitelna
  '00001350', // ČSOB
  '29045371', // Air Bank
]); // ověřeno v ARES 7. 10. 2026
// Právní formy úřadů, obcí a bank – IČO z webu prodejny takového subjektu skoro jistě patří někomu jinému.
const FORMY_UREDNI = new Set(['301', '313', '325', '331', '381', '391', '601', '661', '801', '804', '811']);

// IČO z webu: kandidáti bez „cizích“ (dozor, platby, IČO opakující se na webech různých prodejen), z nich to,
// jehož firma se nejvíc podobá názvu prodejny nebo doméně; bez shody jen jediné IČO na webu, a to podnikatele.
function vyberIcoZWebu(m, w, firmy, caste) {
  const kandidati = ((w && w.stav === 'ok' && w.ico) || []).filter((ico) => !CIZI_ICO.has(ico) && !caste.has(ico));
  if (!kandidati.length) return null;
  const host = (contacts.hostOf(w.web) || '').split('.').slice(0, -1).join(' ');
  let best = null;
  for (const ico of kandidati) {
    const f = firmy[ico];
    if (!f || f.zanikla) continue;
    if (FORMY_UREDNI.has(String(f.forma)) || (f.nace || []).some((c) => /^64/.test(c))) continue;
    const s = Math.max(nameSim(m.nazev, f.nazev), nameSim(host, f.nazev), nameSim(w.provozovatel || '', f.nazev));
    if (!best || s > best.s) best = { ico, s };
  }
  if (!best) return null;
  if (best.s > 0) return best.ico;
  return kandidati.length === 1 ? best.ico : null;
}

// ----------------------------------------------------------------- main
async function main() {
  log(`cache: ${CACHE}`);
  log(`výstup: ${OUT}`);
  const hranice = await buildHranice();
  const locate = makeLocator(hranice);
  const obceRuian = await loadObceRuian();
  const obecAt = makeObecLocator(obceRuian);
  const okresByKod = new Map(hranice.okresy.map((o) => [o.properties.kod, o.properties]));

  const mista = await loadOsm(locate);
  const weby = await projdiWeby(mista);
  const hityArr = await aresHledani();
  const hity = new Map(hityArr.map((s) => [s.ico, s]));
  const relevantni = hityArr.filter(relevantniAres);
  log(`ARES: ${hityArr.length} subjektů s „kolovým“ slovem v názvu, relevantních ${relevantni.length}`);

  // IČO, které se opakuje na webech různých prodejen (provozovatel platformy, dopravce…), prodejně nepatří
  const icoHosty = new Map();
  for (const m of mista) {
    const w = weby[m.id];
    if (!w || w.stav !== 'ok') continue;
    const host = contacts.hostOf(w.web) || w.web;
    for (const ico of w.ico || []) {
      if (!icoHosty.has(ico)) icoHosty.set(ico, new Set());
      icoHosty.get(ico).add(host);
    }
  }
  const caste = new Set([...icoHosty].filter(([, h]) => h.size >= 3).map(([ico]) => ico));
  if (caste.size) log(`IČO na webech 3 a více prodejen (ignoruji): ${[...caste].join(', ')}`);

  // firmy pro všechna kandidátní IČO (z OSM, z webů, z hledání) – detail ARES + RES, cache po IČO
  const kandidati = new Set([...mista.map((m) => m.ico).filter(Boolean), ...relevantni.map((s) => s.ico)]);
  for (const [ico] of icoHosty) if (!caste.has(ico) && !CIZI_ICO.has(ico)) kandidati.add(ico);
  const firmy = await nactiFirmy(kandidati, hity);

  let zWebu = 0;
  for (const m of mista) {
    if (m.ico) continue;
    const ico = vyberIcoZWebu(m, weby[m.id], firmy, caste);
    if (ico) {
      m.ico = ico;
      m.icoZdroj = 'web';
      zWebu++;
    }
  }
  log(`IČO z webů: ${zWebu} míst`);

  // firmy z hledání v ARES – relevantní a dosud nepropojené
  const icoNaMiste = new Set(mista.map((m) => m.ico).filter(Boolean));

  // souřadnice sídel relevantních firem (adresní místa RÚIAN)
  const amKody = relevantni.map((s) => s.sidlo && s.sidlo.kodAdresnihoMista).filter(Boolean);
  let amCache = (!FORCE && readJsonCache('ruian_am.json')) || {};
  const chybi = amKody.filter((k) => !amCache[k]);
  if (chybi.length) {
    log(`RÚIAN: souřadnice ${chybi.length} adresních míst`);
    const got = await ares.adresniMista(chybi);
    for (const [k, v] of got) amCache[k] = v;
    writeJsonCache('ruian_am.json', amCache);
  }

  // propojení podle názvu: firma z ARES ↔ prodejna z OSM do 25 km od sídla
  let propojenoNazvem = 0;
  for (const s of relevantni) {
    if (icoNaMiste.has(s.ico)) continue;
    const am = s.sidlo && amCache[s.sidlo.kodAdresnihoMista];
    let best = null;
    for (const m of mista) {
      if (m.ico) continue;
      const sim = nameSim(m.nazev, s.obchodniJmeno);
      if (sim < 0.99) continue;
      const d = am ? geo.haversineM(am[0], am[1], m.lat, m.lon) : m.okres === Number(s.sidlo && s.sidlo.kodOkresu) ? 0 : Infinity;
      if (d > 25000) continue;
      if (!best || d < best.d) best = { m, d };
    }
    if (best) {
      best.m.ico = s.ico;
      best.m.icoZdroj = 'nazev';
      icoNaMiste.add(s.ico);
      propojenoNazvem++;
    }
  }
  log(`propojeno podle názvu: ${propojenoNazvem}`);

  // zbylé prodejny bez IČO: odhad z ARES podle jména a obce, pak detail firem pro nová IČO
  const odhad = await aresPodleNazvu(mista, obecAt);
  for (const m of mista) {
    const ico = odhad.get(m.id);
    if (!ico) continue;
    m.ico = ico;
    m.icoZdroj = 'odhad';
    icoNaMiste.add(ico);
  }
  const nova = new Set([...odhad.values()].filter((ico) => !firmy[ico]));
  if (nova.size) Object.assign(firmy, await nactiFirmy(nova, hity));

  // firmy bez prodejny v OSM → místo v sídle
  let zAres = 0;
  let bezSouradnic = 0;
  for (const s of relevantni) {
    if (icoNaMiste.has(s.ico)) continue;
    const f = firmy[s.ico];
    if (!f || f.zanikla || f.likvidace) continue;
    const am = f.am && amCache[f.am];
    if (!am) {
      bezSouradnic++;
      continue;
    }
    const loc = locate(am[1], am[0]);
    if (!loc) continue;
    mista.push({
      id: 'a' + s.ico,
      zdroj: 'ares',
      typ: 'firma',
      nazev: f.nazev,
      lat: am[0],
      lon: am[1],
      okres: loc.okres,
      kraj: loc.kraj,
      obec: f.obec || null,
      adresa: f.sidlo || null,
      tel: [],
      mail: [],
      web: [],
      fb: [],
      sl: { prodej: null, servis: /servis/i.test(f.nazev) ? 'nazev' : null, pujcovna: /půjčovn|pujcovn|rent/i.test(f.nazev) ? 'nazev' : null, ekola: /e-?bike|elektrokol/i.test(f.nazev) ? 'nazev' : null, bazar: /bazar/i.test(f.nazev) ? 'nazev' : null },
      ico: s.ico,
      icoZdroj: 'ares',
      osm: null,
    });
    zAres++;
  }
  log(`firmy z ARES bez prodejny v OSM: ${zAres} míst v sídle (bez souřadnic ${bezSouradnic})`);

  // služby z webu a obec (podle hranic obcí RÚIAN, když OSM obec neuvádí)
  const { psc, obce } = await buildPscObce(locate, obceRuian, obecAt);
  for (const m of mista) {
    const w = weby[m.id];
    if (w && w.stav === 'ok' && w.sluzby) {
      for (const k of ['prodej', 'servis', 'pujcovna', 'ekola', 'bazar']) if (!m.sl[k] && w.sluzby[k]) m.sl[k] = 'web';
      if (w.sluzby.eshop) m.sl.eshop = 'web';
    }
    if (!m.obec) {
      const o = obecAt(m.lon, m.lat);
      if (o) m.obec = o.nazev;
    }
    for (const k of Object.keys(m.sl)) if (m.sl[k] == null) delete m.sl[k];
    for (const k of ['tel', 'mail', 'web', 'fb']) if (!m[k] || !m[k].length) delete m[k];
    for (const k of ['oteviraci', 'popis', 'znacka', 'adresa', 'obec', 'osm', 'ico', 'icoZdroj', 'bezNazvu']) if (m[k] == null) delete m[k];
  }

  // počet míst na IČO (řetězce) do firem
  const pocty = new Map();
  for (const m of mista) if (m.ico) pocty.set(m.ico, (pocty.get(m.ico) || 0) + 1);
  for (const [ico, f] of Object.entries(firmy)) {
    f.mist = pocty.get(ico) || 0;
    f.velikost = velikost.urci({ zam: f.zam, forma: f.forma, ico }).key;
    for (const k of Object.keys(f)) if (f[k] == null || f[k] === '' || (Array.isArray(f[k]) && !f[k].length)) delete f[k];
  }
  // do firem jen to, co mapa použije
  const firmyOut = {};
  for (const ico of new Set(mista.map((m) => m.ico).filter(Boolean))) if (firmy[ico]) firmyOut[ico] = firmy[ico];

  // weby jen pro místa v datech, bez zbytečností
  const webyOut = {};
  for (const m of mista) {
    const w = weby[m.id];
    if (!w) continue;
    // kontakty znovu přes aktuální filtry (cache webů může být ze starší verze filtrů – smetí, zástupná čísla)
    const emaily = (w.emaily || []).filter((e) => contacts.extractEmails(e).length);
    const telefony = uniq((w.telefony || []).map((t) => contacts.normalizePhone(t)));
    webyOut[m.id] = w.stav === 'ok'
      ? { web: w.web, stav: 'ok', kdy: w.kdy, stranky: w.stranky, emaily, telefony, ico: w.ico, provozovatel: w.provozovatel || undefined, sluzby: w.sluzby, ukazky: w.ukazky, znacky: w.znacky }
      : { web: w.web, stav: 'chyba', chyba: w.chyba, kdy: w.kdy };
  }

  mista.sort((a, b) => a.nazev.localeCompare(b.nazev, 'cs'));
  fs.mkdirSync(OUT, { recursive: true });
  const strip = (fc) => ({ type: 'FeatureCollection', features: fc.map(({ _full, ...f }) => f) });
  writeDataset(OUT, 'hranice', { kraje: strip(hranice.kraje), okresy: strip(hranice.okresy) });
  writeDataset(OUT, 'mista', mista);
  writeDataset(OUT, 'firmy', firmyOut);
  writeDataset(OUT, 'weby', webyOut);
  writeDataset(OUT, 'psc', psc);
  writeDataset(OUT, 'obce', obce);
  const typy = {};
  for (const m of mista) typy[m.typ] = (typy[m.typ] || 0) + 1;
  const vel = {};
  for (const m of mista) {
    const f = m.ico && firmyOut[m.ico];
    const k = f ? f.velikost : 'neznama';
    vel[k] = (vel[k] || 0) + 1;
  }
  writeDataset(OUT, 'meta', {
    vytvoreno: new Date().toISOString(),
    pocty: { mista: mista.length, typy, velikost: vel, firmy: Object.keys(firmyOut).length, sIco: mista.filter((m) => m.ico).length, weby: Object.keys(webyOut).length, webyOk: Object.values(webyOut).filter((w) => w.stav === 'ok').length, psc: Object.keys(psc).length, okresy: okresByKod.size },
    zdroje: [
      { nazev: 'OpenStreetMap (© přispěvatelé OSM, ODbL) přes Overpass API', url: 'https://www.openstreetmap.org/copyright' },
      { nazev: 'ARES – Ministerstvo financí (firmy, sídla, CZ-NACE)', url: 'https://ares.gov.cz/' },
      { nazev: 'RES – ČSÚ (kategorie počtu zaměstnanců)', url: 'https://csu.gov.cz/registr-ekonomickych-subjektu' },
      { nazev: 'ČÚZK RÚIAN – hranice krajů, okresů a obcí, adresní místa (CC BY 4.0)', url: 'https://ags.cuzk.cz/arcgis/rest/services/RUIAN/MapServer' },
      { nazev: 'GeoNames – PSČ a počty obyvatel (CC BY 4.0)', url: 'https://www.geonames.org/' },
    ],
  });
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.js')) log(`${f}: ${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)} kB`);
  log(`hotovo: ${mista.length} míst (${Object.entries(typy).map(([k, v]) => k + ' ' + v).join(', ')}), velikost: ${Object.entries(vel).map(([k, v]) => k + ' ' + v).join(', ')}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { typOsm, relevantniAres, nameSim, nameTokens, vyberIcoZWebu, sloucitDuplicity, CIZI_ICO };
