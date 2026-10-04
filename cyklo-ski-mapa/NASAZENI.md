# Nasazení Cyklo & Ski mapy jako webu

Aplikace je jeden Node.js proces (`server.js`): servíruje stránku, hlídá **přihlášení** a ukládá
sdílený **stav oslovení** do `stav.json`. Před něj patří **Caddy** (HTTPS). Varianty podle serveru:
**Hetzner** (nebo jiný VPS s veřejnou adresou – doporučeno, níže), interní server Koloshopu se
systémovou Caddy (varianta B) a běh bez Dockeru (varianta C).

## Hetzner – postup od nuly (≈ 20 minut)

Potřebujete: účet na [Hetzner Cloud](https://console.hetzner.cloud/), doménu (nebo subdoménu) a
SSH klíč na svém počítači. Vše běží v Dockeru přes `deploy/docker-compose.yml`: kontejner aplikace
+ kontejner Caddy, který si sám vystaví certifikát z Let's Encrypt. Skript `deploy/hetzner.sh` dělá
instalaci, aktualizace, zálohy i návrat zpět.

**1. Server.** Hetzner Cloud → *Add Server*: lokace Norimberk nebo Falkenstein, image **Ubuntu 24.04**,
typ **CX22** (2 vCPU, 4 GB; stačí i nejmenší – aplikace potřebuje ~150 MB RAM), váš **SSH klíč**,
**Firewall** s pravidly příchozí TCP 22, 80, 443 a UDP 443, zapnuté **Backups** (7 % ceny, denní snapshot).
Do pole **Cloud config** vložte obsah `deploy/hetzner-cloud-init.yml` – server si sám nainstaluje Docker,
nastaví firewall a stáhne repozitář. (Bez cloud‑initu to udělá krok 3.)

**2. DNS.** U registrátora domény přidejte **A záznam** `mapa` (nebo jiné jméno) → IPv4 serveru
a **AAAA záznam** → IPv6 serveru (Hetzner ji dává zdarma; když AAAA nedáte, nic se neděje). Ověřte
`ping mapa.vase-domena.cz`. Než se DNS rozšíří, Caddy certifikát nedostane – proto DNS dřív než krok 3.

**3. Instalace.**

```bash
ssh root@IP_SERVERU
apt-get install -y git && git clone https://github.com/ladasuchan1-cmd/Doma.git /opt/Doma   # (přeskočit, když klonoval cloud-init)
bash /opt/Doma/cyklo-ski-mapa/deploy/hetzner.sh instalace mapa.vase-domena.cz
```

Skript doinstaluje Docker, zeptá se na **uživatele a hesla** (`jmeno:heslo;jmeno2:heslo2`; Enter =
jedno náhodné heslo pro uživatele „tým“), zapíše `deploy/.env`, postaví a spustí aplikaci i Caddy a počká,
až `https://mapa.vase-domena.cz/api/health` odpoví. Pak otevřete adresu v prohlížeči a přihlaste se.

> Pokud aplikace zatím není v hlavní větvi repa, klonujte větev, kde je:
> `git clone -b NAZEV_VETVE https://github.com/ladasuchan1-cmd/Doma.git /opt/Doma`.
> Aktualizace pak sledují tuto větev, dokud ji na serveru nepřepnete (`git -C /opt/Doma checkout main`).

**4. Zálohy a provoz.**

```bash
bash /opt/Doma/cyklo-ski-mapa/deploy/hetzner.sh zaloha --cron   # denní kopie stav.json do /opt/zalohy-cyklo-ski-mapa (60 posledních)
bash /opt/Doma/cyklo-ski-mapa/deploy/hetzner.sh stav            # kontejnery, health, disk
bash /opt/Doma/cyklo-ski-mapa/deploy/hetzner.sh log             # živý log
bash /opt/Doma/cyklo-ski-mapa/deploy/hetzner.sh aktualizace     # nový kód z GitHubu → build → výměna (při chybě vrátí předchozí)
bash /opt/Doma/cyklo-ski-mapa/deploy/hetzner.sh zpet            # ruční návrat k předchozí verzi
```

Uživatele měníte v `/opt/Doma/cyklo-ski-mapa/deploy/.env` (`CSM_USERS=…`) a `docker compose -f … up -d`
(nebo `hetzner.sh aktualizace`). Stav oslovení žije v Docker svazku `deploy_data`; záloha je obyčejný JSON,
obnova = `docker compose cp zaloha.json app:/data/stav.json && docker compose restart app`.

**5. Automatické nasazení z GitHubu** (volitelné, doporučené): po každém pushi do hlavní větve, který se
dotkne složky `cyklo-ski-mapa/`, proběhnou testy a pak se přes SSH na serveru spustí `hetzner.sh aktualizace`.

1. Na svém počítači vytvořte klíč jen pro nasazení: `ssh-keygen -t ed25519 -f ~/.ssh/csm-deploy -N ""`
   a veřejnou část přidejte na server: `ssh-copy-id -i ~/.ssh/csm-deploy.pub root@IP_SERVERU`.
2. GitHub → repo **Doma** → Settings → Secrets and variables → Actions:
   - **Secrets**: `HETZNER_HOST` = IP nebo doména serveru, `HETZNER_SSH_KEY` = obsah souboru `~/.ssh/csm-deploy`
     (soukromý klíč, celý včetně hlaviček), volitelně `HETZNER_USER` (výchozí `root`) a `HETZNER_PORT` (22).
   - **Variables**: `CSM_HETZNER` = `1` (zapíná job), volitelně `CSM_HETZNER_DIR` (výchozí `/opt/Doma/cyklo-ski-mapa`).
3. Ruční spuštění: Actions → „Cyklo & Ski mapa“ → Run workflow (hlavní větev). Výsledek je vidět v logu jobu
   `deploy-hetzner` včetně výstupu `/api/health` s verzí.

**Když Caddy nedostane certifikát** (`hetzner.sh log` hlásí ACME chyby): DNS ještě nemíří na server, nebo
nejsou otevřené porty 80/443 (Hetzner Firewall i `ufw status`). Po opravě Caddy zkouší dál sama.

**Starý Hetzner s Caddy v kontejneru** (síť `web`, `/root/Caddyfile`): použijte
`CSM_COMPOSE=docker-compose.caddy-externi.yml bash hetzner.sh instalace mapa.vase-domena.cz` a do Caddyfile
přidejte blok z `deploy/Caddyfile.externi-blok` (`reverse_proxy cyklo-ski-mapa:8090`), pak
`docker exec caddy caddy reload --config /etc/caddy/Caddyfile`.

| Co | Kde (výchozí, lze přebít proměnnými `CSM_*`) |
|---|---|
| Kód | `/home/suchan/apps/Doma/cyklo-ski-mapa` (repo `Doma`, složka aplikace) |
| Data mimo repo | `/home/suchan/cyklo-ski-mapa-data` → v kontejneru `/data` (`stav.json`, `.secret`, `.env`) |
| Konfigurace | `/home/suchan/cyklo-ski-mapa-data/.env` (vzor `.env.example`; **mimo git**) |
| Kontejner | `cyklo-ski-mapa`, port `127.0.0.1:8091` → Caddy; běží pod účtem, který nasazuje (vlastník datové složky) |
| Health | `GET /api/health` → `{"ok":true,"zaznamu":N,"zapis":true,"verze":"v2026-10-04-abc1234"}`; `zapis:false` (503) = do datové složky nejde zapisovat |

## 0. Před nasazením: DNS a hesla

1. **DNS**: A záznam domény (třeba `mapa.vase-domena.cz`) na IP serveru. U interního serveru
   s vlastní CA (jako `sales.report`) stačí interní DNS a `tls internal` v Caddy.
2. **Uživatelé**: do `.env` dejte `CSM_USERS=jmeno:heslo;jmeno2:heslo2` – každý z obchodu má své jméno,
   u každé změny stavu se pak ukládá, **kdo** ji udělal. Nebo jedno společné `CSM_PASSWORD`.
   Bez hesla server při startu vygeneruje náhodné a `deploy.sh` nasazení odmítne.

## B. Server Koloshopu (Docker + systémová Caddy)

```bash
ssh suchan@172.18.9.31
mkdir -p /home/suchan/apps /home/suchan/cyklo-ski-mapa-data
cd /home/suchan/apps && git clone https://github.com/ladasuchan1-cmd/Doma.git     # jednou
cp Doma/cyklo-ski-mapa/.env.example /home/suchan/cyklo-ski-mapa-data/.env
nano /home/suchan/cyklo-ski-mapa-data/.env        # CSM_USERS=…  (CSM_TRUST_PROXY=1 nechat)
chmod 600 /home/suchan/cyklo-ski-mapa-data/.env

cd /home/suchan/apps/Doma/cyklo-ski-mapa && bash deploy.sh
curl -s http://127.0.0.1:8091/api/health ; echo    # {"ok":true,...}
```

Pak Caddy – do `/etc/caddy/Caddyfile` přidejte blok z `deploy/Caddyfile.systemova`
(doménu nahraďte; pro interní doménu s vlastní CA přidejte `tls internal`):

```
mapa.vase-domena.cz {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8091
	header {
		Strict-Transport-Security "max-age=31536000"
		-Server
	}
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

Hotovo: <https://mapa.vase-domena.cz> → přihlašovací obrazovka → mapa.

**Aktualizace**: `cd /home/suchan/apps/Doma/cyklo-ski-mapa && bash deploy.sh` (stáhne hlavní větev z originu
– jen rychloposunem a jen když v klonu nejsou vlastní úpravy – postaví, vyzkouší ve vedlejším kontejneru, vymění;
při neúspěchu nechá běžet starou verzi). Bez stahování: `CSM_BEZ_AKTUALIZACE=1 bash deploy.sh`.
**Cesta zpět**: `bash deploy.sh --zpet`. **Log**: `docker logs cyklo-ski-mapa --tail 50`.

### Automatické nasazení z GitHubu (volitelné)

Stejně jako u R01 Sales: self-hosted runner na serveru, který po pushi do hlavní větve spustí `deploy.sh`.
Hlavní větev repa `Doma` se dnes jmenuje `claude/terms-reader-app-dl4h8h`; workflow i `deploy.sh` berou
hlavní větev z nastavení repa, takže fungují i po přejmenování na `main` (GitHub → Settings → Branches),
které doporučuji.

1. GitHub → repo **Doma** → Settings → Actions → Runners → **New self-hosted runner** (Linux x64),
   při konfiguraci zadejte label **`cyklo-ski-mapa`**; nainstalujte jako službu (`./svc.sh install && ./svc.sh start`).
   Účet, pod kterým runner běží, musí dosáhnout na docker (`sudo usermod -aG docker suchan`, nové přihlášení).
2. Settings → Secrets and variables → Actions → **Variables** → `CSM_DEPLOY` = `1`.
   Bez téhle proměnné job `deploy` neběží (jinak by čekal na neexistující runner).
3. Od té chvíle: změna ve složce `cyklo-ski-mapa/` → push/merge do hlavní větve → testy na GitHubu →
   nasazení na serveru. Ruční spuštění: Actions → „Cyklo & Ski mapa“ → Run workflow (hlavní větev).

Runner staví ze svého workspace, takže `.env` i data zůstávají jen v `/home/suchan/cyklo-ski-mapa-data`.

## Ručně přes Docker Compose (bez hetzner.sh)

Totéž, co dělá `hetzner.sh`, ručně – na libovolném VPS:

```bash
git clone https://github.com/ladasuchan1-cmd/Doma.git /opt/Doma && cd /opt/Doma/cyklo-ski-mapa/deploy
cp ../.env.example .env && nano .env            # CSM_USERS=…  a přidat řádek DOMAIN=mapa.vase-domena.cz
docker compose up -d --build
docker compose logs -f app                      # „Cyklo & Ski mapa běží…, uživatelé: …“
```

Aktualizace: `git pull && docker compose up -d --build`. Stav oslovení je ve svazku `deploy_data`
(`docker compose cp app:/data/stav.json ./zaloha.json` pro zálohu).

## C. Bez Dockeru (Node.js 22+ a systemd)

```bash
sudo apt install -y nodejs   # Node 22+ (NodeSource), nebo nvm
git clone https://github.com/ladasuchan1-cmd/Doma.git /home/suchan/apps/Doma
mkdir -p /home/suchan/cyklo-ski-mapa-data && cp /home/suchan/apps/Doma/cyklo-ski-mapa/.env.example /home/suchan/cyklo-ski-mapa-data/.env
sudo cp /home/suchan/apps/Doma/cyklo-ski-mapa/deploy/cyklo-ski-mapa.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cyklo-ski-mapa
```

Caddy stejně jako ve variantě A (`reverse_proxy 127.0.0.1:8091`). Aktualizace: `git pull && sudo systemctl restart cyklo-ski-mapa`.

## Provoz

- **Záloha stavu**: `stav.json` v datové složce (JSON, atomický zápis). Stačí ho kopírovat; obnova = nahradit
  soubor a restartovat kontejner. Alternativně z aplikace tlačítkem **Stav oslovení → Uložit zálohu**,
  nebo skriptem: `curl -H "Authorization: Bearer $CSM_TOKEN" https://mapa.vase-domena.cz/api/stav > zaloha.json`.
- **Uživatelé**: změna `CSM_USERS` v `.env` + `bash deploy.sh` (nebo `docker restart cyklo-ski-mapa`).
  Odebraný uživatel přestane platit okamžitě, i když má cookie.
- **Obnova dat (trasy, místa, weby)**: workflow **„Cyklo & Ski mapa – obnova dat“** běží 1. den v měsíci,
  commitne nová `data/*.js` do hlavní větve a spustí testy + nasazení. Jde pustit i ručně (Actions → Run workflow,
  volitelně bez průchodu webů). Lokálně: `npm run build-data && npm run enrich`.
- **Bezpečnost**: přihlášení s brzdou (10 pokusů / 15 min na IP), HttpOnly + Secure cookie (za HTTPS),
  CSP, bez indexace mimo přihlášení (bez přihlášení je vidět jen přihlašovací formulář). Hesla jsou
  v `.env` v otevřené podobě jako u R01 Sales – soubor patří jen uživateli (`chmod 600`).
- **Verze** se nepíše ručně: `deploy.sh` ji počítá z gitu (`v<datum>-<hash>`) a je v `/api/health`.
