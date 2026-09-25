'use strict';
// Testy formátovacích pomocníků UI (public/lib/format.js).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'lib', 'format.js')).href);
const norm = (s) => String(s).replace(/[  ]/g, ' ').replace(/−/g, '-');

test('money: česká notace s Kč a pevnou mezerou', async () => {
  const f = await load();
  assert.strictEqual(norm(f.money(12990)), '12 990 Kč');
  assert.ok(f.money(12990).includes(' '), 'oddělovač tisíců je pevná mezera');
  assert.strictEqual(norm(f.money(1234.5)), '1 234,50 Kč');
  assert.strictEqual(norm(f.money(1234.5, { decimals: 0 })), '1 235 Kč');
  assert.strictEqual(norm(f.money(-1500)), '-1 500 Kč');
  assert.strictEqual(f.money(null), '–');
  assert.strictEqual(f.money('abc'), '–');
  assert.strictEqual(norm(f.money('12990')), '12 990 Kč');
});

test('percent, signedPercent, index', async () => {
  const f = await load();
  assert.strictEqual(norm(f.percent(12.5)), '12,5 %');
  assert.strictEqual(norm(f.percent(12)), '12,0 %');
  assert.strictEqual(norm(f.signedPercent(3.24)), '+3,2 %');
  assert.strictEqual(norm(f.signedPercent(-3.24)), '-3,2 %');
  assert.ok(f.signedPercent(-3.24).startsWith('−'), 'typografické mínus');
  assert.strictEqual(norm(f.signedPercent(0.01)), '0,0 %');
  assert.strictEqual(norm(f.index(103.44)), '103,4');
  assert.strictEqual(f.percent(undefined), '–');
});

test('changeInfo: šipka, znaménko a CSS třída', async () => {
  const f = await load();
  const up = f.changeInfo(5.26);
  assert.strictEqual(up.dir, 'up');
  assert.strictEqual(up.cls, 'chg-up');
  assert.strictEqual(norm(up.text), '▲ +5,3 %');
  const down = f.changeInfo(-10);
  assert.strictEqual(down.cls, 'chg-down');
  assert.strictEqual(norm(down.text), '▼ -10,0 %');
  assert.strictEqual(f.changeInfo(0).dir, 'zero');
  assert.strictEqual(f.changeInfo(null).dir, 'none');
  assert.strictEqual(norm(f.changeInfo(-500, { kind: 'abs' }).text), '▼ -500 Kč');
});

test('relTime: česká relativní doba', async () => {
  const f = await load();
  const now = Date.parse('2026-09-25T12:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.strictEqual(f.relTime(ago(10000), now), 'právě teď');
  assert.strictEqual(norm(f.relTime(ago(5 * 60000), now)), 'před 5 min');
  assert.strictEqual(norm(f.relTime(ago(3 * 3600000), now)), 'před 3 h');
  assert.strictEqual(f.relTime(ago(26 * 3600000), now), 'včera');
  assert.strictEqual(norm(f.relTime(ago(4 * 86400000), now)), 'před 4 dny');
  assert.strictEqual(norm(f.relTime(ago(62 * 86400000), now)), 'před 2 měsíci');
  assert.strictEqual(f.relTime(ago(400 * 86400000), now), 'před rokem');
  assert.strictEqual(norm(f.relTime(new Date(now + 2 * 3600000).toISOString(), now)), 'za 2 h');
  assert.strictEqual(f.relTime('nesmysl', now), '–');
});

test('plural / count', async () => {
  const f = await load();
  assert.strictEqual(f.plural(1, 'produkt', 'produkty', 'produktů'), 'produkt');
  assert.strictEqual(f.plural(3, 'produkt', 'produkty', 'produktů'), 'produkty');
  assert.strictEqual(f.plural(5, 'produkt', 'produkty', 'produktů'), 'produktů');
  assert.strictEqual(f.plural(0, 'produkt', 'produkty', 'produktů'), 'produktů');
  assert.strictEqual(norm(f.count(1234, 'návrh', 'návrhy', 'návrhů')), '1 234 návrhů');
});

test('popisky pozic, příznaků (SPEC §6.7) a důvodů přeskočení', async () => {
  const f = await load();
  assert.strictEqual(f.positionLabel('cheapest'), 'Nejlevnější');
  assert.strictEqual(f.positionLabel('middle'), 'Uprostřed');
  assert.strictEqual(f.positionLabel('most_expensive'), 'Nejdražší');
  assert.strictEqual(f.positionLabel('no_data'), 'Bez dat');
  for (const flag of ['fallback', 'change_limited', 'ceiling', 'floor', 'limits_conflict', 'floor_over_change_limit', 'no_cost', 'below_cost', 'big_change']) {
    assert.ok(f.FLAG_LABELS[flag], 'chybí popisek příznaku ' + flag);
    assert.ok(f.FLAG_HELP[flag], 'chybí nápověda příznaku ' + flag);
    assert.ok(f.FLAG_SEVERITY[flag], 'chybí závažnost příznaku ' + flag);
  }
  for (const r of ['locked', 'zero_stock', 'no_msrp', 'no_cost', 'no_market', 'no_price', 'below_threshold']) {
    assert.ok(f.REASON_LABELS[r], 'chybí popisek důvodu ' + r);
  }
  for (const r of ['disabled', 'excluded', 'not_included', 'tag', 'out_of_stock', 'stale', 'outlier']) {
    assert.ok(f.EXCLUDED_LABELS[r], 'chybí popisek vyřazení ' + r);
  }
  assert.strictEqual(f.flagLabel('neznamy'), 'neznamy');
  assert.strictEqual(f.statusLabel('approved'), 'Schváleno');
});

test('parseInputNumber: české vstupy', async () => {
  const f = await load();
  assert.strictEqual(f.parseInputNumber('12 990'), 12990);
  assert.strictEqual(f.parseInputNumber('12,5'), 12.5);
  assert.strictEqual(f.parseInputNumber('-2'), -2);
  assert.strictEqual(f.parseInputNumber('−2,5'), -2.5);
  assert.strictEqual(f.parseInputNumber('12.990,50'), 12990.5);
  assert.strictEqual(f.parseInputNumber('1 290 Kč'), 1290);
  assert.strictEqual(f.parseInputNumber(''), null);
  assert.ok(Number.isNaN(f.parseInputNumber('abc')));
});

test('availability, bytes, duration, truncate, fold', async () => {
  const f = await load();
  assert.strictEqual(f.availability(1, 0), 'Skladem');
  assert.strictEqual(norm(f.availability(0, 3)), 'Do 3 dnů');
  assert.strictEqual(f.availability(0, null), 'Není skladem');
  assert.strictEqual(f.availability(null, null), 'Neznámo');
  assert.strictEqual(norm(f.bytes(2048)), '2,0 kB');
  assert.strictEqual(norm(f.duration(350)), '350 ms');
  assert.strictEqual(norm(f.duration(1500)), '1,5 s');
  assert.strictEqual(f.truncate('abcdef', 4), 'abc…');
  assert.strictEqual(f.fold('Žluťoučký KŮŇ'), 'zlutoucky kun');
});
