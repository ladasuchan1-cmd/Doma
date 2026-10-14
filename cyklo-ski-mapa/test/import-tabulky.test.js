'use strict';
// Testy hromadného importu upravené tabulky do stavu oslovení (lib/import-tabulky.js).
const test = require('node:test');
const assert = require('node:assert');
const imp = require('../lib/import-tabulky.js');
const stavLib = require('../lib/stav.js');

const HLAVICKA = ['Název', 'Typ', 'Půjčovna', 'Provozovatel', 'Telefon', 'E-mail', 'Web', 'Chceme kontaktovat', 'Proběhl nabídkový e-mail', 'Volali jsme', 'Osobní návštěva proběhla', 'Poznámka', 'Upravil', 'Upraveno', 'OSM'];
const osm = (typ, n) => `https://www.openstreetmap.org/${typ}/${n}`;
const radek = (o) => HLAVICKA.map((h) => (o[h] == null ? '' : o[h]));

const MISTA = {
  n1: { nazev: 'Penzion U Lípy', pujcovna: '', provozovatel: '', telefon: '+420 603 123 456', email: 'info@lipa.cz', web: 'https://lipa.cz/' },
  w2: { nazev: 'Hotel Skalka', pujcovna: 'ano?', provozovatel: 'Skalka s.r.o.', telefon: '', email: '', web: '' },
  n3: { nazev: 'Kemp Pod Lesem', pujcovna: 'ano', provozovatel: '', telefon: '', email: '', web: '' },
};
const misto = (id) => MISTA[id] || null;

test('stavZBunky: ano s datem i bez, ne, prázdno, datum z Excelu, nerozpoznané', () => {
  assert.deepStrictEqual(imp.stavZBunky('ano (14. 10. 2026)'), { ano: true, datum: '2026-10-14' });
  assert.deepStrictEqual(imp.stavZBunky('Ano'), { ano: true, datum: null });
  assert.deepStrictEqual(imp.stavZBunky('x'), { ano: true, datum: null });
  assert.deepStrictEqual(imp.stavZBunky('TRUE'), { ano: true, datum: null });
  assert.deepStrictEqual(imp.stavZBunky('14.10.2026'), { ano: true, datum: '2026-10-14' });
  assert.deepStrictEqual(imp.stavZBunky('46309'), { ano: true, datum: '2026-10-14' });
  assert.deepStrictEqual(imp.stavZBunky('ne'), { ano: false });
  assert.deepStrictEqual(imp.stavZBunky('0'), { ano: false });
  assert.strictEqual(imp.stavZBunky('  '), null);
  assert.deepStrictEqual(imp.stavZBunky('možná'), { neznamo: 'možná' });
  assert.deepStrictEqual(imp.stavZBunky('ano (31. 2. 2026)'), { ano: true, datum: null });
});

test('textZBunky a stejne: apostrof z exportu, telefony, weby, e-maily', () => {
  assert.strictEqual(imp.textZBunky("'+420 739 842 402"), '+420 739 842 402');
  assert.strictEqual(imp.textZBunky("'=1+1"), '=1+1');
  assert.strictEqual(imp.textZBunky("Rock'n'roll"), "Rock'n'roll");
  assert.ok(imp.stejne('telefon', '+420603123456', '+420 603 123 456'));
  assert.ok(imp.stejne('web', 'HTTPS://lipa.cz', 'https://lipa.cz/'));
  assert.ok(imp.stejne('email', 'Info@Lipa.cz', 'info@lipa.cz'));
  assert.ok(!imp.stejne('provozovatel', 'Lípa s.r.o.', 'Lipa s.r.o.'));
});

test('idZRadku: odkaz OSM i sloupec ID', () => {
  const s = { osm: 0, id: 1 };
  assert.strictEqual(imp.idZRadku([osm('node', 1), ''], s), 'n1');
  assert.strictEqual(imp.idZRadku(['way/22', ''], s), 'w22');
  assert.strictEqual(imp.idZRadku(['', 'osk-abc'], s), 'osk-abc');
  assert.strictEqual(imp.idZRadku(['https://www.openstreetmap.org/', ''], s), null);
});

test('navrhni: víc listů (kraj na list), pravidla buněk, nespárované, duplicity, nerozpoznané, přeskočené listy', () => {
  const stav = {
    w2: { ...stavLib.emptyRecord(), volano: true, datumy: { volano: '2026-10-01' }, poznamka: 'stará' },
    n3: { ...stavLib.emptyRecord(), nabidka: true, datumy: { nabidka: '2026-10-02' } },
  };
  const listy = [
    { nazev: 'Ústecký kraj', radky: [
      HLAVICKA,
      radek({ Název: 'Penzion U Lípy', Telefon: "'+420 603 123 456", 'E-mail': 'info@lipa.cz', Web: 'https://lipa.cz', 'Proběhl nabídkový e-mail': 'ano (14. 10. 2026)', Upraveno: '46309.5', OSM: osm('node', 1) }),
      radek({ Název: 'Hotel Skalka', Půjčovna: 'podle webu', Provozovatel: 'Skalka s.r.o.', 'Volali jsme': 'ne', 'Chceme kontaktovat': 'x', Poznámka: 'nová poznámka', OSM: osm('way', 2) }),
      radek({ Název: 'Neznámý', 'Volali jsme': 'ano', OSM: osm('node', 999) }),
      radek({ Název: 'Bez odkazu', 'Volali jsme': 'ano' }),
      [],
    ] },
    { nazev: 'List1', radky: [] },
    { nazev: 'Poznámky', radky: [['jen text bez hlavičky']] },
    { nazev: 'Jihomoravský kraj', radky: [
      HLAVICKA,
      radek({ Název: 'Kemp Pod Lesem', Půjčovna: 'ne', 'Proběhl nabídkový e-mail': 'ano (20. 10. 2026)', 'Volali jsme': 'možná', Telefon: '777 888 999', OSM: osm('node', 3) }),
      radek({ Název: 'Penzion U Lípy znovu', 'Volali jsme': 'ano', OSM: osm('node', 1) }),
    ] },
  ];
  const n = imp.navrhni({ listy, misto, stav, dnes: '2026-10-21' });
  assert.deepStrictEqual(n.listy.map((l) => [l.nazev, l.radku, l.sparovano]), [['Ústecký kraj', 4, 2], ['Jihomoravský kraj', 2, 1]]);
  assert.deepStrictEqual(n.preskocene, ['Poznámky']);
  assert.strictEqual(n.radku, 6);
  const z = n.zmeny.map((x) => `${x.id} ${x.pole} ${JSON.stringify(x.puvodni)}→${JSON.stringify(x.nove)}${x.datum ? ' ' + x.datum : ''}`);
  assert.deepStrictEqual(z, [
    'n1 nabidka false→true 2026-10-14',
    'w2 kontaktovat false→true 2026-10-21',
    'w2 volano true→false',
    'w2 poznamka "stará"→"nová poznámka"',
    'n3 pujcovna "ano"→"ne"',
    'n3 telefon ""→"777 888 999"',
  ]);
  assert.deepStrictEqual(n.nesparovane.map((x) => [x.list, x.radek, x.duvod]), [
    ['Ústecký kraj', 4, 'místo v mapě není'],
    ['Ústecký kraj', 5, 'chybí odkaz OSM'],
    ['Jihomoravský kraj', 3, 'stejné místo už je na listu „Ústecký kraj“ na řádku 2'],
  ]);
  assert.deepStrictEqual(n.nerozpoznane.map((x) => [x.list, x.radek, x.sloupec, x.hodnota]), [['Jihomoravský kraj', 2, 'Volali jsme', 'možná']]);
  assert.strictEqual(n.mist, 3);
  assert.deepStrictEqual(n.zmeny.map((x) => x.skupina), ['osloveni', 'osloveni', 'osloveni', 'osloveni', 'udaje', 'udaje'], 'půjčovna a kontakty jsou zvlášť – zapisují se jen na souhlas');
  assert.deepStrictEqual(imp.souhrn(n.zmeny).map((x) => [x.pole, x.zaskrtnout, x.odskrtnout, x.zmenit]), [
    ['kontaktovat', 1, 0, 0], ['nabidka', 1, 0, 0], ['volano', 0, 1, 0], ['poznamka', 0, 0, 1], ['pujcovna', 0, 0, 1], ['telefon', 0, 0, 1],
  ]);
});

test('navrhni: soubor bez sloupce OSM i ID → chyba jmenuje nalezené sloupce', () => {
  assert.throws(() => imp.navrhni({ listy: [{ nazev: 'x', radky: [['Název', 'Telefon'], ['A', '1']] }], misto, stav: {}, dnes: '2026-10-21' }), /chybí sloupec „OSM“.*Název, Telefon/);
});

test('pouzij: data z buněk, kdo, odškrtnutí, prázdný záznam zmizí', () => {
  const stav = { w2: { ...stavLib.emptyRecord(), volano: true, datumy: { volano: '2026-10-01' } } };
  const zmeny = [
    { id: 'n1', druh: 'stav', pole: 'nabidka', puvodni: false, nove: true, datum: '2026-10-14' },
    { id: 'n1', druh: 'pole', pole: 'telefon', puvodni: '', nove: '777 888 999' },
    { id: 'w2', druh: 'stav', pole: 'volano', puvodni: true, nove: false },
  ];
  const { stav: novy, id } = imp.pouzij(stav, zmeny, { kdo: 'jana@koloshop.cz', now: '2026-10-21T08:00:00.000Z' });
  assert.deepStrictEqual(id, ['n1', 'w2']);
  assert.strictEqual(novy.n1.nabidka, true);
  assert.strictEqual(novy.n1.datumy.nabidka, '2026-10-14');
  assert.strictEqual(novy.n1.telefon, '777 888 999');
  assert.strictEqual(novy.n1.kdo, 'jana@koloshop.cz');
  assert.strictEqual(novy.n1.upraveno, '2026-10-21T08:00:00.000Z');
  assert.ok(!('w2' in novy), 'záznam bez jakékoli informace se nedrží');
  assert.ok(stav.w2.volano, 'původní stav se nemění');
});
