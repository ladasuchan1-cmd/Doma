// Přihlášení heslem (POST /auth/login → cookie ct_session) s nepovinným jménem (C9): jméno se jen zapisuje
// k rozhodnutím (schválil / zamítl) a do auditu – nejde o ověření totožnosti (heslo je společné).
import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { brandMark, icon } from '../lib/icons.js';

export const title = 'Přihlášení';

/** Klíč v localStorage pro zapamatované jméno. */
export const NAME_STORAGE_KEY = 'ct-user-name';
export const NAME_MAX = 64;

/** Zapamatované jméno (prázdné, když úložiště není dostupné). */
export function rememberedName() {
  try {
    return String(localStorage.getItem(NAME_STORAGE_KEY) || '').slice(0, NAME_MAX);
  } catch {
    return '';
  }
}

function rememberName(name) {
  try {
    if (name) localStorage.setItem(NAME_STORAGE_KEY, name);
    else localStorage.removeItem(NAME_STORAGE_KEY);
  } catch {
    /* soukromé okno – jméno se jen nezapamatuje */
  }
}

/**
 * Jméno pro přihlášení: ořízne mezery, řídicí znaky jsou chyba (server je odmítne), nejvýš 64 znaků.
 * @returns {{name: string|null, error: string|null}} name null = bez jména
 */
export function normalizeName(v) {
  const s = String(v ?? '').trim();
  if (!s) return { name: null, error: null };
  if (/[\u0000-\u001f\u007f-\u009f]/.test(s)) return { name: null, error: 'Jméno nesmí obsahovat řídicí znaky.' };
  if (s.length > NAME_MAX) return { name: null, error: 'Jméno může mít nejvýš ' + NAME_MAX + ' znaků.' };
  return { name: s, error: null };
}

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
  const nameIn = h('input', { type: 'text', class: 'input', id: 'login-name', name: 'name', autocomplete: 'name', maxlength: NAME_MAX, placeholder: 'Např. Jana Dvořáková', value: rememberedName(), 'aria-describedby': 'login-name-help' });
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
        const nm = normalizeName(nameIn.value);
        if (nm.error) {
          err.textContent = nm.error;
          nameIn.focus();
          return;
        }
        submit.disabled = true;
        submit.classList.add('is-busy');
        try {
          await api.post('/auth/login', nm.name ? { password: pwd.value, name: nm.name } : { password: pwd.value }, { silent: true, allow401: true });
          rememberName(nm.name);
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
    h('label', { for: 'login-name', class: 'field-label' }, 'Jméno ', h('span', { class: 'muted' }, '(nepovinné)')),
    nameIn,
    h('p', { class: 'field-help', id: 'login-name-help' }, 'Zapíše se k návrhům, které schválíte nebo zamítnete, a do auditu. Slouží jen pro přehled – přihlašuje se společným heslem.'),
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
  // se zapamatovaným jménem rovnou na heslo
  if (nameIn.value) pwd.focus();
  else nameIn.focus();
}
