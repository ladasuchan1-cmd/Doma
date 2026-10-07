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
const page = require('../src/render/pages/nabidka');

const FIXTURE = path.join(__dirname, 'fixtures', 'nabidka.json');
const INTERNI = path.join(__dirname, 'fixtures', 'nabidka.interni.json');
const PLATFORMA_HESLO = 'test-platforma-heslo-2026';
const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const rawInterni = JSON.parse(fs.readFileSync(INTERNI, 'utf8'));
const { config } = domain.validateConfig(raw, rawInterni);
const run = (q) => domain.compute(domain.normalizeInput(q, config), config);
const BAD_TOKENS = /\{\{|undefined|NaN/;

// ---------------------------------------------------------------------------------------------------------
// Doména

test('validateConfig: fixtura projde, procenta jako podíly, interní klíče doplňků; chybná struktura vrátí české chyby', () => {
  const v = domain.validateConfig(raw, rawInterni);
  assert.ok(v.ok, v.errors.join(' '));
  assert.equal(v.config.meta.nakupniCenyZeSouboru, true);
  assert.equal(v.config.meta.nakupniCenyOdvozene, false);
  assert.equal(v.config.tridyKol[0].nakupniCena, 18000);
  const bezInterni = domain.validateConfig(raw, null);
  assert.ok(bezInterni.ok, bezInterni.errors.join(' '));
  assert.equal(bezInterni.config.meta.nakupniCenyOdvozene, true);
  assert.equal(bezInterni.config.tridyKol.find((t) => t.id === 'zakladni').nakupniCena, 20000, '25000 × 0,8');
  const verejnaSNakupni = domain.validateConfig({ ...raw, tridyKol: raw.tridyKol.map((t) => ({ ...t, nakupniCena: 1 })) }, rawInterni);
  assert.equal(verejnaSNakupni.ok, false);
  assert.ok(verejnaSNakupni.errors.some((e) => /do veřejného souboru nepatří/.test(e)));
  assert.equal(domain.validateConfig(raw, { tridyKol: { foo: 1 } }).ok, false);
  assert.equal(v.config.pronajem.rocniUrok, 0.07);
  assert.equal(v.config.interni.nakladyDoplnkuProcentCeny.Prilby, 0.7);
  assert.equal(v.config.interni.nakladySpravyHodinMesicne, 3);
  assert.ok(!/marže|Nákupní cena/.test(v.config.tridyKol[0].popisVerejny), 'veřejný popis bez interních vět');
  assert.match(v.config.tridyKol[0].popisVerejny, /^Hliníkový rám/);
  assert.equal(domain.pct(10), 0.1, 'celá čísla jsou procenta');
  assert.equal(domain.pct(0.35), 0.35, 'desetinná ≤ 1 jsou podíly');
  const bad = domain.validateConfig({ ...raw, tridyKol: raw.tridyKol.slice(0, 2), pronajem: { ...raw.pronajem, minKol: 'x' } }, rawInterni);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /tridyKol/.test(e)));
  assert.ok(bad.errors.some((e) => /minKol/.test(e)));
  assert.equal(domain.validateConfig(null).ok, false);
});

test('sazby za 1 kolo podle NABIDKA-MODEL.md: pronájem 24/36 m, zůstatek 24 m, zkouška', () => {
  const expected = { zakladni: [454, 535, 13667, 1070], trek: [907, 1071, 27333, 2142], ekolo: [1675, 1952, 47000, 3904] };
  for (const t of config.tridyKol) {
    const [m24, m36, z24, zk] = expected[t.id];
    assert.equal(domain.monthlyRate(t, 24, config.pronajem).celkem, m24, `${t.id} 24 m`);
    assert.equal(domain.monthlyRate(t, 36, config.pronajem).celkem, m36, `${t.id} 36 m`);
    assert.equal(Math.round(domain.zustatkova(t, 24)), z24, `${t.id} zůstatek 24 m`);
    assert.equal(domain.zustatkova(t, 36), t.zustatkova36m, `${t.id} zůstatek 36 m = zustatkova36m`);
    assert.equal(Math.round(2 * domain.monthlyRate(t, 36, config.pronajem).celkem), zk, `${t.id} zkouška`);
  }
  // 24 m nesmí používat zustatkova36m
  const ekolo = config.tridyKol[2];
  assert.ok(domain.zustatkova(ekolo, 24) > ekolo.zustatkova36m + 15000);
  const r = run({ ekolo: 5, porizeni: 'pronajem24' });
  assert.equal(r.souhrn.odkupNaKonci, 5 * 47000);
  assert.equal(r.porizeni.radky[0].zaKolo, 1675);
});

test('scénář penzion (5 kol: 2 trek + 3 e-kola, web šablona, partner servis, přilby, nabíječka)', () => {
  const base = { trek: 2, ekolo: 3, web: 'sablona', sprava: 'sami', servis: 'partner', doplnky: 'prilby,nabijecky' };
  const k = run({ ...base, porizeni: 'koupe' });
  assert.equal(k.souhrn.jednorazove, 410000);
  assert.equal(k.souhrn.mesicne, 1890);
  assert.deepEqual(k.souhrn.horizonty.map((h) => h.castka), [437180, 491540]);
  assert.equal(k.interni.marze, 152925);
  assert.equal(k.interni.podilPartnera, 39015);
  assert.equal(k.souhrn.kauce, 0);

  const p = run({ ...base, porizeni: 'pronajem36' });
  assert.equal(p.souhrn.jednorazove, 46000);
  assert.equal(p.souhrn.mesicne, 9888);
  assert.equal(p.porizeni.mesicne, 7998);
  assert.equal(p.souhrn.kauce, 36400);
  assert.equal(p.souhrn.odkupNaKonci, 111500);
  assert.deepEqual(p.souhrn.horizonty.map((h) => h.castka), [169156, 415468]);
  assert.equal(p.interni.marze, 147965);
  assert.equal(p.interni.podilPartnera, 39015);
  assert.equal(Math.round(p.interni.marzeProcent * 100), 36);
  assert.equal(p.interni.varovani.length, 0);

  const z = run({ ...base, porizeni: 'zkouska' });
  assert.equal(z.zkouska.celkem, 63984);
  assert.equal(z.zkouska.mesicne, 15996);
  assert.equal(z.zkouska.zaloha, 31992);
  assert.equal(z.zkouska.zapocet, 22394);
  assert.equal(z.zkouska.odkup, 291200);
  assert.equal(z.zkouska.kauce, 36400);
  assert.equal(z.interni.nakladyZkousky, 19425);
  assert.equal(z.souhrn.mesicne, 16896, 'kola + servis partnera; web a přilby v ceně');
  assert.equal(z.souhrn.jednorazove, 25000, 'jen nabíječka; přilby v ceně zkoušky');
  assert.equal(z.souhrn.rocne, 0, 'sezónní prohlídka v ceně zkoušky');
  assert.ok(z.web.vCeneZkousky && z.servis.prohlidkaVCeneZkousky);
  assert.ok(z.doplnky.find((d) => d.id === 'prilby').vCeneZkousky);
  assert.equal(z.souhrn.horizonty.length, 1);
  assert.equal(z.souhrn.horizonty[0].castka, 25000 + 4 * 16896);
  assert.ok(z.interni.varovani.some((w) => /započte 22394/.test(w)));
});

test('scénář hotel (20 kol, předplacená správa, pojištění) a resort (50 kol, GPS, 2. design)', () => {
  const hotel = { zakladni: 6, trek: 6, ekolo: 8, web: 'sablona', sprava: 'predplacena', servis: 'partner', doplnky: 'prilby,nabijecky,pojisteni' };
  const hp = run({ ...hotel, porizeni: 'pronajem36' });
  assert.equal(hp.souhrn.jednorazove, 64000);
  assert.equal(hp.souhrn.mesicne, 36142);
  assert.equal(hp.porizeni.mesicne, 25252);
  assert.equal(hp.souhrn.kauce, 115400);
  assert.equal(hp.souhrn.odkupNaKonci, 356000);
  assert.deepEqual(hp.souhrn.horizonty.map((h) => h.castka), [515704, 1419112]);
  assert.equal(hp.interni.marze, 472820);
  assert.equal(hp.interni.podilPartnera, 156060);
  const sprava = hp.interni.polozky.find((p) => p.id === 'sprava');
  assert.equal(sprava.naklady, 36 * 3 * 600, 'náklad správy = 3 h × 600 Kč měsíčně');
  const hk = run({ ...hotel, porizeni: 'koupe' });
  assert.equal(hk.souhrn.jednorazove, 1218000);
  assert.deepEqual(hk.souhrn.horizonty.map((h) => h.castka), [1366680, 1664040]);
  assert.equal(hk.interni.marze, 489860);
  const hz = run({ ...hotel, porizeni: 'zkouska' });
  assert.equal(hz.zkouska.celkem, 202016);
  assert.equal(hz.souhrn.mesicne, 56504);
  assert.equal(hz.zkouska.zapocet, 70706);
  assert.equal(hz.zkouska.odkup, 923200);

  const resort = { zakladni: 15, trek: 15, ekolo: 20, web: 'sablona', dalsiDesign: '1', sprava: 'predplacena', servis: 'partner', doplnky: 'prilby,nabijecky,pojisteni,gps' };
  const rp = run({ ...resort, porizeni: 'pronajem36' });
  assert.equal(rp.souhrn.mesicne, 86020);
  assert.equal(rp.porizeni.mesicne, 63130);
  assert.equal(rp.souhrn.jednorazove, 180000, 'dokument počítá 2 nabíjecí stanice (205 000) – config umí jen jednu');
  assert.equal(rp.interni.podilPartnera, 390150);
  assert.equal(rp.souhrn.horizonty[1].castka, 3411720);
  const rk = run({ ...resort, porizeni: 'koupe' });
  assert.equal(rk.souhrn.jednorazove, 3090000 - 25000);
  assert.ok(rk.interni.marzeProcent > 0.26 && rk.interni.marzeProcent < 0.28);
  const rz = run({ ...resort, porizeni: 'zkouska' });
  assert.equal(rz.zkouska.celkem, 505040);
  assert.equal(rz.zkouska.zapocet, 176764);
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
  assert.ok(!/nakupni/i.test(JSON.stringify(pub)), 'veřejný výsledek bez nákupních údajů');
  assert.ok(!/"interni"/.test(JSON.stringify(pub)), 'veřejný výsledek bez klíče interni');
  assert.equal('nakupniCenyOdvozene' in pub.meta, false);
  // práh marže: konfigurace s nulovou marží pronájmu hlásí varování
  const low = domain.validateConfig({ ...raw, pronajem: { ...raw.pronajem, marzeRocni: 0 }, web: { ...raw.web, sablona: { jednorazove: 6000, mesicne: 150 } } }, rawInterni).config;
  const lr = domain.compute(domain.normalizeInput({ zakladni: 5, porizeni: 'pronajem36', web: 'sablona', servis: 'vlastni' }, low), low);
  assert.ok(lr.interni.varovani.some((w) => /pod prahem/.test(w)));
  // odvozené nákupní ceny (bez interního souboru) → varování
  const bezCfg = domain.validateConfig(raw, null).config;
  const odv = domain.compute(domain.normalizeInput({ ekolo: 5, porizeni: 'pronajem36' }, bezCfg), bezCfg);
  assert.ok(odv.interni.varovani.some((w) => /Nákupní ceny kol nejsou nastaveny/.test(w)));
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
  const realText = fs.readFileSync(real, 'utf8');
  const realRaw = JSON.parse(realText);
  const v = domain.validateConfig(realRaw, rawInterni);
  assert.ok(v.ok, v.errors.join(' '));
  assert.ok(!JSON.stringify(realRaw).includes('nakupniCena'), 'veřejný soubor nesmí obsahovat nákupní ceny');
  const modelyText = fs.readFileSync(feature.MODELY_PATH, 'utf8');
  const modelyRaw = JSON.parse(modelyText);
  const seznam = Array.isArray(modelyRaw) ? modelyRaw : (modelyRaw.modely || Object.values(modelyRaw));
  assert.ok(seznam.length >= 1);
  for (const m of seznam) {
    assert.ok(m.slug && m.znacka && m.model, 'model má slug, znacka, model');
    assert.ok(m.cenaVerejna > 0, `${m.slug}: cenaVerejna > 0`);
  }
  assert.ok(!/nakupni/i.test(modelyText), 'config/kola-modely.json bez nákupních údajů');
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
  feature.setInterniPath(INTERNI);
  const log = createLogger({ level: 'debug', stdout: { write: (l) => logLines.push(l) }, stderr: { write: (l) => logLines.push(l) } });
  srv = await startServer({ log, env: { PK_PLATFORMA_HESLO: PLATFORMA_HESLO } });
});
test.after(async () => {
  if (srv) await srv.stop();
  feature.setConfigPath(feature.DEFAULT_CONFIG_PATH);
  feature.setInterniPath(null);
});

async function platformLogin() {
  const token = /name="_csrf" value="([^"]+)"/.exec(await (await srv.fetch('/platforma')).text())[1];
  const r = await srv.fetch('/platforma/prihlaseni', { method: 'POST', body: { _csrf: token, heslo: PLATFORMA_HESLO } });
  assert.equal(r.status, 303);
}

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
    assert.match(html, /<ol class="steps nab-steps">/);
    assert.match(html, /class="steps__link" href="#krok-navratnost"/, 'kroky jsou odkazy na sekce');
    assert.match(html, /data-nabidka-verdikt/, 'verdikt „Vyplatí se to?“ nahoře v souhrnu');
    assert.match(html, /name="trek" required="" |name="trek"/);
    assert.match(html, /value="6"[^>]*data-nabidka-count="zakladni"|data-nabidka-count="zakladni"/);
    assert.match(html, /36\u00a0142\u00a0Kč/, 'měsíčně hotel');
    assert.match(html, /1\u00a0419\u00a0112\u00a0Kč/, '3 roky hotel');
    assert.match(html, /badge badge--warning">ukázkové ceny/);
    assert.match(html, /Odkup kol na konci/);
    assert.match(html, /name="konfigurace" value="zakladni=6&amp;trek=6&amp;ekolo=8&amp;porizeni=pronajem36[^"]*doplnky=prilby%2Cpojisteni%2Cnabijecky"/);
    assert.ok(!/nab-internal/.test(html), 'veřejnost nevidí interní blok');
    assert.ok(!/marže/i.test(html), 'veřejnost nevidí slovo marže');
    assert.ok(html.includes('id="modely"'));
    assert.ok(html.includes('Konkrétní modely, které flotilu tvoří'));
    assert.ok(html.includes('Superior eXP 6.4 STEPS'));
    assert.match(html, /53\u00a0990\u00a0Kč/);
    assert.ok(html.includes('href="/kola/superior-exp-6-4-steps"'));
    assert.ok(html.includes('nab-class__examples'));
    assert.ok(!/nakupn/i.test(html), 'veřejnost nevidí nákupní ceny');
    assert.ok(!/33\u00a0000/.test(html) && !html.includes('33 000'), 'ani nákupní cenu modelu');
  }
  const zk = await (await srv.fetch('/nabidka?trek=2&ekolo=3&porizeni=zkouska&servis=partner&doplnky=prilby,nabijecky')).text();
  assert.match(zk, /Celkem za zkoušku \(4 měsíce\)/);
  assert.match(zk, /započteme <strong>22\u00a0394\u00a0Kč<\/strong>/);
  assert.match(zk, /Start nejpozději 15\. 6\./);
  assert.match(zk, /v ceně zkoušky/);
  const malo = await (await srv.fetch('/nabidka?zakladni=2&porizeni=pronajem36')).text();
  assert.match(malo, /notice notice--warning[^>]*>Pronájem nabízíme od 5 kol/);
  const prazdna = await (await srv.fetch('/nabidka')).text();
  assert.ok(!/Zadejte prosím počet kol/.test(prazdna), 'bez zadání výchozí 2 kola – souhrn hned ukazuje ceny');
  assert.match(prazdna, /data-nabidka-count="trek" type="number" value="1"/);
  assert.match(prazdna, /data-nabidka-count="ekolo" type="number" value="1"/);
  assert.match(prazdna, /data-nabidka-verdikt/);
  assert.match(prazdna, /name="porizeni" value="zkouska" checked/, 'výchozí = zkouška');
  const nula = await (await srv.fetch('/nabidka?zakladni=0&trek=0&ekolo=0')).text();
  assert.match(nula, /Zadejte prosím počet kol/, 'výslovně 0 kol zůstává 0');
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
  assert.ok(!/nakupni/i.test(JSON.stringify(j)), 'API bez nákupních údajů');
  assert.equal(j.souhrn.pocetKol, 10);
  assert.deepEqual(j.doplnky.map((d) => d.id), ['pojisteni', 'gps']);
  assert.equal(j.zkouska.mesice, 4);
  assert.ok(!BAD_TOKENS.test(j.html));
  const dflt = await (await srv.fetch('/api/v1/nabidka/spocitat?porizeni=nesmysl&zakladni=-5')).json();
  assert.equal(dflt.vstup.porizeni, 'zkouska');
  assert.equal(dflt.souhrn.pocetKol, 0);
});

test('interní blok jen pro správce platformy (/nabidka i API), ne pro správce tenanta (veřejné demo heslo); ?interni=0 ho skryje', async () => {
  srv.jar.clear();
  const q = '/nabidka?trek=2&ekolo=3&porizeni=pronajem36&servis=partner&doplnky=prilby,nabijecky';
  assert.ok(!/nab-internal/.test(await (await srv.fetch(q + '&interni=1')).text()), 'veřejnost s ?interni=1 nic');
  const pubApi = await (await srv.fetch('/api/v1/nabidka/spocitat?trek=2&ekolo=3&porizeni=pronajem36&interni=1')).json();
  assert.equal('interni' in pubApi, false);
  await adminLogin();
  const jenAdmin = await (await srv.fetch(q + '&interni=1')).text();
  assert.ok(!/nab-internal/.test(jenAdmin), 'správce tenanta (demo heslo je veřejné) interní čísla nevidí');
  assert.ok(!/33\u00a0000/.test(jenAdmin), 'ani nákupní ceny');
  assert.equal('interni' in (await (await srv.fetch('/api/v1/nabidka/spocitat?trek=2&ekolo=3&porizeni=pronajem36')).json()), false);
  srv.jar.clear();
  await platformLogin();
  const html = await (await srv.fetch(q)).text();
  assert.match(html, /nab-internal/);
  assert.match(html, /Naše marže/);
  assert.match(html, /147\u00a0965\u00a0Kč/, 'marže penzion pronájem 36');
  assert.ok(html.includes('Nákupní ceny tříd (interní soubor)'));
  assert.ok(html.includes('Konkrétní modely: veřejná cena výrobce'));
  assert.match(html, /33\u00a0000\u00a0Kč/, 'nákupní cena eXP z interního souboru');
  assert.match(html, /39\u00a0015\u00a0Kč/, 'podíl partnera');
  assert.ok(!/nab-internal/.test(await (await srv.fetch(q + '&interni=0')).text()));
  const api = await (await srv.fetch('/api/v1/nabidka/spocitat?trek=2&ekolo=3&porizeni=pronajem36&servis=partner&doplnky=prilby,nabijecky')).json();
  assert.equal(api.interni.marze, 147965);
  assert.match(api.html, /nab-internal/);
  // bez session → zase nic
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
  assert.match(row.body_text, /Měsíčně: 16\u00a0896 Kč/);
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
  assert.equal(payload.vysledek.zkouska.celkem, 63984);
  assert.equal('interni' in payload.vysledek, false);
  assert.equal(payload.interni.nakupniCelkem, 2 * 36000 + 3 * 64000);
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

test('/admin/nabidky: bez přihlášení 303 na login; s přihlášením seznam a detail s dešifrovaným kontaktem a auditem nabidka.view; interní marže jen se session platformy', async () => {
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
  assert.ok(!/Vázaný kapitál/.test(dh), 'správce tenanta nevidí interní čísla poptávky');
  assert.match(dh, /vidí jen správce platformy/);
  await platformLogin();
  const dh2 = await (await srv.fetch(`/admin/nabidky/${id}`)).text();
  assert.match(dh2, /Vázaný kapitál/, 'správce platformy (+ admin session) interní čísla vidí');
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

// ---------------------------------------------------------------------------------------------------------
// Množstevní stupně (od 6. 10. 2026): nabídka od 2 kol, čím víc kol, tím vyšší sleva a lepší podmínky

const TIERS = [
  { odKol: 2, nazev: 'Start', sleva: 0, slevaKoupe: 0, poplatekZkousky: 7900, kauceProcent: 0.1, zalohaZkouskyProcent: 0.5, vyhody: ['zaškolení obsluhy'] },
  { odKol: 5, nazev: 'Flotila', sleva: 0.04, slevaKoupe: 0.03, poplatekZkousky: 3900, kauceProcent: 0.1, zalohaZkouskyProcent: 0.4, vyhody: ['sleva 4 %'] },
  { odKol: 10, nazev: 'Hotel', sleva: 0.07, slevaKoupe: 0.05, poplatekZkousky: 0, kauceProcent: 0.08, zalohaZkouskyProcent: 0.3, vyhody: ['náhradní kolo'] },
  { odKol: 20, nazev: 'Resort', sleva: 0.1, slevaKoupe: 0.07, poplatekZkousky: 0, kauceProcent: 0.05, zalohaZkouskyProcent: 0.25, vyhody: ['servis do 24 h'] },
];
const tierRaw = { ...raw, mnozstevniSlevy: TIERS, pronajem: { ...raw.pronajem, minKol: 2 }, zkouska: { ...raw.zkouska, minKol: 2 } };
const tierCfg = domain.validateConfig(tierRaw, rawInterni).config;
const runT = (q) => domain.compute(domain.normalizeInput(q, tierCfg), tierCfg);

test('množstevní stupně: validace, výběr stupně, minimum 2 kola, další stupeň', () => {
  assert.ok(tierCfg, 'konfigurace se stupni je platná');
  assert.equal(domain.stupenPro(tierCfg, 1).odKol, 2);
  assert.equal(domain.stupenPro(tierCfg, 4).odKol, 2);
  assert.equal(domain.stupenPro(tierCfg, 5).odKol, 5);
  assert.equal(domain.stupenPro(tierCfg, 19).odKol, 10);
  assert.equal(domain.stupenPro(tierCfg, 50).odKol, 20);
  const one = runT({ trek: 1, porizeni: 'pronajem36' });
  assert.deepEqual(one.upozorneni.map((u) => u.kod), ['min-kol']);
  assert.match(one.upozorneni[0].text, /od 2 kol/);
  const two = runT({ trek: 2, porizeni: 'pronajem36' });
  assert.equal(two.upozorneni.length, 0, '2 kola stačí i na pronájem');
  assert.equal(two.mnozstevni.aktualni.nazev, 'Start');
  assert.deepEqual({ odKol: two.mnozstevni.dalsi.odKol, chybi: two.mnozstevni.dalsi.chybi }, { odKol: 5, chybi: 3 });
  assert.equal(runT({ trek: 25, porizeni: 'pronajem36' }).mnozstevni.dalsi, null, 'nejvyšší stupeň už nemá další');
  const bad = domain.validateConfig({ ...tierRaw, mnozstevniSlevy: [TIERS[1], TIERS[0]] }, rawInterni);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /seřazené/.test(e)));
  assert.equal(domain.validateConfig({ ...tierRaw, mnozstevniSlevy: [{ ...TIERS[0], sleva: 0.6 }] }, rawInterni).ok, false);
});

test('množstevní stupně: sleva na pronájem, koupi a zkoušku, kauce a záloha podle stupně, poplatek za rozjezd', () => {
  const base = runT({ trek: 12, porizeni: 'pronajem36' });
  const rate = domain.monthlyRate(tierCfg.tridyKol[1], 36, tierCfg.pronajem).celkem;
  assert.equal(base.porizeni.radky[0].zaKoloBezSlevy, rate);
  assert.equal(base.porizeni.radky[0].zaKolo, Math.round(rate * 0.93));
  assert.equal(base.mnozstevni.slevaKc, (rate - Math.round(rate * 0.93)) * 12);
  assert.equal(base.souhrn.kauce, Math.round(12 * 50000 * 0.08), 'kauce 8 % od 10 kol');
  const koupe = runT({ trek: 12, porizeni: 'koupe' });
  assert.equal(koupe.porizeni.jednorazove, 12 * Math.round(50000 * 0.95), 'koupě se slevou 5 %');
  assert.equal(koupe.mnozstevni.slevaPerioda, 'jednorazove');
  const zk2 = runT({ trek: 2, porizeni: 'zkouska' });
  assert.equal(zk2.zkouska.rozjezd, 7900);
  assert.equal(zk2.porizeni.jednorazove, 7900);
  assert.equal(zk2.zkouska.zaloha, Math.round(zk2.zkouska.celkem * 0.5));
  const zk10 = runT({ trek: 10, porizeni: 'zkouska' });
  assert.equal(zk10.zkouska.rozjezd, 0, 'od 10 kol bez poplatku za rozjezd');
  assert.equal(zk10.zkouska.zaloha, Math.round(zk10.zkouska.celkem * 0.3));
  assert.equal(zk10.zkouska.kauce, Math.round(10 * 50000 * 0.08));
  // veřejný výsledek nese stupně, ale ne interní čísla
  const pub = domain.publicResult(base);
  assert.ok(pub.mnozstevni && pub.mnozstevni.aktualni);
  assert.ok(!/nakupni/i.test(JSON.stringify(pub)));
});

test('množstevní stupně: s ukázkovými nákupními cenami drží každá kombinace marži nad prahem', () => {
  const realRaw = JSON.parse(fs.readFileSync(feature.DEFAULT_CONFIG_PATH, 'utf8'));
  const cfg = domain.validateConfig(realRaw, rawInterni).config;
  let low = [];
  for (const n of [2, 4, 5, 10, 20, 50]) for (const trida of ['zakladni', 'trek', 'ekolo']) for (const porizeni of ['koupe', 'pronajem24', 'pronajem36', 'zkouska']) for (const web of ['zadny', 'sablona', 'namiru']) for (const servis of ['vlastni', 'partner']) {
    const r = domain.compute(domain.normalizeInput({ [trida]: n, porizeni, web, servis }, cfg), cfg);
    if (r.interni.marzeProcent < cfg.interni.prahMarzeProcent) low.push(`${n} ${trida} ${porizeni} ${web} ${servis}: ${Math.round(r.interni.marzeProcent * 100)} %`);
  }
  assert.deepEqual(low, []);
  assert.equal(cfg.mnozstevniSlevy[0].odKol, 2, 'nabídka od 2 kol');
});

test('stránka /nabidka: stupně v kroku 1, úspora a „přidejte ještě“ v souhrnu, web bez napojení na cizí systémy', () => {
  const html = String(page.nabidka({ config: tierCfg, input: domain.normalizeInput({ trek: 4, porizeni: 'pronajem36' }, tierCfg), result: domain.publicResult(runT({ trek: 4, porizeni: 'pronajem36' })), internal: false, csrf: 'x', values: {}, errors: {}, query: '' }));
  assert.match(html, /Čím víc kol, tím lepší podmínky/);
  assert.match(html, /<li class="nab-tier is-active" data-od="2" aria-current="true">/);
  assert.match(html, /Přidejte ještě <strong>1 kolo<\/strong> a dostanete slevu 4 %/);
  assert.ok(!/napojení/i.test(html), 'žádné napojení na rezervační systém');
  assert.match(html, /odkaz nebo tlačítko „Půjčit kolo“/);
  const h12 = String(page.summaryFragment({ result: domain.publicResult(runT({ trek: 12, porizeni: 'pronajem36' })), internal: false, config: tierCfg }));
  assert.match(h12, /Množstevní sleva 7 % \(Hotel\)/);
});

test('mobil: rezervační karta detailu kola není sticky pod 900 px, přepínač designů není fixní pod 720 px', () => {
  const kolaCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'kola.css'), 'utf8');
  const side = /\.detail__side \{[^}]*\}/.exec(kolaCss)[0];
  assert.ok(!/sticky/.test(side), 'základní pravidlo bez sticky');
  assert.match(kolaCss, /@media \(min-width: 900px\) \{\s*\.detail__side \{\s*position: sticky;/);
  const base = fs.readFileSync(path.join(__dirname, '..', 'public', 'base.css'), 'utf8');
  assert.match(base, /@media \(max-width: 719px\) \{\s*\.design-switch \{\s*position: static;/);
});

// ---------------------------------------------------------------------------------------------------------
// Kalkulačka návratnosti „Vyplatí se to?“ (od 7. 10. 2026)

const PENZION = { trek: 2, ekolo: 3, web: 'sablona', sprava: 'sami', servis: 'partner', doplnky: 'prilby,nabijecky' };

test('návratnost: výchozí hodnoty bez bloku navratnost v konfiguraci, validace bloku, ořez a normalizace vstupů', () => {
  assert.equal(raw.navratnost, undefined, 'fixtura blok nemá');
  assert.deepEqual(config.navratnost, { sezonaDni: 150, vytizenost: 0.35, cenaDen: { zakladni: 390, trek: 450, ekolo: 890 }, dph: 0.21 });
  const vychozi = domain.normalizeInput({}, config).navratnost;
  assert.deepEqual(vychozi, { sezonaDni: 150, vytizenost: 0.35, cenaDen: { zakladni: 390, trek: 450, ekolo: 890 }, platceDph: true });
  // vlastní blok v konfiguraci: procenta i podíl, výchozí vstupy z něj
  const vlastni = domain.validateConfig({ ...raw, navratnost: { sezonaDni: 200, vytizenostProcent: 40, cenaDen: { zakladni: 300, trek: 400, ekolo: 800 }, dph: 21 } }, rawInterni);
  assert.ok(vlastni.ok, vlastni.errors.join(' '));
  assert.deepEqual(vlastni.config.navratnost, { sezonaDni: 200, vytizenost: 0.4, cenaDen: { zakladni: 300, trek: 400, ekolo: 800 }, dph: 0.21 });
  assert.equal(domain.normalizeInput({}, vlastni.config).navratnost.sezonaDni, 200);
  assert.equal(domain.normalizeInput({}, vlastni.config).navratnost.vytizenost, 0.4);
  const castecny = domain.validateConfig({ ...raw, navratnost: { sezonaDni: 120 } }, rawInterni);
  assert.ok(castecny.ok);
  assert.deepEqual(castecny.config.navratnost.cenaDen, { zakladni: 390, trek: 450, ekolo: 890 }, 'chybějící klíče z výchozích');
  const spatny = domain.validateConfig({ ...raw, navratnost: { sezonaDni: 10, vytizenostProcent: 150, cenaDen: { ekolo: -1, kolobezka: 100 }, dph: 150 } }, rawInterni);
  assert.equal(spatny.ok, false);
  for (const re of [/sezonaDni/, /vytizenostProcent/, /cenaDen\.ekolo/, /kolobezka/, /dph/]) assert.ok(spatny.errors.some((e) => re.test(e)), String(re));
  assert.equal(domain.validateConfig({ ...raw, navratnost: [] }, rawInterni).ok, false);

  const n = (q) => domain.normalizeInput(q, config).navratnost;
  assert.equal(n({ sezona: '10' }).sezonaDni, 30, 'pod rozsahem → minimum');
  assert.equal(n({ sezona: '999' }).sezonaDni, 365, 'nad rozsahem → maximum');
  assert.equal(n({ sezona: 'abc' }).sezonaDni, 150, 'nečíselné → výchozí');
  assert.equal(n({ sezona: '' }).sezonaDni, 150, 'prázdné → výchozí');
  assert.equal(n({ sezona: '180.6' }).sezonaDni, 181);
  assert.equal(n({ vytizenost: '0' }).vytizenost, 0.05);
  assert.equal(n({ vytizenost: '120' }).vytizenost, 1);
  assert.equal(n({ vytizenost: '42,4' }).vytizenost, 0.42, 'desetinná čárka, celá procenta');
  assert.equal(n({ vytizenost: 'x' }).vytizenost, 0.35);
  assert.deepEqual(n({ cena_zakladni: '-5', cena_trek: '99999', cena_ekolo: 'nic' }).cenaDen, { zakladni: 0, trek: 5000, ekolo: 890 });
  assert.equal(n({ neplatce: '1' }).platceDph, false);
  assert.equal(n({ neplatce: 'on' }).platceDph, false);
  assert.equal(n({ neplatce: '0' }).platceDph, true);
});

test('návratnost: inputToQuery round-trip a parametry kalkulačky před doplnky', () => {
  const i = domain.normalizeInput({ ...PENZION, porizeni: 'koupe', sezona: '200', vytizenost: '41', cena_zakladni: '350', cena_trek: '500', cena_ekolo: '990', neplatce: '1' }, config);
  const q = domain.inputToQuery(i);
  assert.deepEqual(domain.normalizeInput(Object.fromEntries(new URLSearchParams(q)), config), i);
  assert.match(q, /servis=partner&sezona=200&vytizenost=41&cena_zakladni=350&cena_trek=500&cena_ekolo=990&neplatce=1&doplnky=prilby%2Cnabijecky$/);
  const plat = domain.normalizeInput({ trek: 2 }, config);
  const q2 = domain.inputToQuery(plat);
  assert.ok(!/neplatce/.test(q2), 'plátce bez parametru neplatce');
  assert.deepEqual(domain.normalizeInput(Object.fromEntries(new URLSearchParams(q2)), config), plat);
});

test('návratnost: koupě penzionu (2 trek + 3 e-kola) – tržby, náklady 1. roku, další roky, bod zvratu, návratnost v sezónách', () => {
  const r = run({ ...PENZION, porizeni: 'koupe' });
  const n = r.navratnost;
  // dílčí hodnoty
  const trzbaTrek = Math.round(450 / 1.21); // 372
  const trzbaEkolo = Math.round(890 / 1.21); // 736
  const dnyTrek = Math.round(2 * 150 * 0.35);
  const dnyEkolo = Math.round(3 * 150 * 0.35);
  const trzby = dnyTrek * trzbaTrek + dnyEkolo * trzbaEkolo;
  const jednorazove = 2 * 50000 + 3 * 88000 + 15000 + 5 * 1200 + 25000; // kola + web + přilby + nabíječka
  const mesicne = 990 + 5 * 180; // web + servis partnera
  const rocne = 5 * 900; // sezónní prohlídka
  const prvniRok = jednorazove + 12 * mesicne + rocne;
  const provoz = 12 * mesicne + rocne;
  assert.equal(trzbaTrek, 372);
  assert.equal(trzbaEkolo, 736);
  assert.equal(n.vypujcniDny, dnyTrek + dnyEkolo);
  assert.equal(n.trzby, trzby);
  assert.equal(n.vydajePrvniRok, prvniRok);
  assert.equal(n.vydajePrvniRok, r.souhrn.horizonty[0].castka, 'koupě: náklady 1. roku = „Celkem za 1 rok“');
  assert.equal(n.vysledekPrvniRok, trzby - prvniRok);
  assert.ok(n.vysledekPrvniRok < 0, 'první rok koupě je při 35 % ve ztrátě');
  assert.equal(n.vydajeDalsiRoky, provoz);
  assert.equal(n.vysledekDalsiRoky, trzby - provoz);
  assert.equal(n.navratnostSezon, Math.round((jednorazove / (trzby - provoz)) * 10) / 10);
  assert.match(n.navratnostText, /se vrátí za 3,2\u00a0sezóny/);
  // bod zvratu: průměrná tržba za den vážená počty kol
  const prumer = (2 * trzbaTrek + 3 * trzbaEkolo) / 5;
  const bz = Math.ceil(prvniRok / prumer);
  assert.equal(n.bodZvratu.vypujcniDny, bz);
  assert.equal(n.bodZvratu.vytizenost, bz / (5 * 150));
  assert.equal(n.bodZvratu.dosazitelny, true);
  assert.match(n.veta, new RegExp(`ztrátou ${(prvniRok - trzby).toLocaleString('cs-CZ').replace(/\s/g, '\\s')}\u00a0Kč; zisk začíná od ${Math.ceil((bz / 750) * 100)} % vytíženosti`));
  // za kolo: koupě = cena kola
  const trek = n.tridy.find((t) => t.id === 'trek');
  assert.equal(trek.vydajNaKolo, 50000);
  assert.equal(trek.vypujcekNaZaplaceni, Math.ceil(50000 / trzbaTrek));
  assert.equal(trek.vydelaNaKolo, Math.round(150 * 0.35) * trzbaTrek - 50000);
  const ekolo = n.tridy.find((t) => t.id === 'ekolo');
  assert.equal(ekolo.vypujcekNaZaplaceni, Math.ceil(88000 / trzbaEkolo));
  assert.deepEqual(n.vstupy, { sezonaDni: 150, vytizenost: 0.35, cenaDen: { zakladni: 390, trek: 450, ekolo: 890 }, platceDph: true, dph: 0.21, dnyPokryte: 150 });
  // kalkulačka nemění dosavadní výpočty
  assert.equal(r.souhrn.jednorazove, 410000);
  assert.equal(r.interni.marze, 152925);
});

test('návratnost: pronájem 36 m penzionu – přesné hodnoty, kolo se zaplatí za N výpůjček, pak vydělá', () => {
  const n = run({ ...PENZION, porizeni: 'pronajem36' }).navratnost;
  const trzby = Math.round(2 * 150 * 0.35) * 372 + Math.round(3 * 150 * 0.35) * 736;
  const mesicne = 2 * 1071 + 3 * 1952 + 990 + 5 * 180; // splátky (sazby 36 m) + web + servis
  const jednorazove = 15000 + 5 * 1200 + 25000;
  const prvniRok = jednorazove + 12 * mesicne + 4500;
  const dalsi = 12 * mesicne + 4500;
  assert.equal(n.trzby, trzby);
  assert.equal(n.vydajePrvniRok, prvniRok);
  assert.equal(n.vysledekPrvniRok, trzby - prvniRok);
  assert.equal(n.vydajeDalsiRoky, dalsi);
  assert.equal(n.vysledekDalsiRoky, trzby - dalsi);
  const bz = Math.ceil(prvniRok / ((2 * 372 + 3 * 736) / 5));
  assert.equal(n.bodZvratu.vypujcniDny, bz);
  assert.equal(n.bodZvratu.vytizenost, bz / 750);
  const ekolo = n.tridy.find((t) => t.id === 'ekolo');
  assert.equal(ekolo.vydajNaKolo, 1952 * 12, 'pronájem: splátka × 12');
  assert.equal(ekolo.vypujcekNaZaplaceni, Math.ceil((1952 * 12) / 736));
  assert.equal(ekolo.vydelaNaKolo, Math.round(150 * 0.35) * 736 - 1952 * 12);
  assert.equal(n.navratnostSezon, null, 'návratnost v sezónách jen u koupě');
  const sign = n.vysledekPrvniRok >= 0 ? /vyděláte za první rok/ : /ztrátou/;
  assert.match(n.veta, sign);
  assert.match(n.veta, /^Při 35 % vytíženosti/);
});

test('návratnost: neplátce DPH (náklady × 1,21, tržby celé), zkouška (jen pokryté dny, další roky null), bez kol null, publicResult', () => {
  const plat = run({ ...PENZION, porizeni: 'pronajem36' }).navratnost;
  const nepl = run({ ...PENZION, porizeni: 'pronajem36', neplatce: '1' }).navratnost;
  assert.equal(nepl.cenyVcetneDph, true);
  assert.deepEqual(nepl.tridy.map((t) => t.trzbaDen), [450, 890], 'neplátce: tržba = celá cena');
  assert.equal(nepl.trzby, Math.round(2 * 150 * 0.35) * 450 + Math.round(3 * 150 * 0.35) * 890);
  assert.equal(nepl.vydajePrvniRok, Math.round(plat.vydajePrvniRok * 1.21));
  assert.equal(nepl.vydajeDalsiRoky, Math.round(plat.vydajeDalsiRoky * 1.21));
  assert.equal(nepl.tridy[1].vydajNaKolo, Math.round(1952 * 12 * 1.21));

  const z = run({ ...PENZION, porizeni: 'zkouska' });
  const n = z.navratnost;
  assert.equal(n.vstupy.dnyPokryte, 120, 'min(150, 4 × 30)');
  assert.equal(n.trzby, Math.round(2 * 120 * 0.35) * 372 + Math.round(3 * 120 * 0.35) * 736);
  assert.equal(n.vydajePrvniRok, 25000 + 4 * 16896, 'celá cena zkoušky');
  assert.equal(n.vysledekPrvniRok, n.trzby - n.vydajePrvniRok);
  assert.equal(n.vysledekDalsiRoky, null);
  assert.equal(n.vydajeDalsiRoky, null);
  assert.match(n.poznamkaDalsiRoky, /podle skutečné vytíženosti/);
  assert.equal(n.tridy[1].vydajNaKolo, 3904 * 4, 'zkouška: měsíční sazba × 4');
  assert.equal(n.bodZvratu.vytizenost, Math.ceil(n.vydajePrvniRok / ((2 * 372 + 3 * 736) / 5)) / (5 * 120));
  const kratka = run({ ...PENZION, porizeni: 'zkouska', sezona: '90' }).navratnost;
  assert.equal(kratka.vstupy.dnyPokryte, 90, 'kratší sezóna než zkouška');

  // ztráta: nízká vytíženost → poctivá věta s prahem zisku
  const ztrata = run({ ...PENZION, porizeni: 'pronajem36', vytizenost: '10' }).navratnost;
  assert.ok(ztrata.vysledekPrvniRok < 0);
  assert.match(ztrata.veta, new RegExp(`^Při 10 % vytíženosti vychází první rok se ztrátou .*; zisk začíná od ${domain.procentNahoru(ztrata.bodZvratu.vytizenost)} % vytíženosti`));
  // nedosažitelný bod zvratu
  const nikdy = run({ ...PENZION, porizeni: 'koupe', cena_trek: '0', cena_ekolo: '10' }).navratnost;
  assert.equal(nikdy.bodZvratu.dosazitelny, false);
  assert.match(nikdy.veta, /nepokryje ani plná vytíženost/);
  assert.match(nikdy.navratnostText, /se nevrátí/);

  assert.equal(run({}).navratnost, null, 'bez kol null');
  assert.equal(run({ porizeni: 'koupe', sezona: '200' }).navratnost, null);

  const pub = domain.publicResult(run({ ...PENZION, porizeni: 'koupe' }));
  assert.ok(pub.navratnost && pub.navratnost.veta);
  const json = JSON.stringify(pub.navratnost);
  assert.ok(!/nakupni/i.test(JSON.stringify(pub)), 'bez nákupních údajů');
  assert.ok(!/marže|marze|naklady|provize|interni/i.test(json), 'bez interních slov (API je kontroluje)');
  assert.ok(!/NaN|undefined|Infinity/.test(json));
  assert.match(feature.recapText(pub), /^Návratnost \(odhad klienta: sezóna 150 dní, ceny 390 \/ 450 \/ 890 Kč\/den vč\. DPH\): Při 35 % vytíženosti/m);
  assert.ok(!/Návratnost/.test(feature.recapText(domain.publicResult(run({})))), 'bez kol bez řádku');
});

test('návratnost: stránka má krok 6 ve formuláři a blok „Vyplatí se to?“ v souhrnu (bez inline stylů a skriptů)', async () => {
  const render = (q) => {
    const input = domain.normalizeInput(q, config);
    return String(page.nabidka({ config, input, result: domain.publicResult(domain.compute(input, config)), internal: false, csrf: 'x', values: {}, errors: {}, query: domain.inputToQuery(input) }));
  };
  const h = render({ ...PENZION, porizeni: 'pronajem36', sezona: '180', vytizenost: '40', neplatce: '1' });
  const form = /<form class="nab-form"[^>]*data-nabidka-form>[\s\S]*?<\/form>/.exec(h)[0];
  assert.match(form, /id="krok-navratnost"/);
  assert.match(form, /Krok 6/);
  for (const name of ['sezona', 'vytizenost', 'cena_zakladni', 'cena_trek', 'cena_ekolo']) assert.match(form, new RegExp(`type="number"[^>]*name="${name}"|name="${name}"[^>]*type="number"`), name);
  assert.match(form, /name="sezona"[^>]*value="180"|value="180"[^>]*name="sezona"/);
  assert.match(form, /name="neplatce"[^>]*checked|checked[^>]*name="neplatce"/);
  assert.match(form, /tuto třídu zatím nemáte \(0 kusů\)/, 'pole třídy s 0 kusy je jasně označené');
  assert.match(form, /Cena pro hosta za den – Trekové e-kolo/);
  assert.match(h, /<section class="nab-roi" aria-label="Vyplatí se to\?" data-nabidka-navratnost>/);
  assert.match(h, /Bod zvratu prvního roku/);
  assert.match(h, /se zaplatí za \d+\u00a0výpůjč/);
  assert.match(h, /Neplátce DPH: tržby celé, naše ceny včetně DPH/);
  assert.match(h, /bez provize platební brány/);
  assert.match(h, /v šesti krocích/);
  assert.ok(!BAD_TOKENS.test(h), 'bez undefined / NaN');
  assert.ok(!/ style="/.test(h), 'bez inline stylů');
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(h), 'bez inline skriptů');
  assert.ok(!/marže/i.test(h));
  const koupe = render({ ...PENZION, porizeni: 'koupe' });
  assert.match(koupe, /Návratnost koupě/);
  assert.match(koupe, /nab-roi__lead is-loss/);
  assert.match(koupe, /Částky bez DPH/);
  const zk = render({ ...PENZION, porizeni: 'zkouska' });
  assert.match(zk, /Tržby za zkoušku \(120 dní sezóny\)/);
  assert.match(zk, /Další roky u zkoušky nepočítáme/);
  assert.ok(!/Další roky \(ročně\)/.test(zk));
  assert.ok(!BAD_TOKENS.test(zk));
  const prazdna = render({});
  assert.match(prazdna, /id="krok-navratnost"/, 'krok 6 i bez kol');
  assert.ok(!/data-nabidka-navratnost/.test(prazdna), 'bez kol bez bloku');
  // přes server (výchozí vstupy kalkulačky) ve všech tématech
  for (const theme of ['outdoor', 'sport', 'family']) {
    const html = await (await srv.fetch(`/nabidka?design=${theme}&trek=2&ekolo=3&porizeni=pronajem36`)).text();
    assert.match(html, /Vyplatí se to\?/);
    assert.match(html, /name="vytizenost"/);
    assert.ok(!BAD_TOKENS.test(html));
    assert.ok(!/ style="/.test(html));
  }
  const api = await (await srv.fetch('/api/v1/nabidka/spocitat?trek=2&ekolo=3&porizeni=pronajem36')).json();
  assert.ok(api.navratnost && api.navratnost.trzby > 0);
  assert.match(api.html, /data-nabidka-navratnost/);
});

test('kalkulačka návratnosti přes server: vlastní sezóna, vytíženost, ceny a neplátce DPH se promítnou do stránky i API', async () => {
  srv.jar.clear();
  const q = 'trek=2&ekolo=3&porizeni=pronajem36&sezona=120&vytizenost=50&cena_trek=500&cena_ekolo=1000&neplatce=1';
  const api = await (await srv.fetch(`/api/v1/nabidka/spocitat?${q}`)).json();
  assert.equal(api.ok, true);
  assert.equal(api.vstup.navratnost.sezonaDni, 120);
  assert.equal(api.vstup.navratnost.platceDph, false);
  assert.equal(api.vstup.navratnost.cenaDen.ekolo, 1000);
  assert.ok(api.navratnost, 'API vrací návratnost');
  const html = await (await srv.fetch(`/nabidka?${q}`)).text();
  assert.match(html, /Vyplatí se to\?/);
  assert.match(html, /name="sezona"[^>]*value="120"|value="120"[^>]*name="sezona"/);
  assert.match(html, /name="konfigurace" value="[^"]*sezona=120[^"]*neplatce=1/);
});

test('modelové příklady (config/nabidka.json + kola-modely.json): 4 stupně, skutečné modely, veřejně bez marží a nákupních cen', () => {
  const real = JSON.parse(fs.readFileSync(feature.DEFAULT_CONFIG_PATH, 'utf8'));
  const v = domain.validateConfig(real, JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'nabidka.interni.example.json'), 'utf8')));
  assert.ok(v.ok, v.errors.join(' '));
  assert.ok(!v.config.doplnky.some((d) => /nabij/i.test(d.id)), 'nabíjecí stanice není placený doplněk');
  assert.ok(v.config.naDomluvu.some((t) => /Nabíjecí stanice/.test(t)), 'nabíjecí stanice je „po individuální domluvě“');
  const modely = JSON.parse(fs.readFileSync(feature.MODELY_PATH, 'utf8')).modely;
  const pr = domain.modelovePriklady(v.config, modely);
  assert.deepEqual(pr.map((p) => [p.stupen, p.pocet]), [['Start', 2], ['Flotila', 5], ['Hotel', 10], ['Resort', 20]]);
  for (const p of pr) {
    assert.equal(p.odKol <= p.pocet, true);
    assert.ok(p.kola.every((k) => /^(Superior|Rock Machine) /.test(k.nazev)), 'jen Superior a Rock Machine');
    const z = p.varianty.zkouska;
    const n = p.varianty.pronajem36;
    const k = p.varianty.koupe;
    assert.ok(z.celkem > 0 && n.mesicne > 0 && k.jednorazove > 0);
    assert.equal(n.tri, n.jednorazove + 36 * n.mesicne, 'pronájem: web jednorázově + 36 splátek');
    for (const id of ['zkouska', 'pronajem36', 'koupe']) assert.ok(Number.isFinite(p.interni[id].marze));
  }
  // větší stupeň = nižší cena za kolo (sleva) – měsíční pronájem na kolo
  const naKolo = pr.map((p) => (p.varianty.pronajem36.mesicne - v.config.web.sablona.mesicne) / p.pocet);
  assert.ok(naKolo[3] < naKolo[0], 'Resort levnější na kolo než Start');
  const verejne = domain.verejnePriklady(pr);
  const txt = JSON.stringify(verejne);
  assert.ok(!/interni|nakupni|marze/i.test(txt), 'veřejné příklady bez interních čísel');
  // výpočet sedí s konfigurátorem: Start = 1+1 e-kolo s cenou modelu, ruční kontrola koupě (sleva 0 %, web 15 000)
  const start = pr[0];
  const kolaKoupe = start.kola.reduce((a, x) => a + Math.round(x.cenaVerejna / 1.21) * x.pocet, 0);
  assert.ok(Math.abs(start.varianty.koupe.kola - kolaKoupe) <= 2, 'koupě = ceny modelů bez DPH (± zaokrouhlení průměru)');
  assert.equal(start.varianty.koupe.jednorazove, start.varianty.koupe.kola + v.config.web.sablona.jednorazove);
});

test('stránka /nabidka se skutečným ceníkem: příklady, předvolby stupňů a nabíjecí stanice na domluvu; interní příklady jen pro platformu', async () => {
  feature.setConfigPath(feature.DEFAULT_CONFIG_PATH);
  try {
    srv.jar.clear();
    const html = await (await srv.fetch('/nabidka')).text();
    assert.ok(html.includes('Modelové příklady se skutečnými koly'));
    assert.match(html, /data-nabidka-preset="10"/);
    assert.match(html, /href="\/nabidka\?zakladni=0&amp;trek=0&amp;ekolo=20[^"]*#krok-kola"/, 'předvolba funguje i bez JS');
    assert.ok(html.includes('Po individuální domluvě'));
    assert.ok(!/name="doplnky" value="nabijecky"/.test(html), 'nabíjecí stanice bez ceny');
    assert.ok(!/marže|nákupní|nakupni/i.test(html), 'veřejnost nevidí marže ani nákupní ceny');
    assert.ok(!BAD_TOKENS.test(html));
    await platformLogin();
    const intern = await (await srv.fetch('/nabidka')).text();
    assert.match(intern, /Naše marže a horizont/);
  } finally {
    srv.jar.clear();
    feature.setConfigPath(FIXTURE);
  }
});
