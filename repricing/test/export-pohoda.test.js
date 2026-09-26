'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { toPohodaXml, toPohodaXmlString, buildPohodaXml, packId } = require('../src/export/pohoda');
const { parseXml, decodeBuffer } = require('../src/formats');

const DOC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'POHODA.md'), 'utf8');
const EXAMPLES = [...DOC.matchAll(/```xml\n([\s\S]*?)```/g)].map((m) => m[1]);

/** Porovnání nezávislé na odsazení/zalomení: mezery mezi tagy pryč, bílé znaky uvnitř tagu sjednoceny. */
function norm(xml) {
  return xml
    .replace(/>\s+</g, '><')
    .replace(/<[^>]+>/g, (tag) => tag.replace(/\s+/g, ' '))
    .trim();
}

const ROWS_A = [
  { product_id: 1, proposal_id: 11, code: 'KOLO-TREK-FX2-M', ean: '8591234567890', price: 18990 },
  { product_id: 2, proposal_id: 12, code: 'PLAST-SCHW-29-2.35', ean: '4026495999999', price: 899 },
];

test('ukázky v docs/POHODA.md existují', () => {
  assert.equal(EXAMPLES.length, 2, 'očekávány ukázky (a) a (c)');
});

test('(a) aktualizace prodejní ceny podle kódu – shodné s ukázkou v docs/POHODA.md', () => {
  const xml = toPohodaXmlString(ROWS_A, { id: 'cenotvorba-20260925-0001', ico: '12345678' });
  assert.equal(xml, EXAMPLES[0], 'výstup je znak po znaku shodný s ukázkou');
  assert.equal(norm(xml), norm(EXAMPLES[0]));
});

test('(c) cena v cenové hladině (dis:discount) – shodné s ukázkou v docs/POHODA.md', () => {
  const xml = toPohodaXmlString([{ code: 'KOLO-TREK-FX2-M', price: 18490 }], {
    id: 'cenotvorba-20260925-0002',
    ico: '12345678',
    price_level: 'Eshop',
  });
  assert.equal(xml, EXAMPLES[1]);
});

test('(b) filtr podle EAN: ftr:EAN a v cenové hladině typ:EAN', () => {
  const xml = toPohodaXmlString(ROWS_A, { filter_by: 'ean', id: 'x' });
  const root = parseXml(xml, { keepNs: true });
  const filters = [];
  const walk = (n) => {
    if (n.name === 'ftr:filter') filters.push(n.children.map((c) => [c.name, c.text]));
    n.children.forEach(walk);
  };
  walk(root);
  assert.deepEqual(filters, [[['ftr:EAN', '8591234567890']], [['ftr:EAN', '4026495999999']]]);
  assert.ok(!xml.includes('ftr:code'));
  const lvl = toPohodaXmlString(ROWS_A, { filter_by: 'EAN', price_level: 'Eshop', id: 'x' });
  assert.ok(lvl.includes('<typ:EAN>8591234567890</typ:EAN>'));
  assert.ok(!lvl.includes('<typ:ids>KOLO'));
});

test('obálka: namespaces, version 2.0, povinné id/application/note, ico jen když je zadané', () => {
  const root = parseXml(toPohodaXmlString(ROWS_A, { ico: ' 123 456 78 ', application: 'Muj admin', note: 'Ruční export', id: 'balik-1' }), { keepNs: true });
  assert.equal(root.name, 'dat:dataPack');
  assert.equal(root.attrs.version, '2.0');
  assert.equal(root.attrs.id, 'balik-1');
  assert.equal(root.attrs.ico, '12345678', 'mezery v IČO pryč');
  assert.equal(root.attrs.application, 'Muj admin');
  assert.equal(root.attrs.note, 'Ruční export');
  assert.equal(root.attrs['xmlns:dat'], 'http://www.stormware.cz/schema/version_2/data.xsd');
  assert.equal(root.attrs['xmlns:stk'], 'http://www.stormware.cz/schema/version_2/stock.xsd');
  assert.equal(root.attrs['xmlns:ftr'], 'http://www.stormware.cz/schema/version_2/filter.xsd');
  assert.equal(root.attrs['xmlns:typ'], 'http://www.stormware.cz/schema/version_2/type.xsd');
  for (const item of root.children) {
    assert.equal(item.name, 'dat:dataPackItem');
    assert.equal(item.attrs.version, '2.0');
    assert.equal(item.children[0].name, 'stk:stock');
    assert.equal(item.children[0].attrs.version, '2.0');
  }
  const noIco = parseXml(toPohodaXmlString(ROWS_A, {}), { keepNs: true });
  assert.ok(!('ico' in noIco.attrs));
  assert.equal(noIco.attrs.application, 'Cenotvorba');
  assert.equal(noIco.attrs.note, 'Přecenění – 2 položky');
  assert.match(noIco.attrs.id, /^cenotvorba-\d{8}-[0-9a-f]{8}$/);
  const lvl = parseXml(toPohodaXmlString(ROWS_A, { price_level: 'Eshop' }), { keepNs: true });
  assert.equal(lvl.attrs['xmlns:dis'], 'http://www.stormware.cz/schema/version_2/discount.xsd');
  assert.ok(!('xmlns:stk' in lvl.attrs));
  assert.equal(lvl.children[0].children[0].name, 'dis:discount');
  // skloňování poznámky
  const one = parseXml(toPohodaXmlString(ROWS_A.slice(0, 1), {}), { keepNs: true });
  assert.equal(one.attrs.note, 'Přecenění – 1 položka');
  const many = Array.from({ length: 5 }, (_, i) => ({ code: 'K' + i, price: 100 + i }));
  assert.equal(parseXml(toPohodaXmlString(many, {}), { keepNs: true }).attrs.note, 'Přecenění – 5 položek');
});

test('id položek unikátní a po sobě jdoucí; vynechané řádky se hlásí', () => {
  const rows = [
    { product_id: 1, proposal_id: 1, code: 'A', ean: '8591111111111', price: 100 },
    { product_id: 2, proposal_id: 2, code: '', ean: '8592222222222', price: 200 },
    { product_id: 3, proposal_id: 3, code: 'C', ean: null, price: 300 },
    { product_id: 4, proposal_id: 4, code: 'D', ean: '8591111111111', price: 400 },
    { product_id: 5, proposal_id: 5, code: 'E', ean: '8595555555555', price: 0 },
    { product_id: 6, proposal_id: 6, code: 'F', ean: '8596666666666', price: 12365.5 },
    { product_id: 7, proposal_id: 7, code: '   ', ean: '8597777777777', price: null },
  ];
  const byCode = buildPohodaXml(rows, { id: 'x' });
  assert.equal(byCode.count, 4);
  assert.deepEqual(byCode.rows.map((r) => r.code), ['A', 'C', 'D', 'F']);
  assert.deepEqual(byCode.skipped.map((s) => [s.product_id, s.reason]), [
    [2, 'no_code'],
    [5, 'invalid_price'],
    [7, 'no_code'],
  ]);
  assert.ok(byCode.skipped.every((s) => typeof s.message === 'string' && s.message));
  const root = parseXml(byCode.xml, { keepNs: true });
  const ids = root.children.map((c) => c.attrs.id);
  assert.deepEqual(ids, ['CT-000001', 'CT-000002', 'CT-000003', 'CT-000004']);
  assert.ok(byCode.xml.includes('<stk:sellingPrice payVAT="true">12365.5</stk:sellingPrice>'));

  const byEan = buildPohodaXml(rows, { filter_by: 'ean', id: 'x' });
  assert.deepEqual(byEan.rows.map((r) => r.product_id), [2, 6]);
  assert.deepEqual(byEan.skipped.map((s) => [s.product_id, s.reason]), [
    [3, 'no_ean'],
    [5, 'invalid_price'],
    [7, 'invalid_price'],
    [1, 'duplicate_ean'],
    [4, 'duplicate_ean'],
  ]);
});

test('kódování: výchozí windows-1250 (deklarace + bajty), volitelně UTF-8', () => {
  const buf = toPohodaXml(ROWS_A, { id: 'x', note: 'Přecenění – žluťoučký kůň €' });
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.subarray(0, 60).toString('latin1').startsWith('<?xml version="1.0" encoding="Windows-1250"?>'));
  const expected = Buffer.from([0x50, 0xf8, 0x65, 0x63, 0x65, 0x6e, 0xec, 0x6e, 0xed, 0x20, 0x96]); // „Přecenění –“
  assert.ok(buf.includes(expected), 'ř/ě/í a pomlčka v cp1250');
  assert.ok(!buf.includes(Buffer.from('ř', 'utf8')));
  const text = decodeBuffer(buf);
  assert.ok(text.includes('note="Přecenění – žluťoučký kůň €"'));
  assert.equal(parseXml(text, { keepNs: true }).attrs.note, 'Přecenění – žluťoučký kůň €');
  // znak mimo cp1250 → „?“
  assert.ok(decodeBuffer(toPohodaXml(ROWS_A, { id: 'x', note: 'kolo 🚲' })).includes('note="kolo ?"'));

  const u = buildPohodaXml(ROWS_A, { id: 'x', encoding: 'utf-8', note: 'Přecenění' });
  assert.ok(u.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(u.buffer.includes(Buffer.from('Přecenění', 'utf8')));
  assert.equal(u.contentType, 'application/xml; charset=utf-8');
  assert.equal(buildPohodaXml(ROWS_A, { id: 'x' }).contentType, 'application/xml; charset=windows-1250');
  assert.equal(buildPohodaXml(ROWS_A, { id: 'x', encoding: 'CP1250' }).encoding, 'windows-1250');
  // řetězcová varianta nese deklaraci podle zvoleného kódování
  assert.ok(toPohodaXmlString(ROWS_A, { id: 'x' }).startsWith('<?xml version="1.0" encoding="Windows-1250"?>'));
});

test('escapování, id balíku, neplatné volby', () => {
  const xml = toPohodaXmlString([{ code: 'A&B<"1">', price: 10 }], { id: 'x', application: 'App "X"', price_level: 'Hladina & spol.' });
  const root = parseXml(xml, { keepNs: true });
  assert.equal(root.attrs.application, 'App "X"');
  assert.ok(xml.includes('<typ:ids>A&amp;B&lt;&quot;1&quot;&gt;</typ:ids>'));
  assert.ok(xml.includes('<typ:ids>Hladina &amp; spol.</typ:ids>'));

  assert.equal(packId({ export_id: 12, now: '2026-09-24T22:30:00Z' }), 'cenotvorba-20260925-0012', 'datum v pražském čase');
  assert.equal(packId({ export_id: 123456, now: '2026-01-05T10:00:00Z' }), 'cenotvorba-20260105-123456');
  assert.equal(packId({ id: 'x'.repeat(100) }).length, 64);
  assert.notEqual(packId({}), packId({}), 'náhodná id se liší');

  assert.throws(() => toPohodaXml(ROWS_A, { encoding: 'latin2' }), /Nepodporované kódování/);
  assert.throws(() => toPohodaXml(ROWS_A, { filter_by: 'mpn' }), /Neplatný způsob párování/);
  // prázdné volby ze settings = výchozí
  const d = buildPohodaXml(ROWS_A, { filter_by: '', encoding: '', price_level: '', ico: '' });
  assert.equal(d.encoding, 'windows-1250');
  assert.ok(d.xml.includes('<ftr:code>KOLO-TREK-FX2-M</ftr:code>'));
  // prázdný balík XSD nepovoluje → chyba POHODA_EMPTY (409) se seznamem vynechaných
  assert.throws(() => buildPohodaXml([], { id: 'x' }), (e) => e.code === 'POHODA_EMPTY' && e.status === 409 && /Žádné změny/.test(e.message));
  assert.throws(
    () => toPohodaXml([{ product_id: 9, code: 'A', ean: null, price: 10 }], { filter_by: 'ean' }),
    (e) => e.code === 'POHODA_EMPTY' && e.skipped.length === 1 && e.skipped[0].reason === 'no_ean' && /chybí EAN/.test(e.message)
  );
});

test('validace XSD (xmllint) když je nastaveno POHODA_XSD_DIR', (t) => {
  const dir = process.env.POHODA_XSD_DIR;
  if (!dir) return t.skip('POHODA_XSD_DIR není nastaveno');
  if (spawnSync('xmllint', ['--version']).error) return t.skip('xmllint není nainstalován');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-pohoda-'));
  try {
    const rows = [...ROWS_A, { code: 'ŽLUŤ-KŮŇ & <1>', ean: '8590000000011', price: 1234.56 }];
    const variants = [
      ['code-1250.xml', toPohodaXml(rows, { ico: '12345678' })],
      ['ean-utf8.xml', toPohodaXml(rows, { filter_by: 'ean', encoding: 'utf-8' })],
      ['level-1250.xml', toPohodaXml(rows, { price_level: 'Eshop', ico: '12345678' })],
      ['level-ean-utf8.xml', toPohodaXml(rows, { price_level: 'Eshop', filter_by: 'ean', encoding: 'utf-8' })],
      ['one.xml', toPohodaXml(rows.slice(0, 1), { id: 'cenotvorba-20260925-0001' })],
    ];
    for (const [name, buf] of variants) {
      const file = path.join(tmp, name);
      fs.writeFileSync(file, buf);
      const r = spawnSync('xmllint', ['--noout', '--schema', path.join(dir, 'data.xsd'), file], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('money-12: cenová hladina bez DPH – do dis:price jde cena bez DPH podle sazby řádku', () => {
  const rows = [
    { code: 'K1', price: 12100, vat_rate: 21, proposal_id: 1, product_id: 1 },
    { code: 'K2', price: 1120, vat_rate: 12, proposal_id: 2, product_id: 2 },
  ];
  const withVat = buildPohodaXml(rows, { price_level: 'Eshop' }).xml;
  assert.match(withVat, /<dis:price>12100<\/dis:price>/);
  const net = buildPohodaXml(rows, { price_level: 'Eshop', price_level_includes_vat: false }).xml;
  assert.match(net, /<dis:price>10000<\/dis:price>/);
  assert.match(net, /<dis:price>1000<\/dis:price>/);
  // bez hladiny (stk:sellingPrice payVAT="true") se volba neuplatní
  const plain = buildPohodaXml(rows, { price_level_includes_vat: false }).xml;
  assert.match(plain, /<stk:sellingPrice payVAT="true">12100<\/stk:sellingPrice>/);
});
