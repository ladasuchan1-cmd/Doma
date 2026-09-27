'use strict';
// Historie našich cen (tabulka price_history) – společné pravidlo pro všechna místa, která mění products.price
// (import katalogu, export/ack, ruční změna v UI).
//
// Proč: lowest_30d (Omnibus, § 12a zákona o ochraně spotřebitele) se počítá z price_history + aktuální ceny.
// Import katalogu ale první (výchozí) cenu produktu do historie nezapisuje – nejde o změnu. Když se pak cena
// poprvé změní (export zdražení, import, ruční změna), zapíše se jen NOVÁ cena a dosavadní cena, za kterou se
// zboží ještě před chvílí prodávalo, z výpočtu zmizí: po zdražení 1 000 → 1 200 by feed hlásil „nejnižší cena
// za 30 dní = 1 200“, přestože se ještě včera prodávalo za 1 000 (následná „sleva“ by se tak jevila větší).
// Řešení: před prvním záznamem změny se do historie doplní výchozí záznam s dosavadní cenou, platnou od
// price_changed_at (nebo od založení produktu).

// připravené dotazy per databáze (import mění ceny i desítkám tisíc produktů najednou)
const statements = new WeakMap();
function stmts(db) {
  let s = statements.get(db);
  if (!s) {
    s = {
      has: db.prepare('SELECT 1 FROM price_history WHERE product_id = ? LIMIT 1'),
      product: db.prepare('SELECT price, price_changed_at, created_at FROM products WHERE id = ?'),
      insert: db.prepare('INSERT INTO price_history (product_id, price, source, ref_id, at) VALUES (?, ?, ?, NULL, ?)'),
    };
    statements.set(db, s);
  }
  return s;
}

/**
 * Zajistí, že historie produktu obsahuje cenu platnou před první zaznamenanou změnou.
 * Volat PŘED zápisem nové ceny (products.price ještě obsahuje dosavadní cenu – nebo ji předejte v `price`).
 * Nic nedělá, když produkt už nějaký záznam v historii má nebo dosavadní cenu nemá.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: number, price?: number|null, price_changed_at?: string|null, created_at?: string|null}} product
 *   dosavadní stav produktu (chybí-li price / created_at, načtou se z databáze)
 * @param {string} [source='import'] zdroj výchozí ceny ('import' = cena z katalogu, 'manual' …)
 * @returns {boolean} true = výchozí záznam byl vložen
 */
function ensurePriceBaseline(db, product, source = 'import') {
  if (!product || product.id == null) return false;
  const st = stmts(db);
  if (st.has.get(product.id)) return false;
  let { price, price_changed_at: changedAt, created_at: createdAt } = product;
  if (price === undefined || createdAt === undefined) {
    const row = st.product.get(product.id);
    if (!row) return false;
    if (price === undefined) price = row.price;
    if (changedAt === undefined) changedAt = row.price_changed_at;
    if (createdAt === undefined) createdAt = row.created_at;
  }
  if (price == null || !(Number(price) > 0)) return false;
  const since = changedAt || createdAt;
  if (!since) return false;
  st.insert.run(product.id, Number(price), source, since);
  return true;
}

module.exports = { ensurePriceBaseline };
