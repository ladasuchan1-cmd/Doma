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
