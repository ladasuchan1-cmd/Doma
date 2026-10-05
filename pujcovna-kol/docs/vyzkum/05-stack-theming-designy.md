# Podklad: technologický stack a designový systém „muster“ pro půjčovny kol

Stav k 5. 10. 2026. Podklad pro [PLAN.md](../../PLAN.md).

## A. Jak dnes stavíme projekty (cyklo-ski-mapa, repricing)

| Oblast | Zjištěná zvyklost |
|---|---|
| Runtime | Node **22+** (`engines >=22` / `>=22.13`), image `node:22-alpine`, `--disable-warning=ExperimentalWarning` kvůli `node:sqlite` |
| Závislosti | **Nula npm závislostí** (package.json bez `dependencies`); klientské knihovny (Leaflet) zkopírované do `vendor/` |
| Kód | **CommonJS**, `'use strict'`, `require('node:*')`; hlavička souboru s komentářem co dělá + proměnné prostředí; kód/DB anglicky, komentáře, UI a dokumentace **česky** |
| HTTP | vestavěný `node:http`, ruční MIME tabulka, gzip, CSP, HSTS; API JSON pod `/api/...`, `/api/health` s verzí z gitu |
| Autentizace | HMAC-SHA256 podepsaná session cookie (HttpOnly, Secure za proxy, `TRUST_PROXY`), `timingSafeEqual`, brzda 10 pokusů/15 min na IP; cyklo-ski-mapa má hesla **v otevřené podobě v `.env`** (chmod 600), repricing už **scrypt hash** (`scrypt$N$r$p$salt$hash`) + API tokeny s oprávněními |
| Úložiště | cyklo-ski-mapa: JSON soubor s atomickým zápisem; repricing: **`node:sqlite` DatabaseSync**, migrace jako pole SQL + `schema_version` v tabulce `meta`, WAL, `foreign_keys`, `busy_timeout`, JSON sloupce jako TEXT, časy ISO UTC |
| Testy | `node --test "test/**/*.test.js"` – jednotkové, API (`api-*.test.js`), engine, e2e flow |
| Frontend | bez buildu: vanilla JS moduly (`public/lib/*.js`, `public/views/*.js`), CSS custom properties v `:root` (světlý/tmavý), `system-ui` fonty |
| Nasazení | Dockerfile (`USER node`, `VOLUME /data`, HEALTHCHECK), `docker-compose.yml` app + `caddy:2-alpine` (auto TLS, `encode zstd gzip`, HSTS, `-Server`, rotovaný access log), `hetzner.sh` (instalace/aktualizace/zpet/zaloha/stav/log, ufw, cron záloha 2:30, 60 kopií, tag `predchozi` pro rollback), varianty systémová Caddy a systemd |
| CI | GitHub Actions: test → deploy přes SSH (skript posílán stdin) nebo self-hosted runner; secrets/variables řídí uživatele i doménu |
| Dokumentace | README + NASAZENI.md + `docs/` (SHRNUTI/MANUAL/METODIKA, SPEC, ADMIN-API), tabulky, česky |

**Závěr pro muster:** navázat na „Node bez závislostí + SQLite + Docker/Caddy/hetzner.sh“ je přirozené; nové je multi-tenant, platby, e-maily a theming.

## B. Porovnání a doporučení

### B1 Backend + databáze

| Varianta | Závislosti | Pro | Proti |
|---|---|---|---|
| **`node:http` + vlastní router** (dosavadní přístup) | 0 | nejmenší útočná plocha, nulový `npm audit`, tým to umí | vlastní parsování, validace, CSRF |
| **Hono** 4.x | **0** (na Node navíc `@hono/node-server`) | MIT, Web Standards, middleware (CSP, CSRF, cookie), typy | mladší ekosystém, adaptér navíc |
| Fastify 5 | 13 (pino, ajv…) | nejrychlejší na Node, JSON Schema validace | více kódu třetích stran k auditu |
| Express 5 | ~30 | největší ekosystém | „maintenance mode“, nejpomalejší, bez vestavěné validace |
| Django / Laravel / Rails | stovky | Django: admin + bezpečné defaulty hotové | nový runtime, dva stacky v týmu; pro 2–3 lidi zbytečná režie |

| DB | Pro | Proti |
|---|---|---|
| **SQLite přes `node:sqlite`** | už používáme (repricing), bez instalace, bez flagu od 22.13, `backup()`; **1 soubor = 1 půjčovna** → izolace, záloha = kopie, GDPR výmaz = smazání souboru | stabilita „1.2 Release candidate“, jeden zapisující proces; migrace se spouští N× (smyčka přes soubory) |
| better-sqlite3 | zralejší API, `.transaction()` | nativní build, závislost navíc |
| PostgreSQL | souběžní zapisovatelé, cross-tenant dotazy, EXCLUDE constraint | další kontejner, zálohy, uživatelé; pro desítky rezervací/den overkill |

**Doporučení:** **Node 24 LTS** (Active LTS; Node 22 je v maintenance), kód kompatibilní s 22.13+. `node:http` s malým routerem podle vzoru repricing. **SQLite per tenant** (`/data/tenants/<slug>.db`) + společná `platform.db` (tenanti, domény, admin účty provozovatele). Migrace jako dnes (`MIGRATIONS[]` + `schema_version`).

**Bezpečnost dat:** hesla scrypt (převzít z repricing); **šifrování citlivých polí** AES-256-GCM z `node:crypto` (telefon, adresa, číslo dokladu, poznámky): klíč v Docker secretu / souboru 600, náhodný 96-bit nonce na záznam, prefix verze klíče (`k1:`) pro rotaci, pro vyhledávání HMAC otisk e-mailu. **Karty nikdy neukládat** – hostovaná platební stránka (PCI SAQ-A). Zálohy šifrovat, přístup k adminu jen přes HTTPS + rate limit + 2FA + audit log.

### B2 Renderování

| Přístup | SEO | Rychlost | CSP | Údržba |
|---|---|---|---|---|
| **SSR HTML z Node (vlastní šablony) + progresivní JS** | plné HTML, schema.org | nejrychlejší TTFB, cache per tenant | striktní nonce CSP snadno | bez buildu, 0 závislostí |
| Astro (SSR adaptér node) | výborné (islands, 0 JS default) | výborná | vestavěný CSP manager | build krok, stovky devDependencies |
| Eleventy 3 | výborné pro statiku | výborná | ruční | jen statika – rezervace přes API |
| SvelteKit / Next / Nuxt | dobré jen s SSR | hydratace, větší bundle | ano, s prací | největší plocha, časté major změny |

**Doporučení:** **SSR z téhož Node procesu** (šablony = JS funkce s escapováním, jako dnes `loginPage()`), obsah z konfigurace tenanta + SQLite, výstup cache v paměti. Progresivní JS jen pro filtry kol, kalendář, mapu. SEO: `LocalBusiness`/`BikeStore` + `Product`/`Offer` JSON-LD, sitemap, hreflang cs/de/en, OG obrázky, optimalizované fotky (AVIF/WebP, `srcset`). Pokud by tým chtěl framework, jediná rozumná volba je Astro – ne SPA.

### B3 Theming pro 3 odlišné designy

**Architektura:** tři vrstvy tokenů jako CSS custom properties – *primitiva* (`--green-700`, `--size-4`, `--font-display`) → *semantika* (`--color-primary`, `--surface`, `--radius-card`, `--hero-overlay`) → *komponenty* (`--btn-radius`, `--card-shadow`). HTML a komponenty **jedny**; téma = `themes/<nazev>.css` + manifest tenanta:

```json
{ "theme": "outdoor", "brand": { "logo": "...", "primary": "#2F5D3A" },
  "fonts": { "display": "Fraunces", "body": "Inter" },
  "layout": { "hero": "fullbleed", "nav": "transparent", "cards": "photo-top" } }
```

`<html data-theme="outdoor" data-hero="fullbleed">` – **layout varianty přepíná manifest, ne jen barvy**: hero (full-bleed foto / split / centrovaná ilustrace), navigace (transparentní / pruh / vycentrovaná), karty kola (foto nahoře / vedle / tmavý overlay), rytmus sekcí (`--section-gap`), poloměry (`--radius: 0 | 6px | 20px`), stíny, animace (`--motion-duration`, `prefers-reduced-motion`), úprava fotek (duotone/overlay přes `mix-blend-mode`), typografická škála (`--step-*` – jiné poměry per téma). Fonty self-hostované (subset latin-ext, `font-display: swap`), bez Google CDN kvůli GDPR a CSP.

| Knihovna | Hvězdy / licence | Hodí se? |
|---|---|---|
| **Vlastní CSS + tokeny** | – | ano, 0 závislostí, plná kontrola |
| **Open Props** 1.7 | 5,5k / MIT | ano jako zdroj primitiv (barvy, easings, stíny) – zkopírovat jen potřebné |
| daisyUI 5 | 42,5k / MIT | referenční model `data-theme` + 35 témat; vyžaduje Tailwind build |
| Tailwind presets | – | funguje, ale přidává build a utility třídy do HTML |
| Pico CSS 2.1 | 16,9k / MIT | **už není udržován** – jen inspirace class-less přístupu |
| Basecoat | 4,3k / MIT | shadcn vzhled v čistém HTML + Tailwind |

**Repozitáře k převzetí (ověřeno):**
1. [AstroWind](https://github.com/arthelokyo/astrowind) – 6,0k★, MIT – `src/config.yaml` jako vzor tenant konfigurace, 30+ sekcí/widgetů.
2. [Open Props](https://github.com/argyleink/open-props) – 5,5k★, MIT – primitivní tokeny.
3. [daisyUI](https://github.com/saadeghi/daisyui) – 42,5k★, MIT – sémantická jména barev (`base-100/200/300`, `primary-content`) a přepínání témat atributem.
4. [Basecoat](https://github.com/hunvreus/basecoat) – 4,3k★, MIT – komponenty (dialog, tabs, select) bez Reactu.
5. [Style Dictionary](https://github.com/style-dictionary/style-dictionary) – 4,9k★, Apache-2.0 – build tokenů z JSON do CSS pro 3 témata (DTCG formát).
6. [kickstartDS](https://github.com/kickstartDS/kickstartDS) – 99★, Apache-2.0/MIT – „white-label design system“, sémantické tokeny + JSON Schema komponent.
7. [Pico CSS](https://github.com/picocss/pico) – 16,9k★, MIT – class-less styling nativních prvků (formuláře rezervace).

Kalendář: [vanilla-calendar-pro](https://github.com/uvarov-frontend/vanilla-calendar-pro) (1,3k★, MIT, 0 závislostí, rozsah + blokované dny) nebo [Cally](https://github.com/WickyNilliams/cally) (1,7k★, MIT, web component `<calendar-range>`, < 9 KB).

### B4 Tři designové koncepty

Všechny kontrasty spočteny (WCAG 2.x), text ≥ 4,5:1.

**1) „Outdoor / Nature“ – zemitý, fotografický, osobní**
- Paleta: pozadí `#F5F0E6` (krém), plocha `#EAE2D3`, text `#1F2A1E` (13,1:1), primární lesní `#2F5D3A` (bílá na ní 7,6:1), akcent terakota `#B4581B` tlačítka (bílá 4,8:1) / `#9A4A14` pro text (5,5:1), tlumený `#5C6355` (5,5:1), patička tmavá `#1F2A1E` s krémem.
- Fonty (Google Fonts, OFL, self-host): **Fraunces** (variabilní serif, osy `opsz/wght/SOFT/WONK` – „měkký“ nadpis), **Caveat** (ručně psané akcenty: „od 290 Kč/den“, šipky), tělo Inter.
- Fotky: full-bleed krajina (ranní světlo, zrno), lidé zády ke kameře, teplý grading; žádné ilustrace.
- Komponenty: poloměr 6–8 px, papírová textura okraje, karty s fotkou přes celou šířku, tlačítka s jemným „razítkem“, pomalé fade (300 ms), parallax jen desktop.
- Inspirace: [Komoot](https://www.komoot.com/) (zelená + autentická outdoor fotografie), lokální benchmark [Půjčovna kol Lipno](https://pujcovna-kol-lipno.cz/) a [Lipno Centrum](https://www.lipnocentrum.cz/) (co překonat).

**2) „Sport / Performance“ – tmavý, kontrastní, dynamický**
- Paleta: pozadí `#0E0F12`, plocha `#1A1D23`, text `#F2F4F7` (17,4:1), tlumený `#8B93A1` (5,5:1 na ploše), primární limetka `#C9FF3D` s černým textem (16,3:1), CTA červená `#D92D20` (bílá 4,8:1) / `#FF4D3D` jako text na tmavém (5,8:1).
- Fonty: **Barlow Condensed** (9 vah, verzálky, těsný prostrk, velké číslovky cen), **Space Grotesk** (tělo, tabulky, UI).
- Fotky: akce, pohybová neostrost, vysoký kontrast, duotone overlay (`mix-blend-mode`), video hero.
- Komponenty: poloměr 0–2 px, diagonální řezy (`clip-path`), běžící pruh (ticker) s typy kol, hover posun 4 px, rychlé přechody 150 ms, sticky rezervační lišta.
- Inspirace (ověřeno na Awwwards): [Star Bicycle](https://www.awwwards.com/sites/star-bicycle) (černá + `#D14836`, video storytelling), [Bike Time](https://www.awwwards.com/sites/bike-time) (`#222` + `#EA1C56`, ticker, parallax), [Rapha](https://www.rapha.cc/) (editoriální cyklofotografie).

**3) „Clean / Minimal / Family“ – světlý, vzdušný, přátelský**
- Paleta: bílá `#FFFFFF`, plocha `#F3F7FB`, mint `#D9F2EC`, text `#1E2A3A` (14,5:1), tlumený `#5B6B7E` (5,5:1), primární petrolej `#0F766E` (bílá 5,5:1; na mintu 4,7:1), sekundární `#2563EB` (5,2:1), akcent žlutá `#FFC940` jen pro pozadí štítků s tmavým textem (9,5:1), CTA korál `#C8392C` (bílá 5,2:1).
- Fonty: **Nunito** (variabilní 200–1000, zaoblené konce) pro vše, **Bricolage Grotesque** (`opsz/wdth/wght`) pro hravé display titulky.
- Obraz: rodiny, děti, e-kola v denním světle na bílém/mint pozadí; jednoduché SVG ilustrace (helma, mapa, hodiny) v paletě; ikony s kulatými tahy.
- Komponenty: poloměr 16–24 px, pill tlačítka, měkké stíny, velké mezery (`--section-gap: 6rem`), kroky rezervace jako „1-2-3“ s ilustracemi, spring animace 250 ms.
- Inspirace: [woom](https://woom.com/) (bílá + červený akcent, skutečné děti/rodiny), [Swapfiets](https://swapfiets.com/) (tón „worry-free biking“).

Přístupnost společná: viditelný focus ring (`--focus`), cíle ≥ 44 px, `prefers-reduced-motion`, štítky formulářů, kontrast ověřen v CI skriptem.

### B5 Admin

**Minimum:** kola (varianty velikost/typ, fotky, stav servis/vyřazeno), ceník (sazby den/půlden/týden, sezóny, slevy, kauce), kalendář dostupnosti + blokace, rezervace (stavy, platba, předání/vrácení, poškození), zákazníci (minimum PII, výmaz), platby (přehled, refundace, ruční párování), texty/zajímavosti/podmínky (verze), export účetnictví (CSV/XLSX, Pohoda XML – máme v repricing), audit log, uživatelé a role.

| Kit | Hvězdy / licence | Plusy | Mínusy / bezpečnost |
|---|---|---|---|
| AdminJS 7.8 | 9,0k / MIT | Node, generuje CRUD | React bundle, ORM adaptér, stovky závislostí |
| react-admin | 26,9k / MIT | zralý, hotové datagridy | RBAC jen v placené EE; samostatná SPA |
| Payload 3 | 30k+ / MIT | typovaný, přístupová práva v kódu | postaven na Next.js, těžký |
| Directus | 38k / **BSL** (source-available) | admin nad DB okamžitě | další služba, licence není OSS |
| Strapi 5 | 73k | ekosystém | **2026 CVE: nepřihlášené získání admin tokenu (CVE-2026-27886), SQLi (CVE-2026-22599)** |

**Doporučení: vlastní jednoduchý admin** jako v repricing (vanilla JS `views/*.js` nad `/api/v1`, scrypt, session cookie `SameSite=Strict` + CSRF token, audit log). Znovu použít `public/lib` (table, modal, toast, filter-builder, combobox). Nejmenší útočná plocha, žádný externí panel vystavený na internet.

### B6 Provoz

| Téma | Doporučení |
|---|---|
| Nasazení | Docker Compose jako dnes: `app` + `caddy` + `litestream` sidecar (+ volitelně `uptime-kuma`); `hetzner.sh` rozšířit o `tenant pridat <slug> <domena>` |
| Multi-tenant | **Jedna instance, více domén** (desítky půjčoven na CX22 bez problému). Caddy **on-demand TLS** s `ask` endpointem `/api/tls-ask` (ověří doménu v `platform.db`); 1 kontejner na půjčovnu jen pro VIP klienty |
| Zálohy | **Litestream** (průběžná replikace SQLite, point-in-time restore) → Hetzner Object Storage (S3); **restic** denně `/data` (DB + fotky) na Hetzner Storage Box, šifrováno, retence 7d/4w/12m; k tomu `hetzner.sh zaloha` s `sqlite.backup()`; test obnovy 1× měsíčně |
| Monitoring | **Uptime Kuma 2.x** – `/api/health` per tenant, status page; Caddy access log s rotací |
| E-maily | **Resend** (3 000/měs. zdarma) nebo **Postmark** (15 USD, nejlepší doručitelnost) – přes HTTPS API bez SDK; odesílat z domény musteru (`rezervace@…`) s `Reply-To` půjčovny, nebo per tenant ověřit doménu (SPF, DKIM, DMARC); webhooky bounce → admin |
| CI | GitHub Actions: `npm test`, `node --check`, `npm audit`, `docker build`, Trivy na image, deploy přes SSH jako dnes; Dependabot pro base image a actions |

## Doporučený stack (shrnutí)

**Node 24 LTS (kompatibilní s 22.13+) · CommonJS · 0 npm závislostí · `node:http` + vlastní router · `node:sqlite` per tenant + šifrovaná PII (AES-256-GCM) + scrypt · SSR HTML z Node + progresivní vanilla JS (kalendář, Leaflet) · tokeny CSS (3 vrstvy) + 3 témata jako CSS + layout manifest tenanta · vlastní admin · Docker Compose + Caddy (on-demand TLS) + Litestream + restic + Uptime Kuma · platební brána přes adaptér · Resend/Postmark · GitHub Actions → `hetzner.sh`.** Důvod: navazuje na ověřené zvyklosti (repricing je de facto prototyp této architektury), minimalizuje kód třetích stran k auditu, dává plnou kontrolu nad CSP a SEO a drží provoz na jednom VPS.

## Zdroje

- Node: https://nodejs.org/api/sqlite.html · https://nodejs.org/en/about/previous-releases
- Frameworky: https://github.com/honojs/hono · https://github.com/fastify/fastify · https://fastify.dev/benchmarks/
- SQLite per tenant: https://medium.com/@dmitry.s.mamonov/database-per-tenant-consider-sqlite-9239113c936c
- Theming: https://clearleft.com/thinking/designing-with-tokens-for-a-flexible-multi-brand-design-system · https://frontendmasters.com/blog/exploring-multi-brand-systems-with-tokens-and-composability/ · repozitáře viz B3
- Fonty (google/fonts, OFL): Fraunces, Bricolage Grotesque, Caveat, Nunito, Space Grotesk, Barlow Condensed – https://github.com/google/fonts
- Inspirace: https://www.awwwards.com/sites/bike-time · https://www.awwwards.com/sites/star-bicycle · https://woom.com/ · https://swapfiets.com/ · https://www.komoot.com/ · https://www.rapha.cc/ · https://pujcovna-kol-lipno.cz/
- Admin: https://github.com/SoftwareBrothers/adminjs · https://github.com/marmelab/react-admin · https://github.com/directus/directus · https://github.com/strapi/strapi · https://bishopfox.com/blog/cve-2026-27886-unauthenticated-boolean-oracle-exfiltration-of-administrator-secrets-in-strapi
- Provoz: https://caddyserver.com/docs/automatic-https · https://litestream.io/ · https://docs.hetzner.com/storage/object-storage/howto-backups/restic/ · https://github.com/louislam/uptime-kuma · https://postmarkapp.com/compare/resend-alternative
