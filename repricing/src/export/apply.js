'use strict';
// Označení exportu a zápis do logu exportů (SPEC §7 apply.js, §3.7).
//
// markExported: jen návrhy, které jsou PRÁVĚ TEĎ ve stavu „approved“, přejdou na „exported“ (exported_at, export_id).
// Při settings.export.update_current_price se nová cena (manual_price ?? new_price) zapíše do products.price,
// products.price_changed_at a do price_history (source 'export', ref_id = id exportu). Pokud je cena produktu už
// stejná (admin ji mezitím naimportoval), cena ani historie se nemění – nešlo o změnu.
// Když není co označit, nevzniká řádek v `exports` (časté dotazování feedu s mark=1 by zaplavilo log) → export_id null.

const { tx, nowIso, json, getSettings, audit } = require('../db');
const { codeKey } = require('../util/keys');
const { ensurePriceBaseline } = require('../util/price-history');
const { exportRows, idList, LATEST_APPROVED_SQL } = require('./rows');
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

/**
 * Označí schválené návrhy jako exportované.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]} proposalIds
 * @param {{kind?: string, target?: string|null, actor?: string|null, now?: Date|string, detail?: object,
 *   update_current_price?: boolean}} [opts] update_current_price přebije nastavení (jinak settings.export.update_current_price)
 * @returns {{export_id: number|null, count: number, proposal_ids: number[], price_updates: number}}
 */
function markExported(db, proposalIds, opts = {}) {
  const { kind = 'feed', target = null, actor = null, detail = null } = opts;
  const ids = idList(proposalIds) || [];
  const now = nowIso(opts.now);
  if (!ids.length) return { export_id: null, count: 0, proposal_ids: [], price_updates: 0 };
  const settings = getSettings(db);
  const updatePrice = opts.update_current_price ?? settings.export?.update_current_price !== false;

  return tx(db, () => {
    const props = db
      .prepare(
        `SELECT pr.id, pr.product_id, pr.new_price, pr.manual_price, p.price AS current_price
         FROM proposals pr JOIN products p ON p.id = pr.product_id
         WHERE pr.status = 'approved' AND pr.id IN (SELECT value FROM json_each(?))
         ORDER BY pr.id`
      )
      .all(JSON.stringify(ids));
    if (!props.length) return { export_id: null, count: 0, proposal_ids: [], price_updates: 0 };

    const markedIds = props.map((p) => p.id);
    const exportId = logExport(db, {
      kind,
      target,
      count: props.length,
      status: 'ok',
      now,
      detail: { ...(detail && typeof detail === 'object' ? detail : detail != null ? { note: String(detail) } : {}), proposal_ids: markedIds.slice(0, 5000) },
    });

    const setExported = db.prepare("UPDATE proposals SET status = 'exported', exported_at = ?, export_id = ? WHERE id = ? AND status = 'approved'");
    const setPrice = db.prepare('UPDATE products SET price = ?, price_changed_at = ?, updated_at = ? WHERE id = ?');
    const addHistory = db.prepare("INSERT INTO price_history (product_id, price, source, ref_id, at) VALUES (?, ?, 'export', ?, ?)");
    const current = new Map(); // product_id → cena po předchozích změnách v této dávce
    let priceUpdates = 0;
    for (const p of props) {
      setExported.run(now, exportId, p.id);
      if (!updatePrice) continue;
      const price = p.manual_price ?? p.new_price;
      if (price == null || !(price > 0)) continue;
      const cur = current.has(p.product_id) ? current.get(p.product_id) : p.current_price;
      if (cur != null && Math.abs(cur - price) < 0.005) continue;
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
      detail: { kind, target, count: props.length, price_updates: priceUpdates, update_current_price: !!updatePrice },
    });
    return { export_id: exportId, count: props.length, proposal_ids: markedIds, price_updates: priceUpdates };
  });
}

/**
 * Potvrzení převzetí změn adminem (POST /export/ack): podle id návrhů a/nebo kódů produktů.
 * Kód se převede na nejnovější schválený návrh produktu (stejné pravidlo jako exportRows).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{proposal_ids?: number[], codes?: string[], actor?: string|null, target?: string|null, now?: Date|string}} opts
 * @returns {{export_id: number|null, count: number, proposal_ids: number[], unknown_codes: string[]}}
 */
function ackExport(db, opts = {}) {
  const ids = new Set(idList(opts.proposal_ids) || []);
  const unknown = [];
  const codes = Array.isArray(opts.codes) ? opts.codes : opts.codes != null ? String(opts.codes).split(',') : [];
  if (codes.length) {
    const find = db.prepare(
      `SELECT pr.id FROM proposals pr JOIN products p ON p.id = pr.product_id
       WHERE p.code_key = ? AND pr.status = 'approved' AND ${LATEST_APPROVED_SQL}`
    );
    for (const c of codes) {
      const key = codeKey(c);
      const r = key ? find.get(key) : null;
      if (r && r.id != null) ids.add(r.id);
      else if (c != null && String(c).trim() !== '') unknown.push(String(c));
    }
  }
  const res = markExported(db, [...ids], { kind: 'ack', target: opts.target ?? 'api', actor: opts.actor ?? null, now: opts.now });
  return { ...res, unknown_codes: unknown };
}

/** yyyymmdd (pražský čas) pro název souboru. */
const stamp = (now) => pragueDate(now);

/**
 * Změny (nebo ceník) v požadovaném formátu, volitelně rovnou označené jako exportované.
 * Sestavení těla i označení proběhne v jedné transakci – označí se přesně řádky, které jsou v těle.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{format?: 'json'|'xml'|'csv'|'xlsx', mark?: boolean, actor?: string|null, scope?: 'approved'|'all',
 *   kind?: string, target?: string|null, now?: Date|string, labels?: boolean}} [opts]
 * @returns {{body: string|Buffer, contentType: string, export_id?: number|null, count: number, filename: string}}
 */
function exportChanges(db, opts = {}) {
  const format = String(opts.format || 'json').toLowerCase();
  if (!CONTENT_TYPES[format]) throw badRequest(`Nepodporovaný formát exportu „${opts.format}“ (json, xml, csv, xlsx)`);
  const scope = opts.scope || 'approved';
  if (scope !== 'approved' && scope !== 'all') throw badRequest(`Neplatný rozsah exportu „${scope}“ (approved, all)`);
  const mark = opts.mark === true || opts.mark === 1 || opts.mark === '1' || opts.mark === 'true';

  const build = () => {
    const settings = getSettings(db);
    const rows = exportRows(db, { scope, now: opts.now });
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
      filename: `cenotvorba-${scope === 'all' ? 'cenik' : 'zmeny'}-${stamp(opts.now)}.${format}`,
    };
    if (mark) {
      const ids = rows.map((r) => r.proposal_id).filter((id) => id != null);
      const res = markExported(db, ids, { kind: opts.kind || format, target: opts.target ?? null, actor: opts.actor ?? null, now: opts.now, detail: { format, scope } });
      out.export_id = res.export_id;
      out.marked = res.count;
    }
    return out;
  };
  return mark ? tx(db, build) : build();
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
    const rows = exportRows(db, { scope, now: opts.now });
    const pohodaOpts = {
      ico: pick('ico', cfg),
      application: pick('application', cfg),
      filter_by: pick('filter_by', cfg),
      price_level: pick('price_level', cfg),
      encoding: pick('encoding', cfg),
      note: opts.note,
      now: opts.now,
    };
    let res;
    try {
      // id balíku podle id exportu – ten ale vznikne až při označení; bez označení náhodné id
      res = buildPohodaXml(rows, pohodaOpts);
    } catch (e) {
      // POHODA_EMPTY (409, nic k exportu) propustit beze změny; chybné volby (kódování, filtr) = 400
      if (e && e.status) throw e;
      throw badRequest(e.message);
    }
    let exportId;
    if (mark) {
      const ids = res.rows.map((r) => r.proposal_id).filter((id) => id != null);
      const m = markExported(db, ids, {
        kind: 'pohoda',
        target: opts.target ?? null,
        actor: opts.actor ?? null,
        now: opts.now,
        detail: { scope, pack_id: null, skipped: res.skipped.length },
      });
      exportId = m.export_id;
      if (exportId != null) {
        // přegenerovat s id balíku odvozeným z id exportu (dohledatelnost v POHODĚ i v logu)
        res = buildPohodaXml(rows, { ...pohodaOpts, export_id: exportId });
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
    return out;
  };
  return mark ? tx(db, build) : build();
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
  const rows = exportRows(db, { scope: 'approved', now: opts.now });
  if (!rows.length) return { ok: true, count: 0, status: null, export_id: null, marked: 0, skipped: 'no_changes' };
  const push = opts.push || require('./webhook').pushWebhook;
  const res = await push(rows, { ...webhook, url, template: settings.export?.xml, now: opts.now, currency: settings.currency });
  if (res && res.ok) {
    const ids = rows.map((r) => r.proposal_id).filter((id) => id != null);
    const m = markExported(db, ids, {
      kind: 'webhook',
      target: url,
      actor: opts.actor ?? null,
      now: opts.now,
      detail: { status: res.status, duration_ms: res.duration_ms, attempts: res.attempts },
    });
    return { ...res, count: rows.length, export_id: m.export_id, marked: m.count };
  }
  const exportId = logExport(db, {
    kind: 'webhook',
    target: url,
    count: rows.length,
    status: 'error',
    now: opts.now,
    detail: { status: res?.status ?? null, error: res?.error ?? null, body: res?.body ?? null, attempts: res?.attempts ?? null },
  });
  return { ok: false, status: null, ...res, count: rows.length, export_id: exportId, marked: 0 };
}

module.exports = { markExported, logExport, exportChanges, exportPohoda, pushChanges, ackExport, EXPORT_KINDS, CONTENT_TYPES };
