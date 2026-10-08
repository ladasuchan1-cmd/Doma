'use strict';
// Testy serveru (server.js): přihlášení, sdílená data týmu (stav, objednávky, ručně přidaná místa, obraty,
// nastavení), uložení na disk a ochrana cest. ARES / RÚIAN se netestují proti síti (MP_REGISTRY=0).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-server-'));
process.env.MP_DATA = tmp;
process.env.MP_USERS = 'Lada:tajne1;obchod:tajne2';
process.env.MP_TOKEN = 'token-pro-zalohy';
process.env.MP_REGISTRY = '0';
delete process.env.MP_AUTH;
delete process.env.MP_TRUST_PROXY;
delete process.env.ANTHROPIC_API_KEY;
const { server, flushAll, parseUsers, safeNext } = require('../server.js');

let base;
let cookie;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const json = (method, p, body, extra) =>
  fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(extra || {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });

test('pomocné funkce: uživatelé a bezpečný návrat po přihlášení', () => {
  assert.deepStrictEqual([...parseUsers('Jana:a;petr:b:c,\n  :x;ivo:')], [['jana', 'a'], ['petr', 'b:c']]);
  assert.strictEqual(safeNext('/#kraj=116'), '/#kraj=116');
  assert.strictEqual(safeNext('//zly.cz'), '/');
  assert.strictEqual(safeNext('https://zly.cz'), '/');
});

test('bez přihlášení: jen health, přihlašovací stránka a favicon', async () => {
  const h = await (await fetch(base + '/api/health')).json();
  assert.strictEqual(h.ok, true);
  assert.strictEqual(h.zapis, true);
  let res = await fetch(base + '/', { redirect: 'manual' });
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location'), /^\/login\?next=/);
  res = await fetch(base + '/app.js');
  assert.strictEqual(res.status, 401);
  res = await fetch(base + '/api/stav');
  assert.strictEqual(res.status, 401);
  res = await fetch(base + '/login');
  assert.match(await res.text(), /Mapa prodejen a servisů kol/);
  assert.strictEqual((await fetch(base + '/favicon.svg')).status, 200);
});

test('přihlášení: špatné heslo 401, jméno bez ohledu na velikost písmen, cookie', async () => {
  let res = await fetch(base + '/login', { method: 'POST', body: 'jmeno=lada&heslo=spatne', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  assert.strictEqual(res.status, 401);
  res = await fetch(base + '/login', { method: 'POST', body: 'jmeno=LADA&heslo=tajne1&next=%2F%23tab%3Dmesta', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get('location'), '/#tab=mesta');
  const set = res.headers.get('set-cookie');
  assert.match(set, /mp_session=.*HttpOnly/);
  cookie = set.split(';')[0];
  const me = await (await json('GET', '/api/me')).json();
  assert.strictEqual(me.jmeno, 'lada');
  assert.strictEqual(me.registry, false);
  // token pro skripty
  const t = await fetch(base + '/api/stav', { headers: { Authorization: 'Bearer token-pro-zalohy' } });
  assert.strictEqual(t.status, 200);
});

test('stav spolupráce: záznam s autorem, neplatné id, sloučení, smazání', async () => {
  let res = await json('PUT', '/api/stav/n123', { vytipovano: true, poznamka: 'zavolat', upraveno: '2026-10-07T10:00:00Z' });
  assert.deepStrictEqual(await res.json(), { ok: true, kdo: 'lada' });
  assert.strictEqual((await json('PUT', '/api/stav/..%2Fetc', {})).status, 400);
  res = await json('PUT', '/api/stav', { stav: { a03148807: { partner: true, upraveno: '2026-10-07T11:00:00Z' }, spatne: { partner: true } } });
  assert.strictEqual((await res.json()).zaznamu, 2);
  const all = await (await json('GET', '/api/stav')).json();
  assert.strictEqual(all.app, 'mapa-prodejen');
  assert.strictEqual(all.stav.n123.kdo, 'lada');
  assert.strictEqual(all.stav.a03148807.partner, true);
  await json('PUT', '/api/stav/n123', {});
  assert.ok(!('n123' in (await (await json('GET', '/api/stav')).json()).stav));
  assert.strictEqual((await json('PUT', '/api/stav/n1', '{nejson')).status, 200); // řetězec = prázdný záznam
  const bad = await fetch(base + '/api/stav/n1', { method: 'PUT', headers: { Cookie: cookie }, body: '{nejson' });
  assert.strictEqual(bad.status, 400);
});

test('objednávky: jen součty podle PSČ, osobní údaje se odmítnou', async () => {
  // zákazníci a aktivní zákazníci z tabulky vložené z Excelu (bez objednávek)
  let res = await json('PUT', '/api/objednavky', { metriky: ['zak', 'akt'], mista: [{ psc: '16000', zak: 40, akt: 3, kc: 0 }], soubor: 'vloženo ze schránky' });
  assert.deepStrictEqual(await res.json(), { ok: true, objednavek: 0, psc: 1 });
  const z = await (await json('GET', '/api/objednavky', undefined, { 'Accept-Encoding': 'identity' })).json();
  assert.deepStrictEqual([z.metriky, z.zakazniku, z.aktivnich, z.mista], [['zak', 'akt'], 40, 3, [{ psc: '16000', zak: 40, akt: 3, kc: 0 }]]);
  res = await json('PUT', '/api/objednavky', { mista: [{ psc: '60200', n: 12, kc: 34000 }, { psc: '11000', n: 5 }], od: '2025-01-01', do: '2025-12-31', soubor: 'export.csv' });
  assert.deepStrictEqual(await res.json(), { ok: true, objednavek: 17, psc: 2 });
  res = await json('PUT', '/api/objednavky', { mista: [{ psc: '60200', n: 1, email: 'jan@x.cz' }] });
  assert.strictEqual(res.status, 400);
  const d = await (await json('GET', '/api/objednavky', undefined, { 'Accept-Encoding': 'identity' })).json();
  assert.strictEqual(d.objednavek, 17);
  assert.strictEqual(d.kdo, 'lada');
  assert.strictEqual(d.mista[0].psc, '60200');
  const h = await (await fetch(base + '/api/health')).json();
  assert.strictEqual(h.objednavek, 17);
});

test('ručně přidaná místa: přidat, upravit, smazat, kontrola polohy', async () => {
  let res = await json('POST', '/api/mista', { nazev: 'Cyklo U Nádraží', typ: 'servis', lat: 49.2, lon: 16.6, tel: '+420 605 111 222', sl: { servis: true } });
  const { misto } = await res.json();
  assert.match(misto.id, /^v[0-9a-z]{10}$/);
  assert.strictEqual(misto.kdo, 'lada');
  assert.strictEqual((await json('POST', '/api/mista', { nazev: 'Mimo', lat: 10, lon: 10 })).status, 400);
  res = await json('PUT', '/api/mista/' + misto.id, { ...misto, nazev: 'Cyklo U Nádraží 2', typ: 'nase' });
  assert.strictEqual((await res.json()).misto.typ, 'nase');
  assert.strictEqual((await json('PUT', '/api/mista/vneexistuje1', misto)).status, 404);
  let list = (await (await json('GET', '/api/mista')).json()).mista;
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].nazev, 'Cyklo U Nádraží 2');
  await json('DELETE', '/api/mista/' + misto.id);
  list = (await (await json('GET', '/api/mista')).json()).mista;
  assert.strictEqual(list.length, 0);
});

test('obraty: hromadně i jednotlivě, neplatné IČO vynechá', async () => {
  let res = await json('PUT', '/api/obraty', { obraty: { '03148807': { obrat: 12e6, rok: 2024, zdroj: 'závěrka' }, 12345678: { obrat: 1 }, 27082440: { obrat: -5 } } });
  const j = await res.json();
  assert.strictEqual(j.ulozeno, 1);
  assert.strictEqual(j.chyby.length, 2);
  res = await json('PUT', '/api/obraty/27082440', { obrat: 75e9, rok: 2024 });
  assert.strictEqual(res.status, 200);
  const all = (await (await json('GET', '/api/obraty')).json()).obraty;
  assert.strictEqual(all['03148807'].obrat, 12e6);
  assert.strictEqual(all['03148807'].kdo, 'lada');
  assert.strictEqual(all['27082440'].rok, 2024);
  await json('DELETE', '/api/obraty/27082440');
  assert.ok(!('27082440' in (await (await json('GET', '/api/obraty')).json()).obraty));
  assert.strictEqual((await json('PUT', '/api/obraty/12345678', { obrat: 1 })).status, 400);
});

test('nastavení: IČO naší firmy, ARES vypnutý', async () => {
  const r = await (await json('PUT', '/api/nastaveni', { naseIco: ['28715501', 'nesmysl', '28715501'] })).json();
  assert.deepStrictEqual(r.naseIco, ['28715501']);
  assert.deepStrictEqual(await (await json('GET', '/api/nastaveni')).json(), { naseIco: ['28715501'] });
  assert.strictEqual((await json('GET', '/api/firma/03148807')).status, 503);
  assert.strictEqual((await json('GET', '/api/firma/12345678')).status, 400);
  assert.strictEqual((await json('GET', '/api/geokoduj?q=Brno')).status, 503);
  assert.deepStrictEqual((await (await json('GET', '/api/firmy')).json()).firmy, {});
});

test('statika: aplikace ano, server, nástroje, data týmu ne', async () => {
  const get = (p) => fetch(base + p, { headers: { Cookie: cookie, 'Accept-Encoding': 'gzip' } });
  let res = await get('/');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  res = await get('/data/meta.js');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('cache-control'), /private/);
  assert.strictEqual((await get('/lib/asistent.js')).status, 200);
  for (const p of ['/server.js', '/lib/ares.js', '/lib/asistent-server.js', '/node_modules/@anthropic-ai/sdk/package.json', '/tools/build-data.js', '/test/server.test.js', '/deploy/server.sh', '/package.json', '/.env', '/cache/x', '/server-data/stav.json', '/%2e%2e/etc/passwd', '/README.md']) {
    assert.strictEqual((await get(p)).status, 404, p);
  }
  assert.strictEqual((await fetch(base + '/%E0%A4%A', { headers: { Cookie: cookie } })).status, 400);
});

test('asistent: bez klíče vypnutý (503), s klientem jedno kolo konverzace, kontrola zpráv, limit dotazů', async () => {
  const asistentSrv = require('../lib/asistent-server.js');
  assert.strictEqual((await (await json('GET', '/api/me')).json()).asistent, false);
  const zprava = { messages: [{ role: 'user', content: [{ type: 'text', text: 'ukaž Jihomoravský kraj' }] }] };
  assert.strictEqual((await json('POST', '/api/asistent', zprava)).status, 503);
  const volani = [];
  asistentSrv._nastavKlienta({ beta: { messages: { create: async (p) => {
    volani.push(p);
    return { model: p.model, stop_reason: 'tool_use', stop_details: null, content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'toolu_1', name: 'nastav_oblast', input: { uroven: 'kraj', nazev: 'Jihomoravský' } }], usage: { input_tokens: 10, output_tokens: 5 } };
  } } } });
  try {
    assert.strictEqual((await (await json('GET', '/api/me')).json()).asistent, true);
    let res = await json('POST', '/api/asistent', zprava);
    assert.strictEqual(res.status, 200);
    const j = await res.json();
    assert.strictEqual(j.stop_reason, 'tool_use');
    assert.deepStrictEqual(j.content[0], { type: 'thinking', thinking: '', signature: 'sig' });
    assert.strictEqual(volani[0].model, 'claude-opus-5-5');
    assert.deepStrictEqual(volani[0].messages, zprava.messages);
    res = await json('POST', '/api/asistent', { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }] });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await json('GET', '/api/asistent')).status, 405);
    let posledni;
    for (let i = 0; i < 60; i++) posledni = await json('POST', '/api/asistent', zprava);
    assert.strictEqual(posledni.status, 429);
  } finally {
    asistentSrv._nastavKlienta(null);
  }
});

test('data týmu se uloží na disk ve formátu, který server znovu načte', async () => {
  flushAll();
  for (const f of ['stav.json', 'objednavky.json', 'mista.json', 'obraty.json', 'nastaveni.json']) assert.ok(fs.existsSync(path.join(tmp, f)), f);
  const st = JSON.parse(fs.readFileSync(path.join(tmp, 'stav.json'), 'utf8'));
  assert.strictEqual(st.app, 'mapa-prodejen');
  assert.ok(st.stav.a03148807.partner);
  const ob = JSON.parse(fs.readFileSync(path.join(tmp, 'obraty.json'), 'utf8'));
  assert.strictEqual(ob.obraty['03148807'].obrat, 12e6);
  // nový proces nad stejnou složkou načte totéž
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e', "const s=require('./server.js').stores; console.log(JSON.stringify([Object.keys(s.stavStore.get()), s.objStore.get().objednavek, Object.keys(s.obratyStore.get()), s.nastaveniStore.get()]))"], { cwd: path.join(__dirname, '..'), env: { ...process.env, MP_DATA: tmp } }).toString();
  assert.deepStrictEqual(JSON.parse(out), [['a03148807', 'n1'].filter((x) => st.stav[x]), 17, ['03148807'], { naseIco: ['28715501'] }]);
});

test('brzda hádání hesla: 10 chyb z jedné adresy → 429', async () => {
  let last;
  for (let i = 0; i < 11; i++) {
    last = await fetch(base + '/login', { method: 'POST', body: 'jmeno=obchod&heslo=x' + i, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  }
  assert.strictEqual(last.status, 429);
});
