'use strict';
// Integrační testy feature „kola“ přes běžící server s demo daty: /kola (filtry bez JS, dostupnost pro termín),
// /kola/:slug (galerie, velikosti, ceník typu, JSON-LD Product/Offer, title/description), /cenik, /api/v1/cena.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const demo = require('../tools/demo-data');
const availability = require('../src/domain/availability');
const format = require('../src/render/format');

const nb = (s) => s.replace(/\u00a0/g, ' ');
let srv;
const silent = { info() {}, warn() {}, error() {}, debug() {} };
test.before(async () => {
  srv = await startServer();
  await demo.seed({ db: srv.db, tenant: srv.tenant, config: srv.instance.config, fieldCrypto: srv.app.fieldCrypto, log: silent });
});
test.after(async () => {
  if (srv) await srv.stop();
});

function futureDate(days) {
  return availability.addDays(availability.utcToLocal(new Date()).date, days);
}

test('/kola: karty všech 6 typů s cenou od, filtry fungují přes GET bez JS', async () => {
  const res = await srv.fetch('/kola');
  assert.equal(res.status, 200);
  const html = await res.text().then(nb);
  assert.equal((html.match(/<article class="card card--bike">/g) || []).length, 6);
  assert.match(html, /<form class="form filters" method="get" action="\/kola"/);
  assert.match(html, /<select class="field__input field__input--select" id="f-kategorie" name="kategorie"/);
  assert.match(html, /od <\/span><strong class="price__amount">290 Kč/, 'trek od 290 Kč (pásmo 7+)');
  assert.match(html, /href="\/css\/kola.css\?v=test"/);
  assert.match(html, /<script src="\/js\/kola.js\?v=test" defer>/);
  assert.match(html, /<title>Kola k zapůjčení · Půjčovna kol U Tří dubů<\/title>/);
  const ebike = await (await srv.fetch('/kola?kategorie=ebike')).text().then(nb);
  assert.equal((ebike.match(/<article class="card card--bike">/g) || []).length, 2);
  assert.match(ebike, /<option value="ebike" selected>/);
  const xl = await (await srv.fetch('/kola?velikost=XL')).text().then(nb);
  assert.equal((xl.match(/<article class="card card--bike">/g) || []).length, 3, 'XL: trek, mtb, e-mtb');
  const none = await (await srv.fetch('/kola?kategorie=kids&velikost=XL')).text().then(nb);
  assert.match(none, /neodpovídá žádné kolo/);
  const bad = await (await srv.fetch('/kola?kategorie=<script>')).text().then(nb);
  assert.ok(!/<script>/.test(bad.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '')));
});

test('/kola s termínem: dostupnost a cena za den pro délku; odkaz na detail nese termín', async () => {
  const od = futureDate(20);
  const doD = futureDate(22);
  const html = await (await srv.fetch(`/kola?od=${od}&do=${doD}`)).text().then(nb);
  assert.match(html, /Dostupnost a ceny pro termín/);
  assert.match(html, /3 dny/);
  assert.match(html, /badge badge--success">\d+ kol/);
  assert.match(html, /od <\/span><strong class="price__amount">350 Kč/, 'trek pásmo 2–3 dny = 350');
  assert.match(html, new RegExp(`href="/kola/trek-fx-2\\?od=${od}&amp;do=${doD}"`));
  const invalid = await (await srv.fetch(`/kola?od=${doD}&do=${od}`)).text().then(nb);
  assert.match(invalid, /notice notice--warning/);
  const tooLong = await (await srv.fetch(`/kola?od=${od}&do=${futureDate(80)}`)).text().then(nb);
  assert.match(tooLong, /nejvýše 30 dní/);
});

test('/kola/:slug: galerie s attribution, velikosti, ceník typu, poplatek, kauce, JSON-LD Product/Offer, title/description', async () => {
  const res = await srv.fetch('/kola/trek-fx-2');
  assert.equal(res.status, 200);
  const html = await res.text().then(nb);
  assert.match(html, /<title>Trekové kolo Trek FX 2 · Půjčovna kol U Tří dubů<\/title>/);
  assert.match(html, /<meta name="description" content="Trekové kolo Trek FX 2 – půjčovna kol Třeboň\./);
  assert.match(html, /<link rel="canonical" href="http:\/\/127.0.0.1:\d+\/kola\/trek-fx-2">/);
  assert.match(html, /<img class="gallery__main" src="\/img\/demo\/kola\/trek-fx-2-1.jpg"/);
  assert.match(html, /gallery__thumb/);
  assert.match(html, /Foto: <a href="https:\/\/commons.wikimedia.org\/wiki\/File:Giant_Escape_M2.jpg"[^>]*>Taiyo FUJII<\/a>, <a href="https:\/\/creativecommons.org\/licenses\/by\/2.0"[^>]*>CC BY 2.0<\/a>/);
  assert.match(html, /<li class="sizes__item"><span class="sizes__size">M<\/span> <span class="sizes__total">2 kusy<\/span>/);
  assert.match(html, /<th scope="row">Mimo sezónu<\/th>/);
  assert.match(html, /Hlavní sezóna/);
  assert.match(html, /<td class="is-right">390 Kč<\/td><td class="is-right">350 Kč<\/td><td class="is-right">320 Kč<\/td><td class="is-right">290 Kč<\/td><td class="is-right">90 Kč<\/td><td class="is-right">250 Kč<\/td>/);
  assert.match(html, /Rezervační poplatek<\/dt><dd>300 Kč/);
  assert.match(html, /Vratná kauce při převzetí<\/dt><dd>5 000 Kč/);
  assert.match(html, /Specifikace/);
  assert.match(html, /<th scope="row">Rám<\/th><td>hliník Alpha Gold<\/td>/);
  assert.match(html, /href="\/rezervace\?typ=trek-fx-2"/);
  const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  const data = JSON.parse(ld[1]);
  assert.equal(data['@type'], 'Product');
  assert.equal(data.name, 'Trekové kolo Trek FX 2');
  assert.equal(data.offers['@type'], 'Offer');
  assert.equal(data.offers.priceCurrency, 'CZK');
  assert.equal(data.offers.price, '290.00');
  assert.equal(data.offers.priceSpecification.unitText, 'den');
  assert.equal(data.offers.availability, 'https://schema.org/InStock');
  assert.equal(data.image.length, 2);
  assert.match(data.image[0], /^http:\/\/127.0.0.1:\d+\/img\/demo\/kola\/trek-fx-2-1.jpg$/);
  // s termínem: cena pro termín a dostupnost per velikost
  const od = futureDate(20);
  const doD = futureDate(21);
  const withTerm = await (await srv.fetch(`/kola/trek-fx-2?od=${od}&do=${doD}`)).text().then(nb);
  assert.match(withTerm, /Cena pro/);
  assert.match(withTerm, /<strong class="price__amount">700 Kč<\/strong>/, '2 dny × 350');
  assert.match(withTerm, /badge badge--success">2 kola volná/);
  assert.match(withTerm, new RegExp(`href="/rezervace\\?typ=trek-fx-2&amp;od=${od}&amp;do=${doD}&amp;od_cas=`));
  assert.equal((await srv.fetch('/kola/neexistuje')).status, 404);
});

test('/cenik: všechny typy, sezóna, příslušenství, poplatek, kauce, storno pravidla', async () => {
  const html = await (await srv.fetch('/cenik')).text().then(nb);
  assert.match(html, /<title>Ceník · /);
  assert.match(html, /<h2 class="section__title">Mimo sezónu<\/h2>/);
  assert.match(html, /<h2 class="section__title">Hlavní sezóna<\/h2>/);
  assert.match(html, /15\. 6\. – 15\. 9\. \d{4}/);
  assert.equal((html.match(/<a href="\/kola\/[a-z0-9-]+">/g) || []).length, 12, '6 typů × 2 tabulky');
  assert.match(html, /1 020 Kč/, 'sezónní e-kolo 890 × 1,15 → 1 020');
  assert.match(html, /Cyklistická přilba<\/th><td class="is-right">50 Kč<\/td>/);
  assert.match(html, /Zámek<\/th><td class="is-right">zdarma<\/td>/);
  assert.match(html, /id="storno"/);
  assert.match(html, /nejméně 48 hodin/);
  assert.match(html, /poplatek propadá/);
  assert.match(html, /60 minut/);
});

test('/api/v1/cena: JSON cena, chyby 400/404', async () => {
  const od = futureDate(20);
  const doD = futureDate(22);
  const res = await srv.fetch(`/api/v1/cena?typ=trek-fx-2&od=${od}&do=${doD}&pocet=2&prislusenstvi=prilba:2`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.days, 3);
  assert.equal(body.unit, 'day');
  assert.equal(body.bikesMinor, 2 * 3 * 35000);
  assert.equal(body.accessoriesMinor, 2 * 3 * 5000);
  assert.equal(body.totalMinor, body.bikesMinor + body.accessoriesMinor);
  assert.equal(body.feeMinor, 60000);
  assert.equal(body.formatted.total, format.money(body.totalMinor));
  const iso = await (await srv.fetch(`/api/v1/cena?typ=${body.typeId}&od=${encodeURIComponent(od + 'T07:00:00.000Z')}&do=${encodeURIComponent(od + 'T09:00:00.000Z')}`)).json();
  assert.equal(iso.unit, 'hour');
  assert.equal(iso.totalMinor, 2 * 9000);
  assert.equal((await srv.fetch(`/api/v1/cena?typ=neni&od=${od}&do=${doD}`)).status, 404);
  const bad = await srv.fetch(`/api/v1/cena?typ=trek-fx-2&od=${doD}&do=${od}`);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).ok, false);
  assert.equal((await srv.fetch('/api/v1/cena?typ=trek-fx-2&od=xx&do=yy')).status, 400);
});
