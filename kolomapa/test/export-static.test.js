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
const data = require('../src/server/data');
const { KRAJ_CODES } = data;
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

/** Umí systém symlinky? (Windows bez vývojářského režimu ne) */
function canSymlink(dir) {
  try {
    fs.symlinkSync(dir, path.join(dir, '.symlink-test'), 'dir');
    fs.unlinkSync(path.join(dir, '.symlink-test'));
    return true;
  } catch {
    return false;
  }
}

test('export: symlinky z public/ jen dovnitř public/ (obsah, ne odkaz), bez cyklů; .git a CNAME zůstanou', async (t) => {
  const { dir, config } = setup();
  if (!canSymlink(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return t.skip('systém neumí symlinky');
  }
  const { db } = sampleDb();
  try {
    // vlastní public/ se symlinky: ven (tajný soubor), dovnitř (alias adresáře), cyklus, rozbitý odkaz
    const pub = path.join(dir, 'pub');
    fs.mkdirSync(path.join(pub, 'vendor'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'secret'));
    fs.writeFileSync(path.join(dir, 'secret', 'key.txt'), 'TAJNE');
    fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(pub, 'vendor', 'lib.js'), '/* lib */');
    fs.writeFileSync(path.join(pub, '.env'), 'TAJNE');
    fs.symlinkSync(path.join(dir, 'secret'), path.join(pub, 'leak'), 'dir');
    fs.symlinkSync(path.join(dir, 'secret', 'key.txt'), path.join(pub, 'vendor', 'key.txt'));
    fs.symlinkSync('vendor', path.join(pub, 'alias'), 'dir');
    fs.symlinkSync('..', path.join(pub, 'vendor', 'loop'), 'dir');
    fs.symlinkSync('neexistuje.js', path.join(pub, 'broken.js'));
    const cfg = { ...config, publicDir: pub };

    // pracovní kopie gh-pages: .git + CNAME, bez značky → smí se použít a nesmaže se
    const out = cfg.staticDir;
    fs.mkdirSync(path.join(out, '.git'), { recursive: true });
    fs.writeFileSync(path.join(out, '.git', 'HEAD'), 'ref: refs/heads/gh-pages\n');
    fs.writeFileSync(path.join(out, 'CNAME'), 'kolomapa.example.cz\n');
    const warns = [];
    const r = await exportStatic({ db, config: cfg, log: { info() {}, warn: (...a) => warns.push(a) } });
    await exportStatic({ db, config: cfg, log: { info() {}, warn() {} } }); // podruhé přes značku

    assert.equal(fs.readFileSync(path.join(out, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/gh-pages\n');
    assert.equal(fs.readFileSync(path.join(out, 'CNAME'), 'utf8'), 'kolomapa.example.cz\n');
    assert.equal(fs.readFileSync(path.join(out, 'alias', 'lib.js'), 'utf8'), '/* lib */');
    assert.equal(fs.lstatSync(path.join(out, 'alias')).isSymbolicLink(), false);
    for (const p of ['leak', 'vendor/key.txt', 'vendor/loop', 'broken.js', '.env']) assert.equal(fs.existsSync(path.join(out, p)), false, p);
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isSymbolicLink() ? [path.join(d, e.name)] : e.isDirectory() ? walk(path.join(d, e.name)) : []));
    assert.deepEqual(walk(out), [], 'export nesmí obsahovat symlinky');
    assert.ok(warns.length && JSON.stringify(warns).includes('leak'));
    assert.ok(r.files > 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkOutDir: symlink na zakázaný adresář (domov, projekt) se odmítne', (t) => {
  const { dir, config } = setup();
  if (!canSymlink(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return t.skip('systém neumí symlinky');
  }
  try {
    const toHome = path.join(dir, 'home-link');
    fs.symlinkSync(os.homedir(), toHome, 'dir');
    assert.throws(() => checkOutDir(toHome, config), /nezapíšu/);
    const toProject = path.join(dir, 'proj-link');
    fs.symlinkSync(config.projectDir, toProject, 'dir');
    assert.throws(() => checkOutDir(toProject, config), /nezapíšu/);
    assert.throws(() => checkOutDir(path.join(toProject, 'public', 'nove'), config), /nezapíšu/);
    assert.equal(checkOutDir(path.join(dir, 'novy'), config), path.join(dir, 'novy'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('statický přehled: chybové hlášky běhu bez cest a přihlašovacích údajů', async () => {
  const { dir, config } = setup();
  const { db } = sampleDb();
  try {
    const stats = {
      sources: { bazos: { error: 'Cannot find module playwright\nRequire stack:\n- /home/user/kolomapa/src/sources/browser.js', scanned: 10 }, sbazar: { error: null } },
      aiError: 'connect ECONNREFUSED http://user:tajne@proxy.firma.cz:3128',
      model: { mode: 'model', buyRatio: 0.652, calibration: 0.885, salesUsed: 38 },
    };
    db.prepare("INSERT INTO runs (started_at, finished_at, status, trigger, stats, error) VALUES (?, ?, 'partial', 'cli', ?, ?)").run(
      '2026-10-01T05:00:00Z',
      '2026-10-01T05:30:00Z',
      JSON.stringify(stats),
      "ENOENT: no such file or directory, open '/home/user/kolomapa/data/kolomapa.db'"
    );
    await exportStatic({ db, config, log });
    const text = fs.readFileSync(path.join(config.staticDir, 'data', 'summary.json'), 'utf8');
    assert.doesNotMatch(text, /\/home\/user|tajne|Require stack/);
    const s = JSON.parse(text);
    assert.equal(s.lastRun.error, "ENOENT: no such file or directory, open '…/kolomapa.db'");
    assert.equal(s.lastRun.stats.sources.bazos.error, 'Cannot find module playwright');
    assert.equal(s.lastRun.stats.aiError, 'connect ECONNREFUSED http://proxy.firma.cz:3128');
    assert.equal(s.lastRun.stats.sources.bazos.scanned, 10);
    assert.equal('model' in s.lastRun.stats, false, 'interní čísla modelu (výkupní poměr) nepatří do veřejného exportu');
    // server (pro provozovatele) dál ukazuje vše
    assert.equal(data.buildSummary(db, { mode: 'server' }).lastRun.stats.model.buyRatio, 0.652);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('veřejný export (výchozí): bez max. výkupní ceny, poznámek AI a kalibrace na vlastní prodeje; --interni je ponechá', async () => {
  const { dir, config } = setup();
  const { db, ids } = sampleDb();
  try {
    db.prepare("UPDATE listings SET ai_czk = 58000, ai_low = 52000, ai_high = 63000, ai_notes = 'Koloshop prodal podobné za 41 000 Kč', ai_input_hash = 'h1', content_hash = 'h1', est_factors = ? WHERE id = ?").run(
      JSON.stringify(['Stáří 4 roky: −40 %', 'Kalibrace na vlastní prodeje obchodu: ×0,9']),
      ids.dealJhm
    );
    const r = await exportStatic({ db, config, log });
    assert.equal(r.internal, false);
    const read = (f) => fs.readFileSync(path.join(config.staticDir, 'data', f), 'utf8');
    for (const text of [read('summary.json'), read('kraj/JHM.json'), read('kraj/PHA.json')]) {
      assert.doesNotMatch(text, /"mb":|Koloshop prodal|vlastní prodeje obchodu/);
    }
    const l = JSON.parse(read('kraj/JHM.json')).listings.find((x) => x.id === ids.dealJhm);
    assert.deepEqual(l.ai, { e: 58000, l: 52000, h: 63000 }, 'AI odhad zůstává, poznámky ne');
    assert.deepEqual(l.fx, ['Stáří 4 roky: −40 %']);
    // neveřejné umístění: vše jako na serveru
    const warns = [];
    const r2 = await exportStatic({ db, config: { ...config, staticInternal: true }, log: { ...log, warn: (m) => warns.push(m) } });
    assert.equal(r2.internal, true);
    const l2 = JSON.parse(read('kraj/JHM.json')).listings.find((x) => x.id === ids.dealJhm);
    assert.equal(l2.mb, 7400);
    assert.match(l2.ai.n, /Koloshop/);
    assert.ok(warns.some((w) => /nenahrávejte ji na veřejný web/.test(w)));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
