# Cyklo & Ski mapa – manuál pro obchodní tým

Jak se přihlásit, najít místa k oslovení, vést stav oslovení a dostat výběr do Excelu. Odkud jsou data a jak se
počítají, popisuje [METODIKA.md](METODIKA.md); provoz serveru [../NASAZENI.md](../NASAZENI.md); přehled na jednu
stránku [SHRNUTI.md](SHRNUTI.md).

## 1. Přihlášení a odhlášení

- Adresa aplikace: **https://cyklomapa.ksprehledy.cz**.
- **Přihlašuje Cloudflare e-mailem Koloshopu** (od 7. 10. 2026). Po otevření adresy se ukáže přihlašovací stránka
  Cloudflare: přihlaste se svým e-mailem **@koloshop.cz** podle toho, co stránka nabídne (obvykle kód poslaný
  na e-mail). Jiný e-mail neprojde a jméno s heslem aplikace už nefungují.
- Přihlášení platí podle nastavení v Cloudflare (obvykle týden), pak se Cloudflare zeptá znovu.
  Odhlášení: tlačítko vedle vašeho e-mailu vpravo nahoře.
- U změn stavu oslovení se ukládá **e-mail**, kdo je udělal (sloupec „Upravil“).
- Nový kolega s firemním e-mailem se dostane dovnitř sám, nikdo mu účet zakládat nemusí.
- Bez přihlášení není vidět nic – odkaz na místo proto funguje jen kolegovi s e-mailem Koloshopu.
- Do 7. 10. 2026 se přihlašovalo jménem a heslem aplikace – ta už neplatí.

## 2. Co je na obrazovce

| Část | Co tam je |
|---|---|
| Lišta nahoře | výběr **kraje** a **okresu**, pole **hledání**, tlačítka **Tabulka**, **Export CSV**, **Stav oslovení**, přepínač světlého/tmavého vzhledu (◐), vaše jméno a odhlášení |
| Mapa | hranice krajů a okresů s názvy, cyklotrasy, cyklostezky, MTB trasy, skiareály, místa (při oddálení ve shlucích s počtem) |
| Levý panel | **filtry** vrstev, typů míst, okolí, půjčovny a stavu oslovení – u každého počet v aktuálním výběru |
| Pravý panel | **detail** vybraného místa, trasy nebo skiareálu |

Na užší obrazovce (tablet, telefon) se panely přeskládají pod sebe; aplikace jde používat i v telefonu,
nejpohodlnější je notebook.

## 3. Pohyb v mapě: ČR → kraj → okres

1. **Úroveň ČR**: kliknutím na kraj (nebo výběrem v liště) se mapa přiblíží na kraj. Na úrovni ČR se značky míst
   nekreslí (překrývaly by kraje) a z tras jsou vidět jen dálkové (EuroVelo, národní) a cyklostezky.
2. **Úroveň kraje**: okresy s názvy, všechny trasy, místa ve shlucích. Klik na okres přiblíží okres.
3. **Úroveň okresu**: všechno – trasy, sjezdovky, místa jednotlivě (podle zapnutých filtrů).
4. **Zpět**: drobečková navigace nad mapou (ČR › kraj › okres) nebo výběr v liště.

Vybraná oblast (ČR / kraj / okres) určuje, co je v **tabulce** a v **exportu**.

## 4. Filtry (levý panel)

- **Trasy**: Cyklotrasy (značené) · Cyklostezky (pojmenované) · MTB trasy; **Skiareály**.
- **Místa**: skupiny **Ubytování** · **Půjčovny, cyklo a sport obchody** · **Infocentra** a pod nimi jednotlivé
  typy (Hotel, Penzion, Chata, Kemp, Apartmán, Hostel, Motel, Horská chata; Půjčovna kol, Půjčovna lyží,
  Cykloprodejna / servis, Lyžařský obchod / servis, Sportovní obchod, Outdoorový obchod, Lyžařská škola,
  Půjčovna; Infocentrum) s počty.
- **Zobrazit i místa bez názvu** – chaty a stánky, které mají v mapě jen evidenční číslo (běžně skryté).
- **Okolí**: **Vše** / **u cyklotras** (posuvník 0,25–3 km od nejbližší cyklotrasy, cyklostezky nebo MTB trasy) /
  **u skiareálů** (posuvník 1–15 km od nejbližšího skiareálu).
- **Půjčovna**: vše / **Provozuje půjčovnu (ano / podle webu)** / **ne** / **neznámo**. „Podle webu“ znamená, že
  web místa půjčovnu zmiňuje – před nabídkou ověřit.
- **Stav oslovení**: vše / **bez stavu** / **S jakýmkoli stavem** / jednotlivé stavy / **Chceme kontaktovat –
  zatím neosloveno** (zaškrtnuto „Chceme kontaktovat“ a nic dalšího).

Filtry platí najednou pro mapu, pro seznamy míst v detailu trasy či areálu, pro tabulku i pro export.

## 5. Hledání

Pole nahoře (klávesa `/` do něj skočí) hledá v názvu místa, obci, adrese, provozovateli, názvu nebo čísle trasy
a názvu skiareálu. Klik na výsledek otevře detail a přiblíží mapu.

## 6. Detail místa

Otevře se kliknutím na značku v mapě, na řádek v seznamu nebo na název v tabulce. Obsahuje:

- **Název, typ, štítky** (značky z OpenStreetMap), **adresu**, obec a okres.
- **Kontakty z OpenStreetMap**: telefon, e-mail, web, provozovatel – tak, jak je zapsali mapéři.
- **Údaje z webu** (když má místo web a podařilo se ho načíst): e-maily, telefony, IČO a k němu název firmy
  z ARES, jméno provozovatele z textu, **zmínky o půjčovně** kol/lyží s ukázkou textu. Jsou označené
  „Podle textu webu – ověřit“ – je to automatický odhad.
- **Půjčovna**: ano / podle webu / ne / neznámo (jak se určuje: METODIKA.md, kap. 3).
- **Nejbližší cyklotrasy do 3 km** a **skiareály do 15 km** se vzdáleností; klik otevře detail trasy či areálu.
- **Odkazy**: Google, „Google: půjčovna kol“, Firmy.cz, Mapy.cz, ARES a OpenStreetMap – pro rychlé ověření
  a doplnění kontaktů, které v datech chybí.
- **Převzít do kontaktů**: jedním klikem doplní **jen prázdná** ruční pole údaji z webu (provozovatel z ARES,
  telefon, e-mail, půjčovna „ano“). Co už je vyplněné, nepřepíše.
- **Kontakt a stav oslovení** – formulář, viz další kapitola.

## 7. Stav oslovení

Čtyři zaškrtávátka, u každého se po zaškrtnutí uloží datum:

| Zaškrtávátko | Kdy ho zaškrtnout |
|---|---|
| **Chceme kontaktovat** | místo je zajímavé a chceme ho oslovit (do poznámky proč / kdo si ho bere) |
| **Proběhl nabídkový e-mail** | nabídka odešla e-mailem |
| **Volali jsme** | proběhl telefonát (do poznámky s kým, výsledek) |
| **Osobní návštěva proběhla** | obchodník byl na místě |

Zaškrtávátka jsou nezávislá – běžný postup je zleva doprava, ale jde zaškrtnout i jen některé. Dál je ve formuláři:

- **Poznámka** – „kdo, kdy, co domluveno“; je vidět v tabulce i v exportu.
- **Provozuje půjčovnu** – ruční přepsání: *neznámo / podle dat*, *ano*, *ne*. Má přednost před údaji z OSM i webu.
- **Provozovatel, Telefon, E-mail, Web** – šedě předvyplněné hodnoty jsou z dat (OSM / web); co sem napíšete, má
  přednost všude (detail, tabulka, export).
- **Uloženo … · jméno** – vše se ukládá **okamžitě** při každé změně, žádné tlačítko Uložit není. Zobrazí se čas
  a jméno přihlášeného.
- **Smazat záznam** – po potvrzení vymaže stav, poznámku i ruční kontakty u tohoto místa.

**Sdílení v týmu.** Každá změna se hned pošle na server. Kolegové ji uvidí po obnovení stránky (F5). Když dva
lidé upraví totéž místo, platí **novější úprava** záznamu – proto u sdílených míst pište do poznámky, kdo
a kdy.

**Skiareály.** V detailu skiareálu je stejný formulář pro oslovení **provozovatele areálu**.

## 8. Detail trasy a skiareálu

- **Trasa**: druh (cyklotrasa / cyklostezka / MTB), síť (místní, regionální, dálková, mezinárodní – EuroVelo),
  číslo, délka, popis, správce, web, okresy, odkaz na OpenStreetMap a **seznam míst do 3 km od trasy** podle
  aktuálních filtrů (zobrazí se nejvýš 200 – zúžíte filtry nebo oblast).
- **Skiareál**: stav provozu, počet a délka sjezdovek podle obtížnosti, vleky, nadmořská výška, web, **místa
  v okruhu** podle posuvníku „u skiareálů“ a formulář oslovení provozovatele.

## 9. Tabulka

Tlačítko **Tabulka** nahoře přepne mapu na tabulku všech míst aktuálního výběru (oblast + filtry).

- **Sloupce**: Název · Typ · Obec · Adresa · Okres · Kraj · Půjčovna · Provozovatel · Telefon · E-mail · Web ·
  Nejbližší cyklotrasa · km od trasy · Nejbližší skiareál · km od skiareálu · čtyři stavy oslovení · Poznámka ·
  Upravil · Upraveno · OSM · Zem. šířka · Zem. délka.
- **Řazení** kliknutím na záhlaví (druhý klik obrátí směr). Zobrazí se 500 řádků, tlačítkem **Zobrazit dalších
  500** přibývají.
- **Zaškrtávátka stavů** přímo v řádcích se rovnou ukládají – hodí se na hromadné odškrtání po rozeslání nabídek.
- Klik na **název** otevře detail místa v mapě.
- **Export CSV (N)** exportuje **všechny** řádky výběru, ne jen zobrazených 500.
- **Import z Excelu…** načte upravený export zpět – hromadné změny stavů a poznámek (kap. 13).

## 10. Export CSV

- Z mapy tlačítkem **Export CSV** (aktuální výběr: oblast + filtry) nebo z tabulky (včetně řazení).
- Soubor `mista-<oblast>-<datum>.csv`, oddělovač `;`, kódování UTF‑8 s BOM – **Excel ho otevře dvojklikem**
  s českou diakritikou; kilometry mají desetinnou čárku.
- Sloupce jsou stejné jako v tabulce; stavy jsou vyplněné jako „ano (datum)“.
- **Export všech záznamů (CSV)** v dialogu **Stav oslovení** vyexportuje všechna místa (i skiareály) se záznamem
  bez ohledu na oblast a filtry – přehled všeho, co tým dosud řešil.

## 11. Odkaz kolegovi

Adresa v prohlížeči nese kraj, okres a vybrané místo (např. `…/#kraj=35&okres=3302&misto=n123`). Stačí ji
zkopírovat a poslat – kolega po přihlášení uvidí totéž.

## 12. Záloha a přenos stavu

Dialog **Stav oslovení** ukazuje, kolik míst má záznam, a nabízí:

- **Uložit zálohu (JSON)** – stáhne všechny záznamy do souboru.
- **Načíst soubor…** – sloučí záznamy ze souboru s aktuálními; u každého místa vyhraje novější úprava. Načtené
  záznamy se pošlou i na server.
- **Export všech záznamů (CSV)** – viz výše.
- **Načíst upravenou tabulku (Excel/CSV)…** – hromadné úpravy, kap. 13.

Na webu je stav uložený na serveru a zálohuje se tam **každý den ve 2:30**. Ruční zálohu JSON je dobré udělat
před hromadnými změnami. Když aplikaci otevřete přímo ze souboru `index.html` (bez serveru), stav se ukládá jen
do daného prohlížeče a smazání dat prohlížeče ho vymaže.

## 13. Hromadné úpravy přes Excel (od 14. 10. 2026)

Když potřebujete změnit stav u desítek míst najednou (třeba po obvolání okresu), nemusíte klikat v tabulce:

1. Vyberte oblast a dejte **Export CSV**. Soubor otevřete v Excelu; můžete ho uložit jako `.xlsx` a exporty víc
   krajů dát do jednoho sešitu – **každý list jeden kraj**.
2. Upravte buňky podle pravidel níže a soubor uložte.
3. **Tabulka → Import z Excelu…** (nebo **Stav oslovení → Načíst upravenou tabulku**) a vyberte soubor
   (`.xlsx` nebo `.csv`).
4. Mapa ukáže **náhled**: kolik řádků se spárovalo, co se změní a které řádky nebo hodnoty nepoznala. Zapíše se
   to až tlačítkem **Uložit** – u každého místa s vaším jménem a časem.

**Pravidla:**

- Řádky se párují podle sloupce **OSM** (odkaz na místo) – ten v souboru nechte. Řádky bez něj nebo s místem,
  které v mapě není, náhled vypíše a nepoužije. Listy bez sloupce OSM se přeskočí.
- **Zaškrtávací sloupce** (Chceme kontaktovat, Proběhl nabídkový e-mail, Volali jsme, Osobní návštěva proběhla):
  „ano“, „ano (14. 10. 2026)“, x nebo 1 zaškrtne (s datem z buňky, jinak dnešním), „ne“ nebo 0 odškrtne.
  **Prázdná buňka nic nemění** – nic se tedy nesmaže jen proto, že jste řádek nevyplnili.
- **Poznámka** vyplněná a jiná než v mapě se přepíše. Prázdná nic nemění.
- **Půjčovna** (ano/ne) a **kontakty** (provozovatel, telefon, e-mail, web): když se liší od mapy, uloží se jako
  ruční údaj – ale **jen když v náhledu zaškrtnete „Zapsat i údaje o místech“**. Mapa se každé pondělí obnovuje,
  takže starší export může obsahovat údaj, který se mezitím v OSM nebo na webu změnil.
- Ostatní sloupce (název, vzdálenosti, Upravil, Upraveno…) se jen čtou. Nerozpoznané hodnoty (třeba „možná“)
  náhled vypíše a nepoužije.
- Starý formát `.xls` se nenačte – uložte soubor jako `.xlsx` nebo CSV.

**Pozor na hromadné e-maily:** nabídku e-mailem posílejte jen těm, kdo o ni požádali nebo s ní souhlasili.
Obchodní sdělení e-mailem bez souhlasu porušuje zákon č. 480/2004 Sb., a to i vůči firmám.

## 14. Doporučený postup (příklad kampaně)

1. Vyberte okres.
2. Filtry: **Ubytování**, okolí **u cyklotras do 1 km**, půjčovna **ne** nebo **neznámo**.
3. Přepněte na **Tabulku**, projděte řádky a u vhodných zaškrtněte **Chceme kontaktovat** (do poznámky proč).
4. Filtr stavu **Chceme kontaktovat – zatím neosloveno** → **Export CSV** → podklad pro hovory. Nabídku e-mailem
   jen tomu, kdo si o ni řekne (kap. 13).
5. Po hovoru zaškrtněte **Volali jsme** + poznámka, po odeslání vyžádané nabídky **Proběhl nabídkový e-mail**,
   po návštěvě **Osobní návštěva proběhla** – v tabulce, nebo hromadně přes Excel (kap. 13).
6. Kontrola rozpracovaného: filtr **S jakýmkoli stavem**, řazení podle **Upraveno**.

## 15. Časté otázky

**Místo v mapě chybí.** Není v OpenStreetMap. Ručně ho do aplikace přidat nejde; nejrychlejší je doplnit ho
v OSM (odkaz „OpenStreetMap“ u sousedního místa, účet zdarma) – do mapy se dostane s pondělní obnovou dat,
jakmile QLever převezme novější snímek OSM (bývá to pár týdnů).

**Místo nemá telefon ani e-mail.** OSM ho nemá a web se nenačetl (nebo místo web nemá). Použijte odkazy Google,
Firmy.cz, ARES v detailu a zjištěný kontakt zapište do ručních polí – zůstane napořád.

**Údaj je špatně.** Přepište ho ručně (má přednost). Chcete‑li opravu i pro ostatní uživatele map, opravte ji
v OpenStreetMap.

**Co znamená „podle webu“ u půjčovny?** Web místa zmiňuje půjčovnu kol nebo lyží (text na úvodní nebo
kontaktní stránce). Je to odhad – ověřte a nastavte ručně *ano* / *ne*.

**Jak často se mapa obnovuje a proč je „data OSM k“ starší než „obnoveno“?** Mapa se obnovuje každé pondělí
ráno (od 14. 10. 2026). OpenStreetMap ale bere ze serveru QLever, který snímek OSM obnovuje po svém, takže bývá
o pár týdnů starší. První datum v záhlaví říká, z kdy jsou data OSM, druhé, kdy se mapa naposledy sestavila –
k tomuto dni jsou čerstvé skiareály z OpenSkiMap a údaje z webů nových míst. Všechny weby se procházejí znovu
první pondělí v měsíci.

**Co se stane s mým stavem při obnově dat?** Nic – záznamy jsou vázané na trvalé identifikátory míst
z OpenStreetMap a žijí mimo data mapy. Když objekt v OSM někdo smaže nebo sloučí, jeho záznam se přestane
zobrazovat, ale v záloze zůstane.

**Kdo vidí moje poznámky?** Všichni přihlášení kolegové. Nikdo zvenčí – bez přihlášení není vidět ani mapa.

**Mohu pracovat v telefonu?** Ano, v prohlížeči na stejné adrese; pohodlnější je notebook.

**Klávesy.** `/` skočí do hledání, `Esc` zruší výběr nebo zavře dialog.
