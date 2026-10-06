'use strict';
// Admin → Ceník (SPEC kap. 13): pásma per typ (mimo sezónu + každá sezóna; jednotky hodina / půlden / den 1 · 2–3 · 4–6 · 7+),
// sezóny (CRUD) a příslušenství (CRUD). Hodnoty se zadávají v Kč, feature je převádí na haléře.
// Vstup: { types: [{ type, table }], seasons, accessories, csrf }. Výstup: Html.

const s = require('./shared');
const { html, c, format } = s;
const { TIER_LABELS } = require('../../../domain/pricing');

const TIERS = [1, 2, 4, 7];

function priceCell(typeId, seasonId, unit, fromQty, valueMinor) {
  const name = `p_${seasonId === null ? 0 : seasonId}_${unit}_${fromQty}`;
  const v = valueMinor === null || valueMinor === undefined ? '' : String(Math.round(valueMinor) / 100);
  return html`<label class="visually-hidden" for="${name}-${typeId}">${unit} ${fromQty}</label><input class="field__input field__input--sm num" id="${name}-${typeId}" name="${name}" type="number" min="0" step="any" inputmode="decimal" value="${v}">`;
}

function typeTable({ type, table, csrf }) {
  return s.card({
    id: `typ-${type.id}`,
    title: type.name,
    actions: html`<small class="muted">poplatek ${format.money(type.fee_minor)} · kauce ${format.money(type.deposit_minor)}</small>`,
    children: s.form({
      action: `/admin/cenik/typ/${type.id}`,
      csrf,
      children: html`${s.tableWrap(html`<table class="table table--compact table--prices">
      <thead><tr><th scope="col">Období</th>${TIERS.map((t) => html`<th scope="col" class="is-right">${TIER_LABELS[t]}</th>`)}<th scope="col" class="is-right">Hodina</th><th scope="col" class="is-right">Půlden</th></tr></thead>
      <tbody>${table.map(
        (g) => html`<tr><th scope="row">${g.season ? html`${g.season.name}<br><small class="muted">${format.date(g.season.date_from)} – ${format.date(g.season.date_to)}</small>` : 'Mimo sezónu (základ)'}</th>${TIERS.map((t) => html`<td class="is-right">${priceCell(type.id, g.season ? g.season.id : null, 'day', t, g.tiers[t])}</td>`)}<td class="is-right">${priceCell(type.id, g.season ? g.season.id : null, 'hour', 1, g.hour)}</td><td class="is-right">${priceCell(type.id, g.season ? g.season.id : null, 'halfday', 1, g.halfday)}</td></tr>`
      )}</tbody></table>`)}
      <p class="small muted">Ceny v Kč za jednotku. Prázdné sezónní pole = použije se základní cena. Pásmo se vybírá podle celkového počtu dní.</p>`,
      submit: 'Uložit ceník typu',
      submitVariant: 'secondary',
    }),
  });
}

function cenik({ types, seasons, accessories, csrf }) {
  return html`
<div class="admin-grid admin-grid--2">
${s.card({
    title: 'Sezóny',
    children: html`${s.table({
      head: ['Název', 'Od', 'Do', { label: '', sort: false }],
      rows: seasons.map((se) => [se.name, s.date(se.date_from), s.date(se.date_to), s.actionButton({ action: `/admin/cenik/sezona/${se.id}/smazat`, csrf, label: 'Smazat', variant: 'danger', confirm: `Smazat sezónu „${se.name}“ včetně jejích cen?` })]),
      empty: 'Žádná sezóna – platí základní ceny celoročně.',
      sortable: false,
    })}
    <h3 class="admin-card__subtitle">Přidat sezónu</h3>
    ${s.form({
      action: '/admin/cenik/sezona',
      csrf,
      children: html`<div class="admin-grid admin-grid--3">${c.field({ label: 'Název', name: 'name', required: true, maxlength: 60 })}${c.field({ label: 'Od', name: 'date_from', type: 'date', required: true })}${c.field({ label: 'Do', name: 'date_to', type: 'date', required: true })}</div><p class="small muted">Sezónní ceny doplňte u jednotlivých typů níže (prázdné = základ).</p>`,
      submit: 'Přidat sezónu',
      submitVariant: 'secondary',
    })}`,
  })}
${s.card({
    title: 'Příslušenství',
    children: html`${s.table({
      head: ['Název', 'Slug', { label: 'Cena / den', align: 'right' }, { label: 'Skladem', align: 'right' }, 'Aktivní', { label: '', sort: false }],
      rows: accessories.map((a) => [
        html`<form class="form form--inline form--row" method="post" action="/admin/cenik/prislusenstvi/${a.id}" id="acc-${a.id}"><input type="hidden" name="_csrf" value="${csrf}"><label class="visually-hidden" for="acc-name-${a.id}">Název</label><input class="field__input field__input--sm" id="acc-name-${a.id}" name="name" value="${a.name}" required></form>`,
        html`<span class="mono">${a.slug}</span>`,
        html`<label class="visually-hidden" for="acc-price-${a.id}">Cena</label><input class="field__input field__input--sm num" id="acc-price-${a.id}" form="acc-${a.id}" name="price" type="number" min="0" step="1" value="${a.price_minor / 100}">`,
        html`<label class="visually-hidden" for="acc-stock-${a.id}">Skladem</label><input class="field__input field__input--sm num" id="acc-stock-${a.id}" form="acc-${a.id}" name="stock" type="number" min="0" step="1" value="${a.stock}">`,
        html`<label class="field__check field__check--plain"><input type="checkbox" form="acc-${a.id}" name="active" value="1"${a.active ? s.raw(' checked') : ''}><span class="visually-hidden">Aktivní</span></label>`,
        html`<button class="btn btn--secondary btn--sm" type="submit" form="acc-${a.id}">Uložit</button>`,
      ]),
      empty: 'Žádné příslušenství.',
      sortable: false,
    })}
    <h3 class="admin-card__subtitle">Přidat příslušenství</h3>
    ${s.form({
      action: '/admin/cenik/prislusenstvi',
      csrf,
      children: html`<div class="admin-grid admin-grid--3">${c.field({ label: 'Název', name: 'name', required: true, maxlength: 80 })}${s.moneyField({ label: 'Cena za den (Kč)', name: 'price', valueMinor: 0, required: true })}${c.field({ label: 'Skladem (ks)', name: 'stock', type: 'number', value: 1, min: 0, step: 1, required: true })}</div>`,
      submit: 'Přidat',
      submitVariant: 'secondary',
    })}`,
  })}
</div>
<h2 class="admin-section-title">Pásma podle typu</h2>
${types.map((t) => typeTable({ ...t, csrf }))}`;
}

module.exports = { cenik, TIERS };
