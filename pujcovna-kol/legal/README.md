# Právní texty – návrhy k advokátní kontrole

Parametrizované šablony dokumentů, které muster generuje pro každou půjčovnu z jejího nastavení.
Jsou to **návrhy připravené jako podklad**; před prvním použitím je zkontroluje advokát, kterého
zajišťuje zadavatel. Každý dokument má na začátku tabulku **Parametry** (všechny placeholdery
`{{NAZEV}}` s významem a výchozí hodnotou) a na konci sekci **K ověření advokátem** se sporným
body a body vyžadujícími rozhodnutí půjčovny.

| Soubor | Dokument | Kdo ho podepisuje / kde se zobrazuje |
|---|---|---|
| [obchodni-podminky.md](obchodni-podminky.md) | Obchodní podmínky půjčovny kol s online rezervací | zákazník souhlasí při rezervaci (ukládá se verze, čas, otisk IP); stránka `/podminky` |
| [zasady-ochrany-osobnich-udaju.md](zasady-ochrany-osobnich-udaju.md) | Zásady ochrany osobních údajů včetně informací o cookies | samostatná stránka `/soukromi`; odkaz z rezervace a z patičky |
| [zpracovatelska-smlouva.md](zpracovatelska-smlouva.md) | Smlouva o zpracování osobních údajů (čl. 28 GDPR) mezi provozovatelem musteru a půjčovnou | podepisuje půjčovna při onboardingu |
| [zaznam-o-cinnostech-zpracovani.md](zaznam-o-cinnostech-zpracovani.md) | Záznamy o činnostech zpracování (čl. 30 GDPR) pro půjčovnu i provozovatele | interní dokument, generuje se předvyplněný |
| [smlouva-o-najmu-a-predavaci-protokol.md](smlouva-o-najmu-a-predavaci-protokol.md) | Smlouva o nájmu kola, předávací protokol a protokol o vrácení | tisk/podpis při převzetí a vrácení |

Jak vznikly (5. 10. 2026): návrh → dvě nezávislé oponentury (právo ČR: OZ, ochrana spotřebitele, DPH, doklady;
GDPR, stanoviska ÚOOÚ a praktičnost) → zapracování nálezů. Citace paragrafů oponenti ověřovali
z primárních zdrojů (e-Sbírka, zakonyprolidi.cz). Podklady: [rešerše 02 – platby, zálohy
a DPH](../docs/vyzkum/02-platby-cr.md) a [rešerše 03 – bezpečnost, GDPR, praxe půjčoven](../docs/vyzkum/03-bezpecnost-gdpr-podminky.md).

| Dokument | Nálezů oponentury | Zapracováno | Zbývá pro advokáta |
|---|---|---|---|
| Obchodní podmínky | 28 | 22 změn (mj. storno překvalifikováno na smluvní právo odstoupit s paušálním vypořádáním zálohy, opraveny citace § 20a a § 28 ZDPH, § 19 ZOS, § 2214 OZ, doručování podle § 570 OZ, vrácení nájemného při předčasném ukončení) | 15 bodů |
| Zásady ochrany osobních údajů | 25 | 24 změn (mj. § 39 písm. d) zákona o OP → dvě varianty režimu dokladu, analytika jen volitelně, anonymizace vs. daňové doklady, předávání mimo EU parametrizováno) | 10 bodů |
| Zpracovatelská smlouva | 31 | 14 změn (mj. podmíněné fragmenty, pravdivý popis logů, záložní podzpracovatel, výmaz podle typu dokladu, odpovědnost podle § 2913 OZ) | 20 bodů |
| Záznamy o činnostech | 24 | 19 změn (mj. § 39 písm. d), § 20a ZDPH, lhůty § 636 a § 640 OZ, sladění části B se smlouvou) | 8 bodů |
| Smlouva o nájmu a protokoly | 21 | 16 změn (mj. souhlas držitele OP, § 37a ZDPH, vyvratitelné domněnky o stavu kola, strop náhrady podle § 2969 OZ) | 12 bodů |

**Průřezové body (opakují se ve více dokumentech) a rozhodnutí zadavatele z 5. 10. 2026:**

1. **Režim dokladu totožnosti – rozhodnuto:** zápis typu a čísla dokladu je **podmínkou nájmu bez výjimky**
   (parametr `{{DOKLAD_REZIM}}` má jedinou hodnotu `A`; varianta B bez čísla dokladu je ze všech dokumentů
   odstraněna). Souhlas podle § 39 písm. d) zákona č. 269/2021 Sb. dává zákazník předložením dokladu a podpisem
   protokolu; odůvodnění v OP čl. 8.3, Zásadách odd. 2–3 (balanční test A), Smlouvě čl. 1 a 6 a Záznamech A3:
   ověření totožnosti a **platnosti dokladu** (Databáze neplatných dokladů MV ČR, https://aplikace.mvcr.cz/neplatne-doklady/)
   a ochrana majetku při krádežích jízdních kol (statistika Policie ČR). Bez dokladu a souhlasu se kolo nevydá a
   rezervace se posuzuje jako nevyzvednutá. Pro advokáta zůstává jediný bod: riziko posouzení souhlasu
   podmíněného službou (čl. 7 odst. 4 GDPR) – zadavatel si je vědom a na podmínce trvá.
2. **Rezervační poplatek – rozhodnuto:** úplata za zajištění služby (blokaci kol na termín), započítává se na
   nájemné; zrušení nejméně `{{STORNO_LHUTA_HODIN}}` hodin (výchozí 48) před začátkem → vrací se celý, později
   nebo nevyzvednutí → propadá. `{{STORNO_TABULKA}}` generuje systém jako dvouřádkovou tabulku. Režim DPH:
   úplata za službu, plátce zdaní i propadlý poplatek (`{{STORNO_DPH_REZIM}}` = `zdanitelne-plneni`) – potvrdí
   daňový poradce.
3. **Zjednodušený daňový doklad – rozhodnuto:** u plátce DPH pro platby do 10 000 Kč (§ 30 ZDPH), nad to běžný
   daňový doklad (`{{REZIM_DOKLADU}}` = `zjednoduseny`); potvrdit s daňovým poradcem pro konečný a opravný doklad.
   Způsob vedení evidence (účetnictví / daňová evidence) nese přejmenovaný parametr `{{REZIM_EVIDENCE}}`.
4. **Limit odpovědnosti a smluvní pokuta** ve zpracovatelské smlouvě (§ 2898 OZ u slabší strany) – rozhodnutí zadavatele.
5. **Vyvratitelné domněnky o stavu kola** v protokolu a strop náhrady obvyklou cenou kola (§ 1814 písm. l), § 2969 OZ).

**Slovník parametrů:** jediný slovník sestavuje `src/features/pravni.js` (`legalParams(tenant, settings)`) z
`tenant.json` (business, legal, openingHours, hosts) a nastavení půjčovny; dvojice `{{PLATEBNI_BRANA}}`/`{{PLATEBNI_BRANA_NAZEV}}`,
`{{BANKA}}`/`{{BANKA_NAZEV}}` a `{{POJISTENI}}`/`{{POJISTOVNA_NAZEV}}` dostávají stejnou hodnotu; lhůty jsou
sjednoceny na `{{DOBA_*}}`. Test `test/pravni.test.js` ověřuje, že slovník zná každý placeholder všech pěti šablon.

**Konvence renderování (src/render/markdown.js):** vše mezi `<!-- INTERNI: nerenderovat -->` a `<!-- /INTERNI -->`,
oddíly „Parametry“, „K ověření advokátem“ a „Příloha pro advokáta…“ a úvodní rámeček „Návrh připravený jako
podklad…“ se na web ani do tisku nedostanou. Podmíněné bloky `{{#X}}…{{/X}}` / `{{^X}}…{{/X}}` se vyhodnocují
(hodnoty `ne`, prázdno, `—` jsou nepravda); prozaické značky **[VARIANTA …]** / **[při … = …]** renderer
nevyhodnocuje a zobrazují se jako text – jejich převod na `{{#X}}` bloky je samostatná úprava textů.

Zapracovaná rozhodnutí zadavatele: fixní rezervační poplatek za každé kolo započítávaný na cenu,
kauce hotově/terminálem nebo preautorizací karty při převzetí, párování převodů přes Fio, provoz na
subdoméně musteru, žádné kopie dokladů totožnosti (jen zápis typu a čísla, šifrovaně, s výmazem po vypořádání).

V aplikaci se z těchto šablon renderuje HTML (a tisková verze) dosazením parametrů z nastavení půjčovny;
každá změna textu zvyšuje verzi a nová verze se váže k novým souhlasům.
