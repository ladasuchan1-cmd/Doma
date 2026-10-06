'use strict';
// Přihlášení do administrace (SPEC kap. 13): e-mail + heslo, druhý krok TOTP, v demo režimu box „Demo přístup“.
// Vstup: { csrf, error, email, zpet, demo, demoEmail, demoPassword }. Výstup: Html tělo (bez admin shellu).

const { html } = require('../../html');
const c = require('../../components');

function wrap(title, lead, inner) {
  return html`<section class="section section--page-head admin-login"><div class="container admin-login__box">
  <p class="section__eyebrow">Administrace</p>
  <h1 class="section__title">${title}</h1>
  ${lead ? html`<p class="section__lead">${lead}</p>` : ''}
  ${inner}
</div></section>`;
}

/** Krok 1: e-mail + heslo. */
function login({ csrf, error, email, zpet, demo, demoEmail, demoPassword }) {
  return wrap(
    'Přihlášení',
    'Přihlaste se e-mailem a heslem. Po 10 neúspěšných pokusech se účet na 15 minut uzamkne.',
    html`${error ? c.notice(error, 'danger') : ''}
  ${demo ? c.notice(html`<strong>Demo přístup:</strong> <code>${demoEmail}</code> / <code>${demoPassword}</code> – data se každou noc vrací do výchozího stavu.`, 'info', { title: '' }) : ''}
  ${c.form({
    action: '/admin/login',
    csrf,
    attrs: { class: 'form admin-login__form', novalidate: true },
    children: html`
      <input type="hidden" name="zpet" value="${zpet || '/admin'}">
      ${c.field({ label: 'E-mail', name: 'email', type: 'email', value: email || (demo ? demoEmail : ''), required: true, autocomplete: 'username' })}
      ${c.field({ label: 'Heslo', name: 'heslo', type: 'password', value: '', required: true, autocomplete: 'current-password' })}`,
    submit: 'Přihlásit se',
  })}`
  );
}

/** Krok 2: ověřovací kód z autentikátoru. */
function totp({ csrf, error, zpet }) {
  return wrap(
    'Ověření druhým faktorem',
    'Zadejte šestimístný kód z aplikace autentikátoru (platí 30 sekund).',
    html`${error ? c.notice(error, 'danger') : ''}
  ${c.form({
    action: '/admin/login/2fa',
    csrf,
    attrs: { class: 'form admin-login__form', novalidate: true },
    children: html`
      <input type="hidden" name="zpet" value="${zpet || '/admin'}">
      ${c.field({ label: 'Ověřovací kód', name: 'kod', type: 'text', value: '', required: true, inputmode: 'numeric', pattern: '[0-9 ]{6,7}', autocomplete: 'one-time-code', attrs: { autofocus: true } })}`,
    submit: 'Ověřit a přihlásit',
  })}
  <p class="admin-login__alt"><a href="/admin/login">Zpět na přihlášení</a></p>`
  );
}

module.exports = { login, totp };
