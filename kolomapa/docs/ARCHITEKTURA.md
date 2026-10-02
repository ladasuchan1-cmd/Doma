# Kolomapa – architektura

Node.js ≥ 22.13, CommonJS, `'use strict'`, **bez povinných závislostí** (stejně jako `repricing/`). Volitelné:
`playwright` (Cyklobazar je za Cloudflare → potřebuje skutečný prohlížeč) a `@anthropic-ai/sdk` (AI nacenění podle fotky).
Komentáře a hlášky česky, JSDoc u exportů. Testy `node --test` (bez frameworku), offline nad fixtures v `test/fixtures/`.

```
kolomapa/
  server.js                 HTTP server (UI + JSON API) + denní plánovač
  tools/run.js              jednorázový běh (pro cron / Plánovač úloh / GitHub Actions)
  tools/export-static.js    statická verze mapy do dist/ (GitHub Pages apod.)
  tools/import-sales.js     import vlastních prodejů z POHODY (xlsx) → training/ + DB
  tools/build-geo.js        přegeneruje src/geo/data (GeoNames, ČÚZK)
  src/config.js             proměnné prostředí
  src/db.js                 SQLite schéma (tabulky listings, price_history, sales, runs, settings)
  src/pipeline.js           denní běh: zdroje → upsert → detaily → klasifikace → geo → nacenění → zmizelé
  src/sources/{bazos,sbazar,aukro,cyklobazar}.js   scrapery (kontrakt níže)
  src/sources/index.js      registr zdrojů
  src/sources/browser.js    sdílený Chromium (Playwright) – jen pro zdroje s requiresBrowser
  src/classify/index.js     kolo × nekolo, typ kola, vytěžení údajů z textu
  src/geo/index.js          PSČ / obec / okres / kraj → souřadnice + kraj (offline data v src/geo/data)
  src/pricing/index.js      trénink modelu + nacenění všech inzerátů
  src/pricing/ai.js         volitelné AI nacenění (Claude, fotka + text)
  src/sales.js              import prodejů obchodu (anonymizace, DPH, vratky)
  src/util/{http,text,log}.js
  public/                   UI (Leaflet mapa, seznam, filtry) – funguje nad serverem i staticky
  training/koloshop-prodeje.json   anonymizované vlastní prodeje (trénovací data)
```

## Normalizovaná položka inzerátu (výstup zdroje)

| pole | typ | poznámka |
|---|---|---|
| `sourceId` * | string | ID na webu |
| `url` * | string | veřejný odkaz na inzerát |
| `title` * | string | |
| `description` | string | plný text (z výpisu může být zkrácený) |
| `priceCzk` | number \| null | null = dohodou / v textu / aukce bez ceny |
| `priceNote` | string \| null | „Dohodou“, „Aukce – aktuální příhoz“, „Kup teď“ … |
| `postedAt` | ISO string | vložení / poslední obnovení |
| `categorySrc` | string | kategorie na webu |
| `locationText` | string | město / lokalita tak, jak ji uvádí web |
| `psc` | string | 5 číslic bez mezery, je-li k dispozici |
| `okres`, `kraj` | string | text z webu (kraj se normalizuje v geo) |
| `lat`, `lon` | number | jen souřadnice dodané webem (ukládají se do `src_lat/src_lon`) |
| `latLonPrecision` | `exact` \| `city` \| `psc` | jak přesné souřadnice webu jsou (střed obce / PSČ → piny se rozptýlí); výchozí `exact` |
| `photoUrl` | string | JEDNA hlavní fotka, velikost ~800–1200 px, musí se načíst bez cookies |
| `photoCount` | number | |
| `params` | object | strukturované údaje webu (`{"Velikost rámu": "L", "Rok výroby": "2021", …}`); z výpisu se slévají do uložených, `null` klíč smaže, z detailu se nahradí celé |
| `sellerType` | `private` \| `company` \| null | |
| `views` | number | |
| `detailComplete` | boolean | položka už obsahuje vše, co by dal detail |

**Nikdy neukládat** jméno, telefon ani e-mail prodávajícího.

## Kontrakt zdroje

```js
module.exports = {
  key: 'bazos', label: 'Bazoš', homepage: 'https://www.bazos.cz', requiresBrowser: false,
  defaultMaxDetails: 4000, // detailů za běh, pokud není nastaveno KOLOMAPA_MAX_DETAILS
  async scan(ctx) { /* … await ctx.emit(item) … */ return { complete: true }; },
  async detail(ctx, listing) { return { description, params, photoUrl, … } /* nebo null = inzerát zmizel */ },
  async confirmGone(ctx, listing) { return true /* smazán */ | false /* existuje */ | null /* nevím */; }, // volitelné
};
```

`ctx`: `http` (src/util/http.js – šetrné pauzy, opakování), `getBrowser()` (jen requiresBrowser), `log`, `config`,
`signal`, `cache` (trvalé `get/set/delete` klíč → JSON pro daný zdroj, např. přeložené lokality), `mode` (`'full'` = projít celý výpis, `'incremental'` = skončit, když 3 stránky po sobě přinesou jen známé
inzeráty bez změny ceny – pozor na topované inzeráty nahoře), `maxPages`, `minPrice`, `isKnown(sourceId)`,
`emit(item) → {isNew, changed}`.

`complete: true` vracet jen při `mode === 'full'` a úspěšném průchodu celého výpisu všech kategorií – pak pipeline
označí neviděné inzeráty jako zmizelé (prodané/smazané): hned, pokud to zdroj potvrdí přes `confirmGone`, jinak až když
chybí ve dvou úplných průchodech po sobě (offsetové stránkování se během průchodu posouvá).

## Klasifikace (`src/classify`)

`classifyListing({source, title, description, params, categorySrc, priceCzk, sellerType})` →
`{isBike, bikeType, reason, features}`; export `CLASSIFIER_VERSION` (zvýšit při změně logiky → překlasifikuje se vše).

`bikeType`: `mtb_hardtail | mtb_full | road | gravel | cyclocross | trekking | cross | city | kids | balance | bmx | dirt | fatbike | folding | cargo | tandem | ebike_mtb | ebike_mtb_full | ebike_trekking | ebike_city | ebike_road | ebike_cargo | ebike_kids | other`.

`features` (vše volitelné): `brand`, `brandTier` (1–5), `model`, `modelYear`, `ageYears`, `wheelSize`, `frameSize`,
`material` (`carbon|alu|steel|titanium`), `suspension` (`rigid|hardtail|full`), `isEbike`, `motor`, `batteryWh`,
`groupset`, `groupsetTier`, `condition` (`new|like_new|very_good|good|fair|poor|parts`), `originalPriceCzk`,
`hasReceipt`, `warranty`, `isShop`, `isFrameOnly`, `kidsWheel`, `warnings` (pole českých textů).

## Nacenění (`src/pricing`)

- `trainModel(db, {config, log})` → model (pravidla z `kb.json` + naučené koeficienty z tržních dat + kalibrace na vlastní
  prodeje) s `summary` pro statistiky běhu.
- `estimate(model, listing)` → `{estCzk, low, high, confidence (0–1), method, factors: [české texty]}`.
- `priceAll(db, model, {config})` zapíše `est_*`, `deal_ratio = price_czk / est_czk`, `max_buy_czk`.
- AI (`ai.js`, jen s `ANTHROPIC_API_KEY`): pro nejzajímavější inzeráty pošle Claude titulek, popis, parametry, fotku,
  odhad modelu a srovnatelné inzeráty → strukturovaný JSON `{estimate_czk, low_czk, high_czk, condition, notes}`;
  výsledek se uloží do `ai_*` a má přednost v UI.

## API serveru (stejné tvary vrací statický export)

- `GET /data/summary.json` – `{generatedAt, mode: 'server'|'static', lastRun, totals, kraje: {PHA: {name, count, deals,
  newToday, medianPrice}, …}, sources, topDeals: [kompaktní inzeráty], unlocated, newSince, demo,
  thresholds: {deal: 0.85, high: 1.15, minConfidence: 0.45, newHours: 36}}`
- `GET /data/kraj/<KOD>.json` – `{kraj, name, generatedAt, listings: [kompaktní inzeráty]}`; kompaktní klíče viz
  `src/server/data.js` (`id, s, u, t, p, pn, la, lo, g, c, k, ph, bt, b, m, y, ws, fs, mat, eb, mo, wh, gs, cond,
  e, el, eh, ec, em, d, mb, ai, fx, w, f, ps, v, st, de, pa`)
- `GET /data/kraje.geojson`
- `GET /api/listing/:id` – plný detail + historie cen (jen server)
- `POST /api/run` – spustit běh hned (jen server; vyžaduje hlavičku `X-Requested-With: kolomapa` – ochrana proti CSRF),
  `GET /api/run` – stav a průběh posledního běhu. Server i `tools/run.js` sdílí zámek `<db>.run-lock`.

„Výhodné“ = `deal_ratio ≤ 0.85` a `est_confidence ≥ 0.45`; `deal_ratio` počítá nacenění z AI odhadu, je-li aktuální,
jinak z odhadu modelu.

## Prohlížeč pro zdroje za Cloudflare (`src/sources/browser.js`)

`getBrowser({config, log})` → sdílená instance (Playwright Chromium, líně spuštěná při prvním použití; když
`playwright` není nainstalovaný, vyhodí srozumitelnou chybu a zdroj se pro běh přeskočí), `closeBrowser()` po běhu.
Cesta k prohlížeči `KOLOMAPA_BROWSER`, další argumenty `KOLOMAPA_BROWSER_ARGS`, proxy z `HTTPS_PROXY`.
