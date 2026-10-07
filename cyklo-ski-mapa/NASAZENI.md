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

**3. Instalace** – jeden příkaz na serveru (jako root, nebo účet se `sudo`):

```bash
ssh root@IP_SERVERU            # nebo ssh agent@IP_SERVERU – skript se přes sudo povýší sám
sudo apt-get install -y git && sudo git clone https://github.com/ladasuchan1-cmd/Doma.git /opt/cyklo-ski-mapa/Doma   # (přeskočit, když klonoval cloud-init)
sudo bash /opt/cyklo-ski-mapa/Doma/cyklo-ski-mapa/deploy/hetzner.sh instalace mapa.vase-domena.cz
```

Skript doinstaluje Docker, zeptá se na **uživatele a hesla** (`jmeno:heslo;jmeno2:heslo2`; Enter =
jedno náhodné heslo pro uživatele „tým“), zapíše `deploy/.env`, postaví a spustí aplikaci i Caddy a počká,
až `https://mapa.vase-domena.cz/api/health` odpoví. Pak otevřete adresu v prohlížeči a přihlaste se.
Bez dotazu: `sudo env CSM_USERS='lada:heslo;obchod:heslo2' bash …/hetzner.sh instalace mapa.vase-domena.cz`.

> Nemáte zatím doménu? Dočasně poslouží `IP-S-POMLCKAMI.sslip.io` (např. `37-27-203-154.sslip.io`) – veřejná DNS
> služba, která jméno překládá na tu IP, takže Caddy dostane platný certifikát. Vlastní doménu pak nastavíte
> změnou `DOMAIN=` v `deploy/.env` a `hetzner.sh aktualizace`.

> Pokud aplikace zatím není v hlavní větvi repa, klonujte větev, kde je:
> `git clone -b NAZEV_VETVE https://github.com/ladasuchan1-cmd/Doma.git /opt/cyklo-ski-mapa/Doma`.
> Aktualizace pak sledují tuto větev, dokud ji na serveru nepřepnete (`git -C /opt/cyklo-ski-mapa/Doma checkout main`).

**4. Zálohy a provoz.**

```bash
bash /opt/cyklo-ski-mapa/Doma/cyklo-ski-mapa/deploy/hetzner.sh zaloha          # ruční záloha stav.json do /opt/zalohy-cyklo-ski-mapa (denní ve 2:30 se nastaví sama, 60 posledních)
bash /opt/cyklo-ski-mapa/Doma/cyklo-ski-mapa/deploy/hetzner.sh stav            # kontejnery, health, disk
bash /opt/cyklo-ski-mapa/Doma/cyklo-ski-mapa/deploy/hetzner.sh log             # živý log
bash /opt/cyklo-ski-mapa/Doma/cyklo-ski-mapa/deploy/hetzner.sh aktualizace     # nový kód z GitHubu → build → výměna (při chybě vrátí předchozí)
bash /opt/cyklo-ski-mapa/Doma/cyklo-ski-mapa/deploy/hetzner.sh zpet            # ruční návrat k předchozí verzi
```

Uživatele měníte v `/opt/cyklo-ski-mapa/Doma/cyklo-ski-mapa/deploy/.env` (`CSM_USERS=…`) a `docker compose -f … up -d`
(nebo `hetzner.sh aktualizace`). Stav oslovení žije v Docker svazku `deploy_data`; záloha je obyčejný JSON,
obnova = `docker compose cp zaloha.json app:/data/stav.json && docker compose restart app`.

**5. Automatické nasazení z GitHubu** (volitelné, doporučené): po každém pushi do hlavní větve, který se
dotkne složky `cyklo-ski-mapa/`, proběhnou testy a pak se přes SSH na serveru spustí `hetzner.sh aktualizace`.

1. Na svém počítači vytvořte klíč jen pro nasazení, **bez passphrase**: `ssh-keygen -t ed25519 -f ~/.ssh/csm-deploy -N ""`
   (ve Windows PowerShellu 5.1 je prázdná passphrase `-N '""'`, v PowerShellu 7 `-N ""`; když se ssh-keygen ptá
   na passphrase, jen dvakrát potvrďte Enter). Veřejnou část přidejte na server: `ssh-copy-id -i ~/.ssh/csm-deploy.pub agent@IP_SERVERU`
   (účet, pod kterým se workflow přihlásí; jiný než root potřebuje `sudo` bez hesla: `echo 'agent ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/agent`).
   Ve Windows bez `ssh-copy-id`: `type $HOME\.ssh\csm-deploy.pub | ssh agent@IP_SERVERU "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"`.
   Soukromý klíč do schránky: `Get-Content $HOME\.ssh\csm-deploy | Set-Clipboard` (nekopírujte výběrem textu z okna konzole,
   přidává mezery; workflow si klíč sice očistí, ale otisk v logu jobu musí odpovídat tomu, který vypsal ssh-keygen).
2. GitHub → repo **Doma** → Settings → Secrets and variables → Actions:
   - **Secrets**: `HETZNER_HOST` = IP nebo doména serveru, `HETZNER_SSH_KEY` = obsah souboru `~/.ssh/csm-deploy`
     (soukromý klíč, celý včetně hlaviček), `HETZNER_USER` (např. `agent`; výchozí `root`), `HETZNER_USERS` =
     `jmeno:heslo;jmeno2:heslo2` (přihlášení do aplikace; jména nerozlišují velikost písmen), volitelně `HETZNER_PORT`.
   - **Variables**: `CSM_HETZNER` = `1` (zapíná job), `CSM_HETZNER_DOMAIN` = doména webu,
     volitelně `CSM_HETZNER_DIR` (výchozí `/opt/cyklo-ski-mapa/Doma/cyklo-ski-mapa`), `CSM_CLOUDFLARE` (viz oddíl
     Cloudflare), `CSM_ACCESS_AUD` (přihlášení e-mailem Koloshopu, viz oddíl Cloudflare Access).
   - **Uživatelé i doména se při každém nasazení propíší na server** (do `deploy/.env`). Změna hesla nebo nový
     kolega = upravit secret `HETZNER_USERS` a spustit workflow (Actions → „Cyklo & Ski mapa“ → Run workflow);
     nová doména = změnit variable `CSM_HETZNER_DOMAIN` (po nastavení DNS) a spustit workflow.
3. Job `deploy-hetzner` pozná, zda aplikace na serveru je: když ne, provede **první instalaci** (pošle skript přes
   SSH a ten doinstaluje Docker, naklonuje repo, nastaví uživatele i doménu), jinak **aktualizaci**. Ruční spuštění:
   Actions → „Cyklo & Ski mapa“ → Run workflow (hlavní větev); v logu jobu je i výstup `/api/health` s verzí.

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
git clone https://github.com/ladasuchan1-cmd/Doma.git /opt/cyklo-ski-mapa/Doma && cd /opt/cyklo-ski-mapa/Doma/cyklo-ski-mapa/deploy
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

## Cloudflare před serverem (od 7. 10. 2026)

Doména `ksprehledy.cz` má DNS u Cloudflare. Když se u záznamu zapne proxy (oranžový mrak), chodí návštěvníci
přes Cloudflare a server je zvenčí vidět jen pro Cloudflare. Co to pro aplikaci znamená a jak se to zapíná:

> **Stav od 7. 10. 2026: zapnuto.** Za proxy jsou všechny weby na serveru – `cyklomapa`, weby Půjčovny kol
> (`outdoor`, `sport`, `family`, `www`; `ksprehledy.cz` je za Cloudflare Access) a `kolomapa` (projekt Kolomapa).
> Variable `CSM_CLOUDFLARE` = `1`, Caddy používá Origin certifikát (`*.ksprehledy.cz`, platí do 3. 10. 2041),
> Let's Encrypt se pro tyto weby už neobnovuje. Rocket Loader i Email Address Obfuscation jsou pro celou zónu
> vypnuté. Do té doby měla každá doména certifikát od Let's Encrypt a vedla přímo na server.

1. **Origin certifikát.** Caddy si normálně bere certifikát od Let's Encrypt přímým ověřením serveru; za proxy
   je to nespolehlivé. Místo něj se použije Cloudflare Origin certifikát: Cloudflare → SSL/TLS → Origin Server →
   *Create Certificate*, hostnames `*.ksprehledy.cz` a `ksprehledy.cz`, platnost 15 let. Certifikát do secretu
   `CSM_ORIGIN_CERT`, soukromý klíč do `CSM_ORIGIN_KEY` (celé PEM od řádku BEGIN po END; klíč nikam jinam).
   Nasazení oba ověří (platný pár; vypíše platnost a hostnames) a uloží je na server do `/opt/caddy-origin/`
   (Caddy je vidí jako `/etc/caddy/origin`). V Cloudflare → SSL/TLS → Overview musí být režim **Full (strict)**.
2. **Proxy zapnout u všech webů na serveru, které certifikát pokrývá.** Jakmile Caddy Origin certifikát načte,
   podá ho každému svému webu v `ksprehledy.cz` – i Půjčovně kol – a Let's Encrypt pro ně přestane obnovovat
   (ověřeno na Caddy 2.11). Prohlížeče Origin certifikátu bez Cloudflare nevěří. Nejdřív proto oranžový mrak
   u všech webů na serveru (seznam viz Stav výše; nový web přidaný jiným projektem kontrola v kroku 3 najde sama).
   Do zapnutí běží dál Let's Encrypt a nic se nemění – Cloudflare v režimu Full (strict) certifikát od Let's
   Encrypt přijme, takže přepnutí mráčku je bez výpadku.
3. **Zapnutí:** variable `CSM_CLOUDFLARE` = `1` a Run workflow. Skript projde všechny weby sdílené Caddy (blok mapy
   i importy dalších projektů), a pokud některý pokrytý certifikátem vede DNS pořád přímo na server, skončí chybou
   s jejich jmény – nic nezapne. Jinak zapíše `/opt/caddy-origin/tls.caddy`, ověří konfiguraci a Caddy znovu načte.
   Hodnota `0` vrátí Let's Encrypt (až po vypnutí proxy); prázdná proměnná nic nemění. Ruční běh skriptu na serveru
   nastavení nepřepíná. **Po zapnutí** musí být za proxy i každý nový web v `ksprehledy.cz` na tomto serveru
   (např. web klienta Půjčovny kol) – jinak dostane Origin certifikát a prohlížeče ho odmítnou. Kontrola se ptá
   DNS serveru, které si odpověď pamatuje až 5 minut: když skončí chybou u webu, který už za proxy je, stačí
   nasazení za pár minut zopakovat (7. 10. 2026 to tak bylo s `kolomapa`).
4. **Skutečné IP adresy.** Za proxy vidí server adresy Cloudflare. Caddy hlavičkám s adresou klienta věří jen od
   adres Cloudflare (`trusted_proxies` v `Caddyfile`) a adresu bere z `CF-Connecting-IP`, kterou Cloudflare vždy
   přepíše. Aplikaci pak pošle v `X-Forwarded-For` jedinou adresu (`header_up X-Forwarded-For {client_ip}`),
   protože brzda přihlášení bere první adresu z té hlavičky. Bez toho by si útočník mohl adresu vymyslet a brzdu
   (10 pokusů / 15 min) obejít. Ověřeno 7. 10. 2026 na Caddy 2.11 se skutečnou aplikací: přes Cloudflare dostane
   aplikace adresu návštěvníka, při přímém spojení vždy adresu spojení, podvržené hlavičky se zahodí a jedenáctý
   pokus skončí 429. Seznam adres Cloudflare je v Caddyfile, Cloudflare ho mění zřídka
   (https://www.cloudflare.com/ips). Ostatní weby na sdílené Caddy dostávají za Cloudflare v `X-Forwarded-For`
   celý řetězec. Půjčovna kol z něj bere poslední adresu, takže za Cloudflare vidí adresu Cloudflare místo
   návštěvníka; oprava je stejný `header_up X-Forwarded-For {client_ip}` v jejím bloku (projekt Půjčovny kol).
5. **Nastavení Cloudflare:** **Rocket Loader** (Speed → Settings → Content Optimization) musí být vypnutý – přepisuje
   skripty na stránkách a přísná CSP aplikace by je zablokovala; je vypnutý výchozím stavem (ověřeno 7. 10. 2026).
   **Email Address Obfuscation** (Security → Settings, filtr *Client-side abuse*) je výchozím stavem zapnutá,
   pro `ksprehledy.cz` je od 7. 10. 2026 vypnutá. Mapu neovlivní (e-maily jsou v datech, ne v HTML), ale na webech
   Půjčovny kol Cloudflare v HTML nahrazoval e-maily textem „[email protected]“ a dekódoval je až svým skriptem
   v prohlížeči.
   Auto Minify Cloudflare v roce 2024 zrušil. Cloudflare Access na `cyklomapa` nezapínat, aplikace má vlastní
   přihlášení. Cache: statické soubory posílá aplikace jako
   `Cache-Control: private`, Cloudflare je tedy neukládá a nepodá je nepřihlášeným; po měsíční obnově dat nic nevisí.
6. **Firewall (volitelně):** když jsou všechny weby za proxy, lze porty 80/443 omezit jen na adresy Cloudflare
   (Hetzner Cloud Firewall) – server pak zvenčí neodpovídá vůbec.

## Přihlášení přes Cloudflare Access – e-mail Koloshopu (od 7. 10. 2026)

Do mapy se dostane jen člověk s e-mailem **@koloshop.cz**, kterého pustí Cloudflare Access – stejně jako
u R01 Sales. Jména a hesla aplikace (`HETZNER_USERS`) se v tomto režimu nepoužívají a přihlásit se jimi nejde.

> **Stav: zapnuto 7. 10. 2026.** Aplikace v Zero Trust pro `cyklomapa.ksprehledy.cz`, tým `bold-dust-a2b5`,
> AUD končí `…7dd58cf6`, e-maily `@koloshop.cz`. Nasazení ověřilo, že server bez tokenu Access vrací 403.
> Do té doby se přihlašovalo jménem a heslem aplikace; záznamy z té doby mají ve sloupci „Upravil“ jméno,
> novější e-mail.

**Jak to funguje.** Cloudflare Access stojí před webem: nepřihlášenému vrátí svou přihlašovací stránku (tým
`bold-dust-a2b5`). Přihlášenému přidá Cloudflare ke každému požadavku na server podepsaný token
(`Cf-Access-Jwt-Assertion`). Aplikace ho ověří – podpis klíčem týmu Access (stahuje
`https://bold-dust-a2b5.cloudflareaccess.com/cdn-cgi/access/certs`, při rotaci klíčů znovu), vydavatele, aplikaci
(AUD), platnost a doménu e-mailu – a bez platného tokenu nepustí nikoho, ani při obejití Cloudflare přímo na adresu
serveru (stránka 403, API 401). Kdo změnu udělal, je e-mail z tokenu. Veřejné zůstává jen `/api/health` (kontrola
kontejneru). Ověření odpovídá `core/cfaccess.py` v R01 Sales, stejné jsou i názvy proměnných v `.env`
(`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`; navíc `CF_ACCESS_DOMENY` jako pojistka k pravidlu v Cloudflare).

**Zapnutí:**
1. Cloudflare → **Zero Trust → Access controls → Applications → Create new application → Self-hosted and
   private → Add public hostname** `cyklomapa.ksprehledy.cz`. Pravidlo (policy): **Allow**, Include **Emails ending
   in** `@koloshop.cz` – nebo stávající pravidlo pro Koloshop z R01 Sales. Přihlašovací metody a délku relace
   (Session Duration, např. 1 týden) podle zvyklosti. Uložit.
2. V téže aplikaci **Configure → Additional settings** zkopírovat **Application Audience (AUD) Tag**. Když ho
   tam Cloudflare neukáže (7. 10. 2026 nebyl vidět), stačí ho vzít z přesměrování na přihlášení – je to parametr
   `kid`:
   ```bash
   curl -sS -o /dev/null -w '%{redirect_url}' https://cyklomapa.ksprehledy.cz/ | sed -n 's/.*[?&]kid=\([0-9a-f]*\).*/\1/p'
   ```
3. GitHub → Settings → Secrets and variables → Actions → **Variables**: `CSM_ACCESS_AUD` = AUD tag. Volitelně
   `CSM_ACCESS_TEAM` (výchozí `bold-dust-a2b5`) a `CSM_ACCESS_DOMENY` (výchozí `koloshop.cz`, víc domén čárkou).
4. Actions → „Cyklo & Ski mapa“ → Run workflow. Skript nejdřív ověří, že `https://cyklomapa.ksprehledy.cz/`
   opravdu vede na přihlášení Access tohoto týmu; jinak skončí chybou a nic nezmění (aplikace by bez tokenu zamkla
   všechny). Pak zapíše `CF_ACCESS_*` do `.env`, aplikace se restartuje a skript ověří, že server sám bez tokenu
   odpovídá 403.

**Vypnutí:** variable `CSM_ACCESS_AUD` = `0` a Run workflow – platí zase jména a hesla (`HETZNER_USERS`). Aplikaci
v Zero Trust pak smažte, jinak se přihlašuje dvakrát.

**Noví a odcházející kolegové:** nikam se nepřidávají – pravidlo „Emails ending in @koloshop.cz“ pustí každého
s firemním e-mailem. Odchod = zrušení firemního e-mailu nebo výjimka v pravidle Access.

**Skripty s `CSM_TOKEN`** (Bearer) aplikace pustí dál, přes Cloudflare je ale zastaví Access – fungují jen přímo
na serveru (`curl -k --resolve cyklomapa.ksprehledy.cz:443:127.0.0.1 …`) nebo se service tokenem Access.

## Provoz

- **Záloha stavu**: `stav.json` v datové složce (JSON, atomický zápis). Stačí ho kopírovat; obnova = nahradit
  soubor a restartovat kontejner. Alternativně z aplikace tlačítkem **Stav oslovení → Uložit zálohu**,
  nebo skriptem: `curl -H "Authorization: Bearer $CSM_TOKEN" https://mapa.vase-domena.cz/api/stav > zaloha.json`.
- **Uživatelé**: s Cloudflare Access (od 7. 10. 2026) je určuje pravidlo v Zero Trust – e-maily @koloshop.cz,
  viz oddíl výše. Bez něj `CSM_USERS` v `.env` (na Hetzneru secret `HETZNER_USERS`) + nasazení; odebraný
  uživatel přestane platit okamžitě, i když má cookie.
- **Obnova dat (trasy, místa, weby)**: workflow **„Cyklo & Ski mapa – obnova dat“** běží 1. den v měsíci,
  commitne nová `data/*.js` do hlavní větve a spustí testy + nasazení. Jde pustit i ručně (Actions → Run workflow,
  volitelně bez průchodu webů). Lokálně: `npm run build-data && npm run enrich`.
- **Bezpečnost**: přihlášení s brzdou (10 pokusů / 15 min na IP), HttpOnly + Secure cookie (za HTTPS),
  CSP, bez indexace mimo přihlášení (bez přihlášení je vidět jen přihlašovací formulář). Hesla jsou
  v `.env` v otevřené podobě jako u R01 Sales – soubor patří jen uživateli (`chmod 600`).
- **Verze** se nepíše ručně: `deploy.sh` ji počítá z gitu (`v<datum>-<hash>`) a je v `/api/health`.
- **Další weby na témže serveru (od 7. 10. 2026).** Caddy mapy drží porty 80/443 pro celý server, proto ji
  využívají i další projekty z tohoto repa: **Půjčovna kol** (bloky v `/opt/caddy-extra/*.caddy`, zapisuje
  `pujcovna-kol/deploy/vedle-mapy.sh`; adresář je připojený v `docker-compose.yml`) a **Kolomapa**
  (`/config/sites/*.caddy` ve svazku `caddy_config`). Oba adresáře `Caddyfile` importuje – prázdné nevadí.
  Řádky jsou v repu proto, aby je nasazení mapy nesmazalo a weby ostatních projektů nespadly.
- **Vlastní klon mapy (od 7. 10. 2026).** Server sdílí Půjčovna kol a Kolomapa, které mají klon v `/opt/Doma`
  a přepínají si v něm své větve – nasazení mapy z něj tak jednou nasadilo cizí větev. Mapa má proto vlastní klon
  `/opt/cyklo-ski-mapa/Doma` (variable `CSM_HETZNER_DIR`). Při prvním nasazení do nového místa skript převzal
  `.env` ze starého; kontejnery, svazky (`deploy_data` se stavem oslovení, `deploy_caddy_data` s certifikáty)
  i síť `deploy_default`, do které se připojuje Půjčovna kol, zůstaly, protože projekt Compose se jmenuje pořád
  `deploy`. Skript `pujcovna-kol/deploy/vedle-mapy.sh` na Caddy mapy sahá přes jméno projektu, takže funguje dál;
  `.env` v `/opt/Doma/cyklo-ski-mapa/deploy` už ale není ten platný. Nasazení z GitHubu navíc předává `CSM_VETEV`:
  kdyby v klonu byla jiná větev s odlišnou aplikací, skončí chybou místo tichého nasazení cizího kódu.
- **Caddy při nasazení (od 7. 10. 2026).** Nový `Caddyfile` se ještě před nasazením ověří v dočasném kontejneru
  se všemi importy (bloky Půjčovny kol a Kolomapy, Origin certifikát). Neprojde-li, nasazení skončí chybou
  a weby běží beze změny. Po nasazení se Caddy načte znovu: `Caddyfile` je do kontejneru připojený jako soubor
  a git ho při aktualizaci nahradí novým, takže běžící Caddy ho reloadem nenačte. Když se změnil, skript Caddy
  restartuje, a to znamená pár sekund výpadku všech webů na serveru. Změnám v `/opt/caddy-origin` stačí reload.
- **Staré místo `/opt/Doma/cyklo-ski-mapa` už nespouštějte.** Skript pouštěný ze starého klonu by kontejnery
  projektu `deploy` přestavěl z cizí větve; nová verze skriptu to pozná a skončí chybou s cestou ke správnému
  místu. Ruční příkazy: `sudo bash /opt/cyklo-ski-mapa/Doma/cyklo-ski-mapa/deploy/hetzner.sh stav | log | …`.
