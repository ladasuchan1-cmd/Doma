# Nasazení Mapy prodejen na mapa.ksprehledy.cz

Aplikace je jeden Node.js proces (`server.js`) v Docker kontejneru `mapa-prodejen`. Běží na **stejném serveru
(Hetzner) jako Cyklo & Ski mapa** a ven ji pouští **Caddy mapy** (kontejner projektu `deploy`, drží porty 80/443
celého serveru). Návštěvníci chodí přes **Cloudflare** (proxy), Caddy používá Cloudflare Origin certifikát
`*.ksprehledy.cz`, který spravuje nasazení Cyklo & Ski mapy. Nasazuje se z GitHub Actions přes SSH – nic dalšího
se na serveru instalovat nemusí.

```
prohlížeč ──HTTPS──▶ Cloudflare (proxy) ──HTTPS, Origin cert──▶ Caddy mapy (deploy-caddy-1, :443)
                                                                   │  /opt/caddy-extra/mapa-prodejen.caddy
                                                                   ▼
                                               kontejner mapa-prodejen :8094 (síť deploy_default)
                                                                   │
                                                  svazek mapa-prodejen-data → /data (data týmu)
```

## Zapnutí (jednou, ≈ 5 minut)

1. **DNS v Cloudflare.** Záznam `mapa` v zóně `ksprehledy.cz` musí vést na IP serveru (stejnou jako
   `cyklomapa`) a mít **zapnutou proxy (oranžový mrak)**. Bez proxy by prohlížeče Origin certifikát odmítly.
   Režim SSL/TLS **Full (strict)** a vypnutý Rocket Loader platí pro celou zónu a jsou nastavené (7. 10. 2026).
2. **GitHub → repo Doma → Settings → Secrets and variables → Actions:**
   - **Variables**: `MP_HETZNER` = `1` (zapíná nasazení). Volitelně `MP_DOMAIN` (výchozí `mapa.ksprehledy.cz`).
   - **Secrets**: použijí se ty od Cyklo & Ski mapy – `HETZNER_HOST`, `HETZNER_SSH_KEY`, `HETZNER_USER`,
     `HETZNER_PORT`. Uživatelé aplikace: volitelný secret **`MP_USERS`** (`jmeno:heslo;jmeno2:heslo2`), jinak
     se vezme `HETZNER_USERS` – tedy **stejná jména a hesla jako na cyklomapě**. Když není ani jeden, převezme
     server uživatele z nasazené Cyklo & Ski mapy.
3. **Nasazení.** Sloučit větev s aplikací do hlavní větve repa (dnes `claude/terms-reader-app-dl4h8h`) – push
   spustí workflow **„Mapa prodejen“**: testy, pak nasazení. Další nasazení: Actions → „Mapa prodejen“ →
   **Run workflow** (jde vybrat i jinou větev). Tlačítko se zobrazí až ve chvíli, kdy je workflow v hlavní větvi.
4. **Ověření.** <https://mapa.ksprehledy.cz> → přihlašovací stránka → mapa. Konec logu jobu vypíše
   `Web běží: https://mapa.ksprehledy.cz – {"ok":true,…,"verze":"v2026-10-07-abc1234"}`.

## Co nasazení dělá

Workflow pošle na server archiv složky `mapa-prodejen` přesně z testovaného commitu
(`/opt/mapa-prodejen/vydani/<commit>.tar.gz`) a spustí `deploy/server.sh nasadit` (skript přes stdin, hesla
v base64 – ne v příkazové řádce). Na serveru se nic nestahuje z gitu a nesahá se na klon Cyklo & Ski mapy.

1. Ověří, že doména v DNS nevede přímo na server (je-li zapnutý Origin certifikát Cloudflare). Kdyby vedla,
   skončí chybou dřív, než cokoli změní – web by měl neplatný certifikát a nasazení cyklomapy by u něj také
   skončilo chybou (stejnou kontrolu dělá její `hetzner.sh`).
2. Rozbalí vydání do `/opt/mapa-prodejen/vydani/<commit>/`, zapíše konfiguraci `/opt/mapa-prodejen/mapa-prodejen.env`
   (uživatelé, klíč pro podpis cookie – ten se při dalších nasazeních zachová, takže se nikdo neodhlásí).
3. Postaví image `mapa-prodejen:<commit>` a **vyzkouší ho ve vedlejším kontejneru** bez dat týmu. Když
   neodpoví, skončí chybou a ostrá verze běží dál beze změny.
4. Předchozí image označí `mapa-prodejen:predchozi`, spustí novou verzi (svazek `mapa-prodejen-data`, kořen
   jen pro čtení, `no-new-privileges`) a počká na `/api/health`. Když nová verze po výměně neodpoví, vrátí
   předchozí.
5. Zapíše blok `deploy/Caddyfile.blok` s doménou do `/opt/caddy-extra/mapa-prodejen.caddy`, **ověří celou
   konfiguraci Caddy** (i s weby ostatních projektů) a teprve pak ji načte (reload, bez výpadku). Neprojde-li
   kontrola, vrátí původní blok – ostatní weby na serveru se nezmění.
6. Nastaví denní zálohu (cron 2:40), nechá 5 posledních vydání, ověří web přes `https://<doména>/api/health`.

## Provoz

Na serveru (jako root nebo přes `sudo`):

```bash
sudo bash /opt/mapa-prodejen/app/deploy/server.sh stav     # kontejner, health, Caddy blok, vydání, poslední zálohy
sudo bash /opt/mapa-prodejen/app/deploy/server.sh log      # živý log aplikace
sudo bash /opt/mapa-prodejen/app/deploy/server.sh zaloha   # ruční záloha dat týmu
sudo bash /opt/mapa-prodejen/app/deploy/server.sh zpet     # návrat k předchozí verzi (mapa-prodejen:predchozi)
```

| Co | Kde |
|---|---|
| Aplikace | `/opt/mapa-prodejen/app` → `/opt/mapa-prodejen/vydani/<commit>/` (5 posledních vydání) |
| Konfigurace | `/opt/mapa-prodejen/mapa-prodejen.env` (`MP_USERS`, `MP_SECRET`, `MP_SESSION_DAYS`, `MP_TRUST_PROXY`; `chmod 600`, při nasazení se přepíše) |
| Kontejner | `mapa-prodejen`, image `mapa-prodejen:<commit>` (+ `:latest`, `:predchozi`), síť `deploy_default`, port 8094 jen uvnitř sítě |
| Data týmu | svazek `mapa-prodejen-data` → `/data`: `stav.json` (spolupráce), `objednavky.json` (součty podle PSČ), `mista.json` (ručně přidaná místa), `obraty.json`, `firmy.json` (dohledané v ARES), `nastaveni.json` (IČO naší firmy) |
| Zálohy | `/opt/zalohy-mapa-prodejen/<datum-čas>/` – denně ve 2:40 (`/etc/cron.d/mapa-prodejen-zaloha`), 60 nejnovějších, log `/var/log/mapa-prodejen-zaloha.log` |
| Caddy | `/opt/caddy-extra/mapa-prodejen.caddy` (v kontejneru Caddy `/etc/caddy/extra`), přístupový log v kontejneru Caddy `/data/access-mapa-prodejen.log` |
| Health | `GET /api/health` → `{"ok":true,"zapis":true,"verze":"v2026-10-07-abc1234","zaznamu":N,"mist":N,"obratu":N,"objednavek":N}`; `zapis:false` (503) = do svazku nejde zapisovat |

- **Uživatelé**: změnit secret `MP_USERS` (nebo `HETZNER_USERS`) a spustit workflow. Jména nerozlišují velikost
  písmen; odebraný uživatel přestane platit hned po nasazení, i když má cookie. Každá změna v aplikaci nese
  jméno toho, kdo ji udělal.
- **Obnova ze zálohy** (celá data týmu; server drží data v paměti a při zastavení je zapíše, proto napřed stop):

  ```bash
  Z=/opt/zalohy-mapa-prodejen/2026-10-08-0240        # vybraná záloha
  docker stop mapa-prodejen
  docker run --rm --user root -v mapa-prodejen-data:/data -v "$Z":/z:ro mapa-prodejen:latest \
    sh -c 'cp /z/*.json /data/ && chown node:node /data/*.json'
  docker start mapa-prodejen
  ```

  Jen stav spolupráce jde vrátit i z aplikace: **Data → Načíst zálohu** (záznamy se sloučí, vyhraje novější).
- **Obnova dat mapy** (prodejny, firmy, weby, PSČ): workflow **„Mapa prodejen – obnova dat“** běží 1. den
  v měsíci, commitne nová `data/*.js` do hlavní větve a spustí „Mapa prodejen“ (testy + nasazení). Ručně:
  Actions → Run workflow. Data týmu ve svazku se nemění.
- **Verze** se nepíše ručně: `v<datum commitu>-<hash>`, je v `/api/health` a v logu jobu.
- **Bezpečnost**: přihlášení s brzdou (10 chybných pokusů / 15 min z jedné adresy → 429), HttpOnly + Secure
  cookie, CSP, statické soubory s `Cache-Control: private` (Cloudflare je neukládá a nepodá nepřihlášeným),
  server a nástroje se ven neservírují. Objednávky se na server ukládají jen jako součty podle PSČ – server
  záznam s čímkoli jiným (jméno, e-mail, adresa) odmítne.

## Cloudflare a sdílená Caddy

- Adresu návštěvníka bere Caddy mapy z `CF-Connecting-IP` jen od adres Cloudflare (globální nastavení
  v `cyklo-ski-mapa/deploy/Caddyfile`) a blok mapy prodejen ji aplikaci pošle jako jedinou v `X-Forwarded-For`
  – brzda přihlášení tak počítá skutečné adresy a nejde obejít podvrženou hlavičkou.
- Origin certifikát (`/opt/caddy-origin`, v Caddy `/etc/caddy/origin`) blok importuje stejně jako cyklomapa.
  Bez něj by Caddy žádala Let's Encrypt.
- Caddy patří Cyklo & Ski mapě: její nasazení Caddyfile mění a Caddy případně restartuje (pár sekund výpadku
  všech webů). Blok mapy prodejen leží mimo její klon v `/opt/caddy-extra`, nasazení cyklomapy ho nesmaže a při
  kontrole konfigurace ho ověřuje spolu s ostatními. Když Caddy mapy neběží, není vidět ani mapa prodejen.
- Cloudflare Access na `mapa` nezapínat – aplikace má vlastní přihlášení.

## Když něco nejde

| Příznak | Příčina a řešení |
|---|---|
| Job skončí „Chybí secret HETZNER_HOST“ / klíč není použitelný | secrets cyklomapy nejsou v repu nebo je klíč chráněný heslem – viz `cyklo-ski-mapa/NASAZENI.md`, krok 5 |
| „neběží Caddy Cyklo & Ski mapy“ / „síť deploy_default neexistuje“ | na serveru neběží Cyklo & Ski mapa – napřed nasadit ji |
| „Caddy mapy nemá připojený adresář /opt/caddy-extra“ | starší nasazení cyklomapy – spustit její workflow (aktualizace) a pak znovu Mapu prodejen |
| „… vede v DNS přímo na tento server (DNS only) …“ | v Cloudflare zapnout u záznamu `mapa` proxy (oranžový mrak), počkat ~5 minut (DNS si odpověď pamatuje) a spustit workflow znovu |
| Web hlásí chybu certifikátu (526 / nedůvěryhodný certifikát) | záznam `mapa` v Cloudflare není za proxy, nebo režim SSL/TLS není Full (strict) |
| 502 od Cloudflare / Caddy | kontejner neběží: `server.sh stav`, `server.sh log`; `server.sh zpet` vrátí předchozí verzi |
| `zapis:false` v `/api/health` | svazek nejde zapisovat (práva) – `docker logs mapa-prodejen` |
| „VAROVÁNÍ: … zatím neodpovídá“ na konci nasazení | DNS ještě nevede přes Cloudflare na server; aplikace běží, stačí počkat a zkontrolovat záznam |

## Jinde než na tomto serveru

Kontejner nepotřebuje nic specifického: `docker build -t mapa-prodejen mapa-prodejen/` a
`docker run -d -p 127.0.0.1:8094:8094 -e MP_USERS='jmeno:heslo' -e MP_TRUST_PROXY=1 -v mapa-prodejen-data:/data mapa-prodejen`,
před něj libovolná reverzní proxy s HTTPS. Bez Dockeru: Node.js 22+, `MP_USERS=… MP_DATA=/srv/mapa-prodejen-data npm start`.
Proměnné popisuje `.env.example`. Server potřebuje přístup ven na `ares.gov.cz` a `ags.cuzk.cz` (dohledání firmy
a adresy při ručním přidání místa); bez něj `MP_REGISTRY=0`.
