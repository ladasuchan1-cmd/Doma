'use strict';
// Testy zápisu/čtení datových souborů (tools/lib/data-io.js) a kontrola konzistence vygenerovaných dat, pokud existují.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const io = require('../tools/lib/data-io.js');

test('serializeDataset / parseDataset – round-trip a tvar skriptu', () => {
  const text = io.serializeDataset('mista', [{ id: 'n1', nazev: 'Hotel; "U Lípy"' }]);
  assert.ok(text.startsWith('window.CSM_DATA = window.CSM_DATA || {};\n'));
  assert.ok(text.includes('window.CSM_DATA.mista = ['));
  assert.deepStrictEqual(io.parseDataset(text, 'mista'), [{ id: 'n1', nazev: 'Hotel; "U Lípy"' }]);
  assert.throws(() => io.parseDataset(text, 'jine'));
  assert.throws(() => io.serializeDataset('špatný-název', 1));
});

test('writeDataset / readDataset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-data-'));
  try {
    const file = io.writeDataset(dir, 'meta', { a: 1 });
    assert.ok(fs.existsSync(file));
    assert.deepStrictEqual(io.readDataset(dir, 'meta'), { a: 1 });
    assert.strictEqual(io.readDataset(dir, 'neni'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const DATA = path.join(__dirname, '..', 'data');
const hasData = fs.existsSync(path.join(DATA, 'mista.js'));

test('vygenerovaná data jsou konzistentní (přeskočeno bez data/)', { skip: !hasData }, () => {
  const hranice = io.readDataset(DATA, 'hranice');
  const mista = io.readDataset(DATA, 'mista');
  const trasy = io.readDataset(DATA, 'trasy');
  const ski = io.readDataset(DATA, 'ski');
  const meta = io.readDataset(DATA, 'meta');
  assert.strictEqual(hranice.kraje.features.length, 14);
  assert.strictEqual(hranice.okresy.features.length, 77); // 76 okresů + Praha
  const okresy = new Set(hranice.okresy.features.map((f) => f.properties.kod));
  const kraje = new Set(hranice.kraje.features.map((f) => f.properties.kod));
  for (const o of hranice.okresy.features) assert.ok(kraje.has(o.properties.kraj), 'okres bez kraje ' + o.properties.nazev);
  assert.ok(mista.length > 10000);
  const ids = new Set();
  for (const m of mista) {
    assert.ok(!ids.has(m.id), 'duplicitní id ' + m.id);
    ids.add(m.id);
    assert.ok(okresy.has(m.okres), 'místo mimo okres ' + m.id);
    assert.ok(kraje.has(m.kraj));
    assert.ok(m.lat > 48.5 && m.lat < 51.1 && m.lon > 12 && m.lon < 18.9, 'souřadnice mimo ČR ' + m.id);
    assert.ok(['ubytovani', 'pujcovna', 'infocentrum'].includes(m.skupina));
    assert.ok(Array.isArray(m.blizko.trasy) && Array.isArray(m.blizko.ski));
    for (const [, d] of m.blizko.trasy) assert.ok(d <= meta.okoli.trasyM);
  }
  const trasaIds = new Set(trasy.map((t) => t.id));
  const arealIds = new Set(ski.arealy.map((a) => a.id));
  for (const m of mista) {
    for (const [tid] of m.blizko.trasy) assert.ok(trasaIds.has(tid), 'neznámá trasa ' + tid);
    for (const [aid] of m.blizko.ski) assert.ok(arealIds.has(aid), 'neznámý areál ' + aid);
  }
  for (const t of trasy) {
    assert.ok(t.label && t.geom.length && t.bbox, 'trasa bez geometrie ' + t.id);
    assert.ok(['cyklotrasa', 'cyklostezka', 'mtb'].includes(t.druh));
  }
  for (const s of ski.sjezdovky) if (s.areal) assert.ok(arealIds.has(s.areal), 'sjezdovka s neznámým areálem ' + s.id);
  assert.strictEqual(meta.pocty.mista, mista.length);
  assert.strictEqual(meta.pocty.trasy, trasy.length);
  assert.strictEqual(meta.pocty.skiarealy, ski.arealy.length);
});
