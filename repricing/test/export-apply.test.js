'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { markExported, logExport, exportChanges, exportPohoda, ackExport, pushChanges } = require('../src/export/apply');
const { exportRows } = require('../src/export/rows');
const { setSetting } = require('../src/db');
const { parseXml, parseCsv, readXlsx, decodeBuffer } = require('../src/formats');
const h = require('./export-helpers');

const status = (db, id) => db.prepare('SELECT status, exported_at, export_id FROM proposals WHERE id = ?').get(id);
const product = (db, id) => db.prepare('SELECT price, price_changed_at, updated_at FROM products WHERE id = ?').get(id);
const history = (db, id) => db.prepare('SELECT price, source, ref_id, at FROM price_history WHERE product_id = ? ORDER BY id').all(id).map((r) => ({ ...r }));
const exportsLog = (db) => db.prepare('SELECT * FROM exports ORDER BY id').all().map((r) => ({ ...r }));

test('markExported: jen schválené návrhy → exported, cena produktu, historie, log exportu, audit', () => {
  const db = h.freshDb();
  const s = h.seedBasic(db);
  const res = markExported(db, [s.pA, s.pB, s.pC, s.pA, 'x', 99999], { kind: 'feed', target: 'admin', actor: 'tester', now: h.NOW });
  assert.equal(res.count, 2);
  assert.deepEqual(res.proposal_ids, [s.pA, s.pB]);
  assert.equal(res.price_updates, 2);
  assert.ok(res.export_id > 0);

  assert.deepEqual({ ...status(db, s.pA) }, { status: 'exported', exported_at: h.NOW, export_id: res.export_id });
  assert.deepEqual({ ...status(db, s.pB) }, { status: 'exported', exported_at: h.NOW, export_id: res.export_id });
  assert.equal(status(db, s.pC).status, 'pending', 'čekající se nemění');
  assert.equal(status(db, s.pOldA).status, 'approved', 'neuvedené se nemění');

  assert.deepEqual({ ...product(db, s.a) }, { price: 18990, price_changed_at: h.NOW, updated_at: h.NOW });
  assert.equal(product(db, s.b).price, 899, 'ruční cena má přednost');
  assert.deepEqual(history(db, s.a), [{ price: 18990, source: 'export', ref_id: res.export_id, at: h.NOW }]);
  assert.deepEqual(history(db, s.b), [{ price: 899, source: 'export', ref_id: res.export_id, at: h.NOW }]);

  const log = exportsLog(db);
  assert.equal(log.length, 1);
  assert.equal(log[0].id, res.export_id);
  assert.equal(log[0].kind, 'feed');
  assert.equal(log[0].target, 'admin');
  assert.equal(log[0].count, 2);
  assert.equal(log[0].status, 'ok');
  assert.equal(log[0].created_at, h.NOW);
  assert.deepEqual(JSON.parse(log[0].detail).proposal_ids, [s.pA, s.pB]);

  const au = db.prepare("SELECT * FROM audit WHERE action = 'export'").all();
  assert.equal(au.length, 1);
  assert.equal(au[0].actor, 'tester');
  assert.equal(au[0].entity, 'export');
  assert.equal(au[0].entity_id, res.export_id);
  assert.equal(JSON.parse(au[0].detail).count, 2);

  // opakované označení: nic dalšího, žádný nový řádek logu
  const again = markExported(db, [s.pA, s.pB], { kind: 'feed', now: h.NOW });
  assert.deepEqual(again, { export_id: null, count: 0, proposal_ids: [], price_updates: 0 });
  assert.deepEqual(markExported(db, [], {}), { export_id: null, count: 0, proposal_ids: [], price_updates: 0 });
  assert.equal(exportsLog(db).length, 1);
  // po exportu už návrh v exportRows není; nová cena se promítne do nejnižší ceny za 30 dní
  assert.deepEqual(exportRows(db, { now: h.NOW }).map((r) => r.proposal_id), []);
  const later = exportRows(db, { scope: 'all', now: h.daysAgo(-1) }).find((r) => r.code === 'KOLO-TREK-FX2-M');
  assert.equal(later.price, 18990);
  assert.equal(later.proposal_id, null);
});

test('markExported: update_current_price vypnuto / cena beze změny → produkt a historie se nemění', () => {
  const db = h.freshDb();
  const s = h.seedBasic(db);
  setSetting(db, 'export', { update_current_price: false });
  const r = markExported(db, [s.pA], { kind: 'ack', now: h.NOW });
  assert.equal(r.count, 1);
  assert.equal(r.price_updates, 0);
  assert.equal(status(db, s.pA).status, 'exported');
  assert.equal(product(db, s.a).price, 19990);
  assert.deepEqual(history(db, s.a), []);

  // přebití volbou + cena už je stejná (admin ji mezitím naimportoval) → bez historie
  db.prepare('UPDATE products SET price = 899 WHERE id = ?').run(s.b);
  const r2 = markExported(db, [s.pB], { kind: 'ack', now: h.NOW, update_current_price: true });
  assert.equal(r2.count, 1);
  assert.equal(r2.price_updates, 0);
  assert.deepEqual(history(db, s.b), []);
});

test('logExport: zápis do logu exportů', () => {
  const db = h.freshDb();
  const id = logExport(db, { kind: 'webhook', target: 'https://admin/hook', count: 3, status: 'error', detail: { status: 500 }, now: h.NOW });
  const [row] = exportsLog(db);
  assert.equal(row.id, id);
  assert.deepEqual({ ...row, detail: JSON.parse(row.detail) }, { id, created_at: h.NOW, kind: 'webhook', target: 'https://admin/hook', count: 3, status: 'error', detail: { status: 500 } });
  const id2 = logExport(db, { kind: 'pohoda' });
  const row2 = exportsLog(db).find((r) => r.id === id2);
  assert.equal(row2.status, 'ok');
  assert.equal(row2.count, 0);
  assert.equal(row2.detail, null);
  assert.throws(() => logExport(db, {}), /kind/);
});

test('exportChanges: JSON bez označení, XML podle šablony s označením', () => {
  const db = h.freshDb();
  const s = h.seedBasic(db);
  const j = exportChanges(db, { format: 'json', now: h.NOW });
  assert.equal(j.contentType, 'application/json; charset=utf-8');
  assert.equal(j.count, 2);
  assert.ok(!('export_id' in j));
  assert.equal(j.filename, 'cenotvorba-zmeny-20260925.json');
  const body = JSON.parse(j.body);
  assert.equal(body.count, 2);
  assert.equal(body.currency, 'CZK');
  assert.equal(body.generated, h.NOW);
  assert.deepEqual(body.items.map((i) => i.proposal_id), [s.pA, s.pB]);
  assert.equal(status(db, s.pA).status, 'approved', 'bez mark se nic nemění');

  setSetting(db, 'export', { xml: { root: 'CENIK', item: 'ZBOZI', fields: { code: 'KOD', price: 'CENA' } } });
  const x = exportChanges(db, { format: 'xml', mark: '1', actor: 'admin-api', target: 'feed', now: h.NOW });
  assert.equal(x.contentType, 'application/xml; charset=utf-8');
  assert.equal(x.count, 2);
  assert.equal(x.marked, 2);
  assert.ok(x.export_id > 0);
  const root = parseXml(x.body);
  assert.equal(root.name, 'CENIK');
  assert.equal(root.attrs.count, '2');
  assert.deepEqual(root.children.map((c) => c.children.map((e) => [e.name, e.text])), [
    [['KOD', 'KOLO-TREK-FX2-M'], ['CENA', '18990']],
    [['KOD', 'PLAST-SCHW-29-2.35'], ['CENA', '899']],
  ]);
  assert.equal(status(db, s.pA).export_id, x.export_id);
  assert.equal(exportsLog(db)[0].kind, 'xml');
  assert.equal(exportsLog(db)[0].target, 'feed');
  // podruhé už nic
  const x2 = exportChanges(db, { format: 'xml', mark: true, now: h.NOW });
  assert.equal(x2.count, 0);
  assert.equal(x2.export_id, null);
  assert.equal(parseXml(x2.body).attrs.count, '0');
});

test('exportChanges: CSV, XLSX, ceník (scope all) a neplatný formát', () => {
  const db = h.freshDb();
  const s = h.seedBasic(db);
  const c = exportChanges(db, { format: 'csv', now: h.NOW });
  assert.equal(c.contentType, 'text/csv; charset=utf-8');
  assert.ok(c.body.startsWith('﻿'));
  const parsed = parseCsv(c.body);
  assert.deepEqual(parsed.rows.map((r) => r.price), ['18990', '899']);
  assert.equal(parsed.delimiter, ';');

  const x = exportChanges(db, { format: 'xlsx', scope: 'all', now: h.NOW });
  assert.ok(Buffer.isBuffer(x.body));
  assert.equal(x.filename, 'cenotvorba-cenik-20260925.xlsx');
  const wb = readXlsx(x.body);
  assert.deepEqual(wb.sheets, ['Ceník']);
  assert.equal(wb.rows.length, 3);
  assert.equal(wb.rows[0]['Kód'], 'HELMA-ABUS');
  assert.equal(wb.rows[0]['Cena s DPH'], 2490);

  // ceník s označením: označí se jen řádky z návrhů
  const all = exportChanges(db, { format: 'json', scope: 'all', mark: true, now: h.NOW });
  assert.equal(all.count, 3);
  assert.equal(all.marked, 2);
  assert.equal(status(db, s.pA).status, 'exported');
  assert.equal(status(db, s.pC).status, 'pending');

  assert.throws(() => exportChanges(db, { format: 'yaml' }), (e) => e.status === 400 && /Nepodporovaný formát/.test(e.message));
  assert.throws(() => exportChanges(db, { format: 'json', scope: 'x' }), (e) => e.status === 400);
});

test('exportPohoda: nastavení z settings, označení jen zapsaných řádků, id balíku z id exportu', () => {
  const db = h.freshDb();
  const s = h.seedBasic(db);
  const run = h.addRun(db);
  const f = h.addProduct(db, { code: 'BEZ-EAN', price: 500 });
  const pF = h.addProposal(db, { run_id: run, product_id: f, old_price: 500, new_price: 490 });
  setSetting(db, 'export', { pohoda: { ico: '12345678', filter_by: 'ean' } });

  const preview = exportPohoda(db, { now: h.NOW });
  assert.equal(preview.count, 2);
  assert.deepEqual(preview.skipped.map((x) => [x.proposal_id, x.reason]), [[pF, 'no_ean']]);
  assert.equal(preview.contentType, 'application/xml; charset=windows-1250');
  assert.ok(!('export_id' in preview));
  assert.equal(status(db, s.pA).status, 'approved');

  const r = exportPohoda(db, { mark: 1, actor: 'ucetni', now: h.NOW });
  assert.equal(r.count, 2);
  assert.ok(r.export_id > 0);
  assert.equal(r.id, `cenotvorba-20260925-${String(r.export_id).padStart(4, '0')}`);
  assert.equal(r.filename, 'pohoda-ceny-20260925.xml');
  const text = decodeBuffer(r.body);
  const root = parseXml(text, { keepNs: true });
  assert.equal(root.attrs.id, r.id);
  assert.equal(root.attrs.ico, '12345678');
  assert.ok(text.includes('<ftr:EAN>8591234567890</ftr:EAN>'));
  assert.equal(status(db, s.pA).status, 'exported');
  assert.equal(status(db, s.pB).status, 'exported');
  assert.equal(status(db, pF).status, 'approved', 'vynechaný řádek zůstává schválený');
  const log = exportsLog(db)[0];
  assert.equal(log.kind, 'pohoda');
  assert.equal(JSON.parse(log.detail).pack_id, r.id);
  assert.equal(JSON.parse(log.detail).skipped, 1);

  // volby v požadavku přebijí nastavení (kód místo EAN, UTF-8)
  const u = exportPohoda(db, { filter_by: 'code', encoding: 'utf-8', now: h.NOW });
  assert.equal(u.count, 1);
  assert.ok(u.body.toString('utf8').includes('<ftr:code>BEZ-EAN</ftr:code>'));

  // nic k exportu → 409, nic se neoznačí
  setSetting(db, 'export', { pohoda: { filter_by: 'ean' } });
  assert.throws(() => exportPohoda(db, { mark: true, now: h.NOW }), (e) => e.status === 409 && e.code === 'POHODA_EMPTY');
  assert.equal(status(db, pF).status, 'approved');
  assert.equal(exportsLog(db).length, 1);
  assert.throws(() => exportPohoda(db, { encoding: 'ebcdic' }), (e) => e.status === 400);
});

test('ackExport: potvrzení podle kódů i id návrhů', () => {
  const db = h.freshDb();
  const s = h.seedBasic(db);
  const r = ackExport(db, { codes: [' kolo-trek-fx2-m ', 'NEZNAMY', 'HELMA-ABUS'], actor: 'admin', now: h.NOW });
  assert.equal(r.count, 1);
  assert.deepEqual(r.proposal_ids, [s.pA], 'nejnovější schválený návrh produktu');
  assert.deepEqual(r.unknown_codes, ['NEZNAMY', 'HELMA-ABUS']);
  assert.equal(exportsLog(db)[0].kind, 'ack');
  const r2 = ackExport(db, { proposal_ids: [s.pB], now: h.NOW });
  assert.equal(r2.count, 1);
  assert.equal(status(db, s.pB).status, 'exported');
  assert.deepEqual(ackExport(db, {}), { export_id: null, count: 0, proposal_ids: [], price_updates: 0, unknown_codes: [] });
});

test('pushChanges: úspěch označí export, chyba se zapíše do logu a nic neoznačí', async () => {
  const db = h.freshDb();
  const s = h.seedBasic(db);
  const none = await pushChanges(db, { now: h.NOW });
  assert.equal(none.ok, false);
  assert.match(none.error, /URL webhooku/);

  setSetting(db, 'export', { webhook: { url: 'https://admin.example/hook', format: 'json', headers: { 'X-Key': 'k' } } });
  let seen = null;
  const fail = await pushChanges(db, { now: h.NOW, push: async (rows, o) => ((seen = { rows, o }), { ok: false, status: 500, body: 'err', attempts: 3, error: 'Webhook vrátil HTTP 500' }) });
  assert.equal(fail.ok, false);
  assert.equal(fail.status, 500);
  assert.equal(fail.count, 2);
  assert.equal(fail.marked, 0);
  assert.equal(seen.o.url, 'https://admin.example/hook');
  assert.deepEqual(seen.o.headers, { 'X-Key': 'k' });
  assert.deepEqual(seen.o.template, require('../src/db').DEFAULT_SETTINGS.export.xml);
  assert.equal(status(db, s.pA).status, 'approved');
  const log = exportsLog(db);
  assert.equal(log.length, 1);
  assert.equal(log[0].status, 'error');
  assert.equal(log[0].kind, 'webhook');
  assert.equal(JSON.parse(log[0].detail).status, 500);

  const ok = await pushChanges(db, { actor: 'admin', now: h.NOW, push: async () => ({ ok: true, status: 200, body: 'ok', attempts: 1, duration_ms: 5 }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.count, 2);
  assert.equal(ok.marked, 2);
  assert.ok(ok.export_id > log[0].id);
  assert.equal(status(db, s.pA).status, 'exported');
  assert.equal(exportsLog(db)[1].target, 'https://admin.example/hook');
  const empty = await pushChanges(db, { now: h.NOW, push: async () => assert.fail('nemá se volat') });
  assert.deepEqual([empty.ok, empty.count, empty.skipped], [true, 0, 'no_changes']);
});
