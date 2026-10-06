'use strict';
// Testy src/render/components.js – třídy podle SPEC kap. 6 a escapování vstupů.
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/render/components');

test('hero, section, grid, button mají předepsané třídy', () => {
  const h = c.hero({ title: 'T<', text: 'x', cta: 'Rezervovat', ctaHref: '/rezervace', image: '/img/a.jpg', imageAlt: 'alt' }).toString();
  assert.match(h, /<section class="hero">/);
  assert.match(h, /<div class="hero__media"><img src="\/img\/a.jpg" alt="alt"/);
  assert.match(h, /<h1 class="hero__title">T&lt;<\/h1>/);
  assert.match(h, /<p class="hero__text">x<\/p>/);
  assert.match(h, /class="btn btn--primary btn--lg" href="\/rezervace"/);
  const s = c.section({ title: 'N', lead: 'L', variant: 'usp', children: c.grid(['a', 'b'], 3) }).toString();
  assert.match(s, /<section class="section section--usp">/);
  assert.match(s, /<div class="container">/);
  assert.match(s, /<h2 class="section__title">N<\/h2>/);
  assert.match(s, /<p class="section__lead">L<\/p>/);
  assert.match(s, /<div class="grid grid--3">ab<\/div>/);
  assert.match(c.button({ label: 'X', variant: 'secondary', size: 'sm' }).toString(), /<button class="btn btn--secondary btn--sm" type="button">/);
  assert.match(c.button({ label: 'X', variant: 'danger', type: 'submit' }).toString(), /type="submit"/);
  assert.match(c.button({ label: 'X', href: '/a', variant: 'ghost', size: 'lg' }).toString(), /<a class="btn btn--ghost btn--lg" href="\/a">/);
});

test('bikeCard: struktura a cena „od“', () => {
  const out = c.bikeCard({ slug: 'trek', name: 'Trek <FX>', category: 'mtb', sizes: ['S', 'M', 'L', 'XL'], photos: [] }, { price: 39000, available: 2 }).toString();
  assert.match(out, /<article class="card card--bike">/);
  assert.match(out, /<a class="card__media" href="\/kola\/trek"/);
  assert.match(out, /<div class="card__body">/);
  assert.match(out, /<span class="badge">Horské<\/span>/);
  assert.match(out, /<h3 class="card__title"><a href="\/kola\/trek">Trek &lt;FX&gt;<\/a><\/h3>/);
  assert.match(out, /<p class="card__meta">velikosti S–XL<\/p>/);
  assert.match(out, /<p class="price"><span class="price__prefix">od <\/span><strong class="price__amount">390 Kč<\/strong> <span class="price__unit">\/ den<\/span><\/p>/);
  assert.match(out, /class="btn btn--secondary" href="\/kola\/trek"/);
  assert.match(out, /badge badge--success/);
  assert.match(c.bikeCard({ slug: 'a', name: 'A', category: 'kids', sizes: [] }, { available: 0 }).toString(), /badge--danger">Obsazeno/);
});

test('field a form: label, input, hint, error, hidden _csrf', () => {
  const f = c.field({ label: 'E-mail', name: 'email', type: 'email', value: 'a"@b.cz', required: true, hint: 'H', error: 'E' }).toString();
  assert.match(f, /<div class="field field--email has-error">/);
  assert.match(f, /<label class="field__label" for="f-email">E-mail/);
  assert.match(f, /<input class="field__input" id="f-email" name="email" required aria-describedby="f-email-hint f-email-error" aria-invalid="true" type="email" value="a&quot;@b.cz">/);
  assert.match(f, /<p class="field__hint" id="f-email-hint">H<\/p>/);
  assert.match(f, /<p class="field__error" id="f-email-error">E<\/p>/);
  const sel = c.field({ label: 'V', name: 'v', type: 'select', value: 'M', options: ['S', 'M'] }).toString();
  assert.match(sel, /<option value="M" selected>M<\/option>/);
  const cb = c.field({ label: 'S', name: 's', type: 'checkbox', checked: true }).toString();
  assert.match(cb, /class="field field--checkbox"/);
  assert.match(cb, /type="checkbox"[^>]*checked/);
  const ta = c.field({ label: 'Z', name: 'z', type: 'textarea', value: '<x>' }).toString();
  assert.match(ta, /<textarea class="field__input field__input--textarea"[^>]*>&lt;x&gt;<\/textarea>/);
  const form = c.form({ action: '/kontakt', csrf: 'tok<en', children: ['x'], submit: 'Odeslat' }).toString();
  assert.match(form, /<form class="form" method="post" action="\/kontakt">/);
  assert.match(form, /<input type="hidden" name="_csrf" value="tok&lt;en">/);
  assert.match(form, /<div class="form__actions"><button class="btn btn--primary" type="submit">/);
});

test('steps, table, badge, notice, price, summary, tabs', () => {
  const s = c.steps(['A', 'B', 'C'], 1).toString();
  assert.match(s, /<ol class="steps"><li class="steps__item is-done">/);
  assert.match(s, /<li class="steps__item is-active" aria-current="step">/);
  assert.match(s, /<li class="steps__item">/);
  const t = c.table({ head: ['A', 'B'], rows: [['1', { value: '2', align: 'right' }]], caption: 'C' }).toString();
  assert.match(t, /<table class="table">/);
  assert.match(t, /<caption class="table__caption">C<\/caption>/);
  assert.match(t, /<th scope="col">A<\/th>/);
  assert.match(t, /<td class="is-right">2<\/td>/);
  assert.equal(c.badge('X', 'warning').toString(), '<span class="badge badge--warning">X</span>');
  assert.equal(c.badge('X', 'nesmysl').toString(), '<span class="badge">X</span>');
  assert.match(c.notice('N', 'success').toString(), /<div class="notice notice--success" role="status">N<\/div>/);
  assert.match(c.notice('N', 'danger').toString(), /role="alert"/);
  assert.match(c.price(89000, 'den').toString(), /<p class="price"><strong class="price__amount">890 Kč<\/strong> <span class="price__unit">\/ den<\/span><\/p>/);
  const sum = c.summary([['A', 'B'], { label: 'C', value: 'D', strong: true }]).toString();
  assert.match(sum, /<dl class="summary"><div class="summary__row"><dt>A<\/dt><dd>B<\/dd><\/div><div class="summary__row summary__row--total"><dt>C<\/dt><dd>D<\/dd><\/div><\/dl>/);
  const tabs = c.tabs([{ label: 'A', href: '/a', active: true }, { label: 'B', href: '/b' }]).toString();
  assert.match(tabs, /<nav class="tabs"/);
  assert.match(tabs, /<a class="tabs__tab is-active" href="\/a" aria-current="page">A<\/a>/);
  assert.match(tabs, /<a class="tabs__tab" href="\/b">B<\/a>/);
});

test('calendarRange: data atributy + fallback dvou date inputů', () => {
  const out = c.calendarRange({ name: 'termin', min: '2026-07-01', max: '2026-09-30', blocked: ['2026-07-05'] }).toString();
  assert.match(out, /<div class="calendar" data-calendar data-name="termin" data-min="2026-07-01" data-max="2026-09-30" data-blocked="\[&quot;2026-07-05&quot;\]">/);
  assert.equal((out.match(/type="date"/g) || []).length, 2);
  assert.match(out, /name="od"/);
  assert.match(out, /name="do"/);
});

test('timeline, contactCard, poiCard, routeCard', () => {
  const tl = c.timeline({ days: ['2026-07-01', '2026-07-02', '2026-07-03'], rows: [{ label: 'Trek', bars: [{ fromIndex: 0, toIndex: 1, status: 'confirmed', label: 'R1' }] }] }).toString();
  assert.match(tl, /<div class="timeline" data-days="3"/);
  assert.match(tl, /<div class="timeline__row" role="row">/);
  assert.match(tl, /class="timeline__bar status-confirmed" data-from="1" data-span="2"/);
  const cc = c.contactCard({ legalName: 'U Tří dubů s.r.o.', address: 'Masarykovo nám. 1, 379 01 Třeboň', phone: '+420 000 000 000', email: 'info@ksprehledy.cz' }, { mon: ['09:00', '18:00'] }).toString();
  assert.match(cc, /<div class="contact-card">/);
  assert.match(cc, /href="tel:\+420000000000"/);
  assert.match(cc, /href="mailto:info@ksprehledy.cz"/);
  assert.match(cc, /<dt>Po<\/dt><dd>9:00–18:00<\/dd>/);
  const poi = c.poiCard({ name: 'Svět', type: 'rybník', distanceKm: 1.2, summary: 'S', wikipediaUrl: 'https://cs.wikipedia.org/wiki/X', image: { file: 'q.jpg', author: 'Autor', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', sourceUrl: 'https://commons.wikimedia.org/wiki/File:q.jpg' } }).toString();
  assert.match(poi, /<article class="card card--poi">/);
  assert.match(poi, /src="\/okoli\/img\/q.jpg"/);
  assert.match(poi, /1,2 km od půjčovny/);
  assert.match(poi, /Foto: <a href="https:\/\/commons.wikimedia.org\/wiki\/File:q.jpg"[^>]*>Autor<\/a>, <a href="https:\/\/creativecommons.org\/licenses\/by-sa\/4.0\/"[^>]*>CC BY-SA 4.0<\/a>/);
  const rt = c.routeCard({ nazev: 'Okruh', ref: '1034', sit: 'rcn', delkaKm: 12.4, gpxHref: '/mapa/gpx/1.gpx' }).toString();
  assert.match(rt, /<article class="card card--route" data-network="rcn">/);
  assert.match(rt, /12,4 km/);
  assert.match(rt, /href="\/mapa\/gpx\/1.gpx" download/);
});
