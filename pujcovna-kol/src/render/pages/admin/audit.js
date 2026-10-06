'use strict';
// Admin → Audit (SPEC kap. 13): záznamy audit_log s filtrem akce / entity, stránkování. Vstup: data z admin.js. Výstup: Html.

const s = require('./shared');
const { html, c } = s;

function entityLink(row) {
  if (!row.entity_id) return html`<span class="muted">–</span>`;
  if (row.entity === 'reservation') return html`<a class="mono" href="/admin/rezervace/${row.entity_id}">${row.entity} #${row.entity_id}</a>`;
  if (row.entity === 'customer') return html`<a class="mono" href="/admin/zakaznici/${row.entity_id}">${row.entity} #${row.entity_id}</a>`;
  return html`<span class="mono">${row.entity || ''} #${row.entity_id}</span>`;
}

function audit({ rows, filters, actions, page, pages, href, total }) {
  return html`
${s.card({
    compact: true,
    children: c.form({
      action: '/admin/audit',
      method: 'get',
      attrs: { class: 'form form--filters' },
      children: html`${c.field({ label: 'Akce', name: 'akce', type: 'select', value: filters.akce, options: [{ value: '', label: 'Vše' }, ...actions.map((a) => ({ value: a, label: a }))] })}${c.field({ label: 'Entita a ID (např. reservation 12)', name: 'entita', value: filters.entita })}${c.field({ label: 'Od', name: 'od', type: 'date', value: filters.od })}<div class="form__actions form__actions--inline">${c.button({ label: 'Filtrovat', type: 'submit', variant: 'secondary' })} <a class="btn btn--ghost" href="/admin/audit">Zrušit</a></div>`,
    }),
  })}
${s.card({
    title: `Audit (${total})`,
    children: html`${s.table({
      id: 'audit',
      head: ['Čas', 'Uživatel', 'Akce', 'Entita', 'Detail'],
      rows: rows.map((r) => [s.dt(r.at), r.user_email || html`<span class="muted">systém / anonym</span>`, html`<span class="mono">${r.action}</span>`, entityLink(r), r.meta ? html`<details class="admin-details admin-details--inline"><summary>meta</summary><pre class="admin-pre">${r.metaPretty}</pre></details>` : '']),
      empty: 'Žádný záznam.',
      sortable: false,
    })}
    ${s.pager({ page, pages, href })}`,
  })}`;
}

module.exports = { audit };
