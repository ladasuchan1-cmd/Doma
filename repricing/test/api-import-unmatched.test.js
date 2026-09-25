'use strict';
// Integrační testy API nespárovaných nabídek: výpis s filtry a stránkováním, ruční spárování, zahození.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, example } = require('./api-import-helpers');

const OFFERS = [
  { competitor: 'Cyklo Žluťoučký.cz', ean: '8599999999999', name: 'Kolo Žluťoučké 29"', price: 15990, url: 'https://zlutoucky.example/kolo' },
  { competitor: 'Cyklo Žluťoučký.cz', mpn: 'ABC-123', name: 'Sedlo Pohodlné', price: 990 },
  { competitor: 'Jiný Obchod.cz', ean: '8590000000017', name: 'Duplikátní zboží', price: 500 },
  { competitor: 'Jiný Obchod.cz', ext_id: 'X-77', name: 'Přilba Rychlá', price: 1200 },
];

describe('API nespárovaných nabídek', () => {
  let s;
  let tRead;
  let tImport;
  let tExport;
  const pid = (code) => s.db.prepare('SELECT id FROM products WHERE code = ?').get(code).id;

  before(async () => {
    s = await startServer();
    tRead = await s.token(['read']);
    tImport = await s.token(['import']);
    tExport = await s.token(['export']);
    let r = await s.call('POST', '/api/v1/import/products', { as: tImport, body: example('katalog.csv'), type: 'text/csv' });
    assert.equal(r.status, 200, r.text);
    // dva produkty se stejným EAN → nabídka s tímto EAN je nejednoznačná
    r = await s.call('POST', '/api/v1/import/products', {
      as: tImport,
      json: [
        { code: 'DUP-A', ean: '8590000000017', name: 'Duplikát A' },
        { code: 'DUP-B', ean: '8590000000017', name: 'Duplikát B' },
      ],
    });
    assert.equal(r.status, 200, r.text);
    r = await s.call('POST', '/api/v1/import/offers', { as: tImport, json: OFFERS });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.stats.unmatched, 3);
    assert.equal(r.data.stats.ambiguous, 1);
  });
  after(() => s && s.stop());

  it('výpis: konkurent, důvod, kandidáti, raw, počty', async () => {
    const r = await s.call('GET', '/api/v1/unmatched', { as: tRead });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.total, 4);
    assert.equal(r.data.page, 1);
    assert.equal(r.data.limit, 50);
    assert.equal(r.data.items.length, 4);
    const kolo = r.data.items.find((i) => i.ean === '8599999999999');
    assert.equal(kolo.competitor, 'Cyklo Žluťoučký.cz');
    assert.ok(Number.isInteger(kolo.competitor_id));
    assert.equal(kolo.name, 'Kolo Žluťoučké 29"');
    assert.equal(kolo.price, 15990);
    assert.equal(kolo.url, 'https://zlutoucky.example/kolo');
    assert.equal(kolo.match_key, 'ean:8599999999999');
    assert.equal(kolo.seen_count, 1);
    assert.ok(kolo.first_seen_at && kolo.last_seen_at);
    assert.equal(kolo.reason, 'not_found');
    assert.deepEqual(kolo.candidates, []);
    assert.equal(kolo.raw._reason, 'not_found');
    assert.equal(kolo.raw.competitor, 'Cyklo Žluťoučký.cz');
    const dup = r.data.items.find((i) => i.ean === '8590000000017');
    assert.equal(dup.reason, 'ambiguous');
    assert.deepEqual(dup.candidates.map((c) => c.code).sort(), ['DUP-A', 'DUP-B']);
    assert.ok(dup.candidates.every((c) => Number.isInteger(c.id) && c.name && c.active === true));
    assert.equal(dup.raw._candidates.length, 2);
    // opakovaný import zvýší seen_count
    const again = await s.call('POST', '/api/v1/import/offers', { as: tImport, json: OFFERS });
    assert.equal(again.status, 200);
    const r2 = await s.call('GET', '/api/v1/unmatched', { as: tRead });
    assert.ok(r2.data.items.every((i) => i.seen_count === 2));
    assert.equal(r2.data.total, 4);
  });

  it('filtry: konkurent (id i název), hledání bez diakritiky, důvod; stránkování a řazení', async () => {
    const get = async (qs) => {
      const r = await s.call('GET', `/api/v1/unmatched?${qs}`, { as: tRead });
      assert.equal(r.status, 200, `${qs}: ${r.text}`);
      return r.data;
    };
    const cid = s.db.prepare("SELECT id FROM competitors WHERE name = 'Jiný Obchod.cz'").get().id;
    assert.equal((await get(`competitor=${cid}`)).total, 2);
    assert.equal((await get(`competitor=${encodeURIComponent('Jiný Obchod.cz')}`)).total, 2);
    assert.equal((await get(`competitor=${encodeURIComponent('jiný obchod.cz')}`)).total, 2);
    assert.equal((await get('competitor=neexistuje.cz')).total, 0);
    // hledání v názvu bez ohledu na diakritiku a velikost písmen
    let d = await get('q=zlutouck');
    assert.equal(d.total, 1);
    assert.equal(d.items[0].ean, '8599999999999');
    assert.equal((await get(`q=${encodeURIComponent('ŽLUŤ')}`)).total, 1);
    assert.equal((await get('q=8599999')).total, 1);
    assert.equal((await get('q=abc-123')).total, 1);
    assert.equal((await get('q=x-77')).total, 1);
    assert.equal((await get('q=100%25')).total, 0, 'znak % se hledá doslova');
    assert.equal((await get(`q=prilba&competitor=${cid}`)).total, 1);
    d = await get('reason=ambiguous');
    assert.equal(d.total, 1);
    assert.equal(d.items[0].reason, 'ambiguous');
    assert.equal((await get('reason=not_found')).total, 3);
    // stránkování
    d = await get('limit=1&page=2&sort=price&dir=asc');
    assert.equal(d.total, 4);
    assert.equal(d.page, 2);
    assert.equal(d.limit, 1);
    assert.equal(d.items.length, 1);
    assert.equal(d.items[0].price, 990);
    d = await get('sort=price');
    assert.deepEqual(
      d.items.map((i) => i.price),
      [15990, 1200, 990, 500]
    );
    d = await get('sort=name');
    assert.equal(d.items[0].name, 'Duplikátní zboží');
    // neplatné parametry
    for (const qs of ['reason=nevim', 'sort=hodnota', 'dir=nahoru', 'limit=abc']) {
      const r = await s.call('GET', `/api/v1/unmatched?${qs}`, { as: tRead });
      assert.equal(r.status, 400, qs);
    }
  });

  it('oprávnění', async () => {
    assert.equal((await s.call('GET', '/api/v1/unmatched', { as: 'none' })).status, 401);
    assert.equal((await s.call('GET', '/api/v1/unmatched', { as: tExport })).status, 403);
    assert.equal((await s.call('GET', '/api/v1/unmatched', { as: tImport })).status, 403);
    const id = s.db.prepare('SELECT id FROM unmatched_offers LIMIT 1').get().id;
    for (const as of [tRead, tImport]) {
      assert.equal((await s.call('POST', `/api/v1/unmatched/${id}/match`, { as, json: { product_id: pid('SRA-00007') } })).status, 403);
      assert.equal((await s.call('DELETE', `/api/v1/unmatched/${id}`, { as })).status, 403);
    }
    assert.equal((await s.call('DELETE', `/api/v1/unmatched/${id}`, { as: 'session-nocsrf' })).status, 403);
    assert.equal(Number(s.db.prepare('SELECT COUNT(*) AS n FROM unmatched_offers').get().n), 4);
  });

  it('ruční spárování vytvoří alias, nabídku a příští import ji spáruje sám', async () => {
    const u = s.db.prepare("SELECT id, competitor_id FROM unmatched_offers WHERE ean = '8599999999999'").get();
    const target = pid('SRA-00007');
    const r = await s.call('POST', `/api/v1/unmatched/${u.id}/match`, { json: { product_id: target } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.product_id, target);
    assert.deepEqual(r.data.alias, { kind: 'ean', value_key: '8599999999999', competitor_id: u.competitor_id });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM unmatched_offers WHERE id = ?').get(u.id).n, 0);
    const off = s.db.prepare('SELECT * FROM offers WHERE product_id = ? AND competitor_id = ?').get(target, u.competitor_id);
    assert.ok(off, 'nabídka po spárování existuje');
    assert.equal(off.price, 15990);
    // další import stejné nabídky se spáruje přes alias
    const again = await s.call('POST', '/api/v1/import/offers', { as: tImport, json: [OFFERS[0]] });
    assert.equal(again.status, 200);
    assert.equal(again.data.stats.matched, 1);
    assert.equal(again.data.stats.unmatched, 0);
    // audit
    assert.ok(s.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'unmatched.match'").get().n >= 1);
  });

  it('spárování nejednoznačné nabídky podle kódu produktu a druhu aliasu', async () => {
    const u = s.db.prepare("SELECT id FROM unmatched_offers WHERE ean = '8590000000017'").get();
    const r = await s.call('POST', `/api/v1/unmatched/${u.id}/match`, { json: { code: ' dup-b ', kind: 'name' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.product_id, pid('DUP-B'));
    assert.equal(r.data.alias.kind, 'name');
    const list = await s.call('GET', '/api/v1/unmatched?reason=ambiguous');
    assert.equal(list.data.total, 0);
  });

  it('chyby spárování', async () => {
    const u = s.db.prepare("SELECT id FROM unmatched_offers WHERE ext_id = 'X-77'").get();
    const cases = [
      [`/api/v1/unmatched/999999/match`, { product_id: pid('SRA-00007') }, 404, /nebyla nalezena/],
      [`/api/v1/unmatched/${u.id}/match`, { product_id: 999999 }, 404, /Produkt nebyl nalezen/],
      [`/api/v1/unmatched/${u.id}/match`, { code: 'NENI-TAKOVY' }, 404, /NENI-TAKOVY/],
      [`/api/v1/unmatched/${u.id}/match`, {}, 400, /product_id/],
      [`/api/v1/unmatched/${u.id}/match`, { product_id: 'abc' }, 400, /product_id/],
      [`/api/v1/unmatched/${u.id}/match`, { product_id: -1 }, 400, /product_id/],
      [`/api/v1/unmatched/${u.id}/match`, { product_id: pid('SRA-00007'), kind: 'barva' }, 400, /kind/],
      [`/api/v1/unmatched/${u.id}/match`, { product_id: pid('SRA-00007'), kind: 'ean' }, 400, /ean/],
      [`/api/v1/unmatched/abc/match`, { product_id: 1 }, 400, /id/],
    ];
    for (const [p, body, status, re] of cases) {
      const r = await s.call('POST', p, { json: body });
      assert.equal(r.status, status, `${p} ${JSON.stringify(body)}: ${r.text}`);
      assert.match(r.data.error.message, re);
    }
    const arr = await s.call('POST', `/api/v1/unmatched/${u.id}/match`, { json: [1] });
    assert.equal(arr.status, 400);
    // nic se nespárovalo
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM unmatched_offers WHERE id = ?').get(u.id).n, 1);
  });

  it('zahození nespárované nabídky', async () => {
    const u = s.db.prepare("SELECT id FROM unmatched_offers WHERE ext_id = 'X-77'").get();
    const r = await s.call('DELETE', `/api/v1/unmatched/${u.id}`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.data, { ok: true });
    assert.equal((await s.call('DELETE', `/api/v1/unmatched/${u.id}`)).status, 404);
    assert.equal((await s.call('DELETE', '/api/v1/unmatched/abc')).status, 400);
    const list = await s.call('GET', '/api/v1/unmatched');
    assert.equal(list.data.total, 1);
    assert.equal(list.data.items[0].mpn, 'ABC-123');
  });
});
