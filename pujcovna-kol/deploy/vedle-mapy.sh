#!/usr/bin/env bash
# Půjčovna kol VEDLE Cyklo & Ski mapy na jednom serveru (např. 37.27.203.154): mapa už drží porty 80/443 svým
# kontejnerem Caddy, proto se půjčovna spustí jen jako aplikace v téže Docker síti a Caddy mapy dostane blok pro
# doménu půjčovny (import /etc/caddy/extra/*.caddy). Spouští se NA SERVERU jako root.
#
#   bash /opt/Doma/pujcovna-kol/deploy/vedle-mapy.sh instalace ksprehledy.cz   # poprvé (i přepnutí repa na větev s půjčovnou)
#   bash /opt/Doma/pujcovna-kol/deploy/vedle-mapy.sh aktualizace               # nový kód z GitHubu → build → výměna
#   bash /opt/Doma/pujcovna-kol/deploy/vedle-mapy.sh stav | log | zaloha | zpet
#   bash /opt/Doma/pujcovna-kol/deploy/vedle-mapy.sh caddy-sync                # weby klientů → Caddy (cron každou minutu)
#
# Vše ostatní dělá hetzner.sh s PK_COMPOSE=docker-compose.vedle-mapy.yml (zálohy, cron, návrat zpět).
# Proměnné: PK_VETEV (větev repa, ve které je půjčovna – výchozí claude/quirky-ramanujan-cjewtf, po sloučení main),
# PK_CADDY_SIT (Docker síť Caddy mapy, výchozí deploy_default), PK_CADDY_EXTRA (/opt/caddy-extra), PK_REPO_DIR (/opt/Doma).
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "CHYBA: spusťte jako root (sudo bash $0 …)." >&2; exit 1; }

REPO_DIR="${PK_REPO_DIR:-/opt/Doma}"
VETEV="${PK_VETEV:-claude/quirky-ramanujan-cjewtf}"
MAPA_DEPLOY="$REPO_DIR/cyklo-ski-mapa/deploy"
PK_DEPLOY="$REPO_DIR/pujcovna-kol/deploy"
EXTRA="${PK_CADDY_EXTRA:-/opt/caddy-extra}"
SIT="${PK_CADDY_SIT:-deploy_default}"
export PK_COMPOSE=docker-compose.vedle-mapy.yml PK_CADDY_SIT="$SIT" PK_UFW="${PK_UFW:-0}"

chyba() { echo "CHYBA: $*" >&2; exit 1; }
mapa_compose() { (cd "$MAPA_DEPLOY" && docker compose -f docker-compose.yml "$@"); }

# Repo na serveru musí obsahovat složku pujcovna-kol – je-li na jiné větvi, přepne se (jen bez lokálních změn).
zajisti_vetev() {
  [ -d "$REPO_DIR/.git" ] || chyba "repozitář $REPO_DIR neexistuje – nejdřív nainstalujte Cyklo & Ski mapu (cyklo-ski-mapa/NASAZENI.md)."
  [ -z "$(git -C "$REPO_DIR" status --porcelain)" ] || chyba "v $REPO_DIR jsou necommitnuté změny – uklidit (git -C $REPO_DIR status)."
  git -C "$REPO_DIR" fetch -q origin "$VETEV" || chyba "větev $VETEV na GitHubu není."
  if [ "$(git -C "$REPO_DIR" branch --show-current)" != "$VETEV" ]; then
    echo "→ Přepínám $REPO_DIR na větev $VETEV (obsahuje půjčovnu i upravenou Caddy mapy)…"
    git -C "$REPO_DIR" checkout -q "$VETEV"
  fi
  git -C "$REPO_DIR" merge -q --ff-only "origin/$VETEV" || echo "VAROVÁNÍ: větev nešla rychloposunout – stavím stav na disku." >&2
  [ -d "$REPO_DIR/pujcovna-kol" ] || chyba "ve větvi $VETEV není složka pujcovna-kol."
}

# Caddy mapy musí importovat /etc/caddy/extra/*.caddy a mít tento adresář připojený (docker-compose.yml mapy).
zajisti_caddy_mapy() {
  mkdir -p "$EXTRA" && chmod 755 "$EXTRA"
  grep -q 'import /etc/caddy/extra' "$MAPA_DEPLOY/Caddyfile" || chyba "Caddyfile mapy neimportuje /etc/caddy/extra – aktualizujte repo (větev $VETEV)."
  docker network inspect "$SIT" >/dev/null 2>&1 || chyba "Docker síť $SIT neexistuje – běží Caddy mapy? (docker network ls; PK_CADDY_SIT=…)"
  if ! docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' "$(mapa_compose ps -q caddy)" 2>/dev/null | grep -q '/etc/caddy/extra'; then
    echo "→ Caddy mapy znovu vytvářím s připojeným $EXTRA (krátký výpadek mapy, sekundy)…"
    mapa_compose up -d caddy
  fi
}

zapis_blok() { # $1 = doména
  local d="$1" cil="$EXTRA/pujcovna-kol.caddy"
  sed "s/DOMENA/$d/g" "$PK_DEPLOY/Caddyfile.vedle-mapy-blok" > "$cil.tmp" && mv "$cil.tmp" "$cil"
  echo "→ Blok Caddy pro $d zapsán do $cil"
}

reload_caddy() {
  if mapa_compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    echo "→ Caddy mapy znovu načtena."
  else
    echo "VAROVÁNÍ: reload Caddy selhal – zkouším restart kontejneru." >&2
    mapa_compose restart caddy
  fi
}

domena() { sed -n 's/^PK_DOMAIN=//p' "$PK_DEPLOY/.env" 2>/dev/null | head -1; }

# Weby klientů založené průvodcem (/zalozeni): aplikace zapisuje jejich hosty do /data/caddy-hosty.txt; odtud se
# skládá blok $EXTRA/pujcovna-kol-klienti.caddy (stejné nastavení jako hlavní blok), ověří se celá konfigurace Caddy
# mapy a teprve pak se načte – při chybě zůstane předchozí stav. Bez změny se nic nedělá (cron každou minutu).
KLIENTI_BLOK="$EXTRA/pujcovna-kol-klienti.caddy"
caddy_sync() {
  local hosts novy caddy_id
  hosts="$(docker exec pujcovna-kol cat /data/caddy-hosty.txt 2>/dev/null \
    | grep -E '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' | sort -u | paste -sd, - | sed 's/,/, /g')" || true
  novy="$(mktemp)"
  if [ -n "$hosts" ]; then
    { echo "# Weby klientů Půjčovny kol – generuje vedle-mapy.sh caddy-sync z /data/caddy-hosty.txt. Neupravovat ručně."
      sed -e "s/^DOMENA, .* {\$/$hosts {/" -e 's/access-pujcovna-kol\.log/access-pujcovna-kol-klienti.log/' "$PK_DEPLOY/Caddyfile.vedle-mapy-blok" | grep -v '^#'
    } > "$novy"
  fi
  if [ -s "$novy" ] && cmp -s "$novy" "$KLIENTI_BLOK" 2>/dev/null; then rm -f "$novy"; return 0; fi
  if [ ! -s "$novy" ] && [ ! -f "$KLIENTI_BLOK" ]; then rm -f "$novy"; return 0; fi
  local zaloha=""
  [ -f "$KLIENTI_BLOK" ] && { zaloha="$(mktemp)"; cp "$KLIENTI_BLOK" "$zaloha"; }
  if [ -s "$novy" ]; then install -m 644 "$novy" "$KLIENTI_BLOK"; else rm -f "$KLIENTI_BLOK"; fi
  rm -f "$novy"
  caddy_id="$(mapa_compose ps -q caddy 2>/dev/null || true)"
  if [ -z "$caddy_id" ] || ! docker exec "$caddy_id" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    echo "$(date -Is) CHYBA: konfigurace Caddy s weby klientů neprošla kontrolou – vracím předchozí stav." >&2
    if [ -n "$zaloha" ]; then install -m 644 "$zaloha" "$KLIENTI_BLOK"; else rm -f "$KLIENTI_BLOK"; fi
    rm -f "$zaloha"
    return 1
  fi
  rm -f "$zaloha"
  reload_caddy
  echo "$(date -Is) Weby klientů v Caddy: ${hosts:-žádné}"
}

# Cron pro caddy-sync (každou minutu; nová subdoména klienta dostane certifikát do ~2 minut od založení).
zajisti_cron_sync() {
  local soubor=/etc/cron.d/pujcovna-kol-caddy-sync
  local obsah="# Weby klientů Půjčovny kol → Caddy mapy (deploy/vedle-mapy.sh caddy-sync)
* * * * * root bash $PK_DEPLOY/vedle-mapy.sh caddy-sync >> /var/log/pujcovna-kol-caddy-sync.log 2>&1"
  if [ ! -f "$soubor" ] || [ "$(cat "$soubor")" != "$obsah" ]; then
    printf '%s\n' "$obsah" > "$soubor"
    chmod 644 "$soubor"
    echo "→ Synchronizace webů klientů do Caddy nastavena ($soubor)."
  fi
}

case "${1:-}" in
  instalace)
    d="${2:-${PK_DOMAIN:-}}"; [ -n "$d" ] || chyba "zadejte doménu: vedle-mapy.sh instalace ksprehledy.cz"
    zajisti_vetev
    zajisti_caddy_mapy
    zapis_blok "$d"
    reload_caddy
    echo "→ Instaluji aplikaci půjčovny (hetzner.sh, bez vlastní Caddy)…"
    bash "$PK_DEPLOY/hetzner.sh" instalace "$d"
    zajisti_cron_sync
    caddy_sync || true
    ;;
  aktualizace)
    zajisti_vetev
    zajisti_caddy_mapy
    [ -n "$(domena)" ] && zapis_blok "$(domena)"
    bash "$PK_DEPLOY/hetzner.sh" aktualizace
    reload_caddy
    zajisti_cron_sync
    caddy_sync || true
    ;;
  caddy-sync) caddy_sync ;;
  stav|log|zaloha|zpet) bash "$PK_DEPLOY/hetzner.sh" "$@" ;;
  *) echo "Použití: vedle-mapy.sh instalace DOMENA | aktualizace | stav | log | zaloha [--cron] | zpet | caddy-sync" >&2; exit 1 ;;
esac
