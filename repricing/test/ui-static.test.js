'use strict';
// Statické kontroly webového rozhraní: žádné innerHTML/eval, žádné inline skripty ani externí zdroje (CSP 'self'),
// všechny moduly se dají načíst (existují importované soubory i exporty), pohledy mají správné rozhraní.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PUB = path.join(__dirname, '..', 'public');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const files = walk(PUB);
const jsFiles = files.filter((f) => f.endsWith('.js'));

test('žádné nebezpečné vkládání HTML ani eval', () => {
  const bad = [/\.(innerHTML|outerHTML|insertAdjacentHTML)\b/, /document\.write\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/, /setTimeout\s*\(\s*['"`]/];
  for (const f of jsFiles) {
    const src = fs.readFileSync(f, 'utf8');
    for (const re of bad) assert.ok(!re.test(src), `${path.relative(PUB, f)} obsahuje ${re}`);
  }
});

test('index.html: žádné inline skripty, handlery ani externí zdroje', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 1);
  for (const [, attrs, body] of scripts) {
    assert.match(attrs, /\bsrc=/, 'skript musí mít src');
    assert.strictEqual(body.trim(), '', 'inline obsah skriptu je zakázán (CSP)');
  }
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline handlery (onclick=…) jsou zakázané');
  assert.ok(!/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html), 'externí zdroje jsou zakázané');
  assert.match(html, /<html lang="cs">/);
  assert.match(html, /name="viewport"/);
});

test('JS a CSS nenačítají nic zvenku', () => {
  for (const f of jsFiles) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/\bimport\s*(\(|[^'"]*from\s*)\s*['"](https?:)?\/\//.test(src), path.relative(PUB, f) + ': externí import');
    assert.ok(!/fetch\(\s*['"`]https?:/.test(src), path.relative(PUB, f) + ': externí fetch');
  }
  const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
  assert.ok(!/@import/.test(css), 'CSS @import');
  assert.ok(!/url\(\s*['"]?(https?:)?\/\//.test(css), 'CSS s externí URL');
});

test('relativní importy odkazují na existující soubory', () => {
  for (const f of jsFiles) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(f), m[1]);
      assert.ok(fs.existsSync(target), `${path.relative(PUB, f)} → ${m[1]} neexistuje`);
    }
  }
});

test('všechny moduly (kromě app.js) jdou v Node načíst – exporty a importy sedí', async () => {
  for (const f of jsFiles) {
    if (path.basename(f) === 'app.js') continue;
    await assert.doesNotReject(import(pathToFileURL(f).href), path.relative(PUB, f));
  }
});

test('pohledy exportují show(root, ctx) a app.js na ně odkazuje', async () => {
  const views = fs.readdirSync(path.join(PUB, 'views')).filter((f) => f.endsWith('.js'));
  assert.ok(views.length >= 13);
  const app = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  for (const v of views) {
    const mod = await import(pathToFileURL(path.join(PUB, 'views', v)).href);
    assert.strictEqual(typeof mod.show, 'function', v + ' nemá show()');
    assert.ok(app.includes(`import('./views/${v}')`), v + ' není v app.js');
  }
  for (const route of ['/login', '/prehled', '/produkty', '/produkty/:id', '/navrhy', '/strategie', '/segmenty', '/konkurence', '/import', '/export', '/nastaveni']) {
    assert.ok(app.includes(`pattern: '${route}'`), 'chybí trasa ' + route);
  }
});

test('public/package.json označuje soubory jako ES moduly', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PUB, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.type, 'module');
});
