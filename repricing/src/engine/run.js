'use strict';
// Orchestrace přecenění nad databází – SPEC §6.8 a §3.5 / §3.6.
//  - loadContext: nastavení, segmenty (zkompilované filtry), zapnuté strategie (seřazené), konkurenti
//  - evaluateProduct: výběr strategie (segment, podmínky, časové okno, propadnutí „next“) + computePrice
//  - runPricing: hromadné načtení, vyhodnocení všech aktivních produktů, zápis běhu a návrhů v jedné transakci
//  - simulate: „co kdyby“ pro jednu ad-hoc strategii bez zápisu
//  - explainProduct / latestProposal: detail produktu v UI

const { tx, nowIso, parseJson, json, getSettings } = require('../db');
const { net, round } = require('../util/num');
const { compileFilter, isEmptyFilter } = require('./filter');
const { productView, scheduleActive, describeSchedule, toDate } = require('./metrics');
const { computePrice } = require('./pricing');
const { normalizeConfig } = require('./presets');
const { MANUAL_FLAGS, CENT } = require('../util/proposals');

// Jak dlouho si běh pamatuje zamítnutí: stejnou (±0,5 %) cenu, kterou člověk v posledních N dnech zamítl, znovu
// automaticky neschválí (vznikne jako čekající s příznakem previously_rejected).
const REJECT_MEMORY_DAYS = 7;
const REJECT_SAME_PCT = 0.5;

const MISSING_TEXT = {
  no_market: 'chybí trh (málo použitelných nabídek konkurence)',
  no_competitor: 'chybí nabídka zvoleného konkurenta',
  no_msrp: 'chybí MOC',
  no_cost: 'chybí nákupní cena',
  no_price: 'chybí aktuální cena',
};

// ---------------------------------------------------------------------------------------------
// Kontext

const PREPARED = Symbol('preparedStrategy');
const preparedCache = new WeakMap();

function compileSegment(row) {
  const filter = parseJson(row.filter, {});
  let match;
  let error = null;
  try {
    match = compileFilter(filter);
  } catch (e) {
    // neplatný filtr segmentu nesmí omylem zahrnout všechny produkty → neodpovídá ničemu
    match = () => false;
    error = e.message;
  }
  return { id: row.id, name: row.name, filter, match, error };
}

/**
 * Připraví strategii k vyhodnocení: normalizovaný config, zkompilované podmínky, chyby.
 * @param {{id, name, segment_id, priority?, enabled?, config}} row
 */
function prepareStrategy(row) {
  const { config, errors } = normalizeConfig(row.config);
  let conditions = null;
  if (!errors.length && !isEmptyFilter(config.conditions)) {
    try {
      conditions = compileFilter(config.conditions);
    } catch (e) {
      errors.push(`conditions: ${e.message}`);
    }
  }
  return {
    [PREPARED]: true,
    id: row.id ?? null,
    name: row.name ?? null,
    description: row.description ?? null,
    segment_id: row.segment_id ?? null,
    priority: row.priority ?? null,
    enabled: row.enabled == null ? true : Boolean(row.enabled),
    config,
    rawConfig: row.config,
    errors,
    conditions,
  };
}

/**
 * Načte vše potřebné pro vyhodnocení produktů.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{now?: Date|string}} [opts]
 * @returns {{now: Date, settings: object, segments: object[], segmentById: Map, strategies: object[], competitors: object[]}}
 */
function loadContext(db, opts = {}) {
  const now = toDate(opts.now);
  const settings = getSettings(db);
  const segments = db.prepare('SELECT id, name, filter FROM segments ORDER BY id').all().map(compileSegment);
  const strategies = db
    .prepare('SELECT id, name, description, segment_id, priority, enabled, config FROM strategies WHERE enabled = 1 ORDER BY priority, id')
    .all()
    .map(prepareStrategy);
  const competitors = db
    .prepare('SELECT id, name, label, enabled, tags, note FROM competitors ORDER BY id')
    .all()
    .map((c) => ({ ...c, enabled: Boolean(c.enabled), tags: toTags(parseJson(c.tags, [])) }));
  return { now, settings, segments, segmentById: new Map(segments.map((s) => [s.id, s])), strategies, competitors };
}

// ---------------------------------------------------------------------------------------------
// Vyhodnocení produktu

/**
 * Vybere strategii pro produkt a spočítá rozhodnutí (SPEC §3.5).
 * @param {object} ctx výsledek loadContext (nebo {now, settings, segments, strategies})
 * @param {object} product řádek produktu
 * @param {Array<object>} offers nabídky (SPEC §6.1)
 * @returns {{view, segmentIds: number[], strategy: object|null, decision: object|null,
 *   tried: Array<{strategy_id, name, result: 'not_applicable'|'fallthrough'|'decided', why: string, code: string}>,
 *   lastFallthrough: object|null}}
 */
/** Zajistí připravenou strategii/segment i pro „syrové“ řádky z DB (podmínky se nesmí tiše ignorovat). */
function ensurePrepared(obj, prepare) {
  if (obj[PREPARED] || typeof obj.match === 'function') return obj;
  let p = preparedCache.get(obj);
  if (!p) {
    p = prepare(obj);
    preparedCache.set(obj, p);
  }
  return p;
}

function evaluateProduct(ctx, product, offers) {
  const now = toDate(ctx.now);
  const view = productView(product, offers, { now, settings: ctx.settings });
  const segments = (ctx.segments || []).map((s) => ensurePrepared(s, compileSegment));
  const segmentIds = [];
  for (const s of segments) if (s.match(view)) segmentIds.push(s.id);
  const segById = ctx.segmentById || new Map(segments.map((s) => [s.id, s]));
  const tried = [];
  const notes = [];
  let lastFallthrough = null;
  for (const raw of ctx.strategies || []) {
    const st = ensurePrepared(raw, prepareStrategy);
    const base = { strategy_id: st.id, name: st.name };
    if (st.enabled === false) {
      tried.push({ ...base, result: 'not_applicable', code: 'disabled', why: 'strategie je vypnutá' });
      continue;
    }
    if (st.segment_id != null && !segmentIds.includes(st.segment_id)) {
      const seg = segById.get(st.segment_id);
      tried.push({ ...base, result: 'not_applicable', code: 'segment', why: seg ? `produkt nepatří do segmentu „${seg.name}“` : 'segment strategie neexistuje' });
      continue;
    }
    let decision;
    if (st.errors && st.errors.length) {
      // Neplatná strategie, jejíž segment produkt splňuje: raději nepřecenit, než použít jinou (obecnější)
      // strategii. computePrice s původním (nevalidním) configem vrátí skip „invalid_config“ s popisem chyb.
      decision = computePrice(product, offers, { id: st.id, name: st.name, segment_id: st.segment_id, config: st.rawConfig }, { now, settings: ctx.settings });
      if (decision.action !== 'skip' || decision.reason !== 'invalid_config') {
        decision.action = 'skip';
        decision.reason = 'invalid_config';
        decision.new_price = null;
        decision.explain = [{ step: 'config', text: `Strategie „${st.name}“ má neplatnou konfiguraci: ${st.errors.join('; ')}` }];
      }
    } else {
      if (st.conditions && !st.conditions(view)) {
        tried.push({ ...base, result: 'not_applicable', code: 'conditions', why: 'produkt nesplňuje podmínky strategie' });
        continue;
      }
      if (!scheduleActive(st.config.schedule, now)) {
        tried.push({ ...base, result: 'not_applicable', code: 'schedule', why: `mimo časové okno strategie (${describeSchedule(st.config.schedule)})` });
        continue;
      }
      decision = computePrice(product, offers, st, { now, settings: ctx.settings });
    }
    if (decision.action === 'skip' && decision.reason === 'fallthrough') {
      const why = MISSING_TEXT[decision.base_missing] || 'chybí základ ceny';
      tried.push({ ...base, result: 'fallthrough', code: decision.base_missing || 'fallthrough', why });
      notes.push({ step: 'fallthrough', text: `Strategie „${st.name}“ nepoužita: ${why}` });
      decision.explain = [...notes.slice(0, -1), ...decision.explain];
      lastFallthrough = decision;
      continue;
    }
    if (notes.length) decision.explain = [...notes, ...decision.explain];
    tried.push({ ...base, result: 'decided', code: decision.action, why: 'strategie rozhodla' });
    return { view, segmentIds, strategy: st, decision, tried, lastFallthrough };
  }
  return { view, segmentIds, strategy: null, decision: null, tried, lastFallthrough };
}

// ---------------------------------------------------------------------------------------------
// Hromadné načtení

function idsClause(productIds, col) {
  if (!Array.isArray(productIds)) return { sql: '', args: [] };
  const ids = [...new Set(productIds.map(Number).filter(Number.isInteger))];
  return { sql: ` AND ${col} IN (SELECT value FROM json_each(?))`, args: [JSON.stringify(ids)] };
}

// Sloupce products pro json_object – zjišťujeme z PRAGMA, aby výsledek odpovídal SELECT *.
function productColumns(db) {
  return db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
}

/**
 * Aktivní (nebo všechny) produkty jedním dotazem; attrs jako objekt (parsováno jednou).
 * Řádky přenášíme jako JSON: node:sqlite je při materializaci mnoha sloupců několikrát pomalejší
 * než JSON.parse. REAL se v JSON vypisuje na 15 platných číslic – pro ceny na haléře přesné.
 */
function loadProducts(db, { productIds, activeOnly = true } = {}) {
  const w = idsClause(productIds, 'id');
  const where = `WHERE ${activeOnly ? 'active = 1' : '1 = 1'}${w.sql}`;
  const cols = productColumns(db);
  if (cols.length * 2 > 100 || !cols.every((c) => /^[a-z_][a-z0-9_]*$/i.test(c))) {
    // pojistka pro budoucí schéma (limit argumentů funkce v SQLite)
    const rows = db.prepare(`SELECT * FROM products ${where} ORDER BY id`).all(...w.args);
    return rows.map((r) => ({ ...r, attrs: toAttrs(parseJson(r.attrs, {})) }));
  }
  const fields = cols.map((c) =>
    c === 'attrs' ? `'attrs', CASE WHEN json_valid(attrs) AND json_type(attrs) = 'object' THEN json(attrs) ELSE json('{}') END` : `'${c}', "${c}"`
  );
  const rows = db.prepare(`SELECT json_object(${fields.join(', ')}) AS j FROM products ${where} ORDER BY id`).all(...w.args);
  const out = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) out[i] = JSON.parse(rows[i].j);
  return out;
}

function toTags(v) {
  return Array.isArray(v) ? v.filter((t) => t != null).map(String) : [];
}

function toAttrs(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/**
 * Nabídky všech (nebo vybraných) produktů jedním dotazem (spojeným s konkurenty), seskupené po produktech.
 * @returns {Map<number, object[]>} product_id → nabídky dle SPEC §6.1
 */
function loadOffers(db, productIds) {
  const w = idsClause(productIds, 'o.product_id');
  const comps = new Map();
  for (const c of db.prepare('SELECT id, name, label, enabled, tags FROM competitors').all()) {
    // štítky zmrazené a sdílené všemi nabídkami konkurenta (market.js si je pak cachuje)
    comps.set(c.id, { name: c.name, label: c.label, enabled: c.enabled === 1, tags: Object.freeze(toTags(parseJson(c.tags, []))) });
  }
  const stmt = db.prepare(
    `SELECT o.product_id AS p,
            json_group_array(json_array(o.competitor_id, o.price, o.shipping, o.in_stock, o.delivery_days, o.observed_at, o.name, o.url)) AS j
       FROM offers o JOIN competitors c ON c.id = o.competitor_id
      WHERE 1 = 1${w.sql}
      GROUP BY o.product_id`
  );
  const out = new Map();
  for (const r of stmt.all(...w.args)) {
    const arr = JSON.parse(r.j);
    const list = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      const c = comps.get(a[0]);
      list[i] = {
        competitor_id: a[0],
        competitor: c.name,
        label: c.label,
        tags: c.tags,
        enabled: c.enabled,
        price: a[1],
        shipping: a[2],
        in_stock: a[3],
        delivery_days: a[4],
        url: a[7],
        name: a[6],
        observed_at: a[5],
      };
    }
    out.set(r.p, list);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Statistiky

function emptyStats() {
  return {
    products: 0,
    evaluated: 0,
    changes: 0,
    up: 0,
    down: 0,
    no_change: 0,
    no_change_reasons: {},
    skipped: {},
    no_strategy: 0,
    fallthrough: 0,
    auto_approved: 0,
    pending: 0,
    by_strategy: {},
    flags: {},
    margin_impact_abs: 0,
  };
}

function vatOf(product, settings) {
  return product.vat_rate ?? settings.vat_rate_default ?? 21;
}

function addDecision(stats, decision, product, settings, strategy) {
  const inc = (obj, key) => (obj[key] = (obj[key] || 0) + 1);
  stats.evaluated += 1;
  let bs = null;
  if (strategy) {
    const key = String(strategy.id);
    bs = stats.by_strategy[key] || (stats.by_strategy[key] = { name: strategy.name, products: 0, changes: 0, up: 0, down: 0 });
    bs.products += 1;
  }
  if (decision.action === 'change') {
    stats.changes += 1;
    if (bs) bs.changes += 1;
    if (decision.old_price != null) {
      if (decision.new_price > decision.old_price) {
        stats.up += 1;
        if (bs) bs.up += 1;
      } else if (decision.new_price < decision.old_price) {
        stats.down += 1;
        if (bs) bs.down += 1;
      }
      const vat = vatOf(product, settings);
      stats.margin_impact_abs += net(decision.new_price, vat) - net(decision.old_price, vat);
    }
    if (decision.auto_approve) stats.auto_approved += 1;
    else stats.pending += 1;
    for (const f of decision.flags) inc(stats.flags, f);
  } else if (decision.action === 'no_change') {
    stats.no_change += 1;
    inc(stats.no_change_reasons, decision.reason || 'none');
  } else {
    inc(stats.skipped, decision.reason || 'unknown');
  }
}

// ---------------------------------------------------------------------------------------------
// Běh přecenění

const INSERT_PROPOSAL = `INSERT INTO proposals (run_id, product_id, strategy_id, segment_id, old_price, new_price, target_price,
  reference_price, market_min, competitor_count, rank_before, rank_after, margin_before, margin_after, change_abs, change_pct,
  status, flags, explain, created_at, decided_at, decided_by, manual_price)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const n = (v) => (v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? null : v);

/**
 * Přecenění všech aktivních produktů (nebo vybraných productIds).
 * Zápis (runs + supersede starších návrhů + nové návrhy) probíhá v jedné transakci; při chybě se vše
 * vrátí a zapíše se běh se stavem „error“ a zprávou.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{trigger?: string, productIds?: number[], now?: Date|string, dryRun?: boolean}} [opts]
 * @returns {{run_id: number|null, stats: object, decisions?: object[]}}
 */
function runPricing(db, opts = {}) {
  const { trigger = 'manual', productIds = null, dryRun = false } = opts;
  const now = toDate(opts.now);
  const ts = nowIso(now);
  const t0 = Date.now();
  // s vnuceným `now` (testy) je konec běhu = začátek, jinak skutečný čas
  const finishedAt = () => (opts.now ? ts : nowIso());

  const timing = {};
  const evaluate = () => {
    let t = performance.now();
    const ctx = loadContext(db, { now });
    const products = loadProducts(db, { productIds });
    const offers = loadOffers(db, productIds);
    timing.load = Math.round(performance.now() - t);
    t = performance.now();
    const stats = emptyStats();
    const results = [];
    for (const p of products) {
      const res = evaluateProduct(ctx, p, offers.get(p.id) || []);
      stats.products += 1;
      if (res.tried.some((t) => t.result === 'fallthrough')) stats.fallthrough += 1;
      if (!res.decision) stats.no_strategy += 1;
      else addDecision(stats, res.decision, p, ctx.settings, res.strategy);
      results.push({ product: p, decision: res.decision });
    }
    stats.margin_impact_abs = round(stats.margin_impact_abs, 2);
    timing.evaluate = Math.round(performance.now() - t);
    stats.timing_ms = timing;
    return { stats, results, products };
  };

  if (dryRun) {
    const { stats, results } = evaluate();
    stats.duration_ms = Date.now() - t0;
    return { run_id: null, stats, decisions: results.filter((r) => r.decision).map((r) => r.decision) };
  }

  try {
    return tx(db, () => {
      const runId = Number(db.prepare("INSERT INTO runs (started_at, status, trigger, stats) VALUES (?, 'running', ?, '{}')").run(ts, String(trigger)).lastInsertRowid);
      const { stats, results, products } = evaluate();
      const tw = performance.now();

      // Otevřené (čekající / schválené, neexportované) návrhy vyhodnocených produktů. Běh je dříve všechny nahradil
      // (superseded) – tím ale zahodil lidská rozhodnutí (ruční schválení, ruční cenu) a každým během vložil kopii
      // téhož návrhu (růst tabulky). Nově (SPEC §3.6, ops-1 / money-8 / ops-5):
      //  - stejný návrh (stejná nová i výchozí cena, kompatibilní stav) se PONECHÁ – jen se přesune do tohoto běhu
      //    (run_id + aktuální vysvětlení a metriky trhu); stav, ruční cena a rozhodnutí zůstávají,
      //  - otevřený návrh s ruční cenou (lidské přebití) se nezahodí: nový návrh ji převezme a čeká na schválení
      //    (příznak manual_carried); když běh změnu nenavrhne, návrh s ruční cenou zůstane otevřený,
      //  - cenu, kterou člověk v posledních 7 dnech zamítl, běh znovu automaticky neschválí (previously_rejected),
      //  - ostatní otevřené návrhy → superseded (jako dřív).
      const evaluatedIds = products.map((p) => p.id);
      const openByProduct = new Map();
      const rejectedByProduct = new Map();
      for (let i = 0; i < evaluatedIds.length; i += 20000) {
        const chunk = JSON.stringify(evaluatedIds.slice(i, i + 20000));
        for (const r of db
          .prepare(
            `SELECT id, product_id, status, old_price, new_price, manual_price, decided_by, flags FROM proposals
             WHERE status IN ('pending', 'approved') AND run_id <> ? AND product_id IN (SELECT value FROM json_each(?)) ORDER BY id`
          )
          .iterate(runId, chunk)) {
          openByProduct.set(r.product_id, r); // nejnovější otevřený návrh produktu
        }
        const since = nowIso(new Date(now.getTime() - REJECT_MEMORY_DAYS * 86400000));
        for (const r of db
          .prepare(
            `SELECT product_id, COALESCE(manual_price, new_price) AS price FROM proposals
             WHERE status = 'rejected' AND decided_at >= ? AND product_id IN (SELECT value FROM json_each(?))`
          )
          .iterate(since, chunk)) {
          const list = rejectedByProduct.get(r.product_id);
          if (list) list.push(r.price);
          else rejectedByProduct.set(r.product_id, [r.price]);
        }
      }
      const same = (a, b) => (a == null || b == null ? a == null && b == null : Math.abs(a - b) < CENT);
      const keepIds = [];
      const keepProposal = db.prepare(
        `UPDATE proposals SET run_id = ?, strategy_id = ?, segment_id = ?, target_price = ?, reference_price = ?, market_min = ?,
           competitor_count = ?, rank_before = ?, rank_after = ?, margin_before = ?, margin_after = ?, change_abs = ?, change_pct = ?,
           flags = ?, explain = ?
         WHERE id = ?`
      );
      const plan = []; // {product, decision, status, manual, flags}
      stats.kept = 0;
      stats.held_by_human = 0;
      for (const { product, decision } of results) {
        const open = openByProduct.get(product.id) || null;
        const change = decision && decision.action === 'change';
        const human = open && (open.manual_price != null || (open.status === 'approved' && open.decided_by != null && open.decided_by !== 'auto'));
        if (!change) {
          // běh změnu nenavrhl: ruční cenu (lidské přebití) nezahazovat
          if (open && open.manual_price != null) keepIds.push(open.id);
          continue;
        }
        const auto = decision.auto_approve === true;
        const flags = [...(decision.flags || [])];
        if (open && same(open.new_price, decision.new_price) && same(open.old_price, decision.old_price)) {
          // stejný návrh: ponechat, pokud stav odpovídá (lidské rozhodnutí vždy; automatické jen při stejném auto-schválení)
          const compatible = human || open.status === (auto ? 'approved' : 'pending');
          if (compatible) {
            const openFlags = parseJson(open.flags, []) || [];
            const manualFlags = openFlags.filter((f) => MANUAL_FLAGS.includes(f) || f === 'manual_carried' || f === 'previously_rejected');
            keepProposal.run(
              runId, n(decision.strategy_id), n(decision.segment_id), n(decision.target_price), n(decision.reference_price),
              n(decision.market?.min ?? null), n(decision.market?.count ?? null), n(decision.rank_before), n(decision.rank_after),
              n(decision.margin_before), n(decision.margin_after), n(decision.change_abs), n(decision.change_pct),
              json([...new Set([...flags, ...manualFlags])]), json(decision.explain || []), open.id
            );
            keepIds.push(open.id);
            stats.kept += 1;
            continue;
          }
        }
        let status = auto ? 'approved' : 'pending';
        let manual = null;
        if (open && open.manual_price != null) {
          // ruční cena se přenese do nového návrhu, ten ale čeká na nové schválení
          manual = open.manual_price;
          status = 'pending';
          const openFlags = parseJson(open.flags, []) || [];
          for (const f of openFlags) if (MANUAL_FLAGS.includes(f) && !flags.includes(f)) flags.push(f);
          flags.push('manual_carried');
          stats.held_by_human += 1;
        } else if (auto) {
          const tol = Math.max(CENT, (Math.abs(decision.new_price) * REJECT_SAME_PCT) / 100);
          const rejected = rejectedByProduct.get(product.id) || [];
          if (rejected.some((p) => p != null && Math.abs(p - decision.new_price) <= tol)) {
            status = 'pending';
            flags.push('previously_rejected');
            stats.held_by_human += 1;
          }
        }
        plan.push({ product, decision, status, manual, flags });
      }
      if (stats.held_by_human) {
        // statistiky auto/pending odpovídají skutečně uloženým stavům
        const heldAuto = plan.filter((x) => x.decision.auto_approve === true && x.status === 'pending').length;
        stats.auto_approved -= heldAuto;
        stats.pending += heldAuto;
      }

      // ostatní otevřené návrhy vyhodnocených produktů → superseded
      const keepSet = JSON.stringify(keepIds);
      let supCount = 0;
      for (let i = 0; i < evaluatedIds.length; i += 20000) {
        supCount += Number(
          db
            .prepare(
              `UPDATE proposals SET status = 'superseded' WHERE status IN ('pending', 'approved') AND run_id <> ?
               AND product_id IN (SELECT value FROM json_each(?)) AND id NOT IN (SELECT value FROM json_each(?))`
            )
            .run(runId, JSON.stringify(evaluatedIds.slice(i, i + 20000)), keepSet).changes
        );
      }
      // Úplný běh: otevřené návrhy NEAKTIVNÍCH produktů (běh je nevyhodnocuje) → superseded, aby se po opětovné
      // aktivaci produktu nevyexportoval starý návrh spočítaný z dávno neplatného trhu (money-4).
      if (productIds == null) {
        supCount += Number(
          db
            .prepare(
              `UPDATE proposals SET status = 'superseded' WHERE status IN ('pending', 'approved')
               AND product_id IN (SELECT id FROM products WHERE active = 0)`
            )
            .run().changes
        );
      }
      stats.superseded = supCount;

      const ins = db.prepare(INSERT_PROPOSAL);
      for (const { product, decision, status, manual, flags } of plan) {
        const auto = status === 'approved';
        ins.run(
          runId,
          product.id,
          n(decision.strategy_id),
          n(decision.segment_id),
          n(decision.old_price),
          decision.new_price,
          n(decision.target_price),
          n(decision.reference_price),
          n(decision.market?.min ?? null),
          n(decision.market?.count ?? null),
          n(decision.rank_before),
          n(decision.rank_after),
          n(decision.margin_before),
          n(decision.margin_after),
          n(decision.change_abs),
          n(decision.change_pct),
          status,
          json(flags),
          json(decision.explain || []),
          ts,
          auto ? ts : null,
          auto ? 'auto' : null,
          manual
        );
      }
      timing.write = Math.round(performance.now() - tw);
      stats.duration_ms = Date.now() - t0;
      db.prepare("UPDATE runs SET status = 'done', finished_at = ?, stats = ? WHERE id = ?").run(finishedAt(), json(stats), runId);
      return { run_id: runId, stats };
    });
  } catch (e) {
    // transakce je vrácena → zaznamenat neúspěšný běh zvlášť
    try {
      db.prepare("INSERT INTO runs (started_at, finished_at, status, trigger, stats, error) VALUES (?, ?, 'error', ?, '{}', ?)").run(ts, finishedAt(), String(trigger), String((e && e.message) || e));
    } catch {
      /* ani zápis chyby se nepovedl – chybu předáme volajícímu */
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Simulace

/**
 * Simulace ad-hoc strategie nad jejím segmentem (ostatní strategie se ignorují), bez zápisu.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{config: object, segment_id?: number|null, filter?: object|null, limit?: number, now?: Date|string}} opts
 * @returns {{stats: object, decisions: object[], truncated: {changes: boolean, skips: boolean, changes_total: number,
 *   skips_total: number}, errors: string[]}} decisions = nejvýše `limit` změn + nejvýše `limit` přeskočených
 */
function simulate(db, opts = {}) {
  const now = toDate(opts.now);
  const limit = Math.max(0, Math.min(5000, Number.isFinite(Number(opts.limit)) ? Math.floor(Number(opts.limit)) : 200));
  const stats = { ...emptyStats(), avg_change_pct: null, avg_margin_before: null, avg_margin_after: null };
  const errors = [];

  const strategy = prepareStrategy({ id: null, name: opts.name || 'Simulace', segment_id: null, config: opts.config });
  errors.push(...strategy.errors);

  let scope = null;
  let scopeName = null;
  if (opts.segment_id != null && opts.segment_id !== '') {
    const row = db.prepare('SELECT id, name, filter FROM segments WHERE id = ?').get(Number(opts.segment_id));
    if (!row) errors.push(`Segment ${opts.segment_id} neexistuje`);
    else {
      const seg = compileSegment(row);
      if (seg.error) errors.push(`Segment „${seg.name}“: ${seg.error}`);
      scope = seg.match;
      scopeName = seg.name;
    }
  } else if (opts.filter != null && !isEmptyFilter(opts.filter)) {
    try {
      scope = compileFilter(opts.filter);
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (errors.length) return { stats, decisions: [], errors };

  // Rozsah simulace = pseudo-segment; strategie se tak vyhodnotí jen pro produkty v rozsahu.
  const SCOPE_ID = -1;
  const scopeSeg = { id: SCOPE_ID, name: scopeName || 'Všechny produkty', filter: null, match: scope || (() => true), error: null };
  strategy.segment_id = SCOPE_ID;
  const ctx = { now, settings: getSettings(db), segments: [scopeSeg], segmentById: new Map([[SCOPE_ID, scopeSeg]]), strategies: [strategy] };
  const products = loadProducts(db);
  const offers = loadOffers(db);
  const changes = [];
  const skips = [];
  let changesTotal = 0;
  let skipsTotal = 0;
  let sumPct = 0;
  let sumMb = 0;
  let cntMb = 0;
  let sumMa = 0;
  let cntMa = 0;
  for (const p of products) {
    const list = offers.get(p.id) || [];
    const res = evaluateProduct(ctx, p, list);
    if (!res.segmentIds.includes(SCOPE_ID)) continue;
    stats.products += 1;
    let decision = res.decision;
    if (!decision) {
      const t = res.tried[0];
      if (t && t.result === 'fallthrough' && res.lastFallthrough) {
        decision = res.lastFallthrough;
        stats.fallthrough += 1;
      } else {
        stats.skipped[t ? t.code : 'not_applicable'] = (stats.skipped[t ? t.code : 'not_applicable'] || 0) + 1;
        continue;
      }
    }
    addDecision(stats, decision, p, ctx.settings, null);
    const withProduct = { ...decision, segment_id: opts.segment_id != null && opts.segment_id !== '' ? Number(opts.segment_id) : null, code: p.code, name: p.name, manufacturer: p.manufacturer };
    if (decision.action === 'change') {
      if (decision.change_pct != null) sumPct += decision.change_pct;
      if (decision.margin_before != null) {
        sumMb += decision.margin_before;
        cntMb += 1;
      }
      if (decision.margin_after != null) {
        sumMa += decision.margin_after;
        cntMa += 1;
      }
      changesTotal += 1;
      if (changes.length < limit) changes.push(withProduct);
    } else if (decision.action === 'skip') {
      skipsTotal += 1;
      if (skips.length < limit) skips.push(withProduct);
    }
  }
  const withPct = stats.up + stats.down;
  stats.avg_change_pct = withPct ? round(sumPct / withPct, 2) : null;
  stats.avg_margin_before = cntMb ? round(sumMb / cntMb, 2) : null;
  stats.avg_margin_after = cntMa ? round(sumMa / cntMa, 2) : null;
  stats.margin_impact_abs = round(stats.margin_impact_abs, 2);
  stats.segment = scopeName;
  delete stats.by_strategy;
  // Změny i přeskočené mají každé vlastní limit – dřív se přeskočené při ≥ limit změnách celé odřízly a filtr
  // „Přeskočené“ v UI hlásil „nic se nepřeskočilo“, přestože statistika ukazovala desítky (contract-6).
  return {
    stats,
    decisions: [...changes, ...skips],
    truncated: { changes: changesTotal > changes.length, skips: skipsTotal > skips.length, changes_total: changesTotal, skips_total: skipsTotal },
    errors,
  };
}

// ---------------------------------------------------------------------------------------------
// Detail produktu

/**
 * Vysvětlení aktuálního rozhodnutí cenotvorby pro jeden produkt (i neaktivní).
 * @returns {{view, segments: Array<{id, name}>, strategy: object|null, decision: object|null, tried: object[]}|null}
 */
function explainProduct(db, productId, opts = {}) {
  const [product] = loadProducts(db, { productIds: [productId], activeOnly: false });
  if (!product) return null;
  const ctx = loadContext(db, { now: opts.now });
  const offers = loadOffers(db, [product.id]).get(product.id) || [];
  const res = evaluateProduct(ctx, product, offers);
  const segments = res.segmentIds.map((id) => ({ id, name: ctx.segmentById.get(id)?.name ?? null }));
  const st = res.strategy;
  return {
    view: res.view,
    segments,
    strategy: st ? { id: st.id, name: st.name, description: st.description, segment_id: st.segment_id, priority: st.priority } : null,
    decision: res.decision || res.lastFallthrough || null,
    tried: res.tried,
  };
}

/** Poslední návrh ceny produktu (libovolný stav) s rozparsovanými flags/explain, nebo null. */
function latestProposal(db, productId) {
  const row = db.prepare('SELECT * FROM proposals WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(Number(productId));
  if (!row) return null;
  return { ...row, flags: parseJson(row.flags, []) || [], explain: parseJson(row.explain, []) || [] };
}

module.exports = {
  loadContext,
  evaluateProduct,
  runPricing,
  simulate,
  explainProduct,
  latestProposal,
  prepareStrategy,
  loadProducts,
  loadOffers,
};
