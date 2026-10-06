'use strict';
// Stránka: kontakt (feature kontakt). Vstup: { tenant, texts, csrf, values, errors, sent } (texts = efektivní texty
// z layout.siteTexts; texts.contactNote = poznámka z adminu pod kontaktní kartou). Výstup: Html tělo.

const { html } = require('../html');
const c = require('../components');

function kontakt({ tenant, texts, csrf, values, errors, sent }) {
  const business = tenant.business || {};
  const t = texts || tenant.texts || {};
  const loc = tenant.location;
  const mapHref = loc ? `https://mapy.cz/zakladni?x=${loc.lon}&y=${loc.lat}&z=16&source=coor&id=${loc.lon}%2C${loc.lat}` : null;
  return html`
${c.section({
  variant: 'page-head',
  title: 'Kontakt',
  titleTag: 'h1',
  lead: 'Najdete nás na náměstí v centru Třeboně. Zavolejte, napište, nebo se zastavte v otevírací době.',
})}
${c.section({
  variant: 'contact',
  children: html`<div class="grid grid--2">
    <div>
      ${c.contactCard(business, tenant.openingHours, { title: tenant.name, mapHref })}
      ${t.contactNote ? html`<p class="contact-note-text">${t.contactNote}</p>` : ''}
      ${loc
        ? html`<p class="contact-coords">GPS: ${loc.lat}, ${loc.lon} · <a href="${mapHref}" rel="noopener" target="_blank">Navigovat v Mapy.cz</a> · <a href="https://www.openstreetmap.org/?mlat=${loc.lat}&amp;mlon=${loc.lon}#map=16/${loc.lat}/${loc.lon}" rel="noopener" target="_blank">OpenStreetMap</a></p>`
        : ''}
      <p class="contact-hint">Chcete výlet naplánovat předem? Podívejte se na <a href="/mapa">mapu cyklotras</a> a <a href="/okoli">tipy na výlety</a>.</p>
    </div>
    <div class="contact-form">
      <h2 class="contact-form__title">Napište nám</h2>
      ${sent ? c.notice('Děkujeme, váš dotaz jsme přijali. Odpovíme na uvedený e-mail obvykle do druhého pracovního dne.', 'success') : ''}
      ${Object.keys(errors || {}).length ? c.notice('Formulář obsahuje chyby – zkontrolujte prosím označená pole.', 'danger') : ''}
      ${c.form({
        action: '/kontakt',
        method: 'post',
        csrf,
        children: [
          c.field({ label: 'Jméno a příjmení', name: 'jmeno', type: 'text', value: values.name, required: true, error: errors.name, autocomplete: 'name', maxlength: 100 }),
          c.field({ label: 'E-mail', name: 'email', type: 'email', value: values.email, required: true, error: errors.email, autocomplete: 'email', maxlength: 200 }),
          c.field({ label: 'Telefon', name: 'telefon', type: 'tel', value: values.phone, error: errors.phone, autocomplete: 'tel', hint: 'Nepovinné – pokud chcete, abychom zavolali zpět.', maxlength: 40 }),
          c.field({ label: 'Zpráva', name: 'zprava', type: 'textarea', value: values.message, required: true, error: errors.message, rows: 6, maxlength: 2000, hint: 'Napište, kdy a jaká kola potřebujete; odpovíme s nabídkou.' }),
          html`<div class="hp" aria-hidden="true"><label for="f-web">Web</label><input id="f-web" type="text" name="web" tabindex="-1" autocomplete="off"></div>`,
          c.field({
            label: html`Beru na vědomí, že uvedené údaje použijete jen k vyřízení dotazu podle <a href="/soukromi">zásad ochrany osobních údajů</a>.`,
            name: 'souhlas',
            type: 'checkbox',
            value: '1',
            checked: values.consent,
            required: true,
            error: errors.consent,
          }),
        ],
        submit: 'Odeslat dotaz',
      })}
    </div>
  </div>`,
})}
`;
}

module.exports = { kontakt };
