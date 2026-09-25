// Návrhy cen – filtry, tabulka staré → nové ceny, hromadné schválení/zamítnutí, schválení vše dle filtru,
// ruční úprava ceny v řádku, rozbalitelné vysvětlení, stažení XLSX.
import { h, mount, debounce } from '../lib/dom.js';
import { api, apiUrl, cachedGet, itemsOf, isAbort } from '../lib/api.js';
import { icon } from '../lib/icons.js';
import { DataTable } from '../lib/table.js';
import { emptyState, flagBadges, statusBadge, changeEl, segmented, searchInput, badge, callout, dl } from '../lib/ui.js';
import { explainList, priceMove } from '../lib/decision.js';
import { confirmDialog } from '../lib/modal.js';
import { toast } from '../lib/toast.js';
import {
  money, percent, int, count, FLAG_LABELS, parseInputNumber, round, relTime, dateTime, toNum,
} from '../lib/format.js';

export const title = 'Návrhy cen';

const STATUSES = [
  { value: 'pending', label: 'Čeká' },
  { value: 'approved', label: 'Schváleno' },
  { value: 'exported', label: 'Exportováno' },
  { value: 'rejected', label: 'Zamítnuto' },
  { value: 'superseded', label: 'Nahrazeno' },
  { value: 'all', label: 'Vše' },
];

/** Marže při ruční ceně – DPH se odvodí z marže navržené ceny (API ji v řádku neposílá). */
function manualMargin(r, price) {
  const purchase = toNum(r.product?.purchase_price ?? r.purchase_price);
  const m = toNum(r.margin_after);
  const np = toNum(r.new_price);
  if (purchase == null || m == null || np == null || m >= 100) return null;
  const netNew = purchase / (1 - m / 100);
  const vatFactor = np / netNew;
  if (!(vatFactor > 0.9 && vatFactor < 1.5)) return null;
  const net = price / vatFactor;
  return round(((net - purchase) / net) * 100, 2);
}

function prod(r) {
  return r.product || { code: r.code, name: r.name, manufacturer: r.manufacturer };
}

export async function show(root, ctx) {
  const q = ctx.query;
  const st = {
    status: q.status || 'pending',
    q: q.q || '',
    strategy: q.strategy || '',
    segment: q.segment || '',
    direction: q.direction || '',
    flag: q.flag || '',
    manufacturer: q.manufacturer || '',
    run: q.run || '',
    sort: q.sort || '',
    dir: q.dir || '',
    page: Math.max(1, Number(q.page) || 1),
    limit: Number(q.limit) || 50,
  };
  ctx.setTitle('Návrhy cen', '');
  let summary = null;
  let total = 0;
  let rows = [];
  let editing = null;

  const [strRes, segRes, facRes] = await Promise.allSettled([cachedGet('/strategies'), cachedGet('/segments'), cachedGet('/products/facets')]);
  if (ctx.signal.aborted) return;
  const strategies = strRes.status === 'fulfilled' ? itemsOf(strRes.value) : [];
  const segments = segRes.status === 'fulfilled' ? itemsOf(segRes.value) : [];
  const manufacturers = facRes.status === 'fulfilled' ? facRes.value?.manufacturers || [] : [];

  function filterParams() {
    return {
      status: st.status,
      q: st.q || null,
      strategy: st.strategy || null,
      segment: st.segment || null,
      direction: st.direction || null,
      flag: st.flag || null,
      manufacturer: st.manufacturer || null,
      run: st.run || null,
    };
  }
  function queryParams() {
    return { ...filterParams(), sort: st.sort || null, dir: st.dir || null, page: st.page, limit: st.limit };
  }

  const xlsxLink = h('a', { class: 'btn btn-ghost', download: '', dataset: { action: 'xlsx' } }, icon('download', { size: 16 }), h('span', { class: 'lbl' }, 'XLSX'));
  const approveAllBtn = h('button', { type: 'button', class: 'btn btn-success', dataset: { action: 'approve-all' }, onClick: () => decideAll('approve') }, icon('check', { size: 16 }), h('span', { class: 'lbl' }, 'Schválit vše dle filtru'));
  const rejectAllBtn = h('button', { type: 'button', class: 'btn btn-ghost', dataset: { action: 'reject-all' }, onClick: () => decideAll('reject') }, icon('x', { size: 16 }), h('span', { class: 'lbl' }, 'Zamítnout vše'));
  ctx.setActions(xlsxLink, rejectAllBtn, approveAllBtn);

  function updateActions() {
    xlsxLink.href = apiUrl('/export/proposals.xlsx', filterParams());
    xlsxLink.title = 'Stáhnout návrhy podle aktuálních filtrů jako XLSX';
    const canAll = (st.status === 'pending' || st.status === 'all') && total > 0;
    approveAllBtn.disabled = !canAll;
    rejectAllBtn.disabled = !canAll;
    approveAllBtn.title = canAll ? 'Schválit všechny čekající návrhy odpovídající filtru' : 'Hromadně lze schvalovat jen čekající návrhy';
  }

  // --------------------------------------------------------------- akce
  async function decide(kind, ids) {
    if (!ids.length) return;
    try {
      const res = await api.post('/proposals/' + kind, { ids });
      const n = res?.updated ?? ids.length;
      toast((kind === 'approve' ? 'Schváleno: ' : 'Zamítnuto: ') + count(n, 'návrh', 'návrhy', 'návrhů'), { type: 'success' });
      table.clearSelection();
      ctx.notifyChanged('proposals');
    } catch {
      /* toast */
    }
    load();
  }

  async function decideAll(kind) {
    const n = st.status === 'pending' ? total : summary?.pending ?? total;
    const ok = await confirmDialog({
      title: kind === 'approve' ? 'Schválit vše dle filtru' : 'Zamítnout vše dle filtru',
      message: h(
        'div',
        null,
        h('p', null, (kind === 'approve' ? 'Schválit ' : 'Zamítnout ') + (st.status === 'pending' ? 'všech ' + count(n, 'čekající návrh', 'čekající návrhy', 'čekajících návrhů') : 'všechny čekající návrhy') + ' odpovídající aktuálnímu filtru?'),
        kind === 'approve' ? h('p', { class: 'muted small' }, 'Schválené ceny se objeví v exportu (feed, webhook, POHODA XML).') : null
      ),
      confirmLabel: kind === 'approve' ? 'Schválit ' + (st.status === 'pending' ? int(n) : 'vše') : 'Zamítnout',
      danger: kind === 'reject',
    });
    if (!ok) return;
    const filter = filterParams();
    delete filter.status;
    for (const k of Object.keys(filter)) if (filter[k] == null) delete filter[k];
    try {
      const res = await api.post('/proposals/' + kind, { all: true, filter });
      toast((kind === 'approve' ? 'Schváleno: ' : 'Zamítnuto: ') + count(res?.updated ?? 0, 'návrh', 'návrhy', 'návrhů'), { type: 'success' });
      ctx.notifyChanged('proposals');
    } catch {
      /* toast */
    }
    load();
  }

  async function saveManual(r, value) {
    const v = value === '' ? null : parseInputNumber(value);
    if (v != null && (Number.isNaN(v) || v <= 0)) {
      toast('Zadejte kladnou cenu, nebo pole vymažte pro zrušení ruční ceny.', { type: 'error' });
      return false;
    }
    try {
      const upd = await api.patch('/proposals/' + encodeURIComponent(r.id), { manual_price: v });
      Object.assign(r, upd && typeof upd === 'object' ? upd : { manual_price: v });
      if (upd && !upd.product && r.product == null) r.product = prod(r);
      toast(v == null ? 'Ruční cena zrušena' : 'Ruční cena uložena: ' + money(v), { type: 'success' });
      return true;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------- tabulka
  function priceCell(r) {
    const eff = r.manual_price ?? r.new_price;
    const editable = r.status === 'pending' || r.status === 'approved';
    if (editing === r.id) {
      const inp = h('input', { type: 'text', inputmode: 'decimal', class: 'input input-num', value: String(eff ?? '').replace('.', ','), 'aria-label': 'Ruční cena pro ' + (prod(r).code || '') });
      const done = async (save) => {
        if (save) {
          const ok = await saveManual(r, inp.value.trim());
          if (!ok) return;
        }
        editing = null;
        table.setData(rows, { total, page: st.page, limit: st.limit });
        table.el.querySelector(`tr[data-key="${r.id}"] .price-edit`)?.focus();
      };
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          done(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          done(false);
        }
      });
      setTimeout(() => {
        inp.focus();
        inp.select();
      }, 0);
      return h(
        'span',
        { class: 'inline-edit' },
        inp,
        h('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Uložit ruční cenu', onClick: () => done(true) }, icon('check', { size: 15 })),
        h('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Zrušit úpravu', onClick: () => done(false) }, icon('x', { size: 15 }))
      );
    }
    const content = [h('span', null, money(eff))];
    if (r.manual_price != null) content.push(badge('ručně', 'info', 'Navrženo ' + money(r.new_price)));
    if (!editable) return h('span', { class: 'num strong' }, content);
    return h(
      'button',
      {
        type: 'button',
        class: 'price-edit',
        title: 'Upravit cenu ručně (Enter uloží, Esc zruší; prázdné pole ruční cenu zruší)',
        onClick: () => {
          editing = r.id;
          table.setData(rows, { total, page: st.page, limit: st.limit });
        },
      },
      content,
      icon('edit', { size: 13 })
    );
  }

  const columns = [
    {
      key: 'product',
      label: 'Produkt',
      sortKey: 'code',
      render: (r) => {
        const p = prod(r);
        return h('div', { class: 'cell-2' }, h('a', { href: '#/produkty/' + encodeURIComponent(r.product_id), class: 'cell-name', style: 'max-width:220px', title: p.name }, p.name || p.code || '#' + r.product_id), h('span', { class: 'cell-sub ellipsis', style: 'max-width:220px' }, h('span', { class: 'mono' }, p.code || ''), p.manufacturer ? ' · ' + p.manufacturer : ''));
      },
    },
    { key: 'strategy_name', label: 'Strategie', hideSm: true, hideLg: true, render: (r) => h('div', { class: 'cell-2' }, h('span', { class: 'ellipsis', style: 'max-width:190px' }, r.strategy_name || '–'), r.segment_name ? h('span', { class: 'cell-sub ellipsis', style: 'max-width:190px' }, r.segment_name) : null) },
    { key: 'old_price', label: 'Stará cena', format: 'money', sortable: true },
    { key: 'new_price', label: 'Nová cena', align: 'right', sortKey: 'new_price', render: priceCell },
    {
      key: 'change_pct',
      label: 'Změna',
      align: 'right',
      sortable: true,
      defaultDesc: true,
      render: (r) => {
        if (r.manual_price != null && r.old_price) return h('div', { class: 'cell-2', style: 'align-items:flex-end' }, changeEl(((r.manual_price - r.old_price) / r.old_price) * 100), h('span', { class: 'cell-sub num' }, money(r.manual_price - r.old_price)));
        return h('div', { class: 'cell-2', style: 'align-items:flex-end' }, changeEl(r.change_pct), r.change_abs != null ? h('span', { class: 'cell-sub num' }, money(r.change_abs)) : null);
      },
    },
    {
      key: 'margin_after',
      label: 'Marže',
      title: 'Marže po změně (pod ní marže před změnou)',
      align: 'right',
      sortable: true,
      render: (r) => {
        const after = r.manual_price != null ? manualMargin(r, r.manual_price) : r.margin_after;
        return h('div', { class: 'cell-2', style: 'align-items:flex-end' }, h('span', { class: after != null && after < 0 ? 'chg chg-down' : 'num strong' }, percent(after)), h('span', { class: 'cell-sub num' }, 'z ' + percent(r.margin_before)));
      },
    },
    { key: 'market_min', label: 'Min. trh', align: 'right', hideSm: true, render: (r) => h('div', { class: 'cell-2', style: 'align-items:flex-end' }, h('span', { class: 'num' }, money(r.market_min)), r.competitor_count != null ? h('span', { class: 'cell-sub' }, count(r.competitor_count, 'konkurent', 'konkurenti', 'konkurentů')) : null) },
    { key: 'rank', label: 'Pořadí', align: 'center', hideSm: true, hideLg: true, title: 'Pořadí mezi konkurenty před → po (1 = nejlevnější)', render: (r) => h('span', { class: 'num' }, (r.rank_before ?? '–') + ' → ' + (r.rank_after ?? '–')) },
    { key: 'flags', label: 'Příznaky', render: (r) => flagBadges(r.flags) },
    { key: 'status', label: 'Stav', class: 'col-status', render: (r) => statusBadge(r.status) },
    {
      key: 'actions',
      label: 'Akce',
      align: 'right',
      render: (r) =>
        r.status === 'pending'
          ? h(
            'span',
            { class: 'row-actions' },
            h('button', { type: 'button', class: 'btn-icon approve', 'aria-label': 'Schválit návrh ' + (prod(r).code || ''), title: 'Schválit', dataset: { action: 'approve-row' }, onClick: () => decide('approve', [r.id]) }, icon('check', { size: 16 })),
            h('button', { type: 'button', class: 'btn-icon reject', 'aria-label': 'Zamítnout návrh ' + (prod(r).code || ''), title: 'Zamítnout', dataset: { action: 'reject-row' }, onClick: () => decide('reject', [r.id]) }, icon('x', { size: 16 }))
          )
          : r.decided_at
            ? h('span', { class: 'muted small nowrap', title: dateTime(r.decided_at) + (r.decided_by ? ' · ' + r.decided_by : '') }, relTime(r.decided_at))
            : '',
    },
  ];

  const bulkCount = h('span', { class: 'strong' });
  const bulkbar = h(
    'div',
    { class: 'bulkbar', hidden: true, role: 'region', 'aria-label': 'Hromadné akce' },
    bulkCount,
    h('button', { type: 'button', class: 'btn btn-sm btn-success', dataset: { action: 'approve-selected' }, onClick: () => decide('approve', [...table.selected]) }, icon('check', { size: 14 }), h('span', null, 'Schválit vybrané')),
    h('button', { type: 'button', class: 'btn btn-sm btn-danger', dataset: { action: 'reject-selected' }, onClick: () => decide('reject', [...table.selected]) }, icon('x', { size: 14 }), h('span', null, 'Zamítnout vybrané')),
    h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: () => table.clearSelection() }, 'Zrušit výběr')
  );

  const table = new DataTable({
    columns,
    rowKey: 'id',
    selectable: true,
    isSelectable: (r) => r.status === 'pending',
    expandable: (r) =>
      h(
        'div',
        { class: 'grid-main-side' },
        h('div', null, h('div', { class: 'form-subtitle' }, 'Proč tato cena'), explainList(r.explain)),
        h(
          'div',
          null,
          h('div', { class: 'form-subtitle' }, 'Detail'),
          dl([
            ['Cena', priceMove(r.old_price, r.manual_price ?? r.new_price)],
            ['Cílová cena', money(r.target_price)],
            ['Reference', money(r.reference_price)],
            ['Nákup bez DPH', money(prod(r).purchase_price ?? r.purchase_price)],
            ['Sklad', int(prod(r).stock)],
            ['Vytvořeno', dateTime(r.created_at)],
          ]),
          h('div', { class: 'row', style: 'margin-top:10px' }, h('a', { class: 'btn btn-sm', href: '#/produkty/' + encodeURIComponent(r.product_id) }, 'Detail produktu'))
        )
      ),
    onSelectionChange: (keys) => {
      bulkbar.hidden = !keys.length;
      bulkCount.textContent = 'Vybráno: ' + count(keys.length, 'návrh', 'návrhy', 'návrhů');
    },
    pagination: true,
    page: st.page,
    limit: st.limit,
    sort: st.sort ? { key: st.sort, dir: st.dir || 'asc' } : null,
    onSort: (s) => {
      st.sort = s.key;
      st.dir = s.dir;
      st.page = 1;
      load();
    },
    onPage: (p, l) => {
      st.page = p;
      st.limit = l;
      load();
    },
    caption: 'Návrhy cen',
    empty: () => {
      if (st.status === 'pending' && !st.q && !st.strategy && !st.segment && !st.direction && !st.flag && !st.manufacturer) {
        return emptyState({
          icon: 'check',
          title: 'Žádné čekající návrhy',
          text: 'Všechno je vyřízeno. Nové návrhy vzniknou po přecenění – spusťte ho tlačítkem nahoře nebo nastavte automatické přecenění.',
          actions: [h('button', { type: 'button', class: 'btn btn-primary', onClick: () => ctx.runPricing() }, icon('play', { size: 14 }), h('span', null, 'Spustit přecenění')), h('a', { class: 'btn', href: '#/export' }, 'Export schválených')],
        });
      }
      return emptyState({ icon: 'filter', title: 'Žádné návrhy neodpovídají filtru', text: 'Zkuste jiný stav nebo filtr.', compact: true });
    },
  });

  // --------------------------------------------------------------- filtry
  const statusCtl = segmented(STATUSES, st.status, (v) => {
    st.status = v;
    st.page = 1;
    table.clearSelection();
    load();
  }, { label: 'Stav návrhu' });
  const onSearch = debounce(() => {
    st.page = 1;
    load();
  }, 280);
  const sel = (key, label, options) => {
    const s = h('select', {
      class: 'select', 'aria-label': label,
      onChange: (e) => {
        st[key] = e.target.value;
        st.page = 1;
        load();
      },
    }, h('option', { value: '' }, label + ': vše'), options.map((o) => h('option', { value: String(o.value) }, o.label)));
    s.value = st[key];
    return s;
  };
  const filtersToggle = h('button', {
    type: 'button', class: 'btn filters-toggle', 'aria-expanded': 'false',
    onClick: () => { toolbar.classList.toggle('is-open'); filtersToggle.setAttribute('aria-expanded', toolbar.classList.contains('is-open') ? 'true' : 'false'); },
  }, icon('filter', { size: 16 }), h('span', null, 'Filtry'));
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    searchInput(st.q, (v) => {
      st.q = v;
      onSearch();
    }, { placeholder: 'Kód, název nebo EAN…', ariaLabel: 'Hledat návrhy' }),
    filtersToggle,
    h('span', { class: 'toolbar-more' },
      sel('strategy', 'Strategie', strategies.map((s) => ({ value: s.id, label: s.name }))),
      sel('segment', 'Segment', segments.map((s) => ({ value: s.id, label: s.name }))),
      sel('direction', 'Směr', [{ value: 'up', label: '▲ Zdražení' }, { value: 'down', label: '▼ Zlevnění' }]),
      sel('flag', 'Příznak', Object.entries(FLAG_LABELS).map(([k, v]) => ({ value: k, label: v }))),
      sel('manufacturer', 'Výrobce', manufacturers.map((m) => ({ value: m.value, label: `${m.value} (${int(m.count)})` }))))
  );
  const summaryEl = h('div', { class: 'row small muted', style: 'margin:-4px 0 10px' });
  const runNote = h('div');

  mount(root, h('div', { class: 'stack-sm' }, h('div', { class: 'row-between', style: 'margin-bottom:8px' }, statusCtl), toolbar, runNote, summaryEl, h('div', { class: 'card' }, table.el), bulkbar));

  function renderSummary() {
    if (!summary) return mount(summaryEl);
    mount(
      summaryEl,
      h('span', null, count(total, 'návrh', 'návrhy', 'návrhů') + ' ve filtru'),
      h('span', { class: 'chg chg-up' }, '▲ ' + int(summary.up) + ' zdražení'),
      h('span', { class: 'chg chg-down' }, '▼ ' + int(summary.down) + ' zlevnění'),
      h('span', null, '· celkem čeká ' + int(summary.pending) + ', schváleno ' + int(summary.approved) + ', dnes exportováno ' + int(summary.exported_today))
    );
    ctx.setSub(int(summary.pending) + ' čeká na schválení · ' + int(summary.approved) + ' schváleno k exportu');
  }

  if (st.run) mount(runNote, callout(h('span', null, 'Zobrazeny návrhy z běhu #' + st.run + '. ', h('button', { type: 'button', class: 'btn btn-xs', onClick: () => { st.run = ''; mount(runNote); load(); } }, 'Zobrazit všechny')), 'info'));

  let seq = 0;
  async function load() {
    const my = ++seq;
    ctx.setQuery({ ...queryParams(), status: st.status !== 'pending' ? st.status : null, page: st.page > 1 ? st.page : null, limit: st.limit !== 50 ? st.limit : null });
    updateActions();
    table.setLoading(true);
    try {
      const res = await api.get('/proposals', queryParams(), { signal: ctx.signal, silent: true });
      if (my !== seq) return;
      rows = itemsOf(res);
      total = res.total ?? rows.length;
      summary = res.summary || null;
      editing = null;
      table.el.classList.toggle('hide-status', st.status === 'pending');
      table.setData(rows, { total, page: res.page, limit: res.limit });
      renderSummary();
      updateActions();
    } catch (e) {
      if (isAbort(e) || my !== seq) return;
      table.setError(e, () => load());
    }
  }
  ctx.onChanged((what) => {
    if (what !== 'proposals') load();
  });
  await load();
}
