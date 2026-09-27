'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const net = require('node:net');
const { openDb } = require('../src/db');
const httpMod = require('../src/server/http');
const { createRouter, createApp, HttpError, sendBuffer, sendJson, raw, contentDisposition, acceptsGzip, parseUrl, compilePattern, intParam } = httpMod;
const { memoryLogger, silentLog, request, listen } = require('./server-helpers');

// ---------------------------------------------------------------------------------------------------------
// Router

test('router: parametry, dekódování, koncové lomítko', () => {
  const r = createRouter({ log: silentLog });
  const h = () => {};
  r.get('/api/v1/products/:id', h);
  r.get('/api/v1/runs/:runId/proposals/:pid', h);
  let m = r.match('GET', '/api/v1/products/42');
  assert.strictEqual(m.route.pattern, '/api/v1/products/:id');
  assert.deepStrictEqual(m.params, { id: '42' });
  m = r.match('GET', '/api/v1/runs/7/proposals/x%20y');
  assert.deepStrictEqual(m.params, { runId: '7', pid: 'x y' });
  assert.strictEqual(r.match('GET', '/api/v1/products').route, null);
  assert.strictEqual(r.match('GET', '/api/v1/products/1/2').route, null);
  assert.throws(() => r.match('GET', '/api/v1/products/%E0%A4%A'), (e) => e instanceof HttpError && e.status === 400);
});

test('router: více parametrů v segmentu a vlastní regex', () => {
  const r = createRouter({ log: silentLog });
  r.get('/feed/:name.:ext(xml|json|csv)', () => {}, { auth: 'export' });
  r.get('/api/v1/export/changes.:format', () => {});
  let m = r.match('GET', '/feed/changes.xml');
  assert.deepStrictEqual(m.params, { name: 'changes', ext: 'xml' });
  m = r.match('GET', '/feed/moje.ceny.csv');
  assert.deepStrictEqual(m.params, { name: 'moje.ceny', ext: 'csv' });
  assert.strictEqual(r.match('GET', '/feed/changes.pdf').route, null);
  m = r.match('GET', '/api/v1/export/changes.json');
  assert.deepStrictEqual(m.params, { format: 'json' });
  assert.strictEqual(m.route.auth, 'read');
});

test('router: specifičtější vzor vyhrává bez ohledu na pořadí registrace', () => {
  const r = createRouter({ log: silentLog });
  r.get('/api/v1/products/:id', () => 'id');
  r.get('/api/v1/products/facets', () => 'facets');
  r.get('/api/*', () => 'wild');
  assert.strictEqual(r.match('GET', '/api/v1/products/facets').route.pattern, '/api/v1/products/facets');
  assert.strictEqual(r.match('GET', '/api/v1/products/5').route.pattern, '/api/v1/products/:id');
  const w = r.match('GET', '/api/x/y');
  assert.strictEqual(w.route.pattern, '/api/*');
  assert.strictEqual(w.params['*'], 'x/y');
});

test('router: HEAD používá GET routu, jiná metoda → allowed', () => {
  const r = createRouter({ log: silentLog });
  r.get('/a', () => {});
  r.delete('/a', () => {});
  r.all('/b', () => {});
  assert.ok(r.match('HEAD', '/a').route);
  const m = r.match('POST', '/a');
  assert.strictEqual(m.route, null);
  assert.deepStrictEqual(m.allowed.sort(), ['DELETE', 'GET']);
  assert.ok(r.match('PATCH', '/b').route);
});

test('router: duplicitní registrace se ignoruje (první vyhrává), neplatné volby vyhodí chybu', () => {
  const log = memoryLogger();
  const r = createRouter({ log });
  const first = () => 1;
  r.post('/api/v1/settings/password', first, { auth: 'admin' });
  r.post('/api/v1/settings/password', () => 2, { auth: 'admin' });
  assert.strictEqual(r.match('POST', '/api/v1/settings/password').route.handler, first);
  assert.ok(log.records.some((x) => x.level === 'warn'));
  assert.throws(() => r.get('/x', () => {}, { auth: 'superuser' }), TypeError);
  assert.throws(() => r.get('x', () => {}), TypeError);
  assert.throws(() => r.get('/x', 'není funkce'), TypeError);
  assert.throws(() => r.get('/*/x', () => {}), TypeError);
  r.get('/y', () => {}, { auth: ['import', 'export'] });
  assert.deepStrictEqual(r.list().find((x) => x.path === '/y').auth, ['import', 'export']);
});

test('compilePattern a parseUrl', () => {
  assert.ok(compilePattern('/').regex.test('/'));
  assert.deepStrictEqual(parseUrl('//api//v1/products/?q=1'), { pathname: '/api/v1/products', search: 'q=1' });
  assert.deepStrictEqual(parseUrl('http://example.com/a/b?x'), { pathname: '/a/b', search: 'x' });
  assert.throws(() => parseUrl('*'), HttpError);
});

test('acceptsGzip a contentDisposition', () => {
  assert.strictEqual(acceptsGzip('gzip, deflate, br'), true);
  assert.strictEqual(acceptsGzip('br;q=1, gzip;q=0'), false);
  assert.strictEqual(acceptsGzip('*'), true);
  assert.strictEqual(acceptsGzip('identity'), false);
  assert.strictEqual(acceptsGzip(undefined), false);
  const cd = contentDisposition('Ceník – změny (září).xml');
  assert.match(cd, /^attachment; filename="Cenik _ zmeny \(zari\).xml"; filename\*=UTF-8''/);
  assert.ok(cd.includes("filename*=UTF-8''Cen%C3%ADk%20%E2%80%93%20zm%C4%9Bny%20%28z%C3%A1%C5%99%C3%AD%29.xml"));
  assert.ok(!/[\r\n]/.test(contentDisposition('a\r\nb"c')));
});

// ---------------------------------------------------------------------------------------------------------
// Aplikace přes HTTP

async function withApp(setup, fn, { config = {}, log = silentLog } = {}) {
  const db = openDb(':memory:');
  const app = createApp({ db, config: { publicDir: null, maxBodyMb: 1, ...config }, log, api: false, setup });
  const srv = await listen(app);
  try {
    await fn(srv, db);
  } finally {
    await srv.close();
    db.close();
  }
}

function echoRoutes(r) {
  const echo = (ctx) => ({
    bodyType: ctx.bodyType,
    contentType: ctx.contentType,
    isBuffer: Buffer.isBuffer(ctx.body),
    body: Buffer.isBuffer(ctx.body) ? ctx.body.toString('hex') : ctx.body,
    rawLength: ctx.rawBody.length,
    query: ctx.query,
    queryAll: ctx.queryAll,
    params: ctx.params,
  });
  r.post('/api/echo', echo, { auth: 'public' });
  r.post('/api/echo/:a/:b', echo, { auth: 'public' });
  r.get('/api/echo', echo, { auth: 'public' });
  r.post('/api/big', (ctx) => ({ n: ctx.rawBody.length }), { auth: 'public', maxBodyMb: 0.01 });
}

test('tělo: JSON, text, XML, form, raw, prázdné, sniffing', async () => {
  await withApp(echoRoutes, async ({ port }) => {
    let r = await request(port, { method: 'POST', path: '/api/echo', headers: { 'content-type': 'application/json' }, body: '{"a":1,"č":"ř"}' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json().body, { a: 1, č: 'ř' });
    assert.strictEqual(r.json().bodyType, 'json');

    r = await request(port, { method: 'POST', path: '/api/echo', headers: { 'content-type': 'application/xml' }, body: '<a>žluťoučký</a>' });
    assert.strictEqual(r.json().body, '<a>žluťoučký</a>');
    assert.strictEqual(r.json().bodyType, 'text');

    r = await request(port, { method: 'POST', path: '/api/echo', headers: { 'content-type': 'text/csv; charset=windows-1250' }, body: Buffer.from([0x9a, 0xe8, 0x3b, 0x31]) });
    assert.strictEqual(r.json().body, 'šč;1');

    r = await request(port, { method: 'POST', path: '/api/echo', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from([1, 2, 3]) });
    assert.strictEqual(r.json().isBuffer, true);
    assert.strictEqual(r.json().body, '010203');
    assert.strictEqual(r.json().bodyType, 'raw');

    r = await request(port, { method: 'POST', path: '/api/echo', headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: Buffer.from('PK\x03\x04') });
    assert.strictEqual(r.json().bodyType, 'raw');

    r = await request(port, { method: 'POST', path: '/api/echo' });
    assert.deepStrictEqual(r.json().body, {});
    assert.strictEqual(r.json().bodyType, 'empty');

    r = await request(port, { method: 'POST', path: '/api/echo', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=tajn%C3%A9&x=1&x=2' });
    assert.deepStrictEqual(r.json().body, { password: 'tajné', x: '2' });
    assert.strictEqual(r.json().bodyType, 'form');

    // curl -d '{"a":1}' posílá x-www-form-urlencoded → rozpoznáme JSON
    r = await request(port, { method: 'POST', path: '/api/echo', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '{"a":1}' });
    assert.deepStrictEqual(r.json().body, { a: 1 });
    assert.strictEqual(r.json().bodyType, 'json');

    // bez Content-Type: text vs. binární
    r = await request(port, { method: 'POST', path: '/api/echo', body: 'kod;cena\n1;2' });
    assert.strictEqual(r.json().body, 'kod;cena\n1;2');
    r = await request(port, { method: 'POST', path: '/api/echo', body: Buffer.from([0x50, 0x4b, 3, 4, 0, 0]) });
    assert.strictEqual(r.json().bodyType, 'raw');

    // gzip tělo požadavku
    r = await request(port, {
      method: 'POST',
      path: '/api/echo',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: zlib.gzipSync('{"zip":true}'),
    });
    assert.deepStrictEqual(r.json().body, { zip: true });
    r = await request(port, { method: 'POST', path: '/api/echo', headers: { 'content-type': 'application/json', 'content-encoding': 'lzma' }, body: 'x' });
    assert.strictEqual(r.status, 415);
  });
});

test('tělo: neplatný JSON → 400 s českou zprávou', async () => {
  await withApp(echoRoutes, async ({ port }) => {
    const r = await request(port, { method: 'POST', path: '/api/echo', headers: { 'content-type': 'application/json' }, body: '{"a":' });
    assert.strictEqual(r.status, 400);
    const j = r.json();
    assert.strictEqual(j.error.status, 400);
    assert.strictEqual(j.error.message, 'Neplatný JSON v těle požadavku.');
    assert.ok(j.error.details.message);
  });
});

test('tělo: limit velikosti → 413 (Content-Length i chunked), limit i po dekompresi', async () => {
  await withApp(echoRoutes, async ({ port }) => {
    // limit routy 0.01 MB = 10485 B
    let r = await request(port, { method: 'POST', path: '/api/big', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(9000) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json().n, 9000);
    r = await request(port, { method: 'POST', path: '/api/big', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(20000) });
    assert.strictEqual(r.status, 413);
    assert.match(r.json().error.message, /příliš velké/);
    r = await request(port, {
      method: 'POST',
      path: '/api/big',
      headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
      chunks: [Buffer.alloc(6000), Buffer.alloc(6000)],
    }).catch((e) => ({ status: 'reset', e }));
    assert.ok(r.status === 413 || r.status === 'reset', `neočekávaný výsledek ${r.status}`);
    // zip bomba: malé komprimované tělo, velké po rozbalení
    r = await request(port, {
      method: 'POST',
      path: '/api/big',
      headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' },
      body: zlib.gzipSync(Buffer.alloc(100000)),
    });
    assert.strictEqual(r.status, 413);
    // server běží dál
    r = await request(port, { method: 'GET', path: '/api/echo' });
    assert.strictEqual(r.status, 200);
  });
});

test('veřejné routy mají limit těla max 1 MB', async () => {
  await withApp(echoRoutes, async ({ port }) => {
    const r = await request(port, { method: 'POST', path: '/api/echo', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(1024 * 1024 + 10) });
    assert.strictEqual(r.status, 413);
  }, { config: { maxBodyMb: 300 } });
});

test('query: poslední hodnota vyhrává, queryAll drží všechny; parametry cesty', async () => {
  await withApp(echoRoutes, async ({ port }) => {
    let r = await request(port, { path: '/api/echo?a=1&a=2&b=%C5%99&c' });
    const j = r.json();
    assert.deepStrictEqual(j.query, { a: '2', b: 'ř', c: '' });
    assert.deepStrictEqual(j.queryAll, { a: ['1', '2'], b: ['ř'], c: [''] });
    r = await request(port, { method: 'POST', path: '/api/echo/x/%C4%8D' });
    assert.deepStrictEqual(r.json().params, { a: 'x', b: 'č' });
  });
});

test('návratové hodnoty handleru a pomocníci odpovědí', async () => {
  const setup = (r) => {
    r.get('/api/obj', () => ({ ok: true }), { auth: 'public' });
    r.get('/api/created', (ctx) => {
      ctx.status = 201;
      return { id: 1 };
    }, { auth: 'public' });
    r.get('/api/none', () => undefined, { auth: 'public' });
    r.get('/api/text', () => 'ahoj', { auth: 'public' });
    r.get('/api/buf', () => Buffer.from([1, 2]), { auth: 'public' });
    r.get('/api/raw', () => raw({ status: 202, headers: { 'X-Export-Id': 5 }, body: '<a/>', contentType: 'application/xml' }), { auth: 'public' });
    r.get('/api/rawjson', () => raw({ status: 207, body: { a: 1 } }), { auth: 'public' });
    r.get('/api/download', (ctx) => {
      sendBuffer(ctx, Buffer.from('x'), { contentType: 'application/xml', filename: 'Změny cen.xml' });
    }, { auth: 'public' });
    r.get('/api/header', (ctx) => {
      ctx.setHeader('X-Export-Id', '9');
      return { a: 1 };
    }, { auth: 'public' });
    r.get('/api/helper', async (ctx) => {
      await sendJson(ctx, { hi: 1 }, 202);
    }, { auth: 'public' });
    r.get('/api/id/:id', (ctx) => ({ id: intParam(ctx) }), { auth: 'public' });
    r.get('/api/bigint', () => ({ n: 5n }), { auth: 'public' });
  };
  await withApp(setup, async ({ port }) => {
    let r = await request(port, { path: '/api/obj' });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.strictEqual(r.headers['cache-control'], 'no-store');
    r = await request(port, { path: '/api/created' });
    assert.strictEqual(r.status, 201);
    r = await request(port, { path: '/api/none' });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.body.length, 0);
    r = await request(port, { path: '/api/text' });
    assert.strictEqual(r.text, 'ahoj');
    assert.match(r.headers['content-type'], /^text\/plain/);
    r = await request(port, { path: '/api/buf' });
    assert.strictEqual(r.headers['content-type'], 'application/octet-stream');
    r = await request(port, { path: '/api/raw' });
    assert.strictEqual(r.status, 202);
    assert.strictEqual(r.headers['x-export-id'], '5');
    assert.strictEqual(r.text, '<a/>');
    r = await request(port, { path: '/api/rawjson' });
    assert.strictEqual(r.status, 207);
    assert.deepStrictEqual(r.json(), { a: 1 });
    r = await request(port, { path: '/api/download' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-disposition'], `attachment; filename="Zmeny cen.xml"; filename*=UTF-8''Zm%C4%9Bny%20cen.xml`);
    r = await request(port, { path: '/api/header' });
    assert.strictEqual(r.headers['x-export-id'], '9');
    r = await request(port, { path: '/api/helper' });
    assert.strictEqual(r.status, 202);
    assert.deepStrictEqual(r.json(), { hi: 1 });
    r = await request(port, { path: '/api/id/12' });
    assert.deepStrictEqual(r.json(), { id: 12 });
    r = await request(port, { path: '/api/id/abc' });
    assert.strictEqual(r.status, 400);
    r = await request(port, { path: '/api/bigint' });
    assert.deepStrictEqual(r.json(), { n: 5 });
  });
});

test('chyby: HttpError, neznámá chyba → 500 + log, chyby jiných modulů, SQLite constraint', async () => {
  const log = memoryLogger();
  const setup = (r) => {
    r.get('/api/e400', () => {
      throw new HttpError(400, 'Špatně zadané pole', { field: 'x' });
    }, { auth: 'public' });
    r.get('/api/e500', () => {
      throw new Error('tajná interní věc');
    }, { auth: 'public' });
    r.get('/api/filter', () => {
      const e = new Error('Neznámý operátor „~“');
      e.name = 'FilterError';
      throw e;
    }, { auth: 'public' });
    r.get('/api/constraint', (ctx) => {
      ctx.db.prepare("INSERT INTO segments(name, filter, created_at, updated_at) VALUES ('s', '{}', 'x', 'x')").run();
      ctx.db.prepare("INSERT INTO strategies(name, segment_id, config, created_at, updated_at) VALUES ('a', 1, '{}', 'x', 'x')").run();
      ctx.db.prepare('DELETE FROM segments WHERE id = 1').run();
    }, { auth: 'public' });
    r.get('/api/async', async () => {
      await new Promise((res) => setTimeout(res, 5));
      throw new HttpError(409, 'Konflikt');
    }, { auth: 'public' });
    r.get('/api/retry', () => {
      throw new HttpError(429, 'Pomalu', null, { headers: { 'Retry-After': 30 } });
    }, { auth: 'public' });
  };
  await withApp(setup, async ({ port }) => {
    let r = await request(port, { path: '/api/e400' });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(r.json(), { error: { status: 400, message: 'Špatně zadané pole', details: { field: 'x' } } });
    r = await request(port, { path: '/api/e500' });
    assert.strictEqual(r.status, 500);
    assert.deepStrictEqual(r.json(), { error: { status: 500, message: 'Interní chyba serveru', details: null } });
    assert.ok(!r.text.includes('tajná'), 'interní zpráva nesmí uniknout nepřihlášenému');
    const logged = log.records.find((x) => x.level === 'error');
    assert.ok(logged && logged.meta && /tajná interní věc/.test(logged.meta.stack));
    r = await request(port, { path: '/api/filter' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json().error.message, 'Neznámý operátor „~“');
    r = await request(port, { path: '/api/constraint' });
    assert.strictEqual(r.status, 409);
    r = await request(port, { path: '/api/async' });
    assert.strictEqual(r.status, 409);
    r = await request(port, { path: '/api/retry' });
    assert.strictEqual(r.headers['retry-after'], '30');
  }, { log });
});

test('404 JSON pro neznámé /api/* a /feed/*, 405 s Allow, OPTIONS', async () => {
  await withApp((r) => r.get('/api/only-get', () => ({}), { auth: 'public' }), async ({ port }) => {
    let r = await request(port, { path: '/api/v1/neexistuje' });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.json().error.status, 404);
    assert.match(r.json().error.message, /Neznámý endpoint/);
    r = await request(port, { path: '/feed/neco.xml' });
    assert.strictEqual(r.status, 404);
    assert.match(r.headers['content-type'], /json/);
    r = await request(port, { method: 'POST', path: '/neco' });
    assert.strictEqual(r.status, 404);
    assert.match(r.headers['content-type'], /json/);
    r = await request(port, { method: 'DELETE', path: '/api/only-get' });
    assert.strictEqual(r.status, 405);
    assert.match(r.headers.allow, /GET/);
    r = await request(port, { method: 'OPTIONS', path: '/api/only-get' });
    assert.strictEqual(r.status, 204);
    assert.match(r.headers.allow, /HEAD/);
  });
});

test('bezpečnostní hlavičky na všech odpovědích', async () => {
  await withApp((r) => r.get('/api/x', () => ({}), { auth: 'public' }), async ({ port }) => {
    for (const p of ['/api/x', '/api/nic', '/']) {
      const r = await request(port, { path: p });
      assert.strictEqual(r.headers['content-security-policy'], "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'", p);
      assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
      assert.strictEqual(r.headers['referrer-policy'], 'same-origin');
      assert.strictEqual(r.headers['x-frame-options'], 'DENY');
    }
  });
});

test('gzip: velké komprimovatelné odpovědi, ne malé, ne xlsx, ne bez Accept-Encoding; HEAD', async () => {
  const big = { items: Array.from({ length: 300 }, (_, i) => ({ code: `KOLO-${i}`, name: 'Horské kolo Škoda' })) };
  const setup = (r) => {
    r.get('/api/big', () => big, { auth: 'public' });
    r.get('/api/small', () => ({ a: 1 }), { auth: 'public' });
    r.get('/api/xlsx', (ctx) => sendBuffer(ctx, Buffer.alloc(5000, 1), { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: 'návrhy.xlsx' }), { auth: 'public' });
  };
  await withApp(setup, async ({ port }) => {
    let r = await request(port, { path: '/api/big', headers: { 'accept-encoding': 'gzip, deflate, br' } });
    assert.strictEqual(r.headers['content-encoding'], 'gzip');
    assert.match(r.headers.vary, /Accept-Encoding/);
    assert.deepStrictEqual(JSON.parse(zlib.gunzipSync(r.body).toString()), big);
    assert.strictEqual(Number(r.headers['content-length']), r.body.length);
    r = await request(port, { path: '/api/big' });
    assert.strictEqual(r.headers['content-encoding'], undefined);
    assert.deepStrictEqual(r.json(), big);
    r = await request(port, { path: '/api/big', headers: { 'accept-encoding': 'gzip;q=0' } });
    assert.strictEqual(r.headers['content-encoding'], undefined);
    r = await request(port, { path: '/api/small', headers: { 'accept-encoding': 'gzip' } });
    assert.strictEqual(r.headers['content-encoding'], undefined);
    r = await request(port, { path: '/api/xlsx', headers: { 'accept-encoding': 'gzip' } });
    assert.strictEqual(r.headers['content-encoding'], undefined);
    assert.strictEqual(r.body.length, 5000);
    r = await request(port, { method: 'HEAD', path: '/api/big', headers: { 'accept-encoding': 'gzip' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.length, 0);
    assert.strictEqual(Number(r.headers['content-length']), Buffer.byteLength(JSON.stringify(big)));
  });
});

test('přerušené spojení klienta server neshodí', async () => {
  let reached = 0;
  const setup = (r) => {
    r.post('/api/upload', (ctx) => {
      reached++;
      return { n: ctx.rawBody.length };
    }, { auth: 'public' });
    r.get('/api/ok', () => ({ ok: true }), { auth: 'public' });
  };
  await withApp(setup, async ({ port }) => {
    await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write('POST /api/upload HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: 100000\r\n\r\n');
        s.write(Buffer.alloc(1000));
        setTimeout(() => {
          s.destroy();
          resolve();
        }, 30);
      });
      s.on('error', () => resolve());
    });
    await new Promise((r) => setTimeout(r, 30));
    const r = await request(port, { path: '/api/ok' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(reached, 0, 'handler se nesmí zavolat s neúplným tělem');
  });
});

test('HttpError: výchozí zprávy a neplatný status', () => {
  assert.strictEqual(new HttpError(404).message, 'Nenalezeno.');
  assert.strictEqual(new HttpError(123, 'x').status, 500);
  const t = httpMod.toHttpError(Object.assign(new Error('x'), { status: 404 }));
  assert.strictEqual(t.status, 500, 'status cizí chyby (např. HTTP 404 vzdáleného zdroje) se nepřebírá');
  assert.strictEqual(httpMod.toHttpError(Object.assign(new Error('Chybí pole'), { status: 422, expose: true })).status, 422);
});

test('readBody: tělo přijaté celé ještě před čtením (req.complete) se neztratí', async () => {
  const { readBody } = httpMod;
  const got = [];
  const srv = await listen((req, res) => {
    // čteme až po chvíli – parser už má celé tělo v bufferu
    setTimeout(async () => {
      const buf = await readBody(req, 1024 * 1024);
      got.push(buf.toString());
      res.end('ok');
    }, 30);
  });
  try {
    const r = await request(srv.port, { method: 'POST', path: '/', headers: { 'content-type': 'text/plain' }, body: 'malé tělo' });
    assert.strictEqual(r.text, 'ok');
    assert.deepStrictEqual(got, ['malé tělo']);
  } finally {
    await srv.close();
  }
});

test('tělo: klíče __proto__ se z JSON i formuláře zahodí', async () => {
  await withApp(echoRoutes, async ({ port }) => {
    let r = await request(port, { method: 'POST', path: '/api/echo', headers: { 'content-type': 'application/json' }, body: '{"a":1,"__proto__":{"admin":true},"b":{"__proto__":{"x":1}}}' });
    assert.deepStrictEqual(r.json().body, { a: 1, b: {} });
    r = await request(port, { method: 'POST', path: '/api/echo', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '__proto__=x&a=1' });
    assert.deepStrictEqual(r.json().body, { a: '1' });
  });
  assert.strictEqual({}.admin, undefined);
});

test('sendFile / sendStream: streamování, gzip, HEAD, chybějící soubor → 404', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { Readable } = require('node:stream');
  const { tmpDir } = require('./server-helpers');
  const dir = tmpDir();
  const file = path.join(dir, 'ceník.csv');
  fs.writeFileSync(file, 'kod;cena\n'.repeat(1000));
  const setup = (r) => {
    r.get('/api/file', (ctx) => httpMod.sendFile(ctx, file, { filename: 'ceník.csv' }), { auth: 'public' });
    r.get('/api/missing', (ctx) => httpMod.sendFile(ctx, path.join(dir, 'neni.csv')), { auth: 'public' });
    r.get('/api/stream', () => Readable.from([Buffer.from('a'), Buffer.from('b')]), { auth: 'public' });
  };
  try {
    await withApp(setup, async ({ port }) => {
      let r = await request(port, { path: '/api/file' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers['content-type'], 'text/csv; charset=utf-8');
      assert.strictEqual(r.headers['content-length'], '9000');
      assert.match(r.headers['content-disposition'], /filename\*=UTF-8''cen%C3%ADk\.csv/);
      assert.strictEqual(r.text, 'kod;cena\n'.repeat(1000));
      r = await request(port, { path: '/api/file', headers: { 'accept-encoding': 'gzip' } });
      assert.strictEqual(r.headers['content-encoding'], 'gzip');
      assert.strictEqual(zlib.gunzipSync(r.body).toString(), 'kod;cena\n'.repeat(1000));
      r = await request(port, { method: 'HEAD', path: '/api/file' });
      assert.strictEqual(r.body.length, 0);
      assert.strictEqual(r.headers['content-length'], '9000');
      r = await request(port, { path: '/api/missing' });
      assert.strictEqual(r.status, 404);
      assert.match(r.headers['content-type'], /json/);
      r = await request(port, { path: '/api/stream' });
      assert.strictEqual(r.text, 'ab');
      assert.strictEqual(r.headers['content-type'], 'application/octet-stream');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
