# Cyklo & Ski mapa – shrnutí na jednu stránku

*Stav k 7. 10. 2026, data sestavená 3. 10. 2026. Podrobnosti: [MANUAL.md](MANUAL.md) (ovládání),
[METODIKA.md](METODIKA.md) (data a výpočty), [../NASAZENI.md](../NASAZENI.md) (provoz).*

## Co to je a k čemu slouží

**Cyklo & Ski mapa** je obchodní nástroj Koloshopu pro oslovování provozovatelů v okolí cyklotras a sjezdovek.
Je to interaktivní mapa ČR (**kraje → okresy**) se všemi značenými cyklotrasami, pojmenovanými cyklostezkami,
MTB trasami, skiareály, sjezdovkami a vleky. K nim mapa zobrazuje **místa v okolí**: penziony, hotely, chaty,
kempy, půjčovny kol a lyží, cykloprodejny, sportovní obchody a infocentra.

U každého místa je vidět **název, adresa, provozovatel, telefon, e-mail, web** a zda **provozuje půjčovnu**.
Obchodník si u místa vede **stav oslovení** čtyřmi zaškrtávátky (Chceme kontaktovat · Proběhl nabídkový e-mail ·
Volali jsme · Osobní návštěva proběhla), poznámkou a ručně doplněnými kontakty. Stav je **sdílený v týmu** přes
server a u každé změny je vidět, kdo a kdy ji udělal. Výběr (např. „ubytování do 1 km od cyklotrasy bez vlastní
půjčovny v okrese Trutnov“) jde exportovat do **CSV pro Excel**.

Aplikace běží jako web s přihlášením na **https://cyklomapa.ksprehledy.cz**, kód i data jsou v repozitáři GitHub
`ladasuchan1-cmd/Doma` ve složce `cyklo-ski-mapa/`.

## Co v mapě je

| Vrstva | Počet | Poznámka |
|---|---|---|
| Kraje / okresy | 14 / 77 | Praha je vedená jako samostatný okres |
| Cyklotrasy | 3 344 | značené trasy z OpenStreetMap (místní, regionální, dálkové, EuroVelo) |
| Cyklostezky | 517 | pojmenované samostatné stezky |
| MTB trasy | 419 | singletraily a MTB okruhy |
| Skiareály | 401 | s 1 638 sjezdovkami a 1 127 vleky |
| Místa celkem | 12 932 | 10 021 ubytování · 2 195 půjčoven a obchodů · 716 infocenter |

**Kontakty u míst:** telefon u 5 537 míst (43 %), e-mail u 4 760 (37 %), aspoň jeden kontakt u 5 692 (44 %).
Web má 5 763 míst, z toho se 4 473 podařilo automaticky načíst a vytěžit. **Půjčovna** je potvrzená u 740 míst
podle OpenStreetMap a u dalších 411 podle textu webu (309 kola, 168 lyže). 1 480 míst nemá název (např. chaty jen
s evidenčním číslem) a zobrazují se až po zapnutí filtru.

Každé místo má spočítané **nejbližší cyklotrasy do 3 km** (12 844 míst) a **skiareály do 15 km** (8 415 míst).

## Odkud se berou data

| Zdroj | Co dodává | Licence a podmínky |
|---|---|---|
| **OpenStreetMap** (přes dotazovací službu QLever osm-planet) | cyklotrasy, cyklostezky, MTB, sjezdovky, vleky, ubytování, půjčovny, obchody, infocentra včetně kontaktů, které mapéři zapsali (telefon, e-mail, web, provozovatel, půjčovna) | ODbL – zdarma, nutné uvést „© přispěvatelé OpenStreetMap“ |
| **OpenSkiMap.org** | skiareály v ČR: název, stav provozu, web, počty a délky sjezdovek podle obtížnosti, vleky | ODbL / CC BY – zdarma |
| **ČÚZK RÚIAN** (ArcGIS služba) | hranice krajů a okresů | CC BY 4.0 – zdarma, uvést zdroj |
| **Weby jednotlivých míst** | e-maily, telefony, IČO, jméno provozovatele, zmínky o půjčovně kol/lyží (úvodní stránka + až 2 kontaktní podstránky) | veřejně zveřejněné údaje firem; automatický odhad, nutno ověřit |
| **ARES** (Ministerstvo financí) | podle IČO z webu oficiální název firmy, právní forma a sídlo | veřejný rejstřík, zdarma |

Všechny zdroje jsou **veřejné a bezplatné**, aplikace nepoužívá žádné placené API ani licencované mapové podklady
(podkladová mapa je OpenStreetMap). Údaje z OSM jsou tak úplné a aktuální, jak je zapsali dobrovolníci – co v OSM
není, v mapě není.

## Je to aktualizovatelné? Ano – tři nezávislé věci

1. **Data mapy (trasy, areály, místa, údaje z webů)** se obnovují **automaticky 1. den v měsíci** workflow
   „Cyklo & Ski mapa – obnova dat“ na GitHubu: stáhne nové zdroje, projde weby míst (≈ 30 min), spustí testy,
   uloží nová data do repozitáře a nasadí je na web. Obnovu jde pustit kdykoli ručně (GitHub → Actions → Run
   workflow) nebo na počítači příkazy `npm run build-data` a `npm run enrich`. **Stav oslovení obnova nemaže** –
   je uložený zvlášť a vázaný na trvalé identifikátory míst z OpenStreetMap.
2. **Aplikace (kód)** se nasazuje sama po každém sloučení změny do hlavní větve repozitáře: GitHub spustí testy
   a přes SSH aktualizuje server na Hetzneru (≈ 2–3 minuty). Když nová verze nenaběhne, skript se sám vrátí
   k předchozí. **Uživatelé a doména** se nastavují v GitHubu (secret `HETZNER_USERS`, variable
   `CSM_HETZNER_DOMAIN`) a propíší se na server při každém nasazení.
3. **Stav oslovení** se ukládá okamžitě při každém zaškrtnutí – na server i do prohlížeče. Kolegové změny vidí
   po obnovení stránky. Server dělá **denní zálohu ve 2:30** (drží 60 posledních), ručně jde záloha stáhnout
   tlačítkem **Stav oslovení → Uložit zálohu (JSON)**.

Chybu v datech (špatný telefon, zavřený penzion) jde opravit okamžitě ručně v detailu místa – ruční zápis má
přednost před automatickými údaji a přežije obnovu dat. Trvalou opravu pro všechny je nejlepší udělat přímo
v OpenStreetMap (odkaz je u každého místa); do mapy se dostane s příští měsíční obnovou.

## Jak s tím pracovat (postup pro obchodníka)

1. **Přihlášení** na https://cyklomapa.ksprehledy.cz jménem a heslem od správce; přihlášení platí 30 dní,
   odhlášení je vpravo nahoře.
2. **Oblast**: klik na kraj, pak na okres (nebo výběr v liště nahoře); zpět drobečkovou navigací. Hledání názvu,
   obce nebo trasy – pole nahoře, klávesa `/`.
3. **Filtry vlevo**: typy míst (ubytování / půjčovny a obchody / infocentra), okolí **„u cyklotras“ (0,25–3 km)**
   nebo **„u skiareálů“ (1–15 km)**, půjčovna ano / ne / neznámo, stav oslovení (např. „Chceme kontaktovat –
   zatím neosloveno“).
4. **Detail místa** (klik na značku nebo řádek): kontakty, nejbližší trasy a areály, údaje z webu, odkazy na
   Google, Firmy.cz, Mapy.cz a ARES. Tlačítko **Převzít do kontaktů** doplní prázdná pole údaji z webu.
5. **Stav oslovení**: zaškrtnout fázi (Chceme kontaktovat → Proběhl nabídkový e-mail → Volali jsme → Osobní
   návštěva proběhla), napsat poznámku „kdo, kdy, co domluveno“. Ukládá se hned, s datem, časem a jménem.
6. **Tabulka** (tlačítko nahoře): řazení kliknutím na záhlaví, zaškrtávátka stavů rovnou v řádcích,
   **Export CSV** aktuálního výběru do Excelu (oddělovač `;`, čeština v pořádku).
7. **Odkaz kolegovi**: adresa v prohlížeči nese kraj, okres i vybrané místo – stačí ji zkopírovat.

## Provoz, přístup a bezpečnost

- **Kde běží:** server Hetzner Cloud (`37.27.203.154`, Ubuntu, Docker). Dva kontejnery – aplikace (Node.js 22,
  bez závislostí) a Caddy, která sama obstarává HTTPS certifikát. Web je na **https://cyklomapa.ksprehledy.cz**
  (DNS záznam A domény míří přímo na server, správa DNS je u Cloudflare). Případná další změna domény = nový
  A záznam + změna variable `CSM_HETZNER_DOMAIN` v GitHubu + Run workflow.
- **Kdo se dostane dovnitř:** jen přihlášení uživatelé. Hesla jsou v GitHub secretu `HETZNER_USERS`; přidání
  nebo změna = upravit secret a spustit workflow „Cyklo & Ski mapa“. Bez přihlášení je vidět jen přihlašovací
  formulář, po 10 špatných pokusech se adresa na 15 minut zablokuje.
- **Co je veřejné a co ne:** kód a mapová data jsou ve veřejném repozitáři na GitHubu (jsou to veřejná data
  z OSM). **Stav oslovení, poznámky a ruční kontakty** jsou jen na serveru v souboru `stav.json` (Docker volume),
  do repozitáře nikdy nejdou.
- **Zálohy:** denně 2:30 na serveru do `/opt/zalohy-cyklo-ski-mapa` (60 kopií), k tomu případné Hetzner Backups
  serveru. Obnova = nahrát soubor zpět (`deploy/hetzner.sh zpet`, viz NASAZENI.md).
- **Náklady:** jen měsíční cena serveru Hetzner; žádné placené API, licence ani mapové podklady.
- **Správa na serveru** (`ssh agent@37.27.203.154`):
  `sudo bash /opt/Doma/cyklo-ski-mapa/deploy/hetzner.sh stav | log | zaloha | zpet | aktualizace`.
  Stav aplikace a verzi hlásí `/api/health`.

## Omezení a na co dát pozor

- **Úplnost odpovídá OpenStreetMap.** Penzion, který v OSM není, v mapě chybí. Kontakt (telefon nebo e-mail) je
  u 44 % míst; u ostatních pomohou odkazy v detailu (Google, Firmy.cz, ARES).
- **Zhruba pětina webů** (1 290 z 5 763) se automaticky načíst nedala – blokují roboty, neexistují nebo
  neodpovídají.
- **„Půjčovna podle webu“ je odhad** z textu stránky (web zmiňuje půjčovnu kol nebo lyží). Před nabídkou ověřit;
  v detailu jde přepsat na ano/ne.
- **E-maily jsou z veřejných webů firem.** Při hromadném rozesílání nabídek platí pravidla pro obchodní sdělení
  (zákon č. 480/2004 Sb.) – posílat adresně, s možností odmítnutí.
- **Doména:** do 7. 10. 2026 web běžel na dočasné adrese `37-27-203-154.sslip.io`, od přepnutí na
  `cyklomapa.ksprehledy.cz` staré odkazy a záložky nefungují a každý se jednou znovu přihlásí.
- **Hlavní větev repozitáře** se jmenuje `claude/terms-reader-app-dl4h8h`; doporučeno přejmenovat na `main`
  (GitHub → Settings → Branches). Workflow i skripty si název zjišťují samy, přejmenování nic nerozbije.
- **Historie stavu** se nevede – u každé fáze je uložené datum zaškrtnutí a poslední úprava (kdo, kdy), ne celý
  průběh. Denní zálohy ale umožňují vrátit se ke stavu k danému dni.
- **Hesla** jsou v `.env` na serveru v otevřené podobě (jako u R01 Sales) – soubor je čitelný jen pro root.

## Odkazy

- **Aplikace:** https://cyklomapa.ksprehledy.cz (stav a verze: `/api/health`)
- **Repozitář:** https://github.com/ladasuchan1-cmd/Doma – složka `cyklo-ski-mapa/`
- **Dokumentace:** [README.md](../README.md) (přehled a spuštění), [MANUAL.md](MANUAL.md) (manuál pro obchodní
  tým), [METODIKA.md](METODIKA.md) (zdroje dat, klasifikace, výpočty), [NASAZENI.md](../NASAZENI.md) (nasazení
  a provoz)
- **Automatizace:** GitHub → Actions → „Cyklo & Ski mapa“ (testy + nasazení), „Cyklo & Ski mapa – obnova dat“
  (měsíční obnova)
- **Zdroje dat:** [OpenStreetMap](https://www.openstreetmap.org/copyright) · [QLever osm-planet](https://qlever.dev/osm-planet)
  · [OpenSkiMap](https://openskimap.org/) · [ČÚZK RÚIAN](https://ags.cuzk.cz/arcgis/rest/services/RUIAN/MapServer)
  · [ARES](https://ares.gov.cz/)
