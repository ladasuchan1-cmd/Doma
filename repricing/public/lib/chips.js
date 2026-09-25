// Vstup pro více hodnot („čipy“) s našeptávačem: Enter / čárka přidá, Backspace odebere poslední.
import { h, mount } from './dom.js';
import { icon } from './icons.js';
import { combobox, staticSource } from './combobox.js';

/**
 * @param {{values?: any[], suggestions?: {value, label?, count?}[] | string[], placeholder?: string, onChange?: (values: any[]) => void,
 *          id?: string, ariaLabel?: string, allowNew?: boolean, parse?: (s: string) => any, format?: (v: any) => string}} o
 */
export function chipsInput(o = {}) {
  let values = Array.isArray(o.values) ? [...o.values] : [];
  let suggestions = normalize(o.suggestions || []);
  const fmt = o.format || ((v) => String(v));
  const chipsEl = h('span', { class: 'chips-list' });
  const input = h('input', {
    type: 'text',
    class: 'chips-input',
    id: o.id,
    placeholder: values.length ? '' : o.placeholder || 'Přidat…',
    'aria-label': o.ariaLabel || o.placeholder || 'Hodnoty',
  });
  const inner = h('span', { class: 'chips-inner' }, input);
  const el = h('div', { class: 'chips', onClick: (e) => { if (e.target === el || e.target === chipsEl) input.focus(); } }, chipsEl, inner);

  function normalize(list) {
    return list.map((s) => (typeof s === 'object' && s !== null ? { value: s.value, label: s.label ?? String(s.value), count: s.count } : { value: s, label: String(s) }));
  }

  function emit() {
    input.placeholder = values.length ? '' : o.placeholder || 'Přidat…';
    if (o.onChange) o.onChange([...values]);
  }

  function renderChips() {
    mount(
      chipsEl,
      values.map((v, i) =>
        h(
          'span',
          { class: 'chip' },
          h('span', { class: 'chip-text' }, labelOf(v)),
          h(
            'button',
            {
              type: 'button',
              class: 'chip-x',
              'aria-label': 'Odebrat ' + labelOf(v),
              onClick: () => {
                values.splice(i, 1);
                renderChips();
                emit();
                input.focus();
              },
            },
            icon('x', { size: 12 })
          )
        )
      )
    );
  }

  function labelOf(v) {
    const s = suggestions.find((x) => String(x.value) === String(v));
    return s && s.label !== String(s.value) ? s.label : fmt(v);
  }

  function add(raw) {
    const parts = String(raw).split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    let changed = false;
    for (const p of parts) {
      let v = p;
      const s = suggestions.find((x) => x.label.toLowerCase() === p.toLowerCase() || String(x.value).toLowerCase() === p.toLowerCase());
      if (s) v = s.value;
      else if (o.allowNew === false) continue;
      if (o.parse) {
        v = o.parse(v);
        if (v == null || Number.isNaN(v)) continue;
      }
      if (!values.some((x) => String(x) === String(v))) {
        values.push(v);
        changed = true;
      }
    }
    input.value = '';
    if (changed) {
      renderChips();
      emit();
    }
  }

  const cb = combobox(input, {
    source: staticSource(() => suggestions, () => new Set(values.map(String))),
    onPick: (it) => {
      add(String(it.value));
      input.focus();
    },
    emptyText: o.allowNew === false ? 'Žádná další hodnota' : 'Enter přidá zadanou hodnotu',
  });

  input.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ';') && input.value.trim()) {
      if (e.key === 'Enter' && cb.hasActive()) return; // vybere combobox
      e.preventDefault();
      add(input.value);
    } else if (e.key === 'Enter') {
      e.preventDefault();
    } else if (e.key === 'Backspace' && !input.value && values.length) {
      values.pop();
      renderChips();
      emit();
    }
  });
  input.addEventListener('paste', (e) => {
    const t = e.clipboardData?.getData('text');
    if (t && /[,;\n]/.test(t)) {
      e.preventDefault();
      add(t);
    }
  });
  input.addEventListener('blur', () => {
    if (input.value.trim() && o.allowNew !== false) add(input.value);
  });

  renderChips();
  return {
    el,
    input,
    getValues: () => [...values],
    setValues: (v) => {
      values = Array.isArray(v) ? [...v] : [];
      renderChips();
    },
    setSuggestions: (s) => {
      suggestions = normalize(s || []);
      renderChips();
    },
  };
}
