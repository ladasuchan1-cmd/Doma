'use strict';
// Integrační testy API (C8): znovustažení exportu GET /api/v1/exports/:id/changes.(json|xml|csv) a příznak
// redownload v logu exportů.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./api-routes-helpers');
const { parseCsv } = require('../src/formats/csv');
const { parseXml } = require('../src/formats/xml');
const { logExport } = require('../src/export/apply');

test('API C8: znovustažení exportu', async (t) => {
  const app = await H.startApp();
  t.after(() => app.stop());
  H.seedBasic(app.db);
  const s = app.session();
  const read = app.token(['read']);
  const exp = app.token(['export']);
  await s.post('/api/v1/runs', {});
  const byCode = async () => Object.fromEntries((await s.get('/api/v1/proposals?status=all&limit=500')).json.items.map((x) => [x.product.code, x]));
  const S = {};

  await t.test('feed s mark=1 → export → stejné řádky znovu (JSON), doručená cena', async () => {
    const m = await byCode();
    await s.patch(`/api/v1/proposals/${m.P1.id}`, { manual_price: 77777 });
    await s.post('/api/v1/proposals/approve', { ids: [m.P1.id, m.P3.id] });
    const feed = await exp.get('/api/v1/export/changes.json?mark=1');
    assert.equal(feed.status, 200);
    assert.equal(feed.json.count, 2);
    S.exportId = Number(feed.headers.get('x-export-id'));
    assert.ok(S.exportId > 0);
    S.feed = feed.json;

    const r = await exp.get(`/api/v1/exports/${S.exportId}/changes.json`);
    assert.equal(r.status, 200, r.text);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.equal(r.headers.get('x-export-id'), String(S.exportId));
    assert.equal(r.headers.get('x-export-count'), '2');
    assert.match(r.headers.get('content-disposition') || '', new RegExp(`cenotvorba-export-${S.exportId}\\.json`));
    assert.deepEqual(Object.keys(r.json).sort(), Object.keys(S.feed).sort(), 'stejný tvar jako feed změn');
    assert.equal(r.json.count, 2);
    const items = Object.fromEntries(r.json.items.map((x) => [x.code, x]));
    assert.deepEqual(Object.keys(items).sort(), ['P1', 'P3']);
    assert.equal(items.P1.price, 77777, 'doručená (ruční) cena');
    assert.equal(items.P1.proposal_id, m.P1.id);
    assert.equal(items.P1.old_price, 79990);
    const feedP1 = S.feed.items.find((x) => x.code === 'P1');
    for (const k of ['proposal_id', 'product_id', 'code', 'ean', 'name', 'manufacturer', 'price', 'old_price', 'change_pct', 'vat_rate', 'currency', 'strategy', 'segment']) {
      assert.deepEqual(items.P1[k], feedP1[k], k);
    }
    // znovustažení nic neoznačuje ani nemění
    assert.equal((await byCode()).P1.status, 'exported');
    const again = await exp.get(`/api/v1/exports/${S.exportId}/changes.json`);
    assert.deepEqual(again.json.items, r.json.items);
  });

  await t.test('XML a CSV ve formátu feedu změn', async () => {
    let r = await exp.get(`/api/v1/exports/${S.exportId}/changes.xml`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /xml/);
    const root = parseXml(r.text);
    assert.equal(root.name, 'prices');
    assert.equal(root.attrs.count, '2');
    const prices = root.children.filter((c) => c.name === 'item').map((it) => it.children.find((c) => c.name === 'price').text);
    assert.ok(prices.includes('77777'));
    r = await exp.get(`/api/v1/exports/${S.exportId}/changes.csv`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    const csv = parseCsv(r.text.replace(/^﻿/, ''));
    assert.equal(csv.rows.length, 2);
  });

  await t.test('pozdější změny (nové přecenění, ruční cena produktu) řádky exportu nemění; ack vytvoří vlastní export', async () => {
    await s.patch(`/api/v1/products/${(await byCode()).P1.product_id}`, { price: 70000 });
    await s.post('/api/v1/runs', {});
    const r = await exp.get(`/api/v1/exports/${S.exportId}/changes.json`);
    assert.equal(r.json.items.find((x) => x.code === 'P1').price, 77777);
    // ack s cenami → nový export s vlastními řádky
    const m = await byCode();
    await s.post('/api/v1/proposals/approve', { ids: [m.P2.id] });
    const ack = await exp.post('/api/v1/export/ack', { items: [{ proposal_id: m.P2.id, price: m.P2.final_price }] });
    assert.equal(ack.status, 200, ack.text);
    assert.equal(ack.json.count, 1);
    const r2 = await exp.get(`/api/v1/exports/${ack.json.export_id}/changes.json`);
    assert.equal(r2.status, 200);
    assert.deepEqual(r2.json.items.map((x) => [x.code, x.price]), [['P2', m.P2.final_price]]);
  });

  await t.test('GET /exports: redownload true jen u exportu s návrhy; 404 pro neznámý / prázdný export', async () => {
    const empty = logExport(app.db, { kind: 'xlsx', target: 'download', count: 0 });
    const list = await read.get('/api/v1/exports');
    assert.equal(list.status, 200);
    const items = Object.fromEntries(list.json.items.map((x) => [x.id, x]));
    assert.equal(items[S.exportId].redownload, true);
    assert.equal(items[empty].redownload, false);
    assert.ok(list.json.items.every((x) => typeof x.redownload === 'boolean'));

    let r = await exp.get(`/api/v1/exports/${empty}/changes.json`);
    assert.equal(r.status, 404);
    assert.match(r.json.error.message, /nelze ho stáhnout znovu/);
    r = await exp.get('/api/v1/exports/999999/changes.json');
    assert.equal(r.status, 404);
    r = await exp.get(`/api/v1/exports/${S.exportId}/changes.pdf`);
    assert.equal(r.status, 404);
    r = await exp.get('/api/v1/exports/abc/changes.json');
    assert.ok(r.status === 400 || r.status === 404);
    // oprávnění: scope export (read nestačí)
    assert.equal((await read.get(`/api/v1/exports/${S.exportId}/changes.json`)).status, 403);
    assert.equal((await app.anon().get(`/api/v1/exports/${S.exportId}/changes.json`)).status, 401);
    assert.equal((await s.get(`/api/v1/exports/${S.exportId}/changes.json`)).status, 200, 'session má všechny rozsahy');
  });
});
