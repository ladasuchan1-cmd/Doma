'use strict';
// Integrační testy API zdrojů dat: CRUD, validace, maskování tajných údajů, ruční spuštění z URL a plánovač.
// URL zdroje míří na lokální http server (examples/konkurence.xml) – bez sítě.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, localServer, example, hardErrors } = require('./api-import-helpers');
const { silentLog } = require('./server-helpers');
const { startScheduler } = require('../src/server/scheduler');

const BASIC = 'Basic ' + Buffer.from('uzivatel:tajneheslo').toString('base64');

describe('API zdrojů dat', () => {
  let s;
  let tRead;
  let tImport;
  let feed;
  const seen = [];

  before(async () => {
    s = await startServer();
    tRead = await s.token(['read']);
    tImport = await s.token(['import']);
    const kat = await s.call('POST', '/api/v1/import/products', { body: example('katalog.csv'), type: 'text/csv' });
    assert.equal(kat.status, 200, kat.text);
    // lokální „feed“ konkurence: /konkurence.xml chrání Basic auth, /chyba vrací 500, /rozbite.xml neplatné XML
    feed = await localServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization || null, key: req.headers['x-api-key'] || null });
      if (req.url.startsWith('/konkurence.xml')) {
        if (req.headers.authorization !== BASIC) {
          res.writeHead(401, { 'content-type': 'text/plain' });
          res.end('neautorizováno');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
        res.end(example('konkurence.xml'));
      } else if (req.url.startsWith('/verejne.csv')) {
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' });
        res.end(example('konkurence.csv'));
      } else if (req.url.startsWith('/rozbite.xml')) {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end('<prices><offer>');
      } else {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('interní chyba feedu');
      }
    });
  });
  after(async () => {
    if (feed) await feed.close();
    if (s) await s.stop();
  });

  it('validace těla → 400 se seznamem chyb', async () => {
    const cases = [
      [{ kind: 'offers' }, 'name'],
      [{ name: '   ', kind: 'offers' }, 'name'],
      [{ name: 'X' }, 'kind'],
      [{ name: 'X', kind: 'zbozi' }, 'kind'],
      [{ name: 'X', kind: 'offers', url: 'ftp://feed.example.cz/x.xml' }, 'url'],
      [{ name: 'X', kind: 'offers', url: 'není url' }, 'url'],
      [{ name: 'X', kind: 'offers', url: 42 }, 'url'],
      [{ name: 'X', kind: 'offers', interval_minutes: -1 }, 'interval_minutes'],
      [{ name: 'X', kind: 'offers', interval_minutes: 1.5 }, 'interval_minutes'],
      [{ name: 'X', kind: 'offers', interval_minutes: 'hodně' }, 'interval_minutes'],
      [{ name: 'X', kind: 'offers', mapping: [] }, 'mapping'],
      [{ name: 'X', kind: 'offers', mapping: '{nejson' }, 'mapping'],
      [{ name: 'X', kind: 'products', mapping: { fields: { competitor: 'Obchod' } } }, 'mapping.fields'],
      [{ name: 'X', kind: 'offers', headers: { 'Špatná hlavička': 'x' } }, 'headers.Špatná hlavička'],
      [{ name: 'X', kind: 'offers', headers: { 'X-Test': 'a\r\nb' } }, 'headers.X-Test'],
      [{ name: 'X', kind: 'offers', headers: 'nejson' }, 'headers'],
      [{ name: 'X', kind: 'offers', method: 'DELETE' }, 'method'],
      [{ name: 'X', kind: 'offers', enabled: 'možná' }, 'enabled'],
      [{ name: 'X', kind: 'offers', options: { replace: 'vse' } }, 'options.replace'],
      [{ name: 'X', kind: 'offers', options: { max_age_days: -5 } }, 'options.max_age_days'],
      [{ name: 'X', kind: 'offers', headers: { Authorization: 'Basic ••••' } }, 'headers.Authorization'],
    ];
    for (const [body, field] of cases) {
      const r = await s.call('POST', '/api/v1/sources', { json: body });
      assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.text}`);
      assert.match(r.data.error.message, /^Neplatný zdroj/);
      assert.ok(
        r.data.error.details.errors.some((e) => e.field === field),
        `${JSON.stringify(body)} → očekávána chyba pole ${field}: ${JSON.stringify(r.data.error.details.errors)}`
      );
    }
    // tělo, které není objekt
    const arr = await s.call('POST', '/api/v1/sources', { json: [{ name: 'X', kind: 'offers' }] });
    assert.equal(arr.status, 400);
    assert.equal((await s.call('GET', '/api/v1/sources')).data.total, 0);
  });

  it('vytvoření, výpis, maskování tajných údajů a zachování při PUT', async () => {
    const url = 'https://uzivatel:heslo123@feed.example.cz/ceny.xml?token=abc123&format=xml';
    const c = await s.call('POST', '/api/v1/sources', {
      json: {
        name: '  Feed Heureka  ',
        kind: 'offers',
        url,
        method: 'get',
        headers: { Authorization: BASIC, 'X-Api-Key': 'k-123', Accept: 'application/xml', 'X-Prazdna': '' },
        mapping: { fields: { competitor: '@shop' }, item_path: 'prices.offer' },
        options: { replace: 'competitors', body: { login: 'eshop', password: 'tajne' } },
        interval_minutes: '60',
        enabled: true,
      },
    });
    assert.equal(c.status, 201, c.text);
    const src = c.data;
    assert.equal(src.name, 'Feed Heureka');
    assert.equal(src.kind, 'offers');
    assert.equal(src.method, 'GET');
    assert.equal(src.url, 'https://uzivatel:••••@feed.example.cz/ceny.xml?token=••••&format=xml');
    assert.deepEqual(src.headers, { Authorization: 'Basic ••••', 'X-Api-Key': '••••', Accept: 'application/xml' });
    assert.deepEqual(src.mapping, { fields: { competitor: '@shop' }, item_path: 'prices.offer' });
    assert.deepEqual(src.options, { replace: 'competitors', body: { login: 'eshop', password: '••••' } });
    assert.equal(src.interval_minutes, 60);
    assert.equal(src.enabled, true);
    assert.equal(src.next_run_at, null);
    assert.equal(src.last_status, null);

    // v databázi jsou skutečné hodnoty
    const row = () => s.db.prepare('SELECT * FROM sources WHERE id = ?').get(src.id);
    assert.equal(row().url, url);
    assert.deepEqual(JSON.parse(row().headers), { Authorization: BASIC, 'X-Api-Key': 'k-123', Accept: 'application/xml' });
    assert.equal(JSON.parse(row().options).body.password, 'tajne');

    // výpis (read token) – JSON sloupce rozparsované, tajné údaje maskované
    const list = await s.call('GET', '/api/v1/sources', { as: tRead });
    assert.equal(list.status, 200);
    assert.equal(list.data.total, 1);
    assert.equal(list.data.items[0].headers.Authorization, 'Basic ••••');
    assert.equal(typeof list.data.items[0].mapping, 'object');
    assert.ok(!JSON.stringify(list.data).includes('k-123'));
    assert.ok(!JSON.stringify(list.data).includes('heslo123'));
    assert.ok(!JSON.stringify(list.data).includes('abc123'));
    const one = await s.call('GET', `/api/v1/sources/${src.id}`, { as: tRead });
    assert.deepEqual(one.data, list.data.items[0]);

    // PUT celého objektu z GET (jak to dělá UI při vypnutí) → tajné hodnoty zůstanou
    const put = await s.call('PUT', `/api/v1/sources/${src.id}`, { json: { ...one.data, name: 'Feed Heureka 2', enabled: false } });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.data.name, 'Feed Heureka 2');
    assert.equal(put.data.enabled, false);
    assert.equal(row().url, url);
    assert.deepEqual(JSON.parse(row().headers), { Authorization: BASIC, 'X-Api-Key': 'k-123', Accept: 'application/xml' });
    assert.equal(JSON.parse(row().options).body.password, 'tajne');
    assert.equal(row().enabled, 0);
    assert.ok(row().updated_at >= row().created_at);

    // částečný PUT – ostatní pole beze změny
    const partial = await s.call('PUT', `/api/v1/sources/${src.id}`, { json: { interval_minutes: 30 } });
    assert.equal(partial.status, 200, partial.text);
    assert.equal(partial.data.interval_minutes, 30);
    assert.equal(partial.data.name, 'Feed Heureka 2');
    assert.deepEqual(JSON.parse(row().headers).Authorization, BASIC);

    // nové hlavičky nahradí celý objekt; nová hodnota se uloží
    const h = await s.call('PUT', `/api/v1/sources/${src.id}`, { json: { headers: { authorization: 'Basic ••••', 'X-Novy': 'n' } } });
    assert.equal(h.status, 200, h.text);
    assert.deepEqual(JSON.parse(row().headers), { authorization: BASIC, 'X-Novy': 'n' });
    const h2 = await s.call('PUT', `/api/v1/sources/${src.id}`, { json: { headers: { Authorization: 'Bearer novy-token' } } });
    assert.equal(h2.status, 200);
    assert.deepEqual(JSON.parse(row().headers), { Authorization: 'Bearer novy-token' });
    assert.deepEqual(h2.data.headers, { Authorization: 'Bearer ••••' });

    // maskovaná hodnota bez uloženého protějšku / jiná URL s maskou → 400
    let bad = await s.call('PUT', `/api/v1/sources/${src.id}`, { json: { headers: { 'X-Api-Key': '••••' } } });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error.message, /skrytá/);
    bad = await s.call('PUT', `/api/v1/sources/${src.id}`, { json: { url: 'https://uzivatel:••••@jiny.example.cz/' } });
    assert.equal(bad.status, 400);
    bad = await s.call('PUT', `/api/v1/sources/${src.id}`, { json: { options: { body: { password: '••••', extra: '••••' } } } });
    assert.equal(bad.status, 400);
    assert.ok(bad.data.error.details.errors.some((e) => e.field === 'options.body.extra'));
    // změna druhu s mapováním pro nabídky → 400
    bad = await s.call('PUT', `/api/v1/sources/${src.id}`, { json: { kind: 'products' } });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error.message, /Neznámá pole v mapování/);
    // prázdná URL = zdroj jen pro příjem dat
    const noUrl = await s.call('PUT', `/api/v1/sources/${src.id}`, { json: { url: '' } });
    assert.equal(noUrl.status, 200);
    assert.equal(noUrl.data.url, null);
    assert.equal(row().url, null);
  });

  it('oprávnění: read čte, admin zapisuje, import smí jen spouštět', async () => {
    const body = { name: 'Oprávnění', kind: 'offers' };
    assert.equal((await s.call('POST', '/api/v1/sources', { as: tRead, json: body })).status, 403);
    assert.equal((await s.call('POST', '/api/v1/sources', { as: tImport, json: body })).status, 403);
    assert.equal((await s.call('POST', '/api/v1/sources', { as: 'session-nocsrf', json: body })).status, 403);
    assert.equal((await s.call('GET', '/api/v1/sources', { as: 'none' })).status, 401);
    assert.equal((await s.call('GET', '/api/v1/sources', { as: tImport })).status, 403);
    const c = await s.call('POST', '/api/v1/sources', { json: body });
    assert.equal(c.status, 201);
    assert.equal((await s.call('PUT', `/api/v1/sources/${c.data.id}`, { as: tRead, json: { name: 'Y' } })).status, 403);
    assert.equal((await s.call('DELETE', `/api/v1/sources/${c.data.id}`, { as: tRead })).status, 403);
    assert.equal((await s.call('DELETE', `/api/v1/sources/${c.data.id}`, { as: tImport })).status, 403);
    assert.equal((await s.call('POST', `/api/v1/sources/${c.data.id}/run`, { as: tRead, json: {} })).status, 403);
    // zdroj bez URL nelze spustit (import token prošel ověřením)
    const run = await s.call('POST', `/api/v1/sources/${c.data.id}/run`, { as: tImport, json: {} });
    assert.equal(run.status, 400);
    assert.match(run.data.error.message, /nemá nastavenou URL/);
    assert.equal(s.db.prepare('SELECT last_status FROM sources WHERE id = ?').get(c.data.id).last_status, null);
  });

  it('smazání zdroje: 404 potom, historie importů zůstane bez vazby', async () => {
    const c = await s.call('POST', '/api/v1/sources', { json: { name: 'Ke smazání', kind: 'offers', mapping: { defaults: { competitor: 'Mazaný.cz' } } } });
    assert.equal(c.status, 201);
    const imp = await s.call('POST', `/api/v1/import/offers?source=${c.data.id}`, { as: tImport, body: 'ean;cena\n8597315660484;900\n', type: 'text/csv' });
    assert.equal(imp.status, 200, imp.text);
    const del = await s.call('DELETE', `/api/v1/sources/${c.data.id}`);
    assert.equal(del.status, 200);
    assert.deepEqual(del.data, { ok: true });
    assert.equal((await s.call('GET', `/api/v1/sources/${c.data.id}`)).status, 404);
    assert.equal((await s.call('DELETE', `/api/v1/sources/${c.data.id}`)).status, 404);
    assert.equal((await s.call('PUT', `/api/v1/sources/${c.data.id}`, { json: { name: 'Z' } })).status, 404);
    assert.equal((await s.call('POST', `/api/v1/sources/${c.data.id}/run`, { json: {} })).status, 404);
    assert.equal((await s.call('GET', '/api/v1/sources/abc')).status, 400);
    const log = await s.call('GET', `/api/v1/imports/${imp.data.import_id}`);
    assert.equal(log.status, 200);
    assert.equal(log.data.source_id, null);
    assert.equal(log.data.status, 'ok');
    // audit
    const actions = s.db.prepare("SELECT action FROM audit WHERE entity = 'source'").all().map((a) => a.action);
    assert.ok(actions.includes('source.create') && actions.includes('source.update') && actions.includes('source.delete'));
  });

  it('ruční spuštění zdroje z URL (lokální server, Basic auth) naimportuje nabídky', async () => {
    const c = await s.call('POST', '/api/v1/sources', {
      json: { name: 'Lokální XML feed', kind: 'offers', url: `${feed.url}/konkurence.xml`, headers: { Authorization: BASIC }, interval_minutes: 0 },
    });
    assert.equal(c.status, 201, c.text);
    // UI přepne zdroj s maskovanými hlavičkami – tajná hlavička se musí zachovat
    const toggled = await s.call('PUT', `/api/v1/sources/${c.data.id}`, { json: { ...c.data, enabled: true } });
    assert.equal(toggled.status, 200, toggled.text);

    const before = Number(s.db.prepare('SELECT COUNT(*) AS n FROM offers').get().n);
    const r = await s.call('POST', `/api/v1/sources/${c.data.id}/run`, { as: tImport, json: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.source_id, c.data.id);
    assert.equal(r.data.format, 'xml');
    assert.ok(Number.isInteger(r.data.import_id));
    assert.ok(r.data.stats.matched > 0, JSON.stringify(r.data.stats));
    assert.equal(r.data.stats.unmatched, 0);
    assert.equal(hardErrors(r.data.stats).length, 0);
    assert.ok(r.data.duration_ms >= 0);
    assert.equal(r.data.source.last_status, 'ok');
    assert.match(r.data.source.last_message, /spárováno/);
    assert.equal(r.data.source.headers.Authorization, 'Basic ••••');
    assert.equal(Number(s.db.prepare('SELECT COUNT(*) AS n FROM offers').get().n), before + r.data.stats.created);
    assert.ok(r.data.stats.created > 100);
    assert.ok(seen.some((x) => x.url === '/konkurence.xml' && x.auth === BASIC), 'feed dostal uloženou Basic auth hlavičku');

    const log = await s.call('GET', `/api/v1/imports/${r.data.import_id}`, { as: tRead });
    assert.equal(log.data.origin, 'url');
    assert.equal(log.data.source_name, 'Lokální XML feed');
    assert.equal(log.data.status, 'ok');
    // spustit smí i admin (session)
    const again = await s.call('POST', `/api/v1/sources/${c.data.id}/run`, { json: {} });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.data.stats.unchanged, r.data.stats.matched);
  });

  it('neúspěšné stažení / import → 502, chyba zapsaná v logu i u zdroje', async () => {
    for (const [p, re] of [
      ['/chyba', /HTTP 500/],
      ['/rozbite.xml', /XML/],
      ['/konkurence.xml', /HTTP 401/], // bez autorizační hlavičky
    ]) {
      const c = await s.call('POST', '/api/v1/sources', { json: { name: `Vadný ${p}`, kind: 'offers', url: feed.url + p } });
      assert.equal(c.status, 201);
      const r = await s.call('POST', `/api/v1/sources/${c.data.id}/run`, { as: tImport, json: {} });
      assert.equal(r.status, 502, r.text);
      assert.match(r.data.error.message, re);
      const d = r.data.error.details;
      assert.equal(d.ok, false);
      assert.equal(d.source_id, c.data.id);
      assert.ok(Number.isInteger(d.import_id));
      const log = await s.call('GET', `/api/v1/imports/${d.import_id}`);
      assert.equal(log.data.status, 'error');
      assert.match(log.data.error, re);
      const src = await s.call('GET', `/api/v1/sources/${c.data.id}`);
      assert.equal(src.data.last_status, 'error');
      assert.match(src.data.last_message, re);
      assert.ok(src.data.last_run_at);
    }
  });

  it('plánovač stáhne zdroj s intervalem (dueSources → runSource)', async () => {
    const c = await s.call('POST', '/api/v1/sources', {
      json: { name: 'Plánovaný CSV feed', kind: 'offers', url: `${feed.url}/verejne.csv`, interval_minutes: 60, options: { replace: 'competitors' } },
    });
    assert.equal(c.status, 201, c.text);
    // ostatní zdroje (např. s URL mimo tento stroj) plánovač vynechá
    s.db.prepare('UPDATE sources SET enabled = 0 WHERE id <> ?').run(c.data.id);
    const sched = startScheduler({ db: s.db, config: s.app.config, log: silentLog, autoStart: false });
    let summary;
    try {
      summary = await sched.tick();
    } finally {
      await sched.stop();
    }
    const entry = summary.sources.find((x) => x.id === c.data.id);
    assert.ok(entry, JSON.stringify(summary));
    assert.equal(entry.ok, true, JSON.stringify(summary));
    const log = await s.call('GET', `/api/v1/imports/${entry.import_id}`);
    assert.equal(log.data.origin, 'schedule');
    assert.equal(log.data.status, 'ok');
    assert.ok(log.data.stats.matched > 0);
    const src = await s.call('GET', `/api/v1/sources/${c.data.id}`);
    assert.equal(src.data.last_status, 'ok');
    assert.ok(src.data.next_run_at);
    assert.equal(Date.parse(src.data.next_run_at) - Date.parse(src.data.last_run_at), 60 * 60000);
    assert.ok(seen.some((x) => x.url === '/verejne.csv'));
  });
});
