#!/usr/bin/env node
'use strict';
// Smoke test webového rozhraní přes Playwright (Chromium): projde přehled ČR, kraj, filtry a detail inzerátu
// na desktopu (1440×900) i mobilu (390×844) ve světlém i tmavém režimu, udělá snímky obrazovky a ohlídá chyby
// v konzoli, nezachycené výjimky, chybné odpovědi serveru a vodorovné přetečení stránky.
//
//   node tools/ui-smoke.js [--out=DIR] [--url=http://127.0.0.1:8090] [--only=desktop|mobile] [--no-dark] [--headed]
//
// Bez --url si spustí vlastní server nad dočasnou databází s demo daty (tools/demo-data.js) – skutečnou databázi
// nemění. Dlaždice OpenStreetMap se v testu blokují (mapa musí fungovat i bez nich).
// Playwright: require('playwright'), jinak /opt/node-tools/node_modules/playwright nebo PLAYWRIGHT_PATH.
// Prohlížeč: KOLOMAPA_BROWSER / /opt/pw-browsers/chromium, jinak výchozí Chromium Playwrightu.
// Návratový kód 1 = nalezeny problémy.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

function loadPlaywright() {
  const candidates = ['playwright', process.env.PLAYWRIGHT_PATH, '/opt/node-tools/node_modules/playwright'].filter(Boolean);
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* další kandidát */
    }
  }
  throw new Error('Playwright nenalezen – nainstalujte ho (npm i -D playwright) nebo nastavte PLAYWRIGHT_PATH.');
}

function browserPath() {
  for (const p of [process.env.KOLOMAPA_BROWSER, '/opt/pw-browsers/chromium']) {
    if (p && fs.existsSync(p)) return p;
  }
  return undefined;
}

const OUT = path.resolve(String(args.out || process.env.UI_SHOTS_DIR || path.join(os.tmpdir(), 'kolomapa-ui')));
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
].filter((v) => !args.only || v.name === args.only);
const SCHEMES = args['no-dark'] ? ['light'] : ['light', 'dark'];

const problems = [];
const problem = (where, msg) => problems.push(`${where}: ${msg}`);

async function startLocalServer() {
  const { openDb } = require('../src/db');
  const { seedDemo } = require('./demo-data');
  const { start } = require('../server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolomapa-smoke-'));
  const dbFile = path.join(dir, 'smoke.db');
  const db = openDb(dbFile);
  seedDemo(db, { count: 400, seed: 7 });
  const log = require('../src/util/log').createLogger({ level: 'warn' });
  const inst = await start({ db, log, port: 0, host: '127.0.0.1', password: null, scheduler: false, publicDir: path.join(__dirname, '..', 'public') });
  return {
    url: inst.url,
    async stop() {
      await inst.stop();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

async function checkOverflow(page, where) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  if (o.sw > o.w + 1) problem(where, `vodorovné přetečení stránky (${o.sw} > ${o.w} px)`);
}

async function runScenario(browser, base, vp, scheme) {
  const tag = `${vp.name}-${scheme}`;
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: !!vp.isMobile,
    hasTouch: !!vp.hasTouch,
    colorScheme: scheme,
    locale: 'cs-CZ',
    timezoneId: 'Europe/Prague',
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/tile\.openstreetmap|ERR_FAILED|net::ERR_/.test(m.text())) problem(tag, `konzole: ${m.text()}`);
  });
  page.on('pageerror', (e) => problem(tag, `výjimka: ${e.message}`));
  page.on('response', (r) => {
    if (r.url().startsWith(base) && r.status() >= 400) problem(tag, `HTTP ${r.status()} ${r.url()}`);
  });
  // dlaždice mapy v testu neřešíme (sandbox bez internetu) – rychle odmítnout
  await page.route(/tile\.openstreetmap\.org/, (route) => route.abort());

  const files = [];
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.kraj-label__inner', { timeout: 15000 });
  await page.waitForSelector('#panel .cards .card, #panel .empty', { timeout: 15000 });
  const labels = await page.locator('.kraj-label__inner').count();
  if (labels !== 14) problem(tag, `popisků krajů je ${labels}, čekáno 14`);
  const paths = await page.locator('.leaflet-kraje-pane path').count();
  if (paths < 14) problem(tag, `polygonů krajů je ${paths}, čekáno ≥ 14`);
  await page.waitForTimeout(400);
  files.push(await shot(page, `${tag}-1-prehled`));
  await checkOverflow(page, `${tag} přehled`);

  // záložka Kraje
  await page.locator('.tab', { hasText: 'Kraje' }).click();
  await page.waitForSelector('.ktable tbody tr');
  if (vp.name === 'desktop') files.push(await shot(page, `${tag}-2-kraje`));
  await page.locator('.tab', { hasText: 'Nejvýhodnější' }).click();

  // kliknutí na kraj (popisek Jihomoravského kraje na mapě)
  if (vp.isMobile) await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('.kraj-label__inner', { hasText: vp.isMobile ? /./ : 'Jihomoravský' }).nth(vp.isMobile ? 10 : 0).click();
  await page.waitForFunction(() => location.hash.startsWith('#/'));
  await page.waitForSelector('#cards .card', { timeout: 15000 });
  await page.waitForSelector('.pin, .cluster', { timeout: 15000 });
  await page.waitForTimeout(700);
  const kraj = await page.evaluate(() => location.hash);
  files.push(await shot(page, `${tag}-3-kraj`));
  await checkOverflow(page, `${tag} kraj ${kraj}`);

  // hover na kartu → zvýraznění pinu/shluku (jen desktop)
  if (!vp.isMobile) {
    await page.locator('#cards .card').first().hover();
    const hl = await page.locator('.pin.is-hl, .cluster.is-hl').count();
    if (!hl) problem(tag, 'najetí na kartu nezvýraznilo pin ani shluk');
  }

  // filtry: jen výhodné
  const before = await page.locator('#result-count').textContent();
  const ft = page.locator('.toolbar [aria-controls="filters"]');
  if ((await ft.getAttribute('aria-expanded')) !== 'true') await ft.click();
  await page.locator('label.toggle', { hasText: 'Jen výhodné' }).click();
  await page.waitForTimeout(400);
  const after = await page.locator('#result-count').textContent();
  if (before === after) problem(tag, `filtr „Jen výhodné“ nezměnil počet (${before})`);
  if (vp.name === 'desktop' || scheme === 'light') files.push(await shot(page, `${tag}-4-filtry`));
  await page.locator('label.toggle', { hasText: 'Jen výhodné' }).click();
  await page.waitForTimeout(300);
  await ft.click();

  // detail inzerátu
  await page.locator('#cards .card').first().click();
  await page.waitForSelector('#detail:not([hidden]) #detail-title', { timeout: 10000 });
  await page.waitForTimeout(900);
  const sel = await page.locator('.pin.is-selected').count();
  if (!sel) problem(tag, 'po otevření detailu není na mapě vybraný pin');
  files.push(await shot(page, `${tag}-5-detail`));
  const href = await page.locator('.detail__foot a').getAttribute('href');
  if (!/^https?:\/\//.test(href || '')) problem(tag, `odkaz na inzerát není http(s): ${href}`);
  if (vp.isMobile && scheme === 'light') {
    await page.locator('.detail__scroll').evaluate((e) => e.scrollTo(0, e.scrollHeight));
    await page.waitForTimeout(200);
    files.push(await shot(page, `${tag}-6-detail-konec`));
  }
  await page.keyboard.press('Escape');
  await page.waitForSelector('#detail[hidden]', { state: 'attached' });

  // zpět na celou ČR a otevření nejvýhodnější nabídky z přehledu
  await page.locator('.phead .back').click();
  await page.waitForSelector('.tabs');
  const top = page.locator('#tabpanel .card').first();
  if (await top.count()) {
    await top.click();
    await page.waitForSelector('#detail:not([hidden]) #detail-title', { timeout: 10000 });
    await page.waitForTimeout(600);
    if (vp.name === 'desktop' && scheme === 'light') files.push(await shot(page, `${tag}-7-top-detail`));
  }
  await ctx.close();
  return files;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const pw = loadPlaywright();
  let server = null;
  let base = typeof args.url === 'string' ? args.url.replace(/\/+$/, '') : null;
  if (!base) {
    server = await startLocalServer();
    base = server.url;
  }
  const browser = await pw.chromium.launch({ headless: !args.headed, executablePath: browserPath() });
  const files = [];
  try {
    for (const vp of VIEWPORTS) {
      for (const scheme of SCHEMES) {
        try {
          files.push(...(await runScenario(browser, base, vp, scheme)));
        } catch (e) {
          problem(`${vp.name}-${scheme}`, `scénář selhal: ${e.message.split('\n')[0]}`);
        }
      }
    }
  } finally {
    await browser.close();
    if (server) await server.stop();
  }
  console.log(`Snímky (${files.length}) v ${OUT}:`);
  for (const f of files) console.log('  ' + f);
  if (problems.length) {
    console.log(`\nNalezené problémy (${problems.length}):`);
    for (const p of problems) console.log('  - ' + p);
    return 1;
  }
  console.log('\nBez problémů.');
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(e);
      process.exitCode = 1;
    }
  );
}
