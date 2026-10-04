#!/usr/bin/env bash
# Aktualizace Kolomapy na serveru: stáhne novou verzi z gitu a restartuje službu.
#
#   sudo bash deploy/aktualizovat.sh
#
# Když zrovna běží stahování, počká na jeho konec (nejvýš 3 hodiny) – restart by ho přerušil.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(git -C "$APP_DIR" rev-parse --show-toplevel)"
[[ $EUID -eq 0 ]] || { echo "Spusťte přes sudo: sudo bash $0" >&2; exit 1; }

# Běží stahování? Zámek s číslem živého procesu (po pádu zůstane soubor, ale proces už neexistuje).
LOCK="$APP_DIR/data/kolomapa.db.run-lock"
lock_alive() {
  [[ -f "$LOCK" ]] || return 1
  local pid
  pid="$(grep -o '"pid":[0-9]*' "$LOCK" | cut -d: -f2)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}
for _ in $(seq 1 180); do
  lock_alive || break
  [[ -n "${waited:-}" ]] || { echo "Běží stahování – čekám na jeho konec…"; waited=1; }
  sleep 60
done

# Prodeje importované na serveru (npm run import-sales) jsou v databázi; změněný trénovací soubor by bránil
# aktualizaci → odložit jeho kopii do data/ a vrátit verzi z gitu.
if ! git -C "$REPO_DIR" diff --quiet -- "$APP_DIR/training"; then
  COPY="$APP_DIR/data/koloshop-prodeje-$(date +%Y%m%d-%H%M).json"
  cp "$APP_DIR/training/koloshop-prodeje.json" "$COPY"
  git -C "$REPO_DIR" checkout -- "$APP_DIR/training"
  echo "Místně importované prodeje zůstávají v databázi; kopie souboru: $COPY"
fi

BEFORE="$(git -C "$REPO_DIR" rev-parse HEAD)"
git -C "$REPO_DIR" pull --ff-only
AFTER="$(git -C "$REPO_DIR" rev-parse HEAD)"
chown -R kolomapa:kolomapa "$APP_DIR/data" "$APP_DIR/training"
if [[ "$BEFORE" == "$AFTER" ]]; then
  echo "Žádná nová verze."
else
  git -C "$REPO_DIR" --no-pager log --oneline "$BEFORE..$AFTER" | head -20
  systemctl restart kolomapa
  echo "Kolomapa aktualizována a restartována."
fi
