'use strict';
// Admin → Dnes (SPEC kap. 13): výdeje a vrácení dnes, čekající poplatky, nespárované platby, kauce k uvolnění,
// vratky k potvrzení, poslední e-maily. Vstup: data z features/admin.js (bez PII zákazníků). Výstup: Html.

const s = require('./shared');
const { html } = s;

function reservationRows(list, { showTime }) {
  return list.map((r) => [s.reservationLink(r), showTime === 'from' ? s.dt(r.from_at) : s.dt(r.to_at), s.itemsSummary(r.items), s.statusBadge(r.status), s.money(r.total_minor), r.flags || '']);
}

function dnes({ today, checkouts, returns, awaitingFee, unmatched, depositsToRelease, pendingRefunds, mails, counts, modules }) {
  const head = (timeLabel) => ['Číslo', timeLabel, 'Kola', 'Stav', { label: 'Cena', align: 'right', sort: 'num' }, { label: '', sort: false }];
  return html`
${s.stats([
    { label: 'Výdeje dnes', value: checkouts.length, href: '#vydeje', tone: 'primary' },
    { label: 'Vrácení dnes', value: returns.length, href: '#vraceni', tone: 'info' },
    { label: 'Čeká na poplatek', value: awaitingFee.length, href: '#poplatky', tone: awaitingFee.length ? 'warning' : null },
    { label: 'Nespárované platby', value: unmatched.length, href: '#nesparovane', tone: unmatched.length ? 'danger' : null },
    { label: 'Kauce k vypořádání', value: depositsToRelease.length, href: '#kauce', tone: depositsToRelease.length ? 'warning' : null },
    { label: 'Potvrzených celkem', value: counts.confirmed || 0, href: '/admin/rezervace?stav=confirmed' },
  ])}
<div class="admin-grid admin-grid--2">
  ${s.card({ id: 'vydeje', title: `Výdeje – ${s.format.dateLong(today)}`, children: s.table({ head: head('Vyzvednutí'), rows: reservationRows(checkouts, { showTime: 'from' }), empty: 'Dnes žádný výdej.', sortable: false }) })}
  ${s.card({ id: 'vraceni', title: 'Vrácení dnes a po termínu', children: s.table({ head: head('Vrácení'), rows: reservationRows(returns, { showTime: 'to' }), empty: 'Dnes se nic nevrací.', sortable: false }) })}
</div>
<div class="admin-grid admin-grid--2">
  ${s.card({
    id: 'poplatky',
    title: 'Rezervace čekající na poplatek',
    children: s.table({
      head: ['Číslo', 'Termín od', 'Poplatek', 'Vyprší', { label: '', sort: false }],
      rows: awaitingFee.map((r) => [s.reservationLink(r), s.dt(r.from_at), s.money(r.fee_minor), s.dt(r.expires_at), html`<a class="btn btn--ghost btn--sm" href="/admin/rezervace/${r.id}#platby">Potvrdit platbu</a>`]),
      empty: 'Žádná rezervace nečeká na poplatek.',
      sortable: false,
    }),
  })}
  ${s.card({
    id: 'nesparovane',
    title: 'Nespárované příchozí platby',
    actions: html`<a class="btn btn--ghost btn--sm" href="/admin/platby#nesparovane">Platby</a>`,
    children: s.table({
      head: ['Připsáno', 'Částka', 'VS', 'Zpráva'],
      rows: unmatched.map((t) => [s.dt(t.booked_at), s.money(t.amount_minor), html`<span class="mono">${t.vs || '–'}</span>`, t.msg || '–']),
      empty: modules.fio ? 'Vše spárováno.' : 'Modul plateb (fio-mock) zatím není k dispozici.',
      sortable: false,
    }),
  })}
</div>
<div class="admin-grid admin-grid--2">
  ${s.card({
    id: 'kauce',
    title: 'Kauce k uvolnění / vypořádání',
    children: s.table({
      head: ['Číslo', 'Stav rezervace', 'Kauce', 'Forma', 'Složena'],
      rows: depositsToRelease.map((p) => [s.reservationLink(p), s.statusBadge(p.status), s.money(p.amount_minor), s.METHOD_LABELS[p.method] || p.method, s.dt(p.created_at)]),
      empty: 'Žádná kauce nečeká na vypořádání.',
      sortable: false,
    }),
  })}
  ${s.card({
    title: 'Vratky k potvrzení',
    children: s.table({
      head: ['Číslo', 'Částka', 'Forma', 'Založena'],
      rows: pendingRefunds.map((p) => [s.reservationLink(p), s.money(p.amount_minor), s.METHOD_LABELS[p.method] || p.method, s.dt(p.created_at)]),
      empty: 'Žádná vratka nečeká na odeslání.',
      sortable: false,
    }),
  })}
</div>
${s.card({
    title: 'Poslední e-maily (outbox)',
    actions: html`<a class="btn btn--ghost btn--sm" href="/admin/emaily">Všechny</a>`,
    children: s.table({
      head: ['Vytvořen', 'Typ', 'Předmět', 'Rezervace', 'Stav'],
      rows: mails.map((m) => [s.dt(m.created_at), s.MAIL_LABELS[m.type] || m.type, html`<a href="/admin/emaily/${m.id}">${m.subject}</a>`, m.number ? html`<span class="mono">${m.number}</span>` : '–', m.sent_at ? s.c.badge('odesláno', 'success') : s.c.badge('ve frontě', 'warning')]),
      empty: 'Outbox je prázdný.',
      sortable: false,
    }),
  })}`;
}

module.exports = { dnes };
