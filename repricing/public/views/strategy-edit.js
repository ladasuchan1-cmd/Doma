// Editor strategie – základní údaje, formulář konfigurace (SPEC §6.5), živé shrnutí, validace, simulace dopadu.
import { h, mount } from '../lib/dom.js';
import { api, cachedGet, itemsOf, isAbort, invalidate } from '../lib/api.js';
import { icon } from '../lib/icons.js';
import { card, field, switchEl, emptyState, errorState, skeletonBlocks, badge, callout, numberInput, segmented, changeEl } from '../lib/ui.js';
import { strategyForm } from '../lib/strategy-form.js';
import { describeStrategy, validateConfig, mergeConfig, hasExtensions } from '../lib/strategy-model.js';
import { runStatsView } from '../lib/run-stats.js';
import { histogram } from '../lib/charts.js';
import { DataTable } from '../lib/table.js';
import { explainList, actionBadge, priceMove } from '../lib/decision.js';
import { toast } from '../lib/toast.js';
import { confirmDialog } from '../lib/modal.js';
import { money, percent, int, count, parseInputNumber } from '../lib/format.js';
import { flagBadges } from '../lib/ui.js';

export const title = 'Strategie';

const SIM_FILTERS = [
  { value: 'change', label: 'Změny' },
  { value: 'skip', label: 'Přeskočené' },
  { value: 'all', label: 'Vše' },
];

export async function show(root, ctx) {
  const isNew = ctx.params.id === 'nova';
  ctx.setTitle(isNew ? 'Nová strategie' : 'Strategie', h('a', { href: '#/strategie' }, '← Strategie'));
  mount(root, h('div', { class: 'editor' }, h('div', { class: 'stack' }, skeletonBlocks(1, 160), skeletonBlocks(1, 260)), skeletonBlocks(1, 240)));

  let strategy;
  let segments = [];
  let competitors = [];
  try {
    const [s, segs, comps] = await Promise.all([
      isNew ? Promise.resolve(null) : api.get('/strategies/' + encodeURIComponent(ctx.params.id), null, { signal: ctx.signal, silent: true }),
      cachedGet('/segments', null, 5000).catch(() => ({ items: [] })),
      cachedGet('/competitors', null, 30000).catch(() => ({ items: [] })),
    ]);
    strategy = s;
    segments = itemsOf(segs);
    competitors = itemsOf(comps);
  } catch (e) {
    if (isAbort(e)) return;
    if (e.status === 404) {
      mount(root, emptyState({ icon: 'sliders', title: 'Strategie nenalezena', text: 'Strategie #' + ctx.params.id + ' neexistuje.', actions: [h('a', { class: 'btn', href: '#/strategie' }, 'Zpět na strategie')] }));
      return;
    }
    mount(root, errorState(e, () => show(root, ctx)));
    return;
  }

  // Rozšíření enginu (časové okno, podmínky, doprodej…) nabídnout, jen když je server podporuje.
  let extensions = strategy ? hasExtensions(strategy.config) : false;
  if (!strategy) {
    try {
      const pr = await cachedGet('/strategies/presets', null, 300000);
      extensions = itemsOf(pr).some((p) => hasExtensions(p.config));
    } catch {
      extensions = false;
    }
  }
  let fields = [];
  let facets = null;
  if (extensions) {
    const [fr, fc] = await Promise.allSettled([cachedGet('/fields'), cachedGet('/products/facets')]);
    fields = fr.status === 'fulfilled' ? fr.value?.fields || [] : [];
    facets = fc.status === 'fulfilled' ? fc.value : null;
  }
  if (ctx.signal.aborted) return;
  const fieldsMap = new Map(fields.map((f) => [f.key, f]));
  const model = strategy
    ? { name: strategy.name || '', description: strategy.description || '', segment_id: strategy.segment_id ?? null, priority: strategy.priority ?? null, enabled: Boolean(strategy.enabled), config: mergeConfig(strategy.config, { extensions }) }
    : { name: '', description: '', segment_id: ctx.query.segment ? Number(ctx.query.segment) : null, priority: null, enabled: true, config: mergeConfig({}, { extensions }) };
  if (!isNew) ctx.setTitle(model.name || 'Strategie', h('span', null, h('a', { href: '#/strategie' }, 'Strategie'), ' / ' + (model.name || '#' + ctx.params.id)));
  let dirty = false;

  // ------------------------------------------------ základ
  const nameIn = h('input', { class: 'input', value: model.name, required: true, maxlength: 120, placeholder: 'Např. Klíčové značky – pozice 2', dataset: { field: 'name' } });
  const descIn = h('textarea', { class: 'input', rows: 2, placeholder: 'K čemu strategie slouží (nepovinné)' });
  descIn.value = model.description;
  const segSel = h('select', { class: 'select', dataset: { field: 'segment' } }, h('option', { value: '' }, 'Všechny produkty (bez segmentu)'), segments.map((s) => h('option', { value: String(s.id) }, s.name + (s.count != null ? ' (' + int(s.count) + ')' : ''))));
  segSel.value = model.segment_id != null ? String(model.segment_id) : '';
  const segLink = h('a', { class: 'small' });
  const enabledSw = switchEl({ checked: model.enabled, label: 'Strategie je zapnutá', onChange: (v) => { model.enabled = v; changed(); } });
  const prioIn = numberInput(model.priority, { placeholder: 'automaticky', size: 6 });

  function updateSegLink() {
    if (model.segment_id != null) {
      segLink.href = '#/segmenty/' + encodeURIComponent(model.segment_id);
      segLink.textContent = 'Upravit segment →';
    } else {
      segLink.href = '#/segmenty/novy';
      segLink.textContent = 'Vytvořit segment →';
    }
  }
  updateSegLink();
  nameIn.addEventListener('input', () => { model.name = nameIn.value; changed(); });
  descIn.addEventListener('input', () => { model.description = descIn.value; changed(); });
  segSel.addEventListener('change', () => { model.segment_id = segSel.value ? Number(segSel.value) : null; updateSegLink(); changed(); });
  prioIn.addEventListener('input', () => {
    const v = parseInputNumber(prioIn.value);
    prioIn.classList.toggle('is-invalid', Number.isNaN(v));
    if (!Number.isNaN(v)) { model.priority = v; changed(); }
  });

  const baseCard = card({
    title: 'Základ',
    icon: 'sliders',
    body: [
      h('div', { class: 'form-grid form-grid-2' },
        field({ label: 'Název', control: nameIn, required: true }),
        field({ label: 'Segment', control: segSel, help: h('span', null, 'Na které produkty strategie platí. ', segLink) })
      ),
      h('div', { class: 'form-grid form-grid-2', style: 'margin-top:14px' },
        field({ label: 'Popis', control: descIn }),
        h('div', { class: 'stack-sm' }, enabledSw, field({ label: 'Priorita', control: prioIn, help: 'Nižší číslo = dřív. Pořadí lze měnit i v seznamu strategií.' }))
      ),
    ],
  });

  // ------------------------------------------------ konfigurace
  const form = strategyForm({ config: model.config, competitors, extensions, fields, facets, onChange: (cfg) => { model.config = cfg; changed(); } });

  // ------------------------------------------------ shrnutí + akce
  const summaryText = h('p', { class: 'summary-text', 'aria-live': 'polite' });
  const validationEl = h('div');
  const dirtyBadge = badge('Neuloženo', 'warning');
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', dataset: { action: 'save-strategy' }, onClick: () => save() }, icon('check', { size: 16 }), h('span', null, 'Uložit'));
  const simBtn = h('button', { type: 'button', class: 'btn', dataset: { action: 'simulate' }, onClick: () => simulate() }, icon('eye', { size: 16 }), h('span', null, 'Simulovat'));
  const delBtn = isNew ? null : h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => remove() }, icon('trash', { size: 16 }), h('span', null, 'Smazat'));
  const summaryCard = card({
    title: 'Shrnutí strategie',
    icon: 'info',
    class: 'summary-card',
    actions: [dirtyBadge],
    body: [summaryText, validationEl, h('div', { class: 'sticky-actions' }, saveBtn, simBtn, delBtn), h('p', { class: 'field-help' }, 'Simulace spočítá dopad na aktuálních datech bez uložení a bez vzniku návrhů.')],
    dataset: { card: 'summary' },
  });

  const simHost = h('div');

  function segNameOf(id) {
    return segments.find((s) => String(s.id) === String(id))?.name || null;
  }

  function changed() {
    dirty = true;
    refresh();
  }

  function refresh() {
    dirtyBadge.hidden = !dirty;
    summaryText.textContent = describeStrategy(model.config, { segmentName: model.segment_id != null ? segNameOf(model.segment_id) || '#' + model.segment_id : null, fieldsMap });
    const v = validateConfig(model.config);
    const errors = [...v.errors];
    if (!model.name.trim()) errors.unshift('Zadejte název strategie.');
    mount(
      validationEl,
      errors.length ? callout(h('div', null, h('b', null, 'Opravte před uložením:'), h('ul', { class: 'validation-list' }, errors.map((e) => h('li', null, e)))), 'danger') : null,
      v.warnings.length ? callout(h('ul', { class: 'validation-list' }, v.warnings.map((w) => h('li', null, w))), 'warning') : null
    );
    saveBtn.disabled = errors.length > 0;
    return errors;
  }

  async function save() {
    const errors = refresh();
    if (errors.length) {
      toast(errors[0], { type: 'error' });
      return;
    }
    const body = {
      name: model.name.trim(),
      description: model.description.trim() || null,
      segment_id: model.segment_id,
      enabled: model.enabled,
      config: model.config,
    };
    if (model.priority != null) body.priority = model.priority;
    saveBtn.disabled = true;
    saveBtn.classList.add('is-busy');
    try {
      const res = isNew ? await api.post('/strategies', body) : await api.put('/strategies/' + encodeURIComponent(ctx.params.id), body);
      invalidate('/strategies');
      dirty = false;
      refresh();
      toast('Strategie uložena', { type: 'success' });
      if (isNew && res?.id) ctx.navigate('#/strategie/' + res.id, { replace: true });
    } catch {
      /* toast s chybami ze serveru */
    } finally {
      saveBtn.disabled = false;
      saveBtn.classList.remove('is-busy');
    }
  }

  async function remove() {
    const ok = await confirmDialog({ title: 'Smazat strategii', message: 'Opravdu smazat strategii „' + model.name + '“?', confirmLabel: 'Smazat', danger: true });
    if (!ok) return;
    try {
      await api.del('/strategies/' + encodeURIComponent(ctx.params.id));
      invalidate('/strategies');
      toast('Strategie smazána', { type: 'success' });
      ctx.navigate('#/strategie');
    } catch {
      /* toast */
    }
  }

  // ------------------------------------------------ simulace
  async function resolveProducts(ids) {
    const map = new Map();
    if (!ids.length) return map;
    try {
      const res = await api.get('/products', { filter: JSON.stringify({ field: 'id', op: 'in', value: ids }), limit: 500, status: 'all' }, { signal: ctx.signal, silent: true });
      for (const p of itemsOf(res)) map.set(String(p.id), p);
    } catch {
      /* názvy nejsou kritické */
    }
    return map;
  }

  async function simulate() {
    const errors = validateConfig(model.config).errors;
    if (errors.length) {
      toast(errors[0], { type: 'error' });
      return;
    }
    simBtn.disabled = true;
    simBtn.classList.add('is-busy');
    mount(simHost, card({ title: 'Simulace', icon: 'eye', body: skeletonBlocks(4, 70) }));
    simHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
    let res;
    try {
      res = await api.post('/simulate', { config: model.config, segment_id: model.segment_id, limit: 200 }, { signal: ctx.signal });
    } catch (e) {
      if (!isAbort(e)) mount(simHost, card({ title: 'Simulace', icon: 'eye', body: errorState(e, () => simulate()) }));
      simBtn.disabled = false;
      simBtn.classList.remove('is-busy');
      return;
    }
    simBtn.disabled = false;
    simBtn.classList.remove('is-busy');
    const decisions = Array.isArray(res?.decisions) ? res.decisions : [];
    // API může rozhodnutí obohatit o product {code,name} nebo ploché code/name; jinak názvy dohledáme
    const missing = decisions.filter((d) => !d.product && !d.code).map((d) => d.product_id).filter((x) => x != null);
    const products = await resolveProducts([...new Set(missing)]);
    renderSimulation(res?.stats || {}, decisions, products, Array.isArray(res?.errors) ? res.errors : []);
  }

  function renderSimulation(stats, decisions, products, simErrors = []) {
    let filter = 'change';
    const rows = decisions.map((d, i) => ({ ...d, _key: i, _p: d.product || (d.code ? { code: d.code, name: d.name, manufacturer: d.manufacturer } : products.get(String(d.product_id))) || null }));
    const table = new DataTable({
      columns: [
        {
          key: 'product', label: 'Produkt', sortKey: 'code', value: (r) => r._p?.code || r.product_id,
          render: (r) => h('div', { class: 'cell-2' }, h('a', { href: '#/produkty/' + encodeURIComponent(r.product_id), class: 'cell-name' }, r._p?.name || 'Produkt #' + r.product_id), r._p ? h('span', { class: 'cell-sub mono' }, r._p.code) : null),
        },
        { key: 'action', label: 'Výsledek', render: (r) => actionBadge(r) },
        { key: 'old_price', label: 'Cena', align: 'right', sortable: true, value: (r) => r.new_price, render: (r) => (r.action === 'change' ? priceMove(r.old_price, r.new_price) : h('span', { class: 'num' }, money(r.old_price))) },
        { key: 'change_pct', label: 'Změna', align: 'right', sortable: true, value: (r) => r.change_pct, render: (r) => (r.action === 'change' ? changeEl(r.change_pct) : h('span', { class: 'muted' }, '–')) },
        { key: 'margin_after', label: 'Marže před → po', align: 'right', sortable: true, value: (r) => r.margin_after, render: (r) => h('span', { class: 'num' }, h('span', { class: 'muted' }, percent(r.margin_before)), ' → ', h('span', { class: r.margin_after != null && r.margin_after < 0 ? 'chg chg-down' : 'strong' }, percent(r.margin_after))) },
        { key: 'market', label: 'Trh', align: 'right', hideSm: true, hideLg: true, value: (r) => r.market?.min, render: (r) => h('div', { class: 'cell-2', style: 'align-items:flex-end' }, h('span', { class: 'num' }, money(r.market?.min)), r.market ? h('span', { class: 'cell-sub' }, count(r.market.count || 0, 'konkurent', 'konkurenti', 'konkurentů')) : null) },
        { key: 'rank', label: 'Pořadí', align: 'center', hideSm: true, hideLg: true, render: (r) => h('span', { class: 'num' }, (r.rank_before ?? '–') + ' → ' + (r.rank_after ?? '–')) },
        { key: 'flags', label: 'Příznaky', render: (r) => flagBadges(r.flags) },
      ],
      rowKey: '_key',
      clientSort: true,
      expandable: (r) => explainList(r.explain),
      empty: () => emptyState({ title: filter === 'skip' ? 'Nic se nepřeskočilo' : 'Žádné změny', text: filter === 'change' ? 'S touto konfigurací by se žádná cena nezměnila.' : null, compact: true }),
      caption: 'Výsledky simulace',
    });
    const apply = () => table.setData(rows.filter((r) => filter === 'all' || r.action === filter));
    apply();
    const changes = rows.filter((r) => r.action === 'change').map((r) => Number(r.change_pct));
    mount(
      simHost,
      card({
        title: 'Simulace' + (model.segment_id != null ? ' – segment „' + (segNameOf(model.segment_id) || model.segment_id) + '“' : ' – všechny produkty'),
        icon: 'eye',
        subtitle: 'Výsledek na aktuálních datech, nic se neuložilo. Zobrazeno prvních ' + int(rows.length) + ' rozhodnutí.',
        dataset: { card: 'simulation' },
        body: h(
          'div',
          { class: 'stack' },
          simErrors.length ? callout(h('ul', { class: 'validation-list' }, simErrors.map((e) => h('li', null, typeof e === 'string' ? e : e.message || JSON.stringify(e)))), 'danger') : null,
          runStatsView(stats, { simulate: true }),
          changes.length ? h('div', null, h('div', { class: 'form-subtitle' }, 'Rozložení změn ceny (%)'), histogram(changes, { ariaLabel: 'Histogram změn ceny v procentech' })) : null,
          h('div', { class: 'row-between' }, h('div', { class: 'form-subtitle', style: 'margin:0' }, 'Rozhodnutí'), segmented(SIM_FILTERS, filter, (v) => { filter = v; apply(); }, { label: 'Zobrazit rozhodnutí', class: 'seg-sm' })),
          h('div', { class: 'card' }, table.el)
        ),
      })
    );
  }

  mount(
    root,
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'editor' }, h('div', { class: 'stack' }, baseCard, form.el), h('aside', { class: 'editor-side', 'aria-label': 'Shrnutí a akce' }, summaryCard)),
      simHost
    )
  );
  refresh();
  dirty = false;
  dirtyBadge.hidden = true;
  const beforeUnload = (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  ctx.onCleanup(() => window.removeEventListener('beforeunload', beforeUnload));
  if (ctx.query.simulovat) simulate();
}
