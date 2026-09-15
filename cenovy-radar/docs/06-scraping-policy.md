# 06 — Scraping policy Koloshop s.r.o. (návrh k schválení)

Interní pravidla pro automatizovaný sběr cen konkurence. Návrh vychází z rešerše v 02;
**před ostrým provozem schválí vedení (CEO) a doporučujeme revizi advokátem**. Verze 0.1,
15. 9. 2026.

## 1. Účel a rozsah
- Účel: **interní cenový monitoring** pro vlastní cenotvorbu (CZ, DE, AT).
- Rozsah: veřejné produktové stránky vybraných konkurentů (seznam zdrojů = tabulka v 04,
  vede se v aplikaci jako `sources`), sitemapy, veřejné strukturované údaje (JSON‑LD),
  oficiální produkty Heureky/Zboží/Google, ruční soubory (SHOPSCOUT apod.).
- Mimo rozsah: Heureka.cz web (výslovný zákaz v podmínkách), marketplace sekce s údaji
  prodejců, cokoli za přihlášením.

## 2. Právní základ
- § 39c autorského zákona (vytěžování textů a dat pro komerční účely při oprávněném přístupu
  a bez strojově čitelné výhrady), test SDEU CV‑Online (nezasahovat do návratnosti investice
  pořizovatele), § 2976 OZ (jednat v mezích dobrých mravů soutěže).
- Garant: sales manager (L. Suchan); schvaluje CEO.

## 3. Datová minimalizace
- **Povolené atributy:** URL, ID produktu / SKU konkurenta, EAN/GTIN, MPN, značka, název,
  cena (s DPH), cena před slevou, dostupnost / počet kusů / dodací lhůta, cena dopravy, čas.
- **Zakázané atributy:** popisy, fotografie, recenze a jména recenzentů, údaje prodejců,
  jakékoli osobní údaje, texty pro republikaci.

## 4. Technická pravidla
1. Před každým během načíst `robots.txt` cíle; respektovat `Disallow` pro `*` i pro náš UA
   a `Crawl-delay`; zkontrolovat `/.well-known/tdmrep.json` a hlavičku `tdm-reservation`.
   Zdroj s výhradou pro `*` se **nepoužívá**.
2. `User-Agent: KoloshopPriceBot/1.0 (+https://www.koloshop.cz/bot; pricing@koloshop.cz)`;
   na uvedené URL zveřejnit krátký popis bota a kontakt. Žádné maskování za prohlížeč.
3. Max. **1 požadavek za 2 s na doménu** (konfigurovatelně 2–5 s), **1 souběžné spojení na
   doménu**, plné běhy v okně **23:00–05:00**, přes den jen inkrementy TOP položek.
4. Podmíněné požadavky (ETag / If‑Modified‑Since), žádné stahování obrázků, skriptů, fontů.
5. Při odpovědi **403 / 429 / captcha / bot‑challenge** běh na daném zdroji okamžitě zastavit,
   zdroj pozastavit na 24 h a poslat alert; **nikdy neobcházet** (žádné proxy, rotace IP,
   řešení captchy, headless prohlížeč proti anti‑bot ochraně, login).
6. Prohlížečový režim (Playwright) je povolen jen tam, kde web běžný GET vůbec neobslouží
   (čistě JS aplikace) a zároveň **neblokuje** automatizovaný přístup; každý takový zdroj
   schvaluje vedení jmenovitě.
7. Jedna serverová IP (172.18.9.31 / firemní veřejná), žádné cizí sítě.
8. Každý běh loguje: zdroj, počet požadavků, stavové kódy, dobu trvání, chyby (`runs`).

## 5. Karta zdroje (vede se per doména v aplikaci)
URL robots.txt · zakázané cesty · sitemapa · datum poslední kontroly ToS · kontakt provozovatele
· alternativní zdroj (feed/Google Shopping) · stav (aktivní / pozastaven / zakázán) · důvod.

## 6. Retence a přístup
- Surové HTML: uchovat max. **30 dní** na interním volume kvůli re‑parsování po opravě
  parseru, pak automaticky smazat.
- Strukturované cenové řady: **24 měsíců**, poté agregovat (měsíční minimum/medián).
- Přístup: jen role pricing / vedení v aplikaci; data neopouštějí firemní infrastrukturu.

## 7. Zákaz zužitkování
Data slouží výhradně interní cenotvorbě. Nikdy se nezobrazují zákazníkům, nesdílí třetím
stranám, neprodávají a nestaví se z nich veřejný srovnávač.

## 8. Incidentní proces
Námitka provozovatele (e‑mail, cease & desist, telefon) → do **24 h** zdroj pozastavit →
informovat CEO a garanta → odpovědět provozovateli, nabídnout dohodu (feed) → obnovit jen po
souhlasu vedení a případně právníka.

## 9. Revize
Čtvrtletně: kontrola robots.txt a ToS všech zdrojů, revize seznamu zdrojů, sledování vývoje
SDEU C‑250/25 a pokynů EDPB ke scrapingu; roční revize této policy.

## 10. Audit
Souhrn běhů (požadavky/den/doména, podíl chyb, pozastavení) je součástí týdenního reportu,
aby šlo doložit slušné chování.
