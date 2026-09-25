'use strict';
// Testy hash routeru (public/lib/router.js).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'lib', 'router.js')).href);

test('parseHash', async () => {
  const r = await load();
  assert.deepStrictEqual(r.parseHash('#/produkty/12?q=trek&page=2'), { path: '/produkty/12', parts: ['produkty', '12'], query: { q: 'trek', page: '2' } });
  assert.deepStrictEqual(r.parseHash(''), { path: '/', parts: [], query: {} });
  assert.strictEqual(r.parseHash('#produkty').path, '/produkty');
  assert.strictEqual(r.parseHash('#/segmenty/novy?filter=%7B%22all%22%3A%5B%5D%7D').query.filter, '{"all":[]}');
  assert.strictEqual(r.parseHash('#/a?x=1&x=2').query.x, '2', 'opakovaný klíč → poslední');
});

test('queryString a buildHash', async () => {
  const r = await load();
  assert.strictEqual(r.queryString({ a: 1, b: '', c: null, d: undefined, e: false, f: true }), '?a=1&f=1');
  assert.strictEqual(r.queryString({ ids: [1, 2] }), '?ids=1%2C2');
  assert.strictEqual(r.queryString({ filter: { all: [] } }), '?filter=%7B%22all%22%3A%5B%5D%7D');
  assert.strictEqual(r.queryString({}), '');
  assert.strictEqual(r.buildHash('/produkty', { q: 'kolo á' }), '#/produkty?q=kolo+%C3%A1');
  assert.strictEqual(r.buildHash('produkty/5'), '#/produkty/5');
  const back = r.parseHash(r.buildHash('/navrhy', { q: 'Trek Marlin', status: 'all' }));
  assert.deepStrictEqual(back.query, { q: 'Trek Marlin', status: 'all' });
});

test('matchRoute', async () => {
  const r = await load();
  const routes = [{ pattern: '/produkty' }, { pattern: '/produkty/:id' }, { pattern: '/strategie/:id' }];
  assert.strictEqual(r.matchRoute(routes, '/produkty').route.pattern, '/produkty');
  const m = r.matchRoute(routes, '/produkty/42');
  assert.strictEqual(m.route.pattern, '/produkty/:id');
  assert.deepStrictEqual(m.params, { id: '42' });
  assert.strictEqual(r.matchRoute(routes, '/nic'), null);
  assert.strictEqual(r.matchRoute(routes, '/produkty/1/2'), null);
});
