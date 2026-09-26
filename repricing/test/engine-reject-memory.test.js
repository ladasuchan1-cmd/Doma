'use strict';
// Paměť zamítnutí (C1): stejnou cenu (±0,5 Kč), kterou člověk zamítl v posledních reject_memory_days dnech,
// přecenění znovu nenavrhne – rozhodnutí je „beze změny“ s důvodem rejected_before.

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./engine-helpers');
const { setSetting, getSettings, DEFAULT_SETTINGS } = require('../src/db');
const { runPricing, explainProduct } = require('../src/engine/run');
const { REASON_LABELS } = require('../src/engine/pricing');

const DAY = 86400000;
const ago = (days) => new Date(Date.parse(H.NOW) - days * DAY).toISOString();

/** Produkt 79 990, trh 80 000 → strategie navrhne 78 990 (bez automatického schválení). */
function setup({ auto = false } = {}) {
  const db = H.createDb();
  const c = H.insertCompetitor(db, { name: 'VeloMarket.cz' });
  const id = H.insertProduct(db, { code: 'P1', price: 79990, purchase_price: 50000, msrp: 84990 });
  H.insertOffer(db, id, c, 80000);
  H.insertStrategy(db, {
    name: 'Podstřel',
    config: { target: { mode: 'undercut_min', offset_pct: -1 }, limits: { min_margin_pct: 5, max_above_msrp_pct: 0 }, approval: { auto, auto_max_change_pct: 5 } },
  });
  return { db, id, c };
}

function reject(db, { daysAgo = 1, manual = null, id = null } = {}) {
  const row = id ? db.prepare('SELECT id FROM proposals WHERE id = ?').get(id) : db.prepare("SELECT id FROM proposals WHERE status IN ('pending', 'approved') ORDER BY id DESC").get();
  db.prepare("UPDATE proposals SET status = 'rejected', decided_at = ?, decided_by = 'jana', manual_price = ? WHERE id = ?").run(ago(daysAgo), manual, row.id);
  return row.id;
}

const count = (db, status) => db.prepare('SELECT count(*) AS c FROM proposals WHERE status = ?').get(status).c;

test('C1 nastavení: reject_memory_days výchozí 14 dní; popisek důvodu', () => {
  assert.equal(DEFAULT_SETTINGS.reject_memory_days, 14);
  assert.equal(getSettings(H.createDb()).reject_memory_days, 14);
  assert.equal(REASON_LABELS.rejected_before, 'stejná cena byla nedávno zamítnuta');
});

test('C1: nedávno zamítnutá stejná cena se znovu nenavrhne (no_change rejected_before)', () => {
  const { db, id } = setup();
  const r1 = runPricing(db, { now: H.NOW });
  assert.equal(r1.stats.changes, 1);
  assert.equal(db.prepare('SELECT new_price FROM proposals').get().new_price, 78990);
  reject(db, { daysAgo: 3 });

  const r2 = runPricing(db, { now: H.NOW });
  assert.equal(r2.stats.changes, 0);
  assert.equal(r2.stats.no_change, 1);
  assert.deepEqual(r2.stats.no_change_reasons, { rejected_before: 1 });
  assert.equal(count(db, 'pending'), 0, 'žádný nový návrh');
  assert.equal(db.prepare('SELECT count(*) AS c FROM proposals').get().c, 1);

  // vysvětlení v detailu produktu
  const ex = explainProduct(db, id, { now: H.NOW });
  assert.equal(ex.decision.action, 'no_change');
  assert.equal(ex.decision.reason, 'rejected_before');
  assert.equal(ex.decision.new_price, 79990);
  assert.equal(ex.decision.change_pct, 0);
  assert.equal(ex.decision.auto_approve, false);
  const step = ex.decision.explain.find((s) => s.step === 'rejected');
  assert.ok(step);
  assert.match(step.text, /Stejnou cenu 78\s990 Kč někdo .* zamítl \(paměť zamítnutí 14 dní\)/);

  // zkušební běh počítá stejně
  const dry = runPricing(db, { now: H.NOW, dryRun: true });
  assert.equal(dry.stats.no_change_reasons.rejected_before, 1);
  assert.equal(dry.decisions[0].reason, 'rejected_before');
});

test('C1: jiná cena, zamítnutí mimo okno nebo vypnutá paměť → návrh vznikne', () => {
  {
    // zamítnuto před 20 dny, paměť 14 dní → nový návrh
    const { db } = setup();
    runPricing(db, { now: H.NOW });
    reject(db, { daysAgo: 20 });
    const r = runPricing(db, { now: H.NOW });
    assert.equal(r.stats.changes, 1);
    assert.equal(count(db, 'pending'), 1);
  }
  {
    // paměť prodloužená na 30 dní → stejné zamítnutí (20 dní) už platí
    const { db } = setup();
    runPricing(db, { now: H.NOW });
    reject(db, { daysAgo: 20 });
    setSetting(db, 'reject_memory_days', 30);
    assert.equal(runPricing(db, { now: H.NOW }).stats.no_change_reasons.rejected_before, 1);
  }
  {
    // 0 = vypnuto
    const { db } = setup();
    runPricing(db, { now: H.NOW });
    reject(db, { daysAgo: 1 });
    setSetting(db, 'reject_memory_days', 0);
    const r = runPricing(db, { now: H.NOW });
    assert.equal(r.stats.changes, 1);
    assert.equal(r.stats.no_change_reasons.rejected_before, undefined);
  }
  {
    // trh se pohnul → nová cena (77 990) se liší od zamítnuté (78 990) → návrh vznikne
    const { db, id } = setup();
    runPricing(db, { now: H.NOW });
    reject(db, { daysAgo: 1 });
    db.prepare('UPDATE offers SET price = 79000 WHERE product_id = ?').run(id);
    const r = runPricing(db, { now: H.NOW });
    assert.equal(r.stats.changes, 1);
    assert.equal(db.prepare("SELECT new_price FROM proposals WHERE status = 'pending'").get().new_price, 77990);
  }
});

test('C1: rozhoduje NEJNOVĚJŠÍ zamítnutí a jeho cena k exportu (manual_price ?? new_price)', () => {
  {
    // zamítnutá ruční cena 78 990 (navrženo bylo něco jiného) → stejná cena se znovu nenavrhne
    const { db } = setup();
    runPricing(db, { now: H.NOW });
    const pid = db.prepare('SELECT id FROM proposals').get().id;
    db.prepare('UPDATE proposals SET new_price = 77000 WHERE id = ?').run(pid);
    reject(db, { daysAgo: 2, manual: 78990.3 });
    assert.equal(runPricing(db, { now: H.NOW }).stats.no_change_reasons.rejected_before, 1, 'rozdíl < 0,5 Kč');
  }
  {
    // starší zamítnutí 78 990, novější zamítnutí jiné ceny → poslední rozhodnutí se týká jiné ceny → návrh vznikne
    const { db, id } = setup();
    runPricing(db, { now: H.NOW });
    const older = reject(db, { daysAgo: 5 });
    const newer = Number(
      db
        .prepare(
          "INSERT INTO proposals (run_id, product_id, old_price, new_price, status, flags, explain, created_at, decided_at, decided_by) VALUES ((SELECT MAX(id) FROM runs), ?, 79990, 76990, 'rejected', '[]', '[]', ?, ?, 'petr')"
        )
        .run(id, ago(2), ago(2)).lastInsertRowid
    );
    assert.ok(newer > older);
    const r = runPricing(db, { now: H.NOW });
    assert.equal(r.stats.changes, 1);
    assert.equal(r.stats.no_change_reasons.rejected_before, undefined);
  }
});

test('C1: platí i pro automaticky schvalované strategie – zamítnutá cena se neschválí ani nevloží', () => {
  const { db } = setup({ auto: true });
  runPricing(db, { now: H.NOW });
  assert.equal(count(db, 'approved'), 1);
  reject(db, { daysAgo: 1 });
  const r = runPricing(db, { now: H.NOW });
  assert.equal(r.stats.auto_approved, 0);
  assert.equal(r.stats.no_change_reasons.rejected_before, 1);
  assert.equal(count(db, 'approved'), 0);
  assert.equal(count(db, 'pending'), 0);
});
