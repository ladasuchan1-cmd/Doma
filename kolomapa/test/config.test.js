'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, parseSchedule } = require('../src/config');

test('výchozí konfigurace', () => {
  const c = loadConfig({});
  assert.equal(c.port, 8090);
  assert.equal(c.host, '127.0.0.1');
  // výchozí jen Bazoš (robots.txt Sbazaru zakazuje všem robotům, Aukro/Cyklobazar na vyžádání)
  assert.deepEqual(c.sources, ['bazos']);
  assert.deepEqual(c.schedule, { hour: 5, minute: 30 });
  assert.equal(c.ai.enabled, false);
  assert.equal(c.ai.model, 'claude-opus-5-5');
});

test('zdroje, plán, AI klíč', () => {
  assert.deepEqual(loadConfig({ KOLOMAPA_SOURCES: 'all' }).sources, ['bazos', 'sbazar', 'aukro', 'cyklobazar']);
  assert.deepEqual(loadConfig({ KOLOMAPA_SOURCES: 'aukro, bazos, nic' }).sources, ['bazos', 'aukro']);
  assert.equal(parseSchedule('off'), null);
  assert.deepEqual(parseSchedule('7:05'), { hour: 7, minute: 5 });
  assert.deepEqual(parseSchedule('25:00'), { hour: 5, minute: 30 });
  const c = loadConfig({ ANTHROPIC_API_KEY: 'sk-test', KOLOMAPA_AI_MAX_PER_RUN: '10' });
  assert.equal(c.ai.enabled, true);
  assert.equal(c.ai.maxPerRun, 10);
});

// ---------------------------------------------------------------------------------------------------------
// Provozní odolnost: srozumitelná varování, nastaveni.txt (Windows), verze Node.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../src/config');

test('neplatné hodnoty → výchozí + české varování (nic nespadne potichu)', () => {
  const c = loadConfig({ KOLOMAPA_PORT: 'abc', KOLOMAPA_SCHEDULE: '5h', KOLOMAPA_DELAY_MS: '-5', KOLOMAPA_RUN_ON_START: 'mozna', LOG_LEVEL: 'hlasite' });
  assert.equal(c.port, 8090);
  assert.deepEqual(c.schedule, { hour: 5, minute: 30 });
  assert.equal(c.delayMs, 1200);
  assert.equal(c.runOnStart, true);
  const all = c.warnings.join('\n');
  assert.match(all, /KOLOMAPA_PORT=„abc“ neplatí – čekám číslo portu/);
  assert.match(all, /KOLOMAPA_SCHEDULE=„5h“ neplatí – čekám čas HH:MM/);
  assert.match(all, /KOLOMAPA_DELAY_MS=„-5“ neplatí – čekám celé číslo od 0 do 60000/);
  assert.match(all, /KOLOMAPA_RUN_ON_START=„mozna“/);
  assert.match(all, /LOG_LEVEL=„hlasite“/);
  assert.deepEqual(loadConfig({}).warnings, []);
  assert.deepEqual(loadConfig({ KOLOMAPA_PORT: ' 8091 ', KOLOMAPA_MAX_DETAILS: '4 000', KOLOMAPA_SCHEDULE: 'off' }).warnings, []);
  assert.equal(loadConfig({ KOLOMAPA_MAX_DETAILS: '4 000' }).maxDetails, 4000);
});

test('plán: „5.30“ i „05:30:00“ jako čas; vypnutí', () => {
  assert.deepEqual(parseSchedule('5.30'), { hour: 5, minute: 30 });
  assert.deepEqual(parseSchedule('06:15:00'), { hour: 6, minute: 15 });
  assert.equal(parseSchedule('vypnuto'), null);
  assert.deepEqual(loadConfig({ KOLOMAPA_SCHEDULE: '4.45' }).schedule, { hour: 4, minute: 45 });
});

test('zdroje: diakritika, velká písmena a domény; překlep → varování, nic platného → výchozí zdroje', () => {
  assert.deepEqual(loadConfig({ KOLOMAPA_SOURCES: 'Bazoš; www.Sbazar.cz' }).sources, ['bazos', 'sbazar']);
  assert.deepEqual(loadConfig({ KOLOMAPA_SOURCES: 'Cyklobazar' }).sources, ['cyklobazar']);
  const typo = loadConfig({ KOLOMAPA_SOURCES: 'cyklobazr' });
  assert.deepEqual(typo.sources, ['bazos']); // dřív [] → každý běh „Žádný ze zdrojů nejde načíst“
  assert.match(typo.warnings.join('\n'), /neznám „cyklobazr“.*Stahuji z: bazos/);
  const mixed = loadConfig({ KOLOMAPA_SOURCES: 'aukro, bazos, nic' });
  assert.deepEqual(mixed.sources, ['bazos', 'aukro']);
  assert.match(mixed.warnings[0], /„nic“/);
  assert.deepEqual(loadConfig({ KOLOMAPA_SOURCES: 'vše' }).warnings, []);
});

test('marže při výkupu: 0.35, „0,35“, „35“ i „35 %“; nesmysl → varování', () => {
  for (const v of ['0.35', '0,35', '35', '35 %', '35%']) assert.equal(loadConfig({ KOLOMAPA_BUY_MARGIN: v }).buyMargin, 0.35, v);
  const bad = loadConfig({ KOLOMAPA_BUY_MARGIN: '120 %' });
  assert.equal(bad.buyMargin, null);
  assert.match(bad.warnings[0], /KOLOMAPA_BUY_MARGIN/);
});

test('relativní cesty (KOLOMAPA_DB …) vůči složce kolomapa – Plánovač úloh startuje v C:\\Windows\\System32', () => {
  const c = loadConfig({ KOLOMAPA_DB: 'data/demo.db', KOLOMAPA_STATIC_DIR: 'verejne' });
  assert.equal(c.dbFile, path.join(C.PROJECT_DIR, 'data', 'demo.db'));
  assert.equal(c.staticDir, path.join(C.PROJECT_DIR, 'verejne'));
  assert.equal(loadConfig({ KOLOMAPA_DB: ':memory:' }).dbFile, ':memory:');
});

test('nastaveni.txt: komentáře, „set“, uvozovky, malá písmena, překlepy, nesmysly', () => {
  const { values, warnings } = C.parseSettings(
    [
      '\uFEFF# komentář',
      'rem taky komentář',
      'set KOLOMAPA_PORT=8091',
      'kolomapa_schedule = 6.15',
      'KOLOMAPA_PASSWORD="tajné heslo s # a = "',
      'KOLOMAPA_SOURCE=bazos',
      'NODE_OPTIONS=--inspect',
      'tohle není nastavení',
      '',
    ].join('\r\n')
  );
  assert.deepEqual(values, { KOLOMAPA_PORT: '8091', KOLOMAPA_SCHEDULE: '6.15', KOLOMAPA_PASSWORD: 'tajné heslo s # a = ', KOLOMAPA_SOURCE: 'bazos' });
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /řádek 6: neznámé nastavení KOLOMAPA_SOURCE – není to překlep/);
  assert.match(warnings[1], /řádek 7: NODE_OPTIONS není nastavení Kolomapy/);
  assert.match(warnings[2], /řádek 8: nerozumím/);
});

test('nastaveni.txt: Poznámkový blok – UTF-8 s BOM, ANSI (windows-1250) i UTF-16', () => {
  const text = 'KOLOMAPA_PASSWORD=žluťoučký kůň\r\n';
  assert.equal(C.decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])), text);
  const cp1250 = Buffer.from([...Buffer.from('KOLOMAPA_PASSWORD='), 0x9e, 0x6c, 0x75, 0x9d, 0x6f, 0x75, 0xe8, 0x6b, 0xfd, 0x20, 0x6b, 0xf9, 0xf2, 0x0d, 0x0a]);
  assert.equal(C.decodeText(cp1250), text);
  assert.equal(C.decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])), text);
});

test('applySettingsFile: hodnoty jdou do env, skutečné proměnné prostředí mají přednost; „off“ vypne', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolomapa-nastaveni-'));
  try {
    const file = path.join(dir, 'nastaveni.txt');
    fs.writeFileSync(file, 'KOLOMAPA_PORT=8091\nKOLOMAPA_SOURCES=all\nKOLOMAPA_HOST=0.0.0.0\n');
    const env = { KOLOMAPA_PORT: '9000', KOLOMAPA_HOST: '' };
    const r = C.applySettingsFile({ file, env });
    assert.equal(r.file, file);
    assert.deepEqual(r.applied.sort(), ['KOLOMAPA_HOST', 'KOLOMAPA_SOURCES']);
    assert.equal(env.KOLOMAPA_PORT, '9000');
    assert.equal(env.KOLOMAPA_SOURCES, 'all');
    assert.equal(loadConfig(env).port, 9000);
    assert.deepEqual(C.applySettingsFile({ file: 'off', env: {} }), { file: null, applied: [], warnings: [] });
    // chybějící soubor není chyba
    assert.deepEqual(C.applySettingsFile({ file: path.join(dir, 'neni.txt'), env: {} }).applied, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applySettingsFile: „nastaveni.txt.txt“ (skryté přípony ve Windows) → rada, ne tiché ignorování', (t) => {
  if (fs.existsSync(C.DEFAULT_SETTINGS_FILE)) return t.skip('v projektu leží skutečný nastaveni.txt');
  const twin = `${C.DEFAULT_SETTINGS_FILE}.txt`;
  if (fs.existsSync(twin)) return t.skip('v projektu leží nastaveni.txt.txt');
  fs.writeFileSync(twin, 'KOLOMAPA_PORT=8091\n');
  try {
    const r = C.applySettingsFile({ file: null, env: {} });
    assert.deepEqual(r.applied, []);
    assert.match(r.warnings[0], /přejmenujte ho na „nastaveni.txt“/);
  } finally {
    fs.unlinkSync(twin);
  }
});

test('vzor nastaveni-vzor.txt je celý zakomentovaný a zná jen platné klíče', () => {
  const text = C.decodeText(fs.readFileSync(path.join(C.PROJECT_DIR, 'nastaveni-vzor.txt')));
  assert.deepEqual(C.parseSettings(text), { values: {}, warnings: [] });
  const keys = [...text.matchAll(/^#([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 8);
  for (const k of keys) assert.ok(C.KNOWN_KEYS.has(k), k);
  // po odkomentování všech řádků žádné varování (hodnoty ve vzoru jsou platné)
  const uncommented = text.replace(/^#([A-Z_][A-Z0-9_]*=)/gm, '$1');
  const parsed = C.parseSettings(uncommented);
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(loadConfig(parsed.values).warnings, []);
});

test('KNOWN_KEYS pokrývá všechny proměnné KOLOMAPA_*, které kód čte', () => {
  const files = [path.join(C.PROJECT_DIR, 'server.js')];
  for (const d of ['src', 'tools']) {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.name.endsWith('.js')) files.push(f);
      }
    };
    walk(path.join(C.PROJECT_DIR, d));
  }
  const used = new Set();
  for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(/\b(KOLOMAPA_[A-Z0-9_]+)\b/g)) used.add(m[1]);
  used.delete('KOLOMAPA_SETTINGS_FILE'); // řídí samotné načtení souboru, v něm nemá smysl
  for (const k of used) assert.ok(C.KNOWN_KEYS.has(k), `${k} chybí v KNOWN_KEYS (src/config.js)`);
});

test('verze Node.js: srozumitelná česká hláška místo „No such built-in module: node:sqlite“', () => {
  assert.equal(C.nodeVersionProblem('22.13.0'), null);
  assert.equal(C.nodeVersionProblem('24.9.0'), null);
  assert.equal(C.nodeVersionProblem('23.4.0'), null);
  assert.match(C.nodeVersionProblem('22.12.0'), /potřebuje Node.js 22.13 nebo novější – tento počítač má 22.12.0.*nodejs.org/);
  assert.match(C.nodeVersionProblem('20.18.1'), /20.18.1/);
  assert.ok(C.nodeVersionProblem('23.3.0'));
});

test('varování „SQLite is an experimental feature“ se nevypisuje, jiná varování ano', () => {
  const seen = [];
  const onWarning = (w) => seen.push(w.message);
  process.on('warning', onWarning);
  try {
    process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
    process.emitWarning('jiné varování kolomapy', 'Warning');
  } finally {
    // varování se doručují asynchronně (process.nextTick)
  }
  return new Promise((resolve) =>
    setImmediate(() => {
      process.removeListener('warning', onWarning);
      assert.deepEqual(seen, ['jiné varování kolomapy']);
      resolve();
    })
  );
});
