// Strategie – pořadí (šipky i přetažení → POST /strategies/reorder), zapnutí, předvolby, odkaz na simulaci.
import { h, mount } from '../lib/dom.js';
import { api, cachedGet, itemsOf, isAbort, invalidate } from '../lib/api.js';
import { buildHash } from '../lib/router.js';
import { icon } from '../lib/icons.js';
import { card, emptyState, errorState, skeletonTable, switchEl, badge, callout, colorDot, button } from '../lib/ui.js';
import { confirmDialog } from '../lib/modal.js';
import { toast } from '../lib/toast.js';
import { describeTargetShort, describeLimitsShort, describeConditionsShort, describeScheduleShort, scheduleState, mergeConfig } from '../lib/strategy-model.js';
import { count, relTime } from '../lib/format.js';

export const title = 'Strategie';

function strategyBody(s, patch = {}) {
  return {
    name: s.name,
    description: s.description ?? null,
    segment_id: s.segment_id ?? null,
    priority: s.priority,
    enabled: Boolean(s.enabled),
    config: s.config,
    ...patch,
  };
}

export async function show(root, ctx) {
  ctx.setTitle('Strategie', 'Jak se chovat vůči trhu – pro každý produkt platí první vhodná strategie shora');
  ctx.setActions(h('a', { class: 'btn', href: '#/strategie/nova', dataset: { action: 'new-strategy' } }, icon('plus', { size: 16 }), h('span', { class: 'lbl' }, 'Nová strategie')));

  const listHost = h('div');
  const presetsHost = h('div');
  const coverageHost = h('div');
  let strategies = [];
  let segments = [];
  let fieldsMap = new Map();
  cachedGet('/fields', null, 60000).then((r) => {
    fieldsMap = new Map((r?.fields || []).map((f) => [f.key, f]));
    if (strategies.length && !ctx.signal.aborted) renderList();
  }).catch(() => {});

  mount(
    root,
    h(
      'div',
      { class: 'stack' },
      callout(h('span', null, 'Pro každý produkt se použije ', h('b', null, 'první zapnutá strategie'), ' (shora), jejíž segment produkt obsahuje. Strategie bez segmentu platí pro všechny produkty – dejte ji proto na konec jako výchozí. Pořadí změníte šipkami nebo přetažením.'), 'info'),
      coverageHost,
      card({ title: 'Pořadí strategií', icon: 'sliders', flush: true, body: listHost, dataset: { card: 'strategies' } }),
      card({ title: 'Předvolby', icon: 'zap', subtitle: 'Hotové strategie pro typické situace cykloobchodu. Předvolba založí segment i strategii (vypnutou) – před zapnutím ji zkontrolujte a nasimulujte.', body: presetsHost })
    )
  );

  function segName(id) {
    return segments.find((s) => String(s.id) === String(id));
  }

  async function reorder(ids) {
    // optimisticky přeuspořádat
    strategies = ids.map((id) => strategies.find((s) => s.id === id)).filter(Boolean);
    renderList();
    try {
      await api.post('/strategies/reorder', { ids });
      invalidate('/strategies');
      toast('Pořadí strategií uloženo', { type: 'success', timeout: 2000 });
    } catch {
      /* toast */
    }
    await loadList();
  }

  function move(idx, delta) {
    const j = idx + delta;
    if (j < 0 || j >= strategies.length) return;
    const ids = strategies.map((s) => s.id);
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    reorder(ids).then(() => {
      listHost.querySelector(`[data-id="${ids[j]}"] [data-move="${delta < 0 ? 'up' : 'down'}"]`)?.focus();
    });
  }

  async function toggle(s, on) {
    try {
      await api.put('/strategies/' + encodeURIComponent(s.id), strategyBody(s, { enabled: on }));
      s.enabled = on ? 1 : 0;
      invalidate('/strategies');
      toast(on ? 'Strategie „' + s.name + '“ zapnuta' : 'Strategie „' + s.name + '“ vypnuta', { type: 'success', timeout: 2500 });
      renderList();
    } catch {
      renderList();
    }
  }

  async function duplicate(s) {
    try {
      const res = await api.post('/strategies', strategyBody(s, { name: s.name + ' (kopie)', enabled: false, priority: undefined }));
      invalidate('/strategies');
      toast('Strategie zkopírována (vypnutá)', { type: 'success' });
      if (res?.id) ctx.navigate('#/strategie/' + res.id);
      else loadList();
    } catch {
      /* toast */
    }
  }

  async function remove(s) {
    const ok = await confirmDialog({ title: 'Smazat strategii', message: 'Opravdu smazat strategii „' + s.name + '“? Produkty, na které platila, převezme další strategie v pořadí.', confirmLabel: 'Smazat', danger: true });
    if (!ok) return;
    try {
      await api.del('/strategies/' + encodeURIComponent(s.id));
      invalidate('/strategies');
      toast('Strategie smazána', { type: 'success' });
    } catch {
      /* toast */
    }
    loadList();
  }

  function strategyMeta(s, cfg, seg) {
    const cond = describeConditionsShort(cfg.conditions, fieldsMap);
    const sch = describeScheduleShort(cfg.schedule);
    const limits = describeLimitsShort(cfg);
    return h(
      'div',
      { class: 'strategy-meta' },
      seg
        ? h('a', { href: '#/segmenty/' + encodeURIComponent(seg.id), class: 'meta-item' }, colorDot(seg.color), h('span', null, seg.name), seg.count != null ? h('span', { class: 'muted' }, '(' + count(seg.count, 'produkt', 'produkty', 'produktů') + ')') : null)
        : s.segment_id != null
          ? h('span', { class: 'meta-item chg chg-down' }, 'Segment #' + s.segment_id + ' nenalezen')
          : h('span', { class: 'meta-item' }, icon('box', { size: 13 }), 'Všechny produkty'),
      h('span', { class: 'meta-item', title: 'Cíl ceny' }, icon('target', { size: 13 }), describeTargetShort(cfg)),
      cond ? h('span', { class: 'meta-item', dataset: { meta: 'conditions' }, title: 'Doplňující podmínky' }, icon('filter', { size: 13 }), 'Podmínky: ' + cond) : null,
      sch ? h('span', { class: 'meta-item', dataset: { meta: 'schedule' }, title: 'Časové okno' }, icon('clock', { size: 13 }), 'Platnost: ' + sch) : null,
      limits ? h('span', { class: 'meta-item', title: 'Limity' }, icon('lock', { size: 13 }), limits) : null
    );
  }

  function schBadge(sch) {
    const state = scheduleState(sch);
    if (state === 'expired') return badge('Platnost skončila', 'warning');
    if (state === 'future') return badge('Zatím neplatí', 'info');
    return null;
  }

  function configErrors(s) {
    const errs = Array.isArray(s.config_errors) ? s.config_errors : [];
    return errs.length ? badge('Chybná konfigurace', 'danger', errs.join('; ')) : null;
  }

  let dragId = null;
  function renderList() {
    if (!strategies.length) {
      mount(listHost, emptyState({
        icon: 'sliders',
        title: 'Zatím žádná strategie',
        text: 'Bez strategie se nic nepřecení. Začněte předvolbou níže (např. „Výchozí – medián trhu −2 %“) nebo vytvořte vlastní.',
        actions: [h('a', { class: 'btn btn-primary', href: '#/strategie/nova' }, icon('plus', { size: 16 }), h('span', null, 'Nová strategie'))],
      }));
      return;
    }
    const items = strategies.map((s, i) => {
      const cfg = mergeConfig(s.config);
      const seg = s.segment_id != null ? segName(s.segment_id) : null;
      const sw = switchEl({ checked: Boolean(s.enabled), ariaLabel: (s.enabled ? 'Vypnout' : 'Zapnout') + ' strategii ' + s.name, onChange: (v) => toggle(s, v) });
      const li = h(
        'li',
        {
          class: ['strategy-item', s.enabled ? null : 'is-disabled'],
          dataset: { id: s.id },
          draggable: 'true',
          onDragstart: (e) => {
            dragId = s.id;
            li.classList.add('is-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(s.id));
          },
          onDragend: () => {
            dragId = null;
            li.classList.remove('is-dragging');
            listHost.querySelectorAll('.is-drag-over').forEach((x) => x.classList.remove('is-drag-over'));
          },
          onDragover: (e) => {
            if (dragId == null || dragId === s.id) return;
            e.preventDefault();
            li.classList.add('is-drag-over');
          },
          onDragleave: () => li.classList.remove('is-drag-over'),
          onDrop: (e) => {
            e.preventDefault();
            li.classList.remove('is-drag-over');
            if (dragId == null || dragId === s.id) return;
            const ids = strategies.map((x) => x.id).filter((x) => x !== dragId);
            ids.splice(ids.indexOf(s.id), 0, dragId);
            reorder(ids);
          },
        },
        h('span', { class: 'drag-handle', title: 'Přetáhněte pro změnu pořadí', 'aria-hidden': 'true' }, icon('grip', { size: 16 })),
        h('div', { class: 'strategy-order' },
          h('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Posunout výš: ' + s.name, disabled: i === 0, dataset: { move: 'up' }, onClick: () => move(i, -1) }, icon('chevron-up', { size: 14 })),
          h('span', { class: 'strategy-num', title: 'Priorita ' + s.priority }, String(i + 1)),
          h('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Posunout níž: ' + s.name, disabled: i === strategies.length - 1, dataset: { move: 'down' }, onClick: () => move(i, 1) }, icon('chevron-down', { size: 14 }))
        ),
        h(
          'div',
          { class: 'strategy-main' },
          h('div', { class: 'row', style: 'gap:8px' }, h('a', { class: 'strategy-name', href: '#/strategie/' + encodeURIComponent(s.id) }, s.name), s.enabled ? null : badge('Vypnuto', 'neutral'), cfg.approval.auto ? badge('Auto-schválení ≤ ' + (cfg.approval.auto_max_change_pct ?? '∞') + ' %', 'success') : null, schBadge(cfg.schedule), configErrors(s)),
          s.description ? h('div', { class: 'muted small ellipsis', title: s.description }, s.description) : null,
          strategyMeta(s, cfg, seg)
        ),
        h(
          'div',
          { class: 'strategy-actions' },
          sw,
          h('a', { class: 'btn btn-sm hide-sm', href: buildHash('/strategie/' + s.id, { simulovat: 1 }), title: 'Nasimulovat dopad bez uložení' }, icon('eye', { size: 14 }), h('span', { class: 'lbl' }, 'Simulovat')),
          h('a', { class: 'btn btn-sm', href: '#/strategie/' + encodeURIComponent(s.id) }, icon('edit', { size: 14 }), h('span', { class: 'lbl' }, 'Upravit')),
          button('', { icon: 'duplicate', variant: 'ghost', size: 'sm', title: 'Duplikovat', onClick: () => duplicate(s) }),
          button('', { icon: 'trash', variant: 'ghost', size: 'sm', title: 'Smazat', onClick: () => remove(s) })
        )
      );
      return li;
    });
    mount(listHost, h('ol', { class: 'strategy-list', 'aria-label': 'Strategie v pořadí priority' }, items));
  }

  async function loadList() {
    if (!strategies.length) mount(listHost, skeletonTable(4, 4));
    try {
      const [sr, gr] = await Promise.all([api.get('/strategies', null, { signal: ctx.signal, silent: true }), cachedGet('/segments', null, 5000)]);
      strategies = itemsOf(sr).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.id - b.id);
      segments = itemsOf(gr);
      renderList();
    } catch (e) {
      if (isAbort(e)) return;
      mount(listHost, errorState(e, () => loadList()));
    }
  }

  function presetMeta(p) {
    const cfg = mergeConfig(p.config);
    const cond = describeConditionsShort(cfg.conditions, fieldsMap);
    const sch = describeScheduleShort(cfg.schedule);
    return h(
      'ul',
      { class: 'preset-meta' },
      h('li', null, icon('layers', { size: 13 }), h('span', null, p.segment ? 'Segment „' + p.segment.name + '“' : 'Všechny produkty')),
      h('li', null, icon('target', { size: 13 }), h('span', null, describeTargetShort(cfg))),
      cond ? h('li', null, icon('filter', { size: 13 }), h('span', null, 'Podmínky: ' + cond)) : null,
      sch ? h('li', null, icon('clock', { size: 13 }), h('span', null, 'Platnost: ' + sch)) : null
    );
  }

  async function loadPresets() {
    try {
      const r = await api.get('/strategies/presets', null, { signal: ctx.signal, silent: true });
      const items = itemsOf(r);
      mount(
        presetsHost,
        items.length
          ? h(
            'div',
            { class: 'preset-grid' },
            items.map((p) =>
              h(
                'div',
                { class: 'preset', dataset: { preset: p.key } },
                h('h3', null, p.name),
                h('p', null, p.description || ''),
                presetMeta(p),
                h('div', { class: 'row' }, h('button', {
                  type: 'button', class: 'btn btn-sm',
                  onClick: async (e) => {
                    // tlačítko uložit před await – po něm je e.currentTarget null a po chybě by zůstalo vypnuté
                    const btn = e.currentTarget;
                    btn.disabled = true;
                    try {
                      const res = await api.post('/strategies/presets/' + encodeURIComponent(p.key), {});
                      invalidate();
                      const sid = res?.strategy?.id ?? res?.id;
                      toast('Předvolba „' + p.name + '“ založena – zkontrolujte ji a zapněte.', { type: 'success' });
                      if (sid) ctx.navigate('#/strategie/' + sid);
                      else loadList();
                    } catch {
                      /* chyba je v toastu */
                    } finally {
                      btn.disabled = false;
                    }
                  },
                }, icon('plus', { size: 14 }), h('span', null, 'Použít předvolbu')))
              )
            )
          )
          : h('p', { class: 'muted' }, 'Žádné předvolby.')
      );
    } catch (e) {
      if (isAbort(e)) return;
      mount(presetsHost, errorState(e, () => loadPresets()));
    }
  }

  async function loadCoverage() {
    try {
      const r = await api.get('/runs', { limit: 1 }, { signal: ctx.signal, silent: true });
      const run = itemsOf(r)[0];
      const n = run?.stats?.no_strategy;
      if (n) mount(coverageHost, callout(h('span', null, 'Při posledním přecenění (' + relTime(run.started_at) + ') nespadalo ' + count(n, 'produkt', 'produkty', 'produktů') + ' pod žádnou strategii. Přidejte výchozí strategii bez segmentu na konec pořadí.'), 'warning'));
      else mount(coverageHost);
    } catch {
      mount(coverageHost);
    }
  }

  ctx.onChanged(() => loadList());
  await Promise.all([loadList(), loadPresets(), loadCoverage()]);
}
