'use strict';
// Admin → Obsah (SPEC kap. 13): texty domovské stránky a kontaktu (settings.texts) a zajímavosti okolí
// (poi_overrides: skrýt / pořadí / vlastní text). Vstup: { texts, defaults, pois, csrf }. Výstup: Html.

const s = require('./shared');
const { html, c, format } = s;

const TEXT_FIELDS = [
  ['heroTitle', 'Titulek úvodu (hero)', 'text'],
  ['heroText', 'Text úvodu', 'textarea'],
  ['about', 'O půjčovně (patička, domovská stránka)', 'textarea'],
  ['contactNote', 'Poznámka na stránce Kontakt', 'textarea'],
  ['pickupNote', 'Co vzít s sebou (potvrzení rezervace)', 'textarea'],
];

function obsah({ texts, defaults, pois, csrf }) {
  return html`
${s.card({
    title: 'Texty webu',
    children: s.form({
      action: '/admin/obsah/texty',
      csrf,
      children: html`<p class="small muted">Prázdné pole = výchozí text z tenant.json (zobrazen pod polem). Texty se ukládají do nastavení (settings.texts).</p>
      ${TEXT_FIELDS.map(([key, label, type]) => c.field({ label, name: key, type, value: texts[key] || '', rows: 3, hint: defaults[key] ? html`Výchozí: <em>${defaults[key]}</em>` : null }))}`,
      submit: 'Uložit texty',
    }),
  })}
${s.card({
    title: `Zajímavosti v okolí (${pois.length})`,
    children: pois.length
      ? html`<p class="small muted">Změny se na webu (/okoli, /mapa) projeví okamžitě. Pořadí: nižší číslo = dřív; bez čísla se řadí podle vzdálenosti. Vlastní text nahradí úvod z Wikipedie.</p>
      <div class="admin-pois">${pois.map(
        (p) => html`<form class="admin-poi${p.override && p.override.hidden ? ' is-hidden' : ''}" method="post" action="/admin/obsah/poi/${encodeURIComponent(p.id)}">
        <input type="hidden" name="_csrf" value="${csrf}">
        ${p.image && p.image.src ? html`<img class="admin-poi__img" src="${p.image.src}" alt="" loading="lazy" width="120" height="90">` : html`<div class="admin-poi__img admin-poi__img--empty" aria-hidden="true"></div>`}
        <div class="admin-poi__body">
          <h3 class="admin-poi__title">${p.name} <small class="muted">${p.type} · ${format.km(p.distanceKm)} · <span class="mono">${p.id}</span></small></h3>
          <p class="small muted admin-poi__summary">${p.summary || ''}</p>
          <div class="admin-grid admin-grid--3 admin-poi__fields">
            ${c.field({ label: 'Skrýt na webu', name: 'hidden', type: 'checkbox', checked: !!(p.override && p.override.hidden), id: `poi-hidden-${p.idx}` })}
            ${c.field({ label: 'Pořadí', name: 'sort', type: 'number', value: p.override && p.override.sort !== null && p.override.sort !== undefined ? p.override.sort : '', min: 0, step: 1, id: `poi-sort-${p.idx}` })}
            ${c.field({ label: 'Vlastní text', name: 'custom_text', type: 'textarea', value: (p.override && p.override.custom_text) || '', rows: 2, id: `poi-text-${p.idx}` })}
          </div>
          <div class="form__actions">${c.button({ label: 'Uložit', type: 'submit', variant: 'secondary', size: 'sm' })}${p.override ? c.button({ label: 'Zrušit úpravy', type: 'submit', variant: 'ghost', size: 'sm', name: 'reset', value: '1' }) : ''}</div>
        </div>
      </form>`
      )}</div>`
      : c.notice('Soubor tenants/<slug>/okoli.json neexistuje – spusťte npm run build-okoli.', 'warning'),
  })}`;
}

module.exports = { obsah, TEXT_FIELDS };
