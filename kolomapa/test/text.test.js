'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('../src/util/text');

test('parseCzk', () => {
  assert.equal(t.parseCzk('170 000 Kč'), 170000);
  assert.equal(t.parseCzk('12.500,-'), 12500);
  assert.equal(t.parseCzk('12 tis.'), 12000);
  assert.equal(t.parseCzk('45k'), 45000);
  assert.equal(t.parseCzk('Dohodou'), null);
  assert.equal(t.parseCzk('  8 990 Kč'), 8990);
  assert.equal(t.parseCzk(3000), 3000);
});

test('htmlToText / decodeEntities', () => {
  assert.equal(t.htmlToText('a<br>b&nbsp;c &amp; d<p>e</p>'), 'a\nb c & d\ne');
  assert.equal(t.decodeEntities('&#353;&#x161;&quot;'), 'šš"');
});

test('fold, keyOf, parseCzDate, parsePsc, hash, truncate', () => {
  assert.equal(t.fold('Ústí nad Labem'), 'usti nad labem');
  assert.equal(t.keyOf('Brno - Královo Pole!'), 'brno kralovo pole');
  assert.equal(t.parseCzDate('[2.10. 2026]'), '2026-10-02');
  assert.equal(t.parsePsc('Pelhřimov 393 01'), '39301');
  assert.equal(t.parsePsc('12'), null);
  assert.equal(t.hash('a'), t.hash('a'));
  assert.notEqual(t.hash('a'), t.hash('b'));
  assert.equal(t.truncate('jedna dva tři čtyři', 10), 'jedna dva…');
});

test('scrubContacts: skryje telefony a e-maily, ceny a roky nechá', () => {
  const s = t.scrubContacts('Volejte 777 123 456 nebo +420 602-111-222, mail jan.novak@seznam.cz. Cena 12 500 Kč, rok 2021, 150 000 Kč, rám 19".');
  assert.ok(!s.includes('777 123 456'));
  assert.ok(!s.includes('602-111-222'));
  assert.ok(!s.includes('seznam.cz'));
  assert.ok(s.includes('12 500 Kč') && s.includes('2021') && s.includes('150 000 Kč'));
  assert.equal(t.scrubContacts(null), null);
});

test('scrubContacts: číslo inzerátu ani PSČ nejsou telefon', () => {
  const s = t.scrubContacts('Inzerát 224568683, PSČ 39301, tel: 224568683, mobil 777123456');
  assert.ok(s.startsWith('Inzerát 224568683, PSČ 39301'));
  assert.ok(s.includes('tel: [telefon skryt]'));
  assert.ok(s.endsWith('mobil [telefon skryt]'));
});

// Všechna čísla, adresy a jména níže jsou smyšlená (ve formátech, které se v inzerátech skutečně objevují).
const scrub = t.scrubContacts;
const hidden = (input, secret) => {
  const out = scrub(input);
  assert.ok(!out.includes(secret), `„${secret}“ zůstalo v: ${out}`);
  return out;
};

test('scrubContacts: telefony v různých seskupeních a s předvolbou', () => {
  assert.equal(scrub('pouze volejte 777 12 34 56'), 'pouze volejte [telefon skryt]');
  assert.equal(scrub('mobil 604 11 22 33.'), 'mobil [telefon skryt].');
  assert.equal(scrub('Prodám kolo 777 12 34 56'), 'Prodám kolo [telefon skryt]', '3-2-2-2 i bez klíčového slova');
  assert.equal(scrub('(+420) 777 123 456'), '[telefon skryt]');
  assert.equal(scrub('+420 777 12 34 56'), '[telefon skryt]');
  assert.equal(scrub('00421 905 123 456'), '[telefon skryt]');
  assert.equal(scrub('Elektrokolo Crussis 420 777 123 456'), 'Elektrokolo Crussis [telefon skryt]', 'předvolba bez +');
  assert.equal(scrub('tel.:+420777123456'), 'tel.:[telefon skryt]');
  assert.equal(scrub('tel. 777/123/456'), 'tel. [telefon skryt]', 'lomítka za klíčovým slovem');
  assert.equal(scrub('tel 77 71 23 456'), 'tel [telefon skryt]', 'neobvyklé seskupení za klíčovým slovem');
  assert.equal(scrub('Telefonní číslo: 777–123–456'), 'Telefonní číslo: [telefon skryt]', 'pomlčky (en dash)');
  assert.equal(scrub('7 7 7 1 2 3 4 5 6'), '[telefon skryt]');
  assert.equal(scrub('777 123456 nebo 777123 456'), '[telefon skryt] nebo [telefon skryt]');
  assert.equal(scrub('na čísle 0905 123 456'), 'na čísle [telefon skryt]', 'slovenské číslo');
  assert.equal(scrub('777 123 456 602 111 222'), '[telefon skryt] [telefon skryt]', 'dvě čísla za sebou');
  assert.equal(scrub('Tel: 777123456, 602111222'), 'Tel: [telefon skryt], [telefon skryt]');
  assert.equal(scrub('volejte (777 123 456) 8-20 hod'), 'volejte ([telefon skryt]) 8-20 hod');
  assert.equal(scrub('777 123 456 V Praze'), '[telefon skryt] V Praze');
});

test('scrubContacts: odkazy na WhatsApp / Telegram / Facebook / Instagram a @přezdívky', () => {
  assert.equal(scrub('fotky na https://wa.me/420777123456'), 'fotky na [kontakt skryt]');
  hidden('api.whatsapp.com/send?phone=420777123456', '777123456');
  assert.equal(scrub('wa.me/420777123456'), '[kontakt skryt]');
  assert.equal(scrub('https://wa.me/420777123456 nebo 420777123456'), '[kontakt skryt] nebo [telefon skryt]');
  assert.equal(scrub('fb: https://www.facebook.com/jan.novak.123'), 'fb: [kontakt skryt]');
  assert.equal(scrub('messenger m.me/jannovak, t.me/jannovak'), 'messenger [kontakt skryt], [kontakt skryt]');
  assert.equal(scrub('IG: @kola_novak.'), 'IG: [kontakt skryt].');
  assert.equal(scrub('viber://chat?number=%2B420777123456'), '[kontakt skryt]');
  // odkazy na výrobce a obchody zůstanou (popis výbavy)
  const spec = 'specifikace: https://www.canyon.com/en-cz/p/622123456 a https://www.specialized.com/cz/cs/turbo-levo/p/154386?color=239518';
  assert.equal(scrub(spec), spec);
});

test('scrubContacts: e-maily i se zástupným zavináčem a diakritikou', () => {
  assert.equal(scrub('pište na jan.novak(at)seznam.cz'), 'pište na [e-mail skryt]');
  assert.equal(scrub('jan.novak [zavináč] seznam tečka cz'), '[e-mail skryt]');
  assert.equal(scrub('jan.novak (zavinac) email (dot) cz'), '[e-mail skryt]');
  assert.equal(scrub('jan.novak @ seznam.cz'), '[e-mail skryt]');
  assert.equal(scrub('jiří.novák@seznam.cz'), '[e-mail skryt]');
  assert.equal(scrub('mail: novak (at) gmail'), 'mail: [e-mail skryt]');
  assert.equal(scrub('jan.novak@seznam'), '[e-mail skryt]');
  assert.equal(scrub('Novak at seznam.cz'), '[e-mail skryt]');
  assert.equal(scrub('JAN.NOVAK@SEZNAM.CZ'), '[e-mail skryt]');
});

test('scrubContacts: rodné číslo, DIČ fyzické osoby, IČO, IBAN, číslo účtu', () => {
  // 780101/1229 je platné rodné číslo (dělitelné 11), 780101/1234 ne
  assert.equal(scrub('RČ 780101/1229'), 'RČ [rodné číslo skryto]');
  assert.equal(scrub('díl 780101/1234'), 'díl 780101/1234');
  assert.equal(scrub('DIČ: CZ7801011229'), 'DIČ: [DIČ skryto]');
  assert.equal(scrub('DIČ CZ12345678'), 'DIČ [DIČ skryto]');
  assert.equal(scrub('CZ7801011229'), 'CZ[DIČ skryto]');
  assert.equal(scrub('kód CZ1234567890'), 'kód CZ1234567890', 'bez „DIČ“ jen platné rodné číslo');
  assert.equal(scrub('IČO: 12345678'), 'IČO: [IČO skryto]');
  assert.equal(scrub('IČ 123 45 678'), 'IČ [IČO skryto]');
  assert.equal(scrub('IBAN CZ65 0800 0000 1920 0014 5399'), 'IBAN [číslo účtu skryto]');
  assert.equal(scrub('Číslo mého b.účtu k převodu: 107-1234567890/0100'), 'Číslo mého b.účtu k převodu: [číslo účtu skryto]');
  assert.equal(scrub('č.ú. 123456789/0800'), 'č.ú. [číslo účtu skryto]');
  // klíčová slova pro rozpoznání obchodu (IČO, DIČ) zůstanou
  assert.match(t.fold(scrub('IČO: 12345678, DIČ: CZ12345678')), /\bico\b.*\bdic\b/);
});

test('scrubContacts: jména u kontaktu', () => {
  assert.equal(scrub('pouze volejte 777 12 34 56 Novák\ncena je pevná'), 'pouze volejte [telefon skryt] [jméno skryto]\ncena je pevná');
  assert.equal(scrub('Kontakt: 777 123 456 - Petr Novák.'), 'Kontakt: [telefon skryt] - [jméno skryto].');
  assert.equal(scrub('jan.novak@seznam.cz Novák'), '[e-mail skryt] [jméno skryto]');
  assert.equal(scrub('volejte pana Nováka'), 'volejte pana Nováka', '„pana“ ani 4. pád neřešíme');
  assert.equal(scrub('ptejte se pan Novák'), 'ptejte se pan [jméno skryto]');
  assert.equal(scrub('paní Nováková'), 'paní [jméno skryto]');
  assert.equal(scrub('S pozdravem Jan Novák'), 'S pozdravem [jméno skryto]');
  assert.equal(scrub('S pozdravem,\nJan'), 'S pozdravem,\n[jméno skryto]');
  assert.equal(scrub('Jméno: Petr'), 'Jméno: [jméno skryto]');
  // běžná slova a města za číslem nejsou jména
  assert.equal(scrub('Telefon 777 123 456 Děkuji'), 'Telefon [telefon skryt] Děkuji');
  assert.equal(scrub('tel 777 123 456 Praha'), 'tel [telefon skryt] Praha');
  assert.equal(scrub('[telefon skryt] Petr Děkuji.'), '[telefon skryt] [jméno skryto] Děkuji.');
});

test('scrubContacts: ceny, roky, rozměry, čísla dílů a adresy zůstanou (žádné falešné nálezy)', () => {
  const keep = [
    'Cena 12 500 Kč, rok 2021, 150 000 Kč, rám 19".',
    'Cena 250 000 000 Kč',
    'Cena: 777 123 456 Kč',
    'cena 39 999,-Kč',
    'Inzerát 224568683, PSČ 393 01, PSČ 39301',
    'BOSCH SMART POWERTUBE 500/625/750 Wh',
    'pro výšku 160/170/180 cm',
    'Horizontální (číslo dílu: 0 275 007 543)',
    'pláště 622 25 28 32 mm',
    'teleskopická sedlovka 125 150 170 mm',
    'kazeta 7 8 9 10 11 12 rychlostí',
    'modely 2019-2020-2021, 2023/2024, vyrobeno 12.05.2023',
    'Shimano 105 R7000 2x11, kazeta 11-34, plášť 57-622, 29x2.25, 700x38C',
    'Rozměry:\n200\n150\n100',
    'Bosch Performance Line CX 85Nm 625Wh, 36V 13,4Ah, najeto 1 234 km',
    'Baterie Li-Ion (výr.č. ABC1D 123456789012)',
    'https://sport.bazos.cz/inzerat/224210521/spark.php',
    'https://www.example-kola.cz/bmc-twostroke/123456?v=654321&utm_id=12345678901&gclid=EAIaIQobChMIabc',
    'Prodám kolo Specialized Stumpjumper, velikost M, Praha 4',
    'Telč, okres Jihlava',
    'Dámské kolo pro paní. Prodám',
    // výčty trojic a čísla mimo číslovací plán ČR (62x, 30x … nejsou předčíslí)
    'velikosti rámu 480 500 520 540 mm',
    'Stránka: Předchozí 591 592 593 594 595 596',
    'ráfky ETRTO 622 584 559',
    'odkaz /p/622123456 a kód 301 123 456',
  ];
  for (const s of keep) assert.equal(scrub(s), s, s);
});

test('scrubContacts: idempotentní a s ne-řetězci', () => {
  const once = scrub('Volejte 777 12 34 56 Novák, mail jan.novak(at)seznam.cz, IČO 12345678, wa.me/420777123456');
  assert.equal(scrub(once), once);
  assert.equal(scrub(undefined), undefined);
  assert.equal(scrub(777123456), '[telefon skryt]');
  assert.equal(scrub(''), '');
});
