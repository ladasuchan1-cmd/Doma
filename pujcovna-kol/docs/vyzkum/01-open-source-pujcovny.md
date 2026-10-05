# Podklad z open source: půjčovny kol a rezervační systémy pro pronájem vybavení

Stav ověřen 5. 10. 2026 přímo na stránkách repozitářů (README, topic stránky, dokumentace). Počty hvězd jsou orientační.
Použity pouze veřejné stránky; nic nebylo klonováno. Rešerše je podklad pro [PLAN.md](../../PLAN.md).

## 1. Shrnutí

- Nejbližší vzor pro náš záměr (white-label šablona pro více půjčoven, storefront + rezervace + Stripe + PDF smlouvy + právní stránky) je **Louez** (Next.js, AGPLv3). Pozor: některé seznamy ho uvádějí jako MIT, soubor LICENSE je však AGPLv3.
- Nejlepší referenci pro **stavový automat rezervace** nabízí **Shelf.nu** (Draft → Reserved → Ongoing → Overdue → Completed → Archived) a **leihs** (rezervace → schválení → výdej se smlouvou → vrácení).
- Nejlepší referenci pro **rezervační poplatek odečítaný z finální ceny** a storno pravidla má **QloApps** (advance payment, refund rules podle dní před nástupem).
- Kolize termínů řeší zralé projekty dvěma způsoby: (a) **počítání kapacity v intervalu** (sklad − souběžné objednávky; OCA, Louez, Shelf), (b) **DB constraint** (PostgreSQL `EXCLUDE USING gist` nad `tstzrange`). Pro kola doporučujeme kombinaci: rezervace na *typ/velikost kola* (kapacita), přiřazení konkrétního kusu až při výdeji.

## 2. Přehled repozitářů

| Repozitář | ★ | Aktivita | Licence | Stack |
|---|---|---|---|---|
| Synapsr/Louez | 48 | aktivní (10/2026, 1 185 commitů) | AGPLv3 | Next.js 16, TS, Tailwind 4, MySQL + Drizzle, better-auth, Stripe, React PDF, next-intl (13 jazyků) |
| Shelf-nu/shelf.nu | 3,0k | aktivní (10/2026) | AGPL-3.0 | React Router 7, Prisma 6, Postgres/Supabase, Tailwind |
| Qloapps/QloApps | 14,4k | aktivní (6 235 commitů) | OSL-3.0 (jádro) | PHP 8.1+, MySQL, struktura PrestaShopu (modules/themes/override) |
| LibreBooking/librebooking | 817 | aktivní (5 457 commitů) | GPL-3.0 | PHP 8.2+, MySQL/MariaDB, Bootstrap 5 |
| alextselegidis/easyappointments | 4,4k | aktivní (4 089 commitů) | GPL-3.0 | PHP (CodeIgniter), MySQL, REST API |
| OCA/vertical-rental | 24 | udržováno (default branch 19.0, CI) | AGPL-3.0 | Odoo (Python) |
| adam-rms/adam-rms | 62 | aktivní (1 140 commitů) | AGPL-3.0 | PHP 8.3, Twig, MySQL 8, S3, Docker |
| leihs/leihs | 245 | aktivní (2 073 commitů) | GPL-3.0 | Ruby + Clojure, Postgres, monorepo (admin/borrow/inventory/lending/procurement/mail) |
| cyklokoalicia/OpenSourceBikeShare | 183 | udržováno, nová verze ve vývoji | GPL-3.0 | PHP, JS, Docker, OpenAPI + JWT |
| Robert-2/Robert2 (Loxya) | 55 | aktivní (830 commitů) | vlastní licence | web app (PHP), PDF nabídky/faktury |
| nbt4/rentalcore | 70 | aktivní (726 commitů) | neověřeno | Go/Gin/GORM, Postgres 16, React 19, PWA |
| qx04222/openrental | 1 | aktivní (10/2026, RC 1.0) | Apache-2.0 | TS end-to-end: Express + tRPC, Drizzle/Postgres, React/Vite |
| transportkollektiv/openbike | 60 | meta-repo | neuvedeno | Django (cykel) + web frontend (voorwiel), zámky, GPS |
| OpenReservation/OpenReservation | 246 | aktivní (1 252 commitů) | MIT | ASP.NET Core, Angular |
| manjurulhoque/BoltBike | 23 | 50 commitů | MIT | Django 5.2 DRF, React 18/TS, shadcn |

## 3. Co z jednotlivých projektů převzít a čeho se vyvarovat

**Louez** – každý obchod má vlastní brandovaný storefront (logo, barvy, light/dark), filtrovatelný katalog s dostupností v reálném čase, košík s výběrem dat a dynamickou cenou, bezheslový zákaznický portál, editovatelné právní stránky (obchodní podmínky), auto-generované PDF smlouvy, e-maily (potvrzení, připomínky), týdenní/měsíční kalendář, role v týmu. Režim `LOUEZ_MODE=platform` = multi-tenant se subdoménami – přesně náš model „jedna instance, více půjčoven". Platby: Stripe je volitelný; bez něj storefront padá na „žádost o rezervaci" nebo „platba na místě". Souhlas s podmínkami při checkoutu slouží jako podpis smlouvy (PR #58). Roadmapa: „Deposit holds" = autorizace zálohy bez stržení, pozdější release/capture.
*Převzít:* strukturu storefront ↔ dashboard, fallback režimy plateb, platform mode, právní stránky v CMS. *Vyvarovat se:* AGPL (při úpravách a provozu jako SaaS musíme sdílet zdroj) – spíše inspirace než fork; MySQL místo Postgresu (bez range constraintů).

**Shelf.nu** – nejčistší stavový model: *Draft* (lze smazat) → *Reserved* (assety blokovány pro překryvy, ale fyzicky stále „Available") → *Ongoing* (po check-outu) → *Overdue* (automaticky po uplynutí konce) → *Completed* (vše vráceno) → *Archived*. Kits (sady: kolo + helma + zámek), QR štítky, multi-workspace, audit log.
*Převzít:* stavy, rozlišení „rezervováno vs. fyzicky vydáno", kity, automatický Overdue. *Vyvarovat se:* je to asset management bez cen/plateb – e-commerce část si musíme dodat.

**QloApps** – hotelový booking engine s **advance payment** (sloupce `is_advance_payment`, `advance_paid_amount` v objednávce), stavy objednávky „awaiting payment / partial payment received / complete payment received", **refund rules**: typ srážky (% nebo fixní), odlišná srážka pro zálohu a pro plnou platbu, platnost podle počtu dní před check-inem; refund politika napojená na CMS stránku. Témata, multi-hotel, moduly platebních bran.
*Převzít:* model rezervačního poplatku jako částečné platby objednávky + storno tabulku podle dní před vyzvednutím. *Vyvarovat se:* těžký PHP/PrestaShop monolit, hotelová doména (pokoje/noci).

**LibreBooking** – rezervace zdrojů s waitlisty, kvótami a kredity, vlastní témata a barevná schémata, plugin architektura, ICS export.
*Převzít:* kvóty/kredity jako alternativu kauce pro B2B zákazníky, ICS feed pro provozovatele. *Vyvarovat se:* bez plateb, bez multi-tenancy, PHP+Smarty UI.

**Easy!Appointments** – referenční rezervační systém: entity appointments / customers / services / providers, „working plans and booking rules", Google Calendar sync, REST API.
*Převzít:* koncept otevírací doby a výjimek (provider working plan) → otevírací hodiny půjčovny určují povolené časy výdeje/vrácení. *Vyvarovat se:* slotový model (30 min) se na vícedenní pronájem nehodí.

**OCA/vertical-rental** – moduly `rental_base`, `sale_rental` (pronájem jako řádek prodejní objednávky s datem od/do), `rental_pricelist` (ceny podle časové jednotky: hodina/den/týden), `rental_offday` (dny, které se neúčtují), `rental_product_pack`, `rental_check_availability` (dostupnost = sklad − produkty v souběžných objednávkách ve stejném okně; vizuální varování na řádku + odkaz na kolidující objednávky).
*Převzít:* ceník podle časové jednotky, přepočet dní, kapacitní kontrola s odkazem na kolize. *Vyvarovat se:* závislost na Odoo.

**AdamRMS** – „instance" jako jednotka multi-tenancy, dvouúrovňová oprávnění (server / business), soft-delete všude, čárové/QR kódy, stav dispatch u assetů, Stripe pro předplatné instancí.
*Převzít:* model instance + per-tenant role, soft-delete, Stripe Billing pro naše zákazníky-půjčovny. *Vyvarovat se:* AGPL, PHP/Twig.

**leihs** – univerzitní půjčovna: rezervace → schválení správcem poolu → **hand over** (tisk smlouvy, čárové kódy) → **take back**; více „inventory pools" s vlastními správci.
*Převzít:* oddělení modelu (typ kola) a konkrétního kusu, čtečka kódů při výdeji/vrácení, pooly = pobočky. *Vyvarovat se:* složitý Ruby+Clojure monorepo.

**OpenSourceBikeShare** (Bratislava, ~80 kol) – webová mapa stojanů s dostupností, půjčení přes SMS/QR, kreditní systém, OpenAPI s JWT + refresh tokeny.
*Převzít:* mapu s dostupností kol v reálném čase, kredity/předplacené, API-first. *Vyvarovat se:* bikesharing (minutové výpůjčky, bez rezervací dopředu).

**Loxya/Robert2** – vizuální časová osa událostí, více „parků" (poboček), seznamy materiálu s identifikací mezer (chybějící kusy), PDF nabídky a faktury.
*Převzít:* timeline kalendář pro admin, pobočky. *Vyvarovat se:* nestandardní licence, eventová doména.

**RentalCore** – jobs se stavy Planning → Confirmed → Completed / Cancelled, real-time kontrola dostupnosti při přiřazení zařízení, **verzování jobů pro detekci konfliktů**, soft delete, audit s replay, PWA.
*Převzít:* optimistické verzování rezervace (dva operátoři současně), PWA pro výdejní pult. *Vyvarovat se:* nejasná licence, německé B2B specifika.

**openrental** (1★, ale promyšlená architektura) – „každá koruna zákazníka je přesně na jednom místě: alokovaná na faktuře, držená jako kauce, nebo na kreditním zůstatku"; kauce odstupňované délkou pronájmu, při uzavření objednávky explicitně převedené na nájem nebo zůstatek; finanční doklady append-only (opravy jako dobropisy); vedlejší efekty „claimed → executed → settled" s retry cronem; dostupnost odvozená výhradně z reálných blokátorů.
*Převzít:* ledger přístup ke kauci/rezervačnímu poplatku, append-only doklady, idempotentní zpracování plateb. *Vyvarovat se:* severoamerické daně, 63 tabulek – přestřelené pro půjčovnu kol.

**Krátce:** *openbike* – integrace chytrých zámků a GPS (budoucí rozšíření); *OpenReservation* – jednoduchý flow „slot → schválení adminem", blacklist uživatelů (užitečné pro no-show); *BoltBike* – P2P e-kola, booking request s přijetím vlastníkem, přepínač stavu kola available/unavailable/maintenance; Stripe jen plánován.

## 4. Doplňkové stavební kameny

- **QR platba (SPAYD, standard ČBA):** `tedyno/qrplatba` (TS, SVG/data-URL, IBAN-aware), `@spayd/core` (npm), `Tajnymag/spayd-js`. Generujeme QR pro rezervační poplatek i doplatek převodem.
- **Mapa cyklostezek:** Leaflet + plugin leaflet-gpx pro GPX trasy, podkladová vrstva **CyclOSM** (open-source cyklo render OSM), **BRouter** pro cyklo routing, **gpx.studio** (MIT) umožňuje embed editoru tras. Body zájmu v okolí jako GeoJSON vrstva.
- **Zamezení dvojí rezervace v DB:** PostgreSQL `btree_gist` + `EXCLUDE USING gist (bike_id WITH =, tstzrange(from,to,'[)') WITH &&) WHERE (status NOT IN ('cancelled'))` – polootevřený interval umožní navazující výpůjčky, stornované řádky zůstanou pro audit. (V SQLite nahradíme transakcí + aplikační kontrolou, viz plán.)

## 5. Poučení z open source (13 bodů)

1. **Stavy rezervace** se v praxi sbíhají na: *draft/cart* → *pending (čeká na poplatek)* → *confirmed (rezervační poplatek zaplacen)* → *ongoing/vydáno* → *overdue* (automaticky) → *returned* → *settled/vyúčtováno* (+ *cancelled*, *no-show*, *archived*). Shelf a leihs důsledně oddělují „rezervováno" od „fyzicky vydáno".
2. **Rezervujte typ, přiřazujte kus:** rezervace vzniká na model (horské kolo M), konkrétní rám se přiřadí při výdeji (leihs, OCA, Shelf „model reservations"). Umožní servis, přesuny mezi pobočkami a nerozbije rezervaci defektem jednoho kola.
3. **Dostupnost = kapacita − překryvy:** `available(type, [od,do)) = stock(type) − count(rezervace typu, status ∈ blokující, interval && [od,do))`. OCA zobrazuje kolidující objednávky přímo u řádku – převzít do adminu.
4. **Dvojí pojistka proti kolizi:** aplikační check pro UX + DB constraint/transakce (`SELECT … FOR UPDATE` nad řádky typu kola nebo EXCLUDE constraint). RentalCore přidává verzování záznamu proti souběžné editaci dvěma operátory.
5. **Buffer mezi výpůjčkami** (čištění, kontrola) a **off-days** (OCA `rental_offday`) modelujte jako parametry typu kola / pobočky, ne jako natvrdo zapsaný kód.
6. **Rezervační poplatek jako částečná platba objednávky** (QloApps `advance_paid_amount`), nikoli samostatná entita: doplatek = cena − zaplaceno; stav „partial payment received". Storno tabulka podle dní před vyzvednutím s odlišnou srážkou pro zálohu vs. plnou platbu.
7. **Kauce ≠ rezervační poplatek:** kauci řešte jako autorizaci karty (hold) s pozdějším capture/release (Louez roadmapa) nebo jako položku ledgeru (openrental); u platby převodem/QR kauce hotově či kartou na místě.
8. **Peněžní ledger místo flagů:** každá platba má přesně jeden stav (na faktuře / držena / kredit); refundy nikdy neupravují historii, vznikají jako dobropis (openrental, Louez PR #60 – refundy nepočítat do tržeb).
9. **Fallback platebních režimů:** storefront musí fungovat i bez karetní brány – „žádost o rezervaci" a „platba na místě" (Louez). Pro ČR přidat převod + SPAYD QR s automatickým párováním podle VS.
10. **Smlouva a souhlas:** souhlas s obchodními podmínkami při checkoutu se zaznamená (čas, verze podmínek, IP) a tiskne na PDF smlouvu jako podpis (Louez PR #58). Právní stránky (OP, GDPR, reklamace) spravovat jako editovatelný obsah per tenant, verzované.
11. **White-label/theming:** jeden kód, konfigurace tenantu v DB (logo, barvy jako design tokens, light/dark, doména/subdoména, texty, jazyky). Louez `platform` mode a AdamRMS „instance" potvrzují, že stačí `tenant_id` na každé tabulce + routing podle hostname. Naše „3 odlišné designy" = 3 téma-presety (layout + tokeny), ne 3 kódové větve.
12. **Kalendář pro admin je timeline** (řádky = kola/typy, sloupce = dny; Loxya, Louez), pro zákazníka je to **výběr rozsahu dat + počet kusů** s okamžitou cenou a dostupností (Louez košík). Slotový model (Easy!Appointments) použijte jen pro časy výdeje/vrácení v rámci otevírací doby.
13. **Provozní detaily, které zralé projekty mají:** soft-delete, audit log, QR/čárový kód na každém kole pro výdej/vrácení, stav kola (available / maintenance / retired), automatické e-maily (potvrzení, připomínka den před, po vrácení), ICS export, role (majitel, obsluha, zákazník), i18n od začátku (Louez 13 jazyků).

## Zdroje

- https://github.com/Synapsr/Louez (README, LICENSE, PR #58, #60)
- https://github.com/Shelf-nu/shelf.nu; https://www.shelf.nu/knowledge-base/introduction-to-bookings
- https://github.com/Qloapps/QloApps; https://docs.qloapps.com/hrs/manage_refund_rules/
- https://github.com/LibreBooking/librebooking
- https://github.com/alextselegidis/easyappointments
- https://github.com/OCA/vertical-rental (branch 16.0); https://apps.odoo-community.org/modules/rental_check_availability
- https://github.com/adam-rms/adam-rms
- https://github.com/leihs/leihs
- https://github.com/cyklokoalicia/OpenSourceBikeShare
- https://github.com/Robert-2/Robert2
- https://github.com/nbt4/rentalcore
- https://github.com/qx04222/openrental
- https://github.com/transportkollektiv/openbike
- https://github.com/OpenReservation/OpenReservation
- https://github.com/manjurulhoque/BoltBike
- https://github.com/ishandutta2007/Awesome-Equipment-Rental-Management
- https://github.com/topics/equipment-rental; https://github.com/topics/rental?o=desc&s=stars; https://github.com/topics/bike-rental
- https://github.com/tedyno/qrplatba; https://www.npmjs.com/package/@spayd/core; https://github.com/Tajnymag/spayd-js
- https://www.cyclosm.org/; https://wiki.openstreetmap.org/wiki/Track-drawing_websites
- https://dev.to/ripazocom/preventing-double-bookings-with-postgresql-exclusion-constraints-5efn; https://www.jusdb.com/blog/postgresql-range-types-exclusion-constraints

Poznámka: u RentalCore a openbike se nepodařilo z veřejné stránky ověřit licenci – před případným přebíráním kódu ověřit v repozitáři. Roadmapa Louez (ROADMAP.md) vracela 404, informace o „Deposit holds" pochází z indexovaného obsahu ve výsledcích vyhledávání.
