/*
 * Ověří Boubínský kvíz (kviz/) v reálném Chromiu – stejné jádro jako Android WebView.
 * Server napodobuje LocalServer.kt (vložení mobile.css + bridge.js, pozadí .png → .jpg, ukázky podle názvu)
 * a window.KvizApp je podstrčené; jako ukázka „Titanic“ slouží syntetické video tools/fixtures/kviz-test.webm.
 *   node tools/e2e-kviz.js [složka-pro-screenshoty]
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
const WEB = path.join(ROOT, 'kviz/web');
const APP = path.join(ROOT, 'kviz/android/app/src/main/assets/app');
const SHOTS = process.argv[2];
const MEDIA = { titanic: path.join(__dirname, 'fixtures/kviz-test.webm') };   // klíč = norm(název)

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]/g, '');
const TYPES = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', jpg: 'image/jpeg', webm: 'video/webm' };

/* Kvízy jako v Library.parse: názvy okruhů a ukázky z pole BLOCKS. */
const quizzes = fs.readdirSync(WEB).filter((f) => f.endsWith('.html')).sort().map((file) => {
  const html = fs.readFileSync(path.join(WEB, file), 'utf8');
  const blocks = JSON.parse(html.match(/const BLOCKS = (\[.*?\]);\nconst SECONDS/s)[1]);
  const rounds = [], clips = [];
  blocks.forEach((b) => b.forEach((r) => { rounds.push(r.name); r.items.forEach((it, i) => { if (it.t === 'm') clips.push({ label: `${r.name} ${i + 1} · ${it.f[0]}`, have: !!MEDIA[norm(it.f[0])] }); }); }));
  return { file, title: html.match(/<title>(.*?)<\/title>/)[1], rounds, clips, have: clips.filter((c) => c.have).length, total: clips.length };
});
const STATE = { quizzes, busy: false, media: { have: 1, total: 40, bytes: fs.statSync(MEDIA.titanic).size } };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
      const send = (code, type, body, headers = {}) => { res.writeHead(code, { 'content-type': type, ...headers }); res.end(body); };
      if (/\.(mp4|m4v|webm|mov|mkv|mp3|m4a|ogg|wav)$/i.test(p)) {
        const f = MEDIA[norm(p.split('/').pop())];
        if (!f) return send(404, 'text/plain', '');
        const buf = fs.readFileSync(f), m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
        if (!m) return send(200, 'video/webm', buf, { 'accept-ranges': 'bytes' });
        const a = m[1] ? +m[1] : buf.length - +m[2], b = m[1] && m[2] ? Math.min(+m[2], buf.length - 1) : buf.length - 1;
        return send(206, 'video/webm', buf.subarray(a, b + 1), { 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${buf.length}` });
      }
      let f = p.startsWith('app/') ? path.join(APP, p.slice(4)) : p.startsWith('kviz/') ? path.join(WEB, p.slice(5)) : null;
      if (f && !fs.existsSync(f) && f.endsWith('.png')) f = f.replace(/\.png$/, '.jpg');
      if (!f || !fs.existsSync(f)) return send(404, 'text/plain', '');
      let body = fs.readFileSync(f);
      if (p.startsWith('kviz/') && p.endsWith('.html')) {
        body = body.toString().replace('</head>', '<link rel="stylesheet" href="/app/mobile.css">\n</head>')
          .replace(/<\/body>(?![\s\S]*<\/body>)/, '<script src="/app/bridge.js"></script>\n</body>');
      }
      send(200, TYPES[f.split('.').pop()] || 'application/octet-stream', body);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port }));
  });
}

/* Podstrčený most z MainActivity.Bridge – volání se zapisují do window.__calls. */
const bridge = (state) => {
  window.__calls = [];
  window.KvizApp = {
    state: () => JSON.stringify(state), busy: () => false, version: () => '1.0.0',
    importFiles: () => window.__calls.push('importFiles'), importFolder: () => window.__calls.push('importFolder'),
    pickClip: (n) => window.__calls.push('pickClip:' + n), deleteMedia: () => window.__calls.push('deleteMedia'),
    exitQuiz: () => { window.__calls.push('exitQuiz'); location.href = '/app/menu.html'; },
  };
};

(async () => {
  const { srv, base } = await serve();
  const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  let ok = true;
  const check = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!c) ok = false; };
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } };
  const fits = (page) => page.evaluate(() => {
    const out = [...document.querySelectorAll('header > *, footer > button')].filter((e) => e.offsetParent)
      .filter((e) => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.width < 1; });
    return { overflowX: document.documentElement.scrollWidth > innerWidth, outside: out.map((e) => e.id || e.className) };
  });
  const covers = (page) => page.evaluate(() => {
    const m = document.getElementById('main').getBoundingClientRect(), r = cur().node.getBoundingClientRect();
    return Math.abs(m.left - r.left) <= 1 && Math.abs(m.right - r.right) <= 1 && r.top <= m.top + 1;
  });
  const slideTo = (page, pred) => page.evaluate((src) => { const f = new Function('s', 'return ' + src); const i = slides.findIndex(f); idx = i; render(); return i; }, pred);
  const swipe = (page, dx) => page.evaluate((dx) => {
    const m = document.getElementById('main'), r = m.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    const t = (cx) => new Touch({ identifier: 1, target: m, clientX: cx, clientY: y });
    m.dispatchEvent(new TouchEvent('touchstart', { touches: [t(x)], changedTouches: [t(x)], bubbles: true }));
    m.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t(x + dx)], bubbles: true }));
  }, dx);

  try {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    await ctx.addInitScript(bridge, STATE);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    // Menu
    await page.goto(base + '/app/menu.html');
    await shot(page, '00-menu');
    check('menu: 4 kvízy', (await page.locator('.quiz').count()) === 4);
    check('menu: stav ukázek', (await page.textContent('#mstatus')).includes('1 z 40'));
    check('menu: upozornění na chybějící ukázky', (await page.textContent('#banner')).includes('39 z 40') && await page.isVisible('#banner'));
    check('menu: kvíz 1 má ukázky 1/10', (await page.locator('.quiz').first().textContent()).includes('Ukázky 1/10'));
    await page.click('#bFiles');
    check('menu: Vybrat soubory volá aplikaci', (await page.evaluate(() => window.__calls)).includes('importFiles'));
    await page.evaluate(() => kvizProgress({ index: 2, count: 5, name: 'pelisky.mp4', done: 500, size: 1000 }));
    check('menu: průběh nahrávání', (await page.textContent('#prog .t')).includes('Kopíruji 2 z 5'));
    await page.evaluate(() => kvizImportDone({ copied: [{ label: 'Film 2 · pelisky.mp4', from: 'Pelisky (1999).mp4', exact: false }], failed: [], kept: 0, unused: 3, selected: 4, missing: Array(39).fill('x') }));
    const res = await page.textContent('#result');
    check('menu: shrnutí nahrávání', res.includes('Nahráno 1 ukázka') && res.includes('podobného názvu') && res.includes('3 vybrané soubory') && res.includes('39 z 40'), res);
    await shot(page, '01-menu');
    check('menu: bez vodorovného posouvání', !(await fits(page)).overflowX);

    // Kvíz 1 na výšku
    await page.click('[data-open="kviz-boubin-01.html"]');
    await page.waitForSelector('.appback');
    check('kvíz: vložená mobilní vrstva', await page.evaluate(() => !!document.querySelector('link[href="/app/mobile.css"]') && typeof kvizImportDone === 'function'));
    check('kvíz: Celá obrazovka skrytá', await page.$eval('#btnFull', (b) => getComputedStyle(b).display === 'none'));
    check('kvíz: dotyková nápověda na úvodu', (await page.textContent('.keys')).includes('přejetí prstem'));
    let f = await fits(page);
    check('kvíz: hlavička a lišta se vejdou (na výšku)', !f.overflowX && f.outside.length === 0, JSON.stringify(f));
    await shot(page, '02-uvod');

    await swipe(page, -150);
    check('kvíz: přejetí doleva = další snímek', await page.evaluate(() => idx === 1));
    await swipe(page, 150);
    check('kvíz: přejetí doprava = zpět', await page.evaluate(() => idx === 0));
    await swipe(page, -20);
    check('kvíz: krátký pohyb nelistuje', await page.evaluate(() => idx === 0));

    await slideTo(page, '`${s.kind}`==="q" && s.name==="Historie" && s.no===2');
    await page.click('#btnHint'); await page.click('#btnAnswer');
    const bg = await page.evaluate(() => fetch(cur().node.style.backgroundImage.match(/url\("?([^")]+)/)[1]).then((r) => r.status + ' ' + r.headers.get('content-type')));
    check('kvíz: pozadí okruhu (.png → .jpg)', bg === '200 image/jpeg', bg);
    f = await fits(page);
    check('kvíz: otázka s nápovědou a odpovědí se vejde', !f.overflowX && f.outside.length === 0, JSON.stringify(f));
    check('kvíz: světlé pozadí okruhu přes celou plochu', await covers(page));
    await shot(page, '03-otazka');

    // Ukázka, která v telefonu je (Titanic) a která není (Pelíšky)
    await slideTo(page, 's.kind==="m" && s.no===1 && s.name==="Film"');
    await page.waitForFunction(() => cur().node.querySelector('video').readyState >= 1, null, { timeout: 8000 }).catch(() => {});
    check('ukázka: Titanic se načetl z aplikace', await page.evaluate(() => { const v = cur().node.querySelector('video'); return v.readyState >= 1 && /videos\/TITANIC\.mp4$/.test(v.currentSrc); }));
    await page.click('#btnA');
    await page.waitForTimeout(1200);
    check('ukázka: Přehrát pustí video', await page.evaluate(() => { const v = cur().node.querySelector('video'); return !v.paused && v.currentTime > 0.3; }));
    check('ukázka: bez hlášky o chybějícím souboru', await page.evaluate(() => !cur().node.querySelector('.err').classList.contains('on')));
    f = await fits(page);
    check('ukázka: rozvržení na výšku', !f.overflowX && f.outside.length === 0, JSON.stringify(f));
    await shot(page, '04-ukazka-vyska');

    await slideTo(page, 's.kind==="m" && s.no===2 && s.name==="Film"');
    await page.waitForFunction(() => cur().node.querySelector('.err').classList.contains('on'), null, { timeout: 8000 }).catch(() => {});
    check('ukázka: chybějící Pelíšky ukážou hlášku hned', await page.evaluate(() => cur().node.querySelector('.err').classList.contains('on')));
    check('ukázka: text tlačítka', (await page.textContent('.slide.on [data-err="folder"]')) === 'Načíst ukázky');
    await page.click('.slide.on [data-err="file"]');
    await page.click('.slide.on [data-err="folder"]');
    const calls = await page.evaluate(() => window.__calls);
    check('ukázka: Vybrat tento soubor → pickClip', calls.includes('pickClip:pelisky.mp4'), calls.join(','));
    check('ukázka: Načíst ukázky → importFiles', calls.filter((c) => c === 'importFiles').length >= 1);
    await shot(page, '05-ukazka-chybi');
    await page.evaluate(() => kvizImportDone({ copied: [{ label: 'Film 2 · pelisky.mp4', from: 'pelisky.mp4', exact: true }], failed: [], kept: 0, unused: 0, selected: 1, missing: ['Film 2 · pelisky.mp4'] }));
    check('ukázka: zpráva po nahrání v kvízu', (await page.textContent('#pickinfo')).includes('chybí 1 z 10'));

    // Skóre
    await slideTo(page, 's.kind==="score" && s.block===1');
    await page.fill('.scorebox input[data-t="0"][data-f="0"]', '7');
    check('skóre: součet týmu', (await page.textContent('.scorebox tr:nth-child(1) .total')) === '7');
    f = await fits(page);
    check('skóre: rozvržení na výšku', !f.overflowX && f.outside.length === 0, JSON.stringify(f));
    await shot(page, '06-skore');

    // Uložená pozice a návrat do menu
    const at = await page.evaluate(() => idx);
    await page.reload(); await page.waitForSelector('.appback');
    check('pozice: po znovuotevření pokračuje', await page.evaluate((at) => idx === at, at));
    await page.click('.appback');
    await page.waitForSelector('.quiz');
    const card = await page.locator('.quiz').first().textContent();
    check('menu: rozehraný kvíz', card.includes('Pokračovat') && card.includes('Rozehráno') && card.includes('Od začátku'));
    await page.click('[data-restart="kviz-boubin-01.html"]');
    await page.waitForSelector('.appback');
    check('pozice: Od začátku', await page.evaluate(() => idx === 0 && location.hash === ''));
    check('bez chyb JS (na výšku)', errors.length === 0, errors.join(' | '));

    // Na šířku
    const land = await browser.newContext({ viewport: { width: 915, height: 412 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    await land.addInitScript(bridge, STATE);
    const lp = await land.newPage();
    const lerr = [];
    lp.on('pageerror', (e) => lerr.push(String(e)));
    await lp.goto(base + '/kviz/kviz-boubin-01.html#od-zacatku');
    await lp.waitForSelector('.appback');
    for (const [name, pred] of [['uvod', 's.kind==="title"'], ['otazka', 's.kind==="q" && s.name==="Geografie" && s.no===5'],
      ['ukazka', 's.kind==="m" && s.no===1 && s.name==="Film"'], ['hudba', 's.kind==="m" && s.name==="Hudba" && s.no===1'],
      ['cas', 's.kind==="timer"'], ['reseni', 's.kind==="sol" && s.name==="Film"'], ['skore', 's.kind==="score"']]) {
      await slideTo(lp, pred);
      if (name === 'otazka') {
        await lp.click('#btnHint'); await lp.click('#btnAnswer');
        check('na šířku: světlé pozadí přes celou plochu', await covers(lp));
      }
      if (name === 'ukazka') {
        check('na šířku: ukázka a otázka vedle sebe', await lp.evaluate(() => {
          const g = document.querySelector('.slide.on .mediagrid'); return g.children[0].getBoundingClientRect().right <= g.children[1].getBoundingClientRect().left;
        }));
      }
      await lp.waitForTimeout(150);
      f = await fits(lp);
      check('na šířku: ' + name, !f.overflowX && f.outside.length === 0, JSON.stringify(f));
      await shot(lp, '1x-sirka-' + name);
    }
    check('bez chyb JS (na šířku)', lerr.length === 0, lerr.join(' | '));

    // Tablet na výšku a na šířku – původní rozvržení kvízu, jen bez tlačítka Celá obrazovka
    for (const [w, h] of [[800, 1280], [1280, 800]]) {
      const tc = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
      await tc.addInitScript(bridge, STATE);
      const tp = await tc.newPage();
      await tp.goto(base + '/kviz/kviz-boubin-02.html#od-zacatku');
      await tp.waitForSelector('.appback');
      for (const [name, pred] of [['otazka', 's.kind==="q" && s.name==="Historie" && s.no===1'], ['ukazka', 's.kind==="m"'], ['skore', 's.kind==="score"']]) {
        await slideTo(tp, pred);
        if (name === 'otazka') {
          await tp.click('#btnHint'); await tp.click('#btnAnswer');
          check(`tablet ${w}×${h}: světlé pozadí přes celou plochu`, await covers(tp));
        }
        f = await fits(tp);
        check(`tablet ${w}×${h}: ${name}`, !f.overflowX && f.outside.length === 0, JSON.stringify(f));
        await shot(tp, `2x-tablet-${w}-${name}`);
      }
      await tc.close();
    }

    // Každý snímek všech kvízů na menším telefonu (Samsung v Chromu): tlačítka nic nepřekrývá a obsah jde doposouvat
    for (const [w, h] of [[384, 740], [740, 360]]) {
      const pc = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2.6, hasTouch: true, isMobile: true });
      await pc.addInitScript(bridge, STATE);
      const pp = await pc.newPage();
      const bad = [];
      for (const q of quizzes) {
        await pp.goto(base + '/kviz/' + q.file + '#od-zacatku');
        await pp.waitForSelector('.appback');
        bad.push(...await pp.evaluate(() => {
          const out = [];
          for (let i = 0; i < slides.length; i++) {
            idx = i; render();
            const s = cur();
            s.node.querySelector('.opts')?.classList.remove('hidden');
            s.node.querySelector('.reveal')?.classList.add('on');
            const m = document.getElementById('main');
            for (const b of document.querySelectorAll('header button, footer button')) {
              if (!b.offsetParent) continue;
              const r = b.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              if (!hit || !b.contains(hit)) out.push(`${i}:${s.kind}:${b.id || b.className} zakryté`);
            }
            if (m.scrollHeight > m.clientHeight + 1 && !/auto|scroll/.test(getComputedStyle(m).overflowY)) out.push(`${i}:${s.kind}: obsah nejde posunout`);
            if (m.scrollTop !== 0) out.push(`${i}:${s.kind}: snímek nezačíná nahoře`);
            const c = s.node.firstElementChild.getBoundingClientRect(), mr = m.getBoundingClientRect();
            if (c.top < mr.top - 1) out.push(`${i}:${s.kind}: začátek obsahu je mimo dosah`);
            if (c.bottom > mr.top + m.scrollHeight + 1) out.push(`${i}:${s.kind}: konec obsahu je mimo dosah`);
            m.scrollTop = m.scrollHeight;
            if (document.documentElement.scrollWidth > innerWidth) out.push(`${i}:${s.kind}: vodorovné posouvání`);
          }
          return out;
        }));
      }
      check(`všechny snímky ${w}×${h}: tlačítka jdou stisknout, obsah jde posunout`, bad.length === 0, bad.slice(0, 8).join(', '));
      await pp.goto(base + '/kviz/kviz-boubin-01.html#od-zacatku'); await pp.waitForSelector('.appback');
      await slideTo(pp, 's.kind==="sol" && s.name==="Historie"');
      await shot(pp, `3x-${w}-reseni`);
      await pp.evaluate(() => { const m = document.getElementById('main'); m.scrollTop = m.scrollHeight; });
      await shot(pp, `3x-${w}-reseni-konec`);
      await pc.close();
    }

    // Všechny čtyři kvízy se otevřou bez chyb
    for (const q of quizzes) {
      const e2 = [];
      lp.removeAllListeners('pageerror'); lp.on('pageerror', (e) => e2.push(String(e)));
      await lp.goto(base + '/kviz/' + q.file + '#od-zacatku');
      await lp.waitForSelector('.appback');
      const n = await lp.evaluate(() => slides.length);
      check('kvíz ' + q.file, e2.length === 0 && n > 70, n + ' snímků ' + e2.join(' | '));
    }
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(ok ? '\nVše v pořádku.' : '\nNěco selhalo.');
  process.exit(ok ? 0 : 1);
})();
