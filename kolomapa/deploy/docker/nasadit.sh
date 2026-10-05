#!/usr/bin/env bash
# Nasazení Kolomapy na server s Dockerem a Caddy (Hetzner) – stejný vzor jako ostatní aplikace (r01sales, projekty,
# import-web, Cyklostezky a sjezdovky): kontejner, ven ho pouští Caddy. Postup a instalace runneru: HETZNER.md.
#
# Skript běží NA SERVERU – pouští ho GitHub Actions přes self-hosted runner (štítek „kolomapa“), nebo ručně
# v konzoli Hetzneru:   bash /root/Doma/kolomapa/deploy/docker/nasadit.sh
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
vychozi_domena() {
  local ip
  ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -vE '^(10\.|127\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)' | head -1 || true)"
  if [[ -n "$ip" ]]; then echo "kolomapa.${ip//./-}.sslip.io"; else echo "kolomapa.ksprehledy.cz"; fi
}
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
DOMENA="${DOMENA:-$(vychozi_domena)}"
PROHLIZEC="${KOLOMAPA_PROHLIZEC:-$(hodnota KOLOMAPA_PROHLIZEC)}"
[[ "$DOMENA" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || die "KOLOMAPA_DOMENA=„$DOMENA“ nevypadá jako doména"
if grep -qE '^KOLOMAPA_USERS(_FILE)?=.' "$ENV_SOUBOR"; then UZIVATELE=vlastni; fi
[[ -n "$UZIVATELE" ]] || grep -q '^KOLOMAPA_PASSWORD=.\+' "$ENV_SOUBOR" || die "v $ENV_SOUBOR chybí KOLOMAPA_PASSWORD (a na serveru není Cyklo & Ski mapa s uživateli) – mapa na internetu musí mít heslo"
HESLO_TAKE="$(hodnota KOLOMAPA_PASSWORD)"

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

# --- Caddy -------------------------------------------------------------------------------------------------------
BLOK="# Kolomapa – mapa inzerátů kol (blok přidal kolomapa/deploy/docker/nasadit.sh)
$DOMENA {
    reverse_proxy $CIL
    header X-Robots-Tag \"noindex, nofollow\"
}"
# bezpečnostní hlavičky sdílené s ostatními aplikacemi (snippet header_sec), když v Caddyfile jsou
if [[ -f "$CADDYFILE" ]] && grep -q '^(header_sec)' "$CADDYFILE"; then BLOK="${BLOK/reverse_proxy/import header_sec
    reverse_proxy}"; fi

caddy_docker_nacti() {   # ověřit a načíst konfiguraci běžícího kontejneru Caddy; 1 = kontrola neprošla
  docker exec "$CADDY" caddy validate --config "$CADDY_CONFIG" >/dev/null 2>&1 || return 1
  docker exec "$CADDY" caddy reload --config "$CADDY_CONFIG" >/dev/null 2>&1 || true
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

if [[ ! -f "$CADDYFILE" ]]; then
  echo "VAROVÁNÍ: $CADDYFILE neexistuje – do své konfigurace Caddy přidejte ručně:"
  printf '%s\n' "$BLOK"
elif grep -qE "^[[:space:]]*$DOMENA([[:space:],{]|$)" "$CADDYFILE"; then
  say "Caddy: blok pro $DOMENA už v $CADDYFILE je"
elif [[ "$ZPUSOB" == sites ]]; then
  # Caddyfile je v git klonu (Cyklo & Ski mapa) – blok nejde dovnitř, ale do svazku caddy_config: /config/sites/kolomapa.caddy.
  # V Caddyfile musí být řádek „import /config/sites/*.caddy“ (v repozitáři je; starší klon ho dostane tady).
  SOUBOR="$CADDY_SITES/$APP.caddy"
  say "Caddy: zapisuji blok pro $DOMENA do $SOUBOR v kontejneru $CADDY"
  PUVODNI="$(docker exec "$CADDY" cat "$SOUBOR" 2>/dev/null || true)"
  PUVODNI_CADDYFILE=""   # záloha jen v paměti – soubor .zaloha by v git klonu vadil (hetzner.sh: necommitnuté změny)
  if ! grep -qxF "$IMPORT_RADEK" "$CADDYFILE"; then
    echo "   $CADDYFILE: doplňuji řádek „$IMPORT_RADEK“"
    PUVODNI_CADDYFILE="$(cat "$CADDYFILE")"
    # >> drží stejný soubor (inode) – kontejner caddy ho má připojený, nový soubor by neviděl
    printf '\n%s\n%s\n' "$IMPORT_KOMENTAR" "$IMPORT_RADEK" >>"$CADDYFILE"
  fi
  printf '%s\n' "$BLOK" | docker exec -i "$CADDY" sh -c "mkdir -p '$CADDY_SITES' && cat >'$SOUBOR'"
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
  # >> drží stejný soubor (inode) – kontejner caddy ho má připojený, nový soubor by neviděl
  printf '\n%s\n' "$BLOK" >>"$CADDYFILE"
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
    if ! getent ahosts "$DOMENA" >/dev/null 2>&1; then
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
    echo "Mapa:       https://$DOMENA"
    case "$UZIVATELE" in
      csm)     echo "Přihlášení: jména a hesla z Cyklo & Ski mapy ($CSM_ENV)${HESLO_TAKE:+; navíc KOLOMAPA_PASSWORD z $ENV_SOUBOR s libovolným jménem}" ;;
      vlastni) echo "Přihlášení: podle KOLOMAPA_USERS / KOLOMAPA_USERS_FILE v $ENV_SOUBOR${HESLO_TAKE:+ (+ KOLOMAPA_PASSWORD, jméno libovolné)}" ;;
      *)       echo "Přihlášení: jméno libovolné, heslo KOLOMAPA_PASSWORD v $ENV_SOUBOR" ;;
    esac
    case "$REZIM" in
      docker) if [[ "$ZPUSOB" == sites ]]; then echo "Vrátnice:   Caddy v kontejneru $CADDY → $CIL (blok $CADDY_SITES/$APP.caddy, import v $CADDYFILE)"
              else echo "Vrátnice:   Caddy v kontejneru $CADDY → $CIL (blok v $CADDYFILE)"; fi ;;
      system) echo "Vrátnice:   Caddy jako služba ($CADDYFILE) → $CIL" ;;
      *)      echo "Vrátnice:   ŽÁDNÁ – Caddy nenalezena, https://$DOMENA se neotevře (viz VAROVÁNÍ výše)" ;;
    esac
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
