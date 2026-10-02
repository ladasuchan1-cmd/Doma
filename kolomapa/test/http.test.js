'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHttp, HttpError } = require('../src/util/http');

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers || {} });
  };
  fn.calls = calls;
  return fn;
}

test('opakuje 429/5xx a síťové chyby, pak vrátí tělo', async () => {
  const f = fakeFetch([{ status: 503 }, new TypeError('fetch failed'), { status: 200, body: '{"a":1}' }]);
  const pauses = [];
  const http = createHttp({ delayMs: 0, fetchImpl: f, sleepImpl: async (ms) => pauses.push(ms) });
  assert.deepEqual(await http.json('https://example.cz/x'), { a: 1 });
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls[0].init.headers['User-Agent'].includes('Mozilla'));
  assert.equal(http.requests, 3);
});

test('404 → HttpError se stavem, bez opakování', async () => {
  const f = fakeFetch([{ status: 404, body: 'nic' }]);
  const http = createHttp({ delayMs: 0, fetchImpl: f, sleepImpl: async () => {} });
  await assert.rejects(http.text('https://example.cz/y'), (e) => e instanceof HttpError && e.status === 404);
  assert.equal(f.calls.length, 1);
});

test('okStatuses: 410 vrátí odpověď', async () => {
  const f = fakeFetch([{ status: 410, body: '{"status":"deleted"}' }]);
  const http = createHttp({ delayMs: 0, fetchImpl: f, sleepImpl: async () => {} });
  const r = await http.request('https://example.cz/z', { okStatuses: [410] });
  assert.equal(r.status, 410);
  assert.equal(r.json().status, 'deleted');
});

test('pauza mezi požadavky na stejný web', async () => {
  const f = fakeFetch([{ body: 'a' }, { body: 'b' }]);
  const waits = [];
  const http = createHttp({ delayMs: 1000, fetchImpl: f, sleepImpl: async (ms) => waits.push(ms) });
  await http.text('https://example.cz/1');
  await http.text('https://example.cz/2');
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 900 && waits[0] <= 1250);
});

test('siteOf: pauza se počítá pro celý web (sport.bazos.cz = www.bazos.cz)', () => {
  const { siteOf } = require('../src/util/http');
  assert.equal(siteOf('https://sport.bazos.cz/horska/'), 'bazos.cz');
  assert.equal(siteOf('https://www.bazos.cz/api/v1/ads.php'), 'bazos.cz');
  assert.equal(siteOf('http://127.0.0.1:8090/x'), '127.0.0.1');
});
