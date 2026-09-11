const test = require('node:test');
const assert = require('node:assert');
const D = require('../lib/detector.js');

const longLegal = ('Tyto obchodní podmínky upravují práva a povinnosti prodávajícího a kupujícího. Kupující bere na vědomí, že smlouva je uzavřena odesláním objednávky. Spotřebitel má právo odstoupit od smlouvy do 14 dnů. Osobní údaje jsou zpracovány podle GDPR. Poskytovatel neodpovídá za škodu. Reklamace se řídí reklamačním řádem. Ustanovení těchto podmínek jsou závazná. ').repeat(12);

test('rozpozná dokument s podmínkami podle nadpisu a textu', () => {
  const r = D.detect({ url: 'https://eshop.cz/informace', title: 'Obchodní podmínky | E-shop', headings: ['Všeobecné obchodní podmínky'], text: longLegal, links: [] });
  assert.strictEqual(r.kind, 'document');
});

test('rozpozná dokument podle URL a hustoty textu', () => {
  const r = D.detect({ url: 'https://example.com/legal/terms-of-service', title: 'Example', headings: [], text: longLegal, links: [] });
  assert.strictEqual(r.kind, 'document');
});

test('krátká stránka s nadpisem není dokument', () => {
  const r = D.detect({ url: 'https://example.com/', title: 'Obchodní podmínky', headings: [], text: 'krátký text', links: [] });
  assert.notStrictEqual(r.kind, 'document');
});

test('pokladna s odkazem na podmínky a souhlasem = kontext souhlasu', () => {
  const r = D.detect({
    url: 'https://eshop.cz/kosik/dokonceni',
    title: 'Dokončení objednávky',
    headings: ['Pokladna'],
    buttons: ['Objednat a zaplatit'],
    labels: ['Souhlasím s obchodními podmínkami a zásadami ochrany osobních údajů'],
    text: 'Vaše objednávka…',
    links: [{ href: '/obchodni-podminky', text: 'obchodními podmínkami' }, { href: '/gdpr', text: 'zásadami ochrany osobních údajů' }, { href: '/produkt/1', text: 'Kolo' }],
    hasPaymentField: true,
  });
  assert.strictEqual(r.kind, 'consent');
  assert.ok(r.context.includes('checkout'));
  assert.strictEqual(r.termsLinks.length, 2);
  assert.strictEqual(r.termsLinks[0].url, 'https://eshop.cz/obchodni-podminky');
});

test('registrace v angličtině', () => {
  const r = D.detect({
    url: 'https://app.example.com/signup', title: 'Create your account', headings: ['Sign up'],
    buttons: ['Create account'], labels: ['I agree to the Terms of Service and Privacy Policy'], text: '',
    links: [{ href: 'https://example.com/terms', text: 'Terms of Service' }, { href: 'https://example.com/privacy', text: 'Privacy Policy' }],
    hasPasswordField: true,
  });
  assert.strictEqual(r.kind, 'consent');
  assert.ok(r.context.includes('signup'));
  assert.deepStrictEqual(r.termsLinks.map((l) => l.type).sort(), ['podminky', 'soukromi']);
});

test('obchod s aplikacemi je instalační kontext', () => {
  const r = D.detect({
    url: 'https://chromewebstore.google.com/detail/abc/xyz', title: 'Super Extension', headings: ['Super Extension'],
    buttons: ['Add to Chrome'], labels: [], text: 'By installing you agree to the terms',
    links: [{ href: 'https://dev.example.com/privacy', text: 'Privacy policy' }],
  });
  assert.strictEqual(r.kind, 'consent');
  assert.ok(r.context.includes('install'));
});

test('běžná stránka s produktem není nic', () => {
  const r = D.detect({ url: 'https://eshop.cz/produkt/kolo', title: 'Horské kolo', headings: ['Horské kolo'], buttons: ['Do košíku'], labels: [], text: 'Skvělé kolo za skvělou cenu.', links: [{ href: '/obchodni-podminky', text: 'Obchodní podmínky' }] });
  assert.strictEqual(r.kind, 'none');
});

test('findTermsLinks ignoruje neplatné a duplicitní odkazy', () => {
  const links = D.findTermsLinks([{ href: 'javascript:void(0)', text: 'terms' }, { href: '/vop', text: 'VOP' }, { href: '/vop#top', text: 'VOP' }, { href: 'mailto:a@b.cz', text: 'privacy' }], 'https://x.cz/');
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].url, 'https://x.cz/vop');
});
