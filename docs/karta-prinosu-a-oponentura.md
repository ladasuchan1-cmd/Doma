# Karta přínosu a oponentura — pravidlo pro všechny nástroje

Platí od 27. 11. 2026 (pokyn Ládi) pro Sales, OBR, Cashflow Radar i Feed Hub. Závazné znění pro Feed Hub
je v jeho `CLAUDE.md`, sekce 10. Do `CLAUDE.md` Salesu zapsané není — Sales a OBR tahle session jen čte.

## Proč

CEO Honza: „Vím, že toho děláte hodně. Máte spoustu přehledů a náhledů, možná až moc. Ale chybí mi to
nejdůležitější: co nám to přinese. Úspory času, peněz, lidí? Výnosy — obrat, marže, zisk? Kolik?“
Je pod tlakem auditu, banky a CFO; za každý nástroj musíme umět odpovědět, klidně s pravděpodobností,
s variantami cesty a s připraveným postupem, když to půjde jinak. Nesmí nastat stav, kdy nevíme, co dál.

## Karta (ke každému návrhu, dřív než se staví)

1. **Co a proč** — jednou větou: čí rozhodnutí nebo úkon se tím změní a co se stane, když se to neudělá.
2. **Přínos za rok** v korunách nebo hodinách — pesimisticky / realisticky / optimisticky, s pravděpodobností.
   Zvlášť marže, hotovost (sklad), ušetřené platby, čas lidí. U každého čísla: **změřeno**, nebo **odhad**, a z čeho.
3. **Náklad** — stavba, provoz, čas lidí, kteří s tím mají pracovat.
4. **Jak se to změří** — jedno číslo, výchozí stav, datum kontroly.
5. **Varianty cesty** — aspoň dvě, vždy i „nedělat“ nebo „udělat menší“.
6. **Když to půjde jinak** — předem daný práh a rozhodnutí: pokračovat, změnit cestu, zastavit.

## Oponentura (čtyři pohledy, v tomhle pořadí)

- **Claude** — data a proveditelnost: co je jen odhad, co může být špatně, co už existuje a nikdo to nepoužívá.
- **CFO** — peníze, hotovost, riziko, doložitelnost pro audit a banku.
- **CSO** — obchod a dodavatelé; bude s tím tým opravdu pracovat?
- **CEO** — co to přinese firmě, proč teď, co kvůli tomu počká. Tenhle pohled váží nejvíc.

## Oponentura Ládi (pět otázek ke každému nápadu nebo updatu)

1. Čí rozhodnutí nebo úkon se tím změní? (Ne „co uvidím“.)
2. Co se stane, když to měsíc neuděláme?
3. Podle čeho za 30 dní poznáme, že to pomohlo?
4. Kdo to bude používat — a ví o tom?
5. Co kvůli tomu počká?

Když chybí odpověď na 1 nebo 3, nestaví se: nápad jde do seznamu a vrátíme se k němu. Souhlas ze zdvořilosti
je chyba; stejně přísně se oponují návrhy Clauda. Bez karty se dělají jen opravy chyb, spadlé běhy a to,
co už je rozhodnuté.

## První karta: Feed Hub, verze 1 (27. 11. 2026) — odhad, ne měření

Měřítko (změřeno z dat Salesu a logu serveru): obrat 2025 324 mil. Kč, marže 66 mil. (20 %); nákup 8/2025–7/2026
125 mil. Kč, asi 100 mil. od dodavatelů, jejichž feed čteme; sklad 92 mil. Kč, ležáky 18 mil.

| Přínos | Kč ročně (pes. / real. / opt.) | Podklad |
|---|---|---|
| Chybějící varianty prodávané ze skladu dodavatele | marže 0,2 / 0,8 / 2,4 mil. | přes 7 000 chybějících variant; 6 tis. Kč obratu na položku; nejslabší podklad |
| Nákup u levnějšího dodavatele | 0,05 / 0,25 / 1 mil. | vzorek 13 feedů: 24 % položek u víc dodavatelů, rozdíl 6–12 %; většina Force u KCK a Slogeru |
| Slib dostupnosti na e-shopu | 0 / 0,1 / 0,3 mil. | vzorek KCK: 52 slibů bez krytí z 1 108 položek |
| Menší sklad (hotovost, jednorázově) | 0 / 0,9–1,8 / 4,6 mil. | jen po napojení OBR |
| BHIT a IT Future | podle fakturace | částku má CFO |
| Čas lidí | neměřeno | 1 000 karet ručně po 2 minutách = 33 hodin |

Součet marže 0,3 / 1,1 / 3,7 mil. Kč; pravděpodobnost 80 / 50 / 15 % je úsudek, ne výpočet.

Oponentura téhož dne: od 22. do 26. 11. šlo na server 48 změn; ruční párování z 23. 11. nemělo k 26. 11. jediné
použití; fáze 1–4 ze zadání nejsou uzavřené a BHIT s IT Future běží dál; nevíme, kdo kromě Ládi nástroj používá.
Doporučení: napřed změřit používání a výsledek toho, co už je, než se staví další.

## První měření: Disivo feed (27. 11. 2026)

Láďa poslal adresu našeho feedu pro Disivo (`xml-new/CZE/disivo.xml`). Nese u každé z 49 395 položek e-shopu
naši prodejní a nákupní cenu (s DPH), třídu ABC, sklad Teplice / Praha a dny skladem — tedy vstupy, které
kartě chyběly. Jednorázový rozbor mimo server (nic se nestavělo), dodavatelé jen ze 17 z asi 50 feedů
(KCK z 27. 11., ostatní z 23.–25. 11.; chybí Aspire, Helios, Zookee, Sport Import):

| Třída | Položek | U nás vyprodáno | Z vyprodaných má dodavatel skladem (aspoň) |
|---|---:|---:|---:|
| A | 823 | 319 (39 %) | 114 |
| B | 1 793 | 660 (37 %) | 248 |
| C | 3 707 | 1 203 (32 %) | 511 |

- Hodnota skladu v nákupních cenách bez DPH podle feedu: 82,6 mil. Kč (Sales: 92 mil., jiný den a rozsah).
- Nákupní cena: u položek A a B, které jdou srovnat (809), je nejlevnější stažená nabídka o víc než 3 % pod
  naší nákupní cenou u 168 a o víc než 3 % nad ní u 397. Feedové ceny bývají před našimi slevami, takže
  je to seznam k prověření, ne úspora.
- Vyprodáno u nás neznamená, že se neprodává (e-shop umí nabízet dodání ze skladu dodavatele), a třída ABC
  nejsou koruny — obrat po položkách feed nenese.
- Všechny čtyři sloupce ABC (30 / 90 / 180 / 360 dní) mají u všech položek stejnou hodnotu.
- **Feed je stažitelný bez přihlášení z veřejné adresy** — i s nákupními cenami celého sortimentu.

Další krok podle karty: seznam 362 položek tříd A a B dostane nákup s jednou otázkou — je to nová informace,
nebo ji už dává OBR? Podle odpovědi se rozhodne, jestli se Disivo feed stane zdrojem Feed Hubu.
