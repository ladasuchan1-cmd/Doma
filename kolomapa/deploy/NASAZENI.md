# Kolomapa na vlastním serveru s doménou

> Server, kde už běží ostatní aplikace v Dockeru za Caddy (Hetzner, ksprehledy.cz)? Pak použijte
> [docker/HETZNER.md](docker/HETZNER.md) – Kolomapa tam poběží jako další kontejner. Tenhle návod je pro
> samostatný Linux server bez Dockeru.

Výsledek: mapa na `https://mapa.vasedomena.cz` s heslem a HTTPS certifikátem (Let's Encrypt, obnovuje se sám).
Stahování běží každý den přímo na serveru, počítač v obchodě nemusí být zapnutý.

**Co potřebujete**
- Server (VPS) s **Ubuntu 22.04/24.04** nebo **Debianem 12** a přístupem přes SSH s `sudo`. Stačí **1 GB RAM**,
  s Cyklobazarem (prohlížeč) **2 GB**. Disk: ~1 GB.
- Doménu (nebo subdoménu), u které můžete upravit DNS.

Příkazy níže se zadávají do SSH terminálu serveru. Z Windows: `ssh root@IP-serveru` v PowerShellu, z telefonu
třeba aplikace Termius.

## 1. DNS

U registrátora domény přidejte záznam **A**: `mapa` (nebo jiná subdoména) → **IP adresa serveru**
(má-li server IPv6, i záznam **AAAA**). Změna se obvykle projeví do hodiny. Ověření na serveru:

```bash
getent hosts mapa.vasedomena.cz     # má vypsat IP serveru
```

## 2. Kód na server (repozitář je soukromý → klíč jen pro čtení)

```bash
sudo ssh-keygen -t ed25519 -N "" -f /root/.ssh/kolomapa_deploy -C kolomapa-server
sudo cat /root/.ssh/kolomapa_deploy.pub
```

Vypsaný řádek (`ssh-ed25519 AAAA… kolomapa-server`) vložte na GitHubu: repozitář **Doma → Settings → Deploy keys →
Add deploy key** (název třeba „server“, **bez** „Allow write access“). Pak:

```bash
sudo tee -a /root/.ssh/config >/dev/null <<'EOF'
Host github-kolomapa
  HostName github.com
  User git
  IdentityFile /root/.ssh/kolomapa_deploy
  IdentitiesOnly yes
EOF
sudo git clone -b claude/bike-sales-monitoring-app-kufe7w git@github-kolomapa:ladasuchan1-cmd/Doma.git /opt/doma
```

(Až bude práce sloučená do hlavní větve, použijte místo `-b claude/…` větev `main`:
`sudo git -C /opt/doma checkout main`.)

## 3. Instalace

```bash
sudo bash /opt/doma/kolomapa/deploy/instalace.sh mapa.vasedomena.cz
```

Skript nainstaluje Node.js 22, Caddy (HTTPS), službu `kolomapa` a denní zálohu a na konci **vypíše heslo**.
Otevřete `https://mapa.vasedomena.cz`, jméno libovolné, heslo z výpisu. První stahování začne samo (2–3 hodiny).

Běží-li na serveru už nginx nebo Apache (porty 80/443 obsazené), skript Caddy neinstaluje – Kolomapu napojte podle
`deploy/nginx-kolomapa.conf`.

## Běžná údržba

| Co | Příkaz |
|---|---|
| Stav / log | `systemctl status kolomapa` · `journalctl -u kolomapa -f` |
| Změna nastavení | `sudo nano /opt/doma/kolomapa/nastaveni.txt`, pak `sudo systemctl restart kolomapa` |
| Nová verze | `sudo bash /opt/doma/kolomapa/deploy/aktualizovat.sh` (počká na doběhnutí stahování) |
| Vlastní prodeje z POHODY | soubor nahrajte na server (WinSCP, nebo `scp export.xlsx root@IP:/tmp/`), pak `cd /opt/doma/kolomapa && sudo -u kolomapa npm run import-sales -- /tmp/export.xlsx` |
| Zálohy databáze | každý den do `/var/backups/kolomapa/` (7 dní dozadu) |
| Obnova ze zálohy | `sudo systemctl stop kolomapa`, zkopírovat zálohu na `/opt/doma/kolomapa/data/kolomapa.db` (smazat `-wal`/`-shm` vedle), `sudo chown kolomapa: …`, `sudo systemctl start kolomapa` |

**AI nacenění a Cyklobazar** (volitelné balíčky):

```bash
cd /opt/doma/kolomapa && sudo npm install --omit=dev
sudo npx playwright install-deps chromium            # jen pro Cyklobazar: systémové knihovny prohlížeče
sudo -u kolomapa npx playwright install chromium     # jen pro Cyklobazar: prohlížeč pro službu
```

Klíč `ANTHROPIC_API_KEY` a zdroje (`KOLOMAPA_SOURCES`) se nastavují v `nastaveni.txt` – viz README.md.

## Bezpečnost

- Kolomapa poslouchá jen na `127.0.0.1`, ven ji pouští Caddy přes HTTPS; bez hesla se nic nezobrazí. Po 10 špatných
  heslech z jedné adresy server tuto adresu na čas zablokuje (`KOLOMAPA_TRUST_PROXY=1` – skutečná adresa návštěvníka
  od Caddy).
- Služba běží pod vlastním uživatelem `kolomapa` a smí zapisovat jen do `data/` a `training/`.
- Heslo je v `nastaveni.txt` (čte ho jen služba a root). Změna: upravit řádek `KOLOMAPA_PASSWORD=…` a restartovat.
- K serveru se přihlašujte SSH klíčem a udržujte systém aktuální (`sudo apt update && sudo apt upgrade`).
