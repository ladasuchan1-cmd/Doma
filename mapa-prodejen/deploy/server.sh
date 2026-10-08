#!/usr/bin/env bash
# Mapa prodejen a servisů kol na serveru s Cyklo & Ski mapou (Hetzner, ksprehledy.cz): nasazení, návrat zpět,
# záloha, stav, log. Spouští se NA SERVERU jako root. Aplikace běží jako kontejner „mapa-prodejen“ v Docker síti
# Caddy mapy (deploy_default); web pouští ven Caddy mapy přes blok /opt/caddy-extra/mapa-prodejen.caddy.
#
# Nasazení z GitHub Actions (workflow „Mapa prodejen“): runner pošle přes SSH archiv složky mapa-prodejen
# z nasazovaného commitu (/opt/mapa-prodejen/vydani/<commit>.tar.gz) a pak tento skript ze stdin:
#   ssh agent@server 'sudo -n env MP_VYDANI=<commit> MP_DOMENA=mapa.ksprehledy.cz bash -s -- nasadit' < deploy/server.sh
# Na serveru git ani přístup k repozitáři není potřeba – nasadí se přesně ten commit, který prošel testy.
#
# Ručně na serveru (skript leží v aktuálním vydání):
#   sudo bash /opt/mapa-prodejen/app/deploy/server.sh stav | log | zaloha | zpet
#
# Proměnné: MP_VYDANI (commit = jméno archivu ve /opt/mapa-prodejen/vydani), MP_VERZE (verze do /api/health),
# MP_DOMENA (mapa.ksprehledy.cz), MP_USERS_B64 (uživatelé „jmeno:heslo;…“ v base64 – jinak se převezmou
# z Cyklo & Ski mapy), MP_SIT (Docker síť Caddy, deploy_default), MP_CADDY_EXTRA (/opt/caddy-extra),
# MP_ZALOHY (/opt/zalohy-mapa-prodejen), MP_CADDY_ORIGIN (/opt/caddy-origin – Origin certifikát Cloudflare od cyklomapy).
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "CHYBA: spusťte jako root (sudo bash $0 …)." >&2; exit 1; }

APP=mapa-prodejen
IMAGE=mapa-prodejen
KOREN=/opt/mapa-prodejen
VYDANI_DIR="$KOREN/vydani"
ENV_FILE="$KOREN/mapa-prodejen.env"
SVAZEK=mapa-prodejen-data
PORT=8094
DOMENA="${MP_DOMENA:-mapa.ksprehledy.cz}"
SIT="${MP_SIT:-deploy_default}"
EXTRA="${MP_CADDY_EXTRA:-/opt/caddy-extra}"
BLOK="$EXTRA/mapa-prodejen.caddy"
ZALOHY="${MP_ZALOHY:-/opt/zalohy-mapa-prodejen}"
ORIGIN="${MP_CADDY_ORIGIN:-/opt/caddy-origin}"
MAPA_ENV=/opt/cyklo-ski-mapa/Doma/cyklo-ski-mapa/deploy/.env

chyba() { echo "CHYBA: $*" >&2; exit 1; }
krok() { echo "→ $*"; }

command -v docker >/dev/null 2>&1 || chyba "na serveru není Docker (instaluje ho nasazení Cyklo & Ski mapy)."
[[ "$DOMENA" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || chyba "neplatná doména „$DOMENA“."

# Caddy z Docker Compose projektu Cyklo & Ski mapy („deploy“), služba caddy.
caddy_id() {
  local id
  id="$(docker ps -q --filter label=com.docker.compose.project=deploy --filter label=com.docker.compose.service=caddy | head -1)"
  [ -n "$id" ] || id="$(docker ps -q --filter name='^deploy-caddy-1$' | head -1)"
  printf '%s' "$id"
}

# Vede DNS hostu přímo na tento server (záznam „DNS only“)? Za proxy Cloudflare vede na adresy Cloudflare.
# (Stejná kontrola jako v cyklo-ski-mapa/deploy/hetzner.sh.)
miri_na_server() {
  local ip vlastni
  vlastni=" $(hostname -I 2>/dev/null | tr '\n' ' ') "
  for ip in $(getent ahosts "$1" 2>/dev/null | awk '{print $1}' | sort -u); do
    case "$vlastni" in *" $ip "*) return 0 ;; esac
  done
  return 1
}

# Caddy mapy podává za Cloudflare Origin certifikát, kterému prohlížeče věří jen přes proxy. Web s DNS „DNS only“
# by měl neplatný certifikát a nasazení Cyklo & Ski mapy by u něj skončilo chybou – proto se nenasazuje vůbec.
kontrola_cloudflare() {
  [ -s "$ORIGIN/tls.caddy" ] || return 0
  if miri_na_server "$DOMENA"; then
    chyba "$DOMENA vede v DNS přímo na tento server (DNS only), ale Caddy tu používá Cloudflare Origin certifikát. V Cloudflare u záznamu zapněte proxy (oranžový mrak), počkejte ~5 minut a nasazení zopakujte. Nic se nezměnilo."
  fi
}

zdravi() { # $1 = kontejner; vrátí 0, když /api/health odpoví
  docker exec "$1" wget -qO- "http://127.0.0.1:$PORT/api/health" 2>/dev/null
}

cekej_na() { # $1 = kontejner, $2 = sekund
  local i
  for i in $(seq 1 "$2"); do
    if zdravi "$1" >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

# Uživatelé: z GitHubu (MP_USERS_B64), jinak stejné jako Cyklo & Ski mapa (CSM_USERS / CSM_PASSWORD).
pripravit_env() {
  mkdir -p "$KOREN"
  local users=""
  if [ -n "${MP_USERS_B64:-}" ]; then users="$(printf %s "$MP_USERS_B64" | base64 -d)"; fi
  if [ -z "$users" ] && [ -f "$ENV_FILE" ]; then users="$(sed -n 's/^MP_USERS=//p' "$ENV_FILE" | head -1)"; fi
  if [ -z "$users" ] && [ -f "$MAPA_ENV" ]; then
    users="$(sed -n 's/^CSM_USERS=//p' "$MAPA_ENV" | head -1)"
    if [ -z "$users" ]; then
      local heslo
      heslo="$(sed -n 's/^CSM_PASSWORD=//p' "$MAPA_ENV" | head -1)"
      [ -n "$heslo" ] && users="tým:$heslo"
    fi
    [ -n "$users" ] && krok "Uživatelé převzati z Cyklo & Ski mapy ($MAPA_ENV)."
  fi
  [ -n "$users" ] || chyba "nejsou uživatelé – nastavte v GitHubu secret MP_USERS (nebo HETZNER_USERS), formát jmeno:heslo;jmeno2:heslo2."
  # Asistent mapy (Claude API): klíč jen z GitHubu (secret ANTHROPIC_API_KEY) – bez něj je asistent vypnutý.
  local aiklic="" aimodel="${MP_AI_MODEL:-}" aieffort="${MP_AI_EFFORT:-}"
  if [ -n "${MP_AI_KEY_B64:-}" ]; then aiklic="$(printf %s "$MP_AI_KEY_B64" | base64 -d | tr -d ' \r\n')"; fi
  if [ -n "$aiklic" ] && ! [[ "$aiklic" =~ ^[A-Za-z0-9_-]{20,300}$ ]]; then
    echo "VAROVÁNÍ: ANTHROPIC_API_KEY nemá tvar klíče Claude API – asistent zůstane vypnutý." >&2
    aiklic=""
  fi
  [[ "$aimodel" =~ ^[a-z0-9.-]{3,60}$ ]] || aimodel=""
  [[ "$aieffort" =~ ^(low|medium|high|xhigh|max)$ ]] || aieffort=""
  local secret=""
  [ -f "$ENV_FILE" ] && secret="$(sed -n 's/^MP_SECRET=//p' "$ENV_FILE" | head -1)"
  [ -n "$secret" ] || secret="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  umask 077
  {
    echo "# Mapa prodejen – konfigurace kontejneru (zapisuje deploy/server.sh $(date +%F)). Mimo git."
    echo "MP_USERS=$users"
    echo "MP_SECRET=$secret"
    echo "MP_SESSION_DAYS=30"
    echo "MP_TRUST_PROXY=1"
    [ -n "$aiklic" ] && echo "ANTHROPIC_API_KEY=$aiklic"
    [ -n "$aimodel" ] && echo "MP_AI_MODEL=$aimodel"
    [ -n "$aieffort" ] && echo "MP_AI_EFFORT=$aieffort"
    true
  } > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  umask 022
  if [ -n "$aiklic" ]; then krok "Asistent mapy zapnutý (Claude API, model ${aimodel:-claude-opus-5-5})."; else krok "Asistent mapy vypnutý (v GitHubu není secret ANTHROPIC_API_KEY)."; fi
}

# Archiv vydání → /opt/mapa-prodejen/vydani/<commit>/ a odkaz /opt/mapa-prodejen/app na něj.
rozbalit_vydani() {
  local v="${MP_VYDANI:-}"
  [ -n "$v" ] || chyba "chybí MP_VYDANI (commit) – nasazuje se z GitHub Actions, viz NASAZENI.md."
  [[ "$v" =~ ^[0-9a-f]{7,40}$ ]] || chyba "MP_VYDANI musí být hash commitu."
  local archiv="$VYDANI_DIR/$v.tar.gz" cil="$VYDANI_DIR/$v"
  [ -f "$archiv" ] || chyba "archiv $archiv chybí (posílá ho workflow před spuštěním skriptu)."
  rm -rf "$cil.tmp" && mkdir -p "$cil.tmp"
  tar -xzf "$archiv" -C "$cil.tmp"
  # archiv má kořen „mapa-prodejen/“
  if [ -d "$cil.tmp/mapa-prodejen" ]; then rm -rf "$cil" && mv "$cil.tmp/mapa-prodejen" "$cil" && rm -rf "$cil.tmp"; else rm -rf "$cil" && mv "$cil.tmp" "$cil"; fi
  [ -f "$cil/server.js" ] && [ -f "$cil/Dockerfile" ] || chyba "v archivu není aplikace (server.js, Dockerfile)."
  VYDANI_CESTA="$cil"
}

# Necháme posledních 5 vydání (rozbalených i archivů).
uklid_vydani() {
  local d
  ls -1dt "$VYDANI_DIR"/*/ 2>/dev/null | tail -n +6 | while read -r d; do [ "$(readlink -f "$KOREN/app")/" = "$d" ] || rm -rf "$d"; done
  ls -1t "$VYDANI_DIR"/*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f
}

spust() { # $1 = image, $2 = jméno kontejneru
  docker rm -f "$2" >/dev/null 2>&1 || true
  docker run -d \
    --name "$2" \
    --restart unless-stopped \
    --network "$SIT" \
    --env-file "$ENV_FILE" \
    -e MP_DATA=/data \
    -e PORT="$PORT" \
    -v "$SVAZEK":/data \
    --read-only --tmpfs /tmp \
    --security-opt no-new-privileges:true \
    --log-opt max-size=20m --log-opt max-file=5 \
    "$1" >/dev/null
}

# Blok pro Caddy mapy: zapsat, ověřit celou konfiguraci v běžící Caddy, načíst. Při chybě vrátit původní blok.
caddy_blok() {
  local id puvodni=""
  id="$(caddy_id)"
  [ -n "$id" ] || chyba "neběží Caddy Cyklo & Ski mapy (kontejner projektu „deploy“) – web by nebyl vidět."
  docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' "$id" | grep -q '/etc/caddy/extra' \
    || chyba "Caddy mapy nemá připojený adresář $EXTRA (/etc/caddy/extra) – aktualizujte nasazení Cyklo & Ski mapy."
  docker exec "$id" grep -q 'import /etc/caddy/extra' /etc/caddy/Caddyfile || chyba "Caddyfile mapy neimportuje /etc/caddy/extra/*.caddy."
  mkdir -p "$EXTRA" && chmod 755 "$EXTRA"
  [ -f "$BLOK" ] && puvodni="$(cat "$BLOK")"
  sed "s/^DOMENA {/$DOMENA {/" "$VYDANI_CESTA/deploy/Caddyfile.blok" > "$BLOK.tmp"
  if [ -n "$puvodni" ] && cmp -s "$BLOK.tmp" "$BLOK"; then
    rm -f "$BLOK.tmp"
    krok "Blok Caddy pro $DOMENA beze změny."
    return 0
  fi
  mv "$BLOK.tmp" "$BLOK" && chmod 644 "$BLOK"
  if ! docker exec "$id" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/mapa-prodejen-caddy.log 2>&1; then
    grep -v '"level":"info"' /tmp/mapa-prodejen-caddy.log | tail -8 >&2 || true
    if [ -n "$puvodni" ]; then printf '%s\n' "$puvodni" > "$BLOK"; else rm -f "$BLOK"; fi
    chyba "konfigurace Caddy s blokem mapy prodejen neprošla kontrolou – vrácen původní stav, ostatní weby běží beze změny."
  fi
  docker exec "$id" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
    || chyba "reload Caddy selhal (blok je v $BLOK; ověřte: docker logs $(docker inspect -f '{{.Name}}' "$id" | tr -d /))."
  krok "Caddy: blok pro $DOMENA zapsán ($BLOK) a načten."
}

# Denní záloha dat (stav spolupráce, objednávky, místa, obraty) ve 2:40 – cron.
zajisti_cron() {
  [ -d /etc/cron.d ] || return 0
  local soubor=/etc/cron.d/mapa-prodejen-zaloha
  local obsah="# Denní záloha dat Mapy prodejen (deploy/server.sh zaloha)
40 2 * * * root bash $KOREN/app/deploy/server.sh zaloha >> /var/log/mapa-prodejen-zaloha.log 2>&1"
  if [ ! -f "$soubor" ] || [ "$(cat "$soubor")" != "$obsah" ]; then
    printf '%s\n' "$obsah" > "$soubor"
    chmod 644 "$soubor"
    krok "Denní záloha ve 2:40 nastavena ($soubor → $ZALOHY)."
  fi
}

cekej_na_web() {
  local i
  for i in $(seq 1 30); do
    if curl -fsS -m 5 "https://$DOMENA/api/health" >/dev/null 2>&1; then
      echo "Web běží: https://$DOMENA  –  $(curl -fsS -m 5 "https://$DOMENA/api/health")"
      return 0
    fi
    sleep 2
  done
  echo "VAROVÁNÍ: https://$DOMENA zatím neodpovídá. Zkontrolujte DNS v Cloudflare (záznam $DOMENA → server, proxy zapnutá)" >&2
  echo "          a log Caddy: docker logs --tail 30 $(docker inspect -f '{{.Name}}' "$(caddy_id)" 2>/dev/null | tr -d /)" >&2
  return 1
}

nasadit() {
  docker network inspect "$SIT" >/dev/null 2>&1 || chyba "Docker síť $SIT neexistuje – běží Cyklo & Ski mapa (její Caddy)?"
  kontrola_cloudflare
  rozbalit_vydani
  pripravit_env
  local verze="${MP_VERZE:-v$(date +%F)-${MP_VYDANI:0:7}}"
  krok "Stavím image $IMAGE:${MP_VYDANI:0:12} (verze $verze)…"
  docker build -q --build-arg APP_VERSION="$verze" -t "$IMAGE:${MP_VYDANI:0:12}" "$VYDANI_CESTA" >/dev/null
  # napřed zkouška ve vedlejším kontejneru (bez dat týmu), ostrá verze zatím běží
  krok "Zkouším novou verzi ve vedlejším kontejneru…"
  docker rm -f "$APP-zkouska" >/dev/null 2>&1 || true
  docker run -d --name "$APP-zkouska" --network "$SIT" --env-file "$ENV_FILE" -e MP_DATA=/tmp/data -e PORT="$PORT" "$IMAGE:${MP_VYDANI:0:12}" >/dev/null
  if ! cekej_na "$APP-zkouska" 40; then
    docker logs --tail 30 "$APP-zkouska" >&2 || true
    docker rm -f "$APP-zkouska" >/dev/null 2>&1 || true
    chyba "nová verze neodpovídá – ostrá verze běží beze změny."
  fi
  docker rm -f "$APP-zkouska" >/dev/null 2>&1 || true
  # výměna: předchozí image si pamatujeme pro cestu zpět
  local stary
  stary="$(docker inspect -f '{{.Config.Image}}' "$APP" 2>/dev/null || true)"
  if [ -n "$stary" ] && [ "$stary" != "$IMAGE:${MP_VYDANI:0:12}" ]; then docker tag "$stary" "$IMAGE:predchozi"; fi
  docker volume create "$SVAZEK" >/dev/null
  krok "Spouštím ostrou verzi…"
  spust "$IMAGE:${MP_VYDANI:0:12}" "$APP"
  if ! cekej_na "$APP" 60; then
    docker logs --tail 40 "$APP" >&2 || true
    if docker image inspect "$IMAGE:predchozi" >/dev/null 2>&1; then
      echo "CHYBA: nová verze po výměně neodpovídá – vracím předchozí." >&2
      spust "$IMAGE:predchozi" "$APP"
      cekej_na "$APP" 60 || true
    fi
    exit 1
  fi
  docker tag "$IMAGE:${MP_VYDANI:0:12}" "$IMAGE:latest"
  ln -sfn "$VYDANI_CESTA" "$KOREN/app"
  krok "Aplikace běží: $(zdravi "$APP")"
  caddy_blok
  zajisti_cron
  uklid_vydani
  docker image prune -f >/dev/null 2>&1 || true
  cekej_na_web || true
}

zpet() {
  docker image inspect "$IMAGE:predchozi" >/dev/null 2>&1 || chyba "žádná předchozí verze ($IMAGE:predchozi) není uložená."
  [ -f "$ENV_FILE" ] || chyba "chybí $ENV_FILE."
  krok "Vracím předchozí verzi…"
  spust "$IMAGE:predchozi" "$APP"
  cekej_na "$APP" 60 && echo "Běží předchozí verze: $(zdravi "$APP")"
}

zaloha() {
  mkdir -p "$ZALOHY"
  local cil
  cil="$ZALOHY/$(date +%F-%H%M)"
  mkdir -p "$cil"
  local f n=0
  for f in stav.json objednavky.json mista.json obraty.json nastaveni.json firmy.json; do
    if docker cp "$APP:/data/$f" "$cil/$f" >/dev/null 2>&1; then n=$((n + 1)); fi
  done
  if [ "$n" = 0 ]; then
    rmdir "$cil" 2>/dev/null || true
    krok "Zatím žádná data k záloze."
  else
    chmod -R go-rwx "$cil"
    krok "Záloha: $cil ($n souborů)"
  fi
  ls -1dt "$ZALOHY"/*/ 2>/dev/null | tail -n +61 | xargs -r rm -rf # nechat 60 nejnovějších
}

stav() {
  docker ps -a --filter "name=^$APP\$" --format 'kontejner: {{.Names}}  {{.Image}}  {{.Status}}'
  echo "--- health ---"
  zdravi "$APP" || echo "aplikace neodpovídá"
  echo
  curl -fsS -m 5 "https://$DOMENA/api/health" || echo "web https://$DOMENA neodpovídá"
  echo
  echo "--- Caddy ---"
  if [ -f "$BLOK" ]; then echo "blok: $BLOK – $(grep -m1 '{$' "$BLOK" | tr -d '{')"; else echo "blok $BLOK chybí"; fi
  echo "--- vydání ---"
  readlink -f "$KOREN/app" 2>/dev/null || echo "(žádné)"
  echo "--- zálohy ---"
  ls -1dt "$ZALOHY"/*/ 2>/dev/null | head -3 || true
}

case "${1:-}" in
  nasadit) nasadit ;;
  zpet) zpet ;;
  zaloha) zaloha ;;
  stav) stav ;;
  log) docker logs --tail 100 -f "$APP" ;;
  *)
    echo "Použití: server.sh nasadit | zpet | zaloha | stav | log" >&2
    exit 1
    ;;
esac
