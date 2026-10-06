# Půjčovna kol – web s rezervacemi a platbami („muster“ pro více půjčoven)

Proklikávací **demo** fiktivní „Půjčovny kol U Tří dubů“ v Třeboni na doménách `ksprehledy.cz`
(`outdoor.`, `sport.`, `family.` subdomény = tři designy). Demo je **první verze ostré aplikace**: architektura,
bezpečnost a datový model jsou podle [PLAN.md](PLAN.md) a závazné [specifikace dema](docs/SPEC-DEMO.md).
Mockované jsou jen externí služby – karetní brána (simulační stránka), bankovní API (tlačítko „simulovat příchozí
platbu“), e-maily (tabulka `outbox` zobrazená v adminu) a Mapy.cz (bez klíče → CyclOSM). Žádné reálné osoby,
žádné smyšlené recenze, obrázky jen CC0 / CC BY z Wikimedia Commons s uvedenou attribution.

## Jak spustit

Vyžaduje **Node ≥ 22.13** (vestavěný `node:sqlite`). Žádné `npm install` – projekt nemá npm závislosti.

```sh
cd pujcovna-kol
npm run demo-data        # naplní data/tenants/demo.db demo daty (idempotentní; --reset smaže a naplní znovu)
npm start                # http://localhost:8092
```

Admin: `http://localhost:8092/admin`, demo přístup `demo@ksprehledy.cz` / `kolo-demo-2026` (jen v demo režimu).
Designy přepíná plovoucí přepínač vpravo dole, `?design=outdoor|sport|family`, nebo subdoména. Galerie všech
komponent ve zvoleném designu: `http://localhost:8092/design`.

Další skripty: `npm test` (node --test), `npm run dev` (watch), `npm run check-contrast` (WCAG kontrast tokenů
témat), `npm run build-okoli` (sestavení tras a zajímavostí okolí), `npm run e2e` (Playwright průchod ve 3 designech).

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
src/features/             home, kontakt, design (demo) – další features přidávají ostatní moduly (kola, rezervace, platby, mapa, pravni, admin)
src/jobs.js               registr periodických úloh (feature exportuje jobs: [{ name, everyMs, fn }])
src/vendor/qrcode.js      qrcode-generator 1.4.4 (MIT) pro SPAYD QR
public/base.css           tokeny ve 3 vrstvách + všechny komponenty; public/themes/*.css = témata
public/fonts/             self-hostované OFL fonty (woff2, latin + latin-ext) + fonts.css
public/vendor/            Leaflet 1.9.4, Leaflet.markercluster 1.5.3 (LICENSES.md)
tenants/demo/             tenant.json (konfigurace půjčovny), logo.svg
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
- Nasazení na Hetzner + Caddy popíše `NASAZENI.md` (připravuje modul provoz, viz SPEC kap. 15).

Navazuje na ostatní projekty v repozitáři: datová pipeline a Leaflet z [Cyklo & Ski mapy](../cyklo-ski-mapa/),
backend bez závislostí, `node:sqlite`, admin a nasazení z [Cenotvorby](../repricing/).
