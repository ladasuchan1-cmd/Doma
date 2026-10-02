'use strict';
// Šetrný HTTP klient pro stahování inzerátů.
//  - mezi požadavky na stejný web drží pauzu (delayMs, s malým náhodným rozptylem),
//  - opakuje při 429 / 5xx / síťové chybě s rostoucí pauzou (respektuje Retry-After),
//  - timeout na požadavek, přerušení přes AbortSignal,
//  - posílá běžný prohlížečový User-Agent a češtinu v Accept-Language.

// Poctivá identifikace robota (žádné vydávání se za prohlížeč) – weby podle ní mohou uplatnit svá pravidla.
const DEFAULT_UA = 'Mozilla/5.0 (compatible; Kolomapa/1.0; +https://github.com/ladasuchan1-cmd/Doma)';

class HttpError extends Error {
  constructor(message, { status = 0, url = '', body = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** Registrovatelná doména pro šetrné pauzy: „sport.bazos.cz“ → „bazos.cz“, „d46-a.sdn.cz“ → „sdn.cz“. */
function siteOf(url) {
  const h = new URL(url).hostname.toLowerCase();
  if (/^[\d.]+$/.test(h) || h === 'localhost' || h.includes(':')) return h;
  const parts = h.split('.');
  return parts.slice(-2).join('.');
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Přerušeno'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason || new Error('Přerušeno'));
      },
      { once: true }
    );
  });

/**
 * Vytvoří klienta. Jeden klient sdílí pauzy pro všechny požadavky (po hostitelích).
 * @param {{delayMs?: number, timeoutMs?: number, retries?: number, userAgent?: string, log?: object, signal?: AbortSignal,
 *          fetchImpl?: typeof fetch, sleepImpl?: Function}} [opts]
 */
function createHttp(opts = {}) {
  const delayMs = opts.delayMs ?? 1200;
  const timeoutMs = opts.timeoutMs ?? 30000;
  const retries = opts.retries ?? 3;
  const ua = opts.userAgent || process.env.KOLOMAPA_USER_AGENT || DEFAULT_UA;
  const log = opts.log;
  const fetchImpl = opts.fetchImpl || fetch;
  const sleepFn = opts.sleepImpl || sleep;
  const lastAt = new Map(); // doména (bazos.cz) → čas posledního požadavku – sport.bazos.cz a www.bazos.cz jsou jeden web
  let requests = 0;

  async function waitTurn(host, signal) {
    const prev = lastAt.get(host) || 0;
    const jitter = delayMs > 0 ? Math.round(delayMs * 0.25 * Math.random()) : 0;
    const wait = prev + delayMs + jitter - Date.now();
    if (wait > 0) await sleepFn(wait, signal);
    lastAt.set(host, Date.now());
  }

  /**
   * Stáhne URL. Vrací {status, url, headers, text(), json(), buffer()} – tělo je už načtené.
   * @param {string} url
   * @param {{method?: string, headers?: object, body?: any, accept?: string, okStatuses?: number[], signal?: AbortSignal}} [o]
   */
  async function request(url, o = {}) {
    const signal = o.signal || opts.signal;
    const host = siteOf(url);
    let attempt = 0;
    for (;;) {
      await waitTurn(host, signal);
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(new Error(`Vypršel čas ${timeoutMs} ms`)), timeoutMs);
      let res;
      let buf;
      try {
        requests++;
        res = await fetchImpl(url, {
          method: o.method || 'GET',
          headers: {
            'User-Agent': ua,
            'Accept-Language': 'cs-CZ,cs;q=0.9,en;q=0.6',
            Accept: o.accept || 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            ...(o.headers || {}),
          },
          body: o.body,
          redirect: 'follow',
          signal: ctrl.signal,
        });
        buf = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) throw signal.reason || e;
        if (attempt < retries) {
          attempt++;
          const pause = Math.min(60000, 2000 * 2 ** (attempt - 1));
          log?.warn?.('Síťová chyba, zkusím znovu', { url, attempt, pause, error: e.cause?.code || e.message });
          await sleepFn(pause, signal);
          continue;
        }
        throw new HttpError(`Nelze stáhnout ${url}: ${e.cause?.code || e.message}`, { url });
      }
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const status = res.status;
      const ok = (status >= 200 && status < 300) || (o.okStatuses || []).includes(status);
      if (!ok && (status === 429 || status >= 500) && attempt < retries) {
        attempt++;
        const ra = Number(res.headers.get('retry-after'));
        const pause = Number.isFinite(ra) && ra > 0 ? Math.min(120000, ra * 1000) : Math.min(60000, 3000 * 2 ** (attempt - 1));
        log?.warn?.('Web odpověděl chybou, zkusím znovu', { url, status, attempt, pause });
        await sleepFn(pause, signal);
        continue;
      }
      const text = () => buf.toString('utf8');
      if (!ok) throw new HttpError(`HTTP ${status} pro ${url}`, { status, url, body: text().slice(0, 500) });
      return {
        status,
        url: res.url || url,
        headers: res.headers,
        buffer: () => buf,
        text,
        json: () => JSON.parse(text()),
      };
    }
  }

  return {
    request,
    get: (url, o) => request(url, o),
    async text(url, o) {
      return (await request(url, o)).text();
    },
    async json(url, o) {
      return (await request(url, { accept: 'application/json', ...o })).json();
    },
    get requests() {
      return requests;
    },
    userAgent: ua,
  };
}

module.exports = { createHttp, HttpError, sleep, siteOf, DEFAULT_UA };
