# Záznamy o činnostech zpracování dle čl. 30 GDPR (šablona pro půjčovnu jako správce a pro provozovatele jako zpracovatele)

> **Návrh připravený jako podklad; před použitím vyžaduje kontrolu advokátem.** Advokátní kontrolu zajišťuje zadavatel; sporné body a body vyžadující rozhodnutí jsou v oddílu „K ověření advokátem“ na konci.

Verze {{VERZE}}, platná od {{UCINNOST_OD}}, poslední revize {{DATUM_REVIZE}}. **Interní dokument** – nezveřejňuje se, předkládá se na vyžádání Úřadu pro ochranu osobních údajů (čl. 30 odst. 4 GDPR). Aplikace ho generuje předvyplněný z nastavení půjčovny; půjčovna ho doplní o činnosti, které v systému neběží (oddíl A.7).

<!-- INTERNI: nerenderovat -->

## Parametry

Všechny proměnné údaje jsou zapsány jako `{{NAZEV_PARAMETRU}}`. Aplikace je při generování nahradí hodnotami z nastavení půjčovny a z nastavení platformy. Bloky **[při … = …]** a **[VARIANTA …]** se zobrazí jen při uvedené hodnotě parametru. Názvy parametrů jsou shodné se Zásadami ochrany osobních údajů, Obchodními podmínkami a smlouvou o nájmu; kde zpracovatelská smlouva používá jiný název, je uveden ve sloupci Význam – generátor obě jména mapuje na **jednu hodnotu** v nastavení, nic se neopisuje dvakrát. Sloupec „Zdroj“ říká, který dokument hodnotu určuje.

| Parametr | Význam | Zdroj | Výchozí hodnota / návrh |
|---|---|---|---|
| `{{PUJCOVNA_NAZEV}}` | Obchodní firma / jméno podnikatele provozujícího půjčovnu (správce) | nastavení půjčovny | – (povinné) |
| `{{PUJCOVNA_ICO}}` | IČO půjčovny | nastavení půjčovny | – (povinné) |
| `{{PLATCE_DPH}}` | Je půjčovna plátcem DPH? (ano / ne) – řídí varianty vět o daňových dokladech v A2 | nastavení půjčovny (shodně s OP a Zásadami) | ne |
| `{{PUJCOVNA_DIC}}` | DIČ půjčovny – zobrazí se jen při `{{PLATCE_DPH}}` = ano | nastavení půjčovny | – (volitelný – skryje se) |
| `{{REZIM_DOKLADU}}` | Jak půjčovna vede evidenci: `ucetnictvi` (účetní jednotka podle zákona č. 563/1991 Sb.) nebo `danova-evidence` (§ 7b zákona o daních z příjmů, případně paušální daň) – řídí lhůty uchování dokladů v A2 | nastavení půjčovny (shodně se Zásadami) | danova-evidence |
| `{{PUJCOVNA_SIDLO}}` | Sídlo půjčovny | nastavení půjčovny | – (povinné) |
| `{{PUJCOVNA_PROVOZOVNA}}` | Adresa provozovny, kde se kola vydávají a vracejí (a kde jsou případné listinné smlouvy) | nastavení půjčovny | shodná se sídlem |
| `{{PUJCOVNA_EMAIL}}` | Kontaktní e-mail půjčovny (i pro uplatnění práv subjektů) | nastavení půjčovny | – (povinné) |
| `{{PUJCOVNA_TELEFON}}` | Telefon půjčovny | nastavení půjčovny | – (volitelný – skryje se) |
| `{{PUJCOVNA_ODPOVEDNA_OSOBA}}` | Osoba v půjčovně odpovědná za ochranu osobních údajů (není pověřencem podle čl. 37 GDPR, jen interní kontakt) | nastavení půjčovny | majitel / jednatel |
| `{{PUJCOVNA_POCET_OSOB}}` | Počet osob, které půjčovna zaměstnává (pro oddíl 1) | nastavení půjčovny | např. 3 |
| `{{DOMENA_MUSTERU}}` | Hlavní doména platformy, pod kterou běží subdomény půjčoven | nastavení platformy (shodně se zpracovatelskou smlouvou a Zásadami) | pujcovna.cz *(dle zadání; doména je obsazená, rešerše doporučuje rezervacekol.cz – konečný výběr je na zadavateli)* |
| `{{WEB_SUBDOMENA}}` | Adresa webu půjčovny ve tvaru `<nazev-stavajiciho-webu>.{{DOMENA_MUSTERU}}` (Hotel U Tří dubů s webem utridubu.cz → utridubu.pujcovna.cz) | odvozeno | *(příklad)* `utridubu.pujcovna.cz` |
| `{{PODMINKY_URL}}` | Adresa Obchodních podmínek | odvozeno | `https://{{WEB_SUBDOMENA}}/podminky` |
| `{{ZASADY_URL}}` | Adresa Zásad ochrany osobních údajů (obsahují balanční testy, na které se tento záznam odkazuje) | odvozeno | `https://{{WEB_SUBDOMENA}}/soukromi` |
| `{{PROVOZOVATEL_NAZEV}}` | Provozovatel platformy – zpracovatel podle čl. 28 GDPR | nastavení platformy | – (povinné) |
| `{{PROVOZOVATEL_ICO}}` | IČO provozovatele platformy | nastavení platformy | – (povinné) |
| `{{PROVOZOVATEL_SIDLO}}` | Sídlo provozovatele platformy | nastavení platformy | – (povinné) |
| `{{PROVOZOVATEL_EMAIL}}` | Kontakt na provozovatele (technické dotazy, bezpečnostní incidenty) | nastavení platformy | – (povinné) |
| `{{PROVOZOVATEL_ODPOVEDNA_OSOBA}}` | Osoba u provozovatele odpovědná za ochranu údajů a incidenty | nastavení platformy | – |
| `{{SMLOUVA_ZPRACOVANI_DATUM}}` | Datum uzavření Smlouvy o zpracování osobních údajů (čl. 28 odst. 3 GDPR) mezi půjčovnou a provozovatelem (ve zpracovatelské smlouvě `{{DATUM_UZAVRENI}}`) | onboarding | datum onboardingu |
| `{{HOSTING_NAZEV}}` | Poskytovatel serverů a úložiště záloh (podzpracovatel provozovatele) | nastavení platformy (shodně se Zásadami; zpracovatelská smlouva: Příloha 3 + `{{HETZNER_LOKALITA}}`) | „Hetzner Online GmbH, datová centra v Německu a Finsku (EU)“ |
| `{{EMAIL_SLUZBA_NAZEV}}` | Poskytovatel odesílání transakčních e-mailů (podzpracovatel provozovatele) | nastavení platformy (shodně se zpracovatelskou smlouvou) | doplní provozovatel po rozhodnutí (kandidáti s provozem v EU: Mailgun EU, Brevo) |
| `{{DNS_POSKYTOVATEL}}` | Poskytovatel DNS pro `{{DOMENA_MUSTERU}}` – **není podzpracovatelem**, osobní údaje zákazníků nedostává (uveden v B.4 jen pro úplnost) | zpracovatelská smlouva | Cloudflare v režimu DNS-only nebo Hetzner DNS |
| `{{PLATEBNI_BRANA_NAZEV}}` | Platební brána pro karetní platby a preautorizace kauce (samostatný správce); ve zpracovatelské smlouvě `{{PLATEBNI_BRANA}}` | nastavení půjčovny (shodně s OP a Zásadami) | „ComGate Payments, a.s.“ |
| `{{TERMINAL_POSKYTOVATEL}}` | Poskytovatel platebního terminálu na provozovně (acquirer), pokud půjčovna přijímá kauci a doplatek kartou na místě (samostatný správce) | nastavení půjčovny (shodně se Zásadami) | „—“ (volitelný – skryje se) |
| `{{BANKA_NAZEV}}` | Banka půjčovny, z jejíhož rozhraní systém načítá příchozí platby (samostatný správce); ve zpracovatelské smlouvě `{{BANKA}}` | nastavení půjčovny (shodně se Zásadami) | „Fio banka, a.s.“ |
| `{{UCETNI_NAZEV}}` | Externí účetní nebo daňový poradce půjčovny | nastavení půjčovny (shodně se Zásadami) | „externí účetní půjčovny“ (volitelný – skryje se) |
| `{{UCETNI_ROLE}}` | Role účetní/ho: `zpracovatel` (externí účetní se smlouvou podle čl. 28) nebo `samostatný správce` (daňový poradce) | nastavení půjčovny (shodně se Zásadami) | zpracovatel |
| `{{POJISTOVNA_NAZEV}}` | Pojišťovna, pokud má půjčovna kola pojištěná | nastavení půjčovny (shodně se Zásadami; v OP text `{{POJISTENI}}`) | „—“ (volitelný – skryje se) |
| `{{MAPOVE_PODKLADY}}` | Poskytovatelé mapových dlaždic načítaných až po kliknutí na mapu | nastavení platformy (shodně se Zásadami) | „Seznam.cz, a.s. (Mapy.cz) a CyclOSM (OpenStreetMap France)“ |
| `{{ANALYTIKA_NASTROJ}}` | Analytický nástroj s cookies, pokud ho půjčovna zapne (jinak se činnost A10 a související řádky nezobrazí) | nastavení půjčovny (shodně se Zásadami) | „nepoužívá se“ (volitelný – skryje se) |
| `{{ANALYTIKA_POSKYTOVATEL}}` | Poskytovatel analytického nástroje (název, sídlo, role: zpracovatel / samostatný správce) | nastavení půjčovny (shodně se Zásadami) | – (volitelný – skryje se) |
| `{{GPS_LOKATORY}}` | Jsou kola vybavena GPS lokátorem? (ne / ano) – při „ano“ je nutné posouzení vlivu (čl. 35) a doplnění samostatné činnosti do tohoto záznamu (A.7) | nastavení půjčovny (shodně se Zásadami) | ne |
| `{{POPLATEK_KOLO}}` | Rezervační poplatek za jedno kolo (Kč), fixní, započítává se na cenu | nastavení půjčovny (shodně s OP) | 300 |
| `{{POPLATEK_EKOLO}}` | Rezervační poplatek za jedno elektrokolo (Kč), fixní, započítává se na cenu | nastavení půjčovny (shodně s OP) | 500 |
| `{{KAUCE_KOLO}}` | Vratná kauce za kolo (Kč) – jedna hodnota pro OP, protokol, Zásady, zpracovatelskou smlouvu i tento záznam | nastavení půjčovny (shodně s OP) | 3 000 |
| `{{KAUCE_EKOLO}}` | Vratná kauce za elektrokolo (Kč) | nastavení půjčovny (shodně s OP) | 10 000 |
| `{{PREAUTH_MAX_DNU}}` | Nejdelší nájem, u kterého lze kauci blokovat preautorizací karty (dle platnosti blokace u brány) | nastavení půjčovny (shodně s protokolem) | 6 |
| `{{STORNO_TABULKA}}` | Storno lhůty a procenta z rezervačního poplatku | nastavení půjčovny (shodně s OP čl. 6.2) | „zrušení 72 h a více před termínem: 100 % poplatku zpět · 24–72 h: 50 % · méně než 24 h nebo nevyzvednutí: 0 %“ |
| `{{STORNO_DPH_REZIM}}` | Jak plátce DPH nakládá s ponechanou částí rezervačního poplatku: `mimo-predmet-dane` (opravný daňový doklad k původně zdaněné úplatě) nebo `zdanitelne-plneni` (ponechaná část zůstává zdaněnou úplatou) – **rozhodne daňový poradce půjčovny** (K ověření, bod 4); zobrazí se jen při `{{PLATCE_DPH}}` = ano | nastavení půjčovny | mimo-predmet-dane |
| `{{DOKLAD_REZIM}}` | Jak se nakládá s dokladem totožnosti při výdeji – **rozhodne advokát (K ověření, bod 1)**: `souhlas` = zapisuje se typ a číslo dokladu, u občanského průkazu jen se souhlasem držitele zaznamenaným v protokolu a s reálnou alternativou (VARIANTA DOKLAD-A); `bez-cisla` = číslo se nezapisuje, obsluha do dokladu jen nahlédne a do smlouvy zapíše jméno, datum narození a adresu (VARIANTA DOKLAD-B) | nastavení půjčovny (shodně se Zásadami) | souhlas |
| `{{DOKLADY_AKCEPTOVANE}}` | Doklady totožnosti, které půjčovna při převzetí přijímá | nastavení půjčovny (shodně s OP čl. 8.3 a protokolem) | občanský průkaz, cestovní pas nebo řidičský průkaz |
| `{{DRUHY_DOKLAD}}` | Může obsluha požádat o předložení druhého dokladu s fotografií? (ano / ne) Druhý doklad se **pouze předkládá, nic se z něj nezapisuje** | nastavení půjčovny (shodně se Zásadami) | ne |
| `{{ZAPISOVAT_NAROZENI_ADRESU}}` | Zapisovat do smlouvy o nájmu i datum narození a adresu nájemce? (ano / ne); při `{{DOKLAD_REZIM}}` = bez-cisla vždy ano | nastavení půjčovny (shodně s protokolem a Zásadami) | ne |
| `{{DOKLAD_CISLO_TISK}}` | Jak se číslo dokladu tiskne na listinnou smlouvu: `maskovane` (jen poslední 3 znaky) nebo `plne` | nastavení půjčovny (shodně s protokolem a Zásadami) | maskovane |
| `{{PODPIS_ZPUSOB}}` | Jak se smlouva a protokoly podepisují: `papir` (listinné stejnopisy) nebo `obrazovka` (obrázek podpisu uložený k dokumentu) | nastavení půjčovny (shodně s protokolem a Zásadami) | obrazovka |
| `{{DOBA_NEDOKONCENE_REZERVACE}}` | Uchování nedokončené / nezaplacené rezervace; ve zpracovatelské smlouvě `{{DOBA_NEDOKONCENE_REZERVACE}}` | nastavení půjčovny (shodně se Zásadami) | 90 dní (rozsah 30–90) |
| `{{DOBA_SMLOUVA}}` | Uchování smlouvy o nájmu, protokolů, fotodokumentace, záznamu o souhlasu s OP a údajů o zrušené rezervaci (od storna); ve zpracovatelské smlouvě `{{DOBA_SMLOUVA}}` | nastavení půjčovny (shodně se Zásadami a protokolem) | 3 roky od vrácení kola (resp. od storna); lze až 10 let |
| `{{DOBA_CISLO_DOKLADU}}` | Uchování typu a čísla dokladu totožnosti po vrácení kola a vypořádání kauce; ve zpracovatelské smlouvě `{{DOBA_CISLO_DOKLADU}}` | nastavení půjčovny (shodně se Zásadami a protokolem) | 30 dní |
| `{{DOBA_LOGY}}` | Uchování technických a bezpečnostních logů a audit logu; ve zpracovatelské smlouvě `{{DOBA_LOGY}}` | nastavení půjčovny (shodně se Zásadami) | 12 měsíců (rozsah 6–12) |
| `{{DOBA_ZALOHY}}` | Nejdelší doba, po kterou smazaný údaj přetrvá v zálohách (nejstarší měsíční záloha); ve zpracovatelské smlouvě `{{DOBA_ZALOHY}}` | **nastavení platformy** – určuje provozovatel, shodné pro všechny půjčovny, půjčovna ho nemění | 12 měsíců |
| `{{DOBA_KOMUNIKACE}}` | Uchování komunikace, která nesouvisí s uzavřenou smlouvou (dotazy, nedokončené poptávky) | nastavení půjčovny (shodně se Zásadami odd. 4) | 1 rok od posledního kontaktu |
| `{{DOBA_MARKETING}}` | Jak dlouho po poslední výpůjčce půjčovna posílá obchodní sdělení vlastním zákazníkům | nastavení půjčovny (shodně se Zásadami) | 3 roky od poslední výpůjčky |
| `{{MARKETING_FREKVENCE}}` | Nejvyšší četnost obchodních sdělení vlastním zákazníkům | nastavení půjčovny (shodně se Zásadami) | „nejvýše 4× ročně“ |
| `{{LHUTA_OHLASENI_INCIDENTU}}` | Do kdy od zjištění provozovatel ohlásí půjčovně porušení zabezpečení | zpracovatelská smlouva (čl. 12) | 24 hodin |
| `{{LHUTA_SOUCINNOSTI}}` | Do kdy provozovatel poskytne půjčovně součinnost nad rámec funkcí administrace (práva subjektů, DPIA, informace) | zpracovatelská smlouva (čl. 11.3, 12.6) | 10 pracovních dnů |
| `{{LHUTA_OZNAMENI_PODZPRACOVATELE}}` | Jak dlouho předem provozovatel oznámí nového nebo nahrazeného podzpracovatele | zpracovatelská smlouva (čl. 9.2) | 30 dnů |
| `{{LHUTA_NAMITKY}}` | Do kdy od oznámení může půjčovna vznést námitku proti podzpracovateli | zpracovatelská smlouva (čl. 9.2) | 14 dnů |
| `{{SEZNAM_SPRAVCU}}` | Jen v části B: řádky tabulky B.2 (všechny půjčovny, pro které provozovatel zpracovává údaje) generované z databáze platformy ve sloupcích uvedených v B.2 | databáze platformy | – (generováno) |
| `{{VERZE}}` | Číslo verze tohoto dokumentu | systém | 1.0 |
| `{{UCINNOST_OD}}` | Datum, od kterého tato verze platí | systém | – |
| `{{DATUM_REVIZE}}` | Datum poslední kontroly záznamu (nejméně 1× ročně a při každé změně) | systém | = `{{UCINNOST_OD}}` při prvním vydání |

<!-- /INTERNI -->

---

## 1. Co je tento záznam a proč ho vedeme

Záznam o činnostech zpracování je **interní přehled toho, co půjčovna s osobními údaji dělá** – ne deník každodenní práce s rezervacemi. Čl. 30 GDPR ukládá správci vést záznam s identifikací správce, účely, kategoriemi subjektů a údajů, příjemci, případným předáním do třetí země, lhůtami výmazu a obecným popisem zabezpečení (odst. 1); zpracovatel vede záznam o kategoriích činností, které pro správce provádí (odst. 2). Záznam se vede písemně, i elektronicky (odst. 3), a předkládá se dozorovému úřadu na požádání (odst. 4).

**Část A** je záznam půjčovny {{PUJCOVNA_NAZEV}} jako správce, **část B** záznam provozovatele {{PROVOZOVATEL_NAZEV}} jako zpracovatele. Role vyplývají ze Smlouvy o zpracování osobních údajů ze dne {{SMLOUVA_ZPRACOVANI_DATUM}}.

**Proč záznam vede i malá půjčovna.** Výjimka pro podniky do 250 osob (čl. 30 odst. 5) neplatí, jakmile zpracování není příležitostné – a zpracování údajů zákazníků je samotnou podstatou podnikání půjčovny, probíhá denně po celou sezónu (stanovisko WP29 z 19. 4. 2018). Úřad pro ochranu osobních údajů v Základní příručce k ochraně údajů uvádí, že výjimka má v praxi minimální význam, protože běžná činnost – včetně mzdové agendy, která navíc obsahuje údaje o zdravotním stavu – příležitostná není, a doporučuje záznamy vést prakticky všem správcům. Půjčovna {{PUJCOVNA_NAZEV}} ({{PUJCOVNA_POCET_OSOB}} osob) proto záznam vede; o riziku pro práva a svobody subjektů (další podmínka odst. 5) není třeba rozhodovat. Podrobnější odůvodnění pro advokáta je v příloze na konci dokumentu.

**Jak záznam vzniká a kdo ho udržuje.** Aplikace sestaví část A z nastavení půjčovny a část B ze seznamu půjčoven a podzpracovatelů; změna nastavení (nová brána, jiná lhůta, zapnutí analytiky) vytvoří novou verzi, starší verze zůstávají uložené. Činnosti mimo systém (oddíl A.7) doplní půjčovna ručně – bez nich záznam není úplný. Revize nejméně **jednou ročně** a při každé změně účelu, příjemce, lhůty nebo opatření. Za část A odpovídá {{PUJCOVNA_ODPOVEDNA_OSOBA}} ({{PUJCOVNA_EMAIL}}), za část B {{PROVOZOVATEL_ODPOVEDNA_OSOBA}} ({{PROVOZOVATEL_EMAIL}}). Na vyžádání ÚOOÚ se záznam exportuje do PDF z administrace.

**Vazba na ostatní dokumenty.** Účely, právní základy, lhůty a příjemci jsou shodné se Zásadami ochrany osobních údajů ({{ZASADY_URL}}, oddíly 3–6); balanční testy pro oprávněný zájem jsou v Zásadách (oddíl 3, testy A a B) a zde se na ně jen odkazuje. Podzpracovatelé, lhůty součinnosti a ohlašování incidentů jsou převzaty ze Smlouvy o zpracování osobních údajů ze dne {{SMLOUVA_ZPRACOVANI_DATUM}} (čl. 9, 11, 12 a Příloha 3). Co se ukládá ze smlouvy o nájmu a protokolů, popisuje část D šablony Smlouvy o nájmu jízdního kola.

---

## Část A – Záznam správce podle čl. 30 odst. 1 GDPR

### A.0 Přehled pro majitele půjčovny

**Co záznam pokrývá:** devět činností, které běží v rezervačním systému a na webu (A1–A9), a volitelnou A10 (měření návštěvnosti, jen je-li zapnuto). Souhrn je v tabulce A.2, podrobnosti v A.3.

**Co musí půjčovna doplnit sama (A.7):** mzdovou a personální agendu (vždy, má-li zaměstnance nebo brigádníky), kamerový systém (má-li ho), evidenci hostů (provozuje-li půjčovnu hotel či penzion), případné GPS lokátory na kolech, vlastní marketing mimo systém, ruční evidenci mimo systém. Administrace záznam neoznačí za hotový, dokud půjčovna A.7 neprojde.

**Kdy revidovat:** nejméně jednou ročně (datum poslední revize: {{DATUM_REVIZE}}) a vždy, když půjčovna změní nastavení (lhůty, brána, banka, účetní, analytika, způsob podpisu, nakládání s dokladem) nebo začne údaje používat k novému účelu. Systém při změně nastavení vytvoří novou verzi automaticky; změny mimo systém zapíše půjčovna.

**Co dělat při žádosti zákazníka nebo incidentu:** postup je v A8 – export a výmaz na jedno kliknutí v administraci, ohlášení incidentu ÚOOÚ do 72 hodin, provozovatel hlásí půjčovně do {{LHUTA_OHLASENI_INCIDENTU}}.

### A.1 Identifikace správce (čl. 30 odst. 1 písm. a))

| Položka | Údaj |
|---|---|
| Správce | **{{PUJCOVNA_NAZEV}}**, IČO {{PUJCOVNA_ICO}} [při {{PLATCE_DPH}} = ano], DIČ {{PUJCOVNA_DIC}} |
| Sídlo | {{PUJCOVNA_SIDLO}} |
| Provozovna (místo výdeje a vrácení kol) | {{PUJCOVNA_PROVOZOVNA}} |
| Kontakt | {{PUJCOVNA_EMAIL}}, {{PUJCOVNA_TELEFON}} |
| Web | `https://{{WEB_SUBDOMENA}}` (provozovaný zpracovatelem {{PROVOZOVATEL_NAZEV}}) |
| Osoba odpovědná za ochranu údajů (interní kontakt) | {{PUJCOVNA_ODPOVEDNA_OSOBA}} |
| Pověřenec pro ochranu osobních údajů (čl. 37) | **nejmenován** – půjčovna není orgánem veřejné moci, její hlavní činnost nespočívá v rozsáhlém pravidelném a systematickém monitorování osob ani v rozsáhlém zpracování zvláštních kategorií údajů (čl. 37 odst. 1 písm. a)–c) GDPR) |
| Společný správce (čl. 26) | žádný – provozovatel platformy je zpracovatel; platební brána, poskytovatel terminálu a banka jsou samostatní správci |
| Zástupce správce (čl. 27) | není třeba – správce je usazen v EU |
| Posouzení vlivu (čl. 35) | neprovedeno – nejde o žádný z případů čl. 35 odst. 3 (systematické a rozsáhlé vyhodnocování osob, rozsáhlé zpracování zvláštních kategorií, rozsáhlé monitorování veřejných prostor) a zpracování neodpovídá kritériím seznamu ÚOOÚ; při zapnutí GPS lokátorů ({{GPS_LOKATORY}} = ano) je posouzení nutné – viz K ověření, bod 13 |
| Dozorový úřad | Úřad pro ochranu osobních údajů, Pplk. Sochora 27, 170 00 Praha 7, posta@uoou.gov.cz, datová schránka qkbaa2n |

### A.2 Přehled činností zpracování

| # | Činnost | Hlavní účel | Právní základ (čl. 6 odst. 1 GDPR) | Hlavní lhůta výmazu |
|---|---|---|---|---|
| A1 | Rezervace a smlouva o nájmu kola | uzavření a plnění smlouvy o nájmu kola jako dopravního prostředku (§ 2201 a násl., § 2321 a násl. OZ) | písm. b); záznam o souhlasu s OP písm. f) | nedokončená rezervace {{DOBA_NEDOKONCENE_REZERVACE}}; smlouva, protokoly a zrušená rezervace {{DOBA_SMLOUVA}} |
| A2 | Platby, doklady a účetnictví | přijetí rezervačního poplatku a doplatku, vratky, doklady o platbě a o poskytnutí služby, účetnictví nebo daňová evidence | písm. c) (§ 16 odst. 1 ZOS; [při {{PLATCE_DPH}} = ano] § 20a, § 28, § 35 ZDPH; [při {{REZIM_DOKLADU}} = ucetnictvi] § 31 zákona o účetnictví; [při {{REZIM_DOKLADU}} = danova-evidence] § 7b odst. 5 ZDP, § 148 daňového řádu), pro provedení platby písm. b) | [při {{PLATCE_DPH}} = ano] daňové doklady 10 let (§ 35 odst. 2 ZDPH); [při {{REZIM_DOKLADU}} = ucetnictvi] účetní záznamy 5 let, závěrka 10 let (§ 31 odst. 2 zákona o účetnictví); [při {{REZIM_DOKLADU}} = danova-evidence] po dobu lhůty pro stanovení daně (§ 7b odst. 5 ZDP, § 148 daňového řádu – zpravidla 3 roky, nejdéle 10 let) |
| A3 | Ověření totožnosti a evidence kauce při výdeji kola | ochrana majetku půjčovny, možnost dohledat nájemce při nevrácení kola; evidence přijetí a vrácení kauce | [VARIANTA DOKLAD-A] číslo občanského průkazu: písm. a) (souhlas vyžadovaný § 39 písm. d) zákona č. 269/2021 Sb.); číslo pasu / řidičského průkazu: písm. f) – balanční test A v Zásadách; [VARIANTA DOKLAD-B] jméno, datum narození a adresa z dokladu: písm. b), podpůrně f); kauce: písm. b) | [VARIANTA DOKLAD-A] typ a číslo dokladu {{DOBA_CISLO_DOKLADU}} po vrácení kola a vypořádání kauce; [VARIANTA DOKLAD-B] údaje ze smlouvy {{DOBA_SMLOUVA}}; údaje o kauci {{DOBA_SMLOUVA}} |
| A4 | Bezpečnostní logy a audit přístupu | bezpečnost webu a systému, prošetření incidentů, doložení přístupů obsluhy | písm. f) – balanční test B v Zásadách; čl. 32 GDPR | {{DOBA_LOGY}} |
| A5 | Komunikace se zákazníky, dotazy a reklamace | odpovědi na dotazy před rezervací, změny rezervace, vyřízení reklamací, informace o mimosoudním řešení sporů | písm. b) (jednání o smlouvě a její plnění); reklamace a informace o ADR písm. c) (§ 14 odst. 1 a 2, § 19 ZOS); dotazy bez smlouvy písm. f) | se smlouvou {{DOBA_SMLOUVA}}; jinak {{DOBA_KOMUNIKACE}} |
| A6 | Obchodní sdělení vlastním zákazníkům a newsletter | informace o sezóně, novinkách a nabídce půjčovny | vlastní zákazníci: písm. f) + § 7 odst. 3 zákona č. 480/2004 Sb.; ostatní: písm. a) + § 7 odst. 2 | do námitky / odvolání souhlasu, nejdéle {{DOBA_MARKETING}} |
| A7 | Škodní události, krádeže a uplatnění právních nároků | vyčíslení a vymáhání škody, oznámení krádeže, obhajoba proti nárokům zákazníka | písm. f) (§ 2910, § 2913 OZ); při dožádání orgánů písm. c) (§ 8 odst. 1 trestního řádu) | do vyřešení věci + 3 roky (§ 629 odst. 1 OZ); nepřiznaný nárok nejdéle 10 let od vzniku škody, u úmyslné škody 15 let (§ 636 odst. 1 a 2 OZ); přiznaný nárok nejdéle 10 let od vykonatelnosti (§ 640 OZ) |
| A8 | Plnění povinností podle GDPR | vyřízení žádostí subjektů, evidence námitek a odvolaných souhlasů, dokumentace incidentů, tento záznam | písm. c) (čl. 12–22, čl. 30, čl. 33 odst. 5 GDPR) | žádosti 3 roky od vyřízení; evidence incidentů 5 let; otisk e-mailu po námitce proti marketingu trvale |
| A9 | Účty obsluhy v administraci | přihlášení a oprávnění zaměstnanců a brigádníků půjčovny, 2FA, přehled přihlášení | písm. b) (pracovní smlouva / dohoda) a písm. f) (zabezpečení, čl. 32) | účet smazán při ukončení spolupráce; záznamy přihlášení {{DOBA_LOGY}} |
| A10 | [jen při zapnuté analytice {{ANALYTIKA_NASTROJ}}] Měření návštěvnosti webu | statistika používání webu | písm. a) + § 89 odst. 3 ZEK | volba v liště 12 / 6 měsíců; analytické údaje nejdéle 14 měsíců |

### A.3 Podrobné záznamy

#### A1 – Rezervace a smlouva o nájmu kola

| Náležitost (čl. 30 odst. 1) | Obsah |
|---|---|
| **Účel** | Přijmout a potvrdit rezervaci kol na termín, uzavřít smlouvu o nájmu věci movité – jízdního kola jako dopravního prostředku (§ 2201 a násl., § 2321 a násl. OZ) – a plnit ji: připomínka den předem, správa rezervace přes zabezpečený odkaz v e-mailu, změna termínu, storno a vratka podle storno podmínek, výdej a vrácení kola, předávací protokol a protokol o vrácení. Součástí je záznam o souhlasu s Obchodními podmínkami ({{PODMINKY_URL}}; verze, čas, otisk IP adresy) a poučení, že u rezervace na termín nemá spotřebitel 14denní právo odstoupit (§ 1837 písm. j) OZ – smlouva „o … nájmu dopravního prostředku … nebo využití volného času, pokud má být podle smlouvy plněno k určitému datu nebo v určitém období“). |
| **Právní základ** | Čl. 6 odst. 1 písm. b) GDPR – plnění smlouvy a jednání o ní. Záznam o souhlasu s OP a otisk IP: čl. 6 odst. 1 písm. f) – oprávněný zájem prokázat obsah a okamžik uzavření smlouvy (viz K ověření, bod 7). [při {{ZAPISOVAT_NAROZENI_ADRESU}} = ano] Datum narození a adresa: čl. 6 odst. 1 písm. b), podpůrně písm. f) – identifikace smluvní strany pro případné uplatnění nároku u soudu (K ověření, bod 2). |
| **Kategorie subjektů údajů** | Zákazníci (nájemci) – spotřebitelé i podnikatelé; osoby, které rezervaci rozpracovaly a nedokončily; další osoby, které přebírají kolo v rámci jedné rezervace (každá se při výdeji stává nájemcem); osoba, která rezervaci zapisuje telefonicky nebo osobně prostřednictvím obsluhy. Smlouvu uzavírá jen osoba starší 18 let (OP čl. 8.2). Děti mohou kola užívat jako členové skupiny nájemce; zahrnuje-li rezervace dětské kolo, sedačku nebo vozík, zpracovává se jen typ a velikost kola či příslušenství a případně věk nebo výška dítěte, pokud ji zákazník uvede v poznámce pro volbu velikosti – bez jména, jako součást rezervačních údajů se stejnou lhůtou. Poučení o přilbě pro osoby mladší 18 let a o věkových limitech přepravy dětí (§ 58 zákona č. 361/2000 Sb.) je v OP čl. 9.2 a v předávacím protokolu. |
| **Kategorie osobních údajů** | Identifikační a kontaktní: jméno a příjmení, e-mail, telefon, jazyk komunikace. Rezervační: termín od–do, typy, velikosti a počet kol, příslušenství, poznámka, číslo a stav rezervace, cena, výše rezervačního poplatku ({{POPLATEK_KOLO}} Kč za kolo, {{POPLATEK_EKOLO}} Kč za elektrokolo), storno podmínky ({{STORNO_TABULKA}}). Smluvní: identifikace vydaných kol (včetně výrobního čísla rámu), předávací protokol a protokol o vrácení (stav kola, výbava, poškození a jeho ocenění, vyúčtování), fotografie kol při výdeji a vrácení (fotí se jen kolo, nikdy zákazník ani doklad; údaje o poloze z fotografií systém odstraní), verze OP a Zásad, k nimž se podpis váže. Záznam o souhlasu s OP: verze, datum a čas, otisk (hash) IP adresy. Bezpečnostní odkaz na správu rezervace. [při {{ZAPISOVAT_NAROZENI_ADRESU}} = ano nebo VARIANTĚ DOKLAD-B] Datum narození a adresa bydliště nájemce ověřené z dokladu (uloženy šifrovaně, lhůta {{DOBA_SMLOUVA}}; účel: označení žalovaného při vymáhání škody). [při {{PODPIS_ZPUSOB}} = obrazovka] Obrázek vlastnoručního podpisu nájemce s časem a identifikátorem zařízení, uložený šifrovaně k dokumentu – nejde o biometrický údaj ve smyslu čl. 4 bodu 14 GDPR: ukládá se jen statický obrázek, podpis se nevyhodnocuje technickými prostředky k identifikaci (K ověření, bod 8). [při {{PODPIS_ZPUSOB}} = papir] Listinné stejnopisy smlouvy a protokolů s podpisy; číslo dokladu na nich podle {{DOKLAD_CISLO_TISK}} (maskované, nebo plné). **Nezpracovává se:** rodné číslo, kopie dokladů, poloha nájemce ani kola během výpůjčky (kola nemají GPS; při {{GPS_LOKATORY}} = ano se doplní samostatná činnost, A.7); datum narození a adresa jen při zapnuté volbě výše. |
| **Kategorie příjemců** | {{PROVOZOVATEL_NAZEV}} (zpracovatel – provoz systému); {{HOSTING_NAZEV}} a {{EMAIL_SLUZBA_NAZEV}} (podzpracovatelé); zákazník sám (potvrzení, kalendářová pozvánka, odkaz na správu rezervace, kopie smlouvy a protokolů); obsluha půjčovny. Při sporu: soudy, ČOI jako subjekt mimosoudního řešení sporů (§ 20e ZOS). |
| **Předání do třetí země** | Ne. Servery, zálohy i e-mailová služba v EU. |
| **Lhůty výmazu** | Nedokončená nebo nezaplacená rezervace: {{DOBA_NEDOKONCENE_REZERVACE}} od vytvoření, pak výmaz. Zrušená rezervace: osobní údaje {{DOBA_SMLOUVA}} od storna (§ 629 odst. 1 OZ – nároky z vratky), doklad o vratce podle A2 (K ověření, bod 10). Uzavřená smlouva, protokoly, fotografie a záznam o souhlasu s OP: {{DOBA_SMLOUVA}} od vrácení kola; při nevyřešené škodě, krádeži nebo sporu do pravomocného skončení věci a vypořádání nároků, nejdéle v lhůtách podle A7 (10 let od vzniku škody, u úmyslně způsobené škody 15 let – § 636 odst. 1 a 2 OZ; u nároku přiznaného rozhodnutím 10 let od vykonatelnosti – § 640 OZ). [při {{PODPIS_ZPUSOB}} = papir] Listinné stejnopisy: uzamčená skříň v provozovně {{PUJCOVNA_PROVOZOVNA}}, přístup jen oprávněná obsluha, skartace po {{DOBA_SMLOUVA}}; [při {{DOKLAD_CISLO_TISK}} = plne] číslo dokladu na listině se začerní nebo listina skartuje po {{DOBA_CISLO_DOKLADU}} – systém to připomene úkolem v administraci. Po lhůtě automatická anonymizace (osobní údaje nahrazeny neutrálními hodnotami, zůstává statistika obsazenosti). |
| **Technická a organizační opatření** | Obecný popis v A.6. Specificky: odkazy na rezervaci v e-mailu jsou nehádatelné a časově omezené; jméno, kontakty i podpis jsou v databázi zašifrované, klíč je mimo databázi; dvě rezervace nemohou zabrat totéž kolo; u každé rezervace je uložena verze OP, kterou zákazník odsouhlasil; výmaz a anonymizace po lhůtách probíhají automaticky. Podrobný popis: Příloha 2 Smlouvy o zpracování osobních údajů. |

#### A2 – Platby, doklady a účetnictví

| Náležitost (čl. 30 odst. 1) | Obsah |
|---|---|
| **Účel** | Přijmout rezervační poplatek (fixní částka za každé kolo, započítává se na cenu nájmu), doplatek (online nebo na místě) a provést vratky; spárovat příchozí převody a QR platby s rezervací; vystavit doklad o přijaté platbě a konečný doklad se započtením poplatku – vždy doklad o poskytnutí služby na žádost spotřebitele podle § 16 odst. 1 ZOS; [při {{PLATCE_DPH}} = ano] u plátce DPH vzniká přijetím úplaty před uskutečněním plnění povinnost přiznat daň ke dni přijetí úplaty (§ 20a odst. 2 ZDPH; plnění je ke dni přijetí známo dostatečně určitě – rezervace konkrétního typu kola na termín, § 20a odst. 3) a daňový doklad k přijaté úplatě se vystavuje podle § 28 odst. 1 písm. d) a odst. 5 ZDPH (povinně do 15 dnů vůči podnikatelům a právnickým osobám; vůči spotřebiteli dobrovolně, zpravidla jako zjednodušený daňový doklad podle § 30 ZDPH); při stornu podle storno podmínek v OP se vypořádá ponechaná část rezervačního poplatku – její právní povaha a režim DPH se řídí rozhodnutím v Obchodních podmínkách a stanoviskem daňového poradce půjčovny ([při {{PLATCE_DPH}} = ano] nastavení {{STORNO_DPH_REZIM}}: `mimo-predmet-dane` = opravný daňový doklad k původně zdaněné úplatě; `zdanitelne-plneni` = ponechaná část zůstává zdaněnou úplatou; K ověření, bod 4); vést účetnictví nebo daňovou evidenci; doložit platby při kontrole finanční správy. |
| **Právní základ** | Čl. 6 odst. 1 písm. c) GDPR – právní povinnost: § 16 odst. 1 ZOS (doklad o poskytnutí služby na žádost spotřebitele); [při {{PLATCE_DPH}} = ano] § 20a, § 28, § 35 a § 35a ZDPH (přiznání daně, daňové doklady a jejich uchování); [při {{REZIM_DOKLADU}} = ucetnictvi] § 31 zákona č. 563/1991 Sb., o účetnictví (uchování účetních záznamů); [při {{REZIM_DOKLADU}} = danova-evidence] § 7b odst. 5 zákona č. 586/1992 Sb., o daních z příjmů, ve spojení s § 148 zákona č. 280/2009 Sb., daňového řádu (uchování daňové evidence po dobu lhůty pro stanovení daně). Pro samotné provedení platby a vratky čl. 6 odst. 1 písm. b) – plnění smlouvy. |
| **Kategorie subjektů údajů** | Zákazníci (plátci poplatku a doplatku); osoby, které platbu provedly za zákazníka (plátce převodu může být jiná osoba než nájemce); příjemci vratek. |
| **Kategorie osobních údajů** | Jméno a fakturační údaje zákazníka (jen pokud jsou na dokladu nutné); způsob, částka, měna, datum a stav platby; účel platby (poplatek, doplatek, vratka, ponechaná část poplatku při stornu); identifikátor platby u brány nebo číslo transakce z účtenky terminálu; u karty nejvýše značka karty a poslední 4 číslice, pokud je brána nebo terminál předá; u převodu a QR platby z výpisu účtu: číslo účtu a název protiúčtu (jméno plátce), variabilní symbol, zpráva pro příjemce, datum a identifikátor pohybu; u platby na místě: forma (hotově/terminál) a částka; vystavené doklady (číslo, datum, položky, [při {{PLATCE_DPH}} = ano] DPH); záznamy v účetním deníku. **Nezpracovává se:** číslo platební karty, CVC, 3-D Secure data – zadávají se výhradně na stránce brány nebo na terminálu. |
| **Kategorie příjemců** | {{PLATEBNI_BRANA_NAZEV}} – samostatný správce (zpracovává platbu kartou podle zákona č. 370/2017 Sb., o platebním styku, a zákona č. 253/2008 Sb.); [jen je-li vyplněn {{TERMINAL_POSKYTOVATEL}}] {{TERMINAL_POSKYTOVATEL}} – samostatný správce (platby kartou na místě); {{BANKA_NAZEV}} – samostatný správce (výpis účtu načítaný přes rozhraní banky přístupem jen pro čtení); [jen je-li vyplněn {{UCETNI_NAZEV}}] {{UCETNI_NAZEV}} – {{UCETNI_ROLE}}; finanční správa a jiné orgány při kontrole nebo dožádání; {{PROVOZOVATEL_NAZEV}} a podzpracovatelé (provoz systému, odeslání dokladů e-mailem); zákazník (doklady e-mailem / přes odkaz). |
| **Předání do třetí země** | Ne. Brána a banka jsou české společnosti; pokud by zvolená brána zpracovávala část údajů mimo EU, řídí se to jejími vlastními pravidly jako samostatného správce (uvede se v Zásadách, oddíl 6). |
| **Lhůty výmazu** | [při {{PLATCE_DPH}} = ano] Daňové doklady: **10 let od konce zdaňovacího období, ve kterém se plnění uskutečnilo** (§ 35 odst. 2 ZDPH; elektronicky s věrohodností původu, neporušeností obsahu a čitelností podle § 35a ZDPH). [při {{REZIM_DOKLADU}} = ucetnictvi] Účetní doklady a knihy: 5 let, účetní závěrka 10 let, vždy od konce účetního období (§ 31 odst. 2 písm. a) a b) zákona o účetnictví). [při {{REZIM_DOKLADU}} = danova-evidence] Daňová evidence a doklady: po dobu lhůty pro stanovení daně (§ 7b odst. 5 ZDP, § 148 daňového řádu) – zpravidla 3 roky od konce lhůty pro podání přiznání, při zahájení kontroly nebo doměření déle, nejdéle 10 let. Platební údaje (identifikátor platby, číslo účtu plátce, značka karty a poslední 4 číslice): součást dokladů a evidence, stejné lhůty. Nespárované platby bez rezervace: do vrácení plátci, pak jako účetní záznam; nespárované pohyby, které se k žádné rezervaci nepřiřadí, se mažou po {{DOBA_NEDOKONCENE_REZERVACE}}. Po uplynutí lhůt se doklady archivují bez vazby na ostatní údaje zákazníka (zbytek profilu je už anonymizován podle A1). |
| **Technická a organizační opatření** | Obecný popis v A.6. Specificky: částky plateb určuje výhradně systém, ne zákazníkův prohlížeč; stav platby se vždy ověřuje přímo u brány, aby nešlo platbu podvrhnout; každá notifikace brány se zpracuje nejvýše jednou; přístupové údaje k bráně a bance jsou uloženy zašifrované zvlášť pro každou půjčovnu, přístup k bance je jen pro čtení a pravidelně se obnovuje; každá koruna je v účetním deníku zapsána právě jednou; export pro účetní neobsahuje údaje z dokladů totožnosti. Podrobný popis: Příloha 2 Smlouvy o zpracování osobních údajů. |

#### A3 – Ověření totožnosti a evidence kauce při výdeji kola

| Náležitost (čl. 30 odst. 1) | Obsah |
|---|---|
| **Účel** | (1) Ověřit totožnost nájemce při výdeji kola, aby bylo možné při nevrácení kola, krádeži nebo neuhrazené škodě doložit, kdo kolo převzal, a předat tento údaj Policii ČR nebo soudu. [VARIANTA DOKLAD-A] Zaznamenává se **pouze typ a číslo** předloženého dokladu. [VARIANTA DOKLAD-B] Z dokladu se nic nezaznamenává; obsluha do něj jen nahlédne a do smlouvy zapíše jméno, datum narození a adresu nájemce (A1). (2) Evidovat kauci (vratnou jistotu) – její výši, formu, přijetí, vrácení nebo započtení na škodu – aby bylo prokazatelné, co a kdy půjčovna přijala a vrátila. |
| **Právní základ** | **Zákonný rámec dokladů:** § 39 zákona č. 269/2021 Sb., o občanských průkazech, zakazuje občanský průkaz přijímat jako zástavu (písm. b)), pořizovat jeho kopii bez souhlasu držitele (písm. c); přestupek podle § 65 odst. 1 písm. d), pokuta do 10 000 Kč) a **zpracovávat údaje v něm uvedené bez souhlasu držitele (písm. d)); výjimka z písm. d) platí jen pro nahlédnutí do průkazu při ověřování totožnosti, které vyžaduje nebo umožňuje právní předpis**. Zápis čísla občanského průkazu do systému je zpracování údaje uvedeného v průkazu, ne nahlédnutí – oprávněný zájem (písm. f)) nemůže výslovný zákonný zákaz přebít. U cestovního pasu obdobný zákaz zpracování údajů není (§ 2 odst. 3 zákona č. 329/1999 Sb. zakazuje jen kopie bez souhlasu – přestupek podle § 34a odst. 1 písm. i), pokuta do 10 000 Kč; § 2 odst. 2 zakazuje zadržení pasu jako zástavy); u řidičského průkazu zákon č. 361/2000 Sb. žádný zákaz neobsahuje a ÚOOÚ ho jako průkaz totožnosti připouští, „je-li to druhou stranou akceptováno“. **[VARIANTA DOKLAD-A]** Číslo **občanského průkazu**: čl. 6 odst. 1 písm. a) GDPR – souhlas držitele vyžadovaný § 39 písm. d), zaznamenaný v předávacím protokolu; souhlas je svobodný, protože zákazník má reálnou alternativu bez ztráty služby – předložit jiný doklad z {{DOKLADY_AKCEPTOVANE}} (pas nebo řidičský průkaz), nebo složit kauci v plné hodnotě kola (OP čl. 8.3). Číslo **cestovního pasu nebo řidičského průkazu**: čl. 6 odst. 1 písm. f) – oprávněný zájem na ochraně majetku a vymahatelnosti nároků; balanční test A je v Zásadách (oddíl 3) a opírá se o stanovisko ÚOOÚ „Prokazování totožnosti a zpracování osobních údajů“ (13. 5. 2021): ve většině případů má postačovat předložení originálu veřejné listiny a zaznamenání nezbytných údajů, případně včetně čísla průkazu a kým byl vydán. **[VARIANTA DOKLAD-B]** Ověření totožnosti nahlédnutím: výjimka v § 39 písm. d) (nahlédnutí při ověřování totožnosti smluvní strany, které umožňuje OZ); jméno, datum narození a adresa zapsané do smlouvy: čl. 6 odst. 1 písm. b) – identifikace smluvní strany jako nezbytná část smlouvy o nájmu věci v hodnotě desítek tisíc korun, podpůrně písm. f) s balančním testem A. **Volba varianty a její odůvodnění je první bod oddílu „K ověření advokátem“.** Kauce: čl. 6 odst. 1 písm. b) – plnění smlouvy (OP čl. 5). |
| **Kategorie subjektů údajů** | Nájemci přebírající kolo (každá osoba, která kolo fyzicky převzala a předložila doklad). |
| **Kategorie osobních údajů** | [VARIANTA DOKLAD-A] Typ dokladu (z {{DOKLADY_AKCEPTOVANE}}) a jeho číslo; u občanského průkazu záznam o souhlasu se zápisem čísla (v předávacím protokolu); datum a čas zápisu; kdo z obsluhy zápis provedl. [VARIANTA DOKLAD-B] Záznam, že totožnost byla ověřena nahlédnutím do dokladu, a typ předloženého dokladu; jméno, datum narození a adresa jsou součástí smlouvy (A1). [při {{DRUHY_DOKLAD}} = ano] Druhý doklad s fotografií se pouze předkládá; nic se z něj nezapisuje. Kauce: výše ({{KAUCE_KOLO}} Kč za kolo, {{KAUCE_EKOLO}} Kč za elektrokolo), forma – **(a) hotově nebo platebním terminálem na místě** (obsluha zapíše částku, formu a u terminálu číslo transakce z účtenky do předávacího protokolu), nebo **(b) preautorizace karty přes platební bránu při převzetí** (uložen jen identifikátor blokace u brány, částka, stav, platnost blokace, případně značka karty a poslední 4 číslice; blokace platí u bran 4–7 dní, proto jen u nájmů do {{PREAUTH_MAX_DNU}} dní); datum a způsob vrácení nebo částečného stržení s odkazem na záznam o škodě. **Nezpracovává se a je zakázáno:** kopie, sken nebo fotografie dokladu (§ 39 písm. c) zákona č. 269/2021 Sb.; § 2 odst. 3 zákona č. 329/1999 Sb.; souhlas vynucený jako podmínka služby není svobodný – ÚOOÚ to u půjčovny sportovního vybavení posoudil jako porušení), zadržení dokladu jako zástavy (§ 39 písm. b); § 2 odst. 2 zákona č. 329/1999 Sb.), rodné číslo, státní příslušnost, strojově čitelná zóna a údaje z čipu; [VARIANTA DOKLAD-B] ani číslo dokladu. |
| **Kategorie příjemců** | Obsluha půjčovny s rolí umožňující výdej ([VARIANTA DOKLAD-A] číslo dokladu vidí jen při výdeji a vrácení); {{PROVOZOVATEL_NAZEV}} jako zpracovatel – [VARIANTA DOKLAD-A] číslo dokladu pouze v zašifrované podobě, klíč je mimo databázi a při servisním zásahu se číslo nedešifruje (B.3, řádek B6); {{PLATEBNI_BRANA_NAZEV}} – samostatný správce pro preautorizaci; [jen je-li vyplněn {{TERMINAL_POSKYTOVATEL}}] {{TERMINAL_POSKYTOVATEL}} – samostatný správce pro kauci složenou kartou na místě; Policie ČR, soudy, exekutoři – jen při nevrácení kola, krádeži nebo neuhrazené škodě; [jen je-li vyplněn {{POJISTOVNA_NAZEV}}] {{POJISTOVNA_NAZEV}} – při pojistné události jen jméno nájemce a údaje o výpůjčce a škodě; [VARIANTA DOKLAD-A] číslo dokladu pouze na její odůvodněnou žádost při šetření krádeže. **Nikdy** účetní, e-mailová služba ani jiné půjčovny. |
| **Předání do třetí země** | Ne. |
| **Lhůty výmazu** | [VARIANTA DOKLAD-A] Typ a číslo dokladu: **{{DOBA_CISLO_DOKLADU}} po vrácení kola a vypořádání kauce**, pak automatický nevratný výmaz; déle jen při nevyřešené škodě, krádeži nebo nezaplacení – do vyřešení věci (pak přechází do A7). Záznam o souhlasu se zápisem čísla občanského průkazu zůstává v protokolu po dobu {{DOBA_SMLOUVA}} (prokázání souhlasu, čl. 7 odst. 1 GDPR). Pokud zákazník kolo nepřevzal, číslo dokladu se nezapisuje. [VARIANTA DOKLAD-B] Údaje ze smlouvy podle A1 ({{DOBA_SMLOUVA}}). Údaje o kauci: součást protokolu – {{DOBA_SMLOUVA}}; doklad o přijetí a vrácení kauce v hotovosti nebo terminálem je účetní záznam (A2). Identifikátor blokace u brány: po uvolnění nebo stržení blokace jako platební záznam (A2). |
| **Technická a organizační opatření** | Obecný popis v A.6. Specificky: [VARIANTA DOKLAD-A] číslo dokladu je zašifrované, klíč je mimo databázi, v zálohách je jen zašifrované; zobrazí se jen oprávněné obsluze a jen v kroku výdeje a vrácení, každé zobrazení se zapíše; po lhůtě ho systém vymaže automaticky a výmaz je ověřen testy. V administraci nelze k zákazníkovi nahrát žádný soubor (žádné skeny dokladů); formulář obsluhu upozorní, že se doklad nekopíruje a nefotí, [VARIANTA DOKLAD-A] a u občanského průkazu vyžaduje zaškrtnout udělený souhlas nebo zvolit alternativu; pokyn obsluze je v provozním řádu výdeje. Preautorizace probíhá jen na stránce brány (žádné karetní údaje v systému); systém upozorní, když nájem přesahuje platnost blokace, a nabídne kauci na místě. Nastavení {{DOKLAD_REZIM}} lze změnit v administraci bez zásahu do kódu; změna vytvoří novou verzi tohoto záznamu, Zásad i protokolu. Podrobný popis: Příloha 2 Smlouvy o zpracování osobních údajů. |

#### A4 – Bezpečnostní logy a audit přístupu

| Náležitost (čl. 30 odst. 1) | Obsah |
|---|---|
| **Účel** | Udržet web a rezervační systém bezpečný a dostupný: odhalit a zastavit útoky (hádání hesel, podvržené platby, zneužití odkazů na rezervaci, nadměrné požadavky), prošetřit a doložit bezpečnostní incident, doložit, kdo z obsluhy a kdy k údajům zákazníka přistupoval, obnovit systém ze zálohy. Zároveň splnění povinnosti zabezpečení podle čl. 32 GDPR a podklad pro ohlášení incidentu podle čl. 33. Souhrnné statistiky návštěvnosti (počty zobrazení, typ zařízení, země) se počítají ze serverových logů bez ukládání čehokoli do zařízení návštěvníka. |
| **Právní základ** | Čl. 6 odst. 1 písm. f) GDPR – oprávněný zájem na bezpečnosti systému; balanční test B v Zásadách (oddíl 3). Čl. 32 odst. 1 písm. b) a d) GDPR (důvěrnost, integrita, dostupnost; pravidelné testování). Audit log přístupů obsluhy navíc dokládá plnění čl. 5 odst. 2 (odpovědnost) a čl. 32 odst. 4 (zpracování jen na pokyn správce). |
| **Kategorie subjektů údajů** | Všichni návštěvníci webu; zákazníci (při práci s jejich rezervací v administraci); obsluha půjčovny; pracovníci provozovatele při servisním přístupu. |
| **Kategorie osobních údajů** | Provozní log webu: IP adresa (v logu jako otisk), datum a čas, požadovaná adresa, stavový kód, typ prohlížeče a zařízení, chybová hlášení. Bezpečnostní události: pokusy o přihlášení (úspěch/neúspěch, účet, otisk IP), zamknutí účtu, změny hesla a 2FA, překročení limitu požadavků, odmítnuté platební notifikace. Audit log administrace: kdo (účet obsluhy), kdy, jakou akci provedl, nad kterou rezervací/platbou, s **otisky (hash) hodnot místo hodnot samotných** a bez obsahu citlivých polí. Zálohy: šifrované kopie celé databáze půjčovny. **Nelogují se:** hesla, tokeny, session ID, čísla dokladů, platební údaje, obsah formulářů a e-mailů. |
| **Kategorie příjemců** | {{PROVOZOVATEL_NAZEV}} (zpracovatel – provoz a monitoring); {{HOSTING_NAZEV}} (podzpracovatel – uložení logů a záloh); obsluha půjčovny s rolí vlastníka (přehled přihlášení); ÚOOÚ a Policie ČR při incidentu nebo dožádání; {{MAPOVE_PODKLADY}} vidí IP adresu návštěvníka při načítání mapových dlaždic po kliknutí na mapu (samostatní správci). |
| **Předání do třetí země** | Ne. CyclOSM (OpenStreetMap France) a Seznam.cz jsou v EU. |
| **Lhůty výmazu** | Provozní a bezpečnostní logy i audit log: **{{DOBA_LOGY}}**, pak výmaz. Záznamy o incidentu použité k ohlášení: podle A8. Zálohy: denní 7 dní, týdenní 4 týdny, měsíční {{DOBA_ZALOHY}} – údaje smazané z provozní databáze tak ze záloh zmizí nejpozději po {{DOBA_ZALOHY}}; zálohy slouží výhradně k obnově po havárii. |
| **Technická a organizační opatření** | Obecný popis v A.6. Specificky: do záznamu o přístupech obsluhy lze jen přidávat, ne měnit; logy neobsahují osobní údaje v čitelné podobě; opakované neúspěšné pokusy o přihlášení, platbu nebo rezervaci systém zpomalí a zablokuje; zálohy jsou šifrované a uložené mimo provozní server, obnova se zkouší každé čtvrtletí a čtení záloh je možné jen při obnově pod individuálním účtem se záznamem. Podrobný popis: Příloha 2 Smlouvy o zpracování osobních údajů. |

#### A5 – Komunikace se zákazníky, dotazy a reklamace

| Náležitost (čl. 30 odst. 1) | Obsah |
|---|---|
| **Účel** | Odpovědět na dotazy před rezervací (dostupnost, trasy, vhodná velikost kola), komunikovat změny a storna, informovat o zrušení ze strany půjčovny (počasí, porucha), přijmout a vyřídit reklamaci služby (§ 19 ZOS – vydání potvrzení o přijetí; reklamace musí být vyřízena a spotřebitel informován do 30 dnů), informovat o mimosoudním řešení sporů u ČOI – obecně na webu a v OP (§ 14 odst. 1 ZOS) a **po neúspěšném vyřízení reklamace nebo při sporu, který se nepodařilo urovnat přímo, poskytnout spotřebiteli tyto informace v listinné podobě nebo na jiném trvalém nosiči, tj. e-mailem (§ 14 odst. 2 ZOS)**; návrh na ADR lze podat do 1 roku od prvního uplatnění práva (§ 20p ZOS); odpovídat na zprávy z kontaktního formuláře. Hovory se nenahrávají; obsluha si zapisuje jen poznámku. |
| **Právní základ** | Čl. 6 odst. 1 písm. b) GDPR – jednání o smlouvě a její plnění; u reklamací a poskytnutí informací o ADR čl. 6 odst. 1 písm. c) (§ 14 odst. 1 a 2, § 19 ZOS); u dotazů, z nichž smlouva nevznikne, čl. 6 odst. 1 písm. f) – oprávněný zájem odpovědět a doložit, co bylo sděleno. |
| **Kategorie subjektů údajů** | Zákazníci; tazatelé, kteří rezervaci neudělali; osoby uplatňující reklamaci. |
| **Kategorie osobních údajů** | Jméno, e-mail, telefon; obsah e-mailů a zpráv z formuláře; poznámky obsluhy z telefonátu; obsah reklamace, datum přijetí, způsob vyřízení, potvrzení; odpovědi a lhůty; **záznam o poskytnutí informace o ADR na trvalém nosiči (e-mail s datem odeslání a obsahem) po neúspěšném vyřízení reklamace**; odkaz na rezervaci. |
| **Kategorie příjemců** | {{PROVOZOVATEL_NAZEV}} a {{EMAIL_SLUZBA_NAZEV}} (odeslání a doručení zpráv); obsluha půjčovny; ČOI a soudy při sporu (samostatní správci). |
| **Předání do třetí země** | Ne (e-mailová služba v EU; při změně viz K ověření, bod 12). |
| **Lhůty výmazu** | Komunikace související s uzavřenou smlouvou včetně reklamací a záznamu o poskytnutí informace o ADR: stejně jako smlouva – {{DOBA_SMLOUVA}}. Dotazy bez smlouvy a nedokončené poptávky: {{DOBA_KOMUNIKACE}}. Zprávy z kontaktního formuláře, které obsluha neuloží k rezervaci, se mažou automaticky po téže lhůtě. |
| **Technická a organizační opatření** | Obecný popis v A.6. Specificky: e-maily odesílá systém z ověřené domény s podpisem proti podvržení; obsah zpráv se u e-mailové služby nedrží déle, než je nutné k doručení; obsluha používá individuální účty, žádné sdílené schránky mimo systém; reklamace jsou evidovány u rezervace s lhůtou a stavem a systém po zamítnutí reklamace nabídne odeslání informace o ADR a odeslání zaznamená. |

#### A6 – Obchodní sdělení vlastním zákazníkům a newsletter

| Náležitost (čl. 30 odst. 1) | Obsah |
|---|---|
| **Účel** | (1) Zasílat vlastním zákazníkům (těm, kdo si u půjčovny kolo půjčili) e-mailem informace o **vlastních obdobných službách**: zahájení sezóny, nové typy kol, otevírací doba, akce půjčovny – {{MARKETING_FREKVENCE}}. (2) Newsletter osobám, které u půjčovny nic nepůjčily, jen po potvrzeném souhlasu (double opt-in). Obchodní sdělení **nejsou**: potvrzení rezervace, doklady, připomínka den předem, informace o změně termínu nebo podmínek. Měření návštěvnosti webu je samostatná činnost A10. |
| **Právní základ** | (1) Čl. 6 odst. 1 písm. f) GDPR ve spojení s § 7 odst. 3 zákona č. 480/2004 Sb., o některých službách informační společnosti: kontakt získaný v souvislosti s prodejem služby lze využít pro sdělení o vlastních obdobných službách, pokud má zákazník jasnou a zřetelnou možnost jednoduchým způsobem a zdarma odmítnout, a to i při zasílání každé jednotlivé zprávy; každá zpráva je označena jako obchodní sdělení a obsahuje platnou adresu pro odhlášení (§ 7 odst. 4). Námitce podle čl. 21 odst. 2 GDPR se vyhoví vždy. (2) Čl. 6 odst. 1 písm. a) GDPR a § 7 odst. 2 zákona č. 480/2004 Sb. – předchozí souhlas, kdykoli odvolatelný (čl. 7 odst. 3 GDPR). |
| **Kategorie subjektů údajů** | Zákazníci s alespoň jednou dokončenou výpůjčkou; odběratelé newsletteru bez výpůjčky. |
| **Kategorie osobních údajů** | Jméno, e-mail, jazyk; skutečnost, že osoba je zákazníkem, a datum poslední výpůjčky (bez dalšího profilování); u newsletteru záznam o souhlasu (datum, čas, otisk IP, text souhlasu, potvrzovací klik); záznam o odhlášení nebo námitce a otisk (hash) e-mailu pro blokaci dalšího zasílání. **Nezpracovává se:** otevírací a klikací sledování na úrovni jednotlivce, „podobná publika“, předávání reklamním sítím. |
| **Kategorie příjemců** | {{PROVOZOVATEL_NAZEV}} a {{EMAIL_SLUZBA_NAZEV}} (rozesílka). Nikomu dalšímu – seznam zákazníků se neprodává a nesdílí s jinými půjčovnami na platformě. |
| **Předání do třetí země** | Ne. |
| **Lhůty výmazu** | Obchodní sdělení vlastním zákazníkům: do odhlášení nebo námitky, nejdéle **{{DOBA_MARKETING}}**. Souhlas s newsletterem: do odvolání; záznam o souhlasu po dobu zasílání a 3 roky poté (prokázání souhlasu, čl. 7 odst. 1 GDPR). Otisk e-mailu po odhlášení/námitce: trvale, dokud půjčovna obchodní sdělení rozesílá (čl. 21 odst. 3 GDPR). |
| **Technická a organizační opatření** | Obecný popis v A.6. Specificky: odmítnutí lze zaškrtnout už při rezervaci; odkaz pro odhlášení jedním kliknutím v každé zprávě, zpracování ihned (nejpozději do 3 dnů); blokační seznam s otisky e-mailů kontrolovaný před každou rozesílkou; rozesílka jen z ověřené domény. |

#### A7 – Škodní události, krádeže a uplatnění právních nároků

| Náležitost (čl. 30 odst. 1) | Obsah |
|---|---|
| **Účel** | Zdokumentovat poškození, ztrátu nebo krádež kola a nehodu; vyčíslit škodu, započíst ji na kauci nebo ji vymáhat (včetně nezaplaceného nájemného a smluvních sankcí podle OP); oznámit krádež Policii ČR; [jen je-li vyplněn {{POJISTOVNA_NAZEV}}] hlásit pojistnou událost; bránit se nárokům zákazníka (újma na zdraví, spor o vratku); vyhovět dožádání orgánů. |
| **Právní základ** | Čl. 6 odst. 1 písm. f) GDPR – oprávněný zájem na uplatnění a obhajobě právních nároků: nárok na náhradu škody z porušení smluvní povinnosti vrátit věc v převzatém stavu (§ 2913 OZ) nebo ze zaviněného porušení zákona (§ 2910 OZ); promlčení nároků § 629, § 636 a § 640 OZ. Při zákonném dožádání čl. 6 odst. 1 písm. c) – § 8 odst. 1 trestního řádu (povinnost vyhovět dožádání orgánů činných v trestním řízení bez zbytečného odkladu). Oznámení krádeže podává půjčovna jako poškozený. |
| **Kategorie subjektů údajů** | Nájemci, u nichž k události došlo; svědci a další účastníci nehody (jen pokud je zákazník nebo policie uvede); obsluha, která událost zapsala. |
| **Kategorie osobních údajů** | Údaje z A1–A3 ([VARIANTA DOKLAD-A] včetně typu a čísla dokladu) po dobu řešení věci; popis a fotografie poškození kola (bez osob), vyčíslení škody a ceník náhrad; zápis o krádeži nebo nehodě, číslo jednací Policie ČR; komunikace s pojišťovnou, advokátem, soudem; výzvy k úhradě, splátky, exekuce. **Zdravotní údaje** se nezaznamenávají; pokud je zákazník sám sdělí (zranění při nehodě), uloží se jen v nezbytném rozsahu pro obhajobu nároku (čl. 9 odst. 2 písm. f) GDPR) – viz K ověření, bod 11. |
| **Kategorie příjemců** | Policie ČR, soudy, exekutoři, advokát půjčovny (samostatní správci / vázaní mlčenlivostí); [jen je-li vyplněn {{POJISTOVNA_NAZEV}}] {{POJISTOVNA_NAZEV}} při pojistné události (údaje o výpůjčce a škodě, číslo dokladu jen na odůvodněnou žádost – A3); {{PROVOZOVATEL_NAZEV}} jako zpracovatel (uložení záznamu v systému). |
| **Předání do třetí země** | Ne. |
| **Lhůty výmazu** | Do vyřešení věci (úhrada, pravomocné rozhodnutí, odložení policií) a dále 3 roky od jejího skončení (§ 629 odst. 1 OZ). Horní hranice podle druhu nároku: u nároku, který nebyl přiznán rozhodnutím, nejdéle 10 let od vzniku škody (§ 636 odst. 1 OZ); **u škody způsobené úmyslně (krádež, úmyslné nevrácení kola) nejdéle 15 let od vzniku škody (§ 636 odst. 2 OZ)**; u nároku přiznaného rozhodnutím orgánu veřejné moci do jeho vymožení, nejdéle 10 let ode dne, kdy mělo být plněno (§ 640 OZ); u nároků z újmy na zdraví uplatněných zákazníkem po dobu trvání sporu (objektivní lhůty se podle § 636 odst. 3 OZ neuplatní). [VARIANTA DOKLAD-A] Číslo dokladu se vymaže ihned po vyřešení věci. |
| **Technická a organizační opatření** | Obecný popis v A.6. Specificky: příznak „nevyřešená událost“ u rezervace pozastaví automatický výmaz jen pro tuto rezervaci; obsluha při jeho nastavení vybere druh lhůty (nedbalostní škoda / úmyslná škoda nebo krádež / nárok přiznaný rozhodnutím / spor o újmu na zdraví), uvede důvod a datum příští kontroly a systém podle toho hlídá horní hranici; fotografie poškození jsou dostupné jen v administraci; přístup jen pro roli vlastníka. |

#### A8 – Plnění povinností podle GDPR

| Náležitost (čl. 30 odst. 1) | Obsah |
|---|---|
| **Účel** | Přijmout a vyřídit žádosti subjektů údajů (přístup, oprava, výmaz, omezení, přenositelnost, námitka, odvolání souhlasu – čl. 15–21 GDPR) do jednoho měsíce (čl. 12 odst. 3); bezpečně ověřit totožnost žadatele; vést evidenci žádostí a námitek; dokumentovat každé porušení zabezpečení včetně těch, která se neohlašují (čl. 33 odst. 5), ohlásit ÚOOÚ do 72 hodin (čl. 33 odst. 1) a při vysokém riziku informovat subjekty (čl. 34); vést a aktualizovat tento záznam (čl. 30). |
| **Právní základ** | Čl. 6 odst. 1 písm. c) GDPR – právní povinnost (čl. 12–22, 30, 33–34 GDPR). |
| **Kategorie subjektů údajů** | Žadatelé (zákazníci i jiné osoby, které tvrdí, že o nich půjčovna údaje má); osoby dotčené incidentem. |
| **Kategorie osobních údajů** | Jméno, e-mail žadatele, obsah žádosti, způsob ověření totožnosti (zpravidla odpověď z e-mailu uvedeného v rezervaci – **kopie dokladu se nevyžaduje**), datum přijetí a vyřízení, výsledek, odůvodnění odmítnutí; u incidentů: popis, rozsah, dotčené údaje a osoby, účinky, přijatá opatření, komunikace s ÚOOÚ. |
| **Kategorie příjemců** | ÚOOÚ; {{PROVOZOVATEL_NAZEV}} (export a výmaz v systému, součinnost při incidentu podle čl. 28 odst. 3 písm. e) a f) a Smlouvy o zpracování, čl. 11–12); dotčení zákazníci; advokát. |
| **Předání do třetí země** | Ne. |
| **Lhůty výmazu** | Evidence žádostí: 3 roky od vyřízení (promlčení případných nároků, § 629 odst. 1 OZ). Evidence incidentů: 5 let od uzavření (doložitelnost vůči ÚOOÚ). Záznam o činnostech: aktuální verze trvale, předchozí verze 5 let. |
| **Technická a organizační opatření** | Export údajů zákazníka a výmaz/anonymizace na jedno kliknutí v administraci; přehled žádostí s lhůtou; šablona ohlášení ÚOOÚ a kontakty v plánu reakce na incidenty; smluvní povinnost provozovatele ohlásit incident půjčovně do {{LHUTA_OHLASENI_INCIDENTU}} a poskytnout součinnost do {{LHUTA_SOUCINNOSTI}}. |

#### A9 – Účty obsluhy v administraci

| Náležitost (čl. 30 odst. 1) | Obsah |
|---|---|
| **Účel** | Umožnit zaměstnancům a brigádníkům půjčovny práci s rezervacemi v administraci pod individuálním účtem s rolí (vlastník / obsluha), dvoufaktorovým ověřením a přehledem přihlášení; odebrat přístup při ukončení spolupráce. |
| **Právní základ** | Čl. 6 odst. 1 písm. b) GDPR – plnění pracovní smlouvy nebo dohody (účet je nástroj výkonu práce); čl. 6 odst. 1 písm. f) a čl. 32 GDPR – zabezpečení a odpovědnost za přístup k údajům zákazníků. Mzdová a personální agenda je samostatná činnost mimo systém (A.7). |
| **Kategorie subjektů údajů** | Zaměstnanci, brigádníci a jednatelé půjčovny s přístupem do administrace. |
| **Kategorie osobních údajů** | Jméno, pracovní e-mail, role, otisk hesla, tajemství dvoufaktorového ověření a záložní kódy (šifrovaně), čas a otisk IP posledních přihlášení, záznamy akcí v audit logu. |
| **Kategorie příjemců** | {{PROVOZOVATEL_NAZEV}} (zpracovatel); vlastník účtu půjčovny. |
| **Předání do třetí země** | Ne. |
| **Lhůty výmazu** | Účet se deaktivuje při ukončení spolupráce a maže po 30 dnech; záznamy přihlášení a audit log {{DOBA_LOGY}} (odkazy na smazaný účet zůstávají v audit logu jako identifikátor bez jména). |
| **Technická a organizační opatření** | Povinné dvoufaktorové ověření, zamykání účtu po opakovaných neúspěšných pokusech, oddělení rolí, žádné sdílené účty, ověření 2FA při změně hesla a e-mailu. |

#### A10 – Měření návštěvnosti webu [jen při zapnuté analytice {{ANALYTIKA_NASTROJ}}]

| Náležitost (čl. 30 odst. 1) | Obsah |
|---|---|
| **Účel** | Měřit návštěvnost a používání webu půjčovny nástrojem {{ANALYTIKA_NASTROJ}} pomocí cookies ukládaných do zařízení návštěvníka se souhlasem. Bez zapnuté analytiky tato činnost neprobíhá; web používá jen technicky nezbytné cookies a souhrnné statistiky ze serverových logů (A4). |
| **Právní základ** | Čl. 6 odst. 1 písm. a) GDPR – souhlas, a § 89 odst. 3 ZEK: kdo ukládá údaje do koncového zařízení uživatele nebo k nim získává přístup, potřebuje předem prokazatelný souhlas s rozsahem a účelem, s výjimkou technického uložení nezbytného pro přenos zprávy nebo pro službu, kterou si uživatel výslovně vyžádal. Souhlas je kdykoli odvolatelný (čl. 7 odst. 3 GDPR). |
| **Kategorie subjektů údajů** | Návštěvníci webu, kteří v liště udělili souhlas. |
| **Kategorie osobních údajů** | Identifikátor cookie, navštívené stránky, zdroj návštěvy, typ zařízení a prohlížeče, přibližná poloha podle IP; záznam o volbě v liště. **Nezpracovává se:** spojení s rezervací nebo zákaznickým profilem, předávání reklamním sítím. |
| **Kategorie příjemců** | {{ANALYTIKA_POSKYTOVATEL}} (role podle uvedeného nastavení: zpracovatel se smlouvou podle čl. 28, nebo samostatný správce); {{PROVOZOVATEL_NAZEV}} (vložení skriptu a lišty). |
| **Předání do třetí země** | Jen pokud poskytovatel nástroje zpracovává mimo EU – pak na základě čl. 45 nebo čl. 46 odst. 2 písm. c) GDPR s uvedením v Zásadách (oddíl 6) a v A.5. |
| **Lhůty výmazu** | Volba v liště: souhlas 12 měsíců, odmítnutí 6 měsíců, pak se web zeptá znovu. Analytické údaje podle nastavení nástroje, nejdéle 14 měsíců. |
| **Technická a organizační opatření** | Lišta bez předvyplněných voleb, tlačítko Odmítnout rovnocenné s Přijmout, žádný analytický skript před volbou; odvolání souhlasu v patičce webu; doporučen nástroj bez cookies nebo provozovaný v EU, pak lišta ani tato činnost nejsou potřeba. |

### A.4 Příjemci – společný přehled (čl. 30 odst. 1 písm. d))

| Příjemce | Role podle GDPR | Činnosti | Co dostává |
|---|---|---|---|
| {{PROVOZOVATEL_NAZEV}}, IČO {{PROVOZOVATEL_ICO}} | zpracovatel (čl. 28), Smlouva o zpracování osobních údajů ze dne {{SMLOUVA_ZPRACOVANI_DATUM}} | A1–A10 | všechny údaje v systému; k databázi půjčovny přistupuje jen při řešení závady nebo incidentu, pod individuálním účtem s 2FA, se záznamem v audit logu; šifrovaná pole nedešifruje (B.3, řádek B6) |
| {{HOSTING_NAZEV}} | podzpracovatel provozovatele | A1–A9 | fyzické uložení dat a šifrovaných záloh v EU; bez přístupu k obsahu |
| {{EMAIL_SLUZBA_NAZEV}} | podzpracovatel provozovatele | A1, A2, A5, A6, A8 | e-mailová adresa a obsah zprávy po dobu doručení |
| {{PLATEBNI_BRANA_NAZEV}} | samostatný správce | A2, A3 | údaje k platbě kartou a preautorizaci kauce (zadává zákazník přímo bráně) |
| [jen je-li vyplněn {{TERMINAL_POSKYTOVATEL}}] {{TERMINAL_POSKYTOVATEL}} | samostatný správce | A2, A3 | karetní platby na místě (doplatek, kauce, náhrady); půjčovna eviduje jen částku, čas a číslo transakce |
| {{BANKA_NAZEV}} | samostatný správce | A2 | příchozí platby; systém čte výpis přes rozhraní banky |
| [jen je-li vyplněn {{UCETNI_NAZEV}}] {{UCETNI_NAZEV}} | {{UCETNI_ROLE}} | A2 | doklady a účetní záznamy, nikdy údaje z dokladů totožnosti |
| [jen je-li vyplněn {{POJISTOVNA_NAZEV}}] {{POJISTOVNA_NAZEV}} | samostatný správce | A7 | jméno nájemce a údaje o výpůjčce a škodě při pojistné události; číslo dokladu jen na odůvodněnou žádost při šetření krádeže |
| Policie ČR, soudy, exekutoři, ČOI, finanční správa, ÚOOÚ | samostatní správci / orgány veřejné moci | A2, A3, A5, A7, A8 | jen při konkrétním případě, dožádání nebo kontrole, v nezbytném rozsahu |
| {{MAPOVE_PODKLADY}} | samostatní správci | A4 | IP adresa a typ prohlížeče při načtení mapy po kliknutí |
| [jen při zapnuté analytice] {{ANALYTIKA_POSKYTOVATEL}} | podle nastavení (zpracovatel / samostatný správce) | A10 | údaje o používání webu po souhlasu |
| Obsluha půjčovny | osoby jednající z pověření správce (čl. 29, čl. 32 odst. 4) | A1–A9 | podle role; mlčenlivost sjednána v pracovní smlouvě / dohodě |

Údaje se nepředávají reklamním sítím, sociálním sítím, zprostředkovatelům ani jiným půjčovnám na platformě; provozovatel údaje zákazníků různých půjčoven nespojuje. Poskytovatel DNS, registrátor domény a certifikační autorita osobní údaje zákazníků nedostávají (Smlouva o zpracování, čl. 9.6).

### A.5 Předání do třetích zemí (čl. 30 odst. 1 písm. e))

**Nepředává se.** Všechny činnosti A1–A9 probíhají v EU: servery a zálohy u {{HOSTING_NAZEV}}, e-mailová služba {{EMAIL_SLUZBA_NAZEV}} s provozem v EU, platební brána a banka v ČR, provozovatel v ČR. Web nenačítá písma, skripty ani knihovny z cizích CDN. [jen při zapnuté analytice] U A10 závisí na poskytovateli {{ANALYTIKA_POSKYTOVATEL}} – zpracovává-li mimo EU, uvede se zde příjemce, země a nástroj předání (rozhodnutí Komise podle čl. 45, nebo standardní smluvní doložky podle čl. 46 odst. 2 písm. c) GDPR s posouzením dopadu) a nejprve se aktualizují Zásady (oddíl 6). Totéž platí, pokud by se předání stalo nezbytným u některého podzpracovatele.

### A.6 Obecný popis technických a organizačních opatření (čl. 30 odst. 1 písm. g), čl. 32 GDPR)

Podrobný popis opatření je v Příloze 2 Smlouvy o zpracování osobních údajů; zde jen obecný přehled.

| Oblast | Opatření |
|---|---|
| Šifrování a pseudonymizace (čl. 32 odst. 1 písm. a)) | Přenos jen přes HTTPS. Šifrované disky a zálohy. **Aplikační šifrování (AES-256-GCM, klíč mimo databázi, verzovaný pro rotaci) jména, e-mailu, telefonu, adresy, data narození, typu a čísla dokladu, obrázku podpisu a výrobních čísel kol; e-mail navíc jako otisk pro vyhledání; IP adresy v logu a u souhlasů jen jako otisky.** Audit log s otisky (hash) místo hodnot. Anonymizace po uplynutí lhůt místo „měkkého“ smazání. |
| Důvěrnost, integrita, dostupnost, odolnost (písm. b)) | Samostatná databáze, šifrovací klíč a doména pro každou půjčovnu; automatizované testy, že přes web jedné půjčovny nelze číst data jiné. Individuální účty s povinným dvoufaktorovým ověřením, role vlastník / obsluha, odebrání přístupu při odchodu. Zabezpečené relace a formuláře (ochrana proti podvržení požadavků a vložení kódu), kontrola všech vstupů na serveru. Zpomalení a blokace při opakovaných pokusech. Částky plateb jen ze serveru, ověření stavu u brány. Minimalizace: žádné kopie dokladů, žádná karetní data, žádné osobní údaje v provozních lozích. Knihovny třetích stran jen v ověřených, připnutých verzích s kontrolou zranitelností. |
| Obnova dostupnosti (písm. c)) | Denní šifrované zálohy mimo produkční server (retence 7 dní / 4 týdny / {{DOBA_ZALOHY}}), průběžná replikace databáze, monitoring dostupnosti; test obnovy ze zálohy čtvrtletně s písemným záznamem. |
| Pravidelné testování a hodnocení (písm. d)) | Automatizované bezpečnostní testy při každém nasazení, skenování zranitelností; roční revize zabezpečení podle uznávaného standardu (OWASP ASVS); roční revize tohoto záznamu, Zásad a Smlouvy o zpracování. |
| Organizační opatření | Smlouva o zpracování podle čl. 28 odst. 3 s provozovatelem, seznam podzpracovatelů a právo námitky (čl. 28 odst. 2 a 4). Mlčenlivost obsluhy. Provozní řád výdeje: kontrola dokladu nahlédnutím, [VARIANTA DOKLAD-A] zápis jen typu a čísla (u občanského průkazu se souhlasem nebo alternativa), [VARIANTA DOKLAD-B] bez zápisu čísla, zákaz kopírování a focení, zákaz zadržení dokladu. Plán reakce na incidenty: kontakty, kdo rozhoduje, šablona ohlášení ÚOOÚ do 72 h, interní evidence každého incidentu, hlášení provozovatele půjčovně do {{LHUTA_OHLASENI_INCIDENTU}}. Oddělená prostředí vývoj / testování / produkce, žádná produkční data ve vývoji. Automatický výmaz a anonymizace podle lhůt v tomto záznamu. Export a výmaz údajů zákazníka na jedno kliknutí. [při {{PODPIS_ZPUSOB}} = papir] Listinné stejnopisy v uzamčené skříni, přístup jen oprávněná obsluha, skartace po lhůtě. |

### A.7 Co v tomto záznamu není a půjčovna si doplní sama

Systém pokrývá jen zpracování, které probíhá v rezervačním systému a na webu. Záznam správce musí být **úplný**, proto půjčovna v administraci doplní své další činnosti, typicky:

| Činnost mimo systém | Poznámka |
|---|---|
| Mzdová a personální agenda zaměstnanců a brigádníků | podle WP29 nikdy není „příležitostná“; **zahrnuje zvláštní kategorii údajů – údaje o zdravotním stavu (pracovní neschopnost, lékařské prohlídky), čl. 9 odst. 2 písm. b) GDPR** – i proto se výjimka čl. 30 odst. 5 neuplatní; právní základ čl. 6 odst. 1 písm. b) a c) (zákoník práce, zákon o daních z příjmů, pojistné předpisy); lhůty podle předpisů o archivaci mzdových listů |
| Kamerový systém v provozovně nebo na stojanech kol | samostatná činnost na základě oprávněného zájmu s balančním testem a informační cedulí; metodika ÚOOÚ ke kamerovým systémům |
| [při {{GPS_LOKATORY}} = ano] Sledování polohy kol lokátorem během výpůjčky | samostatná činnost (oprávněný zájem – ochrana majetku); před zapnutím posouzení vlivu (čl. 35 – kritérium sledování polohy v seznamu ÚOOÚ), poloha se čte jen při nevrácení, krádeži nebo nahlášené nehodě, výmaz do 7 dnů po vrácení (Zásady, oddíl 3 ř. 11) |
| Evidence hostů, pokud půjčovnu provozuje hotel nebo penzion | zákon o místních poplatcích a zákon o pobytu cizinců – jiný správce není, ale je to jiná činnost s jinými lhůtami |
| Ruční evidence mimo systém (sešit, tabulka, poznámky) | doporučujeme nevést; pokud existuje, uvést ji zde a dodržet stejné lhůty a zákaz kopií dokladů. Listinné smlouvy a protokoly při {{PODPIS_ZPUSOB}} = papir jsou už popsány v A1 a nedoplňují se znovu |
| Firemní zákazníci, dodavatelé, servis kol | kontakty podnikatelů a jejich zástupců – čl. 6 odst. 1 písm. b) a f) |
| Vlastní marketing mimo systém (sociální sítě, tištěné letáky se soutěží) | podle použitého nástroje; sociální sítě mohou zakládat společné správcovství se sítí |

---

## Část B – Záznam zpracovatele podle čl. 30 odst. 2 GDPR

Část B generuje systém jen pro provozovatele; půjčovna v ní vidí pouze svůj řádek v B.2. Hodnoty lhůt a seznam podzpracovatelů jsou převzaty z téhož nastavení jako Smlouva o zpracování osobních údajů (čl. 9, 11, 12 a Příloha 3) – záznam je neopisuje.

### B.1 Identifikace zpracovatele (čl. 30 odst. 2 písm. a))

| Položka | Údaj |
|---|---|
| Zpracovatel | **{{PROVOZOVATEL_NAZEV}}**, IČO {{PROVOZOVATEL_ICO}} |
| Sídlo | {{PROVOZOVATEL_SIDLO}} |
| Kontakt | {{PROVOZOVATEL_EMAIL}} |
| Osoba odpovědná za ochranu údajů a incidenty | {{PROVOZOVATEL_ODPOVEDNA_OSOBA}} |
| Pověřenec (čl. 37) | nejmenován – hlavní činností je provoz rezervačního systému, nikoli rozsáhlé systematické monitorování osob ani zpracování zvláštních kategorií (čl. 37 odst. 1 písm. b) a c)); viz K ověření, bod 15 |
| Zástupce (čl. 27) | není třeba – usazen v EU |
| Výjimka čl. 30 odst. 5 | neuplatní se – zpracování pro správce je hlavní, nepřetržitou činností (oddíl 1) |

### B.2 Správci, pro které zpracovatel jedná (čl. 30 odst. 2 písm. a))

Pro každou půjčovnu na platformě platí samostatná Smlouva o zpracování osobních údajů podle čl. 28 odst. 3 GDPR, uzavřená při onboardingu. Řádky tabulky generuje systém z databáze platformy ({{SEZNAM_SPRAVCU}}); první řádek ukazuje šablonu řádku.

| Správce (půjčovna) | IČO | Kontakt správce | Pověřenec / zástupce správce | Web na platformě | Smlouva o zpracování od | Stav |
|---|---|---|---|---|---|---|
| {{PUJCOVNA_NAZEV}} | {{PUJCOVNA_ICO}} | {{PUJCOVNA_EMAIL}} | nejmenován (není-li ve smlouvě uvedeno jinak) | `https://{{WEB_SUBDOMENA}}` | {{SMLOUVA_ZPRACOVANI_DATUM}} | aktivní |

Po ukončení smlouvy se správcem se řádek přesune do historie s datem ukončení a datem výmazu nebo předání dat (čl. 28 odst. 3 písm. g); Smlouva o zpracování, čl. 13).

### B.3 Kategorie zpracování prováděného pro každého správce (čl. 30 odst. 2 písm. b))

Pro všechny správce provádí zpracovatel stejné kategorie zpracování; liší se jen nastavení (brána, banka, lhůty, nakládání s dokladem), které určuje správce.

| # | Kategorie zpracování | Pro činnosti správce | Co zpracovatel konkrétně dělá | Pokyn správce |
|---|---|---|---|---|
| B1 | Provoz webu a rezervačního systému na subdoméně správce | A1, A5, A6, A10 | hostování aplikace a databáze půjčovny, zpracování rezervací, výpočet dostupnosti a ceny, generování dokumentů z šablon, odesílání transakčních e-mailů přes podzpracovatele | Smlouva o zpracování + nastavení v administraci |
| B2 | Ukládání a šifrování údajů | A1–A9 | samostatná databáze per správce, aplikační šifrování citlivých polí, správa klíčů (zpracovatel klíče drží, ale šifrovaná pole mimo běh aplikace nedešifruje – organizační pravidlo, viz K ověření, bod 16) | Smlouva o zpracování |
| B3 | Zpracování plateb (bez karetních dat) | A2, A3 | vytvoření platby u brány správce, ověření stavu, zpracování notifikací, vytvoření preautorizace kauce a její uvolnění/stržení na pokyn obsluhy, generování QR plateb, načítání výpisu z banky správce přístupem jen pro čtení a párování plateb, vedení účetního deníku, generování dokladů, export pro účetní | nastavení brány, banky, storno pravidel a režimu DPH správcem; každé stržení kauce potvrzuje obsluha správce |
| B4 | Zálohování a obnova | A1–A9 | denní šifrované zálohy mimo produkční server, průběžná replikace, snapshoty, test obnovy čtvrtletně; obnova na žádost správce nebo po havárii | Smlouva o zpracování |
| B5 | Logování, monitoring a bezpečnost | A4 | provozní a bezpečnostní logy, audit log, omezení počtu požadavků, monitoring dostupnosti, detekce útoků, bezpečnostní aktualizace, zpracování incidentů a jejich hlášení správci do {{LHUTA_OHLASENI_INCIDENTU}} | Smlouva o zpracování (čl. 12) |
| B6 | Technická podpora s přístupem k údajům | A1–A9 | přístup k databázi správce jen při řešení závady nebo incidentu, pod individuálním účtem s 2FA, se záznamem v audit logu správce; bez dešifrování citlivých polí; žádné kopírování údajů mimo systém | jen na žádost správce nebo při incidentu; každý přístup viditelný správci |
| B7 | Automatický výmaz, anonymizace a výkon práv subjektů | A1–A9, A8 | automatický výmaz a anonymizace podle lhůt nastavených správcem, export údajů zákazníka, výmaz/anonymizace na pokyn obsluhy správce, blokační seznam pro marketing; předání žádosti subjektu doručené zpracovateli správci (Smlouva o zpracování, čl. 11.2) | lhůty a jednotlivé žádosti určuje správce |
| B8 | Ukončení služby | A1–A9 | po skončení smlouvy export celé databáze správci ve strojově čitelném formátu a následný výmaz databáze, klíčů a záloh (zálohy nejpozději po {{DOBA_ZALOHY}}) s písemným potvrzením (čl. 28 odst. 3 písm. g); Smlouva o zpracování, čl. 13) | volba správce: vrátit, nebo smazat |

**Co zpracovatel nedělá:** nespojuje údaje zákazníků různých půjčoven, nepoužívá je pro vlastní marketing, analytiku ani vývoj (vývoj a testy běží na anonymizovaných datech), nepředává je třetím stranám mimo schválené podzpracovatele, nezpracovává karetní data ani kopie dokladů.

### B.4 Podzpracovatelé (čl. 28 odst. 2 a 4)

Správce udělil obecné písemné povolení k zapojení podzpracovatelů uvedených v tomto seznamu (Smlouva o zpracování, čl. 9.1 a Příloha 3). O každé zamýšlené změně zpracovatel správce informuje nejméně **{{LHUTA_OZNAMENI_PODZPRACOVATELE}}** předem; správce může do **{{LHUTA_NAMITKY}}** od doručení oznámení vznést odůvodněnou námitku (čl. 9.2); naléhavá výměna vyvolaná bezpečností nebo dostupností služby se oznamuje nejpozději do 5 pracovních dnů po zapojení se zachovaným právem námitky a výpovědi (čl. 9.3–9.4). Podzpracovatelé jsou smluvně vázáni stejnými povinnostmi (čl. 28 odst. 4).

| Podzpracovatel | Služba | Země zpracování | Kategorie | Zapojen od |
|---|---|---|---|---|
| {{HOSTING_NAZEV}} | virtuální servery, úložiště záloh, snapshoty | EU (Německo, Finsko) | B1, B2, B4, B5 | {{UCINNOST_OD}} |
| {{EMAIL_SLUZBA_NAZEV}} | odesílání transakčních e-mailů a obchodních sdělení správce | EU | B1 | {{UCINNOST_OD}} |

**Nejsou podzpracovateli** (Smlouva o zpracování, čl. 9.6): platební brána {{PLATEBNI_BRANA_NAZEV}}, poskytovatel terminálu a banka {{BANKA_NAZEV}} – správce má s nimi vlastní smlouvu a vystupují jako samostatní správci, zpracovatel pouze volá jejich rozhraní jménem správce s přístupovými údaji, které správce vložil do nastavení; certifikační autorita Let's Encrypt, poskytovatel DNS {{DNS_POSKYTOVATEL}} a registrátor domény – osobní údaje zákazníků nedostávají (jen názvy domén a DNS záznamy); poskytovatel analytického nástroje ({{ANALYTIKA_POSKYTOVATEL}}, je-li zapnut) – smluvní partner správce, nikoli zpracovatele.

### B.5 Předání do třetích zemí (čl. 30 odst. 2 písm. c))

**Nepředává se.** Všichni podzpracovatelé zpracovávají v EU. Před případným zapojením podzpracovatele mimo EU/EHP (typicky e-mailové služby) zpracovatel: (1) informuje všechny správce {{LHUTA_OZNAMENI_PODZPRACOVATELE}} předem, (2) uzavře standardní smluvní doložky podle čl. 46 odst. 2 písm. c) GDPR nebo se opře o rozhodnutí Komise podle čl. 45, (3) provede a správcům zpřístupní posouzení dopadu předání, (4) aktualizuje tento záznam a šablonu Zásad (Smlouva o zpracování, čl. 10.3).

### B.6 Technická a organizační opatření zpracovatele (čl. 30 odst. 2 písm. d), čl. 32 GDPR)

Platí opatření uvedená v A.6 – zpracovatel je zavádí a provozuje pro všechny správce; podrobně Příloha 2 Smlouvy o zpracování. Nad rámec toho na úrovni platformy:

| Oblast | Opatření |
|---|---|
| Izolace správců | databáze, šifrovací klíč, přístupové údaje k bráně a bance a doména zvlášť pro každou půjčovnu; cookies se nesdílejí mezi subdoménami; automatizovaný test, že přes doménu jedné půjčovny nelze číst data jiné |
| Správa tajemství | klíče a přístupové údaje mimo zdrojový kód a mimo databázi, s omezenými právy; pravidelná rotace šifrovacích klíčů a přístupu k bance; přístup k DNS pro vydávání certifikátů omezený na jednu zónu |
| Přístup pracovníků zpracovatele | individuální účty, povinné 2FA, přístup k serverům jen klíčem a jen z vyjmenovaných zařízení; každý servisní přístup do databáze správce zapsán do jeho audit logu; mlčenlivost ve smlouvách s pracovníky (čl. 28 odst. 3 písm. b)) |
| Dodavatelský řetězec | knihovny třetích stran jen v ověřených, připnutých verzích; kontrola zranitelností při každém nasazení; automatické bezpečnostní aktualizace systému |
| Incidenty | plán reakce, hlášení správci bez zbytečného odkladu, nejpozději do {{LHUTA_OHLASENI_INCIDENTU}} od zjištění (čl. 33 odst. 2 GDPR; Smlouva o zpracování, čl. 12), se všemi informacemi potřebnými pro ohlášení ÚOOÚ do 72 h; interní evidence každého incidentu |
| Součinnost se správcem | export a výmaz údajů subjektu v administraci; předání žádosti subjektu doručené zpracovateli správci (čl. 11.2); součinnost nad rámec funkcí administrace do **{{LHUTA_SOUCINNOSTI}}** (čl. 11.3, 12.6); umožnění auditu správcem nebo jím pověřeným auditorem po dohodě termínu (čl. 28 odst. 3 písm. h); čl. 14); zpřístupnění výsledků bezpečnostních testů |
| Prostředí a testy | oddělené prostředí vývoj / testování / produkce, anonymizovaná testovací data, žádná produkční data na pracovních stanicích |
| Dokumentace | tento záznam, seznam podzpracovatelů, protokol z testu obnovy, roční revize zabezpečení, verzování smluv a šablon dokumentů |

### B.7 Kde provozovatel vystupuje jako správce (mimo tento záznam)

Provozovatel je zároveň **samostatným správcem** pro údaje, které zpracovává pro vlastní účely, a vede pro ně vlastní záznam podle čl. 30 odst. 1 (není součástí této šablony). Jde zejména o: kontaktní a fakturační údaje půjčoven a jejich kontaktních osob (plnění smlouvy o poskytování platformy, účetnictví), účty vlastníků půjčoven v administraci platformy, logy a bezpečnostní monitoring **na úrovni celé platformy** (ochrana před útoky na infrastrukturu – zájem provozovatele), marketing platformy vůči půjčovnám a veřejná část webu platformy. Zda jsou bezpečnostní logy na úrovni platformy zpracováním správce, nebo zpracovatele, viz K ověření, bod 14.

---

## Historie verzí a revizí

| Verze | Platnost od | Revize | Změna |
|---|---|---|---|
| {{VERZE}} | {{UCINNOST_OD}} | {{DATUM_REVIZE}} | první vydání, generováno z nastavení půjčovny a platformy |

---

## Použité předpisy a zdroje

Zkratky: **GDPR** – nařízení Evropského parlamentu a Rady (EU) 2016/679; **OZ** – zákon č. 89/2012 Sb., občanský zákoník; **ZOS** – zákon č. 634/1992 Sb., o ochraně spotřebitele; **ZDPH** – zákon č. 235/2004 Sb., o dani z přidané hodnoty; **ZDP** – zákon č. 586/1992 Sb., o daních z příjmů; **ZEK** – zákon č. 127/2005 Sb., o elektronických komunikacích; zákon č. 269/2021 Sb., o občanských průkazech; zákon č. 329/1999 Sb., o cestovních dokladech; zákon č. 361/2000 Sb., o silničním provozu; zákon č. 480/2004 Sb., o některých službách informační společnosti; zákon č. 563/1991 Sb., o účetnictví; zákon č. 280/2009 Sb., daňový řád; zákon č. 141/1961 Sb., trestní řád.

Znění předpisů ověřeno 5. 10. 2026 (návrh a dvě oponentury): GDPR čl. 4 bod 14, čl. 9, 28, 30, 32, 33, 35, 37; OZ § 629, § 636 odst. 1–3, § 640, § 1837 písm. j), § 2201, § 2321–2325, § 2910, § 2913 (znění od 1. 1. 2026); zákon č. 269/2021 Sb. § 39 písm. b), c), d) a § 65 odst. 1 (znění od 1. 1. 2026); zákon č. 329/1999 Sb. § 2 odst. 2 a 3, § 34a odst. 1 písm. i); zákon č. 361/2000 Sb. § 58; zákon č. 480/2004 Sb. § 7 odst. 2–4; zákon o účetnictví § 31 odst. 2 (novela č. 316/2025 Sb. účinná od 1. 1. 2026 lhůty nemění; nový zákon o účetnictví je v legislativním procesu); ZDP § 7b odst. 5; daňový řád § 148; ZOS § 14 odst. 1 a 2, § 16 odst. 1, § 19, § 20e, § 20p (znění od 20. 8. 2025); ZEK § 89 odst. 3; ZDPH § 20a odst. 2 a 3, § 28 odst. 1 písm. d) a odst. 5, § 30, § 35 odst. 2, § 35a (znění od 1. 1. 2026; § 35 a § 35a z sekundárních zdrojů – K ověření, bod 5); trestní řád § 8 odst. 1.

Judikatura k režimu DPH u ponechané části poplatku (K ověření, bod 4): SDEU C-277/05 Société thermale d'Eugénie-les-Bains (propadlá záloha při zrušení = paušální náhrada mimo DPH); C-250/14 a C-289/14 Air France-KLM / Hop!-Brit Air (nevyužité letenky = úplata podléhající DPH); C-242/18 UniCredit Leasing; C-43/19 Vodafone Portugal.

Stanoviska a metodiky: WP29, *Position Paper on the derogations from the obligation to maintain records of processing activities pursuant to Article 30(5) GDPR* (19. 4. 2018); ÚOOÚ, *Základní příručka k ochraně údajů* (část o záznamech o činnostech zpracování, včetně základního vzoru pro nejmenší správce); ÚOOÚ, *Prokazování totožnosti a zpracování osobních údajů* (13. 5. 2021) – včetně kontrolního případu půjčovny sportovního vybavení, která podmiňovala výpůjčku kopií dokladu se souhlasem vloženým do smlouvy (posouzeno jako porušení – souhlas nebyl svobodný), a případu autopůjčovny, kde obsluha při odmítnutí kopie pouze ověří totožnost a opíše potřebné údaje (ÚOOÚ nerozporuje; materiál vznikl za zákona č. 328/1999 Sb., před účinností § 39 písm. d) zákona č. 269/2021 Sb.); ÚOOÚ, *Metodika k plnění informační povinnosti*; seznam ÚOOÚ druhů operací zpracování podléhajících posouzení vlivu; Evropská komise, návrhy Omnibus IV (21. 5. 2025) a Digitální omnibus (19. 11. 2025) ke změně čl. 30 odst. 5 GDPR.

Související dokumenty platformy: Obchodní podmínky půjčovny ({{PODMINKY_URL}}), Zásady ochrany osobních údajů ({{ZASADY_URL}}), Smlouva o zpracování osobních údajů ze dne {{SMLOUVA_ZPRACOVANI_DATUM}}, šablona Smlouvy o nájmu jízdního kola a předávacího protokolu (část D – co se ukládá do systému), interní podklady k platbám a DPH a k bezpečnosti, GDPR a praxi půjčoven.

---

<!-- INTERNI: nerenderovat -->

## K ověření advokátem

Jen body, které jsou sporné nebo vyžadují rozhodnutí půjčovny, provozovatele či zadavatele. Číslování odpovídá odkazům v textu výše. Citace ověřené oponenturou z primárních zdrojů (§ 629, § 636, § 640, § 1837 písm. j), § 2201, § 2321 a násl. OZ; § 14, § 16 odst. 1, § 19, § 20e, § 20p ZOS; § 20a, § 28, § 35 odst. 2, § 35a ZDPH; § 31 odst. 2 zákona o účetnictví; § 7b odst. 5 ZDP; § 148 daňového řádu; § 7 zákona č. 480/2004 Sb.; § 39 a § 65 zákona č. 269/2021 Sb.; § 2 odst. 3 a § 34a zákona č. 329/1999 Sb.; § 58 zákona č. 361/2000 Sb.) se zde neopakují.

**Právní základy a údaje**

1. **(A3, parametr `{{DOKLAD_REZIM}}`) Zápis čísla občanského průkazu a § 39 písm. d) zákona č. 269/2021 Sb. – rozhodnutí mezi variantou A a B.** Písm. d) zakazuje zpracovávat údaje uvedené v občanském průkazu bez souhlasu držitele; výjimka platí jen pro nahlédnutí při ověřování totožnosti, které vyžaduje nebo umožňuje právní předpis. Zápis čísla do systému je zpracování, ne nahlédnutí; oprávněný zájem zákonný zákaz nepřebije. Stanovisko ÚOOÚ z 13. 5. 2021, o které se balanční test A opírá, vzniklo před účinností zákona (2. 8. 2021). Porušení písm. d) podle oponentury není přestupkem (§ 65 odst. 1 sankcionuje jen písm. a), b), c) a e)) – z primárního zdroje jednoznačně nepotvrzeno; dopad je každopádně v rovině GDPR (zpracování bez titulu). Šablona nabízí: **varianta A (`souhlas`, výchozí)** – u OP zápis čísla jen se souhlasem zaznamenaným v protokolu a s reálnou alternativou (pas / řidičský průkaz na základě oprávněného zájmu, nebo kauce v plné hodnotě kola), aby byl souhlas svobodný; **varianta B (`bez-cisla`)** – číslo se nezapisuje, obsluha nahlédne a zapíše jméno, datum narození a adresu (titul písm. b), podpůrně f)). Rozhodnout: (a) kterou variantu použít; (b) zda lze u OP dovodit, že zápis čísla při uzavírání smlouvy je „ověřování totožnosti, které umožňuje právní předpis“ (OZ) – tuto cestu označujeme za právně nejistou; (c) zda ve variantě B obstojí titul písm. b); (d) zda je rozdílné zacházení podle typu dokladu pro zákazníka srozumitelné, nebo je lepší jednotná varianta B. Přepínač v administraci umožní změnu bez zásahu do kódu; rozhodnutí musí být shodné pro Zásady, OP čl. 8.3, protokol a tento záznam.
2. **(A1, A3, parametr `{{ZAPISOVAT_NAROZENI_ADRESU}}`) Datum narození a adresa.** K žalobě je třeba žalovaného označit jménem, datem narození a bydlištěm; číslo dokladu nestačí. Ve variantě A je zápis volitelný (rozhodnutí půjčovny mezi minimalizací a vymahatelností), ve variantě B povinný. Posoudit titul: nezbytná součást smlouvy (písm. b)) nebo oprávněný zájem (písm. f)).
3. **(A1, A.2) Kolo jako dopravní prostředek.** Záznam i Zásady a OP kvalifikují smlouvu jednotně jako nájem dopravního prostředku (§ 2321 a násl. OZ) a o totéž opírají vyloučení odstoupení (§ 1837 písm. j)). Potvrdit kvalifikaci; pokud advokát zvolí jen „využití volného času“, upravit poučení v A1, OP i Zásadách. Zároveň upozorňujeme, že **OP čl. 8.3 dosud uvádí zápis čísla dokladu na základě oprávněného zájmu bez variant** – po rozhodnutí v bodu 1 sladit OP se Zásadami a tímto záznamem (mimo tuto šablonu).
4. **(A2, parametr `{{STORNO_DPH_REZIM}}`) Právní povaha a režim DPH u ponechané části rezervačního poplatku – posoudit s advokátem i daňovým poradcem.** Dokumenty projektu se zatím liší: OP čl. 6.2 ji označují za „sjednané paušální vypořádání zálohy (§ 1807 OZ)“ při smluvním právu odstoupit (§ 2001), plán platforma ji nazývá „smluvní pokuta/odstupné“ a předpokládá opravný doklad vždy, rešerše uvádí smluvní pokutu (§ 2048, moderace § 2051, test § 1813) nebo odstupné (§ 1992 – musí být výslovně ujednáno). Režim DPH: C-277/05 (propadlá záloha při zrušení mimo DPH) vs. C-250/14 a C-289/14 Air France-KLM, C-242/18, C-43/19 (nevyužité plnění = úplata podléhající DPH) – zejména u 0 % vratky při nevyzvednutí (no-show, OP čl. 6.5) může správce daně dovodit úplatu za plnění. Rozhodnout kvalifikaci jednotně pro OP, plán a záznam; u plátce DPH nastavit `{{STORNO_DPH_REZIM}}`, případně odlišně pro zrušení (50 % / 100 % vratky) a no-show. Záznam proto používá neutrální formulaci.
5. **(A2) Daňové a účetní lhůty.** (a) Primární znění § 35 odst. 2 a § 35a ZDPH se nepodařilo načíst; lhůta 10 let od konce zdaňovacího období, ve kterém se plnění uskutečnilo, je z více sekundárních zdrojů – zkontrolovat primární text včetně toho, od čeho se počítá u daňového dokladu k přijaté úplatě. (b) § 28 odst. 5 ZDPH (15 dnů) ověřeno ze sekundárního zdroje ve znění 2026 – potvrdit. (c) Zjednodušený daňový doklad (§ 30) u plateb spotřebitelů do 10 000 Kč – potvrdit, že vyhovuje i konečnému dokladu se započtením poplatku a opravnému dokladu. (d) U paušální daně ověřit, zda a jaké doklady poplatník uchovává. (e) Po přijetí nového zákona o účetnictví aktualizovat odkazy na § 31.
6. **(A3, parametr `{{DRUHY_DOKLAD}}`) Druhý doklad.** České půjčovny běžně vyžadují dva doklady. Zásady a tento záznam volí, že druhý doklad se **pouze předkládá a nic se z něj nezapisuje** (minimalizace, stanovisko ÚOOÚ – stačí předložení); oponentura navrhovala alternativně zápis typu a čísla obou dokladů s parametrem počtu. Potvrdit zvolené řešení; pokud by advokát připustil zápis druhého čísla, vyžaduje to druhé šifrované pole v databázi zákazníka a stejnou lhůtu `{{DOBA_CISLO_DOKLADU}}` – do té doby volbu nepovolit.
7. **(A1) Otisk IP adresy u souhlasu s OP** na základě písm. f) po dobu `{{DOBA_SMLOUVA}}` – hash IP je stále osobní údaj; potvrdit titul a dobu (shodně se Zásadami, bod 17).
8. **(A1) Podpis na obrazovce a fotodokumentace.** Obrázek podpisu uchováváme s protokolem po `{{DOBA_SMLOUVA}}`; potvrdit, že statický obrázek bez dynamických charakteristik není biometrický údaj (čl. 4 bod 14, čl. 9 GDPR). U fotografií kol potvrdit, že náhodné zachycení osob v pozadí nevyžaduje další informaci a že odstranění údajů o poloze z fotografií stačí.
9. **(A1) Děti.** Záznam uvádí, že při rezervaci dětského kola, sedačky nebo vozíku se může v poznámce objevit věk nebo výška dítěte (bez jména) – jako součást rezervačních údajů. Zásady (oddíl 2, „Děti“) dosud říkají „údaje o dětech nezaznamenáváme“; po potvrzení formulace sladit Zásady (mimo tuto šablonu). Poučení podle § 58 zákona č. 361/2000 Sb. je v OP čl. 9.2 – potvrdit, že do záznamu nepatří nic dalšího.

**Lhůty**

10. **(A1, A.2) Lhůta u zrušené rezervace.** Shodně se Zásadami (oddíl 4) držíme osobní údaje zrušené rezervace `{{DOBA_SMLOUVA}}` od storna (nároky z vratky, § 629 odst. 1 OZ). Oponentura považuje 3 roky dat (jméno, e-mail, telefon, otisk IP) u storna s plnou vratkou za dlouhé a navrhuje samostatný parametr (1–3 roky) nebo anonymizaci po 1 roce s uchováním jen dokladu o vratce podle A2. Rozhodnout; při zavedení samostatného parametru ho doplnit i do Zásad.
11. **(A7) Zdravotní údaje při nehodě.** Pokud zákazník sám sdělí zranění, jde o zvláštní kategorii (čl. 9). Navrhujeme čl. 9 odst. 2 písm. f) (obhajoba právních nároků) s uložením jen v nezbytném rozsahu. Ověřit, zda stačí, nebo zda má být A7 od začátku vedena jako činnost, která „může zahrnovat“ zvláštní kategorie. Dále potvrdit horní hranice lhůt v A7 (§ 636 odst. 1 a 2, § 640 OZ) a výchozí lhůty obecně (smlouva 3 roky, číslo dokladu 30 dní, logy 12 měsíců, komunikace 1 rok, nedokončená rezervace 90 dní, žádosti 3 roky, incidenty 5 let, zálohy 12 měsíců – zejména zda 12 měsíců u záloh obstojí jako řešení práva na výmaz a zda 5 let u incidentů není zbytečně dlouho; shodně se Zásadami, body 7–8).

**Příjemci, předání a smlouvy**

12. **(A.5, B.5) Předání mimo EU** závisí na dosud nevybrané e-mailové službě. EU–US Data Privacy Framework je právně nejistý (věc Latombe u SDEU); doporučujeme poskytovatele s provozem v EU. Při volbě americké služby doplnit standardní smluvní doložky, posouzení dopadu a změnit odpověď „Nepředává se“ v A.5 a B.5 (shodně se Zásadami, bod 12).
13. **(A.1, A.7, parametr `{{GPS_LOKATORY}}`) Posouzení vlivu.** Tvrdíme, že DPIA není nutná. Ověřit proti seznamu ÚOOÚ druhů operací podléhajících DPIA; při nasazení GPS lokátorů na kola (kritérium „sledování polohy“) by DPIA byla nutná a záznam by se rozšířil o samostatnou činnost – administrace to při přepnutí `{{GPS_LOKATORY}}` vyžaduje.
14. **(B.7, A4) Role provozovatele u bezpečnostních logů.** Logy aplikace půjčovny vedeme jako zpracování pro správce (A4); logy na úrovni celé platformy (firewall, detekce útoků na infrastrukturu) jako vlastní zpracování provozovatele. Ověřit, zda je rozdělení udržitelné, a sladit se Smlouvou o zpracování (shodně se Zásadami, bod 9).
15. **(B.1) Pověřenec u provozovatele.** Tvrdíme, že není povinný. Při růstu platformy na desítky půjčoven a desetitisíce zákazníků posoudit znovu kritérium „rozsáhlé pravidelné a systematické monitorování“ (čl. 37 odst. 1 písm. b)). Zvážit dobrovolné jmenování.
16. **(B.3, řádek B6; A3) Servisní přístup bez dešifrování.** Aplikace běžící pod správou provozovatele data dešifrovat umí; „nedešifruje“ je organizační pravidlo zapsané ve Smlouvě o zpracování. Formulovat přesně, aby nevzniklo zavádějící ujištění pro správce ani pro ÚOOÚ.
17. **(A.4) Platební brána, poskytovatel terminálu, banka a účetní.** Ověřit u konkrétní brány (výchozí ComGate Payments, a.s.), poskytovatele terminálu a Fio banky, že vystupují jako samostatní správci (některé brány se pro část údajů označují za zpracovatele); doplnit IČO a odkazy na jejich zásady do parametrů. `{{UCETNI_ROLE}}` = zpracovatel vyžaduje smlouvu podle čl. 28 mezi půjčovnou a účetní – administrace má při této volbě upozornit.
18. **(A3, A7, A.4) Pojišťovna.** Pojišťovně předáváme jen jméno nájemce a údaje o výpůjčce a škodě; číslo dokladu pouze na její odůvodněnou žádost při šetření krádeže (minimalizace, čl. 5 odst. 1 písm. c)). Potvrdit, že to odpovídá pojistným podmínkám běžných pojišťoven.

**Struktura záznamu a generování**

19. **(A.2, A.3, A.7, B.2) Rozsah a forma.** (a) Zvolili jsme 10 činností; posoudit, zda A7–A9 ponechat samostatně, nebo A9 sloučit s A4 a A8 vést jen jako poznámku; naopak zvážit rozdělení A1 na „rezervace“ a „plnění smlouvy při výpůjčce“, jak to dělají Zásady. (b) Administrace neoznačí záznam za hotový, dokud půjčovna neprojde A.7 (mzdová agenda, kamery) – potvrdit, že to stačí k úplnosti. (c) Část B s úplným seznamem klientů je citlivý obchodní dokument – potvrdit, že ÚOOÚ může vyžadovat celý seznam, a že půjčovna vidí jen svůj řádek. (d) Uchování starých verzí záznamu 5 let – GDPR lhůtu nestanoví; ověřit, zda stačí „do další revize“.
20. **(Parametry) Jednotný slovník a výchozí hodnoty.** Tento záznam používá názvy shodné se Zásadami, OP a smlouvou o nájmu; Smlouva o zpracování má pro lhůty uchování názvy `RETENCE_*` a pro bránu/banku `PLATEBNI_BRANA` / `BANKA` – mapování je ve sloupci Význam a generátor musí obě jména číst z jedné hodnoty. Sjednocení slovníku do jedné sdílené tabulky pro celou složku právních šablon a sjednocení výchozích hodnot (doména platformy, kauce 3 000 Kč, nedokončená rezervace 90 vs. 60 dnů ve Smlouvě o zpracování) je mimo tuto šablonu. Po advokátní úpravě je třeba, aby právník potvrdil i výchozí hodnoty parametrů a všechny varianty a volitelné bloky (DOKLAD-A/B, plátce/neplátce, účetnictví/daňová evidence, analytika, podpis papír/obrazovka, GPS), protože každá půjčovna může hodnoty změnit bez další právní kontroly; zvážit, zda administrace má u lhůt povolit jen rozsah schválený advokátem.

---

## Příloha pro advokáta – odůvodnění k čl. 30 odst. 5 GDPR (nerenderuje se)

Čl. 30 odst. 5 GDPR: *„Povinnosti uvedené v odstavcích 1 a 2 se nepoužijí pro podnik nebo organizaci zaměstnávající méně než 250 osob, ledaže zpracování, které provádí, pravděpodobně představuje riziko pro práva a svobody subjektů údajů, zpracování není příležitostné, nebo zahrnuje zpracování zvláštních kategorií údajů uvedených v čl. 9 odst. 1 nebo osobních údajů týkajících se rozsudků v trestních věcech a trestných činů.“* Tři podmínky za slovem „ledaže“ jsou alternativní; stačí jediná.

- **Zpracování není příležitostné.** WP29 ve stanovisku z 19. 4. 2018 vyložila, že zpracování je „příležitostné“ jen tehdy, když neprobíhá pravidelně a odehrává se mimo běžnou podnikatelskou činnost správce. U půjčovny je každá rezervace, smlouva, platba a zápis dokladu zpracování osobních údajů, probíhá denně po celou sezónu a je podstatou podnikání. Totéž platí pro mzdovou agendu, kterou podle WP29 žádná organizace nemůže považovat za příležitostnou. ÚOOÚ v Základní příručce k ochraně údajů uvádí (parafráze), že výjimka má v praxi minimální význam, protože běžná činnost včetně mzdové agendy příležitostná není, a doporučuje záznamy vést prakticky všem správcům. Tato podmínka sama stačí; záznam se o ni opírá.
- **Riziko pro práva a svobody.** O této podmínce záznam úmyslně nerozhoduje – není třeba (předchozí podmínka stačí) a argumentace rizikem by byla v napětí se Zásadami (balanční test A: dopad na subjekt nízký) a s A.1 (DPIA není nutná), čímž by zbytečně otevírala otázku čl. 35.
- **Zvláštní kategorie.** V rezervačním systému půjčovna zvláštní kategorie nezpracovává (oznámení krádeže Policii ČR je údaj o události, ne o rozsudku). Mimo systém k nim dochází v mzdové a personální agendě (údaje o zdravotním stavu zaměstnanců – pracovní neschopnost, lékařské prohlídky), kterou půjčovna doplní v A.7; i z tohoto důvodu se výjimka neuplatní.
- **Provozovatel platformy** provozuje systém pro více půjčoven nepřetržitě, zpracování je jeho hlavní činností; vede proto záznam zpracovatele (část B).
- **Výhled.** Evropská komise navrhla v balíčku Omnibus IV (21. 5. 2025) a v Digitálním omnibusu (19. 11. 2025) zúžit povinnost podle čl. 30 na podniky od 750 zaměstnanců a u menších ji ponechat jen pro zpracování s vysokým rizikem. Ke dni revize {{DATUM_REVIZE}} návrh není přijat. I kdyby byl přijat, doporučujeme záznam vést dál: aplikace ho generuje automaticky, je základem pro Zásady a pro odpovědi na žádosti subjektů a dokládá zásadu odpovědnosti (čl. 5 odst. 2 GDPR).

<!-- /INTERNI -->
