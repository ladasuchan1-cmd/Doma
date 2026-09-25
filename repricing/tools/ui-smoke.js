#!/usr/bin/env node
'use strict';
// Smoke test webového rozhraní přes Playwright (Chromium).
// Spustí mock server (tools/ui-mock-server.js) nebo použije --url, projde všechny stránky ve dvou velikostech
// (1366×850 a 390×844), udělá snímky obrazovky, vyzkouší klíčové interakce a ohlídá chyby v konzoli,
// porušení CSP, nezachycené výjimky, chyby API 5xx a vodorovné přetečení stránky na mobilu.
//
// Použití:
//   node tools/ui-smoke.js [--out=DIR] [--url=http://localhost:8080] [--password=demo] [--only=desktop|mobile|extensions] [--no-dark] [--headed]
// Playwright: require('playwright'), jinak PLAYWRIGHT_PATH, jinak /opt/node22/lib/node_modules/playwright.
// Návratový kód 1 = nalezeny chyby.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

function loadPlaywright() {
  const candidates = ['playwright', process.env.PLAYWRIGHT_PATH, '/opt/node22/lib/node_modules/playwright'].filter(Boolean);
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* další kandidát */
    }
  }
  throw new Error('Playwright nenalezen – nainstalujte ho nebo nastavte PLAYWRIGHT_PATH.');
}

const OUT = path.resolve(String(args.out || process.env.UI_SHOTS_DIR || path.join(os.tmpdir(), 'cenotvorba-ui-shots')));
const PASSWORD = String(args.password || 'demo');
const VIEWPORTS = [
  { name: 'desktop', width: 1366, height: 850 },
  { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
].filter((v) => !args.only || v.name === args.only);

const ROUTES = [
  '/prehled', '/produkty', '/produkty/1', '/navrhy', '/strategie', '/strategie/1', '/strategie/nova', '/segmenty', '/segmenty/1', '/segmenty/novy',
  '/konkurence', '/konkurence?tab=unmatched', '/import', '/import?tab=sources', '/import?tab=log', '/import?tab=api', '/export', '/nastaveni', '/nastaveni?tab=tokeny', '/nastaveni?tab=audit', '/neexistuje',
];

const CSV = [
  'EAN;Obchod;Cena s DPH;Doprava;Skladem;URL',
  '8599999000011;VeloMarket.cz;20 490 Kč;0;ano;https://velomarket.example/p/1',
  'NEEXISTUJE-1;KoloExpres.cz;1 290,-;99;ne;https://koloexpres.example/p/2',
  ';CykloSvět.cz;abc;;;',
].join('\n');

const problems = [];
function problem(vp, where, msg) {
  problems.push(`[${vp}] ${where}: ${msg}`);
}

function slug(route) {
  return route.replace(/^\//, '').replace(/[?=&/]+/g, '-').replace(/-+$/, '') || 'root';
}

async function waitReady(page, prevSeq, timeout = 15000) {
  await page.waitForFunction(
    (prev) => {
      const app = document.getElementById('app');
      const seq = Number(app?.dataset.renderSeq || 0);
      return seq > prev && app.dataset.ready === String(seq);
    },
    prevSeq,
    { timeout }
  );
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(120);
}

async function currentSeq(page) {
  return page.evaluate(() => Number(document.getElementById('app')?.dataset.renderSeq || 0));
}

async function go(page, base, route) {
  const prev = await currentSeq(page);
  await page.evaluate((hash) => {
    if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = hash;
  }, '#' + route);
  await waitReady(page, prev);
}

/** Provede akci a počká na odpověď API, která jí odpovídá (čekání se připraví předem – žádný závod). */
async function act(page, pred, action, timeout = 15000) {
  const [r] = await Promise.all([page.waitForResponse(pred, { timeout }), action()]);
  return r;
}

async function shot(page, name, full = true) {
  const file = path.join(OUT, name + '.png');
  if (!full) {
    await page.screenshot({ path: file });
    return file;
  }
  // celá stránka, ale nejvýš 2400 px (dlouhé seznamy na mobilu by byly nečitelné)
  const size = await page.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.scrollHeight }));
  await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: 0, width: size.w, height: Math.min(size.h, 2400) } });
  return file;
}

async function checkOverflow(page, vp, where, width) {
  // U isMobile Chromium při přetečení rozšíří layout viewport – porovnáváme proto s šířkou zařízení.
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  if (sw > width + 1) problem(vp, where, `vodorovné přetečení stránky (${sw}px > ${width}px)`);
}

let currentStep = '';
function step(name) {
  currentStep = name;
}

async function expectVisible(page, selector, vp, where, timeout = 5000) {
  try {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    problem(vp, where, 'nenalezen prvek ' + selector);
    return false;
  }
}

async function interactions(page, base, vp) {
  const W = (name) => 'interakce ' + name;
  // --- produkty: hledání, filtr výrobce, detail
  step('produkty');
  await go(page, base, '/produkty');
  await act(page, (x) => x.url().includes('/api/v1/products?') && x.url().includes('q=trek'), () => page.fill('#products-search', 'trek'));
  await page.waitForTimeout(200);
  const firstName = await page.locator('.dt tbody tr:first-child td:nth-child(2)').innerText().catch(() => '');
  if (!/trek/i.test(firstName)) problem(vp, W('produkty'), 'hledání „trek“ nevrátilo Trek (první řádek: ' + firstName + ')');
  if (vp === 'desktop') {
    await act(page, (x) => x.url().includes('/api/v1/products?') && x.url().includes('manufacturer=Trek'), () => page.selectOption('select[aria-label="Výrobce"]', 'Trek'));
    await page.waitForTimeout(150);
    await shot(page, vp + '-produkty-filtr');
    // pokročilý filtr
    await page.click('[data-action="advanced-filter"]');
    await expectVisible(page, '.fb', vp, W('pokročilý filtr'));
    await shot(page, vp + '-produkty-pokrocily-filtr');
  }
  const prev = await currentSeq(page);
  await page.locator('.dt tbody tr.is-clickable').first().click();
  await waitReady(page, prev);
  await expectVisible(page, '.product-title', vp, W('detail produktu'));
  await expectVisible(page, '[data-card="history"] svg', vp, W('graf historie'));
  if (vp === 'desktop') {
    // úprava min. ceny
    const minInput = page.locator('[data-card="product-settings"] input.input-num').first();
    await minInput.fill('1000');
    const pr = await act(page, (x) => x.request().method() === 'PATCH' && x.url().includes('/api/v1/products/'), () => page.click('[data-action="save-product"]'));
    if (pr.status() !== 200) problem(vp, W('uložení produktu'), 'PATCH vrátil ' + pr.status());
    await page.waitForTimeout(300);
    // hover na graf (tooltip)
    const plot = page.locator('[data-card="history"] .overlay').first();
    await plot.scrollIntoViewIfNeeded();
    const box = await plot.boundingBox();
    if (box) {
      await plot.hover({ position: { x: box.width * 0.7, y: box.height / 2 } });
      await page.waitForTimeout(150);
      await expectVisible(page, '.chart-tip:not([hidden])', vp, W('tooltip grafu'), 2000);
      await shot(page, vp + '-produkt-graf-tooltip', false);
    }
  }

  // --- návrhy: schválit řádek, hromadný výběr, schválit vše (Esc), rozbalení, ruční cena
  step('návrhy');
  await go(page, base, '/navrhy');
  let r = await act(page, (x) => x.url().includes('/api/v1/proposals/approve') && x.request().method() === 'POST', () => page.locator('[data-action="approve-row"]').first().click());
  if (r.status() !== 200) problem(vp, W('schválení návrhu'), 'POST approve ' + r.status());
  await expectVisible(page, '.toast-success', vp, W('toast po schválení'));
  await page.waitForTimeout(400);
  if (vp === 'desktop') {
    const boxes = page.locator('.dt tbody td.col-check input[type=checkbox]');
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await expectVisible(page, '.bulkbar:not([hidden])', vp, W('hromadná lišta'));
    await shot(page, vp + '-navrhy-vyber', false);
    r = await act(page, (x) => x.url().includes('/api/v1/proposals/approve'), () => page.click('[data-action="approve-selected"]'));
    const body = r.request().postDataJSON();
    if (!Array.isArray(body.ids) || body.ids.length !== 2) problem(vp, W('hromadné schválení'), 'očekávány 2 ids, posláno ' + JSON.stringify(body));
    await page.waitForTimeout(400);
    // schválit vše dle filtru → potvrzovací dialog s počtem → Esc zavře
    await page.click('[data-action="approve-all"]');
    await expectVisible(page, 'dialog[open]', vp, W('dialog schválit vše'));
    const dlgText = await page.locator('dialog[open]').innerText();
    if (!/\d/.test(dlgText)) problem(vp, W('dialog schválit vše'), 'dialog neobsahuje počet');
    await shot(page, vp + '-navrhy-schvalit-vse', false);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    if (await page.locator('dialog[open]').count()) problem(vp, W('Esc'), 'Esc nezavřel dialog');
    // rozbalení vysvětlení
    await page.locator('.expander').first().click();
    await expectVisible(page, '.dt-expand .steps-explain', vp, W('rozbalení vysvětlení'));
    // ruční cena
    await page.locator('.price-edit').first().click();
    const inp = page.locator('.inline-edit input');
    await inp.fill('12 345');
    r = await act(page, (x) => x.request().method() === 'PATCH' && x.url().includes('/api/v1/proposals/'), () => inp.press('Enter'));
    if (r.request().postDataJSON().manual_price !== 12345) problem(vp, W('ruční cena'), 'špatně odeslaná cena ' + r.request().postData());
    await page.waitForTimeout(250);
    await shot(page, vp + '-navrhy-po-akcich');
  }

  // --- strategie: úprava + simulace + uložení, přeřazení
  step('strategie');
  await go(page, base, '/strategie/1');
  const off = page.locator('input[data-path="target.offset_pct"]');
  await off.fill('-2');
  await page.waitForTimeout(100);
  const summary = await page.locator('.summary-text').innerText();
  if (!/2\s?%/.test(summary.replace(/ /g, ' '))) problem(vp, W('shrnutí strategie'), 'shrnutí nereaguje na změnu: ' + summary.slice(0, 120));
  step('strategie – simulace');
  r = await act(page, (x) => x.url().includes('/api/v1/simulate'), () => page.click('[data-action="simulate"]'));
  if (r.status() !== 200) problem(vp, W('simulace'), 'POST simulate ' + r.status());
  await expectVisible(page, '[data-card="simulation"] .kpi', vp, W('výsledek simulace'));
  await page.waitForTimeout(300);
  await shot(page, vp + '-strategie-simulace');
  step('strategie – uložení');
  r = await act(page, (x) => x.url().includes('/api/v1/strategies/1') && x.request().method() === 'PUT', () => page.click('[data-action="save-strategy"]'));
  if (r.status() !== 200) problem(vp, W('uložení strategie'), 'PUT ' + r.status());
  if (vp === 'desktop') {
    await go(page, base, '/strategie');
    r = await act(page, (x) => x.url().includes('/api/v1/strategies/reorder'), () => page.locator('[data-move="down"]').first().click());
    if (r.status() !== 200) problem(vp, W('přeřazení'), 'reorder ' + r.status());
    await page.waitForTimeout(300);
  }

  // --- segment s vnořenou skupinou
  step('segment');
  await go(page, base, '/segmenty/novy');
  await page.fill('input[data-field="name"]', 'Test – Trek levné');
  await page.click('.fb-group.depth-0 > .fb-group-head [data-action="add-cond"]');
  let cond = page.locator('.fb-cond').last();
  await cond.locator('.fb-field').selectOption('manufacturer');
  await cond.locator('.fb-op').selectOption('in');
  const chipsInputEl = cond.locator('.chips-input');
  await chipsInputEl.fill('Trek');
  await chipsInputEl.press('Enter');
  await page.click('.fb-group.depth-0 > .fb-group-head [data-action="add-group"]');
  cond = page.locator('.fb-group.depth-1 .fb-cond').last();
  await cond.locator('.fb-field').selectOption('margin_pct');
  await cond.locator('.fb-op').selectOption('>=');
  await cond.locator('input.fb-value').fill('10');
  await page.click('.fb-group.depth-1 > .fb-group-head [data-action="add-cond"]');
  cond = page.locator('.fb-group.depth-1 .fb-cond').last();
  await cond.locator('.fb-field').selectOption('position');
  await cond.locator('.fb-op').selectOption('=');
  await act(page, (x) => x.url().includes('/api/v1/segments/preview'), () => cond.locator('select.fb-value').selectOption('cheapest'));
  await page.waitForTimeout(500);
  const sumText = await page.locator('.fb-summary').innerText();
  if (!/Výrobce/.test(sumText) || !/nebo/.test(sumText)) problem(vp, W('popis filtru'), sumText);
  await shot(page, vp + '-segment-vnoreny');
  r = await act(page, (x) => x.url().endsWith('/api/v1/segments') && x.request().method() === 'POST', () => page.click('[data-action="save-segment"]'));
  const saved = r.request().postDataJSON();
  if (!saved.filter?.all || !saved.filter.all.some((x) => x.any)) problem(vp, W('uložení segmentu'), 'filtr bez vnořené skupiny: ' + JSON.stringify(saved.filter));
  await page.waitForTimeout(400);

  // --- import CSV
  step('import');
  await go(page, base, '/import');
  r = await act(page, (x) => x.url().includes('/api/v1/import/preview'), () => page.setInputFiles('#import-file', { name: 'ceny-konkurence.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf8') }));
  if (r.status() !== 200) problem(vp, W('náhled importu'), 'preview ' + r.status());
  if (r.request().headers()['content-type'] !== 'text/csv') problem(vp, W('náhled importu'), 'Content-Type ' + r.request().headers()['content-type']);
  await expectVisible(page, '[data-card="mapping"]', vp, W('mapování'));
  const mappedEan = await page.locator('select[data-canonical="ean"]').inputValue();
  if (mappedEan !== 'EAN') problem(vp, W('návrh mapování'), 'EAN namapován na „' + mappedEan + '“');
  await page.selectOption('select[data-canonical="shipping"]', 'Doprava');
  await page.waitForTimeout(800);
  await shot(page, vp + '-import-mapovani');
  r = await act(page, (x) => x.url().includes('/api/v1/import/offers') && x.url().includes('dry_run=1'), () => page.click('[data-action="dry-run"]'));
  if (r.status() !== 200) problem(vp, W('zkušební import'), r.status());
  await page.waitForTimeout(300);
  r = await act(page, (x) => x.url().includes('/api/v1/import/offers') && !x.url().includes('dry_run'), () => page.click('[data-action="import"]'));
  if (r.status() !== 200) problem(vp, W('import'), r.status());
  await expectVisible(page, '[data-card="import-result"]', vp, W('výsledek importu'));
  await shot(page, vp + '-import-vysledek');
  if (vp === 'desktop') {
    await page.click('[data-action="open-save-source"]');
    await expectVisible(page, 'dialog[open]', vp, W('uložit zdroj'));
    r = await act(page, (x) => x.url().endsWith('/api/v1/sources') && x.request().method() === 'POST', () => page.click('[data-action="save-source"]'));
    if (r.status() !== 200) problem(vp, W('uložit zdroj'), r.status());
    await page.waitForTimeout(300);
  }

  // --- konkurence: vypnutí konkurenta, ruční spárování nabídky
  step('konkurence');
  if (vp === 'desktop') {
    await go(page, base, '/konkurence');
    r = await act(page, (x) => x.request().method() === 'PATCH' && x.url().includes('/api/v1/competitors/'), () => page.locator('.dt tbody [role=switch]').first().click());
    if (r.request().postDataJSON().enabled === undefined) problem(vp, W('konkurent'), 'PATCH bez enabled');
    await go(page, base, '/konkurence?tab=unmatched');
    await page.locator('[data-action="match"]').first().click();
    await expectVisible(page, 'dialog[open] input[type=search]', vp, W('dialog párování'));
    await act(page, (x) => x.url().includes('/api/v1/products?') && x.url().includes('q=trek'), () => page.locator('dialog[open] input[type=search]').fill('trek'));
    await expectVisible(page, 'dialog[open] .match-item', vp, W('výsledky hledání produktu'));
    await page.locator('dialog[open] .match-item').first().click();
    r = await act(page, (x) => x.url().includes('/match') && x.request().method() === 'POST', () => page.click('dialog[open] [data-action="confirm-match"]'));
    if (!r.request().postDataJSON().product_id) problem(vp, W('spárování'), 'chybí product_id');
    await page.waitForTimeout(300);
    await shot(page, vp + '-konkurence-sparovano', false);
  }

  // --- tokeny
  step('tokeny');
  if (vp === 'desktop') {
    await go(page, base, '/nastaveni?tab=tokeny');
    await page.fill('input[placeholder^="Např. Admin"]', 'Smoke test');
    await act(page, (x) => x.url().endsWith('/api/v1/tokens') && x.request().method() === 'POST', () => page.click('[data-action="create-token"]'));
    await expectVisible(page, '[data-role="new-token"]', vp, W('nový token'));
    const tok = await page.locator('[data-role="new-token"] input').first().inputValue();
    if (!/^ct_[A-Za-z0-9]{32}$/.test(tok)) problem(vp, W('nový token'), 'neplatný token ' + tok);
    await shot(page, vp + '-token', false);
    await page.locator('dialog[open] .modal-foot .btn-primary').click();
  }

  // --- globální přecenění
  step('přecenění');
  await go(page, base, '/prehled');
  await page.click('[data-action="run-pricing"]');
  await expectVisible(page, 'dialog[open] [data-confirm]', vp, W('potvrzení přecenění'));
  r = await act(page, (x) => x.url().endsWith('/api/v1/runs') && x.request().method() === 'POST', () => page.click('dialog[open] [data-confirm]'));
  if (r.status() !== 200) problem(vp, W('přecenění'), r.status());
  await expectVisible(page, 'dialog[open] .run-stats', vp, W('výsledek přecenění'));
  await page.waitForTimeout(250);
  await shot(page, vp + '-preceneni-vysledek', false);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  if (await page.locator('dialog[open]').count()) problem(vp, W('Esc'), 'Esc nezavřel dialog výsledku');

  // --- mobilní menu
  step('mobilní menu');
  if (vp === 'mobile') {
    await page.click('.menu-toggle');
    await page.waitForTimeout(300);
    await shot(page, vp + '-menu', false);
    const prevSeq = await currentSeq(page);
    await page.click('.sidebar a[data-nav="/navrhy"]');
    await waitReady(page, prevSeq);
    const open = await page.evaluate(() => document.querySelector('.app').classList.contains('nav-open'));
    if (open) problem(vp, W('mobilní menu'), 'menu zůstalo otevřené po navigaci');
  }
}

async function runViewport(browser, base, vp, colorScheme = 'light') {
  const label = vp.name + (colorScheme === 'dark' ? '-dark' : '');
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, isMobile: Boolean(vp.isMobile), hasTouch: Boolean(vp.hasTouch), colorScheme, locale: 'cs-CZ', timezoneId: 'Europe/Prague' });
  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.text();
    // 401 u /auth/me a špatného hesla je očekávané chování (prohlížeč ho loguje jako chybu zdroje)
    if (/status of 401/.test(t)) return;
    if (m.type() === 'error' || /Content[- ]Security[- ]Policy|Refused to/i.test(t)) problem(label, 'konzole', t);
  });
  page.on('pageerror', (e) => problem(label, 'výjimka', e.message));
  page.on('response', (r) => {
    if (r.status() >= 500) problem(label, 'API', r.status() + ' ' + r.url());
  });
  page.on('requestfailed', (req) => {
    const f = req.failure()?.errorText || '';
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(f)) problem(label, 'síť', f + ' ' + req.url());
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error('CSP violation: ' + e.violatedDirective + ' ' + e.blockedURI));
  });

  // přihlášení
  await page.goto(base + '/#/prehled');
  await page.waitForSelector('[data-view="login"]', { timeout: 10000 });
  await shot(page, label + '-login', false);
  await page.fill('#login-password', 'spatne-heslo');
  await page.click('.login-card button[type=submit]');
  await page.waitForFunction(() => /Nesprávné/.test(document.querySelector('.login-error')?.textContent || ''), null, { timeout: 5000 }).catch(() => problem(label, 'přihlášení', 'chybí hláška o špatném hesle'));
  const prev = await currentSeq(page);
  await page.fill('#login-password', PASSWORD);
  await page.click('.login-card button[type=submit]');
  await waitReady(page, prev);
  if (!(await page.locator('.sidebar').count())) problem(label, 'přihlášení', 'po přihlášení se nezobrazila aplikace');

  const routes = colorScheme === 'dark' ? ['/prehled', '/produkty/1', '/navrhy', '/strategie/1', '/segmenty/1', '/import'] : ROUTES;
  for (const route of routes) {
    try {
      await go(page, base, route);
    } catch (e) {
      problem(label, route, 'stránka se nenačetla: ' + e.message.split('\n')[0]);
      continue;
    }
    if (vp.isMobile) await checkOverflow(page, label, route, vp.width);
    const err = await page.locator('.empty-error').count();
    if (err && route !== '/neexistuje') problem(label, route, 'zobrazen chybový stav');
    await shot(page, label + '-' + slug(route));
  }
  if (colorScheme === 'light') {
    try {
      await interactions(page, base, vp.name);
    } catch (e) {
      problem(label, 'interakce „' + currentStep + '“', e.message.split('\n')[0]);
      await shot(page, label + '-CHYBA-interakce').catch(() => {});
    }
  }
  await context.close();
}

async function runExtensions(browser, base) {
  const label = 'rozšíření';
  const context = await browser.newContext({ viewport: { width: 1366, height: 850 }, locale: 'cs-CZ' });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (/status of 401/.test(m.text())) return;
    if (m.type() === 'error') problem(label, 'konzole', m.text());
  });
  page.on('pageerror', (e) => problem(label, 'výjimka', e.message));
  await page.goto(base + '/#/strategie/nova');
  await page.waitForSelector('[data-view="login"]');
  const prev = await currentSeq(page);
  await page.fill('#login-password', PASSWORD);
  await page.click('.login-card button[type=submit]');
  await waitReady(page, prev);
  await expectVisible(page, '[data-section="schedule"] .fb', label, 'sekce Platnost a podmínky s editorem podmínek');
  await page.selectOption('select[data-path="target.mode"]', 'clearance');
  await expectVisible(page, 'input[data-path="target.step_pct"]', label, 'pole doprodeje');
  await page.locator('[data-section="schedule"] .segmented button').nth(5).click();
  const sum = await page.locator('.summary-text').innerText();
  if (!/zlevní o 5/.test(sum.replace(/\u00a0/g, ' ')) || !/jen so/.test(sum)) problem(label, 'shrnutí', sum.slice(0, 200));
  await shot(page, 'desktop-rozsireni-strategie');
  await page.locator('[data-section="schedule"]').screenshot({ path: path.join(OUT, 'desktop-rozsireni-platnost.png') });
  await context.close();
}

process.on('unhandledRejection', (e) => problem('proces', 'nezachycené odmítnutí', String(e && e.message ? e.message.split('\n')[0] : e)));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = loadPlaywright();
  let mock = null;
  let base = args.url ? String(args.url).replace(/\/+$/, '') : null;
  if (!base) {
    const { createMockServer } = require('./ui-mock-server.js');
    mock = await createMockServer({ port: 0, password: PASSWORD, latency: Number(args.latency || 30) });
    base = mock.url;
  }
  const browser = await chromium.launch({ headless: !args.headed });
  const t0 = Date.now();
  try {
    for (const vp of VIEWPORTS) {
      console.log('▶ ' + vp.name + ' ' + vp.width + '×' + vp.height);
      await runViewport(browser, base, vp, 'light');
      if (!args['no-dark'] && vp.name === 'desktop') {
        console.log('▶ ' + vp.name + ' tmavý režim');
        await runViewport(browser, base, vp, 'dark');
      }
    }
    // Rozšíření enginu (časové okno, podmínky, doprodej) – druhý mock server s --extensions
    if (!args.url && (!args.only || args.only === 'extensions')) {
      console.log('▶ desktop – rozšíření strategií');
      const { createMockServer } = require('./ui-mock-server.js');
      const ext = await createMockServer({ port: 0, password: PASSWORD, extensions: true });
      try {
        await runExtensions(browser, ext.url);
      } finally {
        await ext.close();
      }
    }
  } finally {
    await browser.close();
    if (mock) await mock.close();
  }
  const shots = fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
  console.log(`Hotovo za ${((Date.now() - t0) / 1000).toFixed(1)} s, snímků: ${shots} v ${OUT}`);
  if (problems.length) {
    console.log('\n✖ Nalezené problémy (' + problems.length + '):');
    for (const p of problems) console.log('  - ' + p);
    process.exitCode = 1;
  } else console.log('✔ Bez chyb v konzoli, CSP i API.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
