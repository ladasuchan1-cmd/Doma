#!/usr/bin/env bash
# Půjčovna kol (demo musteru) na Hetzneru nebo jiném VPS s veřejnou IP a doménou: instalace, aktualizace, záloha,
# stav, log, návrat k předchozí verzi. Spouští se NA SERVERU jako root (Ubuntu 22.04/24.04, Debian 12). Používá
# Docker Compose s Caddy (HTTPS z Let's Encrypt automaticky, zvlášť pro apex a subdomény www/outdoor/sport/family) –
# deploy/docker-compose.yml + deploy/Caddyfile. Převzato z ../cyklo-ski-mapa/deploy/hetzner.sh (SPEC kap. 15).
#
#   apt-get install -y git && git clone https://github.com/ladasuchan1-cmd/Doma.git /opt/Doma
#   bash /opt/Doma/pujcovna-kol/deploy/hetzner.sh instalace ksprehledy.cz
#
#   bash /opt/Doma/pujcovna-kol/deploy/hetzner.sh aktualizace    # stáhne nový kód a znovu postaví (pouští i GitHub Actions)
#   bash /opt/Doma/pujcovna-kol/deploy/hetzner.sh zaloha         # online záloha všech data/tenants/*.db + .secret + kopie tenants/
#   bash /opt/Doma/pujcovna-kol/deploy/hetzner.sh zaloha --cron  # + denní záloha ve 2:30 (cron; nastavuje se i sama po instalaci)
#   bash /opt/Doma/pujcovna-kol/deploy/hetzner.sh zpet           # vrátí předchozí verzi aplikace (image :predchozi)
#   bash /opt/Doma/pujcovna-kol/deploy/hetzner.sh stav | log
#
# Proměnné: PK_REPO_DIR (/opt/Doma), PK_COMPOSE (docker-compose.yml), PK_ZALOHY (/opt/zalohy-pujcovna-kol), PK_PLATFORMA_HESLO
# (heslo /platforma – propíše se do .env), PK_DOMAIN
# (apex doména – při nasazení z GitHubu se propíše do .env), PK_ADMIN_PASSWORD (heslo správce – propíše se do .env, v demu
# netřeba: demo@ksprehledy.cz / kolo-demo-2026), PK_VETEV (větev repa pro první klon), PK_UFW=0 (nenastavovat firewall),
# PK_CRON=0 (nenastavovat denní zálohu), PK_ZALOHY_POCET (30 – kolik posledních záloh nechat).
#
# Běží i bez repa na disku – skript lze poslat přes SSH ze stdin (první instalace z GitHub Actions):
#   ssh agent@server 'sudo -n env PK_DOMAIN=ksprehledy.cz bash -s -- instalace ksprehledy.cz' < deploy/hetzner.sh
# Když neběží jako root a sudo je bez hesla, spustí se přes sudo sám.
set -euo pipefail

if [ "$(id -u)" != 0 ]; then
  if [ -f "${BASH_SOURCE[0]:-}" ] && sudo -n true 2>/dev/null; then
    exec sudo -n env PK_DOMAIN="${PK_DOMAIN:-}" PK_ADMIN_PASSWORD="${PK_ADMIN_PASSWORD:-}" PK_PLATFORMA_HESLO="${PK_PLATFORMA_HESLO:-}" PK_REPO_DIR="${PK_REPO_DIR:-}" \
      PK_COMPOSE="${PK_COMPOSE:-}" PK_ZALOHY="${PK_ZALOHY:-}" PK_VETEV="${PK_VETEV:-}" PK_UFW="${PK_UFW:-}" PK_CRON="${PK_CRON:-}" \
      PK_ZALOHY_POCET="${PK_ZALOHY_POCET:-}" bash "${BASH_SOURCE[0]}" "$@"
  fi
  echo "CHYBA: spusťte jako root nebo přes sudo (sudo bash $0 …)." >&2
  exit 1
fi

REPO_URL="${PK_REPO:-https://github.com/ladasuchan1-cmd/Doma.git}"
REPO_DIR="${PK_REPO_DIR:-/opt/Doma}"
APP_DIR="$REPO_DIR/pujcovna-kol"
DEPLOY_DIR="$APP_DIR/deploy"
COMPOSE_FILE="${PK_COMPOSE:-docker-compose.yml}"
ZALOHY="${PK_ZALOHY:-/opt/zalohy-pujcovna-kol}"
ZALOHY_POCET="${PK_ZALOHY_POCET:-30}"
IMAGE=pujcovna-kol
APP_PORT=8092
SUBDOMENY="www outdoor sport family"

compose() { (cd "$DEPLOY_DIR" && docker compose -f "$COMPOSE_FILE" "$@"); }

chyba() { echo "CHYBA: $*" >&2; exit 1; }

domena() { sed -n 's/^PK_DOMAIN=//p' "$DEPLOY_DIR/.env" 2>/dev/null | head -1; }

verze_z_gitu() { git -C "$APP_DIR" log -1 --format='v%cd-%h' --date=format:%Y-%m-%d 2>/dev/null || date +'v%Y-%m-%d-%H%M'; }

# Health aplikace zevnitř kontejneru (node:alpine má busybox wget).
health_app() { compose exec -T app wget -qO- "http://127.0.0.1:$APP_PORT/api/health" 2>/dev/null; }

# Nastaví klíč v deploy/.env (přidá, nebo nahradí). $1 = klíč, $2 = hodnota.
nastav_env() {
  local env="$DEPLOY_DIR/.env" key="$1" value="$2"
  { grep -v "^$key=" "$env" 2>/dev/null || true; printf '%s=%s\n' "$key" "$value"; } > "$env.tmp" && mv "$env.tmp" "$env" && chmod 600 "$env"
}

# Doména (PK_DOMAIN) a heslo správce (PK_ADMIN_PASSWORD) z prostředí – typicky z nastavení GitHubu při nasazení –
# se propíší do deploy/.env, aby platilo to, co je v GitHubu, a na server nebylo nutné chodit.
synchronizuj_env() {
  local env="$DEPLOY_DIR/.env"
  [ -f "$env" ] || return 0
  if [ -n "${PK_DOMAIN:-}" ] && [ "$(domena)" != "$PK_DOMAIN" ]; then
    nastav_env PK_DOMAIN "$PK_DOMAIN"
    echo "→ Doména změněna na $PK_DOMAIN (Caddy si vystaví nové certifikáty pro apex i subdomény)."
  fi
  if [ -n "${PK_ADMIN_PASSWORD:-}" ] && [ "$(sed -n 's/^PK_ADMIN_PASSWORD=//p' "$env" | head -1)" != "$PK_ADMIN_PASSWORD" ]; then
    nastav_env PK_ADMIN_PASSWORD "$PK_ADMIN_PASSWORD"
    echo "→ Heslo správce v .env aktualizováno podle nastavení GitHubu (platí pro nově zakládaný účet / demo seed)."
  fi
  # heslo správy platformy /platforma (pozvánky do průvodce pro nové klienty); min. 12 znaků, jinak je /platforma vypnutá
  if [ -n "${PK_PLATFORMA_HESLO:-}" ] && [ "$(sed -n 's/^PK_PLATFORMA_HESLO=//p' "$env" | head -1)" != "$PK_PLATFORMA_HESLO" ]; then
    nastav_env PK_PLATFORMA_HESLO "$PK_PLATFORMA_HESLO"
    echo "→ Heslo správy platformy (/platforma) v .env aktualizováno podle nastavení GitHubu."
  fi
}

# Čeká, až aplikace v kontejneru odpoví na /api/health.
cekej_na_app() {
  local i
  for i in $(seq 1 90); do
    if health_app >/dev/null; then
      echo "→ Aplikace běží: $(health_app)"
      return 0
    fi
    sleep 1
  done
  echo "Aplikace do 90 s neodpověděla. Log:" >&2
  compose logs --tail 40 app >&2 || true
  return 1
}

# Čeká, až web odpoví přes Caddy na https://DOMENA (certifikáty z Let's Encrypt trvají pár vteřin až minut), pak
# zkontroluje i subdomény – každá má vlastní certifikát a vlastní DNS záznam.
cekej_na_web() {
  local d i s
  d="$(domena)"
  [ -n "$d" ] || return 0
  for i in $(seq 1 90); do
    if curl -fsS -m 5 "https://$d/api/health" >/dev/null 2>&1; then
      echo "Web běží: https://$d  –  $(curl -fsS -m 5 "https://$d/api/health")"
      for s in $SUBDOMENY; do
        if curl -fsS -m 10 "https://$s.$d/api/health" >/dev/null 2>&1; then
          echo "  https://$s.$d  –  OK ($(curl -fsS -m 5 "https://$s.$d/api/health" | sed -n 's/.*"theme":"\([a-z]*\)".*/design \1/p'))"
        else
          echo "  VAROVÁNÍ: https://$s.$d zatím neodpovídá (DNS záznam subdomény, nebo certifikát ještě nevydaný)." >&2
        fi
      done
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
  [ "${PK_UFW:-1}" = "1" ] || return 0
  command -v ufw >/dev/null 2>&1 || return 0
  echo "→ Firewall (ufw): SSH, 80, 443…"
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
}

# Build s čerstvým základním image (bezpečnostní záplaty node:22-alpine) a aktuální Caddy, pak výměna kontejnerů.
postav_a_spust() {
  compose pull --ignore-buildable -q 2>/dev/null || compose pull -q caddy 2>/dev/null || true
  APP_VERSION="$(verze_z_gitu)" compose build --pull app
  APP_VERSION="$(verze_z_gitu)" compose up -d
}

vytvor_env() { # $1 = doména
  local d="$1"
  mkdir -p "$DEPLOY_DIR"
  if [ -f "$DEPLOY_DIR/.env" ]; then
    echo "→ $DEPLOY_DIR/.env už existuje – nechávám (doménu a nastavení upravte ručně, nebo přes PK_DOMAIN)."
    grep -q '^PK_DOMAIN=' "$DEPLOY_DIR/.env" || nastav_env PK_DOMAIN "$d"
    return
  fi
  cat > "$DEPLOY_DIR/.env" <<EOF
# Půjčovna kol – konfigurace serveru (vytvořil hetzner.sh $(date +%F)). Soubor není v gitu. Vzor: .env.example
PK_DOMAIN=$d
PK_ACME_EMAIL=info@$d
PK_DEMO=1
PK_RESET_DEMO_HOUR=3
PK_SEED_DEMO=1
LOG_LEVEL=info
EOF
  [ -n "${PK_ADMIN_PASSWORD:-}" ] && printf 'PK_ADMIN_PASSWORD=%s\n' "$PK_ADMIN_PASSWORD" >> "$DEPLOY_DIR/.env"
  chmod 600 "$DEPLOY_DIR/.env"
  echo "→ Vytvořen $DEPLOY_DIR/.env (demo režim; správce demo@ksprehledy.cz / kolo-demo-2026)."
}

instalace() {
  local d="${1:-${PK_DOMAIN:-}}"
  [ -n "$d" ] || [ -n "$(domena)" ] || chyba "zadejte doménu: hetzner.sh instalace ksprehledy.cz"
  export DEBIAN_FRONTEND=noninteractive
  if command -v apt-get >/dev/null 2>&1; then
    echo "→ Balíčky (git, curl, ufw)…"
    apt-get update -qq && apt-get install -y -qq ca-certificates curl git ufw >/dev/null
  fi
  nainstaluj_docker
  nastav_firewall
  if [ ! -d "$APP_DIR" ]; then
    echo "→ Stahuji repozitář do $REPO_DIR…"
    git clone ${PK_VETEV:+-b "$PK_VETEV"} "$REPO_URL" "$REPO_DIR"
    [ -d "$APP_DIR" ] || chyba "ve větvi není složka pujcovna-kol – naklonujte větev, kde aplikace je (PK_VETEV=… nebo git clone -b …)."
  fi
  vytvor_env "${d:-$(domena)}"
  echo "→ Stavím a spouštím (aplikace + Caddy)…"
  postav_a_spust
  cekej_na_app
  cekej_na_web || true
  mkdir -p "$ZALOHY" && chmod 700 "$ZALOHY"
  zajisti_cron
  echo
  echo "Hotovo. Další krok: v GitHubu nastavit automatické nasazení (NASAZENI.md)."
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
  synchronizuj_env
  # záloha dat před výměnou verze (migrace DB jsou jen dopředné)
  if health_app >/dev/null 2>&1; then zaloha || echo "VAROVÁNÍ: záloha před aktualizací se nepodařila – pokračuji." >&2; fi
  # předchozí verze pro cestu zpět – před buildem, než se přepíše tag latest
  if docker image inspect "$IMAGE:latest" >/dev/null 2>&1; then docker tag "$IMAGE:latest" "$IMAGE:predchozi"; fi
  echo "→ Stavím a spouštím…"
  postav_a_spust
  if ! cekej_na_app; then
    echo "CHYBA: nová verze neodpovídá – vracím předchozí." >&2
    zpet
    exit 1
  fi
  docker image prune -f >/dev/null 2>&1 || true
  zajisti_cron
  cekej_na_web || true
}

zpet() {
  docker image inspect "$IMAGE:predchozi" >/dev/null 2>&1 || chyba "žádná předchozí verze ($IMAGE:predchozi) není uložená."
  echo "→ Vracím předchozí verzi…"
  docker tag "$IMAGE:predchozi" "$IMAGE:latest"
  compose up -d --no-build app
  cekej_na_app && echo "Běží předchozí verze: $(health_app)"
}

# Denní záloha přes cron – nastavuje se automaticky po instalaci i aktualizaci (PK_CRON=0 vypne).
# Běží ve 2:30, tedy před nočním resetem demo dat (PK_RESET_DEMO_HOUR=3).
zajisti_cron() {
  [ "${PK_CRON:-1}" = "1" ] || return 0
  [ -d /etc/cron.d ] || return 0
  local soubor=/etc/cron.d/pujcovna-kol-zaloha
  local obsah="# Denní záloha databází Půjčovny kol (hetzner.sh zaloha)
30 2 * * * root bash $DEPLOY_DIR/hetzner.sh zaloha >> /var/log/pujcovna-kol-zaloha.log 2>&1"
  if [ ! -f "$soubor" ] || [ "$(cat "$soubor")" != "$obsah" ]; then
    printf '%s\n' "$obsah" > "$soubor"
    chmod 644 "$soubor"
    echo "→ Denní záloha ve 2:30 nastavena ($soubor, archivy v $ZALOHY)."
  fi
}

# Konzistentní online kopie SQLite databází vytvořená uvnitř kontejneru (node:sqlite – sqlite.backup(), starší Node
# VACUUM INTO), protože v image není sqlite3 CLI. Argumenty: zdrojový adresář s *.db, cílový adresář, cesta k .secret.
ZALOHA_JS='
const fs = require("node:fs"); const path = require("node:path"); const sqlite = require("node:sqlite");
const [src, dst, secret] = process.argv.slice(1);
(async () => {
  fs.rmSync(dst, { recursive: true, force: true }); fs.mkdirSync(path.join(dst, "db"), { recursive: true });
  const files = fs.existsSync(src) ? fs.readdirSync(src).filter((f) => f.endsWith(".db")) : [];
  for (const f of files) {
    const target = path.join(dst, "db", f);
    const db = new sqlite.DatabaseSync(path.join(src, f));
    try {
      if (typeof sqlite.backup === "function") await sqlite.backup(db, target);
      else db.exec("VACUUM INTO " + "\x27" + target.replace(/\x27/g, "\x27\x27") + "\x27");
    } finally { db.close(); }
    console.log("  " + f + " → " + fs.statSync(target).size + " B");
  }
  if (fs.existsSync(secret)) fs.copyFileSync(secret, path.join(dst, "secret"));
  const dataRoot = path.dirname(secret);
  const plat = path.join(dataRoot, "platforma.db");
  if (fs.existsSync(plat)) {
    const pdb = new sqlite.DatabaseSync(plat);
    try {
      if (typeof sqlite.backup === "function") await sqlite.backup(pdb, path.join(dst, "platforma.db"));
      else pdb.exec("VACUUM INTO " + "\x27" + path.join(dst, "platforma.db").replace(/\x27/g, "\x27\x27") + "\x27");
    } finally { pdb.close(); }
  }
  const klientiDir = path.join(dataRoot, "klienti");
  if (fs.existsSync(klientiDir)) fs.cpSync(klientiDir, path.join(dst, "klienti"), { recursive: true });
  const interni = path.join(dataRoot, "nabidka.interni.json");
  if (fs.existsSync(interni)) fs.copyFileSync(interni, path.join(dst, "nabidka.interni.json"));
  fs.writeFileSync(path.join(dst, "INFO.txt"), "Záloha Půjčovny kol " + new Date().toISOString() + "\ndb/*.db = konzistentní kopie data/tenants/*.db\nsecret = obsah /data/.secret (klíč k šifrovaným polím – bez něj jsou údaje zákazníků nečitelné)\nnabidka.interni.json = interní ceník s nákupními cenami kol (je-li; mimo git, patří jen na server)\nplatforma.db = pozvánky a evidence klientů; klienti/ = konfigurace a loga webů klientů (průvodce)\n");
  console.log("  databází: " + files.length);
})().catch((e) => { console.error("Záloha selhala: " + e.message); process.exit(1); });
'

zaloha() {
  mkdir -p "$ZALOHY" && chmod 700 "$ZALOHY"
  if [ "${1:-}" = "--cron" ]; then
    rm -f /etc/cron.d/pujcovna-kol-zaloha
    zajisti_cron
  fi
  health_app >/dev/null 2>&1 || chyba "aplikace neběží – zálohu dělá kontejner app (compose exec)."
  local znacka tmp cil
  znacka="$(date +%F-%H%M)"
  tmp="$(mktemp -d)"
  echo "→ Záloha databází (online, konzistentní snímek)…"
  compose exec -T app node --disable-warning=ExperimentalWarning -e "$ZALOHA_JS" -- /data/tenants /data/.zaloha-tmp /data/.secret
  compose cp app:/data/.zaloha-tmp "$tmp/data" >/dev/null
  compose exec -T app rm -rf /data/.zaloha-tmp
  cil="$ZALOHY/pujcovna-kol-$znacka.tar.gz"
  # + kopie konfigurace tenantů z repa (tenant.json, logo, okoli.json a obrázky) a .env serveru (je-li)
  if [ -f "$DEPLOY_DIR/.env" ]; then
    tar -czf "$cil" -C "$tmp" data -C "$APP_DIR" tenants -C "$DEPLOY_DIR" .env
  else
    tar -czf "$cil" -C "$tmp" data -C "$APP_DIR" tenants
  fi
  chmod 600 "$cil"
  rm -rf "$tmp"
  echo "→ Záloha: $cil ($(du -h "$cil" | cut -f1)). Obsahuje klíč .secret a osobní údaje – uchovávat jen šifrovaně / s omezeným přístupem."
  ls -1t "$ZALOHY"/pujcovna-kol-*.tar.gz 2>/dev/null | tail -n +"$((ZALOHY_POCET + 1))" | xargs -r rm -f   # nechat N nejnovějších
}

stav() {
  compose ps
  echo "--- health ---"
  health_app || echo "aplikace neodpovídá"
  echo
  local d s
  d="$(domena)"
  if [ -n "$d" ]; then
    for s in "" $SUBDOMENY; do
      local h="${s:+$s.}$d"
      printf '%-28s ' "https://$h"
      curl -fsS -m 5 "https://$h/api/health" || printf 'neodpovídá'
      echo
    done
  fi
  echo "--- zálohy ---"
  ls -1t "$ZALOHY"/pujcovna-kol-*.tar.gz 2>/dev/null | head -3 || echo "žádné"
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
