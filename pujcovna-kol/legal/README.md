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

**Průřezové body k rozhodnutí (opakují se ve více dokumentech):**

1. **Režim dokladu totožnosti** – § 39 písm. d) zákona č. 269/2021 Sb. zakazuje zpracovávat údaje z občanského
   průkazu bez souhlasu držitele. Varianta **A** (zápis typu a čísla se souhlasem daným předložením a podpisem;
   u pasu/ŘP oprávněný zájem) je rozpracována ve všech dokumentech; varianta **B** (bez čísla dokladu, místo něj
   datum narození a adresa) zatím jen v Zásadách a Záznamech (parametr `{{DOKLAD_REZIM}}`). Po rozhodnutí doplnit
   variantu B i do Obchodních podmínek a Smlouvy o nájmu.
2. **Právní povaha ponechané části rezervačního poplatku a její DPH** – OP používají paušální vypořádání zálohy
   (§ 1807 OZ); alternativy smluvní pokuta / odstupné; režim DPH u storna zákazníkem vs. no-show (SDEU C-277/05,
   C-250/14) – rozhodnout s advokátem i daňovým poradcem, promítnout do parametru `{{STORNO_DPH_REZIM}}`.
3. **Zjednodušený daňový doklad** (§ 30 ZDPH) u plátce pro platby do 10 000 Kč – potvrdit, že vyhovuje i pro
   konečný a opravný doklad; usnadní výmaz osobních údajů.
4. **Limit odpovědnosti a smluvní pokuta** ve zpracovatelské smlouvě (§ 2898 OZ u slabší strany) – rozhodnutí zadavatele.
5. **Vyvratitelné domněnky o stavu kola** v protokolu a strop náhrady obvyklou cenou kola (§ 1814 písm. l), § 2969 OZ).

**Slovník parametrů:** dokumenty používají 210 placeholderů; lhůty jsou sjednoceny na `{{DOBA_*}}`. Zbývá
při stavbě rendereru sloučit dvojice `{{PLATEBNI_BRANA}}`/`{{PLATEBNI_BRANA_NAZEV}}`, `{{BANKA}}`/`{{BANKA_NAZEV}}`
a `{{POJISTENI}}`/`{{POJISTOVNA_NAZEV}}` do jediného slovníku (`legal/PARAMETRY.md`, fáze 1) a doplnit
`{{DOKLAD_REZIM}}` do OP a smlouvy o nájmu (bod 1).

Zapracovaná rozhodnutí zadavatele: fixní rezervační poplatek za každé kolo započítávaný na cenu,
kauce hotově/terminálem nebo preautorizací karty při převzetí, párování převodů přes Fio, provoz na
subdoméně musteru, žádné kopie dokladů totožnosti (jen zápis typu a čísla, šifrovaně, s výmazem po vypořádání).

V aplikaci se z těchto šablon renderuje HTML (a tisková verze) dosazením parametrů z nastavení půjčovny;
každá změna textu zvyšuje verzi a nová verze se váže k novým souhlasům.
