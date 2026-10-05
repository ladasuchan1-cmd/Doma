# Kolomapa na serveru s Dockerem a Caddy (Hetzner, ksprehledy.cz)

Stejný vzor jako sales, projekty a import: aplikace běží jako kontejner na Docker síti `web`, ven ji pouští Caddy
(kontejner `caddy`, konfigurace `/root/Caddyfile`), doména `*.ksprehledy.cz`, HTTPS certifikát si Caddy vyřídí sama.
Nasazení dělá jeden skript (`nasadit.sh`) – ručně v konzoli Hetzneru, nebo automaticky přes GitHub Actions
(stejně jako Cashflow Radar).

Výsledek: **https://kolomapa.ksprehledy.cz** s heslem; stahování běží každý den v 05:30 přímo na serveru.

## Jak to běží

| Co | Kde |
|---|---|
| kód | `/root/Doma` (klon repozitáře, aplikace ve složce `kolomapa`) – při nasazení přes runner netřeba |
| nastavení | `/root/kolomapa.env` (mimo git; při prvním nasazení vznikne s náhodným heslem a skript ho vypíše) |
| data | `/root/kolomapa-data` → `/app/data` v kontejneru (databáze; přežije přestavbu), zálohy v `zalohy/` |
| kontejner | `kolomapa` z obrazu `kolomapa`, síť `web`, port 8050 jen uvnitř sítě (bez `-p`) |
| vrátnice | Caddy → `https://kolomapa.ksprehledy.cz` (blok do `/root/Caddyfile` přidá `nasadit.sh`, s `header_sec`) |
| stahování | plánovač uvnitř kontejneru (05:30 pražského času) – žádný cron |
| záloha | `/etc/cron.daily/kolomapa-zaloha` → `/root/kolomapa-data/zalohy/kolomapa-<den>.db` (7 dní dozadu) |
| log | `docker logs -f kolomapa` |

Doménu lze změnit v `/root/kolomapa.env` (`KOLOMAPA_DOMENA=…`) před prvním nasazením.

## 1. DNS

U správce domény ksprehledy.cz přidejte záznam **A**: `kolomapa` → IP Hetzner serveru (stejná jako
`sales.ksprehledy.cz`). Certifikát si Caddy vyřídí, jakmile se změna projeví (obvykle do hodiny).

## 2. První nasazení – ručně (konzole Hetzneru, dva příkazy)

```bash
git clone -b claude/bike-sales-monitoring-app-kufe7w https://github.com/ladasuchan1-cmd/Doma.git /root/Doma
bash /root/Doma/kolomapa/deploy/docker/nasadit.sh
```

(Až bude práce sloučená do `main`, klonujte bez `-b …`.) Skript postaví obraz, pustí v něm testy, spustí
kontejner, přidá blok do `/root/Caddyfile` a načte Caddy, založí denní zálohu a **na konci vypíše heslo**.
Trvá 3–5 minut. Pak otevřete https://kolomapa.ksprehledy.cz (jméno libovolné, heslo z výpisu); první stahování
začne samo a trvá 2–3 hodiny.

Je-li repozitář **soukromý**, potřebuje server pro `git clone` / `git pull` klíč jen pro čtení – postup
v [../NASAZENI.md](../NASAZENI.md), krok 2 (nebo nasazujte přes runner níže, ten klíč nepotřebuje).

## 3. Automatické nasazení (GitHub Actions + self-hosted runner)

Po každém sloučení do `main` (změny ve složce `kolomapa/`) proběhne workflow **„Kolomapa – nasazení na server“**:
testy na runneru GitHubu → když projdou, self-hosted runner na serveru pustí `nasadit.sh`. Ručně:
Actions → „Kolomapa – nasazení na server“ → *Run workflow* (jde i z jiné větve, např. té rozpracované).

1. **Repozitář přepněte na soukromý** (Settings → Danger Zone). Self-hosted runner ve veřejném repozitáři GitHub
   nedoporučuje – kód z cizího pull requestu by se mohl dostat na váš server.
2. **Runner na serveru** (konzole Hetzneru, jako root). Na GitHubu otevřete *Settings → Actions → Runners →
   New self-hosted runner → Linux / x64* – stránka vypíše aktuální verzi, kontrolní součet a **registrační
   token** (platí hodinu); použijte příkazy odtud, jen s těmito úpravami:

   ```bash
   mkdir -p /root/actions-runner-kolomapa && cd /root/actions-runner-kolomapa
   # curl … a tar … přesně podle stránky GitHubu
   RUNNER_ALLOW_RUNASROOT=1 ./config.sh --url https://github.com/ladasuchan1-cmd/Doma --token TOKEN_ZE_STRANKY \
     --labels kolomapa --unattended
   ./svc.sh install root && ./svc.sh start && ./svc.sh status
   ```

   Štítek **`kolomapa`** je důležitý – podle něj si workflow runner najde. Vlastní složka
   `actions-runner-kolomapa`: runner je vázaný na jeden repozitář, případný runner jiné aplikace nezabere.
   Běží jako root, protože nasazení upravuje `/root/Caddyfile` a na serveru tak běží vše ostatní.
3. **Zapnutí:** Settings → Secrets and variables → Actions → *Variables* → `KOLOMAPA_HETZNER` = `true`.
   Bez proměnné se job `deploy` přeskočí (jinak by bez runneru visel na „Waiting for a runner“).
4. Actions → „Kolomapa – nasazení na server“ → *Run workflow*. Job `deploy` musí runner sebrat do pár vteřin.

Změny v postupu nasazení patří do `nasadit.sh`, ne do workflow – skript pouští i ruční zásah na serveru.

## Nastavení (`/root/kolomapa.env`)

Formát `docker --env-file`: `KLÍČ=hodnota` bez uvozovek, `#` komentář. Po změně znovu spusťte `nasadit.sh`
(kontejner se musí založit znovu; `docker restart` nové hodnoty nenačte).

| Klíč | Význam |
|---|---|
| `KOLOMAPA_PASSWORD` | heslo do mapy (jméno libovolné) – povinné, bez něj skript nenasadí |
| `KOLOMAPA_DOMENA` | doména pro Caddy (výchozí `kolomapa.ksprehledy.cz`) |
| `KOLOMAPA_SOURCES` | weby (výchozí `bazos`; ostatní viz README – Zdroje, šetrnost a pravidla) |
| `KOLOMAPA_PROHLIZEC` | `1` = do obrazu se přidá Chromium pro Cyklobazar (~400 MB; jen s `cyklobazar` v `KOLOMAPA_SOURCES`) |
| `ANTHROPIC_API_KEY` | zapne AI nacenění podle fotek (placené); balíček je v obrazu |
| `KOLOMAPA_SCHEDULE` | čas denního stahování, výchozí `05:30` |

Ostatní volby (`KOLOMAPA_DELAY_MS`, `KOLOMAPA_MAX_DETAILS`, `KOLOMAPA_AI_MAX_PER_RUN` …) viz README.md.
`KOLOMAPA_HOST`, `KOLOMAPA_PORT`, `KOLOMAPA_TRUST_PROXY` a `KOLOMAPA_DB` jsou dané obrazem – neměňte je.

## Údržba

| Co | Příkaz (konzole Hetzneru) |
|---|---|
| Stav / log | `docker ps --filter name=kolomapa` · `docker logs -f kolomapa` |
| Nová verze | sloučit do `main` (runner nasadí sám) nebo `bash /root/Doma/kolomapa/deploy/docker/nasadit.sh` |
| Stáhnout hned | v mapě tlačítko *Stáhnout teď* |
| Vlastní prodeje z POHODY | export nahrát na server (WinSCP / `scp`), pak `docker cp export.xlsx kolomapa:/tmp/ && docker exec kolomapa npm run import-sales -- /tmp/export.xlsx` – prodeje se uloží do databáze (přežijí přestavbu) |
| Záloha ručně | `docker exec kolomapa sh -c 'sqlite3 /app/data/kolomapa.db ".backup /app/data/zalohy/rucni.db"'` → `/root/kolomapa-data/zalohy/rucni.db` |
| Obnova ze zálohy | `docker stop kolomapa`, `cp /root/kolomapa-data/zalohy/kolomapa-3.db /root/kolomapa-data/kolomapa.db`, smazat `kolomapa.db-wal` a `kolomapa.db-shm` vedle, `docker start kolomapa` |
| Cyklobazar | v `/root/kolomapa.env` `KOLOMAPA_PROHLIZEC=1` a `KOLOMAPA_SOURCES=bazos,cyklobazar`, pak `nasadit.sh` |

## Řešení potíží

| Příznak | Příčina / řešení |
|---|---|
| job `deploy` visí na „Waiting for a runner“ | runner neběží (`cd /root/actions-runner-kolomapa && ./svc.sh status`) nebo nemá štítek `kolomapa` |
| job `deploy` se přeskočil | chybí proměnná repozitáře `KOLOMAPA_HETZNER=true` |
| „testy v obrazu neprošly“ | celý výpis v `/tmp/kolomapa-testy.log` na serveru; starý kontejner běží dál |
| „nová konfigurace Caddy neprošla kontrolou“ | skript vrátil původní `/root/Caddyfile`; blok přidejte ručně (je vypsaný ve skriptu) a `docker exec caddy caddy reload --config /etc/caddy/Caddyfile` |
| prohlížeč hlásí chybu certifikátu | DNS ještě neukazuje na server (`getent hosts kolomapa.ksprehledy.cz`), Caddy to zkouší znovu sama |
| „Kolomapa do minuty neodpověděla“ | skript vypíše posledních 40 řádků logu; typicky špatná hodnota v `/root/kolomapa.env` |
| mapa prázdná | první stahování ještě běží (stav nahoře v mapě, `docker logs kolomapa`) |

## Rollback

```bash
cd /root/Doma && git log --oneline -5        # commit před nasazením
git checkout <hash> && bash kolomapa/deploy/docker/nasadit.sh   # (hlášku o git pull ignorujte)
git checkout main                            # až to bude opravené
```

Databáze i nastavení zůstávají; nic se nemaže.
