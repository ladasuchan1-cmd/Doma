# 🚲 Kolomapa

Jednou denně projde inzeráty kol na **Bazoši a Sbazaru** (volitelně i na **Cyklobazaru a Aukru**), ukáže je na **mapě ČR
po krajích**, u každého si vezme **jednu fotku a všechno, co o kole píše prodávající**, a **nacení tržní hodnotu**.
Výhodné nabídky (cena pod odhadem) jsou zeleně, u každého kola je i **doporučená maximální výkupní cena** pro obchod.

- Kliknutím na kraj se mapa přiblíží a ukáže piny přesně tam, kde kolo je (podle souřadnic / PSČ / obce z inzerátu).
- Vpravo seznam s filtry (zdroj, typ kola, cena, jen výhodné, jen nové) a řazením (nejvýhodnější, nejnovější …).
- Detail: fotka, cena, odhad s rozpětím a vysvětlením „proč“, značka/model/rok/velikost/motor…, odkaz na inzerát.
- Odhad ceny se **učí z trhu** (tisíce inzerátů, srovnatelné nabídky) a **kalibruje na vlastní prodeje obchodu**
  (`training/koloshop-prodeje.json`). S klíčem k Claude API umí nacenit i **podle fotky** (stav kola, výbava).

## Spuštění (Windows / macOS / Linux)

Potřebujete jen **Node.js 22.13 nebo novější** (https://nodejs.org → LTS). Žádná databáze ani `npm install` navíc.

```bash
cd kolomapa
npm start              # http://localhost:8090 – mapa + denní stahování v 05:30
```

Při prvním startu se hned spustí první stahování (trvá desítky minut – inzerátů jsou desetitisíce; detaily se
dočítají postupně během prvních dní). Tlačítkem **Stáhnout teď** v aplikaci ho lze spustit kdykoli ručně.

### Cyklobazar a AI nacenění – volitelné doplňky

```bash
cd kolomapa
npm install                    # nainstaluje volitelné balíčky: playwright (prohlížeč pro Cyklobazar) a @anthropic-ai/sdk
npx playwright install chromium
```

Bez nich aplikace běží dál – jen bez Cyklobazaru a bez AI nacenění.

**Cyklobazar** se chrání službou Cloudflare: obyčejné stahování odmítá a i skutečný prohlížeč po pár rychlých
dotazech zastaví ověřením „Potvrďte, že jste člověk“. Kolomapa proto Cyklobazar čte jen na vyžádání
(`KOLOMAPA_SOURCES=bazos,sbazar,cyklobazar`), přes obyčejný Chromium **bez jakéhokoli maskování**, velmi pomalu
(1 stránka za 20 s, denně jedna sitemapa + nové inzeráty) a při první výzvě k ověření se na 12 hodin zastaví – ověření
nikdy neobchází. Spolehlivější cesta je požádat Cyklobazar o datový export / spolupráci.

### Jednorázový běh (Plánovač úloh Windows / cron) a statická verze

```bash
npm run run            # stáhne, nacení a skončí (vhodné pro Plánovač úloh / cron)
npm run export         # vyrobí statickou mapu do dist/ (lze nahrát na libovolný web)
npm run run -- --export
```

GitHub Actions: workflow `.github/workflows/kolomapa-denne.yml` umí totéž každý den na serverech GitHubu a mapu
zveřejnit na GitHub Pages. **Je vypnuté** – zapíná se proměnnou repozitáře `KOLOMAPA_PAGES=true`. Pozor: repozitář je
veřejný, takže i mapa s odhady a výkupními cenami by byla veřejná.

## Nastavení (proměnné prostředí)

| Proměnná | Význam | Výchozí |
|---|---|---|
| `KOLOMAPA_PORT` | port | `8090` |
| `KOLOMAPA_HOST` | `0.0.0.0` = přístupné z celé sítě (pak nastavte i heslo) | `127.0.0.1` |
| `KOLOMAPA_PASSWORD` | heslo do aplikace (HTTP Basic) | – |
| `KOLOMAPA_SOURCES` | zdroje, např. `bazos,sbazar,cyklobazar,aukro` nebo `all` | `bazos,sbazar` |
| `KOLOMAPA_SCHEDULE` | čas denního běhu `HH:MM`, `off` = vypnout | `05:30` |
| `KOLOMAPA_DELAY_MS` | pauza mezi dotazy na jeden web | `1200` |
| `KOLOMAPA_MAX_DETAILS` | max. detailů inzerátů na zdroj za běh | podle zdroje (Bazoš 4000, Sbazar 2000, Aukro 300, Cyklobazar 120) |
| `ANTHROPIC_API_KEY` | zapne AI nacenění podle fotek | – |
| `KOLOMAPA_AI_MODEL` | model pro AI nacenění | `claude-opus-5-5` |
| `KOLOMAPA_AI_MAX_PER_RUN` | max. AI nacenění za den (hlídá útratu) | `150` |
| `KOLOMAPA_BUY_MARGIN` | cílová marže při výkupu (jinak z vlastních prodejů, ~35 %) | – |

Úplný seznam je v `src/config.js`.

## Vlastní prodeje = učení modelu

Model se kalibruje na skutečné prodeje obchodu. Nový export z POHODY (pohyby skladu – prodejky a vydané faktury,
XLSX) přidáte příkazem:

```bash
npm run import-sales -- cesta/k/exportu.xlsx
```

Jména a firmy zákazníků se **neukládají**. BAZAR = cena je konečná (zvláštní režim DPH), PROVĚŘENO = částka v exportu
je bez DPH, přičte se 21 %. Vratky se párují a vyřadí.

## Zdroje, šetrnost a pravidla

- Mezi dotazy na jeden web je pauza (výchozí 1,2 s), chyby 429/5xx se opakují s rostoucí pauzou, při stránce
  s captchou se zdroj pro daný den zastaví.
- Neukládají se jména, telefony ani e-maily prodávajících; fotky se neukládají, jen se na ně odkazuje.
- **Aukro** je ve výchozím stavu vypnuté: jeho `robots.txt` výslovně blokuje robota společnosti Anthropic (ClaudeBot);
  pro ostatní roboty jsou použité stránky povolené. Zapnutí (`KOLOMAPA_SOURCES=…,aukro`) je rozhodnutí provozovatele.
- Data slouží pro interní potřebu obchodu; před zveřejněním mapy zvažte podmínky jednotlivých webů.

Geodata: © [GeoNames](https://www.geonames.org) (CC BY 4.0), hranice krajů © ČÚZK (CC BY 4.0). Mapové podklady
© přispěvatelé OpenStreetMap.

## Vývoj

```bash
npm test               # offline testy nad uloženými ukázkami stránek
npm run demo           # naplní DB ukázkovými daty (vývoj UI)
node tools/try-source.js bazos --pages=1 --details=3   # vyzkouší zdroj proti živému webu
npm run build-geo      # přegeneruje geodata (GeoNames, ČÚZK)
```

Architektura a kontrakty modulů: [docs/ARCHITEKTURA.md](docs/ARCHITEKTURA.md).
