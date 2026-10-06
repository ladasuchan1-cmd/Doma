'use strict';
// Testy src/http/router.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRouter } = require('../src/http/router');

test('router: statické i parametrické cesty, 404, 405', () => {
  const r = createRouter();
  const h1 = async () => {};
  const h2 = async () => {};
  const h3 = async () => {};
  r.add('GET', '/kola', h1, { rateLimit: 'public' });
  r.add('GET', '/kola/:slug', h2);
  r.add('POST', '/kola/:slug', h3, { csrf: true });
  r.add('GET', '/kola/cenik', h1);

  const a = r.match('GET', '/kola');
  assert.equal(a.handler, h1);
  assert.deepEqual(a.params, {});
  assert.equal(a.opts.rateLimit, 'public');

  const b = r.match('GET', '/kola/trek-fx-2');
  assert.equal(b.handler, h2);
  assert.deepEqual(b.params, { slug: 'trek-fx-2' });

  const c = r.match('GET', '/kola/cenik');
  assert.equal(c.handler, h1, 'statický segment má přednost před parametrem');

  const d = r.match('POST', '/kola/trek-fx-2');
  assert.equal(d.handler, h3);
  assert.equal(d.opts.csrf, true);

  const e = r.match('DELETE', '/kola/trek-fx-2');
  assert.equal(e.status, 405);
  assert.deepEqual(e.allow, ['GET', 'HEAD', 'POST']);

  assert.equal(r.match('GET', '/neexistuje').status, 404);
  assert.equal(r.match('GET', '/kola/a/b').status, 404);
  assert.equal(r.match('HEAD', '/kola').handler, h1, 'HEAD = GET');
  assert.equal(r.match('GET', '/kola/').handler, h1, 'koncové lomítko se toleruje');
  assert.equal(r.match('GET', '/kola/%C5%99%C3%ADdlo').params.slug, 'řídlo', 'parametry se dekódují');
});

test('router: validace registrace', () => {
  const r = createRouter();
  assert.throws(() => r.add('FOO', '/x', () => {}), /metoda/);
  assert.throws(() => r.add('GET', 'x', () => {}), /začínat/);
  assert.throws(() => r.add('GET', '/x', 'ne-funkce'), /funkce/);
  r.add('GET', '/x', () => {});
  assert.throws(() => r.add('GET', '/x', () => {}), /už zaregistrovaná/);
  assert.equal(r.list().length, 1);
});
