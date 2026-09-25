// Produkty – vyhledávání, rychlé filtry (facety), pokročilý filtr, řaditelná stránkovaná tabulka.
import { h, mount, debounce } from '../lib/dom.js';
import { api, cachedGet, itemsOf, isAbort } from '../lib/api.js';
import { buildHash } from '../lib/router.js';
import { icon } from '../lib/icons.js';
import { DataTable } from '../lib/table.js';
import { card, emptyState, positionBadge, changeEl, searchInput, checkbox } from '../lib/ui.js';
import { filterBuilder } from '../lib/filter-builder.js';
import { describeFilter, countConditions, isEmptyFilter } from '../lib/filter-model.js';
import { money, percent, int, index, count, statusLabel, POSITION_LABELS, POSITION_ORDER } from '../lib/format.js';

export const title = 'Produkty';

const FACET_FILTERS = [
  { key: 'manufacturer', label: 'Výrobce', facet: 'manufacturers' },
  { key: 'category', label: 'Kategorie', facet: 'categories' },
  { key: 'owner', label: 'Zodpovědná osoba', facet: 'owners' },
  { key: 'supplier', label: 'Dodavatel', facet: 'suppliers' },
];

function parseFilter(s) {
  if (!s) return null;
  try {
    const f = JSON.parse(s);
    return f && typeof f === 'object' ? f : null;
  } catch {
    return null;
  }
}

export async function show(root, ctx) {
  const q = ctx.query;
  const st = {
    q: q.q || '',
    manufacturer: q.manufacturer || '',
    category: q.category || '',
    owner: q.owner || '',
    supplier: q.supplier || '',
    position: q.position || '',
    segment: q.segment || '',
    has_proposal: q.has_proposal === '1',
    status: q.status || 'active',
    filter: parseFilter(q.filter),
    sort: q.sort || 'code',
    dir: q.dir === 'desc' ? 'desc' : 'asc',
    page: Math.max(1, Number(q.page) || 1),
    limit: Number(q.limit) || 50,
  };
  ctx.setTitle('Produkty', '');
  ctx.setActions(h('a', { class: 'btn btn-ghost', href: '#/import' }, icon('upload', { size: 16 }), h('span', { class: 'lbl' }, 'Import katalogu')));

  let facets = null;
  let segments = [];
  let fields = [];
  const [facetsRes, segRes] = await Promise.allSettled([cachedGet('/products/facets'), cachedGet('/segments')]);
  if (facetsRes.status === 'fulfilled') facets = facetsRes.value;
  if (segRes.status === 'fulfilled') segments = itemsOf(segRes.value);
  if (ctx.signal.aborted) return;

  function queryParams() {
    return {
      q: st.q || null,
      manufacturer: st.manufacturer || null,
      category: st.category || null,
      owner: st.owner || null,
      supplier: st.supplier || null,
      position: st.position || null,
      segment: st.segment || null,
      has_proposal: st.has_proposal ? 1 : null,
      status: st.status !== 'active' ? st.status : null,
      filter: st.filter && !isEmptyFilter(st.filter) ? JSON.stringify(st.filter) : null,
      sort: st.sort,
      dir: st.dir,
      page: st.page,
      limit: st.limit,
    };
  }

  function syncUrl() {
    const p = queryParams();
    ctx.setQuery({ ...p, sort: st.sort !== 'code' ? st.sort : null, dir: st.dir !== 'asc' ? st.dir : null, page: st.page > 1 ? st.page : null, limit: st.limit !== 50 ? st.limit : null, filter: p.filter });
  }

  function anyFilter() {
    return Boolean(st.q || st.manufacturer || st.category || st.owner || st.supplier || st.position || st.segment || st.has_proposal || st.status !== 'active' || (st.filter && !isEmptyFilter(st.filter)));
  }

  function clearFilters() {
    Object.assign(st, { q: '', manufacturer: '', category: '', owner: '', supplier: '', position: '', segment: '', has_proposal: false, status: 'active', filter: null, page: 1 });
    renderToolbar();
    load();
  }

  const columns = [
    { key: 'code', label: 'Kód', sortable: true, hideSm: true, class: 'code-cell', render: (r) => h('span', { class: 'code-cell' }, r.code) },
    {
      key: 'name',
      label: 'Název',
      sortable: true,
      main: true,
      render: (r) => h(
        'div',
        { class: 'cell-2' },
        h('a', { href: '#/produkty/' + encodeURIComponent(r.id), class: 'cell-name', style: 'max-width:250px', title: r.name }, r.locked ? icon('lock', { size: 12, title: 'Zamčeno' }) : null, r.locked ? ' ' : null, r.name || r.code),
        h('span', { class: 'cell-sub ellipsis', style: 'max-width:250px' }, h('span', { class: 'show-sm mono' }, r.code + ' · '), [r.manufacturer, r.category].filter(Boolean).join(' · ') + (r.active === 0 || r.active === false ? ' · neaktivní' : ''))
      ),
    },
    { key: 'manufacturer', label: 'Výrobce', sortable: true, hideSm: true, hideLg: true },
    { key: 'stock', label: 'Sklad', format: 'int', sortable: true },
    { key: 'purchase_price', label: 'Nákup', format: 'money0', sortable: true, hideSm: true, title: 'Nákupní cena bez DPH' },
    { key: 'price', label: 'Cena', format: 'money0', sortable: true, title: 'Prodejní cena s DPH' },
    { key: 'margin_pct', label: 'Marže', format: 'percent', sortable: true, render: (r) => h('span', { class: r.margin_pct != null && r.margin_pct < 0 ? 'chg chg-down' : 'num' }, percent(r.margin_pct)) },
    {
      key: 'market_min',
      label: 'Min. trh',
      format: 'money0',
      sortable: true,
      render: (r) => (r.market_min == null ? h('span', { class: 'muted' }, '–') : h('div', { class: 'cell-2', style: 'align-items:flex-end' }, h('span', { class: 'num' }, money(r.market_min, { decimals: 0 })), r.cheapest_competitor ? h('span', { class: 'cell-sub ellipsis', style: 'max-width:120px', title: r.cheapest_competitor + ' · ' + int(r.market_count) + ' konk.' }, r.cheapest_competitor) : null)),
    },
    { key: 'price_index', label: 'Index', format: 'index', sortable: true, title: 'Naše cena / nejnižší cena trhu × 100', render: (r) => h('span', { class: r.price_index > 110 ? 'chg chg-down' : 'num' }, index(r.price_index)) },
    { key: 'position', label: 'Pozice', sortable: true, render: (r) => positionBadge(r.position) },
    { key: 'market_count', label: 'Konk.', format: 'int', sortable: true, hideLg: true, title: 'Počet započtených konkurentů' },
    {
      key: 'proposal',
      label: 'Návrh',
      align: 'right',
      render: (r) => {
        const p = r.proposal;
        if (!p) return h('span', { class: 'muted' }, '–');
        const approved = p.status === 'approved';
        return h('div', { class: 'cell-2', style: 'align-items:flex-end', title: statusLabel(p.status) }, h('span', { class: 'num strong nowrap' }, approved ? h('span', { class: 'chg-up', 'aria-label': 'schváleno' }, icon('check', { size: 12 }), ' ') : null, money(p.new_price, { decimals: 0 })), changeEl(p.change_pct));
      },
    },
  ];

  const table = new DataTable({
    columns,
    pagination: true,
    page: st.page,
    limit: st.limit,
    sort: { key: st.sort, dir: st.dir },
    caption: 'Produkty',
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
    onRowClick: (r) => ctx.navigate('#/produkty/' + encodeURIComponent(r.id)),
    empty: () =>
      anyFilter()
        ? emptyState({ icon: 'filter', title: 'Žádný produkt neodpovídá filtrům', text: 'Zkuste filtry uvolnit nebo zrušit.', actions: [h('button', { type: 'button', class: 'btn', onClick: clearFilters }, 'Zrušit filtry')] })
        : emptyState({ icon: 'box', title: 'Zatím žádné produkty', text: 'Nahrajte katalog z POHODY nebo adminu – produkty se pak objeví tady.', actions: [h('a', { class: 'btn btn-primary', href: '#/import' }, 'Importovat katalog')] }),
  });

  // --------------------------------------------------------------- toolbar
  const toolbar = h('div', { class: 'toolbar' });
  const pills = h('div', { class: 'filters-active' });
  const advPanel = h('div', { hidden: true });
  let fb = null;

  const onSearch = debounce(() => {
    st.page = 1;
    load();
  }, 280);

  function facetSelect(f) {
    const list = facets?.[f.facet] || [];
    const sel = h('select', {
      class: 'select',
      'aria-label': f.label,
      onChange: (e) => {
        st[f.key] = e.target.value;
        st.page = 1;
        renderPills();
        load();
      },
    }, h('option', { value: '' }, f.label + ': vše'), list.map((x) => h('option', { value: String(x.value) }, `${x.value} (${int(x.count)})`)));
    if (st[f.key] && !list.some((x) => String(x.value) === st[f.key])) sel.appendChild(h('option', { value: st[f.key] }, st[f.key]));
    sel.value = st[f.key];
    return sel;
  }

  function renderToolbar() {
    const search = searchInput(st.q, (v) => {
      st.q = v;
      onSearch();
    }, { placeholder: 'Kód, název nebo EAN…', ariaLabel: 'Hledat produkty', id: 'products-search' });
    const posSel = h('select', {
      class: 'select', 'aria-label': 'Pozice',
      onChange: (e) => { st.position = e.target.value; st.page = 1; renderPills(); load(); },
    }, h('option', { value: '' }, 'Pozice: vše'), POSITION_ORDER.map((p) => h('option', { value: p }, POSITION_LABELS[p])));
    posSel.value = st.position;
    const segSel = h('select', {
      class: 'select', 'aria-label': 'Segment',
      onChange: (e) => { st.segment = e.target.value; st.page = 1; renderPills(); load(); },
    }, h('option', { value: '' }, 'Segment: vše'), segments.map((s) => h('option', { value: String(s.id) }, s.name + (s.count != null ? ` (${int(s.count)})` : ''))));
    segSel.value = st.segment;
    const statusSel = h('select', {
      class: 'select', 'aria-label': 'Stav produktu',
      onChange: (e) => { st.status = e.target.value; st.page = 1; renderPills(); load(); },
    }, h('option', { value: 'active' }, 'Aktivní'), h('option', { value: 'inactive' }, 'Neaktivní'), h('option', { value: 'all' }, 'Aktivní i neaktivní'));
    statusSel.value = st.status;
    const n = countConditions(st.filter);
    const advBtn = h('button', {
      type: 'button', class: ['btn', n ? 'btn-primary' : null], 'aria-expanded': advPanel.hidden ? 'false' : 'true', dataset: { action: 'advanced-filter' },
      onClick: () => toggleAdvanced(),
    }, icon('filter', { size: 16 }), h('span', null, 'Pokročilý filtr'), n ? h('span', { class: 'seg-count' }, String(n)) : null);
    const nActive = FACET_FILTERS.filter((f) => st[f.key]).length + (st.position ? 1 : 0) + (st.segment ? 1 : 0) + (st.has_proposal ? 1 : 0) + (st.status !== 'active' ? 1 : 0) + (n ? 1 : 0);
    const toggle = h('button', {
      type: 'button', class: 'btn filters-toggle', 'aria-expanded': toolbar.classList.contains('is-open') ? 'true' : 'false',
      onClick: () => { toolbar.classList.toggle('is-open'); toggle.setAttribute('aria-expanded', toolbar.classList.contains('is-open') ? 'true' : 'false'); },
    }, icon('filter', { size: 16 }), h('span', null, 'Filtry'), nActive ? h('span', { class: 'seg-count' }, String(nActive)) : null);
    mount(
      toolbar,
      search,
      toggle,
      h('span', { class: 'toolbar-more' },
        FACET_FILTERS.slice(0, 3).map(facetSelect),
        posSel,
        segSel,
        facetSelect(FACET_FILTERS[3]),
        statusSel,
        checkbox('Jen s návrhem', st.has_proposal, (v) => { st.has_proposal = v; st.page = 1; renderPills(); load(); }),
        advBtn)
    );
    renderPills();
  }

  function renderPills() {
    const items = [];
    const pill = (text, clear) => items.push(h('span', { class: 'filter-pill' }, text, h('button', { type: 'button', 'aria-label': 'Zrušit filtr ' + text, onClick: clear }, icon('x', { size: 12 }))));
    for (const f of FACET_FILTERS) if (st[f.key]) pill(f.label + ': ' + st[f.key], () => { st[f.key] = ''; st.page = 1; renderToolbar(); load(); });
    if (st.position) pill('Pozice: ' + (POSITION_LABELS[st.position] || st.position), () => { st.position = ''; renderToolbar(); load(); });
    if (st.segment) pill('Segment: ' + (segments.find((s) => String(s.id) === st.segment)?.name || '#' + st.segment), () => { st.segment = ''; renderToolbar(); load(); });
    if (st.has_proposal) pill('Jen s návrhem', () => { st.has_proposal = false; renderToolbar(); load(); });
    if (st.filter && !isEmptyFilter(st.filter)) {
      const fm = new Map(fields.map((f) => [f.key, f]));
      pill('Filtr: ' + describeFilter(st.filter, fm), () => { st.filter = null; if (fb) fb.setFilter({}); renderToolbar(); load(); });
    }
    if (items.length > 1) items.push(h('button', { type: 'button', class: 'btn btn-xs btn-ghost', onClick: clearFilters }, 'Zrušit vše'));
    mount(pills, items);
    pills.hidden = !items.length;
  }

  async function toggleAdvanced(force) {
    const open = force ?? advPanel.hidden;
    advPanel.hidden = !open;
    renderToolbar();
    if (!open || fb) return;
    mount(advPanel, card({ body: h('div', { class: 'muted' }, 'Načítám pole…') }));
    try {
      const fr = await cachedGet('/fields');
      fields = fr?.fields || [];
    } catch (e) {
      mount(advPanel, card({ body: h('div', { class: 'callout callout-danger' }, 'Pole pro filtr se nepodařilo načíst: ' + e.message) }));
      return;
    }
    let pending = st.filter || {};
    fb = filterBuilder({ value: st.filter || {}, fields, facets, emptyText: 'Žádná podmínka – zobrazují se všechny produkty. Přidejte podmínku, např. Marže % je menší než 10.', onChange: (f) => { pending = f; } });
    mount(
      advPanel,
      card({
        title: 'Pokročilý filtr',
        icon: 'filter',
        subtitle: 'Libovolné podmínky nad poli produktu, metrikami trhu i importovanými atributy.',
        body: [
          fb.el,
          h(
            'div',
            { class: 'form-actions' },
            h('button', { type: 'button', class: 'btn btn-primary', dataset: { action: 'apply-filter' }, onClick: () => { st.filter = isEmptyFilter(pending) ? null : pending; st.page = 1; renderToolbar(); load(); } }, 'Použít filtr'),
            h('button', { type: 'button', class: 'btn', onClick: () => { fb.setFilter({}); pending = {}; st.filter = null; renderToolbar(); load(); } }, 'Vymazat'),
            h('span', { class: 'toolbar-spacer' }),
            h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.navigate(buildHash('/segmenty/novy', { filter: pending })) }, icon('layers', { size: 16 }), h('span', null, 'Uložit jako segment'))
          ),
        ],
      })
    );
  }

  mount(root, h('div', { class: 'stack-sm' }, toolbar, pills, advPanel, h('div', { class: 'card' }, table.el)));
  renderToolbar();
  if (st.filter) toggleAdvanced(true);

  let seq = 0;
  async function load() {
    const my = ++seq;
    syncUrl();
    table.setLoading(true);
    try {
      const res = await api.get('/products', queryParams(), { signal: ctx.signal, silent: true });
      if (my !== seq) return;
      table.setData(itemsOf(res), { total: res.total, page: res.page, limit: res.limit });
      ctx.setSub(count(res.total ?? 0, 'produkt', 'produkty', 'produktů') + (anyFilter() ? ' odpovídá filtrům' : ''));
    } catch (e) {
      if (isAbort(e) || my !== seq) return;
      table.setError(e, () => load());
    }
  }
  ctx.onChanged(() => load());
  await load();
}
