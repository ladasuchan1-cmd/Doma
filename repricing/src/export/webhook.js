'use strict';
// Odeslání změn cen do adminu webhookem (SPEC §7 webhook.js).
//
//  - POST na `url`; tělo JSON = toJson(rows) (výchozí), XML = toXml(rows, template), případně CSV.
//  - Opakování: 2× s prodlevou 500 ms a 2 s při síťové chybě (vč. vypršení času), HTTP 5xx, 408 a 429.
//    Jiné 4xx se neopakují (chyba konfigurace / odmítnutí – opakování nepomůže).
//  - Přesměrování 307/308 v rámci stejného původu se následují (max. 3, se stejným tělem); 301/302/303 a přesměrování
//    na jiný server = chyba – fetch by z POST udělal GET bez těla a hlásil falešný úspěch, resp. poslal hlavičky
//    s tajemstvím cizímu serveru.
//  - Funkce NIKDY nevyhazuje výjimku – výsledek {ok, status, body (prvních 2 KB odpovědi), duration_ms, attempts, error?}.

const { toJson, toXml, toCsv } = require('./feeds');

const BODY_LIMIT = 2048;
const DEFAULT_DELAYS = [500, 2000];
const MAX_REDIRECTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Hlavičky ze settings: objekt, JSON řetězec nebo řádky „Název: hodnota“. */
function parseWebhookHeaders(h) {
  if (h == null || h === '') return {};
  if (typeof h === 'string') {
    const s = h.trim();
    if (!s) return {};
    if (s.startsWith('{')) {
      try {
        return parseWebhookHeaders(JSON.parse(s));
      } catch {
        throw new Error('Hlavičky webhooku nejsou platný JSON');
      }
    }
    const out = {};
    for (const line of s.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  }
  if (typeof h !== 'object' || Array.isArray(h)) throw new Error('Hlavičky webhooku musí být objekt {název: hodnota}');
  const out = {};
  for (const [k, v] of Object.entries(h)) if (v != null) out[String(k).trim()] = String(v);
  return out;
}

/** Přečte nejvýše BODY_LIMIT bajtů těla odpovědi a zbytek zahodí. */
async function readHead(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < BODY_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).subarray(0, BODY_LIMIT);
  // oříznutí mohlo rozdělit vícebajtový znak → náhradní znak na konci pryč
  return new TextDecoder('utf-8').decode(buf).replace(/\uFFFD+$/, '');
}

function describeError(e, timeoutMs) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return `Vypršel časový limit ${timeoutMs} ms`;
  const code = e && (e.cause?.code || e.code);
  if (code === 'ECONNREFUSED') return 'Spojení odmítnuto (server neběží nebo je chybná adresa/port)';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Adresu serveru nelze přeložit (DNS)';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'Spojení bylo přerušeno';
  if (code && (String(code).startsWith('CERT') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN')) return `Chyba certifikátu HTTPS (${code})`;
  const msg = e && (e.cause?.message || e.message);
  return msg ? `Síťová chyba: ${msg}` : 'Síťová chyba';
}

const isRetryableStatus = (s) => s >= 500 || s === 408 || s === 429;

/** Jeden pokus včetně následování 307/308. */
async function attempt(url, init, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  for (let hop = 0; ; hop++) {
    const res = await fetch(current, { ...init, redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      res.body?.cancel().catch(() => {});
      if ((res.status === 307 || res.status === 308) && location && hop < MAX_REDIRECTS) {
        const next = new URL(location, current);
        // jen v rámci stejného původu – hlavičky (Authorization, API klíč) nesmí odejít na cizí server
        if (next.origin === new URL(url).origin) {
          current = next.toString();
          continue;
        }
      }
      return { status: res.status, body: '', redirect: location || null };
    }
    const body = await readHead(res);
    return { status: res.status, body };
  }
}

/**
 * Odešle řádky exportu webhookem.
 * @param {object[]} rows řádky z exportRows
 * @param {{url: string, format?: 'json'|'xml'|'csv', headers?: object|string, timeout_ms?: number, template?: object,
 *   retries?: number, retry_delays_ms?: number[], now?: Date|string, currency?: string}} opts
 *   retries (výchozí 2) a retry_delays_ms (výchozí [500, 2000]) jsou hlavně pro testy.
 * @returns {Promise<{ok: boolean, status: number|null, body: string, duration_ms: number, attempts: number, error?: string}>}
 */
async function pushWebhook(rows, opts = {}) {
  const t0 = Date.now();
  const result = (extra) => ({ ok: false, status: null, body: '', attempts: 0, ...extra, duration_ms: Date.now() - t0 });
  try {
    const o = opts || {};
    let url;
    try {
      url = new URL(String(o.url || '').trim());
    } catch {
      return result({ error: 'Není nastavena platná URL webhooku' });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return result({ error: 'URL webhooku musí začínat http:// nebo https://' });

    const format = String(o.format || 'json').toLowerCase();
    let body;
    let contentType;
    if (format === 'json') {
      body = JSON.stringify(toJson(rows || [], { now: o.now, currency: o.currency }));
      contentType = 'application/json; charset=utf-8';
    } else if (format === 'xml') {
      body = toXml(rows || [], o.template, { now: o.now, currency: o.currency });
      contentType = 'application/xml; charset=utf-8';
    } else if (format === 'csv') {
      body = toCsv(rows || []);
      contentType = 'text/csv; charset=utf-8';
    } else {
      return result({ error: `Nepodporovaný formát webhooku „${o.format}“ (json, xml, csv)` });
    }

    let userHeaders;
    try {
      userHeaders = parseWebhookHeaders(o.headers);
    } catch (e) {
      return result({ error: e.message });
    }
    const headers = { 'content-type': contentType, 'user-agent': 'Cenotvorba/1.0 (webhook)', 'x-cenotvorba-count': String((rows || []).length) };
    for (const [k, v] of Object.entries(userHeaders)) headers[k.toLowerCase()] = v;

    const timeoutMs = Number(o.timeout_ms) > 0 ? Number(o.timeout_ms) : 20000;
    const retries = o.retries != null && Number(o.retries) >= 0 ? Math.floor(Number(o.retries)) : 2;
    const delays = Array.isArray(o.retry_delays_ms) && o.retry_delays_ms.length ? o.retry_delays_ms : DEFAULT_DELAYS;

    let last = null;
    let attempts = 0;
    for (let i = 0; i <= retries; i++) {
      if (i > 0) await sleep(Number(delays[Math.min(i - 1, delays.length - 1)]) || 0);
      attempts++;
      try {
        const r = await attempt(url.toString(), { method: 'POST', headers, body }, timeoutMs);
        if (r.status >= 200 && r.status < 300) return result({ ok: true, status: r.status, body: r.body, attempts });
        last = {
          status: r.status,
          body: r.body,
          error: r.redirect !== undefined ? `Webhook vrátil přesměrování ${r.status}${r.redirect ? ` na ${r.redirect}` : ''} – upravte URL` : `Webhook vrátil HTTP ${r.status}`,
        };
        if (!isRetryableStatus(r.status)) break;
      } catch (e) {
        // Chyba sestavení požadavku (neplatná hlavička apod.) – opakování nepomůže.
        if (e instanceof TypeError && !e.cause && /header|invalid/i.test(e.message)) {
          last = { status: null, body: '', error: `Neplatný požadavek: ${e.message}` };
          break;
        }
        last = { status: null, body: '', error: describeError(e, timeoutMs) };
      }
    }
    return result({ ...last, attempts });
  } catch (e) {
    return result({ error: `Neočekávaná chyba webhooku: ${e && e.message}` });
  }
}

module.exports = { pushWebhook, parseWebhookHeaders };
