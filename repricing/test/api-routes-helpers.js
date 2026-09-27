'use strict';
// Pomocníci pro integrační testy API rout (test/api-*.test.js). Sám o sobě není testem.
//  - startApp(): skutečný server (server.js start) nad ':memory:' DB, bez plánovače, s tichým logem
//  - client: fetch s přihlášenou session (cookie + X-Requested-With) nebo s API tokenem
//  - seed*: data vkládaná čistým SQL (nezávislé na src/import)

const { createLogger } = require('../src/util/log');
const { nowIso } = require('../src/db');
const { codeKey, eanKey, nameKey } = require('../src/util/keys');
const auth = require('../src/server/auth');

const PASSWORD = 'testovaci-heslo-123';

/** Spustí server a vrátí {url, db, stop, session(), token(scopes)}. */
async function startApp() {
  const { start } = require('../server.js');
  const app = await start({
    dbFile: ':memory:',
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    schedulerEnabled: false,
    password: PASSWORD,
    log: createLogger({ level: 'silent' }),
  });
  const url = `http://127.0.0.1:${app.port}`;
  let cookie = null;
  async function login() {
    const res = await fetch(url + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    if (res.status !== 200) throw new Error(`přihlášení selhalo: ${res.status}`);
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
    cookie = set.map((c) => c.split(';')[0]).join('; ');
    return cookie;
  }
  await login();
  return {
    url,
    db: app.db,
    app,
    stop: () => app.stop(),
    /** Klient se session (UI). */
    session: () => client(url, { cookie }),
    /** Klient s API tokenem daných rozsahů. */
    token(scopes, name = 'test-' + scopes.join('-')) {
      const t = auth.createToken(app.db, { name, scopes });
      return Object.assign(client(url, { token: t.token }), { value: t.token });
    },
    anon: () => client(url, {}),
  };
}

/**
 * Jednoduchý HTTP klient. Odpověď: {status, headers, body (Buffer), text, json}.
 */
function client(url, { cookie = null, token = null } = {}) {
  async function req(method, path, body, extra = {}) {
    const headers = { ...(extra.headers || {}) };
    if (cookie) {
      headers.Cookie = cookie;
      if (method !== 'GET' && method !== 'HEAD' && extra.csrf !== false) headers['X-Requested-With'] = 'cenotvorba';
    }
    if (token && extra.tokenInQuery !== true) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
      if (Buffer.isBuffer(body) || typeof body === 'string') payload = body;
      else {
        payload = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
      }
    }
    let p = path;
    if (token && extra.tokenInQuery === true) p += (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
    const res = await fetch(url + p, { method, headers, body: payload });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, body: buf, text, json };
  }
  return {
    get: (p, extra) => req('GET', p, undefined, extra),
    post: (p, body, extra) => req('POST', p, body ?? {}, extra),
    put: (p, body, extra) => req('PUT', p, body ?? {}, extra),
    patch: (p, body, extra) => req('PATCH', p, body ?? {}, extra),
    del: (p, extra) => req('DELETE', p, undefined, extra),
    req,
  };
}

/** Query string z objektu (null/undefined vynechá). */
function qs(obj) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v != null) sp.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  const s = sp.toString();
  return s ? '?' + s : '';
}

// ---------------------------------------------------------------------------------------------------------
// Data

function insertCompetitor(db, name, { enabled = 1, tags = [], label = null } = {}) {
  return Number(
    db.prepare('INSERT INTO competitors (name, name_key, label, enabled, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(name, nameKey(name), label, enabled, JSON.stringify(tags), nowIso()).lastInsertRowid
  );
}

function insertProduct(db, p) {
  const now = nowIso();
  const row = {
    code: p.code,
    code_key: codeKey(p.code),
    ean: p.ean ?? null,
    ean_key: p.ean ? eanKey(p.ean) : null,
    name: p.name ?? p.code,
    manufacturer: p.manufacturer ?? null,
    category: p.category ?? null,
    supplier: p.supplier ?? null,
    owner: p.owner ?? null,
    purchase_price: p.purchase_price ?? null,
    price: p.price ?? null,
    vat_rate: p.vat_rate ?? 21,
    msrp: p.msrp ?? null,
    stock: p.stock ?? 5,
    sales_30: p.sales_30 ?? 1,
    sales_90: p.sales_90 ?? 3,
    attrs: JSON.stringify(p.attrs ?? {}),
    active: p.active ?? 1,
    locked: p.locked ?? 0,
    locked_until: p.locked_until ?? null,
    min_price: p.min_price ?? null,
    max_price: p.max_price ?? null,
    note: p.note ?? null,
    price_changed_at: p.price_changed_at ?? null,
    group_code: p.group_code ?? null,
    created_at: now,
    updated_at: now,
  };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO products (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c])).lastInsertRowid);
}

function insertOffer(db, productId, competitorId, price, extra = {}) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO offers (product_id, competitor_id, price, shipping, in_stock, delivery_days, url, name, observed_at, first_seen_at, prev_price, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(productId, competitorId, price, extra.shipping ?? null, extra.in_stock ?? 1, extra.delivery_days ?? null, extra.url ?? null, extra.name ?? null, extra.observed_at ?? now, extra.first_seen_at ?? now, extra.prev_price ?? null, extra.changed_at ?? null);
}

function insertSegment(db, name, filter) {
  const now = nowIso();
  return Number(db.prepare('INSERT INTO segments (name, filter, created_at, updated_at) VALUES (?, ?, ?, ?)').run(name, JSON.stringify(filter), now, now).lastInsertRowid);
}

function insertStrategy(db, { name, segment_id = null, priority = 100, enabled = 1, config = {} }) {
  const now = nowIso();
  return Number(
    db.prepare('INSERT INTO strategies (name, segment_id, priority, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(name, segment_id, priority, enabled, JSON.stringify(config), now, now).lastInsertRowid
  );
}

/**
 * Malý deterministický katalog:
 *  - 3 konkurenti (VeloMarket.cz, KoloPointer.cz, Vypnutý.cz – vypnutý)
 *  - produkty P1..P6 (P5 neaktivní, P6 bez nákupní ceny a pod nákladem…)
 *  - segment „Focus“ + strategie „Podstřel minimum“ (undercut_min −1 %, bez zaokrouhlení limitů)
 */
function seedBasic(db) {
  const c1 = insertCompetitor(db, 'VeloMarket.cz', { tags: ['klíčový'] });
  const c2 = insertCompetitor(db, 'KoloPointer.cz');
  const c3 = insertCompetitor(db, 'Vypnutý.cz', { enabled: 0 });
  const ids = {};
  ids.P1 = insertProduct(db, { code: 'P1', ean: '8590000000011', name: 'Focus Jam 2026 vel. M', manufacturer: 'Focus', category: 'Horská kola', owner: 'Jana', supplier: 'PON', purchase_price: 50000, price: 79990, msrp: 84990, attrs: { N: 'N2', sezona: 2026 } });
  ids.P2 = insertProduct(db, { code: 'P2', ean: '8590000000028', name: 'Cervélo Áspero', manufacturer: 'Cervélo', category: 'Gravel', owner: 'Petr', supplier: 'PON', purchase_price: 40000, price: 64990, msrp: 69990, attrs: { N: 'N7', sezona: 2024 } });
  ids.P3 = insertProduct(db, { code: 'P3', ean: '8590000000035', name: 'Schwalbe Nobby Nic', manufacturer: 'Schwalbe', category: 'Pláště', owner: 'Lucie', supplier: 'Schwalbe CZ', purchase_price: 700, price: 1290, msrp: 1390, attrs: { N: 'N1', sezona: 2026 } });
  ids.P4 = insertProduct(db, { code: 'P4', ean: '8590000000042', name: 'Abus Bordo 6500', manufacturer: 'Abus', category: 'Příslušenství', owner: 'Lucie', supplier: 'Abus CZ', purchase_price: 2000, price: 2190, msrp: 2490, attrs: { N: 'N8', sezona: 2025 } });
  ids.P5 = insertProduct(db, { code: 'P5', name: 'Starý model (neaktivní)', manufacturer: 'Focus', category: 'Horská kola', purchase_price: 10000, price: 19990, active: 0 });
  ids.P6 = insertProduct(db, { code: 'P6', name: 'Žlutá lahev', manufacturer: 'Elite', category: 'Příslušenství', purchase_price: null, price: 199, attrs: { N: 'N0' } });
  // nabídky
  insertOffer(db, ids.P1, c1, 76990);
  insertOffer(db, ids.P1, c2, 78990);
  insertOffer(db, ids.P1, c3, 50000); // vypnutý konkurent → ignorován
  insertOffer(db, ids.P2, c1, 66990);
  insertOffer(db, ids.P3, c1, 1190, { prev_price: 1390, changed_at: nowIso() }); // pokles o 14 % za 24 h
  insertOffer(db, ids.P3, c2, 1250);
  insertOffer(db, ids.P4, c2, 1990); // konkurence pod naším nákupem (1990 / 1,21 < 2000)
  const segFocus = insertSegment(db, 'Focus', { field: 'manufacturer', op: '=', value: 'focus' });
  const segLezaky = insertSegment(db, 'Ležáky', { field: 'attrs.N', op: 'in', value: ['N7', 'N8'] });
  const loose = {
    target: { mode: 'undercut_min', offset_pct: -1 },
    limits: { min_margin_pct: 5, max_decrease_pct: 20, max_increase_pct: 20, max_above_msrp_pct: null, min_change_pct: 0, min_change_abs: 1 },
    rounding: { mode: 'integer', direction: 'down' },
  };
  const stAll = insertStrategy(db, { name: 'Podstřel minimum', priority: 100, config: loose });
  return { competitors: { c1, c2, c3 }, products: ids, segments: { focus: segFocus, lezaky: segLezaky }, strategies: { all: stAll } };
}

module.exports = { startApp, client, qs, seedBasic, insertCompetitor, insertProduct, insertOffer, insertSegment, insertStrategy, PASSWORD };
