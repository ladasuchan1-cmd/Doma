'use strict';
// Integrační testy API: export (změny, označení, ack, POHODA XML, XLSX, ceník, webhook push, log) a feedy /feed/*.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const H = require('./api-routes-helpers');
const { readZip } = require('../src/formats/zip');
const { readXlsx } = require('../src/formats/xlsx');
const { decodeBuffer } = require('../src/formats/decode');

test('API export a feedy', async (t) => {
  const app = await H.startApp();
  t.after(() => app.stop());
  const seed = H.seedBasic(app.db);
  const P = seed.products;
  const s = app.session();
  const read = app.token(['read']);
  const exp = app.token(['export']);
  await s.post('/api/v1/runs', {});
  const proposals = async () => Object.fromEntries((await s.get('/api/v1/proposals?status=all&limit=500')).json.items.map((x) => [x.product.code, x]));

  await t.test('bez schválených návrhů: prázdný export změn, POHODA 409', async () => {
    let r = await exp.get('/api/v1/export/changes.json');
    assert.equal(r.status, 200);
    assert.equal(r.json.count, 0);
    assert.deepEqual(r.json.items, []);
    assert.equal(r.headers.get('x-export-count'), '0');
    r = await exp.get('/api/v1/export/pohoda.xml');
    assert.equal(r.status, 409);
    assert.match(r.json.error.message, /POHOD/);
    assert.equal(r.json.error.details.code, 'POHODA_EMPTY');
  });

  await t.test('oprávnění exportu', async () => {
    assert.equal((await read.get('/api/v1/export/changes.json')).status, 403);
    assert.equal((await read.get('/api/v1/export/pohoda.xml')).status, 403);
    assert.equal((await read.get('/api/v1/export/pricelist.csv')).status, 403);
    assert.equal((await read.post('/api/v1/export/ack', { codes: ['P1'] })).status, 403);
    assert.equal((await read.post('/api/v1/export/push')).status, 403);
    assert.equal((await app.anon().get('/api/v1/export/changes.json')).status, 401);
    assert.equal((await read.get('/api/v1/export/proposals.xlsx')).status, 200, 'XLSX návrhů stačí read');
    assert.equal((await read.get('/api/v1/exports')).status, 200);
  });

  await t.test('schválení → export změn (JSON/XML/CSV) → mark=1 → cena produktu', async () => {
    const m = await proposals();
    const p1 = m.P1;
    await s.patch(`/api/v1/proposals/${p1.id}`, { manual_price: 77777 });
    let r = await s.post('/api/v1/proposals/approve', { ids: [p1.id] });
    assert.equal(r.json.updated, 1);

    r = await exp.get('/api/v1/export/changes.json');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.equal(r.json.count, 1);
    assert.equal(r.json.items[0].code, 'P1');
    assert.equal(r.json.items[0].price, 77777, 'ruční cena má přednost');
    assert.equal(r.json.items[0].proposal_id, p1.id);
    assert.equal(r.headers.get('x-export-id'), null, 'bez mark se nic neoznačí');
    assert.match(r.headers.get('content-disposition') || '', /attachment/);

    r = await exp.get('/api/v1/export/changes.xml');
    assert.match(r.headers.get('content-type'), /xml/);
    assert.match(r.text, /<prices [^>]*count="1"/);
    assert.match(r.text, /<code>P1<\/code>/);
    r = await exp.get('/api/v1/export/changes.csv');
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.text, /P1/);
    assert.equal((await exp.get('/api/v1/export/changes.txt')).status, 404);

    // produkt zatím nezměněn
    assert.equal((await s.get(`/api/v1/products/${P.P1}`)).json.product.price, 79990);

    // HEAD s mark=1 nic neoznačí (klient tělo nedostane)
    r = await exp.req('HEAD', '/api/v1/export/changes.json?mark=1');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-export-id'), null);
    assert.equal((await proposals()).P1.status, 'approved');

    r = await exp.get('/api/v1/export/changes.json?mark=1');
    assert.equal(r.status, 200);
    const exportId = Number(r.headers.get('x-export-id'));
    assert.ok(exportId > 0);
    assert.equal(r.json.count, 1);
    const after = await proposals();
    assert.equal(after.P1.status, 'exported');
    assert.equal(after.P1.export_id, exportId);
    // cena produktu přepsána + historie 'export' + seznam produktů to vidí (cache zneplatněna)
    const d = await s.get(`/api/v1/products/${P.P1}`);
    assert.equal(d.json.product.price, 77777);
    assert.equal(d.json.history.our.at(-1).source, 'export');
    const list = await s.get('/api/v1/products?q=P1');
    assert.equal(list.json.items[0].price, 77777);
    assert.equal(list.json.items[0].proposal, null);
    // znovu už nic
    r = await exp.get('/api/v1/export/changes.json?mark=1');
    assert.equal(r.json.count, 0);
    assert.equal(r.headers.get('x-export-id'), null);
    const log = await s.get('/api/v1/exports');
    assert.equal(log.json.items[0].id, exportId);
    assert.equal(log.json.items[0].kind, 'json');
    assert.equal(typeof log.json.items[0].detail, 'object');
  });

  await t.test('feed /feed/:name.:ext s ?token=', async () => {
    const m = await proposals();
    await s.post('/api/v1/proposals/approve', { ids: [m.P3.id] });
    const anon = app.anon();
    let r = await anon.get('/feed/changes.xml');
    assert.equal(r.status, 401);
    r = await anon.get('/feed/changes.xml?token=ct_neplatny');
    assert.equal(r.status, 401);
    r = await anon.get(`/feed/changes.xml?token=${read.value}`);
    assert.equal(r.status, 403, 'token bez rozsahu export');
    r = await exp.get('/feed/changes.xml', { tokenInQuery: true });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /xml/);
    assert.match(r.text, /<code>P3<\/code>/);
    assert.equal(r.headers.get('content-disposition'), null, 'feed je inline');
    r = await exp.get('/feed/changes.json', { tokenInQuery: true });
    assert.equal(r.json.count, 1);
    r = await exp.get('/feed/prices.csv', { tokenInQuery: true });
    assert.equal(r.status, 200);
    for (const c of ['P1', 'P2', 'P3', 'P4', 'P6']) assert.match(r.text, new RegExp(`\\b${c}\\b`));
    assert.doesNotMatch(r.text, /\bP5\b/, 'neaktivní produkt není v ceníku');
    r = await exp.get('/feed/prices.json', { tokenInQuery: true });
    assert.equal(r.json.count, 5);
    assert.equal((await exp.get('/feed/prices.json?mark=1', { tokenInQuery: true })).status, 400);
    assert.equal((await exp.get('/feed/ceny.json', { tokenInQuery: true })).status, 404);
    assert.equal((await exp.get('/feed/constructor.json', { tokenInQuery: true })).status, 404);
    r = await exp.get('/feed/changes.json?mark=1', { tokenInQuery: true });
    assert.equal(r.status, 200);
    assert.ok(Number(r.headers.get('x-export-id')) > 0);
    assert.equal((await proposals()).P3.status, 'exported');
    const log = await s.get('/api/v1/exports');
    assert.equal(log.json.items[0].kind, 'feed');
  });

  await t.test('POHODA XML: stažení, kódování, mark', async () => {
    const m = await proposals();
    await s.post('/api/v1/proposals/approve', { ids: [m.P4.id] });
    let r = await exp.get('/api/v1/export/pohoda.xml');
    assert.equal(r.status, 200, r.text);
    assert.match(r.headers.get('content-type'), /xml/);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="pohoda-ceny-\d{8}\.xml"/);
    const head = r.body.subarray(0, 60).toString('latin1');
    assert.match(head, /encoding="Windows-1250"/);
    const xml = decodeBuffer(r.body);
    assert.match(xml, /<dat:dataPack /);
    assert.match(xml, /<ftr:code>P4<\/ftr:code>/);
    assert.equal(r.headers.get('x-export-id'), null);
    assert.equal((await proposals()).P4.status, 'approved');
    r = await exp.get('/api/v1/export/pohoda.xml?encoding=utf-8');
    assert.match(r.body.subarray(0, 60).toString('utf8'), /encoding="UTF-8"/i);
    assert.equal((await exp.get('/api/v1/export/pohoda.xml?encoding=latin2')).status, 400);
    assert.equal((await exp.get('/api/v1/export/pohoda.xml?scope=vse')).status, 400);
    r = await exp.get('/api/v1/export/pohoda.xml?scope=all');
    assert.equal(r.status, 200);
    assert.match(decodeBuffer(r.body), /<ftr:code>P6<\/ftr:code>/);
    r = await exp.get('/api/v1/export/pohoda.xml?mark=1');
    assert.equal(r.status, 200);
    assert.ok(Number(r.headers.get('x-export-id')) > 0);
    assert.equal((await proposals()).P4.status, 'exported');
    assert.equal((await s.get(`/api/v1/products/${P.P4}`)).json.product.price, m.P4.new_price);
  });

  await t.test('XLSX: návrhy a ceník jsou platný zip s listy', async () => {
    let r = await read.get('/api/v1/export/proposals.xlsx?status=all');
    assert.equal(r.status, 200);
    assert.equal(r.body.subarray(0, 2).toString('latin1'), 'PK');
    assert.match(r.headers.get('content-type'), /spreadsheetml/);
    assert.match(r.headers.get('content-disposition'), /navrhy-cen-\d{8}\.xlsx/);
    const zip = readZip(r.body);
    assert.ok(zip.has('xl/workbook.xml'));
    const wb = readXlsx(r.body);
    assert.deepEqual(wb.sheets, ['Návrhy', 'Souhrn']);
    assert.ok(wb.rows.length >= 3);
    assert.ok(wb.rows.some((row) => row['Nejlevnější konkurent'] === 'VeloMarket.cz' || row['Kód'] === 'P1'));
    r = await read.get('/api/v1/export/proposals.xlsx?status=hotovo');
    assert.equal(r.status, 400);
    r = await exp.get('/api/v1/export/pricelist.xlsx');
    assert.equal(r.status, 200);
    assert.equal(r.body.subarray(0, 2).toString('latin1'), 'PK');
    const pl = readXlsx(r.body);
    assert.equal(pl.rows.length, 5);
    for (const f of ['json', 'xml', 'csv']) {
      r = await exp.get(`/api/v1/export/pricelist.${f}`);
      assert.equal(r.status, 200, f);
      assert.match(r.headers.get('content-disposition'), /cenotvorba-cenik-\d{8}\./);
    }
    assert.equal((await exp.get('/api/v1/export/pricelist.json?mark=1')).status, 400);
  });

  await t.test('POST /export/ack podle kódů a id', async () => {
    await s.post('/api/v1/runs', {});
    const m = await proposals();
    const pending = Object.values(m).filter((x) => x.status === 'pending');
    assert.ok(pending.length >= 1);
    await s.post('/api/v1/proposals/approve', { ids: pending.map((x) => x.id) });
    const first = pending[0];
    let r = await exp.post('/api/v1/export/ack', { codes: [first.product.code, 'NEEXISTUJE'] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.count, 1);
    assert.ok(r.json.export_id);
    assert.deepEqual(r.json.unknown_codes, ['NEEXISTUJE']);
    const rest = pending.slice(1).map((x) => x.id);
    if (rest.length) {
      r = await exp.post('/api/v1/export/ack', { proposal_ids: rest });
      assert.equal(r.json.count, rest.length);
    }
    assert.equal((await exp.post('/api/v1/export/ack', {})).status, 400);
    assert.equal((await exp.post('/api/v1/export/ack', { proposal_ids: 'x' })).status, 400);
    const log = await s.get('/api/v1/exports');
    assert.equal(log.json.items[0].kind, 'ack');
  });

  await t.test('POST /export/push na webhook (lokální server)', async () => {
    let r = await exp.post('/api/v1/export/push');
    assert.equal(r.status, 400, 'bez URL webhooku');
    assert.match(r.json.error.message, /URL/);
    const received = [];
    const hook = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise((res) => hook.listen(0, '127.0.0.1', res));
    t.after(() => new Promise((res) => hook.close(res)));
    r = await s.put('/api/v1/settings', { export: { webhook: { url: `http://127.0.0.1:${hook.address().port}/hook`, headers: { 'X-Tajne': 'abc' } } } });
    assert.equal(r.status, 200, r.text);
    // nic ke schválení → ok bez odeslání
    r = await exp.post('/api/v1/export/push');
    assert.equal(r.status, 200);
    assert.equal(r.json.count, 0);
    assert.equal(received.length, 0);
    // konkurence zlevnila → nové návrhy (stejný návrh by běh jen ponechal)
    app.db.prepare('UPDATE offers SET price = price - 500 WHERE product_id IN (?, ?)').run(P.P1, P.P2);
    await s.post('/api/v1/runs', { product_ids: [P.P1, P.P2, P.P3, P.P4] });
    const pend = (await s.get('/api/v1/proposals')).json.items;
    assert.ok(pend.length >= 1);
    await s.post('/api/v1/proposals/approve', { all: true, include_flagged: true });
    r = await exp.post('/api/v1/export/push');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.marked, pend.length);
    assert.ok(r.json.export_id);
    assert.equal(received.length, 1);
    assert.equal(received[0].headers['x-tajne'], 'abc');
    assert.equal(received[0].body.count, pend.length);
    const log = await s.get('/api/v1/exports');
    assert.equal(log.json.items[0].kind, 'webhook');
    assert.equal(log.json.items[0].status, 'ok');
    assert.equal((await s.get('/api/v1/proposals?status=approved')).json.total, 0);
  });
});
