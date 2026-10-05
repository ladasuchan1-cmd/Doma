#!/usr/bin/env bash
# Příprava serveru (Hetzner 37.27.203.154) pro Kolomapu – JEDEN příkaz přes SSH (uživatel se sudo, nebo root):
#
#   curl -fsSL https://raw.githubusercontent.com/ladasuchan1-cmd/Doma/refs/heads/VETEV/kolomapa/deploy/docker/pripravit-server.sh -o /tmp/pripravit-server.sh && sudo bash /tmp/pripravit-server.sh [REGISTRACNI_TOKEN]
#
# 1. stáhne (nebo aktualizuje) kód do /root/Doma a nasadí Kolomapu (deploy/docker/nasadit.sh: obraz, testy,
#    kontejner na Docker síti Caddy, blok pro Caddy, záloha) – na konci vypíše heslo do mapy,
# 2. s REGISTRAČNÍM TOKENEM z GitHubu (Doma → Settings → Actions → Runners → New self-hosted runner → Linux;
#    token ze stránky platí hodinu) nainstaluje self-hosted runner se štítkem „kolomapa“ jako službu – od té
#    chvíle nasazuje workflow „Kolomapa – nasazení na server“ samo (zapíná proměnná repozitáře
#    KOLOMAPA_HETZNER=true). Bez tokenu se jen nasadí.
# Lze spouštět opakovaně (klon aktualizuje, runner neinstaluje dvakrát). Podrobně: HETZNER.md.
set -euo pipefail

REPO=ladasuchan1-cmd/Doma
VETEV="${KOLOMAPA_VETEV:-claude/bike-sales-monitoring-app-kufe7w}"
KOD=/root/Doma
RUNNER_DIR=/root/actions-runner-kolomapa
TOKEN="${1:-}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\nCHYBA: %s\n' "$*" >&2; exit 1; }

if [[ $EUID -ne 0 ]]; then
  die "potřebuje práva root. Spusťte přes sudo:
  curl -fsSL https://raw.githubusercontent.com/ladasuchan1-cmd/Doma/refs/heads/$VETEV/kolomapa/deploy/docker/pripravit-server.sh -o /tmp/pripravit-server.sh && sudo bash /tmp/pripravit-server.sh${TOKEN:+ $TOKEN}"
fi
command -v docker >/dev/null || die "docker tu není – je to server, kde běží ostatní aplikace (sales, projekty)?"
if ! command -v git >/dev/null; then
  say "Instaluji git"
  apt-get update -qq && apt-get install -y -qq git >/dev/null
fi

say "Kód Kolomapy v $KOD (větev $VETEV)"
if [[ -d "$KOD/.git" ]]; then
  git -C "$KOD" fetch --quiet origin
  git -C "$KOD" checkout --quiet "$VETEV"
  git -C "$KOD" pull --ff-only --quiet
else
  git clone --quiet -b "$VETEV" "https://github.com/$REPO.git" "$KOD"
fi
echo "   verze $(git -C "$KOD" rev-parse --short HEAD)"

say "Nasazení Kolomapy"
bash "$KOD/kolomapa/deploy/docker/nasadit.sh"

if [[ -z "$TOKEN" ]]; then
  echo
  echo "Runner pro automatické nasazování jsem neinstaloval (bez registračního tokenu)."
  echo "Až budete chtít: GitHub → Doma → Settings → Actions → Runners → New self-hosted runner → Linux → zkopírovat"
  echo "token z řádku ./config.sh a spustit tento příkaz znovu s tokenem na konci."
  exit 0
fi

say "Self-hosted runner GitHub Actions ($RUNNER_DIR, štítek kolomapa)"
mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"
if [[ ! -x ./config.sh ]]; then
  URL="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | grep -o '"browser_download_url": *"[^"]*actions-runner-linux-x64-[0-9.]*\.tar\.gz"' | head -1 | cut -d'"' -f4)"
  [[ -n "$URL" ]] || die "nepodařilo se zjistit adresu runneru (api.github.com nedostupné?)"
  echo "   stahuji $URL"
  curl -fsSL -o runner.tar.gz "$URL"
  tar xzf runner.tar.gz && rm -f runner.tar.gz
fi
if [[ -f .runner ]]; then
  echo "   runner už je zaregistrovaný – nechávám."
else
  # Runner běží jako root: nasazení upravuje konfiguraci Caddy a tak na tomto serveru běží vše ostatní.
  RUNNER_ALLOW_RUNASROOT=1 ./config.sh --url "https://github.com/$REPO" --token "$TOKEN" \
    --name "hetzner-kolomapa" --labels kolomapa --unattended --replace
  grep -q '^RUNNER_ALLOW_RUNASROOT=' .env 2>/dev/null || echo 'RUNNER_ALLOW_RUNASROOT=1' >>.env
  ./svc.sh install root >/dev/null
  ./svc.sh start >/dev/null
fi
./svc.sh status | tail -3

say "Hotovo"
cat <<EOF
Runner běží a čeká na joby se štítkem „kolomapa“. Ještě na GitHubu: Doma → Settings → Secrets and variables
→ Actions → Variables → New: KOLOMAPA_HETZNER = true. Pak nasazení spustí každé sloučení do main (změny ve složce
kolomapa/) nebo ručně Actions → „Kolomapa – nasazení na server“ → Run workflow.
EOF
