'use strict';
// Test stažení dotazů na QLever přes server (tools/qlever-pres-ssh.js) s falešným ssh – bez sítě.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const src = require('../tools/lib/sources.js');

const NASTROJ = path.join(__dirname, '..', 'tools', 'qlever-pres-ssh.js');
const FALESNE = path.join(__dirname, 'fixtures', 'falesne-ssh.js');

function spust(cache, env) {
  return spawnSync(process.execPath, [NASTROJ, '--cache', cache, '--', process.execPath, FALESNE, 'uzivatel@server'], { encoding: 'utf8', env: { ...process.env, ...env } });
}

test('každý dotaz jde se svým tělem do vlastního souboru, statistiky do qlever_stats.json', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-qlever-'));
  try {
    const r = spust(cache, {});
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    for (const [nazev, dotaz] of Object.entries(src.SPARQL_QUERIES)) {
      const obsah = fs.readFileSync(path.join(cache, `${nazev}.csv`), 'utf8');
      assert.strictEqual(obsah, `delka\n${src.sparqlBody(dotaz).length}\n`, nazev);
    }
    const stats = JSON.parse(fs.readFileSync(path.join(cache, 'qlever_stats.json'), 'utf8'));
    assert.strictEqual(src.planetDatum(stats['name-index']), '2026-09-21');
    assert.deepStrictEqual(fs.readdirSync(cache).filter((f) => f.endsWith('.stahuji')), []);
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test('chyba dotazu ukončí běh s chybou a nenechá po sobě neúplný soubor', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-qlever-'));
  try {
    const r = spust(cache, { FALESNE_SSH_CHYBA: '1' });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /selhalo/);
    assert.deepStrictEqual(fs.readdirSync(cache), []);
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});
