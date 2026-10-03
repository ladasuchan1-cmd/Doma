'use strict';
// Zdroje dat: SPARQL dotazy nad OSM (QLever osm-planet), ČÚZK RÚIAN (ArcGIS REST) a OpenSkiMap.
// Jen stahování – zpracování je v build-data.js.

const QLEVER_ENDPOINT = process.env.CSM_QLEVER || 'https://qlever.dev/api/osm-planet';
const CZ_RELATION = 'osmrel:51684'; // relace hranic Česka v OSM
const OPENSKIMAP_URL = 'https://tiles.openskimap.org/geojson/ski_areas.geojson';
const CUZK_BASE = 'https://ags.cuzk.cz/arcgis/rest/services/RUIAN/MapServer';
const USER_AGENT = 'cyklo-ski-mapa/0.1 (+https://github.com/ladasuchan1-cmd/Doma)';

const PREFIXES = `PREFIX osmkey: <https://www.openstreetmap.org/wiki/Key:>
PREFIX osmrel: <https://www.openstreetmap.org/relation/>
PREFIX ogc: <http://www.opengis.net/rdf#>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
`;

// Výběr míst: ubytování, infocentra, půjčovny a obchody (cyklo/lyže/sport).
const POI_UNION = `  { ?p osmkey:tourism ?t . FILTER(?t IN ("hotel","guest_house","chalet","hostel","motel","apartment","alpine_hut","camp_site")) BIND(CONCAT("tourism=",?t) AS ?kind) }
  UNION { ?p osmkey:tourism "information" . ?p osmkey:information ?t . FILTER(?t IN ("office","visitor_centre")) BIND(CONCAT("information=",?t) AS ?kind) }
  UNION { ?p osmkey:shop ?t . FILTER(?t IN ("bicycle","ski","sports","outdoor","rental")) BIND(CONCAT("shop=",?t) AS ?kind) }
  UNION { ?p osmkey:amenity ?t . FILTER(?t IN ("bicycle_rental","ski_rental","ski_school")) BIND(CONCAT("amenity=",?t) AS ?kind) }`;

const POI_KEYS = [
  'name', 'name:cs', 'official_name', 'alt_name', 'brand', 'operator',
  'phone', 'contact:phone', 'mobile', 'contact:mobile', 'email', 'contact:email',
  'website', 'contact:website', 'url', 'contact:facebook', 'facebook',
  'addr:street', 'addr:housenumber', 'addr:conscriptionnumber', 'addr:streetnumber', 'addr:city', 'addr:place', 'addr:suburb', 'addr:postcode',
  'opening_hours', 'description', 'stars', 'rooms', 'beds', 'capacity',
  'rental', 'service:bicycle:rental', 'service:bicycle:retail', 'service:bicycle:repair', 'bicycle_rental', 'ski_rental', 'ski', 'sport',
  'tourism', 'shop', 'amenity', 'information',
];

const SPARQL_QUERIES = {
  poi_geom: `SELECT ?p ?kind ?wkt WHERE {
  ${CZ_RELATION} ogc:sfContains ?p .
${POI_UNION}
  ?p geo:hasGeometry/geo:asWKT ?wkt .
}`,
  // tagy přes VALUES na pevnou sadu klíčů (obecné ?p ?k ?v s FILTER je na QLeveru příliš pomalé)
  poi_tags: `SELECT ?p ?k ?v WHERE {
  ${CZ_RELATION} ogc:sfContains ?p .
${POI_UNION.replace(/ BIND\(CONCAT\([^)]*\) AS \?kind\)/g, '')}
  VALUES ?k { ${POI_KEYS.map((k) => 'osmkey:' + k).join(' ')} }
  ?p ?k ?v .
}`,
  routes: `SELECT ?r ?route ?name ?ref ?network ?distance ?operator ?website ?description ?from ?to ?wkt WHERE {
  ${CZ_RELATION} ogc:sfIntersects ?r .
  ?r osmkey:route ?route . FILTER(?route IN ("bicycle","mtb"))
  OPTIONAL { ?r osmkey:name ?name }
  OPTIONAL { ?r osmkey:ref ?ref }
  OPTIONAL { ?r osmkey:network ?network }
  OPTIONAL { ?r osmkey:distance ?distance }
  OPTIONAL { ?r osmkey:operator ?operator }
  OPTIONAL { ?r osmkey:website ?website }
  OPTIONAL { ?r osmkey:description ?description }
  OPTIONAL { ?r osmkey:from ?from }
  OPTIONAL { ?r osmkey:to ?to }
  ?r geo:hasGeometry/geo:asWKT ?wkt .
}`,
  cycleways: `SELECT ?w ?name ?ref ?surface ?wkt WHERE {
  ${CZ_RELATION} ogc:sfContains ?w .
  ?w osmkey:highway "cycleway" .
  ?w osmkey:name ?name .
  OPTIONAL { ?w osmkey:ref ?ref }
  OPTIONAL { ?w osmkey:surface ?surface }
  ?w geo:hasGeometry/geo:asWKT ?wkt .
}`,
  pistes: `SELECT ?w ?name ?difficulty ?grooming ?ref ?operator ?website ?lit ?wkt WHERE {
  ${CZ_RELATION} ogc:sfIntersects ?w .
  ?w osmkey:piste:type "downhill" .
  FILTER(STRSTARTS(STR(?w), "https://www.openstreetmap.org/way/"))
  OPTIONAL { ?w osmkey:name ?name }
  OPTIONAL { ?w osmkey:piste:difficulty ?difficulty }
  OPTIONAL { ?w osmkey:piste:grooming ?grooming }
  OPTIONAL { ?w osmkey:ref ?ref }
  OPTIONAL { ?w osmkey:operator ?operator }
  OPTIONAL { ?w osmkey:website ?website }
  OPTIONAL { ?w osmkey:piste:lit ?lit }
  ?w geo:hasGeometry/geo:asWKT ?wkt .
}`,
  aerialways: `SELECT ?w ?type ?name ?operator ?website ?wkt WHERE {
  ${CZ_RELATION} ogc:sfIntersects ?w .
  ?w osmkey:aerialway ?type . FILTER(?type IN ("drag_lift","t-bar","platter","chair_lift","gondola","cable_car","rope_tow","magic_carpet","j-bar","mixed_lift"))
  FILTER(STRSTARTS(STR(?w), "https://www.openstreetmap.org/way/"))
  OPTIONAL { ?w osmkey:name ?name }
  OPTIONAL { ?w osmkey:operator ?operator }
  OPTIONAL { ?w osmkey:website ?website }
  ?w geo:hasGeometry/geo:asWKT ?wkt .
}`,
  winter_sports: `SELECT ?a ?name ?operator ?website ?phone ?email ?wkt WHERE {
  ${CZ_RELATION} ogc:sfIntersects ?a .
  ?a osmkey:landuse "winter_sports" .
  OPTIONAL { ?a osmkey:name ?name }
  OPTIONAL { ?a osmkey:operator ?operator }
  OPTIONAL { ?a osmkey:website ?website }
  OPTIONAL { ?a osmkey:phone ?phone }
  OPTIONAL { ?a osmkey:email ?email }
  ?a geo:hasGeometry/geo:asWKT ?wkt .
}`,
};

async function fetchText(url, opts) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...((opts && opts.headers) || {}) }, signal: AbortSignal.timeout((opts && opts.timeoutMs) || 600000), ...(opts || {}) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 120)}`);
  return res.text();
}

async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

// SPARQL dotaz → CSV text (QLever vrací hlavičku s názvy proměnných bez otazníků).
async function sparqlCsv(query) {
  const body = new URLSearchParams({ query: PREFIXES + query }).toString();
  return fetchText(QLEVER_ENDPOINT, {
    method: 'POST',
    headers: { Accept: 'text/csv', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    timeoutMs: 900000,
  });
}

// ČÚZK RÚIAN – vrstva 15 = okresy, 17 = kraje (VÚSC); generalizace ~55 m, WGS84, GeoJSON.
function cuzkUrl(layer) {
  const q = new URLSearchParams({ where: '1=1', outFields: '*', outSR: '4326', f: 'geojson', maxAllowableOffset: '0.0005', returnGeometry: 'true' });
  return `${CUZK_BASE}/${layer}/query?${q}`;
}

module.exports = { QLEVER_ENDPOINT, OPENSKIMAP_URL, CUZK_BASE, USER_AGENT, PREFIXES, POI_KEYS, SPARQL_QUERIES, fetchText, fetchJson, sparqlCsv, cuzkUrl };
