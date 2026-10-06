<!-- INTERNI: nerenderovat -->

# Smlouva o zpracování osobních údajů (provozovatel musteru ↔ půjčovna) dle čl. 28 GDPR – návrh

> **Návrh připravený jako podklad; před použitím vyžaduje kontrolu advokátem.** Tento rámeček, poznámky „Jak číst návrh“, oddíl „Parametry“ a oddíl „K ověření advokátem“ jsou interní a negenerují se do dokumentu (HTML komentáře INTERNI: nerenderovat … /INTERNI).

Verze šablony {{VERZE}}, účinnost od {{UCINNOST_OD}}. Dokument generuje muster při onboardingu každé půjčovny dosazením parametrů z jejího nastavení (`tenant.json`, `platform.db`). Souvisí s [obchodními podmínkami půjčovny](obchodni-podminky.md) (čl. 1.3 a 14), se [Zásadami ochrany osobních údajů](zasady-ochrany-osobnich-udaju.md) a se [záznamy o činnostech zpracování](zaznam-o-cinnostech-zpracovani.md). Podklady: [rešerše 03 – GDPR, ÚOOÚ, bezpečnost](../docs/vyzkum/03-bezpecnost-gdpr-podminky.md), [rešerše 02 – platby, brány, Fio](../docs/vyzkum/02-platby-cr.md), [rešerše 07 – subdomény a TLS](../docs/vyzkum/07-domeny-a-tls.md), [PLAN.md kap. 5–8, 11–12](../PLAN.md).

**Jak číst návrh**

- `{{NAZEV}}` je proměnná, kterou doplní systém z nastavení půjčovny nebo provozovatele. Všechny proměnné jsou v tabulce *Parametry* níže. Hodnoty, které půjčovna nastavuje v adminu (`DOBA_*`, `KAUCE_*`, `POPLATEK_*`, `STORNO_TABULKA`), jsou tytéž klíče `tenant.json`, ze kterých se generují i Zásady a záznam o činnostech – jediný zdroj hodnoty, takže smlouva nemůže správci slíbit jinou lhůtu, než jakou zákazníkům uvádějí Zásady (čl. 5 odst. 1 písm. e) a čl. 13 odst. 2 písm. a) GDPR).
- **Podmíněný fragment** `{{#X}}…{{/X}}` se vykreslí jen tehdy, je-li parametr `X` vyplněn nebo pravdivý (např. `{{#PLATCE_DPH}}…{{/PLATCE_DPH}}` – pasáž jen pro plátce DPH; `{{#PUJCOVNA_DIC}}, DIČ {{PUJCOVNA_DIC}}{{/PUJCOVNA_DIC}}` – údaj o DIČ jen u půjčovny, která ho uvádí, takže u ostatních nevznikne prázdné „DIČ , se sídlem“). `{{^X}}…{{/X}}` se vykreslí naopak jen tehdy, není-li `X` vyplněn. Stejná konvence platí pro `{{PUJCOVNA_DPO}}`, `{{MONITORING_SLUZBA}}` a podmíněné řádky Přílohy 3.
- **Sladění s ostatními dokumenty (úkol mimo tento soubor):** smlouva používá klíče `{{DOBA_*}}` shodné se Zásadami a Záznamem a výchozí hodnotu 90 dní u nedokončené rezervace. V ostatních dokumentech je třeba doplnit nové klíče `{{DOBA_DOKLADY}}`, `{{DOBA_NESPAROVANE_POHYBY}}`, `{{DOBA_FRONTY}}`, `{{FREKVENCE_TESTU_OBNOVY}}` a `{{PLATCE_DPH}}`, sjednotit výchozí kauci (3 000 Kč podle OP; Zásady a Záznam uvádějí 5 000 Kč), frekvenci testu obnovy (měsíčně; Záznam a PLAN.md kap. 7 uvádějí čtvrtletně), terminologii „přijetí OP“ místo „souhlas s OP“ (PLAN.md kap. 5, sloupec `consent_at` → `terms_accepted_at`) a anonymizaci IP v access logu Caddy (PLAN.md kap. 12). Doporučujeme jeden soubor výchozích hodnot (`legal/defaults.json`), ze kterého se tabulky Parametry všech dokumentů generují.
- Strany označujeme přesně podle GDPR: **správce** = půjčovna, **zpracovatel** = provozovatel musteru. Je to záměr – advokát i ÚOOÚ okamžitě vidí, kdo nese kterou roli. V textu pro půjčovny vysvětlujeme, proč to tak je.
- Odkazy na předpisy: **GDPR** = nařízení (EU) 2016/679; **ZZOÚ** = zákon č. 110/2019 Sb., o zpracování osobních údajů; **OZ** = zákon č. 89/2012 Sb., občanský zákoník; **ZOS** = zákon č. 634/1992 Sb., o ochraně spotřebitele; **ZDPH** = zákon č. 235/2004 Sb., o dani z přidané hodnoty; **ZDP** = zákon č. 586/1992 Sb., o daních z příjmů; **DŘ** = zákon č. 280/2009 Sb., daňový řád; **zákon o občanských průkazech** = zákon č. 269/2021 Sb.; **zákon o cestovních dokladech** = zákon č. 329/1999 Sb.; **ZEK** = zákon č. 127/2005 Sb., o elektronických komunikacích; **zákon o účetnictví** = zákon č. 563/1991 Sb.; **ZSDEP** = zákon č. 297/2016 Sb., o službách vytvářejících důvěru pro elektronické transakce; **zákon o některých službách informační společnosti** = zákon č. 480/2004 Sb. Znění ověřeno 5. 10. 2026 v e-Sbírce (e-sbirka.gov.cz – závazné znění podle zákona č. 222/2016 Sb.) a na zakonyprolidi.cz; druhá oponentura (právo ČR) ověřila všechny citované paragrafy včetně § 89 odst. 3 ZEK, § 31 zákona o účetnictví a § 1752 OZ – žádný neexistující ani obsahově chybný odkaz nebyl nalezen.
- Co je „muster“: jedna aplikace, kterou zpracovatel provozuje pro více nezávislých půjčoven na jednom serveru. Každá půjčovna má **vlastní databázi (soubor), vlastní šifrovací klíče a tajemství a vlastní subdoménu** `{{WEB_SUBDOMENA}}`. Tím se smlouva liší od běžných vzorů: například audit nesmí zasáhnout do dat jiných půjčoven a výmaz po skončení je smazání jedné instance.
- Vzor Hetzner DPA (v1.1, 10. 2. 2025), který zpracovatel uzavírá s hostingem, jsme prošli, aby řetězec povinností správce → zpracovatel → Hetzner navazoval (čl. 28 odst. 4 GDPR).

---

## Parametry

| Parametr | Význam | Výchozí hodnota / návrh |
|---|---|---|
| **Správce (půjčovna)** | | |
| `{{PUJCOVNA_NAZEV}}` | Obchodní firma nebo jméno a příjmení podnikatele, který kola pronajímá | *(příklad)* Hotel U Tří dubů s.r.o. |
| `{{PUJCOVNA_ICO}}` | IČO půjčovny | *(příklad)* 12345678 |
| `{{PUJCOVNA_DIC}}` | DIČ půjčovny; v záhlaví vloženo jako podmíněný fragment `{{#PUJCOVNA_DIC}}, DIČ {{PUJCOVNA_DIC}}{{/PUJCOVNA_DIC}}`, takže u půjčovny bez DIČ nevznikne prázdný text | – |
| `{{PLATCE_DPH}}` | Příznak, zda je půjčovna plátcem DPH (ano/ne). Řídí podmíněné pasáže o daňových dokladech (čl. 11.1 c), 13.2, 13.5, Příloha 1 D). Samotné DIČ příznakem být nemůže – DIČ má i neplátce registrovaný k dani z příjmů. Zda budou půjčovny typicky plátci, je otevřená otázka PLAN.md kap. 15 bod 1 | ne *(nastaví půjčovna při onboardingu)* |
| `{{PUJCOVNA_SIDLO}}` | Adresa sídla (u fyzické osoby místo podnikání) | – |
| `{{PUJCOVNA_REJSTRIK}}` | Údaj o zápisu v obchodním nebo živnostenském rejstříku | „zapsaná v obchodním rejstříku vedeném Krajským soudem v …, oddíl C, vložka …“ |
| `{{PUJCOVNA_ZASTUPCE}}` | Jméno a funkce osoby, která smlouvu za půjčovnu uzavírá (jednatel, podnikatel, zmocněnec) | – |
| `{{PUJCOVNA_EMAIL}}` | E-mail půjčovny pro smluvní komunikaci a pokyny | – |
| `{{PUJCOVNA_TELEFON}}` | Telefon půjčovny | – |
| `{{PUJCOVNA_INCIDENT_KONTAKT}}` | E-mail **a** telefon, na které zpracovatel hlásí bezpečnostní incidenty (i mimo pracovní dobu) | shodné s `{{PUJCOVNA_EMAIL}}` a `{{PUJCOVNA_TELEFON}}` |
| `{{PUJCOVNA_DPO}}` | Pověřenec pro ochranu osobních údajů půjčovny, byl-li jmenován (čl. 37 GDPR); v Příloze 4 jako podmíněný fragment, není-li vyplněn, zobrazí se „nejmenován“ | nejmenován (pro běžnou půjčovnu není povinný) |
| **Zpracovatel (provozovatel musteru)** | | |
| `{{PROVOZOVATEL_NAZEV}}` | Obchodní firma provozovatele musteru | – |
| `{{PROVOZOVATEL_ICO}}` | IČO provozovatele | – |
| `{{PROVOZOVATEL_SIDLO}}` | Sídlo provozovatele | – |
| `{{PROVOZOVATEL_REJSTRIK}}` | Údaj o zápisu provozovatele | – |
| `{{PROVOZOVATEL_ZASTUPCE}}` | Osoba, která smlouvu za provozovatele uzavírá | – |
| `{{PROVOZOVATEL_EMAIL}}` | E-mail provozovatele pro smluvní komunikaci, pokyny a žádosti subjektů údajů | – |
| `{{PROVOZOVATEL_INCIDENT_KONTAKT}}` | E-mail a telefon provozovatele pro hlášení incidentů ze strany půjčovny | – |
| `{{PROVOZOVATEL_DPO}}` | Pověřenec provozovatele, byl-li jmenován | nejmenován |
| **Služba a partneři** | | |
| `{{DOMENA_MUSTERU}}` | Hlavní doména musteru, pod kterou běží subdomény půjčoven | pujcovna.cz *(dle zadání; rešerše 07: doména je obsazená, doporučeno rezervacekol.cz – konečný výběr je na zadavateli)* |
| `{{WEB_SUBDOMENA}}` | Doména webu půjčovny ve tvaru `<nazev-stavajiciho-webu>.{{DOMENA_MUSTERU}}` | *(příklad)* utridubu.pujcovna.cz |
| `{{HLAVNI_SMLOUVA}}` | Označení hlavní smlouvy o poskytování služby musteru (název, datum), ke které se tato smlouva váže | „Smlouva o poskytování webu a rezervačního systému ze dne …“ |
| `{{PLATEBNI_BRANA}}` | Platební brána, se kterou má půjčovna vlastní smlouvu (karty, preautorizace kauce) | Comgate *(podle rešerše 06)* |
| `{{BANKA}}` | Banka půjčovny, jejíž API muster čte pro párování převodů | Fio banka, a.s. |
| `{{HETZNER_LOKALITA}}` | Datová centra Hetzner, ve kterých běží server a úložiště záloh | Falkenstein a Norimberk (Německo), záloha Storage Box/Object Storage tamtéž; vše EU |
| `{{EMAIL_SLUZBA_NAZEV}}` | Poskytovatel transakčních e-mailů (potvrzení rezervace, doklady, připomínky) – **placeholder, rozhodnutí viz PLAN.md kap. 15 bod 4** | – *(kandidáti s EU hostingem: Mailgun EU, Brevo)* |
| `{{EMAIL_SLUZBA_SIDLO}}` | Sídlo poskytovatele e-mailů | – |
| `{{EMAIL_SLUZBA_LOKALITA}}` | Umístění zpracování u poskytovatele e-mailů (musí být EU/EHP, jinak čl. 10.3) | EU |
| `{{EMAIL_SLUZBA_ZALOZNI}}` | Záložní poskytovatel transakčních e-mailů (název, sídlo, umístění zpracování v EU/EHP), na kterého smí zpracovatel v naléhavém případě přepnout bez předchozího oznámení (čl. 9.4); je předem uveden v Příloze 3 A, kryje ho obecné povolení a smlouva podle čl. 28 odst. 4 GDPR je s ním uzavřena předem | – *(druhý z kandidátů PLAN.md kap. 15 bod 4)* |
| `{{MONITORING_SLUZBA}}` | Externí monitoring dostupnosti, pokud se používá; řádek v Příloze 3 A je podmíněný fragment `{{#MONITORING_SLUZBA}}…{{/MONITORING_SLUZBA}}` | žádný externí (Uptime Kuma na vlastním serveru) |
| `{{DNS_POSKYTOVATEL}}` | Poskytovatel DNS pro `{{DOMENA_MUSTERU}}` (nedostává osobní údaje zákazníků, uveden pro úplnost) | Cloudflare v režimu DNS-only nebo Hetzner DNS *(rešerše 07)* |
| **Nastavení správce, která určují zpracování (pokyny)** | | |
| `{{POPLATEK_KOLO}}` | Rezervační poplatek za jedno kolo (fixní částka; úplata za zajištění služby – blokaci kola na termín, při řádném využití se započítává na nájemné) | 300 Kč |
| `{{POPLATEK_EKOLO}}` | Rezervační poplatek za jedno elektrokolo | 500 Kč |
| `{{KAUCE_KOLO}}` | Kauce za jedno kolo (hotově/terminál na místě nebo preautorizace karty při převzetí) | 3 000 Kč |
| `{{KAUCE_EKOLO}}` | Kauce za jedno elektrokolo | 10 000 Kč |
| `{{STORNO_TABULKA}}` | Storno pravidlo generované ze storno lhůty půjčovny (`STORNO_LHUTA_HODIN`, výchozí 48 h; rozhodnutí zadavatele 5. 10. 2026) – v textu jako věta | zrušení nejméně 48 hodin před začátkem nájmu → celý poplatek zpět · později nebo nevyzvednutí → poplatek propadá |
| `{{DOBA_NEDOKONCENE_REZERVACE}}` | Po jaké době se maže rezervace, u které nedošlo k zaplacení poplatku ani k uzavření smlouvy (klíč shodný se Zásadami a Záznamem) | 90 dní od vytvoření (rozsah 30–90) |
| `{{DOBA_CISLO_DOKLADU}}` | Po jaké době od vrácení kola a vypořádání kauce se maže typ a číslo dokladu totožnosti (klíč shodný se Zásadami, OP a nájemní smlouvou) | 30 dní (déle jen u nevyřešené škody, krádeže nebo nezaplacení – do vypořádání) |
| `{{DOBA_SMLOUVA}}` | Jak dlouho se uchovává rezervace, smlouva o nájmu, protokoly, záznam o škodě a záznam o přijetí OP, než se osobní údaje anonymizují (klíč shodný se Zásadami a Záznamem) | 3 roky od skončení nájmu **nebo od vypořádání poslední pohledávky z nájmu** (škoda, nedoplatek, kauce), podle toho, co nastane později (§ 619, § 629 odst. 1 OZ); nastavitelný rozsah 3–4 roky (rezerva na doručení žaloby). Delší uchování jen jednotlivě u rezervace s příznakem „spor“ (otevřená škoda, krádež, soudní nebo reklamační spor) – do pravomocného skončení, nejdéle 10 let (§ 629 odst. 2, § 636 odst. 1 OZ); job „retence“ takovou rezervaci neanonymizuje |
| `{{DOBA_DOKLADY}}` | Jak dlouho se uchovávají daňové a účetní doklady (klíč pro Zásady a Záznam, které dnes uvádějí 10 let napevno) | **Plátce DPH:** 10 let od konce zdaňovacího období, ve kterém se plnění uskutečnilo (§ 35 odst. 2 ZDPH). **Neplátce – účetní jednotka:** 5 let od konce účetního období (§ 31 odst. 2 písm. b) zákona o účetnictví). **Neplátce – OSVČ s daňovou evidencí:** po dobu, po kterou neuplynula lhůta pro stanovení daně (§ 7b odst. 5 ZDP, § 148 DŘ – zpravidla 3 roky, nejdéle 10 let). Výchozí návrh pro neplátce 5 let |
| `{{DOBA_LOGY}}` | Doba uchování provozních, bezpečnostních a audit logů (obsahují nejvýše pseudonymizované identifikátory – otisky; klíč shodný se Zásadami a Záznamem) | 12 měsíců (rozsah 6–12) |
| `{{DOBA_NESPAROVANE_POHYBY}}` | Jak dlouho se uchovávají bankovní pohyby, které se nepodařilo spárovat s žádnou rezervací (jméno plátce, číslo protiúčtu, zpráva pro příjemce, surový záznam – často údaje třetích osob); spárované pohyby sdílejí lhůtu rezervace | 12 měsíců od zaúčtování, pak výmaz polí plátce (částka a datum zůstávají) |
| `{{DOBA_FRONTY}}` | Jak dlouho zůstává obsah ve frontě odeslaných e-mailů (`outbox`) a v uložených notifikacích platební brány (`webhook_events`) po odeslání / zpracování | 90 dní, pak výmaz obsahu (zůstává jen stav doručení / zpracování) |
| **Lhůty a částky této smlouvy** | | |
| `{{LHUTA_OHLASENI_INCIDENTU}}` | Do kdy od zjištění zpracovatel ohlásí správci porušení zabezpečení | 24 hodin |
| `{{LHUTA_PREDANI_ZADOSTI}}` | Do kdy zpracovatel předá správci žádost subjektu údajů, která přišla k němu | 3 pracovní dny |
| `{{LHUTA_SOUCINNOSTI}}` | Do kdy zpracovatel poskytne součinnost nad rámec funkcí adminu (práva subjektů, DPIA, informace) | 10 pracovních dnů |
| `{{LHUTA_OZNAMENI_PODZPRACOVATELE}}` | Jak dlouho předem zpracovatel oznámí nového nebo nahrazeného dalšího zpracovatele | 30 dnů |
| `{{LHUTA_NAMITKY}}` | Do kdy od oznámení může správce vznést námitku proti dalšímu zpracovateli | 14 dnů |
| `{{LHUTA_OZNAMENI_ZMENY_SMLOUVY}}` | Jak dlouho předem zpracovatel oznámí novou verzi textu této smlouvy | 30 dnů |
| `{{LHUTA_EXPORTU}}` | Jak dlouho po skončení hlavní smlouvy je instance dostupná jen pro export dat | 30 dnů |
| `{{LHUTA_VYMAZU}}` | Do kdy po uplynutí exportní lhůty (nebo po pokynu správce) zpracovatel instanci smaže | 14 dnů |
| `{{DOBA_ZALOHY}}` | Nejdelší doba, po kterou smazaný údaj **běžící** instance přetrvá v šifrovaných zálohách, než vyrotuje (klíč shodný se Záznamem a Zásadami) | 12 měsíců (denní 7 dní, týdenní 4 týdny, měsíční 12 měsíců) |
| `{{LHUTA_VYMAZU_ZALOH}}` | Do kdy po výmazu **zaniklé** instance zmizí její data ze záloh zpracovatele, nelze-li některou zálohovou sadu smazat výběrově spolu s instancí (čl. 13.1 d)) | 30 dnů – *viz K ověření, bod 9* |
| `{{FREKVENCE_TESTU_OBNOVY}}` | Jak často zpracovatel testuje obnovu ze zálohy se záznamem (čl. 8.5, Příloha 2 bod 18); tentýž klíč má používat Záznam | měsíčně |
| `{{VYPOVEDNI_DOBA_ZMENA}}` | Výpovědní doba hlavní smlouvy, odmítne-li správce novou verzi této smlouvy (čl. 18.2 c)); musí dát čas obstarat obdobné plnění od jiného dodavatele (§ 1752 odst. 1 OZ) | 3 měsíce |
| `{{LHUTA_OZNAMENI_AUDITU}}` | Jak dlouho předem správce oznámí audit | 14 dnů |
| `{{SAZBA_SOUCINNOSTI}}` | Hodinová sazba za součinnost nad rámec hlavní smlouvy (nikdy za nápravu vlastního porušení zpracovatele) | – Kč/hod. bez DPH |
| `{{LIMIT_ODPOVEDNOSTI}}` | Horní hranice náhrady škody zpracovatele vůči správci z této smlouvy (neplatí pro úmysl, hrubou nedbalost a v rozsahu, v jakém ho zákon vůči slabší straně nepřipouští – § 2898 OZ) | částka rovná odměně zaplacené za posledních 12 měsíců, nejméně … Kč – *rozhodnutí zadavatele, viz K ověření, bod 3* |
| `{{VERZE}}` | Verze této smlouvy (každá změna textu = nová verze) | 1.0 |
| `{{UCINNOST_OD}}` | Datum účinnosti této verze šablony | – |
| `{{DATUM_UZAVRENI}}` | Datum uzavření smlouvy konkrétní půjčovnou (doplní systém při onboardingu) | – |

<!-- /INTERNI -->

# Smlouva o zpracování osobních údajů

uzavřená podle čl. 28 nařízení Evropského parlamentu a Rady (EU) 2016/679 (GDPR) a § 1746 odst. 2 OZ mezi

**Správce:** **{{PUJCOVNA_NAZEV}}**, IČO {{PUJCOVNA_ICO}}{{#PUJCOVNA_DIC}}, DIČ {{PUJCOVNA_DIC}}{{/PUJCOVNA_DIC}}, se sídlem {{PUJCOVNA_SIDLO}}, {{PUJCOVNA_REJSTRIK}}, zastoupená {{PUJCOVNA_ZASTUPCE}}, e-mail {{PUJCOVNA_EMAIL}}, telefon {{PUJCOVNA_TELEFON}} (dále „**správce**“ nebo „**půjčovna**“)

a

**Zpracovatel:** **{{PROVOZOVATEL_NAZEV}}**, IČO {{PROVOZOVATEL_ICO}}, se sídlem {{PROVOZOVATEL_SIDLO}}, {{PROVOZOVATEL_REJSTRIK}}, zastoupený {{PROVOZOVATEL_ZASTUPCE}}, e-mail {{PROVOZOVATEL_EMAIL}} (dále „**zpracovatel**“ nebo „**provozovatel**“)

(společně „strany“).

## 1. Proč smlouvu uzavíráme a na co se vztahuje

1.1 Zpracovatel pro správce provozuje web a rezervační systém půjčovny kol na adrese **{{WEB_SUBDOMENA}}** – hosting, provoz aplikace, zálohování, aktualizace a technickou podporu – na základě **{{HLAVNI_SMLOUVA}}** (dále „hlavní smlouva“). Bez nakládání s osobními údaji zákazníků a obsluhy půjčovny to nejde: údaje jsou uložené na serveru zpracovatele, zpracovatel je zálohuje a při podpoře k nim může mít přístup.

1.2 **Role.** Správcem osobních údajů zákazníků je půjčovna: ona rozhoduje, proč a jaké údaje se od zákazníků sbírají, jak dlouho se uchovávají a komu se předávají (čl. 4 bod 7 GDPR). Provozovatel je zpracovatelem (čl. 4 bod 8 GDPR): údaje zpracovává výhradně pro půjčovnu a podle jejích pokynů. Úřad pro ochranu osobních údajů (ÚOOÚ) ve svém vyjádření k cloudovým službám řadí poskytovatele hostingu a cloudu mezi zpracovatele a požaduje písemnou smlouvu s náležitostmi čl. 28 GDPR. Tato smlouva tyto náležitosti splňuje.

1.3 **Co smlouva obsahuje.** Upravuje předmět, dobu, povahu a účel zpracování, typ údajů a kategorie subjektů údajů (čl. 3–5 a Příloha 1) a povinnosti podle čl. 28 odst. 3 písm. a) až h) GDPR: pokyny (čl. 6), mlčenlivost (čl. 7), zabezpečení (čl. 8 a Příloha 2), další zpracovatele (čl. 9 a Příloha 3), součinnost při právech subjektů údajů (čl. 11), součinnost při zabezpečení a incidentech (čl. 12), výmaz a vrácení údajů (čl. 13), doložení souladu a audity (čl. 14).

1.4 **Vztah k hlavní smlouvě.** Tato smlouva je nedílnou součástí hlavní smlouvy. V otázkách ochrany osobních údajů má před hlavní smlouvou přednost. Trvá po dobu hlavní smlouvy a zaniká s ní (čl. 17).

1.5 **Co smlouva neupravuje.** Provozovatel je zároveň *samostatným správcem* údajů kontaktních osob půjčovny (jméno, e-mail, telefon jednatele či obsluhy) pro účely plnění hlavní smlouvy, fakturace a podpory. Na toto zpracování se smlouva nevztahuje; informace podle čl. 13 GDPR k němu poskytuje provozovatel v hlavní smlouvě.

1.6 Správce prohlašuje, že smlouvu uzavírá v rámci své podnikatelské nebo jiné hospodářské činnosti a není spotřebitelem (§ 419 OZ); ZOS se na vztah stran nepoužije. Není-li správce podnikatelem (spolek, obec, příspěvková organizace), uzavírá smlouvu podpisem dokumentu a potvrzuje, že se seznámil s celým textem včetně příloh a měl možnost navrhnout jeho změny (§ 1799 a 1800 OZ; čl. 18.1 poslední věta). ZOS a obchodní podmínky půjčovny platí pro vztah půjčovny se zákazníky.

## 2. Pojmy

2.1 **Osobní údaje**, **zpracování**, **subjekt údajů**, **porušení zabezpečení osobních údajů** mají význam podle čl. 4 GDPR (body 1, 2 a 12; subjekt údajů je vymezen v bodě 1).

2.2 **Instance** – samostatná databáze (soubor), úložiště souborů (fotky, vystavené dokumenty), šifrovací klíče a tajemství (přístupy k bráně, bankovní token) a subdoména {{WEB_SUBDOMENA}}, které zpracovatel v rámci musteru vyhradil správci. Data jiných půjčoven jsou v jiných instancích.

2.3 **Admin** – rozhraní `/admin`, ve kterém obsluha správce spravuje rezervace, kola, ceník, texty a nastavení; nastavení v adminu jsou pokyny správce (čl. 6).

2.4 **Platforma** – rozhraní `/platform`, kterým zpracovatel spravuje všechny instance (založení, doména, téma, zálohy, zdraví). Neumožňuje běžné prohlížení osobních údajů zákazníků (čl. 6.6).

2.5 **Další zpracovatel** (podzpracovatel) – subjekt, kterého zpracovatel zapojí do zpracování pro správce (čl. 28 odst. 2 a 4 GDPR). Seznam je v Příloze 3.

2.6 **Pracovní den** – den kromě soboty, neděle a státního svátku v České republice.

## 3. Předmět, povaha a účel zpracování

3.1 **Předmět.** Hosting a provoz webu a rezervačního systému půjčovny (prezentace, katalog kol, rezervace, platby, výdej a vrácení, doklady, e-maily, admin), zálohování a obnova dat, instalace aktualizací, technická podpora a odstraňování chyb, automatické mazání a anonymizace podle retenčních lhůt, export dat.

3.2 **Povaha (operace).** Ukládání a uchovávání; šifrování citlivých polí; zobrazení oprávněné obsluze správce; třídění a vyhledávání (např. podle otisku e-mailu); generování dokumentů (potvrzení, doklady o platbě, předávací protokoly) z dat správce; odesílání transakčních e-mailů zákazníkům jménem správce; založení platby u platební brány správce a čtení jejího stavu; čtení pohybů na účtu správce a jejich párování s rezervacemi; zálohování a obnova; výmaz a anonymizace; export; nahlížení pracovníkem zpracovatele při podpoře nebo incidentu v nezbytném rozsahu (čl. 6.6).

3.3 **Účel.** Umožnit správci přijímat a spravovat rezervace, uzavírat a plnit smlouvy o nájmu kol, přijímat platby a vracet je, plnit účetní a daňové povinnosti, chránit svůj majetek a komunikovat se zákazníky. Zpracovatel nesmí osobní údaje použít k žádnému vlastnímu účelu – ani ke statistice, vývoji, trénování modelů nebo oslovování zákazníků. Pokud by sám určil účel nebo prostředky zpracování, považuje se v tomto rozsahu za správce a nese za to odpovědnost (čl. 28 odst. 10 GDPR).

3.4 Systém neprovádí automatizované rozhodování s právními účinky pro zákazníky ani profilování (čl. 22 GDPR). Výpočty ceny, dostupnosti a storna jsou provedením pravidel, která stanovil správce.

3.5 Podrobný popis včetně vazby na platební bránu a banku je v Příloze 1.

## 4. Kategorie subjektů údajů a typ osobních údajů

4.1 Subjekty údajů jsou **zákazníci správce** (osoby, které rezervují a přebírají kola; o dalších jezdcích uvedených v rezervaci systém neukládá žádné identifikační údaje, jen počet – Příloha 1, tabulka B), **obsluha správce** (uživatelé adminu) a **plátci**, jejichž údaje jsou v bankovních pohybech nebo u brány (zpravidla totožní se zákazníky).

4.2 Typy údajů jsou vyjmenovány v Příloze 1, tabulka B. Jde zejména o identifikační a kontaktní údaje, údaje o rezervaci a nájmu, platební údaje bez údajů o kartě, typ a číslo dokladu totožnosti, záznamy o přijetí obchodních podmínek a o volbě u obchodních sdělení, technické údaje (otisk IP adresy, logy) a přihlašovací údaje obsluhy.

4.3 **Co se nezpracovává a správce to do systému nevkládá:** zvláštní kategorie údajů (čl. 9 GDPR); kopie, skeny ani fotografie dokladů totožnosti – pořizovat kopii občanského průkazu bez souhlasu držitele zakazuje § 39 odst. 1 písm. c) zákona o občanských průkazech (přestupek podle § 65 odst. 1 písm. d)), kopii cestovního dokladu § 2 odst. 3 zákona o cestovních dokladech (přestupek podle § 34a odst. 1 písm. i)); u dokladů vydaných jiným státem platí zásada minimalizace (čl. 5 odst. 1 písm. c) GDPR) – zapisuje se opět jen typ a číslo; podle stanoviska ÚOOÚ z května 2021 k prokazování totožnosti postačí zapsání nezbytných údajů; údaje o platební kartě (číslo karty, CVC, údaje 3-D Secure) – ty zpracovává výhradně platební brána; hesla v čitelné podobě. Systém pro takové údaje nenabízí žádnou funkci. Vloží-li je správce přesto do volných textových polí (poznámky), odpovídá za to správce a na výzvu zpracovatele je odstraní.

## 5. Doba zpracování

5.1 Zpracovatel zpracovává osobní údaje po dobu trvání hlavní smlouvy.

5.2 Po jejím skončení provádí už jen operace podle čl. 13 (zpřístupnění exportu, výmaz) a uchovává jen to, co čl. 13.3 výslovně připouští.

5.3 Doby uchování jednotlivých údajů během trvání smlouvy určuje správce nastavením retence v adminu (výchozí hodnoty v Příloze 1, tabulka D). Zpracovatel je provádí automaticky (job „retence“) a správce o tom nemusí dávat jednotlivé pokyny.

## 6. Pokyny správce

6.1 Zpracovatel zpracovává osobní údaje **pouze na základě doložených pokynů správce** (čl. 28 odst. 3 písm. a) a čl. 29 GDPR). Doloženými pokyny jsou:
- (a) tato smlouva včetně příloh;
- (b) **nastavení správce v adminu** – zejména rezervační poplatek ({{POPLATEK_KOLO}} za kolo, {{POPLATEK_EKOLO}} za elektrokolo), kauce ({{KAUCE_KOLO}} / {{KAUCE_EKOLO}}) a její formy, storno tabulka ({{STORNO_TABULKA}}), retenční lhůty, zvolená platební brána a bankovní účet, texty e-mailů, obchodních podmínek a Zásad, uživatelské účty obsluhy. Každou změnu nastavení systém zapisuje do audit logu s časem a uživatelem, takže je doložitelná;
- (c) **další písemné pokyny** zaslané z adresy {{PUJCOVNA_EMAIL}} na {{PROVOZOVATEL_EMAIL}}; zpracovatel potvrdí přijetí. Ústní nebo telefonický pokyn správce bez zbytečného odkladu potvrdí e-mailem; do té doby ho zpracovatel nemusí provést.

6.2 Pokyn, který by vyžadoval změnu softwaru nebo jde nad rámec hlavní smlouvy (např. nová funkce, ruční zásah do databáze), je požadavkem na změnu služby. Zpracovatel sdělí, zda a za jakých podmínek ho provede.

6.3 **Upozornění na protiprávní pokyn.** Má-li zpracovatel za to, že pokyn porušuje GDPR nebo jiný předpis o ochraně osobních údajů, neprodleně na to správce upozorní (čl. 28 odst. 3 poslední pododstavec GDPR) a může provedení pozastavit, dokud správce pokyn nepotvrdí nebo neupraví. Příklad: pokyn ukládat fotografie dokladů totožnosti nebo posílat zákazníkům bez souhlasu nabídky třetích osob.

6.4 Pokud zpracovateli ukládá zpracování právo Evropské unie nebo České republiky (například příkaz soudu nebo orgánu veřejné moci k vydání dat), informuje o tom správce před provedením, ledaže to právo zakazuje z důležitého veřejného zájmu. Zpracovatel vydá jen údaje, které požadavek výslovně kryje, a požadavek zaznamená.

6.5 Předání osobních údajů do země mimo EU/EHP je možné jen na doložený pokyn správce podle čl. 10.

6.6 **Přístup pracovníků zpracovatele k údajům.** Běžný provoz musteru přístup k obsahu dat nevyžaduje. Pracovník zpracovatele nahlíží do instance správce jen (a) na žádost správce (podpora, oprava chyby), nebo (b) při řešení incidentu nebo prokazatelné poruchy, vždy v nejmenším nutném rozsahu. Každý takový přístup je zapsán do audit logu („break-glass“) s důvodem a časem; správce dostane na vyžádání jejich přehled, u přístupů podle písm. (b) ho zpracovatel informuje bez vyžádání nejpozději se zprávou o incidentu.

## 7. Mlčenlivost

7.1 Zpracovatel zajistí, aby všechny osoby, které pro něj osobní údaje zpracovávají nebo k nim mají přístup (zaměstnanci, spolupracovníci, subdodavatelé podpory), byly **písemně zavázány mlčenlivostí** a poučeny o povinnostech podle této smlouvy (čl. 28 odst. 3 písm. b) a čl. 32 odst. 4 GDPR). Mlčenlivost trvá i po skončení jejich spolupráce se zpracovatelem a po skončení této smlouvy.

7.2 Přístup k údajům mají jen osoby, které ho k plnění smlouvy nezbytně potřebují, a to na základě individuálních účtů s dvoufázovým ověřením. Seznam rolí s přístupem a počet osob zpracovatel na žádost sdělí.

7.3 Mlčenlivost se vztahuje i na obchodní informace správce (obsazenost, tržby, ceník, zákaznická základna), které jsou z dat zjistitelné.

7.4 Mlčenlivost neporušuje sdělení, které ukládá zákon (čl. 6.4), nebo které správce písemně povolí.

## 8. Zabezpečení zpracování (čl. 32 GDPR)

8.1 Zpracovatel zavede a po celou dobu udržuje technická a organizační opatření uvedená v **Příloze 2**. Nezávisle na jejím aktuálním znění platí vždy nejméně toto:
- (a) **šifrování citlivých polí** v databázi (jméno, e-mail, telefon, adresa, typ a číslo dokladu totožnosti, bankovní token a přístupy k bráně) algoritmem AES-256-GCM, s klíči uloženými mimo databázi a verzovanými pro rotaci; e-mail je pro vyhledání uložen navíc jen jako klíčovaný otisk (HMAC);
- (b) **oddělená databáze a úložiště pro každou půjčovnu**, vlastní klíče a tajemství, žádné sdílené účty; automatické testy, že data jedné instance nejsou dostupné přes doménu jiné;
- (c) **šifrované zálohy mimo produkční server** (průběžná replikace a denní záloha) s pravidelným testem obnovy a záznamem o něm;
- (d) **povinné dvoufázové ověření** (TOTP nebo passkey) pro všechny účty obsluhy správce i pro účty zpracovatele na platformě;
- (e) **audit log** všech změn nastavení, přístupů k citlivým polím, administrátorských akcí a přístupů zpracovatele, uložený jen pro připojování (append-only), s nejvýše pseudonymizovanými identifikátory (otisky místo hodnot – jde stále o osobní údaje, dokud existuje klíč otisku), s retencí {{DOBA_LOGY}}; provozní a bezpečnostní logy včetně logu reverzní proxy neobsahují jméno, e-mail, telefon, číslo dokladu, hesla ani tokeny a IP adresa je v nich před zápisem zkrácena nebo nahrazena otiskem (Příloha 2 bod 14);
- (f) **automatické mazání a anonymizace** podle retenčních lhůt nastavených správcem (čl. 5.3);
- (g) šifrovaný přenos (TLS 1.2+, HSTS), hesla uložená funkcí scrypt, serverové session s omezenou platností, ochrana proti CSRF, přísná Content-Security-Policy, omezení počtu pokusů (rate limiting), bezpečnostní hlavičky;
- (h) individuální účty, role, odebrání přístupu při odchodu, minimální oprávnění procesů a kontejnerů, oddělené prostředí vývoj/stage/provoz bez ostrých dat.

8.2 Opatření odpovídají posouzení rizik podle čl. 32 odst. 2 GDPR, zejména rizikům úniku z databáze nebo zálohy, přístupu mezi půjčovnami, kompromitace serveru, zneužití účtu obsluhy, podvržení platby a ztráty dat. Shrnutí posouzení je v Příloze 2, část F.

8.3 Zpracovatel může opatření měnit podle vývoje techniky a hrozeb, **nesmí však snížit jejich úroveň**. Podstatné změny zdokumentuje a Přílohu 2 aktualizuje nejméně jednou ročně; aktuální verzi zpřístupní správci v platformě a na žádost zašle.

8.4 **Povinnosti správce.** Správce zajistí bezpečnost na své straně: individuální účty pro každou osobu obsluhy a jejich zrušení při odchodu, bezpečné uchování hesel a záložních kódů dvoufázového ověření, nesdílení přihlašovacích údajů, zabezpečená zařízení, bezpečné uchování stažených exportů a tištěných protokolů. Zpracovatel k tomu poskytuje nástroje (správa uživatelů, přehled přihlášení, vynucené dvoufázové ověření).

8.5 **Testování** (čl. 32 odst. 1 písm. d) GDPR): zpracovatel při každém nasazení spouští automatizované testy (včetně testů přístupu mezi instancemi, CSRF, session, bezpečnostních hlaviček), kontrolu závislostí a obrazů kontejnerů a bezpečnostní sken aplikace; {{FREKVENCE_TESTU_OBNOVY}} testuje obnovu ze zálohy a nejméně jednou ročně provádí revizi podle OWASP ASVS. Záznamy poskytne podle čl. 14.

## 9. Další zpracovatelé

9.1 **Obecné povolení.** Správce uděluje zpracovateli **obecné písemné povolení** (čl. 28 odst. 2 GDPR) zapojit další zpracovatele uvedené v **Příloze 3**, v rozsahu a pro činnosti tam uvedené.

9.2 **Změny.** Zamýšlené zapojení nového dalšího zpracovatele nebo nahrazení stávajícího oznámí zpracovatel správci e-mailem na {{PUJCOVNA_EMAIL}} nejméně **{{LHUTA_OZNAMENI_PODZPRACOVATELE}}** předem. Oznámení obsahuje identitu, poskytovanou službu, umístění zpracování, záruky (smlouva podle čl. 28 odst. 4, certifikace) a datum zapojení. Správce může do **{{LHUTA_NAMITKY}}** od doručení oznámení vznést odůvodněnou námitku. Nevznese-li ji, platí změna za schválenou.

9.3 **Řešení námitky.** Při námitce strany jednají o řešení (jiný poskytovatel, dodatečné záruky). Nenajdou-li ho do data zapojení nebo nemůže-li zpracovatel bez dalšího zpracovatele službu poskytovat, má správce právo **vypovědět hlavní smlouvu bez sankce** s účinností nejpozději ke dni zapojení; zpracovatel do té doby dalšího zpracovatele pro instanci správce nezapojí. Postup při skončení se řídí čl. 13.

9.4 **Naléhavá změna.** Vyžaduje-li bezpečnost nebo dostupnost služby okamžitou výměnu dalšího zpracovatele (výpadek, ukončení služby, bezpečnostní incident u poskytovatele), může zpracovatel bez dalšího oznámení přepnout jen na **záložního dalšího zpracovatele, který je pro danou službu předem uveden v Příloze 3 A** (záložní poskytovatel e-mailů {{EMAIL_SLUZBA_ZALOZNI}}; jiné datové centrum Hetzner v EU) – ten je krytý obecným povolením podle čl. 9.1 a správce ho může uvést ve svých Zásadách předem (čl. 13 odst. 1 písm. e) GDPR). O provedeném přepnutí zpracovatel správce informuje nejpozději do 5 pracovních dnů. Na jiného než předem uvedeného dalšího zpracovatele lze přejít jen postupem podle čl. 9.2; do té doby zpracovatel službu poskytuje v omezeném rozsahu (např. e-maily odkládá do fronty) a správce o tom informuje.

9.5 **Řetězec povinností.** Zpracovatel uzavře s každým dalším zpracovatelem písemnou smlouvu, která mu ukládá **stejné povinnosti ochrany údajů** jako tato smlouva (čl. 28 odst. 4 GDPR). U velkých poskytovatelů jde o jejich standardní smlouvu o zpracování; zpracovatel na žádost poskytne její kopii nebo odkaz. Neplní-li další zpracovatel své povinnosti, odpovídá správci za jejich plnění zpracovatel. Zpracovatel oznámení o změnách podzpracovatelů svých podzpracovatelů (např. Hetzner oznamuje změny s lhůtou 14 dnů) přepošle správci bez zbytečného odkladu, aby správce mohl lhůtu podle čl. 9.2 využít.

9.6 **Kdo není dalším zpracovatelem – a proč.** Některé subjekty, které se systému účastní, nejsou podzpracovateli zpracovatele, ale **smluvními partnery správce** (nebo subjekty, které osobní údaje zákazníků vůbec nedostávají). Správce s nimi má vlastní smluvní vztah a uvádí je ve svých Zásadách a záznamech o činnostech zpracování (čl. 30 odst. 1 GDPR):
- (a) **Platební brána {{PLATEBNI_BRANA}}.** Smlouvu o přijímání plateb uzavírá správce svým jménem a platby jdou na účet správce; zpracovatel peníze nikdy nedrží. Brána zpracovává platební údaje jako regulovaný poskytovatel platebních služeb (samostatný správce, případně zpracovatel správce podle své smlouvy se správcem). Muster na pokyn správce – tím je volba brány a vložení přístupových údajů v adminu – zakládá platby (částka, číslo rezervace, e-mail zákazníka pro potvrzení), přesměruje zákazníka na stránku brány, zakládá preautorizaci kauce při převzetí a čte stav plateb. Tyto operace jsou zpracováním **pro správce** a jsou popsány v Příloze 1; údaje o kartě k zpracovateli nikdy neprocházejí (režim PCI DSS SAQ A).
- (b) **Banka {{BANKA}}.** Účet patří správci; správce vytvoří ve svém internetovém bankovnictví **token API jen pro čtení** a vloží ho do adminu, kde je uložen šifrovaně. Muster pohyby čte a páruje s rezervacemi; údaje plátců v pohybech (jméno, číslo účtu, zpráva pro příjemce) se tím stávají údaji, které zpracovatel zpracovává pro správce. Banka sama je samostatným správcem vázaným bankovním tajemstvím a zpracovatel vůči ní nijak nevystupuje. Zpracovatel nikdy nezadává platební příkazy.
- (c) **Účetní správce, pojišťovna, Policie ČR** – příjemci na straně správce; muster jim data nepředává, správce jim je předává sám (export, doklady).
- (d) **Poskytovatelé, kteří osobní údaje zákazníků nedostávají:** certifikační autorita Let's Encrypt (jen názvy domén; muster používá jeden wildcard certifikát, takže ani názvy půjčoven nejsou v certifikátech), poskytovatel DNS {{DNS_POSKYTOVATEL}} a registrátor domény (jen DNS záznamy).
- (e) **Mapové podklady Mapy.cz (Seznam.cz, a.s.) a CyclOSM.** Mapu na stránce „Mapa a výlety“ načítá prohlížeč návštěvníka až po jeho kliknutí přímo ze serverů poskytovatele; ten tím získá IP adresu návštěvníka jako samostatný správce. Zpracovatel data o návštěvnících poskytovateli nepředává. Správce to uvede v Zásadách. Totéž platí pro analytické nebo marketingové nástroje, které by správce sám zapnul – ty vyžadují souhlas návštěvníka (§ 89 odst. 3 ZEK) a nejsou součástí výchozí služby.

## 10. Umístění zpracování a předávání mimo EU/EHP

10.1 Veškeré zpracování – server, databáze, soubory, zálohy, odesílání e-mailů, podpora – probíhá **v Evropské unii nebo Evropském hospodářském prostoru**: server a zálohy v datových centrech Hetzner ({{HETZNER_LOKALITA}}), e-mailová služba v {{EMAIL_SLUZBA_LOKALITA}}. Pracovníci zpracovatele přistupují k údajům jen z území EU/EHP.

10.2 Předání osobních údajů do třetí země nebo mezinárodní organizaci (včetně vzdáleného přístupu ze třetí země) je možné jen na doložený pokyn správce a při splnění kapitoly V GDPR (čl. 44–49): na základě rozhodnutí Komise o odpovídající ochraně (čl. 45) nebo vhodných záruk, zejména standardních smluvních doložek (čl. 46 odst. 2 písm. c)). Zpracovatel správci předem sdělí zemi a použitou záruku a na žádost ji doloží.

10.3 Pokud by některý další zpracovatel zpracovával údaje mimo EU/EHP, uvede to zpracovatel v Příloze 3 včetně záruky a oznámí to postupem podle čl. 9.2; do té doby takového zpracovatele nezapojí.

## 11. Součinnost při právech subjektů údajů (čl. 12–22 GDPR)

11.1 Žádosti zákazníků vyřizuje správce. Zpracovatel mu k tomu poskytuje **funkce v adminu**, které správci umožní odpovědět ve lhůtě jednoho měsíce (čl. 12 odst. 3 GDPR):
- (a) **export údajů zákazníka** ve strojově čitelném formátu (JSON, volitelně CSV) pro právo na přístup (čl. 15) a přenositelnost (čl. 20);
- (b) **oprava** údajů (čl. 16) přímou editací;
- (c) **výmaz / anonymizace** jedním úkonem (čl. 17): osobní údaje v rezervaci, zákaznickém profilu, protokolech a komunikaci se nahradí. Vystavené daňové a účetní doklady se uchovávají po dobu {{DOBA_DOKLADY}}, protože to ukládá zákon (čl. 17 odst. 3 písm. b) GDPR; § 35 ZDPH; § 31 zákona o účetnictví; § 7b ZDP). Systém rozlišuje typ dokladu: u dokladu, který nemusí obsahovat označení příjemce – zjednodušený daňový doklad do 10 000 Kč (§ 30, § 30a ZDPH), doklad pro spotřebitele, kterému plátce daňový doklad vystavovat nemusí (§ 28 odst. 1 ZDPH), nebo doklad neplátce – jméno a adresu zákazníka anonymizuje a doklad zůstává vázán jen na číslo rezervace; u plného daňového dokladu (příjemce s IČO/DIČ nebo částka nad 10 000 Kč) identifikaci příjemce ponechá (§ 29 odst. 1 ZDPH) a výmaz v tomto rozsahu odmítne – správci vygeneruje text odpovědi zákazníkovi s odůvodněním podle čl. 17 odst. 3 písm. b) GDPR;
- (d) **omezení zpracování** (čl. 18) označením zákazníka, po kterém systém jeho údaje nepoužije pro e-maily ani další operace kromě uchování;
- (e) **námitka a odvolání souhlasu** (čl. 21, čl. 7 odst. 3 GDPR; § 7 odst. 3 zákona o některých službách informační společnosti) – odhlášení z obchodních sdělení jedním kliknutím v každé zprávě a v adminu, zpracované nejpozději do 3 dnů, a vedení **blokačního seznamu** otisků e-mailů, který systém kontroluje před každou rozesílkou;
- (f) aktuální **seznam příjemců a dalších zpracovatelů** (Příloha 3) a popis zpracování (Příloha 1) pro odpověď zákazníkovi a pro Zásady (čl. 13).

11.2 **Žádost doručená zpracovateli.** Obrátí-li se subjekt údajů se žádostí přímo na zpracovatele (e-mailem, přes web musteru), zpracovatel žádost **bez vlastního vyřízení** předá správci do **{{LHUTA_PREDANI_ZADOSTI}}** a žadateli sdělí pouze to, že správcem jeho údajů je {{PUJCOVNA_NAZEV}} a že mu žádost předal. Zpracovatel sám o žádosti nikdy nerozhoduje a nepodává informace o obsahu údajů.

11.3 **Součinnost nad rámec funkcí adminu** (například dohledání údajů, které funkce nepokrývají, technické vysvětlení zpracování pro odpověď) poskytne zpracovatel do **{{LHUTA_SOUCINNOSTI}}** od žádosti správce, vždy tak, aby správce stihl zákonnou lhůtu. Je-li rozsah mimořádný, může zpracovatel účtovat {{SAZBA_SOUCINNOSTI}}; nikdy ne tehdy, vznikla-li potřeba porušením povinností zpracovatele.

11.4 Zpracovatel zajistí, aby byly spolu s rezervací uchovány a doložitelné: (a) záznam o **přijetí obchodních podmínek** zákazníkem (verze, čas, otisk IP) – jde o uzavření smlouvy (čl. 6 odst. 1 písm. b) GDPR), nikoli o souhlas se zpracováním; záznam dokládá obsah smlouvy (§ 1751, § 562 odst. 2 OZ); (b) záznam o **možnosti odmítnout obchodní sdělení** při rezervaci a o každém odhlášení či námitce (§ 7 odst. 3 zákona o některých službách informační společnosti; čl. 21 odst. 2 a 3 GDPR); (c) záznam o **souhlasu** s obchodními sděleními tam, kde ho správce vyžaduje (osoby bez výpůjčky, newsletter) – k prokázání souhlasu podle čl. 7 odst. 1 GDPR.

## 12. Součinnost při zabezpečení, incidentech, posouzení vlivu a konzultacích (čl. 32–36 GDPR)

12.1 **Co je incident.** Porušením zabezpečení (čl. 4 bod 12 GDPR) je zejména: neoprávněný přístup k instanci nebo serveru; únik databáze, zálohy nebo klíčů; zobrazení dat správce jiné půjčovně nebo naopak; odeslání e-mailu s údaji zákazníka na nesprávnou adresu vinou systému; ztráta nebo zašifrování dat (ransomware) bez možnosti obnovy; ztráta zálohy; kompromitace účtu obsluhy nebo zpracovatele; zranitelnost, u které nelze vyloučit, že byla zneužita.

12.2 **Ohlášení správci.** Zpracovatel ohlásí správci každý incident, který se týká jeho instance nebo sdílené infrastruktury, u níž nelze dopad na instanci vyloučit, **bez zbytečného odkladu, nejpozději do {{LHUTA_OHLASENI_INCIDENTU}} od okamžiku, kdy se o něm dozvěděl** (čl. 33 odst. 2 GDPR), na {{PUJCOVNA_INCIDENT_KONTAKT}} – e-mailem a u incidentů s pravděpodobným rizikem pro zákazníky také telefonicky nebo SMS. Nemá-li v této lhůtě úplné informace, ohlásí to, co ví, a doplňuje průběžně (obdobně čl. 33 odst. 4 GDPR). Lhůta běží i o víkendech a svátcích.

12.3 **Obsah ohlášení** (obdobně čl. 33 odst. 3 GDPR, aby ho správce mohl převzít do ohlášení ÚOOÚ): popis povahy incidentu; kategorie a přibližný počet dotčených zákazníků a záznamů; čas vzniku a zjištění; kontaktní osoba zpracovatele; pravděpodobné důsledky; zda byly dotčené údaje šifrované a klíč nebyl kompromitován (důležité pro čl. 34 odst. 3 písm. a) GDPR); přijatá a navrhovaná opatření; zda jsou dotčeny i jiné půjčovny (bez jejich identifikace). Šablona je v Příloze 4.

12.4 **Dokumentace a podklady.** Zpracovatel každý incident zdokumentuje ve své evidenci (obdobně čl. 33 odst. 5 GDPR) a správci poskytne vše, co potřebuje pro **ohlášení ÚOOÚ do 72 hodin** (čl. 33 odst. 1 GDPR) a pro **informování zákazníků** při vysokém riziku (čl. 34 GDPR): seznam dotčených zákazníků s kontakty, technický popis, a na pokyn správce odešle informaci zákazníkům systémem. Rozhodnutí, zda a co ohlásit a koho informovat, je na správci; zpracovatel sám ÚOOÚ ani zákazníky neinformuje, ledaže mu to ukládá zákon nebo pokyn správce. Zpracovatel incident správce bez jeho souhlasu nezveřejní; je-li dotčeno více půjčoven, informuje každou o jejím dopadu.

12.5 **Náprava.** Zpracovatel neprodleně zahájí nápravná opatření (izolace, rotace klíčů a hesel, zneplatnění session, obnova ze zálohy, oprava zranitelnosti), informuje správce o postupu a po uzavření incidentu předá závěrečnou zprávu s příčinou a opatřeními proti opakování.

12.6 **Posouzení vlivu (DPIA, čl. 35) a předchozí konzultace (čl. 36).** Pro běžnou půjčovnu kol DPIA povinné není, rozhoduje však správce. Rozhodne-li se ji provést nebo konzultovat zpracování s ÚOOÚ, poskytne mu zpracovatel do {{LHUTA_SOUCINNOSTI}} popis zpracování (Příloha 1), opatření (Příloha 2), posouzení rizik a další technické informace, které správce potřebuje.

12.7 **Kontrola ÚOOÚ.** Obě strany spolupracují s dozorovým úřadem. Zpracovatel informuje správce o kontrole nebo opatření ÚOOÚ, které se týká údajů správce, ledaže to zakazuje zákon nebo rozhodnutí orgánu.

12.8 **Incident na straně správce.** Správce bez zbytečného odkladu oznámí zpracovateli na {{PROVOZOVATEL_INCIDENT_KONTAKT}} událost, která může ohrozit systém (ztráta nebo vyzrazení hesla, odchod osoby, která znala přístupy, krádež zařízení s přihlášením). Zpracovatel pomůže s nápravou (zneplatnění session, reset dvoufázového ověření, přehled přihlášení).

## 13. Skončení zpracování: export a výmaz údajů (čl. 28 odst. 3 písm. g) GDPR)

13.1 Po skončení hlavní smlouvy z jakéhokoli důvodu zpracovatel:
- (a) nejpozději **do 3 pracovních dnů** od účinnosti skončení zpřístupní správci **úplný export instance**: data ve strojově čitelném formátu (JSON a CSV všech tabulek z Přílohy 1 včetně dešifrovaných osobních údajů), vystavené dokumenty (potvrzení, doklady, protokoly), fotografie, nastavení a verze obchodních podmínek a Zásad se záznamy o jejich přijetí a o souhlasech a odmítnutích u obchodních sdělení. Export je dostupný jen po přihlášení s dvoufázovým ověřením, jako šifrovaný archiv, jehož heslo zpracovatel předá jinou cestou než odkaz;
- (b) po dobu **{{LHUTA_EXPORTU}}** od skončení ponechá instanci v režimu **jen pro export** – veřejný web a rezervace jsou vypnuté, obsluha správce se může přihlásit jen ke stažení dat;
- (c) po uplynutí exportní lhůty, nebo dříve na písemný pokyn správce, instanci **smaže do {{LHUTA_VYMAZU}}**: databázový soubor, soubory, šifrovací klíče a tajemství (bankovní token, přístupy k bráně), průběžnou repliku, DNS záznam subdomény {{WEB_SUBDOMENA}} a e-mailovou konfiguraci. O výmazu vystaví správci **písemný protokol** s datem a rozsahem;
- (d) **zálohy instance smaže spolu s instancí**: repliku databáze (Litestream) a zálohovou sadu instance (restic – snímky označené identifikátorem instance, `forget --tag` + `prune`). Nelze-li některou zálohovou sadu technicky smazat výběrově, vyrotuje nejpozději do **{{LHUTA_VYMAZU_ZALOH}}** od výmazu instance; do té doby je šifrovaná, nepoužívá se a zpracovatel ji neobnoví jinak než na písemný pokyn správce (např. při omylu). Dvanáctiměsíční retence {{DOBA_ZALOHY}} platí jen pro **běžící** instance (Příloha 2 bod 17), kde kryje právo na výmaz shodně se Zásadami správce. Zánik poslední kopie zpracovatel na žádost potvrdí.

13.2 **Povinnosti správce.** Správce si export ve lhůtě stáhne a dále sám plní své archivační povinnosti: {{#PLATCE_DPH}}daňové doklady 10 let od konce zdaňovacího období, ve kterém se plnění uskutečnilo (§ 35 odst. 2 ZDPH) – lze elektronicky (§ 35a ZDPH) při zachování věrohodnosti původu, neporušenosti obsahu a čitelnosti dokladu po celou dobu uchovávání (§ 34 odst. 1 ZDPH), přičemž za dostatečné zajištění lze považovat kontrolní mechanismy procesů vytvářející spolehlivou vazbu mezi dokladem a plněním (§ 34 odst. 3 ZDPH), které export zachovává číselnými řadami a výpisem auditního logu; {{/PLATCE_DPH}}je-li správce účetní jednotkou, účetní doklady 5 let a účetní závěrky 10 let od konce účetního období (§ 31 odst. 2 zákona o účetnictví); vede-li daňovou evidenci, po dobu, po kterou neuplynula lhůta pro stanovení daně (§ 7b odst. 5 ZDP, § 148 DŘ); smlouvy a protokoly po dobu promlčecí lhůty (§ 619, § 629 OZ). Po výmazu zpracovatel žádné údaje zákazníků nedrží a nemůže je obnovit. Nevyužije-li správce export, výmaz proběhne stejně; zpracovatel ho na to upozorní e-mailem 7 dnů před výmazem.

13.3 **Co zpracovatel smí ponechat:** (a) vlastní účetní a smluvní doklady vůči správci (ty neobsahují údaje zákazníků); (b) provozní a audit logy po dobu {{DOBA_LOGY}}, k prokázání řádného zpracování a bezpečnosti – spolu s instancí se smaže i klíč HMAC, kterým byly otisky vytvořeny, takže zbývající otisky už nelze přiřadit k osobě; (c) protokol o výmazu; (d) evidenci incidentů **bez seznamů dotčených zákazníků** po dobu 5 let od uzavření incidentu (doložitelnost vůči ÚOOÚ, čl. 33 odst. 5 GDPR) – seznamy dotčených osob a jejich kontakty se mažou spolu s instancí.

13.4 Export podle čl. 13.1 slouží i k **přechodu k jinému poskytovateli**; jeho formát zpracovatel dokumentuje. Správce si může úplný export instance ve formátu podle čl. 13.1 písm. a) stáhnout **kdykoli i za trvání smlouvy** v adminu (role vlastník, dvoufázové ověření); stažení se zapisuje do audit logu. Slouží to i k vlastní archivaci dokladů správce a k přechodu bez výpovědi „naslepo“.

{{#PLATCE_DPH}}13.5 **Daňové doklady uchovávané mimo tuzemsko.** Daňové doklady správce jsou po dobu trvání smlouvy uchovávány elektronicky na serverech v Německu ({{HETZNER_LOKALITA}}) způsobem umožňujícím nepřetržitý dálkový přístup (admin, export). Správce jako uchovatel je povinen **předem oznámit svému správci daně místo uchovávání mimo tuzemsko** (§ 35 odst. 3 a 4 ZDPH) a na výzvu zajistit správci daně bezodkladný přístup k dokladům, možnost je stáhnout a použít (§ 35a odst. 4 ZDPH); zpracovatel k tomu poskytne součinnost (export dokladů za zvolené období ve strojově čitelném formátu i v podobě pro tisk) do {{LHUTA_SOUCINNOSTI}}, při probíhající daňové kontrole bez zbytečného odkladu. Systém správci při onboardingu zobrazí upozornění na oznamovací povinnost a nabídne vzor oznámení. Po skončení smlouvy dálkový přístup zaniká (čl. 13.1); správce doklady z exportu přenese na jiné místo a případnou změnu místa uchovávání oznámí správci daně.{{/PLATCE_DPH}}

## 14. Doložení souladu a audity (čl. 28 odst. 3 písm. h) GDPR)

14.1 **Informace.** Zpracovatel správci na žádost do {{LHUTA_SOUCINNOSTI}} poskytne vše potřebné k doložení, že plní povinnosti podle čl. 28 GDPR a této smlouvy: aktuální Přílohu 2 a popis architektury, záznam o posledním testu obnovy ze zálohy, souhrn výsledků bezpečnostních testů, přehled rolí s přístupem, potvrzení o smlouvách s dalšími zpracovateli (u Hetzner včetně zprávy o ročním nezávislém auditu opatření, kterou Hetzner poskytuje zákazníkům se smlouvou o zpracování), evidenci incidentů a evidenci přístupů podle čl. 6.6 týkajících se instance správce.

14.2 **Audit.** Správce může – sám nebo prostřednictvím nezávislého auditora vázaného mlčenlivostí, který není konkurentem zpracovatele – provést **jednou za kalendářní rok** audit plnění této smlouvy, oznámený **{{LHUTA_OZNAMENI_AUDITU}}** předem, v pracovní době a bez narušení provozu. Formy: prohlídka dokumentace, rozhovor s odpovědnou osobou, vzdálená ukázka konfigurace a nastavení, ověření funkcí v instanci správce, vzorkové ověření záznamů. Po incidentu týkajícím se správce nebo při důvodném podezření na porušení smlouvy lze audit provést **mimořádně** bez ohledu na roční limit.

14.3 **Meze auditu na sdílené infrastruktuře.** Audit nesmí zasáhnout do dat jiných půjčoven ani do bezpečnosti serveru: zpracovatel neposkytne přístup do operačního systému serveru, k databázím jiných instancí ani k šifrovacím klíčům. Fyzický přístup do datového centra není možný (Hetzner ho zákazníkům neposkytuje); nahrazují ho jeho certifikace a nezávislé audity opatření, jejichž výsledky zpracovatel předá.

14.4 **Náklady a nálezy.** Každá strana nese své náklady; čas pracovníků zpracovatele nad 4 hodiny za audit může zpracovatel účtovat sazbou {{SAZBA_SOUCINNOSTI}}, ne však odhalí-li audit porušení smlouvy. Zjištěné nedostatky zpracovatel odstraní v dohodnuté přiměřené lhůtě, závažné bez zbytečného odkladu. Zpráva z auditu je důvěrná a správce ji nesmí poskytnout třetím osobám kromě dozorového úřadu a svých poradců.

14.5 **Záznamy o činnostech.** Zpracovatel vede záznamy o kategoriích činností zpracování prováděných pro všechny správce (čl. 30 odst. 2 GDPR). Správci poskytuje předvyplněný záznam o jeho činnostech zpracování (čl. 30 odst. 1 GDPR) generovaný z Příloh 1 a 3 – viz [záznamy o činnostech zpracování](zaznam-o-cinnostech-zpracovani.md).

## 15. Odpovědnost

15.1 **Vůči subjektům údajů** se odpovědnost řídí čl. 82 GDPR: zpracovatel odpovídá za újmu jen tehdy, nesplnil-li povinnosti, které GDPR ukládá specificky zpracovatelům, nebo jednal-li nad rámec či v rozporu s pokyny správce (čl. 82 odst. 2); správce odpovídá za újmu, kterou způsobí zpracováním v rozporu s GDPR. Odpovídají-li za tutéž újmu oba, odpovídá každý za celou újmu (čl. 82 odst. 4) a ten, kdo ji nahradil, má právo na vrácení části odpovídající podílu druhého (čl. 82 odst. 5). Strany si tento regres vzájemně poskytnou.

15.2 **Mezi stranami** nahradí strana druhé straně škodu způsobenou porušením této smlouvy (§ 2913 odst. 1 OZ); zprostí se, prokáže-li mimořádnou nepředvídatelnou a nepřekonatelnou překážku vzniklou nezávisle na její vůli (§ 2913 odst. 2 OZ). Správce odpovídá zejména za zákonnost účelů a právních titulů, obsah obchodních podmínek a Zásad, správnost pokynů a nastavení (včetně retence), za své uživatele a za údaje, které do systému vloží. Zpracovatel odpovídá zejména za zabezpečení, dodržení pokynů, další zpracovatele, ohlášení incidentů a výmaz.

15.3 **Pokuty.** Pokutu uloženou dozorovým úřadem (čl. 83 GDPR; § 62 ZZOÚ) nese strana, které byla uložena. V rozsahu, v jakém uložení pokuty způsobilo porušení povinností druhé strany z této smlouvy, jde o škodu, kterou druhá strana nahradí podle § 2913 odst. 1 OZ při prokázání příčinné souvislosti; čl. 15.4 se použije.

15.4 **Omezení.** Celková náhrada škody zpracovatele vůči správci z této smlouvy je omezena částkou **{{LIMIT_ODPOVEDNOSTI}}**. Omezení neplatí pro újmu způsobenou úmyslně nebo z hrubé nedbalosti a pro újmu na přirozených právech člověka (§ 2898 OZ) ani pro regres podle čl. 15.1 v rozsahu, ve kterém ho GDPR nedovoluje smluvně omezit. Omezení se neuplatní ani v rozsahu, v jakém ho zákon vůči slabší straně nepřipouští (§ 2898 věta druhá, § 433 OZ). Správce potvrzuje, že měl možnost znění smlouvy před uzavřením projednat a návrhy změn uplatnit (čl. 18.1).

15.5 **Smluvní pokuta** se nesjednává (volitelné ujednání viz *K ověření advokátem*, bod 4).

## 16. Odměna

16.1 Odměna za zpracování je zahrnuta v ceně služby podle hlavní smlouvy. Součinnost nad její rámec (čl. 11.3, 12.6, 14.4) může zpracovatel účtovat sazbou {{SAZBA_SOUCINNOSTI}} po předchozím odhadu rozsahu; nikdy ne za nápravu vlastního porušení nebo za incident, který zavinil.

## 17. Trvání a ukončení

17.1 Smlouva je účinná od {{DATUM_UZAVRENI}} a trvá po dobu hlavní smlouvy. Nelze ji vypovědět samostatně, dokud zpracovatel pro správce zpracovává osobní údaje. Po skončení trvají povinnosti podle čl. 7 (mlčenlivost), 13 (export a výmaz), 14.1 (informace o skončeném zpracování), 15 (odpovědnost) a 18.

17.2 **Odstoupení.** Poruší-li strana smlouvu podstatným způsobem, může druhá strana bez zbytečného odkladu odstoupit od hlavní smlouvy (§ 2002 odst. 1 OZ). Podstatným porušením zpracovatele je zejména: zpracování pro vlastní účely, neohlášení incidentu ve lhůtě, zapojení dalšího zpracovatele bez oznámení nebo navzdory nevyřešené námitce, předání údajů mimo EU/EHP bez pokynu, odmítnutí auditu, opakované nesplnění pokynu. Podstatným porušením správce je zejména: setrvání na pokynu, který zpracovatel označil za protiprávní (čl. 6.3), nebo opakované vkládání údajů podle čl. 4.3 po upozornění.

17.3 Výpověď hlavní smlouvy se řídí jejími pravidly (§ 1998 OZ). Po každém skončení se postupuje podle čl. 13.

## 18. Závěrečná ustanovení

18.1 **Uzavření.** Smlouva se uzavírá při onboardingu půjčovny v platformě: osoba oprávněná jednat za správce ({{PUJCOVNA_ZASTUPCE}}) po přihlášení s dvoufázovým ověřením potvrdí její znění; systém uloží verzi, čas, uživatele a otisk IP adresy, vygeneruje dokument s doplněnými parametry (HTML pro tisk, případně PDF) a odešle ho oběma stranám e-mailem; totéž znění je trvale dostupné v platformě pod číslem záznamu. Potvrzení znění přihlášeným uživatelem s uvedením jeho jména v dokumentu je elektronickým podpisem podle § 7 ZSDEP; písemná forma je tím zachována (čl. 28 odst. 9 GDPR; § 561 odst. 1 a § 562 odst. 1 OZ). Má se za to, že záznam o uzavření je spolehlivý (§ 562 odst. 2 OZ): zpracovatel záznamy o uzavření vede systematicky a posloupně v audit logu chráněném proti změnám (append-only). Smlouvu může za správce potvrdit jen účet s rolí **vlastník**; systém před potvrzením zobrazí celý text včetně příloh a umožní zaslat návrhy změn na {{PROVOZOVATEL_EMAIL}}. Na žádost správce, a vždy u správce, který není podnikatelem (čl. 1.6), se smlouva uzavírá podpisem vygenerovaného dokumentu (vlastnoručním nebo elektronickým) s potvrzením, že se správce seznámil s přílohami.

18.2 **Změny.** (a) Přílohu 2 může zpracovatel aktualizovat podle čl. 8.3; (b) Příloha 3 se mění postupem podle čl. 9; (c) text smlouvy může zpracovatel jednostranně změnit **jen v přiměřeném rozsahu a z těchto důvodů** (§ 1752 odst. 1 OZ): změna právních předpisů nebo závazných stanovisek ÚOOÚ či EDPB, změna technického řešení služby, změna dalších zpracovatelů (čl. 9). Změna nesmí bez výslovného souhlasu správce zhoršit jeho postavení v otázkách odpovědnosti (čl. 15), odměny (čl. 16) a lhůt v tabulce Parametry. Novou verzi zpracovatel oznámí e-mailem na {{PUJCOVNA_EMAIL}} s vyznačením změn nejméně {{LHUTA_OZNAMENI_ZMENY_SMLOUVY}} před účinností. Správce ji může do dne účinnosti odmítnout a hlavní smlouvu vypovědět s výpovědní dobou {{VYPOVEDNI_DOBA_ZMENA}}; po dobu výpovědní doby platí dosavadní verze a s výpovědí není spojena žádná sankce ani jiná povinnost správce. Neodmítne-li správce novou verzi do dne její účinnosti, platí za přijatou; systém mu ji při prvním přihlášení po účinnosti zobrazí k potvrzení a potvrzení zaznamená stejně jako uzavření (čl. 18.1). Ostatní změny vyžadují dohodu obou stran v písemné formě včetně elektronické.

18.3 **Přednost.** V rozporu mezi touto smlouvou a hlavní smlouvou má v otázkách osobních údajů přednost tato smlouva. V rozporu s kogentním ustanovením GDPR nebo zákona platí předpis.

18.4 **Právo a spory.** Smlouva se řídí právem České republiky; GDPR se použije přímo. Spory strany nejprve řeší jednáním; jinak rozhodují soudy České republiky.

18.5 **Oddělitelnost.** Je-li nebo stane-li se část smlouvy neplatnou nebo neúčinnou, ostatní části platí dál; strany neplatnou část nahradí platnou s nejbližším účelem.

18.6 **Komunikace.** Smluvní komunikace probíhá e-mailem na adresy v záhlaví; incidenty se hlásí podle čl. 12.2 a 12.8. Změnu kontaktů strana oznámí bez zbytečného odkladu; do té doby platí poslední známé.

18.7 Smlouva se vyhotovuje v českém jazyce. Tato verze **{{VERZE}}** je účinná od **{{UCINNOST_OD}}**; archiv verzí je správci přístupný v platformě.

| Správce | Zpracovatel |
|---|---|
| {{PUJCOVNA_NAZEV}} | {{PROVOZOVATEL_NAZEV}} |
| {{PUJCOVNA_ZASTUPCE}} | {{PROVOZOVATEL_ZASTUPCE}} |
| uzavřeno {{DATUM_UZAVRENI}} (elektronicky v platformě, záznam č. … / podpis) | uzavřeno {{DATUM_UZAVRENI}} |

---

## Příloha 1: Popis zpracování

### A. Shrnutí

| Položka | Obsah |
|---|---|
| Předmět | Hosting a provoz webu a rezervačního systému půjčovny {{PUJCOVNA_NAZEV}} na {{WEB_SUBDOMENA}}, zálohy, aktualizace, podpora |
| Povaha | Ukládání, šifrování, zobrazení obsluze správce, generování dokumentů, e-maily, založení plateb u brány správce, čtení a párování bankovních pohybů správce, zálohování, obnova, výmaz, export, nahlížení při podpoře |
| Účel | Rezervace a nájem kol, platby a vratky, účetní a daňové povinnosti správce, ochrana majetku správce, komunikace se zákazníky |
| Kategorie subjektů | Zákazníci správce (o dalších jezdcích uvedených v rezervaci jen počet – tabulka B), obsluha správce, plátci |
| Zvláštní kategorie údajů | Nezpracovávají se |
| Automatizované rozhodování | Neprovádí se |
| Doba | Po dobu hlavní smlouvy; poté export a výmaz podle čl. 13 |
| Umístění | Server, databáze, soubory a zálohy: Hetzner, {{HETZNER_LOKALITA}} (EU). E-maily: {{EMAIL_SLUZBA_NAZEV}}, {{EMAIL_SLUZBA_LOKALITA}}. Podpora: z území EU/EHP |
| Další zpracovatelé | Příloha 3 |

### B. Kategorie údajů

| Subjekt | Údaje | Odkud | Ochrana v systému |
|---|---|---|---|
| Zákazník | jméno a příjmení, e-mail, telefon; případně fakturační adresa a IČO | zadá zákazník při rezervaci | šifrovaná pole; e-mail navíc jako HMAC otisk |
| Zákazník | rezervace: termín, kola a příslušenství, cena, rezervační poplatek ({{POPLATEK_KOLO}} / {{POPLATEK_EKOLO}} za kolo), doplatek, kauce ({{KAUCE_KOLO}} / {{KAUCE_EKOLO}}), stav, storno podle {{STORNO_TABULKA}}, poznámky | systém, obsluha | přístup jen po přihlášení; správa rezervace zákazníkem přes podepsaný odkaz |
| Zákazník | záznam o přijetí obchodních podmínek (uzavření smlouvy): verze, čas, otisk IP | systém | otisk IP, ne IP; uchování {{DOBA_SMLOUVA}} |
| Další jezdci uvedení v rezervaci | **jen počet** (z toho počet mladších 18 let) a typ či velikost kola; žádné identifikační údaje. Osoba, která kolo při výdeji skutečně přebírá, je zapsána v předávacím protokolu jako nájemce (jméno, typ a číslo dokladu) a platí pro ni řádky výše | zákazník, obsluha | – |
| Zákazník | platby: způsob, částka, stav, identifikátor platby u brány, u karty nejvýše značka a poslední 4 číslice; u převodu číslo protiúčtu, zpráva pro příjemce, variabilní symbol; uložené notifikace brány (`webhook_events`: e-mail zákazníka, částka, stav) | brána, banka, obsluha | **nikdy číslo karty ani CVC**; bankovní pohyby jen z účtu správce; obsah notifikací se maže po {{DOBA_FRONTY}} |
| Zákazník | **typ a číslo dokladu totožnosti** (bez kopie) | zapíše obsluha při převzetí | šifrované pole, viditelné jen rolím obsluhy, automatický výmaz {{DOBA_CISLO_DOKLADU}} po vypořádání |
| Zákazník | předávací protokol a protokol o vrácení: přidělená kola, stav, kauce (forma a částka, u preautorizace identifikátor u brány), škoda, vyúčtování | obsluha | přístup jen po přihlášení |
| Zákazník | vystavené dokumenty: potvrzení, doklad o přijaté platbě, konečný doklad, opravný doklad | systém | uchování podle {{DOBA_DOKLADY}}; při žádosti o výmaz postup podle typu dokladu (čl. 11.1 c)) |
| Zákazník | komunikace: odeslané e-maily (potvrzení, připomínky, doklady, storno), stav doručení; kopie zprávy ve frontě systému (`outbox`) | systém, e-mailová služba | obsah v e-mailové službě jen po dobu nutnou k doručení; obsah ve frontě systému se maže po {{DOBA_FRONTY}}, zůstává stav doručení |
| Zákazník | obchodní sdělení vlastním zákazníkům (§ 7 odst. 3 zákona o některých službách informační společnosti): záznam o možnosti odmítnutí při rezervaci, o odhlášení či námitce a **blokační seznam** otisků e-mailů (pokud správce funkci zapne) | zákazník, systém | blokační seznam jen jako otisk e-mailu; kontrolován před každou rozesílkou |
| Zákazník / odběratel | souhlas s obchodními sděleními tam, kde je vyžadován (osoby bez výpůjčky, newsletter), a jeho odvolání | zákazník | do odvolání; záznam o souhlasu uchován k prokázání (čl. 7 odst. 1 GDPR) |
| Zákazník / návštěvník | technické údaje: otisk IP, user-agent, časy požadavků, bezpečnostní logy; technicky nezbytné cookies (session, rozpracovaná rezervace, CSRF, volba souhlasu) – bez souhlasu podle § 89 odst. 3 ZEK | prohlížeč | provozní a bezpečnostní logy obsahují nejvýše pseudonymizované identifikátory (otisk IP, otisk e-mailu); log reverzní proxy (Caddy) je buď vypnutý, nebo IP adresu před zápisem zkracuje či otiskuje; žádný log neobsahuje jméno, e-mail, telefon, číslo dokladu, hesla ani tokeny; retence {{DOBA_LOGY}} |
| Obsluha správce | jméno, e-mail, role, hash hesla (scrypt), tajemství dvoufázového ověření (šifrované), záložní kódy, přihlášení a akce v audit logu | správce | individuální účty, 2FA povinné |
| Plátce (třetí osoba) | jméno, číslo účtu, zpráva pro příjemce z bankovního pohybu (`bank_transactions` včetně surového záznamu), pokud platil někdo jiný než zákazník; nespárované pohyby, které k žádné rezervaci nepatří | banka správce | jen z účtu správce, párování podle VS; spárované pohyby sdílejí lhůtu rezervace, nespárované {{DOBA_NESPAROVANE_POHYBY}} |

### C. Nastavení správce, která určují zpracování (doložené pokyny)

Rezervační poplatek za kolo a elektrokolo, kauce a její povolené formy (hotově/terminál na místě, preautorizace karty přes bránu při převzetí), storno tabulka, lhůta platby poplatku převodem, retenční lhůty (tabulka D), zvolená platební brána a její přístupové údaje, bankovní účet a token API banky (jen čtení), texty e-mailů, obchodních podmínek a Zásad, otevírací doba, uživatelské účty obsluhy, zapnutí obchodních sdělení. Všechny změny jsou v audit logu.

### D. Retenční lhůty (výchozí hodnoty, mění správce v adminu)

| Údaje | Lhůta | Co se stane | Opora |
|---|---|---|---|
| Nedokončená nebo nezaplacená rezervace bez smlouvy | {{DOBA_NEDOKONCENE_REZERVACE}} od vytvoření | výmaz | minimalizace (čl. 5 odst. 1 písm. e) GDPR) |
| Typ a číslo dokladu totožnosti | {{DOBA_CISLO_DOKLADU}} po vrácení kola a vypořádání kauce; při nevyřešené škodě, krádeži nebo nezaplacení do vypořádání | výmaz pole | oprávněný zájem správce; stanovisko ÚOOÚ 2021 |
| Rezervace, smlouva o nájmu, protokoly, záznam o škodě, záznam o přijetí OP | {{DOBA_SMLOUVA}} od skončení nájmu nebo od vypořádání poslední pohledávky z nájmu (co nastane později); u rezervace s příznakem „spor“ do pravomocného skončení, nejdéle 10 let | anonymizace osobních údajů, obchodní data zůstávají; job „retence“ neanonymizuje rezervaci s otevřenou pohledávkou nebo příznakem „spor“ | § 619, § 629 odst. 1 a 2, § 636 odst. 1 OZ |
| Daňové a účetní doklady | {{DOBA_DOKLADY}} | doklady zůstávají (při žádosti o výmaz postup podle typu dokladu, čl. 11.1 c)); po uplynutí výmaz | {{#PLATCE_DPH}}§ 35 odst. 2 ZDPH; {{/PLATCE_DPH}}§ 31 odst. 2 zákona o účetnictví (účetní jednotka); § 7b odst. 5 ZDP a § 148 DŘ (daňová evidence) |
| Bankovní pohyby – spárované s rezervací | jako rezervace, ke které patří | anonymizace spolu s rezervací | plnění smlouvy; účetnictví |
| Bankovní pohyby – nespárované | {{DOBA_NESPAROVANE_POHYBY}} od zaúčtování | výmaz polí plátce (jméno, protiúčet, zpráva, surový záznam); částka a datum zůstávají | oprávněný zájem – párování plateb a vrácení omylem zaslané částky; § 31 zákona o účetnictví |
| Fronta e-mailů (`outbox`) a notifikace brány (`webhook_events`) | {{DOBA_FRONTY}} po odeslání / zpracování | výmaz obsahu; zůstává jen stav doručení / zpracování a identifikátor | minimalizace; doložení doručení |
| Záznam o odmítnutí obchodních sdělení / námitce (blokační seznam) | po dobu, kdy správce obchodní sdělení rozesílá | jen otisk e-mailu; po vypnutí funkce výmaz | čl. 21 odst. 3 GDPR; § 7 odst. 3 zákona o některých službách informační společnosti |
| Souhlas s obchodními sděleními (kde je vyžadován) | do odvolání; záznam o souhlasu 3 roky po skončení zasílání | po odvolání zasílání končí, záznam zůstává k prokázání | čl. 7 odst. 1 a 3 GDPR |
| Provozní, bezpečnostní a audit logy (nejvýše pseudonymizované identifikátory) | {{DOBA_LOGY}} | výmaz | oprávněný zájem – bezpečnost (čl. 32 GDPR) |
| Účty obsluhy | do zrušení správcem (deaktivace, výmaz po 30 dnech) | zrušení; audit log zůstává po {{DOBA_LOGY}} jako identifikátor bez jména | – |

### E. Platební toky a kdo v nich osobní údaje zpracovává

1. **Rezervační poplatek kartou:** muster (pro správce) založí platbu u brány {{PLATEBNI_BRANA}} s částkou, číslem rezervace a e-mailem zákazníka → zákazník zadá kartu na stránce brány (jen brána) → brána pošle notifikaci, muster ověří stav dotazem (pro správce). Zpracovatel nikdy nevidí údaje o kartě.
2. **Rezervační poplatek převodem nebo QR Platbou:** muster vygeneruje platební údaje a QR (standard SPAYD) → zákazník zaplatí ve své bance → muster čte pohyby na účtu správce u {{BANKA}} tokenem správce jen pro čtení a páruje podle variabilního symbolu (pro správce). Nespárované pohyby vidí jen obsluha správce.
3. **Kauce:** (a) hotově nebo terminálem správce na místě – muster eviduje jen částku, formu a vrácení; (b) preautorizací karty přes bránu při převzetí – muster založí blokaci, při vrácení ji uvolní nebo na pokyn obsluhy částečně strhne; údaje o kartě opět jen u brány.
4. **Vratky:** kartou přes bránu (refund), převodem odchozí platbou, kterou zadá správce sám ve své bance; muster jen eviduje.

---

## Příloha 2: Technická a organizační opatření (čl. 32 GDPR)

Stav k verzi {{VERZE}}. Zpracovatel opatření aktualizuje podle čl. 8.3; úroveň ochrany nesmí klesnout.

### A. Pseudonymizace a šifrování (čl. 32 odst. 1 písm. a))

1. **Přenos:** TLS 1.3 výchozí, TLS 1.2 povoleno, starší vypnuto; HSTS s `includeSubDomains`; přesměrování HTTP → HTTPS; certifikáty Let's Encrypt (jeden wildcard certifikát pro `*.{{DOMENA_MUSTERU}}`, takže názvy půjčoven nejsou v certifikátech ani ve veřejných CT lozích); CAA záznam, DNSSEC.
2. **Šifrování polí v databázi:** AES-256-GCM s unikátní nonce pro každou hodnotu; klíč mimo databázi (Docker secret / soubor s právy 600), verze klíče v každém záznamu, rotace klíčů (envelope DEK/KEK). Šifrována jsou: jméno, e-mail, telefon, adresa, typ a číslo dokladu, výrobní číslo kola, tajemství 2FA, token banky, přístupy k bráně.
3. **Pseudonymizace:** e-mail pro vyhledání jen jako HMAC otisk; IP adresy v logu a u souhlasů jen jako otisk; audit log obsahuje identifikátory, ne hodnoty.
4. **Hesla:** scrypt (N = 2^17, r = 8, p = 1) podle doporučení OWASP, bez horního limitu délky pod 64 znaků.
5. **Zálohy:** šifrované na straně zpracovatele před uložením do úložiště (restic; replikace Litestream do šifrovaného objektového úložiště); zálohy jsou **oddělitelné po instancích** (snímky restic označené identifikátorem instance, replika Litestream per databázový soubor), aby šel výmaz jedné instance provést i v zálohách (čl. 13.1 d)).
6. **Šifrovaný disk** serveru a úložišť (Hetzner).

### B. Důvěrnost, integrita, dostupnost a odolnost (čl. 32 odst. 1 písm. b))

7. **Izolace půjčoven:** jedna databáze (soubor) na půjčovnu, vlastní adresář souborů, vlastní klíče; identifikace instance výhradně z hostname; automatizované testy přístupu mezi instancemi v CI; cookies `__Host-` bez atributu `Domain`, takže neplatí napříč subdoménami; platforma na vlastním hostu.
8. **Autentizace a session:** dvoufázové ověření (TOTP nebo passkey) povinné pro admin i platformu včetně záložních kódů; ověření 2FA při změně hesla, e-mailu a vypnutí 2FA; serverové session s ≥ 64 bity entropie, cookie `Secure; HttpOnly; SameSite=Strict` (admin) / `Lax` (veřejná část), regenerace po přihlášení, nečinnost 30 min, absolutní platnost 8 h, odhlášení zneplatní session na serveru; zamykání účtu po opakovaných neúspěšných pokusech.
9. **Autorizace:** kontrola instance a role na každém koncovém bodu API (role vlastník/obsluha; platforma odděleně); odkazy pro zákazníky jako podepsané tokeny s expirací, žádná sekvenční ID v URL.
10. **Ochrana aplikace:** CSRF tokeny a kontrola `Origin` u všech měnících požadavků; CSP bez `unsafe-inline`; bezpečnostní hlavičky (`frame-ancestors`, `Referrer-Policy`, `X-Content-Type-Options`); serverová validace vstupů, parametrizované dotazy; rate limiting na přihlášení, reset hesla, rezervace a platby; chybové stránky bez technických detailů; vypnuté hlavičky identifikující software.
11. **Platby:** částky výhradně ze serveru; stav platby vždy ověřen dotazem na bránu, notifikace jen jako podnět; každá notifikace zpracována nejvýše jednou (`webhook_events`); idempotentní přechody stavů; účetní deník (ledger). Karty výhradně přes hostovanou stránku brány (PCI DSS SAQ A).
12. **Server a kontejnery:** aplikace běží pod neprivilegovaným uživatelem v kontejneru s read-only souborovým systémem; firewall jen porty 22/80/443; SSH jen klíčem; automatické bezpečnostní aktualizace OS; tajemství nikdy v repozitáři ani v proměnných prostředí kontejneru (Docker secrets).
13. **Dodavatelský řetězec:** aplikace bez npm závislostí, klientské knihovny vendorované s připnutou verzí a kontrolním součtem; kontrola obrazů kontejnerů (Trivy) a `npm audit` v CI s blokováním nasazení; nasazení jen z hlavní větve po úspěšných testech.
14. **Logování:** provozní log bez jmen, e-mailů, telefonů, hesel, tokenů a čísel dokladů; IP adresy jen jako otisk (HMAC s klíčem instance) nebo zkrácené (IPv4 /24, IPv6 /48); **access log reverzní proxy (Caddy)** je buď vypnutý, nebo nakonfigurovaný tak, že IP adresu před zápisem anonymizuje a neloguje query string ani cookies, s rotací a touž retencí; audit log append-only s omezeným přístupem, identifikátory místo hodnot; retence {{DOBA_LOGY}}; klíč otisků se maže spolu s instancí (čl. 13.3).
15. **Dostupnost:** monitoring dostupnosti ({{MONITORING_SLUZBA}}), průběžná replikace databází, snapshoty serveru, Caddy limity proti přetížení.
16. **Fyzická bezpečnost:** datová centra Hetzner ({{HETZNER_LOKALITA}}) s vlastními opatřeními, která Hetzner nechává každoročně nezávisle auditovat (TÜV Rheinland) a zprávu poskytuje zákazníkům se smlouvou o zpracování; zpracovatel nemá fyzický přístup a zprávu předává správci na žádost.

### C. Obnova dostupnosti (čl. 32 odst. 1 písm. c))

17. Průběžná replikace všech databází (point-in-time) a denní šifrovaná záloha dat (databáze, soubory, dokumenty) mimo produkční server; retence {{DOBA_ZALOHY}} (denní 7 dní, týdenní 4 týdny, měsíční 12 měsíců) u běžící instance; u zaniklé instance výmaz spolu s instancí, nejpozději do {{LHUTA_VYMAZU_ZALOH}} (čl. 13.1 d)); konzistentní snapshot databáze při záloze; obnova ze zálohy znovu spustí job „retence“, aby se neobnovily údaje mezitím smazané podle lhůt.
18. **Test obnovy** {{FREKVENCE_TESTU_OBNOVY}} na odděleném prostředí se záznamem (datum, rozsah, výsledek, doba obnovy); postup obnovy dokumentován.
19. Postup pro obnovu jedné instance bez dopadu na ostatní.

### D. Pravidelné testování a hodnocení (čl. 32 odst. 1 písm. d))

20. Automatizované testy při každém nasazení: jednotkové a API testy včetně souběhu, cross-instance, CSRF, session, hlavičky; bezpečnostní sken (OWASP ZAP baseline) proti stage; kontrola závislostí a obrazů.
21. Roční revize podle OWASP ASVS 5.0 (cíl: úroveň L1 celá, L2 pro autentizaci, session, kryptografii a přístupová práva), roční revize těchto opatření a právních dokumentů; sledování zranitelností použitých komponent.
22. Oddělená prostředí vývoj / stage / provoz; ve vývoji a na stage jen anonymizovaná nebo testovací data; sandbox bran.

### E. Organizační opatření

23. Individuální účty pro každou osobu u zpracovatele i správce; přidělení a odebrání přístupu dokumentováno; přehled přihlášení pro správce.
24. Pracovníci zpracovatele vázáni mlčenlivostí a poučeni; přístup k instanci správce jen na žádost nebo při incidentu, vždy zaznamenán (čl. 6.6).
25. **Plán reakce na incident:** kontakty obou stran (Příloha 4), kdo rozhoduje, kroky izolace a nápravy, šablona ohlášení správci do {{LHUTA_OHLASENI_INCIDENTU}}, podklady pro ohlášení ÚOOÚ do 72 h, interní evidence každého incidentu.
26. **Minimalizace:** žádné kopie dokladů, žádné karetní údaje, žádné marketingové ani analytické skripty ve výchozím stavu, mapa načítaná až po kliknutí; automatická retence.
27. Smlouvy o zpracování se všemi dalšími zpracovateli (Příloha 3) a jejich přezkum při každé změně.
28. Dokumentace: bezpečnostní dokumentace, postup nasazení a obnovy, záznamy o činnostech zpracování (čl. 30 odst. 2), záznamy o testech obnovy a incidentech.

### F. Shrnutí posouzení rizik (čl. 32 odst. 2)

| Riziko | Pravděpodobnost / dopad | Hlavní opatření |
|---|---|---|
| Únik databáze nebo zálohy | nízká / vysoký | šifrování polí s klíčem mimo DB, šifrované zálohy, oddělené DB |
| Přístup k datům jiné půjčovny | nízká / vysoký | DB per instance, hostname → instance, testy v CI, `__Host-` cookies |
| Kompromitace účtu obsluhy | střední / střední | 2FA povinné, rate limiting, zámek účtu, session timeouty, audit log |
| Kompromitace serveru | nízká / vysoký | minimální práva, bez závislostí, aktualizace, tajemství mimo prostředí, rotace klíčů, incident plán |
| Podvržení platby nebo dvojí zpracování | střední / střední | částky ze serveru, ověření stavu u brány, idempotence, ledger |
| Ztráta dat | nízká / vysoký | replikace, denní zálohy, test obnovy {{FREKVENCE_TESTU_OBNOVY}} |
| Únik přes logy nebo e-maily | nízká / střední | logy jen s otisky (bez přímých identifikátorů), anonymizace IP v access logu, e-maily jen nezbytný obsah, krátká retence fronty, EU poskytovatel |
| Chyba obsluhy (vložení zakázaných údajů) | střední / střední | žádná funkce pro kopie dokladů, poučení, kontrola na výzvu |

---

## Příloha 3: Seznam dalších zpracovatelů

### A. Další zpracovatelé zpracovatele (obecné povolení podle čl. 9.1)

| Další zpracovatel | Služba a rozsah údajů | Umístění | Záruky |
|---|---|---|---|
| **Hetzner Online GmbH**, Industriestraße 25, 91710 Gunzenhausen, Německo (HRB 6089 Ansbach) | hosting virtuálního serveru, objektové úložiště a Storage Box pro zálohy; všechna data instance v šifrované podobě na disku a v zálohách; Hetzner k obsahu nepřistupuje, pracuje s infrastrukturou | datová centra {{HETZNER_LOKALITA}}; Hetzner DPA § 3 odst. 1: zpracování výhradně v EU/EHP, předání do třetí země jen s předchozím souhlasem zákazníka | smlouva o zpracování podle čl. 28 GDPR (Hetzner DPA v1.1, 10. 2. 2025) uzavřená v zákaznickém účtu zpracovatele; opatření (TOM) každoročně nezávisle auditována (TÜV Rheinland), zpráva poskytována zákazníkům s DPA; jmenovaný pověřenec (data-protection@hetzner.com); subdodavatelé Hetzner uvedeni v příloze 3 jeho DPA, změny oznamuje s lhůtou námitky 14 dnů |
| **{{EMAIL_SLUZBA_NAZEV}}**, {{EMAIL_SLUZBA_SIDLO}} – *placeholder, poskytovatel bude doplněn po rozhodnutí (PLAN.md kap. 15 bod 4)* | odesílání transakčních e-mailů jménem správce (adresa a jméno příjemce, obsah zprávy: potvrzení rezervace, doklady, připomínky, storno); krátkodobé uchování pro doručení a stav doručení (bounce) | {{EMAIL_SLUZBA_LOKALITA}} (musí být EU/EHP, jinak postup podle čl. 10.3) | smlouva o zpracování podle čl. 28 GDPR uzavřená zpracovatelem; žádné sledování otevření ani kliknutí |
| **{{EMAIL_SLUZBA_ZALOZNI}}** – *záložní poskytovatel pro naléhavý případ (čl. 9.4)* | totéž jako u hlavního poskytovatele e-mailů; použije se jen při výpadku, ukončení služby nebo incidentu u hlavního poskytovatele; o přepnutí zpracovatel informuje do 5 pracovních dnů | EU/EHP (podmínka zařazení) | smlouva o zpracování podle čl. 28 GDPR uzavřená zpracovatelem předem, aby bylo přepnutí možné bez prodlení; žádné sledování otevření ani kliknutí |
{{#MONITORING_SLUZBA}}| **{{MONITORING_SLUZBA}}** – *volitelně* | kontrola dostupnosti veřejné adresy {{WEB_SUBDOMENA}}; získává jen stav odpovědi a dobu odezvy, žádné osobní údaje zákazníků (používá-li se jen interní Uptime Kuma na serveru zpracovatele, řádek se nevykreslí) | – | není-li přístup k osobním údajům, nejde o dalšího zpracovatele; uveden pro transparentnost |{{/MONITORING_SLUZBA}}

### B. Subjekty, které nejsou dalšími zpracovateli (vysvětlení v čl. 9.6)

| Subjekt | Role | Kdo má smlouvu |
|---|---|---|
| Platební brána {{PLATEBNI_BRANA}} | poskytovatel platebních služeb správce; samostatný správce platebních a karetních údajů (resp. zpracovatel správce podle vlastní smlouvy) | správce |
| {{BANKA}} | banka správce; samostatný správce; muster čte pohyby tokenem správce jen pro čtení | správce |
| Účetní správce, pojišťovna, Policie ČR | příjemci na straně správce; muster jim nic nepředává | správce |
| Let's Encrypt (ISRG), {{DNS_POSKYTOVATEL}}, registrátor domény | certifikáty a DNS pro doménu musteru; žádné osobní údaje zákazníků | zpracovatel |
| Mapy.cz (Seznam.cz, a.s.), CyclOSM | mapové dlaždice načítané prohlížečem návštěvníka po kliknutí; samostatný správce IP adresy návštěvníka | nikdo (uvést v Zásadách správce) |

---

## Příloha 4: Kontaktní osoby a šablona ohlášení incidentu

### A. Kontakty

| | Správce | Zpracovatel |
|---|---|---|
| Smluvní záležitosti a pokyny | {{PUJCOVNA_EMAIL}} | {{PROVOZOVATEL_EMAIL}} |
| Hlášení incidentů (nepřetržitě) | {{PUJCOVNA_INCIDENT_KONTAKT}} | {{PROVOZOVATEL_INCIDENT_KONTAKT}} |
| Pověřenec pro ochranu osobních údajů | {{#PUJCOVNA_DPO}}{{PUJCOVNA_DPO}}{{/PUJCOVNA_DPO}}{{^PUJCOVNA_DPO}}nejmenován{{/PUJCOVNA_DPO}} | {{#PROVOZOVATEL_DPO}}{{PROVOZOVATEL_DPO}}{{/PROVOZOVATEL_DPO}}{{^PROVOZOVATEL_DPO}}nejmenován{{/PROVOZOVATEL_DPO}} |
| Dozorový úřad | Úřad pro ochranu osobních údajů, Pplk. Sochora 27, 170 00 Praha 7, www.uoou.gov.cz, datová schránka qkbaa2n; ohlášení porušení zabezpečení online formulářem úřadu | |

### B. Šablona ohlášení incidentu správci (čl. 12.2–12.3)

```
Předmět: [INCIDENT] {{WEB_SUBDOMENA}} – <stručný název> – ohlášení č. <n> (první / doplnění / závěrečné)

1. Čas vzniku (pokud známo) a čas zjištění zpracovatelem:
2. Co se stalo (povaha porušení: důvěrnost / integrita / dostupnost):
3. Dotčené údaje – kategorie a přibližný počet zákazníků a záznamů:
4. Byly dotčené údaje šifrované? Byl kompromitován klíč?
5. Pravděpodobné důsledky pro zákazníky:
6. Již přijatá opatření:
7. Navrhovaná další opatření a odhad času:
8. Jsou dotčeny i jiné instance (ano/ne, bez identifikace):
9. Doporučení zpracovatele k ohlášení ÚOOÚ (72 h od zjištění správcem) a k informování zákazníků (čl. 34) – rozhodnutí je na správci:
10. Kontaktní osoba zpracovatele pro tento incident (jméno, telefon, e-mail):
11. Další aktualizace do: <čas>
```

---

## K ověření advokátem

Body, u kterých si nejsme jisti právní kvalifikací, nebo kde záleží na rozhodnutí půjčovny či zadavatele. Číslování odkazuje na články smlouvy. Nálezy dvou oponentur (právo ČR; GDPR a praktičnost) z 5. 10. 2026 jsou v textu zapracovány; zde zůstává jen to, co je sporné nebo vyžaduje rozhodnutí.

**Forma, hlavní smlouva, struktura**

1. **Uzavření potvrzením v platformě (čl. 18.1).** Opíráme se o čl. 28 odst. 9 GDPR, § 561 odst. 1 a § 562 odst. 1 a 2 OZ a § 7 ZSDEP (mezi soukromoprávními subjekty lze použít „jiný typ elektronického podpisu“ – potvrzení přihlášeným uživatelem s uvedením jména). Judikatura krajských soudů k tomu, zda § 562 odst. 1 OZ nahrazuje podpis u elektronického právního jednání, je nejednotná. Ověřit: (a) zda potvrzení účtem s rolí „vlastník“ s 2FA dostatečně určuje jednající osobu a její oprávnění za právnickou osobu, nebo zda u právnických osob vyžadovat podpis dokumentu (vlastnoruční / zaručený elektronický); (b) zda vedení záznamů o uzavření v append-only audit logu stačí pro domněnku spolehlivosti podle § 562 odst. 2 OZ („systematicky, posloupně, chráněné proti změnám“).
2. **Hlavní smlouva neexistuje (čl. 1.1, 1.4, {{HLAVNI_SMLOUVA}}).** Obchodní model musteru (jednorázová cena + provoz, nebo předplatné) je otevřená otázka PLAN.md kap. 15 bod 3. Tato smlouva na hlavní smlouvu odkazuje (odměna, výpověď, odpovědnost); je potřeba ji napsat a sladit: výpovědní doby (včetně {{VYPOVEDNI_DOBA_ZMENA}} při odmítnutí nové verze, čl. 18.2 c)), cenu, dostupnost (SLA), odpovědnost. Do té doby lze oba dokumenty spojit do jednoho.
3. **Limit odpovědnosti (čl. 15.4, {{LIMIT_ODPOVEDNOSTI}}).** Výše je rozhodnutí zadavatele (návrh: odměna za 12 měsíců s minimem). Ověřit: (a) **§ 2898 věta druhá OZ** – půjčovna (malý podnikatel, který formulářovou smlouvu nemůže vyjednávat a uzavírá ji potvrzením v platformě) může být i v B2B vztahu slabší stranou (§ 433 OZ) a limit by se vůči ní vůbec nepoužil; text to přiznává dovětkem a potvrzením správce, že měl možnost znění projednat. Zvážit (i) přiměřenou minimální částku limitu, (ii) oboustranné nastavení limitu, (iii) zda potvrzení v čl. 15.4 a postup čl. 18.1 (zobrazení celého textu, možnost zaslat návrhy změn) na kvalifikaci slabší strany něco mění; (b) zda lze smluvně omezit regres podle čl. 82 odst. 5 GDPR – dovětek „v rozsahu, ve kterém ho GDPR nedovoluje omezit“ je záměrně opatrný; (c) **náhrada pokuty dozorového úřadu (čl. 15.3)** je pojata jako škoda z porušení smlouvy (§ 2913 odst. 1 OZ) s nutností prokázat příčinnou souvislost, nikoli jako smluvní přenos veřejnoprávní sankce – ověřit přípustnost vůči osobní povaze správního trestu (§ 1 odst. 2, § 580 OZ) a zda má limit dopadat i na ni; (d) § 1798–1801 OZ – formulářová smlouva předkládaná zpracovatelem; mezi podnikateli se ochrana adhezních smluv neuplatní, pokud doložka hrubě neodporuje obchodním zvyklostem (§ 1801 OZ) – posoudit limit a jednostranné změny (bod 15) z tohoto pohledu.
4. **Smluvní pokuta (čl. 15.5).** Nesjednána – rozhodnutí zadavatele. GDPR ji neupravuje, ale praxe ji doporučuje (např. za neohlášení incidentu ve lhůtě, zapojení podzpracovatele bez oznámení). Pokud by ji zadavatel chtěl, sjednat s ohledem na § 2048, § 2050 (pokuta vylučuje náhradu škody, není-li ujednáno jinak) a § 2051 OZ (moderace); doporučujeme výslovně „vedle náhrady škody“.
5. **Půjčovna, která není podnikatelem (čl. 1.6, 18.1).** Spolek ani obec nejsou spotřebitelé (§ 419 OZ, § 2 odst. 1 písm. a) ZOS) – ZOS a § 1810 a násl. OZ se na ně nepoužijí nikdy. Je-li však půjčovna nepodnikatelem (spolek, obec, příspěvková organizace), neuplatní se výjimka § 1801 OZ a adhezní režim §§ 1798–1800 OZ dopadá v plném rozsahu – zejména na limit odpovědnosti (čl. 15.4), zpoplatnění součinnosti (čl. 11.3, 14.4), jednostranné změny (čl. 18.2 c)) a dobíhání záloh (čl. 13.1 d)); vedle toho ochrana slabší strany (§ 433, § 630 odst. 2, § 2898 věta druhá OZ). Návrh: onboarding u takové půjčovny vynutí podpis dokumentu a potvrzení o seznámení s přílohami (čl. 1.6, 18.1). Ověřit, zda to stačí (§ 1799 OZ – doložka odkazující mimo text platí jen při prokázaném seznámení; § 1800 OZ – nesrozumitelné nebo zvláště nevýhodné doložky), nebo zda pro nepodnikatele připravit variantu bez limitu odpovědnosti a bez zpoplatnění součinnosti.

**Další zpracovatelé a partneři**

6. **Obecné povolení, lhůta námitky a záložní podzpracovatelé (čl. 9.1–9.4, Příloha 3 A).** Ověřit, že 30denní oznámení + 14denní námitka + právo výpovědi bez sankce vyhovuje čl. 28 odst. 2 GDPR a praxi ÚOOÚ (vyjádření ke cloudu požaduje kontrolu a schvalování podzpracovatelů správcem). Naléhavou změnu jsme omezili na záložního dalšího zpracovatele předem uvedeného v Příloze 3 A ({{EMAIL_SLUZBA_ZALOZNI}}) – ověřit, že předem uvedený „záložník“ je krytý obecným povolením i tehdy, když se k němu data dostanou až po měsících, a že smlouva podle čl. 28 odst. 4 s ním má být uzavřena předem (návrh: ano). Hetzner oznamuje změny svých subdodavatelů s lhůtou **14 dnů** (jeho DPA § 7 odst. 3) – kratší než naše lhůta; řešíme přeposláním bez zbytečného odkladu (čl. 9.5). Posoudit, zda to stačí, nebo zda lhůtu oznámení zkrátit na 14 dnů.
7. **Platební brána a banka jako „ne-podzpracovatelé“ (čl. 9.6 a), b), Příloha 3 B).** Kvalifikace: brána = samostatný správce (regulovaný poskytovatel platebních služeb) nebo zpracovatel půjčovny podle smlouvy brány s půjčovnou; banka = samostatný správce. Zpracovatel se jich účastní jen tím, že na pokyn půjčovny zakládá platby a čte výpisy. Ověřit, zda (a) založení platby s e-mailem zákazníka u brány není „předáním“ vyžadujícím zvláštní úpravu, (b) čtení bankovních výpisů s údaji třetích osob (plátců) je dostatečně pokryto popisem v Příloze 1 jako zpracování pro správce a zda správce vůči plátcům – třetím osobám plní informační povinnost podle čl. 14 GDPR (návrh: text v Zásadách, odd. „Platby převodem“), (c) není třeba, aby půjčovna měla s bránou vlastní zpracovatelskou smlouvu (většina bran má DPA v obchodních podmínkách – zkontrolovat u {{PLATEBNI_BRANA}}).
8. **E-mailová služba a Mapy.cz.** Poskytovatel e-mailů je placeholder; pokud zadavatel zvolí poskytovatele mimo EU (Postmark, Resend), je nutné doplnit záruku podle čl. 46 GDPR (SCC / Data Privacy Framework) a Přílohu 3. Mapy.cz kvalifikujeme jako samostatného správce IP adresy návštěvníka (dlaždice načítá prohlížeč po kliknutí) – ověřit, zda není vhodnější uvést Seznam.cz jako příjemce v Zásadách s odkazem na jeho podmínky a zda „načtení až po kliknutí“ je dostatečný základ bez souhlasu (§ 89 odst. 3 ZEK se týká ukládání do zařízení, nikoli samotného HTTP požadavku).

**Zabezpečení, incidenty, výmaz**

9. **Zálohy (čl. 13.1 d), {{DOBA_ZALOHY}}, {{LHUTA_VYMAZU_ZALOH}}).** Po zapracování: zálohy zaniklé instance se mažou spolu s instancí (snímky restic označené instancí, replika Litestream per databáze), 30denní lhůta je jen záložní pro případ, že některou sadu nelze smazat výběrově; 12měsíční retence zůstává u běžících instancí (shodně se Zásadami). Ověřit: (a) že 30denní dobíhání obstojí vůči čl. 28 odst. 3 písm. g) GDPR a praxi ÚOOÚ/EDPB; (b) že 12 měsíců u běžící instance je přijatelné řešení práva na výmaz (čl. 17), když se zálohy nepoužívají k běžnému zpracování a obnova ze zálohy znovu spustí job „retence“ (Příloha 2 bod 17); (c) zda má snapshot celého serveru u Hetzner podléhat stejné lhůtě.
10. **Lhůta 24 h (čl. 12.2).** Je přísnější než „bez zbytečného odkladu“ (čl. 33 odst. 2). Ověřit formulaci „od okamžiku, kdy se o něm dozvěděl“ – zda se má počítat od důvodného podezření, a zda chceme rozlišit „podezření“ (24 h) a „potvrzení“ (doplnění). Zvážit, zda smlouva má řešit i výpadek služby bez dopadu na data (to patří do SLA hlavní smlouvy).
11. **Break-glass přístup (čl. 6.6).** Přístup pracovníka zpracovatele při incidentu bez předchozího pokynu správce opíráme o pokyn daný touto smlouvou. Ověřit, zda to stačí jako „doložený pokyn“ podle čl. 29 GDPR, nebo zda má systém vyžadovat zpětné potvrzení správcem u každého takového přístupu.
12. **Audit na sdílené infrastruktuře (čl. 14.2–14.4).** Omezení četnosti (1× ročně), formy (bez přístupu k OS a cizím instancím) a zpoplatnění nad 4 hodiny – posoudit přiměřenost vůči čl. 28 odst. 3 písm. h) GDPR; Hetzner DPA § 8 má obdobné limity (1× ročně, náklady). Ověřit, že nahrazení fyzické kontroly datového centra certifikacemi a audit reportem Hetzner je přijatelné.
13. **Doklady při žádosti o výmaz (čl. 11.1 c), Příloha 1 D) – ověřit s daňovým poradcem.** Zapracováno rozlišení podle typu dokladu: plátce nemusí vystavit daňový doklad spotřebiteli (§ 28 odst. 1 ZDPH) a do 10 000 Kč stačí zjednodušený daňový doklad bez označení příjemce (§ 30, § 30a ZDPH; zadavatel 5. 10. 2026 rozhodl, že půjčovny-plátci ho do 10 000 Kč vystavují, nad to běžný doklad – parametr `REZIM_DOKLADU` v OP a Zásadách) – u takových dokladů lze jméno a adresu anonymizovat bez kolize s § 29 ZDPH; identifikaci příjemce ponecháváme (a výmaz odmítáme podle čl. 17 odst. 3 písm. b) GDPR) jen u dokladů s IČO/DIČ příjemce nebo nad 10 000 Kč. Ověřit: (a) zda anonymizace jména na dokladu pro spotřebitele neodporuje náležitostem účetního dokladu (§ 11 odst. 1 písm. b) zákona o účetnictví – „účastníci“ účetního případu; navrhujeme, že účastníka dostatečně určuje číslo rezervace a smlouvy); (b) zda doklad k přijaté platbě (záloha) sdílí režim konečného dokladu; (c) zda hranici 10 000 Kč posuzovat za doklad, nebo za plnění (§ 30 odst. 1 ZDPH). Výsledné pravidlo promítnout do funkce v adminu.
14. **Zbytkové údaje zpracovatele po skončení (čl. 13.3).** Logy s otisky ponecháváme po {{DOBA_LOGY}} s tím, že klíč HMAC instance se smaže spolu s instancí, takže otisky už nelze přiřadit k osobě (recital 26 GDPR). Ověřit, že smazání klíče postačí k tomu, aby zbývající otisky nebyly osobními údaji v rukou zpracovatele, a zda evidence incidentů bez seznamů dotčených osob po 5 let (čl. 33 odst. 5 GDPR; srov. čl. 17 odst. 3 písm. e)) je přiměřená.

**Role, dokumenty, předpisy**

15. **Jednostranné změny (čl. 8.3, 18.2).** Čl. 18.2 c) nyní obsahuje náležitosti § 1752 odst. 1 OZ: ujednaný rozsah a důvody změn, zákaz zhoršení v odpovědnosti, odměně a lhůtách bez souhlasu, oznámení {{LHUTA_OZNAMENI_ZMENY_SMLOUVY}} předem, právo odmítnout a vypovědět s výpovědní dobou {{VYPOVEDNI_DOBA_ZMENA}} bez sankce, po dobu výpovědní doby platí dosavadní verze. Ověřit: (a) zda je výpovědní doba dostatečná „k obstarání obdobných plnění od jiného dodavatele“ (přenos webu a rezervačního systému trvá týdny až měsíce); (b) pravidlo pro nečinnost správce – návrh „neodmítne-li do účinnosti, platí za přijatou; systém ji zobrazí k potvrzení při prvním přihlášení“ (odpovídá konstrukci § 1752) oproti přísnější variantě „bez výslovného potvrzení zůstává stará verze a zpracovatel může hlavní smlouvu vypovědět“ – rozhodnutí zadavatele; (c) aktualizace Přílohy 2 bez souhlasu („nesníží-li úroveň“); (d) vazba na § 1801 OZ (bod 3 d) a na nepodnikatele (bod 5). Příloha 3 se mění postupem čl. 9 – to GDPR výslovně připouští.
16. **Role u údajů obsluhy půjčovny (čl. 1.5, Příloha 1 B).** Účty obsluhy (e-mail, hash hesla, tajemství 2FA) zpracovává zpracovatel pro správce; zároveň je provozovatel samostatným správcem kontaktních osob půjčovny pro smlouvu a fakturaci. Ověřit, že rozdělení je udržitelné a že informační povinnost (čl. 13) vůči obsluze plní správce (zaměstnavatel) – návrh to předpokládá.
17. **Záznamy o činnostech (čl. 14.5).** Výjimka pro méně než 250 zaměstnanců se podle rešerše 03 neuplatní (zpracování není příležitostné); zpracovatel vede záznamy podle čl. 30 odst. 2. Ověřit, zda generovaný záznam pro správce může být „předvyplněný“ zpracovatelem, nebo zda ho musí správce aktivně schválit (návrh: schválení v adminu).
18. **Nový zákon o účetnictví.** Všechny citované paragrafy byly ověřeny z primárního zdroje (úvod dokumentu). Zákon č. 563/1991 Sb. platí ve znění účinném od 1. 1. 2026; nový zákon o účetnictví je v Poslanecké sněmovně (1. čtení 12. 3. 2026), navržená účinnost 1. 1. 2028, reálně i později. Po vyhlášení zkontrolovat čísla paragrafů (§ 11 a § 31 zákona o účetnictví v čl. 11.1 c), 13.2 a Příloze 1 D) a lhůty uchování.
19. **Žádosti orgánů veřejné moci (čl. 6.4).** Postup „informovat správce předem, ledaže to právo zakazuje“ – ověřit vůči trestnímu řádu (§ 7b, § 8 – vydání dat) a zda zpracovatel smí zdržet vydání do informování správce.
20. **DPIA (čl. 12.6).** Tvrdíme, že pro běžnou půjčovnu není povinná. Ověřit vůči seznamu operací podléhajících DPIA zveřejněnému ÚOOÚ (zejména kritéria: zpracování dokladů totožnosti, platby, větší počet subjektů) – pokud by DPIA byla povinná, muster by měl generovat podklad.
21. **Vzdálený přístup z území mimo EU/EHP (čl. 10.1).** Závazek, že pracovníci zpracovatele přistupují jen z EU/EHP, je přísný (práce na cestách). Ověřit, zda stačí přístup přes VPN s koncovým bodem v EU, nebo zda je nutné předání podle kapitoly V GDPR i při pouhém nahlédnutí.
22. **Doména musteru ({{DOMENA_MUSTERU}}).** Zadání uvádí `pujcovna.cz`; registr CZ.NIC ji vede jako obsazenou (rešerše 07). Placeholder umožňuje dosadit zvolenou doménu (doporučení `rezervacekol.cz`); po rozhodnutí zadavatele sjednotit ve všech dokumentech v `legal/`.

**Lhůty a daňové doklady (nové po oponentuře)**

23. **Retence smluv a protokolů ({{DOBA_SMLOUVA}}, Příloha 1 D).** Lhůta běží od skončení nájmu nebo od vypořádání poslední pohledávky (§ 619 OZ), rozsah parametru je omezen na 3–4 roky a delší uchování řeší příznak „spor“ na rezervaci (do pravomocného skončení, nejdéle 10 let – § 629 odst. 2, § 636 odst. 1 OZ). Ověřit, že blokování anonymizace u rezervace s otevřenou pohledávkou obstojí jako oprávněný zájem bez dalšího balančního testu, a zda horní hranici vázat na § 629 odst. 2 OZ (10 let), nebo u úmyslně způsobené škody na § 636 odst. 2 OZ (15 let).
24. **Daňové doklady uchovávané na serveru v Německu (čl. 13.5, Příloha 1 A) – jen plátce DPH.** Ukládáme správci povinnost předem oznámit správci daně místo uchovávání mimo tuzemsko (§ 35 odst. 3 a 4 ZDPH) a zpracovateli součinnost při kontrole (§ 35a odst. 4 ZDPH). Ověřit: (a) zda hosting s nepřetržitým dálkovým přístupem je „místem uchovávání mimo tuzemsko“ podléhajícím oznámení podle § 35 odst. 4, nebo zda oznamovací povinnost odpadá, uchovává-li se způsobem umožňujícím dálkový přístup (§ 35 odst. 3 věta druhá), a zda má muster generovat vzor oznámení; (b) zda obdobný požadavek dopadá i na neplátce – účetní jednotku (§ 33 zákona o účetnictví, průkaznost účetních záznamů) – pasáž zobrazujeme jen plátci.
25. **Nové retenční lhůty ({{DOBA_NESPAROVANE_POHYBY}}, {{DOBA_FRONTY}}, blokační seznam) – rozhodnutí zadavatele.** Výchozí hodnoty (12 měsíců u nespárovaných bankovních pohybů, 90 dní u fronty e-mailů a notifikací brány, blokační seznam otisků po dobu rozesílání) jsou náš návrh. Ověřit oporu u nespárovaných pohybů (oprávněný zájem na párování a vrácení omylem zaslané částky vs. § 31 zákona o účetnictví, je-li pohyb účetním případem) a u „trvalého“ blokačního seznamu (čl. 21 odst. 3 GDPR vs. zásada omezení uložení).
26. **Výchozí doba uchování dokladů u neplátce ({{DOBA_DOKLADY}}).** U neplátce vedoucího daňovou evidenci neumí systém zjistit lhůtu pro stanovení daně (§ 148 DŘ – 3 roky, prodlužovaná úkony správce daně, nejdéle 10 let); navrhujeme výchozích 5 let s možností změny. Ověřit, zda je 5 let obhajitelný kompromis, nebo zda nabízet 3 roky s upozorněním.
