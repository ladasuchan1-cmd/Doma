// Vykreslení rozhodnutí cenotvorby: kroky vysvětlení, přechod ceny, souhrn trhu.
import { h } from './dom.js';
import { icon } from './icons.js';
import { badge, flagBadges, changeEl, dl } from './ui.js';
import { money, percent, int, stepLabel, reasonLabel, ACTION_LABELS, excludedLabel, toNum } from './format.js';

/** Seznam kroků vysvětlení [{step, text}]. */
export function explainList(steps) {
  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) return h('p', { class: 'muted' }, 'Bez vysvětlení.');
  return h(
    'ol',
    { class: 'steps-explain' },
    list.map((s) => h('li', null, h('span', { class: 'step-key' }, stepLabel(s.step)), h('span', { class: 'step-text' }, s.text ?? '')))
  );
}

/** „12 990 Kč → 12 490 Kč“ */
export function priceMove(oldP, newP) {
  return h('span', { class: 'price-move' }, h('span', { class: 'old' }, money(oldP)), icon('arrow-right', { size: 12 }), h('span', { class: 'strong' }, money(newP)));
}

const ACTION_VARIANT = { change: 'info', no_change: 'neutral', skip: 'warning' };

/** Odznak akce rozhodnutí (Změna ceny / Beze změny / Přeskočeno – důvod). */
export function actionBadge(d) {
  if (!d) return badge('Bez strategie', 'neutral');
  const label = ACTION_LABELS[d.action] || d.action || '–';
  return badge(d.reason ? label + ': ' + reasonLabel(d.reason) : label, ACTION_VARIANT[d.action] || 'neutral');
}

/** Souhrn trhu z decision.market. */
export function marketSummary(m) {
  if (!m) return null;
  const cheapest = m.cheapest ? m.cheapest.competitor + ' ' + money(m.cheapest.price) : '–';
  return dl([
    ['Konkurentů', int(m.count)],
    ['Nejlevnější', cheapest],
    ['Medián / průměr', money(m.median) + ' / ' + money(m.avg)],
    ['Nejdražší', money(m.max)],
    Array.isArray(m.excluded) && m.excluded.length
      ? ['Vyřazeno', h('span', { class: 'tags' }, m.excluded.map((x) => h('span', { class: 'tag-chip', title: money(x.price) }, (x.competitor || '?') + ': ' + excludedLabel(x.reason))))]
      : null,
  ]);
}

/** Kompletní karta rozhodnutí (hlavička + ceny + hranice + příznaky + kroky). */
export function decisionView(d, opts = {}) {
  if (!d) return h('p', { class: 'muted' }, 'Rozhodnutí není k dispozici.');
  const newP = toNum(d.new_price);
  return h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'decision-head' },
      actionBadge(d),
      d.action === 'change' ? h('span', { class: 'decision-price' }, priceMove(d.old_price, newP)) : null,
      d.action === 'change' ? changeEl(d.change_pct) : null,
      d.auto_approve ? badge('Automaticky schválit', 'success') : null
    ),
    h(
      'div',
      { class: 'grid-2' },
      dl([
        ['Referenční cena', money(d.reference_price)],
        ['Cílová cena', money(d.target_price)],
        ['Spodní hranice', money(d.floor)],
        ['Horní hranice', money(d.ceiling)],
      ]),
      dl([
        ['Marže před → po', percent(d.margin_before) + ' → ' + percent(d.margin_after)],
        ['Pořadí před → po', (d.rank_before ?? '–') + ' → ' + (d.rank_after ?? '–')],
        ['Příznaky', flagBadges(d.flags)],
        opts.strategyName ? ['Strategie', opts.strategyName] : null,
      ])
    ),
    opts.showMarket !== false && d.market ? h('div', null, h('div', { class: 'form-subtitle' }, 'Trh'), marketSummary(d.market)) : null,
    h('div', null, h('div', { class: 'form-subtitle' }, 'Postup výpočtu'), explainList(d.explain))
  );
}
