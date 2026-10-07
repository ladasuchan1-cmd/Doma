# Mapa prodejen a servisů kol

Obchodní nástroj na **https://mapa.ksprehledy.cz**: **interaktivní mapa ČR (kraje → okresy)** se všemi
**prodejnami kol, servisy, půjčovnami, bazary a sportovními řetězci** a s **firmami z ARES**, které mají kola
v názvu. Každé místo má **velikost firmy** (podle obratu, jinak podle počtu zaměstnanců z ARES / ČSÚ), kontakty,
nabízené služby (servis, e-kola, půjčovna, bazar, e-shop) a značky kol z webu. Nad tím:

- **Objednávky a zákazníci podle obcí** – tabulka vložená z Excelu (i kontingenční: nadpis a filtry, řádky
  Celkem, dvě tabulky vedle sebe) nebo export z e-shopu (CSV / XLSX) se zpracuje v prohlížeči, na server jdou jen
  součty podle PSČ (objednávky, zákazníci, aktivní zákazníci, částka). Mapa ukáže obce a okresy podle zvolené
  veličiny a **bílá místa** – obce s objednávkami či zákazníky, kde není partner ani naše prodejna.
- **Hledání partnerů** – kandidáti seřazení podle **skóre 0–100** (objednávky v okolí, servis, nepokryté
  okolí, kontakt) a **evidence spolupráce**: vytipováno → osloveno → voláno → schůzka → partner / nemá zájem,
  typ spolupráce (servis, výdejní místo, prodej), kontaktní osoba, poznámka – sdílené pro celý tým.

```
 OpenStreetMap (Overpass) ─────┐  prodejny, servisy, půjčovny, bazary, řetězce (shop=bicycle, service:bicycle:*…)
 ARES + RES (ČSÚ) ─────────────┤  firmy s koly v názvu, IČO → název, sídlo, CZ-NACE, kategorie počtu zaměstnanců
 weby prodejen ────────────────┤  e-maily, telefony, IČO, služby, značky kol
 ČÚZK RÚIAN ───────────────────┤  hranice krajů, okresů a obcí, adresní místa sídel
 GeoNames ─────────────────────┤  PSČ → obec, počty obyvatel
                               ▼
                 tools/build-data.js  →  data/*.js   (měsíčně v GitHub Actions)
                               ▼
     index.html + app.js (Leaflet)  ·  server.js (přihlášení, sdílená data týmu, ARES a RÚIAN na požádání)
```

## Dokumentace

| Pro koho | Kde |
|---|---|
| Obchodní tým | [docs/MANUAL.md](docs/MANUAL.md) – ovládání, velikost firem, objednávky a zákazníci (vložení tabulky z Excelu), města a bílá místa, partneři a skóre, evidence spolupráce, export |
| Kdo chce rozumět datům | [docs/METODIKA.md](docs/METODIKA.md) – zdroje a dotazy, výběr firem z ARES, párování IČO, velikost, PSČ → obec, výpočet skóre, omezení |
| Správce serveru | [NASAZENI.md](NASAZENI.md) – zapnutí nasazení z GitHubu, uživatelé, Cloudflare, zálohy, návrat zpět |

Při změně chování se dokumentace mění spolu s kódem: ovládání → `docs/MANUAL.md`, výpočet nebo zdroj dat →
`docs/METODIKA.md` (změnu metodiky **datovat**), nasazení → `NASAZENI.md`.

## Spuštění

Nejjednodušší je otevřít `index.html` v prohlížeči – data jsou v `data/`, Leaflet ve `vendor/`, internet je
potřeba jen na mapové podklady. Stav spolupráce, objednávky a ručně přidaná místa se pak ukládají jen do
prohlížeče (localStorage) a nejde dohledávat v ARES.

Pro tým a web slouží `server.js` (Node.js 22+, bez závislostí):

```bash
cd mapa-prodejen
MP_USERS="lada:heslo;obchod:heslo2" npm start   # http://localhost:8094 – přihlášení, data týmu v ./server-data
MP_AUTH=0 npm start                             # bez přihlášení (jen vývoj / vnitřní síť)
```

Proměnné popisuje `.env.example` (`MP_USERS` / `MP_PASSWORD`, `MP_SESSION_DAYS`, `MP_TRUST_PROXY`, `MP_TOKEN`,
`MP_SECRET`, `MP_DATA`, `MP_REGISTRY`, `PORT`). Server ukládá do `MP_DATA`: `stav.json` (spolupráce),
`objednavky.json` (součty podle PSČ), `mista.json` (ručně přidaná místa), `obraty.json`, `firmy.json`
(firmy dohledané v ARES) a `nastaveni.json` (IČO naší firmy).

**Web na mapa.ksprehledy.cz** běží na stejném serveru jako Cyklo & Ski mapa, za její Caddy a za Cloudflare –
zapnutí a provoz popisuje **[NASAZENI.md](NASAZENI.md)**.

## Data

```bash
npm run build-data                         # použije cache/, chybějící zdroje stáhne, nové weby projde (poprvé ≈ 20–30 min)
node tools/build-data.js --fetch           # vše znovu (OSM, ARES, RÚIAN, PSČ, weby) – takhle běží měsíční obnova
node tools/build-data.js --bez-webu        # bez procházení webů (jen z cache)
node tools/build-data.js --web-limit 50    # projde jen 50 dosud neprojitých webů
```

Stažené zdroje jsou v `cache/` (≈ 20 MB, mimo git). Výsledek – `data/hranice.js`, `mista.js`, `firmy.js`,
`weby.js`, `psc.js`, `obce.js`, `meta.js` (≈ 2,5 MB) – je v gitu. Workflow **„Mapa prodejen – obnova dat“**
ho 1. den v měsíci sestaví znovu, commitne do hlavní větve a spustí nasazení. Data týmu na serveru se obnovy
netýkají.

Stav k 7. 10. 2026: **1 210 míst** (763 prodejen, 14 servisů, 57 půjčoven, 144 prodejen sportovních řetězců,
232 firem z ARES jen se sídlem), **533 s IČO**, 502 firem z ARES; velikost: 13 velkých, 59 středních, 219 malých,
96 mikro, 823 neznámých (hlavně místa bez IČO). Podrobně [docs/METODIKA.md](docs/METODIKA.md).

## Struktura

```
index.html, app.js, styles.css   aplikace (bez buildu, běžné skripty – funguje i z file://)
login.js, favicon.svg            přihlašovací stránka
lib/velikost.js                  kategorie velikosti (obrat / zaměstnanci ČSÚ), čtení obratu „45 mil“
lib/objednavky.js                rozpoznání sloupců a tabulek, součty podle PSČ, storno, zahraničí, obce podle názvu
                                 (přívlastky „u Prahy“, zkratky „p.R.“, jmenovci), kontrola dat pro server
lib/partneri.js                  vzdálenosti, mřížkový index, poptávka v okruhu, skóre partnera, obce, bílá místa
lib/stav.js                      evidence spolupráce (stavy, typ spolupráce, sloučení, import/export, efektivní kontakt)
lib/vlastni.js                   ručně přidaná místa a obraty (kontrola IČO, polohy, polí)
lib/xlsx.js                      čtení XLSX bez knihoven (první list, sdílené řetězce, data)
lib/contacts.js                  e-maily, telefony, IČO, služby a značky z HTML webů
lib/ares.js                      ARES, RES, RÚIAN (jen server a sestavení dat – do prohlížeče se neposílá)
lib/geo.js, lib/csv.js           geometrie (bod v polygonu, vzdálenosti), CSV (Excel, BOM, ;)
tools/build-data.js              sestavení dat (tools/lib/sources.js = dotazy a URL zdrojů)
server.js                        web: přihlášení, statika (gzip, CSP), API pro data týmu, ARES/RÚIAN na požádání
Dockerfile, deploy/              kontejner, skript nasazení na server (server.sh), blok pro Caddy
data/                            vygenerovaná data
vendor/                          Leaflet 1.9.4
test/                            node --test (knihovny, server, konzistence dat)
```

```bash
npm test      # 88 testů: knihovny, XLSX, import tabulek a hledání obcí, server (přihlášení, API, uložení,
              # ochrana cest), konzistence dat
```

## Omezení

- **Obrat ARES neuvádí.** Velikost je proto u většiny firem podle kategorie počtu zaměstnanců (ČSÚ); obrat
  z účetních závěrek (justice.cz) nebo z placené databáze se dá nahrát tabulkou nebo zadat ručně.
- **Úplnost míst odpovídá OpenStreetMap** a firmám, které mají kola v obchodním jméně. Prodejna, která v OSM
  chybí a jmenuje se „Novák s.r.o.“, v datech není – přidá se tlačítkem **+ Místo** (s IČO z ARES).
- Místa typu „firma z ARES“ leží v **sídle firmy**, které nemusí být prodejnou.
- IČO s příznakem **„?“** je odhad podle jména a obce – před oslovením ověřit (odkaz ARES v detailu).
- Zhruba čtvrtina webů se automaticky načíst nedá (blokují roboty, neexistují) – kontakty pak jen z OSM.
