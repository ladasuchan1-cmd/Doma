# Recepty z videí – Android

Nativní Android aplikace (Kotlin, min. Android 8.0 / API 26, bez AndroidX a dalších knihoven), do které
**sdílíte video s jídlem z YouTube, Instagramu (Reels) nebo TikToku**. Aplikace z videa zjistí
**ingredience, postup a klíčová slova** a uložený recept pak najdete fulltextem – třeba „kuře rýže -smetana“.

## Co dělá

| Krok | Co se stane |
|---|---|
| V YouTube / Instagramu / TikToku klepnete na *Sdílet → Uložit recept* | Aplikace stáhne název, autora, popisek (caption), u YouTube i automatické titulky, a náhledový obrázek. |
| Zápis receptu | S API klíčem Anthropic recept zapíše model **Claude** (strukturovaný JSON): ingredience v 1. pádě s množstvím a jednotkou, postup, kuchyně, kategorie, čas, porce a 8–20 klíčových slov včetně synonym. Bez klíče se použije **offline slovník** ~200 surovin (česky, slovensky, anglicky) a rozpoznání řádků „200 g mouky“. |
| Webové recepty | Sdílený odkaz na stránku s receptem využije strukturovaná data schema.org/Recipe, když je stránka má. |
| Hledání | Fulltext SQLite FTS4 bez ohledu na diakritiku a s předponami: „kur“ najde „Kuřecí“, „-smetana“ vyřadí recepty se smetanou. Štítky nad seznamem = nejčastější suroviny, klepnutím filtrujete. |
| Detail | Ingredience s odškrtávacími políčky (nákup), postup, klíčová slova (klepnutí = hledat), tlačítko *Otevřít video*, sdílení textu receptu. |
| Úpravy | Cokoli lze ručně opravit; když se popisek nestáhl (Instagram někdy vyžaduje přihlášení), vložíte ho do pole *Popisek videa* a dáte *Uložit a analyzovat znovu*. |
| Záloha | Export všech receptů do JSON (sdílením) a import zpět. |

## Sestavení

Vyžaduje Android Studio (nebo Android SDK + JDK 17) a přístup na Google Maven (Android Gradle Plugin 8.5).

```bash
cd recepty
./gradlew assembleDebug          # APK: app/build/outputs/apk/debug/app-debug.apk
./gradlew installDebug           # instalace na připojený telefon (USB ladění)
```

Nebo v Android Studiu: *File → Open → složka `recepty`* → Run.

APK se také sestavuje automaticky v GitHub Actions (workflow *Recepty APK*, artefakt `recepty-debug-apk`);
tag `recepty-v1.0.0` vytvoří Release s APK.

## První spuštění

1. Nainstalujte APK, otevřete aplikaci.
2. *⋮ → Nastavení* → vložte API klíč Anthropic (z [console.anthropic.com](https://console.anthropic.com/)) → *Otestovat klíč* → *Uložit*.
   Bez klíče aplikace funguje offline s nižší přesností.
3. V YouTube / Instagramu / TikToku otevřete video → *Sdílet* → **Uložit recept**.

## Soukromí

- API klíč je uložen jen v telefonu (SharedPreferences).
- Na `api.anthropic.com` se posílá pouze popisek, titulky a náhled videa, které ukládáte – a jen když je zadán klíč.
- Recepty, náhledy a index jsou lokálně (`recepty.db`, `filesDir/thumbs`).
- Metadata videí se stahují přímo z YouTube / Instagramu / TikToku veřejnými koncovými body (oEmbed, HTML) bez přihlášení.

## Omezení

- Instagram a TikTok nemají veřejné API bez přihlášení; aplikace čte vloženou (embed) stránku a og: metadata,
  což někdy selže (hlavně u soukromých účtů nebo při omezení ze strany Meta). Pak stačí popisek zkopírovat ručně.
- YouTube titulky se berou z automatického přepisu (pokud existuje) – bývají zašuměné, model si s tím poradí, offline heuristika méně.
- Aplikace nepřepisuje zvuk videa; vychází z textu, který k videu autor přiložil, a z náhledu.

## Struktura

```
app/src/main/java/cz/doma/recepty/
  data/Recipe.kt            model receptu + parser řádků ingrediencí („200 g hladká mouka“)
  data/RecipeDb.kt          SQLite: tabulka recipes + FTS4 index (unicode61, bez diakritiky), export/import
  data/SearchQuery.kt       uživatelský dotaz → FTS MATCH (předpony, vyloučení „-slovo“)
  data/Prefs.kt             nastavení (klíč, model, důkladnost, přepínače)
  engine/VideoSource.kt     rozpoznání platformy a ID videa z odkazu
  engine/VideoFetcher.kt    oEmbed + HTML: název, autor, popisek, titulky, náhled; schema.org/Recipe
  engine/ClaudeExtractor.kt Anthropic Messages API, strukturovaný výstup (JSON schéma), server-side fallback
  engine/LocalExtractor.kt  offline heuristika (sekce Ingredience/Postup, řádky s množstvím, slovník)
  engine/IngredientDictionary.kt  slovník surovin cs/sk/en → základní český název
  engine/RecipeImporter.kt  celý průchod: odkaz → stažení → extrakce → uložení; opakovaná analýza
  engine/Thumbs.kt          stažení a zobrazení náhledů
  engine/Http.kt, TextUtil.kt
  ui/MainActivity.kt        hledání, štítky, seznam, přidání odkazu, export/import
  ui/RecipeActivity.kt      detail receptu
  ui/EditActivity.kt        ruční úpravy + „Uložit a analyzovat znovu“
  ui/ShareActivity.kt       cíl pro Sdílet
  ui/SettingsActivity.kt    klíč, model, přepínače, test klíče
```

## Ověření bez Android SDK

Čistě kotlinská logika (parser ingrediencí, slovník, offline extrakce, dotazy, rozpoznání odkazů, čtení HTML/JSON)
má jednotkové testy, které běží na JVM proti `android-all.jar` (Robolectric, Maven Central):

```bash
npm run test:recepty
# = python3 tools/gen-r.py recepty/app/src/main/res tools/recepty-typecheck/build/gen/cz/doma/recepty/R.java cz.doma.recepty
#   && gradle -p tools/recepty-typecheck test
```
