# Kolomapa – architektura

Node.js ≥ 22.13 (node:sqlite bez přepínače; CI testuje 22.13, 24 a Windows), CommonJS, `'use strict'`, **bez
povinných závislostí** (stejně jako `repricing/`). Volitelné:
`playwright` (Cyklobazar je za Cloudflare → potřebuje skutečný prohlížeč) a `@anthropic-ai/sdk` (AI nacenění podle fotky).
Komentáře a hlášky česky, JSDoc u exportů. Testy `node --test` (bez frameworku), offline nad fixtures v `test/fixtures/`.

```
kolomapa/
  server.js                 HTTP server (UI + JSON API) + denní plánovač
  start.cmd                 Windows: dvojklik → tools/start.js (server + otevře prohlížeč; běží-li už, jen otevře mapu)
  stahnout.cmd              Windows: Plánovač úloh → tools/run.js, výstup do data\stahovani.log
  nastaveni-vzor.txt        vzor nastaveni.txt (KLÍČ=hodnota; nastaveni.txt je v .gitignore – heslo, API klíč)
  tools/start.js            spuštění pro majitele obchodu (pozná běžící Kolomapu / cizí program na portu)
  tools/run.js              jednorázový běh (pro cron / Plánovač úloh / GitHub Actions); česká rada k chybám,
                            návratový kód 1 i když se nestáhl žádný web
  tools/export-static.js    statická verze mapy do dist/ (GitHub Pages apod.)
  deploy/                   nasazení na vlastní Linux server: instalace.sh (služba systemd + Caddy/HTTPS + zálohy),
                            aktualizovat.sh, šablony služby a proxy, návod NASAZENI.md
  deploy/docker/            server s Dockerem a Caddy (Hetzner): nasadit.sh (obraz, testy v obrazu, kontejner na síti
                            web, blok do Caddyfile, záloha), návod HETZNER.md; obraz: Dockerfile + .dockerignore;
                            workflow .github/workflows/kolomapa-nasazeni.yml (self-hosted runner, štítek kolomapa)
  tools/import-sales.js     import vlastních prodejů z POHODY (xlsx) → training/ + DB
  tools/build-geo.js        přegeneruje src/geo/data (GeoNames, ČÚZK)
  src/config.js             proměnné prostředí + nastaveni.txt; neplatné hodnoty → výchozí + české varování
                            (config.warnings); kontrola verze Node.js; tlumí ExperimentalWarning u node:sqlite
  src/db.js                 SQLite schéma (tabulky listings, price_history, sales, runs, settings)
  src/pipeline.js           denní běh: zdroje → upsert → detaily → klasifikace → geo → nacenění → zmizelé
  src/sources/{bazos,sbazar,aukro,cyklobazar}.js   scrapery (kontrakt níže)
  src/sources/index.js      registr zdrojů
  src/sources/browser.js    sdílený Chromium (Playwright) – jen pro zdroje s requiresBrowser
  src/classify/index.js     kolo × nekolo, typ kola, vytěžení údajů z textu
  src/geo/index.js          PSČ / obec / okres / kraj → souřadnice + kraj (offline data v src/geo/data)
  src/pricing/index.js      trénink modelu + nacenění všech inzerátů
  src/pricing/gbdt.js       boosting rozhodovacích stromů (druhý stupeň nacenění)
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
  defaultFullScanDays: 7,  // jak často celý průchod, pokud není nastaveno KOLOMAPA_FULL_SCAN_DAYS (jinak 1)
  async scan(ctx) { /* … await ctx.emit(item) … */ return { complete: true }; },
  async detail(ctx, listing) { return { description, params, photoUrl, … } /* nebo null = inzerát zmizel */ },
  async confirmGone(ctx, listing) { return true /* smazán */ | false /* existuje */ | null /* nevím */; }, // volitelné
};
```

`ctx`: `http` (src/util/http.js – šetrné pauzy, opakování), `getBrowser()` (jen requiresBrowser), `log`, `config`,
`signal`, `markSeen(sourceId, {refreshDetail})` (inzerát je stále aktivní – např. podle sitemapy – bez stažení; refreshDetail = web hlásí změnu), `cache` (trvalé `get/set/delete` klíč → JSON pro daný zdroj, např. přeložené lokality), `mode` (`'full'` = projít celý výpis, `'incremental'` = skončit, když 3 stránky po sobě přinesou jen známé
inzeráty bez změny ceny – pozor na topované inzeráty nahoře), `maxPages`, `minPrice`, `isKnown(sourceId)`,
`emit(item) → {isNew, changed}`.

`complete: true` vracet jen při `mode === 'full'` a úspěšném průchodu celého výpisu všech kategorií – pak pipeline
označí neviděné inzeráty jako zmizelé (prodané/smazané): hned, pokud to zdroj potvrdí přes `confirmGone`, jinak až když
chybí ve dvou úplných průchodech po sobě (offsetové stránkování se během průchodu posouvá).

Pravidla webů: zdroj stahuje jen adresy, které povoluje `robots.txt` webu (Bazoš i Cyklobazar to hlídají funkcí
`assertAllowed(url)` před každým požadavkem), představuje se poctivým User-Agentem (`KOLOMAPA_USER_AGENT`, výchozí
`Kolomapa/1.0` s odkazem na projekt) a ověření „nejste robot“ nikdy neobchází (blokace → konec zdroje pro běh).
Ve výchozím stavu je zapnutý jen Bazoš (`KOLOMAPA_SOURCES`); Sbazar (`Disallow: /` pro všechny), Aukro (blokuje
ClaudeBot) a Cyklobazar (Cloudflare) zapíná provozovatel.

Trvalá cache zdrojů (`ctx.cache`, tabulka settings, klíče `cache:<zdroj>:…`): Sbazar ukládá přeložené lokality
(`loc:<typ>:<id>`), Cyklobazar `cooldownUntil` (pauza 12 h po ověření Cloudflare), `newHorizonAt`, `newestPostedAt`,
`sweep`, `sweepDoneAt`, `sitemapCount`, `sitemapLow`.

## Klasifikace (`src/classify`)

`classifyListing({source, title, description, params, categorySrc, priceCzk, sellerType}, {now?})` →
`{isBike, bikeType, reason, features}`; export `CLASSIFIER_VERSION` (zvýšit při změně logiky → překlasifikuje se vše).
Soubory: `index.js` (rozhodnutí + typ), `extract.js` (rok, kola, rám, materiál, motor, baterie, sada, stav, původní cena…),
`keywords.js` (nekola, služby, poptávky), `brands.js` (≈ 220 značek: tier, aliasy/překlepy, nápovědy typu podle modelu).

Rozhodnutí kolo × nekolo stojí na titulku: fráze „na kolo / pro kola / za kolo / na díly / s košíkem“ se zamaskují,
pak vyhrává to, co je v titulku dřív – „nekolo“ podstatné jméno (helma, sedačka, nosič, vidlice, trenažér, koloběžka,
motorka …) nebo silný důkaz kola (kolo, elektrokolo, MTB, BMX, odrážedlo, značka + známý model). „Koupím / sháním“ →
`isBike: false, reason: 'poptávka'`; půjčovna/servis → služba; „zapletená / přední kola“ → díl; „Rám …“ → kolo s
`isFrameOnly`. Bez důkazů v titulku rozhoduje začátek popisu a kategorie webu („Ostatní“ = spíš nekolo).
`params` (Cyklobazar, Aukro, Sbazar) mají přednost; klíče se porovnávají bez diakritiky a velikosti písmen
(`Velikost rámu`, `Rok výroby`, `Stav`/`Stav zboží`, `Značka`, `Model`, `Materiál rámu`, `Průměr kol`, `Odpružení` …).

`bikeType`: `mtb_hardtail | mtb_full | road | gravel | cyclocross | trekking | cross | city | kids | balance | bmx | dirt | fatbike | folding | cargo | tandem | ebike_mtb | ebike_mtb_full | ebike_trekking | ebike_city | ebike_road | ebike_cargo | ebike_kids | other`.

`features` (vše volitelné): `brand`, `brandTier` (1–5), `model`, `modelYear` (2005–letos+1), `ageYears`, `yearSource`
(`params|explicit|title|purchase|age|text`), `vintageYear` + `isVintage` (retro), `wheelSize` (`12…29`, `27.5`; 650b → 27.5,
700c → 28), `mullet`, `kidsWheel`, `frameSize` (`XS…XXL`, normalizované z cm/palců/S1–S6) + `frameSizeRaw`,
`material` (`carbon|alu|steel|titanium`), `suspension` (`rigid|hardtail|full`), `isEbike`, `motor`, `motorClass`
(`premium|mid|hub`), `batteryWh`, `groupset`, `groupsetTier` (1–6, +0,5 za Di2/AXS), `electronicShifting`, `condition`
(`new|like_new|very_good|good|fair|poor|parts`, s negací „není poškozené“), `originalPriceCzk`, `hasReceipt`, `warranty`,
`isShop`, `isFrameOnly`, `isMulti` (více kol v inzerátu), `pricePlaceholder` (cena < 300 Kč), `nonBikeGroup` (u nekol),
`warnings` (české texty: „Možná ukradené – chybí doklad a cena je podezřele nízká“, „Prasklý rám“, „Nutný servis“,
„Cena je za díly“, „Prodává se jen rám“, „Více kol v jednom inzerátu…“, „Bez baterie“ …).

## Nacenění (`src/pricing`)

- `trainModel(db, {config, log})` → model s `summary` (`mode: 'model'|'rules'`, počty, `calibration`, `buyRatio`, `ms`).
  Robustní (Huberova) ridge regrese log(ceny) nad inzeráty kol z DB (aktivní i zmizelé; zmizelé = pravděpodobně prodané,
  váha 1,3; placeholdery, „více kol“ a extrémy se vynechají). Příznaky: typ, tier, značka, sada, stáří, materiál, motor a
  baterie e-kol, velikost kol, stav, původní cena, příznaky (rám, obchod, retro …) a slova z titulků (modely). Pod 300
  použitelných kol jen pravidla z `kb.json`. Kalibrace inzerovaná → skutečná cena: medián skutečná/odhad u BAZAR prodejů
  (tabulka `sales`, jinak `training/koloshop-prodeje.json`) kombinovaný s `kb.askToSale` (0,9), oříznutý na 0,6–1,1.
  Druhý stupeň (od 1 000 použitelných kol): boosting rozhodovacích stromů (`gbdt.js`, bez závislostí) nad zbytkovou
  chybou prvního stupně, učený na odložených odhadech interní 3× CV. Vstupy: odhad 1. stupně, rozdíl proti srovnatelným,
  pravidlům, původní ceně a podobným titulkům (k nejbližších podle vážených slov – i bez shody značky a modelu) a
  vlastnosti kola. Inzeráty z trénovacích dat (všechny aktivní) nacení třetina modelu, která je neviděla
  (cross-fitting: `model.cross`), aby odhad neopisoval vlastní cenu inzerátu. Trénink ~40 s, nacenění 25 tis.
  inzerátů ~11 s.
- `estimate(model, listing)` → `{estCzk, low, high, confidence, method: 'comps'|'model'|'rules', factors}`. Odhad =
  model + posun podle srovnatelných inzerátů (stejná značka a model ± rok) + malá váha pravidel + druhý stupeň;
  `low/high` = 10./90. percentil chyb na odložených datech (interní 3× CV) podle třídy důkazů a rodiny kola
  (horská / silniční / e-kola / dětská / ostatní); `confidence` = odhadnutá pravděpodobnost, že
  inzerovaná cena srovnatelného kola leží v ±35 % odhadu (≈ ±25 % proti skutečné hodnotě) → práh 0,45 odděluje
  identifikovaná kola (značka + model / rok / srovnatelné) od obecných inzerátů.
- `priceAll(db, model, {config})` zapíše `est_*`, `est_at`; `deal_ratio = price_czk / ref` a `max_buy_czk = ref × výkupní
  poměr`, kde `ref` = `ai_czk`, pokud je AI odhad aktuální (`ai_input_hash = content_hash`), jinak `est_czk`. Výkupní poměr
  = 1 − `KOLOMAPA_BUY_MARGIN`, jinak medián cost/price BAZAR prodejů (≈ 0,65). U placeholder cen a „více kol“ se
  `deal_ratio` nepočítá; nekolům se odhady smažou. `refreshDeal(db, id)` přepočítá jeden inzerát (volá ho AI).
- `comparables(model, listing, n)` → srovnatelné inzeráty `{title, price, url, sold, year}` (pro AI a UI).
- AI (`ai.js`, jen s `ANTHROPIC_API_KEY` a `npm install @anthropic-ai/sdk`): `valuatePending(db, {config, log, signal, model})`
  vybere aktivní kola s fotkou a cenou ≥ `KOLOMAPA_AI_MIN_PRICE`, jejichž obsah se změnil (`ai_input_hash ≠ content_hash`),
  nejdřív potenciálně výhodné (nízký `deal_ratio`) a čerstvé, max. `KOLOMAPA_AI_MAX_PER_RUN`, 3 souběžně. Pošle Claude
  (výchozí `claude-opus-5-5`, effort low, JSON schéma, system prompt s tabulkou vlastních prodejů v cache, server-side
  fallback při odmítnutí) titulek, popis, parametry, fotku, vytěžené údaje, odhad modelu a srovnatelné inzeráty →
  `{estimate_czk, low_czk, high_czk, condition, condition_from_photo, notes, is_bike, bike_type}`; uloží `ai_*`
  (+ `ai_model`, `ai_at`, `ai_input_hash`) a přepočítá `deal_ratio`/`max_buy_czk`. `est_*` zůstává odhadem modelu.
- `tools/eval-pricing.js` – evaluace klasifikátoru a nacenění na stažených datech (5× CV, vlastní prodeje).

## API serveru (stejné tvary vrací statický export)

- `GET /data/summary.json` – `{generatedAt, mode: 'server'|'static', lastRun, totals, kraje: {PHA: {name, count, deals,
  newToday, medianPrice}, …}, sources, topDeals: [kompaktní inzeráty], unlocated, newSince, demo,
  thresholds: {deal: 0.85, high: 1.15, minConfidence: 0.45, newHours: 36}}`
- `GET /data/kraj/<KOD>.json` – `{kraj, name, generatedAt, listings: [kompaktní inzeráty]}`; kompaktní klíče viz
  `src/server/data.js` (`id, s, u, t, p, pn, la, lo, g, c, k, ph, bt, b, m, y, ws, fs, mat, eb, mo, wh, gs, cond,
  e, el, eh, ec, em, d, mb, ai, fx, w, f, ps, v, st, de, pa`)
  Statický export (`tools/export-static.js`) je ve výchozím stavu veřejný: bez `mb`, `ai.n` a faktoru kalibrace na
  vlastní prodeje (`publicListing` v `src/server/data.js`); `--interni` / `KOLOMAPA_STATIC_INTERNAL=1` je ponechá.
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

## Provoz (Windows, majitel obchodu)

- Provozní vstupní body (server.js, tools/start|run|import-sales|export-static|demo-data|try-source) načtou jako
  první `src/config.js`: ten při starší verzi Node.js skončí českou hláškou, načte
  `nastaveni.txt` do `process.env` (proměnné prostředí mají přednost; při `node --test` se soubor nečte) a vypne
  „ExperimentalWarning: SQLite …“. Relativní cesty v nastavení se berou vůči složce `kolomapa` (Plánovač úloh startuje
  v `C:\Windows\System32`).
- `loadConfig(process.env)` vrací `warnings` a každé vypíše jednou do logu; `loadConfig(objekt)` (testy) jen vrací.
- `tools/run.js`: 0 = ok / částečně, 1 = chyba, busy, nebo žádný zdroj nic nestáhl (pipeline v tom případě hlásí
  `partial`). Souhrn je v místním čase a ke známým chybám přidá radu („→ Nefunguje internet …“).
- Zámek běhu `<db>.run-lock` (PID + jméno počítače): `tools/run.js` ho uvolní i při zavření okna (SIGHUP) a Ctrl+Break.

