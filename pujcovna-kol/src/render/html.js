'use strict';
// Bezpečné skládání HTML (SPEC kap. 6): tagged template html`` escapuje všechny ${} hodnoty.
//   html`<p>${text}</p>`         → Html fragment (string → escapovaný, number → text, null/undefined/false → '',
//                                   Html → vložen beze změny, pole → spojeno)
//   raw(str)                      → označí už escapovaný fragment (výstup markdownu, komponent)
//   escape(str)                   → escapovaný text (& < > " ')
//   attr(obj)                     → ' name="value"' pro každý klíč; true → jen název, false/null → vynecháno
//   joinHtml(list, separator)     → spojí fragmenty
// Výstup renderu je objekt Html; String(fragment) nebo fragment.toString() vrátí HTML text.

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

class Html {
  constructor(value) {
    this.value = String(value);
  }
  toString() {
    return this.value;
  }
  toJSON() {
    return this.value;
  }
}

function escape(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

function raw(value) {
  if (value instanceof Html) return value;
  return new Html(value === null || value === undefined ? '' : value);
}

function render(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return ''; // true samostatně nic nevypíše (jako v JSX)
  if (typeof value === 'object' && typeof value.toHtml === 'function') return render(value.toHtml());
  return escape(value);
}

function html(strings, ...values) {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += render(values[i]);
  }
  return new Html(out);
}

/** Atributy: { class: 'x', disabled: true, hidden: false, 'data-id': 3 } → ' class="x" disabled data-id="3"'. */
function attr(obj) {
  if (!obj) return new Html('');
  let out = '';
  for (const [name, value] of Object.entries(obj)) {
    if (value === null || value === undefined || value === false) continue;
    if (!/^[A-Za-z_:][A-Za-z0-9_:.-]*$/.test(name)) throw new Error(`Neplatný název atributu: ${name}`);
    if (value === true) out += ` ${name}`;
    else out += ` ${name}="${escape(value)}"`;
  }
  return new Html(out);
}

function joinHtml(list, separator = '') {
  const sep = render(separator);
  return new Html((list || []).map(render).join(sep));
}

/** Je hodnota bezpečný fragment? */
function isHtml(value) {
  return value instanceof Html;
}

module.exports = { Html, html, raw, escape, attr, joinHtml, isHtml, render };
