'use strict';
// HTTP server: data, API, statické soubory (průchod mimo adresář), /api/run (single-flight), heslo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { loadConfig } = require('../src/config');
const { createApp, resolveStaticPath, checkBasicAuth } = require('../src/server/http');
const { createRunner } = require('../src/server/scheduler');
const { createLogger } = require('../src/util/log');
const { sampleDb } = require('./server-helpers');

const log = createLogger({ level: 'silent' });

function tmpPublic() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kolomapa-http-'));
  const pub = path.join(root, 'public');
  fs.mkdirSync(path.join(pub, 'vendor', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><title>Kolomapa</title>');
  fs.writeFileSync(path.join(pub, 'app.js'), 'console.log("app");');
  fs.writeFileSync(path.join(pub, 'vendor', 'lib', 'lib.js'), '/* vendor */');
  fs.writeFileSync(path.join(pub, '.hidden'), 'skryté');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'TAJNE-HESLO');
  return { root, pub };
}

/** Surový požadavek (bez normalizace cesty, kterou dělá fetch/URL). */
function raw(port, method, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

async function startServer({ password = null, runFn } = {}) {
  const { root, pub } = tmpPublic();
  const { db, ids } = sampleDb();
  const config = { ...loadConfig({}), dbFile: ':memory:', publicDir: pub, password };
  const runner = createRunner({ db, config, log, runFn: runFn || (async () => ({ status: 'ok' })) });
  const server = http.createServer(createApp({ db, config, log, runner }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port,
    ids,
    runner,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await runner.wait(2000);
      await new Promise((r) => server.close(r));
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('GET /data/summary.json a /data/kraj/<KOD>.json', async () => {
  const s = await startServer();
  try {
    let r = await fetch(`${s.base}/data/summary.json`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.ok(r.headers.get('content-security-policy'));
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    const summary = await r.json();
    assert.equal(summary.mode, 'server');
    assert.equal(Object.keys(summary.kraje).length, 14);
    assert.ok(r.headers.get('etag'));

    r = await fetch(`${s.base}/data/kraj/JHM.json`);
    assert.equal(r.status, 200);
    const k = await r.json();
    assert.equal(k.kraj, 'JHM');
    assert.equal(k.listings.length, 2);
    // ETag (bez generatedAt) → 304, dokud se data nezmění
    const etag = r.headers.get('etag');
    assert.ok(etag);
    const r304 = await raw(s.port, 'GET', '/data/kraj/JHM.json', { 'If-None-Match': etag });
    assert.equal(r304.status, 304);
    assert.equal(r304.body.length, 0);
    assert.equal((await fetch(`${s.base}/data/kraj/jhm.json`)).status, 200);
    assert.equal((await fetch(`${s.base}/data/kraj/XXX.json`)).status, 404);
    assert.equal((await fetch(`${s.base}/data/kraj/J1.json`)).status, 400);
    assert.equal((await fetch(`${s.base}/data/kraj/JHMX.json`)).status, 400);
    assert.equal((await fetch(`${s.base}/data/kraj/`)).status, 400);
    const bad = await raw(s.port, 'GET', '/data/kraj/..%2f..%2fsecret.json');
    assert.equal(bad.status, 400);

    r = await fetch(`${s.base}/data/kraje.geojson`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).features.length, 14);
    assert.equal((await fetch(`${s.base}/data/summary.json`, { method: 'POST' })).status, 405);
  } finally {
    await s.close();
  }
});

test('gzip pro velké JSON odpovědi', async () => {
  const s = await startServer();
  try {
    const r = await raw(s.port, 'GET', '/data/kraje.geojson', { 'Accept-Encoding': 'gzip' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'gzip');
    const json = JSON.parse(zlib.gunzipSync(r.body).toString('utf8'));
    assert.equal(json.type, 'FeatureCollection');
  } finally {
    await s.close();
  }
});

test('GET /api/listing/:id', async () => {
  const s = await startServer();
  try {
    const r = await fetch(`${s.base}/api/listing/${s.ids.dealJhm}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const l = await r.json();
    assert.equal(l.id, s.ids.dealJhm);
    assert.ok(Array.isArray(l.history));
    assert.equal((await fetch(`${s.base}/api/listing/999999`)).status, 404);
    assert.equal((await fetch(`${s.base}/api/listing/abc`)).status, 400);
    assert.equal((await fetch(`${s.base}/api/neexistuje`)).status, 404);
  } finally {
    await s.close();
  }
});

test('statické soubory: index, typy, cache vendor/, žádný průchod mimo public/', async () => {
  const s = await startServer();
  try {
    let r = await raw(s.port, 'GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    r = await raw(s.port, 'GET', '/app.js');
    assert.match(r.headers['content-type'], /text\/javascript/);
    assert.equal(r.headers['cache-control'], 'no-cache');
    r = await raw(s.port, 'GET', '/vendor/lib/lib.js');
    assert.equal(r.status, 200);
    assert.match(r.headers['cache-control'], /max-age=\d+/);
    const head = await raw(s.port, 'HEAD', '/app.js');
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/vendor/..%2f..%2f..%2fsecret.txt', '/vendor/../../secret.txt', '/%2e%2e%5csecret.txt', '/.hidden', '/nic.js', '/app.js%00.html']) {
      const x = await raw(s.port, 'GET', p);
      assert.equal(x.status, 404, `${p} → ${x.status}`);
      assert.ok(!x.body.toString().includes('TAJNE'), p);
    }
    assert.equal((await raw(s.port, 'DELETE', '/app.js')).status, 405);
  } finally {
    await s.close();
  }
});

test('resolveStaticPath', () => {
  const root = path.resolve('/srv/public');
  assert.equal(resolveStaticPath(root, '/app.js'), path.join(root, 'app.js'));
  assert.equal(resolveStaticPath(root, '/../x'), null);
  assert.equal(resolveStaticPath(root, '/%2e%2e/x'), null);
  assert.equal(resolveStaticPath(root, '/a/.git/config'), null);
  assert.equal(resolveStaticPath(root, '/%E0%A4%A'), null);
  assert.equal(resolveStaticPath(root, 'app.js'), null);
});

test('/api/run: CSRF hlavička, spuštění, 409 při běžícím, průběh, dokončení', async () => {
  const gate = deferred();
  let calls = 0;
  const s = await startServer({
    runFn: async (o) => {
      calls++;
      o.onProgress('Bazoš: stahuji výpis…');
      await gate.promise;
      return { status: 'ok', runId: 1 };
    },
  });
  try {
    let st = await (await fetch(`${s.base}/api/run`)).json();
    assert.equal(st.running, false);
    assert.equal((await fetch(`${s.base}/api/run`, { method: 'POST' })).status, 403);
    const hdr = { 'X-Requested-With': 'kolomapa' };
    let r = await fetch(`${s.base}/api/run`, { method: 'POST', headers: hdr });
    assert.equal(r.status, 202);
    assert.equal((await r.json()).started, true);
    r = await fetch(`${s.base}/api/run`, { method: 'POST', headers: hdr });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /běží/);
    st = await (await fetch(`${s.base}/api/run`)).json();
    assert.equal(st.running, true);
    assert.equal(st.trigger, 'manual');
    assert.equal(st.progress, 'Bazoš: stahuji výpis…');
    gate.resolve();
    await s.runner.wait(2000);
    st = await (await fetch(`${s.base}/api/run`)).json();
    assert.equal(st.running, false);
    assert.equal(st.lastResult.status, 'ok');
    assert.equal(calls, 1);
    assert.equal((await fetch(`${s.base}/api/run`, { method: 'PUT', headers: hdr })).status, 405);
  } finally {
    gate.resolve();
    await s.close();
  }
});

test('heslo: HTTP Basic (jméno libovolné), bez hesla 401', async () => {
  const s = await startServer({ password: 'tajne-heslo' });
  try {
    let r = await raw(s.port, 'GET', '/data/summary.json');
    assert.equal(r.status, 401);
    assert.match(r.headers['www-authenticate'], /Basic realm="Kolomapa"/);
    const auth = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
    r = await raw(s.port, 'GET', '/data/summary.json', auth('kdokoli', 'spatne'));
    assert.equal(r.status, 401);
    r = await raw(s.port, 'GET', '/data/summary.json', auth('kdokoli', 'tajne-heslo'));
    assert.equal(r.status, 200);
    r = await raw(s.port, 'GET', '/', auth('', 'tajne-heslo'));
    assert.equal(r.status, 200);
  } finally {
    await s.close();
  }
});

test('checkBasicAuth', () => {
  const h = (s) => 'Basic ' + Buffer.from(s).toString('base64');
  assert.equal(checkBasicAuth(h('a:b'), 'b'), true);
  assert.equal(checkBasicAuth(h('a:b:c'), 'b:c'), true);
  assert.equal(checkBasicAuth(h('a:x'), 'b'), false);
  assert.equal(checkBasicAuth(undefined, 'b'), false);
  assert.equal(checkBasicAuth('Bearer xyz', 'b'), false);
});

test('config: KOLOMAPA_PASSWORD a KOLOMAPA_EXPORT_AFTER_RUN', () => {
  assert.equal(loadConfig({}).password, null);
  assert.equal(loadConfig({ KOLOMAPA_PASSWORD: ' heslo ' }).password, 'heslo');
  assert.equal(loadConfig({}).exportAfterRun, false);
  assert.equal(loadConfig({ KOLOMAPA_EXPORT_AFTER_RUN: '1' }).exportAfterRun, true);
});
