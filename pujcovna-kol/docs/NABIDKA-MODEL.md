# Nabídka „Kola + web + správa + servis“ pro hotely, penziony a půjčovny – obchodní model

Stav: návrh k rozhodnutí, 6. 10. 2026. Veřejný zdroj cen je [`config/nabidka.json`](../config/nabidka.json); tento dokument vysvětluje
model, vzorce a ukazuje tři scénáře spočítané přesně z těchto hodnot. Všechny částky bez DPH. **Prodejní ceny, zůstatkové hodnoty,
náklad kapitálu, ceny webu, správy, servisu, doplňků a interní náklady jsou náš NÁVRH K POTVRZENÍ** (`meta.zastupneCeny: true`).

**Nákupní ceny kol nejsou nikde v gitu ani v tomto dokumentu.** Architektura dat:

| Soubor | Co obsahuje | Kde leží |
|---|---|---|
| `config/nabidka.json` | jen VEŘEJNÉ ceny: prodejní, zůstatkové, web, správa, servis, doplňky a interní nákladové parametry (`interni.*`). Validace ho **odmítne**, pokud by obsahoval `nakupniCena` | git |
| `config/kola-modely.json` | veřejné údaje o konkrétních modelech (název, doporučená cena výrobce vč. DPH, odkaz) | git |
| interní soubor s nákupními cenami tříd a konkrétních modelů | `nakupniCena` pro třídy (`tridyKol`) i modely (`modely`) | MIMO git: cesta `PK_NABIDKA_INTERNI`, jinak `$PK_DATA/nabidka.interni.json` (na serveru `/data/nabidka.interni.json` v datovém svazku), lokálně i `config/nabidka.interni.json` (v `.gitignore`) |
| `config/nabidka.interni.example.json` | VZOR interního souboru s **UKÁZKOVÝMI** hodnotami (třídy 18 000 / 36 000 / 64 000 Kč; modely viz soubor) | git |

Chybí-li interní soubor, konfigurátor funguje dál a nákupní cenu odvodí jako prodejní × (1 − `interni.prahMarzeProcent`)
(`meta.nakupniCenyOdvozene = true`); interní blok to označí varováním. Nákupní ceny se zobrazují **jen v interním bloku pro přihlášené
správce** (tabulka tříd a tabulka konkrétních modelů: veřejná cena výrobce bez DPH vs. nákupní, marže), nikdy veřejně. Konkrétní
modely z `config/kola-modely.json` se zobrazují na /nabidka v sekci „Konkrétní modely, které flotilu tvoří“ a v demu půjčovny jako typy kol.

**Všechny nákupní ceny, marže a scénáře v tomto dokumentu jsou počítány z UKÁZKOVÝCH nákupních cen** z `config/nabidka.interni.example.json`
(18 000 / 36 000 / 64 000 Kč za třídy `zakladni` / `trek` / `ekolo`). Skutečné nákupní ceny jsou pouze v interním souboru na serveru;
skutečné marže se od ukázkových liší.

Navazuje na [PLAN.md](../PLAN.md) kap. 15, otevřený bod 3 („obchodní model musteru“): zde ho rozpracováváme na pět linií A–E,
které si klient kombinuje v konfigurátoru. Princip: **každá kombinace musí mít naši hrubou marži ≥ `interni.prahMarzeProcent`
(20 %)**, a zároveň být pro klienta levnější nebo pohodlnější než vlastní nákup a pro partnerský cykloservis zdrojem stabilní práce.

---

## 1. Linie nabídky

### A. Kola – koupě / pronájem / zkušební období

**Tři třídy kol** (`tridyKol`): trekové/městské (`zakladni`), trekové/horské vyšší třídy (`trek`), trekové e-kolo se středovým
motorem (`ekolo`). Klient skládá flotilu z tříd, minimum jsou **2 kola** (od 6. 10. 2026; dřív 5 – `pronajem.minKol`,
`zkouska.minKol` a první stupeň `mnozstevniSlevy`). Malé flotile pokrývá fixní náklady rozjezdu (doprava, zaškolení, nasazení
webu) **poplatek za rozjezd zkoušky** a vyšší záloha; s počtem kol obojí klesá (viz tabulka stupňů níže).

**Množstevní stupně** (`mnozstevniSlevy`, počítá se celkový počet kol všech tříd): čím víc kol, tím vyšší sleva a lepší
podmínky. Sleva se uplatní na kupní cenu (`slevaKoupe`), na měsíční sazbu pronájmu i zkoušky (`sleva`); kauce a záloha zkoušky
se řídí stupněm. Návrh k potvrzení:

| Stupeň | Kol | Sleva pronájem / zkouška | Sleva koupě | Poplatek za rozjezd zkoušky | Kauce | Záloha zkoušky | Další výhody |
|---|---|---|---|---|---|---|---|
| Start | 2–4 | 0 % | 0 % | 7 900 Kč | 10 % | 50 % | zaškolení, servis do 48 h |
| Flotila | 5–9 | 4 % | 3 % | 3 900 Kč | 10 % | 40 % | – |
| Hotel | 10–19 | 7 % | 5 % | zdarma | 8 % | 30 % | náhradní kolo po dobu opravy |
| Resort | 20+ | 10 % | 7 % | zdarma | 5 % | 25 % | servis do 24 h, náhradní kolo, přednostní obměna modelů |

Koupě má nižší slevu než pronájem, protože marže koupě je jednorázová: s ukázkovými nákupními cenami drží 10 % sleva e-kola
na 19 % (pod prahem 20 %), 7 % na 22 %. Test `množstevní stupně: … marži nad prahem` projde všechny kombinace (2–50 kol,
3 třídy, 4 způsoby pořízení, web, servis) a hlídá, že žádná nespadne pod `interni.prahMarzeProcent`. Se skutečnými nákupními
cenami to ukazuje interní blok konfigurátoru. Konfigurátor ukazuje klientovi aktuální stupeň, úsporu v Kč a kolik kol chybí
do dalšího stupně („Přidejte ještě 1 kolo a dostanete slevu 4 %“). Scénáře v kapitole 3 jsou počítané **bez** stupňů.

| Varianta | Co klient dostane | Náš zisk | Pojistky |
|---|---|---|---|
| **Koupě** | kola za `prodejniCena`, dodání, sestavení, záruka výrobce, 2 roky přednostní odkup při obměně | `prodejniCena − nakupniCena` (s ukázkovými nákupními cenami ≈ 27–28 % z prodejní ceny) | platba předem nebo 50 % při objednávce + 50 % při dodání; vlastnictví přechází zaplacením |
| **Pronájem 24 / 36 m** (operativní leasing s odkupem) | kola za měsíční splátku, na konci odkup za pevnou zůstatkovou cenu (`zustatkova36m`, pro 24 m lineárně přepočtená), vrácení nebo výměna za nová | marže `marzeRocni` (12 % ročně z nákupní ceny) nad anuitou; anuita pokrývá kapitál a jeho náklad `rocniUrok` | kauce `kauceProcent` × prodejní cena (vratná), min. délka = celá doba, předčasné ukončení = doplacení zbývajících splátek do zůstatkové hodnoty, protokol o stavu při vrácení s ceníkem oprav |
| **Zkušební období 4 měsíce** | flotila na jednu sezónu za vyšší sazbu (`nasobekSazby36m` = 2,0× splátky 36 m); **v ceně** web s 1 designem, zaškolení, 1 konzultace/měsíc, 1 sezónní prohlídka, přilby a zámky | vysoká sazba kryje depreciaci a náklady na rozjezd; po zkoušce buď pokračování (pronájem/koupě se započtením 35 % zkušební ceny), odkup kol za 80 % prodejní ceny, nebo vrácení → ex-demo prodej / další klient | záloha 50–25 % předem podle stupně, zbytek do 30 dnů; vratná kauce 10–5 % podle stupně; poplatek za rozjezd u flotil do 9 kol; **start nejpozději 15. 6.** (`startNejpozdeji`), aby zkouška pokryla hlavní sezónu; předávací protokol s ceníkem oprav; min. 2 kola |

**Financování pronájmu:** z **vlastního kapitálu** zadavatele. `pronajem.rocniUrok` proto není bankovní úrok, ale **náklad
vlastního kapitálu** – navrhujeme **7 %** (rozpětí 6–8 %): spoří-li kapitál na termínovaném vkladu, přijde o 3–4 % p. a.;
investuje-li ho do zboží na prodejně, obrátí ho s marží 20 % za sezónu – 7 % je střed mezi oběma příležitostmi a zároveň pokrývá
riziko nesplácení a předčasného vrácení. Ve výsledku je úrok naším výnosem navíc k marži (ve scénářích ho konzervativně
počítáme jako náklad). **Budoucí varianta:** dodavatelské financování (výrobce / distributor nese kapitál, my platíme jeho
splátky) – model zůstává stejný, jen `rocniUrok` se nastaví na sazbu dodavatele a odpadá vázání vlastních peněz.

**Proč zkouška funguje pro obě strany:** klient za 4 měsíce zaplatí u e-kola 4 × 3 904 = 15 616 Kč, tj. 18 % kupní ceny,
a vyzkouší, zda hosté kola chtějí. My na zkoušce vyděláme i při vrácení: po jedné sezóně má kolo hodnotu ex-demo ≈ 80 %
prodejní ceny (70 400 Kč), což je nad **ukázkovou** nákupní cenou 64 000 Kč (skutečná je jen v interním souboru) – zkušební nájem je
tedy prakticky celý zisk, z něhož se hradí web, zaškolení a prohlídka (viz scénáře). Vrácená kola jdou k dalšímu klientovi (druhá sezóna za nižší sazbu) nebo do
ex-demo prodeje v kamenné prodejně zadavatele.

**Co se stane s webem:** při vrácení kol po zkoušce web běží dál za `web.sablona.mesicne`, pokud klient chce; jinak se po 30 dnech
vypne, data se exportují a tenant se smaže (viz PLAN kap. 8). Při předčasném ukončení pronájmu platí totéž.

### B. Web – šablona nebo na míru

| Varianta | Co klient dostane | Náš zisk | Pojistky |
|---|---|---|---|
| **Šablona** (`web.sablona`) | subdoména `klient.rezervacekol.cz`, 1 ze 3 designů (Outdoor / Sport / Family), rezervace s poplatkem, platby, mapa okolí a zajímavosti, právní texty, admin | jednorázově 15 000 Kč (náklad nasazení 6 000 Kč) + 990 Kč/měs (hosting 150 Kč) | min. smlouva 12 měsíců; výpověď 2 měsíce; export dat při odchodu |
| **Další design** | přepnutí/přidání designu | 5 000 Kč | – |
| **Na míru** (`web.naMiru`) | vlastní doména, vlastní design a úpravy layoutu; **bez napojení na cizí systémy** (PMS hotelu, channel manager, stávající rezervační systém – od 6. 10. 2026 nenabízíme) | od 60 000 Kč + 1 490 Kč/měs | rozsah fixně v nabídce, změny hodinově |

Rezervace kol běží vždy samostatně na naší subdoméně (nebo vlastní doméně u webu na míru). Se stávajícím webem klienta se
„propojí“ jen **odkazem nebo tlačítkem „Půjčit kolo“** – klient ho vloží sám, žádná technická integrace, žádná závislost na
jeho dodavateli webu.

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

Konfigurátor nejdřív načte veřejný `config/nabidka.json` (validace ho odmítne, pokud obsahuje `nakupniCena`) a pak interní soubor
(`PK_NABIDKA_INTERNI` → `$PK_DATA/nabidka.interni.json` → lokálně `config/nabidka.interni.json`; změna se projeví do 2 s bez restartu).
`validateConfig(veřejný, interní)` z nich složí jednu konfiguraci, ve které má každá třída `T.nakupniCena`. Bez interního souboru se
`T.nakupniCena = prodejniCena × (1 − interni.prahMarzeProcent)` a `meta.nakupniCenyOdvozene = true`. Veřejný výstup konfigurátoru nákupní
ceny nikdy neobsahuje, jen blok `interni` pro přihlášené správce.

```
C = načti config/nabidka.json + interní soubor (nákupní ceny);  T = C.tridyKol[id];  R(x) = zaokrouhli na celé Kč
mix = { id třídy: počet }      // např. { trek: 2, ekolo: 3 }

zustatkova(T, mesice)   = T.zustatkova36m + (T.prodejniCena − T.zustatkova36m) × (36 − mesice) / 36
anuita(T, mesice)       = i = C.pronajem.rocniUrok / 12
                          pv = zustatkova(T, mesice) / (1 + i)^mesice
                          (T.nakupniCena − pv) × i / (1 − (1 + i)^−mesice)
                          // ekvivalentní zápis: anuita(T.nakupniCena − zustatkova(T, m), i, m) + zustatkova(T, m) × i
pronajemMesicne(T, m)   = R( anuita(T, m) + T.nakupniCena × C.pronajem.marzeRocni / 12 )     // za 1 kolo
                          // POZOR: pro 24 m se musí použít zustatkova(T, 24) (lineární přepočet), ne zustatkova36m –
                          // jinak by klient po 2 letech odkoupil kolo za cenu po 3 letech (náš prodělek by byl řádově desítky tisíc Kč na e-kole)
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

Sazby za jedno kolo podle současných veřejných hodnot a **UKÁZKOVÝCH nákupních cen**:

| Třída | Nákupní | Prodejní | Zůst. 36 m | Zůst. 24 m | Pronájem 24 m | Pronájem 36 m | Zkouška/měs | 36 splátek + odkup | Marže prodeje | Marže pronájmu |
|---|---|---|---|---|---|---|---|---|---|---|
| Trekové/městské | 18 000 | 25 000 | 8 000 | 13 667 | 454 | 535 | 1 070 | 27 260 | 28,0 % | 34,0 % |
| Trekové/horské vyšší | 36 000 | 50 000 | 16 000 | 27 333 | 907 | 1 071 | 2 142 | 54 556 | 28,0 % | 34,0 % |
| E-kolo středový motor | 64 000 | 88 000 | 26 500 | 47 000 | 1 675 | 1 952 | 3 904 | 96 772 | 27,3 % | 33,9 % |

Nákupní ceny v tabulce jsou **ukázkové** z `config/nabidka.interni.example.json`; skutečné jsou pouze v interním souboru na serveru.
(„36 splátek + odkup“ = 36 × splátka + zůstatková hodnota, např. 36 × 535 + 8 000 = 27 260; marže pronájmu = (36 splátek + odkup − nákupní) / (36 splátek + odkup).)

Pronájem na 36 m s odkupem stojí klienta ≈ 1,1× kupní ceny (27 260 / 25 000 = 1,09×, 54 556 / 50 000 = 1,09×, 96 772 / 88 000 = 1,10×) – trh (KoloNaOperák: e-kolo 59 999 Kč → 3 075 Kč/měs na 24 m,
tj. 1,23× **včetně** servisu a pojištění) ukazuje, že je prostor případně sazbu zvýšit nebo servis přibalit.

### 2b. Konkrétní modely

Konkrétní modely, které flotilu tvoří, jsou ve [`config/kola-modely.json`](../config/kola-modely.json) – jen veřejné údaje (název, doporučená
cena výrobce vč. DPH, odkaz, velikosti, popis, ceník půjčovny pro demo). Doporučené ceny výrobce vč. DPH k 6. 10. 2026:

| Model | Cena vč. DPH (aktuální) | Běžná cena |
|---|---|---|
| Superior eXP 6.4 STEPS | 53 990 Kč | 91 990 Kč |
| Superior eXP 6.4 STEPS SUV | 56 990 Kč | 93 990 Kč |
| Superior eWAY 6.4 | 75 990 Kč | 75 990 Kč |
| Rock Machine eBlizzard 30 S | 67 990 Kč | 79 990 Kč |
| Rock Machine Crossride e400 B Touring | 52 990 Kč | 64 990 Kč |
| Superior Racer 20 (dětské) | 10 990 Kč | 10 990 Kč |

Nákupní ceny modelů jsou (stejně jako u tříd) jen v interním souboru mimo git (blok `modely`, vzor v `config/nabidka.interni.example.json`).
**Pozor na rozpor s prodejními cenami tříd:** veřejná cena těchto e-kol bez DPH vychází na ≈ 44–63 tis. Kč, což je výrazně POD prodejní cenou
třídy „ekolo“ v konfigurátoru (88 000 Kč bez DPH). Prodejní ceny tříd je proto třeba sladit se skutečnou flotilou (viz otevřené rozhodnutí 11 v sekci 8);
do té doby jsou výpočty v sekci 3 ilustrativní.

---

## 3. Tři scénáře (spočítáno z `nabidka.json` a UKÁZKOVÝCH nákupních cen z `nabidka.interni.example.json`, Kč bez DPH)

Společná konfigurace: web šablona, servis u partnera, přilby a zámky, 1 sezónní prohlídka ročně. Řádek „Zkouška“ předpokládá
přechod na pronájem 36 m po 4 měsících se započtením 35 %; sloupec „3 roky“ zahrnuje zkoušku (4 měsíce) + 32 splátek pronájmu (celkem 36 měsíců); „1 rok“ = jednorázově (vč. celé ceny zkoušky) + 4 × měsíčně mimo kola ve zkoušce + 8 × měsíčně pronájmu − započet. Náš hrubý zisk = tržby − nákup kol (u pronájmu jen marže nad anuitou) − přímé náklady (nasazení, hosting,
hodiny, nákup doplňků, výplata partnera); procento = podíl na tržbách za 3 roky.

### Penzion – 5 kol (2 trek + 3 e-kola; správa sami; 1 nabíjecí stanice)

Měsíčně bez kol: web 990 + servis 900 = 1 890 Kč; prohlídka 4 500 Kč/rok; doplňky jednorázově 31 000 Kč (přilby 6 000, nabíječka 25 000).

| Model | Jednorázově | Měsíčně | 1 rok | 3 roky | Náš hrubý zisk (3 r.) | Podíl partnera (3 r.) |
|---|---|---|---|---|---|---|
| Koupě | 410 000 | 1 890 | 437 180 | 491 540 | 152 925 (31 %) | 39 015 |
| Pronájem 36 m | 46 000 + kauce 36 400 (vratná) | 9 888 (kola 7 998) | 169 156 | 415 468 + odkup 111 500 | 147 965 (36 %) | 39 015 |
| Zkouška → pronájem | 88 984 (záloha 31 992 předem, zbytek do 30 dnů) + kauce 36 400 | zkouška 16 896; poté 9 888 | 149 294 | 395 606 | 144 735 (37 %) | 39 015 |

Zkouška samotná: 63 984 Kč za 4 měsíce, započet 22 394 Kč, odkup kol po zkoušce 291 200 Kč. Při vrácení kol a ex-demo prodeji
za 291 200 Kč je zisk zkoušky 71 759 Kč (náklady zkoušky bez kol 19 425 Kč).

### Hotel – 20 kol (6 základní + 6 trek + 8 e-kol; správa předplacená; pojištění; 1 nabíjecí stanice)

Měsíčně bez kol: web 990 + správa 3 900 + servis 3 600 + pojištění 2 400 = 10 890 Kč; prohlídka 18 000 Kč/rok; doplňky jednorázově 49 000 Kč.

| Model | Jednorázově | Měsíčně | 1 rok | 3 roky | Náš hrubý zisk (3 r.) | Podíl partnera (3 r.) |
|---|---|---|---|---|---|---|
| Koupě | 1 218 000 | 10 890 | 1 366 680 | 1 664 040 | 489 860 (29 %) | 156 060 |
| Pronájem 36 m | 64 000 + kauce 115 400 | 36 142 (kola 25 252) | 515 704 | 1 419 112 + odkup 356 000 | 472 820 (33 %) | 156 060 |
| Zkouška → pronájem | 227 016 (záloha 101 008 předem, zbytek do 30 dnů) + kauce 115 400 | zkouška 56 504; poté 36 142 | 469 446 | 1 372 854 | 496 530 (36 %) | 156 060 |

Zkouška: 202 016 Kč za 4 měsíce, započet 70 706 Kč, odkup 923 200 Kč; zisk zkoušky při vrácení a ex-demo prodeji 245 716 Kč (náklady zkoušky bez kol 43 500 Kč).

### Resort – 50 kol (15 + 15 + 20 e-kol; správa předplacená; pojištění; GPS; 1 nabíjecí stanice; 2. design)

Měsíčně bez kol: web 990 + správa 3 900 + servis 9 000 + pojištění 6 000 + GPS 3 000 = 22 890 Kč; prohlídka 45 000 Kč/rok; doplňky jednorázově 160 000 Kč
(přilby 60 000, nabíječka 25 000, GPS 75 000) + 2. design 5 000 Kč. Konfigurace umí jen 1 nabíjecí stanici.

| Model | Jednorázově | Měsíčně | 1 rok | 3 roky | Náš hrubý zisk (3 r.) | Podíl partnera (3 r.) |
|---|---|---|---|---|---|---|
| Koupě | 3 065 000 | 22 890 | 3 384 680 | 4 024 040 | 1 095 640 (27 %) | 390 150 |
| Pronájem 36 m | 180 000 + kauce 288 500 | 86 020 (kola 63 130) | 1 257 240 | 3 411 720 + odkup 890 000 | 1 053 040 (31 %) | 390 150 |
| Zkouška → pronájem | 610 040 (záloha 252 520 předem, zbytek do 30 dnů) + kauce 288 500 | zkouška 144 260; poté 86 020 | 1 193 436 | 3 347 916 | 1 160 556 (35 %) | 390 150 |

Zkouška: 505 040 Kč za 4 měsíce, započet 176 764 Kč, odkup 2 308 000 Kč; zisk zkoušky při vrácení a ex-demo prodeji 631 390 Kč (náklady zkoušky bez kol 91 650 Kč).

<!-- Výpočet řádku „Zkouška → pronájem“ (kód: compute() pro porizeni=zkouska a porizeni=pronajem36 z test/fixtures/nabidka*.json, ukázkové nákupní ceny 18 000 / 36 000 / 64 000):
  jednorázově = souhrn.jednorazove(zkouška) + zkouska.celkem                       (penzion 25 000 + 63 984 = 88 984)
  1 rok  = jednorázově + 4 × (měsíčně zkoušky − kola zkoušky) + 8 × měsíčně pronájmu − zkouska.zapocet
           penzion: 88 984 + 4 × 900 + 8 × 9 888 − 22 394 = 149 294
           hotel:   227 016 + 4 × 6 000 + 8 × 36 142 − 70 706 = 469 446
           resort:  610 040 + 4 × 18 000 + 8 × 86 020 − 176 764 = 1 193 436
  3 roky = 1 rok + 24 × měsíčně pronájmu + 2 × roční prohlídky (1. prohlídka je v ceně zkoušky)
           penzion: 149 294 + 24 × 9 888 + 2 × 4 500 = 395 606;  hotel: 469 446 + 24 × 36 142 + 2 × 18 000 = 1 372 854;
           resort: 1 193 436 + 24 × 86 020 + 2 × 45 000 = 3 347 916
  zisk   = interni.marze zkoušky (4 měs.) − započet + 32/36 × (marže pronájmu 36 m z položek kola, web-provoz, správa, servis, pojištění, GPS měsíčně)
           + 2/3 × marže položky servis-rocne
           penzion: 50 099 − 22 394 + 32/36 × 130 140 + 2/3 × 2 025 = 144 735 (36,6 % z 395 606)
           hotel: 496 530 (36,2 %); resort: 1 160 556 (34,7 %)
  podíl partnera = jako u pronájmu 36 m (servis 36 měs. + 3 prohlídky; zkouška ho jen předplácí) -->

Zisk zkoušky při vrácení = cena zkoušky + ex-demo prodej kol (80 % prodejní ceny) − nákupní cena kol − náklady zkoušky bez kol; nákupní ceny jsou ukázkové.

**Čtení výsledků:** všechny kombinace jsou nad prahem 20 %; koupě má v ukázkových číslech marži 27–31 % (u resortu nejnižší –
velkoobjemová sleva by ji srazila k prahu, proto konfigurátor musí hlídat `prahMarzeProcent` i u slev). Pronájem váže kapitál
(penzion 264 000 Kč, hotel 836 000 Kč, resort 2 090 000 Kč v nákupních cenách; **ukázkové nákupní ceny**) a má o 4–5 procentních bodů
vyšší marži než koupě (31–36 %), absolutní zisk za 3 roky je ale o ≈ 3–4 % nižší a přidává vazbu na 3 roky a odkup kol po skončení.
Zkouška je pro klienta nejnižší vstupní práh a její zisk v řádku „zkouška → pronájem“ je srovnatelný s pronájmem (hotel a resort
mírně nad, penzion mírně pod) – za předpokladu, že ex-demo kola prodáme za ≈ 80 % prodejní ceny. Zisk zkoušky klesá s dosažitelnou
ex-demo cenou: u penzionu je 71 759 Kč při 80 %, 53 559 Kč při 75 %, 35 359 Kč při 70 %, 17 159 Kč při 65 % a nulový při ≈ 60 %
(u hotelu a resortu ≈ 58–59 %; vše s ukázkovými nákupními cenami, bod zvratu je nutné ověřit na pilotu se skutečnými cenami).
Dosažitelnou ex-demo cenu je proto nutné ověřit na pilotu dřív, než se zkouška nabídne plošně.

---

## 4. Rizika a pojistky

| Riziko | Pojistka |
|---|---|
| Klient po zkoušce vrátí kola a my je neprodáme | min. 2 kola s poplatkem za rozjezd, start do 15. 6. (celá sezóna), sazba 2× kryje depreciaci; druhý život kol u dalšího klienta; ex-demo kanál v prodejně zadavatele |
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

1. **Nákupní ceny** – dodány zadavatelem a uloženy pouze v interním souboru na serveru (mimo git); potvrdit, že jsou bez DPH, a doplnit dodací lhůty.
2. **Prodejní ceny a marži** – potvrdit návrh prodejních cen (25 / 50 / 88 tis. Kč) a minimální marži (práh 20 %), nebo zadat vlastní; ceny je třeba sladit s konkrétními modely (viz 2b).
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
11. Sladění prodejních cen tříd se skutečnou flotilou: veřejná cena konkrétních e-kol bez DPH (≈ 44–63 tis. Kč, viz 2b) je výrazně pod prodejní cenou třídy „ekolo“ (88 000 Kč); rozhodnout, zda snížit prodejní ceny tříd, nebo flotilu složit z dražších modelů, a pak přepočítat scénáře.

---

## 9. Kalkulačka návratnosti „Vyplatí se to?“ (od 7. 10. 2026)

Hotel nezajímá splátka, ale kolik vydělá. Krok 6 konfigurátoru z odhadu sezóny spočítá tržby z půjčovného, výsledek prvního
a dalších let, bod zvratu a za kolik výpůjček se zaplatí jedno kolo. Je to **odhad pro rozhodnutí, ne slib** – výsledek stojí
na vytíženosti, kterou zadává klient. Kalkulačka **nemění žádný dosavadní výpočet** (souhrn, horizonty, marže); jen z nich čte.
Je veřejná: pracuje s cenami pro klienta (`souhrn`, `porizeni.radky[].zaKolo`), nikdy s nákupními cenami ani blokem `interni`.

**Vstupy** (GET parametry, výchozí hodnoty v `config/nabidka.json` → `navratnost`; blok je volitelný – chybí-li, platí stejné
výchozí hodnoty z kódu `NAVRATNOST_VYCHOZI`; mimo rozsah se ořízne, nečíselné → výchozí):

| Parametr | Význam | Výchozí | Rozsah |
|---|---|---|---|
| `sezona` | délka sezóny ve dnech (`navratnost.sezonaDni`) | 150 | 30–365 |
| `vytizenost` | průměrná vytíženost kol v celých % (`navratnost.vytizenostProcent`; v doméně podíl 0,35) | 35 | 5–100 |
| `cena_zakladni`, `cena_trek`, `cena_ekolo` | cena půjčovného pro hosta za den v Kč **vč. DPH** (`navratnost.cenaDen`) | 390 / 450 / 890 | 0–5 000 |
| `neplatce=1` | „Nejsme plátci DPH“ | plátce | – |
| (jen config) `navratnost.dph` | sazba DPH | 0,21 | 0–99 % |

V odkazu (`inputToQuery`) jdou parametry kalkulačky vždy za `servis` a před `doplnky` (doplnky zůstávají poslední).

**Vzorce** (R = zaokrouhlení na celé Kč; `D` = dny sezóny, které období pokryje; `v` = vytíženost; `f` = 1 pro plátce, 1 + dph pro neplátce):

```
D                   = koupě, pronájem: sezonaDni;  zkouška: min(sezonaDni, zkouska.mesice × 30)
tržbaDen(třída)     = plátce: R(cenaDen / (1 + dph));  neplátce: cenaDen          // tržba bez DPH, kterou hotel skutečně má
výpůjčníDny(třída)  = R(počet kol třídy × D × v)
tržby               = Σ výpůjčníDny × tržbaDen
nákladyPrvníRok     = koupě, pronájem: R((souhrn.jednorazove + 12 × souhrn.mesicne + souhrn.rocne) × f)
                      zkouška: R(souhrn.horizonty[0].castka × f)                     // celá cena zkoušky
nákladyDalšíRoky    = koupě, pronájem: R((12 × souhrn.mesicne + souhrn.rocne) × f)   // u koupě jen provoz (web, servis, doplňky)
                      zkouška: null – po zkoušce se rozhoduje podle skutečné vytíženosti
výsledek            = tržby − náklady (první rok; další roky ročně)
průměrnáTržbaDen    = Σ (počet × tržbaDen) / počet kol                               // vážená počty kol
bodZvratu           = ceil(nákladyPrvníRok / průměrnáTržbaDen) výpůjčních dní
                      vytíženost bodu zvratu = bodZvratu / (počet kol × D)          // > 100 % = nedosažitelné
nákladNaKolo        = koupě: zaKolo (cena po slevě);  pronájem: zaKolo × 12;  zkouška: zaKolo × zkouska.mesice;  vše × f
kolo se zaplatí za  = ceil(nákladNaKolo / tržbaDen) výpůjček
pak kolo vydělá     = R(D × v) × tržbaDen − nákladNaKolo   (za sezónu; záporné → ukážeme ≈ počet sezón do zaplacení)
návratnost koupě    = R(souhrn.jednorazove × f) / (tržby − nákladyDalšíRoky)  sezón, jen když je jmenovatel kladný;
                      jinak „při zadané vytíženosti se investice nevrátí“
```

Bez kol je `navratnost = null`. Výsledek nese i použité vstupy (`navratnost.vstupy`: sezóna, vytíženost, ceny, plátce/neplátce,
sazba DPH, pokryté dny), aby šlo číslo doložit; e-mail poptávky má řádek se shrnutím a vstupy.

**Hlavní věta** v souhrnu: „Při 35 % vytíženosti vyděláte za první rok X Kč, od druhého roku Y Kč ročně.“ Při ztrátě poctivě
„…vychází první rok se ztrátou X Kč; zisk začíná od N % vytíženosti“ (N = vytíženost bodu zvratu zaokrouhlená nahoru). U zkoušky
„…vyděláte za zkoušku (4 měsíce, 120 dní sezóny) X Kč“ a místo dalších let věta, že po zkoušce se rozhodne podle skutečné vytíženosti.

Příklad (veřejný `config/nabidka.json`, penzion 2 trek + 3 e-kola, pronájem 36 m, web šablona, správa sami, vlastní servis, bez
doplňků, výchozí vstupy, plátce DPH): tržby 155 348 Kč (263 výpůjčních dní), náklady 1. roku 131 820 Kč → **+23 528 Kč**, další roky
**+38 528 Kč** ročně, bod zvratu 224 výpůjčních dní (30 % vytíženosti); trek se zaplatí za 39 výpůjček a pak vydělá 5 496 Kč za sezónu,
e-kolo za 35 výpůjček a pak 13 508 Kč.

**Co se nezapočítává:** náklady na vlastní obsluhu (recepce, výdej, mytí kol), provize platební brány a rezervačního poplatku,
spotřební díly u vlastního servisu, pojištění mimo doplněk, vratná kauce (není náklad), odkup kol na konci pronájmu ani prodejní
hodnota kol po koupi či zkoušce, sezónní výkyvy poptávky (vytíženost je průměr), zdanění zisku. U pronájmu jsou „další roky“
roky v rámci smlouvy (24 / 36 m); po skončení se náklady mění podle volby (odkup / vrácení / nová kola).

**DPH:** naše ceny jsou bez DPH. Plátce si DPH z našich faktur odečte a z půjčovného ji odvádí – počítáme proto obojí bez DPH
(tržba = cena pro hosta / 1,21). Neplátce si DPH odečíst nemůže a z půjčovného ji neodvádí – tržba je celá cena pro hosta a naše
náklady se násobí 1 + dph (× 1,21). Souhrn to uvádí v poznámce pod blokem („Částky bez DPH“ / „Neplátce DPH: tržby celé, naše ceny
včetně DPH“). Sazba DPH 21 % u půjčovného je předpoklad – ověřit s daňovým poradcem (viz kap. 4).

Novinka bez zlomu v historii: dosavadní čísla nabídky (souhrn, horizonty, interní marže, scénáře v kap. 3) se nemění; starší
uložené poptávky blok `navratnost` ve výsledku nemají.
