// Zobrazení statistik přecenění / simulace (tvar stats z runPricing / simulate, SPEC §6.8).
import { h } from './dom.js';
import { kpi, badge } from './ui.js';
import { int, signedMoney, compactMoney, reasonLabel, flagLabel, count } from './format.js';
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
    kpi({ label: 'Dopad na marži', value: compactMoney(s.margin_impact_abs, { signed: true }), title: signedMoney(s.margin_impact_abs, { decimals: 0 }) + ' (bez DPH, součet za 1 ks od každého produktu)', sub: 'bez DPH, 1 ks od každého', tone: (s.margin_impact_abs || 0) < 0 ? 'danger' : 'good' })
  );
  const parts = [tiles];
  const reasonRow = (label, obj, labelFn, variant = 'neutral') => {
    const entries = obj && typeof obj === 'object' ? Object.entries(obj).filter(([, v]) => Number(v) > 0).sort((a, b) => b[1] - a[1]) : [];
    if (!entries.length) return null;
    return h('div', { class: 'row reason-row' }, h('span', { class: 'muted small' }, label), entries.map(([k, v]) => badge(labelFn(k) + ': ' + int(v), variant, k)));
  };
  const rows = [
    reasonRow('Přeskočeno:', s.skipped, reasonLabel, 'warning'),
    reasonRow('Beze změny:', s.no_change_reasons, reasonLabel),
    reasonRow('Příznaky změn:', s.flags, flagLabel, 'info'),
    Number(s.fallthrough) > 0 ? h('div', { class: 'row reason-row' }, h('span', { class: 'muted small' }, 'Propadnutí:'), h('span', { class: 'small' }, count(s.fallthrough, 'produkt', 'produkty', 'produktů') + ' přešlo na další strategii (chyběl základ ceny)')) : null,
  ].filter(Boolean);
  if (rows.length) parts.push(h('div', { class: 'stack-sm', style: 'margin-top:10px' }, rows));
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

