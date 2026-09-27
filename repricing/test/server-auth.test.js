'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { openDb, getSettings, getSetting } = require('../src/db');
const { createApp } = require('../src/server/http');
const auth = require('../src/server/auth');
const { silentLog, request, listen } = require('./server-helpers');

const PASSWORD = 'Spravne-Heslo-123';

function testRoutes(r) {
  r.get('/api/test/read', () => ({ ok: 'read' }), { auth: 'read' });
  r.post('/api/test/read', () => ({ ok: 'read-post' }), { auth: 'read' });
  r.post('/api/test/import', () => ({ ok: 'import' }), { auth: 'import' });
  r.get('/api/test/export', () => ({ ok: 'export' }), { auth: 'export' });
  r.post('/api/test/admin', (ctx) => ({ ok: 'admin', user: ctx.user }), { auth: 'admin' });
  r.get('/test-feed/:name.:ext(xml|json|csv)', (ctx) => ({ feed: ctx.params.name, query: ctx.query }), { auth: 'export' });
}

/** Aplikace s plnou API vrstvou (auth modul) + testovací routy. */
async function withAuthApp(fn, { config = {}, initialPassword = PASSWORD } = {}) {
  const db = openDb(':memory:');
  const cfg = { publicDir: null, maxBodyMb: 5, ...config };
  auth.initAuth(db, cfg);
  if (initialPassword && !cfg.password) auth.setPassword(db, initialPassword, cfg);
  const app = createApp({ db, config: cfg, log: silentLog, setup: testRoutes });
  const srv = await listen(app);
  const api = (method, p, { body, headers = {}, cookie, xrw = true } = {}) => {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (cookie) h.cookie = cookie;
    if (cookie && xrw) h['x-requested-with'] = 'cenotvorba';
    return request(srv.port, { method, path: p, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  const login = async (password = PASSWORD, headers = {}) => {
    const r = await api('POST', '/api/v1/auth/login', { body: { password }, headers });
    const sc = r.headers['set-cookie'];
    return { r, cookie: sc ? sc[0].split(';')[0] : null, setCookie: sc ? sc[0] : null };
  };
  try {
    await fn({ srv, db, api, login, config: cfg });
  } finally {
    await srv.close();
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------------------

test('initAuth: vygeneruje heslo jen poprvé, tajemství uloží do interních nastavení', async () => {
  const db = openDb(':memory:');
  const first = auth.initAuth(db, {});
  assert.strictEqual(first.passwordSource, 'generated');
  assert.match(first.generatedPassword, /^[A-Za-z2-9]{16}$/);
  assert.ok(await auth.verifyPassword(db, {}, first.generatedPassword));
  assert.ok(!(await auth.verifyPassword(db, {}, 'spatne')));
  const second = auth.initAuth(db, {});
  assert.deepStrictEqual(second, { generatedPassword: null, passwordSource: 'db' });
  const secret = getSetting(db, '_secret', null);
  assert.match(secret, /^[0-9a-f]{64}$/);
  const settings = getSettings(db);
  assert.ok(!('_secret' in settings) && !('_password_hash' in settings));
  assert.match(getSetting(db, '_password_hash', ''), /^scrypt\$16384\$8\$1\$/);
  // env heslo má přednost a nic negeneruje
  const db2 = openDb(':memory:');
  assert.deepStrictEqual(auth.initAuth(db2, { password: 'z-env' }), { generatedPassword: null, passwordSource: 'env' });
  assert.strictEqual(getSetting(db2, '_password_hash', null), null);
  assert.ok(await auth.verifyPassword(db2, { password: 'z-env' }, 'z-env'));
  assert.ok(!(await auth.verifyPassword(db2, { password: 'z-env' }, 'z-env2')));
  db.close();
  db2.close();
});

test('hash hesla a podpis session', async () => {
  const h = auth.hashPassword('abc');
  assert.notStrictEqual(h, auth.hashPassword('abc'), 'sůl musí být náhodná');
  assert.ok(await auth.verifyPasswordHash('abc', h));
  assert.ok(!(await auth.verifyPasswordHash('abd', h)));
  assert.ok(!(await auth.verifyPasswordHash('abc', 'nesmysl')));
  const v = auth.signSession({ u: 'admin', exp: Date.now() + 1000 }, 's1');
  assert.strictEqual(auth.verifySession(v, 's1').u, 'admin');
  assert.strictEqual(auth.verifySession(v, 's2'), null);
  assert.strictEqual(auth.verifySession(auth.signSession({ u: 'admin', exp: Date.now() - 1 }, 's1'), 's1'), null);
  assert.strictEqual(auth.verifySession('a.b.c', 's1'), null);
  assert.strictEqual(auth.verifySession(undefined, 's1'), null);
  assert.deepStrictEqual(auth.parseCookies('a=1; ct_session=x%3Dy; b="q"'), { a: '1', ct_session: 'x=y', b: 'q' });
});

test('přihlášení: úspěch nastaví cookie (HttpOnly, SameSite=Strict), /auth/me', async () => {
  await withAuthApp(async ({ api, login }) => {
    const { r, cookie, setCookie } = await login();
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json(), { ok: true });
    assert.match(setCookie, /^ct_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=1209600$/);
    const me = await api('GET', '/api/v1/auth/me', { cookie });
    assert.strictEqual(me.status, 200);
    const j = me.json();
    assert.strictEqual(j.user, 'admin');
    assert.strictEqual(j.via, 'session');
    assert.deepStrictEqual(j.scopes, ['read', 'import', 'export', 'admin']);
    // session = všechny rozsahy
    const adm = await api('POST', '/api/test/admin', { cookie, body: {} });
    assert.strictEqual(adm.status, 200);
    assert.strictEqual(adm.json().user, 'admin');
  });
});

test('přihlášení: Secure cookie za HTTPS proxy (trustProxy + X-Forwarded-Proto)', async () => {
  await withAuthApp(async ({ login }) => {
    const { setCookie } = await login(PASSWORD, { 'x-forwarded-proto': 'https' });
    assert.match(setCookie, /; Secure$/);
  }, { config: { trustProxy: true } });
  await withAuthApp(async ({ login }) => {
    const { setCookie } = await login(PASSWORD, { 'x-forwarded-proto': 'https' });
    assert.doesNotMatch(setCookie, /Secure/, 'bez trustProxy se hlavičce nevěří');
  });
});

test('přihlášení: špatné heslo → 401, chybějící → 400, bez auth → 401 JSON', async () => {
  await withAuthApp(async ({ api, login }) => {
    const { r, cookie } = await login('spatne');
    assert.strictEqual(r.status, 401);
    assert.strictEqual(cookie, null);
    assert.strictEqual(r.json().error.message, 'Nesprávné heslo.');
    assert.strictEqual(r.json().error.details.remaining_attempts, 9);
    const r2 = await api('POST', '/api/v1/auth/login', { body: {} });
    assert.strictEqual(r2.status, 400);
    const me = await api('GET', '/api/v1/auth/me');
    assert.strictEqual(me.status, 401);
    assert.strictEqual(me.headers['www-authenticate'], 'Bearer realm="cenotvorba"');
    assert.match(me.json().error.message, /Nepřihlášeno/);
    const h = await api('GET', '/api/v1/health');
    assert.strictEqual(h.status, 200);
    const hj = h.json();
    assert.strictEqual(hj.ok, true);
    assert.strictEqual(hj.version, require('../package.json').version);
    assert.ok(!Number.isNaN(Date.parse(hj.time)));
  });
});

test('přihlášení: 10 chyb / 15 min / IP → 429 (i se správným heslem), jiná IP není blokovaná', async () => {
  await withAuthApp(async ({ login }) => {
    const ip1 = { 'x-forwarded-for': '10.0.0.1' };
    for (let i = 0; i < 10; i++) {
      const { r } = await login('spatne', ip1);
      assert.strictEqual(r.status, 401, `pokus ${i + 1}`);
    }
    const blocked = await login(PASSWORD, ip1);
    assert.strictEqual(blocked.r.status, 429);
    assert.ok(Number(blocked.r.headers['retry-after']) > 0);
    assert.match(blocked.r.json().error.message, /Příliš mnoho/);
    assert.strictEqual(blocked.cookie, null);
    const other = await login(PASSWORD, { 'x-forwarded-for': '10.0.0.2' });
    assert.strictEqual(other.r.status, 200);
  }, { config: { trustProxy: true } });
});

test('limiter: okno 15 minut, reset po úspěchu', () => {
  const lim = auth.createLoginLimiter({ max: 3, windowMs: 1000 });
  const t0 = 1_000_000;
  lim.fail('a', t0);
  lim.fail('a', t0 + 10);
  assert.strictEqual(lim.check('a', t0 + 20).limited, false);
  lim.fail('a', t0 + 20);
  const c = lim.check('a', t0 + 30);
  assert.strictEqual(c.limited, true);
  assert.strictEqual(c.retryAfterSec, 1);
  assert.strictEqual(lim.check('a', t0 + 1001).limited, false, 'nejstarší pokus vypadl z okna');
  lim.reset('a');
  assert.strictEqual(lim.check('a', t0 + 30).remaining, 3);
});

test('session: pozměněná, cizím tajemstvím podepsaná nebo prošlá cookie je odmítnuta', async () => {
  await withAuthApp(async ({ api, login, db, config }) => {
    const { cookie } = await login();
    const value = cookie.slice('ct_session='.length);
    const [body, sig] = value.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    // 1) změněný obsah (delší platnost) se starým podpisem
    const forgedBody = Buffer.from(JSON.stringify({ ...payload, exp: payload.exp + 1e9 })).toString('base64url');
    let r = await api('GET', '/api/v1/auth/me', { cookie: `ct_session=${forgedBody}.${sig}` });
    assert.strictEqual(r.status, 401);
    assert.match(r.json().error.message, /vypršelo/);
    // 2) pozměněný podpis
    const badSig = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    r = await api('GET', '/api/v1/auth/me', { cookie: `ct_session=${body}.${badSig}` });
    assert.strictEqual(r.status, 401);
    // 3) podepsáno jiným tajemstvím
    r = await api('GET', '/api/v1/auth/me', { cookie: 'ct_session=' + auth.signSession(payload, 'jine-tajemstvi') });
    assert.strictEqual(r.status, 401);
    // 4) prošlá (správně podepsaná)
    const secret = auth.getSecret(db, config);
    r = await api('GET', '/api/v1/auth/me', { cookie: 'ct_session=' + auth.signSession({ ...payload, exp: Date.now() - 1000 }, secret) });
    assert.strictEqual(r.status, 401);
    // 5) nesmysl
    r = await api('GET', '/api/v1/auth/me', { cookie: 'ct_session=abc' });
    assert.strictEqual(r.status, 401);
    // původní funguje
    r = await api('GET', '/api/v1/auth/me', { cookie });
    assert.strictEqual(r.status, 200);
  });
});

test('session: klouzavé obnovení cookie, když do vypršení zbývá < 7 dní', async () => {
  await withAuthApp(async ({ api, login, db, config }) => {
    const { cookie } = await login();
    const payload = JSON.parse(Buffer.from(cookie.slice(11).split('.')[0], 'base64url').toString());
    let r = await api('GET', '/api/v1/auth/me', { cookie });
    assert.strictEqual(r.headers['set-cookie'], undefined, 'čerstvá session se neobnovuje');
    const old = 'ct_session=' + auth.signSession({ ...payload, exp: Date.now() + 2 * 86400000 }, auth.getSecret(db, config));
    r = await api('GET', '/api/v1/auth/me', { cookie: old });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers['set-cookie'][0], /^ct_session=.*Max-Age=1209600/);
  });
});

test('CSRF: cookie + ne-GET bez X-Requested-With → 403; s hlavičkou OK; token hlavičku nepotřebuje', async () => {
  await withAuthApp(async ({ api, login, db }) => {
    const { cookie } = await login();
    let r = await api('POST', '/api/test/read', { cookie, body: {}, xrw: false });
    assert.strictEqual(r.status, 403);
    assert.match(r.json().error.message, /X-Requested-With/);
    r = await api('POST', '/api/test/read', { cookie, body: {}, headers: { 'x-requested-with': 'XMLHttpRequest' }, xrw: false });
    assert.strictEqual(r.status, 403);
    r = await api('POST', '/api/test/read', { cookie, body: {} });
    assert.strictEqual(r.status, 200);
    r = await api('GET', '/api/test/read', { cookie, xrw: false });
    assert.strictEqual(r.status, 200, 'GET CSRF hlavičku nepotřebuje');
    // odhlášení přes cookie bez hlavičky je také odmítnuto (nelze odhlásit cizí stránkou)
    r = await api('POST', '/api/v1/auth/logout', { cookie, xrw: false });
    assert.strictEqual(r.status, 403);
    const t = auth.createToken(db, { name: 'skript', scopes: ['read'] });
    r = await api('POST', '/api/test/read', { body: {}, headers: { authorization: `Bearer ${t.token}` } });
    assert.strictEqual(r.status, 200);
  });
});

test('tokeny: rozsahy, Bearer / X-Api-Key / ?token=, neplatný a smazaný token', async () => {
  await withAuthApp(async ({ api, db }) => {
    const read = auth.createToken(db, { name: 'čtení', scopes: ['read'] });
    const exp = auth.createToken(db, { name: 'admin feed', scopes: 'export' });
    const adm = auth.createToken(db, { name: 'správa', scopes: ['admin'] });
    assert.match(read.token, /^ct_[0-9A-Za-z]{32}$/);
    assert.strictEqual(read.prefix, read.token.slice(0, 7));
    const bearer = (t) => ({ authorization: `Bearer ${t}` });

    let r = await api('GET', '/api/test/read', { headers: bearer(read.token) });
    assert.strictEqual(r.status, 200);
    r = await api('POST', '/api/test/admin', { headers: bearer(read.token), body: {} });
    assert.strictEqual(r.status, 403);
    assert.match(r.json().error.message, /„admin“/);
    r = await api('POST', '/api/test/import', { headers: bearer(read.token), body: {} });
    assert.strictEqual(r.status, 403);
    r = await api('GET', '/api/v1/tokens', { headers: bearer(read.token) });
    assert.strictEqual(r.status, 403, 'read token nesmí na admin routu');

    // export token: feed přes ?token= (a token se neobjeví v ctx.query)
    r = await api('GET', `/test-feed/changes.xml?token=${exp.token}&mark=1`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json(), { feed: 'changes', query: { mark: '1' } });
    r = await api('GET', '/api/test/export', { headers: { 'x-api-key': exp.token } });
    assert.strictEqual(r.status, 200);
    r = await api('GET', '/api/test/read', { headers: { 'x-api-key': exp.token } });
    assert.strictEqual(r.status, 403, 'export neimplikuje read');
    r = await api('GET', '/test-feed/changes.xml');
    assert.strictEqual(r.status, 401);

    // admin zahrnuje vše
    for (const [m, p] of [['GET', '/api/test/read'], ['POST', '/api/test/import'], ['GET', '/api/test/export'], ['POST', '/api/test/admin']]) {
      r = await api(m, p, { headers: bearer(adm.token), body: m === 'POST' ? {} : undefined });
      assert.strictEqual(r.status, 200, `${m} ${p}`);
    }
    r = await api('POST', '/api/test/admin', { headers: bearer(adm.token), body: {} });
    assert.strictEqual(r.json().user, 'token:správa');

    // /auth/me s tokenem
    r = await api('GET', '/api/v1/auth/me', { headers: bearer(exp.token) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json().via, 'token');
    assert.deepStrictEqual(r.json().scopes, ['export']);
    assert.strictEqual(r.json().token.prefix, exp.prefix);

    // neplatný token
    r = await api('GET', '/api/test/read', { headers: bearer('ct_' + 'x'.repeat(32)) });
    assert.strictEqual(r.status, 401);
    assert.match(r.json().error.message, /Neplatný nebo zrušený API token/);
    r = await api('GET', '/api/test/read?token=nesmysl');
    assert.strictEqual(r.status, 401);

    // last_used_at
    const row = db.prepare('SELECT last_used_at FROM tokens WHERE id = ?').get(read.id);
    assert.ok(row.last_used_at);

    // smazaný token
    assert.strictEqual(auth.deleteToken(db, read.id), true);
    r = await api('GET', '/api/test/read', { headers: bearer(read.token) });
    assert.strictEqual(r.status, 401);
  });
});

test('neplatný předložený token se nenahrazuje platnou cookie', async () => {
  await withAuthApp(async ({ api, login }) => {
    const { cookie } = await login();
    const r = await api('GET', '/api/test/read', { cookie, headers: { authorization: 'Bearer ct_neplatny' } });
    assert.strictEqual(r.status, 401);
  });
});

test('API tokenů: vytvoření (token jen jednou), výpis bez hashů, smazání, validace', async () => {
  await withAuthApp(async ({ api, login, db }) => {
    const { cookie } = await login();
    let r = await api('POST', '/api/v1/tokens', { cookie, body: { name: 'Admin – import', scopes: ['import', 'read'] } });
    assert.strictEqual(r.status, 200);
    const created = r.json();
    assert.match(created.token, /^ct_/);
    assert.deepStrictEqual(created.scopes, ['read', 'import']);
    assert.strictEqual(created.prefix, created.token.slice(0, 7));
    r = await api('GET', '/api/v1/tokens', { cookie });
    const items = r.json().items;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].name, 'Admin – import');
    assert.ok(!('token' in items[0]) && !('token_hash' in items[0]));
    assert.ok(!r.text.includes(created.token));
    const stored = db.prepare('SELECT token_hash FROM tokens').get().token_hash;
    assert.strictEqual(stored, auth.sha256Hex(created.token));
    // import token funguje
    r = await api('POST', '/api/test/import', { headers: { authorization: `Bearer ${created.token}` }, body: {} });
    assert.strictEqual(r.status, 200);
    // validace
    r = await api('POST', '/api/v1/tokens', { cookie, body: { name: 'x', scopes: ['root'] } });
    assert.strictEqual(r.status, 400);
    r = await api('POST', '/api/v1/tokens', { cookie, body: { name: '', scopes: ['read'] } });
    assert.strictEqual(r.status, 400);
    r = await api('POST', '/api/v1/tokens', { cookie, body: { name: 'x', scopes: [] } });
    assert.strictEqual(r.status, 400);
    // smazání
    r = await api('DELETE', `/api/v1/tokens/${created.id}`, { cookie });
    assert.deepStrictEqual(r.json(), { ok: true });
    r = await api('DELETE', `/api/v1/tokens/${created.id}`, { cookie });
    assert.strictEqual(r.status, 404);
    r = await api('DELETE', '/api/v1/tokens/abc', { cookie });
    assert.strictEqual(r.status, 400);
    const actions = db.prepare('SELECT action FROM audit ORDER BY id').all().map((a) => a.action);
    assert.ok(actions.includes('token.create') && actions.includes('token.delete'));
  });
});

test('změna hesla: ověření současného, délka, zneplatnění starých session', async () => {
  await withAuthApp(async ({ api, login }) => {
    const a = await login();
    const b = await login();
    let r = await api('POST', '/api/v1/settings/password', { cookie: a.cookie, body: { current: 'spatne', new: 'NoveHeslo-456' } });
    assert.strictEqual(r.status, 400);
    assert.match(r.json().error.message, /Současné heslo/);
    r = await api('POST', '/api/v1/settings/password', { cookie: a.cookie, body: { current: PASSWORD, new: 'kratke' } });
    assert.strictEqual(r.status, 400);
    assert.match(r.json().error.message, /alespoň 8/);
    r = await api('POST', '/api/v1/settings/password', { cookie: a.cookie, body: { current: PASSWORD, new: 'NoveHeslo-456' } });
    assert.strictEqual(r.status, 200);
    const newCookie = r.headers['set-cookie'][0].split(';')[0];
    // stará session (i jiná) neplatí, nová ano
    assert.strictEqual((await api('GET', '/api/v1/auth/me', { cookie: a.cookie })).status, 401);
    assert.strictEqual((await api('GET', '/api/v1/auth/me', { cookie: b.cookie })).status, 401);
    assert.strictEqual((await api('GET', '/api/v1/auth/me', { cookie: newCookie })).status, 200);
    assert.strictEqual((await login(PASSWORD)).r.status, 401);
    assert.strictEqual((await login('NoveHeslo-456')).r.status, 200);
  });
});

test('heslo z env: přihlášení funguje, změna v aplikaci → 409', async () => {
  await withAuthApp(async ({ api, login }) => {
    assert.strictEqual((await login('spatne')).r.status, 401);
    const { r, cookie } = await login('Env-Heslo-789');
    assert.strictEqual(r.status, 200);
    const me = await api('GET', '/api/v1/auth/me', { cookie });
    assert.strictEqual(me.json().password_from_env, true);
    const ch = await api('POST', '/api/v1/settings/password', { cookie, body: { current: 'Env-Heslo-789', new: 'NoveHeslo-456' } });
    assert.strictEqual(ch.status, 409);
  }, { config: { password: 'Env-Heslo-789' }, initialPassword: null });
});

test('odhlášení smaže cookie', async () => {
  await withAuthApp(async ({ api, login }) => {
    const { cookie } = await login();
    const r = await api('POST', '/api/v1/auth/logout', { cookie });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers['set-cookie'][0], /^ct_session=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0/);
    assert.strictEqual(r.headers['set-cookie'].length, 1);
    // bez cookie je odhlášení také OK
    assert.strictEqual((await api('POST', '/api/v1/auth/logout')).status, 200);
  });
});

test('requireScope / hasScope', () => {
  assert.strictEqual(auth.hasScope(['read'], 'read'), true);
  assert.strictEqual(auth.hasScope(['read'], 'admin'), false);
  assert.strictEqual(auth.hasScope(['admin'], 'import'), true);
  assert.strictEqual(auth.hasScope(['export'], ['read', 'export']), true);
  assert.strictEqual(auth.hasScope([], 'any'), false);
  assert.strictEqual(auth.hasScope(['import'], 'any'), true);
  assert.throws(() => auth.requireScope({ user: null, scopes: [] }, 'read'), (e) => e.status === 401);
  assert.throws(() => auth.requireScope({ user: 'x', scopes: ['read'] }, 'export'), (e) => e.status === 403);
  assert.doesNotThrow(() => auth.requireScope({ user: null }, 'public'));
  assert.deepStrictEqual(auth.normalizeScopes('admin, read'), ['read', 'admin']);
  assert.strictEqual(auth.normalizeScopes(['read', 'root']), null);
  assert.strictEqual(auth.safeEqual('abc', 'abc'), true);
  assert.strictEqual(auth.safeEqual('abc', 'abd'), false);
  assert.strictEqual(auth.safeEqual('abc', 'abcd'), false);
});
