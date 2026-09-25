// Editor segmentu – název, popis, barva, filtr (editor podmínek i JSON) a živý náhled (POST /segments/preview).
import { h, mount, debounce } from '../lib/dom.js';
import { api, cachedGet, itemsOf, isAbort, invalidate } from '../lib/api.js';
import { buildHash } from '../lib/router.js';
import { icon } from '../lib/icons.js';
import { card, field, emptyState, errorState, skeletonBlocks, badge, callout } from '../lib/ui.js';
import { filterBuilder } from '../lib/filter-builder.js';
import { describeFilter, validateFilter, isEmptyFilter } from '../lib/filter-model.js';
import { confirmDialog } from '../lib/modal.js';
import { toast } from '../lib/toast.js';
import { int, count, money, POSITION_LABELS } from '../lib/format.js';

export const title = 'Segment';

const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948', '#898781'];

export async function show(root, ctx) {
  const isNew = ctx.params.id === 'novy' || ctx.params.id === 'nova';
  ctx.setTitle(isNew ? 'Nový segment' : 'Segment', h('a', { href: '#/segmenty' }, '← Segmenty'));
  mount(root, h('div', { class: 'editor' }, h('div', { class: 'stack' }, skeletonBlocks(1, 140), skeletonBlocks(1, 220)), skeletonBlocks(1, 300)));

  let segment = null;
  let fields = [];
  let facets = null;
  let strategies = [];
  try {
    const [seg, fr, fc, st] = await Promise.all([
      isNew ? Promise.resolve(null) : api.get('/segments/' + encodeURIComponent(ctx.params.id), null, { signal: ctx.signal, silent: true }),
      cachedGet('/fields'),
      cachedGet('/products/facets').catch(() => null),
      cachedGet('/strategies', null, 5000).catch(() => ({ items: [] })),
    ]);
    segment = seg;
    fields = fr?.fields || [];
    facets = fc;
    strategies = itemsOf(st);
  } catch (e) {
    if (isAbort(e)) return;
    if (e.status === 404) {
      mount(root, emptyState({ icon: 'layers', title: 'Segment nenalezen', actions: [h('a', { class: 'btn', href: '#/segmenty' }, 'Zpět na segmenty')] }));
      return;
    }
    mount(root, errorState(e, () => show(root, ctx)));
    return;
  }
  const fieldsMap = new Map(fields.map((f) => [f.key, f]));
  let initialFilter = segment?.filter || {};
  if (isNew && ctx.query.filter) {
    try {
      initialFilter = JSON.parse(ctx.query.filter);
    } catch {
      /* neplatný filtr v URL – začít prázdným */
    }
  }
  const model = { name: segment?.name || '', description: segment?.description || '', color: segment?.color || COLORS[0], filter: initialFilter };
  if (!isNew) ctx.setTitle(model.name || 'Segment', h('span', null, h('a', { href: '#/segmenty' }, 'Segmenty'), ' / ' + model.name));
  let dirty = false;
  const usedBy = segment ? strategies.filter((s) => String(s.segment_id) === String(segment.id)) : [];

  // ------------------------------------------------ základ
  const nameIn = h('input', { class: 'input', value: model.name, required: true, maxlength: 120, placeholder: 'Např. Ležáky N7/N8', dataset: { field: 'name' } });
  const descIn = h('textarea', { class: 'input', rows: 2, placeholder: 'K čemu segment slouží (nepovinné)' });
  descIn.value = model.description;
  const colorIn = h('input', { type: 'color', class: 'input', value: /^#[0-9a-f]{6}$/i.test(model.color) ? model.color : COLORS[0], 'aria-label': 'Vlastní barva' });
  const swatches = h('div', { class: 'color-swatches', role: 'group', 'aria-label': 'Barva segmentu' });
  function renderSwatches() {
    mount(swatches, COLORS.map((c) => h('button', { type: 'button', class: 'color-swatch', style: { background: c }, 'aria-label': 'Barva ' + c, 'aria-pressed': c === model.color ? 'true' : 'false', onClick: () => { model.color = c; colorIn.value = c; renderSwatches(); changed(); } })), colorIn);
  }
  renderSwatches();
  colorIn.addEventListener('input', () => { model.color = colorIn.value; renderSwatches(); changed(); });
  nameIn.addEventListener('input', () => { model.name = nameIn.value; changed(); });
  descIn.addEventListener('input', () => { model.description = descIn.value; changed(); });

  const baseCard = card({
    title: 'Segment',
    icon: 'layers',
    body: [
      h('div', { class: 'form-grid form-grid-2' }, field({ label: 'Název', control: nameIn, required: true }), field({ label: 'Barva', control: swatches, input: colorIn })),
      h('div', { style: 'margin-top:14px' }, field({ label: 'Popis', control: descIn })),
      usedBy.length ? h('div', { style: 'margin-top:12px' }, callout(h('span', null, 'Segment používá: ', usedBy.map((s, i) => [i ? ', ' : '', h('a', { href: '#/strategie/' + s.id }, s.name)])), 'info')) : null,
    ],
  });

  // ------------------------------------------------ filtr
  const summary = h('div', { class: 'fb-summary', 'aria-live': 'polite' });
  const fb = filterBuilder({ value: model.filter, fields, facets, onChange: (f) => { model.filter = f; changed(); schedulePreview(); } });
  const jsonArea = h('textarea', { class: 'input json-edit', rows: 10, spellcheck: 'false', 'aria-label': 'Filtr jako JSON' });
  const jsonErr = h('div', { class: 'field-error' });
  const jsonWrap = h(
    'div',
    { hidden: true, class: 'stack-sm', style: 'margin-top:12px' },
    jsonArea,
    jsonErr,
    h('div', { class: 'row' }, h('button', {
      type: 'button', class: 'btn btn-sm',
      onClick: () => {
        let f;
        try {
          f = JSON.parse(jsonArea.value || '{}');
        } catch (e) {
          jsonErr.textContent = 'Neplatný JSON: ' + e.message;
          return;
        }
        const v = validateFilter(f);
        if (!v.ok) {
          jsonErr.textContent = v.errors.join('; ');
          return;
        }
        jsonErr.textContent = '';
        fb.setFilter(f);
        toast('Filtr z JSON použit', { type: 'success', timeout: 1500 });
      },
    }, 'Použít JSON'), h('span', { class: 'field-help' }, 'Gramatika: {"all":[…]} / {"any":[…]} / {"not":…} / {"field","op","value"}.'))
  );
  const jsonToggle = h('button', {
    type: 'button', class: 'btn btn-sm btn-ghost', 'aria-expanded': 'false',
    onClick: () => {
      jsonWrap.hidden = !jsonWrap.hidden;
      jsonToggle.setAttribute('aria-expanded', jsonWrap.hidden ? 'false' : 'true');
      if (!jsonWrap.hidden) jsonArea.value = JSON.stringify(model.filter, null, 2);
    },
  }, icon('code', { size: 14 }), h('span', null, 'JSON'));
  const filterCard = card({
    title: 'Podmínky',
    icon: 'filter',
    subtitle: 'Produkt patří do segmentu, když splní podmínky. Texty se porovnávají bez ohledu na velikost písmen a diakritiku.',
    actions: [jsonToggle],
    body: [fb.el, summary, jsonWrap],
    dataset: { card: 'filter' },
  });

  // ------------------------------------------------ náhled + akce
  const countEl = h('div', { class: 'big-number', 'aria-live': 'polite' }, '…');
  const previewErrors = h('div');
  const sampleHost = h('div');
  const dirtyBadge = badge('Neuloženo', 'warning');
  dirtyBadge.hidden = true;
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', dataset: { action: 'save-segment' }, onClick: () => save() }, icon('check', { size: 16 }), h('span', null, 'Uložit'));
  const productsLink = h('a', { class: 'btn btn-ghost' }, icon('box', { size: 16 }), h('span', null, 'V produktech'));
  const delBtn = isNew ? null : h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => remove() }, icon('trash', { size: 16 }), h('span', null, 'Smazat'));
  const previewCard = card({
    title: 'Náhled',
    icon: 'eye',
    actions: [dirtyBadge],
    class: 'summary-card',
    dataset: { card: 'preview' },
    body: [
      h('div', { class: 'preview-head' }, countEl, h('span', { class: 'muted', dataset: { role: 'count-label' } }, 'aktivních produktů')),
      previewErrors,
      h('div', { class: 'sticky-actions' }, saveBtn, productsLink, delBtn),
      h('div', { class: 'form-subtitle' }, 'Ukázka (max. 20)'),
      sampleHost,
    ],
  });

  function changed() {
    dirty = true;
    dirtyBadge.hidden = false;
    summary.textContent = 'Popis: ' + describeFilter(model.filter, fieldsMap);
    productsLink.href = !isNew && !dirty ? buildHash('/produkty', { segment: segment.id }) : buildHash('/produkty', { filter: isEmptyFilter(model.filter) ? null : model.filter });
  }

  let seq = 0;
  async function preview() {
    const my = ++seq;
    countEl.classList.add('muted');
    try {
      const r = await api.post('/segments/preview', { filter: model.filter }, { signal: ctx.signal, silent: true });
      if (my !== seq) return;
      countEl.classList.remove('muted');
      countEl.textContent = int(r?.count ?? 0);
      const errs = Array.isArray(r?.errors) ? r.errors : [];
      mount(previewErrors, errs.length ? callout(h('ul', { class: 'validation-list' }, errs.map((e) => h('li', null, typeof e === 'string' ? e : e.message || JSON.stringify(e)))), 'danger') : null);
      const sample = Array.isArray(r?.sample) ? r.sample : [];
      mount(
        sampleHost,
        sample.length
          ? h(
            'ul',
            { class: 'list-plain' },
            sample.map((p) =>
              h(
                'li',
                null,
                h('span', { class: ['pos', 'pos-' + (p.position || 'no_data')], title: POSITION_LABELS[p.position] || '' }, h('span', { class: 'pos-dot', 'aria-hidden': 'true' })),
                h('div', { class: 'cell-2', style: 'flex:1;min-width:0' }, h('a', { href: '#/produkty/' + encodeURIComponent(p.id), class: 'ellipsis' }, p.name || p.code), h('span', { class: 'cell-sub mono' }, p.code)),
                h('span', { class: 'num small' }, money(p.price, { decimals: 0 }))
              )
            )
          )
          : emptyState({ icon: 'filter', title: 'Žádný produkt', text: 'Podmínkám neodpovídá žádný aktivní produkt.', compact: true })
      );
    } catch (e) {
      if (isAbort(e) || my !== seq) return;
      countEl.textContent = '–';
      mount(previewErrors, callout('Náhled selhal: ' + e.message, 'danger'));
    }
  }
  const schedulePreview = debounce(preview, 350);

  async function save() {
    if (!model.name.trim()) {
      toast('Zadejte název segmentu.', { type: 'error' });
      nameIn.focus();
      return;
    }
    const errs = fb.getErrors();
    if (errs.length) {
      const ok = await confirmDialog({ title: 'Neúplné podmínky', message: count(errs.length, 'podmínka je neúplná', 'podmínky jsou neúplné', 'podmínek je neúplných') + ' a nebude uložena. Pokračovat?', confirmLabel: 'Uložit bez nich' });
      if (!ok) return;
    }
    const body = { name: model.name.trim(), description: model.description.trim() || null, filter: fb.getFilter(), color: model.color };
    saveBtn.disabled = true;
    saveBtn.classList.add('is-busy');
    try {
      const res = isNew ? await api.post('/segments', body) : await api.put('/segments/' + encodeURIComponent(segment.id), body);
      invalidate('/segments');
      dirty = false;
      dirtyBadge.hidden = true;
      toast('Segment uložen' + (res?.count != null ? ' – ' + count(res.count, 'produkt', 'produkty', 'produktů') : ''), { type: 'success' });
      if (isNew && res?.id) ctx.navigate('#/segmenty/' + res.id, { replace: true });
    } catch {
      /* toast */
    } finally {
      saveBtn.disabled = false;
      saveBtn.classList.remove('is-busy');
    }
  }

  async function remove() {
    if (usedBy.length) {
      toast('Segment používají strategie – nejdřív je upravte.', { type: 'warning' });
      return;
    }
    const ok = await confirmDialog({ title: 'Smazat segment', message: 'Opravdu smazat segment „' + model.name + '“?', confirmLabel: 'Smazat', danger: true });
    if (!ok) return;
    try {
      await api.del('/segments/' + encodeURIComponent(segment.id));
      invalidate('/segments');
      toast('Segment smazán', { type: 'success' });
      ctx.navigate('#/segmenty');
    } catch {
      /* toast */
    }
  }

  mount(root, h('div', { class: 'editor' }, h('div', { class: 'stack' }, baseCard, filterCard), h('aside', { class: 'editor-side', 'aria-label': 'Náhled segmentu' }, previewCard)));
  changed();
  dirty = isNew && !isEmptyFilter(model.filter);
  dirtyBadge.hidden = !dirty;
  productsLink.href = !isNew ? buildHash('/produkty', { segment: segment.id }) : buildHash('/produkty', { filter: isEmptyFilter(model.filter) ? null : model.filter });
  const beforeUnload = (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  ctx.onCleanup(() => window.removeEventListener('beforeunload', beforeUnload));
  await preview();
  if (isNew) nameIn.focus();
}
