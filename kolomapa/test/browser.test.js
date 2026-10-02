'use strict';
// Sdílený prohlížeč (src/sources/browser.js) proti podvrženému modulu playwright – bez skutečného Chromia a bez sítě.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const B = require('../src/sources/browser');

const ORIGIN = 'https://www.cyklobazar.cz';
const CHALLENGE_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'cyklobazar', 'challenge_okamzik.html'), 'utf8');
const NORMAL_HTML = `<!DOCTYPE html><html><head><title id="snippet-seo-title">Okamžik za 5 000 Kč | Cyklobazar.cz</title></head><body>
<script>var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';</script>
<div class="cf-turnstile" data-sitekey="x" data-require-turnstile="Potvrďte prosím, že nejste robot"></div>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></body></html>`;

/** Hodiny a pauzy bez skutečného čekání. */
function fakeClock(start = Date.parse('2026-10-02T10:00:00Z')) {
  let t = start;
  const sleeps = [];
  return {
    now: () => t,
    sleeps,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason || new Error('Přerušeno');
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

/**
 * Podvržený playwright: zaznamená spuštění, kontext, navigace a fetch uvnitř stránky.
 * @param {{homeTitles?: string[], homeStatus?: number, homeContent?: string, respond?: Function, clock?: object,
 *          launchError?: Error}} o
 */
function fakePlaywright(o = {}) {
  const rec = { launches: [], contexts: [], routes: [], initScripts: 0, gotos: [], evaluates: [], closed: 0, times: [] };
  const respond = o.respond || ((a) => ({ status: 200, url: a.url, text: `<html><title>OK</title><body>${a.url}</body></html>`, cfMitigated: null, contentType: 'text/html' }));
  const pw = {
    chromium: {
      async launch(opts) {
        if (o.launchError) throw o.launchError;
        rec.launches.push(opts);
        return {
          async newContext(c) {
            rec.contexts.push(c);
            return {
              async route(pattern, handler) {
                rec.routes.push({ pattern, handler });
              },
              async addInitScript() {
                rec.initScripts++;
              },
              async newPage() {
                let titleCalls = 0;
                return {
                  async goto(url) {
                    rec.gotos.push(url);
                    rec.times.push(['goto', o.clock ? o.clock.now() : 0]);
                    const status = o.homeStatus ?? 200;
                    return { status: () => status, headers: () => ({}) };
                  },
                  async title() {
                    const titles = o.homeTitles || ['Cyklobazar.cz – bazar kol'];
                    return titles[Math.min(titleCalls++, titles.length - 1)];
                  },
                  async content() {
                    return o.homeContent || '<html><body>Cyklobazar</body></html>';
                  },
                  async evaluate(fn, arg) {
                    assert.equal(typeof fn, 'function');
                    rec.evaluates.push(arg);
                    rec.times.push(['fetch', o.clock ? o.clock.now() : 0]);
                    return respond(arg);
                  },
                  isClosed: () => false,
                };
              },
            };
          },
          async close() {
            rec.closed++;
          },
        };
      },
    },
  };
  return { pw, rec };
}

function makeBrowser(o = {}) {
  const clock = o.clock || fakeClock();
  const { pw, rec } = fakePlaywright({ ...o, clock });
  const logs = [];
  const log = { warn: (m) => logs.push(['warn', m]), info: (m) => logs.push(['info', m]), debug: () => {} };
  const b = B.createBrowser({ config: o.config || {}, log, playwright: pw, env: o.env || {}, sleep: clock.sleep, now: clock.now, settleMs: 20000, pollMs: 1000 });
  return { b, rec, clock, logs };
}

test('chybí playwright → srozumitelná česká chyba s návodem', async () => {
  const requireFn = () => {
    const e = new Error("Cannot find module 'playwright'");
    e.code = 'MODULE_NOT_FOUND';
    throw e;
  };
  assert.throws(() => B.loadPlaywright({ requireFn }), (e) => e instanceof B.BrowserUnavailableError && e.message.startsWith(B.MISSING_MSG));
  assert.match(B.MISSING_MSG, /npm install a npx playwright install chromium/);
  await B.closeBrowser();
  await assert.rejects(() => B.getBrowser({ config: {}, requireFn }), /Cyklobazar potřebuje prohlížeč: v adresáři kolomapa spusťte npm install a npx playwright install chromium/);
  // modul bez chromium
  assert.throws(() => B.loadPlaywright({ requireFn: () => ({}) }), /npm install/);
});

test('spuštění: headless, cesta, argumenty, proxy z HTTPS_PROXY, locale cs-CZ – nic neskrývá automatizaci', async () => {
  const { b, rec, logs } = makeBrowser({
    config: {
      browserPath: '/opt/chromium/chrome',
      browserArgs: ['--ignore-certificate-errors-spki-list=ABC=', '--disable-blink-features=AutomationControlled', '--user-agent=Mozilla/5.0 Fake'],
    },
    env: { HTTPS_PROXY: 'http://uzivatel:tajne%40heslo@proxy.local:3128', NO_PROXY: 'localhost,127.0.0.1' },
  });
  await b.fetchHtml(`${ORIGIN}/kola`);
  assert.equal(rec.launches.length, 1);
  assert.deepEqual(rec.launches[0], {
    headless: true,
    args: ['--ignore-certificate-errors-spki-list=ABC='],
    executablePath: '/opt/chromium/chrome',
    proxy: { server: 'http://proxy.local:3128', username: 'uzivatel', password: 'tajne@heslo', bypass: 'localhost,127.0.0.1' },
  });
  assert.deepEqual(rec.contexts, [{ locale: 'cs-CZ' }]); // žádný vlastní User-Agent, viewport ani jiný otisk
  assert.equal(rec.initScripts, 0); // žádné úpravy navigator.webdriver apod.
  assert.equal(logs.filter(([l, m]) => l === 'warn' && /ignoruji/.test(m)).length, 2);
  // bez proxy a bez cesty
  assert.deepEqual(B.launchOptions({}, {}), { headless: true, args: [] });
  assert.equal(B.proxyFromEnv({}), undefined);
  assert.deepEqual(B.proxyFromEnv({ https_proxy: 'http://p:8080' }), { server: 'http://p:8080' });
  await b.close();
  assert.equal(rec.closed, 1);
});

test('zahřátí originu jednou, pak fetch() uvnitř stránky s cookies; referer jen ze stejného originu', async () => {
  const { b, rec } = makeBrowser();
  const r1 = await b.fetchHtml(`${ORIGIN}/kola`, { referer: `${ORIGIN}/`, minIntervalMs: 20000 });
  const r2 = await b.fetchHtml(`${ORIGIN}/kola?vp-page=2`, { referer: 'https://jiny-web.cz/', minIntervalMs: 20000 });
  assert.deepEqual(rec.gotos, [`${ORIGIN}/`]);
  assert.equal(rec.evaluates.length, 2);
  assert.equal(rec.evaluates[0].url, `${ORIGIN}/kola`);
  assert.equal(rec.evaluates[0].referer, `${ORIGIN}/`);
  assert.equal(rec.evaluates[1].referer, null);
  assert.match(rec.evaluates[0].accept, /text\/html/);
  assert.equal(r1.status, 200);
  assert.equal(r1.challenged, false);
  assert.match(r1.html, /\/kola<\/body>/);
  assert.equal(r2.url, `${ORIGIN}/kola?vp-page=2`);
  assert.deepEqual({ warmUps: b.stats.warmUps, requests: b.stats.requests, challenged: b.stats.challenged }, { warmUps: 1, requests: 2, challenged: 0 });
  // jiný origin = vlastní zahřátí
  await b.fetchHtml('https://example.org/x');
  assert.deepEqual(rec.gotos, [`${ORIGIN}/`, 'https://example.org/']);
  await assert.rejects(() => b.fetchHtml('http://www.cyklobazar.cz/kola'), /jen https/);
  await assert.rejects(() => b.fetchHtml('neni adresa'), /Neplatná adresa/);
});

test('pauza mezi požadavky na jeden origin (včetně úvodní stránky), souběžné požadavky jdou postupně', async () => {
  const { b, rec } = makeBrowser();
  await Promise.all([
    b.fetchHtml(`${ORIGIN}/a`, { minIntervalMs: 20000 }),
    b.fetchHtml(`${ORIGIN}/b`, { minIntervalMs: 20000 }),
    b.fetchHtml(`${ORIGIN}/c`, { minIntervalMs: 20000 }),
  ]);
  const t = rec.times.map(([, x]) => x);
  assert.equal(rec.times[0][0], 'goto');
  assert.equal(t.length, 4);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] >= 20000, `rozestup ${t[i] - t[i - 1]} ms`);
  assert.deepEqual(
    rec.evaluates.map((a) => a.url),
    [`${ORIGIN}/a`, `${ORIGIN}/b`, `${ORIGIN}/c`]
  );
  // příliš krátký interval se zvedne na 1 s
  const m = makeBrowser();
  await m.b.fetchHtml(`${ORIGIN}/a`, { minIntervalMs: 5 });
  await m.b.fetchHtml(`${ORIGIN}/b`, { minIntervalMs: 5 });
  const tt = m.rec.times.map(([, x]) => x);
  assert.ok(tt[2] - tt[1] >= 1000);
});

test('úvodní stránka s neviditelnou kontrolou Cloudflare: počká, až se ustálí (nic neřeší)', async () => {
  const { b, rec, clock } = makeBrowser({ homeTitles: ['Okamžik…', 'Okamžik…', 'Cyklobazar.cz – bazar kol'] });
  const r = await b.fetchHtml(`${ORIGIN}/kola`, { minIntervalMs: 20000 });
  assert.equal(r.challenged, false);
  assert.equal(rec.evaluates.length, 1);
  assert.ok(clock.sleeps.filter((ms) => ms === 1000).length >= 2);
});

test('úvodní stránka zůstane „Just a moment…“ → challenged, žádný fetch a origin je pro běh uzavřený', async () => {
  const { b, rec, logs } = makeBrowser({ homeTitles: ['Just a moment...'], homeStatus: 403 });
  const r = await b.fetchHtml(`${ORIGIN}/kola`);
  assert.equal(r.challenged, true);
  assert.equal(r.html, '');
  assert.equal(rec.evaluates.length, 0);
  const r2 = await b.fetchHtml(`${ORIGIN}/elektrokola`);
  assert.equal(r2.challenged, true);
  assert.equal(r2.skipped, true);
  assert.equal(rec.gotos.length, 1); // žádný další pokus
  assert.ok(logs.some(([l, m]) => l === 'warn' && /ověření neobcházím/.test(m)));
});

test('interaktivní ověření („Potvrďte, že jste člověk“) → konec hned, bez čekání', async () => {
  const { b, rec, clock } = makeBrowser({ homeTitles: ['Okamžik…'], homeContent: '<html><body><p>Potvrďte, že jste člověk, provedením níže uvedené akce.</p></body></html>' });
  const r = await b.fetchHtml(`${ORIGIN}/kola`);
  assert.equal(r.challenged, true);
  assert.equal(rec.evaluates.length, 0);
  assert.deepEqual(clock.sleeps, []);
});

test('odpověď s cf-mitigated: challenge → challenged a další požadavky na origin už nejdou', async () => {
  const { b, rec } = makeBrowser({
    respond: (a) =>
      a.url.endsWith('/kola?vp-page=2')
        ? { status: 403, url: a.url, text: CHALLENGE_HTML, cfMitigated: 'challenge' }
        : { status: 200, url: a.url, text: '<html><title>Výpis</title></html>', cfMitigated: null },
  });
  assert.equal((await b.fetchHtml(`${ORIGIN}/kola`)).challenged, false);
  const r = await b.fetchHtml(`${ORIGIN}/kola?vp-page=2`);
  assert.equal(r.challenged, true);
  assert.equal(r.status, 403);
  assert.equal(r.html, '');
  const r3 = await b.fetchHtml(`${ORIGIN}/kola?vp-page=3`);
  assert.equal(r3.challenged, true);
  assert.equal(rec.evaluates.length, 2);
  assert.equal(b.stats.challenged, 1);
});

test('rozpoznání ověřovací stránky: hlavička, titulek, obsah; běžná stránka s Turnstile ve formuláři ověřením není', () => {
  assert.equal(B.isChallengeResponse({ status: 403, cfMitigated: 'challenge', text: '' }), true);
  assert.equal(B.isChallengeResponse({ status: 403, cfMitigated: null, text: CHALLENGE_HTML }), true);
  assert.equal(B.isChallengeResponse({ status: 200, cfMitigated: null, text: '<html><head><title>Just a moment...</title></head></html>' }), true);
  assert.equal(B.isChallengeResponse({ status: 403, text: '<title>Attention Required! | Cloudflare</title>' }), true);
  assert.equal(B.isChallengeResponse({ status: 200, cfMitigated: null, text: NORMAL_HTML }), false);
  assert.equal(B.isChallengeResponse({ status: 200, cfMitigated: null, text: NORMAL_HTML + ' '.repeat(100000) }), false);
  assert.equal(B.isChallengeResponse({ status: 404, cfMitigated: null, text: '<title>Stránka nenalezena</title>' }), false);
  assert.equal(B.isChallengeTitle('Okamžik…'), true);
  assert.equal(B.isChallengeTitle('Okamžik za 5 000 Kč | Cyklobazar.cz'), false);
});

test('přerušení během pauzy zastaví požadavek', async () => {
  const clock = fakeClock();
  const ac = new AbortController();
  let block = false; // pauza, která skončí jen přerušením
  const sleep = (ms, signal) =>
    block
      ? new Promise((resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason);
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
      : clock.sleep(ms, signal);
  const { pw, rec } = fakePlaywright({ clock });
  const b = B.createBrowser({ config: {}, playwright: pw, env: {}, sleep, now: clock.now });
  await b.fetchHtml(`${ORIGIN}/a`, { minIntervalMs: 20000, signal: ac.signal });
  block = true;
  const p = b.fetchHtml(`${ORIGIN}/b`, { minIntervalMs: 20000, signal: ac.signal });
  setImmediate(() => ac.abort(new Error('Přerušeno uživatelem')));
  await assert.rejects(p, /Přerušeno uživatelem/);
  assert.equal(rec.evaluates.length, 1);
  await assert.rejects(() => b.fetchHtml(`${ORIGIN}/c`, { signal: ac.signal }), /Přerušeno uživatelem/);
});

test('chyba fetch() v prohlížeči a selhání spuštění Chromia', async () => {
  const { b } = makeBrowser({ respond: () => ({ error: 'Failed to fetch' }) });
  await assert.rejects(() => b.fetchHtml(`${ORIGIN}/kola`), /v prohlížeči selhalo: Failed to fetch/);
  const clock = fakeClock();
  const { pw } = fakePlaywright({ clock, launchError: new Error("Executable doesn't exist at /x/chrome\nmore") });
  const b2 = B.createBrowser({ config: {}, playwright: pw, env: {}, sleep: clock.sleep, now: clock.now });
  await assert.rejects(() => b2.fetchHtml(`${ORIGIN}/kola`), (e) => e instanceof B.BrowserUnavailableError && /Chromium nejde spustit: Executable doesn't exist/.test(e.message) && /npm install/.test(e.message));
  await assert.rejects(() => b2.fetchHtml(`${ORIGIN}/kola`), /Chromium nejde spustit/);
  await b2.close();
});

test('route: obrázky, písma a reklamy se nestahují, dokumenty, skripty a Cloudflare ano', async () => {
  const { b, rec } = makeBrowser();
  await b.fetchHtml(`${ORIGIN}/kola`);
  assert.equal(rec.routes.length, 1);
  const handler = rec.routes[0].handler;
  const run = async (url, type) => {
    let what = null;
    await handler({
      request: () => ({ url: () => url, resourceType: () => type }),
      abort: async () => {
        what = 'abort';
      },
      continue: async () => {
        what = 'continue';
      },
    });
    return what;
  };
  assert.equal(await run(`${ORIGIN}/uploads/items/2026/10/2/1/250_x.jpg`, 'image'), 'abort');
  assert.equal(await run(`${ORIGIN}/dist/fonts/a.woff2`, 'font'), 'abort');
  assert.equal(await run('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'script'), 'abort');
  assert.equal(await run(`${ORIGIN}/?do=cookieBar-hide`, 'fetch'), 'abort'); // signály Nette zakazuje robots.txt
  assert.equal(await run(`${ORIGIN}/`, 'document'), 'continue');
  assert.equal(await run(`${ORIGIN}/dist/main.js`, 'script'), 'continue');
  assert.equal(await run(`${ORIGIN}/cdn-cgi/challenge-platform/scripts/jsd/main.js`, 'script'), 'continue');
  assert.equal(await run('https://challenges.cloudflare.com/turnstile/v0/x.png', 'image'), 'continue');
});

test('inPageFetch: obyčejný fetch s cookies prohlížeče, vrací stav, text a cf-mitigated', async () => {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([url, init]);
    return {
      status: 403,
      url,
      text: async () => 'tělo',
      headers: { get: (h) => ({ 'cf-mitigated': 'challenge', 'content-type': 'text/html' })[h.toLowerCase()] ?? null },
    };
  };
  try {
    const r = await B.inPageFetch({ url: `${ORIGIN}/kola`, referer: `${ORIGIN}/`, accept: 'text/html', timeoutMs: 1000 });
    assert.deepEqual(r, { status: 403, url: `${ORIGIN}/kola`, text: 'tělo', cfMitigated: 'challenge', contentType: 'text/html' });
    assert.equal(calls[0][1].credentials, 'include');
    assert.equal(calls[0][1].referrer, `${ORIGIN}/`);
    assert.deepEqual(calls[0][1].headers, { Accept: 'text/html' });
    globalThis.fetch = async () => {
      throw new Error('Failed to fetch');
    };
    assert.deepEqual(await B.inPageFetch({ url: `${ORIGIN}/kola` }), { error: 'Failed to fetch' });
  } finally {
    globalThis.fetch = orig;
  }
});

test('getBrowser je sdílený a líný, closeBrowser ho zavře (i opakovaně a bez spuštění)', async () => {
  await B.closeBrowser();
  const clock = fakeClock();
  const { pw, rec } = fakePlaywright({ clock });
  const opts = { config: {}, playwright: pw, env: {}, sleep: clock.sleep, now: clock.now };
  const a = await B.getBrowser(opts);
  const b = await B.getBrowser(opts);
  assert.equal(a, b);
  assert.equal(rec.launches.length, 0); // líně – zatím nic nespuštěno
  await a.fetchHtml(`${ORIGIN}/kola`);
  assert.equal(rec.launches.length, 1);
  await B.closeBrowser();
  assert.equal(rec.closed, 1);
  assert.equal(a.closed, true);
  await assert.rejects(() => a.fetchHtml(`${ORIGIN}/kola`), /zavřený/);
  await B.closeBrowser();
  const c = await B.getBrowser(opts);
  assert.notEqual(c, a);
  await B.closeBrowser(); // nespuštěný – nic se nezavírá
  assert.equal(rec.closed, 1);
});
