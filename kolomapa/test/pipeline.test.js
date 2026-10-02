'use strict';
// Pipeline: ukládání položek, změny cen, detaily, označení zmizelých. Klasifikace a nacenění jsou zde nahrazené
// jednoduchými náhradami (testují se zvlášť), aby test hlídal jen logiku pipeline.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const stubs = {
  [path.join(__dirname, '..', 'src', 'classify')]: {
    CLASSIFIER_VERSION: 'test-1',
    classifyListing: (l) => ({ isBike: !/helma/i.test(l.title), bikeType: 'mtb_hardtail', reason: 'test', features: { brand: 'Test' } }),
  },
  [path.join(__dirname, '..', 'src', 'pricing')]: {
    trainModel: () => ({ summary: { stub: true } }),
    priceAll: (db) => Number(db.prepare("UPDATE listings SET est_czk = 10000, deal_ratio = price_czk / 10000.0 WHERE is_bike = 1 AND gone_at IS NULL AND price_czk IS NOT NULL").run().changes),
  },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename && parent.filename.includes(`${path.sep}src${path.sep}pipeline.js`)) {
    const resolved = path.resolve(path.dirname(parent.filename), request);
    if (stubs[resolved]) return stubs[resolved];
  }
  return origLoad.apply(this, arguments);
};
const { runPipeline, upsertItem } = require('../src/pipeline');
Module._load = origLoad;
const { openDb } = require('../src/db');
const { loadConfig } = require('../src/config');

const config = { ...loadConfig({}), maxDetails: 100, ai: { enabled: false } };

function makeSource(pages, { details = {}, gone = {}, complete = true } = {}) {
  let run = 0;
  return {
    key: 'fake',
    label: 'Fake',
    calls: { detail: [], confirm: [] },
    async scan(ctx) {
      const items = pages[Math.min(run++, pages.length - 1)];
      for (const it of items) await ctx.emit(it);
      return { complete };
    },
    async detail(ctx, l) {
      this.calls.detail.push(l.source_id);
      return details[l.source_id] === undefined ? { description: `Plný popis ${l.source_id}` } : details[l.source_id];
    },
    async confirmGone(ctx, l) {
      this.calls.confirm.push(l.source_id);
      return gone[l.source_id] ?? null;
    },
  };
}

const item = (id, o = {}) => ({ sourceId: id, url: `https://x.cz/${id}`, title: `Kolo ${id}`, priceCzk: 8000, locationText: 'Brno', ...o });

test('upsertItem: nový, beze změny, změna ceny → historie cen', () => {
  const db = openDb(':memory:');
  const a = upsertItem(db, 'fake', item('1'), '2026-10-01T00:00:00Z');
  assert.deepEqual([a.isNew, a.changed], [true, true]);
  const b = upsertItem(db, 'fake', item('1'), '2026-10-02T00:00:00Z');
  assert.deepEqual([b.isNew, b.changed], [false, false]);
  const c = upsertItem(db, 'fake', item('1', { priceCzk: 7000 }), '2026-10-03T00:00:00Z');
  assert.equal(c.changed, true);
  const hist = db.prepare('SELECT price_czk FROM price_history ORDER BY at').all().map((r) => r.price_czk);
  assert.deepEqual(hist, [8000, 7000]);
});

test('upsertItem: zkrácený popis z výpisu nepřepíše plný popis z detailu', () => {
  const db = openDb(':memory:');
  upsertItem(db, 'fake', item('1', { description: 'Krátký …' }), '2026-10-01T00:00:00Z');
  upsertItem(db, 'fake', { ...item('1'), description: 'Krátký popis a ještě mnohem delší text z detailu' }, '2026-10-01T01:00:00Z', { fromDetail: true });
  upsertItem(db, 'fake', item('1', { description: 'Krátký …' }), '2026-10-02T00:00:00Z');
  const row = db.prepare('SELECT description, detail_at FROM listings').get();
  assert.equal(row.description, 'Krátký popis a ještě mnohem delší text z detailu');
  assert.ok(row.detail_at);
});

test('runPipeline: detaily, klasifikace, geolokace, nacenění', async () => {
  const db = openDb(':memory:');
  const src = makeSource([[item('1'), item('2', { title: 'Helma Giro' }), item('3', { locationText: 'Pelhřimov', psc: '39301' })]]);
  const r = await runPipeline({ db, config, sources: [src], trigger: 'test' });
  assert.equal(r.status, 'ok');
  assert.equal(r.stats.sources.fake.new, 3);
  assert.equal(src.calls.detail.length, 3);
  const rows = db.prepare('SELECT source_id, is_bike, kraj, geo_precision, est_czk, description FROM listings ORDER BY source_id').all();
  assert.deepEqual(rows.map((x) => x.is_bike), [1, 0, 1]);
  assert.equal(rows[0].kraj, 'JHM');
  assert.equal(rows[2].kraj, 'VYS');
  assert.equal(rows[0].est_czk, 10000);
  assert.equal(rows[0].description, 'Plný popis 1');
  const run = db.prepare('SELECT status, stats FROM runs').get();
  assert.equal(run.status, 'ok');
});

test('runPipeline: detail null → zmizelý; zmizelí jen po potvrzení nebo 2 chybějících průchodech', async () => {
  const db = openDb(':memory:');
  const src = makeSource(
    [[item('1'), item('2'), item('3'), item('4')], [item('1')], [item('1')]],
    { details: { 4: null }, gone: { 2: true, 3: null } }
  );
  const cfg = { ...config, fullScanDays: 1 };
  await runPipeline({ db, config: cfg, sources: [src] });
  assert.ok(db.prepare("SELECT gone_at FROM listings WHERE source_id = '4'").get().gone_at, 'detail null → gone');
  // 2. běh (celý průchod – nastavíme lastFullScan do minulosti): 2 potvrzeno smazané, 3 neví → zatím aktivní
  db.prepare("UPDATE settings SET value = ? WHERE key = 'lastFullScan:fake'").run(JSON.stringify('2000-01-01T00:00:00Z'));
  await runPipeline({ db, config: cfg, sources: [src] });
  const g = (id) => db.prepare('SELECT gone_at, missed_scans FROM listings WHERE source_id = ?').get(id);
  assert.ok(g('2').gone_at);
  assert.equal(g('3').gone_at, null);
  assert.equal(g('3').missed_scans, 1);
  db.prepare("UPDATE settings SET value = ? WHERE key = 'lastFullScan:fake'").run(JSON.stringify('2000-01-01T00:00:00Z'));
  await runPipeline({ db, config: cfg, sources: [src] });
  assert.ok(g('3').gone_at, 'chybí podruhé → gone');
  assert.equal(g('1').gone_at, null);
});

test('runPipeline: neúplný průchod nikoho neoznačí jako zmizelého', async () => {
  const db = openDb(':memory:');
  const src = makeSource([[item('1'), item('2')], [item('1')]], { complete: false });
  await runPipeline({ db, config, sources: [src] });
  await runPipeline({ db, config, sources: [src] });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listings WHERE gone_at IS NOT NULL').get().n, 0);
});

test('runPipeline: chyba zdroje → partial, ostatní kroky proběhnou', async () => {
  const db = openDb(':memory:');
  const bad = { key: 'bad', label: 'Bad', async scan() { throw new Error('captcha'); } };
  const ok = makeSource([[item('1')]]);
  const r = await runPipeline({ db, config, sources: [bad, ok] });
  assert.equal(r.status, 'partial');
  assert.equal(r.stats.sources.bad.error, 'captcha');
  assert.equal(r.stats.sources.fake.new, 1);
});
