'use strict';
// Admin → Kola (SPEC kap. 13): typy a kusy (CRUD), stav kusu, fotky z public/img/demo/kola, QR štítky k tisku
// s inventory_code (SVG z src/vendor/qrcode.js – generuje feature). Vstup: data z features/admin.js. Výstup: Html.

const s = require('./shared');
const { html, raw, c, format } = s;

const CATEGORIES = Object.entries(s.CATEGORY_LABELS).map(([value, label]) => ({ value, label }));
const BIKE_STATUSES = Object.entries(s.BIKE_STATUS).map(([value, [label]]) => ({ value, label }));

function list({ types, bikes, csrf }) {
  return html`
${s.card({
    title: 'Typy kol',
    actions: html`<a class="btn btn--primary btn--sm" href="/admin/kola/typ/novy">Nový typ</a> <a class="btn btn--ghost btn--sm" href="/admin/kola/stitky" target="_blank" rel="noopener">QR štítky všech kol</a>`,
    children: s.table({
      id: 'typy',
      head: ['Název', 'Kategorie', 'Velikosti', { label: 'Kusů', align: 'right', sort: 'num' }, { label: 'Kauce', align: 'right', sort: 'num' }, { label: 'Poplatek', align: 'right', sort: 'num' }, { label: 'Od Kč/den', align: 'right', sort: 'num' }, 'Aktivní', { label: '', sort: false }],
      rows: types.map((t) => [html`<a href="/admin/kola/typ/${t.id}">${t.name}</a><br><small class="muted mono">${t.slug}</small>`, s.CATEGORY_LABELS[t.category] || t.category, t.sizes.join(', '), t.bikeCount, s.money(t.deposit_minor), s.money(t.fee_minor), t.fromPrice !== null ? s.money(t.fromPrice) : '–', t.active ? c.badge('ano', 'success') : c.badge('ne', 'neutral'), html`<a class="btn btn--ghost btn--sm" href="/admin/kola/kus/novy?typ=${t.id}">+ kus</a> <a class="btn btn--ghost btn--sm" href="/admin/kola/stitky?typ=${t.id}" target="_blank" rel="noopener">štítky</a>`]),
      empty: 'Zatím žádný typ kola.',
    }),
  })}
${s.card({
    title: `Kusy (${bikes.length})`,
    actions: html`<a class="btn btn--secondary btn--sm" href="/admin/kola/kus/novy">Nový kus</a>`,
    children: s.table({
      id: 'kusy',
      filter: true,
      head: ['Kód', 'Typ', 'Velikost', 'Stav', 'Poznámka', { label: 'Rychlá změna stavu', sort: false }],
      rows: bikes.map((b) => [
        html`<a class="mono" href="/admin/kola/kus/${b.id}">${b.inventory_code}</a>`,
        b.type_name,
        b.size,
        s.bikeBadge(b.status),
        b.note || '',
        html`<form class="form form--inline" method="post" action="/admin/kola/kus/${b.id}/stav"><input type="hidden" name="_csrf" value="${csrf}"><label class="visually-hidden" for="st-${b.id}">Stav kusu ${b.inventory_code}</label><select class="field__input field__input--select field__input--sm" id="st-${b.id}" name="status" data-autosubmit>${BIKE_STATUSES.map((o) => html`<option value="${o.value}"${o.value === b.status ? raw(' selected') : ''}>${o.label}</option>`)}</select>${c.button({ label: 'Uložit', type: 'submit', variant: 'ghost', size: 'sm', attrs: { 'data-autosubmit-hide': true } })}</form>`,
      ]),
      empty: 'Zatím žádný kus.',
    }),
  })}`;
}

/** Formulář typu kola. type = null pro nový. */
function typeForm({ type, photosAvailable, csrf, errors = {} }) {
  const t = type || { sizes: [], photos: [], specs: {}, active: 1, sort: 0, category: 'trek' };
  const selected = new Set((t.photos || []).map((p) => (typeof p === 'string' ? p : p.src)));
  const specsText = Object.entries(t.specs || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return s.card({
    title: type ? `Typ kola: ${type.name}` : 'Nový typ kola',
    actions: type ? html`<a class="btn btn--ghost btn--sm" href="/admin/kola/kus/novy?typ=${type.id}">Přidat kus</a> <a class="btn btn--ghost btn--sm" href="/admin/cenik#typ-${type.id}">Ceník typu</a>` : '',
    children: s.form({
      action: type ? `/admin/kola/typ/${type.id}` : '/admin/kola/typ',
      csrf,
      children: html`
        ${Object.keys(errors).length ? c.notice('Zkontrolujte označená pole.', 'danger') : ''}
        <div class="admin-grid admin-grid--2">
          ${c.field({ label: 'Název', name: 'name', value: t.name || '', required: true, maxlength: 120, error: errors.name })}
          ${c.field({ label: 'Slug (URL)', name: 'slug', value: t.slug || '', hint: 'Prázdné = odvodí se z názvu.', pattern: '[a-z0-9-]*', error: errors.slug })}
          ${c.field({ label: 'Kategorie', name: 'category', type: 'select', value: t.category, options: CATEGORIES })}
          ${c.field({ label: 'Velikosti (oddělené čárkou)', name: 'sizes', value: (t.sizes || []).join(', '), required: true, hint: 'např. S, M, L, XL nebo 20", 24"', error: errors.sizes })}
          ${s.moneyField({ label: 'Kauce za kus (Kč)', name: 'deposit', valueMinor: t.deposit_minor ?? 500000, required: true })}
          ${s.moneyField({ label: 'Rezervační poplatek za kus (Kč)', name: 'fee', valueMinor: t.fee_minor ?? 30000, required: true })}
          ${s.moneyField({ label: 'Hodnota kola (Kč, pro smlouvu)', name: 'value', valueMinor: t.value_minor ?? 2500000, required: true })}
          ${c.field({ label: 'Pořadí', name: 'sort', type: 'number', value: t.sort ?? 0, min: 0, step: 1 })}
        </div>
        ${c.field({ label: 'Popis', name: 'description', type: 'textarea', value: t.description || '', rows: 3 })}
        ${c.field({ label: 'Specifikace (jeden řádek = „Klíč: hodnota“)', name: 'specs', type: 'textarea', value: specsText, rows: 5 })}
        <fieldset class="field admin-photos"><legend class="field__label">Fotky (public/img/demo/kola, CC BY – viz ATTRIBUTION.md)</legend>
          <div class="admin-photos__grid">${photosAvailable.map((f) => html`<label class="admin-photos__item"><input type="checkbox" name="photos" value="${f.src}"${selected.has(f.src) ? raw(' checked') : ''}><img src="${f.src}" alt="${f.alt || f.file}" loading="lazy" width="160" height="120"><span class="mono small">${f.file}</span></label>`)}</div>
        </fieldset>
        ${c.field({ label: 'Aktivní (nabízí se v katalogu a rezervaci)', name: 'active', type: 'checkbox', checked: !!Number(t.active) })}`,
      submit: type ? 'Uložit typ' : 'Založit typ',
    }),
  });
}

/** Formulář kusu. bike = null pro nový. */
function bikeForm({ bike, types, csrf, errors = {}, preselectedType, frameNo }) {
  const b = bike || { status: 'available', bike_type_id: preselectedType || (types[0] && types[0].id) };
  const sizes = [...new Set(types.flatMap((t) => t.sizes))];
  return s.card({
    title: bike ? `Kus ${bike.inventory_code}` : 'Nový kus',
    actions: bike ? html`<a class="btn btn--ghost btn--sm" href="/admin/kola/stitky?kus=${bike.id}" target="_blank" rel="noopener">QR štítek</a>` : '',
    children: s.form({
      action: bike ? `/admin/kola/kus/${bike.id}` : '/admin/kola/kus',
      csrf,
      children: html`
        ${Object.keys(errors).length ? c.notice('Zkontrolujte označená pole.', 'danger') : ''}
        <div class="admin-grid admin-grid--2">
          ${c.field({ label: 'Typ kola', name: 'bike_type_id', type: 'select', value: b.bike_type_id, options: types.map((t) => ({ value: t.id, label: `${t.name} (${t.sizes.join(', ')})` })), required: true })}
          ${c.field({ label: 'Inventární kód', name: 'inventory_code', value: b.inventory_code || '', required: true, pattern: '[A-Za-z0-9._-]{2,20}', hint: 'Jedinečný, tiskne se na QR štítek (např. TRK-06).', error: errors.inventory_code })}
          ${c.field({ label: 'Velikost', name: 'size', type: 'select', value: b.size || '', options: [{ value: '', label: '– vyberte –' }, ...sizes.map((x) => ({ value: x, label: x }))], required: true, hint: 'Musí být jednou z velikostí typu.', error: errors.size })}
          ${c.field({ label: 'Stav', name: 'status', type: 'select', value: b.status, options: BIKE_STATUSES })}
          ${c.field({ label: 'Výrobní číslo rámu (ukládá se šifrované)', name: 'frame_no', value: frameNo || '', autocomplete: 'off', maxlength: 40 })}
        </div>
        ${c.field({ label: 'Poznámka (servis, výbava)', name: 'note', type: 'textarea', value: b.note || '', rows: 2 })}`,
      submit: bike ? 'Uložit kus' : 'Založit kus',
    }),
  });
}

/** Tiskové QR štítky. labels: [{ bike, typeName, qrSvg }] */
function labels({ labels: items, title }) {
  return html`${c.notice(html`Štítky vytiskněte (Ctrl+P) – navigace a hlavička se netisknou. QR obsahuje inventární kód; po naskenování se otevře karta kusu v administraci.`, 'info')}
<div class="qr-labels">${items.map(
    (l) => html`<article class="qr-label">
    <div class="qr-label__qr">${raw(l.qrSvg)}</div>
    <div class="qr-label__text"><strong class="qr-label__code mono">${l.bike.inventory_code}</strong><span>${l.typeName}</span><span>vel. ${l.bike.size}</span><span class="qr-label__owner">${title}</span></div>
  </article>`
  )}</div>
${items.length ? '' : c.notice('Žádná kola k tisku.', 'warning')}`;
}

module.exports = { list, typeForm, bikeForm, labels, CATEGORIES, BIKE_STATUSES, format };
