'use strict';
// Admin → Zákazníci (SPEC kap. 13): hledání podle e-mailu (HMAC – bez dešifrování celé tabulky), karta zákazníka
// s dešifrovanými údaji (přístup auditován), export JSON, anonymizace, výmaz dokladu. Vstup: data z admin.js. Výstup: Html.

const s = require('./shared');
const { html, c, format } = s;

function list({ rows, email, recent, csrf }) {
  const table = (items, empty) =>
    s.table({
      head: ['ID', 'Vytvořen', { label: 'Rezervací', align: 'right', sort: 'num' }, 'Doklad', 'Marketing', 'Stav', { label: '', sort: false }],
      rows: items.map((cst) => [
        String(cst.id),
        s.dt(cst.created_at),
        String(cst.reservations),
        cst.id_doc_type ? html`${cst.id_doc_type} <small class="muted">(výmaz po ${format.date(cst.id_doc_delete_after)})</small>` : html`<span class="muted">–</span>`,
        cst.marketing_consent_at ? c.badge('souhlas', 'success') : html`<span class="muted">ne</span>`,
        cst.anonymized_at ? c.badge('anonymizován', 'neutral') : c.badge('aktivní', 'success'),
        html`<a class="btn btn--ghost btn--sm" href="/admin/zakaznici/${cst.id}">Karta</a>`,
      ]),
      empty,
      sortable: false,
    });
  return html`
${s.card({
    title: 'Hledat zákazníka',
    children: c.form({
      action: '/admin/zakaznici',
      method: 'get',
      attrs: { class: 'form form--filters' },
      children: html`${c.field({ label: 'E-mail (přesná shoda)', name: 'email', type: 'email', value: email || '', required: true, hint: 'Hledá se podle HMAC otisku – údaje v databázi jsou šifrované, fulltext není možný.' })}<div class="form__actions form__actions--inline">${c.button({ label: 'Hledat', type: 'submit', variant: 'secondary' })}</div>`,
    }),
  })}
${email ? s.card({ title: `Výsledek pro ${email}`, children: table(rows, 'Zákazník s tímto e-mailem nebyl nalezen.') }) : ''}
${s.card({ title: 'Naposledy přidaní zákazníci', children: html`<p class="small muted">Jména a e-maily se zobrazují až na kartě zákazníka (každé zobrazení se audituje).</p>${table(recent, 'Zatím žádný zákazník.')}` })}
${csrf ? '' : ''}`;
}

function detail({ customer: cst, reservations, csrf, activeReservations }) {
  const doc = cst.anonymized
    ? '–'
    : cst.idDocType
      ? html`${cst.idDocType}, č. <span class="mono">${cst.idDocMasked}</span><br><small class="muted">souhlas ${format.dateTime(cst.idDocConsentAt)} · výmaz po ${format.date(cst.idDocDeleteAfter)}</small>`
      : html`<span class="muted">nezapsán</span>`;
  return html`
<div class="admin-grid admin-grid--head">
${s.card({
    title: 'Údaje',
    actions: cst.anonymized ? '' : html`<a class="btn btn--ghost btn--sm" href="/admin/zakaznici/${cst.id}/export.json">Export JSON</a>`,
    children: cst.anonymized
      ? c.notice(`Zákazník byl anonymizován ${format.dateTime(cst.anonymizedAt)}. Rezervace zůstávají pro účetní evidenci bez osobních údajů.`, 'info')
      : c.summary([
          ['Jméno', cst.name],
          ['E-mail', cst.email],
          ['Telefon', cst.phone || '–'],
          ['Adresa', cst.address || '–'],
          ['Doklad totožnosti', doc],
          ['Obchodní sdělení', cst.marketingConsentAt ? `souhlas ${format.dateTime(cst.marketingConsentAt)}` : 'bez souhlasu'],
          ['Vytvořen', format.dateTime(cst.createdAt)],
        ]),
  })}
${cst.anonymized
    ? ''
    : s.card({
        title: 'Práva subjektu údajů',
        tone: 'danger',
        children: html`<p class="small">Anonymizace nahradí jméno, e-mail, telefon, adresu i doklad; rezervace a doklady zůstanou bez vazby na osobu. Lze jen bez aktivní rezervace${activeReservations ? html` – <strong>zákazník má ${format.plural(activeReservations, 'aktivní rezervaci', 'aktivní rezervace', 'aktivních rezervací')}</strong>` : ''}.</p>
      <div class="admin-card__actions">
        ${cst.idDocType ? s.actionButton({ action: `/admin/zakaznici/${cst.id}/doklad-smazat`, csrf, label: 'Smazat číslo dokladu', variant: 'secondary', confirm: 'Smazat zapsaný doklad totožnosti?' }) : ''}
        ${s.actionButton({ action: `/admin/zakaznici/${cst.id}/anonymizovat`, csrf, label: 'Anonymizovat zákazníka', variant: 'danger', confirm: 'Opravdu nevratně anonymizovat osobní údaje zákazníka?' })}
      </div>`,
      })}
</div>
${s.card({
    title: `Rezervace (${reservations.length})`,
    children: s.table({
      head: ['Číslo', 'Od', 'Do', 'Stav', { label: 'Cena', align: 'right', sort: 'num' }, { label: 'Zaplaceno', align: 'right', sort: 'num' }],
      rows: reservations.map((r) => [s.reservationLink(r), s.dt(r.from_at), s.dt(r.to_at), s.statusBadge(r.status), s.money(r.total_minor), s.money(r.paid_minor)]),
      empty: 'Žádná rezervace.',
    }),
  })}`;
}

module.exports = { list, detail };
