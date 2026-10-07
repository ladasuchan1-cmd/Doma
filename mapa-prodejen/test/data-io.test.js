'use strict';
// Testy čtení a zápisu datových souborů data/<název>.js (window.MP_DATA).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const io = require('../tools/lib/data-io.js');

test('serializeDataset / parseDataset – round-trip a tvar skriptu', () => {
  const text = io.serializeDataset('mista', [{ id: 'n1', nazev: 'Hotel; "U Lípy"' }]);
  assert.ok(text.startsWith('window.MP_DATA = window.MP_DATA || {};\n'));
  assert.ok(text.includes('window.MP_DATA.mista = ['));
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
