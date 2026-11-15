#!/usr/bin/env bash
# Nasazení Investiční školy na server Hetzner vedle Cyklo & Ski mapy (sdílená Caddy z cyklo-ski-mapa/deploy).
#
# Spouští ho workflow .github/workflows/investovani.yml přes SSH (skript jde stdinem z nasazovaného commitu).
# Zdrojáky workflow předem nahraje do /opt/investovani/src.new. Skript:
#   1. uloží otisk hesla do /opt/investovani/.env (heslo samotné na server nejde),
#   2. postaví image a vymění kontejner `investovani`; když nový neodpoví, vrátí předchozí,
#   3. zapíše blok domény do /opt/caddy-extra/investovani.caddy, ověří celou konfiguraci Caddy a načte ji;
#      když ji Caddy nepřijme, blok vrátí a skončí chybou – ostatní weby na serveru zůstanou, jak byly.
# Deník obchodů žije ve svazku `investovani_data` a nasazení na něj nesahá.
#
# Proměnné: INV_DOMENA (povinná), INV_VERZE, INV_HESLO_HASH_B64 (otisk hesla v base64; bez něj platí dosavadní).
set -euo pipefail

DIR=/opt/investovani
NOVY=$DIR/src.new
SRC=$DIR/src
ENVF=$DIR/.env
CADDY_EXTRA=/opt/caddy-extra
BLOK=$CADDY_EXTRA/investovani.caddy
DOMENA="${INV_DOMENA:-}"
VERZE="${INV_VERZE:-rucne}"

chyba() { echo "✗ $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || chyba "Spusť jako root (nebo přes sudo)."
command -v docker >/dev/null || chyba "Na serveru chybí docker."
[[ "$DOMENA" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] || chyba "INV_DOMENA musí být doména malými písmeny, např. investice.ksprehledy.cz (dostal jsem '$DOMENA')."
case "$VERZE" in ""|*[!A-Za-z0-9._-]*) chyba "INV_VERZE smí obsahovat jen písmena, číslice, tečku, - a _." ;; esac
[ -f "$NOVY/server.js" ] && [ -f "$NOVY/trh.js" ] && [ -f "$NOVY/zdroje.js" ] && [ -f "$NOVY/index.html" ] && [ -f "$NOVY/Dockerfile" ] || chyba "V $NOVY nejsou zdrojáky (server.js, trh.js, zdroje.js, index.html, Dockerfile)."

echo "== 1/4 Heslo"
mkdir -p "$DIR" && chmod 700 "$DIR"
if [ -n "${INV_HESLO_HASH_B64:-}" ]; then
  otisk="$(printf %s "$INV_HESLO_HASH_B64" | base64 -d)" || chyba "INV_HESLO_HASH_B64 není base64."
  case "$otisk" in scrypt:*:*:*:*:*) ;; *) chyba "Otisk hesla nemá očekávaný tvar." ;; esac
  ( umask 077; printf 'INV_HESLO_HASH=%s\n' "$otisk" > "$ENVF.tmp" ) && mv "$ENVF.tmp" "$ENVF"
  echo "  ✓ otisk hesla uložen do $ENVF"
fi
[ -s "$ENVF" ] || chyba "Na serveru není otisk hesla a nasazení ho neposlalo (secret INVESTOVANI_HESLO)."

echo "== 2/4 Sdílená Caddy"
CADDY="$(docker ps -q --filter label=com.docker.compose.project=deploy --filter label=com.docker.compose.service=caddy | head -1)"
[ -n "$CADDY" ] || chyba "Nenašel jsem běžící kontejner Caddy (compose projekt 'deploy' z cyklo-ski-mapa). Nic jsem nezměnil."
SIT="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$CADDY" | sed '/^$/d' | head -1)"
[ -n "$SIT" ] || chyba "Kontejner Caddy není v žádné Docker síti."
docker inspect -f '{{range .Mounts}}{{println .Source}}{{end}}' "$CADDY" | grep -qx "$CADDY_EXTRA" \
  || chyba "Caddy nemá připojenou složku $CADDY_EXTRA, blok domény by nenačetla. Nic jsem nezměnil."
echo "  ✓ Caddy $CADDY, síť $SIT"

echo "== 3/4 Kontejner"
docker build --build-arg APP_VERSION="$VERZE" -t "investovani:$VERZE" "$NOVY"
PRED="$(docker inspect -f '{{.Config.Image}}' investovani 2>/dev/null || true)"
spust() {
  docker rm -f investovani >/dev/null 2>&1 || true
  docker run -d --name investovani --restart unless-stopped --network "$SIT" \
    --env-file "$ENVF" -e INV_TRUST_PROXY=1 -v investovani_data:/data "$1" >/dev/null
}
zdravy() {
  local i odp
  for i in $(seq 1 30); do
    odp="$(docker exec investovani wget -qO- http://127.0.0.1:8095/api/health 2>/dev/null || true)"
    case "$odp" in *'"ok":true'*) echo "  $odp"; return 0 ;; esac
    sleep 1
  done
  return 1
}
spust "investovani:$VERZE"
if ! zdravy; then
  echo "--- log nového kontejneru ---" >&2; docker logs --tail 40 investovani >&2 || true
  if [ -n "$PRED" ] && [ "$PRED" != "investovani:$VERZE" ]; then
    if spust "$PRED" && zdravy >/dev/null; then echo "→ Vrácen předchozí kontejner ($PRED), běží." >&2
    else echo "→ Předchozí kontejner ($PRED) se nepodařilo vrátit – web neběží (docker logs investovani)." >&2; fi
  fi
  chyba "Nový kontejner neodpověděl na /api/health."
fi
docker exec investovani wget -qO- http://127.0.0.1:8095/api/health | grep -q '"heslo":true' || chyba "Kontejner běží, ale nemá heslo."
docker exec investovani wget -qO- http://127.0.0.1:8095/api/health | grep -q '"denik":true' || echo "  ⚠ Deník na serveru nejde přečíst, zápis je vypnutý (svazek investovani_data, soubor denik.json)."
rm -rf "$SRC" && mv "$NOVY" "$SRC"
docker image tag "investovani:$VERZE" investovani:latest
echo "  ✓ běží investovani:$VERZE"

echo "== 4/4 Doména $DOMENA"
mkdir -p "$CADDY_EXTRA"
cat > "$BLOK.tmp" <<CADDY
# Investiční škola (Doma/investovani) – zapisuje investovani/deploy/nasadit.sh, ručně neupravovat.
$DOMENA {
	# Cloudflare Origin certifikát, je-li na serveru zapnutý (viz cyklo-ski-mapa/NASAZENI.md); jinak Let's Encrypt
	import /etc/caddy/origin/*.caddy
	encode zstd gzip
	reverse_proxy investovani:8095 {
		header_up X-Forwarded-For {client_ip}
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		-Server
	}
}
CADDY
if [ -f "$BLOK" ] && cmp -s "$BLOK.tmp" "$BLOK"; then
  rm -f "$BLOK.tmp"
  echo "  ✓ blok domény beze změny"
else
  [ -f "$BLOK" ] && cp "$BLOK" "$BLOK.predchozi"
  mv "$BLOK.tmp" "$BLOK" && chmod 644 "$BLOK"
  if vystup="$(docker exec "$CADDY" caddy validate --config /etc/caddy/Caddyfile 2>&1)"; then
    docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || chyba "Caddy konfiguraci ověřila, ale nenačetla (docker logs $CADDY)."
    rm -f "$BLOK.predchozi"
    echo "  ✓ blok domény zapsán a Caddy načtena"
  else
    if [ -f "$BLOK.predchozi" ]; then mv "$BLOK.predchozi" "$BLOK"; else rm -f "$BLOK"; fi
    echo "$vystup" | tail -15 >&2
    chyba "Caddy novou konfiguraci nepřijala – blok domény jsem vrátil, ostatní weby běží beze změny."
  fi
fi
docker exec "$CADDY" wget -qO- http://investovani:8095/api/health >/dev/null 2>&1 \
  && echo "  ✓ Caddy na aplikaci dosáhne" || echo "  ⚠ Caddy na kontejner investovani nedosáhla (síť $SIT)."
if getent ahosts "$DOMENA" >/dev/null 2>&1; then
  echo "  ✓ DNS pro $DOMENA existuje"
else
  echo "  ⚠ DNS záznam pro $DOMENA zatím neexistuje – přidej ho v Cloudflare (se zapnutou proxy)."
fi
echo "Hotovo: https://$DOMENA (verze $VERZE)"
