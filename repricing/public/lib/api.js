// Obal nad fetch pro /api/v1: cookie (same-origin), X-Requested-With (CSRF), JSON dovnitř i ven,
// 401 → přihlášení, chyby jako toast se zprávou serveru (error.message).
import { toast } from './toast.js';
import { queryString } from './router.js';
import { guessContentType } from './import-model.js';

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

let unauthorizedHandler = null;
/** Nastaví reakci na 401 (aplikace přesměruje na #/login). */
export function onUnauthorized(fn) {
  unauthorizedHandler = fn;
}

/** Základ cesty API vzhledem k umístění index.html (umožní provoz i pod podadresářem proxy). */
export function basePath() {
  try {
    if (typeof document !== 'undefined') return new URL('.', document.baseURI).pathname;
  } catch {
    /* výchozí níže */
  }
  return '/';
}

/** Absolutní cesta k API: apiUrl('/products', {q:'x'}) → '/api/v1/products?q=x'. */
export function apiUrl(path, query) {
  return basePath() + 'api/v1/' + String(path).replace(/^\/+/, '') + queryString(query);
}

export function isAbort(e) {
  return e && (e.name === 'AbortError' || e.code === 20);
}

/** Z odpovědi seznamu vytáhne pole položek (podporuje {items} i holé pole). */
export function itemsOf(res) {
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.items)) return res.items;
  return [];
}

function detailsList(details) {
  if (!details) return [];
  if (Array.isArray(details)) return details.map((d) => (typeof d === 'string' ? d : d?.message || JSON.stringify(d)));
  if (Array.isArray(details.errors)) return detailsList(details.errors);
  if (typeof details === 'string') return [details];
  return [];
}

/**
 * Obecný požadavek.
 * @param {string} method
 * @param {string} path cesta pod /api/v1
 * @param {{query?: object, body?: any, raw?: Blob|ArrayBuffer|string, contentType?: string, signal?: AbortSignal,
 *          silent?: boolean, allow401?: boolean}} [opts]
 */
export async function request(method, path, opts = {}) {
  const headers = { 'X-Requested-With': 'cenotvorba', Accept: 'application/json' };
  const init = { method, credentials: 'same-origin', headers, signal: opts.signal };
  if (opts.raw !== undefined) {
    init.body = opts.raw;
    headers['Content-Type'] = opts.contentType || opts.raw?.type || 'application/octet-stream';
  } else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(apiUrl(path, opts.query), init);
  } catch (e) {
    if (isAbort(e)) throw e;
    const err = new ApiError(0, 'Server je nedostupný – zkontrolujte připojení.');
    if (!opts.silent) toast(err.message, { type: 'error' });
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  let data = null;
  if (res.status !== 204) {
    if (ct.includes('json')) {
      try {
        data = await res.json();
      } catch {
        data = null;
      }
    } else {
      data = await res.text();
    }
  }
  if (res.status === 401 && !opts.allow401) {
    const err = new ApiError(401, data?.error?.message || 'Přihlášení vypršelo – přihlaste se znovu.');
    if (unauthorizedHandler) unauthorizedHandler(err);
    throw err;
  }
  if (!res.ok) {
    const e = data && typeof data === 'object' ? data.error : null;
    const msg = e?.message || (typeof data === 'string' && data && data.length < 200 ? data : 'Chyba serveru (' + res.status + ')');
    const err = new ApiError(res.status, msg, e?.details);
    if (!opts.silent) toast(msg, { type: 'error', details: detailsList(e?.details) });
    throw err;
  }
  return data;
}

export const api = {
  get: (path, query, opts = {}) => request('GET', path, { ...opts, query }),
  post: (path, body, opts = {}) => request('POST', path, { ...opts, body }),
  put: (path, body, opts = {}) => request('PUT', path, { ...opts, body }),
  patch: (path, body, opts = {}) => request('PATCH', path, { ...opts, body }),
  del: (path, opts = {}) => request('DELETE', path, opts),
  /** Nahrání souboru jako surové tělo s Content-Type podle souboru. */
  upload: (path, file, query, opts = {}) =>
    request('POST', path, { ...opts, query, raw: file, contentType: guessContentType(file.name, file.type) }),
};

// ------------------------------------------------------------------ stahování souborů

/** Název souboru z Content-Disposition (filename*=UTF-8''… má přednost). */
export function filenameFromDisposition(cd, fallback = 'soubor') {
  if (!cd) return fallback;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* níže */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  return plain ? plain[1].trim() : fallback;
}

/**
 * Stáhne soubor z API přes fetch: chyba (např. 409 „není co exportovat“) se ukáže jako toast místo
 * uložení JSON chyby do souboru; úspěch uloží soubor pod jménem ze serveru.
 * @param {string} href URL (apiUrl(…))
 * @returns {Promise<{filename: string, size: number, exportId: string|null, count: number|null}|null>}
 */
export async function downloadHref(href) {
  let res;
  try {
    res = await fetch(href, { credentials: 'same-origin', headers: { 'X-Requested-With': 'cenotvorba' } });
  } catch {
    toast('Server je nedostupný – soubor se nepodařilo stáhnout.', { type: 'error' });
    return null;
  }
  if (res.status === 401) {
    if (unauthorizedHandler) unauthorizedHandler(new ApiError(401, 'Přihlášení vypršelo – přihlaste se znovu.'));
    return null;
  }
  if (!res.ok) {
    let msg = 'Soubor se nepodařilo stáhnout (HTTP ' + res.status + ').';
    try {
      const j = await res.json();
      if (j?.error?.message) msg = j.error.message;
    } catch {
      /* ne-JSON */
    }
    toast(msg, { type: res.status === 409 ? 'warning' : 'error' });
    return null;
  }
  const blob = await res.blob();
  const fallback = decodeURIComponent(String(new URL(href, location.href).pathname.split('/').pop() || 'soubor'));
  const filename = filenameFromDisposition(res.headers.get('content-disposition'), fallback);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  const cnt = res.headers.get('x-export-count');
  return { filename, size: blob.size, exportId: res.headers.get('x-export-id'), count: cnt != null ? Number(cnt) : null };
}

/**
 * Odkaz ke stažení (a[href]) stáhne přes downloadHref – s hlášením chyb; Ctrl/⌘/Shift+klik zůstává nativní.
 * @param {HTMLAnchorElement} a
 * @param {(r: object) => void} [onDone]
 */
export function bindDownload(a, onDone) {
  a.addEventListener('click', async (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (a.classList.contains('is-busy')) return;
    a.classList.add('is-busy');
    a.setAttribute('aria-busy', 'true');
    try {
      const r = await downloadHref(a.href);
      if (r && onDone) onDone(r);
    } finally {
      a.classList.remove('is-busy');
      a.removeAttribute('aria-busy');
    }
  });
  return a;
}

// ------------------------------------------------------------------ jednoduchá cache číselníků

const cache = new Map();

/**
 * GET s krátkodobou cache (pole, facety, segmenty, konkurenti).
 * @param {string} path
 * @param {object} [query]
 * @param {number} [ttl] ms
 */
export function cachedGet(path, query, ttl = 60000) {
  const key = path + queryString(query);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = api.get(path, query, { silent: true }).catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

/** Zneplatní cache (všechny klíče začínající prefixem, bez prefixu vše). */
export function invalidate(prefix = '') {
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
}
