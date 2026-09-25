// Oznámení (toasty) – vpravo dole, aria-live, chyby jako role=alert.
import { h } from './dom.js';
import { icon } from './icons.js';

let container = null;

// Otevřený modální <dialog> leží v top layer nad celou stránkou – toasty proto vkládáme do něj,
// jinak by zůstaly schované pod podkladem dialogu.
function ensure() {
  const dialogs = document.querySelectorAll('dialog[open]');
  const host = dialogs.length ? dialogs[dialogs.length - 1] : document.body;
  if (!container || !container.isConnected || container.parentNode !== host) {
    container = h('div', { class: 'toasts', 'aria-live': 'polite', 'aria-relevant': 'additions' });
    host.appendChild(container);
  }
  return container;
}

const ICON = { success: 'check', error: 'alert-circle', warning: 'alert', info: 'info' };

/**
 * Zobrazí oznámení.
 * @param {string} message
 * @param {{type?: 'info'|'success'|'warning'|'error', timeout?: number, details?: string[]|string, action?: {label: string, onClick: Function}}} [opts]
 * @returns {{close: Function}}
 */
export function toast(message, opts = {}) {
  if (typeof document === 'undefined') return { close() {} };
  const type = opts.type || 'info';
  const timeout = opts.timeout ?? (type === 'error' ? 8000 : 4000);
  const details = Array.isArray(opts.details) ? opts.details : opts.details ? [String(opts.details)] : [];
  let timer = null;
  const close = () => {
    if (timer) clearTimeout(timer);
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 180);
  };
  const el = h(
    'div',
    { class: ['toast', 'toast-' + type], role: type === 'error' ? 'alert' : 'status' },
    h('span', { class: 'toast-icon' }, icon(ICON[type] || 'info', { size: 18 })),
    h(
      'div',
      { class: 'toast-body' },
      h('div', { class: 'toast-msg' }, message),
      details.length
        ? h('ul', { class: 'toast-details' }, details.slice(0, 5).map((d) => h('li', null, typeof d === 'string' ? d : d?.message || JSON.stringify(d))))
        : null,
      opts.action
        ? h('button', { type: 'button', class: 'btn btn-sm btn-ghost toast-action', onClick: () => { opts.action.onClick(); close(); } }, opts.action.label)
        : null
    ),
    h('button', { type: 'button', class: 'btn-icon toast-close', 'aria-label': 'Zavřít oznámení', onClick: close }, icon('x', { size: 14 }))
  );
  const host = ensure();
  host.appendChild(el);
  // nejvýš 4 současně – nejstarší zmizí
  while (host.children.length > 4) host.firstChild.remove();
  if (timeout > 0) {
    timer = setTimeout(close, timeout);
    el.addEventListener('mouseenter', () => timer && clearTimeout(timer));
    el.addEventListener('mouseleave', () => { timer = setTimeout(close, 2000); });
  }
  return { close };
}
