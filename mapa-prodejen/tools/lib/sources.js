'use strict';
// Zdroje dat mapy prodejen: OpenStreetMap (Overpass API), ČÚZK RÚIAN (hranice krajů a okresů), GeoNames (PSČ
// a obce). Jen stahování s opakováním – zpracování je v build-data.js. ARES a adresní místa RÚIAN jsou v lib/ares.js.

const USER_AGENT = 'mapa-prodejen/0.1 (+https://github.com/ladasuchan1-cmd/Doma)';

// Overpass: veřejné instance se střídají – hlavní overpass-api.de bývá přetížená, zrcadla občas vrací 504.
const OVERPASS = (process.env.MP_OVERPASS || 'https://overpass-api.de/api/interpreter,https://maps.mail.ru/osm/tools/overpass/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const CUZK_RUIAN = 'https://ags.cuzk.cz/arcgis/rest/services/RUIAN/MapServer';
const GEONAMES_PSC = 'https://download.geonames.org/export/zip/CZ.zip';
const GEONAMES_MISTA = 'https://download.geonames.org/export/dump/CZ.zip';

// Dotazy na OSM po částech (jeden velký dotaz zrcadla odmítají – 504). Vše v hranicích ČR, výstup se středem a tagy.
const OSM_DOTAZY = {
  prodejny: 'nwr["shop"="bicycle"](area.cz);',
  servis: 'nwr["service:bicycle:repair"~"^(yes|only)$"](area.cz);',
  prodej: 'nwr["service:bicycle:retail"~"^(yes|only)$"](area.cz);',
  pujcovny: 'nwr["amenity"="bicycle_rental"](area.cz);',
  pujcovnySluzba: 'nwr["service:bicycle:rental"~"^(yes|only)$"](area.cz);',
  pujcovnyObchod: 'nwr["shop"="rental"]["rental"~"bicycle|bike|ebike|kolo",i](area.cz);',
  sportCyklo: 'nwr["shop"="sports"]["sport"~"cycling|bicycle|mtb|bmx"](area.cz);',
  retezce: 'nwr["shop"="sports"]["name"~"Decathlon|Sportisimo|Hervis|Intersport",i](area.cz);',
};

function overpassQuery(selector) {
  return `[out:json][timeout:170];\narea["ISO3166-1"="CZ"][admin_level=2]->.cz;\n${selector}\nout center tags;\n`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchRaw(url, opts) {
  const o = opts || {};
  const res = await fetch(url, {
    method: o.method || 'GET',
    headers: { 'User-Agent': USER_AGENT, ...(o.headers || {}) },
    body: o.body,
    signal: AbortSignal.timeout(o.timeoutMs || 120000),
    redirect: 'follow',
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${url.slice(0, 120)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function fetchText(url, opts) {
  return (await fetchRaw(url, opts)).text();
}

async function fetchBuffer(url, opts) {
  return Buffer.from(await (await fetchRaw(url, opts)).arrayBuffer());
}

async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

// Opakování s prodlevou (síťové chyby, 429, 5xx).
async function retry(fn, opts) {
  const o = opts || {};
  const tries = o.tries || 4;
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
      if (e.status && e.status < 500 && e.status !== 429) throw e;
      if (i < tries - 1) await sleep((o.baseMs || 2000) * 2 ** i);
    }
  }
  throw last;
}

// Overpass s rotací instancí: zkouší instance dokola, mezi koly čeká déle. Vrací JSON odpovědi.
async function overpass(selector, log) {
  const body = new URLSearchParams({ data: overpassQuery(selector) }).toString();
  let last;
  for (let kolo = 0; kolo < 6; kolo++) {
    for (const ep of OVERPASS) {
      try {
        const text = await fetchText(ep, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, timeoutMs: 200000 });
        const json = JSON.parse(text);
        if (!Array.isArray(json.elements)) throw new Error('odpověď bez elements');
        if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new Error('Overpass: ' + json.remark.slice(0, 120));
        return json;
      } catch (e) {
        last = e;
        if (log) log(`  Overpass ${new URL(ep).hostname}: ${e.message.slice(0, 100)}`);
      }
    }
    await sleep(15000 * (kolo + 1));
  }
  throw new Error('Overpass nedostupný: ' + (last && last.message));
}

// ČÚZK RÚIAN – vrstva 15 = okresy, 17 = kraje (VÚSC); generalizace ~55 m, WGS84, GeoJSON.
function cuzkUrl(layer) {
  const q = new URLSearchParams({ where: '1=1', outFields: '*', outSR: '4326', f: 'geojson', maxAllowableOffset: '0.0006', returnGeometry: 'true' });
  return `${CUZK_RUIAN}/${layer}/query?${q}`;
}

module.exports = { USER_AGENT, OVERPASS, OSM_DOTAZY, CUZK_RUIAN, GEONAMES_PSC, GEONAMES_MISTA, overpassQuery, overpass, cuzkUrl, fetchText, fetchJson, fetchBuffer, fetchRaw, retry, sleep };
