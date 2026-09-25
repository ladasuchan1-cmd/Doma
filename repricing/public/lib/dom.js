// Minimalistický a bezpečný pomocník pro tvorbu DOM.
// Zásada: data z API (názvy produktů, konkurentů, …) nikdy nejdou do innerHTML.
// h() nastavuje text přes textové uzly a atributy přes setAttribute; innerHTML/outerHTML zakazuje.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Vlastnosti, které je nutné nastavit jako property (ne atribut), aby odrážely aktuální stav.
const PROPS = new Set(['value', 'checked', 'selected', 'indeterminate', 'muted']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster']);
const FORBIDDEN = new Set(['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'srcdoc']);

function doc() {
  const d = globalThis.document;
  if (!d) throw new Error('dom.js: document není k dispozici');
  return d;
}

/**
 * Bezpečná URL pro href/src: povoleny relativní odkazy, #, http(s), mailto, tel; data: jen obrázky.
 * Vše ostatní (javascript:, vbscript:, …) → '#'.
 */
export function safeUrl(u, { allowData = false } = {}) {
  if (u == null) return '#';
  const s = String(u).trim();
  if (!s) return '#';
  // odstranit neviditelné a řídicí znaky, které prohlížeče při parsování schématu ignorují
  const probe = s.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();
  const m = /^([a-z][a-z0-9+.-]*):/.exec(probe);
  if (!m) return s; // relativní URL nebo #kotva
  const scheme = m[1];
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel') return s;
  if (allowData && scheme === 'data' && /^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/.test(probe)) return s;
  return '#';
}

function kebab(s) {
  return s.startsWith('--') ? s : s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

function classString(v) {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return v.map(classString).filter(Boolean).join(' ');
  if (typeof v === 'object') return Object.keys(v).filter((k) => v[k]).join(' ');
  return String(v);
}

function applyProps(el, props, isSvg) {
  for (const key of Object.keys(props)) {
    const v = props[key];
    if (FORBIDDEN.has(key)) throw new Error('dom.js: vlastnost ' + key + ' je zakázaná (XSS)');
    if (v == null || v === false) continue;
    if (key === 'class' || key === 'className') {
      const c = classString(v);
      if (c) el.setAttribute('class', c);
    } else if (key === 'style') {
      if (typeof v === 'string') el.setAttribute('style', v);
      else for (const [k, val] of Object.entries(v)) if (val != null && val !== false) el.style.setProperty(kebab(k), String(val));
    } else if (key === 'dataset') {
      for (const [k, val] of Object.entries(v)) if (val != null) el.setAttribute('data-' + kebab(k), String(val));
    } else if (key === 'ref') {
      if (typeof v === 'function') v(el);
    } else if (key === 'text') {
      el.textContent = String(v);
    } else if (key.startsWith('on') && typeof v === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), v);
    } else if (!isSvg && PROPS.has(key)) {
      el[key] = v;
    } else if (URL_ATTRS.has(key)) {
      el.setAttribute(key, safeUrl(v, { allowData: key === 'src' }));
    } else {
      el.setAttribute(key, v === true ? '' : String(v));
    }
  }
}

function appendChildren(el, children) {
  const d = doc();
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (typeof c === 'object' && typeof c.nodeType === 'number') el.appendChild(c);
    else el.appendChild(d.createTextNode(String(c)));
  }
}

function isProps(p) {
  return p != null && typeof p === 'object' && !Array.isArray(p) && typeof p.nodeType !== 'number';
}

/**
 * Vytvoří HTML element. h('a', {href, class, onClick}, 'text', childNode, [pole])
 * Props jsou nepovinné: h('p', 'text').
 */
export function h(tag, props, ...children) {
  const el = doc().createElement(tag);
  if (isProps(props)) applyProps(el, props, false);
  else if (props != null) children.unshift(props);
  appendChildren(el, children);
  return el;
}

/** Vytvoří SVG element (jmenný prostor SVG). */
export function svg(tag, props, ...children) {
  const el = doc().createElementNS(SVG_NS, tag);
  if (isProps(props)) applyProps(el, props, true);
  else if (props != null) children.unshift(props);
  appendChildren(el, children);
  return el;
}

/** Fragment z více uzlů. */
export function frag(...children) {
  const f = doc().createDocumentFragment();
  appendChildren(f, children);
  return f;
}

/** Vyprázdní element. */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Nahradí obsah elementu. */
export function mount(el, ...children) {
  clear(el);
  appendChildren(el, children);
  return el;
}

/** Debounce s metodou cancel(). */
export function debounce(fn, ms = 250) {
  let t = null;
  const wrapped = (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => {
    if (t) clearTimeout(t);
    t = null;
  };
  return wrapped;
}

let uidCounter = 0;
/** Unikátní id pro propojení label ↔ input. */
export function uid(prefix = 'id') {
  uidCounter += 1;
  return prefix + '-' + uidCounter;
}

/** Zkopíruje text do schránky (s fallbackem pro nezabezpečený kontext). */
export async function copyText(text) {
  try {
    if (globalThis.navigator?.clipboard && globalThis.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fallback níže */
  }
  const d = doc();
  const ta = d.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  d.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = d.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** Je cíl události interaktivní prvek (kliknutí na řádek pak nenaviguje)? */
export function isInteractive(target, stopAt) {
  let el = target;
  while (el && el !== stopAt && el.nodeType === 1) {
    const tag = el.tagName;
    if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'LABEL') return true;
    if (el.getAttribute && (el.getAttribute('role') === 'switch' || el.getAttribute('contenteditable') === 'true')) return true;
    el = el.parentNode;
  }
  return false;
}
