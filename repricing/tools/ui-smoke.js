#!/usr/bin/env node
'use strict';
// Smoke test webového rozhraní přes Playwright (Chromium).
// Spustí mock server (tools/ui-mock-server.js) nebo použije --url, projde všechny stránky ve dvou velikostech
// (1366×850 a 390×844), udělá snímky obrazovky, vyzkouší klíčové interakce a ohlídá chyby v konzoli,
// porušení CSP, nezachycené výjimky, chyby API 5xx a vodorovné přetečení stránky na mobilu.
//
// Použití:
//   node tools/ui-smoke.js [--out=DIR] [--url=http://localhost:8080] [--password=demo] [--only=desktop|mobile] [--no-dark] [--headed]
// Nezávislé na datech: ID a hledané texty bere z API (první produkt, strategie s posunem, segment), takže projde
// s mockem i se skutečným serverem s demo daty (tools/demo-data.js). Smoke data mění (schválí návrhy, vytvoří segment,
// zdroj a token, naimportuje examples/konkurence.csv, spustí přecenění) – proti produkční databázi ho nepouštějte.
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

// Trasy se doplní o skutečná ID z dat (první produkt, strategie a segment) – smoke funguje s mockem i s demo daty.
function routesFor(ids) {
  return [
    '/prehled', '/produkty', '/produkty/' + ids.product, '/navrhy', '/strategie', '/strategie/' + ids.strategy, '/strategie/nova', '/segmenty',
    ids.segment ? '/segmenty/' + ids.segment : null, '/segmenty/novy',
    '/konkurence', '/konkurence?tab=unmatched', '/import', '/import?tab=sources', '/import?tab=log', '/import?tab=api', '/export', '/nastaveni', '/nastaveni?tab=tokeny', '/nastaveni?tab=audit', '/neexistuje',
  ].filter(Boolean);
}

const EXAMPLE_CSV = path.join(__dirname, '..', 'examples', 'konkurence.csv');
const RUN_ID = Date.now().toString(36);

const problems = [];
function problem(vp, where, msg) {
  problems.push(`[${vp}] ${where}: ${msg}`);
}

function slug(route) {
  // ID v cestě nahradíme slovem, aby se názvy snímků neměnily s daty (produkty/1 i produkty/654 → produkty-detail)
  return route.replace(/^\//, '').replace(/\/\d+(?=$|\?)/, '/detail').replace(/[?=&/]+/g, '-').replace(/-+$/, '') || 'root';
}

/** Volání API ze stránky (session cookie + CSRF hlavička jako UI). */
async function apiCall(page, method, url, body) {
  return page.evaluate(async ([m, u, b]) => {
    const r = await fetch('api/v1' + u, { method: m, credentials: 'same-origin', headers: { 'X-Requested-With': 'cenotvorba', ...(b != null ? { 'Content-Type': 'application/json' } : {}) }, body: b != null ? JSON.stringify(b) : undefined });
    let json = null;
    try {
      json = await r.json();
    } catch {
      /* ne-JSON */
    }
    return { status: r.status, body: json };
  }, [method, url, body ?? null]);
}

const itemsOf = (b) => (Array.isArray(b) ? b : b && Array.isArray(b.items) ? b.items : []);

/** Skutečná ID z dat: produkt s nejvíce konkurenty, strategie s posunem cíle, první segment. */
async function discoverIds(page) {
  const prods = itemsOf((await apiCall(page, 'GET', '/products?limit=5&sort=market_count&dir=desc')).body);
  const strats = itemsOf((await apiCall(page, 'GET', '/strategies')).body);
  const segs = itemsOf((await apiCall(page, 'GET', '/segments')).body);
  const OFFSET_MODES = ['undercut_min', 'rank', 'market_avg', 'market_median', 'competitor', 'msrp'];
  const strategy = strats.find((x) => x.enabled && OFFSET_MODES.includes(x.config?.target?.mode)) || strats[0];
  const product = prods[0];
  return {
    product: product ? product.id : 1,
    productName: product ? product.name : '',
    strategy: strategy ? strategy.id : 1,
    segment: segs[0] ? segs[0].id : null,
    manufacturer: product ? product.manufacturer : null,
  };
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
  // celá stránka, ale nejvýš 2400 px (dlouhé seznamy na mobilu by byly nečitelné); od začátku stránky,
  // jinak by lepivá hlavička a postranní panel byly na snímku uprostřed
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(50);
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

async function interactions(page, base, vp, ids) {
  const W = (name) => 'interakce ' + name;
  const okStatus = (r) => r.status() >= 200 && r.status() < 300;
  let r;

  // --- produkty: hledání podle názvu prvního produktu, filtr výrobce, detail
  step('produkty');
  await go(page, base, '/produkty');
  const firstName = (await page.locator('.dt tbody tr.is-clickable .cell-name').first().innerText().catch(() => '')).trim() || ids.productName;
  const needle = firstName.split(/\s+/).slice(0, 3).join(' ');
  if (!needle) problem(vp, W('produkty'), 'tabulka produktů je prázdná');
  else {
    await act(page, (x) => x.url().includes('/api/v1/products?') && decodeURIComponent(x.url().replace(/\+/g, ' ')).includes('q=' + needle), () => page.fill('#products-search', needle));
    await page.waitForTimeout(250);
    const rows = await page.locator('.dt tbody tr.is-clickable .cell-name').allInnerTexts();
    if (!rows.length || !rows.some((t) => t.includes(needle))) problem(vp, W('produkty'), `hledání „${needle}“ nevrátilo produkt (řádky: ${rows.slice(0, 3).join(' | ')})`);
  }
  if (vp === 'desktop') {
    // hledání zrušit, jinak by se s filtrem výrobce nemuselo nic najít
    await act(page, (x) => x.url().includes('/api/v1/products?') && !x.url().includes('q='), () => page.fill('#products-search', ''));
    const manu = await page.locator('select[aria-label="Výrobce"] option').nth(1).getAttribute('value').catch(() => null);
    if (manu) {
      await act(page, (x) => x.url().includes('/api/v1/products?') && x.url().includes('manufacturer='), () => page.selectOption('select[aria-label="Výrobce"]', manu));
      await page.waitForTimeout(150);
      await shot(page, vp + '-produkty-filtr');
    } else problem(vp, W('produkty'), 'filtr výrobce nemá žádné hodnoty (facety)');
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
  // naše cena musí být v grafu vždy (i bez historie změn)
  const usInLegend = await page.locator('[data-card="history"] .legend-item', { hasText: 'Naše cena' }).count();
  if (!usInLegend) problem(vp, W('graf historie'), 'v grafu chybí naše cena');
  if (vp === 'desktop') {
    // úprava min. ceny (a vrácení zpět, ať smoke nemění data)
    const minInput = page.locator('[data-card="product-settings"] input.input-num').first();
    const before = await minInput.inputValue();
    await minInput.fill('1000');
    r = await act(page, (x) => x.request().method() === 'PATCH' && x.url().includes('/api/v1/products/'), () => page.click('[data-action="save-product"]'));
    if (r.status() !== 200) problem(vp, W('uložení produktu'), 'PATCH vrátil ' + r.status());
    await page.waitForTimeout(700);
    await page.locator('[data-card="product-settings"] input.input-num').first().fill(before);
    r = await act(page, (x) => x.request().method() === 'PATCH' && x.url().includes('/api/v1/products/'), () => page.click('[data-action="save-product"]'));
    if (r.status() !== 200) problem(vp, W('vrácení min. ceny'), 'PATCH vrátil ' + r.status());
    await page.waitForTimeout(400);
    // hover na graf (tooltip)
    const plot = page.locator('[data-card="history"] .overlay').first();
    await plot.scrollIntoViewIfNeeded();
    const box = await plot.boundingBox();
    if (box) {
      await plot.hover({ position: { x: box.width * 0.9, y: box.height / 2 } });
      await page.waitForTimeout(150);
      await expectVisible(page, '.chart-tip:not([hidden])', vp, W('tooltip grafu'), 2000);
      await shot(page, vp + '-produkt-graf-tooltip', false);
    }
  }

  // --- návrhy: schválit řádek, hromadný výběr, schválit vše (Esc), rozbalení, ruční cena
  step('návrhy');
  await go(page, base, '/navrhy');
  const pendingRows = await page.locator('[data-action="approve-row"]').count();
  if (!pendingRows) problem(vp, W('návrhy'), 'žádné čekající návrhy (spusťte přecenění na demo datech)');
  else {
    r = await act(page, (x) => x.url().includes('/api/v1/proposals/approve') && x.request().method() === 'POST', () => page.locator('[data-action="approve-row"]').first().click());
    if (r.status() !== 200) problem(vp, W('schválení návrhu'), 'POST approve ' + r.status());
    await expectVisible(page, '.toast-success, .toast-warning', vp, W('toast po schválení'));
    await page.waitForTimeout(400);
  }
  if (vp === 'desktop' && pendingRows > 3) {
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
    // ruční cena: o 10 Kč nad navrženou – v tabulce se pak musí ukázat právě ta (cena k exportu)
    const priceBtn = page.locator('.price-edit').first();
    const shown = (await priceBtn.innerText()).replace(/[^\d,]/g, '').replace(',', '.');
    const manual = Math.round(Number(shown) || 1000) + 10;
    await priceBtn.click();
    const inp = page.locator('.inline-edit input');
    await inp.fill(String(manual));
    r = await act(page, (x) => x.request().method() === 'PATCH' && x.url().includes('/api/v1/proposals/'), () => inp.press('Enter'));
    if (r.request().postDataJSON().manual_price !== manual) problem(vp, W('ruční cena'), 'špatně odeslaná cena ' + r.request().postData());
    if (r.status() !== 200) problem(vp, W('ruční cena'), 'PATCH ' + r.status());
    await page.waitForTimeout(300);
    const after = (await page.locator('.price-edit').first().innerText()).replace(/\D/g, '');
    if (after !== String(manual)) problem(vp, W('ruční cena'), `v tabulce je ${after}, čekáno ${manual} (cena k exportu)`);
    await shot(page, vp + '-navrhy-po-akcich');
  }

  // --- strategie: úprava + simulace + uložení, přeřazení
  step('strategie');
  await go(page, base, '/strategie/' + ids.strategy);
  const off = page.locator('input[data-path="target.offset_pct"]');
  if (await off.isVisible()) {
    await off.fill('-2');
    await page.waitForTimeout(100);
    const summary = await page.locator('.summary-text').innerText();
    if (!/2\s?%/.test(summary.replace(/ /g, ' '))) problem(vp, W('shrnutí strategie'), 'shrnutí nereaguje na změnu: ' + summary.slice(0, 120));
  } else problem(vp, W('strategie'), 'strategie #' + ids.strategy + ' nemá pole posunu');
  // náhradní režim: výchozí „next“ je v nabídce vždy
  const fbOpts = await page.locator('select[data-path="fallback.mode"] option').evaluateAll((o) => o.map((x) => x.value));
  for (const v of ['next', 'keep', 'msrp', 'cost_plus']) if (!fbOpts.includes(v)) problem(vp, W('strategie'), 'náhradní režim bez volby ' + v);
  await expectVisible(page, '[data-section="schedule"]', vp, W('sekce Platnost a podmínky'));
  step('strategie – simulace');
  r = await act(page, (x) => x.url().includes('/api/v1/simulate'), () => page.click('[data-action="simulate"]'), 30000);
  if (r.status() !== 200) problem(vp, W('simulace'), 'POST simulate ' + r.status());
  await expectVisible(page, '[data-card="simulation"] .kpi', vp, W('výsledek simulace'), 15000);
  await page.waitForTimeout(300);
  // karta simulace je pod dlouhým formulářem – snímek jen jí (celostránkový by ji s limitem 2400 px uřízl)
  await page.locator('[data-card="simulation"]').screenshot({ path: path.join(OUT, vp + '-strategie-simulace.png') });
  step('strategie – uložení');
  r = await act(page, (x) => x.url().includes('/api/v1/strategies/' + ids.strategy) && x.request().method() === 'PUT', () => page.click('[data-action="save-strategy"]'));
  if (r.status() !== 200) problem(vp, W('uložení strategie'), 'PUT ' + r.status() + ' ' + (await r.text().catch(() => '')).slice(0, 200));
  if (vp === 'desktop') {
    await go(page, base, '/strategie');
    if (!(await page.locator('.strategy-meta [data-meta="conditions"], .strategy-meta [data-meta="schedule"]').count())) problem(vp, W('seznam strategií'), 'chybí souhrn podmínek / platnosti');
    r = await act(page, (x) => x.url().includes('/api/v1/strategies/reorder'), () => page.locator('[data-move="down"]').first().click());
    if (r.status() !== 200) problem(vp, W('přeřazení'), 'reorder ' + r.status());
    await page.waitForTimeout(300);
    // vrátit pořadí zpět
    r = await act(page, (x) => x.url().includes('/api/v1/strategies/reorder'), () => page.locator('[data-move="up"]:not([disabled])').first().click());
    await page.waitForTimeout(300);
    // nová strategie: výchozí hodnoty = engine (fallback „next“)
    await go(page, base, '/strategie/nova');
    const fb = await page.locator('select[data-path="fallback.mode"]').inputValue();
    if (fb !== 'next') problem(vp, W('nová strategie'), 'výchozí náhradní režim je „' + fb + '“, engine má „next“');
    await page.selectOption('select[data-path="target.mode"]', 'clearance');
    await expectVisible(page, 'input[data-path="target.step_pct"]', vp, W('pole doprodeje'));
    await page.locator('[data-section="schedule"] .segmented button').nth(5).click();
    await page.locator('[data-section="schedule"] .segmented button').nth(6).click();
    const sum = (await page.locator('.summary-text').innerText()).replace(/ /g, ' ');
    if (!/zlevní o 5/.test(sum) || !/jen so, ne/.test(sum)) problem(vp, W('shrnutí nové strategie'), sum.slice(0, 200));
    await shot(page, vp + '-strategie-nova-doprodej');
  }

  // --- segment s vnořenou skupinou
  step('segment');
  await go(page, base, '/segmenty/novy');
  await page.fill('input[data-field="name"]', 'Smoke ' + vp + ' ' + RUN_ID);
  await page.click('.fb-group.depth-0 > .fb-group-head [data-action="add-cond"]');
  let cond = page.locator('.fb-cond').last();
  await cond.locator('.fb-field').selectOption('manufacturer');
  await cond.locator('.fb-op').selectOption('in');
  const chipsInputEl = cond.locator('.chips-input');
  await chipsInputEl.fill(ids.manufacturer || 'Trek');
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
  if (!okStatus(r)) problem(vp, W('uložení segmentu'), 'POST ' + r.status());
  const saved = r.request().postDataJSON();
  if (!saved.filter?.all || !saved.filter.all.some((x) => x.any)) problem(vp, W('uložení segmentu'), 'filtr bez vnořené skupiny: ' + JSON.stringify(saved.filter));
  await page.waitForTimeout(400);

  // --- import: examples/konkurence.csv průvodcem s navrženým mapováním
  step('import');
  await go(page, base, '/import');
  r = await act(page, (x) => x.url().includes('/api/v1/import/preview'), () => page.setInputFiles('#import-file', { name: 'konkurence.csv', mimeType: 'text/csv', buffer: fs.readFileSync(EXAMPLE_CSV) }));
  if (r.status() !== 200) problem(vp, W('náhled importu'), 'preview ' + r.status());
  if (r.request().headers()['content-type'] !== 'text/csv') problem(vp, W('náhled importu'), 'Content-Type ' + r.request().headers()['content-type']);
  await expectVisible(page, '[data-card="mapping"]', vp, W('mapování'));
  const expected = { ean: 'ean', competitor: 'konkurent', price: 'cena', shipping: 'doprava', availability: 'skladem', url: 'url' };
  for (const [canon, col] of Object.entries(expected)) {
    const v = await page.locator(`select[data-canonical="${canon}"]`).inputValue().catch(() => '');
    if (v !== col) problem(vp, W('návrh mapování'), `${canon} namapováno na „${v}“, čekáno „${col}“`);
  }
  await page.waitForTimeout(500);
  await shot(page, vp + '-import-mapovani');
  r = await act(page, (x) => x.url().includes('/api/v1/import/offers') && x.url().includes('dry_run=1'), () => page.click('[data-action="dry-run"]'));
  if (r.status() !== 200) problem(vp, W('zkušební import'), r.status());
  await page.waitForTimeout(300);
  r = await act(page, (x) => x.url().includes('/api/v1/import/offers') && !x.url().includes('dry_run'), () => page.click('[data-action="import"]'), 30000);
  if (r.status() !== 200) problem(vp, W('import'), r.status() + ' ' + (await r.text().catch(() => '')).slice(0, 200));
  else {
    const res = await r.json().catch(() => ({}));
    const st = res.stats || {};
    if (!(st.received > 100)) problem(vp, W('import'), 'přijato jen ' + st.received + ' řádků');
    if (args.url && !(st.matched > 0)) problem(vp, W('import'), 'nic se nespárovalo (demo data by měla): ' + JSON.stringify(st).slice(0, 200));
  }
  await expectVisible(page, '[data-card="import-result"]', vp, W('výsledek importu'));
  await shot(page, vp + '-import-vysledek');
  if (vp === 'desktop') {
    await page.click('[data-action="open-save-source"]');
    await expectVisible(page, 'dialog[open]', vp, W('uložit zdroj'));
    r = await act(page, (x) => x.url().endsWith('/api/v1/sources') && x.request().method() === 'POST', () => page.click('[data-action="save-source"]'));
    if (!okStatus(r)) problem(vp, W('uložit zdroj'), r.status());
    await page.waitForTimeout(300);
    await go(page, base, '/import?tab=log');
    const logText = await page.locator('main').innerText();
    if (!/Ceny konkurence/.test(logText)) problem(vp, W('historie importů'), 'import se neobjevil v historii');
  }

  // --- konkurence: vypnutí/zapnutí konkurenta, ruční spárování nabídky
  step('konkurence');
  if (vp === 'desktop') {
    await go(page, base, '/konkurence');
    const sw = page.locator('.dt tbody [role=switch]').first();
    const wasOn = (await sw.getAttribute('aria-checked')) === 'true';
    r = await act(page, (x) => x.request().method() === 'PATCH' && x.url().includes('/api/v1/competitors/'), () => sw.click());
    if (r.request().postDataJSON().enabled !== !wasOn) problem(vp, W('konkurent'), 'PATCH enabled ' + r.request().postData());
    await page.waitForTimeout(300);
    r = await act(page, (x) => x.request().method() === 'PATCH' && x.url().includes('/api/v1/competitors/'), () => page.locator('.dt tbody [role=switch]').first().click());
    if (r.request().postDataJSON().enabled !== wasOn) problem(vp, W('konkurent'), 'zpětné zapnutí ' + r.request().postData());
    // nespárovaná nabídka: když žádná není (demo data), vytvoříme ji importem přes API
    const um = await apiCall(page, 'GET', '/unmatched?limit=1');
    if (!itemsOf(um.body).length) {
      const imp = await apiCall(page, 'POST', '/import/offers', { items: [{ competitor: 'SmokeShop.cz', ean: '8590000000017', name: firstName + ' (smoke)', price: 1234 }] });
      if (imp.status !== 200) problem(vp, W('nespárované'), 'nepodařilo se vytvořit nespárovanou nabídku: ' + imp.status);
    }
    await go(page, base, '/konkurence?tab=unmatched');
    await page.locator('[data-action="match"]').first().click();
    await expectVisible(page, 'dialog[open] input[type=search]', vp, W('dialog párování'));
    await act(page, (x) => x.url().includes('/api/v1/products?') && x.url().includes('q='), () => page.locator('dialog[open] input[type=search]').fill(needle));
    await expectVisible(page, 'dialog[open] .match-item', vp, W('výsledky hledání produktu'));
    await page.locator('dialog[open] .match-item').first().click();
    r = await act(page, (x) => x.url().includes('/match') && x.request().method() === 'POST', () => page.click('dialog[open] [data-action="confirm-match"]'));
    if (!r.request().postDataJSON().product_id) problem(vp, W('spárování'), 'chybí product_id');
    if (!okStatus(r)) problem(vp, W('spárování'), 'POST match ' + r.status());
    await page.waitForTimeout(300);
    await shot(page, vp + '-konkurence-sparovano', false);
  }

  // --- tokeny
  step('tokeny');
  if (vp === 'desktop') {
    await go(page, base, '/nastaveni?tab=tokeny');
    await page.fill('input[placeholder^="Např. Admin"]', 'Smoke test ' + RUN_ID);
    r = await act(page, (x) => x.url().endsWith('/api/v1/tokens') && x.request().method() === 'POST', () => page.click('[data-action="create-token"]'));
    if (!okStatus(r)) problem(vp, W('nový token'), 'POST ' + r.status());
    await expectVisible(page, '[data-role="new-token"]', vp, W('nový token'));
    const tok = await page.locator('[data-role="new-token"] input').first().inputValue();
    if (!/^ct_[A-Za-z0-9]{32}$/.test(tok)) problem(vp, W('nový token'), 'neplatný token ' + tok);
    await shot(page, vp + '-token', false);
    await page.locator('dialog[open] .modal-foot .btn-primary').click();
  }

  // --- přecenění → schválit jeden návrh → export ho ukazuje
  step('přecenění');
  await go(page, base, '/prehled');
  await page.click('[data-action="run-pricing"]');
  await expectVisible(page, 'dialog[open] [data-confirm]', vp, W('potvrzení přecenění'));
  r = await act(page, (x) => x.url().endsWith('/api/v1/runs') && x.request().method() === 'POST', () => page.click('dialog[open] [data-confirm]'), 60000);
  if (r.status() !== 200) problem(vp, W('přecenění'), r.status());
  await expectVisible(page, 'dialog[open] .run-stats', vp, W('výsledek přecenění'));
  await page.waitForTimeout(250);
  await shot(page, vp + '-preceneni-vysledek', false);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  if (await page.locator('dialog[open]').count()) problem(vp, W('Esc'), 'Esc nezavřel dialog výsledku');

  step('schválení → export');
  await go(page, base, '/navrhy');
  const row = page.locator('.dt tbody tr[data-key]').filter({ has: page.locator('[data-action="approve-row"]') }).first();
  const propId = await row.getAttribute('data-key').catch(() => null);
  if (!propId) problem(vp, W('schválení → export'), 'po přecenění není žádný čekající návrh');
  else {
    const priceText = (await row.locator('.price-edit').innerText().catch(() => '')).replace(/\D/g, '');
    r = await act(page, (x) => x.url().includes('/api/v1/proposals/approve'), () => row.locator('[data-action="approve-row"]').click());
    if (r.status() !== 200) problem(vp, W('schválení → export'), 'approve ' + r.status());
    await page.waitForTimeout(300);
    await go(page, base, '/export');
    const item = page.locator(`[data-card="approved"] [data-proposal-id="${propId}"]`);
    if (!(await item.count())) problem(vp, W('schválení → export'), 'export nezobrazuje schválený návrh #' + propId);
    else {
      const t = (await item.innerText()).replace(/\s/g, '');
      if (priceText && !t.includes(priceText)) problem(vp, W('schválení → export'), `export ukazuje jinou cenu (${t}) než návrhy (${priceText})`);
    }
    const feed = await apiCall(page, 'GET', '/export/changes.json');
    if (feed.status !== 200 || !itemsOf(feed.body).some((x) => String(x.proposal_id) === String(propId))) problem(vp, W('schválení → export'), 'changes.json neobsahuje návrh #' + propId);
    await shot(page, vp + '-export-schvaleno');
    if (vp === 'desktop') {
      // stažení souboru přes UI (fetch → blob) – bez označení jako exportované
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('a[data-format="json"]')]);
      if (!/\.json$/.test(dl.suggestedFilename())) problem(vp, W('stažení změn'), 'neočekávaný název souboru ' + dl.suggestedFilename());
    }
  }

  // --- upozornění na přehledu mají odkaz
  if (vp === 'desktop') {
    step('upozornění');
    await go(page, base, '/prehled');
    const alerts = await page.locator('[data-card="alerts"] .alert-item').count();
    const links = await page.locator('[data-card="alerts"] .alert-item .alert-link').count();
    if (alerts && links < alerts) problem(vp, W('upozornění'), `jen ${links} z ${alerts} upozornění má odkaz`);
    const bad = await page.locator('[data-card="alerts"] .alert-item:not(.alert-danger):not(.alert-warning):not(.alert-info)').count();
    if (bad) problem(vp, W('upozornění'), bad + ' upozornění bez stylu závažnosti');
  }

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
    // 4xx z API = UI poslalo požadavek, který server odmítl (neznámé pole, špatný parametr…); 401 u přihlášení je v pořádku
    else if (r.status() >= 400 && r.status() !== 401 && r.url().includes('/api/v1/')) problem(label, 'API', r.status() + ' ' + r.request().method() + ' ' + r.url());
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

  const ids = await discoverIds(page);
  const routes = colorScheme === 'dark'
    ? ['/prehled', '/produkty/' + ids.product, '/navrhy', '/strategie', '/strategie/' + ids.strategy, ids.segment ? '/segmenty/' + ids.segment : '/segmenty', '/import', '/export']
    : routesFor(ids);
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
    // hodnoty dlaždic se nesmí oříznout výpustkou (např. „−1 467 7…“)
    const cut = await page.evaluate(() => [...document.querySelectorAll('.kpi-value')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
    if (cut.length) problem(label, route, 'oříznutá hodnota KPI: ' + cut.join(' | '));
    // žádné surové objekty v textu stránky
    const raw = await page.evaluate(() => /\[object Object\]|\bundefined\b|\bNaN\b/.test(document.querySelector('main')?.innerText || ''));
    if (raw) problem(label, route, 'v textu stránky je [object Object] / undefined / NaN');
    await shot(page, label + '-' + slug(route));
  }
  if (colorScheme === 'light') {
    try {
      await interactions(page, base, vp.name, ids);
    } catch (e) {
      problem(label, 'interakce „' + currentStep + '“', e.message.split('\n')[0]);
      await shot(page, label + '-CHYBA-interakce').catch(() => {});
    }
  }
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
