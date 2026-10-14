'use strict';
// Hledání adres (ulice, číslo domu) přes Nominatim – vyhledávač OpenStreetMap. Obce, části obcí, kraje a PSČ hledá
// Kolomapa sama bez internetu (geo.searchPlaces); sem jde jen dotaz, který místní data neznají, a jen po potvrzení
// (Enter / „Hledat adresu“), nikdy při psaní.
//
// Pravidla veřejného Nominatimu (https://operations.osmfoundation.org/policies/nominatim/): nejvýš 1 dotaz za sekundu,
// aplikace se představí v User-Agent, žádné našeptávání, výsledky se cachují. Proto: dotazy jdou frontou s odstupem
// ≥ 1,1 s, fronta má strop (víc čekajících → 429), výsledky se drží v paměti 7 dní. Vlastní nebo jiná instance
// s rozhraním Nominatimu: KOLOMAPA_GEOCODER=https://…/search; KOLOMAPA_GEOCODER=off hledání adres vypne.

const { krajAt, krajFromText } = require('../geo');

const DEFAULT_URL = 'https://nominatim.openstreetmap.org/search';
const MIN_INTERVAL_MS = 1100;
const CACHE_MAX = 500;
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const QUEUE_MAX = 6;
const TIMEOUT_MS = 8000;
const RESULTS_MAX = 6;

class GeocodeError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GeocodeError';
    this.status = status;
  }
}

/** Zoom mapy podle druhu výsledku (place_rank Nominatimu: 30 budova … 16 město … 8 kraj). */
function zoomFor(r) {
  const rank = Number(r.place_rank) || 0;
  if (rank >= 28) return 17;
  if (rank >= 26) return 16;
  if (rank >= 20) return 14.5;
  if (rank >= 16) return 13;
  if (rank >= 12) return 11;
  return 9;
}

/** Popisek výsledku: „Kounicova 681/10“ + „Veveří, Brno, 602 00“. Název podniku na adrese jen v podtitulku. */
function labelOf(r) {
  const a = r && typeof r.address === 'object' && r.address ? r.address : {};
  const s = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const locality = s(a.city) || s(a.town) || s(a.village) || s(a.municipality) || s(a.hamlet);
  const quarter = s(a.suburb) || s(a.quarter) || s(a.neighbourhood) || s(a.city_district);
  const road = s(a.road) || s(a.pedestrian) || s(a.footway) || s(a.square);
  const no = s(a.house_number);
  let label = null;
  if (road && no) label = `${road} ${no}`;
  else if (road) label = road;
  else if (no && locality) label = `${locality} ${no}`; // vesnice bez ulic: „Lhota 25“
  const name = s(r.name);
  if (!label) label = name || s(String(r.display_name || '').split(',')[0]) || 'Místo';
  const sub = [
    name && name !== label && name !== road && name !== locality ? name : null,
    quarter && quarter !== label && quarter !== locality ? quarter : null,
    locality && locality !== label && !label.startsWith(`${locality} `) ? locality : null,
    s(a.postcode),
  ].filter(Boolean);
  return { label: label.slice(0, 120), sub: sub.join(', ').slice(0, 160) };
}

/**
 * @param {{url?: string, userAgent: string, fetchImpl?: Function, log?: object, now?: () => number,
 *   sleep?: (ms: number) => Promise<void>, minIntervalMs?: number}} o
 * @returns {{search: (q: string) => Promise<{results: object[], cached: boolean}>, url: string}}
 */
function createGeocoder({ url = DEFAULT_URL, userAgent, fetchImpl = globalThis.fetch, log, now = () => Date.now(), sleep, minIntervalMs = MIN_INTERVAL_MS } = {}) {
  const cache = new Map(); // dotaz → {at, results}; Map drží pořadí vložení = nejstarší první
  let chain = Promise.resolve();
  let lastAt = -Infinity;
  let waiting = 0;
  const pause = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function fetchResults(q) {
    const u = new URL(url);
    u.searchParams.set('q', q);
    u.searchParams.set('format', 'jsonv2');
    u.searchParams.set('countrycodes', 'cz');
    u.searchParams.set('limit', '10');
    u.searchParams.set('addressdetails', '1');
    u.searchParams.set('accept-language', 'cs');
    // hlavička HTTP smí mít jen ASCII (diakritika by fetch shodila: „Cannot convert argument to a ByteString“)
    const ua = String(userAgent || 'Kolomapa/1.0').replace(/[^\x20-\x7e]/g, '');
    const res = await fetchImpl(u.href, { headers: { 'User-Agent': ua, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 429 || res.status === 403 || res.status === 509) {
      throw new GeocodeError(503, 'Vyhledávání adres je teď přetížené – zkuste to za chvíli, nebo hledejte obec či PSČ.');
    }
    if (!res.ok) throw new GeocodeError(502, `Vyhledávání adres neodpovídá (HTTP ${res.status}).`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new GeocodeError(502, 'Vyhledávání adres vrátilo nečekanou odpověď.');
    // nejdřív samotné adresy, podniky na adrese (hospoda v domě) až za nimi – při sloučení pak zůstane adresa
    const isPoi = (r) => !!(r && r.name) && !['house', 'building', 'place', 'road', 'residential'].includes(r.addresstype);
    const rows = body.filter((r) => r && typeof r === 'object').sort((a, b) => isPoi(a) - isPoi(b));
    const out = [];
    for (const r of rows) {
      const lat = Number(r.lat);
      const lon = Number(r.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      const { label, sub } = labelOf(r);
      const road = (r.address && r.address.road) || label;
      // stejná ulice do ~60 m (č. p./č. o. „681/10“ a „10“, podniky v domě) = jedno místo
      if (out.some((o) => o.road === road && Math.abs(o.lat - lat) < 0.0006 && Math.abs(o.lon - lon) < 0.0009)) continue;
      const kraj = krajAt(lat, lon) || krajFromText(r.address && r.address.state) || null;
      out.push({ road, label, sub, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, kraj, kind: 'adresa', zoom: zoomFor(r) });
      if (out.length >= RESULTS_MAX) break;
    }
    return out.map(({ road: _road, ...o }) => o);
  }

  async function search(q) {
    const query = String(q ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (query.length < 3) throw new GeocodeError(400, 'Napište aspoň 3 znaky.');
    if (query.length > 200) throw new GeocodeError(400, 'Hledaný text je moc dlouhý.');
    const key = query.toLowerCase();
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) {
      cache.delete(key); // naposledy použité na konec
      cache.set(key, hit);
      return { results: hit.results, cached: true };
    }
    if (waiting >= QUEUE_MAX) throw new GeocodeError(429, 'Moc hledání najednou – zkuste to za pár sekund.');
    waiting++;
    const run = chain.then(async () => {
      const gap = lastAt + minIntervalMs - now();
      if (gap > 0) await pause(gap);
      lastAt = now();
      return fetchResults(query);
    });
    chain = run.catch(() => {});
    try {
      const results = await run;
      cache.set(key, { at: now(), results });
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return { results, cached: false };
    } catch (e) {
      if (e instanceof GeocodeError) throw e;
      log?.warn?.('Vyhledávání adres selhalo', { error: e.message });
      throw new GeocodeError(502, e && e.name === 'TimeoutError' ? 'Vyhledávání adres neodpovědělo včas – zkuste to znovu.' : 'Vyhledávání adres teď nefunguje – zkuste to za chvíli.');
    } finally {
      waiting--;
    }
  }

  return { search, url };
}

module.exports = { createGeocoder, labelOf, zoomFor, GeocodeError, DEFAULT_URL, MIN_INTERVAL_MS, QUEUE_MAX };
