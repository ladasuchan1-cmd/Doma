'use strict';
// Testy rendereru Markdownu a šablonování právních textů (src/render/markdown.js, SPEC kap. 11):
// každá konstrukce Markdownu, escapování HTML v obsahu i v hodnotách parametrů, {{X}}, {{#X}}, {{^X}},
// INTERNI bloky, interní sekce, rámeček, STORNO_TABULKA, výřez sekcí, chybějící placeholdery.
const test = require('node:test');
const assert = require('node:assert/strict');
const md = require('../src/render/markdown');
const { raw } = require('../src/render/html');

const html = (src, params, opts) => md.render(src, params, opts).html;

test('nadpisy #–#### dostanou id (slug bez diakritiky), title = první h1', () => {
  const r = md.render('# Obchodní podmínky půjčovny Ústí\n\n## 1. Kdo jsme\n\n### Podsekce\n\n#### Čtvrtá\n');
  assert.match(r.html, /<h1 id="obchodni-podminky-pujcovny-usti">Obchodní podmínky půjčovny Ústí<\/h1>/);
  assert.match(r.html, /<h2 id="1-kdo-jsme">1\. Kdo jsme<\/h2>/);
  assert.match(r.html, /<h3 id="podsekce">Podsekce<\/h3>/);
  assert.match(r.html, /<h4 id="ctvrta">Čtvrtá<\/h4>/);
  assert.equal(r.title, 'Obchodní podmínky půjčovny Ústí');
  assert.deepEqual(r.headings.map((h) => h.level), [1, 2, 3, 4]);
  // duplicitní nadpis → unikátní id
  const d = html('## A\n\n## A\n');
  assert.match(d, /id="a"/);
  assert.match(d, /id="a-2"/);
});

test('odstavce: prázdný řádek odděluje, měkký konec řádku → <br>', () => {
  const out = html('První řádek\ndruhý řádek\n\nDruhý odstavec');
  assert.equal(out, '<p>První řádek<br>druhý řádek</p>\n<p>Druhý odstavec</p>');
});

test('inline: tučné, kurzíva, kód, vnoření, ☐/☑ zůstávají', () => {
  assert.equal(html('**tučné** a *kurzíva* a `kód` a **tučné *s kurzívou***'), '<p><strong>tučné</strong> a <em>kurzíva</em> a <code>kód</code> a <strong>tučné <em>s kurzívou</em></strong></p>');
  assert.equal(html('☐ nezaškrtnuto ☑ zaškrtnuto'), '<p>☐ nezaškrtnuto ☑ zaškrtnuto</p>');
  assert.equal(html('3 * 4 * 5'), '<p>3 * 4 * 5</p>', 'hvězdičky s mezerami nejsou kurzíva');
  assert.equal(html('\\*ne kurzíva\\*'), '<p>*ne kurzíva*</p>', 'zpětné lomítko escapuje');
  assert.equal(html('Nespárované **tučné'), '<p>Nespárované **tučné</p>');
});

test('odkazy: bezpečná URL, rel=noopener u externích, nebezpečné schéma bez odkazu, holé https:// autolink', () => {
  assert.equal(html('[ČOI](https://www.coi.gov.cz/x)'), '<p><a href="https://www.coi.gov.cz/x" rel="noopener">ČOI</a></p>');
  assert.equal(html('[zásady](/soukromi) a [kotva](#a) a [mail](mailto:a@b.cz)'), '<p><a href="/soukromi">zásady</a> a <a href="#a">kotva</a> a <a href="mailto:a@b.cz">mail</a></p>');
  assert.equal(html('[zlý](javascript:alert(1))'), '<p>zlý</p>');
  assert.equal(html('[repo](../docs/x.md)'), '<p>repo</p>');
  assert.equal(html('Viz https://aplikace.mvcr.cz/neplatne-doklady/.'), '<p>Viz <a href="https://aplikace.mvcr.cz/neplatne-doklady/" rel="noopener">https://aplikace.mvcr.cz/neplatne-doklady/</a>.</p>');
  assert.equal(html('(web https://www.coi.gov.cz/informace-o-adr/)'), '<p>(web <a href="https://www.coi.gov.cz/informace-o-adr/" rel="noopener">https://www.coi.gov.cz/informace-o-adr/</a>)</p>');
  // odkaz na sousední šablonu → veřejná cesta přes linkMap, jinak jen text
  assert.equal(html('[Zásady](zasady-ochrany-osobnich-udaju.md)', {}, { linkMap: { 'zasady-ochrany-osobnich-udaju.md': '/soukromi' } }), '<p><a href="/soukromi">Zásady</a></p>');
  assert.equal(html('[Zásady](zasady-ochrany-osobnich-udaju.md)'), '<p>Zásady</p>');
  assert.equal(html('[E-KOLO] řádek'), '<p>[E-KOLO] řádek</p>', 'hranaté závorky bez odkazu zůstávají textem');
});

test('seznamy: odrážky, číslované se start, vnoření o jednu úroveň, pokračovací řádek', () => {
  assert.equal(html('- a) první\n- b) druhý\n  - vnořený\n- třetí'), '<ul><li>a) první</li><li>b) druhý<ul><li>vnořený</li></ul></li><li>třetí</li></ul>');
  assert.equal(html('1. jedna\n2. dvě\n   pokračuje\n3. tři'), '<ol><li>jedna</li><li>dvě pokračuje</li><li>tři</li></ol>');
  assert.equal(html('3. třetí\n4. čtvrtá'), '<ol start="3"><li>třetí</li><li>čtvrtá</li></ol>');
  assert.equal(html('- ☐ je vám **18 let**\n- ☐ [E-KOLO] zaškolení'), '<ul><li>☐ je vám <strong>18 let</strong></li><li>☐ [E-KOLO] zaškolení</li></ul>');
  // seznam následovaný odstavcem
  assert.equal(html('- x\n\nOdstavec'), '<ul><li>x</li></ul>\n<p>Odstavec</p>');
});

test('tabulky: záhlaví, tělo, doplnění chybějících buněk, prázdné záhlaví se vynechá, escapovaný svislítko', () => {
  const t = html('| A | B |\n|---|---|\n| 1 | **2** |\n| jen jedna |\n');
  assert.equal(t, '<div class="table-wrap"><table class="table"><thead><tr><th scope="col">A</th><th scope="col">B</th></tr></thead><tbody><tr><td>1</td><td><strong>2</strong></td></tr><tr><td>jen jedna</td><td></td></tr></tbody></table></div>');
  const noHead = html('| | |\n|---|---|\n| Kauce | 3 000 Kč |');
  assert.ok(!noHead.includes('<thead>'));
  assert.match(noHead, /<td>Kauce<\/td><td>3 000 Kč<\/td>/);
  assert.match(html('| a | b |\n|---|---|\n| x \\| y | z |'), /<td>x \| y<\/td><td>z<\/td>/);
});

test('blockquote, vodorovná čára, ohraničený kód', () => {
  assert.equal(html('> **Správce**\n> sídlo: Praha\n>\n> druhý odstavec'), '<blockquote><p><strong>Správce</strong><br>sídlo: Praha</p>\n<p>druhý odstavec</p></blockquote>');
  assert.equal(html('a\n\n---\n\nb'), '<p>a</p>\n<hr>\n<p>b</p>');
  assert.equal(html('```\nPředmět: <x> & y\n```'), '<pre><code>Předmět: &lt;x&gt; &amp; y</code></pre>');
});

test('escapování HTML v obsahu: značky i entity v textu, buňkách, nadpisech a atributech', () => {
  assert.equal(html('<script>alert(1)</script> & "uvozovky"'), '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;uvozovky&quot;</p>');
  assert.equal(html('## <b>x</b>'), '<h2 id="b-x-b">&lt;b&gt;x&lt;/b&gt;</h2>');
  assert.match(html('| <i> |\n|---|\n| <u> |'), /<th scope="col">&lt;i&gt;<\/th>.*<td>&lt;u&gt;<\/td>/);
  assert.equal(html('[x](https://a.cz/?q="><script>)'), '<p><a href="https://a.cz/?q=&quot;&gt;&lt;script&gt;" rel="noopener">x</a></p>');
  assert.equal(html('<!-- komentář -->text'), '<p>text</p>', 'HTML komentáře se zahazují');
});

test('šablonování: {{X}} dosadí escapovanou hodnotu i v odkazu a kódu; null/undefined → prázdno', () => {
  const out = html('Firma **{{NAZEV}}**, web [{{WEB}}](https://{{WEB}}/podminky), `{{WEB}}`, nic:{{NIC}}.', { NAZEV: 'U Tří dubů <s.r.o.> & spol.', WEB: 'ksprehledy.cz', NIC: null });
  assert.equal(out, '<p>Firma <strong>U Tří dubů &lt;s.r.o.&gt; &amp; spol.</strong>, web <a href="https://ksprehledy.cz/podminky" rel="noopener">ksprehledy.cz</a>, <code>ksprehledy.cz</code>, nic:.</p>');
  // hodnota s markdown znaky se nevykládá jako markdown
  assert.equal(html('{{A}}', { A: '**ne tučné** [x](javascript:1) | b' }), '<p>**ne tučné** [x](javascript:1) | b</p>');
  // hodnota s uvozovkami v atributu
  assert.equal(html('[odkaz]({{URL}})', { URL: 'https://a.cz/"onclick="x' }), '<p><a href="https://a.cz/&quot;onclick=&quot;x" rel="noopener">odkaz</a></p>');
  // číslo a Html fragment
  assert.equal(html('{{N}} kol, {{H}}', { N: 3, H: raw('<em>fragment</em>') }), '<p>3 kol, <em>fragment</em></p>');
  // nadpis s parametrem → id z hodnoty
  assert.match(html('# Podmínky {{N}}', { N: 'Půjčovna Řeka' }), /<h1 id="podminky-pujcovna-reka">Podmínky Půjčovna Řeka<\/h1>/);
});

test('šablonování: {{#X}} a {{^X}} podle pravdivosti (ano/ne, prázdno, boolean), vnoření, neuzavřený blok zůstane', () => {
  const src = 'A{{#P}} plátce{{/P}}{{^P}} neplátce{{/P}}.';
  assert.equal(html(src, { P: 'ano' }), '<p>A plátce.</p>');
  assert.equal(html(src, { P: 'ne' }), '<p>A neplátce.</p>');
  assert.equal(html(src, { P: true }), '<p>A plátce.</p>');
  assert.equal(html(src, { P: '' }), '<p>A neplátce.</p>');
  assert.equal(html(src, { P: '—' }), '<p>A neplátce.</p>');
  assert.equal(html(src, {}), '<p>A neplátce.</p>');
  assert.equal(html('IČO 1{{#DIC}}, DIČ {{DIC}}{{/DIC}}, sídlo', { DIC: 'CZ1' }), '<p>IČO 1, DIČ CZ1, sídlo</p>');
  assert.equal(html('IČO 1{{#DIC}}, DIČ {{DIC}}{{/DIC}}, sídlo', { DIC: '' }), '<p>IČO 1, sídlo</p>');
  assert.equal(html('{{#A}}a{{#B}}b{{/B}}{{^B}}ne-b{{/B}}{{/A}}', { A: 1, B: 0 }), '<p>ane-b</p>');
  assert.equal(html('{{#A}}a{{#A}}vnořené{{/A}}{{/A}}', { A: 1 }), '<p>avnořené</p>');
  assert.equal(html('{{#A}}bez konce', { A: 1 }), '<p>{{#A}}bez konce</p>');
  // podmíněný řádek tabulky
  const t = html('| a | b |\n|---|---|\n{{#M}}| **{{M}}** | x |{{/M}}\n| c | d |', { M: '' });
  assert.ok(!t.includes('<strong>'));
  assert.match(t, /<td>c<\/td>/);
});

test('bloky se značkami na samostatných řádcích: žádný prázdný řádek navíc, tabulka zůstane celistvá, skrytý blok zmizí i s řádky', () => {
  const src = 'A\n\n{{#X}}\n> b\n{{/X}}\n{{^X}}\n> c\n{{/X}}\n\nD';
  assert.equal(html(src, { X: 'ano' }), '<p>A</p>\n<blockquote><p>b</p></blockquote>\n<p>D</p>');
  assert.equal(html(src, { X: 'ne' }), '<p>A</p>\n<blockquote><p>c</p></blockquote>\n<p>D</p>');
  // blok obalující víc řádků tabulky
  const table = '| a |\n|---|\n{{#X}}\n| 1 |\n| 2 |\n{{/X}}\n| 3 |';
  assert.equal(html(table, { X: 1 }), '<div class="table-wrap"><table class="table"><thead><tr><th scope="col">a</th></tr></thead><tbody><tr><td>1</td></tr><tr><td>2</td></tr><tr><td>3</td></tr></tbody></table></div>');
  assert.equal(html(table, { X: 0 }), '<div class="table-wrap"><table class="table"><thead><tr><th scope="col">a</th></tr></thead><tbody><tr><td>3</td></tr></tbody></table></div>');
  // odstavec obalený blokem; za ním nadpis
  assert.equal(html('{{#P}}\n3.6 **Platba na místě.** text\n{{/P}}\n\n## 4. Cena', { P: 'ne' }), '<h2 id="4-cena">4. Cena</h2>');
  assert.equal(html('{{#P}}\n3.6 **Platba na místě.** text\n{{/P}}\n\n## 4. Cena', { P: 'ano' }), '<p>3.6 <strong>Platba na místě.</strong> text</p>\n<h2 id="4-cena">4. Cena</h2>');
  // podmíněný nadpis s podsekcí
  assert.equal(html('### A\n\n{{#X}}\n### B\n\nb\n\n{{/X}}\n\n### C', { X: '' }), '<h3 id="a">A</h3>\n<h3 id="c">C</h3>');
});

test('cyklus {{#X}} nad polem záznamů: řádky tabulky pro každý záznam, hodnoty escapované, vnořené podmínky per záznam', () => {
  const rows = [
    { X: '1', E: 'ano', T: 'Trek <FX>' },
    { X: '2|x', E: 'ne', T: '**ne tučné**' },
  ];
  const t = html('| # | typ | e |\n|---|---|---|\n{{#R}}| {{X}} | {{T}} | {{#E}}e-kolo{{/E}}{{^E}}–{{/E}} |{{/R}}\n| z | z | z |', { R: rows });
  assert.match(t, /<tr><td>1<\/td><td>Trek &lt;FX&gt;<\/td><td>e-kolo<\/td><\/tr><tr><td>2\|x<\/td><td>\*\*ne tučné\*\*<\/td><td>–<\/td><\/tr><tr><td>z<\/td>/);
  // cyklus přes celou tabulku (blok na samostatných řádcích) → tabulka pro každý záznam
  const tables = html('{{#K}}\n| h {{V}} |\n|---|\n| {{V}} |\n\n{{/K}}\n\n## N', { K: [{ V: '1' }, { V: '2' }] });
  assert.equal((tables.match(/<table/g) || []).length, 2);
  assert.match(tables, /<th scope="col">h 2<\/th>/);
  assert.match(tables, /<h2 id="n">N<\/h2>$/);
  // cyklus uvnitř věty, globální parametr dostupný uvnitř, hodnota záznamu má přednost
  assert.equal(html('Kola: {{#K}}{{V}} ({{G}}); {{/K}}konec', { K: [{ V: 'A' }, { V: 'B', G: 'vlastní' }], G: 'glob' }), '<p>Kola: A (glob); B (vlastní); konec</p>');
  // prázdné pole = nepravda; „ano“ bez pole = jeden průchod s globálními hodnotami
  assert.equal(html('a{{#K}}x{{/K}}{{^K}}nic{{/K}}', { K: [] }), '<p>anic</p>');
  assert.equal(html('{{#K}}| {{V}} |{{/K}}', { K: 'ano', V: 'glob' }), '<p>| glob |</p>');
  assert.equal(md.isTruthy([]), false);
  assert.equal(md.isTruthy([{}]), true);
  // {{K}} jako prostý placeholder nad polem skalárů → seznam
  assert.equal(html('{{K}}', { K: ['a', 'b'] }), '<p>a, b</p>');
  // Html fragment v záznamu se vloží beze změny
  assert.equal(html('{{#K}}{{H}}{{/K}}', { K: [{ H: raw('<em>x</em>') }] }), '<p><em>x</em></p>');
  assert.deepEqual(md.render('{{#K}}{{V}}{{/K}}', { K: [{ V: 1 }] }).missing, []);
});

test('INTERNI bloky a HTML komentáře se vyhodí, interní sekce a rámeček se nerenderují', () => {
  const src = [
    '# Zásady',
    '',
    '<!-- INTERNI: nerenderovat -->',
    '',
    '> **Návrh připravený jako podklad.**',
    '',
    '## Parametry',
    '',
    '| `{{X}}` | význam |',
    '|---|---|',
    '',
    '<!-- /INTERNI -->',
    '',
    'Veřejný text {{A}}.',
    '',
    '## K ověření advokátem',
    '',
    '1. sporný bod {{NEZNAMY}}',
    '',
    '## Příloha pro advokáta – odůvodnění',
    '',
    'interní',
    '',
    '# Druhá část',
    '',
    'veřejné',
  ].join('\n');
  const r = md.render(src, { A: 'ok' });
  assert.equal(r.html, '<h1 id="zasady">Zásady</h1>\n<p>Veřejný text ok.</p>\n<h1 id="druha-cast">Druhá část</h1>\n<p>veřejné</p>');
  assert.deepEqual(r.missing, []);
  // rámeček a sekce i bez INTERNI značek
  const plain = '# Titul\n\n> **Návrh připravený jako podklad; před použitím vyžaduje kontrolu advokátem.**\n\n## Parametry\n\n| a | b |\n|---|---|\n| {{Q}} | x |\n\n---\n\n# Dokument\n\n## 1. Kdo jsme\n\ntext\n\n## K ověření advokátem\n\n1. bod';
  const p = md.render(plain, {});
  // oddělovač --- za vyhozenou sekcí Parametry patří k ní a zmizí také
  assert.equal(p.html, '<h1 id="titul">Titul</h1>\n<h1 id="dokument">Dokument</h1>\n<h2 id="1-kdo-jsme">1. Kdo jsme</h2>\n<p>text</p>');
  assert.deepEqual(p.missing, []);
  // zmínka značky uvnitř textu (v kódu) blok INTERNI neukončí – tabulka Parametry nesmí prosáknout na web
  const leak = '# T\n\n<!-- INTERNI: nerenderovat -->\n\n## Parametry\n\nOddíly mezi `<!-- INTERNI: nerenderovat -->` a `<!-- /INTERNI -->` jsou interní.\n\n| Parametr | Význam |\n|---|---|\n| `{{A}}` | firma |\n\n<!-- /INTERNI -->\n\n## Stručně\n\nveřejné {{A}}';
  const l = md.render(leak, { A: 'ok' });
  assert.equal(l.html, '<h1 id="t">T</h1>\n<h2 id="strucne">Stručně</h2>\n<p>veřejné ok</p>');
  // omitHeadings – volitelné vyřazení dalších sekcí (např. ČÁST D protokolu)
  const o = md.render('# ČÁST C – Vrácení\n\nc\n\n# ČÁST D – Co se ukládá\n\nd', {}, { omitHeadings: [/^ČÁST D/] });
  assert.equal(o.html, '<h1 id="cast-c-vraceni">ČÁST C – Vrácení</h1>\n<p>c</p>');
});

test('chybějící placeholder zůstane viditelný jako {{NAZEV}} a je v missing', () => {
  const r = md.render('Ahoj {{KDO}} a {{KDO}} a {{DALSI}}', { X: 1 });
  assert.equal(r.html, '<p>Ahoj {{KDO}} a {{KDO}} a {{DALSI}}</p>');
  assert.deepEqual(r.missing, ['KDO', 'DALSI']);
});

test('STORNO_TABULKA: na samostatném řádku tabulka ze settings.cancellation, uvnitř věty text', () => {
  const src = 'Pravidla:\n\n{{STORNO_TABULKA}}\n\nVěta ({{STORNO_TABULKA}}).';
  const r = md.render(src, {}, { cancellation: { freeHoursBefore: 48 } });
  assert.match(r.html, /<table class="table">/);
  assert.match(r.html, /<td>nejméně 48 hodin před začátkem nájmu<\/td><td>100 %<\/td><td>0 %<\/td>/);
  assert.match(r.html, /<td>méně než 48 hodin před začátkem nájmu, nebo kola nevyzvednete<\/td><td>0 %<\/td><td>100 % \(poplatek propadá\)<\/td>/);
  assert.match(r.html, /<p>Věta \(zrušení nejméně 48 hodin před začátkem nájmu: vrátíme celý rezervační poplatek · později nebo při nevyzvednutí kol: poplatek propadá\)\.<\/p>/);
  assert.equal((r.html.match(/<table/g) || []).length, 1);
  assert.deepEqual(r.missing, []);
  // jiná lhůta a výchozí 48 při nesmyslu
  assert.equal(md.stornoTable({ freeHoursBefore: 24 }).hours, 24);
  assert.equal(md.stornoTable({}).hours, 48);
  // explicitní hodnota v params má přednost; settings objekt se převede
  assert.match(html('{{STORNO_TABULKA}}', { STORNO_TABULKA: { freeHoursBefore: 72 } }), /nejméně 72 hodin/);
  assert.match(html('{{STORNO_TABULKA}}', { STORNO_TABULKA: 'text tabulky' }), /<p>text tabulky<\/p>/);
});

test('markdown hodnota parametru: vlastní tabulka na řádku, inline text ve větě', () => {
  const v = { markdown: '| a |\n|---|\n| b |', inline: 'a: b' };
  assert.match(html('{{T}}', { T: v }), /<table class="table">/);
  assert.equal(html('viz ({{T}})', { T: v }), '<p>viz (a: b)</p>');
});

test('extractSections vybere sekce ## podle vzorů včetně podsekcí, až po další ##', () => {
  const src = '# OP\n\n## 11. Vrácení\n\nv\n\n## 12. Závady a reklamace\n\n12.1 text\n\n### 12.a\n\npod\n\n## 13. Mimosoudní řešení sporů\n\n13.1 text\n\n## 14. Ochrana\n\nx';
  const part = md.extractSections(src, [/^12\./, /^13\./]);
  assert.equal(part, '## 12. Závady a reklamace\n\n12.1 text\n\n### 12.a\n\npod\n\n## 13. Mimosoudní řešení sporů\n\n13.1 text\n');
  const r = md.render(src, {}, { only: [/^12\./, /^13\./] });
  assert.ok(!/Vrácení|Ochrana/.test(r.html));
  assert.match(r.html, /<h2 id="12-zavady-a-reklamace">/);
  assert.match(r.html, /<h3 id="12-a">/);
});

test('collectPlaceholders a isTruthy', () => {
  assert.deepEqual(md.collectPlaceholders('{{B}} {{#A}}x{{/A}} {{^C}}y{{/C}} {{B}}'), ['A', 'B', 'C']);
  assert.equal(md.isTruthy('ano'), true);
  assert.equal(md.isTruthy('Ne'), false);
  assert.equal(md.isTruthy(0), false);
  assert.equal(md.isTruthy(5), true);
  assert.equal(md.isTruthy({}), true);
  assert.equal(md.isTruthy(undefined), false);
});

test('kombinovaný dokument (vzorek OP) se vyrenderuje bez {{ a bez interních částí', () => {
  const src = [
    '# Obchodní podmínky půjčovny kol s online rezervací – návrh',
    '',
    '> **Návrh připravený jako podklad; před použitím vyžaduje kontrolu advokátem.**',
    '',
    '## Parametry',
    '',
    '| Parametr | Význam |',
    '|---|---|',
    '| `{{PUJCOVNA_NAZEV}}` | firma |',
    '',
    '---',
    '',
    '# Obchodní podmínky půjčovny kol {{PUJCOVNA_NAZEV}}',
    '',
    '## 1. Kdo jsme',
    '',
    '1.1 Kola pronajímá **{{PUJCOVNA_NAZEV}}**, IČO {{PUJCOVNA_ICO}}.',
    '',
    '> **[VARIANTA A – plátce DPH ({{PLATCE_DPH}} = ano)]** Jsme plátci DPH, DIČ {{PUJCOVNA_DIC}}.',
    '',
    '## 6. Storno',
    '',
    '{{STORNO_TABULKA}}',
    '',
    '## K ověření advokátem',
    '',
    '1. bod {{HODNOTA_KOLA}}',
  ].join('\n');
  const r = md.render(src, { PUJCOVNA_NAZEV: 'U Tří dubů s.r.o.', PUJCOVNA_ICO: '00000000', PLATCE_DPH: 'ano', PUJCOVNA_DIC: 'CZ00000000' }, { cancellation: { freeHoursBefore: 48 } });
  assert.ok(!r.html.includes('{{'), r.html);
  assert.ok(!/Parametry|K ověření|Návrh připravený/.test(r.html));
  assert.match(r.html, /<h1 id="obchodni-podminky-pujcovny-kol-u-tri-dubu-s-r-o">Obchodní podmínky půjčovny kol U Tří dubů s\.r\.o\.<\/h1>/);
  assert.match(r.html, /<blockquote><p><strong>\[VARIANTA A – plátce DPH \(ano = ano\)\]<\/strong> Jsme plátci DPH, DIČ CZ00000000\.<\/p><\/blockquote>/);
  assert.deepEqual(r.missing, []);
  assert.equal(r.title, 'Obchodní podmínky půjčovny kol s online rezervací – návrh');
});
