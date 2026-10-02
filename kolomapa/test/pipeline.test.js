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
const { runPipeline, upsertItem, rescrubStored, contentHash } = require('../src/pipeline');
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

test('upsertItem: kontakty se skryjí i v poznámce k ceně, lokalitě a parametrech', () => {
  const db = openDb(':memory:');
  upsertItem(
    db,
    'fake',
    item('1', { priceNote: 'Dohodou, volejte 777 123 456', locationText: 'Brno, tel. 608123456', params: { Stav: 'Použité', Kontakt: 'jan.novak@seznam.cz', Rok: 2021 } }),
    '2026-10-01T00:00:00Z'
  );
  const row = db.prepare('SELECT price_note, location_text, params FROM listings').get();
  assert.doesNotMatch(JSON.stringify(row), /777 123 456|608123456|novak@/);
  assert.match(row.price_note, /^Dohodou, volejte \[telefon skryt\]/);
  assert.deepEqual(JSON.parse(row.params), { Stav: 'Použité', Kontakt: '[e-mail skryt]', Rok: 2021 });
});

test('rescrubStored: jednorázově skryje kontakty ve starších záznamech, platné AI nacenění zůstane platné', () => {
  const db = openDb(':memory:');
  const raw = { title: 'Kolo Trek', description: 'Pište na jan.novak@seznam.cz', price_czk: 9000, params: {} };
  const h = contentHash(raw);
  db.prepare(
    "INSERT INTO listings (source, source_id, url, title, description, price_czk, price_note, params, content_hash, ai_czk, ai_input_hash, first_seen_at, last_seen_at) VALUES ('fake', '1', 'https://x.cz/1', ?, ?, 9000, 'tel 777 123 456', '{}', ?, 9500, ?, 'x', 'x')"
  ).run(raw.title, raw.description, h, h);
  db.prepare(
    "INSERT INTO listings (source, source_id, url, title, price_czk, content_hash, first_seen_at, last_seen_at) VALUES ('fake', '2', 'https://x.cz/2', 'Čisté kolo', 5000, 'abc', 'x', 'x')"
  ).run();
  assert.equal(rescrubStored(db), 1);
  const r = db.prepare("SELECT * FROM listings WHERE source_id = '1'").get();
  assert.equal(r.description, 'Pište na [e-mail skryt]');
  assert.equal(r.price_note, 'tel [telefon skryt]');
  assert.notEqual(r.content_hash, h);
  assert.equal(r.ai_input_hash, r.content_hash, 'AI odhad zůstává aktuální – za nacenění se znovu neplatí');
  assert.equal(db.prepare("SELECT content_hash FROM listings WHERE source_id = '2'").get().content_hash, 'abc', 'čisté záznamy beze změny');
  assert.equal(rescrubStored(db), 0, 'podruhé už nic');
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
  // všechny zdroje selhaly a nic nestáhly → chyba (ne „částečný“ běh), kroky po stažení přesto proběhnou
  const all = await runPipeline({ db, config, sources: [bad] });
  assert.equal(all.status, 'error');
  assert.equal(all.error, 'captcha');
  assert.equal(db.prepare('SELECT status FROM runs WHERE id = ?').get(all.runId).status, 'error');
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

test('geolokace: okres/kraj z webu (Sbazar) nepřepíše kód kraje – inzerát zůstane v kraji i v dalších bězích', async () => {
  const db = openDb(':memory:');
  const it = item('1', { locationText: 'Smilovice', okres: 'Frýdek-Místek', kraj: 'Moravskoslezský kraj' });
  const src = makeSource([[it], [it], [it]]);
  for (let i = 0; i < 3; i++) {
    await runPipeline({ db, config, sources: [src] });
    const r = db.prepare('SELECT kraj, okres, src_kraj, src_okres, geo_precision FROM listings').get();
    assert.deepEqual([r.kraj, r.okres, r.geo_precision], ['MSK', 'Frýdek-Místek', 'city'], `běh ${i + 1}`);
    assert.deepEqual([r.src_kraj, r.src_okres], ['Moravskoslezský kraj', 'Frýdek-Místek']);
  }
  // ani samotné uložení položky (mezi uložením a geolokací v běhu) kód kraje nepřepíše
  upsertItem(db, 'fake', it, '2026-10-05T00:00:00Z');
  assert.equal(db.prepare('SELECT kraj FROM listings').get().kraj, 'MSK');
});

test('geolokace: prodávající změní lokalitu → poloha se spočítá znovu; neznámé místo nemá kraj', async () => {
  const db = openDb(':memory:');
  const src = makeSource([[item('1', { locationText: 'Brno' })], [item('1', { locationText: 'Pelhřimov' })], [item('1', { locationText: 'Xyzzy Qwerty' })]]);
  await runPipeline({ db, config, sources: [src] });
  assert.equal(db.prepare('SELECT kraj FROM listings').get().kraj, 'JHM');
  await runPipeline({ db, config, sources: [src] });
  assert.equal(db.prepare('SELECT kraj FROM listings').get().kraj, 'VYS');
  await runPipeline({ db, config, sources: [src] });
  const r = db.prepare('SELECT kraj, lat, geo_precision FROM listings').get();
  assert.deepEqual([r.kraj, r.lat, r.geo_precision], [null, null, null]);
});

test('geolokace: po změně logiky (GEO_VERSION) se přepočítají i inzeráty s přesností obce', async () => {
  const db = openDb(':memory:');
  const src = makeSource([[item('1', { locationText: 'Pelhřimov' })]]);
  await runPipeline({ db, config, sources: [src] });
  // stará verze geolokace uložila chybnou polohu s přesností „city“ (běžně se už nepřepočítává)
  db.prepare("UPDATE listings SET lat = 50.1, lon = 14.4, kraj = 'PHA', geo_precision = 'city'").run();
  await runPipeline({ db, config, sources: [src] });
  assert.equal(db.prepare('SELECT kraj FROM listings').get().kraj, 'PHA', 'beze změny verze zůstává');
  db.prepare("UPDATE settings SET value = '\"stara\"' WHERE key = 'geoVersion'").run();
  await runPipeline({ db, config, sources: [src] });
  assert.equal(db.prepare('SELECT kraj FROM listings').get().kraj, 'VYS');
});

test('migrace v4: okres/kraj Sbazaru → src_okres/src_kraj, text místo kódu kraje → nová geolokace', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { MIGRATIONS, migrate } = require('../src/db');
  const { geocodePending } = require('../src/pipeline');
  const db = new DatabaseSync(':memory:');
  for (const sql of MIGRATIONS.slice(0, 3)) db.exec(sql);
  db.exec('PRAGMA user_version = 3');
  const ins = db.prepare(
    "INSERT INTO listings (source, source_id, url, title, location_text, okres, kraj, lat, lon, geo_precision, first_seen_at, last_seen_at) VALUES (?, ?, 'u', 't', ?, ?, ?, ?, ?, ?, 'x', 'x')"
  );
  ins.run('sbazar', '1', 'Smilovice', 'Frýdek-Místek', 'Moravskoslezský kraj', 49.66, 18.57, 'city'); // poškozený řádek
  ins.run('cyklobazar', '2', 'Žilina', 'Žilina', null, null, null, null); // zahraničí
  ins.run('bazos', '3', 'Brno', 'Brno-město', 'JHM', 49.2, 16.6, 'city');
  migrate(db);
  const rows = db.prepare('SELECT source, src_okres, src_kraj, geo_precision FROM listings ORDER BY id').all();
  assert.deepEqual(rows.map((r) => [r.src_okres, r.src_kraj, r.geo_precision]), [
    ['Frýdek-Místek', 'Moravskoslezský kraj', null],
    ['Žilina', null, null],
    [null, null, 'city'],
  ]);
  geocodePending(db);
  const after = db.prepare('SELECT kraj, lat FROM listings ORDER BY id').all();
  assert.deepEqual(after.map((r) => r.kraj), ['MSK', null, 'JHM']);
  assert.equal(after[1].lat, null, 'zahraniční okres zůstane bez polohy');
});

test('runPipeline: běh nedokončený po pádu procesu („running“) se při dalším běhu uzavře jako chyba', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO runs (started_at, status, trigger) VALUES ('2026-10-01T05:30:00.000Z', 'running', 'schedule')").run();
  const r = await runPipeline({ db, config, sources: [makeSource([[item('1')]])] });
  const runs = db.prepare('SELECT id, status, finished_at, error FROM runs ORDER BY id').all();
  assert.equal(runs[0].status, 'error');
  assert.ok(runs[0].finished_at && /nebyl dokončen/.test(runs[0].error));
  assert.equal(runs[1].id, r.runId);
  assert.equal(runs[1].status, 'ok');
});

test('upsertItem: změna ceny a záznam do historie cen jsou jedna transakce', () => {
  const db = openDb(':memory:');
  upsertItem(db, 'fake', item('1', { priceCzk: 9000 }), '2026-10-01T00:00:00Z');
  // zápis do historie selže (jako pád procesu mezi dvěma příkazy) → nesmí zůstat nová cena bez historie
  db.exec("CREATE TRIGGER fail_hist BEFORE INSERT ON price_history BEGIN SELECT RAISE(ABORT, 'disk plný'); END");
  assert.throws(() => upsertItem(db, 'fake', item('1', { priceCzk: 8000 }), '2026-10-02T00:00:00Z'), /disk plný/);
  assert.equal(db.prepare('SELECT price_czk FROM listings').get().price_czk, 9000);
  db.exec('DROP TRIGGER fail_hist');
  // uvnitř vnější transakce (SAVEPOINT) se chová stejně
  db.exec('BEGIN');
  upsertItem(db, 'fake', item('1', { priceCzk: 8000 }), '2026-10-02T00:00:00Z');
  db.exec('COMMIT');
  assert.deepEqual(db.prepare('SELECT price_czk FROM price_history ORDER BY at').all().map((x) => x.price_czk), [9000, 8000]);
});

test('migrate: migraci, kterou mezitím provedl jiný proces (server × tools/run.js), nespustí podruhé', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { DatabaseSync } = require('node:sqlite');
  const { migrate, MIGRATIONS } = require('../src/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolomapa-mig-'));
  const file = path.join(dir, 'k.db');
  try {
    const a = new DatabaseSync(file);
    for (const sql of MIGRATIONS.slice(0, 3)) a.exec(sql);
    a.exec('PRAGMA user_version = 3');
    const b = new DatabaseSync(file);
    // proces B si přečte verzi 3 …
    let stale = true;
    const bView = {
      exec: (sql) => b.exec(sql),
      prepare(sql) {
        if (stale && /user_version/.test(sql)) {
          stale = false;
          return { get: () => ({ user_version: 3 }) };
        }
        return b.prepare(sql);
      },
    };
    // … mezitím proces A dokončí migraci …
    migrate(a);
    // … a B nesmí spadnout na „duplicate column name“
    assert.doesNotThrow(() => migrate(bView));
    assert.equal(b.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    a.close();
    b.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runPipeline: přerušený celý průchod se nezapíše jako úplný (příští běh je zase celý)', async () => {
  const db = openDb(':memory:');
  const controller = new AbortController();
  const src = {
    key: 'ab',
    label: 'AB',
    async scan(ctx) {
      await ctx.emit(item('1'));
      await ctx.emit(item('2'));
      return { complete: true };
    },
    async detail() {
      controller.abort(new Error('Ukončuji server'));
      return { description: 'x' };
    },
  };
  const r = await runPipeline({ db, config: { ...config, fullScanDays: 1 }, sources: [src], signal: controller.signal });
  assert.equal(r.status, 'error');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'lastFullScan:ab'").get(), undefined);
});

test('runPipeline: celý průchod jednou za místní kalendářní den (i když od včerejšího běhu uplynulo < 22 h)', async () => {
  const db = openDb(':memory:');
  const src = makeSource([[item('1')]]);
  // poslední celý průchod: včera 23:59 místního času
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 0, 0);
  db.prepare("INSERT INTO settings (key, value) VALUES ('lastFullScan:fake', ?)").run(JSON.stringify(yesterday.toISOString()));
  const r = await runPipeline({ db, config: { ...config, fullScanDays: 1 }, sources: [src] });
  assert.equal(r.stats.sources.fake.mode, 'full');
  // druhý běh téhož dne → jen novinky
  const r2 = await runPipeline({ db, config: { ...config, fullScanDays: 1 }, sources: [src] });
  assert.equal(r2.stats.sources.fake.mode, 'incremental');
});
