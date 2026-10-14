#!/usr/bin/env bash
# Připraví SSH klíč a known_hosts, aby se runner GitHubu připojil k serveru (Hetzner). Používá ho workflow
# obnovy dat (dotazy na QLever jdou přes server). Vstup v proměnných prostředí: KEY (soukromý klíč ze secretu
# HETZNER_SSH_KEY), HOST, PORT (výchozí 22). Výstup: ~/.ssh/id_deploy a záznam serveru v ~/.ssh/known_hosts.
# Klíč čistí stejně jako nasazení (cyklo-ski-mapa.yml): vložený ze schránky Windows mívá CRLF, BOM nebo je
# slepený do jednoho řádku a OpenSSH ho pak odmítne („error in libcrypto“).
set -euo pipefail
test -n "${HOST:-}" || { echo "Chybí secret HETZNER_HOST"; exit 1; }
test -n "${KEY:-}" || { echo "Chybí secret HETZNER_SSH_KEY"; exit 1; }
mkdir -p ~/.ssh
raw="$(printf '%s\n' "$KEY" | sed '1s/^\xEF\xBB\xBF//' | tr -d '\r')"
typ="$(printf '%s\n' "$raw" | grep -o -m1 'BEGIN [A-Z0-9 ]*PRIVATE KEY' | sed 's/^BEGIN //' || true)"
test -n "$typ" || { echo "Secret HETZNER_SSH_KEY neobsahuje soukromý klíč (chybí řádek -----BEGIN … PRIVATE KEY-----)."; exit 1; }
body="$(printf '%s\n' "$raw" | sed -e 's/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----//' -e 's/-----END [A-Z0-9 ]*PRIVATE KEY-----//' | tr -d '[:space:]')"
{ echo "-----BEGIN $typ-----"; printf '%s\n' "$body" | fold -w 70; echo "-----END $typ-----"; } > ~/.ssh/id_deploy
chmod 600 ~/.ssh/id_deploy
if ! chyba="$(ssh-keygen -y -P "" -f ~/.ssh/id_deploy 2>&1 >/dev/null)"; then
  echo "Secret HETZNER_SSH_KEY není použitelný klíč: $chyba"
  exit 1
fi
ssh-keyscan -p "${PORT:-22}" -H "$HOST" >> ~/.ssh/known_hosts 2>/dev/null || { echo "Server neodpovídá na SSH (port ${PORT:-22})."; exit 1; }
echo "Klíč v pořádku, otisk: $(ssh-keygen -lf ~/.ssh/id_deploy | awk '{print $2}')"
