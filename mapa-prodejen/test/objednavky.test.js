'use strict';
// Testy zpracování objednávek a zákazníků (lib/objednavky.js): rozpoznání sloupců a tabulek (i kontingenčních
// tabulek vložených z Excelu), PSČ, částky, data, součty, přiřazení k obcím, zahraničí, ochrana osobních údajů.
const test = require('node:test');
const assert = require('node:assert');
const o = require('../lib/objednavky.js');
const csv = require('../lib/csv.js');
const fx = require('./fixtures/excel-tabulky.js');
const obce = require('./fixtures/obce.js');

const IX = o.indexObci(obce.OBCE, null);
const obec = (n) => {
  const z = o.najdiZaznamObce(n, IX);
  return z ? `${z.nazev} ${z.okres}` : null;
};
const zpracuj = (text, opts) => o.zpracovat(csv.parse(text), { pscData: fx.PSC, obecIndex: fx.OBCE, velkaMesta: fx.VELKA, meta: { nahrano: '2026-01-01T00:00:00.000Z' }, ...opts });
const misto = (ds, psc) => ds.mista.find((x) => x.psc === psc);

test('rozpoznání sloupců – doručovací PSČ má přednost před fakturačním', () => {
  const rows = [['Export objednávek'], [], ['Číslo objednávky', 'Datum vytvoření', 'Fakturační PSČ', 'Dodací PSČ', 'Dodací město', 'Země', 'Cena bez DPH', 'Celkem s DPH', 'Stav']];
  const d = o.detectColumns(rows);
  assert.strictEqual(d.hlavicka, 2);
  assert.deepStrictEqual(d.sloupce, { psc: 3, mesto: 4, zeme: 5, datum: 1, castka: 7, stav: 8, id: 0 });
  const agg = o.detectColumns([['PSČ', 'Počet objednávek']]);
  assert.deepStrictEqual(agg.sloupce, { psc: 0, pocet: 1 });
  assert.strictEqual(o.detectColumns([['a', 'b']]).hlavicka, -1);
});

test('záhlaví kontingenčních tabulek – zákazníci, aktivní, objednávky, hodnota; průměr a číslo objednávky ne', () => {
  const m = (cells) => o.mapHeader(cells.map(o.fold));
  assert.deepStrictEqual(m(['Obec (sjednoc.)', 'Zákazníků', 'Z toho aktivních']), { mesto: 0, zak: 1, akt: 2 });
  assert.deepStrictEqual(m(['Obec', 'Aktivních zákazníků', 'Objednávek od 2024', 'Hodnota obj. od 2024 (Kč)']), { mesto: 0, akt: 1, pocet: 2, castka: 3 });
  assert.deepStrictEqual(m(['Obec', 'Počet objednávek', 'Hodnota objednávek (Kč)', 'Průměrná objednávka (Kč)']), { mesto: 0, pocet: 1, castka: 2 });
  assert.deepStrictEqual(m(['Číslo objednávky', 'PSČ']), { psc: 1, id: 0 });
  assert.deepStrictEqual(m(['Obec', '2025', '2026', 'Celkový součet']), { mesto: 0, soucet: 3 });
  // sloupec „Zákazník“ s textem (jméno) není počet zákazníků
  const b = o.rozpoznat(csv.parse('Zákazník;Město;PSČ\nJan Novák;Brno;602 00\nEva Malá;Praha;160 00\n'));
  assert.deepStrictEqual(b[0].sloupce, { psc: 2, mesto: 1 });
});

test('PSČ, prázdné hodnoty, země, částky a data', () => {
  assert.strictEqual(o.normPsc('602 00'), '60200');
  assert.strictEqual(o.normPsc(60200), '60200');
  assert.strictEqual(o.normPsc('CZ-11000'), '11000');
  assert.strictEqual(o.normPsc('811 01'), null); // Slovensko
  assert.strictEqual(o.normPsc('1100'), null);
  assert.deepStrictEqual(o.pscForma('160 00'), { forma: 'cz', kod: '16000' });
  assert.deepStrictEqual(o.pscForma('851 01'), { forma: 'cizi', kod: '85101' });
  assert.deepStrictEqual(o.pscForma('02-972'), { forma: 'cizi', kod: '02972' }); // Polsko
  assert.deepStrictEqual(o.pscForma('30-001'), { forma: 'cizi', kod: '30001' }); // Krakov, ne Plzeň
  assert.deepStrictEqual(o.pscForma('SK-81101'), { forma: 'cizi', kod: '81101' });
  assert.deepStrictEqual(o.pscForma('1200'), { forma: '4', kod: '1200' });
  assert.deepStrictEqual(o.pscForma('101'), { forma: 'jine', kod: '101' });
  assert.deepStrictEqual(o.pscForma('(neuvedeno)'), { forma: '', kod: '' });
  for (const v of ['(neuvedeno)', '(prázdné)', '??????', '-', '', null]) assert.ok(o.jePrazdne(v), String(v));
  assert.ok(!o.jePrazdne('Praha'));
  assert.ok(o.jeCesko(''));
  assert.ok(o.jeCesko('Česká republika'));
  assert.ok(o.jeCesko('CZ'));
  assert.ok(!o.jeCesko('Slovensko'));
  assert.strictEqual(o.normCastka('12 345,50 Kč'), 12345.5);
  assert.strictEqual(o.normCastka('15 743 032'), 15743032);
  assert.strictEqual(o.normCastka('1 200'), 1200);
  assert.strictEqual(o.normCastka('1 200,5 Kč'), 1200.5);
  assert.strictEqual(o.normCastka('1.234,5'), 1234.5);
  assert.strictEqual(o.normCastka('1,234.5'), 1234.5);
  assert.strictEqual(o.normCastka(99), 99);
  assert.strictEqual(o.normCastka('zdarma'), null);
  assert.strictEqual(o.normDatum('14.03.2025'), '2025-03-14');
  assert.strictEqual(o.normDatum('4. 3. 2025 10:22'), '2025-03-04');
  assert.strictEqual(o.normDatum('2025-03-14T10:00:00'), '2025-03-14');
  assert.strictEqual(o.normDatum(45730), '2025-03-14');
  assert.strictEqual(o.normDatum('včera'), null);
});

test('obec podle názvu – části velkých měst, okresy, zahraniční města a jmenovci', () => {
  const najdi = (n) => o.najdiObec(n, fx.OBCE, fx.VELKA);
  assert.strictEqual(najdi('Praha 4 - Libuš'), '14200');
  assert.strictEqual(najdi('Praha5-Radotín'), '14200');
  assert.strictEqual(najdi('Hlavní město Praha'), '14200');
  assert.strictEqual(najdi('Prague 6'), '14200');
  assert.strictEqual(najdi('Ostrava-Poruba'), '70030');
  assert.strictEqual(najdi('Liberec XXV'), '46001');
  assert.strictEqual(najdi('Teplice (okres Teplice)'), '41501');
  assert.strictEqual(najdi('Teplice, Česká republika'), '41501');
  assert.strictEqual(najdi('Brno-venkov'), null); // okres, ne město
  assert.strictEqual(najdi('Praha-východ'), null);
  assert.strictEqual(najdi('Most pri Bratislave'), null); // slovenská obec, ne Most
  for (const n of ['Košice', 'Kosice', 'Žilina', 'Modra', 'Brezno', 'Wien', 'Berlin', 'Warszawa', 'Komárno']) assert.ok(o.jeCiziMesto(n), n);
  for (const n of ['Modrá', 'Březno', 'Praha', 'Kolín', 'Most']) assert.ok(!o.jeCiziMesto(n), n);
});

test('obec podle názvu – starší a poštovní přívlastky, vodítko „u …“, okres, oblast, řeka', () => {
  assert.strictEqual(obec('Říčany u Prahy'), 'Říčany 3209');
  assert.strictEqual(obec('Říčany u Brna'), 'Říčany 3703'); // jmenovec u Brna, ne větší Říčany u Prahy
  assert.strictEqual(obec('Jesenice u Prahy'), 'Jesenice 3210');
  assert.strictEqual(obec('Roztoky u Křivoklátu'), 'Roztoky 3212'); // ta blízko vodítka, i když je menší
  assert.strictEqual(obec('Zbýšov u Brna'), 'Zbýšov 3703'); // dva Zbýšovy skoro stejně daleko od Brna → větší
  assert.strictEqual(obec('Hranice u Aše'), 'Hranice 3402');
  assert.strictEqual(obec('Vřesina u Bílovce'), 'Vřesina 3807');
  assert.strictEqual(obec('Benešov u Prahy'), 'Benešov 3201'); // 37 km od středu Prahy
  assert.strictEqual(obec('Kozmice okr. Benešov'), 'Kozmice 3201');
  assert.strictEqual(obec('Zábřeh na Moravě'), 'Zábřeh 3809');
  assert.strictEqual(obec('Hlinsko v Čechách'), 'Hlinsko 3603');
  assert.strictEqual(obec('Ostrov nad Ohří'), 'Ostrov 3403'); // ze šesti Ostrovů ten u obcí „nad Ohří“
  assert.strictEqual(obec('Rožnov pod Rahoštěm'), 'Rožnov pod Radhoštěm 3810'); // překlep, ne Rožnov u Náchoda
  // bez vodítka se nehádá: pět Starých Měst; Polanka nad Odrou je část Ostravy, ne Polánka u Plzně
  assert.strictEqual(obec('Staré Město pod Sněžníkem'), null);
  assert.strictEqual(obec('Polanka nad Odrou'), null);
});

test('obec podle názvu – zkratky, část názvu se spojovníkem, začátek názvu', () => {
  assert.strictEqual(obec('Frenštát p.R.'), 'Frenštát pod Radhoštěm 3804');
  assert.strictEqual(obec('Č. Budějovice'), 'České Budějovice 3301');
  assert.strictEqual(obec('Uh.Hradiště'), 'Uherské Hradiště 3711');
  assert.strictEqual(obec('Ústí n/L'), 'Ústí nad Labem 3510'); // ne Ústí nad Orlicí
  assert.strictEqual(obec('Jablonec n.N.'), 'Jablonec nad Nisou 3504');
  assert.strictEqual(obec('Brandýs n/L'), 'Brandýs nad Labem-Stará Boleslav 3209');
  assert.strictEqual(obec('Brandýs nad Labem'), 'Brandýs nad Labem-Stará Boleslav 3209');
  assert.strictEqual(obec('Stará Boleslav'), 'Brandýs nad Labem-Stará Boleslav 3209');
  assert.strictEqual(obec('Morkovice'), 'Morkovice-Slížany 3708');
  assert.strictEqual(obec('Frenštát'), 'Frenštát pod Radhoštěm 3804');
  assert.strictEqual(obec('Jablonec'), 'Jablonec nad Nisou 3504'); // 23× větší než Jablonec nad Jizerou
  assert.strictEqual(obec('Jakubov'), null); // jen začátek názvu vesnice (Jakubov u Moravských Budějovic) – nehádá
});

test('obec podle názvu – část obce, číslo obvodu, adresa, čtvrť velkého města, okres', () => {
  assert.strictEqual(obec('Husinec - Řež'), 'Husinec 3209');
  assert.strictEqual(obec('Sušice II'), 'Sušice 3404');
  assert.strictEqual(obec('Tišnov3'), 'Tišnov 3703');
  assert.strictEqual(obec('obec Tišnov'), 'Tišnov 3703');
  assert.strictEqual(obec('TišnovTišnov'), 'Tišnov 3703');
  assert.strictEqual(obec('Nová Ves I -Ohrada'), 'Nová Ves I 3204'); // „I“ patří k úřednímu názvu
  assert.strictEqual(obec('Zbraslav-Praha'), 'Praha 3100'); // pražská čtvrť, ne Zbraslav u Brna
  assert.strictEqual(obec('Holásky, Brno'), 'Brno 3702');
  assert.strictEqual(obec('Studené 55, Jílové u Prahy'), 'Jílové u Prahy 3210'); // ulice s číslem, obec za čárkou
  assert.strictEqual(obec('Jesenice, Praha-západ'), 'Jesenice 3210');
  assert.strictEqual(obec('Moravská Ostrava'), 'Ostrava 3807');
  assert.strictEqual(obec('Ostrava Jih'), 'Ostrava 3807'); // obvod Ostravy (okres „Ostrava-jih“ neexistuje)
  assert.strictEqual(obec('Praha-západ'), null); // okres, ne obec
  assert.strictEqual(obec('Brno-venkov'), null);
});

test('obec podle názvu – slovenské a zahraniční tvary jdou do zahraničí, české ne', () => {
  for (const n of ['Moravany nad Váhom', 'Výčapy-Opatovce', 'Horné Orešany', 'Košice - Peres', 'Bratislava V', 'Martin-Priekopa', 'Divina, okres Žilina', 'Nitra Slovensko', 'Wien - Liesing', 'Gütersloh']) {
    assert.ok(o.jeCiziMesto(n), n);
  }
  // „u Bílovce“ je český 2. pád, „Trnava u Zlína“ česká Trnava, „MÄ?sto“ rozbité kódování slova „Město“
  for (const n of ['Vřesina u Bílovce', 'Trnava u Zlína', 'Říčany u Prahy', 'Ostrava-Poruba', 'MÄ?sto']) assert.ok(!o.jeCiziMesto(n), n);
  assert.strictEqual(obec('Moravany nad Váhom'), null); // ani přímé hledání z něj neudělá moravské Moravany
  assert.strictEqual(obec('Trnava u Zlína'), 'Trnava 3705');
});

test('tabulka jen s obcemi – nové tvary názvů se přiřadí k PSČ, slovenské do zahraničí, nejisté zůstanou', () => {
  const text = ['Obec;Zákazníků', 'Říčany u Prahy;5', 'Frenštát p.R.;3', 'Stará Boleslav;2', 'Moravany nad Váhom;4', 'Staré Město pod Sněžníkem;1'].join('\n');
  const p = o.zpracovat(csv.parse(text), { obecIndex: IX, meta: { nahrano: 'x' } }).prirazeno;
  assert.strictEqual(p.psc['25101'].zak, 5);
  assert.strictEqual(p.psc['74401'].zak, 3);
  assert.strictEqual(p.psc['25001'].zak, 2);
  assert.strictEqual(p.podleNazvu.zak, 10);
  assert.strictEqual(p.zahranici.zak, 4);
  assert.deepStrictEqual(p.neprirazene.map((x) => [x.nazev, x.zak]), [['Staré Město pod Sněžníkem', 1]]);
});

test('export po objednávkách: položky, storno a zahraničí po objednávkách, částka jednou za objednávku', () => {
  const text = [
    'Objednávka;Datum;PSČ;Město;Země;Celkem;Stav',
    '1;01.02.2025;602 00;Brno;CZ;1 000 Kč;Vyřízeno',
    '1;01.02.2025;602 00;Brno;CZ;1 000 Kč;Vyřízeno', // stejná objednávka, celková cena opakovaná
    '2;03.02.2025;602 00;Brno;CZ;500;Vyřízeno',
    '2;03.02.2025;602 00;Brno;CZ;300;Vyřízeno', // položky s vlastní cenou → sečíst
    '3;05.02.2025;110 00;Praha;CZ;200;Stornováno',
    '3;05.02.2025;110 00;Praha;CZ;200;Stornováno',
    '4;06.02.2025;811 01;Bratislava;SK;900;Vyřízeno',
    '5;07.02.2025;;Liberec;CZ;100;Vyřízeno',
    '6;08.02.2025;;;CZ;100;Vyřízeno',
    'Celkem;;;;;3 100;', // řádek součtu na konci exportu
  ].join('\n');
  const rows = csv.parse(text);
  const d = o.detectColumns(rows);
  const s = o.secti(rows, d.sloupce, { odRadku: d.hlavicka + 1 });
  assert.ok(!s.sectene);
  assert.strictEqual(s.storno.n, 1);
  assert.strictEqual(s.bezAdresy.n, 1);
  assert.strictEqual(s.od, '2025-02-01');
  assert.strictEqual(s.do, '2025-02-07');
  const pscData = { 60200: [49.2, 16.6, 3702, 'Brno', 582786], 46001: [50.77, 15.05, 3505, 'Liberec', 563889] };
  const prir = o.priradit(s, pscData, new Map([['liberec', '46001']]));
  assert.deepStrictEqual(prir.psc, { 60200: { n: 2, zak: 0, akt: 0, kc: 1800 }, 46001: { n: 1, zak: 0, akt: 0, kc: 100 } });
  assert.strictEqual(prir.zahranici.n, 1);
  assert.strictEqual(prir.nezarazeno.n, 1);
  const ds = o.dataset(prir, s, { soubor: 'export.csv', kdo: 'lada' });
  assert.strictEqual(ds.objednavek, 3);
  assert.deepStrictEqual(ds.metriky, ['n']);
  assert.strictEqual(ds.nezarazeno, 1);
  assert.strictEqual(ds.zahranici, 1);
  assert.strictEqual(ds.storno, 1);
  assert.deepStrictEqual(ds.mista[0], { psc: '60200', n: 2, kc: 1800 });
});

// Export objednávek z POHODY (tvar podle skutečných exportů, data vymyšlená): Číslo, Celkem, Přeneseno, Obec, PSČ,
// Země, Ceny. Objednávka přenesená na pobočku je tam podruhé s příponou (PHA, BM, LI); z XLSX přijde Přeneseno
// jako „ano“ / „ne“.
const PSC_POHODA = { 60200: [49.19, 16.61, 3702, 'Brno', 582786], 46001: [50.77, 15.05, 3505, 'Liberec', 563889] };
const OBCE_POHODA = new Map([['brno', '60200'], ['liberec', '46001']]);
const POHODA_2026 = [
  ['Číslo', 'Cizí měna', 'Celkem', 'Přeneseno', 'Obec', 'PSČ', 'Země', 'Ceny'],
  ['202602031', null, 1047, 'ne', 'Brno', '602 00', 'ČR', 'Prodejní'],
  ['202602031PHA', null, 1047, 'ano', 'Brno', '602 00', 'ČR', 'Prodejní'], // kopie na pobočce
  ['202602032', null, 500, 'ne', 'Brno', '602 00', 'ČR', 'Prodejní'],
  ['202602032BM', null, 650, 'ano', 'Brno', '602 00', 'ČR', 'Prodejní'], // jiná částka → platí přenesená
  ['202602033', null, 200, 'ne', null, null, 'ČR', 'Prodejní'],
  ['202602033LI', null, 200, 'ano', 'Liberec', '460 01', 'ČR', 'Prodejní'], // adresu má jen kopie
  ['202602034', null, 300, 'ne', 'Brno', '602 00', 'ČR', 'VIP CENY'], // nepřenesená, bez kopie
  ['202602035', null, 100, 'ano', 'Brno', '602 00', 'ČR', 'Prodejní'],
  ['202602035', null, 100, 'ne', 'Brno', '602 00', 'ČR', 'Prodejní'], // stejné číslo, liší se jen v Přeneseno
  ['202602036', 'EUR', 1300, 'ano', 'Wien', '1030', 'AT', 'Prodejní'],
  ['WSAT2600001', null, 2261, 'ano', null, null, 'ČR', 'Prodejní'], // prodej na prodejně bez adresy
  ['26TEP00001', null, 450, 'ano', null, null, 'ČR', 'Prodejní'], // jiná řada dokladů – každý zvlášť
  ['26TEP00002', null, 700, 'ano', null, null, 'ČR', 'Prodejní'],
];

test('export z POHODY: „Číslo“, kopie s příponou pobočky a řádky lišící se jen v Přeneseno se počítají jednou', () => {
  assert.strictEqual(o.zakladCisla('202602031PHA'), '202602031');
  assert.strictEqual(o.zakladCisla('202502029LI'), '202502029');
  for (const c of ['WSAT2600001', '26TEP00001', '26PS0001', '12345A']) assert.strictEqual(o.zakladCisla(c), c);
  for (const v of ['ano', 'PRAVDA', 'TRUE', '1', true, 1]) assert.strictEqual(o.jePreneseno(v), true, String(v));
  for (const v of ['ne', 'NEPRAVDA', 'false', '0', false, 0]) assert.strictEqual(o.jePreneseno(v), false, String(v));
  assert.strictEqual(o.jePreneseno(''), null);
  const m = (cells) => o.mapHeader(cells.map(o.fold));
  assert.deepStrictEqual(m(POHODA_2026[0]), { id: 0, castka: 2, prenes: 3, mesto: 4, psc: 5, zeme: 6 });
  assert.deepStrictEqual(m(['Číslo', 'Celkem', 'Přeneseno', 'Ceny', 'RefZeme', 'Země', 'PSČ', 'Obec']), { id: 0, castka: 1, prenes: 2, zeme: 5, psc: 6, mesto: 7 });

  const r = o.zpracovat(POHODA_2026, { pscData: PSC_POHODA, obecIndex: OBCE_POHODA });
  const s = r.souhrn;
  assert.strictEqual(s.kopie, 4);
  assert.strictEqual(s.radku, 9);
  assert.strictEqual(s.nepreneseno.n, 1); // 202602034 – ostatní mají přenesenou kopii
  assert.deepStrictEqual(r.prirazeno.psc, { 60200: { n: 4, zak: 0, akt: 0, kc: 2097 }, 46001: { n: 1, zak: 0, akt: 0, kc: 200 } });
  assert.strictEqual(r.prirazeno.zahranici.n, 1);
  assert.strictEqual(s.bezAdresy.n, 3);
  assert.strictEqual(r.dataset.nepreneseno, 0); // započteno, ne vynecháno

  const jen = o.zpracovat(POHODA_2026, { pscData: PSC_POHODA, obecIndex: OBCE_POHODA, jenPrenesene: true });
  assert.deepStrictEqual(jen.prirazeno.psc['60200'], { n: 3, zak: 0, akt: 0, kc: 1797 });
  assert.strictEqual(jen.dataset.nepreneseno, 1);
  assert.strictEqual(o.validovat(JSON.parse(JSON.stringify(jen.dataset))).data.nepreneseno, 1);

  // export bez sloupce Přeneseno: řádky položek se stejným číslem se sečtou, kopie s příponou se vynechá
  const rows = csv.parse('Číslo objednávky;PSČ;Celkem\n100100;602 00;500\n100100;602 00;300\n100200;602 00;400\n100200PHA;602 00;400\n');
  const p = o.zpracovat(rows, { pscData: PSC_POHODA, obecIndex: OBCE_POHODA });
  assert.deepStrictEqual(p.prirazeno.psc['60200'], { n: 2, zak: 0, akt: 0, kc: 1200 });
  assert.strictEqual(p.souhrn.kopie, 1);
});

test('víc souborů najednou: jiné pořadí sloupců, řádek součtu, kopie napříč soubory; přehledy ne', () => {
  const t2025 = [
    ['Číslo', 'Celkem', 'Přeneseno', 'Ceny', 'RefZeme', 'Země', 'PSČ', 'Obec'],
    ['202502026', 1897, 'ano', 'Prodejní', 6, 'ČR', '602 00', 'Brno'],
    ['202502029', 248, 'ne', 'Prodejní', 6, 'ČR', '46001', 'Liberec'],
    ['202502029LI', 248, 'ano', 'Prodejní', 6, 'ČR', '460 01', 'Liberec'],
    ['Celkem', 2393, null, null, null, null, null, null],
  ];
  const t2026 = [
    ['Číslo', 'Cizí měna', 'Celkem', 'Přeneseno', 'Obec', 'PSČ', 'Země', 'Ceny'],
    ['202602027', null, 3, 'ne', 'Brno', '602 00', 'ČR', 'VIP CENY'],
    ['202602029', 'EUR', 13951.06, 'ano', 'Wien', '1030', 'AT', 'Prodejní'],
    ['202502029BM', null, 248, 'ne', 'Liberec', '460 01', 'ČR', 'Prodejní'], // kopie objednávky z druhého souboru
  ];
  const sp = o.spojitTabulky([{ nazev: '2025.xlsx', rows: t2025 }, { nazev: '2026.xlsx', rows: t2026 }]);
  assert.strictEqual(sp.soubory, 2);
  assert.deepStrictEqual(sp.rows[0], ['Číslo objednávky', 'PSČ', 'Obec', 'Země', 'Celkem', 'Přeneseno']);
  assert.strictEqual(sp.rows.length, 7); // záhlaví + 3 + 3, bez řádku „Celkem“
  assert.deepStrictEqual(sp.rows[4], ['202602027', '602 00', 'Brno', 'ČR', 3, 'ne']);
  const r = o.zpracovat(sp.rows, { pscData: PSC_POHODA, obecIndex: OBCE_POHODA });
  assert.deepStrictEqual(r.bloky[0].sloupce, { id: 0, psc: 1, mesto: 2, zeme: 3, castka: 4, prenes: 5 });
  assert.strictEqual(r.souhrn.kopie, 2);
  assert.deepStrictEqual(r.prirazeno.psc, { 60200: { n: 2, zak: 0, akt: 0, kc: 1900 }, 46001: { n: 1, zak: 0, akt: 0, kc: 248 } });
  assert.strictEqual(r.prirazeno.zahranici.n, 1);
  assert.match(o.spojitTabulky([{ nazev: 'prehled.xlsx', rows: [['PSČ', 'Počet objednávek'], ['602 00', 5]] }, { nazev: '2026.xlsx', rows: t2026 }]).chyba, /přehled s počty/);
  assert.match(o.spojitTabulky([{ nazev: 'x.csv', rows: [['a', 'b'], ['1', '2']] }]).chyba, /nenašel záhlaví/);
});

test('hotový přehled PSČ; počet', () => {
  const rows = csv.parse('PSČ;Počet objednávek\n602 00;12\n110 00;30\n999 99;1\n');
  const d = o.detectColumns(rows);
  const s = o.secti(rows, d.sloupce, { odRadku: 1 });
  assert.ok(s.sectene);
  const prir = o.priradit(s, null, null);
  assert.deepStrictEqual(prir.psc['11000'], { n: 30, zak: 0, akt: 0, kc: 0 });
  assert.strictEqual(prir.zahranici.n, 1); // 999 99 = slovenské PSČ
  assert.strictEqual(o.dataset(prir, s).objednavek, 42);
});

test('plochá kontingenční tabulka: nadpis s „PSČ“, filtry, řádky Celkem, (neuvedeno), 4místná PSČ, zahraničí', () => {
  const r = zpracuj(fx.PLOCHA);
  assert.strictEqual(r.bloky.length, 1);
  const b = r.bloky[0];
  assert.strictEqual(b.hlavicka, 6); // ne nadpis „… dle Země / Obce / PSČ“ ani filtry
  assert.ok(b.zemeOdhad);
  assert.deepStrictEqual(b.sloupce, { zeme: 0, mesto: 1, psc: 2, zak: 3, akt: 4, pocet: 5, castka: 6 });
  const ds = r.dataset;
  assert.deepStrictEqual(ds.metriky, ['n', 'zak', 'akt']);
  assert.ok(ds.castky);
  assert.deepStrictEqual(misto(ds, '16000'), { psc: '16000', n: 2000, zak: 1200, akt: 100, kc: 10000000 }); // nezlomitelné mezery v číslech
  assert.deepStrictEqual(misto(ds, '60200'), { psc: '60200', n: 900, zak: 800, akt: 40, kc: 3000000 });
  assert.deepStrictEqual(misto(ds, '14200'), { psc: '14200', n: 40, zak: 30, akt: 2, kc: 200000 }); // Praha bez PSČ → podle názvu
  assert.deepStrictEqual(misto(ds, '12000'), { psc: '12000', n: 4, zak: 11, akt: 0, kc: 10000 }); // „1200“ u CZ i u AT Praha
  assert.deepStrictEqual(misto(ds, '46001'), { psc: '46001', n: 2, zak: 7, akt: 0, kc: 2000 }); // AT | Liberec | 4601
  assert.deepStrictEqual(misto(ds, '25088'), { psc: '25088', n: 2, zak: 1, akt: 1, kc: 7000 }); // nesmyslný název, platné PSČ
  assert.strictEqual(ds.mista.length, 6);
  assert.deepStrictEqual([ds.objednavek, ds.zakazniku, ds.aktivnich], [2948, 2049, 143]);
  const p = r.prirazeno;
  assert.deepStrictEqual(p.zahranici, { n: 347, zak: 184, akt: 1, kc: 3117500 }); // Berlin s českým tvarem PSČ, SK, AT Wien, PL, DE
  assert.deepStrictEqual(p.nezarazeno, { n: 9010, zak: 23000, akt: 700, kc: 50050000 }); // (neuvedeno), řádky Celkem ne
  assert.strictEqual(p.opraveno.n, 6);
  assert.strictEqual(ds.nezarazeno, 9010);
  assert.strictEqual(ds.zahranici, 347);
  assert.strictEqual(o.nadpisTabulky(csv.parse(fx.PLOCHA), r.bloky), 'Podklad pro mapu – ploché tabulky dle Země / Obce / PSČ (bez mezisoučtů)');
});

test('dvě tabulky vedle sebe: obce + rozpad velkých měst podle PSČ, bez dvojího započtení, kontrolní součty', () => {
  const r = zpracuj(fx.VEDLE);
  assert.strictEqual(r.bloky.length, 2);
  assert.deepStrictEqual(r.bloky.map((b) => [b.od, b.do, b.hlavicka]), [[0, 3, 6], [5, 9, 6]]);
  assert.deepStrictEqual(r.bloky[0].sloupce, { mesto: 0, pocet: 1, castka: 2 }); // průměrná objednávka ne
  assert.deepStrictEqual(r.bloky[1].sloupce, { mesto: 5, psc: 6, pocet: 7, castka: 8 });
  assert.ok(r.lzeSpojit);
  assert.strictEqual(r.volba, 'spojit');
  assert.strictEqual(r.prekryto, 3); // Praha, Brno, Bratislava z tabulky obcí vynechány
  assert.deepStrictEqual(r.rozdily, []);
  const ds = r.dataset;
  const n = Object.fromEntries(ds.mista.map((x) => [x.psc, x.n]));
  assert.deepStrictEqual(n, { 16000: 600, 15000: 340, 14200: 80, 60200: 300, 61700: 100, 41501: 150, 25065: 30, 70030: 15 });
  assert.strictEqual(misto(ds, '15000').kc, 1700000); // 150 00 + „1500“
  assert.strictEqual(ds.objednavek, 1615);
  assert.strictEqual(r.prirazeno.zahranici.n, 194); // Bratislava, Košice, Žilina (české jmenovce), Most pri Bratislave
  assert.strictEqual(r.prirazeno.nezarazeno.n, 507);
  assert.deepStrictEqual(r.prirazeno.neprirazene.map((x) => [x.nazev, x.n]), [['', 500], ['Brno-venkov', 5], ['<img src=x onerror=alert(1)>', 2]]);
  assert.deepStrictEqual(r.kontroly.map((k) => [k.blok, k.celkem, k.radky, k.ok]), [[0, 2316, 2316, true], [1, 1500, 1500, true], ['spojeno', 2316, 2316, true]]);
  // jen jedna tabulka
  const jenPsc = zpracuj(fx.VEDLE, { volba: 1 });
  assert.strictEqual(jenPsc.dataset.objednavek, 1400);
  assert.strictEqual(jenPsc.prirazeno.zahranici.n, 100);
  // jiné filtry v tabulkách → upozornění
  const jine = zpracuj(fx.VEDLE.replace('Brno\t400\t1 600 000', 'Brno\t350\t1 600 000'));
  assert.deepStrictEqual(jine.rozdily, [{ nazev: 'Brno', obec: 350, psc: 400 }]);
});

test('křížová tabulka s roky ve sloupcích a „Celkový součet“ + rozpad podle PSČ se záhlavím o řádek výš', () => {
  const r = zpracuj(fx.KRIZOVA);
  assert.deepStrictEqual(r.bloky.map((b) => [b.od, b.hlavicka, b.sloupce]), [
    [0, 5, { mesto: 0, pocet: 4 }], // sloupec „Celkový součet“ = počet objednávek (podle popisku nad tabulkou)
    [7, 4, { mesto: 7, psc: 8, pocet: 9, castka: 10 }],
  ]);
  assert.strictEqual(r.volba, 'spojit');
  const n = Object.fromEntries(r.dataset.mista.map((x) => [x.psc, x.n]));
  assert.deepStrictEqual(n, { 16000: 30, 15000: 10, 62100: 5, 46001: 3 });
  assert.ok(!r.dataset.castky); // tabulka obcí částku nemá → po spojení bez částek
  assert.ok(r.kontroly.every((k) => k.ok));
});

test('zákazníci a aktivní zákazníci: slovenská Modra × moravská Modrá, jmenovci, smetí místo obce', () => {
  const r = zpracuj(fx.ZAKAZNICI);
  const ds = r.dataset;
  assert.deepStrictEqual(ds.metriky, ['zak', 'akt']);
  assert.strictEqual(ds.objednavek, 0);
  assert.deepStrictEqual(ds.mista, [
    { psc: '16000', zak: 300, akt: 30, kc: 0 },
    { psc: '14200', zak: 190, akt: 8, kc: 0 },
    { psc: '68706', zak: 30, akt: 0, kc: 0 },
    { psc: '12000', zak: 10, akt: 2, kc: 0 },
  ]);
  assert.deepStrictEqual([r.prirazeno.zahranici.zak, r.prirazeno.zahranici.akt], [150, 2]); // Komárno, Senec, Modra
  assert.deepStrictEqual([r.prirazeno.nezarazeno.zak, r.prirazeno.nezarazeno.akt], [1030, 50]);
  assert.ok(r.kontroly.every((k) => k.ok));
});

test('osnova s mezisoučtem nad skupinou a kompaktní forma – mezisoučet se nepočítá dvakrát', () => {
  const r = zpracuj(fx.OSNOVA);
  assert.deepStrictEqual(r.bloky[0].popisky, [0, 1, 2]);
  assert.deepStrictEqual(r.dataset.mista.map((x) => [x.psc, x.zak]), [['16000', 70], ['60200', 50], ['15000', 40]]);
  assert.deepStrictEqual(r.kontroly.map((k) => [k.celkem, k.radky, k.ok]), [[160, 160, true]]);
});

test('kontrolní součet odhalí nesedící řádek „Celkový součet“; vstupní řádky se nemění', () => {
  const r = zpracuj(fx.OSNOVA.replace('Celkový součet\t\t\t160', 'Celkový součet\t\t\t170'));
  assert.deepStrictEqual(r.kontroly.map((k) => [k.celkem, k.radky, k.ok]), [[170, 160, false]]);
  const rows = csv.parse(fx.VEDLE);
  const kopie = JSON.stringify(rows);
  const a = o.zpracovat(rows, { pscData: fx.PSC, obecIndex: fx.OBCE, velkaMesta: fx.VELKA, meta: { nahrano: 'x' } });
  const b = o.zpracovat(rows, { pscData: fx.PSC, obecIndex: fx.OBCE, velkaMesta: fx.VELKA, meta: { nahrano: 'x' } });
  assert.strictEqual(JSON.stringify(rows), kopie);
  assert.deepStrictEqual(a.dataset, b.dataset);
});

test('validace datasetu pro server – jen PSČ, počty, částka; starý formát i zákazníci', () => {
  const ok = o.validovat({ mista: [{ psc: '60200', n: 3, kc: 1000 }, { psc: '60200', n: 9 }, { psc: '81101', n: 1 }, { psc: '11000', n: 0 }], od: '2025-01-01', do: 'x', nezarazeno: -5 });
  assert.deepStrictEqual(ok.data.mista, [{ psc: '60200', n: 3, kc: 1000 }]);
  assert.deepStrictEqual(ok.data.metriky, ['n']);
  assert.strictEqual(ok.data.objednavek, 3);
  assert.strictEqual(ok.data.do, null);
  assert.strictEqual(ok.data.nezarazeno, 0);
  const zak = o.validovat({ metriky: ['zak', 'akt', 'xyz'], mista: [{ psc: '16000', zak: 5, akt: 1, kc: 0 }, { psc: '15000', zak: 0, akt: 0 }, { psc: '60200', zak: 2, n: 99 }] });
  assert.deepStrictEqual(zak.data.metriky, ['zak', 'akt']);
  assert.deepStrictEqual(zak.data.mista, [{ psc: '16000', zak: 5, akt: 1, kc: 0 }, { psc: '60200', zak: 2, akt: 0, kc: 0 }]);
  assert.deepStrictEqual([zak.data.zakazniku, zak.data.aktivnich, zak.data.objednavek], [7, 1, 0]);
  assert.match(o.validovat({ mista: [{ psc: '60200', n: 1, jmeno: 'Jan' }] }).chyba, /osobní údaje/);
  assert.match(o.validovat({ metriky: ['zak'], mista: [{ psc: '60200', zak: 1, email: 'jan@example.cz' }] }).chyba, /osobní údaje/);
  assert.ok(o.validovat({}).chyba);
  assert.ok(o.validovat({ mista: new Array(20001).fill({ psc: '60200', n: 1 }) }).chyba);
  // dataset z importu projde validací beze změny počtů
  const r = zpracuj(fx.PLOCHA);
  const v = o.validovat(JSON.parse(JSON.stringify(r.dataset))).data;
  assert.deepStrictEqual(v.mista, r.dataset.mista);
  assert.deepStrictEqual([v.objednavek, v.zakazniku, v.aktivnich], [2948, 2049, 143]);
});
