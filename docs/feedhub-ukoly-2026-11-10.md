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

**Zbývá z kontroly zalistování (stav 23. 11. 2026 večer):** omezit objednací název na karty daného dodavatele (karta dodavatele nese, chybí přiřazení dodavatel Pohody → zdroj feedu) a týdenní souhrn mailem (čeká na SMTP). **Hotovo:** skupiny variant a chybějící varianty, sledované značky (značky, které vedeme, a ruční přiřazení značek), tabulka pro import do Pohody.

## Kde jsme dnes

Stav k 25. 11. 2026 po ranním běhu. Přehled pro tým je v dokumentu [Feed Hub: co děláme a co umíme](https://claude.ai/artifact/CF5dfPP7jNhBn8787jYsqy), na jeho druhé záložce jsou čísla po dodavatelích.

| Cíl | Co už je | Co chybí |
| --- | --- | --- |
| 1. Zavedení feedu | Formulář „Přidat feed“ pro XML i VeloConnect s ověřením připojení. Feed v JSON, v ZIPu, velký feed proudem, klíč v adrese i v hlavičkách. Excel nahraný na dashboardu, ceník ke zdroji, druhý feed téhož dodavatele (Crussis, Cyklomax). Náhled varuje, když kód dodavatele není jedinečný. | Formulář pro CSV. Přepočet z uloženého stažení po úpravě mapování. Druhý feed se nastavuje migrací, ne formulářem. |
| 2. Změny mezi běhy | Každý úspěšný běh zapíše, co se změnilo. Sekce „Co se změnilo“ s filtry a CSV. Oprava čtení z migrace ani změna adresy se do změn nezapisují. | Prahy na podezřelé změny (B3) a strop na stáří dat (B4). Ride Hard přepočítává ceny kurzem: jedna změna kurzu = tři tisíce událostí „nákupní cena“. |
| 3. Kdo změnu udělal | Semafor, historie běhů, deník výpadků a obnov s příčinou a s tím, jestli mezitím proběhlo naše nasazení. Stav po nasazení v logu na GitHubu. | Denní e-mail, chybí SMTP. Otisk struktury feedu. |
| 4. Naše změny | Deník: nasazení, založení a úpravy zdrojů (před → po), změny přístupů v `.env`, nahrané soubory a ceníky, přiřazení značek, ruční páry. | U změn z přímého přístupu na port není, kdo je udělal. |
| 5. Kontrola zalistování (od 22. 11.) | Náš sortiment z e-shopu a z karet Pohody, párování EAN → objednací název → ručně. Co nemáme, chybějící varianty, značky, které vedeme, import do Pohody, Claude Desktop. | Omezit objednací název na karty daného dodavatele. Nákupní ceny u 10 feedů, které je nenesou. Týdenní souhrn mailem. |

Čísla z 25. 11. 2026 v 7:14 (verze `v2026-11-25-16808aa`): 73 zdrojů, 52 zapnutých, z nich 47 v pořádku, 3 s varováním (Aspire sport přechodně, obě konkurence) a 2 červené (Salewa čeká na svůj Order Sheet, MBPS na přístup). 226 338 nabídek od 44 dodavatelů, máme 62 586, nemáme 162 750, ke kontrole 1 002.

Večer 25. 11. 2026 ve 22:41 (verze `v2026-11-25-83dd701`): 74 zdrojů, 53 zapnutých. Přibyl zdroj `raymon-api` (nové B2B API Raymonu, vypnutý, čeká na přístup v `.env`), Silvini se poprvé stáhlo ze serveru (dostupnostní feed Viking, 17 093 nabídek) a nová pojistka hlídá, jestli dva zapnuté zdroje téhož dodavatele nenesou tytéž položky. Hned našla znovu zapnutý starý zdroj Sport und Freizeit (8 015 společných nabídek); po rozhodnutí Ládi je zase vypnutý. Sortiment po tom: z 243 467 nabídek zapnutých zdrojů máme 67 961, nemáme 174 502, ke kontrole 1 004 — proti ránu přibylo Silvini.

Zkušenost z 10. 11., proč je to potřeba: Lindlau deset dní padal po mém nasazení z 31. 10. a nikdo se to nedozvěděl. Feed Hub to věděl (červený semafor), ale neřekl to nikomu a nedal to do souvislosti s nasazením.

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

## F. Feedy podle obratu dodavatele (23. 11. 2026)

**Stav 25. 11. 2026 ve 22:41 (feedhub #54 až #56; verze `v2026-11-25-83dd701`), z logu nasazení — Raymon API, Silvini a pojistka na překryv zdrojů:**

- **Raymon má nové B2B API** (Postman kolekci poslal Láďa). Proti VeloConnectu nese skutečné kusy skladem a naše ceny s množstevními stupni; termín dodání nenese. Zdroj `raymon-api` je založený a **vypnutý**: mapování je podle veřejného popisu rozhraní, skutečná data jsme neviděli. **Čeká na Láďu:** řádek `RAYMON_API_AUTH=e-mail:heslo` (přihlášení do B2B Raymonu) do `.env` na serveru a nasazení. Po prvním běhu se rozhodne, jestli Raymon přepnout na API (a VeloConnect vypnout), nebo nechat VeloConnect kvůli termínům.
- **Silvini se poprvé stáhlo** (Láďa odpoledne nastavil na dashboardu dva feedy Viking): `silvini-viking-dostupnostni` běží — 17 093 nabídek, všechny s EANem, máme 5 382 (jen karta 3 218), nemáme 11 710. Feed nese jen kód, EAN a dispozici, takže nabídky jsou **bez názvu, značky a ceny**. `silvini-viking-zalistovaci` (názvy, nákupní ceny, sklad) je nastavený, ale vypnutý. Další krok: zapnout zalistovací feed; Feed Hub hned řekne, jestli nese tytéž položky jako dostupnostní, a pak nechat zapnutý jen jeden (nebo je spojit jako druhý feed).
- **Pojistka na překryv zdrojů** (feedhub #55): když dva zapnuté zdroje téhož dodavatele nesou tytéž položky (stejný kód nebo EAN u aspoň poloviny nabídek menšího z nich), napíše to Feed Hub nad tabulku Sortimentu, k oběma zdrojům, do výpisu stavu, Claudovi a hned po zapnutí takového zdroje. Nic sám nevypíná. Zapnutí a vypnutí zdroje se nově v Sortimentu projeví hned.
- **Co pojistka našla na serveru:** starý zdroj `sport-und-freizeit` (fischer-shop.cz), který Láďa v 17:23 znovu zapnul, nese 8 015 z 9 396 nabídek shodných s novým zdrojem (8 016 z 8 712). Starý feed má navíc všechny položky „skladem: ne“. **Láďa rozhodl vypnout — hotovo ve 22:41 (feedhub #56, migrace 041)**, varování zmizelo a součty sedí. Summit Trade (produkt × outlet) se nehlásí — společná je menšina.
- Beze změny: Salewa čeká na svůj Order Sheet, MBPS na přístup, Aspire sport je přechodně ve varování.

**Stav 25. 11. 2026 v 7:14 (feedhub #53; verze `v2026-11-25-16808aa`), z logu nasazení — Crussis a Cyklomax jsou každý jeden zdroj:**

- **Druhý feed téhož dodavatele** (`app/second_feed.py`, migrace 039): hlavní zdroj při běhu stáhne i druhý feed a spojí ho přesnou shodou kódu dodavatele. Doplňuje jen to, co hlavní feed nemá. Když druhý feed nejde přečíst, běh končí chybou a nabídky zůstanou, jak byly.
- **Crussis** na serveru: 2 649 nabídek, sklad doplněn u 1 163 produktů, 1 363 položek je jen ve feedu dostupnosti (kód a sklad, bez názvu). Máme 1 046, nemáme 1 603.
- **Cyklomax** na serveru: 4 866 nabídek, nákupní cena u 202. U Cyklomaxu tím odpadá rozhodnutí, který feed nechat — nic se neztrácí; zbývá chtít cenu pro celý sortiment.
- Zdroje `crussis-dostupnost` a `cyklomax-novy` jsou vypnuté a zapnout nejdou (čte je hlavní zdroj); adresa se u nich dál mění přes Upravit. První běh byl nové načtení bez událostí.
- **Zlom:** součet nabídek zapnutých zdrojů klesl z 227 703 na 226 338, „máme“ z 63 331 na 62 586 (nabídky se už nepočítají dvakrát). Vypnutých zdrojů je 21.
- Sloupec „Skladem“ v přehledu feedů počítá u XML feedů jen textové stavy, ne kusy — u Crussis proto ukazuje nulu, i když Sortiment sklad zná. Čeká na rozhodnutí z 10. 11. (jednotný stav dostupnosti).

**Stav 25. 11. 2026 v 6:52 (feedhub #52; verze `v2026-11-25-64adc6e`), z logu nasazení — první ranní běhy po včerejších opravách:**

- **Všechny zdroje v 6:00 proběhly.** Ze 54 zapnutých je 49 v pořádku, 3 s varováním, 2 červené. Červená je podle očekávání **Salewa** (má nahraný sešit Dynafitu, čeká na svůj Order Sheet) a MBPS (přístup).
- **Varování na opakované kódy nedostal žádný zdroj** — všude je to pod 5 %, jen poznámka běhu: N Distribution 76, ABUS 19, Sloger 18, Origos 15, Sport Import 6, Snow-How 3, OneUp 2. Pinguin neuložil 191 položek bez kódu i EANu.
- **Endura** drží 8 581 nabídek s kódem varianty (oprava z migrace 038 vydržela ranní běh). **Bike Fun** má cenu z ceníku u 1 314 z 1 497 nabídek, žádost o nový ceník nevznikla.
- **Ride Hard zapsal 2 990 změn nákupní ceny.** Není to chyba čtení: 2 883 položek se změnilo stejným poměrem (−0,16 %), dodavatel přepočítává ceny kurzem (O´Neal, Kini Red Bull, ONE; SIXS beze změny). Ověřeno produkčním parserem nad feedem z 23. a z 25. 11. Každá změna kurzu tak udělá v „Co se změnilo“ tři tisíce událostí — k rozhodnutí Ládi, jestli drobné změny ceny schovat.
- **Bike-Discount** v noci odmítl všech 1 500 stránek (403). Podle rozhodnutí z 11. 11. se konkurence neřeší.
- **Značka Raymonu** se nepočítá mezi značky, které vedeme, i když ji na e-shopu máme (412 položek) — v katalogu Raymonu je zapsaná jinak. Přiřadit ji musí člověk v Sortimentu, stejně jako Merrell a Saucony (Aspire sport) a OneUp.
- Sortiment: z 227 703 nabídek zapnutých zdrojů máme 63 331 (EAN 60 526, objednací název 2 805), nemáme 163 368, ke kontrole 1 004. E-shop 49 006 položek, karet Pohody 149 221.
- Přehled „Feed Hub: co děláme a co umíme“ je přepsaný na dnešní stav (odkaz v části Kde jsme dnes).

**Stav 24. 11. 2026 ve 22:40 (feedhub #50 a #51; verze `v2026-11-24-34a78ac`), z logu nasazení — Láďa doplnil adresy a soubory:**

- **Běží všechno kromě MBPS:** zdrojů 73 (vypnutých 19), funkčních 53. Aspire sport má správnou adresu (8 408 nabídek; 19 700 omylem načtených vyřazeno), Bike Fun má ceník (cenu 1 314 z 1 497), Endura 8 581 (máme 3 783, nemáme 4 798, chybějící varianty 1 660), Summit Trade 9 384 z produktového feedu čteného proudem (máme 180, nemáme 9 204, chybějící varianty 566), Dynafit 8 956 (máme 2 135, nemáme 6 821), OneUp 281 (máme 122).
- **4ever: nákupní cena je `CUSTOMER_PRICE / 1,21`** (feedhub #50). Láďa odpověď neměl, rozhodla naše nákupní cena vedená v Disivu: rovná se `CUSTOMER_PRICE` přesně u 66 ze 70 kol. `CATALOGUE_PRICE` (tabulka BHIT), který se četl první den, je o 7 % vyšší.
- **Dvě chyby při zadávání a pojistky** (feedhub #51): (1) u Endury se při druhém uložení formuláře změnil kód na prvek vybraný z roletky (`MaterialNumber`, 1 724 hodnot na 8 581 variant) — roletky u polí nastavených výrazem ukazovaly „— nepoužít —“. Mapování je obnovené; formulář nově ukazuje „nastaveno výrazem — ponechat“ a při výběru prvku hned varuje, že kód není jedinečný. (2) Do zdroje Salewa se nahrál sešit Dynafitu (8 956 nabídek dvakrát) — vyřazeno; zdroj nově čeká svou značku sešitu a cizí odmítne.
- **Čeká na Láďu:** Order Sheet Salewy (do té doby je zdroj červený), přiřadit v Sortimentu značky OneUp Components → Oneup a u Aspire sport Merrell a Saucony. Nákupní ceny chybí u Sidasu, Progress Cycle a Endury (feedy je nenesou).

**Stav 24. 11. 2026 ve 21:50 (feedhub #46 až #49; verze `v2026-11-24-6806f00`), z logů nasazení — adresy z tabulek běží, opravená mapování:**

- **Všech 14 feedů s adresami z tabulek BHIT a IT Future běží** (Láďa doplnil `.env` ve 20:29): 4ever 799, Beany 348, Cyklo Profi 4 426, Cyklo Žitný 2 687, Cyklospeciality 5 752, N Distribution 9 122, Pinguin 1 569, Protocycles 61, Rascal 287, Sloger, Snow-How, Summit Trade ×2, Zookee. Funkčních zdrojů 49 (ráno 36).
- **Tři mapování z října ztrácela varianty** (feedhub #47, migrace 035) — zjištěno kontrolou produkčním parserem nad staženými feedy. Po opravě: **Sloger 11 627 nabídek** (dřív 7 396; máme 3 590, nemáme 8 021, chybějící varianty 224), **Snow-How 614** (dřív 368), **outlet Summit Trade 3 925** (dřív 1 435). Hlavní feed Summit Trade se nově čte z produktového feedu (168 MB, proudem — 20 MB paměti místo 1 GB): 9 384 variant s názvem, značkou, cenou a skladem; čeká na vložení adresy.
- **Endura** (feedhub #46): mapování katalogu v JSON hotové (8 581 variant, všechny s EANem, 958 máme na e-shopu, bez cen); čeká na vložení adresy.
- **Zdvojené zdroje vypnuty:** starý Sport und Freizeit (všech 9 396 položek „skladem: ne“), starý Zookee (bez ceny), dostupnostní feed Summit Trade. Vypnutý zdroj se v Sortimentu ani v součtech nepočítá. Sortiment ve 21:47: z 211 710 nabídek zapnutých zdrojů máme 67 225, nemáme 143 391, ke kontrole 1 094.
- **Názvy, značky a skupiny variant u šesti feedů** (feedhub #49, migrace 036) — u feedů se stavbou produkt → varianty se jako název četl název parametru („velikost“). Po opravě: **Ride Hard 3 787 nabídek** (dřív 3 236; přibylo 551 produktů bez variant; značky O´Neal, SIXS, Kini Red Bull; máme 245, nemáme 3 541, chybějící varianty 159), **Sidas 950** (dřív 884; máme 640, nemáme 310), **Viva 2 569** s kódem dodavatele `CODE-velikost` (máme 1 273, nemáme 1 291, chybějící varianty 185), **Sport Import** se značkou z prvku `<brand>` (dřív 1 212 „značek“ = názvy variant) a rozpoznaným skladem, **Crussis** se skutečným názvem místo kódu, **Bike Time** s názvem a značkou. **Sidas: nákupní cena se přestala číst** — feed nese jen ceník MOC a jeho cena bez DPH byla v mediánu 111 % naší prodejní ceny; kontrola stejného poměru u ostatních feedů nic nenašla (0,64–0,90).
- **Pojistka** (feedhub #48): běh říká, kolik položek feedu se neuložilo (bez kódu i EANu, opakovaný kód); nad 5 % opakovaných kódů je varování „kód dodavatele není jedinečný“ — chyba typu Summit Trade se příště ukáže sama.
- **Méně klikání:** po vložení adresy ve formuláři Upravit se zdroj stáhne sám; výpis stavu po nasazení čeká i na zdroje odblokované doplněním `.env`.
- **Čeká na Láďu:** vložit dvě adresy ve formuláři Upravit (`endura-2`, `summit-trade-produkt` — soubor s adresami dostal), rozhodnout nákupní cenu 4ever (`CATALOGUE_PRICE` podle BHIT, nebo `CUSTOMER_PRICE / 1,21` podle IT Future — o 9 % méně), nahrát ceník Bike Funu a soubory Ober Alpu a OneUpu, opravit adresu Aspire sport.

**Stav 24. 11. 2026 v 17:10 (feedhub #43, #44, #45) — ceník Bike Funu, Progress Cycle, soubory Ober Alp a OneUp, adresy z tabulek:**

- **Ceník ke zdroji** (feedhub #43): feed bez cen dostane ceny ze souboru nahraného na dashboardu („Nahrát ceník“ u řádku zdroje). U Bike Funu je to export z jejich B2B: po nahrání má cenu 1 316 z 1 497 nabídek a MOC 1 120 (ověřeno nad skutečným feedem a souborem). Když se ve feedu objeví nový produkt mimo ceník, zdroj zoranžoví, v Úkolech vznikne žádost a deník ji zapíše; nahráním nového souboru se uzavře. Značka doplňků: SF = Superior, NF = One Bikeparts. **Čeká na Láďu:** nahrát soubor na dashboardu.
- **Progress Cycle** (feedhub #44) běží: 4 910 nabídek, máme 2 143 (jen karta 617), nemáme 2 755, u značek, které vedeme, 1 829, chybějící varianty 390. Nákupní cenu feed nenese (jen doporučenou MOC) — zbývá ceník.
- **Ober Alp a OneUp** (feedhub #45): soubor se nahrává na dashboardu („Nahrát soubor“). Dynafit: 8 956 položek s nákupní cenou, MOC, EANem a skladem; OneUp: 283 položek se skladem (bez EANu a cen; hlavička má SKU a Brand prohozené, mapování s tím počítá). **Čeká na Láďu:** nahrát soubory Dynafit, Salewa a OneUp.
- **Adresy z tabulek BHIT a IT Future:** pro 14 zapnutých zdrojů, které čekaly na adresu, je připravený soubor řádků pro `.env` (není v repozitáři). Ověřeno stažením a produkčním parserem: 4ever 799, Cyklo Profi 4 426, Cyklo Žitný 2 687, N Distribution 9 164, Pinguin 1 761, Protocycles 61, Sloger 7 415, Snow-How 368, Summit Trade dostupnost 12 926 a outlet 3 907. Odsud neověřeno (server pouští jen některé adresy): Beany, Rascal, Zookee, Cyklospeciality. **Summit Trade produkt** vynechán: feed má 168 MB a jeho čtení bere 1,1 GB paměti (kontejner má 2 GB), nese jen názvy a zdvojil by nabídky — chce to spojit názvy s dostupnostním feedem jinak.
- Nové možnosti z tabulek: Endura má katalog v JSON (teď už čitelný), Vertone vrací XML `<stock>` — oba čekají na mapování. MTBiker a Viva vracejí 404, Level Sport chybu na své straně.

**Stav 24. 11. 2026 v 16:20 (verze `v2026-11-24-57c128c`, feedhub #42), z logu nasazení — Bike Fun běží:**

- Láďa doplnil klíč do `.env` a nasadil; zdroj se v 16:11 stáhl sám hned po startu. **1 499 nabídek** (EAN má 1 498, značku 1 247, bez cen — feed je nenese).
- Zalistování: **máme 841** (z toho 101 jen kartu v Pohodě, na e-shopu není), **nemáme 653** — z toho 486 od značek, které vedeme (Superior, Rock Machine); ke kontrole 5 (objednací název sedí, EAN ne).
- Zbývá: ceník Bike Funu (nákupní ceny a doporučené MOC — bez něj vyjde import do Pohody bez cen) a potvrdit značku doplňků (kódy SF = Superior, NF = One Bikeparts?). Úkol v záložce Úkoly je přepsaný, odškrtnutí je na Láďovi.
- Stav serveru: 72 zdrojů (18 vypnutých), 34 funkčních, 2 s varováním, 36 nefunkčních nebo bez běhu; 178 597 nabídek, máme 54 801, nemáme 118 626.

**Stav 24. 11. 2026 v 15:35 (verze `v2026-11-24-133d132`, feedhub #41), z logu nasazení — Bike Fun má mapování, čeká jen na klíč:**

- Se souhlasem Ládi jsem feed volného skladu stáhl klíčem z podkladů Bike Funu. **Je to JSON, ne XML** — Feed Hub ho nově čte převedený na XML (stejný parser a mapování, i ve formuláři Přidat feed). Totéž odemyká katalog Endury, až bude adresa.
- Feed: 1 497 položek (kola Superior a Rock Machine, doplňky), EAN má 1 496, **bez cen**. Skladem 1 051 položek (42 340 kusů), 446 není skladem a všechny mají týden dodání. Proti kopii e-shopu z 21. 11. máme 737 položek, kód Bike Funu je u 696 z nich i náš kód.
- Pravidla mapování (migrace 029): dostupnost = volný sklad (řádek `Year` 1900 / `Week` 01); **termín dodání = pátek prvního dalšího týdne s kusy, jen když je sklad nula**; `QtyOnHand` se nečte; značka z kódu — `801.` Superior, `803.` Rock Machine. Doplňky `SF…` a `NF…` (252 položek) jsou zatím bez značky: SF je u nás Superior u 12 z 12, NF One Bikeparts u 20 z 22 — čeká na potvrzení Ládi.
- Zdroj je **zapnutý**. První běh v 15:35 skončil podle očekávání chybou „chybí přístup k feedu v .env (BIKE_FUN_FEED_AUTH)“ — klíč na serveru ještě není. **Zbývá jediné:** řádek `BIKE_FUN_FEED_AUTH=<Client-Id>:<Client-Secret>` do `.env` a nasadit; zdroj se pak stáhne sám hned po startu (nově platí pro každý zdroj, kterému chybělo jen nastavení).
- Stav serveru: 72 zdrojů (18 vypnutých), 33 funkčních, 2 s varováním, 37 nefunkčních nebo bez běhu; 177 098 nabídek.

**Stav 24. 11. 2026 v 15:05 (verze `v2026-11-24-b2ebfff`, feedhub #40), z logu nasazení — Bike Fun:**

- Stránka „Forbidden“ u feedu Bike Funu **není blokovaná IP adresa**. Podle podkladů Bike Funu z 26. 2. 2026 (Pavel je přeposlal 24. 11.) feed chrání Cloudflare Access a přístup se posílá ve **dvou hlavičkách** (`CF-Access-Client-Id`, `CF-Access-Client-Secret`) — proto ho neotevře ani prohlížeč.
- Feed Hub to od této verze umí: v nastavení zdroje jsou jen názvy hlaviček, hodnoty klíče jsou v `.env` na serveru (jedna proměnná, hodnoty oddělené dvojtečkou). Hlavičky dostane jen server z adresy feedu. Zdroj `bike-fun-international-s-r-o` má název proměnné a hlaviček přednastavený, **zůstává vypnutý a bez mapování**.
- **Chybí na serveru:** řádek `BIKE_FUN_FEED_AUTH=<Client-Id>:<Client-Secret>` v `.env` a nasazení. Pak u zdroje Upravit → Stáhnout a rozebrat.
- **Mapování není připravené:** strukturu feedu jsem neviděl (stažení odsud klíčem z mailu neproběhlo — čeká na souhlas Ládi). Podklady říkají jen: volný sklad má vždy `Year` 1900 a `week` 01, `Qty` = počet kol. Položka tedy nejspíš chodí ve víc řádcích (sklad a týdny dodání) a mapování to musí rozlišit.
- Podklady zmiňují i druhý, produktový feed (specifikace a obrázky) s tokenem v adrese — jde vložit formulářem Přidat feed.
- Vedlejší opravy formuláře: rozbor už nedrží v paměti odmítnutí (po doplnění přístupu se feed zkusí hned znovu) a zdroj založený bez mapování si při rozboru vezme navržená pole (dřív zůstala prázdná — týká se i Silvini, MTBiker a dalších vypnutých zdrojů).
- Stav serveru: 72 zdrojů (19 vypnutých), 33 funkčních, 2 s varováním (oba zdroje konkurence), 37 nefunkčních nebo bez běhu; 177 098 nabídek, máme 53 960, nemáme 117 973.

**Stav 24. 11. 2026 v 00:07 (verze `v2026-11-24-3d5ec23`, feedhub #39), z logu nasazení — nezávislá kontrola večerních změn, opravy nasazené:**

- Večerní změny (feedhub #30–#38, asi 2 100 řádků) prošly nezávislou kontrolou — druhý agent je jen četl, pouštěl sondy a měřil. Našel dvanáct věcí, všechny jsou opravené a mají vlastní test (305 testů).
- Tři mohly dát špatná data: neúplné stažení hned po změně adresy feedu by položky tiše vyřadilo; ruční páry by přestaly platit po přejmenování dodavatele; značku se zápisem jen na staré kartě Pohody nešlo přiřadit.
- Jedna zpomalila pohled „Máme, dodavatel nenabízí“ ze zlomku sekundy na sekundy (opraveno, nad skutečnými feedy 0,05 s).
- Dvě se tvářily jako „nic nechybí“: Claude u filtru „jen naše značky“ a u přehledu dodavatelů tam, kde feed značku nebo varianty nenese.
- Po nasazení oprav jsou čísla na serveru stejná jako před nimi (máme 53 950, nemáme 117 924, ke kontrole 941; 34 funkčních zdrojů) — opravy nic nerozbily.
- **Čeká na Láďu:** opravit adresu u zdroje Aspire sport; rozhodnout o smazání 19 669 omylem načtených řádků; poslat od Level Sportu soubor s cenami a skladem (a další značky); potvrdit, že `PRICE` u Paul Lange je nákupní bez DPH; vyměnit přístupový klíč v adrese Stablecamu; poslat soubory nebo adresy OneUp a Endura.
- Kontrola zároveň potvrdila, že rozdělení nabídek (ručně / EAN / objednací název / ke kontrole / nemáme) dává vždy součet všech nabídek, zápisy jsou chráněné a migrace bezpečné.

**Stav 23. 11. 2026 ve 23:37 (verze `v2026-11-23-f509ba5`, feedhub #36–#38), z logu nasazení — vše nasazeno:**

- Přiřazení značek, záložka Nápověda i ruční párování běží na serveru; kontrola po nasazení v pořádku (databáze, start, spojení na Sales). Čísla Sortimentu se ručním párováním nezměnila (zatím žádný ruční pár): máme 53 950, nemáme 117 924, ke kontrole 941.

**Průběh 23. 11. 2026 večer (feedhub #36–#38):**

- **Přiřazení značky dodavatele k naší značce** je nasazené (verze `v2026-11-23-eb0c2ff`): Sortiment → dodavatel → ve filtru Značka vyber značku s poznámkou „nevedeme“ → pod filtry „Je to naše značka pod jiným názvem?“ → vyber naši značku → Přiřadit.
- **Záložka Nápověda** (nasazuje se): návod pro kolegy přímo ve Feed Hubu — `https://sales.report/feeds/#napoveda`.
- **Ruční párování** (feedhub #38, čeká na testy a nasazení): položku, kterou máme pod jiným kódem nebo EANem, jde spárovat s naší kartou — odkaz „spárovat ručně“ pod položkou v pohledech *Dodavatel nabízí, my nemáme* a *Ke kontrole*. Tím je hotový třetí krok párování ze zadání (EAN → objednací název → člověk) a 941 položek „ke kontrole“ má jak vyřešit.

**Stav 23. 11. 2026 ve 23:18 (verze `v2026-11-23-0ee3a14`, feedhub #34 a #35), z logu nasazení — dvě nové věci v Sortimentu:**

- **Chybějící varianty** (model máme, ale ne všechny velikosti a barvy): Sortiment → dodavatel → *Dodavatel nabízí, my nemáme* → filtr **Varianty: jen chybějící (model už máme)**. Čísla ze serveru: Aspire 1 396, Zookee 670, Sport und Freizeit 187 a 172, ABUS 157, Origos 72, Level Sport 100 % 57, LAID 40, KCK 22, Penco 20, Crussis 12. U dodavatelů, jejichž feed varianty nespojuje (Paul Lange, Stablecam, Helios, Sport Import…), stránka říká, že to z feedu poznat nejde.
- **Co nám chybí u značek, které už prodáváme:** filtr **Naše značky: jen které vedeme** a počet v přehledu. Ze serveru: Aspire nemáme 9 325, z toho u našich značek 6 531; Helios 12 460 → 5 779; Zookee 6 353 → 5 689; Sport und Freizeit 8 338 → 3 943; Lindlau 6 802 → 3 758; Paul Lange 3 521 → 3 339; KCK 2 254 → 2 045; Cyklomax 3 306 → 1 789; Origos 4 645 → 710. Značka se pozná jen podle stejného názvu.
- **Ruční přiřazení značky dodavatele k naší značce** (feedhub #36, nasazuje se): kde dodavatel píše značku jinak („SRAM ROCK SHOX“ × naše „RockShox“), jde ji v Sortimentu po výběru značky přiřadit. Pak se počítá mezi naše značky a v importu do Pohody je ve sloupci Výrobce náš zápis. Import nově upozorní na řádky se značkou, kterou nevedeme.
- Oba filtry i počty jsou také v CSV, v importu do Pohody a u Clauda (`jen_chybejici_varianty`, `jen_nase_znacky`).
- Server: 72 zdrojů (19 vypnutých), 34 funkčních; 176 988 nabídek; máme 53 950, nemáme 117 924 (včetně zdvojeného Aspire sport).

**Stav 23. 11. 2026 ve 22:52 (verze `v2026-11-23-341bd69`, feedhub #32 a #33), z logu nasazení:**

- **Paul Lange běží.** Láďa poslal obsah feedu uložený z prohlížeče; mapování je nasazené a server přes Cloudflare projde: 6 774 nabídek za 7 s (EAN 6 438, cena 6 568, značka 6 771). **Máme 3 234 (jen karta 1 061), nemáme 3 521 (bez EAN 273), ke kontrole 19.** Značka je první slovo názvu (Shimano 4 518, Schwalbe 598, PRO 589, Lazer 481, Elite 253). Cena `PRICE` = nákupní bez DPH — k potvrzení Láďou. Druhý feed Paul Lange (`img.paul-lange.cz`) je dál vypnutý, obsah neznáme.
- **Stablecam běží** (úkol 44): feed chodí v ZIPu, Feed Hub ho teď rozbalí sám. 5 031 nabídek s nákupní cenou, MOC a skladem; **názvy ani značky feed nenese**. Máme 81 (jen karta 43), nemáme 4 950. Do importu nových položek nejde (bez názvu).
- **K řešení Láďou:** adresa Stablecamu je v repozitáři od 19. 10. i s parametrem `access=`. Jestli je to přístupový klíč, je vhodné nechat si u Stablecamu vystavit nový a vložit ho jen ve formuláři Upravit.
- Server celkem: 72 zdrojů (19 vypnutých), 34 funkčních, 1 s varováním, 37 nefunkčních nebo bez běhu; 176 982 nabídek. Za 23. 11. přibyly LAID, Aspire cyklo, Level Sport 100 %, Paul Lange a Stablecam.
- **Chybějící varianty** (původní zadání: model máme, ale ne všechny velikosti a barvy) jsou hotové a jdou do nasazení (feedhub #34): filtr v Sortimentu, počty v přehledu, CSV, import a Claude Desktop. Jdou u 13 zdrojů, jejichž feed varianty spojuje (ABUS, Aspire, Crussis, KCK, LAID, Level Sport, Origos, Penco, Sport und Freizeit, Zookee).

**Stav 23. 11. 2026 ve 22:34 (verze `v2026-11-23-96a5ee2`, feedhub #31), z logu nasazení:**

- **Level Sport Koncept — katalog značky 100 % běží.** Láďa poslal soubor z jejich B2B a jeho adresu (veřejná, bez klíče). Nový zdroj `level-sport-koncept-100percent`, 6:00 a 12:00; první stažení ve 22:34: 1 927 nabídek, EAN má 1 919, značka u všech, běh 2 s — server na jejich B2B dosáhne. Sortiment: **máme 464 (z toho jen karta v Pohodě 376, na e-shopu tedy 88), nemáme 1 461 (z toho bez EAN 8), ke kontrole 2**.
- **Soubor je katalog bez cen a skladu** (kód, EAN, název, barva, velikost, kategorie). Stačí na kontrolu zalistování; import do Pohody z něj vyjde bez nákupní ceny a doporučené MOC. Řádky modelů (381, bez EANu) se nečtou. Kód dodavatele je stejný jako náš kód (115 ze 117 položek spárovaných EANem na e-shopu). Názvy jsou anglické.
- **Chybí od Level Sportu:** soubor s cenami a skladem a stejné soubory pro další značky. Starý zdroj `level-sport-koncept` (feed mywac) zůstává vypnutý.
- **Paul Lange:** adresa, kterou Láďa poslal, je ve Feed Hubu od 19. 10. jako zdroj `paul-lange-2` (vypnutý, bez mapování). Odsud ji stáhnout nejde (Cloudflare pustí jen běžný prohlížeč), takže mapování nejde připravit bez souboru — **Láďa nahraje XML do chatu**, nebo zkusí u zdroje Upravit → rozbor ze serveru.
- Aspire sport má dál adresu cyklo feedu (čeká na opravu Láďou, viz níže).

**Stav 23. 11. 2026 ve 22:12 (verze `v2026-11-23-e916bde`, feedhub #29 a #30), z logu nasazení:**

- **Záložka Úkoly je nasazená** (přání Ládi: „záložku úkoly, kde si budu moci odškrtávat či psát poznámky“): `https://sales.report/feeds/#ukoly`. Je v ní 44 úkolů z tabulky níže ve stejném pořadí (podle nákupu od dodavatele); úkol jde odškrtnout a vrátit, napsat k němu poznámku, změnit „kdo“ a přidat vlastní. Ukládá se hned, s účtem Salesu a časem. U úkolu je živý stav jeho feedů z posledního běhu (běží / neběží / vypnutý). Odškrtnutí je na člověku, samo se nic neodškrtává. **Tahle tabulka v dokumentu se tím přestává udržovat — platí záložka.**
- **Aspire cyklo běží:** první stažení ve 21:51, 19 669 nabídek (s EAN 19 132, s cenou 19 625, značka u všech), běh 94 s. Máme 10 254 (z toho jen karta 3 079), nemáme 9 325 (z toho bez EAN 526), ke kontrole 90.
- **Aspire sport má vloženou adresu cyklo feedu** (deník 21:27: adresa `sport.aspire.cz` → `cyklo.aspire.cz`), takže načetl tytéž položky jako cyklo — 19 669 nabídek je v přehledu dvakrát. **Náprava (Láďa):** u zdroje `aspire-sport-aspire-saucony-merrel` Upravit → adresa se serverem `sport.aspire.cz` a stejným klíčem → Uložit → Spustit. Čeká se asi 8 500 nabídek (Merrell, Saucony) a u posledního běhu „po změně nastavení vyřazeno 19 669 a nově načteno 8 526 položek“.
- **Aby se omylem načtené položky po opravě samy vyřadily** (pojistka „víc než polovina chybí = neúplné stažení“ by je nechala navždy), přibylo pravidlo: když se z dashboardu změní adresa zdroje, prvek položky nebo čtení kódu a víc než polovinu dosud nabízených položek od té změny žádný běh neposlal, bere se běh jako nové načtení — staré položky se vyřadí bez události, nově načtené se nezapisují jako „nové“. Výměna klíče v adrese téhož feedu nic nemění.
- **Formulář už stejnou adresu ve dvou zdrojích neuloží** — řekne, který zdroj ji má.
- **Zůstává k rozhodnutí:** 19 669 omylem načtených řádků zůstane ve zdroji „sport“ vedeno jako „už neposílá“ (Feed Hub nabídky nemaže) — o tolik bude na dashboardu vyšší počet zmizelých nabídek. Smazat je jde jen migrací; rozhoduje Láďa.
- Souhrn serveru: 71 zdrojů (21 vypnutých), 31 funkčních, 1 s varováním, 39 nefunkčních nebo bez běhu; 163 250 nabídek (včetně zdvojeného Aspire), z toho 4 163 už dodavatel neposílá. E-shop měl 23. 11. 48 774 položek (22. 11. 51 311).

**Stav 23. 11. 2026 ve 22:00:** Aspire — Láďa adresu vložil a zdroje spustil (výsledek běhu odsud nevidím). Cena: doporučeno nechat `Cena` — platí `Cena = CenaPuvodni × (1 − SlevaProcento/100)` u všech položek, sleva je u 94 % variant cyklo feedu a je hlavně stálá po značkách (SRAM 6–8 %, Mavic 13 %, Fizik 15 %, Troy Lee 28 %, Merrell 30 %), tedy naše čistá nákupní cena; `CenaPuvodni` je ceník před slevou. Bike Fun — dvě XML na koloshop.cz (852 EANů, 848 z nich na našem e-shopu) a export od BFI (202 řádků, vše Shop = Koloshop.cz, bez cen) popisují náš sklad, ne nabídku BFI.

**Stav 23. 11. 2026 ve 21:20 (feedhub #28):** Aspire — Láďa dodal adresu s klíčem, odpovídají oba feedy. Mapování plného katalogu je nasazené (cyklo 19 669 variant, sport 8 526; kód = `Id`, tedy náš objednací název). Klíč není v repozitáři — adresu vloží Láďa ve formuláři Upravit a zdroje zapne. Dostupnostní feed se nezakládá (plný katalog kusy nese).

**Stav 23. 11. 2026 v 18:30 (verze `v2026-11-23-7af9527`, feedhub #27):** LAID zapnutý a stažený — 2 071 nabídek, všechny s EANem, nákupní cenou, MOC a značkou (Smith, Barts); máme 219 (z toho 51 jen kartu v Pohodě), nemáme 1 852. Import do Pohody nově počítá prodejní cenu v EUR jako MOC v Kč / 24,5 u všech zdrojů s MOC v korunách. Zdrojů běží 29 ze 48 zapnutých.

Zadání Ládi: úkoly podle priorit, prioritou je obrat dodavatele, od největšího. Řazeno podle **nákupu od dodavatele (příjemky) za 8/2025–7/2026** z dat Salesu v repozitáři (novější měsíce tam nejsou; obrat z prodejů po dodavatelích v repu není). Celkem 125,2 mil. Kč. **Fungující feedy pokrývají dodavatele s nákupem 27,8 mil. (22 %)**, úkoly níže 92,4 mil. (74 %); jen Aspire je 17,7 % nákupu. Sloupec „Kdo“ je návrh.

| # | Dodavatel | Nákup 12 měs. (mil. Kč) | Stav feedu | Úkol | Kdo |
| --- | --- | --- | --- | --- | --- |
| 1 | ASPIRE SPORTS, s.r.o. | 22,1 | **běží oba:** cyklo 19 700 nabídek (máme 10 261, nemáme 9 349), **sport od 24. 11. 22:04 se správnou adresou** — 8 408 nabídek (máme 193, nemáme 8 215) | V Sortimentu přiřadit značky sport feedu (Merrell, Saucony) k našim — pod zápisem Aspire je nevedeme | Láďa / Pavel |
| 2 | BIKE FUN International s.r.o. | 10,7 | **běží od 24. 11. 16:11, ceník nahrán 24. 11. 22:06** (1 497 nabídek, cenu má 1 314; máme 839, nemáme 653) | Při novém produktu ve feedu si Feed Hub o nový ceník řekne sám (úkol nahoře a oranžový semafor) | Láďa |
| 3 | LEVELSPORTKONCEPT s.r.o. | 5,8 | **katalog značky 100 % běží od 23. 11. 22:34** (1 927 nabídek, máme 464, nemáme 1 461; bez cen a skladu); starý feed hlásí chybu | Vyžádat u Level Sportu soubor s cenami a skladem a stejné soubory pro další značky | Láďa / Pavel |
| 4 | Paul Lange Ostrava s.r.o. | 5,7 | **běží od 23. 11. 22:47** (6 774 nabídek, máme 3 234, nemáme 3 521) | Potvrdit, že `PRICE` je nákupní bez DPH; zjistit, co nese druhý feed (`img.paul-lange.cz`) | Láďa |
| 5 | PROGRESS CYCLE, a.s. | 4,8 | žádný feed nemáme | Zjistit, jestli Progress Cycle nabízí feed (XML / B2B export), a založit ho | Pavel |
| 6 | Ober Alp S.p.A. | 4,1 | **Dynafit běží od 24. 11. 22:17** (8 956 nabídek, máme 2 135, nemáme 6 821); **Salewa čeká na svůj Order Sheet** (omylem nahraný sešit Dynafitu je vyřazený) | Nahrát Order Sheet Salewy u zdroje `oberalp-salewa`; při každé aktualizaci skladovky nahrát znovu | Láďa / Pavel |
| 7 | CYKLOMAX, spol.s.r.o. | 4,0 | běží, hlavní feed bez nákupní ceny | Ověřit, jestli nový feed s cenou (203 položek) má nahradit starý, nebo chtít cenu do hlavního | Pavel |
| 8 | N Distribution s.r.o. | 3,8 | **běží od 24. 11. 20:29** (9 122 nabídek, máme 814, nemáme 8 299) | Projít, co od N Distribution nemáme u značek, které vedeme (1 708) | Pavel |
| 9 | CYKLOSPECIALITY s.r.o. | 2,7 | **běží od 24. 11. 20:29** (5 752 nabídek, máme 1 887, nemáme 3 807) | Projít, co nemáme u značek, které vedeme (1 055) | Pavel |
| 10 | Early Rider Dealer Store | 2,3 | žádný feed nemáme | Zjistit, jestli Early Rider dává feed nebo ceník ke stažení | Pavel |
| 11 | Creative play s.r.o. | 1,9 | **běží od 24. 11. 20:29** (348 nabídek, máme 101, nemáme 247) | — | — |
| 12 | SPORT und FREIZEIT, spol. s r.o. | 1,8 | běží, bez nákupní ceny | Zjistit, jestli jde dostat feed s nákupní cenou (oba zdroje) | Pavel |
| 13 | CYKLO PROFI, s.r.o. | 1,6 | **běží od 24. 11. 20:29** (4 426 nabídek, máme 2 154, nemáme 2 215) | Projít, co nemáme u značek, které vedeme (1 724) | Pavel |
| 14 | Kalkhoff Werke GmbH | 1,5 | žádný feed nemáme | Zjistit, jestli Kalkhoff nabízí VeloConnect, a vyžádat přístup | Pavel |
| 15 | Garmin Czech s.r.o. | 1,4 | žádný feed nemáme | Zjistit, jestli Garmin dává feed pro prodejce | Pavel |
| 16 | BIKE BROTHERS IMPORT, spol. s r.o. | 1,4 | jen přihlášení do B2B | Požádat o přímou adresu feedu (bez přihlášení přes web) | Pavel |
| 17 | ENDURA LIMITED | 1,3 | **běží od 24. 11. 22:11** (8 581 variant, máme 3 783, nemáme 4 798, chybějící varianty 1 660; bez cen) | Zjistit, jestli jde dostat ceník (feed ceny nenese) | Pavel |
| 18 | RASCAL BIKES s.r.o. | 1,3 | **běží od 24. 11. 20:29** (287 nabídek, máme 126, nemáme 161; feed nenese značku) | — | — |
| 19 | SILVINI s.r.o. | 1,2 | **dostupnostní feed Viking běží od 25. 11. 22:16** (17 093 nabídek, máme 5 382, nemáme 11 710; bez názvů a cen); zalistovací feed Viking je nastavený a vypnutý; dva feedy značky Silvini zatím nerozebrané | Zapnout `silvini-viking-zalistovaci` (názvy a ceny) a nechat zapnutý jen jeden ze dvou; stejně rozebrat zbylé dva feedy | Láďa |
| 20 | CYKLO ŽITNÝ, s.r.o. | 1,2 | **běží od 24. 11. 20:29** (2 687 nabídek, máme 1 594, nemáme 1 090) | — | — |
| 21 | 4EVER, s.r.o. | 1,0 | **běží od 24. 11.** (799 nabídek, máme 446, nemáme 347); nákupní cena = `CUSTOMER_PRICE / 1,21`, ověřeno proti našim nákupním cenám | Zkontrolovat první import do Pohody | Láďa |
| 22 | SNOW-HOW ČR s.r.o. | 0,9 | **běží od 24. 11.** (614 variant po opravě čtení, máme 200, nemáme 413) | — | — |
| 23 | SLOGER, j.s.a. | 0,9 | **běží od 24. 11.** (11 627 nabídek po opravě čtení variant, máme 3 590, nemáme 8 021) | Projít, co nemáme u značek, které vedeme (3 923) | Pavel |
| 24 | Wahoo Fitness | 0,9 | žádný feed nemáme | Zjistit, jestli Wahoo dává feed pro prodejce | Pavel |
| 25 | OneUp Components | 0,9 | **běží od 24. 11. 22:18** ze souboru nahraného na dashboardu (281 nabídek, máme 122; bez EANu a cen) | V Sortimentu přiřadit značku „OneUp Components“ k naší „Oneup“; soubor při aktualizaci nahrát znovu | Láďa |
| 26 | VAVRYS CZ s.r.o. | 0,8 | jen přihlášení do B2B | Požádat o přímou adresu feedu | Pavel |
| 27 | Protocycles s.r.o. | 0,6 | **běží od 24. 11. 20:29** (61 nabídek, máme 41, nemáme 18) | — | — |
| 28 | Halbich s.r.o. | 0,5 | žádný feed nemáme | Zjistit, jestli Halbich dává feed | Pavel |
| 29 | Forever Faster s.r.o. | 0,5 | jen přihlášení do B2B | Požádat o přímou adresu feedu | Pavel |
| 30 | UNIS Pro Team s.r.o. | 0,5 | žádný feed nemáme | Zjistit, jestli Unis dává feed | Pavel |
| 31 | MAGURA Bosch Parts & Services GmbH & Co. KG | 0,5 | chybí přístup k VeloConnectu | Vyžádat u MBPS přihlášení k VeloConnectu a dát ho do .env na serveru | Pavel / Láďa |
| 32 | AMER SPORTS Czech Republic s.r.o. | 0,5 | žádný feed nemáme | Zjistit, jestli Amer Sports dává feed | Pavel |
| 33 | ABUS CZECH s.r.o. | 0,4 | běží jen dostupnost, bez ceny | Vyžádat přístup k VeloConnectu ABUS (ceny), až skončí údržba jejich portálu | Pavel |
| 34 | Activent 365 s.r.o. | 0,4 | **běží od 24. 11. 20:29** (1 569 nabídek, máme 263, nemáme 1 304; 192 položek feedu nemá EAN a neukládají se) | — | — |
| 35 | Engelbert Wiener Bike Parts GmbH | 0,3 | žádný feed nemáme | Zjistit, jestli Wiener Bike Parts nabízí VeloConnect | Pavel |
| 36 | Biketime s.r.o. | 0,3 | běží, bez nákupní ceny a značky | Zjistit, jestli jde dostat feed s nákupní cenou (ve feedu je jen MOC) | Pavel |
| 37 | LAID a.s. | 0,3 | **běží od 23. 11. 18:30** (2 071 nabídek, máme 219, nemáme 1 852) | Zkontrolovat první import (kód karty bez závorek, EUR = MOC / 24,5) | Láďa |
| 38 | LEVIT s.r.o. | 0,3 | žádný feed nemáme | Zjistit, jestli Levit dává feed | Pavel |
| 39 | SPRINT spol.s r.o. | 0,2 | adresa neexistuje (404) | Vyžádat u Sprintu novou adresu feedu a vložit ji | Pavel |
| 40 | CYKLO BARTONÍČEK, s.r.o. | 0,2 | žádný feed nemáme | Zjistit, jestli Cyklo Bartoníček dává feed | Pavel |
| 41 | Summit Trade s.r.o. | 0,2 | **běží od 24. 11. 22:12** — produktový feed 9 384 variant s názvy (máme 180, nemáme 9 204), outlet 3 925 | — | — |
| 42 | Krab cycles s.r.o. | 0,2 | žádný feed nemáme | Zjistit, jestli Krab cycles dává feed | Pavel |
| 43 | MTBiker s.r.o. | 0,2 | chybí adresa; zvenku blokováno | Vložit adresu s tokenem a zkusit ze serveru | Láďa |
| 44 | Stablecam | 0,2 | **běží od 23. 11. 22:52** (5 031 nabídek s cenou a skladem; bez názvů a značek) | Zeptat se Stablecamu na katalogový feed s názvy; vyměnit přístupový klíč v adrese | Láďa |

Feed běží a úkol nemá (podle nákupu): Crussis 6,7 · Zookee 5,1 · KCK 3,8 · Raymon 2,6 · Sport Import 2,2 · Lindlau 1,4 · Viva 1,2 · Helios 1,0 · Focus 1,0 · Bottico 0,7 · Pedalsport 0,7 · Origos 0,6 · Catherine 0,4 · Sidas 0,2 · Bike Park 0,2 · Ride Hard, Penco, Vertone 0,1.

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
