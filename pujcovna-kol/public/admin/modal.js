// Modální dialogy nad nativním <dialog> (fokus a Esc řeší prohlížeč). Vzor ../repricing/public/lib/modal.js.
// PKAdmin.openModal({ title, body, footer, onClose }) → { el, close }; PKAdmin.confirmDialog({ message, danger }) → Promise<boolean>
(function () {
  'use strict';
  const PKAdmin = (window.PKAdmin = window.PKAdmin || {});
  const { h, uid } = PKAdmin;
  const open = new Set();

  function openModal(o) {
    const titleId = uid('dlg-title');
    const dlg = h(
      'dialog',
      { class: 'admin-dialog', 'aria-labelledby': titleId },
      h('div', { class: 'admin-dialog__body' }, h('h2', { id: titleId, class: 'admin-dialog__title' }, o.title || 'Potvrzení'), o.body),
      o.footer ? h('div', { class: 'admin-dialog__actions' }, o.footer) : null
    );
    const previous = document.activeElement;
    let closed = false;
    const handle = {
      el: dlg,
      close(reason) {
        if (closed) return;
        closed = true;
        open.delete(handle);
        try {
          dlg.close();
        } catch {
          /* už zavřeno */
        }
        dlg.remove();
        if (previous && typeof previous.focus === 'function' && previous.isConnected) previous.focus();
        if (o.onClose) o.onClose(reason);
      },
    };
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      handle.close('esc');
    });
    dlg.addEventListener('mousedown', (e) => {
      if (e.target === dlg) handle.close('backdrop');
    });
    document.body.appendChild(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    open.add(handle);
    return handle;
  }

  function confirmDialog(o) {
    return new Promise((resolve) => {
      let result = false;
      const ok = h('button', { type: 'button', class: ['btn', o.danger ? 'btn--danger' : 'btn--primary'], onClick: () => { result = true; m.close('confirm'); } }, o.confirmLabel || 'Potvrdit');
      const cancel = h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close('cancel') }, o.cancelLabel || 'Zrušit');
      const m = openModal({ title: o.title || 'Potvrzení', body: h('p', null, o.message), footer: [cancel, ok], onClose: () => resolve(result) });
      (o.danger ? cancel : ok).focus();
    });
  }

  PKAdmin.openModal = openModal;
  PKAdmin.confirmDialog = confirmDialog;
  PKAdmin.closeAllModals = () => [...open].forEach((m) => m.close('nav'));
})();
