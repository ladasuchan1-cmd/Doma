'use strict';
// tools/run.js – argumenty a čitelné shrnutí běhu.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, formatSummary } = require('../tools/run');

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['--sources=bazos,sbazar', '--full', '--max-details=10']), { sources: 'bazos,sbazar', full: true, 'max-details': '10' });
  assert.throws(() => parseArgs(['bazos']), /Neznámý argument/);
});

test('formatSummary: zdroje, zpracování, chyby', () => {
  const text = formatSummary(
    {
      status: 'partial',
      stats: {
        sources: {
          bazos: { scanned: 1234, new: 56, changed: 7, details: 50, gone: 3, detailErrors: 0, mode: 'full', complete: true, error: null },
          aukro: { scanned: 0, new: 0, changed: 0, details: 0, gone: 0, mode: 'incremental', complete: false, error: 'HTTP 403' },
        },
        classified: 60,
        geocoded: 58,
        priced: 1200,
        pruned: 2,
      },
    },
    125000
  );
  assert.match(text, /částečně/);
  assert.match(text, /2 min 5 s/);
  assert.match(text, /Bazoš\s+1\s234 prošlo · 56 nových/);
  assert.match(text, /celý výpis/);
  assert.match(text, /Aukro .*jen novinky/);
  assert.match(text, /! HTTP 403/);
  assert.match(text, /60 klasifikováno · 58 s nově určenou polohou · 1\s200 naceněno · 2 starých smazáno/);
  assert.match(formatSummary({ status: 'error', error: 'Nelze načíst moduly' }, 500), /CHYBA[\s\S]*Nelze načíst moduly/);
});

// ---------------------------------------------------------------------------------------------------------
// Provoz bez programátora: rady k chybám, návratový kód pro Plánovač úloh, chyba databáze

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { errorHint, exitCodeFor, nothingDownloaded, main } = require('../tools/run');

test('errorHint: běžné chyby → česká rada', () => {
  assert.match(errorHint('Nelze stáhnout https://sport.bazos.cz/horska/: ENOTFOUND'), /Nefunguje internet/);
  assert.match(errorHint('Nelze stáhnout https://www.sbazar.cz/: EAI_AGAIN'), /internet/);
  assert.match(errorHint('HTTP 403 pro https://www.bazos.cz/'), /dočasně blokuje.*KOLOMAPA_DELAY_MS/);
  assert.match(errorHint('Sbazar vrátil místo dat HTML stránku (captcha / ověření místo dat)'), /blokuje/);
  assert.match(errorHint('Bazoš: stránka výpisu https://x nemá očekávanou podobu (změna webu?)'), /změnil podobu/);
  assert.match(errorHint('HTTP 503 pro https://www.sbazar.cz/'), /potíže na své straně/);
  assert.match(errorHint('Nelze stáhnout X: ECONNRESET'), /firewall/);
  assert.match(errorHint('Nelze stáhnout X: UNABLE_TO_VERIFY_LEAF_SIGNATURE'), /antivir/);
  assert.match(errorHint('database is locked'), /OneDrive/);
  assert.match(errorHint('Cyklobazar potřebuje prohlížeč: …'), /npx playwright install chromium/);
  assert.match(errorHint('Už běží jiné stahování (proces 1234).'), /kolomapa\.db\.run-lock/);
  assert.equal(errorHint('něco úplně jiného'), null);
  assert.equal(errorHint(undefined), null);
});

const failedSources = {
  bazos: { scanned: 0, new: 0, details: 0, mode: 'full', complete: false, error: 'Nelze stáhnout https://sport.bazos.cz/horska/: ENOTFOUND' },
  sbazar: { scanned: 0, new: 0, details: 0, mode: 'full', complete: false, error: 'Nelze stáhnout https://www.sbazar.cz/api: ENOTFOUND' },
};

test('bez internetu: pipeline hlásí „partial“, ale nic se nestáhlo → CHYBA a návratový kód 1', () => {
  const res = { status: 'partial', stats: { sources: failedSources, classified: 0, geocoded: 0, priced: 0 } };
  assert.equal(nothingDownloaded(res), true);
  assert.equal(exitCodeFor(res), 1);
  const text = formatSummary(res, 1000, new Date(2026, 9, 2, 5, 30));
  assert.match(text, /CHYBA – žádný web se nepodařilo stáhnout/);
  assert.match(text, /→ Nefunguje internet nebo překlad adres/);
  assert.equal((text.match(/→ Nefunguje internet/g) || []).length, 1, 'stejná rada jen jednou');
  assert.match(text, /stahování 2\. 10\. 2026 5:30/); // místní čas (log je v UTC)
});

test('exitCodeFor: ok / částečně (aspoň jeden web prošel) = 0; chyba / busy = 1', () => {
  assert.equal(exitCodeFor({ status: 'ok', stats: { sources: { bazos: { scanned: 10 } } } }), 0);
  const partial = { status: 'partial', stats: { sources: { ...failedSources, bazos: { scanned: 500, error: null } } } };
  assert.equal(nothingDownloaded(partial), false);
  assert.equal(exitCodeFor(partial), 0);
  // zdroj selhal ve výpisu, ale detaily už známých inzerátů prošly → něco se stáhlo
  assert.equal(exitCodeFor({ status: 'partial', stats: { sources: { bazos: { scanned: 0, details: 5, error: 'HTTP 403' } } } }), 0);
  assert.equal(exitCodeFor({ status: 'partial', stats: { sources: {} } }), 0); // AI selhalo, zdroje nic nehlásí
  assert.equal(exitCodeFor({ status: 'error', error: 'x' }), 1);
  assert.equal(exitCodeFor({ status: 'busy', error: 'Už běží jiné stahování.' }), 1);
  assert.equal(exitCodeFor(undefined), 1);
  assert.match(formatSummary({ status: 'busy', error: 'Už běží jiné stahování (proces 1).' }, 10), /neproběhlo[\s\S]*run-lock/);
});

test('main: databázi nejde otevřít → česká hláška a kód 1, žádný stack trace', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolomapa-run-'));
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const notDir = path.join(dir, 'soubor');
    fs.writeFileSync(notDir, 'x');
    assert.equal(await main([`--db=${path.join(notDir, 'kolomapa.db')}`]), 1);
    const broken = path.join(dir, 'rozbita.db');
    fs.writeFileSync(broken, 'tohle není databáze, jen text '.repeat(200));
    assert.equal(await main([`--db=${broken}`]), 1);
  } finally {
    console.error = origError;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows: poškozený soubor DB může držet otevřený handle (openDb ho po chybě nezavře) */
    }
  }
  const out = errors.join('\n');
  assert.match(out, /CHYBA – databázi nejde otevřít/);
  assert.match(out, /→ Databáze je poškozená/);
  assert.doesNotMatch(out, /\n\s+at /);
});

test('main --process-only: bez stahování doplní klasifikaci, polohu a nacenění; při drženém zámku kód 1', async () => {
  const { openDb } = require('../src/db');
  const { upsertItem } = require('../src/pipeline');
  const sch = require('../src/server/scheduler');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolomapa-run-'));
  const dbFile = path.join(dir, 'kolomapa.db');
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const db = openDb(dbFile);
    for (let i = 1; i <= 5; i++) upsertItem(db, 'bazos', { sourceId: String(i), url: `https://x.cz/${i}`, title: `Horské kolo Trek ${i}`, priceCzk: 8000 + i * 500, locationText: 'Brno' }, new Date().toISOString());
    db.close();
    const lock = sch.acquireRunLock(dbFile);
    assert.equal(await main([`--db=${dbFile}`, '--process-only']), 1, 'zámek drží jiný proces');
    lock.release();
    assert.equal(await main([`--db=${dbFile}`, '--process-only']), 0);
    const db2 = openDb(dbFile);
    assert.equal(db2.prepare("SELECT count(*) AS n FROM listings WHERE kraj = 'JHM' AND is_bike = 1").get().n, 5);
    db2.close();
    assert.equal(fs.existsSync(`${dbFile}.run-lock`), false, 'zámek uvolněn');
  } finally {
    console.log = origLog;
    console.error = origError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.match(errors.join('\n'), /už běží jiné stahování/);
  assert.match(logs.join('\n'), /zpracování bez stahování: klasifikováno 5, poloha 5, naceněno/);
});

test('main: neznámý zdroj / argument → kód 1 a nápověda', async () => {
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    assert.equal(await main(['--sources=bazos,olx']), 1);
    assert.equal(await main(['bazos']), 1);
    assert.equal(await main(['--max-details=-1']), 1);
  } finally {
    console.error = origError;
  }
  assert.match(errors.join('\n'), /Neznámý zdroj: olx[\s\S]*Neznámý argument: bazos[\s\S]*--max-details musí být/);
});
