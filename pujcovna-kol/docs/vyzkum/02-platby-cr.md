# Podklad: platební modul webu půjčovny kol (ČR, šablona pro více půjčoven)

Stav k 5. 10. 2026. Legenda: **[D]** ověřeno z oficiální dokumentace/webu provozovatele · **[K]** komunitní/sekundární zdroj (recenze, README) · **[O]** odhad/doporučení. Podklad pro [PLAN.md](../../PLAN.md). Není to právní ani daňové poradenství.

---

## 1. QR platba (SPAYD, standard ČBA)

**Formát [D]** (qr-platba.cz/specifikace): řetězec `SPD*1.0*KLÍČ:HODNOTA*…`. Hodnoty se oddělují `*`; hvězdička v hodnotě se URL-enkóduje (`%2A`). Doporučená znaková sada pro malý QR: `0–9 A–Z mezera $ % * + - . / :`. Pro tisk ECC úroveň **M**.

| Klíč | Povinný | Max | Význam |
|---|---|---|---|
| `ACC` | ano | 46 | IBAN, volitelně `+BIC` |
| `ALT-ACC` | ne | 93 | alternativní účty |
| `AM` | ne | 10 | částka, tečka, max 2 des. |
| `CC` | ne | 3 | ISO 4217 (`CZK`) |
| `DT` | ne | 8 | datum splatnosti `YYYYMMDD` |
| `MSG` | ne | 60 | zpráva pro příjemce |
| `RN` | ne | 35 | jméno příjemce |
| `PT` | ne | 3 | `IP` = okamžitá platba |
| `X-VS` / `X-SS` / `X-KS` | ne | 10 | variabilní/specifický/konstantní symbol |
| `X-URL`, `X-ID`, `X-PER`, `NT`, `NTA`, `CRC32` | ne | – | URL, ID platby, dny opakování, notifikace, kontrolní součet |

Příklad: `SPD*1.0*ACC:CZ9106000000000000000123*AM:450.00*CC:CZK*X-VS:2610000123*MSG:REZERVACE 123`. QR platbu čtou aplikace všech velkých bank (ČS, ČSOB, KB, RB, Fio, Air Bank, Moneta, mBank) **[D]**.

**Knihovny (stav k 10/2026):**

| Knihovna | Jazyk | Licence | Co dělá | Pozn. |
|---|---|---|---|---|
| `spayd` (Tajnymag/spayd-js) | JS/TS | MIT, v3.0.4 **[D]** | jen řetězec SPAYD; závislosti `ibantools`, `date-fns` | 17 ★, UMD/ESM/CJS |
| `@spayd/core` (asonnleitner/spayd) | TS | (viz repo) | řetězec + validace IBAN/ISO 4217 | malý repo |
| `qrplatba` (tedyno/qrplatba) | TS | MIT **[D]** | **převod CZ čísla účtu na IBAN**, výstup SVG / data-URL / payload; 1 závislost (`qrcode-generator`); Node i browser | nejpraktičtější pro náš případ |
| `qrcode` (soldair/node-qrcode) | JS | MIT **[D]** | renderer QR: Node (PNG/SVG/`toDataURL`), browser (`toCanvas`); `errorCorrectionLevel` | 8,2 k ★, aktivní |
| dfridrich/QRPlatba | PHP | MIT **[K]** | QR platba + QR faktura | |
| ViktorStiskala/python-qrplatba | Python | MIT **[K]** | SVG/PNG | |

Poznámka k vašemu stylu „bez závislostí“: SPAYD řetězec i převod čísla účtu na IBAN (mod 97) jsou pár desítek řádků a lze je napsat vlastní; QR renderer je naopak lepší vendorovat (`qrcode-generator` MIT je jeden soubor bez závislostí).

**Server vs. prohlížeč [O]:** payload (částka, VS, účet) sestavovat **výhradně na serveru** (zdroj pravdy = DB rezervace), QR renderovat na serveru jako SVG a vložit inline. Nikdy nepřijímat částku z klienta.

---

## 2. Bankovní převod a automatické párování

**Fio banka – API bankovnictví [D + K]:** zdarma, token se vytváří v internetbankingu (*Nastavení → API*), dvě úrovně oprávnění („sledování účtu" = read‑only, nebo i zadávání příkazů), token platí **max. 180 dní** (nutná rotace), limit **1 dotaz / token / 30 s**, jinak HTTP 409. Endpointy: `GET https://fioapi.fio.cz/v1/rest/periods/{token}/{od}/{do}/transactions.json`, `…/last/{token}/transactions.json` (nové od poslední zarážky), `set-last-id`, `set-last-date`. Transakce obsahují částku, měnu, protiúčet + kód banky, VS/KS/SS, zprávu pro příjemce, typ, **unikátní ID pohybu**. Klienti: honzajavorek/fiobank (Python), h4kuna/fio (PHP), jbub/fio (Go), komunitní npm `fio-bank-client`.

**Ostatní banky (firemní API, ne PSD2):**

| Banka | Služba | Cena | Autorizace | Open‑source klient |
|---|---|---|---|---|
| KB | Account Direct Access (ADAA) **[D]** | 50 stažení/měs. zdarma, pak 100–500 Kč/měs. | aktivace v MojeBanka, obnova každých 12 měs. | komercka/adaa-client (Java) |
| Česká spořitelna | Premium API **[K]** | 300 Kč/účet/měs. | George Business | – |
| ČSOB | Business Connector (CEB) **[D/K]** | zdarma | klientský certifikát | AsisTeam/csob-bc (PHP) |
| Raiffeisenbank | Premium API **[K]** | 99–500 Kč/měs. (**rozpor zdrojů, ověřit**) | certifikát | – |
| Moneta, Creditas | token API **[K]** | zdarma | token | – |
| Air Bank | pouze PSD2 AIS pro licencované TPP **[D]** | – | – | nepraktické |

PSD2 AIS API všech bank vyžaduje licenci TPP (ČNB) – pro půjčovnu nepoužitelné. **Doporučení [O]:** šablona ať podporuje adaptér „Fio" jako první (zdarma, nejjednodušší) a volitelně KB ADAA / ČSOB BC; jiné půjčovny párují ručně (import CSV/GPC výpisu) nebo potvrzením v adminu.

**Párování [O]:**
- **VS = unikátní číslo rezervace** (max 10 číslic, např. `RRMM` + 6‑místná sekvence), nikdy neopakovat. Do `MSG` čitelný popis; VS je primární klíč, MSG fallback (regex), poslední fallback částka + protiúčet.
- Poller běží každých 60–120 s (`/last/`), každé ID pohybu uložit do `bank_transactions` (unique) → idempotence.
- **Přeplatek:** spárovat, rozdíl evidovat jako kredit, nabídnout vratku/započtení. **Nedoplatek:** stav `partially_paid`, e‑mail s QR na zbytek; tolerance např. ±5 Kč se odpouští.
- **Nepřiřazené platby** → fronta pro ruční párování v adminu.
- **Expirace:** převod drží rezervaci jen omezeně (např. 48–72 h, u rezervace na zítra max. do 20:00) – cron po uplynutí přepne `expired`, uvolní kola; platba došlá po expiraci → `unmatched`, vratka nebo obnovení rezervace, pokud je kapacita.

---

## 3. Karetní brány pro ČR

| Brána | Integrace | Cena (orientačně) | Apple/Google Pay | Preautorizace / část. capture | Refund / webhook / sandbox | Node.js SDK |
|---|---|---|---|---|---|---|
| **Comgate** [D] | redirect; **Checkout SDK** (embedded karty+wallety); Basic auth merchant+secret | Start: 6 měs. zdarma (do 50 k Kč), pak **1 % + 0 Kč**; Easy 0,6 % + 0 Kč (akce), vedení 100 Kč/měs. při obratu < 100 k; Profi 0,47 % + 1 Kč; bank. tlačítka 1 % | ano | `preauth=true`, `capturePreauth` na plnou/nižší částku, `cancelPreauth`; blokace **min. 7 dní** | částečný refund; push notifikace → **ověřit dotazem na status**, IP whitelist; test mode | oficiální PHP comgate-payments/sdk-php; Node jen komunitní xGearForce/comgate-node (MIT, 0 ★) [K] |
| **GoPay** [D] | redirect `gw_url` nebo inline `embed.js`; OAuth2 (token 30 min) | Start: 12 měs. zdarma (do 50 k), pak **0,95 % + 0 Kč**; vedení 80 Kč/měs. při obratu < 50 k; (nový sazebník od 1. 11. 2026 – ověřit) | ano | `preauthorization=true`, blokace **4 dny**, capture plný/částečný, void | částečný refund; notifikace GET na `notification_url` → ověřit `GET /payments/payment/{id}`; sandbox `gw.sandbox.gopay.com` | **oficiální** `@gopaycz/gopay-js-sdk`, MIT, TS, API v4.0 |
| **ThePay** [D] | redirect (Gate API) + Data API; IP whitelist | **0,99 % + 0 Kč + 139 Kč/měs.** do 250 k; 0,89 % do 1 M | ano | blokace **max. 7 dní**, realizace na plnou/nižší částku | refund; notifikace; demo prostředí | oficiální jen PHP; Node žádný |
| **GP webpay** [K] | HTTP redirect s RSA podpisem + WS API; sjednává se přes banku | **individuálně dle banky** | ano | preautorizace + `processCapture` | refund; test | komunitní, zastaralé |
| **Stripe** [D] | Checkout (hosted) nebo Elements (iframe); v ČR od 2020 | **1,5 % + 6,50 Kč** EEA karty, 2,8 % premium, +2 % FX, 0 Kč měsíčně | ano | `capture_method=manual`, platnost **7 dní**, částečný capture | refund; webhook HMAC‑SHA256 (`Stripe-Signature`, tolerance 5 min); test mode + CLI | oficiální `stripe` (npm) |
| **Adyen** [D] | API/Drop‑in | Interchange++ + 0,60 % + $0,13; **minimální měsíční faktura** | ano | ano | ano | oficiální |
| **PayU** [K] | redirect/REST | **1,45 % + 1 Kč**, aktivace 200 Kč | ano | neověřeno | ano | – |

**Hodnocení [O]:** pro malé půjčovny jsou nejvhodnější **Comgate** (nejlevnější karty, dokumentovaná preautorizace, české bankovní tlačítka) a **GoPay** (jediná CZ brána s oficiálním Node SDK). Stripe je dražší na malých částkách (fix 6,50 Kč) a nemá české bankovní tlačítka, ale má nejlepší vývojářský model – vhodný jako referenční adaptér. Adyen nedává smysl. Preautorizace jsou u všech bran **omezeny na karty**, blokace typicky **4–7 dní** → kauci blokovat nejdříve při převzetí, nikoli při rezervaci týdny dopředu.

---

## 4. Bezpečnost platebních dat

- **PCI DSS SAQ A vs. A‑EP [D/K]:** SAQ A (~22 kontrol) platí jen tehdy, když **všechny prvky platební stránky pochází od PCI‑DSS‑compliant poskytovatele** – plný redirect nebo iframe z domény brány – a obchodník potvrdí, že jeho web není zranitelný vůči skriptovým útokům (revize 1/2025). Jakmile na stránce s kartou běží vlastní JS a formulář generuje váš server, spadáte do **SAQ A‑EP (~191 kontrol, ASV skeny, pentest)**. Proto: **nikdy nepřijímat ani neprocházet PAN/CVC přes vlastní server**, používat redirect nebo iframe brány; na checkoutu minimalizovat cizí skripty, nasadit CSP.
- **3‑D Secure 2 / SCA (PSD2 RTS) [K]:** SCA zajišťuje brána; pro náš flow: rezervační poplatek = CIT s 3DS; dokapturování kauce = capture z preautorizace, bez nového SCA.
- **Webhooky:** u Stripe ověřit HMAC podpis z raw body + timestamp, konstantní porovnání; u Comgate/GoPay/ThePay je notifikace **jen trigger** – stav vždy znovu načíst API dotazem a kontrolovat IP whitelist. Vracet 2xx rychle, zpracování do fronty, události nejsou řazené.
- **Idempotence:** tabulka `webhook_events(provider, event_id UNIQUE)`; odchozí volání s `Idempotency-Key`; přechody stavového automatu idempotentní (opakovaný `paid` = no‑op).
- **Co ukládat:** jen `provider`, `provider_payment_id`, stav, částky, měnu, případně brand + last4 (mimo rozsah PCI). Žádný PAN, CVC, 3DS data. Secrets bran šifrovat per půjčovna, rotovat Fio token před 180. dnem.

---

## 5. Rezervační poplatek vs. kauce – právní a praktický rámec

**Právo [K]:** záloha (§ 1807 OZ) se při nesplnění vrací a při splnění započítává na cenu; závdavek (§ 1808–1809) může propadnout. Storno poplatek je buď **smluvní pokuta (§ 2048)** nebo **odstupné (§ 1992)** – musí být přiměřený a transparentně v obchodních podmínkách, jinak hrozí neúčinnost vůči spotřebiteli (§ 1813). Důležité: **§ 1837 písm. j)** – u služeb využití volného času / nájmu dopravního prostředku plněných v určitém termínu spotřebitel **nemá 14‑denní právo odstoupit**, takže storno podmínky lze uplatnit od rezervace. **Doporučení [O]:** v šabloně nechat půjčovnu zvolit model „vratný rezervační poplatek (záloha), propadá při stornu < X h" a sazby storna řešit odstupňovaně.

**Daně a doklady [K]:** plátce DPH musí ze zálohy přiznat daň **ke dni přijetí** a vystavit **daňový doklad k přijaté platbě do 15 dnů**; konečný doklad má základ snížený o zálohu. Propadlý storno poplatek / smluvní pokuta **není předmětem DPH** → k původně zdaněné záloze opravný daňový doklad. **Kauce** (vratná jistota) **není úplatou za plnění**, DPH se neodvádí, daňový doklad se nevystavuje. **EET** zrušena od 1. 1. 2023; návrh „EET 2.0" (pilot 1/2027) je v připomínkovém řízení, měl by se týkat prezenčních plateb – sledovat.

**Reálné půjčovny [D – jejich weby]:**

| Půjčovna | Rezervační poplatek / záloha | Storno | Kauce |
|---|---|---|---|
| ekolo.cz | 350 Kč vč. DPH, vratný | propadá < 48 h | 10 000 / 20 000 Kč **preautorizací na kartě** nebo hotově |
| ČD Bike | 100 Kč kolo / 200 Kč elektrokolo, vratný po vrácení kola | 100 % < 24 h | 1 000 / 2 500 Kč při převzetí |
| Harfa Sport | bez poplatku – **celé půjčovné online při rezervaci (GP webpay)** | > 7 dní 50 Kč; 7–3 dny 10 %; 3–0 dny 25 %; po termínu 100 % | terminál/hotovost; 0 Kč pro ověřené přes BankID |
| elektrokola-sumava.cz | **50 % půjčovného**, odečte se při převzetí | > 3 dny zdarma; 2 dny 50 %; < 2 dny 100 % | 1 000 / 2 000 Kč hotově |
| pujcovna-elektrokol.com | rezervační poplatek **nevratný**, převod den předem | neuvedeno | 3 000 Kč hotově |

Vzor trhu: malý fixní vratný poplatek nebo 30–50 % záloha online + kauce až při převzetí (ideálně preautorizace karty).

---

## 6. Doporučená architektura platebního modulu [O]

**Abstrakce**

```ts
interface PaymentProvider {
  kind: 'card' | 'bank_transfer';
  createPayment(req: {paymentId, amountMinor, currency:'CZK', purpose:'reservation_fee'|'balance'|'deposit_hold', capture:'auto'|'manual', returnUrl, metadata}): Promise<{redirectUrl?: string; spayd?: string; qrSvg?: string; providerRef: string}>;
  getStatus(providerRef): Promise<ProviderStatus>;
  capture?(providerRef, amountMinor): Promise<void>;   // jen karty
  cancelHold?(providerRef): Promise<void>;
  refund(providerRef, amountMinor, reason): Promise<{refundRef}>;
  verifyWebhook(rawBody, headers, ip): Promise<ProviderEvent[]>; // u CZ bran: načíst status API
}
```
Adaptéry: `ComgateProvider`, `GoPayProvider`, `StripeProvider` (karta), `BankTransferProvider` (SPAYD + `FioMatcher`/`ManualImportMatcher`). Konfigurace **per tenant** (půjčovna): zvolená brána, šifrované klíče, číslo účtu/IBAN, pravidla storna a výše poplatku.

**Datový model** (bez karetních dat): `reservations(id, tenant_id, status, total_price, reservation_fee_total, vs UNIQUE, expires_at)`, `reservation_items(bike_type_id, bike_id, fee_minor)` – poplatek za **každé kolo**, `payments(id, reservation_id, provider, provider_ref, purpose, amount_minor, captured_minor, status, idempotency_key, created_at)`, `bank_transactions(provider, tx_id UNIQUE, amount, vs, msg, counter_account, matched_payment_id)`, `webhook_events(provider, event_id UNIQUE, payload, processed_at)`, `ledger_entries(reservation_id, type: fee_paid|balance_paid|deposit_held|deposit_captured|refund|storno_fee, amount_minor)`, `documents(type: payment_receipt|advance_tax_doc|final_invoice|credit_note, …)`.

**Stavový automat**

- Rezervace: `draft → awaiting_fee → confirmed(fee paid) → checked_out → returned → closed`; odbočky `expired` (poplatek nezaplacen do T), `cancelled_by_customer` (→ vratka/propadnutí dle storna), `cancelled_by_operator` (→ plná vratka).
- Platba: `created → pending → (authorized → captured | partially_captured | released) | paid | failed | expired → refunded | partially_refunded`.
- Přechody jen přes doménovou službu, idempotentní, logované (audit).

**Zúčtování rezervačního poplatku:** poplatek = součet `fee` za kola; při finální platbě `balance = total_price − Σ fee_paid` (± kredit z přeplatku). Doplatek lze zaplatit online (karta/QR před vyzvednutím) nebo na místě (terminál – evidovat jako externí platbu). **Kauce**: samostatná platba `deposit_hold` s `capture:'manual'`, zakládá se **při převzetí** (platnost blokace 4–7 dní!), při vrácení `cancelHold` nebo částečný `capture` na škodu; u delších výpůjček raději kauce na terminálu/hotově. Pro bankovní převod kauci nepoužívat.

**Vratky a storno:** engine storna z pravidel tenanta spočítá `storno_fee`; vratka = `fee_paid − storno_fee` přes `refund()` původní metodou (karta → refund brány, převod → odchozí platba na protiúčet z `bank_transactions`, manuální fronta); opravný daňový doklad, pokud byl poplatek zdaněn. Vše jako ledger záznamy, aby součet vždy souhlasil.

**Provozní detaily:** cron expirací (každou minutu), Fio poller (≥ 30 s interval, zarážka `set-last-id`), fronta zpracování webhooků, e‑maily s doklady (PDF + QR na doplatek), sandbox pro každou bránu v testovacím tenantovi, rotace Fio tokenu (upozornění 14 dní před 180. dnem).

---

## Zdroje

- SPAYD: https://qr-platba.cz/pro-vyvojare/specifikace-formatu/ · https://en.wikipedia.org/wiki/Short_Payment_Descriptor
- Knihovny QR: https://github.com/Tajnymag/spayd-js · https://github.com/asonnleitner/spayd · https://github.com/tedyno/qrplatba · https://github.com/soldair/node-qrcode · https://github.com/dfridrich/QRPlatba · https://github.com/ViktorStiskala/python-qrplatba
- Fio: https://www.fio.cz/bankovni-sluzby/api-bankovnictvi · https://www.fio.cz/docs/cz/API_Bankovnictvi.pdf · https://github.com/honzajavorek/fiobank · https://github.com/h4kuna/fio · https://github.com/dg/fio-mcp
- Banky: https://www.kb.cz/en/kbapi/kb-api-services/account-direct-access · https://github.com/komercka/adaa-client · https://github.com/AsisTeam/csob-bc · https://www.rb.cz/podnikatele/ucty-a-platebni-styk/prime-bankovnictvi/premium-api · https://www.airbank.cz/aplikace-tretich-stran/aktualne-k-api/ · https://github.com/JirkaChadima/cz-banking-psd2
- Comgate: https://help.comgate.eu/docs/api-protokol · https://help.comgate.eu/docs/predautorizace · https://www.comgate.eu/cs/ceniky-platebni-brany · https://apidoc.comgate.cz/ · https://github.com/comgate-payments/sdk-php · https://github.com/xGearForce/comgate-node
- GoPay: https://doc.gopay.cz/ · https://www.gopay.com/en/pricing/ · https://github.com/gopaycommunity/gopay-js-sdk
- ThePay: https://www.thepay.eu/cs/predautorizace/ · https://www.thepay.eu/cs/cenove-hladiny/ · https://github.com/ThePay/api-client
- GP webpay: https://www.gpwebpay.cz/downloads/GP_webpay_WS.pdf · https://www.npmjs.com/package/@topmonks/gpwebpay
- Stripe: https://stripe.com/en-cz/pricing · https://docs.stripe.com/payments/place-a-hold-on-a-payment-method · https://docs.stripe.com/webhooks · https://docs.stripe.com/api/idempotent_requests · https://docs.stripe.com/security/guide
- Srovnání: https://www.adyen.com/pricing · https://czech.payu.com/jak-aktivovat-payu/ · https://kosmoweb.cz/en/blog/czech-payment-gateways-compared-2026/
- PCI DSS / SCA: https://www.schellman.com/blog/pci-compliance/saq-a-vs-saq-a-ep · https://www.securitymetrics.com/blog/big-changes-for-saq-a · https://stripe.com/guides/strong-customer-authentication
- Právo a daně: https://www.dauc.cz/clanky/8823/zalohy-a-zavdavky-v-ucetnictvi-a-danich · https://www.asociace-sos.cz/vyjimky-z-moznosti-odstoupeni-od-smlouvy/ · https://advokatnidenik.cz/2024/10/28/moznosti-sjednavani-smluvnich-sankci/ · https://portal.pohoda.cz/dane-ucetnictvi-mzdy/dph/jak-na-zalohy-v-dph/ · https://www.podnikatel.cz/clanky/eet-skoncila-jak-je-to-ale-nyni-s-uctenkami-a-dalsimi-doklady/ · https://www.pruvodcepodnikanim.cz/clanek/znovuzavedeni-eet-2-0-v-roce-2027/
- Půjčovny: https://pujcovna.ekolo.cz/cs/page-podminky-pujceni · https://pujcovna.harfasport.cz/pujcovni-rad · https://elektrokola-sumava.cz/ · https://pujcovna-elektrokol.com/obchodni-podminky/

**Neověřeno přímo (web nedostupný/PDF):** oficiální Fio PDF (údaje z komunitních README), portál GP webpay (502), ceník PayU (403), cena RB Premium API (rozpor 99 vs. 500 Kč).
