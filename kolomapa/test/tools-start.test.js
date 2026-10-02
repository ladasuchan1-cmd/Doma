'use strict';
// tools/start.js (start.cmd) – pozná běžící Kolomapu / cizí program na portu, otevře prohlížeč.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { probe, probeHost, browserUrl, openBrowser } = require('../tools/start');

function serve(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const close = (s) => new Promise((r) => s.close(() => r()));

test('probe: volný port / Kolomapa (i s heslem) / jiný program', async () => {
  const kolomapa = await serve((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ running: false, lastRun: null, messages: [] }));
  });
  const locked = await serve((req, res) => {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Kolomapa", charset="UTF-8"' });
    res.end();
  });
  const other = await serve((req, res) => res.end('<html>Jiná aplikace</html>'));
  try {
    assert.equal(await probe(kolomapa.address().port), 'kolomapa');
    assert.equal(await probe(locked.address().port), 'kolomapa');
    assert.equal(await probe(other.address().port), 'other');
    const free = other.address().port;
    await close(other);
    assert.equal(await probe(free), 'free');
  } finally {
    await close(kolomapa);
    await close(locked);
    if (other.listening) await close(other);
  }
});

test('adresy: 0.0.0.0 → localhost; IPv6; konkrétní IP', () => {
  assert.equal(probeHost('0.0.0.0'), '127.0.0.1');
  assert.equal(probeHost('127.0.0.1'), '127.0.0.1');
  assert.equal(probeHost('::'), '::1');
  assert.equal(probeHost('192.168.1.5'), '192.168.1.5');
  assert.equal(browserUrl('127.0.0.1', 8090), 'http://localhost:8090/');
  assert.equal(browserUrl('0.0.0.0', 8091), 'http://localhost:8091/');
  assert.equal(browserUrl('192.168.1.5', 8090), 'http://192.168.1.5:8090/');
  assert.equal(browserUrl('fe80::1', 8090), 'http://[fe80::1]:8090/');
});

test('openBrowser: Windows přes rundll32 (žádné uvozovky pro cmd), macOS open, Linux xdg-open; chyba nespadne', () => {
  const calls = [];
  const fake = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { on() {}, unref() {} };
  };
  openBrowser('http://localhost:8090/', { platform: 'win32', spawnFn: fake });
  openBrowser('http://localhost:8090/', { platform: 'darwin', spawnFn: fake });
  openBrowser('http://localhost:8090/', { platform: 'linux', spawnFn: fake });
  assert.deepEqual(
    calls.map((c) => [c.cmd, ...c.args]),
    [
      ['rundll32', 'url.dll,FileProtocolHandler', 'http://localhost:8090/'],
      ['open', 'http://localhost:8090/'],
      ['xdg-open', 'http://localhost:8090/'],
    ]
  );
  assert.equal(calls[0].opts.detached, true);
  const logs = [];
  const keep = console.log;
  console.log = (m) => logs.push(m);
  try {
    openBrowser('http://localhost:8090/', {
      platform: 'linux',
      spawnFn: () => {
        throw new Error('ENOENT');
      },
    });
  } finally {
    console.log = keep;
  }
  assert.match(logs[0], /Otevřete v prohlížeči: http:\/\/localhost:8090\//);
});

test('probe: bez odpovědi (vypršel čas) → „free“ – start nesmí zablokovat, obsazený port ohlásí až server', async () => {
  const silent = await serve(() => {
    /* nikdy neodpoví */
  });
  try {
    assert.equal(await probe(silent.address().port, { timeoutMs: 150 }), 'free');
  } finally {
    silent.closeAllConnections?.();
    await close(silent);
  }
});
