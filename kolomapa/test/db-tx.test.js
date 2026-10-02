'use strict';
// tx(): vnořené transakce i na Node 22.13–22.15, kde node:sqlite ještě nemá db.isTransaction (engines: >= 22.13).
// Starší Node se simuluje proxy, která isTransaction skryje – test tak hlídá obě cesty na libovolné verzi.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb, tx } = require('../src/db');
const { upsertItem } = require('../src/pipeline');

/** DatabaseSync bez vlastnosti isTransaction (jako Node < 22.16). */
function withoutIsTransaction(db) {
  return new Proxy(db, {
    get(target, key) {
      if (key === 'isTransaction') return undefined;
      const v = Reflect.get(target, key);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

for (const [label, wrap] of [
  ['db.isTransaction k dispozici', (db) => db],
  ['bez db.isTransaction (Node < 22.16)', withoutIsTransaction],
]) {
  test(`tx: ${label} – samostatná, vnořená i v ručním BEGIN, rollback jen vnitřní části`, () => {
    const raw = openDb(':memory:');
    const db = wrap(raw);
    const ins = (k) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, '1');
    const keys = () => db.prepare("SELECT key FROM settings WHERE key LIKE 't%' ORDER BY key").all().map((r) => r.key);

    tx(db, () => ins('t1'));
    // vnořená transakce uvnitř tx()
    tx(db, () => {
      ins('t2');
      assert.throws(() => tx(db, () => (ins('t3'), assert.fail('boom'))), /boom/);
      tx(db, () => ins('t4'));
    });
    assert.deepEqual(keys(), ['t1', 't2', 't4']);

    // tx() uvnitř ručně zahájené transakce (tools/eval-pricing.js, testy)
    db.exec('BEGIN');
    tx(db, () => ins('t5'));
    assert.throws(() => tx(db, () => (ins('t6'), assert.fail('boom'))), /boom/);
    db.exec('COMMIT');
    assert.deepEqual(keys(), ['t1', 't2', 't4', 't5']);

    // upsertItem (vlastní tx) v ruční transakci
    db.exec('BEGIN');
    upsertItem(db, 'fake', { sourceId: '1', url: 'https://x.cz/1', title: 'Kolo 1', priceCzk: 9000 }, '2026-10-01T00:00:00Z');
    upsertItem(db, 'fake', { sourceId: '1', url: 'https://x.cz/1', title: 'Kolo 1', priceCzk: 8000 }, '2026-10-02T00:00:00Z');
    db.exec('COMMIT');
    assert.deepEqual(db.prepare('SELECT price_czk FROM price_history ORDER BY at').all().map((r) => r.price_czk), [9000, 8000]);

    // po chybě vnější tx() žádná transakce nezůstane otevřená
    assert.throws(() => tx(db, () => (ins('t7'), assert.fail('boom'))), /boom/);
    db.exec('BEGIN');
    db.exec('COMMIT');
    assert.deepEqual(keys(), ['t1', 't2', 't4', 't5']);

    // jiná chyba BEGIN (zavřená databáze) se nepřekryje
    raw.close();
    assert.throws(() => tx(db, () => assert.fail('nemá se spustit')), (e) => !/nemá se spustit|boom/.test(e.message));
  });
}
