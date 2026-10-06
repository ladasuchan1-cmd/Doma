'use strict';
// Testy průvodce pro nového klienta a správy platformy (od 7. 10. 2026): pomocníci (IČO, subdoména, poloha, obrázek,
// multipart), správa platformy (vypnutá bez hesla, přihlášení, pozvánka), celý průchod průvodcem až po běžící web na
// subdoméně (soubory, caddy-hosty.txt, kola, logo, admin s heslem z průvodce, žádné demo chování, náhledový pruh),
// opakované použití odkazu, stavy webu (pozastaveno → 503, ostrý provoz) a načtení klienta po restartu.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers');
const k = require('../src/klienti');
const { parseMultipart } = require('../src/http/context');
const feature = require('../src/features/klienti');

const HESLO = 'tajne-heslo-platformy-2026';
const HOST = 'utridubu.ksprehledy.cz';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

// ---------------------------------------------------------------------------------------------------------
// Pomocníci

test('pomocníci: IČO, subdoména, návrh adresy, poloha, typ obrázku, heslo platformy', () => {
  assert.equal(k.isValidIco('27082440'), true);
  assert.equal(k.isValidIco('27082441'), false);
  assert.equal(k.isValidIco('1234567'), false);
  assert.equal(k.isValidSlug('utridubu'), true);
  for (const bad of ['www', 'demo', 'admin', 'ab', '-abc', 'abc-', 'a--b', 'Utri', 'u_tri', 'a'.repeat(31)]) assert.equal(k.isValidSlug(bad), false, bad);
  assert.equal(k.suggestSlug({ web: 'https://www.utridubu.cz/kontakt' }), 'utridubu');
  assert.equal(k.suggestSlug({ nazev: 'Hotel U Tří dubů' }), 'utridubu');
  assert.deepEqual(k.parseLocation('49.0035, 14.7708'), { lat: 49.0035, lon: 14.7708 });
  assert.deepEqual(k.parseLocation('https://mapy.cz/turisticka?x=14.7708&y=49.0035&z=15'), { lat: 49.0035, lon: 14.7708 });
  assert.deepEqual(k.parseLocation('https://www.google.com/maps/@49.0035,14.7708,15z'), { lat: 49.0035, lon: 14.7708 });
  assert.equal(k.parseLocation('14.7708, 49.0035'), null, 'prohozené souřadnice mimo ČR');
  assert.equal(k.sniffImage(PNG), 'png');
  assert.equal(k.sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null, 'SVG nepřijímáme');
  assert.deepEqual(k.distributeSizes(['S', 'M', 'L'], 4), ['M', 'S', 'L', 'M']);
  assert.equal(feature.checkPassword(HESLO, HESLO), true);
  assert.equal(feature.checkPassword('jine', HESLO), false);
  assert.equal(feature.checkPassword('', ''), false, 'prázdné heslo nikdy');
});

test('multipart: pole, soubor, prázdné souborové pole, zakázané klíče, poškozený formát → 400', () => {
  const b = 'XyZ';
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="design"\r\n\r\nsport\r\n--${b}\r\nContent-Disposition: form-data; name="__proto__"\r\n\r\nx\r\n--${b}\r\nContent-Disposition: form-data; name="logo"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`),
    PNG,
    Buffer.from(`\r\n--${b}\r\nContent-Disposition: form-data; name="nic"; filename=""\r\n\r\n\r\n--${b}--\r\n`),
  ]);
  const r = parseMultipart(body, `multipart/form-data; boundary=${b}`);
  assert.equal(r.design, 'sport');
  assert.equal(r.logo.filename, 'logo.png');
  assert.equal(r.logo.data.length, PNG.length);
  assert.equal(r.nic, '');
  assert.equal(Object.getPrototypeOf(r), Object.prototype);
  assert.throws(() => parseMultipart(Buffer.from('nesmysl'), `multipart/form-data; boundary=${b}`), (e) => e.status === 400);
});

// ---------------------------------------------------------------------------------------------------------
// Server

function multipartBody(fields, files = {}) {
  const b = `----pk${Date.now()}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  for (const [name, f] of Object.entries(files)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${name}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`), f.data, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${b}` };
}

test('správa platformy je bez PK_PLATFORMA_HESLO vypnutá (404)', async () => {
  const srv = await startServer();
  try {
    assert.equal((await srv.fetch('/platforma')).status, 404);
  } finally {
    await srv.stop();
  }
});

test('celý průchod: pozvánka → průvodce → web klienta na subdoméně v náhledovém provozu', async () => {
  const srv = await startServer({ env: { PK_PLATFORMA_HESLO: HESLO, PK_KLIENTI_DOMENA: 'ksprehledy.cz' } });
  let srv2 = null;
  try {
    // --- přihlášení do platformy ---
    let res = await srv.fetch('/platforma');
    assert.equal(res.status, 200);
    let html = await res.text();
    assert.match(html, /Heslo platformy/);
    let token = /name="_csrf" value="([^"]+)"/.exec(html)[1];
    res = await srv.fetch('/platforma/prihlaseni', { method: 'POST', body: { _csrf: token, heslo: 'spatne-heslo-12345' } });
    assert.equal(res.status, 401);
    token = /name="_csrf" value="([^"]+)"/.exec(await res.text())[1];
    res = await srv.fetch('/platforma/prihlaseni', { method: 'POST', body: { _csrf: token, heslo: HESLO } });
    assert.equal(res.status, 303);
    html = await (await srv.fetch('/platforma')).text();
    assert.match(html, /Nová pozvánka do průvodce/);
    const ptoken = /name="_csrf" value="([^"]+)"/.exec(html)[1];
    // CSRF: veřejný token na platformní akci nestačí
    assert.equal((await srv.fetch('/platforma/pozvanky', { method: 'POST', body: { _csrf: 'x', nazev: 'A', email: 'a@b.cz' } })).status, 403);

    // --- pozvánka ---
    res = await srv.fetch('/platforma/pozvanky', { method: 'POST', body: { _csrf: ptoken, nazev: 'Hotel U Tří dubů', email: 'jana@utridubu.cz', poznamka: 'pilot' } });
    assert.equal(res.status, 200);
    html = await res.text();
    const link = /value="(http[^"]+\/zalozeni\/([A-Za-z0-9_-]+))"/.exec(html);
    assert.ok(link, 'stránka ukazuje odkaz');
    const inv = link[2];
    assert.match(html, /href="mailto:jana%40utridubu\.cz\?subject=/);
    const pdb = srv.app.platformDb;
    const row = pdb.prepare('SELECT * FROM pozvanky').get();
    assert.notEqual(row.token_hash, inv, 'v DB je jen otisk tokenu');
    assert.ok(!String(row.email_enc).includes('jana@'), 'e-mail šifrovaně');
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type = 'pozvanka'").get().n, 1);

    // --- průvodce: úvod a pořadí kroků ---
    srv.jar.clear();
    res = await srv.fetch(`/zalozeni/${inv}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Vítejte, Hotel U Tří dubů/);
    res = await srv.fetch(`/zalozeni/${inv}/kola`);
    assert.equal(res.status, 303, 'nelze přeskočit kroky');
    assert.match(res.headers.get('location'), /\/provozovna$/);
    const base = `/zalozeni/${inv}`;
    const post = async (krok, body) => srv.fetch(`${base}/${krok}`, { method: 'POST', body: { _csrf: await srv.csrf(`${base}/${krok}`), ...body } });

    // provozovna
    const provozovna = { nazev: 'Hotel U Tří dubů', firma: 'U Tří dubů s.r.o.', ico: '27082440', platceDph: '1', dic: 'CZ27082440', sidlo: 'Masarykovo nám. 1, 379 01 Třeboň', email: 'recepce@utridubu.cz', telefon: '+420 777 123 456', zastupce: 'Jana Nováková, jednatelka', web: 'https://www.utridubu.cz', ucet: '19-2000145399/0800', banka: 'Česká spořitelna' };
    res = await post('provozovna', { ...provozovna, ico: '12345678' });
    assert.equal(res.status, 422);
    assert.match(await res.text(), /IČO má 8 číslic/);
    res = await post('provozovna', provozovna);
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /\/adresa$/);

    // adresa – návrh z webu, rezervovaná adresa, neplatná poloha
    html = await (await srv.fetch(`${base}/adresa`)).text();
    assert.match(html, /name="slug"[^>]*value="utridubu"/);
    res = await post('adresa', { slug: 'www', poloha: '49.0035, 14.7708' });
    assert.equal(res.status, 422);
    res = await post('adresa', { slug: 'utridubu', poloha: 'nikde' });
    assert.equal(res.status, 422);
    res = await post('adresa', { slug: 'utridubu', poloha: 'https://mapy.cz/turisticka?x=14.7708&y=49.0035&z=15' });
    assert.equal(res.status, 303);

    // vzhled – SVG odmítnuto, PNG přijato (multipart)
    let mp = multipartBody({ _csrf: await srv.csrf(`${base}/vzhled`), design: 'family', claim: 'Kola pro celou rodinu', nadpis: 'Půjčte si kolo u Tří dubů', text: 'Elektrokola i dětská kola.' }, { logo: { filename: 'logo.svg', type: 'image/svg+xml', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') } });
    res = await srv.fetch(`${base}/vzhled`, { method: 'POST', body: mp.body, headers: { 'content-type': mp.contentType } });
    assert.equal(res.status, 422);
    assert.match(await res.text(), /PNG, JPG nebo WebP/);
    mp = multipartBody({ _csrf: await srv.csrf(`${base}/vzhled`), design: 'family', claim: 'Kola pro celou rodinu', nadpis: 'Půjčte si kolo u Tří dubů', text: 'Elektrokola i dětská kola.' }, { logo: { filename: 'logo.png', type: 'image/png', data: PNG } });
    res = await srv.fetch(`${base}/vzhled`, { method: 'POST', body: mp.body, headers: { 'content-type': mp.contentType } });
    assert.equal(res.status, 303);

    // kola – bez kusů chyba, pak 3 + 2
    res = await post('kola', {});
    assert.equal(res.status, 422);
    res = await post('kola', { 'pocet_superior-eway-6-4': '3', 'cena_superior-eway-6-4': '950', 'pocet_superior-racer-20': '2', 'cena_superior-racer-20': '250' });
    assert.equal(res.status, 303);

    // provoz
    res = await post('provoz', { vsedniOd: '10:00', vsedniDo: '09:00', vikendOd: '', vikendDo: '', poplatek: '300', poplatekEkolo: '500' });
    assert.equal(res.status, 422);
    res = await post('provoz', { vsedniOd: '09:00', vsedniDo: '18:00', vikendOd: '08:00', vikendDo: '19:00', poplatek: '300', poplatekEkolo: '500' });
    assert.equal(res.status, 303);

    // účet – předvyplněný e-mail z pozvánky, krátké heslo, bez souhlasu, pak správně
    html = await (await srv.fetch(`${base}/ucet`)).text();
    assert.match(html, /value="jana@utridubu\.cz"/);
    res = await post('ucet', { jmeno: 'Jana Nováková', email: 'jana@utridubu.cz', heslo: 'kratke', heslo2: 'kratke', souhlas: '1' });
    assert.equal(res.status, 422);
    res = await post('ucet', { jmeno: 'Jana Nováková', email: 'jana@utridubu.cz', heslo: 'dlouhe-heslo-hotelu', heslo2: 'dlouhe-heslo-hotelu' });
    assert.equal(res.status, 422, 'bez souhlasu');
    res = await post('ucet', { jmeno: 'Jana Nováková', email: 'jana@utridubu.cz', heslo: 'dlouhe-heslo-hotelu', heslo2: 'dlouhe-heslo-hotelu', souhlas: '1' });
    assert.equal(res.status, 303);
    const draftRaw = pdb.prepare('SELECT draft_enc FROM pozvanky').get().draft_enc;
    assert.ok(!draftRaw.includes('dlouhe-heslo') && !draftRaw.includes('27082440'), 'koncept je šifrovaný');

    // zpracovatelská smlouva s údaji z průvodce
    html = await (await srv.fetch(`${base}/zpracovatelska-smlouva`)).text();
    assert.match(html, /U Tří dubů s\.r\.o\./);
    assert.match(html, /utridubu\.ksprehledy\.cz/);

    // kontrola a spuštění
    html = await (await srv.fetch(`${base}/kontrola`)).text();
    assert.match(html, /https:\/\/utridubu\.ksprehledy\.cz/);
    assert.match(html, /3× eWAY 6\.4 – 950/);
    res = await post('kontrola', {});
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /\/hotovo$/);
    html = await (await srv.fetch(`${base}/hotovo`)).text();
    assert.match(html, /Hotovo – web běží/);
    assert.match(html, /https:\/\/utridubu\.ksprehledy\.cz\/admin/);

    // --- výsledek na disku a v aplikaci ---
    const dir = path.join(srv.dataDir, 'klienti', 'utridubu');
    const tj = JSON.parse(fs.readFileSync(path.join(dir, 'tenant.json'), 'utf8'));
    assert.deepEqual(tj.hosts, [HOST]);
    assert.equal(tj.stav, 'nahled');
    assert.equal(tj.themeDefault, 'family');
    assert.equal(tj.business.ico, '27082440');
    assert.equal(tj.business.iban, 'CZ6508000000192000145399');
    assert.deepEqual(tj.location, { lat: 49.0035, lon: 14.7708, radiusKm: 25 });
    assert.ok(fs.existsSync(path.join(dir, 'logo.png')));
    assert.match(fs.readFileSync(path.join(srv.dataDir, 'caddy-hosty.txt'), 'utf8'), /^utridubu\.ksprehledy\.cz$/m);
    const cdb = srv.dbs.get('utridubu');
    assert.equal(cdb.prepare('SELECT COUNT(*) AS n FROM bikes').get().n, 5);
    assert.equal(cdb.prepare('SELECT COUNT(*) AS n FROM bike_types').get().n, 2);
    assert.equal(cdb.prepare("SELECT price_minor FROM price_rules r JOIN bike_types t ON t.id = r.bike_type_id WHERE t.slug = 'superior-eway-6-4' AND unit = 'day' AND from_qty = 1").get().price_minor, 95000);
    assert.equal(cdb.prepare("SELECT role FROM users WHERE email = 'jana@utridubu.cz'").get().role, 'owner');
    assert.equal(cdb.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type = 'vitejte'").get().n, 1);
    assert.ok(pdb.prepare('SELECT used_at FROM pozvanky').get().used_at);
    assert.equal(pdb.prepare('SELECT draft_enc FROM pozvanky').get().draft_enc, null, 'koncept smazán');

    // --- web klienta na subdoméně ---
    srv.jar.clear();
    const H = { host: HOST };
    res = await srv.fetch('/', { headers: H });
    assert.equal(res.status, 200);
    html = await res.text();
    assert.match(html, /<html lang="cs" data-theme="family"/);
    assert.match(html, /Hotel U Tří dubů/);
    assert.match(html, /class="preview-bar"/);
    assert.match(html, /src="\/tenant\/logo\.png"/);
    assert.ok(!/design-switch/.test(html), 'žádný přepínač designů dema');
    assert.ok(!/Demo verze/.test(html), 'žádná patička dema');
    html = await (await srv.fetch('/kola', { headers: H })).text();
    assert.equal((html.match(/<article class="card card--bike">/g) || []).length, 2);
    res = await srv.fetch('/tenant/logo.png', { headers: H });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal((await srv.fetch('/?design=sport', { headers: H }).then((r) => r.text())).includes('data-theme="sport"'), false, 'design nejde přepnout parametrem');
    // platforma ani průvodce na webu klienta nejsou
    assert.equal((await srv.fetch('/platforma', { headers: H })).status, 404);
    assert.equal((await srv.fetch(`/zalozeni/${inv}`, { headers: H })).status, 404);
    // přihlášení do administrace klienta – bez demo údajů, heslem z průvodce
    html = await (await srv.fetch('/admin/login', { headers: H })).text();
    assert.ok(!/kolo-demo-2026/.test(html), 'veřejné demo heslo se na webu klienta neukazuje');
    const at = /name="_csrf" value="([^"]+)"/.exec(html)[1];
    res = await srv.fetch('/admin/login', { method: 'POST', headers: { ...H, origin: `http://${HOST}` }, body: { _csrf: at, email: 'demo@ksprehledy.cz', heslo: 'kolo-demo-2026', zpet: '/admin' } });
    assert.notEqual(res.status, 303, 'demo účet na webu klienta neexistuje');
    const at2 = /name="_csrf" value="([^"]+)"/.exec(await (await srv.fetch('/admin/login', { headers: H })).text())[1];
    res = await srv.fetch('/admin/login', { method: 'POST', headers: { ...H, origin: `http://${HOST}` }, body: { _csrf: at2, email: 'jana@utridubu.cz', heslo: 'dlouhe-heslo-hotelu', zpet: '/admin' } });
    assert.equal(res.status, 303);

    // --- odkaz podruhé ---
    srv.jar.clear();
    res = await srv.fetch(`/zalozeni/${inv}`);
    assert.equal(res.status, 410);
    assert.match(await res.text(), /Web už je založený/);
    assert.equal((await srv.fetch('/zalozeni/neexistujici-token-neexistujici')).status, 404);

    // --- stavy z platformy ---
    let t0 = /name="_csrf" value="([^"]+)"/.exec(await (await srv.fetch('/platforma')).text())[1];
    await srv.fetch('/platforma/prihlaseni', { method: 'POST', body: { _csrf: t0, heslo: HESLO } });
    html = await (await srv.fetch('/platforma')).text();
    assert.match(html, /utridubu\.ksprehledy\.cz/);
    t0 = /name="_csrf" value="([^"]+)"/.exec(html)[1];
    res = await srv.fetch('/platforma/klienti/utridubu/stav', { method: 'POST', body: { _csrf: t0, stav: 'pozastaven' } });
    assert.equal(res.status, 303);
    assert.equal((await srv.fetch('/', { headers: H })).status, 503);
    await srv.fetch('/platforma/klienti/utridubu/stav', { method: 'POST', body: { _csrf: t0, stav: 'ostry' } });
    html = await (await srv.fetch('/', { headers: H })).text();
    assert.ok(!/preview-bar/.test(html), 'ostrý provoz bez pruhu');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tenant.json'), 'utf8')).stav, 'ostry');

    // --- po restartu (nový server nad stejnými daty) web klienta běží dál ---
    srv2 = await startServer({ env: { PK_DATA: srv.dataDir, PK_PLATFORMA_HESLO: HESLO } });
    assert.ok(srv2.instance.tenants.some((t) => t.slug === 'utridubu' && t.klient));
    res = await srv2.fetch('/', { headers: H });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Hotel U Tří dubů/);
  } finally {
    if (srv2) await srv2.instance.stop();
    await srv.stop();
  }
});

test('pozvánka: prošlá a zrušená nejdou použít; obsazená subdoména se v průvodci odmítne', async () => {
  const srv = await startServer({ env: { PK_PLATFORMA_HESLO: HESLO } });
  try {
    const pdb = srv.app.platformDb;
    const fc = srv.app.fieldCrypto;
    const old = k.createInvite(pdb, { email: 'a@b.cz', nazev: 'Starý', fieldCrypto: fc, now: Date.now() - 30 * 86400000 });
    let res = await srv.fetch(`/zalozeni/${old.token}`);
    assert.equal(res.status, 410);
    assert.match(await res.text(), /Platnost odkazu vypršela/);
    const zr = k.createInvite(pdb, { email: 'a@b.cz', nazev: 'Zrušený', fieldCrypto: fc });
    assert.equal(k.revokeInvite(pdb, zr.id), true);
    assert.equal((await srv.fetch(`/zalozeni/${zr.token}`)).status, 410);
    // obsazenost: host jiného tenanta (demo má www.ksprehledy.cz → slug www je rezervovaný; vezmeme klienta z evidence)
    pdb.prepare("INSERT INTO klienti(slug, nazev, host, stav, created_at, updated_at) VALUES ('obsazeno', 'X', 'obsazeno.ksprehledy.cz', 'nahled', 'x', 'x')").run();
    assert.equal(k.isSlugFree({ slug: 'obsazeno', tenants: srv.app.tenants, pdb, domena: 'ksprehledy.cz' }), false);
    assert.equal(k.isSlugFree({ slug: 'volne', tenants: srv.app.tenants, pdb, domena: 'ksprehledy.cz' }), true);
  } finally {
    await srv.stop();
  }
});
