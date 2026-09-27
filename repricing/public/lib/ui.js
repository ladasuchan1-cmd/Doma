// Drobné UI stavební prvky: odznaky, karty, pole formulářů, přepínače, prázdné a chybové stavy, skeletony.
import { h, uid, copyText, mount } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import {
  changeInfo, positionLabel, POSITION_LABELS, flagLabel, FLAG_HELP, FLAG_SEVERITY, statusLabel, STATUS_VARIANT,
  JOB_STATUS_LABELS, JOB_STATUS_VARIANT,
} from './format.js';
import { isAbort } from './api.js';

export { icon };

/** Tlačítko. */
export function button(label, opts = {}) {
  const cls = ['btn'];
  if (opts.variant) cls.push('btn-' + opts.variant);
  if (opts.size) cls.push('btn-' + opts.size);
  if (!label && opts.icon) cls.push('btn-icon-only');
  return h(
    'button',
    {
      type: opts.type || 'button',
      class: [cls, opts.class],
      onClick: opts.onClick,
      disabled: opts.disabled,
      title: opts.title,
      'aria-label': opts.ariaLabel || (!label ? opts.title : null),
      dataset: opts.dataset,
    },
    opts.icon ? icon(opts.icon, { size: opts.iconSize || 16 }) : null,
    label ? h('span', { class: 'lbl' }, label) : null
  );
}

/** Odkaz vypadající jako tlačítko. */
export function linkButton(label, href, opts = {}) {
  const cls = ['btn'];
  if (opts.variant) cls.push('btn-' + opts.variant);
  if (opts.size) cls.push('btn-' + opts.size);
  return h(
    'a',
    { class: [cls, opts.class], href, download: opts.download, target: opts.target, rel: opts.target ? 'noopener noreferrer' : null, title: opts.title },
    opts.icon ? icon(opts.icon, { size: 16 }) : null,
    label ? h('span', { class: 'lbl' }, label) : null
  );
}

/** Odznak. variant: neutral | info | success | warning | danger | primary */
export function badge(text, variant = 'neutral', title) {
  return h('span', { class: ['badge', 'badge-' + variant], title }, text);
}

export function positionBadge(pos) {
  if (!pos) return h('span', { class: 'muted' }, '–');
  return h('span', { class: ['pos', 'pos-' + pos], title: POSITION_LABELS[pos] || pos }, h('span', { class: 'pos-dot', 'aria-hidden': 'true' }), positionLabel(pos));
}

export function statusBadge(status) {
  return badge(statusLabel(status), STATUS_VARIANT[status] || 'neutral');
}

export function jobStatusBadge(status) {
  return badge(JOB_STATUS_LABELS[status] || status || '–', JOB_STATUS_VARIANT[status] || 'neutral');
}

export function flagBadges(flags) {
  const list = Array.isArray(flags) ? flags : [];
  if (!list.length) return h('span', { class: 'muted' }, '–');
  return h(
    'span',
    { class: 'flags' },
    list.map((f) => badge(flagLabel(f), FLAG_SEVERITY[f] || 'neutral', FLAG_HELP[f]))
  );
}

/** Změna se šipkou a barvou. */
export function changeEl(v, opts = {}) {
  const c = changeInfo(v, opts);
  return h('span', { class: ['chg', c.cls] }, c.text);
}

/** Karta s hlavičkou. */
export function card(o = {}) {
  const titleId = o.title ? uid('card') : null;
  return h(
    'section',
    { class: ['card', o.class, o.flush ? 'card-flush' : null], 'aria-labelledby': titleId, dataset: o.dataset },
    o.title || o.actions
      ? h(
        'header',
        { class: 'card-head' },
        h('div', { class: 'card-titles' }, o.title ? h('h2', { class: 'card-title', id: titleId }, o.icon ? icon(o.icon, { size: 16 }) : null, o.title) : null, o.subtitle ? h('p', { class: 'card-sub' }, o.subtitle) : null),
        o.actions ? h('div', { class: 'card-actions' }, o.actions) : null
      )
      : null,
    h('div', { class: 'card-body' }, o.body)
  );
}

/**
 * Pole formuláře s popiskem a nápovědou. control je input/select/…; dostane id pro label.
 * @param {{label: string, control: HTMLElement, input?: HTMLElement, help?: string|Node, required?: boolean, error?: string, class?: string, inline?: boolean}} o
 *   input = prvek, na který míří <label for> (když control je obal, např. vstup s jednotkou)
 */
export function field(o) {
  const target = o.input || o.control;
  const id = target.id || uid('f');
  target.id = id;
  const helpId = o.help ? id + '-help' : null;
  if (helpId) {
    const prev = target.getAttribute('aria-describedby');
    target.setAttribute('aria-describedby', prev ? prev + ' ' + helpId : helpId);
  }
  return h(
    'div',
    { class: ['field', o.inline ? 'field-inline' : null, o.class] },
    h('label', { for: id, class: 'field-label' }, o.label, o.required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null),
    o.control,
    o.help ? h('div', { class: 'field-help', id: helpId }, o.help) : null,
    o.error ? h('div', { class: 'field-error' }, o.error) : null
  );
}

/** Vstup s českou čárkou (text + inputmode=decimal). */
export function numberInput(value, opts = {}) {
  return h('input', {
    type: 'text',
    inputmode: 'decimal',
    class: ['input', 'input-num', opts.class],
    value: value == null ? '' : String(value).replace('.', ','),
    placeholder: opts.placeholder,
    'aria-label': opts.ariaLabel,
    id: opts.id,
    onInput: opts.onInput,
    onChange: opts.onChange,
    autocomplete: 'off',
    size: opts.size || 8,
  });
}

/** Vstup s jednotkou vpravo („%“, „Kč“, „dní“). */
export function withSuffix(input, suffix) {
  if (!suffix) return input;
  return h('div', { class: 'input-group' }, input, h('span', { class: 'input-suffix', 'aria-hidden': 'true' }, suffix));
}

/** Select z pole voleb [{value, label}] nebo skupin [{group, options}]. */
export function select(options, value, opts = {}) {
  const el = h('select', { class: ['select', opts.class], id: opts.id, 'aria-label': opts.ariaLabel, onChange: opts.onChange, disabled: opts.disabled });
  const add = (parent, o) => {
    const opt = h('option', { value: String(o.value ?? '') }, o.label ?? String(o.value));
    if (o.disabled) opt.disabled = true;
    parent.appendChild(opt);
  };
  if (opts.placeholder != null) add(el, { value: '', label: opts.placeholder });
  for (const o of options) {
    if (o && o.group) {
      const g = h('optgroup', { label: o.group });
      for (const x of o.options) add(g, x);
      el.appendChild(g);
    } else add(el, o);
  }
  el.value = value == null ? '' : String(value);
  return el;
}

/** Přepínač (role=switch). */
export function switchEl(o = {}) {
  const btn = h(
    'button',
    {
      type: 'button',
      role: 'switch',
      class: 'switch',
      'aria-checked': o.checked ? 'true' : 'false',
      'aria-label': o.ariaLabel || o.label,
      id: o.id,
      disabled: o.disabled,
      title: o.title,
    },
    h('span', { class: 'switch-knob', 'aria-hidden': 'true' })
  );
  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', next ? 'true' : 'false');
    if (o.onChange) o.onChange(next, btn);
  });
  btn.setChecked = (v) => btn.setAttribute('aria-checked', v ? 'true' : 'false');
  btn.isChecked = () => btn.getAttribute('aria-checked') === 'true';
  if (!o.label || o.labelHidden) return btn;
  return h('label', { class: 'switch-row' }, btn, h('span', null, o.label));
}

/** Zaškrtávací pole s popiskem. */
export function checkbox(label, checked, onChange, opts = {}) {
  const input = h('input', { type: 'checkbox', checked: Boolean(checked), id: opts.id, onChange: (e) => onChange && onChange(e.target.checked, e) });
  return h('label', { class: ['check', opts.class] }, input, h('span', null, label), opts.help ? h('span', { class: 'check-help' }, opts.help) : null);
}

/** Segmentový přepínač (radio skupina). */
export function segmented(options, value, onChange, opts = {}) {
  const el = h('div', { class: ['segmented', opts.class], role: 'radiogroup', 'aria-label': opts.label });
  const buttons = options.map((o) => {
    const b = h(
      'button',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': String(o.value) === String(value) ? 'true' : 'false',
        tabindex: String(o.value) === String(value) ? '0' : '-1',
        dataset: { value: o.value },
        onClick: () => select(o.value, true),
      },
      o.label,
      o.count != null ? h('span', { class: 'seg-count' }, String(o.count)) : null
    );
    return b;
  });
  function select(v, fire) {
    buttons.forEach((b) => {
      const on = b.dataset.value === String(v);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    if (fire && onChange) onChange(v);
  }
  el.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    let j = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % buttons.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + buttons.length) % buttons.length;
    if (j != null) {
      e.preventDefault();
      buttons[j].focus();
      buttons[j].click();
    }
  });
  buttons.forEach((b) => el.appendChild(b));
  el.setValue = (v) => select(v, false);
  return el;
}

/** Prázdný stav s vysvětlením a akcí. */
export function emptyState(o = {}) {
  return h(
    'div',
    { class: ['empty', o.compact ? 'empty-compact' : null] },
    h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, icon(o.icon || 'inbox', { size: o.compact ? 20 : 28 })),
    h('div', { class: 'empty-title' }, o.title || 'Nic tu není'),
    o.text ? h('p', { class: 'empty-text' }, o.text) : null,
    o.actions ? h('div', { class: 'empty-actions' }, o.actions) : null
  );
}

/** Chybový stav s tlačítkem „Zkusit znovu“. */
export function errorState(err, retry) {
  const msg = err?.message || String(err || 'Neznámá chyba');
  return h(
    'div',
    { class: 'empty empty-error', role: 'alert' },
    h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, icon('alert-circle', { size: 28 })),
    h('div', { class: 'empty-title' }, 'Data se nepodařilo načíst'),
    h('p', { class: 'empty-text' }, msg),
    retry ? h('div', { class: 'empty-actions' }, button('Zkusit znovu', { icon: 'refresh', onClick: retry })) : null
  );
}

/** Skeleton – řádky tabulky. */
export function skeletonTable(rows = 8, cols = 6) {
  return h(
    'div',
    { class: 'skeleton-table', 'aria-hidden': 'true' },
    Array.from({ length: rows }, (_, r) =>
      h('div', { class: 'sk-row' }, Array.from({ length: cols }, (_, c) => h('span', { class: 'sk', style: 'width:' + (c === 1 ? 30 + ((r * 17) % 40) : 8 + ((r + c * 7) % 10)) + '%' })))
    )
  );
}

/** Skeleton – dlaždice / bloky. */
export function skeletonBlocks(n = 4, height = 88) {
  return h('div', { class: 'sk-grid', 'aria-hidden': 'true' }, Array.from({ length: n }, () => h('div', { class: 'sk sk-block', style: 'height:' + height + 'px' })));
}

/** Stránka načítání: skeleton, pak render(data), nebo chyba s opakováním. */
export async function loadInto(container, loader, render, opts = {}) {
  mount(container, opts.skeleton || skeletonTable());
  container.setAttribute('aria-busy', 'true');
  try {
    const data = await loader();
    container.removeAttribute('aria-busy');
    mount(container, render(data));
    return data;
  } catch (e) {
    if (isAbort(e)) return null;
    container.removeAttribute('aria-busy');
    mount(container, errorState(e, () => loadInto(container, loader, render, opts)));
    return null;
  }
}

/** KPI dlaždice. */
const KPI_UNIT = /^(.*\d)([\u00a0 ](?:(?:tis\.|mil\.|mld\.)[\u00a0 ])?(?:Kč|%|ks))$/;

/** Hodnota dlaždice: číslo velké, jednotka („Kč“, „mil. Kč“, „%“, „ks“) menší – dlouhé částky se tak vejdou. */
export function kpiValue(v) {
  if (typeof v !== 'string') return v;
  const m = KPI_UNIT.exec(v);
  return m ? [m[1], h('span', { class: 'kpi-unit' }, m[2])] : v;
}

export function kpi(o) {
  const tag = o.href ? 'a' : 'div';
  return h(
    tag,
    { class: ['kpi', o.tone ? 'kpi-' + o.tone : null, o.href ? 'kpi-link' : null], href: o.href },
    h('div', { class: 'kpi-label' }, o.icon ? icon(o.icon, { size: 14 }) : null, o.label),
    h('div', { class: 'kpi-value', title: o.title || (typeof o.value === 'string' ? o.value : null) }, kpiValue(o.value)),
    o.sub ? h('div', { class: 'kpi-sub' }, o.sub) : null,
    o.extra || null
  );
}

/** Blok kódu s tlačítkem Kopírovat. */
export function codeBlock(code, opts = {}) {
  const pre = h('pre', { class: 'code' }, h('code', null, code));
  return h(
    'div',
    { class: 'code-wrap' },
    opts.title ? h('div', { class: 'code-title' }, opts.title) : null,
    pre,
    h('button', { type: 'button', class: 'btn btn-sm code-copy', onClick: async () => toast((await copyText(code)) ? 'Zkopírováno do schránky' : 'Kopírování se nezdařilo', { type: 'success', timeout: 1800 }) }, icon('copy', { size: 14 }), h('span', null, 'Kopírovat'))
  );
}

/** Pole jen pro čtení s tlačítkem kopírovat (URL feedu, token). */
export function copyField(value, opts = {}) {
  const input = h('input', { class: ['input', 'input-mono'], readonly: true, value, 'aria-label': opts.ariaLabel || 'Hodnota ke zkopírování', onFocus: (e) => e.target.select() });
  return h(
    'div',
    { class: 'copy-field' },
    input,
    h('button', { type: 'button', class: 'btn', onClick: async () => toast((await copyText(input.value)) ? 'Zkopírováno' : 'Kopírování se nezdařilo', { type: 'success', timeout: 1500 }) }, icon('copy', { size: 14 }), h('span', null, opts.label || 'Kopírovat'))
  );
}

/** Seznam definic (štítek – hodnota). */
export function dl(pairs, opts = {}) {
  return h(
    'dl',
    { class: ['dl', opts.class] },
    pairs.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v == null || v === '' ? '–' : v)])
  );
}

/** Upozornění / callout. */
export function callout(text, variant = 'info', opts = {}) {
  const ic = variant === 'danger' ? 'alert-circle' : variant === 'warning' ? 'alert' : variant === 'success' ? 'check' : 'info';
  return h('div', { class: ['callout', 'callout-' + variant, opts.class], role: variant === 'danger' ? 'alert' : null }, icon(ic, { size: 16 }), h('div', { class: 'callout-body' }, text));
}

/** Externí odkaz (jen http/https, noopener). */
export function extLink(url, text, opts = {}) {
  if (!url) return h('span', { class: 'muted' }, '–');
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow', class: ['ext-link', opts.class], title: url }, text || url, icon('external', { size: 12 }));
}

/** Nadpis sekce uvnitř stránky. */
export function sectionHead(title, actions, sub) {
  return h('div', { class: 'section-head' }, h('div', null, h('h2', { class: 'section-title' }, title), sub ? h('p', { class: 'section-sub' }, sub) : null), actions ? h('div', { class: 'section-actions' }, actions) : null);
}

/** Pomocník pro vyhledávací pole s ikonou. */
export function searchInput(value, onInput, opts = {}) {
  const input = h('input', {
    type: 'search',
    class: 'input',
    value: value || '',
    placeholder: opts.placeholder || 'Hledat…',
    'aria-label': opts.ariaLabel || opts.placeholder || 'Hledat',
    onInput: (e) => onInput(e.target.value),
    autocomplete: 'off',
    id: opts.id,
  });
  return h('div', { class: ['search', opts.class] }, icon('search', { size: 16 }), input);
}

/** Barevná tečka (segmenty). */
export function colorDot(color) {
  return h('span', { class: 'dot', style: { background: color || 'var(--muted)' }, 'aria-hidden': 'true' });
}
