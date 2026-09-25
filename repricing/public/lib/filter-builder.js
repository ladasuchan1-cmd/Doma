// Editor filtru segmentu (SPEC §6.4): vnořené skupiny all/any (+ negace), výběr pole podle skupin z /fields,
// operátory podle typu pole, hodnoty s našeptáváním z /products/facets, více hodnot pro in/not_in.
import { h, mount } from './dom.js';
import { icon } from './icons.js';
import { numberInput, segmented } from './ui.js';
import { chipsInput } from './chips.js';
import { combobox, staticSource } from './combobox.js';
import { parseInputNumber } from './format.js';
import {
  toModel, fromModel, newCond, newGroup, opsFor, defaultOp, OP_LABELS, NO_VALUE_OPS, LIST_OPS, KNOWN_ENUMS, parseList,
} from './filter-model.js';

const FACET_KEYS = { manufacturer: 'manufacturers', category: 'categories', owner: 'owners', supplier: 'suppliers' };

/** Návrhy hodnot pro pole z odpovědi /products/facets. */
export function suggestionsFor(field, facets) {
  if (!field) return [];
  if (field.type === 'enum') {
    const vals = field.values || field.options || KNOWN_ENUMS[field.key]?.map((x) => x.value) || [];
    const known = KNOWN_ENUMS[field.key] || [];
    return vals.map((v) => (typeof v === 'object' ? { value: v.value, label: v.label ?? String(v.value) } : { value: v, label: known.find((k) => k.value === v)?.label || String(v) }));
  }
  if (!facets) return [];
  let list = null;
  if (FACET_KEYS[field.key]) list = facets[FACET_KEYS[field.key]];
  else if (field.key.startsWith('attrs.') && facets.attrs) list = facets.attrs[field.key.slice(6)];
  if (!Array.isArray(list)) return [];
  return list.map((x) => (typeof x === 'object' ? { value: x.value, label: String(x.value), count: x.count } : { value: x, label: String(x) }));
}

/**
 * @param {{value?: object, fields: {key, label, type, group, values?}[], facets?: object, onChange?: (filter: object, errors: object[]) => void, maxDepth?: number}} o
 * @returns {{el: HTMLElement, getFilter: () => object, getErrors: () => object[], setFilter: (f: object) => void}}
 */
export function filterBuilder(o) {
  const maxDepth = o.maxDepth ?? 3;
  const fields = [...(o.fields || [])];
  const fieldsMap = new Map(fields.map((f) => [f.key, f]));
  let model = toModel(o.value || {});
  let lastErrors = [];
  const touched = new Set();
  const el = h('div', { class: 'fb' });

  // pole použitá ve filtru, která /fields nezná (např. starý atribut) – doplnit jako text
  function ensureFields(node) {
    if (node.kind === 'cond' && node.field && !fieldsMap.has(node.field)) {
      const f = { key: node.field, label: node.field.startsWith('attrs.') ? node.field.slice(6) : node.field, type: 'string', group: 'Ostatní' };
      fields.push(f);
      fieldsMap.set(f.key, f);
    }
    if (node.kind === 'group') node.items.forEach(ensureFields);
  }
  ensureFields(model);

  function groupedFieldOptions() {
    const groups = new Map();
    for (const f of fields) {
      const g = f.group || 'Ostatní';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(f);
    }
    return groups;
  }

  function emit() {
    const { filter, errors } = fromModel(model, fieldsMap);
    lastErrors = errors;
    markErrors();
    if (o.onChange) o.onChange(filter, errors);
  }

  function markErrors() {
    const byId = new Map(lastErrors.map((e) => [e.id, e.message]));
    el.querySelectorAll('.fb-cond').forEach((row) => {
      const msg = byId.get(row.dataset.id);
      const show = msg && touched.has(row.dataset.id);
      row.classList.toggle('is-invalid', Boolean(show));
      const err = row.querySelector('.fb-err');
      if (err) err.textContent = show ? msg + ' – podmínka se zatím ignoruje' : '';
    });
  }

  function fieldSelect(c) {
    const sel = h('select', { class: 'select fb-field', 'aria-label': 'Pole' });
    sel.appendChild(h('option', { value: '' }, '— vyberte pole —'));
    for (const [g, list] of groupedFieldOptions()) {
      const og = h('optgroup', { label: g });
      for (const f of list) og.appendChild(h('option', { value: f.key }, f.label));
      sel.appendChild(og);
    }
    sel.value = c.field || '';
    sel.addEventListener('change', () => {
      const f = fieldsMap.get(sel.value);
      c.field = sel.value;
      const type = f?.type || 'string';
      if (!opsFor(type).includes(c.op)) c.op = defaultOp(type);
      c.value = LIST_OPS.has(c.op) ? [] : '';
      touched.add(c.id);
      replaceCond(c);
      emit();
    });
    return sel;
  }

  function opSelect(c, type) {
    const sel = h('select', { class: 'select fb-op', 'aria-label': 'Operátor' }, opsFor(type).map((op) => h('option', { value: op }, OP_LABELS[op])));
    sel.value = c.op || defaultOp(type);
    if (!c.op) c.op = sel.value;
    sel.addEventListener('change', () => {
      const prev = c.op;
      c.op = sel.value;
      if (LIST_OPS.has(c.op) && !LIST_OPS.has(prev)) c.value = c.value === '' || c.value == null ? [] : parseList(c.value);
      else if (!LIST_OPS.has(c.op) && LIST_OPS.has(prev)) c.value = Array.isArray(c.value) ? c.value[0] ?? '' : c.value;
      if (c.op === 'between' && !Array.isArray(c.value)) c.value = [c.value ?? '', ''];
      else if (prev === 'between' && c.op !== 'between' && Array.isArray(c.value) && !LIST_OPS.has(c.op)) c.value = c.value[0] ?? '';
      touched.add(c.id);
      replaceCond(c);
      emit();
    });
    return sel;
  }

  function valueEditor(c, f) {
    const type = f?.type || 'string';
    const op = c.op;
    if (!c.field || NO_VALUE_OPS.has(op)) return null;
    const onVal = (v) => {
      c.value = v;
      touched.add(c.id);
      emit();
    };
    if (op === 'between') {
      const arr = Array.isArray(c.value) ? c.value : ['', ''];
      const a = numberInput(arr[0], { ariaLabel: 'Od', placeholder: 'od', size: 7 });
      const b = numberInput(arr[1], { ariaLabel: 'Do', placeholder: 'do', size: 7 });
      const upd = () => onVal([a.value, b.value]);
      a.addEventListener('input', upd);
      b.addEventListener('input', upd);
      return h('div', { class: 'fb-between' }, a, h('span', { class: 'muted' }, 'a'), b);
    }
    const sugg = suggestionsFor(f, o.facets);
    if (LIST_OPS.has(op)) {
      const chips = chipsInput({
        values: Array.isArray(c.value) ? c.value : parseList(c.value),
        suggestions: sugg,
        placeholder: sugg.length ? 'Vyberte nebo napište…' : 'Napište a Enter…',
        ariaLabel: 'Hodnoty',
        allowNew: type !== 'enum',
        parse: type === 'number' ? (s) => parseInputNumber(s) : null,
        onChange: onVal,
      });
      chips.el.classList.add('fb-value');
      return chips.el;
    }
    if (type === 'enum') {
      const sel = h('select', { class: 'select fb-value', 'aria-label': 'Hodnota' }, h('option', { value: '' }, '— vyberte —'), sugg.map((s) => h('option', { value: String(s.value) }, s.label)));
      sel.value = c.value == null ? '' : String(c.value);
      sel.addEventListener('change', () => onVal(sel.value));
      return sel;
    }
    if (type === 'number') {
      const inp = numberInput(c.value, { ariaLabel: 'Hodnota', placeholder: 'číslo', class: 'fb-value' });
      inp.addEventListener('input', () => onVal(inp.value));
      return inp;
    }
    const inp = h('input', { type: 'text', class: 'input fb-value', value: c.value == null ? '' : String(c.value), 'aria-label': 'Hodnota', placeholder: 'hodnota' });
    inp.addEventListener('input', () => onVal(inp.value));
    if (sugg.length) {
      const wrap = h('div', { class: 'fb-value cb-host' }, inp);
      combobox(inp, { source: staticSource(sugg), onPick: (it) => { inp.value = String(it.value); onVal(inp.value); } });
      return wrap;
    }
    return inp;
  }

  function renderCond(c, parent) {
    const f = fieldsMap.get(c.field);
    const type = f?.type || 'string';
    const row = h(
      'div',
      { class: 'fb-cond', dataset: { id: c.id } },
      h('div', { class: 'fb-cond-main' }, fieldSelect(c), c.field ? opSelect(c, type) : null, valueEditor(c, f)),
      h('button', {
        type: 'button', class: 'btn-icon fb-remove', 'aria-label': 'Odebrat podmínku', title: 'Odebrat podmínku',
        onClick: () => {
          parent.items = parent.items.filter((x) => x !== c);
          render();
          emit();
        },
      }, icon('trash', { size: 15 })),
      h('div', { class: 'fb-err', 'aria-live': 'polite' })
    );
    row._node = c;
    row._parent = parent;
    return row;
  }

  function replaceCond(c) {
    const row = el.querySelector(`.fb-cond[data-id="${c.id}"]`);
    if (!row) return render();
    const next = renderCond(c, row._parent);
    row.replaceWith(next);
    const focusTarget = next.querySelector('.fb-op') || next.querySelector('.fb-field');
    const valueTarget = next.querySelector('.fb-value input, input.fb-value, select.fb-value, .fb-between input');
    (valueTarget || focusTarget)?.focus();
  }

  function renderGroup(g, depth, parent) {
    const modeCtl = segmented(
      [
        { value: 'all', label: 'Všechny podmínky (A)' },
        { value: 'any', label: 'Kterákoli (NEBO)' },
      ],
      g.mode,
      (v) => {
        g.mode = v;
        render();
        emit();
      },
      { label: 'Způsob spojení podmínek', class: 'seg-sm' }
    );
    const negate = h('label', { class: 'check fb-negate' }, h('input', {
      type: 'checkbox', checked: g.negate,
      onChange: (e) => { g.negate = e.target.checked; render(); emit(); },
    }), h('span', null, 'Neplatí (NE)'));
    const addCond = h('button', {
      type: 'button', class: 'btn btn-sm', dataset: { action: 'add-cond' },
      onClick: () => {
        const c = newCond();
        g.items.push(c);
        render();
        el.querySelector(`.fb-cond[data-id="${c.id}"] .fb-field`)?.focus();
      },
    }, icon('plus', { size: 14 }), h('span', null, 'Podmínka'));
    const addGroup = depth < maxDepth
      ? h('button', {
        type: 'button', class: 'btn btn-sm', dataset: { action: 'add-group' },
        onClick: () => {
          const ng = newGroup(g.mode === 'all' ? 'any' : 'all');
          const c = newCond();
          ng.items.push(c);
          g.items.push(ng);
          render();
          el.querySelector(`.fb-cond[data-id="${c.id}"] .fb-field`)?.focus();
        },
      }, icon('layers', { size: 14 }), h('span', null, 'Skupina'))
      : null;
    const remove = parent
      ? h('button', {
        type: 'button', class: 'btn-icon', 'aria-label': 'Odebrat skupinu', title: 'Odebrat skupinu',
        onClick: () => {
          parent.items = parent.items.filter((x) => x !== g);
          render();
          emit();
        },
      }, icon('trash', { size: 15 }))
      : null;
    const conj = g.mode === 'any' ? 'nebo' : 'a';
    const items = [];
    g.items.forEach((it, i) => {
      if (i > 0) items.push(h('div', { class: 'fb-conj', 'aria-hidden': 'true' }, conj));
      items.push(it.kind === 'group' ? renderGroup(it, depth + 1, g) : renderCond(it, g));
    });
    return h(
      'div',
      { class: ['fb-group', g.negate ? 'is-negated' : null, 'depth-' + depth], dataset: { id: g.id, depth } },
      h('div', { class: 'fb-group-head' }, parent ? h('span', { class: 'fb-group-label' }, 'Skupina') : null, modeCtl, negate, h('span', { class: 'fb-spacer' }), addCond, addGroup, remove),
      h(
        'div',
        { class: 'fb-items' },
        items.length
          ? items
          : h('div', { class: 'fb-empty' }, parent ? 'Prázdná skupina se ignoruje – přidejte podmínku.' : 'Žádná podmínka – segment obsahuje všechny aktivní produkty. Přidejte podmínku, např. Výrobce je jedno z Trek, Specialized.')
      )
    );
  }

  function render() {
    mount(el, renderGroup(model, 0, null));
    markErrors();
  }

  render();
  const initial = fromModel(model, fieldsMap);
  lastErrors = initial.errors;

  return {
    el,
    getFilter: () => fromModel(model, fieldsMap).filter,
    getErrors: () => fromModel(model, fieldsMap).errors,
    setFilter: (f) => {
      model = toModel(f || {});
      ensureFields(model);
      render();
      emit();
    },
  };
}
