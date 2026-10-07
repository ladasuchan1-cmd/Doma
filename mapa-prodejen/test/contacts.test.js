'use strict';
// Testy vytěžení kontaktů z webu (lib/contacts.js).
const test = require('node:test');
const assert = require('node:assert');
const c = require('../lib/contacts.js');

test('stripHtml – skripty pryč, entity dekódované, bloky na řádky', () => {
  const html = '<html><head><style>a{}</style><script>var x="<b>";</script></head><body><h1>Penzion&nbsp;U&nbsp;Lípy</h1><p>Tel: 123&nbsp;456&nbsp;789</p><div>a &amp; b &#269;</div></body></html>';
  const t = c.stripHtml(html);
  assert.ok(!t.includes('var x'));
  assert.ok(t.includes('Penzion U Lípy'));
  assert.ok(t.includes('a & b č'));
  assert.ok(t.split('\n').length >= 3);
  assert.strictEqual(c.stripHtml(''), '');
});

test('extractEmails – mailto, maskování, odfiltrování obrázků a vzorových adres', () => {
  const html = '<a href="mailto:Info@Penzion.cz?subject=x">napište</a> recepce [at] hotel-lipno (dot) cz, logo@2x.png, name@example.com, jmeno@domena.cz, email@domain.com, rezervace@chata.eu.';
  const e = c.extractEmails(html);
  // jmeno@domena.cz a email@domain.com jsou vzorové adresy z formulářů – filtrují se
  assert.deepStrictEqual(e.sort(), ['info@penzion.cz', 'recepce@hotel-lipno.cz', 'rezervace@chata.eu'].sort());
  assert.deepStrictEqual(c.extractEmails(''), []);
});

test('normalizePhone – CZ/SK tvary', () => {
  assert.strictEqual(c.normalizePhone('+420 603 123 456'), '+420 603 123 456');
  assert.strictEqual(c.normalizePhone('00420603123456'), '+420 603 123 456');
  assert.strictEqual(c.normalizePhone('603 123 456'), '+420 603 123 456');
  assert.strictEqual(c.normalizePhone('tel:+421905123456'), '+421 905 123 456');
  assert.strictEqual(c.normalizePhone('+49 30 1234567'), '+49301234567');
  assert.strictEqual(c.normalizePhone('12345678'), null); // IČO, ne telefon
  assert.strictEqual(c.normalizePhone(''), null);
});

test('extractPhones – tel: odkazy, mezinárodní tvar, kontext, ignorování IČO a částek', () => {
  const html = '<a href="tel:+420603123456">volejte</a> Recepce: 777 888 999. IČO: 27082440, cena 1 500 000 Kč, číslo účtu 123456789/0100, Telefon 234567890';
  const p = c.extractPhones(html);
  assert.ok(p.includes('+420 603 123 456'));
  assert.ok(p.includes('+420 777 888 999'));
  assert.ok(p.includes('+420 234 567 890'));
  assert.ok(!p.some((x) => x.includes('270 824 40')));
  assert.ok(!p.includes('+420 500 000 Kč'));
  assert.ok(!p.includes('+420 123 456 789'), p.join(','));
  assert.deepStrictEqual(c.extractPhones(''), []);
});

test('IČO – kontrolní součet a vytažení z textu', () => {
  assert.ok(c.validIco('27082440')); // Alza.cz
  assert.ok(c.validIco('00006947')); // MF ČR
  assert.ok(!c.validIco('27082441'));
  assert.ok(!c.validIco('1234'));
  assert.deepStrictEqual(c.extractIco('Provozovatel: Firma s.r.o., IČO: 270 82 440, DIČ CZ27082440; IČ 27082441'), ['27082440']);
});

test('extractOperator', () => {
  assert.strictEqual(c.extractOperator('Provozovatel: Horská chata Pod Smrkem s.r.o., IČO 12345678'), 'Horská chata Pod Smrkem s.r.o.');
  assert.strictEqual(c.extractOperator('Provozovatelem penzionu je Jan Novák\nTel: 123'), 'Jan Novák');
  assert.strictEqual(c.extractOperator('žádný text'), null);
});

test('detectRental – kola vs. lyže, ukázky', () => {
  const r = c.detectRental('Nabízíme půjčovnu elektrokol a koloběžek. V zimě půjčovna lyží a snowboardů.');
  assert.ok(r.kola && r.lyze && r.obecne);
  assert.ok(r.ukazky.length >= 1);
  const r2 = c.detectRental('Bike rental available at the reception.');
  assert.ok(r2.kola && !r2.lyze);
  const r3 = c.detectRental('Ubytování s polopenzí, wellness.');
  assert.ok(!r3.kola && !r3.lyze && !r3.obecne && r3.ukazky.length === 0);
  const r4 = c.detectRental('Skiverleih und Fahrradverleih im Haus');
  assert.ok(r4.kola && r4.lyze);
});

test('normalizeWebsite, hostOf, isSocialUrl', () => {
  assert.strictEqual(c.normalizeWebsite('www.penzion.cz'), 'https://www.penzion.cz/');
  assert.strictEqual(c.normalizeWebsite('http://hotel.cz/kontakt; další'), 'http://hotel.cz/kontakt');
  assert.strictEqual(c.normalizeWebsite('nic'), null);
  assert.strictEqual(c.normalizeWebsite(''), null);
  assert.strictEqual(c.hostOf('https://www.hotel.cz/x'), 'hotel.cz');
  assert.ok(c.isSocialUrl('https://www.facebook.com/penzion'));
  assert.ok(!c.isSocialUrl('https://penzion.cz'));
});

test('findContactLinks – jen stejná doména, max 4, bez duplicit', () => {
  const html = '<a href="/kontakt">Kontakt</a> <a href="https://www.penzion.cz/o-nas/">O nás</a> <a href="https://jinde.cz/kontakt">x</a> <a href="/kontakt#top">Kontakt</a> <a href="/galerie">Galerie</a>';
  const links = c.findContactLinks(html, 'https://penzion.cz/');
  assert.deepStrictEqual(links, ['https://penzion.cz/kontakt', 'https://www.penzion.cz/o-nas/']);
  assert.deepStrictEqual(c.findContactLinks(html, 'neplatné'), []);
});

test('služby prodejny z textu webu (mapa prodejen)', () => {
  const s = c.detectSluzby('Nabízíme servis jízdních kol a prodej elektrokol. Půjčovna kol v centru. Výkup kol na protiúčet.', '<button class="btn add-to-cart">Koupit</button>');
  assert.deepStrictEqual({ prodej: s.prodej, servis: s.servis, ekola: s.ekola, pujcovna: s.pujcovna, bazar: s.bazar, eshop: s.eshop }, { prodej: true, servis: true, ekola: true, pujcovna: true, bazar: true, eshop: true });
  assert.match(s.ukazky.servis, /servis jízdních kol/);
  const n = c.detectSluzby('Kavárna a cukrárna u náměstí, otevřeno denně.', '');
  assert.ok(!n.servis && !n.ekola && !n.pujcovna && !n.eshop);
});

test('značky kol – běžná slova nejsou značka', () => {
  assert.deepStrictEqual(c.detectZnacky('Prodáváme kola Specialized, Trek a CUBE, pohony Bosch Performance a Shimano STEPS. Rock Machine.'), ['Specialized', 'Trek', 'Cube', 'Rock Machine', 'Bosch eBike', 'Shimano STEPS']);
  assert.deepStrictEqual(c.detectZnacky('trekingová kola, trek na Sněžku, giant step, focus na zákazníka, kona se závod'), []);
  assert.ok(c.ZNACKY.includes('Kellys'));
});

test('podstránky webu: kontakt, servis, o nás (jen stejná doména)', () => {
  const html = '<a href="/servis-kol">Servis</a><a href="https://jiny.cz/kontakt">Cizí</a><a href="/kontakt">Kontakt</a><a href="/o-nas">O nás</a><a href="/vop.pdf">Obchodní podmínky</a>';
  assert.deepStrictEqual(c.findInfoLinks(html, 'https://www.kola.cz/'), ['https://www.kola.cz/kontakt', 'https://www.kola.cz/servis-kol', 'https://www.kola.cz/o-nas']);
  assert.deepStrictEqual(c.findInfoLinks(html, 'nejde'), []);
});

test('smetí mezi kontakty: e-maily robotů a zástupná čísla ze šablon', () => {
  assert.deepStrictEqual(c.extractEmails('spider-feedback@bytedance.com, info@kola.cz'), ['info@kola.cz']);
  assert.strictEqual(c.normalizePhone('+420 123 456 789'), null);
  assert.strictEqual(c.normalizePhone('777 777 777'), null);
  assert.strictEqual(c.normalizePhone('605 281 537'), '+420 605 281 537');
});
