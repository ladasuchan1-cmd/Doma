'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  parseXml,
  xmlToObject,
  streamRecords,
  detectItemPath,
  escapeXml,
  el,
  XmlWriter,
  XmlError,
} = require('../src/formats/xml.js');
const { encodeWindows1250 } = require('../src/formats/decode.js');

const HEUREKA = `<?xml version="1.0" encoding="utf-8"?>
<!-- export pro Heureku -->
<SHOP xmlns="http://www.zbozi.cz/ns/offer/1.0">
  <SHOPITEM>
    <ITEM_ID>KOLO-001</ITEM_ID>
    <PRODUCTNAME>Horské kolo Žluťoučký kůň &amp; spol.</PRODUCTNAME>
    <PRODUCT><![CDATA[Kolo <b>tučně</b> & "uvozovky"]]></PRODUCT>
    <DESCRIPTION>
      Víceřádkový
      popis
    </DESCRIPTION>
    <URL>https://www.example.cz/kolo?a=1&amp;b=2</URL>
    <PRICE_VAT>12990.00</PRICE_VAT>
    <EAN>8590000000017</EAN>
    <PARAM>
      <PARAM_NAME>Barva</PARAM_NAME>
      <VAL>modrá</VAL>
    </PARAM>
    <PARAM>
      <PARAM_NAME>Velikost rámu</PARAM_NAME>
      <VAL>L</VAL>
    </PARAM>
    <PARAM>
      <PARAM_NAME>Kola</PARAM_NAME>
      <VAL>29&quot;</VAL>
    </PARAM>
    <DELIVERY_DATE>0</DELIVERY_DATE>
    <DELIVERY>
      <DELIVERY_ID>PPL</DELIVERY_ID>
      <DELIVERY_PRICE>149</DELIVERY_PRICE>
    </DELIVERY>
    <GIFT/>
  </SHOPITEM>
  <SHOPITEM>
    <ITEM_ID>KOLO-002</ITEM_ID>
    <PRODUCTNAME>Silniční kolo</PRODUCTNAME>
    <PRICE_VAT>45 990</PRICE_VAT>
    <PARAM>
      <PARAM_NAME>Barva</PARAM_NAME>
      <VAL>černá</VAL>
    </PARAM>
    <DELIVERY_DATE>3</DELIVERY_DATE>
  </SHOPITEM>
</SHOP>
`;

const GOOGLE = `<?xml version="1.0"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Kola s.r.o.</title>
    <link>https://www.kola.cz</link>
    <description>Feed</description>
    <item>
      <g:id>A1</g:id>
      <title>Kolo Trek Marlin 7</title>
      <link>https://www.kola.cz/a1</link>
      <g:price>12990.00 CZK</g:price>
      <g:sale_price>11990.00 CZK</g:sale_price>
      <g:gtin>0601842789234</g:gtin>
      <g:availability>in stock</g:availability>
      <g:shipping>
        <g:country>CZ</g:country>
        <g:price>99 CZK</g:price>
      </g:shipping>
    </item>
    <item>
      <g:id>A2</g:id>
      <title>Helma</title>
      <g:price>1290.00 CZK</g:price>
      <g:gtin>8590000000024</g:gtin>
      <g:availability>out of stock</g:availability>
    </item>
  </channel>
</rss>`;

const POHODA_PACK = `<?xml version="1.0" encoding="Windows-1250"?>
<dat:dataPack xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd" xmlns:stk="http://www.stormware.cz/schema/version_2/stock.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" id="Zasoby01" ico='12345678' application="Cenotvorba" version="2.0" note="Import cen">
  <dat:dataPackItem id="1" version="2.0">
    <stk:stock version="2.0">
      <stk:stockHeader>
        <stk:code>KOLO-001</stk:code>
        <stk:EAN>8590000000017</stk:EAN>
        <stk:name>Horské kolo Žluťoučký kůň</stk:name>
        <stk:sellingPrice>12990</stk:sellingPrice>
        <stk:storage><typ:ids>Sklad</typ:ids></stk:storage>
      </stk:stockHeader>
      <stk:stockPriceItem>
        <stk:stockPrice><typ:ids>MOC</typ:ids><typ:price>13990</typ:price></stk:stockPrice>
        <stk:stockPrice><typ:ids>VO</typ:ids><typ:price>10990</typ:price></stk:stockPrice>
      </stk:stockPriceItem>
    </stk:stock>
  </dat:dataPackItem>
  <dat:dataPackItem id="2" version="2.0">
    <stk:stock version="2.0">
      <stk:stockHeader>
        <stk:code>KOLO-002</stk:code>
        <stk:name>Ďábelské ódy</stk:name>
        <stk:sellingPrice>45990</stk:sellingPrice>
      </stk:stockHeader>
    </stk:stock>
  </dat:dataPackItem>
</dat:dataPack>`;

const POHODA_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
<rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" xmlns:lStk="http://www.stormware.cz/schema/version_2/list_stock.xsd" xmlns:stk="http://www.stormware.cz/schema/version_2/stock.xsd" version="2.0" id="001" state="ok">
  <rsp:responsePackItem version="2.0" id="001" state="ok">
    <lStk:listStock version="2.0" dateTimeStamp="2026-09-25T10:00:00" state="ok">
      <lStk:stock version="2.0"><stk:stockHeader><stk:id>1</stk:id><stk:code>A</stk:code></stk:stockHeader></lStk:stock>
      <lStk:stock version="2.0"><stk:stockHeader><stk:id>2</stk:id><stk:code>B</stk:code></stk:stockHeader></lStk:stock>
      <lStk:stock version="2.0"><stk:stockHeader><stk:id>3</stk:id><stk:code>C</stk:code></stk:stockHeader></lStk:stock>
    </lStk:listStock>
  </rsp:responsePackItem>
</rsp:responsePack>`;

test('parseXml: Heureka – deklarace, komentář, CDATA, entity, bílé znaky, prázdný element', () => {
  const root = parseXml(HEUREKA);
  assert.strictEqual(root.name, 'SHOP');
  assert.deepStrictEqual(root.attrs, {}); // xmlns se při odstranění prefixů vynechá
  assert.strictEqual(root.children.length, 2);
  const item = root.children[0];
  const get = (n) => item.children.find((c) => c.name === n);
  assert.strictEqual(get('PRODUCTNAME').text, 'Horské kolo Žluťoučký kůň & spol.');
  assert.strictEqual(get('PRODUCT').text, 'Kolo <b>tučně</b> & "uvozovky"');
  assert.strictEqual(get('DESCRIPTION').text, 'Víceřádkový\n      popis');
  assert.strictEqual(get('URL').text, 'https://www.example.cz/kolo?a=1&b=2');
  assert.strictEqual(get('GIFT').text, '');
  assert.strictEqual(item.text, '');
  assert.strictEqual(item.children.filter((c) => c.name === 'PARAM').length, 3);
});

test('xmlToObject: pole pro opakované elementy, text, prázdné → ""', () => {
  const obj = xmlToObject(parseXml(HEUREKA).children[0]);
  assert.strictEqual(obj.ITEM_ID, 'KOLO-001');
  assert.strictEqual(obj.PRICE_VAT, '12990.00');
  assert.deepStrictEqual(obj.PARAM, [
    { PARAM_NAME: 'Barva', VAL: 'modrá' },
    { PARAM_NAME: 'Velikost rámu', VAL: 'L' },
    { PARAM_NAME: 'Kola', VAL: '29"' },
  ]);
  assert.strictEqual(obj.DELIVERY_DATE, '0');
  assert.deepStrictEqual(obj.DELIVERY, { DELIVERY_ID: 'PPL', DELIVERY_PRICE: '149' });
  assert.strictEqual(obj.GIFT, '');
  const second = xmlToObject(parseXml(HEUREKA).children[1]);
  assert.deepStrictEqual(second.PARAM, { PARAM_NAME: 'Barva', VAL: 'černá' }); // jeden výskyt → objekt
});

test('xmlToObject: atributy jako @název, atributy + text → #text', () => {
  const root = parseXml(`<offers><offer id='1' shop="Kola &amp; spol">12 990 Kč</offer><offer id="2"/><x a="1"><y>t</y>smíšený</x></offers>`);
  const o = xmlToObject(root);
  assert.deepStrictEqual(o.offer, [{ '@id': '1', '@shop': 'Kola & spol', '#text': '12 990 Kč' }, { '@id': '2' }]);
  assert.deepStrictEqual(o.x, { '@a': '1', y: 't', '#text': 'smíšený' });
});

test('xmlToObject: názvy jako constructor/__proto__ nevedou ke znečištění prototypu', () => {
  const o = xmlToObject(parseXml('<a><constructor>1</constructor><toString>2</toString><__proto__>3</__proto__><__proto__>4</__proto__></a>'));
  assert.strictEqual(o.constructor, '1');
  assert.strictEqual(o.toString, '2');
  assert.deepStrictEqual(Object.getOwnPropertyDescriptor(o, '__proto__').value, ['3', '4']);
  assert.strictEqual(Object.getPrototypeOf(o), Object.prototype);
  assert.strictEqual({}.polluted, undefined);
});

test('Google Merchant RSS: prefix g: se odstraní, keepNs ho ponechá', () => {
  const items = [];
  const n = streamRecords(GOOGLE, { itemPath: 'rss.channel.item' }, (r) => items.push(r));
  assert.strictEqual(n, 2);
  assert.strictEqual(items[0].id, 'A1');
  assert.strictEqual(items[0].price, '12990.00 CZK');
  assert.strictEqual(items[0].gtin, '0601842789234');
  assert.deepStrictEqual(items[0].shipping, { country: 'CZ', price: '99 CZK' });
  assert.strictEqual(items[1].availability, 'out of stock');

  const nsItems = [];
  streamRecords(GOOGLE, { itemPath: 'rss.channel.item', keepNs: true }, (r) => nsItems.push(r));
  assert.strictEqual(nsItems[0]['g:price'], '12990.00 CZK');
  assert.strictEqual(nsItems[0]['g:gtin'], '0601842789234');
  const root = parseXml(GOOGLE, { keepNs: true });
  assert.strictEqual(root.attrs['xmlns:g'], 'http://base.google.com/ns/1.0');
  assert.strictEqual(detectItemPath(GOOGLE), 'rss.channel.item');
});

test('POHODA dataPack ve windows-1250 (dat:/stk:/typ:), atribut v apostrofech', () => {
  const buf = encodeWindows1250(POHODA_PACK);
  const root = parseXml(buf); // Buffer → decodeBuffer podle XML deklarace
  assert.strictEqual(root.name, 'dataPack');
  assert.strictEqual(root.attrs.ico, '12345678');
  assert.strictEqual(root.attrs.id, 'Zasoby01');
  assert.strictEqual(detectItemPath(POHODA_PACK), 'dataPack.dataPackItem');
  const recs = [];
  streamRecords(buf, { itemPath: 'dataPack.dataPackItem' }, (r) => recs.push(r));
  assert.strictEqual(recs.length, 2);
  assert.strictEqual(recs[0]['@id'], '1');
  assert.strictEqual(recs[0].stock.stockHeader.name, 'Horské kolo Žluťoučký kůň');
  assert.strictEqual(recs[0].stock.stockHeader.storage.ids, 'Sklad');
  assert.deepStrictEqual(recs[0].stock.stockPriceItem.stockPrice, [
    { ids: 'MOC', price: '13990' },
    { ids: 'VO', price: '10990' },
  ]);
  assert.strictEqual(recs[1].stock.stockHeader.name, 'Ďábelské ódy');
  // s plnými názvy
  const nsRoot = parseXml(POHODA_PACK, { keepNs: true });
  assert.strictEqual(nsRoot.name, 'dat:dataPack');
  assert.strictEqual(detectItemPath(POHODA_PACK, { keepNs: true }), 'dat:dataPack.dat:dataPackItem');
  const n = streamRecords(POHODA_PACK, { itemPath: 'dat:dataPack.dat:dataPackItem', keepNs: true }, () => {});
  assert.strictEqual(n, 2);
  // itemPath s prefixy funguje i bez keepNs (prefixy se z cesty odstraní)
  assert.strictEqual(streamRecords(POHODA_PACK, { itemPath: 'dat:dataPack/dat:dataPackItem' }, () => {}), 2);
});

test('detectItemPath: Heureka, POHODA responsePack, products.product s vnořenými nabídkami', () => {
  assert.strictEqual(detectItemPath(HEUREKA), 'SHOP.SHOPITEM');
  assert.strictEqual(detectItemPath(POHODA_RESPONSE), 'responsePack.responsePackItem.listStock.stock');
  const nested = `<products>
    <product><code>A1</code><offers><offer><shop>X</shop><price>1</price></offer><offer><shop>Y</shop><price>2</price></offer><offer><shop>Z</shop><price>3</price></offer></offers></product>
    <product><code>A2</code><offers><offer><shop>X</shop><price>1</price></offer></offers></product>
  </products>`;
  assert.strictEqual(detectItemPath(nested), 'products.product');
  // nesouvisející opakující se elementy – vyhrává ten s více opakováními
  const two = `<root><cats><cat id="1"/><cat id="2"/></cats><items><item id="1"/><item id="2"/><item id="3"/></items></root>`;
  assert.strictEqual(detectItemPath(two), 'root.items.item');
  // shoda počtu → hlubší cesta
  const tie = `<root><a x="1"/><a x="2"/><b><c y="1"/><c y="2"/></b></root>`;
  assert.strictEqual(detectItemPath(tie), 'root.b.c');
  // jediná položka → podle známého názvu
  assert.strictEqual(detectItemPath('<SHOP><SHOPITEM><ITEM_ID>1</ITEM_ID><PARAM><PARAM_NAME>a</PARAM_NAME></PARAM></SHOPITEM></SHOP>'), 'SHOP.SHOPITEM');
  // nic se neopakuje a nic známého → null
  assert.strictEqual(detectItemPath('<data><code>1</code><price>2</price></data>'), null);
  // textové listy (bez potomků/atributů) nejsou záznamy
  assert.strictEqual(detectItemPath('<list><ean>1</ean><ean>2</ean></list>'), null);
  // useknutý nebo vadný začátek dokumentu nevadí
  assert.strictEqual(detectItemPath(HEUREKA.slice(0, HEUREKA.indexOf('<ITEM_ID>KOLO-002'))), 'SHOP.SHOPITEM');
  assert.strictEqual(detectItemPath(Buffer.from(HEUREKA)), 'SHOP.SHOPITEM');
});

test('streamRecords: bez itemPath použije detekci, bez opakování vrátí kořen', () => {
  const recs = [];
  assert.strictEqual(streamRecords(HEUREKA, {}, (r) => recs.push(r)), 2);
  assert.strictEqual(recs[1].ITEM_ID, 'KOLO-002');
  const single = [];
  assert.strictEqual(streamRecords('<data><code>1</code><price>2</price></data>', {}, (r) => single.push(r)), 1);
  assert.deepStrictEqual(single[0], { code: '1', price: '2' });
  // funkce jako druhý argument
  assert.strictEqual(streamRecords(HEUREKA, () => {}), 2);
});

test('streamRecords: limit, stop přes return false, index, žádná shoda', () => {
  const seen = [];
  assert.strictEqual(streamRecords(HEUREKA, { itemPath: 'SHOP.SHOPITEM', limit: 1 }, (r, i) => seen.push([r.ITEM_ID, i])), 1);
  assert.deepStrictEqual(seen, [['KOLO-001', 0]]);
  assert.strictEqual(streamRecords(HEUREKA, { itemPath: 'SHOP.SHOPITEM' }, () => false), 1);
  assert.strictEqual(streamRecords(HEUREKA, { itemPath: 'SHOP.NEEXISTUJE' }, () => {}), 0);
  // záznam na hlubší úrovni
  const params = [];
  streamRecords(HEUREKA, { itemPath: 'SHOP.SHOPITEM.PARAM' }, (r) => params.push(r.PARAM_NAME));
  assert.deepStrictEqual(params, ['Barva', 'Velikost rámu', 'Kola', 'Barva']);
});

test('streamRecords: chyba ve feedu se nahlásí s řádkem', () => {
  const broken = HEUREKA.replace('<PRICE_VAT>45 990</PRICE_VAT>', '<PRICE_VAT>45 990</PRICE>');
  const line = broken.split('\n').findIndex((l) => l.includes('</PRICE>')) + 1;
  const col = broken.split('\n')[line - 1].indexOf('</PRICE>') + 1;
  let first = null;
  assert.throws(
    () => streamRecords(broken, { itemPath: 'SHOP.SHOPITEM' }, (r) => (first = first || r.ITEM_ID)),
    (e) => e instanceof XmlError && e.line === line && e.column === col && /řádek 37, sloupec 22/.test(e.message)
  );
  assert.strictEqual(first, 'KOLO-001'); // záznamy před chybou už byly předány
  // useknutý soubor
  assert.throws(() => streamRecords(HEUREKA.slice(0, -20), {}, () => {}), /neočekávaný konec dokumentu/);
});

test('entity: pojmenované, číselné, HTML, neznámé a osamocené &', () => {
  const r = parseXml('<a>&lt;&gt;&amp;&quot;&apos; &#123; &#x1F600; &#x10D; &nbsp;|&hellip; &neznama; AT&T &#0; &#xD800;</a>');
  assert.strictEqual(r.text, `<>&"' { 😀 č  |… &neznama; AT&T &#0; &#xD800;`);
  const attr = parseXml(`<a t="x&#10;y" u="a\tb\nc"/>`);
  assert.strictEqual(attr.attrs.t, 'x\ny');
  assert.strictEqual(attr.attrs.u, 'a b c'); // normalizace bílých znaků v atributu
});

test('DOCTYPE (i s interní podmnožinou), PI, komentáře, CRLF', () => {
  const xml =
    '<?xml version="1.0"?>\r\n<!DOCTYPE SHOP SYSTEM "http://www.heureka.cz/shop.dtd" [\r\n  <!ENTITY firma "Kola">\r\n  <!-- komentář > s [závorkou] -->\r\n]>\r\n<?xml-stylesheet href="x.xsl"?>\r\n<SHOP><!-- a --><X>řádek1\r\nřádek2\rřádek3</X><?pi data?></SHOP>\r\n<!-- konec -->\r\n';
  const r = parseXml(xml);
  assert.strictEqual(r.name, 'SHOP');
  assert.strictEqual(r.children[0].text, 'řádek1\nřádek2\nřádek3');
});

test('samouzavírací tagy, mezery v tagu, BOM, trim:false', () => {
  const r = parseXml('﻿<a >\n  <b x = "1" / >\n  <c\n y="2"\n/><d>  t  </d></a >'.replace('/ >', '/>'));
  assert.strictEqual(r.children.length, 3);
  assert.deepStrictEqual(r.children[0].attrs, { x: '1' });
  assert.deepStrictEqual(r.children[1].attrs, { y: '2' });
  assert.strictEqual(r.children[2].text, 't');
  assert.strictEqual(parseXml('<a><d>  t  </d></a>', { trim: false }).children[0].text, '  t  ');
  assert.strictEqual(parseXml('<a>x<![CDATA[  y  ]]>z</a>', { trim: false }).text, 'x  y  z');
});

test('atributy s prefixy: xmlns vynechány, kolize po odstranění prefixu zachová data', () => {
  const r = parseXml('<a xmlns="u" xmlns:x="v" x:id="1" y:id="2" xml:lang="cs"/>');
  assert.deepStrictEqual(r.attrs, { id: '1', 'y:id': '2', lang: 'cs' });
  const k = parseXml('<a xmlns="u" x:id="1"/>', { keepNs: true });
  assert.deepStrictEqual(k.attrs, { xmlns: 'u', 'x:id': '1' });
});

test('chybné XML → XmlError s řádkem a sloupcem', () => {
  const cases = [
    ['<a><b></a>', /neočekávaný koncový tag <\/a>, očekáván <\/b>/, 1, 7],
    ['<a>\n  <b>\n</a>', /očekáván <\/b>/, 3, 1],
    ['<a>', /neočekávaný konec dokumentu – chybí <\/a>/],
    ['<a><!-- x </a>', /neukončený komentář/],
    ['<a><![CDATA[ x </a>', /neukončená sekce CDATA/],
    ['<a x="1></a>', /neukončená hodnota atributu/],
    ['<a x=1></a>', /musí být v uvozovkách/],
    ['<a x></a>', /nemá hodnotu/],
    ['<a x="1" x="2"></a>', /duplicitní atribut/],
    ['<a>1 < 2</a>', /neplatný název elementu/],
    ['</a>', /bez odpovídajícího/],
    ['<a/><b/>', /druhý kořenový element/],
    ['text<a/>', /text před kořenovým elementem/],
    ['<a/>text', /text za koncem/],
    ['', /neobsahuje žádný element/],
    ['<a><b', /neukončený tag/],
    ['<a><?pi </a>', /neukončená instrukce/],
    ['<a><!FOO></a>', /neznámá deklarace/],
    ['<a ="1"/>', /neplatný název atributu/],
    ['<a><b/ ></a>', /očekáváno „\/>“/],
    ['<a>' + '<b>'.repeat(1001) + '</a>', /příliš hluboké zanoření/],
  ];
  for (const [xml, re, line, column] of cases) {
    assert.throws(
      () => parseXml(xml),
      (e) => {
        assert.ok(e instanceof XmlError, `${xml}: ${e}`);
        assert.match(e.message, re, xml);
        assert.match(e.message, /Neplatné XML/);
        if (line) assert.strictEqual(e.line, line, xml);
        if (column) assert.strictEqual(e.column, column, xml);
        return true;
      }
    );
  }
});

test('escapeXml a el()', () => {
  assert.strictEqual(escapeXml(`a<b>&"c'`), 'a&lt;b&gt;&amp;&quot;c&apos;');
  assert.strictEqual(escapeXml('x\u0001y\u0008z￾w\uD800v😀'), 'xyzwv😀'); // neplatné znaky XML 1.0 pryč
  assert.strictEqual(escapeXml(null), '');
  assert.strictEqual(escapeXml(12.5), '12.5');
  assert.strictEqual(el('price', { currency: 'CZK' }, 12990), '<price currency="CZK">12990</price>');
  assert.strictEqual(el('item', null, [el('code', null, 'A&B'), null, el('empty')]), '<item><code>A&amp;B</code><empty/></item>');
  assert.strictEqual(el('x', { a: null, b: 'q"', c: true }, ''), '<x b="q&quot;" c="true"/>');
});

test('XmlWriter: odsazení, deklarace, escapování, automatické uzavření', () => {
  const w = new XmlWriter();
  w.open('prices', { generated: '2026-09-25T10:00:00Z', count: 2 });
  w.open('item').leaf('code', 'KOLO-001').leaf('name', 'Kolo „Žluť“ & <spol>\u0000').leaf('price', 12990).leaf('note', null).close();
  w.comment('pozn -- x');
  w.open('item', { id: 2 }).leaf('code', 'B', { type: 'ean' });
  const xml = w.toString();
  assert.strictEqual(
    xml,
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<prices generated="2026-09-25T10:00:00Z" count="2">\n' +
      '  <item>\n' +
      '    <code>KOLO-001</code>\n' +
      '    <name>Kolo „Žluť“ &amp; &lt;spol&gt;</name>\n' +
      '    <price>12990</price>\n' +
      '    <note/>\n' +
      '  </item>\n' +
      '  <!-- pozn - - x -->\n' +
      '  <item id="2">\n' +
      '    <code type="ean">B</code>\n' +
      '  </item>\n' +
      '</prices>\n'
  );
  // výstup je znovu čitelný
  const back = xmlToObject(parseXml(xml));
  assert.strictEqual(back.item[0].name, 'Kolo „Žluť“ & <spol>');
  assert.strictEqual(back['@count'], '2');
  assert.throws(() => new XmlWriter().close(), /není co uzavřít/);
  assert.strictEqual(new XmlWriter({ declaration: false }).open('a').toString(), '<a>\n</a>\n');
});

test('výkon: streamRecords na ~10 MB Heureka feedu', () => {
  const xml = heurekaFeed(10 * 1024 * 1024);
  const t0 = Date.now();
  let sum = 0;
  const n = streamRecords(xml, { itemPath: 'SHOP.SHOPITEM' }, (r) => {
    sum += Number(r.PRICE_VAT);
  });
  const ms = Date.now() - t0;
  assert.ok(n > 8000, `položek ${n}`);
  assert.ok(sum > 0);
  assert.ok(ms < 5000, `streamRecords trval ${ms} ms`);
  assert.strictEqual(detectItemPath(xml), 'SHOP.SHOPITEM');
});

// Plný test výkonu (~50 MB, cíl < 5 s): CENOTVORBA_PERF=1 npm test
test('výkon: ~50 MB feed pod 5 s (jen s CENOTVORBA_PERF=1)', { skip: !process.env.CENOTVORBA_PERF }, () => {
  const xml = heurekaFeed(50 * 1024 * 1024);
  let t0 = Date.now();
  const n = streamRecords(xml, {}, () => {});
  const streamMs = Date.now() - t0;
  t0 = Date.now();
  const root = parseXml(xml);
  const parseMs = Date.now() - t0;
  assert.strictEqual(root.children.length, n);
  assert.ok(streamMs < 5000, `streamRecords ${streamMs} ms`);
  assert.ok(parseMs < 5000, `parseXml ${parseMs} ms`);
});

function heurekaFeed(targetChars) {
  const parts = ['<?xml version="1.0" encoding="utf-8"?>\n<SHOP>\n'];
  let size = 0;
  for (let i = 1; size < targetChars; i++) {
    const s = `  <SHOPITEM>
    <ITEM_ID>KOLO-${i}</ITEM_ID>
    <PRODUCTNAME>Horské kolo Žluťoučký kůň ${i} &amp; spol.</PRODUCTNAME>
    <PRODUCT><![CDATA[Kolo <b>${i}</b>]]></PRODUCT>
    <DESCRIPTION>Příliš žluťoučký kůň úpěl ďábelské ódy. Rám hliník, vidlice RockShox, 12 převodů, brzdy Shimano.</DESCRIPTION>
    <URL>https://www.example.cz/kolo-${i}?utm_source=heureka&amp;utm_medium=cpc</URL>
    <PRICE_VAT>${10000 + ((i * 37) % 90000)}.00</PRICE_VAT>
    <MANUFACTURER>Trek</MANUFACTURER>
    <EAN>859${String(1000000000 + i)}</EAN>
    <PARAM><PARAM_NAME>Barva</PARAM_NAME><VAL>modrá</VAL></PARAM>
    <PARAM><PARAM_NAME>Velikost</PARAM_NAME><VAL>L</VAL></PARAM>
    <DELIVERY_DATE>${i % 4}</DELIVERY_DATE>
    <DELIVERY><DELIVERY_ID>PPL</DELIVERY_ID><DELIVERY_PRICE>149</DELIVERY_PRICE></DELIVERY>
  </SHOPITEM>
`;
    parts.push(s);
    size += s.length;
  }
  parts.push('</SHOP>\n');
  return parts.join('');
}
