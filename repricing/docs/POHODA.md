# POHODA XML – import nových prodejních cen

Podklady: oficiální XSD Stormware (`all_schema_ver2.zip`, stažené 2026-09-25), oficiální ukázky
(`/xml/samples/version_2/import/Zasoby/stock_03_v2.0.xml` a odpověď), stránky „Historie změn“, „Podrobnosti zpracování“ a
dokumentace mServeru. Níže uvedené příklady byly ověřeny `xmllint --schema data.xsd` (UTF-8 i Windows-1250).

## Shrnutí pro implementaci (závazné pro `src/export/pohoda.js`)

| Téma | Pravidlo |
|---|---|
| Kódování | **Výchozí `windows-1250`** (Stormware: „XML data jsou uložena v kódování Windows-1250“). Deklarace v hlavičce musí odpovídat skutečným bajtům. Znaky mimo cp1250 nahradit `?`. Volba `encoding: 'utf-8'` jen na vyžádání (podpora UTF-8 v POHODĚ není oficiálně potvrzena). |
| Obálka | `dat:dataPack` s atributy `version="2.0"`, `id` (povinné, unikátní pro každý export, max 64 znaků), `ico` (IČO účetní jednotky – musí souhlasit, jinak POHODA odmítne), `application` (povinné, max 100), `note` (**povinné**). |
| Položka | `dat:dataPackItem version="2.0" id="…"` (id unikátní v rámci balíku, max 64) → `stk:stock version="2.0"`. |
| Aktualizace | `stk:actionType/stk:update/ftr:filter/ftr:code` (výchozí) nebo `ftr:EAN`. Aktualizují se **jen odeslaná pole**, ostatní zůstanou. `update` bez atributu `add` → nenalezená zásoba se nezaloží. |
| Filtr podle EAN | POHODA **odmítne aktualizaci, pokud filtru odpovídá více zásob** („Pro daný filtr bylo nalezeno více jak 1 záznam“). EAN v POHODĚ není unikátní → doporučujeme filtr podle kódu. |
| Cena | `stk:stockHeader/stk:sellingPrice payVAT="true"` = prodejní cena **s DPH**. Bez atributu je cena bez DPH! Hodnota `xsd:double` – desetinná tečka, bez oddělovačů tisíců. |
| Vedlejší efekt | Od verze 13100 změna prodejní ceny přes XML nastaví na zásobě „fixaci prodejní ceny“. |
| Cenové hladiny | Oficiálně přes samostatnou agendu `dis:discount` (discount.xsd, od verze 13400): `dis:discountStockItem/dis:stockItem/typ:stockItem/typ:ids` = kód zásoby, `dis:discounts/dis:discountsItem/dis:filter/dis:priceLevel/typ:ids` = kód cenové hladiny, `dis:price` = cena. Zda je `dis:price` s DPH, řídí nastavení hladiny (`calculation`). |
| Namespaces | `dat` `http://www.stormware.cz/schema/version_2/data.xsd`, `stk` `…/stock.xsd`, `ftr` `…/filter.xsd`, `typ` `…/type.xsd`, `dis` `…/discount.xsd` |

## (a) Aktualizace prodejní ceny podle kódu

```xml
<?xml version="1.0" encoding="Windows-1250"?>
<dat:dataPack version="2.0" id="cenotvorba-20260925-0001" ico="12345678" application="Cenotvorba" note="Přecenění – 2 položky"
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd" xmlns:stk="http://www.stormware.cz/schema/version_2/stock.xsd"
  xmlns:ftr="http://www.stormware.cz/schema/version_2/filter.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd">
  <dat:dataPackItem version="2.0" id="CT-000001">
    <stk:stock version="2.0">
      <stk:actionType>
        <stk:update>
          <ftr:filter>
            <ftr:code>KOLO-TREK-FX2-M</ftr:code>
          </ftr:filter>
        </stk:update>
      </stk:actionType>
      <stk:stockHeader>
        <stk:sellingPrice payVAT="true">18990</stk:sellingPrice>
      </stk:stockHeader>
    </stk:stock>
  </dat:dataPackItem>
  <dat:dataPackItem version="2.0" id="CT-000002">
    <stk:stock version="2.0">
      <stk:actionType>
        <stk:update>
          <ftr:filter>
            <ftr:code>PLAST-SCHW-29-2.35</ftr:code>
          </ftr:filter>
        </stk:update>
      </stk:actionType>
      <stk:stockHeader>
        <stk:sellingPrice payVAT="true">899</stk:sellingPrice>
      </stk:stockHeader>
    </stk:stock>
  </dat:dataPackItem>
</dat:dataPack>
```

## (b) Totéž podle EAN
Jako (a), jen filtr `<ftr:filter><ftr:EAN>8591234567890</ftr:EAN></ftr:filter>`.

## (c) Cena v cenové hladině (agenda Slevy, `dis:discount`)

```xml
<?xml version="1.0" encoding="Windows-1250"?>
<dat:dataPack version="2.0" id="cenotvorba-20260925-0002" ico="12345678" application="Cenotvorba" note="Přecenění – cenová hladina Eshop"
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd" xmlns:dis="http://www.stormware.cz/schema/version_2/discount.xsd"
  xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd">
  <dat:dataPackItem version="2.0" id="CT-000001">
    <dis:discount version="2.0">
      <dis:discountStockItem>
        <dis:stockItem>
          <typ:stockItem>
            <typ:ids>KOLO-TREK-FX2-M</typ:ids>
          </typ:stockItem>
        </dis:stockItem>
        <dis:discounts>
          <dis:discountsItem>
            <dis:filter>
              <dis:priceLevel>
                <typ:ids>Eshop</typ:ids>
              </dis:priceLevel>
            </dis:filter>
            <dis:price>18490</dis:price>
          </dis:discountsItem>
        </dis:discounts>
      </dis:discountStockItem>
    </dis:discount>
  </dat:dataPackItem>
</dat:dataPack>
```
Pro filtr podle EAN použijte v `typ:stockItem` element `typ:EAN` místo `typ:ids`.

(Alternativa `stk:stockPriceItem/stk:stockPrice/typ:ids + typ:price` uvnitř `stk:stock` je sice validní podle XSD,
ale Stormware nepotvrzuje, že ji POHODA při aktualizaci použije – proto ji negenerujeme.)

## Odpověď POHODY a kontrola úspěchu (pro admin)

`rsp:responsePack` (`state` ok/error, `id` = id odeslaného balíku) → `rsp:responsePackItem` (`id` = id položky, `state`)
→ `stk:stockItemResponse` / `dis:discountResponse` (`state`) → `rdc:importDetails/rdc:detail` (state ok/warning/error, `errno`,
`note`) a `rdc:producedDetails/rdc:id`. Úspěch položky = `responsePackItem/@state="ok"` **a** vnitřní `@state="ok"` **a**
existuje `producedDetails/id`. Varování (např. 603 „Hodnota prvku musela být upravena“) logovat. Chyby 101–113, 551–557.

## Jak XML do POHODY dostat

1. **Ručně**: Soubor → Datová komunikace → XML import/export → vybrat soubor stažený z Cenotvorby (Export → „POHODA XML“).
2. **mServer** (HTTP API POHODY): `POST http(s)://server:port/xml`, `Content-Type: text/xml`, hlavička
   `STW-Authorization: Basic base64(uživatel:heslo)`, volitelně `STW-Check-Duplicity: true` (kontrola duplicity podle `id`).
   Odpověď je synchronní `rsp:responsePack` ve Windows-1250. mServer patří do LAN / VPN, ne na veřejnou IP.
3. **Příkazová řádka**: `Pohoda.exe /XML "uživatel" "heslo" "import.ini"` se sekcí `[XML]` (`input_xml`, `response_xml`, …).
4. **Přes váš admin**: admin stáhne `GET /api/v1/export/pohoda.xml?mark=1` (nebo feed změn) a předá ho mServeru.

## Export katalogu z POHODY (pro import do Cenotvorby)

`lStk:listStockRequest version="2.0" stockVersion="2.0"` → `lStk:listStock/lStk:stock/stk:stockHeader`. Užitečná pole:
`stk:code`, `stk:EAN`, `stk:name`, `stk:purchasingPrice` (@payVAT), `stk:sellingPrice` (@payVAT), `stk:sellingRateVAT`
(@value = sazba v %), `stk:count` (množství), `stk:producer` (výrobce), `stk:storage/typ:ids` (členění skladu),
`stk:supplier/typ:id`, `stk:parameters/typ:parameter` (volitelné parametry). Inkrementálně filtrem `ftr:lastChanges`.
Cenotvorba takový export načte jako „katalog“ (XML, cesta položek `responsePack.responsePackItem.listStock.stock`, prefixy
jmenných prostorů se odstraňují, pole se napárují automaticky – `code`, `EAN`, `name`, `purchasingPrice`, `sellingPrice`,
`count`, `producer`).

## Ověření schématem (vývoj)
XSD nejsou součástí repozitáře (licence Stormware). Stáhněte `https://www.stormware.cz/xml/schema/all_schema_ver2.zip`,
rozbalte a nastavte `POHODA_XSD_DIR=/cesta/k/xsd`; testy exportu pak výstup ověří přes `xmllint --schema data.xsd`.
