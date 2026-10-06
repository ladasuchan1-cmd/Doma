'use strict';
// Admin → Kalendář (SPEC kap. 13): timeline – řádky typy kol rozbalitelné na kusy, sloupce dny (7/14/21/28), bloky podle
// stavu rezervace, klik → detail. Používá stejné třídy jako komponenta timeline() (base.css), navíc data-group /
// data-parent pro rozbalování kusů progresivním JS (bez JS jsou kusy vidět vždy).
// Vstup: { start, days: ['YYYY-MM-DD'], groups: [{ type, bars, bikes: [{ bike, bars }], unassigned: bars }], today, csrf }

const s = require('./shared');
const { html, attr, c, format } = s;
const { STATUS_LABELS } = require('../../../domain/reservations');

function bar(b, cols) {
  const from = Math.max(0, Math.min(cols - 1, b.fromIndex));
  const to = Math.max(from, Math.min(cols - 1, b.toIndex));
  const attrs = { class: `timeline__bar status-${String(b.status).replace(/[^a-z_-]/g, '')}${b.cutStart ? ' is-cut-start' : ''}${b.cutEnd ? ' is-cut-end' : ''}`, 'data-from': from + 1, 'data-span': to - from + 1, title: b.title, href: b.href };
  return html`<a${attr(attrs)}><span class="timeline__bar-label">${b.label}</span></a>`;
}

function row({ label, href, bars, cols, cls, dataAttrs, sub }) {
  return html`<div class="timeline__row${cls ? ` ${cls}` : ''}" role="row"${attr(dataAttrs || {})}>
    <div class="timeline__label" role="rowheader">${href ? html`<a href="${href}">${label}</a>` : label}${sub ? html` <small class="muted">${sub}</small>` : ''}</div>
    <div class="timeline__track" role="cell">${bars.map((b) => bar(b, cols))}</div>
  </div>`;
}

function kalendar({ start, days, groups, today, lengths, length }) {
  const cols = days.length;
  const prev = s.format.isoDate(new Date(`${start}T12:00:00Z`).getTime() - cols * 86400000);
  const next = s.format.isoDate(new Date(`${start}T12:00:00Z`).getTime() + cols * 86400000);
  const legend = ['awaiting_fee', 'confirmed', 'checked_out', 'returned', 'closed'];
  return html`
${s.card({
    compact: true,
    children: html`<div class="admin-toolbar">
    <div class="admin-toolbar__group">
      <a class="btn btn--ghost btn--sm" href="/admin/kalendar?od=${prev}&amp;dny=${cols}">← Dříve</a>
      <a class="btn btn--secondary btn--sm" href="/admin/kalendar?dny=${cols}">Dnes</a>
      <a class="btn btn--ghost btn--sm" href="/admin/kalendar?od=${next}&amp;dny=${cols}">Později →</a>
    </div>
    ${c.form({ action: '/admin/kalendar', method: 'get', attrs: { class: 'form form--inline' }, children: html`${c.field({ label: 'Od', name: 'od', type: 'date', value: start })}${c.field({ label: 'Dní', name: 'dny', type: 'select', value: String(cols), options: lengths.map((n) => ({ value: String(n), label: String(n) })) })}${c.button({ label: 'Zobrazit', type: 'submit', variant: 'secondary', size: 'sm' })}` })}
    <p class="admin-toolbar__group timeline-legend">${legend.map((st) => html`<span class="timeline-legend__item"><span class="timeline__bar status-${st}" aria-hidden="true"></span>${STATUS_LABELS[st]}</span>`)}</p>
    <button class="btn btn--ghost btn--sm" type="button" data-timeline-toggle hidden>Rozbalit vše</button>
  </div>`,
  })}
<div class="timeline timeline--admin" data-days="${cols}" role="table" aria-label="Obsazenost kol">
  <div class="timeline__head" role="row"><div class="timeline__label" role="columnheader">Typ / kolo</div>${days.map((d) => html`<div class="timeline__day${d === today ? ' is-today' : ''}" role="columnheader"><time datetime="${d}">${format.date(d).replace(/\s?\d{4}$/, '')}</time></div>`)}</div>
  ${groups.map(
    (g) => html`${row({ label: g.type.name, href: `/admin/kola/typ/${g.type.id}`, bars: g.bars, cols, cls: 'timeline__row--type', dataAttrs: { 'data-group': g.type.id, 'data-count': g.bikes.length }, sub: `${g.bikes.length} ks` })}
    ${g.bikes.map((b) => row({ label: b.bike.inventory_code, href: `/admin/kola/kus/${b.bike.id}`, bars: b.bars, cols, cls: `timeline__row--bike${b.bike.status !== 'available' ? ' is-unavailable' : ''}`, dataAttrs: { 'data-parent': g.type.id }, sub: `${b.bike.size}${b.bike.status !== 'available' ? ` · ${s.BIKE_STATUS[b.bike.status][0]}` : ''}` }))}
    ${g.unassigned.length ? row({ label: 'bez přiřazeného kusu', bars: g.unassigned, cols, cls: 'timeline__row--bike timeline__row--unassigned', dataAttrs: { 'data-parent': g.type.id } }) : ''}`
  )}
</div>
${groups.length ? '' : c.notice('Žádné aktivní typy kol.', 'info')}`;
}

module.exports = { kalendar };
