// Přihlášení heslem (POST /auth/login → cookie ct_session).
import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { brandMark, icon } from '../lib/icons.js';

export const title = 'Přihlášení';

function safeNext(next) {
  // jen interní cesty aplikace (žádné //host nebo schéma)
  if (typeof next === 'string' && /^\/[a-z0-9/_?=&%.,:+~-]*$/i.test(next) && !next.startsWith('//') && !next.startsWith('/login')) return next;
  return '/prehled';
}

export async function show(root, ctx) {
  document.title = 'Přihlášení · Cenotvorba';
  const next = safeNext(ctx.query.next);
  // už přihlášen? → rovnou dál
  try {
    const me = await api.get('/auth/me', null, { silent: true, allow401: true, signal: ctx.signal });
    if (me && me.user) {
      ctx.loggedIn(me);
      location.hash = '#' + next;
      return;
    }
  } catch {
    /* nepřihlášen – zobrazit formulář */
  }
  const err = h('div', { class: 'login-error', role: 'alert', 'aria-live': 'assertive' });
  const pwd = h('input', { type: 'password', class: 'input', id: 'login-password', name: 'password', autocomplete: 'current-password', required: true, placeholder: 'Heslo' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('arrow-right', { size: 16 }), h('span', null, 'Přihlásit se'));
  const form = h(
    'form',
    {
      class: 'stack-sm',
      novalidate: true,
      onSubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        if (!pwd.value) {
          err.textContent = 'Zadejte heslo.';
          pwd.focus();
          return;
        }
        submit.disabled = true;
        submit.classList.add('is-busy');
        try {
          await api.post('/auth/login', { password: pwd.value }, { silent: true, allow401: true });
          const me = await api.get('/auth/me', null, { silent: true });
          ctx.loggedIn(me);
          location.hash = '#' + next;
        } catch (ex) {
          err.textContent = ex.status === 401 ? 'Nesprávné heslo.' : ex.status === 429 ? ex.message || 'Příliš mnoho pokusů – zkuste to za chvíli.' : ex.message || 'Přihlášení se nezdařilo.';
          pwd.select();
          pwd.focus();
        } finally {
          submit.disabled = false;
          submit.classList.remove('is-busy');
        }
      },
    },
    h('label', { for: 'login-password', class: 'field-label' }, 'Heslo'),
    pwd,
    err,
    submit
  );
  mount(
    root,
    h(
      'div',
      { class: 'login', dataset: { view: 'login' } },
      h(
        'div',
        { class: 'login-card' },
        h('div', { class: 'login-brand' }, brandMark(), h('div', null, h('h1', null, 'Cenotvorba'), h('p', null, 'Repricing a dynamická cenotvorba'))),
        form,
        h('p', { class: 'login-foot' }, 'Heslo nastavuje správce (proměnná CENOTVORBA_PASSWORD nebo Nastavení → Změna hesla).')
      )
    )
  );
  root.dataset.ready = '1';
  pwd.focus();
}
