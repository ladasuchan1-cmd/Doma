'use strict';
// Feature „mapa“ (SPEC kap. 12): mapa okolí půjčovny a tipy na výlety z tenants/<slug>/okoli.json.
//   GET /mapa                      Leaflet mapa (vendor) – statický SVG náhled, mapa se inicializuje až po kliknutí
//                                  „Načíst mapu“ (nebo při scrollu, pokud návštěvník už jednou souhlasil); boční panel
//                                  se seznamem tras, filtrem sítě (?sit=icn,ncn funguje i bez JS) a odkazy Stáhnout GPX
//   GET /mapa/gpx/:file            GPX 1.1 trasy z geom (file = <routeId>.gpx), Content-Type application/gpx+xml,
//                                  Content-Disposition attachment s názvem souboru
//   GET /api/v1/okoli.json         ořezaná data pro klientský JS (trasy, zajímavosti s respektováním poi_overrides,
//                                  půjčovna, podklad, barvy sítí)
//   GET /okoli                     20 tipů jako karty (poiCard) seřazené podle vzdálenosti, filtr typu ?typ=, attribution
//                                  u každého obrázku, admin override poi_overrides (hidden / custom_text / sort)
//   GET /okoli/img/:file           obrázky zajímavostí z tenants/<slug>/okoli/img/ (jen Q<id>.jpg), ETag/304; odkazy nesou
//                                  ?v=<mtime> → s platnou verzí Cache-Control immutable (1 rok), bez ní 1 den
// Rate limit obrázků: stránka /okoli načte 20 obrázků, které by s klíčem 'public' (300/15 min) vyčerpaly limit celého webu
// (QA nález: ~14 zobrazení /okoli z jedné IP → 429 i na /rezervace). Obrázky proto mají vlastní klíč IMAGE_RATE_KEY –
// ratelimit.js pro neznámý profil použije limity 'public', ale kbelík je oddělený (`${key}|${ip}`), takže obrázky nikdy
// nespotřebují tokeny stránek. Vlastní profil s vyšším limitem / statické servírování je požadavek na kostru (TODO-INTEGRACE).
// Podklad: MAPY_API_KEY v env → Mapy.cz outdoor (logo + attribution), jinak CyclOSM. Attribution OSM/CyclOSM je na mapě
// i v patičce (layout). Vstup: ctx (tenant.dir, db). Výstup: stránky / JSON / GPX / obrázky. Bez zápisu do DB.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { publicBaseUrl } = require('../tenants');
const { HttpError } = require('../http/errors');
const { mimeType } = require('../http/static');
const page = require('../render/pages/mapa');

/** Sítě tras – barvy jako v ../cyklo-ski-mapa/app.js (cyklotrasa #d9480f, cyklostezka #c2410c, MTB #7c3aed). */
const NETWORKS = Object.freeze({
  icn: { label: 'Mezinárodní (EuroVelo)', color: '#d9480f', weight: 4, order: 0 },
  ncn: { label: 'Dálkové', color: '#d9480f', weight: 3, order: 1 },
  rcn: { label: 'Regionální', color: '#d9480f', weight: 2.5, order: 2 },
  lcn: { label: 'Místní', color: '#d9480f', weight: 2, order: 3 },
  cyklostezka: { label: 'Cyklostezky', color: '#c2410c', weight: 3, order: 4 },
  mtb: { label: 'MTB', color: '#7c3aed', weight: 2.5, order: 5 },
});

const TILE_ATTRIBUTION = { cyclosm: '© přispěvatelé OpenStreetMap, CyclOSM', mapy: '© Seznam.cz, a.s. a další (Mapy.cz), © přispěvatelé OpenStreetMap' };
const IMAGE_FILE = /^Q\d{1,12}\.jpg$/;
const GPX_FILE = /^([rwnc]\d{1,12})\.gpx$/; // r = relace OSM, c = cyklostezka (way) – id z cyklo-ski-mapa
/** Klíč rate limitu obrázků zajímavostí – oddělený kbelík od 'public' (viz hlavička souboru). */
const IMAGE_RATE_KEY = 'okoli-img';
const IMAGE_CACHE_VERSIONED = 'public, max-age=31536000, immutable';
const IMAGE_CACHE_PLAIN = 'public, max-age=86400';

// --------------------------------------------------------------------------------------------- data
const okoliCache = new Map(); // file → { mtimeMs, data }
const imageVersionCache = new Map(); // dir → { checkedAt, versions: Map(file → verze) }
const IMAGE_VERSION_TTL_MS = 60 * 1000;

/** Načte okoli.json tenanta (cache podle mtime). Bez souboru vrací null. */
function loadOkoli(tenant) {
  const file = path.join(tenant.dir, 'okoli.json');
  try {
    const st = fs.statSync(file);
    const cached = okoliCache.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.data;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data.routes)) data.routes = [];
    if (!Array.isArray(data.pois)) data.pois = [];
    okoliCache.set(file, { mtimeMs: st.mtimeMs, data });
    return data;
  } catch {
    return null;
  }
}

/** Verze souboru obrázku (mtime v base36) pro ?v= – umožňuje Cache-Control immutable. Chybějící soubor → null. */
function imageVersion(tenant, file) {
  if (!tenant || !tenant.dir || !IMAGE_FILE.test(String(file || ''))) return null;
  const dir = path.join(tenant.dir, 'okoli', 'img');
  const now = Date.now();
  let entry = imageVersionCache.get(dir);
  if (!entry || now - entry.checkedAt > IMAGE_VERSION_TTL_MS) {
    entry = { checkedAt: now, versions: new Map() };
    imageVersionCache.set(dir, entry);
  }
  if (entry.versions.has(file)) return entry.versions.get(file);
  let v = null;
  try {
    const st = fs.statSync(path.join(dir, file));
    if (st.isFile()) v = Math.floor(st.mtimeMs).toString(36);
  } catch {
    v = null;
  }
  entry.versions.set(file, v);
  return v;
}

/** URL obrázku zajímavosti (s ?v=, pokud soubor existuje). */
function imageSrc(tenant, file) {
  const base = `/okoli/img/${encodeURIComponent(file)}`;
  const v = imageVersion(tenant, file);
  return v ? `${base}?v=${v}` : base;
}

/** Načte poi_overrides (admin: skrýt, vlastní text, pořadí) → Map(poi_id → row). */
function loadOverrides(db) {
  const out = new Map();
  try {
    for (const row of db.prepare('SELECT poi_id, hidden, custom_text, sort FROM poi_overrides').all()) out.set(String(row.poi_id), row);
  } catch {
    /* tabulka chybí → bez override */
  }
  return out;
}

/** Odkaz „Navigovat v Mapy.cz“ na souřadnice. */
function mapyNavigateUrl(lat, lon) {
  return `https://mapy.cz/zakladni?x=${lon}&y=${lat}&z=15&source=coor&id=${lon}%2C${lat}`;
}

/**
 * Zajímavosti pro výstup: aplikuje poi_overrides, doplní obrázek (src), odkazy; řadí podle sort (override) a vzdálenosti.
 * @param {object} okoli
 * @param {Map} overrides
 * @param {object} [tenant] pro verzované URL obrázků (?v=mtime); bez tenanta URL bez verze
 */
function visiblePois(okoli, overrides, tenant = null) {
  const out = [];
  for (const p of okoli.pois) {
    const o = overrides.get(String(p.id));
    if (o && Number(o.hidden)) continue;
    const img = p.image || null;
    out.push({
      id: p.id,
      name: p.name,
      type: p.type,
      typeKey: p.typeKey || null,
      lat: p.lat,
      lon: p.lon,
      distanceKm: p.distanceKm,
      nearRouteId: p.nearRouteId || null,
      summary: o && o.custom_text ? String(o.custom_text) : p.summary,
      customText: !!(o && o.custom_text),
      wikipediaUrl: p.wikipediaUrl || null,
      mapyUrl: mapyNavigateUrl(p.lat, p.lon),
      sort: o && o.sort !== null && o.sort !== undefined ? Number(o.sort) : null,
      image: img
        ? {
            file: img.file,
            src: tenant ? imageSrc(tenant, img.file) : `/okoli/img/${encodeURIComponent(img.file)}`,
            alt: `${p.name}`,
            author: img.author || null,
            license: img.license || null,
            licenseUrl: img.licenseUrl || null,
            sourceUrl: img.sourceUrl || null,
            width: img.width || null,
            height: img.height || null,
          }
        : null,
    });
  }
  out.sort((a, b) => {
    const sa = a.sort === null ? Number.POSITIVE_INFINITY : a.sort;
    const sb = b.sort === null ? Number.POSITIVE_INFINITY : b.sort;
    return sa - sb || a.distanceKm - b.distanceKm || a.name.localeCompare(b.name, 'cs');
  });
  return out;
}

function networkRank(net) {
  return NETWORKS[net] ? NETWORKS[net].order : 9;
}

/** Trasy pro výstup: síť, barva, GPX odkaz; řazení podle sítě, čísla a názvu. */
function visibleRoutes(okoli) {
  return okoli.routes
    .map((r) => {
      const net = NETWORKS[r.net] ? r.net : r.druh === 'mtb' ? 'mtb' : r.druh === 'cyklostezka' ? 'cyklostezka' : 'lcn';
      return { ...r, net, color: NETWORKS[net].color, weight: NETWORKS[net].weight, netLabel: NETWORKS[net].label, gpxHref: `/mapa/gpx/${encodeURIComponent(r.id)}.gpx` };
    })
    .sort((a, b) => networkRank(a.net) - networkRank(b.net) || refNumber(a.ref) - refNumber(b.ref) || String(a.nazev).localeCompare(String(b.nazev), 'cs'));
}

function refNumber(ref) {
  const n = parseInt(String(ref || ''), 10);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/** Konfigurace podkladu podle env. */
function tilesConfig(ctx) {
  const key = (ctx.app && ctx.app.env && ctx.app.env.MAPY_API_KEY) || process.env.MAPY_API_KEY || '';
  if (key) return { provider: 'mapy', mapyKey: key, attribution: TILE_ATTRIBUTION.mapy };
  return { provider: 'cyclosm', mapyKey: null, attribution: TILE_ATTRIBUTION.cyclosm };
}

function rentalInfo(tenant) {
  const loc = tenant.location || {};
  return { name: tenant.name, lat: loc.lat, lon: loc.lon, address: (tenant.business && tenant.business.address) || '', href: '/kontakt', mapyUrl: loc.lat ? mapyNavigateUrl(loc.lat, loc.lon) : null };
}

/** Filtr sítí z query ?sit=icn,ncn → Set nebo null (vše). */
function networkFilter(query) {
  const raw = String(query.sit || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => Object.hasOwn(NETWORKS, s));
  return raw.length ? new Set(raw) : null;
}

// ---------------------------------------------------------------------------------------------- GPX
function xmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
}

/** Název souboru bez diakritiky a nebezpečných znaků. */
function asciiFilename(s, fallback = 'trasa') {
  const base = String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60);
  return base || fallback;
}

/**
 * GPX 1.1 z geom [[ [lat,lon], … ], …]: jeden <trk>, každý úsek <trkseg>.
 * @param {object} route { id, nazev, ref, net, druh, delkaKm, geom, bbox }
 * @param {{creator?: string, link?: string, time?: Date}} [opts]
 */
function buildGpx(route, { creator = 'Půjčovna kol', link = null, time = new Date() } = {}) {
  const geom = Array.isArray(route.geom) ? route.geom : [];
  const bbox = route.bbox && route.bbox.length === 4 ? route.bbox : null;
  const name = route.nazev || route.id;
  const desc = [route.ref ? `Cyklotrasa č. ${route.ref}` : null, NETWORKS[route.net] ? NETWORKS[route.net].label : null, route.delkaKm ? `délka výřezu ${route.delkaKm} km` : null, 'Zdroj dat: OpenStreetMap (ODbL)'].filter(Boolean).join(' · ');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${xmlEscape(creator)}" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">`,
    '  <metadata>',
    `    <name>${xmlEscape(name)}</name>`,
    `    <desc>${xmlEscape(desc)}</desc>`,
    link ? `    <link href="${xmlEscape(link)}"><text>${xmlEscape(creator)}</text></link>` : null,
    `    <time>${xmlEscape(time.toISOString())}</time>`,
    bbox ? `    <bounds minlat="${bbox[0]}" minlon="${bbox[1]}" maxlat="${bbox[2]}" maxlon="${bbox[3]}"/>` : null,
    '  </metadata>',
    '  <trk>',
    `    <name>${xmlEscape(name)}</name>`,
    route.ref ? `    <cmt>${xmlEscape(`č. ${route.ref}`)}</cmt>` : null,
    `    <type>${xmlEscape(route.druh || 'cyklotrasa')}</type>`,
  ].filter((l) => l !== null);
  for (const seg of geom) {
    if (!Array.isArray(seg) || seg.length < 2) continue;
    lines.push('    <trkseg>');
    for (const pt of seg) lines.push(`      <trkpt lat="${Number(pt[0])}" lon="${Number(pt[1])}"></trkpt>`);
    lines.push('    </trkseg>');
  }
  lines.push('  </trk>', '</gpx>', '');
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------- handlery
function requireOkoli(ctx) {
  const okoli = loadOkoli(ctx.tenant);
  return okoli;
}

async function mapaHandler(ctx) {
  const okoli = requireOkoli(ctx);
  const filter = networkFilter(ctx.query);
  const routes = okoli ? visibleRoutes(okoli) : [];
  const pois = okoli ? visiblePois(okoli, loadOverrides(ctx.db), ctx.tenant) : [];
  const tiles = tilesConfig(ctx);
  const focusPoi = /^Q\d{1,12}$/.test(String(ctx.query.poi || '')) ? String(ctx.query.poi) : null;
  ctx.render(
    page.mapa,
    {
      tenant: ctx.tenant,
      okoli,
      routes,
      pois,
      networks: NETWORKS,
      filter,
      tiles,
      rental: rentalInfo(ctx.tenant),
      focusPoi,
      demo: !!ctx.config.demo,
    },
    { feature: 'mapa', canonicalPath: '/mapa' }
  );
}

async function okoliHandler(ctx) {
  const okoli = requireOkoli(ctx);
  const all = okoli ? visiblePois(okoli, loadOverrides(ctx.db), ctx.tenant) : [];
  const types = [];
  for (const p of all) {
    const t = types.find((x) => x.key === (p.typeKey || p.type));
    if (t) t.count++;
    else types.push({ key: p.typeKey || p.type, label: p.type, count: 1 });
  }
  types.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'cs'));
  const typ = types.some((t) => t.key === ctx.query.typ) ? ctx.query.typ : '';
  const pois = typ ? all.filter((p) => (p.typeKey || p.type) === typ) : all;
  const baseUrl = publicBaseUrl(ctx.tenant, { host: ctx.req.headers.host, secure: ctx.secure });
  ctx.render(page.okoli, { tenant: ctx.tenant, okoli, pois, allCount: all.length, types, typ, rental: rentalInfo(ctx.tenant), baseUrl }, { feature: 'mapa', canonicalPath: typ ? `/okoli?typ=${encodeURIComponent(typ)}` : '/okoli' });
}

async function okoliApi(ctx) {
  const okoli = requireOkoli(ctx);
  const tiles = tilesConfig(ctx);
  const body = {
    ok: true,
    generatedAt: okoli ? okoli.generatedAt : null,
    center: okoli ? okoli.center : { lat: ctx.tenant.location && ctx.tenant.location.lat, lon: ctx.tenant.location && ctx.tenant.location.lon },
    radiusKm: okoli ? okoli.radiusKm : (ctx.tenant.location && ctx.tenant.location.radiusKm) || 25,
    rental: rentalInfo(ctx.tenant),
    tiles: { provider: tiles.provider, attribution: tiles.attribution, mapyKey: tiles.mapyKey || undefined },
    networks: NETWORKS,
    routes: okoli ? visibleRoutes(okoli).map(({ id, nazev, ref, sit, net, druh, delkaKm, delkaCelkemKm, color, weight, netLabel, elevation, bbox, geom, gpxHref }) => ({ id, nazev, ref, sit, net, druh, delkaKm, delkaCelkemKm, color, weight, netLabel, elevation, bbox, geom, gpxHref })) : [],
    pois: okoli ? visiblePois(okoli, loadOverrides(ctx.db), ctx.tenant).map(({ sort, customText, ...p }) => p) : [],
  };
  sendCompressed(ctx, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=600' }, JSON.stringify(body));
}

/** Odešle textovou odpověď gzipem/brotli podle Accept-Encoding (okoli.json má stovky kB). */
function sendCompressed(ctx, headers, text) {
  const buf = Buffer.from(text, 'utf8');
  const ae = String(ctx.req.headers['accept-encoding'] || '').toLowerCase();
  const out = { ...headers, Vary: 'Accept-Encoding' };
  if (buf.length < 1024) return ctx.send(200, out, buf);
  if (/\bbr\b/.test(ae)) return ctx.send(200, { ...out, 'Content-Encoding': 'br' }, zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }));
  if (/\bgzip\b/.test(ae)) return ctx.send(200, { ...out, 'Content-Encoding': 'gzip' }, zlib.gzipSync(buf, { level: 6 }));
  return ctx.send(200, out, buf);
}

async function gpxHandler(ctx) {
  const m = GPX_FILE.exec(String(ctx.params.file || ''));
  if (!m) return ctx.notFound('Soubor GPX nenalezen.');
  const okoli = requireOkoli(ctx);
  const route = okoli && okoli.routes.find((r) => r.id === m[1]);
  if (!route) return ctx.notFound('Trasa nebyla nalezena.');
  const baseUrl = publicBaseUrl(ctx.tenant, { host: ctx.req.headers.host, secure: ctx.secure });
  const gpx = buildGpx({ ...route, net: NETWORKS[route.net] ? route.net : 'lcn' }, { creator: `${ctx.tenant.name} – ${baseUrl.replace(/^https?:\/\//, '')}`, link: `${baseUrl}/mapa` });
  const ascii = `${asciiFilename(route.ref ? `cyklotrasa-${route.ref}-${route.nazev}` : route.nazev, route.id)}.gpx`;
  const utf8 = encodeURIComponent(`${route.nazev || route.id}.gpx`).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  sendCompressed(
    ctx,
    {
      'Content-Type': 'application/gpx+xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`,
      'Cache-Control': 'public, max-age=3600',
    },
    gpx
  );
  return undefined;
}

async function imageHandler(ctx) {
  const name = String(ctx.params.file || '');
  if (!IMAGE_FILE.test(name)) return ctx.notFound('Obrázek nenalezen.');
  const file = path.join(ctx.tenant.dir, 'okoli', 'img', name);
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return ctx.notFound('Obrázek nenalezen.');
  }
  if (!stat.isFile()) return ctx.notFound('Obrázek nenalezen.');
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  // ?v=<mtime> shodné s aktuálním souborem → immutable (prohlížeč se už neptá, neutrácí tokeny rate limitu); jinak 1 den
  const versioned = ctx.query.v !== undefined && String(ctx.query.v) === Math.floor(stat.mtimeMs).toString(36);
  const headers = { 'Content-Type': mimeType(file), 'Cache-Control': versioned ? IMAGE_CACHE_VERSIONED : IMAGE_CACHE_PLAIN, ETag: etag, 'Last-Modified': stat.mtime.toUTCString() };
  const inm = String(ctx.req.headers['if-none-match'] || '');
  if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''))) {
    ctx.send(304, headers, null);
    return undefined;
  }
  ctx.send(200, headers, await fs.promises.readFile(file));
  return undefined;
}

module.exports = {
  name: 'mapa',
  routes: [
    ['GET', '/mapa', mapaHandler, { rateLimit: 'public' }],
    ['GET', '/mapa/gpx/:file', gpxHandler, { rateLimit: 'public' }],
    ['GET', '/api/v1/okoli.json', okoliApi, { rateLimit: 'api' }],
    ['GET', '/okoli', okoliHandler, { rateLimit: 'public' }],
    // vlastní kbelík rate limitu (viz hlavička): 20 obrázků na stránku nesmí vyčerpat limit 'public' celého webu
    ['GET', '/okoli/img/:file', imageHandler, { rateLimit: IMAGE_RATE_KEY }],
  ],
  nav: [
    { label: 'Mapa', href: '/mapa', order: 40 },
    { label: 'Výlety', href: '/okoli', order: 45 },
  ],
  css: ['/vendor/leaflet/leaflet.css', '/css/mapa.css'],
  js: ['/vendor/leaflet/leaflet.js', '/js/mapa.js'],
  NETWORKS,
  TILE_ATTRIBUTION,
  IMAGE_RATE_KEY,
  loadOkoli,
  imageVersion,
  imageSrc,
  loadOverrides,
  visiblePois,
  visibleRoutes,
  networkFilter,
  tilesConfig,
  mapyNavigateUrl,
  buildGpx,
  asciiFilename,
  xmlEscape,
  HttpError,
};
