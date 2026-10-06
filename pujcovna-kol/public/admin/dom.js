// Pomocníci pro DOM (admin, progresivní JS). Převzato a zjednodušeno z ../repricing/public/lib/dom.js – bez modulů,
// vše pod window.PKAdmin. h(tag, attrs, ...children) staví prvky bez innerHTML (CSP bez unsafe-inline, žádný HTML string).
(function () {
  'use strict';
  const PKAdmin = (window.PKAdmin = window.PKAdmin || {});

  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) {
      child.forEach((c) => append(el, c));
      return;
    }
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  /** h('button', { class: ['btn', cond && 'btn--sm'], onClick, dataset: { x: 1 } }, 'Text') */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
    append(el, children);
    return el;
  }

  function mount(parent, ...children) {
    parent.replaceChildren();
    append(parent, children);
    return parent;
  }

  /** Je cíl kliknutí interaktivní prvek (odkaz, tlačítko, pole)? */
  function isInteractive(target, until) {
    let el = target;
    while (el && el !== until) {
      if (el.matches && el.matches('a, button, input, select, textarea, label, summary, [role="button"]')) return true;
      el = el.parentElement;
    }
    return false;
  }

  let counter = 0;
  function uid(prefix) {
    counter += 1;
    return `${prefix || 'id'}-${counter}`;
  }

  PKAdmin.h = h;
  PKAdmin.mount = mount;
  PKAdmin.isInteractive = isInteractive;
  PKAdmin.uid = uid;
})();
