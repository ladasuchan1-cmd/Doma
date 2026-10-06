# Půjčovna kol – web s rezervacemi a platbami („muster“ pro více půjčoven)

Proklikávací **demo** fiktivní „Půjčovny kol U Tří dubů“ v Třeboni na doménách `ksprehledy.cz`
(`outdoor.`, `sport.`, `family.` subdomény = tři designy). Demo je **první verze ostré aplikace**: architektura,
bezpečnost a datový model jsou podle [PLAN.md](PLAN.md) a závazné [specifikace dema](docs/SPEC-DEMO.md).
Mockované jsou jen externí služby – karetní brána (simulační stránka), bankovní API (tlačítko „simulovat příchozí
platbu“), e-maily (tabulka `outbox` zobrazená v adminu) a Mapy.cz (bez klíče → CyclOSM). Žádné reálné osoby,
žádné smyšlené recenze, obrázky jen CC0 / CC BY z Wikimedia Commons s uvedenou attribution (stránka `/fotografie`
generovaná z `public/img/demo/*/ATTRIBUTION.md`, odkaz v patičce; u zajímavostí přímo u obrázku).

## Jak spustit

Vyžaduje **Node ≥ 22.13** (vestavěný `node:sqlite`). Žádné `npm install` – projekt nemá npm závislosti.

```sh
cd pujcovna-kol
npm start                # http://localhost:8092 – v demo režimu se prázdná DB při startu sama naplní demo daty
npm run demo-data        # ruční naplnění / doplnění (idempotentní; --reset smaže data a naplní znovu)
```

V demo režimu (`PK_DEMO=1`) server při startu zkontroluje tabulku `bike_types`; je-li prázdná (první start, nový svazek),
zavolá `tools/demo-data.js` sám a zaloguje to (`PK_DEMO_AUTOSEED=0` vypne). Designy přepíná plovoucí přepínač vpravo
dole, `?design=outdoor|sport|family`, nebo subdoména. Galerie všech komponent ve zvoleném designu:
`http://localhost:8092/design`.

Další skripty: `npm test` (node --test), `npm run dev` (watch), `npm run check-contrast` (WCAG kontrast tokenů
témat), `npm run build-okoli` (sestavení tras a zajímavostí okolí), `npm run e2e` (Playwright průchod ve 3 designech,
viz níže).

### Nabídkový konfigurátor a ceny

`/nabidka` (Pro hotely a půjčovny) počítá z `config/nabidka.json` – **veřejného** ceníku (prodejní ceny tříd, web, správa,
servis, doplňky, interní nákladové parametry). **Nákupní ceny kol v něm nejsou a nesmí být** (validace soubor
s `nakupniCena` odmítne): čtou se z interního souboru mimo git – `PK_NABIDKA_INTERNI`, jinak `$PK_DATA/nabidka.interni.json`
nebo `config/nabidka.interni.json` (oba v `.gitignore`); vzor `config/nabidka.interni.example.json` má ukázkové hodnoty.
Bez souboru se nákupní cena odvodí z prodejní a prahu marže a interní blok (jen přihlášený správce) to označí. Konkrétní
modely flotily s veřejnými cenami výrobce jsou v `config/kola-modely.json` – zobrazují se na `/nabidka` a demo seed z nich
dělá typy kol (`/kola`, ilustrační fotky CC BY). Nasazení interního souboru na server: `NASAZENI.md` kap. 6b.

### Weby klientů (průvodce) a správa platformy

Nová půjčovna si web založí sama průvodcem `/zalozeni/<token>` (7 kroků, odkaz z pozvánky). Pozvánky a přehled klientů
jsou ve správě platformy `/platforma` – zapíná ji `PK_PLATFORMA_HESLO` (min. 12 znaků; demo heslo administrace je
veřejné, proto má platforma vlastní přihlášení). Weby klientů leží v `$PK_DATA/klienti/<slug>/` a běží na
`<slug>.<PK_KLIENTI_DOMENA>` (výchozí `PK_DOMAIN`); nemají demo chování (veřejné demo heslo, přepínač designů, noční
reset), v náhledovém provozu jen simulované platby a pruh „náhledový provoz“. Lokálně si průvodce vyzkoušíte:

```sh
PK_PLATFORMA_HESLO=heslo-platformy-123 npm start      # http://localhost:8092/platforma → pozvánka → odkaz
curl -H 'Host: <slug>.ksprehledy.cz' http://localhost:8092/   # web klienta po dokončení průvodce
```

Nasazení na server (DNS wildcard, secret, synchronizace subdomén do Caddy): `NASAZENI.md` kap. 7c.

### Demo přístup do adminu

Administrace běží na `http://localhost:8092/admin` (na ksprehledy.cz na kterékoli subdoméně). V demo režimu je
připravený účet **`demo@ksprehledy.cz` / `kolo-demo-2026`** (role `owner`, TOTP vypnuto); přihlašovací stránka ho
v demu zobrazuje jako „Demo přístup“. Účet vzniká při prvním startu z `PK_ADMIN_USER` / `PK_ADMIN_PASSWORD`
(v demu pevné hodnoty, mimo demo náhodné heslo vytištěné do konzole) a `tools/demo-data.js` ho při každém naplnění
obnoví (heslo, role, odemknutí). Noční reset dema (`PK_RESET_DEMO_HOUR`, výchozí 3:00 Europe/Prague) vrátí všechna
data včetně účtu do výchozího stavu – cokoli v demo adminu změníte, do rána zmizí.

### Co je simulované

Demo je první verze ostré aplikace; mockované jsou **jen externí služby**, vždy s ostrým rozhraním, aby se daly
vyměnit bez zásahu do rezervačního toku:

| Služba | V demu | Kde |
|---|---|---|
| **Karetní brána** | simulační stránka `/simulace-brany/…` označená „SIMULACE – žádné peníze se nepřevádějí“ s tlačítky Zaplatit / Zamítnout / Zrušit; „notifikace“ jde interně a stav se vždy ověří přes `getStatus()` | `src/payments/mock-gateway.js`, provider `mock` v `tenant.json → settings.gateway` |
| **Banka (Fio API)** | platba převodem zobrazí IBAN, VS a SPAYD QR; příchozí pohyb simuluje admin tlačítkem „Simulovat příchozí převod“ (párování podle VS, tolerance ±5 Kč) | `src/payments/fio-mock.js`, `settings.bankMatcher = fio-mock` |
| **E-maily** | neodesílají se – ukládají se do tabulky `outbox` a zobrazují v adminu (E-maily) | `src/mail/outbox.js` |
| **Mapy.cz** | bez `MAPY_API_KEY` je podkladem CyclOSM (OpenStreetMap); výškový profil tras je vypnutý (`elevation: null`) | `src/features/mapa.js`, `tools/build-okoli.js` |
| **Přepínač designů** | cookie `__Host-pk_design` a `?design=`; mimo demo určuje design jen subdoména | `server.js`, `src/features/design.js` |

Zbytek (rezervace, dostupnost, ceník, storno, doklady, doklad totožnosti, admin, bezpečnost) je ostrý kód nad
`node:sqlite`. Peníze se v demu nikde nepřevádějí; patička každé stránky to připomíná.

### E2E průchod (Playwright)

`npm run e2e` spustí `tools/e2e.js`: na volném portu nastartuje server s dočasnými daty, pro každé téma projde
veřejné stránky a rezervační tok, hlídá chyby konzole, porušení CSP, odpovědi 5xx a nerozvinuté `{{…}}` a ukládá
screenshoty do `dist/screenshots/<tema>-<stranka>.png` (není v gitu). Parametry:

| Parametr | Význam |
|---|---|
| `--design=outdoor\|sport\|family` | jen jedno téma (výchozí všechna tři) |
| `--url=http://host:port` | netestovat vlastní server, ale už běžící (musí mít demo data) |
| `--out=dist/screenshots` | kam ukládat screenshoty |
| `--bez-rezervace` | přeskočit rezervační tok |
| `--mapa` | kliknout i na „Načíst mapu“ (externí dlaždice – vyžaduje síť) |

Projekt má 0 npm závislostí, proto se **Playwright bere z globální instalace**: `require('playwright')` musí být
dostupné (např. `npm i -g playwright` + `NODE_PATH`), prohlížeč z `PLAYWRIGHT_BROWSERS_PATH` (adresář s
`chromium-*`; zde `/opt/pw-browsers`) nebo přímo `PK_E2E_CHROME=/cesta/k/chrome`. Časový limit kroku nastaví
`PK_E2E_TIMEOUT` (ms). Bez Playwrightu nebo prohlížeče skript skončí s kódem 2 a vysvětlením.

## Proměnné prostředí

| Proměnná | Výchozí | Význam |
|---|---|---|
| `PORT` | `8092` | port HTTP serveru |
| `HOST` | `0.0.0.0` | adresa, na které server poslouchá |
| `PK_DATA` | `./data` | datový adresář: `tenants/<slug>.db`, `.secret` |
| `PK_TENANTS` | `./tenants` | adresář tenantů (`<slug>/tenant.json`, `logo.svg`, `okoli.json`) |
| `PK_DEMO` | `1` | demo režim: přepínač designu, simulace plateb, demo přihlášení, noční reset dat |
| `PK_TRUST_PROXY` | `0` | `1` za reverzní proxy (Caddy): IP z `X-Forwarded-For`, Secure cookies a HSTS podle `X-Forwarded-Proto` |
| `PK_SECRET` | – | klíč pro HMAC a šifrování polí; chybí-li, vygeneruje se do `$PK_DATA/.secret` (práva 600) |
| `PK_ADMIN_USER` | `demo@ksprehledy.cz` | e-mail výchozího správce při prvním startu |
| `PK_ADMIN_PASSWORD` | `kolo-demo-2026` v demu | heslo správce; mimo demo bez hodnoty se vygeneruje a vypíše do konzole |
| `PK_RESET_DEMO_HOUR` | `3` | hodina nočního resetu demo dat (Europe/Prague); prázdné = vypnuto |
| `PK_DEMO_AUTOSEED` | `1` | v demo režimu při startu naplnit demo data, je-li tabulka `bike_types` prázdná; `0` = nenaplňovat |
| `APP_VERSION` | verze z `package.json` | verze do patičky a `?v=` u statických souborů |
| `LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` · `silent` (JSON log bez osobních údajů) |

## Struktura

```
server.js                 vstup: tenanty → DB + migrace → admin → features → jobs → listen; GET /api/health
src/config.js log.js      env a cesty; JSON logger bez PII
src/db.js                 node:sqlite, MIGRATIONS[] (celé schéma), nowIso/bind/parseJson/transaction, openTenantDb
src/tenants.js themes.js  tenant podle hostu, settings → DB; presety tří designů
src/crypto/               passwords (scrypt), fields (AES-256-GCM, HMAC e-mailu), totp (RFC 6238), tokens (HMAC)
src/http/                 router, context (ctx), session (__Host-pk_sid / __Host-pk_adm), csrf, ratelimit, headers (CSP), static, errors
src/render/               html`` (escapování), layout, components (SPEC kap. 6), format (Kč, data, Europe/Prague), pages/
src/features/             home, kontakt, design (demo), kola, rezervace, pravni, mapa – další přidávají moduly platby a admin
src/jobs.js               registr periodických úloh (feature exportuje jobs: [{ name, everyMs, fn }])
src/vendor/qrcode.js      qrcode-generator 1.4.4 (MIT) pro SPAYD QR
public/base.css           tokeny ve 3 vrstvách + všechny komponenty; public/themes/*.css = témata
public/fonts/             self-hostované OFL fonty (woff2, latin + latin-ext) + fonts.css
public/vendor/            Leaflet 1.9.4, Leaflet.markercluster 1.5.3 (LICENSES.md)
tenants/demo/             tenant.json (konfigurace půjčovny), logo.svg (vkládá se inline, obarvitelné přes CSS color), okoli.json
legal/                    právní texty (renderují se za běhu)
tools/                    demo-data.js, check-contrast.js, build-okoli.js, e2e.js
test/                     node --test; helpers.js spustí server na náhodném portu s dočasnými daty
docs/                     SPEC-DEMO.md (závazná specifikace), TODO-INTEGRACE.md, vyzkum/
```

Konvence: CommonJS, `'use strict'`, identifikátory anglicky, komentáře a UI česky, peníze v haléřích, časy ISO UTC,
žádný inline JS/CSS (CSP bez `unsafe-inline`), veškerý HTML výstup přes `html\`\``. Vlastnictví souborů mezi agenty
popisuje SPEC kap. 16; požadavky na změny v cizích souborech se zapisují do [docs/TODO-INTEGRACE.md](docs/TODO-INTEGRACE.md).

## Dokumentace

- **[docs/SPEC-DEMO.md](docs/SPEC-DEMO.md)** – závazná specifikace dema (technologie, HTTP vrstva, DB schéma, komponenty, theming, features, doména, platby, právní texty, mapa, admin, demo data, nasazení, vlastnictví).
- **[PLAN.md](PLAN.md)** – plán: rozhodnutí, architektura, datový model, rezervační tok, platby, bezpečnost, GDPR, mapa, tři designy, admin, provoz, fáze, rizika.
- **[legal/](legal/README.md)** – návrhy právních textů k advokátní kontrole: obchodní podmínky, zásady ochrany osobních údajů, zpracovatelská smlouva, záznamy o činnostech zpracování, smlouva o nájmu s předávacím protokolem.
- **[docs/vyzkum/](docs/vyzkum/)** – rešerše (5. 10. 2026):
  1. [open-source půjčovny a rezervační systémy](docs/vyzkum/01-open-source-pujcovny.md)
  2. [platby v ČR – SPAYD, banky, brány, PCI DSS, právo záloh](docs/vyzkum/02-platby-cr.md)
  3. [bezpečnost, GDPR, obchodní podmínky](docs/vyzkum/03-bezpecnost-gdpr-podminky.md)
  4. [mapa cyklostezek a zajímavosti](docs/vyzkum/04-mapa-cyklostezek-a-zajimavosti.md)
  5. [stack, theming, tři designy](docs/vyzkum/05-stack-theming-designy.md)
  6. [výběr platební brány podle ceny, údržby a bezpečnosti](docs/vyzkum/06-vyber-platebni-brany.md)
  7. [subdomény `<slug>.pujcovna.cz`, TLS a limity](docs/vyzkum/07-domeny-a-tls.md)
- **[NASAZENI.md](NASAZENI.md)** – nasazení na Hetzner + Caddy pro ksprehledy.cz (DNS, `deploy/hetzner.sh`, Docker
  Compose, zálohy, aktualizace; SPEC kap. 15). Kontejnerové soubory jsou v [deploy/](deploy/).

Navazuje na ostatní projekty v repozitáři: datová pipeline a Leaflet z [Cyklo & Ski mapy](../cyklo-ski-mapa/),
backend bez závislostí, `node:sqlite`, admin a nasazení z [Cenotvorby](../repricing/).
