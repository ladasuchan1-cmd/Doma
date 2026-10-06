'use strict';
// Admin → Rezervace (SPEC kap. 13): seznam s filtry a hledáním podle čísla; detail s položkami, zákazníkem
// (dešifrovaná pole – jen zde, přístup auditován ve feature), ledgerem, platbami, doklady, e-maily a akcemi podle stavu:
// Potvrdit platbu · Přiřadit kola · Zapsat doklad · Kauce · Doplatek · Vydat · Vrátit · Uzavřít · Stornovat · Nevyzvednuto.
// Vstup: data z features/admin.js. Výstup: Html. Formuláře fungují bez JS; JS přidává potvrzovací dialogy.

const s = require('./shared');
const { html, c, format } = s;
const { STATUS_LABELS } = require('../../../domain/reservations');
const cancellation = require('../../../domain/cancellation');

const STATUS_GROUPS = Object.freeze([
  ['', 'Všechny'],
  ['aktivni', 'Aktivní (čeká / potvrzené / vydané / vrácené)'],
  ['awaiting_fee', STATUS_LABELS.awaiting_fee],
  ['confirmed', STATUS_LABELS.confirmed],
  ['checked_out', STATUS_LABELS.checked_out],
  ['returned', STATUS_LABELS.returned],
  ['closed', STATUS_LABELS.closed],
  ['cancelled', 'Zrušené / propadlé / nevyzvednuté'],
]);

// ---------------------------------------------------------------------------------------------------------
// Seznam

function list({ rows, filters, total, page, pages, href }) {
  return html`
${s.card({
    compact: true,
    children: c.form({
      action: '/admin/rezervace',
      method: 'get',
      attrs: { class: 'form form--filters' },
      children: html`
        ${c.field({ label: 'Hledat číslo', name: 'q', type: 'search', value: filters.q, placeholder: 'např. 2610000012', inputmode: 'numeric' })}
        ${c.field({ label: 'Stav', name: 'stav', type: 'select', value: filters.stav, options: STATUS_GROUPS.map(([value, label]) => ({ value, label })) })}
        ${c.field({ label: 'Termín od', name: 'od', type: 'date', value: filters.od })}
        ${c.field({ label: 'Termín do', name: 'do', type: 'date', value: filters.do })}
        <div class="form__actions form__actions--inline">${c.button({ label: 'Filtrovat', type: 'submit', variant: 'secondary' })} <a class="btn btn--ghost" href="/admin/rezervace">Zrušit filtr</a></div>`,
    }),
  })}
${s.card({
    title: `Rezervace (${total})`,
    children: html`${s.table({
      id: 'rezervace',
      filter: true,
      head: ['Číslo', { label: 'Od', sort: 'text' }, 'Do', 'Kola', 'Stav', { label: 'Cena', align: 'right', sort: 'num' }, { label: 'Zaplaceno', align: 'right', sort: 'num' }, 'Vytvořeno'],
      rows: rows.map((r) => [s.reservationLink(r), s.dt(r.from_at), s.dt(r.to_at), s.itemsSummary(r.items), s.statusBadge(r.status), s.money(r.total_minor), s.money(r.paid_minor), s.date(r.created_at)]),
      empty: 'Žádná rezervace neodpovídá filtru.',
    })}
    ${s.pager({ page, pages, href })}`,
  })}`;
}

// ---------------------------------------------------------------------------------------------------------
// Detail

function kcInput(name, label, valueMinor, opts = {}) {
  return s.moneyField({ label, name, valueMinor, ...opts });
}

function customerCard(d) {
  const cst = d.customer;
  if (!cst) return s.card({ title: 'Zákazník', children: html`<p class="muted">Rezervace nemá přiřazeného zákazníka.</p>` });
  if (cst.anonymized) return s.card({ title: 'Zákazník', children: c.notice('Údaje zákazníka byly anonymizovány.', 'info') });
  const doc = cst.idDocType
    ? html`${cst.idDocType}, č. <span class="mono">${cst.idDocMasked}</span><br><small class="muted">souhlas ${format.dateTime(cst.idDocConsentAt)}, výmaz po ${format.date(cst.idDocDeleteAfter)}</small>`
    : html`<span class="badge badge--warning">nezapsán</span> <small class="muted">povinné před výdejem</small>`;
  return s.card({
    title: 'Zákazník',
    actions: html`<a class="btn btn--ghost btn--sm" href="/admin/zakaznici/${cst.id}">Karta zákazníka</a>`,
    children: html`${c.summary([
      ['Jméno', cst.name],
      ['E-mail', html`<a href="mailto:${cst.email}">${cst.email}</a>`],
      ['Telefon', cst.phone ? html`<a href="tel:${String(cst.phone).replace(/\s+/g, '')}">${cst.phone}</a>` : '–'],
      ['Doklad totožnosti', doc],
      ['Souhlas s OP', html`verze ${d.r.terms_version || '–'}, ${format.dateTime(d.r.consent_at)}`],
      ['Poučení o dokladu', format.dateTime(d.r.id_doc_ack_at)],
    ])}
    <p class="muted small">Zobrazení osobních údajů se zapisuje do auditu.</p>`,
  });
}

function itemsCard(d) {
  const rows = d.detail.itemRows.map((row) => {
    const bike = row.bike_id ? d.bikesById[row.bike_id] : null;
    return [html`${row.type_name}`, row.size, s.money(row.unit_price_minor), s.money(row.fee_minor), bike ? html`<span class="mono">${bike.inventory_code}</span> ${s.bikeBadge(bike.status)}` : html`<span class="muted">nepřiřazeno</span>`];
  });
  return s.card({
    title: 'Položky',
    children: html`${s.table({ head: ['Typ', 'Velikost', { label: 'Nájemné', align: 'right' }, { label: 'Poplatek', align: 'right' }, 'Kus'], rows, sortable: false })}
    ${d.detail.accessories.length ? html`<p class="small"><strong>Příslušenství:</strong> ${d.detail.accessories.map((a, i) => html`${i ? ', ' : ''}${a.qty}× ${a.label} (${format.money(a.amountMinor)})`)}</p>` : ''}
    ${c.summary([
      ['Nájemné celkem', format.money(d.r.total_minor)],
      ['Rezervační poplatek', format.money(d.r.fee_minor)],
      ['Zaplaceno (ledger)', format.money(d.balance.paidMinor)],
      ['Kauce', html`${format.money(d.r.deposit_minor)}${d.r.deposit_method ? html` <small class="muted">(${s.METHOD_LABELS[d.r.deposit_method] || d.r.deposit_method})</small>` : ''}`],
      d.balance.damageMinor ? ['Poškození', format.money(d.balance.damageMinor)] : null,
      { label: 'Zbývá uhradit', value: format.money(d.balance.dueMinor), strong: true },
    ].filter(Boolean))}`,
  });
}

function paymentsCard(d) {
  return s.card({
    id: 'platby',
    title: 'Platby',
    children: s.table({
      head: ['Účel', 'Forma', 'Poskytovatel', { label: 'Částka', align: 'right' }, { label: 'Strženo/přijato', align: 'right' }, 'Stav', 'Čas'],
      rows: d.detail.payments.map((p) => [s.PURPOSE_LABELS[p.purpose] || p.purpose, s.METHOD_LABELS[p.method] || p.method, html`<span class="mono">${p.provider}${p.provider_ref ? html` · ${p.provider_ref}` : ''}</span>`, s.money(p.amount_minor), s.money(p.captured_minor), s.paymentBadge(p.status), s.dt(p.updated_at)]),
      empty: 'Zatím žádná platba.',
      sortable: false,
    }),
  });
}

function ledgerCard(d) {
  return s.card({
    title: 'Ledger (pohyby peněz)',
    children: s.table({
      head: ['Čas', 'Pohyb', { label: 'Částka', align: 'right' }, 'Poznámka'],
      rows: d.detail.ledger.map((l) => [s.dt(l.created_at), s.LEDGER_LABELS[l.type] || l.type, s.money(l.amount_minor), l.note || '']),
      empty: 'Zatím žádný pohyb.',
      sortable: false,
    }),
  });
}

function documentsCard(d) {
  return s.card({
    title: 'Doklady a protokoly',
    children: s.table({
      head: ['Číslo', 'Typ', 'Vystaveno', { label: '', sort: false }],
      rows: d.detail.documents.map((doc) => [html`<span class="mono">${doc.number}</span>`, s.DOC_LABELS[doc.type] || doc.type, s.dt(doc.issued_at), html`<a class="btn btn--ghost btn--sm" href="/admin/doklady/${encodeURIComponent(doc.number)}" target="_blank" rel="noopener">Zobrazit / tisk</a>`]),
      empty: d.modules.documents ? 'Zatím žádný doklad.' : 'Modul dokladů (domain/documents.js) zatím není k dispozici – smlouva se při výdeji vyrenderuje ze šablony pravni.',
      sortable: false,
    }),
  });
}

function mailsCard(d) {
  return s.card({
    title: 'E-maily',
    children: s.table({
      head: ['Vytvořen', 'Typ', 'Předmět', 'Stav'],
      rows: d.detail.mails.map((m) => [s.dt(m.created_at), s.MAIL_LABELS[m.type] || m.type, html`<a href="/admin/emaily/${m.id}">${m.subject}</a>`, m.sent_at ? c.badge('odesláno', 'success') : c.badge('ve frontě', 'warning')]),
      empty: 'Žádný e-mail.',
      sortable: false,
    }),
  });
}

function handoversCard(d) {
  if (!d.handovers.length) return '';
  return s.card({
    title: 'Předání a vrácení',
    children: s.table({
      head: ['Čas', 'Typ', 'Obsluha', { label: 'Poškození', align: 'right' }, 'Poznámka'],
      rows: d.handovers.map((h) => [s.dt(h.at), h.type === 'pickup' ? 'Výdej' : 'Vrácení', h.by_name || '–', s.money(h.damage_minor), h.note || '']),
      sortable: false,
    }),
  });
}

/** Výběr kusů pro položky (select volných kol bez kolize). */
function bikeSelects(d, { required }) {
  return d.detail.itemRows.map((row) => {
    const options = [{ value: '', label: required ? '– vyberte kus –' : '– nepřiřazeno –' }, ...(d.candidates[row.id] || []).map((b) => ({ value: b.id, label: `${b.inventory_code} (${b.size}${b.note ? `, ${b.note}` : ''})` }))];
    if (row.bike_id && !(d.candidates[row.id] || []).some((b) => b.id === row.bike_id)) {
      const b = d.bikesById[row.bike_id];
      if (b) options.push({ value: b.id, label: `${b.inventory_code} (přiřazeno)` });
    }
    return c.field({ label: `${row.type_name} – ${row.size}`, name: `item_${row.id}`, type: 'select', value: row.bike_id || '', options, required: !!required });
  });
}

function actionsForm(d, { title, action, children, submit, variant = 'primary', confirm, hint, tone }) {
  return s.card({ title, tone, compact: true, children: html`${hint ? html`<p class="small muted">${hint}</p>` : ''}${s.form({ action, csrf: d.csrf, children, submit, submitVariant: variant, confirm })}` });
}

function actions(d) {
  const { r } = d;
  const base = `/admin/rezervace/${r.id}`;
  const out = [];
  const st = r.status;
  const cash = [
    { value: 'cash', label: 'Hotově' },
    { value: 'terminal', label: 'Platební terminál' },
  ];

  if (st === 'awaiting_fee') {
    out.push(
      actionsForm(d, {
        title: 'Potvrdit zaplacení poplatku',
        action: `${base}/potvrdit-platbu`,
        hint: 'Poplatek přijatý mimo online bránu (hotově, terminálem nebo převod zapsaný ručně). Příchozí převody se párují automaticky podle VS na stránce Platby.',
        children: html`${c.field({ label: 'Forma úhrady', name: 'metoda', type: 'select', value: 'cash', options: [...cash, { value: 'bank_transfer', label: 'Převod (ručně ověřeno ve výpisu)' }] })}${kcInput('castka', 'Částka (Kč)', r.fee_minor, { required: true })}`,
        submit: 'Zapsat platbu a potvrdit rezervaci',
      })
    );
  }

  if (st === 'confirmed') {
    out.push(
      actionsForm(d, {
        title: 'Přiřadit kola',
        action: `${base}/kola`,
        hint: `Nabízí se jen volné kusy daného typu a velikosti bez kolize s jinou rezervací (včetně bufferu ${d.settings.bufferMinutes ?? 60} min).`,
        children: html`<div class="admin-grid admin-grid--2">${bikeSelects(d, { required: false })}</div>`,
        submit: 'Uložit přiřazení',
        variant: 'secondary',
      })
    );
    if (d.customer && !d.customer.anonymized) {
      out.push(
        actionsForm(d, {
          title: d.customer.idDocType ? 'Doklad totožnosti (přepsat)' : 'Zapsat doklad totožnosti',
          action: `${base}/doklad`,
          hint: 'Podmínka nájmu (OP čl. 8): typ a číslo dokladu, souhlas dává zákazník předložením a podpisem protokolu. Číslo se ukládá šifrované a maže se po uplynutí retence.',
          tone: d.customer.idDocType ? null : 'warning',
          children: html`<div class="admin-grid admin-grid--2">${c.field({ label: 'Typ dokladu', name: 'typ', type: 'select', value: 'op', options: Object.entries(s.ID_DOC_TYPES).map(([value, label]) => ({ value, label })) })}${c.field({ label: 'Číslo dokladu', name: 'cislo', type: 'text', value: '', required: true, autocomplete: 'off', maxlength: 20, hint: 'Ověřte platnost v databázi neplatných dokladů MV ČR.' })}</div>
          ${c.field({ label: 'Zákazník doklad předložil a souhlasí se zápisem typu a čísla', name: 'souhlas', type: 'checkbox', required: true })}`,
          submit: 'Zapsat doklad',
          variant: 'secondary',
        })
      );
    }
  }

  if ((st === 'confirmed' || st === 'checked_out') && !d.hold) {
    out.push(
      actionsForm(d, {
        title: 'Kauce',
        action: `${base}/kauce`,
        hint: d.modules.provider ? 'Preautorizace kartou otevře simulační bránu; po jejím potvrzení je kauce blokována (uvolní se nebo strhne při uzavření).' : 'Modul plateb zatím není k dispozici – preautorizaci kartou nelze založit, kauci lze zapsat hotově nebo terminálem.',
        children: html`<div class="admin-grid admin-grid--2">${c.field({ label: 'Forma kauce', name: 'metoda', type: 'select', value: 'cash', options: [...cash, { value: 'card', label: 'Preautorizace kartou (simulační brána)', disabled: !d.modules.provider }] })}${kcInput('castka', 'Výše kauce (Kč)', r.deposit_minor, { required: true })}</div>`,
        submit: 'Zapsat kauci',
        variant: 'secondary',
      })
    );
  }

  if (['confirmed', 'checked_out', 'returned'].includes(st) && d.balance.dueMinor > 0) {
    out.push(
      actionsForm(d, {
        title: 'Doplatek nájemného',
        action: `${base}/doplatek`,
        hint: html`Zbývá uhradit ${format.money(d.balance.dueMinor)}. Hotově / terminál se zapíše ihned; karta otevře simulační bránu, převod vygeneruje QR s VS ${r.number}.${d.modules.provider ? '' : ' (Karta a převod vyžadují modul plateb.)'}`,
        children: html`<div class="admin-grid admin-grid--2">${c.field({ label: 'Forma', name: 'metoda', type: 'select', value: 'terminal', options: [...cash, { value: 'card', label: 'Karta (simulační brána)', disabled: !d.modules.provider }, { value: 'bank_transfer', label: 'Převod / QR', disabled: !d.modules.provider }] })}${kcInput('castka', 'Částka (Kč)', d.balance.dueMinor, { required: true })}</div>`,
        submit: 'Zapsat doplatek',
        variant: 'secondary',
      })
    );
  }

  if (st === 'confirmed') {
    const missing = [];
    if (!d.customer || !d.customer.idDocType) missing.push('zápis dokladu totožnosti');
    if (d.detail.itemRows.some((row) => !row.bike_id)) missing.push('přiřazení všech kusů');
    out.push(
      actionsForm(d, {
        title: 'Vydat kola',
        tone: 'primary',
        action: `${base}/vydat`,
        hint: html`Přechod do stavu „Vydaná“: zapíše kauci (${d.hold ? html`složena ${format.money(d.hold.amount_minor)} – ${s.METHOD_LABELS[d.hold.method]}` : 'zvolte formu níže'}), doplatek a vystaví smlouvu s předávacím protokolem k tisku.${missing.length ? html` <strong>Chybí: ${missing.join(' a ')}.</strong>` : ''}`,
        children: html`${d.detail.itemRows.some((row) => !row.bike_id) ? html`<div class="admin-grid admin-grid--2">${bikeSelects(d, { required: true })}</div>` : ''}
        ${!d.hold ? html`<div class="admin-grid admin-grid--2">${c.field({ label: 'Kauce složena', name: 'kauce_metoda', type: 'select', value: 'cash', options: cash })}${kcInput('kauce_castka', 'Výše kauce (Kč)', r.deposit_minor, { required: true })}</div>` : ''}
        ${d.balance.dueMinor > 0 ? html`<div class="admin-grid admin-grid--2">${c.field({ label: 'Doplatek při převzetí', name: 'doplatek_metoda', type: 'select', value: 'terminal', options: [{ value: '', label: 'Nezapisovat (doplatí při vrácení)' }, ...cash] })}${kcInput('doplatek_castka', 'Částka doplatku (Kč)', d.balance.dueMinor)}</div>` : ''}
        ${c.field({ label: 'Poznámka k předání (stav kol, baterie, příslušenství)', name: 'poznamka', type: 'textarea', rows: 2 })}
        ${c.field({ label: 'Zákazník předložil doklad, převzal kola a podepsal předávací protokol', name: 'potvrzeni', type: 'checkbox', required: true })}`,
        submit: 'Vydat kola a vystavit smlouvu',
        confirm: 'Opravdu vydat kola? Rezervace přejde do stavu Vydaná a vystaví se smlouva.',
      })
    );
  }

  if (st === 'checked_out') {
    out.push(
      actionsForm(d, {
        title: 'Vrátit kola',
        tone: 'primary',
        action: `${base}/vratit`,
        hint: 'Přechod do stavu „Vrácená“: zapíše stav kol a případné poškození; kauce se vypořádá při uzavření.',
        children: html`<div class="admin-grid admin-grid--2">${c.field({ label: 'Stav kol', name: 'stav', type: 'select', value: 'ok', options: [{ value: 'ok', label: 'V pořádku' }, { value: 'poskozeno', label: 'Poškozeno' }, { value: 'spinave', label: 'Znečištěno (čištění)' }, { value: 'chybi', label: 'Chybí příslušenství' }] })}${kcInput('poskozeni', 'Poškození / náhrada (Kč)', 0)}</div>
        ${c.field({ label: 'Poznámka k vrácení', name: 'poznamka', type: 'textarea', rows: 2 })}
        ${c.field({ label: 'Odstavit vrácená kola do servisu', name: 'servis', type: 'checkbox' })}`,
        submit: 'Zapsat vrácení',
        confirm: 'Zapsat vrácení kol?',
      })
    );
  }

  if (st === 'returned') {
    const maxCapture = d.hold ? d.hold.amount_minor : r.deposit_minor;
    out.push(
      actionsForm(d, {
        title: 'Uzavřít rezervaci',
        tone: 'primary',
        action: `${base}/uzavrit`,
        hint: html`Vypořádání kauce ${format.money(maxCapture)} (${d.hold ? s.METHOD_LABELS[d.hold.method] : 'bez záznamu platby'}) a konečný doklad.${d.balance.damageMinor ? html` Evidované poškození: <strong>${format.money(d.balance.damageMinor)}</strong>.` : ''}`,
        children: html`<div class="admin-grid admin-grid--2">${c.field({ label: 'Kauce', name: 'kauce_akce', type: 'select', value: d.balance.damageMinor > 0 ? 'strhnout' : 'uvolnit', options: [{ value: 'uvolnit', label: 'Uvolnit celou' }, { value: 'strhnout', label: 'Strhnout část / celou' }] })}${kcInput('strhnout_castka', 'Strhnout (Kč)', Math.min(maxCapture, d.balance.damageMinor || 0))}</div>
        ${d.balance.dueMinor > 0 ? html`<div class="admin-grid admin-grid--2">${c.field({ label: 'Zbývající doplatek', name: 'doplatek_metoda', type: 'select', value: 'terminal', options: [{ value: '', label: 'Neuhrazen (vyúčtovat zvlášť)' }, ...cash] })}${kcInput('doplatek_castka', 'Částka (Kč)', d.balance.dueMinor)}</div>` : ''}
        ${c.field({ label: 'Poznámka k vyúčtování', name: 'poznamka', type: 'textarea', rows: 2 })}`,
        submit: 'Uzavřít a vystavit konečný doklad',
        confirm: 'Uzavřít rezervaci a vypořádat kauci?',
      })
    );
  }

  if (st === 'awaiting_fee' || st === 'confirmed') {
    const q = d.operatorQuote;
    const cq = d.customerQuote;
    out.push(
      actionsForm(d, {
        title: 'Stornovat rezervaci (ze strany půjčovny)',
        tone: 'danger',
        action: `${base}/storno`,
        hint: html`${cancellation.describe(q)}${cq ? html` <small class="muted">(Pokud by rušil zákazník: ${cancellation.describe(cq)})</small>` : ''}`,
        children: c.field({ label: 'Důvod storna (uvede se v e-mailu zákazníkovi)', name: 'duvod', type: 'text', required: true, maxlength: 300 }),
        submit: 'Stornovat a vrátit poplatek',
        variant: 'danger',
        confirm: 'Opravdu stornovat rezervaci? Zákazníkovi se vrátí celý zaplacený poplatek.',
      })
    );
  }

  if (st === 'confirmed' && new Date(r.from_at).getTime() < d.now.getTime()) {
    out.push(
      actionsForm(d, {
        title: 'Označit jako nevyzvednutou',
        tone: 'danger',
        action: `${base}/no-show`,
        hint: 'Zákazník se nedostavil – poplatek propadá (OP čl. 6). Automaticky se tak stane po konci termínu.',
        children: '',
        submit: 'Nevyzvednuto',
        variant: 'danger',
        confirm: 'Označit rezervaci jako nevyzvednutou? Poplatek propadne.',
      })
    );
  }
  return out;
}

function detail(d) {
  const { r } = d;
  return html`
<div class="admin-grid admin-grid--head">
  ${s.card({
    compact: true,
    children: c.summary([
      ['Stav', html`${s.statusBadge(r.status)} <small class="muted">verze ${r.version}</small>`],
      ['Termín', html`${format.dateTime(r.from_at)} – ${format.dateTime(r.to_at)} <small class="muted">(${format.plural(d.days, 'den', 'dny', 'dní')})</small>`],
      ['Vytvořeno', format.dateTime(r.created_at)],
      r.expires_at ? ['Vyprší', format.dateTime(r.expires_at)] : null,
      r.note ? ['Poznámky', html`<span class="pre">${r.note}</span>`] : null,
    ].filter(Boolean)),
  })}
  ${customerCard(d)}
</div>
${d.actionList.length ? html`<h2 class="admin-section-title">Akce</h2><div class="admin-grid admin-grid--2 admin-actions">${d.actionList}</div>` : ''}
<div class="admin-grid admin-grid--2">
  ${itemsCard(d)}
  ${paymentsCard(d)}
  ${ledgerCard(d)}
  ${documentsCard(d)}
  ${handoversCard(d)}
  ${mailsCard(d)}
</div>`;
}

module.exports = { list, detail, actions, STATUS_GROUPS };
