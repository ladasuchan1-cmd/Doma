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
  "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: https://*.tile.openstreetmap.fr https://tile.openstreetmap.org https://*.tile.opentopomap.org https://api.mapy.cz; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://payments.comgate.cz; object-src 'none'";

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

test('404 stránka v layoutu, 405 s Allow', async () => {
  const res = await srv.fetch('/neexistuje');
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.match(html, /<footer class="site-footer">/);
  assert.match(html, /404 · Stránka nenalezena/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  const api = await srv.fetch('/api/neexistuje');
  assert.equal(api.status, 404);
  assert.equal((await api.json()).ok, false);
  const m = await srv.fetch('/', { method: 'DELETE' });
  assert.equal(m.status, 405);
  assert.equal(m.headers.get('allow'), 'GET, HEAD');
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
