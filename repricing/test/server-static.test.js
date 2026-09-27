'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { openDb } = require('../src/db');
const { createApp } = require('../src/server/http');
const { resolveStaticPath, mimeType, isCompressible } = require('../src/server/static');
const { silentLog, request, listen, tmpDir } = require('./server-helpers');

function makePublic() {
  const root = tmpDir();
  const pub = path.join(root, 'public');
  fs.mkdirSync(path.join(pub, 'views'), { recursive: true });
  fs.mkdirSync(path.join(pub, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><title>Cenotvorba</title><script type="module" src="app.js"></script>');
  fs.writeFileSync(path.join(pub, 'app.js'), 'export const x = 1;\n' + '// komentář\n'.repeat(400));
  fs.writeFileSync(path.join(pub, 'styles.css'), 'body{color:red}');
  fs.writeFileSync(path.join(pub, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(pub, 'font.woff2'), Buffer.alloc(4000, 7));
  fs.writeFileSync(path.join(pub, 'favicon.ico'), Buffer.from([0, 0, 1, 0]));
  fs.writeFileSync(path.join(pub, 'manifest.webmanifest'), '{"name":"Cenotvorba"}');
  fs.writeFileSync(path.join(pub, 'views', 'produkty.js'), 'export default 1;');
  fs.writeFileSync(path.join(pub, 'docs', 'index.html'), '<p>docs</p>');
  fs.writeFileSync(path.join(pub, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(root, 'tajne.txt'), 'TAJNE-HESLO');
  try {
    fs.symlinkSync(path.join(root, 'tajne.txt'), path.join(pub, 'odkaz.txt'));
  } catch {
    /* symlinky nemusí být povolené */
  }
  return { root, pub };
}

async function withStatic(fn) {
  const { root, pub } = makePublic();
  const db = openDb(':memory:');
  const app = createApp({ db, config: { publicDir: pub }, log: silentLog, api: false, setup: (r) => r.get('/api/x', () => ({ ok: 1 }), { auth: 'public' }) });
  const srv = await listen(app);
  try {
    await fn(srv, { root, pub });
  } finally {
    await srv.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('index.html: text/html, no-cache, bez ETagu; SPA fallback pro cesty bez přípony', async () => {
  await withStatic(async ({ port }) => {
    for (const p of ['/', '/index.html', '/produkty/123', '/navrhy']) {
      const r = await request(port, { path: p });
      assert.strictEqual(r.status, 200, p);
      assert.match(r.headers['content-type'], /^text\/html; charset=utf-8/);
      assert.strictEqual(r.headers['cache-control'], 'no-cache');
      assert.strictEqual(r.headers.etag, undefined);
      assert.match(r.text, /<title>Cenotvorba<\/title>/);
      assert.strictEqual(r.headers['x-frame-options'], 'DENY');
    }
    // adresář s vlastním index.html
    const d = await request(port, { path: '/docs/' });
    assert.strictEqual(d.text, '<p>docs</p>');
  });
});

test('MIME typy a ETag / If-None-Match → 304', async () => {
  await withStatic(async ({ port }) => {
    const cases = {
      '/app.js': 'text/javascript; charset=utf-8',
      '/views/produkty.js': 'text/javascript; charset=utf-8',
      '/styles.css': 'text/css; charset=utf-8',
      '/icon.svg': 'image/svg+xml',
      '/font.woff2': 'font/woff2',
      '/favicon.ico': 'image/x-icon',
      '/manifest.webmanifest': 'application/manifest+json; charset=utf-8',
    };
    for (const [p, ct] of Object.entries(cases)) {
      const r = await request(port, { path: p });
      assert.strictEqual(r.status, 200, p);
      assert.strictEqual(r.headers['content-type'], ct, p);
      assert.strictEqual(r.headers['cache-control'], 'no-cache');
      assert.ok(r.headers.etag, p);
    }
    const first = await request(port, { path: '/app.js' });
    const second = await request(port, { path: '/app.js', headers: { 'if-none-match': first.headers.etag } });
    assert.strictEqual(second.status, 304);
    assert.strictEqual(second.body.length, 0);
    const other = await request(port, { path: '/app.js', headers: { 'if-none-match': 'W/"jiny"' } });
    assert.strictEqual(other.status, 200);
  });
});

test('gzip statických souborů (JS ano, woff2 ne)', async () => {
  await withStatic(async ({ port }) => {
    let r = await request(port, { path: '/app.js', headers: { 'accept-encoding': 'gzip' } });
    assert.strictEqual(r.headers['content-encoding'], 'gzip');
    assert.match(zlib.gunzipSync(r.body).toString(), /^export const x = 1;/);
    r = await request(port, { path: '/font.woff2', headers: { 'accept-encoding': 'gzip' } });
    assert.strictEqual(r.headers['content-encoding'], undefined);
    assert.strictEqual(r.body.length, 4000);
  });
});

test('ochrana proti průchodu adresáři, skrytým souborům a symlinkům ven', async () => {
  await withStatic(async ({ port }) => {
    const bad = [
      '/../tajne.txt',
      '/..%2ftajne.txt',
      '/%2e%2e/tajne.txt',
      '/views/..%2f..%2ftajne.txt',
      '/%2e%2e%5ctajne.txt',
      '/..\\tajne.txt',
      '/.env',
      '/views/%2e%2e/.env',
      '/app.js%00.png',
      '/%E0%A4%A',
      '/odkaz.txt',
    ];
    for (const p of bad) {
      const r = await request(port, { path: p });
      assert.ok(!r.text.includes('TAJNE-HESLO'), `únik přes ${p}`);
      assert.ok(!r.text.includes('SECRET=1'), `únik .env přes ${p}`);
      assert.ok(r.status === 404 || r.status === 400, `${p} → ${r.status}`);
    }
  });
});

test('chybějící soubor s příponou → 404 (žádný fallback), ne-GET → 404 JSON', async () => {
  await withStatic(async ({ port }) => {
    let r = await request(port, { path: '/chybi.js' });
    assert.strictEqual(r.status, 404);
    assert.match(r.headers['content-type'], /^text\/plain/);
    r = await request(port, { method: 'POST', path: '/index.html' });
    assert.strictEqual(r.status, 404);
    assert.match(r.headers['content-type'], /json/);
    r = await request(port, { method: 'HEAD', path: '/styles.css' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.length, 0);
    assert.strictEqual(r.headers['content-length'], '15');
  });
});

test('bez public/index.html → 404 s vysvětlením, API funguje', async () => {
  const root = tmpDir();
  const db = openDb(':memory:');
  const app = createApp({ db, config: { publicDir: path.join(root, 'neni') }, log: silentLog, api: false, setup: (r) => r.get('/api/x', () => ({ ok: 1 }), { auth: 'public' }) });
  const srv = await listen(app);
  try {
    let r = await request(srv.port, { path: '/' });
    assert.strictEqual(r.status, 404);
    assert.match(r.text, /Uživatelské rozhraní není k dispozici/);
    r = await request(srv.port, { path: '/api/x' });
    assert.strictEqual(r.status, 200);
  } finally {
    await srv.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveStaticPath, mimeType, isCompressible', () => {
  const root = path.resolve('/srv/public');
  assert.strictEqual(resolveStaticPath(root, '/app.js'), path.join(root, 'app.js'));
  assert.strictEqual(resolveStaticPath(root, '/'), root);
  assert.strictEqual(resolveStaticPath(root, '/../etc/passwd'), null);
  assert.strictEqual(resolveStaticPath(root, '/a/%2e%2e/%2e%2e/etc'), null);
  assert.strictEqual(resolveStaticPath(root, '/.git/config'), null);
  assert.strictEqual(resolveStaticPath(root, '/a%00'), null);
  assert.strictEqual(resolveStaticPath(root, 'relativni'), null);
  assert.strictEqual(resolveStaticPath(root, '/%C5%99.js'), path.join(root, 'ř.js'));
  assert.strictEqual(mimeType('x.JS'), 'text/javascript; charset=utf-8');
  assert.strictEqual(mimeType('x.unknown'), 'application/octet-stream');
  assert.strictEqual(isCompressible('application/json; charset=utf-8'), true);
  assert.strictEqual(isCompressible('image/svg+xml'), true);
  assert.strictEqual(isCompressible('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), false);
  assert.strictEqual(isCompressible('application/zip'), false);
  assert.strictEqual(isCompressible('font/woff2'), false);
  assert.strictEqual(isCompressible(undefined), false);
});
