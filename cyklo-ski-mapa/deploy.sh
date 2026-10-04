#!/usr/bin/env bash
# Nasazení Cyklo & Ski mapy na server (Docker + Caddy). Skript běží NA CÍLOVÉM SERVERU –
# pouští ho GitHub Actions (self-hosted runner) nebo ho spustíš ručně: `bash deploy.sh`.
# Je schválně jeden pro obě cesty, ať se ruční zásah nedělá zpaměti a pokaždé jinak.
#
# Co dělá: postaví image (--no-cache, s verzí z gitu), uchová image běžícího kontejneru jako
# cyklo-ski-mapa:predchozi, NOVOU VERZI NAPŘED VYZKOUŠÍ ve vedlejším kontejneru (musí odpovědět
# na /api/health), teprve pak vymění ostrý kontejner a znovu počká na odpověď. Když nová verze
# neodpoví, běžící kontejner zůstane beze změny; když neodpoví ani po výměně, vrátí se předchozí.
# Ručně kdykoli: `bash deploy.sh --zpet`.
#
# Prostředí (přebít proměnnými):
#   CSM_KOD    složka aplikace v repu       (výchozí /home/suchan/apps/Doma/cyklo-ski-mapa)
#   CSM_DATA   data mimo repo: stav.json, .secret, .env   (výchozí /home/suchan/cyklo-ski-mapa-data)
#   CSM_PORT   publikovaný port pro Caddy   (výchozí 127.0.0.1:8091:8090)
#   CSM_ENV    soubor .env                  (výchozí $CSM_DATA/.env, jinak $CSM_KOD/.env)
set -euo pipefail

APP=cyklo-ski-mapa
KOD="${CSM_KOD:-/home/suchan/apps/Doma/cyklo-ski-mapa}"
DATA="${CSM_DATA:-/home/suchan/cyklo-ski-mapa-data}"
PORT="${CSM_PORT:-127.0.0.1:8091:8090}"
HOST_PORT="${PORT%:*}"          # 127.0.0.1:8091
ENV_FILE="${CSM_ENV:-}"

# Když skript pouští runner, staví se z JEHO workspace (commit už je vytažený, server nepotřebuje git).
# Při ručním spuštění v $KOD se adresář nejdřív aktualizuje z origin/main.
ZDROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if sudo -n docker info >/dev/null 2>&1; then
    DOCKER="sudo docker"
  else
    echo "CHYBA: uživatel $(whoami) nedosáhne na docker. Náprava: sudo usermod -aG docker $(whoami) a znovu se přihlas (runner: restart služby)."
    exit 1
  fi
fi

if [ -z "$ENV_FILE" ]; then
  if [ -f "$DATA/.env" ]; then ENV_FILE="$DATA/.env"; elif [ -f "$KOD/.env" ]; then ENV_FILE="$KOD/.env"; fi
fi
if [ -z "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then
  echo "CHYBA: chybí .env (hledal jsem $DATA/.env a $KOD/.env). Vzor: $ZDROJ/.env.example – nastav aspoň CSM_USERS nebo CSM_PASSWORD."
  exit 1
fi
if ! grep -qE '^(CSM_USERS|CSM_PASSWORD)=.+' "$ENV_FILE" && ! grep -qE '^CSM_AUTH=0' "$ENV_FILE"; then
  echo "CHYBA: v $ENV_FILE není CSM_USERS ani CSM_PASSWORD – web by měl náhodné heslo, které po restartu nikdo nezná."
  exit 1
fi
mkdir -p "$DATA"

spust_kontejner() {   # $1 = image; nahradí ostrý kontejner
  $DOCKER rm -f "$APP" >/dev/null 2>&1 || true
  # --user: kontejner běží pod účtem, který nasazuje a vlastní $DATA – jinak by uživatel „node“ (uid 1000)
  # do připojené složky nemohl zapsat stav.json a stav oslovení by se po restartu ztrácel.
  $DOCKER run -d \
    --name "$APP" \
    --restart unless-stopped \
    --user "$(id -u):$(id -g)" \
    -p "$PORT" \
    --env-file "$ENV_FILE" \
    -e CSM_STAV=/data/stav.json \
    -e CSM_TRUST_PROXY=1 \
    -v "$DATA":/data \
    "$1" >/dev/null
}

cekej_na_odpoved() {  # $1 = URL, $2 = sekund
  local i
  for i in $(seq 1 "$2"); do
    if curl -fsS -m 3 "$1" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

if [ "${1:-}" = "--zpet" ]; then
  if ! $DOCKER image inspect "$APP:predchozi" >/dev/null 2>&1; then
    echo "CHYBA: žádná předchozí verze ($APP:predchozi) není uložená."
    exit 1
  fi
  echo "→ Vracím předchozí verzi…"
  spust_kontejner "$APP:predchozi"
  cekej_na_odpoved "http://$HOST_PORT/api/health" 60 && echo "Hotovo – běží předchozí verze." || { echo "CHYBA: ani předchozí verze neodpovídá."; $DOCKER logs "$APP" --tail 40; exit 1; }
  exit 0
fi

# Aktualizace klonu na serveru: jen RYCHLOPOSUN (ff-only) hlavní větve a jen když v klonu nejsou vlastní
# úpravy – nikdy reset --hard, který by je zahodil. Přeskočit: CSM_BEZ_AKTUALIZACE=1.
if [ "$ZDROJ" = "$KOD" ] && [ -d "$KOD/../.git" ] && [ "${CSM_BEZ_AKTUALIZACE:-0}" != "1" ]; then
  REPO="$KOD/.."
  if [ -n "$(git -C "$REPO" status --porcelain 2>/dev/null)" ]; then
    echo "VAROVÁNÍ: v klonu jsou necommitnuté změny – neaktualizuji, stavím to, co je na disku."
  else
    VETEV="$(git -C "$REPO" ls-remote --symref origin HEAD 2>/dev/null | sed -n 's|^ref: refs/heads/\([^[:space:]]*\).*|\1|p')"
    AKTUALNI="$(git -C "$REPO" branch --show-current 2>/dev/null)"
    if [ -z "$VETEV" ]; then
      echo "VAROVÁNÍ: nepodařilo se zjistit hlavní větev originu – stavím aktuálně vytažený stav."
    elif [ "$AKTUALNI" != "$VETEV" ]; then
      echo "VAROVÁNÍ: klon je na větvi '$AKTUALNI', hlavní je '$VETEV' – neaktualizuji, stavím to, co je na disku."
    elif git -C "$REPO" fetch -q origin "$VETEV" && git -C "$REPO" merge -q --ff-only "origin/$VETEV"; then
      echo "→ $KOD aktualizován z origin/$VETEV ($(git -C "$REPO" log -1 --format='%h %s'))"
    else
      echo "VAROVÁNÍ: aktualizace z origin/$VETEV nešla rychloposunem – stavím aktuálně vytažený stav."
    fi
  fi
fi

# Uchovat image běžícího kontejneru pro cestu zpět – JEŠTĚ PŘED buildem: jakmile build přepíše tag
# latest, zůstal by starý image bez tagu a úložiště ho může uklidit, i když z něj kontejner běží.
BEZICI="$($DOCKER inspect -f '{{.Image}}' "$APP" 2>/dev/null || true)"
if [ -n "$BEZICI" ] && $DOCKER image inspect "$BEZICI" >/dev/null 2>&1; then
  $DOCKER tag "$BEZICI" "$APP:predchozi"
  echo "→ Předchozí verze uložena jako $APP:predchozi ($($DOCKER inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$BEZICI" | sed -n 's/^APP_VERSION=//p'))"
fi

VERZE="$(git -C "$ZDROJ" log -1 --format='v%cd-%h' --date=format:%Y-%m-%d 2>/dev/null || date +'v%Y-%m-%d-%H%M')"
echo "→ Stavím $APP ($VERZE) z $ZDROJ…"
$DOCKER build --no-cache --build-arg APP_VERSION="$VERZE" -t "$APP:latest" -t "$APP:$VERZE" "$ZDROJ"

echo "→ Zkouším novou verzi ve vedlejším kontejneru…"
$DOCKER rm -f "$APP-zkouska" >/dev/null 2>&1 || true
$DOCKER run -d --name "$APP-zkouska" --user "$(id -u):$(id -g)" --env-file "$ENV_FILE" -e CSM_STAV=/tmp/zkouska/stav.json -e CSM_SECRET=zkouska-zkouska-zkouska-zkouska-zkouska "$APP:latest" >/dev/null
OK=0
for i in $(seq 1 60); do
  if $DOCKER exec "$APP-zkouska" wget -qO- http://127.0.0.1:8090/api/health >/dev/null 2>&1; then OK=1; break; fi
  sleep 1
done
if [ "$OK" != 1 ]; then
  echo "CHYBA: nová verze neodpovídá – běžící kontejner zůstává beze změny. Log zkoušky:"
  $DOCKER logs "$APP-zkouska" --tail 40 || true
  $DOCKER rm -f "$APP-zkouska" >/dev/null 2>&1 || true
  exit 1
fi
$DOCKER rm -f "$APP-zkouska" >/dev/null 2>&1 || true

echo "→ Vyměňuji ostrý kontejner…"
spust_kontejner "$APP:latest"
if cekej_na_odpoved "http://$HOST_PORT/api/health" 60; then
  echo "Hotovo: $APP $VERZE běží na http://$HOST_PORT (za Caddy) – $(curl -fsS -m 3 "http://$HOST_PORT/api/health")"
  $DOCKER image prune -f >/dev/null 2>&1 || true
  exit 0
fi

echo "CHYBA: nová verze po výměně neodpovídá. Log:"
$DOCKER logs "$APP" --tail 40 || true
if $DOCKER image inspect "$APP:predchozi" >/dev/null 2>&1; then
  echo "→ Vracím předchozí verzi…"
  spust_kontejner "$APP:predchozi"
  cekej_na_odpoved "http://$HOST_PORT/api/health" 60 && echo "Běží předchozí verze." || echo "CHYBA: ani předchozí verze neodpovídá."
fi
exit 1
