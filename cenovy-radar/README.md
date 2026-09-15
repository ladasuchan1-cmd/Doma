# Cenový radar — návrh náhrady Disiva (research + projekt)

Podklady k rozhodnutí, jak nahradit Disivo vlastním nástrojem pro monitoring cen konkurence
a dynamickou cenotvorbu. Vzniklo 15. 9. 2026 čistě sběrem informací (maily, Drive,
repozitáře r01sales / feedhub, veřejné weby) — **nic nebylo měněno** v adminu, Disivu,
na webu ani v mailech.

| Dokument | Obsah |
|---|---|
| [01 Současný stav](docs/01-soucasny-stav.md) | Jak dnes používáme Disivo, datové toky, známé problémy, co už máme postavené, lidé |
| [02 Legální rámec](docs/02-legalni-ramec.md) | EU/ČR právo (databáze, TDM výjimka, ToS, nekalá soutěž, § 230 TZ, GDPR), judikatura, checklist „smíme / nesmíme“ |
| [03 Párování produktů](docs/03-parovani-produktu.md) | EAN/MPN, normalizace, kandidáti, skóre, human‑in‑the‑loop, varianty a ročníky, doporučený design |
| [04 Konkurence a zdroje](docs/04-konkurence-a-zdroje.md) | Disivo (co umí, co nahrazujeme), tabulka konkurentů CZ/DE (robots, JSON‑LD, anti‑bot), Pohoda, Heureka |
| [05 Návrh projektu](docs/05-navrh-projektu.md) | Architektura, datový model, sběr, párování, cenový engine, fáze, rizika, otevřené otázky |
| [06 Scraping policy](docs/06-scraping-policy.md) | Interní pravidla sběru dat k schválení vedením |

Jednostránkový přehled pro vedení: [prehled-pro-vedeni.html](prehled-pro-vedeni.html) (tělo HTML stránky; publikováno i jako sdílený artefakt).

**Implementace:** samostatný repozitář `ladasuchan1-cmd/cenovy-radar` (fáze 1 — skeleton, ingest feedu, adaptéry, párování EAN/MPN, srovnání cen; nasazení na Hetzner viz tamní `NASAZENI.md`).

Doporučené pořadí čtení pro vedení: 05 → 01 → 06 → 02. Pro implementaci: 03 → 04 → 05.
