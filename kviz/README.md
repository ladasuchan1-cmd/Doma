# 🎬 Boubínský kvíz – aplikace pro Android

Čtyři kvízy **Boubínské rodinné kvízování** (složka `Kviz` na Disku Google) jako aplikace do telefonu. Každý kvíz má
pět bloků po dvou okruzích, 50 otázek, filmové a hudební ukázky, odpočet času, řešení a tabulku skóre. Telefon slouží
jako prezentace pro moderátora – dá se otočit na šířku nebo zrcadlit na televizi.

Existuje ve třech podobách se stejnými kvízy a stejnou mobilní úpravou:

- **Web na GitHub Pages** – https://ladasuchan1-cmd.github.io/Doma/ (větev `kviz-web`). Otevře ho kdokoli bez účtu
  a instalace, na Androidu, iPhonu i počítači; ukázky jsou zašifrované a přehrají se až po zadání hesla
  (viz [Veřejný web](#veřejný-web-github-pages)).
- **Soukromá stránka na claude.ai** – jen pro vlastníka účtu, ukázky nahrané přímo ve stránce.
- **Android aplikace (APK)** – funguje i bez internetu, ale instalaci mimo Obchod Play musí telefon povolit.

## Instalace

1. Stáhni `boubinsky-kviz.apk` do telefonu – z GitHubu (záložka **Actions → Kvíz APK → poslední běh → Artifacts**,
   soubor je zabalený v ZIPu), nebo z **Releases**, pokud je vydaná verze (tag `kviz-v…`).
2. Otevři stažený soubor. Android se zeptá, jestli smí prohlížeč / Soubory instalovat aplikace z neznámých zdrojů –
   povol to a dej **Instalovat**. Samsung s **Automatickým blokováním** instalaci odmítne úplně; vypíná se v
   *Nastavení → Zabezpečení a soukromí → Automatické blokování* (po instalaci ho jde zase zapnout).
3. Aplikace se jmenuje **Boubínský kvíz**. Novější verze se instaluje přes starou, ukázky i skóre zůstanou.

Aplikace nepotřebuje žádná oprávnění ani internet (jen při nahrávání ukázek z Disku Google).

## Ukázky z filmů a hudby

Videa nejsou součástí aplikace ani tohoto repozitáře – repozitář je veřejný a jde o ukázky z filmů a hudebních klipů
(dohromady asi 210 MB). Do telefonu se nahrají jednou, aplikace si je uloží a pak fungují i bez internetu:

1. V menu aplikace klepni na **Vybrat soubory**.
2. Ve výběru otevři nabídku ☰ a zvol **Disk** (Disk Google).
3. Otevři **Kviz → videos**, označ všechna videa (podržet prst na prvním, pak klepat, případně ⋮ → *Vybrat vše*)
   a potvrď **Vybrat**. Aplikace si sama vezme 20 videí, která kvízy potřebují, ostatní přeskočí.
4. Totéž pro složku **hudba** (dalších 20 ukázek).

Kdo má složku `Kviz` přímo v telefonu (zkopírovanou z počítače), může místo toho použít **Vybrat složku** – aplikace
projde i podsložky. Soubory se párují podle názvu stejně jako v původním kvízu: bez diakritiky, mezer a velikosti
písmen, takže projde i `Pelisky (1999).mp4` místo `pelisky.mp4`. Přehled, co chybí, je v menu pod **Seznam ukázek**;
jednotlivou ukázku lze přiřadit i přímo v kvízu tlačítkem **Vybrat tento soubor**.

## Ovládání

| | |
|---|---|
| **Další / Zpět** nebo přejetí prstem | další a předchozí snímek |
| **Nápověda** | tři možnosti (trefa s nápovědou platí za půl bodu) |
| **Odpověď** | správné řešení s vysvětlením |
| **Přehrát** | pustí ukázku, na snímku s časem spustí dvouminutový odpočet |
| **S klipem** | u hudby pustí i obraz |
| **‹ Menu** nebo systémové Zpět | zpět do menu (s potvrzením) |

Kvíz si pamatuje, kde jste skončili – z menu jde **Pokračovat** nebo začít **Od začátku**. Skóre týmů se ukládá
průběžně (tlačítkem *Vymazat body* na snímku se skóre se vynuluje). S připojenou klávesnicí fungují i původní
zkratky (šipky, N, O, mezerník, V).

## Jak to funguje

```
kviz/
  web/                      původní kvízy (HTML beze změny) + pozadi/*.jpg (zmenšená z PNG)
  android/                  aplikace (Kotlin, bez AndroidX, jen WebView)
    app/src/main/assets/app/
      menu.html             menu: výběr kvízu, stav a nahrávání ukázek
      mobile.css            úpravy rozvržení pro telefon (na výšku, na šířku, tablet)
      bridge.js             listování prstem, uložená pozice, tlačítko Menu, napojení výběru ukázek
    app/src/main/java/cz/boubinkviz/
      MainActivity.kt       WebView, výběr souborů (SAF), celá obrazovka během kvízu, Zpět
      LocalServer.kt        adresy https://appassets.androidplatform.net/… → assets a uložené ukázky (s Range)
      Library.kt            seznam kvízů a ukázek (čte pole BLOCKS z HTML), import a kopírování ukázek
      Names.kt              párování názvů souborů (stejné jako norm/fromPicked v kvízu)
```

- HTML kvízů se při sestavení zkopíruje z `kviz/web` do assets. Aplikace do stránky za běhu vloží `mobile.css`
  a `bridge.js`, původní soubory se tedy dají dál otevírat v prohlížeči na počítači.
- Kvíz si ukázky žádá relativně (`videos/TITANIC.mp4`, `hudba/…`); `LocalServer` je hledá podle normalizovaného
  názvu mezi ukázkami uloženými v aplikaci a posílá je i po částech (hlavička Range), takže video jde přetáčet.
- Seznam potřebných ukázek se čte přímo z kvízů – po výměně HTML za novou verzi s jinými ukázkami stačí aplikaci
  znovu sestavit.
- APK je podepsané pevným ladicím klíčem `android/app/debug.keystore` (heslo `android`), aby se každá nová verze
  – z GitHubu i z vlastního počítače – nainstalovala přes předchozí bez ztráty nahraných ukázek. Nejde o tajemství,
  jen o stejný podpis.

## Webové verze

Obě se staví ze složky `kviz/webapp/`: `index.html` je menu (společná šablona), kvízy jsou vedle jako samostatné
stránky s vloženým `mobile.css` a `bridge.js` z Android aplikace. Tlačítko Menu v kvízu vede zpět na menu.

### Veřejný web (GitHub Pages)

Větev `kviz-web` obsahuje jen sestavený web a GitHub Pages ji zveřejňuje (*Settings → Pages → Branch: kviz-web*).
Filmové a hudební ukázky jsou chráněné autorským právem, proto na veřejném webu nejsou čitelně: `server.mjs` je
zašifruje AES-256-GCM klíčem odvozeným z hesla (PBKDF2-SHA256, 210 000 iterací) a `sifra.js` je v prohlížeči
rozšifruje, až když je kvíz potřebuje. Heslo se zadá jednou v menu, v prohlížeči zůstane jen odvozený klíč; ve
větvi ani v repozitáři heslo není. Bez hesla jdou otázky hrát, ukázky ukážou „zamčené heslem“.

```bash
git worktree add ../kviz-web kviz-web                                  # předchozí sestavení: stejná sůl i nezměněné ukázky
KVIZ_HESLO=… node kviz/webapp/server.mjs ../kviz-web ~/Kviz/ukazky      # složka s videi pojmenovanými jako na Disku
cd ../kviz-web && git add -A && git commit -m "…" && git push
```

Do stávajícího sestavení jde jen s původním heslem (skript jiné odmítne), takže uložená hesla v telefonech dál platí
a git nahraje jen nové nebo změněné ukázky.

### Soukromá stránka na claude.ai

`build.py` sestaví stránku pro claude.ai; ukázky jsou nahrané jako soubory stránky (assets) a `ukazky.js` obsahuje
jejich adresy. Stránku otevře jen vlastník účtu a ti, se kterými ji sdílí.

```bash
python3 kviz/webapp/build.py /tmp/web-kviz ukazky.json   # ukazky.json: {"titanic": "/_blob/…", …}
```

Skript vypíše mapu `files` pro publikování (pozadí jsou JPEG pod názvy `.png`, které kvíz volá).

## Vývoj

```bash
cd kviz/android
./gradlew assembleDebug testDebugUnitTest    # APK v app/build/outputs/apk/debug/ + testy párování (JDK 17, Android SDK 34)
cd ../.. && npm run e2e:kviz                 # menu, všechny kvízy a veřejný web s heslem v Chromiu (telefon, tablet)
```

Testy párování (`app/src/test/…/NamesTest.kt`) ověřují i to, že všech 40 ukázek ze čtyř kvízů je ve složce na Disku
pod přesným názvem. `tools/e2e-kviz.js` napodobuje `LocalServer` a místo skutečné ukázky používá syntetické video
`tools/fixtures/kviz-test.webm`.
