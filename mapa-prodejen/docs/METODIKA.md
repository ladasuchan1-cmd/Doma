# Mapa prodejen a servisů kol – metodika dat

Co je v datech, odkud to je, jak se to páruje a počítá a jak to číst. Platí pro data sestavená **7. 10. 2026**
nástrojem `tools/build-data.js`. Změny metodiky se v tomto dokumentu **datují** (kap. 11), aby bylo jasné, od kdy
čísla nejsou srovnatelná se staršími. Ovládání popisuje [MANUAL.md](MANUAL.md).

## 1. Zdroje

| Zdroj | Jak se čte | Co dodává | Licence |
|---|---|---|---|
| **OpenStreetMap** | Overpass API po částech (kap. 2), střídají se veřejné instance (`overpass-api.de`, zrcadla `maps.mail.ru`, `overpass.kumi.systems`, `overpass.private.coffee`); území = `area["ISO3166-1"="CZ"]` a pak kontrola bodu v hranicích ČR | prodejny, servisy, půjčovny, bazary, řetězce s kontakty a značkami `service:bicycle:*` | [ODbL](https://www.openstreetmap.org/copyright) – uvádět „© přispěvatelé OpenStreetMap“ |
| **ARES** (MF) | REST `ares.gov.cz/ekonomicke-subjekty-v-be/rest`: `ekonomicke-subjekty/vyhledat` (obchodní jméno, sídlo v obci), `ekonomicke-subjekty/{IČO}` | firmy: název, právní forma, sídlo s kódem adresního místa, CZ-NACE, vznik, zánik, plátce DPH | veřejný rejstřík |
| **RES** (ČSÚ, přes ARES) | `ekonomicke-subjekty-res/{IČO}`, primární záznam | **kategorie počtu zaměstnanců** (číselník `KategoriePoctuPracovniku`) | veřejný registr |
| **ČÚZK RÚIAN** | ArcGIS REST `ags.cuzk.cz/arcgis/rest/services/RUIAN/MapServer`: vrstva 17 (kraje), 15 (okresy), 12 (obce, po 1 000), 1 (adresní místa); vyhledávání adres `GeocodeSOE/findAddressCandidates` | hranice krajů, okresů a obcí s kódy, souřadnice sídel firem, adresy při ručním přidání místa | CC BY 4.0 |
| **GeoNames** | `download.geonames.org/export/zip/CZ.zip` (PSČ) a `export/dump/CZ.zip` (sídla) | PSČ s místy a souřadnicemi, počty obyvatel sídel | CC BY 4.0 |
| **Weby prodejen** | úvodní stránka + až 3 podstránky (kap. 5) | e-maily, telefony, IČO, provozovatel, služby, značky kol | veřejně zveřejněné údaje; automatický odhad |

Stažené zdroje se ukládají do `cache/` (≈ 20 MB, mimo git): OSM a hranice na 20 dní, firmy z ARES na 30 dní,
weby na 45 dní (nedostupný web se zkouší znovu po týdnu). Měsíční obnova v GitHub Actions stahuje vše znovu
(`--fetch`).

## 2. Místa z OpenStreetMap

Dotazy (každý zvlášť, výstup se středem u ploch a se všemi značkami):

| Dotaz | Značky |
|---|---|
| prodejny | `shop=bicycle` |
| servis | `service:bicycle:repair=yes/only` |
| prodej | `service:bicycle:retail=yes/only` |
| půjčovny | `amenity=bicycle_rental`, `service:bicycle:rental=yes/only`, `shop=rental` + `rental~bicycle|bike|ebike|kolo` |
| sport | `shop=sports` + `sport~cycling|bicycle|mtb|bmx` |
| řetězce | `shop=sports` + název `Decathlon|Sportisimo|Hervis|Intersport` |

**Typ místa** (`typOsm`):

| Podmínka | Typ |
|---|---|
| `shop=sports/outdoor/bicycle` a název / značka / provozovatel Decathlon, Sportisimo, Hervis, Intersport, A3 Sport | Sportovní řetězec |
| `shop=bicycle` + `service:bicycle:second_hand=only` | Bazar kol |
| `shop=bicycle` + jen opravy (`repair=only`, nebo `retail=no` a `repair=yes`) | Servis kol |
| `shop=bicycle` + `retail=no` a `rental=yes` | Půjčovna kol |
| ostatní `shop=bicycle` | Prodejna kol |
| `amenity=bicycle_rental`, `shop=rental` s koly | Půjčovna kol – **jen pojmenované**; bez stojanů sdílených kol (`docking_station`, `dropoff_point`, Nextbike, Rekola, Lime, Bolt …) a bez půjčoven čehokoli jiného |
| jiný obchod se `service:bicycle:repair=yes` | Servis kol |
| jiný obchod s `service:bicycle:retail=yes`, sportovní obchod s cyklistikou | Prodejna kol |

Vynechávají se stojany na samoobslužné opravy (`amenity=bicycle_repair_station`). Z každého objektu se čte
název (`name`, `name:cs`, `brand`, `operator`), telefony, e-maily, weby a Facebook (`phone`, `contact:*`,
`website`, `url`), adresa (`addr:*`), `opening_hours`, `description`, `brand` a IČO (`ref:ico`, `ref:IČO`, `ico`,
`company:ico`). Stejný název do **200 m** (bod a budova, dvojí zápis) = jedno místo se sjednocenými kontakty.
Místa bez názvu (94) jsou v datech jako „Prodejna kol bez názvu“ a zobrazují se jen po zapnutí filtru.

## 3. Firmy z ARES (místa bez prodejny v OSM)

Prodejna, která v OSM chybí, často existuje jako firma s koly v obchodním jméně. ARES se proto prohledá podle
39 slov (celá slova obchodního jména): `kolo`, `kola`, `kol`, `cyklo`, `cykloservis`, `cyklosport`, …, `bike`,
`bikes`, `ebike`, `elektrokola`, `kolárna`, `velo`, `bicykl`, `cycling`, `cycles`, `koloshop`, `mtb` (úplný seznam
`ARES_SLOVA` v `tools/build-data.js`). Firma se bere, když:

1. je to podnikatel – OSVČ, v. o. s., s. r. o., k. s., a. s., družstvo, zahraniční osoba nebo odštěpný závod
   (právní formy 101, 105, 107, 111, 112, 113, 121, 205, 421, 424, 425, 501),
2. nezanikla, není v likvidaci, konkurzu ani insolvenci a není zaniklá v RES bez jiné aktivní registrace,
3. název neobsahuje slova jiných oborů – tým, klub, spolek, závod, maraton, škola, kavárna, hotel, penzion,
   kemp, reality, stavby, auto, pneu, velodrom, Velorex, marketing, holding … (`NE_PRODEJNA`), a není to
   podnikatel s příjmením Kola („Martin Kola“),
4. a název kola jasně zmiňuje (`cyklo…`, `bike…`, `elektrokol…`, `kolárna`, `bicykl…`, „jízdní kola“,
   „servis kol“, „Kola Novák“ …), **nebo** obsahuje nejednoznačné slovo (`kola`, `velo`, `cycl…`, `mtb`)
   a firma má v CZ-NACE obchod (46, 47), opravy (95), výrobu kol (30, 323) nebo půjčovnu (77).

Taková firma se napřed zkusí **spárovat s prodejnou z OSM** (kap. 4). Když se nespáruje, vznikne místo typu
**Firma z ARES (sídlo)** v souřadnicích **adresního místa sídla** z RÚIAN. Sídlo nemusí být provozovnou
(často byt majitele nebo sídlo účetní) – v mapě je proto tečka průhlednější s čárkovaným okrajem.
Stav 7. 10. 2026: 232 takových míst.

## 4. Párování míst s IČO

Velikost firmy se dá zjistit jen přes IČO. Pořadí zdrojů (první nalezený platí; ručně zadané IČO má vždy
přednost):

| Zdroj (`icoZdroj`) | Jak | Míst |
|---|---|---|
| **osm** | IČO zapsané v OpenStreetMap (kontrolní součet) | 3 |
| **web** | IČO na webu prodejny (kap. 5) – bez „cizích“ IČO a vybrané podle podobnosti | 179 |
| **nazev** | relevantní firma z ARES (kap. 3), jejíž název se shoduje s názvem prodejny (všechna výrazná slova kratšího názvu jsou i v delším) a sídlo je do 25 km | 35 |
| **odhad** | ARES podle nejvýraznějšího slova názvu v obci prodejny – jen jediný vyhovující kandidát | 84 |
| **ares** | místo vzniklo z firmy v ARES (sídlo) | 232 |
| bez IČO | | 677 |

**IČO z webu.** Na webech e-shopů bývají IČO jiných subjektů: Česká obchodní inspekce, Úřad pro ochranu osobních
údajů, Ministerstvo financí, Zásilkovna, Česká pošta, PPL, Comgate, Shoptet, Seznam, banky (seznam `CIZI_ICO`,
ověřeno v ARES 7. 10. 2026). Ty se vynechají, stejně jako IČO, které je na webech **3 a více různých prodejen**
(provozovatel platformy), a IČO úřadů, obcí a bank (vybrané právní formy řad 300, 600 a 800, CZ-NACE 64). Ze zbylých se vybere
IČO, jehož firma se nejvíc podobá názvu prodejny, doméně webu nebo provozovateli uvedenému v textu; bez jakékoli
shody jen tehdy, když je na webu jediné.

**Odhad podle jména a obce.** U prodejny z OSM bez IČO se z názvu vezme nejdelší slovo, které není obecné
(„cyklosport“, „point“, „shop“, „sport“, „servis“, názvy měst … – seznam `OBECNA_SLOVA`), a v ARES se hledají
firmy s tímto slovem se sídlem v obci prodejny. Když je výsledků víc než 50, slovo je příliš obecné a nic se
nebere. Kandidát musí být aktivní podnikatel, nesmí mít slova jiných oborů, výrazná slova kratšího z obou názvů
musí být všechna i v delším a musí mít obchod / opravy / půjčovnu v CZ-NACE nebo kola v názvu. Bere se **jen
jediný** takový kandidát. Příklad: „Cyklo Hloch“ v Olomouci → „Ctirad Hloch“. I tak jde o odhad – aplikace u
velikosti ukazuje **„?“** a v detailu „odhad podle jména a obce – ověřte“.

**Firma k IČO**: detail z ARES a záznam z RES (kategorie počtu zaměstnanců), uloženo na 30 dní. Do dat jde
502 firem; 533 míst má IČO.

## 5. Weby prodejen

Pro každé místo s webem (455 webů) se stáhne úvodní stránka a až **3 podstránky** ze stejné domény v pořadí
kontakt → servis → o nás (ne PDF). Slušnost: na jednu doménu jeden požadavek najednou, celkem 8 souběžně
(v Actions 10), limit 20 s a 1,5 MB na stránku, kódování podle hlavičky nebo `<meta charset>` (i Windows-1250).
Načíst se podařilo 336 webů (74 %); ostatní blokují roboty, neexistují nebo neodpověděly.

| Údaj | Jak |
|---|---|
| E-maily | `mailto:` a text; bez smetí (obrázky, `example`, `sentry`, roboti jako `bytedance`, `crawler` …), max. 6 |
| Telefony | česká a slovenská čísla, normalizovaná `+420 xxx xxx xxx`; bez zástupných čísel (`123 456 789`, `777 123 456`, opakující se číslice …), max. 6 |
| IČO | „IČ“, „IČO“ + 8 číslic s platným kontrolním součtem |
| Provozovatel | věta typu „Provozovatel: …“, „Provozovatelem e-shopu je …“ |
| Služby | **servis** (servis kol, opravy, seřízení …), **e-kola** (elektrokola, e-bike …), **půjčovna**, **bazar / výkup**, **e-shop** („do košíku“, „e-shop“, „internetový obchod“, tlačítko košíku v HTML), **prodej**; s ukázkou textu |
| Značky | ≈ 70 značek kol a komponent (Author, Rock Machine, Superior, Kellys, Specialized, Trek, Bafang …); víceznačná slova jen s velkým písmenem |

Služba v datech má **zdroj**: `osm` (značka v OSM nebo typ místa), `web` (text webu), `nazev` (název firmy
z ARES). OSM má přednost; „ne“ z OSM web nepřepíše. Stav 7. 10. 2026: prodej 915 míst, servis 388, e-kola 257,
e-shop 190, půjčovna 148, bazar 23. E-mail má (z OSM nebo webu) 368 míst, telefon 445. Nejčastější značky na
webech: Rock Machine 56, Author 51, Cannondale 45, Leader Fox 43, Superior 43, Kellys 42, Crussis 42, Scott 42.

## 6. Velikost firmy

Kategorie odpovídají trhu s koly (prodejna s 10 lidmi je v oboru velká), ne definici malých a středních podniků
podle EU:

| Kategorie | Obrat (má přednost) | Jinak počet zaměstnanců (ČSÚ) |
|---|---|---|
| Velká | nad 100 mil. Kč | 50 a více (kód 240 a vyšší) |
| Střední | 20–100 mil. Kč | 10–49 (210, 220, 230) |
| Malá | 3–20 mil. Kč | 1–9 (120, 130) |
| Mikro | do 3 mil. Kč | bez zaměstnanců (110); podnikající fyzická osoba, která počet neuvádí |
| Neznámá | – | IČO neznáme, nebo firma (právnická osoba) počet neuvádí (kód 000 / chybí) |

**Obrat ARES neposkytuje.** Je jen v účetních závěrkách ve Sbírce listin (`or.justice.cz`; povinnost zveřejnit
mají obchodní korporace, ne OSVČ, a řada firem ji plní pozdě) a v placených databázích, které je přebírají
(Merk, Cribis, Albertina / Bisnode). Aplikace proto obrat **přijímá** – ručně v detailu nebo tabulkou IČO; obrat;
rok (MANUAL kap. 11) – a ukládá ho na server s autorem a zdrojem. Číslo se čte i jako „45 mil“, „45,5 mil. Kč“,
„1,2 mld“, „800 tis.“, „1.234.567,89“; sloupec v „tis. Kč“ se vynásobí.

**Počet zaměstnanců** je kategorie z registru ekonomických subjektů ČSÚ (měsíčně podle hlášení ČSSZ), nikoli
přesné číslo. U malých firem bývá „neuvedeno“ a u OSVČ se nevyplňuje. Stav 7. 10. 2026 u míst: velká 13,
střední 59, malá 219, mikro 96, neznámá 823 (z toho 677 bez IČO). U firem (502): velká 9, střední 49, malá 204,
mikro 94, neznámá 146.

## 7. PSČ → obec, počty obyvatel

Objednávky nesou PSČ, mapa ukazuje obce. Jedno PSČ obsluhuje víc obcí (pošta a okolní vesnice), GeoNames u PSČ
uvádí místa s názvem a souřadnicemi, často přibližnými. Postup pro každé PSČ:

1. Každé místo PSČ **hlasuje** pro obec: obec stejného jména do 25 km (i „Plzeň 3-Valcha“ → Plzeň, „Brno 2“ →
   Brno) má váhu 3, jinak obec, ve které bod leží podle hranic obcí RÚIAN – přesné souřadnice 2, přibližné 1.
2. **Hlavní obec PSČ** = nejvyšší hlasy × počet obyvatel obce (min. 50). Pošta bývá v největší obci svého obvodu
   („741 01“ je Nový Jičín, ne Starý Jičín). Praha jen tehdy, když jsou pražská místa PSČ alespoň polovinou.
3. Poloha PSČ = průměr míst, která leží uvnitř hlavní obce; když žádné, střed obce.

Výsledek: 2 694 PSČ, každé s polohou, okresem, obcí a kódem obce RÚIAN. **Obce** (6 258) mají název, okres, střed,
hlavní PSČ a **počet obyvatel** – z GeoNames, sídlo stejného jména jako obec ležící v ní (součet za ČR
10,3 mil.). Počty jsou z GeoNames, ne z ČSÚ, proto jsou „na 1 000 obyvatel“ v aplikaci **orientační**.

## 8. Objednávky

Zpracovávají se **v prohlížeči** (`lib/objednavky.js`); na server se posílají jen součty podle PSČ. Server
(`validovat`) u každé položky přijme jen PSČ, počet a částku – položku s čímkoli dalším odmítne i s celým
souborem – a jinak uloží jen období, popis, název souboru, kdo a kdy nahrál a počty vynechaných (max. 20 000 PSČ).

1. **Záhlaví**: v prvních 15 řádcích se hledá řádek se sloupcem PSČ nebo obce. Rozpoznávají se názvy bez
   diakritiky a velikosti písmen: PSČ / ZIP / postcode, město / obec / city, země / stát / country, datum,
   celkem / částka / cena / total, počet, stav / status, číslo objednávky / order / doklad. Je-li sloupců víc,
   má přednost **doručovací** adresa před fakturační.
2. **Řádky**: stav obsahující storno / zrušeno / cancel / vráceno / refund / nevyzvednuto / nezaplaceno /
   odmítnuto / smazáno = **storno**; země jiná než Česko nebo PSČ začínající 0, 8 či 9 (slovenská) = **zahraničí**.
   Obojí se vynechá (u exportu po položkách jednou za objednávku).
3. **Po objednávkách**: s číslem objednávky se řádky se stejným číslem počítají jako jedna objednávka; částka
   se sečte, pokud se na řádcích liší (položky), a vezme jednou, pokud se opakuje (celková cena na každém řádku).
4. **Hotový přehled**: soubor s PSČ a sloupcem počtu (bez čísel objednávek) se bere jako součty.
5. **Přiřazení**: PSČ z CZ formátu (5 číslic, první 1–7). Neznámé PSČ → PSČ se stejnými prvními třemi číslicemi;
   řádek jen s obcí → hlavní PSČ obce stejného jména (největší).

Obce se z PSČ sčítají podle kódu obce RÚIAN; poloha obce = vážený průměr jejích PSČ.

## 9. Pokrytí, bílá místa, skóre partnera

- **Pokrytí** = místa se stavem **Partner** a **naše prodejny** (IČO naší firmy v Nastavení, nebo ručně přidané
  místo typu „naše prodejna“).
- **Okruh** R (5–50 km, výchozí 15 km) nastavuje uživatel; vzdálenosti jsou vzdušné (haversine) přes mřížkový
  index.
- **Poptávka u místa** = součet objednávek z PSČ do R km.
- **Obec pokrytá** = nejbližší pokrývající místo do R km. **Bílé místo** = obec s alespoň N objednávkami
  (výchozí 5) bez pokrytí v okruhu.
- **Kandidát na partnera**: prodejna, servis, půjčovna, bazar nebo firma z ARES, která není partnerem,
  neodmítla, není skrytá, není sportovní řetězec ani naše prodejna.

**Skóre (0–100)** = součet:

| Složka | Body | Výpočet |
|---|---|---|
| Poptávka | 0–50 | `50 × √(poptávka / největší poptávka mezi kandidáty)` – odmocnina, aby jedno velké město nepřebilo vše |
| Servis | 20 / 8 / 0 | dělá servis / nevíme / nedělá (podle OSM a webu) |
| Nepokryté okolí | 0–20 | `20 × min(1, vzdálenost k nejbližšímu pokrývajícímu místu / R)`; žádné do 3R = 20 |
| Kontakt | 0–10 | e-mail 6 + telefon 4 (ruční, z OSM nebo z webu) |

Skóre je **pomůcka k řazení**, ne hodnocení firmy: neříká nic o kvalitě prodejny, cenách ani ochotě
spolupracovat. Velikost firmy do skóre záměrně nevstupuje – pro servisní partnerství bývá malá prodejna
vhodnější než velká; filtr velikosti se dá použít zvlášť.

## 10. Omezení

- **Úplnost** odpovídá OpenStreetMap (prodejny kol v ČR jsou v OSM zmapované dobře, servisy hůř – servis jako
  služba prodejny často chybí) a firmám s koly v obchodním jméně. Prodejna, která v OSM není a jmenuje se jinak,
  v datech chybí – doplňuje se ručně (+ Místo) nebo zápisem do OSM.
- **Firmy z ARES** leží v sídle; část z nich jsou e-shopy, velkoobchody nebo firmy, které kola jen mají v názvu
  – v aplikaci se skrývají („není prodejna“).
- **IČO** u 677 míst chybí; u 84 je jen odhad. Velikost je tak známá hlavně u prodejen s webem.
- **Zaměstnanci** jsou kategorie ČSÚ se zpožděním a u části firem chybí; **obrat** jen z importu nebo ručně.
- **Služby a značky z webu** jsou automatický odhad podle textu (web může zmiňovat servis jen v obchodních
  podmínkách); 26 % webů se načíst nepodařilo.
- **PSČ → obec**: PSČ pokrývá i okolní obce, objednávky z vesnice se tak započtou obci s poštou. U pěti PSČ větších
  měst je hlavní obec jiná, než by čekal člověk (souřadnice GeoNames); na součty za okres to nemá vliv.
- **Vzdálenosti** jsou vzdušnou čarou, ne po silnici.

## 11. Změny metodiky

| Datum | Změna |
|---|---|
| 7. 10. 2026 | První verze: OSM (8 dotazů), ARES podle 39 slov, IČO z OSM / webu / názvu / odhadu, velikost podle obratu nebo kategorie zaměstnanců ČSÚ, PSČ → obec podle hranic obcí RÚIAN a hlasování, skóre partnera 50 / 20 / 20 / 10. |
