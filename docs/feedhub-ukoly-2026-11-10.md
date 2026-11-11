# Feed Hub: co dělat dál

Seznam úkolů, 10. 11. 2026. Cíl zadal Láďa:

1. sami si umíme zavést feed a dostat ho do správného parsování,
2. víme o každé změně, která mezi dvěma staženími nastane,
3. víme, který dodavatel změnu udělal,
4. víme, když změnu uděláme my, například v hesle nebo v nastavení feedu.

Pracnost je odhad v člověkodnech práce Clauda, ne slib. Stav „dnes“ je ověřený v kódu na `main` (verze `v2026-11-10-5f28be2`).

**Stav k večeru 10. 11. 2026:** hotové a nasazené jsou A1, B1, B2, D4, E1 a E7 (verze `v2026-11-10-a83beaf`). Podrobnosti u jednotlivých řádků.

**Stav 11. 11. 2026 ráno (verze `v2026-11-11-5bdc817`), čtený z logu nasazení:** Lindlau stahuje celý katalog (8 898 položek, EAN má 8 737, běh 53 s), Raymon (2 354) i Focus (3 184) běží, takže A2 je hotové. Aktivních zdrojů je 45, z toho 25 funkčních, 2 s varováním a 18 nefunkčních: 15 českých feedů bez adresy s tokenem, MBPS bez přístupu a oba zdroje Oberalpu bez připojené složky. Nabídek je 118 271, z toho 2 840 dodavatelé už neposílají.

**Nové od 11. 11. 2026:** po každém nasazení se do logu na GitHubu vypíše stav zdrojů (bez cen, položek, adres a přístupů; souhlas Ládi), na serveru jde `bash deploy.sh --stav` a `bash deploy.sh --spust <zdroj>`.

**Rozhodnutí Ládi 10. 11. 2026:** celý katalog vždy, kde to jde, u všech dodavatelů. Je to výchozí chování všech zdrojů přes VeloConnect; zadané kódy jsou jen záloha.

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
| A7 | Kupkolo skoro nic nenachází: z 6 904 ověřených EANů vede 4 (0,06 %), poslední běh 4 z 300. Buď hledání podle EAN na Kupkole nefunguje, nebo se změnila stránka, nebo jsou ve frontě hlavně EANy mimo jeho sortiment. | Zjistit příčinu a opravit, jinak je srovnání s Kupkolem prázdné. Bike-Discount funguje (5 447 z 5 449). | Claude | 0,5 |
| A8 | Výchozí větev repozitáře `feedhub` je stará `claude/claude-md-phase-1-fi5irl`, ne `main`. Kvůli tomu GitHub nezaregistroval ruční workflow „Spustit zdroj na serveru“. | Výchozí větev `main` (GitHub → Settings → General → Default branch). | Láďa | minuta |
| A9 | Fronta ověřování u konkurence: u dodavatelů je 87 821 různých EANů, Kupkolo zvládne 300 za noc, celý průchod by trval asi 290 dní. | Ověřovat přednostně položky, které opravdu vedeme. Jde až po spárování na karty Pohody (Fáze 2), nebo jiným pravidlem, které určí Láďa. | Claude, Láďa | po Fázi 2 |
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
| C2 | Rozlišení příčin selhání: odmítnuté přihlášení, nedostupná adresa, přesměrování, změna struktury, prázdný feed. Ke každé česká věta, co s tím. | Z chyby je hned jasné, jestli je to na dodavateli, nebo na nás. | 0,5 |
| C3 | Deník událostí, jedna časová osa za všechny zdroje: výpadek a obnova, změna struktury, změna ceníku s počtem cen, změna sortimentu, odmítnuté přihlášení. | Odpověď na otázku „co se tento týden u dodavatelů stalo“. | 1 |
| C4 | Pošta: denní souhrn v 7:00 a okamžité upozornění při selhání. Je v zadání od začátku. | O změně se dozvíš, aniž bys otevřel dashboard. | 1, čeká na SMTP |

## D. Víme, když změnu uděláme my (cíl 4)

| # | Úkol | Výsledek | Pracnost |
| --- | --- | --- | --- |
| D1 | Deník změn nastavení zdroje: adresa, mapování, plán, zapnutí, kódy, zařazení do feedu. Hodnota před a po, adresy s tokenem maskovaně. | U každého zdroje je vidět, kdy a co se změnilo. | 1 |
| D2 | Jmenná přihlášení místo jednoho společného. | V deníku je i kdo. Kolik lidí bude mít přístup, určí Láďa. | 1 |
| D3 | Změny přístupů v `.env`. Hodnoty nikdy neukládat, jen otisk. Při startu porovnat s minulým. | Událost „přístup k Lindlau změněn 10. 11.“ a vedle ní, jestli od té doby běhy procházejí. | 0,5 |
| D4 | Tlačítko „Ověřit přihlášení“ u zdroje. | **Hotovo 10. 11.** Tlačítko „Ověřit“ u zdroje přes VeloConnect: přístupy, přihlášení, co dodavatel umí, jestli jde stáhnout celý katalog (a kolik má položek) nebo proč ne, a tři položky na ukázku. Nic neukládá. | hotovo |
| D5 | Deník nasazení: která verze kdy naběhla. Po nasazení porovnat stav zdrojů před a po. | Událost „od verze X padá Lindlau“. Přesně tohle 31. 10. chybělo. | 0,5 |

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

- **Láďa:** prahy pro podezřelé změny, po kolika dnech výpadku dodavatele vyřadit z feedu, kdo má mít přístup do dashboardu.
- **František:** SMTP pro poštu, zpřístupnění feedu zvenku, interní adresa, místo pro zálohy.
- **BHIT:** potvrzení struktury XML a zdrojová IP.
- **Pavel:** přístupy k VeloConnectu pro MBPS a ABUS, kontrolní položky s ověřenou nákupní cenou.
