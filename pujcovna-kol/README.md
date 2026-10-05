# Půjčovna kol – web s rezervacemi a platbami („muster“ pro více půjčoven)

Zatím **jen plán a rešerše**, žádný kód. Cíl: vizuálně výrazný web půjčovny kol s rezervačním systémem,
přehledem kol, rezervačním poplatkem za kolo (odečítá se při finální platbě), platbami kartou / převodem /
QR Platbou, mapou cyklostezek a tipy na výlety v okolí, obchodními podmínkami a ochranou osobních údajů.
Jedna šablona ve třech odlišných designech, nasazovaná pro více nezávislých půjčoven; bezpečnost dat je
první priorita.

- **[PLAN.md](PLAN.md)** – jak postupovat: rozhodnutí, architektura, datový model, rezervační tok, platby,
  bezpečnost, GDPR, mapa, tři designy, admin, provoz, fáze a odhad, otevřené otázky, rizika.
- **[docs/vyzkum/](docs/vyzkum/)** – rešerše veřejných GitHub projektů a dokumentace (5. 10. 2026):
  1. [open-source půjčovny a rezervační systémy](docs/vyzkum/01-open-source-pujcovny.md)
  2. [platby v ČR – SPAYD, banky, brány, PCI DSS, právo záloh](docs/vyzkum/02-platby-cr.md)
  3. [bezpečnost, GDPR, obchodní podmínky](docs/vyzkum/03-bezpecnost-gdpr-podminky.md)
  4. [mapa cyklostezek a zajímavosti](docs/vyzkum/04-mapa-cyklostezek-a-zajimavosti.md)
  5. [stack, theming, tři designy](docs/vyzkum/05-stack-theming-designy.md)

Navazuje na ostatní projekty v repozitáři: datová pipeline a Leaflet z [Cyklo & Ski mapy](../cyklo-ski-mapa/),
backend bez závislostí, `node:sqlite`, admin a nasazení z [Cenotvorby](../repricing/).
