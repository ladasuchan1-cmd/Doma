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
  // nekolo (helma) se pozná už z výpisu → detail se nestahuje
  assert.deepEqual(src.calls.detail.sort(), ['1', '3']);
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

test('ctx.cache: trvalá cache zdroje přes běhy', async () => {
  const db = openDb(':memory:');
  const seen = [];
  const src = {
    key: 'c',
    label: 'C',
    async scan(ctx) {
      seen.push(ctx.cache.get('loc:1'));
      ctx.cache.set('loc:1', { lat: 49.1, lon: 16.6 });
      return { complete: false };
    },
  };
  await runPipeline({ db, config, sources: [src] });
  await runPipeline({ db, config, sources: [src] });
  assert.deepEqual(seen, [undefined, { lat: 49.1, lon: 16.6 }]);
});

test('upsertItem: cena „Dohodou“ (null) smaže dřívější cenu; číselná cena smaže poznámku', () => {
  const db = openDb(':memory:');
  upsertItem(db, 'fake', item('1', { priceCzk: 9000 }), '2026-10-01T00:00:00Z');
  upsertItem(db, 'fake', item('1', { priceCzk: null, priceNote: 'Dohodou' }), '2026-10-02T00:00:00Z');
  let r = db.prepare('SELECT price_czk, price_note FROM listings').get();
  assert.deepEqual([r.price_czk, r.price_note], [null, 'Dohodou']);
  upsertItem(db, 'fake', item('1', { priceCzk: 8500 }), '2026-10-03T00:00:00Z');
  r = db.prepare('SELECT price_czk, price_note FROM listings').get();
  assert.deepEqual([r.price_czk, r.price_note], [8500, null]);
});

test('upsertItem: parametry z výpisu se slévají, null klíč smaže; proměnlivé parametry nemění otisk', () => {
  const db = openDb(':memory:');
  upsertItem(db, 'fake', { ...item('1'), params: { 'Velikost rámu': 'L', Rezervováno: 'ano' } }, '2026-10-01T00:00:00Z', { fromDetail: true });
  const h1 = db.prepare('SELECT content_hash FROM listings').get().content_hash;
  const r = upsertItem(db, 'fake', item('1', { params: { Rezervováno: null, Konec: '5. 10. 2026 20:00' } }), '2026-10-02T00:00:00Z');
  const row = db.prepare('SELECT params, content_hash FROM listings').get();
  assert.deepEqual(JSON.parse(row.params), { 'Velikost rámu': 'L', Konec: '5. 10. 2026 20:00' });
  assert.equal(row.content_hash, h1);
  assert.equal(r.changed, false);
});

test('geolokace: souřadnice z webu s přesností „psc“ → rozptyl pinů; nové souřadnice se přepočítají', async () => {
  const db = openDb(':memory:');
  const src = makeSource([
    [item('1', { locationText: 'Brno venkov' })],
    [item('1', { locationText: 'Brno venkov', lat: 49.289978, lon: 16.575022, latLonPrecision: 'psc' })],
  ]);
  await runPipeline({ db, config, sources: [src] });
  assert.equal(db.prepare('SELECT geo_precision FROM listings').get().geo_precision, 'okres');
  await runPipeline({ db, config, sources: [src] });
  const r = db.prepare('SELECT lat, lon, kraj, geo_precision, src_lat FROM listings').get();
  assert.deepEqual([r.lat, r.lon, r.kraj, r.geo_precision, r.src_lat], [49.289978, 16.575022, 'JHM', 'psc', 49.289978]);
});

test('ctx.markSeen: aktivní podle sitemapy → není zmizelý; refreshDetail vynutí nový detail', async () => {
  const db = openDb(':memory:');
  let run = 0;
  const src = {
    key: 'sm',
    label: 'SM',
    detailCalls: [],
    async scan(ctx) {
      run++;
      if (run === 1) {
        await ctx.emit(item('a'));
        await ctx.emit(item('b'));
      } else {
        assert.equal(ctx.markSeen('a'), true);
        assert.equal(ctx.markSeen('b', { refreshDetail: true }), true);
        assert.equal(ctx.markSeen('neznamy'), false);
      }
      return { complete: true };
    },
    async detail(ctx, l) {
      this.detailCalls.push(`${run}:${l.source_id}`);
      return { description: 'x' };
    },
  };
  const cfg = { ...config, fullScanDays: 1 };
  await runPipeline({ db, config: cfg, sources: [src] });
  db.prepare("UPDATE settings SET value = ? WHERE key = 'lastFullScan:sm'").run(JSON.stringify('2000-01-01T00:00:00Z'));
  await runPipeline({ db, config: cfg, sources: [src] });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listings WHERE gone_at IS NOT NULL').get().n, 0);
  assert.deepEqual(src.detailCalls.sort(), ['1:a', '1:b', '2:b']);
});

test('contentHash: čas úpravy („Upraveno“) nemění otisk (žádné zbytečné AI přecenění)', () => {
  const { contentHash } = require('../src/pipeline');
  const base = { title: 'Kolo', price_czk: 1000, description: 'x' };
  assert.equal(contentHash({ ...base, params: { Upraveno: '1. 10. 2026' } }), contentHash({ ...base, params: { Upraveno: '2. 10. 2026' } }));
  assert.notEqual(contentHash({ ...base, params: { Velikost: 'M' } }), contentHash({ ...base, params: { Velikost: 'L' } }));
});
