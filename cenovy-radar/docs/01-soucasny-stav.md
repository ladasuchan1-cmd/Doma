# 01 — Současný stav (co dnes máme a kde to bolí)

Sběr informací z mailů (suchan@koloshop.cz), Google Drive, repozitářů `r01sales`, `feedhub`,
`import-web` a z veřejného webu. Nic nebylo měněno, jde čistě o čtení.
Stav k 15. 9. 2026.

## 1. Disivo — jak ho dnes používáme

| Věc | Stav |
|---|---|
| Instance | CZ (`koloshop.cz`) a DE (`koloshop24.de`); z DE cenotvorby se přebírá i AT (rozdíl DPH 1 %) |
| Tarif CZ | ~1 000 000 „searchů“ měsíčně (±10 %) |
| Spotřeba | 31 000 skladových položek × Heureka × 30 dní = 930 000; 48 000 aktivních položek na webu by bylo 1 440 000 → část položek se vůbec nehledá |
| Přímí konkurenti v Disivu (CZ) | Kupkolo 9 223 produktů, Mojekolo 8 514, Bikemax 2 988 → s Heurekou dohromady ~1 555 000 searchů, tedy 50 % nad paušál (mail „meet Disivo 11.8.“) |
| DE monitoring | Disivo scrapuje bike24, bike-discount, mtbiker.de. **Od října 2026 DE monitoring od Disiva končí** a máme si ho nahradit sami (mail „DE Disivo“, 14. 9.) |
| Heureka | Dělá cca 5 % obratu; ceny posílané na Heureku se u části produktů liší od reálných cen na webu konkurence |
| Cíl z přehledu projektů (19. 5.) | „Napojení přímého scrapingu místo Heureky“: 60–80 % produktů napojit na přímé konkurenty, zbytek nechat na Heurece; očekávaný přínos +25–33 % spárování |

### Datové toky kolem Disiva

```
Pohoda E1 ──(export / DMOC)──► Admin webu (Fameless) ──produktový feed (á 2 h; obsahuje N = "zdraví zboží",
                                        │                objednací název = web kód, DiS jen ze sSklad)──► Disivo
                                        │──transakční feed (1× denně; prodeje)──────────────────────────► Disivo
                                        ◄──export cen (CSV/XLSX; text_ITEM_ID, float_PRICE_VAT,
                                             float_PURCHASE_VAT, name, text_MANUFACTURER,
                                             performance.days_14/30/90.display|quantity) ~3:45–4:00 ─────  Disivo
                                        │
                                        └──► ceny na webu → ranní vlna marketingových feedů (Heureka, Zboží, …)
```

- Cenové strategie čtou produktový feed (á 2 h), marketingové akce transakční feed (1× denně) → akce vidí stav zásob se zpožděním až 24 h.
- Ranní vlna: export musí proběhnout do ~5:00, jinak se ceny do všech systémů propíší až další den (mail „Přecenění Heute“).
- Upozornění „významná změna ceny“ nastaveno −25 % / +25 %; po akcích blokuje tisíce položek (1 741, 3 193) k ručnímu potvrzení.
- DMOC (doporučené MOC) jsou v Pohodě; EUR DMOC nahrává František; chybné DMOC (balení vs. kus, Schwalbe) rozbíjely DE ceny.

### Známé problémy Disiva (z mailů 4–9/2026)

1. **Export se negeneruje / trvá 2 h** (7. 9. a 20. 5.) → posun marketingové akce, náklady a „nálada vedení“.
2. **Nepřecenění položky, ač splňuje pravidla** (marže 13 % > limit 10 %), bez upozornění.
3. **Kvalita párování**: „n – name“ shody párují jinou barvu/velikost, nebo vyprodanou variantu; správný produkt na Kupkolu je, ale je nedostupný → Disivo vezme podobný. Ověřovalo se ručně v tabulce od Disiva (5/2026).
4. **Kódy**: 43 položek s čárkou v kódu Disivo nebere; u variant Disivo maže `@` v kódu → špatné párování akcí.
5. **Bez automatického exportu sestav a bez historie** (odpověď supportu 10. 9.: DEV tým dělá nový monitoring, historická data zpětně asi nejdou).
6. **Změny logiky = domluva se supportem**, ne konfigurace (master produkty DE, strategie per konkurent, limity searchů „až to vývojáři udělají za 3–6 týdnů“).
7. **Kapacita searchů** dělá z monitoringu rozpočtovou položku místo technického rozhodnutí.

### Co Disivo umí a co budeme muset nahradit (KPI z týdenního reportu 7.–13. 9.)

- Počet přecenění za období (234 896), „ušetřeno“ Kč a hodin.
- Zachycená podezřelá přecenění pod spodní limit (8).
- Nevyužité příležitosti: dobře prodejné produkty bez skladu (218), příliš levné oproti mediánu konkurence −20 % a víc (6 447), produkty pod nákupní cenou (2 739), obrátkovost < 7 dní (3 580).
- Aktivita uživatelů (5 aktivních, 177 akcí).
- Strategie (per skupina produktů), marketingové akce (CSV kód + akční cena, časové okno), schvalovací systém párování, upozornění.

## 2. Co už máme postavené (a jde na to navázat)

### `r01sales` (sales.report) — záložky Scrap a Konkurence
- **`konk_scraper.py`** — ověřený scraper Kupkola: hledání podle EAN → produktová stránka (SSR) → JSON-LD `Product → offers[] (gtin13, price)`; jedna stránka nese všechny varianty; přesná česká dostupnost z datového bloku, počty kusů u nízkých zásob. Slušné chování: robots.txt, min. 2 s mezi dotazy, identifikovaný User-Agent, žádná rotace IP.
- **`de_scraper.py`** — bike-discount.de (JSON-LD + UPC→EAN13 převod); bike24.de blokuje datacentrové IP (Datadome) → nutný reálný prohlížeč z pobočkové sítě.
- **Scrap import** — umí soubory z pricewatch / SHOPSCOUT, rozlišuje **jistou** (EAN/MPN) a **nejistou** (jen název) shodu; na reálném souboru bylo 40 % shod nejistých. Pásma rozdílu, návrh akční ceny s kontrolou marže, deník změn cen konkurence (180 dní).
- **Konkurence (Kupkolo)** — párování podle EAN, prahy marže, přehled po výrobcích, `kupkolo_brands.py` (snímek značek Kupkola).
- **CZ vs DE** — parser Disivo exportu (`text_ITEM_ID`, `float_PRICE_VAT`).
- **Imprese** — import Disivo exportu impresí 14/30/90 dní, napojení přes web kód (Objednací název).
- Mailový import (IMAP): denní report `report@koloshop.cz → data@ksprehledy.cz` s `zásoby.xlsx`, `pohyby.xlsx`, `příjemky.xlsx` — **existující automatický kanál dat z Pohody**.

### `feedhub` (feeds.report) — dodavatelské feedy
- Postgres schéma `feedhub` (`feed_sources`, `feed_runs`, `supplier_offers`, `offer_history` jako delta log, `sku_map`).
- Párovací engine: **1) EAN exact, 2) kód, 3) ruční fronta „Nespárováno“**; párování podle podobnosti názvu je zakázané.
- Monitoring jako vedlejší produkt pipeline (`parse_yield`, semafor, denní e-mail).
- **Nepřekročitelná pravidla (direktiva CEO)**: všechna data na firemní infrastruktuře, žádné externí cloudy / AI API / SaaS, deterministická logika, hesla jen v `.env`.

### Skill `kupkolo-porovnani`
Porovnání scrapu Kupkola s exportem Pohody (EAN primárně, pojistka výrobce u shody přes kód/název), maržový scénář „dorovnání“ s filtrem podezřelých párů (poměr cen < 0,2 nebo > 5×).

### Infrastruktura
- Interní server `172.18.9.31` (Debian 13, Docker, Caddy s local certs, PostgreSQL 17 `ksprehledy`), aplikace `sales.report` (8010), `feeds.report` (8050), import, projekty. Nasazení přes GitHub Actions + self-hosted runner, případně ruční `deploy.sh`. Odchozí provoz povoluje František (firewall).

## 3. Data, která pro cenotvorbu potřebujeme, a kde jsou

| Data | Zdroj dnes | Poznámka |
|---|---|---|
| Kód, EAN, název, výrobce, nákupní (vážená) cena, stav po skladech (sSklad/sPRAHA/sBRNO), dodání | Pohoda export `Zásoby` (denní mail) | EAN = sloupec `Čárkód`; `Typ = Karta` |
| Prodejní cena s DPH, akční cena, DMOC | Admin webu / Disivo export | DMOC v Pohodě (CZK i EUR) |
| Web kód (Objednací název), ID varianty, aktivní, skrýt po vyprodání | Export položek z adminu | export nemá ID skupiny variant |
| Prodeje, pohyby, příjemky | Pohoda (denní mail) | základ N klasifikace (DiS, DSLS, Sales90, STC) |
| N (zdraví zboží N0–N8) | vlastní výpočet (r01sales), v produktovém feedu pro Disivo | |
| Imprese / konverze | Disivo export (ručně / mailem) | po odchodu z Disiva zdroj zmizí → náhrada GA4 / vlastní web analytika |
| Ceny konkurence | Disivo (Heureka + přímí), r01sales scrap (Kupkolo, bike-discount), SHOPSCOUT soubory | |
| Seznam konkurentů po kategoriích | Google Sheet „disivo – cílení na konkurenci“ (8/2026) | ~60 domén CZ, viz 04 |

## 4. Lidé a role (kdo bude s nástrojem pracovat)

- Láďa Suchan — sales manager, autor nástrojů, vlastník cenotvorby.
- Pavel Veselý (CSO) — akce, DE/AT ceny, kontrola exportů.
- Rostislav Přibyl (kola, zimní hardgoods), Nikola Kotyzová (soft goods), Ondřej Šenk — brand manažeři; potvrzují párování a strategie za své značky.
- Jana Lužinová (CMO), Marie Krčková (marketing) — feedy, ranní vlna, marketingové akce.
- Lenka Hlinková (PM), Jan Tančin (CEO) — schvalování, rozpočet.
- František (IT) — Pohoda, firewall, DMOC importy; Fameless — admin webu a feedy.

## 5. Shrnutí bolestí, které má nový nástroj vyřešit

1. Logika cenotvorby musí být **naše a upravitelná v kódu/konfiguraci**, ne přes support.
2. Monitoring konkurence nesmí být limitovaný „searchy“, ale technikou (feedy, JSON-LD, slušný scraping).
3. Párování musí být **auditovatelné**: každý pár nese důvod a jistotu (EAN / MPN / kód / ručně), nejisté páry nikdy nehýbou cenou automaticky.
4. Export cen musí být **deterministický a včas** (před ranní vlnou), s dry-runem a limity (marže, DMOC, spodní/horní zarážky, krok změny).
5. Historie (ceny konkurence, naše ceny, důvody změn) musí zůstat u nás a být dotazovatelná.
6. DE/AT monitoring musí fungovat od října 2026 bez Disiva.
