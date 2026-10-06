'use strict';
// Route registry (SPEC kap. 3): add(method, pattern, handler, opts), vzory '/kola/:slug', match(method, path).
//   match → { handler, params, opts, pattern } | { status: 404 } | { status: 405, allow: ['GET', …] }
// Segmenty :param zachytí jeden segment (bez '/'); hodnota se dekóduje (decodeURIComponent).
// Pořadí: statické segmenty mají přednost před parametry (routy se řadí podle specifičnosti), HEAD = GET.

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

function compile(pattern) {
  if (typeof pattern !== 'string' || !pattern.startsWith('/')) throw new Error(`Vzor routy musí začínat „/“: ${pattern}`);
  const keys = [];
  let staticCount = 0;
  const segments = pattern.split('/').slice(1);
  const parts = segments.map((seg) => {
    if (seg.startsWith(':')) {
      const name = seg.slice(1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Neplatný název parametru v routě: ${pattern}`);
      keys.push(name);
      return '([^/]+)';
    }
    if (seg === '*') {
      keys.push('rest');
      return '(.*)';
    }
    staticCount++;
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  const re = new RegExp('^/' + parts.join('/') + '/?$');
  return { re, keys, staticCount, segments: segments.length };
}

function createRouter() {
  const routes = [];

  /** Zaregistruje routu. opts se předají do match() (csrf, rateLimit, feature …). */
  function add(method, pattern, handler, opts = {}) {
    const m = String(method).toUpperCase();
    if (!METHODS.has(m)) throw new Error(`Neznámá HTTP metoda: ${method}`);
    if (typeof handler !== 'function') throw new Error(`Handler routy ${m} ${pattern} musí být funkce.`);
    const compiled = compile(pattern);
    if (routes.some((r) => r.method === m && r.pattern === pattern)) throw new Error(`Routa ${m} ${pattern} je už zaregistrovaná.`);
    routes.push({ method: m, pattern, handler, opts: { ...opts }, ...compiled });
    // specifičtější (více statických segmentů, pak delší) dřív
    routes.sort((a, b) => b.staticCount - a.staticCount || b.segments - a.segments || a.pattern.localeCompare(b.pattern));
  }

  function decode(v) {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }

  /** Najde routu pro metodu a cestu. */
  function match(method, pathname) {
    const m = String(method).toUpperCase() === 'HEAD' ? 'GET' : String(method).toUpperCase();
    const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
    const allow = new Set();
    for (const r of routes) {
      const hit = r.re.exec(path);
      if (!hit) continue;
      if (r.method !== m) {
        allow.add(r.method);
        if (r.method === 'GET') allow.add('HEAD');
        continue;
      }
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decode(hit[i + 1]);
      });
      return { handler: r.handler, params, opts: r.opts, pattern: r.pattern, method: r.method };
    }
    if (allow.size) return { status: 405, allow: [...allow].sort() };
    return { status: 404 };
  }

  function list() {
    return routes.map((r) => ({ method: r.method, pattern: r.pattern, opts: r.opts }));
  }

  return { add, match, list };
}

module.exports = { createRouter, compile, METHODS };
