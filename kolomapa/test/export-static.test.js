'use strict';
// Statický export: zapsané soubory, režim 'static', jen relativní adresy v UI, bezpečné přepisování adresáře.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/util/log');
const { exportStatic, checkOutDir, MARKER } = require('../tools/export-static');
const { KRAJ_CODES } = require('../src/server/data');
const { sampleDb } = require('./server-helpers');

const log = createLogger({ level: 'silent' });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolomapa-export-'));
  const config = { ...loadConfig({}), dbFile: ':memory:', staticDir: path.join(dir, 'dist') };
  return { dir, config };
}

test('exportStatic zapíše UI, přehled, 14 krajů a hranice', async () => {
  const { dir, config } = setup();
  const { db, ids } = sampleDb();
  try {
    const r = await exportStatic({ db, config, log });
    const out = config.staticDir;
    assert.equal(r.outDir, out);
    for (const f of ['index.html', 'app.js', 'styles.css', 'favicon.svg', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/markercluster/leaflet.markercluster.js', 'data/summary.json', 'data/kraje.geojson', MARKER, '.nojekyll']) {
      assert.ok(fs.existsSync(path.join(out, f)), `chybí ${f}`);
    }
    const summary = JSON.parse(fs.readFileSync(path.join(out, 'data/summary.json'), 'utf8'));
    assert.equal(summary.mode, 'static');
    assert.equal(summary.topDeals[0].id, ids.dealJhm);
    for (const code of KRAJ_CODES) {
      const k = JSON.parse(fs.readFileSync(path.join(out, 'data/kraj', `${code}.json`), 'utf8'));
      assert.equal(k.kraj, code);
      assert.ok(Array.isArray(k.listings));
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'data/kraj/JHM.json'), 'utf8')).listings.length, 2);
    assert.equal(r.listings, 5); // 6 kol, jedno bez kraje
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'data/kraje.geojson'), 'utf8')).features.length, 14);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('UI používá jen relativní adresy (GitHub Pages v podadresáři)', () => {
  const pub = path.join(__dirname, '..', 'public');
  const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  assert.doesNotMatch(app, /['"`]\/(data|api|vendor)\//, 'app.js nesmí používat absolutní /data/, /api/ ani /vendor/');
  assert.match(app, /['"`]data\/summary\.json['"`]/);
  assert.match(app, /data\/kraj\/\$\{/);
  assert.doesNotMatch(html, /(src|href)="\/(?!\/)/, 'index.html nesmí odkazovat na absolutní cesty');
  assert.match(html, /src="vendor\/leaflet\/leaflet\.js"/);
  assert.doesNotMatch(app, /\.innerHTML\s*=/, 'app.js nesmí používat innerHTML');
});

test('export opakovaně přepíše starý export, cizí neprázdný adresář nepřepíše', async () => {
  const { dir, config } = setup();
  const { db } = sampleDb();
  try {
    await exportStatic({ db, config, log });
    fs.writeFileSync(path.join(config.staticDir, 'stary.txt'), 'x');
    await exportStatic({ db, config, log });
    assert.equal(fs.existsSync(path.join(config.staticDir, 'stary.txt')), false);

    const foreign = path.join(dir, 'cizi');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'dulezite.txt'), 'neprepsat');
    await assert.rejects(exportStatic({ db, config, log, outDir: foreign }), /není prázdný/);
    assert.equal(fs.readFileSync(path.join(foreign, 'dulezite.txt'), 'utf8'), 'neprepsat');

    assert.throws(() => checkOutDir(config.projectDir, config), /nezapíšu/);
    assert.throws(() => checkOutDir(config.publicDir, config), /nezapíšu/);
    assert.throws(() => checkOutDir(path.join(config.publicDir, 'x'), config), /nezapíšu/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
