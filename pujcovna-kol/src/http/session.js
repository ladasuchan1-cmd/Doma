'use strict';
// Server-side session v tabulce sessions (SPEC kap. 3). Dva oddělené profily:
//   public: cookie __Host-pk_sid, SameSite=Lax,    idle 2 h,    absolutní 24 h  (rozepsaná rezervace)
//   admin:  cookie __Host-pk_adm, SameSite=Strict, idle 30 min, absolutní 8 h   (samostatná session, regenerate po loginu)
// Cookie nese 32 B náhodné ID (base64url); v DB je jen SHA-256 otisk. HttpOnly; Path=/; Secure na https / za proxy.
// Pozn.: prefix __Host- vyžaduje v prohlížeči atribut Secure – na http://localhost ho moderní prohlížeče přijmou
// (localhost je „potentially trustworthy“), proto Secure nastavujeme i pro localhost/127.0.0.1 (viz isLocalHost).
// Handle je líný: z DB se čte až při prvním get()/csrf(); řádek vzniká až při prvním set()/csrf()/regenerate().
// Vstup: { db, req, res, kind, secure, ipHash, now }. Výstup: handle { get, set, delete, all, csrf, exists, userId,
// setUser, regenerate, destroy, id }.

const crypto = require('node:crypto');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const PROFILES = Object.freeze({
  public: Object.freeze({ kind: 'public', cookie: '__Host-pk_sid', idleMs: 2 * HOUR, absoluteMs: 24 * HOUR, sameSite: 'Lax' }),
  admin: Object.freeze({ kind: 'admin', cookie: '__Host-pk_adm', idleMs: 30 * MINUTE, absoluteMs: 8 * HOUR, sameSite: 'Strict' }),
  // správa platformy /platforma (pozvánky do průvodce, klienti) – heslo z PK_PLATFORMA_HESLO, nezávislé na adminu půjčovny
  platform: Object.freeze({ kind: 'platform', cookie: '__Host-pk_plat', idleMs: 30 * MINUTE, absoluteMs: 8 * HOUR, sameSite: 'Strict' }),
});

const TOUCH_THROTTLE_MS = 60 * 1000;
const ID_BYTES = 32;

function hashId(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex');
}

function isLocalHost(hostHeader) {
  const h = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

/** Rozparsuje hlavičku Cookie → objekt (první výskyt jména vyhrává). */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || Object.hasOwn(out, name)) continue;
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
    try {
      out[name] = decodeURIComponent(val);
    } catch {
      out[name] = val;
    }
  }
  return out;
}

/** Sestaví hodnotu Set-Cookie. */
function serializeCookie(name, value, { maxAgeSec, path = '/', httpOnly = true, secure = false, sameSite = 'Lax', expires } = {}) {
  if (!/^[A-Za-z0-9_\-!#$%&'*+.^`|~]+$/.test(name)) throw new Error(`Neplatný název cookie: ${name}`);
  const parts = [`${name}=${encodeURIComponent(value ?? '')}`, `Path=${path}`];
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
  if (expires) parts.push(`Expires=${expires.toUTCString()}`);
  if (httpOnly) parts.push('HttpOnly');
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Přidá Set-Cookie do odpovědi; stejnojmennou cookie nahradí. */
function appendSetCookie(res, cookieStr) {
  const name = cookieStr.slice(0, cookieStr.indexOf('='));
  const prev = res.getHeader('Set-Cookie');
  const list = (prev == null ? [] : Array.isArray(prev) ? prev : [String(prev)]).filter((c) => !c.startsWith(name + '='));
  list.push(cookieStr);
  res.setHeader('Set-Cookie', list);
}

/**
 * Vytvoří handle session pro požadavek.
 * @param {{db: object, req: object, res: object, kind?: 'public'|'admin', secure?: boolean, ipHash?: string|null, now?: () => number}} opts
 */
function createSession({ db, req, res, kind = 'public', secure = false, ipHash = null, now = Date.now }) {
  const profile = PROFILES[kind];
  if (!profile) throw new Error(`Neznámý druh session: ${kind}`);
  const cookieSecure = secure || isLocalHost(req.headers.host);
  let loaded = false;
  let row = null; // řádek z DB (id_hash, user_id, data, csrf, created_at, last_seen_at, expires_at)
  let data = {};
  let currentId = null; // prostý identifikátor (jen pokud jsme ho v tomto požadavku vydali nebo přijali)

  function setCookie(id, expiresAtMs) {
    appendSetCookie(
      res,
      serializeCookie(profile.cookie, id, {
        maxAgeSec: Math.max(1, Math.floor((expiresAtMs - now()) / 1000)),
        httpOnly: true,
        secure: cookieSecure,
        sameSite: profile.sameSite,
      })
    );
  }

  function clearCookie() {
    appendSetCookie(res, serializeCookie(profile.cookie, '', { maxAgeSec: 0, httpOnly: true, secure: cookieSecure, sameSite: profile.sameSite, expires: new Date(0) }));
  }

  function load() {
    if (loaded) return;
    loaded = true;
    const cookies = parseCookies(req.headers.cookie);
    const id = cookies[profile.cookie];
    if (!id || typeof id !== 'string' || id.length < 20 || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) return;
    const idHash = hashId(id);
    const r = db.prepare('SELECT id_hash, kind, user_id, data, csrf, created_at, last_seen_at, expires_at FROM sessions WHERE id_hash = ?').get(idHash);
    if (!r || r.kind !== profile.kind) return;
    const t = now();
    const lastSeen = Date.parse(r.last_seen_at);
    const expiresAt = Date.parse(r.expires_at);
    if (!(expiresAt > t) || !(lastSeen + profile.idleMs > t)) {
      db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
      clearCookie();
      return;
    }
    row = r;
    currentId = id;
    try {
      data = JSON.parse(r.data || '{}') || {};
    } catch {
      data = {};
    }
    if (t - lastSeen > TOUCH_THROTTLE_MS) {
      const iso = new Date(t).toISOString();
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(iso, idHash);
      row.last_seen_at = iso;
    }
  }

  function create(userId = null) {
    const id = crypto.randomBytes(ID_BYTES).toString('base64url');
    const t = now();
    const createdAt = new Date(t).toISOString();
    const expiresAt = new Date(t + profile.absoluteMs).toISOString();
    const csrf = crypto.randomBytes(32).toString('base64url');
    row = { id_hash: hashId(id), kind: profile.kind, user_id: userId, data: JSON.stringify(data), csrf, created_at: createdAt, last_seen_at: createdAt, expires_at: expiresAt };
    db.prepare('INSERT INTO sessions(id_hash, kind, user_id, data, csrf, created_at, last_seen_at, expires_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      row.id_hash,
      row.kind,
      userId,
      row.data,
      csrf,
      createdAt,
      createdAt,
      expiresAt,
      ipHash
    );
    currentId = id;
    setCookie(id, t + profile.absoluteMs);
  }

  function ensure() {
    load();
    if (!row) create();
  }

  function persistData() {
    row.data = JSON.stringify(data);
    row.last_seen_at = new Date(now()).toISOString();
    db.prepare('UPDATE sessions SET data = ?, last_seen_at = ? WHERE id_hash = ?').run(row.data, row.last_seen_at, row.id_hash);
  }

  return {
    kind: profile.kind,
    cookieName: profile.cookie,
    /** Hodnota klíče (bez klíče celý objekt dat). Bez session → undefined / {}. */
    get(key) {
      load();
      if (key === undefined) return { ...data };
      return data[key];
    },
    all() {
      load();
      return { ...data };
    },
    set(key, value) {
      ensure();
      if (value === undefined) delete data[key];
      else data[key] = value;
      persistData();
    },
    delete(key) {
      load();
      if (!row) return;
      delete data[key];
      persistData();
    },
    /** Existuje platná session? */
    exists() {
      load();
      return !!row;
    },
    /** CSRF token (vytvoří session, pokud není). */
    csrf() {
      ensure();
      return row.csrf;
    },
    /** CSRF token bez vytváření session (pro ověření POSTu). */
    peekCsrf() {
      load();
      return row ? row.csrf : null;
    },
    /** Přihlášený uživatel (admin session). */
    userId() {
      load();
      return row ? row.user_id : null;
    },
    setUser(userId) {
      ensure();
      row.user_id = userId;
      db.prepare('UPDATE sessions SET user_id = ? WHERE id_hash = ?').run(userId, row.id_hash);
    },
    /** Nové ID (po přihlášení) – data i user_id zůstanou, absolutní lhůta běží znovu, nový CSRF token. */
    regenerate() {
      load();
      const keepUser = row ? row.user_id : null;
      if (row) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(row.id_hash);
      row = null;
      create(keepUser);
    },
    /** Smaže session v DB i cookie v prohlížeči. */
    destroy() {
      load();
      if (row) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(row.id_hash);
      row = null;
      data = {};
      currentId = null;
      clearCookie();
    },
    /** Otisk ID (pro audit) – null bez session. */
    idHash() {
      load();
      return row ? row.id_hash : null;
    },
    /** Prostý identifikátor – jen pro testy. */
    _id() {
      return currentId;
    },
  };
}

/** Úklid prošlých session (job). Vrací počet smazaných. */
function purgeExpired(db, now = Date.now()) {
  const t = new Date(now).toISOString();
  const idlePublic = new Date(now - PROFILES.public.idleMs).toISOString();
  const idleAdmin = new Date(now - PROFILES.admin.idleMs).toISOString();
  return Number(
    db
      .prepare(
        "DELETE FROM sessions WHERE expires_at <= ? OR (kind = 'public' AND last_seen_at <= ?) OR (kind = 'admin' AND last_seen_at <= ?)"
      )
      .run(t, idlePublic, idleAdmin).changes
  );
}

module.exports = { PROFILES, createSession, parseCookies, serializeCookie, appendSetCookie, hashId, purgeExpired, isLocalHost };
