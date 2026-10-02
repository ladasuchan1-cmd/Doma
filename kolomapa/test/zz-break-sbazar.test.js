'use strict';
// Dočasný test pro review – ověření, zda jde modul rozbít.
const test = require('node:test');
const assert = require('node:assert/strict');
const sbazar = require('../src/sources/sbazar');

function mk(handler) {
  const calls = [];
  return {
    calls,
    http: {
      async request(url, o = {}) {
        calls.push(url);
        const r = handler(new URL(url), o);
        const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        if (!(r.status >= 200 && r.status < 300) && !(o.okStatuses || []).includes(r.status)) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
        return { status: r.status, headers: new Headers({ 'content-type': 'application/json' }), text: () => text };
      },
    },
  };
}
function item(id, cat, price = 9000, ts = '2026-10-01T10:00:00') {
  return { id, name: 'Kolo ' + id, seo_name: id + '-kolo', price, price_by_agreement: false, create_date: ts, category: { id: cat, name: 'X' }, locality: { municipality: 'Brno', district: 'Brno-město', region: 'Jihomoravský kraj', entity_type: 'municipality', entity_id: 1 }, images: [] };
}
function ctxOf(http, extra = {}) {
  const emitted = []; const warn = [];
  return { emitted, warn, ctx: { http, mode: 'full', maxPages: 400, minPrice: 500, config: { sbazarMaxResolve: 0 }, log: { warn: (m) => warn.push(m), info() {}, debug() {} }, isKnown: () => null, emit: async (i) => emitted.push(i), ...extra } };
}

test('BREAK: API ignores category_id → foreign items emitted?', async () => {
  const all = [];
  for (let i = 0; i < 50; i++) all.push(item(1000 + i, i % 2 ? 628 : 1234));
  const s = mk((u) => ({ status: 200, body: { pagination: { total: all.length }, results: all.slice(Number(u.searchParams.get('offset')), Number(u.searchParams.get('offset')) + 500) } }));
  const { ctx, emitted } = ctxOf(s.http);
  const r = await sbazar.scan(ctx).catch((e) => ({ err: e.message }));
  console.log('foreign:', r, 'emitted', emitted.length, [...new Set(emitted.map((e) => e.categorySrc))]);
});

test('BREAK: total 0 everywhere → complete?', async () => {
  const s = mk(() => ({ status: 200, body: { pagination: { total: 0 }, results: [] } }));
  const { ctx } = ctxOf(s.http);
  console.log('empty:', await sbazar.scan(ctx));
});

test('BREAK: API ignores offset → complete?', async () => {
  const all = []; for (let i = 0; i < 1200; i++) all.push(item(5000 + i, 628, 6000));
  const s = mk((u) => { const c = Number(u.searchParams.get('category_id')); const res = c === 628 && u.searchParams.get('price_from') === '5000' ? all : []; return { status: 200, body: { pagination: { total: res.length }, results: res.slice(0, 500) } }; });
  const { ctx, emitted } = ctxOf(s.http);
  console.log('offset ignored:', await sbazar.scan(ctx), 'emitted', emitted.length);
});

test('BREAK: server caps limit at 200', async () => {
  const all = []; for (let i = 0; i < 1200; i++) all.push(item(5000 + i, 628, 6000));
  const s = mk((u) => { const c = Number(u.searchParams.get('category_id')); const off = Number(u.searchParams.get('offset')); const res = c === 628 && u.searchParams.get('price_from') === '5000' ? all : []; return { status: 200, body: { pagination: { total: res.length }, results: res.slice(off, off + 200) } }; });
  const { ctx, emitted, warn } = ctxOf(s.http);
  console.log('limit cap:', await sbazar.scan(ctx), 'emitted', emitted.length, warn);
});

test('BREAK: resolve returns 400 for all', async () => {
  const items = []; for (let i = 0; i < 30; i++) { const it = item(7000 + i, 628, 6000); it.locality.entity_id = 100 + i; items.push(it); }
  const store = new Map();
  const s = mk((u) => {
    if (u.pathname.endsWith('/resolve')) return { status: 400, body: { status_code: 400 } };
    const c = Number(u.searchParams.get('category_id')); const res = c === 628 && u.searchParams.get('price_from') === '5000' ? items : [];
    return { status: 200, body: { pagination: { total: res.length }, results: res } };
  });
  const { ctx } = ctxOf(s.http, { config: {}, cache: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) } });
  await sbazar.scan(ctx);
  console.log('resolve 400: requests', s.calls.filter((c) => c.includes('resolve')).length, 'cached', store.size, [...store.values()][0]);
});
