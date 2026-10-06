'use strict';
// Integrační testy kostry přes běžící server: hlavičky (CSP přesně), statické soubory, stránky home/kontakt/design,
// 404 v layoutu, health, CSRF (POST bez tokenu → 403), kontaktní formulář → outbox, přepínač designu, téma podle hostu,
// tenant podle hostu, bez inline skriptů/stylů, žádné PII v logu.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { CSP } = require('../src/http/headers');
const { createLogger } = require('../src/log');

const EXPECTED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: https://*.tile.openstreetmap.fr https://*.tile-cyclosm.openstreetmap.fr https://tile.openstreetmap.org https://*.tile.opentopomap.org https://api.mapy.cz https://api.mapy.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://payments.comgate.cz; object-src 'none'";

let srv;
const logLines = [];
test.before(async () => {
  const log = createLogger({ level: 'debug', stdout: { write: (l) => logLines.push(l) }, stderr: { write: (l) => logLines.push(l) } });
  srv = await startServer({ log });
});
test.after(async () => {
  if (srv) await srv.stop();
});

test('hlavičky: CSP přesně dle SPEC, ostatní bezpečnostní hlavičky, bez HSTS na http, bez Server', async () => {
  assert.equal(CSP, EXPECTED_CSP);
  const res = await srv.fetch('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-security-policy'), EXPECTED_CSP);
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('permissions-policy'), 'geolocation=(self), camera=(), microphone=()');
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(res.headers.get('strict-transport-security'), null);
  assert.equal(res.headers.get('server'), null);
  assert.equal(res.headers.get('x-powered-by'), null);
  // i chybová odpověď a statika mají hlavičky
  const nf = await srv.fetch('/neexistuje');
  assert.equal(nf.headers.get('content-security-policy'), EXPECTED_CSP);
  const st = await srv.fetch('/base.css');
  assert.equal(st.headers.get('content-security-policy'), EXPECTED_CSP);
});

test('HSTS jen za proxy s X-Forwarded-Proto: https', async () => {
  const proxied = await startServer({ env: { PK_TRUST_PROXY: '1' } });
  try {
    const a = await proxied.fetch('/api/health', { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(a.headers.get('strict-transport-security'), 'max-age=300');
    const b = await proxied.fetch('/api/health');
    assert.equal(b.headers.get('strict-transport-security'), null);
  } finally {
    await proxied.stop();
  }
});

test('health vrací ok, verzi, tenant a téma', async () => {
  const res = await srv.fetch('/api/health');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.version, 'test');
  assert.equal(body.tenant, 'demo');
  assert.equal(body.theme, 'outdoor');
});

test('stránky /, /kontakt, /design vracejí 200 v layoutu, bez inline JS/CSS', async () => {
  for (const p of ['/', '/kontakt', '/design']) {
    const res = await srv.fetch(p);
    assert.equal(res.status, 200, p);
    const html = await res.text();
    assert.ok(html.startsWith('<!doctype html>'), p);
    assert.match(html, /<html lang="cs" data-theme="outdoor" data-hero="fullbleed" data-nav="transparent" data-cards="photo-top">/);
    assert.match(html, /<a class="skip-link" href="#obsah">/);
    assert.match(html, /<header class="site-header">/);
    assert.match(html, /<nav class="site-nav"/);
    assert.match(html, /<main id="obsah"/);
    assert.match(html, /<footer class="site-footer">/);
    assert.match(html, /<aside class="design-switch"/);
    assert.match(html, /href="\/design\/nastavit\?design=sport&amp;zpet=/);
    assert.match(html, /<link rel="stylesheet" href="\/base.css\?v=test">/);
    assert.match(html, /<link rel="stylesheet" href="\/themes\/outdoor.css\?v=test">/);
    assert.match(html, /<link rel="canonical" href="http:\/\/127.0.0.1:\d+/);
    assert.ok(!/<script>/.test(html), `${p}: inline <script>`);
    assert.ok(!/<script[^>]*>[^<]*\S[^<]*<\/script>/.test(html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '')), `${p}: inline skript`);
    assert.ok(!/ style="/.test(html), `${p}: inline style`);
    assert.ok(!/\bon[a-z]+="/.test(html), `${p}: inline handler`);
    assert.match(html, /Podmínky.*Ochrana osobních údajů.*Reklamace.*Kontakt/s);
  }
});

test('domovská stránka: hero, USP, notice bez kol, kroky, teasery, kontakt, JSON-LD', async () => {
  const html = await (await srv.fetch('/')).text();
  assert.match(html, /<section class="hero">/);
  assert.match(html, /<h1 class="hero__title">Půjčte si kolo a objevte Třeboňsko<\/h1>/);
  assert.equal((html.match(/<article class="usp">/g) || []).length, 3);
  assert.match(html, /notice notice--info/, 'prázdná tabulka bike_types → notice');
  assert.match(html, /<ol class="steps">/);
  assert.match(html, /Vyzvedněte s dokladem/);
  assert.match(html, /href="\/mapa"/);
  assert.match(html, /href="\/okoli"/);
  assert.match(html, /<div class="contact-card">/);
  assert.match(html, /Po–Pá/);
  const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(ld, 'JSON-LD přítomen');
  const data = JSON.parse(ld[1]);
  assert.equal(data['@type'], 'LocalBusiness');
  assert.equal(data.name, 'Půjčovna kol U Tří dubů');
  assert.equal(data.address.postalCode, '379 01');
  assert.equal(data.geo.latitude, 49.0035);
  assert.equal(data.openingHoursSpecification.length, 7);
  assert.match(html, /<title>Půjčovna kol U Tří dubů – Kola, která vás vezmou dál<\/title>/);
});

test('otevírací doba z adminu (settings.openingHours, pondělí zavřeno) se propíše do patičky, JSON-LD, karty na / i na /kontakt', async () => {
  const { setSetting } = require('../src/tenants');
  const { localBusinessJsonLd, siteOpeningHours } = require('../src/render/layout');
  const tenant = srv.tenant;
  const before = await (await srv.fetch('/kontakt')).text();
  assert.match(before, /<dt>Po–Pá<\/dt><dd>9:00–18:00<\/dd>/, 'výchozí doba z tenant.json');
  setSetting(srv.db, 'openingHours', { ...tenant.openingHours, mon: null, sat: ['10:00', '16:00'] });
  try {
    for (const p of ['/', '/kontakt', '/design']) {
      const html = await (await srv.fetch(p)).text();
      let cards = html.match(/<div class="contact-card">[\s\S]*?<\/dl>/g) || [];
      // /design je vzorník komponent s ukázkovými daty – tam se kontroluje jen patička (poslední karta)
      if (p === '/design') cards = cards.slice(-1);
      assert.ok(cards.length >= 1, `${p}: kontaktní karta`);
      for (const card of cards) {
        assert.match(card, /<dt>Po<\/dt><dd>zavřeno<\/dd>/, `${p}: zavřené pondělí`);
        assert.match(card, /<dt>Út–Pá<\/dt><dd>9:00–18:00<\/dd>/, `${p}: úterý–pátek beze změny`);
        assert.match(card, /<dt>So<\/dt><dd>10:00–16:00<\/dd>/, `${p}: nová sobota`);
        assert.match(card, /<dt>Ne<\/dt><dd>8:00–19:00<\/dd>/, `${p}: neděle výchozí`);
      }
    }
    const home = await (await srv.fetch('/')).text();
    assert.equal((home.match(/<dt>Po<\/dt><dd>zavřeno<\/dd>/g) || []).length, 2, 'karta „Kde nás najdete“ i patička');
    const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(home)[1]);
    assert.equal(ld.openingHoursSpecification.length, 6, 'JSON-LD bez zavřeného pondělí');
    assert.ok(!ld.openingHoursSpecification.some((h) => h.dayOfWeek === 'Monday'));
    assert.deepEqual(ld.openingHoursSpecification.find((h) => h.dayOfWeek === 'Saturday'), { '@type': 'OpeningHoursSpecification', dayOfWeek: 'Saturday', opens: '10:00', closes: '16:00' });
  } finally {
    srv.db.prepare("DELETE FROM settings WHERE key = 'openingHours'").run();
  }
  const after = await (await srv.fetch('/')).text();
  assert.ok(!/<dd>zavřeno<\/dd>/.test(after), 'po obnovení nastavení opět výchozí doba');
  // čisté pomocníky: siteOpeningHours bez DB → tenant.json; JSON-LD přeskočí null i prázdné dny
  assert.deepEqual(siteOpeningHours({ tenant }), tenant.openingHours);
  assert.deepEqual(
    siteOpeningHours({
      tenant,
      get settings() {
        throw new Error('bez DB');
      },
    }),
    tenant.openingHours
  );
  const closed = localBusinessJsonLd(tenant, 'https://x.cz', { ...tenant.openingHours, mon: null, tue: [] });
  assert.equal(closed.openingHoursSpecification.length, 5);
  assert.equal(localBusinessJsonLd({ ...tenant, openingHours: {} }, 'https://x.cz').openingHoursSpecification, undefined);
});

test('domovská stránka zobrazí karty kol z bike_types s cenou od', async () => {
  srv.db.prepare("INSERT INTO bike_types(slug, name, category, sizes, deposit_minor, fee_minor, value_minor, sort) VALUES ('trek-fx-2', 'Trekové kolo Trek FX 2', 'trek', '[\"S\",\"M\",\"L\",\"XL\"]', 500000, 30000, 2500000, 1)").run();
  const id = srv.db.prepare("SELECT id FROM bike_types WHERE slug = 'trek-fx-2'").get().id;
  srv.db.prepare("INSERT INTO price_rules(bike_type_id, unit, from_qty, price_minor) VALUES (?, 'day', 1, 39000), (?, 'day', 2, 35000), (?, 'hour', 1, 9000)").run(id, id, id);
  try {
    const html = await (await srv.fetch('/')).text();
    assert.match(html, /<article class="card card--bike">/);
    assert.match(html, /Trekové kolo Trek FX 2/);
    assert.match(html, /<span class="price__prefix">od <\/span><strong class="price__amount">350 Kč<\/strong>/);
    assert.ok(!/Nabídka kol se připravuje/.test(html));
  } finally {
    srv.db.exec('DELETE FROM price_rules; DELETE FROM bike_types');
  }
});

test('404 stránka v layoutu s vysvětlením a odkazy Domů / Kola / Kontakt, 405 s Allow', async () => {
  const res = await srv.fetch('/neexistuje');
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.match(html, /<footer class="site-footer">/);
  assert.match(html, /<h1 class="section__title">404 · Stránka nenalezena<\/h1>/, 'chybová stránka má h1');
  assert.ok(!/<h2 class="section__title">/.test(html), 'nadpis chyby není h2');
  assert.match(html, /<p class="section__lead">Zkontrolujte adresu, nebo začněte na domovské stránce.<\/p>/);
  assert.match(html, /<a class="btn btn--primary" href="\/"><span class="btn__label">Domů<\/span><\/a>/);
  assert.match(html, /<a class="btn btn--secondary" href="\/kola"><span class="btn__label">Kola<\/span><\/a>/);
  assert.match(html, /<a class="btn btn--ghost" href="\/kontakt"><span class="btn__label">Kontakt<\/span><\/a>/);
  assert.ok(!/error-page__id/.test(html), '404 bez request id');
  assert.match(html, /<meta name="robots" content="noindex">/);
  const api = await srv.fetch('/api/neexistuje');
  assert.equal(api.status, 404);
  assert.equal((await api.json()).ok, false);
  const m = await srv.fetch('/', { method: 'DELETE' });
  assert.equal(m.status, 405);
  assert.equal(m.headers.get('allow'), 'GET, HEAD');
});

test('500 stránka nese identifikátor požadavku, chyba se zaloguje bez stack trace v HTML', async () => {
  const { errorBody } = require('../src/http/errors');
  const html = errorBody({ status: 500, requestId: 'rid-abc123' }).toString();
  assert.match(html, /<h1 class="section__title">500 · Chyba serveru<\/h1>/);
  assert.match(html, /Identifikátor požadavku: <code>rid-abc123<\/code>/);
  assert.match(html, /neočekávaná chyba/);
  // vlastní hláška u 404 → vysvětlení zůstane jako nápověda pod ní
  const custom = errorBody({ status: 404, message: 'Kolo nenalezeno.' }).toString();
  assert.match(custom, /<p class="section__lead">Kolo nenalezeno.<\/p>/);
  assert.match(custom, /<p class="error-page__hint">Zkontrolujte adresu, nebo začněte na domovské stránce.<\/p>/);
});

test('dynamické odpovědi: gzip/brotli podle Accept-Encoding, Vary, malé a binární odpovědi beze změny', async () => {
  const plain = await srv.fetch('/');
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.equal(plain.headers.get('vary'), 'Accept-Encoding');
  const gz = await srv.fetch('/', { headers: { 'accept-encoding': 'gzip, deflate' } });
  assert.equal(gz.status, 200);
  assert.equal(gz.headers.get('content-encoding'), 'gzip');
  assert.equal(gz.headers.get('vary'), 'Accept-Encoding');
  const body = await gz.text();
  assert.ok(body.startsWith('<!doctype html>'), 'helper tělo rozbalí');
  assert.ok(Number(gz.headers.get('content-length')) < body.length, 'Content-Length je komprimovaná velikost');
  const br = await srv.fetch('/', { headers: { 'accept-encoding': 'br, gzip' } });
  assert.equal(br.headers.get('content-encoding'), 'br');
  assert.match(await br.text(), /<footer class="site-footer">/);
  // HEAD: hlavičky jako GET, bez těla
  const head = await srv.fetch('/', { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(head.headers.get('content-encoding'), 'gzip');
  assert.equal((await head.arrayBuffer()).length, 0);
  // malý JSON (< 1 KB) se nekomprimuje, ale nese Vary
  const health = await srv.fetch('/api/health', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(health.headers.get('content-encoding'), null);
  assert.equal(health.headers.get('vary'), 'Accept-Encoding');
  assert.equal((await health.json()).ok, true);
  // přesměrování bez těla – bez Vary i komprese
  const redirect = await srv.fetch('/design/nastavit?design=outdoor&zpet=/', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('content-encoding'), null);
  srv.jar.clear();
  const { compressBody } = require('../src/http/context');
  const big = Buffer.from('a'.repeat(5000));
  assert.equal(compressBody(big, { acceptEncoding: 'gzip', contentType: 'image/png' }).encoding, null, 'binární typ se nekomprimuje');
  assert.equal(compressBody(Buffer.from('x'), { acceptEncoding: 'gzip', contentType: 'text/html' }).encoding, null, 'malé tělo');
  assert.equal(compressBody(big, { acceptEncoding: 'identity', contentType: 'text/html' }).encoding, null);
  assert.equal(compressBody(big, { acceptEncoding: 'gzip', contentType: 'text/html; charset=utf-8' }).encoding, 'gzip');
});

test('logo tenanta je inline SVG (obarvitelné přes CSS color) v hlavičce i patičce, favicon a /tenant/logo.svg zůstávají', async () => {
  const html = await (await srv.fetch('/')).text();
  const logos = html.match(/<svg class="site-logo__img" aria-hidden="true" focusable="false" width="160" height="40"[^>]*viewBox="0 0 320 80"[^>]*>/g) || [];
  assert.equal(logos.length, 2, 'hlavička + patička');
  assert.ok(!/<svg class="site-logo__img"[^>]*(role=|aria-label=)/.test(html), 'root svg bez role/aria-label (nese ho odkaz)');
  assert.match(html, /<a class="site-logo" href="\/" aria-label="Půjčovna kol U Tří dubů – domů"><svg class="site-logo__img"/);
  assert.match(html, /<a class="site-logo site-logo--footer" href="\/" aria-label="Půjčovna kol U Tří dubů – domů"><svg class="site-logo__img"/);
  assert.match(html, /fill="currentColor"/);
  assert.ok(!/<img class="site-logo__img"/.test(html), 'žádný <img> logo');
  assert.ok(!/<!--/.test(html.slice(html.indexOf('<svg class="site-logo__img"'), html.indexOf('</svg>'))), 'bez komentářů z SVG');
  assert.match(html, /<link rel="icon" href="\/tenant\/logo.svg" type="image\/svg\+xml">/);
  // fallback na <img>, když logo.svg chybí nebo není použitelné
  const { tenantLogoSvg, logoMarkup } = require('../src/render/layout');
  assert.equal(tenantLogoSvg({ dir: '/neexistuje/tenant' }), null);
  assert.match(logoMarkup({ dir: '/neexistuje/tenant' }, '/tenant/logo.svg').toString(), /^<img class="site-logo__img" src="\/tenant\/logo.svg" alt="" width="160" height="40">$/);
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-logo-'));
  try {
    fs.writeFileSync(path.join(dir, 'logo.svg'), '<?xml version="1.0"?><!-- k --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img" aria-label="x" width="10" height="10"><script>alert(1)</script></svg>');
    assert.equal(tenantLogoSvg({ dir }), null, 'SVG se skriptem se nevkládá');
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-logo-'));
    fs.writeFileSync(path.join(dir2, 'logo.svg'), '<?xml version="1.0"?>\n<!-- k -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img" aria-label="x" width="10" height="10" id="l"><g fill="currentColor"><rect width="5" height="5"/></g></svg>\n');
    assert.equal(tenantLogoSvg({ dir: dir2 }), '<svg class="site-logo__img" aria-hidden="true" focusable="false" width="160" height="40" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g fill="currentColor"><rect width="5" height="5"/></g></svg>');
    fs.rmSync(dir2, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hero fotka a alt text podle tématu (THEMES.<tema>.heroAlt)', async () => {
  const { THEMES } = require('../src/themes');
  for (const [name, t] of Object.entries(THEMES)) {
    assert.ok(t.heroAlt && t.heroAlt.length > 10, `${name}: heroAlt`);
    const html = await (await srv.fetch(`/?design=${name}`)).text();
    assert.match(html, new RegExp(`<img src="/img/demo/${name}/hero\\.[a-z]+" alt="${t.heroAlt}"`), `${name}: hero fotka tématu s alt textem`);
  }
  assert.ok(!/Cyklisté na hrázi/.test(await (await srv.fetch('/?design=sport')).text()));
});

test('texty z adminu (settings.texts) přepisují tenant.texts na domovské stránce, v kontaktu i v patičce; prázdné = výchozí', async () => {
  const { setSetting, getSetting } = require('../src/db');
  const { getTexts } = require('../src/tenants');
  assert.deepEqual(getTexts(srv.tenant, { texts: { heroTitle: ' ', about: 'A' } }).about, 'A');
  assert.equal(getTexts(srv.tenant, { texts: { heroTitle: ' ' } }).heroTitle, srv.tenant.texts.heroTitle, 'prázdný řetězec = výchozí');
  assert.equal(getTexts(srv.tenant, null).heroText, srv.tenant.texts.heroText);
  setSetting(srv.db, 'texts', { heroTitle: 'QA TITULEK ZMĚNĚN', heroText: 'Nový text úvodu', about: 'O nás z adminu', contactNote: 'Parkování zdarma za rohem.' });
  try {
    const home = await (await srv.fetch('/')).text();
    assert.match(home, /<h1 class="hero__title">QA TITULEK ZMĚNĚN<\/h1>/);
    assert.match(home, /<p class="hero__text">Nový text úvodu<\/p>/);
    assert.match(home, /<meta name="description" content="Nový text úvodu">/);
    assert.match(home, /<p class="site-footer__about-text">O nás z adminu<\/p>/);
    assert.ok(!/Půjčte si kolo a objevte Třeboňsko/.test(home), 'výchozí titulek zmizel');
    const kontakt = await (await srv.fetch('/kontakt')).text();
    assert.match(kontakt, /<p class="contact-note-text">Parkování zdarma za rohem.<\/p>/);
    assert.match(kontakt, /<p class="site-footer__about-text">O nás z adminu<\/p>/, 'patička i na jiných stránkách');
    assert.ok(!/<meta name="description" content="Nový text úvodu">/.test(kontakt), 'kontakt má vlastní description');
  } finally {
    srv.db.prepare("DELETE FROM settings WHERE key = 'texts'").run();
  }
  assert.equal(getSetting(srv.db, 'texts'), null);
  const back = await (await srv.fetch('/')).text();
  assert.match(back, /<h1 class="hero__title">Půjčte si kolo a objevte Třeboňsko<\/h1>/);
  assert.ok(!/contact-note-text/.test(await (await srv.fetch('/kontakt')).text()));
});

test('/fotografie: autoři a licence CC BY z public/img/demo/*/ATTRIBUTION.md, odkaz v patičce každé stránky', async () => {
  const { parseAttributionMd, loadPhotoCredits } = require('../src/features/home');
  const rows = parseAttributionMd(
    '# Attribution\n\nText.\n\n| Soubor | Původní soubor | Název / popis | Autor | Licence | Zdroj |\n|---|---|---|---|---|---|\n' +
      '| `hero.jpg` | Orig (1).JPG | Rybník | Autor X | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0) | https://commons.wikimedia.org/wiki/File:Orig_(1).JPG |\n' +
      '| `a.jpg` | B.jpg | Popis | Někdo | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) (na Commons PD) | https://commons.wikimedia.org/wiki/File:B.jpg (Flickr: https://www.flickr.com/x) |\n' +
      '| bez souboru | | | | | |\n'
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { file: 'hero.jpg', original: 'Orig (1).JPG', title: 'Rybník', author: 'Autor X', license: { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0', note: null }, source: 'https://commons.wikimedia.org/wiki/File:Orig_(1).JPG' });
  assert.equal(rows[1].license.note, 'na Commons PD');
  assert.equal(rows[1].source, 'https://commons.wikimedia.org/wiki/File:B.jpg');
  const groups = loadPhotoCredits(srv.instance.config.publicDir);
  const dirs = groups.map((g) => g.dir);
  for (const d of ['outdoor', 'sport', 'family', 'kola']) assert.ok(dirs.includes(d), `skupina ${d}`);
  assert.ok(groups.every((g) => g.items.every((it) => it.author && it.license && it.license.name && it.file)), 'každá položka má autora, licenci a soubor');
  assert.ok(groups.find((g) => g.dir === 'outdoor').items.some((it) => it.file === 'hero.jpg'), 'hero tématu je v seznamu');
  for (const name of ['outdoor', 'sport', 'family']) {
    const res = await srv.fetch(`/fotografie?design=${name}`);
    assert.equal(res.status, 200, name);
    const html = await res.text();
    assert.match(html, /<h1 class="section__title">Fotografie: autoři a licence<\/h1>/);
    assert.match(html, /<title>Fotografie: autoři a licence · Půjčovna kol U Tří dubů<\/title>/);
    assert.match(html, /<caption class="table__caption">Design Outdoor<\/caption>/);
    assert.match(html, /<caption class="table__caption">Fotografie kol \(katalog\)<\/caption>/);
    assert.match(html, /Chmee2/);
    assert.match(html, /Taiyo FUJII/);
    assert.match(html, /<a href="https:\/\/creativecommons\.org\/licenses\/by\/2\.0\/?" rel="license noopener">CC BY 2\.0<\/a>/);
    assert.match(html, /<img class="credits__thumb" src="\/img\/demo\/outdoor\/hero\.jpg" alt="" loading="lazy"/);
    assert.match(html, /<link rel="stylesheet" href="\/css\/home\.css\?v=test">/);
    assert.ok(!/ style="/.test(html) && !/<script>/.test(html), 'bez inline stylů a skriptů');
  }
  for (const p of ['/', '/kontakt', '/neexistuje']) {
    const html = await (await srv.fetch(p)).text();
    assert.match(html, /<a class="site-footer__credits" href="\/fotografie">Fotografie: autoři a licence<\/a>/, `${p}: odkaz v patičce`);
  }
});

test('demo režim: při prázdné tabulce bike_types server sám naplní demo data (PK_DEMO_AUTOSEED), v testech vypnuto', async () => {
  assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM bike_types').get().n, 0, 'výchozí test env má autoseed vypnutý');
  const seeded = await startServer({ env: { PK_DEMO_AUTOSEED: '1' } });
  try {
    assert.equal(seeded.db.prepare('SELECT COUNT(*) AS n FROM bike_types').get().n, 12);
    assert.ok(seeded.db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n >= 1);
    assert.equal(seeded.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1, 'admin z ensureAdmin se neduplikuje');
    const home = await (await seeded.fetch('/')).text();
    assert.match(home, /<article class="card card--bike">/);
    assert.ok(!/Nabídka kol se připravuje/.test(home));
    // druhý start se stejnými daty už neseeduje (tabulka není prázdná) – ověříme přes autoSeedDemo
    const { autoSeedDemo } = require('../server');
    const calls = [];
    const log = { info: (m) => calls.push(m), warn() {}, error: (m) => calls.push('E:' + m), debug() {} };
    assert.equal(await autoSeedDemo({ db: seeded.db, tenant: seeded.tenant, config: seeded.instance.config, fieldCrypto: seeded.app.fieldCrypto, log }), false);
    assert.deepEqual(calls, []);
    assert.equal(await autoSeedDemo({ db: seeded.db, tenant: seeded.tenant, config: { ...seeded.instance.config, demo: false }, fieldCrypto: seeded.app.fieldCrypto, log }), false);
  } finally {
    await seeded.stop();
  }
});

test('statické soubory: MIME, cache, komprese, ETag/304, zákaz .. a skrytých souborů', async () => {
  const css = await srv.fetch('/base.css', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.equal(css.headers.get('cache-control'), 'public, max-age=3600');
  assert.equal(css.headers.get('content-encoding'), 'gzip');
  const text = await css.text();
  assert.match(text, /--primary:/);
  const etag = css.headers.get('etag');
  assert.ok(etag);
  const again = await srv.fetch('/base.css', { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
  const br = await srv.fetch('/base.css', { headers: { 'accept-encoding': 'br, gzip' } });
  assert.equal(br.headers.get('content-encoding'), 'br');
  const font = await srv.fetch('/fonts/fonts.css');
  assert.equal(font.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const vendor = await srv.fetch('/vendor/leaflet/leaflet.css');
  assert.equal(vendor.status, 200);
  assert.equal(vendor.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const svg = await srv.fetch('/img/icons.svg');
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  const logo = await srv.fetch('/tenant/logo.svg');
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/svg+xml');
  assert.match(await logo.text(), /U Tří dubů/);
  // zakázané cesty
  for (const p of ['/img/../../package.json', '/img/..%2F..%2Fpackage.json', '/fonts/.hidden', '/.secret', '/css/%2e%2e/%2e%2e/server.js']) {
    const r = await srv.fetch(p);
    assert.equal(r.status, 404, p);
  }
  // neexistující soubor v povoleném prefixu → 404 prostý text
  const missing = await srv.fetch('/css/neni.css');
  assert.equal(missing.status, 404);
  // server.js není ve veřejném prefixu
  assert.equal((await srv.fetch('/server.js')).status, 404);
  assert.equal((await srv.fetch('/package.json')).status, 404);
});

test('CSRF: POST bez tokenu → 403; bez Origin → 403; cizí Origin → 403; s tokenem projde', async () => {
  srv.jar.clear();
  const noToken = await srv.fetch('/kontakt', { method: 'POST', body: { jmeno: 'x' } });
  assert.equal(noToken.status, 403);
  assert.match(await noToken.text(), /token|jiné stránky/);
  const token = await srv.csrf('/kontakt');
  assert.ok(srv.jar.get('__Host-pk_sid'), 'session cookie po načtení formuláře');
  const noOrigin = await srv.fetch('/kontakt', { method: 'POST', body: { _csrf: token, jmeno: 'x' }, noOrigin: true });
  assert.equal(noOrigin.status, 403);
  const badOrigin = await srv.fetch('/kontakt', { method: 'POST', body: { _csrf: token, jmeno: 'x' }, headers: { origin: 'https://utocnik.example' } });
  assert.equal(badOrigin.status, 403);
  const wrongToken = await srv.fetch('/kontakt', { method: 'POST', body: { _csrf: 'spatny', jmeno: 'x' } });
  assert.equal(wrongToken.status, 403);
  const sfs = await srv.fetch('/kontakt', { method: 'POST', body: { _csrf: token, jmeno: 'x' }, noOrigin: true, headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(sfs.status, 422, 'Sec-Fetch-Site same-origin stačí; pak selže validace formuláře');
  const ok = await srv.fetch('/kontakt', { method: 'POST', body: { _csrf: token, jmeno: 'x' } });
  assert.equal(ok.status, 422, 'token OK → validace formuláře (422)');
  const html = await ok.text();
  assert.match(html, /field__error/);
});

test('kontaktní formulář: validace, úspěšné odeslání do outboxu s šifrovanými údaji, honeypot', async () => {
  srv.jar.clear();
  const token = await srv.csrf('/kontakt');
  const values = { _csrf: token, jmeno: 'Jana Nováková', email: 'jana.novakova@example.com', telefon: '+420 777 000 000', zprava: 'Dobrý den, máte volná dvě trekovka na víkend 12.–14. 7.?', souhlas: '1' };
  const res = await srv.fetch('/kontakt', { method: 'POST', body: values });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/kontakt?odeslano=1');
  const page = await (await srv.fetch('/kontakt?odeslano=1')).text();
  assert.match(page, /notice notice--success/);
  const row = srv.db.prepare("SELECT * FROM outbox WHERE type = 'contact_inquiry' ORDER BY id DESC").get();
  assert.ok(row);
  assert.equal(row.subject, 'Dotaz z webu: Jana Nováková');
  assert.match(row.body_text, /trekovka na víkend/);
  assert.equal(row.to_hmac, srv.app.fieldCrypto.hmacEmail('info@ksprehledy.cz'));
  const payload = JSON.parse(row.payload);
  assert.match(payload.reply_to_enc, /^k1:/);
  assert.equal(srv.app.fieldCrypto.dec(payload.reply_to_enc), 'jana.novakova@example.com');
  assert.equal(srv.app.fieldCrypto.dec(payload.name_enc), 'Jana Nováková');
  assert.ok(!row.payload.includes('Nováková'), 'jméno v payloadu šifrované');
  // chybějící souhlas a špatný e-mail
  const bad = await srv.fetch('/kontakt', { method: 'POST', body: { ...values, email: 'neni-email', souhlas: '' } });
  assert.equal(bad.status, 422);
  const badHtml = await bad.text();
  assert.match(badHtml, /platný e-mail/);
  assert.match(badHtml, /Bez potvrzení/);
  assert.match(badHtml, /value="Jana Nováková"/, 'hodnoty zůstanou předvyplněné');
  // honeypot
  const before = srv.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n;
  const hp = await srv.fetch('/kontakt', { method: 'POST', body: { ...values, web: 'http://spam.example' } });
  assert.equal(hp.status, 303);
  assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, before);
  // log neobsahuje PII
  const joined = logLines.join('\n');
  assert.ok(!joined.includes('jana.novakova@example.com'), 'e-mail v logu');
  assert.ok(!joined.includes('Nováková'), 'jméno v logu');
  assert.ok(!joined.includes(token), 'CSRF token v logu');
});

test('tělo větší než 256 KB → 413, špatný JSON → 400', async () => {
  srv.jar.clear();
  const token = await srv.csrf('/kontakt');
  const big = await srv.fetch('/kontakt', { method: 'POST', body: `_csrf=${token}&zprava=${'a'.repeat(300 * 1024)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(big.status, 413);
  const badJson = await srv.fetch('/kontakt', { method: 'POST', body: '{nevalidni', headers: { 'content-type': 'application/json' } });
  assert.equal(badJson.status, 400);
});

test('přepínač designu: cookie __Host-pk_design, ověření hodnoty, jen relativní zpet', async () => {
  srv.jar.clear();
  const res = await srv.fetch('/design/nastavit?design=sport&zpet=/kontakt');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/kontakt');
  const sc = (res.headers.getSetCookie() || []).find((c) => c.startsWith('__Host-pk_design='));
  assert.ok(sc);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  assert.match(sc, /Max-Age=2592000/);
  const page = await (await srv.fetch('/kontakt')).text();
  assert.match(page, /<html lang="cs" data-theme="sport" data-hero="video-or-duotone" data-nav="bar" data-cards="overlay">/);
  assert.match(page, /\/themes\/sport.css/);
  const health = await (await srv.fetch('/api/health')).json();
  assert.equal(health.theme, 'sport');
  // ?design= přebije cookie
  const q = await (await srv.fetch('/kontakt?design=family')).text();
  assert.match(q, /data-theme="family"/);
  // neplatná hodnota → redirect bez cookie
  srv.jar.clear();
  const bad = await srv.fetch('/design/nastavit?design=neon&zpet=//evil.example');
  assert.equal(bad.status, 302);
  assert.equal(bad.headers.get('location'), '/');
  assert.equal(srv.jar.get('__Host-pk_design'), undefined);
  const open = await srv.fetch('/design/nastavit?design=family&zpet=https://evil.example/x');
  assert.equal(open.headers.get('location'), '/');
  srv.jar.clear();
});

test('téma a tenant podle hostu', async () => {
  const sport = await srv.fetch('/api/health', { headers: { host: 'sport.ksprehledy.cz' } });
  assert.equal((await sport.json()).theme, 'sport');
  const family = await srv.fetch('/api/health', { headers: { host: 'family.ksprehledy.cz:443' } });
  assert.equal((await family.json()).theme, 'family');
  const www = await srv.fetch('/api/health', { headers: { host: 'www.ksprehledy.cz' } });
  assert.equal((await www.json()).theme, 'outdoor');
  // neznámý host v demu → tenant demo
  const unknown = await srv.fetch('/api/health', { headers: { host: 'cizi.example' } });
  assert.equal((await unknown.json()).tenant, 'demo');
  // canonical podle hostu
  const page = await (await srv.fetch('/kontakt', { headers: { host: 'sport.ksprehledy.cz' } })).text();
  assert.match(page, /<link rel="canonical" href="https:\/\/sport.ksprehledy.cz\/kontakt">/);
});

test('neznámý host mimo demo režim → 404 Půjčovna nenalezena; /design mimo demo neexistuje', async () => {
  const prod = await startServer({ env: { PK_DEMO: '0', PK_ADMIN_PASSWORD: 'tajne-heslo-123' } });
  try {
    const r = await prod.fetch('/api/health', { headers: { host: 'cizi.example' } });
    assert.equal(r.status, 404);
    assert.match(await r.text(), /Půjčovna nenalezena/);
    const ok = await prod.fetch('/api/health', { headers: { host: 'ksprehledy.cz' } });
    assert.equal(ok.status, 200);
    assert.equal((await prod.fetch('/design')).status, 404);
    const home = await (await prod.fetch('/')).text();
    assert.ok(!/design-switch/.test(home), 'přepínač jen v demu');
    assert.ok(!/\?design=/.test(home));
  } finally {
    await prod.stop();
  }
});

test('při prvním startu vznikne admin demo@ksprehledy.cz se scrypt heslem a settings se zkopírují', async () => {
  const user = srv.db.prepare('SELECT * FROM users').get();
  assert.equal(user.email, 'demo@ksprehledy.cz');
  assert.equal(user.role, 'owner');
  assert.match(user.password_hash, /^scrypt\$131072\$8\$1\$/);
  const { verifyPassword } = require('../src/crypto/passwords');
  assert.equal(await verifyPassword('kolo-demo-2026', user.password_hash), true);
  const settings = srv.db.prepare('SELECT key, value FROM settings ORDER BY key').all();
  assert.ok(settings.length >= 15);
  assert.deepEqual(JSON.parse(settings.find((s) => s.key === 'cancellation').value), { freeHoursBefore: 48 });
  const fs = require('node:fs');
  const path = require('node:path');
  assert.ok(fs.existsSync(path.join(srv.dataDir, 'tenants', 'demo.db')));
});

test('rate limit: po vyčerpání profilu 429 s Retry-After', async () => {
  srv.app.rateLimiter.reset('127.0.0.1', 'api');
  let last;
  for (let i = 0; i < 121; i++) last = await srv.fetch('/api/health');
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) >= 1);
  srv.app.rateLimiter.reset('127.0.0.1', 'api');
});
