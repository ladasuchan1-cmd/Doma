'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/util/log');
const { createRouter } = require('../src/server/http');
const { registerRoutes, MODULES } = require('../src/server/api');
const { start } = require('../server');
const { memoryLogger, request } = require('./server-helpers');

test('loadConfig: výchozí hodnoty', () => {
  const c = loadConfig({});
  assert.strictEqual(c.port, 8080);
  assert.strictEqual(c.host, '0.0.0.0');
  assert.strictEqual(c.dbFile, path.join(__dirname, '..', 'data', 'cenotvorba.db'));
  assert.strictEqual(c.password, null);
  assert.strictEqual(c.secret, null);
  assert.strictEqual(c.maxBodyMb, 300);
  assert.strictEqual(c.publicDir, path.join(__dirname, '..', 'public'));
  assert.strictEqual(c.trustProxy, false);
  assert.strictEqual(c.schedulerEnabled, true);
});

test('loadConfig: proměnné prostředí', () => {
  const c = loadConfig({
    PORT: '3000',
    CENOTVORBA_DB: ':memory:',
    CENOTVORBA_PASSWORD: ' heslo s mezerou ',
    CENOTVORBA_SECRET: 'tajne',
    CENOTVORBA_MAX_BODY_MB: '50',
    CENOTVORBA_PUBLIC_DIR: '/srv/ui',
    CENOTVORBA_TRUST_PROXY: '1',
    CENOTVORBA_SCHEDULER: '0',
    CENOTVORBA_HOST: '127.0.0.1',
  });
  assert.strictEqual(c.port, 3000);
  assert.strictEqual(c.dbFile, ':memory:');
  assert.strictEqual(c.password, ' heslo s mezerou ');
  assert.strictEqual(c.secret, 'tajne');
  assert.strictEqual(c.maxBodyMb, 50);
  assert.strictEqual(c.publicDir, path.resolve('/srv/ui'));
  assert.strictEqual(c.trustProxy, true);
  assert.strictEqual(c.schedulerEnabled, false);
  assert.strictEqual(c.host, '127.0.0.1');
  assert.strictEqual(loadConfig({ PORT: '3000', CENOTVORBA_PORT: '4000' }).port, 4000);
  assert.strictEqual(loadConfig({ PORT: 'abc' }).port, 8080);
  assert.strictEqual(loadConfig({ PORT: '70000' }).port, 8080);
  assert.strictEqual(loadConfig({ CENOTVORBA_SCHEDULER: 'false' }).schedulerEnabled, false);
  assert.strictEqual(loadConfig({ CENOTVORBA_SCHEDULER: '1' }).schedulerEnabled, true);
  assert.strictEqual(loadConfig({ CENOTVORBA_MAX_BODY_MB: '-5' }).maxBodyMb, 300);
  assert.strictEqual(loadConfig({ CENOTVORBA_DB: 'x/y.db' }).dbFile, path.resolve('x/y.db'));
  assert.strictEqual(loadConfig({ CENOTVORBA_PASSWORD: '' }).password, null);
});

test('log: jeden řádek s ISO časem, úrovní a metadaty jako JSON; filtrování úrovní', () => {
  const out = [];
  const err = [];
  const log = createLogger({
    level: 'info',
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    now: () => new Date('2026-09-25T10:00:00.000Z'),
  });
  log.debug('neuvidíš');
  log.info('Import dokončen', { n: 5, zdroj: 'Heureka' });
  log.warn('pozor');
  const e = new Error('chyba\ns novým řádkem');
  log.error('Selhalo', e);
  assert.deepStrictEqual(out, ['2026-09-25T10:00:00.000Z INFO  Import dokončen {"n":5,"zdroj":"Heureka"}\n']);
  assert.strictEqual(err.length, 2);
  assert.strictEqual(err[0], '2026-09-25T10:00:00.000Z WARN  pozor\n');
  assert.ok(err[1].startsWith('2026-09-25T10:00:00.000Z ERROR Selhalo {"message":"chyba\\ns novým řádkem"'));
  assert.strictEqual(err[1].split('\n').length, 2, 'jeden řádek (stack je escapovaný v JSON)');
  log.setLevel('error');
  log.warn('už ne');
  assert.strictEqual(err.length, 2);
  log.setLevel('debug');
  log.debug('teď ano', { big: 1n });
  assert.match(out[1], /DEBUG teď ano \{"big":"1"\}/);
  const cyc = {};
  cyc.self = cyc;
  log.info('cyklus', cyc);
  assert.match(out[2], /\[cyklus\]/);
  assert.strictEqual(createLogger({ level: 'nesmysl' }).getLevel(), 'info');
  assert.strictEqual(createLogger({ level: 'silent' }).isEnabled('error'), false);
});

test('api/index: registruje auth, chybějící moduly tiše přeskočí, /api/v1 vyžaduje přihlášení', () => {
  const r = createRouter({ log: memoryLogger() });
  const res = registerRoutes(r, { log: memoryLogger() });
  assert.deepStrictEqual(res.loaded.slice(0, 1), ['auth']);
  assert.strictEqual(res.loaded.length + res.missing.length + res.failed.length, MODULES.length + 1);
  const paths = r.list().map((x) => `${x.method} ${x.path} ${x.auth}`);
  for (const p of [
    'GET /api/v1/health public',
    'POST /api/v1/auth/login public',
    'POST /api/v1/auth/logout public',
    'GET /api/v1/auth/me any',
    'POST /api/v1/settings/password admin',
    'GET /api/v1/tokens admin',
    'POST /api/v1/tokens admin',
    'DELETE /api/v1/tokens/:id admin',
    'GET /api/v1 any',
  ]) {
    assert.ok(paths.includes(p), p);
  }
});

test('server.start: port 0, :memory:, vygenerované heslo, health, přihlášení, stop zavře DB', async () => {
  const log = memoryLogger();
  const inst = await start({ port: 0, host: '127.0.0.1', dbFile: ':memory:', schedulerEnabled: false, quiet: true, log, env: {} });
  try {
    assert.ok(inst.port > 0);
    assert.strictEqual(inst.url, `http://127.0.0.1:${inst.port}`);
    assert.match(inst.generatedPassword, /^[A-Za-z2-9]{16}$/);
    assert.strictEqual(inst.scheduler, null);
    let r = await request(inst.port, { path: '/api/v1/health' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json().ok, true);
    r = await request(inst.port, {
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: inst.generatedPassword }),
    });
    assert.strictEqual(r.status, 200);
    assert.ok(log.records.some((x) => x.level === 'info' && /Cenotvorba běží na/.test(x.msg)));
  } finally {
    await inst.stop();
  }
  assert.throws(() => inst.db.prepare('SELECT 1').get(), 'DB je po stop() zavřená');
  assert.strictEqual(inst.server.listening, false);
  await inst.stop(); // idempotentní
});

test('server.start: s plánovačem a heslem z env (bez generování)', async () => {
  const log = memoryLogger();
  const inst = await start({
    port: 0,
    host: '127.0.0.1',
    dbFile: ':memory:',
    quiet: true,
    log,
    env: { CENOTVORBA_PASSWORD: 'Env-Heslo-1', CENOTVORBA_SCHEDULER: '1' },
    scheduler: { deps: { dueSources: () => [], runPricing: () => ({}) }, initialDelayMs: 60000 },
  });
  try {
    assert.strictEqual(inst.generatedPassword, null);
    assert.ok(inst.scheduler && typeof inst.scheduler.tick === 'function');
    const summary = await inst.scheduler.tick();
    assert.ok(summary && Array.isArray(summary.errors));
  } finally {
    await inst.stop();
  }
});

test('server.start: obsazený port → chyba, DB se zavře', async () => {
  const a = await start({ port: 0, host: '127.0.0.1', dbFile: ':memory:', schedulerEnabled: false, quiet: true, log: memoryLogger(), env: {} });
  try {
    await assert.rejects(
      start({ port: a.port, host: '127.0.0.1', dbFile: ':memory:', schedulerEnabled: false, quiet: true, log: memoryLogger(), env: {} }),
      (e) => e.code === 'EADDRINUSE'
    );
  } finally {
    await a.stop();
  }
});
