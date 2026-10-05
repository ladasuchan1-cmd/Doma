# Výběr platební brány pro adaptér `PaymentProvider`

Stav k 5. 10. 2026. Legenda: **[D]** ověřeno z oficiálního zdroje brány · **[K]** komunitní/sekundární zdroj · **[O]** odhad/rozhodnutí. Vychází z ověřených faktů o Comgate, GoPay, ThePay a Stripe a ze dvou nezávislých hodnocení (A: cena + údržba, B: bezpečnost + riziko). Kritéria zadavatele: nejlevnější pro malé obraty, nejjednodušší údržba, kvalitní bezpečnost. Scénáře: **S** = 250 plateb × 480 Kč (120 000 Kč/rok), 40 preautorizací kauce 5 000 Kč; **M** = 1 000 × 600 Kč (600 000 Kč), 200 preautorizací; sezóna 7 měsíců, 5 měsíců nulový obrat. Podklad pro [PLAN.md](../../PLAN.md), kap. 6 a 15.

## 1. Doporučení

**První brána: Comgate (tarif Easy, první rok Start). Záložní brána: Stripe (Checkout, hostovaná stránka).** Comgate je při zadaných obratech nejlevnější brána s veřejně doloženým a nepodmíněným ceníkem (≈ 2 500 Kč/rok v S, ≈ 7 600 Kč v M), má statickou autentizaci bez nutnosti SDK, úplnou českou dokumentaci, licenci ČNB a zpracování dat v ČR; její hlavní bezpečnostní slabina – nepodepsané notifikace – se odstraní návrhem adaptéru, který stav platby vždy ověřuje dotazem na API (kap. 4). Hodnotitelé se v pořadí neshodli (A: Comgate 79 b., Stripe 57; B: Stripe 80, Comgate 66); rozhodl jsem pro Comgate, protože cenovou nevýhodu Stripe (fixních 6,50 Kč na transakci = +40 % v S a +110 % v M) nelze nijak obejít, zatímco bezpečnostní a údržbový náskok Stripe (podepsané webhooky, sandbox) dorovnáme disciplínou v kódu, kterou plán stejně vyžaduje. Stripe je zálohou místo ThePay proto, že má *jiný* rizikový profil (0 Kč paušál, HMAC webhooky, okamžitá aktivace, mezinárodní karty), kdežto ThePay sdílí slabiny Comgate a je dražší. GoPay oba hodnotitelé odmítli: preautorizace jen 4 dny a jen v legacy API bez data ukončení, sazba 0,95 % je „individuální ujednání“ s rizikem sazebníku od 1. 11. 2026.

## 2. Tabulka srovnání

| Kritérium | **Comgate** (1.) | **Stripe** (2.) | ThePay | GoPay |
|---|---|---|---|---|
| Ceník [D] | Easy 1 % + 0 Kč, 100 Kč/měs. při obratu < 100 tis.; Start 6 měs. zdarma do 50 tis./měs.; refund 5 Kč; výplaty zdarma; chargeback 990 Kč | 1,5 % + 6,50 Kč (EEA), premium 2,8 %, mimo EEA 3,15 %; 0 Kč měsíčně, výplaty i refund; spor 550 Kč | 0,99 % + 0 Kč (min. 5 Kč/tx); 139 Kč/měs. do 250 tis.; refund 5 Kč; výplata 10 Kč; chargeback 1 290 Kč; +1 % bez banneru | nabídka 0,95 % + 0 Kč, 80 Kč/měs. < 50 tis.; **sazebník od 1. 11. 2026: 2,15–2,30 % + 3 Kč, 190 Kč/měs.**; refund 5 Kč; výplata 10 Kč |
| Náklady S / M (kap. 3) | **2 495 / 7 600 Kč** | 3 483 / 15 790 Kč | 3 083 / 8 077 Kč | 2 264 / 6 563 Kč (nabídka) · 5 877 / 17 830 Kč (sazebník) |
| Preautorizace, max. dní [D] | `preauth=true`; garantováno **7 dní**; částečný capture, cancel; i Apple/Google Pay | `capture_method=manual`; **7 dní**; jediný částečný capture; 30 dní jen na IC+ ceníku | **7 dní**; částečná realizace (v2, odpověď 200/202); cancel někdy 422 | **jen 4 dny**; pouze legacy API (v4.0 capture/void nemá); částečný capture aktivuje podpora |
| Notifikace a ověření [D] | POST JSON **bez podpisu**; `secret` v těle + IP whitelist (Comgate + Cloudflare); ověření dotazem `GET /payment/transId`; až 1 000 opakování | POST s **HMAC-SHA256** (`Stripe-Signature`, tolerance 5 min) + publikované IP; deduplikace `event.id`; opakování 3 dny | GET bez podpisu, zdrojové IP nedokumentované; jen dotaz; opakování 2 dny | GET `?id=` bez podpisu; IP v AWS [K]; jen dotaz; 20 opakování |
| Integrace a údržba [D] | REST v2.0 JSON, HTTP Basic `merchant:secret` (statické), IPv4 whitelist odchozích volání; bez sandboxu (`test=true` + druhé propojení obchodu); bez Node SDK → ≈ 6 vlastních endpointů; česky | REST form-urlencoded, restricted key + access policy na IP; pinovaná verze API (breaking max. 2×/rok); sandbox, CLI; SDK netřeba; anglicky | REST, podpis sha256(merchant_id+password+date), tolerance 20 s; IP whitelist povinný; volné demo; OpenAPI YAML; jen PHP SDK | dvě nepřekrývající se generace API; OAuth2 token 30 min; dokumentace při rešerši 503; Node SDK jen pro v4.0 |
| Bezpečnost [D/K] | PCI DSS Level 1; platební instituce ČNB; 3DS dynamické, **verze 2.x nedoložena**; SAQ A jen obecným pravidlem; data v ČR | PCI DSS Level 1, **SAQ A výslovně**; 3DS2 nevypnutelné; irská EMI, přenos do USA; 8/2026 únik klíčů obchodníků, ne Stripe [K] | EMI ČNB; 3DS2; **PCI Level neuveden**; může žádat SAQ/ASV; výpadek karet 11/2024 [K] | PCI DSS Level 1; 3DS2; Worldline N.V.; častá P4 incidence (PSD2) |
| Onboarding [D/K] | smlouva e-mailem, 2 doklady, 1 Kč platba; karty ≈ 14 dní; výplaty D+2 | online, aktivace téměř okamžitá, KYC do 24 h; první výplata 7–14 dní | online, podpis mobilem, „pracovní dny“; výpověď 3 měsíce | 8 kroků, ≈ týden; údaje SMS |

## 3. Výpočet nákladů pro scénáře S a M

Sjednocené předpoklady [O]: ustálený rok bez promo, 100 % spotřebitelských karet EEA v CZK, uvolněná preautorizace 0 Kč, stržená kauce průměrně 1 500 Kč zpoplatněna jen ze stržené částky, vratky u 5 % plateb, výplaty měsíčně jen v sezóně, 0 chargebacků, paušál i v 5 měsících bez obratu. Poplatky jsou osvobozeny od DPH [D; ThePay neuvádí].

| Položka | Comgate Easy | Stripe | ThePay | GoPay (nabídka) | GoPay (sazebník 11/2026) |
|---|---|---|---|---|---|
| **S** – karty 120 000 Kč | 1 % → 1 200 | 1,5 % + 250 × 6,50 → 3 425 | 250 × min. 5 Kč → 1 250 | 0,95 % → 1 140 | 2,2 % + 250 × 3 → 3 390 |
| S – 2 stržené kauce (3 000 Kč) | 30 | 2 × 29 = 58 | 30 | 29 | 72 |
| S – 13 vratek | 65 | 0 | 65 | 65 | 65 |
| S – paušál 12 měs. + 7 výplat | 12 × 100 = 1 200 | 0 | 12 × 139 + 70 = 1 738 | 12 × 80 + 70 = 1 030 | 12 × 190 + 70 = 2 350 |
| **S celkem / rok** | **2 495 (2,1 %)** | **3 483 (2,9 %)** | **3 083 (2,6 %)** | **2 264 (1,9 %)** | **5 877 (4,9 %)** |
| **M** – karty 600 000 Kč | 6 000 | 9 000 + 6 500 = 15 500 | 5 940 | 5 700 | 16 200 |
| M – 10 stržených kaucí (15 000 Kč) | 150 | 290 | 149 | 143 | 360 |
| M – 50 vratek | 250 | 0 | 250 | 250 | 250 |
| M – paušál + 7 výplat | 1 200 | 0 | 1 738 | 5 × 80 + 70 = 470 | 5 × 190 + 70 = 1 020 |
| **M celkem / rok** | **7 600 (1,27 %)** | **15 790 (2,6 %)** | **8 077 (1,35 %)** | **6 563 (1,1 %)** | **17 830 (3,0 %)** |

Comgate první rok s tarifem Start ≈ 870 Kč (S) / ≈ 4 000 Kč (M) [O]; Profi (0,67 % + 1 Kč) by v M ušetřil ≈ 980 Kč, pokud ho obchodník nabídne [D]. Stripe je jediná brána bez paušálu – pod ≈ 65 000 Kč ročního obratu vychází levněji než Comgate [O]. **Citlivost Comgate:** kdyby se 1 % účtovalo z plné blokované částky každé preautorizace, S vzroste na ≈ 4 500 Kč a M na ≈ 17 600 Kč – Stripe by pak byl levnější v obou scénářích (kap. 5).

## 4. Co to znamená pro architekturu adaptéru

Rozhraní `PaymentProvider` z [rešerše 02](02-platby-cr.md) (`createPayment`, `getStatus`, `capture`, `cancelHold`, `refund`, `verifyWebhook`) zůstává; níže mapování na Comgate, na konci odchylky Stripe.

**Kroky volání (Comgate REST v2.0, `https://payments.comgate.cz/v2.0/`, HTTP Basic `merchant:secret`, částky v haléřích) [D]:**
1. *Založení platby:* nejdřív vložit řádek `payments` s `idempotency_key` (Comgate nemá Idempotency-Key), pak `POST /payment.json` s `price`, `curr=CZK`, `label` (≤ 16 znaků), `refId` = číslo rezervace, `email`, `url_paid/url_cancelled/url_pending`, `preauth=true` pro kauci. Uložit `transId` a redirect URL; opakování se stejným klíčem vrátí uloženou URL, nikdy druhou platbu.
2. *Návrat zákazníka* na `url_paid` je jen UI – stav ihned `GET /payment/transId/{id}.json`.
3. *Notifikace* `POST` JSON: (a) odpovědět 2xx hned, zpracovat z fronty `outbox`; (b) zdrojovou IP porovnat s denně stahovanými seznamy `payments.comgate.cz/ips-v4` + `cloudflare.com/ips-v4` – jen doplňková kontrola; (c) `secret` z těla porovnat `timingSafeEqual`, **nikdy nelogovat**; (d) **vždy** `GET /payment/transId` a řídit se výhradně jeho `status`; (e) idempotence: `webhook_events` s klíčem `comgate:<transId>:<status>` (Comgate nemá ID události), opakovaný `PAID` = no-op.
4. *Kauce:* po `AUTHORIZED` → stav `authorized`; při vrácení `PUT /preauth/transId/{id}.json` s `amount` (≤ blokace) nebo `DELETE …/preauth/…`. Job: 5. den upozornění obsluze, 6. den automatické uvolnění, není-li vyúčtováno (garance 7 dní). Výpůjčka > 5 dní → kauce hotově/terminálem.
5. *Vratka:* `POST /refund.json` (`transId`, `amount`, `refId`); stav vratky není v API → `refund_requested`, párování přes `GET /transferList/date/{date}.json`; po 14 pracovních dnech bez provedení alert (Comgate ji zruší pro nedostatek krytí – mimo sezónu dobít „Pohledávky“).
6. *Rekonciliace:* denně `transferList` → `refId` ↔ `payments`, poplatky do `ledger_entries`.

*Stripe:* Checkout Session s `payment_intent_data[capture_method]=manual` a `client_reference_id`; webhook ověřit HMAC-SHA256 nad `t.rawBody` přes `node:crypto` s `timingSafeEqual`, tolerance 300 s, deduplikace `event.id`; stav `GET /v1/payment_intents/{id}`; `Idempotency-Key` na každém POST; hlavička `Stripe-Version` připnutá [D].

**Co ukládat:** `provider`, `provider_ref` (transId / PaymentIntent id), `refId`, stav, `amount_minor`, `captured_minor`, měnu, metodu, případně brand + last4 (mimo PCI), časy přechodů, surovou notifikaci **se smazaným polem `secret`**. Nikdy PAN, CVC, 3DS data ani heslo brány v logu.

**Tajemství a rotace (per půjčovna, AES-256-GCM v její DB, verze klíče) [D/O]:**
- Comgate `merchant` + `secret`: rotace není dokumentována → ručně v Klientském portálu nejméně ročně a při odchodu zaměstnance; adaptér přechodně zná dvě hesla (staré ověřuje doběhlé notifikace, nové volá API).
- Comgate IP whitelist: naše výstupní IPv4 v každém tenantovi; při změně serveru hromadně `POST /config.json` skriptem. Stage = druhé propojení obchodu s `test=true`, nikdy produkční údaje.
- Stripe: restricted key (`checkout_sessions`, `payment_intents`, `refunds` write; `events` read) s access policy na IP, rotace s překryvem 7 dní; `whsec_` per endpoint, překryv 24 h.
- Testy pro oba adaptéry: podvržený `status=PAID`, cizí IP, replay, dvojí `paid`, podvržená částka – nic z toho nesmí změnit stav rezervace.

## 5. Rizika a kdy přepnout na druhou bránu

| Riziko | Dopad | Opatření / spouštěč přepnutí |
|---|---|---|
| Comgate účtuje 1 % z blokované částky preautorizace (neověřeno) | S +2 000 Kč, M +10 000 Kč → Stripe levnější | **vyžádat písemně před podpisem**; při potvrzení Stripe jako výchozí brána musteru |
| Změna ceníku Comgate (2025→2026: 0,98 → 1 %, refund 2 → 5 Kč) [D] | zdražení; VOP dává 2 měsíce předstih | hlídat smluvní dokumenty; přepnout, pokud Easy > 1,3 % nebo paušál > 150 Kč/měs. |
| Start nedostupný půjčovně s existujícím terminálem | první rok dražší o ≈ 600–3 000 Kč | není důvod k přepnutí |
| Karty u Comgate schváleny až za ≈ 14 dní | zdržení pilotu | smlouvu zahájit ve fázi 0; pro pilot dočasně Stripe |
| Výpadek Comgate, podpora o víkendu nedostupná [K] | nelze platit kartou | převod + QR fungují nezávisle; přepínač brány per tenant v `settings`; adaptér Stripe hotový po pilotu |
| Půjčovna s obratem < 65 tis. Kč/rok nebo zahraniční klientelou | paušál 1 200 Kč/rok; mimo-EU karty 2 % | per tenant zvolit Stripe (0 Kč paušál) |
| Únik `secret` (notifikace nese heslo) | podvržené notifikace, volání API | notifikace nikdy zdroj pravdy; rotace; IP whitelist; alert na odmítnuté notifikace |
| Comgate nedoloží 3DS2/SCA a SAQ A písemně | nejistota compliance | vyžádat potvrzení; při odmítnutí Stripe |
| Stripe: přenos do USA, zpřísněné KYC 2026, únik klíčů obchodníků | text Zásad, pozastavení výplat | do Zásad doplnit DPF/SCC a Stripe jako správce; restricted keys, vault, monitoring |

ThePay zůstává třetí možností jen pro půjčovnu, která trvá na české bráně a Comgate ji odmítne – po doložení PCI DSS Level a s vědomím tříměsíční výpovědi. GoPay nezařazujeme.

## 6. Co zbývá ověřit

1. **Comgate – poplatek za preautorizaci** (z blokované vs. stržené částky, cena uvolnění) – rozhodující pro cenu, písemně před podpisem.
2. Comgate – datum účinnosti ceníků CZK26 (PDF bez „platný od“); zda Start 2026 vyžaduje absenci smlouvy o akceptaci karet; jak se vybírá paušál v měsíci bez obratu; zda se při refundaci vrací původní poplatek.
3. Comgate – verze 3-D Secure (2.x), soulad se SCA, kategorie SAQ pro redirect; rotace `secret`; rate limity; konec API v1.0; historie incidentů (status stránka nebyla strojově čitelná).
4. Stripe – definice „premium“ karet, datum účinnosti českého ceníku, bezplatnost standardních výplat, smluvní entita (Stripe Payments Europe vs. Stripe Technology Europe), MCC půjčovny pro 30denní autorizaci.
5. ThePay – paušál při nulovém obratu, PCI Level, uplatňování minima 5 Kč/tx. GoPay – zda nová půjčovna dostane 0,95 %, konec legacy API, IP notifikací.
6. Vstupy odhadu, které zadání neurčilo: stržená kauce, podíl vratek, frekvence výplat – poplatky jsou lineární, přepočet je triviální.

## 7. Zdroje

**Comgate [D]:** https://www.comgate.eu/cs/ceniky-platebni-brany · https://www.comgate.eu/files/15679-comgate-easy-czk26pbcz.pdf · https://www.comgate.eu/files/15687-comgate-start-czk26pbcz.pdf · https://www.comgate.eu/files/2024-obchodni-podminky-comgate-as-od-23-08-2024.pdf · https://help.comgate.eu/docs/poplatky.md · https://help.comgate.eu/docs/predautorizace.md · https://help.comgate.eu/docs/refundace.md · https://help.comgate.eu/docs/dodrzovani-standardu-pci-dss.md · https://help.comgate.eu/docs/3d-secure-overeni.md · https://apidoc.comgate.cz/en/api/rest/ · https://apidoc.comgate.cz/en/push-notifikace/ · https://apidoc.comgate.cz/en/zabezpeceni/ · http://payments.comgate.cz/ips-v4 · https://status.comgate.cz/ · https://github.com/comgate-payments/sdk-php/issues/116

**Stripe [D]:** https://stripe.com/cz/pricing · https://docs.stripe.com/payments/place-a-hold-on-a-payment-method · https://docs.stripe.com/payments/extended-authorization · https://docs.stripe.com/refunds · https://docs.stripe.com/webhooks · https://docs.stripe.com/ips · https://docs.stripe.com/api/idempotent_requests · https://docs.stripe.com/api/versioning · https://docs.stripe.com/payments/checkout · https://docs.stripe.com/keys · https://stripe.com/guides/pci-compliance · https://docs.stripe.com/payments/3d-secure · https://stripe.com/en-cz/legal/ssa · https://stripe.com/legal/stel · [K] https://www.hudsonrock.com/blog/analyzing-stripe-breach-confirmed-vendor-exposure-and-claims-of-20000-compromised-apis

**ThePay [D]:** https://www.thepay.eu/nwm-upload/2025/04/sazebnik_poplatku_5_5_2025.pdf · https://www.thepay.eu/nwm-upload/2026/07/obchodni_podminky_15_8_2026.pdf · https://www.thepay.eu/cs/predautorizace/ · https://gate.thepay.cz/openapi.yaml · https://docs.thepay.eu/

**GoPay [D]:** https://www.gopay.com/cs/platebni-brana/ · https://help.gopay.com/cs/tema/cenik-a-obchodni-podminky/aktualni-cenik-a-obchodni-podminky/sazebniky-poplatku/sazebnik-poplatku-platebni-brany-gopay-ucinnost-od-1-11-2026 · https://help.gopay.com/cs/tema/integrace-platebni-brany/technicky-popis-integrace-platebni-brany/predautorizovane-platby · https://api-docs.gopay.com/ · https://github.com/gopaycommunity/gopay-js-sdk · https://gopay.status.io/

**Interní:** [02-platby-cr.md](02-platby-cr.md) (rozhraní `PaymentProvider`, PCI SAQ A), [03-bezpecnost-gdpr-podminky.md](03-bezpecnost-gdpr-podminky.md) (checklist, bod 17), [PLAN.md](../../PLAN.md).
