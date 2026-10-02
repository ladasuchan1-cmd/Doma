'use strict';
// Geolokace inzerátů: (souřadnice | PSČ | město | okres | kraj) → {lat, lon, kraj, okres, precision}.
//
// Data (src/geo/data, sestaví tools/build-geo.js; © GeoNames CC BY 4.0, hranice krajů © ČÚZK CC BY 4.0):
//   psc.json      „39301“ → [lat, lon, kraj, okres, hlavní obec]
//   places.json   [název, kraj, okres, lat, lon, obyvatel] – obce, části obcí, sídla (seřazeno podle velikosti)
//   kraje.geojson 14 krajů {code, name}
//
// Přesnost (precision): exact (souřadnice z webu) > city (obec/část obce, případně potvrzená PSČ) > psc > okres > kraj.
//
// Kontrola dat (líně, při prvním použití záznamu): GeoNames má u pár desítek míst a PSČ souřadnice v JINÉM kraji,
// než uvádí ten samý záznam (např. PSČ 156 00 Praha-Zbraslav leží podle souřadnic u Českého Krumlova). Taková místa
// se při hledání přeskočí; PSČ se opraví podle stejnojmenné obce (nebo podle souřadnic, když kraj nesedí ani
// sousedním PSČ), jinak se nepoužije. Body těsně za státní hranicí (nepřesnost hranic) se berou jako platné.

const fs = require('node:fs');
const path = require('node:path');
const { fold, parsePsc } = require('../util/text');

const DATA_DIR = path.join(__dirname, 'data');

const KRAJE = {
  PHA: 'Hlavní město Praha',
  STC: 'Středočeský kraj',
  JHC: 'Jihočeský kraj',
  PLK: 'Plzeňský kraj',
  KVK: 'Karlovarský kraj',
  ULK: 'Ústecký kraj',
  LBK: 'Liberecký kraj',
  HKK: 'Královéhradecký kraj',
  PAK: 'Pardubický kraj',
  VYS: 'Kraj Vysočina',
  JHM: 'Jihomoravský kraj',
  OLK: 'Olomoucký kraj',
  ZLK: 'Zlínský kraj',
  MSK: 'Moravskoslezský kraj',
};

// Reprezentativní bod uvnitř kraje (pro inzeráty, u kterých známe jen kraj).
const KRAJ_POINT = {
  PHA: [50.0755, 14.4378], STC: [49.95, 14.95], JHC: [49.08, 14.45], PLK: [49.62, 13.25], KVK: [50.2, 12.75],
  ULK: [50.52, 13.95], LBK: [50.72, 15.05], HKK: [50.35, 15.85], PAK: [49.9, 16.05], VYS: [49.4, 15.6],
  JHM: [49.05, 16.6], OLK: [49.7, 17.2], ZLK: [49.15, 17.75], MSK: [49.75, 18.1],
};

// Varianty názvů krajů v inzerátech → kód.
const KRAJ_ALIASES = [
  ['PHA', ['hlavni mesto praha', 'praha hlavni mesto', 'kraj praha']],
  ['STC', ['stredocesky', 'stredni cechy']],
  ['JHC', ['jihocesky', 'jizni cechy']],
  ['PLK', ['plzensky']],
  ['KVK', ['karlovarsky']],
  ['ULK', ['ustecky']],
  ['LBK', ['liberecky']],
  ['HKK', ['kralovehradecky', 'hradecky']],
  ['PAK', ['pardubicky']],
  ['VYS', ['vysocina', 'kraj vysocina']],
  ['JHM', ['jihomoravsky', 'jizni morava']],
  ['OLK', ['olomoucky']],
  ['ZLK', ['zlinsky']],
  ['MSK', ['moravskoslezsky', 'severomoravsky']],
];

/**
 * Verze logiky geolokace – zvýšit při změně pravidel nebo dat (src/geo/data); pipeline pak přepočítá polohu všech
 * aktivních inzerátů (jinak jen nových / změněných).
 */
const GEO_VERSION = '2026-10-02.2';

let cache = null;

/** Klíč názvu místa: bez diakritiky, „n.“ → „nad“, „p.“ → „pod“, jen písmena/číslice. */
function placeKey(s) {
  return fold(s)
    // jen první výskyt: „Jablonec n. N.“ → „jablonec nad n“ (druhé „n.“ je zkratka řeky)
    .replace(/\bn\s*\/\s*/, 'nad ')
    .replace(/\bn\.\s*/, 'nad ')
    .replace(/\bp\.\s*/, 'pod ')
    .replace(/\bsv\.\s*/g, 'svaty ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function load() {
  if (cache) return cache;
  const psc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'psc.json'), 'utf8'));
  const placesRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'places.json'), 'utf8'));
  const kraje = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'kraje.geojson'), 'utf8'));

  const byKey = new Map();
  const byFirst = new Map(); // první slovo klíče → klíče (pro zkratky „Ústí n. L.“)
  const add = (key, p) => {
    if (!key) return;
    if (!byKey.has(key)) {
      byKey.set(key, []);
      const first = key.split(' ')[0];
      if (!byFirst.has(first)) byFirst.set(first, []);
      byFirst.get(first).push(key);
    }
    byKey.get(key).push(p);
  };
  const okresPlaces = new Map(); // klíč okresu → místa okresu (stejnojmenná obec, pak podle velikosti)
  const prahaParts = new Map(); // „praha 4“ → [místa]
  for (const [n, k, o, lat, lon, pop] of placesRaw) {
    const p = { n, k, o, lat, lon, pop };
    add(placeKey(n), p);
    if (o) {
      const ok = placeKey(o);
      if (!okresPlaces.has(ok)) okresPlaces.set(ok, []);
      okresPlaces.get(ok).push(p);
    }
    const m = n.match(/^Praha (\d{1,2})\b/);
    if (m) {
      const key = `praha ${m[1]}`;
      if (!prahaParts.has(key)) prahaParts.set(key, []);
      prahaParts.get(key).push(p);
    }
  }
  // Bod okresu = stejnojmenná obec (okresní město; „Karviná“, ne větší Havířov), jinak největší obec okresu.
  for (const [ok, list] of okresPlaces) list.sort((a, b) => (placeKey(b.n) === ok) - (placeKey(a.n) === ok) || b.pop - a.pop);
  const seats = new Map();
  const okresSeat = {
    has: (key) => okresPlaces.has(key),
    get(key) {
      if (!seats.has(key)) seats.set(key, (okresPlaces.get(key) || []).find(validPlace) || null);
      return seats.get(key) || undefined;
    },
  };
  const features = kraje.features.map((f) => ({ code: f.properties.code, name: f.properties.name, geom: f.geometry, bbox: bboxOf(f.geometry) }));
  // pro kontrolu PSČ: kraj podle prvních 3 (2) číslic PSČ → počty
  const pscPrefix = new Map();
  for (const [code, e] of Object.entries(psc)) {
    for (const pre of [code.slice(0, 3), code.slice(0, 2)]) {
      if (!pscPrefix.has(pre)) pscPrefix.set(pre, {});
      const c = pscPrefix.get(pre);
      c[e[2]] = (c[e[2]] || 0) + 1;
    }
  }
  cache = { psc, pscChecked: new Map(), pscPrefix, byKey, byFirst, okresSeat, features, placesRaw };
  // „Praha 4“ = střed všech (platných) částí Prahy 4
  for (const [key, list] of prahaParts) {
    if (byKey.has(key)) continue;
    const ok = list.filter(validPlace);
    if (!ok.length) continue;
    const lat = ok.reduce((a, p) => a + p.lat, 0) / ok.length;
    const lon = ok.reduce((a, p) => a + p.lon, 0) / ok.length;
    add(key, { n: `Praha ${key.split(' ')[1]}`, k: 'PHA', o: 'Praha', lat, lon, pop: 100000, valid: true });
  }
  return cache;
}

/** Leží místo (podle souřadnic) v kraji, který uvádí jeho záznam? Bod mimo polygony ČR (hranice) = platný. */
function validPlace(p) {
  if (p.valid === undefined) {
    const k = krajAt(p.lat, p.lon);
    p.valid = !k || k === p.k;
  }
  return p.valid;
}

/**
 * Záznam PSČ [lat, lon, kraj, okres, obec] po kontrole: souřadnice v jiném kraji, než uvádí záznam →
 * pokud kraj souřadnic odpovídá sousedním PSČ (stejné první 3 číslice), opraví se kraj/okres podle souřadnic,
 * jinak se souřadnice vezmou ze stejnojmenné obce v uvedeném kraji/okrese; když nic nesedí → null.
 */
function pscEntry(code) {
  const c = load();
  if (!code) return null;
  if (c.pscChecked.has(code)) return c.pscChecked.get(code);
  let e = c.psc[code] || null;
  if (e) {
    const [lat, lon, k, o, obec] = e;
    const at = krajAt(lat, lon);
    if (at && at !== k) {
      e = null;
      const majority = (pre) => {
        const counts = { ...(c.pscPrefix.get(pre) || {}) };
        counts[k] = (counts[k] || 0) - 1; // bez sebe sama
        const best = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])[0];
        return best ? best[0] : null;
      };
      const neighbours = majority(code.slice(0, 3)) || majority(code.slice(0, 2));
      if (neighbours === at) {
        // chybný kraj/okres záznamu, souřadnice sedí k sousedním PSČ → okres a obec podle nejbližšího místa
        let best = null;
        let bestD = Infinity;
        for (const [n, pk, po, plat, plon] of c.placesRaw) {
          if (pk !== at || !po) continue;
          const d = d2({ lat: plat, lon: plon }, lat, lon);
          if (d < bestD) [best, bestD] = [{ n, o: po }, d];
        }
        if (best) e = [lat, lon, at, best.o, best.n];
      } else {
        const ok = o ? placeKey(o) : null;
        const cands = (c.byKey.get(placeKey(obec)) || []).filter((p) => p.k === k && validPlace(p) && krajAt(p.lat, p.lon) === k);
        const same = cands.filter((p) => !ok || (p.o && placeKey(p.o) === ok));
        const p = (same.length ? same : cands).sort((a, b) => b.pop - a.pop)[0] || (ok ? c.okresSeat.get(ok) : null);
        if (p && krajAt(p.lat, p.lon) === k) e = [p.lat, p.lon, k, o, obec];
      }
    }
  }
  c.pscChecked.set(code, e);
  return e;
}

function bboxOf(geom) {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys)
    for (const ring of poly)
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
  return [minX, minY, maxX, maxY];
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inGeometry(x, y, geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    if (!inRing(x, y, poly[0])) continue;
    let hole = false;
    for (let h = 1; h < poly.length; h++) if (inRing(x, y, poly[h])) hole = true;
    if (!hole) return true;
  }
  return false;
}

/** Kód kraje pro souřadnice (point-in-polygon), nebo null mimo ČR. */
function krajAt(lat, lon) {
  const { features } = load();
  for (const f of features) {
    const [a, b, c, d] = f.bbox;
    if (lon < a || lon > c || lat < b || lat > d) continue;
    if (inGeometry(lon, lat, f.geom)) return f.code;
  }
  return null;
}

/** Kód kraje z textu („Jihomoravský kraj“, „kraj Vysočina“, „Hlavní město Praha“) nebo null. */
function krajFromText(s) {
  if (!s) return null;
  const k = placeKey(s);
  if (/^[a-z]{3}$/.test(k) && KRAJE[k.toUpperCase()]) return k.toUpperCase();
  for (const [code, aliases] of KRAJ_ALIASES) if (aliases.some((a) => k.includes(a))) return code;
  return null;
}

function d2(a, lat, lon) {
  const dx = (a.lon - lon) * Math.cos((lat * Math.PI) / 180);
  const dy = a.lat - lat;
  return dx * dx + dy * dy;
}

/**
 * Kandidáti pro klíč: přesná shoda, jinak zkratky – každé slovo dotazu je prefixem slova názvu
 * („usti nad l“ → „usti nad labem“, „roznov pod r“ → „roznov pod radhostem“, „brandys nad l“ → „brandys nad labem stara boleslav“).
 */
function lookup(key) {
  const { byKey, byFirst } = load();
  const exact = (byKey.get(key) || []).filter(validPlace);
  if (exact.length) return exact;
  const q = key.split(' ');
  if (q.length < 2 || !q.slice(1).some((t) => t.length <= 4)) return null;
  const out = [];
  for (const cand of byFirst.get(q[0]) || []) {
    const c = cand.split(' ');
    if (c.length < q.length) continue;
    // u víceslovných názvů („Brandýs nad Labem-Stará Boleslav“) stačí shoda začátku
    if (q.every((t, i) => c[i].startsWith(t))) out.push(...byKey.get(cand).filter(validPlace));
  }
  return out.length ? out : null;
}

/**
 * Najde místo podle textu. Kandidáty zúží podle kraje/okresu, při PSČ vybere nejbližší k PSČ, jinak největší.
 * @returns {{n, k, o, lat, lon, pop}|null}
 */
function findPlace(text, { kraj, okres, near } = {}) {
  const raw = String(text || '');
  const attempts = [];
  const full = placeKey(raw.replace(/\b(okres|kraj|obec|mesto|město|čr|cz|česká republika|czech republic)\b/gi, ' '));
  if (full) attempts.push(full);
  // části oddělené čárkou, lomítkem, závorkou, „ - “
  for (const part of raw.split(/\s[-–]\s|[,/;()|]/)) {
    const k = placeKey(part.replace(/\b(okres|kraj|obec)\b/gi, ' '));
    if (k && !attempts.includes(k)) attempts.push(k);
  }
  // „Praha 4 - Chodov“ → „praha 4 chodov“ (sedí na PSČ názvy „Praha 4-Chodov“), „Praha 10“ → „praha 10“
  const pm = placeKey(raw).match(/^praha\s*(\d{1,2})\b/);
  if (pm && !attempts.includes(`praha ${pm[1]}`)) attempts.push(`praha ${pm[1]}`);
  // „Brno-venkov“, „Praha-západ“ → okres; řeší volající přes okresSeat

  const okKey = okres ? placeKey(okres) : null;
  for (const key of attempts) {
    let cands = lookup(key);
    if (!cands || !cands.length) continue;
    if (kraj) {
      const f = cands.filter((c) => c.k === kraj);
      if (f.length) cands = f;
    }
    if (okKey) {
      const f = cands.filter((c) => c.o && placeKey(c.o) === okKey);
      if (f.length) cands = f;
    }
    if (near) {
      const close = cands.filter((c) => d2(c, near.lat, near.lon) < 0.35 * 0.35); // ~30 km
      if (close.length) cands = close.sort((a, b) => d2(a, near.lat, near.lon) - d2(b, near.lat, near.lon));
      else if (cands.length > 1) cands = [...cands].sort((a, b) => b.pop - a.pop);
    } else cands = [...cands].sort((a, b) => b.pop - a.pop);
    return cands[0];
  }
  return null;
}

/**
 * Hlavní funkce: zjistí polohu inzerátu.
 * @param {{lat?: number, lon?: number, psc?: string, locationText?: string, okres?: string, kraj?: string}} loc
 * @returns {{lat: number|null, lon: number|null, kraj: string|null, okres: string|null, precision: string|null, place?: string}}
 */
function resolveLocation(loc = {}) {
  const { okresSeat } = load();
  const lat = Number(loc.lat);
  const lon = Number(loc.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon) && lat > 48.4 && lat < 51.2 && lon > 11.9 && lon < 19) {
    const k = krajAt(lat, lon);
    if (k) return { lat, lon, kraj: k, okres: loc.okres || null, precision: 'exact', place: loc.locationText || null };
  }
  // Okres, který v ČR neexistuje (Cyklobazar: „Žilina, okres Žilina“) → zahraničí; neumisťovat na českou obec
  // stejného jména. Praha a „Hlavní město Praha“ jsou v pořádku.
  if (loc.okres && !/praha/i.test(String(loc.okres)) && !okresSeat.has(placeKey(String(loc.okres).replace(/\bokres\b/gi, ' ')))) {
    return { lat: null, lon: null, kraj: null, okres: String(loc.okres), precision: null, foreign: true };
  }
  let krajHint = krajFromText(loc.kraj) || null;
  // Části textu, které jsou jen názvem kraje („Brno, Jihomoravský kraj“, „Kraj Vysočina“), použijeme jako nápovědu.
  let rawText = String(loc.locationText || '');
  const kept = [];
  for (const part of rawText.split(/[,;|()]|\s[-–]\s/)) {
    const pk = placeKey(part);
    const kk = krajFromText(part);
    if (kk && (/\bkraj\b/.test(pk) || KRAJ_ALIASES.some(([c, a]) => c === kk && a.includes(pk)))) {
      krajHint = krajHint || kk;
      continue;
    }
    if (part.trim()) kept.push(part.trim());
  }
  rawText = kept.join(', ');
  const pscKey = parsePsc(loc.psc) || parsePsc(loc.locationText);
  const pscHit = pscEntry(pscKey);
  const near = pscHit ? { lat: pscHit[0], lon: pscHit[1] } : null;
  const fromPsc = () => ({ lat: pscHit[0], lon: pscHit[1], kraj: pscHit[2], okres: pscHit[3], precision: 'psc', place: pscHit[4] });

  const text = rawText.replace(/\b\d{3}\s?\d{2}\b/g, ' ').trim();
  // Celý text je název okresu. Bazoš uvádí VŽDY okres (u PSČ 744 01 Frenštát p. R. píše „Nový Jičín“), takže
  // název, který je zároveň okresem i obcí („Nový Jičín“, „Jindřichův Hradec“), bez jiného údaje o okrese
  // znamená jen okres: přesnost 'okres' (ne „střed obce“), s PSČ ze stejného okresu poloha podle PSČ.
  // Zdroje, které okres uvádí zvlášť (Sbazar, Cyklobazar – loc.okres), mají v textu obec.
  const fullKey = placeKey(text.replace(/\bokres\b/gi, ' '));
  if (fullKey && okresSeat.has(fullKey)) {
    const okresOnly = (seat) => ({ lat: seat.lat, lon: seat.lon, kraj: seat.k, okres: seat.o, precision: 'okres', place: seat.n });
    if (!lookup(fullKey)) {
      // jen okres („Praha - východ“, „Brno venkov“)
      if (pscHit) return fromPsc();
      const seat = okresSeat.get(fullKey);
      if (seat) return okresOnly(seat);
    } else if (!loc.okres) {
      if (pscHit && placeKey(pscHit[3] || '') === fullKey) {
        // PSČ ve stejném okrese: PSČ samotného okresního města („Pelhřimov 393 01“, bod PSČ do ~5 km od města)
        // → obec (níže), jinak poloha podle PSČ (obec někde v okrese)
        const town = findPlace(text, { okres: text, near });
        if (!town || d2(town, pscHit[0], pscHit[1]) > 0.045 * 0.045) return fromPsc();
      } else if (!pscHit) {
        const seat = okresSeat.get(fullKey);
        if (seat) return okresOnly(seat);
      }
      // PSČ z jiného okresu → obecná logika níže (obec × PSČ podle vzdálenosti)
    }
  }
  const place = text ? findPlace(text, { kraj: krajHint || (pscHit && pscHit[2]) || null, okres: loc.okres || (okresSeat.has(fullKey) ? text : null), near }) : null;
  if (place && (!pscHit || d2(place, pscHit[0], pscHit[1]) < 0.35 * 0.35)) {
    return { lat: place.lat, lon: place.lon, kraj: place.k, okres: place.o, precision: 'city', place: place.n };
  }
  if (pscHit) return fromPsc();
  if (place) return { lat: place.lat, lon: place.lon, kraj: place.k, okres: place.o, precision: 'city', place: place.n };

  // okres (text „okres Jihlava“, „Brno-venkov“ nebo samostatné pole okres)
  for (const o of [loc.okres, text]) {
    if (!o) continue;
    const seat = okresSeat.get(placeKey(String(o).replace(/\bokres\b/gi, ' ')));
    if (seat) return { lat: seat.lat, lon: seat.lon, kraj: seat.k, okres: seat.o, precision: 'okres', place: seat.n };
  }
  const k = krajHint || krajFromText(text) || (pscHit && pscHit[2]) || null;
  if (k) return { lat: KRAJ_POINT[k][0], lon: KRAJ_POINT[k][1], kraj: k, okres: null, precision: 'kraj', place: null };
  return { lat: null, lon: null, kraj: null, okres: null, precision: null };
}

/**
 * Deterministický posun pinu (aby se inzeráty ze stejné obce nepřekrývaly). Max. ~±400 m u obce, víc u PSČ/okresu.
 * @param {string} seed např. „bazos:224210521“
 */
function jitter(lat, lon, precision, seed) {
  if (lat == null || lon == null || precision === 'exact') return [lat, lon];
  const radius = { city: 0.004, psc: 0.006, okres: 0.02, kraj: 0.05 }[precision] || 0.004;
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const a = ((h >>> 0) % 3600) / 10;
  const r = (((h >>> 12) % 1000) / 1000) * radius;
  return [lat + r * Math.sin((a * Math.PI) / 180), lon + (r * Math.cos((a * Math.PI) / 180)) / Math.cos((lat * Math.PI) / 180)];
}

module.exports = { resolveLocation, krajAt, krajFromText, findPlace, placeKey, jitter, pscEntry, KRAJE, KRAJ_POINT, GEO_VERSION, load };
