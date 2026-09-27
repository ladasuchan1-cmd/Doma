'use strict';
// Testy bezpečného DOM pomocníka (public/lib/dom.js) nad minimálním falešným dokumentem.
// Hlídají, že data nikdy nejdou do innerHTML a že nebezpečné URL se neuloží.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.childNodes = [];
    this.parentNode = null;
  }
  appendChild(c) {
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  removeChild(c) {
    this.childNodes = this.childNodes.filter((x) => x !== c);
    c.parentNode = null;
    return c;
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.childNodes = [new FakeText(String(v))];
  }
}
class FakeText extends FakeNode {
  constructor(t) {
    super(3);
    this.data = t;
  }
  get textContent() {
    return this.data;
  }
}
class FakeElement extends FakeNode {
  constructor(tag, ns) {
    super(1);
    this.tagName = tag.toUpperCase();
    this.namespaceURI = ns || 'http://www.w3.org/1999/xhtml';
    this.attributes = {};
    this.listeners = {};
    const styles = {};
    this.style = { setProperty: (k, v) => { styles[k] = v; }, _all: styles };
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }
  getAttribute(k) {
    return k in this.attributes ? this.attributes[k] : null;
  }
  addEventListener(ev, fn) {
    (this.listeners[ev] ||= []).push(fn);
  }
  set innerHTML(v) {
    throw new Error('innerHTML se nesmí použít');
  }
}
globalThis.document = {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t, ns),
  createTextNode: (t) => new FakeText(t),
  createDocumentFragment: () => new FakeNode(11),
};

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'lib', 'dom.js')).href);

test('h(): text jako textový uzel, ne HTML', async () => {
  const { h } = await load();
  const el = h('div', { class: 'x' }, '<img src=x onerror=alert(1)>', 42, null, false, ['a', ['b']]);
  assert.strictEqual(el.tagName, 'DIV');
  assert.strictEqual(el.getAttribute('class'), 'x');
  assert.ok(el.childNodes.every((c) => c.nodeType === 3), 'jen textové uzly');
  assert.strictEqual(el.textContent, '<img src=x onerror=alert(1)>42ab');
  const noProps = h('p', 'jen text');
  assert.strictEqual(noProps.textContent, 'jen text');
});

test('h(): innerHTML/outerHTML v props je zakázané', async () => {
  const { h } = await load();
  assert.throws(() => h('div', { innerHTML: '<b>x</b>' }), /zakázaná/);
  assert.throws(() => h('div', { outerHTML: 'x' }), /zakázaná/);
});

test('h(): atributy, třídy, styl, dataset, události, property', async () => {
  const { h } = await load();
  let clicked = 0;
  const el = h('input', {
    class: ['a', null, { b: true, c: false }],
    style: { marginTop: '4px', '--x': 1 },
    dataset: { rowKey: 5 },
    onClick: () => clicked++,
    value: 'v',
    checked: true,
    disabled: true,
    hidden: false,
    title: null,
    'aria-label': 'Popis',
  });
  assert.strictEqual(el.getAttribute('class'), 'a b');
  assert.strictEqual(el.style._all['margin-top'], '4px');
  assert.strictEqual(el.style._all['--x'], '1');
  assert.strictEqual(el.getAttribute('data-row-key'), '5');
  assert.strictEqual(el.value, 'v');
  assert.strictEqual(el.checked, true);
  assert.strictEqual(el.getAttribute('disabled'), '');
  assert.strictEqual(el.getAttribute('hidden'), null);
  assert.strictEqual(el.getAttribute('title'), null);
  assert.strictEqual(el.getAttribute('aria-label'), 'Popis');
  el.listeners.click[0]();
  assert.strictEqual(clicked, 1);
});

test('safeUrl a href: javascript: a podobná schémata se neuloží', async () => {
  const { h, safeUrl } = await load();
  assert.strictEqual(safeUrl('https://velomarket.example/p/1'), 'https://velomarket.example/p/1');
  assert.strictEqual(safeUrl('#/produkty/1'), '#/produkty/1');
  assert.strictEqual(safeUrl('/api/v1/export/changes.csv'), '/api/v1/export/changes.csv');
  assert.strictEqual(safeUrl('mailto:a@b.cz'), 'mailto:a@b.cz');
  assert.strictEqual(safeUrl('javascript:alert(1)'), '#');
  assert.strictEqual(safeUrl(' JaVaScRiPt:alert(1)'), '#');
  assert.strictEqual(safeUrl('java\tscript:alert(1)'), '#');
  assert.strictEqual(safeUrl('vbscript:x'), '#');
  assert.strictEqual(safeUrl('data:text/html,<script>'), '#');
  assert.strictEqual(safeUrl('data:image/png;base64,AAA', { allowData: true }), 'data:image/png;base64,AAA');
  assert.strictEqual(safeUrl(null), '#');
  const a = h('a', { href: 'javascript:alert(1)' }, 'x');
  assert.strictEqual(a.getAttribute('href'), '#');
});

test('svg(): prvky ve jmenném prostoru SVG', async () => {
  const { svg } = await load();
  const s = svg('svg', { viewBox: '0 0 10 10', class: 'icon' }, svg('path', { d: 'M0 0L1 1' }));
  assert.strictEqual(s.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.strictEqual(s.getAttribute('viewBox'), '0 0 10 10');
  assert.strictEqual(s.childNodes[0].getAttribute('d'), 'M0 0L1 1');
});

test('mount/clear a debounce', async () => {
  const { h, mount, clear, debounce } = await load();
  const el = h('div', null, 'a', 'b');
  mount(el, 'c');
  assert.strictEqual(el.textContent, 'c');
  clear(el);
  assert.strictEqual(el.childNodes.length, 0);
  let n = 0;
  const d = debounce(() => n++, 10);
  d();
  d();
  d();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(n, 1);
  d();
  d.cancel();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(n, 1);
});
