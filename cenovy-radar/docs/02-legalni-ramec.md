# 02 — Právní a etický rámec monitoringu cen konkurence

> Rešerše (web, judikatura, dokumentace nástrojů), **ne právní stanovisko**. Body označené ⚠️
> jsou právně nejisté nebo se opírají o judikaturu přenositelnou jen analogicky. Před ostrým
> nasazením doporučujeme nechat dokument 06 (Scraping policy) zkontrolovat advokátem se
> zaměřením na IT/IP právo. Stav k 15. 9. 2026.

**Shrnutí v jedné větě:** automatizované čtení *veřejně přístupných* cen, dostupnosti a
identifikátorů produktů z konkurenčních e‑shopů je v ČR/EU legální „šedě‑bílá“ zóna; rizikem
není samotné čtení ceny, ale (a) obcházení technických zábran, (b) systematické zkopírování
podstatné části databáze konkurenta, (c) porušení obchodních podmínek, které jsme prokazatelně
akceptovali, a (d) nadměrná zátěž serveru.

## 1. Právní rámec EU a ČR

### 1.1 Zvláštní právo pořizovatele databáze (směrnice 96/9/ES, § 88–94 AZ)

Katalog e‑shopu (produkty, ceny, dostupnost) je téměř vždy „databází“ ve smyslu § 88 autorského
zákona (121/2000 Sb.). Chráněn je ale jen pořizovatel, který prokáže **podstatný vklad do
pořízení, ověření nebo předvedení obsahu**, ne vklad do *vytvoření* dat samotných (SDEU *BHB v.
William Hill* C‑203/02, *Fixtures Marketing*). ⚠️ Zda vlastní ceníky e‑shopu splňují „podstatný
vklad“, je sporné; u agregátorů typu Alza/Heureka spíše ano.

Klíčová judikatura SDEU:
- **Innoweb v. Wegener (C‑202/12, 2013)** — metavyhledávač, který v reálném čase prohledával
  celou databázi inzerátů (~100 000 dotazů denně) a výsledky zobrazoval uživatelům, „zužitkoval“
  podstatnou část databáze → porušení. Lekce: nebýt „parazitní alternativou“ k webu konkurenta,
  nezpřístupňovat data veřejnosti.
- **CV‑Online Latvia v. Melons (C‑762/19, 2021)** — zásadní zmírnění: vytěžování lze zakázat jen
  tehdy, pokud **ohrožuje návratnost podstatného vkladu** pořizovatele; váží se zájem pořizovatele
  proti zájmu konkurentů a uživatelů na přístupu k informacím. Interní cenový monitoring, který
  nekonkuruje webu konkurenta jako zdroj informací pro zákazníky, tento test s vysokou
  pravděpodobností projde.
- **Ryanair v. PR Aviation (C‑30/14, 2015)** — pokud databáze *není* chráněna, neplatí kogentní
  ochrana „oprávněného uživatele“ a provozovatel **může scraping zakázat smluvně** (obchodními
  podmínkami).
- Německý BGH *Automobil‑Onlinebörse* (I ZR 159/10, 2011): jednotlivé dotazy na nepodstatné části
  databáze neporušují právo pořizovatele, i když jsou automatizované; problém je až kumulativní
  rekonstrukce celé databáze.

**Dopad na nás:** stahovat **pouze nepodstatnou část** (cena + dostupnost + ID u spárovaných SKU,
ne celý katalog s popisy a obrázky) a **nezveřejňovat** ji. Tím se držíme mimo Innoweb a uvnitř
CV‑Online.

### 1.2 Výjimka pro vytěžování textů a dat (DSM směrnice 2019/790 čl. 4; § 39c AZ)

§ 39c AZ (účinný od 5. 1. 2023) dovoluje **komukoli, i pro komerční účely**, zhotovit rozmnoženinu
díla i databáze za účelem automatizované analýzy, pokud (a) má k obsahu **oprávněný přístup**
(veřejně dostupná stránka), (b) nositel práv **si užití výslovně nevyhradil** u online obsahu
„strojově čitelnými prostředky“, (c) rozmnoženiny se uchovají jen po dobu nezbytnou. ⚠️ Zda
obchodní podmínky fungují jako *výhrada práv*, je nevyjasněné.

„Strojově čitelná výhrada“ = prakticky **robots.txt** (RFC 9309), **TDMRep**
(`/.well-known/tdmrep.json`, hlavička `tdm-reservation: 1`), případně `ai.txt`. Nizozemský soud
v *DPG Media v. HowardsHome* (10/2024) rozhodl, že komerční monitoring spadá pod výjimku a
**výhrada v obchodních podmínkách nestačila**. ⚠️ Prvoinstanční; otázka je u SDEU (*Like Company
v. Google*, C‑250/25, rozsudek se čeká).

**Závěr:** pokud konkurent v robots.txt nezakazuje náš user‑agent (ani `*`) na produktových URL a
nemá TDMRep výhradu, máme silný argument, že jednáme v mezích § 39c.

Kontrola robots.txt cílů (15. 9. 2026): **kupkolo.cz** — `*` zakazuje jen `/uzivatel/`,
`/graphql`, `/prihlaseni/`, `/registrace/`; produktové stránky volné, sitemap k dispozici.
**bikero.cz** — zakázáno jen hledání, objednávka, admin. **sportisimo.cz** — zakázány filtry
(parametry `cena-od=`, `znacka[]=`…), `/dostupnost-produktu/`, `/porovnani-produktu/`.
**bike‑discount.de** — zakázán `/search`, `/detail/`, stránkování; explicitní skupina pro AI
boty; 12 sitemap vč. CS. Nikde není `Crawl-delay`. **alza.cz** — robots.txt i podmínky vrací 403
(Cloudflare). Podrobněji per zdroj v 04.

### 1.3 Obchodní podmínky (browsewrap vs. clickwrap)

- **Clickwrap** (aktivní souhlas při registraci/objednávce) je vymahatelný; **browsewrap**
  (podmínky jen odkazem v patičce) je slabý, ale po *Ryanair v. PR Aviation* nelze vyloučit
  vymáhání, pokud jsme s podmínkami byli prokazatelně seznámeni. *Meta v. Bright Data* (2024):
  scraping **veřejných** stránek **bez přihlášení** nebyl porušením ToS.
- **Heureka.cz** má v podmínkách výslovný zákaz „softwarových robotů, crawlerů, scraperů…“ →
  Heureku **nescrapovat**, jít přes oficiální produkty.
- **Neuzavírat na konkurenčních webech účty** pro účely scrapingu (tím bychom clickwrap přijali).

### 1.4 Nekalá soutěž (§ 2976 a násl. OZ)

Sledování veřejných cen konkurence je standardní soutěžní praxe. Rizikové skutkové podstaty:
**parazitování** (§ 2982 — převzetí cizího katalogu, fotek, popisů), **zlehčování**, nekalé
**přetěžování** serveru. BGH *Flugvermittlung im Internet* (I ZR 224/12, 2014): screen scraping
veřejných dat není nekalá překážka soutěži; kdo nabízí veřejně na internetu, musí počítat
s automatizovaným čtením. ⚠️ Českou judikaturu přímo k cenovému scrapingu jsme nenašli.

### 1.5 Trestní právo (§ 230, § 231 TZ)

§ 230 odst. 1 TZ: „Kdo překoná bezpečnostní opatření, a tím neoprávněně získá přístup
k počítačovému systému…“ Judikatura NS (8 Tdo 450/2024): i nízká úroveň zabezpečení stačí,
rozhodující je úmyslné překonání.
- Čtení veřejné HTML stránky bez zábran → **není** překonání bezpečnostního opatření.
- **Řešení CAPTCHA, obcházení Cloudflare/Datadome challenge, rotace rezidenčních proxy k obejití
  blokace IP, cizí login, přístup do cest zakázaných v robots.txt** → ⚠️ šedá až černá zóna,
  s § 231 (opatření nástrojů) teoreticky trestné.
- *Ryanair v. Booking.com* (USA): porota uznala porušení CFAA kvůli přístupu do přihlášené sekce
  přes třetí stranu (verdikt později zrušen pro neprokázání škody); *hiQ v. LinkedIn*: veřejná
  data bez loginu nejsou „bez oprávnění“, hiQ přesto prohrálo na smluvním základě.

### 1.6 GDPR

Cena, dostupnost, EAN, název produktu **nejsou osobní údaje**. Osobní údaje mohou být jména
recenzentů, jména prodejců‑OSVČ na marketplace, kontaktní osoby. EDPB (pokyny 03/2026 ke
scrapingu, návrh) zdůrazňuje, že „veřejně dostupné“ není výjimka. **Recenze a jména prodejců
nestahovat vůbec.**

### 1.7 DMA / Data Act

Data Act se na scraping e‑shopů nevztahuje. DMA nutí Google sdílet vyhledávací data
s konkurenčními vyhledávači; pro e‑shop bez přímého užitku, nepřímo znamená, že Google Shopping
zůstává robustním veřejným zdrojem cen.

## 2. Praxe trhu a SaaS poskytovatelé

- **Disivo** (nástroj Azor koupený od Heureka Group) uvádí jako zdroje weby konkurence
  a distributorů, Google Shopping, Heureku, Amazon, Idealo.
- **Price2Spy**: „ceny jsou veřejné pro každého návštěvníka, včetně botů; právně není rozdíl mezi
  ručním opsáním do Excelu a automatizací.“ **Prisync**: legální, protože čte jen veřejně dostupné
  ceny. **PriceShape**: primárně Google Shopping feedy a marketplace, ne crawling. **Dealavo**:
  scraping + ruční QA. **Minderest**: deklaruje GDPR compliance.
- Celý trh staví na stejné tezi: veřejná data, bez loginu, bez obcházení. Nikdo neuvádí soudní
  spor v ČR. Použití SaaS **nepřenáší** odpovědnost objednatele, jen rozkládá riziko.

## 3. Pravidla „slušného scrapingu“

1. **robots.txt**: před každým během načíst, respektovat `Disallow` pro `*` i pro náš UA;
   `Crawl-delay` brát jako závazný; neprocházet zakázané cesty.
2. **Rychlost**: max **1 požadavek / 2–5 s na host**, jedno souběžné spojení na host; ne
   kontinuální crawl.
3. **Identifikace**: `User-Agent: KoloshopPriceBot/1.0 (+https://www.koloshop.cz/bot;
   pricing@koloshop.cz)`; žádné maskování za prohlížeč, žádné rotující proxy.
4. **Čas**: noc/brzké ráno (01–06 h), mimo špičku a kampaně konkurenta.
5. **Cache a podmíněné požadavky**: `If-Modified-Since`/ETag; ne obrázky, ne JS.
6. **Žádné obcházení**: při 403/429/CAPTCHA/challenge **zastavit** a zdroj přepnout na
   alternativu. Žádný login, žádné účty.
7. **Minimalizace dat**: jen URL, ID/EAN, název, cena, dostupnost, čas.
8. **Nezveřejňovat**: data pouze interně pro cenotvorbu (Innoweb).
9. **Retence**: surové HTML smazat po extrakci (§ 39c „po dobu nezbytnou“); cenové řady max.
   24 měsíců.
10. **Reakce na námitku**: cease & desist → zdroj okamžitě pozastavit, řešit dohodou.

## 4. Alternativy bez scrapingu

| Zdroj | Co dá | Poznámka |
|---|---|---|
| Heureka — oficiální nástroje | ceny konkurentů u spárovaných produktů | zpoplatněno; podmínky zakazují scraping webu |
| Zboží.cz | přehled nabídek u produktu | ⚠️ veřejné API pro konkurenční ceny nenalezeno |
| Google Shopping / Merchant Center | „price competitiveness“ report, veřejné listingy | nejméně rizikový, zdroj PriceShape i Disiva |
| Sitemapy konkurence | seznam produktových URL | snižuje počet dotazů |
| Shopify `/products.json` | strukturovaný katalog | jen u Shopify obchodů |
| SaaS (Disivo, Price2Spy, Prisync, Dealavo, Competera, Minderest) | hotová data + párování | náklady vs. přenesené technické riziko |
| Feedy distributorů / DMOC ceníky | doporučené ceny | legální základ pro DE–CZ srovnání |

## 5. Checklist „Co smíme / co nesmíme“

**Smíme (nízké riziko):** číst veřejné produktové stránky bez přihlášení v mezích robots.txt;
ukládat cenu, dostupnost, ID/EAN, název, URL, čas pro spárované SKU; používat sitemapy, Google
Shopping, oficiální produkty Heureky/Zboží, SaaS; interně odvozovat vlastní ceny.

**Smíme s opatrností (⚠️):** stahovat větší část katalogu jednoho konkurenta (test CV‑Online);
pokračovat u webu, jehož ToS scraping zakazují, ale nepřijali jsme je kliknutím a robots.txt
nezakazuje — při výzvě přestat.

**Nesmíme (vysoké riziko):** obcházet CAPTCHA, Cloudflare/Datadome, IP bany, rate‑limity; maskovat
UA, rotovat proxy (§ 230/231 TZ); přihlašovat se / zakládat účty; číst B2B ceníky za loginem;
scrapovat Heureka.cz a weby s výhradou pro `*`; stahovat recenze, jména, fotky, texty;
zveřejňovat nebo prodávat data; přetěžovat servery.

## Zdroje

- SDEU C‑30/14 Ryanair v. PR Aviation: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex%3A62014CJ0030
- SDEU C‑202/12 Innoweb v. Wegener: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex%3A62012CJ0202
- SDEU C‑762/19 CV‑Online Latvia v. Melons: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex:62019CJ0762 ; https://www.akcisek.cz/blog/aktualni-judikatura-sdeu-zmeny-ve-vytezovani-obsahu-databaze
- DSM čl. 3–4: https://legalblogs.wolterskluwer.com/copyright-blog/the-new-copyright-directive-text-and-data-mining-articles-3-and-4/ ; TDMRep: https://w3c.github.io/cg-reports/tdmrep/CG-FINAL-tdmrep-20220216/
- Novela AZ 2023 (§ 39c/39d): https://www.pravniprostor.cz/clanky/obcanske-pravo/novela-autorskeho-zakona-cast-i ; https://www.peytonlegal.cz/novela-autorskeho-zakona/
- DPG Media v. HowardsHome: https://ipkitten.blogspot.com/2025/02/dutch-court-holds-that-tdm-opt-out-must.html
- Like Company v. Google C‑250/25: https://www.twobirds.com/en/insights/2026/like-company-v-google-cjeu-holds-first-ever-hearing-on-generative-ai-and-copyright-on-10-march-2026
- Lupa.cz: https://www.lupa.cz/clanky/vsichni-to-delaji-nikdo-nevi-jak-spravne-stahovani-informaci-z-internetu-je-v-evrope-jeste-seda-zona/
- Web scraping v ČR: https://akmjartan.cz/blog/web-scraping-pravni-pohled/ ; https://legalpartners.cz/vytezovani-webovych-stranek
- Nekalá soutěž: https://www.businessinfo.cz/navody/nekala-soutez-ppbi/
- § 230 TZ, NS 8 Tdo 450/2024: https://www.judikaty.info/cz/nejvyssi-soud-ceske-republiky/neopravneny-pristup-k-pocitacovemu-systemu-a-nosici-informaci/
- BGH I ZR 224/12: https://www.bundesgerichtshof.de/SharedDocs/Pressemitteilungen/DE/2014/2014069.html ; BGH I ZR 159/10: https://dejure.org/dienste/vernetzung/rechtsprechung?Text=I+ZR+159%2F10
- Meta v. Bright Data: https://www.fbm.com/publications/major-decision-affects-law-of-scraping-and-online-data-collection-meta-platforms-v-bright-data/
- hiQ v. LinkedIn: https://www.zwillgen.com/alternative-data/hiq-v-linkedin-wrapped-up-web-scraping-lessons-learned/
- Ryanair v. Booking.com: https://www.eff.org/deeplinks/2025/07/ryanairs-cfaa-claim-against-bookingcom-has-nothing-do-actual-hacking
- EDPB scraping: https://www.edpb.europa.eu/system/files/2026-07/edpb_guidelines_2020603_webscraping_v1_en_0.pdf
- Heureka podmínky: https://www.heureka.cz/a/podminky-pouzivani-internetovych-stranek-c-30309/
- Disivo/Azor: https://heureka.group/cz-cs/o-nas/tiskove-centrum/tiskove-zpravy/cesky-startup-disivo-kupuje-nastroj-na-monitoring-konkurence-od-heureka-group-a-zrychluje-expanzi-do-zapadni-evropy/
- Price2Spy: https://www.price2spy.com/blog/is-web-crawling-legal-lets-explain/ ; Prisync: https://prisync.com/price-scraping-software/
- robots.txt ověřeno 15. 9. 2026: kupkolo.cz, bikero.cz, sportisimo.cz, bike‑discount.de (alza.cz 403)
