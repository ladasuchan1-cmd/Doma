# 🚲 Kolomapa

Jednou denně projde inzeráty kol na **Bazoši** (Sbazar, Cyklobazar a Aukro jdou zapnout – viz
[Zdroje, šetrnost a pravidla](#zdroje-šetrnost-a-pravidla)), ukáže je na **mapě ČR po krajích**, u každého si vezme **jednu fotku a všechno, co o kole píše prodávající**, a **nacení tržní hodnotu**.
Výhodné nabídky (cena pod odhadem) jsou zeleně, u každého kola je i **doporučená maximální výkupní cena** pro obchod.

- Kliknutím na kraj se mapa přiblíží a ukáže piny přesně tam, kde kolo je (podle souřadnic / PSČ / obce z inzerátu).
- Vpravo seznam s filtry (zdroj, typ kola, cena, jen výhodné, jen nové) a řazením (nejvýhodnější, nejnovější …).
- Detail: fotka, cena, odhad s rozpětím a vysvětlením „proč“, značka/model/rok/velikost/motor…, odkaz na inzerát.
- Odhad ceny se **učí z trhu** (tisíce inzerátů, srovnatelné nabídky) a **kalibruje na vlastní prodeje obchodu**
  (`training/koloshop-prodeje.json`). S klíčem k Claude API umí nacenit i **podle fotky** (stav kola, výbava).
- Přesnost (ověřeno na 22 866 kolech z Bazoše): u kol, ke kterým existují aspoň 3 podobné inzeráty, se odhad typicky
  trefí do ~26 %, u vlastních prodejů BAZAR do ~27 %; u obecných inzerátů bez značky („Dámské kolo“) je jen orientační.
  Rozpětí odhadu obsahuje skutečnou cenu zhruba v 80 % případů. Měření: `node tools/eval-pricing.js`.

## Spuštění

Potřebujete jen **Node.js 22.13 nebo novější** (https://nodejs.org → LTS). Žádná databáze ani `npm install` navíc.

- **Windows:** dvojklik na `start.cmd` – podrobně v části [Windows – krok za krokem](#windows--krok-za-krokem).
- **macOS / Linux / příkazová řádka:** ve složce `kolomapa` spusťte `npm start` a otevřete http://localhost:8090.

**První stahování** začne samo pár sekund po startu a trvá **2–3 hodiny** (přes 30 tisíc inzerátů; detaily se dočítají
i další dny). Mapa se naplní, až doběhne – do té doby je nahoře stav „Stahuji…“. Pak se stahuje každý den v 05:30
(jen novinky a změny, pár minut; jednou týdně celý výpis kvůli prodaným kolům, asi 40 minut); když počítač v tu dobu
neběží, stáhne se po příštím spuštění. Tlačítkem
**Stáhnout teď** lze stahování spustit kdykoli ručně.

## Windows – krok za krokem

1. **Node.js:** na https://nodejs.org stáhněte verzi **LTS** (Windows Installer) a nainstalujte ji s výchozími volbami.
2. **Kolomapa:** na GitHubu repozitáře *Code → Download ZIP*; před rozbalením na ZIP klikněte pravým tlačítkem →
   *Vlastnosti → Odblokovat* (Windows se pak u `start.cmd` nebude ptát). Rozbalte např. do `C:\Kolomapa` – Kolomapa je
   ve složce `kolomapa`. **Ne** do OneDrive / Dropboxu (synchronizace databázi zamyká a může ji poškodit) ani do
   „Program Files“.
3. **Spuštění:** dvojklik na `start.cmd` (zeptá-li se Windows na bezpečnost, zvolte *Spustit*, příp. *Další informace →
   Přesto spustit*). Otevře se okno Kolomapy a mapa v prohlížeči. **Okno nechte otevřené** (stačí minimalizovat) –
   jeho zavřením se Kolomapa ukončí. Další dvojklik na `start.cmd` jen otevře mapu.
4. **Po zapnutí počítače automaticky:** `Win+R` → `shell:startup` → Enter; do otevřené složky přetáhněte `start.cmd`
   pravým tlačítkem myši a zvolte *Vytvořit zástupce*. Kolomapa se pak spustí po přihlášení do Windows.
5. **Nastavení:** soubor `nastaveni.txt` ve složce `kolomapa` (při prvním spuštění ho `start.cmd` vytvoří ze vzoru
   `nastaveni-vzor.txt`). Otevřete ho Poznámkovým blokem, u řádku smažte `#`, uložte a Kolomapu spusťte znovu.
   Překlep nebo neplatnou hodnotu Kolomapa ohlásí v okně („Nastavení: …“) a použije výchozí.
6. **Z jiných počítačů v obchodě:** v `nastaveni.txt` nastavte `KOLOMAPA_HOST=0.0.0.0` a `KOLOMAPA_PASSWORD=…`, na dotaz
   brány firewall povolte přístup v soukromé síti; adresa je `http://<jméno-počítače>:8090`.

**Stahování bez otevřeného okna (Plánovač úloh).** `stahnout.cmd` stáhne a nacení inzeráty a skončí; výstup zapisuje
do `data\stahovani.log`. Úlohu vytvoříte v PowerShellu (upravte cestu):

```powershell
$cmd = "C:\Kolomapa\kolomapa\stahnout.cmd"
Register-ScheduledTask -TaskName "Kolomapa" -Action (New-ScheduledTaskAction -Execute $cmd) `
  -Trigger (New-ScheduledTaskTrigger -Daily -At 05:30) `
  -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 4))
```

Nebo ručně: *Plánovač úloh → Vytvořit základní úlohu → Denně 5:30 → Spustit program → `stahnout.cmd`*, pak ve
vlastnostech úlohy zaškrtněte *Spustit úlohu co nejdříve po zmeškaném naplánovaném spuštění*. Mapu pak prohlížíte přes
`start.cmd` s `KOLOMAPA_SCHEDULE=off` a `KOLOMAPA_RUN_ON_START=0` v `nastaveni.txt` (jinak by stahoval i on). Plánovač
počítá s místním časem (i letním); výsledek posledního spuštění `0x1` = chyba – podrobnosti na konci
`data\stahovani.log`.

## Řešení potíží

| Hláška / příznak | Co s tím |
|---|---|
| „Chybi Node.js“ / „node není rozpoznán…“ | Nainstalujte Node.js LTS, zavřete okno a spusťte `start.cmd` znovu (příp. restart počítače). |
| „Kolomapa potřebuje Node.js 22.13 nebo novější“ | Nainstalujte aktuální LTS z https://nodejs.org (stará verze se nahradí). |
| „Port … už používá jiný program“ / „Port je obsazený“ | V `nastaveni.txt` nastavte jiný port, např. `KOLOMAPA_PORT=8091`. |
| Mapa je prázdná, „Zatím žádné inzeráty“ | První stahování ještě běží (stav nahoře) – trvá 2–3 h. Neběží-li, klikněte na *Stáhnout teď*. |
| „Nefunguje internet nebo překlad adres“ (ENOTFOUND) | Zkontrolujte připojení; další běh to zkusí znovu. |
| „Web stahování dočasně blokuje“ (HTTP 403/429, captcha) | Nic nedělejte, zkusí se zítra. Opakuje-li se, nastavte `KOLOMAPA_DELAY_MS=3000`. |
| „HTTPS přerušil antivir nebo firewall“ | V antiviru povolte výjimku pro `node.exe`. |
| „Už běží jiné stahování“ | Stahuje server i Plánovač úloh zároveň – nechte jen jedno. Po pádu počítače smažte `data\kolomapa.db.run-lock`. |
| „database is locked“ | Neběží Kolomapa dvakrát nad stejnou složkou? Neleží v OneDrive / Dropboxu? |
| „Databáze je poškozená“ / „file is not a database“ | Zavřete Kolomapu, přejmenujte `data\kolomapa.db` (inzeráty se stáhnou znovu, vlastní prodeje zůstávají v `training/`). |
| „Cyklobazar potřebuje prohlížeč“ | Viz [Cyklobazar a AI nacenění](#cyklobazar-a-ai-nacenění--volitelné-doplňky), nebo Cyklobazar ze `KOLOMAPA_SOURCES` vyřaďte. |
| Kolomapa „zamrzla“, v titulku okna je „Vybrat“ | Do okna se kliklo a Windows program pozastavil – klikněte do okna a stiskněte Esc. |
| Časy v okně nesedí s hodinami | Řádky logu mají čas v UTC (o 1–2 h méně); souhrn stahování a plán jsou v místním čase. |
| `data\stahovani.log` má rozsypanou diakritiku | Otevřete ho Poznámkovým blokem (soubor je v UTF-8), ne příkazem `type`. |

## Cyklobazar a AI nacenění – volitelné doplňky

```bash
cd kolomapa
npm install                    # nainstaluje volitelné balíčky: playwright (prohlížeč pro Cyklobazar) a @anthropic-ai/sdk
npx playwright install chromium
```

Bez nich aplikace běží dál – jen bez Cyklobazaru a bez AI nacenění. AI zapne `ANTHROPIC_API_KEY` v `nastaveni.txt`.

**Cyklobazar** se chrání službou Cloudflare: obyčejné stahování odmítá a i skutečný prohlížeč po pár rychlých
dotazech zastaví ověřením „Potvrďte, že jste člověk“. Kolomapa proto Cyklobazar čte jen na vyžádání
(`KOLOMAPA_SOURCES=bazos,cyklobazar`), přes obyčejný Chromium **bez jakéhokoli maskování**, velmi pomalu
(1 stránka za 20 s, denně jedna sitemapa + nové inzeráty) a při první výzvě k ověření se na 12 hodin zastaví – ověření
nikdy neobchází. Spolehlivější cesta je požádat Cyklobazar o datový export / spolupráci.

## Jednorázový běh (cron) a statická verze

```bash
npm run run            # stáhne, nacení a skončí (cron; ve Windows stahnout.cmd)
npm run export         # vyrobí statickou mapu do dist/ (lze nahrát na libovolný web)
npm run run-export     # obojí najednou
node tools/run.js --help
```

Návratový kód `tools/run.js`: 0 = v pořádku / částečně, 1 = chyba, žádný web se nepodařilo stáhnout nebo už běží
jiné stahování (server a `tools/run.js` sdílejí zámek `data/kolomapa.db.run-lock`).

**GitHub Actions:** workflow `.github/workflows/kolomapa-denne.yml` umí totéž každý den na serverech GitHubu a mapu
zveřejnit na GitHub Pages. **Je vypnuté** – zapíná se proměnnou repozitáře `KOLOMAPA_PAGES=true` (Settings → Secrets
and variables → Actions → Variables) a v Settings → Pages volbou *Source: GitHub Actions*. Pozor: repozitář je veřejný,
takže i mapa s inzeráty a odhady by byla veřejná. Statická verze proto ve výchozím stavu **neobsahuje** max. výkupní
ceny, poznámky AI ani kalibraci na vlastní prodeje (`npm run export -- --interni` / `KOLOMAPA_STATIC_INTERNAL=1` je
ponechá – jen pro neveřejné umístění, např. sdílený disk). Plánované běhy GitHub spouští **jen z výchozí větve**
repozitáře a po 60 dnech bez commitu je sám vypne (znovu zapnout v záložce Actions). Databáze se mezi běhy přenáší
v cache Actions; první běh stáhne 1 500 detailů na web (`KOLOMAPA_MAX_DETAILS`), zbytek dočte další dny.

## Nastavení

Ve Windows v souboru `nastaveni.txt` (řádky `KLÍČ=hodnota`), jinde i jako proměnné prostředí (ty mají přednost).

| Proměnná | Význam | Výchozí |
|---|---|---|
| `KOLOMAPA_PORT` | port | `8090` |
| `KOLOMAPA_HOST` | `0.0.0.0` = přístupné z celé sítě (pak nastavte i heslo) | `127.0.0.1` |
| `KOLOMAPA_PASSWORD` | heslo do aplikace (HTTP Basic) | – |
| `KOLOMAPA_SOURCES` | zdroje, např. `bazos,cyklobazar` nebo `all` (proč jen Bazoš – viz [Zdroje](#zdroje-šetrnost-a-pravidla)) | `bazos` |
| `KOLOMAPA_SCHEDULE` | čas denního běhu `HH:MM` (místní čas), `off` = vypnout | `05:30` |
| `KOLOMAPA_RUN_ON_START` | `0` = po spuštění nestahovat (jinak stáhne, pokud dnes ještě nestahoval) | `1` |
| `KOLOMAPA_DELAY_MS` | pauza mezi dotazy na jeden web | `1200` |
| `KOLOMAPA_FULL_SCAN_DAYS` | jak často projít výpis celý (odhalí prodaná kola), ve dnech | podle zdroje (Bazoš 7, ostatní 1) |
| `KOLOMAPA_USER_AGENT` | jak se Kolomapa webům představuje | `Mozilla/5.0 (compatible; Kolomapa/1.0; +odkaz na projekt)` |
| `KOLOMAPA_MAX_DETAILS` | max. detailů inzerátů na zdroj za běh | podle zdroje (Bazoš 4000, Sbazar 2000, Aukro 300, Cyklobazar 120; Cyklobazar nikdy víc než 300) |
| `KOLOMAPA_CYKLOBAZAR_DELAY_MS` | pauza mezi stránkami Cyklobazaru (nejméně 10 s) | `20000` |
| `KOLOMAPA_CYKLOBAZAR_MAX_LIST_PAGES` | max. stránek výpisu Cyklobazaru za běh (celý výpis ~445 stránek se projde postupně) | `60` |
| `KOLOMAPA_DB` | soubor databáze (relativní cesta = vůči složce `kolomapa`) | `data/kolomapa.db` |
| `ANTHROPIC_API_KEY` | zapne AI nacenění podle fotek | – |
| `KOLOMAPA_AI_MODEL` | model pro AI nacenění | `claude-opus-5-5` |
| `KOLOMAPA_AI_MAX_PER_RUN` | max. AI nacenění za den (hlídá útratu) | `150` |
| `KOLOMAPA_BUY_MARGIN` | cílová marže při výkupu, např. `35 %` (jinak z vlastních prodejů, ~35 %) | – |
| `KOLOMAPA_STATIC_INTERNAL` | `1` = statická verze ponechá výkupní ceny a poznámky AI (jen pro neveřejné umístění) | `0` |

Úplný seznam je v `src/config.js`.

## Vlastní prodeje = učení modelu

Model se kalibruje na skutečné prodeje obchodu. Nový export z POHODY (pohyby skladu – prodejky a vydané faktury,
uložený jako sešit Excelu `.xlsx`) přidáte příkazem ve složce `kolomapa` (cestu s mezerami dejte do uvozovek):

```bash
npm run import-sales "C:\Users\…\export prodejů.xlsx"
```

Jména a firmy zákazníků se **neukládají**. Opakovaný import téhož nebo překrývajícího se exportu nic nezdvojí.
BAZAR = cena je konečná (zvláštní režim DPH), PROVĚŘENO = částka v exportu je bez DPH, přičte se 21 %. Vratky se
párují a vyřadí (jen v rámci jednoho exportu).

## Zdroje, šetrnost a pravidla

- Kolomapa se webům poctivě představuje (`Kolomapa/1.0` s odkazem na projekt) a řídí se jejich `robots.txt`
  (ověřeno 2. 10. 2026). Mezi dotazy na jeden web je pauza (výchozí 1,2 s), chyby 429/5xx se opakují s rostoucí
  pauzou, při blokaci nebo captche se zdroj pro daný den zastaví – ověření „nejste robot“ nikdy neobchází.
- **Bazoš** (zapnutý): čte jen HTML stránky kategorií kol (`sport.bazos.cz/horska/`, `/horska/20/` …) a detail
  inzerátu přes `api/v1/ad-detail-2.php`. Výpis mobilního API s parametrem `category=`, vyhledávání ani řazení
  `robots.txt` Bazoše zakazuje, takže je Kolomapa nepoužívá (každou adresu před stažením kontroluje).
- **Sbazar** je ve výchozím stavu vypnutý: jeho `robots.txt` má pro všechny roboty `Disallow: /`.
- **Aukro** je ve výchozím stavu vypnuté: jeho `robots.txt` výslovně blokuje robota společnosti Anthropic (ClaudeBot).
- **Cyklobazar** je ve výchozím stavu vypnutý: chrání se službou Cloudflare (viz výše).
- Zapnutí vypnutého zdroje (`KOLOMAPA_SOURCES=…`) je rozhodnutí provozovatele. Čistší cesta je požádat web o datový
  export nebo souhlas – pak stačí zdroj zapnout.
- Neukládají se jména, telefony ani e-maily prodávajících (skryjí se i z popisu inzerátu); fotky se neukládají, jen se
  na ně odkazuje.
- Data slouží pro interní potřebu obchodu; před zveřejněním mapy zvažte podmínky jednotlivých webů.

Geodata: © [GeoNames](https://www.geonames.org) (CC BY 4.0), hranice krajů © ČÚZK (CC BY 4.0). Mapové podklady
© přispěvatelé OpenStreetMap.

## Vývoj

```bash
npm test               # offline testy nad uloženými ukázkami stránek
npm run demo -- --db=data/demo.db   # ukázková data do samostatné DB; pak KOLOMAPA_DB=data/demo.db npm start
npm run demo-clear     # smaže ukázková data z hlavní DB (do DB se skutečnými inzeráty je demo vloží jen s --force)
node tools/try-source.js bazos --pages=1 --details=3   # vyzkouší zdroj proti živému webu
npm run build-geo      # přegeneruje geodata (GeoNames, ČÚZK)
```

V PowerShellu může `npm run <skript> -- --přepínač` přepínač „spolknout“ – použijte `node tools/…` přímo nebo skripty bez `--`
(`demo-clear`, `run-export`). Architektura a kontrakty modulů: [docs/ARCHITEKTURA.md](docs/ARCHITEKTURA.md).
