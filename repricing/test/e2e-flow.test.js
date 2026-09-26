'use strict';
// E2E scénář celé cenotvorby – výhradně přes HTTP proti skutečnému serveru (server.js start) spuštěnému v procesu.
//
//   1. přihlášení, API tokeny (import, export, read)
//   2. import katalogu (CSV UTF-8 i windows-1250), kontrola statistik a GET /products
//   3. import cen konkurence (XML, JSON, vnořený JSON, CSV; jednou ?replace=competitors) tokenem pro import
//   4. segmenty + strategie (z předvolby, vlastní s podmínkami a cílem pozice 2, záchytná s fallback next), pořadí,
//      simulace, přecenění, návrhy (vysvětlení, příznaky, propadnutí na další strategii)
//   5. schválení / zamítnutí / ruční cena → feedy (xml/json/csv) → POST /export/ack → exportováno, nové ceny, historie
//   6. POHODA XML (windows-1250, s označením) + validace proti oficiálnímu XSD (xmllint), varianta s cenovou hladinou
//   7. webhook: nastavení URL → POST /export/push → lokální server dostal JSON s položkami
//   8. uzavření smyčky: další import katalogu s novými cenami (bez upozornění not_applied) / s jinou cenou (upozornění)
//   9. přehled, pole, facety, běhy, log exportů a audit odpovídají provedeným akcím
//  10. plánovač: druhý server se zapnutým plánovačem, zdroj s URL, přecenění po importu, automatické odeslání
//  11. cenová skupina (3 velikosti za jednu cenu), zkušební běh celé sady, import metrik „jen aktualizovat“,
//      zrušení schválení, znovustažení exportu, přihlášení se jménem → decided_by / audit
// Robustnost: poškozená těla (XML/CSV/JSON/XLSX) → 400 s českou zprávou, import 30 000 produktů, souběžné požadavky
// během přecenění i při zámku databáze jiným procesem, restart serveru nad souborovou databází.
//
// Validace XSD: POHODA_XSD_DIR z prostředí, jinak adresář se staženými schématy Stormware (pokud existuje).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { startServer, localServer, example, hardErrors, PASSWORD } = require('./api-import-helpers');
const { encodeWindows1250, decodeBuffer } = require('../src/formats/decode');
const { parseCsv } = require('../src/formats/csv');
const { parseXml } = require('../src/formats/xml');
const { generateDemo } = require('../tools/demo-data');

const XSD_FALLBACK = '/tmp/claude-0/-home-user-Doma/742d48af-6776-5fc6-af84-78d20384ca0e/scratchpad/allxsd';
const XSD_DIR = process.env.POHODA_XSD_DIR || (fs.existsSync(path.join(XSD_FALLBACK, 'data.xsd')) ? XSD_FALLBACK : null);
const HAS_XMLLINT = !spawnSync('xmllint', ['--version']).error;

// česká zpráva: diakritika nebo běžná česká slova (některé krátké zprávy diakritiku nemají)
const CZECH = /[ěščřžýáíéůúťďňó]|\b(je|jen|není|musí|pro|nebo|neplatn\w*|parametr\w*|zadejte|chybí|nelze|soubor)\b/i;
const DAY_MS = 24 * 3600 * 1000;

/** Chybová odpověď API: status 400 a česká zpráva (nikdy 500). */
function assertCzech400(r, label) {
  assert.equal(r.status, 400, `${label}: čekáno 400, přišlo ${r.status} ${String(r.text).slice(0, 300)}`);
  const msg = r.data && r.data.error && r.data.error.message;
  assert.equal(typeof msg, 'string', `${label}: chybí error.message`);
  assert.match(msg, CZECH, `${label}: zpráva není česky: ${msg}`);
  assert.doesNotMatch(msg, /Unexpected token|undefined|is not a function|Cannot read|SQLITE/i, `${label}: technická zpráva: ${msg}`);
}

/** Řádky katalogu (examples/katalog.csv) jako pole polí; hlavička zvlášť. */
function catalogLines() {
  const text = example('katalog.csv').toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  return { head: lines[0], rows: lines.slice(1).map((l) => l.split(';')) };
}

/** Katalog CSV s cenami podle mapy kód → cena (ostatní beze změny). */
function catalogWithPrices(prices) {
  const { head, rows } = catalogLines();
  const PRICE_COL = head.split(';').indexOf('Prodejní cena s DPH');
  assert.ok(PRICE_COL > 0, 'sloupec Prodejní cena s DPH v examples/katalog.csv');
  const out = rows.map((cells) => {
    const c = [...cells];
    if (prices.has(c[0])) c[PRICE_COL] = String(prices.get(c[0]));
    return c.join(';');
  });
  return '\uFEFF' + [head, ...out].join('\r\n') + '\r\n';
}

/** Počet elementů daného (lokálního) jména ve stromu parseXml. */
function countElements(node, name) {
  let n = node.name === name ? 1 : 0;
  for (const c of node.children || []) n += countElements(c, name);
  return n;
}

function xmllint(xmlBuffer, label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-e2e-xsd-'));
  try {
    const file = path.join(tmp, `${label}.xml`);
    fs.writeFileSync(file, xmlBuffer);
    const r = spawnSync('xmllint', ['--noout', '--schema', path.join(XSD_DIR, 'data.xsd'), file], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${label}: XSD validace selhala:\n${r.stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Lokální přijímač webhooku – ukládá přijaté požadavky. */
async function webhookReceiver({ status = 200 } = {}) {
  const received = [];
  const srv = await localServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      const body = Buffer.concat(parts).toString('utf8');
      let json = null;
      try {
        json = JSON.parse(body);
      } catch {
        /* nic */
      }
      received.push({ method: req.method, url: req.url, headers: req.headers, body, json });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return { ...srv, received };
}

// =========================================================================================================
describe('E2E: import → strategie → přecenění → schválení → export → uzavření smyčky', () => {
  let s;
  const T = {}; // tokeny
  const S = {}; // sdílený stav mezi kroky
  let hook;

  before(async () => {
    s = await startServer();
    hook = await webhookReceiver();
  });
  after(async () => {
    if (hook) await hook.close();
    if (s) await s.stop();
  });

  test('1. přihlášení a API tokeny', async () => {
    const me = await s.call('GET', '/api/v1/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.via, 'session');

    // špatné heslo
    const bad = await s.call('POST', '/api/v1/auth/login', { as: 'none', json: { password: 'spatne-heslo' } });
    assert.equal(bad.status, 401);
    assert.match(bad.data.error.message, CZECH);

    T.imp = await s.token(['import'], 'e2e-import');
    T.exp = await s.token(['export'], 'e2e-export');
    T.read = await s.token(['read'], 'e2e-read');
    for (const t of [T.imp, T.exp, T.read]) assert.match(t, /^ct_[A-Za-z0-9]{32}$/);

    const list = await s.call('GET', '/api/v1/tokens');
    assert.equal(list.status, 200);
    assert.equal(list.data.items.length, 3);
    assert.ok(list.data.items.every((t) => !('token' in t) && !('token_hash' in t)), 'seznam tokenů nesmí vracet tajemství');

    // rozsahy: read token nesmí importovat, import token nesmí číst produkty ani feed
    const r1 = await s.call('POST', '/api/v1/import/products', { as: T.read, body: 'code;price\nX;1', type: 'text/csv' });
    assert.equal(r1.status, 403);
    const r2 = await s.call('GET', '/api/v1/products', { as: T.imp });
    assert.equal(r2.status, 403);
    const r3 = await s.call('GET', '/api/v1/products', { as: 'none' });
    assert.equal(r3.status, 401);
    const me2 = await s.call('GET', '/api/v1/auth/me', { as: T.exp });
    assert.equal(me2.status, 200);
    assert.deepEqual(me2.data.scopes, ['export']);
    // cookie bez CSRF hlavičky → zamítnuto
    const csrf = await s.call('POST', '/api/v1/runs', { as: 'session-nocsrf', json: {} });
    assert.equal(csrf.status, 403);
  });

  test('2. import katalogu CSV (UTF-8 a windows-1250) + GET /products', async () => {
    const r = await s.call('POST', '/api/v1/import/products', { as: T.imp, body: example('katalog.csv'), type: 'text/csv' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.format, 'csv');
    assert.deepEqual({ ...r.data.stats, errors: hardErrors(r.data.stats) }, { received: 40, created: 40, updated: 0, unchanged: 0, deactivated: 0, superseded: 0, errors: [] });

    // stejný katalog v kódování windows-1250 (export z Pohody/Excelu); „²“ v cp1250 není → nahrazeno „2“
    const text = example('katalog.csv').toString('utf8').replace(/^\uFEFF/, '').replace(/²/g, '2');
    const cp = encodeWindows1250(text);
    assert.ok(cp.includes(0x9a) || cp.includes(0xe1), 'soubor opravdu obsahuje cp1250 bajty');
    const r2 = await s.call('POST', '/api/v1/import/products', { as: T.imp, body: cp, type: 'text/csv' });
    assert.equal(r2.status, 200, r2.text);
    // 5 produktů „Jam²“ → „Jam2“ (změna názvu), zbytek beze změny = diakritika dekódována správně
    assert.equal(r2.data.stats.updated, 5);
    assert.equal(r2.data.stats.unchanged, 35);
    assert.equal(r2.data.stats.created, 0);

    // totéž s výslovným charset v Content-Type → vše beze změny
    const r2b = await s.call('POST', '/api/v1/import/products', { as: T.imp, body: cp, type: 'text/csv; charset=windows-1250' });
    assert.equal(r2b.status, 200, r2b.text);
    assert.equal(r2b.data.stats.unchanged, 40);

    // náhled (návrh mapování) a zkušební import nic nezapíšou
    const pv = await s.call('POST', '/api/v1/import/preview?kind=products', { as: T.imp, body: example('katalog.csv'), type: 'text/csv' });
    assert.equal(pv.status, 200, pv.text);
    assert.equal(pv.data.format, 'csv');
    assert.equal(pv.data.suggested.code, 'Kód');
    assert.equal(pv.data.suggested.price, 'Prodejní cena s DPH');
    assert.equal(pv.data.suggested.purchase_price, 'Nákupní cena');
    assert.equal(pv.data.suggested.owner, 'Zodpovědná osoba');
    assert.equal(pv.data.canonical[0].code, 'SRA-00007');
    const dry = await s.call('POST', '/api/v1/import/products?dry_run=1', { as: T.imp, body: catalogWithPrices(new Map([['SRA-00007', 1]])), type: 'text/csv' });
    assert.equal(dry.status, 200);
    assert.equal(dry.data.dry_run, true);
    assert.equal(dry.data.import_id, null);
    assert.equal(dry.data.stats.updated, 6, 'zkušební import hlásí, co by se změnilo');

    // vrátit původní názvy
    const r3 = await s.call('POST', '/api/v1/import/products', { as: T.imp, body: example('katalog.csv'), type: 'text/csv; charset=utf-8' });
    assert.equal(r3.status, 200);
    assert.equal(r3.data.stats.updated, 5);

    const list = await s.call('GET', '/api/v1/products?limit=100&sort=code', { as: T.read });
    assert.equal(list.status, 200);
    assert.equal(list.data.total, 40);
    const byCode = new Map(list.data.items.map((p) => [p.code, p]));
    const sram = byCode.get('SRA-00007');
    assert.equal(sram.price, 909, 'zkušební import nic nezapsal');
    assert.equal(sram.name, 'SRAM XTR kliky');
    assert.equal(sram.owner, 'Petr Svoboda');
    assert.equal(sram.purchase_price, 505);
    assert.equal(sram.price, 909);
    assert.equal(sram.msrp, 979);
    assert.equal(sram.stock, 7);
    assert.equal(sram.sales_30, 17);
    assert.equal(sram.attrs.N, 'N2');
    const jam = byCode.get('CAN-00245-XS');
    assert.equal(jam.name, 'Cannondale Jam² 2024 vel. XS (šedá)');
    assert.equal(jam.owner, 'Jana Nováková');
    assert.equal(jam.market_count, 0, 'zatím bez nabídek konkurence');
    assert.equal(jam.position, 'no_data');
    S.products = byCode;

    // vyhledávání a řazení
    const q = await s.call('GET', '/api/v1/products?q=' + encodeURIComponent('šedá') + '&limit=100', { as: T.read });
    assert.equal(q.status, 200);
    assert.ok(q.data.total > 0 && q.data.items.every((p) => /šedá/.test(p.name)));
    const desc = await s.call('GET', '/api/v1/products?sort=price&dir=desc&limit=2', { as: T.read });
    assert.ok(desc.data.items[0].price >= desc.data.items[1].price);
  });

  test('3. import cen konkurence (XML, JSON, vnořený JSON, CSV) tokenem pro import', async () => {
    // XML jako první – bez observed_at (= čas importu), takže trh je čerstvý nezávisle na datu v příkladech
    const xml = await s.call('POST', '/api/v1/import/offers', { as: T.imp, body: example('konkurence.xml'), type: 'application/xml' });
    assert.equal(xml.status, 200, xml.text);
    assert.equal(xml.data.format, 'xml');
    assert.equal(xml.data.item_path, 'prices.offer');
    assert.equal(xml.data.stats.received, 123);
    assert.equal(xml.data.stats.matched, 123);
    assert.equal(xml.data.stats.unmatched, 0);
    assert.equal(xml.data.stats.created, 123);
    assert.equal(xml.data.stats.competitors_created, 7);
    assert.deepEqual(hardErrors(xml.data.stats), []);

    for (const [file, type] of [
      ['konkurence.json', 'application/json'],
      ['konkurence-vnorene.json', 'application/json'],
    ]) {
      const r = await s.call('POST', '/api/v1/import/offers', { as: T.imp, body: example(file), type });
      assert.equal(r.status, 200, `${file}: ${r.text}`);
      assert.equal(r.data.stats.received, 123, file);
      assert.equal(r.data.stats.matched, 123, file);
      assert.equal(r.data.stats.competitors_created, 0, file);
      assert.deepEqual(hardErrors(r.data.stats), [], file);
    }

    // CSV + replace=competitors: nabídky konkurentů z dávky, které v ní chybí, se smažou
    const lines = example('konkurence.csv').toString('utf8').split(/\r?\n/).filter(Boolean);
    const dropped = lines[1].split(';'); // první nabídka (ean;konkurent;…) v dávce chybí
    const csv = [lines[0], ...lines.slice(2)].join('\r\n');
    const rc = await s.call('POST', '/api/v1/import/offers?replace=competitors', { as: T.imp, body: csv, type: 'text/csv' });
    assert.equal(rc.status, 200, rc.text);
    assert.equal(rc.data.stats.received, 122);
    assert.equal(rc.data.stats.matched, 122);
    assert.equal(rc.data.stats.removed, 1, 'replace=competitors smaže chybějící nabídku');
    S.droppedOffer = { ean: dropped[0], competitor: dropped[1] };

    // a zpět úplná CSV dávka (bez replace) – nabídka se vrátí
    const rc2 = await s.call('POST', '/api/v1/import/offers', { as: T.imp, body: example('konkurence.csv'), type: 'text/csv' });
    assert.equal(rc2.status, 200);
    assert.equal(rc2.data.stats.matched, 123);
    assert.equal(rc2.data.stats.created, 1);

    // zdroj „jen pro příjem“ s vlastním mapováním (admin posílá CSV s vlastními názvy sloupců)
    const src = await s.call('POST', '/api/v1/sources', {
      json: { name: 'Admin – ceny Velo', kind: 'offers', mapping: { fields: { code: 'sku', price: 'castka', shipping: 'posta' }, defaults: { competitor: 'VeloMarket.cz' } } },
    });
    assert.equal(src.status, 201, src.text);
    const veloCsv = 'sku;castka;posta\nSRA-00007;829;99\nMAX-00028;;0\n';
    const rs = await s.call('POST', `/api/v1/import/offers?source=${src.data.id}`, { as: T.imp, body: veloCsv, type: 'text/csv' });
    assert.equal(rs.status, 200, rs.text);
    assert.equal(rs.data.source_id, src.data.id);
    assert.equal(rs.data.stats.matched, 1);
    assert.equal(hardErrors(rs.data.stats).length, 1, 'řádek bez ceny je chyba');
    assert.match(hardErrors(rs.data.stats)[0].message, CZECH);
    const srcNow = await s.call('GET', `/api/v1/sources/${src.data.id}`, { as: T.read });
    assert.equal(srcNow.data.last_status, 'ok');
    const sramDetail = await s.call('GET', `/api/v1/products/${S.products.get('SRA-00007').id}`, { as: T.read });
    assert.equal(sramDetail.data.offers.find((o) => o.competitor === 'VeloMarket.cz').price, 829);
    // a zpět původní cena z XML (novější pozorování)
    assert.equal((await s.call('POST', '/api/v1/import/offers', { as: T.imp, body: example('konkurence.xml'), type: 'application/xml' })).status, 200);

    // nespárované nabídky: neznámý EAN + neznámý kód
    const unknown = {
      items: [
        { ean: '8590000000999', competitor: 'VeloMarket.cz', price: 1234, name: 'Neznámé kolo' },
        { code: 'NEEXISTUJE-1', competitor: 'NovýObchod.cz', price: 999, name: 'Neznámý díl' },
      ],
    };
    const ru = await s.call('POST', '/api/v1/import/offers', { as: T.imp, json: unknown });
    assert.equal(ru.status, 200, ru.text);
    assert.equal(ru.data.stats.matched, 0);
    assert.equal(ru.data.stats.unmatched, 2);
    assert.equal(ru.data.stats.competitors_created, 1);

    const um = await s.call('GET', '/api/v1/unmatched', { as: T.read });
    assert.equal(um.status, 200);
    assert.equal(um.data.total, 2);
    assert.deepEqual(um.data.items.map((u) => u.name).sort(), ['Neznámé kolo', 'Neznámý díl']);
    S.unmatched = um.data.items;

    const comp = await s.call('GET', '/api/v1/competitors', { as: T.read });
    assert.equal(comp.status, 200);
    assert.equal(comp.data.items.length, 8);
    const velo = comp.data.items.find((c) => c.name === 'VeloMarket.cz');
    assert.ok(velo, 'VeloMarket.cz');
    assert.ok(velo.offers > 0);
    assert.equal(comp.data.items.reduce((a, c) => a + c.offers, 0), 123);
    const nov = comp.data.items.find((c) => c.name === 'NovýObchod.cz');
    assert.equal(nov.offers, 0);

    // ruční spárování nespárované nabídky s produktem → alias, nabídka se naimportuje
    const target = S.products.get('ABU-00056');
    const u = S.unmatched.find((x) => x.name === 'Neznámý díl');
    const m = await s.call('POST', `/api/v1/unmatched/${u.id}/match`, { json: { product_id: target.id } });
    assert.equal(m.status, 200, m.text);
    assert.equal(m.data.ok, true);
    const um2 = await s.call('GET', '/api/v1/unmatched', { as: T.read });
    assert.equal(um2.data.total, 1);
    // další import stejné nabídky se už spáruje přes alias
    const again = await s.call('POST', '/api/v1/import/offers', { as: T.imp, json: { items: [unknown.items[1]] } });
    assert.equal(again.data.stats.matched, 1);
    assert.equal(again.data.stats.unmatched, 0);

    const detail = await s.call('GET', `/api/v1/products/${target.id}`, { as: T.read });
    assert.equal(detail.status, 200);
    assert.ok(detail.data.offers.some((o) => o.competitor === 'NovýObchod.cz' && o.price === 999));
    // tuto testovací nabídku zakážeme (konkurent vypnut) – aby neovlivnila trh
    const off = await s.call('PATCH', `/api/v1/competitors/${nov.id}`, { json: { enabled: false } });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.data.enabled, false);

    // produkty už mají trh
    const list = await s.call('GET', '/api/v1/products?limit=100', { as: T.read });
    const withMarket = list.data.items.filter((p) => p.market_count > 0);
    assert.ok(withMarket.length >= 30, `produktů s trhem: ${withMarket.length}`);
    const abus = list.data.items.find((p) => p.code === 'ABU-00056');
    assert.ok(!abus.offers_count || abus.cheapest_competitor !== 'NovýObchod.cz', 'vypnutý konkurent se nepočítá');

    const imports = await s.call('GET', '/api/v1/imports', { as: T.imp });
    assert.equal(imports.status, 200);
    assert.ok(imports.data.items.every((i) => i.status === 'ok'));
    assert.ok(imports.data.items.every((i) => i.origin === 'api'));
  });

  test('4. segmenty a strategie, pořadí, simulace, přecenění, návrhy', async () => {
    const presets = await s.call('GET', '/api/v1/strategies/presets', { as: T.read });
    assert.equal(presets.status, 200);
    assert.ok(presets.data.items.some((p) => p.key === 'aged_stock_n7_n8'));

    // a) z předvolby – ležáky N7/N8 (vytvoří i segment)
    const pr = await s.call('POST', '/api/v1/strategies/presets/aged_stock_n7_n8');
    assert.equal(pr.status, 201, pr.text);
    assert.equal(pr.data.segment_created, true);
    const agedSeg = pr.data.segment;
    assert.equal(agedSeg.name, 'Ležáky N7/N8');
    const expectedAged = [...S.products.values()].filter((p) => ['N7', 'N8'].includes(p.attrs.N)).length;
    assert.equal(agedSeg.count, expectedAged);
    S.presetId = pr.data.strategy.id;
    // předvolba vzniká vypnutá (contract-4) – po kontrole ji zapneme
    assert.equal(pr.data.strategy.enabled, false);
    const en = await s.call('PUT', `/api/v1/strategies/${S.presetId}`, { json: { enabled: true } });
    assert.equal(en.status, 200, en.text);
    assert.equal(en.data.enabled, true);

    // b) vlastní segment + strategie s podmínkami a cílem „2. místo“, fallback next (min. 3 konkurenti)
    const seg = await s.call('POST', '/api/v1/segments', {
      json: { name: 'Pláště a komponenty', description: 'Díly', filter: { field: 'category', op: 'in', value: ['Pláště', 'Komponenty'] }, color: '#336699' },
    });
    assert.equal(seg.status, 201, seg.text);
    assert.equal(seg.data.count, [...S.products.values()].filter((p) => ['Pláště', 'Komponenty'].includes(p.category)).length);
    S.partsSeg = seg.data.id;
    const dup = await s.call('POST', '/api/v1/segments', { json: { name: 'pláště a KOMPONENTY', filter: {} } });
    assert.equal(dup.status, 409);

    const prev = await s.call('POST', '/api/v1/segments/preview', { as: T.read, json: { filter: { all: [{ field: 'category', op: '=', value: 'plaste' }, { field: 'stock', op: '>', value: 0 }] } } });
    assert.equal(prev.status, 200);
    assert.ok(prev.data.count > 0 && prev.data.sample.every((v) => v.category === 'Pláště' && v.stock > 0));

    const custom = await s.call('POST', '/api/v1/strategies', {
      json: {
        name: 'Díly – držet 2. místo',
        segment_id: S.partsSeg,
        config: {
          conditions: { all: [{ field: 'stock', op: '>', value: 0 }, { field: 'margin_pct', op: '>=', value: 5 }] },
          target: { mode: 'rank', rank: 2 },
          competitors: { min_competitors: 3 },
          limits: { min_margin_pct: 15, max_decrease_pct: 20 },
          fallback: { mode: 'next' },
        },
      },
    });
    assert.equal(custom.status, 201, custom.text);
    assert.equal(custom.data.config.target.rank, 2);
    assert.equal(custom.data.config.limits.min_margin_pct, 15);
    assert.equal(custom.data.config.rounding.mode, 'ending', 'config normalizován výchozími hodnotami');
    S.customId = custom.data.id;

    // neplatná konfigurace → 400 s českými chybami
    const badCfg = await s.call('POST', '/api/v1/strategies', { json: { name: 'Špatná', config: { target: { mode: 'neexistuje' } } } });
    assertCzech400(badCfg, 'neplatný config');
    assert.ok(Array.isArray(badCfg.data.error.details) && badCfg.data.error.details.length > 0);

    // c) záchytná strategie pro všechno, fallback next (bez trhu → propadne, žádná další → no_strategy)
    const all = await s.call('POST', '/api/v1/strategies', {
      json: { name: 'Vše – medián −2 %', config: { target: { mode: 'market_median', offset_pct: -2 }, limits: { min_margin_pct: 12 }, fallback: { mode: 'next' } } },
    });
    assert.equal(all.status, 201, all.text);
    assert.equal(all.data.segment_id, null);
    S.catchAllId = all.data.id;

    // pořadí: vlastní → předvolba → záchytná
    const ro = await s.call('POST', '/api/v1/strategies/reorder', { json: { ids: [S.customId, S.presetId, S.catchAllId] } });
    assert.equal(ro.status, 200, ro.text);
    assert.deepEqual(
      ro.data.items.map((x) => [x.id, x.priority]),
      [
        [S.customId, 10],
        [S.presetId, 20],
        [S.catchAllId, 30],
      ]
    );
    const segs = await s.call('GET', '/api/v1/segments', { as: T.read });
    const partsItem = segs.data.items.find((g) => g.id === S.partsSeg);
    assert.deepEqual(partsItem.strategies.map((x) => x.id), [S.customId]);
    // segment používaný strategií nejde smazat
    const del = await s.call('DELETE', `/api/v1/segments/${S.partsSeg}`);
    assert.equal(del.status, 409);

    // simulace (read token) – nic se nezapíše
    const sim = await s.call('POST', '/api/v1/simulate', {
      as: T.read,
      json: { config: { target: { mode: 'undercut_min', offset_abs: -10 }, limits: { min_margin_pct: 5 } }, filter: { field: 'manufacturer', op: '=', value: 'Kellys' } },
    });
    assert.equal(sim.status, 200, sim.text);
    assert.equal(sim.data.stats.products, [...S.products.values()].filter((p) => p.manufacturer === 'Kellys').length);
    assert.ok(sim.data.decisions.length > 0);
    assert.ok(sim.data.decisions.every((d) => d.product && d.product.code && Array.isArray(d.explain)));
    const runsBefore = await s.call('GET', '/api/v1/runs', { as: T.read });
    assert.equal(runsBefore.data.total, 0, 'simulace nevytváří běh');

    // přecenění
    const run = await s.call('POST', '/api/v1/runs', { json: {} });
    assert.equal(run.status, 200, run.text);
    const st = run.data.stats;
    S.runId = run.data.run_id;
    assert.equal(st.products, 40);
    assert.ok(st.changes > 0);
    assert.equal(st.changes, st.up + st.down);
    assert.equal(st.pending + st.auto_approved, st.changes);
    assert.ok(st.fallthrough > 0, 'aspoň jeden produkt propadl na další strategii');
    assert.ok(st.no_strategy > 0, 'produkty bez trhu nemají strategii (záchytná propadne)');
    assert.ok(st.by_strategy[S.customId] && st.by_strategy[S.presetId] && st.by_strategy[S.catchAllId]);

    const runDetail = await s.call('GET', `/api/v1/runs/${S.runId}`, { as: T.read });
    assert.equal(runDetail.status, 200);
    assert.equal(runDetail.data.trigger, 'manual');
    assert.equal(runDetail.data.status, 'done');
    assert.equal(runDetail.data.proposals.pending, st.pending);

    const props = await s.call('GET', '/api/v1/proposals?limit=500', { as: T.read });
    assert.equal(props.status, 200);
    assert.equal(props.data.total, st.pending);
    assert.equal(props.data.summary.pending, st.pending);
    assert.equal(props.data.summary.up + props.data.summary.down, st.pending);
    for (const p of props.data.items) {
      assert.equal(p.status, 'pending');
      assert.ok(p.explain.length >= 3, 'vysvětlení má kroky');
      assert.ok(p.explain.every((e) => typeof e.step === 'string' && typeof e.text === 'string'));
      assert.ok(Array.isArray(p.flags));
      assert.ok(p.new_price > 0 && p.new_price !== p.old_price);
      // floor vždy platí: nová cena ≥ nákup s DPH (min. marže ≥ 3 % u všech strategií)
      assert.ok(p.new_price / (1 + p.product.vat_rate / 100) > p.product.purchase_price, `${p.product.code} pod nákupem`);
      assert.ok(p.explain.some((e) => /Kč/.test(e.text)));
    }
    // propadnutí: vysvětlení začíná krokem „Strategie … nepoužita“ a rozhodla záchytná strategie
    const fell = props.data.items.filter((p) => p.explain[0].step === 'fallthrough');
    assert.ok(fell.length > 0, 'návrh po propadnutí');
    for (const p of fell) {
      assert.match(p.explain[0].text, /nepoužita/);
      // propadnout může jen vlastní strategie (min. 3 konkurenti) nebo předvolba – rozhodla některá další
      assert.match(p.explain[0].text, /Díly – držet 2\. místo|Ležáky N7\/N8/);
      assert.notEqual(p.strategy_id, S.customId);
    }
    assert.ok(fell.some((p) => p.strategy_id === S.catchAllId));
    // vlastní strategie cílí na 2. místo: reference = 2. nejnižší použitá cena trhu (skladem, min. 3 konkurenti)
    const rank2 = props.data.items.filter((p) => p.strategy_id === S.customId);
    assert.ok(rank2.length > 0, 'vlastní strategie rozhodla aspoň jeden produkt');
    for (const p of rank2) {
      assert.equal(p.segment_id, S.partsSeg);
      assert.ok(['Pláště', 'Komponenty'].includes(p.product.category));
      assert.ok(p.product.stock > 0, 'podmínka stock > 0');
      const det = await s.call('GET', `/api/v1/products/${p.product_id}`, { as: T.read });
      const used = det.data.offers.filter((o) => o.used !== false && o.in_stock !== 0 && o.competitor !== 'NovýObchod.cz').map((o) => o.price).sort((a, b) => a - b);
      assert.ok(used.length >= 3, `${p.product.code}: konkurentů ${used.length}`);
      assert.equal(p.reference_price, used[1], `${p.product.code}: reference = 2. nejnižší cena`);
    }
    const flagged = props.data.items.filter((p) => p.flags.includes('big_change'));
    assert.ok(flagged.length > 0);
    const fl = await s.call('GET', '/api/v1/proposals?flag=big_change&limit=500', { as: T.read });
    assert.equal(fl.data.total, flagged.length);
    const down = await s.call('GET', '/api/v1/proposals?direction=down&limit=500', { as: T.read });
    assert.equal(down.data.total, props.data.summary.down);
    assert.ok(down.data.items.every((p) => p.new_price < p.old_price));

    // detail produktu s vysvětlením aktuálního rozhodnutí
    const one = props.data.items[0];
    const pd = await s.call('GET', `/api/v1/products/${one.product_id}`, { as: T.read });
    assert.equal(pd.status, 200);
    assert.equal(pd.data.proposals[0].id, one.id);
    assert.ok(pd.data.explain && pd.data.explain.decision);
    assert.ok(pd.data.offers.length > 0);

    // produkt s návrhem v seznamu produktů
    const hp = await s.call('GET', '/api/v1/products?has_proposal=1&limit=500', { as: T.read });
    assert.equal(hp.data.total, st.pending);
    assert.ok(hp.data.items.every((p) => p.proposal && p.proposal.status === 'pending'));

    S.proposals = props.data.items;
  });

  test('5. schválení, zamítnutí, ruční cena → feedy → ack', async () => {
    // vybereme 5 návrhů ke schválení, 1 k zamítnutí
    const pend = [...S.proposals].sort((a, b) => a.id - b.id);
    const approve = pend.slice(0, 5);
    const reject = pend[5];
    const ap = await s.call('POST', '/api/v1/proposals/approve', { json: { ids: approve.map((p) => p.id) } });
    assert.equal(ap.status, 200, ap.text);
    assert.equal(ap.data.updated, 5);
    const rj = await s.call('POST', '/api/v1/proposals/reject', { json: { ids: [reject.id] } });
    assert.equal(rj.status, 200);
    assert.equal(rj.data.updated, 1);
    // zamítnutý návrh nejde znovu schválit
    const ap2 = await s.call('POST', '/api/v1/proposals/approve', { json: { ids: [reject.id] } });
    assert.equal(ap2.data.updated, 0);

    // ruční cena u jednoho schváleného (o 100 Kč jinak než návrh)
    const manual = approve[0];
    const manualPrice = manual.new_price + (manual.new_price > manual.old_price ? -100 : 100);
    const mp = await s.call('PATCH', `/api/v1/proposals/${manual.id}`, { json: { manual_price: manualPrice } });
    assert.equal(mp.status, 200, mp.text);
    assert.equal(mp.data.manual_price, manualPrice);
    assert.equal(mp.data.final_price, manualPrice);
    // úprava ceny schváleného návrhu ho vrací ke schválení (money-7) – upravená cena nejde ven bez druhého pohledu
    assert.equal(mp.data.status, 'pending');
    const reap = await s.call('POST', '/api/v1/proposals/approve', { json: { ids: [manual.id] } });
    assert.equal(reap.data.updated, 1);
    const badMp = await s.call('PATCH', `/api/v1/proposals/${manual.id}`, { json: { manual_price: -5 } });
    assertCzech400(badMp, 'záporná ruční cena');

    const approved = await s.call('GET', '/api/v1/proposals?status=approved&limit=500', { as: T.read });
    assert.equal(approved.data.total, 5);
    const expected = new Map(approved.data.items.map((p) => [p.product.code, p.manual_price ?? p.new_price]));
    assert.equal(expected.get(manual.product.code), manualPrice);

    // feed bez tokenu → 401, s read tokenem → 403
    const noTok = await s.call('GET', '/feed/changes.json', { as: 'none' });
    assert.equal(noTok.status, 401);
    const readTok = await s.call('GET', `/feed/changes.json?token=${T.read}`, { as: 'none' });
    assert.equal(readTok.status, 403);

    // JSON
    const fj = await s.call('GET', `/feed/changes.json?token=${T.exp}`, { as: 'none' });
    assert.equal(fj.status, 200, fj.text);
    assert.match(fj.headers['content-type'], /json/);
    assert.equal(fj.data.count, 5);
    assert.equal(fj.data.currency, 'CZK');
    assert.equal(fj.data.items.length, 5);
    for (const row of fj.data.items) {
      assert.equal(row.price, expected.get(row.code), `cena ${row.code}`);
      assert.equal(typeof row.lowest_30d, 'number', `lowest_30d ${row.code}`);
      // katalog byl naimportován jednou → nejnižší cena za 30 dní = dosavadní cena
      assert.equal(row.lowest_30d, row.old_price);
      assert.ok(row.proposal_id > 0);
      assert.ok(row.vat_rate === 21);
    }
    // XML
    const fx = await s.call('GET', `/feed/changes.xml?token=${T.exp}`, { as: 'none' });
    assert.equal(fx.status, 200);
    assert.match(fx.headers['content-type'], /xml/);
    const doc = parseXml(fx.text);
    assert.equal(doc.name, 'prices');
    assert.equal(doc.attrs.count, '5');
    assert.equal(countElements(doc, 'item'), 5);
    const manualItem = doc.children.find((c) => c.children.find((x) => x.name === 'code' && x.text === manual.product.code));
    assert.equal(Number(manualItem.children.find((x) => x.name === 'price').text), manualPrice);
    // CSV
    const fc = await s.call('GET', `/feed/changes.csv?token=${T.exp}`, { as: 'none' });
    assert.equal(fc.status, 200);
    assert.match(fc.headers['content-type'], /csv/);
    const csv = parseCsv(decodeBuffer(Buffer.from(fc.text, 'utf8')));
    assert.equal(csv.rows.length, 5);
    // feed bez mark nic neoznačí
    const still = await s.call('GET', '/api/v1/proposals?status=approved', { as: T.read });
    assert.equal(still.data.total, 5);
    // HEAD s mark=1 nic neoznačí
    const head = await s.call('HEAD', `/feed/changes.json?mark=1&token=${T.exp}`, { as: 'none' });
    assert.equal(head.status, 200);
    assert.equal((await s.call('GET', '/api/v1/proposals?status=approved', { as: T.read })).data.total, 5);

    // ack podle kódů (+ jeden neznámý)
    const codes = [...expected.keys()];
    const ack = await s.call('POST', '/api/v1/export/ack', { as: T.exp, json: { codes: [...codes, 'NEZNAMY-KOD'] } });
    assert.equal(ack.status, 200, ack.text);
    assert.equal(ack.data.count, 5);
    assert.ok(ack.data.export_id > 0);
    assert.deepEqual(ack.data.unknown_codes, ['NEZNAMY-KOD']);
    S.ackExportId = ack.data.export_id;
    // opakovaný ack už nic neoznačí
    const ack2 = await s.call('POST', '/api/v1/export/ack', { as: T.exp, json: { codes } });
    assert.equal(ack2.data.count, 0);

    const exported = await s.call('GET', '/api/v1/proposals?status=exported&limit=500', { as: T.read });
    assert.equal(exported.data.total, 5);
    assert.ok(exported.data.items.every((p) => p.export_id === S.ackExportId && p.exported_at));

    // products.price aktualizována + historie 'export'
    const list = await s.call('GET', '/api/v1/products?limit=100', { as: T.read });
    const byCode = new Map(list.data.items.map((p) => [p.code, p]));
    for (const [code, price] of expected) {
      const p = byCode.get(code);
      assert.equal(p.price, price, `nová cena ${code}`);
      assert.ok(p.price_changed_at, 'price_changed_at');
      assert.equal(p.days_since_change, 0);
      const d = await s.call('GET', `/api/v1/products/${p.id}`, { as: T.read });
      const hist = d.data.history.our.filter((h) => h.source === 'export');
      assert.equal(hist.length, 1, `historie exportu ${code}`);
      assert.equal(hist[0].price, price);
      assert.equal(hist[0].ref_id, S.ackExportId);
      // produkt už nemá otevřený návrh
      assert.equal(p.proposal, null);
    }
    S.exportedPrices = expected;
    S.oldPrices = new Map(approved.data.items.map((p) => [p.product.code, p.old_price]));

    // úplný ceník – lowest_30d (Omnibus): po zdražení zůstává původní (nižší) cena, po zlevnění nová
    const prices = await s.call('GET', `/feed/prices.json?token=${T.exp}`, { as: 'none' });
    assert.equal(prices.status, 200);
    assert.equal(prices.data.count, 40);
    for (const row of prices.data.items) {
      assert.equal(typeof row.lowest_30d, 'number', row.code);
      if (!expected.has(row.code)) continue;
      const oldP = S.oldPrices.get(row.code);
      assert.equal(row.price, expected.get(row.code));
      assert.equal(row.lowest_30d, Math.min(oldP, expected.get(row.code)), `lowest_30d ${row.code}`);
    }
    const markPrices = await s.call('GET', `/feed/prices.json?mark=1&token=${T.exp}`, { as: 'none' });
    assertCzech400(markPrices, 'mark u ceníku');
    const unknownFeed = await s.call('GET', `/feed/neco.json?token=${T.exp}`, { as: 'none' });
    assert.equal(unknownFeed.status, 404);
  });

  test('6. POHODA XML (windows-1250, mark=1) + XSD, varianta s cenovou hladinou', async () => {
    // nic schváleného → 409 s českou zprávou
    const empty = await s.call('GET', '/api/v1/export/pohoda.xml', { as: T.exp });
    assert.equal(empty.status, 409);
    assert.match(empty.data.error.message, CZECH);

    const pend = await s.call('GET', '/api/v1/proposals?status=pending&sort=id&limit=500', { as: T.read });
    const batch = pend.data.items.slice(0, 3);
    const ap = await s.call('POST', '/api/v1/proposals/approve', { json: { ids: batch.map((p) => p.id) } });
    assert.equal(ap.data.updated, 3);

    const px = await rawGet(s, '/api/v1/export/pohoda.xml?mark=1', T.exp);
    assert.equal(px.status, 200, px.text);
    assert.match(px.headers['content-type'], /xml/i);
    assert.match(px.headers['content-disposition'] || '', /attachment/);
    assert.ok(Number(px.headers['x-export-id']) > 0, 'X-Export-Id');
    const marked = px.body;
    const buf = (await rawGet(s, '/api/v1/export/pohoda.xml?scope=all', T.exp)).body;
    assert.match(marked.toString('latin1').slice(0, 100), /encoding="Windows-1250"/i);
    const xmlText = decodeBuffer(marked, { encoding: 'windows-1250' });
    assert.equal((xmlText.match(/<dat:dataPackItem\b/g) || []).length, 3);
    for (const p of batch) assert.ok(xmlText.includes(`<ftr:code>${p.product.code}</ftr:code>`), p.product.code);
    assert.ok(/<stk:sellingPrice payVAT="true">\d+(\.\d+)?<\/stk:sellingPrice>/.test(xmlText));
    // označeno jako exportované
    const ex = await s.call('GET', '/api/v1/proposals?status=exported&limit=500', { as: T.read });
    assert.equal(ex.data.total, 8);
    const again = await s.call('GET', '/api/v1/export/pohoda.xml?mark=1', { as: T.exp });
    assert.equal(again.status, 409, 'podruhé už není co exportovat');
    for (const p of batch) {
      S.exportedPrices.set(p.product.code, p.new_price);
      S.oldPrices.set(p.product.code, p.old_price);
    }

    // úplný ceník v POHODA XML (scope=all) – 40 položek
    const allText = decodeBuffer(buf, { encoding: 'windows-1250' });
    assert.equal((allText.match(/<dat:dataPackItem\b/g) || []).length, 40);
    assert.ok(allText.includes('Cannondale') || allText.includes('<ftr:code>'), 'obsahuje kódy');

    // cenová hladina + IČO z nastavení
    const set = await s.call('PUT', '/api/v1/settings', { json: { export: { pohoda: { price_level: 'Eshop', ico: '12345678' } } } });
    assert.equal(set.status, 200, set.text);
    const lvl = await rawGet(s, '/api/v1/export/pohoda.xml?scope=all', T.exp);
    assert.equal(lvl.status, 200);
    const lvlText = decodeBuffer(lvl.body, { encoding: 'windows-1250' });
    assert.ok(lvlText.includes('dis:discount'), 'agenda cenových hladin');
    assert.ok(lvlText.includes('ico="12345678"'));
    const utf = await rawGet(s, '/api/v1/export/pohoda.xml?scope=all&encoding=utf-8', T.exp);
    assert.match(utf.body.toString('utf8').slice(0, 100), /encoding="UTF-8"/i);
    const badEnc = await s.call('GET', '/api/v1/export/pohoda.xml?encoding=latin2', { as: T.exp });
    assertCzech400(badEnc, 'neplatné kódování');

    if (XSD_DIR && HAS_XMLLINT) {
      xmllint(marked, 'pohoda-mark-1250');
      xmllint(buf, 'pohoda-all-1250');
      xmllint(lvl.body, 'pohoda-level-1250');
      xmllint(utf.body, 'pohoda-level-utf8');
    }
    // zpět bez cenové hladiny
    const reset = await s.call('PUT', '/api/v1/settings', { json: { export: { pohoda: { price_level: '', ico: '' } } } });
    assert.equal(reset.status, 200);
  });

  test('7. webhook: nastavení URL → POST /export/push', async () => {
    // bez URL → 400
    const noUrl = await s.call('POST', '/api/v1/export/push', { as: T.exp, json: {} });
    assertCzech400(noUrl, 'push bez URL');

    const set = await s.call('PUT', '/api/v1/settings', { json: { export: { webhook: { url: `${hook.url}/ceny`, headers: { 'X-Admin-Key': 'tajne-123' } } } } });
    assert.equal(set.status, 200, set.text);
    const masked = await s.call('GET', '/api/v1/settings', { as: T.read });
    assert.equal(masked.data.export.webhook.headers['X-Admin-Key'], '***');

    const pend = await s.call('GET', '/api/v1/proposals?status=pending&sort=id&limit=500', { as: T.read });
    const batch = pend.data.items.slice(0, 4);
    const ap = await s.call('POST', '/api/v1/proposals/approve', { json: { ids: batch.map((p) => p.id) } });
    assert.equal(ap.data.updated, 4);

    const push = await s.call('POST', '/api/v1/export/push', { as: T.exp, json: {} });
    assert.equal(push.status, 200, push.text);
    assert.equal(push.data.ok, true);
    assert.equal(push.data.count, 4);
    assert.equal(push.data.marked, 4);
    assert.ok(push.data.export_id > 0);
    assert.equal(hook.received.length, 1);
    const got = hook.received[0];
    assert.equal(got.method, 'POST');
    assert.equal(got.url, '/ceny');
    assert.equal(got.headers['x-admin-key'], 'tajne-123');
    assert.match(got.headers['content-type'], /json/);
    assert.equal(got.json.count, 4);
    assert.deepEqual(got.json.items.map((i) => i.code).sort(), batch.map((p) => p.product.code).sort());
    assert.ok(got.json.items.every((i) => typeof i.lowest_30d === 'number'));

    const ex = await s.call('GET', '/api/v1/proposals?status=exported&limit=500', { as: T.read });
    assert.equal(ex.data.total, 12);
    // nic dalšího k odeslání
    const push2 = await s.call('POST', '/api/v1/export/push', { as: T.exp, json: {} });
    assert.equal(push2.status, 200);
    assert.equal(push2.data.count, 0);
    assert.equal(hook.received.length, 1);
    for (const p of batch) {
      S.exportedPrices.set(p.product.code, p.manual_price ?? p.new_price);
      S.oldPrices.set(p.product.code, p.old_price);
    }
  });

  test('7b. webhook: odmítnutí adminem nic neoznačí, formát XML', async () => {
    const bad = await webhookReceiver({ status: 422 });
    try {
      const set = await s.call('PUT', '/api/v1/settings', { json: { export: { webhook: { url: `${bad.url}/x` } } } });
      assert.equal(set.status, 200);
      const pend = await s.call('GET', '/api/v1/proposals?status=pending&sort=id&limit=500', { as: T.read });
      const batch = pend.data.items.slice(0, 2);
      assert.equal((await s.call('POST', '/api/v1/proposals/approve', { json: { ids: batch.map((p) => p.id) } })).data.updated, 2);
      const push = await s.call('POST', '/api/v1/export/push', { as: T.exp, json: {} });
      assert.ok(push.status < 500, push.text);
      assert.equal(push.data.ok, false);
      assert.equal(push.data.marked, 0);
      assert.equal(push.data.status, 422);
      assert.match(push.data.error, CZECH);
      assert.equal(bad.received.length, 1, '4xx se neopakuje');
      assert.equal((await s.call('GET', '/api/v1/proposals?status=approved', { as: T.read })).data.total, 2, 'návrhy zůstaly schválené');
      const log = await s.call('GET', '/api/v1/exports', { as: T.read });
      assert.equal(log.data.items[0].status, 'error');
      assert.equal(log.data.items[0].kind, 'webhook');

      // XML formát na funkční přijímač
      const set2 = await s.call('PUT', '/api/v1/settings', { json: { export: { webhook: { url: `${hook.url}/xml`, format: 'xml' } } } });
      assert.equal(set2.status, 200);
      const n0 = hook.received.length;
      const push2 = await s.call('POST', '/api/v1/export/push', { as: T.exp, json: {} });
      assert.equal(push2.status, 200, push2.text);
      assert.equal(push2.data.ok, true);
      assert.equal(push2.data.marked, 2);
      const got = hook.received[n0];
      assert.match(got.headers['content-type'], /xml/);
      const doc = parseXml(got.body);
      assert.equal(doc.attrs.count, '2');
      assert.deepEqual(doc.children.map((c) => c.children.find((x) => x.name === 'code').text).sort(), batch.map((p) => p.product.code).sort());
      for (const p of batch) {
        S.exportedPrices.set(p.product.code, p.new_price);
        S.oldPrices.set(p.product.code, p.old_price);
      }
      S.exportedCount = 14;
      assert.equal((await s.call('PUT', '/api/v1/settings', { json: { export: { webhook: { format: 'json' } } } })).status, 200);
    } finally {
      await bad.close();
    }
  });

  test('8. uzavření smyčky: import katalogu s novými cenami → bez not_applied; jiná cena → not_applied', async () => {
    // simulace plynutí času: exporty proběhly před 2 dny (upozornění not_applied hlídá exporty starší 24 h)
    const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS).toISOString();
    s.db.prepare("UPDATE proposals SET exported_at = ? WHERE status = 'exported'").run(twoDaysAgo);
    s.db.prepare("UPDATE price_history SET at = ? WHERE source = 'export'").run(twoDaysAgo);

    // admin ceny převzal → další import katalogu už obsahuje nové ceny
    const list = await s.call('GET', '/api/v1/products?limit=100', { as: T.read });
    const current = new Map(list.data.items.map((p) => [p.code, p.price]));
    for (const [code, price] of S.exportedPrices) assert.equal(current.get(code), price, code);
    const csv1 = catalogWithPrices(S.exportedPrices);
    const r1 = await s.call('POST', '/api/v1/import/products', { as: T.imp, body: csv1, type: 'text/csv' });
    assert.equal(r1.status, 200, r1.text);
    assert.equal(r1.data.stats.unchanged, 40, 'ceny už odpovídají exportu');
    const d1 = await s.call('GET', '/api/v1/dashboard', { as: T.read });
    assert.equal(d1.status, 200);
    assert.ok(!d1.data.alerts.some((a) => a.type === 'not_applied'), JSON.stringify(d1.data.alerts.map((a) => a.type)));

    // admin jednu cenu nepřevzal → import katalogu vrátí starou cenu
    const [code] = [...S.exportedPrices.keys()];
    const prices2 = new Map(S.exportedPrices);
    prices2.set(code, S.oldPrices.get(code) ?? current.get(code) + 1000);
    const r2 = await s.call('POST', '/api/v1/import/products', { as: T.imp, body: catalogWithPrices(prices2), type: 'text/csv' });
    assert.equal(r2.status, 200);
    assert.equal(r2.data.stats.updated, 1);
    const d2 = await s.call('GET', '/api/v1/dashboard', { as: T.read });
    const na = d2.data.alerts.find((a) => a.type === 'not_applied');
    assert.ok(na, 'upozornění not_applied');
    assert.equal(na.count, 1);
    assert.equal(na.severity, 'warn');
    assert.match(na.text, CZECH);
    assert.equal(na.product_id, S.products.get(code).id);
    // import zapsal historii ceny 'import'
    const pd = await s.call('GET', `/api/v1/products/${S.products.get(code).id}`, { as: T.read });
    assert.ok(pd.data.history.our.some((h) => h.source === 'import' && h.price === prices2.get(code)));
    S.notAppliedCode = code;

    // úplný katalog bez jednoho produktu + deactivate_missing → produkt neaktivní, zmizí z ceníku; pak zpět
    const csvAll = catalogWithPrices(prices2);
    const without = csvAll.split('\r\n').filter((l) => !l.startsWith('GIR-00203;')).join('\r\n');
    const r3 = await s.call('POST', '/api/v1/import/products?deactivate_missing=1', { as: T.imp, body: without, type: 'text/csv' });
    assert.equal(r3.status, 200, r3.text);
    assert.equal(r3.data.stats.deactivated, 1);
    const inactive = await s.call('GET', '/api/v1/products?status=inactive', { as: T.read });
    assert.deepEqual(inactive.data.items.map((p) => p.code), ['GIR-00203']);
    const feedAll = await s.call('GET', `/feed/prices.json?token=${T.exp}`, { as: 'none' });
    assert.equal(feedAll.data.count, 39);
    assert.ok(!feedAll.data.items.some((i) => i.code === 'GIR-00203'));
    const d3 = await s.call('GET', '/api/v1/dashboard', { as: T.read });
    assert.equal(d3.data.products.active, 39);
    const r4 = await s.call('POST', '/api/v1/import/products?deactivate_missing=1', { as: T.imp, body: csvAll, type: 'text/csv' });
    assert.equal(r4.status, 200);
    assert.equal(r4.data.stats.updated, 1, 'znovu aktivní');
    assert.equal((await s.call('GET', '/api/v1/products?status=inactive', { as: T.read })).data.total, 0);
  });

  test('8b. druhé přecenění: superseded, zámek produktu, ruční cena produktu, nové návrhy vychází z exportovaných cen', async () => {
    const pendBefore = await s.call('GET', '/api/v1/proposals?status=pending&sort=id&limit=500', { as: T.read });
    assert.ok(pendBefore.data.total >= 2);
    // jeden čekající návrh schválíme – nový běh se stejným výsledkem ho ponechá i se schválením (ops-1)
    const keepApproved = pendBefore.data.items[0];
    assert.equal((await s.call('POST', '/api/v1/proposals/approve', { json: { ids: [keepApproved.id] } })).data.updated, 1);
    // zámek produktu s čekajícím návrhem → nový běh ho přeskočí (locked)
    const lockedP = pendBefore.data.items[1];
    const lk = await s.call('PATCH', `/api/v1/products/${lockedP.product_id}`, { json: { locked: true, note: 'Akční cena – nesahat' } });
    assert.equal(lk.status, 200, lk.text);
    assert.equal(lk.data.lock_active, true);
    // zámek otevřený návrh rovnou zneplatní (money-1) – schválený by jinak odešel do exportu
    const lockedNow = await s.call('GET', `/api/v1/proposals?status=all&product=${lockedP.product_id}`, { as: T.read });
    assert.equal(lockedNow.data.items.find((p) => p.id === lockedP.id).status, 'superseded');
    // ruční změna ceny produktu (price → historie 'manual')
    const manualP = [...S.products.values()].find((p) => !S.exportedPrices.has(p.code) && p.id !== lockedP.product_id && p.price > 1000);
    const manualPrice = manualP.price + 100;
    const mp = await s.call('PATCH', `/api/v1/products/${manualP.id}`, { json: { price: manualPrice } });
    assert.equal(mp.status, 200, mp.text);
    assert.equal(mp.data.price, manualPrice);
    const readOnly = await s.call('PATCH', `/api/v1/products/${manualP.id}`, { as: T.read, json: { price: 1 } });
    assert.equal(readOnly.status, 403);

    const run2 = await s.call('POST', '/api/v1/runs', { json: {} });
    assert.equal(run2.status, 200, run2.text);
    assert.equal(run2.data.stats.skipped.locked, 1, JSON.stringify(run2.data.stats.skipped));
    assert.ok(run2.data.stats.superseded + run2.data.stats.kept >= pendBefore.data.total - 2, JSON.stringify(run2.data.stats));

    const old = await s.call('GET', `/api/v1/proposals?status=superseded&run=${S.runId}&limit=500`, { as: T.read });
    assert.ok(old.data.items.every((p) => p.run_id === S.runId));
    // schválený návrh se stejnou cenou zůstal schválený a patří k novému běhu (lidské rozhodnutí se nezahodí)
    const kept = await s.call('GET', `/api/v1/proposals?status=all&product=${keepApproved.product_id}`, { as: T.read });
    const keptItem = kept.data.items.find((p) => p.id === keepApproved.id);
    if (keptItem.status !== 'superseded') {
      assert.equal(keptItem.status, 'approved');
      assert.equal(keptItem.decided_by, 'admin');
      assert.equal(keptItem.run_id, run2.data.run_id);
    }
    // zamčený produkt byl vyhodnocen (skip locked) → jeho starý návrh je nahrazen a nový nevznikl
    const lockedProp = await s.call('GET', `/api/v1/proposals?status=all&product=${lockedP.product_id}`, { as: T.read });
    assert.equal(lockedProp.data.items.find((p) => p.id === lockedP.id).status, 'superseded');
    assert.ok(!lockedProp.data.items.some((p) => p.run_id === run2.data.run_id));
    const pd = await s.call('GET', `/api/v1/products/${lockedP.product_id}`, { as: T.read });
    assert.equal(pd.data.explain.decision.reason, 'locked');

    // exportované produkty: nový návrh (pokud je) vychází z exportované ceny
    const cur = await s.call('GET', `/api/v1/proposals?run=${run2.data.run_id}&limit=500`, { as: T.read });
    for (const p of cur.data.items) {
      if (S.exportedPrices.has(p.product.code) && p.product.code !== S.notAppliedCode) assert.equal(p.old_price, S.exportedPrices.get(p.product.code), p.product.code);
      if (p.product_id === manualP.id) assert.equal(p.old_price, manualPrice);
    }
    // exportované návrhy z 1. běhu zůstaly exportované
    const ex = await s.call('GET', '/api/v1/proposals?status=exported&limit=500', { as: T.read });
    assert.equal(ex.data.total, S.exportedCount);
    const det = await s.call('GET', `/api/v1/products/${manualP.id}`, { as: T.read });
    assert.deepEqual(
      det.data.history.our.map((h) => [h.source, h.price]),
      [
        ['import', manualP.price],
        ['manual', manualPrice],
      ]
    );
    S.runId = run2.data.run_id;
    // zámek po vytvoření návrhu = ruční přebití → návrh nejde schválit (skipped_locked)
    const fresh = cur.data.items.find((p) => p.status === 'pending');
    assert.equal((await s.call('PATCH', `/api/v1/products/${fresh.product_id}`, { json: { locked_until: new Date(Date.now() + DAY_MS).toISOString() } })).status, 200);
    const apLocked = await s.call('POST', '/api/v1/proposals/approve', { json: { ids: [fresh.id] } });
    assert.equal(apLocked.data.updated, 0);
    // zámek návrh zneplatnil hned (money-1), schvalovat už není co
    const freshNow = await s.call('GET', `/api/v1/proposals?status=all&product=${fresh.product_id}`, { as: T.read });
    assert.equal(freshNow.data.items.find((p) => p.id === fresh.id).status, 'superseded');
    // zámky zpět
    for (const id of [lockedP.product_id, fresh.product_id]) {
      const u = await s.call('PATCH', `/api/v1/products/${id}`, { json: { locked: false, locked_until: null } });
      assert.equal(u.status, 200, u.text);
      assert.equal(u.data.lock_active, false);
    }
  });

  test('9. přehled, pole, facety, běhy, log exportů a audit', async () => {
    const d = await s.call('GET', '/api/v1/dashboard', { as: T.read });
    assert.equal(d.status, 200);
    const db = d.data;
    assert.equal(db.products.active, 40);
    assert.equal(db.products.with_market + db.products.without_market, 40);
    assert.ok(db.products.with_market >= 30);
    const pos = db.position;
    assert.equal(pos.cheapest + pos.middle + pos.most_expensive + pos.no_data, 40);
    assert.equal(pos.no_data, db.products.without_market);
    assert.ok(db.price_index.vs_min > 0);
    assert.equal(db.proposals.approved, (await s.call('GET', '/api/v1/proposals?status=approved', { as: T.read })).data.total);
    assert.equal(db.proposals.exported_7d, S.exportedCount);
    const pendingNow = (await s.call('GET', '/api/v1/proposals?status=pending', { as: T.read })).data.total;
    assert.equal(db.proposals.pending, pendingNow);
    assert.equal(db.last_run.id, S.runId);
    assert.ok(db.last_imports.length > 0 && db.last_imports.length <= 5);
    assert.equal(db.last_imports[0].kind, 'products');
    assert.equal(db.competitors.length, 7, 'vypnutý konkurent se nezobrazuje');
    assert.ok(db.by_manufacturer.some((m) => m.manufacturer === 'Cannondale' && m.products === [...S.products.values()].filter((p) => p.manufacturer === 'Cannondale').length));
    const um = db.alerts.find((a) => a.type === 'unmatched');
    assert.ok(um && um.count === 1);
    for (const a of db.alerts) {
      assert.ok(['info', 'warn', 'error'].includes(a.severity));
      assert.match(a.text, CZECH);
    }

    const f = await s.call('GET', '/api/v1/fields', { as: T.read });
    assert.equal(f.status, 200);
    const keys = new Set(f.data.fields.map((x) => x.key));
    for (const k of ['code', 'manufacturer', 'margin_pct', 'position', 'market_min', 'attrs.N', 'attrs.Sezóna']) assert.ok(keys.has(k), `pole ${k}`);
    assert.ok(f.data.fields.every((x) => typeof x.label === 'string' && x.label.length > 0));

    const fc = await s.call('GET', '/api/v1/products/facets', { as: T.read });
    assert.equal(fc.status, 200);
    const cann = fc.data.manufacturers.find((m) => m.value === 'Cannondale');
    assert.equal(cann.count, [...S.products.values()].filter((p) => p.manufacturer === 'Cannondale').length);
    assert.ok(fc.data.owners.some((o) => o.value === 'Jana Nováková'));
    assert.ok(fc.data.attrs.N && fc.data.attrs.N.some((v) => v.value === 'N7'));

    const runs = await s.call('GET', '/api/v1/runs', { as: T.read });
    assert.equal(runs.data.total, 2);
    assert.ok(runs.data.items.every((r) => r.stats.products === 40 && r.status === 'done'));

    const exps = await s.call('GET', '/api/v1/exports', { as: T.read });
    assert.equal(exps.status, 200);
    const kinds = exps.data.items.map((e) => e.kind);
    assert.ok(kinds.includes('ack'), kinds.join());
    assert.ok(kinds.includes('pohoda'), kinds.join());
    assert.ok(kinds.includes('webhook'), kinds.join());
    assert.equal(exps.data.items.reduce((a, e) => a + (e.status === 'ok' ? e.count : 0), 0), S.exportedCount);
    assert.equal(exps.data.items.filter((e) => e.status === 'error').length, 1);

    const au = await s.call('GET', '/api/v1/audit');
    assert.equal(au.status, 200);
    const actions = new Set(au.data.items.map((a) => a.action));
    for (const a of ['strategy.preset', 'strategy.create', 'strategy.reorder', 'run.start', 'proposals.approve', 'proposals.reject', 'proposal.manual_price', 'export', 'settings.update', 'product.update']) {
      assert.ok(actions.has(a), `audit ${a} (máme: ${[...actions].join(', ')})`);
    }
    const auRead = await s.call('GET', '/api/v1/audit', { as: T.read });
    assert.equal(auRead.status, 403, 'audit jen pro admina');

    // XLSX s návrhy a ceník
    const x = await rawGet(s, '/api/v1/export/proposals.xlsx?status=all', T.read);
    assert.equal(x.status, 200);
    assert.equal(x.body.subarray(0, 2).toString(), 'PK');
    const pl = await rawGet(s, '/api/v1/export/pricelist.xlsx', T.exp);
    assert.equal(pl.status, 200);
    assert.equal(pl.body.subarray(0, 2).toString(), 'PK');
  });
});

// =========================================================================================================
describe('E2E 10: plánovač – zdroj s URL, přecenění po importu, automatické odeslání webhookem', () => {
  let s2;
  let feed;
  let hook;
  let served = 0;
  before(async () => {
    feed = await localServer((req, res) => {
      served++;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(example('konkurence.xml'));
    });
    hook = await webhookReceiver();
    // plánovač zapnutý (časovače dlouhé, tik se volá ručně přes vrácený handle)
    s2 = await startServer({ schedulerEnabled: true, scheduler: { initialDelayMs: 3600e3, intervalMs: 3600e3 } });
  });
  after(async () => {
    if (s2) await s2.stop();
    if (feed) await feed.close();
    if (hook) await hook.close();
  });

  test('tick: stažení zdroje → import → přecenění → automatické odeslání → označení', async () => {
    assert.ok(s2.app.scheduler && typeof s2.app.scheduler.tick === 'function', 'start() vrací handle plánovače');
    const imp = await s2.call('POST', '/api/v1/import/products', { body: example('katalog.csv'), type: 'text/csv' });
    assert.equal(imp.status, 200);
    assert.equal(imp.data.stats.created, 40);
    // naplnit cache pohledů ještě bez trhu (ověří, že se po importu z plánovače obnoví)
    const before0 = await s2.call('GET', '/api/v1/products?limit=100');
    assert.ok(before0.data.items.every((p) => p.market_count === 0));
    const dash0 = await s2.call('GET', '/api/v1/dashboard');
    assert.equal(dash0.data.products.with_market, 0);

    const st = await s2.call('POST', '/api/v1/strategies', {
      json: {
        name: 'Automat – medián',
        config: { target: { mode: 'market_median', offset_pct: -2 }, limits: { min_margin_pct: 5, max_decrease_pct: 30, max_increase_pct: 30 }, fallback: { mode: 'keep' }, approval: { auto: true, auto_max_change_pct: 100 } },
      },
    });
    assert.equal(st.status, 201, st.text);
    const src = await s2.call('POST', '/api/v1/sources', { json: { name: 'Srovnávač cen', kind: 'offers', url: `${feed.url}/ceny.xml`, interval_minutes: 60 } });
    assert.equal(src.status, 201, src.text);
    const set = await s2.call('PUT', '/api/v1/settings', { json: { schedule: { run_after_import: true }, export: { webhook: { url: `${hook.url}/push`, auto_push: true } } } });
    assert.equal(set.status, 200, set.text);

    const sum = await s2.app.scheduler.tick();
    assert.deepEqual(sum.errors, []);
    assert.equal(served, 1, 'zdroj stažen');
    assert.equal(sum.sources.length, 1);
    assert.equal(sum.sources[0].ok, true);
    assert.ok(sum.run && sum.run.ok, JSON.stringify(sum.run));
    assert.equal(sum.run.reason, 'import');
    assert.ok(sum.run.stats.auto_approved > 0, 'automaticky schválené změny');
    assert.ok(sum.push && sum.push.ok, JSON.stringify(sum.push));
    assert.equal(sum.push.count, sum.run.stats.auto_approved);

    // import ze zdroje zapsán s původem „schedule“
    const imports = await s2.call('GET', '/api/v1/imports?origin=schedule');
    assert.equal(imports.data.total, 1);
    assert.equal(imports.data.items[0].stats.matched, 123);
    assert.equal(imports.data.items[0].source_id, src.data.id);
    const srcNow = await s2.call('GET', `/api/v1/sources/${src.data.id}`);
    assert.equal(srcNow.data.last_status, 'ok');
    assert.ok(srcNow.data.last_run_at);
    // běh s triggerem schedule
    const runs = await s2.call('GET', '/api/v1/runs');
    assert.equal(runs.data.total, 1);
    assert.equal(runs.data.items[0].trigger, 'schedule');
    // webhook dostal položky, návrhy jsou exportované a ceny přepsané
    assert.equal(hook.received.length, 1);
    assert.equal(hook.received[0].url, '/push');
    assert.equal(hook.received[0].json.count, sum.push.count);
    assert.equal(hook.received[0].json.items.length, sum.push.count);
    const exported = await s2.call('GET', '/api/v1/proposals?status=exported&limit=500');
    assert.equal(exported.data.total, sum.push.count);
    const exps = await s2.call('GET', '/api/v1/exports');
    assert.equal(exps.data.items[0].kind, 'webhook');
    assert.equal(exps.data.items[0].status, 'ok');
    assert.equal(exps.data.items[0].count, sum.push.count);

    // přehledy vidí data z plánovače (cache se obnovila)
    const after1 = await s2.call('GET', '/api/v1/products?limit=100');
    assert.ok(after1.data.items.filter((p) => p.market_count > 0).length >= 30, 'produkty mají trh');
    const byCode = new Map(after1.data.items.map((p) => [p.code, p]));
    for (const it of hook.received[0].json.items) assert.equal(byCode.get(it.code).price, it.price, `cena ${it.code} po exportu`);
    const dash = await s2.call('GET', '/api/v1/dashboard');
    assert.ok(dash.data.products.with_market >= 30);
    assert.equal(dash.data.last_run.trigger, 'schedule');
    assert.equal(dash.data.proposals.exported_7d, sum.push.count);

    // další tik hned potom: zdroj ještě není na řadě, nic nového
    const sum2 = await s2.app.scheduler.tick();
    assert.equal(sum2.sources.length, 0);
    assert.equal(sum2.run, null);
    assert.equal(served, 1);

    // nabídky poslané přes API → příští tik přecení (run_after_import reaguje i na push import)
    const push = await s2.call('POST', '/api/v1/import/offers', { json: { items: [{ code: 'SRA-00007', competitor: 'VeloMarket.cz', price: 799 }] } });
    assert.equal(push.status, 200);
    assert.equal(push.data.stats.matched, 1);
    const sum3 = await s2.app.scheduler.tick();
    assert.ok(sum3.run && sum3.run.ok && sum3.run.reason === 'import', JSON.stringify(sum3.run));
    const runs2 = await s2.call('GET', '/api/v1/runs');
    assert.equal(runs2.data.total, 2);
  });
});

// =========================================================================================================
describe('E2E 11: cenová skupina, zkušební běh, import jen aktualizací, zrušení schválení, znovustažení exportu, jméno', () => {
  let s;
  const T = {};
  const GROUP = 'FOC-JAM-2026';
  const SIZES = ['JAM-S', 'JAM-M', 'JAM-L'];
  let jana; // požadavky se session přihlášenou se jménem

  before(async () => {
    s = await startServer();
    T.imp = await s.token(['import'], 'e2e11-import');
    T.exp = await s.token(['export'], 'e2e11-export');
    T.read = await s.token(['read'], 'e2e11-read');
    const login = await s.call('POST', '/api/v1/auth/login', { as: 'none', json: { password: PASSWORD, name: 'Jana Nováková' } });
    assert.equal(login.status, 200, login.text);
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    jana = (method, p, o = {}) => s.call(method, p, { ...o, as: 'none', headers: { ...(o.headers || {}), cookie, 'x-requested-with': 'cenotvorba' } });
  });
  after(async () => {
    if (s) await s.stop();
  });

  test('model kola ve 3 velikostech → jedna cena; dry run; update-only metriky; unapprove; re-download; decided_by', async () => {
    // přihlášení se jménem
    const me = await jana('GET', '/api/v1/auth/me');
    assert.equal(me.data.user, 'Jana Nováková');

    // katalog: sloupec „Model“ se sám namapuje na group_code (Skupina / model)
    const catalog = [
      'kod;nazev;vyrobce;Model;nakupni_cena;cena;moc',
      'JAM-S;Focus Jam 2026 vel. S;Focus;FOC-JAM-2026;50000;79990;84990',
      'JAM-M;Focus Jam 2026 vel. M;Focus;FOC-JAM-2026;50000;76990;84990',
      'JAM-L;Focus Jam 2026 vel. L;Focus;foc-jam-2026;50000;74990;84990',
      'LAHEV;Lahev Elite;Elite;;60;249;299',
    ].join('\n');
    const cat = await s.call('POST', '/api/v1/import/products', { as: T.imp, body: catalog, type: 'text/csv' });
    assert.equal(cat.status, 200, cat.text);
    assert.equal(cat.data.stats.created, 4);
    const grp = await s.call('GET', '/api/v1/products?filter=' + encodeURIComponent(JSON.stringify({ field: 'group_code', op: '=', value: GROUP })), { as: T.read });
    assert.equal(grp.status, 200);
    assert.deepEqual(grp.data.items.map((p) => p.code).sort(), ['JAM-L', 'JAM-M', 'JAM-S']);
    const fields = await s.call('GET', '/api/v1/fields', { as: T.read });
    assert.ok(fields.data.fields.some((f) => f.key === 'group_code' && f.label === 'Skupina / model'));

    const offers = await s.call('POST', '/api/v1/import/offers', {
      as: T.imp,
      json: {
        items: [
          { code: 'JAM-S', competitor: 'VeloMarket.cz', price: 80000 },
          { code: 'JAM-M', competitor: 'VeloMarket.cz', price: 78000 },
          { code: 'JAM-L', competitor: 'VeloMarket.cz', price: 76000 },
          { code: 'LAHEV', competitor: 'VeloMarket.cz', price: 239 },
        ],
      },
    });
    assert.equal(offers.status, 200, offers.text);
    assert.equal(offers.data.stats.matched, 4);

    const st = await jana('POST', '/api/v1/strategies', {
      json: {
        name: 'Focus – velikosti za jednu cenu',
        config: {
          target: { mode: 'undercut_min', offset_pct: -1 },
          limits: { min_margin_pct: 5, max_above_msrp_pct: 0, max_decrease_pct: 20, max_increase_pct: 20 },
          group: { align: 'max' },
        },
      },
    });
    assert.equal(st.status, 201, st.text);
    assert.equal(st.data.config.group.align, 'max');

    // zkušební běh celé sady: nic se nezapíše
    const dry = await jana('POST', '/api/v1/runs', { json: { dry_run: true } });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.data.run_id, null);
    assert.equal(dry.data.dry_run, true);
    assert.deepEqual(dry.data.stats.groups, { aligned: 1, conflicts: 0, members: 3 });
    const drySizes = dry.data.sample.filter((d) => SIZES.includes(d.product.code));
    assert.equal(drySizes.length, 3);
    assert.ok(drySizes.every((d) => d.action === 'change' && d.new_price === 78990 && d.flags.includes('group_aligned')));
    const absPct = dry.data.sample.map((d) => Math.abs(d.change_pct ?? 0));
    assert.deepEqual(absPct, [...absPct].sort((a, b) => b - a));
    assert.equal((await s.call('GET', '/api/v1/runs', { as: T.read })).data.total, 0);
    assert.equal((await s.call('GET', '/api/v1/proposals?status=all', { as: T.read })).data.total, 0);

    // skutečný běh: tři velikosti za 78 990 Kč
    const run = await jana('POST', '/api/v1/runs', { json: {} });
    assert.equal(run.status, 200, run.text);
    assert.ok(run.data.run_id > 0);
    const list = await s.call('GET', '/api/v1/proposals?' + new URLSearchParams({ filter: JSON.stringify({ field: 'group_code', op: '=', value: GROUP }) }), { as: T.read });
    assert.equal(list.data.total, 3);
    for (const p of list.data.items) {
      assert.equal(p.new_price, 78990, p.product.code);
      assert.ok(p.flags.includes('group_aligned'));
      assert.ok(p.explain.some((e) => /^Sjednoceno ve skupině FOC-JAM-2026 \(3 produkty, režim nejvyšší\) → 78\s990 Kč/.test(e.text)));
    }

    // metriky z Disiva: jen kód + imprese, neznámé kódy se nezakládají
    const pendingBefore = (await s.call('GET', '/api/v1/proposals', { as: T.read })).data.total;
    const metrics = await s.call('POST', '/api/v1/import/products?create_missing=0', { as: T.imp, body: 'kod;imprese_30\nJAM-S;1500\nJAM-M;900\nNEZNAMY-99;5\n', type: 'text/csv' });
    assert.equal(metrics.status, 200, metrics.text);
    assert.equal(metrics.data.stats.created, 0);
    assert.equal(metrics.data.stats.updated, 2);
    assert.equal(metrics.data.stats.skipped_unknown, 1);
    assert.deepEqual(metrics.data.stats.unknown_codes, ['NEZNAMY-99']);
    const all = await s.call('GET', '/api/v1/products?status=all', { as: T.read });
    assert.equal(all.data.total, 4);
    const jamS = all.data.items.find((p) => p.code === 'JAM-S');
    assert.equal(jamS.attrs.imprese_30, 1500);
    assert.equal(jamS.price, 79990, 'cena se importem metrik nezměnila');
    // otevřené návrhy import metrik nezneplatnil (cenové vstupy se nezměnily)
    assert.equal((await s.call('GET', '/api/v1/proposals', { as: T.read })).data.total, pendingBefore);

    // Jana schválí celou skupinu (filtr nad pohledem produktu), pak L vrátí ke schválení
    const appr = await jana('POST', '/api/v1/proposals/approve', { json: { all: true, filter: { filter: { field: 'group_code', op: '=', value: GROUP } }, include_flagged: true, expect: { count: 3 } } });
    assert.equal(appr.status, 200, appr.text);
    assert.equal(appr.data.updated, 3);
    const byCode = async () => Object.fromEntries((await s.call('GET', '/api/v1/proposals?status=all', { as: T.read })).data.items.map((p) => [p.product.code, p]));
    let m = await byCode();
    for (const c of SIZES) {
      assert.equal(m[c].status, 'approved');
      assert.equal(m[c].decided_by, 'Jana Nováková');
    }
    const un = await jana('POST', '/api/v1/proposals/unapprove', { json: { ids: [m['JAM-L'].id] } });
    assert.equal(un.status, 200, un.text);
    assert.deepEqual(un.data, { updated: 1 });
    m = await byCode();
    assert.equal(m['JAM-L'].status, 'pending');

    // export feedem s označením → znovustažení stejného exportu
    const feed = await s.call('GET', '/api/v1/export/changes.json?mark=1', { as: T.exp });
    assert.equal(feed.status, 200);
    assert.deepEqual(feed.data.items.map((i) => i.code).sort(), ['JAM-M', 'JAM-S']);
    const exportId = Number(feed.headers['x-export-id']);
    assert.ok(exportId > 0);
    const again = await s.call('GET', `/api/v1/exports/${exportId}/changes.json`, { as: T.exp });
    assert.equal(again.status, 200, again.text);
    assert.deepEqual(again.data.items.map((i) => [i.code, i.price]).sort(), [['JAM-M', 78990], ['JAM-S', 78990]]);
    const xml = await s.call('GET', `/api/v1/exports/${exportId}/changes.xml`, { as: T.exp });
    assert.equal(xml.status, 200);
    assert.equal(countElements(parseXml(xml.text), 'item'), 2);
    const exports = await s.call('GET', '/api/v1/exports', { as: T.read });
    assert.equal(exports.data.items.find((e) => e.id === exportId).redownload, true);
    // po exportu mají S a M novou cenu, L čeká na nové schválení
    const after = await s.call('GET', '/api/v1/products?status=all', { as: T.read });
    const prices = Object.fromEntries(after.data.items.map((p) => [p.code, p.price]));
    assert.equal(prices['JAM-S'], 78990);
    assert.equal(prices['JAM-M'], 78990);
    assert.equal(prices['JAM-L'], 74990);

    // audit nese jméno
    const au = await jana('GET', '/api/v1/audit');
    const byAction = (a) => au.data.items.filter((x) => x.action === a);
    assert.ok(byAction('proposals.approve').some((x) => x.actor === 'Jana Nováková'));
    assert.ok(byAction('proposals.unapprove').some((x) => x.actor === 'Jana Nováková'));
    assert.equal(byAction('run.start').length, 1, 'zkušební běh se neaudituje');
  });
});

// =========================================================================================================
describe('E2E: robustnost', () => {
  let s;
  let T;
  const S0 = { extra: 0 };
  before(async () => {
    s = await startServer();
    T = { imp: await s.token(['import']), read: await s.token(['read']), exp: await s.token(['export']) };
    const r = await s.call('POST', '/api/v1/import/products', { as: T.imp, body: example('katalog.csv'), type: 'text/csv' });
    assert.equal(r.status, 200);
  });
  after(async () => {
    if (s) await s.stop();
  });

  test('poškozená těla (XML, CSV, JSON, XLSX, ZIP, gzip) → 400 s českou zprávou, nikdy 500', async () => {
    const zlib = require('node:zlib');
    const cases = [
      ['offers', 'neukončené XML', '<prices><offer><ean>1</ean><price>10</price></prices>', 'application/xml'],
      ['offers', 'XML s nespárovanými tagy', '<?xml version="1.0"?><a><b></a></b>', 'text/xml'],
      ['offers', 'XML jen deklarace', '<?xml version="1.0" encoding="UTF-8"?>', 'application/xml'],
      ['products', 'XML bez produktů', '<katalog></katalog>', 'application/xml'],
      ['offers', 'neukončený JSON', '{"items": [{"ean": "1", "price": 10}', 'application/json'],
      ['offers', 'JSON null', 'null', 'application/json'],
      ['offers', 'JSON číslo', '42', 'application/json'],
      ['offers', 'JSON prázdné pole', '[]', 'application/json'],
      ['offers', 'JSON pole čísel', '[1,2,3]', 'application/json'],
      ['offers', 'JSON řetězec', '"ahoj"', 'application/json'],
      ['offers', 'JSON nabídky bez ceny', '{"items": [{"ean": "8597315660484", "competitor": "A"}]}', 'application/json'],
      ['offers', 'CSV jen hlavička', 'ean;cena;konkurent\r\n', 'text/csv'],
      ['offers', 'CSV nesmysl', 'toto není;tabulka\n"neukončené', 'text/csv'],
      ['products', 'CSV bez kódu', 'nazev;cena\nKolo;1000\n', 'text/csv'],
      ['offers', 'binární smetí', Buffer.from([0, 1, 2, 3, 255, 254, 0, 7, 8]), 'application/octet-stream'],
      ['offers', 'poškozené XLSX', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(200, 7)]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['products', 'ZIP bez datového souboru', require('../src/formats/zip').writeZip([{ name: 'readme.txt', data: 'nic' }]), 'application/zip'],
      ['offers', 'poškozený gzip', Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0]), Buffer.alloc(50, 1)]), 'application/gzip'],
      ['offers', 'gzip s poškozeným XML', zlib.gzipSync('<a><b></a>'), 'application/xml'],
      ['offers', 'PDF', Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n'), 'application/pdf'],
      ['offers', 'hluboce zanořený JSON', '['.repeat(100000) + ']'.repeat(100000), 'application/json'],
      ['offers', 'hluboce zanořené XML', '<a>'.repeat(5000) + '</a>'.repeat(5000), 'application/xml'],
      ['offers', 'nespárovaný multipart', '--X\r\nContent-Disposition: form-data; name="a"\r\n\r\nb\r\n--X--\r\n', 'multipart/form-data; boundary=X'],
      ['offers', 'prázdné tělo', '', 'application/json'],
      ['offers', 'jen mezery', '   \n  ', 'text/plain'],
    ];
    for (const [kind, label, body, type] of cases) {
      const r = await s.call('POST', `/api/v1/import/${kind}`, { as: T.imp, body, type });
      assertCzech400(r, `${kind}: ${label}`);
      // náhled se stejným tělem také nesmí spadnout
      const pv = await s.call('POST', `/api/v1/import/preview?kind=${kind}`, { as: T.imp, body, type });
      assert.ok(pv.status === 200 || pv.status === 400, `náhled ${label}: ${pv.status} ${pv.text.slice(0, 200)}`);
      if (pv.status === 400) assertCzech400(pv, `náhled ${label}`);
    }
    // neplatná nepovinná hodnota (cena „abc“) = varování, produkt se založí bez ceny (dokumentované chování importu)
    const warn = await s.call('POST', '/api/v1/import/products', { as: T.imp, body: '[{"code": "X-VAROVANI", "price": "abc"}]', type: 'application/json' });
    assert.equal(warn.status, 200);
    assert.equal(warn.data.stats.created, 1);
    assert.ok(warn.data.stats.errors[0].warning && CZECH.test(warn.data.stats.errors[0].message));
    S0.extra = 1;
    // neplatné parametry
    assertCzech400(await s.call('POST', '/api/v1/import/offers?replace=vse', { as: T.imp, body: example('konkurence.csv'), type: 'text/csv' }), 'replace');
    assertCzech400(await s.call('POST', '/api/v1/import/offers?mapping=%7Bspatne', { as: T.imp, body: example('konkurence.csv'), type: 'text/csv' }), 'mapping JSON');
    assertCzech400(await s.call('POST', '/api/v1/import/offers?mapping=' + encodeURIComponent('{"fields":{"cenaa":"x"}}'), { as: T.imp, body: example('konkurence.csv'), type: 'text/csv' }), 'mapping pole');
    assertCzech400(await s.call('POST', '/api/v1/import/preview?kind=nevim', { as: T.imp, body: 'a;b\n1;2', type: 'text/csv' }), 'kind');

    // JSON API s poškozeným tělem
    const jsonCases = [
      ['POST', '/api/v1/strategies', '{"name": "x", '],
      ['POST', '/api/v1/segments', '{bad json}'],
      ['POST', '/api/v1/simulate', '[1,2]'],
      ['PUT', '/api/v1/settings', '"text"'],
      ['POST', '/api/v1/proposals/approve', 'null'],
      ['POST', '/api/v1/runs', '{"product_ids": "vse"}'],
      ['PATCH', '/api/v1/products/1', '{"price": "drahé"}'],
      ['POST', '/api/v1/segments/preview', '{"filter": {"field": "margin_pct", "op": "~", "value": 1}}'],
      ['POST', '/api/v1/segments', '{"name": "Divný", "filter": {"any": "nic"}}'],
      ['POST', '/api/v1/strategies', '{"name": "Bez configu", "config": "{nejson"}'],
      ['POST', '/api/v1/simulate', '{"config": {}, "filter": "{nejson"}'],
      ['PUT', '/api/v1/settings', '{"offer_max_age_days": "sedm"}'],
      ['POST', '/api/v1/export/ack', '{"codes": "A,B"}'],
    ];
    for (const [method, p, body] of jsonCases) {
      const r = await s.call(method, p, { body, type: 'application/json' });
      if (p === '/api/v1/segments/preview') {
        // náhled segmentu vrací chybu filtru v těle (živá kontrola v editoru)
        assert.equal(r.status, 200);
        assert.ok(r.data.errors.length > 0 && CZECH.test(r.data.errors[0]));
        continue;
      }
      if (p === '/api/v1/export/ack') {
        const a = await s.call(method, p, { as: T.exp, body, type: 'application/json' });
        assertCzech400(a, `${method} ${p}`);
        continue;
      }
      assertCzech400(r, `${method} ${p} ${body}`);
    }
    // neznámé API → 404 JSON s českou zprávou
    const nf = await s.call('GET', '/api/v1/neexistuje', { as: T.read });
    assert.equal(nf.status, 404);
    assert.match(nf.data.error.message, CZECH);
    // server stále odpovídá
    const h = await s.call('GET', '/api/v1/health', { as: 'none' });
    assert.equal(h.status, 200);
  });

  test('import 30 000 produktů a ~100 000 nabídek přes API doběhne', { timeout: 180000 }, async () => {
    const demo = generateDemo({ products: 30000, seed: 7 });
    const t0 = Date.now();
    const rp = await s.call('POST', '/api/v1/import/products', { as: T.imp, json: demo.products });
    const tp = Date.now() - t0;
    assert.equal(rp.status, 200, rp.text.slice(0, 500));
    assert.equal(rp.data.stats.received, 30000);
    // pár kódů se může shodovat s ukázkovým katalogem (stejný generátor) → aktualizace
    assert.equal(rp.data.stats.created + rp.data.stats.updated + rp.data.stats.unchanged, 30000);
    assert.ok(rp.data.stats.created >= 29960);
    assert.deepEqual(hardErrors(rp.data.stats), []);
    const total = 40 + S0.extra + rp.data.stats.created;
    const t1 = Date.now();
    const ro = await s.call('POST', '/api/v1/import/offers', { as: T.imp, json: { items: demo.offers } });
    const to = Date.now() - t1;
    assert.equal(ro.status, 200, ro.text.slice(0, 500));
    assert.equal(ro.data.stats.received, demo.offers.length);
    assert.equal(ro.data.stats.matched, demo.offers.length);
    const t2 = Date.now();
    const list = await s.call('GET', '/api/v1/products?limit=50&sort=gap_min_pct&dir=desc', { as: T.read });
    assert.equal(list.status, 200);
    assert.equal(list.data.total, total);
    const tl = Date.now() - t2;
    const dash = await s.call('GET', '/api/v1/dashboard', { as: T.read });
    assert.equal(dash.status, 200);
    assert.equal(dash.data.products.active, total);
    if (!process.env.CI_SLOW) {
      assert.ok(tp < 30000, `import produktů ${tp} ms`);
      assert.ok(to < 30000, `import nabídek ${to} ms`);
      assert.ok(tl < 10000, `seznam produktů ${tl} ms`);
    }
  });

  test('souběžné požadavky během přecenění a importu nechybují', { timeout: 120000 }, async () => {
    // strategie pro všechny produkty (30k z předchozího testu)
    const st = await s.call('POST', '/api/v1/strategies/presets/default_median');
    assert.equal(st.status, 201, st.text);
    const reqs = [];
    reqs.push(s.call('POST', '/api/v1/runs', { json: {} }));
    for (let i = 0; i < 6; i++) {
      reqs.push(s.call('GET', '/api/v1/dashboard', { as: T.read }));
      reqs.push(s.call('GET', `/api/v1/products?limit=20&page=${i + 1}`, { as: T.read }));
      reqs.push(s.call('GET', '/api/v1/proposals?limit=20', { as: T.read }));
      reqs.push(s.call('GET', `/feed/changes.json?token=${T.exp}`, { as: 'none' }));
    }
    reqs.push(s.call('POST', '/api/v1/import/offers', { as: T.imp, body: example('konkurence.xml'), type: 'application/xml' }));
    reqs.push(s.call('POST', '/api/v1/runs', { json: { product_ids: [1, 2, 3] } }));
    reqs.push(s.call('POST', '/api/v1/proposals/approve', { json: { all: true, filter: { direction: 'up' } } }));
    reqs.push(s.call('GET', `/feed/changes.xml?mark=1&token=${T.exp}`, { as: 'none' }));
    const res = await Promise.all(reqs);
    for (const r of res) assert.ok(r.status < 400, `${r.status} ${String(r.text).slice(0, 300)}`);
    const runs = await s.call('GET', '/api/v1/runs', { as: T.read });
    assert.equal(runs.data.total, 2);
    assert.ok(runs.data.items.every((r) => r.status === 'done'));
  });
});

// =========================================================================================================
describe('E2E: souborová databáze – restart serveru a zámek databáze jiným procesem', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-e2e-db-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('restart zachová data, tokeny i přihlášení; zápis čeká na zámek jiného procesu', { timeout: 60000 }, async () => {
    const dbFile = path.join(dir, 'cenotvorba.db');
    let s = await startServer({ dbFile });
    const tok = await s.token(['import', 'read']);
    assert.equal((await s.call('POST', '/api/v1/import/products', { as: tok, body: example('katalog.csv'), type: 'text/csv' })).status, 200);
    assert.equal((await s.call('POST', '/api/v1/import/offers', { as: tok, body: example('konkurence.xml'), type: 'application/xml' })).status, 200);
    assert.equal((await s.call('POST', '/api/v1/strategies/presets/default_median')).status, 201);
    const run = await s.call('POST', '/api/v1/runs', { json: {} });
    assert.equal(run.status, 200);
    const cookie = s.cookie;
    await s.stop();
    assert.ok(fs.existsSync(dbFile));

    s = await startServer({ dbFile });
    try {
      const p = await s.call('GET', '/api/v1/products?limit=1', { as: tok });
      assert.equal(p.status, 200, 'starý token platí i po restartu');
      assert.equal(p.data.total, 40);
      const runs = await s.call('GET', '/api/v1/runs', { as: tok });
      assert.equal(runs.data.total, 1);
      const props = await s.call('GET', '/api/v1/proposals', { as: tok });
      assert.equal(props.data.total, run.data.stats.pending);
      // session cookie z předchozího běhu platí (tajemství je v databázi)
      const { request } = require('./server-helpers');
      const me = await request(s.port, { path: '/api/v1/auth/me', headers: { cookie } });
      assert.equal(me.status, 200);

      // jiný proces drží zápisový zámek 1,5 s → zápis přes API počká (busy_timeout) a uspěje
      const script = `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(${JSON.stringify(dbFile)});
        db.exec('PRAGMA busy_timeout = 5000');
        db.exec('BEGIN IMMEDIATE');
        db.prepare("INSERT INTO audit(at, action) VALUES (?, 'lock-test')").run(new Date().toISOString());
        process.stdout.write('locked\\n');
        setTimeout(() => { db.exec('COMMIT'); db.close(); process.stdout.write('released\\n'); }, 1500);
      `;
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
      await new Promise((resolve, reject) => {
        child.stdout.on('data', (d) => String(d).includes('locked') && resolve());
        child.on('error', reject);
        child.on('exit', (code) => code && reject(new Error(`dětský proces skončil ${code}`)));
      });
      const t0 = Date.now();
      const imp = await s.call('POST', '/api/v1/import/offers', { as: tok, body: example('konkurence.csv'), type: 'text/csv' });
      const waited = Date.now() - t0;
      assert.equal(imp.status, 200, imp.text);
      assert.ok(waited >= 500, `import čekal na zámek (${waited} ms)`);
      const r2 = await s.call('POST', '/api/v1/runs', { json: {} });
      assert.equal(r2.status, 200, r2.text);
      await new Promise((r) => (child.exitCode != null ? r() : child.on('exit', r)));
      const au = await s.call('GET', '/api/v1/audit');
      assert.ok(au.data.items.some((a) => a.action === 'lock-test'));
    } finally {
      await s.stop();
    }
  });
});

/** GET se surovým tělem (Buffer) – pro binární odpovědi (windows-1250, XLSX). */
async function rawGet(s, p, token) {
  const { request } = require('./server-helpers');
  const r = await request(s.port, { method: 'GET', path: p, headers: { authorization: `Bearer ${token}` } });
  let data = null;
  try {
    data = JSON.parse(r.text);
  } catch {
    /* není JSON */
  }
  return { status: r.status, headers: r.headers, body: r.body, text: r.text, data };
}
