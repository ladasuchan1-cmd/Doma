'use strict';
// Import katalogu (SPEC §5 products.js): upsert podle code_key, historie cen, sloučení attrs, deaktivace chybějících.
//
// Pravidla:
//  - mění se jen pole, která záznam obsahuje (undefined = beze změny; null = smazat hodnotu)
//  - pole spravovaná v aplikaci (locked, locked_until, min_price, max_price, note) se změní jen tehdy, když je záznam
//    výslovně obsahuje – applyMapping je z návrhu mapování nikdy nevytvoří
//  - attrs: nové klíče přepisují, ostatní zůstávají; null = atribut smazat
//  - změna ceny (stará i nová známá) → price_history (source 'import') + price_changed_at. Nový produkt ani první
//    doplnění ceny se za změnu nepovažují (strategie „doprodej“ bere „nikdy neměněno“ jako splatné). Při první
//    zaznamenané změně se do historie nejdřív doplní dosavadní cena (util/price-history.js – Omnibus lowest_30d).
//  - nastavení purchase_includes_vat → nákupní cena se převede na cenu bez DPH (DPH záznamu / produktu / výchozí)
//  - price_is_net (mapping.price_net) → price, msrp, min_price, max_price se převedou na ceny s DPH
//  - záznam může nést vlastní základ DPH (POHODA @payVAT u sellingPrice / purchasingPrice – money-10):
//    price_net_fields = pole, která jsou v tomto záznamu BEZ DPH (→ převod na s DPH), purchase_is_gross = nákupní cena
//    je S DPH (→ převod na bez DPH); má přednost před globálním nastavením
//  - stejný kód vícekrát v jednom importu (POHODA: jedna karta ve více skladech) → varování, platí poslední řádek;
//    do historie cen jde jen VÝSLEDNÁ cena importu (porovnaná s cenou před importem), ne každé mezikolo (data-11)
//  - změna vstupů ceny (cena, nákupní cena, DPH, min./max., zámek, deaktivace) zneplatní otevřené návrhy produktu
//    (superseded) – exportovaly by cenu spočítanou ze staré báze (money-2/3/4). Výjimka: nová cena = cena návrhu.
//  - deactivate_missing, který by vypnul víc než polovinu aktivních produktů, se neprovede bez force_deactivate
//    (ochrana proti chybně rozpoznanému souboru – data-5)

const { tx, nowIso, getSettings, parseJson } = require('../db');
const { codeKey, eanKey, mpnKey } = require('../util/keys');
const { parseNumber, round } = require('../util/num');
const { normalizeCode, normalizeText, parseBool, parseVat, parseDate, errorCollector } = require('./mapping');
const { ensurePriceBaseline } = require('../util/price-history');
const { supersedeOpen } = require('../util/proposals');
const { isLockActive } = require('../engine/metrics');

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
  const netFields = Array.isArray(rec.price_net_fields) ? rec.price_net_fields.filter((f) => GROSS_FIELDS.includes(f)) : [];
  return { code, key, set, attrs, warnings, priceIsNet: rec.price_is_net === true, netFields, purchaseIsGross: rec.purchase_is_gross };
}

/**
 * Importuje katalog.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object[]} records kanonické záznamy (applyMapping nebo přímo z kódu)
 * @param {{deactivateMissing?: boolean, forceDeactivate?: boolean, sourceId?: number|null, now?: Date|string, importId?: number|null,
 *          rowNumbers?: number[], onError?: Function}} [opts]
 *   rowNumbers = čísla řádků zdroje pro hlášení chyb (výchozí index + 1); onError = interní (runImport)
 * @returns {{received: number, created: number, updated: number, unchanged: number, deactivated: number, superseded: number,
 *   errors: {row: number|null, message: string}[]}}
 */
function importProducts(db, records, opts = {}) {
  const list = Array.isArray(records) ? records : [];
  const now = nowIso(opts.now);
  const stats = { received: list.length, created: 0, updated: 0, unchanged: 0, deactivated: 0, superseded: 0, errors: [] };
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
    const orig = new Map(); // id → řádek produktu PŘED importem (historie cen a zneplatnění návrhů se řídí výsledkem)

    // duplicitní kódy v jednom importu – varování (POHODA: stejná karta ve více skladech; varianty se stejným kódem)
    const dupRows = new Map();
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const k = r && typeof r === 'object' ? codeKey(normalizeCode(r.code)) : null;
      if (!k) continue;
      const arr = dupRows.get(k);
      if (arr) arr.push(rowOf(i));
      else dupRows.set(k, [rowOf(i)]);
    }
    // varování se přidá u posledního výskytu (chyby tak zůstanou v pořadí řádků)
    const dupWarn = (key, row) => {
      const rows = dupRows.get(key);
      if (!rows || rows.length < 2 || rows[rows.length - 1] !== row) return;
      const shown = rows.slice(0, 10).join(', ') + (rows.length > 10 ? ', …' : '');
      errs.add(row, `Kód ${key} je v importu ${rows.length}× (řádky ${shown}) – použit poslední řádek.`, { warning: true });
    };

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
      dupWarn(n.key, row);
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
      // základ DPH nákupní ceny: údaj záznamu (POHODA purchasingPrice@payVAT) má přednost před nastavením
      const purchaseGross = n.purchaseIsGross === true || (n.purchaseIsGross !== false && purchaseInclVat);
      if (purchaseGross && n.set.purchase_price != null) next.purchase_price = round(n.set.purchase_price / (1 + vat / 100), 4);
      for (const f of GROSS_FIELDS) {
        if (n.set[f] != null && (n.priceIsNet || n.netFields.includes(f))) next[f] = round(n.set[f] * (1 + vat / 100), 2);
      }
      // stav před importem (produkt založený tímto importem – duplicitní řádek – do porovnání nepatří)
      if (cur && cur.id != null && !orig.has(cur.id) && outcome.get(cur.id) !== 'created') orig.set(cur.id, { ...cur });

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
          // Změna ceny se měří proti ceně PŘED importem (duplicitní řádky téhož kódu nesmí „přepínat“ cenu a pokaždé
          // posunout price_changed_at); záznam do historie se zapíše až po importu – jen výsledná cena.
          const before = orig.get(next.id);
          if (!before) next.price_changed_at = cur.price_changed_at; // založen tímto importem – první cena není změna
          else if (before.price != null && next.price != null && !same(before.price, next.price)) next.price_changed_at = now;
          else next.price_changed_at = before.price_changed_at;
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

    // historie cen: jen výsledná cena importu oproti ceně před importem (jeden záznam na produkt)
    const toSupersede = new Set();
    const keepPrice = new Map();
    for (const [id, before] of orig) {
      const after = byKey.get(before.code_key);
      if (!after) continue;
      // duplicitní řádky, které se vrátily na původní hodnoty → ve výsledku beze změny
      if (outcome.get(id) === 'updated' && COMPARE.every((c) => same(before[c], after[c])) && (before.attrs ?? '{}') === (after.attrs ?? '{}')) {
        stats.updated--;
        stats.unchanged++;
        outcome.set(id, 'unchanged');
      }
      if (before.price != null && after.price != null && !same(before.price, after.price)) {
        // první změna ceny: nejdřív dosavadní cenu (Omnibus lowest_30d ji jinak ztratí) – viz util/price-history.js
        ensurePriceBaseline(db, before);
        history.run(id, after.price, refId, now);
      }
      // změněné vstupy ceny → otevřené návrhy jsou zastaralé
      const inputs = ['purchase_price', 'vat_rate', 'min_price', 'max_price'].some((f) => !same(before[f], after[f]));
      const deact = before.active && !after.active;
      const locked = isLockActive(after, now) && !isLockActive(before, now);
      if (inputs || deact || locked) toSupersede.add(id);
      else if (!same(before.price, after.price)) keepPrice.set(id, after.price);
    }

    if (opts.deactivateMissing) {
      if (seen.size === 0) {
        errs.add(null, 'Import neobsahuje žádný platný produkt – deaktivace chybějících produktů byla přeskočena.');
      } else {
        const missing = [...byKey.values()].filter((p) => p.active && !seen.has(p.id));
        const active = [...byKey.values()].filter((p) => p.active).length;
        if (missing.length > 1 && missing.length * 2 > active && !opts.forceDeactivate) {
          // Víc než polovina katalogu najednou = spíš chybně rozpoznaný soubor (jiné pole záznamů, jediný záznam…)
          errs.add(
            null,
            `Deaktivace chybějících produktů byla přeskočena: import by vypnul ${missing.length} z ${active} aktivních produktů. ` +
              'Pokud je to záměr, zopakujte import s volbou force_deactivate.'
          );
        } else {
          const deactivate = db.prepare('UPDATE products SET active = 0, updated_at = ? WHERE id = ?');
          for (const p of missing) {
            deactivate.run(now, p.id);
            p.active = 0;
            stats.deactivated++;
            toSupersede.add(p.id); // deaktivovaný produkt: návrh se po opětovné aktivaci nesmí „vynořit“ (money-4)
            keepPrice.delete(p.id);
          }
        }
      }
    }
    stats.superseded = supersedeOpen(db, toSupersede) + supersedeOpen(db, keepPrice.keys(), { keepPrice });
  });
  errs.finish();
  return stats;
}

module.exports = { importProducts };
