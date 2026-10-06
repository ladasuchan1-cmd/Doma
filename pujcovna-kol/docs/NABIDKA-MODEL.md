# Nabídka „Kola + web + správa + servis“ pro hotely, penziony a půjčovny – obchodní model

Stav: návrh k rozhodnutí, 6. 10. 2026. Jediný zdroj cen je [`config/nabidka.json`](../config/nabidka.json); tento dokument vysvětluje
model, vzorce a ukazuje tři scénáře spočítané přesně z těchto hodnot. **Nákupní ceny kol jsou skutečné vstupy zadavatele
(20 000 / 40 000 / 70 000 Kč, předpoklad bez DPH); všechno ostatní – prodejní ceny, zůstatkové hodnoty, náklad kapitálu, ceny webu,
správy, servisu, doplňků a interní náklady – je náš NÁVRH K POTVRZENÍ** (`meta.zastupneCeny: true`). Všechny částky bez DPH.

Navazuje na [PLAN.md](../PLAN.md) kap. 15, otevřený bod 3 („obchodní model musteru“): zde ho rozpracováváme na pět linií A–E,
které si klient kombinuje v konfigurátoru. Princip: **každá kombinace musí mít naši hrubou marži ≥ `interni.prahMarzeProcent`
(20 %)**, a zároveň být pro klienta levnější nebo pohodlnější než vlastní nákup a pro partnerský cykloservis zdrojem stabilní práce.

---

## 1. Linie nabídky

### A. Kola – koupě / pronájem / zkušební období

**Tři třídy kol** (`tridyKol`): trekové/městské (`zakladni`), trekové/horské vyšší třídy (`trek`), trekové e-kolo se středovým
motorem (`ekolo`). Klient skládá flotilu z tříd, minimum je **5 kol** (`pronajem.minKol`, `zkouska.minKol`) – pod tím se
nevyplatí doprava, zaškolení ani servisní smlouva.

| Varianta | Co klient dostane | Náš zisk | Pojistky |
|---|---|---|---|
| **Koupě** | kola za `prodejniCena`, dodání, sestavení, záruka výrobce, 2 roky přednostní odkup při obměně | `prodejniCena − nakupniCena` (návrh 20 % z prodejní ceny) | platba předem nebo 50 % při objednávce + 50 % při dodání; vlastnictví přechází zaplacením |
| **Pronájem 24 / 36 m** (operativní leasing s odkupem) | kola za měsíční splátku, na konci odkup za pevnou zůstatkovou cenu (`zustatkova36m`, pro 24 m lineárně přepočtená), vrácení nebo výměna za nová | marže `marzeRocni` (12 % ročně z nákupní ceny) nad anuitou; anuita pokrývá kapitál a jeho náklad `rocniUrok` | kauce `kauceProcent` × prodejní cena (vratná), min. délka = celá doba, předčasné ukončení = doplacení zbývajících splátek do zůstatkové hodnoty, protokol o stavu při vrácení s ceníkem oprav |
| **Zkušební období 4 měsíce** | flotila na jednu sezónu za vyšší sazbu (`nasobekSazby36m` = 2,0× splátky 36 m); **v ceně** web s 1 designem, zaškolení, 1 konzultace/měsíc, 1 sezónní prohlídka, přilby a zámky | vysoká sazba kryje depreciaci a náklady na rozjezd; po zkoušce buď pokračování (pronájem/koupě se započtením 35 % zkušební ceny), odkup kol za 80 % prodejní ceny, nebo vrácení → ex-demo prodej / další klient | záloha 50 % předem, zbytek do 30 dnů; vratná kauce 10 %; **start nejpozději 15. 6.** (`startNejpozdeji`), aby zkouška pokryla hlavní sezónu; předávací protokol s ceníkem oprav; min. 5 kol |

**Financování pronájmu:** z **vlastního kapitálu** zadavatele. `pronajem.rocniUrok` proto není bankovní úrok, ale **náklad
vlastního kapitálu** – navrhujeme **7 %** (rozpětí 6–8 %): spoří-li kapitál na termínovaném vkladu, přijde o 3–4 % p. a.;
investuje-li ho do zboží na prodejně, obrátí ho s marží 20 % za sezónu – 7 % je střed mezi oběma příležitostmi a zároveň pokrývá
riziko nesplácení a předčasného vrácení. Ve výsledku je úrok naším výnosem navíc k marži (ve scénářích ho konzervativně
počítáme jako náklad). **Budoucí varianta:** dodavatelské financování (výrobce / distributor nese kapitál, my platíme jeho
splátky) – model zůstává stejný, jen `rocniUrok` se nastaví na sazbu dodavatele a odpadá vázání vlastních peněz.

**Proč zkouška funguje pro obě strany:** klient za 4 měsíce zaplatí u e-kola 4 × 4 396 = 17 584 Kč, tj. 20 % kupní ceny,
a vyzkouší, zda hosté kola chtějí. My na zkoušce vyděláme i při vrácení: po jedné sezóně má kolo hodnotu ex-demo ≈ 80 %
prodejní ceny (70 400 Kč), což je nad nákupní cenou 70 000 Kč – zkušební nájem je tedy prakticky celý zisk, z něhož se hradí
web, zaškolení a prohlídka (viz scénáře). Vrácená kola jdou k dalšímu klientovi (druhá sezóna za nižší sazbu) nebo do
ex-demo prodeje v kamenné prodejně zadavatele.

**Co se stane s webem:** při vrácení kol po zkoušce web běží dál za `web.sablona.mesicne`, pokud klient chce; jinak se po 30 dnech
vypne, data se exportují a tenant se smaže (viz PLAN kap. 8). Při předčasném ukončení pronájmu platí totéž.

### B. Web – šablona nebo na míru

| Varianta | Co klient dostane | Náš zisk | Pojistky |
|---|---|---|---|
| **Šablona** (`web.sablona`) | subdoména `klient.rezervacekol.cz`, 1 ze 3 designů (Outdoor / Sport / Family), rezervace s poplatkem, platby, mapa okolí a zajímavosti, právní texty, admin | jednorázově 15 000 Kč (náklad nasazení 6 000 Kč) + 990 Kč/měs (hosting 150 Kč) | min. smlouva 12 měsíců; výpověď 2 měsíce; export dat při odchodu |
| **Další design** | přepnutí/přidání designu | 5 000 Kč | – |
| **Na míru** (`web.naMiru`) | vlastní doména, úpravy layoutu, integrace (PMS hotelu, channel manager) | od 60 000 Kč + 1 490 Kč/měs | rozsah fixně v nabídce, změny hodinově |

### C. Správa – sami, nebo předplacená

| Varianta | Co klient dostane | Náš zisk |
|---|---|---|
| **Sami** (`sprava.sami`) | admin, zaškolení (ve zkoušce v ceně), manuál, e-mailová podpora | 0 Kč; podpora nad rámec 900 Kč/h |
| **Předplacená** (`sprava.predplacena`) | obsah (ceník, sezóny, fotky, texty), kontrola rezervací a plateb, helpdesk pro hosty i obsluhu, **1 konzultace/měsíc zdarma** | 3 900 Kč/měs, náš náklad ≈ 3 h × 600 Kč → marže 54 %; další konzultace 900 Kč/h (náklad 600) |

### D. Servis – vlastní, nebo smluvní u partnera

| Varianta | Co klient dostane | Náš zisk | Zisk partnera |
|---|---|---|---|
| **Vlastní** (`servis.vlastni`) | sleva 15 % na díly a spotřební materiál přes náš velkoobchodní účet | marže na dílech | – |
| **Smluvní** (`servis.partner`) | partnerský cykloservis do 30 km: pravidelná údržba, opravy do **48 h** (`slaHodin`), náhradní kolo při delší opravě, 180 Kč/kolo/měs; sezónní prohlídka 900 Kč/kolo | provize 15 % z fakturace partnera (`provizeProNasProcent`) | 85 % z 180 Kč/kolo/měs = 153 Kč → u 20 kol 36 720 Kč/rok + prohlídky 15 300 Kč/rok jisté práce bez akvizice; sleva na díly; přednostní odkup vyřazené flotily |

Sazbu 180 Kč/kolo/měs odvozujeme z tržních cen: velký servis 1 500–2 150 Kč, základní 890–1 290 Kč (Slevomat, cykloservisy 2026) –
roční paušál 2 160 Kč tak odpovídá jednomu velkému servisu a drobným opravám; náročnější e-kola se vyvažují koly základní třídy.

### E. Doplňky (`doplnky`)

Pojištění flotily 120 Kč/kolo/měs (odhad podle KoloNaOperák, kde je pojištění krádeže a vandalismu součástí splátky), GPS lokátor
1 500 Kč + 60 Kč/měs (SIM), přilby a zámky 1 200 Kč/kolo, nabíjecí stanice pro e-kola 25 000 Kč, sezónní prohlídka u partnera
900 Kč/kolo. Naše marže: přilby 30 %, GPS 25 %, pojištění 20 %, nabíječky 20 % (`interni.naklady*ProcentCeny`).

---

## 2. Výpočty (pseudokód pro konfigurátor, klíče 1:1 s `config/nabidka.json`)

```
C = načti config/nabidka.json;  T = C.tridyKol[id];  R(x) = zaokrouhli na celé Kč
mix = { id třídy: počet }      // např. { trek: 2, ekolo: 3 }

zustatkova(T, mesice)   = T.zustatkova36m + (T.prodejniCena − T.zustatkova36m) × (36 − mesice) / 36
anuita(T, mesice)       = i = C.pronajem.rocniUrok / 12
                          pv = zustatkova(T, mesice) / (1 + i)^mesice
                          (T.nakupniCena − pv) × i / (1 − (1 + i)^−mesice)
                          // ekvivalentní zápis: anuita(T.nakupniCena − zustatkova(T, m), i, m) + zustatkova(T, m) × i
pronajemMesicne(T, m)   = R( anuita(T, m) + T.nakupniCena × C.pronajem.marzeRocni / 12 )     // za 1 kolo
                          // POZOR: pro 24 m se musí použít zustatkova(T, 24) (lineární přepočet), ne zustatkova36m –
                          // jinak by klient po 2 letech odkoupil kolo za cenu po 3 letech (náš prodělek ≈ 20 000 Kč na e-kole)
koupe(mix)              = Σ T.prodejniCena × pocet
pronajemMesicneFlotila  = Σ pronajemMesicne(T, m) × pocet;   kauce = R(C.pronajem.kauceProcent × koupe(mix))
odkupNaKonci            = Σ zustatkova(T, m) × pocet

zkouskaMesicne(T)       = R( C.zkouska.nasobekSazby36m × pronajemMesicne(T, 36) )
zkouskaCelkem(mix)      = Σ zkouskaMesicne(T) × pocet × C.zkouska.mesice
zalohaZkousky           = R( C.zkouska.zalohaProcent × zkouskaCelkem );  zbytek do 30 dnů
kauceZkousky            = R( C.zkouska.kauceProcent × koupe(mix) )
zapocet                 = R( C.zkouska.zapocetPriPokracovaniProcent × zkouskaCelkem )   // odečte se z prvních splátek / z kupní ceny
odkupPoZkousce          = R( C.zkouska.odkupPoZkousceProcentProdejni × koupe(mix) )
// start zkoušky ≤ C.zkouska.startNejpozdeji (MM-DD) daného roku; v ceně položky C.zkouska.vCene (web mesicne, správa, prohlídka, přilby = 0 Kč po dobu zkoušky)

webJednorazove          = sablona ? C.web.sablona.jednorazove + dalsiDesigny × C.web.dalsiDesignJednorazove : C.web.naMiru.jednorazoveOd
webMesicne              = sablona ? C.web.sablona.mesicne : C.web.naMiru.mesicne
sprava                  = C.sprava[sami|predplacena].mesicne  (+ hodiny × C.sprava.predplacena.dalsiKonzultaceHodina)
servis                  = partner ? C.servis.partner.mesicneZaKolo × pocetKol : 0
prohlidkaRocne          = C.servis.partner.sezonniProhlidkaZaKolo × pocetKol                  // 1× ročně, ve zkoušce v ceně
doplnky                 = jednorázově Σ (jednorazoveZaKolo × pocetKol | jednorazove);  měsíčně Σ mesicneZaKolo × pocetKol
                          (nabijecky jen když mix obsahuje ekolo: jenEkolo)

marzeNase(mesicu)       = kola: koupe → koupe(mix) − Σ T.nakupniCena × pocet
                                pronajem → Σ T.nakupniCena × pocet × C.pronajem.marzeRocni / 12 × mesicu
                                zkouska  → zkouskaCelkem − nakladyZkousky − zapocet (+ pronájem po přechodu jako výše)
                          + webJednorazove − C.interni.nakladyNasazeniWebu + mesicu × (webMesicne − C.interni.nakladyHostingMesicne)
                          + mesicu × (sprava.predplacena.mesicne − C.interni.nakladySpravyHodinMesicne × C.interni.nakladyKonzultaceHodina)
                          + (servis × mesicu + prohlidkaRocne × mesicu/12) × C.servis.partner.provizeProNasProcent
                          + doplňky × (1 − C.interni.naklady<Doplnek>ProcentCeny)
nakladyZkousky          = C.interni.nakladyNasazeniWebu + C.interni.nakladyZaskoleniHodin × C.interni.nakladyKonzultaceHodina
                          + C.zkouska.mesice × (C.interni.nakladyKonzultaceHodina + C.interni.nakladyHostingMesicne)
                          + prohlidkaRocne × (1 − provizeProNasProcent) + prilby × C.interni.nakladyPrilbyProcentCeny
podilPartnera(mesicu)   = (servis × mesicu + prohlidkaRocne × mesicu/12) × (1 − C.servis.partner.provizeProNasProcent)
kontrola                = marzeNase / tržby ≥ C.interni.prahMarzeProcent, jinak konfigurátor kombinaci označí „nelze nabídnout“
```

Sazby za jedno kolo podle současných hodnot:

| Třída | Nákupní | Prodejní | Zůst. 36 m | Zůst. 24 m | Pronájem 24 m | Pronájem 36 m | Zkouška/měs | 36 splátek + odkup | Marže prodeje | Marže pronájmu |
|---|---|---|---|---|---|---|---|---|---|---|
| Trekové/městské | 20 000 | 25 000 | 8 000 | 13 667 | 563 | 617 | 1 234 | 30 212 | 20,0 % | 32,4 % |
| Trekové/horské vyšší | 40 000 | 50 000 | 16 000 | 27 333 | 1 127 | 1 234 | 2 468 | 60 424 | 20,0 % | 32,4 % |
| E-kolo středový motor | 70 000 | 88 000 | 26 500 | 47 000 | 2 004 | 2 198 | 4 396 | 105 628 | 20,5 % | 31,8 % |

Pronájem na 36 m s odkupem stojí klienta 1,20× kupní ceny – trh (KoloNaOperák: e-kolo 59 999 Kč → 3 075 Kč/měs na 24 m,
tj. 1,23× **včetně** servisu a pojištění) ukazuje, že je prostor případně sazbu zvýšit nebo servis přibalit.

---

## 3. Tři scénáře (spočítáno z `nabidka.json`, Kč bez DPH)

Společná konfigurace: web šablona, servis u partnera, přilby a zámky, 1 sezónní prohlídka ročně. Řádek „Zkouška“ předpokládá
přechod na pronájem 36 m po 4 měsících se započtením 35 %; sloupec „3 roky“ zahrnuje zkoušku + 32 splátek (pronájem běží do
40. měsíce). Náš hrubý zisk = tržby − nákup kol (u pronájmu jen marže nad anuitou) − přímé náklady (nasazení, hosting,
hodiny, nákup doplňků, výplata partnera); procento = podíl na tržbách za 3 roky.

### Penzion – 5 kol (2 trek + 3 e-kola; správa sami; 1 nabíjecí stanice)

Měsíčně bez kol: web 990 + servis 900 = 1 890 Kč; prohlídka 4 500 Kč/rok; doplňky jednorázově 31 000 Kč (přilby 6 000, nabíječka 25 000).

| Model | Jednorázově | Měsíčně | 1 rok | 3 roky | Náš hrubý zisk (3 r.) | Podíl partnera (3 r.) |
|---|---|---|---|---|---|---|
| Koupě | 410 000 | 1 890 | 437 180 | 491 540 | 126 925 (26 %) | 39 015 |
| Pronájem 36 m | 46 000 + kauce 36 400 (vratná) | 10 952 (kola 9 062) | 181 924 | 453 772 + odkup 111 500 | 157 325 (35 %) | 39 015 |
| Zkouška → pronájem | 97 496 (záloha 36 248 předem, zbytek do 30 dnů) + kauce 36 400 | zkouška 19 024; poté 10 952 | 163 338 | 435 186 | 160 837 (37 %) | 41 565 |

Zkouška samotná: 72 496 Kč za 4 měsíce, započet 25 374 Kč, odkup kol po zkoušce 291 200 Kč. Při vrácení kol a ex-demo prodeji
za 291 200 Kč je zisk zkoušky 54 271 Kč (náklady zkoušky bez kol 19 425 Kč).

### Hotel – 20 kol (6 základní + 6 trek + 8 e-kol; správa předplacená; pojištění; 1 nabíjecí stanice)

Měsíčně bez kol: web 990 + správa 3 900 + servis 3 600 + pojištění 2 400 = 10 890 Kč; prohlídka 18 000 Kč/rok; doplňky jednorázově 49 000 Kč.

| Model | Jednorázově | Měsíčně | 1 rok | 3 roky | Náš hrubý zisk (3 r.) | Podíl partnera (3 r.) |
|---|---|---|---|---|---|---|
| Koupě | 1 218 000 | 10 890 | 1 366 680 | 1 664 040 | 405 860 (24 %) | 156 060 |
| Pronájem 36 m | 64 000 + kauce 115 400 | 39 580 (kola 28 690) | 556 960 | 1 542 880 + odkup 356 000 | 503 060 (33 %) | 156 060 |
| Zkouška → pronájem | 254 520 (záloha 114 760) + kauce 115 400 | zkouška 63 380; poté 39 580 | 514 828 | 1 500 748 | 550 288 (37 %) | 166 260 |

Zkouška: 229 520 Kč za 4 měsíce, započet 80 332 Kč, odkup 923 200 Kč; zisk zkoušky při vrácení a ex-demo prodeji 189 220 Kč.

### Resort – 50 kol (15 + 15 + 20 e-kol; správa předplacená; pojištění; GPS; 2 nabíjecí stanice; 2. design)

Měsíčně bez kol: web 990 + správa 3 900 + servis 9 000 + pojištění 6 000 + GPS 3 000 = 22 890 Kč; prohlídka 45 000 Kč/rok; doplňky jednorázově 185 000 Kč.

| Model | Jednorázově | Měsíčně | 1 rok | 3 roky | Náš hrubý zisk (3 r.) | Podíl partnera (3 r.) |
|---|---|---|---|---|---|---|
| Koupě | 3 090 000 | 22 890 | 3 409 680 | 4 049 040 | 890 640 (22 %) | 390 150 |
| Pronájem 36 m | 205 000 + kauce 288 500 | 94 615 (kola 71 725) | 1 385 380 | 3 746 140 + odkup 890 000 | 1 133 640 (30 %) | 390 150 |
| Zkouška → pronájem | 698 800 (záloha 286 900) + kauce 288 500 | zkouška 161 450; poté 94 615 | 1 326 890 | 3 687 650 | 1 294 950 (35 %) | 415 650 |

Zkouška: 573 800 Kč za 4 měsíce, započet 200 830 Kč, odkup 2 308 000 Kč; zisk zkoušky při vrácení 490 150 Kč.

**Čtení výsledků:** všechny kombinace jsou nad prahem 20 %; koupě je marží nejslabší (u resortu 22 % – velkoobjemová sleva
by ji srazila pod práh, proto konfigurátor musí hlídat `prahMarzeProcent` i u slev). Pronájem váže kapitál (penzion 290 000 Kč,
hotel 920 000 Kč, resort 2 300 000 Kč v nákupních cenách), ale přináší o čtvrtinu vyšší zisk a vazbu na 3 roky. Zkouška je
pro klienta nejnižší vstupní práh a pro nás nejvýnosnější varianta – za předpokladu, že ex-demo kola prodáme za ≈ 80 % prodejní
ceny; při 75 % je zisk zkoušky u penzionu 36 071 Kč, při 70 % 17 871 Kč a **při 65 % je zkouška na nule** (−329 Kč).
Dosažitelnou ex-demo cenu je proto nutné ověřit na pilotu dřív, než se zkouška nabídne plošně.

---

## 4. Rizika a pojistky

| Riziko | Pojistka |
|---|---|
| Klient po zkoušce vrátí kola a my je neprodáme | min. 5 kol, start do 15. 6. (celá sezóna), sazba 2× kryje depreciaci; druhý život kol u dalšího klienta; ex-demo kanál v prodejně zadavatele |
| Nesplácení pronájmu | kauce 10 % prodejní ceny, vlastnictví kol zůstává u nás do odkupu, GPS u větších flotil, výpověď s odvozem kol do 14 dnů |
| Předčasné ukončení pronájmu | doplatek rozdílu mezi zůstatkem splátek a aktuální zůstatkovou hodnotou (lineární křivka `zustatkova(T, m)`), nebo převod smlouvy na jiného klienta |
| Stav při vrácení | předávací protokol s fotodokumentací a **ceníkem oprav** (díly + hodinová sazba partnera), započtení proti kauci |
| Partner neplní SLA | smluvní pokuta, záložní partner, náhradní kola z našeho skladu; hodnocení klientem v adminu |
| Web po odchodu klienta | 30 dní provoz, export rezervací a dokladů, smazání tenanta (zpracovatelská smlouva) |
| Vázaný kapitál | strop flotil financovaných z vlastního kapitálu (rozhodne zadavatel), později dodavatelské financování |
| DPH a daňové uznání | pronájem = služba s DPH 21 %, u klienta plátce plně odečitatelná; zkouška totéž; kauce mimo DPH – potvrdit s daňovým poradcem |

---

## 5. Partnerský program pro cykloservisy

**Nabídka:** stabilní paušální příjem 153 Kč/kolo/měs (85 % z 180 Kč) + 765 Kč za sezónní prohlídku kola, bez vlastní akvizice;
noví zákazníci (hosté hotelu, kteří si chtějí kolo koupit nebo opravit vlastní), 15 % sleva na díly přes náš velkoobchodní účet,
**přednostní odkup vyřazené flotily** za zůstatkovou cenu, uvedení na webu klienta i na katalogu půjčoven (PLAN kap. 1).
**Provize pro nás:** 15 % z fakturace partnera klientovi (`provizeProNasProcent`); fakturaci vystavujeme my, partnerovi
posíláme 85 % měsíčně. **SLA:** reakce do 24 h, oprava do 48 h (`slaHodin`), náhradní kolo při delší opravě, originální nebo
námi schválené díly, sezónní prohlídka do 15. 4. a po 15. 10., servisní záznam ke každému kolu v adminu.

**Osnova B2B smlouvy s partnerským cykloservisem (10 bodů):**
1. Strany, předmět: údržba a opravy flotil klientů v spádové oblasti (okres / 30 km).
2. Rozsah služeb: paušální údržba, sezónní prohlídka, opravy na objednávku, ceník prací a dílů (příloha, roční aktualizace).
3. SLA: lhůty reakce a opravy, náhradní kolo, dostupnost v sezóně (so 8–12 h), sankce 500 Kč/den prodlení.
4. Odměna a provize: 85/15, fakturace přes nás, splatnost 14 dnů, bonus 5 % při hodnocení klienta ≥ 4,5/5.
5. Díly: nákup přes náš účet se slevou 15 %, záruka na práci 6 měsíců.
6. Přednostní odkup vyřazené flotily za zůstatkovou cenu, lhůta 14 dnů na uplatnění.
7. Exkluzivita: partner nenabízí klientům přímo konkurenční paušál po dobu smlouvy + 12 měsíců; my nebereme druhého partnera v oblasti bez důvodu (neplnění SLA).
8. Evidence a data: servisní záznamy v našem adminu, GDPR – partner zpracovatel kontaktů obsluhy klienta, žádná data hostů.
9. Odpovědnost a pojištění: pojištění odpovědnosti partnera ≥ 2 mil. Kč, odpovědnost za škodu na kole v dílně.
10. Doba trvání a ukončení: 24 měsíců, výpověď 3 měsíce, okamžitá při opakovaném porušení SLA; dokončení rozpracovaných zakázek.

---

## 6. Zdroje orientačních cen (ověřeno 6. 10. 2026)

- Operativní leasing e-kol v ČR: KoloNaOperák (Global Marketing) – Giant DIRT-E+ 3 POWER 59 999 Kč → 3 075 Kč/měs na 24 m,
  Dahon Icon ED8 43 990 Kč → 1 833 Kč/měs, v ceně pojištění (10 % spoluúčast) a servis; odkup za zůstatkovou cenu
  ([fdrive.cz](https://fdrive.cz/clanky/uz-i-elektrokola-lze-poridit-na-operacni-leasing-2394), článek z r. 2018 – sazby
  bereme jako řádový vzor, ne jako aktuální ceník).
- Sazby cykloservisů 2026: kompletní servis od 1 290 Kč, velký servis 1 500 Kč, sezónní servis s mytím 2 150 Kč, základní
  prohlídka od 890 Kč ([Slevomat – cykloservis Standard/Standard Plus](https://www.slevomat.cz/akce/892519-cykloservis-standard-ci-standard-plus),
  [Slevomat – kompletní seřízení](https://www.slevomat.cz/akce/5434-299-kc-za-kompletni-serizeni-jizdniho-kola), [Firmy.cz – cykloservisy](https://www.firmy.cz/sluzby/Opravy-a-servisy/Cykloservis/kraj-praha)).
- Ceny e-kol 2026: průměr 20–30 tis. Kč, kvalitní trekové se středovým motorem Bosch 45–70 tis. Kč, špička 100+ tis.
  ([aRecenze – nejlepší elektrokola 2026](https://www.arecenze.cz/clanky/nejlepsi-elektrokola-2026-naprostou-klasikou-je-crussis-nejvetsi-nadsence-ale-uchvati-model-za-160-tisic/),
  [Trek – Bosch](https://www.trekbikes.com/cz/cs_CZ/bosch/)).
- Praxe půjčoven (kauce 1 000–20 000 Kč, poplatek 100–350 Kč/kolo): [docs/vyzkum/02-platby-cr.md](vyzkum/02-platby-cr.md) kap. 5.
- Tendr „pronájem elektrokol s komplexní údržbou“ ([BusinessInfo](https://www.businessinfo.cz/prilezitosti/tendr-na-pronajem-elektrokol-s-komplexni-udrzbou-a-dalsimi-sluzbami/))
  potvrzuje poptávku po modelu pronájem + servis; detail nebyl dostupný (HTTP 403).

---

## 7. Co musí dodat zadavatel

1. **Nákupní ceny** – dodány (20 / 40 / 70 tis. Kč); potvrdit, že jsou bez DPH, a doplnit konkrétní modely a dodací lhůty.
2. **Prodejní ceny a marži** – potvrdit návrh 20 % z prodejní ceny (25 / 50 / 88 tis. Kč), nebo zadat vlastní.
3. **Zůstatkové hodnoty po 36 m** – potvrdit návrh 30–32 % prodejní ceny; ideálně podle zkušenosti s bazarem prodejny.
4. **Financování** – strop vlastního kapitálu vázaného v pronájmech a potvrzení nákladu kapitálu 7 %; jednání o dodavatelském financování.
5. **Partnerské servisy** – seznam kandidátů podle regionů prvních klientů, jejich hodinové sazby.
6. **Pojištění flotil** – nabídka pojišťovny (zda 120 Kč/kolo/měs je reálné pro e-kola 88 tis. Kč).
7. **Právní a daňová kontrola** – smlouva o pronájmu s odkupem (vs. finanční leasing), DPH u kauce a započtení, B2B smlouva s partnerem.

## 8. Otevřená rozhodnutí

1. Pronájem s odkupem za zůstatkovou vs. čistý operativní pronájem (odkup jen na vyžádání) – daňové dopady u klienta.
2. Servis v ceně pronájmu (`pronajem.servisVCene = true`, sazba +180 Kč/kolo) jako jediná varianta, nebo volitelně.
3. Výše zkušební sazby 1,8× / 2,0× / 2,2× a započtení 30 / 35 / 40 % – otestovat na dvou pilotních klientech.
4. Druhá sezóna vrácených kol: snížená sazba pro dalšího klienta (návrh 0,7× sazby nových), nebo výhradně ex-demo prodej.
5. Minimální délka smlouvy webu (12 m) při koupi kol bez pronájmu; cena webu „zdarma“ při pronájmu ≥ 20 kol?
6. Provize partnera 15 % vs. fixní poplatek za zprostředkování; kdo fakturuje klientovi (my vs. partner).
7. Objemové slevy při koupi (resort) a jak zachovat práh 20 % – sleva z marže, nebo vyjednaná nižší nákupní cena.
8. Vlastní doména klienta u šablony (`klient.cz` místo subdomény) – za příplatek, nebo jen v „na míru“.
9. Hranice pro povinné GPS lokátory (návrh od 20 kol / u všech e-kol).
10. Pojištění: v ceně pronájmu (jako KoloNaOperák) nebo doplněk.
