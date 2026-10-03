# Cyklo & Ski mapa – kontakty v okolí cyklotras a sjezdovek

Obchodní nástroj: **interaktivní mapa ČR (kraje → okresy)** se všemi značenými **cyklotrasami, pojmenovanými
cyklostezkami a MTB trasami**, **skiareály a sjezdovkami**, a k nim **místa v okolí** – penziony, hotely, chaty, kempy,
půjčovny kol a lyží, cykloprodejny, sportovní obchody a infocentra. U každého místa je vidět **název, adresa,
provozovatel, telefon, e-mail, web** a zda **provozuje půjčovnu**, a dá se k němu vést **stav oslovení**:

- ☐ Chceme kontaktovat
- ☐ Proběhl nabídkový e-mail
- ☐ Volali jsme
- ☐ Osobní návštěva proběhla

plus poznámka a ručně doplněné kontakty (ty mají přednost před automaticky zjištěnými).

```
 OpenStreetMap (QLever SPARQL) ──┐  cyklotrasy, cyklostezky, sjezdovky, vleky, ubytování, půjčovny, infocentra
 OpenSkiMap ─────────────────────┤  skiareály (název, web, statistiky sjezdovek a vleků)
 ČÚZK RÚIAN ─────────────────────┤  hranice krajů a okresů
                                 ▼
                      tools/build-data.js  →  data/*.js   (přiřazení do okresů, nejbližší trasy/areály)
                      tools/enrich-web.js  →  data/enrich.js  (e-maily, telefony, IČO → ARES, zmínky o půjčovně z webů)
                                 ▼
                      index.html + app.js  (Leaflet; funguje i přímo z disku)   ·   server.js (sdílený stav pro tým)
```

## Spuštění

Nejjednodušší: otevřít `index.html` v prohlížeči (Chrome, Edge, Firefox). Data jsou ve složce `data/`, knihovny ve
`vendor/`, internet je potřeba jen na mapové podklady. Stav oslovení se ukládá do úložiště prohlížeče (localStorage)
– zálohu nebo přenos jinam uděláte tlačítkem **Stav oslovení** (JSON soubor, při načtení se záznamy sloučí).

Pro **sdílení stavu v týmu** spusťte malý server (Node.js 22+, žádné závislosti):

```bash
cd cyklo-ski-mapa
npm start                 # http://localhost:8090 – stav oslovení v data/stav.json
```

Aplikace otevřená přes server pozná API, sloučí lokální a serverový stav a každou změnu posílá na server; ostatní
ji uvidí po obnovení stránky. Proměnné: `PORT`, `CSM_STAV` (cesta k souboru se stavem), `CSM_TOKEN` (volitelný
Bearer token pro externí skripty).

## Ovládání

| Co | Jak |
|---|---|
| Kraj → okres | klik na kraj v mapě (nebo výběr v liště nahoře), pak klik na okres; zpět drobečkovou navigací |
| Vrstvy | vlevo: cyklotrasy / cyklostezky / MTB, skiareály, skupiny míst a jejich typy (s počty ve výběru) |
| Jen místa v okolí | přepínač „u cyklotras“ (do 0,25–3 km) nebo „u skiareálů“ (do 1–15 km) s posuvníkem |
| Půjčovna | filtr ano (včetně „podle webu“) / ne / neznámo |
| Stav oslovení | filtr bez stavu / s jakýmkoli stavem / konkrétní stav / „chceme kontaktovat, zatím neosloveno“ |
| Hledání | pole nahoře (název, obec, adresa, provozovatel, trasa, areál); klávesa `/` |
| Detail místa | klik na značku nebo řádek: kontakty, nejbližší trasy a areály, údaje z webu, odkazy Google / Firmy.cz / Mapy.cz / ARES, formulář stavu |
| Detail trasy / areálu | seznam míst do 3 km od trasy, resp. do zvoleného okruhu od areálu; u areálu lze vést stav oslovení provozovatele |
| Tabulka | tlačítko **Tabulka**: řazení kliknutím na záhlaví, zaškrtávátka stavů se rovnou ukládají |
| Export | **Export CSV** (aktuální výběr, oddělovač `;`, UTF‑8 s BOM – otevře Excel), v dialogu stavu i export všech záznamů |
| Odkaz | adresa stránky nese kraj/okres/vybraný objekt (`#kraj=35&okres=3302&misto=n123`) – dá se poslat kolegovi |

Na úrovni ČR se značky míst nekreslí (překrývaly by kraje); zapnout je lze ve filtrech. Zobrazené trasy na úrovni ČR
jsou jen dálkové (EuroVelo, národní) a cyklostezky – vše ostatní od úrovně kraje.

## Odkud jsou data a jak se obnovují

| Zdroj | Co | Licence |
|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/copyright) přes [QLever osm-planet](https://qlever.dev/osm-planet) | relace `route=bicycle` / `route=mtb`, pojmenované `highway=cycleway`, `piste:type=downhill`, vleky `aerialway=*`, `landuse=winter_sports`, `tourism=hotel|guest_house|chalet|hostel|motel|apartment|alpine_hut|camp_site`, `tourism=information` + `information=office|visitor_centre`, `shop=bicycle|ski|sports|outdoor|rental`, `amenity=bicycle_rental|ski_rental|ski_school` včetně kontaktů (`phone`, `email`, `website`, `operator`, `service:bicycle:rental`, `rental`…) | ODbL |
| [OpenSkiMap](https://openskimap.org/) | skiareály v ČR (název, stav, weby, počty a délky sjezdovek podle obtížnosti, vleky) | ODbL / CC-BY |
| [ČÚZK RÚIAN](https://ags.cuzk.cz/arcgis/rest/services/RUIAN/MapServer) | hranice krajů (VÚSC) a okresů, generalizované; Praha doplněna jako okres z geometrie kraje | CC BY 4.0 |
| weby míst + [ARES](https://ares.gov.cz/) | e-maily, telefony, IČO → oficiální název firmy, zmínky o půjčovně kol/lyží | – |

```bash
npm run build-data            # stáhne zdroje do cache/ (≈80 MB) a přegeneruje data/*.js (≈1 min)
node tools/build-data.js --fetch     # vynutí nové stažení
npm run enrich                # projde weby míst (≈5 800 webů, ~30 min, obnovitelné – hotové přeskakuje)
node tools/enrich-web.js --skupina pujcovna --limit 200   # jen půjčovny/obchody, prvních 200
```

Při sestavení se každé místo přiřadí do okresu (bod v polygonu), spočítají se **nejbližší cyklotrasy do 3 km**
a **skiareály do 15 km** (vzdálenost k linii trasy / sjezdovky) a sjezdovky a vleky se přiřadí k areálům.
Místa bez názvu (včetně „názvů“ typu evidenční číslo chaty) jsou v datech, ale zobrazují se jen po zapnutí filtru.

Údaje z webu jsou **automatický odhad** – e-maily a telefony z kontaktních stránek, IČO ověřené kontrolním součtem
a dohledané v ARES, „půjčovna podle webu“ znamená, že web půjčovnu kol nebo lyží zmiňuje. V detailu jde jedním
tlačítkem převzít do ručních kontaktů (doplní jen prázdná pole).

## Struktura

```
index.html, app.js, styles.css   aplikace (bez buildu, běžné skripty – funguje z file://)
lib/geo.js                       WKT, zjednodušení linií, bod v polygonu, vzdálenosti, mřížkový index úseček
lib/csv.js                       CSV parser/serializace (RFC 4180, Excel)
lib/contacts.js                  e-maily, telefony, IČO, provozovatel, zmínky o půjčovně z HTML
lib/stav.js                      model stavu oslovení (sloučení, import/export, efektivní kontakt)
tools/build-data.js              sestavení dat (tools/lib/sources.js = dotazy a URL zdrojů, tools/lib/data-io.js = formát data/*.js)
tools/enrich-web.js              obohacení z webů + ARES
server.js                        statický server + API /api/stav (sdílený stav v data/stav.json)
data/                            vygenerovaná data (hranice, mista, trasy, ski, enrich, meta)
vendor/                          Leaflet 1.9.4, Leaflet.markercluster 1.5.3
test/                            node --test
```

```bash
npm test                      # jednotkové testy knihoven, serveru a konzistence dat
```

## Omezení

- Úplnost a aktuálnost odpovídá OpenStreetMap – u míst bez kontaktů v OSM pomůže projití webu (`npm run enrich`)
  nebo odkazy v detailu. Zhruba pětina webů se automaticky načíst nedá (blokují roboty, neexistují).
- „Půjčovna“ u ubytování je známá jen tam, kde to OSM nebo web uvádí; jinak je stav „neznámo“ a dá se zadat ručně.
- Statická varianta (file://) ukládá stav jen v daném prohlížeči – pro tým použijte `npm start` nebo pravidelně
  sdílejte zálohu JSON.
