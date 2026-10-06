# SPEC-DEMO – proklikávací demo musteru „Půjčovna kol“ na ksprehledy.cz

Závazná specifikace pro stavbu první verze aplikace (demo). Platí pro všechny, kdo do složky
`pujcovna-kol/` píší kód. Kde se tato specifikace liší od [PLAN.md](../PLAN.md), platí specifikace
(je novější a konkrétnější). Stav: 5. 10. 2026.

## 0. Účel a hranice

- **Demo = první verze ostré aplikace, ne prototyp na vyhození.** Architektura, bezpečnost a datový model jsou podle PLAN.md. Mockované jsou **jen externí služby**: karetní brána (simulační stránka), bankovní API Fio (tlačítko „simulovat příchozí platbu“ v adminu), odesílání e-mailů (ukládají se do tabulky `outbox` a zobrazují v adminu), Mapy.cz (bez klíče → podklad CyclOSM/OSM), výškový profil (vypnutý bez klíče).
- **Rozhodnutí zadavatele (5. 10. 2026), která demo musí odrážet:**
  1. **Souhlas se zápisem dokladu totožnosti je podmínkou pronájmu, bez výjimky.** Při rezervaci zákazník potvrdí, že při převzetí předloží platný doklad a půjčovna si zapíše jeho typ a číslo; bez toho rezervaci nelze dokončit a kolo se nevydá. Argumentace v textech: ověření totožnosti a **platnosti dokladu** (kontrola v databázi neplatných dokladů Ministerstva vnitra) a **rostoucí krádeže jízdních kol v ČR** (doložit statistikou Policie ČR s uvedením zdroje a roku).
  2. **Rezervační poplatek je úplata za zajištění služby** (blokaci kol na termín). Při řádném využití se **započítá na nájemné**; při zrušení **po uplynutí storno lhůty** nebo při nevyzvednutí **propadá**. Výchozí storno lhůta: zrušení **nejméně 48 h před začátkem** → poplatek se vrací celý; později → propadá. Lhůta je parametr půjčovny.
  3. **Zjednodušený daňový doklad** (§ 30 ZDPH) u plátce DPH pro platby do 10 000 Kč; nad tuto částku běžný daňový doklad.
- **Domény dema:** `ksprehledy.cz`, `www.ksprehledy.cz`, `outdoor.ksprehledy.cz`, `sport.ksprehledy.cz`, `family.ksprehledy.cz` a `localhost`. Subdoména určuje výchozí design, přepínač `?design=` ho přebije (jen v demo režimu).
- **Jediný tenant `demo`:** fiktivní „Půjčovna kol U Tří dubů“, Třeboň (Masarykovo nám. 1, 379 01 Třeboň; 49.0035 N, 14.7708 E). Žádné reálné osoby, žádné vymyšlené recenze zákazníků.

## 1. Technologie a konvence

- **Node ≥ 22.13**, CommonJS, `'use strict'`, `require('node:*')`. Spouštění s `--disable-warning=ExperimentalWarning` (kvůli `node:sqlite`). **0 npm závislostí** – `package.json` nemá `dependencies` ani `devDependencies`. Playwright pro e2e se používá z globální instalace (`require('playwright')` funguje v tomto prostředí; Chromium v `/opt/pw-browsers`), skript `tools/e2e.js` ho jen volá.
- **Vendorované knihovny** (zkopírované, s licencí): Leaflet 1.9.4 + Leaflet.markercluster 1.5.3 z `../cyklo-ski-mapa/vendor/` → `public/vendor/leaflet/`, `public/vendor/markercluster/`; qrcode-generator 1.4.4 (MIT, Kazuhiko Arase) → `src/vendor/qrcode.js` + `src/vendor/qrcode.LICENSE` (stáhnout z `https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js`, ověřit hlavičku licence).
- **Jazyk:** identifikátory v kódu a DB anglicky, komentáře, UI texty, chybové hlášky a dokumentace česky. Každý soubor začíná komentářem, co dělá a jaké má vstupy (vzor `../repricing/src/db.js`).
- **Peníze** v haléřích (`*_minor`, INTEGER); **časy** v DB jako ISO 8601 UTC (`2026-07-01T08:00:00.000Z`), zobrazení v `Europe/Prague` přes `Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', … })`.
- **Testy:** `node --test "test/**/*.test.js"`; každý modul má testy; `npm test` musí projít před každým commitem. `test/helpers.js` (kostra) umí spustit server na náhodném portu s dočasným datovým adresářem a demo daty a vrátit `fetch` helper s cookie jar.
- **Žádný inline JS ani CSS v HTML** (CSP bez `unsafe-inline`). Data pro klientský JS předávat přes `data-*` atributy nebo JSON endpointy `/api/v1/...`. Skripty vždy `<script src="…" defer>`.
- **Escapování:** veškerý HTML výstup přes tagged template `html` (kap. 6); `raw()` jen pro fragmenty, které už escapované jsou (výstup markdown rendereru, komponenty).
- **Logování** přes `src/log.js`: JSON řádky bez osobních údajů (nikdy e-mail, jméno, telefon, číslo dokladu, tokeny, hesla, `secret`).
- **Commit konvence:** malé commity s českou zprávou ve stylu repozitáře („Půjčovna kol: …“). Před commitem `npm test`.

## 2. Struktura složek

```
pujcovna-kol/
  package.json              name "pujcovna-kol", scripts: start, dev (--watch), test, demo-data, build-okoli, e2e
  server.js                 vstup (kap. 3)
  src/
    config.js               čtení env, cesty, konstanty
    log.js                  JSON log bez PII
    db.js                   node:sqlite, migrace (kap. 4), otevření tenant DB
    tenants.js              načtení tenants/*/tenant.json, host → tenant, theme podle hostu
    themes.js               presety 3 designů (kap. 7)
    crypto/
      passwords.js          scrypt hash/verify (formát scrypt$N$r$p$salt$hash – převzít z ../repricing)
      fields.js             AES-256-GCM šifrování polí: enc(plaintext) → 'k1:' + base64(nonce|cipher|tag); dec(); hmacEmail()
      totp.js               RFC 6238 TOTP (SHA-1, 30 s, 6 číslic), generování secretu, otpauth URL
      tokens.js             podepsané tokeny (HMAC-SHA256, expirace) pro odkazy „správa rezervace“, náhodná ID
    http/
      router.js             route registry, matching :param, 405/404
      context.js            ctx: parsování těla, cookies, session, csrf, render, redirect, json
      session.js            server-side session v tabulce sessions, cookie __Host-pk_sid
      csrf.js               synchronizer token + kontrola Origin / Sec-Fetch-Site
      ratelimit.js          in-memory token bucket per IP a klíč
      headers.js            bezpečnostní hlavičky, CSP
      static.js             statické soubory z public/, MIME, cache, gzip/brotli
      errors.js             404/500 stránky
    render/
      html.js               html``, raw(), escape, attr, joinHtml
      layout.js             <html data-theme …>, hlavička, navigace, patička, skripty/styly features
      components.js         komponenty (kap. 6)
      markdown.js           markdown → HTML + šablonování {{…}} (kap. 11)
      format.js             formátování Kč, dat, časů, délek
      pages/                stránky features (každá feature své soubory: home.js, kola.js, rezervace.js, …)
    domain/
      pricing.js            cena za typ a termín (kap. 9)
      availability.js       dostupnost (kap. 9)
      reservations.js       stavový automat rezervace, číslo rezervace (VS)
      cancellation.js       storno engine (kap. 9)
      documents.js          doklady (číselné řady, zjednodušený daňový doklad, HTML)
    payments/
      provider.js           rozhraní PaymentProvider + registry podle tenant.settings
      mock-gateway.js       simulační brána (kap. 10)
      bank-transfer.js      SPAYD řetězec, IBAN z čísla účtu, QR SVG
      fio-mock.js           simulace příchozího pohybu + párování podle VS
      ledger.js             ledger_entries
    mail/
      outbox.js             zápis do outbox + render šablon
      templates.js          potvrzení rezervace, připomínka, storno, doklad
    features/
      home.js kola.js rezervace.js platby.js mapa.js pravni.js kontakt.js design.js admin.js
    jobs.js                 expirace, auto-uvolnění kauce, retence, nightly reset dema
    vendor/qrcode.js, vendor/qrcode.LICENSE
  public/
    base.css                tokeny + komponenty (kap. 7)
    themes/outdoor.css sport.css family.css
    css/<feature>.css       jen styly specifické pro feature, přes tokeny
    js/<feature>.js         progresivní JS (kalendář, filtry, mapa, checkout, admin)
    fonts/                  self-host (OFL), subset latin-ext, woff2
    img/demo/               fotky CC0 / CC BY z Wikimedia Commons + ATTRIBUTION.md; img/icons.svg sprite
    vendor/leaflet/ vendor/markercluster/
    admin/                  admin UI (vanilla JS views, převzít vzory z ../repricing/public/lib)
  tenants/demo/
    tenant.json             konfigurace (kap. 5)
    okoli.json              výřez tras + zajímavosti (kap. 12), img/ obrázky zajímavostí
    logo.svg
  legal/                    právní šablony (existují) – renderují se za běhu (kap. 11)
  tools/
    demo-data.js            naplnění demo daty (kap. 14), reset
    build-okoli.js          sestavení tenants/<slug>/okoli.json (kap. 12)
    e2e.js                  Playwright: průchod rezervací ve 3 designech, screenshoty do dist/screenshots/
    check-contrast.js       kontrast tokenů témat (WCAG AA)
  deploy/                   Dockerfile, docker-compose.yml, Caddyfile, hetzner.sh, .env.example (kap. 15)
  test/                     *.test.js + helpers.js
  docs/                     SPEC-DEMO.md (tento), vyzkum/, …
  README.md NASAZENI.md
```

## 3. Server a HTTP vrstva

**Proměnné prostředí** (čte `src/config.js`, výchozí v závorce): `PORT` (8092) · `PK_DATA` (`./data`) · `PK_TENANTS` (`./tenants`) · `PK_DEMO` (`1` = demo režim: přepínač designu, simulace plateb, demo přihlášení, noční reset) · `PK_TRUST_PROXY` (`0`; `1` za Caddy – IP z `X-Forwarded-For`, Secure cookies podle `X-Forwarded-Proto`) · `PK_SECRET` (klíč pro HMAC a šifrování polí; není-li, vygeneruje se a uloží do `$PK_DATA/.secret` s právy 600) · `PK_ADMIN_USER` / `PK_ADMIN_PASSWORD` (výchozí admin při prvním startu; v demu `demo` / náhodné heslo vytištěné do konzole, nebo pevné `kolo-demo-2026`, pokud `PK_DEMO=1`) · `PK_RESET_DEMO_HOUR` (`3` – hodina nočního resetu demo dat; prázdné = vypnuto) · `APP_VERSION`.

**Start:** `node --disable-warning=ExperimentalWarning server.js`. Při startu: načíst tenanty → pro každý otevřít DB a spustit migrace → není-li žádný admin, vytvořit z env → načíst features (`src/features/*.js`) → spustit jobs → poslouchat. Health: `GET /api/health` → `{ ok: true, version, tenant, theme }`.

**Tenant podle hostu:** `Host` bez portu, lowercase, IDN beze změny. `tenants.js` najde tenant, kde `hosts` obsahuje host. Neznámý host → když `PK_DEMO=1`, tenant `demo`; jinak 404 „Půjčovna nenalezena“.

**Design (téma):** `tenant.themeByHost[host] || tenant.themeDefault`. V demo režimu lze přebít cookie `__Host-pk_design` (platnost 30 dní, `Secure` za proxy, `HttpOnly`, `SameSite=Lax`): `GET /design/nastavit?design=sport&zpet=/kola` → ověřit hodnotu proti seznamu témat a `zpet` jen relativní cesta → 302. Téma je dostupné jako `ctx.theme` a atribut `data-theme` na `<html>`.

**Feature modul** (`src/features/<name>.js`) exportuje:

```js
module.exports = {
  name: 'rezervace',
  routes: [
    ['GET', '/rezervace', handler, { rateLimit: 'public' }],
    ['POST', '/rezervace/termin', handler, { csrf: true, rateLimit: 'reservation' }],
  ],
  nav: [{ label: 'Rezervace', href: '/rezervace', order: 30, cta: true }],   // volitelné
  css: ['/css/rezervace.css'],       // načte se jen na stránkách této feature (ctx.render přidá)
  js: ['/js/rezervace.js'],
};
```

**Router** (`src/http/router.js`): `add(method, pattern, handler, opts)`, vzory `/kola/:slug`, `match(method, path)` → `{ handler, params, opts }`; neexistující cesta 404, existující cesta s jinou metodou 405. Handler je `async (ctx) => void`.

**ctx** (`src/http/context.js`): `req`, `res`, `tenant`, `db` (tenant DB), `theme`, `url` (URL objekt), `params`, `query`, `body` (objekt z `application/x-www-form-urlencoded` nebo JSON; limit 256 KB), `cookies`, `session` (lazy: `ctx.session.get()`, `ctx.session.set(key, value)`, `ctx.session.regenerate()`, `ctx.session.destroy()`), `csrfToken()` (hodnota pro hidden input `_csrf`), `ip`, `render(pageFn, data, { status, title, feature })` (zavolá layout; `feature` určuje css/js), `redirect(location, status=303)`, `json(obj, status)`, `html(string, status)`, `notFound()`, `log` (child logger s request id, bez PII).

**Session** (`src/http/session.js`): tabulka `sessions`; cookie `__Host-pk_sid` (32 B náhodně, base64url; v DB jen SHA-256 otisk), `HttpOnly; Secure (za proxy nebo https); SameSite=Lax; Path=/`. Veřejná část: idle 2 h (rozepsaná rezervace), absolutní 24 h. Admin: idle 30 min, absolutní 8 h, `regenerate()` po přihlášení, `SameSite=Strict` pro admin cookie (`__Host-pk_adm`, samostatná session). `destroy()` maže záznam v DB.

**CSRF** (`src/http/csrf.js`): synchronizer token per session (náhodný, uložený v session), hidden `_csrf` u každého formuláře, u JSON API hlavička `X-CSRF-Token`; navíc u každého POST/PUT/DELETE kontrola `Origin` (musí odpovídat hostu) nebo `Sec-Fetch-Site` ∈ {same-origin, none}. Při selhání 403 s českou hláškou.

**Rate limit** (`src/http/ratelimit.js`): in-memory token bucket per `ip + klíč`: `public` 300/15 min, `reservation` 60/15 min, `login` 10/15 min (+ zámek účtu po 10 neúspěších na 15 min), `api` 120/min. Překročení → 429.

**Bezpečnostní hlavičky** (`src/http/headers.js`), vždy:
```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: https://*.tile.openstreetmap.fr https://*.tile-cyclosm.openstreetmap.fr https://tile.openstreetmap.org https://*.tile.opentopomap.org https://api.mapy.cz https://api.mapy.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://payments.comgate.cz; object-src 'none'
Referrer-Policy: strict-origin-when-cross-origin
X-Content-Type-Options: nosniff
Permissions-Policy: geolocation=(self), camera=(), microphone=()
Cross-Origin-Opener-Policy: same-origin
Strict-Transport-Security: max-age=300 (jen za proxy/https; hodnotu později zvýšit dle rešerše 07)
```
Žádná hlavička `Server`/`X-Powered-By`.

**Statické soubory** (`src/http/static.js`): `public/` → `/` (kromě `base.css`, `themes/`, `css/`, `js/`, `fonts/`, `img/`, `vendor/`, `admin/`); MIME tabulka; `Cache-Control: public, max-age=31536000, immutable` pro `/vendor/` a `/fonts/`, `max-age=3600` jinde; URL stylů a skriptů nesou `?v=<APP_VERSION nebo mtime>`; gzip/brotli pro text; žádný listing adresářů; cesty normalizovat (zákaz `..`).

**Chyby** (`src/http/errors.js`): 404 a 500 renderované v layoutu tématu bez stack trace; 500 zaloguje chybu s request id, uživatel vidí id.

## 4. Databáze (per tenant, `data/tenants/<slug>.db`)

`src/db.js`: `openTenantDb(slug)` → `DatabaseSync` s `PRAGMA journal_mode=WAL; foreign_keys=ON; busy_timeout=5000`. Migrace jako pole SQL řetězců `MIGRATIONS[]`, verze v tabulce `meta(key, value)` → `schema_version`. Pomocníci: `nowIso()`, `bind()` (boolean → 1/0, undefined → null), `parseJson()`, `transaction(db, fn)` (`BEGIN IMMEDIATE` … `COMMIT`/`ROLLBACK`). Schéma verze 1 (všechny tabulky zakládá kostra; features je jen používají):

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);   -- JSON hodnoty; výchozí z tenant.json
CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','staff')), totp_secret_enc TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0, locked_until TEXT, disabled INTEGER NOT NULL DEFAULT 0, last_login_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('public','admin')), user_id INTEGER REFERENCES users(id),
  data TEXT NOT NULL DEFAULT '{}', csrf TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, ip_hash TEXT);
CREATE TABLE bike_types (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, category TEXT NOT NULL
  CHECK (category IN ('mtb','trek','ebike','kids','gravel','city')), description TEXT, photos TEXT NOT NULL DEFAULT '[]',
  sizes TEXT NOT NULL DEFAULT '[]', specs TEXT NOT NULL DEFAULT '{}', deposit_minor INTEGER NOT NULL, fee_minor INTEGER NOT NULL,
  value_minor INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE bikes (id INTEGER PRIMARY KEY, bike_type_id INTEGER NOT NULL REFERENCES bike_types(id), inventory_code TEXT NOT NULL UNIQUE,
  size TEXT NOT NULL, frame_no_enc TEXT, status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','maintenance','retired')), note TEXT);
CREATE TABLE seasons (id INTEGER PRIMARY KEY, name TEXT NOT NULL, date_from TEXT NOT NULL, date_to TEXT NOT NULL);
CREATE TABLE price_rules (id INTEGER PRIMARY KEY, bike_type_id INTEGER NOT NULL REFERENCES bike_types(id), season_id INTEGER REFERENCES seasons(id),
  unit TEXT NOT NULL CHECK (unit IN ('hour','halfday','day')), from_qty INTEGER NOT NULL DEFAULT 1, price_minor INTEGER NOT NULL);
CREATE TABLE closures (id INTEGER PRIMARY KEY, date_from TEXT NOT NULL, date_to TEXT NOT NULL, reason TEXT);
CREATE TABLE accessories (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, price_minor INTEGER NOT NULL, stock INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE customers (id INTEGER PRIMARY KEY, email_hmac TEXT NOT NULL, email_enc TEXT NOT NULL, name_enc TEXT NOT NULL, phone_enc TEXT,
  address_enc TEXT, birth_date_enc TEXT, id_doc_type TEXT, id_doc_number_enc TEXT, id_doc_consent_at TEXT, id_doc_delete_after TEXT,
  marketing_consent_at TEXT, created_at TEXT NOT NULL, anonymized_at TEXT);
CREATE INDEX customers_email ON customers(email_hmac);
CREATE TABLE reservations (id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK (status IN
  ('draft','awaiting_fee','confirmed','checked_out','returned','closed','expired','cancelled_by_customer','cancelled_by_operator','no_show')),
  customer_id INTEGER REFERENCES customers(id), from_at TEXT NOT NULL, to_at TEXT NOT NULL, total_minor INTEGER NOT NULL, fee_minor INTEGER NOT NULL,
  paid_minor INTEGER NOT NULL DEFAULT 0, deposit_minor INTEGER NOT NULL DEFAULT 0, deposit_method TEXT, terms_version TEXT, consent_at TEXT,
  consent_ip_hash TEXT, id_doc_ack_at TEXT, expires_at TEXT, note TEXT, token_hash TEXT, version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX reservations_range ON reservations(from_at, to_at, status);
CREATE TABLE reservation_items (id INTEGER PRIMARY KEY, reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  bike_type_id INTEGER NOT NULL REFERENCES bike_types(id), size TEXT NOT NULL, bike_id INTEGER REFERENCES bikes(id),
  unit_price_minor INTEGER NOT NULL, fee_minor INTEGER NOT NULL, accessories TEXT NOT NULL DEFAULT '[]');
CREATE TABLE payments (id INTEGER PRIMARY KEY, reservation_id INTEGER NOT NULL REFERENCES reservations(id), purpose TEXT NOT NULL
  CHECK (purpose IN ('fee','balance','deposit_hold','refund')), method TEXT NOT NULL CHECK (method IN ('card','bank_transfer','cash','terminal')),
  provider TEXT NOT NULL, provider_ref TEXT, amount_minor INTEGER NOT NULL, captured_minor INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL
  CHECK (status IN ('created','pending','paid','authorized','captured','partially_captured','released','failed','expired','refunded','partially_refunded')),
  idempotency_key TEXT UNIQUE, vs TEXT, spayd TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE bank_transactions (id INTEGER PRIMARY KEY, source TEXT NOT NULL, tx_id TEXT NOT NULL UNIQUE, booked_at TEXT NOT NULL, amount_minor INTEGER NOT NULL,
  vs TEXT, msg TEXT, counter_account TEXT, counter_name TEXT, matched_payment_id INTEGER REFERENCES payments(id), raw TEXT);
CREATE TABLE webhook_events (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, event_id TEXT NOT NULL, payload TEXT, received_at TEXT NOT NULL, processed_at TEXT, UNIQUE (provider, event_id));
CREATE TABLE ledger_entries (id INTEGER PRIMARY KEY, reservation_id INTEGER NOT NULL REFERENCES reservations(id), type TEXT NOT NULL
  CHECK (type IN ('fee_paid','balance_paid','deposit_held','deposit_captured','deposit_released','refund','fee_forfeited','damage')),
  amount_minor INTEGER NOT NULL, payment_id INTEGER REFERENCES payments(id), note TEXT, created_at TEXT NOT NULL);
CREATE TABLE documents (id INTEGER PRIMARY KEY, reservation_id INTEGER NOT NULL REFERENCES reservations(id), type TEXT NOT NULL
  CHECK (type IN ('receipt','simplified_tax_doc','tax_doc','final_doc','credit_note','contract','handover','return_protocol')),
  number TEXT NOT NULL UNIQUE, issued_at TEXT NOT NULL, html TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE handovers (id INTEGER PRIMARY KEY, reservation_id INTEGER NOT NULL REFERENCES reservations(id), type TEXT NOT NULL CHECK (type IN ('pickup','return')),
  at TEXT NOT NULL, by_user_id INTEGER REFERENCES users(id), condition TEXT NOT NULL DEFAULT '{}', damage_minor INTEGER NOT NULL DEFAULT 0, note TEXT);
CREATE TABLE content_pages (id INTEGER PRIMARY KEY, slug TEXT NOT NULL, version INTEGER NOT NULL, title TEXT NOT NULL, body_md TEXT NOT NULL, published_at TEXT, UNIQUE (slug, version));
CREATE TABLE poi_overrides (poi_id TEXT PRIMARY KEY, hidden INTEGER NOT NULL DEFAULT 0, custom_text TEXT, sort INTEGER);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY, at TEXT NOT NULL, user_id INTEGER, action TEXT NOT NULL, entity TEXT, entity_id TEXT, meta TEXT, ip_hash TEXT);
CREATE TABLE outbox (id INTEGER PRIMARY KEY, type TEXT NOT NULL, to_hmac TEXT, subject TEXT NOT NULL, body_text TEXT NOT NULL, body_html TEXT,
  payload TEXT, run_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent_at TEXT, error TEXT, created_at TEXT NOT NULL);
```

Čísla rezervací (`reservations.number`, zároveň variabilní symbol): `RRMM` + 6-místná sekvence v rámci měsíce, např. `2607000123` (max. 10 číslic). Čísla dokladů: `<typ>-<rok>-<pořadí>` (např. `ZDD-2026-000012`, `DD-2026-…`, `OD-2026-…` opravný, `SML-2026-…`, `PP-2026-…`).

## 5. Tenant konfigurace `tenants/demo/tenant.json`

```json
{
  "slug": "demo",
  "name": "Půjčovna kol U Tří dubů",
  "hosts": ["localhost", "127.0.0.1", "ksprehledy.cz", "www.ksprehledy.cz", "outdoor.ksprehledy.cz", "sport.ksprehledy.cz", "family.ksprehledy.cz"],
  "themeDefault": "outdoor",
  "themeByHost": { "sport.ksprehledy.cz": "sport", "family.ksprehledy.cz": "family" },
  "brand": { "logo": "/tenant/logo.svg", "claim": "Kola, která vás vezmou dál", "primary": null },
  "business": { "legalName": "U Tří dubů s.r.o.", "ico": "00000000", "dic": "CZ00000000", "vatPayer": true,
    "address": "Masarykovo nám. 1, 379 01 Třeboň", "email": "info@ksprehledy.cz", "phone": "+420 000 000 000",
    "iban": "CZ6508000000192000145399", "accountNumber": "19-2000145399/0800", "bankName": "Česká spořitelna (demo)" },
  "location": { "lat": 49.0035, "lon": 14.7708, "radiusKm": 25 },
  "openingHours": { "mon": ["09:00","18:00"], "tue": ["09:00","18:00"], "wed": ["09:00","18:00"], "thu": ["09:00","18:00"], "fri": ["09:00","18:00"], "sat": ["08:00","19:00"], "sun": ["08:00","19:00"] },
  "settings": {
    "feeMinor": { "default": 30000, "ebike": 50000 },
    "cancellation": { "freeHoursBefore": 48 },
    "bufferMinutes": 60,
    "transferExpiryHours": 48,
    "preauthMaxDays": 7,
    "idDocRetentionDays": 30,
    "reservationRetentionDays": 90,
    "contractRetentionYears": 3,
    "logRetentionDays": 365,
    "gateway": "mock",
    "bankMatcher": "fio-mock",
    "docMode": "A",
    "acceptedIdDocs": "občanský průkaz, cestovní pas nebo řidičský průkaz",
    "lateReturnFlatMinor": 30000,
    "cleaningFlatMinor": 30000
  },
  "legal": { "version": "1.0", "effectiveFrom": "2026-10-05", "operatorName": "KS Přehledy (provozovatel musteru)", "operatorIco": "00000000",
    "processors": ["Hetzner Online GmbH (hosting, Německo – EU)", "e-mailová služba (bude doplněna)"] },
  "texts": { "heroTitle": "Půjčte si kolo a objevte Třeboňsko", "heroText": "Trekové, horské i elektrokola, dětská kola a vozíky. Rezervujte online za minutu, vyzvedněte u nás na náměstí.",
    "about": "Rodinná půjčovna v centru Třeboně. Kola servisujeme po každém vrácení, k zapůjčení dáváme zámek, mapu a tipy na výlety." }
}
```

Hodnoty `settings` se při prvním startu zkopírují do tabulky `settings` (admin ji může měnit); `tenant.json` je výchozí stav. Všechny placeholdery právních textů (kap. 11) se mapují z `business`, `settings`, `legal` a `openingHours`.

## 6. Render vrstva a komponenty

`src/render/html.js`: `html\`…\`` escapuje `${}` hodnoty (string, number, pole fragmentů se spojí, `null/undefined` → prázdno), `raw(str)` označí bezpečný fragment, `attr(obj)` vyrenderuje atributy. `layout.js` vytvoří `<!doctype html><html lang="cs" data-theme="outdoor" data-hero="fullbleed" data-nav="transparent" data-cards="photo-top">` s `<head>` (title „Stránka · Název půjčovny“, meta description, viewport, `<link rel=stylesheet>` base + téma + feature css, preload fontů, favicon, JSON-LD `LocalBusiness` na domovské stránce a `Product/Offer` na detailu kola, canonical absolutní podle hostu) a `<body>` s `<header class="site-header">` (logo, `<nav class="site-nav">` z `nav` všech features, CTA tlačítko „Rezervovat“), `<main id="obsah">`, `<footer class="site-footer">` (kontakt, otevírací doba, odkazy Podmínky · Ochrana osobních údajů · Reklamace · Kontakt, attribution map, verze), skip-link `#obsah`, v demo režimu `<aside class="design-switch">` s přepínačem designů (odkazy na `/design/nastavit?design=…`).

**Komponenty** (`src/render/components.js`, všechny vracejí `raw` fragment, používají výhradně tyto třídy – tématické CSS je stylují):

| Komponenta | Funkce | Markup / třídy |
|---|---|---|
| Hero | `hero({ title, text, cta, ctaHref, image, imageAlt })` | `<section class="hero"><div class="hero__media"><img …></div><div class="hero__body"><h1 class="hero__title">…</h1><p class="hero__text">…</p><a class="btn btn--primary btn--lg">…</a></div></section>` |
| Sekce | `section({ title, lead, children, variant })` | `<section class="section section--{variant}"><div class="container"><h2 class="section__title">…</h2><p class="section__lead">…</p>…</div></section>` |
| Mřížka | `grid(children, cols)` | `<div class="grid grid--3">…</div>` |
| Karta kola | `bikeCard(type, { price, available })` | `<article class="card card--bike"><a class="card__media" href><img></a><div class="card__body"><span class="badge">Horské</span><h3 class="card__title">…</h3><p class="card__meta">velikosti S–XL</p><p class="price"><strong class="price__amount">od 390 Kč</strong><span class="price__unit">/ den</span></p><a class="btn btn--secondary">Detail</a></div></article>` |
| Tlačítka | `button({ label, href, variant, size, type })` | `.btn .btn--primary|secondary|ghost|danger .btn--sm|lg` |
| Formulář | `field({ label, name, type, value, required, hint, error, options })`, `form({ action, method, csrf, children })` | `<div class="field"><label class="field__label" for>…</label><input class="field__input"><p class="field__hint">…</p><p class="field__error">…</p></div>`; `<form class="form" method="post"><input type="hidden" name="_csrf">…` |
| Kroky | `steps(items, activeIndex)` | `<ol class="steps"><li class="steps__item is-done|is-active">…</li></ol>` |
| Tabulka | `table({ head, rows, caption })` | `<table class="table">` |
| Odznak / stav | `badge(text, tone)` | `.badge .badge--success|warning|danger|info` |
| Upozornění | `notice(text, tone)` | `<div class="notice notice--info|success|warning|danger" role="status">` |
| Cenovka | `price(minor, unit)` | `.price` |
| Souhrn | `summary(rows)` | `<dl class="summary"><dt><dd>` |
| Kalendář | `calendarRange({ name, min, max, blocked })` | `<div class="calendar" data-calendar data-min data-max data-blocked="…">` + fallback `<input type="date">` ×2 bez JS |
| Záložky | `tabs(items)` | `.tabs .tabs__tab .is-active` |
| Timeline (admin) | `timeline({ rows, days })` | `.timeline .timeline__row .timeline__bar.status-confirmed` |
| Patička karta kontakt | `contactCard(business, openingHours)` | `.contact-card` |
| Zajímavost | `poiCard(poi)` | `<article class="card card--poi">` s obrázkem, vzdáleností, licencí/autorem |
| Trasa | `routeCard(route)` | `<article class="card card--route">` délka, síť, GPX odkaz |

Přístupnost: každý `<img>` má `alt`; formulářové prvky mají `<label>`; focus ring přes `--focus`; cíle ≥ 44 px; `prefers-reduced-motion` respektováno v `base.css`.

## 7. Theme kontrakt

`public/base.css` definuje **primitiva** (`--gray-50…900`, `--space-1…12` (4px škála), `--step--1…--step-5` typografická škála, `--radius-xs|sm|md|lg|pill`, `--shadow-1|2|3`, `--ease`, `--motion` (ms)), **semantiku** (`--bg`, `--bg-elevated`, `--surface`, `--surface-2`, `--text`, `--text-muted`, `--border`, `--primary`, `--on-primary`, `--primary-hover`, `--accent`, `--on-accent`, `--success`, `--warning`, `--danger`, `--info`, `--focus`, `--link`, `--font-display`, `--font-body`, `--font-mono`, `--hero-overlay`, `--section-gap`, `--container`, `--card-radius`, `--btn-radius`, `--input-radius`) a **komponenty** z kap. 6 jen přes semantické proměnné. `base.css` má neutrální výchozí hodnoty (funguje i bez tématu).

Každé téma `public/themes/<nazev>.css` **přepisuje jen proměnné a layoutové varianty**: selektory `[data-theme="sport"] { … }`, `[data-theme="sport"][data-hero="split"] .hero { … }`, `[data-theme="sport"] .card--bike { … }`. Nikdy nemění HTML. Preset v `src/themes.js`:

```js
module.exports = {
  outdoor: { label: 'Outdoor', hero: 'fullbleed', nav: 'transparent', cards: 'photo-top',
    fonts: { display: 'Fraunces', body: 'Inter', accent: 'Caveat' }, css: '/themes/outdoor.css', hint: 'zemitý, fotografický, osobní' },
  sport:   { label: 'Sport', hero: 'video-or-duotone', nav: 'bar', cards: 'overlay',
    fonts: { display: 'Barlow Condensed', body: 'Space Grotesk' }, css: '/themes/sport.css', hint: 'tmavý, kontrastní, dynamický' },
  family:  { label: 'Family', hero: 'split', nav: 'centered', cards: 'soft',
    fonts: { display: 'Bricolage Grotesque', body: 'Nunito' }, css: '/themes/family.css', hint: 'světlý, vzdušný, přátelský' },
};
```

Palety, fonty a charakter podle [rešerše 05, kap. B4](vyzkum/05-stack-theming-designy.md) – Outdoor: krém `#F5F0E6`, lesní `#2F5D3A`, terakota `#B4581B`, text `#1F2A1E`; Sport: `#0E0F12`, limetka `#C9FF3D` s černým textem, červená `#D92D20`, text `#F2F4F7`; Family: bílá, mint `#D9F2EC`, petrolej `#0F766E`, korál `#C8392C`, text `#1E2A3A`. Kontrast textu ≥ 4,5:1 ověřuje `tools/check-contrast.js` (čte proměnné z CSS témat, selže při nedodržení). Fonty self-host: stáhnout OFL soubory z `https://github.com/google/fonts` (variabilní TTF → převést nelze bez nástrojů; použít přímo `.ttf` z repa nebo woff2 z `https://fonts.gstatic.com` adres získaných z Google Fonts CSS API se správným User-Agent), uložit do `public/fonts/<rodina>/` s `OFL.txt`, `@font-face` s `font-display: swap`, `unicode-range` latin + latin-ext. Pokud by stažení nebylo možné, fallback systémové fonty a poznámka v README – ale téma musí vizuálně fungovat i tak.

Fotografie: `public/img/demo/` – pouze **CC0 nebo CC BY** z Wikimedia Commons (ověřit přes `imageinfo&iiprop=extmetadata`), max. 1600 px šířka, `ATTRIBUTION.md` (soubor, autor, licence, URL). Témata používají `object-fit`, overlay (`--hero-overlay`), duotone přes `mix-blend-mode` – ne upravené soubory.

## 8. Features a stránky

Veřejné stránky (`src/features/*`), všechny renderované serverem, funkční bez JS (JS jen zlepšuje):

| Cesta | Feature | Obsah |
|---|---|---|
| `/` | home | hero; 3 USP; výběr kol (karty podle kategorií); „Jak to funguje“ (1 Vyberte termín · 2 Zaplaťte rezervační poplatek · 3 Vyzvedněte s dokladem); teaser mapy a výletů (statický náhled + odkaz); kontakt a otevírací doba; JSON-LD `LocalBusiness` |
| `/kola` | kola | filtry (kategorie, velikost, termín od–do); karty s cenou „od … Kč/den“ a dostupností pro zadaný termín (`availability`) |
| `/kola/:slug` | kola | galerie, specifikace, velikosti s dostupností, ceník typu (tabulka pásem), poplatek a kauce typu, tlačítko „Rezervovat“ (předvyplní typ) |
| `/cenik` | kola | ceník všech typů, sezóny, příslušenství, poplatek, kauce, storno pravidla (z nastavení) |
| `/rezervace` → kroky | rezervace | viz kap. 9 |
| `/rezervace/:token` | rezervace | správa: stav, položky, platby, doklady, ICS, storno (s výpočtem), doplatek (mock) |
| `/mapa` | mapa | Leaflet mapa okolí (kap. 12) |
| `/okoli` | mapa | 20 tipů (karty), filtr podle vzdálenosti/typu, odkaz na mapu |
| `/podminky`, `/soukromi`, `/reklamace` | pravni | renderované právní texty (kap. 11); `/reklamace` = výřez OP čl. 12–13 + kontakt |
| `/kontakt` | kontakt | adresa, mapa (statický odkaz), otevírací doba, formulář dotazu → outbox |
| `/design` | design (jen demo) | galerie všech komponent ve zvoleném tématu + přepínač designů + odkaz na admin demo + popis tří designů |
| `/api/v1/dostupnost?od&do&typ&velikost` | rezervace | JSON pro kalendář: `{ available: { [typeId]: { [size]: n } }, blockedDates: [...] }` |
| `/api/v1/cena?typ&od&do&pocet` | kola | JSON cena |
| `/api/health` | kostra | health |

Admin (`/admin/...`, kap. 13). Simulační brána (`/simulace-brany/...`, kap. 10).

## 9. Doména

**Ceník** (`domain/pricing.js`): délka = celé dny (`ceil` z rozdílu `from_at`–`to_at` v hodinách / 24; ≤ 4 h = `hour`×hodiny, ≤ 6 h = `halfday`, jinak `day`); pásma `from_qty` (1 den, 2–3, 4–6, 7+), sezóna podle `seasons` (pokud existuje `price_rules.season_id` pro daný den, má přednost). `quote({ db, typeId, fromAt, toAt, qty, accessories })` → `{ days, unit, unitPriceMinor, totalMinor, feeMinor, depositMinor, breakdown[] }`. Příslušenství se počítá per den.

**Dostupnost** (`domain/availability.js`): `available({ db, typeId, size, fromAt, toAt })` = počet `bikes` typu a velikosti se `status='available'` − počet `reservation_items` téhož typu a velikosti, jejichž rezervace je ve stavu ∈ {`awaiting_fee`,`confirmed`,`checked_out`} a interval `[from_at − buffer, to_at + buffer)` se překrývá. Zavírací dny (`closures`, `openingHours`) nelze zvolit jako začátek/konec. Rezervace se zapisuje v `transaction(db, …)` s `BEGIN IMMEDIATE`: znovu spočítat dostupnost a teprve pak vložit; při nedostatku vrátit chybu „Kolo mezitím někdo rezervoval“.

**Rezervační tok** (`features/rezervace.js`), stav rozepsané rezervace v session (`draft`), finální zápis do DB až v kroku 4:
1. `GET/POST /rezervace` – termín (od/do datum + čas vyzvednutí/vrácení v otevírací době; výběr z 30-minutových slotů), kalendář blokuje zavřené dny.
2. `/rezervace/kola` – pro termín seznam typů s velikostmi, dostupností a cenou; výběr počtu kusů per typ+velikost; příslušenství.
3. `/rezervace/udaje` – jméno, e-mail, telefon; **povinná zaškrtávátka:** (a) souhlas s OP verze X (odkaz) a poučení, že u rezervace na termín není 14denní odstoupení a platí storno pravidla; (b) **„Beru na vědomí, že při převzetí předložím platný doklad totožnosti a půjčovna si zapíše jeho typ a číslo. Bez toho kolo nelze vydat.“** s odkazem na vysvětlení (proč: ověření totožnosti a platnosti dokladu, ochrana kol před krádeží) – bez zaškrtnutí nelze pokračovat; (c) volitelně obchodní sdělení (výchozí nezaškrtnuto). Uloží se `terms_version`, `consent_at`, `consent_ip_hash`, `id_doc_ack_at`.
4. `/rezervace/poplatek` – souhrn, částka poplatku (součet `fee_minor` položek) a výběr metody: **karta** (→ `payments.createPayment(... method 'card')` → redirect na simulační bránu), **převod / QR** (zobrazí IBAN, částku, VS, SPAYD QR, expiraci `transferExpiryHours`; rezervace `awaiting_fee`), **na místě** (jen pokud `settings.allowPayOnSite`; rezervace `confirmed` bez poplatku s poznámkou „bez garance“ – v demu vypnuto, ukázat jako neaktivní volbu s vysvětlením). Při kroku 4 vzniká zápis v DB (`reservations`, `reservation_items`, `customers` – e-mail HMAC pro dedup), `number` a `token` pro správu (`tokens.sign({ r: id }, 90 dní)`; v DB `token_hash`).
5. `/rezervace/hotovo/:token` – potvrzení, rekapitulace, odkaz na správu, co vzít s sebou (doklad!), ICS ke stažení, e-mail do outboxu (potvrzení + doklad o přijaté platbě, pokud zaplaceno).

**Stavový automat** (`domain/reservations.js`): `transition(db, reservationId, event, meta)` s povolenými přechody: `draft→awaiting_fee` (vytvoření), `awaiting_fee→confirmed` (poplatek zaplacen), `awaiting_fee→expired` (job), `confirmed→checked_out` (výdej: přiřazení `bike_id` všem položkám, kauce, doplatek nebo poznámka), `checked_out→returned` (vrácení: stav, poškození), `returned→closed` (vyúčtování: kauce uvolněna/stržena, konečný doklad), `awaiting_fee|confirmed→cancelled_by_customer` (storno engine), `awaiting_fee|confirmed→cancelled_by_operator` (plná vratka), `confirmed→no_show` (job po `to_at` bez výdeje, nebo ručně). Každý přechod: `version+1`, `audit_log`, případné e-maily do outboxu. Opakovaný stejný event je no-op (idempotence).

**Storno** (`domain/cancellation.js`): `quote({ reservation, now, settings })` → `{ hoursBefore, refundMinor, forfeitMinor, rule: 'free'|'forfeit' }`: `hoursBefore ≥ settings.cancellation.freeHoursBefore` → vrací se celý zaplacený poplatek; jinak propadá celý (`fee_forfeited` v ledgeru). Zrušení ze strany půjčovny → vždy plná vratka. Vratka = `payments` řádek `purpose='refund'` přes původní metodu (mock karta → okamžitě `refunded`; převod → `pending` do ručního potvrzení v adminu).

**Doklady** (`domain/documents.js`): `issue(db, type, reservation, data)` → číslo z řady, HTML (šablona s údaji půjčovny, položkami, DPH rozpisem), uloží do `documents`. Pravidla: platba poplatku → u neplátce `receipt`; u plátce `simplified_tax_doc` do 10 000 Kč (bez identifikace zákazníka, § 30 ZDPH), jinak `tax_doc`; vyúčtování → `final_doc` se započtením poplatku; storno s vratkou zdaněného poplatku → `credit_note`; výdej → `contract` + `handover` (z `legal/smlouva-o-najmu-a-predavaci-protokol.md`, kap. 11); vrácení → `return_protocol`. Vše HTML s tiskovým CSS (`/css/doklady.css`, `@media print`).

## 10. Platby (mock, ale s ostrým rozhraním)

`payments/provider.js` – rozhraní z rešerše 02/06:

```js
// createPayment({ db, reservation, purpose, method, amountMinor, capture: 'auto'|'manual', returnUrl })
//   → { payment, redirectUrl?, spayd?, qrSvg? }
// getStatus({ db, payment }) → stav ze zdroje pravdy (u mocku z tabulky), capture(), cancelHold(), refund()
// handleNotification(ctx) – zpracování notifikace: idempotence přes webhook_events, nikdy nevěřit notifikaci, vždy getStatus()
```

**Simulační brána** (`payments/mock-gateway.js`, provider `mock`): `createPayment` vrátí `redirectUrl = /simulace-brany/:paymentId?sig=…` (podepsaný token). Stránka vypadá jako platební brána (jasně označená „SIMULACE – žádné peníze se nepřevádějí“), nabízí tlačítka **Zaplatit** (→ nastaví `paid`/`authorized` podle `capture`), **Zamítnout** (→ `failed`), **Zrušit** (→ návrat). Pak pošle „notifikaci“ na `/platby/notifikace/mock` (interní POST s `secret` jako u Comgate – ověřit `timingSafeEqual`), handler stav **ověří přes getStatus** a teprve pak posune rezervaci. Preautorizace kauce: `capture:'manual'` → `authorized`; admin při vrácení `capture(amount)` nebo `cancelHold()`. Job 5./6. den (demo: parametry v minutách přepínatelné pro ukázku) upozorní / uvolní.

**Převod a QR** (`payments/bank-transfer.js`): `ibanFromCzAccount('19-2000145399/0800')` (mod 97), `spayd({ iban, amountMinor, vs, msg, dueDate })` → `SPD*1.0*ACC:…*AM:…*CC:CZK*X-VS:…*MSG:…*DT:…`, `qrSvg(payload)` přes `src/vendor/qrcode.js` (ECC M). Testy proti příkladu z rešerše 02.

**Fio mock** (`payments/fio-mock.js`): admin tlačítko „Simulovat příchozí převod“ (částka, VS, zpráva) → vloží `bank_transactions` (tx_id náhodné UNIQUE) → `match()` podle VS → `payments` `paid`, rezervace `confirmed`; přeplatek/nedoplatek dle rešerše 02 (tolerance ±5 Kč → paid; nedoplatek → `partially_paid` zobrazeno jako pending s QR na zbytek; nespárované → fronta). Rozhraní stejné jako budoucí `fio.js`.

**Ledger** (`payments/ledger.js`): každý pohyb peněz = řádek; `balance(reservation)` = `total − Σ(fee_paid + balance_paid) + …`; admin zobrazuje ledger u rezervace.

## 11. Právní texty

`src/render/markdown.js`: podmnožina Markdownu (nadpisy `#`–`####`, odstavce, `**`, `*`, odkazy, seznamy číslované i odrážkové včetně vnoření o jednu úroveň, tabulky `|`, blockquote `>`, `code`, vodorovná čára, `☐`/`☑` ponechat) → HTML s escapováním. Šablonování **před** renderem: `{{PARAM}}` → hodnota (escapovaná), `{{#X}}…{{/X}}` zobrazit, je-li X pravdivé/neprázdné, `{{^X}}…{{/X}}` zobrazit, je-li X nepravdivé; bloky mezi `<!-- INTERNI: nerenderovat -->` a `<!-- /INTERNI -->` vyhodit; sekce `## Parametry`, `## K ověření advokátem`, `## Příloha pro advokáta…` a úvodní rámeček „Návrh připravený jako podklad…“ **se na webu nerenderují** (ale v demo režimu se pod textem zobrazí šedý box „Demo: tento text je návrh k advokátní kontrole, verze X“). `{{STORNO_TABULKA}}` se vyrenderuje jako tabulka z `settings.cancellation`.

Mapování parametrů z `tenant.json` + `settings` → slovník (`src/features/pravni.js`, funkce `legalParams(tenant, settings)`), **všechny placeholdery všech pěti dokumentů musí mít hodnotu** (test prochází `legal/*.md`, posbírá `{{…}}` a ověří, že slovník každý zná – chybějící = test selže). Dvojice `PLATEBNI_BRANA`/`PLATEBNI_BRANA_NAZEV`, `BANKA`/`BANKA_NAZEV`, `POJISTENI`/`POJISTOVNA_NAZEV` dostávají stejnou hodnotu.

**Úpravy textů podle rozhodnutí zadavatele (provede feature „pravni“ ve složce `legal/`):**
1. OP čl. 8 (převzetí), Zásady odd. 2–3, Smlouva čl. 1 a 6, Záznamy A3: zápis typu a čísla dokladu je **podmínkou nájmu** (varianta B se ruší, `DOKLAD_REZIM` zůstává jen jako `A`); souhlas se zápisem údajů z občanského průkazu podle § 39 písm. d) zákona č. 269/2021 Sb. dává zákazník předložením a podpisem protokolu; **odůvodnění do textu**: ověření totožnosti a platnosti dokladu (kontrola čísla v Databázi neplatných dokladů Ministerstva vnitra ČR – uvést odkaz `https://aplikace.mvcr.cz/neplatne-doklady/`), ochrana majetku a vymáhání škody při **rostoucím počtu krádeží jízdních kol v ČR** (uvést ověřený údaj Policie ČR s rokem a zdrojem; bez ověřeného čísla formulovat obecně „patří k nejčastějším majetkovým trestným činům“). Bez předložení dokladu a souhlasu se zápisem kolo nevydáme a rezervace se posuzuje jako nevyzvednutá. Do „K ověření advokátem“ ponechat jediný bod: riziko posouzení souhlasu podmíněného službou (čl. 7 odst. 4 GDPR) – zadavatel si je vědom a trvá na podmínce; argumentace oprávněným zájmem (čl. 6 odst. 1 písm. f)) + zákonný požadavek souhlasu podle zákona o OP.
2. OP čl. 4 a 6, Zásady odd. 3, Záznamy A2, Smlouva čl. 3: rezervační poplatek = **úplata za zajištění služby (blokaci kol na termín)**, započítává se na nájemné; zrušení **nejméně `{{STORNO_LHUTA_HODIN}}` hodin před začátkem** → vrácení celého poplatku; později nebo nevyzvednutí → **propadá**. `{{STORNO_TABULKA}}` nahradit dvouřádkovou tabulkou. Režim DPH: úplata za službu (zajištění) – plátce ji zdaní jako službu; `STORNO_DPH_REZIM` zůstává parametr; bod pro daňového poradce.
3. OP čl. 4, Zásady odd. 4, Smlouva čl. 3, Záznamy A2: **zjednodušený daňový doklad** do 10 000 Kč u plátce (bez identifikace zákazníka), nad 10 000 Kč běžný daňový doklad; `REZIM_DOKLADU` = `zjednoduseny`.
Přitom aktualizovat tabulky Parametry a sekce „K ověření advokátem“ (odstranit body, které rozhodnutí vyřešilo). Nic jiného v textech neměnit.

## 12. Mapa a okolí

`tools/build-okoli.js --tenant demo` (bez závislostí): načte `../cyklo-ski-mapa/data/trasy.js` (odřízne `window.CSM_DATA.trasy = ` a `;`, `JSON.parse`), vybere trasy, jejichž `bbox` protíná kruh `location.radiusKm` kolem půjčovny, ořízne `geom` na segmenty do `radiusKm + 5`, spočítá `delkaKm` (haversine – znovu použít `../cyklo-ski-mapa/lib/geo.js` kopií do `src/geo.js`), uloží `{ id, nazev, ref, sit, druh, delkaKm, geom (zjednodušené, ≤ 400 bodů), bbox }`. Zajímavosti: Wikidata SPARQL `SERVICE wikibase:around` (poloměr `radiusKm`, instance of castle/château/church/monastery/museum/viewpoint/nature reserve/pond (Třeboňsko!)/town square/tower; `P18` obrázek; sitelink cswiki), cs.wikipedia `extracts` (intro, 2 věty), Commons `imageinfo&iiprop=extmetadata|url&iiurlwidth=800` → jen `CC0`, `CC BY`, `CC BY-SA` (uložit `Artist`, `LicenseShortName`, `LicenseUrl`), stáhnout náhled 800 px do `tenants/demo/okoli/img/<qid>.jpg`; skóre = má cs článek + obrázek + typ + blízkost (vzdálenost od půjčovny, blízkost k trase přes `SegmentGrid`) → top 20 → `okoli.json` `{ generatedAt, center, radiusKm, routes[], pois[{ id, name, type, lat, lon, distanceKm, summary, wikipediaUrl, image: { file, author, license, licenseUrl, sourceUrl } }] }`. Výšky: pokud `MAPY_API_KEY` v env, dopočítat převýšení z Mapy.cz Elevation (vzorky ~50 m), jinak `elevation: null`. Cache stažených odpovědí v `cache/` (není v gitu). Při selhání sítě skript skončí s chybou a vysvětlením – data se do gitu commitnou (jsou součást dema).

`features/mapa.js`: `/mapa` – Leaflet (vendor), podklad: je-li `MAPY_API_KEY`, Mapy.cz `outdoor` s logem a attribution, jinak CyclOSM (`https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png`) s attribution „© přispěvatelé OpenStreetMap, CyclOSM“; vrstvy: trasy podle `sit` (icn/ncn/rcn/lcn/mtb/cyklostezka – barvy jako v cyklo-ski-mapa), zajímavosti (markery s popupem: foto, text, vzdálenost, odkaz Wikipedie, odkaz „Navigovat v Mapy.cz“ `https://mapy.cz/zakladni?x=…&y=…&source=coor&id=…`), půjčovna. Boční panel: seznam tras (klik = zoom), filtr sítě, tlačítko **Stáhnout GPX** → `GET /mapa/gpx/:routeId.gpx` (server generuje GPX 1.1 z `geom`). Mapa se inicializuje až po kliknutí na „Načíst mapu“ (nebo při scrollu do viewportu) kvůli CSP/GDPR – do té doby statický náhled. Data pro JS: `GET /api/v1/okoli.json` (ořezaný `okoli.json`). `/okoli` – karty 20 tipů (`poiCard`) seřazené podle vzdálenosti, s attribution u každého obrázku; admin override `poi_overrides`.

## 13. Admin (`/admin`, feature `admin`)

Přihlášení `email + heslo` (scrypt) + TOTP, pokud zapnuto (demo: admin `demo@ksprehledy.cz` / `kolo-demo-2026`, TOTP vypnuto, na login stránce v demo režimu zobrazeno „Demo přístup“). Role: `owner` vše, `staff` bez nastavení a uživatelů. Vlastní session `__Host-pk_adm` (`SameSite=Strict`). Každá změna → `audit_log`. UI: serverově renderované stránky + progresivní JS (`public/admin/*.js`, převzít `table.js`, `modal.js`, `toast.js` vzory z `../repricing/public/lib` – zkopírovat a upravit, žádné závislosti).

Stránky: **Dnes** (`/admin`: výdeje a vrácení dnes, čekající poplatky, nespárované platby, kauce k uvolnění, poslední e-maily) · **Rezervace** (`/admin/rezervace` filtr podle stavu/termínu/hledání podle čísla; detail `/admin/rezervace/:id`: položky, zákazník (dešifrovaná pole jen zde, přístup se audituje), ledger, platby, doklady, akce podle stavu: *Přiřadit kola* (výběr konkrétních kusů podle typu/velikosti, kontrola kolizí), *Zapsat doklad* (typ + číslo; povinné před výdejem; `id_doc_consent_at`), *Kauce* (hotově / terminál / preautorizace kartou → odkaz na simulační bránu), *Doplatek* (karta mock / převod QR / hotově / terminál), *Vydat* → `checked_out` + smlouva a předávací protokol (tisk), *Vrátit* (stav, poškození Kč, poznámka) → `returned`, *Uzavřít* (kauce uvolnit/strhnout, konečný doklad) → `closed`, *Stornovat* (výpočet storna, důvod, vratka) · **Kalendář** (`/admin/kalendar`: timeline řádky = typy kol (rozbalitelné na kusy), sloupce = 14 dní, bloky podle stavu, klik → detail) · **Kola** (`/admin/kola`: typy a kusy CRUD, stav, fotky z `public/img/demo`, QR štítky k tisku s `inventory_code`) · **Ceník** (`/admin/cenik`: pásma, sezóny, příslušenství) · **Platby** (`/admin/platby`: seznam, filtr, *Simulovat příchozí převod*, nespárované s ručním přiřazením, vratky k potvrzení) · **E-maily** (`/admin/emaily`: outbox s náhledem) · **Zákazníci** (`/admin/zakaznici`: hledání podle e-mailu (HMAC), export JSON, anonymizovat) · **Obsah** (`/admin/obsah`: texty domovské stránky a kontaktu, zajímavosti skrýt/přeřadit/vlastní text) · **Nastavení** (`/admin/nastaveni`: poplatek, storno lhůta, buffer, otevírací doba, zavírací dny, brána (mock), banka (mock), DPH, lhůty retence, uživatelé, 2FA pro vlastní účet s QR `otpauth://`) · **Audit** (`/admin/audit`).

## 14. Demo data (`tools/demo-data.js`)

Idempotentní (`--reset` smaže a znovu naplní): 6 typů kol (Trekové kolo Trek FX 2 · Horské kolo Specialized Rockhopper · Elektrokolo trekové Cube Touring Hybrid · Elektrokolo horské Haibike AllTrail · Dětské kolo Woom 4 · Gravel Canyon Grail – názvy modelů jsou ukázkové, bez tvrzení o skladu), 2–6 kusů na typ, velikosti S–XL (dětské 20"/24"), ceny v pásmech (např. trek 390/350/320/290 Kč, e-kolo 890/790/690/590), sezóna „Hlavní sezóna“ 15. 6.–15. 9. s +15 %, příslušenství (přilba 50 Kč/den, dětská sedačka 100, vozík 250, zámek zdarma), zavírací dny (24.–26. 12.), 12 rezervací v různých stavech kolem dnešního dne (včetně dnešního výdeje a vrácení, jedné čekající na převod s QR, jedné stornované, jedné `checked_out` s preautorizovanou kaucí), odpovídající platby, ledger, doklady, outbox, audit. Admin `demo@ksprehledy.cz`. Zákazníci fiktivní (např. „Jana Nováková“, e-maily `@example.com`). Noční reset v demo režimu volá tentýž skript.

## 15. Provoz a nasazení (`deploy/`)

`deploy/Dockerfile` (vzor `../cyklo-ski-mapa/Dockerfile`: `node:22-alpine`, `USER node`, `VOLUME /data`, `HEALTHCHECK` na `/api/health`, `ENV PK_DATA=/data`), `deploy/docker-compose.yml` (`app` + `caddy:2-alpine`, svazky `data`, `caddy_data`, `caddy_config`), `deploy/Caddyfile` s bloky pro `ksprehledy.cz, www.ksprehledy.cz, outdoor.ksprehledy.cz, sport.ksprehledy.cz, family.ksprehledy.cz` (HTTP-01 per host; `encode zstd gzip`; hlavičky HSTS nepřidávat v Caddy – řeší aplikace; `header -Server`; access log s rotací), `deploy/.env.example`, `deploy/hetzner.sh` (převzít a přejmenovat z `../cyklo-ski-mapa/deploy/hetzner.sh`: instalace, aktualizace, zpet, zaloha (sqlite backup všech `*.db` + tenants), stav, log), `NASAZENI.md` (postup pro ksprehledy.cz: DNS A/AAAA pro apex + 4 subdomény (nebo wildcard) → server → `hetzner.sh instalace ksprehledy.cz` → ověření; poznámka, že ostrá verze přejde na wildcard DNS-01 dle rešerše 07). GitHub Actions `.github/workflows/pujcovna-kol.yml` podle `cyklo-ski-mapa.yml` (test na push/PR dotýkající se složky; deploy přes SSH jen z hlavní větve při `PK_HETZNER=1`).

## 16. Vlastnictví souborů (kdo co píše)

| Agent | Vlastní (smí vytvářet a měnit) | Nesmí měnit |
|---|---|---|
| **kostra** | `package.json`, `server.js`, `src/config.js`, `src/log.js`, `src/db.js`, `src/tenants.js`, `src/themes.js`, `src/crypto/*`, `src/http/*`, `src/render/html.js`, `layout.js`, `components.js`, `format.js`, `src/jobs.js` (rámec), `src/geo.js`, `public/base.css`, `public/fonts/` (stažení), `public/vendor/*`, `src/vendor/*`, `tenants/demo/tenant.json`, `tenants/demo/logo.svg`, `src/features/home.js`, `design.js`, `kontakt.js` + jejich pages/css/js, `test/helpers.js`, testy kostry, `README.md` (kostra), `tools/check-contrast.js` | `legal/`, `docs/vyzkum/` |
| **kola** | `src/domain/pricing.js`, `src/features/kola.js`, `src/render/pages/kola.js`, `public/css/kola.css`, `public/js/kola.js`, `tools/demo-data.js` (kola, ceník, sezóny, příslušenství – část), `test/pricing.test.js`, `test/kola.test.js` | ostatní |
| **rezervace** | `src/domain/availability.js`, `reservations.js`, `cancellation.js`, `src/features/rezervace.js`, `src/render/pages/rezervace.js`, `public/css/rezervace.css`, `public/js/rezervace.js` (kalendář), `src/mail/*`, `tools/demo-data.js` (rezervace – část), testy | ostatní |
| **platby** | `src/payments/*`, `src/domain/documents.js`, `src/features/platby.js` (simulační brána, notifikace, doklady), `public/css/doklady.css`, `public/css/platby.css`, testy | ostatní |
| **mapa** | `tools/build-okoli.js`, `tenants/demo/okoli.json` + `okoli/img/`, `src/features/mapa.js`, `src/render/pages/mapa.js`, `public/css/mapa.css`, `public/js/mapa.js`, testy | ostatní |
| **pravni** | `legal/*.md` (úpravy podle kap. 11), `src/render/markdown.js`, `src/features/pravni.js`, `src/render/pages/pravni.js`, `public/css/pravni.css`, testy | ostatní |
| **tema-outdoor / tema-sport / tema-family** | `public/themes/<t>.css`, `public/img/demo/<t>/` + `ATTRIBUTION.md` (společný soubor – každý přidává své řádky), fonty svého tématu v `public/fonts/` | HTML, komponenty, ostatní témata |
| **admin** | `src/features/admin.js`, `src/render/pages/admin/*`, `public/admin/*`, `public/css/admin.css`, testy | doménové moduly (jen volá) |
| **provoz** | `deploy/*`, `NASAZENI.md`, `.github/workflows/pujcovna-kol.yml`, `tools/e2e.js` | aplikační kód |

Když agent potřebuje změnu v souboru, který nevlastní (např. novou komponentu v `components.js`), **přidá ji do své feature** (vlastní pomocná funkce ve svém `pages/*.js`) a zapíše požadavek do `docs/TODO-INTEGRACE.md` (sdílený seznam; každý jen přidává řádky). Při souběhu dvou agentů v `tools/demo-data.js`: soubor má sekce `// === KOLA ===`, `// === REZERVACE ===`; každý edituje jen svou sekci (kostra připraví skeleton se sekcemi).

## 17. Akceptační kritéria dema

1. `npm test` prochází; `node --check` všech souborů; `tools/check-contrast.js` prochází pro 3 témata.
2. `npm run demo-data && npm start` → na `http://localhost:8092` fungují všechny stránky z kap. 8 ve všech 3 designech (`?design=`), bez chyb v konzoli prohlížeče, bez porušení CSP, bez nerozvinutých `{{…}}`.
3. Kompletní průchod rezervací: termín → kola → údaje (povinné souhlasy) → poplatek kartou přes simulační bránu → potvrzení s dokladem (u plátce zjednodušený daňový doklad) → e-mail v outboxu → správa rezervace → storno s výpočtem podle 48 h pravidla. Totéž převodem s QR + simulace příchozí platby v adminu.
4. Admin: přihlášení, výdej (doklad, kola, kauce preautorizací přes simulaci), vrácení, uzavření s konečným dokladem; timeline; simulace příchozího převodu; outbox; audit.
5. Mapa zobrazuje trasy a 20 zajímavostí okolo Třeboně s attribution; GPX ke stažení funguje.
6. Právní stránky renderují OP, Zásady a Reklamace z `legal/*.md` s parametry dema, bez interních sekcí; texty odrážejí rozhodnutí 1–3.
7. Bezpečnost: hlavičky dle kap. 3, cookies `__Host-`, CSRF odmítne POST bez tokenu/Origin, rate limit na login funguje, hesla scrypt, citlivá pole v DB šifrovaná (ověřit v testu, že `customers.name_enc` není čitelný text), žádné PII v logu.
8. `tools/e2e.js` projde rezervaci ve 3 designech a uloží screenshoty do `dist/screenshots/` (není v gitu).
9. `NASAZENI.md` popisuje nasazení na ksprehledy.cz; `docker compose -f deploy/docker-compose.yml config` je validní.
