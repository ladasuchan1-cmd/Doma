/*
 * Ověří JS most Android aplikace (android/app/src/main/assets/engine.html a result.html)
 * v reálném Chromiu – stejné WebView jádro jako na Androidu.
 *   node tools/e2e-android-assets.js
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  const g = require('child_process').execSync('npm root -g').toString().trim();
  ({ chromium } = require(path.join(g, 'playwright')));
}
const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'android/app/src/main/assets');
const LIB = path.join(ROOT, 'lib');

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      const f = u.startsWith('/lib/') ? path.join(LIB, u.slice(5)) : path.join(ASSETS, u.slice(1));
      if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(f));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port }));
  });
}

(async () => {
  const { srv, base } = await serve();
  const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] });
  let ok = true;
  const check = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!c) ok = false; };
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(base + '/engine.html');
    check('engine.html bez chyb', errors.length === 0, errors.join('; '));
    const vop = fs.readFileSync(path.join(ROOT, 'tools/fixtures/vop.html'), 'utf8');
    const r = await page.evaluate((html) => {
      const ex = JSON.parse(TG.fromHtml(html));
      const det = JSON.parse(TG.detect(JSON.stringify({ url: 'https://testshop.cz/vop', title: ex.title, headings: [], buttons: [], labels: [], links: [], text: ex.text })));
      const quick = JSON.parse(TG.detect(JSON.stringify({ url: 'https://testshop.cz/kosik/dokonceni', title: 'Pokladna', headings: [], buttons: ['Objednat a zaplatit'], labels: ['Souhlasím s obchodními podmínkami'], links: [], text: 'krátký text obrazovky' })));
      const local = JSON.parse(TG.analyzeLocal(ex.text, JSON.stringify({ url: 'x' })));
      const req = JSON.parse(TG.buildRequest('text', JSON.stringify({ url: 'u' }), JSON.stringify({ model: 'claude-opus-5', effort: 'low' })));
      return { title: ex.title, textLen: ex.text.length, det, quick, verdict: local.verdict, prices: local.prices.length, hash: TG.hash('abc'), model: req.body.model, betas: req.betas, format: req.body.output_config.format.type };
    }, vop);
    check('fromHtml: titulek a text', r.title.includes('Obchodní podmínky') && r.textLen > 800, r.title + ' / ' + r.textLen);
    check('detect: dokument', r.det.kind === 'document', r.det.reason);
    check('detect: rychlé signály pokladny (context+agree)', r.quick.context.includes('checkout') && r.quick.agree, JSON.stringify({ context: r.quick.context, agree: r.quick.agree, strong: r.quick.strong }));
    check('analyzeLocal: verdikt a ceny', r.verdict === 'nebezpecne' && r.prices >= 3, r.verdict + ' / ' + r.prices);
    check('buildRequest: model, beta, formát', r.model === 'claude-opus-5' && r.betas[0] === 'server-side-fallback-2026-07-01' && r.format === 'json_schema');
    check('hash', /^[0-9a-f]{8}-3$/.test(r.hash), r.hash);

    // result.html s rozhraním Android
    const page2 = await browser.newPage();
    const errors2 = [];
    page2.on('pageerror', (e) => errors2.push(String(e)));
    const local = await page.evaluate((html) => TG.analyzeLocal(JSON.parse(TG.fromHtml(html)).text, '{}'), vop);
    await page2.addInitScript((json) => { window.Android = { getResult: () => json, getTitle: () => 'TestShop VOP' }; }, local);
    await page2.goto(base + '/result.html');
    await page2.waitForSelector('.tg-verdict', { timeout: 5000 });
    const v = await page2.evaluate(() => ({ label: document.querySelector('.tg-verdict-label').textContent, tabs: document.querySelectorAll('.tg-tab').length, h1: document.querySelector('h1').textContent }));
    check('result.html vykreslí výsledek', errors2.length === 0 && v.tabs === 4 && v.h1 === 'TestShop VOP', v.label + ' ' + errors2.join('; '));
    await page2.click('.tg-tab[data-tab=prices]');
    const rows = await page2.evaluate(() => document.querySelectorAll('.tg-panel.active .tg-table tbody tr').length);
    check('result.html: záložka Ceny funguje', rows >= 3, rows + ' řádků');
    if (process.env.SCREENSHOT) { await page2.setViewportSize({ width: 412, height: 915 }); await page2.screenshot({ path: process.env.SCREENSHOT }); }
  } catch (e) { ok = false; console.error('chyba:', e && e.stack || e); }
  finally { await browser.close(); srv.close(); }
  process.exit(ok ? 0 : 1);
})();
