'use strict';
// tools/demo-data.js – ukázková data se nesmí přimíchat do databáze se skutečnými inzeráty (učení modelu, export).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { upsertItem } = require('../src/pipeline');
const { main, realListingCount, seedDemo } = require('../tools/demo-data');

function quiet(fn) {
  const out = [];
  const keep = [console.log, console.error];
  console.log = console.error = (...a) => out.push(a.join(' '));
  try {
    return { code: fn(), out: out.join('\n') };
  } finally {
    [console.log, console.error] = keep;
  }
}

test('demo: do DB se skutečnými inzeráty jen s --force; do prázdné / demo DB ano; --clear', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolomapa-demo-'));
  try {
    const real = path.join(dir, 'kolomapa.db');
    const db = openDb(real);
    upsertItem(db, 'bazos', { sourceId: '1', url: 'https://sport.bazos.cz/inzerat/1/', title: 'Kolo Author', priceCzk: 5000 }, new Date().toISOString());
    seedDemo(db, { count: 14, seed: 1 });
    assert.equal(realListingCount(db), 1);
    db.close();

    const refused = quiet(() => main([`--db=${real}`, '--count=14']));
    assert.equal(refused.code, 1);
    assert.match(refused.out, /už obsahuje 1 skutečných inzerátů – ukázková data do ní nevložím/);
    assert.match(refused.out, /--db=data\/demo\.db/);
    assert.equal(quiet(() => main([`--db=${real}`, '--count=14', '--force'])).code, 0);

    const demoDb = path.join(dir, 'demo.db');
    assert.equal(quiet(() => main([`--db=${demoDb}`, '--count=14'])).code, 0);
    assert.equal(quiet(() => main([`--db=${demoDb}`, '--count=14'])).code, 0, 'demo do demo DB lze opakovat');
    const cleared = quiet(() => main([`--db=${demoDb}`, '--clear']));
    assert.equal(cleared.code, 0);
    assert.match(cleared.out, /Smazáno 14 demo inzerátů/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
