# Hlídač podmínek – Android

Nativní Android aplikace (Kotlin, min. Android 8.0 / API 26, bez AndroidX) se **stejným analytickým jádrem**
jako rozšíření prohlížeče: sdílené JS knihovny z `../lib` běží ve skrytém WebView, takže detekce,
offline analýza, sestavení požadavku na Claude i vykreslení výsledku jsou na obou platformách identické.

## Co dělá

| Situace | Co se stane |
|---|---|
| Otevřete v prohlížeči (Chrome, Firefox, Brave, Samsung…) obchodní podmínky, privacy policy, EULA | Služba na pozadí přečte adresu z lišty, stáhne stránku, zanalyzuje ji a pošle notifikaci s verdiktem. |
| Jste v prohlížeči na pokladně / registraci s políčkem „Souhlasím s…“ | Stáhne odkazované podmínky a zanalyzuje je ještě před souhlasem. |
| Instalujete aplikaci v Obchodě Play nebo se registrujete přímo v aplikaci | Sleduje text na obrazovce; dlouhý právní text zanalyzuje sám, u souhlasu bez dostupných odkazů nabídne notifikací „Analyzovat obrazovku“. |
| Cokoli ručně | *Sdílet → Hlídač podmínek* (text nebo odkaz), „Analyzovat podmínky“ v menu označeného textu, nebo vložení textu / odkazu v aplikaci. |

Výsledek: verdikt (standardní / pozor / rizikové), rizika podle závažnosti (únik dat, třetí strany, mimo EU…),
**jak zrušit** smlouvu či předplatné (postup, lhůty, automatické prodlužování, sankce), **ceny** v tabulce, klíčové body.

## Sestavení

Vyžaduje Android Studio (nebo Android SDK + JDK 17) a přístup na Google Maven (Android Gradle Plugin 8.5).

```bash
cd android
./gradlew assembleDebug          # APK: app/build/outputs/apk/debug/app-debug.apk
./gradlew installDebug           # instalace na připojený telefon (USB ladění)
```

Nebo v Android Studiu: *File → Open → složka `android`* → Run.

Task `copyJsLibs` před sestavením zkopíruje `../lib/*.js` do assetů – JS knihovny se neduplikují.

## První spuštění v telefonu

1. Otevřete aplikaci → **Zapnout službu na pozadí** → v nastavení přístupnosti povolte „Hlídač podmínek“.
   (Android se zeptá na potvrzení; služba čte obsah obrazovky, viz Soukromí níže.)
2. Povolte notifikace (Android 13+ se zeptá sám).
3. **Nastavení** → vložte API klíč Anthropic → *Otestovat klíč* → *Uložit*. Bez klíče běží offline analýza.
4. Doporučeno: v nastavení baterie vypněte optimalizaci pro aplikaci, aby systém službu neukončoval.

## Soukromí

- Služba přístupnosti vidí text na obrazovce. Nic z něj **neopouští telefon**, dokud detektor nerozhodne,
  že jde o podmínky / souhlas – a i pak se text posílá jen na `api.anthropic.com`, pokud je zadán klíč.
- Hesla (pole `isPassword`) se nikdy nečtou. Balíčky systému, klávesnic a launcheru jsou ignorovány.
- Výsledky, historie a cache (7 dní) jsou uloženy jen v telefonu (`filesDir/results`, SharedPreferences).
- Pokud byste aplikaci chtěli publikovat na Google Play, počítejte s tím, že použití AccessibilityService
  k jinému než asistivnímu účelu vyžaduje zdůvodnění v konzoli a viditelné vysvětlení uživateli (obojí je v aplikaci).

## Struktura

```
app/src/main/java/cz/hlidacpodminek/
  App.kt                         kanály notifikací, start JS jádra
  engine/JsEngine.kt             most do lib/*.js (WebView.evaluateJavascript)
  engine/Http.kt                 HttpURLConnection klient
  engine/ClaudeClient.kt         volání Anthropic Messages API (tělo sestavuje lib/claude.js)
  engine/Analyzer.kt             cache → Claude / offline → uložení; analýza textu, odkazů, URL
  service/TermsAccessibilityService.kt   služba na pozadí (obdoba content.js)
  service/Notifier.kt            notifikace s výsledkem / výzvou
  ui/MainActivity.kt             stav služby, vložení textu, historie
  ui/ResultActivity.kt           výsledek (WebView + lib/render.js)
  ui/SettingsActivity.kt         klíč, model, přepínače
  ui/ShareActivity.kt            cíl pro Sdílet / Analyzovat označený text
app/src/main/assets/engine.html  načte lib/*.js a vystaví window.TG
app/src/main/assets/result.html  vykreslení výsledku
```

## Ověření bez Android SDK

V tomto repozitáři se Kotlin zdrojáky typově kontrolují proti `android-all.jar` (Robolectric, Maven Central)
a WebView assety se testují v Chromiu:

```bash
python3 tools/gen-r.py android/app/src/main/res tools/android-typecheck/build/gen/cz/hlidacpodminek/R.java cz.hlidacpodminek
gradle -p tools/android-typecheck compileKotlin
node tools/e2e-android-assets.js
```
