'use strict';
// Windows pro majitele obchodu: start.cmd / stahnout.cmd (dvojklik, Plánovač úloh), npm skripty, README příkazy.
// cmd.exe se tu spustit nedá – kontroluje se aspoň to, co ve Windows typicky rozbije dávkový soubor
// (LF místo CRLF, diakritika v kódové stránce 852, závorky v blocích) a že odkazované soubory existují.
// Skutečný běh v cmd.exe ověřuje workflow .github/workflows/kolomapa.yml (windows-latest).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f));

for (const name of ['start.cmd', 'stahnout.cmd']) {
  test(`${name}: CRLF, jen ASCII, existující cesty, cd do vlastní složky`, () => {
    const buf = read(name);
    const text = buf.toString('latin1');
    assert.ok(!/[^\r]\n/.test(text) && text.includes('\r\n'), 'konce řádků musí být CRLF');
    assert.ok(![...buf].some((b) => b > 0x7e || (b < 0x20 && b !== 0x0d && b !== 0x0a && b !== 0x09)), 'jen ASCII (cmd čte .cmd v kódové stránce 852)');
    assert.match(text, /^@echo off\r\n/);
    assert.match(text, /cd \/d "%~dp0"/, 'Plánovač úloh startuje v C:\\Windows\\System32');
    for (const m of text.matchAll(/node\s+(tools\\[\w.-]+\.js)/g)) assert.ok(fs.existsSync(path.join(ROOT, m[1].replace(/\\/g, '/'))), m[1]);
    // uvnitř bloku ( … ) by „)“ v echo blok ukončila – soubory bloky s echo nepoužívají (skoky na návěští)
    let depth = 0;
    for (const line of text.split('\r\n')) {
      if (depth > 0 && /^\s*echo\b.*\)/i.test(line)) assert.fail(`„)“ v echo uvnitř bloku: ${line}`);
      depth += (line.match(/\(\s*$/) || []).length;
      if (/^\s*\)/.test(line)) depth--;
    }
    for (const m of text.matchAll(/goto\s+(\w+)/gi)) assert.match(text, new RegExp(`^:${m[1]}\\r$`, 'm'), `návěští :${m[1]}`);
  });
}

test('.gitattributes drží CRLF u .cmd i ve stažených ZIPech', () => {
  const attrs = read('.gitattributes').toString();
  assert.match(attrs, /^\*\.cmd text eol=crlf\r?$/m);
  assert.match(attrs, /^nastaveni-vzor\.txt text eol=crlf\r?$/m);
});

test('nastaveni.txt (heslo, API klíč) se necommituje', () => {
  const ignore = read('.gitignore').toString();
  assert.match(ignore, /^\/nastaveni\.txt\r?$/m);
  assert.match(ignore, /^\/nastaveni\.txt\.txt\r?$/m);
});

test('package.json: skripty ukazují na existující soubory, testy přes uvozený glob (cmd.exe i sh)', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.engines.node, '>=22.13');
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    assert.match(cmd, /^node /, name);
    for (const m of cmd.matchAll(/\s((?:tools\/)?[\w.-]+\.js)\b/g)) assert.ok(fs.existsSync(path.join(ROOT, m[1])), `${name}: ${m[1]}`);
    assert.doesNotMatch(cmd, /'/, `${name}: apostrofy cmd.exe neodstraní`);
  }
  assert.equal(pkg.scripts.test, 'node --disable-warning=ExperimentalWarning --test "test/**/*.test.js"');
  // přepínače, které by PowerShell (npm.ps1) u „npm run x -- --přepínač“ spolkl, mají vlastní skript
  assert.match(pkg.scripts['demo-clear'], /--clear$/);
  assert.match(pkg.scripts['run-export'], /--export$/);
});

test('README: npm skripty a soubory, na které odkazuje, existují', () => {
  const readme = read('README.md').toString();
  const pkg = JSON.parse(read('package.json'));
  const builtins = new Set(['install', 'test', 'start']);
  for (const m of readme.matchAll(/npm (?:run )?([\w-]+)/g)) {
    if (builtins.has(m[1]) || m[1] === 'run') continue;
    assert.ok(pkg.scripts[m[1]], `README zmiňuje neexistující „npm run ${m[1]}“`);
  }
  for (const f of ['start.cmd', 'stahnout.cmd', 'nastaveni-vzor.txt', 'docs/ARCHITEKTURA.md', 'tools/try-source.js']) {
    assert.ok(readme.includes(f), `README by měl zmínit ${f}`);
    assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  }
});
