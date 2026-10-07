# Nasazení dema Půjčovny kol na ksprehledy.cz

Aplikace je jeden Node.js proces (`server.js`, Node ≥ 22.13, 0 npm závislostí, SQLite přes `node:sqlite`). Před ním
běží **Caddy** (HTTPS z Let's Encrypt). Obojí jede v Dockeru přes `deploy/docker-compose.yml`; skript
`deploy/hetzner.sh` dělá instalaci, aktualizace, zálohy, návrat zpět, stav a log. Demo běží na pěti hostech jednoho
tenanta `demo` (SPEC kap. 0 a 5):

| Host | Design | Poznámka |
|---|---|---|
| `ksprehledy.cz` | outdoor (výchozí) | apex |
| `www.ksprehledy.cz` | outdoor | |
| `outdoor.ksprehledy.cz` | outdoor | |
| `sport.ksprehledy.cz` | sport | `themeByHost` v `tenants/demo/tenant.json` |
| `family.ksprehledy.cz` | family | |

V demo režimu (`PK_DEMO=1`) jde design přebít přepínačem `?design=…` (cookie `__Host-pk_design`), platby jsou
simulované, admin je `demo@ksprehledy.cz` / `kolo-demo-2026` a **každou noc ve 3:00 se demo data resetují**
(`PK_RESET_DEMO_HOUR`). Záloha z cronu běží ve 2:30, tedy před resetem.

## 1. DNS (dřív než instalace)

U registrátora `ksprehledy.cz` založte záznamy na IPv4 (A) a IPv6 (AAAA) serveru – Hetzner dává IPv6 zdarma, když
AAAA nedáte, nic se neděje:

| Jméno | Typ | Hodnota |
|---|---|---|
| `@` (apex) | A / AAAA | IP serveru |
| `www` | A / AAAA | IP serveru |
| `outdoor` | A / AAAA | IP serveru |
| `sport` | A / AAAA | IP serveru |
| `family` | A / AAAA | IP serveru |

Místo čtyř subdomén lze dát **wildcard** `*` (A / AAAA → IP serveru); Caddy stejně vystaví certifikát zvlášť pro
každý z pěti hostů. Doporučené navíc: `CAA 0 issue "letsencrypt.org"` a DNSSEC u registrátora (rešerše 07, kap. 3).
Nízké TTL (300 s) při startu. Ověření: `dig +short ksprehledy.cz sport.ksprehledy.cz` musí vrátit IP serveru.

**Proč dřív:** Caddy si po startu vyžádá certifikát pro každý host výzvou **HTTP-01** (nebo TLS-ALPN-01) – Let's
Encrypt musí doménu rozpoznat na portu 80/443 tohoto serveru. Host bez DNS záznamu certifikát nedostane (Caddy to
zkouší dál s rostoucím odstupem; limit Let's Encrypt je 5 neúspěšných ověření za hodinu na jméno), ostatní hosty tím
neblokuje.

## 2. Server (Hetzner, ≈ 15 minut)

Hetzner Cloud → *Add Server*: lokace Norimberk nebo Falkenstein (EU), image **Ubuntu 24.04**, typ **CX22** (2 vCPU,
4 GB; aplikace potřebuje ~150 MB RAM, demo DB má jednotky MB), váš **SSH klíč**, **Firewall** s příchozími pravidly
TCP 22, 80, 443 a UDP 443 (HTTP/3), zapnuté **Backups** (denní snapshot celého serveru). Do pole **Cloud config** lze
vložit obsah `../cyklo-ski-mapa/deploy/hetzner-cloud-init.yml` (Docker, ufw, klon repa do `/opt/Doma`) – nebo to
udělá krok 3.

> Půjčovna kol i Cyklo & Ski mapa mají každá vlastní Caddy na portech 80/443. **Na jeden server patří jen jedna
> z nich** (nebo společná Caddy – pro demo neřešíme, viz otevřené body v závěru).

## 3. Instalace – jeden příkaz na serveru

```bash
ssh root@IP_SERVERU            # nebo ssh agent@IP_SERVERU – skript se přes sudo povýší sám
sudo apt-get install -y git && sudo git clone https://github.com/ladasuchan1-cmd/Doma.git /opt/Doma   # (přeskočit, když klonoval cloud-init)
sudo bash /opt/Doma/pujcovna-kol/deploy/hetzner.sh instalace ksprehledy.cz
```

Skript doinstaluje Docker a ufw, vytvoří `deploy/.env` (demo režim, viz `deploy/.env.example`), postaví image
(`deploy/Dockerfile`), spustí aplikaci + Caddy, počká na `/api/health` uvnitř kontejneru a pak na
`https://ksprehledy.cz` a všechny čtyři subdomény, založí `/opt/zalohy-pujcovna-kol` a denní zálohu v cronu.
Kontejner aplikace při každém startu **idempotentně naplní demo data** (`tools/demo-data.js`; typy kol a ceník
upsertuje, rezervace přidá jen do prázdné tabulky).

> Pokud aplikace zatím není v hlavní větvi repa, klonujte větev, kde je: `git clone -b NAZEV_VETVE … /opt/Doma`
> (nebo `PK_VETEV=NAZEV_VETVE bash …/hetzner.sh instalace ksprehledy.cz`). Aktualizace pak sledují tuto větev.

> Nemáte zatím DNS? Dočasně poslouží `IP-S-POMLCKAMI.sslip.io` jako `PK_DOMAIN` – subdomény
> `sport.37-27-1-2.sslip.io` fungují také. Pak změníte `PK_DOMAIN=` v `deploy/.env` a spustíte `hetzner.sh aktualizace`.

## 4. Ověření

```bash
bash /opt/Doma/pujcovna-kol/deploy/hetzner.sh stav     # kontejnery, health zevnitř, https všech 5 hostů, zálohy, disk
curl -sS https://sport.ksprehledy.cz/api/health         # {"ok":true,"version":"v2026-10-06-abc1234","tenant":"demo","theme":"sport","demo":true}
curl -sSI https://ksprehledy.cz/ | grep -iE 'content-security-policy|strict-transport|^server|x-content-type'
```

Očekávané: `/api/health` na každém hostu vrací `ok:true` a `theme` podle subdomény (apex/www/outdoor → `outdoor`,
`sport` → `sport`, `family` → `family`); hlavičky CSP, `Strict-Transport-Security: max-age=300` (posílá aplikace,
ne Caddy), `X-Content-Type-Options: nosniff`; **žádná** hlavička `Server`. V prohlížeči: domovská stránka ve třech
designech (subdomény i přepínač vpravo dole), `/kola`, `/cenik`, `/mapa`, `/okoli`, `/podminky`, `/kontakt`,
rezervace se simulovanou platbou, admin `https://ksprehledy.cz/admin` (`demo@ksprehledy.cz` / `kolo-demo-2026`).

Automatický průchod prohlížečem proti běžícímu serveru (z počítače s globálně nainstalovaným Playwrightem;
rezervační tok založí v demu skutečnou rezervaci – do nočního resetu bude v adminu vidět):

```bash
cd pujcovna-kol && node --disable-warning=ExperimentalWarning tools/e2e.js --url=https://ksprehledy.cz   # screenshoty v dist/screenshots/
node tools/e2e.js --url=https://sport.ksprehledy.cz --design=sport --bez-rezervace                      # jen stránky
```

Lokálně bez serveru: `npm run e2e` spustí vlastní instanci s dočasnými daty (3 designy, rezervace, storno, mobil);
výstup hlásí chyby konzole prohlížeče, porušení CSP, odpovědi 5xx a nerozvinuté `{{…}}`; chybějící routy jen varuje.

## 5. Aktualizace a návrat zpět

```bash
bash /opt/Doma/pujcovna-kol/deploy/hetzner.sh aktualizace   # git fast-forward → záloha → build (čerstvý node:22-alpine) → výměna; při chybě vrátí předchozí
bash /opt/Doma/pujcovna-kol/deploy/hetzner.sh zpet          # ruční návrat k předchozí verzi (image pujcovna-kol:predchozi)
bash /opt/Doma/pujcovna-kol/deploy/hetzner.sh log           # živý log aplikace i Caddy
```

`aktualizace` před buildem udělá zálohu dat (migrace DB jsou jen dopředné) a uloží dosavadní image jako
`pujcovna-kol:predchozi`. Když nová verze do 90 s neodpoví na `/api/health`, skript ji sám vrátí. Verze se nepíše
ručně – počítá se z gitu (`v<datum>-<hash>`) a je v `/api/health` i v patičce.

### Automatické nasazení z GitHubu (doporučené)

Workflow `.github/workflows/pujcovna-kol.yml` po každém pushi do hlavní větve, který se dotkne `pujcovna-kol/`,
spustí testy (`npm test`, `node --check`, kontrast témat, `docker compose config`, `caddy validate`, build image +
health) a pak přes SSH na serveru `hetzner.sh aktualizace` (poprvé `instalace`).

1. Klíč jen pro nasazení, **bez passphrase**: `ssh-keygen -t ed25519 -f ~/.ssh/pk-deploy -N ""` (PowerShell 5.1:
   `-N '""'`). Veřejnou část na server: `ssh-copy-id -i ~/.ssh/pk-deploy.pub agent@IP_SERVERU` (účet jiný než root
   potřebuje `sudo` bez hesla: `echo 'agent ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/agent`).
2. GitHub → repo **Doma** → Settings → Secrets and variables → Actions:
   - **Secrets**: `HETZNER_HOST` (IP/doména serveru), `HETZNER_SSH_KEY` (celý soukromý klíč včetně hlaviček),
     volitelně `HETZNER_USER` (výchozí `root`), `HETZNER_PORT`, `PK_ADMIN_PASSWORD` (jen mimo demo). Běží-li Půjčovna
     na **jiném serveru** než Cyklo & Ski mapa, použijte `PK_HETZNER_HOST`, `PK_HETZNER_SSH_KEY`, `PK_HETZNER_USER`,
     `PK_HETZNER_PORT` – mají přednost před sdílenými.
   - **Variables**: `PK_HETZNER` = `1` (zapíná job), volitelně `PK_HETZNER_DOMAIN` (výchozí `ksprehledy.cz`),
     `PK_HETZNER_DIR` (výchozí `/opt/Doma/pujcovna-kol`).
   - Doména a heslo správce se při každém nasazení propíší do `deploy/.env` na serveru.
3. Ruční spuštění: Actions → „Půjčovna kol“ → Run workflow (hlavní větev). V logu jobu je výstup `/api/health` s verzí.

## 6. Zálohy

```bash
bash /opt/Doma/pujcovna-kol/deploy/hetzner.sh zaloha          # ručně
bash /opt/Doma/pujcovna-kol/deploy/hetzner.sh zaloha --cron   # + obnoví cron (denně 2:30, /etc/cron.d/pujcovna-kol-zaloha)
ls -la /opt/zalohy-pujcovna-kol/                              # pujcovna-kol-2026-10-06-0230.tar.gz, 30 nejnovějších
```

Archiv obsahuje: `data/db/*.db` – **konzistentní online kopie** všech `data/tenants/*.db` (uvnitř kontejneru přes
`node:sqlite` `backup()`, ekvivalent `sqlite3 .backup`; u staršího Node `VACUUM INTO`), `data/secret` – obsah
`/data/.secret` (klíč k šifrovaným polím a HMAC; **bez něj jsou údaje zákazníků nečitelné**), `data/nabidka.interni.json` –
interní ceník s nákupními cenami kol (je-li, kap. 6b), `data/platforma.db` a `data/klienti/` – pozvánky, evidence
a konfigurace webů klientů z průvodce (kap. 7c), `tenants/` – kopie
konfigurace tenantů z repa (tenant.json, logo, okoli.json, obrázky), `.env` serveru a `INFO.txt`. Archiv má práva
600, složka 700. **Obsahuje klíč i osobní údaje** – mimo server ho ukládejte jen šifrovaně (plán: restic na Hetzner
Storage Box + Litestream, PLAN kap. 12). V demu se data každou noc resetují, záloha je tedy hlavně kvůli `.secret`
a nastavení; v ostrém provozu (`PK_DEMO=0`) je to jediná záloha rezervací.

**Obnova** (svazek dat se jmenuje `pujcovna-kol_data`):

```bash
cd /opt/Doma/pujcovna-kol/deploy && docker compose stop app
mkdir -p /tmp/obnova && tar -xzf /opt/zalohy-pujcovna-kol/pujcovna-kol-2026-10-06-0230.tar.gz -C /tmp/obnova
docker run --rm -v pujcovna-kol_data:/data -v /tmp/obnova/data:/obnova:ro alpine sh -c \
  'rm -f /data/tenants/*.db-wal /data/tenants/*.db-shm && cp /obnova/db/*.db /data/tenants/ && cp /obnova/secret /data/.secret && { [ -f /obnova/nabidka.interni.json ] && cp /obnova/nabidka.interni.json /data/; true; } && { [ -f /obnova/platforma.db ] && cp /obnova/platforma.db /data/; true; } && { [ -d /obnova/klienti ] && cp -r /obnova/klienti /data/; true; } && chown -R 1000:1000 /data && chmod 600 /data/.secret; chmod 600 /data/nabidka.interni.json 2>/dev/null; true'
docker compose start app && rm -rf /tmp/obnova
```

Zkouška obnovy patří k provozu (PLAN kap. 7): aspoň jednou za čtvrtletí obnovit zálohu na testovacím serveru a
zapsat výsledek.

## 6b. Interní ceník s nákupními cenami kol (mimo git)

Konfigurátor `/nabidka` počítá marže z nákupních cen kol. Ty **nikdy nepatří do gitu ani na veřejnou stránku** – veřejný
`config/nabidka.json` je bez nich (validace by soubor s `nakupniCena` odmítla) a čtou se jen z interního souboru
v datovém svazku: `/data/nabidka.interni.json` (cesta přepsatelná `PK_NABIDKA_INTERNI`). Vzor s ukázkovými hodnotami
je `config/nabidka.interni.example.json`; změna souboru se projeví do 2 s bez restartu. Bez souboru konfigurátor běží
s odhadem (prodejní cena × (1 − práh marže)) a interní blok pro správce to označí varováním. Nákupní ceny a marže vidí jen
přihlášený správce platformy (`/platforma`, heslo `PK_PLATFORMA_HESLO`) v interním bloku `/nabidka` a v `/admin/nabidky` – správce
tenanta ne (heslo administrace dema je veřejné). Bez `PK_PLATFORMA_HESLO` je nevidí nikdo.

Zápis na serveru (svazek dat se jmenuje `pujcovna-kol_data`; hodnoty vyplňte podle skutečnosti – do gitu, chatu ani
e-mailu je nekopírujte):

```bash
cat > /root/nabidka.interni.json <<'JSON'
{
  "tridyKol": { "zakladni": { "nakupniCena": 0 }, "trek": { "nakupniCena": 0 }, "ekolo": { "nakupniCena": 0 } },
  "modely": {
    "superior-exp-6-4-steps": { "nakupniCena": 0 },
    "superior-exp-6-4-steps-suv": { "nakupniCena": 0 },
    "superior-eway-6-4": { "nakupniCena": 0 },
    "rock-machine-eblizzard-30-s": { "nakupniCena": 0 },
    "rock-machine-crossride-e400-b-touring": { "nakupniCena": 0 },
    "superior-racer-20": { "nakupniCena": 0 }
  }
}
JSON
docker run --rm -v pujcovna-kol_data:/data -v /root/nabidka.interni.json:/src.json:ro alpine sh -c \
  'cp /src.json /data/nabidka.interni.json && chown 1000:1000 /data/nabidka.interni.json && chmod 600 /data/nabidka.interni.json'
shred -u /root/nabidka.interni.json
docker logs pujcovna-kol --since 10s 2>&1 | grep -i 'nabídka'   # „konfigurace cen načtena … interniSoubor: nabidka.interni.json“
```

Nákupní cena 0 znamená „nenastaveno“ (třída se pak počítá odhadem). Soubor je součástí zálohy (`hetzner.sh zaloha` →
`data/nabidka.interni.json` v archivu) a při obnově se kopíruje spolu s `.secret`.

## 7. Přechod na wildcard certifikát (DNS-01) – ostrá verze

Demo používá certifikát **zvlášť pro každý host** (HTTP-01 per host): nejjednodušší, bez DNS API klíče na serveru.
Nevýhody pro muster s desítkami půjčoven (rešerše 07, kap. 2): každá nová subdoména čeká na vydání certifikátu, názvy
klientů jsou veřejně v Certificate Transparency lozích a platí limity Let's Encrypt (50 certifikátů / doména / týden).
Ostrá verze proto přejde na **wildcard `*.<domena>` + apex přes DNS-01**:

1. DNS u poskytovatele s API: Cloudflare jen jako DNS (šedý mrak) s tokenem omezeným na zónu (`Zone:Read`,
   `DNS:Edit`), nebo Hetzner DNS; nejlépe delegace `_acme-challenge` CNAME do oddělené zóny (`acmedns`/`desec`/
   `rfc2136`), aby klíč na serveru nemohl měnit ostré DNS. Záznamy: `A/AAAA` apex + `*`.
2. Vlastní image Caddy s DNS pluginem (připnuté verze, Dependabot), místo `image: caddy:2-alpine` v compose:
   ```dockerfile
   FROM caddy:2-builder AS build
   RUN xcaddy build --with github.com/caddy-dns/cloudflare
   FROM caddy:2-alpine
   COPY --from=build /usr/bin/caddy /usr/bin/caddy
   ```
   a do `.env` token (`CF_API_TOKEN=…`), který compose předá službě `caddy`.
3. Caddyfile: jeden blok pro apex i wildcard s DNS výzvou; Caddy ≥ 2.10 použije wildcard automaticky i pro
   konkrétní subdomény:
   ```
   {$PK_DOMAIN}, *.{$PK_DOMAIN} {
       tls {
           dns cloudflare {$CF_API_TOKEN}
           resolvers 1.1.1.1
       }
       encode zstd gzip
       header -Server
       log { … }
       reverse_proxy app:8092
   }
   ```
4. On-demand TLS (`on_demand_tls { ask http://app:8092/api/tls-ask }`) jen pro případné vlastní domény půjčoven po
   pilotu; HSTS `max-age` zvyšovat postupně (300 → týden → měsíc → rok s `includeSubDomains`) v `src/http/headers.js`;
   PSL a preload až vědomě po pilotu.

## 7b. Vedle Cyklo & Ski mapy na jednom serveru (37.27.203.154)

Na serveru, kde už běží Cyklo & Ski mapa (její kontejner Caddy drží porty 80 a 443), se půjčovna spouští jen jako
aplikace v téže Docker síti a Caddy mapy dostane blok pro doménu půjčovny (`import /etc/caddy/extra/*.caddy`
v `cyklo-ski-mapa/deploy/Caddyfile`, adresář `/opt/caddy-extra` připojený v jejím `docker-compose.yml`). Vše dělá
`deploy/vedle-mapy.sh`:

```bash
ssh root@37.27.203.154
bash /opt/Doma/pujcovna-kol/deploy/vedle-mapy.sh instalace ksprehledy.cz
```

Skript: přepne repo `/opt/Doma` na větev s půjčovnou (`PK_VETEV`, výchozí `claude/quirky-ramanujan-cjewtf`; po
sloučení do hlavní větve nastavte `PK_VETEV=main`), ověří Docker síť Caddy mapy (`deploy_default`; jinak
`PK_CADDY_SIT=…`), znovu vytvoří Caddy mapy s připojeným `/opt/caddy-extra` (výpadek mapy jen na sekundy), zapíše
blok `/opt/caddy-extra/pujcovna-kol.caddy`, Caddy znovu načte a spustí `hetzner.sh instalace` s
`PK_COMPOSE=docker-compose.vedle-mapy.yml` (aplikace bez vlastní Caddy, zálohy a cron jako obvykle). Firewall
se neřeší (`PK_UFW=0`) – mapa ho už nastavila.

**DNS u Cloudflare** (doména `ksprehledy.cz` je dnes za Cloudflare proxy s Cloudflare Access): pro `ksprehledy.cz`,
`www`, `outdoor`, `sport` a `family` nastavte záznamy **A → 37.27.203.154** v režimu **DNS only (šedý mrak)**, aby
Let's Encrypt na serveru mohl vystavit certifikáty, a pro tyto hosty vypněte aplikaci Cloudflare Access (jinak
návštěvníky zastaví přihlašovací stránka Cloudflare). Chcete-li demo chránit přihlášením, je lepší to řešit až po
nasazení (Access lze zapnout zpět při oranžovém mraku a režimu SSL „Full (strict)“).

Aktualizace a provoz: `vedle-mapy.sh aktualizace | stav | log | zaloha | zpet`. Logy Caddy pro půjčovnu jsou
v kontejneru Caddy mapy (`/data/access-pujcovna-kol.log`).

## 7c. Weby klientů – průvodce pro novou půjčovnu (od 7. 10. 2026)

Nová půjčovna si web založí sama: provozovatel jí pošle **pozvánku** (jednorázový odkaz, platí 14 dní), klient projde
**průvodcem** na `https://www.ksprehledy.cz/zalozeni/<token>` (provozovna a IČO, adresa webu a poloha výdeje, design
a logo, kola z naší nabídky s cenou za den, otevírací doba a rezervační poplatek, účet správce a souhlas se smlouvami)
a web se po potvrzení **hned spustí** na `<název>.ksprehledy.cz` v **náhledovém provozu**: rezervace i administrace
fungují, platby jsou simulované a stránky nesou pruh „náhledový provoz“. Ostrý provoz se zapíná ve správě platformy
po podpisu smlouvy a nastavení plateb.

**Co nastavit jednou:**

1. **DNS:** u Cloudflare záznam **A `*` → 37.27.203.154** (wildcard) v režimu **DNS only** (šedý mrak). Bez něj nové
   subdomény nevedou na server.
2. **Heslo správy platformy:** v GitHubu *Settings → Secrets and variables → Actions → New repository secret*
   `PK_PLATFORMA_HESLO` (alespoň 12 znaků) a spustit nasazení (Actions → Půjčovna kol → Run workflow, zaškrtnout
   „vedle_mapy“). Heslo se propíše do `deploy/.env`. Bez něj je `/platforma` vypnutá.
3. Nasazení samo nastaví cron `/etc/cron.d/pujcovna-kol-caddy-sync` (každou minutu `vedle-mapy.sh caddy-sync`).

**Běžná práce:** `https://www.ksprehledy.cz/platforma` → přihlásit heslem platformy → *Nová pozvánka* (název
a e-mail klienta) → odkaz se zobrazí jednou, tlačítko otevře předvyplněný e-mail. Z poptávky v administraci
(`/admin/nabidky/<id>`) vede tlačítko *Pozvat do průvodce* s předvyplněnými údaji. Na stejné stránce je přehled webů
klientů a přepínání stavu *Náhledový provoz / Ostrý provoz / Pozastaveno* (pozastavený web vrací 503).
Záloha bez webového rozhraní (na serveru):

```bash
docker exec pujcovna-kol node --disable-warning=ExperimentalWarning tools/pozvanka.js --email jana@hotel.cz --nazev "Hotel U Tří dubů"
```

**Kde co leží (datový svazek `pujcovna-kol_data`, přežije nasazení):** `/data/klienti/<slug>/tenant.json` a logo,
`/data/tenants/<slug>.db` (DB klienta), `/data/platforma.db` (pozvánky – token jen jako otisk, e-mail a rozpracovaný
průvodce šifrovaně – a evidence klientů), `/data/caddy-hosty.txt` (hosty klientů pro Caddy). Noční reset dema se
klientů netýká; zálohu dělá `hetzner.sh zaloha` (DB klientů v `data/db/`, `data/platforma.db` a `data/klienti/`;
obnova viz kap. 6).

**Jak se nová subdoména dostane do Caddy:** aplikace po založení zapíše host do `/data/caddy-hosty.txt`; cron
`caddy-sync` z něj složí `/opt/caddy-extra/pujcovna-kol-klienti.caddy` (stejné nastavení jako hlavní blok), ověří celou
konfiguraci Caddy mapy (`caddy validate`) a teprve pak ji načte – při chybě vrátí předchozí stav a zapíše chybu do
`/var/log/pujcovna-kol-caddy-sync.log`. Certifikát Let's Encrypt se vystaví při prvním požadavku, celkem do ~2 minut.
Ručně: `bash /opt/Doma/pujcovna-kol/deploy/vedle-mapy.sh caddy-sync`.

> Samostatné nasazení s vlastní Caddy (`deploy/docker-compose.yml`, kap. 3) průvodce zatím nesynchronizuje – weby
> klientů tam fungují, ale jejich hosty je potřeba do `deploy/Caddyfile` doplnit ručně.

## 7d. Odesílání e-mailů provozovateli – SMTP (od 7. 10. 2026)

Poptávky z konfigurátoru `/nabidka` a dotazy z kontaktního formuláře se vždy uloží do fronty (admin → E-maily, `/admin/nabidky`).
Se zapnutým SMTP je job `mail-sender` (každou minutu) navíc **odešle na e-mail půjčovny** z `tenant.json` (u dema
`info@ksprehledy.cz`) s **Reply-To tazatele** – odpovědí v poště odpovídáte rovnou jemu.

**Zapnutí:** v GitHubu (Settings → Secrets and variables → Actions) secrets `PK_SMTP_HOST` (Thinline / Český hosting:
`smtp.cesky-hosting.cz`), `PK_SMTP_PORT` (`465`), `PK_SMTP_USER` (`info@ksprehledy.cz`), `PK_SMTP_PASS` (heslo schránky) a znovu
nasadit. Workflow je pošle na server v base64 a `hetzner.sh` je zapíše do `deploy/.env` (heslo jako `PK_SMTP_PASS_B64`, aby
znaky `$` a uvozovky nerozbily soubor); hodnoty se nikde nevypisují. Ruční provoz: stejné proměnné v `deploy/.env`
(`PK_SMTP_PASS` nebo `PK_SMTP_PASS_B64`, volitelně `PK_SMTP_FROM`, `PK_SMTP_SECURE=starttls` pro port 587).

**Co se posílá:** jen typy `nabidka` a `contact_inquiry`, jen u webů platformy (demo), ne u webů klientů, a jen řádky mladší
7 dní (zapnutí nerozešle starou frontu). **E-maily zákazníkům (potvrzení rezervací, platby, připomínky) se neposílají** –
demo má smyšlené rezervace. Chyba (špatné heslo, odmítnutý adresát) → `attempts + 1`, chyba v admin → E-maily, další pokus za
5 × počet pokusů minut, po 5 pokusech konec; log obsahuje jen id, typ a text odpovědi serveru, nikdy adresy ani obsah.

**DNS:** aby pošta z `ksprehledy.cz` nekončila ve spamu, přidejte v Cloudflare TXT záznam SPF podle pokynů poskytovatele
schránky (Thinline / Český hosting). Odesílací server `smtp.cesky-hosting.cz` má jinou IP adresu než přijímací servery
z MX – samotné `mx` v SPF nestačí.

## 8. Když něco nejde

- **Caddy nedostane certifikát** (`hetzner.sh log` hlásí ACME chyby): DNS záznam daného hostu nemíří na server,
  nebo nejsou otevřené porty 80/443 (Hetzner Firewall i `ufw status`). Po opravě Caddy zkouší dál sama. Po 5
  neúspěších za hodinu na jedno jméno čeká Let's Encrypt – nepomáhá restartovat dokola.
- **Aplikace nestartuje**: `docker compose -f /opt/Doma/pujcovna-kol/deploy/docker-compose.yml logs app`. Typicky
  práva `/data` (musí vlastnit uid 1000 = `node`), nebo chybějící `PK_ADMIN_PASSWORD` mimo demo (vygeneruje se a
  vypíše do logu).
- **Demo data chybí / chci je znovu**: `PK_SEED_RESET=1` do `.env`, `docker compose up -d app`, pak řádek zase
  odebrat (jinak se resetují při každém restartu). Noční reset dělá totéž ve 3:00.
- **Port 80/443 obsazený**: na serveru už běží jiná Caddy/nginx (např. Cyklo & Ski mapa) – demo potřebuje vlastní
  server, nebo společnou proxy s `reverse_proxy 127.0.0.1:8092` (publikovat port `app` jen na 127.0.0.1).
- **Změna domény**: `PK_DOMAIN=` v `deploy/.env` (nebo variable `PK_HETZNER_DOMAIN`) + `hetzner.sh aktualizace`;
  hosty musí být i v `tenants/demo/tenant.json` → `hosts`, jinak aplikace v ostrém režimu vrátí 404 „Půjčovna
  nenalezena“ (v demu spadne na tenant `demo`).

## 9. Provoz, bezpečnost a GDPR

- **Logy**: aplikace loguje JSON bez osobních údajů (`LOG_LEVEL`), Docker je rotuje (20 MB × 5). Access log Caddy
  (`/data/access.log` ve svazku `pujcovna-kol_caddy_data`) obsahuje IP adresy: rotace 20 MB × 5, **14 dní**
  (`roll_keep_for 336h`) – v mezích „technických a bezpečnostních logů“ Zásad ochrany osobních údajů.
- **Hlavičky**: CSP bez `unsafe-inline`, HSTS, `nosniff`, `frame-ancestors 'none'` posílá aplikace; Caddy jen
  skrývá `Server`. Cookies jsou `__Host-` (bez `Domain`), nepřetékají mezi subdoménami.
- **Kontejner**: `USER node`, souborový systém jen ke čtení (`read_only`, zápis jen `/data` a `/tmp`),
  `no-new-privileges`, healthcheck na `/api/health`.
- **Tajemství**: `deploy/.env` (600) a `/data/.secret` (600). Při odchodu člověka s přístupem na server klíč
  nerotujeme automaticky (rotace klíče polí = TODO ostré verze).
- **Aktualizace systému**: `apt-get upgrade` + reboot podle Hetzner oznámení; `hetzner.sh aktualizace` staví s
  `--pull`, takže bere čerstvý `node:22-alpine` i `caddy:2-alpine`.

| Co | Kde (výchozí, lze přebít proměnnými `PK_*` skriptu) |
|---|---|
| Kód | `/opt/Doma/pujcovna-kol` (repo `Doma`) |
| Konfigurace serveru | `/opt/Doma/pujcovna-kol/deploy/.env` (vzor `deploy/.env.example`, **mimo git**) |
| Data | svazek `pujcovna-kol_data` → v kontejneru `/data` (`tenants/demo.db`, `.secret`) |
| Certifikáty, access log | svazky `pujcovna-kol_caddy_data`, `pujcovna-kol_caddy_config` |
| Zálohy | `/opt/zalohy-pujcovna-kol/` (30 posledních), cron `/etc/cron.d/pujcovna-kol-zaloha`, log `/var/log/pujcovna-kol-zaloha.log` |
| Kontejnery | `pujcovna-kol-app-1` (port 8092 jen v síti compose), `pujcovna-kol-caddy-1` (80, 443) |
| Health | `GET /api/health` → `{ ok, version, tenant, theme, demo }` |

## Ručně přes Docker Compose (bez hetzner.sh)

```bash
git clone https://github.com/ladasuchan1-cmd/Doma.git /opt/Doma && cd /opt/Doma/pujcovna-kol/deploy
cp .env.example .env && nano .env            # PK_DOMAIN=ksprehledy.cz
docker compose up -d --build
docker compose logs -f app                   # „Půjčovna kol běží …“
```

Aktualizace: `git pull && docker compose build --pull app && docker compose up -d`. Lokálně bez Dockeru:
`npm run demo-data && npm start` (README).
