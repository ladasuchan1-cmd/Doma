// Našeptávač (ARIA combobox + listbox) nad textovým vstupem. Zdroj může být synchronní i asynchronní.
import { h, mount, uid, debounce } from './dom.js';
import { fold } from './format.js';

/**
 * Připojí našeptávač ke vstupu. Vstup musí mít rodiče s position: relative (třída .cb).
 * @param {HTMLInputElement} input
 * @param {{source: (q: string) => (Promise<any[]>|any[]), onPick: (item: any) => void, render?: (item: any) => any,
 *          minChars?: number, delay?: number, emptyText?: string, openOnFocus?: boolean}} o
 *   položky: {value, label, sub?, count?}
 */
export function combobox(input, o) {
  const listId = uid('lb');
  const list = h('ul', { class: 'cb-list', role: 'listbox', id: listId, hidden: true });
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('autocomplete', 'off');
  const host = input.parentNode;
  if (host) {
    host.classList.add('cb');
    host.appendChild(list);
  }
  let items = [];
  let activeIdx = -1;
  let seq = 0;
  let open = false;

  function close() {
    open = false;
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIdx = -1;
  }

  function highlight(i) {
    activeIdx = i;
    [...list.children].forEach((li, j) => {
      const on = j === i;
      li.classList.toggle('is-active', on);
      li.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) {
        input.setAttribute('aria-activedescendant', li.id);
        li.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function pick(i) {
    const it = items[i];
    if (!it) return;
    close();
    o.onPick(it);
  }

  function renderList(loading) {
    if (loading) {
      mount(list, h('li', { class: 'cb-empty', role: 'presentation' }, 'Hledám…'));
    } else if (!items.length) {
      mount(list, h('li', { class: 'cb-empty', role: 'presentation' }, o.emptyText || 'Nic nenalezeno'));
    } else {
      mount(
        list,
        items.map((it, i) =>
          h(
            'li',
            {
              role: 'option',
              id: listId + '-' + i,
              class: 'cb-item',
              'aria-selected': 'false',
              onMousedown: (e) => {
                e.preventDefault();
                pick(i);
              },
            },
            o.render
              ? o.render(it)
              : [h('span', { class: 'cb-label' }, it.label ?? String(it.value)), it.sub ? h('span', { class: 'cb-sub' }, it.sub) : null, it.count != null ? h('span', { class: 'cb-count' }, String(it.count)) : null]
          )
        )
      );
    }
    list.hidden = false;
    open = true;
    input.setAttribute('aria-expanded', 'true');
  }

  const run = async () => {
    const q = input.value;
    if ((o.minChars || 0) > q.trim().length) {
      close();
      return;
    }
    const my = ++seq;
    const res = o.source(q);
    if (res && typeof res.then === 'function') renderList(true);
    let out;
    try {
      out = await res;
    } catch {
      out = [];
    }
    if (my !== seq || document.activeElement !== input) return;
    items = Array.isArray(out) ? out.slice(0, 50) : [];
    renderList(false);
    if (items.length) highlight(0);
  };
  const runDebounced = debounce(run, o.delay ?? 120);

  input.addEventListener('input', () => runDebounced());
  input.addEventListener('focus', () => {
    if (o.openOnFocus !== false) run();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) run();
      else highlight(Math.min(items.length - 1, activeIdx + 1));
    } else if (e.key === 'ArrowUp') {
      if (!open) return;
      e.preventDefault();
      highlight(Math.max(0, activeIdx - 1));
    } else if (e.key === 'Enter') {
      if (open && activeIdx >= 0) {
        e.preventDefault();
        e.stopPropagation();
        pick(activeIdx);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    }
  });

  return { close, refresh: run, isOpen: () => open, hasActive: () => open && activeIdx >= 0 };
}

/** Pomocník: statický zdroj s filtrováním bez diakritiky. */
export function staticSource(getItems, exclude) {
  return (q) => {
    const f = fold(q);
    const all = typeof getItems === 'function' ? getItems() : getItems;
    const ex = exclude ? exclude() : null;
    return all
      .filter((it) => !ex || !ex.has(String(it.value)))
      .filter((it) => !f || fold(it.label ?? it.value).includes(f));
  };
}
