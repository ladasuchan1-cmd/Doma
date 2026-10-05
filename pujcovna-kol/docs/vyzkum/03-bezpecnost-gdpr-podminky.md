# Podklad: bezpečnost dat, GDPR a obchodní podmínky – šablona webu půjčovny kol

> **Upozornění:** Jde o rešeršní podklad, nikoli právní poradenství. Finální znění obchodních podmínek, zásad ochrany osobních údajů a zpracovatelské smlouvy nechte zkontrolovat advokátem. Tvrzení jsou odkazována na veřejné zdroje (seznam na konci); stav k říjnu 2026. Podklad pro [PLAN.md](../../PLAN.md).

---

## 1. GDPR pro půjčovnu kol

### 1.1 Role
- **Každá půjčovna = samostatný správce** osobních údajů svých zákazníků.
- **Provozovatel šablony / hostingu = zpracovatel** (čl. 28 GDPR). ÚOOÚ ve vyjádření k cloudovým službám výslovně řadí poskytovatele hostingu/cloudu mezi zpracovatele a vyžaduje písemnou smlouvu s náležitostmi čl. 28 (předmět, doba, povaha a účel, kategorie údajů, povinnosti; podmínky pro podzpracovatele; součinnost při právech subjektů a incidentech; výmaz/vrácení dat po skončení). Správce se smlouvou nezbavuje odpovědnosti a má zpracovatele prověřit.
- **Platební brána** (Comgate, GoPay, Stripe…) – karetní data obchodník nikdy nedrží; brána má PCI DSS Level 1 a 3-D Secure. Do zásad uvést jako příjemce.

### 1.2 Jaké údaje a na jakém právním titulu

| Údaj | Účel | Titul (čl. 6) |
|---|---|---|
| Jméno, e-mail, telefon, termín, vybrané kolo | rezervace a smlouva o nájmu | b) plnění smlouvy |
| Fakturační údaje, platby | účetnictví, DPH | c) právní povinnost |
| **Typ a číslo dokladu totožnosti** (bez kopie) | ochrana majetku, vymáhání škody/krádeže | f) oprávněný zájem (s balančním testem) |
| IP adresa, bezpečnostní logy | bezpečnost systému | f) oprávněný zájem |
| E-mail pro newsletter neklientům; analytické/marketingové cookies | marketing | a) souhlas |
| Obchodní sdělení **vlastním zákazníkům** o obdobných službách | marketing | f) + § 7 odst. 3 z. 480/2004 Sb. (opt-out v každé zprávě) |

**Doklady totožnosti – stanovisko ÚOOÚ (květen 2021, „Prokazování totožnosti a zpracování osobních údajů"):** rozlišuje *nahlédnutí*, *zaznamenání nezbytných údajů* a *pořízení kopie*. „Ve většině případů by mělo stačit jejich pouhé předložení a případné zaznamenání (opsání) nezbytných údajů." Kopie je přípustná jen tam, kde to ukládá zákon (AML), nebo se svobodným souhlasem – souhlas „take it or leave it" (kopie jako podmínka služby) podmínku svobodnosti nenaplňuje. **§ 39 zákona č. 269/2021 Sb. o občanských průkazech** zakazuje pořizovat kopii OP bez souhlasu držitele a odebírat OP či přijímat ho jako zástavu; porušení je přestupek (§ 65).
→ **Doporučení pro šablonu:** žádné nahrávání/skenování dokladů; pole „typ dokladu + číslo" šifrované na úrovni aplikace, viditelné jen oprávněné obsluze, automaticky mazané po vrácení kola a vypořádání kauce (např. 30 dní), delší uchování jen při nevyřešené škodě.

### 1.3 Doby uchování (návrh)
- Daňové doklady: **10 let** od konce zdaňovacího období (§ 35 ZDPH; elektronicky dle § 35a – věrohodnost, neporušenost, čitelnost).
- Účetní doklady: 5 let; účetní závěrka 10 let (zákon o účetnictví).
- Smlouva o nájmu + záznam o škodě: po dobu promlčecí lhůty (obecně 3 roky, § 629 OZ); doporučení praxe až 10 let u smluv.
- Nedokončená/nepotvrzená rezervace bez smlouvy: krátce (např. 30–90 dní), pak výmaz.
- Číslo dokladu: viz výše. Bezpečnostní logy: 6–12 měsíců. Souhlas s marketingem: do odvolání.

### 1.4 Informační povinnost (čl. 13) – povinné body
Identita a kontakt správce; účely a právní základ (u oprávněného zájmu jeho popis); příjemci/kategorie příjemců (hosting, platební brána, e-mailová služba, účetní); předávání mimo EU (pozor na US nástroje); doba uchování nebo kritéria; práva (přístup, oprava, výmaz, omezení, přenositelnost, námitka, odvolání souhlasu); právo podat stížnost u ÚOOÚ; zda je poskytnutí údajů smluvním požadavkem a důsledky neposkytnutí. **Metodika ÚOOÚ:** zásady v **samostatném dokumentu**, ne skryté v OP; plnění smlouvy nesmí být podmiňováno souhlasem; nevymáhat souhlas tam, kde platí jiný titul.

### 1.5 Další povinnosti
- **Záznamy o činnostech zpracování (čl. 30):** výjimka pro méně než 250 zaměstnanců platí jen pro „příležitostné" zpracování – u půjčovny se neuplatní, záznamy vést (šablona může generovat předvyplněný záznam).
- **Cookies:** od 1. 1. 2022 **opt-in** (§ 89 odst. 3 ZEK). Bez souhlasu jen technicky nezbytné (session, košík/rezervace, CSRF, nastavení souhlasu). Lišta bez předvyplněných voleb, „setrváním souhlasíte" neplatí, odmítnutí stejně snadné jako přijetí.
- **Pověřenec (DPO):** pro běžnou půjčovnu není povinný.
- **Incident:** ohlásit ÚOOÚ do **72 h** od zjištění (online formulář, datová schránka qkbaa2n), při vysokém riziku informovat i zákazníky (čl. 34; šifrování dat může tuto povinnost vyloučit); **každé** porušení interně zdokumentovat (čl. 33 odst. 5). Smlouva se zpracovatelem musí zavázat hosting hlásit incidenty správci bez zbytečného odkladu (např. do 24 h).
- **Zákaz sdílení** mimo nezbytné zpracovatele – žádné předávání marketingovým sítím bez souhlasu; žádné „sdílené" účty mezi půjčovnami.

---

## 2. Technické zabezpečení

**Reference rámce:** OWASP Top 10:2021 (A01 Broken Access Control, A02 Cryptographic Failures, A03 Injection, A04 Insecure Design, A05 Security Misconfiguration, A06 Vulnerable Components, A07 Identification/Authentication Failures, A08 Software/Data Integrity, A09 Logging/Monitoring, A10 SSRF); verze 2025 přidává *Software Supply Chain Failures* a *Mishandling of Exceptional Conditions*. Cíl pro šablonu: **OWASP ASVS 5.0 úroveň L1 kompletně, L2 pro autentizaci, session, kryptografii a přístupová práva.**

**Konkrétní parametry (dle OWASP Cheat Sheets):**
- **TLS:** 1.3 výchozí, 1.2 povolené, 1.0/1.1 vypnuté; HSTS (`max-age` ≥ 1 rok, `includeSubDomains`); HTTP→HTTPS redirect; Let's Encrypt.
- **Hesla:** Argon2id, OWASP minimum m=19 MiB, t=2, p=1 (nebo 37 MiB/t=1). Bez závislostí: `crypto.scrypt` z `node:crypto` (OWASP: N=2^17, r=8, p=1) – používá už projekt Cenotvorba.
- **Session:** ID ≥ 64 bitů entropie, cookie `__Host-id; Secure; HttpOnly; SameSite=Strict (Lax u veřejné části); Path=/`; regenerace po přihlášení; idle timeout 15–30 min (admin kratší), absolutní 4–8 h; logout invaliduje na serveru.
- **CSRF:** synchronizer token nebo signed double-submit + SameSite + kontrola Origin/`Sec-Fetch-Site`. XSS prevence je předpoklad (CSP bez `unsafe-inline`, výstupní escapování).
- **Hlavičky:** CSP, HSTS, `frame-ancestors`, `Referrer-Policy`, `X-Content-Type-Options` (helmet, nebo ručně – jsou to řádky v odpovědi).
- **Rate limiting:** login, reset hesla, rezervační a platební endpointy.
- **Šifrování v klidu:** disk/DB šifrování + aplikační šifrování citlivých polí (číslo dokladu, telefon, adresa) **AES-256-GCM**, unikátní nonce, klíč oddělený od DB (Docker secret / KMS), rotace klíčů (envelope DEK/KEK). `pgcrypto` lze, ale klíč putuje v SQL a může skončit v logu – OWASP preferuje šifrování v aplikaci. U SQLite: `better-sqlite3-multiple-ciphers` (šifrovaný soubor DB) nebo šifrovaný disk + aplikační šifrování polí.
- **Tajemství:** nikdy v repu ani v `environment:` (čitelné přes `docker inspect`, dědí je child procesy); Docker Compose `secrets:` → `/run/secrets/...`, konvence `*_FILE`; `.env.example` v repu, `.env` v `.gitignore`.
- **Logování bez PII:** logovat auth úspěch/neúspěch, změny práv, admin akce, přístup k citlivým polím, chyby; **nelogovat** hesla, tokeny, session ID, čísla dokladů/karet, celé requesty. Audit log append-only, omezený přístup, retence 6–12 měsíců.
- **Závislosti:** `npm audit --audit-level=high` v CI, lockfile, minimum balíčků, Dependabot/Renovate (i pro Docker image a Actions).
- **2FA pro admin půjčovny:** TOTP (RFC 6238 – lze bez závislostí přes `node:crypto` HMAC) nebo WebAuthn/passkeys; SMS nedoporučeno; záložní kódy; MFA i při změně hesla/e-mailu a vypnutí MFA.
- **Zálohy:** šifrované, mimo produkční server, denní; **pravidelný test obnovy** (čtvrtletně) s doloženým záznamem.
- **Prostředí:** dev/stage/prod oddělené, žádná produkční data ve vývoji (anonymizace).

**Open-source reference (GitHub):**

| Projekt | Licence | Stav |
|---|---|---|
| [OWASP/ASVS](https://github.com/OWASP/ASVS) | CC BY-SA 4.0 | v5.0.0 (5/2025), aktivní, ~3,7k★ |
| [OWASP/CheatSheetSeries](https://github.com/OWASP/CheatSheetSeries) | CC BY-SA 4.0 | aktivní, ~33k★ |
| [helmetjs/helmet](https://github.com/helmetjs/helmet) | MIT | aktivní, ~10,7k★ (vzor hlaviček) |
| [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit) | MIT | aktivní, ~3,3k★ |
| [ranisalt/node-argon2](https://github.com/ranisalt/node-argon2) | MIT | aktivní, Node ≥ 22, ~2,2k★ |
| [m4heshd/better-sqlite3-multiple-ciphers](https://github.com/m4heshd/better-sqlite3-multiple-ciphers) | MIT | v13.0.3, ~240★ |
| PostgreSQL `pgcrypto` / RLS | PostgreSQL licence | součást PostgreSQL |

---

## 3. Multi-tenant izolace

Varianty (Microsoft SaaS tenancy patterns): (A) **instance + DB per půjčovna**, (B) **DB per půjčovna, sdílená aplikace**, (C) **sdílená DB s `tenant_id` + Row-Level Security**.

**Doporučení pro malý tým a nízký počet nezávislých správců:** varianta **B** (případně A pro VIP) – každá půjčovna vlastní DB soubor, vlastní tajemství, vlastní doménu. Důvody: odpovídá právní realitě (každá půjčovna = správce, jednoduchá zpracovatelská smlouva, výmaz dat při ukončení = smazání souboru), per-tenant záloha/obnova, chyba v jednom `WHERE` nevede k úniku mezi půjčovnami, nulová „noisy neighbour" rizika. Cena: migrace se spouští N-krát (automatizovat), monitoring per tenant.

Pokud by se volila **C (sdílená DB)**, pak povinně: `tenant_id` v každé tabulce a v `UNIQUE (tenant_id, …)`; `ENABLE` + **`FORCE ROW LEVEL SECURITY`**; policy `USING`/`WITH CHECK (tenant_id = current_setting('app.tenant')::int)`; kontext nastavovat **`SET LOCAL` v transakci**; aplikační role **bez `BYPASSRLS`**; samostatná role pro migrace; automatické testy na cross-tenant přístup.

---

## 4. Obchodní podmínky – praxe českých půjčoven

| Půjčovna | Doklady | Kauce | Rezervace / storno | Sankce |
|---|---|---|---|---|
| Kolomat servis s.r.o., Šumperk | 2 doklady s fotkou, jeden OP/pas | min. 5 000 Kč | dle reenio | nájemce hradí opravy, při krádeži plnou cenu; čištění 250 Kč; krádež ihned PČR; zákaz závodů, komerčního užití, půjčení třetí osobě |
| TestujBike (Hotel Duo a.s.), Horní Bečva | 2 doklady | 5 000 Kč/kolo, hotově nebo **předautorizace karty** | – | 18+; pozdní vrácení = půjčovné dle sazby; dřívější vrácení bez refundace; zákaz alkoholu, úprav, předání jiné osobě |
| Sport Brzák s.r.o., Liberec | 2 doklady | 5 000 Kč kola / 10 000 Kč e-kola | – | čištění 300 Kč; „předání třetí osobě zakázáno" |
| CYKLOSVEC s.r.o., Písek/Vlašim | **kopie OP/pasu** (z pohledu ÚOOÚ problematické) | 500 / 2 000 Kč hotově | záloha 200 Kč, storno < 3 dny = propadá | mytí 200–500 Kč; 18+ |
| KTM-ebikes.cz | 2 doklady | 5 000 / 10 000 Kč | platba předem; storno 7 dní 100 %, 3 dny −25 %, 2 dny −50 %, 1 den −75 % | silné znečištění = 1 den půjčovného |
| BIKE-SKI-SPORT | 2 doklady (OP + s fotkou) | 10 000 / 20 000 Kč hotově | rezervační poplatek 1 000 Kč; storno 350 Kč (> 3 dny) / 1 000 Kč (< 3 dny) | čištění 300 Kč |
| Půjčovna kol Praha 5; SBCR Radotín (Anyrent) | 1 doklad | 500 Kč / 3 000 Kč e-kolo, hotově | – | čištění 100 Kč; 1 den = 24 h |
| Kola na kouli (nosiče) | – | 5 000 Kč | záloha 100 %; storno ≥ 15 dní 100 %, 8–14 dní 50 %, méně propadá | – |

**Standardní obsah:** 18+ a svéprávnost; 1–2 doklady (zapsání, ne kopie); vratná kauce 500–20 000 Kč podle hodnoty kola (hotově, převodem, nebo předautorizace karty – online varianta vhodná pro šablonu); rezervační záloha nebo 100 % platba předem; odstupňované storno; plná odpovědnost nájemce za škodu i krádež (často bez pojištění), krádež hlásit policii; povinnost zamykat dodaným zámkem; přilba doporučena / u dětí povinná ze zákona (§ 58 z. 361/2000 Sb. do 18 let); vrátit čisté, včas, nabité (e-kola); sankce za pozdní vrácení (další den půjčovného nebo dvojnásobek); zákaz předání třetí osobě, závodů, alkoholu, úprav; ohlášení závad.

**Co musí mít web ze zákona:**
- Předsmluvní informace (§ 1811, § 1820 OZ): identifikace podnikatele (název, IČO, sídlo, kontakt), hlavní vlastnosti služby, **celková cena včetně DPH** a dalších poplatků (kauce, storno), způsob platby a plnění, práva z vadného plnění, reklamace, trvání smlouvy.
- **Odstoupení:** obecně 14 dní u distančních smluv (§ 1829), ale **§ 1837 písm. j)** vylučuje odstoupení u smluv „o … nájmu dopravního prostředku … nebo využití volného času, pokud má být podle smlouvy plněno k určitému datu nebo v určitém období" → rezervace kola na termín bez práva na odstoupení; OP to musí výslovně uvést a nahradit **storno podmínkami**.
- **Mimosoudní řešení sporů (ADR):** § 14 zákona o ochraně spotřebitele – informovat o ČOI včetně URL (https://www.coi.gov.cz/informace-o-adr/) na webu i v OP; návrh lze podat do 1 roku od uplatnění nároku.
- **Zásady ochrany osobních údajů** jako samostatný dokument; cookie lišta opt-in.

---

## 5. Open-source šablony v češtině
Dedikovaný udržovaný GitHub repozitář s českými zásadami/OP **nebyl nalezen** – jen weby jednotlivých firem s `gdpr.html` v repu (bez licence). Použitelné výchozí body: [laymonage/gdpr-privacy-policy](https://github.com/laymonage/gdpr-privacy-policy) (EN, Unlicense, převod gdpr.eu vzoru do Markdownu); [Dimitri777/gdpr-privacy-compliance](https://github.com/Dimitri777/gdpr-privacy-compliance) (EN, RoPA/DPIA/DPA/breach šablony – jen inspirace). České ne-GitHub vzory: Fakturoid (vzor zásad + zpracovatelské smlouvy), metodika ÚOOÚ. **Doporučení:** napsat vlastní české texty podle osnov níže a nechat zkontrolovat advokátem; do šablony vložit jako parametrizované dokumenty (název, IČO, sídlo, kontakty, seznam zpracovatelů).

---

## Bezpečnostní minimum – checklist

**Infrastruktura a data**
1. TLS 1.2+/1.3, HSTS, redirect HTTP→HTTPS, test na SSL Labs.
2. Samostatná DB per půjčovna; žádná sdílená přihlašovací data.
3. Šifrování disku/DB + AES-256-GCM pro číslo dokladu a další citlivá pole.
4. Klíče a tajemství v Docker secrets / souboru s právy 600, nikdy v repu ani `environment:`; `.env` v `.gitignore`.
5. Šifrované zálohy mimo server, denní, retence ≤ 30 dní; **test obnovy** 4× ročně.
6. Oddělené prostředí dev/stage/prod; anonymizovaná testovací data.
7. Minimální práva procesu (kontejner `USER node`, read-only FS kde lze).
8. Firewall: jen 22/80/443; SSH jen klíčem; automatické bezpečnostní aktualizace OS.

**Aplikace**
9. scrypt/Argon2id hesla, žádné limity délky hesla < 64 znaků, kontrola proti uniklým heslům (k-anonymita HIBP, volitelně).
10. 2FA (TOTP/WebAuthn) povinné pro admin účty půjčovny i provozovatele; záložní kódy.
11. Session: ≥ 64 bit entropie, `Secure; HttpOnly; SameSite`, regenerace po loginu, idle 15–30 min, absolutní 8 h.
12. CSRF tokeny na všech state-changing požadavcích + kontrola Origin.
13. CSP bez `unsafe-inline`, ostatní bezpečnostní hlavičky.
14. Validace vstupů na serveru, parametrizované dotazy.
15. Autorizace na každém endpointu (tenant + role check) – A01 Broken Access Control.
16. Rate limiting (login, reset, rezervace, platba) + zamykání účtu po N pokusech.
17. Platby výhradně přes PCI DSS bránu (redirect/iframe), ověřování webhooků podpisem/stavem; karetní data nikdy na serveru.
18. `npm audit` v CI s blokováním buildu, lockfile, Dependabot; minimum závislostí.
19. Žádné PII, hesla, tokeny v lozích; audit log admin akcí a přístupů k citlivým polím; retence 6–12 měsíců.
20. Chybové stránky bez stack trace; `X-Powered-By`/`Server` vypnuto.
21. Upload souborů jen fotky kol v adminu – typ, velikost, mimo webroot; **žádné skeny dokladů**.

**Organizace a GDPR**
22. Zpracovatelská smlouva (čl. 28) provozovatel ↔ každá půjčovna; seznam podzpracovatelů (hosting, e-mail, brána).
23. Záznamy o činnostech zpracování (čl. 30) – šablona generuje per půjčovna.
24. Automatické mazání dle retenčních lhůt (nedokončené rezervace, čísla dokladů, logy); export/výmaz na žádost do 30 dnů.
25. Cookie lišta opt-in; bez marketingových skriptů před souhlasem (ideálně žádné).
26. Incident response plán: kontakty, 72 h ohlášení ÚOOÚ, interní evidence, komunikace zákazníkům.
27. Přístupy: individuální účty pro obsluhu, odebrání při odchodu, přehled přihlášení.
28. Roční revize: automatizovaný test (OWASP ZAP), kontrola ASVS L1 checklistu, aktualizace dokumentů.

---

## Osnova obchodních podmínek (půjčovna kol s online rezervací)
1. **Identifikace provozovatele** – název, IČO, DIČ, sídlo/provozovna, kontakt, otevírací doba.
2. **Definice a předmět** – smlouva o nájmu věci movité (kolo, e-kolo, příslušenství), vztah OP a rezervačního systému.
3. **Rezervace a uzavření smlouvy** – postup, potvrzení e-mailem, kdy je smlouva uzavřena, závaznost ceny (včetně DPH).
4. **Cena, platba, rezervační poplatek** – ceník, rezervační poplatek za kolo a jeho započtení na cenu, doplatek, platební brána / převod / QR, daňový doklad.
5. **Kauce** – výše podle typu kola, forma (hotově/předautorizace), vrácení, započtení škody.
6. **Storno a změny rezervace** – odstupňované lhůty a procenta, nevyužití rezervace, změna termínu, zrušení ze strany půjčovny (počasí, porucha) a vrácení plateb.
7. **Odstoupení od smlouvy** – poučení o § 1837 písm. j) (bez 14denní lhůty), odkaz na storno.
8. **Převzetí** – věk 18+, předložení dokladu (zapsání typu a čísla, bez kopie), kontrola stavu, předávací protokol, zaškolení k e-kolu.
9. **Užívání** – řádné užívání, zákaz předání třetí osobě, závodů, alkoholu, úprav; povinnost uzamčení dodaným zámkem; přilba (děti povinně); dodržování pravidel silničního provozu.
10. **Odpovědnost za škodu, ztrátu, krádež** – plná odpovědnost nájemce, postup při krádeži (PČR, oznámení), ceník oprav, opotřebení vs. poškození, pojištění (pokud je).
11. **Vrácení** – místo, čas, stav (čisté, nabité), sankce za pozdní vrácení a znečištění, dřívější vrácení.
12. **Závady a reklamace** – hlášení závad, výměna kola, reklamace služby (§ 1914 a násl. OZ), lhůta 30 dní.
13. **Mimosoudní řešení sporů** – ČOI, URL, EU platforma ODR (pokud relevantní).
14. **Ochrana osobních údajů** – jen odkaz na samostatné Zásady.
15. **Závěrečná ustanovení** – rozhodné právo, změny OP, účinnost, verze.

## Osnova Zásad ochrany osobních údajů
1. **Správce** – půjčovna (název, IČO, kontakt); poznámka, že web provozuje zpracovatel.
2. **Jaké údaje zpracováváme** – rezervační, smluvní, platební (bez karetních dat), údaje z dokladu (typ, číslo), komunikace, technické/logy, cookies.
3. **Účely a právní základy** – tabulka účel → titul (smlouva, zákon, oprávněný zájem s popisem, souhlas).
4. **Doby uchování** – konkrétní lhůty per kategorie (viz 1.3).
5. **Příjemci a zpracovatelé** – hosting/provozovatel šablony, platební brána, e-mailová služba, účetní, případně pojišťovna/policie při škodě; prohlášení o nesdílení s jinými třetími stranami.
6. **Předávání mimo EU** – zda ano, na jakém základě (SCC/DPF).
7. **Cookies** – kategorie, nezbytné vs. se souhlasem, správa souhlasu.
8. **Obchodní sdělení** – vlastním zákazníkům s možností odhlášení; newsletter jen se souhlasem.
9. **Práva subjektů** – výčet, způsob uplatnění, lhůta 30 dní, právo na stížnost u ÚOOÚ (uoou.gov.cz).
10. **Zabezpečení** – stručně (šifrování, přístupová práva, zálohy, incidenty).
11. **Automatizované rozhodování** – nepoužívá se.
12. **Změny zásad** – datum účinnosti, verze.

---

## Zdroje
- ÚOOÚ – stanovisko Prokazování totožnosti a zpracování osobních údajů (5/2021): https://uoou.gov.cz/media/tiskove-zpravy/dokumenty/prokazovani-totoznosti-a-zpracovani-osobnich-udaju.pdf ; shrnutí: https://www.qcom.cz/2021/05/20/legitimace/
- Zákon č. 269/2021 Sb. o občanských průkazech (§ 39, § 65): https://www.zakonyprolidi.cz/cs/2021-269
- ÚOOÚ – cookies od 2022 jen se souhlasem: https://uoou.gov.cz/novinky/nezarazene/cookies-od-zacatku-roku-2022-pouze-se-souhlasem
- ÚOOÚ – metodika k informační povinnosti: https://uoou.gov.cz/profesional/metodiky-a-doporuceni-pro-spravce/metodika-k-plneni-informacni-povinnosti-a-k-souvisejicim-ujednanim-vuci-zakaznikum
- ÚOOÚ – Základní příručka: https://uoou.gov.cz/verejnost/zakladni-prirucka-k-ochrane-udaju
- ÚOOÚ – porušení zabezpečení (72 h): https://uoou.gov.cz/profesional/poruseni-zabezpeceni-osobnich-udaju ; formulář: https://uoou.gov.cz/ohlaseni-poruseni-zabezpeceni-osobnich-udaju-dle-gdpr
- ÚOOÚ – vyjádření k cloudovým službám (zpracovatel, čl. 28): http://www.dia.gov.cz/media/2244/download/Vyjadreni_UOOU_k_vyuzivani_cloudovych_sluzeb_z_pohleduOOU_a_povinnostem_spravce_a_zpracovatele.pdf?v=1
- ÚOOÚ – FAQ k zákonu 480/2004 Sb.: https://uoou.gov.cz/cinnost/obchodni-sdeleni/casto-kladene-otazky-k-zakonu-c-4802004-sb
- Náležitosti zpracovatelské smlouvy: https://www.epravo.cz/top/clanky/nalezitosti-zpracovatelske-smlouvy-108130.html
- Uchovávání daňových dokladů: https://portal.pohoda.cz/dane-ucetnictvi-mzdy/dph/danovy-doklad/uchovavani-danovych-dokladu/ ; https://www.fakturoid.cz/almanach/legislativa/jak-archivovat-dokumenty
- OZ § 1811, 1820, 1829, 1837: https://www.mesec.cz/zakony/obcansky-zakonik-2014/f4584711/ ; ČOI: https://coi.gov.cz/faq/6-o-cem-me-musi-prodavajici-informovat/ ; https://www.coi.gov.cz/informace-o-adr/
- OWASP Top 10: https://top10.owasp.org/2021/ , https://top10.owasp.org/2025/ ; ASVS: https://github.com/OWASP/ASVS ; Cheat Sheets: https://github.com/OWASP/CheatSheetSeries (Password Storage, Session Management, CSRF, Logging, Cryptographic Storage, MFA, TLS)
- Knihovny: https://github.com/helmetjs/helmet , https://github.com/express-rate-limit/express-rate-limit , https://github.com/ranisalt/node-argon2 , https://github.com/m4heshd/better-sqlite3-multiple-ciphers
- PostgreSQL RLS: https://www.postgresql.org/docs/current/ddl-rowsecurity.html ; tenancy patterns: https://learn.microsoft.com/en-us/azure/azure-sql/database/saas-tenancy-app-design-patterns
- Docker Compose secrets: https://docs.docker.com/compose/how-tos/use-secrets/ ; npm audit: https://docs.npmjs.com/cli/v10/commands/npm-audit
- Půjčovny: https://www.kolomat.cz/vypujcni-rad-pujcovny-elektrokol/ , https://www.testujbike.cz/obchodni-podminky/ , https://www.brzak.cz/pujcovna-kol-6.html , https://www.cyklosvec.cz/pujcovna , https://www.ktm-ebikes.cz/pujcovna-elektrokol/ , https://www.bike-ski-sport.cz/pujcovna-elektrokol-2/ , https://www.pujcovna-kol-praha.cz/pujcovna-kol.htm , https://sbcr.anyrent.cz/static/faq-pujceni-kola , https://kolanakouli.cz/wp-content/uploads/2021/05/obchodni-podminky-pujcovna-nosicu-na-kola.pdf
- Šablony: https://github.com/laymonage/gdpr-privacy-policy , https://github.com/Dimitri777/gdpr-privacy-compliance , https://www.fakturoid.cz/almanach/legislativa/gdpr
