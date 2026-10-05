#!/usr/bin/env node
'use strict';
// Sestavení dat pro mapu: stáhne (nebo vezme z cache) hranice krajů a okresů (ČÚZK RÚIAN), cyklotrasy,
// cyklostezky, sjezdovky, vleky a skiareály (OpenStreetMap přes SPARQL endpoint QLever; OpenSkiMap) a místa
// (ubytování, půjčovny, cykloprodejny, infocentra) a zapíše je do data/*.js pro statickou aplikaci.
//
//   node tools/build-data.js            # použije cache/, chybějící zdroje stáhne
//   node tools/build-data.js --fetch    # stáhne vše znovu
//   node tools/build-data.js --cache DIR --out DIR
//
// Bez závislostí (Node 22+: fetch, fs). Výstupní soubory: data/hranice.js, data/mista.js, data/trasy.js,
// data/ski.js, data/meta.js – každý nastaví window.CSM_DATA.<název>.

const fs = require('node:fs');
const path = require('node:path');
const geo = require('../lib/geo.js');
const csv = require('../lib/csv.js');
const contacts = require('../lib/contacts.js');
const { fetchText, fetchJson, sparqlCsv, cuzkUrl, OPENSKIMAP_URL, SPARQL_QUERIES } = require('./lib/sources.js');
const { writeDataset } = require('./lib/data-io.js');

const args = parseArgs(process.argv.slice(2));
const ROOT = path.join(__dirname, '..');
const CACHE = path.resolve(args.cache || process.env.CSM_CACHE || path.join(ROOT, 'cache'));
const OUT = path.resolve(args.out || path.join(ROOT, 'data'));
const FORCE = Boolean(args.fetch);

const TOL_ROUTE_M = 25; // zjednodušení cyklotras (metry)
const TOL_PISTE_M = 12;
const TOL_BOUNDARY_M = 40;
const NEAR_ROUTE_M = 3000; // „v okolí“ cyklotrasy
const NEAR_SKI_M = 15000; // „v okolí“ skiareálu

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fetch') out.fetch = true;
    else if (a === '--cache') out.cache = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('node tools/build-data.js [--fetch] [--cache DIR] [--out DIR]');
      process.exit(0);
    }
  }
  return out;
}

function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

// ------------------------------------------------------------------ cache
async function cached(name, loader) {
  const file = path.join(CACHE, name);
  if (!FORCE && fs.existsSync(file) && fs.statSync(file).size > 0) return fs.readFileSync(file, 'utf8');
  log('stahuji', name);
  const text = await loader();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, text);
  return text;
}

// ------------------------------------------------------- pomocné funkce
const OSM_PREFIX = 'https://www.openstreetmap.org/';
const KEY_PREFIX = 'https://www.openstreetmap.org/wiki/Key:';

// IRI → krátké id: node/123 → n123, way/5 → w5, relation/7 → r7
function shortId(iri) {
  const rest = iri.startsWith(OSM_PREFIX) ? iri.slice(OSM_PREFIX.length) : iri;
  const [type, num] = rest.split('/');
  return (type === 'node' ? 'n' : type === 'way' ? 'w' : 'r') + num;
}

function osmPath(id) {
  const t = id[0] === 'n' ? 'node' : id[0] === 'w' ? 'way' : 'relation';
  return `${t}/${id.slice(1)}`;
}

function clean(s) {
  if (s == null) return null;
  const t = String(s).trim();
  return t ? t : null;
}

function num(s) {
  if (s == null || s === '') return null;
  const m = /-?\d+(?:[.,]\d+)?/.exec(String(s).replace(/\s/g, ''));
  if (!m) return null;
  const v = Number(m[0].replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function uniq(arr) {
  return [...new Set(arr.filter((x) => x != null && x !== ''))];
}

// ------------------------------------------------------------- hranice
function featureKraj(f) {
  const p = f.properties;
  return { kod: Number(p.kod), nazev: p.nazev, nuts: p.nutslau };
}

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
  // největší polygon → těžiště; pro Leaflet [lat, lon]
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const biggest = polys.reduce((b, p) => (p[0].length > (b ? b[0].length : 0) ? p : b), null);
  const c = geo.centroid({ polygons: [biggest], lines: [], points: [] });
  return [geo.round(c[1], 4), geo.round(c[0], 4)];
}

async function buildHranice() {
  const krajeRaw = JSON.parse(await cached('kraje_cuzk.geojson', () => fetchText(cuzkUrl(17))));
  const okresyRaw = JSON.parse(await cached('okresy_cuzk.geojson', () => fetchText(cuzkUrl(15))));
  const kraje = krajeRaw.features
    .map((f) => {
      const g = roundGeometry(simplifyGeometry(f.geometry, TOL_BOUNDARY_M), 4);
      return { type: 'Feature', properties: { ...featureKraj(f), stred: labelPoint(f.geometry) }, geometry: g, _full: f.geometry };
    })
    .sort((a, b) => a.properties.nazev.localeCompare(b.properties.nazev, 'cs'));
  const okresy = okresyRaw.features
    .map((f) => {
      const g = roundGeometry(simplifyGeometry(f.geometry, TOL_BOUNDARY_M), 4);
      return {
        type: 'Feature',
        properties: { kod: Number(f.properties.kod), nazev: f.properties.nazev, nuts: f.properties.nutslau, kraj: Number(f.properties.vusc), stred: labelPoint(f.geometry) },
        geometry: g,
        _full: f.geometry,
      };
    })
    .sort((a, b) => a.properties.nazev.localeCompare(b.properties.nazev, 'cs'));
  const krajByKod = new Map(kraje.map((k) => [k.properties.kod, k]));
  for (const o of okresy) if (!krajByKod.has(o.properties.kraj)) throw new Error(`Okres ${o.properties.nazev} má neznámý kraj ${o.properties.kraj}`);
  // RÚIAN vede Prahu jen jako kraj (VÚSC 19), ve vrstvě okresů chybí → doplníme okres 3100 z geometrie kraje
  for (const k of kraje) {
    if (okresy.some((o) => o.properties.kraj === k.properties.kod)) continue;
    okresy.push({
      type: 'Feature',
      properties: { kod: k.properties.kod === 19 ? 3100 : k.properties.kod * 100, nazev: k.properties.nazev, nuts: k.properties.nuts ? k.properties.nuts + '0' : null, kraj: k.properties.kod, stred: k.properties.stred },
      geometry: k.geometry,
      _full: k._full,
    });
  }
  okresy.sort((a, b) => a.properties.nazev.localeCompare(b.properties.nazev, 'cs'));
  log(`hranice: ${kraje.length} krajů, ${okresy.length} okresů`);
  return { kraje, okresy };
}

// Přiřazení bodu do okresu (plná geometrie z ČÚZK pro přesnost, bbox předfiltr).
function makeLocator(hranice) {
  const items = hranice.okresy.map((o) => ({ kod: o.properties.kod, kraj: o.properties.kraj, bbox: geo.bboxOfGeometry(o._full), geom: o._full, simple: o.geometry }));
  return function locate(lon, lat) {
    for (const it of items) {
      if (!geo.bboxContains(it.bbox, lon, lat)) continue;
      if (geo.pointInGeometry(lon, lat, it.geom)) return { okres: it.kod, kraj: it.kraj };
    }
    // mimo přesné hranice (např. hraniční tok) → nejbližší okres podle zjednodušené geometrie se shovívavostí 300 m
    let best = null;
    for (const it of items) {
      if (lon < it.bbox[0] - 0.01 || lon > it.bbox[2] + 0.01 || lat < it.bbox[1] - 0.01 || lat > it.bbox[3] + 0.01) continue;
      const d = distToGeometryM(lon, lat, it.simple);
      if (d < 300 && (!best || d < best.d)) best = { d, okres: it.kod, kraj: it.kraj };
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

// --------------------------------------------------------------- trasy
const NETWORK_LABEL = { icn: 'mezinárodní', ncn: 'dálková', rcn: 'regionální', lcn: 'místní' };

function linesFromWkt(wkt) {
  const parsed = geo.parseWkt(wkt);
  return parsed.lines.filter((l) => l.length >= 2);
}

function routeLabel(r) {
  if (r.nazev) return r.nazev;
  if (r.ref) return (r.druh === 'mtb' ? 'MTB trasa ' : 'Cyklotrasa ') + r.ref;
  return r.druh === 'mtb' ? 'MTB trasa bez označení' : 'Cyklotrasa bez označení';
}

async function buildTrasy(locate) {
  const rows = csv.parseObjects(await cached('routes.csv', () => sparqlCsv(SPARQL_QUERIES.routes)));
  const trasy = [];
  const seenNames = new Set();
  for (const row of rows) {
    const lines = linesFromWkt(row.wkt);
    if (!lines.length) continue;
    const id = shortId(row.r);
    const lengthKm = lines.reduce((s, l) => s + geo.lineLengthKm(l), 0);
    const simple = lines.map((l) => geo.simplify(l, TOL_ROUTE_M));
    const t = {
      id,
      druh: row.route === 'mtb' ? 'mtb' : 'cyklotrasa',
      nazev: clean(row.name),
      ref: clean(row.ref),
      sit: clean(row.network),
      delkaKm: Math.round((num(row.distance) || lengthKm) * 10) / 10,
      operator: clean(row.operator),
      web: contacts.normalizeWebsite(row.website),
      popis: clean(row.description) || [clean(row.from), clean(row.to)].filter(Boolean).join(' – ') || null,
      osm: osmPath(id),
    };
    t.label = routeLabel(t);
    finishLine(t, simple, locate);
    trasy.push(t);
    if (t.nazev) seenNames.add(normName(t.nazev));
  }
  log(`cyklotrasy: ${trasy.length} relací`);

  // pojmenované cyklostezky (highway=cycleway) seskupené podle názvu; stejnojmenné relace mají přednost
  const cw = csv.parseObjects(await cached('cycleways.csv', () => sparqlCsv(SPARQL_QUERIES.cycleways)));
  const groups = new Map();
  for (const row of cw) {
    const name = clean(row.name);
    if (!name) continue;
    const key = normName(name);
    if (seenNames.has(key)) continue;
    const lines = linesFromWkt(row.wkt);
    if (!lines.length) continue;
    let g = groups.get(key);
    if (!g) {
      g = { nazev: name, ref: clean(row.ref), lines: [], surfaces: new Set(), ids: [] };
      groups.set(key, g);
    }
    g.lines.push(...lines);
    if (row.surface) g.surfaces.add(row.surface);
    g.ids.push(shortId(row.w));
  }
  let n = 0;
  for (const [, g] of groups) {
    const t = {
      id: 'c' + g.ids[0].slice(1),
      druh: 'cyklostezka',
      nazev: g.nazev,
      ref: g.ref,
      sit: null,
      delkaKm: Math.round(g.lines.reduce((s, l) => s + geo.lineLengthKm(l), 0) * 10) / 10,
      operator: null,
      web: null,
      popis: g.surfaces.size ? 'povrch: ' + [...g.surfaces].join(', ') : null,
      osm: osmPath(g.ids[0]),
      useku: g.ids.length,
    };
    t.label = t.nazev;
    finishLine(t, g.lines.map((l) => geo.simplify(l, TOL_ROUTE_M)), locate);
    trasy.push(t);
    n++;
  }
  log(`cyklostezky: ${n} pojmenovaných (z ${cw.length} úseků)`);
  trasy.sort((a, b) => a.label.localeCompare(b.label, 'cs'));
  return trasy;
}

// Doplní okresy/kraje, bbox a geometrii [lat,lon] podle (zjednodušených) linií.
function finishLine(t, lines, locate) {
  const okresy = new Set();
  const kraje = new Set();
  let bbox = null;
  for (const l of lines) {
    bbox = geo.bboxOf(l, bbox);
    const step = Math.max(1, Math.floor(l.length / 60)); // vzorkování vrcholů pro přiřazení do okresů
    for (let i = 0; i < l.length; i += step) {
      const loc = locate(l[i][0], l[i][1]);
      if (loc) {
        okresy.add(loc.okres);
        kraje.add(loc.kraj);
      }
    }
    const last = locate(l[l.length - 1][0], l[l.length - 1][1]);
    if (last) {
      okresy.add(last.okres);
      kraje.add(last.kraj);
    }
  }
  t.okresy = [...okresy];
  t.kraje = [...kraje];
  t.bbox = bbox ? [geo.round(bbox[1], 4), geo.round(bbox[0], 4), geo.round(bbox[3], 4), geo.round(bbox[2], 4)] : null; // [S, Z, J, V] jako Leaflet [[lat,lon],[lat,lon]] zploštěle
  t.geom = lines.map((l) => geo.toLatLng(l, 5));
  t.body = lines.reduce((s, l) => s + l.length, 0);
}

// ------------------------------------------------------------------ ski
const DIFF_LABEL = { novice: 'lehká', easy: 'lehká', intermediate: 'střední', advanced: 'těžká', expert: 'těžká', freeride: 'freeride', extreme: 'těžká' };

async function buildSki(locate) {
  const osmAreas = csv.parseObjects(await cached('winter_sports.csv', () => sparqlCsv(SPARQL_QUERIES.winter_sports)));
  const pistesRows = csv.parseObjects(await cached('pistes.csv', () => sparqlCsv(SPARQL_QUERIES.pistes)));
  const liftRows = csv.parseObjects(await cached('aerialways.csv', () => sparqlCsv(SPARQL_QUERIES.aerialways)));
  const skimap = JSON.parse(await cached('openskimap_ski_areas.geojson', () => fetchText(OPENSKIMAP_URL)));

  // 1) skiareály z OpenSkiMap (ČR) – název, web, statistiky
  const arealy = [];
  for (const f of skimap.features) {
    const p = f.properties || {};
    const places = Array.isArray(p.places) ? p.places : [];
    if (!places.some((pl) => pl && pl.iso3166_1Alpha2 === 'CZ')) continue;
    const stats = p.statistics || {};
    const runs = ((stats.runs || {}).byActivity || {}).downhill || {};
    const byDiff = runs.byDifficulty || {};
    const lifts = (stats.lifts || {}).byType || {};
    const runCount = Object.values(byDiff).reduce((s, d) => s + (d.count || 0), 0);
    const runKm = Object.values(byDiff).reduce((s, d) => s + (d.lengthInKm || 0), 0);
    const liftCount = Object.values(lifts).reduce((s, d) => s + (d.count || 0), 0);
    const hasDownhill = (p.activities || []).includes('downhill') || runCount > 0;
    if (!hasDownhill && liftCount === 0) continue;
    const parsed = geo.parseWkt(geometryToWkt(f.geometry));
    const c = geo.centroid(parsed);
    if (!c) continue;
    const region = places.find((pl) => pl.iso3166_1Alpha2 === 'CZ');
    arealy.push({
      id: 'osk-' + String(p.id || '').slice(0, 12),
      nazev: clean(p.name) || 'Skiareál bez názvu',
      stav: p.status || 'unknown',
      lat: geo.round(c[1]),
      lon: geo.round(c[0]),
      web: uniq((p.websites || []).map((w) => contacts.normalizeWebsite(w))),
      sjezdovky: { pocet: runCount, km: Math.round(runKm * 10) / 10, obtiznost: Object.fromEntries(Object.entries(byDiff).map(([k, v]) => [DIFF_LABEL[k] || k, v.count || 0])) },
      vleky: { pocet: liftCount, typy: Object.fromEntries(Object.entries(lifts).map(([k, v]) => [k, v.count || 0])) },
      vyska: stats.maxElevation && stats.minElevation ? [Math.round(stats.minElevation), Math.round(stats.maxElevation)] : null,
      region: region && region.localized && region.localized.en ? region.localized.en.region : null,
      zdroj: 'openskimap',
      operator: null,
      telefon: null,
      email: null,
      osm: null,
      _poly: parsed.polygons.length ? parsed.polygons : null,
    });
  }
  log(`skiareály (OpenSkiMap, ČR): ${arealy.length}`);

  // 2) OSM landuse=winter_sports – doplní kontakty / přidá chybějící areály
  let matched = 0;
  for (const row of osmAreas) {
    const parsed = geo.parseWkt(row.wkt);
    const c = geo.centroid(parsed);
    if (!c) continue;
    const name = clean(row.name);
    let best = null;
    for (const a of arealy) {
      const inside = a._poly && a._poly.some((rings) => geo.pointInPolygon(c[0], c[1], rings));
      const d = inside ? 0 : geo.haversineM(c[1], c[0], a.lat, a.lon);
      const sameName = name && normName(name) === normName(a.nazev);
      if (d < 1500 || sameName) {
        const score = d - (sameName ? 5000 : 0);
        if (!best || score < best.score) best = { a, score };
      }
    }
    const target = best ? best.a : null;
    if (target) {
      matched++;
      target.osm = osmPath(shortId(row.a));
      target.operator = target.operator || clean(row.operator);
      target.telefon = target.telefon || contacts.normalizePhone(row.phone);
      target.email = target.email || clean(row.email);
      const w = contacts.normalizeWebsite(row.website);
      if (w && !target.web.includes(w)) target.web.push(w);
      if (!target._poly && parsed.polygons.length) target._poly = parsed.polygons;
    } else {
      arealy.push({
        id: shortId(row.a),
        nazev: name || 'Skiareál bez názvu',
        stav: 'unknown',
        lat: geo.round(c[1]),
        lon: geo.round(c[0]),
        web: uniq([contacts.normalizeWebsite(row.website)]),
        sjezdovky: { pocet: 0, km: 0, obtiznost: {} },
        vleky: { pocet: 0, typy: {} },
        vyska: null,
        region: null,
        zdroj: 'osm',
        operator: clean(row.operator),
        telefon: contacts.normalizePhone(row.phone),
        email: clean(row.email),
        osm: osmPath(shortId(row.a)),
        _poly: parsed.polygons.length ? parsed.polygons : null,
      });
    }
  }
  log(`OSM winter_sports: ${osmAreas.length} ploch, ${matched} spárováno s OpenSkiMap`);

  // 3) sjezdovky a vleky → přiřadit k areálu (uvnitř plochy, jinak nejbližší do 2,5 km)
  function assign(lines) {
    const pts = lines.flat();
    const mid = pts[Math.floor(pts.length / 2)];
    let best = null;
    for (const a of arealy) {
      const inside = a._poly && a._poly.some((rings) => geo.pointInPolygon(mid[0], mid[1], rings));
      const d = inside ? 0 : geo.haversineM(mid[1], mid[0], a.lat, a.lon);
      if (d <= 2500 && (!best || d < best.d)) best = { a, d };
    }
    return best ? best.a : null;
  }

  const sjezdovky = [];
  const perArea = new Map();
  for (const row of pistesRows) {
    const lines = linesFromWkt(row.wkt);
    const polys = geo.parseWkt(row.wkt).polygons;
    const geomLines = lines.length ? lines : polys.map((p) => p[0]);
    if (!geomLines.length) continue;
    const area = assign(geomLines);
    const id = shortId(row.w);
    const lengthKm = lines.reduce((s, l) => s + geo.lineLengthKm(l), 0);
    const s = {
      id,
      nazev: clean(row.name),
      obtiznost: DIFF_LABEL[row.difficulty] || clean(row.difficulty),
      osvetlena: /^(yes|true)$/i.test(row.lit || ''),
      upravovana: clean(row.grooming),
      delkaKm: Math.round(lengthKm * 100) / 100,
      areal: area ? area.id : null,
      geom: geomLines.map((l) => geo.toLatLng(geo.simplify(l, TOL_PISTE_M), 5)),
      osm: osmPath(id),
    };
    sjezdovky.push(s);
    if (area) {
      const agg = perArea.get(area.id) || { pocet: 0, km: 0, obt: {}, vleky: 0 };
      agg.pocet++;
      agg.km += lengthKm;
      if (s.obtiznost) agg.obt[s.obtiznost] = (agg.obt[s.obtiznost] || 0) + 1;
      perArea.set(area.id, agg);
    }
  }
  const vleky = [];
  for (const row of liftRows) {
    const lines = linesFromWkt(row.wkt);
    if (!lines.length) continue;
    const area = assign(lines);
    const id = shortId(row.w);
    vleky.push({ id, typ: row.type, nazev: clean(row.name), areal: area ? area.id : null, geom: lines.map((l) => geo.toLatLng(l, 5)), osm: osmPath(id) });
    if (area) {
      const agg = perArea.get(area.id) || { pocet: 0, km: 0, obt: {}, vleky: 0 };
      agg.vleky++;
      perArea.set(area.id, agg);
    }
  }
  // sjezdovky bez areálu, ale pojmenované → vlastní „areál“ podle názvu v okruhu 1 km
  const orphans = sjezdovky.filter((s) => !s.areal);
  const orphanGroups = [];
  for (const s of orphans) {
    const p = s.geom[0][Math.floor(s.geom[0].length / 2)];
    let g = orphanGroups.find((og) => geo.haversineM(p[0], p[1], og.lat, og.lon) < 1000);
    if (!g) {
      g = { lat: p[0], lon: p[1], items: [], names: new Map() };
      orphanGroups.push(g);
    }
    g.items.push(s);
    if (s.nazev) g.names.set(s.nazev, (g.names.get(s.nazev) || 0) + 1);
  }
  for (const g of orphanGroups) {
    const name = [...g.names.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0])[0];
    const id = 'g' + g.items[0].id.slice(1);
    const a = {
      id,
      nazev: name ? (/ski|areál|areal|vlek|sjezdovka/i.test(name) ? name : 'Sjezdovka ' + name) : 'Sjezdovka bez názvu',
      stav: 'unknown',
      lat: geo.round(g.lat),
      lon: geo.round(g.lon),
      web: [],
      sjezdovky: { pocet: 0, km: 0, obtiznost: {} },
      vleky: { pocet: 0, typy: {} },
      vyska: null,
      region: null,
      zdroj: 'osm-sjezdovky',
      operator: null,
      telefon: null,
      email: null,
      osm: g.items[0].osm,
      _poly: null,
    };
    arealy.push(a);
    const agg = { pocet: 0, km: 0, obt: {}, vleky: 0 };
    for (const s of g.items) {
      s.areal = id;
      agg.pocet++;
      agg.km += s.delkaKm;
      if (s.obtiznost) agg.obt[s.obtiznost] = (agg.obt[s.obtiznost] || 0) + 1;
    }
    perArea.set(id, agg);
  }

  for (const a of arealy) {
    const agg = perArea.get(a.id);
    if (agg && agg.pocet) {
      a.sjezdovky = { pocet: agg.pocet, km: Math.round(agg.km * 10) / 10, obtiznost: agg.obt };
    }
    if (agg && agg.vleky && !a.vleky.pocet) a.vleky.pocet = agg.vleky;
    const loc = locate(a.lon, a.lat);
    a.okres = loc ? loc.okres : null;
    a.kraj = loc ? loc.kraj : null;
    a.polygon = a._poly ? a._poly.map((rings) => geo.toLatLng(geo.simplify(rings[0], 15), 5)) : null;
    delete a._poly;
  }
  // areály bez jediné sjezdovky i vleku (jen bod z OpenSkiMap bez dat) necháme – mají aspoň název a polohu
  arealy.sort((a, b) => a.nazev.localeCompare(b.nazev, 'cs'));
  log(`skiareály celkem: ${arealy.length}, sjezdovky: ${sjezdovky.length} (${orphans.length} bez areálu → ${orphanGroups.length} skupin), vleky: ${vleky.length}`);
  return { arealy, sjezdovky, vleky };
}

function geometryToWkt(geometry) {
  if (!geometry) return '';
  const c = (p) => `${p[0]} ${p[1]}`;
  if (geometry.type === 'Point') return `POINT(${c(geometry.coordinates)})`;
  if (geometry.type === 'Polygon') return `POLYGON(${geometry.coordinates.map((r) => '(' + r.map(c).join(',') + ')').join(',')})`;
  if (geometry.type === 'MultiPolygon') return `MULTIPOLYGON(${geometry.coordinates.map((poly) => '(' + poly.map((r) => '(' + r.map(c).join(',') + ')').join(',') + ')').join(',')})`;
  if (geometry.type === 'LineString') return `LINESTRING(${geometry.coordinates.map(c).join(',')})`;
  return '';
}

// ---------------------------------------------------------------- místa
const TYP = {
  'tourism=hotel': ['hotel', 'ubytovani', 'Hotel'],
  'tourism=guest_house': ['penzion', 'ubytovani', 'Penzion'],
  'tourism=chalet': ['chata', 'ubytovani', 'Chata / chalupa'],
  'tourism=hostel': ['hostel', 'ubytovani', 'Hostel'],
  'tourism=motel': ['motel', 'ubytovani', 'Motel'],
  'tourism=apartment': ['apartman', 'ubytovani', 'Apartmány'],
  'tourism=alpine_hut': ['horska_chata', 'ubytovani', 'Horská chata / bouda'],
  'tourism=camp_site': ['kemp', 'ubytovani', 'Kemp'],
  'information=office': ['infocentrum', 'infocentrum', 'Infocentrum'],
  'information=visitor_centre': ['infocentrum', 'infocentrum', 'Návštěvnické centrum'],
  'amenity=bicycle_rental': ['pujcovna_kol', 'pujcovna', 'Půjčovna kol'],
  'amenity=ski_rental': ['pujcovna_lyzi', 'pujcovna', 'Půjčovna lyží'],
  'amenity=ski_school': ['lyzarska_skola', 'pujcovna', 'Lyžařská škola'],
  'shop=bicycle': ['cykloprodejna', 'pujcovna', 'Cykloprodejna / servis'],
  'shop=ski': ['lyzarsky_obchod', 'pujcovna', 'Lyžařský obchod / servis'],
  'shop=rental': ['pujcovna', 'pujcovna', 'Půjčovna'],
  'shop=sports': ['sport', 'pujcovna', 'Sportovní obchod'],
  'shop=outdoor': ['outdoor', 'pujcovna', 'Outdoorový obchod'],
};
// priorita druhu, když má místo více štítků (půjčovna > ubytování > infocentrum > obchod)
const TYP_PRIORITY = ['amenity=bicycle_rental', 'amenity=ski_rental', 'shop=rental', 'tourism=hotel', 'tourism=guest_house', 'tourism=alpine_hut', 'tourism=chalet', 'tourism=hostel', 'tourism=motel', 'tourism=apartment', 'tourism=camp_site', 'information=office', 'information=visitor_centre', 'shop=bicycle', 'shop=ski', 'amenity=ski_school', 'shop=sports', 'shop=outdoor'];

function rentalFromTags(kinds, tags) {
  const yes = (v) => v && /^(yes|true|only|designated|\d+)$/i.test(v);
  const no = (v) => v && /^(no|false)$/i.test(v);
  const druhy = new Set();
  let stav = null;
  if (kinds.includes('amenity=bicycle_rental')) {
    stav = 'ano';
    druhy.add('kola');
  }
  if (kinds.includes('amenity=ski_rental')) {
    stav = 'ano';
    druhy.add('lyže');
  }
  if (yes(tags['service:bicycle:rental'])) {
    stav = 'ano';
    druhy.add('kola');
  }
  if (yes(tags.bicycle_rental)) {
    stav = 'ano';
    druhy.add('kola');
  }
  if (yes(tags.ski_rental)) {
    stav = 'ano';
    druhy.add('lyže');
  }
  const rental = (tags.rental || '').toLowerCase();
  if (rental) {
    if (/bicycle|bike|ebike|e-bike|kolo|kola/.test(rental)) {
      stav = 'ano';
      druhy.add('kola');
    }
    if (/ski|snowboard|lyž|běžk/.test(rental)) {
      stav = 'ano';
      druhy.add('lyže');
    }
    if (!druhy.size && kinds.includes('shop=rental')) stav = stav || 'ano';
  }
  if (kinds.includes('shop=rental') && !stav) stav = 'ano';
  if (!stav && no(tags['service:bicycle:rental']) && !yes(tags.ski_rental)) stav = 'ne';
  return { stav, druhy: [...druhy] };
}

async function buildMista(locate, trasy, ski) {
  const geomRows = csv.parseObjects(await cached('poi_geom.csv', () => sparqlCsv(SPARQL_QUERIES.poi_geom)));
  const tagRows = csv.parseObjects(await cached('poi_tags.csv', () => sparqlCsv(SPARQL_QUERIES.poi_tags)));
  const tags = new Map();
  for (const row of tagRows) {
    const id = shortId(row.p);
    const key = row.k.startsWith(KEY_PREFIX) ? row.k.slice(KEY_PREFIX.length) : row.k;
    let t = tags.get(id);
    if (!t) {
      t = {};
      tags.set(id, t);
    }
    if (t[key] == null) t[key] = row.v;
  }

  const byId = new Map();
  for (const row of geomRows) {
    const id = shortId(row.p);
    let m = byId.get(id);
    if (!m) {
      const parsed = geo.parseWkt(row.wkt);
      const c = geo.centroid(parsed);
      if (!c) continue;
      m = { id, kinds: [], lon: c[0], lat: c[1] };
      byId.set(id, m);
    }
    if (!m.kinds.includes(row.kind)) m.kinds.push(row.kind);
  }

  // index linií tras a sjezdovek pro „v okolí“
  const routeGrid = new geo.SegmentGrid(0.02);
  for (const t of trasy) for (const l of t.geom) routeGrid.addLine(l.map((p) => [p[1], p[0]]), t.id);
  const skiGrid = new geo.SegmentGrid(0.05);
  for (const s of ski.sjezdovky) if (s.areal) for (const l of s.geom) skiGrid.addLine(l.map((p) => [p[1], p[0]]), s.areal);
  const skiPoints = ski.arealy.map((a) => ({ id: a.id, lat: a.lat, lon: a.lon }));

  const mista = [];
  let noName = 0;
  let noOkres = 0;
  for (const m of byId.values()) {
    const t = tags.get(m.id) || {};
    const kinds = m.kinds.slice().sort((a, b) => TYP_PRIORITY.indexOf(a) - TYP_PRIORITY.indexOf(b));
    const main = TYP[kinds[0]];
    if (!main) continue;
    const loc = locate(m.lon, m.lat);
    if (!loc) noOkres++;
    let nazev = clean(t.name) || clean(t['name:cs']) || clean(t.official_name) || clean(t.brand) || clean(t.operator);
    // „1“, „č. 12“, „E 5“ – evidenční čísla chat a stánků nejsou názvy
    const jenCislo = nazev && (/^[\d\s\-/.,]+$/.test(nazev) || /^(č\.?|čp\.?|ev\.?\s*č\.?|e)\s*\d+$/i.test(nazev) || nazev.length < 3);
    if (jenCislo) nazev = null;
    if (!nazev) noName++;
    const telefony = uniq([t.phone, t['contact:phone'], t.mobile, t['contact:mobile']].flatMap((v) => (v ? String(v).split(/[;,]/) : [])).map((v) => contacts.normalizePhone(v)));
    const emaily = uniq([t.email, t['contact:email']].flatMap((v) => (v ? String(v).toLowerCase().split(/[;,\s]+/) : [])).filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e)));
    const weby = uniq([t.website, t['contact:website'], t.url].map((v) => contacts.normalizeWebsite(v)));
    const social = uniq([t['contact:facebook'], t.facebook].map((v) => (v && /facebook\.com/i.test(v) ? contacts.normalizeWebsite(v) : v && /^[\w.-]+$/.test(v) ? 'https://www.facebook.com/' + v : null)));
    const ulice = [clean(t['addr:street']) || clean(t['addr:place']), [clean(t['addr:conscriptionnumber']), clean(t['addr:streetnumber'])].filter(Boolean).join('/') || clean(t['addr:housenumber'])].filter(Boolean).join(' ');
    const obec = clean(t['addr:city']) || clean(t['addr:suburb']) || (clean(t['addr:place']) && !clean(t['addr:street']) ? null : null);
    const rental = rentalFromTags(kinds, t);
    const near = [...routeGrid.within(m.lon, m.lat, NEAR_ROUTE_M)].sort((a, b) => a[1] - b[1]).slice(0, 3).map(([id, d]) => [id, Math.round(d)]);
    const nearSki = new Map();
    for (const [id, d] of skiGrid.within(m.lon, m.lat, NEAR_SKI_M)) nearSki.set(id, d);
    for (const a of skiPoints) {
      const d = geo.haversineM(m.lat, m.lon, a.lat, a.lon);
      if (d <= NEAR_SKI_M && (!nearSki.has(a.id) || d < nearSki.get(a.id))) nearSki.set(a.id, d);
    }
    const nearSkiArr = [...nearSki].sort((a, b) => a[1] - b[1]).slice(0, 2).map(([id, d]) => [id, Math.round(d)]);

    mista.push({
      id: m.id,
      typ: main[0],
      skupina: main[1],
      typLabel: main[2],
      stitky: kinds,
      nazev: nazev || (jenCislo ? `${main[2]} ${clean(t.name)}` : `${main[2]} bez názvu`),
      bezNazvu: !nazev,
      lat: geo.round(m.lat),
      lon: geo.round(m.lon),
      okres: loc ? loc.okres : null,
      kraj: loc ? loc.kraj : null,
      obec,
      adresa: [ulice, [clean(t['addr:postcode']), obec].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null,
      operator: clean(t.operator),
      telefon: telefony,
      email: emaily,
      web: weby,
      social,
      pujcovna: rental.stav,
      pujcovnaDruh: rental.druhy,
      hvezdy: num(t.stars),
      kapacita: num(t.rooms) || num(t.beds) || num(t.capacity),
      oteviraci: clean(t.opening_hours),
      popis: clean(t.description),
      sport: clean(t.sport),
      osm: osmPath(m.id),
      blizko: { trasy: near, ski: nearSkiArr },
    });
  }
  mista.sort((a, b) => a.nazev.localeCompare(b.nazev, 'cs'));
  log(`místa: ${mista.length} (bez názvu ${noName}, mimo okresy ${noOkres})`);
  return mista;
}

// ----------------------------------------------------------------- main
async function main() {
  log(`cache: ${CACHE}`);
  log(`výstup: ${OUT}`);
  const hranice = await buildHranice();
  const locate = makeLocator(hranice);
  const trasy = await buildTrasy(locate);
  const ski = await buildSki(locate);
  const mista = await buildMista(locate, trasy, ski);

  fs.mkdirSync(OUT, { recursive: true });
  const strip = (fc) => ({ type: 'FeatureCollection', features: fc.map(({ _full, ...f }) => f) });
  writeDataset(OUT, 'hranice', { kraje: strip(hranice.kraje), okresy: strip(hranice.okresy) });
  writeDataset(OUT, 'trasy', trasy);
  writeDataset(OUT, 'ski', ski);
  writeDataset(OUT, 'mista', mista);
  const meta = {
    vytvoreno: new Date().toISOString(),
    pocty: {
      kraje: hranice.kraje.length,
      okresy: hranice.okresy.length,
      trasy: trasy.length,
      cyklotrasy: trasy.filter((t) => t.druh === 'cyklotrasa').length,
      mtb: trasy.filter((t) => t.druh === 'mtb').length,
      cyklostezky: trasy.filter((t) => t.druh === 'cyklostezka').length,
      skiarealy: ski.arealy.length,
      sjezdovky: ski.sjezdovky.length,
      vleky: ski.vleky.length,
      mista: mista.length,
      ubytovani: mista.filter((m) => m.skupina === 'ubytovani').length,
      pujcovny: mista.filter((m) => m.skupina === 'pujcovna').length,
      infocentra: mista.filter((m) => m.skupina === 'infocentrum').length,
    },
    zdroje: [
      { nazev: 'OpenStreetMap (© přispěvatelé OSM, ODbL) přes QLever osm-planet', url: 'https://qlever.dev/osm-planet' },
      { nazev: 'OpenSkiMap.org – skiareály', url: 'https://openskimap.org/' },
      { nazev: 'ČÚZK RÚIAN – hranice krajů a okresů (CC BY 4.0)', url: 'https://ags.cuzk.cz/arcgis/rest/services/RUIAN/MapServer' },
    ],
    okoli: { trasyM: NEAR_ROUTE_M, skiM: NEAR_SKI_M },
  };
  writeDataset(OUT, 'meta', meta);
  for (const f of fs.readdirSync(OUT)) {
    if (f.endsWith('.js')) log(`${f}: ${(fs.statSync(path.join(OUT, f)).size / 1024 / 1024).toFixed(2)} MB`);
  }
  log('hotovo');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
