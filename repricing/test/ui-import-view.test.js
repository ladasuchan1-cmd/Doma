'use strict';
// Regrese pohledu Import (public/views/import.js) nad falešným DOM a falešným API:
//  - contract-7: po chybě serveru při uložení zdroje zůstalo tlačítko „Uložit“ navždy vypnuté
//    (e.currentTarget je po await null → TypeError v catch),
//  - contract-8: ostrý import katalogu s „Deaktivovat produkty, které v souboru chybí“ proběhl bez potvrzení.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { installDom, makeCtx, text } = require('./ui-fake-dom.js');

const dom = installDom();
const PUB = path.join(__dirname, '..', 'public');
const view = () => import(pathToFileURL(path.join(PUB, 'views', 'import.js')).href);
const lib = (f) => import(pathToFileURL(path.join(PUB, 'lib', f)).href);

const pageErrors = [];
process.on('unhandledRejection', (e) => pageErrors.push(e));

test('Nový zdroj: chyba validace serveru → tlačítko Uložit zůstane použitelné a druhý pokus projde', async () => {
  const saved = [];
  dom.api({
    'GET /sources': { items: [] },
    'POST /sources': (req) => {
      if (!/^https?:\/\//.test(req.body.url || '')) return dom.apiError(400, 'Neplatný zdroj: URL musí začínat http:// nebo https://.');
      saved.push(req.body);
      return { id: 7, ...req.body };
    },
  });
  const { show } = await view();
  const root = dom.root();
  await show(root, makeCtx({ query: { tab: 'sources' } }));
  await dom.settle();
  dom.click(root.querySelector('[data-action="new-source"]'));
  const dlg = dom.dialogs().at(-1);
  assert.ok(dlg, 'dialog nového zdroje');
  const inputs = dlg.querySelectorAll('input');
  dom.type(inputs[0], 'X');
  const url = dlg.querySelector('input[type="url"]');
  dom.type(url, 'ftp://example.cz/feed.xml');
  const save = dom.byText('Uložit', dlg, 'button');
  dom.click(save);
  await dom.settle();
  assert.strictEqual(save.disabled, false, 'po chybě je tlačítko znovu aktivní');
  assert.match(text(dlg), /URL musí začínat http/, 'chyba je vidět i ve formuláři');
  assert.deepStrictEqual(pageErrors, [], 'žádná nezachycená výjimka');
  dom.type(url, 'https://example.cz/feed.xml');
  dom.click(save);
  await dom.settle();
  assert.strictEqual(saved.length, 1, 'druhý pokus se odeslal');
  assert.strictEqual(saved[0].url, 'https://example.cz/feed.xml');
  assert.strictEqual(dom.dialogs().includes(dlg), false, 'dialog se po uložení zavřel');
});

/** Nahradí obsah řetězců, šablon, regulárních výrazů a komentářů mezerami (délka i řádky zůstanou). */
function blankLiterals(src) {
  const out = src.split('');
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  let prev = ''; // poslední významný znak (kvůli rozlišení regulárního výrazu od dělení)
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? src.length : e;
      blank(i, end);
      i = end;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2) + 2;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
      prev = c;
    } else if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev))) {
      let j = i + 1;
      let cls = false;
      while (j < src.length && (cls || src[j] !== '/')) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      prev = '/';
    } else {
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return out.join('');
}

/** Nejbližší funkce obklopující pozici idx: {start (index „{“ těla), async}. Bloky if/try/… se přeskočí. */
function enclosingFunction(src, idx) {
  let depth = 0;
  for (let i = idx; i >= 0; i--) {
    if (src[i] === '}') depth++;
    else if (src[i] === '{') {
      if (depth > 0) {
        depth--;
        continue;
      }
      const before = src.slice(Math.max(0, i - 300), i);
      const arrow = /(\basync\s*)?(?:\([^()]*\)|[\w$]+)\s*=>\s*$/.exec(before);
      const fn = /(\basync\s+)?function\b[\w$\s]*\([^()]*\)\s*$/.exec(before);
      const method = /(\basync\s+)?\b[\w$]+\s*\([^()]*\)\s*$/.exec(before);
      const m = arrow || fn || (method && !/\b(if|for|while|switch|catch|with)\s*\([^()]*\)\s*$/.test(before) ? method : null);
      if (m) return { start: i, async: Boolean(m[1]) };
    }
  }
  return null;
}

test('v UI nikde e.currentTarget po await (po skončení události je null)', () => {
  // Statická pojistka: v async funkci se currentTarget smí číst jen před prvním await téže funkce.
  const files = ['views', 'lib'].flatMap((d) => fs.readdirSync(path.join(PUB, d)).map((f) => path.join(PUB, d, f))).concat(path.join(PUB, 'app.js'));
  const bad = [];
  let checked = 0;
  for (const f of files) {
    const src = blankLiterals(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/\bcurrentTarget\b/g)) {
      checked++;
      const fn = enclosingFunction(src, m.index);
      if (!fn || !fn.async) continue;
      if (/\bawait\b/.test(src.slice(fn.start, m.index))) bad.push(path.relative(PUB, f) + ':' + src.slice(0, m.index).split('\n').length);
    }
  }
  assert.ok(checked >= 3, 'test našel použití currentTarget');
  assert.deepStrictEqual(bad, []);
});

test('statická kontrola currentTarget: pozná chybu i správný vzor', () => {
  const wrong = blankLiterals("x({ onClick: async (e) => { e.currentTarget.disabled = true; try { await f('{'); } catch { e.currentTarget.disabled = false; } } });");
  const right = blankLiterals("x({ onClick: async (e) => { const btn = e.currentTarget; btn.disabled = true; try { await f(); } finally { btn.disabled = false; } }, onKey: (e) => { e.currentTarget.focus(); } });");
  const hits = (src) => [...src.matchAll(/\bcurrentTarget\b/g)].filter((m) => {
    const fn = enclosingFunction(src, m.index);
    return fn && fn.async && /\bawait\b/.test(src.slice(fn.start, m.index));
  }).length;
  assert.strictEqual(hits(wrong), 1);
  assert.strictEqual(hits(right), 0);
});

test('deactivateMissingConfirm: počet ze zkušebního importu jen při stejné volbě', async () => {
  const { deactivateMissingConfirm } = await lib('import-model.js');
  const norm = (s) => s.replace(/[  ]/g, ' ');
  const withN = deactivateMissingConfirm({ stats: { deactivated: 1460 } }, { dryWithDeactivate: true, activeTotal: 1500 });
  assert.strictEqual(withN.danger, true);
  assert.match(norm(withN.message), /deaktivuje 1 460 produktů z 1 500 aktivních/);
  // zkušební import bez deaktivace → počet (0) nepoužít
  const noDry = deactivateMissingConfirm({ stats: { deactivated: 0 } }, { dryWithDeactivate: false, activeTotal: 1500 });
  assert.doesNotMatch(noDry.message, /deaktivuje 0/);
  assert.match(norm(noDry.message), /Všechny aktivní produkty \(nyní 1 500\)/);
  assert.match(deactivateMissingConfirm(null).message, /zkušebním importem/);
  // server deaktivaci odmítl (víc než polovina katalogu) → zopakovat jeho hlášku, ne „deaktivuje se 0“
  const refused = deactivateMissingConfirm({ stats: { deactivated: 0, errors: [{ row: null, message: 'Deaktivace chybějících produktů byla přeskočena: import by vypnul 1460 z 1500 aktivních produktů.' }] } }, { dryWithDeactivate: true, activeTotal: 1500 });
  assert.match(refused.message, /byla přeskočena/);
  assert.doesNotMatch(norm(refused.message), /deaktivuje 0/);
});

test('ostrý import katalogu s deaktivací chybějících vyžaduje potvrzení; Zrušit nic neodešle', async () => {
  const uploads = [];
  dom.api({
    'POST /import/preview': () => ({ format: 'csv', headers: ['Kód', 'Název', 'Prodejní cena s DPH'], sample: [{ Kód: 'A', Název: 'Kolo', 'Prodejní cena s DPH': '100' }], canonical: [{ code: 'A', name: 'Kolo', price: 100 }], suggested: { code: 'Kód', name: 'Název', price: 'Prodejní cena s DPH' }, errors: [] }),
    'POST /import/products': (req) => {
      uploads.push(req.query);
      return { import_id: req.query.dry_run ? null : 5, stats: { received: 40, created: 0, updated: 40, unchanged: 0, deactivated: 1460, errors: [] } };
    },
    'GET /products': { items: [], total: 1500, page: 1, limit: 1 },
  });
  const { show } = await view();
  const root = dom.root();
  await show(root, makeCtx({ query: { kind: 'products' } }));
  // soubor vložený jako text (stejná cesta jako přetažení souboru)
  const ta = root.querySelector('textarea');
  ta.value = 'Kód;Název;Prodejní cena s DPH\nA;Kolo;100';
  dom.click(dom.byText('Načíst vložená data', root, 'button'));
  await dom.settle();
  const deact = root.querySelectorAll('label.check').find((l) => /Deaktivovat produkty/.test(l.textContent)).querySelector('input');
  deact.checked = true;
  dom.change(deact);
  // zkušební import s deaktivací → počet do potvrzení
  dom.click(root.querySelector('[data-action="dry-run"]'));
  await dom.settle();
  assert.strictEqual(uploads.length, 1);
  assert.strictEqual(uploads[0].dry_run, '1');
  dom.click(root.querySelector('[data-action="import"]'));
  await dom.settle();
  let dlg = dom.dialogs().at(-1);
  assert.ok(dlg, 'před ostrým importem se ukáže potvrzení');
  assert.match(text(dlg), /deaktivuje 1 460 produktů z 1 500 aktivních/);
  assert.ok(dlg.querySelector('.btn-danger'), 'nebezpečná akce');
  dom.click(dlg.querySelector('[data-cancel]'));
  await dom.settle();
  assert.strictEqual(uploads.length, 1, 'po Zrušit se nic neodeslalo');
  dom.click(root.querySelector('[data-action="import"]'));
  await dom.settle();
  dlg = dom.dialogs().at(-1);
  dom.click(dlg.querySelector('[data-confirm]'));
  await dom.settle();
  assert.strictEqual(uploads.length, 2);
  assert.strictEqual(uploads[1].deactivate_missing, '1');
  assert.strictEqual(uploads[1].dry_run, undefined);
});
