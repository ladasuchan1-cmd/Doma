# Jak dostat data z Feed Hubu přímo do Pohody

Úvaha, 10. 11. 2026. Navazuje na audit VeloConnectu ze 17. 10. (cesty A až D) a nic z něj neopakuje.
Značení: **[ověřeno]** = otevřel jsem dnes oficiální stránku nebo schéma Stormware, odkaz je na konci.
**[neověřeno]** = interní poznámka, paměť nebo odhad.

## 1. Doporučení

Přímý zápis má smysl jen oficiální cestou, tedy Pohoda XML přes mServer. Stavět ho ale lze až po
dvou věcech: po párování nabídek na karty a po zjištění, co je v databázi pole „Dodání“. Do té doby je
nejkratší cesta dát náš soubor IT Future do jejich plusImportUni, protože ten do Pohody už zapisuje
a odpovědnost za zápis zůstane u nich.

## 2. Co by se zapisovalo

| Údaj z Feed Hubu | Kam v Pohodě | Jistota |
| --- | --- | --- |
| Dostupnost (kód) | „Dodání“ na kartě. Dnes je to počet dní 3, 4, 5, 10; prázdné znamená „nevíme“. | Pole ve schématu zásob **není** [ověřeno v stock.xsd]. Nevíme, co to je. |
| Termín dodání | Samostatné pole typu Datum, nebo přepočet na dny do termínu v „Dodání“. | K rozhodnutí. |
| Množství na cestě | Nikam, nanejvýš volitelný parametr. Stav zásoby přes XML zapsat nejde, `stk:count` je jen pro export [ověřeno]. | Jisté. |
| Nákupní cena | `stk:purchasingPrice` na kartě, nebo pole „Cena“ na záložce Dodavatelé (jde od verze 11900) [ověřeno]. | V pilotu nepsat. |
| Doporučená MOC | Nezapisovat do prodejní ceny. Změna prodejní ceny přes XML nastaví na kartě fixaci ceny (verze 13100) [ověřeno]. | V pilotu nepsat. |

Kandidáti na „Dodání“: volitelný parametr karty (jde přes `stk:parameters`, název db pole do 16 znaků,
typy Text, Číslo, Datum) [ověřeno], záložka Dodavatelé (od verze 13400 jde aktualizovat samostatným
XML požadavkem) [ověřeno v historii změn, schéma jsem neotevřel], nebo internetové pole Dostupnost
(`stk:availability`, text do 64 znaků) [ověřeno].

## 3. Nutná podmínka: párování na kartu

- Bez Fáze 2 (`sku_map`) zápis nejde. Pořadí: EAN, pak objednací kód u téhož dodavatele, zbytek ručně. Nikdy podle názvu.
- Zdroj karet existuje: `katalog_karet_RRRR-MM-DD.xlsx` chodí denně do `/mnt/vmservers/reports` a nese Kód, Čárový kód, Objednací název, Dodavatele a Dodání. Feed Hub ho zatím nečte.
- Zapisovat vždy podle Kódu karty, EAN použít jen ke spárování u nás. Filtr podle EAN Pohoda odmítne, když najde víc karet [neověřeno, interní poznámka z 25. 9.].
- **Raymon:** EAN mají všechny položky (2 354). Spáruje se vše, co máme založené. Kolik karet to je, nevím.
- **Focus:** EAN má 1 729 z 3 184. Díly mají 18místné kódy s nulami a EAN skoro žádný. Půjdou jen přes objednací kód, pokud ho karty nesou ve stejném tvaru. Jinak ruční fronta.
- Pozor na UPC-12 proti EAN-13. Sales už na to narazil u Park Toolu.

## 4. Cesty do Pohody

| Cesta | Jak funguje | Co potřebuje | Rizika | Pracnost u nás | Odpovědnost |
| --- | --- | --- | --- | --- | --- |
| a) mServer | HTTP server uvnitř Pohody. `POST /xml`, hlavička `STW-Authorization` se jménem a heslem uživatele Pohody, odpověď hned. Požadavky zpracuje po jednom [ověřeno]. | František: konfigurace mServeru na účetní jednotce, port, uživatel s právy „Datová komunikace“ a „POHODA mServer“, síťová cesta ze serveru Feed Hubu. mServer si vyhradí jednu instanci Pohody. Jen vnitřní síť a serverový systém [ověřeno]. | Náš kód píše do ostrého účetnictví. „Dodání“ možná XML neumí. | 5 až 8 dní plus párování. | My. |
| b) XML dávka do složky | Feed Hub uloží dávku do sdílené složky. Na stroji s Pohodou ji plánovač spustí příkazem `Pohoda.exe /XML` s INI souborem. Odpovědi padají do složky [ověřeno]. | František: naplánovaná úloha, složka se zápisem, uživatel. Heslo je v příkazu úlohy. | Stejná jako a). Zpětná vazba až po běhu úlohy. | O něco méně než a). | My a František. |
| c) plusImportUni | Nástroj firmy ITFutuRe pro import a aktualizaci zásob ze souborů, e-mailů a feedů XML, CSV, XLS. Bere ze složky, URL, FTP i e-mailu, páruje nejlépe přes EAN, umí volitelné parametry i záložku Dodavatelé, běží z plánovače [ověřeno]. | IT Future: šablona nad naším souborem. Licence 14 000 Kč, šablona 1 000 Kč/h [ověřeno]. Vstup už máme: CSV ve složce ImportZasob a od 10. 11. souhrnný XML feed na adrese s tokenem (stejný, jaký si stahuje BHIT). | Závislost na IT Future. Šablona musí respektovat význam dat z bodu 6. | Malá. | IT Future. |
| d) Přímo do SQL | Zápis do tabulek Pohody mimo program. | Přístup k databázi. | Stormware doporučuje omezit zásahy do databáze z jiných aplikací a pro napojení použít XML [ověřeno, dokument z roku 2013]. Obchází kontroly programu, při aktualizaci Pohody se struktura může změnit. | Malá, ale křehká. | My, bez opory u výrobce. |

Cestu d) nedoporučuji. Čtení z databáze je jiná věc a už běží (denní exporty).

## 5. Rizika a pojistky pro vlastní zápis

1. **Testovací účetní jednotka.** První importy jen do kopie, ne do ostrých dat.
2. **Jen pole bez účetního dopadu.** V pilotu dostupnost a termín. Ceny ne.
3. **Jen změny.** Zapisovat to, co se změnilo podle `offer_history`, ne celý katalog.
4. **Strop na běh.** Nad dohodnutý počet změn se běh zastaví a ohlásí. Chrání před chybou feedu.
5. **Výpadek feedu nic nepřepíše.** „Nevíme“ není „nedostupné“. Prázdnem se nepřepisuje.
6. **Log odpovědí.** Pohoda vrací ke každé položce stav, číslo chyby a poznámku [ověřeno]. Vše uložit ve Feed Hubu a ukázat na dashboardu.
7. **Vypínač a běh nasucho.** Globálně i po dodavatelích. Nasucho jen vyrobí XML a ukáže rozdíl.
8. **Jedno pole, jeden zapisovatel.** „Dodání“ dnes plní feed e-shopu a import IT Future. U dodavatele, kterého převezme Feed Hub, musí ostatní zápis přestat.
9. **Heslo uživatele Pohody jen v `.env`.** Uživatel s nejmenšími právy.

## 6. Pozor na význam dat

- Raymon a Focus posílají u „available“ jen kód, **žádné kusy**. Počet dní do „Dodání“ tedy z feedu nevyčteme. Musí to být lhůta nastavená na dodavatele, což je obchodní rozhodnutí.
- Množství chodí jen u zboží na cestě a je to množství k termínu, ne sklad. Raymon tam dává nulu.
- Termín přepočtený na dny se mění každý den. To se bije s pravidlem „jen změny“. Lepší je pole typu Datum, pokud ho Pohoda má nebo ho lze založit.
- „Nedostupné“ dnes v Pohodě nejde odlišit od „nevíme“. OBR proto od 3. 10. prázdné „Dodání“ nevyřazuje. Feed Hub nedostupnost opravdu nese, takže je potřeba dohodnout, jak ji zapsat odlišitelně.
- OBR 3.0 umí nabídky Feed Hubu načíst jako soubor (export `supplier_offers`, od 12. 10. 2026) a zná stav „skladem (Feed Hub)“. Pravidelný automatický přenos zatím není. Pro OBR tedy zápis do Pohody nutný není. Slouží e-shopu a lidem, kteří pracují v Pohodě.

## 7. Postup

1. **První nejmenší krok, bez zásahu do Pohody:** František a IT Future odpoví, co je „Dodání“ a kdo ho čím plní. Souběžně Feed Hub načte `katalog_karet` jen pro čtení a spočítá, kolik položek Raymonu a Focusu se spáruje přes EAN a co mají dnes v „Dodání“. Výstup je tabulka.
2. Pilot Raymon cestou c): šablona IT Future nad naším souborem, týden souběhu, porovnání „Dodání“ před a po.
3. Rozhodnutí o cestě a): testovací jednotka, mServer, ruční import pěti karet, kontrola odpovědi.
4. Fáze 2 (`sku_map`) a zapisovač ve Feed Hubu se všemi pojistkami, napřed nasucho.
5. Ostrý zápis až po výslovném schválení, jak říká zadání Feed Hubu.

## 8. Otevřené otázky

**František**
1. Jaká řada a verze Pohody běží (MDB, SQL, E1) a na kterém stroji?
2. Je ten stroj dosažitelný ze serveru 172.18.9.31?
3. Používá se už mServer (například pro e-shop) a kolik licencí je volných?
4. Existuje testovací účetní jednotka nebo kopie dat?
5. Jak se v databázi jmenuje pole „Dodání“, jakého je typu a je to volitelný parametr?
6. Kdo vyrábí denní exporty do `reports` a šel by připojit `katalog_karet` Feed Hubu jen pro čtení?

**IT Future**
1. Běží u nás plusImport, nebo plusImportUni, a v jaké verzi?
2. Do kterého pole zapisujete dostupnost a jakou cestou (XML, mServer, SQL)?
3. Co zapíšete, když dodavatel zboží nemá: nulu, nebo prázdno?
4. Zvládne šablona náš soubor ze složky nebo z adresy, včetně stavu „na cestě“ a termínu?
5. Kolik bude šablona stát a jak často import poběží?

**Pavel**
1. Má Feed Hub časem zapisovat sám, nebo má zápis zůstat u IT Future?
2. Co má „Dodání“ znamenat u zboží skladem u dodavatele a co u zboží na cestě?
3. Smí se z feedu přepisovat nákupní cena na kartě?
4. Kdo dnes plní „Dodání“ pro e-shop a u kterých dodavatelů ho má převzít Feed Hub?

## 9. Co se nepodařilo ověřit

- Ve kterých řadách Pohody je mServer dostupný a jak se licencuje v SQL a E1. Našel jsem jen pravidlo pro síťové varianty.
- Že se při aktualizaci mění jen odeslaná pole a jak se chová filtr podle EAN při více kartách. Mám to jen z interní poznámky.
- Schéma pro záložku Dodavatelé a jestli je záložka jen v E1.
- Výkon mServeru při tisících aktualizací. Stormware žádné číslo neuvádí.
- Výslovné stanovisko Stormware k záruce při přímém zápisu do SQL. Našel jsem jen obecné doporučení.

## Zdroje (otevřené 10. 11. 2026)

- Schéma zásob, typů a filtrů: https://www.stormware.cz/schema/version_2/stock.xsd, https://www.stormware.cz/schema/version_2/type.xsd, https://www.stormware.cz/schema/version_2/filter.xsd, https://www.stormware.cz/schema/version_2/documentresponse.xsd
- mServer: https://www.stormware.cz/pohoda/xml/mserver/
- mServer pro vývojáře: https://www.stormware.cz/pohoda/xml/mserver/provyvojare/
- mServer v online příručce: https://www.stormware.cz/prirucka-pohoda-online/datova_komunikace/POHODA_mServer/
- Jak XML komunikace funguje (příkazová řádka, INI): https://www.stormware.cz/pohoda/xml/xmlzpracovani/default.aspx
- Podporované doklady pro import: https://www.stormware.cz/pohoda/xml/dokladyimport/default.aspx
- Podrobnosti zpracování (kódy chyb): https://www.stormware.cz/pohoda/xml/podrobnosti/default.aspx
- Historie změn XML: https://www.stormware.cz/pohoda/xml/historiezmen/default.aspx
- Parametrické spuštění (FAQ 3245): https://www.stormware.cz/podpora/faq/tisk.aspx?id=3245
- Licence a počet oken (FAQ 3255): https://www.stormware.cz/podpora/faq/tisk.aspx?id=3255
- Doporučení systémových opatření, verze 2.2 z 20. 8. 2013: https://www.stormware.cz/dnload/Bezchybny%20provoz%20file-server%20systemu.pdf
- plusImportUni: https://www.plussystem.cz/produkt/plusimportuni
- Interní: `Doma/docs/audit-veloconnect-2026-10-17.md`, `Doma/repricing/docs/POHODA.md`, `r01sales/docs/OBR3.md` kapitoly 17.4.68 a 17.4.69, `r01sales/core/pohoda.py`, `r01sales/core/pohoda_slozka.py`, `feedhub/CLAUDE.md` sekce 5 a 7.
