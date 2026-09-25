'use strict';
// Testy běhu importu, náhledu a zdrojů z URL (SPEC §5 sources.js). Síť jen přes lokální http server.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { openDb } = require('../src/db');
const { encodeWindows1250 } = require('../src/formats');
const { runImport, previewImport, fetchSource, runSource, dueSources, importProducts, ImportError } = require('../src/import');

const FIX = path.join(__dirname, 'fixtures', 'import');
const fx = (name) => ({ buffer: fs.readFileSync(path.join(FIX, name)), filename: name });
const T1 = '2026-09-25T10:00:00.000Z';

function withServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

function insertSource(db, fields) {
  const s = {
    name: 'Zdroj',
    kind: 'offers',
    url: null,
    method: 'GET',
    headers: '{}',
    mapping: '{}',
    options: '{}',
    interval_minutes: 0,
    enabled: 1,
    last_run_at: null,
    ...fields,
  };
  for (const k of ['headers', 'mapping', 'options']) if (typeof s[k] !== 'string') s[k] = JSON.stringify(s[k]);
  return Number(
    db
      .prepare(
        'INSERT INTO sources (name, kind, url, method, headers, mapping, options, interval_minutes, enabled, last_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(s.name, s.kind, s.url, s.method, s.headers, s.mapping, s.options, s.interval_minutes, s.enabled, s.last_run_at, T1, T1).lastInsertRowid
  );
}

const seed = (db) => importProducts(db, [{ code: 'SRA-001', ean: '8597315660484' }, { code: 'MAX-028', ean: '8595234463384' }], { now: T1 });

test('runImport: log v imports (running → ok), stats, import_id; mapování jako JSON text', () => {
  const db = openDb();
  seed(db);
  const r = runImport(db, {
    kind: 'offers',
    input: { text: 'ean;price\n8597315660484;12 990 Kč\n8595234463384;799\n' },
    mapping: JSON.stringify({ defaults: { competitor: 'VeloMarket.cz' } }),
    options: { replace: 'competitors' },
    origin: 'api',
    sourceId: null,
    now: T1,
  });
  assert.ok(r.import_id > 0);
  assert.equal(r.stats.matched, 2);
  assert.equal(r.format, 'csv');
  const row = { ...db.prepare('SELECT * FROM imports WHERE id = ?').get(r.import_id) };
  assert.equal(row.status, 'ok');
  assert.equal(row.kind, 'offers');
  assert.equal(row.format, 'csv');
  assert.equal(row.origin, 'api');
  assert.equal(row.started_at, T1);
  assert.ok(row.finished_at);
  assert.deepEqual(JSON.parse(row.stats), r.stats);
  assert.equal(r.preview, undefined);
});

test('runImport: chyba vstupu → imports.status error, výjimka ImportError s import_id a HTTP 400', () => {
  const db = openDb();
  assert.throws(
    () => runImport(db, { kind: 'offers', input: { text: '<a><b></a>' }, origin: 'upload', now: T1 }),
    (e) => {
      assert.equal(e.status, 400);
      assert.equal(e.expose, true);
      assert.ok(e.import_id > 0);
      const row = db.prepare('SELECT * FROM imports WHERE id = ?').get(e.import_id);
      assert.equal(row.status, 'error');
      assert.match(row.error, /XML/);
      return true;
    }
  );
  assert.throws(() => runImport(db, { kind: 'offers', input: { text: 'ean;price\n' }, now: T1 }), /žádné záznamy/);
  assert.throws(() => runImport(db, { kind: 'zboží', input: { text: 'a' } }), ImportError);
  assert.throws(() => runImport(db, { kind: 'offers', input: { text: 'a;b\n1;2' }, mapping: '{rozbité' }), /JSON/);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM imports WHERE status = 'error'").get().c, 2);
});

test('runImport: dryRun nic nezapíše (ani log), vrátí plné statistiky a náhled', () => {
  const db = openDb();
  seed(db);
  const before = db.prepare('SELECT COUNT(*) AS c FROM imports').get().c;
  const r = runImport(db, { kind: 'offers', input: fx('heureka-konkurence.xml'), dryRun: true, now: T1 });
  assert.equal(r.import_id, null);
  assert.deepEqual([r.stats.matched, r.stats.unmatched, r.stats.created, r.stats.competitors_created], [3, 1, 3, 3]);
  assert.equal(r.preview.length, 4);
  assert.equal(r.preview[0].competitor, 'VeloMarket.cz');
  assert.equal(r.fields.competitor, '@shop');
  for (const t of ['offers', 'competitors', 'unmatched_offers', 'offer_history']) assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c, 0, t);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM imports').get().c, before);
  // katalog: dryRun s deaktivací nic nedeaktivuje
  const p = runImport(db, { kind: 'products', input: { text: 'kod;cena\nSRA-001;100\n' }, options: { deactivate_missing: '1' }, dryRun: true, now: T1 });
  assert.equal(p.stats.deactivated, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM products WHERE active = 1').get().c, 2);
});

test('runImport: chyby mapování a importu se slučují podle řádku (max. 100 + souhrn)', () => {
  const db = openDb();
  const lines = ['kod;cena;sklad'];
  for (let i = 0; i < 150; i++) lines.push(i % 2 ? `P${i};${i};hodně` : `;${i};1`);
  const r = runImport(db, { kind: 'products', input: { text: lines.join('\n') }, now: T1 });
  assert.equal(r.stats.received, 150);
  assert.equal(r.stats.created, 75);
  assert.equal(r.stats.errors.length, 100);
  assert.equal(r.stats.errors[0].row, 1);
  assert.equal(r.stats.errors[1].row, 2);
  assert.equal(r.stats.errors[1].warning, true);
  assert.match(r.stats.errors[99].message, /dalších 51/);
  // obecná zpráva (bez řádku) se při stovkách chyb neztratí a počet v souhrnu je skutečný
  const bad = ['kod;cena', ...Array.from({ length: 500 }, (_, i) => `;${i}`)].join('\n');
  const r2 = runImport(db, { kind: 'products', input: { text: bad }, options: { deactivate_missing: true }, now: T1 });
  assert.equal(r2.stats.errors.length, 100);
  assert.equal(r2.stats.errors[0].row, null);
  assert.match(r2.stats.errors[0].message, /deaktivace/);
  assert.equal(r2.stats.deactivated, 0);
  assert.match(r2.stats.errors[99].message, /dalších 402 /);
  const r3 = runImport(db, { kind: 'products', input: { text: bad + '\nP1;5\n' }, options: { deactivate_missing: true }, now: T1 });
  assert.equal(r3.stats.deactivated, 74, 'jediný platný řádek P1 → ostatní produkty z prvního importu se deaktivují');
});

test('previewImport: formát, hlavičky, navržené mapování, ukázka, chyby', () => {
  const p = previewImport({ input: fx('konkurence-bom.csv'), kind: 'offers', mapping: { fields: { competitor: 'Konkurent' } } });
  assert.equal(p.format, 'csv');
  assert.equal(p.itemPath, null);
  assert.deepEqual(p.headers.slice(0, 3), ['EAN', 'Kód výrobce', 'Název u nás']);
  assert.equal(p.suggested.price, 'Cena');
  assert.equal(p.suggested.competitor, 'Konkurent');
  assert.equal(p.sample.length, 6);
  assert.equal(p.canonical.length, 6);
  assert.equal(p.canonical[0], null, 'bez konkurenta je řádek neplatný');
  assert.ok(p.errors.some((e) => e.row === null && /Konkurent/.test(e.message)));
  assert.ok(p.errors.some((e) => e.row === 1 && /konkurent/i.test(e.message)));
  const ok = previewImport({ input: fx('google-merchant.xml'), kind: 'products' });
  assert.equal(ok.itemPath, 'rss.channel.item');
  assert.equal(ok.canonical[0].code, 'SRA-001');
  assert.deepEqual(ok.errors, []);
  const nested = previewImport({ input: fx('konkurence-vnorene.json'), kind: 'offers' });
  assert.equal(nested.offersPath, 'offers');
  assert.equal(nested.canonical[1].in_stock, 0);
});

test('fetchSource: hlavičky, Basic auth z URL, přesměrování, typ obsahu a dekódování cp1250', async () => {
  const seen = [];
  const cp = encodeWindows1250('ean;konkurent;cena\n8597315660484;Kolo Čech;12 990\n');
  const srv = await withServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, token: req.headers['x-token'], method: req.method });
    if (req.url === '/old') {
      res.writeHead(302, { Location: '/data/konkurence.csv' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=windows-1250' });
    res.end(cp);
  });
  try {
    const f = await fetchSource({ url: `${srv.base.replace('http://', 'http://jan:tajne%20heslo@')}/old`, headers: JSON.stringify({ 'X-Token': 'abc' }) });
    assert.ok(Buffer.isBuffer(f.buffer));
    assert.equal(f.contentType, 'text/csv; charset=windows-1250');
    assert.equal(f.filename, 'konkurence.csv');
    assert.equal(seen[0].token, 'abc');
    assert.equal(seen[0].auth, 'Basic ' + Buffer.from('jan:tajne heslo').toString('base64'));
    assert.equal(seen[1].url, '/data/konkurence.csv');
    const p = previewImport({ input: { buffer: f.buffer, contentType: f.contentType }, kind: 'offers' });
    assert.equal(p.canonical[0].competitor, 'Kolo Čech');
  } finally {
    await srv.close();
  }
});

test('fetchSource: ne-2xx → chyba se status, timeout, limit velikosti při čtení těla, špatná URL', async () => {
  const srv = await withServer((req, res) => {
    if (req.url === '/404') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Nenalezeno');
    }
    if (req.url === '/slow') return setTimeout(() => res.end('ok'), 2000);
    if (req.url === '/big') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); // bez Content-Length (chunked)
      let n = 0;
      const push = () => {
        if (n++ > 50 || res.destroyed) return res.end();
        res.write(Buffer.alloc(64 * 1024, 65), () => setImmediate(push));
      };
      return push();
    }
    if (req.url === '/declared') {
      res.writeHead(200, { 'Content-Length': 10 * 1024 * 1024 });
      return res.end(Buffer.alloc(10));
    }
    res.end('ok');
  });
  try {
    await assert.rejects(fetchSource({ url: srv.base + '/404' }), (e) => e.status === 404 && /HTTP 404/.test(e.message) && /Nenalezeno/.test(e.message));
    await assert.rejects(fetchSource({ url: srv.base + '/slow' }, { timeoutMs: 150 }), (e) => e.code === 'FETCH_TIMEOUT' && /časový limit/.test(e.message));
    await assert.rejects(fetchSource({ url: srv.base + '/big' }, { maxBytes: 256 * 1024 }), (e) => e.code === 'FETCH_TOO_LARGE');
    await assert.rejects(fetchSource({ url: srv.base + '/declared' }, { maxBytes: 1024 * 1024 }), (e) => e.code === 'FETCH_TOO_LARGE');
    await assert.rejects(fetchSource({ url: 'ftp://example.cz/x' }), ImportError);
    await assert.rejects(fetchSource({ url: 'není url' }), ImportError);
    await assert.rejects(fetchSource({ url: '' }), /URL/);
    await assert.rejects(fetchSource({ url: 'http://127.0.0.1:1/nic' }), (e) => e.code === 'FETCH_FAILED');
  } finally {
    await srv.close();
  }
});

test('runSource: stáhne, naimportuje, zapíše sources.last_*; gzip a POST s tělem', async () => {
  const db = openDb();
  seed(db);
  const xml = fs.readFileSync(path.join(FIX, 'heureka-konkurence.xml'));
  const bodies = [];
  const srv = await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      bodies.push({ method: req.method, body, type: req.headers['content-type'] });
      if (req.url === '/feed.xml.gz') {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        return res.end(zlib.gzipSync(xml));
      }
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(xml);
    });
  });
  try {
    const id = insertSource(db, { name: 'Heureka', url: srv.base + '/feed.xml', options: { replace: 'competitors' }, interval_minutes: 60 });
    const r = await runSource(db, id, { origin: 'manual', now: T1 });
    assert.equal(r.ok, true);
    assert.equal(r.source_id, id);
    assert.equal(r.stats.matched, 3);
    assert.equal(typeof r.duration_ms, 'number');
    const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
    assert.equal(src.last_status, 'ok');
    assert.equal(src.last_run_at, T1);
    assert.match(src.last_message, /Přijato 4, spárováno 3/);
    const imp = db.prepare('SELECT * FROM imports WHERE id = ?').get(r.import_id);
    assert.deepEqual([imp.source_id, imp.origin, imp.status, imp.format], [id, 'url', 'ok', 'xml']);
    assert.equal(db.prepare('SELECT source_id FROM offers LIMIT 1').get().source_id, id);

    const gz = insertSource(db, { name: 'GZ', url: srv.base + '/feed.xml.gz', method: 'POST', options: { body: { from: '2026-09-01' } } });
    const r2 = await runSource(db, gz, { origin: 'schedule', now: T1 });
    assert.equal(r2.ok, true, r2.error);
    assert.equal(db.prepare('SELECT origin FROM imports WHERE id = ?').get(r2.import_id).origin, 'schedule');
    const post = bodies.find((b) => b.method === 'POST');
    assert.deepEqual(JSON.parse(post.body), { from: '2026-09-01' });
    assert.equal(post.type, 'application/json');
  } finally {
    await srv.close();
  }
});

test('runSource: chyba stažení / importu → {ok:false}, log v imports, last_status error; neznámý zdroj → 404', async () => {
  const db = openDb();
  const srv = await withServer((req, res) => {
    if (req.url === '/500') {
      res.writeHead(500);
      return res.end('chyba serveru');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"rozbité": ');
  });
  try {
    const a = insertSource(db, { url: srv.base + '/500' });
    const r = await runSource(db, a, { now: T1 });
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP 500/);
    assert.ok(r.import_id > 0);
    const imp = db.prepare('SELECT * FROM imports WHERE id = ?').get(r.import_id);
    assert.deepEqual([imp.status, imp.source_id, imp.kind, imp.origin], ['error', a, 'offers', 'url']);
    const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(a);
    assert.equal(src.last_status, 'error');
    assert.match(src.last_message, /HTTP 500/);
    assert.equal(src.last_run_at, T1);

    const b = insertSource(db, { url: srv.base + '/bad.json', kind: 'products' });
    const r2 = await runSource(db, b, { origin: 'schedule', now: T1 });
    assert.equal(r2.ok, false);
    assert.match(r2.error, /JSON/);
    assert.equal(db.prepare('SELECT status FROM imports WHERE id = ?').get(r2.import_id).status, 'error');

    const c = insertSource(db, { url: null });
    const r3 = await runSource(db, c, { now: T1 });
    assert.equal(r3.ok, false);
    assert.match(r3.error, /URL/);

    await assert.rejects(runSource(db, 9999), (e) => e.status === 404);
  } finally {
    await srv.close();
  }
});

test('dueSources: zapnuté, s URL, interval > 0, poslední běh starší než interval; nikdy nespuštěné první', () => {
  const db = openDb();
  const now = '2026-09-25T12:00:00.000Z';
  const due1 = insertSource(db, { name: 'nikdy', url: 'http://x/1', interval_minutes: 60 });
  const due2 = insertSource(db, { name: 'starý', url: 'http://x/2', interval_minutes: 60, last_run_at: '2026-09-25T10:30:00.000Z' });
  const due3 = insertSource(db, { name: 'tolerance', url: 'http://x/3', interval_minutes: 60, last_run_at: '2026-09-25T11:00:20.000Z' });
  insertSource(db, { name: 'čerstvý', url: 'http://x/4', interval_minutes: 60, last_run_at: '2026-09-25T11:30:00.000Z' });
  insertSource(db, { name: 'vypnutý', url: 'http://x/5', interval_minutes: 60, enabled: 0 });
  insertSource(db, { name: 'bez intervalu', url: 'http://x/6', interval_minutes: 0 });
  insertSource(db, { name: 'bez URL', url: '  ', interval_minutes: 5 });
  insertSource(db, { name: 'null URL', url: null, interval_minutes: 5 });
  const due = dueSources(db, now);
  assert.deepEqual(
    due.map((s) => s.id),
    [due1, due2, due3]
  );
  assert.equal(due[0].name, 'nikdy');
  assert.equal(typeof due[0].mapping, 'string', 'řádky tabulky sources beze změny');
  assert.deepEqual(dueSources(db, new Date('2026-09-25T10:00:00Z')).map((s) => s.id), [due1]);
});

test('runImport: už rozparsované tělo API ({items} / pole kanonických nabídek) přes input.records i jako JSON text', () => {
  const db = openDb();
  seed(db);
  const items = [
    { ean: '8597315660484', competitor: 'VeloMarket.cz', price: 12490, in_stock: true, shipping: 0, observed_at: '2026-09-25T08:00:00Z' },
    { code: 'MAX-028', competitor: 'VeloMarket.cz', price: '799 Kč', availability: 'do 3 dnů' },
  ];
  const a = runImport(db, { kind: 'offers', input: { records: items }, origin: 'api', now: T1 });
  assert.deepEqual([a.stats.matched, a.stats.created, a.format], [2, 2, 'json']);
  const b = runImport(db, { kind: 'offers', input: { text: JSON.stringify({ items }), contentType: 'application/json' }, origin: 'api', now: T1 });
  assert.deepEqual([b.stats.matched, b.stats.unchanged], [2, 2]);
  const o = db.prepare("SELECT o.* FROM offers o JOIN products p ON p.id = o.product_id WHERE p.code_key = 'MAX-028'").get();
  assert.deepEqual([o.price, o.in_stock, o.delivery_days], [799, 0, 3]);
});
