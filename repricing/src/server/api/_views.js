'use strict';
// Sdílená vrstva pro API routy:
//  1) cache pohledů na produkty (View = engine metrics.productView) + členství v segmentech + otevřené návrhy,
//  2) drobní pomocníci pro validaci vstupů a převod chyb modulů na HttpError.
//
// ── Cache pohledů ────────────────────────────────────────────────────────────────────────────────────────
// Seznam produktů, facety, počty v segmentech, pole pro filtry i přehled potřebují View pro VŠECHNY produkty
// (30 000+). Stavba trvá ~1 s, proto se výsledek drží v paměti (per databáze) a znovu staví jen při změně dat:
//  - „brána“: SELECT total_changes() (zápisy tímto spojením) + PRAGMA data_version (zápisy jiných spojení).
//    Když se ani jedno nezměnilo, data se určitě nezměnila → žádné další dotazy (teplý požadavek ~ms).
//  - když se brána pohne (třeba jen zápis do auditu), spočítají se levné otisky dotčených tabulek
//    (products, offers + offer_history, competitors, settings | segments | proposals) a přestaví se jen ta část,
//    jejíž otisk se změnil.
//  - pohled závisí i na čase (stáří nabídek, platnost zámku, dny od změny ceny) → po VIEW_TTL_MS se přestaví.
//  - routy po vlastních zápisech volají invalidate(db) (pojistka pro změny, které otisk nezachytí, např. poznámka
//    uložená ve stejné milisekundě).
// View objekty v cache jsou sdílené – volající je NESMÍ měnit (do odpovědi dávat kopii {...view, …}).

const { getSettings, parseJson } = require('../../db');
const { fold } = require('../../util/keys');
const { round } = require('../../util/num');
const { loadProducts, loadOffers } = require('../../engine/run');
const { productView, FIELDS, discoverAttrFields } = require('../../engine/metrics');
const { compileFilter, validateFilter, makeGetter } = require('../../engine/filter');
const { HttpError } = require('../http');

const VIEW_TTL_MS = 5 * 60 * 1000;
const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'exported', 'superseded'];

const collator = new Intl.Collator('cs-CZ', { numeric: true });

// ---------------------------------------------------------------------------------------------------------
// Pomocníci – validace a chyby

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v);
}

/** Tělo požadavku jako JSON objekt, jinak 400. */
function bodyObject(ctx) {
  const b = ctx.body;
  if (!isPlainObject(b)) throw new HttpError(400, 'Očekáván JSON objekt v těle požadavku.');
  return b;
}

/**
 * Převede chybu modulu (import/engine/export) s `status` 4xx na HttpError se stejnou zprávou; jinak ji propustí.
 * Moduly nastavují `status` bez `expose` → framework by z nich udělal 500.
 */
function toClientError(err) {
  if (err instanceof HttpError) return err;
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    const details = err.details ?? err.errors ?? (err.skipped ? { skipped: err.skipped } : null);
    const e = new HttpError(err.status, err.message, details);
    if (err.code) e.code = err.code;
    return e;
  }
  return err;
}

/**
 * Číslo ze vstupu (JSON číslo nebo číselný řetězec). Vrací undefined, když klíč chybí.
 * @param {*} v hodnota
 * @param {string} label český název pole do chybové zprávy
 * @param {{nullable?: boolean, positive?: boolean, min?: number, max?: number, integer?: boolean}} [o]
 */
function numberInput(v, label, o = {}) {
  if (v === undefined) return undefined;
  if (v === null || v === '') {
    if (o.nullable) return null;
    throw new HttpError(400, `${label}: hodnota je povinná.`);
  }
  let n = v;
  if (typeof v === 'string') n = Number(v.trim().replace(/\s+/g, '').replace(',', '.'));
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new HttpError(400, `${label}: musí být číslo.`);
  if (o.integer && !Number.isInteger(n)) throw new HttpError(400, `${label}: musí být celé číslo.`);
  if (o.positive && !(n > 0)) throw new HttpError(400, `${label}: musí být kladné číslo${o.nullable ? ' (nebo null)' : ''}.`);
  if (o.min != null && n < o.min) throw new HttpError(400, `${label}: nejmenší povolená hodnota je ${o.min}.`);
  if (o.max != null && n > o.max) throw new HttpError(400, `${label}: největší povolená hodnota je ${o.max}.`);
  return n;
}

/** Logická hodnota ze vstupu (true/false, 1/0, "1"/"0", "true"/"false"). undefined = chybí. */
function boolInput(v, label) {
  if (v === undefined) return undefined;
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  throw new HttpError(400, `${label}: musí být logická hodnota (true/false).`);
}

/** Text ze vstupu (ořezaný; prázdný → null, pokud nullable). */
function textInput(v, label, { nullable = true, max = 10000 } = {}) {
  if (v === undefined) return undefined;
  if (v === null) {
    if (nullable) return null;
    throw new HttpError(400, `${label}: hodnota je povinná.`);
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, `${label}: musí být text.`);
  const s = String(v).trim();
  if (!s) {
    if (nullable) return null;
    throw new HttpError(400, `${label}: hodnota je povinná.`);
  }
  if (s.length > max) throw new HttpError(400, `${label}: text je příliš dlouhý (max. ${max} znaků).`);
  return s;
}

/** Pole kladných celých čísel (id). */
function idArray(v, label) {
  if (!Array.isArray(v)) throw new HttpError(400, `${label}: očekáváno pole id.`);
  const out = [];
  for (const x of v) {
    const n = typeof x === 'string' && /^\d+$/.test(x.trim()) ? Number(x.trim()) : x;
    if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, `${label}: neplatné id „${x}“.`);
    out.push(n);
  }
  return [...new Set(out)];
}

/** Id z query parametru (kladné celé číslo) nebo 400. */
function queryId(value, label) {
  const s = String(value).trim();
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(Number(s)) || Number(s) <= 0) {
    throw new HttpError(400, `Parametr „${label}“ musí být kladné celé číslo.`);
  }
  return Number(s);
}

/**
 * Filtr (SPEC §6.4) z query řetězce nebo objektu → {filter, match} nebo 400 s českými chybami.
 * Prázdný / chybějící filtr → match null.
 */
function parseFilterInput(input, label = 'filter') {
  if (input == null || input === '') return { filter: null, match: null };
  let f = input;
  if (typeof f === 'string') {
    try {
      f = JSON.parse(f);
    } catch {
      throw new HttpError(400, `Parametr „${label}“ není platný JSON.`, [`Parametr „${label}“ není platný JSON.`]);
    }
  }
  const { ok, errors } = validateFilter(f);
  if (!ok) throw new HttpError(400, `Neplatný filtr: ${errors.join('; ')}`, errors);
  return { filter: f, match: compileFilter(f) };
}

/** Řádek z DB → prostý objekt (node:sqlite vrací objekty s null prototypem). */
function plain(row) {
  return row ? { ...row } : row;
}

/** Porovnání hodnot pro řazení: čísla číselně, řetězce cs-CZ, null na konec (řeší volající). */
function compareValues(a, b) {
  const na = typeof a === 'number';
  const nb = typeof b === 'number';
  if (na && nb) return a - b;
  if (na) return -1;
  if (nb) return 1;
  return collator.compare(a, b);
}

/** Normalizovaná hodnota pro řazení: boolean → 0/1, prázdné → null, ostatní text. */
function sortValue(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (Array.isArray(v)) return v.length ? v.join(', ') : null;
  return JSON.stringify(v);
}

/**
 * Seřadí indexy podle hodnot (nuly/prázdné vždy na konci, shoda → pořadí vstupu = podle id).
 * @param {number[]} idx indexy
 * @param {(i: number) => *} valueOf hodnota pro index
 * @param {'asc'|'desc'} dir
 */
function sortIndices(idx, valueOf, dir) {
  const withVal = [];
  const nulls = [];
  for (const i of idx) {
    const v = sortValue(valueOf(i));
    if (v == null) nulls.push(i);
    else withVal.push([v, i]);
  }
  const mul = dir === 'desc' ? -1 : 1;
  withVal.sort((x, y) => compareValues(x[0], y[0]) * mul || x[1] - y[1]);
  const out = new Array(withVal.length + nulls.length);
  let k = 0;
  for (const [, i] of withVal) out[k++] = i;
  for (const i of nulls) out[k++] = i;
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Cache pohledů

const states = new WeakMap();

function stateOf(db) {
  let st = states.get(db);
  if (!st) {
    st = {
      gate: null,
      dirty: { views: true, segments: true, proposals: true },
      fp: { views: null, segments: null, proposals: null },
      views: null,
      segments: null,
      proposals: null,
      stmts: null,
    };
    states.set(db, st);
  }
  return st;
}

function stmts(db, st) {
  if (st.stmts) return st.stmts;
  st.stmts = {
    tc: db.prepare('SELECT total_changes() AS tc'),
    dv: db.prepare('PRAGMA data_version'),
    fpProducts: db.prepare(
      'SELECT count(*) AS c, max(id) AS mi, max(updated_at) AS mu, total(price) AS sp, total(purchase_price) AS spp, total(stock) AS ss, total(active) AS sa, total(locked) AS sl FROM products'
    ),
    fpOffers: db.prepare('SELECT count(*) AS c, max(observed_at) AS mo, total(price) AS sp, total(in_stock) AS si, total(shipping) AS ss FROM offers'),
    fpOfferHistory: db.prepare('SELECT max(id) AS m FROM offer_history'),
    fpCompetitors: db.prepare("SELECT group_concat(id || ':' || enabled || ':' || tags || ':' || coalesce(label, '') || ':' || name, '|') AS g FROM competitors"),
    fpSettings: db.prepare("SELECT group_concat(key || '=' || value, '|') AS g FROM (SELECT key, value FROM settings WHERE substr(key, 1, 1) <> '_' ORDER BY key)"),
    fpSegments: db.prepare("SELECT group_concat(id || ':' || updated_at || ':' || name || ':' || filter, '|') AS g FROM (SELECT * FROM segments ORDER BY id)"),
    fpProposals: db.prepare(
      "SELECT (SELECT max(id) FROM proposals) AS mi, count(*) AS c, total(coalesce(manual_price, 0)) AS sm, max(coalesce(decided_at, '')) AS md FROM proposals WHERE status IN ('pending', 'approved')"
    ),
    segments: db.prepare('SELECT id, name, description, filter, color, created_at, updated_at FROM segments ORDER BY id'),
    openProposals: db.prepare("SELECT id, product_id, status, old_price, new_price, change_pct, manual_price FROM proposals WHERE status IN ('pending', 'approved') ORDER BY id"),
  };
  return st.stmts;
}

const sig = (row) => JSON.stringify(row ? { ...row } : null);

function fingerprints(db, s) {
  return {
    views: [sig(s.fpProducts.get()), sig(s.fpOffers.get()), sig(s.fpOfferHistory.get()), sig(s.fpCompetitors.get()), sig(s.fpSettings.get())].join('#'),
    segments: sig(s.fpSegments.get()),
    proposals: sig(s.fpProposals.get()),
  };
}

const posNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** Postaví pohledy na všechny produkty (i neaktivní) + statistiky konkurentů. */
function buildViews(db) {
  const t0 = performance.now();
  const now = new Date();
  const settings = getSettings(db);
  const products = loadProducts(db, { activeOnly: false });
  const offersMap = loadOffers(db);
  const n = products.length;
  const views = new Array(n);
  const search = new Array(n);
  const byId = new Map();
  const active = [];
  // statistiky konkurentů (GET /competitors, přehled) – ze stejného průchodu nabídkami
  const comp = new Map();
  for (let i = 0; i < n; i++) {
    const p = products[i];
    const offers = offersMap.get(p.id) || [];
    const v = productView(p, offers, { now, settings });
    views[i] = v;
    byId.set(p.id, i);
    search[i] = fold([p.code, p.name, p.ean, p.mpn].filter((x) => x != null && x !== '').join(' '));
    const isActive = p.active === 1 || p.active === true;
    if (isActive) active.push(i);
    const ours = isActive ? posNum(typeof p.price === 'string' ? Number(p.price) : p.price) : null;
    for (const o of offers) {
      let c = comp.get(o.competitor_id);
      if (!c) comp.set(o.competitor_id, (c = { offers: 0, compared: 0, cheaper: 0, idxSum: 0, last_seen_at: null }));
      c.offers += 1;
      if (o.observed_at && (c.last_seen_at == null || o.observed_at > c.last_seen_at)) c.last_seen_at = o.observed_at;
      const theirs = posNum(o.price);
      if (ours != null && theirs != null) {
        c.compared += 1;
        c.idxSum += (theirs / ours) * 100;
        if (theirs < ours - 1e-9) c.cheaper += 1;
      }
    }
  }
  const competitorStats = new Map();
  for (const [id, c] of comp) {
    competitorStats.set(id, {
      offers: c.offers,
      compared: c.compared,
      products_cheaper_than_us: c.cheaper,
      cheaper_than_us_pct: c.compared ? round((c.cheaper / c.compared) * 100, 1) : null,
      avg_index: c.compared ? round(c.idxSum / c.compared, 1) : null,
      last_seen_at: c.last_seen_at,
    });
  }
  return {
    builtAt: Date.now(),
    now,
    settings,
    views,
    search,
    byId,
    active,
    competitorStats,
    sortCache: new Map(),
    foldCache: new Map(),
    facets: null,
    attrFields: null,
    build_ms: Math.round(performance.now() - t0),
  };
}

/** Segmenty (zkompilované) + členství produktů. */
function buildSegments(db, s, viewsCache) {
  const list = s.segments.all().map((r) => {
    const filter = parseJson(r.filter, {});
    let match;
    let error = null;
    try {
      match = compileFilter(filter);
    } catch (e) {
      // neplatný filtr segmentu neodpovídá ničemu (stejně jako v cenotvorbě)
      match = () => false;
      error = e.message;
    }
    return { ...r, filter, match, error };
  });
  const { views, active } = viewsCache;
  const idsByIdx = new Array(views.length);
  const counts = new Map(list.map((g) => [g.id, 0]));
  const activeSet = new Uint8Array(views.length);
  for (const i of active) activeSet[i] = 1;
  for (let i = 0; i < views.length; i++) {
    let ids = null;
    for (const g of list) {
      let ok = false;
      try {
        ok = g.match(views[i]);
      } catch {
        ok = false;
      }
      if (ok) {
        (ids ||= []).push(g.id);
        if (activeSet[i]) counts.set(g.id, counts.get(g.id) + 1);
      }
    }
    idsByIdx[i] = ids || EMPTY_IDS;
  }
  return { list, byId: new Map(list.map((g) => [g.id, g])), idsByIdx, counts };
}
const EMPTY_IDS = Object.freeze([]);

/** Nejnovější otevřený (čekající / schválený) návrh každého produktu. */
function buildProposals(s) {
  const byProduct = new Map();
  for (const r of s.openProposals.all()) {
    const final = r.manual_price ?? r.new_price;
    byProduct.set(r.product_id, {
      id: r.id,
      status: r.status,
      new_price: r.new_price,
      change_pct: r.change_pct,
      manual_price: r.manual_price,
      final_price: final,
      final_change_pct: r.manual_price != null && r.old_price > 0 ? round(((final - r.old_price) / r.old_price) * 100, 2) : r.change_pct,
    });
  }
  return { byProduct, sortCache: new Map() };
}

/**
 * Aktuální cache pohledů pro databázi (postaví / obnoví, co je potřeba).
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{views: object[], search: string[], byId: Map<number, number>, active: number[], settings: object, now: Date,
 *   competitorStats: Map, segments: {list, byId, idsByIdx, counts}, proposals: {byProduct: Map}}}
 */
function getCache(db) {
  const st = stateOf(db);
  const s = stmts(db, st);
  const gate = `${s.tc.get().tc}:${s.dv.get().data_version}`;
  const d = st.dirty;
  if (d.views || d.segments || d.proposals || gate !== st.gate) {
    const fp = fingerprints(db, s);
    if (d.views || fp.views !== st.fp.views) st.views = null;
    if (d.segments || fp.segments !== st.fp.segments) st.segments = null;
    if (d.proposals || fp.proposals !== st.fp.proposals) st.proposals = null;
    st.fp = fp;
    st.gate = gate;
    st.dirty = { views: false, segments: false, proposals: false };
  }
  if (st.views && Date.now() - st.views.builtAt > VIEW_TTL_MS) st.views = null;
  if (!st.views) {
    st.views = buildViews(db);
    st.segments = null;
  }
  if (!st.segments) st.segments = buildSegments(db, s, st.views);
  if (!st.proposals) st.proposals = buildProposals(s);
  // sdílený objekt (facety, pole a řazení se do něj ukládají jako lazy cache)
  st.views.segments = st.segments;
  st.views.proposals = st.proposals;
  return st.views;
}

/**
 * Zápis, po kterém se pohledy dotčených produktů přepočítají přímo v cache (bez přestavby 30 000 pohledů).
 * Jen pro změny, které neovlivní nic jiného než pohled produktu samotného (zámek, limity, poznámka) – změna
 * ceny mění i statistiky konkurentů, tu řešte přes invalidate(db, 'views').
 * Postup: nejdřív se cache srovná s DB (getCache), pak proběhne `write` (synchronně, nic jiného mezitím nezapisuje),
 * pohledy se přepočítají a uloží se nové otisky, aby se změna nepovažovala za cizí.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]} productIds
 * @param {() => *} write synchronní zápis do DB
 * @returns {*} návratová hodnota write
 */
function writeAndRefresh(db, productIds, write) {
  const st = states.get(db);
  const hadCache = !!(st && st.views);
  if (hadCache) getCache(db);
  const result = write();
  if (!hadCache || !st.views) return result;
  const s = stmts(db, st);
  const cache = st.views;
  const settings = getSettings(db);
  const now = new Date();
  const products = loadProducts(db, { productIds, activeOnly: false });
  const offersMap = loadOffers(db, productIds);
  for (const p of products) {
    const i = cache.byId.get(p.id);
    if (i === undefined) {
      // nový produkt – raději celá přestavba
      st.dirty.views = true;
      return result;
    }
    const wasActive = cache.views[i].active === 1 || cache.views[i].active === true;
    const isActive = p.active === 1 || p.active === true;
    if (wasActive !== isActive) {
      st.dirty.views = true;
      return result;
    }
    const v = productView(p, offersMap.get(p.id) || [], { now, settings });
    cache.views[i] = v;
    cache.search[i] = fold([p.code, p.name, p.ean, p.mpn].filter((x) => x != null && x !== '').join(' '));
    if (st.segments) {
      const ids = [];
      for (const g of st.segments.list) {
        let ok = false;
        try {
          ok = g.match(v);
        } catch {
          ok = false;
        }
        if (ok) ids.push(g.id);
      }
      const old = st.segments.idsByIdx[i];
      if (isActive) {
        for (const id of old) st.segments.counts.set(id, st.segments.counts.get(id) - 1);
        for (const id of ids) st.segments.counts.set(id, st.segments.counts.get(id) + 1);
      }
      st.segments.idsByIdx[i] = ids.length ? ids : EMPTY_IDS;
    }
  }
  cache.sortCache.clear();
  cache.foldCache.clear();
  cache.facets = null;
  cache.attrFields = null;
  st.fp = fingerprints(db, s);
  st.gate = `${s.tc.get().tc}:${s.dv.get().data_version}`;
  return result;
}

/**
 * Zneplatní cache po zápisu přes API.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {...('views'|'segments'|'proposals'|'all')} parts co se změnilo (výchozí vše)
 *   views = produkty, nabídky, konkurenti, nastavení; segments = definice segmentů; proposals = návrhy cen
 */
function invalidate(db, ...parts) {
  const st = states.get(db);
  if (!st) return;
  const list = parts.length ? parts : ['all'];
  for (const p of list) {
    if (p === 'all') st.dirty = { views: true, segments: true, proposals: true };
    else if (p in st.dirty) st.dirty[p] = true;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Dotazy nad cache

/** Seznam klíčů View, podle kterých lze řadit/filtrovat (FIELDS + sloupce produktu + attrs.*). */
function isKnownViewField(cache, field) {
  if (typeof field !== 'string' || !/^[A-Za-z0-9_.\-]+$/.test(field)) return false;
  if (field.startsWith('attrs.')) return field.length > 6;
  if (field.startsWith('proposal.')) return ['proposal.change_pct', 'proposal.new_price', 'proposal.final_price', 'proposal.status', 'proposal.id'].includes(field);
  if (field === 'proposal') return true;
  if (FIELDS.some((f) => f.key === field)) return true;
  const sample = cache.views[0];
  return !!sample && Object.prototype.hasOwnProperty.call(sample, field);
}

/** Seřazené indexy všech pohledů podle pole (cache na verzi pohledů / návrhů). */
function sortedOrder(cache, field, dir) {
  const isProposal = field === 'proposal' || field.startsWith('proposal.');
  const bucket = isProposal ? cache.proposals.sortCache : cache.sortCache;
  const key = `${field}:${dir}`;
  let order = bucket.get(key);
  if (order) return order;
  const all = cache.views.map((_, i) => i);
  let valueOf;
  if (isProposal) {
    const sub = field === 'proposal' ? 'final_change_pct' : field.slice('proposal.'.length);
    valueOf = (i) => {
      const pr = cache.proposals.byProduct.get(cache.views[i].id);
      return pr ? pr[sub] : null;
    };
  } else {
    const get = makeGetter(field);
    valueOf = (i) => get(cache.views[i]);
  }
  order = sortIndices(all, valueOf, dir);
  bucket.set(key, order);
  return order;
}

/** Složené (fold) hodnoty pole pro rychlé porovnání bez diakritiky. */
function foldedField(cache, field) {
  let arr = cache.foldCache.get(field);
  if (!arr) {
    arr = cache.views.map((v) => fold(v[field]));
    cache.foldCache.set(field, arr);
  }
  return arr;
}

/**
 * Indexy produktů odpovídající filtrům seznamu produktů (bez řazení).
 * @param {object} cache
 * @param {{q?, manufacturer?, category?, owner?, supplier?, segment?: number, position?, has_proposal?: boolean,
 *   status?: 'active'|'inactive'|'all', match?: Function|null, productIds?: Set<number>}} f
 * @param {number[]} [order] pořadí, ve kterém procházet (výchozí podle id)
 */
function matchProducts(cache, f, order) {
  const { views } = cache;
  const tests = [];
  const status = f.status || 'active';
  if (status === 'active') tests.push((v) => v.active === 1 || v.active === true);
  else if (status === 'inactive') tests.push((v) => !(v.active === 1 || v.active === true));
  if (f.q != null && String(f.q).trim() !== '') {
    const needle = fold(f.q);
    const search = cache.search;
    tests.push((v, i) => search[i].includes(needle));
  }
  for (const k of ['manufacturer', 'category', 'owner', 'supplier']) {
    if (f[k] == null || String(f[k]).trim() === '') continue;
    const want = fold(f[k]);
    const arr = foldedField(cache, k);
    tests.push((v, i) => arr[i] === want);
  }
  if (f.position != null && f.position !== '') {
    const allowed = new Set(String(f.position).split(',').map((s) => s.trim()).filter(Boolean));
    tests.push((v) => allowed.has(v.position));
  }
  if (f.segment != null) {
    const sid = f.segment;
    const ids = cache.segments.idsByIdx;
    tests.push((v, i) => ids[i].includes(sid));
  }
  if (f.has_proposal) {
    const by = cache.proposals.byProduct;
    tests.push((v) => by.has(v.id));
  }
  if (f.productIds) {
    const set = f.productIds;
    tests.push((v) => set.has(v.id));
  }
  if (f.match) {
    const m = f.match;
    tests.push((v) => {
      try {
        return m(v);
      } catch {
        return false;
      }
    });
  }
  const src = order || views.map((_, i) => i);
  if (!tests.length) return src.slice();
  const out = [];
  outer: for (const i of src) {
    const v = views[i];
    for (const t of tests) if (!t(v, i)) continue outer;
    out.push(i);
  }
  return out;
}

/** Položka seznamu produktů = View + otevřený návrh + id segmentů. */
function productItem(cache, i) {
  const v = cache.views[i];
  const pr = cache.proposals.byProduct.get(v.id) || null;
  return { ...v, proposal: pr ? { ...pr } : null, segments: [...cache.segments.idsByIdx[i]] };
}

/** Facety (hodnoty a počty) nad aktivními produkty – SPEC /products/facets. */
function facetsOf(cache) {
  if (cache.facets) return cache.facets;
  const count = (key) => {
    const m = new Map();
    for (const i of cache.active) {
      const val = cache.views[i][key];
      if (val == null || val === '') continue;
      m.set(val, (m.get(val) || 0) + 1);
    }
    return sortFacet(m);
  };
  const attrMaps = new Map();
  const tooMany = new Set();
  for (const i of cache.active) {
    const attrs = cache.views[i].attrs;
    if (!attrs || typeof attrs !== 'object') continue;
    for (const [k, val] of Object.entries(attrs)) {
      if (tooMany.has(k) || val == null || val === '' || typeof val === 'object') continue;
      let m = attrMaps.get(k);
      if (!m) attrMaps.set(k, (m = new Map()));
      m.set(val, (m.get(val) || 0) + 1);
      if (m.size > 200) {
        tooMany.add(k);
        attrMaps.delete(k);
      }
    }
  }
  const attrs = {};
  for (const k of [...attrMaps.keys()].sort((a, b) => collator.compare(a, b))) attrs[k] = sortFacet(attrMaps.get(k)).slice(0, 50);
  cache.facets = { manufacturers: count('manufacturer'), categories: count('category'), owners: count('owner'), suppliers: count('supplier'), attrs };
  return cache.facets;
}

function sortFacet(m) {
  return [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || compareValues(sortValue(a.value) ?? '', sortValue(b.value) ?? ''));
}

/** FIELDS + objevená pole attrs.* (typ odhadnut z hodnot). */
function fieldsOf(cache) {
  if (!cache.attrFields) cache.attrFields = discoverAttrFields(cache.views.map((v) => v.attrs));
  return [...FIELDS.map((f) => ({ ...f })), ...cache.attrFields.map((f) => ({ ...f }))];
}

module.exports = {
  // cache
  getCache,
  invalidate,
  writeAndRefresh,
  sortedOrder,
  matchProducts,
  productItem,
  facetsOf,
  fieldsOf,
  isKnownViewField,
  VIEW_TTL_MS,
  // pomocníci
  isPlainObject,
  bodyObject,
  toClientError,
  numberInput,
  boolInput,
  textInput,
  idArray,
  queryId,
  parseFilterInput,
  plain,
  sortIndices,
  compareValues,
  collator,
  PROPOSAL_STATUSES,
};
