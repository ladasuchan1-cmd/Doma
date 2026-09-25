// Segmenty – seznam s počty produktů, popisem podmínek a použitím ve strategiích.
import { h, mount } from '../lib/dom.js';
import { api, cachedGet, itemsOf, isAbort, invalidate } from '../lib/api.js';
import { buildHash } from '../lib/router.js';
import { icon } from '../lib/icons.js';
import { DataTable } from '../lib/table.js';
import { emptyState, colorDot, button, callout } from '../lib/ui.js';
import { confirmDialog } from '../lib/modal.js';
import { toast } from '../lib/toast.js';
import { describeFilter, countConditions } from '../lib/filter-model.js';
import { int, truncate } from '../lib/format.js';

export const title = 'Segmenty';

export async function show(root, ctx) {
  ctx.setTitle('Segmenty', 'Skupiny produktů podle vašich metrik – na ně se navazují strategie');
  ctx.setActions(h('a', { class: 'btn', href: '#/segmenty/novy', dataset: { action: 'new-segment' } }, icon('plus', { size: 16 }), h('span', { class: 'lbl' }, 'Nový segment')));
  let fieldsMap = new Map();
  let strategies = [];

  const table = new DataTable({
    columns: [
      {
        key: 'name', label: 'Segment', sortable: true,
        render: (s) => h('div', { class: 'cell-2' }, h('span', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, colorDot(s.color), h('a', { href: '#/segmenty/' + encodeURIComponent(s.id), class: 'strong' }, s.name)), s.description ? h('span', { class: 'cell-sub ellipsis', style: 'max-width:420px' }, s.description) : null),
      },
      {
        key: 'filter', label: 'Podmínky', hideSm: true,
        render: (s) => {
          const text = describeFilter(s.filter, fieldsMap);
          return h('span', { class: 'small', title: text }, truncate(text, 110), ' ', h('span', { class: 'muted' }, '(' + int(countConditions(s.filter)) + ')'));
        },
      },
      { key: 'count', label: 'Produktů', sortable: true, align: 'right', value: (s) => s.count, render: (s) => (s.count == null ? h('span', { class: 'muted' }, '–') : h('a', { href: buildHash('/produkty', { segment: s.id }), class: 'num strong', title: 'Zobrazit produkty segmentu' }, int(s.count))) },
      {
        key: 'strategies', label: 'Strategie', hideSm: true,
        render: (s) => {
          const used = strategies.filter((x) => String(x.segment_id) === String(s.id));
          return used.length ? h('span', { class: 'tags' }, used.map((x) => h('a', { class: 'tag-chip', href: '#/strategie/' + encodeURIComponent(x.id) }, x.name))) : h('span', { class: 'muted small' }, 'nepoužit');
        },
      },
      {
        key: 'actions', label: 'Akce', align: 'right',
        render: (s) => h('span', { class: 'row-actions' },
          h('a', { class: 'btn btn-sm', href: '#/segmenty/' + encodeURIComponent(s.id) }, icon('edit', { size: 14 }), h('span', { class: 'lbl hide-sm' }, 'Upravit')),
          h('a', { class: 'btn btn-sm btn-ghost hide-sm', href: buildHash('/strategie/nova', { segment: s.id }), title: 'Nová strategie pro tento segment' }, icon('sliders', { size: 14 })),
          button('', { icon: 'trash', variant: 'ghost', size: 'sm', title: 'Smazat segment', onClick: () => remove(s) })),
      },
    ],
    clientSort: true,
    sort: { key: 'name', dir: 'asc' },
    onRowClick: (s) => ctx.navigate('#/segmenty/' + encodeURIComponent(s.id)),
    caption: 'Segmenty',
    empty: () => emptyState({
      icon: 'layers',
      title: 'Zatím žádné segmenty',
      text: 'Segment je pojmenovaná skupina produktů podle podmínek – např. „Ležáky N7/N8“ (atribut N je N7 nebo N8) nebo „Bez konkurence“ (počet konkurentů = 0). Na segmenty se pak navazují strategie.',
      actions: [h('a', { class: 'btn btn-primary', href: '#/segmenty/novy' }, icon('plus', { size: 16 }), h('span', null, 'Vytvořit segment')), h('a', { class: 'btn', href: '#/strategie' }, 'Předvolby strategií')],
    }),
  });

  async function remove(s) {
    const used = strategies.filter((x) => String(x.segment_id) === String(s.id));
    if (used.length) {
      toast('Segment používá strategie „' + used.map((x) => x.name).join('“, „') + '“ – nejdřív je upravte nebo smažte.', { type: 'warning' });
      return;
    }
    const ok = await confirmDialog({ title: 'Smazat segment', message: 'Opravdu smazat segment „' + s.name + '“?', confirmLabel: 'Smazat', danger: true });
    if (!ok) return;
    try {
      await api.del('/segments/' + encodeURIComponent(s.id));
      invalidate('/segments');
      toast('Segment smazán', { type: 'success' });
    } catch {
      /* 409 → toast se zprávou serveru */
    }
    load();
  }

  mount(root, h('div', { class: 'stack' }, callout('Produkt může patřit do více segmentů. Která strategie se na něj použije, určuje pořadí strategií.', 'info'), h('div', { class: 'card' }, table.el)));

  async function load() {
    table.setLoading(true);
    try {
      const [segs, strs, fields] = await Promise.all([
        api.get('/segments', null, { signal: ctx.signal, silent: true }),
        cachedGet('/strategies', null, 5000).catch(() => ({ items: [] })),
        cachedGet('/fields').catch(() => ({ fields: [] })),
      ]);
      strategies = itemsOf(strs);
      fieldsMap = new Map((fields?.fields || []).map((f) => [f.key, f]));
      const items = itemsOf(segs);
      table.setData(items);
      ctx.setSub(int(items.length) + ' segmentů · produkt může patřit do více segmentů');
    } catch (e) {
      if (isAbort(e)) return;
      table.setError(e, () => load());
    }
  }
  ctx.onChanged(() => load());
  await load();
}
