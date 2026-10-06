# Zásady ochrany osobních údajů půjčovny {{PUJCOVNA_NAZEV}} (včetně informací o cookies)

<!-- INTERNI: nerenderovat -->

> **Návrh připravený jako podklad; před použitím vyžaduje kontrolu advokátem.** Tento rámeček, oddíl „Parametry“ a oddíl „K ověření advokátem“ jsou interní a na webu se nezobrazují.

## Parametry

Všechny proměnné údaje jsou v textu zapsány jako `{{NAZEV_PARAMETRU}}`. Aplikace je při zobrazení nahradí hodnotami z nastavení půjčovny. Odstavce označené **[Volitelné – …]** se zobrazí jen tehdy, když půjčovna danou funkci zapne; bloky **[VARIANTA …]** se zobrazí podle hodnoty uvedeného parametru a do výsledného textu jde vždy jen jedna varianta. U parametrů označených ve sloupci „Výchozí“ jako **volitelný – skryje se** platí: prázdná hodnota (nebo „—“) znamená, že se věta nebo řádek tabulky, kde je parametr použit, nevyrenderuje. Oddíly **Parametry** a **K ověření advokátem** (mezi značkami `<!-- INTERNI: nerenderovat -->` a `<!-- /INTERNI -->`) jsou interní a na webu se nezobrazují; zobrazuje se text od „Stručně na úvod“ po tabulku verzí. Názvy parametrů mají být shodné napříč šablonami v `legal/` (jeden slovník parametrů v `legal/README.md`); kde se dnes název v sousední šabloně liší, je to poznamenáno ve sloupci Význam.

| Parametr | Význam | Výchozí hodnota / návrh |
|---|---|---|
| `{{PUJCOVNA_NAZEV}}` | Obchodní firma / jméno podnikatele provozujícího půjčovnu (správce) | – (povinné) |
| `{{PUJCOVNA_ICO}}` | IČO půjčovny | – (povinné) |
| `{{PLATCE_DPH}}` | Je půjčovna plátcem DPH? (ano / ne) Řídí zobrazení DIČ a varianty vět o daňových dokladech v odd. 3 a 4 (shodně s Obchodními podmínkami a protokolem) | ne |
| `{{PUJCOVNA_DIC}}` | DIČ půjčovny – zobrazí se **jen při `{{PLATCE_DPH}}` = ano** (nebo u identifikované osoby podle § 6g a násl. ZDPH). U fyzické osoby-neplátce se nezobrazuje: DIČ fyzické osoby je tvořeno kódem CZ a rodným číslem (§ 130 daňového řádu) a na doklad pro spotřebitele patří jen IČO (§ 16 odst. 1 ZOS) | – (volitelný – skryje se) |
| `{{REZIM_EVIDENCE}}` | Jak půjčovna vede evidenci: `ucetnictvi` (účetní jednotka podle zákona č. 563/1991 Sb.) nebo `danova-evidence` (daňová evidence podle § 7b ZDP, případně paušální daň). Řídí řádky o dobách uchování dokladů v odd. 4 a citace v odd. 3 (shodně se Záznamy; dříve pojmenováno `REZIM_DOKLADU`) | danova-evidence *(typická OSVČ / malý hotel; rozhodne půjčovna)* |
| `{{REZIM_DOKLADU}}` | Typ daňového dokladu u plátce DPH pro platby spotřebitelů (rozhodnutí zadavatele 5. 10. 2026): `zjednoduseny` = do 10 000 Kč zjednodušený daňový doklad (§ 30 ZDPH) bez identifikace zákazníka, nad 10 000 Kč běžný daňový doklad. Řídí větu o daňových dokladech v odd. 4 (shodně s OP čl. 4.5 a Záznamy A2) | zjednoduseny |
| `{{PUJCOVNA_SIDLO}}` | Sídlo půjčovny (adresa z rejstříku) | – (povinné) |
| `{{PUJCOVNA_PROVOZOVNA}}` | Adresa provozovny, kde se kola vydávají a vracejí | shodná se sídlem |
| `{{PUJCOVNA_EMAIL}}` | Kontaktní e-mail půjčovny pro dotazy a uplatnění práv | – (povinné) |
| `{{PUJCOVNA_TELEFON}}` | Telefon půjčovny | – (volitelný – skryje se) |
| `{{DOMENA_MUSTERU}}` | Hlavní doména musteru, pod kterou běží subdomény půjčoven (shodně se zpracovatelskou smlouvou) | pujcovna.cz *(dle zadání; rešerše 07: doména je obsazená, doporučeno rezervacekol.cz – konečný výběr je na zadavateli)* |
| `{{WEB_SUBDOMENA}}` | Adresa webu půjčovny na platformě ve tvaru `<nazev-stavajiciho-webu>.{{DOMENA_MUSTERU}}` (Hotel U Tří dubů s webem utridubu.cz → utridubu.pujcovna.cz) | *(příklad)* `utridubu.pujcovna.cz` |
| `{{ODESILACI_ADRESA}}` | Adresa, ze které systém odesílá transakční e-maily i obchodní sdělení (odpovědi směřují na `{{PUJCOVNA_EMAIL}}`) | `<slug>@mail.{{DOMENA_MUSTERU}}`, nebo ověřená doména půjčovny |
| `{{PROVOZOVATEL_NAZEV}}` | Provozovatel platformy (musteru), zpracovatel podle čl. 28 GDPR | – (povinné) |
| `{{PROVOZOVATEL_ICO}}` | IČO provozovatele platformy – bez něj není zpracovatel identifikovatelný (čl. 13 odst. 1 písm. e) GDPR) | – (povinné; vyplní provozovatel musteru jednou pro všechny půjčovny) |
| `{{PROVOZOVATEL_SIDLO}}` | Sídlo provozovatele platformy | – (povinné; vyplní provozovatel musteru) |
| `{{PROVOZOVATEL_EMAIL}}` | Kontakt na provozovatele platformy (technické dotazy, bezpečnostní incidenty) | – (povinné; vyplní provozovatel musteru) |
| `{{HOSTING_NAZEV}}` | Poskytovatel serverů a úložiště záloh (podzpracovatel) | „Hetzner Online GmbH, datová centra v Německu a Finsku (EU)“ |
| `{{EMAIL_SLUZBA_NAZEV}}` | Poskytovatel odesílání e-mailů (podzpracovatel). **Volba poskytovatele mimo EU/EHP (např. Postmark, Resend) vyžaduje přepnout `{{PREDAVANI_MIMO_EU}}` = ano** a doplnit popis | doplní provozovatel po rozhodnutí (kandidáti s hostingem v EU: Mailgun EU, Brevo) |
| `{{PLATEBNI_BRANA_NAZEV}}` | Platební brána, přes kterou půjčovna přijímá karetní platby a preautorizace kauce (v OP, protokolu a zpracovatelské smlouvě pojmenováno `{{PLATEBNI_BRANA}}` – při sjednocení slovníku použít jeden název). **Volba brány se zpracováním mimo EU (např. Stripe Payments Europe s předáváním do USA) vyžaduje `{{PREDAVANI_MIMO_EU}}` = ano** | „ComGate Payments, a.s.“ |
| `{{TERMINAL_POSKYTOVATEL}}` | Poskytovatel platebního terminálu na provozovně (acquirer), pokud půjčovna přijímá kauci a doplatek kartou na místě | „—“ (volitelný – skryje se) |
| `{{BANKA_NAZEV}}` | Banka, u které má půjčovna účet pro přijímání převodů a QR plateb (ve zpracovatelské smlouvě `{{BANKA}}`) | „Fio banka, a.s.“ |
| `{{UCETNI_NAZEV}}` | Externí účetní / daňový poradce půjčovny (pokud je) | „externí účetní půjčovny“ (volitelný – skryje se) |
| `{{UCETNI_ROLE}}` | Role účetní/ho: `zpracovatel` (externí účetní bez vlastní odpovědnosti – nutná smlouva podle čl. 28 GDPR) nebo `samostatný správce` (daňový poradce) – shodně se záznamem o činnostech | zpracovatel |
| `{{POJISTOVNA_NAZEV}}` | Pojišťovna půjčovny, pokud má kola pojištěná (v OP `{{POJISTENI}}` nese text o pojištění; zde jen název pojišťovny) | „—“ (volitelný – skryje se) |
| `{{POPLATEK_KOLO}}` | Rezervační poplatek za jedno kolo (Kč), započítává se na cenu | 300 |
| `{{POPLATEK_EKOLO}}` | Rezervační poplatek za jedno elektrokolo (Kč), započítává se na cenu | 500 |
| `{{KAUCE_KOLO}}` | Vratná kauce za kolo (Kč) – stejná hodnota jako v OP, protokolu a zpracovatelské smlouvě | 3 000 |
| `{{KAUCE_EKOLO}}` | Vratná kauce za elektrokolo (Kč) | 10 000 |
| `{{STORNO_LHUTA_HODIN}}` | Storno lhůta v hodinách před začátkem nájmu (shodně s OP čl. 6.2; nastavení `cancellation.freeHoursBefore`) | 48 |
| `{{STORNO_TABULKA}}` | Storno pravidlo generované ze storno lhůty (shodné s Obchodními podmínkami; v textu se vypisuje jako věta) | „zrušení nejméně {{STORNO_LHUTA_HODIN}} hodin před začátkem nájmu: vrátíme celý rezervační poplatek · později nebo při nevyzvednutí kol: poplatek propadá“ |
| `{{DOKLAD_REZIM}}` | Režim zápisu dokladu totožnosti při výdeji – jediná hodnota `A` (rozhodnutí zadavatele 5. 10. 2026): obsluha zapíše typ a číslo předloženého dokladu, zápis je **podmínkou vydání kola bez výjimky**; souhlas podle § 39 písm. d) zákona č. 269/2021 Sb. dává zákazník u občanského průkazu předložením dokladu a podpisem protokolu. Dřívější varianta B („bez čísla“) je zrušena. V textu se nevypisuje | A |
| `{{DOKLADY_AKCEPTOVANE}}` | Doklady totožnosti, které při převzetí přijímáme (shodně s OP čl. 8.3) | občanský průkaz, cestovní pas nebo řidičský průkaz |
| `{{DRUHY_DOKLAD}}` | Může obsluha požádat o předložení druhého dokladu s fotografií? (ano / ne) Druhý doklad se **pouze předkládá, nic se z něj nezapisuje** – zápis dalšího čísla není nutný ani vhodný (stanovisko ÚOOÚ, stačí předložení) | ne |
| `{{ZAPISOVAT_NAROZENI_ADRESU}}` | Zapisovat do smlouvy o nájmu i datum narození a adresu nájemce podle jeho sdělení? (ano / ne) – shodně s protokolem a Záznamy | ne |
| `{{DOKLAD_CISLO_TISK}}` | Jak se číslo dokladu tiskne na listinnou smlouvu: `maskovane` (jen poslední 3 znaky) nebo `plne` – shodně s protokolem; doporučeno maskovane, případně číslo na listinu netisknout vůbec | maskovane |
| `{{PODPIS_ZPUSOB}}` | Jak se smlouva podepisuje: `papir` (listinné stejnopisy) nebo `obrazovka` – shodně s protokolem; řídí odstavec o listinných protokolech | obrazovka |
| `{{DOBA_NEDOKONCENE_REZERVACE}}` | Jak dlouho uchováváme nedokončenou nebo nezaplacenou rezervaci (ve zpracovatelské smlouvě `{{DOBA_NEDOKONCENE_REZERVACE}}`) | 90 dní (rozsah 30–90) |
| `{{DOBA_SMLOUVA}}` | Jak dlouho uchováváme smlouvu o nájmu, protokoly, záznam o souhlasu s OP a údaje o zrušené rezervaci (ve zpracovatelské smlouvě `{{DOBA_SMLOUVA}}`) | 3 roky od vrácení kola (resp. od storna); rozhodne půjčovna, lze až 10 let |
| `{{DOBA_CISLO_DOKLADU}}` | Jak dlouho uchováváme typ a číslo dokladu totožnosti v databázi po vypořádání (ve zpracovatelské smlouvě `{{DOBA_CISLO_DOKLADU}}`) | 30 dní |
| `{{DOBA_KOMUNIKACE}}` | Jak dlouho uchováváme komunikaci, která nesouvisí s uzavřenou smlouvou (shodně se záznamem o činnostech) | 1 rok od posledního kontaktu |
| `{{DOBA_LOGY}}` | Jak dlouho uchováváme technické a bezpečnostní logy (ve zpracovatelské smlouvě `{{DOBA_LOGY}}`) | 12 měsíců (rozsah 6–12) |
| `{{DOBA_ZALOHY}}` | Nejdelší doba, po kterou smazaný údaj přetrvá v zálohách (nejstarší měsíční záloha; shodně se záznamem o činnostech) | 12 měsíců |
| `{{DOBA_MARKETING}}` | Jak dlouho po poslední výpůjčce posíláme obchodní sdělení vlastním zákazníkům | 3 roky od poslední výpůjčky |
| `{{MARKETING_FREKVENCE}}` | Nejvyšší četnost obchodních sdělení vlastním zákazníkům | „nejvýše 4× ročně“ |
| `{{ANALYTIKA_NASTROJ}}` | Analytický nástroj s cookies, pokud ho půjčovna zapne (jinak se bloky [Volitelné – analytika] nezobrazí a platí výchozí věty „jen technické cookies“). Doporučení: raději nástroj bez cookies / self-hosted v EU (Matomo bez cookies, Plausible) – pak lišta ani tento blok nejsou potřeba | „nepoužívá se“ (volitelný – skryje se) |
| `{{ANALYTIKA_POSKYTOVATEL}}` | Poskytovatel analytického nástroje (název, sídlo, role: zpracovatel / samostatný správce) – řádek v odd. 5; **nástroj přenášející údaje mimo EU (např. GA4 do USA) vyžaduje `{{PREDAVANI_MIMO_EU}}` = ano** | – (volitelný – skryje se) |
| `{{ANALYTIKA_COOKIES_TABULKA}}` | Tabulka analytických cookies: název, účel, platnost, kdo nastavuje (první / třetí strana) | – (vyplní půjčovna podle dokumentace nástroje) |
| `{{PREDAVANI_MIMO_EU}}` | Předávají se údaje do zemí mimo EU/EHP? (ne / ano) Řídí varianty odd. 6 | ne |
| `{{PREDAVANI_MIMO_EU_POPIS}}` | Při `{{PREDAVANI_MIMO_EU}}` = ano: příjemce, země a použitý nástroj (rozhodnutí Komise o odpovídající ochraně podle čl. 45 / standardní smluvní doložky podle čl. 46 odst. 2 písm. c) GDPR) | – |
| `{{GPS_LOKATORY}}` | Jsou kola (typicky e-kola) vybavena GPS lokátorem? (ne / ano) **Zapnutí vyžaduje posouzení vlivu (čl. 35 GDPR) a aktualizaci záznamu o činnostech** | ne |
| `{{MAPOVE_PODKLADY}}` | Poskytovatelé mapových dlaždic načítaných po kliknutí na mapu (výchozí poskytovatelé zpracovávají údaje v EU; poskytovatel mimo EU vyžaduje `{{PREDAVANI_MIMO_EU}}` = ano) | „Seznam.cz, a.s. (Mapy.cz) a CyclOSM (OpenStreetMap France)“ |
| `{{VERZE}}` | Číslo verze tohoto dokumentu | 1.0 |
| `{{UCINNOST_OD}}` | Datum účinnosti této verze | – |

<!-- /INTERNI -->

Verze {{VERZE}}, účinná od {{UCINNOST_OD}}. Zveřejněno na `https://{{WEB_SUBDOMENA}}/soukromi`.

---

## Stručně na úvod

- Údaje o vás zpracováváme proto, abychom vám mohli půjčit kolo: vyřídit rezervaci, přijmout platbu, vydat a převzít kolo a vystavit doklady. K rezervaci ani k uzavření smlouvy po vás souhlas nepožadujeme; souhlas chceme jen tam, kde ho vyžaduje zákon (oddíl 3).
- Z dokladu totožnosti si při převzetí kola **zapíšeme pouze typ a číslo** – je to podmínka vydání kola: podle čísla ověříme, že doklad není evidován jako neplatný v Databázi neplatných dokladů Ministerstva vnitra ČR (https://aplikace.mvcr.cz/neplatne-doklady/), a při krádeži nebo nevrácení kola víme, komu jsme ho svěřili. U občanského průkazu dáváte souhlas se zápisem předložením dokladu a podpisem protokolu. Nikdy doklad nekopírujeme, neskenujeme ani nefotíme a číslo z databáze smažeme {{DOBA_CISLO_DOKLADU}} po vypořádání.
- Údaje platební karty k nám nikdy nedorazí – platbu i blokaci kauce zpracovává platební brána (online) nebo platební terminál (na místě).
- **[Výchozí – bez analytiky]** Web používá jen technicky nezbytné cookies, proto nemá cookie lištu. **[Volitelné – jen při zapnuté analytice]** Kromě nezbytných cookies používáme s vaším souhlasem analytické cookies nástroje {{ANALYTIKA_NASTROJ}} (viz cookie lišta a oddíl 7).
- Vaše údaje neprodáváme a nepředáváme reklamním sítím, sociálním sítím ani jiným půjčovnám.
- Vaše práva uplatníte e-mailem na {{PUJCOVNA_EMAIL}}; odpovíme do 30 dnů.

---

## 1. Kdo je správcem vašich údajů

**Správce** (čl. 4 bod 7 GDPR – ten, kdo určuje, proč a jak se vaše údaje zpracovávají):

> **{{PUJCOVNA_NAZEV}}**, IČO {{PUJCOVNA_ICO}} **[VARIANTA A – {{PLATCE_DPH}} = ano]**, DIČ {{PUJCOVNA_DIC}}
> sídlo: {{PUJCOVNA_SIDLO}}
> provozovna (výdej a vrácení kol): {{PUJCOVNA_PROVOZOVNA}}
> e-mail: {{PUJCOVNA_EMAIL}} **[jen je-li vyplněn {{PUJCOVNA_TELEFON}}]** · telefon: {{PUJCOVNA_TELEFON}}
> web: `https://{{WEB_SUBDOMENA}}`

Pověřence pro ochranu osobních údajů nemáme – pro půjčovnu kol ho čl. 37 GDPR nevyžaduje. Ve všech věcech ochrany údajů se obracejte přímo na kontakty výše.

**Kdo pro nás web provozuje.** Web `{{WEB_SUBDOMENA}}` běží na společné platformě pro půjčovny kol, kterou provozuje **{{PROVOZOVATEL_NAZEV}}**, IČO {{PROVOZOVATEL_ICO}}, {{PROVOZOVATEL_SIDLO}}, e-mail {{PROVOZOVATEL_EMAIL}}. Provozovatel platformy je náš **zpracovatel** (čl. 4 bod 8 a čl. 28 GDPR): zajišťuje technický provoz webu, rezervačního systému, zálohy a podporu, ale s vašimi údaji nakládá výhradně podle našich pokynů a na základě písemné smlouvy o zpracování osobních údajů. Nesmí je použít pro vlastní účely ani je sdílet s jinými půjčovnami na platformě. Každá půjčovna má na platformě vlastní, technicky oddělenou databázi.

---

## 2. Jaké údaje zpracováváme

Zpracováváme jen údaje, které potřebujeme k půjčení kola a k plnění zákonných povinností (zásada minimalizace, čl. 5 odst. 1 písm. c) GDPR). Získáváme je **přímo od vás** (z rezervačního formuláře, při převzetí kola, z komunikace), od **platební brány**, **platebního terminálu** a **banky** (stav a identifikace platby) a z **technického provozu webu** (logy).

| Kategorie | Konkrétní údaje | Kdy je získáme |
|---|---|---|
| **Rezervační údaje** | jméno a příjmení, e-mail, telefon, termín výpůjčky, vybrané typy a velikosti kol, příslušenství, počet kol, poznámka k rezervaci, číslo a stav rezervace, jazyk komunikace | při vytvoření rezervace na webu nebo telefonicky/osobně, když rezervaci zapisuje obsluha |
| **Záznam o souhlasu s Obchodními podmínkami** | verze Obchodních podmínek, datum a čas, otisk (hash) IP adresy | při odeslání rezervace |
| **Smluvní údaje** | identifikace konkrétních vydaných kol, předávací protokol a protokol o vrácení (stav kola, výbava, případné poškození a jeho ocenění), podpis na protokolu, pokud se podepisuje | při převzetí a vrácení kola |
| **Údaje z dokladu totožnosti** | **pouze typ dokladu (občanský průkaz, cestovní pas, řidičský průkaz) a jeho číslo**; nikdy kopie, sken ani fotografie dokladu; rodné číslo neopisujeme **[při {{ZAPISOVAT_NAROZENI_ADRESU}} = ne]** a neopisujeme ani adresu. Zápis typu a čísla dokladu je **podmínkou vydání kola bez výjimky** (Obchodní podmínky čl. 8.3). U **občanského průkazu** vyžaduje zápis údajů souhlas držitele (§ 39 písm. d) zákona č. 269/2021 Sb., o občanských průkazech) – dáváte ho předložením průkazu a podpisem předávacího protokolu, kde je zaznamenán; právním základem zpracování podle GDPR je náš oprávněný zájem (oddíl 3, balanční test A) | při převzetí kola; obsluha doklad zkontroluje, ověří jeho platnost a zapíše dva údaje do zabezpečeného pole v systému |
| **[Volitelné – při {{ZAPISOVAT_NAROZENI_ADRESU}} = ano]** **Datum narození a adresa bydliště** | datum narození a adresa bydliště podle vašeho sdělení – zapisujeme je do smlouvy o nájmu, abychom mohli případný nárok na náhradu škody uplatnit u soudu (k žalobě je třeba žalovaného označit jménem, datem narození a bydlištěm) | při převzetí kola |
| **[Volitelné – při {{DRUHY_DOKLAD}} = ano]** **Druhý doklad** | při převzetí vás můžeme požádat o předložení druhého dokladu s fotografií; ten si **pouze prohlédneme, nic z něj nezapisujeme** | při převzetí kola |
| **Platební údaje** | způsob platby, částka a stav platby, identifikátor platby u platební brány nebo číslo transakce z účtenky terminálu, u karty nejvýše značka karty a poslední 4 číslice (pokud nám je brána nebo terminál předá); u převodu a QR platby číslo a název účtu plátce, částka, variabilní symbol a zpráva pro příjemce z výpisu z účtu; údaje o rezervačním poplatku ({{POPLATEK_KOLO}} Kč za kolo, {{POPLATEK_EKOLO}} Kč za elektrokolo), doplatku, kauci ({{KAUCE_KOLO}} Kč za kolo, {{KAUCE_EKOLO}} Kč za elektrokolo – hotově, terminálem nebo blokací na kartě), vratce nebo ponechané části poplatku podle storno podmínek ({{STORNO_TABULKA}}); vystavené doklady | při platbě, při převzetí a vrácení kola, při stornu |
| **Údaje o škodě nebo mimořádné události** | popis a fotografie poškození kola, vyčíslení škody, zápis o krádeži nebo nehodě, číslo jednací Policie ČR **[jen je-li vyplněn {{POJISTOVNA_NAZEV}}]**, komunikace s pojišťovnou | jen pokud k takové události dojde |
| **Komunikace** | obsah e-mailů, zpráv z kontaktního formuláře, poznámky obsluhy z telefonátu (hovory nenahráváme), reklamace a jejich vyřízení | když nás kontaktujete nebo my vás |
| **Technické údaje a logy** | IP adresa, datum a čas požadavku, navštívená adresa, typ prohlížeče a zařízení, chybová hlášení; v administraci záznam o tom, kdo z obsluhy a kdy s vaší rezervací pracoval (audit log s otisky hodnot místo hodnot samotných) | automaticky při používání webu a systému |
| **Cookies** | viz oddíl 7 – **[Výchozí – bez analytiky]** pouze technicky nezbytné **[Volitelné – jen při zapnuté analytice]** technicky nezbytné a, pokud je odsouhlasíte, analytické | při používání webu |
| **[Volitelné – při {{GPS_LOKATORY}} = ano]** **Poloha kola** | poloha kola z lokátoru umístěného na kole, zaznamenávaná pouze po dobu výpůjčky za účelem ochrany majetku (dohledání kola při krádeži nebo nevrácení); polohu nesledujeme průběžně a nespojujeme ji s vaším profilem pro jiné účely | během výpůjčky |

**Platba třetí osobou.** Pokud za vás rezervaci zaplatí někdo jiný (rodič, zaměstnavatel, kamarád), dozvíme se z bankovního výpisu číslo a název jeho účtu, částku a zprávu pro příjemce; použijeme je jen k přiřazení a případnému vrácení platby a platí pro ně tyto zásady stejně.

**Co nezpracováváme:** číslo platební karty, CVC ani jiné karetní údaje (ty zadáváte výhradně na stránce platební brány nebo na terminálu), kopie dokladů, rodné číslo, údaje o zdravotním stavu, **[při {{GPS_LOKATORY}} = ne]** polohu kola ani vaši polohu během výpůjčky (kola nemají GPS), **[při {{GPS_LOKATORY}} = ano]** vaši polohu mimo polohu kola popsanou výše, kamerové záznamy z webu. Pokud má provozovna kamerový systém, informuje o něm samostatně na místě.

**Které údaje jsou nutné a co se stane, když je neposkytnete** (čl. 13 odst. 2 písm. e) GDPR): jméno, e-mail, telefon a termín jsou smluvním požadavkem – bez nich nelze rezervaci vytvořit a potvrdit. Předložení platného dokladu totožnosti ({{DOKLADY_AKCEPTOVANE}}) a zápis jeho typu a čísla jsou při převzetí **podmínkou vydání kola bez výjimky**, abychom ověřili vaši totožnost a platnost dokladu a věděli, komu kolo v hodnotě desítek tisíc korun svěřujeme (Obchodní podmínky čl. 8.3); potvrzujete to už při rezervaci. Pokud doklad nepředložíte nebo se zápisem jeho typu a čísla nesouhlasíte, kolo nevydáme a rezervace se posuzuje jako nevyzvednutá – rezervační poplatek propadá (Obchodní podmínky čl. 6.5). Vše ostatní (poznámka, newsletter) je dobrovolné.

**Děti.** Kolo si u nás může půjčit jen zletilá, plně svéprávná osoba (dovršených 18 let, § 30 odst. 1 OZ) – viz Obchodní podmínky čl. 8.2. Dětská kola půjčujeme dospělému nájemci; údaje o dětech nezaznamenáváme. Web není určen dětem a nenabízíme na něm služby informační společnosti dětem (§ 7 zákona č. 110/2019 Sb.).

**Rezervace pro více osob.** Pokud rezervujete kola i pro další osoby, uvádíte jen typy a velikosti kol, nikoli jejich jména. Při převzetí může obsluha požadovat doklad totožnosti od každého nájemce, který kolo přebírá; pro jeho údaje platí tyto zásady stejně.

---

## 3. Proč údaje zpracováváme a na jakém právním základě

Právní základy podle čl. 6 odst. 1 GDPR: **b) plnění smlouvy** (včetně jednání o ní), **c) právní povinnost**, **f) oprávněný zájem** a **a) souhlas**. Souhlas po vás chceme **jen** tam, kde to zákon vyžaduje: newsletter pro osoby, které u nás nic nepůjčily, a případné analytické cookies – ty můžete odmítnout bez ztráty služby. Zvláštní případ je **občanský průkaz**: § 39 písm. d) zákona o občanských průkazech vyžaduje k zápisu údajů z něj souhlas držitele; tento souhlas dáváte předložením průkazu a podpisem předávacího protokolu a zápis typu a čísla dokladu je podmínkou vydání kola (oddíl 2). Právním základem zpracování podle GDPR je přitom náš oprávněný zájem (řádek 4 a balanční test A níže), ne souhlas.

| # | Účel | Jaké údaje | Právní základ | Poznámka |
|---|---|---|---|---|
| 1 | **Vyřízení rezervace a uzavření smlouvy o nájmu kola** – potvrzení, připomínka den předem, správa rezervace přes odkaz v e-mailu, změny termínu, storno a vratka | rezervační, platební (poplatek, vratka podle storno podmínek), komunikace | čl. 6 odst. 1 písm. b) | Smlouva o nájmu podle § 2201 a násl. OZ, u kola jako dopravního prostředku se zvláštními ustanoveními § 2321–2325 OZ. U rezervace na konkrétní termín nemáte 14denní právo odstoupit (§ 1837 písm. j) OZ), proto platí storno podmínky z Obchodních podmínek: rezervační poplatek je úplatou za zajištění služby (blokaci kol na termín) a započítává se na nájemné; při zrušení nejméně {{STORNO_LHUTA_HODIN}} hodin před začátkem nájmu se vrací celý, při pozdějším zrušení nebo nevyzvednutí kol propadá. |
| 2 | **Plnění smlouvy při výpůjčce** – výdej a vrácení kola, předávací protokoly, přijetí a vrácení kauce, doplatek, vyúčtování | smluvní, platební, údaje o škodě **[při {{ZAPISOVAT_NAROZENI_ADRESU}} = ano]**, datum narození a adresa podle vašeho sdělení | čl. 6 odst. 1 písm. b) | Kauce je vratná jistota; údaje o její formě a vrácení evidujeme, aby bylo jasné, co a kdy jsme vrátili. |
| 3 | **Účetnictví a daně** – doklady o přijaté platbě a o poskytnutí služby, konečné doklady, případné opravné doklady při stornu nebo vratce, účetní nebo daňová evidence, daňová kontrola | jméno (jen pokud je na dokladu nutné), platební údaje, vystavené doklady | čl. 6 odst. 1 písm. c) | § 16 odst. 1 zákona č. 634/1992 Sb., o ochraně spotřebitele (doklad o poskytnutí služby na žádost); **[VARIANTA A – {{PLATCE_DPH}} = ano]** § 26–35 ZDPH (daňové doklady, uchování 10 let); **[při {{REZIM_EVIDENCE}} = ucetnictvi]** § 31 zákona č. 563/1991 Sb., o účetnictví; **[při {{REZIM_EVIDENCE}} = danova-evidence]** § 7b odst. 5 zákona č. 586/1992 Sb., o daních z příjmů, a § 148 daňového řádu (zákon č. 280/2009 Sb.). |
| 4 | **Ověření totožnosti a platnosti dokladu a ochrana našeho majetku při vydání kola** | typ a číslo dokladu | čl. 6 odst. 1 písm. f) – oprávněný zájem, balanční test níže (A); u občanského průkazu navíc souhlas držitele vyžadovaný § 39 písm. d) zákona č. 269/2021 Sb. (zákonný požadavek zákona o občanských průkazech, ne titul podle GDPR) | Číslo dokladu ověříme v Databázi neplatných dokladů Ministerstva vnitra ČR (https://aplikace.mvcr.cz/neplatne-doklady/). Souhlas se zápisem údajů z občanského průkazu dáváte předložením průkazu a podpisem předávacího protokolu, kde je zaznamenán. Zápis typu a čísla dokladu je podmínkou vydání kola bez výjimky; bez něj se rezervace posuzuje jako nevyzvednutá (Obchodní podmínky čl. 6.5 a 8.3). |
| 5 | **Uplatnění a obhajoba právních nároků** – vymáhání škody, nezaplaceného půjčovného, řešení krádeže a sporů | rezervační, smluvní, platební, údaje o škodě, komunikace, číslo dokladu po dobu nevyřešené události | čl. 6 odst. 1 písm. f) | Náš zájem: moci prokázat obsah smlouvy a stav kola při předání a vrácení a domoci se náhrady (§ 2910 a násl. OZ). Údaje uchováváme po dobu promlčecí lhůty (§ 620, § 629 a § 636 OZ). |
| 6 | **Vyřízení reklamací** | kontaktní údaje, obsah reklamace, protokol o přijetí a vyřízení | čl. 6 odst. 1 písm. c) (§ 19 ZOS) | Reklamaci potvrdíme a vyřídíme nejpozději do 30 dnů od uplatnění (§ 19 odst. 3 ZOS). |
| 7 | **Bezpečnost webu a rezervačního systému** – odhalení a šetření útoků, ochrana před podvodnými rezervacemi a platbami, audit přístupu obsluhy k vašim údajům, obnova ze zálohy | technické údaje a logy, audit log | čl. 6 odst. 1 písm. f) – balanční test níže (B) | Zabezpečení nám zároveň ukládá čl. 32 GDPR. |
| 8 | **Odpovědi na dotazy a komunikace před rezervací** | komunikace, kontaktní údaje | čl. 6 odst. 1 písm. b) (jednání o smlouvě), jinak písm. f) | Uchováváme jen po nezbytnou dobu (oddíl 4). |
| 9 | **Obchodní sdělení vlastním zákazníkům** o našich obdobných službách (sezónní nabídka půjčovny, novinky v nabídce kol) | jméno, e-mail, historie výpůjček (jen fakt, že jste u nás byli) | čl. 6 odst. 1 písm. f) ve spojení s § 7 odst. 3 zákona č. 480/2004 Sb. | Můžete odmítnout už při rezervaci a v každé zprávě (oddíl 8). Námitce podle čl. 21 odst. 2 GDPR vždy vyhovíme. |
| 10 | **Newsletter pro osoby, které u nás nic nepůjčily**; **[Volitelné – jen při zapnuté analytice]** **analytické cookies** nástroje {{ANALYTIKA_NASTROJ}} | e-mail; údaje o používání webu | čl. 6 odst. 1 písm. a) – souhlas; u cookies § 89 odst. 3 ZEK | Souhlas lze kdykoli odvolat (čl. 7 odst. 3 GDPR); odvolání nemá vliv na dosavadní zpracování. Záznam o udělení a odvolání souhlasu uchováváme, abychom souhlas uměli doložit (čl. 7 odst. 1 GDPR, oddíl 4). |
| 11 | **[Volitelné – při {{GPS_LOKATORY}} = ano]** **Sledování polohy kola lokátorem** během výpůjčky | poloha kola | čl. 6 odst. 1 písm. f) – ochrana majetku | Polohu čteme jen při nevrácení, krádeži nebo nahlášené nehodě; údaje mažeme do 7 dnů po vrácení kola. |
| 12 | **Plnění povinností podle GDPR** – evidence a vyřízení vašich žádostí, záznamy o činnostech zpracování, ohlášení incidentů | kontaktní údaje, obsah žádosti | čl. 6 odst. 1 písm. c) | čl. 12–22, čl. 30, čl. 33–34 GDPR. |
| 13 | **Spolupráce s Policií ČR, soudy a úřady** – při krádeži nebo poškození kola, při dožádání orgánů | podle konkrétního případu, zpravidla jméno, kontakt, údaje z dokladu nebo smlouvy, údaje o výpůjčce | čl. 6 odst. 1 písm. c) při zákonném dožádání (např. § 8 odst. 1 trestního řádu), jinak písm. f) | Oznámení krádeže podáváme my jako poškození. |

### Balanční test A – údaje z dokladu totožnosti

Podle čl. 6 odst. 1 písm. f) GDPR musíme svůj zájem poměřit s vašimi právy. Takto jsme postupovali:

1. **Náš zájem:** chránit kola a elektrokola v hodnotě desítek tisíc korun, která vám svěřujeme bez dozoru, ověřit totožnost a **platnost předloženého dokladu** a mít možnost v případě nevrácení, krádeže nebo neuhrazené škody doložit, kdo kolo převzal, a předat tento údaj Policii ČR nebo soudu. Krádeže jízdních kol patří v České republice k nejčastějším majetkovým trestným činům: Policie ČR eviduje ročně okolo čtyř až pěti tisíc odcizených kol a elektrokol a jejich počet se od roku 2010 více než ztrojnásobil (statistika Policie ČR: 1 158 případů v roce 2010, 2 191 v roce 2014 – https://archiv.policie.gov.cz/clanek/zajimava-temata-kradeze-jizdnich-kol.aspx; 3 971 případů se škodou zhruba 123 milionů Kč v roce 2024 podle statistik Policie ČR). Zájem je skutečný, konkrétní a odpovídá běžné praxi půjčoven, kterou zákazníci očekávají.
2. **Nezbytnost:** jméno, e-mail a telefon z rezervace si nemůžeme ověřit; doklad totožnosti předložený při převzetí ano – a podle jeho čísla ověříme v Databázi neplatných dokladů Ministerstva vnitra ČR (https://aplikace.mvcr.cz/neplatne-doklady/), že nejde o doklad evidovaný jako ztracený, odcizený nebo neplatný. Mírnější prostředky: (a) žádné ověření nebo jen nahlédnutí bez zápisu – neumožní nám ověřit platnost dokladu ani po nevrácení kola doložit, komu jsme ho vydali; vydávat kola jen proti kauci v plné hodnotě kola by službu prodražilo všem zákazníkům; (b) kopie, sken nebo fotografie dokladu – **odmítáme**: ÚOOÚ ve stanovisku „Prokazování totožnosti a zpracování osobních údajů“ (květen 2021) uvádí, že ve většině případů má stačit předložení dokladu a zaznamenání nezbytných údajů, § 39 písm. c) zákona č. 269/2021 Sb., o občanských průkazech, zakazuje pořizovat kopii občanského průkazu bez souhlasu držitele (přestupek podle § 65) a § 2 odst. 3 zákona č. 329/1999 Sb., o cestovních dokladech, zakazuje totéž u cestovního pasu (přestupek podle § 34a odst. 1 písm. i)). (c) Zápis typu a čísla dokladu je tak nejmírnější účinný prostředek. U občanského průkazu vyžaduje § 39 písm. d) téhož zákona k zápisu údajů z průkazu souhlas držitele (výjimka platí jen pro nahlédnutí při ověřování totožnosti, které vyžaduje nebo umožňuje právní předpis); tento souhlas dáváte předložením průkazu a podpisem protokolu – je to zákonný požadavek vedle našeho oprávněného zájmu. U cestovního pasu a řidičského průkazu obdobný zákaz neexistuje (zákon o cestovních dokladech zakazuje jen kopie; zákon č. 361/2000 Sb. žádný zákaz neobsahuje a ÚOOÚ řidičský průkaz jako průkaz totožnosti připouští, je-li druhou stranou akceptován).
3. **Dopad na vás:** nízký. Číslo dokladu bez dalších údajů nelze snadno zneužít, je u nás uloženo zašifrované, vidí ho pouze oprávněná obsluha při výdeji a vrácení, nikam se neodesílá (ověření v Databázi neplatných dokladů MV ČR je jednorázový dotaz na typ a číslo dokladu, nic dalšího se nepředává) a **z databáze se automaticky maže {{DOBA_CISLO_DOKLADU}} po vrácení kola a vypořádání kauce**; na listinné smlouvě je nejvýše maskované (oddíl 4). Déle údaje držíme jen při nevyřešené škodě, krádeži nebo nezaplacení, a to do vyřešení věci.
4. **Vaše pojistky:** můžete podat námitku (čl. 21 GDPR). Protože je zápis typu a čísla dokladu podmínkou vydání kola, znamená námitka před výdejem, že kolo nevydáme a rezervace se posuzuje jako nevyzvednutá (Obchodní podmínky čl. 8.3) – na tuto podmínku vás upozorňujeme a výslovně ji potvrzujete už při rezervaci. Po vrácení kola a vypořádání vám na žádost údaje z dokladu smažeme ihned, pokud neběží řešení škody.

**Závěr:** zájem převažuje, zpracování je přiměřené.

### Balanční test B – technické a bezpečnostní logy

1. **Náš zájem:** udržet web a rezervační systém bezpečný a dostupný, odhalit útoky (hádání hesel, podvržené platby, zneužití rezervačních odkazů), prošetřit incidenty a doložit, kdo z obsluhy k údajům přistupoval. Zabezpečení nám navíc ukládá čl. 32 GDPR a případné ohlášení incidentu čl. 33 GDPR vyžaduje, abychom věděli, co se stalo.
2. **Nezbytnost:** bez záznamu IP adresy a času požadavku nelze útok rozpoznat ani zastavit. Logujeme jen nezbytné technické údaje; do logů nikdy nezapisujeme hesla, obsah formulářů, čísla dokladů ani platební údaje a v audit logu administrace ukládáme místo hodnot jejich otisky.
3. **Dopad na vás:** nízký – logy slouží jen bezpečnosti, nespojujeme je s vaším profilem pro jiné účely a mažeme je po {{DOBA_LOGY}}.
4. **Vaše pojistky:** právo na námitku (čl. 21 GDPR) a na informaci, které údaje o vás v logu máme.

**Závěr:** zájem převažuje, zpracování je přiměřené.

---

## 4. Jak dlouho údaje uchováváme

Údaje držíme jen po dobu nezbytnou k danému účelu (čl. 5 odst. 1 písm. e) GDPR). Poté je **smažeme nebo anonymizujeme** (osobní údaje nahradíme neutrálními hodnotami, zůstane jen anonymní statistika). Výjimkou jsou doklady, které musíme ze zákona uchovat beze změny po celou zákonnou dobu (daňové a účetní doklady, daňová evidence – zákon vyžaduje, aby jejich obsah zůstal neporušený, § 34 ZDPH, § 31 a § 33 zákona o účetnictví); ty po uplynutí lhůty skartujeme nebo smažeme. Mazání v systému probíhá automaticky, bez našeho zásahu.

| Údaje | Doba uchování | Proč právě tak dlouho |
|---|---|---|
| Nedokončená nebo nezaplacená rezervace (bez uzavřené smlouvy) | **{{DOBA_NEDOKONCENE_REZERVACE}}** od vytvoření, pak výmaz | krátká lhůta pro případ, že se ozvete s dotazem k rezervaci, kterou jste nedokončili |
| Zrušená rezervace (storno) | osobní údaje **{{DOBA_SMLOUVA}}** (počítáno od storna); doklad o přijaté platbě a vratce podle řádků o dokladech níže | promlčecí lhůta nároků ze smlouvy (§ 629 OZ) pro případné spory o vratku |
| Smlouva o nájmu, předávací protokol, protokol o vrácení, záznam o souhlasu s Obchodními podmínkami **[při {{ZAPISOVAT_NAROZENI_ADRESU}} = ano]**, včetně data narození a adresy | **{{DOBA_SMLOUVA}}** od vrácení kola; při nevyřešené škodě, krádeži nebo sporu do pravomocného skončení věci a vypořádání nároků | promlčecí lhůta nároků ze smlouvy (§ 629 OZ – obecně 3 roky, nejdéle 10 let); u náhrady škody nejdéle 10 let od vzniku škody, u úmyslně způsobené škody 15 let (§ 636 OZ) |
| Záznam o škodě, krádeži, komunikace s Policií ČR **[jen je-li vyplněn {{POJISTOVNA_NAZEV}}]** a pojišťovnou | do vyřešení věci a dále 3 roky od jejího skončení | promlčení nároků na náhradu škody (§ 629, § 636, § 2910 a násl. OZ) |
| **Typ a číslo dokladu totožnosti** v databázi | **{{DOBA_CISLO_DOKLADU}} po vrácení kola a vypořádání kauce**, pak automatický výmaz; déle jen při nevyřešené škodě, krádeži nebo nezaplacení – do vyřešení | minimalizace podle stanoviska ÚOOÚ k prokazování totožnosti; záznam o vašem souhlasu se zápisem čísla občanského průkazu zůstává v protokolu po dobu uchování smlouvy (prokázání souhlasu, čl. 7 odst. 1 GDPR) |
| **[VARIANTA A – {{PLATCE_DPH}} = ano]** Daňové doklady (daňový doklad k přijaté platbě, konečný daňový doklad, případný opravný daňový doklad) | **10 let od konce zdaňovacího období, ve kterém se plnění uskutečnilo** (§ 35 odst. 2 ZDPH) | zákonná povinnost plátce DPH; **[při {{REZIM_DOKLADU}} = zjednoduseny]** u plateb do 10 000 Kč vystavujeme **zjednodušený daňový doklad** (§ 30 ZDPH), na kterém vaše jméno ani adresa nejsou; běžný daňový doklad s vašimi údaji vystavujeme jen u platby nad 10 000 Kč – do dokladů uchovávaných 10 let tak zpravidla žádný váš osobní údaj nevstupuje |
| **[VARIANTA B – {{PLATCE_DPH}} = ne, {{REZIM_EVIDENCE}} = ucetnictvi]** Doklady o přijaté platbě a o poskytnutí služby, účetní doklady a záznamy | 5 let od konce účetního období; účetní závěrka 10 let (§ 31 odst. 2 zákona č. 563/1991 Sb., o účetnictví) | zákonná povinnost účetní jednotky |
| **[VARIANTA B – {{PLATCE_DPH}} = ne, {{REZIM_EVIDENCE}} = danova-evidence]** Doklady o přijaté platbě a o poskytnutí služby a daňová evidence | po dobu lhůty pro stanovení daně (§ 7b odst. 5 zákona o daních z příjmů, § 148 daňového řádu – zpravidla 3 roky od lhůty pro podání přiznání, nejdéle 10 let) | zákonná povinnost poplatníka vedoucího daňovou evidenci |
| **[VARIANTA A – {{PLATCE_DPH}} = ano, {{REZIM_EVIDENCE}} = ucetnictvi]** Účetní doklady a záznamy | 5 let od konce účetního období; účetní závěrka 10 let (§ 31 odst. 2 zákona č. 563/1991 Sb., o účetnictví) | zákonná povinnost účetní jednotky (vedle lhůty pro daňové doklady) |
| Platební údaje (identifikátor platby, číslo transakce terminálu, číslo a název účtu plátce pro vratku, značka karty a poslední 4 číslice) | součást dokladů a evidence – stejné lhůty jako u nich; nespárované platby, které se k žádné rezervaci nepřiřadí, mažeme po {{DOBA_NEDOKONCENE_REZERVACE}} | zákonná povinnost; číslo účtu potřebujeme pro vratku původní metodou |
| Komunikace (e-mail, formulář) | souvisí-li se smlouvou, stejně jako smlouva; jinak **{{DOBA_KOMUNIKACE}}** | vyřízení dotazu |
| Reklamace a protokol o jejím vyřízení | **{{DOBA_SMLOUVA}}** | prokázání řádného vyřízení reklamace (§ 19 ZOS) |
| Technické logy webu a audit log administrace | **{{DOBA_LOGY}}**, pak výmaz | doba potřebná k odhalení a prošetření incidentu |
| Zálohy | šifrované zálohy držíme 7 dní (denní), 4 týdny (týdenní) a {{DOBA_ZALOHY}} (měsíční); údaje smazané z provozní databáze tak ze záloh zmizí nejpozději do {{DOBA_ZALOHY}}; zálohy používáme výhradně k obnově po havárii, ne k běžnému čtení údajů | možnost obnovy systému |
| Obchodní sdělení vlastním zákazníkům | dokud se neodhlásíte nebo nepodáte námitku; nejdéle **{{DOBA_MARKETING}}** | po delší době už nejste „náš zákazník“ v běžném smyslu |
| E-mail pro newsletter (osoby bez výpůjčky) | do odvolání souhlasu | čl. 7 odst. 3 GDPR |
| Záznam o udělení a odvolání souhlasu s newsletterem (čas, verze textu, otisk IP adresy, potvrzovací klik) | 3 roky od odvolání souhlasu | prokázání souhlasu (čl. 7 odst. 1 GDPR), promlčecí lhůta (§ 629 OZ) |
| Záznam o odhlášení / námitce proti marketingu | otisk (hash) e-mailu trvale, dokud rozesíláme obchodní sdělení | abychom vám omylem znovu nepsali (čl. 21 odst. 3 GDPR) |
| **[Volitelné – při {{GPS_LOKATORY}} = ano]** Poloha kola | do 7 dnů po vrácení kola, pak výmaz; déle jen při krádeži nebo nevrácení do vyřešení | ochrana majetku, nic víc |
| **[Volitelné – jen při zapnuté analytice]** Záznam o volbě cookies | souhlas 12 měsíců, odmítnutí 6 měsíců, pak se zeptáme znovu | doporučení ÚOOÚ k cookie liště |

**Listinné protokoly.** **[při {{PODPIS_ZPUSOB}} = papir]** Smlouvu o nájmu a protokoly podepisujeme na papíře ve dvou vyhotoveních; **[při {{DOKLAD_CISLO_TISK}} = maskovane]** číslo dokladu je na výtisku jen maskované (poslední 3 znaky), plné číslo zůstává pouze zašifrované v systému; **[při {{DOKLAD_CISLO_TISK}} = plne]** na výtisku je číslo dokladu uvedeno celé. Listiny uchováváme v uzamčeném prostoru provozovny s přístupem jen pro oprávněnou obsluhu po dobu {{DOBA_SMLOUVA}} a poté je skartujeme. **[při {{PODPIS_ZPUSOB}} = obrazovka]** Smlouvu a protokoly podepisujete na obrazovce; listinné kopie nevznikají a dokument dostanete e-mailem. Automatický výmaz čísla dokladu po {{DOBA_CISLO_DOKLADU}} se týká databáze; na podepsané smlouvě (listinné nebo elektronické) zůstává číslo nejvýše v maskované podobě po dobu uchování smlouvy.

---

## 5. Komu údaje předáváme

Vaše údaje vidí jen ti, kdo je potřebují ke své práci. Příjemce dělíme na **zpracovatele** (pracují pro nás podle našich pokynů a smlouvy podle čl. 28 GDPR) a **samostatné správce** (mají vlastní zákonné povinnosti a vlastní zásady ochrany údajů).

| Příjemce | Role | Co dostává a proč |
|---|---|---|
| **{{PROVOZOVATEL_NAZEV}}** – provozovatel platformy | zpracovatel | provoz webu a rezervačního systému, zálohy, technická podpora; přístup k databázi půjčovny má jen při řešení závady nebo incidentu, pod individuálním účtem s dvoufaktorovým ověřením a se záznamem v audit logu |
| **{{HOSTING_NAZEV}}** – servery a úložiště záloh | podzpracovatel provozovatele | fyzické uložení dat na serverech a v šifrovaných zálohách v EU; k obsahu databází nemá přístup |
| **{{EMAIL_SLUZBA_NAZEV}}** – odesílání e-mailů | podzpracovatel provozovatele | odeslání potvrzení rezervace, dokladů, připomínek a případných obchodních sdělení z adresy {{ODESILACI_ADRESA}} na váš e-mail; vidí adresu a obsah zprávy po dobu doručení |
| **{{PLATEBNI_BRANA_NAZEV}}** – platební brána | samostatný správce | zpracování platby kartou online a blokace (preautorizace) kauce; karetní údaje zadáváte přímo jí, my dostáváme jen stav platby, její identifikátor, částku a nejvýše značku karty a poslední 4 číslice. Brána je platební institucí s vlastními povinnostmi (zákon č. 370/2017 Sb., o platebním styku; zákon č. 253/2008 Sb., AML). Její zásady ochrany údajů najdete na jejím webu. |
| **[jen je-li vyplněn {{TERMINAL_POSKYTOVATEL}}]** **{{TERMINAL_POSKYTOVATEL}}** – poskytovatel platebního terminálu na provozovně | samostatný správce | platba doplatku, kauce a náhrad kartou na místě; karetní údaje zpracovává výhradně terminál podle svých pravidel, my evidujeme jen částku, čas a číslo transakce z účtenky |
| **{{BANKA_NAZEV}}** – banka půjčovny | samostatný správce | přijetí převodu nebo QR platby; z výpisu z účtu (načítáme ho automaticky přes rozhraní banky) vidíme číslo a název účtu plátce, částku, variabilní symbol a zprávu, abychom platbu přiřadili k rezervaci a případně vrátili |
| **[jen je-li vyplněn {{UCETNI_NAZEV}}]** **{{UCETNI_NAZEV}}** – účetní | {{UCETNI_ROLE}} | vedení účetnictví nebo daňové evidence; dostává doklady, ne údaje z dokladů totožnosti |
| **Policie ČR, soudy, exekutoři, finanční správa, ÚOOÚ a jiné orgány** | samostatní správci | jen při krádeži, poškození, nezaplacení, při zákonném dožádání nebo kontrole; předáme jen to, co je pro daný případ nutné |
| **[jen je-li vyplněn {{POJISTOVNA_NAZEV}}]** **{{POJISTOVNA_NAZEV}}** – pojišťovna | samostatný správce | při pojistné události: údaje o výpůjčce a škodě |
| **[Volitelné – jen při zapnuté analytice]** **{{ANALYTIKA_POSKYTOVATEL}}** – poskytovatel analytického nástroje {{ANALYTIKA_NASTROJ}} | podle uvedené role (zpracovatel / samostatný správce) | údaje o používání webu po vašem souhlasu v cookie liště (oddíl 7); místo zpracování a případné předávání mimo EU viz oddíl 6 |
| **Vy sami** | – | doklady, protokoly a export vašich údajů posíláme na váš e-mail nebo zobrazíme přes zabezpečený odkaz na správu rezervace |

**Prohlášení o nesdílení.** Vaše osobní údaje **neprodáváme, nepronajímáme ani nevyměňujeme**. Nepředáváme je reklamním a marketingovým sítím, provozovatelům sociálních sítí, zprostředkovatelům, jiným půjčovnám ani jiným třetím stranám, než jsou uvedeny v tabulce. Provozovatel platformy nespojuje údaje zákazníků různých půjčoven a nepoužívá je k vlastnímu marketingu. Pokud budeme chtít přidat nového zpracovatele, aktualizujeme tyto zásady před tím, než začne údaje zpracovávat.

---

## 6. Předávání údajů mimo EU

**[VARIANTA – {{PREDAVANI_MIMO_EU}} = ne]** **Vaše údaje zpracováváme v Evropské unii.** Servery i zálohy jsou u {{HOSTING_NAZEV}} v EU, platební bránu {{PLATEBNI_BRANA_NAZEV}}, banku {{BANKA_NAZEV}} a e-mailovou službu {{EMAIL_SLUZBA_NAZEV}} používáme se zpracováním v EU, provozovatel platformy je v České republice. Písma, mapovou knihovnu i skripty web načítá z vlastního serveru, ne z cizích CDN. Do zemí mimo EU/EHP údaje nepředáváme. Pokud by to u některého příjemce bylo v budoucnu nutné, stane se to jen na základě rozhodnutí Evropské komise o odpovídající ochraně (čl. 45 GDPR) nebo standardních smluvních doložek (čl. 46 odst. 2 písm. c) GDPR) s posouzením dopadu, a tyto zásady předem doplníme o název příjemce a použitý nástroj.

**[VARIANTA – {{PREDAVANI_MIMO_EU}} = ano]** **Vaše údaje zpracováváme převážně v Evropské unii** – servery i zálohy jsou u {{HOSTING_NAZEV}} v EU a provozovatel platformy je v České republice. Údaje předáváme také {{PREDAVANI_MIMO_EU_POPIS}}. Předání se opírá o rozhodnutí Evropské komise o odpovídající ochraně (čl. 45 GDPR) nebo o standardní smluvní doložky (čl. 46 odst. 2 písm. c) GDPR) s posouzením dopadu; kopii použitých záruk vám na vyžádání poskytneme na {{PUJCOVNA_EMAIL}}.

---

## 7. Cookies a podobné technologie

### Co jsou cookies a jak s nimi zacházíme

Cookies jsou malé soubory, které si web ukládá ve vašem prohlížeči. Podle **§ 89 odst. 3 zákona č. 127/2005 Sb., o elektronických komunikacích (ZEK)**, smíme bez vašeho souhlasu do zařízení ukládat jen to, co je nezbytné pro přenos zprávy nebo pro poskytnutí služby, kterou jste si výslovně vyžádali; pro vše ostatní je od 1. 1. 2022 potřeba předem prokazatelný souhlas (opt-in).

**[Výchozí – bez analytiky]** **Náš web používá pouze technicky nezbytné cookies.** Proto na něm **není cookie lišta** – podle ÚOOÚ (Otázky a odpovědi – Cookies) ji web, který používá jen technické cookies, mít nemusí; informační povinnost plníme tímto oddílem. Žádné reklamní, sledovací ani analytické cookies nepoužíváme.

**[Volitelné – jen při zapnuté analytice]** **Náš web používá technicky nezbytné cookies a – jen s vaším souhlasem – analytické cookies nástroje {{ANALYTIKA_NASTROJ}}.** Proto se při první návštěvě zobrazí cookie lišta (podrobnosti níže). Reklamní ani sledovací cookies pro marketing nepoužíváme.

### Přehled cookies

| Název | Účel | Typ | Platnost |
|---|---|---|---|
| `__Host-session` | udržení přihlášení obsluhy v administraci a bezpečného sezení při rezervaci; ochrana před podvržením požadavku (CSRF) | nezbytná | do zavření prohlížeče, nejdéle 8 hodin od přihlášení |
| `__Host-rezervace` | zapamatování rozepsané rezervace (termín, vybraná kola) během procházení webu | nezbytná – služba, kterou jste si vyžádali | 24 hodin |
| `__Host-csrf` | ochrana formulářů před odesláním z cizí stránky | nezbytná | do zavření prohlížeče |
| `__Host-souhlas` **[Volitelné – jen při zapnuté analytice]** | zapamatování vaší volby v cookie liště | nezbytná (uložení volby) | 12 měsíců při souhlasu, 6 měsíců při odmítnutí |

Nezbytné cookies jsou **první strany** (nastavuje je jen `{{WEB_SUBDOMENA}}`), označené `Secure`, `HttpOnly` a `SameSite`, platí jen pro web této půjčovny a nikdy nepřetékají na weby jiných půjčoven na platformě. Osobní údaje v nich nejsou – jen náhodný identifikátor sezení. Pro rozepsanou rezervaci můžeme místo cookie použít úložiště prohlížeče (`localStorage`); platí pro něj stejná pravidla.

Cookies můžete v prohlížeči kdykoli smazat nebo zakázat. Bez nezbytných cookies nepůjde dokončit rezervaci ani se přihlásit do administrace.

### Statistiky návštěvnosti bez cookies

Abychom věděli, které stránky lidé čtou a zda web funguje, počítáme **souhrnné statistiky ze serverových logů** (počty zobrazení stránek, typ zařízení, země podle IP adresy). Do vašeho zařízení při tom nic neukládáme, výsledkem jsou jen anonymní součty a IP adresy mažeme s logy (oddíl 4). Právní základ: oprávněný zájem (čl. 6 odst. 1 písm. f) GDPR).

### [Volitelné – jen při zapnuté analytice] Analytické cookies

Měříme návštěvnost nástrojem {{ANALYTIKA_NASTROJ}} (poskytovatel {{ANALYTIKA_POSKYTOVATEL}}, oddíl 5), který ukládá cookies. Při první návštěvě se proto zobrazí **cookie lišta**: nic není předvyplněno, tlačítko **Odmítnout** je stejně viditelné jako **Přijmout**, lišta vám nebrání web používat a před vaší volbou se žádná analytická cookie neuloží. Souhlas platí 12 měsíců, odmítnutí si pamatujeme 6 měsíců. Volbu můžete kdykoli změnit odkazem „Nastavení cookies“ v patičce. Právní základ: souhlas (§ 89 odst. 3 ZEK, čl. 6 odst. 1 písm. a) GDPR). Kde nástroj údaje zpracovává a zda je předává mimo EU, uvádí oddíl 6.

Analytické cookies, které se po souhlasu ukládají (název, účel, platnost, kdo je nastavuje):

{{ANALYTIKA_COOKIES_TABULKA}}

### Obsah třetích stran

- **Mapa cyklotras a tipů na výlety** se načte až po kliknutí na „Zobrazit mapu“. Mapové dlaždice se stahují přímo ze serverů {{MAPOVE_PODKLADY}}; při načítání vidí tito poskytovatelé vaši IP adresu a typ prohlížeče (nikoli to, kdo jste nebo co máte rezervováno). Oba výchozí poskytovatelé zpracovávají údaje v EU. Jejich pravidla: Mapy.cz – zásady společnosti Seznam.cz, a.s.; CyclOSM/OpenStreetMap France – zásady projektu OpenStreetMap. Pokud mapu neotevřete, nic se neodesílá. Trasy si můžete stáhnout jako GPX soubor i bez mapy.
- **Platební brána**: při platbě kartou vás přesměrujeme na stránku {{PLATEBNI_BRANA_NAZEV}}, která používá vlastní cookies podle vlastních zásad; po dokončení platby se vrátíte k nám.
- Na webu **nejsou** tlačítka sociálních sítí, vložená videa, chat třetí strany ani písma z cizích serverů.

---

## 8. Obchodní sdělení a newsletter

**Vlastním zákazníkům** – tedy těm, kdo si u nás kolo půjčili – můžeme podle **§ 7 odst. 3 zákona č. 480/2004 Sb.**, o některých službách informační společnosti, bez souhlasu posílat e-mailem obchodní sdělení o **našich vlastních obdobných službách** (zahájení sezóny, nové typy kol, otevírací doba, akce půjčovny). Platí při tom:

- Při rezervaci můžete zaškrtnout, že obchodní sdělení **nechcete** – pak vám žádné nepošleme.
- V **každé zprávě** je odkaz pro odhlášení jedním kliknutím, zdarma; odhlášení zpracujeme ihned, nejpozději do 3 dnů.
- Posíláme je {{MARKETING_FREKVENCE}}, z adresy {{ODESILACI_ADRESA}} (odpovědi směřují na {{PUJCOVNA_EMAIL}}), vždy s naším názvem v odesílateli a zřetelným označením „obchodní sdělení“ (§ 7 odst. 4 zákona č. 480/2004 Sb.).
- Nepředáváme váš e-mail nikomu dalšímu, nevytváříme profily ani „podobná publika“ pro reklamu.
- Právní základ: oprávněný zájem (čl. 6 odst. 1 písm. f) GDPR). Námitce proti marketingu (čl. 21 odst. 2 a 3 GDPR) vždy vyhovíme bez posuzování.

**Newsletter pro ostatní** (kdo u nás nic nepůjčil) posíláme jen s vaším **souhlasem** (§ 7 odst. 2 zákona č. 480/2004 Sb., čl. 6 odst. 1 písm. a) GDPR), který potvrdíte kliknutím na odkaz v ověřovacím e-mailu. Souhlas můžete kdykoli odvolat odkazem ve zprávě nebo e-mailem na {{PUJCOVNA_EMAIL}}. Po odvolání váš e-mail z rozesílky smažeme a ponecháme si jen záznam, že a kdy jste souhlas dali a odvolali (oddíl 4), abychom to uměli doložit.

**Nejsou obchodním sdělením** a posíláme je vždy: potvrzení rezervace, doklady, připomínka den před výpůjčkou, informace o změně termínu nebo zrušení z naší strany, informace o změně těchto zásad nebo Obchodních podmínek, odpověď na váš dotaz.

---

## 9. Vaše práva a jak je uplatnit

Podle GDPR máte tato práva:

| Právo | Co znamená | Článek GDPR |
|---|---|---|
| **Přístup** | dozvědět se, které údaje o vás máme, proč, odkud a komu jsme je předali, a získat jejich kopii | čl. 15 |
| **Oprava** | opravit nepřesné nebo doplnit neúplné údaje (např. telefon, e-mail) | čl. 16 |
| **Výmaz („být zapomenut“)** | smazání údajů, které už nepotřebujeme nebo zpracováváme neoprávněně; nelze u údajů, které musíme držet ze zákona (daňové a účetní doklady, daňová evidence – § 34–35 ZDPH, § 31 zákona o účetnictví, § 7b ZDP) – ty zůstávají beze změny po zákonnou dobu, ostatní údaje smažeme nebo anonymizujeme | čl. 17 |
| **Omezení zpracování** | po dobu, kdy řešíme vaši námitku nebo spor o přesnost údajů, údaje jen uložíme a nepoužíváme | čl. 18 |
| **Přenositelnost** | údaje, které jste nám dali a zpracováváme je na základě smlouvy nebo souhlasu, dostanete ve strojově čitelném formátu (JSON) | čl. 20 |
| **Námitka** | proti zpracování z oprávněného zájmu (údaje z dokladu, logy, obchodní sdělení); u obchodních sdělení vyhovíme vždy, u ostatních posoudíme, zda náš zájem převažuje | čl. 21 |
| **Odvolání souhlasu** | kdykoli, stejně snadno, jako jste ho dali; nemá vliv na zpracování před odvoláním | čl. 7 odst. 3 |
| **Nebýt předmětem automatizovaného rozhodování** | žádné takové rozhodování neprovádíme (oddíl 11) | čl. 22 |
| **Stížnost u dozorového úřadu** | viz níže | čl. 77 |

**Jak práva uplatnit**

1. Napište na **{{PUJCOVNA_EMAIL}}** (ideálně z e-mailu, který jste použili při rezervaci) nebo poštou na {{PUJCOVNA_SIDLO}}, případně osobně v provozovně. Přehled svých rezervací a export údajů získáte i sami přes zabezpečený odkaz „Správa rezervace“ v potvrzovacím e-mailu.
2. Potřebujeme vás **bezpečně ztotožnit**, abychom údaje nevydali někomu jinému: zpravidla stačí, že píšete z e-mailu uvedeného v rezervaci, nebo odpověď na ověřovací zprávu. **Nikdy po vás nebudeme chtít kopii dokladu totožnosti.**
3. Odpovíme **bez zbytečného odkladu, nejpozději do 30 dnů** (čl. 12 odst. 3 GDPR mluví o jednom měsíci). U složitých nebo početných žádostí můžeme lhůtu prodloužit o další dva měsíce – v takovém případě vám do 30 dnů napíšeme proč.
4. Vyřízení je **bezplatné**. Jen u zjevně nedůvodných nebo opakovaných žádostí můžeme podle čl. 12 odst. 5 GDPR požadovat přiměřený poplatek za náklady nebo žádost odmítnout; vždy to odůvodníme.
5. Pokud žádosti nevyhovíme, sdělíme důvod a poučíme vás o možnosti stížnosti a soudní ochrany.

**Stížnost u ÚOOÚ.** Pokud se domníváte, že vaše údaje zpracováváme v rozporu s právem, můžete podat stížnost u dozorového úřadu (čl. 77 GDPR):

> **Úřad pro ochranu osobních údajů (ÚOOÚ)**
> Pplk. Sochora 27, 170 00 Praha 7
> e-mail: posta@uoou.gov.cz · datová schránka: qkbaa2n · telefon: +420 234 665 111
> web: https://uoou.gov.cz (online formulář: Veřejnost → Stížnost na správce nebo zpracovatele)

Budeme rádi, když se nejdřív ozvete nám – většinu věcí vyřešíme rychleji. Máte také právo na soudní ochranu (čl. 79 GDPR).

---

## 10. Jak údaje zabezpečujeme

Zabezpečení považujeme za nejdůležitější vlastnost celého systému (čl. 32 GDPR). Stručně:

- **Šifrovaný přenos:** celý web běží jen přes HTTPS (TLS 1.2/1.3, HSTS).
- **Šifrování citlivých polí:** údaje z dokladu totožnosti, datum narození, adresa, telefon a další citlivé údaje jsou v databázi zašifrované (AES-256-GCM) klíčem uloženým mimo databázi; útočník, který by získal databázový soubor nebo zálohu, je nepřečte. Disky a zálohy jsou šifrované.
- **Oddělení půjčoven:** každá půjčovna má vlastní databázi, vlastní šifrovací klíč a vlastní doménu; systém je testován proti přístupu k údajům cizí půjčovny.
- **Přístupová práva:** každý člen obsluhy má vlastní účet s dvoufaktorovým ověřením, přístup k údajům z dokladu má jen při výdeji a vrácení a každý přístup se zaznamenává. Při odchodu zaměstnance účet rušíme.
- **Žádné karetní údaje u nás:** platba probíhá na stránce platební brány (online) nebo na platebním terminálu (na místě), oboje v režimu PCI DSS; k nám se karetní čísla nedostanou.
- **Minimalizace a automatický výmaz:** žádné kopie dokladů, žádné osobní údaje v provozních lozích, automatické mazání podle oddílu 4. Výmaz čísla dokladu po {{DOBA_CISLO_DOKLADU}} se týká databáze; na podepsané smlouvě je číslo nejvýše maskované a smlouva se skartuje po {{DOBA_SMLOUVA}}.
- **Listinné dokumenty:** **[při {{PODPIS_ZPUSOB}} = papir]** papírové smlouvy a protokoly jsou uloženy v uzamčeném prostoru provozovny, přístup má jen oprávněná obsluha, skartace po {{DOBA_SMLOUVA}}. **[při {{PODPIS_ZPUSOB}} = obrazovka]** smlouvy podepisujete na obrazovce, papírové kopie nevznikají.
- **Zálohy a obnova:** šifrované zálohy mimo provozní server v EU, pravidelný test obnovy.
- **Pravidelné kontroly:** automatizované bezpečnostní testy při každém nasazení, kontrola zranitelností, roční revize podle OWASP ASVS.
- **Incidenty:** pokud by přes všechna opatření došlo k porušení zabezpečení, které může ohrozit vaše práva, ohlásíme je ÚOOÚ do 72 hodin od zjištění (čl. 33 GDPR) a při vysokém riziku vás budeme bez zbytečného odkladu informovat e-mailem (čl. 34 GDPR). Provozovatel platformy je smluvně zavázán nám incident nahlásit do 24 hodin.

---

## 11. Automatizované rozhodování a profilování

**Nepoužíváme** automatizované rozhodování ani profilování ve smyslu čl. 22 GDPR – žádný algoritmus u nás nerozhoduje o tom, zda vám kolo půjčíme, za jakou cenu nebo s jakou kaucí. Systém automaticky pouze **počítá dostupnost kol a cenu podle ceníku a termínu** (stejně pro všechny) a **hlídá lhůty** (expirace nezaplacené rezervace, storno lhůty). O výjimkách rozhoduje vždy člověk z obsluhy. Platební brána provádí při platbě kartou vlastní ověření (3-D Secure, prevence podvodů) jako samostatný správce podle svých pravidel.

---

## 12. Změny těchto zásad a verze

Tyto zásady můžeme změnit, například když přidáme nového zpracovatele, zapneme analytiku nebo se změní právní předpisy. Aktuální verze je vždy na `https://{{WEB_SUBDOMENA}}/soukromi` s číslem verze a datem účinnosti; starší verze na vyžádání poskytneme. O **podstatných změnách** (nový účel zpracování, nový příjemce, předávání mimo EU) informujeme zákazníky s platnou rezervací e-mailem nejméně 14 dní před účinností. Záznam o tom, se kterou verzí Obchodních podmínek jste souhlasili, uchováváme spolu s rezervací; tyto zásady souhlas nevyžadují, jsou informací podle čl. 13 GDPR.

| Verze | Účinnost | Změna |
|---|---|---|
| {{VERZE}} | {{UCINNOST_OD}} | první vydání |

Použité zkratky: **GDPR** – nařízení Evropského parlamentu a Rady (EU) 2016/679; **OZ** – zákon č. 89/2012 Sb., občanský zákoník; **ZOS** – zákon č. 634/1992 Sb., o ochraně spotřebitele (mimosoudní řešení sporů viz Obchodní podmínky); **ZDPH** – zákon č. 235/2004 Sb., o dani z přidané hodnoty; **ZDP** – zákon č. 586/1992 Sb., o daních z příjmů; **daňový řád** – zákon č. 280/2009 Sb.; **ZEK** – zákon č. 127/2005 Sb., o elektronických komunikacích; zákon č. 269/2021 Sb., o občanských průkazech; zákon č. 329/1999 Sb., o cestovních dokladech; zákon č. 361/2000 Sb., o provozu na pozemních komunikacích (řidičské průkazy); zákon č. 480/2004 Sb., o některých službách informační společnosti; zákon č. 110/2019 Sb., o zpracování osobních údajů; zákon č. 563/1991 Sb., o účetnictví.

---

<!-- INTERNI: nerenderovat -->

## K ověření advokátem

Body, u kterých si nejsme jisti nebo kde záleží na rozhodnutí půjčovny či zadavatele. Číslování odpovídá oddílům výše. Citace paragrafů v dokumentu byly ověřeny z primárních zdrojů při oponentuře (§ 1837 písm. j), § 2201, § 2321–2325, § 629, § 636, § 2910 OZ; § 30, § 34, § 35 odst. 2 ZDPH; § 31 zákona o účetnictví; § 7b odst. 5 ZDP; § 16 a § 19 ZOS; § 7 zákona č. 480/2004 Sb.; § 89 odst. 3 ZEK; § 39 a § 65 zákona č. 269/2021 Sb.; § 2 odst. 3 a § 34a zákona č. 329/1999 Sb.; § 8 odst. 1 trestního řádu; materiál ÚOOÚ z května 2021).

1. **(odd. 2, odd. 3 ř. 4, balanční test A; parametr `{{DOKLAD_REZIM}}` = A) Zápis typu a čísla dokladu jako podmínka nájmu – riziko posouzení souhlasu podmíněného službou (čl. 7 odst. 4 GDPR).** Zadavatel rozhodl (5. 10. 2026), že zápis typu a čísla dokladu je podmínkou pronájmu **bez výjimky**; dřívější varianta B („bez čísla“ – jen jméno, datum narození a adresa) je zrušena ve všech dokumentech. Rizika, že ÚOOÚ může souhlas podmíněný poskytnutím služby považovat za nesvobodný (čl. 7 odst. 4 GDPR; materiál ÚOOÚ z 13. 5. 2021, s. 7–9: souhlas vynucený smlouvou není svobodný – vznikl však za zákona č. 328/1999 Sb., před účinností § 39 písm. d)), si je zadavatel vědom a na podmínce trvá. Argumentace v textu: právním titulem podle GDPR je **oprávněný zájem** (čl. 6 odst. 1 písm. f)) doložený balančním testem A – ověření totožnosti a **platnosti dokladu** v Databázi neplatných dokladů MV ČR (https://aplikace.mvcr.cz/neplatne-doklady/) a ochrana majetku při krádežích kol (statistika Policie ČR; údaj za rok 2024 pochází ze statistik PČR citovaných médii, před nasazením ověřit v primárním zdroji); souhlas podle **§ 39 písm. d) zákona č. 269/2021 Sb.** je zákonným požadavkem zákona o občanských průkazech, nikoli titulem podle GDPR (čl. 6 odst. 1 písm. a)), a zákazník ho dává předložením průkazu a podpisem protokolu. Advokát posoudí, zda tato konstrukce obstojí (zejména zda lze zákonem vyžadovaný souhlas oddělit od režimu čl. 7 GDPR a zda § 39 písm. d) připouští zápis čísla při uzavírání smlouvy jako „ověřování totožnosti, které umožňuje právní předpis“), a zda je porušení písm. d) i přestupkem podle § 65 odst. 1 (oponentura: sankcionuje jen písm. a), b), c) a e); z primárního zdroje nepotvrzeno).
2. **(odd. 2, parametr `{{ZAPISOVAT_NAROZENI_ADRESU}}`) Datum narození a adresa.** Pro žalobu na náhradu škody je třeba žalovaného označit jménem, datem narození a bydlištěm; samotné číslo dokladu k žalobě nestačí (pomůže jen Policii). Zápis je volitelný (rozhodnutí půjčovny mezi minimalizací a vymahatelností) a provádí se podle sdělení nájemce, ne opisem z občanského průkazu. Posoudit, zda jde o nezbytnou součást smlouvy (písm. b)) nebo oprávněný zájem (písm. f)); šablona uvádí oba tituly.
3. **(odd. 2, balanční test A) Cestovní pas a řidičský průkaz.** Z primárních zdrojů ověřeno: zákon č. 329/1999 Sb. zakazuje v § 2 odst. 3 jen kopie pasu (přestupek § 34a odst. 1 písm. i), pokuta do 10 000 Kč), obdobný zákaz zpracování údajů v něm není; zákon č. 361/2000 Sb. žádný zákaz kopií ani zpracování údajů z ŘP neobsahuje; ÚOOÚ (s. 2) připouští ŘP jako průkaz totožnosti, „je-li to druhou stranou akceptováno“. Rozhodnout, zda rozdíl (u pasu a ŘP jen oprávněný zájem, u OP navíc zákonem vyžadovaný souhlas) v textu vysvětlovat podrobněji, nebo zda stačí jednotné odůvodnění oprávněným zájmem se zmínkou o § 39 písm. d).
5. **(odd. 3 ř. 1 a 3, odd. 4) DPH režim propadlého rezervačního poplatku – posoudit s daňovým poradcem.** Podle rozhodnutí zadavatele (5. 10. 2026) je poplatek úplatou za zajištění služby (blokaci kol na termín), započítává se na nájemné a při zrušení po uplynutí storno lhůty `{{STORNO_LHUTA_HODIN}}` nebo při nevyzvednutí propadá; plátce DPH ho zdaňuje jako službu i při propadnutí (SDEU C-250/14 a C-289/14 Air France-KLM; C-295/17 MEO, C-43/19 Vodafone Portugal) a opravný daňový doklad vystavuje jen při vrácení poplatku (odlišný závěr pro propadlou zálohu při zrušení: C-277/05 Société thermale). Potvrdit kvalifikaci a nastavit `{{STORNO_DPH_REZIM}}` v Záznamech (výchozí `zdanitelne-plneni`).
6. **(odd. 4, parametry `{{PLATCE_DPH}}`, `{{REZIM_DOKLADU}}`, `{{REZIM_EVIDENCE}}`) Doby uchování dokladů.** (a) Rozhodnuto zadavatelem (5. 10. 2026): u plátce DPH se pro platby spotřebitelů do 10 000 Kč vystavuje zjednodušený daňový doklad (§ 30 ZDPH) bez označení zákazníka, nad 10 000 Kč běžný daňový doklad (`{{REZIM_DOKLADU}}` = zjednoduseny) – do dokladů uchovávaných 10 let pak zpravidla nevstupuje jméno; potvrdit s daňovým poradcem, že to vyhovuje i konečnému dokladu se započtením poplatku a opravnému dokladu (§ 45 ZDPH), a zda se hranice posuzuje za doklad, nebo za plnění. (b) U neplátce s daňovou evidencí uvádíme lhůtu pro stanovení daně (§ 7b odst. 5 ZDP, § 148 DŘ – 3 roky, nejdéle 10 let); u paušální daně ověřit, zda poplatník nějaké doklady uchovávat musí. (c) Nový zákon o účetnictví je v legislativním procesu (1. čtení 12. 3. 2026, plánovaná účinnost 1. 1. 2028) – při přijetí aktualizovat odkazy na § 31 a § 33.
7. **(odd. 4) Doby uchování ostatních údajů.** (a) `{{DOBA_SMLOUVA}}` 3 roky (§ 629 odst. 1) vs. opatrnější praxe až 10 let (§ 629 odst. 2, § 636) – zvolit; (b) logy 12 měsíců – ověřit přiměřenost (ÚOOÚ obvykle akceptuje 6–12); (c) nedokončené rezervace 90 dní a mazání nespárovaných bankovních pohybů (`bank_transactions.raw`) po téže lhůtě; (d) záznam o souhlasu s newsletterem 3 roky od odvolání – potvrdit, že jde o přiměřenou dobu pro prokázání souhlasu (čl. 7 odst. 1).
8. **(odd. 4) Zálohy.** Formulace „údaje smazané z databáze zmizí ze záloh nejpozději do {{DOBA_ZALOHY}}“ – potvrdit, že je to přijatelné řešení práva na výmaz vůči zálohám (ÚOOÚ i EDPB připouštějí, pokud se zálohy nepoužívají k běžnému zpracování).
9. **(odd. 1 a 5) Role provozovatele platformy.** Je čistým zpracovatelem i pro bezpečnostní logy a ochranu celé platformy před útoky (zájem provozovatele, ne jednotlivé půjčovny)? Pokud by šlo o samostatného správce v tomto rozsahu, doplnit odstavec a sladit se zpracovatelskou smlouvou (`legal/zpracovatelska-smlouva.md`).
10. **(odd. 5) Platební brána, terminál a banka jako samostatní správci** – ověřit u konkrétní brány (výchozí ComGate Payments, a.s.), poskytovatele terminálu a Fio banky, zda to odpovídá jejich smluvní dokumentaci (některé brány se označují za zpracovatele pro část údajů). Doplnit IČO a odkaz na jejich zásady do parametrů. Účetní: půjčovna volí `{{UCETNI_ROLE}}`; potvrdit vodítko „externí účetní bez vlastní odpovědnosti = zpracovatel (smlouva podle čl. 28), daňový poradce = samostatný správce“.
11. **(odd. 3 ř. 13, odd. 5) Policie a pojišťovna** – rozlišení písm. c) (zákonné dožádání podle § 8 odst. 1 trestního řádu) a písm. f) (naše vlastní oznámení krádeže, hlášení pojistné události).
12. **(odd. 6, parametr `{{PREDAVANI_MIMO_EU}}`) Předávání mimo EU** – závisí na dosud nevybrané e-mailové službě (PLAN.md kap. 15 bod 4) a na případné druhé bráně (Stripe Payments Europe Ltd., Irsko, s předáváním do USA). EU–US Data Privacy Framework je právně nejistý (odvolání Latombe C-703/25 P u SDEU, dopis EDPB Komisi z 31. 7. 2026 po rozhodnutí Trump v. Slaughter) – doporučujeme poskytovatele s hostingem v EU; při volbě US služby doplnit SCC, posouzení dopadu a text `{{PREDAVANI_MIMO_EU_POPIS}}`.
13. **(odd. 7) Cookies bez lišty.** Potvrdit, že session cookie ve veřejné části (CSRF, rozepsaná rezervace) a cookie s volbou souhlasu spadají pod výjimku § 89 odst. 3 ZEK; parafrázi § 89 odst. 3 oponentura označila za přesnou – advokát ji může nahradit doslovným zněním; sledovat připravovaný nový ZEK. Posoudit `localStorage` pod stejnou výjimku. U volitelné analytiky potvrdit text lišty a tabulku `{{ANALYTIKA_COOKIES_TABULKA}}` pro zvolený nástroj (doporučení: nástroj bez cookies / self-hosted v EU, pak lišta odpadá).
14. **(odd. 7) Serverové statistiky bez cookies** z IP adres v lozích – stačí oprávněný zájem, nebo je nutná anonymizace IP před zpracováním statistik?
15. **(odd. 7) Mapové dlaždice třetích stran** (Mapy.cz, CyclOSM – oba v EU) – přenos IP adresy poskytovateli po kliknutí uživatele: stačí „načtení až po kliknutí“ a informace v zásadách, nebo požadovat souhlas / dvoukrokové potvrzení s textem? Ověřit podmínky Mapy.cz API pro komerční použití a jejich zásady.
16. **(odd. 8) Obchodní sdělení podle § 7 odst. 3 zákona č. 480/2004 Sb.** Ověřit: (a) co jsou „obdobné služby“ půjčovny (jen půjčení kol, nebo i servis, prodej, ubytování, pokud půjčovnu provozuje hotel?); (b) zda je „zákazníkem“ i osoba, která rezervaci zaplatila a stornovala; (c) zda musí být možnost odmítnutí při sběru e-mailu výslovně jako zaškrtávací pole (náš návrh) a jaké znění; (d) `{{MARKETING_FREKVENCE}}` a `{{DOBA_MARKETING}}`; (e) odesílání z adresy `{{ODESILACI_ADRESA}}` na doméně musteru s Reply-To půjčovny – splňuje § 7 odst. 4 písm. b) (identita odesílatele) tím, že v odesílateli je název půjčovny?
17. **(odd. 2) Otisk IP adresy u souhlasu s OP** – hash IP je stále osobní údaj; ověřit, že jeho uložení k prokázání souhlasu obstojí na základě písm. f) a doby `{{DOBA_SMLOUVA}}`.
18. **(odd. 2) Rezervace pro více osob** – zda doklad vyžadovat od každého jezdce (pak každý je nájemcem a „subjektem údajů“ a je třeba mu zásady předat), nebo jen od objednatele, který ručí za všechna kola (řešit shodně v Obchodních podmínkách). **(odd. 2, `{{DRUHY_DOKLAD}}`)** Potvrdit, že požadavek na předložení druhého dokladu bez zápisu je v souladu s minimalizací.
19. **(odd. 2 a 3, `{{GPS_LOKATORY}}`) GPS lokátory** – zapnutí vyžaduje posouzení vlivu (čl. 35 GDPR; kritérium „sledování polohy“ v seznamu ÚOOÚ) a rozšíření záznamu o činnostech; ověřit navrženou dobu 7 dnů a titul písm. f).
20. **(odd. 9) Lhůta „30 dnů“** – GDPR používá „jeden měsíc“; zvolili jsme 30 dnů jako přísnější a srozumitelnější; potvrdit formulaci včetně prodloužení o 2 měsíce.
21. **(odd. 10) Zveřejnění detailů zabezpečení** (algoritmy, lhůty) – je míra detailu v zásadách vhodná, nebo raději obecněji a detail nechat v interní dokumentaci?
22. **(odd. 12) Oznamování změn** – stačí 14 dní předem e-mailem jen zákazníkům s platnou rezervací, nebo informovat všechny zákazníky v retenční době?
23. **Obecně** – zásady jsou generované ze šablony; po advokátní úpravě je třeba, aby právník potvrdil i text všech variant a volitelných bloků (plátce/neplátce, analytika, předávání mimo EU, GPS, listinné protokoly) a výchozí hodnoty parametrů, protože každá půjčovna může hodnoty změnit bez další právní kontroly. Slovník parametrů je sjednocen v generátoru (`src/features/pravni.js`, funkce `legalParams`): dvojice `{{PLATEBNI_BRANA_NAZEV}}`/`{{PLATEBNI_BRANA}}`, `{{POJISTOVNA_NAZEV}}`/`{{POJISTENI}}` a `{{BANKA_NAZEV}}`/`{{BANKA}}` dostávají jednu hodnotu; pravidlo o interních oddílech je v `legal/README.md`.

<!-- /INTERNI -->
