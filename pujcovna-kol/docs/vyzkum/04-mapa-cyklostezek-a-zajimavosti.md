# Podklad: interaktivní mapa cyklostezek a tipy na výlety v okolí půjčovny (šablona pro celou ČR)

Stav ověřen 5. 10. 2026 (dokumentace API, stránky repozitářů, lokální repozitář `cyklo-ski-mapa`). Podklad pro [PLAN.md](../../PLAN.md).

## 1. Mapové knihovny

| Knihovna | ★ / licence | Velikost | Hodí se pro | Poznámka |
|---|---|---|---|---|
| **Leaflet** | 45,7k / BSD‑2 | ~40 kB gz | rastrové podklady, stovky–tisíce linií, nejvíc pluginů | stabilní 1.9.4 (2023), 2.0 zatím jen alpha (ESM, bez IE) |
| **MapLibre GL JS** | 11,8k / BSD‑3 | ~200 kB gz | vektorové dlaždice, 3D terén, hladké otáčení | v benchmarku ICA 2025 „výrazně pomalejší“ pro GeoJSON linie/polygony než Leaflet/OL |
| **OpenLayers** | 12,6k / BSD‑2 | ~600 kB min | 100k+ linií (2× rychlejší než ostatní), WMS/WFS, projekce | těžší API, menší ekosystém pluginů |

Pro okolí jedné půjčovny (desítky až nízké stovky tras v okruhu 30 km) je **Leaflet** nejlevnější volba: už je vendorovaný v repu, běží z disku, funguje s libovolným rastrovým podkladem (Mapy.cz, CyclOSM, Thunderforest) i s PMTiles přes plugin. MapLibre má smysl, jen pokud chcete vlastní vektorový podklad a 3D terén.

Doplňky (ověřeny na GitHubu):
- **Leaflet.markercluster** 4,2k★ MIT – v údržbovém režimu (poslední npm 1.5.3), ale funkční; už v `vendor/`.
- **leaflet-gpx** 619★ BSD‑2 – parsování GPX, vzdálenost, převýšení, značky start/cíl.
- **leaflet-elevation** (Raruto) 282★ **GPL‑3.0** – výškový profil přes d3 v7; pozor na licenci u komerčního webu (distribuce JS = šíření). Bezpečnější je vlastní profil (SVG/Canvas bez knihovny, nebo Chart.js/MIT).
- **togpx** 80★ MIT – GeoJSON → GPX v prohlížeči, stačí pro „Stáhnout GPX“.
- **Turf.js** 10,5k★ MIT, modulární. Většinu ale už pokrývá `lib/geo.js` (haversine, délka, Douglas–Peucker, SegmentGrid).

## 2. Mapové podklady pro ČR

| Zdroj | Zdarma | Cena nad limit | Cyklo/turistická vrstva | Omezení |
|---|---|---|---|---|
| **Mapy.cz REST API** (Seznam) | 250 000 kreditů/měs. (Basic); 1 kredit = 1 dlaždice, 4 kredity = geocode / routing / elevation | 1,60 Kč / 1 000 kreditů | mapset `outdoor` (Turistická mapa Mapy.cz, se značenými trasami), `basic`, `aerial`, `winter`, `names-overlay`; routing `bicycle‑road`, `bicycle‑mountain`, max 15 průjezdních bodů, GeoJSON výstup | komerční použití v Basic **povoleno**; VOP 4.6.2 zakazuje ukládat/cachovat dlaždice i výsledky API; povinné logo + copyright; Extended (10 M kreditů) jen pro bezplatné veřejné projekty **bez kombinace s jinými mapovými daty** → s OSM trasami nad Mapy.cz zůstáváme v Basic |
| **OSM tile.openstreetmap.org** | ano | – | ne (CyclOSM zvlášť) | politika: žádné SLA, komerční weby varovány, že přístup může být odebrán |
| **CyclOSM** (OSM‑FR) | ano | – | ano, nejlepší cyklo‑kartografie | tatáž fair‑use politika OSMF; attribution CyclOSM + OSM |
| **Thunderforest / OpenCycleMap** | Hobby 150 000 dlaždic/měs. | Solo $125/měs. (1,5 M) | OpenCycleMap, Outdoors, Landscape | komerční použití povoleno, cache jen v prohlížeči, attribution |
| **MapTiler Cloud** | 100 000 req., **jen nekomerčně** | Flex $25/měs. | Outdoor, Topo | logo na mapě ve free |
| **Stadia Maps** | 200 000 kreditů, **jen nekomerčně** | Starter $20/měs. | `outdoors` | attribution |
| **Vlastní server** | OpenMapTiles 3,2k★ + tileserver‑gl 2,9k★ (Docker) | VPS | vlastní styl | provoz, aktualizace |
| **PMTiles / Protomaps** | jeden soubor na statickém hostingu, Leaflet i MapLibre plugin; `pmtiles extract` na bbox ČR | jen storage | styly Protomaps (CC0), bez cyklo‑specifik | attribution © OSM |

**Odhad provozu:** malý web půjčovny ≈ 2 000 návštěv/měs. × ~40 dlaždic = 80 000 dlaždic → zdarma u Mapy.cz Basic i Thunderforest Hobby. **Doporučení:** primárně **Mapy.cz `outdoor`** (české, turistické, komerčně OK, zdarma v Basic), jako záložní/vrstvový přepínač **CyclOSM**; při růstu nad limit Thunderforest Solo, nebo PMTiles výřez ČR.

## 3. Data cyklotras ČR

**OpenStreetMap** (ODbL, „© přispěvatelé OpenStreetMap“) je jediný celostátní, otevřený a strojově čitelný zdroj značených tras. Konvence: relace `type=route` + `route=bicycle`, `network=ncn` pro KČT I.–III. třídu (1–3místná čísla), `rcn` pro IV. třídu (4místná), `lcn` místní; `operator=cz:KČT`; `route=mtb` + `mtb:scale`; EuroVelo `icn`. Cyklostezka = fyzická cesta `highway=cycleway`, nikoli trasa. V repu 862 tras nemá `network` – fallback podle počtu číslic v `ref`.

Ukázkový **Overpass** dotaz (okruh 25 km kolem bodu):

```
[out:json][timeout:90];
rel["type"="route"]["route"~"^(bicycle|mtb)$"](around:25000,49.195,16.608);
out tags;
>; out geom;
```

Fair‑use overpass‑api.de: <10 000 dotazů a <1 GB/den pro celou komunitu; komerční provoz → vlastní instance. Proto **dotazovat při sestavení (měsíčně), ne za návštěvníka** – což repo už dělá (QLever místo Overpassu). Alternativa: **Waymarked Trails** – overlay dlaždice a API, kód GPLv3, bez publikované politiky použití → bez SLA.

**Ostatní zdroje (ověřeno):**
- **ČÚZK Data50 / Data200** – CC BY 4.0, ale katalog vrstev (4/2026) **cyklotrasy neobsahuje**; hodí se pro POI (Hrad, Zámek, Zřícenina, Rozhledna) a DMR 5G pro výškopis.
- **NKOD (data.gov.cz)**: Středočeský kraj „Cyklistické stezky a trasy“ (CC BY 4.0), **Jihomoravský kraj „Cyklotrasy“ (GeoJSON, CC BY 4.0)**, Vysočina přes Geoportál. Pokrytí krajově nerovnoměrné → jen křížová kontrola.
- **KČT** – garant číslování, bez otevřeného stažení; **Cykloserver** – komerční, bez API; **NaKole.cz** – „užití jen se svolením“.

**Aktualizace:** měsíční build (jak je v repu) stačí.

**Délka a převýšení:** délka = haversine (`geo.lineLengthKm`). Výšky doplnit při buildu vzorkováním každých ~50 m:
- **Mapy.cz Elevation** – 4 kredity / až 256 bodů, model doplněný lidarem (nejpřesnější pro ČR; 100 tras × 400 bodů ≈ 800 kreditů).
- **Open‑Meteo** – GLO‑90, zdarma jen nekomerčně.
- **Open‑Elevation** – veřejné API prakticky jen self‑host (GPL‑2, Docker).
Převýšení počítat po vyhlazení (medián 3–5 bodů) a s prahem ~5 m.

## 4. Zajímavosti v okolí (POI)

| Zdroj | Co dá | Licence / podmínky |
|---|---|---|
| **OSM** `tourism=attraction|viewpoint|museum|castle`, `historic=castle|ruins|monument`, `natural=peak`, tag `wikidata`/`wikipedia` | poloha, název, web, otevírací doba | ODbL, attribution |
| **Wikidata SPARQL** `SERVICE wikibase:around` + `wdt:P18` (obrázek), `wdt:P31` (typ) | typ, obrázek, sitelink cs | data CC0 |
| **cs.wikipedia geosearch** `generator=geosearch&ggscoord=lat|lon&ggsradius=10000&prop=coordinates|pageimages|extracts` | perex, náhled | text CC BY‑SA 4.0 (uvést zdroj) |
| **Commons imageinfo** `iiprop=extmetadata|url` → `LicenseShortName`, `Artist` | licence obrázku | brát jen CC0 / CC BY / CC BY‑SA, uložit autora |
| **ČÚZK Data50** body Hrad/Zámek/Zřícenina/Rozhledna | doplněk | CC BY 4.0 |
| **Kudy z nudy API** | JSON: název, URL, obrázek, GPS | **jen smluvní partneři CzechTourism**, 1 volání/hod.; licence obsahu neuvedena → ověřit smlouvou |
| **Mapy.cz geocode** `type=poi` | hledání konkrétního místa | 4 kredity; výsledky se nesmí ukládat |
| **Google Places** | bohatá data | $32 / 1 000; **uložit lze jen place_id** → nevhodné pro statický seznam |

**Automatický postup „20 tipů“ (při buildu, licenčně čistý):** adresa půjčovny → geocode → OSM POI v okruhu 25 km → deduplikace přes tag `wikidata` → Wikidata (P18, typ, cs sitelink) → cs.wikipedia extract → Commons licence filtr → skóre (má Wikipedii + typ + vzdálenost + blízkost k trase z `SegmentGrid`) → top 20 → JSON s polem `zdroj` a `licence` u každé položky; ruční override v konfiguraci půjčovny.

## 5. Open‑source inspirace (GitHub)

| Projekt | ★ / licence | Převzít |
|---|---|---|
| **abrensch/brouter** | 724 / MIT | cyklo‑router s výškami; **roundtrip** okruhy; Docker 128 MB RAM |
| **nrenner/brouter-web** | 501 / MIT | Leaflet klient: profily, výškový profil, GPX export – vzor UI |
| **graphhopper/graphhopper** | 6,7k / Apache‑2 | `round_trip` algoritmus; Java, CZ extrakt z Geofabrik |
| **valhalla/valhalla** | 6,3k / MIT | `bicycle_type`, `use_hills`, `avoid_bad_surfaces` |
| **GIScience/openrouteservice** | 2k / GPL‑3 | veřejné API 2 000 directions/den |
| **gpxstudio/gpx.studio** | 1,2k / MIT | TS knihovna pro GPX |
| **Raruto/leaflet-elevation** | 282 / GPL‑3 | profil, sklon; licence! |
| **mpetazzoni/leaflet-gpx** | 619 / BSD‑2 | statistiky GPX |
| **protomaps/PMTiles + basemaps** | BSD‑3 | statický podklad bez serveru |

Plánovač okruhů „z půjčovny a zpět“: nejlevněji **BRouter v Dockeru** (MIT) nebo předpočítané okruhy při buildu.

## 6. Existující repozitář `cyklo-ski-mapa`

- **Data:** OSM přes QLever SPARQL (`tools/lib/sources.js`: relace `route=bicycle|mtb`, `highway=cycleway` s názvem, ubytování, půjčovny, infocentra), OpenSkiMap, RÚIAN hranice; měsíční GitHub workflow. Stav k 3. 10. 2026: 4 280 tras (3 344 cyklo, 419 MTB, 517 cyklostezek), 12 932 míst.
- **Formát:** `data/trasy.js` → `window.CSM_DATA.trasy = [{id "r…", druh, nazev, ref, sit (icn/ncn/rcn/lcn), delkaKm, operator, web, popis, osm, label, okresy, kraje, bbox, geom [[lat,lon]…] (DP 25 m), body}]` – 13 MB; `mista.js` 7 MB s `blizko.trasy`.
- **Mapa:** Leaflet 1.9.4 + markercluster vendorované; podklady OSM / CyclOSM / OpenTopoMap (bez SLA); `app.js` (1 459 ř.).
- **Přímo znovu použitelné:** celá datová pipeline (`build-data.js` + `sources.js`), `lib/geo.js` (`haversineM`, `lineLengthKm`, `simplify`, `SegmentGrid.within`, `bboxOf`), styly tras podle sítě. Pro šablonu stačí nový krok: geocode adresy → `SegmentGrid.within(center, R)` nebo průnik `bbox` → **per‑půjčovna výřez** (řádově stovky kB místo 20 MB).
- **Chybí:** výškový profil (geom bez z), GPX export (togpx nad `geom`), POI zajímavosti (přidat `tourism=attraction|viewpoint|museum|castle`, `historic=*`, `natural=peak` + `wikidata`), obrázky s licencí, plánovač okruhů, produkční podklad s podmínkami, mobilní UX pro zákazníka místo CRM panelu.

## 7. Doporučená kombinace (nízké náklady, licenčně čisté)

**Leaflet 1.9.4 (vendor) + Mapy.cz `outdoor` tiles (Basic, 250k kreditů, logo) s přepínačem CyclOSM + trasy z OSM (QLever/Overpass při měsíčním buildu, výřez 25–30 km od geokódované adresy, převýšení z Mapy.cz Elevation) + POI z OSM × Wikidata × cs.wikipedia s obrázky z Commons (jen CC0/CC BY/CC BY‑SA, uložená attribution) + GPX přes togpx + volitelné okruhy z BRouter v Dockeru.** Měsíční náklad pro jednu i deset půjčoven: 0 Kč (vše v bezplatných limitech), jediná závislost s podmínkami je klíč Mapy.cz na doménu. Kudy z nudy a Google Places jen jako odkazy „více na…“, ne jako uložená data.

## Zdroje

- https://developer.mapy.com/pricing/ · https://developer.mapy.com/terms-and-conditions/ · https://developer.mapy.com/rest-api-mapy-cz/function/map-tiles/ · https://developer.mapy.com/rest-api-mapy-cz/function/routing/ · https://developer.mapy.com/rest-api-mapy-cz/function/elevation-api/ · https://developer.mapy.com/rest-api-mapy-cz/function/geocoding/
- https://operations.osmfoundation.org/policies/tiles/ · https://www.cyclosm.org/ · https://github.com/cyclosm/cyclosm-cartocss-style
- https://www.thunderforest.com/pricing/ · https://www.thunderforest.com/terms/ · https://www.maptiler.com/cloud/pricing/ · https://stadiamaps.com/pricing/
- https://github.com/openmaptiles/openmaptiles · https://github.com/maptiler/tileserver-gl · https://github.com/protomaps/PMTiles · https://github.com/protomaps/basemaps
- https://ica-abs.copernicus.org/articles/10/14/2025/ica-abs-10-14-2025.pdf · https://github.com/Leaflet/Leaflet · https://github.com/maplibre/maplibre-gl-js · https://github.com/openlayers/openlayers
- https://github.com/Leaflet/Leaflet.markercluster · https://github.com/mpetazzoni/leaflet-gpx · https://github.com/Raruto/leaflet-elevation · https://github.com/tyrasd/togpx · https://github.com/Turfjs/turf
- https://wiki.openstreetmap.org/wiki/Overpass_API · https://wiki.openstreetmap.org/wiki/Cs:Cyklotrasy_v_ČR · https://waymarkedtrails.org/ · https://github.com/waymarkedtrails/waymarkedtrails-backend
- https://ags.cuzk.gov.cz/opendata/ · https://geoportal.cuzk.cz/Dokumenty/Data50_katalog_SHP.pdf · https://data.gov.cz/datové-sady?dotaz=cyklotrasy · https://data.jmk.cz/ · https://gis.kr-vysocina.cz/
- https://open-meteo.com/en/docs/elevation-api · https://open-elevation.com/ · https://github.com/Jorl17/open-elevation
- https://en.wikibooks.org/wiki/SPARQL/SERVICE_-_around_and_box · https://www.mediawiki.org/wiki/API:Geosearch · https://www.mediawiki.org/wiki/API:Imageinfo
- https://www.kudyznudy.cz/faq-casto-kladene-otazky/api · https://github.com/CzechTourism/kzn-content-api
- https://developers.google.com/maps/billing-and-pricing/pricing · https://cloud.google.com/maps-platform/terms/maps-service-terms
- https://github.com/abrensch/brouter · https://github.com/nrenner/brouter-web · https://github.com/graphhopper/graphhopper · https://github.com/valhalla/valhalla · https://github.com/GIScience/openrouteservice · https://github.com/gpxstudio/gpx.studio
- Lokálně: `cyklo-ski-mapa/README.md`, `docs/METODIKA.md`, `tools/build-data.js`, `tools/lib/sources.js`, `lib/geo.js`, `app.js`, `data/meta.js`
