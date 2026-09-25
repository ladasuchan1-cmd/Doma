// Zobrazení statistik přecenění / simulace (tvar stats z runPricing / simulate, SPEC §6.8).
import { h } from './dom.js';
import { kpi, badge } from './ui.js';
import { int, signedMoney, reasonLabel, count } from './format.js';
import { barList } from './charts.js';
import { DataTable } from './table.js';

function sumSkipped(skipped) {
  if (!skipped || typeof skipped !== 'object') return 0;
  return Object.values(skipped).reduce((s, v) => s + (Number(v) || 0), 0);
}

/**
 * KPI dlaždice + rozpad přeskočených + tabulka podle strategií.
 * @param {object} stats
 * @param {{simulate?: boolean, strategyNames?: Record<string, string>}} [o]
 */
export function runStatsView(stats, o = {}) {
  const s = stats || {};
  const skipped = sumSkipped(s.skipped);
  const tiles = h(
    'div',
    { class: 'kpi-grid compact' },
    kpi({ label: 'Produktů', value: int(s.products), sub: s.evaluated != null ? 'vyhodnoceno ' + int(s.evaluated) : null }),
    kpi({ label: 'Změn ceny', value: int(s.changes), tone: 'info', sub: h('span', null, h('span', { class: 'chg chg-up' }, '▲ ' + int(s.up)), ' ', h('span', { class: 'chg chg-down' }, '▼ ' + int(s.down))) }),
    kpi({ label: 'Beze změny', value: int(s.no_change) }),
    kpi({ label: 'Přeskočeno', value: int(skipped), tone: skipped ? 'warning' : null }),
    o.simulate ? null : kpi({ label: 'Čeká na schválení', value: int(s.pending) }),
    kpi({ label: 'Autom. schváleno', value: int(s.auto_approved) }),
    s.no_strategy ? kpi({ label: 'Bez strategie', value: int(s.no_strategy), tone: 'warning' }) : null,
    kpi({ label: 'Dopad na marži', value: signedMoney(s.margin_impact_abs, { decimals: 0 }), sub: 'bez DPH, 1 ks od každého', tone: (s.margin_impact_abs || 0) < 0 ? 'danger' : 'good' })
  );
  const parts = [tiles];
  if (skipped) {
    parts.push(
      h(
        'div',
        { class: 'row', style: 'margin-top:10px' },
        h('span', { class: 'muted small' }, 'Přeskočeno:'),
        Object.entries(s.skipped).filter(([, v]) => v).map(([k, v]) => badge(reasonLabel(k) + ': ' + int(v), 'neutral'))
      )
    );
  }
  const bs = s.by_strategy && typeof s.by_strategy === 'object' ? Object.entries(s.by_strategy) : [];
  if (bs.length > 1 || (bs.length === 1 && !o.simulate)) {
    const t = new DataTable({
      columns: [
        { key: 'name', label: 'Strategie', sortable: true },
        { key: 'products', label: 'Produktů', format: 'int', sortable: true },
        { key: 'changes', label: 'Změn', format: 'int', sortable: true },
        { key: 'up', label: '▲', format: 'int', title: 'Zdražení' },
        { key: 'down', label: '▼', format: 'int', title: 'Zlevnění' },
      ],
      rowKey: 'id',
      clientSort: true,
    });
    t.setData(bs.map(([id, v]) => ({ id, name: v.name || o.strategyNames?.[id] || 'Strategie #' + id, products: v.products, changes: v.changes, up: v.up, down: v.down })));
    parts.push(h('div', { style: 'margin-top:14px' }, h('div', { class: 'form-subtitle' }, 'Podle strategií'), h('div', { class: 'card' }, t.el)));
  }
  return h('div', { class: 'run-stats' }, parts);
}

/** Krátký textový souhrn běhu („42 změn · ▲ 10 · ▼ 32“). */
export function runSummaryText(stats) {
  const s = stats || {};
  return count(s.changes ?? 0, 'změna', 'změny', 'změn') + ' · ▲ ' + int(s.up) + ' · ▼ ' + int(s.down);
}

/** Pruhový graf přeskočených důvodů. */
export function skippedBars(skipped) {
  const items = Object.entries(skipped || {}).filter(([, v]) => v).map(([k, v]) => ({ label: reasonLabel(k), value: v }));
  if (!items.length) return null;
  return barList(items, { color: 'var(--s4)' });
}

