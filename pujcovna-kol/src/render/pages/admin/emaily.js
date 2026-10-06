'use strict';
// Admin → E-maily (SPEC kap. 13): outbox se stavem odeslání a náhledem – HTML tělo v sandboxovaném <iframe srcdoc>
// (bez skriptů, bez formulářů) a textová verze; adresát se nezobrazuje (v DB je jen HMAC + šifrovaná adresa).
// Vstup: data z features/admin.js. Výstup: Html.

const s = require('./shared');
const { html, c, attr } = s;

function list({ rows, filters, page, pages, href, total, types }) {
  return html`
${s.card({
    compact: true,
    children: c.form({
      action: '/admin/emaily',
      method: 'get',
      attrs: { class: 'form form--filters' },
      children: html`${c.field({ label: 'Typ', name: 'typ', type: 'select', value: filters.typ, options: [{ value: '', label: 'Vše' }, ...types.map((t) => ({ value: t, label: s.MAIL_LABELS[t] || t }))] })}${c.field({ label: 'Stav', name: 'stav', type: 'select', value: filters.stav, options: [{ value: '', label: 'Vše' }, { value: 'fronta', label: 'Ve frontě' }, { value: 'odeslano', label: 'Odesláno' }, { value: 'chyba', label: 'S chybou' }] })}${c.field({ label: 'Číslo rezervace', name: 'q', type: 'search', value: filters.q, inputmode: 'numeric' })}<div class="form__actions form__actions--inline">${c.button({ label: 'Filtrovat', type: 'submit', variant: 'secondary' })} <a class="btn btn--ghost" href="/admin/emaily">Zrušit</a></div>`,
    }),
  })}
${s.card({
    title: `Outbox (${total})`,
    children: html`<p class="small muted">V demu se e-maily neodesílají – ukládají se do tabulky outbox. Adresa příjemce se v administraci nezobrazuje.</p>
    ${s.table({
      id: 'emaily',
      head: ['Vytvořen', 'Typ', 'Předmět', 'Rezervace', 'Pokusů', 'Stav'],
      rows: rows.map((m) => [s.dt(m.created_at), s.MAIL_LABELS[m.type] || m.type, html`<a href="/admin/emaily/${m.id}">${m.subject}</a>`, m.reservationId ? html`<a class="mono" href="/admin/rezervace/${m.reservationId}">${m.number || m.reservationId}</a>` : html`<span class="muted">–</span>`, m.attempts, m.sent_at ? c.badge(`odesláno ${s.format.dateTime(m.sent_at)}`, 'success') : m.error ? c.badge('chyba', 'danger') : c.badge('ve frontě', 'warning')]),
      empty: 'Outbox je prázdný.',
    })}
    ${s.pager({ page, pages, href })}`,
  })}`;
}

function detail({ mail, payload }) {
  const meta = [
    ['Typ', s.MAIL_LABELS[mail.type] || mail.type],
    ['Předmět', mail.subject],
    ['Vytvořen', s.format.dateTime(mail.created_at)],
    ['Naplánován', s.format.dateTime(mail.run_at)],
    ['Odeslán', mail.sent_at ? s.format.dateTime(mail.sent_at) : html`<span class="badge badge--warning">ve frontě</span>`],
    ['Pokusů', String(mail.attempts)],
    mail.error ? ['Chyba', html`<code>${mail.error}</code>`] : null,
    payload && payload.reservationId ? ['Rezervace', html`<a class="mono" href="/admin/rezervace/${payload.reservationId}">${payload.number || payload.reservationId}</a>`] : null,
    payload && payload.documentNumber ? ['Doklad', html`<a class="mono" href="/admin/doklady/${encodeURIComponent(payload.documentNumber)}">${payload.documentNumber}</a>`] : null,
    ['Adresát', html`<span class="muted">skryt (HMAC ${String(mail.to_hmac || '').slice(0, 12)}…)</span>`],
  ].filter(Boolean);
  return html`
<div class="admin-grid admin-grid--head">
  ${s.card({ compact: true, children: c.summary(meta) })}
  ${s.card({ title: 'Textová verze', children: html`<pre class="admin-pre">${mail.body_text}</pre>` })}
</div>
${mail.body_html
    ? s.card({
        title: 'HTML náhled (sandbox)',
        children: html`<iframe class="admin-mail-frame" title="Náhled e-mailu" sandbox=""${attr({ srcdoc: mail.body_html })}></iframe>
        <details class="admin-details"><summary>Zdrojový HTML kód</summary><pre class="admin-pre">${mail.body_html}</pre></details>`,
      })
    : ''}`;
}

module.exports = { list, detail };
