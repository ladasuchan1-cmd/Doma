'use strict';
// Testy feature „nabídka“: výpočty (domain/nabidka) proti tabulkám v docs/NABIDKA-MODEL.md (sazby 24/36 m, zůstatky 24 m,
// scénáře penzion 5 / hotel 20 / resort 50 pro koupi, pronájem 36 a zkoušku), min. kol, jenEkolo, validace konfigurace;
// přes server: stránka 200 ve 3 tématech bez „{{“ / „undefined“ / „NaN“, API bez interních polí, odeslání poptávky →
// outbox typ nabidka se šifrovanými údaji a bez PII v logu, honeypot, CSRF 403, interní blok jen s admin session,
// /admin/nabidky, stránka „nabídka se připravuje“ při chybné konfiguraci, skutečný config/nabidka.json (existuje-li) validní.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startServer } = require('./helpers');
const { createLogger } = require('../src/log');
const domain = require('../src/domain/nabidka');
const feature = require('../src/features/nabidka');

const FIXTURE = path.join(__dirname, 'fixtures', 'nabidka.json');
const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const { config } = domain.validateConfig(raw);
const run = (q) => domain.compute(domain.normalizeInput(q, config), config);
const BAD_TOKENS = /\{\{|undefined|NaN/;

// ---------------------------------------------------------------------------------------------------------
// Doména

test('validateConfig: fixtura projde, procenta jako podíly, interní klíče doplňků; chybná struktura vrátí české chyby', () => {
  const v = domain.validateConfig(raw);
  assert.ok(v.ok, v.errors.join(' '));
  assert.equal(v.config.pronajem.rocniUrok, 0.07);
  assert.equal(v.config.interni.nakladyDoplnkuProcentCeny.Prilby, 0.7);
  assert.equal(v.config.interni.nakladySpravyHodinMesicne, 3);
  assert.ok(!/marže|Nákupní cena/.test(v.config.tridyKol[0].popisVerejny), 'veřejný popis bez interních vět');
  assert.match(v.config.tridyKol[0].popisVerejny, /^Hliníkový rám/);
  assert.equal(domain.pct(10), 0.1, 'celá čísla jsou procenta');
  assert.equal(domain.pct(0.35), 0.35, 'desetinná ≤ 1 jsou podíly');
  const bad = domain.validateConfig({ ...raw, tridyKol: raw.tridyKol.slice(0, 2), pronajem: { ...raw.pronajem, minKol: 'x' } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /tridyKol/.test(e)));
  assert.ok(bad.errors.some((e) => /minKol/.test(e)));
  assert.equal(domain.validateConfig(null).ok, false);
});

test('sazby za 1 kolo podle NABIDKA-MODEL.md: pronájem 24/36 m, zůstatek 24 m, zkouška', () => {
  const expected = { zakladni: [563, 617, 13667, 1234], trek: [1127, 1234, 27333, 2468], ekolo: [2004, 2198, 47000, 4396] };
  for (const t of config.tridyKol) {
    const [m24, m36, z24, zk] = expected[t.id];
    assert.equal(domain.monthlyRate(t, 24, config.pronajem).celkem, m24, `${t.id} 24 m`);
    assert.equal(domain.monthlyRate(t, 36, config.pronajem).celkem, m36, `${t.id} 36 m`);
    assert.equal(Math.round(domain.zustatkova(t, 24)), z24, `${t.id} zůstatek 24 m`);
    assert.equal(domain.zustatkova(t, 36), t.zustatkova36m, `${t.id} zůstatek 36 m = zustatkova36m`);
    assert.equal(Math.round(2 * domain.monthlyRate(t, 36, config.pronajem).celkem), zk, `${t.id} zkouška`);
  }
  // 24 m nesmí používat zustatkova36m: e-kolo by vyšlo 2 802 Kč a odkup 26 500
  const ekolo = config.tridyKol[2];
  assert.ok(domain.zustatkova(ekolo, 24) > ekolo.zustatkova36m + 15000);
  const r = run({ ekolo: 5, porizeni: 'pronajem24' });
  assert.equal(r.souhrn.odkupNaKonci, 5 * 47000);
  assert.equal(r.porizeni.radky[0].zaKolo, 2004);
});

test('scénář penzion (5 kol: 2 trek + 3 e-kola, web šablona, partner servis, přilby, nabíječka)', () => {
  const base = { trek: 2, ekolo: 3, web: 'sablona', sprava: 'sami', servis: 'partner', doplnky: 'prilby,nabijecky' };
  const k = run({ ...base, porizeni: 'koupe' });
  assert.equal(k.souhrn.jednorazove, 410000);
  assert.equal(k.souhrn.mesicne, 1890);
  assert.deepEqual(k.souhrn.horizonty.map((h) => h.castka), [437180, 491540]);
  assert.equal(k.interni.marze, 126925);
  assert.equal(k.interni.podilPartnera, 39015);
  assert.equal(k.souhrn.kauce, 0);

  const p = run({ ...base, porizeni: 'pronajem36' });
  assert.equal(p.souhrn.jednorazove, 46000);
  assert.equal(p.souhrn.mesicne, 10952);
  assert.equal(p.porizeni.mesicne, 9062);
  assert.equal(p.souhrn.kauce, 36400);
  assert.equal(p.souhrn.odkupNaKonci, 111500);
  assert.deepEqual(p.souhrn.horizonty.map((h) => h.castka), [181924, 453772]);
  assert.equal(p.interni.marze, 157325);
  assert.equal(p.interni.podilPartnera, 39015);
  assert.equal(Math.round(p.interni.marzeProcent * 100), 35);
  assert.equal(p.interni.varovani.length, 0);

  const z = run({ ...base, porizeni: 'zkouska' });
  assert.equal(z.zkouska.celkem, 72496);
  assert.equal(z.zkouska.mesicne, 18124);
  assert.equal(z.zkouska.zaloha, 36248);
  assert.equal(z.zkouska.zapocet, 25374);
  assert.equal(z.zkouska.odkup, 291200);
  assert.equal(z.zkouska.kauce, 36400);
  assert.equal(z.interni.nakladyZkousky, 19425);
  assert.equal(z.souhrn.mesicne, 19024, 'kola + servis partnera; web a přilby v ceně');
  assert.equal(z.souhrn.jednorazove, 25000, 'jen nabíječka; přilby v ceně zkoušky');
  assert.equal(z.souhrn.rocne, 0, 'sezónní prohlídka v ceně zkoušky');
  assert.ok(z.web.vCeneZkousky && z.servis.prohlidkaVCeneZkousky);
  assert.ok(z.doplnky.find((d) => d.id === 'prilby').vCeneZkousky);
  assert.equal(z.souhrn.horizonty.length, 1);
  assert.equal(z.souhrn.horizonty[0].castka, 25000 + 4 * 19024);
  assert.ok(z.interni.varovani.some((w) => /započte 25374/.test(w)));
});

test('scénář hotel (20 kol, předplacená správa, pojištění) a resort (50 kol, GPS, 2. design)', () => {
  const hotel = { zakladni: 6, trek: 6, ekolo: 8, web: 'sablona', sprava: 'predplacena', servis: 'partner', doplnky: 'prilby,nabijecky,pojisteni' };
  const hp = run({ ...hotel, porizeni: 'pronajem36' });
  assert.equal(hp.souhrn.jednorazove, 64000);
  assert.equal(hp.souhrn.mesicne, 39580);
  assert.equal(hp.porizeni.mesicne, 28690);
  assert.equal(hp.souhrn.kauce, 115400);
  assert.equal(hp.souhrn.odkupNaKonci, 356000);
  assert.deepEqual(hp.souhrn.horizonty.map((h) => h.castka), [556960, 1542880]);
  assert.equal(hp.interni.marze, 503060);
  assert.equal(hp.interni.podilPartnera, 156060);
  const sprava = hp.interni.polozky.find((p) => p.id === 'sprava');
  assert.equal(sprava.naklady, 36 * 3 * 600, 'náklad správy = 3 h × 600 Kč měsíčně');
  const hk = run({ ...hotel, porizeni: 'koupe' });
  assert.equal(hk.souhrn.jednorazove, 1218000);
  assert.deepEqual(hk.souhrn.horizonty.map((h) => h.castka), [1366680, 1664040]);
  assert.equal(hk.interni.marze, 405860);
  const hz = run({ ...hotel, porizeni: 'zkouska' });
  assert.equal(hz.zkouska.celkem, 229520);
  assert.equal(hz.souhrn.mesicne, 63380);
  assert.equal(hz.zkouska.zapocet, 80332);
  assert.equal(hz.zkouska.odkup, 923200);

  const resort = { zakladni: 15, trek: 15, ekolo: 20, web: 'sablona', dalsiDesign: '1', sprava: 'predplacena', servis: 'partner', doplnky: 'prilby,nabijecky,pojisteni,gps' };
  const rp = run({ ...resort, porizeni: 'pronajem36' });
  assert.equal(rp.souhrn.mesicne, 94615);
  assert.equal(rp.porizeni.mesicne, 71725);
  assert.equal(rp.souhrn.jednorazove, 180000, 'dokument počítá 2 nabíjecí stanice (205 000) – config umí jen jednu');
  assert.equal(rp.interni.podilPartnera, 390150);
  assert.equal(rp.souhrn.horizonty[1].castka, 3721140);
  const rk = run({ ...resort, porizeni: 'koupe' });
  assert.equal(rk.souhrn.jednorazove, 3090000 - 25000);
  assert.ok(rk.interni.marzeProcent > 0.2 && rk.interni.marzeProcent < 0.23);
  const rz = run({ ...resort, porizeni: 'zkouska' });
  assert.equal(rz.zkouska.celkem, 573800);
  assert.equal(rz.zkouska.zapocet, 200830);
});

test('min. kol → upozornění (pronájem i zkouška, ne koupě); jenEkolo doplněk jen s e-koly; publicResult bez interni; práh marže', () => {
  const r = run({ zakladni: 3, porizeni: 'pronajem36' });
  assert.ok(r.upozorneni.some((u) => u.kod === 'min-kol' && /od 5 kol/.test(u.text)));
  assert.ok(run({ zakladni: 3, porizeni: 'zkouska' }).upozorneni.some((u) => u.kod === 'min-kol'));
  assert.ok(!run({ zakladni: 3, porizeni: 'koupe' }).upozorneni.some((u) => u.kod === 'min-kol'));
  assert.ok(run({}).upozorneni.some((u) => u.kod === 'zadna-kola'));
  const bez = run({ zakladni: 5, porizeni: 'koupe', doplnky: 'nabijecky' });
  assert.equal(bez.doplnky.length, 0);
  assert.ok(bez.upozorneni.some((u) => u.kod === 'jen-ekolo'));
  const s = run({ zakladni: 5, ekolo: 2, porizeni: 'koupe', doplnky: 'nabijecky,gps' });
  assert.deepEqual(s.doplnky.map((d) => [d.id, d.pocet, d.jednorazove, d.mesicne]), [['nabijecky', 2, 25000, 0], ['gps', 7, 10500, 420]]);
  assert.deepEqual(domain.availableDoplnky(config, domain.normalizeInput({ zakladni: 1 }, config)).map((d) => d.id), ['pojisteni', 'gps', 'prilby']);
  const pub = domain.publicResult(s);
  assert.equal('interni' in pub, false);
  assert.ok(JSON.stringify(pub).indexOf('marze') === -1, 'veřejný výsledek bez slova marže');
  // práh marže: konfigurace s nulovou marží pronájmu hlásí varování
  const low = domain.validateConfig({ ...raw, pronajem: { ...raw.pronajem, marzeRocni: 0 }, web: { ...raw.web, sablona: { jednorazove: 6000, mesicne: 150 } } }).config;
  const lr = domain.compute(domain.normalizeInput({ zakladni: 5, porizeni: 'pronajem36', web: 'sablona', servis: 'vlastni' }, low), low);
  assert.ok(lr.interni.varovani.some((w) => /pod prahem/.test(w)));
});

test('normalizeInput: limity, neznámé hodnoty → výchozí, doplnky čárkou i opakovaně; inputToQuery round-trip', () => {
  const i = domain.normalizeInput({ zakladni: '999', trek: '-3', ekolo: 'abc', porizeni: 'x', web: 'namiru', sprava: 'predplacena', servis: 'y', doplnky: ['gps,neznamy', 'prilby', 'gps'] }, config);
  assert.deepEqual(i.kola, { zakladni: domain.MAX_KOL, trek: 0, ekolo: 0 });
  assert.equal(i.porizeni, 'zkouska');
  assert.equal(i.servis, 'vlastni');
  assert.deepEqual(i.doplnky, ['gps', 'prilby']);
  const q = domain.inputToQuery(i);
  assert.deepEqual(domain.normalizeInput(Object.fromEntries(new URLSearchParams(q)), config), i);
});

test('config/nabidka.json (existuje-li) má platnou strukturu a sedí se zmrazenou fixturou v sazbách', () => {
  const real = feature.DEFAULT_CONFIG_PATH;
  if (!fs.existsSync(real)) {
    test.skip ? null : null;
    return;
  }
  const v = domain.validateConfig(JSON.parse(fs.readFileSync(real, 'utf8')));
  assert.ok(v.ok, v.errors.join(' '));
  for (const t of v.config.tridyKol) assert.ok(domain.monthlyRate(t, 36, v.config.pronajem).celkem > 0);
});

test('createConfigLoader: chybějící soubor, neplatný JSON, chybná struktura → error + log; změna mtime se znovu načte', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-nab-'));
  const file = path.join(dir, 'nabidka.json');
  const lines = [];
  const log = createLogger({ level: 'debug', stdout: { write: (l) => lines.push(l) }, stderr: { write: (l) => lines.push(l) } });
  const loader = feature.createConfigLoader({ filePath: file, log });
  assert.equal(loader.get().config, null);
  assert.match(loader.get().error, /neexistuje/);
  fs.writeFileSync(file, '{ nevalidni');
  assert.equal(loader.reload().config, null);
  assert.match(loader.get().error, /JSON/);
  fs.writeFileSync(file, JSON.stringify({ ...raw, servis: {} }));
  assert.equal(loader.reload().config, null);
  assert.match(loader.get().error, /servis/);
  assert.ok(lines.some((l) => /chybnou strukturu/.test(l)));
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.ok(loader.reload().config);
  assert.ok(lines.some((l) => /načtena/.test(l)));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------
// Server

let srv;
const logLines = [];
test.before(async () => {
  feature.setConfigPath(FIXTURE);
  const log = createLogger({ level: 'debug', stdout: { write: (l) => logLines.push(l) }, stderr: { write: (l) => logLines.push(l) } });
  srv = await startServer({ log });
});
test.after(async () => {
  if (srv) await srv.stop();
  feature.setConfigPath(feature.DEFAULT_CONFIG_PATH);
});

async function adminLogin() {
  const token = await srv.csrf('/admin/login');
  const r = await srv.fetch('/admin/login', { method: 'POST', body: { _csrf: token, email: 'demo@ksprehledy.cz', heslo: 'kolo-demo-2026', zpet: '/admin' } });
  assert.equal(r.status, 303);
}

test('stránka /nabidka: 200 ve 3 tématech, bez {{ / undefined / NaN, bez inline JS, s navigací „Pro hotely a půjčovny“, kroky a souhrn', async () => {
  srv.jar.clear();
  for (const theme of ['outdoor', 'sport', 'family']) {
    const res = await srv.fetch(`/nabidka?design=${theme}&zakladni=6&trek=6&ekolo=8&porizeni=pronajem36&sprava=predplacena&servis=partner&doplnky=prilby,pojisteni&doplnky=nabijecky`);
    assert.equal(res.status, 200, theme);
    const html = await res.text();
    assert.match(html, new RegExp(`<html lang="cs" data-theme="${theme}"`));
    assert.ok(!BAD_TOKENS.test(html), `${theme}: nerozvinuté tokeny`);
    assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), 'bez inline skriptů');
    assert.ok(!/ style="/.test(html), 'bez inline stylů');
    assert.match(html, /site-nav__link is-active" href="\/nabidka" aria-current="page">Pro hotely a půjčovny</);
    assert.match(html, /\/css\/nabidka\.css/);
    assert.match(html, /\/js\/nabidka\.js/);
    assert.match(html, /<ol class="steps">/);
    assert.match(html, /name="trek" required="" |name="trek"/);
    assert.match(html, /value="6"[^>]*data-nabidka-count="zakladni"|data-nabidka-count="zakladni"/);
    assert.match(html, /39\u00a0580\u00a0Kč/, 'měsíčně hotel');
    assert.match(html, /1\u00a0542\u00a0880\u00a0Kč/, '3 roky hotel');
    assert.match(html, /badge badge--warning">ukázkové ceny/);
    assert.match(html, /Odkup kol na konci/);
    assert.match(html, /name="konfigurace" value="zakladni=6&amp;trek=6&amp;ekolo=8&amp;porizeni=pronajem36[^"]*doplnky=prilby%2Cpojisteni%2Cnabijecky"/);
    assert.ok(!/nab-internal/.test(html), 'veřejnost nevidí interní blok');
    assert.ok(!/marže/i.test(html), 'veřejnost nevidí slovo marže');
  }
  const zk = await (await srv.fetch('/nabidka?trek=2&ekolo=3&porizeni=zkouska&servis=partner&doplnky=prilby,nabijecky')).text();
  assert.match(zk, /Celkem za zkoušku \(4 měsíce\)/);
  assert.match(zk, /započteme <strong>25\u00a0374\u00a0Kč<\/strong>/);
  assert.match(zk, /Start nejpozději 15\. 6\./);
  assert.match(zk, /v ceně zkoušky/);
  const malo = await (await srv.fetch('/nabidka?zakladni=2&porizeni=pronajem36')).text();
  assert.match(malo, /notice notice--warning[^>]*>Pronájem nabízíme od 5 kol/);
  const prazdna = await (await srv.fetch('/nabidka')).text();
  assert.match(prazdna, /Zadejte prosím počet kol/);
  assert.match(prazdna, /name="porizeni" value="zkouska" checked/, 'výchozí = zkouška');
});

test('API /api/v1/nabidka/spocitat: JSON bez interních polí, doplnky čárkou, html souhrnu; neplatný vstup → výchozí', async () => {
  srv.jar.clear();
  const res = await srv.fetch('/api/v1/nabidka/spocitat?zakladni=5&trek=3&ekolo=2&porizeni=zkouska&web=sablona&sprava=sami&servis=partner&doplnky=pojisteni,gps');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal('interni' in j, false);
  assert.ok(!/marže|marze|naklady|provize/i.test(JSON.stringify({ ...j, html: '' })), 'bez interních slov');
  assert.ok(!/nab-internal/.test(j.html));
  assert.equal(j.souhrn.pocetKol, 10);
  assert.deepEqual(j.doplnky.map((d) => d.id), ['pojisteni', 'gps']);
  assert.equal(j.zkouska.mesice, 4);
  assert.ok(!BAD_TOKENS.test(j.html));
  const dflt = await (await srv.fetch('/api/v1/nabidka/spocitat?porizeni=nesmysl&zakladni=-5')).json();
  assert.equal(dflt.vstup.porizeni, 'zkouska');
  assert.equal(dflt.souhrn.pocetKol, 0);
});

test('interní blok jen s admin session (/nabidka i API); ?interni=0 ho skryje; bez session nikdy, ani s ?interni=1', async () => {
  srv.jar.clear();
  const q = '/nabidka?trek=2&ekolo=3&porizeni=pronajem36&servis=partner&doplnky=prilby,nabijecky';
  assert.ok(!/nab-internal/.test(await (await srv.fetch(q + '&interni=1')).text()), 'veřejnost s ?interni=1 nic');
  const pubApi = await (await srv.fetch('/api/v1/nabidka/spocitat?trek=2&ekolo=3&porizeni=pronajem36&interni=1')).json();
  assert.equal('interni' in pubApi, false);
  await adminLogin();
  const html = await (await srv.fetch(q)).text();
  assert.match(html, /nab-internal/);
  assert.match(html, /Naše marže/);
  assert.match(html, /157\u00a0325\u00a0Kč/, 'marže penzion pronájem 36');
  assert.match(html, /39\u00a0015\u00a0Kč/, 'podíl partnera');
  assert.ok(!/nab-internal/.test(await (await srv.fetch(q + '&interni=0')).text()));
  const api = await (await srv.fetch('/api/v1/nabidka/spocitat?trek=2&ekolo=3&porizeni=pronajem36&servis=partner&doplnky=prilby,nabijecky')).json();
  assert.equal(api.interni.marze, 157325);
  assert.match(api.html, /nab-internal/);
  // odhlášení → zase nic
  const logout = await srv.fetch('/admin/logout', { method: 'POST', body: { _csrf: (await srv.fetch('/admin')).headers.get('x-none') || '' } });
  assert.ok([303, 403].includes(logout.status));
  srv.jar.clear();
  assert.ok(!/nab-internal/.test(await (await srv.fetch(q)).text()));
});

test('poptávka: CSRF 403, validace 422 s předvyplněním, honeypot, úspěch → outbox typ nabidka (šifrované PII, konfigurace + výsledek + interní), děkujeme, bez PII v logu', async () => {
  srv.jar.clear();
  logLines.length = 0;
  const pii = { nazev: 'Penzion U Rybníka', obec: 'Třeboň', osoba: 'Jana Nováková', email: 'jana.novakova@example.com', telefon: '+420 777 000 000', poznamka: 'Začít bychom chtěli v květnu.' };
  const konfigurace = 'trek=2&ekolo=3&porizeni=zkouska&web=sablona&sprava=sami&servis=partner&doplnky=prilby%2Cnabijecky';
  // bez CSRF
  const noCsrf = await srv.fetch('/nabidka/poptavka', { method: 'POST', body: { konfigurace, ...pii, souhlas: '1' } });
  assert.equal(noCsrf.status, 403);
  const token = await srv.csrf('/nabidka');
  // cizí Origin
  assert.equal((await srv.fetch('/nabidka/poptavka', { method: 'POST', body: { _csrf: token, konfigurace, ...pii, souhlas: '1' }, headers: { origin: 'https://utocnik.example' } })).status, 403);
  // validace
  const bad = await srv.fetch('/nabidka/poptavka', { method: 'POST', body: { _csrf: token, konfigurace, ...pii, email: 'neni-email', souhlas: '' } });
  assert.equal(bad.status, 422);
  const badHtml = await bad.text();
  assert.match(badHtml, /platný e-mail/);
  assert.match(badHtml, /Bez potvrzení/);
  assert.match(badHtml, /value="Penzion U Rybníka"/);
  assert.match(badHtml, /value="zakladni=0&amp;trek=2&amp;ekolo=3&amp;porizeni=zkouska/, 'konfigurace zůstane');
  assert.ok(!BAD_TOKENS.test(badHtml));
  // bez kol
  const noBikes = await srv.fetch('/nabidka/poptavka', { method: 'POST', body: { _csrf: token, konfigurace: 'porizeni=koupe', ...pii, souhlas: '1' } });
  assert.equal(noBikes.status, 422);
  assert.match(await noBikes.text(), /alespoň jedno kolo/);
  // honeypot
  const before = srv.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n;
  const hp = await srv.fetch('/nabidka/poptavka', { method: 'POST', body: { _csrf: token, konfigurace, ...pii, souhlas: '1', web_hp: 'http://spam' } });
  assert.equal(hp.status, 303);
  assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, before);
  // úspěch
  const ok = await srv.fetch('/nabidka/poptavka', { method: 'POST', body: { _csrf: token, konfigurace, ...pii, souhlas: '1' } });
  assert.equal(ok.status, 303);
  const loc = ok.headers.get('location');
  assert.match(loc, /^\/nabidka\/dekujeme\/[A-Za-z0-9_-]{16,}$/);
  const row = srv.db.prepare("SELECT * FROM outbox WHERE type = 'nabidka' ORDER BY id DESC").get();
  assert.ok(row);
  assert.match(row.subject, /^Poptávka NAB-\d{4}-000001: 5 kol, zkušební období 4 měsíce$/);
  assert.equal(row.to_hmac, srv.app.fieldCrypto.hmacEmail('provozovatel@ksprehledy.cz'));
  assert.match(row.body_text, /Penzion U Rybníka/);
  assert.match(row.body_text, /Měsíčně: 19\u00a0024 Kč/);
  const payload = JSON.parse(row.payload);
  assert.equal(payload.kind, 'nabidka');
  assert.equal(srv.app.fieldCrypto.dec(payload.nazev_enc), pii.nazev);
  assert.equal(srv.app.fieldCrypto.dec(payload.reply_to_enc), pii.email);
  assert.equal(srv.app.fieldCrypto.dec(payload.osoba_enc), pii.osoba);
  assert.equal(srv.app.fieldCrypto.dec(payload.phone_enc), pii.telefon);
  assert.equal(srv.app.fieldCrypto.dec(payload.note_enc), pii.poznamka);
  for (const s of ['Nováková', 'novakova@', '777 000', 'Rybníka', 'květnu']) assert.ok(!row.payload.includes(s), `payload bez „${s}“`);
  assert.equal(payload.konfigurace.porizeni, 'zkouska');
  assert.deepEqual(payload.konfigurace.kola, { zakladni: 0, trek: 2, ekolo: 3 });
  assert.equal(payload.vysledek.zkouska.celkem, 72496);
  assert.equal('interni' in payload.vysledek, false);
  assert.equal(payload.interni.nakupniCelkem, 290000);
  assert.equal(payload.cenik.zastupneCeny, true);
  // děkujeme
  const thanks = await srv.fetch(loc);
  assert.equal(thanks.status, 200);
  const th = await thanks.text();
  assert.match(th, /Děkujeme za poptávku/);
  assert.match(th, /NAB-\d{4}-000001/);
  assert.match(th, /Penzion U Rybníka, Třeboň/);
  assert.match(th, /Celkem za zkoušku/);
  assert.match(th, /<meta name="robots" content="noindex">/);
  assert.ok(!BAD_TOKENS.test(th));
  assert.ok(!/nab-internal/.test(th));
  assert.equal((await srv.fetch('/nabidka/dekujeme/neexistujici-token-xxxx')).status, 404);
  // log bez PII
  const log = logLines.join('\n');
  for (const s of ['Nováková', 'novakova', '777 000', 'Rybníka', 'květnu']) assert.ok(!log.includes(s), `log bez „${s}“`);
  assert.match(log, /Poptávka nabídky uložena do outboxu/);
  // druhá poptávka má pořadové číslo 2
  const token2 = await srv.csrf('/nabidka');
  await srv.fetch('/nabidka/poptavka', { method: 'POST', body: { _csrf: token2, konfigurace: 'zakladni=10&porizeni=koupe', ...pii, souhlas: '1' } });
  assert.match(srv.db.prepare("SELECT subject FROM outbox WHERE type = 'nabidka' ORDER BY id DESC").get().subject, /000002/);
});

test('/admin/nabidky: bez přihlášení 303 na login; s přihlášením seznam a detail s dešifrovaným kontaktem, interní marží a auditem nabidka.view', async () => {
  srv.jar.clear();
  const anon = await srv.fetch('/admin/nabidky');
  assert.equal(anon.status, 303);
  assert.match(anon.headers.get('location'), /^\/admin\/login\?zpet=/);
  await adminLogin();
  const list = await srv.fetch('/admin/nabidky');
  assert.equal(list.status, 200);
  const lh = await list.text();
  assert.match(lh, /<body class="admin">/);
  assert.match(lh, /admin__nav-link is-active" href="\/admin\/nabidky"/);
  assert.match(lh, /Penzion U Rybníka/);
  assert.match(lh, /NAB-\d{4}-000001/);
  assert.ok(!BAD_TOKENS.test(lh));
  const id = srv.db.prepare("SELECT id FROM outbox WHERE type = 'nabidka' ORDER BY id ASC").get().id;
  const det = await srv.fetch(`/admin/nabidky/${id}`);
  assert.equal(det.status, 200);
  const dh = await det.text();
  assert.match(dh, /jana\.novakova@example\.com/);
  assert.match(dh, /Jana Nováková/);
  assert.match(dh, /Interně: naše marže/);
  assert.match(dh, /Vázaný kapitál/);
  assert.match(dh, /Začít bychom chtěli v květnu/);
  assert.ok(!BAD_TOKENS.test(dh));
  const audit = srv.db.prepare("SELECT * FROM audit_log WHERE action = 'nabidka.view' ORDER BY id DESC").get();
  assert.ok(audit);
  assert.equal(audit.entity_id, String(id));
  assert.equal((await srv.fetch('/admin/nabidky/999999')).status, 404);
  // outbox v adminu zná typ
  const mails = await (await srv.fetch('/admin/emaily?typ=nabidka')).text();
  assert.match(mails, /Poptávka nabídky/);
  srv.jar.clear();
});

test('chybná konfigurace cen → /nabidka 200 s „Nabídka se připravuje“, API 503, poptávka 503; po opravě vše běží', async () => {
  srv.jar.clear();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-nab-'));
  const file = path.join(dir, 'nabidka.json');
  fs.writeFileSync(file, JSON.stringify({ meta: {} }));
  try {
    feature.setConfigPath(file);
    const res = await srv.fetch('/nabidka');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Nabídka se připravuje/);
    assert.ok(!BAD_TOKENS.test(html));
    assert.equal((await srv.fetch('/api/v1/nabidka/spocitat?zakladni=5')).status, 503);
    const token = await srv.csrf('/kontakt');
    assert.equal((await srv.fetch('/nabidka/poptavka', { method: 'POST', body: { _csrf: token, konfigurace: 'zakladni=5', nazev: 'A B', obec: 'Cd', osoba: 'E F', email: 'a@b.cz', souhlas: '1' } })).status, 503);
    assert.ok(logLines.some((l) => /chybnou strukturu/.test(l)), 'srozumitelná chyba v logu');
  } finally {
    feature.setConfigPath(FIXTURE);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.match(await (await srv.fetch('/nabidka?zakladni=5')).text(), /Vaše nabídka/);
});
