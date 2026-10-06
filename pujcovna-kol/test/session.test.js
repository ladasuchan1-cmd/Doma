'use strict';
// Testy src/http/session.js – jednotkově nad DB v paměti s mock req/res.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession, PROFILES, hashId, purgeExpired, parseCookies, serializeCookie } = require('../src/http/session');
const { memoryDb, mockReqRes } = require('./helpers');

function cookieFromRes(res, name) {
  const list = res.getHeader('Set-Cookie') || [];
  const c = list.find((x) => x.startsWith(name + '='));
  return c || null;
}

test('session: profily podle SPEC', () => {
  assert.equal(PROFILES.public.cookie, '__Host-pk_sid');
  assert.equal(PROFILES.public.idleMs, 2 * 3600 * 1000);
  assert.equal(PROFILES.public.absoluteMs, 24 * 3600 * 1000);
  assert.equal(PROFILES.public.sameSite, 'Lax');
  assert.equal(PROFILES.admin.cookie, '__Host-pk_adm');
  assert.equal(PROFILES.admin.idleMs, 30 * 60 * 1000);
  assert.equal(PROFILES.admin.absoluteMs, 8 * 3600 * 1000);
  assert.equal(PROFILES.admin.sameSite, 'Strict');
});

test('session: líné vytvoření, cookie s otiskem v DB, čtení v dalším požadavku', () => {
  const db = memoryDb();
  let now = 1_700_000_000_000;
  const clock = () => now;
  const { req, res } = mockReqRes();
  const s = createSession({ db, req, res, kind: 'public', now: clock });
  assert.equal(s.exists(), false);
  assert.equal(res.getHeader('Set-Cookie'), undefined, 'bez set() žádná cookie');
  s.set('draft', { typ: 1 });
  const cookie = cookieFromRes(res, '__Host-pk_sid');
  assert.ok(cookie, 'cookie nastavena');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Secure/, 'localhost → Secure (prohlížeče ho přijmou, __Host- ho vyžaduje)');
  const id = s._id();
  assert.equal(id.length, 43, '32 B base64url');
  const row = db.prepare('SELECT * FROM sessions').get();
  assert.equal(row.id_hash, hashId(id));
  assert.equal(row.kind, 'public');
  assert.ok(!row.id_hash.includes(id));
  assert.equal(JSON.parse(row.data).draft.typ, 1);
  assert.ok(row.csrf.length > 20);

  // další požadavek s cookie
  now += 5 * 60 * 1000;
  const r2 = mockReqRes({ headers: { cookie: `__Host-pk_sid=${id}` } });
  const s2 = createSession({ db, req: r2.req, res: r2.res, kind: 'public', now: clock });
  assert.equal(s2.exists(), true);
  assert.deepEqual(s2.get('draft'), { typ: 1 });
  assert.equal(s2.csrf(), row.csrf);
  assert.equal(s2.peekCsrf(), row.csrf);
  assert.equal(db.prepare('SELECT last_seen_at FROM sessions').get().last_seen_at, new Date(now).toISOString(), 'touch last_seen_at');

  // admin profil nevidí public session
  const r3 = mockReqRes({ headers: { cookie: `__Host-pk_sid=${id}` } });
  const adm = createSession({ db, req: r3.req, res: r3.res, kind: 'admin', now: clock });
  assert.equal(adm.exists(), false);
  db.close();
});

test('session: idle expirace 2 h a absolutní 24 h', () => {
  const db = memoryDb();
  let now = 1_700_000_000_000;
  const clock = () => now;
  const a = mockReqRes();
  const s = createSession({ db, req: a.req, res: a.res, kind: 'public', now: clock });
  s.set('x', 1);
  const id = s._id();

  now += 2 * 3600 * 1000 + 1000; // idle překročen
  const b = mockReqRes({ headers: { cookie: `__Host-pk_sid=${id}` } });
  const s2 = createSession({ db, req: b.req, res: b.res, kind: 'public', now: clock });
  assert.equal(s2.exists(), false, 'po 2 h nečinnosti session neplatí');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'prošlý řádek smazán');
  assert.match(cookieFromRes(b.res, '__Host-pk_sid'), /Max-Age=0/);

  // absolutní limit: pravidelná aktivita, ale po 24 h konec
  now = 1_700_000_000_000;
  const c = mockReqRes();
  const s3 = createSession({ db, req: c.req, res: c.res, kind: 'public', now: clock });
  s3.set('x', 1);
  const id3 = s3._id();
  for (let i = 0; i < 23; i++) {
    now += 3600 * 1000;
    const r = mockReqRes({ headers: { cookie: `__Host-pk_sid=${id3}` } });
    assert.equal(createSession({ db, req: r.req, res: r.res, kind: 'public', now: clock }).exists(), true, `hodina ${i + 1}`);
  }
  now += 3600 * 1000 + 1000;
  const r = mockReqRes({ headers: { cookie: `__Host-pk_sid=${id3}` } });
  assert.equal(createSession({ db, req: r.req, res: r.res, kind: 'public', now: clock }).exists(), false, 'po 24 h absolutně');
  db.close();
});

test('session: regenerate mění ID a CSRF, zachová data i uživatele; destroy maže', () => {
  const db = memoryDb();
  db.prepare("INSERT INTO users(id, email, name, password_hash, role, created_at) VALUES (7, 'a@b.cz', 'A', 'x', 'owner', '2026-01-01T00:00:00.000Z')").run();
  const a = mockReqRes();
  const s = createSession({ db, req: a.req, res: a.res, kind: 'admin' });
  s.set('k', 'v');
  s.setUser(7);
  const id1 = s._id();
  const csrf1 = s.csrf();
  s.regenerate();
  const id2 = s._id();
  assert.notEqual(id1, id2);
  assert.notEqual(s.csrf(), csrf1);
  assert.equal(s.get('k'), 'v');
  assert.equal(s.userId(), 7);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1, 'starý řádek smazán');
  assert.equal(db.prepare('SELECT id_hash FROM sessions').get().id_hash, hashId(id2));
  assert.match(cookieFromRes(a.res, '__Host-pk_adm'), /SameSite=Strict/);
  s.destroy();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal(s.exists(), false);
  assert.match(cookieFromRes(a.res, '__Host-pk_adm'), /Max-Age=0/);
  db.close();
});

test('session: neplatné cookie hodnoty se ignorují, purgeExpired maže', () => {
  const db = memoryDb();
  const r = mockReqRes({ headers: { cookie: "__Host-pk_sid=' OR 1=1 --" } });
  assert.equal(createSession({ db, req: r.req, res: r.res }).exists(), false);
  const now = 1_700_000_000_000;
  const a = mockReqRes();
  createSession({ db, req: a.req, res: a.res, now: () => now }).set('x', 1);
  assert.equal(purgeExpired(db, now + 3 * 3600 * 1000), 1);
  db.close();
});

test('parseCookies a serializeCookie', () => {
  assert.deepEqual(parseCookies('a=1; b="x y"; a=2; c=%C5%99'), { a: '1', b: 'x y', c: 'ř' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.equal(serializeCookie('n', 'v', { maxAgeSec: 10, secure: true, sameSite: 'Strict' }), 'n=v; Path=/; Max-Age=10; HttpOnly; SameSite=Strict; Secure');
  assert.throws(() => serializeCookie('bad name', 'v'));
});
