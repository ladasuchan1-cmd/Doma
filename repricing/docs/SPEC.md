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
`parseNumber(v, {decimal?})` (CZ/EN formats, currency, `,-`, `%`), `round(n, d=2)`, `net(gross, vat)`,
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
(`pending`, or `approved` when auto-approved). A new run marks all older `pending` and `approved` (not exported)
proposals of every evaluated product as `superseded`. Statuses: `pending | approved | rejected | exported | superseded`.
The price to export = `manual_price ?? new_price`.

### 3.7 Export
Exporting approved proposals (feed pull + ack, webhook push, POHODA XML download with mark) → status `exported`,
`exported_at`, `export_id`; if setting `export.update_current_price` → `products.price` := exported price,
`price_changed_at`, and a `price_history` row (`source='export'`).

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
- JSON: records = the array at `item_path` (dot path), or root if it is an array, or the first array-valued property
  found breadth-first (e.g. `{items:[…]}`, `{data:{offers:[…]}}`); a single object → one record.
- XML: `streamRecords` with `item_path` or `detectItemPath`.
- CSV/XLSX: rows as objects keyed by header.
- **Flattening**: every record becomes a flat object with dot-path keys (`offers.offer.@shop`, `PRICE_VAT`,
  `PARAM.Barva` for Heureka-style `PARAM{PARAM_NAME,VAL}` pairs). Arrays of primitives are joined with `|`.
- **Nested offers**: if `offers_path` is set (or auto: the record has exactly one array of objects whose objects
  contain a price-like field), each element of that array becomes its own row inheriting the parent's fields;
  child keys are exposed both as `<offers_path>.<key>` and as bare `<key>` (child wins on conflict).
- `headers` = union of flat keys (first 1000 records) in first-seen order.

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
  observed_at: observed_at, date, datum, timestamp, scraped_at, updated_at; sales_30/sales_90: prodej_30, sales_30d…
- `applyMapping(flatRecord, mapping, kind, ctx) → {value: object|null, errors: string[]}` – builds a canonical record:
  `mapping.fields[canonical] = sourceKey` (explicit wins; otherwise suggestions), `mapping.defaults[canonical] = constant`,
  coercion: numbers via `parseNumber(v, {decimal: mapping.csv?.decimal})`; `vat_rate` "21 %" → 21;
  `availability` → `{in_stock, delivery_days}` (see `normalizeAvailability`); `observed_at` → ISO (accepts ISO, `d.m.yyyy[ H:mm]`,
  unix seconds/ms); texts trimmed, empty → null. For `products`, all **unmapped** keys go to `attrs` (numbers parsed
  when the whole value is numeric) unless `mapping.attrs === 'none'`; `mapping.attrs` may also be an array of keys to keep.
  `mapping.price_net = true` → offer/our prices are net and must be converted to gross with vat (product's or default).
- `normalizeAvailability(v) → {in_stock: 1|0|null, delivery_days: number|null}`:
  true/"1"/"ano"/"yes"/"skladem"/"in stock"/"instock"/"in_stock"/"available"/"na skladě" → in_stock 1, days 0;
  false/"0"(as a word only when the field is boolean-like)/"ne"/"no"/"není skladem"/"vyprodáno"/"out of stock"/
  "outofstock"/"na dotaz"/"nedostupné"/"preorder"/"předobjednávka" → 0; a number (or "do 3 dnů"/"3 dny") = delivery days
  → in_stock = (days ≤ 0 ? 1 : 0), delivery_days = days. Heureka `DELIVERY_DATE` 0 = skladem.
  Field `stock_qty` > 0 → in_stock 1.

### products.js
`importProducts(db, records (canonical), {deactivateMissing?=false, sourceId?, now?}) → stats`
- upsert by `code_key`; update only fields present (non-undefined) in the record; merge `attrs` (new keys overwrite,
  others kept); `purchase_includes_vat` setting → divide purchase_price by (1+vat/100).
- if `price` changed vs stored → `price_history` row (`source='import'`) and `price_changed_at`.
- `deactivateMissing` → products not in this import get `active=0` (and reactivated when present again).
- stats `{received, created, updated, unchanged, deactivated, errors: [{row, message}]}` (max 100 error entries).

### offers.js
`importOffers(db, records (canonical), {replace?: false|'competitors'|'all', sourceId?, now?, maxAgeDays?}) → stats`
- competitor: find/create by `nameKey`.
- matching order: `code` → products.code_key; `ean` → products.ean_key; `mpn` → products.mpn_key; then
  `product_aliases` (kind code/ean/mpn/ext/name with competitor-specific alias preferred over competitor_id=0).
  Multiple products with the same ean/mpn → ambiguous → treat as unmatched (reason `ambiguous`).
- unmatched → upsert `unmatched_offers` (`match_key` = first of `ean:<k>`, `mpn:<k>`, `code:<k>`, `ext:<id>`,
  `name:<fold(name)>`), increment `seen_count`.
- matched → upsert `offers`; if price or in_stock changed (or new) → `offer_history` row; keep `prev_price`/`changed_at`.
  Several rows for the same product×competitor in one import → keep the lowest price (log `duplicates` count).
  `observed_at` older than the stored one → ignored (stats `stale`).
- `replace='competitors'` → for competitors present in this import, delete their offers not present in it;
  `'all'` → delete all offers not present.
- validation: price must be > 0 and finite, else error row.
- stats `{received, matched, unmatched, ambiguous, created, updated, unchanged, stale, duplicates, removed, competitors_created, errors}`.
- `matchUnmatched(db, unmatchedId, productId, {kind?})` → creates alias from the stored identifiers
  (`ean` > `mpn` > `ext` > `code` > `name`), re-imports the stored raw offer, deletes the unmatched row.

### sources.js
- `runImport(db, {kind, input, mapping, options, sourceId?, origin, dryRun?, now?}) → {import_id, stats, preview?}` –
  logs to `imports` (`running` → `ok`/`error`), calls `extractRecords` → `applyMapping` → `importProducts`/`importOffers`
  inside one `tx`. `dryRun` → no writes except nothing (no import row), returns `preview` (first 20 canonical records) + stats of mapping errors.
- `previewImport({input, mapping, kind}) → {format, itemPath, headers, suggested: mapping.fields, sample: flat[0..9], canonical: [0..9], errors}`
- `fetchSource(source) → {buffer, contentType}` – `fetch` with method, headers (JSON), 60 s timeout (AbortSignal),
  max 500 MB, follows redirects; non-2xx → error with status.
- `runSource(db, sourceId, {origin='schedule'|'manual'}) → result` – fetch + runImport + update `sources.last_*`.
- `dueSources(db, now) → source[]` (enabled, url set, interval > 0, last_run_at older than interval).

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
(product fields, metrics, plus dynamic `attrs.*` added by API from data). `position` is enum
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
                   "exclude_keywords": [] },   // offers whose name contains any keyword (fold()) are excluded, e.g. ["bazar","použit","rozbalen","demo"]
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
  "approval": { "auto": false, "auto_max_change_pct": 5 }
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
7. Round (`rounding.direction`); if rounded < floor → take `up` candidate (repeat until ≥ floor); if rounded > ceiling and the
   `down` candidate ≥ floor → take it.
8. If current price exists and |new − cur| < max(min_change_abs, cur × min_change_pct/100) and the current price
   is within [floor, ceiling] → `no_change` (reason `below_threshold`). new == cur → `no_change`.
9. Output metrics: `margin_before/after` (marginPct), `rank_after`, `change_abs`, `change_pct` (2 dp),
   flags `below_cost` (net new < purchase), `big_change` (|change_pct| > approval.auto_max_change_pct).
10. `auto_approve = approval.auto && !flags.some(f => ['limits_conflict','floor_over_change_limit','below_cost','big_change'].includes(f))`
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
- `runPricing(db, {trigger='manual', productIds?, now?, dryRun?=false}) → {run_id|null, stats, decisions?}`
  stats `{products, evaluated, changes, up, down, no_change, skipped: {reason: n}, no_strategy, fallthrough (count of products where ≥1 strategy fell through), auto_approved, pending,
  by_strategy: {[strategy_id]: {name, products, changes, up, down}}, margin_impact_abs}`
  (`margin_impact_abs` = Σ (net new − net old) over changes, per unit). Writes `runs` + `proposals` + supersedes in one `tx`.
  Loads offers in bulk (one query joined with competitors), not per product.
- `simulate(db, {config, segment_id?|filter?, limit=200, now?}) → {stats, decisions (first `limit` changes/skips)}` – no writes.
- `explainProduct(db, productId, {now?}) → {view, segments: [{id,name}], strategy, decision}`.
- `latestProposal(db, productId)`.

### 6.9 presets.js
`STRATEGY_PRESETS` – array of `{key, name, description, segment: {name, filter}|null, config}` in Czech, including:
„Ležáky N7/N8 – doprodej“ (attrs.N in [N7,N8]; undercut_min −1 %; min margin 3 %; max decrease 15 %),
„Klíčové značky – držet pozici 2“ (rank 2, min margin 18 %, MSRP ceiling),
„Bez konkurence → MOC“ (target msrp, only for market_count = 0 segment),
„Výchozí – medián trhu −2 %“ (all products, market_median −2 %, min margin 12 %, auto approve ≤ 3 %),
„Návrat marže – jsme výrazně nejlevnější“ (conditions position = cheapest AND gap_min_pct <= −5; undercut_min −1 %),
„Doprodej bez prodejů – postupné slevy“ (clearance 5 % každých 14 dní, max_sales_30 0, min margin 0 %, msrp floor 40 %),
„Víkendová akce“ (example schedule weekdays [6,7], fixed/msrp −10 %, disabled by default).
`DEFAULT_CONFIG` – the defaults of §6.5. `normalizeConfig(cfg)` deep-merges defaults and validates
(returns `{config, errors}`).

## 7. Export (`src/export/*`)

### rows.js
`exportRows(db, {scope: 'approved'|'all', ids?, productIds?}) → Row[]` where
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
`markExported(db, proposalIds, {kind, target, actor, now?}) → {export_id, count}` – creates `exports` row, sets proposals
`exported`, applies `update_current_price` (see §3.7), audit. Only proposals currently `approved` are affected.
`logExport(db, {kind, target, count, status, detail})`.
`exportChanges(db, {format, mark, actor}) → {body, contentType, export_id?, count}` convenience used by API/feeds.

## 8. Server & API

### config.js
`loadConfig(env=process.env) → {port (PORT|CENOTVORBA_PORT, default 8080), host ('0.0.0.0'), dbFile (CENOTVORBA_DB, default
'./data/cenotvorba.db'), password (CENOTVORBA_PASSWORD), secret (CENOTVORBA_SECRET), maxBodyMb (default 300),
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
  value = base64url(JSON {u, exp}) + '.' + HMAC-SHA256(secret) ; 14 days; secret from env or settings `_secret` (generated).
- Tokens: `Authorization: Bearer <token>`, header `X-Api-Key`, or `?token=` (feeds). Stored as sha256 hex in `tokens`;
  token format `ct_` + 32 random base62 chars; `prefix` = first 7 chars for display. Scopes: `read`, `import`, `export`, `admin`.
  Session user = all scopes. Update `last_used_at` (at most once per minute).
- Route auth option: `'public'` | scope name (`'read'` default, `'import'`, `'export'`, `'admin'`).
- CSRF: cookie-authenticated non-GET requests require header `X-Requested-With: cenotvorba` (UI sends it).
- Login rate limit: 10 failed attempts / 15 min per IP → 429.

### server/scheduler.js
`startScheduler({db, config, log}) → {stop()}` – every 60 s (and 5 s after start): run `dueSources` sequentially
(`runSource`), then if `schedule.run_after_import` and some offers import succeeded → `runPricing(trigger:'schedule')`;
if `schedule.run_interval_minutes > 0` and last run (runs table) older → run; after a scheduled run, if
`schedule.auto_push_after_run` and webhook url set → push approved changes (`pushWebhook` + `markExported` on success).
Never overlaps (mutex); errors logged, never crash the process. Also daily retention cleanup: delete `superseded`/`rejected`
proposals and `offer_history`/`audit`/`imports` older than `retention_days`.

### API endpoints (all JSON unless stated; prefix `/api/v1`; list endpoints return `{items, total, page, limit}`)

| Method & path | Auth | Request | Response |
|---|---|---|---|
| GET `/health` | public | | `{ok:true, version, time}` |
| POST `/auth/login` | public | `{password}` | `{ok:true}` + cookie |
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
| POST `/strategies/presets/:key` | admin | | creates segment (if any) + strategy from preset |
| POST `/simulate` | read | `{config, segment_id?, filter?, limit?}` | `simulate()` result |
| POST `/runs` | admin | `{product_ids?}` | `{run_id, stats}` |
| GET `/runs`, GET `/runs/:id` | read | | runs with parsed stats |
| GET `/proposals` | read | query: `status` (default `pending`; `all`), `run`, `strategy`, `segment`, `direction` up/down, `flag`, `q`, `manufacturer`, `sort` (default `abs_change_pct` desc), `page`, `limit` | `{items: [proposal + product {code,name,manufacturer,category,stock,purchase_price} + strategy_name + segment_name + flags[] + explain[]], total, page, limit, summary: {pending, approved, exported_today, up, down}}` |
| POST `/proposals/approve` | admin | `{ids?: [], all?: bool (+ same filter query fields in body.filter)}` | `{updated}` (only `pending` ones) |
| POST `/proposals/reject` | admin | same | `{updated}` |
| PATCH `/proposals/:id` | admin | `{manual_price}` (null clears) | proposal (status stays; if pending it may be approved later) |
| POST `/import/preview` | import | raw body (any format) + query `kind`, `mapping` (JSON string) or `source` id | `previewImport` result |
| POST `/import/offers` | import | raw body + query `source`/`mapping`, `replace`, `dry_run` | `{import_id, stats}` ; also accepts `application/json` body `{items:[canonical offers]}` or an array |
| POST `/import/products` | import | raw body + query `source`/`mapping`, `deactivate_missing`, `dry_run` | `{import_id, stats}` |
| GET `/imports` | read | | import log (latest 100) |
| GET/POST `/sources`, GET/PUT/DELETE `/sources/:id`, POST `/sources/:id/run` | read/admin | `{name, kind, url, method, headers, mapping, options, interval_minutes, enabled}` | source / run result |
| GET `/unmatched` | read | query `competitor`, `q`, page | `{items, total}` |
| POST `/unmatched/:id/match` | admin | `{product_id}` | `{ok}` |
| DELETE `/unmatched/:id` | admin | | `{ok}` |
| GET `/export/changes.(json|xml|csv)` | export | query `mark=1` | body in format; header `X-Export-Id` when marked |
| POST `/export/ack` | export | `{proposal_ids?: [], codes?: []}` | `{export_id, count}` |
| GET `/export/pohoda.xml` | export | query `scope` approved/all, `mark=1`, `encoding` | POHODA XML (attachment) |
| GET `/export/proposals.xlsx` | read | same filters as `/proposals` | XLSX attachment |
| GET `/export/pricelist.(json|xml|csv|xlsx)` | export | | full price list (`scope=all`) |
| POST `/export/push` | export | | `pushWebhook` result + marked export |
| GET `/exports` | read | | export log |
| GET `/feed/:name.(xml|json|csv)` (**no /api/v1 prefix**) | token `?token=` scope export | `name` = `changes` or `prices`; `mark=1` allowed for changes | feed |
| GET/PUT `/settings` | read/admin | partial settings object (deep-merged) | settings |
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
