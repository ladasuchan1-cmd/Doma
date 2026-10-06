// Oznámení (toasty) vpravo dole – aria-live, chyby jako role=alert. Vzor ../repricing/public/lib/toast.js (bez modulů).
// PKAdmin.toast(message, { tone: 'info'|'success'|'warning'|'danger', timeout, node }) → { close }
(function () {
  'use strict';
  const PKAdmin = (window.PKAdmin = window.PKAdmin || {});
  const { h } = PKAdmin;
  let container = null;

  function ensure() {
    const dialogs = document.querySelectorAll('dialog[open]');
    const host = dialogs.length ? dialogs[dialogs.length - 1] : document.body;
    if (!container || !container.isConnected || container.parentNode !== host) {
      container = h('div', { class: 'toasts', 'aria-live': 'polite', 'aria-relevant': 'additions' });
      host.appendChild(container);
    }
    return container;
  }

  function toast(message, opts = {}) {
    const tone = opts.tone || 'info';
    const timeout = opts.timeout ?? (tone === 'danger' ? 9000 : 4500);
    let timer = null;
    const close = () => {
      if (timer) clearTimeout(timer);
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 200);
    };
    const el = h(
      'div',
      { class: ['toast', `toast--${tone}`], role: tone === 'danger' || tone === 'warning' ? 'alert' : 'status' },
      h('div', { class: 'toast__body' }, opts.node || message),
      h('button', { type: 'button', class: 'toast__close', 'aria-label': 'Zavřít oznámení', onClick: close }, '×')
    );
    const host = ensure();
    host.appendChild(el);
    while (host.children.length > 4) host.firstChild.remove();
    if (timeout > 0) {
      timer = setTimeout(close, timeout);
      el.addEventListener('pointerenter', () => timer && clearTimeout(timer));
      el.addEventListener('pointerleave', () => {
        timer = setTimeout(close, 2000);
      });
    }
    return { close };
  }

  PKAdmin.toast = toast;
})();
