/*
 * Spustí Chromium s načteným rozšířením nad lokálními testovacími stránkami a ověří,
 * že se rozšíření samo aktivuje (offline režim, bez API klíče).
 *   node tools/e2e.js            # vyžaduje globálně nainstalovaný playwright
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
const FIX = path.join(__dirname, 'fixtures');

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const f = path.join(FIX, req.url.split('?')[0].split('#')[0] === '/' ? 'product.html' : req.url.split('?')[0].split('#')[0]);
      if (!fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(f));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port }));
  });
}

(async () => {
  const { srv, base } = await serve();
  const userDataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tg-e2e-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium', // plné Chromium (headless shell rozšíření nepodporuje)
    args: ['--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT, '--no-sandbox'],
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  let ok = true;
  const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) ok = false; };
  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    check('service worker se spustil', !!sw, sw && sw.url());
    // Zavřít případně otevřenou stránku nastavení.
    for (const p of ctx.pages()) if (p.url().includes('options')) await p.close();

    // 1) Dokument s podmínkami → panel s verdiktem
    const p1 = await ctx.newPage();
    await p1.goto(base + '/vop.html');
    await p1.waitForSelector('#terms-guard-host', { timeout: 15000 });
    await p1.waitForFunction(() => { const h = document.querySelector('#terms-guard-host'); return h && h.shadowRoot && h.shadowRoot.querySelector('.tg-verdict'); }, null, { timeout: 15000 });
    const v1 = await p1.evaluate(() => { const s = document.querySelector('#terms-guard-host').shadowRoot; return { cls: s.querySelector('.tg-verdict').className, label: s.querySelector('.tg-verdict-label').textContent, findings: s.querySelectorAll('.tg-finding').length, prices: s.querySelectorAll('.tg-table tbody tr').length, cancel: s.querySelector('[data-panel=cancel]').textContent }; });
    check('VOP: panel zobrazen s verdiktem', /danger|warn/.test(v1.cls), v1.label);
    check('VOP: nálezy rizik', v1.findings >= 5, v1.findings + ' nálezů');
    check('VOP: tabulka cen', v1.prices >= 3, v1.prices + ' cen');
    check('VOP: automatické prodlužování v záložce Zrušení', /ANO/.test(v1.cancel));
    check('VOP: způsob zrušení nalezen', /nastavení účtu/.test(v1.cancel));

    // 2) Pokladna → stáhne odkazované podmínky a zanalyzuje
    const p2 = await ctx.newPage();
    await p2.goto(base + '/checkout.html');
    await p2.waitForFunction(() => { const h = document.querySelector('#terms-guard-host'); return h && h.shadowRoot && h.shadowRoot.querySelector('.tg-verdict'); }, null, { timeout: 20000 });
    const v2 = await p2.evaluate(() => { const s = document.querySelector('#terms-guard-host').shadowRoot; return { label: s.querySelector('.tg-verdict-label').textContent, sources: s.querySelector('.tg-sources') ? s.querySelector('.tg-sources').textContent : '' }; });
    check('Pokladna: analyzovány odkazované podmínky', /Zdroje/.test(v2.sources), v2.label + ' | ' + v2.sources.trim());

    // 3) Stránka produktu → nic
    const p3 = await ctx.newPage();
    await p3.goto(base + '/product.html');
    await p3.waitForTimeout(3000);
    const has3 = await p3.evaluate(() => !!document.querySelector('#terms-guard-host'));
    check('Produkt: rozšíření se nespustilo', !has3);

    // 4) Popup – stav karty
    const extId = new URL(sw.url()).host;
    const popup = await ctx.newPage();
    await popup.goto('chrome-extension://' + extId + '/popup/popup.html');
    await popup.waitForTimeout(1500);
    const popupText = await popup.evaluate(() => document.body.innerText);
    check('Popup se načte', /Hlídač podmínek/.test(popupText));

    if (process.env.SCREENSHOT) {
      await p1.bringToFront();
      await p1.screenshot({ path: process.env.SCREENSHOT, fullPage: false });
      console.log('screenshot:', process.env.SCREENSHOT);
    }
  } catch (e) {
    ok = false;
    console.error('E2E chyba:', e && e.stack || e);
  } finally {
    await ctx.close();
    srv.close();
  }
  process.exit(ok ? 0 : 1);
})();
