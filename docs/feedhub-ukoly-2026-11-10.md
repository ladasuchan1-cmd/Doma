# Feed Hub: co dělat dál

Seznam úkolů, 10. 11. 2026. Cíl zadal Láďa:

1. sami si umíme zavést feed a dostat ho do správného parsování,
2. víme o každé změně, která mezi dvěma staženími nastane,
3. víme, který dodavatel změnu udělal,
4. víme, když změnu uděláme my, například v hesle nebo v nastavení feedu.

Pracnost je odhad v člověkodnech práce Clauda, ne slib. Stav „dnes“ je ověřený v kódu na `main` (verze `v2026-11-10-5f28be2`).

**Stav k večeru 10. 11. 2026:** hotové a nasazené jsou A1, B1, B2, D4, E1 a E7 (verze `v2026-11-10-a83beaf`). Podrobnosti u jednotlivých řádků.

**Stav 11. 11. 2026 ráno (verze `v2026-11-11-5bdc817`), čtený z logu nasazení:** Lindlau stahuje celý katalog (8 898 položek, EAN má 8 737, běh 53 s), Raymon (2 354) i Focus (3 184) běží, takže A2 je hotové. Aktivních zdrojů je 45, z toho 25 funkčních, 2 s varováním a 18 nefunkčních: 15 českých feedů bez adresy s tokenem, MBPS bez přístupu a oba zdroje Oberalpu bez připojené složky. Nabídek je 118 271, z toho 2 840 dodavatelé už neposílají.

**Deník od 11. 11. 2026 (verze `v2026-11-11-87cd4fb`):** hotové a nasazené jsou C2, D1, D3 a D5, z C3 základ. Na dashboardu je sekce „Deník“; první záznam na serveru je dnešní nasazení.

**Nové od 11. 11. 2026:** po každém nasazení se do logu na GitHubu vypíše stav zdrojů (bez cen, položek, adres a přístupů; souhlas Ládi), na serveru jde `bash deploy.sh --stav` a `bash deploy.sh --spust <zdroj>`.

**Rozhodnutí Ládi 10. 11. 2026:** celý katalog vždy, kde to jde, u všech dodavatelů. Je to výchozí chování všech zdrojů přes VeloConnect; zadané kódy jsou jen záloha.

**Stav 22. 11. 2026 večer (verze `v2026-11-22-7bb3738`), čtený z logu nasazení — nový cíl: kontrola zalistování.** Zadání Ládi: hlídat, jestli máme zalistované všechno, co dodavatel nabízí, nové položky, chybějící varianty, co máme a dodavatel už nevede; přehledně pro tým a s tabulkou pro import do Pohody. Hotové a nasazené jsou tři kroky (feedhub #19–#22):

1. **Náš sortiment z e-shopového feedu** (51 311 položek, denně 5:30) a párování nabídek podle EANu.
2. **Sekce „Sortiment“ na dashboardu** — po dodavatelích kolik nabídek máme, pohledy „nabízí a nemáme“, „máme a nenabízí“, „máme“, exporty pro Excel; značka a doporučená MOC z českých feedů.
3. **Katalog karet Pohody** (souhlas Ládi: číst export ze serverové složky, jen čtení; denně 6:40 a 12:40). První běh na serveru: **149 050 karet**, objednací název má 142 369, EAN 136 525, běh 47 s; sloupec Stav zásoby katalog nenese. Všech 51 311 položek e-shopu má kartu (kódy e-shopu a Pohody sedí). Tím začalo platit párování podle objednacího názvu a přibyly pohledy „jen karta, není na e-shopu“ a „ke kontrole“.

Čísla po kroku 3: z 117 709 aktuálních nabídek dodavatelů **máme 29 445** (EAN 27 370, objednací název 2 075; před katalogem 18 621), u 9 394 z nich máme jen kartu v Pohodě a na e-shopu nejsou, **nemáme 87 525**, **ke kontrole 739** (objednací název sedí na kód dodavatele, EAN je jiný — nejvíc Helios 213, Cyklomax 207, ABUS 93, Zookee 64, KCK 51). KCK: nabízí 6 210, máme 3 904 (jen karta 770), nemáme 2 255.

**Adresa pro tým: `https://sales.report/feeds/`** (rozhodnutí Ládi 22. 11.). Aplikace je připravená a nasazená; chybí jediný krok na serveru, který nasazení záměrně nedělá samo (konfigurace Caddy je vstupní brána Salesu, zásah s právy správce): `bash /home/suchan/actions-runner-feedhub/_work/feedhub/feedhub/deploy.sh --vratnice`. Příkaz upraví jen blok `sales.report`, uloží zálohu, nechá konfiguraci zkontrolovat a vrátí ji, kdyby Sales po změně odpovídal jinak.

**Stav 22. 11. 2026 v 19:01 (verze `v2026-11-22-42219c1`, feedhub #23), z logu nasazení:**

- **Adresa `https://sales.report/feeds/` funguje** (cesta na vrátnici je doplněná, log: „Vrátnice: … odpovídá“).
- **Přihlášení účtem Salesu, jen role TOP a admin** (rozhodnutí Ládi; nezaměňovat se `sales.report/znalosti`). Feed Hub se na platnost přihlášení ptá Salesu po vnitřní síti — log hlásí `"sales":"ok"`. Společné heslo platí už jen přímo na portu aplikace (SSH tunel).
- **Import do Pohody**: v Sortimentu v pohledu „Dodavatel nabízí, my nemáme“ tlačítko „Import do Pohody (XLSX)“ — soubor přesně podle vzoru od Ládi (Kód, Čár. kód, Název, Nákupní bez DPH, Prodejní bez DPH vzorcem z MOC, Dodavatel, Obj. název, Dop. MOC CZK/EUR, Sezona, Výrobce), se stejnými filtry jako seznam (dodavatel, značka, jen skladem, nové). Čísla dodavatelů z adresáře Pohody jsou u 64 zdrojů (z fotek adresáře; KCK 103639, Biketime 240482); chybí německý ABUS a Oberalp.
- **K rozhodnutí u importu:** nákupní cena je cena z feedu tak, jak je (u KCK velkoobchodní bez DPH, bez případné slevy); MOC v EUR se na Kč nepřepočítává; Sezona se zadává ručně; položky bez EANu se do souboru nedávají (u KCK jsou to řádky modelů).
- **MCP pro Claude Desktop**: v 19:01 ještě nebylo (čekalo na rozhodnutí, co smí ke Claudovi) — Láďa pak řekl „postav to jako v sales“, viz stav v 19:36 níže.

**Stav 22. 11. 2026 v 19:36 (verze `v2026-11-22-80c1109`, feedhub #24), z logu nasazení:**

- **Claude Desktop přes MCP je nasazený** (rozhodnutí Ládi: „postav to jako v sales“). Stejné řešení jako u Salesu: rozšíření `.mcpb` na počítači uživatele, jen po firemní síti nebo VPN, osobní klíč `sk-feedhub-…`, adresa `https://sales.report/feeds/mcp`. Log: zdraví `ok`, `"sales":"ok"`, vrátnice odpovídá, **kořenový certifikát Caddy uložen** (rozšíření ho ponese).
- **Jak se připojit:** `sales.report/feeds` → sekce *Claude Desktop* → *Vydat můj klíč* (ukáže se jednou) → *Stáhnout rozšíření* → v Claude Desktop Nastavení → Rozšíření → Instalovat rozšíření → vložit klíč. Pak třeba: „Vytáhni do import souboru všechny položky od KCK, výrobce Force, které nemáme založené.“
- **Co Claude umí (šest nástrojů, jen čtou):** přehled dodavatelů a pokrytí, značky dodavatele, položky dodavatele (nemáme / máme / jen karta / ke kontrole; značka, jen skladem, nové, hledání), naše položky, které dodavatel nenabízí, stav zdrojů a **import do Pohody — vrátí souhrn a odkaz**, soubor se stáhne z Feed Hubu v prohlížeči (položky ani ceny přes Clauda nejdou).
- **Nákupní ceny přes připojení jsou vypnuté**, dokud je TOP/admin v sekci Claude Desktop nezapne (zaškrtávátko, změna je v Deníku). To jsem zvolil já jako opatrnější výchozí stav — k potvrzení Láďou.
- **Klíče:** každý TOP/admin si vydává svůj, zrušit smí kterýkoli TOP/admin. Klíč platí, dokud se majitel aspoň jednou za 30 dní přihlásí do Feed Hubu účtem Salesu a má roli TOP/admin; v sekci je vidět, kdo se kdy na co ptal (bez obsahu dat). 60 dotazů za minutu na klíč.
- **Nezkoušeno naostro:** instalace rozšíření v Claude Desktop na firemním počítači (lokálně ověřeno skutečným mostem rozšíření proti kopii dat KCK: Force 1 717 nemáme → 1 370 do souboru).

**Stav 22. 11. 2026 ve 23:10 (verze `v2026-11-22-425d883`, feedhub #25), z logu nasazení:**

- **Láďa má MCP napojené a první dotaz („co od KCK značky Force nemáme“) nevrátil nic.** Příčina: značku u českých feedů čte Feed Hub až od odpoledního nasazení 22. 11., KCK ale naposledy běžel ve 12:00 — log ukázal u KCK 6 210 nabídek, se značkou 0. Filtr „Force“ proto nenašel nic a nástroj neřekl proč (stejně filtr značky a import v Sortimentu na dashboardu).
- **Opraveno a ověřeno z logu:** zdroje, které značku umí číst a ještě ji neměly, se po nasazení pustily jednou hned. Po doplnění má značku KCK u všech 6 210 nabídek, Helios 16 931, Zookee 11 918, Sport Import 10 535, Sport und Freizeit 9 394 a 8 747, Catherine 5 411, Origos 5 042, Cyklomax 4 871, ABUS 2 185, Vertone 1 912, Pedalsport 1 857, Crussis 1 286, Penco 145.
- **Bez značky zůstávají** (feed ji nenese, nebo ji mapování nečte): Bike Park, Biketime (Bulls), Crussis dostupnost, Ride Hard, Sidas, Viva. U nich filtr značky nepůjde, dokud se značka nedoplní do mapování zdroje.
- Když filtr značky nic nenajde, Claude teď dostane důvod (pole `pozor`) a má ho říct jako první; stejná věta je v Sortimentu. Výpis stavu ukazuje u zdroje počet nabídek se značkou.
- Ruční běh zdroje z GitHubu dál nejde — workflow „Spustit zdroj na serveru“ není registrovaný, dokud výchozí větev repozitáře není `main` (úkol Ládi).

**Stav 23. 11. 2026 v 10:45 (verze `v2026-11-23-de3e435`, feedhub #26), z logu nasazení:**

- Láďa potvrdil, že dotaz na KCK / Force přes Claude Desktop funguje.
- **Nákupní ceny přes Claude Desktop jsou zapnuté** (pokyn Ládi „zapni nákupní ceny“). Zapnula je jednou migrace 018, deník to zapsal v 10:45; přepínač v sekci Claude Desktop platí dál a jde jím ceny zase vypnout. Claude u položek dodavatele vidí nákupní cenu, měnu a přepočet na Kč.

**Zbývá z kontroly zalistování:** omezit objednací název na karty daného dodavatele (karta dodavatele nese, chybí přiřazení dodavatel Pohody → zdroj feedu), skupiny variant (chybějící velikosti a barvy), uložené parametry po dodavatelích (sledované značky), tabulka pro import nových položek do Pohody (potřebuje vzor od Ládi), týdenní souhrn mailem (čeká na SMTP).

## Kde jsme dnes

| Cíl | Co už je | Co chybí |
| --- | --- | --- |
| 1. Zavedení feedu | Formulář „Přidat feed“ pro XML: stáhne, navrhne mapování, ukáže vzorek z produkčního parseru, uloží. | Formulář pro VeloConnect, CSV a XLSX. Kontrola, že cena je nákupní a ne MOC. Přepočet z uloženého stažení po úpravě mapování. Jednotný stav dostupnosti. |
| 2. Změny mezi běhy | **Od 10. 11. večer:** každý úspěšný běh zapíše, co se změnilo (nová, zmizelá a vrácená položka, nákupní cena, MOC, naskladněno, vyprodáno, dostupnost, množství, termín, EAN, název). Na dashboardu sekce „Co se změnilo“ s filtry a exportem do Excelu, souhrn u posledního běhu. | Prahy na podezřelé změny (B3) a strop na stáří dat (B4). Starší historie zná jen cenu a dostupnost. |
| 3. Kdo změnu udělal | Semafor a text chyby u zdroje. | Rozlišení příčin (přihlášení, síť, struktura). Otisk struktury feedu. Deník událostí. Pošta, protože chybí SMTP. |
| 4. Naše změny | Nic. Úpravy z dashboardu se nezapisují, přihlášení je jedno společné. | Deník změn nastavení, kdo je udělal, změny přístupů v `.env`, deník nasazení. |

Dnešní zkušenost ukazuje, proč je to potřeba: Lindlau deset dní padal po mém nasazení z 31. 10. a nikdo se to nedozvěděl. Feed Hub to věděl (červený semafor), ale neřekl to nikomu a nedal to do souvislosti s nasazením.

## A. Napřed: bezpečnost a provoz

| # | Úkol | Výsledek | Kdo | Pracnost |
| --- | --- | --- | --- | --- |
| A1 | Heslo nesmí do chybové hlášky. Při HTTP chybě dodavatele se do historie běhů zapisovala celá adresa i s heslem k VeloConnectu. | **Hotovo 10. 11.** Chyba nese jen stav a adresu serveru, starší řádky jsou vyčištěné. Jestli se nějaké heslo opravdu uložilo, ukáže dotaz na značku „migrace 011“ v historii běhů; pak ho změnit. | Claude | hotovo |
| A2 | Přístupy Raymonu a Focusu do `.env` na serveru. | **Hotovo.** Oba se stahují denně (ověřeno 11. 11. z logu nasazení). | Láďa | hotovo |
| A3 | Zpřístupnit `/export/*` zvenku pro BHIT, interní adresa dashboardu `feeds.sales.report`. | BHIT má odkaz, dashboard jde otevřít bez tunelu. | František | zpráva odeslána |
| A4 | Potvrdit strukturu XML a zdrojovou IP. | BHIT feed načte. | Láďa, BHIT | e-mail |
| A5 | Denní záloha databáze Feed Hubu. Bez ní se historie změn nedá obnovit. | Záloha a vyzkoušená obnova. | Claude, František | 0,5 |
| A7 | Kupkolo skoro nic nenachází: z 6 904 ověřených EANů vede 4 (0,06 %), poslední běh 4 z 300. | **Neřeší se** (rozhodnutí Ládi 11. 11.): konkurence se napojí přes monitoring třetí strany. Noční běhy Kupkola a Bike-Discountu zatím běží dál; jdou vypnout tlačítkem u zdroje. | — | — |
| A8 | Výchozí větev repozitáře `feedhub` je stará `claude/claude-md-phase-1-fi5irl`, ne `main`. Kvůli tomu GitHub nezaregistroval ruční workflow „Spustit zdroj na serveru“. | Výchozí větev `main` (GitHub → Settings → General → Default branch). | Láďa | minuta |
| A9 | Fronta ověřování u konkurence: u dodavatelů je 87 821 různých EANů, Kupkolo zvládne 300 za noc. | **Neřeší se** (rozhodnutí Ládi 11. 11.), viz A7. | — | — |
| A6 | Počty na dashboardu brát jen z aktuálních nabídek a zboží na cestě nepočítat jako skladem. Totéž pro CSV pro IT Future. | Čísla sedí s tím, co je ve feedu. Je to změna zobrazených čísel, napřed ukázat dopad. Od 10. 11. dashboard aspoň ukazuje zvlášť, kolik nabídek dodavatel už neposílá. | Claude, Láďa rozhodne | 0,5 |

## B. Víme o každé změně mezi běhy (cíl 2)

| # | Úkol | Výsledek | Pracnost |
| --- | --- | --- | --- |
| B1 | Souhrn změn každého běhu: nové položky, zmizelé položky, změna ceny, dostupnosti a termínu. Počty k běhu, detail do historie. | **Hotovo 10. 11.** U každého stažení je vidět, co se proti minulému změnilo. Pojistka: když by zmizela víc než polovina položek, neoznačí se žádná a běh to řekne (neúplné stažení). | hotovo |
| B2 | Obrazovka „Co se změnilo“: po zdrojích, za poslední běh a za 7 dní, s filtrem a exportem do Excelu. | **Hotovo 10. 11.** Filtr období, dodavatele, druhu změny a hledání podle kódu, EAN nebo názvu; tabulka „kdo se měnil nejvíc“. Změny množství se drží 30 dní, ostatní 400. | hotovo |
| B3 | Prahy na podezřelé změny: skok ceny o víc než X %, hromadná změna dostupnosti, propad počtu položek. | Chyba ve feedu dodavatele se zachytí dřív, než se propíše dál. Prahy určí Láďa. | 1 |
| B4 | Strop na stáří dat ve výstupech. Dnes feed pro BHIT drží po výpadku poslední známý stav bez omezení. | Po N dnech výpadku se dodavatel z feedu vyřadí nebo označí. N určí Láďa. | 0,5 |

## C. Víme, kdo z dodavatelů změnu udělal (cíl 3)

| # | Úkol | Výsledek | Pracnost |
| --- | --- | --- | --- |
| C1 | Otisk struktury feedu při každém běhu: které prvky nebo sloupce přišly a jak jsou vyplněné. | Událost „dodavatel změnil strukturu“: přibyl prvek, zmizel prvek, prvek se vyprázdnil, změnila se měna. | 1 |
| C2 | Rozlišení příčin selhání: odmítnuté přihlášení, nedostupná adresa, přesměrování, změna struktury, prázdný feed. Ke každé česká věta, co s tím. | **Hotovo 11. 11.** Jedna tabulka pravidel: chybí nastavení, odmítnutý přístup, adresa neexistuje, chyba serveru dodavatele, spojení selhalo, feed nejde přečíst, prázdný feed. Příčina a rada jsou u záznamu o výpadku v deníku. | hotovo |
| C3 | Deník událostí, jedna časová osa za všechny zdroje: výpadek a obnova, změna struktury, změna ceníku s počtem cen, změna sortimentu, odmítnuté přihlášení. | **Základ hotov 11. 11.:** sekce „Deník“ s výpadky a obnovami zdrojů, nasazeními, úpravami nastavení a změnami přístupů. Chybí změna struktury (C1) a hromadné změny ceníku a sortimentu (B3). | 0,5 zbývá |
| C4 | Pošta: denní souhrn v 7:00 a okamžité upozornění při selhání. Je v zadání od začátku. | O změně se dozvíš, aniž bys otevřel dashboard. | 1, čeká na SMTP |

## D. Víme, když změnu uděláme my (cíl 4)

| # | Úkol | Výsledek | Pracnost |
| --- | --- | --- | --- |
| D1 | Deník změn nastavení zdroje: adresa, mapování, plán, zapnutí, kódy, zařazení do feedu. Hodnota před a po, adresy s tokenem maskovaně. | **Hotovo 11. 11.** Každé založení a úprava z dashboardu je v deníku jako před → po. | hotovo |
| D2 | Jmenná přihlášení místo jednoho společného. | V deníku je i kdo. Kolik lidí bude mít přístup, určí Láďa. | 1 |
| D3 | Změny přístupů v `.env`. Hodnoty nikdy neukládat, jen otisk. Při startu porovnat s minulým. | **Hotovo 11. 11.** Při nasazení se porovnají otisky přístupů zdrojů, adres feedů, hesla do dashboardu a tokenu feedu: přibylo, změnilo se, zmizelo. Jestli od té doby běhy procházejí, je vidět na stejné časové ose. | hotovo |
| D4 | Tlačítko „Ověřit přihlášení“ u zdroje. | **Hotovo 10. 11.** Tlačítko „Ověřit“ u zdroje přes VeloConnect: přístupy, přihlášení, co dodavatel umí, jestli jde stáhnout celý katalog (a kolik má položek) nebo proč ne, a tři položky na ukázku. Nic neukládá. | hotovo |
| D5 | Deník nasazení: která verze kdy naběhla. Po nasazení porovnat stav zdrojů před a po. | **Hotovo 11. 11.** Nasazení je v deníku a záznam o výpadku zdroje říká, jaká verze byla nasazena od posledního úspěšného běhu. Stav zdrojů se po nasazení vypisuje do logu. | hotovo |

## E. Sami si zavedeme feed do správného parsování (cíl 1)

| # | Úkol | Výsledek | Pracnost |
| --- | --- | --- | --- |
| E1 | Přidání dodavatele přes VeloConnect z dashboardu. Zadat adresu, název proměnné s přístupem, test připojení, zkouška hledání, vzorek. | **Hotovo 10. 11.** „Přidat feed“ → druh VeloConnect. Na serveru stačí řádek s přístupem v `.env` a nasazení. Přístup z `.env` se posílá jen na server, ke kterému patří. | hotovo |
| E2 | Kontrolní položky u zdroje: tři až pět kódů s ručně ověřenou nákupní cenou. Každý běh ověří, že je parser čte stejně. | Jistota, že se bere nákupní cena, ne MOC, a že to tak zůstane. | 1 |
| E3 | Přepočet z uloženého stažení po úpravě mapování. | Změnu mapování ověříš hned, bez dalšího dotazu na dodavatele. | 0,5 |
| E4 | Jednotný stav dostupnosti napříč dodavateli: skladem, na cestě, není, neznámé, plus množství. Pravidla po zdrojích, vidět ve vzorku. | Dostupnost jde porovnávat a posílat dál v jednom tvaru. | 1,5 |
| E5 | Formulář pro CSV a XLSX z adresy nebo ze složky. Dnes jen XML. | Pokrytí zbylých formátů bez programování. | 2 |
| E6 | Projít 23 vypnutých feedů a 21 adres s tokenem. | Co nejvíc dodavatelů ze seznamu BHIT a IT Future opravdu běží. | Láďa a Claude, průběžně |
| E8 | Číst i údaje, které dnes zahazujeme. Raymon posílá u každé položky kód výrobce, zařazení do skupiny, odkaz na informace o zboží a sazbu DPH (ověřeno 10. 11. na staženém katalogu). Lindlau navíc velikost balení a minimální odběr. | Kód výrobce pomůže s párováním na karty, skupina s orientací v sortimentu. | 1 |
| E7 | Lindlau: číst celý katalog. | **Hotovo 10. 11.** Lindlau na stránku hledání bez parametru `ResultFormat` vrací jen počet, položky až na `ITEM_DETAIL`; klient to teď zkusí sám. Katalog má 8 898 položek místo dosavadních 937. Velikost balení je 1 u 936 z 937 dosud stahovaných položek (jedna má balení po 50), minimální odběr má 59 položek; ani jedno Feed Hub zatím nečte, viz E8. | hotovo |

## Navržené pořadí

1. **A1 a A2.** Bezpečnost a dva dodavatelé, kteří čekají jen na řádky v `.env`. A1 hotovo, A2 čeká na Láďu.
2. **A6, B1 a B2.** Základ všeho ostatního: co je aktuální nabídka a co se mezi běhy změnilo. B1 a B2 hotovo, A6 čeká na rozhodnutí.
3. **C1, C2 a D5.** Kdo za změnou stojí, dodavatel nebo naše nasazení.
4. **D1, D3 a D4.** Naše vlastní změny.
5. **C3 a C4.** Deník a pošta. Pošta čeká na SMTP.
6. **Blok E.** Zavádění dalších feedů.

Bloky A až D dávají dohromady zhruba dva týdny práce, blok E další týden.

## Co musí rozhodnout nebo dodat lidé

- **Láďa:** prahy pro podezřelé změny, po kolika dnech výpadku dodavatele vyřadit z feedu, kdo má mít přístup do dashboardu. Od 22. 11.: potvrdit pravidla importu do Pohody (nákupní cena, MOC v EUR, sezona), doplnit číslo dodavatele pro německý ABUS a Oberalp, říct, které značky u kterého dodavatele sledovat. (Hotovo 22. 11.: vrátnice `sales.report/feeds`, vzor importní tabulky, adresář dodavatelů, rozhodnutí o MCP — „jako v Sales“, rozšíření v Claude Desktop vyzkoušeno; 23. 11.: nákupní ceny přes Claude Desktop zapnuty.)
- **František:** SMTP pro poštu, zpřístupnění feedu zvenku, interní adresa, místo pro zálohy.
- **BHIT:** potvrzení struktury XML a zdrojová IP.
- **Pavel:** přístupy k VeloConnectu pro MBPS a ABUS, kontrolní položky s ověřenou nákupní cenou.
