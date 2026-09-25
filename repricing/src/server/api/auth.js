'use strict';
// API: přihlášení, odhlášení, informace o uživateli, změna hesla, API tokeny a health check.
//
//   GET    /api/v1/health             public  → {ok, version, time}
//   POST   /api/v1/auth/login         public  {password} → {ok: true} + cookie ct_session (429 po 10 chybách / 15 min / IP)
//   POST   /api/v1/auth/logout        public  → {ok: true} + smazání cookie
//   GET    /api/v1/auth/me            any     → {user, scopes, via, token?, password_from_env}
//   POST   /api/v1/settings/password  admin   {current, new} → {ok: true} (+ nová cookie, staré session neplatí)
//   GET    /api/v1/tokens             admin   → {items: [{id, name, prefix, scopes, created_at, last_used_at}]}
//   POST   /api/v1/tokens             admin   {name, scopes} → {id, token, prefix, scopes, name, created_at} (token jen jednou)
//   DELETE /api/v1/tokens/:id         admin   → {ok: true}

const auth = require('../auth');
const { HttpError, intParam } = require('../http');

let cachedVersion = null;
function appVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    cachedVersion = require('../../../package.json').version || '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

function bodyObject(ctx) {
  const b = ctx.body;
  if (b == null || typeof b !== 'object' || Array.isArray(b) || Buffer.isBuffer(b)) {
    throw new HttpError(400, 'Očekáván JSON objekt v těle požadavku.');
  }
  return b;
}

/**
 * @param {object} router
 * @param {{loginLimiter?: ReturnType<typeof auth.createLoginLimiter>}} [deps]
 */
function register(router, deps = {}) {
  // Limiter žije s instancí aplikace (každý createApp má vlastní).
  const limiter = deps.loginLimiter || auth.createLoginLimiter();

  router.get(
    '/api/v1/health',
    (ctx) => {
      let ok = true;
      try {
        ctx.db.prepare('SELECT 1').get();
      } catch {
        ok = false;
      }
      if (!ok) ctx.status = 503;
      return { ok, version: appVersion(), time: new Date().toISOString() };
    },
    { auth: 'public' }
  );

  router.post(
    '/api/v1/auth/login',
    async (ctx) => {
      const lim = limiter.check(ctx.ip, ctx.now);
      if (lim.limited) {
        throw new HttpError(
          429,
          `Příliš mnoho neúspěšných pokusů o přihlášení. Zkuste to znovu za ${Math.ceil(lim.retryAfterSec / 60)} min.`,
          { retry_after: lim.retryAfterSec },
          { headers: { 'Retry-After': lim.retryAfterSec } }
        );
      }
      const body = bodyObject(ctx);
      const password = body.password;
      if (typeof password !== 'string' || password === '') throw new HttpError(400, 'Zadejte heslo.');
      const ok = await auth.verifyPassword(ctx.db, ctx.config, password);
      if (!ok) {
        const remaining = limiter.fail(ctx.ip, ctx.now);
        try {
          ctx.audit({ action: 'auth.login_failed', detail: { ip: ctx.ip } });
        } catch {
          /* audit nesmí přihlášení shodit */
        }
        throw new HttpError(401, 'Nesprávné heslo.', { remaining_attempts: remaining });
      }
      limiter.reset(ctx.ip);
      auth.issueSession(ctx, { now: ctx.now });
      ctx.user = auth.SESSION_USER;
      try {
        ctx.audit({ action: 'auth.login', detail: { ip: ctx.ip } });
      } catch {
        /* nic */
      }
      return { ok: true };
    },
    { auth: 'public' }
  );

  router.post(
    '/api/v1/auth/logout',
    (ctx) => {
      auth.clearSession(ctx);
      return { ok: true };
    },
    { auth: 'public' }
  );

  router.get(
    '/api/v1/auth/me',
    (ctx) => {
      const out = { user: ctx.user, scopes: ctx.scopes, via: ctx.via, password_from_env: auth.passwordFromEnv(ctx.config) };
      if (ctx.token) out.token = ctx.token;
      if (ctx.session) out.expires_at = new Date(ctx.session.exp).toISOString();
      return out;
    },
    { auth: 'any' }
  );

  router.post(
    '/api/v1/settings/password',
    async (ctx) => {
      const body = bodyObject(ctx);
      if (auth.passwordFromEnv(ctx.config)) {
        throw new HttpError(409, 'Heslo je nastaveno proměnnou prostředí CENOTVORBA_PASSWORD – v aplikaci ho nelze změnit.');
      }
      const current = body.current;
      const next = body.new ?? body.new_password;
      if (typeof current !== 'string' || !current) throw new HttpError(400, 'Zadejte současné heslo.');
      if (typeof next !== 'string' || !next) throw new HttpError(400, 'Zadejte nové heslo.');
      const lim = limiter.check(ctx.ip, ctx.now);
      if (lim.limited) {
        throw new HttpError(429, 'Příliš mnoho neúspěšných pokusů. Zkuste to později.', { retry_after: lim.retryAfterSec }, { headers: { 'Retry-After': lim.retryAfterSec } });
      }
      if (!(await auth.verifyPassword(ctx.db, ctx.config, current))) {
        limiter.fail(ctx.ip, ctx.now);
        throw new HttpError(400, 'Současné heslo není správné.', { field: 'current' });
      }
      auth.setPassword(ctx.db, next, ctx.config);
      // všechny session jsou teď neplatné – aktuálnímu uživateli (session) vydáme novou
      if (ctx.via === 'session') auth.issueSession(ctx, { now: ctx.now });
      ctx.audit({ action: 'auth.password_change', entity: 'settings' });
      return { ok: true };
    },
    { auth: 'admin' }
  );

  router.get('/api/v1/tokens', (ctx) => ({ items: auth.listTokens(ctx.db) }), { auth: 'admin' });

  router.post(
    '/api/v1/tokens',
    (ctx) => {
      const body = bodyObject(ctx);
      const created = auth.createToken(ctx.db, { name: body.name, scopes: body.scopes });
      ctx.audit({ action: 'token.create', entity: 'token', entity_id: created.id, detail: { name: created.name, prefix: created.prefix, scopes: created.scopes } });
      return created;
    },
    { auth: 'admin' }
  );

  router.delete(
    '/api/v1/tokens/:id',
    (ctx) => {
      const id = intParam(ctx, 'id');
      if (!auth.deleteToken(ctx.db, id)) throw new HttpError(404, 'Token nenalezen.');
      ctx.audit({ action: 'token.delete', entity: 'token', entity_id: id });
      return { ok: true };
    },
    { auth: 'admin' }
  );

  return { limiter };
}

module.exports = { register, appVersion };
