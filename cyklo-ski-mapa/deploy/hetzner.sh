#!/usr/bin/env bash
# Cyklo & Ski mapa na Hetzneru (nebo jiném VPS s veřejnou IP a doménou): instalace, aktualizace,
# záloha stavu, log, návrat k předchozí verzi. Spouští se NA SERVERU jako root (Ubuntu 22.04/24.04,
# Debian 12). Používá Docker Compose s Caddy (HTTPS z Let's Encrypt automaticky) – deploy/docker-compose.yml.
#
#   apt-get install -y git && git clone https://github.com/ladasuchan1-cmd/Doma.git /opt/cyklo-ski-mapa/Doma
#   bash /opt/cyklo-ski-mapa/Doma/cyklo-ski-mapa/deploy/hetzner.sh instalace mapa.vase-domena.cz
#
#   bash /opt/cyklo-ski-mapa/Doma/cyklo-ski-mapa/deploy/hetzner.sh aktualizace    # nový kód a znovu postavit (pouští i GitHub Actions)
#   bash /opt/cyklo-ski-mapa/Doma/cyklo-ski-mapa/deploy/hetzner.sh zaloha         # zkopíruje stav.json do /opt/zalohy-cyklo-ski-mapa
#   bash /opt/cyklo-ski-mapa/Doma/cyklo-ski-mapa/deploy/hetzner.sh zaloha --cron  # + denní záloha ve 2:30 (cron)
#   bash /opt/cyklo-ski-mapa/Doma/cyklo-ski-mapa/deploy/hetzner.sh zpet           # vrátí předchozí verzi aplikace
#   bash /opt/cyklo-ski-mapa/Doma/cyklo-ski-mapa/deploy/hetzner.sh stav | log
#
# Mapa má vlastní klon repa (výchozí /opt/cyklo-ski-mapa/Doma, od 7. 10. 2026); /opt/Doma patří dalším projektům na
# témže serveru (Půjčovna kol, Kolomapa), které si v něm přepínají větve. Projekt Compose se jmenuje „deploy“, takže
# kontejnery, svazky i síť zůstaly při přesunu stejné – viz prevezmi_stare_nastaveni.
#
# Proměnné: CSM_REPO_DIR (klon repa; výchozí složka, ve které skript leží, jinak /opt/cyklo-ski-mapa/Doma),
# CSM_COMPOSE (docker-compose.yml, pro Caddy v jiném kontejneru docker-compose.caddy-externi.yml), CSM_ZALOHY
# (/opt/zalohy-cyklo-ski-mapa), CSM_USERS (uživatelé pro instalaci bez dotazu; nebo CSM_USERS_B64 = totéž v base64,
# bez starostí s uvozovkami), CSM_VETEV (větev repa pro první klon a kontrola při aktualizaci), CSM_UFW=0
# (nenastavovat firewall), CSM_CLOUDFLARE=1|0 + CSM_ORIGIN_CERT_B64 / CSM_ORIGIN_KEY_B64 (Cloudflare před serverem,
# viz synchronizuj_cloudflare; soubory v /opt/caddy-origin), CSM_STARY_DEPLOY (odkud převzít .env při
# první instalaci do nového místa; /opt/Doma/cyklo-ski-mapa/deploy).
#
# Běží i bez repa na disku – skript lze poslat přes SSH ze stdin (první instalace z GitHub Actions):
#   ssh agent@server 'sudo -n env CSM_USERS_B64=… bash -s -- instalace mapa.domena.cz' < deploy/hetzner.sh
# Když neběží jako root a sudo je bez hesla, spustí se přes sudo sám.
set -euo pipefail

if [ "$(id -u)" != 0 ]; then
  if [ -f "${BASH_SOURCE[0]:-}" ] && sudo -n true 2>/dev/null; then
    exec sudo -n env CSM_USERS="${CSM_USERS:-}" CSM_USERS_B64="${CSM_USERS_B64:-}" CSM_DOMAIN="${CSM_DOMAIN:-}" CSM_REPO_DIR="${CSM_REPO_DIR:-}" \
      CSM_COMPOSE="${CSM_COMPOSE:-}" CSM_ZALOHY="${CSM_ZALOHY:-}" CSM_VETEV="${CSM_VETEV:-}" CSM_UFW="${CSM_UFW:-}" CSM_CRON="${CSM_CRON:-}" \
      CSM_CLOUDFLARE="${CSM_CLOUDFLARE:-}" CSM_ORIGIN_CERT_B64="${CSM_ORIGIN_CERT_B64:-}" CSM_ORIGIN_KEY_B64="${CSM_ORIGIN_KEY_B64:-}" \
      CSM_STARY_DEPLOY="${CSM_STARY_DEPLOY:-}" \
      bash "${BASH_SOURCE[0]}" "$@"
  fi
  echo "CHYBA: spusťte jako root nebo přes sudo (sudo bash $0 …)." >&2
  exit 1
fi
if [ -z "${CSM_USERS:-}" ] && [ -n "${CSM_USERS_B64:-}" ]; then
  CSM_USERS="$(printf %s "$CSM_USERS_B64" | base64 -d)"
  export CSM_USERS
fi

REPO_URL="${CSM_REPO:-https://github.com/ladasuchan1-cmd/Doma.git}"
# Klon repa: zadaný, jinak ten, ve kterém skript leží (deploy/ → cyklo-ski-mapa/ → klon), jinak výchozí místo.
if [ -n "${CSM_REPO_DIR:-}" ]; then
  REPO_DIR="$CSM_REPO_DIR"
elif [ -f "${BASH_SOURCE[0]:-}" ]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
else
  REPO_DIR=/opt/cyklo-ski-mapa/Doma
fi
APP_DIR="$REPO_DIR/cyklo-ski-mapa"
DEPLOY_DIR="$APP_DIR/deploy"
COMPOSE_FILE="${CSM_COMPOSE:-docker-compose.yml}"
ZALOHY="${CSM_ZALOHY:-/opt/zalohy-cyklo-ski-mapa}"
IMAGE=cyklo-ski-mapa
# Adresáře připojené do Caddy (pevně v docker-compose.yml): Origin certifikát a bloky dalších webů na serveru.
ORIGIN_DIR=/opt/caddy-origin
CADDY_EXTRA=/opt/caddy-extra
CADDY_ZMENA=0
TLS_NOVY=0

compose() { (cd "$DEPLOY_DIR" && docker compose -f "$COMPOSE_FILE" "$@"); }

chyba() { echo "CHYBA: $*" >&2; exit 1; }

domena() { sed -n 's/^DOMAIN=//p' "$DEPLOY_DIR/.env" 2>/dev/null | head -1; }

verze_z_gitu() { git -C "$APP_DIR" log -1 --format='v%cd-%h' --date=format:%Y-%m-%d 2>/dev/null || date +'v%Y-%m-%d-%H%M'; }

# Uživatelé (CSM_USERS) a doména (CSM_DOMAIN) z prostředí – typicky z nastavení GitHubu při nasazení –
# se propíší do deploy/.env, aby platilo to, co je v GitHubu, a na server nebylo nutné chodit.
synchronizuj_env() {
  local env="$DEPLOY_DIR/.env"
  [ -f "$env" ] || return 0
  if [ -n "${CSM_USERS:-}" ] && [ "$(sed -n 's/^CSM_USERS=//p' "$env" | head -1)" != "$CSM_USERS" ]; then
    { grep -v '^CSM_USERS=' "$env"; printf 'CSM_USERS=%s\n' "$CSM_USERS"; } > "$env.tmp" && mv "$env.tmp" "$env" && chmod 600 "$env"
    echo "→ Uživatelé aplikace v .env aktualizováni podle nastavení GitHubu."
  fi
  if [ -n "${CSM_DOMAIN:-}" ] && [ "$(domena)" != "$CSM_DOMAIN" ]; then
    { grep -v '^DOMAIN=' "$env"; printf 'DOMAIN=%s\n' "$CSM_DOMAIN"; } > "$env.tmp" && mv "$env.tmp" "$env" && chmod 600 "$env"
    echo "→ Doména změněna na $CSM_DOMAIN (Caddy si vystaví nový certifikát)."
  fi
}

# Čeká, až aplikace v kontejneru odpoví na /api/health (a hlásí zapisovatelnou datovou složku).
cekej_na_app() {
  local i
  for i in $(seq 1 60); do
    if compose exec -T app wget -qO- http://127.0.0.1:8090/api/health >/dev/null 2>&1; then
      compose logs --tail 20 app 2>/dev/null | grep -o 'Přihlášení zapnuté, uživatelé: .*' | tail -1 || true
      return 0
    fi
    sleep 1
  done
  echo "Aplikace do minuty neodpověděla. Log:" >&2
  compose logs --tail 40 app >&2 || true
  return 1
}

# Čeká, až web odpoví přes Caddy na https://DOMENA (certifikát z Let's Encrypt trvá pár vteřin).
cekej_na_web() {
  local d i
  d="$(domena)"
  [ -n "$d" ] || return 0
  for i in $(seq 1 90); do
    if curl -fsS -m 5 "https://$d/api/health" >/dev/null 2>&1; then
      echo "Web běží: https://$d  –  $(curl -fsS -m 5 "https://$d/api/health")"
      return 0
    fi
    sleep 2
  done
  echo "VAROVÁNÍ: https://$d zatím neodpovídá. Nejčastější příčiny: DNS záznam domény ještě nemíří na tento server," >&2
  echo "          nebo nejsou otevřené porty 80 a 443 (Hetzner Cloud Firewall / ufw). Log Caddy:" >&2
  compose logs --tail 30 caddy >&2 2>/dev/null || true
  return 1
}

nainstaluj_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo "→ Docker je nainstalovaný ($(docker --version))."
    return
  fi
  echo "→ Instaluji Docker (get.docker.com)…"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker compose version >/dev/null 2>&1 || chyba "Docker Compose (plugin) není k dispozici."
}

nastav_firewall() {
  [ "${CSM_UFW:-1}" = "1" ] || return 0
  command -v ufw >/dev/null 2>&1 || return 0
  echo "→ Firewall (ufw): SSH, 80, 443…"
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
}

vytvor_env() { # $1 = doména
  local d="$1" users
  mkdir -p "$DEPLOY_DIR"
  if [ -f "$DEPLOY_DIR/.env" ]; then
    echo "→ $DEPLOY_DIR/.env už existuje – nechávám (doménu/uživatele upravte ručně)."
    grep -q '^DOMAIN=' "$DEPLOY_DIR/.env" || echo "DOMAIN=$d" >> "$DEPLOY_DIR/.env"
    return
  fi
  if [ -n "${CSM_USERS:-}" ]; then
    users="$CSM_USERS"
  elif [ -t 0 ]; then
    echo
    echo "Zadejte uživatele obchodního oddělení ve tvaru  jmeno:heslo;jmeno2:heslo2"
    echo "(každý své jméno – u změn se pak eviduje, kdo je udělal). Enter = jedno náhodné heslo pro uživatele „tým“."
    read -r -p "CSM_USERS= " users
  fi
  if [ -z "${users:-}" ]; then
    users="tým:$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 14)"
    echo "→ Vygenerované přihlášení: jméno „tým“, heslo ${users#*:}   (uložené v $DEPLOY_DIR/.env)"
  fi
  cat > "$DEPLOY_DIR/.env" <<EOF
# Cyklo & Ski mapa – konfigurace serveru (vytvořil hetzner.sh $(date +%F)). Soubor není v gitu.
DOMAIN=$d
CSM_USERS=$users
CSM_SESSION_DAYS=30
CSM_TRUST_PROXY=1
EOF
  chmod 600 "$DEPLOY_DIR/.env"
  echo "→ Vytvořen $DEPLOY_DIR/.env"
}

instalace() {
  local d="${1:-}"
  [ -n "$d" ] || [ -n "$(domena)" ] || chyba "zadejte doménu: hetzner.sh instalace mapa.vase-domena.cz"
  export DEBIAN_FRONTEND=noninteractive
  if command -v apt-get >/dev/null 2>&1; then
    echo "→ Balíčky (git, curl, ufw)…"
    apt-get update -qq && apt-get install -y -qq ca-certificates curl git ufw >/dev/null
  fi
  nainstaluj_docker
  nastav_firewall
  if [ ! -d "$APP_DIR" ]; then
    echo "→ Stahuji repozitář do $REPO_DIR…"
    git clone ${CSM_VETEV:+-b "$CSM_VETEV"} "$REPO_URL" "$REPO_DIR"
    [ -d "$APP_DIR" ] || chyba "ve větvi není složka cyklo-ski-mapa – naklonujte větev, kde aplikace je (CSM_VETEV=… nebo git clone -b …)."
  fi
  prevezmi_stare_nastaveni
  vytvor_env "${d:-$(domena)}"
  [ -n "$d" ] && export CSM_DOMAIN="${CSM_DOMAIN:-$d}"
  synchronizuj_env
  synchronizuj_cloudflare
  over_caddyfile
  echo "→ Stavím a spouštím (aplikace + Caddy)…"
  # Běží-li aplikace už odjinud (převzetí z původního místa), zůstane její image jako cesta zpět.
  if docker image inspect "$IMAGE:latest" >/dev/null 2>&1; then docker tag "$IMAGE:latest" "$IMAGE:predchozi"; fi
  APP_VERSION="$(verze_z_gitu)" compose up -d --build
  if ! cekej_na_app; then
    if docker image inspect "$IMAGE:predchozi" >/dev/null 2>&1; then
      echo "CHYBA: nová verze neodpovídá – vracím předchozí." >&2
      zpet
    fi
    exit 1
  fi
  nacti_caddy
  cekej_na_web || true
  mkdir -p "$ZALOHY"
  zajisti_cron
  echo
  echo "Hotovo. Další krok: v GitHubu nastavit automatické nasazení (NASAZENI.md)."
}

# První instalace do nového místa na serveru, kde už mapa běží ze sdíleného klonu (/opt/Doma): převezme se .env
# (doména, uživatelé, nastavení). Kontejnery, svazky (stav oslovení, certifikáty) i síť zůstávají, protože projekt
# Compose se jmenuje pořád „deploy“ – compose up z nového místa je jen převezme a znovu vytvoří.
prevezmi_stare_nastaveni() {
  local stary="${CSM_STARY_DEPLOY:-/opt/Doma/cyklo-ski-mapa/deploy}"
  [ -f "$DEPLOY_DIR/.env" ] && return 0
  [ "$stary" != "$DEPLOY_DIR" ] && [ -f "$stary/.env" ] || return 0
  mkdir -p "$DEPLOY_DIR"
  cp -p "$stary/.env" "$DEPLOY_DIR/.env" && chmod 600 "$DEPLOY_DIR/.env"
  echo "→ Převzato nastavení z $stary/.env (původní nasazení ve sdíleném klonu); kontejnery a data pokračují."
}

# Dočasný kontejner Caddy se stejnými soubory jako ostrý: Caddyfile z disku (tj. ten, který se právě nasazuje),
# bloky dalších webů (/opt/caddy-extra, /config/sites ze svazku) a Origin certifikát. Návratový kód 3 = compose
# nemá vlastní Caddy (varianta caddy-externi) – kontroly se pak přeskočí.
caddy_docasne() {
  local image volby=()
  image="$(sed -n 's/^[[:space:]]*image:[[:space:]]*\(caddy[^[:space:]]*\).*/\1/p' "$DEPLOY_DIR/$COMPOSE_FILE" | head -1)"
  [ -n "$image" ] || return 3
  mkdir -p "$CADDY_EXTRA" "$ORIGIN_DIR"
  volby=(-e "DOMAIN=$(domena)" -v "$DEPLOY_DIR/Caddyfile:/etc/caddy/Caddyfile:ro"
    -v "$CADDY_EXTRA:/etc/caddy/extra:ro" -v "$ORIGIN_DIR:/etc/caddy/origin:ro")
  if docker volume inspect deploy_caddy_config >/dev/null 2>&1; then volby+=(-v deploy_caddy_config:/config:ro); fi
  docker run --rm "${volby[@]}" "$image" caddy "$@" --config /etc/caddy/Caddyfile --adapter caddyfile
}

# Hostitelé všech webů na sdílené Caddy (náš blok i importy dalších projektů), z adaptované konfigurace.
hosty_caddy() {
  { caddy_docasne adapt 2>/dev/null || true; } | grep -o '"host":\[[^]]*\]' | grep -o '"[^"]*"' | tr -d '"' | grep -vx 'host' | sort -u || true
}

# Názvy (SAN) z certifikátu, jeden na řádek.
sany_certifikatu() {
  openssl x509 -noout -text -in "$1" 2>/dev/null | grep -A1 'Subject Alternative Name' | tail -n 1 \
    | tr ',' '\n' | sed -n 's/^[[:space:]]*DNS:[[:space:]]*//p'
}

# Pokrývá certifikát host? $1 = host, další argumenty = názvy z certifikátu (*.domena.cz kryje právě jednu úroveň).
pokryva_cert() {
  local h="$1" s suf z
  shift
  for s in "$@"; do
    [ "$h" = "$s" ] && return 0
    case "$s" in
      '*.'*)
        suf="${s#\*.}"
        case "$h" in
          *".$suf")
            z="${h%".$suf"}"
            case "$z" in '' | *.*) ;; *) return 0 ;; esac
            ;;
        esac
        ;;
    esac
  done
  return 1
}

# Vede DNS hostu přímo na tento server (záznam „DNS only“)? Za proxy Cloudflare vede na adresy Cloudflare.
miri_na_server() {
  local ip vlastni
  vlastni=" $(hostname -I 2>/dev/null | tr '\n' ' ') "
  for ip in $(getent ahosts "$1" 2>/dev/null | awk '{print $1}' | sort -u); do
    case "$vlastni" in *" $ip "*) return 0 ;; esac
  done
  return 1
}

# Cloudflare před serverem (NASAZENI.md, oddíl „Cloudflare před serverem“): Origin certifikát ze secrets GitHubu se
# uloží do $ORIGIN_DIR (v kontejneru Caddy /etc/caddy/origin). CSM_CLOUDFLARE=1 ho zapne souborem tls.caddy, který
# Caddyfile importuje – Caddy pak pro doménu (a kvůli *.ksprehledy.cz i pro další weby na serveru) nepoužije
# Let's Encrypt. CSM_CLOUDFLARE=0 ho vypne; nezadáno = beze změny (ruční běh na serveru nic nepřepíná).
synchronizuj_cloudflare() {
  mkdir -p "$ORIGIN_DIR" && chmod 755 "$ORIGIN_DIR"
  local cert="$ORIGIN_DIR/cert.pem" key="$ORIGIN_DIR/key.pem" tls="$ORIGIN_DIR/tls.caddy"
  local radek="tls /etc/caddy/origin/cert.pem /etc/caddy/origin/key.pem"
  if [ -n "${CSM_ORIGIN_CERT_B64:-}" ] && [ -n "${CSM_ORIGIN_KEY_B64:-}" ]; then
    printf %s "$CSM_ORIGIN_CERT_B64" | base64 -d > "$cert.tmp" || chyba "CSM_ORIGIN_CERT_B64 není base64."
    printf %s "$CSM_ORIGIN_KEY_B64" | base64 -d > "$key.tmp" || chyba "CSM_ORIGIN_KEY_B64 není base64."
    chmod 600 "$cert.tmp" "$key.tmp"
    if command -v openssl >/dev/null 2>&1; then
      openssl x509 -noout -in "$cert.tmp" 2>/dev/null || chyba "Origin certifikát není platný PEM certifikát."
      openssl pkey -noout -in "$key.tmp" 2>/dev/null || chyba "Origin klíč není platný PEM soukromý klíč."
      [ "$(openssl x509 -noout -pubkey -in "$cert.tmp")" = "$(openssl pkey -pubout -in "$key.tmp" 2>/dev/null)" ] \
        || chyba "Origin certifikát a klíč k sobě nepatří."
    fi
    if ! cmp -s "$cert.tmp" "$cert" || ! cmp -s "$key.tmp" "$key"; then
      mv "$cert.tmp" "$cert" && mv "$key.tmp" "$key" && chmod 644 "$cert" && chmod 600 "$key"
      CADDY_ZMENA=1
      echo "→ Cloudflare Origin certifikát uložen do $ORIGIN_DIR ($(openssl x509 -noout -enddate -in "$cert" 2>/dev/null | sed 's/notAfter=/platí do /' || echo 'bez openssl'))."
    else
      rm -f "$cert.tmp" "$key.tmp"
    fi
  fi
  case "${CSM_CLOUDFLARE:-}" in
    1)
      [ -s "$cert" ] && [ -s "$key" ] || chyba "CSM_CLOUDFLARE=1, ale na serveru není Origin certifikát – vyplňte secrets CSM_ORIGIN_CERT a CSM_ORIGIN_KEY."
      local sany=() h prime=""
      mapfile -t sany < <(sany_certifikatu "$cert")
      [ "${#sany[@]}" -gt 0 ] || chyba "Origin certifikát v $cert nemá žádné názvy (SAN)."
      pokryva_cert "$(domena)" "${sany[@]}" || chyba "Origin certifikát nepokrývá $(domena) (pokrývá: ${sany[*]}) – vytvořte v Cloudflare certifikát, který ji zahrnuje."
      # Caddy podá Origin certifikát každému svému webu, který pokrývá – i Půjčovně kol a dalším projektům na serveru
      # (a Let's Encrypt pro ně přestane obnovovat). Prohlížeče mu věří jen přes Cloudflare, proto musí být za proxy všechny.
      while read -r h; do
        case "$h" in '' | *'*'*) continue ;; esac
        pokryva_cert "$h" "${sany[@]}" || continue
        if miri_na_server "$h"; then prime="$prime $h"; fi
      done < <({ domena; hosty_caddy; } | sort -u)
      [ -z "$prime" ] || chyba "CSM_CLOUDFLARE=1, ale tyto weby na serveru pokrývá Origin certifikát a jejich DNS zatím vede přímo sem (DNS only):$prime. Bez Cloudflare by jim prohlížeče nevěřily. V Cloudflare u nich zapněte proxy (oranžový mrak), počkejte ~5 minut a nasazení zopakujte."
      if [ "$(cat "$tls" 2>/dev/null)" != "$radek" ]; then
        printf '%s\n' "$radek" > "$tls.tmp" && mv "$tls.tmp" "$tls"
        TLS_NOVY=1
        CADDY_ZMENA=1
        echo "→ Cloudflare zapnuto: Caddy použije Origin certifikát pro weby, které pokrývá (Let's Encrypt pro ně skončí)."
      fi
      ;;
    0)
      if [ -e "$tls" ]; then
        rm -f "$tls"
        CADDY_ZMENA=1
        echo "→ Cloudflare vypnuto: Caddy si bere certifikát od Let's Encrypt."
      fi
      ;;
  esac
}

# Nový Caddyfile se ověří v dočasném kontejneru ještě před nasazením (se všemi importy). Kdyby byl neplatný a Caddy
# se s ním spustila, spadly by všechny weby na serveru (i Půjčovna kol a Kolomapa); takhle běží dál ty stávající.
over_caddyfile() {
  local vystup rc=0
  vystup="$(caddy_docasne validate 2>&1)" || rc=$?
  [ "$rc" = 3 ] && return 0
  if [ "$rc" != 0 ]; then
    printf '%s\n' "$vystup" | grep -v '"level":"info"' | tail -15 >&2
    if [ "$TLS_NOVY" = 1 ]; then
      rm -f "$ORIGIN_DIR/tls.caddy"
      echo "→ Zapnutí Origin certifikátu vráceno (tls.caddy odstraněn)." >&2
    fi
    chyba "konfigurace Caddy neprošla kontrolou – nic se nenasadilo, weby běží beze změny."
  fi
  echo "→ Konfigurace Caddy ověřena (dočasný kontejner, včetně webů dalších projektů)."
}

# Po nasazení se Caddy načte znovu – Compose změnu Caddyfile ani /opt/caddy-origin sám nepozná. Caddyfile je do
# kontejneru připojený jako soubor a git ho při aktualizaci nahradí novým (jiný inode): běžící kontejner pak vidí
# pořád ten starý a reload nestačí, je potřeba restart (pár sekund výpadek všech webů na serveru). Změnám
# v adresářích /opt/caddy-origin a /opt/caddy-extra reload stačí.
nacti_caddy() {
  local id
  id="$(compose ps -q caddy 2>/dev/null || true)"
  [ -n "$id" ] || return 0
  if ! docker exec "$id" cat /etc/caddy/Caddyfile 2>/dev/null | cmp -s - "$DEPLOY_DIR/Caddyfile"; then
    echo "→ Caddyfile se změnil – restartuji Caddy (pár sekund výpadek webů na serveru)…"
    compose restart caddy >/dev/null
    id="$(compose ps -q caddy 2>/dev/null || true)"
    if [ -n "$id" ] && ! docker exec "$id" cat /etc/caddy/Caddyfile 2>/dev/null | cmp -s - "$DEPLOY_DIR/Caddyfile"; then
      compose up -d --force-recreate --no-deps caddy >/dev/null
    fi
    return 0
  fi
  if ! docker exec "$id" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    echo "VAROVÁNÍ: reload Caddy selhal – restartuji kontejner." >&2
    compose restart caddy >/dev/null
  elif [ "$CADDY_ZMENA" = 1 ]; then
    echo "→ Caddy znovu načtena s novým nastavením."
  fi
  return 0
}

# Mapa běží z jednoho místa (kontejnery projektu „deploy“). Skript puštěný odjinud – např. ze starého sdíleného
# klonu /opt/Doma – by je přestavěl z cizí větve, proto se porovná s místem, ze kterého aplikace běží teď.
hlidej_misto() {
  local id wd stary="${CSM_STARY_DEPLOY:-/opt/Doma/cyklo-ski-mapa/deploy}"
  id="$(compose ps -q app 2>/dev/null || true)"
  [ -n "$id" ] || return 0
  wd="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$id" 2>/dev/null || true)"
  if [ -z "$wd" ] || [ "$wd" = "$DEPLOY_DIR" ]; then return 0; fi
  if [ "$wd" = "$stary" ]; then
    echo "→ Aplikace zatím běží z původního místa $wd – přebírám ji do $DEPLOY_DIR."
    return 0
  fi
  chyba "aplikace běží z $wd, tento skript je z $DEPLOY_DIR – nejspíš starý klon. Použijte: sudo bash $wd/hetzner.sh … (nebo nasazení z GitHubu)."
}

# Klon $REPO_DIR může sdílet víc projektů (Půjčovna kol, Kolomapa) a na serveru pak bývá vytažená jejich větev.
# Větev se tu nepřepíná – druhý projekt by přišel o své soubory i cron – ale nasadit se smí jen tehdy, když má
# nasazovaná větev (CSM_VETEV z GitHub Actions) stejnou aplikaci jako to, co je na disku. Jinak by se
# tiše nasadil cizí kód a změny z hlavní větve by na web nikdy nedošly.
zkontroluj_vetev() {
  [ -n "${CSM_VETEV:-}" ] || return 0
  local vytazena slozka
  vytazena="$(git -C "$REPO_DIR" branch --show-current 2>/dev/null || true)"
  [ -n "$vytazena" ] && [ "$vytazena" != "$CSM_VETEV" ] || return 0
  slozka="$(realpath --relative-to="$REPO_DIR" "$APP_DIR")"
  git -C "$REPO_DIR" fetch -q origin "$CSM_VETEV" || chyba "větev $CSM_VETEV na GitHubu není."
  # Srovnává se to, co doběhne na server: obsah image (podle .dockerignore bez cache/, test/, tools/, deploy/)
  # bez dokumentace, plus compose a Caddyfile. Samotný hetzner.sh přichází ze stdin z nasazované větve.
  local vyluky=(":(exclude)$slozka/cache" ":(exclude)$slozka/test" ":(exclude)$slozka/tools" ":(exclude)$slozka/deploy" ":(exclude)$slozka/docs" ":(exclude)$slozka/*.md")
  if git -C "$REPO_DIR" diff --quiet "origin/$CSM_VETEV" HEAD -- "$slozka" "${vyluky[@]}" \
     && git -C "$REPO_DIR" diff --quiet "origin/$CSM_VETEV" HEAD -- "$slozka/deploy/${CSM_COMPOSE:-docker-compose.yml}" "$slozka/deploy/Caddyfile"; then
    echo "→ Na serveru je vytažená větev $vytazena (sdílený klon s dalším projektem); nasazovaná $CSM_VETEV má stejnou aplikaci – pokračuji."
  else
    chyba "na serveru je vytažená větev $vytazena, nasazuje se $CSM_VETEV a složka $slozka se v nich liší – nasadil by se cizí kód. Slučte větev $vytazena do $CSM_VETEV (nebo naopak), pak nasazení zopakujte."
  fi
}

aktualizace() {
  [ -d "$APP_DIR" ] || chyba "není nainstalováno ($APP_DIR chybí) – spusťte nejdřív: hetzner.sh instalace DOMENA"
  if [ -n "$(git -C "$REPO_DIR" status --porcelain 2>/dev/null)" ]; then
    echo "VAROVÁNÍ: v $REPO_DIR jsou necommitnuté změny – kód z GitHubu nestahuji, stavím to, co je na disku."
  else
    local vetev
    vetev="$(git -C "$REPO_DIR" branch --show-current)"
    if [ -n "$vetev" ] && git -C "$REPO_DIR" fetch -q origin "$vetev" && git -C "$REPO_DIR" merge -q --ff-only "origin/$vetev"; then
      echo "→ Kód aktualizován z origin/$vetev ($(git -C "$REPO_DIR" log -1 --format='%h %s'))"
    else
      echo "VAROVÁNÍ: aktualizace z GitHubu nešla rychloposunem – stavím aktuálně vytažený stav."
    fi
  fi
  hlidej_misto
  zkontroluj_vetev
  synchronizuj_env
  synchronizuj_cloudflare
  over_caddyfile
  # předchozí verze pro cestu zpět – před buildem, než se přepíše tag latest
  if docker image inspect "$IMAGE:latest" >/dev/null 2>&1; then docker tag "$IMAGE:latest" "$IMAGE:predchozi"; fi
  echo "→ Stavím a spouštím…"
  APP_VERSION="$(verze_z_gitu)" compose up -d --build
  if ! cekej_na_app; then
    echo "CHYBA: nová verze neodpovídá – vracím předchozí." >&2
    zpet
    exit 1
  fi
  nacti_caddy
  docker image prune -f >/dev/null 2>&1 || true
  zajisti_cron
  cekej_na_web || true
}

zpet() {
  hlidej_misto
  docker image inspect "$IMAGE:predchozi" >/dev/null 2>&1 || chyba "žádná předchozí verze ($IMAGE:predchozi) není uložená."
  echo "→ Vracím předchozí verzi…"
  docker tag "$IMAGE:predchozi" "$IMAGE:latest"
  compose up -d --no-build app
  cekej_na_app && echo "Běží předchozí verze: $(compose exec -T app wget -qO- http://127.0.0.1:8090/api/health)"
}

# Denní záloha stavu přes cron – nastavuje se automaticky po instalaci i aktualizaci (CSM_CRON=0 vypne).
zajisti_cron() {
  [ "${CSM_CRON:-1}" = "1" ] || return 0
  [ -d /etc/cron.d ] || return 0
  local soubor=/etc/cron.d/cyklo-ski-mapa-zaloha
  local obsah="# Denní záloha stavu oslovení Cyklo & Ski mapy (hetzner.sh zaloha)
30 2 * * * root bash $DEPLOY_DIR/hetzner.sh zaloha >> /var/log/cyklo-ski-mapa-zaloha.log 2>&1"
  if [ ! -f "$soubor" ] || [ "$(cat "$soubor")" != "$obsah" ]; then
    printf '%s\n' "$obsah" > "$soubor"
    chmod 644 "$soubor"
    echo "→ Denní záloha stavu ve 2:30 nastavena ($soubor, kopie v $ZALOHY)."
  fi
}

zaloha() {
  mkdir -p "$ZALOHY"
  if [ "${1:-}" = "--cron" ]; then
    rm -f /etc/cron.d/cyklo-ski-mapa-zaloha
    zajisti_cron
  fi
  local cil="$ZALOHY/stav-$(date +%F-%H%M).json"
  if compose cp app:/data/stav.json "$cil" >/dev/null 2>&1; then
    echo "→ Záloha: $cil ($(wc -c <"$cil") B)"
  else
    echo "→ Zatím žádný stav.json (nikdo nic neuložil) – není co zálohovat."
  fi
  ls -1t "$ZALOHY"/stav-*.json 2>/dev/null | tail -n +61 | xargs -r rm -f   # nechat 60 nejnovějších
}

stav() {
  compose ps
  echo "--- health ---"
  compose exec -T app wget -qO- http://127.0.0.1:8090/api/health 2>/dev/null || echo "aplikace neodpovídá"
  echo
  local d
  d="$(domena)"
  [ -n "$d" ] && { curl -fsS -m 5 "https://$d/api/health" || echo "web https://$d neodpovídá"; echo; }
  echo "--- disk ---"
  df -h / | tail -1
  docker system df 2>/dev/null | head -5 || true
}

case "${1:-}" in
  instalace) instalace "${2:-}" ;;
  aktualizace) aktualizace ;;
  zpet) zpet ;;
  zaloha) zaloha "${2:-}" ;;
  stav) stav ;;
  log) compose logs --tail 100 -f ;;
  *)
    echo "Použití: hetzner.sh instalace DOMENA | aktualizace | zaloha [--cron] | zpet | stav | log" >&2
    exit 1
    ;;
esac
