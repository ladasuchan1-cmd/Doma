// Hash router – čisté funkce (parsování a skládání adres typu #/produkty/12?q=trek).

/** Rozloží hash na cestu a query. „#/produkty/12?q=a“ → {path:'/produkty/12', parts:['produkty','12'], query:{q:'a'}} */
export function parseHash(hash) {
  let s = String(hash || '');
  if (s.startsWith('#')) s = s.slice(1);
  if (!s.startsWith('/')) s = '/' + s;
  const qi = s.indexOf('?');
  const rawPath = qi >= 0 ? s.slice(0, qi) : s;
  const qs = qi >= 0 ? s.slice(qi + 1) : '';
  const parts = rawPath.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const query = {};
  if (qs) {
    for (const [k, v] of new URLSearchParams(qs)) query[k] = v; // opakované klíče → poslední
  }
  return { path: '/' + parts.join('/'), parts, query };
}

/** Sestaví query string; vynechá null/undefined/'' a false. Pole spojí čárkou. */
export function queryString(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null || v === '' || v === false) continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      p.set(k, v.join(','));
    } else if (typeof v === 'object') p.set(k, JSON.stringify(v));
    else p.set(k, v === true ? '1' : String(v));
  }
  const s = p.toString();
  return s ? '?' + s : '';
}

/** „/produkty“ + {q:'trek'} → „#/produkty?q=trek“ */
export function buildHash(path, query) {
  const p = path.startsWith('/') ? path : '/' + path;
  const parts = p.split('/').filter(Boolean).map((x) => encodeURIComponent(x));
  return '#/' + parts.join('/') + queryString(query);
}

/**
 * Najde trasu. Vzory: '/produkty/:id'. Vrací {route, params} nebo null.
 * @param {{pattern: string}[]} routes
 * @param {string} path
 */
export function matchRoute(routes, path) {
  const parts = path.split('/').filter(Boolean);
  for (const route of routes) {
    const pp = route.pattern.split('/').filter(Boolean);
    if (pp.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = parts[i];
      else if (pp[i] !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}
