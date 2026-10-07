#!/usr/bin/env bash
# Nasazení Kolomapy na server s Dockerem a Caddy (Hetzner) – stejný vzor jako ostatní aplikace (r01sales, projekty,
# import-web, Cyklostezky a sjezdovky): kontejner, ven ho pouští Caddy. Postup a instalace runneru: HETZNER.md.
#
# Skript běží NA SERVERU – pouští ho GitHub Actions přes self-hosted runner (štítek „kolomapa“), nebo ručně
# v konzoli Hetzneru:   bash /root/Doma/kolomapa/deploy/docker/nasadit.sh
# Jen stav (nic nenasazuje): bash …/nasadit.sh --stav – kontejner, Caddy, řádek import, blok, certifikáty, logy.
# Je schválně jeden pro obě cesty, aby se ruční zásah a automat nerozešly. Lze spouštět opakovaně.
#
# Co se kde drží:
#   kód        /root/Doma (klon repozitáře, aplikace ve složce kolomapa) – ruční spuštění si stáhne novou verzi
#   nastavení  /root/kolomapa.env (mimo git; při prvním nasazení vznikne – s náhodným heslem, když na serveru není
#              Cyklo & Ski mapa; jinak se přihlašuje jejími jmény a hesly, viz níže)
#   přihlášení jména a hesla Cyklo & Ski mapy (CSM_USERS v jejím .env, typicky /opt/Doma/cyklo-ski-mapa/deploy/.env):
#              skript /usr/local/sbin/kolomapa-uzivatele je opisuje do /root/kolomapa-data/uzivatele.env (hned a pak
#              cronem každých 5 minut), kontejner ho čte přes KOLOMAPA_USERS_FILE a změnu pozná hned – jeden seznam
#              uživatelů pro obě aplikace. Navíc platí KOLOMAPA_PASSWORD (libovolné jméno), je-li vyplněné.
#   data       /root/kolomapa-data → /app/data (databáze; přežije přestavbu obrazu), zálohy v podsložce zalohy/
#   kontejner  „kolomapa“ z obrazu „kolomapa“, port 8050
#   vrátnice   Caddy → https://<KOLOMAPA_DOMENA>; výchozí doména kolomapa.<IP-serveru>.sslip.io (bez vlastní DNS,
#              např. kolomapa.37-27-203-154.sslip.io), nebo vlastní (kolomapa.ksprehledy.cz + záznam A)
#   stahování  plánovač uvnitř kontejneru (05:30 pražského času) – žádný cron není potřeba
#   záloha     /etc/cron.daily/kolomapa-zaloha → /root/kolomapa-data/zalohy/kolomapa-<den>.db (7 dní dozadu)
#
# Caddy skript pozná sám:
#   a) v kontejneru – jménem „caddy“ (ksprehledy.cz), nebo z obrazu caddy (docker compose Cyklo & Ski mapy:
#      deploy-caddy-1): Kolomapa na stejné Docker síti, „reverse_proxy kolomapa:8050“, reload přes docker exec.
#      Blok jde do Caddyfile na hostiteli (podle připojeného svazku, typicky /root/Caddyfile). Když je Caddyfile
#      v git klonu (cyklo-ski-mapa/deploy/Caddyfile v /opt/Doma) a Caddy má svazek /config, blok jde do souboru
#      /config/sites/kolomapa.caddy a v Caddyfile je jen řádek „import /config/sites/*.caddy“ (v repozitáři
#      commitnutý) – Caddyfile zůstává beze změny a klon čistý (hetzner.sh aktualizace jinak kód nestahuje);
#   b) jako služba systému (/etc/caddy/Caddyfile): Kolomapa publikuje 127.0.0.1:8050, blok
#      „reverse_proxy 127.0.0.1:8050“, systemctl reload caddy;
#   c) jinak blok jen vypíše (přidáte ručně).
#
# Přihlášení jen e-mailem Koloshopu (Cloudflare Access, jako sales/projekty.ksprehledy.cz) – postup v HETZNER.md:
#   KOLOMAPA_CF_TUNEL_TOKEN=eyJ… KOLOMAPA_CF_ACCESS_EMAILS=@koloshop.cz bash nasadit.sh
#   - tunel: kontejner „kolomapa-tunel“ (cloudflared) na stejné Docker síti; Kolomapa jde ven JEN tunelem, Caddy pro
#     její doménu nic neobsluhuje (přímý přístup na server mimo Cloudflare neexistuje); token v /root/kolomapa-tunel.env,
#   - Access: tým a AUD aplikace skript zjistí sám z přesměrování https://<doména> na přihlášení Cloudflare (nebo
#     KOLOMAPA_CF_ACCESS_TEAM / _AUD) a zapíše je do /root/kolomapa.env; Kolomapa pak pustí jen požadavek s platným
#     podepsaným tokenem Cloudflare Access pro povolený e-mail – heslo ani jména Cyklo & Ski mapy se nepoužívají.
# Když cokoli selže (stavba, testy v obrazu, Caddy), starý kontejner běží dál.
set -euo pipefail

APP=kolomapa                                   # jméno kontejneru (odkazuje se na něj Caddyfile a cron zálohy)
IMAGE=kolomapa
KOD="${KOLOMAPA_KOD:-/root/Doma}"
ENV_SOUBOR="${KOLOMAPA_ENV:-/root/kolomapa.env}"
DATA="${KOLOMAPA_DATA:-/root/kolomapa-data}"
PORT=8050
CADDY="${CADDY_KONTEJNER:-}"                   # jméno kontejneru Caddy; prázdné = najít sám (caddy, deploy-caddy-1 …)
CADDY_CONFIG="${CADDY_CONFIG:-/etc/caddy/Caddyfile}"   # cesta uvnitř kontejneru caddy
CADDY_SITES=/config/sites                      # soubory dalších webů ve svazku caddy_config (řádek import v Caddyfile)
IMPORT_RADEK="import $CADDY_SITES/*.caddy"
IMPORT_KOMENTAR="# Další weby na tomto serveru (Kolomapa …): soubory $CADDY_SITES/*.caddy (přidal kolomapa/deploy/docker/nasadit.sh)"
ZALOHA_CRON="${KOLOMAPA_ZALOHA_CRON:-/etc/cron.daily/kolomapa-zaloha}"
CSM_ENV="${CSM_ENV:-}"                         # .env Cyklo & Ski mapy (CSM_USERS); prázdné = najít vedle jejího Caddyfile
UZIVATELE_SKRIPT="${KOLOMAPA_UZIVATELE_SKRIPT:-/usr/local/sbin/kolomapa-uzivatele}"
UZIVATELE_CRON="${KOLOMAPA_UZIVATELE_CRON:-/etc/cron.d/kolomapa-uzivatele}"
UZIVATELE_SOUBOR=uzivatele.env                 # v $DATA → /app/data/uzivatele.env v kontejneru (KOLOMAPA_USERS_FILE)
TUNEL=kolomapa-tunel                           # kontejner cloudflared (Cloudflare tunel), jen s tokenem tunelu
TUNEL_ENV="${KOLOMAPA_TUNEL_ENV:-/root/kolomapa-tunel.env}"   # TUNNEL_TOKEN=… (chmod 600; Kolomapa ho nevidí)
TUNEL_IMAGE="${KOLOMAPA_TUNEL_IMAGE:-cloudflare/cloudflared:latest}"
STAV=""; [[ "${1:-}" == "--stav" ]] && STAV=1

say() { printf '\n\033[1m→ %s\033[0m\n' "$*"; }
die() { printf '\nCHYBA: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker není nainstalovaný (spouštíte to na správném serveru?)"
docker info >/dev/null 2>&1 || die "uživatel $(whoami) nedosáhne na docker (chybí práva, nebo docker neběží)"

# --- Odkud se staví --------------------------------------------------------------------------------------------
# Z runneru je to jeho workspace s už vytaženým commitem (git na serveru netřeba). Ruční spuštění z /root/Doma si
# napřed stáhne nejnovější verzi větve, kterou má klon vybranou.
ZDROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKRIPT="$ZDROJ/deploy/docker/nasadit.sh"
[[ -f "$ZDROJ/Dockerfile" && -f "$ZDROJ/server.js" ]] || die "skript musí ležet v kolomapa/deploy/docker (nenašel jsem $ZDROJ/Dockerfile)"
if [[ "$ZDROJ" == "$KOD/kolomapa" ]] && git -C "$KOD" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  say "Ruční spuštění v $KOD – stahuji nejnovější verzi ($(git -C "$KOD" rev-parse --abbrev-ref HEAD))"
  OTISK_PRED="$(sha256sum "$SKRIPT" | cut -d' ' -f1)"
  if git -C "$KOD" pull --ff-only; then
    # Bash čte běžící skript ze starého souboru – když pull přinesl nový nasadit.sh, pokračoval by starý postup
    # nad novým kódem. Proto se nová verze spustí znovu (jen jednou; druhý běh už nic nestáhne).
    if [[ "$(sha256sum "$SKRIPT" | cut -d' ' -f1)" != "$OTISK_PRED" && -z "${KOLOMAPA_NASADIT_ZNOVU:-}" ]]; then
      echo "   nasadit.sh se aktualizoval – spouštím znovu jeho novou verzi"
      KOLOMAPA_NASADIT_ZNOVU=1 exec bash "$SKRIPT" "$@"
    fi
  else
    echo "VAROVÁNÍ: klon se nedostal na GitHub (soukromý repozitář bez klíče? bez sítě?) – stavím to, co na serveru je."
  fi
else
  say "Stavím z $ZDROJ (kód dodal runner / aktuální složka)"
fi
echo "   verze: $(git -C "$ZDROJ" log -1 --format='%h (%cd) %s' --date=format:'%Y-%m-%d %H:%M' 2>/dev/null || echo '?')"

# --- Caddy: kde a jak --------------------------------------------------------------------------------------------
# Kontejner Caddy: jméno z CADDY_KONTEJNER, jinak „caddy“, jinak jediný běžící kontejner z obrazu caddy nebo se
# „caddy“ ve jméně (docker compose je pojmenovává <projekt>-caddy-1 – u Cyklo & Ski mapy deploy-caddy-1).
najdi_caddy() {
  local kandidati
  if [[ -n "$CADDY" ]]; then
    docker ps --format '{{.Names}}' | grep -qx "$CADDY" || die "kontejner Caddy „$CADDY“ (CADDY_KONTEJNER) neběží"
    return 0
  fi
  if docker ps --format '{{.Names}}' | grep -qx caddy; then CADDY=caddy; return 0; fi
  kandidati="$(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /(^|\/)caddy(:|@|$)/ || $1 ~ /caddy/ {print $1}')"
  case "$(grep -c . <<<"$kandidati")" in
    0) return 1 ;;
    1) CADDY="$kandidati" ;;
    *) die "běží víc kontejnerů Caddy ($(tr '\n' ' ' <<<"$kandidati")) – vyberte: CADDY_KONTEJNER=jmeno bash nasadit.sh" ;;
  esac
}
mount_zdroj() { docker inspect "$1" --format '{{range .Mounts}}{{if eq .Destination "'"$2"'"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true; }
mount_typ()   { docker inspect "$1" --format '{{range .Mounts}}{{if eq .Destination "'"$2"'"}}{{.Type}}{{end}}{{end}}' 2>/dev/null || true; }
git_klon() {   # Caddyfile sledovaný gitem (cyklo-ski-mapa/deploy/Caddyfile v /opt/Doma) → cesta klonu; jinak nic
  local d; d="$(dirname "$1")"
  if git -C "$d" ls-files --error-unmatch "$(basename "$1")" >/dev/null 2>&1; then git -C "$d" rev-parse --show-toplevel 2>/dev/null || true; fi
}

REZIM=none     # docker | system | none
ZPUSOB=blok    # blok = blok rovnou do Caddyfile; sites = soubor /config/sites/kolomapa.caddy (Caddyfile v git klonu)
KLON=""
SIT="${KOLOMAPA_SIT:-}"
if najdi_caddy; then
  REZIM=docker
  if [[ -z "${CADDYFILE:-}" ]]; then
    # Caddyfile na hostiteli = zdroj svazku připojeného do kontejneru jako /etc/caddy/Caddyfile
    CADDYFILE="$(mount_zdroj "$CADDY" "$CADDY_CONFIG")"
    CADDYFILE="${CADDYFILE:-/root/Caddyfile}"
  fi
  if [[ -z "$SIT" ]]; then
    # první uživatelská Docker síť kontejneru caddy (na ní se Kolomapa najde jménem); bez ní síť „web“ + připojit caddy
    SIT="$(docker inspect "$CADDY" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | tr ' ' '\n' | grep -vx -e bridge -e host -e none -e '' | head -1 || true)"
    SIT="${SIT:-web}"
  fi
  CIL="$APP:$PORT"
  KLON="$(git_klon "$CADDYFILE")"
  if [[ -n "$KLON" && -n "$(mount_typ "$CADDY" "$(dirname "$CADDY_SITES")")" ]]; then ZPUSOB=sites; fi
elif command -v caddy >/dev/null && [[ -f "${CADDYFILE:-/etc/caddy/Caddyfile}" ]]; then
  REZIM=system
  CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
  CIL="127.0.0.1:$PORT"
else
  CADDYFILE="${CADDYFILE:-/root/Caddyfile}"
  CIL="127.0.0.1:$PORT"
fi
SIT="${SIT:-web}"
echo "   Caddy: $REZIM${CADDY:+ (kontejner $CADDY)}${CADDYFILE:+, $CADDYFILE}${KLON:+ – v git klonu $KLON}, Docker síť: $SIT"
if [[ "$REZIM" == none ]]; then
  echo "VAROVÁNÍ: Caddy jsem nenašel – žádný běžící kontejner z obrazu caddy (ani se „caddy“ ve jméně) a caddy není ani služba."
  echo "          Běžící kontejnery: $(docker ps --format '{{.Names}} ({{.Image}})' | tr '\n' ' ')"
  echo "          Bez Caddy se mapa z internetu neotevře. Jiné jméno kontejneru: CADDY_KONTEJNER=jmeno bash nasadit.sh"
fi

# --- Uživatelé Cyklo & Ski mapy ---------------------------------------------------------------------------------
# Běží-li na serveru Cyklo & Ski mapa (její .env s CSM_USERS / CSM_PASSWORD), přihlašuje se do Kolomapy stejnými
# jmény a hesly. Vlastní KOLOMAPA_USERS / KOLOMAPA_USERS_FILE v /root/kolomapa.env mají přednost (pak se nic neopisuje).
if [[ -z "$CSM_ENV" ]]; then
  if [[ -n "$KLON" ]]; then CSM_ENV="$(dirname "$CADDYFILE")/.env"; else CSM_ENV=/opt/Doma/cyklo-ski-mapa/deploy/.env; fi
fi
UZIVATELE=""   # csm = z Cyklo & Ski mapy, vlastni = KOLOMAPA_USERS(_FILE) v kolomapa.env, prázdné = jen KOLOMAPA_PASSWORD
if [[ -f "$CSM_ENV" ]] && grep -qE '^CSM_(USERS|PASSWORD)=.' "$CSM_ENV"; then UZIVATELE=csm; fi

# --- Nastavení (/root/kolomapa.env) -----------------------------------------------------------------------------
# Výchozí doména: kolomapa.<veřejná IP serveru s pomlčkami>.sslip.io – funguje bez vlastní DNS, Caddy si pro ni
# vyřídí certifikát sama. Vlastní doménu (kolomapa.ksprehledy.cz) stačí zapsat do KOLOMAPA_DOMENA a přidat záznam A.
vychozi_domena() {   # kolomapa.<IP>.sslip.io podle veřejné IP serveru; bez ní prázdné (KOLOMAPA_VYCHOZI_DOMENA = přepis pro zkoušky)
  local ip
  if [[ -n "${KOLOMAPA_VYCHOZI_DOMENA:-}" ]]; then echo "$KOLOMAPA_VYCHOZI_DOMENA"; return; fi
  ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -vE '^(10\.|127\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)' | head -1 || true)"
  [[ -n "$ip" ]] && echo "kolomapa.${ip//./-}.sslip.io"
}
VYCHOZI_DOMENA="$(vychozi_domena)"
NOVE_HESLO=""
if [[ ! -f "$ENV_SOUBOR" ]]; then
  if [[ "$UZIVATELE" == csm ]]; then
    say "Zakládám $ENV_SOUBOR – přihlášení jmény a hesly Cyklo & Ski mapy ($CSM_ENV), bez dalšího hesla"
  else
    say "Zakládám $ENV_SOUBOR s náhodným heslem"
    NOVE_HESLO="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-20)"
  fi
  cat >"$ENV_SOUBOR" <<EOF
# Nastavení Kolomapy na serveru (vytvořil kolomapa/deploy/docker/nasadit.sh). Formát docker --env-file:
# KLÍČ=hodnota bez uvozovek. Po změně znovu spusťte nasadit.sh (kontejner se musí založit znovu, docker restart
# nové hodnoty nenačte). Všechny volby: kolomapa/README.md a src/config.js.

# Adresa mapy. sslip.io = podle IP serveru, bez vlastní DNS. Vlastní doména: přepsat a přidat záznam A na IP serveru.
KOLOMAPA_DOMENA=${KOLOMAPA_DOMENA:-$(vychozi_domena)}

# Přihlášení: na serveru s Cyklo & Ski mapou platí její jména a hesla (CSM_USERS v jejím .env; nasadit.sh je opisuje do
# data/uzivatele.env, změna se projeví do 5 minut). Navíc může platit společné heslo s libovolným jménem:
KOLOMAPA_PASSWORD=$NOVE_HESLO
# Vlastní seznam místo Cyklo & Ski mapy (pak se nic neopisuje): jana:heslo;petr:heslo2
#KOLOMAPA_USERS=
# Jen firemní e-maily přes Cloudflare Access (pak heslo ani jména neplatí) – zapíná nasadit.sh, viz HETZNER.md:
#KOLOMAPA_CF_ACCESS_EMAILS=@koloshop.cz

# Čas denního stahování (pražský čas):
#KOLOMAPA_SCHEDULE=05:30

# Weby – výchozí bazos. Ostatní viz README.md (Zdroje, šetrnost a pravidla).
#KOLOMAPA_SOURCES=bazos

# Cyklobazar potřebuje prohlížeč: 1 = při příštím nasazení se do obrazu přidá Chromium (~400 MB).
#KOLOMAPA_PROHLIZEC=1

# AI nacenění podle fotek (placené, klíč z console.anthropic.com):
#ANTHROPIC_API_KEY=
EOF
  chmod 600 "$ENV_SOUBOR"
fi
hodnota() { sed -n "s/^$1=//p" "$ENV_SOUBOR" | tail -1 | tr -d '\r'; }
uloz_hodnotu() {   # KLÍČ HODNOTA → /root/kolomapa.env (přepíše řádek, nebo připíše)
  local v="${2//\\/\\\\}"; v="${v//&/\\&}"; v="${v//|/\\|}"
  if grep -q "^$1=" "$ENV_SOUBOR"; then sed -i "s|^$1=.*|$1=$v|" "$ENV_SOUBOR"; else printf '\n%s=%s\n' "$1" "$2" >>"$ENV_SOUBOR"; fi
}
DOMENA="${KOLOMAPA_DOMENA:-$(hodnota KOLOMAPA_DOMENA)}"
DOMENA="${DOMENA:-$VYCHOZI_DOMENA}"
PROHLIZEC="${KOLOMAPA_PROHLIZEC:-$(hodnota KOLOMAPA_PROHLIZEC)}"
[[ -n "$DOMENA" ]] || die "nenašel jsem veřejnou IP adresu serveru – zadejte doménu: KOLOMAPA_DOMENA=mapa.vase-domena.cz bash nasadit.sh"
[[ "$DOMENA" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || die "KOLOMAPA_DOMENA=„$DOMENA“ nevypadá jako doména"
# Doména zadaná proměnnou (KOLOMAPA_DOMENA=… bash nasadit.sh) se zapíše do nastavení, aby platila i pro příští nasazení.
if [[ -z "$STAV" && -n "${KOLOMAPA_DOMENA:-}" && "$(hodnota KOLOMAPA_DOMENA)" != "$KOLOMAPA_DOMENA" ]]; then
  say "Doména $KOLOMAPA_DOMENA → zapisuji do $ENV_SOUBOR"
  uloz_hodnotu KOLOMAPA_DOMENA "$KOLOMAPA_DOMENA"
fi

# Certifikát, který Caddy na tomto serveru podává pro doménu (vydavatel, platnost) – za proxy Cloudflare má být
# Cloudflare Origin (Cyklo & Ski mapa ho zapíná pro všechny weby, které pokrývá: CSM_CLOUDFLARE=1); Let's Encrypt by
# za proxy neobnovila.
cert_na_serveru() {
  command -v openssl >/dev/null || return 0
  echo | timeout 10 openssl s_client -connect 127.0.0.1:443 -servername "$DOMENA" 2>/dev/null \
    | openssl x509 -noout -issuer -enddate 2>/dev/null | sed -E 's/^issuer= *//; s/"//g; s/^notAfter=/· platí do /' | cut -c1-90 | tr '\n' ' ' || true
}

# --- Cloudflare Access + tunel (přihlášení jen e-mailem Koloshopu) ------------------------------------------------
# Tým a AUD aplikace jsou vidět v přesměrování na přihlášení: https://<tým>.cloudflareaccess.com/cdn-cgi/access/login/
# <doména>?kid=<AUD>&… – Cloudflare ho pošle každému, kdo doménu otevře bez přihlášení (Access stojí před tunelem
# i před serverem, takže to funguje, i když tunel ještě neběží).
zjisti_access() {
  local loc re='^https://([a-z0-9-]+)\.cloudflareaccess\.com/cdn-cgi/access/login/[^?]*\?(.*&)?kid=([0-9a-fA-F]{16,128})(&|$)'
  loc="$(curl -s -o /dev/null -m 15 -w '%{redirect_url}' "https://$DOMENA/" 2>/dev/null || true)"
  if [[ "$loc" =~ $re ]]; then
    CF_TEAM="${CF_TEAM:-${BASH_REMATCH[1]}}"
    CF_AUD="${CF_AUD:-${BASH_REMATCH[3]}}"
    return 0
  fi
  echo "   https://$DOMENA nepřesměrovává na přihlášení Cloudflare Access (${loc:-žádné přesměrování})"
  return 1
}
CF_TEAM="${KOLOMAPA_CF_ACCESS_TEAM:-$(hodnota KOLOMAPA_CF_ACCESS_TEAM)}"
CF_AUD="${KOLOMAPA_CF_ACCESS_AUD:-$(hodnota KOLOMAPA_CF_ACCESS_AUD)}"
CF_EMAILS="${KOLOMAPA_CF_ACCESS_EMAILS:-$(hodnota KOLOMAPA_CF_ACCESS_EMAILS)}"
TUNEL_TOKEN_NOVY=""
if [[ -n "${KOLOMAPA_CF_TUNEL_TOKEN:-}" ]]; then
  # stačí token, ale vloží-li se celý příkaz z Cloudflare („docker run … --token eyJ…“), token se z něj vybere
  TUNEL_TOKEN_NOVY="$(grep -oE 'eyJ[A-Za-z0-9_=+/-]{40,}' <<<"$KOLOMAPA_CF_TUNEL_TOKEN" | head -1 || true)"
  [[ -n "$TUNEL_TOKEN_NOVY" ]] || die "KOLOMAPA_CF_TUNEL_TOKEN nevypadá jako token tunelu (začíná eyJ…) – zkopírujte ho z příkazu, který Cloudflare u tunelu ukáže (záložka Docker)"
fi
TUNEL_ZAP=""; [[ -n "$TUNEL_TOKEN_NOVY" || -f "$TUNEL_ENV" ]] && TUNEL_ZAP=1
ACCESS=""
if [[ -n "$CF_TEAM$CF_AUD$CF_EMAILS" ]]; then
  ACCESS=1
  if [[ -z "$STAV" ]]; then
    if [[ -z "$CF_TEAM" || -z "$CF_AUD" ]]; then
      say "Cloudflare Access: zjišťuji tým a aplikaci z přihlašovací stránky https://$DOMENA"
      zjisti_access || die "Cloudflare Access pro $DOMENA nevidím. Založte v Cloudflare Zero Trust aplikaci (Access → Applications → Self-hosted, doména $DOMENA, politika: e-maily končící na ${CF_EMAILS:-@koloshop.cz}) a doménu veďte přes Cloudflare (tunel nebo oranžový mráček) – postup v HETZNER.md. Nebo zadejte KOLOMAPA_CF_ACCESS_TEAM a KOLOMAPA_CF_ACCESS_AUD ručně."
      echo "   tým: $CF_TEAM, AUD aplikace: $CF_AUD"
    fi
    [[ "$CF_TEAM" =~ ^[A-Za-z0-9.-]+$ && "$CF_AUD" =~ ^[A-Za-z0-9,-]+$ ]] || die "KOLOMAPA_CF_ACCESS_TEAM / _AUD vypadají divně („$CF_TEAM“, „$CF_AUD“)"
    for k in TEAM AUD EMAILS; do
      v="CF_$k"; v="${!v}"
      if [[ -n "$v" && "$(hodnota "KOLOMAPA_CF_ACCESS_$k")" != "$v" ]]; then uloz_hodnotu "KOLOMAPA_CF_ACCESS_$k" "$v"; ZAPSANO_ACCESS=1; fi
    done
    [[ -n "${ZAPSANO_ACCESS:-}" ]] && echo "   Cloudflare Access zapsané do $ENV_SOUBOR (tým $CF_TEAM${CF_EMAILS:+, e-maily $CF_EMAILS})"
  fi
  UZIVATELE=access   # heslo ani jména Cyklo & Ski mapy se nepoužívají
fi
if [[ -z "$ACCESS" ]] && grep -qE '^KOLOMAPA_USERS(_FILE)?=.' "$ENV_SOUBOR"; then UZIVATELE=vlastni; fi
[[ -n "$UZIVATELE" ]] || grep -q '^KOLOMAPA_PASSWORD=.\+' "$ENV_SOUBOR" || die "v $ENV_SOUBOR chybí KOLOMAPA_PASSWORD (a na serveru není Cyklo & Ski mapa s uživateli) – mapa na internetu musí mít heslo"
HESLO_TAKE="$(hodnota KOLOMAPA_PASSWORD)"

# --- Jen stav (--stav) ------------------------------------------------------------------------------------------
# Co potřebuje vidět člověk, když se mapa neotevře: běží kontejner? zná Caddy doménu? je řádek import i blok tam, kde
# je Caddy čte? má certifikát? co říká log? Nic nemění.
if [[ -n "$STAV" ]]; then
  say "Stav Kolomapy na tomto serveru"
  echo "Kontejner:    $(docker ps -a --filter "name=^$APP\$" --format '{{.Status}}, obraz {{.Image}}' | head -1)"
  echo "Doména:       $DOMENA${VYCHOZI_DOMENA:+   (adresa podle IP: $VYCHOZI_DOMENA)}"
  if [[ -n "$ACCESS" ]]; then
    echo "Přihlášení:   Cloudflare Access – tým ${CF_TEAM:-?}, AUD ${CF_AUD:0:12}${CF_AUD:+…}, e-maily ${CF_EMAILS:-(jen politika v Cloudflare)}"
  else
    echo "Přihlášení:   heslo / jména (Cloudflare Access není zapnutý)"
  fi
  if [[ -n "$TUNEL_ZAP" ]]; then
    echo "Tunel:        $TUNEL – $(docker ps -a --filter "name=^$TUNEL\$" --format '{{.Status}}' | head -1), spojení: $(docker logs "$TUNEL" 2>&1 | grep -c 'Registered tunnel connection' || true)"
  else
    echo "Tunel:        není ($TUNEL_ENV chybí)"
  fi
  echo "Zvenku:       https://$DOMENA → $(curl -s -o /dev/null -m 10 -w '%{http_code} %{redirect_url}' "https://$DOMENA/" 2>/dev/null | cut -c1-110 || true)"
  [[ -z "$TUNEL_ZAP" ]] && echo "Certifikát:   $(cert_na_serveru)"
  echo "Caddy:        $REZIM${CADDY:+ – kontejner $CADDY, $(docker ps --filter "name=^$CADDY\$" --format '{{.Status}}' | head -1)}"
  if [[ -n "${CADDYFILE:-}" && -f "$CADDYFILE" ]]; then
    IMPORT_JE=NE; grep -qxF "$IMPORT_RADEK" "$CADDYFILE" && IMPORT_JE=ano
    GITSTAV=""
    if [[ -n "$KLON" ]]; then
      GITSTAV="$(git -C "$KLON" status --porcelain -- "$CADDYFILE" 2>/dev/null | head -1)"
      if [[ -n "$GITSTAV" ]]; then GITSTAV=", git: $GITSTAV"; else GITSTAV=", git čistý"; fi
    fi
    echo "Caddyfile:    $CADDYFILE – řádek „$IMPORT_RADEK“: $IMPORT_JE$GITSTAV"
  fi
  if [[ "$REZIM" == docker ]]; then
    IMPORT_V_KONT=NE; docker exec "$CADDY" grep -qxF "$IMPORT_RADEK" "$CADDY_CONFIG" >/dev/null 2>&1 && IMPORT_V_KONT=ano
    echo "V kontejneru: $CADDY_CONFIG má import: $IMPORT_V_KONT"
    BLOK_V_KONT="$(docker exec "$CADDY" cat "$CADDY_SITES/$APP.caddy" 2>/dev/null | grep -vE '^#|^[[:space:]]*$' | tr -s ' \n' ' ' || true)"
    echo "Blok:         $CADDY_SITES/$APP.caddy: ${BLOK_V_KONT:-CHYBÍ}"
    KONF="$(docker exec "$CADDY" sh -c 'wget -qO- http://localhost:2019/config/apps/http/servers 2>/dev/null' 2>/dev/null || true)"
    ZNA="NE"
    if [[ -z "$KONF" ]]; then ZNA="nezjištěno (admin API neodpovídá)"; elif [[ "$KONF" == *"\"$DOMENA\""* ]]; then ZNA=ano; fi
    echo "Běžící konfigurace Caddy zná $DOMENA: $ZNA"
    echo "Certifikáty:  $(docker exec "$CADDY" sh -c 'ls /data/caddy/certificates/*/ 2>/dev/null' 2>/dev/null | tr '\n' ' ')"
    echo "Log Caddy (kolomapa / chyby, posledních 6 h):"
    docker logs "$CADDY" --since 6h 2>&1 | grep -iE "kolomapa|\"level\":\"error\"" | tail -8 | cut -c1-240 | sed 's/^/   /'
  fi
  echo "Log Kolomapy (posledních 5 řádků):"
  docker logs "$APP" --tail 5 2>&1 | cut -c1-200 | sed 's/^/   /'
  exit 0
fi

# --- Obraz + testy ---------------------------------------------------------------------------------------------
say "Stavím obraz $IMAGE (--no-cache${PROHLIZEC:+, s prohlížečem pro Cyklobazar})"
docker build --no-cache --build-arg "S_PROHLIZECEM=${PROHLIZEC:-0}" -t "$IMAGE" "$ZDROJ"

# Testy běží v PRÁVĚ POSTAVENÉM obrazu – chytí i to, co se rozbije až verzí Node v obrazu. Před výměnou
# kontejneru, takže když spadnou, stará verze běží dál.
say "Testy uvnitř nového obrazu"
docker run --rm "$IMAGE" npm test >/tmp/kolomapa-testy.log 2>&1 || { tail -40 /tmp/kolomapa-testy.log; die "testy v obrazu neprošly – nenasazuji (celý výpis: /tmp/kolomapa-testy.log)"; }
echo "   $(grep -E '^# (pass|fail)' /tmp/kolomapa-testy.log | tr '\n' ' ')"

# --- Síť, data -------------------------------------------------------------------------------------------------
docker network inspect "$SIT" >/dev/null 2>&1 || { say "Zakládám Docker síť $SIT"; docker network create "$SIT" >/dev/null; }
if [[ "$REZIM" == docker ]]; then docker network connect "$SIT" "$CADDY" >/dev/null 2>&1 || true; fi   # už připojená = nic
mkdir -p "$DATA/zalohy"
chown -R 1000:1000 "$DATA"   # kontejner běží jako uživatel node (UID 1000)

# --- Uživatelé: opis z Cyklo & Ski mapy -------------------------------------------------------------------------
ENV_NAVIC=()
if [[ "$UZIVATELE" == csm ]]; then
  say "Přihlášení: jména a hesla z Cyklo & Ski mapy ($CSM_ENV)"
  cat >"$UZIVATELE_SKRIPT" <<EOF
#!/bin/sh
# Uživatelé Kolomapy = uživatelé Cyklo & Ski mapy: opisuje řádky CSM_USERS / CSM_PASSWORD z jejího .env do
# $DATA/$UZIVATELE_SOUBOR (čte ho kontejner kolomapa přes KOLOMAPA_USERS_FILE a změnu pozná hned).
# Spravuje kolomapa/deploy/docker/nasadit.sh; spouští ho nasazení a cron ($UZIVATELE_CRON) každých 5 minut.
Z='$CSM_ENV'; CIL='$DATA/$UZIVATELE_SOUBOR'
[ -f "\$Z" ] || exit 0
{ echo "# Opis uživatelů z Cyklo & Ski mapy (\$Z) – dělá $UZIVATELE_SKRIPT, neupravovat (přepíše se)."; grep -E '^CSM_(USERS|PASSWORD)=' "\$Z"; } >"\$CIL.tmp"
if cmp -s "\$CIL.tmp" "\$CIL"; then rm -f "\$CIL.tmp"; else chown 1000:1000 "\$CIL.tmp" && chmod 600 "\$CIL.tmp" && mv -f "\$CIL.tmp" "\$CIL"; fi
EOF
  chmod 755 "$UZIVATELE_SKRIPT"
  if [[ -d "$(dirname "$UZIVATELE_CRON")" ]]; then
    printf '# Uživatelé Kolomapy z Cyklo & Ski mapy (spravuje kolomapa/deploy/docker/nasadit.sh)\n*/5 * * * * root %s\n' "$UZIVATELE_SKRIPT" >"$UZIVATELE_CRON"
    chmod 644 "$UZIVATELE_CRON"
  fi
  "$UZIVATELE_SKRIPT"
  JMENA="$(sed -n 's/^CSM_USERS=//p' "$CSM_ENV" | head -1 | tr ';,' '\n\n' | sed 's/:.*//; s/^ *//; s/ *$//' | grep . | tr '\n' ' ')"
  [[ -n "$JMENA" ]] || JMENA="tým (CSM_PASSWORD)"
  echo "   uživatelé: $JMENA→ $DATA/$UZIVATELE_SOUBOR (obnova cronem každých 5 minut)"
  ENV_NAVIC=(-e "KOLOMAPA_USERS_FILE=/app/data/$UZIVATELE_SOUBOR")
else
  rm -f "$UZIVATELE_CRON" 2>/dev/null || true
fi

# --- Výměna kontejneru -----------------------------------------------------------------------------------------
PUBLISH=()
if [[ "$REZIM" != docker ]]; then PUBLISH=(-p "127.0.0.1:$PORT:$PORT"); fi   # jen pro Caddy mimo Docker, nikdy veřejně
say "Spouštím kontejner $APP"
docker rm -f "$APP" >/dev/null 2>&1 || true
# Zámek běhu po právě zabitém kontejneru (stahování uprostřed nasazení) – jinak by nový kontejner čekal, že stahuje
# „jiný proces“, a vlastní běh nespustil. --hostname: stálé jméno hostitele, zámek tak nevypadá jako z cizího počítače.
rm -f "$DATA/kolomapa.db.run-lock"
docker run -d \
  --name "$APP" \
  --hostname "$APP" \
  --restart unless-stopped \
  --network "$SIT" \
  --env-file "$ENV_SOUBOR" \
  -v "$DATA":/app/data \
  "${PUBLISH[@]}" \
  "${ENV_NAVIC[@]}" \
  "$IMAGE" >/dev/null

# --- Cloudflare tunel ------------------------------------------------------------------------------------------
# cloudflared na stejné Docker síti: Cloudflare (po přihlášení přes Access) → tunel → http://kolomapa:8050. V Cloudflare
# u tunelu „Public hostname“: doména Kolomapy → služba HTTP, URL kolomapa:8050. Token jen v $TUNEL_ENV (chmod 600).
if [[ -n "$TUNEL_ZAP" ]]; then
  if [[ -n "$TUNEL_TOKEN_NOVY" ]]; then
    (umask 077 && printf '# Token Cloudflare tunelu Kolomapy (zapsal nasadit.sh) – tajné, necommitovat\nTUNNEL_TOKEN=%s\n' "$TUNEL_TOKEN_NOVY" >"$TUNEL_ENV")
    chmod 600 "$TUNEL_ENV"
  fi
  say "Cloudflare tunel ($TUNEL → http://$APP:$PORT)"
  docker pull -q "$TUNEL_IMAGE" >/dev/null 2>&1 || echo "   VAROVÁNÍ: obraz $TUNEL_IMAGE nejde stáhnout – použiji uložený"
  docker rm -f "$TUNEL" >/dev/null 2>&1 || true
  docker run -d --name "$TUNEL" --restart unless-stopped --network "$SIT" --env-file "$TUNEL_ENV" "$TUNEL_IMAGE" tunnel --no-autoupdate run >/dev/null
  TUNEL_OK=""
  for _ in $(seq 1 25); do
    if docker logs "$TUNEL" 2>&1 | grep -q 'Registered tunnel connection'; then TUNEL_OK=1; break; fi
    sleep 1
  done
  if [[ -n "$TUNEL_OK" ]]; then
    echo "   tunel připojený k Cloudflare"
  else
    echo "   VAROVÁNÍ: tunel se do 25 s nepřipojil (špatný token? síť?) – poslední řádky logu ($TUNEL):"
    docker logs --tail 8 "$TUNEL" 2>&1 | cut -c1-200 | sed 's/^/   /'
  fi
fi

# --- Caddy -------------------------------------------------------------------------------------------------------
BLOK="# Kolomapa – mapa inzerátů kol (blok přidal kolomapa/deploy/docker/nasadit.sh)
$DOMENA {
    reverse_proxy $CIL
    header X-Robots-Tag \"noindex, nofollow\"
}"
# bezpečnostní hlavičky sdílené s ostatními aplikacemi (snippet header_sec), když v Caddyfile jsou
if [[ -f "$CADDYFILE" ]] && grep -q '^(header_sec)' "$CADDYFILE"; then BLOK="${BLOK/reverse_proxy/import header_sec
    reverse_proxy}"; fi
# S tunelem jde Kolomapa ven jen přes Cloudflare – Caddy pro její doménu nic neobsluhuje (žádný přímý přístup na server).
[[ -n "$TUNEL_ZAP" ]] && BLOK=""
# Vlastní doména: původní adresa podle IP (sslip.io) přesměrovává na ni, aby staré odkazy a záložky fungovaly dál.
PRESMEROVANI=""
if [[ -n "$VYCHOZI_DOMENA" && "$DOMENA" != "$VYCHOZI_DOMENA" ]]; then
  PRESMEROVANI="
# Původní adresa Kolomapy podle IP serveru → přesměrování na $DOMENA (přidal kolomapa/deploy/docker/nasadit.sh)
$VYCHOZI_DOMENA {
    redir https://$DOMENA{uri} permanent
}"
fi

caddy_docker_nacti() {   # ověřit a načíst konfiguraci běžícího kontejneru Caddy; 1 = kontrola nebo načtení neprošlo
  docker exec "$CADDY" caddy validate --config "$CADDY_CONFIG" >/dev/null 2>&1 || return 1
  if ! docker exec "$CADDY" caddy reload --config "$CADDY_CONFIG" >/tmp/kolomapa-caddy-reload.log 2>&1; then
    echo "   caddy reload selhal:"; tail -5 /tmp/kolomapa-caddy-reload.log | cut -c1-240 | sed 's/^/   /'
    return 1
  fi
  # Opravdu běžící konfigurace zná doménu? (admin API Caddy; chybí-li řádek import, reload „projde“, ale blok se nenačte)
  local konf
  konf="$(docker exec "$CADDY" sh -c 'wget -qO- http://localhost:2019/config/apps/http/servers 2>/dev/null' 2>/dev/null || true)"
  if [[ -z "$TUNEL_ZAP" && -n "$konf" && "$konf" != *"\"$DOMENA\""* ]]; then
    echo "   VAROVÁNÍ: Caddy načetla konfiguraci, ale $DOMENA v ní není – Caddy blok nečte (řádek „$IMPORT_RADEK“ v $CADDYFILE?). Stav: bash $SKRIPT --stav"
  fi
}
caddy_docker_chyba() {
  docker exec "$CADDY" caddy validate --config "$CADDY_CONFIG" 2>&1 | tail -5 || true
  die "nová konfigurace Caddy neprošla kontrolou – vrácena původní; blok přidejte ručně (je ve skriptu)"
}
# Caddyfile v git klonu: řádek import je v repozitáři commitnutý (cyklo-ski-mapa/deploy/Caddyfile). Dokud ho klon na
# serveru nemá, doplnil se do pracovní kopie – a hetzner.sh aktualizace (Cyklo & Ski mapa) pak hlásí „necommitnuté
# změny – kód nestahuji“. Jakmile řádek má i origin, srovná se pracovní kopie z gitu (checkout + rychloposun), aby
# klon zůstal čistý. Jiných necommitnutých změn se nedotýká.
caddyfile_git_srovnat() {   # $1 Caddyfile, $2 klon
  local rel vetev r
  rel="$(git -C "$(dirname "$1")" ls-files --full-name "$(basename "$1")" 2>/dev/null)"
  [[ -n "$rel" ]] || return 0
  git -C "$2" diff --quiet -- "$rel" 2>/dev/null && return 0      # pracovní kopie = HEAD, není co srovnávat
  while IFS= read -r r; do   # smí se lišit jen o prázdný řádek, náš komentář a řádek import
    case "$r" in "+"|"+$IMPORT_KOMENTAR"|"+$IMPORT_RADEK") ;; *)
      echo "   POZOR: $rel v klonu $2 má i jiné necommitnuté změny – nechávám (hetzner.sh aktualizace kvůli nim kód nestahuje)."
      return 0 ;;
    esac
  done < <(git -C "$2" diff -- "$rel" | grep -E '^[-+]' | grep -vE '^(\+\+\+|---) ')
  vetev="$(git -C "$2" branch --show-current 2>/dev/null || true)"
  if [[ -n "$vetev" ]] && git -C "$2" fetch -q origin "$vetev" 2>/dev/null \
     && git -C "$2" show "origin/$vetev:$rel" 2>/dev/null | grep -qxF "$IMPORT_RADEK"; then
    if git -C "$2" checkout -q -- "$rel" && git -C "$2" merge -q --ff-only "origin/$vetev" 2>/dev/null && grep -qxF "$IMPORT_RADEK" "$1"; then
      echo "   klon $2: řádek „$IMPORT_RADEK“ už je v origin/$vetev – $rel srovnán z gitu, klon je čistý"
      return 0
    fi
    grep -qxF "$IMPORT_RADEK" "$1" || printf '\n%s\n' "$IMPORT_RADEK" >>"$1"   # rychloposun nešel – řádek zpět
  fi
  echo "   POZOR: klon $2 má kvůli řádku „$IMPORT_RADEK“ necommitnutou změnu v $rel; hetzner.sh aktualizace (Cyklo & Ski"
  echo "          mapa) kvůli ní nestahuje nový kód. Srovná se samo při příštím nasazení Kolomapy, až bude řádek i na"
  echo "          GitHubu ve větvi $vetev (sloučení větve Kolomapy)."
}

if [[ -n "$TUNEL_ZAP" && "$ZPUSOB" != sites ]]; then
  # Caddy s bloky přímo v Caddyfile: nic nepřidávat; zbylý blok pro doménu by pouštěl na Kolomapu i mimo Cloudflare
  # (přihlášení by stejně chtělo token Cloudflare Access, ale čistší je ho smazat).
  if [[ -f "$CADDYFILE" ]] && grep -qE "^[[:space:]]*$DOMENA([[:space:],{]|$)" "$CADDYFILE"; then
    echo "POZOR: $CADDYFILE má blok pro $DOMENA – s tunelem ho smažte a Caddy načtěte znovu."
  fi
elif [[ ! -f "$CADDYFILE" ]]; then
  echo "VAROVÁNÍ: $CADDYFILE neexistuje – do své konfigurace Caddy přidejte ručně:"
  printf '%s\n' "$BLOK"
elif grep -qE "^[[:space:]]*$DOMENA([[:space:],{]|$)" "$CADDYFILE"; then
  say "Caddy: blok pro $DOMENA už v $CADDYFILE je"
elif [[ "$ZPUSOB" == sites ]]; then
  # Caddyfile je v git klonu (Cyklo & Ski mapa) – blok nejde dovnitř, ale do svazku caddy_config: /config/sites/kolomapa.caddy.
  # V Caddyfile musí být řádek „import /config/sites/*.caddy“ (v repozitáři je; starší klon ho dostane tady).
  SOUBOR="$CADDY_SITES/$APP.caddy"
  if [[ -n "$TUNEL_ZAP" ]]; then
    say "Caddy: Kolomapa jde ven tunelem – $DOMENA v Caddy není${PRESMEROVANI:+; v $SOUBOR jen přesměrování z $VYCHOZI_DOMENA}"
  else
    say "Caddy: zapisuji blok pro $DOMENA do $SOUBOR v kontejneru $CADDY"
  fi
  PUVODNI="$(docker exec "$CADDY" cat "$SOUBOR" 2>/dev/null || true)"
  PUVODNI_CADDYFILE=""   # záloha jen v paměti – soubor .zaloha by v git klonu vadil (hetzner.sh: necommitnuté změny)
  if ! grep -qxF "$IMPORT_RADEK" "$CADDYFILE"; then
    echo "   $CADDYFILE: doplňuji řádek „$IMPORT_RADEK“"
    PUVODNI_CADDYFILE="$(cat "$CADDYFILE")"
    # >> drží stejný soubor (inode) – kontejner caddy ho má připojený, nový soubor by neviděl
    printf '\n%s\n%s\n' "$IMPORT_KOMENTAR" "$IMPORT_RADEK" >>"$CADDYFILE"
  fi
  # Kontejner Caddy čte starou verzi Caddyfile, když se soubor na disku vyměnil (git checkout = nový soubor; připojený
  # jednotlivý soubor zůstává v kontejneru starý) – pak import nevidí a Kolomapu nezná. Restart ho připojí znovu.
  if ! docker exec "$CADDY" grep -qxF "$IMPORT_RADEK" "$CADDY_CONFIG" >/dev/null 2>&1; then
    echo "   kontejner $CADDY čte starou verzi $CADDYFILE (bez řádku import) → restartuji Caddy (pár sekund výpadek webů na ní)"
    docker restart "$CADDY" >/dev/null
    for _ in $(seq 1 20); do docker exec "$CADDY" grep -qxF "$IMPORT_RADEK" "$CADDY_CONFIG" >/dev/null 2>&1 && break; sleep 1; done
  fi
  if [[ -n "$BLOK$PRESMEROVANI" ]]; then
    printf '%s\n' "$BLOK$PRESMEROVANI" | docker exec -i "$CADDY" sh -c "mkdir -p '$CADDY_SITES' && cat >'$SOUBOR'"
  else
    docker exec "$CADDY" rm -f "$SOUBOR"
  fi
  if caddy_docker_nacti; then
    echo "   Caddy načetla novou konfiguraci"
  else
    if [[ -n "$PUVODNI" ]]; then printf '%s\n' "$PUVODNI" | docker exec -i "$CADDY" sh -c "cat >'$SOUBOR'"; else docker exec "$CADDY" rm -f "$SOUBOR"; fi
    [[ -n "$PUVODNI_CADDYFILE" ]] && printf '%s\n' "$PUVODNI_CADDYFILE" >"$CADDYFILE"   # > drží inode
    caddy_docker_chyba
  fi
  caddyfile_git_srovnat "$CADDYFILE" "$KLON"
else
  say "Caddy: přidávám blok pro $DOMENA do $CADDYFILE"
  cp "$CADDYFILE" "$CADDYFILE.zaloha"
  # přesměrování z původní adresy jen když pro ni v Caddyfile ještě žádný blok není (starý blok by ho vyloučil)
  if [[ -n "$PRESMEROVANI" ]] && grep -qE "^[[:space:]]*$VYCHOZI_DOMENA([[:space:],{]|$)" "$CADDYFILE"; then
    echo "   $VYCHOZI_DOMENA má v $CADDYFILE vlastní blok – nechávám (přesměrování na $DOMENA přidejte ručně, chcete-li)"
    PRESMEROVANI=""
  fi
  # >> drží stejný soubor (inode) – kontejner caddy ho má připojený, nový soubor by neviděl
  printf '\n%s\n' "$BLOK$PRESMEROVANI" >>"$CADDYFILE"
  case "$REZIM" in
    docker)
      if caddy_docker_nacti; then
        echo "   Caddy načetla novou konfiguraci (záloha předchozí: $CADDYFILE.zaloha)"
      else
        cp "$CADDYFILE.zaloha" "$CADDYFILE"
        caddy_docker_chyba
      fi
      ;;
    system)
      if caddy validate --config "$CADDYFILE" >/dev/null 2>&1; then
        systemctl reload caddy 2>/dev/null || caddy reload --config "$CADDYFILE" >/dev/null 2>&1 || true
        echo "   Caddy načetla novou konfiguraci (záloha předchozí: $CADDYFILE.zaloha)"
      else
        cp "$CADDYFILE.zaloha" "$CADDYFILE"
        caddy validate --config "$CADDYFILE" 2>&1 | tail -5 || true
        die "nová konfigurace Caddy neprošla kontrolou – vrácena původní; blok přidejte ručně (je ve skriptu)"
      fi
      ;;
    *) echo "VAROVÁNÍ: Caddy neběží – blok je v $CADDYFILE, Caddy ho načte při příštím startu." ;;
  esac
fi

# --- Denní záloha databáze ----------------------------------------------------------------------------------
if [[ -d "$(dirname "$ZALOHA_CRON")" ]]; then
  cat >"$ZALOHA_CRON" <<EOF
#!/bin/sh
# Záloha databáze Kolomapy (spravuje kolomapa/deploy/docker/nasadit.sh): 7 souborů podle dne v týdnu.
$(command -v docker) exec $APP sh -c 'sqlite3 /app/data/kolomapa.db ".backup /app/data/zalohy/kolomapa-\$(date +%u).db"' 2>/dev/null
EOF
  chmod 755 "$ZALOHA_CRON"
fi

docker image prune -f >/dev/null

# --- Ověření ----------------------------------------------------------------------------------------------------
# Že kontejner „běží“ nestačí – spadlý server v restartovací smyčce vypadá stejně. S heslem odpoví 401, to je OK.
say "Čekám, až Kolomapa odpoví"
for i in $(seq 1 30); do
  if docker exec "$APP" node -e "fetch('http://127.0.0.1:$PORT/api/run').then((r) => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))" 2>/dev/null; then
    echo "   odpovídá (pokus $i): $(docker ps --filter "name=^$APP\$" --format '{{.Status}}')"
    if [[ -n "$ACCESS" ]] && command -v curl >/dev/null; then
      # Zvenku (přes Cloudflare): bez přihlášení přesměrování na přihlášení Access. Přímo na server (mimo Cloudflare):
      # buď nic (tunel – Caddy doménu nezná), nebo 403 od Kolomapy (bez tokenu Cloudflare nic).
      ZVENKU="$(curl -s -o /dev/null -m 15 -w '%{http_code} %{redirect_url}' "https://$DOMENA/" 2>/dev/null || true)"
      case "$ZVENKU" in
        30?\ https://*.cloudflareaccess.com/*) echo "   zvenku: https://$DOMENA chce přihlášení Cloudflare Access" ;;
        *) CO="oranžový mráček u DNS záznamu"; [[ -n "$TUNEL_ZAP" ]] && CO="Public hostname tunelu ($DOMENA → HTTP kolomapa:$PORT)"
           echo "   POZOR: https://$DOMENA nepřesměrovává na přihlášení Cloudflare Access (odpověď: ${ZVENKU% }) – zkontrolujte aplikaci v Cloudflare Access a $CO" ;;
      esac
      if [[ -z "$TUNEL_ZAP" ]]; then
        CERT="$(cert_na_serveru)"
        case "$CERT" in
          *[Cc]loud[Ff]lare*) echo "   certifikát na serveru: $CERT (Cloudflare Origin – za proxy v pořádku)" ;;
          "") ;;
          *) echo "   POZOR: certifikát na serveru: $CERT – za proxy Cloudflare ho Caddy neobnoví. Zapněte Cloudflare Origin certifikát"
             echo "          pokrývající $DOMENA (na tomto serveru ho spravuje Cyklo & Ski mapa: CSM_CLOUDFLARE=1), nebo použijte tunel." ;;
        esac
      fi
      PRIMO="$(curl -sk -o /dev/null -m 10 -w '%{http_code}' --resolve "$DOMENA:443:127.0.0.1" "https://$DOMENA/data/summary.json" 2>/dev/null || true)"
      case "${PRIMO:-000}" in
        000|403|421) echo "   přímo na server mimo Cloudflare: ${PRIMO/000/nedostupné} – bez přihlášení Cloudflare nic" ;;
        *) echo "   POZOR: přímo na server mimo Cloudflare vrací $PRIMO – Kolomapa má odpovídat 403" ;;
      esac
    elif ! getent ahosts "$DOMENA" >/dev/null 2>&1; then
      echo
      echo "POZOR: doména $DOMENA se zatím nepřekládá – u správce domény přidejte záznam A na IP tohoto serveru."
      echo "       Certifikát HTTPS si Caddy vyřídí sama, jakmile se DNS projeví."
    elif [[ "$REZIM" != none ]] && command -v curl >/dev/null; then
      # Přes Caddy z tohoto serveru (bez ohledu na DNS): 401 = Caddy směruje na Kolomapu a chce heslo. Certifikát
      # Caddy vyřizuje na pozadí, chvíli to může trvat – proto víc pokusů, a jen jako informace.
      LOG_CADDY="${CADDY:+docker logs $CADDY}"; LOG_CADDY="${LOG_CADDY:-journalctl -u caddy -n 50}"
      KOD_HTTP=000
      for _ in $(seq 1 12); do
        KOD_HTTP="$(curl -sk -o /dev/null -m 5 -w '%{http_code}' --resolve "$DOMENA:443:127.0.0.1" "https://$DOMENA/" 2>/dev/null || true)"
        KOD_HTTP="${KOD_HTTP:-000}"
        [[ "$KOD_HTTP" == 000 ]] || break
        sleep 5
      done
      case "$KOD_HTTP" in
        401) echo "   přes Caddy: https://$DOMENA odpovídá (401 – chce heslo), certifikát vystaven" ;;
        000) echo "   přes Caddy: https://$DOMENA zatím neodpovídá – Caddy nejspíš ještě vyřizuje certifikát; zkuste za minutu, jinak: $LOG_CADDY" ;;
        *)   echo "   přes Caddy: https://$DOMENA vrací $KOD_HTTP (čekal jsem 401) – podívejte se do: $LOG_CADDY" ;;
      esac
    fi
    echo
    echo "Mapa:       https://$DOMENA${PRESMEROVANI:+   (https://$VYCHOZI_DOMENA přesměrovává sem)}"
    case "$UZIVATELE" in
      access)  echo "Přihlášení: jen Cloudflare Access (tým $CF_TEAM${CF_EMAILS:+, e-maily $CF_EMAILS}) – heslo ani jména se nepoužívají" ;;
      csm)     echo "Přihlášení: jména a hesla z Cyklo & Ski mapy ($CSM_ENV)${HESLO_TAKE:+; navíc KOLOMAPA_PASSWORD z $ENV_SOUBOR s libovolným jménem}" ;;
      vlastni) echo "Přihlášení: podle KOLOMAPA_USERS / KOLOMAPA_USERS_FILE v $ENV_SOUBOR${HESLO_TAKE:+ (+ KOLOMAPA_PASSWORD, jméno libovolné)}" ;;
      *)       echo "Přihlášení: jméno libovolné, heslo KOLOMAPA_PASSWORD v $ENV_SOUBOR" ;;
    esac
    if [[ -n "$TUNEL_ZAP" ]]; then echo "Vrátnice:   Cloudflare tunel $TUNEL → http://$APP:$PORT (Caddy pro $DOMENA nic neobsluhuje)"
    else case "$REZIM" in
      docker) if [[ "$ZPUSOB" == sites ]]; then echo "Vrátnice:   Caddy v kontejneru $CADDY → $CIL (blok $CADDY_SITES/$APP.caddy, import v $CADDYFILE)"
              else echo "Vrátnice:   Caddy v kontejneru $CADDY → $CIL (blok v $CADDYFILE)"; fi ;;
      system) echo "Vrátnice:   Caddy jako služba ($CADDYFILE) → $CIL" ;;
      *)      echo "Vrátnice:   ŽÁDNÁ – Caddy nenalezena, https://$DOMENA se neotevře (viz VAROVÁNÍ výše)" ;;
    esac; fi
    [[ -n "$NOVE_HESLO" ]] && echo "Nové heslo: $NOVE_HESLO"
    echo "Log:        docker logs -f $APP        Stav: docker ps --filter name=$APP"
    echo "Nastavení:  $ENV_SOUBOR  (po změně znovu spustit nasadit.sh)"
    echo "První stahování začalo samo a trvá 2–3 hodiny; mapa se plní průběžně."
    exit 0
  fi
  sleep 2
done
echo "CHYBA: Kolomapa do minuty neodpověděla. Posledních 40 řádků logu:" >&2
docker logs --tail 40 "$APP" >&2 || true
exit 1
