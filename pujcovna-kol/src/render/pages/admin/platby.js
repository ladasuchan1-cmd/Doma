'use strict';
// Admin → Platby (SPEC kap. 13): seznam s filtry, „Simulovat příchozí převod“ (fio-mock), nespárované pohyby s ručním
// přiřazením k čekající platbě převodem, vratky k potvrzení. Vstup: data z features/admin.js. Výstup: Html.

const s = require('./shared');
const { html, c, format } = s;

const PURPOSES = [['', 'Vše'], ...Object.entries(s.PURPOSE_LABELS)];
const METHODS = [['', 'Vše'], ...Object.entries(s.METHOD_LABELS)];
const STATUSES = [['', 'Vše'], ...Object.entries(s.PAYMENT_STATUS).map(([k, [label]]) => [k, label])];

function platby({ rows, filters, unmatched, pendingTransfers, pendingRefunds, csrf, modules, sumPaid }) {
  return html`
<div class="admin-grid admin-grid--2">
${s.card({
    id: 'simulace',
    title: 'Simulovat příchozí převod (demo banky)',
    tone: 'info',
    children: modules.fio
      ? s.form({
          action: '/admin/platby/simulace',
          csrf,
          children: html`<p class="small muted">Vloží pohyb do výpisu (bank_transactions) a spáruje ho podle variabilního symbolu (tolerance ±5 Kč, nedoplatek → QR na zbytek, bez shody → fronta nespárovaných).</p>
          <div class="admin-grid admin-grid--3">${s.moneyField({ label: 'Částka (Kč)', name: 'castka', valueMinor: 30000, required: true })}${c.field({ label: 'Variabilní symbol', name: 'vs', value: filters.vs || '', inputmode: 'numeric', pattern: '[0-9]{0,10}', hint: 'číslo rezervace' })}${c.field({ label: 'Zpráva pro příjemce', name: 'zprava', value: '', maxlength: 60 })}</div>`,
          submit: 'Simulovat příchozí platbu',
        })
      : c.notice('Modul plateb (src/payments/fio-mock.js) zatím není k dispozici – simulaci převodu nelze spustit.', 'warning'),
  })}
${s.card({
    id: 'nesparovane',
    title: `Nespárované příchozí pohyby (${unmatched.length})`,
    children: s.table({
      head: ['Připsáno', { label: 'Částka', align: 'right' }, 'VS', 'Zpráva', 'Protiúčet', { label: 'Přiřadit k platbě', sort: false }],
      rows: unmatched.map((t) => [
        s.dt(t.booked_at),
        s.money(t.amount_minor),
        html`<span class="mono">${t.vs || '–'}</span>`,
        t.msg || '–',
        html`<span class="mono">${t.counter_account || '–'}</span>`,
        pendingTransfers.length
          ? html`<form class="form form--inline" method="post" action="/admin/platby/sparovat"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="tx" value="${t.tx_id}"><label class="visually-hidden" for="pm-${t.id}">Platba</label><select class="field__input field__input--select field__input--sm" id="pm-${t.id}" name="platba" required><option value="">– čekající platba –</option>${pendingTransfers.map((p) => html`<option value="${p.id}">${p.number} · ${s.PURPOSE_LABELS[p.purpose]} · ${format.money(p.amount_minor - p.captured_minor)}</option>`)}</select>${c.button({ label: 'Spárovat', type: 'submit', variant: 'secondary', size: 'sm' })}</form>`
          : html`<span class="muted">žádná čekající platba převodem</span>`,
      ]),
      empty: 'Vše je spárované.',
      sortable: false,
    }),
  })}
</div>
${s.card({
    title: `Vratky k potvrzení (${pendingRefunds.length})`,
    children: s.table({
      head: ['Rezervace', { label: 'Částka', align: 'right' }, 'Forma', 'Založena', { label: '', sort: false }],
      rows: pendingRefunds.map((p) => [s.reservationLink(p), s.money(p.amount_minor), s.METHOD_LABELS[p.method] || p.method, s.dt(p.created_at), s.actionButton({ action: `/admin/platby/vratka/${p.id}/potvrdit`, csrf, label: 'Odesláno – potvrdit', variant: 'primary', confirm: `Potvrdit odeslání vratky ${format.money(p.amount_minor)} k rezervaci ${p.number}?` })]),
      empty: 'Žádná vratka nečeká na potvrzení.',
      sortable: false,
    }),
  })}
${s.card({
    compact: true,
    children: c.form({
      action: '/admin/platby',
      method: 'get',
      attrs: { class: 'form form--filters' },
      children: html`${c.field({ label: 'Účel', name: 'ucel', type: 'select', value: filters.ucel, options: PURPOSES.map(([value, label]) => ({ value, label })) })}${c.field({ label: 'Forma', name: 'metoda', type: 'select', value: filters.metoda, options: METHODS.map(([value, label]) => ({ value, label })) })}${c.field({ label: 'Stav', name: 'stav', type: 'select', value: filters.stav, options: STATUSES.map(([value, label]) => ({ value, label })) })}${c.field({ label: 'VS / číslo rezervace', name: 'vs', type: 'search', value: filters.vs, inputmode: 'numeric' })}<div class="form__actions form__actions--inline">${c.button({ label: 'Filtrovat', type: 'submit', variant: 'secondary' })} <a class="btn btn--ghost" href="/admin/platby">Zrušit</a></div>`,
    }),
  })}
${s.card({
    title: `Platby (${rows.length}) · přijato ${format.money(sumPaid)}`,
    children: s.table({
      id: 'platby',
      filter: true,
      head: ['Čas', 'Rezervace', 'Účel', 'Forma', 'Poskytovatel / ref.', { label: 'Částka', align: 'right', sort: 'num' }, { label: 'Přijato / strženo', align: 'right', sort: 'num' }, 'Stav'],
      rows: rows.map((p) => [s.dt(p.updated_at), s.reservationLink(p), s.PURPOSE_LABELS[p.purpose] || p.purpose, s.METHOD_LABELS[p.method] || p.method, html`<span class="mono small">${p.provider}${p.provider_ref ? html`<br>${p.provider_ref}` : ''}</span>`, s.money(p.amount_minor), s.money(p.captured_minor), s.paymentBadge(p.status)]),
      empty: 'Žádná platba neodpovídá filtru.',
    }),
  })}`;
}

module.exports = { platby };
