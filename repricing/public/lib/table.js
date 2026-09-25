// Datová tabulka: řazení (serverové i klientské), stránkování, výběr řádků, rozbalovací detail,
// klik na řádek (i klávesou Enter), prázdný/načítací/chybový stav.
import { h, mount, isInteractive } from './dom.js';
import { icon } from './icons.js';
import { money, percent, number, int, index, date, dateTime, relTime, DASH } from './format.js';
import { emptyState, errorState } from './ui.js';

const FORMATS = {
  money: (v) => money(v),
  money0: (v) => money(v, { decimals: 0 }),
  percent: (v) => percent(v),
  int: (v) => int(v),
  num1: (v) => number(v, 1),
  index: (v) => index(v),
  date: (v) => date(v),
  datetime: (v) => dateTime(v),
  rel: (v) => relTime(v),
};

const NUMERIC_FORMATS = new Set(['money', 'money0', 'percent', 'int', 'num1', 'index']);

function getVal(row, key) {
  if (!key) return undefined;
  if (!key.includes('.')) return row[key];
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), row);
}

/** Klientské řazení: null na konec, čísla numericky, texty česky. */
export function sortRows(rows, key, dir = 'asc', valueFn) {
  const mul = dir === 'desc' ? -1 : 1;
  const val = valueFn || ((r) => getVal(r, key));
  const coll = new Intl.Collator('cs', { sensitivity: 'base', numeric: true });
  return [...rows].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    const na = va == null || va === '';
    const nb = vb == null || vb === '';
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul;
    return coll.compare(String(va), String(vb)) * mul;
  });
}

/**
 * @typedef {{key: string, label: string, title?: string, sortKey?: string|false, sortable?: boolean, align?: 'left'|'right'|'center',
 *   width?: string, class?: string, format?: string, render?: (row: object) => any, value?: (row: object) => any, hideSm?: boolean, hideLg?: boolean}} Column
 *   hideSm = skrýt na mobilu (≤ 640 px), hideLg = skrýt pod 1440 px (husté tabulky na notebooku)
 */

export class DataTable {
  /**
   * @param {{columns: Column[], rowKey?: string|Function, onRowClick?: Function, selectable?: boolean, onSelectionChange?: Function,
   *   expandable?: Function, sort?: {key: string, dir: 'asc'|'desc'}, onSort?: Function, clientSort?: boolean,
   *   pagination?: boolean, page?: number, limit?: number, pageSizes?: number[], onPage?: Function, empty?: Function,
   *   caption?: string, rowClass?: Function, dense?: boolean, isSelectable?: Function, stickyFirst?: boolean, mobileCards?: boolean}} opts
   *   mobileCards (výchozí true): na úzkém displeji se řádky zobrazí jako karty (štítky z data-label).
   *   Sloupec s main: true (jinak první) je hlavička karty; sloupec „actions“ je přes celou šířku.
   */
  constructor(opts) {
    this.o = { rowKey: 'id', pageSizes: [25, 50, 100, 200], ...opts };
    this.rows = [];
    this.total = 0;
    this.page = opts.page || 1;
    this.limit = opts.limit || 50;
    this.sort = opts.sort || null;
    this.selected = new Set();
    this.expanded = new Set();
    this.loading = true;
    this.error = null;
    this.thead = h('thead');
    this.tbody = h('tbody');
    this.table = h(
      'table',
      { class: ['table', opts.dense !== false ? 'table-dense' : null, opts.stickyFirst ? 'table-sticky-first' : null, opts.mobileCards !== false ? 'table-cards' : null] },
      opts.caption ? h('caption', { class: 'sr-only' }, opts.caption) : null,
      this.thead,
      this.tbody
    );
    this.scroll = h('div', { class: 'dt-scroll', tabindex: '-1' }, this.table);
    this.pager = h('div', { class: 'dt-pager' });
    this.el = h('div', { class: 'dt' }, this.scroll, opts.pagination ? this.pager : null);
    this.renderHead();
    this.renderBody();
  }

  key(row) {
    const k = this.o.rowKey;
    return typeof k === 'function' ? k(row) : row[k];
  }

  colCount() {
    return this.o.columns.length + (this.o.selectable ? 1 : 0) + (this.o.expandable ? 1 : 0);
  }

  setLoading(on = true) {
    this.loading = on;
    this.el.classList.toggle('is-loading', on && this.rows.length > 0);
    this.el.setAttribute('aria-busy', on ? 'true' : 'false');
    if (on && !this.rows.length) this.renderBody();
  }

  setError(err, retry) {
    this.loading = false;
    this.error = { err, retry };
    this.el.classList.remove('is-loading');
    this.el.setAttribute('aria-busy', 'false');
    this.renderBody();
  }

  /** Nastaví data. meta = {total, page, limit}. */
  setData(rows, meta = {}) {
    this.loading = false;
    this.error = null;
    this.rows = Array.isArray(rows) ? rows : [];
    this.total = meta.total ?? this.rows.length;
    if (meta.page) this.page = meta.page;
    if (meta.limit) this.limit = meta.limit;
    const keys = new Set(this.rows.map((r) => this.key(r)));
    for (const k of [...this.selected]) if (!keys.has(k)) this.selected.delete(k);
    this.el.classList.remove('is-loading');
    this.el.setAttribute('aria-busy', 'false');
    this.renderHead();
    this.renderBody();
    this.renderPager();
  }

  clearSelection() {
    this.selected.clear();
    this.renderBody();
    this.renderHead();
    this.emitSelection();
  }

  emitSelection() {
    if (this.o.onSelectionChange) this.o.onSelectionChange([...this.selected], this.rows.filter((r) => this.selected.has(this.key(r))));
  }

  selectableRows() {
    return this.o.isSelectable ? this.rows.filter(this.o.isSelectable) : this.rows;
  }

  renderHead() {
    const cells = [];
    if (this.o.selectable) {
      const rows = this.selectableRows();
      const all = rows.length > 0 && rows.every((r) => this.selected.has(this.key(r)));
      const some = rows.some((r) => this.selected.has(this.key(r)));
      const cb = h('input', {
        type: 'checkbox',
        'aria-label': 'Vybrat vše na stránce',
        checked: all,
        disabled: rows.length === 0,
        onChange: (e) => {
          for (const r of rows) {
            if (e.target.checked) this.selected.add(this.key(r));
            else this.selected.delete(this.key(r));
          }
          this.renderBody();
          this.emitSelection();
        },
      });
      cb.indeterminate = some && !all;
      this.headCheckbox = cb;
      cells.push(h('th', { class: 'col-check', scope: 'col' }, cb));
    }
    if (this.o.expandable) cells.push(h('th', { class: 'col-expand', scope: 'col' }, h('span', { class: 'sr-only' }, 'Detail')));
    for (const c of this.o.columns) {
      const sortKey = c.sortKey === false ? null : c.sortKey || (c.sortable ? c.key : null);
      const align = c.align || (NUMERIC_FORMATS.has(c.format) ? 'right' : null);
      const active = sortKey && this.sort && this.sort.key === sortKey;
      const ariaSort = active ? (this.sort.dir === 'desc' ? 'descending' : 'ascending') : sortKey ? 'none' : null;
      const content = sortKey
        ? h(
          'button',
          {
            type: 'button',
            class: ['th-sort', active ? 'is-active' : null],
            title: c.title || 'Seřadit podle: ' + c.label,
            onClick: () => this.toggleSort(sortKey, c),
          },
          h('span', null, c.label),
          h('span', { class: 'sort-ind', 'aria-hidden': 'true' }, active ? icon(this.sort.dir === 'desc' ? 'arrow-down' : 'arrow-up', { size: 12 }) : icon('chevron-down', { size: 12, class: 'sort-idle' }))
        )
        : h('span', { title: c.title }, c.label);
      cells.push(
        h('th', { scope: 'col', class: [align ? 'al-' + align : null, c.class, c.hideSm ? 'hide-sm' : null, c.hideLg ? 'hide-lg' : null], 'aria-sort': ariaSort, style: c.width ? { width: c.width } : null }, content)
      );
    }
    mount(this.thead, h('tr', null, cells));
  }

  toggleSort(key, col) {
    let dir = 'asc';
    if (this.sort && this.sort.key === key) dir = this.sort.dir === 'asc' ? 'desc' : 'asc';
    else if (col && (NUMERIC_FORMATS.has(col.format) || col.defaultDesc)) dir = 'desc';
    this.sort = { key, dir };
    if (this.o.clientSort) {
      this.renderHead();
      this.renderBody();
    } else {
      this.renderHead();
      if (this.o.onSort) this.o.onSort(this.sort);
    }
  }

  cell(c, row) {
    let content;
    if (c.render) content = c.render(row, this);
    else {
      const v = getVal(row, c.key);
      content = c.format && FORMATS[c.format] ? FORMATS[c.format](v) : v == null || v === '' ? DASH : String(v);
    }
    const align = c.align || (NUMERIC_FORMATS.has(c.format) ? 'right' : null);
    const main = c.main || (!this.o.columns.some((x) => x.main) && c === this.o.columns[0]);
    const actions = c.key === 'actions';
    return h(
      'td',
      { class: [align ? 'al-' + align : null, c.class, c.hideSm ? 'hide-sm' : null, c.hideLg ? 'hide-lg' : null, NUMERIC_FORMATS.has(c.format) ? 'num' : null, main ? 'col-main' : null, actions ? 'col-actions' : null], dataset: { label: main || actions ? null : c.label } },
      content
    );
  }

  visibleRows() {
    if (this.o.clientSort && this.sort) {
      const col = this.o.columns.find((c) => (c.sortKey || c.key) === this.sort.key);
      return sortRows(this.rows, this.sort.key, this.sort.dir, col && col.value);
    }
    return this.rows;
  }

  renderBody() {
    const n = this.colCount();
    if (this.error) {
      mount(this.tbody, h('tr', { class: 'dt-state' }, h('td', { colspan: n }, errorState(this.error.err, this.error.retry))));
      return;
    }
    if (this.loading && !this.rows.length) {
      const sk = Array.from({ length: 8 }, (_, i) =>
        h('tr', { class: 'sk-tr', 'aria-hidden': 'true' }, Array.from({ length: n }, (_, j) => h('td', null, h('span', { class: 'sk', style: 'width:' + (j === 1 ? 40 + ((i * 13) % 45) : 50 + ((i + j * 5) % 40)) + '%' }))))
      );
      mount(this.tbody, sk);
      return;
    }
    if (!this.rows.length) {
      const empty = this.o.empty ? this.o.empty() : emptyState({ title: 'Žádné záznamy', compact: true });
      mount(this.tbody, h('tr', { class: 'dt-state' }, h('td', { colspan: n }, empty)));
      return;
    }
    const trs = [];
    for (const row of this.visibleRows()) {
      const k = this.key(row);
      const cells = [];
      if (this.o.selectable) {
        const can = this.o.isSelectable ? this.o.isSelectable(row) : true;
        cells.push(
          h(
            'td',
            { class: 'col-check' },
            can
              ? h('input', {
                type: 'checkbox',
                checked: this.selected.has(k),
                'aria-label': 'Vybrat řádek',
                onChange: (e) => {
                  if (e.target.checked) this.selected.add(k);
                  else this.selected.delete(k);
                  e.target.closest('tr').classList.toggle('is-selected', e.target.checked);
                  this.renderHead();
                  this.emitSelection();
                },
              })
              : null
          )
        );
      }
      const isOpen = this.expanded.has(k);
      if (this.o.expandable) {
        cells.push(
          h(
            'td',
            { class: 'col-expand' },
            h(
              'button',
              {
                type: 'button',
                class: ['btn-icon', 'expander', isOpen ? 'is-open' : null],
                'aria-expanded': isOpen ? 'true' : 'false',
                'aria-label': isOpen ? 'Skrýt detail' : 'Zobrazit detail',
                onClick: () => {
                  if (this.expanded.has(k)) this.expanded.delete(k);
                  else this.expanded.add(k);
                  this.renderBody();
                },
              },
              icon('chevron-right', { size: 14 })
            )
          )
        );
      }
      for (const c of this.o.columns) cells.push(this.cell(c, row));
      const clickable = Boolean(this.o.onRowClick);
      const tr = h(
        'tr',
        {
          class: [clickable ? 'is-clickable' : null, this.selected.has(k) ? 'is-selected' : null, this.o.rowClass ? this.o.rowClass(row) : null],
          tabindex: clickable ? '0' : null,
          dataset: { key: k },
        },
        cells
      );
      if (clickable) {
        tr.addEventListener('click', (e) => {
          if (isInteractive(e.target, tr)) return;
          this.o.onRowClick(row, e);
        });
        tr.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && e.target === tr) this.o.onRowClick(row, e);
        });
      }
      trs.push(tr);
      if (this.o.expandable && isOpen) {
        trs.push(h('tr', { class: 'dt-expand' }, h('td', { colspan: n }, this.o.expandable(row))));
      }
    }
    mount(this.tbody, trs);
  }

  renderPager() {
    if (!this.o.pagination) return;
    const pages = Math.max(1, Math.ceil(this.total / this.limit));
    const from = this.total ? (this.page - 1) * this.limit + 1 : 0;
    const to = Math.min(this.total, this.page * this.limit);
    const go = (p) => {
      if (p < 1 || p > pages || p === this.page) return;
      this.page = p;
      if (this.o.onPage) this.o.onPage(this.page, this.limit);
    };
    const sizeSel = h(
      'select',
      {
        class: 'select select-sm',
        'aria-label': 'Počet řádků na stránku',
        onChange: (e) => {
          this.limit = Number(e.target.value);
          this.page = 1;
          if (this.o.onPage) this.o.onPage(this.page, this.limit);
        },
      },
      this.o.pageSizes.map((s) => h('option', { value: String(s) }, String(s)))
    );
    sizeSel.value = String(this.limit);
    mount(
      this.pager,
      h('div', { class: 'pager-info' }, this.total ? `${int(from)}–${int(to)} z ${int(this.total)}` : '0 záznamů'),
      h('label', { class: 'pager-size' }, h('span', { class: 'hide-sm' }, 'Na stránku'), sizeSel),
      h(
        'div',
        { class: 'pager-nav' },
        h('button', { type: 'button', class: 'btn btn-sm', disabled: this.page <= 1, onClick: () => go(1), 'aria-label': 'První stránka' }, icon('chevron-left', { size: 14 }), icon('chevron-left', { size: 14, class: 'icon-overlap' })),
        h('button', { type: 'button', class: 'btn btn-sm', disabled: this.page <= 1, onClick: () => go(this.page - 1), 'aria-label': 'Předchozí stránka' }, icon('chevron-left', { size: 14 })),
        h('span', { class: 'pager-page' }, `${int(this.page)} / ${int(pages)}`),
        h('button', { type: 'button', class: 'btn btn-sm', disabled: this.page >= pages, onClick: () => go(this.page + 1), 'aria-label': 'Další stránka' }, icon('chevron-right', { size: 14 })),
        h('button', { type: 'button', class: 'btn btn-sm', disabled: this.page >= pages, onClick: () => go(pages), 'aria-label': 'Poslední stránka' }, icon('chevron-right', { size: 14 }), icon('chevron-right', { size: 14, class: 'icon-overlap' }))
      )
    );
  }
}

/** Jednoduchá klientská tabulka (bez stránkování) – vrací element. */
export function simpleTable(columns, rows, opts = {}) {
  const t = new DataTable({ columns, clientSort: true, sort: opts.sort, rowKey: opts.rowKey || 'id', onRowClick: opts.onRowClick, empty: opts.empty, rowClass: opts.rowClass, expandable: opts.expandable, caption: opts.caption, stickyFirst: opts.stickyFirst });
  t.setData(rows);
  return t.el;
}

