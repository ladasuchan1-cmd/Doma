# Napojení adminu na Cenotvorbu – integrační příručka

Tento dokument je pro vývojáře adminu (frontend nad POHODOU), který má z Cenotvorby přebírat **schválené nové ceny**.
Popisuje ověření, doporučený tok „stáhnout → nasadit → potvrdit“, formáty feedu (JSON / XML / CSV), webhook, potvrzení
převzetí, chybové odpovědi a obnovu po výpadku. Na konci je referenční klient v `curl` a v Node.js.

Všechny ceny jsou **s DPH v Kč** (pokud nenastavíte jinou měnu), čísla v JSON a XML s desetinnou **tečkou**, časy
v ISO-8601 UTC (`2026-09-26T05:28:11.598Z`). Adresa serveru je v příkladech `https://cenotvorba.firma.cz`.

## Obsah

1. [Ověření a API tokeny](#1-ověření-a-api-tokeny)
2. [Doporučený tok](#2-doporučený-tok)
3. [Feed změn cen](#3-feed-změn-cen) – JSON, XML, CSV, hlavičky
4. [Potvrzení převzetí (ack)](#4-potvrzení-převzetí-ack)
5. [Kompletní ceník – resynchronizace](#5-kompletní-ceník--resynchronizace)
6. [Označení při stažení (`mark=1`) a znovustažení exportu](#6-označení-při-stažení-mark1-a-znovustažení-exportu)
7. [Webhook (push)](#7-webhook-push)
8. [Chyby](#8-chyby)
9. [Idempotence a doporučení](#9-idempotence-a-doporučení)
10. [Referenční klient](#10-referenční-klient)

---------------------------------------------------------------------------------------------------------

## 1. Ověření a API tokeny

Token vytvoří správce v **Nastavení → API tokeny** (nebo `POST /api/v1/tokens` s `{"name": "admin-eshop", "scopes": ["export"]}`).
Token má tvar `ct_` + 32 znaků, zobrazí se **jen jednou** (v databázi je uložen jen jeho otisk SHA-256) a lze ho kdykoli zrušit.

| Rozsah (scope) | Co dovolí |
|---|---|
| `read` | čtení: produkty, návrhy, přehled, log exportů (`GET /api/v1/exports`), XLSX s návrhy |
| `import` | posílání dat: `POST /api/v1/import/products`, `POST /api/v1/import/offers` |
| `export` | **feedy a export cen**: `/feed/*`, `/api/v1/export/*`, `POST /api/v1/export/ack`, `POST /api/v1/export/push`, znovustažení exportu |
| `admin` | vše (včetně nastavení, tokenů, schvalování) |

Pro admin stačí token s rozsahem **`export`** (chcete-li číst i log exportů, přidejte `read`). Token předejte jedním ze způsobů:

```
Authorization: Bearer ct_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX     (doporučeno)
X-Api-Key: ct_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
GET /feed/changes.json?token=ct_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX   (jen pro feedy – URL se loguje, raději hlavička)
```

Akce provedené tokenem se v auditu a u návrhů zapisují jako `token:<název tokenu>` – pojmenujte token podle systému
(`admin-eshop`, `pohoda-mserver`). Lidé v UI se přihlašují společným heslem; volitelné jméno při přihlášení
(`POST /api/v1/auth/login {"password": "…", "name": "Jana"}`) je **jen označení** pro audit a sloupec „rozhodl“ u návrhů,
ne ověření identity – kdo zná heslo, může zadat libovolné jméno.

## 2. Doporučený tok

```
 admin                                              Cenotvorba
   │  1. GET /feed/changes.json   (token export)        │
   │ ─────────────────────────────────────────────────▶ │  schválené, dosud neexportované změny
   │ ◀───────────────────────────────────────────────── │  {count, items: [{proposal_id, code, price, …}]}
   │                                                    │
   │  2. nasadit ceny (admin / POHODA)                  │
   │                                                    │
   │  3. POST /api/v1/export/ack                        │
   │     {"items": [{"proposal_id": 97, "price": 114990}, …]}
   │ ─────────────────────────────────────────────────▶ │  návrhy → „exportováno“, products.price := převzatá cena,
   │ ◀───────────────────────────────────────────────── │  historie cen; {export_id, count, mismatched, …}
   │  4. zkontrolovat mismatched / unknown_codes        │
```

- Krok 1 je **bezpečné opakovat** – feed nic neoznačuje a dokud změny nepotvrdíte, vrací je znovu (plus případné nově
  schválené). Cenotvorba si jen zapamatuje, co a za kolik vydala (kvůli potvrzení podle kódu).
- Potvrzujte **cenu, kterou jste skutečně nasadili** (`items` s `price`). Změnil-li mezitím někdo návrh (ruční cena),
  potvrzení s jinou cenou nic neoznačí a vrátí položku v `mismatched` – novou cenu dostanete v dalším stažení.
- Potvrzujte jen úspěšně nasazené položky. Co nepotvrdíte, přijde znovu.
- Doporučený interval: stahovat po každém přecenění nebo pravidelně (např. každých 5–15 minut). Nastavte časový limit
  HTTP klienta alespoň **30 s** (při velkém importu server chvíli neodpovídá, požadavek ale nezahodí).

## 3. Feed změn cen

```
GET /feed/changes.json | .xml | .csv          (token v hlavičce nebo ?token=, rozsah export)
GET /api/v1/export/changes.json | .xml | .csv (totéž pod /api/v1 – odpověď jako příloha)
```

Obsah: pro každý **aktivní** produkt nejnovější **schválený a dosud neexportovaný** návrh. Návrh, který těsně před
exportem neprojde kontrolou (produkt je zamčený, cena produktu se od výpočtu změnila, cena je pod ruční minimální / nad
maximální cenou nebo pod nákupní cenou), se **zadrží** – ve feedu není a počet je v hlavičce `X-Export-Held`.
Nic ke stažení → `200` s `count: 0` a prázdným seznamem.

Hlavičky odpovědi:

| Hlavička | Význam |
|---|---|
| `X-Export-Count` | počet položek v těle |
| `X-Export-Held` | počet zadržených schválených návrhů (nejsou v těle) |
| `X-Export-Id` | jen s `mark=1` a jen když se něco označilo – id exportu (viz kapitola 6) |

### Pole položky

| Pole | Typ | Význam |
|---|---|---|
| `proposal_id` | číslo | id návrhu – **klíč pro potvrzení a pro deduplikaci** |
| `product_id` | číslo | interní id produktu v Cenotvorbě |
| `code` | text | náš kód (POHODA „Kód“) – podle něj cenu nasaďte |
| `ean` | text / null | EAN |
| `name`, `manufacturer` | text / null | název, výrobce (pro kontrolu) |
| `price` | číslo | **nová prodejní cena s DPH** (ruční cena má přednost před navrženou) |
| `old_price` | číslo / null | cena, ze které návrh vycházel |
| `change_pct` | číslo / null | změna v % (2 desetinná místa) |
| `vat_rate` | číslo | sazba DPH % |
| `currency` | text | měna (`CZK`) |
| `changed_at` | ISO čas | kdy byl návrh schválen |
| `strategy`, `segment` | text / null | strategie a segment, které cenu navrhly |
| `lowest_30d` | číslo / null | nejnižší naše cena za posledních 30 dní (Omnibus / §12a – při inzerci slevy) |

### JSON

```http
GET /feed/changes.json HTTP/1.1
Authorization: Bearer ct_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Export-Count: 2
X-Export-Held: 0
```

```json
{
  "generated": "2026-09-26T05:28:11.606Z",
  "count": 2,
  "currency": "CZK",
  "items": [
    {
      "proposal_id": 97,
      "product_id": 119,
      "code": "FOC-00833-XS",
      "ean": "8590246067254",
      "name": "Focus Atlas 2026 vel. XS (modrá)",
      "manufacturer": "Focus",
      "price": 114990,
      "old_price": 97990,
      "change_pct": 17.35,
      "vat_rate": 21,
      "currency": "CZK",
      "changed_at": "2026-09-26T05:28:11.598Z",
      "strategy": "Klíčové značky – držet pozici 2",
      "segment": "Klíčové značky",
      "lowest_30d": 97990
    },
    {
      "proposal_id": 12,
      "product_id": 14,
      "code": "KEL-00098-S",
      "ean": "8598258438635",
      "name": "Kellys Moterra 2026 vel. S (šedá)",
      "manufacturer": "Kellys",
      "price": 120990,
      "old_price": 123990,
      "change_pct": -2.42,
      "vat_rate": 21,
      "currency": "CZK",
      "changed_at": "2026-09-26T05:28:09.944Z",
      "strategy": "Výchozí – medián trhu −2 %",
      "segment": null,
      "lowest_30d": 123990
    }
  ]
}
```

### XML

Výchozí šablona (kořen `prices`, položka `item`, pole `code, ean, name, price, old_price, vat_rate, currency, changed_at`).
Názvy elementů i sadu polí změníte v **Nastavení → Export → XML feed** (např. přidat `proposal_id` – doporučeno pro ack –,
`lowest_30d`, přejmenovat `price` na `PRICE_VAT`). Prázdná hodnota = prázdný element (`<ean/>`).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<prices generated="2026-09-26T05:28:11.616Z" count="2" currency="CZK">
  <item>
    <code>FOC-00833-XS</code>
    <ean>8590246067254</ean>
    <name>Focus Atlas 2026 vel. XS (modrá)</name>
    <price>114990</price>
    <old_price>97990</old_price>
    <vat_rate>21</vat_rate>
    <currency>CZK</currency>
    <changed_at>2026-09-26T05:28:11.598Z</changed_at>
  </item>
  <item>
    <code>KEL-00098-S</code>
    <ean>8598258438635</ean>
    <name>Kellys Moterra 2026 vel. S (šedá)</name>
    <price>120990</price>
    <old_price>123990</old_price>
    <vat_rate>21</vat_rate>
    <currency>CZK</currency>
    <changed_at>2026-09-26T05:28:09.944Z</changed_at>
  </item>
</prices>
```

### CSV

Pro český Excel: UTF-8 s BOM, oddělovač `;`, **desetinná čárka**, řádky CRLF, hlavička = klíče polí (všechna pole).

```csv
proposal_id;product_id;code;ean;name;manufacturer;price;old_price;change_pct;vat_rate;currency;changed_at;strategy;segment;lowest_30d
97;119;FOC-00833-XS;8590246067254;Focus Atlas 2026 vel. XS (modrá);Focus;114990;97990;17,35;21;CZK;2026-09-26T05:28:11.598Z;Klíčové značky – držet pozici 2;Klíčové značky;97990
12;14;KEL-00098-S;8598258438635;Kellys Moterra 2026 vel. S (šedá);Kellys;120990;123990;-2,42;21;CZK;2026-09-26T05:28:09.944Z;Výchozí – medián trhu −2 %;;123990
```

Pro strojové zpracování je nejjednodušší JSON.

## 4. Potvrzení převzetí (ack)

```
POST /api/v1/export/ack        (rozsah export, Content-Type: application/json)
```

Tělo – doporučený tvar `items` (id návrhu **nebo** kód, vždy s převzatou cenou):

```json
{
  "items": [
    { "proposal_id": 97, "price": 114990 },
    { "code": "KEL-00098-S", "price": 120990 },
    { "code": "KEL-00119-XL", "price": 119990 },
    { "code": "NEEXISTUJE-1", "price": 999 }
  ]
}
```

Odpověď `200`:

```json
{
  "export_id": 1,
  "count": 2,
  "proposal_ids": [12, 97],
  "unknown_codes": ["NEEXISTUJE-1"],
  "mismatched": [
    {
      "code": "KEL-00119-XL",
      "proposal_id": null,
      "delivered": 119990,
      "current_proposal_id": 15,
      "current_price": 122990,
      "reason": "price_mismatch"
    }
  ],
  "skipped": []
}
```

| Pole | Význam |
|---|---|
| `export_id` | id vzniklého exportu (záznam v logu exportů); `null`, když se nic neoznačilo |
| `count`, `proposal_ids` | kolik a které návrhy se označily jako exportované |
| `unknown_codes` | kódy, které Cenotvorba nezná (nebo produkt nemá co potvrdit) |
| `mismatched` | položky, které se **neoznačily**, protože nesedí: `reason` = `price_mismatch` (potvrzená cena ≠ cena návrhu / vydaná cena), `changed_since_delivery` (ruční cena návrhu se po stažení změnila – admin má starou), `not_open` (návrh už je exportovaný, zamítnutý, vrácený ke schválení nebo neexistuje) |
| `skipped` | návrhy, které se při označení přeskočily: `locked` (produkt zamčen), `changed_since_delivery`, `price_changed`, `below_min`, `above_max`, `below_cost` (kontrola před exportem) |

Příklad přeskočeného návrhu (produkt mezitím dostal jinou cenu importem z POHODY → návrh se neoznačí, přecenění spočítá nový):

```json
{"export_id": null, "count": 0, "proposal_ids": [], "unknown_codes": [], "mismatched": [],
 "skipped": [{"proposal_id": 41, "reason": "price_changed"}]}
```

Co se stane s označenými návrhy: stav `exported`, `exported_at`, `export_id`; je-li zapnuto **Nastavení → Export →
Po exportu přepsat aktuální cenu** (`export.update_current_price`, výchozí ano), zapíše se převzatá cena do
`products.price` a do historie cen (zdroj `export`). Další import katalogu z POHODY se stejnou cenou pak nic nemění.

Starší tvary (bez ceny, méně bezpečné): `{"proposal_ids": [97, 12]}` – označí návrh, pokud se jeho cena od vydání nezměnila;
`{"codes": ["FOC-00833-XS"]}` – označí naposledy **vydaný** návrh produktu (i když ho mezitím nahradilo nové přecenění),
nikdy novější, který admin neviděl.

## 5. Kompletní ceník – resynchronizace

```
GET /feed/prices.json | .xml | .csv        (rozsah export; mark není povolen)
GET /api/v1/export/pricelist.json | .xml | .csv | .xlsx
```

Všechny **aktivní** produkty: `price` = cena ze schváleného (neexportovaného, nezadrženého) návrhu, jinak aktuální
cena produktu. U produktů bez návrhu je `proposal_id: null`, `change_pct: 0`, `changed_at` = poslední změna ceny.
Ceník **nic neoznačuje a je idempotentní** – hodí se k noční kontrole („liší se cena v adminu od ceníku?“) a k obnově
po výpadku. Formát těla je stejný jako u feedu změn.

JSON (`/feed/prices.json`, zkráceno na 2 položky – produkt bez návrhu a produkt se schválenou změnou):

```json
{
  "generated": "2026-09-26T05:28:24.217Z",
  "count": 2,
  "currency": "CZK",
  "items": [
    {
      "proposal_id": null,
      "product_id": 8,
      "code": "ABU-00056",
      "ean": "8596683838433",
      "name": "Abus Bordo 6500",
      "manufacturer": "Abus",
      "price": 2390,
      "old_price": 2390,
      "change_pct": 0,
      "vat_rate": 21,
      "currency": "CZK",
      "changed_at": null,
      "strategy": null,
      "segment": null,
      "lowest_30d": 2390
    },
    {
      "proposal_id": 15,
      "product_id": 17,
      "code": "KEL-00119-XL",
      "ean": "8596456641079",
      "name": "Kellys Moterra 2026 vel. XL (šedá)",
      "manufacturer": "Kellys",
      "price": 122990,
      "old_price": 119990,
      "change_pct": 2.5,
      "vat_rate": 21,
      "currency": "CZK",
      "changed_at": "2026-09-26T05:28:09.944Z",
      "strategy": "Výchozí – medián trhu −2 %",
      "segment": null,
      "lowest_30d": 119990
    }
  ]
}
```

XML (`/feed/prices.xml`, stejná šablona jako feed změn; chybějící hodnota = prázdný element):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<prices generated="2026-09-26T05:28:24.230Z" count="2" currency="CZK">
  <item>
    <code>ABU-00056</code>
    <ean>8596683838433</ean>
    <name>Abus Bordo 6500</name>
    <price>2390</price>
    <old_price>2390</old_price>
    <vat_rate>21</vat_rate>
    <currency>CZK</currency>
    <changed_at/>
  </item>
  <item>
    <code>KEL-00119-XL</code>
    <ean>8596456641079</ean>
    <name>Kellys Moterra 2026 vel. XL (šedá)</name>
    <price>122990</price>
    <old_price>119990</old_price>
    <vat_rate>21</vat_rate>
    <currency>CZK</currency>
    <changed_at>2026-09-26T05:28:09.944Z</changed_at>
  </item>
</prices>
```

CSV (`/feed/prices.csv`):

```csv
proposal_id;product_id;code;ean;name;manufacturer;price;old_price;change_pct;vat_rate;currency;changed_at;strategy;segment;lowest_30d
;8;ABU-00056;8596683838433;Abus Bordo 6500;Abus;2390;2390;0;21;CZK;;;;2390
15;17;KEL-00119-XL;8596456641079;Kellys Moterra 2026 vel. XL (šedá);Kellys;122990;119990;2,5;21;CZK;2026-09-26T05:28:09.944Z;Výchozí – medián trhu −2 %;;119990
```

Pozor: ceník obsahuje i schválené a nepotvrzené změny. Nasadíte-li z něj cenu s `proposal_id`, potvrďte ji ackem jako u feedu změn.

## 6. Označení při stažení (`mark=1`) a znovustažení exportu

`GET /feed/changes.json?mark=1` stáhne změny a **v téže transakci je označí jako exportované** (bez ack). Odpověď nese
`X-Export-Id`. Je to pohodlné, ale **není to bezpečné pro opakování**: ztratí-li se odpověď (časový limit, výpadek sítě),
změny už jsou označené a další stažení je nevrátí.

Obnova:

1. **Znovustažení exportu** – řádky, které export skutečně doručil, ve stejném formátu jako feed změn:
   ```
   GET /api/v1/exports/{export_id}/changes.json | .xml | .csv     (rozsah export)
   ```
   `price` = doručená cena, položky = návrhy s tímto `export_id`. Nic neoznačuje. Neznámé id nebo export bez návrhů
   (např. stažení XLSX, neúspěšný webhook) → `404`. Id exportu zjistíte z hlavičky `X-Export-Id`, z odpovědi ack nebo
   z logu `GET /api/v1/exports` (rozsah `read`) – položky mají `redownload: true`, když je lze stáhnout znovu:
   ```json
   {"items":[{"id":2,"created_at":"2026-09-26T05:28:24.242Z","kind":"feed","target":"feed/changes.json","count":10,
              "status":"ok","detail":{"format":"json","scope":"approved","held":0,"proposal_ids":[15,52,54]},"redownload":true}],
    "total":2,"page":1,"limit":100}
   ```
2. **Kompletní ceník** `/feed/prices.*` (kapitola 5) – srovnání všech cen.

Doporučení: pro automatickou integraci používejte **feed bez `mark` + ack s cenou**. `mark=1` jen tam, kde klient ack
neumí (a počítejte s obnovou přes znovustažení exportu).

## 7. Webhook (push)

Místo stahování může Cenotvorba schválené změny adminu **poslat**. Nastavení → Export → Webhook:

| Nastavení | Význam | Výchozí |
|---|---|---|
| `export.webhook.url` | adresa (http/https) | – |
| `export.webhook.format` | `json` / `xml` / `csv` – tělo stejné jako feed změn | `json` |
| `export.webhook.headers` | vlastní hlavičky, např. `{"Authorization": "Bearer tajne"}` | `{}` |
| `export.webhook.timeout_ms` | časový limit jednoho pokusu | `20000` |
| `export.webhook.auto_push` | posílat automaticky po plánovaném přecenění | ne |
| `schedule.auto_push_after_run` | totéž (starší přepínač v sekci Plánování) | ne |

**Kdy se odesílá:** ručně tlačítkem v UI / voláním `POST /api/v1/export/push` (rozsah export), nebo automaticky po
úspěšném **plánovaném** přecenění, když je zapnuté `export.webhook.auto_push` (nebo `schedule.auto_push_after_run`)
a URL je nastavená. Když není co odeslat, požadavek se neposílá.

**Požadavek:**

```http
POST /cenotvorba/zmeny HTTP/1.1
Host: admin.firma.cz
Content-Type: application/json; charset=utf-8
User-Agent: Cenotvorba/1.0 (webhook)
X-Cenotvorba-Count: 2
Authorization: Bearer tajne            ← vlastní hlavičky z nastavení

{"generated":"2026-09-26T05:30:00.000Z","count":2,"currency":"CZK","items":[{"proposal_id":97,"code":"FOC-00833-XS","price":114990, …}, …]}
```

(`format: xml` → `Content-Type: application/xml; charset=utf-8` a XML podle šablony; `csv` → `text/csv; charset=utf-8`.)

**Co se počítá jako doručené:** odpověď **2xx** (obsah těla odpovědi se nevyhodnocuje; prvních 2 KB vrátí `POST /export/push` v poli `body` a při chybě se uloží do logu exportů). Pak se odeslané
návrhy označí jako exportované s **odeslanými** cenami (jako ack). Cokoli jiného = nedoručeno: nic se neoznačí, do logu
exportů se zapíše chyba a stejné změny odejdou při dalším pushi (nebo si je admin stáhne feedem).

**Opakování:** až 2 další pokusy (po 500 ms a 2 s) při síťové chybě, vypršení časového limitu, HTTP 5xx, 408 a 429.
Jiné 4xx se neopakují (chyba konfigurace). Přesměrování 307/308 na stejný server se následuje (max. 3×), jiná přesměrování
jsou chyba – upravte URL.

**Odpověď `POST /api/v1/export/push`:**

```json
{"ok": true, "status": 200, "body": "{\"ok\":true}", "duration_ms": 84, "attempts": 1,
 "count": 2, "export_id": 5, "marked": 2, "not_marked": [], "held": []}
```

Chybí-li URL → `400`. Neúspěch webhooku → `200` s `"ok": false`, `error` (česky) a `marked: 0`.

Webhook může výjimečně doručit **stejnou změnu dvakrát** (admin ji zpracoval, ale odpověď nedorazila včas → opakování nebo
další push). Zpracování v adminu proto musí být idempotentní (kapitola 9).

## 8. Chyby

Všechny chyby API mají stejný tvar, zpráva je česky:

```json
{"error": {"status": 400, "message": "items[0]: price musí být kladné číslo (převzatá cena).", "details": null}}
```

| Stav | Kdy |
|---|---|
| `400` | neplatný požadavek (tělo, parametry, filtr); `details` může obsahovat seznam chyb |
| `401` | chybí / neplatný / zrušený token (`WWW-Authenticate: Bearer realm="cenotvorba"`), např. `{"error":{"status":401,"message":"Neplatný nebo zrušený API token.","details":{"reason":"invalid_token"}}}` |
| `403` | token nemá potřebný rozsah: `{"error":{"status":403,"message":"Nedostatečné oprávnění – vyžadován rozsah „read“.","details":{"required":"read","scopes":["export"]}}}` |
| `404` | neznámá cesta, feed nebo export |
| `409` | konflikt stavu (např. POHODA XML bez položek `POHODA_EMPTY`, souběžné spuštění téhož zdroje) |
| `413` | tělo požadavku je příliš velké |
| `429` | příliš mnoho neúspěšných přihlášení (hlavička `Retry-After`) |
| `500` | interní chyba (`"Interní chyba serveru"`) – opakujte později |

## 9. Idempotence a doporučení

- **Cenu nastavujte absolutně podle `code`** (ne jako rozdíl) – opakované zpracování téže položky pak nic nerozbije.
- **Deduplikujte podle `proposal_id`**: položku, kterou jste už nasadili, můžete dostat znovu (nepotvrzený feed, opakovaný
  webhook). Stačí si pamatovat posledních pár tisíc zpracovaných `proposal_id`.
- **Ack je bezpečné opakovat**: podruhé se nic neoznačí (`count: 0`, položky v `mismatched` s důvodem `not_open`).
  Nepotvrzené položky (výpadek mezi nasazením a ackem) přijdou v dalším feedu znovu – po nasazení je znovu potvrďte.
- Potvrzujte s **cenou**, kterou jste nasadili. Položky v `mismatched` s `price_mismatch` / `changed_since_delivery`
  znamenají, že v Cenotvorbě je jiná cena – stáhněte feed znovu.
- `mark=1` a webhook bez deduplikace nejsou bezpečné při výpadku – obnova je `GET /api/v1/exports/{id}/changes.json`
  a `/feed/prices.*`.
- Pravidelně (např. v noci) porovnejte ceny v adminu s `/feed/prices.json` – odhalí cokoli, co se cestou ztratilo.
- Časový limit HTTP klienta ≥ 30 s; při `5xx` / síťové chybě opakujte s prodlevou (feed i ack jsou pro opakování bezpečné).
- Import katalogu z POHODY po nasazení cen je v pořádku: shodná cena nic nemění, jiná cena otevřené návrhy produktu zneplatní
  (spočítají se znovu z nové ceny).

## 10. Referenční klient

### curl

```bash
BASE=https://cenotvorba.firma.cz
TOKEN=ct_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# 1) stáhnout schválené změny
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/feed/changes.json" -o zmeny.json

# 2) … nasadit ceny v adminu …

# 3) potvrdit převzetí (id návrhu + nasazená cena)
curl -sS -X POST "$BASE/api/v1/export/ack" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data '{"items":[{"proposal_id":97,"price":114990},{"proposal_id":12,"price":120990}]}'

# obnova: znovu stáhnout export č. 5 / kompletní ceník
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/exports/5/changes.json"
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/feed/prices.json" -o cenik.json
```

### Node.js (≥ 18, bez knihoven)

```js
// Stáhne schválené změny, nasadí je a potvrdí převzetí. Spouštět např. každých 10 minut.
const BASE = process.env.CENOTVORBA_URL; // https://cenotvorba.firma.cz
const headers = { Authorization: `Bearer ${process.env.CENOTVORBA_TOKEN}`, 'Content-Type': 'application/json' };

async function call(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers, signal: AbortSignal.timeout(60000) });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${body.error?.message}`);
  return body;
}

async function sync(applyPrice /* async (code, price) => void */, seen /* Set zpracovaných proposal_id */) {
  const feed = await call('/feed/changes.json');
  const done = [];
  for (const it of feed.items) {
    try {
      if (!seen.has(it.proposal_id)) await applyPrice(it.code, it.price); // absolutní cena podle kódu
      seen.add(it.proposal_id);
      done.push({ proposal_id: it.proposal_id, price: it.price });
    } catch (e) {
      console.error(`Cenu ${it.code} se nepodařilo nasadit: ${e.message}`); // nepotvrdit → přijde znovu
    }
  }
  if (!done.length) return { count: 0 };
  const ack = await call('/api/v1/export/ack', { method: 'POST', body: JSON.stringify({ items: done }) });
  for (const m of ack.mismatched) console.warn(`Nepotvrzeno ${m.code ?? m.proposal_id}: ${m.reason}`);
  return ack;
}

module.exports = { sync };
```

Související dokumenty: [SPEC.md](SPEC.md) (technická specifikace, §7 export a §8 API), [POHODA.md](POHODA.md)
(import cen přímo do POHODY – XML dataPack).
