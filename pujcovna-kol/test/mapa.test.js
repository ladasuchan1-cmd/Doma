'use strict';
// Testy feature „mapa“ a nástroje tools/build-okoli.js (SPEC kap. 12): výběr tras podle kruhu, ořez a zjednodušení geom,
// skóre a výběr zajímavostí, licence obrázků, GPX (validní XML s trkpt, hlavičky), schéma tenants/demo/okoli.json
// (obrázky s autorem a licencí), stránky /mapa a /okoli (200, attribution, karty), /api/v1/okoli.json s poi_overrides,
// obrázky zajímavostí přes /okoli/img/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, ROOT } = require('./helpers');
const build = require('../tools/build-okoli');
const mapa = require('../src/features/mapa');

const CENTER = { lat: 49.0035, lon: 14.7708 };

/** Úsečka z bodu směrem na sever o n bodech po ~1 km. */
function northLine(lat, lon, n, stepKm = 1) {
  const out = [];
  for (let i = 0; i < n; i++) out.push([lat + (i * stepKm) / 111.32, lon]);
  return out;
}

/** Minimální kontrola dobře utvořeného XML: vyvážené značky, uvozované atributy, povolené entity. */
function assertWellFormedXml(xml) {
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/);
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  const re = /<\/?([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
  const stack = [];
  let m;
  while ((m = re.exec(body))) {
    if (m[5]) throw new Error(`Osamocené „<“ u pozice ${m.index}`);
    if (m[4] !== undefined) {
      assert.ok(!/[<>]/.test(m[4]), 'text obsahuje < nebo >');
      assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(m[4]), `neescapovaný & v „${m[4]}“`);
      continue;
    }
    if (m[0].startsWith('</')) assert.equal(stack.pop(), m[1], `uzavírací značka ${m[1]} neodpovídá`);
    else if (!m[3]) stack.push(m[1]);
  }
  assert.deepEqual(stack, [], 'neuzavřené značky');
}

// ---------------------------------------------------------------------------------------- build-okoli
test('build-okoli: výběr tras podle kruhu, ořez geom na okruh a zjednodušení na ≤ 400 bodů', () => {
  const near = { id: 'r1', druh: 'cyklotrasa', nazev: 'Okolo Světa', ref: '1034', sit: 'rcn', delkaKm: 12, bbox: [48.95, 14.7, 49.05, 14.85], geom: [[[48.95, 14.7], [49.0, 14.77], [49.05, 14.85]]] };
  const far = { id: 'r2', druh: 'cyklotrasa', nazev: 'Praha', ref: '1', sit: 'ncn', delkaKm: 10, bbox: [50.0, 14.0, 50.1, 14.1], geom: [[[50.0, 14.0], [50.1, 14.1]]] };
  const edgeIn = { id: 'r3', druh: 'mtb', nazev: 'Na hraně', ref: null, sit: null, delkaKm: 3, bbox: [49.0035 + 24 / 111.32, 14.7708, 49.3, 14.9], geom: [[[49.0035 + 24 / 111.32, 14.7708], [49.3, 14.9]]] };
  const edgeOut = { id: 'r4', druh: 'cyklotrasa', nazev: 'Za hranou', ref: null, sit: null, delkaKm: 3, bbox: [49.0035 + 26 / 111.32, 14.7708, 49.3, 14.9], geom: [[[49.0035 + 26 / 111.32, 14.7708], [49.3, 14.9]]] };
  const selected = build.selectRoutes([near, far, edgeIn, edgeOut, null, { id: 'bez-geom' }], CENTER, 25);
  assert.deepEqual(
    selected.map((t) => t.id),
    ['r1', 'r3']
  );
  assert.equal(build.bboxIntersectsCircle([48.0, 14.0, 48.5, 14.5], CENTER, 25), false);
  assert.equal(build.bboxIntersectsCircle([48.9, 14.7, 49.1, 14.9], CENTER, 25), true, 'bbox obsahující střed');

  // ořez: linie 100 km na sever → zůstanou body do 30 km (25 + 5)
  const long = northLine(CENTER.lat, CENTER.lon, 101);
  const clipped = build.clipGeom([long], CENTER, 30);
  assert.equal(clipped.length, 1);
  assert.equal(clipped[0].length, 31);
  assert.ok(clipped[0].every(([lat]) => (lat - CENTER.lat) * 111.32 <= 30.01));
  // úsek vracející se do kruhu → dva úseky
  const inOutIn = [...northLine(CENTER.lat, CENTER.lon, 5), ...northLine(CENTER.lat + 40 / 111.32, CENTER.lon, 3), ...northLine(CENTER.lat, CENTER.lon + 0.01, 4)];
  assert.equal(build.clipGeom([inOutIn], CENTER, 30).length, 2);
  assert.deepEqual(build.clipGeom([[[CENTER.lat, CENTER.lon]]], CENTER, 30), [], 'jednobodový úsek se vynechá');

  // zjednodušení: 1 000 bodů po 100 m s mírným vlněním → ≤ 400 bodů, krajní body zůstanou
  const wavy = [];
  for (let i = 0; i < 1000; i++) wavy.push([CENTER.lat + (i * 0.1) / 111.32, CENTER.lon + Math.sin(i / 7) * 0.0006]);
  const simplified = build.simplifyGeom([wavy]);
  assert.equal(simplified.length, 1);
  assert.ok(build.countPoints(simplified) <= 400, `bodů ${build.countPoints(simplified)}`);
  assert.ok(build.countPoints(simplified) >= 2);
  assert.deepEqual(simplified[0][0], [49.0035, 14.7708]);
  assert.equal(simplified[0][simplified[0].length - 1][0], Math.round((CENTER.lat + 99.9 / 111.32) * 1e5) / 1e5);
  // spojení navazujících úseků (rozsekaná OSM data po 2 bodech)
  const A = [49.0, 14.7];
  const B = [49.01, 14.71];
  const C = [49.02, 14.72];
  const D = [49.03, 14.73];
  const merged = build.mergeSegments([[A, B], [B, C], [D, C], [[50, 15], [50.1, 15.1]]]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], [A, B, C, D]);
  const many = [];
  for (let i = 0; i < 600; i++) many.push([[49 + i * 0.001, 14.7], [49 + (i + 1) * 0.001, 14.7]]);
  assert.ok(build.countPoints(build.simplifyGeom(many)) <= 400, 'rozsekaná linie se spojí a zjednoduší');

  // záznam trasy
  const rec = build.routeRecord({ ...near, geom: [long] }, CENTER, 25);
  assert.equal(rec.id, 'r1');
  assert.equal(rec.net, 'rcn');
  assert.equal(rec.druh, 'cyklotrasa');
  assert.ok(rec.delkaKm > 29 && rec.delkaKm < 31, `délka výřezu ${rec.delkaKm}`);
  assert.equal(rec.delkaCelkemKm, 12);
  assert.equal(rec.elevation, null);
  assert.equal(rec.bbox.length, 4);
  assert.equal(build.routeRecord(far, CENTER, 25), null, 'trasa mimo kruh → null');
  assert.equal(build.geomLengthKm([[[49.0, 14.0], [50.0, 14.0]]]).toFixed(0), '111');

  // síť: podle druhu, sit nebo počtu číslic v ref
  assert.equal(build.networkOf({ druh: 'mtb', sit: 'lcn' }), 'mtb');
  assert.equal(build.networkOf({ druh: 'cyklostezka', sit: null }), 'cyklostezka');
  assert.equal(build.networkOf({ druh: 'cyklotrasa', sit: 'icn' }), 'icn');
  assert.equal(build.networkOf({ druh: 'cyklotrasa', sit: null, ref: '12' }), 'ncn');
  assert.equal(build.networkOf({ druh: 'cyklotrasa', sit: null, ref: '1034' }), 'rcn');
  assert.equal(build.networkOf({ druh: 'cyklotrasa', sit: null, ref: null }), 'lcn');
});

test('build-okoli: trasy.js se načte odříznutím prefixu, SPARQL dotaz, WKT, názvy souborů a článků', () => {
  const tmp = path.join(require('node:os').tmpdir(), `trasy-test-${process.pid}.js`);
  fs.writeFileSync(tmp, 'window.CSM_DATA = window.CSM_DATA || {};\nwindow.CSM_DATA.trasy = [{"id":"r1","geom":[[[49,14],[49.1,14.1]]]}];\n');
  try {
    assert.deepEqual(build.loadTrasy(tmp), [{ id: 'r1', geom: [[[49, 14], [49.1, 14.1]]] }]);
  } finally {
    fs.unlinkSync(tmp);
  }
  const q = build.sparqlQuery('wdqs', CENTER, 25);
  assert.match(q, /SERVICE wikibase:around/);
  assert.match(q, /Point\(14\.7708 49\.0035\)/);
  assert.match(q, /wikibase:radius "25"/);
  assert.match(q, /wd:Q23413/, 'hrad');
  assert.match(q, /wd:Q1265665/, 'chovný rybník (Třeboňsko)');
  assert.match(q, /schema:isPartOf <https:\/\/cs\.wikipedia\.org\/>/);
  assert.match(build.sparqlQuery('qlever', CENTER, 25), /geof:latitude/);
  assert.deepEqual(build.parseWktPoint('Point(14.7708 49.0035)'), { lon: 14.7708, lat: 49.0035 });
  assert.equal(build.parseWktPoint('nic'), null);
  assert.equal(build.commonsFileTitle('http://commons.wikimedia.org/wiki/Special:FilePath/Z%C3%A1mek%20T%C5%99ebo%C5%88%2C%20T%C5%99ebo%C5%88%20111.JPG'), 'File:Zámek Třeboň, Třeboň 111.JPG');
  assert.equal(build.commonsFileTitle(null), null);
  assert.equal(build.wikiTitleFromUrl('https://cs.wikipedia.org/wiki/Z%C3%A1mek_T%C5%99ebo%C5%88'), 'Zámek Třeboň');
  assert.equal(build.stripHtml('<a href="//x">Jan <b>Novák</b></a>&nbsp;(foto)'), 'Jan Novák (foto)');
  assert.equal(build.twoSentences('První věta. Druhá věta! Třetí věta.'), 'První věta. Druhá věta!');
  assert.ok(build.twoSentences('x'.repeat(500)).length <= 322);
  assert.deepEqual(build.parseArgs(['--tenant', 'demo', '--force', '--max-pois', '5']), { tenant: 'demo', force: true, offline: false, maxPois: 5, trasy: null });
});

test('build-okoli: skóre (typ, článek, obrázek, blízkost k půjčovně a trase), výběr s rozmanitostí, licence, převýšení', () => {
  const base = { typeWeight: 5, wikipediaUrl: 'x', imageTitle: 'File:x.jpg', sitelinks: 4 };
  const close = build.scorePoi({ ...base, distanceKm: 1 }, { radiusKm: 25, nearRouteM: 100 });
  const far = build.scorePoi({ ...base, distanceKm: 24 }, { radiusKm: 25, nearRouteM: 1800 });
  assert.ok(close > far, 'blízký a u trasy má vyšší skóre');
  const noArticle = build.scorePoi({ ...base, distanceKm: 1, wikipediaUrl: null }, { radiusKm: 25, nearRouteM: 100 });
  assert.equal(Math.round((close - noArticle) * 100) / 100, 3);
  const kaple = build.scorePoi({ ...base, typeWeight: 1, distanceKm: 1 }, { radiusKm: 25, nearRouteM: 100 });
  assert.equal(Math.round((close - kaple) * 100) / 100, 8);
  assert.equal(build.scorePoi({ ...base, distanceKm: 1 }, { radiusKm: 25, nearRouteM: 100 }) - build.scorePoi({ ...base, distanceKm: 1 }, { radiusKm: 25, nearRouteM: 900 }), 1);

  // rozmanitost: 6 kostelů a 2 zámky → max. 3 kostely v top 5, zbytek doplní
  const sorted = [];
  for (let i = 0; i < 6; i++) sorted.push({ id: `k${i}`, typeKey: 'kostel', score: 20 - i });
  sorted.push({ id: 'z1', typeKey: 'zamek', score: 10 }, { id: 'z2', typeKey: 'zamek', score: 9 });
  const picked = build.pickDiverse(sorted, 5);
  assert.deepEqual(
    picked.map((p) => p.id),
    ['k0', 'k1', 'k2', 'z1', 'z2']
  );
  assert.equal(build.pickDiverse(sorted, 8).length, 8, 'při nedostatku se doplní i nad cap');

  for (const ok of ['CC0', 'CC0 1.0', 'CC BY 4.0', 'CC BY-SA 3.0', 'CC BY-SA 4.0', 'CC BY-SA 3.0 de', 'CC BY 2.5']) assert.equal(build.licenseAllowed(ok), true, ok);
  for (const bad of ['Public domain', 'CC BY-NC 4.0', 'CC BY-ND 4.0', 'CC BY-NC-SA 3.0', 'GFDL', '', null, 'Fair use']) assert.equal(build.licenseAllowed(bad), false, String(bad));
  assert.equal(build.licenseUrlFor('CC BY-SA 4.0', null), 'https://creativecommons.org/licenses/by-sa/4.0/');
  assert.equal(build.licenseUrlFor('CC0 1.0', null), 'https://creativecommons.org/publicdomain/zero/1.0/');
  assert.equal(build.licenseUrlFor('CC BY 3.0', 'https://x.example/'), 'https://x.example/');

  // seskupení SPARQL řádků: typ s nejvyšší váhou, filtr kruhu
  const bindings = [
    { item: { value: 'http://www.wikidata.org/entity/Q1' }, itemLabel: { value: 'Zámek' }, class: { value: 'http://www.wikidata.org/entity/Q751876' }, loc: { value: 'Point(14.78 49.01)' }, image: { value: 'http://commons.wikimedia.org/wiki/Special:FilePath/Z.jpg' }, article: { value: 'https://cs.wikipedia.org/wiki/Z%C3%A1mek' }, sitelinks: { value: '7' } },
    { item: { value: 'http://www.wikidata.org/entity/Q1' }, itemLabel: { value: 'Zámek' }, class: { value: 'http://www.wikidata.org/entity/Q23413' }, loc: { value: 'Point(14.78 49.01)' } },
    { item: { value: 'http://www.wikidata.org/entity/Q2' }, itemLabel: { value: 'Daleko' }, class: { value: 'http://www.wikidata.org/entity/Q23413' }, loc: { value: 'Point(15.5 49.5)' } },
    { item: { value: 'http://www.wikidata.org/entity/Q3' }, class: { value: 'http://www.wikidata.org/entity/Q999999' }, loc: { value: 'Point(14.78 49.01)' } },
  ];
  const grouped = build.groupCandidates(bindings, CENTER, 25);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].id, 'Q1');
  assert.equal(grouped[0].typeKey, 'zamek');
  assert.deepEqual(grouped[0].classes.sort(), ['Q23413', 'Q751876']);
  assert.equal(grouped[0].imageTitle, 'File:Z.jpg');
  assert.equal(grouped[0].wikipediaTitle, 'Zámek');
  assert.equal(grouped[0].sitelinks, 7);
  assert.ok(grouped[0].distanceKm > 0.8 && grouped[0].distanceKm < 1.1);

  // převýšení: vzorkování po 50 m a statistika s prahem 5 m
  const samples = build.sampleAlong([northLine(49, 14.7, 3)]);
  assert.ok(samples.length >= 40 && samples.length <= 44, `vzorků ${samples.length}`);
  // medián 3 odstraní špičku 431 → stoupání 400→430 = 30 m, klesání 430→405 = 25 m (poslední −1 m pod prahem)
  const stats = build.elevationStats([400, 400, 402, 410, 420, 430, 431, 429, 425, 415, 405, 404, 404]);
  assert.equal(stats.up, 30);
  assert.equal(stats.down, 25);
  assert.equal(stats.min, 400);
  assert.equal(stats.max, 430);
  assert.equal(stats.samples, 13);
  assert.equal(build.elevationStats([1]), null);
});

// ------------------------------------------------------------------------------------------------ GPX
test('GPX: validní XML 1.1 s trkseg/trkpt podle geom, escapování, název souboru bez diakritiky', () => {
  const route = { id: 'r1', nazev: 'Okolo „Světa“ & zpět', ref: '1034', net: 'rcn', druh: 'cyklotrasa', delkaKm: 12.5, bbox: [48.99, 14.75, 49.02, 14.8], geom: [[[49.0, 14.77], [49.01, 14.78], [49.02, 14.79]], [[48.99, 14.75], [49.0, 14.76]]] };
  const gpx = mapa.buildGpx(route, { creator: 'Půjčovna kol U Tří dubů – ksprehledy.cz', link: 'https://ksprehledy.cz/mapa', time: new Date('2026-10-06T10:00:00Z') });
  assertWellFormedXml(gpx);
  assert.match(gpx, /<gpx version="1\.1" creator="Půjčovna kol U Tří dubů – ksprehledy\.cz" xmlns="http:\/\/www\.topografix\.com\/GPX\/1\/1"/);
  assert.equal((gpx.match(/<trkseg>/g) || []).length, 2);
  assert.equal((gpx.match(/<trkpt lat="/g) || []).length, 5);
  assert.match(gpx, /<trkpt lat="49" lon="14\.77"><\/trkpt>/);
  assert.match(gpx, /<name>Okolo „Světa“ &amp; zpět<\/name>/);
  assert.match(gpx, /<time>2026-10-06T10:00:00\.000Z<\/time>/);
  assert.match(gpx, /<bounds minlat="48\.99" minlon="14\.75" maxlat="49\.02" maxlon="14\.8"\/>/);
  assert.match(gpx, /<link href="https:\/\/ksprehledy\.cz\/mapa">/);
  assert.equal(mapa.asciiFilename('cyklotrasa-1034-Okolo „Světa“ & zpět'), 'cyklotrasa-1034-okolo-sveta-zpet');
  assert.equal(mapa.asciiFilename('ěščřžýáíé'), 'escrzyaie');
  assert.equal(mapa.asciiFilename('???', 'r1'), 'r1');
  assert.equal(mapa.xmlEscape(`<a href='x'>&"</a>`), '&lt;a href=&apos;x&apos;&gt;&amp;&quot;&lt;/a&gt;');
});

// ------------------------------------------------------------------------------------- okoli.json schéma
test('okoli.json: schéma podle SPEC, trasy ≤ 400 bodů, 20 zajímavostí s cs článkem a obrázkem (autor, licence CC, zdroj)', () => {
  const file = path.join(ROOT, 'tenants', 'demo', 'okoli.json');
  assert.ok(fs.existsSync(file), 'tenants/demo/okoli.json existuje (npm run build-okoli)');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(data.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(data.center.lat, 49.0035);
  assert.equal(data.center.lon, 14.7708);
  assert.equal(data.radiusKm, 25);
  assert.ok(Array.isArray(data.routes) && data.routes.length >= 50, `tras ${data.routes.length}`);
  const ids = new Set();
  for (const r of data.routes) {
    assert.match(r.id, /^[rwnc]\d+$/, 'r = relace OSM, c = cyklostezka (way)');
    assert.ok(!ids.has(r.id), `duplicitní trasa ${r.id}`);
    ids.add(r.id);
    assert.equal(typeof r.nazev, 'string');
    assert.ok(r.sit === null || typeof r.sit === 'string');
    assert.ok(['icn', 'ncn', 'rcn', 'lcn', 'mtb', 'cyklostezka'].includes(r.net), r.net);
    assert.ok(['cyklotrasa', 'cyklostezka', 'mtb'].includes(r.druh), r.druh);
    assert.equal(typeof r.delkaKm, 'number');
    assert.ok(r.delkaKm > 0);
    assert.ok(Array.isArray(r.geom) && r.geom.length >= 1);
    const n = r.geom.reduce((a, s) => a + s.length, 0);
    assert.ok(n >= 2 && n <= 400, `${r.id}: ${n} bodů`);
    for (const seg of r.geom) for (const pt of seg) assert.ok(pt.length === 2 && pt[0] > 48 && pt[0] < 50 && pt[1] > 13.5 && pt[1] < 16, `${r.id}: bod ${pt}`);
    assert.equal(r.bbox.length, 4);
    assert.ok(r.elevation === null || typeof r.elevation.up === 'number');
  }
  assert.equal(data.pois.length, 20);
  const allowed = build.ALLOWED_LICENSES;
  let prevDist = -1;
  const imgDir = path.join(ROOT, 'tenants', 'demo', 'okoli', 'img');
  const attribution = fs.readFileSync(path.join(imgDir, 'ATTRIBUTION.md'), 'utf8');
  const typeKeys = new Set();
  for (const p of data.pois) {
    assert.match(p.id, /^Q\d+$/);
    assert.ok(p.name && typeof p.name === 'string');
    assert.ok(p.type && typeof p.type === 'string');
    typeKeys.add(p.typeKey);
    assert.ok(p.lat > 48.5 && p.lat < 49.5 && p.lon > 14 && p.lon < 15.5, `${p.id} souřadnice`);
    assert.ok(p.distanceKm >= 0 && p.distanceKm <= 25, `${p.id} vzdálenost ${p.distanceKm}`);
    assert.ok(p.distanceKm >= prevDist, 'seřazeno podle vzdálenosti');
    prevDist = p.distanceKm;
    assert.ok(p.summary.length >= 40 && p.summary.length <= 330, `${p.id} summary ${p.summary.length}`);
    assert.match(p.wikipediaUrl, /^https:\/\/cs\.wikipedia\.org\/wiki\//);
    assert.ok(p.image, `${p.id} má obrázek`);
    assert.equal(p.image.file, `${p.id}.jpg`);
    assert.ok(p.image.author && p.image.author.length >= 2, `${p.id} autor`);
    assert.match(p.image.license, allowed, `${p.id} licence ${p.image.license}`);
    assert.match(p.image.licenseUrl, /^https?:\/\/creativecommons\.org\//);
    assert.match(p.image.sourceUrl, /^https:\/\/commons\.wikimedia\.org\//);
    const f = path.join(imgDir, p.image.file);
    assert.ok(fs.existsSync(f), `${f} existuje`);
    const buf = fs.readFileSync(f);
    assert.ok(buf.length > 5000, `${p.image.file} je příliš malý`);
    assert.equal(buf[0], 0xff, 'JPEG hlavička');
    assert.equal(buf[1], 0xd8, 'JPEG hlavička');
    assert.ok(attribution.includes(p.image.file), `ATTRIBUTION.md zná ${p.image.file}`);
  }
  assert.ok(typeKeys.size >= 4, 'rozmanitost typů');
  assert.ok(data.pois.some((p) => p.typeKey === 'rybnik'), 'Třeboňsko má rybník');
  assert.ok(data.pois.some((p) => p.typeKey === 'zamek'), 'má zámek');
  // žádné osiřelé obrázky
  for (const f of fs.readdirSync(imgDir)) if (f.endsWith('.jpg')) assert.ok(data.pois.some((p) => p.image.file === f), `osiřelý obrázek ${f}`);
});

// ------------------------------------------------------------------------------------------ server
let srv;
test.before(async () => {
  srv = await startServer();
});
test.after(async () => {
  if (srv) await srv.stop();
});

test('/mapa: 200, náhled SVG, tlačítko Načíst mapu, data-* pro JS, seznam tras s GPX, filtr sítí, attribution, Leaflet z vendor, bez inline JS/CSS', async () => {
  const res = await srv.fetch('/mapa');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>Mapa cyklotras a výletů · Půjčovna kol U Tří dubů<\/title>/);
  assert.match(html, /<div class="map-stage" data-map data-api="\/api\/v1\/okoli\.json" data-center-lat="49\.0035" data-center-lon="14\.7708" data-radius="25" data-tiles="cyclosm">/);
  assert.match(html, /<svg class="map-preview__svg"/);
  assert.match(html, /<polyline class="map-preview__route map-preview__route--rcn"/);
  assert.match(html, /<circle class="map-preview__poi"/);
  assert.match(html, /data-map-load>.*Načíst mapu/);
  assert.match(html, /<div class="map-canvas" id="mapa-canvas" hidden/);
  assert.match(html, /<ol class="route-list" data-route-list>/);
  const items = html.match(/<li class="route-list__item" data-route-id="/g) || [];
  assert.ok(items.length >= 50, `tras v seznamu ${items.length}`);
  assert.match(html, /href="\/mapa\/gpx\/r\d+\.gpx" download>Stáhnout GPX</);
  assert.match(html, /<input type="checkbox" name="sit" value="icn" checked>/);
  assert.match(html, /<input type="checkbox" name="sit" value="mtb" checked>/);
  assert.match(html, /© přispěvatelé OpenStreetMap<\/a>, <a href="https:\/\/www\.cyclosm\.org\/" rel="noopener">CyclOSM<\/a>/, 'attribution na mapové stránce');
  assert.match(html, /Mapové podklady © <a href="https:\/\/www\.openstreetmap\.org\/copyright"/, 'attribution v patičce');
  assert.match(html, /<link rel="stylesheet" href="\/vendor\/leaflet\/leaflet\.css\?v=test">/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/mapa\.css\?v=test">/);
  assert.match(html, /<script src="\/vendor\/leaflet\/leaflet\.js\?v=test" defer><\/script>/);
  assert.match(html, /<script src="\/js\/mapa\.js\?v=test" defer><\/script>/);
  assert.match(html, /<article class="card card--poi">/, 'nejbližší tipy');
  assert.match(html, /class="site-nav__link is-active"[^>]*>Mapa</);
  assert.match(html, /href="\/okoli"[^>]*>Výlety</);
  assert.ok(!/<script>/.test(html), 'inline <script>');
  assert.ok(!/ style="/.test(html), 'inline style');
  assert.ok(!/\bon[a-z]+="/.test(html), 'inline handler');
  // filtr sítí bez JS
  const filtered = await (await srv.fetch('/mapa?sit=icn,ncn')).text();
  const shown = filtered.match(/<li class="route-list__item" data-route-id="[^"]+" data-network="([a-z]+)"/g) || [];
  assert.ok(shown.length > 0 && shown.length < items.length);
  assert.ok(shown.every((s) => /data-network="(icn|ncn)"/.test(s)));
  assert.match(filtered, /<input type="checkbox" name="sit" value="rcn">/);
  // odkaz z karty zajímavosti
  const focus = await srv.fetch('/mapa?poi=Q1749860');
  assert.equal(focus.status, 200);
  assert.match(await focus.text(), /data-focus-poi="Q1749860"/);
  assert.ok(!/data-focus-poi/.test(await (await srv.fetch('/mapa?poi=<x>')).text()));
  // statika feature
  for (const p of ['/css/mapa.css', '/js/mapa.js', '/vendor/leaflet/leaflet.js']) assert.equal((await srv.fetch(p)).status, 200, p);
});

test('/okoli: 20 karet poiCard seřazených podle vzdálenosti s attribution u obrázku, filtr typu, JSON-LD, odkaz na mapu', async () => {
  const res = await srv.fetch('/okoli');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<h1 class="section__title">Tipy na výlety<\/h1>/);
  assert.equal((html.match(/<article class="card card--poi">/g) || []).length, 20);
  assert.equal((html.match(/<p class="card__attribution">Foto: <a href="https:\/\/commons\.wikimedia\.org\//g) || []).length, 20, 'attribution u každého obrázku');
  assert.equal((html.match(/<img src="\/okoli\/img\/Q\d+\.jpg" alt="[^"]+" loading="lazy"/g) || []).length, 20);
  assert.match(html, /creativecommons\.org\/licenses\/by-sa\//);
  assert.match(html, /od půjčovny<\/p>/);
  assert.match(html, /href="https:\/\/cs\.wikipedia\.org\/wiki\/[^"]+" rel="noopener" target="_blank">Wikipedie<\/a>/);
  assert.match(html, /href="https:\/\/mapy\.cz\/zakladni\?x=14\.\d+&amp;y=49\.\d+&amp;z=15&amp;source=coor&amp;id=14\.\d+%2C49\.\d+" rel="noopener" target="_blank">Navigovat<\/a>/);
  assert.match(html, /<a class="okoli-filter__type is-active" href="\/okoli" aria-current="page">Vše <span class="okoli-filter__count">20<\/span><\/a>/);
  assert.match(html, /href="\/okoli\?typ=zamek"/);
  assert.match(html, /href="\/mapa"/);
  // format.km odděluje jednotku pevnou mezerou (U+00A0)
  const distances = [...html.matchAll(/<p class="card__meta">([\d,]+)[\s ](km|m) od půjčovny<\/p>/g)].map((m) => (m[2] === 'm' ? Number(m[1].replace(',', '.')) / 1000 : Number(m[1].replace(',', '.'))));
  assert.equal(distances.length, 20);
  for (let i = 1; i < distances.length; i++) assert.ok(distances[i] >= distances[i - 1], 'řazení podle vzdálenosti');
  const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(ld);
  const data = JSON.parse(ld[1]);
  assert.equal(data['@type'], 'ItemList');
  assert.equal(data.itemListElement.length, 20);
  assert.equal(data.itemListElement[0].item['@type'], 'TouristAttraction');
  assert.ok(!/ style="/.test(html));
  // filtr typu
  const zamky = await (await srv.fetch('/okoli?typ=zamek')).text();
  const n = (zamky.match(/<article class="card card--poi">/g) || []).length;
  assert.ok(n >= 1 && n < 20);
  assert.match(zamky, /<span class="badge">Zámek<\/span>/);
  assert.ok(!/<span class="badge">Rybník<\/span>/.test(zamky));
  assert.match(zamky, /<link rel="canonical" href="http:\/\/127\.0\.0\.1:\d+\/okoli\?typ=zamek">/);
  // neznámý typ → vše
  assert.equal((await (await srv.fetch('/okoli?typ=neexistuje')).text()).match(/<article class="card card--poi">/g).length, 20);
});

test('/api/v1/okoli.json: JSON s trasami, zajímavostmi, půjčovnou a podkladem; gzip; respektuje poi_overrides', async () => {
  const res = await srv.fetch('/api/v1/okoli.json', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=600');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.center.lat, 49.0035);
  assert.equal(body.radiusKm, 25);
  assert.equal(body.rental.name, 'Půjčovna kol U Tří dubů');
  assert.equal(body.rental.lat, 49.0035);
  assert.equal(body.tiles.provider, 'cyclosm');
  assert.match(body.tiles.attribution, /OpenStreetMap, CyclOSM/);
  assert.equal(body.networks.mtb.color, '#7c3aed');
  assert.equal(body.networks.cyklostezka.color, '#c2410c');
  assert.ok(body.routes.length >= 50);
  assert.equal(body.pois.length, 20);
  const r = body.routes[0];
  assert.ok(r.id && r.nazev && r.net && r.color && r.gpxHref && Array.isArray(r.geom));
  assert.equal(r.gpxHref, `/mapa/gpx/${r.id}.gpx`);
  const p = body.pois[0];
  assert.ok(p.image.src.startsWith('/okoli/img/Q'));
  assert.ok(p.image.author && p.image.license);
  assert.match(p.mapyUrl, /^https:\/\/mapy\.cz\/zakladni\?x=/);
  assert.equal(p.sort, undefined, 'interní pole se neposílají');
  // poi_overrides: skrýt, vlastní text, pořadí
  const hidden = body.pois[0].id;
  const custom = body.pois[1].id;
  const last = body.pois[19].id;
  srv.db.prepare('INSERT INTO poi_overrides(poi_id, hidden) VALUES (?, 1)').run(hidden);
  srv.db.prepare('INSERT INTO poi_overrides(poi_id, hidden, custom_text) VALUES (?, 0, ?)').run(custom, 'Vlastní text půjčovny: sem jezdíme nejraději.');
  srv.db.prepare('INSERT INTO poi_overrides(poi_id, hidden, sort) VALUES (?, 0, 1)').run(last);
  try {
    const over = await (await srv.fetch('/api/v1/okoli.json')).json();
    assert.equal(over.pois.length, 19);
    assert.ok(!over.pois.some((x) => x.id === hidden), 'skrytý tip chybí');
    assert.equal(over.pois[0].id, last, 'sort přeřadí dopředu');
    assert.equal(over.pois.find((x) => x.id === custom).summary, 'Vlastní text půjčovny: sem jezdíme nejraději.');
    const page = await (await srv.fetch('/okoli')).text();
    assert.equal((page.match(/<article class="card card--poi">/g) || []).length, 19);
    assert.match(page, /Vlastní text půjčovny: sem jezdíme nejraději\./);
    assert.ok(!page.includes(`/okoli/img/${hidden}.jpg`));
  } finally {
    srv.db.exec('DELETE FROM poi_overrides');
  }
});

test('GPX ke stažení: Content-Type application/gpx+xml, název souboru, validní XML s trkpt; neznámá trasa 404', async () => {
  const api = await (await srv.fetch('/api/v1/okoli.json')).json();
  const route = api.routes.find((r) => r.ref) || api.routes[0];
  const res = await srv.fetch(route.gpxHref);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/gpx+xml; charset=utf-8');
  const cd = res.headers.get('content-disposition');
  assert.match(cd, /^attachment; filename="[a-z0-9-]+\.gpx"; filename\*=UTF-8''/);
  assert.ok(!/[^\x20-\x7e]/.test(cd), 'hlavička jen ASCII');
  const gpx = await res.text();
  assertWellFormedXml(gpx);
  assert.match(gpx, /<gpx version="1\.1" creator="Půjčovna kol U Tří dubů – 127\.0\.0\.1:\d+"/);
  const points = route.geom.reduce((n, s) => n + s.length, 0);
  assert.equal((gpx.match(/<trkpt lat="/g) || []).length, points);
  assert.equal((gpx.match(/<trkseg>/g) || []).length, route.geom.length);
  assert.ok(gpx.includes(`<name>${mapa.xmlEscape(route.nazev)}</name>`));
  // komprese i u GPX
  const gz = await srv.fetch(route.gpxHref, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers.get('content-encoding'), 'gzip');
  assert.ok((await gz.text()).startsWith('<?xml'));
  // chyby
  assert.equal((await srv.fetch('/mapa/gpx/r999999999.gpx')).status, 404);
  assert.equal((await srv.fetch('/mapa/gpx/neco.txt')).status, 404);
  assert.equal((await srv.fetch('/mapa/gpx/..%2F..%2Ftenant.json')).status, 404);
  assert.equal((await srv.fetch(route.gpxHref, { method: 'POST', body: {} })).status, 405);
});

test('/okoli/img: obrázek zajímavosti s cache a ETag/304, jen Q<id>.jpg, traversal → 404', async () => {
  const api = await (await srv.fetch('/api/v1/okoli.json')).json();
  const src = api.pois[0].image.src;
  const res = await srv.fetch(src);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
  const etag = res.headers.get('etag');
  assert.ok(etag);
  const buf = await res.arrayBuffer();
  assert.ok(buf.length > 5000);
  assert.equal(buf[0], 0xff);
  const again = await srv.fetch(src, { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
  const head = await srv.fetch(src, { method: 'HEAD' });
  assert.equal(head.status, 200);
  for (const bad of ['/okoli/img/Q1.jpg', '/okoli/img/..%2Ftenant.json', '/okoli/img/../tenant.json', '/okoli/img/ATTRIBUTION.md', '/okoli/img/Q1749860.png', '/okoli/img/x.jpg']) {
    assert.equal((await srv.fetch(bad)).status, 404, bad);
  }
});

test('bez okoli.json: stránky zobrazí upozornění, API prázdné pole, GPX 404', async () => {
  const bare = await startServer();
  try {
    fs.unlinkSync(path.join(bare.tenantsDir, 'demo', 'okoli.json'));
    const page = await bare.fetch('/mapa');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Mapa okolí se připravuje/);
    const okoli = await bare.fetch('/okoli');
    assert.equal(okoli.status, 200);
    assert.match(await okoli.text(), /zatím nejsou k dispozici/);
    const api = await (await bare.fetch('/api/v1/okoli.json')).json();
    assert.equal(api.ok, true);
    assert.deepEqual(api.routes, []);
    assert.deepEqual(api.pois, []);
    assert.equal((await bare.fetch('/mapa/gpx/r1.gpx')).status, 404);
  } finally {
    await bare.stop();
  }
});

test('feature mapa: routy, navigace a pomocné funkce', () => {
  assert.equal(mapa.name, 'mapa');
  assert.deepEqual(
    mapa.routes.map((r) => `${r[0]} ${r[1]}`),
    ['GET /mapa', 'GET /mapa/gpx/:file', 'GET /api/v1/okoli.json', 'GET /okoli', 'GET /okoli/img/:file']
  );
  assert.deepEqual(
    mapa.nav.map((n) => n.href),
    ['/mapa', '/okoli']
  );
  assert.deepEqual(mapa.css, ['/vendor/leaflet/leaflet.css', '/css/mapa.css']);
  assert.deepEqual(mapa.js, ['/vendor/leaflet/leaflet.js', '/js/mapa.js']);
  assert.equal(mapa.mapyNavigateUrl(49.0035, 14.7708), 'https://mapy.cz/zakladni?x=14.7708&y=49.0035&z=15&source=coor&id=14.7708%2C49.0035');
  assert.deepEqual([...mapa.networkFilter({ sit: 'icn, NCN,neznama' })], ['icn', 'ncn']);
  assert.equal(mapa.networkFilter({}), null);
  assert.equal(mapa.NETWORKS.icn.color, '#d9480f');
  assert.equal(mapa.tilesConfig({ app: {} }).provider, process.env.MAPY_API_KEY ? 'mapy' : 'cyclosm');
  assert.equal(mapa.tilesConfig({ app: { env: { MAPY_API_KEY: 'k' } } }).provider, 'mapy');
});
