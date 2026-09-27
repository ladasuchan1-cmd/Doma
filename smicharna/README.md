# 🧺 Smíchárna

Prototyp komunity pro kamarády: posílají se vtipné kraviny z TikToku, Instagramu nebo YouTube, reaguje se
**jen hezky** (srdíčko, tlemík, palec) a nadávky v komentářích **vypere pračka**.

- **Pračka na nadávky** – napíšeš urážku nebo hejt a pračka z něj vypere něco hezkého. Programy jsou
  pojmenované jako na pračce: Jemné 30 °C, Babička 40 °C, Básnička 50 °C, Komentátor 60 °C, Úředník 90 °C.
  Výsledek jde zkopírovat, uložit jako čtvercový obrázek (1080 × 1080) nebo poslat rovnou do feedu.
- **Kraviny** – sdílený feed: odkaz a popisek, pozitivní reakce, komentáře přes pračku. Každý vypraný
  komentář má štítek „vypráno“ a autor hned vidí, co z jeho zprávy vzniklo. Nikdo nevidí, kdo si
  příspěvek zobrazil a nereagoval.
- **Jak to funguje** – pravidla a tabulka programů ve stylu symbolů praní z visaček na oblečení.

## Jak běží

Stránka je jeden soubor [`index.html`](index.html) publikovaný jako Claude Artifact spolu s
[`pracka.js`](pracka.js). Podle toho, jaké schopnosti (capabilities) artefakt má, běží ve dvou podobách:

| Podoba | Capabilities | Pro koho |
|---|---|---|
| **Smíchárna** (sdílený feed) | `db`, `user` (scope `profile`), `sample`, `downloads` | pozvaní kamarádi s účtem na claude.ai; aby mohli přidávat a reagovat, potřebují v menu Sdílet roli Editor |
| **Pračka na nadávky** (veřejná ukázka) | `sample`, `downloads` | kdokoli s odkazem; feed je jen ukázka uložená v prohlížeči |

Veřejná podoba se liší jen titulkem a výchozí záložkou:

```bash
sed -e 's#<title>Smíchárna</title>#<title>Pračka na nadávky</title>#' \
    -e 's#data-default-tab="kraviny"#data-default-tab="pracka"#' \
    smicharna/index.html > pracka-verejna/index.html
```

## Jak pere

1. **Claude** (`sample`, rychlý model) dostane zadání z `Pracka.aiPrompt()` – program, pravidla, text
   příspěvku jako kontext a zprávu v oddělovačích jako nedůvěryhodná data – a vrátí `{"washed": …, "text": …}`.
   Pere na účtu toho, kdo zrovna pere; při prvním praní se zeptá na svolení.
2. Odpověď kontroluje `Pracka.checkAi()`: když je výstup pořád sprostý, nebo Claude tvrdí „čisté“,
   ale jsou tam nadávky, použije se rychloprogram.
3. **Rychloprogram** (`Pracka.wash()`) běží bez AI přímo v prohlížeči. Pozná nadávky s diakritikou
   i bez ní, vymění je za podobně znějící hezká slova se správnou koncovkou („idiote“ → „idole“,
   „blbče“ → „borče“, „kriple“ → „klaďasi“, „nejtrapnější“ → „nejtřpytivější“) a výhrůžky, nenávist
   nebo rýpnutí do rodiny („tvoje máma…“ spolu s urážkou, i samotné „Tvoje máma.“) nahradí celé
   šablonou daného programu.

## Data (`db`)

| Kolekce | Dokument | Pole |
|---|---|---|
| `posts` | náhodné id | `authorId`, `who`, `nick`, `url`, `text`, `program`, `createdAt` |
| `comments` | náhodné id | `postId`, `authorId`, `who`, `nick`, `text` (už vypraný), `washed`, `program`, `engine`, `createdAt` |
| `reactions` | `<postId>~<who>` | `postId`, `who`, `e` (`heart` / `laugh` / `thumb`), `at` |

Původní znění nadávek se nikam neukládá. Jména se berou z profilu claude.ai (ukládá se jen id);
přezdívka se píše jen tam, kde profil jméno nemá. Databáze artefaktu pojme nejvýš 5 000 dokumentů.

## Vývoj

```bash
node --test smicharna/test/*.test.js   # testy rychloprogramu a kontroly odpovědí od Claude
```

Omezení prototypu: videa se nenahrávají (jen odkazy, kvůli autorským právům a velikosti) a pračka pere
text, ne obrázky.
