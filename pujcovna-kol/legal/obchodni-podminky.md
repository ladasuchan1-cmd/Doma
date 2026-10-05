# Obchodní podmínky půjčovny kol s online rezervací – návrh

> **Návrh připravený jako podklad; před použitím vyžaduje kontrolu advokátem.**

Verze šablony {{VERZE}}, účinnost od {{UCINNOST_OD}}. Dokument generuje muster pro každou půjčovnu dosazením parametrů z jejího nastavení (`tenant.json`). Souvisí s [Zásadami ochrany osobních údajů](zasady-ochrany-osobnich-udaju.md) a se [smlouvou o nájmu a předávacím protokolem](smlouva-o-najmu-a-predavaci-protokol.md). Podklady: [rešerše 02 – platby, zálohy, DPH](../docs/vyzkum/02-platby-cr.md), [rešerše 03 – GDPR, praxe půjčoven, osnova](../docs/vyzkum/03-bezpecnost-gdpr-podminky.md), [PLAN.md kap. 5–8](../PLAN.md).

**Jak číst návrh**

- `{{PUJCOVNA_NAZEV}}` je proměnná, kterou doplní systém z nastavení půjčovny. Všechny proměnné jsou v tabulce *Parametry* níže; názvy proměnných jsou shodné se [Zásadami ochrany osobních údajů](zasady-ochrany-osobnich-udaju.md), aby obě šablony naplnil jeden `tenant.json`.
- Bloky označené **[VARIANTA A – plátce DPH]** a **[VARIANTA B – neplátce DPH]** se zobrazí podle parametru `{{PLATCE_DPH}}`; do výsledného textu jde vždy jen jedna varianta.
- Odkazy na předpisy: **OZ** = zákon č. 89/2012 Sb., občanský zákoník; **ZOS** = zákon č. 634/1992 Sb., o ochraně spotřebitele; **GDPR** = nařízení (EU) 2016/679; **ZDPH** = zákon č. 235/2004 Sb., o dani z přidané hodnoty; **zákon o občanských průkazech** = zákon č. 269/2021 Sb.; **zákon o cestovních dokladech** = zákon č. 329/1999 Sb.; **ZEK** = zákon č. 127/2005 Sb., o elektronických komunikacích; **zákon o silničním provozu** = zákon č. 361/2000 Sb.; **zákon č. 480/2004 Sb.** = o některých službách informační společnosti (obchodní sdělení). Znění paragrafů ověřeno k 5. 10. 2026 (zakonyprolidi.cz, podnikatel.cz, pracepropravniky.cz – znění účinné od 1. 1. 2026); výjimky, kde máme jen sekundární zdroj, jsou uvedeny v sekci *K ověření advokátem*.
- Zákazníka oslovujeme „vy“, půjčovnu označujeme „my“. Je to záměr: text má být srozumitelný bez právníka, ale s přesnými odkazy, aby advokát kontroloval rychle.

---

## Parametry

| Parametr | Význam | Výchozí hodnota / návrh |
|---|---|---|
| `{{PUJCOVNA_NAZEV}}` | Obchodní firma nebo jméno a příjmení podnikatele, který kola pronajímá (smluvní strana) | *(příklad)* Hotel U Tří dubů s.r.o. |
| `{{PUJCOVNA_ICO}}` | IČO půjčovny | *(příklad)* 12345678 |
| `{{PUJCOVNA_DIC}}` | DIČ – jen u plátce DPH | *(příklad)* CZ12345678 |
| `{{PUJCOVNA_SIDLO}}` | Adresa sídla (u fyzické osoby místo podnikání) | – |
| `{{PUJCOVNA_PROVOZOVNA}}` | Adresa výdejního místa (provozovny), kde se kola přebírají a vracejí | shodná se sídlem |
| `{{PUJCOVNA_REJSTRIK}}` | Údaj o zápisu – obchodní rejstřík (soud, oddíl, vložka) nebo živnostenský rejstřík | „zapsaná v obchodním rejstříku vedeném Krajským soudem v …, oddíl C, vložka …“ / „zapsaný v živnostenském rejstříku“ |
| `{{PUJCOVNA_EMAIL}}` | Kontaktní e-mail (rezervace, reklamace, uplatnění práv) | – |
| `{{PUJCOVNA_TELEFON}}` | Kontaktní telefon (včetně čísla pro nahlášení poruchy nebo krádeže během výpůjčky) | – |
| `{{OTEVIRACI_DOBA}}` | Otevírací doba výdejního místa | *(příklad)* denně 9:00–18:00, duben–říjen |
| `{{WEB_SUBDOMENA}}` | Doména webu půjčovny na musteru ve tvaru `<nazev-stavajiciho-webu>.pujcovna.cz` | *(příklad)* utridubu.pujcovna.cz |
| `{{PODMINKY_URL}}` | Adresa těchto podmínek | https://{{WEB_SUBDOMENA}}/podminky |
| `{{ZASADY_URL}}` | Adresa samostatných Zásad ochrany osobních údajů | https://{{WEB_SUBDOMENA}}/soukromi |
| `{{CENIK_URL}}` | Adresa ceníku (nájemné, poplatky, kauce, náhrady) | https://{{WEB_SUBDOMENA}}/cenik |
| `{{PROVOZOVATEL_NAZEV}}` | Provozovatel musteru – technický provozovatel webu a rezervačního systému (zpracovatel osobních údajů podle čl. 28 GDPR); obchodní firma / jméno | – |
| `{{PROVOZOVATEL_ICO}}` | IČO provozovatele musteru | – |
| `{{PLATCE_DPH}}` | Je půjčovna plátcem DPH? Řídí varianty textu | ne *(rozhodne půjčovna; viz otevřená otázka č. 1 v PLAN.md)* |
| `{{PLATEBNI_BRANA_NAZEV}}` | Název poskytovatele platební brány, přes kterou se platí kartou a provádí preautorizace kauce | ComGate Payments, a.s. *(podle rešerše 06)* |
| `{{DEFINICE_DNE}}` | Co je „den nájmu“ – základní jednotka nájemného (čl. 2.3); určuje, kdy končí jednodenní nájem a od kdy běží další nájemné | doba od převzetí kola do stejného času následujícího dne, nejpozději však do konce otevírací doby toho dne; půlden = nejvýše 4 hodiny od převzetí |
| `{{BANKOVNI_UCET}}` | Číslo účtu a IBAN půjčovny pro převod / QR Platbu (Fio banka) | – |
| `{{POPLATEK_KOLO}}` | Rezervační poplatek za jedno kolo (fixní částka) | 300 Kč |
| `{{POPLATEK_EKOLO}}` | Rezervační poplatek za jedno elektrokolo (fixní částka) | 500 Kč |
| `{{LHUTA_PLATBY_POPLATKU}}` | Jak dlouho držíme rezervaci na zaplacení poplatku převodem / QR | 48 hodin od odeslání rezervace; začíná-li nájem dříve než za 48 hodin, do 20:00 dne předcházejícího začátku nájmu |
| `{{PLATBA_NA_MISTE_POVOLENA}}` | Může zákazník rezervovat bez poplatku s platbou až na místě (nezávazná rezervace)? | ne |
| `{{DOPLATEK_PREDEM_POVINNY}}` | Musí být doplatek nájemného zaplacen před převzetím? | ne (doplatek online nebo na místě) |
| `{{TOLERANCE_PLATBY}}` | Rozdíl v platbě převodem, který nevymáháme ani nevracíme | 5 Kč |
| `{{KAUCE_KOLO}}` | Kauce za jedno kolo | 3 000 Kč |
| `{{KAUCE_EKOLO}}` | Kauce za jedno elektrokolo | 10 000 Kč |
| `{{PREAUTH_MAX_DNU}}` | Nejdelší nájem (ve dnech), u kterého lze kauci složit preautorizací karty (blokace u bran platí 4–7 dní) | 6 |
| `{{STORNO_TABULKA}}` | Odstupňovaná tabulka storna – kolik z rezervačního poplatku vracíme podle toho, kdy zrušení dojde | viz výchozí tabulka v čl. 6.2 |
| `{{ZMENA_TERMINU_LHUTA}}` | Do kdy před začátkem nájmu lze bezplatně změnit termín nebo složení rezervace (je-li volná kapacita) | 24 hodin |
| `{{NO_SHOW_LHUTA}}` | Jak dlouho od sjednaného začátku nájmu držíme kola, než rezervaci označíme za nevyzvednutou | 2 hodiny, nejdéle do konce otevírací doby téhož dne |
| `{{STORNO_POCASI}}` | Volitelné pravidlo bezplatného zrušení kvůli počasí (text, nebo „neuplatňuje se“) | neuplatňuje se |
| `{{LHUTA_VRATKY}}` | Do kdy vracíme peníze při stornu, zrušení z naší strany nebo přeplatku | 14 dnů |
| `{{DOKLADY_AKCEPTOVANE}}` | Doklady totožnosti, které při převzetí přijímáme | občanský průkaz, cestovní pas nebo řidičský průkaz |
| `{{DOBA_CISLO_DOKLADU}}` | Jak dlouho po vrácení kola a vypořádání kauce držíme typ a číslo dokladu totožnosti, pak automatický výmaz (shodně se Zásadami, oddíl 4) | 30 dní |
| `{{PRILBA_PODMINKY}}` | Za jakých podmínek půjčujeme přilby | zdarma k zapůjčení na vyžádání (v rámci dostupných velikostí) |
| `{{UZEMI_UZIVANI}}` | Území, na kterém lze kolo užívat | území České republiky |
| `{{CENIK_NAHRAD}}` | Paušální ceny za ztracené nebo zničené příslušenství | viz výchozí tabulka v čl. 10.4 |
| `{{SPOLUUCAST_KRADEZ}}` | Volitelné omezení náhrady při krádeži řádně uzamčeného a policii nahlášeného kola | neuplatňuje se (náhrada v plné výši obvyklé ceny) |
| `{{POJISTENI}}` | Informace o pojištění kol / nájemce | kola nejsou pojištěna pro případ škody způsobené nájemcem |
| `{{TOLERANCE_POZDNI}}` | Zpoždění při vrácení, které neúčtujeme | 30 minut |
| `{{SAZBA_POZDNI}}` | Nájemné za dobu po sjednaném konci nájmu | hodinová sazba podle ceníku za každou započatou hodinu, nejvýše denní sazba za každý započatý den |
| `{{POPLATEK_POZDNI_PAUSAL}}` | Smluvní pokuta za vrácení po konci otevírací doby bez předchozí domluvy (náklady obsluhy) | 300 Kč za rezervaci |
| `{{POPLATEK_CISTENI}}` | Paušální cena za umytí silně znečištěného kola | 200 Kč za kolo |
| `{{POPLATEK_NABITI}}` | Paušální cena za nabití elektrokola vráceného s baterií pod 20 % (0 Kč = neúčtuje se) | 0 Kč (neúčtuje se) |
| `{{DRIVEJSI_VRACENI_REFUND}}` | Vracíme část nájemného při dřívějším vrácení? | ne |
| `{{LHUTA_VYUCTOVANI_SKODY}}` | Do kdy vyúčtujeme škodu, kterou nelze vyčíslit hned při vrácení | 14 dnů od vrácení |
| `{{LHUTA_UHRADY_SKODY}}` | Splatnost náhrady škody převyšující kauci | 14 dnů od doručení vyúčtování |
| `{{VERZE}}` | Verze podmínek (každá změna textu = nová verze, váže se k souhlasu) | 1.0 |
| `{{UCINNOST_OD}}` | Datum účinnosti této verze | – |

---

# Obchodní podmínky půjčovny kol {{PUJCOVNA_NAZEV}}

Platí pro rezervace a nájem kol přes web **{{WEB_SUBDOMENA}}** a na výdejním místě {{PUJCOVNA_PROVOZOVNA}}. Verze {{VERZE}}, účinná od {{UCINNOST_OD}}.

## 1. Kdo jsme a jak nás kontaktovat

1.1 Kola pronajímá **{{PUJCOVNA_NAZEV}}**, IČO {{PUJCOVNA_ICO}}, se sídlem {{PUJCOVNA_SIDLO}}, {{PUJCOVNA_REJSTRIK}} (dále „my“ nebo „půjčovna“).

> **[VARIANTA A – plátce DPH ({{PLATCE_DPH}} = ano)]** Jsme plátci DPH, DIČ {{PUJCOVNA_DIC}}.
>
> **[VARIANTA B – neplátce DPH ({{PLATCE_DPH}} = ne)]** Nejsme plátci DPH.

1.2 Výdejní místo: {{PUJCOVNA_PROVOZOVNA}}, otevírací doba {{OTEVIRACI_DOBA}}. Kontakt: e-mail {{PUJCOVNA_EMAIL}}, telefon {{PUJCOVNA_TELEFON}}. Na tomto telefonu nám hlásíte i poruchu, nehodu nebo krádež během výpůjčky.

1.3 Web a rezervační systém pro nás technicky provozuje **{{PROVOZOVATEL_NAZEV}}**, IČO {{PROVOZOVATEL_ICO}}. Smlouvu uzavíráte s námi, nikoli s provozovatelem webu; ten pro nás zpracovává osobní údaje jako zpracovatel podle čl. 28 GDPR (podrobnosti v Zásadách ochrany osobních údajů, oddíl 5).

1.4 Dozor nad dodržováním předpisů na ochranu spotřebitele vykonává Česká obchodní inspekce (www.coi.gov.cz), nad živnostenským podnikáním příslušný živnostenský úřad, nad ochranou osobních údajů Úřad pro ochranu osobních údajů (www.uoou.gov.cz).

## 2. Co tyto podmínky upravují

2.1 Tyto obchodní podmínky (dále „podmínky“ nebo „OP“) jsou součástí každé smlouvy o nájmu kola, elektrokola nebo příslušenství (dále společně „kolo“), kterou s námi uzavřete přes web {{WEB_SUBDOMENA}} nebo na výdejním místě (§ 1751 odst. 1 OZ).

2.2 Smlouva je **smlouvou o nájmu movité věci** podle § 2201 a násl. OZ; protože je kolo dopravním prostředkem, použijí se i zvláštní ustanovení o nájmu dopravního prostředku (§ 2321–2325 OZ). Předmětem nájmu je konkrétní kolo (případně více kol) a příslušenství uvedené v předávacím protokolu, na sjednanou dobu a za sjednané nájemné.

2.3 Pojmy:
- **Zákazník / vy / nájemce** – osoba, která rezervaci odeslala a která kolo přebírá. Pokud rezervujete kola i pro další osoby (rodinu, skupinu), jste vůči nám nájemcem všech kol vy a odpovídáte za to, že ostatní jezdci dodrží tyto podmínky.
- **Spotřebitel** – zákazník, který s námi jedná mimo rámec svého podnikání (§ 419 OZ). Ustanovení určená spotřebitelům (čl. 7, čl. 12.4 a 12.6, čl. 13 a druhá věta čl. 15.1) se na podnikatele nepoužijí; práva z vad kola podle čl. 12.1–12.3 a 12.5 má každý nájemce.
- **Den nájmu a jednotky nájemného** – den nájmu je {{DEFINICE_DNE}}. Hodinu, půlden a týden jako další jednotky nájemného vymezuje ceník. Podle těchto jednotek počítáme nájemné i další nájemné při pozdním vrácení (čl. 11.3).
- **Rezervace** – vaše objednávka konkrétních kol na konkrétní termín odeslaná přes web.
- **Rezervační poplatek** – fixní částka za každé rezervované kolo, kterou platíte při rezervaci a která je **částí nájemného**, nikoli platbou navíc (čl. 4).
- **Doplatek** – zbytek celkové ceny po odečtení zaplaceného rezervačního poplatku.
- **Kauce** – vratná jistota pro případ škody, ztráty nebo neuhrazených částek (čl. 5). Není platbou za službu.
- **Předávací protokol** – dokument (papírový nebo elektronický), ve kterém při převzetí zaznamenáme, která kola a příslušenství přebíráte, v jakém stavu, s jakou hodnotou, jakou kauci skládáte a kdy kola vrátíte. Při vrácení doplníme stav a vyúčtování.
- **Ceník** – aktuální ceny nájemného, poplatků, kaucí a náhrad zveřejněné na {{CENIK_URL}}. Pro vaši smlouvu platí ceník účinný v okamžiku odeslání rezervace.

2.4 Elektrokolem rozumíme jízdní kolo s pomocným elektrickým pohonem, který pomáhá jen při šlapání a do rychlosti 25 km/h (tzv. pedelec). Z pohledu pravidel silničního provozu jde o jízdní kolo; jezdec je řidičem nemotorového vozidla (§ 2 písm. d) zákona o silničním provozu).

## 3. Rezervace a uzavření smlouvy

3.1 **Postup rezervace.** Na webu zvolíte termín (od–do v rámci otevírací doby), typ, velikost a počet kol a příslušenství. Systém ukáže dostupnost a cenu za zvolený termín. Poté vyplníte jméno, e-mail a telefon – údaje, které potřebujeme k uzavření a plnění smlouvy. Ve formuláři můžete zaškrtnutím **odmítnout**, abychom vám e-mailem posílali naše sezónní nabídky (obchodní sdělení o našich obdobných službách, § 7 odst. 3 zákona č. 480/2004 Sb.); odmítnout je můžete i později odkazem v každé takové zprávě (podrobnosti v Zásadách ochrany osobních údajů, oddíl 8). Před odesláním vám přehledně zobrazíme: popis kol a termín, **celkovou cenu nájemného včetně všech daní a poplatků**, výši rezervačního poplatku, který platíte teď, výši doplatku, výši a formu kauce, storno podmínky (čl. 6) a upozornění, že u rezervace na konkrétní termín nemáte zákonné právo odstoupit ve 14 dnech (čl. 7). Tím plníme informační povinnost podle § 1811 odst. 2, § 1820 odst. 1 a § 1826a odst. 1 OZ.

3.2 **Odeslání rezervace.** Rezervaci odesíláte tlačítkem označeným **„Objednávka zavazující k platbě“** (§ 1826a odst. 2 OZ). Před odesláním potvrdíte zaškrtnutím, že jste se seznámili s těmito podmínkami, a **samostatným zaškrtnutím** potvrdíte storno podmínky (čl. 6), platby nad rámec ceny (čl. 4.7) a poučení o nemožnosti odstoupit (čl. 7). Tato ujednání jsou tak přijata výslovně ve smyslu § 1753 OZ. Systém uloží verzi podmínek, se kterou jste souhlasili, čas souhlasu a technický otisk připojení.

3.3 **Vaše rezervace je nabídka k uzavření smlouvy.** Její přijetí vám neprodleně potvrdíme e-mailem (§ 1827 odst. 1 OZ); toto první potvrzení ještě není uzavřením smlouvy.

3.4 **Kdy je smlouva uzavřena.** Smlouva o nájmu je uzavřena okamžikem, kdy vám po připsání rezervačního poplatku odešleme e-mail **„Potvrzení rezervace“**. V něm najdete rekapitulaci (kola, termín, cena, zaplaceno, doplatek, kauce), doklad o platbě, tyto podmínky v textové podobě (§ 1827 odst. 2 OZ) a odkaz pro správu rezervace. Tento e-mail je zároveň **potvrzením o uzavřené smlouvě** v textové podobě podle § 1824a odst. 1 OZ a obsahuje údaje podle § 1820 odst. 1 OZ. Doporučujeme e-mail uschovat. Den před začátkem nájmu vám pošleme **připomínku** s časem převzetí, výší a možnými formami kauce a seznamem, co vzít s sebou (doklad totožnosti, platební kartu nebo hotovost na kauci), případně s odkazem na zaplacení doplatku online. Připomínka je servisní zpráva k vaší smlouvě, ne obchodní sdělení.

3.5 **Nezaplacený poplatek.** Nepřipíše-li se rezervační poplatek ve lhůtě podle čl. 4.4, rezervace bez dalšího zaniká a kola uvolníme jiným zákazníkům; o zániku vás informujeme e-mailem. Dojde-li platba později, rezervaci obnovíme, pokud jsou kola stále volná; jinak vám platbu vrátíme do {{LHUTA_VRATKY}} stejnou cestou, jakou k nám přišla.

3.6 **Rezervace s platbou na místě.** *(Zobrazí se, jen když {{PLATBA_NA_MISTE_POVOLENA}} = ano.)* Pokud zvolíte „zaplatím na místě“, neplatíte rezervační poplatek a jde o **nezávaznou rezervaci**: smlouva o nájmu vzniká až převzetím kola. Do té doby ji můžete kdykoli bezplatně zrušit a můžeme ji zrušit i my, zejména nepotvrdíte-li ji na naši výzvu (e-mail nebo SMS den předem). Kola pro vás držíme do uplynutí lhůty {{NO_SHOW_LHUTA}} od sjednaného začátku nájmu.

3.7 **Rezervace na místě bez webu.** Přijdete-li bez rezervace, uzavíráme smlouvu podpisem předávacího protokolu; tyto podmínky platí stejně, s výjimkou ustanovení, která se týkají jen online rezervace (čl. 3.1–3.6, čl. 4.4, čl. 6.1–6.4).

3.8 **Jazyk a uchování.** Smlouvu uzavíráme v českém jazyce. Podmínky jsou trvale dostupné na {{PODMINKY_URL}} včetně archivu předchozích verzí; verzi, se kterou jste souhlasili, máte v potvrzovacím e-mailu.

## 4. Cena, rezervační poplatek a platba

4.1 **Cena nájemného** se řídí ceníkem účinným v okamžiku odeslání rezervace a závisí na typu kola a délce nájmu. Celková cena, kterou vidíte před odesláním rezervace, je konečná – zahrnuje nájemné za všechna kola a příslušenství na celý termín. Jednotky nájemného (den nájmu, hodina, půlden, týden) jsou vymezeny v čl. 2.3 a v ceníku.

> **[VARIANTA A – plátce DPH]** Všechny ceny v ceníku i v rezervaci jsou uvedeny **včetně DPH**.
>
> **[VARIANTA B – neplátce DPH]** Nejsme plátci DPH; ceny jsou konečné a DPH se k nim nepřičítá.

4.2 **Rezervační poplatek.** Při rezervaci platíte rezervační poplatek ve výši **{{POPLATEK_KOLO}} za každé kolo** a **{{POPLATEK_EKOLO}} za každé elektrokolo** (u dalších typů – dětská kola, vozíky, příslušenství – ve výši podle ceníku). Poplatek je součet částek za všechna rezervovaná kola a je **zálohou na nájemné** (§ 1807 OZ): při vyúčtování se **v plné výši odečte od celkové ceny**. Není to platba navíc. Při zrušení rezervace se vrací podle storno tabulky (čl. 6).

4.3 **Doplatek** = celková cena − zaplacený rezervační poplatek (± případný přeplatek). Doplatek můžete zaplatit **online** (kartou nebo převodem / QR Platbou kdykoli před převzetím přes odkaz v potvrzovacím e-mailu) nebo **na místě při převzetí** (hotově nebo platební kartou přes terminál). *(Zobrazí se, jen když {{DOPLATEK_PREDEM_POVINNY}} = ano:)* Doplatek je třeba zaplatit nejpozději před převzetím kola; bez něj kola nevydáme. Ujednáním o placení nájemného předem se odchylujeme od § 2324 OZ (splatnost nájemného po skončení užívání), což zákon připouští.

4.4 **Platební metody rezervačního poplatku a doplatku online:**
- **Platební karta** (včetně Apple Pay / Google Pay a případných bankovních tlačítek) přes platební bránu {{PLATEBNI_BRANA_NAZEV}}. Po kliknutí na zaplatit vás přesměrujeme na zabezpečenou stránku brány; údaje o kartě zadáváte jen tam, my k nim nemáme přístup. Platba je zpravidla připsána ihned.
- **Bankovní převod nebo QR Platba** na účet {{BANKOVNI_UCET}} s variabilním symbolem = číslem rezervace. Zobrazíme vám QR kód i platební údaje. Rezervaci držíme **{{LHUTA_PLATBY_POPLATKU}}**; připsání převodu může trvat až 1–2 pracovní dny, s tím počítejte. Dojde-li méně než je účtováno, ale rozdíl nepřesahuje {{TOLERANCE_PLATBY}}, považujeme platbu za úplnou; větší nedoplatek vás požádáme doplatit (e-mail s QR kódem). Přeplatek vrátíme nebo se souhlasem započteme na doplatek.
- **Na místě**: hotově nebo kartou přes terminál (doplatek, kauce, případné náhrady).

4.5 **Doklady.** Ke každé platbě dostanete e-mailem doklad; při převzetí a vrácení předávací protokol s vyúčtováním.

> **[VARIANTA A – plátce DPH]** K rezervačnímu poplatku vystavíme **daňový doklad k přijaté platbě** do 15 dnů ode dne, kdy jsme platbu přijali (§ 20a odst. 2 a § 28 odst. 8 ZDPH). Po skončení nájmu vystavíme **konečný daňový doklad**, ve kterém je základ daně snížen o zaplacený poplatek. Zrušíte-li rezervaci před začátkem nájmu a část poplatku si ponecháme jako storno poplatek (čl. 6.2), posuzujeme ji podle převažujícího výkladu (rozsudek Soudního dvora EU C-277/05 Société thermale d'Eugénie-les-Bains) jako paušální náhradu, která není úplatou za plnění a nepodléhá DPH; k původnímu daňovému dokladu vystavíme do 15 dnů opravný daňový doklad (§ 42 odst. 1 a 2, § 45 ZDPH). Nevyzvednete-li kola (čl. 6.5), vystavíme k ponechané částce konečný daňový doklad **s DPH** – kola jsme pro vás měli připravená a podle judikatury Soudního dvora EU je taková platba úplatou za službu.
>
> **[VARIANTA B – neplátce DPH]** Vystavujeme doklad o zaplacení (nejde o daňový doklad pro účely DPH) a po skončení nájmu konečné vyúčtování se započtením rezervačního poplatku.

4.6 **Kauce není součástí ceny.** Platí se zvlášť při převzetí (čl. 5), nepodléhá DPH a nevystavuje se k ní daňový doklad; její převzetí a vrácení potvrdíme v předávacím protokolu.

4.7 **Co dalšího vám můžeme účtovat – přehled.** Kromě ceny nájemného a kauce můžeme požadovat jen částky uvedené v této tabulce, a to jen v situacích zde popsaných. Na tabulku vás upozorňujeme před odesláním rezervace (čl. 3.2).

| Situace | Co účtujeme | Kde je to vysvětleno |
|---|---|---|
| Zrušení rezervace nebo nevyzvednutí kol | část rezervačního poplatku podle storno tabulky (storno poplatek – paušální náhrada) | čl. 6.2, 6.5 |
| Předčasné ukončení nájmu z naší strany pro porušení čl. 9 | náhrada škody, která nám porušením vznikla (např. oprava, výjezd pro kolo); nájemné za nevyužitou dobu vracíme | čl. 6.8 |
| Vrácení po sjednaném konci nájmu (po toleranci {{TOLERANCE_POZDNI}}) | další nájemné: {{SAZBA_POZDNI}} | čl. 11.3 |
| Vrácení po konci otevírací doby bez předchozí domluvy | smluvní pokuta {{POPLATEK_POZDNI_PAUSAL}} + nájemné za dobu prodlení | čl. 11.4 |
| Silně znečištěné kolo | paušál za umytí {{POPLATEK_CISTENI}} | čl. 11.5 |
| Elektrokolo s baterií pod 20 % | {{POPLATEK_NABITI}} *(jen je-li částka vyšší než 0 Kč)* | čl. 11.6 |
| Poškození kola | skutečné náklady na opravu, nejvýše obvyklá cena kola z protokolu | čl. 10.2 |
| Ztráta, zničení nebo krádež kola | obvyklá cena kola uvedená v předávacím protokolu (případně snížená podle čl. 10.6) | čl. 10.3, 10.6 |
| Ztráta nebo zničení příslušenství | paušál podle ceníku náhrad | čl. 10.4 |
| Prodlení s platbou náhrady | zákonný úrok z prodlení (§ 1970 OZ, výše podle nařízení vlády) | čl. 10.8 |

Žádné jiné sankce nesjednáváme. Smluvní pokutu sjednáváme jen v jednom případě (čl. 11.4) a v částce odpovídající našim běžným nákladům; soud ji může na váš návrh snížit, byla-li by nepřiměřená (§ 2051 OZ).

> **[VARIANTA A – plátce DPH]** Další nájemné za prodlení a paušály za umytí a nabití jsou cenou služby a částky v tabulce i v ceníku jsou uvedeny **včetně DPH**; smluvní pokuta, náhrada škody a storno poplatek při zrušení před nájmem DPH nepodléhají a na dokladu je uvádíme bez daně (k nevyzvednutí kol viz čl. 4.5).

## 5. Kauce

5.1 **Výše.** Při převzetí skládáte kauci **{{KAUCE_KOLO}} za každé kolo** a **{{KAUCE_EKOLO}} za každé elektrokolo** (u dalších typů podle ceníku). Výši kauce vidíte už při rezervaci. Bez složení kauce kola nevydáme.

5.2 **Forma – můžete si vybrat:**
- **a) Hotově nebo platební kartou přes terminál na místě.** Částku a formu zapíšeme do předávacího protokolu. U platby terminálem jde o skutečnou platbu, kterou vám při vrácení kola vrátíme na tutéž kartu (připsání trvá podle banky obvykle 1–5 pracovních dnů); hotovost vracíme ihned při vrácení.
- **b) Preautorizace (blokace) na platební kartě** přes platební bránu {{PLATEBNI_BRANA_NAZEV}}. Při převzetí vám pošleme odkaz nebo ukážeme QR kód na platební stránku brány, kde kartu autorizujete. Částka se **z karty nestrhne, pouze zablokuje**; po dobu blokace s ní nemůžete disponovat. Při řádném vrácení blokaci ihned uvolníme; vaše banka uvolnění zpravidla zobrazí do několika pracovních dnů (závisí na vydavateli karty, ne na nás). Blokace u karet trvá omezeně, proto je **preautorizace možná jen u nájmu nejdéle na {{PREAUTH_MAX_DNU}} dní**; u delšího nájmu použijte formu a). Potřebujete kartu s dostatečným limitem; kartu, která blokaci neumožňuje (některé předplacené nebo virtuální karty), brána odmítne.

5.3 **K čemu kauce slouží.** Kauci můžeme použít jen na úhradu toho, co nám podle těchto podmínek dlužíte: náhradu škody na kole nebo příslušenství, náhradu za ztracené či odcizené kolo nebo příslušenství, nájemné za dobu prodlení s vrácením, smluvní pokutu podle čl. 11.4 a paušály podle čl. 11.5–11.6. Použití kauce je započtením (§ 1982 OZ); vždy vám ukážeme výpočet v protokolu o vrácení nebo ve vyúčtování podle čl. 10.7.

5.4 **Vrácení kauce.** Vrátíte-li kola včas, čistá, kompletní a nepoškozená, vrátíme (uvolníme) kauci **ihned při vrácení** v plné výši. Zjistíme-li škodu, vrátíme ihned část kauce převyšující odhadovanou škodu; zbytek vyúčtujeme podle čl. 10.7 a do {{LHUTA_VYUCTOVANI_SKODY}} vrátíme, co nebylo použito. U preautorizace strhneme z blokované částky jen vyúčtovanou škodu a zbytek uvolníme.

5.5 **Kauce není limitem odpovědnosti.** Je-li škoda vyšší než kauce, dlužíte rozdíl (čl. 10.7). Je-li nižší, vracíme zbytek. Kauce není pojištěním.

5.6 Kauci nelze složit převodem na účet předem (vrácení by bylo zdlouhavé) ani ji nahradit zanecháním dokladu totožnosti nebo jiné věci – doklad nesmíme přijmout jako zástavu (§ 39 písm. b) zákona o občanských průkazech, § 2 odst. 2 zákona o cestovních dokladech).

## 6. Storno a změny rezervace; zrušení z naší strany

6.1 **Jak zrušit.** Rezervaci můžete zrušit kdykoli před začátkem nájmu, a to odkazem „Spravovat rezervaci“ v potvrzovacím e-mailu, nebo e-mailem na {{PUJCOVNA_EMAIL}} (uveďte číslo rezervace). Rozhoduje okamžik, kdy nám zrušení dojde. Zrušit lze i jen některá kola; storno se pak počítá za každé zrušené kolo zvlášť.

6.2 **Storno tabulka.** Zrušení rezervace před začátkem nájmu je vaše **smluvní právo odstoupit od smlouvy** (§ 2001 OZ); zrušením závazek zaniká. Z rezervačního poplatku vám vrátíme část podle této tabulky; část, kterou si ponecháme, je **storno poplatek** – sjednané paušální vypořádání zálohy (§ 1807 OZ) za to, že jsme pro vás kola blokovali a nemohli je pronajmout jinému zákazníkovi. Jeho výše odpovídá našim průměrným nákladům na vyřízení rezervace a ušlému nájemnému z blokace kola a nezávisí na délce nájmu. Nic dalšího (zejména nájemné za zbytek termínu ani náhradu škody) po vás nepožadujeme.

{{STORNO_TABULKA}}

*Výchozí návrh tabulky:*

| Zrušení nám dojde | Vrátíme z rezervačního poplatku za zrušené kolo | Ponecháme si (storno poplatek) |
|---|---|---|
| 72 hodin a více před začátkem nájmu | 100 % | 0 % |
| méně než 72 hodin, ale alespoň 24 hodin před začátkem nájmu | 50 % | 50 % |
| méně než 24 hodin před začátkem nájmu | 0 % | 100 % |
| kola si nevyzvednete (čl. 6.5) | 0 % | 100 % |

Zaplacený doplatek vracíme při jakémkoli zrušení **vždy v plné výši**. Zaplacení rezervačního poplatku ani doplatku vás práva zrušit rezervaci nezbavuje. Stejné pravidlo platí zrcadlově i pro nás: zrušíme-li rezervaci my, dostanete vedle vrácení všech plateb náhradu podle čl. 6.6.

6.3 **Změna rezervace.** Změnu termínu, počtu, typu nebo velikosti kol vyřídíme **bezplatně**, požádáte-li o ni nejpozději **{{ZMENA_TERMINU_LHUTA}}** před začátkem nájmu a je-li v novém termínu volná kapacita; rozdíl v ceně doúčtujeme nebo vrátíme. Pozdější žádost nebo změna, pro kterou není kapacita, se posuzuje jako zrušení původní rezervace (čl. 6.2) a nová rezervace. Změny domluvíte e-mailem nebo telefonicky; potvrdíme je e-mailem.

6.4 **Vrácení peněz** provedeme do **{{LHUTA_VRATKY}}** od zrušení, stejnou cestou, jakou jste platili: kartou → vratka přes platební bránu na tutéž kartu; převodem → na účet, ze kterého platba přišla. Za rezervaci zaplacenou na místě vracíme hotově nebo převodem podle vaší volby.

6.5 **Nevyzvednutí kol (no-show).** Nepřevezmete-li kola do **{{NO_SHOW_LHUTA}}** od sjednaného začátku nájmu a nedomluvíte-li se s námi na pozdějším převzetí, rezervace zaniká, rezervační poplatek si ponecháme jako storno poplatek podle tabulky v čl. 6.2 a zaplacený doplatek vrátíme. Zavoláte-li včas, že se zpozdíte, kola vám podržíme podle možností; zkrácení nájmu způsobené vaším zpožděním nezakládá právo na slevu.

6.6 **Zrušení z naší strany.** Nemůžeme-li vám rezervovaná kola poskytnout (např. porucha, poškození nebo krádež kola, nemoc obsluhy, uzavření provozovny, vyšší moc), nabídneme vám **náhradní kolo stejné nebo vyšší kategorie za stejnou cenu**, případně kolo nižší kategorie se slevou – jen s vaším souhlasem. Nepřijmete-li náhradu, nebo žádnou nemáme, rezervaci zrušíme a **vrátíme vše, co jste zaplatili** (rezervační poplatek i doplatek), do {{LHUTA_VRATKY}}. Zrušíme-li jen část kol, platí to pro zrušenou část.

Zrušíme-li rezervaci **z důvodů na naší straně** (tedy nikoli pro vyšší moc – např. živelní událost, úřední zákaz provozu, krádež kola nahlášená policii) a nepřijmete-li náhradní kolo, vyplatíme vám vedle vrácení všech plateb **náhradu ve výši částky, kterou bychom si podle storno tabulky v čl. 6.2 ponechali, kdybyste ve stejném okamžiku rezervaci zrušili vy** – při zrušení méně než 24 hodin před začátkem nájmu nebo nevydání kol v sjednaném čase tedy celý rezervační poplatek za každé nevydané kolo. Náhradu vyplatíme spolu s vratkou. Vaše zákonná práva (např. na náhradu škody, kterou jsme způsobili porušením smlouvy) tím nejsou dotčena; vyplacená náhrada se na případnou škodu započítá.

6.7 **Počasí.** Déšť, vítr ani chladno nejsou samy o sobě důvodem k bezplatnému zrušení – kola jsou k dispozici a termín je pro vás blokován. {{STORNO_POCASI}}

6.8 **Předčasné ukončení z naší strany během nájmu.** Smlouvu můžeme vypovědět bez výpovědní doby a požadovat okamžité vrácení kola, pokud ho užíváte v rozporu s čl. 9 způsobem, který kolo nebo jiné osoby ohrožuje (zejména jízda pod vlivem alkoholu, závody, přenechání třetí osobě), a na výzvu toho nenecháte (sjednaný důvod výpovědi; vedle něj platí zákonné právo vypovědět nájem bez výpovědní doby při zvlášť závažném porušení povinností, § 2232 OZ). Nájemné za dobu od vrácení kola do sjednaného konce nájmu vám **vrátíme**; můžeme si na ně započíst náhradu škody, která nám porušením čl. 9 vznikla (např. náklady na opravu nebo na výjezd pro kolo), a to po vyúčtování podle čl. 10.7.

## 7. Odstoupení od smlouvy – poučení

7.1 Smlouvu uzavíráte na dálku (přes web). Spotřebitel má obvykle právo odstoupit od smlouvy uzavřené na dálku do 14 dnů bez udání důvodu (§ 1829 odst. 1 OZ). **Na nájem kola na konkrétní termín se toto právo nevztahuje**: podle **§ 1837 písm. j) OZ** nemůže spotřebitel odstoupit od smlouvy „o ubytování, přepravě zboží, nájmu dopravního prostředku, stravování nebo využití volného času, pokud má být podle smlouvy plněno k určitému datu nebo v určitém období“. Na to vás výslovně upozorňujeme před odesláním rezervace (§ 1820 odst. 1 písm. l) OZ).

7.2 Místo zákonného odstoupení platí **storno podmínky v čl. 6**, které vám umožňují rezervaci zrušit kdykoli před začátkem nájmu, při včasném zrušení bez jakékoli srážky.

7.3 Práva odstoupit od smlouvy z důvodů stanovených zákonem (např. podstatné porušení smlouvy z naší strany, § 2002 OZ, nebo nevyřízení reklamace ve lhůtě, čl. 12.6) zůstávají nedotčena.

## 8. Převzetí kola

8.1 **Kde a kdy.** Kola přebíráte na výdejním místě {{PUJCOVNA_PROVOZOVNA}} v otevírací době {{OTEVIRACI_DOBA}}, v čase sjednaném v rezervaci. Počítejte s 10–20 minutami na převzetí (kontrola, protokol, kauce, zaškolení).

8.2 **Kdo může kolo převzít.** Kolo může převzít jen zákazník uvedený v rezervaci, který **dovršil 18 let** a je plně svéprávný (§ 30 OZ). Osobám mladším 18 let kola nepronajímáme; mohou na nich jezdit jako členové vaší skupiny nebo rodiny, přičemž nájemcem a odpovědnou osobou jste vy (čl. 2.3). Kolo nevydáme osobě, která je zjevně pod vlivem alkoholu nebo jiné návykové látky, nebo která odmítne předložit doklad podle čl. 8.3.

8.3 **Doklad totožnosti.** Při převzetí předložíte platný doklad totožnosti: {{DOKLADY_AKCEPTOVANE}}. Do dokladu **pouze nahlédneme, abychom ověřili vaši totožnost, a do předávacího protokolu zapíšeme jeho typ a číslo**. Doklad nekopírujeme, neskenujeme ani nefotografujeme (zákaz pořizovat kopii bez souhlasu držitele: § 39 písm. c) zákona o občanských průkazech, § 2 odst. 3 zákona o cestovních dokladech) a nikdy si ho neponecháváme jako zástavu (§ 39 písm. b) zákona o občanských průkazech, § 2 odst. 2 zákona o cestovních dokladech). Vycházíme ze stanoviska Úřadu pro ochranu osobních údajů „Prokazování totožnosti a zpracování osobních údajů“ z května 2021, podle kterého má zpravidla stačit předložení dokladu a opsání nezbytných údajů, nikoli jeho kopie. Typ a číslo dokladu zpracováváme na základě našeho oprávněného zájmu (čl. 6 odst. 1 písm. f) GDPR) – ochrana majetku a možnost vymáhat náhradu při škodě nebo krádeži; § 39 písm. d) zákona o občanských průkazech připouští nahlédnutí do průkazu v souvislosti s ověřováním totožnosti, které právní předpis umožňuje. Údaj je uložen šifrovaně a po vrácení kola a vypořádání kauce ho **automaticky smažeme do {{DOBA_CISLO_DOKLADU}}**; déle jen při nevyřešené škodě, krádeži nebo nezaplacení (podrobnosti v Zásadách ochrany osobních údajů, oddíl 4). Bez předložení dokladu kolo vydat nemůžeme; v takovém případě se rezervace posuzuje jako nevyzvednutá (čl. 6.5).

8.4 **Kontrola kola a předávací protokol.** Před převzetím kolo společně prohlédneme (rám, brzdy, řazení, kola a pláště, osvětlení, u elektrokola baterii a displej). Do protokolu zapíšeme: identifikaci každého kola (výrobní číslo nebo číslo štítku), velikost, stav a existující poškození, předané příslušenství (zámek s klíči, přilba, nabíječka, světla, brašna, dětská sedačka či vozík), **obvyklou cenu kola** pro případ ztráty či zničení (čl. 10.3), výši a formu kauce, zaplacený doplatek a sjednaný čas a místo vrácení. Protokol podepisujete vy i my (na papíře nebo na obrazovce); kopii dostanete e-mailem (číslo vašeho dokladu je v kopii z bezpečnostních důvodů maskované; úplné zůstává jen v našem zabezpečeném systému). **Máte právo kolo odmítnout, není-li způsobilé k provozu nebo ke sjednanému užívání** (§ 2322 odst. 3 OZ); pak vám nabídneme jiné kolo nebo postupujeme podle čl. 6.6. Poškození, které není v protokolu, je po převzetí obtížné dokázat – proto si kolo prohlédněte pozorně a na vše nás upozorněte před odjezdem.

8.5 **Zaškolení k elektrokolu.** U elektrokola vás seznámíme se zapínáním a režimy pohonu, odhadem dojezdu, vyjímáním a nabíjením baterie (jen dodanou nabíječkou), ovládáním displeje a zamykáním. Převzetím elektrokola potvrzujete, že jste zaškolení absolvovali a pokynům rozumíte. Elektrokolo je určeno jezdcům od 15 let *(doporučení výrobců; mladší jezdec jen po dohodě a na odpovědnost nájemce)*.

8.6 **Nastavení a příslušenství.** Výšku sedla a základní nastavení vám upravíme. Přilbu půjčujeme za těchto podmínek: {{PRILBA_PODMINKY}}. Ke každému kolu patří zámek; jeho ztrátu účtujeme podle ceníku náhrad (čl. 10.4).

8.7 **Rozpor mezi protokolem a podmínkami.** Údaje o konkrétních kolech, příslušenství, kauci a čase vrácení platí podle předávacího protokolu; ve všem ostatním platí tyto podmínky.

## 9. Užívání kola

9.1 **Jak kolo užívat.** Kolo užívejte šetrně, jako řádný hospodář (§ 2213 OZ), k účelu, ke kterému je určeno: silniční a trekové kolo na zpevněných cestách, horské kolo v terénu odpovídajícím jeho konstrukci. Dodržujte maximální nosnost uvedenou výrobcem. Kolo udržujte ve stavu, v jakém jste ho převzali, s přihlédnutím k obvyklému opotřebení (§ 2325 odst. 1 OZ).

9.2 **Pravidla silničního provozu.** Při jízdě dodržujte zákon o silničním provozu – cyklista je řidičem nemotorového vozidla (§ 2 písm. d)) a platí pro něj zejména: zákaz požít alkohol během jízdy a zákaz řídit bezprostředně po požití alkoholu nebo užití jiné návykové látky (§ 5 odst. 2 písm. a) a b)); **cyklista mladší 18 let musí mít za jízdy nasazenou a řádně připevněnou ochrannou přilbu** (§ 58 odst. 1); dítě mladší 10 let smí na silnici a místní komunikaci jet jen pod dohledem osoby starší 15 let (§ 58 odst. 2); **dítě mladší 7 let smí v pomocné sedačce s pevnými opěrami pro nohy vézt jen osoba starší 15 let; v přívěsném vozíku určeném pro přepravu dětí smí osoba starší 18 let vézt nejvýše dvě děti mladší 10 let** (§ 58 odst. 3) – jinou přepravu dítěte na kole zákon nedovoluje. Přilbu důrazně doporučujeme všem jezdcům. Za přestupky v provozu odpovídá jezdec.

9.3 **Co je zakázáno:**
- a) přenechat kolo k užívání jiné osobě než osobám uvedeným v rezervaci nebo protokolu (§ 2215 odst. 1 OZ – jen s naším souhlasem), půjčovat ho dál nebo užívat ke komerční přepravě či kurýrní službě;
- b) účastnit se závodů, organizovaných výkonnostních akcí, jezdit v bikeparcích, skákat a provádět triky (není-li kolo k tomu výslovně určeno a nedohodli-li jsme se jinak);
- c) jezdit pod vlivem alkoholu nebo jiných návykových látek;
- d) provádět na kole úpravy, demontovat součásti, měnit nastavení pohonu elektrokola (odstranění omezení rychlosti nebo výkonu je zásahem do konstrukce a může změnit právní režim vozidla), používat jinou než dodanou nabíječku, otevírat baterii;
- e) přetěžovat kolo, vozit další osobu mimo dodanou sedačku či vozík, převážet náklad na rámu nebo řídítkách;
- f) vyjíždět mimo {{UZEMI_UZIVANI}} bez naší předchozí písemné domluvy;
- g) jezdit mimo cesty tam, kde to zakazuje zákon nebo návštěvní řád (lesy – § 20 zákona č. 289/1995 Sb. o lesích; národní parky a chráněná území – zákon č. 114/1992 Sb. o ochraně přírody a krajiny a návštěvní řády);
- h) ponechat kolo bez dozoru neuzamčené, byť na okamžik.

9.4 **Zamykání a úschova.** Kdykoli kolo opustíte, uzamkněte je dodaným zámkem **za rám k pevnému předmětu** (stojan, zábradlí). Přes noc kolo uložte do uzamčené místnosti (pokoj, kolárna, garáž). Baterii elektrokola při delším parkování vyjměte a vezměte s sebou, je-li to možné.

9.5 **Údržba a opravy během nájmu.** Drobnou údržbu (dofouknutí plášťů, oprava defektu dodanou sadou, dotažení sedla) můžete provést sami. Jiné opravy neprovádějte ani nezadávejte bez naší domluvy; nejprve zavolejte na {{PUJCOVNA_TELEFON}}. Náklady na opravu vady, kterou jsme předem odsouhlasili, vám proplatíme proti dokladu, nejlépe při vrácení kola (§ 2208 odst. 1 OZ); náklady na údržbu kola uplatněte nejpozději do tří měsíců od jejich vynaložení, jinak právo na jejich náhradu zaniká (§ 2325 odst. 2 OZ). Zjistíte-li závadu, postupujte podle čl. 12.

9.6 **Nehoda, zranění, krádež.** Při nehodě se zraněním volejte 155/112; při krádeži kola nebo jeho části neprodleně Policii ČR (158) a nás (čl. 10.5). O každé nehodě, při které se kolo poškodilo, nás informujte co nejdříve, nejpozději při vrácení.

## 10. Odpovědnost za škodu, ztrátu a krádež

10.1 **Za co odpovídáte.** Od převzetí do vrácení kola nám odpovídáte za jeho poškození, zničení, ztrátu nebo odcizení a za ztrátu či poškození příslušenství, a to i když škodu způsobila jiná osoba, které jste kolo svěřili, nebo vznikla při pádu či nehodě bez cizího zavinění (§ 2225 odst. 1, § 2325 odst. 1 a § 2913 OZ). Neodpovídáte za **běžné opotřebení** (sjeté pláště a brzdové destičky odpovídající délce nájmu, drobné oděrky laku) a za vady, které kolo mělo již při převzetí nebo které vznikly jeho vadou, nikoli vaším užíváním.

10.2 **Poškození.** Hradíte skutečné, účelně vynaložené náklady na opravu (práce a díly) podle ceníku našeho servisu nebo obvyklé ceny opravy (§ 2969 odst. 1 OZ), nejvýše však obvyklou cenu kola uvedenou v protokolu. Ceník nejčastějších oprav je součástí ceníku na {{CENIK_URL}} – slouží k orientaci a rychlému vyúčtování na místě; vždy můžete požadovat vyúčtování podle skutečných nákladů.

10.3 **Ztráta, zničení, krádež kola.** Hradíte **obvyklou cenu kola v době převzetí uvedenou v předávacím protokolu**, nikoli cenu nového kola (§ 2969 odst. 1 OZ). U elektrokola zahrnuje hodnota i baterii a nabíječku, jsou-li ztraceny s ním.

10.4 **Příslušenství.** Za ztracené nebo zničené příslušenství účtujeme paušál podle ceníku náhrad; paušál odpovídá obvyklé ceně náhradního dílu včetně výměny.

{{CENIK_NAHRAD}}

*Výchozí návrh ceníku náhrad (upraví půjčovna podle svého vybavení):*

| Položka | Paušální náhrada |
|---|---|
| zámek | 500 Kč |
| klíč od zámku (jeden) | 200 Kč |
| přilba | 800 Kč |
| přední / zadní světlo | 300 Kč / kus |
| pumpa, brašna, sada na defekt | 300 Kč / kus |
| nabíječka elektrokola | 2 500 Kč |
| baterie elektrokola | podle ceny výrobce, uvedena v protokolu |
| dětská sedačka / vozík | 2 000 Kč / podle ceny v protokolu |
| klíč nebo displej elektrokola | podle ceny výrobce |

10.5 **Postup při krádeži.** Krádež kola, baterie nebo příslušenství **neprodleně** oznamte Policii ČR (linka 158 nebo nejbližší služebna) a nám na {{PUJCOVNA_TELEFON}}. Do vrácení ostatních věcí nebo do konce nájmu nám předáte číslo jednací policejního protokolu (nebo jeho kopii), **zámek a oba klíče**, pokud je máte, a popis, kde a jak bylo kolo uzamčeno. Policii poskytneme výrobní číslo kola.

10.6 **Omezení náhrady při krádeži.** {{SPOLUUCAST_KRADEZ}} *(Výchozí: neuplatňuje se – hradíte obvyklou cenu kola podle čl. 10.3. Volitelně může půjčovna sjednat: „Bylo-li kolo v okamžiku krádeže řádně uzamčeno dodaným zámkem za rám k pevnému předmětu, krádež jste bez odkladu oznámili policii a předali nám klíče od zámku, omezujeme vaši povinnost k náhradě na … % obvyklé ceny kola.“)*

10.7 **Vyúčtování škody.** Zjevné škody vyčíslíme a odsouhlasíme s vámi v protokolu o vrácení; částku započteme na kauci (čl. 5.3). Nelze-li škodu vyčíslit na místě (nutná diagnostika v servisu, cenová nabídka), zapíšeme do protokolu popis a fotografie poškození a odhad; konečné vyúčtování s doklady vám pošleme do **{{LHUTA_VYUCTOVANI_SKODY}}**. Převyšuje-li škoda kauci, je rozdíl splatný do **{{LHUTA_UHRADY_SKODY}}** od doručení vyúčtování. S vyúčtováním nemusíte souhlasit – můžete podat námitky (čl. 12.5) nebo se obrátit na ČOI či soud (čl. 13).

10.8 **Prodlení s platbou.** Nezaplatíte-li náhradu včas, můžeme požadovat zákonný úrok z prodlení (§ 1970 OZ, výše podle nařízení vlády č. 351/2013 Sb.) a účelně vynaložené náklady na vymáhání. Jiné sankce za prodlení nesjednáváme.

10.9 **Odpovědnost vůči třetím osobám a za vlastní újmu.** Za újmu, kterou při užívání kola způsobíte sobě nebo jiným osobám (chodci, jiní cyklisté, vozidla, majetek), odpovídáte podle zákona vy, nikoli my – ledaže byla způsobena vadou kola nebo porušením naší povinnosti. Doporučujeme uzavřít pojištění odpovědnosti a úrazové pojištění. {{POJISTENI}}

10.10 **Naše odpovědnost.** Odpovídáme vám za újmu způsobenou vadou kola nebo porušením našich povinností podle zákona; tuto odpovědnost vůči spotřebiteli nijak neomezujeme (§ 2898 OZ). Neodpovídáme za věci, které si na kole, v brašně nebo na výdejním místě zapomenete či ponecháte, nebyla-li u nás uložena do úschovy.

## 11. Vrácení kola

11.1 **Kde a kdy.** Kola vracíte na výdejním místě {{PUJCOVNA_PROVOZOVNA}} nejpozději v čase uvedeném v protokolu, v otevírací době. Chcete-li vrátit mimo otevírací dobu, domluvte to s námi předem telefonicky; pokud to umožníme, platí pokyny, které vám dáme (např. uzamčení v určené kolárně dodaným zámkem, vhození klíčů do schránky). Od okamžiku, kdy kolo podle pokynů uložíte a oznámíte nám to SMS nebo e-mailem, další nájemné neúčtujeme a za ztrátu kola z našich prostor neodpovídáte; stav kola zkontrolujeme a zdokumentujeme fotografiemi při nejbližším otevření a vyúčtování (čl. 11.2) vám pošleme e-mailem – za poškození, které při této kontrole zjistíme, odpovídáte podle čl. 10.

11.2 **Protokol o vrácení.** Kolo společně zkontrolujeme a do protokolu zapíšeme čas vrácení, stav, vrácené příslušenství, případné škody a vyúčtování (čl. 10.7). Vrátíme nebo uvolníme kauci (čl. 5.4) a vystavíme konečný doklad. Kopii protokolu dostanete e-mailem (s maskovaným číslem dokladu, čl. 8.4). Odjedete-li bez společné kontroly, platí stav zjištěný námi při kontrole v nejbližší možné době, kterou zdokumentujeme fotografiemi.

11.3 **Pozdní vrácení.** Zpoždění do **{{TOLERANCE_POZDNI}}** neúčtujeme. Vrátíte-li kolo později, platíte za dobu po sjednaném konci nájmu **další nájemné: {{SAZBA_POZDNI}}**. Zavolejte nám, jakmile víte, že se zpozdíte – domluvíme prodloužení (je-li kolo volné) za běžnou cenu podle ceníku.

11.4 **Vrácení po konci otevírací doby bez domluvy.** Vrátíte-li kolo po konci otevírací doby, aniž byste to s námi předem domluvili, musí na vás obsluha čekat nebo se vrátit; proto sjednáváme **smluvní pokutu {{POPLATEK_POZDNI_PAUSAL}}** za rezervaci (ne za každé kolo), vedle nájemného podle čl. 11.3. Pokuta nahrazuje náhradu škody za tento čas (§ 2050 OZ). Pokutu nepožadujeme, pokud zpoždění zavinila závada kola nebo nehoda, kterou jste nám ohlásili.

11.5 **Čistota.** Kolo vracejte v běžně čistém stavu – prach a lehké znečištění z cesty jsou v pořádku. **Silně znečištěné kolo** (nánosy bláta na rámu, pohonu a brzdách, které vyžadují umytí před dalším pronájmem) umyjeme za paušál **{{POPLATEK_CISTENI}}** za kolo.

11.6 **Nabití elektrokola.** Elektrokolo vracejte pokud možno nabité. *(Zobrazí se, jen když {{POPLATEK_NABITI}} > 0 Kč:)* Elektrokolo vrácené s baterií nabitou pod 20 % nabijeme za paušál {{POPLATEK_NABITI}}.

11.7 **Dřívější vrácení.** Vrátíte-li kolo dříve, než bylo sjednáno, nájem končí převzetím kola. *(Zobrazí se podle {{DRIVEJSI_VRACENI_REFUND}}:)* **[ne]** Nájemné za nevyužitou dobu se nevrací – kolo bylo po celou sjednanou dobu rezervováno pro vás a nemohli jsme je nabídnout jinému zákazníkovi. **[ano]** Nájemné za celé nevyužité dny vracíme, podaří-li se nám kolo na tyto dny pronajmout jinému zákazníkovi.

11.8 **Nevrácení kola.** Nevrátíte-li kolo do 24 hodin po sjednaném konci nájmu a nereagujete na naše pokusy o kontakt, považujeme kolo za odcizené: oznámíme věc Policii ČR (neoprávněné užívání cizí věci, § 207 trestního zákoníku), použijeme kauci a budeme požadovat obvyklou cenu kola podle čl. 10.3 a nájemné do dne oznámení.

## 12. Závady a reklamace

12.1 **Naše povinnosti.** Předáme vám kolo způsobilé k provozu a ke sjednanému užívání, seřízené a s funkčními brzdami, řazením a osvětlením, u elektrokola s nabitou baterií, a po dobu nájmu ho udržujeme v takovém stavu (§ 2205, § 2322 odst. 2 OZ). Plníme bez vad, s vlastnostmi obvyklými pro daný typ kola (§ 1914 odst. 1 OZ).

12.2 **Závada během nájmu.** Zjistíte-li závadu nebo poškození, které ovlivňuje bezpečnost nebo funkci kola, **přestaňte na kole jezdit a hned nám zavolejte** na {{PUJCOVNA_TELEFON}} (§ 2214 OZ). Domluvíme opravu na místě, výměnu kola (přivezeme nebo si ho vyzvednete) nebo ukončení nájmu. Pokud závadu nedokážeme odstranit ani kolo vyměnit bez zbytečného odkladu, máte právo na **přiměřenou slevu z nájemného** za dobu, po kterou jste kolo nemohli užívat (§ 2208 odst. 1 OZ), a při vážné závadě na ukončení nájmu s vrácením nájemného za nevyužitou dobu. Závady způsobené porušením čl. 9 (např. ohnutý disk po skoku) jdou k vaší tíži.

12.3 **Jak reklamovat.** Vady služby (např. jiné kolo než objednané, nefunkční vybavení, špatné vyúčtování) reklamujte co nejdříve – osobně na výdejním místě, e-mailem na {{PUJCOVNA_EMAIL}} nebo telefonicky; uveďte číslo rezervace a popis vady, přiložte fotografie. Vadu kola nám oznamte bez zbytečného odkladu po jejím zjištění, nejlépe ještě během nájmu (§ 2214 OZ) – pozdní oznámení může ztížit její prokázání; zákonná lhůta pro vytknutí vady je šest měsíců od převzetí kola (§ 1921 odst. 1 OZ). Práva ze špatného vyúčtování, z nevrácené kauce nebo na vrácení přeplatku můžete uplatnit ve lhůtách podle zákona (promlčecí lhůta 3 roky, § 629 OZ); tyto podmínky žádnou zákonnou lhůtu nezkracují.

12.4 **Potvrzení a vyřízení.** Při uplatnění reklamace vám vydáme písemné potvrzení (e-mailem), kdy jste ji uplatnili, co je jejím obsahem, jaký způsob vyřízení požadujete a na jaký kontakt vás o vyřízení budeme informovat (§ 19 odst. 2 ZOS); po vyřízení vám vydáme potvrzení o datu a způsobu vyřízení, případně písemné odůvodnění zamítnutí (§ 19 odst. 5 ZOS). Reklamaci vyřídíme **nejpozději do 30 dnů** od uplatnění, nedohodneme-li se na delší lhůtě (§ 19 odst. 3 ZOS).

12.5 **Námitky proti vyúčtování škody.** Nesouhlasíte-li s vyúčtováním podle čl. 10.7, dejte nám to vědět co nejdříve, nejlépe do 14 dnů od jeho doručení, abychom věc vyřešili ještě před splatností; postupujeme stejně jako u reklamace (čl. 12.4) a do vyřízení námitek spornou část nevymáháme. Pozdější námitky vaše práva nezkracují.

12.6 **Nevyřízení včas.** Nevyřídíme-li reklamaci ve lhůtě podle čl. 12.4, můžete od smlouvy odstoupit nebo požadovat přiměřenou slevu (§ 19 odst. 4 ZOS).

## 13. Mimosoudní řešení sporů

13.1 Jste-li spotřebitel a nepodaří-li se nám spor vyřešit přímo, máte právo na mimosoudní řešení spotřebitelského sporu (§ 20d a násl. ZOS). Příslušným subjektem je **Česká obchodní inspekce**, Ústřední inspektorát – oddělení ADR, Gorazdova 1969/24, 120 00 Praha 2, podatelna@coi.gov.cz, web **https://www.coi.gov.cz/informace-o-adr/** (§ 14 odst. 1 ZOS). Návrh lze podat online formulářem na uvedené adrese **nejpozději do 1 roku** ode dne, kdy jste u nás své právo poprvé uplatnili. Řízení je bezplatné; náklady si každá strana nese sama. Nepodaří-li se spor vyřešit přímo, pošleme vám tyto informace o ČOI znovu e-mailem (§ 14 odst. 2 ZOS).

13.2 Spor můžete řešit také u obecného soudu podle zákona č. 99/1963 Sb., občanského soudního řádu. Mimosoudní řešení není podmínkou pro podání žaloby.

## 14. Ochrana osobních údajů

14.1 Správcem vašich osobních údajů (jméno, kontakt, údaje o rezervaci a platbách, typ a číslo dokladu totožnosti) jsme my, {{PUJCOVNA_NAZEV}}. Údaje zpracováváme především pro uzavření a plnění smlouvy (čl. 6 odst. 1 písm. b) GDPR), pro splnění účetních a daňových povinností (písm. c)) a v rozsahu typu a čísla dokladu a bezpečnostních záznamů na základě oprávněného zájmu (písm. f)). Souhlas po vás k uzavření smlouvy nepožadujeme.

14.2 Údaje pro nás zpracovává provozovatel webu {{PROVOZOVATEL_NAZEV}} (hosting a rezervační systém, servery v EU) a dále je přijímá platební brána {{PLATEBNI_BRANA_NAZEV}} (údaje o platbě; údaje o kartě zpracovává výhradně brána), naše banka, poskytovatel e-mailové služby a naše účetní. Při krádeži, poškození kola, nezaplacení nebo sporu můžeme nezbytné údaje (jméno, kontakt, typ a číslo dokladu, údaje o výpůjčce) předat Policii ČR, soudu, případně naší pojišťovně. Jinak údaje nikomu dalšímu nepředáváme ani neprodáváme (úplný přehled příjemců v Zásadách ochrany osobních údajů, oddíl 5).

14.3 Web používá pouze technicky nezbytné cookies (přihlášení, rozpracovaná rezervace, ochrana formulářů) – k těm není podle § 89 odst. 3 ZEK potřeba souhlas. Případné analytické nebo marketingové nástroje spouštíme jen s vaším souhlasem.

14.4 Úplné informace podle čl. 13 GDPR – účely, právní základy, doby uchování (včetně lhůty výmazu čísla dokladu po vypořádání kauce), příjemci, vaše práva (přístup, oprava, výmaz, omezení, přenositelnost, námitka) a právo podat stížnost u Úřadu pro ochranu osobních údajů – najdete v samostatném dokumentu **Zásady ochrany osobních údajů** na **{{ZASADY_URL}}**. Zásady nejsou součástí smlouvy; jsou informací, kterou vám poskytujeme.

## 15. Závěrečná ustanovení

15.1 **Rozhodné právo.** Smlouva a tyto podmínky se řídí právem České republiky, zejména OZ a ZOS. Jste-li spotřebitel s bydlištěm v jiném členském státě EU, nejste tím zbaveni ochrany, kterou vám poskytují kogentní předpisy státu vašeho bydliště.

15.2 **Změny podmínek.** Podmínky můžeme měnit; pro vaši rezervaci vždy platí **verze účinná v okamžiku odeslání rezervace**, kterou jste odsouhlasili a kterou máte v potvrzovacím e-mailu. Nová verze se použije jen na rezervace odeslané po její účinnosti. Všechny verze s datem účinnosti archivujeme na {{PODMINKY_URL}}.

15.3 **Oddělitelnost.** Je-li nebo stane-li se některé ustanovení neplatným, neúčinným nebo – vůči spotřebiteli – zneužívajícím (§ 1813–1815 OZ), nepřihlíží se k němu a ostatní ustanovení zůstávají v platnosti.

15.4 **Komunikace.** Komunikujeme s vámi e-mailem na adresu z rezervace a telefonicky. E-mail je doručen okamžikem, kdy dojde do vaší e-mailové schránky (§ 570 odst. 1 OZ); není-li tento okamžik zřejmý, platí, že došel třetí pracovní den po odeslání (obdobně § 573 OZ). Lhůty, které běží od doručení (např. splatnost vyúčtování škody podle čl. 10.7), počítáme od tohoto okamžiku. Své kontaktní údaje můžete změnit přes správu rezervace.

15.5 **Jazykové verze.** Pokud web nabízí překlad podmínek, je určen jen pro informaci; závazná je česká verze.

15.6 **Předávací protokol a smlouva o nájmu** podepisované při převzetí tvoří spolu s těmito podmínkami a potvrzením rezervace úplnou smlouvu. Ústní ujednání, která nejsou v protokolu, nejsou závazná.

15.7 Tyto podmínky, verze **{{VERZE}}**, jsou účinné od **{{UCINNOST_OD}}**.

---

## K ověření advokátem

Body, u kterých si nejsme jisti právní kvalifikací, nebo kde záleží na rozhodnutí půjčovny. Číslování článků odkazuje na text výše. Nálezy dvou oponentur (právo ČR; GDPR a praktičnost) jsou do textu zapracovány; zde zůstávají jen body, které zapracování neuzavřelo, nebo kde oponent navrhl variantu vyžadující rozhodnutí.

**Právní konstrukce rezervace a storna**

1. **Konstrukce storna (čl. 6.2).** Po oponentuře jsme opustili kvalifikaci ponechané části poplatku jako odstupného podle § 1992 OZ (věta druhá vylučuje odstupné u strany, která již plnila – zákazník poplatek zaplatil; odchylka u spotřebitele nemusí obstát) a storno sjednáváme jako **smluvní právo odstoupit (§ 2001 OZ) s paušálním vypořádáním zálohy (§ 1807 OZ)**, s větou, že částka odpovídá průměrným nákladům a ušlému nájemnému. Ověřit: (a) že ponechaná část nebude posouzena jako smluvní pokuta bez porušení povinnosti (neplatná, § 2048 OZ) ani jako nepřiměřená sankce (§ 1814 odst. 1 písm. l) OZ); (b) že půjčovna výši doloží (u 300/500 Kč na kolo jde přibližně o jednodenní nájemné); (c) zda se nevrátit k § 1992 s výslovnou odchylkou od věty druhé, považuje-li ji advokát za dispozitivní.
2. **Reciprocita (čl. 6.2, 6.6) a 100 % propadnutí (čl. 6.2, 6.5, 8.3).** § 1814 odst. 1 písm. c) OZ (příloha bod 1 písm. d) směrnice 93/13/EHS) vyžaduje, aby spotřebitel měl při zrušení ze strany podnikatele právo na odpovídající náhradu – doplněno do čl. 6.6 jako náhrada ve výši částky podle storno tabulky, mimo případy vyšší moci. Ověřit, že rozhraní „důvody na naší straně“ / „vyšší moc“ je dostatečně určité (krádež kola jsme zařadili k vyšší moci – posoudit). **Rozhodnutí půjčovny:** zda u nevyzvednutí (čl. 6.5) a odmítnutí dokladu (čl. 8.3) ponechat výchozích 100 % poplatku, nebo pro přiměřenost podle § 1813 OZ vracet část (oponent navrhuje 50 %), případně vracet poplatek, podaří-li se kolo týž den pronajmout jinému zákazníkovi. Poplatek je fixní – u jednodenního nájmu je to významná část ceny, u týdenního malý zlomek.
3. **Nezávazná rezervace s platbou na místě (čl. 3.6).** Konstrukce „smlouva vzniká až převzetím“ – ověřit, že nejde o smlouvu o smlouvě budoucí ani o jednostranně nevýhodné ujednání (§ 1814 písm. d) OZ – právo podnikatele zrušit bez obdobného práva spotřebitele; zde mají obě strany stejné právo). Zobrazuje se jen při zapnutém parametru.
4. **Okamžik uzavření smlouvy a potvrzení o smlouvě (čl. 3.3–3.4).** Volíme model „rezervace = nabídka, přijetí = e-mail Potvrzení rezervace po připsání poplatku“. Alternativa: smlouva vzniká odesláním rezervace s odkládací podmínkou zaplacení. Ověřit soulad s § 1731–1745 OZ a to, že první automatické potvrzení (§ 1827 odst. 1) není akceptací. E-mail Potvrzení rezervace označujeme zároveň za potvrzení o uzavřené smlouvě podle § 1824a odst. 1 OZ a za textovou podobu podmínek podle § 1827 odst. 2 OZ (posíláme je jako přílohu HTML/PDF, ne jen odkaz) – ověřit, že obsahuje všechny údaje podle § 1820 odst. 1 OZ, nebo že byly v textové podobě poskytnuty již před uzavřením smlouvy.
5. **Tlačítko „Objednávka zavazující k platbě“ (čl. 3.2).** Používáme přesně zákonnou formulaci § 1826a odst. 2 OZ. Pokud by půjčovna chtěla přívětivější text („Rezervovat a zaplatit“), ověřit, že jde o „jinou odpovídající jednoznačnou formulaci“.
6. **§ 1753 OZ – překvapivá ujednání.** Storno, smluvní pokutu a paušály soustřeďujeme do tabulky v čl. 4.7 a vyžadujeme samostatné zaškrtnutí. Ověřit, že to stačí k „výslovnému přijetí“, nebo zda má checkbox zahrnovat citaci tabulky.
7. **§ 1837 písm. j) OZ (čl. 7).** Vycházíme z toho, že nájem kola na termín spadá pod „nájem dopravního prostředku“ i „využití volného času“ plněné „v určitém období“. Ověřit, včetně toho, zda se výluka vztahuje i na rezervaci bez pevného času převzetí (např. „kdykoli v otevírací době daného dne“).
8. **Právo odstoupit při podstatném porušení z naší strany (čl. 7.3)** – ponecháno obecně; zvážit, zda vyjmenovat (např. nedodání kola v termínu).

**Kauce**

9. **Preautorizace karty (čl. 5.2 b).** Právní povaha blokace jako jistoty (§ 2010 OZ), informační povinnost o blokaci prostředků, odpovědnost za dobu uvolnění (závisí na vydavateli karty). Ověřit, že částečné stržení z preautorizace na škodu (capture) nevyžaduje nový souhlas zákazníka nad rámec těchto podmínek a protokolu, a jak postupovat, když blokace vyprší před vrácením (nájem delší než {{PREAUTH_MAX_DNU}} dní – návrh to řeší zákazem preautorizace u delších nájmů).
10. **Započtení kauce na škodu (čl. 5.3).** Jednostranné započtení podle § 1982 OZ s předložením výpočtu. Ověřit, zda u sporné částky nemáme kauci vracet celou a škodu vymáhat samostatně (návrh: spornou část nevymáháme do vyřízení námitek, ale kauci v této části držíme).
11. **Výše kaucí (čl. 5.1).** Výchozí 3 000 / 10 000 Kč – rozhodnutí půjčovny; u preautorizace pozor na karetní limity zákazníků. Není právní limit, ale nepřiměřeně vysoká kauce vůči hodnotě kola by mohla být napadena.

**Odpovědnost a sankce**

12. **Odpovědnost nájemce za škodu bez zavinění (čl. 10.1).** Opíráme se o § 2225 odst. 1, § 2325 odst. 1 a § 2913 OZ (porušení smluvní povinnosti vrátit věc v převzatém stavu). Ověřit formulaci „i při pádu bez cizího zavinění“ a liberační důvody (§ 2913 odst. 2 OZ – mimořádná nepředvídatelná překážka). Zvážit, zda výslovně vyloučit odpovědnost zákazníka za škodu způsobenou skrytou vadou kola (návrh to dělá).
13. **Výpočet náhrady (čl. 10.2–10.3).** „Obvyklá cena kola v době převzetí uvedená v protokolu“ – ověřit soulad s § 2969 odst. 1 OZ (obvyklá cena v době poškození + účelně vynaložené náklady), a zda předem uvedená částka v protokolu není nepřípustným paušálem; návrh ji označuje jako dohodnutou obvyklou cenu, maximálně do skutečné škody.
14. **Smluvní pokuta za vrácení po otevírací době (čl. 11.4)** – jediná smluvní pokuta v dokumentu, {{POPLATEK_POZDNI_PAUSAL}} (výchozí 300 Kč) za rezervaci. Posoudit přiměřenost (§ 1813, § 2051 OZ) a to, že ji sjednáváme s vyloučením náhrady škody (§ 2050 OZ). Nájemné za prodlení (čl. 11.3) je záměrně nájemné, ne pokuta, aby se § 2050 nepoužil.
15. **Paušály za umytí a nabití (čl. 11.5–11.6).** Pojímáme je jako cenu služby, ne jako sankci. Ověřit, že definice „silně znečištěné“ je dostatečně určitá a že 0 Kč u nabití vypne odstavec.
16. **Dřívější vrácení bez vratky (čl. 11.7, výchozí ne).** Běžná praxe; posoudit vůči § 1813 OZ. Alternativa „vracíme, pokud kolo pronajmeme jinému“ je v návrhu jako volba.
17. **Nevrácení kola a trestní oznámení (čl. 11.8).** Zmínka o § 207 TZ je informační; ověřit, že není nátlaková ve smyslu nekalé obchodní praktiky (§ 4 a násl. ZOS).
18. **Volitelná spoluúčast při krádeži (čl. 10.6)** – rozhodnutí půjčovny; v návrhu vypnuto. Pokud půjčovna kola pojistí, text {{POJISTENI}} a čl. 10 upravit podle pojistných podmínek.
19. **Úrok z prodlení (čl. 10.8)** – odkaz na nařízení vlády č. 351/2013 Sb.; ověřit aktuálnost čísla předpisu.
20. **Výpověď bez výpovědní doby (čl. 6.8)** – odkaz na § 2232 OZ (porušení povinnosti zvlášť závažným způsobem); ověřit výčet příkladů sjednaného důvodu. Původní větu „nájemné za nevyužitou dobu nevracíme“ jsme po oponentuře nahradili vrácením nájemného se započtením náhrady škody – ponechání plnění za neposkytnutou službu při ukončení závazku podnikatelem je vždy zneužívající (§ 1814 odst. 1 písm. e), § 1815 OZ). **Rozhodnutí půjčovny:** chce-li paušální kompenzaci, musí být sjednána jako smluvní pokuta za porušení čl. 9 v přiměřené výši (např. jednodenní nájemné), zapsána do tabulky v čl. 4.7 a výslovně přijata zaškrtnutím (§ 1753 OZ); věta „smluvní pokutu sjednáváme jen v jednom případě“ by se pak musela upravit.
20a. **Vrácení mimo otevírací dobu (čl. 11.1).** Po oponentuře přecházíme na pravidlo „od uložení kola podle pokynů a oznámení SMS/e-mailem neúčtujeme nájemné a zákazník neodpovídá za ztrátu kola z našich prostor; za poškození zjištěné při ranní kontrole odpovídá“. Ověřit vůči § 2225 odst. 1 (odevzdání věci) a § 1813 OZ a praktičnost dokazování stavu kola bez společné kontroly (fotografie při otevření).

**Převzetí a doklady**

21. **Zápis typu a čísla dokladu (čl. 8.3) – § 39 písm. d) zákona č. 269/2021 Sb.** Právní titul oprávněný zájem (čl. 6 odst. 1 písm. f) GDPR) – balanční test je v Zásadách / záznamu o činnostech. **Výslovně posoudit § 39 písm. d)**: zakazuje „zpracovávat údaje uvedené v občanském průkazu … bez souhlasu držitele“, výjimka platí pro „nahlédnutí do občanského průkazu v souvislosti s ověřováním totožnosti, které vyžaduje nebo umožňuje právní předpis“ (znění ověřeno na zakonyprolidi.cz). Opíráme se o výklad, že takovým předpisem je čl. 6 odst. 1 písm. f) GDPR a že opsání typu a čísla je součástí ověření totožnosti; stanovisko ÚOOÚ „Prokazování totožnosti a zpracování osobních údajů“ (květen 2021) opsání nezbytných údajů připouští. Pokud výklad neobstojí, **záložní varianta:** zapisovat z dokladu jen jméno a datum narození bez čísla, nebo nabídnout alternativu (vyšší kauce) tak, aby případný souhlas se zápisem čísla byl svobodný (čl. 7 odst. 4 GDPR). U cestovního pasu doplněn § 2 odst. 2 (zástava) a odst. 3 (kopie) zákona č. 329/1999 Sb. (ověřeno); u řidičského průkazu zákon č. 361/2000 Sb. obdobný zákaz nemá – ověřit, zda ho lze přijímat jako doklad totožnosti.
21a. **Přeprava dětí (čl. 9.2).** Podmínky § 58 odst. 3 zákona o silničním provozu (sedačka: jezdec 15+, dítě do 7 let; vozík: jezdec 18+, nejvýše dvě děti do 10 let) jsme ověřili jen ze sekundárního zdroje (praha11.cz); ověřit aktuální znění včetně technických podmínek vozíku a zda má půjčovna sedačky/vozíky skutečně nabízet.
22. **Odmítnutí dokladu = nevyzvednutí (čl. 8.3 poslední věta).** Tvrdý důsledek – ověřit, zda je přiměřený, nebo zda má zákazník dostat možnost zrušit s vratkou podle tabulky k okamžiku převzetí.
23. **Věk 18+ a jezdci mladší 18 let v skupině (čl. 8.2, 2.3).** Odpovědnost nájemce za ostatní jezdce; zvážit výslovné prohlášení nájemce, že je zákonným zástupcem nebo má jeho souhlas u nezletilých.
24. **Doporučený věk pro elektrokolo (čl. 8.5)** – vychází z doporučení výrobců, ne ze zákona; ověřit a případně vypustit.

**DPH a doklady (ověřit i s daňovým poradcem)**

25. **Daňový doklad k přijaté platbě do 15 dnů (čl. 4.5 A).** Po oponentuře opraveno na § 20a odst. 2 ZDPH (povinnost přiznat daň z úplaty přijaté před uskutečněním plnění; informace GFŘ k § 20a) a § 28 odst. 8 ZDPH („do 15 dnů ode dne, kdy vznikla povinnost přiznat daň, nebo přiznat plnění“ – znění od 1. 1. 2026 ověřeno na podnikatel.cz). Lhůta běží ode dne přijetí úplaty, u karty tedy od autorizace platby, nikoli od připsání na účet půjčovny – ověřit praxi a nastavení systému.
26. **DPH u ponechaného storno poplatku (čl. 4.5 A, 6.2, 6.5) – posoudit i s daňovým poradcem.** U zrušení před nájmem vycházíme z rozsudku SDEU C-277/05 Société thermale (propadlá záloha = paušální odškodnění mimo DPH); opravu základu daně opíráme o § 42 odst. 1 (zrušení plnění – nikoli písm. e), které předpokládá vrácení úplaty) a odst. 2 ZDPH (opravný doklad do 15 dnů od zjištění rozhodných skutečností). U **nevyzvednutí kol** volíme konzervativní variantu – ponechanou částku zdaňujeme a vystavujeme konečný daňový doklad s DPH – s ohledem na rozsudky C-250/14 a C-289/14 Air France-KLM / Hop!-Brit Air (no-show = úplata za službu, kterou byl poskytovatel připraven poskytnout), C-295/17 MEO a C-43/19 Vodafone Portugal. Potvrdit obě kvalifikace, režim částečného storna a to, zda lze no-show přesto posuzovat jako storno (pak by se text čl. 4.5 A zjednodušil).
26a. **Režim DPH u částek nad rámec nájemného (čl. 4.7 A).** Další nájemné za prodlení a paušály za umytí/nabití uvádíme jako cenu služby včetně DPH; smluvní pokutu, náhradu škody a storno poplatek jako částky mimo DPH (§ 1811 odst. 2 písm. c), § 1820 odst. 1 písm. e) OZ – informace o celkové ceně včetně daní). Potvrdit.
27. **Kauce mimo DPH a bez daňového dokladu (čl. 4.6)** – potvrdit; u kauce zaplacené terminálem ověřit evidenci (jde o přijetí a vrácení cizích prostředků, ne o příjem).
28. **EET 2.0** – pokud bude od 2027 zavedena evidence prezenčních plateb, doplnit informaci o účtence.

**Spory, informace, formality**

29. **ČOI – adresa a kontakt (čl. 13.1).** Adresa Gorazdova 1969/24, 120 00 Praha 2 a e-mail podatelny ověřeny na coi.gov.cz/kontakty 5. 10. 2026; zvláštní e-mail oddělení ADR jsme neověřili, proto uvádíme podatelnu a webový formulář. Platforma ODR zrušena k 20. 7. 2025 (nařízení (EU) 2024/3228; MPO doporučuje odkazy odstranit) – zmínku jsme ze zákaznického textu vypustili, na ODR neodkazujeme. Doplněna věta podle § 14 odst. 2 ZOS (opakované poskytnutí informace o ADR na trvalém nosiči, zde e-mailem) – ověřit, že e-mail je „jiný trvalý nosič dat“.
30. **Lhůty k uplatnění práv (čl. 12.3, 12.5).** Po oponentuře nic nezkracujeme: vady se oznamují bez zbytečného odkladu (§ 2214 OZ) s informací o zákonných šesti měsících od převzetí (§ 1921 odst. 1 OZ), peněžité nároky podléhají obecné promlčecí lhůtě (§ 629; zkrácení vůči spotřebiteli vylučuje § 630 odst. 2 OZ), 14 dnů na námitky proti vyúčtování je jen doporučení. Ověřit, zda je u nájmu vhodné § 1921 vůbec zmiňovat (práva z vad nájmu se řídí především § 2205–2208 OZ), nebo zda informaci vypustit.
31. **Doručování e-mailem (čl. 15.4).** Fikci „doručeno dnem odeslání, neprokážete-li opak“ (obrácené důkazní břemeno, § 1813 a § 1814 odst. 1 písm. m) OZ) jsme nahradili pravidlem „doručeno dojitím do schránky (§ 570 odst. 1 OZ); není-li okamžik zřejmý, třetí pracovní den po odeslání“. § 573 OZ se týká zásilek odeslaných provozovatelem poštovních služeb, používáme ho jen **obdobně** jako smluvní domněnku ve prospěch spotřebitele – ověřit formulaci a dopad na lhůty (čl. 10.7 splatnost, čl. 12.4 reklamace, čl. 3.5 zánik rezervace).
32. **Záznam souhlasu (čl. 3.2) a opt-out z obchodních sdělení (čl. 3.1).** Ukládáme verzi, čas a technický otisk připojení (hash IP); informace o tom patří i do Zásad. Políčko „nechci obchodní sdělení“ ve formuláři musí být „jasná a zřetelná možnost odmítnout“ při shromažďování kontaktu (§ 7 odst. 3 zákona č. 480/2004 Sb.) – ověřit podobu (nepředvyplněné, u pole e-mail).
33. **Vztah OP ↔ smlouva o nájmu a protokol (čl. 8.7, 15.6) a slovník placeholderů.** Zkontrolovat, aby tiskový dokument [smlouva-o-najmu-a-predavaci-protokol.md](smlouva-o-najmu-a-predavaci-protokol.md) neobsahoval odchylná ujednání (zejména k čl. 6.8, 11.1 a 12.3 po změnách). Technická poznámka pro tým: OP nyní používají `{{PLATEBNI_BRANA_NAZEV}}` a `{{PROVOZOVATEL_ICO}}` shodně se Zásadami a parametr `{{HODNOTA_KOLA}}` opustily (hodnota kola je údaj protokolu, ne půjčovny); smlouva/protokol zatím používá `{{PLATEBNI_BRANA}}`, `{{PROVOZOVATEL_NAZEV}}` jako „název a IČO“ a odkazuje na parametr HODNOTA_KOLA – sjednotit při příští úpravě smlouvy, ideálně jedním číselníkem parametrů v legal/README.md.
34. **Definice dne nájmu (čl. 2.3, parametr {{DEFINICE_DNE}}).** Výchozí „24 hodin od převzetí, nejpozději do konce otevírací doby; půlden do 4 hodin“ – rozhodnutí půjčovny; ověřit, že se nekříží s ceníkem a s výpočtem dalšího nájemného (čl. 11.3, „započatá hodina / započatý den“).
35. **Rozhodnutí půjčovny před nasazením:** plátce DPH; výše poplatků a kaucí; storno tabulka a režim no-show (bod 2); platba na místě ano/ne; doplatek předem ano/ne; pravidlo pro počasí; dřívější vrácení; spoluúčast při krádeži; pojištění; území užívání; paušály a ceník náhrad; tolerance pozdního vrácení; definice dne nájmu; lhůta výmazu čísla dokladu (shodně se Zásadami a Záznamem o činnostech); otevírací doba a kontakty.
