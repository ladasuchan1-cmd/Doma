'use strict';
// Označení exportu a zápis do logu exportů (SPEC §7 apply.js, §3.7).
//
// markExported: jen návrhy, které jsou PRÁVĚ TEĎ ve stavu „approved“, přejdou na „exported“ (exported_at, export_id).
// Při settings.export.update_current_price se cena zapíše do products.price, products.price_changed_at a do price_history
// (source 'export', ref_id = id exportu). Pokud je cena produktu už stejná (admin ji mezitím naimportoval), cena ani
// historie se nemění – nešlo o změnu.
// Když není co označit, nevzniká řádek v `exports` (časté dotazování feedu s mark=1 by zaplavilo log) → export_id null.
//
// Označuje se to, co admin SKUTEČNĚ dostal (money-5, money-6, ops-4):
//  - `delivered` (id návrhu → doručená cena): návrh se označí, jen když jeho cena k exportu je pořád ta doručená
//    (ruční cena upravená během odesílání webhooku / mezi stažením feedu a potvrzením = „changed_since_delivery“,
//    návrh zůstane schválený a odešle se znovu). Do products.price a historie jde DORUČENÁ cena.
//  - Vydání řádků (feed / export / ceník bez označení) si návrh pamatuje (served_price, served_at). Potvrzení podle
//    kódů (ackExport) pak označí vydaný návrh – i když ho mezitím nové přecenění nahradilo (superseded) – a nikdy
//    novější návrh, který admin neviděl.
//  - Zamčený produkt se neoznačí ani nepřecení (skipped: locked); schválený návrh, který neprojde kontrolou
//    rows.holdReason (cena mimo limity, změněná báze), také ne.

const { tx, nowIso, json, getSettings, audit } = require('../db');
const { codeKey } = require('../util/keys');
const { ensurePriceBaseline } = require('../util/price-history');
const { exportRowsDetailed, idList, holdReason, lowestPrices, changePct, LATEST_APPROVED_SQL, PRODUCT_COLS } = require('./rows');
const { isLockActive } = require('../engine/metrics');
const { CENT } = require('../util/proposals');
const { round } = require('../util/num');
const feeds = require('./feeds');
const { buildPohodaXml, pragueDate } = require('./pohoda');
const { rowsXlsx } = require('./xlsx-report');

const EXPORT_KINDS = ['feed', 'pohoda', 'webhook', 'csv', 'xlsx', 'json', 'xml', 'ack'];

const CONTENT_TYPES = {
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  e.code = 'EXPORT_BAD_REQUEST';
  return e;
}

/**
 * Zapíše řádek do logu exportů.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{kind: string, target?: string|null, count?: number, status?: 'ok'|'error'|'pending', detail?: any, now?: Date|string}} entry
 * @returns {number} id exportu
 */
function logExport(db, { kind, target = null, count = 0, status = 'ok', detail = null, now } = {}) {
  if (!kind) throw new Error('logExport: chybí druh exportu (kind)');
  const r = db
    .prepare('INSERT INTO exports (created_at, kind, target, count, status, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(nowIso(now), String(kind), target == null ? null : String(target), Number(count) || 0, String(status), detail == null ? null : typeof detail === 'string' ? detail : json(detail));
  return Number(r.lastInsertRowid);
}

/** Map id návrhu → doručená cena z Map / objektu / pole řádků exportu ({proposal_id, price}). */
function deliveredMap(v) {
  if (v == null) return null;
  const out = new Map();
  const put = (id, price) => {
    const n = Number(id);
    const pr = Number(price);
    if (Number.isInteger(n) && n > 0 && Number.isFinite(pr) && pr > 0) out.set(n, round(pr, 2));
  };
  if (v instanceof Map) for (const [id, price] of v) put(id, price);
  else if (Array.isArray(v)) for (const r of v) if (r && r.proposal_id != null) put(r.proposal_id, r.price);
  else if (typeof v === 'object') for (const [id, price] of Object.entries(v)) put(id, price);
  return out;
}

/**
 * Zapamatuje si, že řádky exportu byly vydány (feed / export / ceník) – cena a čas u návrhu (served_price, served_at).
 * Potvrzení převzetí podle kódů pak označí přesně vydaný návrh (viz ackExport).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object[]} rows řádky exportRows ({proposal_id, price})
 */
function markServed(db, rows, now) {
  const list = (rows || []).filter((r) => r && r.proposal_id != null && r.price > 0);
  if (!list.length) return 0;
  const at = nowIso(now);
  // Zapisuje se jen první vydání dané ceny – opakované stahování feedu (třeba každou minutu) nic nepřepisuje.
  const upd = db.prepare(
    `UPDATE proposals SET served_price = ?, served_at = ?
     WHERE id = ? AND status = 'approved' AND (served_price IS NULL OR ABS(served_price - ?) >= ${CENT})`
  );
  let n = 0;
  tx(db, () => {
    for (const r of list) n += Number(upd.run(r.price, at, r.proposal_id, r.price).changes);
  });
  return n;
}

/**
 * Označí schválené návrhy jako exportované.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]} proposalIds
 * @param {{kind?: string, target?: string|null, actor?: string|null, now?: Date|string, detail?: object,
 *   update_current_price?: boolean, delivered?: Map<number, number>|object|object[], served?: Iterable<number>}} [opts]
 *   update_current_price přebije nastavení (jinak settings.export.update_current_price);
 *   delivered = id → doručená cena (označí se jen, když cena návrhu pořád odpovídá; zapíše se doručená cena);
 *   served = id návrhů, které smí být i „superseded“ (vydané adminovi dřív, než je nahradilo nové přecenění – ackExport)
 * @returns {{export_id: number|null, count: number, proposal_ids: number[], price_updates: number,
 *   skipped: Array<{proposal_id: number, reason: string, current_price?: number}>}}
 */
function markExported(db, proposalIds, opts = {}) {
  const { kind = 'feed', target = null, actor = null, detail = null } = opts;
  const ids = idList(proposalIds) || [];
  const now = nowIso(opts.now);
  const empty = { export_id: null, count: 0, proposal_ids: [], price_updates: 0, skipped: [] };
  if (!ids.length) return empty;
  const settings = getSettings(db);
  const updatePrice = opts.update_current_price ?? settings.export?.update_current_price !== false;
  const delivered = deliveredMap(opts.delivered);
  const served = new Set(idList(opts.served ? [...opts.served] : []) || []);
  const vatDefault = settings.vat_rate_default ?? 21;

  return tx(db, () => {
    const rows = db
      .prepare(
        `SELECT pr.id, pr.product_id, pr.status, pr.old_price, pr.new_price, pr.manual_price, pr.flags, pr.decided_by, ${PRODUCT_COLS}
         FROM proposals pr JOIN products p ON p.id = pr.product_id
         WHERE pr.status IN ('approved', 'superseded') AND pr.id IN (SELECT value FROM json_each(?))
         ORDER BY pr.id`
      )
      .all(JSON.stringify(ids));
    const skipped = [];
    const props = [];
    for (const r of rows) {
      if (r.status === 'superseded' && !served.has(r.id)) continue; // nahrazený a nevydaný → nic
      if (isLockActive(r, now)) {
        skipped.push({ proposal_id: r.id, reason: 'locked' });
        continue;
      }
      const final = r.manual_price ?? r.new_price;
      const want = delivered && delivered.has(r.id) ? delivered.get(r.id) : null;
      if (want != null && Math.abs(final - want) >= CENT) {
        // cena návrhu se od doručení změnila (ruční cena) – označit by znamenalo zapsat cenu, kterou admin nemá
        skipped.push({ proposal_id: r.id, reason: 'changed_since_delivery', delivered_price: want, current_price: final });
        continue;
      }
      if (r.status === 'approved') {
        const reason = holdReason(r, r, { now, vatDefault });
        if (reason) {
          skipped.push({ proposal_id: r.id, reason });
          continue;
        }
      }
      props.push({ ...r, price: want ?? final });
    }
    if (!props.length) return { ...empty, skipped };

    const markedIds = props.map((p) => p.id);
    const exportId = logExport(db, {
      kind,
      target,
      count: props.length,
      status: 'ok',
      now,
      detail: {
        ...(detail && typeof detail === 'object' ? detail : detail != null ? { note: String(detail) } : {}),
        proposal_ids: markedIds.slice(0, 5000),
        ...(skipped.length ? { skipped: skipped.slice(0, 1000) } : {}),
      },
    });

    // exported_price = cena, kterou export skutečně doručil (znovustažení exportu – exportedRows)
    const setExported = db.prepare(
      "UPDATE proposals SET status = 'exported', exported_at = ?, export_id = ?, exported_price = ? WHERE id = ? AND status IN ('approved', 'superseded')"
    );
    const setPrice = db.prepare('UPDATE products SET price = ?, price_changed_at = ?, updated_at = ? WHERE id = ?');
    const addHistory = db.prepare("INSERT INTO price_history (product_id, price, source, ref_id, at) VALUES (?, ?, 'export', ?, ?)");
    const current = new Map(); // product_id → cena po předchozích změnách v této dávce
    let priceUpdates = 0;
    for (const p of props) {
      setExported.run(now, exportId, p.price ?? null, p.id);
      if (!updatePrice) continue;
      const price = p.price;
      if (price == null || !(price > 0)) continue;
      const cur = current.has(p.product_id) ? current.get(p.product_id) : p.current_price;
      if (cur != null && Math.abs(cur - price) < CENT) continue;
      // Vydaný, ale mezitím nahrazený návrh: cenu produktu přepsat jen tehdy, když ji od výpočtu návrhu nic jiného
      // nezměnilo (jinak má přednost novější údaj, typicky import katalogu z POHODY).
      if (p.status === 'superseded' && (p.old_price == null || cur == null || Math.abs(cur - p.old_price) >= CENT)) continue;
      // dosavadní cenu zapsat do historie, pokud tam ještě není (jinak by lowest_30d po zdražení ukazovala novou cenu)
      ensurePriceBaseline(db, { id: p.product_id });
      setPrice.run(price, now, now, p.product_id);
      addHistory.run(p.product_id, price, exportId, now);
      current.set(p.product_id, price);
      priceUpdates++;
    }

    audit(db, {
      actor,
      action: 'export',
      entity: 'export',
      entity_id: exportId,
      detail: { kind, target, count: props.length, price_updates: priceUpdates, update_current_price: !!updatePrice, skipped: skipped.length },
    });
    return { export_id: exportId, count: props.length, proposal_ids: markedIds, price_updates: priceUpdates, skipped };
  });
}

/** Cena z těla ack (číslo nebo „12 990“) → číslo > 0, jinak null. */
function ackPrice(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? round(n, 2) : null;
}

/**
 * Potvrzení převzetí změn adminem (POST /export/ack).
 * Doporučeno: `items: [{code | proposal_id, price}]` – co admin skutečně převzal a za jakou cenu. Označí se návrh, jehož
 * doručená cena (served_price, resp. aktuální cena schváleného návrhu) odpovídá; jinak se nic neoznačí a položka se
 * vrátí v `mismatched`.
 * Starší tvary: `proposal_ids` (bez ceny – označí návrh, pokud se od vydání nezměnila jeho cena) a `codes` (bez ceny –
 * označí naposledy VYDANÝ návrh produktu i když ho mezitím nahradilo přecenění; nevydaný novější návrh nikdy. Když
 * nebylo vydáno nic, použije se nejnovější schválený návrh).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{items?: Array<{code?: string, proposal_id?: number, price?: number}>, proposal_ids?: number[], codes?: string[],
 *   actor?: string|null, target?: string|null, now?: Date|string}} opts
 * @returns {{export_id: number|null, count: number, proposal_ids: number[], unknown_codes: string[],
 *   mismatched: object[], skipped: object[]}}
 */
function ackExport(db, opts = {}) {
  const entries = [];
  for (const id of idList(opts.proposal_ids) || []) entries.push({ proposal_id: id, price: null });
  const codes = Array.isArray(opts.codes) ? opts.codes : opts.codes != null ? String(opts.codes).split(',') : [];
  for (const c of codes) entries.push({ code: c, price: null });
  for (const it of Array.isArray(opts.items) ? opts.items : []) {
    if (!it || typeof it !== 'object') continue;
    entries.push({ code: it.code ?? null, proposal_id: it.proposal_id ?? null, price: ackPrice(it.price) });
  }

  const unknown = [];
  const mismatched = [];
  const delivered = new Map();
  const served = new Set();
  const byId = db.prepare(
    `SELECT pr.id, pr.product_id, pr.status, pr.new_price, pr.manual_price, pr.served_price, pr.served_at, p.code
     FROM proposals pr JOIN products p ON p.id = pr.product_id WHERE pr.id = ?`
  );
  const productByCode = db.prepare('SELECT id, code FROM products WHERE code_key = ?');
  const latestApproved = db.prepare(
    `SELECT pr.id, pr.product_id, pr.status, pr.new_price, pr.manual_price, pr.served_price, pr.served_at FROM proposals pr
     WHERE pr.product_id = ? AND pr.status = 'approved' AND ${LATEST_APPROVED_SQL}`
  );
  // vydané a dosud neexportované návrhy produktu, novější než poslední exportovaný (starší už admin přepsal)
  const servedOf = db.prepare(
    `SELECT pr.id, pr.product_id, pr.status, pr.new_price, pr.manual_price, pr.served_price, pr.served_at FROM proposals pr
     WHERE pr.product_id = ? AND pr.served_at IS NOT NULL AND pr.status IN ('approved', 'superseded')
       AND pr.id > COALESCE((SELECT MAX(y.id) FROM proposals y WHERE y.product_id = pr.product_id AND y.status = 'exported'), 0)
     ORDER BY pr.served_at DESC, pr.id DESC`
  );
  const eq = (a, b) => a != null && b != null && Math.abs(a - b) < CENT;
  const finalOf = (r) => r.manual_price ?? r.new_price;
  const accept = (r, price) => {
    delivered.set(r.id, price);
    if (r.status === 'superseded') served.add(r.id);
  };
  const mismatch = (e, r, why) =>
    mismatched.push({
      code: e.code ?? r?.code ?? null,
      proposal_id: e.proposal_id ?? null,
      delivered: e.price ?? r?.served_price ?? null,
      current_proposal_id: r ? r.id : null,
      current_price: r ? finalOf(r) : null,
      reason: why,
    });

  for (const e of entries) {
    if (e.proposal_id != null) {
      const id = Number(e.proposal_id);
      const r = Number.isInteger(id) && id > 0 ? byId.get(id) : null;
      if (!r || (r.status !== 'approved' && !(r.status === 'superseded' && r.served_at))) {
        // neexistuje / už exportováno / zamítnuto / vráceno k novému schválení / nahrazeno a nevydáno
        mismatch(e, r, 'not_open');
        continue;
      }
      if (r.status === 'approved') {
        const cur = finalOf(r);
        if (e.price != null) {
          if (!eq(e.price, cur)) mismatch(e, r, 'price_mismatch');
          else accept(r, e.price);
        } else if (r.served_at && !eq(r.served_price, cur)) {
          // vydáno za jinou cenu, než jakou má návrh teď (ruční cena upravená po stažení) – admin tuhle cenu nemá
          mismatch(e, r, 'changed_since_delivery');
        } else accept(r, r.served_at ? r.served_price : cur);
      } else if (e.price != null && !eq(e.price, r.served_price)) mismatch(e, r, 'price_mismatch');
      else accept(r, r.served_price);
      continue;
    }
    const key = codeKey(e.code);
    const prod = key ? productByCode.get(key) : null;
    if (!prod) {
      if (e.code != null && String(e.code).trim() !== '') unknown.push(String(e.code));
      continue;
    }
    const cur = latestApproved.get(prod.id) || null;
    const servedList = servedOf.all(prod.id);
    if (e.price != null) {
      // doručená cena rozhoduje: aktuální schválený se stejnou cenou, jinak vydaný návrh s touto cenou
      let hit = null;
      if (cur && eq(finalOf(cur), e.price) && (cur.served_at == null || eq(cur.served_price, e.price))) hit = cur;
      if (!hit) hit = servedList.find((r) => eq(r.served_price, e.price) && (r.status !== 'approved' || eq(finalOf(r), e.price))) || null;
      if (!hit) {
        mismatch(e, cur && { ...cur, code: prod.code }, 'price_mismatch');
        continue;
      }
      accept(hit, e.price);
      continue;
    }
    // bez ceny: naposledy vydaný návrh, jinak (nic nevydáno) nejnovější schválený
    const last = servedList[0] || null;
    if (last) {
      if (last.status === 'approved' && !eq(finalOf(last), last.served_price)) {
        mismatch(e, { ...last, code: prod.code }, 'changed_since_delivery');
        continue;
      }
      accept(last, last.served_price);
    } else if (cur) accept(cur, finalOf(cur));
    else unknown.push(String(e.code));
  }
  const res = markExported(db, [...delivered.keys()], {
    kind: 'ack',
    target: opts.target ?? 'api',
    actor: opts.actor ?? null,
    now: opts.now,
    delivered,
    served,
  });
  return { ...res, unknown_codes: unknown, mismatched };
}

/**
 * Řádky, které doručil export `exportId` (návrhy s export_id = exportId), ve stejném tvaru jako feed změn (Row, §7).
 * price = doručená cena (exported_price; u starších exportů manual_price ?? new_price – jiná se označit nedala),
 * lowest_30d = nejnižší cena za 30 dní PŘED exportem (bez exportované ceny), changed_at = čas rozhodnutí.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} exportId
 * @returns {{export: object|null, rows: object[]}} export = řádek logu exportů (null = neexistuje)
 */
function exportedRows(db, exportId) {
  const id = Number(exportId);
  const exp = Number.isSafeInteger(id) && id > 0 ? db.prepare('SELECT * FROM exports WHERE id = ?').get(id) : null;
  if (!exp) return { export: null, rows: [] };
  const settings = getSettings(db);
  const list = db
    .prepare(
      `SELECT pr.id AS proposal_id, pr.product_id, pr.old_price, pr.new_price, pr.manual_price, pr.exported_price, pr.change_pct,
              pr.created_at, pr.decided_at, p.code, p.ean, p.name, p.manufacturer, p.vat_rate, s.name AS strategy_name, g.name AS segment_name
       FROM proposals pr
       JOIN products p ON p.id = pr.product_id
       LEFT JOIN strategies s ON s.id = pr.strategy_id
       LEFT JOIN segments g ON g.id = pr.segment_id
       WHERE pr.export_id = ? ORDER BY p.code_key, pr.id`
    )
    .all(id);
  if (!list.length) return { export: { ...exp }, rows: [] };
  // nejnižší cena za 30 dní před okamžikem exportu (záznam historie samotného exportu má at = čas exportu → o 1 ms dřív)
  const before = new Date(Date.parse(exp.created_at) - 1);
  const lowest = lowestPrices(db, before, [...new Set(list.map((r) => r.product_id))]);
  const money = (v) => (v == null || !Number.isFinite(Number(v)) ? null : round(Number(v), 2));
  const rows = list.map((r) => {
    const price = money(r.exported_price ?? r.manual_price ?? r.new_price);
    const oldPrice = money(r.old_price);
    let low = lowest.get(r.product_id);
    if (oldPrice != null && oldPrice > 0 && (low === undefined || oldPrice < low)) low = oldPrice;
    return {
      proposal_id: r.proposal_id,
      product_id: r.product_id,
      code: r.code,
      ean: r.ean ?? null,
      name: r.name ?? null,
      manufacturer: r.manufacturer ?? null,
      price,
      old_price: oldPrice,
      change_pct: changePct(oldPrice, price) ?? r.change_pct ?? null,
      vat_rate: r.vat_rate ?? settings.vat_rate_default ?? null,
      currency: settings.currency || 'CZK',
      changed_at: r.decided_at || r.created_at || null,
      strategy: r.strategy_name ?? null,
      segment: r.segment_name ?? null,
      lowest_30d: low === undefined ? null : money(low),
    };
  });
  return { export: { ...exp }, rows };
}

/**
 * Znovustažení exportu (C8): řádky exportu `exportId` ve formátu feedu změn. Nic neoznačuje ani nezapisuje.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} exportId
 * @param {{format?: 'json'|'xml'|'csv', now?: Date|string}} [opts]
 * @returns {{body: string, contentType: string, filename: string, count: number, export_id: number}|null} null = export
 *   neexistuje nebo nemá žádné návrhy
 */
function exportRedownload(db, exportId, opts = {}) {
  const format = String(opts.format || 'json').toLowerCase();
  if (!['json', 'xml', 'csv'].includes(format)) throw badRequest(`Nepodporovaný formát „${opts.format}“ (json, xml, csv)`);
  const { export: exp, rows } = exportedRows(db, exportId);
  if (!exp || !rows.length) return null;
  const settings = getSettings(db);
  const fo = { now: opts.now, currency: settings.currency };
  let body;
  if (format === 'json') body = JSON.stringify(feeds.toJson(rows, fo));
  else if (format === 'xml') body = feeds.toXml(rows, settings.export?.xml, fo);
  else body = feeds.toCsv(rows, {});
  return { body, contentType: CONTENT_TYPES[format], filename: `cenotvorba-export-${exp.id}.${format}`, count: rows.length, export_id: exp.id };
}

/** yyyymmdd (pražský čas) pro název souboru. */
const stamp = (now) => pragueDate(now);

/**
 * Změny (nebo ceník) v požadovaném formátu, volitelně rovnou označené jako exportované.
 * Sestavení těla i označení proběhne v jedné transakci – označí se přesně řádky, které jsou v těle (s jejich cenou).
 * Bez označení se vydané řádky zapamatují (served_price) pro pozdější potvrzení převzetí (ack), pokud serve !== false.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{format?: 'json'|'xml'|'csv'|'xlsx', mark?: boolean, actor?: string|null, scope?: 'approved'|'all',
 *   kind?: string, target?: string|null, now?: Date|string, labels?: boolean, serve?: boolean}} [opts]
 * @returns {{body: string|Buffer, contentType: string, export_id?: number|null, count: number, filename: string,
 *   held: object[], marked?: number}}
 */
function exportChanges(db, opts = {}) {
  const format = String(opts.format || 'json').toLowerCase();
  if (!CONTENT_TYPES[format]) throw badRequest(`Nepodporovaný formát exportu „${opts.format}“ (json, xml, csv, xlsx)`);
  const scope = opts.scope || 'approved';
  if (scope !== 'approved' && scope !== 'all') throw badRequest(`Neplatný rozsah exportu „${scope}“ (approved, all)`);
  const mark = opts.mark === true || opts.mark === 1 || opts.mark === '1' || opts.mark === 'true';
  const serve = opts.serve !== false;

  const build = () => {
    const settings = getSettings(db);
    const { rows, held } = exportRowsDetailed(db, { scope, now: opts.now });
    const fo = { now: opts.now, currency: settings.currency };
    let body;
    if (format === 'json') body = JSON.stringify(feeds.toJson(rows, fo));
    else if (format === 'xml') body = feeds.toXml(rows, settings.export?.xml, fo);
    else if (format === 'csv') body = feeds.toCsv(rows, { labels: opts.labels });
    else body = rowsXlsx(rows, { sheet: scope === 'all' ? 'Ceník' : 'Změny cen' });
    const out = {
      body,
      contentType: CONTENT_TYPES[format],
      count: rows.length,
      held,
      filename: `cenotvorba-${scope === 'all' ? 'cenik' : 'zmeny'}-${stamp(opts.now)}.${format}`,
    };
    if (mark) {
      const ids = rows.map((r) => r.proposal_id).filter((id) => id != null);
      const res = markExported(db, ids, {
        kind: opts.kind || format,
        target: opts.target ?? null,
        actor: opts.actor ?? null,
        now: opts.now,
        detail: { format, scope, held: held.length },
        delivered: rows,
      });
      out.export_id = res.export_id;
      out.marked = res.count;
    } else if (serve) markServed(db, rows, opts.now);
    return out;
  };
  return mark || serve ? tx(db, build) : build();
}

/**
 * POHODA XML z exportRows podle settings.export.pohoda (přebitelné v opts), volitelně s označením exportu.
 * Označí se jen řádky, které se do XML skutečně zapsaly (ne vynechané).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{scope?: 'approved'|'all', mark?: boolean, actor?: string|null, encoding?: string, filter_by?: string,
 *   price_level?: string, ico?: string, application?: string, note?: string, now?: Date|string, target?: string|null}} [opts]
 * @returns {{body: Buffer, contentType: string, filename: string, export_id?: number|null, count: number, id: string,
 *   skipped: object[]}}
 * @throws chyba se `status` 409 a `code` 'POHODA_EMPTY' (+ `skipped`), když není co exportovat (POHODA nepřijme prázdný
 *   dataPack); se `status` 400 při neplatné volbě (kódování, filtr, rozsah). Při chybě se nic neoznačí.
 */
function exportPohoda(db, opts = {}) {
  const scope = opts.scope || 'approved';
  if (scope !== 'approved' && scope !== 'all') throw badRequest(`Neplatný rozsah exportu „${scope}“ (approved, all)`);
  const mark = opts.mark === true || opts.mark === 1 || opts.mark === '1' || opts.mark === 'true';
  const pick = (k, cfg) => (opts[k] != null && opts[k] !== '' ? opts[k] : cfg[k]);

  const build = () => {
    const cfg = getSettings(db).export?.pohoda || {};
    const { rows, held } = exportRowsDetailed(db, { scope, now: opts.now });
    // zadržené návrhy (rows.holdReason) patří mezi vynechané – ať je admin v odpovědi vidí
    const heldSkipped = held.map((h) => ({ product_id: h.product_id, proposal_id: h.proposal_id, code: h.code, ean: null, reason: `held_${h.reason}`, message: h.message }));
    const pohodaOpts = {
      ico: pick('ico', cfg),
      application: pick('application', cfg),
      filter_by: pick('filter_by', cfg),
      price_level: pick('price_level', cfg),
      price_level_includes_vat: opts.price_level_includes_vat ?? cfg.price_level_includes_vat,
      encoding: pick('encoding', cfg),
      note: opts.note,
      now: opts.now,
    };
    let res;
    try {
      // id balíku podle id exportu – ten ale vznikne až při označení; bez označení náhodné id
      res = buildPohodaXml(rows, pohodaOpts);
    } catch (e) {
      // POHODA_EMPTY (409, nic k exportu) propustit (+ zadržené návrhy); chybné volby (kódování, filtr) = 400
      if (e && e.status) {
        if (e.code === 'POHODA_EMPTY' && heldSkipped.length) {
          e.skipped = [...(e.skipped || []), ...heldSkipped];
          e.message = `${e.message} (zadrženo ${heldSkipped.length} schválených návrhů: ${[...new Set(heldSkipped.map((x) => x.message))].join(', ')})`;
        }
        throw e;
      }
      throw badRequest(e.message);
    }
    res.skipped = [...res.skipped, ...heldSkipped];
    let exportId;
    if (mark) {
      const ids = res.rows.map((r) => r.proposal_id).filter((id) => id != null);
      const m = markExported(db, ids, {
        kind: 'pohoda',
        target: opts.target ?? null,
        actor: opts.actor ?? null,
        now: opts.now,
        detail: { scope, pack_id: null, skipped: res.skipped.length },
        delivered: res.rows,
      });
      exportId = m.export_id;
      if (exportId != null) {
        // přegenerovat s id balíku odvozeným z id exportu (dohledatelnost v POHODĚ i v logu)
        res = buildPohodaXml(rows, { ...pohodaOpts, export_id: exportId });
        res.skipped = [...res.skipped, ...heldSkipped];
        db.prepare('UPDATE exports SET detail = ? WHERE id = ?').run(
          json({ scope, pack_id: res.id, skipped: res.skipped.length, proposal_ids: m.proposal_ids.slice(0, 5000) }),
          exportId
        );
      }
    }
    const out = {
      body: res.buffer,
      contentType: res.contentType,
      filename: `pohoda-ceny-${stamp(opts.now)}.xml`,
      count: res.count,
      id: res.id,
      skipped: res.skipped,
    };
    if (mark) out.export_id = exportId ?? null;
    else if (opts.serve !== false) markServed(db, res.rows, opts.now);
    return out;
  };
  return tx(db, build);
}

/**
 * Odešle schválené změny webhookem podle settings.export.webhook (POST /export/push) a při úspěchu je označí
 * jako exportované (kind 'webhook'). Při neúspěchu se nic neoznačí a do logu exportů se zapíše chyba.
 * Nikdy nevyhazuje kvůli síti (pushWebhook), jen kvůli chybě databáze.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{actor?: string|null, now?: Date|string, webhook?: object, push?: Function}} [opts]
 *   webhook = přebití nastavení {url, format, headers, timeout_ms, retries, retry_delays_ms}; push = náhrada pushWebhook (testy)
 * @returns {Promise<{ok: boolean, count: number, status: number|null, body?: string, duration_ms?: number, attempts?: number,
 *   error?: string, export_id: number|null, marked: number, skipped?: string}>}
 */
async function pushChanges(db, opts = {}) {
  const settings = getSettings(db);
  const webhook = { ...(settings.export?.webhook || {}), ...(opts.webhook || {}) };
  const url = String(webhook.url || '').trim();
  if (!url) return { ok: false, count: 0, status: null, error: 'Není nastavena URL webhooku (Nastavení → Export)', export_id: null, marked: 0 };
  const { rows, held } = exportRowsDetailed(db, { scope: 'approved', now: opts.now });
  if (!rows.length) return { ok: true, count: 0, status: null, export_id: null, marked: 0, skipped: 'no_changes', held };
  const push = opts.push || require('./webhook').pushWebhook;
  const res = await push(rows, { ...webhook, url, template: settings.export?.xml, now: opts.now, currency: settings.currency });
  if (res && res.ok) {
    const ids = rows.map((r) => r.proposal_id).filter((id) => id != null);
    // Mezi sestavením řádků a koncem odeslání (až desítky sekund) se návrh mohl změnit – označit jen doručené ceny.
    const m = markExported(db, ids, {
      kind: 'webhook',
      target: url,
      actor: opts.actor ?? null,
      now: opts.now,
      detail: { status: res.status, duration_ms: res.duration_ms, attempts: res.attempts },
      delivered: rows,
    });
    return { ...res, count: rows.length, export_id: m.export_id, marked: m.count, not_marked: m.skipped, held };
  }
  const exportId = logExport(db, {
    kind: 'webhook',
    target: url,
    count: rows.length,
    status: 'error',
    now: opts.now,
    detail: { status: res?.status ?? null, error: res?.error ?? null, body: res?.body ?? null, attempts: res?.attempts ?? null },
  });
  return { ok: false, status: null, ...res, count: rows.length, export_id: exportId, marked: 0, held };
}

module.exports = {
  markExported,
  markServed,
  logExport,
  exportChanges,
  exportPohoda,
  pushChanges,
  ackExport,
  exportedRows,
  exportRedownload,
  deliveredMap,
  EXPORT_KINDS,
  CONTENT_TYPES,
};
