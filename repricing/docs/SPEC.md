# Cenotvorba – technical specification (developer contract)

Self-hosted repricing / dynamic-pricing tool (Disivo-like) for a Czech bicycle retailer whose ERP is
Stormware POHODA with a custom "admin" frontend in front of it.

Flow: **import** our catalog (products) and competitor prices (offers) via API / file / URL (JSON, XML, CSV, XLSX)
→ **segment** products by our own metrics → **strategies** (price behaviour vs. market) compute **proposals**
→ **approve** (manually or automatically) → **export** to admin (XML/JSON/CSV feed, push webhook, POHODA XML, XLSX).

This document is the contract between modules. Follow names and shapes exactly. If something is ambiguous,
choose the most conservative behaviour (never lower a price below guardrails, never silently drop data) and
document it in a code comment.

---------------------------------------------------------------------------------------------------------

## 0. Ground rules

- Runtime: **Node.js ≥ 22.13**, **zero runtime dependencies** (no npm packages; only `node:*` built-ins).
  DB = built-in `node:sqlite` (`DatabaseSync`, synchronous). HTTP = `node:http`. Fetch = global `fetch`.
- CommonJS (`'use strict'; module.exports = …`). No TypeScript, no build step. JSDoc for public functions.
- Code comments and all user-facing strings (UI, error messages returned by API, explanation texts) in **Czech**.
  Identifiers, JSON keys and DB columns in English snake_case (JSON/DB) / camelCase (JS functions).
- Tests: `node:test` + `node:assert`, files `repricing/test/<module>.test.js`, run with
  `cd repricing && npm test` (= `node --disable-warning=ExperimentalWarning --test "test/**/*.test.js"`). Tests must not use
  the network (use a local `http.createServer` for fetch/webhook tests) and must use `openDb(':memory:')` or a temp dir.
- node:sqlite cannot bind `boolean` or `undefined` → use `bind()` / `bindAll()` from `src/db.js` or pass 1/0/null.
  Rows come back as null-prototype objects; spread them (`{...row}`) before JSON-serialising if needed.
- All timestamps: ISO-8601 UTC strings (`nowIso()`). Functions that depend on time accept `now` (Date|string) for tests.
- Money: selling prices (`price`, `msrp`, `min_price`, `max_price`, competitor `price`, `shipping`) are **gross (incl. VAT), CZK**.
  `purchase_price` is **net (excl. VAT)**. Margin % = (net selling − purchase) / net selling × 100 (`marginPct`).
- Never write outside the files you own (see §1). Shared modules in §2 are read-only for everyone except the lead.

## 1. Layout and ownership

```
repricing/
  package.json                 (lead)
  server.js                    (server agent)  entry point: config → openDb → createApp → listen → scheduler
  src/db.js                    (lead, done)    schema + helpers
  src/util/keys.js             (lead, done)    codeKey/eanKey/mpnKey/nameKey/fold
  src/util/num.js              (lead, done)    parseNumber/round/net/gross/marginPct/markupPct/median/mean
  src/config.js                (server agent)
  src/formats/                 (formats agent) decode.js xml.js csv.js zip.js xlsx.js
  src/import/                  (import agent)  records.js mapping.js products.js offers.js sources.js index.js
  src/engine/                  (engine agent)  rounding.js market.js metrics.js filter.js pricing.js run.js presets.js
  src/export/                  (export agent)  rows.js feeds.js pohoda.js webhook.js xlsx-report.js apply.js
  src/server/                  (server agent)  http.js auth.js scheduler.js static.js
  src/server/api/              (api agent)     *.js route modules + index.js
  public/                      (ui agent)      index.html app.js styles.css views/*.js lib/*.js
  test/                        each agent: test/<area>-*.test.js
  tools/demo-data.js           (lead)          realistic demo catalog + competitor offers
  examples/                    (lead)          sample input files
  docs/                        (lead)
```

## 2. Shared modules (already implemented – read them)

### src/db.js
`openDb(file=':memory:')`, `tx(db, fn)` (sync fn; nested → savepoints), `nowIso(d?)`, `parseJson(text, fallback)`,
`json(v)`, `bind(v)`, `bindAll(obj)`, `getSettings(db)` (merged with `DEFAULT_SETTINGS`), `getSetting(db,key,fb)`,
`setSetting(db,key,value)`, `deepMerge(a,b)`, `audit(db,{actor,action,entity,entity_id,detail})`, `DEFAULT_SETTINGS`.
Settings keys starting with `_` are internal (password hash, secret) and are never returned by `getSettings`.
Read the schema in `src/db.js` – it is authoritative for column names.

### src/util/keys.js
`codeKey(s)` upper/trim/no spaces · `eanKey(s)` digits w/o leading zeros (null if invalid) · `mpnKey(s)` upper, no
separators · `nameKey(s)` folded competitor name (no scheme/www) · `fold(s)` lower-case without diacritics.

### src/util/num.js
`parseNumber(v, {decimal?, dotThousands?, commaThousands?})` (CZ/EN formats, `Kč`/`CZK`, `,-`, `%`; a foreign currency
– EUR, €, $, USD – returns null; a group starting with 0 is never thousands), `round(n, d=2)`, `net(gross, vat)`,
`gross(net, vat)`, `marginPct(priceGross, purchaseNet, vat)`, `markupPct(...)`, `median(arr)`, `mean(arr)`.

## 3. Domain

### 3.1 Product (catalog) – table `products`
Canonical import fields (all optional except `code`):

| field | meaning |
|---|---|
| `code` | our SKU / POHODA "Kód" – **unique**, used for export (matching key `code_key`) |
| `ean`, `mpn` | EAN/GTIN, manufacturer part number (`ean_key`, `mpn_key`) |
| `name`, `manufacturer`, `category`, `supplier`, `owner` | texts (`owner` = zodpovědná osoba) |
| `purchase_price` | net purchase price (see setting `purchase_includes_vat`) |
| `price` | current selling price incl. VAT |
| `vat_rate` | % (default setting `vat_rate_default` = 21 when null) |
| `msrp` | recommended retail price incl. VAT (MOC) |
| `stock` | quantity on stock |
| `sales_30`, `sales_90` | units sold in last 30/90 days |
| `group_code` | price group (C3): sizes / colours of one bike model share it (e.g. `FOC-JAM-2026`); compared like a code (`codeKey`). Label „Skupina / model“ |
| `attrs` | JSON object – **every other imported column** (e.g. `N` = stock-age class N0–N8, `sezona`, `imprese_30`) |
| `active` | 1/0 |

UI-managed (never overwritten by catalog import unless explicitly mapped): `locked`, `locked_until` (ISO; lock expires
after it – manual override with expiry), `min_price`, `max_price`, `note`. Effective lock = `locked = 1 AND (locked_until IS NULL OR locked_until > now)`.

### 3.2 Competitor – table `competitors`
Created automatically on first offer import (`name` as seen, `name_key = nameKey(name)`). `enabled=0` → offers ignored
everywhere. `tags` JSON array of strings (e.g. `["marketplace"]`, `["klíčový"]`) usable in strategy competitor filters.

### 3.3 Offer – table `offers` (current snapshot per product × competitor) + `offer_history`
Canonical import fields: match keys `code` (our code if the provider already matched), `ean`, `mpn`, `ext_id`
(provider's item id), plus `competitor` (required unless source default), `price` (required, gross),
`shipping`, `availability` / `in_stock` / `delivery_days` / `stock_qty`, `url`, `name`, `observed_at`.

### 3.4 Segment – table `segments`
`filter` JSON (see §6.4). A product may match multiple segments.

### 3.5 Strategy – table `strategies`
`segment_id` (NULL = all products), `priority` (lower first; ties by id), `enabled`, `config` JSON (§6.5).
For each product strategies are tried in priority order. A strategy is *applicable* when it is enabled, its segment
matches (or is NULL), its optional `config.conditions` filter matches the product view and its optional `config.schedule`
window is active. The first applicable strategy decides – **unless** its price base is unavailable (no usable market,
named competitor missing, no MSRP / no cost for msrp / cost_plus modes) and its `fallback.mode` is `next`: then the product
**falls through** to the next applicable strategy (Disivo behaviour). No strategy decides → product not repriced
(`no_strategy`).

### 3.6 Run & Proposal – tables `runs`, `proposals`
A run evaluates all active products. Only decisions with a price change are stored as proposals
(`pending`, or `approved` when auto-approved). Statuses: `pending | approved | rejected | exported | superseded`.
The price to export = `manual_price ?? new_price`.

Open proposals (`pending` / `approved`, not exported) of evaluated products on a new run (human decisions are kept –
ops-1, money-8, ops-5):
- **same decision** (same `new_price` and `old_price`) and a compatible state (a human decision – manual approval or
  `manual_price` – always; an automatic one only when the auto-approval outcome is the same) → the proposal is **kept**:
  moved to the new run (`run_id`, explain, market metrics, flags updated), status / `manual_price` / `decided_*` unchanged
  (stats `kept`). No duplicate row is inserted.
- an open proposal with `manual_price` and a different new decision → the new proposal carries the `manual_price`, is
  always `pending` and gets flag `manual_carried`; when the run proposes no change, the manual-price proposal stays open.
- a price a human **rejected** in the last 7 days (±0.5 %) is never auto-approved again: inserted as `pending` with flag
  `previously_rejected` (stats `held_by_human` counts both cases).
- **rejected-price memory (C1)** – setting `reject_memory_days` (default 14, 0 = off, integer 0–365): when the product's
  latest `rejected` proposal was decided within that many days and its `manual_price ?? new_price` equals the new decision
  price (|diff| < 0.5 Kč), **no proposal is inserted** – the decision becomes `no_change` with reason `rejected_before`
  (stats `no_change_reasons.rejected_before`, explain step `rejected`). Applied after group alignment, also in dry runs and
  in `explainProduct`. The 7-day `previously_rejected` rule still applies to prices that differ by ≥ 0.5 Kč.
- a proposal a human **un-approved** (C5 – `pending` with `decided_by` of a human) counts as a human decision: the same
  decision keeps it `pending` (it is never re-approved automatically).
- everything else → `superseded` (as before). A full run (no `productIds`) also supersedes open proposals of
  **inactive** products (money-4).

Outside runs, open proposals are superseded when their inputs change (money-1/2/3/4): a new active lock, a change of
`price` (unless the new price equals the proposal's export price – the admin already applied it), `purchase_price`,
`vat_rate`, `min_price`, `max_price`, or deactivation – in `PATCH /products/:id` and in the catalog import.

### 3.7 Export
Exporting approved proposals (feed pull + ack, webhook push, POHODA XML download with mark) → status `exported`,
`exported_at`, `export_id`; if setting `export.update_current_price` → `products.price` := exported price,
`price_changed_at`, and a `price_history` row (`source='export'`).

The price written is the **delivered** one (money-5/6, ops-4): marking takes the delivered prices of the rows; a proposal
whose `manual_price ?? new_price` changed since delivery is not marked (`skipped: changed_since_delivery`) and is sent
again. Every non-marking delivery (feed, export, price list, POHODA XML) remembers `served_price` / `served_at` on the
proposal; an ack by code marks the last **served** proposal (even if a later run superseded it – then `products.price` is
updated only when nothing else changed it meanwhile) and never a newer proposal the admin has not seen.

Before export every approved proposal is re-checked against the current product (`rows.holdReason`, money-1/2/3) and
**held back** (not exported, not marked, reported as `held`) when: the product lock is active; the product price changed
since the proposal was computed (and is not the proposal's own price); the price is below `min_price` / above `max_price`;
the net price is below `purchase_price`. The last three are allowed when a human approved a proposal carrying the
matching flag (`below_min`, `above_max`, `below_cost` / `manual_below_cost`). In the full price list (`scope=all`) a held
proposal is replaced by the current price.

---------------------------------------------------------------------------------------------------------

## 4. Formats (`src/formats/*`) – zero-dependency parsers/writers

### decode.js
- `decodeBuffer(buf, {encoding?, contentType?}) → string` – honours explicit encoding, BOM (UTF-8/UTF-16LE/BE),
  `charset=` in contentType, XML declaration `encoding="windows-1250"` (sniff first 200 bytes as latin1).
  Supported: utf-8, utf-16le/be, windows-1250 (own table), iso-8859-2 (own table), windows-1252/latin1.
  Default utf-8; if utf-8 decoding produces U+FFFD and the bytes look like cp1250 (common for Czech CSV from
  POHODA/Excel), fall back to windows-1250. Must correctly decode Czech letters `ěščřžýáíéůúťďňó ĚŠČŘŽÝÁÍÉŮÚŤĎŇÓ`.
- `encodeWindows1250(str) → Buffer` (unmappable chars → `?`).
- `detectFormat(buf|string, {contentType?, filename?}) → 'json'|'xml'|'csv'|'xlsx'` (PK zip magic → xlsx;
  first non-space char `{`/`[` → json; `<` → xml; else csv).

### xml.js
- `parseXml(str, {keepNs?=false}) → Node` where `Node = {name, attrs: {[k]:string}, children: Node[], text: string}`
  (root element node). Handles declaration, comments, PI, CDATA, DOCTYPE (skipped), entities (`&amp;` `&lt;` `&gt;`
  `&quot;` `&apos;` `&#123;` `&#x1F;`), self-closing tags, namespaces (by default the prefix is **stripped** from
  element and attribute names: `g:price` → `price`, `stk:code` → `code`; `keepNs:true` keeps full names).
  Throws `XmlError` (with line/column) on malformed input (mismatched tags, unterminated).
- `xmlToObject(node) → object` – plain JSON view: attributes as `@name`, repeated child names → arrays, element with
  only text → string, element with attrs + text → `{'@a':…, '#text': …}`, empty element → `''`.
- `streamRecords(str, {itemPath?, keepNs?}, onRecord)` – tokenises without building the whole tree; for every
  element whose path (names from root joined by `.`, e.g. `SHOP.SHOPITEM`) equals `itemPath` calls
  `onRecord(object)` with the `xmlToObject` view of that element. Returns the count. Must handle 200 MB strings
  without building a full tree.
- `detectItemPath(str) → string|null` – from the first ~2 MB: the path of the element name that repeats most under
  the same parent (ties → deeper path), e.g. `SHOP.SHOPITEM`, `products.product`, `dataPack.dataPackItem`,
  `responsePack.responsePackItem.listStock.stock`.
- `escapeXml(s)`, `el(name, attrs, children|text)` helpers and `XmlWriter` (`open(name, attrs)`, `leaf(name, text, attrs)`,
  `close()`, `toString()`, pretty-printed with 2 spaces, declaration `<?xml version="1.0" encoding="UTF-8"?>`).
  Invalid XML 1.0 characters must be stripped when writing.

### csv.js
- `parseCsv(str, {delimiter?, headerRow?=1, skipEmpty?=true}) → {headers: string[], rows: object[]}` – RFC 4180
  quotes (`""` escape, newlines inside quotes), `\r\n`/`\n`/`\r`. Auto-detects delimiter among `; , \t |` by
  consistency over the first 20 lines. Duplicate/empty headers → `name_2`, `col_3`. Trims header whitespace and BOM.
  `headerRow` = 1-based line with headers (lines before are skipped).
- `toCsv(rows, columns: [{key, label}], {delimiter=';', bom=true, decimal=','})` – CZ Excel-friendly (numbers with
  decimal comma, quote when needed, CRLF).

### zip.js
- `readZip(buf) → Map<name, () => Buffer>` using the central directory; methods 0 (store) and 8 (deflate, via
  `zlib.inflateRawSync`); supports data descriptors; rejects zip64/encrypted with a clear error.
- `writeZip(entries: [{name, data: Buffer|string}]) → Buffer` (deflate via `zlib.deflateRawSync`, CRC via `zlib.crc32`).

### xlsx.js
- `readXlsx(buf, {sheet?: name|index}) → {sheets: string[], headers, rows}` – first sheet by default; uses
  `xl/workbook.xml` + rels to resolve sheet file; shared strings (incl. rich text runs), inline strings, booleans,
  numbers, formulas' cached values; cell refs (skipped columns → empty); first non-empty row = headers
  (same header rules as CSV). Dates stay numbers (Excel serial) unless the style is a date format → ISO string (best effort).
- `writeXlsx(sheets: [{name, columns: [{key, label, width?, type?: 'string'|'number'|'money'|'percent'|'date'}], rows}]) → Buffer`
  – valid workbook openable in Excel/LibreOffice: header row bold + frozen, autofilter, number formats
  (`#,##0` money, `0.0 %`-style percent where the value is already a percentage number → use format `0.0" %"`),
  column widths. Sheet names max 31 chars, invalid chars `[]:*?/\` replaced.

## 5. Import (`src/import/*`)

### records.js
`extractRecords(input, mapping) → {format, itemPath, records: object[], headers: string[]}`
- `input`: `{buffer?: Buffer, text?: string, contentType?, filename?}`; uses `decodeBuffer`/`detectFormat`.
- `mapping.format` (`auto` default), `mapping.item_path`, `mapping.offers_path`, `mapping.csv {delimiter, decimal,
  encoding, header_row}`, `mapping.xlsx {sheet}`, `mapping.encoding`.
- JSON: records = the array at `item_path` (dot path), or root if it is an array, or the best array of objects found
  breadth-first: a well-known name (`items`, `products`, `offers`, `data`, `records`, `results`…) wins, then the largest;
  service arrays (`errors`, `warnings`, `messages`, `meta`, `categories`…) are skipped (data-5); a single object → one
  record. JSON text over 128 MB is rejected (`JSON_TOO_LARGE`, security-2).
- XML: `streamRecords` with `item_path` or `detectItemPath` (a document with a single item whose child repeats – one
  SHOPITEM with 2 PARAM, one POHODA card with price levels – returns the item, data-2).
- gzip / ZIP entries are inflated to at most 256 MB (`MAX_ENTRY_BYTES`); a ZIP with more than one data file is rejected
  (`ZIP_MULTIPLE`, data-15).
- For `kind=offers` only context keys of the envelope are inherited by every record (JSON root primitives, XML root
  attributes): competitor/shop/seller…, dates, currency – never match keys like `code`, `id`, `ean` (data-4).
- CSV/XLSX: rows as objects keyed by header.
- **Flattening**: every record becomes a flat object with dot-path keys (`offers.offer.@shop`, `PRICE_VAT`,
  `PARAM.Barva` for Heureka-style `PARAM{PARAM_NAME,VAL}` pairs). Arrays of primitives are joined with `|`.
- **Nested offers**: if `offers_path` is set (or auto: exactly one path, over ALL records, of arrays of objects whose
  objects contain a price-like field – for offers also a single object named like an offer, `<OFFERS><OFFER>`, data-9),
  each element becomes its own row inheriting the parent's fields; child keys are exposed both as `<offers_path>.<key>`
  and as bare `<key>` (child wins on conflict). Catalog variants need a code-like key (not a bare `id`), and POHODA price
  levels (`stockPriceItem/stockPrice`) are never exploded (data-1). A variant's own code (sku/code) overrides the
  parent's code key (the parent code stays under `parent.<key>`, data-11).
- `headers` = union of flat keys of all records (at most 5000 distinct keys) in first-seen order (data-13).
- result also carries `delimiter` (CSV) and `context` (keys inherited from the envelope).

### mapping.js
- `CANONICAL = {products: [...fields], offers: [...fields]}` with Czech labels.
- `suggestMapping(headers, kind) → {fields: {canonical: header}}` – alias matching on `fold()`-ed, non-alphanumeric-
  stripped names; aliases include (non-exhaustive): code: code, kod, sku, katalog, katalogove_cislo, product_code,
  item_id, itemid, id_produktu, g:id→id only if no better; ean: ean, gtin, gtin13, barcode, carovy_kod; mpn: mpn,
  productno, part_number, kod_vyrobce, partnumber; name: name, nazev, productname, product, title; price: price,
  price_vat, cena, cena_s_dph, prodejni_cena, sellingprice, current_price; purchase_price: purchase_price,
  nakupni_cena, nakup, cost, purchasingprice; competitor: competitor, konkurent, shop, eshop, seller, obchod,
  retailer, domain, vendor_name; shipping: shipping, delivery_price, doprava, postovne; availability: availability,
  dostupnost, skladem, in_stock, delivery_date, delivery_days, stock_status; stock (products): stock, qty, quantity,
  count, mnozstvi, stav, stav_skladu, skladem_ks; manufacturer: manufacturer, brand, vyrobce, znacka, producer;
  category: category, kategorie, categorytext, group, skupina; msrp: msrp, rrp, moc, doporucena_cena,
  recommended_price, standard_price; vat_rate: vat, dph, sazba_dph, vat_rate, ratevat; owner: owner,
  zodpovedna_osoba, responsible, category_manager, manager; supplier: supplier, dodavatel; url: url, link, odkaz;
  group_code (C3, label „Skupina / model“): group_code, model, model_code, nadrazeny_kod, parent_code, group_id,
  item_group_id (Google `g:item_group_id`; the parent code of exploded variants `parent.code` maps here too);
  observed_at: observed_at, date, datum, timestamp, scraped_at, updated_at; sales_30/sales_90: prodej_30, sales_30d…
- `applyMapping(flatRecord, mapping, kind, ctx) → {value: object|null, errors: string[]}` – builds a canonical record:
  `mapping.fields[canonical] = sourceKey` (explicit wins; otherwise suggestions), `mapping.defaults[canonical] = constant`,
  coercion: numbers via `parseNumber(v, {decimal: mapping.csv?.decimal, dotThousands, commaThousands})` – XML/JSON:
  a dot is always decimal (`1299.000` = 1299); CSV with `;`: a comma is always decimal (`123,456` = 123.456); attrs use
  the same rules (money-11, data-10). `price` gets `[sale_price, price]` when a sale-price column exists (Google
  `g:sale_price`, data-7); repeated shipping values pick the CZ one (else the lowest); shipping `zdarma` = 0 (data-16);
  `vat_rate` "21 %" → 21;
  `availability` → `{in_stock, delivery_days}` (see `normalizeAvailability`); `observed_at` → ISO (accepts ISO, `d.m.yyyy[ H:mm]`,
  unix seconds/ms); texts trimmed, empty → null. For `products`, all **unmapped** keys go to `attrs` (numbers parsed
  when the whole value is numeric) unless `mapping.attrs === 'none'`; `mapping.attrs` may also be an array of keys to keep.
  `mapping.price_net = true` → offer/our prices are net and must be converted to gross with vat (product's or default).
  Per record, a sibling `<source key>.@payVAT` (POHODA `stk:sellingPrice payVAT="false"`, `stk:purchasingPrice
  payVAT="true"`) sets `price_net_fields` / `purchase_is_gross`, which win over the global setting (money-10).
  Offers `code` aliases are only unambiguous names (code, kod, nas_kod…); generic item ids (ITEM_ID, SKU…) map to
  `ext_id` – except in feeds with nested offers (price-monitoring export of OUR items), where they are our code (data-3).
  `compileMapping` reports explicitly mapped columns missing from the input: a warning each; for CSV/XLSX a missing
  required/match column fails the import (`MAPPING_COLUMN_MISSING`, data-12).
- `normalizeAvailability(v) → {in_stock: 1|0|null, delivery_days: number|null}`:
  true/"1"/"ano"/"yes"/"skladem"/"in stock"/"instock"/"in_stock"/"available"/"na skladě" → in_stock 1, days 0;
  false/"0"(as a word only when the field is boolean-like)/"ne"/"no"/"není skladem"/"vyprodáno"/"out of stock"/
  "outofstock"/"na dotaz"/"nedostupné"/"preorder"/"předobjednávka" → 0; a number (or "do 3 dnů"/"3 dny") = delivery days
  → in_stock = (days ≤ 0 ? 1 : 0), delivery_days = days. Heureka `DELIVERY_DATE` 0 = skladem.
  Field `stock_qty` > 0 → in_stock 1. „Skladem 0 ks“, „u dodavatele“, „předprodej“ → 0 (data-16). Values are cut to
  200 characters and the day patterns are linear (no ReDoS on long digit runs – security-3).

### products.js
`importProducts(db, records (canonical), {deactivateMissing?=false, sourceId?, now?}) → stats`
- upsert by `code_key`; update only fields present (non-undefined) in the record; merge `attrs` (new keys overwrite,
  others kept); `purchase_includes_vat` setting → divide purchase_price by (1+vat/100).
- attribute keys are matched to **existing** attributes of the catalog by a folded key (no diacritics, lower case,
  runs of non-alphanumerics → `_`): a column „Imprese 30“ updates an existing `imprese_30`, „Sezóna“ an existing `sezona`
  (the most used spelling wins). New attributes keep the source spelling. Renames are reported in
  `stats.attrs_merged = {source name: existing key}` (only when non-empty).
- if `price` changed vs stored → `price_history` row (`source='import'`) and `price_changed_at` – measured on the FINAL
  value of the import (duplicate code rows → one warning per code, last row wins, at most one history row – data-11).
- `deactivateMissing` → products not in this import get `active=0` (and reactivated when present again). If that would
  deactivate more than half of the active products, it is skipped with a general error unless `forceDeactivate`
  (`force_deactivate`) is set (data-5).
- changed price inputs supersede open proposals (see §3.6); stats `superseded`.
- `createMissing: false` (**update-only import**, C6 – e.g. Disivo metrics: code + impressions): unknown codes are not
  created and the row is not processed; stats get `skipped_unknown` (distinct unknown codes) and `unknown_codes` (first 50).
  Both keys exist only in this mode. Default `true`.
- stats `{received, created, updated, unchanged, deactivated, superseded, errors: [{row, message}]}` (max 100 error entries).

### offers.js
`importOffers(db, records (canonical), {replace?: false|'competitors'|'all', sourceId?, now?, maxAgeDays?}) → stats`
- competitor: find/create by `nameKey`.
- matching order: competitor-specific `product_aliases` (a human decision wins, data-3/6); `code` → products.code_key
  unless a unique EAN (or, without EAN, MPN) points to a different product → unmatched reason `conflict` (data-3);
  `ean` → products.ean_key (several EANs `A|B` each tried, data-14); `mpn` → products.mpn_key (placeholder MPNs
  „N/A“, „0“, „x“ are no key; an MPN candidate whose catalog EAN differs from the offer's EAN is skipped – reason
  `ean_mismatch`; several MPN hits are always ambiguous, data-6); then generic aliases (competitor_id=0).
  Multiple products with the same ean → the single active one, else ambiguous → unmatched (reason `ambiguous`).
- unmatched → upsert `unmatched_offers` (`match_key` = first of `ean:<k>`, `mpn:<k>`, `code:<k>`, `ext:<id>`,
  `name:<fold(name)>`), increment `seen_count`.
- matched → upsert `offers`; if price or in_stock changed (or new) → `offer_history` row; keep `prev_price`/`changed_at`.
  `maxAgeDays` is applied per row BEFORE de-duplication. Several rows for the same product×competitor in one import →
  the NEWER observation wins when they are more than 1 h apart, otherwise the lowest price (log `duplicates`, data-8).
  `observed_at` older than the stored one → ignored (stats `stale`).
- `replace='competitors'` → for competitors present in this import, delete their offers not present in it;
  `'all'` → delete all offers not present. Competitors with failed rows (also rows that failed mapping, passed as
  `failedCompetitors`) are skipped; a failed row without a known competitor skips the replace entirely (data-9).
- validation: price must be > 0 and finite, else error row.
- stats `{received, matched, unmatched, ambiguous, created, updated, unchanged, stale, duplicates, removed, competitors_created, errors}`.
- `matchUnmatched(db, unmatchedId, productId, {kind?})` → creates alias from the stored identifiers
  (`ean` > `mpn` > `ext` > `code` > `name`), re-imports the stored raw offer, deletes the unmatched row.

### sources.js
- `runImport(db, {kind, input, mapping, options, sourceId?, origin, dryRun?, now?, createMissing?}) → {import_id, stats, preview?}` –
  products options `deactivate_missing`, `force_deactivate`, `create_missing` (default true; `false`/`0`/`"ne"` = update-only,
  also as `sources.options.create_missing` and top-level `createMissing`, which wins) –
  logs to `imports` (`running` → `ok`/`error`), calls `extractRecords` → `applyMapping` → `importProducts`/`importOffers`
  inside one `tx`. `dryRun` → no writes except nothing (no import row), returns `preview` (first 20 canonical records) + stats of mapping errors.
- `previewImport({input, mapping, kind}) → {format, itemPath, headers, suggested: mapping.fields, sample: flat[0..9], canonical: [0..9], errors}`
- `fetchSource(source) → {buffer, contentType}` – `fetch` with method, headers (JSON), 60 s timeout (AbortSignal),
  max 500 MB, follows at most 5 redirects manually; a redirect to another origin drops the source's own headers and
  Authorization (security-4); non-2xx → error with status.
- `runSource(db, sourceId, {origin='schedule'|'manual'}) → result` – writes `last_run_at` + `last_status='running'`
  BEFORE the fetch (a crash counts as an attempt, ops-2), fetch + runImport + update `sources.last_*`. The same source
  never runs twice concurrently (`{ok:false, busy:true}`, API 409, ops-6).
- `dueSources(db, now) → source[]` (enabled, url set, interval > 0, last_run_at older than interval; a `last_run_at`
  more than 1 h in the future – clock skew – counts as never run, ops-10).

### index.js – re-exports the above.

## 6. Engine (`src/engine/*`) – pure pricing logic + run orchestration

### 6.1 Offer objects passed to the engine
`{competitor_id, competitor (name), label, tags: string[], enabled: bool, price, shipping, in_stock (1|0|null), delivery_days, url, observed_at}`

### 6.2 market.js
`buildMarket(offers, filter, {now, maxAgeDays}) → Market`
- filter (strategy `competitors` config, normalized with defaults): `include` names[], `exclude` names[],
  `include_tags`[], `exclude_tags`[], `in_stock_only` (default true), `include_shipping` (default false),
  `max_age_days` (default = ctx.maxAgeDays = setting `offer_max_age_days`), `outlier_pct` (default null = off),
  `min_competitors` (default 1). Name matching via `nameKey`.
- excluded reasons: `disabled`, `excluded`, `not_included`, `tag`, `out_of_stock` (in_stock === 0; null = unknown counts as
  in stock), `stale`, `outlier` (price < median × (1 − outlier_pct/100), only when ≥ 3 offers remain).
- `max_delivery_days` (C7, default null = off, number ≥ 0): with `in_stock_only`, an offer with `in_stock === 0` still counts
  when `delivery_days != null && delivery_days <= max_delivery_days` („u dodavatele do 3 dnů“). `computePrice` adds an explain
  step „Dostupnost: kromě nabídek skladem se počítají i nabídky s dodáním do N dnů (…)“.
- `effective = price + (include_shipping ? shipping||0 : 0)`.
- Market = `{offers: [...used, sorted by effective asc then name], excluded: [{offer, reason}], count, min, max, avg, median,
  cheapest: offer|null, prices: number[]}` (stats on effective prices, rounded 2 dp).
- `rankOf(price, market) → int|null` = 1 + number of used offers with effective < price (null when count 0).
- `positionOf(price, market) → 'no_data'|'cheapest'|'middle'|'most_expensive'` (`cheapest` if price ≤ min;
  `most_expensive` if price > max; count 0 → `no_data`). One competitor & price in between impossible.

### 6.3 metrics.js
`productView(product, offers, {now, settings}) → View` – flat object: all product columns (attrs parsed as object `attrs`),
plus: `vat` (effective vat rate), `margin_pct`, `markup_pct`, `profit_abs` (net, per unit), `stock_value` (purchase × stock),
`days_of_cover` (stock / (sales_30/30), null when no sales), `market_count`, `market_min`, `market_max`, `market_avg`,
`market_median`, `cheapest_competitor`, `rank`, `position`, `price_index` (price/market_min×100, 1 dp),
`price_index_median`, `gap_min_abs` (price − min), `gap_min_pct`, `msrp_diff_pct` ((price − msrp)/msrp×100),
`offers_instock`, `price_index_avg` (price/avg×100), `min_below_cost` (bool: market_min net of VAT < purchase_price – supplier
negotiation ammunition), `lock_active` (bool, effective lock), `days_since_change` (now − price_changed_at in days, null if never).
Uses default market filter: enabled competitors, fresh (`offer_max_age_days`), `in_stock_only =
settings.metrics_in_stock_only`, no shipping.
`FIELDS` – array describing filterable fields `{key, label (Czech), type: 'string'|'number'|'boolean'|'enum', group}`
(product fields incl. `group_code` „Skupina / model“ in group „Produkt“, metrics, plus dynamic `attrs.*` added by API from
data). `position` is enum
(`cheapest|middle|most_expensive|no_data`).

### 6.4 filter.js – segment filters
Filter JSON grammar:
```
Filter   := {} (matches all) | Group | Cond
Group    := {"all": [Filter...]} | {"any": [Filter...]} | {"not": Filter}
Cond     := {"field": "manufacturer" | "attrs.N" | "margin_pct" | ..., "op": Op, "value": any}
Op       := "=" "!=" ">" ">=" "<" "<=" "in" "not_in" "contains" "not_contains" "starts_with"
            "empty" "not_empty" "between" (value [a,b] inclusive) "is_true" "is_false"
```
- `compileFilter(filter) → (view) => boolean` – throws `FilterError` (message in Czech) on invalid structure/op.
- `validateFilter(filter) → {ok, errors: string[]}`.
- Semantics: field lookup supports dot paths (`attrs.N`). Strings compare case- and diacritics-insensitively (`fold`).
  Numeric ops coerce both sides with `parseNumber`; if either side is not numeric → false. `in`/`not_in` value is an
  array (a comma-separated string is split). Missing/null field → every op false except `empty`, `not_in`, `!=`, `not_contains`, `is_false`.
  `{}` or `{"all": []}` matches everything; `{"any": []}` matches nothing.

### 6.5 Strategy config (`strategies.config`) – defaults in `normalizeConfig(config)`
```jsonc
{
  "conditions": {},          // optional Filter (§6.4) evaluated on the product view – AND-ed with the segment (e.g. "position = cheapest AND gap_min_pct <= -5" = margin recovery)
  "schedule": { "valid_from": null, "valid_to": null, "weekdays": [], "hours": null },
                             // promo/time window: ISO datetimes (inclusive from, exclusive to); weekdays 1=Mon..7=Sun (empty = all);
                             // hours [fromHour, toHour) in Europe/Prague local time, e.g. [18, 24]; null = all day
  "target": {
    "mode": "undercut_min",  // undercut_min | match_min | rank | market_avg | market_median | competitor | msrp | cost_plus | keep | fixed | clearance
    "offset_abs": 0,         // CZK added to the reference (negative = cheaper), e.g. -10
    "offset_pct": 0,         // % of reference added, e.g. -1
    "rank": 1,               // mode rank: desired position (1 = cheapest)
    "competitor": null,      // mode competitor: competitor name
    "markup_pct": null,      // mode cost_plus: net price = purchase × (1 + markup/100)
    "fixed_price": null,     // mode fixed
    "step_pct": 5,           // mode clearance: lower the current price by step_pct % …
    "every_days": 14,        // … when the last price change is at least every_days old …
    "max_sales_30": 0        // … and sales_30 <= max_sales_30 (the product still doesn't sell); otherwise keep
  },
  "competitors": { "include": [], "exclude": [], "include_tags": [], "exclude_tags": [],
                   "in_stock_only": true, "include_shipping": false, "max_age_days": null,
                   "outlier_pct": null, "min_competitors": 1,
                   "exclude_keywords": [],      // offers whose name contains any keyword (fold()) are excluded, e.g. ["bazar","použit","rozbalen","demo"]
                   "max_delivery_days": null }, // with in_stock_only: an out-of-stock offer delivering within N days counts (C7)
  "fallback": { "mode": "next", "markup_pct": null, "offset_pct": 0 },   // next | keep | msrp | cost_plus  (when the price base is unavailable)
  "limits": {
    "min_margin_pct": 10, "min_profit_abs": null, "max_margin_pct": null,
    "max_above_msrp_pct": 0,      // ceiling = msrp × (1 + x/100); null = no MSRP ceiling
    "max_below_msrp_pct": null,   // floor = msrp × (1 − x/100)
    "max_decrease_pct": 10, "max_increase_pct": 15,   // per run vs current price; null = unlimited
    "allow_increase": true, "allow_decrease": true,
    "min_change_pct": 0.5, "min_change_abs": 5,       // smaller changes are ignored (no_change)
    "respect_product_limits": true                     // products.min_price / max_price
  },
  "rounding": { "mode": "ending", "direction": "down",
                "bands": [ {"up_to": 1000, "ending": 9}, {"up_to": 10000, "ending": 90}, {"up_to": null, "ending": 990} ] },
  "stock": { "zero_stock": "reprice" },   // reprice | skip | msrp
  "approval": { "auto": false, "auto_max_change_pct": 5 },
  "group": { "align": "off" }            // off | min | max | median – one price per group_code (C3, §6.10)
}
```

### 6.6 rounding.js
`roundPrice(value, rounding, direction?) → number`, `priceCandidates(value, rounding) → {down, up}`.
- mode `none` → 2 dp; `integer` → whole CZK; `ending` → price points `k × step + ending` (k ≥ 0) where the band is the
  first with `value ≤ up_to` (null = ∞), `step` = band.step ?? 10^(number of digits of ending) (ending 0 → step 1 unless
  band.step given; ending 9 → 10; 90/99 → 100; 990/999 → 1000; 490 → 1000). `ending < step` required.
  `down` = largest point ≤ value; `up` = smallest point ≥ value; if `down ≤ 0` use `up`.
- direction `down` | `up` | `nearest` (tie → down). Output is an exact integer when ending/step are integers.

### 6.7 pricing.js – `computePrice(product, offers, strategy, ctx) → Decision`
`strategy = {id, name, segment_id, config}`; `ctx = {now, settings}`. Steps (and push a Czech explanation step to `explain` for each):
0. The caller (run.js) has already checked segment / conditions / schedule applicability.
1. effective lock (`locked` and not expired `locked_until`) → `{action:'skip', reason:'locked'}`.
2. stock ≤ 0 and `stock.zero_stock === 'skip'` → skip `zero_stock`; `'msrp'` → target = msrp (skip `no_msrp` if none).
3. market = `buildMarket(offers, cfg.competitors, …)`; `rank_before = rankOf(cur, market)`.
4. Target by mode (reference = `reference_price`):
   `undercut_min`/`match_min` ref = market.min; `rank` ref = market.prices[min(rank,count)−1];
   `market_avg` ref = avg; `market_median` ref = median; `competitor` ref = that competitor's effective price;
   `msrp` ref = msrp; `cost_plus` target = gross(purchase × (1+markup/100)); `keep` target = current price;
   `fixed` target = fixed_price; `clearance`: if current price exists, `days_since_change >= every_days` (never changed
   counts as due) and `(sales_30 ?? 0) <= max_sales_30` → target = cur × (1 − step_pct/100), otherwise
   `{action:'no_change', reason:'clearance_wait'}` (guardrail violations of the current price still force a change).
   For reference-based modes: `target = ref × (1 + offset_pct/100) + offset_abs`. `match_min` ignores offsets.
   **Base unavailable** (market-based mode with `market.count < min_competitors`, named competitor missing, msrp mode without
   msrp, cost_plus without purchase price, keep/clearance without current price) → apply `fallback.mode`:
   `next` → `{action:'skip', reason:'fallthrough', base_missing:'no_market'|'no_competitor'|'no_msrp'|'no_cost'|'no_price'}`
   (run.js then tries the next applicable strategy);
   `keep` → `{action:'no_change', reason:'no_market'}` unless the current price violates floor/ceiling, in which case
   target = current price and guardrails apply; `msrp` → target = msrp × (1+offset_pct/100); `cost_plus` → gross(purchase ×
   (1+markup/100)); if the fallback base is missing too → skip `fallthrough`. Using a fallback adds flag `fallback`.
5. Bounds (gross): floor = max(min-margin floor `gross(purchase / (1 − m/100))`, min-profit floor
   `gross(purchase + p)`, msrp floor, product.min_price); ceiling = min(msrp ceiling, max-margin ceiling, product.max_price).
   Missing purchase → margin floors skipped + flag `no_cost`. `m ≥ 100` → invalid config error.
6. Apply in this order: clamp by change limits (vs current price; flag `change_limited`) → `min(ceiling)` (flag `ceiling`)
   → `max(floor)` (flag `floor`). **Floor always wins.** floor > ceiling → flag `limits_conflict`.
   If the floor pushes the price beyond the change limit → flag `floor_over_change_limit`.
7. Round (`rounding.direction`). Candidates: the point in the configured direction, the point on the other side, and points
   derived from the floor / ceiling / change limits (the band is picked from the rounded value, so the nearest valid point may lie
   in the neighbouring band). The rounded price must respect floor, ceiling and change limit and must not flip the direction of the
   change (a decrease never becomes an increase); if no candidate satisfies that and the current price is within limits →
   `no_change` reason `no_price_point`. If the price after limits equals the current price, it is not re-rounded.
   If the current price violates the limits and **no rounding point lies within [floor, ceiling]** (floor ≤ ceiling) → the
   **unrounded** whole-CZK price inside [floor, ceiling] closest to the target is used + flag `rounding_skipped` (limits beat
   the price ending – Disivo behaviour). Only when floor > ceiling does the floor win (`limits_conflict`).
8. If current price exists and |new − cur| < max(min_change_abs, cur × min_change_pct/100) and the current price
   is within [floor, ceiling] → `no_change` (reason `below_threshold`). new == cur → `no_change`.
9. Output metrics: `margin_before/after` (marginPct), `rank_after`, `change_abs`, `change_pct` (2 dp),
   flags `below_cost` (net new < purchase), `big_change` (|change_pct| > approval.auto_max_change_pct).
    Extra flag `ceiling_over_change_limit` when the ceiling forces a decrease beyond the change limit / `allow_decrease=false`.
    Skip reasons also include `invalid_vat` (VAT < 0 or ≥ 100) and `invalid_config`; no_change reasons include `keep`,
    `same_price`, `below_threshold`, `no_price_point`, `clearance_wait` and (run.js) `rejected_before` („stejná cena byla
    nedávno zamítnuta“, §3.6). Flags added by run.js: `group_aligned` („sjednoceno ve skupině“), `group_conflict` („skupinu
    nelze sjednotit (limity)“) – §6.10.
10. `auto_approve = approval.auto && !flags.some(f => BLOCKING_FLAGS.includes(f))`, BLOCKING_FLAGS = `['limits_conflict','floor_over_change_limit','ceiling_over_change_limit','below_cost','big_change','group_conflict']` (`group_conflict` is only set later by groups.js §6.10)
    and **not** (`no_cost` flag and the price goes down) – never auto-lower a price when the margin cannot be checked.

Decision shape:
```js
{ action: 'change'|'no_change'|'skip', reason: string|null,
  product_id, strategy_id, segment_id,
  old_price, new_price, target_price, reference_price, floor, ceiling,
  market: {count, min, max, avg, median, cheapest: {competitor, price}|null, used: [{competitor, price, effective, in_stock}], excluded: [{competitor, price, reason}]},
  rank_before, rank_after, margin_before, margin_after, change_abs, change_pct,
  flags: string[], explain: [{step: string, text: string}], auto_approve: bool }
```
Explanation example texts (Czech): „Nejnižší cena trhu: 12 490 Kč (VeloMarket), 5 konkurentů“, „Cíl: o 1 % levněji → 12 365 Kč“,
„Minimální marže 12 % → spodní hranice 12 800 Kč“, „Zaokrouhlení na …90 dolů → 12 790 Kč“ (format money with
`toLocaleString('cs-CZ')` + „Kč“).

### 6.8 run.js
- `loadContext(db, {now}) → {settings, segments (compiled), strategies (sorted, enabled), competitors}`.
- `evaluateProduct(ctx, product, offers) → {view, segmentIds: number[], strategy|null, decision|null, tried: [{strategy_id, name, result: 'not_applicable'|'fallthrough'|'decided', why}]}` –
  implements §3.5 (segment, conditions, schedule, fall-through). When a strategy falls through, prepend an explain step
  „Strategie X nepoužita: chybí …“ to the final decision.
- `runPricing(db, {trigger='manual', productIds?, now?, dryRun?=false}) → {run_id|null, stats, decisions?}` – `dryRun`
  (C2) evaluates the whole enabled strategy set (incl. group alignment and rejected-price memory) and writes nothing (no
  `runs` row, no proposals, no audit); `decisions` = all decisions of products some strategy decided. With `productIds` and
  a strategy that aligns groups, the selection is extended by the active members of the selected products' groups.
  stats `{products, evaluated, changes, up, down, no_change, skipped: {reason: n}, no_strategy, fallthrough (count of products where ≥1 strategy fell through), auto_approved, pending,
  by_strategy: {[strategy_id]: {name, products, changes, up, down}}, margin_impact_abs}`
  (`margin_impact_abs` = Σ (net new − net old) over changes, per unit), plus `groups: {aligned, conflicts, members}`,
  `no_change_reasons`, `flags`, `kept`, `held_by_human`, `superseded`. Writes `runs` + `proposals` + supersedes in one `tx`.
  Loads offers in bulk (one query joined with competitors), not per product.
- `simulate(db, {config, segment_id?|filter?, limit=200, now?}) → {stats, decisions (up to `limit` changes + up to `limit`
  skips), truncated: {changes, skips, changes_total, skips_total}, errors, context: false}` – no writes (contract-6). Groups are
  aligned as in a run (the ad-hoc strategy's `group.align`).
- **contextual simulation (C2)** `simulate(db, {strategy_id, config?, segment_id?, priority?, limit?, now?})` → the FULL
  enabled strategy set in priority order with that strategy's config replaced (missing `config` = the stored one); a disabled
  strategy is inserted at its priority (`priority` overrides). Reports only products decided by that strategy;
  `context: true`, `stats.products` = products of its segment, `stats.claimed_by_earlier` = products in the segment decided
  by an earlier strategy, `stats.fallthrough` = its base was missing, `stats.skipped.conditions|schedule` = not applicable,
  `stats.strategy`, `stats.segment`, `stats.groups` (only the groups aligned by THIS strategy – groups of the other
  strategies of the set are aligned too, but not counted). Unknown strategy → `errors`.
- `explainProduct(db, productId, {now?}) → {view, segments: [{id,name}], strategy, decision, tried}` – an active product in
  a price group is evaluated together with the active members of its group (the decision shows the aligned price and
  `decision.group = {code, align, members, price, conflict}`); the rejected-price memory applies too.
- `latestProposal(db, productId)`.

### 6.9 presets.js
`STRATEGY_PRESETS` – array of `{key, name, description, segment: {name, filter}|null, config}` in Czech, including:
„Ležáky N7/N8 – doprodej“ (attrs.N in [N7,N8]; undercut_min −1 %; min margin 3 %; max decrease 15 %),
„Klíčové značky – držet pozici 2“ (rank 2, min margin 18 %, MSRP ceiling, `group.align: 'max'` – sizes of one model share
the highest price),
„Bez konkurence → MOC“ (target msrp, only for market_count = 0 segment),
„Výchozí – medián trhu −2 %“ (all products, market_median −2 %, min margin 12 %, auto approve ≤ 3 %),
„Návrat marže – jsme výrazně nejlevnější“ (conditions position = cheapest AND gap_min_pct <= −5; undercut_min −1 %),
„Doprodej bez prodejů – postupné slevy“ (clearance 5 % každých 14 dní, max_sales_30 0, min margin 0 %, msrp floor 40 %),
„Víkendová akce“ (example schedule weekdays [6,7], fixed/msrp −10 %, disabled by default).
`DEFAULT_CONFIG` – the defaults of §6.5. `normalizeConfig(cfg)` deep-merges defaults and validates
(returns `{config, errors}`).

### 6.10 groups.js – price groups (C3)
`alignGroups(items: [{product, decision, strategy}], {settings}) → {aligned, conflicts, members}` (mutates decisions),
`groupKey(product)` (`codeKey(group_code)` or null). Called by `runPricing` / `simulate` / `explainProduct` after the
individual decisions (and before the rejected-price memory):
1. Members = products with the same `groupKey` decided by the **same** strategy (object identity) whose `group.align != 'off'`.
   Members decided by another strategy are not aligned (the group splits by strategy). Groups with < 2 participants → nothing.
2. Participants' resulting prices: `new_price` for `change`, the current price for `no_change`. `skip` members (locked, zero
   stock, invalid VAT…) keep their price, are excluded from the computation and listed in the explain text („… – přeskočeno“).
3. Group price = min / max / median of the resulting prices, clamped to `[max of participants' floors, min of their ceilings]`
   (explained „zvednuto na spodní hranici skupiny …“ / „sníženo na horní hranici skupiny …“). Empty interval → individual
   prices stay, every participant gets flag `group_conflict` and explain step „Skupinu X (N produktů, režim …) nelze sjednotit: …“.
   `group_conflict` is a BLOCKING flag: such a change is **never auto-approved** (approval step „Nutné ruční schválení: …,
   skupinu nelze sjednotit (limity)“) and bulk „approve all“ skips it unless `include_flagged` (RISKY_FLAGS).
4. Re-rounding with the strategy rounding (configured direction, then the other side); a point outside the interval → the
   unrounded whole-CZK value closest to the group price inside it („mezi hranicemi skupiny není cenový bod → bez zaokrouhlení“).
5. Every participant gets the group price: no_change / `min_change_*` threshold re-evaluated against ITS current price
   (`same_price` / `below_threshold`), `margin_after`, `rank_after` (from `market.used`), `change_abs`, `change_pct`,
   `below_cost`, `big_change` and auto-approval recomputed (BLOCKING_FLAGS, no_cost decrease; a group price outside the
   member's change limit is never auto-approved and gets a warning step). Flag `group_aligned`, explain step
   `{step: 'group', text: „Sjednoceno ve skupině X (N produktů, režim nejvyšší|nejnižší|medián) → Y Kč“}`,
   `decision.group = {code, align, members, price, conflict}`.

## 7. Export (`src/export/*`)

### rows.js
`exportRows(db, {scope: 'approved'|'all', ids?, productIds?}) → Row[]`; `exportRowsDetailed(...) → {rows, held}` (held =
approved proposals failing `holdReason`, see §3.7) where
`Row = {proposal_id|null, product_id, code, ean, name, manufacturer, price (to export), old_price, change_pct, vat_rate, currency, changed_at,
strategy (name|null), segment (name|null), lowest_30d}` – `lowest_30d` = lowest of our prices in the 30 days before now
(price_history + current price; EU Omnibus / CZ §12a „nejnižší cena za posledních 30 dní“ needed when a discount is announced).
- `approved`: latest approved (not exported) proposal per product → `price = manual_price ?? new_price`.
- `all`: every active product: price = latest approved-unexported proposal price, else current `products.price`
  (full price list; `proposal_id` set when it comes from a proposal).

### feeds.js
`toXml(rows, template)` (template = `settings.export.xml`: `{root, item, fields: [...] | {field: elementName}}`; root gets
attributes `generated`, `count`, `currency`), `toJson(rows) → {generated, count, currency, items: rows}`, `toCsv(rows)` (via formats/csv).

### pohoda.js
`toPohodaXml(rows, {ico, application='Cenotvorba', filter_by='code'|'ean', price_level?: string, note?, id?, encoding='windows-1250'|'utf-8'}) → Buffer`
– **follow docs/POHODA.md exactly** (it is verified against the official XSD). `dat:dataPack` version 2.0 (required attrs `id` –
unique per export, e.g. `cenotvorba-<yyyymmdd>-<export id or random>`, `application`, `note`; `ico` when set) with one
`dat:dataPackItem` (unique `id`, e.g. `CT-000001`) per row: without `price_level` → `stk:stock` → `stk:actionType/stk:update/ftr:filter/ftr:code|ftr:EAN`
+ `stk:stockHeader/stk:sellingPrice payVAT="true"`; with `price_level` → `dis:discount` agenda (`dis:discountStockItem/dis:stockItem/typ:stockItem/typ:ids|typ:EAN`,
`dis:discounts/dis:discountsItem/dis:filter/dis:priceLevel/typ:ids`, `dis:price`). Numbers as plain decimals with a dot.
`dis:price` is the gross price unless `price_level_includes_vat === false` (setting `export.pohoda.price_level_includes_vat`,
default true) – then `price / (1 + vat_rate/100)` rounded to 2 decimals (money-12).
**Default encoding windows-1250** (declaration `encoding="Windows-1250"` + bytes via `encodeWindows1250`); `utf-8` optional.
Rows without the filter key (no code / no EAN) are skipped and reported. Also export `toPohodaXmlString` (same, returns the string before encoding) for tests.
When env `POHODA_XSD_DIR` is set, tests validate the output with `xmllint --schema $POHODA_XSD_DIR/data.xsd`.

### webhook.js
`pushWebhook(rows, {url, format='json'|'xml', headers={}, timeout_ms=20000, template}) → {ok, status, body (first 2 KB), duration_ms}`
– POST; JSON body = `toJson(rows)`; retries 2× with backoff (500 ms, 2 s) on network errors/5xx; never throws.

### xlsx-report.js
`proposalsXlsx(proposals: row objects as returned by the proposals API) → Buffer` – sheets „Návrhy“ (code, name,
manufacturer, segment, strategy, old, new, change %, margin before/after, market min, cheapest competitor, rank before/after, status, flags),
„Souhrn“ (counts by status/strategy).

### apply.js
`markExported(db, proposalIds, {kind, target, actor, now?, delivered?, served?}) → {export_id, count, skipped}` – creates
`exports` row, sets proposals `exported`, applies `update_current_price` with the DELIVERED price (see §3.7), audit.
Only proposals currently `approved` are affected (plus `served` ids that a run superseded after delivery); locked
products and proposals failing `holdReason` are skipped.
`ackExport(db, {items?: [{code|proposal_id, price}], proposal_ids?, codes?}) → {…, unknown_codes, mismatched}`.
`logExport(db, {kind, target, count, status, detail})`.
`exportChanges(db, {format, mark, actor}) → {body, contentType, export_id?, count}` convenience used by API/feeds.
`markExported` also stores `proposals.exported_price` (the delivered price). **Export re-download (C8):**
`exportedRows(db, exportId) → {export, rows}` – the rows delivered by that export (proposals with `export_id`, `price` =
`exported_price` (older exports: `manual_price ?? new_price`), `lowest_30d` as of the export time, same Row shape);
`exportRedownload(db, exportId, {format: json|xml|csv}) → {body, contentType, filename, count, export_id}|null` (null =
unknown export or no rows). Nothing is marked or served.

## 8. Server & API

### config.js
`loadConfig(env=process.env) → {port (PORT|CENOTVORBA_PORT, default 8080), host ('0.0.0.0'), dbFile (CENOTVORBA_DB, default
'./data/cenotvorba.db'), password (CENOTVORBA_PASSWORD), secret (CENOTVORBA_SECRET), maxBodyMb (default 300),
maxJsonMb (CENOTVORBA_MAX_JSON_MB, default 32 – JSON bodies parsed by the API; larger → 413 before JSON.parse, security-1),
publicDir, trustProxy (bool), schedulerEnabled (default true; CENOTVORBA_SCHEDULER=0 disables)}`.

### server/http.js – tiny framework
`createRouter()` with `.get/.post/.put/.patch/.delete(pattern, handler, {auth})`; patterns `/api/v1/products/:id`.
`createApp({db, config}) → (req, res) handler`. Handler signature: `async (ctx) => result` where
`ctx = {req, res, db, config, params, query (object, repeated keys → last), body (parsed), rawBody (Buffer), user, scopes, ip}`.
Return value: object → JSON 200; `{status, headers, body}` via `send(ctx, …)` helpers (`sendFile`, `sendBuffer`, `redirect`).
Body parsing: JSON (`application/json`), text (xml/csv/text/*), raw Buffer for everything else (xlsx, octet-stream);
limit `maxBodyMb`. Errors: `HttpError(status, message, details?)` → `{error: {status, message, details}}`; unknown errors → 500
(message „Interní chyba serveru“, stack logged). 404 JSON for unknown `/api/*`; SPA fallback (`index.html`) for other GETs.
Security headers: `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`.

### server/auth.js
- Password: `CENOTVORBA_PASSWORD` env, else settings `_password_hash` (scrypt with salt). On first start without either →
  generate random 16-char password, store hash, print it once to the console (`console.log`).
- Session: cookie `ct_session` (HttpOnly, SameSite=Strict, Secure when request is https / trustProxy+x-forwarded-proto),
  value = base64url(JSON {u, exp, pv}) + '.' + HMAC-SHA256(secret) ; 14 days; secret from env or settings `_secret` (generated).
- **Login name (C9)**: `POST /auth/login` accepts optional `name` (trimmed, 1–64 chars, no control characters / line
  separators; `auto` and `token:…` are reserved → 400; empty/missing → `admin`). It is stored in the signed session (`u`),
  becomes `ctx.user` and therefore `decided_by` of proposals and the audit `actor`. **Attribution only, not
  authentication** – the password is shared, anyone who knows it can type any name. Tokens act as `token:<token name>`.
- Tokens: `Authorization: Bearer <token>`, header `X-Api-Key`, or `?token=` (feeds). Stored as sha256 hex in `tokens`;
  token format `ct_` + 32 random base62 chars; `prefix` = first 7 chars for display. Scopes: `read`, `import`, `export`, `admin`.
  Session user = all scopes. Update `last_used_at` (at most once per minute).
- Route auth option: `'public'` | scope name (`'read'` default, `'import'`, `'export'`, `'admin'`).
- CSRF: cookie-authenticated non-GET requests require header `X-Requested-With: cenotvorba` (UI sends it).
- Login rate limit: 10 failed attempts / 15 min per IP → 429.

### server/scheduler.js
`startScheduler({db, config, log}) → {stop()}` – every 60 s (and 5 s after start): run `dueSources` sequentially
(`runSource`), then if `schedule.run_after_import` and some offers import succeeded → `runPricing(trigger:'schedule')`;
if `schedule.run_interval_minutes > 0` and last run (runs table) older → run; otherwise when the validity of some enabled
strategy's time window (`config.schedule`) changed since the last run → run with reason `window` (ops-9). Run / import
times more than 1 h in the future (clock skew) are ignored (ops-10). After a scheduled run, if
`schedule.auto_push_after_run` and webhook url set → push approved changes (`pushWebhook` + `markExported` with the
delivered prices on success). Never overlaps (mutex); errors logged, never crash the process. Also daily retention
cleanup (in batches of 10 000): `rejected` proposals and `offer_history`/`audit`/`imports` older than `retention_days`,
`superseded` proposals older than `retention_superseded_days` (default 14, at most `retention_days`), `unmatched_offers`
not seen for 30 days (ops-5, ops-11). At server start `imports` / `runs` / sources left `running` by a crash are marked
as interrupted (ops-2).

### API endpoints (all JSON unless stated; prefix `/api/v1`; list endpoints return `{items, total, page, limit}`)

The integration guide for the admin (feed → apply → ack, webhook, errors, recovery, reference client) is
[docs/ADMIN-API.md](ADMIN-API.md) (Czech).

| Method & path | Auth | Request | Response |
|---|---|---|---|
| GET `/health` | public | | `{ok:true, version, time}` |
| POST `/auth/login` | public | `{password, name?}` (C9) | `{ok:true}` + cookie |
| POST `/auth/logout` | public | | `{ok:true}` |
| GET `/auth/me` | read | | `{user, scopes, via:'session'|'token'}` |
| GET `/dashboard` | read | | see below |
| GET `/fields` | read | | `{fields: FIELDS + attrs.* discovered (type guessed)}` |
| GET `/products` | read | query: `q` (code/name/ean contains), `manufacturer`, `category`, `owner`, `supplier`, `segment` (id), `position`, `has_proposal` (1), `status` (active/inactive/all, default active), `filter` (JSON Filter), `sort` (any view field, default `code`), `dir` asc/desc, `page` (1), `limit` (50, max 500) | `{items: View+{proposal: {id,status,new_price,change_pct}|null, segments:[id]}, total, page, limit}` |
| GET `/products/facets` | read | | `{manufacturers:[{value,count}], categories, owners, suppliers, attrs: {key: [{value,count}] (top 50, only keys with ≤ 200 distinct values)}}` |
| GET `/products/:id` | read | | `{product: View, offers: [offer+competitor name, excluded reason from default market], history: {our: price_history rows (last 200), competitors: offer_history rows (last 500) with competitor name}, explain: explainProduct result, proposals: last 20}` |
| PATCH `/products/:id` | admin | `{locked?, min_price?, max_price?, note?, price?}` (`price` → manual price change, history `manual`) | product |
| GET `/competitors` | read | | `{items: [{id,name,label,enabled,tags,note, offers (count), products_cheaper_than_us, avg_index (their price / our price ×100), last_seen_at}]}` |
| PATCH `/competitors/:id` | admin | `{label?, enabled?, tags?, note?}` | competitor |
| GET/POST `/segments`, GET/PUT/DELETE `/segments/:id` | read/admin | `{name, description, filter, color}` | segment (+`count` of matching active products in list) ; DELETE used by a strategy → 409 |
| POST `/segments/preview` | read | `{filter}` | `{count, sample: View[≤20], errors}` |
| GET/POST `/strategies`, GET/PUT/DELETE `/strategies/:id` | read/admin | `{name, description, segment_id, priority, enabled, config}` | strategy (config normalized; invalid → 400 with errors) |
| POST `/strategies/reorder` | admin | `{ids: [..]}` | priorities set to 10,20,30… |
| GET `/strategies/presets` | read | | `{items: STRATEGY_PRESETS}` |
| POST `/strategies/presets/:key` | admin | | creates segment (if any) + strategy from preset – always **disabled**; a targeted preset is placed before an enabled catch-all strategy (no segment, no conditions) → `{strategy, segment, segment_created, warning}` (contract-4) |
| POST `/simulate` | read | `{config, segment_id?, filter?, limit?}` or `{strategy_id, config?, segment_id?, priority?, limit?}` (C2 contextual) | `{stats, decisions (+product {id,code,name,manufacturer}), truncated, errors: [], context}` – `context: true` + `stats.claimed_by_earlier` with `strategy_id`; unknown strategy / invalid config → 400 |
| POST `/runs` | admin | `{product_ids?, dry_run?}` | `{run_id, stats}`; `dry_run: true` (C2) → `{run_id: null, dry_run: true, stats, sample: [≤ 200 decisions sorted by abs(change_pct) desc, each + product {id, code, name, manufacturer, category}]}` – nothing written, no audit |
| GET `/runs`, GET `/runs/:id` | read | | runs with parsed stats |
| GET `/proposals` | read | query: `status` (default `pending`; `all`), `run`, `strategy`, `segment` (deciding strategy's segment), `direction` up/down, `flag`, `q`, `manufacturer`, `owner`, `category`, `supplier` (exact, case/diacritics-insensitive), `product_segment` (any segment the product belongs to), `filter` (Filter JSON over the product view; invalid → 400) (C4), `sort` (default `abs_change_pct` desc; own keys only), `page`, `limit` | `{items: [proposal + product {code,name,manufacturer,category,stock,purchase_price} + strategy_name + segment_name + flags[] + explain[]], total, page, limit, max_id, flagged, summary: {pending, approved, exported_today, up, down}}` |
| POST `/proposals/approve` | admin | `{ids?: [], all?: bool (+ same filter query fields in body.filter), expect?: {count, max_id}, include_flagged?: bool}` | `{updated, skipped_locked, skipped_inactive, skipped_flagged}` (only `pending` ones; `all` with `expect` not matching the current selection → 409 `PROPOSALS_CHANGED`; `all` skips proposals with risky flags – BLOCKING_FLAGS, manual price outside limits, previously_rejected – unless `include_flagged`; money-9) |
| POST `/proposals/reject` | admin | same | `{updated}` |
| POST `/proposals/unapprove` | admin | `{ids? \| all: true, filter?, expect?}` (C5) | `{updated}` – `approved` and not exported → `pending`; `decided_at`/`decided_by` = who un-approved, `served_*` cleared (an ack by code no longer marks it) |
| PATCH `/proposals/:id` | admin | `{manual_price, confirm?}` (null clears) | proposal; a risky manual price (net below purchase, outside product min/max, > 50 % change) without `confirm: true` → 409 `MANUAL_PRICE_CONFIRM` with `details.reasons`; stored with flags `manual`, `manual_below_cost`, `below_min`, `above_max`, `big_manual_change`; editing an `approved` proposal returns it to `pending`; locked product → 409 (money-7) |
| POST `/import/preview` | import | raw body (any format) + query `kind`, `mapping` (JSON string) or `source` id | `previewImport` result |
| POST `/import/offers` | import | raw body + query `source`/`mapping`, `replace`, `dry_run` | `{import_id, stats}` ; also accepts `application/json` body `{items:[canonical offers]}` or an array |
| POST `/import/products` | import | raw body + query `source`/`mapping`, `deactivate_missing`, `force_deactivate`, `create_missing` (C6: `0` = update-only; overrides `sources.options.create_missing`; invalid → 400), `dry_run` | `{import_id, stats}` (+ `skipped_unknown`, `unknown_codes` in update-only mode) |
| GET `/imports` | read | | import log (latest 100) |
| GET/POST `/sources`, GET/PUT/DELETE `/sources/:id`, POST `/sources/:id/run` | read/admin | `{name, kind, url, method, headers, mapping, options, interval_minutes, enabled}` | source / run result |
| GET `/unmatched` | read | query `competitor`, `q`, page | `{items, total}` |
| POST `/unmatched/:id/match` | admin | `{product_id}` | `{ok}` |
| DELETE `/unmatched/:id` | admin | | `{ok}` |
| GET `/export/changes.(json|xml|csv)` | export | query `mark=1` | body in format; header `X-Export-Id` when marked, `X-Export-Held` = held proposals |
| POST `/export/ack` | export | `{items?: [{code|proposal_id, price}], proposal_ids?: [], codes?: []}` (items with the applied price recommended) | `{export_id, count, proposal_ids, unknown_codes, mismatched, skipped}` |
| GET `/export/pohoda.xml` | export | query `scope` approved/all, `mark=1`, `encoding` | POHODA XML (attachment) |
| GET `/export/proposals.xlsx` | read | same filters as `/proposals` | XLSX attachment |
| GET `/export/pricelist.(json|xml|csv|xlsx)` | export | | full price list (`scope=all`) |
| POST `/export/push` | export | | `pushWebhook` result + marked export |
| GET `/exports` | read | | export log; items + `redownload` (bool – the export has proposals, C8) |
| GET `/exports/:id/changes.(json\|xml\|csv)` | export | | C8 re-download: the rows delivered by export `:id` (price = delivered price), same body as the changes feed, headers `X-Export-Id`, `X-Export-Count`; unknown id / no rows → 404 |
| GET `/feed/:name.(xml|json|csv)` (**no /api/v1 prefix**) | token `?token=` scope export | `name` = `changes` or `prices`; `mark=1` allowed for changes | feed |
| GET/PUT `/settings` | read/admin | partial settings object (deep-merged); incl. `reject_memory_days` (integer 0–365), `retention_superseded_days`, `export.pohoda.price_level_includes_vat` | settings |
| POST `/settings/password` | admin | `{current, new}` | `{ok}` |
| GET/POST `/tokens`, DELETE `/tokens/:id` | admin | `{name, scopes}` | POST returns the plain token once `{id, token, prefix, scopes}` |
| GET `/audit` | admin | | last 200 |

Dashboard response:
```
{ products: {active, with_market, without_market, locked},
  position: {cheapest, middle, most_expensive, no_data},             // counts over active products
  price_index: {vs_min: avg %, vs_median: avg %},                    // only products with market
  proposals: {pending, approved, exported_7d, up, down, avg_change_pct, margin_impact_abs},
  last_run: run|null, last_imports: imports[≤5],
  competitors: [{name, offers, cheaper_than_us_pct}] (top 10 by offers),
  by_manufacturer: [{manufacturer, products, avg_index, cheapest_pct, avg_margin_pct}] (top 15 by products),
  alerts: [{type, severity: 'info'|'warn'|'error', text, count?, link? (UI hash route)}] – types: `below_cost` (active products
  priced below purchase), `no_cost` (missing purchase price), `zero_price`, `competitor_drop` (offers whose price dropped > 10 %
  in the last 24 h), `stale_offers` (no offer import for > offer_max_age_days), `not_applied` (exported > 24 h ago but the
  latest catalog import still shows a different price – the admin did not apply it), `min_below_cost` (competitor sells
  below our purchase price), `unmatched` (unmatched offers count) }
```

## 9. UI (`public/`) – Czech, vanilla JS SPA (ES modules), no external resources (CSP 'self')

Hash router (`#/prehled`, `#/produkty`, `#/produkty/:id`, `#/navrhy`, `#/strategie`, `#/segmenty`, `#/konkurence`,
`#/import`, `#/export`, `#/nastaveni`, `#/login`). `lib/api.js` wraps fetch (`X-Requested-With: cenotvorba`,
JSON, 401 → login). Components: data table (sorting, pagination, column formatting money/percent, row click),
filter builder (for segments; fields from `/fields`, facet values from `/products/facets`), strategy form (all §6.5 options,
grouped: Cíl, Konkurence, Limity, Zaokrouhlení, Schvalování, with inline help texts), toast notifications, modal dialog,
simple inline SVG charts (bar, sparkline/line for price history). Responsive (≥ 360 px), light/dark via `prefers-color-scheme`.

Pages:
- **Přehled** – KPI tiles, position distribution bar, competitors table, by-manufacturer table, alerts, "Spustit přecenění" button.
- **Produkty** – search, facet filters (výrobce, kategorie, zodpovědná osoba, pozice, segment), sortable table
  (kód, název, výrobce, sklad, nákup, cena, marže %, min. trh, index, pozice, konkurentů, návrh), bulk nothing.
  Detail: product card, offers table (competitor, price, shipping, skladem, stáří, excluded reason), price history chart
  (our price + competitors), explanation of current strategy decision (steps), lock / min / max / note editing.
- **Návrhy cen** – filters (status, strategie, segment, směr, příznak), table with old → new, change %, margins, flags,
  expandable explanation, manual price edit, checkboxes + bulk approve/reject, "Schválit vše dle filtru", export XLSX.
- **Strategie** – ordered list (drag or up/down buttons → reorder), enable toggle, edit form, presets gallery,
  "Simulovat" (shows stats + sample decisions), "Spustit přecenění".
- **Segmenty** – list with counts, editor with filter builder and live preview (count + sample).
- **Konkurence** – competitors table, enable/disable, tags, label; unmatched offers list with manual matching
  (search product by code/name → match).
- **Import** – upload (drag&drop) → preview (detected format, headers, suggested mapping editable per canonical field,
  sample canonical rows) → import (offers/products) → stats; save mapping as source; sources list (URL, interval,
  run now, last status); import log. Shows API usage examples (curl) for pushing data.
- **Export** – feed URLs (with token placeholder), download buttons (changes JSON/XML/CSV, POHODA XML, price list XLSX),
  push webhook now, export log, API ack documentation.
- **Nastavení** – general (VAT, offer max age, purchase incl. VAT), export (XML template fields, POHODA IČO/filter/price level,
  webhook url/format/headers/auto push), scheduling, API tokens (create shows token once), password change.

## 10. Quality bar
- Every module has unit tests covering normal cases and edge cases listed above.
- Pricing engine tests must include: each target mode, fallback modes, each guardrail, floor-wins precedence,
  rounding bands/directions incl. floor interaction, thresholds, auto-approve rules, stale/out-of-stock/outlier exclusion.
- No unhandled promise rejections; server never crashes on bad input.
- Performance target: run over 30 000 products × 8 competitors in < 5 s; import 200 000 offers in < 20 s.
