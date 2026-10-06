'use strict';
// Testy feature „pravni“: pokrytí placeholderů slovníkem legalParams (všech pět šablon), shodné dvojice,
// renderLegal bez {{ a bez interních sekcí, stránky /podminky, /soukromi, /reklamace (200, bez {{, bez
// interních částí, texty odrážejí rozhodnutí 1–3), demo box jen při PK_DEMO=1, CSS feature.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, ROOT } = require('./helpers');
const { loadTenant } = require('../src/tenants');
const md = require('../src/render/markdown');
const format = require('../src/render/format');
const pravni = require('../src/features/pravni');

const tenant = loadTenant(path.join(ROOT, 'tenants', 'demo'));
const params = pravni.legalParams(tenant, tenant.settings);

test('legalParams zná každý placeholder všech pěti šablon (po odstranění interních částí) a dvojice mají stejnou hodnotu', () => {
  const unknown = [];
  for (const doc of pravni.LEGAL_DOCS) {
    const src = fs.readFileSync(path.join(pravni.LEGAL_DIR, `${doc}.md`), 'utf8');
    const { source } = md.applyTemplate(src, params);
    for (const name of md.collectPlaceholders(source)) if (!Object.hasOwn(params, name)) unknown.push(`${doc}: ${name}`);
  }
  assert.deepEqual(unknown, [], 'chybějící klíče slovníku');
  assert.equal(params.PLATEBNI_BRANA, params.PLATEBNI_BRANA_NAZEV);
  assert.equal(params.BANKA, params.BANKA_NAZEV);
  assert.equal(params.POJISTENI, params.POJISTOVNA_NAZEV);
  // hodnoty z tenant.json / settings
  assert.equal(params.PUJCOVNA_NAZEV, 'U Tří dubů s.r.o.');
  assert.equal(params.PLATCE_DPH, 'ano');
  assert.equal(params.PUJCOVNA_DIC, 'CZ00000000');
  assert.equal(params.WEB_SUBDOMENA, 'ksprehledy.cz');
  assert.equal(params.PODMINKY_URL, 'https://ksprehledy.cz/podminky');
  assert.equal(params.POPLATEK_KOLO, format.money(30000)); // „300 Kč“ s pevnou mezerou
  assert.equal(params.POPLATEK_EKOLO, format.money(50000));
  assert.equal(params.KAUCE_KOLO, format.money(300000));
  assert.equal(params.STORNO_LHUTA_HODIN, '48');
  const plain = (s) => String(s).replace(/ /g, ' '); // format.plural používá pevnou mezeru
  assert.equal(plain(params.DOBA_CISLO_DOKLADU), '30 dní');
  assert.equal(plain(params.DOBA_SMLOUVA), '3 roky');
  assert.equal(plain(params.DOBA_LOGY), '12 měsíců');
  assert.equal(plain(params.DOBA_NEDOKONCENE_REZERVACE), '90 dní');
  assert.equal(plain(params.LHUTA_PLATBY_POPLATKU), '48 hodin od odeslání rezervace; začíná-li nájem dříve než za 48 hodin, do 20:00 dne předcházejícího začátku nájmu');
  assert.equal(params.REZIM_DOKLADU, 'zjednoduseny');
  assert.equal(params.REZIM_EVIDENCE, 'ucetnictvi');
  assert.equal(params.DOKLAD_REZIM, 'A');
  assert.equal(params.UCINNOST_OD, '5. 10. 2026');
  assert.equal(params.VERZE, '1.0');
  assert.match(params.OTEVIRACI_DOBA, /Po–Pá 9:00–18:00, So–Ne 8:00–19:00/);
  assert.match(params.BANKOVNI_UCET, /19-2000145399\/0800, IBAN CZ6508000000192000145399/);
  assert.match(params.PLATEBNI_BRANA, /simulační/);
  // přepis přes tenant.legal.params
  const over = pravni.legalParams({ ...tenant, legal: { ...tenant.legal, params: { PUJCOVNA_REJSTRIK: 'KS v Českých Budějovicích, C 1' } } }, tenant.settings);
  assert.equal(over.PUJCOVNA_REJSTRIK, 'KS v Českých Budějovicích, C 1');
  // neplátce → PLATCE_DPH ne, bez DIČ, živnostenský rejstřík
  const np = pravni.legalParams({ ...tenant, business: { ...tenant.business, legalName: 'Jan Novák', vatPayer: false } }, tenant.settings);
  assert.equal(np.PLATCE_DPH, 'ne');
  assert.equal(np.PUJCOVNA_DIC, '');
  assert.match(np.PUJCOVNA_REJSTRIK, /živnostenském/);
  assert.equal(np.REZIM_EVIDENCE, 'danova-evidence');
});

test('renderLegal: všech pět šablon bez {{ a bez interních sekcí; texty odrážejí rozhodnutí 1–3', () => {
  for (const doc of pravni.LEGAL_DOCS) {
    const r = pravni.renderLegal(doc, params);
    assert.deepEqual(r.missing, [], doc);
    assert.ok(!r.html.includes('{{'), `${doc}: nerozvinutý placeholder`);
    assert.ok(!/<h[1-6][^>]*>(Parametry|K ověření advokátem|Příloha pro advokáta)/.test(r.html), `${doc}: interní sekce`);
    assert.ok(!/Návrh připravený jako podklad|Jak číst návrh/.test(r.html), `${doc}: rámeček / poznámky k návrhu`);
    // veřejné dokumenty nesmí na interní oddíl ani odkazovat (smlouva v části D a zpracovatelská smlouva na něj odkazují záměrně)
    if (doc === 'obchodni-podminky' || doc === 'zasady-ochrany-osobnich-udaju') assert.ok(!/K ověření advokátem/.test(r.html), `${doc}: odkaz na interní oddíl`);
    assert.ok(!/DOKLAD-B|bez-cisla|VARIANTA DOKLAD-A/.test(r.html), `${doc}: varianta B dokladu`);
    assert.ok(!/<script|javascript:/i.test(r.html), doc);
  }
  const op = pravni.renderLegal('obchodni-podminky', params);
  assert.match(op.html, /<h1 id="obchodni-podminky-pujcovny-kol-u-tri-dubu-s-r-o">/);
  assert.match(op.html, /aplikace\.mvcr\.cz\/neplatne-doklady/, 'odkaz na Databázi neplatných dokladů MV ČR');
  assert.match(op.html, /Policie ČR/, 'statistika Policie ČR');
  assert.match(op.html, /archiv\.policie\.gov\.cz/, 'zdroj statistiky s URL');
  assert.match(op.html, /nejméně 48 hodin před začátkem nájmu<\/td><td>100 %/, 'storno tabulka ze settings');
  assert.match(op.html, /úplat\w+ za zajištění/, 'poplatek = úplata za zajištění služby');
  assert.match(op.html, /zjednodušený daňový doklad/i);
  assert.match(op.html, /10 000 Kč/);
  assert.equal((op.html.match(/<table/g) || []).length >= 3, true);
  assert.ok(!/72 hodin/.test(op.html), 'stará třístupňová storno tabulka zmizela');
  const zas = pravni.renderLegal('zasady-ochrany-osobnich-udaju', params);
  assert.match(zas.html, /neplatne-doklady/);
  assert.match(zas.title, /^Zásady ochrany osobních údajů půjčovny U Tří dubů s\.r\.o\./);
  // smlouva: části A–D, volitelně bez části D
  const sml = pravni.renderLegal('smlouva-o-najmu-a-predavaci-protokol', params);
  assert.match(sml.html, /ČÁST A/);
  assert.match(sml.html, /ČÁST D/);
  const bezD = pravni.renderLegal('smlouva-o-najmu-a-predavaci-protokol', { ...params, NAJEMCE_JMENO: 'Jana <Nováková>' }, { omitHeadings: [/^ČÁST D/] });
  assert.ok(!/ČÁST D/.test(bezD.html));
  assert.match(bezD.html, /Jana &lt;Nováková&gt;/);
  assert.throws(() => pravni.renderLegal('neexistuje', params), /Neznámý právní dokument/);
});

let srv;
test.before(async () => {
  srv = await startServer();
});
test.after(async () => {
  if (srv) await srv.stop();
});

test('/podminky, /soukromi, /reklamace: 200 v layoutu, bez {{, bez interních částí, CSS feature, demo box', async () => {
  for (const p of ['/podminky', '/soukromi', '/reklamace']) {
    const res = await srv.fetch(p);
    assert.equal(res.status, 200, p);
    const html = await res.text();
    assert.ok(!html.includes('{{'), `${p}: nerozvinutý placeholder`);
    assert.ok(!/K ověření advokátem|Návrh připravený jako podklad|>Parametry</.test(html), `${p}: interní část`);
    assert.match(html, /<link rel="stylesheet" href="\/css\/pravni.css\?v=test">/, p);
    assert.match(html, /<article class="legal">/, p);
    assert.match(html, /<aside class="legal-demo" role="note">Demo: tento text je návrh k advokátní kontrole, verze 1\.0\./, p);
    assert.ok(!/ style="/.test(html), `${p}: inline style`);
    assert.ok(!/<script>/.test(html), `${p}: inline script`);
    assert.match(html, /<footer class="site-footer">/, p);
  }
  const op = await (await srv.fetch('/podminky')).text();
  assert.match(op, /<title>Obchodní podmínky · Půjčovna kol U Tří dubů<\/title>/);
  assert.match(op, /<h1 class="section__title">Obchodní podmínky půjčovny kol U Tří dubů s\.r\.o\.<\/h1>/);
  assert.equal((op.match(/<h1\b/g) || []).length, 1, 'jediný h1');
  assert.match(op, /<nav class="legal-toc"/);
  assert.match(op, /href="#8-prevzeti-kola"/);
  assert.match(op, /Verze 1\.0, účinná od 5\. 10\. 2026/);
  assert.match(op, /neplatne-doklady/);
  assert.match(op, /nejméně 48 hodin před začátkem nájmu/);
  const zas = await (await srv.fetch('/soukromi')).text();
  assert.match(zas, /<title>Ochrana osobních údajů · Půjčovna kol U Tří dubů<\/title>/);
  assert.match(zas, /Stručně na úvod/);
  assert.match(zas, /U Tří dubů s\.r\.o\./);
  const rek = await (await srv.fetch('/reklamace')).text();
  assert.match(rek, /<h2 id="12-zavady-a-reklamace">/);
  assert.match(rek, /<h2 id="13-mimosoudni-reseni-sporu">/);
  assert.ok(!/8\. Převzetí kola|14\. Ochrana osobních údajů/.test(rek), 'výřez jen čl. 12–13');
  assert.match(rek, /coi\.gov\.cz/);
  assert.match(rek, /<div class="contact-card">/);
  assert.match(rek, /info@ksprehledy\.cz/);
  assert.match(rek, /výňatek z dokumentu <a href="\/podminky">Obchodní podmínky<\/a>/);
  const css = await srv.fetch('/css/pravni.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.match(await css.text(), /\.legal-demo/);
});

test('mimo demo režim se demo box nezobrazí, stránky dál fungují', async () => {
  const prod = await startServer({ env: { PK_DEMO: '0', PK_ADMIN_PASSWORD: 'tajne-heslo-123' } });
  try {
    for (const p of ['/podminky', '/soukromi', '/reklamace']) {
      const res = await prod.fetch(p, { headers: { host: 'ksprehledy.cz' } });
      assert.equal(res.status, 200, p);
      const html = await res.text();
      assert.ok(!/legal-demo/.test(html), `${p}: demo box mimo demo`);
      assert.ok(!html.includes('{{'), p);
    }
  } finally {
    await prod.stop();
  }
});
