# Smlouva o nájmu jízdního kola a předávací protokol (k tisku/podpisu při převzetí) + protokol o vrácení – návrh

> **Návrh připravený jako podklad pro advokátní kontrolu, kterou zajišťuje zadavatel. Před nasazením nesmí být použit bez této kontroly; sporné body jsou shrnuty v sekci „K ověření advokátem“ na konci.**

Verze šablony {{VERZE}}, účinnost od {{UCINNOST_OD}}. Dokument generuje muster pro každou půjčovnu dosazením parametrů z jejího nastavení (`tenant.json`) a údajů konkrétní rezervace; tiskne se (nebo podepisuje na obrazovce) při převzetí kol a při jejich vrácení. Navazuje na [Obchodní podmínky](obchodni-podminky.md) (dále „OP“ – odkazy na články OP jsou na jejich verzi {{OP_VERZE}}) a na [Zásady ochrany osobních údajů](zasady-ochrany-osobnich-udaju.md) (dále „Zásady“). Podklady: [rešerše 02 – platby, zálohy, DPH](../docs/vyzkum/02-platby-cr.md), [rešerše 03 – GDPR, praxe půjčoven, stanoviska ÚOOÚ](../docs/vyzkum/03-bezpecnost-gdpr-podminky.md), [PLAN.md kap. 5–8](../PLAN.md).

**Jak číst návrh**

- `{{NAZEV_PARAMETRU}}` je proměnná, kterou doplní systém. Jsou tří druhů – **nastavení půjčovny** (shodné s OP a Zásadami, mění se jen s novou verzí dokumentů), **údaje rezervace** (doplní systém z rezervace) a **údaje vyplňované obsluhou** při převzetí nebo vrácení (zaškrtávací pole ☐, částky, poznámky). Všechny jsou v tabulce *Parametry* níže.
- Bloky **[VARIANTA A – plátce DPH]** / **[VARIANTA B – neplátce DPH]** se zobrazí podle `{{PLATCE_DPH}}`; bloky **[ONLINE]** / **[NA MÍSTĚ]** podle toho, zda rezervace vznikla přes web, nebo ji obsluha založila až na výdejním místě; řádky označené **[E-KOLO]** se tisknou, jen je-li v rezervaci elektrokolo.
- Řádky tabulek označené *(opakuje se pro každé kolo)* systém vygeneruje tolikrát, kolik kol rezervace obsahuje; placeholdery `{{KOLO_…}}` se vztahují k danému řádku.
- Dokument má čtyři části: **A** smlouva (cíl 1 strana A4 u čl. 1–4 a 6–7; poučení v čl. 5 tiskne systém menším písmem, reálně tedy 1–2 strany), **B** předávací protokol (1 strana, u více než 3 kol příloha), **C** protokol o vrácení (1 strana, tiskne se až při vrácení), **D** informace, co se z protokolu ukládá do systému a co se maže (netiskne se, je součástí dokumentace a Zásad). Každý údaj se zapisuje jen na jednom místě: forma kauce a stav doplatku v B.4, nikoli v čl. 3–4.
- Odkazy na předpisy: **OZ** = zákon č. 89/2012 Sb., občanský zákoník; **ZOS** = zákon č. 634/1992 Sb., o ochraně spotřebitele; **GDPR** = nařízení (EU) 2016/679; **ZDPH** = zákon č. 235/2004 Sb., o dani z přidané hodnoty; **zákon o občanských průkazech** = zákon č. 269/2021 Sb.; **ZEK** = zákon č. 127/2005 Sb., o elektronických komunikacích (v tomto dokumentu se nepoužívá – cookies řeší Zásady); **zákon o silničním provozu** = zákon č. 361/2000 Sb.; **TZ** = zákon č. 40/2009 Sb., trestní zákoník; **zákon o el. podpisu** = zákon č. 297/2016 Sb. Znění citovaných paragrafů ověřeno k 5. 10. 2026 (zakonyprolidi.cz pro zákony č. 269/2021 Sb., 634/1992 Sb., 297/2016 Sb. a § 5 zákona č. 361/2000 Sb.; pracepropravniky.cz a podnikatel.cz pro OZ; businesscenter.podnikatel.cz pro ZDPH; mesec.cz pro TZ; eur-lex.europa.eu pro GDPR; zakony.centrum.cz pro § 58 zákona o silničním provozu). Oponentura (10/2026) potvrdila existenci a obsah ostatních citací a opravila tyto: § 28 odst. 8 ZDPH → § 37a ZDPH (základ daně konečného dokladu), § 2969 odst. 1 OZ (obvyklá cena „v době poškození“, ne „v době převzetí“), § 1807 OZ vypuštěn (poplatek není zálohou ve smyslu tohoto ustanovení), § 19 ZOS ponechán jen u reklamace vad kola, § 2051 OZ u spotřebitele nepoužit; § 39 písm. d) a § 65 odst. 1 písm. d) zákona č. 269/2021 Sb. a § 37a ZDPH ověřeny znovu 5. 10. 2026 (zakonyprolidi.cz, pracepropravniky.cz).
- Zákazníka oslovujeme „vy“, půjčovnu „my“ – stejně jako v OP. Text má být srozumitelný bez právníka, ale s přesnými odkazy, aby advokát kontroloval rychle.
- Smlouva o nájmu nevyžaduje písemnou formu (§ 559 OZ). Listinu podepisujeme kvůli důkazu: **zápis o stavu věci při předání se podle § 2225 odst. 1 OZ zohlední při vrácení** (jako vyvratitelná domněnka – nájemce může prokázat opak, § 1814 odst. 1 písm. m) OZ), a potvrzení o převzetí a vrácení kauce chrání obě strany.

---

## Parametry

| Parametr | Význam | Zdroj | Výchozí hodnota / návrh |
|---|---|---|---|
| **Půjčovna (shodné s OP)** | | | |
| `{{PUJCOVNA_NAZEV}}` | Obchodní firma / jméno podnikatele – pronajímatel | nastavení | *(příklad)* Hotel U Tří dubů s.r.o. |
| `{{PUJCOVNA_ICO}}` | IČO | nastavení | *(příklad)* 12345678 |
| `{{PUJCOVNA_DIC}}` | DIČ – jen u plátce DPH | nastavení | *(příklad)* CZ12345678 |
| `{{PUJCOVNA_SIDLO}}` | Sídlo / místo podnikání | nastavení | – |
| `{{PUJCOVNA_REJSTRIK}}` | Údaj o zápisu (obchodní / živnostenský rejstřík) | nastavení | „zapsaná v obchodním rejstříku vedeném Krajským soudem v …, oddíl C, vložka …“ |
| `{{PUJCOVNA_PROVOZOVNA}}` | Výdejní místo – kde se kola přebírají a vracejí | nastavení | shodná se sídlem |
| `{{PUJCOVNA_EMAIL}}` | Kontaktní e-mail | nastavení | – |
| `{{PUJCOVNA_TELEFON}}` | Telefon pro hlášení závad, zpoždění a krádeže během nájmu | nastavení | – |
| `{{OTEVIRACI_DOBA}}` | Otevírací doba výdejního místa | nastavení | *(příklad)* denně 9:00–18:00 |
| `{{WEB_SUBDOMENA}}` | Doména webu půjčovny na musteru `<nazev-stavajiciho-webu>.pujcovna.cz` | nastavení | *(příklad)* utridubu.pujcovna.cz |
| `{{PODMINKY_URL}}` | Adresa OP (archiv všech verzí) | nastavení | https://{{WEB_SUBDOMENA}}/podminky |
| `{{ZASADY_URL}}` | Adresa Zásad | nastavení | https://{{WEB_SUBDOMENA}}/soukromi |
| `{{CENIK_URL}}` | Adresa ceníku (nájemné, paušály, ceník oprav a náhrad) | nastavení | https://{{WEB_SUBDOMENA}}/cenik |
| `{{PROVOZOVATEL_NAZEV}}` | Provozovatel musteru – technický provozovatel webu (zpracovatel osobních údajů), název a IČO | nastavení | – |
| `{{PLATCE_DPH}}` | Je půjčovna plátcem DPH? Řídí varianty A/B | nastavení | ne |
| `{{PLATEBNI_BRANA}}` | Platební brána pro karty a preautorizaci kauce | nastavení | Comgate |
| `{{POPLATEK_KOLO}}` | Rezervační poplatek za jedno kolo (fixní částka; částečná úhrada nájemného zaplacená předem, odečítá se z ceny v plné výši; storno před převzetím podle OP čl. 6) | nastavení | 300 Kč |
| `{{POPLATEK_EKOLO}}` | Rezervační poplatek za jedno elektrokolo | nastavení | 500 Kč |
| `{{KAUCE_KOLO}}` | Kauce za jedno kolo | nastavení | 3 000 Kč |
| `{{KAUCE_EKOLO}}` | Kauce za jedno elektrokolo | nastavení | 10 000 Kč |
| `{{PREAUTH_MAX_DNU}}` | Nejdelší nájem (dny), u kterého lze kauci složit preautorizací karty. **Odvozená hodnota:** platnost blokace u zvolené `{{PLATEBNI_BRANA}}` − 1 den rezervy; systém ji nastaví podle brány, půjčovna ji může jen snížit. U delšího nájmu systém preautorizaci nenabídne (jen hotově / terminál) | systém (podle brány) | 6 (Comgate: 7 − 1) |
| `{{STORNO_TABULKA}}` | Storno tabulka z OP čl. 6.2 – ve smlouvě jen odkaz (storno se týká doby před převzetím) | nastavení | viz OP |
| `{{TOLERANCE_POZDNI}}` | Zpoždění při vrácení, které neúčtujeme | nastavení | 30 minut |
| `{{SAZBA_POZDNI}}` | Nájemné za dobu po sjednaném konci nájmu | nastavení | hodinová sazba podle ceníku za každou započatou hodinu, nejvýše denní sazba za každý započatý den |
| `{{POPLATEK_POZDNI_PAUSAL}}` | Smluvní pokuta za vrácení po otevírací době bez domluvy (za rezervaci). Účel: náklady na obsluhu mimo otevírací dobu. **Strop v adminu: nejvýše denní nájemné jednoho kola** – u spotřebitele se nepřiměřená pokuta neuplatní celá (§ 1814 odst. 1 písm. l), § 1815 OZ), soud ji nesnižuje | nastavení | 300 Kč |
| `{{POPLATEK_CISTENI}}` | Paušál za umytí silně znečištěného kola | nastavení | 200 Kč za kolo |
| `{{POPLATEK_NABITI}}` | Paušál za nabití e-kola vráceného pod 20 % (0 Kč = řádek se netiskne) | nastavení | 0 Kč |
| `{{LHUTA_VYUCTOVANI_SKODY}}` | Do kdy vyúčtujeme škodu, kterou nelze vyčíslit na místě | nastavení | 14 dnů od vrácení |
| `{{LHUTA_UHRADY_SKODY}}` | Splatnost náhrady převyšující kauci | nastavení | 14 dnů od doručení vyúčtování |
| `{{LHUTA_VRATKY_KAUCE_PREVODEM}}` | Do kdy vrátíme hotovostní kauci nebo její zadrženou část převodem na účet nájemce, nelze-li ji vrátit hotově na místě (nájemce nepřítomen, vrácení mimo otevírací dobu, konečné vyúčtování) | nastavení | 5 pracovních dnů |
| `{{DOKLADY_AKCEPTOVANE}}` | Přijímané doklady totožnosti | nastavení | občanský průkaz, cestovní pas nebo řidičský průkaz |
| `{{PRILBA_PODMINKY}}` | Podmínky zapůjčení přilby | nastavení | zdarma na vyžádání |
| `{{UZEMI_UZIVANI}}` | Území, kde lze kolo užívat | nastavení | území České republiky |
| `{{SPOLUUCAST_KRADEZ}}` | Volitelné omezení náhrady při krádeži řádně uzamčeného a nahlášeného kola (text nebo prázdné) | nastavení | neuplatňuje se |
| `{{POJISTENI}}` | Informace o pojištění kol | nastavení | kola nejsou pojištěna pro případ škody způsobené nájemcem |
| `{{DOBA_CISLO_DOKLADU}}` | Jak dlouho po vrácení kola a vypořádání kauce držíme typ a číslo dokladu (pak automatický výmaz) | nastavení | 30 dní |
| `{{DOBA_SMLOUVA}}` | Jak dlouho uchováváme smlouvu, protokoly a fotodokumentaci | nastavení | 3 roky od vrácení kola |
| `{{ZAPISOVAT_NAROZENI_ADRESU}}` | Zapisovat do smlouvy i datum narození a adresu nájemce? (rozhodnutí půjčovny, viz „K ověření advokátem“ bod 9). **Při `ano`:** údaje se zapisují **podle sdělení nájemce**, nikdy opisem z občanského průkazu (§ 39 písm. d) zákona o občanských průkazech), a je nutné zároveň upravit Zásady odd. 2 a 4 a Záznam o činnostech (činnost A3) – jinak jsou dokumenty v rozporu | nastavení | ne |
| `{{DOKLAD_CISLO_TISK}}` | Jak tisknout číslo dokladu: `maskovane` (jen poslední 3 znaky, plné číslo zůstává pouze šifrovaně v systému) nebo `plne`. **`plne` se uplatní jen při papírovém tisku** (`{{PODPIS_ZPUSOB}}` = papir); e-mailová kopie, HTML verze protokolu a náhled v adminu po výmazu jsou **vždy maskované** | nastavení | maskovane |
| `{{PODPIS_ZPUSOB}}` | Jak se podepisuje: `papir` (2 vyhotovení) nebo `obrazovka` (podpis prstem/stylusem na tabletu, kopie e-mailem – bez obrázku podpisu, viz `{{PODPIS_NAJEMCE}}`) | nastavení | obrazovka |
| `{{OBSLUHA_JMENO_FORMAT}}` | Jak se na listinu tiskne jméno obsluhy: `plne` nebo `jmeno_a_iniciala` (jméno a iniciála příjmení); plné jméno a ID účtu zůstávají v systému (`handovers.by_user_id`) | nastavení | jmeno_a_iniciala |
| **Dokumenty a verze** | | | |
| `{{VERZE}}` | Verze této šablony (každá změna textu = nová verze) | nastavení | 1.1 (po zapracování oponentury) |
| `{{UCINNOST_OD}}` | Účinnost této verze šablony | nastavení | – |
| `{{OP_VERZE}}` | Verze OP, kterou nájemce odsouhlasil při rezervaci (z `reservations.terms_version`); u rezervace na místě aktuálně účinná verze | rezervace | – |
| `{{ZASADY_VERZE}}` | Verze Zásad účinná v den převzetí | nastavení | – |
| `{{SMLOUVA_CISLO}}` | Číslo smlouvy / předávacího protokolu (číselná řada `documents`, typ `contract`, per rok) | systém | *(příklad)* S-2026-000123 |
| `{{PROTOKOL_VRACENI_CISLO}}` | Číslo protokolu o vrácení (typ `handover`) | systém | *(příklad)* V-2026-000123 |
| `{{KONECNY_DOKLAD_CISLO}}` | Číslo konečného (daňového) dokladu vystaveného při vrácení | systém | – |
| `{{DOKLAD_POPLATEK_CISLO}}` | Číslo dokladu o přijetí rezervačního poplatku | systém | – |
| **Rezervace** | | | |
| `{{REZERVACE_CISLO}}` | Číslo rezervace (= variabilní symbol) | rezervace | *(příklad)* 2610000123 |
| `{{REZERVACE_DATUM}}` | Datum a čas odeslání rezervace | rezervace | – |
| `{{REZERVACE_POTVRZENI_DATUM}}` | Datum a čas e-mailu „Potvrzení rezervace“ (okamžik uzavření smlouvy podle OP čl. 3) | rezervace | – |
| `{{NAJEM_OD}}` | Sjednaný začátek nájmu (datum a čas) | rezervace | – |
| `{{NAJEM_DO}}` | Sjednaný konec nájmu (datum a čas) | rezervace | – |
| `{{MISTO_VRACENI}}` | Místo vrácení kol | rezervace | {{PUJCOVNA_PROVOZOVNA}} |
| `{{CENA_CELKEM}}` | Celkové nájemné za všechna kola a příslušenství za celý termín | rezervace | – |
| `{{POPLATEK_ZAPLACENO}}` | Součet zaplacených rezervačních poplatků | rezervace | – |
| `{{POPLATEK_ZAPLACENO_DNE}}` | Datum připsání poplatku | rezervace | – |
| `{{DOPLATEK}}` | Doplatek = cena − zaplacený poplatek (± přeplatek) | rezervace | – |
| `{{DOPLATEK_STAV}}` | Stav doplatku při převzetí: „zaplacen online dne …“ / „hotově při převzetí“ / „kartou (terminál) při převzetí“ – zapisuje se jen v B.4 | rezervace + obsluha | – |
| `{{K_UHRADE_PRI_PREVZETI}}` | Co zbývá zaplatit při převzetí (doplatek, je-li nezaplacen; bez kauce) | systém | – |
| `{{KAUCE_CELKEM}}` | Součet kaucí za všechna kola | rezervace | – |
| **Nájemce** | | | |
| `{{NAJEMCE_JMENO}}` | Jméno a příjmení nájemce | rezervace | – |
| `{{NAJEMCE_TELEFON}}` | Telefon | rezervace | – |
| `{{NAJEMCE_EMAIL}}` | E-mail (sem jde kopie protokolů a dokladů) | rezervace | – |
| `{{NAJEMCE_DOKLAD_TYP}}` | Typ předloženého dokladu (OP / pas / ŘP) – jen zápis | obsluha | – |
| `{{NAJEMCE_DOKLAD_CISLO}}` | Číslo dokladu – ukládá se jen šifrovaně v systému (`customers.id_doc_number_enc`); na listinu se tiskne podle `{{DOKLAD_CISLO_TISK}}` | obsluha | – |
| `{{NAJEMCE_DOKLAD_CISLO_TISK}}` | Číslo dokladu ve tvaru pro tisk (maskované „•••••123“ nebo plné) | systém | – |
| `{{NAJEMCE_DATUM_NAROZENI}}` | Datum narození – jen při `{{ZAPISOVAT_NAROZENI_ADRESU}}` = ano; **podle sdělení nájemce**, neopisuje se z dokladu | nájemce (zapíše obsluha) | – |
| `{{NAJEMCE_ADRESA}}` | Adresa bydliště – jen při `{{ZAPISOVAT_NAROZENI_ADRESU}}` = ano; **podle sdělení nájemce**, neopisuje se z dokladu | nájemce (zapíše obsluha) | – |
| `{{NAJEMCE_UCET_VRATKA}}` | Číslo účtu nájemce pro vrácení hotovostní kauce nebo její zadržené části, nelze-li vrátit hotově na místě. Vyplní nájemce při převzetí jen u `{{KAUCE_FORMA}}` = hotove, nebo dodatečně přes Správu rezervace / e-mailem (`customers.refund_account_enc`, nové pole) | nájemce | – |
| `{{POCET_DALSICH_JEZDCU}}` | Počet dalších osob, které budou kola užívat (bez jmen) | rezervace / obsluha | 0 |
| `{{POCET_NEZLETILYCH}}` | Z toho mladších 18 let | obsluha | 0 |
| **Kola** *(opakuje se pro každé kolo)* | | | |
| `{{KOLO_PORADI}}` | Pořadové číslo kola v protokolu | systém | 1, 2, … |
| `{{KOLO_TYP}}` | Typ / model kola (`bike_types.name`) | rezervace | *(příklad)* Trekové kolo Trek FX 2 |
| `{{KOLO_JE_EKOLO}}` | Je to elektrokolo? Řídí řádky [E-KOLO] | rezervace | ne |
| `{{KOLO_INVENTARNI_KOD}}` | Inventární kód na štítku s QR (`bikes.inventory_code`) | obsluha (sken) | *(příklad)* TK-07 |
| `{{KOLO_VELIKOST}}` | Velikost rámu | rezervace | *(příklad)* M / 17" |
| `{{KOLO_VYROBNI_CISLO}}` | Výrobní číslo rámu (`bikes.frame_no_enc`) – pro policii při krádeži | systém | – |
| `{{KOLO_HODNOTA}}` | Obvyklá cena kola podle evidence půjčovny k datu převzetí – **horní hranice náhrady** při poškození, ztrátě, zničení či krádeži (OP čl. 10.2–10.3; v OP parametr HODNOTA_KOLA). Skutečná náhrada se řídí § 2969 odst. 1 OZ (obvyklá cena v době poškození, resp. účelné náklady opravy); evidenci aktualizovat nejméně ročně | systém (evidence kol) | – |
| `{{KOLO_KAUCE}}` | Kauce za toto kolo | systém | {{KAUCE_KOLO}} / {{KAUCE_EKOLO}} |
| `{{KOLO_PRISLUSENSTVI}}` | Předané příslušenství (zámek + počet klíčů, přilba, nabíječka, baterie, světla, brašna, sada na defekt, dětská sedačka/vozík) s cenou náhrady podle ceníku | obsluha | – |
| `{{KOLO_BATERIE_PROCENTA}}` | [E-KOLO] Nabití baterie při předání | obsluha | – |
| `{{KOLO_POSKOZENI_POZNAMKA}}` | Existující poškození a opotřebení při předání (text) | obsluha | „bez poškození“ |
| `{{KOLO_FOTO_POCET}}` | Počet fotografií kola pořízených při předání a uložených v systému k protokolu | systém | – |
| **Kauce – záznam při převzetí** | | | |
| `{{KAUCE_FORMA}}` | Zvolená forma: `hotove` / `terminal` / `preautorizace` | obsluha | – |
| `{{KAUCE_TERMINAL_REF}}` | Číslo transakce terminálu (účtenka) při formě `terminal` | obsluha | – |
| `{{KAUCE_PREAUTH_REF}}` | Identifikátor preautorizace u brány (bez čísla karty; brána + poslední 4 číslice) | systém | – |
| `{{KAUCE_PREAUTH_PLATNOST_DO}}` | Do kdy blokace platí (podle brány 4–7 dní, Comgate 7 dní); vždy pozdější než `{{NAJEM_DO}}`, protože `{{PREAUTH_MAX_DNU}}` je z platnosti blokace odvozeno | systém | – |
| **Předání – vyplní obsluha** | | | |
| `{{PREDANI_CAS}}` | Skutečný datum a čas předání kol | systém | – |
| `{{OBSLUHA_JMENO}}` | Jméno člena obsluhy, který kola vydal (účet v adminu), ve tvaru podle `{{OBSLUHA_JMENO_FORMAT}}` | systém | – |
| `{{PODPIS_NAJEMCE}}` | Podpis nájemce (obrázek podpisu z obrazovky, nebo prázdná linka k podpisu na papíře). **V e-mailové kopii a HTML verzi se obrázek nahrazuje textem** „podepsáno elektronicky dne {{PREDANI_CAS}} (resp. {{VRACENI_CAS}}), záznam č. {{SMLOUVA_CISLO}} / {{PROTOKOL_VRACENI_CISLO}}“; obrázek zůstává jen šifrovaně v systému | obsluha | – |
| `{{PODPIS_OBSLUHA}}` | Podpis za půjčovnu | obsluha | – |
| **Vrácení – vyplní obsluha** | | | |
| `{{VRACENI_CAS}}` | Skutečný datum a čas vrácení (okamžik převzetí obsluhou) | systém | – |
| `{{VRACENI_OBSLUHA_JMENO}}` | Člen obsluhy, který kola převzal, ve tvaru podle `{{OBSLUHA_JMENO_FORMAT}}` | systém | – |
| `{{VRACENI_ZPOZDENI}}` | Zpoždění proti `{{NAJEM_DO}}` (po odečtení tolerance; 0 = včas) | systém | – |
| `{{VRACENI_MIMO_OTEVIRACI_DOBU}}` | `ne` / `ano – po domluvě` / `ano – bez domluvy` | obsluha | ne |
| `{{VRACENI_BEZ_KONTROLY}}` | Nájemce odjel bez společné kontroly (ano/ne). Při `ano` provede obsluha kontrolu nejpozději do konce následující otevírací doby, fotografie s časem pořízení jdou nájemci e-mailem a platí vyvratitelná domněnka podle C.1; protokol podepisuje jen obsluha (C.5) | obsluha | ne |
| `{{KOLO_VRACENI_STAV}}` | *(per kolo)* Souhrn stavu při vrácení (v pořádku / poškozeno / chybí) | obsluha | – |
| `{{KOLO_VRACENI_POSKOZENI}}` | *(per kolo)* Popis nového poškození (co, kde, rozsah) | obsluha | – |
| `{{KOLO_VRACENI_FOTO_POCET}}` | *(per kolo)* Počet fotografií poškození uložených v systému | systém | – |
| `{{KOLO_VRACENI_BATERIE_PROCENTA}}` | *(per kolo)* [E-KOLO] Nabití baterie při vrácení | obsluha | – |
| `{{KOLO_VRACENI_PRISLUSENSTVI_CHYBI}}` | *(per kolo)* Chybějící nebo zničené příslušenství | obsluha | „nic“ |
| `{{NAJEMNE_PRODLENI}}` | Nájemné za dobu prodlení (OP čl. 11.3) | systém | 0 Kč |
| `{{POKUTA_OTEVIRACI_DOBA}}` | Smluvní pokuta za vrácení po otevírací době bez domluvy (OP čl. 11.4) | systém | 0 Kč |
| `{{CASTKA_CISTENI}}` | Paušál za umytí (OP čl. 11.5) | obsluha | 0 Kč |
| `{{CASTKA_NABITI}}` | Paušál za nabití (OP čl. 11.6) | obsluha | 0 Kč |
| `{{SKODA_POPIS}}` | Popis škody na kolech (souhrn) | obsluha | – |
| `{{SKODA_CASTKA}}` | Vyčíslená náhrada škody (účelné náklady opravy podle ceníku oprav / obvyklá cena kola v době poškození), nejvýše `{{KOLO_HODNOTA}}` | obsluha | 0 Kč |
| `{{SKODA_JE_ODHAD}}` | Je částka jen odhad (nutná diagnostika v servisu)? Pak se nezapočítává, ale zadržuje jako jistota (`{{KAUCE_DRZENO}}`) a platí lhůta `{{LHUTA_VYUCTOVANI_SKODY}}` | obsluha | ne |
| `{{NAHRADA_PRISLUSENSTVI}}` | Paušál za ztracené/zničené příslušenství (OP čl. 10.4) | obsluha | 0 Kč |
| `{{VYUCTOVANI_CELKEM}}` | Součet všech položek vyúčtování | systém | 0 Kč |
| `{{KAUCE_POUZITO}}` | Část kauce **započtená** (§ 1982 OZ) – jen na položky vyúčtování vyčíslené na místě, které nájemce v C.5 odsouhlasil nebo nerozporoval | systém | 0 Kč |
| `{{KAUCE_DRZENO}}` | Část kauce **zadržená jako jistota** (§ 2010 odst. 1 OZ, není započtením) do výše odhadu škody, kterou nelze vyčíslit na místě, nebo částky, kterou nájemce rozporuje – vyúčtuje se do `{{LHUTA_VYUCTOVANI_SKODY}}`, resp. po vyřízení námitek | systém | 0 Kč |
| `{{KAUCE_VRACENO}}` | Část kauce vrácená / uvolněná ihned | systém | = {{KAUCE_CELKEM}} |
| `{{KAUCE_VRACENO_FORMA}}` | Jak byla vrácena: hotově na místě / na kartu přes terminál / uvolnění preautorizace (ref.) / převodem na `{{NAJEMCE_UCET_VRATKA}}` do `{{LHUTA_VRATKY_KAUCE_PREVODEM}}` (hotovostní kauce, není-li nájemce při kontrole přítomen) | obsluha / systém | – |
| `{{ZBYVA_DOPLATIT}}` | Škoda převyšující kauci, splatná do `{{LHUTA_UHRADY_SKODY}}` | systém | 0 Kč |
| `{{ZBYVA_VRATIT}}` | Část zadržené kauce, kterou vrátíme po konečném vyúčtování nebo vyřízení námitek – stejnou formou, jakou byla složena; u hotovosti převodem na `{{NAJEMCE_UCET_VRATKA}}` | systém | 0 Kč |
| `{{QR_DOPLATEK}}` | QR Platba (SPAYD) na `{{ZBYVA_DOPLATIT}}` s VS = číslo rezervace – tiskne se, jen je-li částka > 0 | systém | – |
| `{{NAMITKY_TEXT}}` | Námitky nájemce k vyúčtování (volný text) | nájemce / obsluha | – |

---

# ČÁST A – Smlouva o nájmu jízdního kola č. {{SMLOUVA_CISLO}}

*(k rezervaci č. {{REZERVACE_CISLO}}; Obchodní podmínky verze {{OP_VERZE}}, Zásady ochrany osobních údajů verze {{ZASADY_VERZE}})*

## 1. Kdo s kým smlouvu uzavírá

**Půjčovna (pronajímatel, „my“):** {{PUJCOVNA_NAZEV}}, IČO {{PUJCOVNA_ICO}} [VARIANTA A: , DIČ {{PUJCOVNA_DIC}}], sídlo {{PUJCOVNA_SIDLO}}, {{PUJCOVNA_REJSTRIK}}. Výdejní místo: {{PUJCOVNA_PROVOZOVNA}}, otevírací doba {{OTEVIRACI_DOBA}}. Kontakt: {{PUJCOVNA_TELEFON}}, {{PUJCOVNA_EMAIL}}, web {{WEB_SUBDOMENA}}. Při předání nás zastupuje {{OBSLUHA_JMENO}} (pověřená osoba, § 430 odst. 1 OZ).

**Nájemce („vy“):** {{NAJEMCE_JMENO}}, tel. {{NAJEMCE_TELEFON}}, e-mail {{NAJEMCE_EMAIL}}. Předložený doklad totožnosti: {{NAJEMCE_DOKLAD_TYP}} č. {{NAJEMCE_DOKLAD_CISLO_TISK}} – do dokladu jsme jen nahlédli a zapsali jeho typ a číslo; nekopírujeme ho a nepřijímáme jako zástavu (§ 39 písm. b) a c) zákona o občanských průkazech). **Předložíte-li občanský průkaz, podpisem souhlasíte se zapsáním jeho typu a čísla pro účely této smlouvy (§ 39 písm. d) zákona o občanských průkazech); místo občanského průkazu můžete předložit cestovní pas nebo řidičský průkaz** (přijímáme: {{DOKLADY_AKCEPTOVANE}}). Bez předložení dokladu kolo nevydáme (OP čl. 8.2–8.3). *(Jen při {{ZAPISOVAT_NAROZENI_ADRESU}} = ano:)* Datum narození a bydliště **podle vašeho sdělení** (z dokladu je neopisujeme): {{NAJEMCE_DATUM_NAROZENI}}, {{NAJEMCE_ADRESA}}. *(Jen při {{KAUCE_FORMA}} = hotove:)* Účet pro vrácení kauce, nebude-li možné ji vrátit hotově na místě (čl. 4.2 a): {{NAJEMCE_UCET_VRATKA}} – lze doplnit i později přes Správu rezervace.

**Další jezdci:** kola budou užívat i další osoby bez vlastní smlouvy – počet {{POCET_DALSICH_JEZDCU}}, z toho mladších 18 let {{POCET_NEZLETILYCH}}. Za jejich užívání kol odpovídáte vy (OP čl. 2.3 a 8.2).

## 2. Co si půjčujete a na jak dlouho

2.1 Pronajímáme vám k dočasnému užívání kola a příslušenství uvedená v **předávacím protokolu (část B)**, který je součástí této smlouvy (§ 2201 a § 2321 OZ – nájem dopravního prostředku).

2.2 **Doba nájmu: od {{NAJEM_OD}} do {{NAJEM_DO}}.** Kola vrátíte na místě {{MISTO_VRACENI}} nejpozději v uvedený čas, v otevírací době. Zpoždění do {{TOLERANCE_POZDNI}} neúčtujeme; za delší prodlení platíte další nájemné ({{SAZBA_POZDNI}}, OP čl. 11.3); za vrácení po konci otevírací doby bez předchozí telefonické domluvy smluvní pokutu {{POPLATEK_POZDNI_PAUSAL}} za rezervaci – kryje náklady na obsluhu, která na vás musí čekat nebo se kvůli vám vrátit mimo otevírací dobu, a nahrazuje náhradu škody za tento čas (OP čl. 11.4; § 2048 odst. 1 a § 2050 OZ). Zdržíte-li se, zavolejte {{PUJCOVNA_TELEFON}} – prodloužení domluvíme, je-li kolo volné.

2.3 **[ONLINE]** Smlouva vznikla potvrzením vaší rezervace č. {{REZERVACE_CISLO}} (odeslána {{REZERVACE_DATUM}}, potvrzena {{REZERVACE_POTVRZENI_DATUM}}) podle OP čl. 3. Tato listina ji potvrzuje a doplňuje o konkrétní kola, kauci a stav při předání; spolu s OP verze {{OP_VERZE}}, které jste při rezervaci odsouhlasili, a s potvrzením rezervace tvoří úplnou smlouvu (OP čl. 15.6). Údaje o kolech, příslušenství, kauci a čase vrácení platí podle protokolu, ve všem ostatním platí OP (OP čl. 8.7; § 1751 odst. 1 OZ).
**[NA MÍSTĚ]** Rezervaci č. {{REZERVACE_CISLO}} jsme založili na výdejním místě; smlouva vzniká podpisem této listiny. Obchodní podmínky verze {{OP_VERZE}} jsme vám před podpisem předložili (vytištěné / na obrazovce) a jsou trvale dostupné na {{PODMINKY_URL}}; stávají se součástí smlouvy (§ 1751 odst. 1 OZ). Podpisem potvrzujete, že jste se s nimi seznámili, zejména s přehledem všech částek, které vám můžeme účtovat (OP čl. 4.7), a souhlasíte s nimi.

## 3. Cena a platby

| Položka | Částka | Poznámka |
|---|---|---|
| Nájemné celkem (kola + příslušenství, celý termín) | **{{CENA_CELKEM}}** | [VARIANTA A: včetně DPH] [VARIANTA B: nejsme plátci DPH] |
| Zaplacený rezervační poplatek | − {{POPLATEK_ZAPLACENO}} | zaplacen {{POPLATEK_ZAPLACENO_DNE}}, doklad č. {{DOKLAD_POPLATEK_CISLO}}; {{POPLATEK_KOLO}} za kolo / {{POPLATEK_EKOLO}} za elektrokolo; je částečnou úhradou nájemného zaplacenou předem a odečítá se v plné výši; storno před převzetím se řídí OP čl. 6 |
| Doplatek | **{{DOPLATEK}}** | stav úhrady je zapsán v části B.4 |
| **Zbývá zaplatit při převzetí** | **{{K_UHRADE_PRI_PREVZETI}}** | hotově nebo kartou přes terminál; kauce (čl. 4) se platí zvlášť |

Nájemné platíte předem; tím se po dohodě odchylujeme od § 2324 OZ (OP čl. 4.3). **[VARIANTA A]** Doklad k přijatému rezervačnímu poplatku jsme vystavili do 15 dnů od jeho přijetí (§ 28 odst. 8 ZDPH); po skončení nájmu vystavíme konečný daňový doklad, v němž se základ daně sníží o základ daně z již zdaněného poplatku (§ 37a ZDPH; OP čl. 4.5). **[VARIANTA B]** Po skončení nájmu vystavíme konečné vyúčtování s odečtením poplatku. Storno rezervace se týká jen doby před převzetím (OP čl. 6, {{STORNO_TABULKA}}); od převzetí kol se nájemné za nevyužitou dobu nevrací (OP čl. 11.7).

## 4. Kauce

4.1 **Výše: {{KAUCE_CELKEM}}** ({{KAUCE_KOLO}} za kolo, {{KAUCE_EKOLO}} za elektrokolo; rozpis u každého kola v části B). Kauce je vratná jistota (§ 2010 odst. 1 OZ) pro naše pohledávky z této smlouvy – náhradu škody, ztráty nebo krádeže kola či příslušenství, nájemné za prodlení, smluvní pokutu a paušály podle OP čl. 11 (OP čl. 5.3). Není součástí ceny ani limitem vaší odpovědnosti (OP čl. 5.5) a není pojištěním. **[VARIANTA A]** Kauce není úplatou za plnění, nepodléhá DPH (§ 2 odst. 1 ZDPH) a nevystavuje se k ní daňový doklad; její přijetí a vrácení potvrzujeme jen v protokolu.

4.2 **Forma.** Kauci skládáte jednou z těchto forem; **zvolená forma a reference transakce jsou zapsány v části B.4**:
- **a) hotově** – vracíme hotově ihned při řádném vrácení kol; nejste-li při kontrole kol přítomni (čl. C.1), převodem na účet uvedený v čl. 1 do {{LHUTA_VRATKY_KAUCE_PREVODEM}}.
- **b) platební kartou přes terminál** – jde o skutečnou platbu, kterou při vrácení pošleme zpět na tutéž kartu (připsání podle vaší banky obvykle 1–5 pracovních dnů).
- **c) preautorizace (blokace) na platební kartě** přes bránu {{PLATEBNI_BRANA}} – částka se z karty **nestrhává, pouze blokuje**; po dobu blokace s ní nemůžete disponovat. Blokace platí do data uvedeného v B.4, proto je tato forma možná jen u nájmu nejdéle na {{PREAUTH_MAX_DNU}} dní; **u delšího nájmu nabízíme jen kauci hotově nebo terminálem.** Při řádném vrácení blokaci ihned uvolníme; vaše banka uvolnění zobrazí zpravidla do několika pracovních dnů (závisí na vydavateli karty, ne na nás).

4.3 **Vrácení kauce.** Vrátíte-li kola včas, čistá, kompletní a nepoškozená, vrátíme (uvolníme) kauci **ihned při vrácení v plné výši**. Zjistíme-li škodu nebo jiný dluh, rozlišujeme dvě situace (OP čl. 5.4 a 10.7):
- **a) částku vyčíslenou na místě** (nájemné za prodlení, smluvní pokuta, paušály, oprava podle ceníku), kterou v protokolu o vrácení odsouhlasíte nebo nerozporujete, **započteme** na kauci (§ 1982 OZ) a zbytek ihned vrátíme;
- **b) odhad škody, kterou nelze vyčíslit na místě, a částku, kterou rozporujete, nezapočítáváme** – z kauce **zadržíme jako jistotu** (§ 2010 odst. 1 OZ) jen část do výše odhadu, zbytek ihned vrátíme; zadrženou část vyúčtujeme s doklady do {{LHUTA_VYUCTOVANI_SKODY}} (u námitek po jejich vyřízení, OP čl. 12.5) a co nebylo oprávněně použito, vrátíme bez zbytečného odkladu stejnou formou, jakou jste kauci složili (u hotovosti převodem na účet z čl. 1). U preautorizace zadrženou část z blokace strhneme, protože blokace by dříve vypršela; i tak jde o vaši jistotu, ne o započtení.

Je-li dluh vyšší než kauce, rozdíl je splatný do {{LHUTA_UHRADY_SKODY}} od doručení vyúčtování.

4.4 **Prodloužení nájmu.** Původně sjednaná doba nájmu platnost blokace vždy pokryje (čl. 4.2 c). Dohodneme-li **prodloužení** nájmu přes dobu platnosti blokace, složíte kauci znovu (nová preautorizace, hotově nebo terminálem) nejpozději v den, kdy blokace končí; jinak kola vrátíte v původně sjednaném čase. Kauce složené hotově nebo terminálem se prodloužení netýká.

## 5. Vaše hlavní povinnosti – poučení

Podrobně v OP čl. 9–12. Zejména:

- **Užívání.** Kolo užívejte šetrně, k účelu, pro který je určeno, a udržujte ho ve stavu, v jakém jste ho převzali, s přihlédnutím k obvyklému opotřebení (§ 2213, § 2325 odst. 1 OZ). Dodržujte pravidla silničního provozu; **jízda pod vlivem alkoholu nebo jiných návykových látek je zakázána** (§ 5 odst. 2 písm. a) a b) zákona o silničním provozu).
- **Zámek.** Kdykoli kolo opustíte, i na okamžik, uzamkněte ho dodaným zámkem **za rám k pevnému předmětu**; přes noc ho uložte do uzamčené místnosti. [E-KOLO] Baterii při delším parkování vyjměte a vezměte s sebou.
- **Přilba.** Cyklista mladší 18 let musí mít za jízdy nasazenou a řádně připevněnou přilbu (§ 58 odst. 1 zákona o silničním provozu). Všem ostatním přilbu důrazně doporučujeme. Zapůjčení přilby: {{PRILBA_PODMINKY}}.
- **Zákaz předání třetí osobě a komerčního užití.** Kolo nesmíte přenechat nikomu jinému než jezdcům uvedeným v čl. 1 (§ 2215 odst. 1 OZ – jen s naším souhlasem), půjčovat ho dál, **užívat ke komerčním účelům (rozvoz, kurýrní služba, pronájem, výuka za úplatu) ani k přepravě osob nebo nákladu nad rámec výbavy a nosnosti kola**. Zakázány jsou závody, bikeparky, skoky a triky, úpravy kola, [E-KOLO] zásahy do pohonu a baterie a jiná než dodaná nabíječka, a jízda mimo {{UZEMI_UZIVANI}} bez naší domluvy (OP čl. 9.1 a 9.3).
- **Závada.** Zjistíte-li závadu ovlivňující bezpečnost nebo funkci, přestaňte jezdit a zavolejte {{PUJCOVNA_TELEFON}} (§ 2214 OZ; OP čl. 12.2). **Je-li kolo nezpůsobilé k jízdě, máte právo je vrátit a žádat odstranění vady, jiné kolo, nebo zrušení smlouvy s vrácením nájemného za nevyužitou dobu (§ 2322 odst. 3 OZ); nemůžeme-li závadu odstranit ani kolo vyměnit bez zbytečného odkladu, máte právo na přiměřenou slevu (§ 2208 odst. 1 OZ).** Opravy bez domluvy nezadávejte (OP čl. 9.5); reklamace OP čl. 12.
- **Krádež.** Krádež kola, baterie nebo příslušenství **neprodleně oznamte Policii ČR (158) a nám**; předáte nám číslo jednací oznámení, zámek s klíči a popis, jak bylo kolo uzamčeno (OP čl. 10.5). Krádež je trestný čin (§ 205 TZ); policii poskytneme výrobní číslo z části B.
- **Nehoda.** Při zranění volejte 155/112. Každou nehodu, při které se kolo poškodilo, nám oznamte co nejdříve, nejpozději při vrácení.
- **Odpovědnost za škodu.** Od převzetí do vrácení odpovídáte za poškození, zničení, ztrátu i odcizení kola a příslušenství, i když je způsobil jiný jezdec nebo vznikly při pádu bez cizího zavinění (§ 2913 odst. 1 OZ; OP čl. 10.1). Při poškození hradíte skutečné účelně vynaložené náklady opravy; při ztrátě, zničení nebo krádeži obvyklou cenu kola **v době, kdy ke škodě došlo** (§ 2969 odst. 1 OZ) – v obou případech **nejvýše částku uvedenou u kola v části B, která je horní hranicí náhrady** (OP čl. 10.2–10.3); za příslušenství paušály podle ceníku náhrad ({{CENIK_URL}}; OP čl. 10.4). Neodpovídáte za běžné opotřebení ani za vady, které kolo mělo při převzetí. {{SPOLUUCAST_KRADEZ}} {{POJISTENI}}. Za újmu, kterou způsobíte sobě nebo jiným, odpovídá jezdec (OP čl. 10.9).
- **Vrácení.** Kola vraťte včas, kompletní a běžně čistá (silné znečištění: paušál {{POPLATEK_CISTENI}} za kolo); [E-KOLO] pokud možno nabitá *(jen je-li {{POPLATEK_NABITI}} > 0:)* – pod 20 % účtujeme {{POPLATEK_NABITI}}. Nevrátíte-li kolo do 24 hodin po konci nájmu a nebudete reagovat, postupujeme podle OP čl. 11.8.

## 6. Vaše prohlášení

Podpisem potvrzujete, že:

- ☐ je vám **nejméně 18 let** a jste plně svéprávný (§ 30 odst. 1 OZ); předložili jste platný doklad podle čl. 1;
- ☐ kola a příslušenství jste si **prohlédli**; jejich stav odpovídá části B a jiné poškození jste při prohlídce nezjistili. Víte, že kolo nezpůsobilé k provozu máte právo odmítnout (§ 2322 odst. 3 OZ) a že se zápis v části B zohlední při vrácení (§ 2225 odst. 1 OZ): poškození, které v B.3 není zapsáno, se má za vzniklé během nájmu, můžete však prokázat opak;
- ☐ [E-KOLO] absolvovali jste **zaškolení** k elektrokolu (zapínání, režimy, dojezd, baterie a nabíjení, displej, zamykání – OP čl. 8.5) a pokynům rozumíte;
- ☐ seznámili jste se s **Obchodními podmínkami verze {{OP_VERZE}}** ({{PODMINKY_URL}}); kopii máte v potvrzovacím e-mailu / dostanete e-mailem spolu s touto smlouvou;
- ☐ dostali jste **informace o zpracování osobních údajů** (čl. 13 GDPR): správcem je {{PUJCOVNA_NAZEV}}. Jméno, kontakt, údaje o rezervaci, smlouvu, protokoly, fotografie kol a váš podpis zpracováváme pro plnění smlouvy a vedení účetnictví (čl. 6 odst. 1 písm. b) a c) GDPR) a uchováváme {{DOBA_SMLOUVA}}, účetní a daňové doklady po zákonnou dobu. Typ a číslo dokladu zapisujeme na základě oprávněného zájmu – ochrana majetku a vymáhání škody (čl. 6 odst. 1 písm. f) GDPR; u občanského průkazu navíc s vaším souhlasem podle čl. 1) – **bez předložení dokladu kolo nevydáme** (OP čl. 8.2); číslo držíme šifrovaně a automaticky ho smažeme {{DOBA_CISLO_DOKLADU}} po vrácení kol a vypořádání kauce, **déle jen při nevyřešené škodě, krádeži nebo nezaplacení**. Údaje vidí provozovatel systému {{PROVOZOVATEL_NAZEV}} (zpracovatel), při platbě kartou nebo preautorizaci platební brána {{PLATEBNI_BRANA}} a při převodu naše banka (samostatní správci), dále e-mailová služba a účetní. Máte právo na přístup, opravu, výmaz, omezení, přenositelnost, **námitku** (čl. 21 GDPR) a stížnost u Úřadu pro ochranu osobních údajů. Úplné Zásady verze {{ZASADY_VERZE}}: {{ZASADY_URL}}. *(Toto je informace, ne žádost o souhlas se zpracováním podle GDPR – ten k uzavření smlouvy nepotřebujeme. Souhlas se zapsáním údajů z občanského průkazu vyžaduje zákon o občanských průkazech a dáváte ho předložením dokladu a podpisem, čl. 1.)*
- ☐ za jezdce uvedené v čl. 1 odpovídáte; u nezletilých jste jejich zákonný zástupce nebo máte jeho souhlas.

## 7. Závěrečná ujednání

7.1 Smlouva se řídí právem České republiky, zejména OZ a ZOS. Vady kola reklamujte podle OP čl. 12 – reklamaci vyřídíme do 30 dnů (§ 19 odst. 3 ZOS); námitky proti vyúčtování vyřídíme ve stejné lhůtě obdobně jako reklamaci (OP čl. 12.5). Spotřebitelský spor lze řešit mimosoudně u České obchodní inspekce, https://www.coi.gov.cz/informace-o-adr/ (§ 14 odst. 1 ZOS; OP čl. 13).

7.2 *(při {{PODPIS_ZPUSOB}} = papir:)* Smlouva je vyhotovena ve dvou stejnopisech, každá strana obdrží jeden. *(při {{PODPIS_ZPUSOB}} = obrazovka:)* Smlouvu podepisujete na obrazovce; takto zachycený obsah a podpis mají písemnou formu (§ 561 odst. 1 a § 562 odst. 1 OZ; § 7 zákona o el. podpisu) a kopii vám ihned pošleme na {{NAJEMCE_EMAIL}} – v kopii je číslo dokladu maskované a místo obrázku podpisu je záznam o elektronickém podpisu (čas, číslo smlouvy).

7.3 Ústní ujednání, která nejsou v této smlouvě nebo v protokolu, nejsou závazná (OP čl. 15.6). Šablona verze {{VERZE}}, účinná od {{UCINNOST_OD}}.

**V {{PUJCOVNA_PROVOZOVNA}} dne {{PREDANI_CAS}}**

| Nájemce | Za půjčovnu {{PUJCOVNA_NAZEV}} |
|---|---|
| {{NAJEMCE_JMENO}} | {{OBSLUHA_JMENO}} |
| {{PODPIS_NAJEMCE}} | {{PODPIS_OBSLUHA}} |

---

# ČÁST B – Předávací protokol č. {{SMLOUVA_CISLO}} (převzetí)

**Rezervace č. {{REZERVACE_CISLO}} · nájemce {{NAJEMCE_JMENO}} · předáno {{PREDANI_CAS}} · vydal(a) {{OBSLUHA_JMENO}} · vrátit do {{NAJEM_DO}} na {{MISTO_VRACENI}}**

## B.1 Předaná kola

| # | Typ / model | Inventární kód | Velikost | Výrobní číslo rámu | Obvyklá cena kola při převzetí = horní hranice náhrady (OP čl. 10.2–10.3) | Kauce |
|---|---|---|---|---|---|---|
| {{KOLO_PORADI}} | {{KOLO_TYP}} | {{KOLO_INVENTARNI_KOD}} | {{KOLO_VELIKOST}} | {{KOLO_VYROBNI_CISLO}} | {{KOLO_HODNOTA}} | {{KOLO_KAUCE}} |
| *(opakuje se pro každé kolo)* | | | | | | |
| **Celkem** | | | | | | **{{KAUCE_CELKEM}}** |

## B.2 Příslušenství předané s koly

| # kola | Příslušenství (druh, počet, u zámku počet klíčů, u baterie její číslo) | Náhrada při ztrátě (ceník náhrad, OP čl. 10.4) |
|---|---|---|
| {{KOLO_PORADI}} | {{KOLO_PRISLUSENSTVI}} | podle ceníku {{CENIK_URL}} |
| *(opakuje se pro každé kolo)* | | |

## B.3 Stav kol při předání

Zkontrolujeme společně. ☐ = v pořádku; jinak poznámka. Zápis v této části a fotografie pořízené při předání se podle § 2225 odst. 1 OZ zohlední při vrácení. **Má se za to, že poškození, které zde není zapsáno, při převzetí neexistovalo; můžete však prokázat opak** (např. vlastní fotografií). Proto si kolo prohlédněte pozorně a každé poškození nechte zapsat.

| Kontrolovaná část | Kolo {{KOLO_PORADI}} ({{KOLO_INVENTARNI_KOD}}) *(sloupec se opakuje pro každé kolo)* |
|---|---|
| Rám, vidlice, řídítka, představec (praskliny, promáčkliny) | ☐ |
| Brzdy přední / zadní (účinnost, destičky/špalky, lanka či hadice) | ☐ / ☐ |
| Řazení, převody, řetěz, kazeta (plynulost, opotřebení) | ☐ |
| Kola a pláště (dohuštění, centrování, stav plášťů, rychloupínáky) | ☐ |
| Osvětlení přední / zadní, odrazky, zvonek | ☐ / ☐ |
| Sedlo, sedlovka, pedály, stojánek, blatníky, nosič | ☐ |
| Zámek funkční, počet klíčů | ☐ … ks |
| [E-KOLO] Baterie – nabití {{KOLO_BATERIE_PROCENTA}} %, upevnění, klíč baterie, nabíječka | ☐ |
| [E-KOLO] Displej / ovladač, motor, zapnutí a přepínání režimů | ☐ |
| Celkově čisté, bez chybějících dílů | ☐ |
| **Existující poškození a opotřebení** (kde, co, rozsah) | {{KOLO_POSKOZENI_POZNAMKA}} |
| **Fotodokumentace** při předání (uložena v systému k tomuto protokolu, náhled na vyžádání) | {{KOLO_FOTO_POCET}} fotografií |

## B.4 Kauce a doplatek – záznam

| | |
|---|---|
| Kauce celkem | **{{KAUCE_CELKEM}}** |
| Forma ({{KAUCE_FORMA}}) | ☐ hotově (účet pro vratku: {{NAJEMCE_UCET_VRATKA}}) ☐ terminál (transakce č. {{KAUCE_TERMINAL_REF}}) ☐ preautorizace přes {{PLATEBNI_BRANA}} (ref. {{KAUCE_PREAUTH_REF}}, blokace do {{KAUCE_PREAUTH_PLATNOST_DO}}) |
| Doplatek {{DOPLATEK}} | {{DOPLATEK_STAV}} |
| Zaplaceno při převzetí | {{K_UHRADE_PRI_PREVZETI}} ☐ hotově ☐ terminál ☐ nic (vše zaplaceno předem) |

Převzetím kol a podpisem potvrzujete, že jste převzali kola a příslušenství podle tohoto protokolu ve stavu zde popsaném (s možností prokázat opak podle B.3), a my potvrzujeme přijetí kauce a plateb podle B.4. Předáním přechází rezervace do stavu „vydáno“.

| Nájemce | Za půjčovnu |
|---|---|
| {{NAJEMCE_JMENO}} | {{OBSLUHA_JMENO}} |
| {{PODPIS_NAJEMCE}} | {{PODPIS_OBSLUHA}} |

*Kopie smlouvy a protokolu odesílána na {{NAJEMCE_EMAIL}}. V kopii je číslo dokladu totožnosti **vždy maskované** (i při nastavení tisku `plne`, které platí jen pro papír) a obrázek podpisu je nahrazen textem „podepsáno elektronicky dne {{PREDANI_CAS}}, záznam č. {{SMLOUVA_CISLO}}“; plné číslo i obrázek podpisu zůstávají jen v zabezpečeném systému.*

---

# ČÁST C – Protokol o vrácení č. {{PROTOKOL_VRACENI_CISLO}}

**Ke smlouvě č. {{SMLOUVA_CISLO}} · rezervace č. {{REZERVACE_CISLO}} · nájemce {{NAJEMCE_JMENO}}**

## C.1 Čas a způsob vrácení

| | |
|---|---|
| Sjednaný konec nájmu | {{NAJEM_DO}} |
| Skutečné vrácení (převzetí obsluhou) | **{{VRACENI_CAS}}**, převzal(a) {{VRACENI_OBSLUHA_JMENO}} |
| Zpoždění po odečtení tolerance {{TOLERANCE_POZDNI}} | {{VRACENI_ZPOZDENI}} |
| Vrácení mimo otevírací dobu | {{VRACENI_MIMO_OTEVIRACI_DOBU}} |
| Společná kontrola s nájemcem | bez kontroly: {{VRACENI_BEZ_KONTROLY}} *(ne = kontrola proběhla společně; ano = nájemce odjel bez kontroly)*. Odjedete-li bez společné kontroly nebo vrátíte-li kola po domluvě mimo otevírací dobu, provedeme kontrolu sami **nejpozději do konce následující otevírací doby** a stav zdokumentujeme fotografiemi s časem pořízení; **má se za to, že takto zjištěný stav odpovídá stavu při vrácení, můžete však prokázat opak** (např. vlastní fotografií při odložení kol). Kopii fotografií vám pošleme e-mailem spolu s tímto protokolem (OP čl. 11.1–11.2). |

## C.2 Stav kol a příslušenství při vrácení

| # | Kolo (inv. kód) | Stav | Nové poškození – popis (porovnáno s částí B) | Foto | [E-KOLO] Baterie | Chybějící / zničené příslušenství |
|---|---|---|---|---|---|---|
| {{KOLO_PORADI}} | {{KOLO_INVENTARNI_KOD}} | {{KOLO_VRACENI_STAV}} | {{KOLO_VRACENI_POSKOZENI}} | {{KOLO_VRACENI_FOTO_POCET}} ks | {{KOLO_VRACENI_BATERIE_PROCENTA}} % | {{KOLO_VRACENI_PRISLUSENSTVI_CHYBI}} |
| *(opakuje se pro každé kolo)* | | | | | | |

Běžné opotřebení (sjeté pláště a destičky úměrné délce nájmu, drobné oděrky laku, prach z cesty) **není** poškozením a neúčtuje se (OP čl. 10.1, 11.5).

## C.3 Vyúčtování

| Položka | Základ | Částka |
|---|---|---|
| Nájemné za dobu prodlení | OP čl. 11.3 ({{SAZBA_POZDNI}}) | {{NAJEMNE_PRODLENI}} |
| Smluvní pokuta – vrácení po otevírací době bez domluvy | OP čl. 11.4 ({{POPLATEK_POZDNI_PAUSAL}}; § 2048 odst. 1 OZ; nahrazuje náhradu škody za tento čas, § 2050 OZ) | {{POKUTA_OTEVIRACI_DOBA}} |
| Umytí silně znečištěného kola | OP čl. 11.5 ({{POPLATEK_CISTENI}} za kolo) | {{CASTKA_CISTENI}} |
| [E-KOLO] Nabití baterie pod 20 % *(jen je-li {{POPLATEK_NABITI}} > 0)* | OP čl. 11.6 | {{CASTKA_NABITI}} |
| Náhrada škody na kolech: {{SKODA_POPIS}} | OP čl. 10.2–10.3; § 2969 odst. 1 OZ (účelné náklady opravy / obvyklá cena kola v době poškození); ceník oprav {{CENIK_URL}}; **nejvýše částka uvedená u kola v části B** | {{SKODA_CASTKA}} ☐ vyčísleno ☐ **odhad** ({{SKODA_JE_ODHAD}}) – odhad se nezapočítává, jen zadržuje (C.4); konečné vyúčtování s doklady do {{LHUTA_VYUCTOVANI_SKODY}} |
| Ztracené / zničené příslušenství | OP čl. 10.4, ceník náhrad | {{NAHRADA_PRISLUSENSTVI}} |
| **Celkem k úhradě** | | **{{VYUCTOVANI_CELKEM}}** |

Jiné částky než uvedené v OP čl. 4.7 neúčtujeme. **[VARIANTA A]** Nájemné za prodlení a paušály za umytí a nabití jsou úplatou za službu včetně DPH; smluvní pokuta a náhrada škody nejsou předmětem DPH (§ 2 odst. 1 ZDPH). Konečný daňový doklad č. {{KONECNY_DOKLAD_CISLO}}. **[VARIANTA B]** Konečné vyúčtování č. {{KONECNY_DOKLAD_CISLO}}.

## C.4 Vypořádání kauce

| | |
|---|---|
| Kauce složená při převzetí ({{KAUCE_FORMA}}) | {{KAUCE_CELKEM}} |
| **Započteno (odsouhlaseno / nerozporováno)** – částky vyčíslené na místě v C.3 (§ 1982 OZ; OP čl. 5.3) | − {{KAUCE_POUZITO}} |
| **Zadrženo jako jistota do vyčíslení odhadu nebo do vyřešení námitek** (§ 2010 odst. 1 OZ; není započtením – vyúčtujeme s doklady do {{LHUTA_VYUCTOVANI_SKODY}}, u námitek po jejich vyřízení, a nepoužitou část vrátíme) | − {{KAUCE_DRZENO}} |
| **Vráceno / uvolněno ihned** | **{{KAUCE_VRACENO}}** – {{KAUCE_VRACENO_FORMA}} (hotově ihned; terminál: zpět na tutéž kartu, připsání 1–5 pracovních dnů; preautorizace: uvolnění blokace, banka zobrazí do několika dnů; hotovostní kauce bez přítomnosti nájemce: převodem na {{NAJEMCE_UCET_VRATKA}} do {{LHUTA_VRATKY_KAUCE_PREVODEM}}) |
| Zbývá doplatit nad kauci (splatné do {{LHUTA_UHRADY_SKODY}} od doručení vyúčtování; při prodlení zákonný úrok, OP čl. 10.8) | **{{ZBYVA_DOPLATIT}}** {{QR_DOPLATEK}} |
| Zbývá vrátit po konečném vyúčtování / vyřízení námitek (stejnou formou jako kauce; u hotovosti převodem na {{NAJEMCE_UCET_VRATKA}}) | {{ZBYVA_VRATIT}} |

## C.5 Stanovisko nájemce

☐ **S vyúčtováním a vypořádáním kauce souhlasím.**
☐ **Nesouhlasím – námitky:** {{NAMITKY_TEXT}} *(rozporovanou částku nezapočítáváme; do vyřízení námitek ji vedeme jako zadrženou jistotu, C.4)*

Podpis nájemce potvrzuje vrácení kol, převzetí tohoto protokolu a vrácené části kauce; **není uznáním dluhu ve sporné části**. Nesouhlasíte-li s vyúčtováním, zapište námitky zde nebo je pošlete do 14 dnů na {{PUJCOVNA_EMAIL}}; vyřídíme je do 30 dnů obdobně jako reklamaci (OP čl. 12.5) a spornou část do vyřízení nevymáháme. Vady kola během nájmu reklamujte na {{PUJCOVNA_TELEFON}} nebo {{PUJCOVNA_EMAIL}}; reklamaci vyřídíme do 30 dnů (§ 19 odst. 3 ZOS; OP čl. 12.3–12.4). Nepodaří-li se spor urovnat, můžete se obrátit na Českou obchodní inspekci, https://www.coi.gov.cz/informace-o-adr/ (§ 14 ZOS; OP čl. 13).

*(při {{VRACENI_BEZ_KONTROLY}} = ano nebo {{VRACENI_MIMO_OTEVIRACI_DOBU}} = ano – po domluvě:)* Protokol podepisuje jen obsluha; kopii s fotografiemi z kontroly posíláme na {{NAJEMCE_EMAIL}} a námitky můžete uplatnit do 14 dnů od doručení (OP čl. 12.5). Hotovostní kauci nebo její zadrženou část vracíme převodem na {{NAJEMCE_UCET_VRATKA}} do {{LHUTA_VRATKY_KAUCE_PREVODEM}}; nemáme-li číslo účtu, doplňte ho přes Správu rezervace nebo e-mailem – lhůta běží od jeho sdělení.

Vrácením kol nájem končí; typ a číslo vašeho dokladu totožnosti smažeme automaticky {{DOBA_CISLO_DOKLADU}} po vypořádání kauce (déle jen při nevyřešené škodě, krádeži nebo nezaplacení). Kopii protokolu a konečný doklad posíláme na {{NAJEMCE_EMAIL}} (číslo dokladu maskované, místo obrázku podpisu záznam o elektronickém podpisu).

**V {{PUJCOVNA_PROVOZOVNA}} dne {{VRACENI_CAS}}**

| Nájemce | Za půjčovnu |
|---|---|
| {{NAJEMCE_JMENO}} | {{VRACENI_OBSLUHA_JMENO}} |
| {{PODPIS_NAJEMCE}} | {{PODPIS_OBSLUHA}} |

---

# ČÁST D – Co se z protokolů ukládá do systému a co se maže

*(Netiskne se. Popis pro dokumentaci, Zásady odd. 4 a Záznam o činnostech zpracování; odpovídá datovému modelu v PLAN.md kap. 4 a retenci v kap. 8.)*

## D.1 Co a kde se ukládá

| Údaj z protokolu | Kde v systému | Jak dlouho | Poznámka |
|---|---|---|---|
| Číslo smlouvy / protokolů, časy předání a vrácení, kdo vydal/převzal | `documents` (typ `contract`, `handover`), `handovers` (typ `pickup` / `return`, `at`, `by_user_id`) | {{DOBA_SMLOUVA}} od vrácení kola; při nevyřešené škodě, krádeži nebo sporu do pravomocného skončení, nejdéle 10 let (§ 629 OZ) | čísla z číselné řady per typ a rok |
| Identifikace kol (typ, inventární kód, velikost, výrobní číslo), obvyklá cena, kauce per kolo | `reservation_items.bike_id` → `bikes` (`inventory_code`, `frame_no_enc`), snímek hodnot v `handovers.condition` | jako smlouva | výrobní číslo rámu je šifrované pole; do protokolu se tiskne, protože ho potřebuje policie při krádeži |
| Checklist stavu, existující a nová poškození, poznámky, % baterie | `handovers.condition` (JSON), `handovers.note`, `handovers.damage_minor` | jako smlouva | bez osobních údajů – jen stav věcí |
| Fotodokumentace kol při předání a vrácení | úložiště souborů mimo webroot, vazba na `handovers` (jen typ a velikost ověřené, žádné EXIF s polohou – systém metadata odstraní) | jako smlouva | fotí se **kolo, nikdy zákazník ani jeho doklad**; nahrávání jen z adminu. **Pro autora Zásad:** odd. 2 (Smluvní údaje) doplnit o „fotografie kol při předání a vrácení“ – Zásady dnes uvádějí fotografie jen u škody; nejde o fotografie osob, ale vážou se ke smlouvě nájemce (čl. 13 odst. 1 písm. c) GDPR) |
| Kauce: forma, částka, číslo transakce terminálu / ref. preautorizace, platnost blokace, vrácení | `payments` (purpose `deposit_hold`, method `cash` / `terminal` / `card`, `provider_ref`, `captured_minor`, status), `ledger_entries` (`deposit_held`, `deposit_captured`, `refund`) | součást účetní evidence: 5 let (účetní doklady), u daňových dokladů 10 let (§ 35 odst. 2 ZDPH) | nikdy číslo karty ani CVC; nejvýše značka karty a poslední 4 číslice |
| Vyúčtování (položky, částky, odhad vs. vyčísleno), konečný doklad | `documents` (`final_doc`, případně `credit_note`), `ledger_entries`, `payments` | 10 let od konce zdaňovacího období (§ 35 odst. 2 ZDPH) u daňových dokladů; jinak 5 let účetně | daňové doklady se nemažou ani na žádost – anonymizují se jen osobní údaje, které zákon nevyžaduje |
| Jméno, telefon, e-mail nájemce | `customers` (`name_enc`, `phone_enc`, `email_enc`, HMAC otisk e-mailu) | {{DOBA_SMLOUVA}} od vrácení kola z **poslední** rezervace zákazníka (jeden záznam `customers` může mít více rezervací; starší rezervace zůstávají navázané, dokud běží lhůta u kterékoli z nich); poté anonymizace (`anonymized_at`) | šifrováno aplikací (AES-256-GCM), klíč mimo DB. **Pro autora Zásad a Záznamu o činnostech:** stejné počítání lhůty promítnout do Zásad odd. 4 a činnosti A1 |
| **Typ a číslo dokladu totožnosti** | `customers.id_doc_type`, `customers.id_doc_number_enc` | **{{DOBA_CISLO_DOKLADU}} po vrácení kol a vypořádání kauce → automatický výmaz** jobem `retence`; déle jen při nevyřešené škodě, krádeži nebo nezaplacení – do vyřešení | čl. 5 odst. 1 písm. c) a e) GDPR (minimalizace, omezení uložení); stanovisko ÚOOÚ k prokazování totožnosti; každý přístup k poli se zapisuje do `audit_log`. U občanského průkazu je souhlas se zapsáním (§ 39 písm. d) zákona o občanských průkazech) součástí podepsané smlouvy (čl. 1) – uložen s `documents`, samostatné pole není třeba |
| Datum narození a adresa *(jen při {{ZAPISOVAT_NAROZENI_ADRESU}} = ano)* | `customers.address_enc`, nové pole `birth_date_enc` (**doplnit do PLAN.md kap. 4** – tabulka `customers` ho dosud nemá) | jako smlouva | **podle sdělení nájemce, ne opisem z dokladu** (§ 39 písm. d) zákona o občanských průkazech); titul: plnění smlouvy / oprávněný zájem – označení žalovaného (§ 79 odst. 1 o. s. ř.); při `ano` upravit Zásady odd. 2 a 4 a Záznam o činnostech A3; rozhodnutí půjčovny, viz „K ověření advokátem“ bod 9 |
| Číslo účtu nájemce pro vratku *(jen při {{KAUCE_FORMA}} = hotove, nebo sděleno dodatečně)* | `customers.refund_account_enc` (nové pole – **doplnit do PLAN.md kap. 4**); u provedené vratky účet příjemce v `payments` (purpose `refund`) | jako smlouva; u provedené vratky jako účetní doklad (5 let) | účel: vrácení hotovostní kauce nebo její zadržené části, není-li nájemce přítomen (čl. 6 odst. 1 písm. b) GDPR); Zásady odd. 4 s číslem účtu pro vratku již počítají |
| Jméno obsluhy, která kola vydala / převzala | `handovers.by_user_id` → `users` (plné jméno, ID účtu) | jako smlouva; `audit_log` | na listinu a do e-mailové kopie jde jen tvar podle {{OBSLUHA_JMENO_FORMAT}} (výchozí: jméno a iniciála příjmení) – pro identifikaci pověřené osoby (§ 430 odst. 1 OZ) i interní dohledání stačí; plné jméno zaměstnance se minimalizuje (čl. 5 odst. 1 písm. c) GDPR) |
| Podpisy *(při podpisu na obrazovce)* | obrázek podpisu uložený k `documents` (šifrovaný soubor), s časem a identifikátorem zařízení | jako smlouva | § 562 odst. 2 OZ – záznamy vedené systematicky a chráněné proti změnám se považují za spolehlivé; podpis se nikde jinde nepoužívá. **V e-mailové kopii a HTML verzi se obrázek podpisu nahrazuje textem** „podepsáno elektronicky dne {{PREDANI_CAS}} / {{VRACENI_CAS}}, záznam č. {{SMLOUVA_CISLO}} / {{PROTOKOL_VRACENI_CISLO}}“ – obrázek zůstává jen v systému (čl. 5 odst. 1 písm. c) a f), čl. 32 GDPR) |
| Verze OP a Zásad, k nimž se podpis váže | `reservations.terms_version`, `documents.data` | jako smlouva | aby bylo kdykoli dohledatelné, co přesně nájemce podepsal |
| Námitky nájemce | `handovers.note` + e-mail v `outbox` | jako smlouva / do vyřízení reklamace | |

## D.2 Co se maže nebo nikdy neukládá

- **Číslo dokladu totožnosti** – automaticky {{DOBA_CISLO_DOKLADU}} po vypořádání kauce (viz výše). Na listině je podle výchozího nastavení **maskované** (poslední 3 znaky), takže plné číslo existuje jen v šifrovaném poli a po výmazu nikde. **Nastavení `plne` se uplatní jen při papírovém tisku; e-mailová kopie, HTML verze protokolu a náhled v adminu po výmazu jsou vždy maskované** – plné číslo tak nikdy neodchází nešifrovaným e-mailem a nezůstává v poštovních schránkách obou stran mimo dosah výmazu. Zvolí-li půjčovna tisk plného čísla a papírové podepisování, musí stejnou lhůtu dodržet i u papíru (skartace nebo začernění) – systém to připomene úkolem v adminu. K rozhodnutí: posílat e-mailem jen odkaz na zabezpečenou stránku „Správa rezervace“ (PLAN kap. 5, podepsaný token) místo přílohy s osobními údaji – viz „K ověření advokátem“ bod 11.
- **Kopie, sken ani fotografie dokladu** se nikdy nepořizují (§ 39 písm. c) zákona o občanských průkazech; přestupek podle § 65 odst. 1 písm. d) téhož zákona – pořízení kopie bez souhlasu). Zpracování údajů z občanského průkazu bez souhlasu držitele (§ 39 písm. d)) přestupkem podle § 65 není, zákaz ale platí – proto souhlas se zapsáním typu a čísla získáváme podpisem čl. 1. Admin nemá pro nahrání souboru s dokladem žádné pole; fotografie se vážou jen ke kolům.
- **Rodné číslo, státní příslušnost, údaje z čipu dokladu** – neopisují se.
- **Platební karta** – žádné číslo karty, CVC ani data 3-D Secure; preautorizaci drží brána, systém zná jen její identifikátor.
- **Obrázek podpisu** – není součástí e-mailové kopie ani HTML verze (nahrazen textovým záznamem o podpisu); existuje jen jako šifrovaný soubor k `documents`.
- **Osobní údaje po uplynutí {{DOBA_SMLOUVA}}** od vrácení kola z poslední rezervace zákazníka – job `retence` nahradí jméno, kontakt, účet pro vratku a podpis anonymními hodnotami; zůstává jen anonymní záznam o výpůjčce (statistika) a účetní/daňové doklady po zákonnou dobu.
- **Fotodokumentace** – maže se spolu s protokolem; při nevyřešené škodě až po jejím vyřešení.
- **Papírové stejnopisy** (při `{{PODPIS_ZPUSOB}}` = papir) – půjčovna je uloží v uzamčené skříni, přístup jen oprávněná obsluha, skartace po {{DOBA_SMLOUVA}}; doporučujeme místo papíru podpis na obrazovce.

## D.3 Co se při podpisu děje v systému

1. Obsluha v adminu otevře rezervaci, naskenuje QR štítky kol (`reservation_items.bike_id`), zapíše typ a číslo dokladu (u občanského průkazu systém zobrazí text souhlasu podle čl. 1; pole viditelné jen při výdeji a vrácení, zápis do `audit_log`), projde checklist, vyfotí kola, zaznamená kauci (hotově – s polem pro účet nájemce pro vratku / terminál / vygeneruje odkaz či QR na preautorizaci u brány a počká na stav `authorized`; preautorizaci nabídne jen při nájmu do {{PREAUTH_MAX_DNU}} dní) a doplatek.
2. Systém vygeneruje část A + B, zákazník podepíše na obrazovce (nebo se vytisknou dva stejnopisy), rezervace přejde do `checked_out`, kopie odejde e-mailem (`outbox`) – s maskovaným číslem dokladu a textovým záznamem místo obrázku podpisu.
3. Při vrácení obsluha projde checklist, zapíše poškození a částky, systém spočítá vyúčtování z pravidel půjčovny a rozdělí ho na část **započtenou** (vyčíslená, nerozporovaná) a část **zadrženou** (odhad, námitky), provede `cancelHold` / částečný `capture` u brány nebo zapíše vrácení hotovosti/terminálu (případně založí vratku převodem na účet nájemce s lhůtou {{LHUTA_VRATKY_KAUCE_PREVODEM}}), vystaví konečný doklad, zákazník podepíše část C; není-li přítomen, podepisuje jen obsluha a kopie s fotografiemi z kontroly odejde e-mailem → `returned` → `closed`.
4. Job `retence` po {{DOBA_CISLO_DOKLADU}} od `closed` **poslední rezervace zákazníka** vymaže číslo dokladu; po {{DOBA_SMLOUVA}} od vrácení kola z poslední rezervace anonymizuje zbytek (včetně obrázku podpisu a účtu pro vratku). Při stavu „škoda nevyřešena“ nebo „námitky nevyřízeny“ (příznak na `handovers`) se lhůty pozastaví.

---

## K ověření advokátem

Body, u kterých si nejsme jisti právní kvalifikací, nebo kde záleží na rozhodnutí půjčovny či zadavatele. Odkazy na články se vztahují k části A (čl.), B, C a D výše a k OP. Nálezy oponentury (10/2026) jsou zapracovány přímo v textu; zde zůstává jen to, co advokát musí potvrdit, nebo o čem je třeba rozhodnout. Na konci je seznam úprav, které musí autor OP, Zásad a PLAN.md provést, aby dokumenty zůstaly v souladu.

**Povaha listiny a její vztah k OP**

1. **Potvrzení vs. nová smlouva (čl. 2.3 [ONLINE]).** Smlouva vznikla online potvrzením rezervace (OP čl. 3); listina ji „potvrzuje a doplňuje“. Ověřit, že doplnění (konkrétní kola, hodnota kola, kauce, čas vrácení) nejsou změnou smlouvy vyžadující nový souhlas spotřebitele nad rámec podpisu, a že se nejedná o novaci. Po oponentuře listina obsahuje ujednání, která jdou nad rámec OP nebo jsou pro spotřebitele příznivější než OP: čl. 4.3 b) (zadržení jistoty místo započtení), čl. 4.4 (kauce při prodloužení), C.1 (lhůta kontroly a vyvratitelná domněnka), čl. 5 (obvyklá cena v době poškození jako strop). Ověřit, že odchylka ve prospěch spotřebitele je přípustná bez dalšího (§ 1812 odst. 1 OZ), a zadat sladění OP (seznam na konci), aby nevznikl rozpor podle OP čl. 8.7 a 15.6.
2. **Varianta [NA MÍSTĚ] (čl. 2.3).** Smlouva uzavřená v provozovně není smlouvou distanční; OP se stávají součástí smlouvy podle § 1751 odst. 1 OZ „připojením“ (tisk / obrazovka). Ověřit, že předložení OP na tabletu před podpisem stačí, že je splněna informační povinnost § 1811 OZ (práva z vadného plnění jsou nově vypsána v čl. 5 „Závada“, § 1811 odst. 2 písm. f)) a že u nákladových položek (OP čl. 4.7) nejde o překvapivá ujednání (§ 1753 OZ) – navrhujeme při podpisu na místě zobrazit tabulku z OP čl. 4.7 přímo nad podpisem.
3. **Podpis na obrazovce (čl. 7.2, D.1).** Opíráme se o § 561 odst. 1 a § 562 odst. 1–2 OZ a § 7 zákona č. 297/2016 Sb. (pro soukromoprávní jednání lze použít „jiný typ elektronického podpisu“). Ověřit důkazní sílu obrázku podpisu bez certifikátu, zda stačí uložení času, identifikátoru zařízení a verze dokumentu (§ 562 odst. 2 – spolehlivost záznamů), a zda půjčovna nepotřebuje i vlastní podpis (navrhujeme podpis obsluhy také na obrazovce, nebo jen jméno pověřené osoby s odkazem na § 430 odst. 1 OZ). Nově se obrázek podpisu v e-mailové kopii nahrazuje textovým záznamem – ověřit, že kopie bez obrázku podpisu je pro nájemce dostatečná (plný záznam si může vyžádat podle čl. 15 GDPR).
4. **Zastoupení půjčovny obsluhou a formát jména (čl. 1, {{OBSLUHA_JMENO_FORMAT}}).** Odkaz na § 430 odst. 1 OZ (pověřená osoba při provozu závodu). Na listinu jde výchozím nastavením jen jméno a iniciála příjmení obsluhy (minimalizace údajů zaměstnance); plné jméno je v systému. Ověřit, že to pro identifikaci pověřené osoby stačí, nebo zda doplnit „na základě pověření“.
5. **Vyvratitelná domněnka stavu kola (B.3, C.1, čl. 6).** Tvrdé formulace („nic, co není zapsáno…“, „platí stav zjištěný námi“) byly po oponentuře nahrazeny domněnkou „má se za to … můžete však prokázat opak“ a v C.1 lhůtou kontroly „do konce následující otevírací doby“ se zasláním fotografií. Ověřit, že ani vyvratitelná domněnka ve prospěch podnikatele není omezením důkazních prostředků spotřebitele (§ 1814 odst. 1 písm. m) OZ), že ji § 2225 odst. 1 OZ („přihlédne se“) unese, a zda je lhůta kontroly přiměřená (alternativa: 24 hodin od odložení kol).

**Kauce**

6. **Kauce jako jistota a dvojí režim vypořádání (čl. 4.1, 4.3, C.4).** Odkaz na § 2010 odst. 1 OZ. Započtení (§ 1982 OZ) se nově uplatní jen u částek vyčíslených na místě a nájemcem odsouhlasených nebo nerozporovaných; odhad škody a rozporované částky se jen zadržují jako jistota do vyčíslení či vyřešení sporu (kvůli § 1987 odst. 2 OZ – nejistá nebo neurčitá pohledávka není k započtení způsobilá). Ověřit: (a) zda je vyčíslená, ale výslovně neodsouhlasená částka (nepřítomný nájemce) k započtení způsobilá, nebo ji do uplynutí 14 dnů pro námitky vést jen jako zadrženou; (b) že zadržení části jistoty s lhůtou {{LHUTA_VYUCTOVANI_SKODY}} a povinností vrátit zbytek není zneužívajícím ujednáním (§ 1814 odst. 1 písm. j) a m) OZ); (c) konstrukci „u preautorizace zadrženou část z blokace strhneme, stále jde o jistotu“ – zda `capture` není fakticky uspokojením z jistoty před vyčíslením (shodně bod 10 v OP).
7. **Preautorizace (čl. 4.2 c, 4.4, {{PREAUTH_MAX_DNU}}).** Parametr je nově odvozen z platnosti blokace u zvolené brány (−1 den rezervy), čl. 4.4 omezen jen na prodloužení nájmu. Zbývá ověřit informační povinnost o blokaci prostředků a době uvolnění, částečný `capture` na škodu bez nového souhlasu nad rámec podpisu protokolu a zda text o kauci při prodloužení patří do OP čl. 5.
8. **Terminálová kauce = skutečná platba (čl. 4.2 b).** Vratka na kartu trvá dny; ověřit informační povinnost a účetní zacházení (přijetí cizích prostředků, nikoli výnos; OP bod 27) – konzultovat i s daňovým poradcem. Totéž u vrácení hotovostní kauce převodem na účet nájemce ({{LHUTA_VRATKY_KAUCE_PREVODEM}}), není-li nájemce při kontrole přítomen.

**Doklad totožnosti a osobní údaje**

9. **Rozsah identifikace nájemce (čl. 1, parametr {{ZAPISOVAT_NAROZENI_ADRESU}}).** Pro žalobu na náhradu škody je třeba žalovaného označit jménem, datem narození a bydlištěm (§ 79 odst. 1 o. s. ř.); samotné číslo dokladu k tomu nestačí. Výchozí nastavení (jen typ a číslo dokladu) sleduje minimalizaci podle ÚOOÚ; rozhodnutí půjčovny mezi vymahatelností a minimalizací (shodně bod 2 v Zásadách). Při „ano“ se datum narození a bydliště nově zapisují **podle sdělení nájemce**, nikoli opisem z občanského průkazu, aby nešlo o zpracování údajů z OP bez souhlasu (§ 39 písm. d) zákona č. 269/2021 Sb.). Ověřit: (a) že samodeklarované údaje jsou pro označení žalovaného dostatečné a jaký je právní titul (plnění smlouvy, nebo oprávněný zájem s balančním testem); (b) zda souhlas podle § 39 písm. d), který nájemce dává podpisem čl. 1 pro číslo OP, může pokrýt i ověření sdělených údajů nahlédnutím do OP; (c) Zásady odd. 2 (varianta DOKLAD-A) nabízejí při odmítnutí souhlasu i „kauci v plné hodnotě kola“ – smlouva ani OP tuto alternativu nemají; rozhodnout, zda ji zavést, nebo ze Zásad vypustit; (d) Zásady počítají i s variantou DOKLAD-B (bez čísla dokladu, jen jméno, datum narození a adresa) – šablona smlouvy ji nemá; rozhodnout, zda ji doplnit.
10. **Souhlas podle zákona o občanských průkazech vs. titul podle GDPR (čl. 1, čl. 6).** Souhlas se zapsáním typu a čísla občanského průkazu (§ 39 písm. d) zákona č. 269/2021 Sb.) dává nájemce předložením dokladu a podpisem čl. 1; může ho odmítnout a předložit pas nebo řidičský průkaz. Právním titulem podle GDPR zůstává oprávněný zájem (čl. 6 odst. 1 písm. f)) s balančním testem v Zásadách; námitka před výdejem = nevydání kola (alternativa: čl. 6 odst. 1 písm. b)). Ověřit, že souhlas podle zákona o OP může být součástí podepisované smlouvy a nepodléhá režimu čl. 7 GDPR (odvolatelnost), a že první informační vrstva v čl. 6 splňuje čl. 13 GDPR (doplněno: podmínka vydání kola, výjimka z výmazu, příjemci brána a banka jako samostatní správci, podpis a fotografie kol).
11. **Maskování čísla dokladu a obsah e-mailové kopie ({{DOKLAD_CISLO_TISK}}, čl. 7.2, D.2).** `plne` se nově uplatní jen na papír; e-mailová kopie a HTML verze jsou vždy maskované a bez obrázku podpisu. Rozhodnout, zda e-mailem posílat přílohu, nebo jen odkaz na zabezpečenou stránku „Správa rezervace“ (PLAN kap. 5, podepsaný token), aby osobní údaje nezůstávaly v poštovních schránkách. Posoudit, zda maskované číslo na listině oslabuje účel (identifikace pro policii – ta dostává údaj ze systému, dokud je věc otevřená) a zda je to vhodnější než plné číslo + povinná skartace papíru.
12. **Cestovní pas a řidičský průkaz jako doklad ({{DOKLADY_AKCEPTOVANE}}).** Zákon č. 269/2021 Sb. platí jen pro občanské průkazy; u pasu ověřit obdobná pravidla v zákoně č. 329/1999 Sb., o cestovních dokladech (zda i tam je třeba souhlas se zapsáním čísla); u řidičského průkazu, zda je vhodným dokladem totožnosti (shodně bod 21 v OP).
13. **Fotodokumentace (B.3, C.1, C.2, D.1).** Fotí se jen kola, při každém předání a vrácení (Zásady odd. 2 to musí uvádět – viz seznam na konci); při vrácení bez společné kontroly se fotografie posílají nájemci. Ověřit, že náhodné zachycení osob (zákazník v pozadí) nevyžaduje další informaci, a zda EXIF s polohou skutečně odstraňovat (navrhujeme ano).
14. **Podpis jako osobní údaj (D.1).** Obrázek podpisu uchováváme s protokolem po {{DOBA_SMLOUVA}}; ověřit, že nejde o biometrický údaj ve smyslu čl. 9 GDPR (dynamický podpis s tlakem a rychlostí by jím být mohl – systém ukládá jen statický obrázek).

**Odpovědnost, vyúčtování, sankce**

15. **Obvyklá cena kola jako horní hranice náhrady (B.1, čl. 5, C.3).** Po oponentuře je částka v protokolu jen stropem; náhrada se řídí § 2969 odst. 1 OZ (obvyklá cena v době poškození, resp. účelné náklady opravy). Ověřit, že strop ve prospěch spotřebitele není současně nepřípustnou paušalizací (§ 1814 odst. 1 písm. l), § 2898 OZ), jak půjčovna doloží obvyklou cenu v době škody (evidence, srovnatelné nabídky) a jak postupovat, klesne-li obvyklá cena během nájmu; OP čl. 10.3 dosud říká „v době převzetí“ – sladit (shodně bod 13 v OP).
16. **Odpovědnost „i při pádu bez cizího zavinění“ (čl. 5).** Opíráme se o § 2913 odst. 1 OZ (porušení smluvní povinnosti vrátit věc ve stavu podle § 2225 odst. 1 a § 2325 odst. 1 OZ) a liberaci podle § 2913 odst. 2. Ověřit formulaci a výluku pro skryté vady kola (shodně bod 12 v OP).
17. **Stanovisko nájemce v C.5.** Podpis protokolu o vrácení potvrzuje jen vrácení kol a převzetí vyúčtování, nikoli souhlas s ním (zaškrtávací pole „souhlasím“ / „nesouhlasím“ + věta „podpis není uznáním dluhu ve sporné části“, § 2053 OZ); zaškrtnuté „souhlasím“ je nově i podmínkou započtení (bod 6). Ověřit, zda má povahu uznání dluhu (§ 2053 OZ) a zda je to vůči spotřebiteli přijatelné, nebo pole vypustit a nechat jen námitky. Při nepřítomnosti nájemce podepisuje jen obsluha – ověřit, že 14denní lhůta pro námitky od doručení kopie je dostatečná.
18. **Vrácení mimo otevírací dobu po domluvě (C.1).** Kolo se považuje za vrácené až převzetím obsluhou (OP čl. 11.1) – riziko za noc nese nájemce; C.1 nově stanoví lhůtu kontroly a zasílá fotografie. Posoudit přiměřenost rozložení rizika; alternativa: okamžik odložení do určené kolárny s fotografií od zákazníka.
19. **DPH u položek vyúčtování a dokladů (čl. 3, C.3, varianta A).** Citace opraveny: základ konečného dokladu snížený o základ již zdaněné úplaty = § 37a ZDPH; lhůta 15 dnů pro doklad k přijaté úplatě = § 28 odst. 8 ZDPH (číslo odstavce potvrzeno oponenturou z aktuálního znění § 28 – 11 odstavců, novela účinná od 1. 1. 2025; OP bod 25 uvádí ověření znění od 1. 1. 2026 – sjednotit datum v obou dokumentech). Zbývá ověřit s daňovým poradcem: nájemné za prodlení a paušály za umytí/nabití jako úplata za službu s DPH, smluvní pokuta a náhrada škody mimo předmět daně (§ 2 odst. 1 ZDPH), kauce není úplatou za plnění.
20. **Smluvní pokuta za vrácení po otevírací době (čl. 2.2, C.3, {{POPLATEK_POZDNI_PAUSAL}}).** Jediná smluvní pokuta; sjednána s vyloučením náhrady škody (§ 2050 OZ) a s uvedeným účelem (náklady obsluhy mimo otevírací dobu). **U spotřebitele se moderační právo soudu podle § 2051 OZ neuplatní** – nepřiměřená pokuta je neúčinná celá (§ 1814 odst. 1 písm. l), § 1815 OZ; směrnice 93/13/EHS, SDEU C-618/10 Banco Español). Proto má parametr strop „nejvýše denní nájemné jednoho kola“, který má systém vynucovat v adminu. Ověřit přiměřenost výchozích 300 Kč i stropu podle § 1813–1814 OZ a zvážit zakotvení stropu v OP čl. 11.4 (shodně bod 14 v OP).
21. **Odkaz na § 205 TZ (čl. 5 Krádež).** Informační zmínka „krádež je trestný čin“ má motivovat k oznámení policii; ověřit, že není nátlaková (§ 4 a násl. ZOS). Odkaz na § 207 TZ (nevrácení kola) jsme ze smlouvy záměrně vypustili a ponechali jen v OP čl. 11.8.

**Další jezdci, nezletilí, elektrokola**

22. **Další jezdci bez jmen (čl. 1, 6).** Nezapisujeme jména dalších jezdců (minimalizace; Zásady bod 16), nájemce za ně odpovídá a prohlašuje, že u nezletilých je zákonným zástupcem nebo má jeho souhlas. Ověřit, že tím není dotčena zákonná odpovědnost samotných jezdců vůči třetím osobám, a zda u nezletilých není třeba podpis zákonného zástupce na místě.
23. **Zaškolení k elektrokolu (čl. 6).** Prohlášení o absolvování zaškolení – ověřit, že neslouží k nepřípustnému omezení naší odpovědnosti za vady kola (§ 2898 OZ) a zda doplnit stručný obsah zaškolení jako přílohu.
24. **Prohlášení o střízlivosti.** Nezařazeno (obsluha kolo nevydá zjevně ovlivněné osobě, OP čl. 8.2). Zvážit, zda prohlášení „nejsem pod vlivem alkoholu“ přidat do čl. 6.

**Formality a provoz**

25. **Jazyk.** Šablona je česky; pro zahraniční hosty bude systém nabízet překlad jako informaci, podepisuje se česká verze (OP čl. 15.5). Ověřit, zda u spotřebitele bez znalosti češtiny stačí informativní překlad a ústní vysvětlení obsluhy.
26. **Povaha rezervačního poplatku (čl. 3).** Odkaz na § 1807 OZ (záloha) byl po oponentuře vypuštěn: u varianty [NA MÍSTĚ] žádná platba před uzavřením smlouvy není a u varianty [ONLINE] poplatek při stornu zčásti propadá (OP čl. 6 – smluvní pokuta / odstupné), což záloha podle § 1807 nedělá. Smlouva ho označuje jako „částečnou úhradu nájemného zaplacenou předem“. Ověřit, že označení je konzistentní s OP a že nemá dopad na DPH režim (úplata přijatá před uskutečněním plnění, § 20a ZDPH).
27. **Rozhodnutí půjčovny před nasazením:** zapisovat datum narození a adresu (ne/ano – podle sdělení nájemce); tisk čísla dokladu maskovaně/plně (plně jen na papír); podpis na obrazovce/papír; formát jména obsluhy; formy kauce, které nabízí (všechny tři / jen některé); zda nabízet prodloužení nájmu; výše smluvní pokuty v rámci stropu; výše hodnoty kol v evidenci (aktualizovat ročně); ceník oprav a náhrad; text {{SPOLUUCAST_KRADEZ}} a {{POJISTENI}}; lhůty {{DOBA_CISLO_DOKLADU}}, {{DOBA_SMLOUVA}} a {{LHUTA_VRATKY_KAUCE_PREVODEM}} shodně v Zásadách a Záznamu o činnostech.

**Soulad s OP, Zásadami a PLAN.md – úkoly pro autory ostatních dokumentů (ne pro advokáta)**

- **OP čl. 11.2:** doplnit lhůtu kontroly „nejpozději do konce následující otevírací doby“, vyvratitelnou domněnku s možností prokázat opak a zaslání fotografií nájemci (dnes „platí stav zjištěný námi“ – stejný problém podle § 1814 odst. 1 písm. j) a m) OZ jako měla C.1).
- **OP čl. 10.3 a tabulka čl. 4.7:** „obvyklá cena kola v době převzetí uvedená v protokolu“ → „obvyklá cena kola v době poškození (§ 2969 odst. 1 OZ), nejvýše částka uvedená v protokolu“.
- **OP čl. 5.3–5.4 a 10.7:** rozdělit započtení (vyčíslené, odsouhlasené/nerozporované částky) a zadržení jistoty (odhad, námitky) podle čl. 4.3 této smlouvy; doplnit vrácení hotovostní kauce převodem na účet nájemce do {{LHUTA_VRATKY_KAUCE_PREVODEM}}, není-li nájemce při kontrole přítomen.
- **OP čl. 8.3:** doplnit souhlas držitele občanského průkazu se zapsáním typu a čísla (§ 39 písm. d)) – dnes OP uvádí jen „nahlédnutí“; doplnit možnost předložit pas nebo řidičský průkaz místo souhlasu.
- **OP čl. 11.4:** zvážit zakotvení stropu smluvní pokuty (nejvýše denní nájemné jednoho kola).
- **Zásady odd. 2 (Smluvní údaje):** doplnit „fotografie kol při předání a vrácení“; u volitelného data narození a adresy nahradit „ověřené z předloženého dokladu“ slovy „podle vašeho sdělení“; ověřit, že odd. 5 uvádí platební bránu a banku jako samostatné správce.
- **Zásady odd. 4 a Záznam o činnostech (A1, A3):** anonymizace {{DOBA_SMLOUVA}} od vrácení kola z poslední rezervace zákazníka; při {{ZAPISOVAT_NAROZENI_ADRESU}} = ano doplnit činnost A3; nové pole účet pro vratku kauce.
- **PLAN.md kap. 4 (`customers`):** doplnit pole `birth_date_enc` a `refund_account_enc`; **kap. 6:** vrácení hotovostní kauce převodem a lhůta {{LHUTA_VRATKY_KAUCE_PREVODEM}}, rozdělení vyúčtování na započtenou a zadrženou část; **kap. 8:** retence od poslední rezervace zákazníka; **kap. 2/6:** `{{PREAUTH_MAX_DNU}}` jako hodnota odvozená z adaptéru `PaymentProvider` (platnost blokace − 1 den), e-mailová kopie bez obrázku podpisu a vždy s maskovaným číslem dokladu, parametr `{{OBSLUHA_JMENO_FORMAT}}`.
