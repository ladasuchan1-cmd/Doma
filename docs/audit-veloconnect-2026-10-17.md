# Audit VeloConnect (17. 10. 2026)

Živá verze dokumentu (s tabulkami a schématem): https://claude.ai/artifact/PYsayfPVZnYk37XWCJMQrB

## Verdikt

VeloConnect je rozdělaný na třech místech a v provozu neběží nikde. Feed Hub (repo `feedhub`) má hotový klient
i pilotní zdroje pro Raymon a Focus, ale jediné nasazení (24. 9. 2026) skončilo na chybějících GitHub secrets
a od té doby se v repozitáři nic nezměnilo. OBR 3.0 (`r01sales/obr3`) má pět nástrojů ověřených naostro na
Raymonu (srpen 2026) a čte ceník Raymonu jako podklad, ale dostupnost od dodavatelů do něj chodí jen z ručně
nahraného exportu. Do Pohody se z VeloConnectu nezapisuje nic a nic k tomu není napsané.

K prvnímu užitku (denní ceny a dostupnost Raymonu a Focusu v OBR 3.0) chybí šest věcí:

1. Přístupy do `.env` na serveru Hetzner (Raymon: příloha e-mailu z 26. 8., Focus/PON: automatický e-mail
   pon.bike) a tři GitHub secrets pro nasazení.
2. Dvě opravy klienta Feed Hubu zapsané už v srpnu: GetProfile posílat s přihlášením (Raymon jinak vrací 410)
   a nechat selhání profilu neblokovat vlastní dotaz.
3. Seznam sledovaných SKU per dodavatel místo 39 kódů natvrdo v migraci (VeloConnect nemá výpis katalogu;
   OBR 3.0 seznam umí vyexportovat).
4. Cesta dat Feed Hub → OBR 3.0 (dnes CSV ručně; interní server si musí data stahovat sám).
5. Potvrzení CEO k Hetzneru (nákupní ceny dodavatelů mimo firmu, direktiva č. 1).
6. Rozhodnutí, kudy do Pohody: PlusImportUni (CSV z Feed Hubu), agenda BHIT, nebo Pohoda XML / mServer.

Objednávání přes VeloConnect (Order) je naprogramované, ale neověřené; do té doby se objednává běžnou cestou.

## Co už existuje

| Kdy | Kde | Co vzniklo | Stav dnes |
| --- | --- | --- | --- |
| 17. 9. 2025 | e-mail pon.bike | přístup Focus (BuyersID + heslo, endpoint focus.veloapi.net) | heslo koluje v pěti e-mailech, na serveru není |
| 22. 10. 2025 | návštěva Lindlau | Lindlau pošle podklady k VeloConnectu | bez pokračování |
| 24.–27. 10. 2025 | velo.API, DiBike (N. Becker) | princip: každý dodavatel vlastní server, ERP musí implementovat spec, přístupy per dodavatel | kontakt k dispozici |
| 3. 12. 2025 | Raymon | náhrada: týdenní XLSX „B2B Inventory“ | chodí, OBR ho čte jako podklad Ceník |
| 13.–19. 2. 2026 | Fameless | zadání: napojit VeloConnect do Pohody; popis cest BHIT a IT Future | bez technického výstupu v poště |
| 6. 4. 2026 | nabídka Fameless „Cesta bez FU“ | bod 3 „Příprava feedu Veloconnect … dle nabídky“ | nevíme, zda běží |
| 28. 5.–8. 6. 2026 | Campudus | SaaS „Veloconnect Crawler“ s exportem do Pohody: 3 360 € + 300 €/měs. | bez odpovědi |
| 22.–27. 8. 2026 | `feedhub` | klient VeloConnect, XML adaptér, ingest, kurzy ČNB, dashboard (v0.01–v0.07) | kód hotový, neběží |
| 24.–27. 8. 2026 | `r01sales/obr3/nastroje` | velotest, velohledej, velodostupnost, veloprozkum, veloobjednavka, mock; ostrý test Raymon prošel | hotovo; Order neověřen |
| 26. 8. 2026 | Raymon (N. Ziegler) | přístupy (příloha `Velo_Zugang_VeloCity.docx`) | v poště |
| 16. 9. 2026 | `feedhub/scripts/vc_ceny.py` | jednorázový dotaz na ceny; 39 kódů Raymonu | hotovo |
| 23.–24. 9. 2026 | `feedhub` | nasazení na Hetzner, migrace 003 (Raymon, Focus), server-setup.sh | deploy selhal (chybí secrets) |
| 12. 10. 2026 | `r01sales` PR #508 | nabídka z Feed Hubu přebíjí prázdné Dodání („skladem (Feed Hub)“) | v main |

## Co VeloConnect umí a neumí (ověřeno na Raymonu)

| Údaj | VeloConnect | Ceník XLSX Raymonu |
| --- | --- | --- |
| Nákupní cena (`BasePrice`) | ano, CZK; = `NettoPrice` z ceníku | ano |
| Doporučená MOC | ano, u části zboží | ano |
| Dostupnost | jen stav: available / not_available / expecting_delivery | počet volných kusů (strop 21), na cestě, nevyřízené |
| Počet kusů u dodavatele | ne (`AvailableQuantity` jen u očekávané dodávky a vždy 0) | ano |
| Termín dodání | datum dodávky k dodavateli (DD.MM.RRRR), ne naše lhůta | ano |
| EAN, název, značka, DPH, obrázek, kategorie (Bidex) | ano | část |
| Ročník, celní kód, ceníková cena před slevou | ne | ano |
| Výpis celého sortimentu | ne; TextSearch přes GET 404, náš XML-POST tvar 405 | ano |
| Order / GetStatus / Rollback | server hlásí, nástroj napsán, ostrý pokus neproběhl | ne |

Důsledky: bez seznamu objednacích kódů se nedá ptát na nic; dostupnost je binární vstup, ne množstevní strop;
ceník a rozhraní se doplňují (ceník základ, rozhraní denní aktualizace). Oficiální Bruno/Postman kolekce
(github.com/veloconnect/postman) má vzory GET i POST pro GetProfile, GetItemDetailsList, GetItemDetails,
objednávky i TextSearch; z ní se má vzít správný tvar XML-POST místo hádání.

## Dodavatelé a přístupy

| Dodavatel | Server | Přístup | Stav |
| --- | --- | --- | --- |
| R Raymon | velo-connect.raymon-bicycles.com | BuyersID D002260, heslo v příloze 26. 8. | ověřeno; heslo z chatu změnit |
| FOCUS (PON) | focus.veloapi.net/ITriData.asmx/Connector | přihlášení 516165 + heslo z e-mailu pon.bike | nezkoušeno; heslo resetovat |
| Cannondale, Santa Cruz, Cervelo (PON) | vlastní servery v seznamu DiBike | vyžádat u PON | |
| Lindlau | v seznamu DiBike | vyžádat (slíbeno 10/2025) | největší obrat |
| ABUS | v seznamu DiBike | vyžádat | |
| Další značky ze seznamu (Endura, Thule, SKS, Ortlieb, Vaude, Deuter, Uvex, Sigma, Maxxis, Magura, Cratoni, Hamax, Puky, Trelock, Paul Lange) | | prořezat podle přímých nákupů | |

Čeští distributoři VeloConnect nemají; jdou přes XML/CSV adaptér Feed Hubu nebo BHIT / PlusImport.

## Napojení do OBR 3.0

Dnes: Pohoda → SQL exporty do sdílené složky (vč. katalog_karet se sloupcem Dodání) → Sales → OBR;
ceník Raymonu e-mailem → OBR (podklad Ceník); Feed Hub CSV → OBR (podklad Feed Hub (nabídky), párování EAN
a obj. kód); OBR → Export sledovaných SKU.

| Co | Kde | Pracnost |
| --- | --- | --- |
| Nasadit Feed Hub (`.env`, DNS, Caddy, secrets; `scripts/server-setup.sh`) | Hetzner, GitHub | 2 h |
| GetProfile s přihlášením, profil neblokující | `feedhub/app/adapters/veloconnect.py` | 1 h |
| U Raymonu vazba URL (GET), dokud není XML-POST ověřen | tamtéž | 1 h |
| `availability_qty` nevykládat jako zásobu; ukládat MOC; dohledání přes EAN | `veloconnect.py`, `ingest.py`, migrace | půl dne |
| Seznam SKU per dodavatel místo `mapping.codes` | Feed Hub + export z OBR | den |
| Most Feed Hub → OBR: Sales stáhne `offers.csv` (HTTP Basic) a předá OBR | `r01sales` (vzor `core/pohoda_slozka.py`) | den |
| Vyhodnocení pilotu (týden běhů, srovnání s ceníkem a nástroji OBR) | dashboard Feed Hubu | týden |

## Import do Pohody

| Cesta | Jak | Doporučení |
| --- | --- | --- |
| A. PlusImportUni | Feed Hub vystaví CSV ve tvaru ceníku Raymonu (`velodostupnost.py` ho už píše); PlusImportUni z URL/FTP/e-mailu, párování EAN, zápis dostupnosti, termínu, dodavatelské ceny; licence 14 000 Kč, šablona 1 000 Kč/h | první krok |
| B. BHIT agenda | XML ve tvaru `SHOP/SHOPITEM` | jen most, nestavět |
| C. Pohoda XML / mServer | `dat:dataPack` + `stk:stock` update podle kódu (vzor v `repricing/docs/POHODA.md`); mServer v LAN; vyžaduje `sku_map` a výslovné schválení | druhý krok |
| D. Campudus SaaS | 3 360 € + 300 €/měs., data mimo firmu | záloha |

Pohoda dostane stav, ne počet kusů. Otevřené otázky na Františka a IT Future: je dnešní PlusImport totéž
co PlusImportUni a umí plánovaný import z URL; do kterého pole BHIT/PlusImport zapisují dostupnost; jak
často se vyváží do `katalog_karet`.

## Rizika

- Hesla v poště (Focus v pěti e-mailech, Raymon prošlo chatem) → resetovat, jen do `.env`.
- Direktiva CEO č. 1 vs. Hetzner → potvrdit, nebo interní server.
- Souběh Fameless (bod 3 nabídky) × Campudus × interní Feed Hub → nezaplatit dvakrát.
- Vše ověřené jen na Raymonu; Focus (Tridata) je druhý nutný test.
- `availability_qty` 0/NULL není zásoba; XML-POST neověřen (405); Order naostro jen na jedné levné položce.
- Feed Hub bez automatické zálohy (`offer_history`).

## Plán

| # | Krok | Kdo | Pracnost |
| --- | --- | --- | --- |
| 0 | Rozhodnout server (Hetzner + CEO, nebo interní) | CEO, Láďa, František | 1 h |
| 1 | Přístupy, `.env`, secrets, deploy | Láďa | 2 h |
| 2 | Opravy klienta Feed Hubu + testy | Claude | půl dne |
| 3 | Pilot Raymon + Focus, týden sledování | Láďa, Petr Sůva | 1 h + týden |
| 4 | Seznam SKU per dodavatel z exportu OBR | Claude | den |
| 5 | Most Feed Hub → OBR bez zásahu do Sales a OBR: denní CSV e-mailem do schránky OBR (SMTP ve Feed Hubu) | Claude, František | půl dne |
| 6 | Pohoda cesta A přes PlusImportUni, pilot Raymon | Láďa, František, IT Future, Claude | týden |
| 7 | Přístupy PON značky, Lindlau, ABUS | Pavel Veselý, Láďa | e-maily |
| 8 | Vyjasnit Fameless a Campudus | Pavel Veselý | hodina |
| 9 | Objednávka přes rozhraní jako nástroj ve Feed Hubu, ne v OBR (vzor z Bruno kolekce, IsTest, pak 1 levná položka) | Claude, Láďa | den + pokus |
| 10 | Pohoda cesta C (XML/mServer) včetně párování `sku_map`, po měsíci bezchybného běhu | Claude, František | týdny |

Podle pokynu ze 17. 10. se v Sales ani v OBR nic nemění; všechna práce Clauda je ve Feed Hubu.

## Odhad času a tokenů

Tokeny = součet vstupu i výstupu přes všechna kola sezení (účtování Claude Code); kalibrace: tento audit
≈ 0,5 mil. tokenů za 1,5 h. Rozptyl ±50 %.

| # | Krok | Čas lidí | Práce Clauda | Tokeny Clauda | Kalendář |
| --- | --- | --- | --- | --- | --- |
| 0 | Rozhodnutí o serveru | 1 h | 0 | 0 | den |
| 1 | Přístupy, `.env`, secrets, nasazení | 2 h | 1 h dohled | 0,1–0,2 mil. | den |
| 2 | Opravy klienta Feed Hubu + testy | 0,5 h revize | půl dne | 0,3–0,6 mil. | den |
| 3 | Pilot Raymon + Focus | 1 h + 10 min denně | 1 h vyhodnocení | 0,1–0,2 mil. | týden |
| 4 | Seznam SKU per dodavatel | 1 h | den | 0,4–0,8 mil. | 2 dny |
| 5 | Most e-mailem do schránky OBR | 1 h (SMTP) | půl dne | 0,3–0,5 mil. | 2 dny |
| 6 | Pohoda cesta A (PlusImportUni) | 2 h František + 2–4 h IT Future (2–4 tis. Kč) | půl dne | 0,2–0,4 mil. | týden |
| 7 | Další dodavatelé (na jednoho) | 1 h | 1 h | 0,05–0,1 mil. | podle dodavatele |
| 8 | Fameless, Campudus | 1 h | 0 | 0 | den |
| 9 | Objednávka přes rozhraní | 1 h test | den | 0,3–0,6 mil. | 2 dny + pokus |
| 10 | Pohoda cesta C + párování `sku_map` | 1 den František | 5–8 dní | 3–5 mil. | 4–6 týdnů |

Součty: kroky 0–5 (první užitek) 1,2–2,3 mil. tokenů, 2,5 dne Clauda, 7 h lidí, 2–3 týdny. Kroky 0–6
1,4–2,7 mil. tokenů, 3 dny Clauda, 10 h lidí, 3–4 týdny. Kroky 7–10 s pěti dalšími dodavateli
+3,5–6 mil. tokenů a 6–8 týdnů.

## Rozhodnutí k potvrzení

- [ ] Server pro Feed Hub.
- [ ] Cesta do Pohody v první vlně: PlusImportUni.
- [ ] Rozsah první vlny dodavatelů (Raymon, Focus; pak PON, Lindlau, ABUS).
- [ ] Fameless bod 3: běží, nebo ho nahrazuje Feed Hub?
- [ ] Campudus: odmítnout, nebo držet jako zálohu.
- [ ] Objednávání přes VeloConnect: ano/ne, kdo smí spustit pokus.
- [ ] Reset hesel Raymon a Focus; přístupy se nepřeposílají e-mailem.

## Zdroje

E-maily ve schránce suchan@koloshop.cz (vlákna „Fwd: Veloconnect“ 26. 8. 2026, „Fwd: RAYMON Bicycles -
Veloconnect“, „Fwd: Predmet: Heslo veloconnect“, „Fwd: Cesta bez FU“, „VeloConnect xml feed“ 11. 5. 2026,
„Lindlau meet“ 23. 10. 2025, „Re: B2B Inventory“ 3. 12. 2025). Repozitáře `feedhub` (CLAUDE.md, NASAZENI.md,
app/adapters/veloconnect.py, migrations/003), `r01sales` (obr3/nastroje/README.md, docs/PREDANI-feedhub.md,
docs/OBR3.md kap. 17.6), `Doma` (repricing/docs/POHODA.md). Dokumentace: veloconnect.de/en/documentation,
veloconnect.atlassian.net (spec 1.6), veloconnect.de/en/implementation, github.com/veloconnect/postman,
plussystem.cz/produkt/plusimportuni.
