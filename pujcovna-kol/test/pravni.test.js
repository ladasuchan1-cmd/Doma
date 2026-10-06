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
  // otevírací doba z adminu (settings.openingHours, null = zavřeno) přepisuje tenant.json
  const closedMon = pravni.legalParams(tenant, { ...tenant.settings, openingHours: { mon: null, sat: ['10:00', '16:00'] } });
  assert.equal(closedMon.OTEVIRACI_DOBA, 'Po zavřeno, Út–Pá 9:00–18:00, So 10:00–16:00, Ne 8:00–19:00');
  assert.equal(pravni.openingHoursText({ mon: ['09:00', '18:00'] }), 'Po 9:00–18:00, Út–Ne zavřeno');
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
  // údaj za rok 2024 musí mít rok i odkaz na primární zdroj (Statistické přehledy kriminality PČR), QA nález
  assert.match(op.html, /v roce 2024 celkem 3 971 krádeží/, 'ověřený údaj 2024');
  assert.match(op.html, /<a href="https:\/\/archiv\.policie\.gov\.cz\/clanek\/statisticke-prehledy-kriminality-za-rok-2024\.aspx"[^>]*>2024<\/a>/, 'odkaz na Statistické přehledy kriminality 2024');
  assert.ok(!/ztrojnásobil|v roce 2010/.test(op.html), 'pražské údaje 2010–2014 nejsou v celostátním srovnání');
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

test('šablony bez editorských značek: všech 5 dokumentů bez [VARIANTA / [při / [Volitelné / [ONLINE / [NA MÍSTĚ / {{ / …………; varianty řídí booleovské parametry', () => {
  const MARKERS = ['[VARIANTA', '[při', '[Volitelné', '[ONLINE', '[NA MÍSTĚ', '[E-KOLO', '[jen ', '[Výchozí', '{{', '(opakuje se', '= ano', '= ne', '> 0'];
  // údaje rezervace / protokolu a smlouvy s provozovatelem doplňuje admin – pro test je vyplníme testovacími hodnotami
  const filled = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' && v.includes(pravni.BLANK) ? `TEST-${k}` : v]));
  for (const doc of pravni.LEGAL_DOCS) {
    const r = pravni.renderLegal(doc, filled);
    assert.deepEqual(r.missing, [], doc);
    for (const m of MARKERS) assert.ok(!r.html.includes(m), `${doc}: zbylá značka „${m}“`);
    assert.ok(!r.html.includes(pravni.BLANK), `${doc}: „…………“ s vyplněnými údaji`);
  }
  // veřejné dokumenty jsou bez „…………“ už s holými demo parametry (nic nedoplňuje admin)
  for (const doc of ['obchodni-podminky', 'zasady-ochrany-osobnich-udaju']) assert.ok(!pravni.renderLegal(doc, params).html.includes(pravni.BLANK), `${doc}: „…………“`);
  // booleovské parametry odvozené z nastavení dema
  assert.equal(params.EVIDENCE_UCETNICTVI, 'ano');
  assert.equal(params.DOKLAD_ZJEDNODUSENY, 'ano');
  assert.equal(params.ANALYTIKA, 'ne');
  assert.equal(params.PODPIS_OBRAZOVKA, 'ano');
  assert.equal(params.DOKLAD_CISLO_PLNE, 'ne');
  assert.equal(params.POJISTOVNA_UVEDENA, 'ne');
  assert.equal(params.POPLATEK_NABITI_UCTUJEME, 'ne');
  assert.equal(params.SMLOUVA_REZIM, 'online');
  assert.equal(params.SMLOUVA_NA_MISTE, 'ne');
  assert.equal(params.KOLA, 'ano');

  // plátce (demo) vs. neplátce s daňovou evidencí
  const op = pravni.renderLegal('obchodni-podminky', params).html;
  assert.match(op, /<blockquote><p>Jsme plátci DPH, DIČ CZ00000000\.<\/p><\/blockquote>/);
  assert.ok(!/Nejsme plátci DPH/.test(op));
  assert.ok(!/Platba na místě|zaplatím na místě/.test(op), 'čl. 3.6 se bez PLATBA_NA_MISTE_POVOLENA nezobrazí');
  assert.ok(!/Elektrokolo s baterií pod 20 %/.test(op), 'řádek o nabití bez paušálu zmizí');
  assert.match(op, /Nájemné za nevyužitou dobu se nevrací/);
  assert.ok(!/Nájemné za celé nevyužité dny vracíme/.test(op));
  const np = pravni.legalParams({ ...tenant, business: { ...tenant.business, legalName: 'Jan Novák', vatPayer: false, register: undefined } }, { ...tenant.settings, allowPayOnSite: true, chargingFlatMinor: 15000, earlyReturnRefund: true });
  assert.equal(np.EVIDENCE_UCETNICTVI, 'ne');
  const opNp = pravni.renderLegal('obchodni-podminky', np).html;
  assert.match(opNp, /<blockquote><p>Nejsme plátci DPH\.<\/p><\/blockquote>/);
  assert.ok(!/DIČ|Jsme plátci DPH|včetně DPH/.test(opNp));
  assert.match(opNp, /zaplatím na místě/);
  assert.match(opNp, new RegExp(`<td>Elektrokolo s baterií pod 20 %</td><td>paušál za nabití ${format.money(15000)}</td>`));
  assert.match(opNp, /Nájemné za celé nevyužité dny vracíme/);
  const zas = pravni.renderLegal('zasady-ochrany-osobnich-udaju', params).html;
  assert.match(zas, /IČO 00000000, DIČ CZ00000000/);
  assert.match(zas, /<td>Daňové doklady \(daňový doklad k přijaté platbě/);
  assert.match(zas, /<td>Účetní doklady a záznamy<\/td>/);
  assert.match(zas, /zjednodušený daňový doklad/);
  assert.match(zas, /není cookie lišta/);
  assert.ok(!/__Host-souhlas|analyticke-cookies|Analytické cookies<\/h3>/.test(zas), 'bez analytiky žádná cookie lišta');
  assert.match(zas, /zpracováváme v Evropské unii\.<\/strong>/);
  assert.match(zas, /kola nemají GPS/);
  assert.match(zas, /<strong>Podpis na obrazovce\.<\/strong>/);
  assert.ok(!/Listinné protokoly\.<\/strong>/.test(zas));
  assert.ok(!/<td>11<\/td>/.test(zas), 'řádek 11 (GPS) se bez lokátorů nezobrazí');
  const zasNp = pravni.renderLegal('zasady-ochrany-osobnich-udaju', np).html;
  assert.ok(!/<td>Daňové doklady \(daňový/.test(zasNp));
  assert.match(zasNp, /a daňová evidence<\/td>/);
  assert.ok(!/IČO 00000000, DIČ/.test(zasNp));
  // zapnutá analytika, GPS, pojišťovna, papírový podpis s plným číslem
  const an = pravni.legalParams(tenant, { ...tenant.settings, analyticsTool: 'Matomo', analyticsProvider: 'InnoCraft', gpsTrackers: true, insurance: 'Pojišťovna XY', signatureMode: 'papir', idDocPrint: 'plne', secondIdDoc: true, recordBirthAddress: true });
  assert.equal(an.ANALYTIKA, 'ano');
  const zasAn = pravni.renderLegal('zasady-ochrany-osobnich-udaju', an).html;
  assert.match(zasAn, /<h3 id="analyticke-cookies">Analytické cookies<\/h3>/);
  assert.match(zasAn, /__Host-souhlas/);
  assert.match(zasAn, /analytické cookies nástroje Matomo/);
  assert.ok(!/není cookie lišta/.test(zasAn));
  assert.match(zasAn, /<td>11<\/td><td><strong>Sledování polohy kola lokátorem<\/strong>/);
  assert.match(zasAn, /<strong>Pojišťovna XY<\/strong> – pojišťovna/);
  assert.match(zasAn, /<strong>Listinné protokoly\.<\/strong> Smlouvu o nájmu a protokoly podepisujeme na papíře ve dvou vyhotoveních; na výtisku je číslo dokladu uvedeno celé\./);
  assert.match(zasAn, /<td><strong>Druhý doklad<\/strong><\/td>/);
  assert.match(zasAn, /<td><strong>Datum narození a adresa bydliště<\/strong><\/td>/);
  const zz = pravni.renderLegal('zaznam-o-cinnostech-zpracovani', an).html;
  assert.match(zz, /<h4 id="a10-mereni-navstevnosti-webu">A10 – Měření návštěvnosti webu<\/h4>/);
  assert.match(zz, /<td>A10<\/td><td>Měření návštěvnosti webu nástrojem Matomo<\/td>/);
  assert.ok(!/A10 – Měření/.test(pravni.renderLegal('zaznam-o-cinnostech-zpracovani', params).html));
  // smlouva: online/na místě, obrazovka/papír, kauce hotově, vrácení bez nájemce, e-kolo řádky
  const sm = pravni.renderLegal('smlouva-o-najmu-a-predavaci-protokol', params).html;
  assert.match(sm, /2\.3 Smlouva vznikla potvrzením vaší rezervace/);
  assert.match(sm, /7\.2 Smlouvu podepisujete na obrazovce/);
  assert.match(sm, /IČO 00000000, DIČ CZ00000000, sídlo/);
  assert.ok(!/Displej \/ ovladač|zaškolení<\/strong> k elektrokolu|Protokol podepisuje jen obsluha|Účet pro vrácení kauce, nebude-li/.test(sm));
  assert.match(sm, /<td>včetně DPH<\/td>/);
  const smNa = pravni.renderLegal('smlouva-o-najmu-a-predavaci-protokol', { ...np, SMLOUVA_NA_MISTE: 'ano', PODPIS_OBRAZOVKA: 'ne', KAUCE_HOTOVE: 'ano', VRACENI_BEZ_NAJEMCE: 'ano', KOLO_JE_EKOLO: 'ano' }).html;
  assert.match(smNa, /2\.3 Rezervaci č\. ………… jsme založili na výdejním místě/);
  assert.ok(!/Smlouva vznikla potvrzením/.test(smNa));
  assert.match(smNa, /7\.2 Smlouva je vyhotovena ve dvou stejnopisech/);
  assert.match(smNa, /Účet pro vrácení kauce, nebude-li možné/);
  assert.match(smNa, /Protokol podepisuje jen obsluha/);
  assert.match(smNa, /Displej \/ ovladač/);
  assert.match(smNa, /<td>nejsme plátci DPH<\/td>/);
  assert.match(smNa, /Konečné vyúčtování č\./);
  assert.ok(!/Konečný daňový doklad č\./.test(smNa));
  // cyklus přes kola: pole KOLA → řádek B.1, B.2, C.2 a tabulka B.3 pro každé kolo
  const kola = [
    { KOLO_PORADI: '1', KOLO_TYP: 'Trek <FX>', KOLO_INVENTARNI_KOD: 'TK-07', KOLO_JE_EKOLO: 'ne' },
    { KOLO_PORADI: '2', KOLO_TYP: 'Cube e', KOLO_INVENTARNI_KOD: 'EK-02', KOLO_JE_EKOLO: 'ano', KOLO_BATERIE_PROCENTA: '80', KOLO_VRACENI_BATERIE_PROCENTA: '55' },
  ];
  const smK = pravni.renderLegal('smlouva-o-najmu-a-predavaci-protokol', { ...params, KOLA: kola }).html;
  assert.equal((smK.match(/<td>TK-07<\/td>/g) || []).length, 2, 'B.1 + C.2');
  assert.equal((smK.match(/<td>EK-02<\/td>/g) || []).length, 2);
  assert.match(smK, /<td>Trek &lt;FX&gt;<\/td>/);
  assert.equal((smK.match(/Kontrolovaná část/g) || []).length, 2, 'B.3 pro každé kolo');
  assert.equal((smK.match(/Displej \/ ovladač/g) || []).length, 1, 'e-kolo řádky jen u elektrokola');
  assert.match(smK, /Baterie – nabití 80 %/);
  assert.match(smK, /<td>55 %<\/td>/);
  // výřez protokolu B (documents.js) s polem funguje stejně
  const onlyB = pravni.renderLegal('smlouva-o-najmu-a-predavaci-protokol', { ...params, KOLA: kola }, { only: [/^ČÁST B/, /^B\.\d/] }).html;
  assert.equal((onlyB.match(/<td>EK-02<\/td>/g) || []).length, 1);
  assert.ok(!/ČÁST A|ČÁST C/.test(onlyB));
});

test('nadpisy mají stabilní id (slug) – kotvy pro rezervaci: /podminky#8-prevzeti-kola, /soukromi#3-proc-udaje-zpracovavame-a-na-jakem-pravnim-zaklade', () => {
  const op = pravni.renderLegal('obchodni-podminky', params);
  const ids = op.headings.filter((h) => h.level === 2).map((h) => h.id);
  assert.deepEqual(ids.slice(0, 3), ['1-kdo-jsme-a-jak-nas-kontaktovat', '2-co-tyto-podminky-upravuji', '3-rezervace-a-uzavreni-smlouvy']);
  assert.ok(ids.includes('8-prevzeti-kola'));
  assert.ok(ids.includes('6-storno-a-zmeny-rezervace-zruseni-z-nasi-strany'));
  assert.ok(ids.includes('12-zavady-a-reklamace') && ids.includes('13-mimosoudni-reseni-sporu'));
  assert.match(op.html, /<h2 id="8-prevzeti-kola">/);
  const zas = pravni.renderLegal('zasady-ochrany-osobnich-udaju', params);
  const zids = zas.headings.filter((h) => h.level === 2).map((h) => h.id);
  assert.ok(zids.includes('3-proc-udaje-zpracovavame-a-na-jakem-pravnim-zaklade'));
  assert.ok(zids.includes('2-jake-udaje-zpracovavame') && zids.includes('7-cookies-a-podobne-technologie'));
  // id nezávisí na variantě (plátce / neplátce, analytika)
  const np = pravni.legalParams({ ...tenant, business: { ...tenant.business, legalName: 'Jan Novák', vatPayer: false, register: undefined } }, { ...tenant.settings, analyticsTool: 'Matomo' });
  assert.deepEqual(pravni.renderLegal('obchodni-podminky', np).headings.filter((h) => h.level === 2).map((h) => h.id), ids);
  assert.deepEqual(pravni.renderLegal('zasady-ochrany-osobnich-udaju', np).headings.filter((h) => h.level === 2).map((h) => h.id), zids);
  assert.equal(md.slugify('8. Převzetí kola'), '8-prevzeti-kola');
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
  assert.match(op, /<h2 id="8-prevzeti-kola">/);
  for (const m of ['[VARIANTA', '[při', '[Volitelné', '[ONLINE', '[NA MÍSTĚ', pravni.BLANK]) assert.ok(!op.includes(m), `/podminky: „${m}“`);
  assert.match(op, /Verze 1\.0, účinná od 5\. 10\. 2026/);
  assert.match(op, /neplatne-doklady/);
  assert.match(op, /nejméně 48 hodin před začátkem nájmu/);
  const zas = await (await srv.fetch('/soukromi')).text();
  assert.match(zas, /<title>Ochrana osobních údajů · Půjčovna kol U Tří dubů<\/title>/);
  assert.match(zas, /Stručně na úvod/);
  assert.match(zas, /U Tří dubů s\.r\.o\./);
  assert.match(zas, /<h2 id="3-proc-udaje-zpracovavame-a-na-jakem-pravnim-zaklade">/);
  for (const m of ['[VARIANTA', '[při', '[Volitelné', '[jen ', '[Výchozí', pravni.BLANK]) assert.ok(!zas.includes(m), `/soukromi: „${m}“`);
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

test('otevírací doba z adminu (pondělí zavřeno) se propíše do /podminky (OTEVIRACI_DOBA) i kontaktní karty na /reklamace', async () => {
  const { setSetting } = require('../src/tenants');
  const nb = (s) => s.replace(/ /g, ' ');
  const before = nb(await (await srv.fetch('/podminky')).text());
  assert.match(before, /otevírací doba Po–Pá 9:00–18:00, So–Ne 8:00–19:00/);
  setSetting(srv.db, 'openingHours', { ...tenant.openingHours, mon: null });
  try {
    const op = nb(await (await srv.fetch('/podminky')).text());
    assert.match(op, /otevírací doba Po zavřeno, Út–Pá 9:00–18:00, So–Ne 8:00–19:00/, 'čl. 1.2 s dobou z adminu');
    assert.ok(!/Po–Pá 9:00–18:00, So–Ne 8:00–19:00/.test(op), 'stará doba nikde (ani v patičce)');
    const rek = nb(await (await srv.fetch('/reklamace')).text());
    assert.match(rek, /<dt>Po<\/dt><dd>zavřeno<\/dd>/, 'kontaktní karta „Kde reklamaci uplatnit“');
  } finally {
    srv.db.prepare("DELETE FROM settings WHERE key = 'openingHours'").run();
  }
  assert.match(nb(await (await srv.fetch('/podminky')).text()), /otevírací doba Po–Pá 9:00–18:00, So–Ne 8:00–19:00/, 'po obnovení výchozí');
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
