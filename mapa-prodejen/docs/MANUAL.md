# Mapa prodejen a servisů kol – manuál pro obchodní tým

Jak najít prodejny a servisy kol, poznat jejich velikost, nahrát objednávky a zákazníky (tabulka z Excelu nebo
export e-shopu), najít města bez partnera a vést evidenci oslovení. Odkud jsou data a jak se počítají, popisuje
[METODIKA.md](METODIKA.md); provoz serveru [../NASAZENI.md](../NASAZENI.md).

## 1. Přihlášení

- Adresa: **https://mapa.ksprehledy.cz**. Jméno a heslo jsou stejné jako na cyklomapě, pokud správce nenastavil
  jiné. Na velikosti písmen ve **jméně** nezáleží, v **hesle** ano.
- Přihlášení platí **30 dní** v daném prohlížeči; odhlášení tlačítkem vpravo nahoře u vašeho jména.
- Po **10 špatných pokusech** se adresa na 15 minut zablokuje – počkejte, nehádejte.
- Všechno, co v aplikaci uložíte (stav spolupráce, objednávky, přidaná místa, obraty), vidí po obnovení stránky
  celý tým, u změn je vidět **kdo a kdy** je udělal.

## 2. Co je na obrazovce

| Část | Co tam je |
|---|---|
| Lišta nahoře | drobečková navigace **ČR › kraj › okres** s výběrem kraje a okresu, pole **hledání**, tlačítka **Tabulka**, **Objednávky**, **+ Místo**, **Data**, přepínač světlého a tmavého vzhledu (◐), odhlášení |
| Levý panel | souhrn výběru (počet míst, s IČO, se servisem, partneři, vytipováno, osloveno) a **filtry**; po nahrání objednávek i jejich vrstvy a nastavení okruhu |
| Mapa | hranice krajů a okresů, místa jako barevné tečky, ★ partner, ⌂ naše prodejna, po nahrání objednávek bubliny obcí a obarvení krajů / okresů |
| Pravý panel | záložky **Místa** · **Partneři** · **Města** s počty a **detail** vybraného místa nebo obce |

Klávesa `/` skočí do hledání, `Esc` zavře detail. Adresa stránky nese vybraný kraj, okres, místo, obec a záložku
(`#kraj=116&okres=3702&misto=n123`) – dá se poslat kolegovi s účtem.

## 3. Mapa: ČR → kraj → okres

1. Klik na kraj (nebo výběr v liště) přiblíží kraj, klik na okres přiblíží okres. Zpět přes drobečkovou navigaci.
2. Vybraná oblast určuje, co je v seznamech, v tabulce a v exportu.
3. Najetí myší na kraj nebo okres ukáže počet míst a (po nahrání) objednávek.

**Tečky** jsou místa. Barvu volíte vlevo v **Barva značek podle**:

- **velikosti** (výchozí) – větší a tmavší tečka = větší firma, viz kap. 4;
- **typu** – prodejna, servis, půjčovna, bazar, sportovní řetězec, firma z ARES, naše prodejna;
- **spolupráce** – barva podle nejdále dotaženého stavu (vytipováno → osloveno → voláno → schůzka → partner,
  zvlášť „nemá zájem“), šedá bez stavu.

Silný barevný **okraj** tečky ukazuje stav spolupráce (i když je barva podle velikosti nebo typu). Průhlednější
tečka s čárkovaným okrajem je **sídlo firmy z ARES** – firma má kola v názvu, ale v OpenStreetMap její prodejna
není; sídlo nemusí být prodejnou. Najetí myší na tečku ukáže název, typ, velikost a obec.

## 4. Velikost firmy

| Velikost | Kdy | Typicky |
|---|---|---|
| **Velká** | 50 a více zaměstnanců, nebo obrat nad 100 mil. Kč | velké řetězce a distributoři |
| **Střední** | 10–49 zaměstnanců, nebo obrat 20–100 mil. Kč | větší prodejna s e-shopem, malý řetězec |
| **Malá** | 1–9 zaměstnanců, nebo obrat 3–20 mil. Kč | běžná kamenná prodejna se servisem |
| **Mikro** | bez zaměstnanců (OSVČ), nebo obrat do 3 mil. Kč | živnostník, malý servis |
| **Neznámá** | neznáme IČO, nebo firma počet zaměstnanců neuvádí | doplňte IČO nebo obrat |

- **Obrat má přednost.** ARES ho neuvádí, proto je velikost většinou podle **počtu zaměstnanců** (kategorie od
  ČSÚ). Obrat doplníte v detailu místa nebo hromadně tabulkou (kap. 11).
- Štítek **„Malá?“ s otazníkem** = IČO je jen **odhad podle jména a obce**. Před oslovením ověřte (odkaz ARES
  v detailu) a správné IČO případně zadejte – otazník zmizí.
- „**· 5 prodejen**“ za velikostí = firma má v datech 3 a více míst (řetězec).
- Najetím myší na štítek uvidíte, podle čeho se velikost určila („ČSÚ: 10–19 zaměstnanců“, „obrat 45 mil. Kč (2024)“).

## 5. Filtry (levý panel)

- **Typ**: Prodejny kol · Servisy kol · Půjčovny kol · Bazary kol · Sportovní řetězce · Firmy z ARES (sídlo) ·
  Naše prodejny · Jiné (ručně).
- **Velikost firmy**: kategorie z kap. 4 (počty jsou vždy pro aktuální výběr).
- **Musí nabízet**: Servis · E-kola · Půjčovna · Bazar / výkup · E-shop – podle OpenStreetMap a textu webu
  prodejny (zaškrtnuté musí platit všechny).
- **Značka kol**: značky, které prodejna uvádí na webu (Specialized, Trek, Author, Ghost …).
- **Kontakt**: s e-mailem nebo telefonem / s e-mailem / s telefonem / bez kontaktu.
- **Spolupráce**: bez stavu / s jakýmkoli stavem / rozpracované (ne partner, ne odmítl) / konkrétní stav.
  **Zobrazit i místa bez názvu** a **Zobrazit i skrytá** („není prodejna“, kap. 9).
- **Hledání** nahoře filtruje podle názvu, obce, adresy, IČO, názvu firmy, značky, okresu i webu.

Filtry platí najednou pro mapu, seznamy, tabulku i export.

## 6. Detail místa

Klik na tečku, řádek seznamu nebo v tabulce. Obsahuje:

- **typ, velikost, služby, stav**; adresu, okres a kraj, telefon, e-mail, web, otevírací dobu, značky kol a zdroj
  (odkaz do OpenStreetMap, Mapy.cz);
- **Firma a velikost**: název z ARES, IČO a odkud je (z OSM, z webu prodejny, podle shody názvu, odhad, ručně),
  právní forma, plátce DPH, sídlo, vznik, **zaměstnanci (ČSÚ)**, **obrat**, hlavní činnost, další místa téže
  firmy; pole pro **obrat** a pro **změnu IČO**;
- **Objednávky v okolí** (po nahrání objednávek): kolik objednávek je do zvoleného okruhu, z kterých obcí,
  a **skóre partnera** po složkách (kap. 10); v mapě je okruh vyznačen přerušovaným kruhem;
- **Další prodejny a servisy do 5 km** – konkurence a alternativy;
- **Z webu (automaticky)**: e-maily, telefony, IČO na webu, provozovatel, co web zmiňuje (servis, e-kola,
  půjčovna, bazar, e-shop) s ukázkou textu a značky; tlačítko **Převzít kontakty do spolupráce**;
- **Hledat na webu**: Google, Firmy.cz, Mapy.cz, ARES, **Justice – účetní závěrky**, Kurzy.cz;
- **Spolupráce**: evidence oslovení (kap. 9).

## 7. Objednávky a zákazníci (tlačítko Objednávky)

Do mapy jde dostat **objednávky, zákazníky nebo aktivní zákazníky** (a hodnotu objednávek v Kč) dvěma způsoby:

**A) Tabulka z Excelu (kontingenční tabulka) – vložit ze schránky**

1. V Excelu nastavte filtry kontingenční tabulky (rok, země, skupina…) a označte **celou tabulku** – klidně
   i s nadpisem a filtry nad ní a klidně **obě tabulky vedle sebe** (obce vlevo, rozpad velkých měst podle PSČ
   vpravo). **Ctrl+C**.
2. V mapě **Objednávky** → klikněte do pole **„Sem vložte tabulku z Excelu“** → **Ctrl+V**. Náhled se ukáže hned.
3. Aplikace sama najde záhlaví (přeskočí nadpis, popisky a řádky filtrů typu „Země | (Vše)“) a sloupce:
   **obec**, **PSČ**, **země**, **Zákazníků**, **Aktivních** / **Z toho aktivních**, **Objednávek** /
   **Počet objednávek**, **Hodnota (Kč)**. Sloupec „Průměrná objednávka“ se nepočítá. U křížové tabulky (roky ve
   sloupcích) se vezme sloupec **Celkový součet**.
4. Řádky **„Praha Celkem“**, **„CZ Celkem“** a **„Celkový součet“** se nesčítají – a „Celkový součet“ slouží jako
   **kontrola**: v náhledu je ✓ „součet řádků = řádek Celkový součet“, nebo ⚠ s rozdílem, když se něco nenačetlo.
5. **Dvě tabulky vedle sebe** (obce + „Rozpad velkých měst dle PSČ“): výchozí je **Obě tabulky dohromady** –
   velká města se vezmou podle PSČ z pravé tabulky a z levé tabulky se vynechají (nepočítají se dvakrát), ostatní
   obce se vezmou z levé. Když tabulky nesedí (jiné filtry vlevo a vpravo), náhled upozorní – nastavte stejné
   filtry v obou, nebo vyberte **Jen tabulka …**.
6. Popis se předvyplní nadpisem tabulky; **Uložit pro tým**. Nové nahrání nahradí předchozí.

Rozložení kontingenční tabulky, které se čte nejlépe (Excel → **Návrh**): **Rozložení sestavy → Zobrazit ve formě
tabulky** a **Opakovat všechny popisky položek**, **Souhrny → Nezobrazovat souhrny**. Nevadí ale ani kompaktní
forma (obec jen u prvního řádku skupiny – doplní se), ani mezisoučty „… Celkem“ (vynechají se). Nepoužívejte
rozložení „kompaktní“ s jedním sloupcem **Popisky řádků**, ve kterém jsou obce i PSČ pod sebou – tam aplikace
obec od PSČ nerozliší.

**B) Export z e-shopu nebo z POHODY – soubor**

1. Vyexportujte objednávky – **CSV** (oddělovač `;`, `,` nebo tabulátor, UTF-8 i Windows-1250) nebo **XLSX**
   (první list). Starý `.xls` uložte v Excelu jako `.xlsx`.
2. **Vybrat soubor…** – sloupce se najdou samy: **PSČ** (přednost má doručovací adresa), **obec / město**,
   **datum**, **částka**, **stav**, **země** a **číslo objednávky**.
3. Stav jako „stornováno“, „zrušeno“, „vráceno“, „nevyzvednuto“, „nezaplaceno“ se nepočítá. **Export po položkách**
   (jeden řádek = jedna položka) nevadí, když je v souboru číslo objednávky – počítá se po objednávkách.

**Náhled – co kontrolovat:** kolik se přiřadilo k obcím (u každé veličiny zvlášť), kolik **PSČ a obcí**, kolik je
**zahraničí** (vynechá se), **nepřiřazeno** (bez obce a PSČ – „(neuvedeno)“ – a neznámé obce, vypsané jménem),
**opravená PSČ** a **podle názvu obce**. Když nějaký sloupec nesedí, rozbalte **Sloupce tabulky … – opravit**
a vyberte ho ručně; výsledek se hned přepočítá.

Jak se řádky přiřazují k obcím:

- **PSČ** má přednost před názvem obce. Česká PSČ začínají 1–7; slovenská (0, 8, 9), polská (`02-972`) a s předponou
  státu (`SK-…`, `D-…`) jdou do zahraničí, stejně jako řádky se zemí jinou než CZ.
- **4místné PSČ** („1200“ u Prahy, „4601“ u Liberce – chybí nula) se opraví na české, **když sedí název obce**;
  tak se zachrání i řádky, kde Excel odhadl zemi podle tvaru PSČ (sloupec „Země (odhad)“ = AT, ale obec Praha).
  „Wien 1020“ zůstane v zahraničí.
- Řádek **jen s názvem obce** (bez PSČ) se přiřadí k hlavnímu PSČ obce. Import rozumí i tomu, jak lidé obce píšou
  do adres:
  - starší a poštovní přívlastky – „Říčany u Prahy“, „Zábřeh na Moravě“, „Hlinsko v Čechách“, „Ostrov nad Ohří“;
  - zkratky – „Frenštát p.R.“, „Č. Budějovice“, „Uh.Hradiště“, „Ústí n/L“, „Kralupy n. Vlt.“;
  - část názvu se spojovníkem a začátek názvu – „Brandýs nad Labem“, „Stará Boleslav“, „Frenštát“, „Dvůr Králové“;
  - část obce, číslo obvodu a adresa – „Husinec - Řež“, „Sušice II“, „Studené 55, Jílové u Prahy“, „Holásky, Brno“,
    „Zbraslav-Praha“ (pražská čtvrť, ne Zbraslav u Brna), „Praha 6 - Dejvice“, „Ostrava-Poruba“, „Moravská
    Ostrava“, „Liberec XXV“, „Teplice (okres Teplice)“;
  - okres a pošta – „Kozmice okr. Benešov“, „Ruda, pošta Nové Strašecí“; překlep v přívlastku („Rožnov pod
    Rahoštěm“).

  Obcí stejného jména je v Česku hodně (14 Nových Vsí, 6 Ostrovů). Rozhoduje vodítko v názvu: „Říčany u Brna“ jsou
  jiné Říčany než „u Prahy“, „okr. Benešov“ určuje okres. Pomůže i oblast („v Čechách“, „na Moravě“, „ve
  Slezsku“) nebo řeka, podle obcí, které ji mají v názvu („Ostrov nad Ohří“ je ten u Klášterce nad Ohří). Jinak se
  bere největší obec toho jména. Kde vodítko chybí a obcí je víc, import nehádá a obec nechá v **nepřiřazeno**
  („Staré Město pod Sněžníkem“ – v Česku je pět Starých Měst). **„Brno-venkov“** a „Praha-západ“ jsou okresy,
  ne obce – zůstanou nepřiřazené.
- **Zahraniční města** podle názvu: Bratislava, Košice, Žilina, Trnava, Senec, Wien, Berlin, München, Warszawa
  a další velká města, i ta, která mají v Česku malou obec stejného jména (Košice u Tábora, Žilina u Kladna).
  Poznají se i jako součást názvu („Košice - Peres“, „Bratislava V“). Do zahraničí jdou také názvy:
  - s písmeny, která čeština nemá (ľ, ô, ä, ö, ü, ł …);
  - se slovenským tvarem („Moravany nad Váhom“, „Výčapy-Opatovce“, „Horné Orešany“, „… pri …“);
  - se zemí v názvu („Bratislava Slovensko“, „Cesena, Italy“).

  Slovenská „Modra“ a moravská „Modrá“ se rozliší podle diakritiky. Řádek s českým PSČ jde vždy do české obce.
- Neznámé PSČ (P. O. Box, nové) se přiřadí podle názvu obce, jinak k PSČ se stejnými prvními třemi číslicemi.

Dobré vědět:

- **Soukromí:** tabulka i soubor se zpracují jen ve vašem prohlížeči. Na server jdou jen **součty podle PSČ**
  (počty objednávek / zákazníků / aktivních a částka) – žádná jména, adresy, e-maily ani čísla objednávek.
- Názvy obcí z tabulky se nikde nevykreslí jako HTML (ani když v datech e-shopu je podvržený kód).
- **Stáhnout součty (CSV)** dá přehled PSČ – obec – okres – počty – částka; **Smazat nahrané** je smaže pro celý tým.

Po uložení se zapnou vrstvy v levém panelu:

- **Počítat v mapě** (když tabulka obsahovala víc veličin): **Objednávky**, **Zákazníci** nebo **Aktivní
  zákazníci**. Podle výběru se kreslí bubliny, barví kraje, hledají bílá místa a počítá skóre partnerů; popisky
  v celé aplikaci se přepnou („zákazníků do 15 km“).
- **Obce podle počtu …** – oranžové bubliny (plocha ~ počet). Na úrovni ČR je 250 obcí s nejvyšším počtem
  a všechna bílá místa, v kraji a okrese všechny.
- **Kraje / okresy podle …** – obarvení, volitelně **na 1 000 obyvatel** (orientačně).
- **Okruh partnera / poptávky** (5–50 km, výchozí 15 km) – jak daleko jsou zákazníci ochotni jet; podle něj se
  počítá poptávka u prodejny, pokrytí obcí partnery a bílá místa.
- **Bílé místo = obec s aspoň N objednávkami / zákazníky** (výchozí 5) **bez partnera ani naší prodejny
  v okruhu** – bublina s červeným přerušovaným okrajem.

## 8. Záložka Města

Obce seřazené **podle počtu objednávek**, **jen bílá místa** nebo **na 1 000 obyvatel** (jen obce nad 1 000
obyvatel). U obce je okres, částka, objednávky na 1 000 obyvatel, zda je do okruhu partner (a jak daleko),
a kolik prodejen a servisů je v okruhu.

**Detail obce**: počet a podíl (objednávek nebo zákazníků podle volby vlevo), ostatní nahrané veličiny
(např. zákazníci, aktivní zákazníci), hodnota objednávek, počet na 1 000 obyvatel, vzdálenost k nejbližšímu
partnerovi nebo naší prodejně a **seznam prodejen a servisů v okruhu** – partneři nahoře, ostatní podle skóre.
To je seznam, koho v dané oblasti oslovit.

## 9. Evidence spolupráce

V detailu místa, část **Spolupráce**:

| Stav | Kdy zaškrtnout |
|---|---|
| **Vytipovaný – chceme oslovit** | místo stojí za oslovení (rychle i tlačítkem **Vytipovat** v záložce Partneři) |
| **Osloven (e-mail / nabídka)** | odešla nabídka |
| **Volali jsme** | proběhl telefonát |
| **Schůzka / návštěva proběhla** | osobní jednání |
| **Partner – spolupráce domluvena** | ★ v mapě; místo se počítá jako pokrytí okolí (bílá místa, skóre ostatních) |
| **Nemá zájem** | místo vypadne z kandidátů na partnera |

- U každého stavu se ukládá **datum**; „Partner“ a „Nemá zájem“ se vylučují.
- **Typ spolupráce**: servis (montáž, záruční prohlídky, reklamace) · výdejní místo · prodej / odběratel · jiné.
- **Poznámka**, **kontaktní osoba**, **telefon**, **e-mail**, **web** – vlastní zápis má přednost před údaji
  z dat (šedé předvyplnění).
- **Skrýt z mapy – není to prodejna ani servis kol**: pro omyly v datech (zavřená prodejna, firma s koly jen
  v názvu). Skrytá místa zobrazí filtr „Zobrazit i skrytá“.
- Ukládá se samo; u formuláře je „Uloženo … · jméno“. **Smazat záznam** vrátí místo do stavu bez evidence.

## 10. Záložka Partneři – kandidáti a skóre

Seznam prodejen, servisů, půjčoven, bazarů a firem z ARES v aktuálním výběru, které ještě nejsou partnerem,
seřazený podle **skóre 0–100**. Nejsou v něm sportovní řetězce, naše prodejny, skrytá místa a ti, kdo nemají zájem.

| Složka | Body | Jak |
|---|---|---|
| Objednávky v okolí | 0–50 | objednávky do zvoleného okruhu vůči kandidátovi s největší poptávkou (odmocninově – velké město nepřebije vše) |
| Servis | 20 / 8 / 0 | dělá servis / nevíme / nedělá |
| Nepokryté okolí | 0–20 | 20 = v okruhu není partner ani naše prodejna; čím blíž partner, tím méně |
| Kontakt | 0–10 | e-mail 6, telefon 4 |

Proužek u kandidáta ukazuje složky barevně (najetím myší se zobrazí body). Přepínače **jen bez partnera do X km**
a **jen se servisem** zúží seznam. Bez nahraných objednávek se řadí jen podle servisu, kontaktu a pokrytí.

## 11. Obrat firem

- **Jednotlivě**: detail místa → Firma a velikost → pole obrat („45 mil“, „45 000 000“, „800 tis.“, „1,2 mld“)
  a rok → **Doplnit obrat**. Obrat najdete v účetní závěrce (odkaz **Justice – účetní závěrky** → Sbírka listin
  → výkaz zisku a ztráty, řádek „Tržby“) nebo na Kurzy.cz.
- **Hromadně**: **Data → Obraty firem → Nahrát obraty…** – tabulka CSV/XLSX se sloupci **IČO** a **obrat**
  (záhlaví „Obrat“, „Tržby“ nebo „Výnosy“), volitelně **rok**, **jednotka** (tis. / mil.) a **zdroj**. Když je
  v záhlaví „v tis. Kč“, čísla se vynásobí. Hodí se pro export z placené databáze (Merk, Cribis, Albertina).
- **Vzor tabulky** stáhne CSV se všemi IČO z mapy – stačí doplnit obraty a nahrát zpět.
- Obrat má přednost před počtem zaměstnanců; velikost se hned přepočítá.

## 12. Přidání chybějícího místa (+ Místo)

1. Máte-li **IČO**, zadejte ho a **Načíst z ARES** – doplní název, adresu sídla a polohu sídla.
2. Jinak vyplňte název, **adresu** a **Najít** (adresní místa RÚIAN) – vyberte správnou adresu ze seznamu.
   Nebo **Vybrat v mapě** a klikněte na místo prodejny (`Esc` = zpět do formuláře).
3. Typ (prodejna, servis, půjčovna, bazar, sportovní řetězec, **naše prodejna / pobočka**, jiné), kontakty,
   co nabízí, poznámka → **Přidat místo**.

Ručně přidaná místa vidí celý tým; upravit nebo smazat je jde v jejich detailu. Při měsíční obnově dat zůstávají.

## 13. Naše firma

**Data → Naše firma**: IČO naší firmy (víc oddělte čárkou). Její prodejny se v mapě označí ⌂, mají typ „Naše
prodejny“ a **počítají se jako pokrytí** – obec u naší prodejny není bílé místo a kandidáti vedle ní mají méně
bodů za nepokryté okolí. Je-li v datech KOLOSHOP, aplikace ho nabídne jedním tlačítkem. Pobočku, která v datech
chybí, přidejte přes **+ Místo** s typem „Naše prodejna / pobočka“.

## 14. Tabulka a export

- **Tabulka** (tlačítko nahoře) ukazuje aktuální výběr se vším: velikost a proč, zaměstnanci, obrat, IČO,
  firma, adresa, kontakty, služby, značky, objednávky v okolí, skóre, stavy s daty, typ spolupráce, poznámka,
  kdo a kdy upravil. Klik na záhlaví řadí; zaškrtávátka stavů se rovnou ukládají.
- **Export CSV** (v tabulce nebo **Data → Export**) otevře Excel (oddělovač `;`, UTF-8 s BOM).
  **Všechna místa se stavem spolupráce** exportuje celou evidenci bez ohledu na filtry.
- **Data → Stav spolupráce – záloha**: JSON se všemi záznamy; načtení zálohy záznamy sloučí (vyhraje novější).
  Server navíc zálohuje denně.

## 15. Doporučený postup hledání partnerů

1. **Data → Naše firma** – nastavit IČO, ať se naše prodejny počítají jako pokrytí.
2. **Objednávky** – vložit tabulku z Excelu (obce / PSČ s počty objednávek nebo zákazníků) nebo nahrát export
   za poslední 1–2 roky (doručovací PSČ, stav, číslo objednávky).
3. Záložka **Města** → **jen bílá místa**: obce s objednávkami bez partnera v okruhu. Okruh nastavit podle toho,
   kam jsou zákazníci ochotni jet (město 10–15 km, venkov 20–30 km).
4. Detail bílé obce → prodejny a servisy v okruhu → otevřít nejlepší kandidáty, ověřit IČO a velikost,
   **Vytipovat**. Kde v okruhu nic není, hledat přes odkazy (Google, Firmy.cz) a doplnit **+ Místo**.
5. Záložka **Partneři** s filtrem **Spolupráce → Vytipovaný** = seznam k oslovení; export CSV pro rozdělení
   mezi obchodníky (filtr kraje).
6. Průběh zapisovat (osloven → voláno → schůzka → partner / nemá zájem). Nový partner hned změní pokrytí:
   jeho okolí přestane být bílým místem a ostatní kandidáti v okolí klesnou ve skóre.
7. Barva **podle spolupráce** + filtr **Rozpracované** = přehled rozjednaných míst na poradu.

## 16. Časté otázky

- **Proč je tolik firem „Neznámá“?** Většina prodejen z OpenStreetMap nemá IČO a na jejich webu se ho nepodařilo
  spolehlivě najít. Doplňte IČO v detailu – velikost se dohledá v ARES okamžitě.
- **Firma má 0 zaměstnanců, ale je to velká prodejna.** ČSÚ přebírá počet zaměstnanců z hlášení ČSSZ a u části
  firem je neaktuální nebo „neuvedeno“; zadejte obrat – má přednost.
- **Prodejna v mapě chybí.** Data jsou z OpenStreetMap a z firem s koly v obchodním jméně. Přidejte ji přes
  **+ Místo**; nejlépe i do OpenStreetMap (projeví se při příští měsíční obnově).
- **Místo není prodejna (zavřeno, jiný obor).** Skrýt v části Spolupráce.
- **Data k jakému dni?** Pod názvem aplikace vlevo nahoře („data k …“); obnovují se 1. den v měsíci. Stav
  spolupráce, objednávky, přidaná místa a obraty obnova nemění.
- **Uvidí kolegové moje objednávky?** Ano, součty podle PSČ jsou společné pro tým (nahrává se jeden soubor
  za firmu). Osobní údaje zákazníků se na server nedostanou.
- **Po vložení tabulky z Excelu je hodně „nepřiřazeno“.** Podívejte se na seznam v náhledu. „Bez obce i PSČ
  (neuvedeno)“ jsou zákazníci bez adresy v e-shopu – do mapy dát nejdou. Mezi neznámými obcemi bývají:
  - slovenské vesnice bez slovenských písmen („Lipany“, „Trstená“);
  - překlepy, testovací a vymyšlené záznamy („doplnit“, „Mesto“);
  - jmenovci bez vodítka („Staré Město pod Sněžníkem“).

  Takovou obec v tabulce opravte nebo doplňte PSČ, tabulku vložte znovu a součty se přepočítají. Když je ⚠
  u kontrolního součtu, nenačetly se některé řádky – rozbalte „Sloupce tabulky“ a zkontrolujte, který sloupec je
  obec, PSČ a počet.
- **Chci mapu zákazníků i objednávek.** Vložte tabulku, která má obojí (např. Zákazníků, Aktivních, Objednávek,
  Hodnota) – mezi veličinami pak přepínáte vlevo v **Počítat v mapě** bez nového nahrání.
