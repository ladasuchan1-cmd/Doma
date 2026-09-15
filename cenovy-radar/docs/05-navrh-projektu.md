# 05 — Návrh projektu „Cenový radar“ (náhrada Disiva)

Pracovní název navazuje na Sales Radar / Feed Hub / Cashflow radar. Doména `ceny.report`
na interním serveru, stejný stack a stejná pravidla jako Feed Hub (direktiva CEO: data
u nás, žádné externí AI API a SaaS, deterministická logika, hesla v `.env`).

## 1. Cíl a hranice

**Cíl:** vlastní systém, který (a) sbírá ceny konkurence legálně a slušně, (b) páruje je
na náš sortiment auditovatelně, (c) navrhuje a exportuje ceny podle *našich* pravidel
(marže, N, konkurence, DMOC, akce), (d) hlídá a reportuje — a to bez limitu „searchů“.

**Mimo rozsah v1:** změna admina webu (import cen zůstane ve formátu, který admin
už umí od Disiva), řízení nákupu (to je Obra 3.0), Heureka bidding.

**Klíčové rozhodnutí:** admin dnes umí importovat cenový export Disiva. Náš export bude mít
**stejné sloupce** (`ITEM_ID, NAME, RECOMMENDEDPRICE_VAT, PURCHASEPRICE_VAT, PRICE_VAT,
RULE_NAME, GROUP_NAME, SUBGROUP_NAME, PRIORPRICE_VAT`) → na straně Fameless/admina se nic
nemění, přepnutí je jen změna zdroje souboru. Stejně tak **vstup**: produktový feed
`disivo.xml`, který admin už generuje (ITEM_ID, EAN, PART_NUMBER, PRICE_VAT,
PURCHASEPRICE_VAT, GOODS_HEALTH, STOCK_LVL_*, ITEMGROUP_ID…), je hotový kontrakt pro náš
ingest — jen musí být chráněný tokenem (viz nález v 04). Ověřit s Davidem (Fameless), zda
admin export načítá z URL, nebo se nahrává ručně (viz otevřené otázky).

## 2. Architektura

```
                 ┌────────────────────────── ceny.report (FastAPI + vanilla JS, port 8060) ──────────────────────────┐
                 │                                                                                                    │
 Pohoda (denní   │  INGEST            COLLECT (konkurence)          MATCH                 PRICE ENGINE        OUT     │
 mail zásoby/    │  ┌──────────┐      ┌─────────────────────┐      ┌───────────────┐     ┌──────────────┐  ┌──────┐ │
 pohyby) ───────►│  │ products │      │ adaptéry per zdroj: │      │ T1 EAN        │     │ strategie    │  │export│ │
 Admin export    │  │ prices   │      │  jsonld_page        │ raw  │ T2 MPN+značka │     │ (YAML/DB)    │  │ CSV  │─┼─► admin
 položek ───────►│  │ stock    │──┐   │  sitemap_crawl      │──►DB │ T3 kód/SKU    │──►  │ zarážky      │  │      │ │   (stejný
 Disivo export   │  │ N, DMOC  │  │   │  search_by_ean      │      │ T4 kandidáti  │     │ dry-run/diff │  │alert │ │   formát
 (přechodně) ───►│  └──────────┘  │   │  file_upload        │      │  → fronta     │     │ schválení    │  │mail  │ │   jako
                 │                └──►│  (playwright — jen  │      │  k ověření    │     │ vysvětlení   │  │report│ │   Disivo)
                 │                    │   se souhlasem)     │      └───────────────┘     └──────────────┘  └──────┘ │
                 │                    └─────────────────────┘                                                       │
                 │  Postgres 17, schéma `pricing` v DB ksprehledy · APScheduler · raw HTML na volume (30 dní)        │
                 └────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Zásady převzaté z Feed Hubu: raw se ukládá vždy před parsováním; každý běh zapisuje
metriky (`parse_yield`, počty, chyby); tolerantní parser (chybějící pole = NULL + čítač,
nikdy pád celého běhu); delta log místo snapshotů.

### 2.1 Moduly

| Modul | Co dělá | Z čeho vychází |
|---|---|---|
| **ingest** | produktový feed z adminu (`disivo.xml`, á 2 h) + denní Pohoda (zásoby, pohyby) pro nákupní ceny a N; DMOC | `r01sales` mail import, `build_data.py`, existující feed |
| **collect** | plánované stahování cen konkurence per zdroj (adaptér + konfigurace v DB), slušný fetcher (robots, rate‑limit, UA s kontaktem, noční okna), raw storage, monitoring zdroje | `konk_scraper.PoliteFetcher`, `de_scraper`, feedhub `ingest.py` |
| **match** | párování nabídek konkurence na naše kódy ve vrstvách T1–T4, `match_map` s důvodem a jistotou, fronta k ručnímu ověření, trvalé ruční páry, blokace špatných párů | feedhub `sku_map`, r01sales „jistá/nejistá“ shoda, skill kupkolo‑porovnani (podezřelé páry) |
| **price** | výpočet návrhu ceny per položka podle strategií a zarážek, dry‑run, diff proti aktuální ceně, schvalování, export | Disivo strategie (co replikujeme), r01sales „akční cena a marže“ |
| **actions** | marketingové akce (seznam kódů + akční cena / sleva, okno od–do, priorita nad strategií, automatický konec, kontrola zásoby) | dnešní Disivo akce (CSV) |
| **alerts / reports** | upozornění (podezřelá změna, pod nákupní cenou, chybějící zdroj), denní e‑mail 7:00, týdenní KPI (stejné jako Disivo report), historie | feedhub monitoring |
| **ui** | dashboard, detail produktu s konkurencí, fronta párů, editor strategií, simulace, exporty, uživatelé/role | r01sales SPA vzor, `core/htmlpage.py` |

### 2.2 Datový model (schéma `pricing`)

```
products        kod PK, ean, mpn, nazev, vyrobce, kategorie_1/2/3, web_kod, variant_group,
                nakupni_bez_dph, dmoc_czk, dmoc_eur, n_kategorie, stav_teplice/brno/praha,
                dodani_dni, aktivni, updated_at
our_prices      kod, trh (CZ|DE|AT), cena_s_dph, akcni_cena, platnost_od, zdroj (admin|export), updated_at
sources         id, name, domain, trh, type (jsonld_page|sitemap_crawl|search_by_ean|file_upload|browser),
                config JSONB (url vzory, selektory, xpath, min_delay, okno), active, contact_note, robots_ok
runs            source_id, started_at, duration_ms, pages, items, items_with_price, parse_yield,
                status ok|warn|fail, error, raw_path
offers          source_id, ext_id (URL/SKU), ean, mpn, brand, name, price, currency, price_czk,
                availability (skladem|u_dodavatele|nedostupne|neznamo), qty, url, seen_at, first_seen
offer_history   offer_key, price_old, price_new, avail_old, avail_new, changed_at   -- jen změny
match_map       kod, source_id, ext_id, method (ean|mpn|code|manual|candidate), confidence 0–1,
                status (auto|confirmed|rejected|pending), created_by, created_at, note
strategies      id, name, scope JSONB (kategorie/značky/N/kódy), rules JSONB, priority, active, trh
price_runs      id, trh, started_at, mode (dry|live), items, changed, blocked, approved_by, export_path
price_proposals run_id, kod, cena_puvodni, cena_nova, duvod TEXT, strategie_id, konkurent_ref,
                blokace (min_marze|dmoc|krok|bez_konkurence|…), stav (navrh|schvaleno|zamitnuto|exportovano)
actions         id, name, trh, od, do, priorita, rules JSONB, created_by
action_items    action_id, kod, akcni_cena, sleva_pct, min_marze
alerts          id, typ, kod/source_id, payload JSONB, created_at, resolved_at, resolved_by
```

## 3. Sběr cen konkurence (collect)

Pořadí zdrojů podle „technické čistoty“ — vždy volíme nejčistší dostupný způsob:

1. **Strukturovaná data na produktové stránce** (JSON‑LD `Product/Offer` s `gtin13`/`mpn`/`price`) — zjišťovat 1 GET na produkt, jedna stránka obvykle nese všechny varianty. Kupkolo, bike‑discount ověřeno; ostatní viz 04.
2. **Sitemap crawl** — noční objevení URL produktů (`sitemap.xml`), pak jen produkty ve značkách, které vedeme (průnik značek), s cache `Last‑Modified`/ETag.
3. **Vyhledávání podle EAN** na webu konkurenta — jen tam, kde není sitemap; dražší (2 dotazy na položku).
4. **Veřejné feedy konkurentů** — Shoptet obchody (velosport, kola‑bbm, bikemax) vystavují
   Heureka/Google XML s ITEM_ID, PRICE_VAT a EAN: jeden GET na celý katalog, žádný crawl.
5. **Heureka Bidding Data API** (placené, oficiální „náhrada za crawlování“) — jediná legální
   cesta k cenám velkých hráčů za Cloudflare (Alza, Decathlon, Sportisimo) a k long‑tailu;
   rozhodnout podle ceníku (otázka 3).
6. **Soubory** (SHOPSCOUT, pricewatch, tabulky od dodavatelů) — ruční upload, stejná pipeline.
7. **Prohlížeč (Playwright)** — pouze u čistě JS webů bez anti‑bot ochrany a **jen po rozhodnutí vedení** (viz 02 a 06 — obcházení Cloudflare/Akamai/Datadome nedoporučujeme; alternativa je zdroj vynechat, Bidding API, nebo si vyžádat feed).

Pravidla fetcheru (kód už existuje v `konk_scraper.PoliteFetcher`, rozšířit):
- respektovat `robots.txt` včetně `Crawl-delay`; při `Disallow` produktových stránek zdroj nepoužívat;
- min. 2 s mezi dotazy na jednu doménu, 1 souběžné spojení na doménu, noční okno 23:00–5:00 pro plné běhy, přes den jen inkrementy;
- `User-Agent` s názvem a kontaktem (`KoloshopPriceMonitor/1.0 (+https://www.koloshop.cz; suchan@koloshop.cz)`), žádná rotace IP, žádné proxy, žádné obcházení captchy/loginu;
- podmíněné požadavky (ETag/If‑Modified‑Since), cache raw HTML, retry s exponenciálním čekáním, při 429/403 zdroj na 24 h pozastavit a poslat alert;
- stahovat jen to, co potřebujeme: cena, dostupnost, identifikátory, název, URL — žádné popisy, fotky ani recenze;
- frekvence podle důležitosti: TOP položky (imprese/obrat) denně, zbytek 2–3× týdně; DE/AT ceny v EUR s kurzem ČNB.

Odhad objemu: ~30 000 skladových položek × ~6 relevantních konkurentů v kategorii ≈ 60–120 000 stránek za týden, tj. při 2 s/dotaz a 10 zdrojích paralelně cca 4–7 h nočního běhu — zvládnutelné bez zvláštní infrastruktury.

## 4. Párování (match)

Vrstvy, každá s explicitní jistotou a důvodem (detail a rešerše v 03):

| Vrstva | Klíč | Jistota | Cenu smí hýbat |
|---|---|---|---|
| T1 | EAN/GTIN (validní kontrolní číslice, normalizace UPC→EAN13) | 0,98 | ano |
| T2 | MPN (číslo výrobce) + normalizovaná značka | 0,90 | ano |
| T3 | náš kód / objednací název nalezen v SKU konkurenta + značka | 0,80 | ano, po prvním ručním potvrzení značky |
| T4 | kandidát podle názvu (značka + model + rok + velikost + barva, tokeny, fuzzy) | 0,3–0,7 | **ne** — jen fronta k ověření |
| M | ruční pár / ruční zákaz | 1,0 | ano (trvalý) |

Ochrany převzaté z praxe: pojistka výrobce (výrobce z našeho názvu musí být v názvu konkurenta), filtr podezřelých cen (poměr < 0,2 nebo > 5×), vyprodaná varianta se nepáruje na jinou barvu/velikost (přesně chyba, kterou dělá Disivo), pár si pamatuje URL a při zmizení URL se řeší znovu.

## 5. Cenový engine (price)

Deterministický, konfigurovaný ve strategiích (JSON/YAML v DB, editovatelné v UI), pořadí:

1. **Vstup položky:** naše cena, nákupní, DMOC, N, zásoba a dodání, imprese/prodeje 14/30/90, spárované ceny konkurence (jen jisté, s dostupností), trh.
2. **Volba strategie** podle scope (kategorie → značka → N → konkrétní kódy; nejvyšší priorita vyhrává) — příklad z přehledu projektů: N1–N2 chránit, N3–N4 optimalizovat marži vs. konkurence, N5–N6 hlídat obrátku, N7–N8 řízený odprodej.
3. **Pravidlo strategie** (příklady): `cíl = min(konkurence_skladem) − 1 %`, `cíl = medián konkurence`, `cíl = DMOC − 5 %`, `cíl = nákupní × (1 + marže)`; volba, které konkurenty a zda jen „skladem“.
4. **Zarážky (guards)** v pevném pořadí: min. marže per strategie → spodní/horní cena → DMOC strop → max. krok změny za den (např. ±10 %) → nezlevňovat, když jsme už nejlevnější → zaokrouhlení (…9 / …90) → cena v akci má přednost.
5. **Výstup:** návrh + **vysvětlení** („N4, Kupkolo skladem 1 290, cíl −1 % = 1 277, min. marže 22 % OK, krok −4 %“) + případná blokace s důvodem.
6. **Dry‑run** vždy; **schválení**: změny v pásmu ±X % automaticky, mimo pásmo do fronty (nahrazuje Disivo „významná změna ceny“, ale s hromadným schválením po strategii/značce a s možností dočasně zvednout limit).
7. **Export** do CSV ve formátu admina + záznam `price_runs` (kdo, kdy, kolik změn) → historie.

Vedlejší efekt: každá položka má zpětně dohledatelné „proč má tuhle cenu“, což Disivo nedává.

## 6. Reporty a upozornění

- Denní e‑mail 7:00: stav zdrojů (semafor), počet změn cen, blokace, nové páry k ověření, položky pod nákupní cenou, dobře prodejné bez skladu.
- Týdenní KPI stejné jako Disivo (přecenění, „příliš levné vs. medián −20 %“, pod nákupní cenou, obrátka < 7 dní, nepřeceňované) — aby šlo srovnat před/po přechodu.
- Deník změn cen konkurence (kdo, kdy, z čeho na co) — existuje v r01sales, přenést.

## 7. Fáze a odhad práce

Kapacita: Láďa 1–2 h denně + Claude Code; brand manažeři na ověřování párů. Hodiny jsou
hrubý odhad práce Ládi (kód generuje asistent, čas jde na zadání, kontrolu, nasazení).

| Fáze | Obsah | Výstup | Odhad |
|---|---|---|---|
| **0 — Rozhodnutí a příprava** (do konce 9/2026) | **zabezpečit `disivo.xml`** (Fameless/František), schválit scraping policy (06), potvrdit formát importu cen v adminu, priorita konkurentů per kategorie (Sheet), povolit odchozí provoz z 172.18.9.31, skriptem ověřit robots/JSON‑LD/anti‑bot všech ~60 domén **z naší IP**, poptat ceník Heureka Bidding API | podepsaná policy, seznam zdrojů v1, formát exportu | 8 h |
| **1 — DE/AT náhrada** (10/2026, termín daný koncem Disivo DE) | skeleton (schéma `pricing`, ingest Pohody a exportu položek), adaptéry bike‑discount + mtbiker.de + 2–3 další z 04, T1/T2 párování, srovnání CZ→EUR, report „kde jsme dražší“ | ceny DE konkurence denně v UI + XLSX, bez cenového enginu | 25 h |
| **2 — CZ zdroje a fronta párů** (11/2026) | Kupkolo (přenést), Mojekolo, Bikemax, Radotín, další z 04 podle kategorií; T3/T4 kandidáti, UI fronty, trvalé páry, blokace | pokrytí 60–80 % TOP sortimentu přímými konkurenty | 25 h |
| **3 — Cenový engine ve stínu** (12/2026–1/2027) | strategie, zarážky, dry‑run, vysvětlení; 4 týdny souběh s Disivem CZ — denní diff našich návrhů proti Disivo exportu | rozhodnutí „přepnout / co doladit“ podložené čísly | 30 h |
| **4 — Ostrý provoz CZ** (2/2027) | export do admina místo Disiva, marketingové akce, schvalování, alerty, denní/týdenní report | Disivo CZ jen paralelně ke kontrole | 15 h |
| **5 — Vypnutí Disiva** (3/2027) | archiv Disivo exportů, imprese nahradit GA4/webem, výpověď | úspora licence | 4 h |

Celkem cca 107 h práce Ládi, rozložených do 6 měsíců. Fáze 1 je časově kritická
(DE monitoring končí v říjnu); zbytek lze posouvat podle výsledků souběhu.

## 8. Rizika a jak s nimi

| Riziko | Dopad | Opatření |
|---|---|---|
| Konkurent blokuje datacentrovou IP (Datadome, Cloudflare) | výpadek zdroje | zdroj označit `browser`, rozhodnutí vedení; nikdy neobcházet — raději vynechat, hledat feed/dohodu |
| Pokrytí menší než Heureka (stovky obchodů vs. ~15) | u long‑tailu chybí cena | v strategiích fallback „bez konkurence = DMOC/marže“; volitelně ponechat Heureka data jen pro long‑tail (rozhodnout po fázi 2) |
| Špatné páry → špatná cena | ztráta marže/obratu | jen T1–T3 hýbou cenou, filtr podezřelých, max. krok, schvalovací pásmo |
| Změna šablony webu konkurenta | tichý pokles dat | `parse_yield` + práh + alert, golden vzorky HTML v testech |
| Právní / etické (ToS, databázová práva) | reputační riziko | policy 06, jen veřejná data, minimum dat, žádné republikování, kontakt v UA |
| Kapacita Ládi | skluz | fáze nezávislé, fáze 1 má prioritu; brand manažeři ověřují páry v UI, ne v Excelu |
| Ztráta impresí po odchodu z Disiva | slabší N/promo logika | GA4 (r01sales už má `core/ga4.py`) nebo web analytika Fameless |
| Admin importuje jinak, než čekáme | přepnutí se zdrží | ověřit ve fázi 0, dry‑run importu na testovacím prostředí admina |

## 9. Otevřené otázky (k rozhodnutí)

1. **Scraping policy** (06) — schvaluje CEO? Speciálně: zdroje s anti‑bot ochranou (bike24) vynecháme, nebo požádáme o feed?
2. **Formát a cesta importu cen do admina** — soubor z URL, nebo ruční nahrání? Kdo (Fameless) potvrdí? Jsou v importu i akční ceny a časová okna?
3. **Heureka pro long‑tail a velké hráče** — poptat ceník Heureka Bidding Data API (oficiální náhrada crawlování, vrací nabídky všech obchodů u produktu) a rozhodnout, zda ho použít pro produkty bez přímé konkurence a pro Alzu/Decathlon/Sportisimo.
4. **Imprese** — čím nahradit Disivo imprese (GA4 vs. web)?
5. **DE/AT** — které zdroje jsou pro nás v DE nejvíc cenotvorné (bike‑discount, bike24, bike‑components, fahrrad.de, mtbiker.de/sk, …)? Viz tabulka v 04.
6. **Kde poběží prohlížečový worker**, pokud ho vedení povolí (pobočková síť vs. server).
7. **Repo** — nový privátní repozitář `cenovy-radar` (jako feedhub), nebo modul v r01sales? Doporučení: nový repozitář, sdílená DB.
