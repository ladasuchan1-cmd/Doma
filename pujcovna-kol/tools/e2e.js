'use strict';
// E2E průchod dema v prohlížeči (SPEC kap. 2 a 17.8): Playwright z GLOBÁLNÍ instalace (projekt má 0 npm závislostí),
// Chromium z PLAYWRIGHT_BROWSERS_PATH. Spustí server na volném portu s dočasnými daty + demo daty, pro každé téma
// (?design=outdoor|sport|family) projde veřejné stránky a rezervační tok, loguje chyby konzole prohlížeče, chyby
// stránky (pageerror), porušení CSP (securitypolicyviolation), odpovědi 5xx a nerozvinuté {{…}} v HTML; screenshoty
// ukládá do dist/screenshots/<tema>-<stranka>.png (dist/ není v gitu). Chybějící routa (404) = varování a přeskočení.
//
//   node --disable-warning=ExperimentalWarning tools/e2e.js                 (npm run e2e)
//   … --design=sport            jen jedno téma
//   … --url=http://host:port    netestovat vlastní server, ale běžící (demo data musí mít)
//   … --out=dist/screenshots    kam ukládat screenshoty
//   … --bez-rezervace           přeskočit rezervační tok
//   … --mapa                    kliknout i na „Načíst mapu“ (externí dlaždice – vyžaduje síť)
// Prostředí: PLAYWRIGHT_BROWSERS_PATH (adresář s chromium-*), PK_E2E_CHROME (přímá cesta k binárce), PK_E2E_TIMEOUT (ms).
// Výstup: souhrn do konzole; exit 0 bez chyb, 1 při chybách, 2 když Playwright nebo prohlížeč chybí.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'dist', 'screenshots');
const TIMEOUT = Number(process.env.PK_E2E_TIMEOUT) || 30000;
const VIEWPORT = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };

// Veřejné stránky (SPEC kap. 8). name = část názvu souboru screenshotu.
const PAGES = [
  { path: '/', name: 'home' },
  { path: '/kola', name: 'kola' },
  { path: '/cenik', name: 'cenik' },
  { path: '/kontakt', name: 'kontakt' },
  { path: '/design', name: 'design' },
  { path: '/podminky', name: 'podminky' },
  { path: '/soukromi', name: 'soukromi' },
  { path: '/reklamace', name: 'reklamace' },
  { path: '/mapa', name: 'mapa' },
  { path: '/okoli', name: 'okoli' },
];

// ---------------------------------------------------------------------------------------------------------
// Argumenty a pomocníci

function parseArgs(argv) {
  const args = { design: null, url: null, out: DEFAULT_OUT, reservation: true, mapa: false };
  for (const a of argv) {
    if (a.startsWith('--design=')) args.design = a.slice(9);
    else if (a.startsWith('--url=')) args.url = a.slice(6).replace(/\/$/, '');
    else if (a.startsWith('--out=')) args.out = path.resolve(ROOT, a.slice(6));
    else if (a === '--bez-rezervace') args.reservation = false;
    else if (a === '--mapa') args.mapa = true;
    else if (a === '--help' || a === '-h') {
      console.log('Použití: node tools/e2e.js [--design=outdoor|sport|family] [--url=http://host:port] [--out=dist/screenshots] [--bez-rezervace] [--mapa]');
      process.exit(0);
    } else {
      console.error(`Neznámý argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

/** Playwright z globální instalace: require('playwright'), pak NODE_PATH, pak `npm root -g`. */
function loadPlaywright() {
  const candidates = ['playwright'];
  for (const p of String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)) candidates.push(path.join(p, 'playwright'));
  try {
    candidates.push(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'playwright'));
  } catch {
    /* npm není – zkusíme ostatní */
  }
  for (const c of candidates) {
    try {
      // eslint-disable-next-line global-require
      return require(c);
    } catch (e) {
      if (!e || e.code !== 'MODULE_NOT_FOUND') throw e;
    }
  }
  throw new Error('Playwright není k dispozici. Nainstalujte globálně: npm i -g playwright && npx playwright install chromium (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers).');
}

/** Cesta k Chromiu: PK_E2E_CHROME → Playwright executablePath() → hledání v PLAYWRIGHT_BROWSERS_PATH. */
function findChromium(pw) {
  const direct = process.env.PK_E2E_CHROME;
  if (direct && fs.existsSync(direct)) return direct;
  try {
    const p = pw.chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* pokračujeme hledáním */
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && fs.existsSync(root)) {
    const dirs = fs
      .readdirSync(root)
      .filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d))
      // plné Chromium před headless shellem, vyšší revize dřív
      .sort((a, b) => (a.includes('headless') ? 1 : 0) - (b.includes('headless') ? 1 : 0) || Number(b.replace(/\D/g, '')) - Number(a.replace(/\D/g, '')));
    const rel = ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe'];
    for (const d of dirs) {
      for (const r of rel) {
        const p = path.join(root, d, r);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Datum vyzvednutí: za 7 dní; vyhne se vánočním zavíracím dnům z demo dat (24.–26. 12.). */
function pickDates() {
  const from = new Date();
  from.setUTCHours(12, 0, 0, 0);
  from.setUTCDate(from.getUTCDate() + 7);
  if (from.getUTCMonth() === 11 && from.getUTCDate() >= 23 && from.getUTCDate() <= 27) from.setUTCDate(from.getUTCDate() + 7);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 1);
  return { od: isoDate(from), do: isoDate(to) };
}

function slug(p) {
  return p.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'home';
}

// ---------------------------------------------------------------------------------------------------------
// Server s dočasnými daty a demo daty

async function startServer() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-e2e-'));
  const dataDir = path.join(base, 'data');
  const tenantsDir = path.join(base, 'tenants');
  copyDir(path.join(ROOT, 'tenants', 'demo'), path.join(tenantsDir, 'demo'));
  const env = {
    PK_DATA: dataDir,
    PK_TENANTS: tenantsDir,
    PK_DEMO: '1',
    PK_TRUST_PROXY: '0',
    PK_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0123456789',
    PK_RESET_DEMO_HOUR: '',
    APP_VERSION: 'e2e',
    LOG_LEVEL: process.env.LOG_LEVEL || 'warn',
    MAPY_API_KEY: process.env.MAPY_API_KEY || '',
  };
  // eslint-disable-next-line global-require
  const { createLogger } = require('../src/log');
  const log = createLogger({ level: env.LOG_LEVEL });
  // eslint-disable-next-line global-require
  const { start } = require('../server');
  const instance = await start({ env, port: 0, host: '127.0.0.1', quiet: true, log, startJobs: false });
  // eslint-disable-next-line global-require
  const demoData = require('./demo-data');
  const tenant = instance.tenants.find((t) => t.slug === 'demo');
  await demoData.seed({ db: instance.dbs.get('demo'), tenant, config: instance.config, fieldCrypto: instance.fieldCrypto, reset: true, log });
  return {
    url: instance.url,
    async stop() {
      await instance.stop();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Sběr problémů na stránce

/** Zapojí posluchače na kontext: konzole, pageerror, selhané požadavky, 5xx, CSP (přes exposeBinding). */
function attachCollectors(context, baseUrl, sink) {
  context.on('page', (page) => {
    page.on('console', (msg) => {
      const type = msg.type();
      if (type !== 'error' && type !== 'warning') return;
      const text = msg.text();
      const loc = msg.location && msg.location();
      const where = loc && loc.url ? ` (${loc.url}${loc.lineNumber ? ':' + loc.lineNumber : ''})` : '';
      if (/Content Security Policy/i.test(text)) {
        sink.csp(`konzole: ${text}${where}`);
      } else if (/Failed to load resource/i.test(text)) {
        // chybějící soubor (typicky 404 obrázku) – evidujeme zvlášť, URL je v location
        sink.missing(`${loc && loc.url ? loc.url : '?'} – ${text}`);
      } else if (type === 'error') {
        sink.error(`konzole: ${text}${where}`);
      } else {
        sink.warn(`konzole (warning): ${text}${where}`);
      }
    });
    page.on('pageerror', (err) => sink.error(`pageerror: ${err && err.message ? err.message : err}`));
    page.on('requestfailed', (req) => {
      const u = req.url();
      const why = (req.failure() && req.failure().errorText) || '';
      if (/net::ERR_ABORTED/.test(why)) return; // přerušené navigací
      if (u.startsWith(baseUrl)) sink.error(`požadavek selhal: ${u} ${why}`);
      else sink.warn(`externí požadavek selhal: ${u} ${why}`);
    });
    page.on('response', (res) => {
      const u = res.url();
      if (!u.startsWith(baseUrl)) return;
      const status = res.status();
      if (status >= 500) sink.error(`HTTP ${status} ${u}`);
      else if (status === 404 && res.request().resourceType() !== 'document') sink.missing(`HTTP 404 ${u}`);
    });
  });
}

async function installCspProbe(context, sink) {
  await context.exposeBinding('__pkCspViolation', (_source, info) => {
    sink.csp(`${info.directive}: blokováno ${info.blocked || '(inline)'}${info.source ? ` v ${info.source}:${info.line}` : ''}`);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__pkCspViolation({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber });
    });
  });
}

/** Sběrač problémů per téma; `scope` říká, ke které stránce se právě hlásí. */
function createSink(theme) {
  const items = [];
  let scope = '';
  const push = (kind, text) => {
    const key = `${kind}|${scope}|${text}`;
    if (items.some((i) => i.key === key)) return;
    items.push({ key, kind, scope, text, theme });
  };
  return {
    setScope: (s) => {
      scope = s;
    },
    error: (t) => push('chyba', t),
    csp: (t) => push('csp', t),
    warn: (t) => push('varování', t),
    missing: (t) => push('chybí', t),
    items,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Průchod

async function settle(page) {
  await page.waitForLoadState('load', { timeout: TIMEOUT }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  try {
    await page.evaluate(() => (document.fonts && document.fonts.ready ? document.fonts.ready : null));
  } catch {
    /* není kritické */
  }
}

async function checkDocument(page, theme, sink, label) {
  const html = await page.content();
  const unexpanded = html.match(/\{\{[^{}]{1,60}\}\}/g);
  if (unexpanded) sink.error(`${label}: nerozvinuté šablony ${[...new Set(unexpanded)].slice(0, 5).join(', ')}`);
  const actual = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  if (actual !== theme) sink.error(`${label}: <html data-theme="${actual}">, očekáváno „${theme}“`);
  const title = await page.title();
  if (!title) sink.warn(`${label}: stránka nemá <title>`);
  const h1 = await page.locator('h1').count();
  if (h1 !== 1) sink.warn(`${label}: počet <h1> = ${h1}`);
}

function withDesign(p, theme) {
  return `${p}${p.includes('?') ? '&' : '?'}design=${theme}`;
}

/**
 * Projde jednu stránku: navigace, kontroly, screenshot. Vrací 'ok' | 'chybí' | 'chyba'.
 */
async function visit(page, { baseUrl, theme, out, sink, p, name, viewportTag = '' }) {
  const label = `${theme} ${p}`;
  sink.setScope(p);
  let res;
  try {
    res = await page.goto(baseUrl + withDesign(p, theme), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  } catch (e) {
    sink.error(`${label}: navigace selhala – ${e.message}`);
    return 'chyba';
  }
  const status = res ? res.status() : 0;
  if (status === 404) {
    sink.warn(`${label}: routa neexistuje (404) – přeskočeno`);
    return 'chybí';
  }
  if (status >= 400) {
    sink.error(`${label}: HTTP ${status}`);
    return 'chyba';
  }
  await settle(page);
  await checkDocument(page, theme, sink, label);
  const file = path.join(out, `${theme}-${name}${viewportTag}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return 'ok';
}

/** Volitelně klikne na „Načíst mapu“ a počká na dlaždice (externí síť). */
async function loadMap(page, sink) {
  const btn = page.getByRole('button', { name: /načíst mapu/i }).first();
  if (!(await btn.count())) return;
  await btn.click({ timeout: 5000 }).catch((e) => sink.warn(`mapa: klik na „Načíst mapu“ selhal – ${e.message}`));
  await page.waitForTimeout(4000);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
}

/** Rezervační tok: termín → kola → údaje → poplatek (demo simulace) → hotovo → správa → storno. */
async function reservationFlow(page, { baseUrl, theme, out, sink }) {
  const shoot = (name) => page.screenshot({ path: path.join(out, `${theme}-${name}.png`), fullPage: true });
  const expectPath = async (re, step) => {
    await page.waitForURL(re, { timeout: TIMEOUT });
    const status = await page.evaluate(() => document.readyState);
    if (!status) throw new Error(`${step}: stránka se nenačetla`);
  };
  sink.setScope('/rezervace');
  const res = await page.goto(baseUrl + withDesign('/rezervace', theme), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  if (!res || res.status() === 404) {
    sink.warn(`${theme} /rezervace: routa neexistuje – rezervační tok přeskočen`);
    return 'chybí';
  }
  if (res.status() >= 400) {
    sink.error(`${theme} /rezervace: HTTP ${res.status()}`);
    return 'chyba';
  }
  await settle(page);
  await checkDocument(page, theme, sink, `${theme} /rezervace`);
  await shoot('rezervace-termin');

  // krok 1 – termín: fallback <input type=date> schovává kalendář, hodnoty nastavíme přímo (formulář je bere)
  const dates = pickDates();
  const hasDateInputs = (await page.locator('input[type="date"][name="od"]').count()) > 0 && (await page.locator('input[type="date"][name="do"]').count()) > 0;
  if (!hasDateInputs) {
    sink.warn(`${theme} /rezervace: formulář termínu nemá pole od/do – rezervační tok přeskočen`);
    return 'chybí';
  }
  await page.evaluate((d) => {
    const set = (name, value) => {
      const el = document.querySelector(`input[type="date"][name="${name}"]`);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('od', d.od);
    set('do', d.do);
  }, dates);
  for (const [name, value] of [
    ['od_cas', '09:00'],
    ['do_cas', '17:00'],
  ]) {
    const sel = page.locator(`select[name="${name}"]`);
    if (await sel.count()) await sel.selectOption(value).catch(() => sink.warn(`${theme} /rezervace: čas ${name}=${value} není v nabídce`));
  }
  await page.locator('form[data-term-form] button[type="submit"], form[action="/rezervace"] button[type="submit"]').first().click({ timeout: TIMEOUT });
  await expectPath(/\/rezervace\/kola/, 'krok 2');
  await settle(page);
  sink.setScope('/rezervace/kola');
  await checkDocument(page, theme, sink, `${theme} /rezervace/kola`);
  await shoot('rezervace-kola');

  // krok 2 – první volná velikost
  const qty = page.locator('input.bike-pick__qty:not([disabled]), input[name^="qty_"]:not([disabled])').first();
  if (!(await qty.count())) throw new Error('krok 2: žádné kolo není v termínu volné');
  await qty.fill('1');
  await page.locator('form[data-bike-form] button[type="submit"], form[action="/rezervace/kola"] button[type="submit"]').first().click({ timeout: TIMEOUT });
  await expectPath(/\/rezervace\/udaje/, 'krok 3');
  await settle(page);
  sink.setScope('/rezervace/udaje');
  await checkDocument(page, theme, sink, `${theme} /rezervace/udaje`);

  // krok 3 – údaje + povinné souhlasy (tlačítko je bez souhlasů zakázané)
  await page.fill('input[name="jmeno"]', 'Eva Testovací');
  await page.fill('input[name="email"]', 'e2e@example.com');
  await page.fill('input[name="telefon"]', '+420 777 123 456');
  await page.check('input[name="souhlas_op"]');
  await page.check('input[name="souhlas_doklad"]');
  await shoot('rezervace-udaje');
  await page.locator('form[action="/rezervace/udaje"] button[type="submit"]').first().click({ timeout: TIMEOUT });
  await expectPath(/\/rezervace\/poplatek/, 'krok 4');
  await settle(page);
  sink.setScope('/rezervace/poplatek');
  await checkDocument(page, theme, sink, `${theme} /rezervace/poplatek`);
  await shoot('rezervace-poplatek');

  // krok 4 – v demu simulace zaplacení, jinak převod (zobrazí údaje k platbě)
  const demoForm = page.locator('form').filter({ has: page.locator('input[name="metoda"][value="demo"]') });
  const prevodForm = page.locator('form').filter({ has: page.locator('input[name="metoda"][value="prevod"]') });
  if (await demoForm.count()) {
    await demoForm.locator('button[type="submit"]').first().click({ timeout: TIMEOUT });
    await expectPath(/\/rezervace\/hotovo\//, 'krok 5');
  } else if (await prevodForm.count()) {
    sink.warn(`${theme} /rezervace/poplatek: simulace platby není k dispozici – volím převod`);
    await prevodForm.locator('button[type="submit"]').first().click({ timeout: TIMEOUT });
    await settle(page);
    await shoot('rezervace-prevod');
    const link = page.locator('a[href^="/rezervace/hotovo/"]').first();
    if (!(await link.count())) throw new Error('krok 4: po převodu chybí odkaz na potvrzení');
    await link.click({ timeout: TIMEOUT });
    await expectPath(/\/rezervace\/hotovo\//, 'krok 5');
  } else {
    throw new Error('krok 4: žádná dostupná metoda platby (demo/prevod)');
  }
  await settle(page);
  sink.setScope('/rezervace/hotovo');
  await checkDocument(page, theme, sink, `${theme} /rezervace/hotovo`);
  await shoot('rezervace-hotovo');

  // správa rezervace: odkaz s textem „správa/správu rezervace“, jinak href tvaru /rezervace/<token> (ne kroky, ne ICS)
  const manageHref = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href^="/rezervace/"]')];
    const byText = links.find((a) => /správ[ua] rezervace/i.test(a.textContent || ''));
    const byToken = links.find((a) => /^\/rezervace\/[A-Za-z0-9_.~-]{16,}$/.test(a.getAttribute('href') || ''));
    const a = byText || byToken;
    return a ? a.getAttribute('href') : null;
  });
  if (!manageHref) throw new Error('krok 5: chybí odkaz na správu rezervace');
  await page.goto(baseUrl + manageHref, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  if (!/^\/rezervace\/[^/]+$/.test(new URL(page.url()).pathname)) throw new Error(`správa rezervace: nečekaná adresa ${page.url()}`);
  await settle(page);
  sink.setScope('/rezervace/:token');
  await checkDocument(page, theme, sink, `${theme} /rezervace/:token`);
  await shoot('rezervace-sprava');

  // storno s výpočtem (48 h pravidlo) – rezervace je za 7 dní, tedy plná vratka
  const confirm = page.locator('input[name="potvrdit"]');
  if (await confirm.count()) {
    await confirm.check();
    const stornoForm = page.locator('form').filter({ has: confirm });
    await stornoForm.locator('button[type="submit"]').first().click({ timeout: TIMEOUT });
    await page.waitForLoadState('domcontentloaded', { timeout: TIMEOUT }).catch(() => {});
    await settle(page);
    await shoot('rezervace-storno');
    const text = await page.locator('body').innerText();
    if (!/zrušen/i.test(text)) sink.warn(`${theme} storno: na stránce po stornu není potvrzení o zrušení`);
  } else {
    sink.warn(`${theme} /rezervace/:token: formulář storna chybí`);
  }
  return 'ok';
}

async function runTheme(browser, pw, theme, { baseUrl, out, args }) {
  const sink = createSink(theme);
  const context = await browser.newContext({ viewport: VIEWPORT, locale: 'cs-CZ', timezoneId: 'Europe/Prague', ignoreHTTPSErrors: true });
  attachCollectors(context, baseUrl, sink);
  await installCspProbe(context, sink);
  const page = await context.newPage();
  const results = [];

  // přepínač designu (cookie) – ověří /design/nastavit
  sink.setScope('/design/nastavit');
  const sw = await page.goto(`${baseUrl}/design/nastavit?design=${theme}&zpet=/`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT }).catch(() => null);
  if (!sw || sw.status() >= 400) sink.warn(`${theme}: /design/nastavit nedostupné (${sw ? sw.status() : 'bez odpovědi'}) – téma se nastaví jen přes ?design=`);

  for (const pg of PAGES) {
    const r = await visit(page, { baseUrl, theme, out, sink, p: pg.path, name: pg.name });
    results.push({ path: pg.path, result: r });
    if (pg.path === '/mapa' && r === 'ok' && args.mapa) {
      await loadMap(page, sink);
      await page.screenshot({ path: path.join(out, `${theme}-mapa-nactena.png`), fullPage: true });
    }
  }

  // detail prvního kola z katalogu
  sink.setScope('/kola');
  const list = await page.goto(baseUrl + withDesign('/kola', theme), { waitUntil: 'domcontentloaded', timeout: TIMEOUT }).catch(() => null);
  if (list && list.status() === 200) {
    const href = await page.locator('a[href^="/kola/"]').first().getAttribute('href').catch(() => null);
    if (href) {
      const clean = href.split('?')[0];
      results.push({ path: clean, result: await visit(page, { baseUrl, theme, out, sink, p: clean, name: 'kola-detail' }) });
    } else sink.warn(`${theme} /kola: žádný odkaz na detail kola`);
  }

  // rezervační tok
  if (args.reservation) {
    try {
      results.push({ path: '/rezervace (tok)', result: await reservationFlow(page, { baseUrl, theme, out, sink }) });
    } catch (e) {
      sink.error(`${theme} rezervační tok neprošel: ${e.message}`);
      await page.screenshot({ path: path.join(out, `${theme}-rezervace-chyba.png`), fullPage: true }).catch(() => {});
      results.push({ path: '/rezervace (tok)', result: 'chyba' });
    }
  }
  await context.close();

  // mobilní pohled domovské stránky
  const mobile = await browser.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true, locale: 'cs-CZ', timezoneId: 'Europe/Prague' });
  attachCollectors(mobile, baseUrl, sink);
  await installCspProbe(mobile, sink);
  const mpage = await mobile.newPage();
  results.push({ path: '/ (mobil)', result: await visit(mpage, { baseUrl, theme, out, sink, p: '/', name: 'home', viewportTag: '-mobil' }) });
  await mobile.close();

  return { theme, results, items: sink.items };
}

// ---------------------------------------------------------------------------------------------------------
// main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // eslint-disable-next-line global-require
  const { THEMES } = require('../src/themes');
  const themes = args.design ? [args.design] : Object.keys(THEMES);
  for (const t of themes) {
    if (!THEMES[t]) {
      console.error(`Neznámé téma „${t}“. Dostupná: ${Object.keys(THEMES).join(', ')}`);
      process.exit(2);
    }
  }

  let pw;
  try {
    pw = loadPlaywright();
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const executablePath = findChromium(pw);
  if (!executablePath) {
    console.error(`Chromium nenalezeno (PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH || '(nenastaveno)'}). Nainstalujte: npx playwright install chromium`);
    process.exit(2);
  }

  fs.mkdirSync(args.out, { recursive: true });
  let server = null;
  let baseUrl = args.url;
  if (!baseUrl) {
    server = await startServer();
    baseUrl = server.url;
  }
  console.log(`E2E: server ${baseUrl}, témata ${themes.join(', ')}, Chromium ${executablePath}, screenshoty → ${path.relative(ROOT, args.out) || '.'}`);

  const browser = await pw.chromium.launch({ executablePath, headless: true });
  const summary = [];
  try {
    for (const theme of themes) {
      const started = Date.now();
      const r = await runTheme(browser, pw, theme, { baseUrl, out: args.out, args });
      summary.push(r);
      const counts = { ok: 0, chybí: 0, chyba: 0 };
      for (const x of r.results) counts[x.result] = (counts[x.result] || 0) + 1;
      console.log(`\n[${theme}] ${counts.ok} OK, ${counts.chybí} chybějících rout, ${counts.chyba} chyb (${Math.round((Date.now() - started) / 100) / 10} s)`);
      for (const x of r.results) console.log(`  ${x.result === 'ok' ? '✓' : x.result === 'chybí' ? '–' : '✗'} ${x.path}`);
      const problems = r.items.filter((i) => i.kind !== 'varování' && i.kind !== 'chybí');
      const warnings = r.items.filter((i) => i.kind === 'varování');
      const missing = r.items.filter((i) => i.kind === 'chybí');
      for (const i of problems) console.log(`  ! ${i.kind.toUpperCase()} [${i.scope}] ${i.text}`);
      for (const i of missing) console.log(`  ? chybějící soubor [${i.scope}] ${i.text}`);
      for (const i of warnings) console.log(`  ~ ${i.text}`);
    }
  } finally {
    await browser.close().catch(() => {});
    if (server) await server.stop();
  }

  const allItems = summary.flatMap((s) => s.items);
  const errors = allItems.filter((i) => i.kind === 'chyba').length;
  const csp = allItems.filter((i) => i.kind === 'csp').length;
  const missing = allItems.filter((i) => i.kind === 'chybí').length;
  const warnings = allItems.filter((i) => i.kind === 'varování').length;
  const shots = fs.readdirSync(args.out).filter((f) => f.endsWith('.png')).length;
  console.log(`\nCelkem: ${errors} chyb, ${csp} porušení CSP, ${missing} chybějících souborů, ${warnings} varování; ${shots} screenshotů v ${path.relative(ROOT, args.out) || '.'}`);
  process.exitCode = errors + csp > 0 ? 1 : 0;
}

if (require.main === module) {
  main().catch((e) => {
    console.error('E2E selhalo:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

module.exports = { PAGES, loadPlaywright, findChromium, pickDates, parseArgs, slug };
