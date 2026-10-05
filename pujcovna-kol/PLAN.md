# Půjčovna kol – web s rezervacemi a platbami jako „muster“ pro více půjčoven: PLÁN

Stav: návrh k rozhodnutí, 5. 10. 2026. Vychází z pěti rešerší veřejných GitHub projektů a dokumentace
(složka [docs/vyzkum/](docs/vyzkum/)) a z toho, jak už v tomto repozitáři stavíme Cenotvorbu a Cyklo & Ski mapu.
Nic z toho zatím není naprogramováno – tento dokument říká **co, proč, v jakém pořadí a co je třeba rozhodnout**.

---

## 0. Jak bych postupoval – v deseti bodech

1. **Nestavět na cizím hotovém systému, ale na vlastním jádru.** Nejbližší open-source vzory (Louez, Shelf.nu, QloApps, AdamRMS) jsou AGPL/GPL nebo PHP monolity – bereme z nich *vzory* (stavový automat rezervace, záloha jako částečná platba, white-label přes konfiguraci), ne kód. Vlastní jádro v Node bez závislostí je přesně to, co už umíme z Cenotvorby, a má nejmenší útočnou plochu – což je u priority „bezpečnost dat“ rozhodující.
2. **Jedna aplikace, jedna databáze na půjčovnu.** Každá půjčovna = samostatný SQLite soubor, vlastní tajemství, vlastní subdoména musteru odvozená z názvu jejího webu (např. `utridubu.rezervacekol.cz`). Odpovídá to právní realitě (každá půjčovna je správce osobních údajů, my jsme zpracovatel), výmaz při odchodu klienta je smazání souboru, a chyba v jednom dotazu nikdy nevynese data jiné půjčovny.
3. **Karty nikdy nesahají na náš server.** Platba kartou jde přes hostovanou stránku brány (redirect), takže jsme v nejnižším režimu PCI DSS (SAQ A). Převod a QR Platba (standard SPAYD) generujeme sami a párujeme přes bankovní API (Fio zdarma) nebo ručně.
4. **Rezervační poplatek je fixní částka za každé kolo a účtuje se jako částečná platba objednávky**, ne zvláštní entita: při finálním vyúčtování se odečte (`doplatek = cena − zaplaceno`). Storno pravidla jsou tabulka „hodin před vyzvednutím → kolik z poplatku propadá“, nastavitelná per půjčovna. Kauce je něco jiného (vratná jistota), blokuje se až při převzetí a půjčovna nabízí obě formy: hotově či terminálem na místě, nebo preautorizací karty přes bránu.
5. **Rezervujeme typ kola, konkrétní kus přiřazujeme při výdeji.** Dostupnost = počet kol daného typu a velikosti − překrývající se rezervace (s bufferem na čištění). Kontrola i zápis běží v jedné transakci, takže dvojí rezervace nevznikne.
6. **Mapa cyklostezek a zajímavosti z dat, která už máme.** Cyklo & Ski mapa obsahuje všech 4 280 tras a 12 932 míst ČR z OpenStreetMap. Pro každou půjčovnu při nasazení vyřízneme okolí (25–30 km od adresy), doplníme převýšení (Mapy.cz Elevation), zajímavosti (OSM × Wikidata × Wikipedie, obrázky jen pod volnou licencí) a GPX ke stažení. Podklad: Mapy.cz „outdoor“ (zdarma do 250 000 dlaždic měsíčně, komerčně povoleno), záložně CyclOSM.
7. **Tři designy = tři sady tokenů a layoutových variant nad jedním HTML**, ne tři weby: „Outdoor“ (zemitý, fotografický), „Sport“ (tmavý, kontrastní), „Family“ (světlý, zaoblený). Půjčovna si vybere, doplní logo, barvy, fotky a texty.
8. **Právní texty jako parametrizované šablony** (obchodní podmínky, zásady ochrany osobních údajů, zpracovatelská smlouva mezi nami a půjčovnou, záznamy o činnostech zpracování) – doplní se název, IČO, poplatky, storno, zpracovatelé. **Finální znění musí projít advokátem** – rešerše je podklad, ne právní rada.
9. **Bezpečnost jako checklist, který se kontroluje v CI a při každém nasazení**, ne jako kapitola na konci: šifrování citlivých polí (AES-256-GCM), scrypt hesla, 2FA pro obsluhu, podepsané session, CSRF, přísná CSP, rate limiting, audit log bez osobních údajů, šifrované zálohy s testovanou obnovou, žádné kopie dokladů (ÚOOÚ i zákon o občanských průkazech).
10. **Postupovat po fázích s funkčním výsledkem na konci každé**: jádro + prezentace → rezervace → platby → mapa a okolí → designy 2 a 3 → hardening a pilot. Odhad 10–16 týdnů pro 1–2 vývojáře, viz kap. 14.

---

## 1. Co stavíme a pro koho

| Role | Co potřebuje |
|---|---|
| **Zákazník** (návštěvník webu) | pěkná prezentace půjčovny, přehled kol s cenami a dostupností, rezervace na termín za pár kliknutí, zaplacení rezervačního poplatku kartou / převodem / QR, potvrzení e-mailem, mapa cyklostezek a tipy na výlety, srozumitelné podmínky, jistota, že jeho data nikdo nesdílí |
| **Obsluha půjčovny** (majitel, brigádník) | admin: kalendář, dnešní výdeje a vrácení, přiřazení kol, kauce, doplatek, předávací protokol, poškození, vratky, ceník, sezóny, texty a fotky, export do účetnictví |
| **Provozovatel musteru** (my) | založit půjčovnu za hodinu (slug, doména, téma, data), bezpečně provozovat desítky instancí na jednom serveru, zálohovat, aktualizovat jedním příkazem, mít přehled o zdraví a incidentech |

**Rozsah MVP (první verze pro pilotní půjčovnu):** prezentace + katalog kol + rezervace s poplatkem + platby (karta přes jednu bránu, převod + QR, ruční i Fio párování) + výdej/vrácení/vyúčtování + doklady + e-maily + mapa okolí + zajímavosti + OP/Zásady/cookies + admin + 1 design. Designy 2 a 3 následují ihned po pilotu.

**Mimo MVP (později):** elektronický podpis smlouvy, více poboček v jedné půjčovně (datový model na to připravíme), chytré zámky/GPS, věrnostní program, mobilní aplikace, dynamická cenotvorba (lze později napojit na Cenotvorbu), katalog všech našich půjčoven nad Cyklo & Ski mapou (zajímavá synergie pro prodej).

---

## 2. Klíčová rozhodnutí a proč

| Rozhodnutí | Volba | Důvod | Zamítnuté alternativy |
|---|---|---|---|
| Backend | **Node 24 LTS** (kompatibilní s 22.13+), CommonJS, `node:http` + vlastní router, **0 npm závislostí**, klientské knihovny vendorované | navazuje na Cenotvorbu; žádný cizí kód k auditu; `npm audit` triviálně čistý | Express/Fastify (desítky závislostí), Django/Laravel (druhý stack v týmu) |
| Databáze | **`node:sqlite`, jeden soubor na půjčovnu** + `platform.db` pro seznam půjčoven | izolace dat, záloha = kopie, výmaz = smazání; SQLite má jednoho zapisovatele → kontrola dostupnosti v transakci je bezpečná | PostgreSQL + RLS (další služba, overkill pro desítky rezervací denně); sdílená DB s `tenant_id` (riziko úniku mezi půjčovnami) |
| Renderování | **SSR HTML z Node + progresivní vanilla JS** (kalendář, filtry, mapa) | SEO půjčovny (lokální vyhledávání), rychlost, přísná CSP bez `unsafe-inline`, bez build kroku | SPA (Next/Nuxt/SvelteKit); Astro by šlo, ale přidává stovky devDependencies |
| Platby kartou | **adaptér `PaymentProvider`**, první brána **Comgate** (tarif Easy, první rok Start), záložní **Stripe** (Checkout); GoPay vyřazen, ThePay jen nouzová třetí česká varianta | ověřeno v [rešerši 06](docs/vyzkum/06-vyber-platebni-brany.md): Comgate je při našich obratech nejlevnější brána s veřejně doloženým ceníkem (≈ 2 500 Kč/rok malá půjčovna, ≈ 7 600 Kč střední; první rok se Startem ≈ 870 / 4 000 Kč), statický merchant+secret bez SDK, česká dokumentace, licence ČNB, preautorizace 7 dní; slabinu nepodepsaných notifikací řeší adaptér (stav vždy dotazem na API). Stripe má jiný rizikový profil (0 Kč paušál, HMAC webhooky, okamžitá aktivace, mezinárodní karty), ale fixních 6,50 Kč/transakci ho zdražuje o 40–110 % | GoPay (preautorizace jen 4 dny a jen v legacy API, sazba 0,95 % jen „individuálně“, sazebník od 11/2026 2,15–2,30 % + 3 Kč), ThePay (vyšší paušál, PCI Level nedoložen), GP webpay (přes banku, zastaralé SDK), Adyen (minimální měsíční faktura) |
| Převod a QR | **SPAYD generovaný serverem**, VS = číslo rezervace, párování **Fio API** (zdarma) / import výpisu / ruční potvrzení | QR Platbu čtou všechny české banky; Fio má jediné bezplatné čitelné API bez PSD2 licence | PSD2 AIS (vyžaduje licenci ČNB), placená API bank (KB ADAA, ČS Premium – lze přidat jako adaptéry) |
| Admin | **vlastní jednoduchý admin** (vzor Cenotvorba: vanilla JS views nad `/api/v1`) | nejmenší útočná plocha; Strapi měl v roce 2026 kritické CVE, Directus není OSS | AdminJS, react-admin, Payload, Directus, Strapi |
| Theming | **CSS tokeny ve 3 vrstvách + `data-theme` + layoutové varianty v manifestu půjčovny**, fonty self-hostované | 3 skutečně odlišné designy nad jedním HTML; žádné Google CDN (GDPR, CSP) | Tailwind presety (build krok), 3 oddělené šablony (trojí údržba) |
| Mapa | **Leaflet (vendor) + Mapy.cz outdoor + CyclOSM**, data z Cyklo & Ski mapy, POI z OSM/Wikidata/Wikipedie | 0 Kč měsíčně v limitech, licenčně čisté, znovupoužití hotové pipeline | MapLibre (vektorové, pomalejší na GeoJSON), Google Maps/Places (drahé, zákaz ukládání) |
| Hosting | **jeden Hetzner VPS (EU) + Docker Compose + Caddy s wildcard certifikátem (DNS-01) pro subdomény půjčoven**, on-demand TLS jen pro případné vlastní domény, Litestream + restic zálohy | známý postup (`hetzner.sh`), desítky půjčoven na CX22, data v EU; wildcard = založení půjčovny bez čekání na certifikát, názvy klientů nejsou v CT lozích, limity Let's Encrypt nehrají roli | kontejner per půjčovna (jen pro VIP), PaaS mimo EU, čistě on-demand TLS (max ~45 nových půjčoven týdně, veřejný seznam klientů v CT) |
| Hlavní doména | **`pujcovna.cz` je obsazená** (registr CZ.NIC: držena od 1998, aktivní, transfer lock) → doporučení **`rezervacekol.cz`** (volná k 5. 10. 2026), registrovat ihned na 3+ roky; zálohy `kolapujcovna.cz`, `rezervujkolo.cz` jako přesměrování | krátká, popisuje funkci, čte se dobře jako `utridubu.rezervacekol.cz`; detaily a 10 volných alternativ v [rešerši 07](docs/vyzkum/07-domeny-a-tls.md) | odkup `pujcovna.cz` (nereálné), vlastní doména každé půjčovny jako výchozí (zadavatel chce subdomény) |
| Doklady totožnosti | **nikdy kopie ani sken**, jen typ + číslo v šifrovaném poli, automatický výmaz po vypořádání | stanovisko ÚOOÚ 2021, § 39 zákona č. 269/2021 Sb. | upload fotky dokladu (časté v praxi, ale protiprávní bez svobodného souhlasu) |

---

## 3. Architektura

```
 zákazník ──HTTPS──▶ Caddy (wildcard *.rezervacekol.cz; on-demand TLS jen pro vlastní domény) ──▶ app (Node, 1 proces)
                                                                  │
                           hostname → tenant (slug) ──────────────┤
                                                                  ├─ SSR stránky (téma podle tenant.json)
                                                                  ├─ /api/v1/…  (rezervace, platby, admin)
                                                                  ├─ /admin     (obsluha půjčovny, 2FA)
                                                                  ├─ /platform  (my: tenanti, zdraví, zálohy)
                                                                  ├─ jobs: expirace, Fio poller, retence, připomínky
                                                                  │
            /data/platform.db   /data/tenants/<slug>.db   /data/tenants/<slug>/ (fotky, okoli.json, doklady)
                                                                  │
   brána karet (redirect + notifikace) ◀──▶ payments/comgate.js ──┤
   Fio API (čtení pohybů)              ◀──▶ payments/matchers/fio.js
   e-mail API (EU)                     ◀──  mail/
   Mapy.cz tiles + elevation (build)   ◀──  tools/build-okoli.js (při založení půjčovny, pak měsíčně)
   Litestream → S3 (Hetzner Object Storage), restic → Storage Box
```

### Struktura složky `pujcovna-kol/` (návrh)

```
pujcovna-kol/
  server.js                 vstup: http server, hostname → tenant, routing, statické soubory
  src/
    db.js                   node:sqlite, migrace (MIGRATIONS[] + schema_version) – vzor Cenotvorba
    platform/               platform.db: tenanti, domény, účty provozovatele, zdraví
    tenant/                 načtení tenant.json + otevření tenant DB, cache, limity
    crypto/                 fields.js (AES-256-GCM, verze klíče), passwords.js (scrypt), totp.js, tokens.js
    http/                   router, cookies, session, csrf, ratelimit, headers (CSP, HSTS…), body parsing, static
    domain/                 bikes, pricing, availability, reservations (stavový automat), cancellation, handover
    payments/               provider.js (rozhraní), comgate.js (první brána), stripe.js (záložní, po pilotu),
                            bank-transfer.js (SPAYD + QR SVG), matchers/{fio,import,manual}.js, ledger.js, documents.js
    mail/                   odesílání přes HTTPS API poskytovatele, šablony (potvrzení, připomínka, doklad, storno)
    render/                 SSR: layout, stránky, komponenty, i18n (cs/en/de), escapování
    jobs/                   scheduler: expirace rezervací, poller banky, retence/mazání, připomínky, outbox e-mailů
    audit.js, log.js        audit log (append-only), provozní log bez PII
  public/
    base.css                tokeny (primitiva → semantika → komponenty) + komponenty
    themes/{outdoor,sport,family}.css
    js/                     kalendář, filtry kol, checkout, mapa (progresivně)
    vendor/                 leaflet, markercluster, qrcode-generator, vanilla-calendar-pro (MIT/BSD, zkopírované)
    fonts/                  self-host (OFL), subset latin-ext
    admin/                  views/*.js + lib/* (převzít z repricing/public/lib)
  tenants/<slug>/           tenant.json (téma, brand, texty, otevírací doba, poplatek, storno), fotky, okoli.json
  legal/                    šablony OP, Zásad, zpracovatelské smlouvy, záznamu o činnostech, cookie lišty (MD s parametry)
  tools/                    new-tenant.js, build-okoli.js, demo-data.js, check-contrast.js, export-pohoda.js
  deploy/                   Dockerfile, docker-compose.yml, Caddyfile, hetzner.sh, litestream.yml
  test/                     node --test: jednotkové, API, platby (mock brány), e2e tok rezervace
  docs/                     SPEC.md, BEZPECNOST.md, NASAZENI.md, MANUAL.md (pro půjčovnu), ONBOARDING.md, vyzkum/
```

---

## 4. Datový model (per půjčovna, SQLite)

Peněžní částky v haléřích (`*_minor`, INTEGER), časy ISO UTC, JSON sloupce jako TEXT, osobní údaje v polích `*_enc` šifrované aplikací (AES-256-GCM), e-mail navíc jako HMAC otisk pro vyhledání.

| Tabulka | Klíčové sloupce | Poznámka |
|---|---|---|
| `settings` | key, value | otevírací doba, buffer mezi výpůjčkami, výše poplatku, storno tabulka, IBAN, brána, DPH režim |
| `users` | email, password_hash (scrypt), role owner/staff, totp_secret_enc, disabled | obsluha půjčovny; 2FA povinné |
| `sessions` | id_hash, user_id, expires_at, last_seen_at, ip_hash | server-side session, idle 30 min, absolutní 8 h |
| `bike_types` | slug, name, category, description, photos, sizes, specs, deposit_minor, fee_minor, active | „Horské kolo Trek Marlin“; poplatek a kauce per typ |
| `bikes` | bike_type_id, inventory_code, size, frame_no_enc, status available/maintenance/retired | konkrétní kusy; QR štítek s kódem |
| `price_rules` | bike_type_id, season_id, unit hour/halfday/day/week, from_qty, price_minor | ceník s pásmy (1 den, 2–3, 4–6, 7+) a sezónami |
| `seasons`, `closures` | from, to, name/reason | sezónní ceny; zavírací dny a blokace |
| `accessories` | name, price_minor, stock | přilba, dětská sedačka, vozík, zámek |
| `customers` | email_hmac, email_enc, name_enc, phone_enc, address_enc, birth_date_enc, id_doc_type, id_doc_number_enc, id_doc_consent_at, marketing_consent_at, anonymized_at | minimum údajů; dva režimy dokladu (kap. 8): A = typ + číslo se souhlasem držitele OP, B = bez čísla, místo něj datum narození + adresa; číslo dokladu se maže po vypořádání |
| `reservations` | number (= VS), status, customer_id, from_at, to_at, total_minor, fee_minor, paid_minor, deposit_minor, terms_version, consent_at, consent_ip_hash, expires_at, version | stavový automat (kap. 5); `version` pro optimistické zámky v adminu |
| `reservation_items` | reservation_id, bike_type_id, size, bike_id (NULL do výdeje), unit_price_minor, fee_minor, accessories | jeden řádek = jedno kolo → poplatek za kolo |
| `payments` | reservation_id, purpose fee/balance/deposit_hold/refund, method card/bank_transfer/cash/terminal, provider, provider_ref, amount_minor, captured_minor, status, idempotency_key | nikdy data karet |
| `bank_transactions` | source fio/import, tx_id UNIQUE, booked_at, amount_minor, vs, msg, counter_account, matched_payment_id, raw | každý pohyb jednou (idempotence) |
| `webhook_events` | provider, event_id UNIQUE, payload, processed_at | notifikace brány jen jako podnět k ověření stavu |
| `ledger_entries` | reservation_id, type fee_paid/balance_paid/deposit_held/deposit_captured/refund/storno_fee, amount_minor, payment_id | každá koruna právě jednou; součet vždy sedí |
| `documents` | reservation_id, type receipt/advance_tax_doc/final_doc/credit_note/contract/handover, number, issued_at, data | číselné řady per typ a rok; HTML/PDF |
| `handovers` | reservation_id, type pickup/return, at, by_user_id, bike_id, condition, damage_minor, note | předávací protokol a vrácení |
| `content_pages` | slug, title, body_md, version, published_at | OP, Zásady, O nás, Reklamace – verzované, verze se zapisuje k souhlasu |
| `poi_overrides` | poi_id, hidden, custom_text, sort | ruční úpravy zajímavostí z `okoli.json` |
| `audit_log` | at, user_id, action, entity, entity_id, meta, ip_hash | append-only, bez osobních údajů v `meta` |
| `outbox` | type, payload, run_at, attempts, done_at | e-maily a volání bran s opakováním |

`platform.db`: `tenants(slug, name, domains, theme, status, created_at)`, `platform_users` (my, 2FA), `platform_audit`, `health_snapshots`.

---

## 5. Rezervační tok a stavový automat

### Zákazník
1. **Termín** – od/do s časy v otevírací době půjčovny (kalendář blokuje zavřené dny a plně obsazené termíny).
2. **Kola** – typy, velikosti, počet; u každého okamžitá dostupnost a cena za zvolený termín; příslušenství.
3. **Údaje** – jméno, e-mail, telefon (jen to, co je k smlouvě nutné); souhlas s OP (uloží se verze, čas, otisk IP) a poučení, že u rezervace na termín není 14denní odstoupení (§ 1837 písm. j) OZ), ale platí storno podmínky.
4. **Rezervační poplatek** – součet poplatků za kola; výběr: **karta** (redirect na bránu, návrat, ověření stavu) · **převod / QR** (zobrazí se QR Platba + údaje, rezervace drží 48 h, u blízkého termínu kratší) · volitelně „zaplatím na místě“, pokud to půjčovna povolí (pak bez garance).
5. **Potvrzení** – e-mail s rekapitulací, dokladem o přijaté platbě, QR na doplatek (pokud půjčovna chce doplatek předem), ICS do kalendáře, odkaz na správu rezervace (podepsaný token, bez hesla).
6. **Den před** – připomínka: čas, co vzít (doklad, kauce), možnost doplatit online.

### Obsluha
- **Výdej:** v adminu otevře dnešní rezervaci, ověří doklad (zapíše typ + číslo), přiřadí konkrétní kola (sken QR štítku), zaznamená kauci (preautorizace kartou přes bránu/terminál, nebo hotově), vybere doplatek (není-li zaplacen), vytiskne/odešle předávací protokol → `checked_out`.
- **Vrácení:** kontrola stavu, případné poškození s částkou → `returned`; vyúčtování: uvolnění nebo částečné stržení kauce, konečný doklad → `closed`.

### Stavy rezervace

```
draft ─▶ awaiting_fee ─▶ confirmed ─▶ checked_out ─▶ returned ─▶ closed
             │               │             │
             ├─ expired      ├─ cancelled_by_customer (storno engine → vratka / propadnutí)
             │               ├─ cancelled_by_operator (plná vratka)
             │               └─ no_show (po termínu bez výdeje; poplatek dle storno pravidel)
             └─ (platba došla po expiraci → unmatched → obnovit, je-li kapacita, nebo vrátit)
```

Stavy platby: `created → pending → paid | authorized → captured | partially_captured | released | failed | expired → refunded | partially_refunded`. Všechny přechody jen přes doménovou službu, idempotentní (opakovaný „paid“ je no-op), zapsané do audit logu.

### Dostupnost a ochrana proti dvojí rezervaci
`available(typ, velikost, [od, do)) = počet kol typu/velikosti ve stavu available − počet položek rezervací v blokujících stavech (awaiting_fee, confirmed, checked_out), jejichž interval rozšířený o buffer se překrývá`. Kontrola i vložení rezervace probíhají v jedné transakci `BEGIN IMMEDIATE` (SQLite má jediného zapisovatele), takže dvě souběžné rezervace posledního kola nemohou projít obě. Admin má navíc `version` pro souběžnou editaci dvěma lidmi.

---

## 6. Platby

### Rezervační poplatek, doplatek, kauce
- **Poplatek** = **fixní částka za každé kolo** (rozhodnuto 5. 10. 2026), `fee_minor` per typ kola, výchozí návrh 300 Kč kolo / 500 Kč e-kolo, nastavitelné v adminu. Zaplacením přechází rezervace do `confirmed`; poplatek je **částečná platba ceny**.
- **Doplatek** = `total − paid` (± kredit z přeplatku). Online (karta/QR před vyzvednutím) nebo na místě (terminál/hotově – zapíše se jako externí platba).
- **Kauce** = vratná jistota, **ne příjem**: samostatná platba `deposit_hold`. Půjčovna nabízí **obě varianty** (rozhodnuto): (a) **hotově nebo platebním terminálem na místě** – obsluha zapíše částku a formu do předávacího protokolu, systém eviduje vrácení; (b) **preautorizace karty přes bránu při převzetí** – obsluha vygeneruje odkaz/QR na platební stránku brány (Comgate `preauth=true`), zákazník kartu autorizuje na svém telefonu nebo na pultu; blokace je u Comgate i Stripe **garantována 7 dní**; při vrácení se uvolní (`cancelHold`) nebo částečně strhne na škodu (`capture`). Job: 5. den upozorní obsluhu, 6. den blokaci automaticky uvolní, není-li vyúčtováno; u výpůjček delších než 5 dní systém nabídne jen variantu (a). U převodu/QR kauci nepoužíváme (vracení je pracné). Před podpisem smlouvy s Comgate písemně ověřit, že se poplatek účtuje jen ze stržené částky, ne z blokované (jinak by Stripe vyšel levněji, viz rešerše 06).
- **Storno engine:** tabulka per půjčovna, např. `≥ 72 h → 100 % poplatku zpět · 24–72 h → 50 % · < 24 h / no-show → 0 %`. Vratka jde původní metodou (karta → refund brány; převod → odchozí platba na protiúčet z `bank_transactions`, ručně potvrzená). **Právní povaha ponechané části poplatku** (návrh OP: paušální vypořádání zálohy podle § 1807 OZ; alternativy smluvní pokuta nebo odstupné) **a její režim DPH** (storno zákazníkem před plněním zpravidla mimo DPH s opravným dokladem, no-show sporný) jsou body pro advokáta a daňového poradce – systém to nese jako parametr `STORNO_DPH_REZIM`, podle kterého opravný doklad generuje, nebo ne.

### Metody
| Metoda | Jak | Bezpečnost |
|---|---|---|
| **Karta** | adaptér brány: založit platbu (částka ze serveru, nikdy z klienta) → redirect → návrat → **stav vždy ověřit dotazem na API**, notifikaci brát jen jako podnět; idempotentní zpracování (`webhook_events`). **Comgate REST v2.0:** řádek `payments` s vlastním `idempotency_key` před `POST /payment.json` (brána Idempotency-Key nemá), `refId` = číslo rezervace, `preauth=true` pro kauci; notifikace je nepodepsaný POST → vždy `GET /payment/transId/{id}.json`, `secret` z těla porovnat `timingSafeEqual` a nikdy nelogovat, IP whitelist (Comgate + Cloudflare, denně) jen doplněk; klíč `webhook_events` = `comgate:<transId>:<status>`; vratky `POST /refund.json`, jejich stav jen z denního `transferList` (rekonciliace do `ledger_entries`); stage = druhé propojení obchodu s `test=true`. **Stripe (záloha):** Checkout Session s `capture_method=manual`, webhook HMAC-SHA256 nad raw body, tolerance 300 s, deduplikace `event.id`, `Idempotency-Key`, připnutá `Stripe-Version` | PCI SAQ A (hostovaná stránka), 3-D Secure řeší brána; u Comgate je zdrojem pravdy výhradně dotaz na API, u Stripe podpis webhooku; tajemství per půjčovna šifrovaná, Comgate `secret` rotovat ročně a při odchodu zaměstnance (adaptér přechodně zná dvě hesla) |
| **Převod** | zobrazit IBAN, částku, VS = číslo rezervace, zprávu; expirace 48–72 h | párování podle VS (primárně), zprávy (regex), částky + protiúčtu (fallback); přeplatek → kredit/vratka, nedoplatek → `partially_paid` + e-mail s QR na zbytek, tolerance ±5 Kč |
| **QR Platba** | SPAYD řetězec (`SPD*1.0*ACC:…*AM:…*CC:CZK*X-VS:…*MSG:…`) → QR jako SVG na serveru | payload výhradně ze serveru; vendorovaný generátor QR (MIT), SPAYD + převod čísla účtu na IBAN napíšeme sami (pár desítek řádků) |
| **Párování banky** | **Fio (rozhodnuto)**: adaptér `FioMatcher` (REST, token read-only, interval ≥ 30 s, zarážka `set-last-id`, rotace tokenu před 180. dnem); pro půjčovny s jinou bankou `ImportMatcher` (CSV/GPC výpis) a `ManualMatcher` (potvrzení v adminu) | token šifrovaný per půjčovna; nespárované platby do fronty v adminu |
| **Na místě** | hotově/terminál – evidence v adminu | – |

### Doklady
Doklad o přijaté platbě (u plátce DPH daňový doklad k přijaté platbě do 15 dnů ode dne přijetí úplaty), konečný doklad se započtením poplatku, opravný doklad při stornu (dle `STORNO_DPH_REZIM`), předávací protokol, číselné řady per rok. U plátce DPH lze pro platby do 10 000 Kč vystavovat **zjednodušený daňový doklad** (§ 30 ZDPH) bez identifikace zákazníka – zjednoduší i pozdější výmaz osobních údajů (potvrdit s daňovým poradcem). **MVP: HTML doklady s tiskovým CSS** (e-mail i tisk), **později PDF** (vyhodnotíme malou knihovnu bez závislostí vs. headless Chromium v odděleném kontejneru). Export do účetnictví: CSV/XLSX a Pohoda XML (máme v Cenotvorbě).

### Vazba na obchodní model
Každá půjčovna má **vlastní smlouvu s bránou a vlastní účet** – peníze jdou přímo jí, my je nikdy nedržíme (žádná licence platební instituce). Přihlašovací údaje brány a Fio token jsou šifrované per půjčovna. Alternativa (jedna smlouva s bránou pro všechny, split plateb) je možná u Stripe Connect, ale přináší nám finanční odpovědnost – nedoporučuji pro start.

---

## 7. Bezpečnost dat – priorita číslo jedna

### Co chráníme a před čím
| Aktivum | Hrozba | Opatření |
|---|---|---|
| Osobní údaje zákazníků (jméno, kontakt, číslo dokladu) | únik z DB/zálohy, cross-tenant přístup, server kompromitován | DB per půjčovna; šifrování citlivých polí AES-256-GCM s klíčem mimo DB (Docker secret, soubor 600), verze klíče pro rotaci; šifrované zálohy; minimalizace (žádné kopie dokladů, automatický výmaz čísla dokladu po vypořádání, anonymizace po retenci) |
| Integrita plateb | podvržená částka, replay notifikace, dvojí zpracování | částky jen ze serveru; stav vždy ověřit u brány; `webhook_events` UNIQUE; idempotentní přechody; ledger |
| Admin účty | uhodnutí hesla, krádež session, CSRF, XSS | scrypt (N=2^17), 2FA TOTP povinné, rate limit + zámek účtu, session server-side s regenerací a timeouty, cookie `__Host-…; Secure; HttpOnly; SameSite=Strict`, CSRF token + kontrola Origin, CSP bez `unsafe-inline`, escapování všech výstupů |
| Zákaznické odkazy na rezervaci | hádání ID | podepsané tokeny s expirací (HMAC), žádná sekvenční ID v URL |
| Dodavatelský řetězec | zranitelná závislost, kompromitovaný balíček | 0 npm závislostí, vendorované knihovny s připnutou verzí a hashem, Dependabot pro Docker image a Actions, `npm audit` v CI |
| Dostupnost | DoS, výpadek serveru | rate limiting, Caddy limity, Litestream replikace, Hetzner snapshoty, Uptime Kuma |
| Logy | únik PII přes logy | provozní log bez osobních údajů, audit log s otisky (hash) místo hodnot, retence 6–12 měsíců |
| Lidé | sdílené účty, odchod zaměstnance | individuální účty, role owner/staff, přehled přihlášení, odebrání přístupu |

### Checklist do CI a před každým nasazením
Kompletní seznam 28 bodů je v [docs/vyzkum/03-bezpecnost-gdpr-podminky.md](docs/vyzkum/03-bezpecnost-gdpr-podminky.md). Automatizujeme: testy na cross-tenant přístup (rezervace půjčovny A nejde číst přes doménu B), testy CSRF/session, kontrola hlaviček (CSP, HSTS, `frame-ancestors`), `npm audit`, Trivy na Docker image, OWASP ZAP baseline scan proti stage, kontrola kontrastů témat. Ručně: čtvrtletní test obnovy zálohy se záznamem, roční revize ASVS L1 checklistu a dokumentů. Cíl: **OWASP ASVS 5.0 L1 celé, L2 pro autentizaci, session, kryptografii a přístupová práva.**

### Incident
Plán: kontakty, kdo rozhoduje, šablona ohlášení ÚOOÚ do 72 h, komunikace zákazníkům při vysokém riziku, interní evidence každého incidentu. Zpracovatelská smlouva nás zavazuje hlásit půjčovně bez zbytečného odkladu (do 24 h).

---

## 8. GDPR a právní dokumenty

- **Role:** půjčovna = správce, my = zpracovatel (čl. 28) → **zpracovatelská smlouva** je součást onboardingu každé půjčovny; seznam podzpracovatelů (hosting Hetzner EU, e-mailová služba, platební brána).
- **Právní tituly:** rezervace a smlouva (plnění smlouvy), účetnictví (zákon), číslo dokladu a bezpečnostní logy (oprávněný zájem s balančním testem – šablona ho obsahuje), newsletter a analytika (souhlas). Vlastním zákazníkům lze posílat obdobné nabídky s opt-outem.
- **Retence (výchozí, nastavitelné):** daňové doklady 10 let; smlouva a protokoly 3 roky (promlčení) až 10; nedokončené rezervace 30–90 dní; číslo dokladu 30 dní po vypořádání; logy 6–12 měsíců. Job `retence` maže/anonymizuje automaticky.
- **Práva subjektů:** admin umí export dat zákazníka (JSON) a výmaz/anonymizaci na jedno kliknutí (účetní doklady zůstávají, osobní údaje se nahradí).
- **Cookies:** jen technicky nezbytné (session, rezervace, CSRF, volba souhlasu) → **lišta bez souhlasu není nutná**; pokud půjčovna zapne analytiku, lišta opt-in s rovnocenným „Odmítnout“. Výchozí doporučení: žádné marketingové skripty, mapa až po kliknutí (Mapy.cz dlaždice jsou volání třetí straně).
- **Dokumenty generované z `legal/` + `tenant.json`:**
  1. Obchodní podmínky (15 sekcí – identifikace, rezervace a smlouva, cena/poplatek/doplatek, kauce, storno, poučení o § 1837 j), převzetí, užívání, odpovědnost a krádež, vrácení, reklamace, ČOI ADR, odkaz na Zásady, závěr) – verzované, verze se váže k souhlasu.
  2. Zásady ochrany osobních údajů (12 sekcí dle čl. 13) – samostatný dokument, ne skrytý v OP.
  3. Zpracovatelská smlouva my ↔ půjčovna.
  4. Záznam o činnostech zpracování (čl. 30) předvyplněný per půjčovna.
  5. Předávací protokol / smlouva o nájmu k podpisu na místě.
- **Doklad totožnosti – dvě varianty (zjištění oponentury):** § 39 písm. d) zákona č. 269/2021 Sb. zakazuje zpracovávat údaje uvedené v občanském průkazu bez souhlasu držitele (výjimka jen pro nahlédnutí). Návrhy proto nabízejí parametr `DOKLAD_REZIM`: **A** = zápis typu a čísla dokladu se souhlasem daným předložením a podpisem protokolu (u pasu a řidičského průkazu oprávněný zájem), odmítnutí souhlasu bez sankce s alternativou (např. vyšší kauce); **B** = bez čísla dokladu, místo něj jméno + datum narození + adresa (k žalobě na náhradu škody je číslo dokladu stejně nepoužitelné, žalovaný se označuje jménem, datem narození a bydlištěm). Výběr je rozhodnutí advokáta a půjčovny; datový model nese obě varianty (šifrovaná pole, výmaz po vypořádání).
- **Předávání mimo EU:** výchozí stav „ne“ (Hetzner EU, Comgate ČR, Fio ČR, Mapy.cz ČR); při volbě americké e-mailové služby nebo záložní brány Stripe (Stripe Payments Europe, přenos do USA) doplnit do Zásad a zpracovatelské smlouvy DPF/SCC – parametr `PREDAVANI_MIMO_EU`.
- **Advokát:** kontrolu zajišťuje zadavatel (rozhodnuto). My dodáváme návrhy všech pěti dokumentů ve složce `legal/` jako parametrizované šablony s placeholdery `{{…}}`, po oponentuře ze dvou pohledů (právo ČR; GDPR a praktičnost – celkem 129 nálezů zapracováno) a se sekcí „K ověření advokátem“ na konci každého dokumentu, aby kontrola byla rychlá a cílená. Průřezové body pro advokáta a daňového poradce: režim dokladu A/B, právní povaha a DPH ponechané části poplatku, zjednodušený daňový doklad, limit odpovědnosti ve zpracovatelské smlouvě, vyvratitelné domněnky o stavu kola v protokolu.

---

## 9. Mapa cyklostezek a zajímavosti v okolí

- **Zdroj:** data Cyklo & Ski mapy (OSM přes QLever, měsíční build) – trasy (`route=bicycle|mtb`, cyklostezky), místa. Při založení půjčovny `tools/build-okoli.js`: adresa → geokód (Mapy.cz) → trasy v okruhu R (výchozí 25 km, přes `lib/geo.js` SegmentGrid/bbox) → vzorkování výšek každých ~50 m (Mapy.cz Elevation, cca 800 kreditů na půjčovnu) → délka, převýšení, obtížnost → `okoli.json` (stovky kB místo 20 MB).
- **Zajímavosti:** OSM (`tourism=attraction|viewpoint|museum|castle`, `historic=*`, `natural=peak`) × Wikidata (typ, obrázek P18, cs článek) × cs.wikipedia (perex) × Commons (jen CC0 / CC BY / CC BY-SA, uložený autor a licence) → skóre (má článek, typ, vzdálenost, blízkost k trase) → top 20 tipů s fotkou, vzdáleností od půjčovny, odkazem na Wikipedii a na trasu v Mapy.cz. Půjčovna může v adminu skrýt, přeřadit, dopsat vlastní text nebo přidat vlastní tip (restaurace, koupaliště).
- **Stránka „Mapa a výlety“:** Leaflet 1.9.4 (vendor) + Mapy.cz `outdoor` (klíč per doména, logo a attribution dle VOP, dlaždice se necachují) s přepínačem CyclOSM; vrstvy: značené trasy podle sítě (dálková/regionální/místní/MTB), cyklostezky, zajímavosti, půjčovna; klik → název, délka, převýšení, výškový profil (vlastní SVG, bez GPL knihovny), tlačítko **Stáhnout GPX** (generujeme z `geom`), odkaz „Navigovat v Mapy.cz“. Mapa se načte až po kliknutí/scrollu (CSP, GDPR, výkon).
- **Později:** okruhy „z půjčovny a zpět“ (BRouter v Dockeru, MIT), tipy podle typu kola (e-kolo zvládne více převýšení).
- **Náklady:** 0 Kč měsíčně v limitech Mapy.cz Basic (250 000 kreditů) pro desítky půjčoven; attribution OSM/CyclOSM/Mapy.cz/Wikipedie.

---

## 10. Tři designy a theming

Jedno HTML, jedny komponenty; téma = `themes/<nazev>.css` + manifest v `tenant.json` (`theme`, `brand.logo`, `brand.primary`, `fonts`, `layout.hero/nav/cards`). Tokeny ve třech vrstvách (primitiva → semantika → komponenty). Layoutové varianty přepíná manifest (hero full-bleed / split / centrovaný, navigace, karty kol, rytmus sekcí, poloměry, stíny, animace, úprava fotek). Fonty self-hostované (OFL), kontrast ověřen skriptem v CI (text ≥ 4,5:1), `prefers-reduced-motion`, focus ring, cíle ≥ 44 px.

| | **Outdoor / Nature** | **Sport / Performance** | **Family / Clean** |
|---|---|---|---|
| Pro koho | půjčovny u řek, přehrad, v CHKO; rodinná i turistická klientela | MTB, trailparky, e-bike enduro, závodní klientela | města, lázně, rodiny s dětmi, e-kola pro seniory |
| Paleta | krém `#F5F0E6`, lesní `#2F5D3A`, terakota `#B4581B`, text `#1F2A1E` | pozadí `#0E0F12`, limetka `#C9FF3D`, červená `#D92D20`, text `#F2F4F7` | bílá, mint `#D9F2EC`, petrolej `#0F766E`, korál `#C8392C`, text `#1E2A3A` |
| Typografie | Fraunces (měkký serif) + Caveat akcenty + Inter | Barlow Condensed (verzálky, velké ceny) + Space Grotesk | Nunito + Bricolage Grotesque titulky |
| Obraz | full-bleed krajina, teplý grading, lidé zády | akce, pohyb, duotone, video hero | rodiny, děti, denní světlo, jednoduché SVG ilustrace |
| Komponenty | poloměr 6–8 px, papírová textura, pomalé fade | poloměr 0–2 px, diagonální řezy, ticker, sticky rezervační lišta | poloměr 16–24 px, pill tlačítka, měkké stíny, kroky 1-2-3 |
| Inspirace | Komoot, lokální půjčovny Lipno | Awwwards: Bike Time, Star Bicycle; Rapha | woom, Swapfiets |

Prodejní nástroj: **tři demo půjčovny** na subdoménách (`outdoor.demo…`, `sport.demo…`, `family.demo…`) se stejnými daty, aby si klient vybral na živém webu; onboarding pak jen přepne `theme` a doplní brand.

---

## 11. Admin

**Půjčovna (`/admin`, 2FA):** Dnes (výdeje, vrácení, nezaplacené, nespárované platby) · Kalendář-timeline (řádky typy/kola, sloupce dny, drag na změnu) · Rezervace (filtr, detail, přiřazení kol, kauce, doplatek, protokol, poškození, storno s výpočtem vratky, poznámky) · Kola a typy (fotky, velikosti, stav, QR štítky k tisku) · Ceník a sezóny · Příslušenství · Zákazníci (minimum, export/výmaz) · Platby (přehled, ruční párování, import výpisu, vratky) · Obsah (texty stránek, fotky, zajímavosti, verze OP) · Nastavení (otevírací doba, buffer, poplatek, storno, brána, účet/IBAN, Fio token, e-maily, uživatelé, 2FA) · Export (CSV/XLSX, Pohoda XML) · Audit log.

**Provozovatel (`/platform`, 2FA, IP omezení):** půjčovny (založit, doména, téma, stav), zdraví a verze, zálohy a poslední obnova, využití (rezervace/měsíc), incidenty. Žádný přístup k osobním údajům zákazníků půjčoven bez auditovaného důvodu („break-glass“ s logem).

Technicky vzor Cenotvorby: vanilla JS views nad `/api/v1`, znovupoužité `public/lib` (table, modal, toast, filter-builder, combobox).

---

## 12. Provoz a nasazení

- **Docker Compose:** `app` (Node, `USER node`, read-only FS, `/data` volume) + `caddy` (vlastní image s DNS pluginem; HSTS, `encode zstd gzip`, bez `Server` hlavičky, access log s rotací) + `litestream` (průběžná replikace všech `*.db` do Hetzner Object Storage) + volitelně `uptime-kuma`.
- **Domény a TLS** (detail v [rešerši 07](docs/vyzkum/07-domeny-a-tls.md)): hlavní doména musteru (doporučení `rezervacekol.cz`), půjčovna = `<slug>.rezervacekol.cz`, slug z domény jejího stávajícího webu (`utridubu.cz` → `utridubu`), `[a-z0-9-]`, 3–40 znaků, jediná úroveň; rezervované slugy `www`, `platform`, `stage`, `mail`, `bounce`, `demo-*`. **Wildcard certifikát `*.rezervacekol.cz` + apex přes DNS-01** (Caddy ≥ 2.10 s pluginem `caddy-dns/cloudflare` při DNS-only u Cloudflare s tokenem omezeným na zónu, nebo `caddy-dns/hetzner`; nejlépe delegace `_acme-challenge` do oddělené zóny) → nová půjčovna bez čekání na certifikát, názvy klientů nejsou v CT lozích. **On-demand TLS** s `ask` na `/api/tls-ask` jen pro případné vlastní domény půjčoven po pilotu. Cookies výhradně `__Host-` (bez `Domain`), `/platform` na vlastním hostu, HSTS `max-age` postupně až na rok s `includeSubDomains`, preload a Public Suffix List až po pilotu a vědomě. DNS: `A/AAAA` apex + wildcard, CAA `letsencrypt.org`, DNSSEC. E-mail z `<slug>@mail.rezervacekol.cz` s `Reply-To` půjčovny, DKIM na hlavní doméně, SPF na každém odesílacím hostu, DMARC `p=reject; sp=reject`.
- **`hetzner.sh`:** převzít (instalace, aktualizace s rollbackem, zaloha, stav, log) a rozšířit o `tenant pridat <slug> <domena>` (založí DB, zavolá `build-okoli`, přidá doménu), `tenant odebrat` (export + smazání po potvrzení), `obnova-test`.
- **Zálohy:** Litestream (point-in-time) + restic denně `/data` (DB, fotky, doklady) na Hetzner Storage Box, šifrováno, retence 7 dní / 4 týdny / 12 měsíců; `sqlite.backup()` pro konzistentní snapshot; **test obnovy měsíčně** s záznamem.
- **E-maily:** transakční přes HTTPS API poskytovatele (bez SDK), preferovat EU hosting a smlouvu o zpracování (kandidáti: Mailgun EU, Brevo, Postmark/Resend po ověření podmínek – rozhodnutí v kap. 15); SPF, DKIM, DMARC; odesílání z domény musteru s `Reply-To` půjčovny, nebo ověřená doména půjčovny; bounce webhook → admin.
- **CI (GitHub Actions):** `npm test`, `node --check`, `npm audit`, kontrola kontrastů, build image, Trivy, ZAP baseline proti stage, deploy přes SSH (jako dnes); Dependabot pro base image a actions. Nasazení jen z hlavní větve po zelených testech.
- **Prostředí:** dev (lokálně, demo data), stage (subdoména, anonymizovaná data, sandbox bran), prod.

---

## 13. Testování a kvalita

- **Jednotkové:** ceník (pásma, sezóny, půldny), dostupnost (překryvy, buffer, zavírací dny), storno engine, SPAYD/IBAN, šifrování polí (round-trip, rotace klíče), scrypt, TOTP, tokeny.
- **API:** rezervační tok včetně souběhu (dvě rezervace posledního kola najednou → jedna projde), expirace, párování plateb (přeplatek, nedoplatek, duplicitní pohyb), notifikace bran (podvržený `status=PAID`, cizí IP, replay, dvojí `paid`, podvržená částka, špatný podpis u Stripe – nic z toho nesmí změnit stav rezervace), autorizace per role, **cross-tenant testy**.
- **Mocky bran:** falešná Comgate/Stripe/Fio v testech; sandboxy bran na stage.
- **E2E:** Playwright (už v repu u Hlídače podmínek) – rezervace ve všech třech tématech, mobil + desktop, přístupnost (axe), Lighthouse ≥ 90.
- **Bezpečnost:** ZAP baseline, kontrola hlaviček, `npm audit`, Trivy; ručně checklist z rešerše před pilotem.

---

## 14. Fáze a odhad

Odhad pro 1–2 vývojáře, který se zpřesní po rozhodnutích z kap. 15. Každá fáze končí něčím, co lze ukázat.

| Fáze | Obsah | Výstup | Odhad |
|---|---|---|---|
| **0 Příprava** | zbývající rozhodnutí z kap. 15; **registrace hlavní domény** (doporučení `rezervacekol.cz`, 3+ roky) a DNS u poskytovatele s API pro DNS-01; předání návrhů z `legal/` advokátovi zadavatele; **zahájit smlouvu s Comgate** (schválení karet trvá ≈ 14 dní; písemně si vyžádat poplatek za preautorizaci, 3DS2/SCA a kategorii SAQ) a založit druhé propojení obchodu pro stage; účty: Mapy.cz API klíč, Fio testovací účet, e-mail; kostra `pujcovna-kol/`, CI, Dockerfile; SPEC.md z tohoto plánu | repozitář s testy a CI, rozhodnutí zapsaná, doména registrovaná, smlouva s bránou rozjednaná | 1 týden |
| **1 Jádro + prezentace** | platform/tenant DB a migrace; auth (scrypt, session, 2FA), šifrování polí, audit; SSR layout a téma Outdoor; stránky Domů, Kola, Detail kola, Kontakt, OP, Zásady; admin: kola, ceník, nastavení, uživatelé; `new-tenant.js` | živý web demo půjčovny bez rezervací | 2–3 týdny |
| **2 Rezervace** | dostupnost, kalendář, cena, rezervační tok (bez plateb → „platba na místě“), e-maily, expirace, správa rezervace tokenem; admin: timeline, rezervace, výdej/vrácení, protokol, doklady HTML | kompletní rezervace bez online platby | 2–3 týdny |
| **3 Platby** | `PaymentProvider`, převod + QR (SPAYD), Fio párování + import + ruční; karta přes **Comgate** (stage s `test=true` → prod); storno engine, vratky, ledger, kauce preautorizací s jobem auto-uvolnění, doklady k platbě, denní rekonciliace `transferList`, Pohoda export | rezervační poplatek online všemi třemi způsoby, vyúčtování | 2–3 týdny |
| **4 Mapa a okolí** | `build-okoli.js` (výřez, výšky, POI, licence), stránka s Leafletem, výškový profil, GPX, tipy, admin override | mapa a 20 tipů pro demo půjčovnu | 1–2 týdny |
| **5 Designy 2 a 3** | témata Sport a Family, layoutové varianty, kontrasty v CI, 3 demo subdomény, SEO (JSON-LD, sitemap, OG), i18n základ cs/en/de, výkon | prodejní showcase | 1–2 týdny |
| **6 Hardening a pilot** | bezpečnostní checklist, ZAP, Litestream + restic + test obnovy, monitoring, dokumentace (NASAZENI, MANUAL pro půjčovnu, ONBOARDING, BEZPECNOST), právní texty od advokáta, zpracovatelská smlouva, pilotní půjčovna | první ostrá půjčovna | 1–2 týdny |
| **Celkem** | | | **10–16 týdnů** |

Po pilotu: PDF doklady, druhá brána (Stripe), okruhy BRouter, více poboček, katalog půjčoven nad Cyklo & Ski mapou.

---

## 15. Rozhodnutí a otevřené otázky

### Rozhodnuto zadavatelem (5. 10. 2026)

| Téma | Rozhodnutí | Důsledek pro plán |
|---|---|---|
| **Karetní brána** | kritéria: nejlevnější pro malé obraty, nejjednodušší na údržbu, kvalitní bezpečnostní zajištění | **Comgate** (Easy, první rok Start) jako první adaptér, **Stripe** (Checkout) jako záloha; GoPay vyřazen, ThePay jen nouzově – ověřeno v [rešerši 06](docs/vyzkum/06-vyber-platebni-brany.md) (4 brány, 2 nezávislá hodnocení). Každá půjčovna má vlastní smlouvu s bránou. Před podpisem písemně ověřit poplatek za preautorizaci, 3DS2/SCA a SAQ A. |
| **Rezervační poplatek** | fixní částka za každé kolo | per typ kola, výchozí návrh 300 Kč kolo / 500 Kč e-kolo, vratný s odstupňovaným stornem (kap. 6) |
| **Kauce** | obě varianty | hotově/terminál na místě i preautorizace karty přes bránu při převzetí (kap. 6) |
| **Banka pro párování** | Fio | adaptér `FioMatcher` první; import výpisu a ruční potvrzení pro ostatní banky |
| **Domény** | subdomény musteru podle názvu stávajícího webu půjčovny, např. Hotel U Tří dubů s webem utridubu.cz → `utridubu.<domena-musteru>` | **`pujcovna.cz` je obsazená** (ověřeno v registru CZ.NIC 5. 10. 2026, držena od 1998, aktivní) → doporučení registrovat **`rezervacekol.cz`** (volná) a zálohy `kolapujcovna.cz`, `rezervujkolo.cz`; wildcard TLS, `__Host-` cookies, limity a e-mail viz kap. 12 a [rešerše 07](docs/vyzkum/07-domeny-a-tls.md). **Konečný výběr názvu domény je na zadavateli.** |
| **Právní kontrola** | zajišťuje zadavatel | my dodáváme návrhy v `legal/` s oponenturou a seznamem bodů k ověření (kap. 8) |

### Zbývá rozhodnout

1. **DPH:** budou půjčovny typicky plátci DPH? Ovlivňuje daňové doklady k přijaté platbě. Stačí export CSV + Pohoda XML?
2. **Jazyky:** jen čeština v MVP, nebo i angličtina a němčina pro příhraniční půjčovny?
3. **Obchodní model musteru:** jednorázová cena za nasazení + měsíční provoz, nebo předplatné? Ovlivňuje, co má umět `/platform` (fakturace, pozastavení).
4. **E-mailový poskytovatel:** EU hosting (Mailgun EU, Brevo) vs. Postmark/Resend – rozhodnout po ověření smluv o zpracování.
5. **Fotografie:** budou mít půjčovny vlastní fotky, nebo potřebujeme licencovanou fotobanku pro demo a výchozí stav?
6. **Pilotní půjčovna:** máme konkrétního prvního klienta (adresa → okolí, typ designu, web → slug subdomény)?

---

## 16. Rizika a jak s nimi

| Riziko | Dopad | Opatření |
|---|---|---|
| `node:sqlite` je „1.2 release candidate“ | změna API | tenká vrstva `db.js` (jako v Cenotvorbě), testy; fallback better-sqlite3 by byl jediná závislost |
| Onboarding u Comgate trvá ≈ 14 dní (schválení karet) | zpoždění fáze 3 nebo pilotu | zahájit ve fázi 0; stage s `test=true` mezitím; převod + QR fungují bez brány; pro pilot lze dočasně Stripe (aktivace okamžitá) |
| Comgate účtuje 1 % z blokované částky preautorizace (neověřeno) | malá půjčovna +2 000 Kč/rok, střední +10 000 Kč → Stripe by byl levnější | vyžádat písemně před podpisem; při potvrzení Stripe jako výchozí brána musteru |
| Změna ceníku Comgate (2025→2026: 0,98 → 1 %, refund 2 → 5 Kč) | zdražení s 2měsíčním předstihem dle VOP | hlídat; přepnout na Stripe, pokud Easy > 1,3 % nebo paušál > 150 Kč/měs.; přepínač brány per půjčovna v nastavení |
| Preautorizace platí 4–7 dní | kauce nelze blokovat při rezervaci | kauce až při převzetí; u delších výpůjček hotově/terminál |
| Právní texty bez advokáta | neúčinné storno, pokuta ÚOOÚ | advokát v fázi 0, texty parametrizované, verzované |
| Změna podmínek Mapy.cz API | mapa bez podkladu | abstrakce vrstvy podkladu; CyclOSM/Thunderforest/PMTiles jako záloha |
| Kvalita OSM dat v okolí konkrétní půjčovny | chybějící trasy, špatné názvy | admin override, možnost přidat vlastní trasu z GPX |
| Doručitelnost e-mailů | zákazník nedostane potvrzení | ověřená doména, SPF/DKIM/DMARC, bounce webhook, potvrzení i na stránce „Správa rezervace“ |
| Malý tým, široký rozsah | nestihnutý pilot | MVP s jedním designem a jednou bránou; ostatní po pilotu |
| Server kompromitován | únik dat více půjčoven | šifrovaná pole s klíčem mimo DB, oddělené DB, minimální práva kontejneru, rychlá rotace klíčů, incident plán |
| Volné alternativy k obsazené `pujcovna.cz` někdo zaregistruje dřív | ztráta zvoleného názvu musteru | registrovat vybranou doménu (`rezervacekol.cz`) hned ve fázi 0, na 3+ roky |
| DNS API klíč pro wildcard certifikát na serveru | útočník s přístupem k serveru mění DNS | token omezený na jednu zónu, nebo delegace `_acme-challenge` do oddělené zóny; DNS-only režim bez proxy |

---

## 17. Co záměrně neděláme

- Neforkujeme AGPL/GPL systémy (Louez, Shelf, QloApps) – jen vzory; vyhýbáme se licenčním závazkům a cizímu kódu.
- Neukládáme karetní data, kopie ani skeny dokladů, nepoužíváme Google Maps/Places ani marketingové skripty ve výchozím stavu.
- Nestavíme SPA ani build pipeline s stovkami devDependencies.
- Nedržíme peníze zákazníků (každá půjčovna má vlastní účet a smlouvu s bránou).
- Neslibujeme „právně schválené“ texty – dodáme podklady a šablony, schválení je na advokátovi.

---

## Rešerše (podklady)

1. [Open-source půjčovny a rezervační systémy](docs/vyzkum/01-open-source-pujcovny.md) – 15 repozitářů, co převzít, 13 poučení.
2. [Platby v ČR](docs/vyzkum/02-platby-cr.md) – SPAYD, Fio a další banky, srovnání bran, PCI DSS, právo a daně záloh, praxe půjčoven, architektura platebního modulu.
3. [Bezpečnost, GDPR, obchodní podmínky](docs/vyzkum/03-bezpecnost-gdpr-podminky.md) – ÚOOÚ k dokladům, retence, OWASP parametry, multi-tenant izolace, praxe 10 půjčoven, checklist 28 bodů, osnovy OP a Zásad.
4. [Mapa cyklostezek a zajímavosti](docs/vyzkum/04-mapa-cyklostezek-a-zajimavosti.md) – knihovny, podklady a ceny, data tras, POI zdroje a licence, znovupoužití Cyklo & Ski mapy.
5. [Stack, theming, tři designy](docs/vyzkum/05-stack-theming-designy.md) – zvyklosti v repozitáři, porovnání backendů/DB/renderování, tokeny, tři koncepty s paletami a fonty, admin, provoz.
6. [Výběr platební brány](docs/vyzkum/06-vyber-platebni-brany.md) – ověřené ceníky a API Comgate, GoPay, ThePay a Stripe, náklady pro malou a střední půjčovnu, hodnocení cena+údržba a bezpečnost+riziko, doporučení první a záložní brány.
7. [Subdomény, hlavní doména a TLS](docs/vyzkum/07-domeny-a-tls.md) – `pujcovna.cz` obsazená, volné alternativy, wildcard DNS-01 vs. on-demand, limity Let's Encrypt, cookies `__Host-`, HSTS, PSL, SEO, e-mail.

Návrhy právních textů k advokátní kontrole: složka [legal/](legal/README.md).
