// Záložky (role=tablist) s ovládáním šipkami. Obsah panelu se vykresluje líně při přepnutí.
import { h, mount, uid } from './dom.js';

/**
 * @param {{items: {id: string, label: string, badge?: any, render: (panel: HTMLElement) => any}[], active?: string,
 *          onChange?: (id: string) => void, label?: string}} o
 * @returns {{el: HTMLElement, panel: HTMLElement, setActive: (id: string) => void, setBadge: (id: string, v: any) => void, active: () => string}}
 */
export function tabs(o) {
  const base = uid('tabs');
  let active = o.active && o.items.some((i) => i.id === o.active) ? o.active : o.items[0]?.id;
  const panel = h('div', { class: 'tab-panel', role: 'tabpanel', tabindex: '0' });
  const buttons = new Map();
  const badges = new Map();
  const list = h('div', { class: 'tabs', role: 'tablist', 'aria-label': o.label || 'Záložky' });
  for (const it of o.items) {
    const badgeEl = h('span', { class: 'tab-badge', hidden: it.badge == null || it.badge === '' }, it.badge == null ? '' : String(it.badge));
    badges.set(it.id, badgeEl);
    const b = h(
      'button',
      {
        type: 'button',
        role: 'tab',
        id: base + '-' + it.id,
        'aria-controls': base + '-panel',
        dataset: { tab: it.id },
        onClick: () => setActive(it.id, true),
      },
      h('span', null, it.label),
      badgeEl
    );
    buttons.set(it.id, b);
    list.appendChild(b);
  }
  panel.id = base + '-panel';
  list.addEventListener('keydown', (e) => {
    const ids = o.items.map((i) => i.id);
    const i = ids.indexOf(active);
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = ids.length - 1;
    if (j != null) {
      e.preventDefault();
      setActive(ids[j], true);
      buttons.get(ids[j]).focus();
    }
  });

  function setActive(id, fire) {
    const it = o.items.find((x) => x.id === id);
    if (!it) return;
    active = id;
    for (const [bid, b] of buttons) {
      const on = bid === id;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('is-active', on);
    }
    panel.setAttribute('aria-labelledby', base + '-' + id);
    mount(panel);
    const r = it.render(panel);
    if (r && typeof r === 'object' && typeof r.nodeType === 'number') panel.appendChild(r);
    if (fire && o.onChange) o.onChange(id);
  }

  function setBadge(id, v) {
    const b = badges.get(id);
    if (!b) return;
    b.textContent = v == null ? '' : String(v);
    b.hidden = v == null || v === '' || v === 0;
  }

  const el = h('div', { class: 'tabs-wrap' }, list, panel);
  setActive(active, false);
  return { el, panel, setActive: (id) => setActive(id, true), setBadge, active: () => active };
}
