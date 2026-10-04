#!/usr/bin/env bash
# Kolomapa na vlastním serveru (Ubuntu 22.04+/Debian 12+): služba systemd + HTTPS přes Caddy + denní záloha.
#
#   sudo bash deploy/instalace.sh mapa.vasedomena.cz
#
# Spouštějte ze složky s kódem (git clone). Skript lze pustit znovu (např. po změně domény) – nic nezdvojí,
# nastaveni.txt a databázi nepřepíše. Podrobný návod: deploy/NASAZENI.md
set -euo pipefail

DOMAIN="${1:-}"
PORT="${KOLOMAPA_PORT:-8090}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVC_USER=kolomapa
BACKUP_DIR=/var/backups/kolomapa

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\nCHYBA: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "spusťte přes sudo: sudo bash $0 mapa.vasedomena.cz"
[[ -n "$DOMAIN" ]] || die "chybí doména. Použití: sudo bash $0 mapa.vasedomena.cz"
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || die "„$DOMAIN“ nevypadá jako doména (např. mapa.koloshop.cz)"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "KOLOMAPA_PORT musí být číslo"
[[ -f "$APP_DIR/server.js" && -f "$APP_DIR/package.json" ]] || die "skript musí ležet ve složce kolomapa/deploy (nenašel jsem $APP_DIR/server.js)"
command -v apt-get >/dev/null || die "skript umí jen Ubuntu/Debian (apt). Jinde postupujte podle deploy/NASAZENI.md ručně."

export DEBIAN_FRONTEND=noninteractive

say "Balíčky systému"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git sqlite3 >/dev/null

say "Node.js 22 LTS"
node_ok() {
  command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'
}
if node_ok; then
  echo "Node.js $(node -v) už je nainstalovaný."
else
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh >/dev/null
  rm -f /tmp/nodesource_setup.sh
  apt-get install -y -qq nodejs >/dev/null
  node_ok || die "Node.js 22.13+ se nepodařilo nainstalovat (máte $(node -v 2>/dev/null || echo nic))"
  echo "Nainstalován Node.js $(node -v)."
fi
NODE_BIN="$(command -v node)"

say "Uživatel služby a složky"
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/kolomapa --create-home --shell /usr/sbin/nologin "$SVC_USER"
fi
install -d -o "$SVC_USER" -g "$SVC_USER" -m 750 "$APP_DIR/data"
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR/data" "$APP_DIR/training"
install -d -o root -g root -m 700 "$BACKUP_DIR"

say "Nastavení (nastaveni.txt)"
SETTINGS="$APP_DIR/nastaveni.txt"
if [[ -f "$SETTINGS" ]]; then
  echo "nastaveni.txt už existuje – nechávám ho beze změny."
  grep -q '^KOLOMAPA_TRUST_PROXY=' "$SETTINGS" || printf '\nKOLOMAPA_TRUST_PROXY=1\n' >>"$SETTINGS"
  PASSWORD="(beze změny – viz KOLOMAPA_PASSWORD v $SETTINGS)"
else
  PASSWORD="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-20)"
  cat >"$SETTINGS" <<EOF
# Nastavení Kolomapy na serveru $DOMAIN (vytvořil deploy/instalace.sh).
# Po změně: sudo systemctl restart kolomapa. Všechny volby: README.md a src/config.js.

# Kolomapa poslouchá jen lokálně, ven ji pouští Caddy s HTTPS.
KOLOMAPA_HOST=127.0.0.1
KOLOMAPA_PORT=$PORT
KOLOMAPA_TRUST_PROXY=1

# Heslo do mapy (jméno při přihlášení libovolné).
KOLOMAPA_PASSWORD=$PASSWORD

# Čas denního stahování (pražský čas):
#KOLOMAPA_SCHEDULE=05:30

# Weby – výchozí bazos. Ostatní viz README.md (Zdroje, šetrnost a pravidla).
#KOLOMAPA_SOURCES=bazos

# AI nacenění podle fotek (placené; vyžaduje: cd $APP_DIR && sudo -u $SVC_USER npm install):
#ANTHROPIC_API_KEY=
EOF
fi
chown "$SVC_USER:$SVC_USER" "$SETTINGS"
chmod 600 "$SETTINGS"

say "Služba systemd"
sed -e "s#@APP_DIR@#$APP_DIR#g" -e "s#@NODE@#$NODE_BIN#g" "$APP_DIR/deploy/kolomapa.service" >/etc/systemd/system/kolomapa.service
systemctl daemon-reload
systemctl enable kolomapa >/dev/null 2>&1
systemctl restart kolomapa
sleep 3
systemctl is-active --quiet kolomapa || { journalctl -u kolomapa -n 30 --no-pager; die "služba kolomapa nenaběhla (výpis výše)"; }
echo "Služba kolomapa běží (port $PORT, jen lokálně)."

say "HTTPS (Caddy)"
# kdo už poslouchá na 80/443 (prázdné = nikdo; grep bez shody nesmí ukončit skript)
PORT_OWNER="$( (ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null || true) | (grep -oE 'users:\(\("[^"]+' || true) | sed 's/users:(("//' | sort -u | tr '\n' ' ')"
if [[ -n "$PORT_OWNER" && "$PORT_OWNER" != *caddy* ]]; then
  echo "Porty 80/443 už používá: $PORT_OWNER– Caddy neinstaluji."
  echo "Napojte Kolomapu na stávající web server podle deploy/nginx-kolomapa.conf (port $PORT)."
else
  if ! command -v caddy >/dev/null; then
    if ! apt-get install -y -qq caddy >/dev/null 2>&1; then
      # distribuce Caddy nemá → oficiální repozitář Caddy
      apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
      chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -qq
      apt-get install -y -qq caddy >/dev/null
    fi
  fi
  sed -e "s#@DOMAIN@#$DOMAIN#g" -e "s#@PORT@#$PORT#g" "$APP_DIR/deploy/Caddyfile" >/etc/caddy/kolomapa.caddy
  MAIN=/etc/caddy/Caddyfile
  if [[ ! -f "$MAIN" ]] || grep -q '/usr/share/caddy' "$MAIN"; then
    # výchozí ukázkový Caddyfile z balíčku → nahradit (záloha vedle)
    [[ -f "$MAIN" && ! -f "$MAIN.puvodni" ]] && cp "$MAIN" "$MAIN.puvodni"
    echo 'import /etc/caddy/kolomapa.caddy' >"$MAIN"
  elif ! grep -q 'import /etc/caddy/kolomapa.caddy' "$MAIN"; then
    printf '\nimport /etc/caddy/kolomapa.caddy\n' >>"$MAIN"
  fi
  caddy validate --config "$MAIN" --adapter caddyfile >/dev/null
  systemctl enable caddy >/dev/null 2>&1
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  echo "Caddy obsluhuje https://$DOMAIN"
fi

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  echo "Firewall (ufw): povoleny porty 80 a 443."
fi

say "Denní záloha databáze"
cat >/etc/cron.daily/kolomapa-zaloha <<EOF
#!/bin/sh
# Záloha databáze Kolomapy: 7 souborů podle dne v týdnu ($BACKUP_DIR/kolomapa-1.db … -7.db).
DB="$APP_DIR/data/kolomapa.db"
[ -f "\$DB" ] && sqlite3 "\$DB" ".backup '$BACKUP_DIR/kolomapa-\$(date +%u).db'"
EOF
chmod 755 /etc/cron.daily/kolomapa-zaloha

if ! getent ahosts "$DOMAIN" >/dev/null 2>&1; then
  echo
  echo "POZOR: doména $DOMAIN se zatím nepřekládá na žádnou adresu – nastavte u registrátora záznam A na IP tohoto serveru."
  echo "Certifikát HTTPS Caddy vyřídí sám, jakmile se změna DNS projeví (obvykle do hodiny)."
fi

say "Hotovo"
cat <<EOF
Mapa:      https://$DOMAIN   (jméno libovolné, heslo níže)
Heslo:     $PASSWORD
Stav:      systemctl status kolomapa      Log: journalctl -u kolomapa -f
Nastavení: $SETTINGS  (po změně: systemctl restart kolomapa)
Aktualizace: sudo bash $APP_DIR/deploy/aktualizovat.sh

První stahování začalo samo a trvá 2–3 hodiny; mapa se plní průběžně.
EOF
