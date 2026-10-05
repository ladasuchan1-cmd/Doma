#!/usr/bin/env bash
# Nasazení Kolomapy na server s Dockerem a Caddy (Hetzner, ksprehledy.cz) – stejný vzor jako ostatní aplikace
# (r01sales, projekty, import-web): kontejner na Docker síti „web“, ven ho pouští Caddy v kontejneru „caddy“
# s konfigurací /root/Caddyfile. Postup a instalace runneru: deploy/docker/HETZNER.md.
#
# Skript běží NA SERVERU – pouští ho GitHub Actions přes self-hosted runner (štítek „kolomapa“), nebo ho spustíte
# ručně v konzoli Hetzneru:   bash /root/Doma/kolomapa/deploy/docker/nasadit.sh
# Je schválně jeden pro obě cesty, aby se ruční zásah a automat nerozešly. Lze spouštět opakovaně.
#
# Co se kde drží:
#   kód        /root/Doma (klon repozitáře, aplikace ve složce kolomapa) – ruční spuštění si stáhne novou verzi
#   nastavení  /root/kolomapa.env (mimo git; při prvním nasazení vznikne s náhodným heslem a vypíše ho)
#   data       /root/kolomapa-data → /app/data (databáze; přežije přestavbu obrazu), zálohy v podsložce zalohy/
#   kontejner  „kolomapa“ z obrazu „kolomapa“, síť web, port 8050 jen uvnitř sítě (bez -p)
#   vrátnice   Caddy → https://<KOLOMAPA_DOMENA> (výchozí kolomapa.ksprehledy.cz); blok do Caddyfile přidá skript
#   stahování  plánovač uvnitř kontejneru (05:30 pražského času) – žádný cron není potřeba
#   záloha     /etc/cron.daily/kolomapa-zaloha → /root/kolomapa-data/zalohy/kolomapa-<den>.db (7 dní dozadu)
#
# Když cokoli selže (stavba, testy v obrazu, Caddy), starý kontejner běží dál.
set -euo pipefail

APP=kolomapa                                   # jméno kontejneru (odkazuje se na něj Caddyfile a cron zálohy)
IMAGE=kolomapa
KOD="${KOLOMAPA_KOD:-/root/Doma}"
ENV_SOUBOR="${KOLOMAPA_ENV:-/root/kolomapa.env}"
DATA="${KOLOMAPA_DATA:-/root/kolomapa-data}"
SIT="${KOLOMAPA_SIT:-web}"
PORT=8050
CADDYFILE="${CADDYFILE:-/root/Caddyfile}"      # na hostiteli (bind mount do kontejneru caddy)
CADDY="${CADDY_KONTEJNER:-caddy}"
CADDY_CONFIG="${CADDY_CONFIG:-/etc/caddy/Caddyfile}"   # tatáž cesta uvnitř kontejneru caddy
ZALOHA_CRON="${KOLOMAPA_ZALOHA_CRON:-/etc/cron.daily/kolomapa-zaloha}"

say() { printf '\n\033[1m→ %s\033[0m\n' "$*"; }
die() { printf '\nCHYBA: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker není nainstalovaný (na Hetzneru je – spouštíte to na správném serveru?)"
docker info >/dev/null 2>&1 || die "uživatel $(whoami) nedosáhne na docker (chybí práva, nebo docker neběží)"

# --- Odkud se staví --------------------------------------------------------------------------------------------
# Z runneru je to jeho workspace s už vytaženým commitem (git na serveru netřeba). Ruční spuštění z /root/Doma si
# napřed stáhne nejnovější verzi větve, kterou má klon vybranou.
ZDROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ -f "$ZDROJ/Dockerfile" && -f "$ZDROJ/server.js" ]] || die "skript musí ležet v kolomapa/deploy/docker (nenašel jsem $ZDROJ/Dockerfile)"
if [[ "$ZDROJ" == "$KOD/kolomapa" ]] && git -C "$KOD" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  say "Ruční spuštění v $KOD – stahuji nejnovější verzi ($(git -C "$KOD" rev-parse --abbrev-ref HEAD))"
  if git -C "$KOD" pull --ff-only; then :; else
    echo "VAROVÁNÍ: klon se nedostal na GitHub (soukromý repozitář bez klíče? bez sítě?) – stavím to, co na serveru je."
  fi
else
  say "Stavím z $ZDROJ (kód dodal runner / aktuální složka)"
fi
echo "   verze: $(git -C "$ZDROJ" rev-parse --short HEAD 2>/dev/null || echo '?')"

# --- Nastavení (/root/kolomapa.env) -----------------------------------------------------------------------------
NOVE_HESLO=""
if [[ ! -f "$ENV_SOUBOR" ]]; then
  say "Zakládám $ENV_SOUBOR s náhodným heslem"
  NOVE_HESLO="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-20)"
  cat >"$ENV_SOUBOR" <<EOF
# Nastavení Kolomapy na serveru (vytvořil kolomapa/deploy/docker/nasadit.sh). Formát docker --env-file:
# KLÍČ=hodnota bez uvozovek. Po změně znovu spusťte nasadit.sh (nebo: docker restart nic nepomůže – kontejner
# se musí založit znovu, to dělá nasadit.sh). Všechny volby: kolomapa/README.md a src/config.js.

# Doména, na které Caddy mapu pouští (blok do Caddyfile přidá nasadit.sh):
KOLOMAPA_DOMENA=kolomapa.ksprehledy.cz

# Heslo do mapy (jméno při přihlášení libovolné):
KOLOMAPA_PASSWORD=$NOVE_HESLO

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
DOMENA="${KOLOMAPA_DOMENA:-$(hodnota KOLOMAPA_DOMENA)}"
DOMENA="${DOMENA:-kolomapa.ksprehledy.cz}"
PROHLIZEC="${KOLOMAPA_PROHLIZEC:-$(hodnota KOLOMAPA_PROHLIZEC)}"
[[ "$DOMENA" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || die "KOLOMAPA_DOMENA=„$DOMENA“ nevypadá jako doména"
grep -q '^KOLOMAPA_PASSWORD=.\+' "$ENV_SOUBOR" || die "v $ENV_SOUBOR chybí KOLOMAPA_PASSWORD – mapa na internetu musí mít heslo"

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
mkdir -p "$DATA/zalohy"
chown -R 1000:1000 "$DATA"   # kontejner běží jako uživatel node (UID 1000)

# --- Výměna kontejneru -----------------------------------------------------------------------------------------
say "Spouštím kontejner $APP"
docker rm -f "$APP" >/dev/null 2>&1 || true
docker run -d \
  --name "$APP" \
  --restart unless-stopped \
  --network "$SIT" \
  --env-file "$ENV_SOUBOR" \
  -v "$DATA":/app/data \
  "$IMAGE" >/dev/null

# --- Caddy -------------------------------------------------------------------------------------------------------
BLOK="# Kolomapa – mapa inzerátů kol (blok přidal kolomapa/deploy/docker/nasadit.sh)
$DOMENA {
    reverse_proxy $APP:$PORT
    header X-Robots-Tag \"noindex, nofollow\"
}"
if [[ ! -f "$CADDYFILE" ]]; then
  echo "VAROVÁNÍ: $CADDYFILE neexistuje – do své konfigurace Caddy přidejte ručně:"
  printf '%s\n' "$BLOK"
elif grep -qE "^[[:space:]]*$DOMENA([[:space:],{]|$)" "$CADDYFILE"; then
  say "Caddy: blok pro $DOMENA už v $CADDYFILE je"
else
  say "Caddy: přidávám blok pro $DOMENA do $CADDYFILE"
  # bezpečnostní hlavičky sdílené s ostatními aplikacemi (snippet header_sec), když v Caddyfile jsou
  if grep -q '^(header_sec)' "$CADDYFILE"; then BLOK="${BLOK/reverse_proxy/import header_sec
    reverse_proxy}"; fi
  cp "$CADDYFILE" "$CADDYFILE.zaloha"
  # >> drží stejný soubor (inode) – kontejner caddy ho má připojený, nový soubor by neviděl
  printf '\n%s\n' "$BLOK" >>"$CADDYFILE"
  if docker ps --format '{{.Names}}' | grep -qx "$CADDY"; then
    if docker exec "$CADDY" caddy validate --config "$CADDY_CONFIG" >/dev/null 2>&1; then
      docker exec "$CADDY" caddy reload --config "$CADDY_CONFIG" 2>&1 | grep -v -i 'formatt' || true
      echo "   Caddy načetla novou konfiguraci (záloha předchozí: $CADDYFILE.zaloha)"
    else
      cp "$CADDYFILE.zaloha" "$CADDYFILE"
      docker exec "$CADDY" caddy validate --config "$CADDY_CONFIG" 2>&1 | tail -5 || true
      die "nová konfigurace Caddy neprošla kontrolou – vrácena původní; blok přidejte ručně (viz výše ve skriptu)"
    fi
  else
    echo "VAROVÁNÍ: kontejner $CADDY neběží – blok je v $CADDYFILE, Caddy ho načte při příštím startu/reloadu."
  fi
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
    if ! getent ahosts "$DOMENA" >/dev/null 2>&1; then
      echo
      echo "POZOR: doména $DOMENA se zatím nepřekládá – u správce domény přidejte záznam A na IP tohoto serveru."
      echo "       Certifikát HTTPS si Caddy vyřídí sama, jakmile se DNS projeví."
    fi
    echo
    echo "Mapa:       https://$DOMENA   (jméno libovolné; heslo: KOLOMAPA_PASSWORD v $ENV_SOUBOR)"
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
