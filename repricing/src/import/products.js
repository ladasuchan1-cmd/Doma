'use strict';
// Import katalogu (SPEC §5 products.js): upsert podle code_key, historie cen, sloučení attrs, deaktivace chybějících.
//
// Pravidla:
//  - mění se jen pole, která záznam obsahuje (undefined = beze změny; null = smazat hodnotu)
//  - pole spravovaná v aplikaci (locked, locked_until, min_price, max_price, note) se změní jen tehdy, když je záznam
//    výslovně obsahuje – applyMapping je z návrhu mapování nikdy nevytvoří
//  - attrs: nové klíče přepisují, ostatní zůstávají; null = atribut smazat
//  - změna ceny (stará i nová známá) → price_history (source 'import') + price_changed_at. Nový produkt ani první
//    doplnění ceny se za změnu nepovažují (strategie „doprodej“ bere „nikdy neměněno“ jako splatné).
//  - nastavení purchase_includes_vat → nákupní cena se převede na cenu bez DPH (DPH záznamu / produktu / výchozí)
//  - price_is_net (mapping.price_net) → price, msrp, min_price, max_price se převedou na ceny s DPH

const { tx, nowIso, getSettings, parseJson } = require('../db');
const { codeKey, eanKey, mpnKey } = require('../util/keys');
const { parseNumber, round } = require('../util/num');
const { normalizeCode, normalizeText, parseBool, parseVat, parseDate, errorCollector } = require('./mapping');

const TEXT_FIELDS = ['name', 'manufacturer', 'category', 'supplier', 'owner'];
const NUMBER_FIELDS = ['purchase_price', 'price', 'msrp', 'stock', 'sales_30', 'sales_90', 'min_price', 'max_price'];
const GROSS_FIELDS = ['price', 'msrp', 'min_price', 'max_price'];
const BOOL_FIELDS = ['active', 'locked'];
// sloupce porovnávané pro rozlišení updated / unchanged
const COMPARE = [
  'code', 'ean', 'ean_key', 'mpn', 'mpn_key', 'name', 'manufacturer', 'category', 'supplier', 'owner', 'purchase_price', 'price', 'vat_rate', 'msrp', 'stock',
  'sales_30', 'sales_90', 'active', 'locked', 'locked_until', 'min_price', 'max_price', 'note',
];
const LABELS = {
  purchase_price: 'Nákupní cena', price: 'Prodejní cena', msrp: 'MOC', stock: 'Sklad', sales_30: 'Prodeje 30 dní', sales_90: 'Prodeje 90 dní',
  min_price: 'Minimální cena', max_price: 'Maximální cena', vat_rate: 'Sazba DPH', active: 'Aktivní', locked: 'Zamčeno', locked_until: 'Zamčeno do',
};

function same(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return false;
}

function toNum(v) {
  if (v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  const n = parseNumber(v);
  return n == null ? undefined : n;
}

function parseAttrs(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const o = parseJson(v, null);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  }
  return typeof v === 'object' && !Array.isArray(v) ? v : null;
}

/**
 * Z (kanonického) záznamu vybere a znormalizuje pole. Vrací {code, key, set: {pole: hodnota}, attrs, warnings}.
 * Pole s neplatnou hodnotou se vynechá a přidá se varování.
 */
function normalizeRecord(rec) {
  const warnings = [];
  const code = normalizeCode(rec.code);
  const key = codeKey(code);
  const set = {};
  for (const f of TEXT_FIELDS) if (rec[f] !== undefined) set[f] = normalizeText(rec[f], true);
  if (rec.note !== undefined) set.note = normalizeText(rec.note, false);
  if (rec.ean !== undefined) set.ean = normalizeCode(rec.ean);
  if (rec.mpn !== undefined) set.mpn = normalizeCode(rec.mpn);
  for (const f of NUMBER_FIELDS) {
    if (rec[f] === undefined) continue;
    const n = toNum(rec[f]);
    if (n === undefined) warnings.push(`Pole „${LABELS[f]}“: hodnota „${rec[f]}“ není číslo`);
    else set[f] = n;
  }
  if (rec.vat_rate !== undefined) {
    const n = rec.vat_rate === null || rec.vat_rate === '' ? null : parseVat(rec.vat_rate);
    if (n == null && rec.vat_rate !== null && rec.vat_rate !== '') warnings.push(`Pole „Sazba DPH“: neplatná hodnota „${rec.vat_rate}“`);
    else set.vat_rate = n;
  }
  for (const f of BOOL_FIELDS) {
    if (rec[f] === undefined) continue;
    const b = rec[f] === null || rec[f] === '' ? null : parseBool(rec[f]);
    if (b == null && rec[f] !== null && rec[f] !== '') warnings.push(`Pole „${LABELS[f]}“: hodnota „${rec[f]}“ není ano/ne`);
    else if (b != null) set[f] = b;
    else if (f === 'locked') set[f] = 0; // prázdný zámek = odemčeno (sloupec je NOT NULL)
  }
  if (rec.locked_until !== undefined) {
    const d = rec.locked_until === null || rec.locked_until === '' ? null : parseDate(rec.locked_until);
    if (d == null && rec.locked_until !== null && rec.locked_until !== '') warnings.push(`Pole „Zamčeno do“: neplatné datum „${rec.locked_until}“`);
    else set.locked_until = d;
  }
  const attrs = rec.attrs !== undefined ? parseAttrs(rec.attrs) : null;
  return { code, key, set, attrs, warnings, priceIsNet: rec.price_is_net === true };
}

/**
 * Importuje katalog.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object[]} records kanonické záznamy (applyMapping nebo přímo z kódu)
 * @param {{deactivateMissing?: boolean, sourceId?: number|null, now?: Date|string, importId?: number|null,
 *          rowNumbers?: number[], onError?: Function}} [opts]
 *   rowNumbers = čísla řádků zdroje pro hlášení chyb (výchozí index + 1); onError = interní (runImport)
 * @returns {{received: number, created: number, updated: number, unchanged: number, deactivated: number, errors: {row: number|null, message: string}[]}}
 */
function importProducts(db, records, opts = {}) {
  const list = Array.isArray(records) ? records : [];
  const now = nowIso(opts.now);
  const stats = { received: list.length, created: 0, updated: 0, unchanged: 0, deactivated: 0, errors: [] };
  const errs = errorCollector(stats.errors, opts.onError);
  const settings = getSettings(db);
  const vatDefault = Number.isFinite(Number(settings.vat_rate_default)) && settings.vat_rate_default !== null ? Number(settings.vat_rate_default) : 21;
  const purchaseInclVat = settings.purchase_includes_vat === true || settings.purchase_includes_vat === 1;
  const refId = opts.importId ?? null;
  const rowOf = (i) => (opts.rowNumbers && opts.rowNumbers[i] != null ? opts.rowNumbers[i] : i + 1);

  tx(db, () => {
    const byKey = new Map();
    for (const r of db.prepare('SELECT * FROM products').iterate()) byKey.set(r.code_key, { ...r });

    const insert = db.prepare(
      `INSERT INTO products (code, code_key, ean, ean_key, mpn, mpn_key, name, manufacturer, category, supplier, owner, purchase_price, price,
         vat_rate, msrp, stock, sales_30, sales_90, attrs, active, locked, locked_until, min_price, max_price, note, price_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const update = db.prepare(
      `UPDATE products SET code = ?, ean = ?, ean_key = ?, mpn = ?, mpn_key = ?, name = ?, manufacturer = ?, category = ?, supplier = ?, owner = ?,
         purchase_price = ?, price = ?, vat_rate = ?, msrp = ?, stock = ?, sales_30 = ?, sales_90 = ?, attrs = ?, active = ?, locked = ?, locked_until = ?,
         min_price = ?, max_price = ?, note = ?, price_changed_at = ?, updated_at = ?
       WHERE id = ?`
    );
    const history = db.prepare("INSERT INTO price_history (product_id, price, source, ref_id, at) VALUES (?, ?, 'import', ?, ?)");
    const seen = new Set();
    const outcome = new Map(); // id → created | updated | unchanged (kvůli duplicitním řádkům)

    for (let i = 0; i < list.length; i++) {
      const rec = list[i];
      const row = rowOf(i);
      if (!rec || typeof rec !== 'object') {
        errs.add(row, 'Neplatný záznam');
        continue;
      }
      const n = normalizeRecord(rec);
      if (!n.key) {
        errs.add(row, 'Chybí kód produktu');
        continue;
      }
      for (const w of n.warnings) errs.add(row, w, { warning: true });
      const cur = byKey.get(n.key);
      const next = cur
        ? { ...cur }
        : {
            id: null, code: n.code, code_key: n.key, ean: null, ean_key: null, mpn: null, mpn_key: null, name: null, manufacturer: null, category: null,
            supplier: null, owner: null, purchase_price: null, price: null, vat_rate: null, msrp: null, stock: null, sales_30: null, sales_90: null,
            attrs: '{}', active: 1, locked: 0, locked_until: null, min_price: null, max_price: null, note: null, price_changed_at: null, created_at: now, updated_at: now,
          };
      next.code = n.code;
      for (const [k, v] of Object.entries(n.set)) next[k] = v;
      if (n.set.ean !== undefined) next.ean_key = eanKey(next.ean);
      if (n.set.mpn !== undefined) next.mpn_key = mpnKey(next.mpn);
      if (cur && opts.deactivateMissing && n.set.active === undefined) next.active = 1; // znovu v katalogu → aktivní
      const vat = next.vat_rate ?? vatDefault;
      if (purchaseInclVat && n.set.purchase_price != null) next.purchase_price = round(n.set.purchase_price / (1 + vat / 100), 4);
      if (n.priceIsNet) for (const f of GROSS_FIELDS) if (n.set[f] != null) next[f] = round(n.set[f] * (1 + vat / 100), 2);

      // attrs – sloučení
      let attrsChanged = false;
      if (n.attrs) {
        const base = cur ? (cur._attrs ??= parseAttrs(cur.attrs) || {}) : {};
        const merged = { ...base };
        for (const [k, v] of Object.entries(n.attrs)) {
          if (v === null || v === undefined) delete merged[k];
          else merged[k] = v;
        }
        const text = JSON.stringify(merged);
        attrsChanged = text !== JSON.stringify(base);
        next.attrs = text;
        next._attrs = merged;
      }

      if (!cur) {
        const res = insert.run(
          next.code, next.code_key, next.ean, next.ean_key, next.mpn, next.mpn_key, next.name, next.manufacturer, next.category, next.supplier, next.owner,
          next.purchase_price, next.price, next.vat_rate, next.msrp, next.stock, next.sales_30, next.sales_90, next.attrs, next.active, next.locked,
          next.locked_until, next.min_price, next.max_price, next.note, null, now, now
        );
        next.id = Number(res.lastInsertRowid);
        stats.created++;
      } else {
        let changed = attrsChanged;
        if (!changed) for (const c of COMPARE) if (!same(cur[c], next[c])) { changed = true; break; }
        if (changed) {
          if (cur.price != null && next.price != null && !same(cur.price, next.price)) {
            history.run(next.id, next.price, refId, now);
            next.price_changed_at = now;
          }
          next.updated_at = now;
          update.run(
            next.code, next.ean, next.ean_key, next.mpn, next.mpn_key, next.name, next.manufacturer, next.category, next.supplier, next.owner,
            next.purchase_price, next.price, next.vat_rate, next.msrp, next.stock, next.sales_30, next.sales_90, next.attrs, next.active, next.locked,
            next.locked_until, next.min_price, next.max_price, next.note, next.price_changed_at, now, next.id
          );
          // duplicitní řádek téhož kódu v jednom importu se počítá jen jednou (unchanged → updated při změně)
          const prev = outcome.get(next.id);
          if (prev === undefined) {
            stats.updated++;
            outcome.set(next.id, 'updated');
          } else if (prev === 'unchanged') {
            stats.unchanged--;
            stats.updated++;
            outcome.set(next.id, 'updated');
          }
        } else if (!outcome.has(next.id)) {
          stats.unchanged++;
          outcome.set(next.id, 'unchanged');
        }
      }
      if (!cur) outcome.set(next.id, 'created');
      byKey.set(n.key, next);
      seen.add(next.id);
    }

    if (opts.deactivateMissing) {
      if (seen.size === 0) {
        errs.add(null, 'Import neobsahuje žádný platný produkt – deaktivace chybějících produktů byla přeskočena.');
      } else {
        const deactivate = db.prepare('UPDATE products SET active = 0, updated_at = ? WHERE id = ?');
        for (const p of byKey.values()) {
          if (p.active && !seen.has(p.id)) {
            deactivate.run(now, p.id);
            p.active = 0;
            stats.deactivated++;
          }
        }
      }
    }
  });
  errs.finish();
  return stats;
}

module.exports = { importProducts };
