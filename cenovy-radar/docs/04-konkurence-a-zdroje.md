# 04 — Disivo, konkurence, náš web, Pohoda a Heureka (technická rešerše)

Vše získáno pouze čtením (GET, vyhledávání) 15. 9. 2026. Dotazy šly přes datacentrovou IP,
takže „403 Cloudflare“ znamená blokaci z datacentra, ne nutně blokaci běžného prohlížeče
(a totéž bude platit pro náš server 172.18.9.31).

## ⚠️ Nález k okamžitému řešení (mimo rámec projektu)

`https://www.koloshop.cz/xml-new/CZE/disivo.xml` (57 MB, regenerace denně ~7:58) je
**veřejně dostupný bez tokenu** a obsahuje `PURCHASEPRICE_VAT` (nákupní ceny), skladové stavy
po prodejnách (`STOCK_LVL_TEPLICE`, `STOCK_LVL_PRAHA`, `STOCK_LVL`), `GOODS_HEALTH` (N),
ABC klasifikaci a `MAX_LIMIT`. Kdokoli si tak stáhne naši marži po položkách. Ověřeno
15. 9. 2026 8:14 (HTTP 206 na rozsahový GET, první položka `STEMCAPRED1`, PRICE_VAT 427,
PURCHASEPRICE_VAT 322).

Doporučení (řeší Fameless/František, **my nic neměníme**): tajný token v URL nebo basic auth
nebo IP allowlist pro Disivo; Disivo umí stahovat z URL s tokenem. Stejně chránit i budoucí
feed pro náš nástroj. Veřejné feedy `heureka.xml` (172 MB), `zbozi.xml`, `google.xml`
nákupní ceny neobsahují, tam je to v pořádku.

Druhý bod k ověření: web běží za anti‑bot vrstvou **Anubis** (techaro.lol). User‑agent
Googlebot z cizí IP dostává JS výzvu „Making sure you're not a bot“. To může být správně
(Anubis ověřuje Googlebot podle IP), ale stojí za kontrolu v Google Search Console, že
indexace neklesá. Prostý UA bez „Mozilla“ dostane plnou stránku (1 MB).

## 1. Disivo — co umí a co nahrazujeme

- Česká SaaS platforma pro cenotvorbu (od 2020), v r. 2025 koupila od Heureka Group
  monitorovací nástroj **Azor**. Cílí na e‑shopy s 10 000+ produkty.
- **Monitoring konkurence**: weby konkurentů a distributorů, Google Shopping, Heureka, Amazon,
  Allegro, Idealo. Deklarované párování 99 %, „Similar Product AI Matcher“. Data o konkurenci
  se importují **5:00 a 12:00**, produktový feed 10 min před každou lichou hodinou, GA ve 3:00,
  transakční feed 2:00/3:30.
- **Repricing**: Skupiny → Pravidla → Cenové modely, Marketingové akce, Manuální přecenění
  (priorita: manuální > akce > pravidlo). Upozornění proti extrémnímu přecenění, audit log,
  Omnibus (`PRIORPRICE_VAT` = nejnižší cena za 30 dní).
- **Produkty**: přehled s volitelnými sloupci, detail s cenami konkurence a historií, export
  tabulky do CSV. AI copilot „Aila“, BI integrace na vyžádání, týdenní report.
- **Imprese** v dokumentaci nejsou; výkonová data bere z Google Analytics a transakčního feedu
  → naše „imprese“ jsou sloupce z Disivo exportu produktů (GA data), po odchodu je nahradíme
  přímo z GA4 (r01sales už má `core/ga4.py`).
- **Import** = produktový XML „Heureka‑like“ (`<SHOP><SHOPITEM>`). **Náš feed** obsahuje:
  `ITEM_ID, PRICECHECK, SALE, PRODUCTNAME, URL, IMGURL, PRICE_VAT, PURCHASEPRICE_VAT,
  LISTPRICE_VAT, VAT, MANUFACTURER, EAN, CATEGORYTEXT, SEASON, DAYS_IN_STOCK, ABCO30/90/180/360
  (+_CISLA), GOODS_HEALTH, PART_NUMBER, STOCK_LVL_TEPLICE, STOCK_LVL_PRAHA, STOCK_LVL,
  MAX_LIMIT, ITEMGROUP_ID`. To je hotový **vnitřní kontrakt** pro náš ingest (stejný soubor
  může krmit nový nástroj).
- **Export cen** = po schválení CSV, řádek = produkt: `ITEM_ID, NAME, RECOMMENDEDPRICE_VAT
  (nová cena), PURCHASEPRICE_VAT, PRICE_VAT (předchozí cena), RULE_NAME, GROUP_NAME,
  SUBGROUP_NAME` (+ `PRIORPRICE_VAT`). Dostupný „z API (URL, kterou si systém automaticky
  stáhne)“ nebo ručně. Automatické schvalování nastavuje podpora. (Exporty, které parsuje
  r01sales — `text_ITEM_ID`, `float_PRICE_VAT`, `performance.days_*` — jsou exporty
  *tabulky produktů*, ne cenový export.)
- **Veřejná API dokumentace neexistuje**; vše přes account managera.
- **Ceník**: monitoring „od 199 €/měsíc“, plná platforma na poptávku; kritika trhu (Conviu,
  Foxentry): netransparentní cena, každou úpravu řeší podpora, data o konkurenci standardně
  2× denně.

## 2. Konkurence — technický přehled (CZ + DE)

| Doména | Platforma | robots.txt: produkty povoleny? | JSON‑LD gtin/mpn | Anti‑bot | Veřejný feed |
|---|---|---|---|---|---|
| kupkolo.cz | vlastní (WPJ.cz, GraphQL, BunnyCDN) | ano (blok jen /uzivatel, /graphql, /prihlaseni, /registrace); sitemap_products 1–6 | Product: sku, **gtin13** (pozor: hodnoty `400000027753` = interní pseudo‑EAN) | ne | nenalezen |
| cyklospeciality.cz | vlastní (WPJ.cz, stejný engine) | ano; sitemap.xml | pravděpodobně jako kupkolo | ne | nenalezen |
| bikero.cz | vlastní (IIS/ASP.NET) | ano; sitemap‑1029_products.xml | Product: identifier, sku, `gtin8` (chybně pojmenovaný EAN) | ne | nenalezen |
| kolokram.cz | stejný engine jako bikero | ano | ProductGroup/Product: sku, gtin12 | ne | nenalezen |
| velosport.cz | **Shoptet** | ano (blok /export/, /api/) | Product: sku, productID, **gtin13** | ne | `/heureka/export/products.xml`, `/google.xml` |
| kola‑bbm.cz | **Shoptet** | ano | sku, productID (gtin13 jen když je EAN) | ne | `/zbozi.xml`, `/heureka/export/products.xml`, `/google.xml` |
| bikemax.cz | **Shoptet** | ano | sku, productID, **gtin13** | ne | `/heureka/export/products.xml`, `/google.xml` |
| bikeforce.cz | Eshop‑rychle | ano, `Crawl-delay 2` | Product: sku, **gtin**, ean | ne | nenalezen |
| cyklopoint.cz | vlastní ASP | ano | neověřeno (sitemap 404) | ne | – |
| mtbiker.sk | vlastní | ano (Crawl‑delay 5 pro AI boty) | neověřeno | **Cloudflare** 403 z DC | – |
| sportisimo.cz | vlastní | ano, zakázány filtry a srovnání | neověřeno | **Cloudflare** 403 z DC | – |
| kola‑radotin.cz | vlastní (vícejazyčné sitemapy) | ano, bloky parametrů | neověřeno | **Cloudflare** 403 z DC | – |
| bike‑discount.de | Shopware 6 | Googlebot: blok `/detail/`, `/search` | neověřeno dnes (r01sales: JSON‑LD + UPC) | **Cloudflare** 403 z DC (r01sales v 7/2026 procházel) | 12 sitemap vč. CS |
| bike24.com | vlastní | 403 i na robots | – | **Akamai** | – |
| alza.cz | vlastní | 403 i na robots | – | **Cloudflare + vlastní** | – |
| decathlon.cz | vlastní | – | – | **Cloudflare managed challenge** | – |
| bikester.cz | neodpovídá (insolvence 2023) | – | – | – | – |
| cykloswec.cz, bikefun.cz, ciclissimo.cz, profibike.cz, superkolo.cz | nedostupné přes proxy / chybný TLS | neověřeno | | | |

Dosud neověřené domény z našeho seznamu konkurentů (Sheet „disivo – cílení na konkurenci“,
8/2026): mojekolo.cz, sterbabike.cz, ramala.cz, kursport.cz, axit.cz, bikefrodl.cz, spoke.cz,
hupnakolo.cz, cyklodiskont.cz, global‑sport.cz, albie.cz, tsbohemia.cz, bike‑eshop.cz,
heliasport.cz, elementstore.cz, vseprokolo.cz, holokolo.cz, cykloskoda.cz, kolor.cz,
pulsmetry.cz, akumo.cz, ekolo.cz, cyklomira.cz, halbich.cz, m1sport.cz + outdoor/zima
(rockpoint.cz, hudy.cz, 4camping.cz, sportega.cz, harfasport.cz, …). Ověření robots/JSON‑LD
je součást fáze 0/2 (skript, ne ruční práce).

**Závěry:**
- **Shoptet obchody** (velosport, kola‑bbm, bikemax) jsou nejsnazší: veřejný Heureka/Google
  XML s `ITEM_ID`, `PRICE_VAT`, `EAN` + JSON‑LD gtin13. Jeden GET na celý katalog, žádný
  crawl.
- **Vlastní CZ platformy** (kupkolo, bikero, kolokram, cyklospeciality) mají sitemapy + JSON‑LD,
  ale EAN je nespolehlivý (pseudo‑EAN, chybné typy) → validovat GS1 a párovat i přes MPN/název.
- **Velcí hráči** (Alza, Decathlon, bike24, bike‑discount, Sportisimo, MTBIKER) jsou za
  Cloudflare/Akamai a z datacentra neprůchodní. Legální cesty: **Heureka Bidding Data API**
  (§ 5), Google Shopping, případně dohoda o feedu. Neobcházet.
- Pro DE/AT je proto realistický start: bike‑discount (pokud projde z naší IP; v r01sales
  fungoval), mtbiker.de/sk (Cloudflare — ověřit z naší IP), bike‑components.de, fahrrad.de,
  rosebikes.de, bikeinn — **ověřit ve fázi 0** skriptem z 172.18.9.31, ne z datacentra.

## 3. koloshop.cz (read‑only)

- Platforma: vlastní řešení (Nette, „Pro‑idea s.r.o.“), nginx; mutace .sk, .pl, 24.de, 24.at,
  24.com.
- robots.txt blokuje /pujcovna, /muj‑koloshop, /objednavka, /vyhledavani, /admin a filtrační
  parametry; sitemapy `/xml-new/CZE/` (**sitemap‑products.xml = 30 945 URL**).
- JSON‑LD produktu: `Product` s `sku`, `mpn`, **`gtin13`**, `brand`, `offers` (price,
  availability, priceValidUntil). Sami vystavujeme EAN i MPN → dobrý základ pro párování
  a zároveň připomínka, že totéž od nás čtou konkurenti.
- Veřejné feedy: `heureka.xml` (172 MB; ITEM_ID, EAN, PRODUCTNO, PRICE_VAT, DELIVERY…),
  `zbozi.xml`, `google.xml` (g:gtin, g:mpn), `SVK/heureka.xml` a **`disivo.xml`** (viz nález).
- Heureka: obchody.heureka.cz/koloshop‑cz — 4,8/5, ~13 700 recenzí; Zboží.cz 97 %.

## 4. Pohoda (Stormware) — čtení a zápis cen

- **mServer**: vestavěný HTTP server Pohody (POHODA/SQL/E1), vyžaduje **dedikovanou instanci
  Pohody** (v síťové licenci fakticky další licence + Windows stroj). `POST /xml`,
  `Content-Type: text/xml`, hlavička `STW-Authorization: Basic …`; zpracovává **sekvenčně**;
  uživatel potřebuje právo „Datová komunikace“.
- **Čtení zásob**: `lStk:listStockRequest` (list_stock.xsd) → `stockHeader`: `code, EAN, PLU,
  name, storage (členění), typePrice (cenová skupina), weightedPurchasePrice, purchasingPrice,
  sellingPrice, count, countIssue, reservation, supplier, producer, limitMin/Max…`;
  **cenové hladiny** `stockPriceItem/stockPrice{ids, price}`.
- **Zápis cen**: `stk:stock` `actionType update` podle `code`/`EAN`/`extId`, mění
  `sellingPrice` nebo konkrétní `stockPrice`. Pricing Fox posílá jen přeceněné položky každé
  4 h. Pozor: při nesouhlasu IČO Pohoda tiše nic nezmění.
- Alternativa pro čtení: přímé SQL (POHODA SQL/E1) — pro read‑only export ceníku nejjednodušší;
  dnes to nahrazuje denní e‑mail s XLSX exporty, který stačí pro v1.
- Doporučení: ceny **číst** z exportu/SQL, **zapisovat** do Pohody až po rozhodnutí vedení
  (stejné pravidlo jako ve Feed Hubu: zápis přes mServer je samostatné rozhodnutí). V1 píše
  ceny jen do admina webu (jako Disivo dnes).

## 5. Heureka / Zboží.cz — API a podmínky

- **Heureka Bidding Data API** (api.heureka.group/bidding/docs): REST/JSON,
  `GET /v1/bidding/products/{productId}` s hlavičkou `x-hg-portal: heureka.cz`. Vrací detail
  produktu z katalogu vč. **nabídek všech obchodů (název obchodu, cena, dostupnost)**. Heureka ji
  označuje za **„náhradu za crawlování detailů produktů“**. Placeno měsíčně dle tarifu a počtu
  volání, ceník neveřejný, jen CZ/SK. Toto je legální cesta k cenám velkých hráčů (Alza,
  Decathlon, Sportisimo) a k long‑tailu — kandidát pro rozhodnutí v otázce 3 (05).
- **Sortiment report** (admin obchodu): zdarma pro PPC obchody, XLS/CSV, max 32 000 produktů,
  1× za hodinu; počet konkurentů, naše cenová pozice, popularita — **bez jmen konkurentů**.
- **Podmínky Heureky (od 1. 7. 2026)**: zákaz robotů, crawlerů a scraperů, výjimka jen pro
  veřejné vyhledávače → web heureka.cz nescrapovat.
- **Zboží.cz**: původní Zboží API končí 16. 3. 2026, náhrada Sklik API Fénix — ceny konkurence
  neposkytuje.

## Zdroje
- Disivo: https://www.disivo.com/ · https://www.disivo.com/pricing/ · https://help.disivo.com/disivo-data-flow · https://help.disivo.com/export-příprava-a-schvalování-přeceněných-cen · https://help.disivo.com/propojení-shoptet-a-disiva · https://help.disivo.com/products-section · https://help.disivo.com/cheapest-price-in-30-days-eu-directive-98-6-es
- Trh: https://www.conviu.com/blog/repricing-a-monitoring-cen-srovnani-nastroju-a-cena · https://foxentry.com/cs/blog/pruvodce-ai-nastroji-cenotrvorba · https://forbes.cz/tak-kolik-to-bude-stat-dnes-disivo-pomaha-urcit-ceny-eshopu-a-miri-k-valuaci-10-milionu-eur/
- Pohoda: https://www.stormware.cz/pohoda/xml/mserver/ · https://www.stormware.cz/pohoda/xml/mserver/provyvojare/ · https://www.stormware.cz/xml/schema/version_2/stock.xsd · https://www.stormware.cz/xml/schema/version_2/list_stock.xsd · https://pricing-fox.cz/clanky/pohoda-mserver-napojeni-cenotvorby
- Heureka: https://api.heureka.group/bidding/docs · https://sluzby.heureka.sk/napoveda/bidding-data-api/ · https://sluzby.heureka.cz/napoveda/sortiment-report/ · https://heureka.group/cs/podminky-pouzivani/podminky-pouzivani-internetovych-stranek · https://blog.seznam.cz/2025/11/zbozi-api-konci-sjednocujeme-data-do-sklik-api/
- Přímé GET (15. 9. 2026): robots.txt, sitemapy, produktové stránky a feedy domén v tabulce; koloshop.cz feedy `/xml-new/CZE/*.xml`.
