'use strict';
// Testy menších modulů kostry: tenants, themes, log (redakce PII), config, jobs, demo-data skeleton, check-contrast,
// vendor qrcode, feature loader.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tenants = require('../src/tenants');
const themes = require('../src/themes');
const { createLogger, redact } = require('../src/log');
const { loadConfig, ensureSecret } = require('../src/config');
const { createJobs } = require('../src/jobs');
const { memoryDb, ROOT } = require('./helpers');

test('tenants: načtení demo tenanta, host → tenant, téma podle hostu', () => {
  const list = tenants.loadTenants(path.join(ROOT, 'tenants'));
  assert.equal(list.length, 1);
  const demo = list[0];
  assert.equal(demo.slug, 'demo');
  assert.equal(demo.name, 'Půjčovna kol U Tří dubů');
  assert.deepEqual(demo.hosts, ['localhost', '127.0.0.1', 'ksprehledy.cz', 'www.ksprehledy.cz', 'outdoor.ksprehledy.cz', 'sport.ksprehledy.cz', 'family.ksprehledy.cz']);
  assert.equal(demo.business.iban, 'CZ6508000000192000145399');
  assert.equal(demo.settings.feeMinor.ebike, 50000);
  assert.equal(tenants.resolveTenant(list, 'Localhost:8092').slug, 'demo');
  assert.equal(tenants.resolveTenant(list, 'SPORT.ksprehledy.cz').slug, 'demo');
  assert.equal(tenants.resolveTenant(list, 'cizi.example'), null);
  assert.equal(tenants.resolveTenant(list, 'cizi.example', { demo: true }).slug, 'demo');
  assert.equal(tenants.themeForHost(demo, 'sport.ksprehledy.cz:443'), 'sport');
  assert.equal(tenants.themeForHost(demo, 'family.ksprehledy.cz'), 'family');
  assert.equal(tenants.themeForHost(demo, 'outdoor.ksprehledy.cz'), 'outdoor');
  assert.equal(tenants.themeForHost(demo, 'localhost'), 'outdoor');
  assert.equal(tenants.normalizeHost('[::1]:8092'), '::1');
  assert.equal(tenants.publicBaseUrl(demo), 'https://ksprehledy.cz');
  assert.equal(tenants.publicBaseUrl(demo, { host: 'localhost:8092' }), 'http://localhost:8092');
});

test('tenants: seedSettings nepřepisuje existující, getSettings slučuje', () => {
  const db = memoryDb();
  const demo = tenants.loadTenants(path.join(ROOT, 'tenants'))[0];
  assert.ok(tenants.seedSettings(db, demo) >= 15);
  assert.equal(tenants.seedSettings(db, demo), 0, 'podruhé nic');
  tenants.setSetting(db, 'bufferMinutes', 90);
  const s = tenants.getSettings(db, demo);
  assert.equal(s.bufferMinutes, 90);
  assert.equal(s.transferExpiryHours, 48);
  db.close();
});

test('themes: presety podle SPEC', () => {
  assert.deepEqual(themes.THEME_NAMES, ['outdoor', 'sport', 'family']);
  assert.equal(themes.THEMES.outdoor.hero, 'fullbleed');
  assert.equal(themes.THEMES.outdoor.fonts.accent, 'Caveat');
  assert.equal(themes.THEMES.sport.nav, 'bar');
  assert.equal(themes.THEMES.sport.fonts.display, 'Barlow Condensed');
  assert.equal(themes.THEMES.family.cards, 'soft');
  assert.equal(themes.THEMES.family.css, '/themes/family.css');
  assert.equal(themes.isTheme('sport'), true);
  assert.equal(themes.isTheme('__proto__'), false);
  assert.equal(themes.getTheme('x').label, 'Outdoor');
  for (const t of Object.values(themes.THEMES)) assert.ok(fs.existsSync(path.join(ROOT, 'public', t.css)), t.css);
});

test('log: JSON řádky, úrovně, child, redakce PII', () => {
  const out = [];
  const err = [];
  const log = createLogger({ level: 'info', stdout: { write: (l) => out.push(l) }, stderr: { write: (l) => err.push(l) }, now: () => new Date('2026-10-06T00:00:00.000Z') });
  log.debug('neuvidíš');
  log.info('Ahoj', { port: 8092, email: 'a@b.cz', nested: { password: 'x', token: 'y', ok: 1 } });
  log.warn('Pozor');
  assert.equal(out.length, 1);
  assert.equal(err.length, 1);
  const rec = JSON.parse(out[0]);
  assert.equal(rec.t, '2026-10-06T00:00:00.000Z');
  assert.equal(rec.level, 'info');
  assert.equal(rec.msg, 'Ahoj');
  assert.equal(rec.port, 8092);
  assert.equal(rec.email, '[redigováno]');
  assert.equal(rec.nested.password, '[redigováno]');
  assert.equal(rec.nested.token, '[redigováno]');
  assert.equal(rec.nested.ok, 1);
  const child = log.child({ rid: 'abc' });
  child.info('x');
  assert.equal(JSON.parse(out[1]).rid, 'abc');
  assert.deepEqual(redact({ phone: '123', a: [{ iban: 'CZ' }] }), { phone: '[redigováno]', a: [{ iban: '[redigováno]' }] });
  const e = new Error('boom');
  log.error('Chyba', { error: e });
  assert.equal(JSON.parse(err[1]).error.message, 'boom');
});

test('config: výchozí hodnoty a env, ensureSecret vytvoří .secret s právy 600', () => {
  const c = loadConfig({});
  assert.equal(c.port, 8092);
  assert.equal(c.demo, true);
  assert.equal(c.trustProxy, false);
  assert.equal(c.adminUser, 'demo@ksprehledy.cz');
  assert.equal(c.adminPassword, 'kolo-demo-2026');
  assert.equal(c.resetDemoHour, 3);
  assert.equal(c.bodyLimitBytes, 256 * 1024);
  const d = loadConfig({ PK_DEMO: '0', PORT: '9000', PK_TRUST_PROXY: '1', PK_RESET_DEMO_HOUR: '', APP_VERSION: '1.2.3' });
  assert.equal(d.demo, false);
  assert.equal(d.port, 9000);
  assert.equal(d.trustProxy, true);
  assert.equal(d.resetDemoHour, null);
  assert.equal(d.adminPassword, null, 'mimo demo bez env hesla → vygeneruje se');
  assert.equal(d.version, '1.2.3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-secret-'));
  try {
    const cfg = loadConfig({ PK_DATA: dir });
    const s1 = ensureSecret(cfg);
    assert.equal(s1.length, 64);
    assert.equal(ensureSecret(cfg), s1, 'stabilní');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, '.secret')).mode & 0o777, 0o600);
    assert.equal(ensureSecret(loadConfig({ PK_DATA: dir, PK_SECRET: 'z-env' })), 'z-env');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jobs: registrace, spuštění při startu, chyba nezastaví, runNow', async () => {
  const errors = [];
  const log = { debug() {}, info() {}, warn() {}, error: (m, meta) => errors.push(meta) };
  const jobs = createJobs({ log });
  let runs = 0;
  jobs.register('ok', 60_000, async (deps) => {
    runs++;
    assert.equal(deps.marker, 42);
  });
  jobs.register('fail', 60_000, () => {
    throw new Error('rozbité');
  });
  assert.throws(() => jobs.register('ok', 60_000, () => {}), /už zaregistrovaný/);
  assert.throws(() => jobs.register('x', 10, () => {}), /everyMs/);
  jobs.start({ marker: 42 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runs, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].job, 'fail');
  await jobs.runNow('ok');
  assert.equal(runs, 2);
  const list = jobs.list();
  assert.equal(list.find((j) => j.name === 'fail').lastError, 'rozbité');
  jobs.stop();
  assert.equal(jobs.started, false);
});

test('demo-data: seed vytvoří admina idempotentně, --reset vyčistí tabulky', async () => {
  const demoData = require('../tools/demo-data');
  const { createFieldCrypto } = require('../src/crypto/fields');
  const { verifyPasswordSync } = require('../src/crypto/passwords');
  const db = memoryDb();
  const tenant = tenants.loadTenants(path.join(ROOT, 'tenants'))[0];
  const config = loadConfig({});
  const fieldCrypto = createFieldCrypto('tajemstvi-pro-test-dlouhe-dost-0123456789');
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  await demoData.seed({ db, tenant, config, fieldCrypto, log: silent });
  await demoData.seed({ db, tenant, config, fieldCrypto, log: silent });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  const u = db.prepare('SELECT * FROM users').get();
  assert.equal(u.email, 'demo@ksprehledy.cz');
  assert.equal(verifyPasswordSync('kolo-demo-2026', u.password_hash), true);
  db.prepare("INSERT INTO seasons(name, date_from, date_to) VALUES ('X', '2026-01-01', '2026-02-01')").run();
  await demoData.seed({ db, tenant, config, fieldCrypto, reset: true, log: silent });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seasons').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM settings').get().n >= 15, 'settings zůstávají');
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'demo-data.js'), 'utf8');
  assert.match(src, /\/\/ === KOLA ===/);
  assert.match(src, /\/\/ === REZERVACE ===/);
  db.close();
});

test('check-contrast: výpočet WCAG a všechna témata procházejí', () => {
  const cc = require('../tools/check-contrast');
  assert.equal(cc.contrastRatio([255, 255, 255], [0, 0, 0]).toFixed(0), '21');
  assert.equal(cc.contrastRatio([255, 255, 255], [255, 255, 255]), 1);
  assert.ok(Math.abs(cc.contrastRatio(cc.parseColor('#ffffff'), cc.parseColor('#2F5D3A')) - 7.6) < 0.2);
  assert.deepEqual(cc.parseColor('#abc'), [170, 187, 204]);
  assert.deepEqual(cc.parseColor('rgb(1, 2, 3)'), [1, 2, 3]);
  assert.equal(cc.parseColor('rgba(1,2,3,0.5)'), null);
  const vars = cc.extractVars(':root { --a: #fff; --b: var(--a); } .x { --c: #000; }', (s) => s === ':root');
  assert.equal(cc.resolveVar(vars, 'b'), '#fff');
  assert.equal(vars.c, undefined);
  const baseCss = fs.readFileSync(path.join(ROOT, 'public', 'base.css'), 'utf8');
  for (const name of themes.THEME_NAMES) {
    const themeCss = fs.readFileSync(path.join(ROOT, 'public', 'themes', `${name}.css`), 'utf8');
    const { failures, results } = cc.checkVars(cc.loadThemeVars(baseCss, themeCss, name));
    assert.deepEqual(failures, [], `${name}: ${JSON.stringify(failures)}`);
    assert.equal(results.filter((r) => r.required).length, 5);
  }
  const { failures } = cc.checkVars(cc.extractVars(baseCss, (s) => s === ':root'));
  assert.deepEqual(failures, []);
  const weak = cc.checkVars({ text: '#777', bg: '#fff', 'text-muted': '#999', primary: '#eee', 'on-primary': '#fff', accent: '#000', 'on-accent': '#fff', surface: '#fff' });
  assert.ok(weak.failures.length >= 3);
});

test('vendor: qrcode-generator funguje přes require a má licenci', () => {
  const qrcode = require('../src/vendor/qrcode');
  assert.equal(typeof qrcode, 'function');
  const qr = qrcode(0, 'M');
  qr.addData('SPD*1.0*ACC:CZ6508000000192000145399*AM:300.00*CC:CZK*X-VS:2607000123');
  qr.make();
  assert.ok(qr.getModuleCount() >= 21);
  const svg = qr.createSvgTag({ cellSize: 4, margin: 0 });
  assert.match(svg, /^<svg/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'vendor', 'qrcode.js'), 'utf8').slice(0, 600), /Kazuhiko Arase[\s\S]*MIT license/);
  assert.ok(fs.existsSync(path.join(ROOT, 'src', 'vendor', 'qrcode.LICENSE')));
  assert.ok(fs.existsSync(path.join(ROOT, 'public', 'vendor', 'LICENSES.md')));
  assert.ok(fs.existsSync(path.join(ROOT, 'public', 'vendor', 'leaflet', 'leaflet.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'public', 'vendor', 'markercluster', 'leaflet.markercluster.js')));
});

test('fonty: všech 7 rodin má woff2 (latin + latin-ext) a OFL.txt, fonts.css má font-display: swap a unicode-range', () => {
  const dir = path.join(ROOT, 'public', 'fonts');
  for (const slug of ['fraunces', 'inter', 'caveat', 'barlow-condensed', 'space-grotesk', 'nunito', 'bricolage-grotesque']) {
    const files = fs.readdirSync(path.join(dir, slug));
    assert.ok(files.includes('OFL.txt'), slug);
    assert.ok(files.some((f) => f.endsWith('-latin.woff2')), slug + ' latin');
    assert.ok(files.some((f) => f.endsWith('-latin-ext.woff2')), slug + ' latin-ext');
  }
  const css = fs.readFileSync(path.join(dir, 'fonts.css'), 'utf8');
  assert.ok((css.match(/@font-face/g) || []).length >= 14);
  assert.ok(!/font-display: (?!swap)/.test(css));
  assert.match(css, /unicode-range: U\+0100-02BA/);
  assert.match(css, /font-family: 'Barlow Condensed'/);
  assert.ok(!/https:\/\//.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'žádné externí URL');
});

test('feature loader: načte moduly, přeskočí demoOnly mimo demo, ignoruje chybějící adresář', () => {
  const { loadFeatures } = require('../server');
  const { createRouter } = require('../src/http/router');
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const r1 = loadFeatures({ config: { demo: true }, log: silent, router: createRouter() });
  assert.deepEqual(r1.loaded, ['design', 'home', 'kontakt']);
  assert.deepEqual(
    r1.nav.map((n) => n.href),
    ['/kontakt', '/design']
  );
  const r2 = loadFeatures({ config: { demo: false }, log: silent, router: createRouter() });
  assert.deepEqual(r2.loaded, ['home', 'kontakt']);
  const r3 = loadFeatures({ config: { demo: true }, log: silent, router: createRouter(), dir: '/neexistuje/vubec' });
  assert.deepEqual(r3.loaded, []);
});
