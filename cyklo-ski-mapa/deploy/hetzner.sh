#!/usr/bin/env bash
# Cyklo & Ski mapa na Hetzneru (nebo jiném VPS s veřejnou IP a doménou): instalace, aktualizace,
# záloha stavu, log, návrat k předchozí verzi. Spouští se NA SERVERU jako root (Ubuntu 22.04/24.04,
# Debian 12). Používá Docker Compose s Caddy (HTTPS z Let's Encrypt automaticky) – deploy/docker-compose.yml.
#
#   apt-get install -y git && git clone https://github.com/ladasuchan1-cmd/Doma.git /opt/Doma
#   bash /opt/Doma/cyklo-ski-mapa/deploy/hetzner.sh instalace mapa.vase-domena.cz
#
#   bash /opt/Doma/cyklo-ski-mapa/deploy/hetzner.sh aktualizace    # stáhne nový kód a znovu postaví (pouští i GitHub Actions)
#   bash /opt/Doma/cyklo-ski-mapa/deploy/hetzner.sh zaloha         # zkopíruje stav.json do /opt/zalohy-cyklo-ski-mapa
#   bash /opt/Doma/cyklo-ski-mapa/deploy/hetzner.sh zaloha --cron  # + denní záloha ve 2:30 (cron)
#   bash /opt/Doma/cyklo-ski-mapa/deploy/hetzner.sh zpet           # vrátí předchozí verzi aplikace
#   bash /opt/Doma/cyklo-ski-mapa/deploy/hetzner.sh stav | log
#
# Proměnné: CSM_REPO_DIR (/opt/Doma), CSM_COMPOSE (docker-compose.yml, pro Caddy v jiném kontejneru
# docker-compose.caddy-externi.yml), CSM_ZALOHY (/opt/zalohy-cyklo-ski-mapa), CSM_USERS (uživatelé pro
# instalaci bez dotazu), CSM_UFW=0 (nenastavovat firewall).
set -euo pipefail

REPO_URL="${CSM_REPO:-https://github.com/ladasuchan1-cmd/Doma.git}"
REPO_DIR="${CSM_REPO_DIR:-/opt/Doma}"
APP_DIR="$REPO_DIR/cyklo-ski-mapa"
DEPLOY_DIR="$APP_DIR/deploy"
COMPOSE_FILE="${CSM_COMPOSE:-docker-compose.yml}"
ZALOHY="${CSM_ZALOHY:-/opt/zalohy-cyklo-ski-mapa}"
IMAGE=cyklo-ski-mapa

compose() { (cd "$DEPLOY_DIR" && docker compose -f "$COMPOSE_FILE" "$@"); }

chyba() { echo "CHYBA: $*" >&2; exit 1; }

domena() { sed -n 's/^DOMAIN=//p' "$DEPLOY_DIR/.env" 2>/dev/null | head -1; }

verze_z_gitu() { git -C "$APP_DIR" log -1 --format='v%cd-%h' --date=format:%Y-%m-%d 2>/dev/null || date +'v%Y-%m-%d-%H%M'; }

# Čeká, až aplikace v kontejneru odpoví na /api/health (a hlásí zapisovatelnou datovou složku).
cekej_na_app() {
  local i
  for i in $(seq 1 60); do
    if compose exec -T app wget -qO- http://127.0.0.1:8090/api/health >/dev/null 2>&1; then return 0; fi
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
  [ "$(id -u)" = 0 ] || chyba "spusťte jako root (ssh root@server)."
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
  vytvor_env "${d:-$(domena)}"
  echo "→ Stavím a spouštím (aplikace + Caddy)…"
  APP_VERSION="$(verze_z_gitu)" compose up -d --build
  cekej_na_app
  cekej_na_web || true
  mkdir -p "$ZALOHY"
  echo
  echo "Hotovo. Další kroky: hetzner.sh zaloha --cron (denní záloha stavu), v GitHubu nastavit automatické nasazení (NASAZENI.md)."
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
  # předchozí verze pro cestu zpět – před buildem, než se přepíše tag latest
  if docker image inspect "$IMAGE:latest" >/dev/null 2>&1; then docker tag "$IMAGE:latest" "$IMAGE:predchozi"; fi
  echo "→ Stavím a spouštím…"
  APP_VERSION="$(verze_z_gitu)" compose up -d --build
  if ! cekej_na_app; then
    echo "CHYBA: nová verze neodpovídá – vracím předchozí." >&2
    zpet
    exit 1
  fi
  docker image prune -f >/dev/null 2>&1 || true
  cekej_na_web || true
}

zpet() {
  docker image inspect "$IMAGE:predchozi" >/dev/null 2>&1 || chyba "žádná předchozí verze ($IMAGE:predchozi) není uložená."
  echo "→ Vracím předchozí verzi…"
  docker tag "$IMAGE:predchozi" "$IMAGE:latest"
  compose up -d --no-build app
  cekej_na_app && echo "Běží předchozí verze: $(compose exec -T app wget -qO- http://127.0.0.1:8090/api/health)"
}

zaloha() {
  mkdir -p "$ZALOHY"
  if [ "${1:-}" = "--cron" ]; then
    cat > /etc/cron.d/cyklo-ski-mapa-zaloha <<EOF
# Denní záloha stavu oslovení Cyklo & Ski mapy (hetzner.sh zaloha)
30 2 * * * root bash $DEPLOY_DIR/hetzner.sh zaloha >> /var/log/cyklo-ski-mapa-zaloha.log 2>&1
EOF
    chmod 644 /etc/cron.d/cyklo-ski-mapa-zaloha
    echo "→ Denní záloha ve 2:30 nastavena (/etc/cron.d/cyklo-ski-mapa-zaloha)."
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
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
