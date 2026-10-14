'use strict';
// Stav výkupu u inzerátu (src/server/marks.js + /api/marks) a hledání míst na mapě (/api/places, /api/geocode).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { createApp, MAX_BODY_BYTES } = require('../src/server/http');
const { createLogger } = require('../src/util/log');
const marks = require('../src/server/marks');
const { createGeocoder, labelOf, GeocodeError, QUEUE_MAX } = require('../src/server/geocode');
const geo = require('../src/geo');
const { sampleDb, insertListing } = require('./server-helpers');

const log = createLogger({ level: 'silent' });
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function req(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(buf.toString('utf8'));
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, json, body: buf });
      });
    });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

async function startApp({ password = null, geocoder = null, now } = {}) {
  const { db, ids } = sampleDb();
  const config = { ...loadConfig({}), dbFile: ':memory:', publicDir: PUBLIC_DIR, password };
  const server = http.createServer(createApp({ db, config, log, geocoder, ...(now ? { now } : {}) }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    db,
    ids,
    async close() {
      await new Promise((r) => server.close(r));
      db.close();
    },
  };
}

const POST_HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'kolomapa' };
const basic = (name, pass) => 'Basic ' + Buffer.from(`${name}:${pass}`).toString('base64');

// ------------------------------------------------------------------------------------------------ marks.js

test('setMark: nastavení, poznámka, kdo a kdy, historie; zrušení; beze změny se nic nezapíše', () => {
  const { db, ids } = sampleDb();
  try {
    const id = ids.dealJhm;
    const t1 = new Date('2026-10-14T08:00:00Z');
    let r = marks.setMark(db, id, { status: 'contacted', note: '  volat znovu ve čtvrtek \u0007 ' }, { user: 'lada@koloshop.cz', now: t1 });
    assert.equal(r.changed, true);
    assert.deepEqual(r.mark, { s: 'contacted', at: t1.toISOString(), n: 'volat znovu ve čtvrtek', by: 'lada@koloshop.cz' });
    assert.equal(r.log.length, 1);
    // stejný stav i poznámka → bez zápisu
    r = marks.setMark(db, id, { status: 'contacted', note: 'volat znovu ve čtvrtek' }, { user: 'pavel', now: new Date('2026-10-14T09:00:00Z') });
    assert.equal(r.changed, false);
    assert.equal(r.mark.by, 'lada@koloshop.cz');
    assert.equal(r.log.length, 1);
    // nový stav ve stejné milisekundě → čas se posune o 1 ms (expect musí být jednoznačný)
    r = marks.setMark(db, id, { status: 'bought', note: 'koupeno za 26 tis.' }, { user: 'pavel', now: t1 });
    assert.equal(r.mark.s, 'bought');
    assert.equal(r.mark.at, '2026-10-14T08:00:00.001Z');
    assert.deepEqual(
      r.log.map((x) => x.s),
      ['bought', 'contacted']
    );
    // zrušení
    r = marks.setMark(db, id, { status: null }, { user: 'pavel', now: new Date('2026-10-15T08:00:00Z') });
    assert.equal(r.mark, null);
    assert.equal(r.log[0].s, null);
    assert.equal(r.log.length, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listing_marks').get().n, 0);
  } finally {
    db.close();
  }
});

test('setMark: neplatný stav, dlouhá poznámka, poznámka bez stavu, neznámý inzerát, ne-objekt', () => {
  const { db, ids } = sampleDb();
  try {
    const bad = (body, status, rx, id = ids.dealJhm) =>
      assert.throws(
        () => marks.setMark(db, id, body),
        (e) => e instanceof marks.MarkError && e.status === status && rx.test(e.message)
      );
    bad({ status: 'sold' }, 400, /Neznámý stav/);
    bad({ status: 'contacted', note: 'x'.repeat(marks.NOTE_MAX + 1) }, 400, /moc dlouhá/);
    bad({ status: 'contacted', note: 42 }, 400, /musí být text/);
    bad({ status: '', note: 'jen poznámka' }, 400, /jen se stavem/);
    bad({ status: 'contacted' }, 404, /nenalezen/, 999999);
    bad(['contacted'], 400, /JSON objekt/);
    bad(null, 400, /JSON objekt/);
    // prototyp objektu není stav
    bad({ status: 'toString' }, 400, /Neznámý stav/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listing_mark_log').get().n, 0);
  } finally {
    db.close();
  }
});

test('setMark: souběh – expect jiný než současný stav → conflict bez zápisu', () => {
  const { db, ids } = sampleDb();
  try {
    const id = ids.dealPha;
    // první: viděl inzerát bez stavu
    const a = marks.setMark(db, id, { status: 'contacted', expect: null }, { user: 'lada', now: new Date('2026-10-14T08:00:00Z') });
    assert.equal(a.changed, true);
    // druhý má staré okno (také bez stavu) → konflikt, stav lady zůstává
    const b = marks.setMark(db, id, { status: 'rejected', expect: null }, { user: 'petr', now: new Date('2026-10-14T08:01:00Z') });
    assert.equal(b.conflict, true);
    assert.equal(b.changed, false);
    assert.equal(b.mark.s, 'contacted');
    assert.equal(b.mark.by, 'lada');
    // s aktuálním expect projde
    const c = marks.setMark(db, id, { status: 'rejected', expect: a.mark.at }, { user: 'petr', now: new Date('2026-10-14T08:02:00Z') });
    assert.equal(c.changed, true);
    assert.equal(c.mark.s, 'rejected');
  } finally {
    db.close();
  }
});

test('listMarks: aktivní a nedávno zmizelé inzeráty s údaji pro rozpoznání znovu vloženého kola', () => {
  const { db, ids } = sampleDb();
  try {
    const now = new Date('2026-10-14T12:00:00Z');
    const oldGone = insertListing(db, { gone_at: '2026-06-01T00:00:00Z', title: 'Staré kolo' });
    const recentGone = insertListing(db, { gone_at: '2026-10-01T00:00:00Z', title: 'Nedávno prodané' });
    for (const id of [ids.dealJhm, oldGone, recentGone]) marks.setMark(db, id, { status: 'rejected' }, { now });
    const { statuses, marks: list } = marks.listMarks(db, { now });
    assert.equal(statuses.rejected, 'Nechceme');
    assert.deepEqual(
      list.map((m) => m.id).sort((a, b) => a - b),
      [ids.dealJhm, recentGone].sort((a, b) => a - b)
    );
    const m = list.find((x) => x.id === ids.dealJhm);
    assert.equal(m.s, 'rejected');
    assert.match(m.t, /Stumpjumper/);
    assert.equal(m.p, 30000);
    assert.equal(m.k, 'JHM');
    assert.equal(m.b, 'Trek'); // značka a model z vytěžených údajů – rozpoznání znovu vloženého kola
    assert.equal(m.m, 'Marlin 7');
    assert.equal(typeof m.la, 'number');
    assert.equal(list.find((x) => x.id === recentGone).gone, true);
  } finally {
    db.close();
  }
});

test('úklid zmizelých inzerátů nesmaže ty se stavem výkupu (a se stavem se maže jen s inzerátem)', () => {
  const { db, ids } = sampleDb();
  try {
    const marked = insertListing(db, { gone_at: '2020-01-01T00:00:00Z' });
    const plain = insertListing(db, { gone_at: '2020-01-01T00:00:00Z' });
    marks.setMark(db, marked, { status: 'bought' });
    const sql = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'pipeline.js'), 'utf8');
    assert.match(sql, /NOT IN \(SELECT listing_id FROM listing_marks\)/);
    db.prepare('DELETE FROM listings WHERE gone_at IS NOT NULL AND gone_at < ? AND id NOT IN (SELECT listing_id FROM listing_marks)').run('2021-01-01T00:00:00Z');
    assert.ok(db.prepare('SELECT 1 FROM listings WHERE id = ?').get(marked));
    assert.equal(db.prepare('SELECT 1 FROM listings WHERE id = ?').get(plain), undefined);
    // ON DELETE CASCADE: smazaný inzerát vezme stav i historii s sebou
    db.prepare('DELETE FROM listings WHERE id = ?').run(marked);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listing_marks').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listing_mark_log').get().n, 0);
    assert.ok(ids.dealJhm);
  } finally {
    db.close();
  }
});

// ------------------------------------------------------------------------------------------------ /api/marks

test('/api/marks: zápis jen s CSRF hlavičkou a JSONem, kdo = přihlášený, ETag, detail s historií, 409 při souběhu', async () => {
  const s = await startApp({ password: 'heslo' });
  const auth = basic('Nikol', 'heslo');
  try {
    const id = s.ids.dealJhm;
    const body = JSON.stringify({ status: 'contacted', note: 'nebere telefon', expect: null });
    // bez hesla 401
    assert.equal((await req(s.port, 'POST', `/api/marks/${id}`, { headers: POST_HEADERS, body })).status, 401);
    // bez X-Requested-With 403
    let r = await req(s.port, 'POST', `/api/marks/${id}`, { headers: { Authorization: auth, 'Content-Type': 'application/json' }, body });
    assert.equal(r.status, 403);
    // cizí web (Sec-Fetch-Site) 403
    r = await req(s.port, 'POST', `/api/marks/${id}`, { headers: { ...POST_HEADERS, Authorization: auth, 'Sec-Fetch-Site': 'cross-site' }, body });
    assert.equal(r.status, 403);
    // formulář místo JSONu 415
    r = await req(s.port, 'POST', `/api/marks/${id}`, { headers: { ...POST_HEADERS, Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'status=contacted' });
    assert.equal(r.status, 415);
    // rozbitý JSON 400, neznámý inzerát 404, neplatné id 400
    r = await req(s.port, 'POST', `/api/marks/${id}`, { headers: { ...POST_HEADERS, Authorization: auth }, body: '{"status":' });
    assert.equal(r.status, 400);
    assert.equal((await req(s.port, 'POST', '/api/marks/999999', { headers: { ...POST_HEADERS, Authorization: auth }, body })).status, 404);
    assert.equal((await req(s.port, 'POST', '/api/marks/abc', { headers: { ...POST_HEADERS, Authorization: auth }, body })).status, 400);
    // jiná metoda 405 s Allow
    r = await req(s.port, 'DELETE', `/api/marks/${id}`, { headers: { Authorization: auth } });
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, 'GET, HEAD, POST');

    r = await req(s.port, 'POST', `/api/marks/${id}`, { headers: { ...POST_HEADERS, Authorization: auth, 'Sec-Fetch-Site': 'same-origin' }, body });
    assert.equal(r.status, 200);
    assert.equal(r.json.changed, true);
    assert.equal(r.json.mark.s, 'contacted');
    assert.equal(r.json.mark.by, 'Nikol');
    assert.equal(r.json.mark.n, 'nebere telefon');

    // seznam pro mapu + ETag / 304
    r = await req(s.port, 'GET', '/api/marks', { headers: { Authorization: auth } });
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.json.marks.map((m) => [m.id, m.s]),
      [[id, 'contacted']]
    );
    assert.ok(r.headers.etag);
    const again = await req(s.port, 'GET', '/api/marks', { headers: { Authorization: auth, 'If-None-Match': r.headers.etag } });
    assert.equal(again.status, 304);

    // detail inzerátu nese stav i historii
    r = await req(s.port, 'GET', `/api/listing/${id}`, { headers: { Authorization: auth } });
    assert.equal(r.json.mark.s, 'contacted');
    assert.equal(r.json.markLog.length, 1);
    r = await req(s.port, 'GET', `/api/marks/${id}`, { headers: { Authorization: auth } });
    assert.equal(r.json.mark.s, 'contacted');

    // souběh: druhé okno pořád myslí, že stav není → 409 a aktuální stav
    r = await req(s.port, 'POST', `/api/marks/${id}`, { headers: { ...POST_HEADERS, Authorization: basic('petr', 'heslo') }, body: JSON.stringify({ status: 'rejected', expect: null }) });
    assert.equal(r.status, 409);
    assert.equal(r.json.mark.s, 'contacted');
    assert.match(r.json.error, /někdo jiný/);

    // změna ETagu po zápisu
    const before = (await req(s.port, 'GET', '/api/marks', { headers: { Authorization: auth } })).headers.etag;
    const at = (await req(s.port, 'GET', `/api/marks/${id}`, { headers: { Authorization: auth } })).json.mark.at;
    r = await req(s.port, 'POST', `/api/marks/${id}`, { headers: { ...POST_HEADERS, Authorization: basic('petr', 'heslo') }, body: JSON.stringify({ status: 'bought', expect: at }) });
    assert.equal(r.status, 200);
    assert.equal(r.json.mark.by, 'petr');
    const after = (await req(s.port, 'GET', '/api/marks', { headers: { Authorization: auth, 'If-None-Match': before } }));
    assert.equal(after.status, 200);
    assert.equal(after.json.marks[0].s, 'bought');
  } finally {
    await s.close();
  }
});

test('/api/marks: tělo nad limit → spojení zavřeno nebo 413, nic se nezapíše', async () => {
  const s = await startApp();
  try {
    const big = JSON.stringify({ status: 'contacted', note: 'x'.repeat(MAX_BODY_BYTES + 10) });
    let status = null;
    try {
      status = (await req(s.port, 'POST', `/api/marks/${s.ids.dealJhm}`, { headers: POST_HEADERS, body: big })).status;
    } catch {
      status = 'closed';
    }
    assert.ok(status === 413 || status === 'closed', String(status));
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM listing_marks').get().n, 0);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------------------------------------ hledání míst

test('geo.searchPlaces: obce i bez diakritiky, části Prahy, velká města před vesnicemi, kraje, PSČ', () => {
  const first = (q) => geo.searchPlaces(q)[0];
  assert.equal(first('brno').label, 'Brno');
  assert.equal(first('brno').kraj, 'JHM');
  assert.equal(first('ricany').label, 'Říčany');
  assert.equal(first('praha 4').label, 'Praha 4');
  assert.equal(first('hradec').label, 'Hradec Králové');
  assert.equal(first('nove mesto mor').label, 'Nové Město na Moravě');
  assert.equal(first('usti nad l').label, 'Ústí nad Labem');
  const kraj = geo.searchPlaces('jihomoravsky')[0];
  assert.equal(kraj.kind, 'kraj');
  assert.equal(kraj.kraj, 'JHM');
  const psc = geo.searchPlaces('602 00')[0];
  assert.equal(psc.kind, 'psc');
  assert.equal(psc.label, '602 00');
  assert.equal(psc.kraj, 'JHM');
  assert.ok(geo.searchPlaces('110').every((r) => r.kind === 'psc' && r.label.startsWith('110')));
  assert.deepEqual(geo.searchPlaces(''), []);
  assert.deepEqual(geo.searchPlaces('x'), []);
  assert.deepEqual(geo.searchPlaces('Kounicova 10, Brno'), []); // adresa → až Nominatim
  assert.ok(geo.searchPlaces('a'.repeat(5000)).length === 0);
  for (const r of geo.searchPlaces('nove')) {
    assert.ok(Number.isFinite(r.lat) && Number.isFinite(r.lon) && r.zoom > 0);
    assert.ok(r.kraj == null || geo.KRAJE[r.kraj]);
  }
});

test('geocode.labelOf: ulice a číslo, vesnice s číslem popisným, podnik na adrese jen v podtitulku', () => {
  const pub = {
    name: "Suzie's steak pub",
    display_name: "Suzie's steak pub, 10, Kounicova, Veveří, Brno",
    address: { amenity: "Suzie's steak pub", house_number: '10', road: 'Kounicova', suburb: 'Veveří', city: 'Brno', postcode: '602 00' },
  };
  assert.deepEqual(labelOf(pub), { label: 'Kounicova 10', sub: "Suzie's steak pub, Veveří, Brno, 602 00" });
  assert.deepEqual(labelOf({ address: { house_number: '25', village: 'Lhota', postcode: '277 01' } }), { label: 'Lhota 25', sub: '277 01' });
  assert.deepEqual(labelOf({ display_name: 'Říp, Česko', name: 'Říp', address: {} }), { label: 'Říp', sub: '' });
  assert.deepEqual(labelOf({}), { label: 'Místo', sub: '' });
});

function fakeNominatim(responses) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: new URL(url), opts });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { ok: next.status === 200, status: next.status, json: async () => next.body };
  };
  return { calls, fetchImpl };
}

const KOUNICOVA = [
  { lat: '49.2016861', lon: '16.6020495', place_rank: 30, name: 'Pub', address: { house_number: '10', road: 'Kounicova', suburb: 'Veveří', city: 'Brno', state: 'Jihomoravský kraj' } },
  { lat: '49.2017723', lon: '16.6019401', place_rank: 30, name: 'Bar', address: { house_number: '10', road: 'Kounicova', suburb: 'Veveří', city: 'Brno', state: 'Jihomoravský kraj' } },
  { lat: '49.2018', lon: '16.6019', place_rank: 30, address: { house_number: '681/10', road: 'Kounicova', suburb: 'Veveří', city: 'Brno', state: 'Jihomoravský kraj' } },
  { lat: 'x', lon: '16' },
  { lat: '49.2101', lon: '16.5901', place_rank: 26, addresstype: 'road', name: 'Kounicova', address: { road: 'Kounicova', suburb: 'Ponava', city: 'Brno', state: 'Jihomoravský kraj' } },
];

test('createGeocoder: parametry dotazu, User-Agent, sloučení podniků na adrese, kraj, cache, odstup 1 s', async () => {
  const { calls, fetchImpl } = fakeNominatim([
    { status: 200, body: KOUNICOVA },
    { status: 200, body: [] },
  ]);
  let t = 1000;
  const sleeps = [];
  const g = createGeocoder({ url: 'https://nominatim.example/search', userAgent: 'Kolomapa/1.0 (test)', fetchImpl, now: () => t, sleep: async (ms) => sleeps.push(ms) });
  const r = await g.search('  Kounicova 10,   Brno ');
  assert.equal(r.cached, false);
  // adresní bod „681/10“ a podniky v témže domě („10“) = jedno místo; ulice o kus dál zůstane
  assert.deepEqual(
    r.results.map((x) => [x.label, x.kraj, x.zoom]),
    [
      ['Kounicova 681/10', 'JHM', 17],
      ['Kounicova', 'JHM', 16],
    ]
  );
  const u = calls[0].url;
  assert.equal(u.origin + u.pathname, 'https://nominatim.example/search');
  assert.equal(u.searchParams.get('q'), 'Kounicova 10, Brno');
  assert.equal(u.searchParams.get('countrycodes'), 'cz');
  assert.equal(u.searchParams.get('format'), 'jsonv2');
  assert.equal(calls[0].opts.headers['User-Agent'], 'Kolomapa/1.0 (test)');
  // stejný dotaz (jiná velikost písmen) z cache – bez dalšího volání
  const c = await g.search('kounicova 10, brno');
  assert.equal(c.cached, true);
  assert.equal(calls.length, 1);
  // další dotaz hned → čeká do odstupu 1,1 s
  t += 200;
  await g.search('Neexistující ulice 1');
  assert.equal(calls.length, 2);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 800 && sleeps[0] <= 1100, String(sleeps[0]));
});

test('createGeocoder: krátký dotaz 400, přetížení 503, výpadek 502, plná fronta 429', async () => {
  const { fetchImpl } = fakeNominatim([{ status: 429, body: null }, new TypeError('fetch failed'), { status: 500, body: null }]);
  const g = createGeocoder({ userAgent: 'x', fetchImpl, now: () => 0, sleep: async () => {} });
  await assert.rejects(g.search('ab'), (e) => e instanceof GeocodeError && e.status === 400);
  await assert.rejects(g.search('Kounicova 1'), (e) => e.status === 503 && /přetížené/.test(e.message));
  await assert.rejects(g.search('Kounicova 2'), (e) => e.status === 502);
  await assert.rejects(g.search('Kounicova 3'), (e) => e.status === 502 && /HTTP 500/.test(e.message));

  // fronta: QUEUE_MAX dotazů čeká na pomalý vyhledávač, další se odmítne
  let release;
  const gate = new Promise((r) => (release = r));
  const slow = createGeocoder({
    userAgent: 'x',
    now: () => 0,
    sleep: async () => {},
    fetchImpl: async () => {
      await gate;
      return { ok: true, status: 200, json: async () => [] };
    },
  });
  const pending = Array.from({ length: QUEUE_MAX }, (_, i) => slow.search(`ulice ${i}`));
  await assert.rejects(slow.search('ulice navíc'), (e) => e.status === 429);
  release();
  await Promise.all(pending);
});

test('/api/places a /api/geocode: našeptávač bez internetu, adresy přes geokodér, vypnutý geokodér 503', async () => {
  const fake = { search: async (q) => ({ results: [{ label: `Adresa ${q}`, sub: '', lat: 49.2, lon: 16.6, kraj: 'JHM', kind: 'adresa', zoom: 17 }], cached: false }) };
  const s = await startApp({ geocoder: fake });
  try {
    let r = await req(s.port, 'GET', '/api/places?q=ricany');
    assert.equal(r.status, 200);
    assert.equal(r.json.results[0].label, 'Říčany');
    assert.equal(r.json.geocoder, true);
    r = await req(s.port, 'GET', `/api/geocode?q=${encodeURIComponent('Kounicova 10, Brno')}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.results[0].label, 'Adresa Kounicova 10, Brno');
    assert.match(r.json.attribution, /OpenStreetMap/);
    assert.equal((await req(s.port, 'POST', '/api/places?q=x', { headers: POST_HEADERS, body: '{}' })).status, 405);
  } finally {
    await s.close();
  }
  const off = await startApp({ geocoder: null });
  try {
    const r = await req(off.port, 'GET', '/api/geocode?q=Kounicova');
    assert.equal(r.status, 503);
    assert.match(r.json.error, /vypnuté/);
    assert.equal((await req(off.port, 'GET', '/api/places?q=brno')).json.geocoder, false);
  } finally {
    await off.close();
  }
  // chyba geokodéru se ukáže česky (ne „Interní chyba“)
  const failing = await startApp({ geocoder: { search: async () => Promise.reject(new GeocodeError(503, 'Vyhledávání adres je teď přetížené.')) } });
  try {
    const r = await req(failing.port, 'GET', '/api/geocode?q=Kounicova');
    assert.equal(r.status, 503);
    assert.match(r.json.error, /přetížené/);
  } finally {
    await failing.close();
  }
});

test('config: KOLOMAPA_GEOCODER – výchozí Nominatim, vlastní adresa, off, nesmysl s varováním', () => {
  assert.equal(loadConfig({}).geocoderUrl, 'https://nominatim.openstreetmap.org/search');
  assert.equal(loadConfig({ KOLOMAPA_GEOCODER: 'https://geo.firma.cz/search' }).geocoderUrl, 'https://geo.firma.cz/search');
  assert.equal(loadConfig({ KOLOMAPA_GEOCODER: 'off' }).geocoderUrl, null);
  const c = loadConfig({ KOLOMAPA_GEOCODER: 'nominatim' });
  assert.equal(c.geocoderUrl, 'https://nominatim.openstreetmap.org/search');
  assert.ok(c.warnings.some((w) => /KOLOMAPA_GEOCODER/.test(w)));
});
