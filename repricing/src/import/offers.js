'use strict';
// Import cen konkurence (SPEC §5 offers.js): párování na katalog, snapshot `offers` + `offer_history`,
// nespárované nabídky, režimy nahrazení a ruční párování (matchUnmatched).
//
// Párování (v tomto pořadí):
//   1. code → products.code_key
//   2. ean  → products.ean_key, 3. mpn → products.mpn_key
//      – více produktů se stejným EAN/MPN: přednost má jediný aktivní; jinak MPN může EAN zúžit (průnik);
//        jinak nejednoznačné (důvod `ambiguous`)
//   4. product_aliases pro druhy code, ean, mpn, ext, name (v tomto pořadí); u každého druhu má přednost alias
//      konkrétního konkurenta před obecným (competitor_id = 0). Alias (ruční rozhodnutí) spáruje i nejednoznačný EAN.
// Nespárované → unmatched_offers (match_key = první z ean:<k>, mpn:<k>, code:<k>, ext:<k>, name:<fold(název)>),
// seen_count se zvýší jednou za import. raw = kanonický záznam (+ `_reason`, `_candidates`) pro pozdější spárování.

const { tx, nowIso, getSettings, parseJson } = require('../db');
const { codeKey, eanKey, mpnKey, nameKey, fold } = require('../util/keys');
const { parseNumber, round } = require('../util/num');
const { ImportError, normalizeCode, normalizeText, normalizeAvailability, parseDate, errorCollector } = require('./mapping');

const DAY_MS = 86400000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const BULK_THRESHOLD = 2000; // od kolika záznamů se načítají celé tabulky do paměti místo dotazů po jednom
const PAIR = 1048576; // klíč dvojice = product_id * 2^20 + competitor_id
const ALIAS_KINDS = ['code', 'ean', 'mpn', 'ext', 'name'];

/** Klíč ID poskytovatele (ext) – jako náš kód: velká písmena, bez mezer. */
function extKey(v) {
  return codeKey(v);
}

/** Klíč názvu pro alias / match_key. */
function nameMatchKey(v) {
  const f = fold(v);
  return f ? f.slice(0, 200) : null;
}

function same(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return false;
}

function toNum(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const n = parseNumber(v);
  return n == null ? NaN : n;
}

function toBoolStock(v) {
  if (v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? (v > 0 ? 1 : 0) : null;
  return normalizeAvailability(v, { hint: 'bool' }).in_stock;
}

/**
 * Znormalizuje (kanonický) záznam nabídky. Vrací {offer} nebo {error}; varování do `warnings`.
 */
function normalizeOffer(rec, nowIsoStr, nowMs, warnings) {
  if (!rec || typeof rec !== 'object') return { error: 'Neplatný záznam' };
  const competitor = normalizeText(rec.competitor, true);
  const ck = nameKey(competitor);
  if (!ck) return { error: 'Chybí konkurent' };
  const price = toNum(rec.price);
  if (price === undefined || price === null) return { error: 'Chybí cena' };
  if (!Number.isFinite(price) || !(price > 0)) return { error: `Neplatná cena „${rec.price}“ (musí být kladné číslo)` };
  const o = {
    competitor,
    competitor_key: ck,
    code: normalizeCode(rec.code),
    ean: normalizeCode(rec.ean),
    mpn: normalizeCode(rec.mpn),
    ext_id: normalizeCode(rec.ext_id),
    name: normalizeText(rec.name, true),
    price: round(price, 2),
  };
  o.keys = {
    code: codeKey(o.code),
    ean: eanKey(o.ean),
    mpn: mpnKey(o.mpn),
    ext: extKey(o.ext_id),
    name: nameMatchKey(o.name),
  };
  if (!o.keys.code && !o.keys.ean && !o.keys.mpn && !o.keys.ext && !o.keys.name) {
    return { error: 'Chybí párovací klíč (náš kód, EAN, MPN, ID položky nebo název)' };
  }
  if (rec.shipping !== undefined) {
    const s = toNum(rec.shipping);
    if (Number.isNaN(s)) warnings.push(`Doprava: hodnota „${rec.shipping}“ není číslo`);
    else o.shipping = s == null ? null : Math.max(0, round(s, 2));
  }
  // dostupnost: in_stock > availability; delivery_days; stock_qty > 0 → skladem
  let inStock;
  let days;
  if (rec.availability !== undefined && rec.availability !== null) {
    const a = normalizeAvailability(rec.availability, { now: nowIsoStr });
    inStock = a.in_stock;
    days = a.delivery_days;
  }
  if (rec.in_stock !== undefined) {
    const b = toBoolStock(rec.in_stock);
    if (b == null && rec.in_stock !== null && rec.in_stock !== '') warnings.push(`Skladem: nerozpoznaná hodnota „${rec.in_stock}“`);
    else inStock = b;
  }
  if (rec.delivery_days !== undefined) {
    const d = toNum(rec.delivery_days);
    if (Number.isNaN(d)) warnings.push(`Dodání (dny): hodnota „${rec.delivery_days}“ není číslo`);
    else {
      days = d == null ? null : Math.max(0, d);
      if (inStock == null && days != null) inStock = days <= 0 ? 1 : 0;
    }
  }
  if (rec.stock_qty !== undefined) {
    const q = toNum(rec.stock_qty);
    if (Number.isNaN(q)) warnings.push(`Počet kusů: hodnota „${rec.stock_qty}“ není číslo`);
    else if (q != null) {
      o.stock_qty = q;
      if (q > 0) inStock = 1;
      else if (inStock == null) inStock = 0;
    }
  }
  if (inStock !== undefined) o.in_stock = inStock;
  if (days !== undefined) o.delivery_days = days;
  if (rec.url !== undefined) o.url = normalizeText(rec.url, true);
  let observed = null;
  if (rec.observed_at != null && rec.observed_at !== '') {
    observed = parseDate(rec.observed_at);
    if (!observed) warnings.push(`Datum zjištění: neplatné datum „${rec.observed_at}“ – použit čas importu`);
  }
  // budoucí čas (špatné časové pásmo zdroje) by zablokoval pozdější importy jako „zastaralé“ → oříznout na teď
  if (!observed || Date.parse(observed) > nowMs + FUTURE_TOLERANCE_MS) observed = nowIsoStr;
  o.observed_at = observed;
  if (rec.price_is_net === true || rec.price_is_net === 1) o.price_is_net = true;
  return { offer: o };
}

/** match_key nespárované nabídky: první z ean, mpn, code, ext, name. */
function matchKeyOf(o) {
  const k = o.keys;
  if (k.ean) return `ean:${k.ean}`;
  if (k.mpn) return `mpn:${k.mpn}`;
  if (k.code) return `code:${k.code}`;
  if (k.ext) return `ext:${k.ext}`;
  if (k.name) return `name:${k.name}`;
  return null;
}

/** Kanonický záznam pro unmatched_offers.raw (a opětovný import). */
function canonicalOf(o) {
  const out = { competitor: o.competitor, price: o.price };
  for (const k of ['code', 'ean', 'mpn', 'ext_id', 'name', 'shipping', 'in_stock', 'delivery_days', 'stock_qty', 'url', 'observed_at']) {
    if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  }
  if (o.price_is_net) out.price_is_net = true;
  return out;
}

/** Vyhledávání produktů – celé tabulky v paměti (velký import) nebo dotazy s pamětí (malý import). */
function productLookup(db, bulk) {
  const info = new Map(); // id → {active, vat_rate}
  if (bulk) {
    const byCode = new Map();
    const byEan = new Map();
    const byMpn = new Map();
    const add = (map, k, id) => {
      if (!k) return;
      const cur = map.get(k);
      if (cur === undefined) map.set(k, id);
      else if (Array.isArray(cur)) cur.push(id);
      else map.set(k, [cur, id]);
    };
    for (const p of db.prepare('SELECT id, code_key, ean_key, mpn_key, active, vat_rate FROM products').iterate()) {
      info.set(p.id, { active: p.active, vat_rate: p.vat_rate });
      byCode.set(p.code_key, p.id);
      add(byEan, p.ean_key, p.id);
      add(byMpn, p.mpn_key, p.id);
    }
    const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
    return {
      info: (id) => info.get(id),
      code: (k) => byCode.get(k) ?? null,
      ean: (k) => arr(byEan.get(k)),
      mpn: (k) => arr(byMpn.get(k)),
    };
  }
  const qCode = db.prepare('SELECT id, active, vat_rate FROM products WHERE code_key = ?');
  const qEan = db.prepare('SELECT id, active, vat_rate FROM products WHERE ean_key = ?');
  const qMpn = db.prepare('SELECT id, active, vat_rate FROM products WHERE mpn_key = ?');
  const qId = db.prepare('SELECT id, active, vat_rate FROM products WHERE id = ?');
  const memo = new Map();
  const cached = (tag, k, fn) => {
    const mk = tag + '\u0001' + k;
    if (!memo.has(mk)) memo.set(mk, fn());
    return memo.get(mk);
  };
  const remember = (rows) => {
    for (const r of rows) info.set(r.id, { active: r.active, vat_rate: r.vat_rate });
    return rows.map((r) => r.id);
  };
  return {
    info: (id) => {
      if (!info.has(id)) {
        const r = qId.get(id);
        if (r) info.set(id, { active: r.active, vat_rate: r.vat_rate });
      }
      return info.get(id);
    },
    code: (k) => cached('c', k, () => remember(qCode.all(k))[0] ?? null),
    ean: (k) => cached('e', k, () => remember(qEan.all(k))),
    mpn: (k) => cached('m', k, () => remember(qMpn.all(k))),
  };
}

/** Víc kandidátů → přednost má jediný aktivní. */
function preferActive(ids, lookup) {
  if (ids.length <= 1) return ids;
  const active = ids.filter((id) => {
    const i = lookup.info(id);
    return i && i.active;
  });
  return active.length === 1 ? active : ids;
}

/**
 * Importuje nabídky konkurence.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object[]} records kanonické záznamy nabídek
 * @param {{replace?: false|'competitors'|'all', sourceId?: number|null, now?: Date|string, maxAgeDays?: number,
 *          rowNumbers?: number[], onError?: Function, productId?: number}} [opts]
 *   maxAgeDays = nabídky zjištěné před více než N dny se ignorují (stale); productId = interní (matchUnmatched –
 *   všechny záznamy patří k tomuto produktu)
 * @returns {{received, matched, unmatched, ambiguous, created, updated, unchanged, stale, duplicates, removed, competitors_created, errors}}
 */
function importOffers(db, records, opts = {}) {
  const list = Array.isArray(records) ? records : [];
  const nowStr = nowIso(opts.now);
  const nowMs = Date.parse(nowStr);
  let replace = opts.replace;
  if (replace === true || replace === 1 || replace === '1' || replace === 'true') replace = 'competitors';
  if (replace === 'none' || replace === '' || replace === '0' || replace === 'false' || replace == null) replace = false;
  if (replace !== false && replace !== 'competitors' && replace !== 'all') {
    throw new ImportError(`Neplatný režim nahrazení „${opts.replace}“ (povoleno: competitors, all).`);
  }
  const maxAgeMs = Number(opts.maxAgeDays) > 0 ? Number(opts.maxAgeDays) * DAY_MS : null;
  const sourceId = opts.sourceId ?? null;
  const stats = {
    received: list.length, matched: 0, unmatched: 0, ambiguous: 0, created: 0, updated: 0, unchanged: 0, stale: 0, duplicates: 0, removed: 0,
    competitors_created: 0, errors: [],
  };
  const errs = errorCollector(stats.errors, opts.onError);
  const rowOf = (i) => (opts.rowNumbers && opts.rowNumbers[i] != null ? opts.rowNumbers[i] : i + 1);
  const settings = getSettings(db);
  const vatDefault = settings.vat_rate_default != null && Number.isFinite(Number(settings.vat_rate_default)) ? Number(settings.vat_rate_default) : 21;
  const bulk = list.length > BULK_THRESHOLD || replace === 'all';

  tx(db, () => {
    const lookup = productLookup(db, bulk);
    if (opts.productId != null && !lookup.info(Number(opts.productId))) throw new ImportError('Produkt pro spárování neexistuje.', { status: 404, code: 'NOT_FOUND' });

    // aliasy (bývá jich málo – vždy celé)
    const aliases = new Map();
    for (const a of db.prepare('SELECT kind, value_key, competitor_id, product_id FROM product_aliases').iterate()) {
      aliases.set(`${a.kind}\u0001${a.value_key}\u0001${a.competitor_id}`, a.product_id);
    }
    // konkurenti
    const competitors = new Map();
    for (const c of db.prepare('SELECT id, name_key FROM competitors').iterate()) competitors.set(c.name_key, c.id);
    const insCompetitor = db.prepare('INSERT INTO competitors (name, name_key, created_at) VALUES (?, ?, ?)');

    // ------------------------------------------------------------ 1. průchod: validace, párování, agregace
    const best = new Map(); // klíč dvojice → {o, pid, cid}
    const unmatchedBest = new Map(); // cid\u0001match_key → {o, cid, mk, reason, candidates}
    const presentCompetitors = new Set();
    let valid = 0;

    for (let i = 0; i < list.length; i++) {
      const row = rowOf(i);
      const warnings = [];
      const { offer: o, error } = normalizeOffer(list[i], nowStr, nowMs, warnings);
      if (error) {
        errs.add(row, error);
        continue;
      }
      for (const w of warnings) errs.add(row, w, { warning: true });
      valid++;
      let cid = competitors.get(o.competitor_key);
      if (cid === undefined) {
        cid = Number(insCompetitor.run(o.competitor, o.competitor_key, nowStr).lastInsertRowid);
        competitors.set(o.competitor_key, cid);
        stats.competitors_created++;
      }
      presentCompetitors.add(cid);

      // párování
      let pid = null;
      let candidates = null;
      if (opts.productId != null) pid = Number(opts.productId);
      else {
        const k = o.keys;
        if (k.code) pid = lookup.code(k.code);
        if (pid == null) {
          const eIds = k.ean ? preferActive(lookup.ean(k.ean), lookup) : [];
          const mIds = k.mpn ? preferActive(lookup.mpn(k.mpn), lookup) : [];
          if (eIds.length === 1) pid = eIds[0];
          else if (eIds.length > 1) {
            const inter = mIds.filter((id) => eIds.includes(id));
            if (inter.length === 1) pid = inter[0];
            else candidates = eIds;
          } else if (mIds.length === 1) pid = mIds[0];
          else if (mIds.length > 1) candidates = mIds;
        }
        if (pid == null) {
          for (const kind of ALIAS_KINDS) {
            const vk = k[kind];
            if (!vk) continue;
            const hit = aliases.get(`${kind}\u0001${vk}\u0001${cid}`) ?? aliases.get(`${kind}\u0001${vk}\u00010`);
            if (hit !== undefined) {
              pid = hit;
              break;
            }
          }
        }
      }

      if (pid == null) {
        const mk = matchKeyOf(o);
        if (candidates) stats.ambiguous++;
        else stats.unmatched++;
        const uk = `${cid}\u0001${mk}`;
        const prev = unmatchedBest.get(uk);
        if (!prev || o.price < prev.o.price) unmatchedBest.set(uk, { o, cid, mk, reason: candidates ? 'ambiguous' : 'not_found', candidates });
        continue;
      }
      stats.matched++;
      const pk = pid * PAIR + cid;
      const prev = best.get(pk);
      if (prev) {
        stats.duplicates++;
        // ponechat nejnižší cenu; při shodě ceny dostupnější (skladem) a novější nabídku
        const better =
          o.price < prev.o.price ||
          (o.price === prev.o.price && ((o.in_stock === 1 && prev.o.in_stock !== 1) || (o.in_stock === prev.o.in_stock && o.observed_at > prev.o.observed_at)));
        if (better) best.set(pk, { o, pid, cid });
      } else best.set(pk, { o, pid, cid });
    }

    // ------------------------------------------------------------ 2. průchod: zápis nabídek
    const existingAll = bulk ? new Map() : null;
    if (bulk) {
      for (const r of db.prepare('SELECT product_id, competitor_id, price, shipping, in_stock, delivery_days, url, name, observed_at, prev_price, changed_at, source_id FROM offers').iterate()) {
        existingAll.set(r.product_id * PAIR + r.competitor_id, r);
      }
    }
    const getOffer = bulk
      ? null
      : db.prepare('SELECT product_id, competitor_id, price, shipping, in_stock, delivery_days, url, name, observed_at, prev_price, changed_at, source_id FROM offers WHERE product_id = ? AND competitor_id = ?');
    const insOffer = db.prepare(
      `INSERT INTO offers (product_id, competitor_id, price, shipping, in_stock, delivery_days, url, name, observed_at, first_seen_at, prev_price, changed_at, source_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
    );
    const updOffer = db.prepare(
      `UPDATE offers SET price = ?, shipping = ?, in_stock = ?, delivery_days = ?, url = ?, name = ?, observed_at = ?, prev_price = ?, changed_at = ?, source_id = ?
       WHERE product_id = ? AND competitor_id = ?`
    );
    const touchOffer = db.prepare('UPDATE offers SET observed_at = ?, source_id = ? WHERE product_id = ? AND competitor_id = ?');
    const insHistory = db.prepare('INSERT INTO offer_history (product_id, competitor_id, price, in_stock, observed_at) VALUES (?, ?, ?, ?, ?)');

    // nespárované záznamy, které se teď spárovaly, z fronty ručního párování zmizí
    let unmatchedKeys = null;
    let hasUnmatched = null;
    if (bulk) {
      unmatchedKeys = new Set();
      for (const u of db.prepare('SELECT competitor_id, match_key FROM unmatched_offers').iterate()) unmatchedKeys.add(`${u.competitor_id}\u0001${u.match_key}`);
      hasUnmatched = (cid, mk) => unmatchedKeys.has(`${cid}\u0001${mk}`);
    } else {
      const q = db.prepare('SELECT 1 AS x FROM unmatched_offers WHERE competitor_id = ? AND match_key = ?');
      hasUnmatched = (cid, mk) => !!q.get(cid, mk);
    }
    const delUnmatched = db.prepare('DELETE FROM unmatched_offers WHERE competitor_id = ? AND match_key = ?');

    const present = new Set();
    for (const [pk, { o, pid, cid }] of best) {
      present.add(pk);
      const cur = bulk ? existingAll.get(pk) : getOffer.get(pid, cid);
      if (maxAgeMs != null && Date.parse(o.observed_at) < nowMs - maxAgeMs) {
        stats.stale++;
        continue;
      }
      if (cur && o.observed_at < cur.observed_at) {
        stats.stale++;
        continue;
      }
      let price = o.price;
      let shipping = o.shipping;
      if (o.price_is_net) {
        const info = lookup.info(pid);
        const vat = info && info.vat_rate != null ? info.vat_rate : vatDefault;
        price = round(price * (1 + vat / 100), 2);
        if (shipping != null) shipping = round(shipping * (1 + vatDefault / 100), 2);
      }
      if (!cur) {
        const inStock = o.in_stock === undefined ? null : o.in_stock;
        insOffer.run(pid, cid, price, shipping ?? null, inStock, o.delivery_days ?? null, o.url ?? null, o.name ?? null, o.observed_at, nowStr, sourceId);
        insHistory.run(pid, cid, price, inStock, o.observed_at);
        stats.created++;
        if (bulk) existingAll.set(pk, { price, observed_at: o.observed_at });
      } else {
        const next = {
          shipping: shipping === undefined ? cur.shipping : shipping,
          in_stock: o.in_stock === undefined ? cur.in_stock : o.in_stock,
          delivery_days: o.delivery_days === undefined ? cur.delivery_days : o.delivery_days,
          url: o.url === undefined ? cur.url : o.url,
          name: o.name ?? cur.name, // název u konkurenta se prázdnou hodnotou nemaže
        };
        const priceChanged = !same(cur.price, price);
        const stockChanged = !same(cur.in_stock, next.in_stock);
        const otherChanged = !same(cur.shipping, next.shipping) || !same(cur.delivery_days, next.delivery_days) || cur.url !== next.url || cur.name !== next.name;
        if (priceChanged || stockChanged || otherChanged) {
          const prevPrice = priceChanged ? cur.price : cur.prev_price;
          const changedAt = priceChanged ? o.observed_at : cur.changed_at;
          updOffer.run(price, next.shipping, next.in_stock, next.delivery_days, next.url, next.name, o.observed_at, prevPrice, changedAt, sourceId, pid, cid);
          if (priceChanged || stockChanged) insHistory.run(pid, cid, price, next.in_stock, o.observed_at);
          stats.updated++;
        } else {
          // beze změny – jen čas posledního zjištění (a zdroj)
          if (cur.observed_at !== o.observed_at || cur.source_id !== sourceId) touchOffer.run(o.observed_at, sourceId, pid, cid);
          stats.unchanged++;
        }
      }
      const mk = matchKeyOf(o);
      if (mk && hasUnmatched(cid, mk)) {
        delUnmatched.run(cid, mk);
        if (unmatchedKeys) unmatchedKeys.delete(`${cid}\u0001${mk}`);
      }
    }

    // ------------------------------------------------------------ 3. nespárované
    const upsUnmatched = db.prepare(
      `INSERT INTO unmatched_offers (competitor_id, match_key, code, ean, mpn, ext_id, name, price, url, raw, seen_count, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(competitor_id, match_key) DO UPDATE SET
         code = excluded.code, ean = excluded.ean, mpn = excluded.mpn, ext_id = excluded.ext_id, name = excluded.name, price = excluded.price,
         url = excluded.url, raw = excluded.raw, seen_count = unmatched_offers.seen_count + 1, last_seen_at = excluded.last_seen_at`
    );
    for (const { o, cid, mk, reason, candidates } of unmatchedBest.values()) {
      const raw = { ...canonicalOf(o), _reason: reason };
      if (candidates) raw._candidates = candidates.slice(0, 20);
      const displayPrice = o.price_is_net ? round(o.price * (1 + vatDefault / 100), 2) : o.price;
      upsUnmatched.run(cid, mk, o.code, o.ean, o.mpn, o.ext_id, o.name, displayPrice, o.url ?? null, JSON.stringify(raw), nowStr, nowStr);
    }

    // ------------------------------------------------------------ 4. nahrazení (smazání chybějících nabídek)
    if (replace) {
      if (valid === 0) {
        errs.add(null, 'Import neobsahuje žádnou platnou nabídku – mazání chybějících nabídek (replace) bylo přeskočeno.');
      } else {
        const del = db.prepare('DELETE FROM offers WHERE product_id = ? AND competitor_id = ?');
        const toDelete = [];
        if (replace === 'all') {
          for (const r of db.prepare('SELECT product_id, competitor_id FROM offers').iterate()) {
            if (!present.has(r.product_id * PAIR + r.competitor_id)) toDelete.push(r);
          }
        } else {
          const q = db.prepare('SELECT product_id, competitor_id FROM offers WHERE competitor_id = ?');
          for (const cid of presentCompetitors) {
            for (const r of q.iterate(cid)) if (!present.has(r.product_id * PAIR + r.competitor_id)) toDelete.push(r);
          }
        }
        for (const r of toDelete) stats.removed += Number(del.run(r.product_id, r.competitor_id).changes);
      }
    }
  });
  errs.finish();
  return stats;
}

/**
 * Ruční spárování nespárované nabídky s produktem: vytvoří alias z uložených identifikátorů
 * (ean > mpn > ext > code > name, nebo `kind`) pro daného konkurenta, znovu naimportuje uloženou nabídku
 * (už na zvolený produkt) a smaže řádek z unmatched_offers. Vše v jedné transakci.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} unmatchedId
 * @param {number} productId
 * @param {{kind?: 'ean'|'mpn'|'ext'|'code'|'name', now?: Date|string}} [opts]
 * @returns {{ok: true, product_id: number, alias: {kind, value_key, competitor_id}, stats: object}}
 */
function matchUnmatched(db, unmatchedId, productId, opts = {}) {
  const now = nowIso(opts.now);
  return tx(db, () => {
    const u = db.prepare('SELECT * FROM unmatched_offers WHERE id = ?').get(Number(unmatchedId));
    if (!u) throw new ImportError('Nespárovaná nabídka nebyla nalezena.', { status: 404, code: 'NOT_FOUND' });
    const p = db.prepare('SELECT id FROM products WHERE id = ?').get(Number(productId));
    if (!p) throw new ImportError('Produkt nebyl nalezen.', { status: 404, code: 'NOT_FOUND' });
    const raw = parseJson(u.raw, null) || {};
    const ids = {
      ean: eanKey(u.ean ?? raw.ean),
      mpn: mpnKey(u.mpn ?? raw.mpn),
      ext: extKey(u.ext_id ?? raw.ext_id),
      code: codeKey(u.code ?? raw.code),
      name: nameMatchKey(u.name ?? raw.name),
    };
    let kind = opts.kind || null;
    if (kind === 'ext_id') kind = 'ext';
    if (kind) {
      if (!ALIAS_KINDS.includes(kind)) throw new ImportError(`Neznámý druh aliasu „${kind}“ (povoleno: ean, mpn, ext, code, name).`);
      if (!ids[kind]) throw new ImportError(`Nabídka nemá identifikátor „${kind}“, podle kterého by šlo párovat.`);
    } else kind = ['ean', 'mpn', 'ext', 'code', 'name'].find((k) => ids[k]);
    if (!kind) throw new ImportError('Nabídka nemá žádný identifikátor, ze kterého by šel vytvořit alias.');
    const competitorId = u.competitor_id ?? 0;
    db.prepare(
      `INSERT INTO product_aliases (kind, value_key, competitor_id, product_id, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, value_key, competitor_id) DO UPDATE SET product_id = excluded.product_id`
    ).run(kind, ids[kind], competitorId, p.id, now);

    // znovu naimportovat uloženou nabídku
    const rec = {};
    for (const [k, v] of Object.entries(raw)) if (!k.startsWith('_')) rec[k] = v;
    if (!rec.competitor) {
      const c = u.competitor_id != null ? db.prepare('SELECT name FROM competitors WHERE id = ?').get(u.competitor_id) : null;
      rec.competitor = c ? c.name : null;
    }
    for (const k of ['code', 'ean', 'mpn', 'ext_id', 'name', 'url']) if (rec[k] == null && u[k] != null) rec[k] = u[k];
    if (rec.price == null) rec.price = u.price;
    if (rec.observed_at == null) rec.observed_at = u.last_seen_at;
    let stats = null;
    if (rec.competitor && rec.price > 0) stats = importOffers(db, [rec], { now, productId: p.id });
    db.prepare('DELETE FROM unmatched_offers WHERE id = ?').run(u.id);
    return { ok: true, product_id: p.id, alias: { kind, value_key: ids[kind], competitor_id: competitorId }, stats };
  });
}

module.exports = { importOffers, matchUnmatched, matchKeyOf, extKey, nameMatchKey };
