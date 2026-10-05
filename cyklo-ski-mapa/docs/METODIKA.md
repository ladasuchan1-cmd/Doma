# Cyklo & Ski mapa – metodika dat

Co přesně je v datech, odkud to je, jak se to třídí a počítá a jak to číst. Platí pro data sestavená
**3. 10. 2026** nástroji `tools/build-data.js` (mapa) a `tools/enrich-web.js` (údaje z webů). Změny metodiky
se v tomto dokumentu **datují** (kap. 10), aby bylo jasné, od kdy čísla nejsou srovnatelná se staršími.
Ovládání popisuje [MANUAL.md](MANUAL.md), přehled [SHRNUTI.md](SHRNUTI.md).

## 1. Zdroje

| Zdroj | Jak se čte | Co dodává | Licence |
|---|---|---|---|
| **OpenStreetMap** | SPARQL dotazy na [QLever osm-planet](https://qlever.dev/osm-planet) (`https://qlever.dev/api/osm-planet`); území ČR = objekty uvnitř relace hranic Česka `osmrel:51684` (prostorové predikáty `ogc:sfContains` / `ogc:sfIntersects`) | trasy, cyklostezky, sjezdovky, vleky, plochy skiareálů, místa a jejich značky (tagy) | [ODbL](https://www.openstreetmap.org/copyright) – uvádět „© přispěvatelé OpenStreetMap“ |
| **OpenSkiMap** | soubor `ski_areas.geojson` z `tiles.openskimap.org`, filtr na areály s `places[].iso3166_1Alpha2 == "CZ"` | skiareály: název, stav provozu, weby, počty a délky sjezdovek podle obtížnosti, vleky, nadmořská výška, polygon | ODbL / CC BY |
| **ČÚZK RÚIAN** | ArcGIS REST služba `ags.cuzk.cz/arcgis/rest/services/RUIAN/MapServer`, vrstva 17 (kraje – VÚSC) a 15 (okresy), generalizace `maxAllowableOffset=0.0005` | hranice krajů a okresů s kódy RÚIAN a NUTS | CC BY 4.0 |
| **Weby míst** | HTTP stažení úvodní stránky a až 2 kontaktních podstránek (kap. 5) | e-maily, telefony, IČO, provozovatel, zmínky o půjčovně | veřejně zveřejněné údaje; automatický odhad |
| **ARES** | REST `ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{IČO}` | k IČO oficiální název, právní forma, sídlo | veřejný rejstřík |

Stažené zdroje se ukládají do `cache/` (≈ 80 MB, není v gitu); `--fetch` je stáhne znovu. Overpass API
(obvyklá cesta k OSM) nebylo z prostředí sestavení dostupné, proto QLever; výsledek je stejný – data OSM.

## 2. Co se z OpenStreetMap bere

**Místa** – objekty (uzly i plochy, u ploch se bere střed) s některou z těchto značek:

| Značka OSM | Typ v aplikaci | Skupina |
|---|---|---|
| `tourism=hotel` | Hotel | Ubytování |
| `tourism=guest_house` | Penzion | Ubytování |
| `tourism=chalet` | Chata | Ubytování |
| `tourism=hostel` | Hostel | Ubytování |
| `tourism=motel` | Motel | Ubytování |
| `tourism=apartment` | Apartmán | Ubytování |
| `tourism=alpine_hut` | Horská chata | Ubytování |
| `tourism=camp_site` | Kemp | Ubytování |
| `tourism=information` + `information=office` / `visitor_centre` | Infocentrum | Infocentra |
| `amenity=bicycle_rental` | Půjčovna kol | Půjčovny a obchody |
| `amenity=ski_rental` | Půjčovna lyží | Půjčovny a obchody |
| `amenity=ski_school` | Lyžařská škola | Půjčovny a obchody |
| `shop=bicycle` | Cykloprodejna / servis | Půjčovny a obchody |
| `shop=ski` | Lyžařský obchod / servis | Půjčovny a obchody |
| `shop=rental` | Půjčovna | Půjčovny a obchody |
| `shop=sports` | Sportovní obchod | Půjčovny a obchody |
| `shop=outdoor` | Outdoorový obchod | Půjčovny a obchody |

Má‑li objekt víc značek (hotel s půjčovnou kol), rozhoduje pořadí priority: půjčovna kol → půjčovna lyží →
půjčovna → hotel → penzion → horská chata → chata → hostel → motel → apartmán → kemp → infocentrum →
cykloprodejna → lyžařský obchod → lyžařská škola → sportovní obchod → outdoor. Všechny značky zůstávají
v poli `stitky` a jsou v detailu.

Ke každému místu se čtou značky: název (`name`, `name:cs`, `official_name`, `alt_name`, `brand`),
`operator`, telefony (`phone`, `contact:phone`, `mobile`, `contact:mobile`), e-maily (`email`,
`contact:email`), weby (`website`, `contact:website`, `url`, Facebook), adresa (`addr:*`), `opening_hours`,
`description`, `stars`, `rooms` / `beds` / `capacity`, půjčovní značky (`rental`, `service:bicycle:rental`,
`service:bicycle:retail`, `service:bicycle:repair`, `bicycle_rental`, `ski_rental`, `ski`, `sport`).

**Cyklotrasy a MTB trasy** – relace `type=route` s `route=bicycle` (cyklotrasa) nebo `route=mtb` (MTB), včetně
`name`, `ref`, `network`, `distance`, `operator`, `website`, `description`, `from`, `to`. Síť: `icn` =
mezinárodní (EuroVelo), `ncn` = dálková, `rcn` = regionální, `lcn` = místní; 862 tras síť zapsanou nemá.

**Cyklostezky** – cesty `highway=cycleway` s názvem; všechny úseky stejného názvu se spojí do jedné
„cyklostezky“ (proto má 517 cyklostezek dohromady tisíce úseků). Název, který už nese nějaká cyklotrasa, se
podruhé nezakládá.

**Sjezdovky** – cesty `piste:type=downhill` (`name`, `piste:difficulty`, `piste:grooming`, `ref`, `operator`,
`website`, `piste:lit`). Obtížnost: `novice` / `easy` → lehká, `intermediate` → střední, `advanced` / `expert` /
`extreme` → těžká, `freeride` zůstává.

**Vleky a lanovky** – `aerialway` ∈ drag_lift, t-bar, platter, chair_lift, gondola, cable_car, rope_tow,
magic_carpet, j-bar, mixed_lift.

**Plochy skiareálů** – `landuse=winter_sports` (doplňují kontakty a chybějící areály, kap. 4).

## 3. Klasifikace míst

- **Název.** Bere se `name`, jinak `name:cs`, `official_name`, `brand`, nakonec `operator`. Místo bez názvu
  nebo s „názvem“, který je jen evidenční číslo („1“, „č. 12“, „E 5“) či kratší než 3 znaky, dostane
  `bezNazvu = true`. Zůstává v datech, ale zobrazuje se až po
  zapnutí filtru „Zobrazit i místa bez názvu“ (1 480 míst).
- **Adresa** se skládá z `addr:street` (nebo `addr:place`), čísla popisného/orientačního, PSČ a obce;
  **obec** je `addr:city`.
- **Půjčovna podle OSM** (`pujcovna` = ano / ne / neznámo, `pujcovnaDruh` = kola / lyže):
  - `amenity=bicycle_rental` → **ano**, kola; `amenity=ski_rental` → **ano**, lyže;
  - `service:bicycle:rental=yes` nebo `bicycle_rental=yes` → **ano**, kola; `ski_rental=yes` → **ano**, lyže;
  - `rental=*` s hodnotou obsahující *bicycle / bike / ebike / kolo* → kola, *ski / snowboard / lyž / běžk* → lyže;
  - `shop=rental` bez upřesnění → **ano**;
  - `service:bicycle:rental=no` (a žádná lyžařská půjčovna) → **ne**;
  - jinak **neznámo** (`null`). Výsledek k 3. 10. 2026: ano 740 (kola 656, lyže 42), ne 12, neznámo 12 180.

  **Neznámo není ne** – u většiny ubytování OSM půjčovnu prostě neeviduje.
- **Půjčovna podle webu** (`ano?`, v aplikaci „podle webu“) vzniká v kap. 5 a doplňuje jen místa, kde OSM
  nic neříká.

## 4. Geometrie, okresy a okolí

- **Hranice** z RÚIAN se pro kreslení zjednoduší (Douglas–Peucker, tolerance 40 m); pro přiřazování bodů se
  používá plná geometrie. **Praha** v RÚIAN vrstvě okresů není – doplní se z hranice kraje (kód kraje 19) jako
  okres s kódem 3100. Výsledek: 14 krajů, 77 okresů (76 + Praha).
- **Místo → okres**: bod v polygonu okresu. Bod těsně mimo přesné hranice (hraniční tok, nepřesné souřadnice)
  se přiřadí k nejbližšímu okresu do **300 m** podle zjednodušené geometrie. Co nepadne ani tak, zůstane
  v datech bez okresu, log sestavení to hlásí jako „mimo okresy“ a test nad daty neprojde (v aktuálních
  datech žádné takové místo není).
- **Trasa → okresy**: body linie se vzorkují (nejvýš ~60 na linii) a z nich se sestaví seznam okresů a krajů,
  kterými trasa prochází.
- **Zjednodušení linií**: cyklotrasy 25 m, sjezdovky 12 m, polygony areálů 15 m; souřadnice na 5 desetinných
  míst (≈ 1 m). Pro kreslení na úrovni ČR se používá ještě hrubší zjednodušení přímo v prohlížeči.
- **Okolí** (`blizko` u každého místa):
  - **cyklotrasy do 3 000 m** – vzdušná vzdálenost bodu k nejbližšímu úseku linie (mřížkový index úseček);
    ukládají se **3 nejbližší** trasy se vzdáleností v metrech;
  - **skiareály do 15 000 m** – vzdálenost k nejbližší sjezdovce areálu, případně k ploše nebo středu areálu,
    když sjezdovky nejsou zakreslené; ukládají se **2 nejbližší** areály.

  Filtr „u cyklotras do X km“ / „u skiareálů do X km“ pracuje s těmito vzdálenostmi; posuvník má proto strop
  3 km, resp. 15 km. Jde o **vzdálenost vzdušnou čarou k linii**, ne po silnici.
- **Skiareály**: základ je OpenSkiMap (401 areálů v ČR). Plochy `landuse=winter_sports` z OSM se k nim spárují
  (vzdálenost do 1,5 km nebo shodný název) a doplní kontakty; nespárovaná plocha založí nový areál se zdrojem
  `osm`. **Sjezdovky a vleky** se přiřadí areálu, v jehož ploše leží, jinak nejbližšímu do **2,5 km**; bez areálu
  zůstanou samostatné. Stav provozu (`operating`, …) se přebírá z OpenSkiMap a **nefiltruje se** – je uveden
  v detailu.

## 5. Obohacení z webů (`tools/enrich-web.js`)

Projde se každé místo s webem (5 763 míst; stejný web u více míst se stahuje jen jednou):

1. Stáhne se **úvodní stránka** a až **2 podstránky**, jejichž odkaz vypadá kontaktně (*kontakt, contact,
   o nás, about, impressum, provozovatel, půjčovna, rental, služby, services*). Limit 20 s a 1,5 MB na stránku,
   nejvýš 1 požadavek najednou na doménu, celkem 8 souběžně (ve workflow 10). Není‑li odpověď HTML nebo vrátí
   chybu, zapíše se `stav: "chyba"` s důvodem.
2. **E-maily** – vzor e-mailu v textu i `mailto:` odkazech; vyhazují se obrázky (`@2x.png`), zástupné adresy
   (`info@email.cz`, `jmeno@…`, `example.`), technické domény (sentry, wixpress, schema.org) a podobně.
3. **Telefony** – česká a slovenská čísla, normalizovaná na `+420 123 456 789` / `+421 …`; devítimístné číslo
   bez předvolby se bere jako české, začíná‑li 2–7 nebo 9.
4. **IČO** – osmimístné číslo s platným kontrolním součtem (modulo 11) v blízkosti slova IČ/IČO; první platné
   se dohledá v **ARES** (název, právní forma, sídlo).
5. **Provozovatel** – věta „Provozovatel(em) … je / : …“ v textu.
6. **Půjčovna podle webu** – v textu je spojení půjčovna/zapůjčení/rental/verleih/hire s *kolo/bike/e-bike/
   koloběžka* (→ kola) nebo *lyže/ski/snowboard/běžky/skialp* (→ lyže), případně jen obecná zmínka o půjčovně;
   k výsledku se ukládají **ukázky textu**, aby šlo v detailu ověřit, proč tam údaj je.

Výsledek je v `data/enrich.js` pod id místa: `web`, `stav`, `chyba`, `kdy`, `emaily`, `telefony`, `ico`,
`provozovatel`, `ares`, `pujcovna {kola, lyze, obecne, ukazky}`, `stranky`. Běh je obnovitelný (hotová místa
přeskakuje), `--force` je projde znovu.

**Výsledek k 3. 10. 2026:** 5 763 webů · 4 473 načteno (78 %) · 1 290 chyba · e-mail u 3 709 · telefon u 3 939 ·
IČO s ARES u 2 177 · provozovatel z textu u 361 · půjčovna podle webu u 411 (kola 309, lyže 168).

## 6. Efektivní hodnota a stav oslovení

Co aplikace zobrazí v detailu, tabulce a exportu, určuje `lib/stav.js` (`efektivni`) v tomto pořadí přednosti:

1. **ruční zápis** obchodníka (formulář v detailu),
2. **OpenStreetMap** (`telefon`, `email`, `web`, `operator`),
3. **web místa** (první dva e-maily/telefony, provozovatel z ARES nebo z textu).

U **půjčovny**: ruční *ano/ne* → OSM *ano/ne* → web → `ano?` („podle webu“) → neznámo.

**Záznam stavu oslovení** (jeden na místo nebo skiareál, klíč = id objektu):

| Pole | Význam |
|---|---|
| `kontaktovat`, `nabidka`, `volano`, `navsteva` | čtyři zaškrtávátka (true/false) |
| `datumy.<stav>` | kdy bylo zaškrtnuto (ISO čas) |
| `poznamka` | volný text |
| `pujcovna` | ruční přepsání: `ano` / `ne` / prázdné |
| `provozovatel`, `telefon`, `email`, `web` | ruční kontakty |
| `upraveno`, `kdo` | poslední změna a přihlášený uživatel (doplňuje server; z klienta se nepřebírá) |

Ukládání: v prohlížeči (`localStorage`, klíč `csm.stav.v1`) a přes server v `stav.json` (API `GET/PUT /api/stav`,
`GET/PUT /api/stav/:id`; pro skripty `Authorization: Bearer <CSM_TOKEN>`). **Slučování** (lokální × server,
import zálohy): u každého místa vyhraje záznam s novějším `upraveno`; při hromadném importu se `kdo` doplní
jen tam, kde chybí.

**Identifikátory** jsou trvalé: místa a trasy mají id z OSM (`n…` uzel, `w…` cesta, `r…` relace), areály id
z OpenSkiMap (`osk-…`) nebo z OSM. Obnova dat je nemění; zanikne‑li objekt v OSM, jeho záznam ve `stav.json`
zůstane (nezobrazuje se).

## 7. Export CSV

Sloupce v pořadí: Název · Typ · Obec · Adresa · Okres · Kraj · Půjčovna (ano / podle webu / ne / prázdné) ·
Provozovatel · Telefon · E-mail · Web (efektivní hodnoty podle kap. 6) · Nejbližší cyklotrasa · km od trasy ·
Nejbližší skiareál · km od skiareálu · Chceme kontaktovat · Proběhl nabídkový e-mail · Volali jsme · Osobní
návštěva proběhla (každý „ano (datum)“ nebo prázdné) · Poznámka · Upravil · Upraveno · OSM (odkaz) · Zem. šířka ·
Zem. délka. Formát RFC 4180, oddělovač `;`, UTF‑8 s BOM, konce řádků CRLF, desetinná čárka; hodnoty začínající
`=`, `+`, `-`, `@` jsou chráněné proti spuštění jako vzorec v Excelu.

## 8. Obnova dat

- **Automaticky** 1. den v měsíci (3:17 UTC) workflow `.github/workflows/cyklo-ski-mapa-data.yml`:
  `build-data --fetch` → `enrich-web --force` → `npm test` → commit `data/*.js` do hlavní větve → spuštění
  testů a nasazení. **Ručně**: Actions → „Cyklo & Ski mapa – obnova dat“ → Run workflow (volitelně bez průchodu
  webů). **Lokálně**: `npm run build-data` (≈ 1 min nad cache) a `npm run enrich` (≈ 30 min).
- **Testy nad daty** (`test/data-io.test.js`) hlídají: 14 krajů a 77 okresů, přes 10 000 míst, jedinečná id,
  každé místo v existujícím okrese a kraji, souřadnice v obálce ČR, odkazy na existující trasy a areály,
  vzdálenosti v mezích 3 km / 15 km, platné druhy tras a shodu počtů v `meta.js`.
- **Co se mezi obnovami mění**: počty a názvy podle úprav v OSM, nové/zaniklé objekty, výsledky z webů
  (každý měsíc se stahují znovu). **Co se nemění**: stav oslovení (kap. 6).
- `data/meta.js` nese datum sestavení (`vytvoreno`), počty a použité okruhy – aplikace je zobrazuje v patičce.

## 9. Omezení a jak čísla číst

- **Úplnost = OpenStreetMap.** Chybějící penzion není chyba zpracování, ale chybějící zápis v OSM. Nejlepší
  dlouhodobá oprava je doplnit OSM.
- **Kontakt má 44 % míst** (telefon nebo e-mail z OSM či webu); zbytek je třeba dohledat ručně (odkazy v detailu).
- **Údaje z webů jsou odhad**: e-mail může patřit jinému subjektu na sdíleném webu, telefon rezervačnímu
  portálu, „půjčovna podle webu“ může být zmínka o půjčovně v okolí. Ukázky textu v detailu slouží k ověření.
- **Pětina webů se nenačte** (blokování robotů, neexistující domény, jen JavaScript) – u nich jsou jen údaje z OSM.
- **Vzdálenosti jsou vzdušné** k linii trasy / sjezdovce, ne dojezdové.
- **Síť trasy** (místní/regionální/dálková) závisí na zapsaném `network`; u 862 tras chybí.
- **Skiareály zahrnují i neprovozované** – stav je v detailu, nefiltruje se.
- **Historický stav se neuchovává** – data mapy se každý měsíc přepíší; porovnání „co přibylo“ je možné jen
  z historie gitu (`data/*.js` jsou verzované).

## 10. Historie změn metodiky

- **3. 10. 2026** – první sestavení dat (OSM přes QLever, OpenSkiMap, ČÚZK RÚIAN; okolí 3 km / 15 km; průchod
  webů s ARES). Od tohoto data platí vše výše.
