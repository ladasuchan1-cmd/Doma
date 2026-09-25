# Cenotvorba – repricingový nástroj

Vlastní nástroj pro **dynamickou cenotvorbu** (obdoba Disiva) postavený na tom, že **máte vlastní validní data o konkurenci**.
Ceny konkurence do něj pošlete přes API nebo soubor (JSON, XML, CSV, XLSX), produkty si rozdělíte do segmentů podle
vlastních metrik, pro každý segment nastavíte, jak se má cena chovat vůči trhu, a nové ceny si váš **admin** (frontend nad
POHODOU) stáhne jako XML/JSON/CSV feed, dostane je webhookem, nebo je naimportujete přímo do **POHODY** (XML dataPack).

```
 ceny konkurence ──┐   API / soubor / URL (JSON · XML · CSV · XLSX)
 náš katalog ──────┤   (POHODA export, admin, Excel)
                   ▼
            ┌──────────────┐   segmenty dle vašich metrik (výrobce, N-kategorie, marže, sklad, pozice na trhu, …)
            │  Cenotvorba  │── strategie (podlézt nejnižší o 1 %, držet 2. místo, medián −2 %, MOC, doprodej, …)
            └──────────────┘   limity (min. marže, MOC strop, max. změna), zaokrouhlení (…9 / …90 / …990)
                   │  návrhy cen → schválení (ručně / automaticky)
                   ▼
   admin ◀── feed XML/JSON/CSV (pull + potvrzení) · webhook (push) · API
   POHODA ◀── XML dataPack (stk:sellingPrice payVAT="true" / cenová hladina)
```

## Spuštění

Potřebujete jen **Node.js 22.13+** (žádné `npm install`, žádná databáze navíc – data jsou v jednom souboru SQLite).

```bash
cd repricing
npm run demo        # volitelně: naplní ./data/cenotvorba.db ukázkovým katalogem cyklo-obchodu a cenami konkurence
npm start           # http://localhost:8080
```

Při prvním spuštění se vygeneruje heslo do administrace a vypíše se do konzole (nebo ho nastavte proměnnou
`CENOTVORBA_PASSWORD`). Docker: `docker build -t cenotvorba . && docker run -p 8080:8080 -v cenotvorba:/data -e CENOTVORBA_PASSWORD=… cenotvorba`.

| Proměnná | Význam | Výchozí |
|---|---|---|
| `PORT` | port HTTP serveru | `8080` |
| `CENOTVORBA_DB` | cesta k souboru databáze | `./data/cenotvorba.db` |
| `CENOTVORBA_PASSWORD` | heslo do administrace | vygeneruje se |
| `CENOTVORBA_SECRET` | tajemství pro podpis session cookie | vygeneruje se |
| `CENOTVORBA_SCHEDULER` | `0` vypne plánovač (stahování zdrojů, automatické přecenění) | zapnuto |
| `CENOTVORBA_TRUST_PROXY` | `1` za reverzní proxy (HTTPS, X-Forwarded-*) | vypnuto |

Server patří do vnitřní sítě nebo za HTTPS reverzní proxy (nginx, Caddy).

## Jak to funguje

1. **Import katalogu** – kód (POHODA „Kód“ = klíč pro export), EAN, název, výrobce, kategorie, nákupní cena (bez DPH),
   prodejní cena (s DPH), DPH, MOC, sklad, prodeje. **Každý další sloupec** (N-kategorie, sezóna, imprese z Disiva, ABC…)
   se uloží jako vlastní atribut a dá se podle něj segmentovat.
2. **Import konkurence** – řádek = produkt × konkurent: identifikace (náš kód / EAN / kód výrobce), konkurent, cena s DPH,
   doprava, dostupnost, URL, čas zjištění. Párování: kód → EAN → MPN → ruční párování. Nespárované nabídky najdete
   v záložce Konkurence a spárujete je ručně (párování se zapamatuje).
3. **Segmenty** – filtry nad jakýmikoli poli a metrikami (výrobce ∈ {…}, N ∈ {N7, N8}, marže < 15 %, jsme nejdražší,
   počet konkurentů ≥ 2, dny zásoby > 90, …), skupiny A/NEBO, živý náhled.
4. **Strategie** – seřazené podle priority; produkt dostane první strategii, jejíž segment (a volitelné podmínky a časové okno)
   sedí. Když strategii chybí báze (žádná konkurence, chybí MOC či nákupní cena), produkt **propadne na další strategii**.
   - cíl: podlézt nejnižší cenu (o Kč / %), dorovnat nejnižší, **N-tá pozice**, průměr / medián trhu ± %, vůči vybranému
     konkurentovi, vůči MOC, nákup + přirážka, pevná cena, ponechat, **doprodej** (postupné snižování, dokud se neprodává);
   - konkurence: jen vybraní / bez vybraných, podle štítků, jen skladem, s dopravou, max. stáří dat, vyřazení podezřele
     nízkých cen (outlierů), vyřazení bazarových nabídek podle klíčových slov, minimální počet konkurentů;
   - limity: **minimální marže** a zisk v Kč (spodní hranice vždy vyhrává), strop MOC, max. marže, max. snížení/zvýšení
     za jedno přecenění, jen zvyšovat / jen snižovat, ignorovat drobné změny, ruční min./max. cena produktu;
   - zaokrouhlení podle cenových pásem (…9 / …90 / …990), dolů / nahoru / nejbližší;
   - schvalování: ručně, nebo automaticky do zvolené velikosti změny (rizikové změny jdou vždy k ručnímu schválení).
5. **Přecenění** – ručně, přes API nebo plánovaně. Vznikne dávka **návrhů** s vysvětlením krok za krokem
   („nejnižší cena trhu 12 490 Kč (VeloMarket.cz) → −1 % → 12 365 Kč → min. marže 12 % → 12 800 Kč → zaokrouhleno 12 890 Kč“).
6. **Schválení a export** – schválené změny si admin stáhne (feed + potvrzení), nebo je dostane webhookem; pro POHODU je
   připraven XML dataPack. Po exportu se zapíše historie cen (včetně nejnižší ceny za 30 dní pro slevové akce).

## Posílání dat přes API

Token vytvoříte v **Nastavení → API tokeny** (oprávnění `import`, `export`, `read`, `admin`).

```bash
# ceny konkurence – JSON (pole nebo {items: [...]})
curl -X POST "http://server:8080/api/v1/import/offers" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data '[{"ean":"8591234567890","competitor":"VeloMarket.cz","price":12490,"in_stock":true,"shipping":0}]'

# libovolný XML/CSV/XLSX soubor s uloženým mapováním zdroje č. 3
curl -X POST "http://server:8080/api/v1/import/offers?source=3" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/xml" --data-binary @konkurence.xml

# katalog z POHODY / adminu, produkty, které v souboru chybí, se deaktivují
curl -X POST "http://server:8080/api/v1/import/products?deactivate_missing=1" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/csv" --data-binary @katalog.csv

# spustit přecenění
curl -X POST "http://server:8080/api/v1/runs" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{}'
```

Parametr `replace=competitors` zajistí, že nabídky konkurentů, kteří v dávce jsou, ale produkt v ní chybí, se smažou
(plný snapshot). `dry_run=1` jen ověří mapování.

## Napojení adminu

| Způsob | Endpoint |
|---|---|
| Feed schválených změn (pull) | `GET /feed/changes.xml?token=…` (také `.json`, `.csv`) – po zpracování potvrďte `POST /api/v1/export/ack` s `{"codes": [...]}` nebo použijte `?mark=1` |
| Kompletní ceník (idempotentní) | `GET /feed/prices.xml?token=…` – všechny aktivní produkty s aktuální / schválenou cenou |
| Webhook (push) | Nastavení → Export → URL webhooku; po přecenění se schválené změny odešlou jako JSON/XML `POST` |
| POHODA | `GET /api/v1/export/pohoda.xml?mark=1` → XML dataPack (Windows-1250) pro XML import nebo mServer, viz [docs/POHODA.md](docs/POHODA.md) |
| Excel | `GET /api/v1/export/proposals.xlsx` – návrhy k revizi |

Výchozí XML feed:

```xml
<prices generated="2026-09-25T08:00:00.000Z" count="1" currency="CZK">
  <item>
    <code>CAN-00154-M</code><ean>8591234567890</ean><name>Cannondale Topstone 2026 vel. M</name>
    <price>52990</price><old_price>54990</old_price><vat_rate>21</vat_rate><currency>CZK</currency>
    <changed_at>2026-09-25T07:58:12.000Z</changed_at>
  </item>
</prices>
```

Názvy elementů a sada polí jdou upravit v Nastavení → Export (např. `lowest_30d`, `strategy`, `segment`).

## Vývoj

```bash
npm test            # všechny testy (node:test)
npm run dev         # server s automatickým restartem
node tools/demo-data.js --files examples/   # vygeneruje ukázkové vstupní soubory
```

Architektura a kontrakty modulů: [docs/SPEC.md](docs/SPEC.md).
