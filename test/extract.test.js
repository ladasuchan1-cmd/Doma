const test = require('node:test');
const assert = require('node:assert');
const E = require('../lib/extract.js');
const C = require('../lib/claude.js');
const S = require('../lib/schema.js');

test('fromHtml odstraní skripty, styly, navigaci a dekóduje entity', () => {
  const html = '<html><head><title>Podmínky &amp; GDPR</title><style>.x{}</style><script>var a=1</script></head><body><nav><a>Menu</a></nav><main><h1>Obchodní podmínky</h1><p>Cena je 199&nbsp;Kč m&#283;s&iacute;čně.<br>Další řádek.</p></main><footer>Patička</footer></body></html>';
  const t = E.fromHtml(html);
  assert.strictEqual(E.titleFromHtml(html), 'Podmínky & GDPR');
  assert.ok(!t.includes('Menu'));
  assert.ok(!t.includes('Patička'));
  assert.ok(!t.includes('var a=1'));
  assert.ok(t.includes('## Obchodní podmínky'));
  assert.ok(t.includes('199 Kč měsíčně.'));
});

test('hash je stabilní a rozlišuje texty', () => {
  assert.strictEqual(E.hash('abc'), E.hash('abc'));
  assert.notStrictEqual(E.hash('abc'), E.hash('abd'));
});

test('buildRequest sestaví validní tělo požadavku', () => {
  const { body, betas, truncated } = C.buildRequest('Text podmínek', { url: 'https://x.cz/vop', title: 'VOP', context: 'nákup' }, { model: 'claude-opus-5', effort: 'medium' });
  assert.strictEqual(body.model, 'claude-opus-5');
  assert.strictEqual(body.output_config.format.type, 'json_schema');
  assert.deepStrictEqual(body.output_config.format.schema, S.RESULT_SCHEMA);
  assert.strictEqual(body.fallbacks, 'default');
  assert.deepStrictEqual(betas, ['server-side-fallback-2026-07-01']);
  assert.ok(!('thinking' in body), 'thinking se neposílá (adaptivní je výchozí)');
  assert.ok(!('temperature' in body));
  assert.ok(body.messages[0].content[0].text.includes('URL dokumentu: https://x.cz/vop'));
  assert.strictEqual(truncated, false);
});

test('buildRequest zkrátí příliš dlouhý text', () => {
  const { body, truncated } = C.buildRequest('a'.repeat(C.MAX_CHARS + 10), {}, {});
  assert.strictEqual(truncated, true);
  assert.ok(body.messages[0].content[0].text.includes('zkrácen'));
});

test('schéma má additionalProperties:false všude', () => {
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') assert.strictEqual(node.additionalProperties, false);
    for (const v of Object.values(node.properties || {})) walk(v);
    if (node.items) walk(node.items);
  }
  walk(S.RESULT_SCHEMA);
});
