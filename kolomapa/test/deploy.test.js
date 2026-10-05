'use strict';
// Nasazení na vlastní server (deploy/): skripty jsou platný bash s LF, šablony mají zástupné značky, které
// instalace.sh vyplňuje, a služba je zabezpečená (jen lokální port, zápis jen do data/ a training/).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DIR = path.join(__dirname, '..', 'deploy');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

test('deploy: skripty jsou platný bash s konci řádků LF a s set -euo pipefail', (t) => {
  for (const f of ['instalace.sh', 'aktualizovat.sh']) {
    const s = read(f);
    assert.ok(!s.includes('\r'), `${f}: CRLF by v Linuxu rozbil skript`);
    assert.match(s, /^#!\/usr\/bin\/env bash\n/);
    assert.match(s, /\nset -euo pipefail\n/);
    const r = spawnSync('bash', ['-n', path.join(DIR, f)], { encoding: 'utf8' });
    if (r.error) return t.skip('bash není k dispozici');
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
  const attrs = fs.readFileSync(path.join(__dirname, '..', '.gitattributes'), 'utf8');
  assert.match(attrs, /^\*\.sh text eol=lf$/m);
});

test('deploy: instalace vyplní všechny značky šablon a nastaví proxy + heslo', () => {
  const inst = read('instalace.sh');
  const service = read('kolomapa.service');
  const caddy = read('Caddyfile');
  const marks = (s) => [...new Set(s.match(/@[A-Z_]+@/g) || [])].sort();
  assert.deepEqual(marks(service), ['@APP_DIR@', '@NODE@']);
  assert.deepEqual(marks(caddy), ['@DOMAIN@', '@PORT@']);
  for (const m of [...marks(service), ...marks(caddy)]) assert.ok(inst.includes(`s#${m}#`), `instalace.sh nevyplňuje ${m}`);
  // nastavení vytvořené instalací: jen lokální port, důvěra k proxy, náhodné heslo
  assert.match(inst, /KOLOMAPA_HOST=127\.0\.0\.1/);
  assert.match(inst, /KOLOMAPA_TRUST_PROXY=1/);
  assert.match(inst, /KOLOMAPA_PASSWORD=\$PASSWORD/);
  assert.match(inst, /\/dev\/urandom/);
  // nastaveni.txt (heslo) čte jen služba
  assert.match(inst, /chmod 600 "\$SETTINGS"/);
  // klíče v šabloně nastavení musí Kolomapa znát (jinak by hlásila překlep)
  const { KNOWN_KEYS } = require('../src/config');
  for (const k of inst.match(/^#?(KOLOMAPA_[A-Z_]+|ANTHROPIC_API_KEY)=/gm).map((x) => x.replace(/^#|=$/g, ''))) assert.ok(KNOWN_KEYS.has(k), k);
});

test('deploy: služba běží pod vlastním uživatelem, kód jen pro čtení, pražský čas', () => {
  const s = read('kolomapa.service');
  assert.match(s, /^User=kolomapa$/m);
  assert.match(s, /^ProtectSystem=strict$/m);
  assert.match(s, /^NoNewPrivileges=true$/m);
  assert.match(s, /^ReadWritePaths=@APP_DIR@\/data @APP_DIR@\/training$/m);
  assert.match(s, /^Environment=TZ=Europe\/Prague$/m);
  assert.match(s, /^ExecStart=@NODE@ .*server\.js$/m);
  // nginx varianta: X-Forwarded-For jen s adresou návštěvníka (nepodvrhnutelné)
  assert.match(read('nginx-kolomapa.conf'), /proxy_set_header X-Forwarded-For \$remote_addr;/);
});

// ---------------------------------------------------------------- server s Dockerem a Caddy (deploy/docker)

const ROOT = path.join(__dirname, '..');
const readRoot = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('docker: obraz běží pod uživatelem node v pražském čase, jen port 8050, bez dat a hesel v obrazu', () => {
  const d = readRoot('Dockerfile');
  assert.match(d, /^FROM node:22-/m);
  assert.match(d, /^USER node$/m);
  assert.match(d, /TZ=Europe\/Prague/);
  assert.match(d, /^EXPOSE 8050$/m);
  assert.match(d, /KOLOMAPA_PORT=8050/);
  assert.match(d, /KOLOMAPA_HOST=0\.0\.0\.0/);
  assert.match(d, /KOLOMAPA_TRUST_PROXY=1/);
  assert.match(d, /^HEALTHCHECK /m);
  assert.match(d, /PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1/, 'Chromium jen na vyžádání (build-arg)');
  assert.match(d, /^CMD \["node", "--disable-warning=ExperimentalWarning", "server\.js"\]$/m);
  const ignore = readRoot('.dockerignore').split('\n');
  for (const f of ['data', 'dist', 'node_modules', '.env', 'nastaveni.txt', '*.xlsx', '.git']) assert.ok(ignore.includes(f), `.dockerignore: chybí ${f}`);
  assert.ok(readRoot('.gitignore').split('\n').includes('/.env'), '.env (heslo) se necommituje');
});

test('docker: nasadit.sh je platný bash, nasazuje jen s heslem a šablona .env má jen známé klíče', (t) => {
  const s = read(path.join('docker', 'nasadit.sh'));
  assert.ok(!s.includes('\r'));
  assert.match(s, /^#!\/usr\/bin\/env bash\n/);
  assert.match(s, /\nset -euo pipefail\n/);
  const r = spawnSync('bash', ['-n', path.join(DIR, 'docker', 'nasadit.sh')], { encoding: 'utf8' });
  if (r.error) return t.skip('bash není k dispozici');
  assert.equal(r.status, 0, r.stderr);
  // bez hesla se mapa na internet nepouští; testy běží v obrazu před výměnou kontejneru; kontejner bez -p
  assert.match(s, /grep -q '\^KOLOMAPA_PASSWORD=\.\\\+' "\$ENV_SOUBOR" \|\| die/, 'bez hesla (a bez uživatelů) se nenasazuje');
  assert.match(s, /docker run --rm "\$IMAGE" npm test/);
  // pull přinese nový nasadit.sh → bash by dočetl starý soubor nad novým kódem; nová verze se proto spustí znovu (jednou)
  assert.match(s, /KOLOMAPA_NASADIT_ZNOVU=1 exec bash "\$SKRIPT" "\$@"/);
  assert.match(s, /-z "\$\{KOLOMAPA_NASADIT_ZNOVU:-\}"/);
  assert.match(s, /docker build --no-cache --build-arg "S_PROHLIZECEM=/);
  // port se publikuje jen pro Caddy mimo Docker a jen na 127.0.0.1 – nikdy veřejně
  assert.match(s, /PUBLISH=\(-p "127\.0\.0\.1:\$PORT:\$PORT"\)/);
  assert.doesNotMatch(s, /-p "\$PORT:|-p 0\.0\.0\.0|-p "\$\{?PORT\}?:/);
  assert.match(s, /sslip\.io/, 'výchozí adresa bez vlastní DNS');
  assert.match(s, /--network "\$SIT"/);
  // stálé jméno hostitele + smazání zámku běhu po zabitém kontejneru (jinak by nový server čekal na „jiný proces“)
  assert.match(s, /--hostname "\$APP"/);
  assert.match(s, /^rm -f "\$DATA\/kolomapa\.db\.run-lock"$/m);
  assert.match(s, /--env-file "\$ENV_SOUBOR"/);
  assert.match(s, /-v "\$DATA":\/app\/data/);
  assert.match(s, /caddy validate --config/, 'Caddyfile se před reloadem ověří');
  assert.match(s, /chmod 600 "\$ENV_SOUBOR"/);
  // Caddy ze stacku Cyklo & Ski mapy (deploy-caddy-1): kontejner podle obrazu, ne jen podle jména „caddy“; její
  // Caddyfile je v git klonu, proto blok do svazku caddy_config (/config/sites/kolomapa.caddy) + řádek import,
  // a klon se po sloučení srovná z gitu (hetzner.sh aktualizace jinak kód nestahuje)
  assert.match(s, /\(\^\|\\\/\)caddy\(:\|@\|\$\)/, 'kontejner Caddy podle obrazu');
  assert.match(s, /^CADDY_SITES=\/config\/sites\s/m);
  assert.match(s, /^IMPORT_RADEK="import \$CADDY_SITES\/\*\.caddy"$/m);
  assert.match(s, /mkdir -p '\$CADDY_SITES' && cat >'\$SOUBOR'/);
  assert.match(s, /caddyfile_git_srovnat "\$CADDYFILE" "\$KLON"/);
  const sites = s.slice(s.indexOf('elif [[ "$ZPUSOB" == sites ]]; then'), s.indexOf('caddyfile_git_srovnat "$CADDYFILE" "$KLON"'));
  assert.ok(sites.length > 100 && !sites.includes('$CADDYFILE.zaloha'), 'v git klonu žádný soubor .zaloha (hetzner.sh by viděl necommitnutou změnu)');
  assert.match(s, /merge -q --ff-only "origin\/\$vetev"/);
  // přihlášení jmény a hesly Cyklo & Ski mapy: opis CSM_USERS/CSM_PASSWORD do data/uzivatele.env (vlastník UID 1000,
  // jen pro čtení vlastníkem), obnova cronem, kontejner čte KOLOMAPA_USERS_FILE; bez hesla jen když uživatelé jsou
  assert.match(s, /grep -E '\^CSM_\(USERS\|PASSWORD\)=' "\\\$Z"/);
  assert.match(s, /chown 1000:1000 "\\\$CIL\.tmp" && chmod 600 "\\\$CIL\.tmp" && mv -f/);
  assert.match(s, /\\n\*\/5 \* \* \* \* root %s\\n/, 'cron každých 5 minut');
  assert.match(s, /ENV_NAVIC=\(-e "KOLOMAPA_USERS_FILE=\/app\/data\/\$UZIVATELE_SOUBOR"\)/);
  assert.match(s, /\[\[ -n "\$UZIVATELE" \]\] \|\| grep -q '\^KOLOMAPA_PASSWORD=\.\\\+' "\$ENV_SOUBOR" \|\| die/);
  const { KNOWN_KEYS } = require('../src/config');
  for (const k of s.match(/^#?(KOLOMAPA_[A-Z_]+|ANTHROPIC_API_KEY)=/gm).map((x) => x.replace(/^#|=$/g, ''))) assert.ok(KNOWN_KEYS.has(k), k);
});

test('docker: workflow nasazení – testy jako brána, self-hosted runner jen se zapnutou proměnnou, bez pull_request', (t) => {
  const wf = path.join(ROOT, '..', '.github', 'workflows', 'kolomapa-nasazeni.yml');
  if (!fs.existsSync(wf)) return t.skip('workflow leží v repozitáři nad složkou kolomapa (v obrazu Dockeru / ZIPu chybí)');
  const w = fs.readFileSync(wf, 'utf8');
  assert.doesNotMatch(w, /pull_request/, 'self-hosted runner nesmí spouštět kód z cizích pull requestů');
  assert.match(w, /^\s+if: vars\.KOLOMAPA_HETZNER == 'true'$/m);
  assert.match(w, /runs-on: \[self-hosted, kolomapa\]/);
  assert.match(w, /needs: test/);
  assert.match(w, /run: bash kolomapa\/deploy\/docker\/nasadit\.sh/);
  assert.match(w, /contents: read/);
});

test('docker: Caddyfile Cyklo & Ski mapy načítá /config/sites/*.caddy (blok Kolomapy ve svazku caddy_config)', (t) => {
  const dir = path.join(ROOT, '..', 'cyklo-ski-mapa', 'deploy');
  if (!fs.existsSync(dir)) return t.skip('cyklo-ski-mapa leží v repozitáři nad složkou kolomapa (v obrazu Dockeru / ZIPu chybí)');
  assert.match(fs.readFileSync(path.join(dir, 'Caddyfile'), 'utf8'), /^import \/config\/sites\/\*\.caddy$/m);
  // /config musí být svazek, jinak by soubor Kolomapy nepřežil obnovu kontejneru caddy
  assert.match(fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8'), /^\s+- caddy_config:\/config$/m);
});

test('docker: pripravit-server.sh – jeden příkaz z raw odkazu (refs/heads/…), runner se štítkem kolomapa', (t) => {
  const s = read(path.join('docker', 'pripravit-server.sh'));
  assert.ok(!s.includes('\r'));
  assert.match(s, /^#!\/usr\/bin\/env bash\n/);
  assert.match(s, /\nset -euo pipefail\n/);
  const r = spawnSync('bash', ['-n', path.join(DIR, 'docker', 'pripravit-server.sh')], { encoding: 'utf8' });
  if (r.error) return t.skip('bash není k dispozici');
  assert.equal(r.status, 0, r.stderr);
  assert.match(s, /raw\.githubusercontent\.com\/ladasuchan1-cmd\/Doma\/refs\/heads\//, 'větev s lomítkem jen přes refs/heads/');
  assert.match(s, /--labels kolomapa --unattended --replace/);
  assert.match(s, /RUNNER_ALLOW_RUNASROOT=1/);
  assert.match(s, /bash "\$KOD\/kolomapa\/deploy\/docker\/nasadit\.sh"/);
  // bez tokenu se runner neinstaluje, jen nasadí
  assert.match(s, /if \[\[ -z "\$TOKEN" \]\]; then/);
});
