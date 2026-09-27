'use strict';
// C9: nepovinné jméno při přihlášení (jen označení, kdo schvaluje – heslo je společné):
//  - login pošle {password, name}, jméno si pamatuje prohlížeč (localStorage, bez něj se jen nezapamatuje),
//  - vyhrazená / neplatná jména odmítne už formulář (stejná pravidla jako server),
//  - postranní panel aplikace ukazuje jméno z /auth/me.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { installDom, makeCtx, text, FakeEvent } = require('./ui-fake-dom.js');

const dom = installDom();
const PUB = path.join(__dirname, '..', 'public');
const view = () => import(pathToFileURL(path.join(PUB, 'views', 'login.js')).href);

let me = null;
const logins = [];
dom.api({
  'GET /auth/me': () => (me ? { user: me, scopes: ['read', 'import', 'export', 'admin'], via: 'session' } : dom.apiError(401, 'Nepřihlášeno.')),
  'POST /auth/login': (req) => {
    logins.push(req.body);
    if (req.body.password !== 'tajne') return dom.apiError(401, 'Nesprávné heslo.');
    me = req.body.name || 'admin';
    return { ok: true };
  },
  'GET /health': { ok: true, version: 'test' },
  'GET /dashboard': { products: { active: 0 } },
  'GET /proposals': { items: [], total: 0, page: 1, limit: 1, summary: { pending: 0, approved: 0, exported_today: 0, up: 0, down: 0 } },
});

async function render() {
  const { show } = await view();
  const root = dom.root();
  const ctx = makeCtx({ query: { next: '/navrhy' }, loggedIn: (m) => ctx.calls.loggedIn.push(m) });
  ctx.calls.loggedIn = [];
  await show(root, ctx);
  await dom.settle();
  return { root, ctx };
}
function submit(root, name, password) {
  const nameIn = root.querySelector('#login-name');
  if (name != null) dom.type(nameIn, name);
  dom.type(root.querySelector('#login-password'), password);
  root.querySelector('form').dispatchEvent(new FakeEvent('submit', { bubbles: true, cancelable: true }));
}

test('normalizeName: ořez, délka, řídicí znaky, vyhrazená jména', async () => {
  const { normalizeName, NAME_MAX } = await view();
  assert.deepStrictEqual(normalizeName('  Jana Dvořáková '), { name: 'Jana Dvořáková', error: null });
  assert.deepStrictEqual(normalizeName('   '), { name: null, error: null });
  assert.deepStrictEqual(normalizeName(undefined), { name: null, error: null });
  assert.match(normalizeName('x'.repeat(NAME_MAX + 1)).error, /nejvýš 64 znaků/);
  assert.strictEqual(normalizeName('x'.repeat(NAME_MAX)).error, null);
  assert.match(normalizeName('Jana\nNovák').error, /řídicí znaky/);
  assert.match(normalizeName('Auto').error, /vyhrazená/);
  assert.match(normalizeName('token:feed').error, /vyhrazená/);
});

test('přihlášení se jménem: pošle name, zapamatuje ho a příště ho předvyplní', async () => {
  me = null;
  logins.length = 0;
  localStorage.removeItem('ct-user-name');
  const { root, ctx } = await render();
  assert.ok(root.querySelector('#login-name'), 'pole Jméno');
  assert.match(text(root), /Jméno \(nepovinné\)/);
  assert.match(text(root), /Slouží jen pro přehled/);
  assert.strictEqual(document.activeElement, root.querySelector('#login-name'), 'bez zapamatovaného jména fokus na jméno');
  submit(root, '  Jana Dvořáková ', 'tajne');
  await dom.settle();
  assert.deepStrictEqual(logins.at(-1), { password: 'tajne', name: 'Jana Dvořáková' });
  assert.strictEqual(localStorage.getItem('ct-user-name'), 'Jana Dvořáková');
  assert.strictEqual(ctx.calls.loggedIn.at(-1).user, 'Jana Dvořáková');
  assert.strictEqual(location.hash, '#/navrhy');
  // odhlášení a nové přihlášení: jméno předvyplněné, fokus na heslo
  me = null;
  const again = await render();
  assert.strictEqual(again.root.querySelector('#login-name').value, 'Jana Dvořáková');
  assert.strictEqual(document.activeElement, again.root.querySelector('#login-password'));
});

test('bez jména se name neposílá a zapamatované jméno se smaže; vyhrazené jméno formulář odmítne', async () => {
  me = null;
  logins.length = 0;
  localStorage.setItem('ct-user-name', 'Petr');
  const { root } = await render();
  submit(root, 'auto', 'tajne');
  await dom.settle();
  assert.strictEqual(logins.length, 0, 'vyhrazené jméno se neodeslalo');
  assert.match(text(root.querySelector('.login-error')), /vyhrazená/);
  submit(root, '', 'tajne');
  await dom.settle();
  assert.deepStrictEqual(logins.at(-1), { password: 'tajne' });
  assert.strictEqual(localStorage.getItem('ct-user-name'), null);
});

test('nedostupné úložiště (soukromé okno) přihlášení nerozbije', async () => {
  me = null;
  logins.length = 0;
  const orig = { get: localStorage.getItem, set: localStorage.setItem };
  localStorage.getItem = () => {
    throw new Error('SecurityError');
  };
  localStorage.setItem = () => {
    throw new Error('SecurityError');
  };
  try {
    const { root, ctx } = await render();
    assert.strictEqual(root.querySelector('#login-name').value, '');
    submit(root, 'Eva', 'tajne');
    await dom.settle();
    assert.deepStrictEqual(logins.at(-1), { password: 'tajne', name: 'Eva' });
    assert.strictEqual(ctx.calls.loggedIn.at(-1).user, 'Eva');
  } finally {
    localStorage.getItem = orig.get;
    localStorage.setItem = orig.set;
  }
});

test('postranní panel aplikace ukazuje jméno přihlášeného', async () => {
  me = 'Jana Dvořáková';
  const el = dom.document.createElement('div');
  el.setAttribute('id', 'app');
  dom.document.body.appendChild(el);
  dom.location.hash = '#/prehled';
  await import(pathToFileURL(path.join(PUB, 'app.js')).href);
  await dom.settle();
  const user = dom.document.querySelector('[data-role="user-name"]');
  assert.ok(user, 'jméno v postranním panelu');
  assert.strictEqual(text(user), 'Jana Dvořáková');
  assert.match(user.getAttribute('title'), /Přihlášen jako Jana Dvořáková/);
});
