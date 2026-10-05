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

Jak vznikly: návrh → dvě nezávislé oponentury (právo ČR: OZ, ochrana spotřebitele, DPH, doklady;
GDPR, stanoviska ÚOOÚ a praktičnost) → zapracování nálezů. Podklady: [rešerše 02 – platby, zálohy
a DPH](../docs/vyzkum/02-platby-cr.md) a [rešerše 03 – bezpečnost, GDPR, praxe půjčoven](../docs/vyzkum/03-bezpecnost-gdpr-podminky.md).

Zapracovaná rozhodnutí zadavatele: fixní rezervační poplatek za každé kolo započítávaný na cenu,
kauce hotově/terminálem nebo preautorizací karty při převzetí, párování převodů přes Fio, provoz na
subdoméně musteru, žádné kopie dokladů totožnosti (jen zápis typu a čísla, šifrovaně, s výmazem po vypořádání).

V aplikaci se z těchto šablon renderuje HTML (a tisková verze) dosazením parametrů z nastavení půjčovny;
každá změna textu zvyšuje verzi a nová verze se váže k novým souhlasům.
