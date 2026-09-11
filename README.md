# 🛡️ Hlídač podmínek

Rozšíření pro Chrome / Edge / Brave (Manifest V3), které **za vás čte obchodní podmínky, zásady ochrany osobních údajů, licenční ujednání (EULA) a podmínky předplatného** – při nákupu, registraci nebo instalaci aplikace – a srozumitelně česky shrne:

- ✅ zda jde o **standardní text**, nebo obsahuje neobvyklá ustanovení,
- 🔴 co je **kritické / varovné** z pohledu úniku dat, sdílení s třetími stranami, přenosu mimo EU, profilování,
- ✂️ **jak zrušit smlouvu či předplatné** – postup, lhůty, automatické prodlužování, sankce, vrácení peněz,
- 💰 **jaké ceny a poplatky** se v dokumentu zmiňují (částka, období, podmínka),
- 📋 nejdůležitější body v několika větách.

Rozšíření **běží na pozadí a aktivuje se samo**: lehký detektor na každé stránce pozná dokument s podmínkami (nadpis, URL, hustota právního textu) i „kontext souhlasu“ – pokladnu e-shopu, registraci, obchod s aplikacemi – kde stáhne odkazované podmínky a zanalyzuje je ještě před tím, než kliknete na *Souhlasím*.

Existuje ve dvou podobách se společným jádrem:

- **Rozšíření prohlížeče** (Chrome / Edge / Brave) – tento adresář.
- **Android aplikace** (Kotlin) – složka [`android/`](android/README.md); služba na pozadí čte obrazovku, takže funguje v prohlížeči, Obchodě Play i v aplikacích.

## Instalace rozšíření (ze zdrojáků)

1. Stáhněte / naklonujte tento repozitář.
2. V Chromu otevřete `chrome://extensions`, zapněte **Režim pro vývojáře**.
3. Klikněte **Načíst rozbalené** a vyberte složku repozitáře (tu, kde je `manifest.json`).
4. Otevře se stránka nastavení – vložte **API klíč Anthropic** (z [console.anthropic.com](https://console.anthropic.com/)) a klikněte *Otestovat klíč* a *Uložit*.

Bez klíče rozšíření funguje v **offline režimu** (heuristická analýza podle klíčových slov – spolehlivě najde ceny, věty o zrušení, automatické prodlužování a nejčastější rizikové formulace, ale nerozumí kontextu tak jako jazykový model).

## Použití

| Situace | Co se stane |
|---|---|
| Otevřete stránku „Obchodní podmínky“, „Privacy Policy“, EULA… | Rozšíření text přečte a vpravo nahoře zobrazí panel s verdiktem. |
| Jste na pokladně, registraci nebo v obchodě s aplikacemi | Najde odkazy na podmínky, stáhne je na pozadí a zanalyzuje. U rizikových podmínek přijde systémová notifikace. |
| Chcete analyzovat cokoli ručně | Pravé tlačítko → *Analyzovat vybraný text / tuto stránku / odkazované podmínky*, nebo ikona rozšíření → *Vložit text…* |

Ikona v liště ukazuje stav aktuální karty: `OK` standardní · `!` pozor · `!!` rizikové.

Výsledky se ukládají do mezipaměti na 7 dní (stejný dokument se neplatí dvakrát). Web lze přidat mezi ignorované.

## Jak to funguje uvnitř

```
content.js  ──(signály stránky)──▶ lib/detector.js ──▶ PAGE_DETECTED ──▶ background.js
                                                                           │  stáhne odkazované dokumenty (fetch)
                                                                           │  lib/extract.js  HTML → text
                                                                           ├─▶ lib/claude.js  (Claude API, strukturovaný JSON)
                                                                           └─▶ lib/local-analyzer.js (offline heuristika)
                                                                           ▼
                                                    SHOW_RESULT ──▶ panel ve stránce (lib/render.js) / popup
```

- **Detekce** (`lib/detector.js`, `lib/keywords.js`): čeština, slovenština, angličtina, němčina. Dokument = nadpis/URL + délka + hustota právních slov. Kontext souhlasu = (tlačítko/nadpis/URL pokladny, registrace či instalace) **a** silný signál (políčko „Souhlasím s…“, pole pro heslo nebo kartu, URL pokladny, obchod s aplikacemi) **a** odkaz na podmínky – tím se nespouští na běžných stránkách produktů.
- **Analýza modelem** (`lib/claude.js`): Anthropic Messages API, výchozí model `claude-opus-5`, strukturovaný výstup podle `lib/schema.js`, server-side fallback při odmítnutí bezpečnostním klasifikátorem. Klíč se ukládá jen do `chrome.storage.local`.
- **Offline analýza** (`lib/local-analyzer.js`): regexové skupiny rizik (třetí strany, prodej dat, mimo EU, profilování, citlivé údaje, auto-prodlužování, zkušební období, sankce, změna cen/podmínek, licence k obsahu, rozhodčí doložky, vyloučení odpovědnosti…), extrakce cen s obdobím, věty o zrušení, výpovědní lhůty.

## Soukromí

Text podmínek se odesílá **pouze** na `api.anthropic.com`, a jen když je zadán klíč a rozšíření se rozhodne analyzovat (nebo o to požádáte). Nic jiného se nikam neposílá; historie a cache jsou lokálně v prohlížeči.

## Vývoj

```bash
npm test          # jednotkové testy (Node 20+, bez závislostí)
npm run icons     # přegeneruje ikony (python3, bez závislostí)
npm run pack      # zabalí rozšíření do dist/hlidac-podminek.zip
node tools/e2e.js # spustí Chromium s rozšířením nad testovací stránkou (vyžaduje playwright)
npm run e2e:android   # ověří WebView assety Android aplikace v Chromiu
npm run typecheck:android   # zkompiluje Kotlin zdrojáky proti android-all.jar (bez Android SDK)
```

Android APK se sestavuje v Android Studiu nebo `cd android && ./gradlew assembleDebug` (viz `android/README.md`).

Omezení: PDF dokumenty se zatím nečtou (rozšíření na to upozorní); analýza je automatická a **nenahrazuje právní poradenství**.

## Licence

MIT
