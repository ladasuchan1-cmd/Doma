'use strict';
// Integrační testy importního API: /import/preview, /import/offers, /import/products, /imports.
// Spouští skutečný server (server.js) nad :memory: databází; bez sítě.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { startServer, example, hardErrors } = require('./api-import-helpers');
const { writeXlsx } = require('../src/formats');

const OFFER_EXAMPLES = ['konkurence.json', 'konkurence.csv', 'konkurence.xml', 'konkurence-vnorene.json'];
const TYPES = { json: 'application/json', csv: 'text/csv; charset=utf-8', xml: 'application/xml' };

function typeOf(name) {
  return TYPES[path.extname(name).slice(1)] || 'application/octet-stream';
}

function count(db, sql, ...args) {
  return Number(db.prepare(sql).get(...args).n);
}

describe('API importu', () => {
  let s;
  let tImport;
  let tRead;
  let tExport;

  before(async () => {
    s = await startServer();
    tImport = await s.token(['import']);
    tRead = await s.token(['read']);
    tExport = await s.token(['export']);
  });
  after(() => s && s.stop());

  it('moduly imports, sources a unmatched se načetly', () => {
    for (const m of ['imports', 'sources', 'unmatched']) assert.ok(s.app.app.apiModules.loaded.includes(m), `modul ${m} není načten`);
  });

  it('ověření a rozsahy oprávnění', async () => {
    const body = example('konkurence.csv');
    let r = await s.call('POST', '/api/v1/import/offers', { as: 'none', body, type: 'text/csv' });
    assert.equal(r.status, 401);
    r = await s.call('POST', '/api/v1/import/offers', { as: tRead, body, type: 'text/csv' });
    assert.equal(r.status, 403);
    r = await s.call('POST', '/api/v1/import/products', { as: tExport, body: example('katalog.csv'), type: 'text/csv' });
    assert.equal(r.status, 403);
    r = await s.call('POST', '/api/v1/import/preview?kind=offers', { as: tRead, body, type: 'text/csv' });
    assert.equal(r.status, 403);
    // session bez CSRF hlavičky
    r = await s.call('POST', '/api/v1/import/offers', { as: 'session-nocsrf', body, type: 'text/csv' });
    assert.equal(r.status, 403);
    assert.equal(r.data.error.details.reason, 'csrf');
    // log importů: read i import token smí číst, export ne
    assert.equal((await s.call('GET', '/api/v1/imports', { as: tRead })).status, 200);
    assert.equal((await s.call('GET', '/api/v1/imports', { as: tImport })).status, 200);
    assert.equal((await s.call('GET', '/api/v1/imports', { as: tExport })).status, 403);
    assert.equal((await s.call('GET', '/api/v1/imports', { as: 'none' })).status, 401);
    // nic se nezapsalo
    assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM imports'), 0);
  });

  it('prázdné tělo → 400 bez záznamu v logu', async () => {
    for (const p of ['/api/v1/import/offers', '/api/v1/import/products', '/api/v1/import/preview?kind=offers']) {
      const r = await s.call('POST', p, { as: tImport, type: 'text/csv' });
      assert.equal(r.status, 400, p);
      assert.match(r.data.error.message, /Tělo požadavku je prázdné/);
    }
    assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM imports'), 0);
  });

  it('náhled katalogu (katalog.csv)', async () => {
    const r = await s.call('POST', '/api/v1/import/preview?kind=products', { as: tImport, body: example('katalog.csv'), type: 'text/csv' });
    assert.equal(r.status, 200, r.text);
    const p = r.data;
    assert.equal(p.kind, 'products');
    assert.equal(p.format, 'csv');
    assert.ok(p.headers.includes('Kód'));
    assert.equal(p.suggested.code, 'Kód');
    assert.equal(p.suggested.purchase_price, 'Nákupní cena');
    assert.ok(p.sample.length > 0 && p.sample.length <= 10);
    assert.equal(p.canonical[0].code, 'SRA-00007');
    assert.equal(p.canonical[0].attrs.N, 'N2');
    assert.deepEqual(p.errors, []);
    assert.deepEqual(p.mapping, {});
    // náhled nic nezapisuje
    assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM products'), 0);
    assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM imports'), 0);
  });

  it('náhled: přepsání mapování, chybějící / neplatný druh, neplatný formát', async () => {
    const mapping = encodeURIComponent(JSON.stringify({ fields: { name: 'Výrobce' } }));
    let r = await s.call('POST', `/api/v1/import/preview?kind=products&mapping=${mapping}`, { as: tImport, body: example('katalog.csv'), type: 'text/csv' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.canonical[0].name, 'SRAM');
    assert.equal(r.data.suggested.name, 'Výrobce');

    r = await s.call('POST', '/api/v1/import/preview', { as: tImport, body: example('katalog.csv'), type: 'text/csv' });
    assert.equal(r.status, 400);
    assert.match(r.data.error.message, /kind=offers/);
    r = await s.call('POST', '/api/v1/import/preview?kind=zbozi', { as: tImport, body: example('katalog.csv'), type: 'text/csv' });
    assert.equal(r.status, 400);
    r = await s.call('POST', '/api/v1/import/preview?kind=offers&mapping=%7Bnejson', { as: tImport, body: example('konkurence.csv'), type: 'text/csv' });
    assert.equal(r.status, 400);
    assert.match(r.data.error.message, /Mapování není platný JSON/);
    r = await s.call('POST', '/api/v1/import/preview?kind=offers', { as: tImport, body: '<a><b></a>', type: 'application/xml' });
    assert.equal(r.status, 400);
    assert.match(r.data.error.message, /XML/);
    assert.ok(r.data.error.details.line >= 1);
  });

  it('náhled XML nabídek najde položky a navrhne mapování', async () => {
    const r = await s.call('POST', '/api/v1/import/preview?kind=offers', { as: tImport, body: example('konkurence.xml'), type: 'application/xml' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.format, 'xml');
    assert.equal(r.data.itemPath, 'prices.offer');
    assert.equal(r.data.suggested.competitor, '@shop');
    assert.equal(r.data.suggested.price, 'price');
    assert.equal(r.data.canonical[0].competitor, 'VeloMarket.cz');
  });

  it('import katalogu katalog.csv (API token) + log importů', async () => {
    const r = await s.call('POST', '/api/v1/import/products', { as: tImport, body: example('katalog.csv'), type: 'text/csv' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.kind, 'products');
    assert.equal(r.data.dry_run, false);
    assert.equal(r.data.format, 'csv');
    assert.ok(Number.isInteger(r.data.import_id));
    assert.equal(r.data.stats.received, 40);
    assert.equal(r.data.stats.created, 40);
    assert.deepEqual(r.data.stats.errors, []);
    assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM products'), 40);
    const p = s.db.prepare("SELECT * FROM products WHERE code = 'SRA-00007'").get();
    assert.equal(p.price, 909);
    assert.equal(JSON.parse(p.attrs).N, 'N2');

    const log = await s.call('GET', `/api/v1/imports/${r.data.import_id}`, { as: tRead });
    assert.equal(log.status, 200);
    assert.equal(log.data.status, 'ok');
    assert.equal(log.data.origin, 'api');
    assert.equal(log.data.kind, 'products');
    assert.equal(log.data.format, 'csv');
    assert.equal(log.data.stats.created, 40, 'stats musí být rozparsovaný objekt');
    assert.ok(log.data.duration_ms >= 0);
  });

  it('všechny ukázkové soubory nabídek se naimportují bez chyb a spárují', async () => {
    for (const name of OFFER_EXAMPLES) {
      const r = await s.call('POST', '/api/v1/import/offers', { as: tImport, body: example(name), type: typeOf(name) });
      assert.equal(r.status, 200, `${name}: ${r.text}`);
      const st = r.data.stats;
      assert.ok(st.received > 0, name);
      assert.ok(st.matched > 0, `${name}: matched = ${st.matched}`);
      assert.equal(st.unmatched, 0, name);
      assert.equal(st.ambiguous, 0, name);
      assert.deepEqual(st.errors, [], `${name}: ${JSON.stringify(st.errors)}`);
      assert.equal(hardErrors(st).length, 0);
    }
    assert.ok(count(s.db, 'SELECT COUNT(*) AS n FROM offers') > 0);
    assert.ok(count(s.db, 'SELECT COUNT(*) AS n FROM competitors') >= 5);
    // nahrání přes UI (session) má origin „upload“
    const r = await s.call('POST', '/api/v1/import/offers', { body: example('konkurence.csv'), type: 'text/csv' });
    assert.equal(r.status, 200, r.text);
    const log = await s.call('GET', `/api/v1/imports/${r.data.import_id}`);
    assert.equal(log.data.origin, 'upload');
  });

  it('XLSX katalog se naimportuje', async () => {
    const buf = writeXlsx([
      {
        name: 'Katalog',
        columns: [
          { key: 'code', label: 'Kód' },
          { key: 'name', label: 'Název' },
          { key: 'price', label: 'Prodejní cena s DPH', type: 'money' },
          { key: 'N', label: 'N' },
        ],
        rows: [
          { code: 'XLS-001', name: 'Duše 29"', price: 149, N: 'N1' },
          { code: 'XLS-002', name: 'Plášť 29"', price: 899, N: 'N7' },
        ],
      },
    ]);
    const r = await s.call('POST', '/api/v1/import/products?filename=katalog.xlsx', {
      as: tImport,
      body: buf,
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.format, 'xlsx');
    assert.equal(r.data.stats.created, 2);
    const p = s.db.prepare("SELECT * FROM products WHERE code = 'XLS-002'").get();
    assert.equal(p.price, 899);
    assert.equal(JSON.parse(p.attrs).N, 'N7');
  });

  it('gzip soubor, Content-Encoding: gzip a multipart/form-data', async () => {
    // .gz soubor jako tělo
    let r = await s.call('POST', '/api/v1/import/offers', { as: tImport, body: zlib.gzipSync(example('konkurence.csv')), type: 'application/gzip' });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.data.stats.matched > 0);
    // komprimované tělo požadavku
    r = await s.call('POST', '/api/v1/import/offers', {
      as: tImport,
      body: zlib.gzipSync(example('konkurence.json')),
      type: 'application/json',
      headers: { 'content-encoding': 'gzip' },
    });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.data.stats.matched > 0);
    // multipart (curl -F file=@ceny.csv -F mapping=…) – pole formuláře doplní parametry
    const boundary = '----cenotvorbaTest' + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="mapping"\r\n\r\n${JSON.stringify({ defaults: { competitor: 'MultiShop.cz' } })}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="dry_run"\r\n\r\n0\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ceny.csv"\r\nContent-Type: text/csv\r\n\r\n`),
      Buffer.from('ean;cena\r\n8597315660484;812\r\n8595234463384;845\r\n'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    r = await s.call('POST', '/api/v1/import/offers', { as: tImport, body, type: `multipart/form-data; boundary=${boundary}` });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.stats.matched, 2);
    const off = s.db
      .prepare("SELECT o.price FROM offers o JOIN competitors c ON c.id = o.competitor_id JOIN products p ON p.id = o.product_id WHERE c.name = 'MultiShop.cz' AND p.code = 'SRA-00007'")
      .get();
    assert.equal(off.price, 812);
    // multipart bez souboru
    const noFile = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="mapping"\r\n\r\n{}\r\n--${boundary}--\r\n`);
    r = await s.call('POST', '/api/v1/import/offers', { as: tImport, body: noFile, type: `multipart/form-data; boundary=${boundary}` });
    assert.equal(r.status, 400);
    assert.match(r.data.error.message, /chybí soubor/);
  });

  it('JSON pole kanonických nabídek funguje bez mapování (i {items: […]})', async () => {
    const observed = new Date(Date.now() - 2 * 86400000).toISOString();
    const items = [
      { code: 'SRA-00007', competitor: 'KanonShop.cz', price: 777, shipping: 49, in_stock: false, delivery_days: 5, url: 'https://kanon.example/sra', name: 'SRAM XTR kliky (Kanon)', observed_at: observed },
      { ean: '8595234463384', competitor: 'KanonShop.cz', price: '899,50 Kč', availability: 'skladem' },
      { mpn: 'NEEXISTUJE-1', ext_id: 'EXT-42', competitor: 'KanonShop.cz', price: 100, name: 'Neznámé zboží', stock_qty: 3 },
    ];
    let r = await s.call('POST', '/api/v1/import/offers', { as: tImport, json: items });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.format, 'json');
    assert.equal(r.data.stats.received, 3);
    assert.equal(r.data.stats.matched, 2);
    assert.equal(r.data.stats.unmatched, 1);
    assert.deepEqual(r.data.stats.errors, []);
    const q = s.db.prepare(
      "SELECT o.* FROM offers o JOIN competitors c ON c.id = o.competitor_id JOIN products p ON p.id = o.product_id WHERE c.name = 'KanonShop.cz' AND p.code = ?"
    );
    const a = q.get('SRA-00007');
    assert.equal(a.price, 777);
    assert.equal(a.shipping, 49);
    assert.equal(a.in_stock, 0);
    assert.equal(a.delivery_days, 5);
    assert.equal(a.url, 'https://kanon.example/sra');
    assert.equal(a.name, 'SRAM XTR kliky (Kanon)');
    assert.equal(a.observed_at, observed);
    const b = q.get('MAX-00028');
    assert.equal(b.price, 899.5);
    assert.equal(b.in_stock, 1);
    const u = s.db.prepare("SELECT * FROM unmatched_offers WHERE ext_id = 'EXT-42'").get();
    assert.ok(u, 'nespárovaná nabídka s ext_id');
    assert.equal(u.mpn, 'NEEXISTUJE-1');

    // {items: […]} s výchozím konkurentem na kořeni
    r = await s.call('POST', '/api/v1/import/offers', { as: tImport, json: { competitor: 'ObalShop.cz', items: [{ code: 'SRA-00007', price: 800 }, { code: 'MAX-00028', price: 850, in_stock: true }] } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.stats.matched, 2);
    assert.equal(q.get('SRA-00007') && s.db.prepare("SELECT COUNT(*) AS n FROM offers o JOIN competitors c ON c.id = o.competitor_id WHERE c.name = 'ObalShop.cz'").get().n, 2);

    // příklad z UI (curl) – neznámé kódy skončí mezi nespárovanými, ne chybou
    r = await s.call('POST', '/api/v1/import/offers?replace=competitors', {
      as: tImport,
      json: {
        items: [
          { ean: '8592842012345', competitor: 'VeloMarket.cz', price: 18990, shipping: 0, availability: 'skladem', url: 'https://velomarket.example/trek-marlin-7' },
          { code: 'TRK-MAR7-M', competitor: 'KoloExpres.cz', price: 19490, in_stock: false },
        ],
      },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.stats.received, 2);
    assert.equal(r.data.stats.unmatched, 2);
    // replace=competitors: VeloMarket je v dávce (i když nespárovaný) → jeho ostatní nabídky se smažou
    assert.ok(r.data.stats.removed > 0);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM offers o JOIN competitors c ON c.id = o.competitor_id WHERE c.name = 'VeloMarket.cz'").get().n, 0);
  });

  it('replace=competitors ponechá jen nabídky z dávky', async () => {
    // obnovit nabídky ze souboru
    let r = await s.call('POST', '/api/v1/import/offers', { as: tImport, body: example('konkurence.json'), type: 'application/json' });
    assert.equal(r.status, 200, r.text);
    const velo = () => count(s.db, "SELECT COUNT(*) AS n FROM offers o JOIN competitors c ON c.id = o.competitor_id WHERE c.name = 'VeloMarket.cz'");
    const others = () => count(s.db, "SELECT COUNT(*) AS n FROM offers o JOIN competitors c ON c.id = o.competitor_id WHERE c.name <> 'VeloMarket.cz'");
    assert.ok(velo() > 1);
    const before = others();
    r = await s.call('POST', '/api/v1/import/offers?replace=competitors', { as: tImport, json: [{ code: 'SRA-00007', competitor: 'VeloMarket.cz', price: 835 }] });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.data.stats.removed > 0);
    assert.equal(velo(), 1);
    assert.equal(others(), before, 'nabídky ostatních konkurentů zůstávají');
  });

  it('dry_run nic nezapíše a vrátí náhled', async () => {
    const importsBefore = count(s.db, 'SELECT COUNT(*) AS n FROM imports');
    const offersBefore = s.db.prepare('SELECT product_id, competitor_id, price FROM offers ORDER BY 1, 2').all().map((o) => ({ ...o }));
    const r = await s.call('POST', '/api/v1/import/offers?dry_run=1&replace=all', { as: tImport, json: [{ code: 'SRA-00007', competitor: 'DryShop.cz', price: 1 }] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.dry_run, true);
    assert.equal(r.data.import_id, null);
    assert.equal(r.data.stats.matched, 1);
    assert.equal(r.data.stats.competitors_created, 1);
    assert.ok(r.data.stats.removed > 0, 'dry run ukáže, co by se smazalo');
    assert.ok(Array.isArray(r.data.preview) && r.data.preview.length === 1);
    assert.equal(r.data.preview[0].competitor, 'DryShop.cz');
    assert.equal(typeof r.data.fields, 'object');
    assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM imports'), importsBefore);
    assert.deepEqual(
      s.db.prepare('SELECT product_id, competitor_id, price FROM offers ORDER BY 1, 2').all().map((o) => ({ ...o })),
      offersBefore
    );
    assert.equal(count(s.db, "SELECT COUNT(*) AS n FROM competitors WHERE name = 'DryShop.cz'"), 0);
    // dry run katalogu
    const p = await s.call('POST', '/api/v1/import/products?dry_run=true&deactivate_missing=1', { as: tImport, json: [{ code: 'NOVY-1', name: 'Nový' }] });
    assert.equal(p.status, 200, p.text);
    assert.equal(p.data.stats.created, 1);
    assert.ok(p.data.stats.deactivated > 0);
    assert.equal(count(s.db, "SELECT COUNT(*) AS n FROM products WHERE code = 'NOVY-1'"), 0);
    assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM products WHERE active = 0'), 0);
  });

  it('neplatné parametry → 400 s českou zprávou', async () => {
    const body = example('konkurence.csv');
    const cases = [
      ['/api/v1/import/offers?replace=vse', /replace/],
      ['/api/v1/import/offers?max_age_days=-1', /max_age_days/],
      ['/api/v1/import/offers?max_age_days=abc', /max_age_days/],
      ['/api/v1/import/offers?mapping=nejson', /Mapování není platný JSON/],
      ['/api/v1/import/offers?mapping=%5B1%5D', /Mapování/],
      [`/api/v1/import/offers?mapping=${encodeURIComponent(JSON.stringify({ fields: { cena: 'cena' } }))}`, /Neznámá pole v mapování.*cena/],
      [`/api/v1/import/products?mapping=${encodeURIComponent(JSON.stringify({ fields: { competitor: 'x' } }))}`, /Neznámá pole v mapování/],
      [`/api/v1/import/offers?mapping=${encodeURIComponent(JSON.stringify({ fields: [] }))}`, /mapping.fields/],
      [`/api/v1/import/offers?mapping=${encodeURIComponent(JSON.stringify({ format: 'pdf' }))}`, /Neznámý formát/],
      ['/api/v1/import/offers?source=abc', /source/],
    ];
    const before = count(s.db, 'SELECT COUNT(*) AS n FROM imports');
    for (const [p, re] of cases) {
      const r = await s.call('POST', p, { as: tImport, body, type: 'text/csv' });
      assert.equal(r.status, 400, `${p}: ${r.text}`);
      assert.match(r.data.error.message, re, p);
    }
    const r = await s.call('POST', '/api/v1/import/offers?source=99999', { as: tImport, body, type: 'text/csv' });
    assert.equal(r.status, 404);
    assert.match(r.data.error.message, /Zdroj #99999/);
    assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM imports'), before, 'neplatné parametry nezakládají záznam importu');
    // mapování s neznámým polem vrací seznam chyb
    const m = await s.call('POST', `/api/v1/import/offers?mapping=${encodeURIComponent(JSON.stringify({ defaults: { konkurent: 'X' } }))}`, { as: tImport, body, type: 'text/csv' });
    assert.equal(m.status, 400);
    assert.ok(Array.isArray(m.data.error.details.errors));
  });

  it('chyba formátu po založení importu vrací import_id (a log má stav error)', async () => {
    for (const [body, type, re] of [
      ['<prices><offer><ean>1</ean></prices>', 'application/xml', /XML/],
      ['{"items": [1, 2,', 'application/json', /JSON/],
      ['\n\n   \n', 'text/csv', /prázdný|žádné záznamy/i],
    ]) {
      const r = await s.call('POST', '/api/v1/import/offers', { as: tImport, body, type });
      assert.equal(r.status, 400, r.text);
      assert.match(r.data.error.message, re);
      const id = r.data.error.details.import_id;
      assert.ok(Number.isInteger(id), `import_id v details: ${r.text}`);
      const log = await s.call('GET', `/api/v1/imports/${id}`, { as: tRead });
      assert.equal(log.data.status, 'error');
      assert.ok(log.data.error);
    }
  });

  it('import bez jediného platného řádku → 400 s nápovědou (hlavičky, chyby) a log error', async () => {
    const r = await s.call('POST', '/api/v1/import/offers', { as: tImport, body: 'Zboží;Obchod;Kolik\nKolo;X.cz;abc\nKolo 2;Y.cz;\n', type: 'text/csv' });
    assert.equal(r.status, 400, r.text);
    assert.match(r.data.error.message, /Žádný záznam nebyl naimportován – všechny 2 záznamy obsahují chybu/);
    const d = r.data.error.details;
    assert.ok(Number.isInteger(d.import_id));
    assert.deepEqual(d.headers, ['Zboží', 'Obchod', 'Kolik']);
    assert.equal(d.suggested.competitor, 'Obchod');
    assert.ok(Array.isArray(d.errors) && d.errors.length > 0);
    assert.equal(d.stats.received, 2);
    const log = await s.call('GET', `/api/v1/imports/${d.import_id}`);
    assert.equal(log.data.status, 'error');
    assert.match(log.data.error, /Žádný záznam/);
    // katalog bez kódu
    const p = await s.call('POST', '/api/v1/import/products', { as: tImport, json: [{ nazev: 'Bez kódu' }] });
    assert.equal(p.status, 400);
    assert.match(p.data.error.message, /jediný záznam obsahuje chybu/);
    // zkušební import stejného souboru vrací 200 se statistikou
    const dry = await s.call('POST', '/api/v1/import/offers?dry_run=1', { as: tImport, body: 'Zboží;Obchod;Kolik\nKolo;X.cz;abc\n', type: 'text/csv' });
    assert.equal(dry.status, 200);
    assert.ok(hardErrors(dry.data.stats).length > 0);
  });

  it('deactivate_missing deaktivuje chybějící produkty a úplný import je vrátí', async () => {
    const all = count(s.db, 'SELECT COUNT(*) AS n FROM products');
    let r = await s.call('POST', '/api/v1/import/products?deactivate_missing=1', { as: tImport, json: [{ code: 'SRA-00007', name: 'SRAM XTR kliky' }] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.stats.deactivated, all - 1);
    assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM products WHERE active = 1'), 1);
    // bez deactivate_missing se stav aktivity nemění (částečný import nic neoživí ani nevypne)
    r = await s.call('POST', '/api/v1/import/products?deactivate_missing=0', { as: tImport, body: example('katalog.csv'), type: 'text/csv' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.stats.deactivated, 0);
    assert.equal(count(s.db, 'SELECT COUNT(*) AS n FROM products WHERE active = 1'), 1);
    // úplný katalog s deactivate_missing=1 produkty znovu aktivuje (a vypne ty, které v něm nejsou – XLS-00x)
    r = await s.call('POST', '/api/v1/import/products?deactivate_missing=1', { as: tImport, body: example('katalog.csv'), type: 'text/csv' });
    assert.equal(r.status, 200, r.text);
    assert.equal(count(s.db, "SELECT COUNT(*) AS n FROM products WHERE active = 1 AND code NOT LIKE 'XLS-%'"), 40);
    assert.equal(count(s.db, "SELECT COUNT(*) AS n FROM products WHERE active = 1 AND code LIKE 'XLS-%'"), 0);
  });

  it('import přes uložený zdroj (source=ID): mapování, volby, kontrola druhu, stav zdroje', async () => {
    const created = await s.call('POST', '/api/v1/sources', {
      json: {
        name: 'Ceník od MegaSportíku',
        kind: 'offers',
        mapping: { fields: { ean: 'EAN kód', price: 'Cena s DPH' }, defaults: { competitor: 'MegaSportík.cz' }, csv: { decimal: ',' } },
        options: { replace: 'competitors' },
      },
    });
    assert.equal(created.status, 201, created.text);
    const id = created.data.id;
    const csv = 'EAN kód;Cena s DPH;Poznámka\n8597315660484;877,50;akce\n8595234463384;870;\n';
    let r = await s.call('POST', `/api/v1/import/offers?source=${id}`, { as: tImport, body: csv, type: 'text/csv' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.source_id, id);
    assert.equal(r.data.stats.matched, 2);
    assert.ok(r.data.stats.removed > 0, 'volba replace ze zdroje');
    const price = s.db
      .prepare("SELECT o.price FROM offers o JOIN competitors c ON c.id = o.competitor_id JOIN products p ON p.id = o.product_id WHERE c.name = 'MegaSportík.cz' AND p.code = 'SRA-00007'")
      .get().price;
    assert.equal(price, 877.5);
    // zdroj bez URL si pamatuje poslední příjem dat
    let src = await s.call('GET', `/api/v1/sources/${id}`);
    assert.equal(src.data.last_status, 'ok');
    assert.match(src.data.last_message, /spárováno 2/);
    // log importu s názvem zdroje
    const log = await s.call('GET', `/api/v1/imports?source=${id}`, { as: tRead });
    assert.equal(log.data.items[0].source_name, 'Ceník od MegaSportíku');
    // mapování z query přepíše zdroj; replace=0 vypne mazání
    const over = encodeURIComponent(JSON.stringify({ defaults: { competitor: 'Přepsaný.cz' } }));
    r = await s.call('POST', `/api/v1/import/offers?source=${id}&mapping=${over}&replace=0`, { as: tImport, body: csv, type: 'text/csv' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.stats.removed, 0);
    assert.equal(count(s.db, "SELECT COUNT(*) AS n FROM competitors WHERE name = 'Přepsaný.cz'"), 1);
    // náhled přes zdroj převezme druh i mapování
    const pv = await s.call('POST', `/api/v1/import/preview?source=${id}`, { as: tImport, body: csv, type: 'text/csv' });
    assert.equal(pv.status, 200, pv.text);
    assert.equal(pv.data.kind, 'offers');
    assert.equal(pv.data.canonical[0].competitor, 'MegaSportík.cz');
    assert.equal(pv.data.canonical[0].price, 877.5);
    // špatný druh
    r = await s.call('POST', `/api/v1/import/products?source=${id}`, { as: tImport, body: csv, type: 'text/csv' });
    assert.equal(r.status, 400);
    assert.match(r.data.error.message, /je určen pro ceny konkurence/);
    r = await s.call('POST', `/api/v1/import/preview?source=${id}&kind=products`, { as: tImport, body: csv, type: 'text/csv' });
    assert.equal(r.status, 400);
    // neúspěšný příjem se ke zdroji zapíše také
    r = await s.call('POST', `/api/v1/import/offers?source=${id}`, { as: tImport, body: '<x', type: 'application/xml' });
    assert.equal(r.status, 400);
    src = await s.call('GET', `/api/v1/sources/${id}`);
    assert.equal(src.data.last_status, 'error');
  });

  it('GET /imports: pořadí, filtry, stránkování, 404', async () => {
    const all = await s.call('GET', '/api/v1/imports');
    assert.equal(all.status, 200);
    assert.ok(all.data.total >= all.data.items.length);
    assert.equal(all.data.limit, 100);
    assert.equal(all.data.page, 1);
    const ids = all.data.items.map((i) => i.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'nejnovější první');
    for (const i of all.data.items) {
      assert.equal(typeof i.stats, 'object');
      assert.ok(['ok', 'error'].includes(i.status));
      assert.ok('source_name' in i);
    }
    const offers = await s.call('GET', '/api/v1/imports?kind=offers');
    assert.ok(offers.data.items.length > 0 && offers.data.items.every((i) => i.kind === 'offers'));
    const errs = await s.call('GET', '/api/v1/imports?status=error');
    assert.ok(errs.data.items.length > 0 && errs.data.items.every((i) => i.status === 'error'));
    const api = await s.call('GET', '/api/v1/imports?origin=upload');
    assert.ok(api.data.items.every((i) => i.origin === 'upload'));
    const p2 = await s.call('GET', '/api/v1/imports?limit=2&page=2');
    assert.equal(p2.data.items.length, 2);
    assert.deepEqual(
      p2.data.items.map((i) => i.id),
      ids.slice(2, 4)
    );
    assert.equal((await s.call('GET', '/api/v1/imports?status=hotovo')).status, 400);
    assert.equal((await s.call('GET', '/api/v1/imports?kind=x')).status, 400);
    assert.equal((await s.call('GET', '/api/v1/imports?origin=x')).status, 400);
    assert.equal((await s.call('GET', '/api/v1/imports/999999')).status, 404);
    assert.equal((await s.call('GET', '/api/v1/imports/abc')).status, 400);
    // přerušený import (stav running z minulého běhu procesu) se zobrazí jako chyba
    const id = Number(
      s.db
        .prepare("INSERT INTO imports (kind, origin, started_at, status, stats) VALUES ('offers', 'api', ?, 'running', '{}')")
        .run(new Date(Date.now() - 24 * 3600e3).toISOString()).lastInsertRowid
    );
    const stale = await s.call('GET', `/api/v1/imports/${id}`);
    assert.equal(stale.data.status, 'error');
    assert.equal(stale.data.interrupted, true);
  });

  it('import routy mají výslovný limit těla z config.maxBodyMb', () => {
    const cfg = s.app.config;
    for (const p of ['/api/v1/import/offers', '/api/v1/import/products', '/api/v1/import/preview']) {
      const r = s.app.app.router.routes.find((x) => x.method === 'POST' && x.pattern === p);
      assert.ok(r, p);
      assert.equal(r.opts.maxBodyMb, cfg.maxBodyMb);
      assert.equal(r.auth, 'import');
    }
  });

  it('zneplatní cache přehledů po importu (pokud existuje _views.js)', async (t) => {
    const viewsPath = path.join(__dirname, '..', 'src', 'server', 'api', '_views.js');
    if (!fs.existsSync(viewsPath)) {
      t.skip('src/server/api/_views.js zatím neexistuje');
      return;
    }
    const views = require(viewsPath);
    const key = ['invalidate', 'invalidateViews', 'invalidateCache'].find((k) => typeof views[k] === 'function');
    if (!key) {
      t.skip('_views.js neexportuje invalidate');
      return;
    }
    const orig = views[key];
    let calls = 0;
    try {
      views[key] = (...a) => {
        calls++;
        return orig(...a);
      };
    } catch {
      t.skip('export _views.js nelze nahradit');
      return;
    }
    try {
      const dry = await s.call('POST', '/api/v1/import/offers?dry_run=1', { as: tImport, body: example('konkurence.csv'), type: 'text/csv' });
      assert.equal(dry.status, 200);
      assert.equal(calls, 0, 'zkušební import cache nemaže');
      const r = await s.call('POST', '/api/v1/import/offers', { as: tImport, body: example('konkurence.csv'), type: 'text/csv' });
      assert.equal(r.status, 200);
      assert.ok(calls >= 1);
    } finally {
      views[key] = orig;
    }
  });
});

describe('API importu – limit velikosti těla', () => {
  let s;
  before(async () => {
    s = await startServer({ maxBodyMb: 0.004 });
  });
  after(() => s && s.stop());

  it('příliš velké tělo → 413', async () => {
    const tImport = await s.token(['import']);
    const r = await s.call('POST', '/api/v1/import/offers', { as: tImport, body: example('konkurence.csv'), type: 'text/csv' });
    assert.equal(r.status, 413);
    assert.match(r.data.error.message, /příliš velké/);
    const ok = await s.call('POST', '/api/v1/import/offers', { as: tImport, json: [{ ean: '8597315660484', competitor: 'X.cz', price: 1 }] });
    assert.equal(ok.status, 200, ok.text);
  });
});
