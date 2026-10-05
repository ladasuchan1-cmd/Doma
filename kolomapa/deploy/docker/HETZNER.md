# Kolomapa na serveru Hetzner (37.27.203.154) – Docker + Caddy

Stejný vzor jako ostatní aplikace (Cyklostezky a sjezdovky na `37-27-203-154.sslip.io`, sales/projekty/import na
ksprehledy.cz): aplikace běží jako kontejner, ven ji pouští Caddy, HTTPS certifikát si Caddy vyřídí sama.
Nasazení dělá jeden skript (`nasadit.sh`) – ručně v konzoli Hetzneru, nebo automaticky přes GitHub Actions
(stejně jako Cashflow Radar).

Výsledek: **https://kolomapa.37-27-203-154.sslip.io** s heslem; stahování běží každý den v 05:30 přímo na serveru.
Adresa je podle IP serveru (sslip.io), takže nepotřebuje žádnou DNS – vlastní doménu lze dát kdykoli (níže).

## První nasazení – jeden příkaz přes SSH

Přihlaste se na server (`ssh agent@37.27.203.154` z PowerShellu, nebo Termius z telefonu) a vložte:

```bash
curl -fsSL https://raw.githubusercontent.com/ladasuchan1-cmd/Doma/refs/heads/claude/bike-sales-monitoring-app-kufe7w/kolomapa/deploy/docker/pripravit-server.sh -o /tmp/pripravit-server.sh && sudo bash /tmp/pripravit-server.sh
```

(Funguje pro uživatele se `sudo` i pro roota. Webová konzole Hetzneru `>_` také funguje, ale nejde do ní vkládat.)

Stáhne kód do `/root/Doma`, postaví obraz, pustí v něm testy, spustí kontejner, přidá blok do konfigurace Caddy
a načte ji, založí denní zálohu a na konci vypíše, **jak se přihlásit**: na tomto serveru jmény a hesly Cyklo & Ski
mapy (viz níže); bez ní vygeneruje heslo a vypíše ho. Trvá 3–5 minut. Pak otevřete
https://kolomapa.37-27-203-154.sslip.io. První stahování začne samo a trvá 2–3 hodiny; mapa se plní průběžně.
Příkaz lze spustit znovu kdykoli (aktualizuje kód a nasadí znovu).

Až bude práce sloučená do `main`, bude odkaz bez `refs/heads/claude/…` → `refs/heads/main`. Je-li repozitář
soukromý, odkaz `raw.githubusercontent.com` nefunguje – pak nasazujte přes runner (níže) nebo podle
[../NASAZENI.md](../NASAZENI.md), krok 2 (klíč jen pro čtení) a `bash /root/Doma/kolomapa/deploy/docker/nasadit.sh`.

## Automatické nasazení (GitHub Actions + self-hosted runner)

Po každém sloučení do `main` (změny ve složce `kolomapa/`) proběhne workflow **„Kolomapa – nasazení na server“**:
testy na runneru GitHubu → když projdou, self-hosted runner na serveru pustí `nasadit.sh`. Ručně:
Actions → „Kolomapa – nasazení na server“ → *Run workflow* (jde i z rozpracované větve).

1. **Repozitář přepněte na soukromý** (Settings → Danger Zone). Self-hosted runner ve veřejném repozitáři GitHub
   nedoporučuje – kód z cizího pull requestu by se mohl dostat na váš server.
2. **Registrační token:** GitHub → Doma → *Settings → Actions → Runners → New self-hosted runner → Linux* –
   na stránce je řádek `./config.sh … --token XXXXXXXX`; token zkopírujte (platí hodinu).
3. **Na serveru** tentýž příkaz jako při prvním nasazení, jen s tokenem na konci:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/ladasuchan1-cmd/Doma/refs/heads/claude/bike-sales-monitoring-app-kufe7w/kolomapa/deploy/docker/pripravit-server.sh -o /tmp/pripravit-server.sh && sudo bash /tmp/pripravit-server.sh XXXXXXXX
   ```

   Nainstaluje runner do `/root/actions-runner-kolomapa` se štítkem **`kolomapa`** jako službu (běží jako root,
   protože nasazení upravuje konfiguraci Caddy a tak na serveru běží vše ostatní). Soukromý repozitář: runner si
   kód stáhne sám (nepotřebuje klíč) – jen `raw.githubusercontent.com` odkaz nahraďte spuštěním
   `sudo bash /root/Doma/kolomapa/deploy/docker/pripravit-server.sh XXXXXXXX` z klonu, který už na serveru je.
4. **Zapnutí:** Settings → Secrets and variables → Actions → *Variables* → `KOLOMAPA_HETZNER` = `true`.
   Bez proměnné se job `deploy` přeskočí (jinak by bez runneru visel na „Waiting for a runner“).
5. Actions → „Kolomapa – nasazení na server“ → *Run workflow*. Job `deploy` musí runner sebrat do pár vteřin.

Změny v postupu nasazení patří do `nasadit.sh`, ne do workflow – skript pouští i ruční zásah na serveru.

## Jak to běží

| Co | Kde |
|---|---|
| kód | `/root/Doma` (klon repozitáře, aplikace ve složce `kolomapa`) – při nasazení přes runner netřeba |
| nastavení | `/root/kolomapa.env` (mimo git; při prvním nasazení vznikne – s náhodným heslem jen bez Cyklo & Ski mapy) |
| přihlášení | jména a hesla Cyklo & Ski mapy: `/usr/local/sbin/kolomapa-uzivatele` → `/root/kolomapa-data/uzivatele.env` (cron každých 5 min) |
| data | `/root/kolomapa-data` → `/app/data` v kontejneru (databáze; přežije přestavbu), zálohy v `zalohy/` |
| kontejner | `kolomapa` z obrazu `kolomapa`, port 8050 |
| vrátnice | Caddy Cyklo & Ski mapy (`deploy-caddy-1`) → `https://kolomapa.37-27-203-154.sslip.io`; blok `/config/sites/kolomapa.caddy` ve svazku `caddy_config` zapíše `nasadit.sh` |
| stahování | plánovač uvnitř kontejneru (05:30 pražského času) – žádný cron |
| záloha | `/etc/cron.daily/kolomapa-zaloha` → `/root/kolomapa-data/zalohy/kolomapa-<den>.db` (7 dní dozadu) |
| log | `docker logs -f kolomapa` |

Caddy skript pozná sám – na 37.27.203.154 je to Caddy ze stacku Cyklo & Ski mapy (kontejner `deploy-caddy-1`,
Docker síť `deploy_default`, Caddyfile `/opt/Doma/cyklo-ski-mapa/deploy/Caddyfile`). Ten Caddyfile je v git klonu,
proto do něj blok nejde: Kolomapa má vlastní soubor `/config/sites/kolomapa.caddy` ve svazku `caddy_config`
(`reverse_proxy kolomapa:8050`) a Caddyfile ho načítá řádkem `import /config/sites/*.caddy` (v repozitáři je; starší
klon ho od skriptu dostane a jakmile je i na GitHubu, skript klon srovná, aby `hetzner.sh aktualizace` dál stahoval
kód). Jinde: kontejner `caddy` (blok přímo do Caddyfile podle připojeného svazku, typicky `/root/Caddyfile`), nebo
Caddy jako služba systému (`/etc/caddy/Caddyfile`, Kolomapa publikuje jen `127.0.0.1:8050`, `systemctl reload
caddy`). Když v Caddyfile je sdílený snippet `(header_sec)`, blok ho použije. Před načtením se konfigurace ověří a
při chybě se vrátí původní. Na konci skript zkusí `https://<doména>` přes Caddy (čeká 401 = chce heslo).

## Přihlášení – stejná jména a hesla jako Cyklo & Ski mapa

Cyklo & Ski mapa má uživatele v `CSM_USERS=jmeno:heslo;…` v `/opt/Doma/cyklo-ski-mapa/deploy/.env` (plní se z GitHubu,
secret `HETZNER_USERS`, při každém jejím nasazení). Kolomapa používá tentýž seznam: `nasadit.sh` založí skript
`/usr/local/sbin/kolomapa-uzivatele`, který řádky `CSM_USERS` / `CSM_PASSWORD` opisuje do
`/root/kolomapa-data/uzivatele.env` (hned a pak cronem každých 5 minut, `/etc/cron.d/kolomapa-uzivatele`); kontejner
soubor čte přes `KOLOMAPA_USERS_FILE` a změnu pozná okamžitě. Přidáte-li tedy uživatele v Cyklo & Ski mapě, do
5 minut se přihlásí i do Kolomapy – bez nasazování. Jméno se zadává bez ohledu na velikost písmen; `CSM_PASSWORD`
(společné heslo Cyklo & Ski mapy) platí jako uživatel „tým“.

Vedle toho platí `KOLOMAPA_PASSWORD` v `/root/kolomapa.env` s libovolným jménem (když je vyplněné). Nechcete-li ho,
nechte ho prázdné a spusťte `nasadit.sh`. Vlastní seznam jen pro Kolomapu: `KOLOMAPA_USERS=jana:heslo;petr:heslo2`
v `/root/kolomapa.env` – pak se z Cyklo & Ski mapy nic neopisuje. Přihlášení je HTTP Basic (okno prohlížeče);
odhlášení = zavřít prohlížeč. Session Cyklo & Ski mapy (cookie) se nesdílí – jde o stejná jména a hesla, ne o
společné přihlášení.

## Vlastní doména místo sslip.io

1. U správce domény přidejte záznam **A**, např. `kolomapa.ksprehledy.cz` → `37.27.203.154`
   (je-li doména za Cloudflare, záznam dejte „DNS only“ – šedý mráček, ať certifikát vyřídí Caddy).
2. V `/root/kolomapa.env` přepište `KOLOMAPA_DOMENA=kolomapa.ksprehledy.cz`.
3. `bash /root/Doma/kolomapa/deploy/docker/nasadit.sh` – přepíše blok v Caddy na novou doménu (u Caddy s blokem přímo
   v Caddyfile přidá nový; starý pro sslip.io můžete smazat).

## Nastavení (`/root/kolomapa.env`)

Formát `docker --env-file`: `KLÍČ=hodnota` bez uvozovek, `#` komentář. Po změně znovu spusťte `nasadit.sh`
(kontejner se musí založit znovu; `docker restart` nové hodnoty nenačte).

| Klíč | Význam |
|---|---|
| `KOLOMAPA_PASSWORD` | společné heslo do mapy (jméno libovolné); bez Cyklo & Ski mapy povinné, s ní volitelné |
| `KOLOMAPA_USERS` | vlastní uživatelé `jana:heslo;petr:heslo2` místo seznamu Cyklo & Ski mapy |
| `KOLOMAPA_DOMENA` | adresa mapy (výchozí `kolomapa.<IP-s-pomlčkami>.sslip.io`) |
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
| „nová konfigurace Caddy neprošla kontrolou“ | skript vrátil původní konfiguraci; blok přidejte ručně (je vypsaný ve skriptu) a Caddy načtěte znovu |
| prohlížeč hlásí chybu certifikátu / „internal error“ | Caddy certifikát teprve vyřizuje (do minuty), nebo o Kolomapě neví: `docker exec deploy-caddy-1 cat /config/sites/kolomapa.caddy` a `grep import /opt/Doma/cyklo-ski-mapa/deploy/Caddyfile` – chybí-li, znovu `nasadit.sh`; u vlastní domény DNS ještě neukazuje na server |
| „klon /opt/Doma má kvůli řádku import necommitnutou změnu“ | neškodí Kolomapě; jen `hetzner.sh aktualizace` (Cyklo & Ski mapa) zatím nestahuje nový kód – srovná se samo při dalším `nasadit.sh`, až bude větev Kolomapy sloučená do hlavní |
| „Kolomapa do minuty neodpověděla“ | skript vypíše posledních 40 řádků logu; typicky špatná hodnota v `/root/kolomapa.env` |
| mapa prázdná | první stahování ještě běží (stav nahoře v mapě, `docker logs kolomapa`) |
| jméno z Cyklo & Ski mapy se nepřihlásí | `cat /root/kolomapa-data/uzivatele.env` má být opis `CSM_USERS` z `/opt/Doma/cyklo-ski-mapa/deploy/.env`; jinak `/usr/local/sbin/kolomapa-uzivatele` a `docker logs kolomapa \| grep -i uživatel`; v `/root/kolomapa.env` nesmí být vlastní `KOLOMAPA_USERS` |

## Rollback

```bash
cd /root/Doma && git log --oneline -5        # commit před nasazením
git checkout <hash> && bash kolomapa/deploy/docker/nasadit.sh   # (hlášku o git pull ignorujte)
git checkout -                               # až to bude opravené
```

Databáze i nastavení zůstávají; nic se nemaže.
