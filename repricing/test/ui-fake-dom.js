'use strict';
// Minimální falešný DOM pro testy UI v Node (nulové závislosti) – stačí na vykreslení pohledů z public/views
// a na simulaci kliknutí, psaní, kláves a fokusu. Věrně napodobuje to, na čem stojí regresní testy:
//  - event.currentTarget je po skončení dispatch null (jako v prohlížeči → chyby „e.currentTarget po await“),
//  - fokus: odstraněný prvek fokus ztrácí (activeElement = body), focus/blur události,
//  - <dialog>: showModal()/close() a atribut open, klik na disabled tlačítko nic nespustí.
// Nepodporuje layout, CSS ani innerHTML (ten UI stejně zakazuje).
// Použití: const dom = installDom(); … dom.click(el); dom.type(input, 'text'); dom.key(input, 'Enter');
//          dom.api({ 'GET /settings': () => ({…}) }) – falešný fetch pro public/lib/api.js.

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = init.cancelable !== false;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this._stop = false;
    this._stopNow = false;
    for (const [k, v] of Object.entries(init)) if (!(k in this)) this[k] = v;
    if (this.button === undefined) this.button = 0;
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation() {
    this._stop = true;
  }
  stopImmediatePropagation() {
    this._stop = true;
    this._stopNow = true;
  }
}
class FakeCustomEvent extends FakeEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.detail = init.detail ?? null;
  }
}

class EventTargetBase {
  constructor() {
    this._listeners = {};
  }
  addEventListener(type, fn, opts) {
    if (typeof fn !== 'function') return;
    (this._listeners[type] ||= []).push({ fn, once: Boolean(opts && opts.once) });
  }
  removeEventListener(type, fn) {
    const l = this._listeners[type];
    if (l) this._listeners[type] = l.filter((x) => x.fn !== fn);
  }
  /** Cesta pro probublávání (prvek → předci → dokument → okno). */
  _path() {
    return [this];
  }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    const path = ev.bubbles ? this._path() : [this];
    for (const node of path) {
      ev.currentTarget = node;
      for (const l of (node._listeners[ev.type] || []).slice()) {
        if (l.once) node.removeEventListener(ev.type, l.fn);
        l.fn.call(node, ev);
        if (ev._stopNow) break;
      }
      if (ev._stop) break;
    }
    // jako v prohlížeči: po dokončení dispatch je currentTarget null (async handler ho po await už nemá)
    ev.currentTarget = null;
    return !ev.defaultPrevented;
  }
}

class FakeNode extends EventTargetBase {
  constructor(nodeType, ownerDocument) {
    super();
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument || null;
    this.childNodes = [];
    this.parentNode = null;
  }
  _path() {
    const out = [];
    for (let n = this; n; n = n.parentNode) out.push(n);
    const doc = out[out.length - 1];
    if (doc && doc.nodeType === 9 && doc.defaultView) out.push(doc.defaultView);
    return out;
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }
  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }
  get firstElementChild() {
    return this.children[0] || null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const s = this.parentNode.childNodes;
    return s[s.indexOf(this) + 1] || null;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n.nodeType === 9;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v != null && v !== '') this.appendChild(this._doc().createTextNode(String(v)));
  }
  _doc() {
    return this.ownerDocument || globalThis.document;
  }
  _adopt(list) {
    const out = [];
    for (const c of list) {
      if (c.nodeType === 11) {
        out.push(...c.childNodes);
        for (const x of c.childNodes) x.parentNode = null;
        c.childNodes = [];
      } else {
        if (c.parentNode) c.parentNode.removeChild(c);
        out.push(c);
      }
    }
    return out;
  }
  appendChild(c) {
    for (const x of this._adopt([c])) {
      x.parentNode = this;
      this.childNodes.push(x);
    }
    return c;
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(typeof n === 'object' ? n : this._doc().createTextNode(String(n)));
  }
  insertBefore(c, ref) {
    if (!ref) return this.appendChild(c);
    const list = this._adopt([c]);
    const i = this.childNodes.indexOf(ref);
    for (const x of list) x.parentNode = this;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, ...list);
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i < 0) throw new Error('removeChild: uzel není potomkem');
    this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  /** Všichni potomci (elementy) v pořadí dokumentu. */
  _descendants() {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 1) {
          out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelectorAll(sel) {
    const groups = parseSelector(sel);
    return this._descendants().filter((el) => groups.some((g) => matchComplex(el, g, this)));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
}

class FakeText extends FakeNode {
  constructor(t, doc) {
    super(3, doc);
    this.data = String(t);
  }
  get textContent() {
    return this.data;
  }
  set textContent(v) {
    this.data = String(v);
  }
  get nodeValue() {
    return this.data;
  }
}

class FakeFragment extends FakeNode {
  constructor(doc) {
    super(11, doc);
  }
}

// Atributy odrážené jako property (el.id = …, el.hidden = true …).
const STRING_PROPS = { id: 'id', className: 'class', title: 'title', href: 'href', name: 'name', placeholder: 'placeholder', type: 'type', src: 'src', download: 'download', role: 'role' };
const BOOL_PROPS = { hidden: 'hidden', disabled: 'disabled', open: 'open', required: 'required', readOnly: 'readonly', multiple: 'multiple' };

class FakeClassList {
  constructor(el) {
    this.el = el;
  }
  _get() {
    return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  }
  _set(list) {
    this.el.setAttribute('class', [...new Set(list)].join(' '));
  }
  add(...c) {
    this._set([...this._get(), ...c]);
  }
  remove(...c) {
    this._set(this._get().filter((x) => !c.includes(x)));
  }
  contains(c) {
    return this._get().includes(c);
  }
  toggle(c, force) {
    const on = force === undefined ? !this.contains(c) : Boolean(force);
    if (on) this.add(c);
    else this.remove(c);
    return on;
  }
}

class FakeElement extends FakeNode {
  constructor(tag, doc, ns) {
    super(1, doc);
    this.tagName = String(tag).toUpperCase();
    this.localName = String(tag).toLowerCase();
    this.namespaceURI = ns || 'http://www.w3.org/1999/xhtml';
    this._attrs = new Map();
    this.classList = new FakeClassList(this);
    const styles = {};
    this.style = new Proxy(styles, {
      get: (t, k) => (k === 'setProperty' ? (p, v) => { t[p] = String(v); } : k === 'removeProperty' ? (p) => { delete t[p]; } : t[k] ?? ''),
      set: (t, k, v) => {
        t[k] = v;
        return true;
      },
    });
    const self = this;
    this.dataset = new Proxy({}, {
      get: (t, k) => (typeof k === 'string' ? self.getAttribute('data-' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())) ?? undefined : undefined),
      set: (t, k, v) => {
        self.setAttribute('data-' + String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), String(v));
        return true;
      },
      deleteProperty: (t, k) => {
        self.removeAttribute('data-' + String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
        return true;
      },
    });
    if (this.localName === 'input' || this.localName === 'textarea') {
      this._value = '';
      this.checked = false;
    }
  }
  setAttribute(k, v) {
    this._attrs.set(String(k), String(v));
  }
  getAttribute(k) {
    return this._attrs.has(k) ? this._attrs.get(k) : null;
  }
  hasAttribute(k) {
    return this._attrs.has(k);
  }
  removeAttribute(k) {
    this._attrs.delete(k);
  }
  toggleAttribute(k, force) {
    const on = force === undefined ? !this.hasAttribute(k) : Boolean(force);
    if (on) this.setAttribute(k, '');
    else this.removeAttribute(k);
    return on;
  }
  get attributes() {
    return [...this._attrs].map(([name, value]) => ({ name, value }));
  }
  get value() {
    if (this.localName === 'select') {
      const opts = this.options;
      if (this._value !== undefined && opts.some((o) => o.value === this._value)) return this._value;
      const sel = opts.find((o) => o.hasAttribute('selected'));
      return sel ? sel.value : opts[0] ? opts[0].value : '';
    }
    if (this.localName === 'option') return this.getAttribute('value') ?? this.textContent;
    if (this.localName === 'input' || this.localName === 'textarea') return this._value;
    return this.getAttribute('value') ?? '';
  }
  set value(v) {
    if (this.localName === 'option') this.setAttribute('value', String(v));
    else this._value = v == null ? '' : String(v);
  }
  get options() {
    return this._descendants().filter((e) => e.localName === 'option');
  }
  get selectedIndex() {
    return this.options.findIndex((o) => o.value === this.value);
  }
  get tabIndex() {
    return Number(this.getAttribute('tabindex') ?? -1);
  }
  set tabIndex(v) {
    this.setAttribute('tabindex', String(v));
  }
  get form() {
    for (let n = this.parentNode; n; n = n.parentNode) if (n.localName === 'form') return n;
    return null;
  }
  matches(sel) {
    return parseSelector(sel).some((g) => matchComplex(this, g, null));
  }
  closest(sel) {
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n;
    return null;
  }
  focus() {
    if (!this.isConnected || this.disabled) return;
    const d = this._doc();
    const prev = d.activeElement;
    if (prev === this) return;
    d._active = this;
    if (prev && prev !== d.body) {
      prev.dispatchEvent(new FakeEvent('blur'));
      prev.dispatchEvent(new FakeEvent('focusout', { bubbles: true }));
    }
    this.dispatchEvent(new FakeEvent('focus'));
    this.dispatchEvent(new FakeEvent('focusin', { bubbles: true }));
  }
  blur() {
    const d = this._doc();
    if (d.activeElement !== this) return;
    d._active = null;
    this.dispatchEvent(new FakeEvent('blur'));
    this.dispatchEvent(new FakeEvent('focusout', { bubbles: true }));
  }
  click() {
    if (this.disabled) return;
    const ev = new FakeEvent('click', { bubbles: true });
    this.dispatchEvent(ev);
    // výchozí akce: odeslání formuláře tlačítkem submit, přepnutí checkboxu
    if (!ev.defaultPrevented) {
      if (this.localName === 'button' && (this.getAttribute('type') || 'submit') === 'submit' && this.form) {
        this.form.dispatchEvent(new FakeEvent('submit', { bubbles: true }));
      }
    }
  }
  select() {}
  scrollIntoView() {}
  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  get offsetWidth() {
    return 0;
  }
  get clientWidth() {
    return 0;
  }
  // <dialog>
  showModal() {
    this.setAttribute('open', '');
  }
  show() {
    this.setAttribute('open', '');
  }
  close() {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new FakeEvent('close'));
  }
}
for (const [prop, attr] of Object.entries(STRING_PROPS)) {
  Object.defineProperty(FakeElement.prototype, prop, {
    get() {
      return this.getAttribute(attr) ?? '';
    },
    set(v) {
      this.setAttribute(attr, String(v));
    },
  });
}
for (const [prop, attr] of Object.entries(BOOL_PROPS)) {
  Object.defineProperty(FakeElement.prototype, prop, {
    get() {
      return this.hasAttribute(attr);
    },
    set(v) {
      this.toggleAttribute(attr, Boolean(v));
    },
  });
}

// ------------------------------------------------------------------ selektory
// Podpora: seznam (,), potomek (mezera), dítě (>), tag, *, #id, .třída, [attr], [attr=v], [attr="v"], [attr^=v], [attr*=v], :not(…)

function parseSelector(sel) {
  const groups = [];
  for (const part of splitTop(sel, ',')) {
    const tokens = [];
    const re = /\s*(>)\s*|\s+|((?:[^\s>[\]:]|\[[^\]]*\]|:not\([^)]*\))+)/g;
    let m;
    const s = part.trim();
    let comb = ' ';
    while ((m = re.exec(s))) {
      if (m[1]) comb = '>';
      else if (m[2]) {
        tokens.push({ comb, compound: parseCompound(m[2]) });
        comb = ' ';
      }
    }
    groups.push(tokens);
  }
  return groups;
}

function splitTop(s, ch) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '[' || c === '(') depth++;
    if (c === ']' || c === ')') depth--;
    if (c === ch && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.filter((x) => x.trim());
}

function parseCompound(s) {
  const c = { tag: null, id: null, classes: [], attrs: [], nots: [] };
  const re = /^(\*|[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w:-]+)\s*(?:([\^*$]?=)\s*("[^"]*"|'[^']*'|[^\]\s]+))?\s*\]|:not\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) c.tag = m[1] === '*' ? null : m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ name: m[4], op: m[5] || null, value: m[6] != null ? m[6].replace(/^["']|["']$/g, '') : null });
    else if (m[7]) c.nots.push(parseCompound(m[7].trim()));
  }
  return c;
}

function matchCompound(el, c) {
  if (el.nodeType !== 1) return false;
  if (c.tag && el.localName !== c.tag) return false;
  if (c.id && el.getAttribute('id') !== c.id) return false;
  for (const cl of c.classes) if (!el.classList.contains(cl)) return false;
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v == null) return false;
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '^=' && !v.startsWith(a.value)) return false;
    if (a.op === '*=' && !v.includes(a.value)) return false;
    if (a.op === '$=' && !v.endsWith(a.value)) return false;
  }
  for (const n of c.nots) if (matchCompound(el, n)) return false;
  return true;
}

function matchComplex(el, tokens, scope) {
  // zprava doleva
  const match = (node, i) => {
    if (!matchCompound(node, tokens[i].compound)) return false;
    if (i === 0) return true;
    const comb = tokens[i].comb;
    if (comb === '>') {
      const p = node.parentNode;
      return p && p !== scope && p.nodeType === 1 ? match(p, i - 1) : false;
    }
    for (let p = node.parentNode; p && p !== scope && p.nodeType === 1; p = p.parentNode) if (match(p, i - 1)) return true;
    return false;
  };
  return tokens.length > 0 && match(el, tokens.length - 1);
}

// ------------------------------------------------------------------ dokument a okno

class FakeDocument extends FakeNode {
  constructor() {
    super(9, null);
    this.ownerDocument = null;
    this._active = null;
    this.documentElement = new FakeElement('html', this);
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.title = '';
    this.baseURI = 'http://localhost/';
    this.visibilityState = 'visible';
  }
  _doc() {
    return this;
  }
  get activeElement() {
    return this._active && this._active.isConnected ? this._active : this.body;
  }
  createElement(tag) {
    return new FakeElement(tag, this);
  }
  createElementNS(ns, tag) {
    return new FakeElement(tag, this, ns);
  }
  createTextNode(t) {
    return new FakeText(t, this);
  }
  createDocumentFragment() {
    return new FakeFragment(this);
  }
  getElementById(id) {
    return this._descendants().find((e) => e.getAttribute('id') === id) || null;
  }
  execCommand() {
    return false;
  }
}

class FakeWindow extends EventTargetBase {
  constructor(doc) {
    super();
    this.document = doc;
  }
}

/** Vytvoří JSON odpověď ve tvaru fetch Response (to, co potřebuje public/lib/api.js). */
function jsonResponse(status, body, headers = {}) {
  const h = new Map(Object.entries({ 'content-type': 'application/json', ...headers }).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : JSON.parse(JSON.stringify(body ?? null))),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    blob: async () => new Blob([typeof body === 'string' ? body : JSON.stringify(body)]),
  };
}

/** Chyba API ve tvaru serveru ({error: {status, message}}). */
class ApiReply {
  constructor(status, body, headers) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}
const reply = (status, body, headers) => new ApiReply(status, body, headers);
const apiError = (status, message, details) => reply(status, { error: { status, message, details } });

/**
 * Nainstaluje falešný DOM do globalThis (document, window, location, history, localStorage, Event, fetch).
 * Vrací pomocníky pro testy.
 */
function installDom() {
  const document = new FakeDocument();
  const window = new FakeWindow(document);
  document.defaultView = window;
  const loc = { hash: '', origin: 'http://localhost', pathname: '/', href: 'http://localhost/', search: '' };
  const location = new Proxy(loc, {
    set(t, k, v) {
      const old = t.hash;
      t[k] = v;
      if (k === 'hash') {
        const nv = String(v).startsWith('#') || v === '' ? String(v) : '#' + v;
        t.hash = nv;
        t.href = 'http://localhost/' + nv;
        if (nv !== old) setTimeout(() => window.dispatchEvent(new FakeEvent('hashchange')), 0);
      }
      return true;
    },
  });
  const history = {
    replaceState(_s, _t, url) {
      if (url != null) {
        const s = String(url);
        loc.hash = s.startsWith('#') ? s : s.includes('#') ? s.slice(s.indexOf('#')) : loc.hash;
        loc.href = 'http://localhost/' + loc.hash;
      }
    },
    pushState(s, t, url) {
      this.replaceState(s, t, url);
    },
  };
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  Object.assign(window, { location, history, localStorage, addEventListener: window.addEventListener.bind(window) });

  // falešné API: routes['GET /settings'] = (req) => body | reply(status, body)
  const routes = new Map();
  const requests = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://localhost/');
    const method = (init.method || 'GET').toUpperCase();
    const path = u.pathname.replace(/^\/api\/v1/, '');
    let body = init.body;
    if (typeof body === 'string' && /json/.test(init.headers?.['Content-Type'] || '')) {
      try {
        body = JSON.parse(body);
      } catch {
        /* surové tělo */
      }
    }
    const req = { method, path, query: Object.fromEntries(u.searchParams), body, url: String(url) };
    requests.push(req);
    if (init.signal?.aborted) {
      const e = new Error('Aborted');
      e.name = 'AbortError';
      throw e;
    }
    let handler = routes.get(method + ' ' + path);
    if (!handler) {
      for (const [k, fn] of routes) {
        const [m, p] = k.split(' ');
        if (m !== method || !p.includes(':')) continue;
        const re = new RegExp('^' + p.replace(/:[^/]+/g, '([^/]+)') + '$');
        const mm = re.exec(path);
        if (mm) {
          req.params = mm.slice(1).map(decodeURIComponent);
          handler = fn;
          break;
        }
      }
    }
    if (!handler) return jsonResponse(404, { error: { status: 404, message: 'Neznámá cesta ' + method + ' ' + path } });
    const out = await handler(req);
    if (out instanceof ApiReply) return jsonResponse(out.status, out.body, out.headers);
    if (out === undefined) return jsonResponse(204, null);
    return jsonResponse(200, out);
  };

  Object.assign(globalThis, {
    document,
    window,
    location,
    history,
    localStorage,
    Event: FakeEvent,
    CustomEvent: FakeCustomEvent,
    KeyboardEvent: FakeEvent,
    MouseEvent: FakeEvent,
    fetch,
  });
  globalThis.navigator ??= {};

  // Časovače aplikace (toasty 4–8 s, odznak, debounce) nesmí držet proces testu naživu – unref.
  // settle() používá původní (ref) časovač, takže během čekání testu časovače aplikace normálně doběhnou.
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  globalThis.setTimeout = (fn, ms, ...a) => {
    const t = realSetTimeout(fn, ms, ...a);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };
  globalThis.setInterval = (fn, ms, ...a) => {
    const t = realSetInterval(fn, ms, ...a);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };

  const settle = async (ms = 0) => {
    // několik kol mikroúloh a časovačů (await v handlerech, debounce, setTimeout 0)
    for (let i = 0; i < 5; i++) await new Promise((r) => realSetTimeout(r, ms));
  };

  return {
    document,
    window,
    location,
    routes,
    requests,
    reply,
    apiError,
    settle,
    /** Nastaví odpovědi API (klíč 'METODA /cesta', cesta bez /api/v1, může obsahovat :param). */
    api(map) {
      for (const [k, v] of Object.entries(map)) routes.set(k, typeof v === 'function' ? v : () => v);
    },
    /** Kořen pro pohled připojený do dokumentu. */
    root() {
      const r = document.createElement('div');
      document.body.appendChild(r);
      return r;
    },
    click(el) {
      if (!el) throw new Error('click: prvek neexistuje');
      el.click();
    },
    /** Napíše text do vstupu (nastaví value a vyvolá input). */
    type(el, text, { append = false } = {}) {
      if (!el) throw new Error('type: prvek neexistuje');
      el.focus();
      el.value = append ? el.value + text : text;
      el.dispatchEvent(new FakeEvent('input', { bubbles: true }));
    },
    change(el) {
      el.dispatchEvent(new FakeEvent('change', { bubbles: true }));
    },
    key(el, key, init = {}) {
      const ev = new FakeEvent('keydown', { bubbles: true, key, ...init });
      el.dispatchEvent(ev);
      return ev;
    },
    /** Tlačítko/odkaz podle textu (volitelně v rámci kontejneru). */
    byText(text, scope = document, sel = 'button, a') {
      return scope.querySelectorAll(sel).find((e) => e.textContent.replace(/\s+/g, ' ').trim().includes(text)) || null;
    },
    /** Otevřené dialogy. */
    dialogs() {
      return document.querySelectorAll('dialog[open]');
    },
    /** Texty toastů. */
    toasts() {
      return document.querySelectorAll('.toast').map((t) => t.textContent);
    },
  };
}

/**
 * Kontext pohledu (náhrada ctx z app.js) se záznamem volání. Akce horní lišty (setActions) se připojí do
 * ctx.actionsEl v dokumentu, aby na ně šlo klikat.
 */
function makeCtx(overrides = {}) {
  const calls = { title: [], sub: [], actions: [], navigate: [], query: [], changed: [], runPricing: [] };
  const cleanups = [];
  const d = globalThis.document;
  const actionsEl = d.createElement('div');
  actionsEl.setAttribute('class', 'top-actions');
  d.body.appendChild(actionsEl);
  const ctx = {
    params: {},
    query: {},
    signal: new AbortController().signal,
    me: { user: 'admin', scopes: ['read', 'import', 'export', 'admin'] },
    actionsEl,
    setTitle: (t, s) => calls.title.push([t, s]),
    setSub: (s) => calls.sub.push(s),
    setActions: (...n) => {
      const nodes = n.flat().filter(Boolean);
      calls.actions.push(nodes);
      actionsEl.replaceChildren(...nodes);
    },
    navigate: (hsh, o) => calls.navigate.push([hsh, o]),
    setQuery: (q) => calls.query.push(q),
    refreshBadge: () => {},
    notifyChanged: (w) => calls.changed.push(w),
    runPricing: async (o) => {
      calls.runPricing.push(o);
      return { run_id: 1, stats: {} };
    },
    onCleanup: (fn) => cleanups.push(fn),
    onChanged: () => {},
    loggedIn: () => {},
    calls,
    cleanups,
    ...overrides,
  };
  return ctx;
}

/** Text uzlu s normalizovanými mezerami (nezlomitelné mezery → mezera). */
const text = (el) => (el ? el.textContent : '').replace(/[\s  ]+/g, ' ').trim();

module.exports = { installDom, makeCtx, text, FakeEvent };
