# 03 — Párování produktů mezi e‑shopy (rešerše + doporučení pro nás)

> Rešerše stavu poznání (akademie, Heureka/Zboží.cz, komerční nástroje) a z ní odvozený návrh.
> **Rámec pro nás:** platí direktiva CEO z Feed Hubu — žádná externí AI API a SaaS,
> deterministická logika. Vše, co níže zmiňuje LLM (GPT‑4, Claude…), je uvedeno jako stav
> oboru; do našeho návrhu jde jen to, co běží u nás (Postgres rozšíření, případně lokální
> model), a **cenu smí hýbat jen deterministické vrstvy**.

## Shrnutí

- **Nejspolehlivější signál je EAN/GTIN**, ale v cyklo sortimentu je pokrytí nerovnoměrné:
  u komponentů (Shimano, SRAM, Fox) je EAN běžně dostupný a specifický na variantu, u kompletních
  kol a oblečení často chybí nebo je sdílený napříč velikostmi. Všechny komerční nástroje
  (Prisync, PriceShape, Competera, Disivo) staví na EAN/GTIN jako primární vrstvě a na
  **skóre + ruční validaci** pro zbytek.
- **Stav oboru v textovém matchingu:** fuzzy metriky → fine‑tuned transformery (Ditto, F1
  90–96 % na WDC) → LLM jako matcher (GPT‑4 zero‑shot 89,6 % F1 na WDC Products). Nejrelevantnější
  **český** referenční design je Zboží.cz: CatBoost nad 77 signály, práh 0,505 → precision
  80 %, recall 93 %, denní ruční revize vzorku jako trénink.
- **Praktický recept pro 10–30 k SKU × 5–15 konkurentů:** EAN/MPN exact → kandidáti přes
  pg_trgm (+ volitelně embeddingy lokálně) → skóre s jistotou → pásma auto / review / reject →
  fronta pro ruční kontrolu → re‑match při změně URL.

## 1. Párování podle identifikátorů

### EAN / GTIN
- Heureka feed: EAN volitelný mimo knihy/filmy; musí mít 13 číslic; Heureka: „EAN může být velmi
  důležitou součástí párovacího procesu“, ale sám nestačí. Zboží.cz páruje primárně podle názvu,
  EAN zvyšuje šanci. Google Merchant Center GTIN vyžaduje, kontrolní číslice musí sedět, jinak
  brand + MPN.
- **Kde EAN na konkurenčním webu najít:** (a) `schema.org/Product` JSON‑LD nebo microdata
  (`gtin13`/`gtin`/`mpn`/`brand`/`sku`) — Kupkolo i bike‑discount ověřeno; (b) veřejný
  Heureka/Zboží feed konkurenta (vzácné); (c) parametrická tabulka („EAN:“, „Kód výrobce:“).
  Pozor: některé platformy plní `gtin` interním kódem bez validace.
- **Validace:** GS1 Modulo‑10 kontrolní číslice; GTIN‑8/12/13/14 normalizovat doplněním nul
  zleva na 14 míst. Vyřadit kupónové prefixy 05/98/99, sekvence `0000000000000`,
  `1234567890128` a interní kódy začínající 2 (in‑store).

### MPN / kód výrobce
- schema.org `mpn`, Heureka `PRODUCTNO`. U Shimano/SRAM jsou kódy dílů (`FC-M8100-1`,
  `RD-M9100-SGS`) unikátní až na variantu → **nejsilnější ne‑EAN klíč pro komponenty**.
  Normalizovat: velká písmena, odstranit pomlčky/mezery, uchovat i původní tvar.

### Syntetický klíč brand + model + rok + velikost + barva
- Pro kola bez EAN: `cannondale|scalpel 2|carbon|2025|l|black`; získá se extrakcí atributů (§ 2).

### Úskalí
- **EAN sdílený napříč variantami** → EAN match potvrdit shodou velikosti/barvy z názvu.
- **Chybějící EAN u kol** — bez GTIN se i PriceShape/Prisync vrací k ručnímu párování URL.
- **Dodavatelský vs. maloobchodní EAN** — držet na SKU pole `ean_list[]`, ne jediný sloupec.
- **Model year:** stejný EAN často přechází mezi ročníky, ale i naopak → rok extrahovat explicitně
  a rozhodovat pravidlem (§ 5).

## 2. Textové párování

### Normalizace názvů
Unicode NFKC, lowercase, bez diakritiky (uchovat obě verze), sjednocení jednotek (`27,5"`→`27.5`,
`650b`→`27.5`), velikostí (`S/M/L` vs. `52/54/56 cm` — mapovat **per značka**), barev CZ/EN/DE
(`černá|black|schwarz|blk`), ročníků (`2025`, `MY25`), cyklo tokenů (`Di2`, `AXS`,
`12s`/`12-speed`/`12 rychlostí`, `boost`, `1x12`). Odstranit marketingový šum („AKCE“, „skladem“).

### Kandidáti (blocking)
- **BM25 / TF‑IDF top‑k** je překvapivě silný blocker (Sparkly, VLDB 2023). V Postgresu:
  `pg_trgm` GIN index + `similarity()` / `word_similarity()` nad normalizovaným názvem, nebo
  full‑text `ts_rank`. Tvrdé bloky: shoda značky (aliasy) a kategorie.
- **Embeddingy** (`intfloat/multilingual-e5-large`, `BAAI/bge-m3`) v **pgvector** (HNSW) —
  lze provozovat **lokálně na našem serveru** (CPU stačí pro 50 k názvů), tedy v souladu
  s direktivou; sjednocení lexikálních + vektorových kandidátů dává nejlepší recall.

### Rozhodovací vrstva
- **Fuzzy metriky** (rapidfuzz `token_set_ratio`, `WRatio`, Jaro‑Winkler) — rychlé, jako
  feature, ne finální rozhodnutí.
- **Klasické ML nad feature vektorem** (Zboží.cz: CatBoost; Splink Fellegi‑Sunter s nástrojem na
  volbu prahu; dedupe s active learning) — běží lokálně, trénink z ručních labelů.
- **Fine‑tuned transformer (Ditto)**: F1 89 Abt‑Buy, 96 WDC; vyžaduje stovky–tisíce labelů.
- **Cross‑encoder reranker** (`bge-reranker-v2-m3`): 10–50 ms/pár na GPU, na top‑20 kandidátů.
- **LLM jako matcher** (Peeters & Bizer 2025): GPT‑4 zero‑shot F1 89,6 % WDC; fine‑tuned malé
  modely (Llama 3.1 8B) ho překonají o 1–10 p. b. — u nás **jen lokálně a jen po souhlasu
  vedení**, nikdy přes externí API.
- **Extrakce atributů z názvu** (ExtractGPT): schéma `{brand, model, series, year, size, color,
  wheel_size, groupset, speeds}` — deterministicky regexovými slovníky, LLM jen jako záloha
  (stejné omezení).

### Benchmarky
WDC LSPM (26 M nabídek), WDC Products 2023, Abt‑Buy, Amazon‑Google; **ProMapCz — český dataset
1 495 párů ze dvou českých e‑shopů včetně „close non‑matches“** (Pilát a kol.) — ideální pro první
kalibraci prahů.

## 3. Obrazové párování jako podpůrný signál
- **Perceptuální hashe** (pHash/dHash, `imagehash`) odhalí identické fotky výrobce (Hamming ≤ 6–8
  z 64 bitů). CLIP/SigLIP off‑the‑shelf jen ~41 % přesnost na retail datech, po doladění 89 %.
  Obrázek potvrdí model + barvu, nikdy velikost → jen feature do skóre.

## 4. Hybridní pipeline v průmyslu
- **Heureka**: kategorie → párování podle názvu (+ EAN přes Simple Pairing) → „Čekající produkty“
  pro admina (5–7 dní) → ruční dohledání karty.
- **Zboží.cz**: Sphinx kandidáti → CatBoost → práh 0,505 → denní ruční revize vzorku.
- **Google Shopping**: seskupení podle GTIN; od 11/2023 nelze v Google Shopping hledat podle EAN.
- **Prisync**: EAN/URL + ruční URL. **PriceShape**: GTIN + AI validace + ruční QA. **Competera**:
  GTIN + sémantika s confidence → human‑in‑the‑loop → „exact“ vs. „similar“. **Disivo/Azor**:
  EAN + název + parametry, nejasné případy kontroluje člověk, schvalovací systém.
- Společný vzorec: **identifikátor → skóre s jistotou → fronta pro ruční validaci → labely zpět
  do modelu**.

## 5. Varianty, ročníky, bundly a logika porovnání cen
- **Varianty**: párovat na úrovni **varianty** (velikost × barva), držet i vazbu na **model**
  (`variant_group`). Pokud konkurent uvádí jen model, uložit match na skupinu s příznakem
  `variant_resolved=false`.
- **Model year**: (a) stejný rok = exact; (b) jiný rok, stejná spec = „similar — předchozí
  ročník“ (sledovat, nepřeceňovat automaticky); (c) jiný rok, jiná spec = ne‑match.
- **Bundly / balení / MOQ**: normalizovat na jednotkovou cenu (`pack_qty` z názvu: „2 ks“, „pár“,
  „sada“); bundle jen jako „similar“. (Přesně chyba DMOC „balení vs. kus“ u Schwalbe z 5/2026.)
- **Kterou cenu porovnávat**: cenu **s DPH** (B2C); ukládat zvlášť `price`, `price_member`,
  `price_before_discount`, `shipping_min`, `free_shipping_from`, `stock_status`,
  `delivery_days`. Srovnání jen proti `in_stock` nebo `delivery ≤ X dní`; klubové ceny jako
  samostatná řada. U kol (drahá doprava) porovnávat i „landed price“.

## 6. Doporučený design pro nás (10–30 k SKU, 5–15 konkurentů)

### Datový model (doplňuje schéma `pricing` v 05)
- `products`: `ean[]`, `mpn[]`, `name_norm`, `attrs jsonb`, volitelně `name_emb vector(1024)`,
  `img_hash bit(64)`.
- `offers`: `ext_id` (SKU/ID konkurenta z JSON‑LD — přežije změnu URL), `ean`, `mpn`, `name_norm`,
  `attrs`, `raw_jsonld`.
- `match_map`: `level variant|group`, `type exact|prev_year|similar`, `score`, `method`, `status`.
- `match_labels`: každé ruční rozhodnutí (trénink + audit).
- Rozšíření Postgresu: **pg_trgm**, **unaccent**, volitelně **pgvector**.

### Kroky
1. **Sběr + extrakce**: JSON‑LD (`extruct`), tabulky parametrů; kanonizace URL; uložit ID
   produktu konkurenta.
2. **Normalizace**: `unidecode`/`unaccent`, regexové slovníky (jednotky, velikosti, barvy,
   ročníky, balení).
3. **Vrstva T1/T2 — deterministická**: validní EAN nebo brand + MPN → `score 0,98`, `auto`, ale
   jen pokud nekoliduje velikost/barva/rok z atributů (jinak `review`).
4. **Vrstva T3**: náš kód / objednací název nalezen v SKU konkurenta + značka.
5. **Vrstva T4 — kandidáti**: union top‑10 z pg_trgm a (volitelně) top‑10 z pgvector; filtr
   značky; feature vektor (rapidfuzz, Jaro‑Winkler na MPN, shoda year/size/color/wheel, poměr cen,
   pHash) → skóre; **v1 deterministicky váženým součtem**, později CatBoost/Splink na labelech.
6. **Pásma**: `≥ 0,90` auto‑accept (jen T1–T3; spot‑check 2 % týdně); `0,60–0,90` review fronta
   (řazená podle obrat SKU × cenový rozdíl); `< 0,60` reject (uchovat top kandidáta). Cíl
   **precision ≥ 97 % u auto** — špatný pár zkazí přecenění, chybějící jen zpozdí.
7. **Human‑in‑the‑loop UI**: dvojice karet (název, atributy, cena, obrázek), tlačítka
   *Stejné / Předchozí ročník / Jiná varianta / Jiné*; rozhodnutí → `match_labels`.
8. **Udržení čerstvosti**: 404/redirect → re‑match podle `ext_id`/EAN → sitemapa → T4 znovu
   (`rematch_pending`); změna názvu/EAN na URL → re‑verifikace; měsíční audit vzorku; po
   naskladnění nového ročníku hromadný běh + označení starých párů `prev_year`.
9. **Monitoring kvality**: precision/recall na labelovaném setu, podíl SKU s ≥ 1 exact párem per
   konkurent, stáří párů, délka fronty.

### Knihovny
`rapidfuzz`, `jellyfish`, `unidecode`, `extruct` + `w3lib`, `python-stdnum` (GS1 kontrolní
číslice), volitelně `sentence-transformers` + `pgvector`, `catboost`/`splink`, `imagehash`,
`pydantic`. Postgres: `pg_trgm`, `unaccent`, `pgvector`.

### Co očekávat
- Komponenty/doplňky s EAN: 80–95 % pokrytí automaticky.
- Kola a oblečení bez EAN: 50–70 % auto, zbytek review; s ≥ 1 000 labely F1 kolem 85–92 %.
- Ověřit na vlastních datech: **podíl SKU s EAN podle kategorie** (Pohoda `Čárkód`) — první
  úkol fáze 1.

## Zdroje
- Heureka XML spec: https://heureka.github.io/xml-feed-specs/ ; využití EAN: https://sluzby.heureka.cz/napoveda/vyuziti-ean-kodu/ ; Simple Pairing: https://sluzby.heureka.cz/napoveda/simple-pairing/
- Zboží.cz CatBoost: https://www.root.cz/clanky/parovani-zbozi-pomoci-catboost-a-prakticke-zkusenosti-ze-zbozi-cz/ ; Mergado: https://www.mergado.cz/parujte-efektivne-na-zbozi
- Google GTIN: https://support.google.com/merchants/answer/6324461?hl=en
- GS1 check digit: https://www.gs1.org/services/check-digit-calculator ; schema.org: https://schema.org/Product
- Shimano kódy: https://www.sjscycles.co.uk/shimano-id-guide/
- Sparkly BM25 blocking: https://www.vldb.org/pvldb/vol16/p1507-paulsen.pdf ; pg_trgm: https://www.postgresql.org/docs/current/pgtrgm.html ; pgvector: https://github.com/pgvector/pgvector
- mE5: https://arxiv.org/pdf/2402.05672 ; bge‑m3: https://huggingface.co/BAAI/bge-m3 ; reranker: https://huggingface.co/BAAI/bge-reranker-v2-m3
- RapidFuzz: https://github.com/rapidfuzz/RapidFuzz ; Splink: https://github.com/moj-analytical-services/splink ; srovnání OSS ER: https://tilores.io/content/best-open-source-entity-resolution-and-record-linkage-libraries-splink-zingg-dedupe-and-when-to-move-beyond-them/
- Ditto: https://arxiv.org/abs/2004.00584 ; LLM entity matching: https://arxiv.org/html/2310.11244 ; AnyMatch: https://arxiv.org/pdf/2409.04073 ; ExtractGPT: https://arxiv.org/html/2310.12537v4
- WDC: https://arxiv.org/html/2301.09521 ; ProMapCz: https://arxiv.org/abs/2309.06882
- Obrázky: https://github.com/jgraving/imagehash ; https://www.width.ai/post/image-embedding-models
- Prisync: https://www.thepricegeek.com/competitor-monitoring/prisync-review/ ; PriceShape: https://priceshape.com/help/frequently-asked-questions ; Competera: https://competera.ai/solutions/by-need/product-matching ; Minderest: https://www.minderest.com/blog/google-shopping-ean-upc-gtin-scraping
- Disivo: https://help.disivo.com/how-to-divide-your-portfolio ; Conviu: https://napoveda.conviu.cz/modul-uprava-dat-xml-a-csv/export-dat/parovani-produktu-na-heurece-heureka-parovac
- Logika porovnání cen: https://www.marginmoat.com/blog/competitor-price-monitoring-guide
