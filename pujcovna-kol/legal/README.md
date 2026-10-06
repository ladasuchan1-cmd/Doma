# Právní texty – návrhy k advokátní kontrole

Parametrizované šablony dokumentů, které muster generuje pro každou půjčovnu z jejího nastavení. Jsou to
**návrhy připravené jako podklad**; před prvním ostrým použitím je zkontroluje advokát, kterého zajišťuje
zadavatel. Každý dokument má na začátku interní tabulku **Parametry** (všechny placeholdery `{{NAZEV}}`
s významem a výchozí hodnotou) a na konci interní sekci **K ověření advokátem** se spornými body a body
vyžadujícími rozhodnutí půjčovny. Stav: 6. 10. 2026.

| Soubor | Dokument | Kdo ho podepisuje / kde se zobrazuje |
|---|---|---|
| [obchodni-podminky.md](obchodni-podminky.md) | Obchodní podmínky půjčovny kol s online rezervací | zákazník souhlasí při rezervaci (ukládá se verze, čas, otisk IP); stránka `/podminky`; výňatek čl. 12–13 na `/reklamace` |
| [zasady-ochrany-osobnich-udaju.md](zasady-ochrany-osobnich-udaju.md) | Zásady ochrany osobních údajů včetně informací o cookies | samostatná stránka `/soukromi`; odkaz z rezervace a z patičky |
| [smlouva-o-najmu-a-predavaci-protokol.md](smlouva-o-najmu-a-predavaci-protokol.md) | Smlouva o nájmu kola (část A), předávací protokol (B), protokol o vrácení (C), popis uložení (D) | tisk / podpis při převzetí a vrácení – generuje `src/domain/documents.js` (typy `contract`, `handover`, `return_protocol`) |
| [zaznam-o-cinnostech-zpracovani.md](zaznam-o-cinnostech-zpracovani.md) | Záznamy o činnostech zpracování (čl. 30 GDPR) pro půjčovnu i provozovatele | interní dokument, generuje se předvyplněný |
| [zpracovatelska-smlouva.md](zpracovatelska-smlouva.md) | Smlouva o zpracování osobních údajů (čl. 28 GDPR) mezi provozovatelem musteru a půjčovnou | podepisuje půjčovna při onboardingu |

Jak vznikly (5. 10. 2026): návrh → dvě nezávislé oponentury (právo ČR: OZ, ochrana spotřebitele, DPH, doklady;
GDPR, stanoviska ÚOOÚ a praktičnost) → zapracování nálezů → úpravy podle rozhodnutí zadavatele (níže).
Citace paragrafů oponenti ověřovali z primárních zdrojů (e-Sbírka, zakonyprolidi.cz). Podklady:
[rešerše 02 – platby, zálohy a DPH](../docs/vyzkum/02-platby-cr.md) a
[rešerše 03 – bezpečnost, GDPR, praxe půjčoven](../docs/vyzkum/03-bezpecnost-gdpr-podminky.md).

## Rozhodnutí zadavatele (5. 10. 2026) a jejich promítnutí do textů

1. **Doklad totožnosti je podmínkou nájmu bez výjimky.** Při převzetí zákazník předloží platný doklad
   (`{{DOKLADY_AKCEPTOVANE}}`), obsluha ověří jeho platnost v Databázi neplatných dokladů MV ČR
   (https://aplikace.mvcr.cz/neplatne-doklady/) a zapíše **jen typ a číslo** (šifrovaně, výmaz po
   `{{DOBA_CISLO_DOKLADU}}`). Souhlas se zápisem údajů z občanského průkazu (§ 39 písm. d) zákona č. 269/2021 Sb.)
   dává zákazník předložením dokladu a podpisem protokolu; bez dokladu a souhlasu se kolo nevydá a rezervace se
   posuzuje jako nevyzvednutá. Odůvodnění v textech: ověření totožnosti a **platnosti dokladu** a ochrana majetku
   při **krádežích jízdních kol** (statistika Policie ČR s uvedením zdroje a roku, OP čl. 8.3 a balanční test A v Zásadách:
   2024 = 3 971 krádeží kol se škodou 123 mil. Kč, 2025 = 3 387 krádeží se škodou 109 mil. Kč – ověřeno 6. 10. 2026
   přímo v sestavách Statistických přehledů kriminality PČR, řádky TSK 378 a 418; registrovaný počet v posledních letech
   klesá, roste průměrná škoda na kolo, proto texty netvrdí „rostoucí počet“ – viz OP, K ověření bod 21).
   Parametr `{{DOKLAD_REZIM}}` má jedinou hodnotu `A`; dřívější varianta B (bez čísla dokladu) je ze všech
   dokumentů odstraněna. Promítnuto: OP čl. 3.2, 6.5, 8.2–8.3, 14; Zásady odd. 2–4 (balanční test A);
   Smlouva čl. 1 a 6; Záznamy A3.
2. **Rezervační poplatek je úplata za zajištění služby** (blokaci kol na termín). Při řádném využití se **započítá
   na nájemné**; při zrušení **nejméně `{{STORNO_LHUTA_HODIN}}` hodin** (výchozí 48, `settings.cancellation.freeHoursBefore`)
   před začátkem nájmu se vrací celý, při pozdějším zrušení nebo nevyzvednutí **propadá**. `{{STORNO_TABULKA}}`
   generuje systém jako dvouřádkovou tabulku (ve větě jako text). Režim DPH: plátce zdaní poplatek jako službu
   i při propadnutí (`{{STORNO_DPH_REZIM}}` = `zdanitelne-plneni`; alternativu `mimo-predmet-dane` potvrdí daňový
   poradce). Promítnuto: OP čl. 2.3, 4.2, 4.5, 6; Zásady odd. 3; Smlouva čl. 3; Záznamy A2.
3. **Zjednodušený daňový doklad** (§ 30 ZDPH) u plátce DPH pro platby do 10 000 Kč (bez identifikace zákazníka),
   nad tuto částku běžný daňový doklad; stejné pravidlo pro konečný doklad (`{{REZIM_DOKLADU}}` = `zjednoduseny`).
   U neplátce doklad o zaplacení a konečné vyúčtování. Promítnuto: OP čl. 4.5; Zásady odd. 4; Smlouva čl. 3;
   Záznamy A2; zpracovatelská smlouva čl. 11.1 c) (výmaz jména na dokladech pro spotřebitele).

Dřívější rozhodnutí zapracovaná už v první verzi: fixní rezervační poplatek za každé kolo, kauce hotově /
terminálem / preautorizací karty při převzetí, párování převodů přes Fio, provoz na subdoméně musteru, žádné
kopie dokladů totožnosti.

## Jak se dokumenty renderují

Renderer je `src/render/markdown.js` (podmnožina Markdownu + šablonování), slovník parametrů a stránky
`src/features/pravni.js` (`legalParams(tenant, settings)`, `renderLegal(doc, params, { only, omitHeadings })`),
stránka `src/render/pages/pravni.js`, styly `public/css/pravni.css` (obsah, čitelná šířka řádku 72 znaků,
tabulky na mobilu posuvné, tisk černě na bílé i v tmavém tématu).

- **Interní části** se na web ani do tisku nedostanou: vše mezi `<!-- INTERNI: nerenderovat -->` a
  `<!-- /INTERNI -->` (značky platí jen samy na začátku řádku – zmínka značky v textu blok neukončí), oddíly
  „Parametry“, „K ověření advokátem“, „Příloha pro advokáta…“ a úvodní rámeček „Návrh připravený jako podklad…“.
  V demo režimu se pod textem zobrazí šedý box „Demo: tento text je návrh k advokátní kontrole, verze X“.
- **`{{PARAMETR}}`** se nahradí hodnotou ze slovníku (escapovanou – hodnoty se nevykládají jako Markdown ani HTML);
  neznámý placeholder zůstane viditelný a zaloguje se jako chybějící (test ho nedovolí).
- **Podmíněné bloky:** `{{#X}}…{{/X}}` se zobrazí, je-li X pravdivé („ano“, neprázdný text, `true`, pole s prvky),
  `{{^X}}…{{/X}}` je-li nepravdivé („ne“, prázdno, „—“, `false`, prázdné pole). Značka sama na řádku spolkne
  i svůj konec řádku, takže blok může obalit celé odstavce, blockquote, nadpis s podsekcí i víc řádků tabulky;
  jediný řádek tabulky se obaluje inline (`{{#X}}| … |{{/X}}`). **Všechny varianty textů jsou zapsány takto** –
  prozaické značky typu „[VARIANTA A – plátce DPH]“, „[při X = ano]“, „[Volitelné – analytika]“, „[ONLINE] /
  [NA MÍSTĚ]“, „[E-KOLO]“ a poznámky „(opakuje se pro každé kolo)“ byly převedeny na bloky a v textu už nejsou
  (hlídá test `test/pravni.test.js`).
- **Cyklus:** `{{#X}}…{{/X}}`, kde X je **pole záznamů**, se opakuje pro každý záznam; klíče záznamu se uvnitř
  bloku dosazují a vyhodnocují (např. `{{#KOLA}}| {{KOLO_PORADI}} | {{KOLO_TYP}} | … |{{/KOLA}}` v protokolu,
  tabulka B.3 pro každé kolo zvlášť, `{{#KOLO_JE_EKOLO}}` per kolo). Není-li pole předáno, blok se vytiskne jednou
  s hodnotami sloučenými do jedné buňky (`KOLA` = „ano“).
- **Odkazy** mezi šablonami (`zasady-ochrany-osobnich-udaju.md` → `/soukromi`, `obchodni-podminky.md` → `/podminky`)
  mapuje `LINK_MAP`; nadpisy dostávají stabilní `id` (slug bez diakritiky), na která se odkazuje z rezervace:
  `/podminky#8-prevzeti-kola`, `/soukromi#3-proc-udaje-zpracovavame-a-na-jakem-pravnim-zaklade`.
- `/reklamace` je výřez OP (`only: [/^12\./, /^13\./]`) s kontaktní kartou; smlouva a protokoly se tisknou přes
  `documents.js` s `omitHeadings: [/^ČÁST D/]` (smlouva), `only: [/^ČÁST B/, /^B\.\d/]` (předávací protokol),
  `only: [/^ČÁST C/, /^C\.\d/]` (protokol o vrácení).

## Parametry

Jediný slovník sestavuje `legalParams(tenant, settings)` z `tenant.json` (`business`, `legal`, `openingHours`,
`hosts`) a efektivního nastavení půjčovny (tabulka `settings`, výchozí z `tenant.json`); přepisy lze dát do
`tenant.legal.params` nebo `settings.legalParams`. Význam a výchozí hodnotu každého parametru popisují tabulky
**Parametry** na začátku jednotlivých šablon ([OP](obchodni-podminky.md#parametry),
[Zásady](zasady-ochrany-osobnich-udaju.md#parametry), [Smlouva](smlouva-o-najmu-a-predavaci-protokol.md#parametry),
[Záznamy](zaznam-o-cinnostech-zpracovani.md#parametry), [Zpracovatelská smlouva](zpracovatelska-smlouva.md#parametry)).
Test `test/pravni.test.js` ověřuje, že slovník zná každý placeholder všech pěti šablon, že dvojice
`{{PLATEBNI_BRANA}}`/`{{PLATEBNI_BRANA_NAZEV}}`, `{{BANKA}}`/`{{BANKA_NAZEV}}` a `{{POJISTENI}}`/`{{POJISTOVNA_NAZEV}}`
dostávají stejnou hodnotu a že lhůty jsou sjednoceny na `{{DOBA_*}}`.

**Booleovské parametry („ano“ / „ne“), které řídí varianty textů:**

| Parametr | Odvozeno z | Řídí |
|---|---|---|
| `PLATCE_DPH` | `business.vatPayer` | plátce / neplátce DPH (DIČ, ceny s DPH, daňové doklady, doby uchování) |
| `EVIDENCE_UCETNICTVI` | `REZIM_EVIDENCE` (`settings.accountingMode`, jinak s.r.o. = účetnictví, OSVČ = daňová evidence) | účetnictví vs. daňová evidence (Zásady odd. 3–4, Záznamy A2) |
| `DOKLAD_ZJEDNODUSENY` | `REZIM_DOKLADU` = `zjednoduseny` (rozhodnutí 3) | věty o zjednodušeném daňovém dokladu |
| `ANALYTIKA` | `settings.analyticsTool` vyplněn | cookie lišta, analytické cookies, činnost A10 |
| `ZAPISOVAT_NAROZENI_ADRESU` | `settings.recordBirthAddress` | zápis data narození a adresy podle sdělení nájemce |
| `DRUHY_DOKLAD` | `settings.secondIdDoc` | předložení druhého dokladu (bez zápisu) |
| `GPS_LOKATORY` | `settings.gpsTrackers` | sledování polohy kol (vyžaduje DPIA) |
| `PREDAVANI_MIMO_EU` | `settings.transferOutsideEu` (+ `transferOutsideEuText`) | odd. 6 Zásad |
| `PODPIS_OBRAZOVKA` | `PODPIS_ZPUSOB` (`settings.signatureMode`, výchozí `obrazovka`) | podpis na obrazovce vs. listinné stejnopisy |
| `DOKLAD_CISLO_PLNE` | `DOKLAD_CISLO_TISK` (`settings.idDocPrint`, výchozí `maskovane`) | tisk čísla dokladu na listinu |
| `POJISTOVNA_UVEDENA` | `settings.insurance` / `legal.insurance` vyplněno | zmínky o pojišťovně |
| `POPLATEK_NABITI_UCTUJEME` | `settings.chargingFlatMinor` > 0 | paušál za nabití elektrokola (OP čl. 4.7, 11.6; protokol C.3) |
| `PLATBA_NA_MISTE_POVOLENA`, `DOPLATEK_PREDEM_POVINNY`, `DRIVEJSI_VRACENI_REFUND` | `settings.allowPayOnSite`, `balanceBeforePickup`, `earlyReturnRefund` | OP čl. 3.6, 4.3, 11.7 |
| `SMLOUVA_NA_MISTE` | `SMLOUVA_REZIM` (`settings.contractMode`, výchozí `online`; admin může přepsat per rezervace) | Smlouva čl. 2.3 – rezervace přes web vs. založená na výdejním místě |
| `KOLO_JE_EKOLO`, `KAUCE_HOTOVE`, `VRACENI_BEZ_NAJEMCE` | údaje rezervace / protokolu (doplní admin nebo `documents.js`) | řádky pro elektrokolo, účet pro vratku hotovostní kauce, podpis protokolu jen obsluhou |
| `KOLA` | pole záznamů kol z `documents.contractParams` (bez pole „ano“) | cyklus přes kola v protokolu |

Textové a číselné parametry (`PUJCOVNA_*`, `PROVOZOVATEL_*`, `POPLATEK_*`, `KAUCE_*`, `DOBA_*`, `LHUTA_*`,
`NAJEMCE_*`, `KOLO_*`, `VRACENI_*`, …) viz tabulky v šablonách; údaje rezervace a protokolu mají výchozí hodnotu
„…………“ a doplňuje je admin při tisku.

## Co zbývá pro advokáta (zkrácený seznam)

Úplné znění bodů je v sekcích „K ověření advokátem“ jednotlivých šablon (OP 35 bodů, Zásady 22, Smlouva 27,
Záznamy 20, Zpracovatelská smlouva 26). Průřezově:

1. **Souhlas se zápisem dokladu podmíněný službou** (čl. 7 odst. 4 GDPR; § 39 písm. d) zákona o OP) – zadavatel
   si je rizika vědom a na podmínce trvá; posoudit konstrukci oprávněný zájem + zákonem vyžadovaný souhlas,
   uvedení statistiky krádeží přímo v OP (údaje ověřeny v primárním zdroji PČR, viz OP bod 21) a pas / řidičský průkaz jako doklad.
   (OP 21, Zásady 1–3, Smlouva 9–12, Záznamy 1–2, 6)
2. **Rezervační poplatek jako úplata za zajištění služby** – obstojí propadnutí celého poplatku vůči § 1813 OZ
   a není to smluvní pokuta bez porušení povinnosti (§ 2048 OZ)? Reciprocita při zrušení z naší strany
   (§ 1814 odst. 1 písm. c) OZ). (OP 1–2, Smlouva 26, Záznamy 4)
3. **DPH – s daňovým poradcem:** zdanění propadlého poplatku jako služby (SDEU Air France-KLM vs. Société
   thermale), doklad k přijaté úplatě do 15 dnů, zjednodušený daňový doklad do 10 000 Kč i pro doklad k úplatě,
   konečný a opravný doklad (hranice za doklad, nebo za plnění), kauce mimo DPH, nájemné za prodlení a paušály
   s DPH, uchování dokladů na serveru v Německu (§ 35 odst. 3–4 ZDPH), doklady při žádosti o výmaz.
   (OP 25–28, Zásady 5–6, Smlouva 19, Záznamy 4–5, Zpracovatelská 13, 24, 26)
4. **Okamžik uzavření smlouvy, § 1837 písm. j) OZ, překvapivá ujednání (§ 1753), tlačítko „Objednávka zavazující
   k platbě“**, doručování e-mailem, lhůty reklamace. (OP 4–7, 29–31)
5. **Kauce:** preautorizace jako jistota, částečný `capture` bez nového souhlasu, započtení vs. zadržení sporné
   části, terminálová kauce a vratka převodem. (OP 9–11, Smlouva 6–8)
6. **Odpovědnost nájemce bez zavinění, strop náhrady obvyklou cenou kola** (§ 2969 OZ), vyvratitelné domněnky
   o stavu kola, jediná smluvní pokuta a její strop (bez moderace u spotřebitele), dřívější vrácení bez vratky,
   vrácení mimo otevírací dobu. (OP 12–20a, Smlouva 5, 15–21)
7. **Smlouva na místě vs. potvrzení online rezervace, podpis na obrazovce** (§ 561–562 OZ, § 7 zákona
   č. 297/2016 Sb.), e-mailová kopie bez obrázku podpisu, maskované číslo dokladu, další jezdci a nezletilí.
   (Smlouva 1–4, 11, 13–14, 22–25)
8. **GDPR provozně:** doby uchování (smlouva 3 roky vs. 10, logy 12 měsíců, zálohy, zrušená rezervace),
   cookies bez lišty (§ 89 odst. 3 ZEK) a `localStorage`, mapové dlaždice třetích stran, obchodní sdělení
   podle § 7 odst. 3 zákona č. 480/2004 Sb., otisk IP u souhlasu, role brány / terminálu / banky / účetní,
   předávání mimo EU (e-mailová služba), DPIA při GPS lokátorech, zdravotní údaje při nehodě.
   (Zásady 7–22, Záznamy 7–19)
9. **Zpracovatelská smlouva:** uzavření potvrzením v platformě, chybějící hlavní smlouva, limit odpovědnosti
   (§ 2898 OZ, slabší strana), smluvní pokuta (nesjednána – rozhodnutí zadavatele), půjčovna-nepodnikatel,
   podzpracovatelé a lhůty námitek, break-glass přístup, audit, jednostranné změny (§ 1752 OZ), doména musteru.
   (Zpracovatelská 1–12, 14–23, 25)
10. **Obecně:** po advokátní úpravě potvrdit i text všech variant a volitelných bloků (plátce/neplátce,
    účetnictví/daňová evidence, analytika, GPS, podpis papír/obrazovka, předávání mimo EU) a výchozí hodnoty
    parametrů, protože půjčovna je mění bez další právní kontroly. (Zásady 23, Záznamy 20)

**Rozhodnutí půjčovny před nasazením** (ne pro advokáta): plátce DPH; výše poplatků a kaucí; storno lhůta; platba
na místě; doplatek předem; pravidlo pro počasí; dřívější vrácení; spoluúčast při krádeži; pojištění; území užívání;
paušály a ceník náhrad; tolerance pozdního vrácení; definice dne nájmu; zápis data narození a adresy; tisk čísla
dokladu; způsob podpisu; formát jména obsluhy; lhůty výmazu (shodně ve všech dokumentech); otevírací doba a kontakty.

V aplikaci se z těchto šablon renderuje HTML (a tisková verze) dosazením parametrů z nastavení půjčovny;
každá změna textu zvyšuje verzi (`legal.version`) a nová verze se váže k novým souhlasům (`reservations.terms_version`).
