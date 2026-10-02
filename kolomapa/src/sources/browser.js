'use strict';
// Sdílený prohlížeč (Playwright Chromium) pro zdroje za Cloudflare – dnes jen Cyklobazar (requiresBrowser: true).
//
// Proč prohlížeč: cyklobazar.cz chrání Cloudflare; obyčejný HTTP klient dostane na HTML i sitemapy vždy
// 403 „cf-mitigated: challenge“. Běžný prohlížeč projde neviditelnou JS kontrolou úvodní stránky stejně jako každý
// návštěvník. Balíček `playwright` je VOLITELNÁ závislost – bez něj getBrowser() vyhodí srozumitelnou chybu a zdroj se
// pro běh přeskočí.
//
// Zásady (nevyjednatelné):
//  - Obyčejný Playwright Chromium bez úprav: žádné „stealth“ pluginy, žádné --disable-blink-features=Automation-
//    Controlled (ani z KOLOMAPA_BROWSER_ARGS – takové argumenty se zahodí), žádné přepisování navigator.webdriver,
//    User-Agentu či jiného otisku, žádné addInitScript, žádné řešení CAPTCHA/Turnstile, žádné přenášení cookies mimo
//    prohlížeč, žádné střídání proxy (jen pevná HTTPS_PROXY prostředí, je-li nastavená). Prohlížeč se představuje
//    tak, jak je (HeadlessChrome).
//  - Když Cloudflare požádá o ověření (HTTP 403 + cf-mitigated: challenge, stránka „Just a moment…“ / „Okamžik…“ /
//    „Potvrďte, že jste člověk“), vrátí fetchHtml challenged: true, origin se pro zbytek běhu uzavře (další požadavky
//    na něj už nejdou) a zdroj musí skončit. Ověření se nikdy neřeší ani neobchází.
//  - Šetrnost: mezi požadavky na jeden origin drží pauzu minIntervalMs (zadává zdroj – Cyklobazar 20 s; úvodní
//    stránka se počítá taky). Obrázky, média, písma a reklamy se nestahují (route.abort – jen menší zátěž webu, nic
//    neskrývá); skripty a kontroly Cloudflare (/cdn-cgi/, challenges.cloudflare.com) se nikdy neblokují.
//
// Postup: pro každý origin jednou otevře úvodní stránku (jako člověk v prohlížeči) a počká, až se ustálí (titulek
// přestane být „Just a moment…“ / „Okamžik…“, nejvýš ~20 s – nic se neklikne ani nevyplní). Další HTML stahuje
// fetch()em uvnitř té stránky (credentials: 'include') – stejný prohlížeč a cookies, žádné další navigace.
//
// Testy: getBrowser({playwright}) / createBrowser({playwright, sleep, now}) přijmou podvržený modul playwright.

const MISSING_MSG = 'Cyklobazar potřebuje prohlížeč: v adresáři kolomapa spusťte npm install a npx playwright install chromium';
const DEFAULT_MIN_INTERVAL_MS = 20000;
/** Nikdy víc než jeden požadavek za sekundu na jeden web, ať zdroj zadá cokoli. */
const MIN_INTERVAL_FLOOR_MS = 1000;
const SETTLE_MS = 20000;
const POLL_MS = 1000;
const NAV_TIMEOUT_MS = 60000;
const FETCH_TIMEOUT_MS = 90000;
const ACCEPT_HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

// Argumenty, které by skrývaly automatizaci nebo měnily identitu prohlížeče – nikdy je nepředáme.
const FORBIDDEN_ARG_RX = /AutomationControlled|^--user-agent(=|$)|^--disable-web-security|^--remote-debugging/i;
// Co se nestahuje (jen šetří web): obrázky, média, písma a reklamní/analytické servery.
const SKIP_RESOURCE_TYPES = new Set(['image', 'media', 'font']);
const AD_RX = /googlesyndication|doubleclick|googletagmanager|google-analytics|googleadservices|adservice\.google|fundingchoicesmessages|facebook\.(net|com)|connect\.facebook|hotjar|\.seznam\.cz\/(ssp|rs)|ssp\.seznam|imedia\.cz/i;
const CLOUDFLARE_RX = /^https:\/\/challenges\.cloudflare\.com\/|\/cdn-cgi\//i;

// Rozpoznání ověřovací stránky Cloudflare. Pozor: běžné stránky Cyklobazaru obsahují skript
// /cdn-cgi/challenge-platform/scripts/jsd/main.js i formulář s Turnstile („Potvrďte prosím, že nejste robot“) –
// ty ověřením nejsou. Ověřovací stránka má titulek „Just a moment…“ / „Okamžik…“, window._cf_chl_opt a
// /cdn-cgi/challenge-platform/h/…/orchestrate.
// Titulky se porovnávají celé – inzerát „Okamžik …“ má titulek „Okamžik za 5 000 Kč | Cyklobazar.cz“.
const CHALLENGE_TITLE_RX = /^\s*(just a moment(\.{3}|…)?|okamžik(\.{3}|…)?|attention required! \| cloudflare|one more step|checking your browser.*|access denied \|.*cloudflare.*|.*used cloudflare to restrict access)\s*$/i;
const CHALLENGE_BODY_RX = /window\._cf_chl_opt|\/cdn-cgi\/challenge-platform\/h\/|potvrďte,\s*že\s*jste\s*člověk|verify\s+you\s+are\s+human|cf-error-details|sorry, you have been blocked/i;
const INTERACTIVE_RX = /potvrďte,\s*že\s*jste\s*člověk|verify\s+you\s+are\s+human/i;

class BrowserUnavailableError extends Error {
  constructor(detail) {
    super(detail ? `${MISSING_MSG} (${detail})` : MISSING_MSG);
    this.name = 'BrowserUnavailableError';
    this.fatal = true;
  }
}

const defaultSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Přerušeno'));
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(t);
      reject(signal.reason || new Error('Přerušeno'));
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new Error('Přerušeno');
}

/** Počká na promise, ale skončí hned při přerušení (promise samotný doběhne na pozadí). */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  promise.catch(() => {});
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error('Přerušeno'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      }
    );
  });
}

const firstLine = (s) => String(s ?? '').split('\n')[0].slice(0, 300);

/**
 * Načte modul playwright (volitelná závislost). Chybí-li, vyhodí BrowserUnavailableError s návodem.
 * @param {{playwright?: object, requireFn?: Function}} [o] playwright = podvržený modul (testy)
 */
function loadPlaywright({ playwright, requireFn = require } = {}) {
  if (playwright) return playwright;
  let pw;
  try {
    pw = requireFn('playwright');
  } catch (e) {
    throw new BrowserUnavailableError(e && e.code === 'MODULE_NOT_FOUND' ? 'balíček playwright není nainstalovaný' : firstLine(e?.message));
  }
  if (!pw || !pw.chromium || typeof pw.chromium.launch !== 'function') throw new BrowserUnavailableError('balíček playwright nemá chromium');
  return pw;
}

/** Proxy z HTTPS_PROXY (jedna pevná proxy prostředí; přihlašovací údaje z URL zvlášť, jak chce Playwright). */
function proxyFromEnv(env = process.env) {
  const raw = env.HTTPS_PROXY || env.https_proxy || null;
  if (!raw || !String(raw).trim()) return undefined;
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return { server: String(raw).trim() };
  }
  const out = { server: `${u.protocol}//${u.host}` };
  if (u.username) out.username = decodeURIComponent(u.username);
  if (u.password) out.password = decodeURIComponent(u.password);
  const bypass = env.NO_PROXY || env.no_proxy;
  if (bypass && String(bypass).trim()) out.bypass = String(bypass).trim();
  return out;
}

/**
 * Volby pro chromium.launch(): headless, cesta z KOLOMAPA_BROWSER, argumenty z KOLOMAPA_BROWSER_ARGS (bez argumentů
 * skrývajících automatizaci), proxy z HTTPS_PROXY. Nic dalšího – žádné úpravy otisku.
 * @param {object} [config]
 * @param {Record<string, string|undefined>} [env]
 * @param {{warn?: Function}} [log]
 */
function launchOptions(config = {}, env = process.env, log = null) {
  const args = [];
  for (const a of Array.isArray(config.browserArgs) ? config.browserArgs : []) {
    const s = String(a ?? '').trim();
    if (!s) continue;
    if (FORBIDDEN_ARG_RX.test(s)) {
      log?.warn?.(`Argument prohlížeče „${s}“ ignoruji – Kolomapa nic neskrývá ani neobchází`);
      continue;
    }
    args.push(s);
  }
  const opts = { headless: true, args };
  if (config.browserPath) opts.executablePath = config.browserPath;
  const proxy = proxyFromEnv(env);
  if (proxy) opts.proxy = proxy;
  return opts;
}

/** Je titulek stránky ověřovací stránkou Cloudflare? */
function isChallengeTitle(title) {
  return CHALLENGE_TITLE_RX.test(String(title ?? ''));
}

function titleOf(html) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(String(html ?? '').slice(0, 65536));
  return m ? m[1].replace(/&hellip;/g, '…').trim() : '';
}

/**
 * Je odpověď ověření / blokace Cloudflare? Hlavička cf-mitigated: challenge, nebo (u chybového stavu či malé
 * stránky) titulek / značky ověřovací stránky. Velké běžné stránky webu (výpis ~280 kB, detail ~220 kB) se podle
 * obsahu neposuzují – obsahují skript Cloudflare i Turnstile v kontaktním formuláři.
 * @param {{status?: number, cfMitigated?: string|null, text?: string}} r
 */
function isChallengeResponse(r) {
  if (!r) return false;
  if (String(r.cfMitigated ?? '').toLowerCase() === 'challenge') return true;
  const text = String(r.text ?? '');
  if (isChallengeTitle(titleOf(text))) return true;
  const suspicious = r.status === 403 || r.status === 429 || r.status === 503 || text.length < 65536;
  return suspicious && CHALLENGE_BODY_RX.test(text.slice(0, 65536));
}

/**
 * Běží UVNITŘ stránky (page.evaluate): obyčejný fetch() téhož originu s cookies prohlížeče. Nesmí používat nic
 * z okolního kódu (Playwright ji přenese jako text).
 * @param {{url: string, referer?: string|null, accept?: string, timeoutMs?: number}} a
 */
async function inPageFetch(a) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), a.timeoutMs || 90000);
  try {
    const init = { credentials: 'include', signal: ctrl.signal, headers: { Accept: a.accept || '*/*' } };
    if (a.referer) init.referrer = a.referer;
    const res = await fetch(a.url, init);
    const text = await res.text();
    return {
      status: res.status,
      url: res.url,
      text,
      cfMitigated: res.headers.get('cf-mitigated'),
      contentType: res.headers.get('content-type'),
    };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Vytvoří (nesdílenou) instanci prohlížeče. Chromium se spustí líně až při prvním fetchHtml().
 * @param {{config?: object, log?: object, playwright?: object, env?: object, sleep?: Function, now?: Function,
 *          settleMs?: number, pollMs?: number, navTimeoutMs?: number, fetchTimeoutMs?: number,
 *          minIntervalMs?: number}} [opts]
 * @returns {{fetchHtml: Function, close: Function, stats: object, readonly closed: boolean}}
 */
function createBrowser(opts = {}) {
  const config = opts.config || {};
  const log = opts.log || null;
  const pw = loadPlaywright(opts);
  const env = opts.env || process.env;
  const sleep = opts.sleep || defaultSleep;
  const now = opts.now || Date.now;
  const settleMs = opts.settleMs ?? SETTLE_MS;
  const pollMs = opts.pollMs ?? POLL_MS;
  const navTimeoutMs = opts.navTimeoutMs ?? NAV_TIMEOUT_MS;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  const defaultInterval = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const stats = { launches: 0, warmUps: 0, requests: 0, challenged: 0 };
  const origins = new Map(); // origin → {page, warm, challenged, challengeStatus, lastAt, queue}
  let launching = null;
  let browser = null;
  let context = null;
  let closed = false;

  function routeHandler(route) {
    let url = '';
    let type = '';
    try {
      const req = route.request();
      url = req.url();
      type = req.resourceType();
    } catch {
      /* požadavek už neexistuje */
    }
    const p = !CLOUDFLARE_RX.test(url) && (SKIP_RESOURCE_TYPES.has(type) || AD_RX.test(url)) ? route.abort() : route.continue();
    return Promise.resolve(p).catch(() => {});
  }

  async function ensureContext() {
    if (closed) throw new Error('Prohlížeč pro Cyklobazar už je zavřený');
    if (!launching) {
      launching = (async () => {
        let b;
        stats.launches++;
        try {
          b = await pw.chromium.launch(launchOptions(config, env, log));
        } catch (e) {
          throw new BrowserUnavailableError(`Chromium nejde spustit: ${firstLine(e?.message)}`);
        }
        browser = b;
        const c = await b.newContext({ locale: 'cs-CZ' });
        if (typeof c.route === 'function') await c.route('**/*', routeHandler);
        context = c;
        log?.debug?.('Prohlížeč (Chromium) spuštěn');
        return c;
      })();
      // Selhání spuštění platí pro celý běh (každý další požadavek by jen znovu selhal).
      launching.catch(() => {});
    }
    return launching;
  }

  function originState(origin) {
    let o = origins.get(origin);
    if (!o) origins.set(origin, (o = { page: null, warm: false, challenged: false, challengeStatus: 0, lastAt: 0, queue: Promise.resolve() }));
    return o;
  }

  async function pace(o, intervalMs, signal) {
    const wait = o.lastAt + intervalMs - now();
    if (o.lastAt && wait > 0) await sleep(wait, signal);
    throwIfAborted(signal);
    o.lastAt = now();
  }

  async function pageTitle(page) {
    try {
      return String((await page.title()) ?? '');
    } catch {
      return '';
    }
  }

  async function pageLooksInteractive(page) {
    try {
      return INTERACTIVE_RX.test(String((await page.content()) ?? '').slice(0, 200000));
    } catch {
      return false;
    }
  }

  function markChallenged(o, origin, status, url, why) {
    o.challenged = true;
    o.challengeStatus = status || 403;
    stats.challenged++;
    log?.warn?.(`Cloudflare žádá ověření prohlížeče (${why}) – ${origin} pro tento běh končím, ověření neobcházím`, { url, status });
  }

  /** Úvodní stránka originu (jednou za běh): počká, až se ustálí; ověření s Turnstile → challenged. */
  async function warmUp(o, origin, intervalMs, signal) {
    const ctx = await ensureContext();
    if (!o.page) o.page = await ctx.newPage();
    await pace(o, intervalMs, signal);
    stats.warmUps++;
    const home = `${origin}/`;
    const resp = await raceAbort(Promise.resolve(o.page.goto(home, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs })), signal);
    const status = resp && typeof resp.status === 'function' ? resp.status() : 0;
    let title = await pageTitle(o.page);
    const deadline = now() + settleMs;
    // Neviditelná JS kontrola Cloudflare proběhne sama (jako u každého návštěvníka); interaktivní ověření
    // („Potvrďte, že jste člověk“) se neřeší – končíme hned.
    while (isChallengeTitle(title) && now() < deadline && !(await pageLooksInteractive(o.page))) {
      await sleep(pollMs, signal);
      title = await pageTitle(o.page);
    }
    o.lastAt = now(); // pauza do dalšího požadavku až od ustálení úvodní stránky
    if (isChallengeTitle(title)) {
      markChallenged(o, origin, status || 403, home, `úvodní stránka „${title || '?'}“`);
      return;
    }
    if (status >= 400) {
      // Chybový stav úvodní stránky: blokace Cloudflare (1020/1015) je poznat z obsahu; jinak (prošlá kontrola
      // vrátí 403 jen u první odpovědi a stránka se pak načte znovu) pokračujeme.
      let html = '';
      try {
        html = String((await o.page.content()) ?? '');
      } catch {
        /* stránka nedostupná */
      }
      if (CHALLENGE_BODY_RX.test(html.slice(0, 200000))) {
        markChallenged(o, origin, status, home, `úvodní stránka HTTP ${status}`);
        return;
      }
    }
    o.warm = true;
    log?.debug?.(`Prohlížeč: úvodní stránka ${origin} načtena`, { status, title });
  }

  /**
   * Stáhne stránku jako text fetch()em uvnitř prohlížeče (po zahřátí originu). Požadavky na jeden origin jdou
   * postupně s pauzou minIntervalMs.
   * @param {string} url
   * @param {{referer?: string, minIntervalMs?: number, signal?: AbortSignal, accept?: string, timeoutMs?: number}} [o]
   * @returns {Promise<{status: number, html: string, challenged: boolean, url: string, cfMitigated?: string|null,
   *          contentType?: string|null, skipped?: boolean}>}
   */
  function fetchHtml(url, o = {}) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return Promise.reject(new Error(`Neplatná adresa: ${url}`));
    }
    if (u.protocol !== 'https:') return Promise.reject(new Error(`Prohlížeč stahuje jen https:// (${url})`));
    const origin = u.origin;
    const st = originState(origin);
    const intervalMs = Math.max(MIN_INTERVAL_FLOOR_MS, Number(o.minIntervalMs) || defaultInterval);
    const signal = o.signal;
    const job = async () => {
      if (st.challenged) return { status: st.challengeStatus, html: '', challenged: true, url: u.href, skipped: true };
      throwIfAborted(signal);
      if (!st.warm) {
        await warmUp(st, origin, intervalMs, signal);
        if (st.challenged) return { status: st.challengeStatus, html: '', challenged: true, url: u.href };
      }
      await pace(st, intervalMs, signal);
      stats.requests++;
      let referer = null;
      try {
        if (o.referer && new URL(o.referer).origin === origin) referer = new URL(o.referer).href;
      } catch {
        /* neplatný referer se nepošle */
      }
      const r = await raceAbort(
        Promise.resolve(st.page.evaluate(inPageFetch, { url: u.href, referer, accept: o.accept || ACCEPT_HTML, timeoutMs: o.timeoutMs || fetchTimeoutMs })),
        signal
      );
      if (!r || r.error) {
        if (st.page && typeof st.page.isClosed === 'function' && st.page.isClosed()) {
          st.page = null;
          st.warm = false;
        }
        throw new Error(`Stažení ${u.href} v prohlížeči selhalo: ${r ? r.error : 'bez odpovědi'}`);
      }
      const res = { status: Number(r.status) || 0, url: r.url || u.href, text: String(r.text ?? ''), cfMitigated: r.cfMitigated ?? null, contentType: r.contentType ?? null };
      if (isChallengeResponse(res)) {
        markChallenged(st, origin, res.status, u.href, `HTTP ${res.status}${res.cfMitigated ? `, cf-mitigated: ${res.cfMitigated}` : ''}`);
        return { status: res.status || 403, html: '', challenged: true, url: res.url, cfMitigated: res.cfMitigated };
      }
      return { status: res.status, html: res.text, challenged: false, url: res.url, cfMitigated: res.cfMitigated, contentType: res.contentType };
    };
    const p = st.queue.then(job);
    st.queue = p.catch(() => {});
    return p;
  }

  async function close() {
    if (closed) return;
    closed = true;
    const b = browser;
    browser = null;
    context = null;
    origins.clear();
    if (!b && launching) {
      try {
        await launching;
      } catch {
        /* spuštění selhalo – není co zavírat */
      }
    }
    const toClose = b || browser;
    if (toClose && typeof toClose.close === 'function') {
      try {
        await toClose.close();
      } catch (e) {
        log?.debug?.('Prohlížeč se nepodařilo zavřít', { error: e.message });
      }
    }
  }

  return {
    fetchHtml,
    close,
    stats,
    get closed() {
      return closed;
    },
  };
}

let shared = null;

/**
 * Sdílená instance prohlížeče (líně spuštěná při prvním požadavku). Chybí-li playwright, vyhodí chybu s návodem
 * (zdroj se pro běh přeskočí). Po běhu zavřít přes closeBrowser().
 * @param {{config?: object, log?: object, playwright?: object, env?: object}} [opts]
 */
async function getBrowser(opts = {}) {
  if (shared && !shared.closed) return shared;
  shared = createBrowser(opts);
  return shared;
}

/** Zavře sdílený prohlížeč (bezpečné volat opakovaně i bez spuštění). */
async function closeBrowser() {
  const b = shared;
  shared = null;
  if (b) await b.close();
}

module.exports = {
  getBrowser,
  closeBrowser,
  createBrowser,
  loadPlaywright,
  launchOptions,
  proxyFromEnv,
  isChallengeResponse,
  isChallengeTitle,
  inPageFetch,
  BrowserUnavailableError,
  MISSING_MSG,
  DEFAULT_MIN_INTERVAL_MS,
};
