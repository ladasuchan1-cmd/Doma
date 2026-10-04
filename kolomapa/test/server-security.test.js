'use strict';
// Bezpečnost a odolnost HTTP serveru: DNS rebinding (Host), CSRF (Sec-Fetch-Site), hádání hesla, velká těla,
// cache sestavených dat (DoS přes drahé /data/*), hlavičky (CSP bez inline stylů, Vary u 304), chyby parseru.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const data = require('../src/server/data');
const { createApp, hostAllowed, acceptsGzip, resolveStaticPath, CSP, SECURITY_HEADERS, MAX_BODY_BYTES, AUTH_MAX_FAILS } = require('../src/server/http');
const { createRunner } = require('../src/server/scheduler');
const { createLogger } = require('../src/util/log');
const serverMod = require('../server');
const { sampleDb, insertListing } = require('./server-helpers');

const log = createLogger({ level: 'silent' });
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** Surový požadavek přes http.request (vlastní Host apod.). */
function raw(port, method, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Úplně surový požadavek po TCP (vrátí první řádek odpovědi). */
function rawTcp(port, text) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let out = '';
    s.on('data', (d) => (out += d.toString('latin1')));
    s.on('close', () => resolve(out.split('\r\n')[0]));
    s.on('error', () => resolve(out.split('\r\n')[0] || 'ERR'));
    s.write(text);
    setTimeout(() => s.destroy(), 2000).unref();
  });
}

async function startApp({ password = null, allowedHosts, db: givenDb, runFn, now, trustProxy = false } = {}) {
  const { db } = givenDb ? { db: givenDb } : sampleDb();
  const config = { ...loadConfig({}), dbFile: ':memory:', publicDir: PUBLIC_DIR, password, trustProxy, ...(allowedHosts ? { allowedHosts } : {}) };
  const runner = createRunner({ db, config, log, runFn: runFn || (async () => ({ status: 'ok' })) });
  const server = http.createServer(createApp({ db, config, log, runner, ...(now ? { now } : {}) }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port,
    db,
    runner,
    async close() {
      await runner.wait(2000);
      await new Promise((r) => server.close(r));
      if (!givenDb) db.close();
    },
  };
}

test('hostAllowed: IP, localhost, jméno počítače, neveřejné domény ano; veřejné domény ne', () => {
  for (const h of [undefined, '', '127.0.0.1', '127.0.0.1:8090', '192.168.1.20:8090', '[::1]:8090', '[fe80::1]', 'localhost', 'localhost:8090', 'LOCALHOST.', 'app.localhost', 'dilna-pc', 'dilna-pc:8090', 'kolomapa_web:8090', 'kolomapa.local', 'nas.lan:8090', 'x.home.arpa', 'srv.internal']) {
    assert.equal(hostAllowed(h), true, String(h));
  }
  for (const h of ['evil.com', 'evil.com:8090', '127.0.0.1.nip.io', 'localhost.evil.com', 'kolomapa.firma.cz', 'a b', '[::1', 'x/y', 'evil.com.']) {
    assert.equal(hostAllowed(h), false, h);
  }
  assert.equal(hostAllowed('kolomapa.firma.cz:443', new Set(['kolomapa.firma.cz'])), true);
  assert.equal(hostAllowed('cokoli.cz', new Set(['*'])), true);
});

test('bez hesla: cizí Host (DNS rebinding) → 403 všude; s heslem rozhoduje heslo', async () => {
  let started = 0;
  const s = await startApp({ runFn: async () => (started++, { status: 'ok' }) });
  try {
    for (const p of ['/', '/data/summary.json', '/api/run', '/app.js']) {
      const r = await raw(s.port, 'GET', p, { Host: 'rebind.evil.com:8090' });
      assert.equal(r.status, 403, p);
      assert.match(r.body.toString(), /DNS rebinding/);
    }
    const post = await raw(s.port, 'POST', '/api/run', { Host: 'rebind.evil.com', 'X-Requested-With': 'kolomapa' });
    assert.equal(post.status, 403);
    assert.equal(started, 0);
    assert.equal((await raw(s.port, 'GET', '/data/summary.json', { Host: `localhost:${s.port}` })).status, 200);
    assert.equal((await raw(s.port, 'GET', '/data/summary.json', { Host: 'dilna-pc:8090' })).status, 200);
  } finally {
    await s.close();
  }
  const a = await startApp({ allowedHosts: ['kolomapa.firma.cz'] });
  try {
    assert.equal((await raw(a.port, 'GET', '/data/summary.json', { Host: 'kolomapa.firma.cz' })).status, 200);
    assert.equal((await raw(a.port, 'GET', '/data/summary.json', { Host: 'jina.firma.cz' })).status, 403);
  } finally {
    await a.close();
  }
  const p = await startApp({ password: 'heslo' });
  try {
    const auth = { Authorization: 'Basic ' + Buffer.from('x:heslo').toString('base64') };
    assert.equal((await raw(p.port, 'GET', '/data/summary.json', { Host: 'kolomapa.firma.cz' })).status, 401);
    assert.equal((await raw(p.port, 'GET', '/data/summary.json', { Host: 'kolomapa.firma.cz', ...auth })).status, 200);
  } finally {
    await p.close();
  }
});

test('POST /api/run: Sec-Fetch-Site z cizího webu → 403, same-origin → 202', async () => {
  let started = 0;
  const s = await startApp({ runFn: async () => (started++, { status: 'ok' }) });
  try {
    const hdr = { 'X-Requested-With': 'kolomapa' };
    for (const site of ['cross-site', 'same-site', 'none']) {
      const r = await raw(s.port, 'POST', '/api/run', { ...hdr, 'Sec-Fetch-Site': site });
      assert.equal(r.status, 403, site);
    }
    assert.equal(started, 0);
    // preflight cizího webu server nepovolí (žádné CORS hlavičky)
    const pre = await raw(s.port, 'OPTIONS', '/api/run', { Origin: 'http://evil.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-requested-with' });
    assert.notEqual(pre.status, 200);
    assert.equal(pre.headers['access-control-allow-origin'], undefined);
    const ok = await raw(s.port, 'POST', '/api/run', { ...hdr, 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(ok.status, 202);
    await s.runner.wait(2000);
    assert.equal(started, 1);
  } finally {
    await s.close();
  }
});

test('heslo: po AUTH_MAX_FAILS špatných pokusech z jedné IP 429 (i se správným heslem); požadavky bez hlavičky se nepočítají', async () => {
  const s = await startApp({ password: 'spravne-heslo' });
  const auth = (p) => ({ Authorization: 'Basic ' + Buffer.from(`x:${p}`).toString('base64') });
  try {
    for (let i = 0; i < AUTH_MAX_FAILS + 5; i++) assert.equal((await raw(s.port, 'GET', '/data/summary.json')).status, 401);
    assert.equal((await raw(s.port, 'GET', '/data/summary.json', auth('spravne-heslo'))).status, 200);
    for (let i = 0; i < AUTH_MAX_FAILS; i++) assert.equal((await raw(s.port, 'GET', '/data/summary.json', auth(`spatne-${i}`))).status, 401);
    const r = await raw(s.port, 'GET', '/data/summary.json', auth('spravne-heslo'));
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers['retry-after']) > 0);
    assert.equal(r.headers['www-authenticate'], undefined);
    assert.equal((await raw(s.port, 'HEAD', '/', auth('spravne-heslo'))).status, 429);
  } finally {
    await s.close();
  }
});

test('za reverzní proxy (KOLOMAPA_TRUST_PROXY): hádání hesla zablokuje jen adresu útočníka z X-Forwarded-For', async () => {
  const auth = (p) => ({ Authorization: 'Basic ' + Buffer.from(`x:${p}`).toString('base64') });
  const via = (ip, p) => ({ ...auth(p), 'X-Forwarded-For': ip });
  {
    const s = await startApp({ password: 'spravne-heslo', trustProxy: true });
    try {
      // podvržená první položka nepomůže – rozhoduje poslední (přidává ji proxy)
      for (let i = 0; i < AUTH_MAX_FAILS; i++) assert.equal((await raw(s.port, 'GET', '/data/summary.json', via(`10.9.9.${i}, 203.0.113.7`, `spatne-${i}`))).status, 401);
      assert.equal((await raw(s.port, 'GET', '/data/summary.json', via('203.0.113.7', 'spravne-heslo'))).status, 429, 'útočník blokován');
      assert.equal((await raw(s.port, 'GET', '/data/summary.json', via('198.51.100.20', 'spravne-heslo'))).status, 200, 'majitel se přihlásí');
    } finally {
      await s.close();
    }
  }
  {
    // bez KOLOMAPA_TRUST_PROXY se hlavička ignoruje (jinak by si ji útočník přímo na port volil sám)
    const s = await startApp({ password: 'spravne-heslo' });
    try {
      for (let i = 0; i < AUTH_MAX_FAILS; i++) await raw(s.port, 'GET', '/data/summary.json', via(`203.0.113.${i}`, `spatne-${i}`));
      assert.equal((await raw(s.port, 'GET', '/data/summary.json', via('198.51.100.20', 'spravne-heslo'))).status, 429);
    } finally {
      await s.close();
    }
  }
});

test('clientIp: X-Forwarded-For jen od proxy na stejném počítači, jen platná IP', () => {
  const { clientIp } = require('../src/server/http');
  const req = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff == null ? {} : { 'x-forwarded-for': xff } });
  assert.equal(clientIp(req('127.0.0.1', '1.2.3.4'), true), '1.2.3.4');
  assert.equal(clientIp(req('::ffff:127.0.0.1', '9.9.9.9, 1.2.3.4'), true), '1.2.3.4');
  assert.equal(clientIp(req('::1', '2001:db8::1'), true), '2001:db8::1');
  assert.equal(clientIp(req('192.0.2.5', '1.2.3.4'), true), '192.0.2.5', 'přímé spojení z internetu: hlavičce nevěřit');
  assert.equal(clientIp(req('127.0.0.1', 'nesmysl'), true), '127.0.0.1');
  assert.equal(clientIp(req('127.0.0.1'), true), '127.0.0.1');
  assert.equal(clientIp(req('127.0.0.1', '1.2.3.4'), false), '127.0.0.1');
});

test('401 na HEAD bez těla; 413 pro velké tělo požadavku', async () => {
  const s = await startApp({ password: 'heslo' });
  try {
    const head = await raw(s.port, 'HEAD', '/data/summary.json');
    assert.equal(head.status, 401);
    assert.equal(head.body.length, 0);
    const big = await rawTcp(s.port, `POST /api/run HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${MAX_BODY_BYTES + 1}\r\nConnection: close\r\n\r\n`);
    assert.match(big, / 413 /);
  } finally {
    await s.close();
  }
});

test('hlavičky: CSP bez inline skriptů/stylů a stejná jako v index.html; 304 s Vary; gzip podle Accept-Encoding', async () => {
  assert.doesNotMatch(CSP, /unsafe-inline|unsafe-eval/);
  assert.match(CSP, /frame-ancestors 'none'/);
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const meta = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  assert.ok(meta, 'index.html má CSP v <meta>');
  assert.equal(meta[1], CSP.replace(/;\s*frame-ancestors 'none'/, ''), 'CSP v <meta> (statický export) se má shodovat s hlavičkou serveru');
  assert.equal(SECURITY_HEADERS['X-Frame-Options'], 'DENY');
  // CSP bez 'unsafe-inline' u stylů: UI smí styly nastavovat jen přes CSSOM (element.style.x = …)
  const app = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  assert.doesNotMatch(app, /setAttribute\(\s*['"]style['"]|['"]?\bstyle['"]?\s*:\s*['"`]/, 'app.js nesmí používat atribut style (CSP)');
  assert.doesNotMatch(html, /\sstyle=|<style/i, 'index.html nesmí mít inline styly (CSP)');

  assert.equal(acceptsGzip('gzip, deflate, br'), true);
  assert.equal(acceptsGzip('br;q=1, gzip;q=0.5'), true);
  assert.equal(acceptsGzip('*'), true);
  assert.equal(acceptsGzip('gzip;q=0'), false);
  assert.equal(acceptsGzip('identity'), false);
  assert.equal(acceptsGzip(undefined), false);

  const s = await startApp();
  try {
    for (const p of ['/data/summary.json', '/data/kraj/JHM.json', '/data/kraje.geojson', '/app.js']) {
      const r = await raw(s.port, 'GET', p, { 'Accept-Encoding': 'gzip' });
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.vary, 'Accept-Encoding', p);
      assert.ok(r.headers['content-security-policy'], p);
      const r304 = await raw(s.port, 'GET', p, { 'If-None-Match': r.headers.etag });
      assert.equal(r304.status, 304, p);
      assert.equal(r304.headers.vary, 'Accept-Encoding', p);
      assert.equal(r304.headers.etag, r.headers.etag, p);
    }
    const id = await raw(s.port, 'GET', '/data/kraje.geojson', { 'Accept-Encoding': 'gzip;q=0' });
    assert.equal(id.headers['content-encoding'], undefined);
    assert.equal(JSON.parse(id.body.toString()).features.length, 14);
  } finally {
    await s.close();
  }
});

test('cache dat: opakovaný požadavek nesestavuje data znovu; zápis (i z jiného spojení) cache zneplatní', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolomapa-cache-'));
  const file = path.join(dir, 'k.db');
  const db = openDb(file);
  insertListing(db, { kraj: 'JHM' });
  const counts = { summary: 0, kraj: 0 };
  const orig = { buildSummary: data.buildSummary, buildKraj: data.buildKraj };
  data.buildSummary = (...a) => (counts.summary++, orig.buildSummary(...a));
  data.buildKraj = (...a) => (counts.kraj++, orig.buildKraj(...a));
  const s = await startApp({ db });
  try {
    const get = async (p) => {
      const r = await raw(s.port, 'GET', p);
      assert.equal(r.status, 200, p);
      return { etag: r.headers.etag, json: JSON.parse(r.body.toString()) };
    };
    const k1 = await get('/data/kraj/JHM.json');
    const k2 = await get('/data/kraj/jhm.json');
    await get('/data/summary.json');
    await get('/data/summary.json');
    await raw(s.port, 'HEAD', '/data/kraj/JHM.json');
    assert.equal(counts.kraj, 1);
    assert.equal(counts.summary, 1);
    assert.equal(k1.etag, k2.etag);
    assert.equal(k1.json.listings.length, 1);

    // zápis tímto spojením (běh v serveru)
    insertListing(db, { kraj: 'JHM', title: 'Nové kolo' });
    const k3 = await get('/data/kraj/JHM.json');
    assert.equal(counts.kraj, 2);
    assert.equal(k3.json.listings.length, 2);
    assert.notEqual(k3.etag, k1.etag);
    assert.equal((await get('/data/summary.json')).json.kraje.JHM.count, 2);

    // zápis jiným spojením (tools/run.js v jiném procesu)
    const other = openDb(file);
    insertListing(other, { kraj: 'JHM', title: 'Kolo z cronu' });
    other.close();
    const k4 = await get('/data/kraj/JHM.json');
    assert.equal(k4.json.listings.length, 3);
    assert.equal((await get('/data/summary.json')).json.kraje.JHM.count, 3);

    // 20 souběžných požadavků = jedno sestavení
    const before = counts.kraj;
    await Promise.all(Array.from({ length: 20 }, () => raw(s.port, 'GET', '/data/kraj/JHM.json', { 'Accept-Encoding': 'gzip' })));
    assert.equal(counts.kraj, before);

    // rozpracovaná transakce se necachuje (mohla by skončit ROLLBACKem); db.isTransaction je od Node 22.16
    if (typeof db.isTransaction !== 'boolean') return;
    db.exec('BEGIN');
    insertListing(db, { kraj: 'JHM', title: 'Vrácené kolo' });
    assert.equal((await get('/data/kraj/JHM.json')).json.listings.length, 4);
    db.exec('ROLLBACK');
    assert.equal((await get('/data/kraj/JHM.json')).json.listings.length, 3);
  } finally {
    Object.assign(data, orig);
    await s.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cache přehledu: nové 10min okno → nové sestavení, na klíč jen jedna položka (žádný únik paměti)', async () => {
  let t = Date.parse('2026-10-02T08:00:00Z');
  let builds = 0;
  const orig = data.buildSummary;
  data.buildSummary = (...a) => (builds++, orig(...a));
  const s = await startApp({ now: () => new Date(t) });
  try {
    const get = async () => JSON.parse((await raw(s.port, 'GET', '/data/summary.json')).body.toString());
    const a = await get();
    t += 5 * 60000; // stejné okno
    await get();
    assert.equal(builds, 1);
    t += 10 * 60000; // další okno → newSince se posune
    const b = await get();
    assert.equal(builds, 2);
    assert.notEqual(a.newSince, b.newSince);
    t -= 10 * 60000; // zpět do prvního okna: položka se přepsala, ne nahromadila → znovu sestavit
    await get();
    assert.equal(builds, 3);
  } finally {
    data.buildSummary = orig;
    await s.close();
  }
});

test('resolveStaticPath: dvojtečka (disk Windows, NTFS proudy) se odmítne', () => {
  const root = path.resolve('/srv/public');
  assert.equal(resolveStaticPath(root, '/C:/Windows/win.ini'), null);
  assert.equal(resolveStaticPath(root, '/app.js::$DATA'), null);
  assert.equal(resolveStaticPath(root, '/vendor/leaflet/leaflet.js'), path.join(root, 'vendor', 'leaflet', 'leaflet.js'));
});

test('server.js: chyby parseru (431/400), KOLOMAPA_ALLOWED_HOSTS', async () => {
  assert.deepEqual(serverMod.parseHostList(' Kolomapa.Firma.cz:443, dilna ;[::1]:8090 '), ['kolomapa.firma.cz', 'dilna', '::1']);
  assert.deepEqual(serverMod.parseHostList(undefined), []);
  const db = openDb(':memory:');
  const inst = await serverMod.start({
    env: { KOLOMAPA_ALLOWED_HOSTS: 'kolomapa.firma.cz', KOLOMAPA_RUN_ON_START: '0' },
    db,
    log,
    port: 0,
    host: '127.0.0.1',
    password: null,
    scheduler: false,
    publicDir: PUBLIC_DIR,
  });
  try {
    assert.deepEqual(inst.config.allowedHosts, ['kolomapa.firma.cz']);
    assert.equal((await raw(inst.port, 'GET', '/data/summary.json', { Host: 'kolomapa.firma.cz' })).status, 200);
    assert.equal((await raw(inst.port, 'GET', '/data/summary.json', { Host: 'evil.com' })).status, 403);
    assert.match(await rawTcp(inst.port, `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Big: ${'a'.repeat(20000)}\r\n\r\n`), / 431 /);
    assert.match(await rawTcp(inst.port, `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`), / 400 /);
  } finally {
    await inst.stop();
    db.close();
  }
});
