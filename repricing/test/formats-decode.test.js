'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { decodeBuffer, encodeWindows1250, detectFormat, normalizeEncoding } = require('../src/formats/decode.js');

const CZ = 'ěščřžýáíéůúťďňó ĚŠČŘŽÝÁÍÉŮÚŤĎŇÓ';
const PANGRAM = 'Příliš žluťoučký kůň úpěl ďábelské ódy';

// Oficiální mapování (Unicode/WHATWG), vygenerováno: python3 -c "print(bytes(range(128,256)).decode('cp1250', errors='replace'))"
// Nedefinované pozice (0x81 0x83 0x88 0x90 0x98) mapujeme podle WHATWG na řídicí znak se stejným kódem.
const CP1250_HIGH =
  '€\u0081‚\u0083„…†‡\u0088‰Š‹ŚŤŽŹ\u0090‘’“”•–—\u0098™š›śťžź' +
  ' ˇ˘Ł¤Ą¦§¨©Ş«¬­®Ż°±˛ł´µ¶·¸ąş»Ľ˝ľż' +
  'ŔÁÂĂÄĹĆÇČÉĘËĚÍÎĎĐŃŇÓÔŐÖ×ŘŮÚŰÜÝŢßŕáâăäĺćçčéęëěíîďđńňóôőö÷řůúűüýţ˙';
const ISO88592_HIGH =
  Array.from({ length: 32 }, (_, i) => String.fromCharCode(0x80 + i)).join('') +
  ' Ą˘Ł¤ĽŚ§¨ŠŞŤŹ­ŽŻ°ą˛ł´ľśˇ¸šşťź˝žż' +
  'ŔÁÂĂÄĹĆÇČÉĘËĚÍÎĎĐŃŇÓÔŐÖ×ŘŮÚŰÜÝŢßŕáâăäĺćçčéęëěíîďđńňóôőö÷řůúűüýţ˙';

const highBytes = () => Buffer.from(Array.from({ length: 128 }, (_, i) => 128 + i));

test('windows-1250: všech 128 horních znaků odpovídá oficiální mapě', () => {
  const s = decodeBuffer(highBytes(), { encoding: 'windows-1250' });
  assert.strictEqual(s.length, 128);
  assert.strictEqual(s, CP1250_HIGH);
  // namátkové kontroly ze zadání
  const at = (b) => s[b - 128];
  assert.deepStrictEqual(
    [0x8a, 0x9a, 0x8e, 0x9e, 0xc8, 0xe8, 0xd8, 0xf8, 0xcc, 0xec, 0xd9, 0xf9, 0x8d, 0x9d, 0xcf, 0xef, 0xd2, 0xf2].map(at).join(''),
    'ŠšŽžČčŘřĚěŮůŤťĎďŇň'
  );
});

test('iso-8859-2: všech 128 horních znaků odpovídá oficiální mapě', () => {
  const s = decodeBuffer(highBytes(), { encoding: 'iso-8859-2' });
  assert.strictEqual(s, ISO88592_HIGH);
});

test('tabulky souhlasí s TextDecoder (full-ICU), je-li k dispozici', (t) => {
  for (const enc of ['windows-1250', 'iso-8859-2', 'windows-1252']) {
    let td;
    try {
      td = new TextDecoder(enc);
    } catch {
      t.skip(`TextDecoder nepodporuje ${enc}`);
      continue;
    }
    assert.strictEqual(decodeBuffer(highBytes(), { encoding: enc }), td.decode(highBytes()), enc);
  }
});

test('encodeWindows1250 → decodeBuffer je bezztrátové pro češtinu', () => {
  const text = `${PANGRAM} ${CZ} „uvozovky“ – € … ©`;
  const buf = encodeWindows1250(text);
  assert.strictEqual(buf.length, text.length); // jeden bajt na znak
  assert.strictEqual(buf[text.indexOf('Š')], 0x8a);
  assert.strictEqual(decodeBuffer(buf, { encoding: 'cp1250' }), text);
  // autodetekce (neplatné UTF-8 → windows-1250)
  assert.strictEqual(decodeBuffer(buf), text);
});

test('encodeWindows1250: nezobrazitelné znaky → ?, NFC normalizace, emoji jako jeden ?', () => {
  assert.strictEqual(encodeWindows1250('a漢b').toString('latin1'), 'a?b');
  assert.strictEqual(encodeWindows1250('x😀y').toString('latin1'), 'x?y');
  const decomposed = 'ě'; // e + háček → ě
  assert.deepStrictEqual([...encodeWindows1250(decomposed)], [0xec]);
  assert.strictEqual(encodeWindows1250(null).length, 0);
});

test('BOM: UTF-8, UTF-16LE, UTF-16BE (BOM má přednost i před explicitním kódováním)', () => {
  const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(PANGRAM)]);
  assert.strictEqual(decodeBuffer(utf8), PANGRAM);
  assert.strictEqual(decodeBuffer(utf8, { encoding: 'windows-1250' }), PANGRAM);
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(PANGRAM, 'utf16le')]);
  assert.strictEqual(decodeBuffer(le), PANGRAM);
  const be = Buffer.from(le);
  for (let i = 0; i < be.length; i += 2) [be[i], be[i + 1]] = [be[i + 1], be[i]];
  assert.strictEqual(decodeBuffer(be), PANGRAM);
});

test('UTF-16 XML bez BOM se pozná podle „<?“', () => {
  const xml = '<?xml version="1.0" encoding="UTF-16"?><a>Žluť</a>';
  assert.strictEqual(decodeBuffer(Buffer.from(xml, 'utf16le')), xml);
});

test('charset z Content-Type a encoding z XML deklarace', () => {
  const body = encodeWindows1250(PANGRAM);
  assert.strictEqual(decodeBuffer(body, { contentType: 'text/csv; charset=windows-1250' }), PANGRAM);
  assert.strictEqual(decodeBuffer(body, { contentType: 'text/csv; charset="CP1250"' }), PANGRAM);
  const xml = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="windows-1250"?>\n<a>'), body, Buffer.from('</a>')]);
  assert.strictEqual(decodeBuffer(xml), `<?xml version="1.0" encoding="windows-1250"?>\n<a>${PANGRAM}</a>`);
  const xml2 = Buffer.concat([Buffer.from("<?xml version='1.0' encoding='ISO-8859-2'?><a>"), Buffer.from([0xa9, 0xb9]), Buffer.from('</a>')]);
  assert.strictEqual(decodeBuffer(xml2), "<?xml version='1.0' encoding='ISO-8859-2'?><a>Šš</a>");
});

test('deklarované jednobajtové kódování, ale obsah je platné UTF-8 → UTF-8', () => {
  const xml = `<?xml version="1.0" encoding="windows-1250"?><a>${PANGRAM}</a>`;
  assert.strictEqual(decodeBuffer(Buffer.from(xml)), xml);
  assert.strictEqual(decodeBuffer(Buffer.from(PANGRAM), { contentType: 'text/plain; charset=ISO-8859-1' }), PANGRAM);
  // explicitní kódování se ale dodrží vždy
  assert.notStrictEqual(decodeBuffer(Buffer.from(PANGRAM), { encoding: 'windows-1250' }), PANGRAM);
});

test('výchozí UTF-8; UTF-8 s ojedinělým vadným bajtem zůstane UTF-8', () => {
  assert.strictEqual(decodeBuffer(Buffer.from(PANGRAM)), PANGRAM);
  const broken = Buffer.concat([Buffer.from(PANGRAM + ' '), Buffer.from([0xff]), Buffer.from(' ' + CZ)]);
  const s = decodeBuffer(broken);
  assert.ok(s.startsWith(PANGRAM));
  assert.ok(s.endsWith(CZ));
  assert.ok(s.includes('�'));
});

test('fallback rozliší windows-1250 a ISO-8859-2', () => {
  const cp = encodeWindows1250(`kód;název\n1;${PANGRAM} Šťastný Žďár`);
  assert.strictEqual(decodeBuffer(cp), `kód;název\n1;${PANGRAM} Šťastný Žďár`);
  // stejný text v ISO-8859-2 (Š ť Ž ž š jsou na jiných pozicích)
  const td = (() => {
    try {
      return new TextDecoder('iso-8859-2');
    } catch {
      return null;
    }
  })();
  const isoMap = new Map();
  for (let b = 0; b < 256; b++) isoMap.set(decodeBuffer(Buffer.from([b]), { encoding: 'iso-8859-2' }), b);
  const text = 'Šťastný Žďár, šťáva, žluťoučký';
  const iso = Buffer.from(Array.from(text).map((c) => isoMap.get(c)));
  assert.strictEqual(decodeBuffer(iso), text);
  if (td) assert.strictEqual(td.decode(iso), text);
});

test('windows-1252 / latin1 / neznámé kódování', () => {
  assert.strictEqual(decodeBuffer(Buffer.from([0x80, 0xe9]), { encoding: 'latin1' }), '€é');
  assert.strictEqual(decodeBuffer(Buffer.from([0x80, 0xe9]), { encoding: 'windows-1252' }), '€é');
  assert.throws(() => decodeBuffer(Buffer.from('a'), { encoding: 'x-neexistuje' }), /Nepodporované kódování/);
  assert.strictEqual(decodeBuffer(Buffer.from('abc'), { encoding: 'auto' }), 'abc');
});

test('normalizeEncoding', () => {
  assert.strictEqual(normalizeEncoding('CP1250'), 'windows-1250');
  assert.strictEqual(normalizeEncoding('Windows-1250'), 'windows-1250');
  assert.strictEqual(normalizeEncoding('latin2'), 'iso-8859-2');
  assert.strictEqual(normalizeEncoding('UTF8'), 'utf-8');
  assert.strictEqual(normalizeEncoding(''), null);
  assert.strictEqual(normalizeEncoding('auto'), null);
});

test('decodeBuffer přijme i řetězec, Uint8Array a prázdný vstup', () => {
  assert.strictEqual(decodeBuffer('﻿abc'), 'abc');
  assert.strictEqual(decodeBuffer(new Uint8Array([0x61, 0x62])), 'ab');
  assert.strictEqual(decodeBuffer(Buffer.alloc(0)), '');
});

test('velký windows-1250 soubor se dekóduje rychle', () => {
  const line = encodeWindows1250(`KOLO-1;${PANGRAM};12 990,50\r\n`);
  const buf = Buffer.concat(Array.from({ length: 50000 }, () => line)); // ~3 MB
  const t0 = Date.now();
  const s = decodeBuffer(buf);
  assert.ok(Date.now() - t0 < 3000);
  assert.ok(s.startsWith(`KOLO-1;${PANGRAM};`));
  assert.strictEqual(s.length, buf.length);
});

test('detectFormat', () => {
  assert.strictEqual(detectFormat(Buffer.from('  \n{"items": []}')), 'json');
  assert.strictEqual(detectFormat('[1,2]'), 'json');
  assert.strictEqual(detectFormat(Buffer.from('﻿<?xml version="1.0"?><a/>')), 'xml');
  assert.strictEqual(detectFormat(Buffer.from('<SHOP></SHOP>', 'utf16le')), 'xml'); // UTF-16LE bez BOM
  assert.strictEqual(decodeBuffer(Buffer.from('<SHOP>Žluť</SHOP>', 'utf16le')), '<SHOP>Žluť</SHOP>');
  assert.strictEqual(detectFormat(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<SHOP/>', 'utf16le')])), 'xml');
  assert.strictEqual(detectFormat(Buffer.from('kód;cena\nA;1')), 'csv');
  assert.strictEqual(detectFormat(encodeWindows1250('Kód;Název\nA;Žluť')), 'csv');
  assert.strictEqual(detectFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])), 'xlsx');
  assert.strictEqual(detectFormat(Buffer.alloc(0), { filename: 'x.json' }), 'json');
  assert.strictEqual(detectFormat('', { contentType: 'application/xml' }), 'xml');
  assert.strictEqual(detectFormat(''), 'csv');
  assert.throws(() => detectFormat(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), (e) => e.code === 'UNSUPPORTED_FORMAT' && /xls/.test(e.message));
  assert.throws(() => detectFormat(Buffer.from([0x1f, 0x8b, 8, 0])), /gzip/);
});
