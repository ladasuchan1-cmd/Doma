'use strict';
// Testy src/render/html.js a src/render/format.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { html, raw, escape, attr, joinHtml, isHtml } = require('../src/render/html');
const format = require('../src/render/format');

test('html``: escapuje hodnoty, raw ponechá, pole spojí, null vynechá', () => {
  const user = '<script>alert("x")</script> & \'q\'';
  const out = html`<p title="${user}">${user}</p>`.toString();
  assert.equal(out, '<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;</p>');
  assert.equal(html`${raw('<b>x</b>')}`.toString(), '<b>x</b>');
  assert.equal(html`${[html`<i>a</i>`, 'b<', null, undefined, false, 3]}`.toString(), '<i>a</i>b&lt;3');
  assert.equal(html`${null}${undefined}${false}`.toString(), '');
  assert.equal(html`${0}`.toString(), '0');
  const inner = html`<em>${'<'}</em>`;
  assert.equal(html`<p>${inner}</p>`.toString(), '<p><em>&lt;</em></p>', 'vnořený fragment se neescapuje dvakrát');
  assert.ok(isHtml(inner));
  assert.equal(String(raw(null)), '');
});

test('escape a attr', () => {
  assert.equal(escape('a&b<c>"d\'e'), 'a&amp;b&lt;c&gt;&quot;d&#39;e');
  assert.equal(escape(null), '');
  assert.equal(attr({ class: 'x', disabled: true, hidden: false, 'data-id': 3, title: null, alt: 'a"b' }).toString(), ' class="x" disabled data-id="3" alt="a&quot;b"');
  assert.equal(attr(null).toString(), '');
  assert.throws(() => attr({ 'onclick="x"': 1 }));
  assert.equal(joinHtml(['a<', raw('<b>')], ', ').toString(), 'a&lt;, <b>');
});

test('format: peníze, data, časy v Europe/Prague, km, otevírací doba', () => {
  assert.equal(format.money(39000), '390 Kč');
  assert.equal(format.money(39050), '390,50 Kč');
  assert.equal(format.money(1250050), '12 500,50 Kč');
  assert.equal(format.money(-5000), '−50 Kč');
  assert.equal(format.money('x'), '');
  assert.equal(format.date('2026-07-12T06:00:00.000Z'), '12. 7. 2026');
  assert.equal(format.time('2026-07-12T06:30:00.000Z'), '8:30', 'letní čas UTC+2');
  assert.equal(format.time('2026-01-12T06:30:00.000Z'), '7:30', 'zimní čas UTC+1');
  assert.equal(format.dateTime('2026-07-12T06:30:00.000Z'), '12. 7. 2026 8:30');
  assert.equal(format.dateRange('2026-07-12', '2026-07-14'), '12. 7. – 14. 7. 2026');
  assert.equal(format.dateRange('2026-07-12', '2026-07-12'), '12. 7. 2026');
  assert.equal(format.isoDate('2026-07-12T22:30:00.000Z'), '2026-07-13', 'po půlnoci v Praze');
  assert.equal(format.km(12.46), '12,5 km');
  assert.equal(format.km(0.85), '850 m');
  assert.equal(format.plural(1, 'den', 'dny', 'dní'), '1 den');
  assert.equal(format.plural(3, 'den', 'dny', 'dní'), '3 dny');
  assert.equal(format.plural(7, 'den', 'dny', 'dní'), '7 dní');
  assert.equal(format.dayKey('2026-07-12'), 'sun');
  const rows = format.openingHoursRows({ mon: ['09:00', '18:00'], tue: ['09:00', '18:00'], wed: ['09:00', '18:00'], thu: ['09:00', '18:00'], fri: ['09:00', '18:00'], sat: ['08:00', '19:00'], sun: ['08:00', '19:00'] });
  assert.deepEqual(rows, [
    { days: 'Po–Pá', hours: '9:00–18:00' },
    { days: 'So–Ne', hours: '8:00–19:00' },
  ]);
  assert.deepEqual(format.openingHoursRows({ mon: ['09:00', '18:00'] })[1], { days: 'Út–Ne', hours: 'zavřeno' });
});
