// Modální dialogy nad nativním <dialog> (focus trap a Esc zajišťuje prohlížeč).
import { h, uid } from './dom.js';
import { icon } from './icons.js';
import { rehomeToasts } from './toast.js';

/**
 * Otevře modální dialog.
 * @param {{title: string, body: Node|Node[], footer?: Node[], size?: 'sm'|'md'|'lg'|'xl', onClose?: Function,
 *          closeOnBackdrop?: boolean, initialFocus?: string, description?: string}} o
 * @returns {{el: HTMLDialogElement, body: HTMLElement, footer: HTMLElement, close: (reason?: string) => void}}
 */
export function openModal(o) {
  const titleId = uid('dlg-title');
  const body = h('div', { class: 'modal-body' }, o.body);
  const footer = h('footer', { class: 'modal-foot' }, o.footer || []);
  const dlg = h(
    'dialog',
    { class: ['modal', 'modal-' + (o.size || 'md')], 'aria-labelledby': titleId },
    h(
      'div',
      { class: 'modal-card' },
      h(
        'header',
        { class: 'modal-head' },
        h('h2', { id: titleId, class: 'modal-title' }, o.title),
        h('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Zavřít dialog', onClick: () => close('x') }, icon('x', { size: 18 }))
      ),
      o.description ? h('p', { class: 'modal-desc' }, o.description) : null,
      body,
      o.footer ? footer : null
    )
  );
  const previous = document.activeElement;
  let closed = false;
  function close(reason) {
    if (closed) return;
    closed = true;
    try {
      dlg.close();
    } catch {
      /* už zavřeno */
    }
    rehomeToasts(dlg);
    dlg.remove();
    if (previous && typeof previous.focus === 'function' && previous.isConnected) previous.focus();
    if (o.onClose) o.onClose(reason);
  }
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close('esc');
  });
  // klik na podklad: cílem je samotný <dialog> (karta vyplňuje celý obsah dialogu)
  dlg.addEventListener('mousedown', (e) => {
    if (e.target === dlg && o.closeOnBackdrop !== false) close('backdrop');
  });
  document.body.appendChild(dlg);
  dlg.showModal();
  if (o.initialFocus) {
    const f = dlg.querySelector(o.initialFocus);
    if (f) f.focus();
  }
  return { el: dlg, body, footer, close };
}

/**
 * Potvrzovací dialog. Vrací Promise<boolean>.
 * @param {{title?: string, message: string|Node, confirmLabel?: string, cancelLabel?: string, danger?: boolean, details?: Node}} o
 */
export function confirmDialog(o) {
  return new Promise((resolve) => {
    let result = false;
    const confirmBtn = h(
      'button',
      {
        type: 'button',
        class: ['btn', o.danger ? 'btn-danger' : 'btn-primary'],
        'data-confirm': '1',
        onClick: () => {
          result = true;
          m.close('confirm');
        },
      },
      o.confirmLabel || 'Potvrdit'
    );
    const cancelBtn = h('button', { type: 'button', class: 'btn', 'data-cancel': '1', onClick: () => m.close('cancel') }, o.cancelLabel || 'Zrušit');
    const m = openModal({
      title: o.title || 'Potvrzení',
      size: 'sm',
      body: [typeof o.message === 'string' ? h('p', null, o.message) : o.message, o.details || null],
      footer: [cancelBtn, confirmBtn],
      onClose: () => resolve(result),
    });
    (o.danger ? cancelBtn : confirmBtn).focus();
  });
}
