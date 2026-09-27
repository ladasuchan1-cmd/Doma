'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { pushWebhook, parseWebhookHeaders } = require('../src/export/webhook');
const { parseXml } = require('../src/formats');

const ROWS = [
  { proposal_id: 1, product_id: 1, code: 'A', ean: null, name: 'Kolo Ž', manufacturer: 'Trek', price: 18990, old_price: 19990, change_pct: -5, vat_rate: 21, currency: 'CZK', changed_at: null, strategy: null, segment: null, lowest_30d: 18990 },
];
const FAST = { retry_delays_ms: [20, 40] };

/** Lokální server; handler(req, body, res, n) kde n = pořadí požadavku od 1. */
async function server(handler) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, body, res, requests.length);
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  return {
    url: `http://127.0.0.1:${port}/hook`,
    port,
    requests,
    close: () =>
      new Promise((resolve) => {
        srv.closeAllConnections?.();
        srv.close(() => resolve());
      }),
  };
}

test('úspěch: POST s JSON tělem, vlastní hlavičky, prvních 2 KB odpovědi', async () => {
  const s = await server((req, body, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('OK ' + 'x'.repeat(5000));
  });
  try {
    const r = await pushWebhook(ROWS, { url: s.url, headers: { Authorization: 'Bearer abc', 'X-Shop': 'kola' }, now: '2026-09-25T10:00:00Z', ...FAST });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.attempts, 1);
    assert.equal(r.body.length, 2048);
    assert.ok(r.body.startsWith('OK xxx'));
    assert.equal(typeof r.duration_ms, 'number');
    assert.equal(r.error, undefined);
    const req = s.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/hook');
    assert.equal(req.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(req.headers.authorization, 'Bearer abc');
    assert.equal(req.headers['x-shop'], 'kola');
    const json = JSON.parse(req.body);
    assert.deepEqual(json, { generated: '2026-09-25T10:00:00.000Z', count: 1, currency: 'CZK', items: ROWS });
  } finally {
    await s.close();
  }
});

test('formát XML podle šablony', async () => {
  const s = await server((req, body, res) => {
    res.writeHead(204);
    res.end();
  });
  try {
    const r = await pushWebhook(ROWS, { url: s.url, format: 'xml', template: { root: 'CENY', item: 'P', fields: { code: 'KOD', price: 'CENA' } }, ...FAST });
    assert.equal(r.ok, true);
    assert.equal(r.status, 204);
    assert.equal(r.body, '');
    assert.equal(s.requests[0].headers['content-type'], 'application/xml; charset=utf-8');
    const root = parseXml(s.requests[0].body);
    assert.equal(root.name, 'CENY');
    assert.deepEqual(root.children[0].children.map((c) => [c.name, c.text]), [
      ['KOD', 'A'],
      ['CENA', '18990'],
    ]);
  } finally {
    await s.close();
  }
});

test('500 a pak úspěch → opakování, 2 pokusy', async () => {
  const s = await server((req, body, res, n) => {
    if (n === 1) {
      res.writeHead(500);
      res.end('chyba');
    } else {
      res.writeHead(200);
      res.end('{"ok":true}');
    }
  });
  try {
    const r = await pushWebhook(ROWS, { url: s.url, ...FAST });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.attempts, 2);
    assert.equal(r.body, '{"ok":true}');
    assert.equal(s.requests.length, 2);
    assert.equal(s.requests[0].body, s.requests[1].body, 'opakuje se stejné tělo');
  } finally {
    await s.close();
  }
});

test('trvalá 503 → 3 pokusy (2 opakování), výsledek s chybou; 400 se neopakuje', async () => {
  let code = 503;
  const s = await server((req, body, res) => {
    res.writeHead(code);
    res.end('nedostupné');
  });
  try {
    const t0 = Date.now();
    const r = await pushWebhook(ROWS, { url: s.url, ...FAST });
    assert.equal(r.ok, false);
    assert.equal(r.status, 503);
    assert.equal(r.attempts, 3);
    assert.equal(r.body, 'nedostupné');
    assert.match(r.error, /HTTP 503/);
    assert.ok(Date.now() - t0 >= 55, 'prodlevy mezi pokusy');
    code = 400;
    const r2 = await pushWebhook(ROWS, { url: s.url, ...FAST });
    assert.equal(r2.ok, false);
    assert.equal(r2.status, 400);
    assert.equal(r2.attempts, 1);
    assert.equal(s.requests.length, 4);
  } finally {
    await s.close();
  }
});

test('vypršení časového limitu → ok false, status null, opakuje se', async () => {
  const s = await server(() => {
    /* nikdy neodpoví */
  });
  try {
    const t0 = Date.now();
    const r = await pushWebhook(ROWS, { url: s.url, timeout_ms: 150, retries: 1, ...FAST });
    const took = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(r.status, null);
    assert.equal(r.attempts, 2);
    assert.match(r.error, /časový limit 150 ms/);
    assert.ok(took >= 300 && took < 3000, `trvalo ${took} ms`);
    assert.equal(s.requests.length, 2);
  } finally {
    await s.close();
  }
});

test('odmítnuté spojení → ok false, nikdy nevyhodí výjimku', async () => {
  const s = await server(() => {});
  const url = s.url;
  await s.close();
  const r = await pushWebhook(ROWS, { url, ...FAST });
  assert.equal(r.ok, false);
  assert.equal(r.status, null);
  assert.equal(r.attempts, 3);
  assert.match(r.error, /Spojení odmítnuto/);
});

test('přesměrování: 307 se následuje, 302 je chyba', async () => {
  const s = await server((req, body, res) => {
    if (req.url === '/hook') {
      res.writeHead(307, { location: '/novy' });
      res.end();
    } else if (req.url === '/novy') {
      res.writeHead(200);
      res.end('prijato ' + body.length);
    } else {
      res.writeHead(302, { location: '/jinam' });
      res.end();
    }
  });
  try {
    const r = await pushWebhook(ROWS, { url: s.url, ...FAST });
    assert.equal(r.ok, true);
    assert.equal(s.requests[1].method, 'POST');
    assert.equal(r.body, 'prijato ' + s.requests[0].body.length);
    const r2 = await pushWebhook(ROWS, { url: s.url.replace('/hook', '/stary'), ...FAST });
    assert.equal(r2.ok, false);
    assert.equal(r2.status, 302);
    assert.equal(r2.attempts, 1);
    assert.match(r2.error, /přesměrování 302/);
  } finally {
    await s.close();
  }
});

test('neplatná konfigurace → chyba bez výjimky a bez pokusu', async () => {
  for (const opts of [{}, { url: '' }, { url: 'ftp://x/y' }, { url: 'nesmysl' }, null]) {
    const r = await pushWebhook(ROWS, opts);
    assert.equal(r.ok, false);
    assert.equal(r.attempts, 0);
    assert.match(r.error, /URL/);
  }
  const r = await pushWebhook(ROWS, { url: 'http://127.0.0.1:9/x', format: 'yaml' });
  assert.match(r.error, /Nepodporovaný formát/);
  const r2 = await pushWebhook(ROWS, { url: 'http://127.0.0.1:9/x', headers: '{nejson' });
  assert.match(r2.error, /JSON/);
  const r3 = await pushWebhook(ROWS, { url: 'http://127.0.0.1:9/x', headers: { 'X-Bad': 'a\nb' }, ...FAST });
  assert.equal(r3.ok, false);
  assert.equal(r3.attempts, 1);
  // řádky nejsou pole → nevyhodí
  const r4 = await pushWebhook({ nic: 1 }, { url: 'http://127.0.0.1:9/x', retries: 0 });
  assert.equal(r4.ok, false);
});

test('parseWebhookHeaders: objekt, JSON, řádky „Název: hodnota“', () => {
  assert.deepEqual(parseWebhookHeaders({ A: 1, B: null }), { A: '1' });
  assert.deepEqual(parseWebhookHeaders('{"X-Key":"k"}'), { 'X-Key': 'k' });
  assert.deepEqual(parseWebhookHeaders('X-Key: k:1\nAuthorization: Bearer t\n'), { 'X-Key': 'k:1', Authorization: 'Bearer t' });
  assert.deepEqual(parseWebhookHeaders(''), {});
  assert.throws(() => parseWebhookHeaders([1]), /objekt/);
});

test('přesměrování 307 na jiný server se nenásleduje (hlavičky s tajemstvím by odešly jinam)', async () => {
  const other = await server((req, body, res) => {
    res.writeHead(200);
    res.end('cizí');
  });
  const s = await server((req, body, res) => {
    res.writeHead(307, { location: other.url });
    res.end();
  });
  try {
    const r = await pushWebhook(ROWS, { url: s.url, headers: { Authorization: 'Bearer tajne' }, ...FAST });
    assert.equal(r.ok, false);
    assert.equal(r.status, 307);
    assert.match(r.error, /přesměrování 307/);
    assert.equal(other.requests.length, 0);
  } finally {
    await s.close();
    await other.close();
  }
});
