'use strict';
// Sestaví offline geodata pro Kolomapu do src/geo/data/:
//   psc.json      PSČ → [lat, lon, kraj, okres, název hlavní obce]
//   places.json   obce, části obcí a místa → [název, kraj, okres, lat, lon, počet obyvatel]
//   kraje.geojson hranice 14 krajů (zjednodušené) s vlastnostmi {code, name}
//
// Zdroje (licence CC BY 4.0 – uvedeno v UI i README):
//   GeoNames postal codes  https://download.geonames.org/export/zip/CZ.zip
//   GeoNames gazetteer     https://download.geonames.org/export/dump/CZ.zip (+ admin2Codes.txt)
//   ČÚZK INSPIRE AU (přes github.com/siwekm/czech-geojson, kraje.json) – zjednodušeno nástrojem mapshaper
//
// Spuštění:  node tools/build-geo.js            (stáhne zdroje, vyžaduje síť)
//            node tools/build-geo.js --kraje    (navíc přegeneruje kraje.geojson přes „npx mapshaper“)

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readZip } = require('../src/formats/zip');
const { fold } = require('../src/util/text');

const OUT = path.join(__dirname, '..', 'src', 'geo', 'data');

// GeoNames admin1 → náš kód kraje
const ADMIN1 = {
  52: 'PHA', 78: 'JHM', 79: 'JHC', 80: 'VYS', 81: 'KVK', 82: 'HKK', 83: 'LBK',
  84: 'OLK', 85: 'MSK', 86: 'PAK', 87: 'PLK', 88: 'STC', 89: 'ULK', 90: 'ZLK',
};
// ČÚZK národní kód kraje → náš kód
const CUZK_KRAJ = {
  19: 'PHA', 27: 'STC', 35: 'JHC', 43: 'PLK', 51: 'KVK', 60: 'ULK', 78: 'LBK',
  86: 'HKK', 94: 'PAK', 108: 'VYS', 116: 'JHM', 124: 'OLK', 132: 'MSK', 141: 'ZLK',
};

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'kolomapa-build-geo' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function unzipText(buf, name) {
  const zip = readZip(buf);
  const get = zip.get(name);
  if (!get) throw new Error(`V archivu chybí ${name}`);
  return get().toString('utf8');
}

const r4 = (n) => Math.round(Number(n) * 1e4) / 1e4;

function dist2(a, b) {
  const dx = (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180);
  const dy = a.lat - b.lat;
  return dx * dx + dy * dy;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('Stahuji GeoNames…');
  const [postalZip, dumpZip, admin2Txt] = await Promise.all([
    download('https://download.geonames.org/export/zip/CZ.zip'),
    download('https://download.geonames.org/export/dump/CZ.zip'),
    download('https://download.geonames.org/export/dump/admin2Codes.txt'),
  ]);

  // okresy: CZ.78.0647 → „Znojmo“
  const okresByAdmin2 = new Map();
  for (const line of admin2Txt.toString('utf8').split('\n')) {
    const [code, name] = line.split('\t');
    if (!code || !code.startsWith('CZ.')) continue;
    let okres = String(name).replace(/^Okres\s+/, '').trim();
    if (okres === 'Město Brno') okres = 'Brno-město'; // sjednotit s PSČ souborem
    okresByAdmin2.set(code.slice(3), okres);
  }

  // --- Gazetteer: obce (ADM3) a sídla (P*) ---------------------------------------------------------------
  const places = []; // {n, k, o, lat, lon, pop, src}
  for (const line of unzipText(dumpZip, 'CZ.txt').split('\n')) {
    const f = line.split('\t');
    if (f.length < 15) continue;
    const [, name, , , lat, lon, fclass, fcode, , , admin1, admin2, , , pop] = f;
    const k = ADMIN1[admin1];
    if (!k) continue;
    const isObec = fclass === 'A' && fcode === 'ADM3';
    const isPlace = fclass === 'P' && fcode !== 'PPLH' && fcode !== 'PPLQ' && fcode !== 'PPLW';
    if (!isObec && !isPlace) continue;
    let n = name;
    if (fcode === 'PPLC') n = 'Praha';
    if (n === 'Pilsen') n = 'Plzeň';
    places.push({
      n,
      k,
      o: k === 'PHA' ? 'Praha' : okresByAdmin2.get(`${admin1}.${admin2}`) || null,
      lat: Number(lat),
      lon: Number(lon),
      pop: Number(pop) || 0,
      src: isObec ? 'obec' : 'misto',
    });
  }

  // --- PSČ ---------------------------------------------------------------------------------------------
  const postalRows = [];
  for (const line of unzipText(postalZip, 'CZ.txt').split('\n')) {
    const f = line.split('\t');
    if (f.length < 11) continue;
    const psc = String(f[1]).replace(/\s+/g, '');
    const k = ADMIN1[f[4]];
    if (!/^\d{5}$/.test(psc) || !k) continue;
    postalRows.push({ psc, n: f[2], k, o: k === 'PHA' ? 'Praha' : f[5], lat: Number(f[9]), lon: Number(f[10]) });
  }

  // Populace sídel podle jména a okresu (pro volbu „hlavní“ obce PSČ).
  const popIndex = new Map();
  for (const p of places) {
    const key = `${fold(p.n)}|${fold(p.o)}`;
    popIndex.set(key, Math.max(popIndex.get(key) || 0, p.pop));
  }
  const byPsc = new Map();
  for (const r of postalRows) {
    if (!byPsc.has(r.psc)) byPsc.set(r.psc, []);
    byPsc.get(r.psc).push(r);
  }
  const pscOut = {};
  for (const [psc, rows] of [...byPsc].sort()) {
    // hlavní obec PSČ = nejlidnatější; při shodě ta nejblíž středu všech míst PSČ
    const c = { lat: rows.reduce((a, r) => a + r.lat, 0) / rows.length, lon: rows.reduce((a, r) => a + r.lon, 0) / rows.length };
    let best = null;
    for (const r of rows) {
      const base = r.n.replace(/\s*\d+$/, '').split('-')[0].trim();
      const pop = Math.max(popIndex.get(`${fold(r.n)}|${fold(r.o)}`) || 0, popIndex.get(`${fold(base)}|${fold(r.o)}`) || 0);
      const score = pop * 1e6 - dist2(r, c);
      if (!best || score > best.score) best = { r, score, pop };
    }
    pscOut[psc] = [r4(best.r.lat), r4(best.r.lon), best.r.k, best.r.o, best.r.n];
  }

  // Místa z PSČ souboru (části obcí, „Praha 4-Chodov“, „Brno-Královo Pole“) – doplní gazetteer.
  for (const r of postalRows) places.push({ n: r.n, k: r.k, o: r.o, lat: r.lat, lon: r.lon, pop: 0, src: 'psc' });

  // Deduplikace: stejné jméno ve stejném okrese do 3 km → jedno místo (nejvyšší populace, souřadnice obce).
  const groups = new Map();
  for (const p of places) {
    const key = `${fold(p.n)}|${fold(p.o)}`;
    if (!groups.has(key)) groups.set(key, []);
    const list = groups.get(key);
    const near = list.find((q) => dist2(p, q) < 0.03 * 0.03);
    if (!near) list.push({ ...p });
    else {
      near.pop = Math.max(near.pop, p.pop);
      if (p.src === 'obec' && near.src !== 'obec') Object.assign(near, { lat: p.lat, lon: p.lon, src: 'obec' });
    }
  }
  const placesOut = [];
  for (const list of groups.values()) for (const p of list) placesOut.push([p.n, p.k, p.o, r4(p.lat), r4(p.lon), p.pop]);
  placesOut.sort((a, b) => b[5] - a[5] || String(a[0]).localeCompare(String(b[0]), 'cs'));

  fs.writeFileSync(path.join(OUT, 'psc.json'), JSON.stringify(pscOut));
  fs.writeFileSync(path.join(OUT, 'places.json'), JSON.stringify(placesOut));
  console.log(`psc.json: ${Object.keys(pscOut).length} PSČ, places.json: ${placesOut.length} míst`);

  if (process.argv.includes('--kraje')) {
    console.log('Stahuji hranice krajů (ČÚZK INSPIRE via siwekm/czech-geojson)…');
    const raw = JSON.parse((await download('https://raw.githubusercontent.com/siwekm/czech-geojson/master/kraje.json')).toString('utf8'));
    for (const f of raw.features) {
      f.properties = { code: CUZK_KRAJ[f.nationalCode], name: f.name };
      for (const k of ['nationalCode', 'localId', 'name', 'id']) delete f[k];
    }
    const tmp = path.join(require('node:os').tmpdir(), `kraje-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(raw));
    execFileSync('npx', ['-y', 'mapshaper@0.6', tmp, '-simplify', '2.5%', 'keep-shapes', '-clean', '-o', 'format=geojson', 'precision=0.00001', path.join(OUT, 'kraje.geojson')], {
      stdio: 'inherit',
    });
    fs.unlinkSync(tmp);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
