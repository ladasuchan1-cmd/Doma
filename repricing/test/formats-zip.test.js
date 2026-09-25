'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { readZip, writeZip } = require('../src/formats/zip.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'formats');

test('writeZip → readZip: deflate, store, UTF-8 názvy, prázdný soubor', () => {
  const big = 'Příliš žluťoučký kůň úpěl ďábelské ódy. '.repeat(1000);
  const random = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 73 + 11) % 256)); // nekomprimovatelné → store
  const zip = writeZip([
    { name: 'xl/workbook.xml', data: '<workbook/>' },
    { name: 'data/velký.txt', data: big },
    { name: 'bin.dat', data: random },
    { name: 'empty.txt', data: '' },
  ]);
  assert.strictEqual(zip.readUInt32LE(0), 0x04034b50);
  const entries = readZip(zip);
  assert.deepStrictEqual([...entries.keys()], ['xl/workbook.xml', 'data/velký.txt', 'bin.dat', 'empty.txt']);
  assert.strictEqual(entries.get('xl/workbook.xml')().toString(), '<workbook/>');
  assert.strictEqual(entries.get('data/velký.txt')().toString('utf8'), big);
  assert.ok(zip.length < big.length / 10, 'text se komprimoval');
  assert.deepStrictEqual(entries.get('bin.dat')(), random);
  assert.strictEqual(entries.get('empty.txt')().length, 0);
  // metoda uložení: nekomprimovatelná data → 0 (store)
  const cdStart = zip.readUInt32LE(zip.length - 6);
  const methods = [];
  for (let p = cdStart, n = 0; n < 4; n++) {
    methods.push(zip.readUInt16LE(p + 10));
    p += 46 + zip.readUInt16LE(p + 28) + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  assert.deepStrictEqual(methods, [0, 8, 0, 0]); // krátký XML se deflatem nezmenší → store
});

test('writeZip: duplicitní a prázdné názvy se odmítnou; lomítka se normalizují', () => {
  assert.throws(() => writeZip([{ name: 'a', data: '1' }, { name: 'a', data: '2' }]), /Duplicitní/);
  assert.throws(() => writeZip([{ name: '', data: '1' }]), /název/);
  const z = readZip(writeZip([{ name: '\\dir\\file.txt', data: 'x' }]));
  assert.ok(z.has('dir/file.txt'));
});

test('readZip: archiv třetí strany (XLSX z LibreOffice)', () => {
  const entries = readZip(fs.readFileSync(path.join(FIXTURES, 'libreoffice-cz.xlsx')));
  assert.ok(entries.has('[Content_Types].xml'));
  assert.ok(entries.has('xl/worksheets/sheet1.xml'));
  assert.match(entries.get('xl/sharedStrings.xml')().toString('utf8'), /Žluťoučký/);
});

test('readZip: datové deskriptory (bit 3, velikosti v lokální hlavičce nulové)', () => {
  const zip = zipWithDataDescriptor('soubor.txt', Buffer.from('obsah s deskriptorem – Žluť'.repeat(20)));
  const entries = readZip(zip);
  assert.strictEqual(entries.get('soubor.txt')().toString(), 'obsah s deskriptorem – Žluť'.repeat(20));
});

test('readZip: adresáře se přeskočí, komentář archivu nevadí', () => {
  const base = writeZip([{ name: 'a.txt', data: 'A' }]);
  // přidat komentář archivu
  const comment = Buffer.from('komentář PK\x05\x06 uvnitř');
  const withComment = Buffer.concat([base.subarray(0, base.length - 2), u16(comment.length), comment]);
  assert.strictEqual(readZip(withComment).get('a.txt')().toString(), 'A');
  const withDir = zipWithDataDescriptor('adresar/', Buffer.alloc(0));
  assert.strictEqual(readZip(withDir).size, 0);
});

test('readZip: chyby – není ZIP, useknutý, šifrovaný, ZIP64, špatné CRC, neznámá metoda', () => {
  assert.throws(() => readZip(Buffer.from('není to zip, jen text, dost dlouhý na hlavičku')), (e) => e.code === 'ZIP_INVALID');
  assert.throws(() => readZip(Buffer.alloc(5)), /příliš krátký/);
  assert.throws(() => readZip('x'), /Buffer/);

  const good = writeZip([{ name: 'a.txt', data: 'Ahoj světe '.repeat(50) }]);
  assert.throws(() => readZip(good.subarray(0, good.length - 30)), (e) => e.code === 'ZIP_INVALID');

  const cd = good.readUInt32LE(good.length - 6);
  const enc = Buffer.from(good);
  enc.writeUInt16LE(enc.readUInt16LE(cd + 8) | 1, cd + 8);
  assert.throws(() => readZip(enc), (e) => e.code === 'ZIP_ENCRYPTED' && /Šifrovaný/.test(e.message));

  const z64 = Buffer.from(good);
  z64.writeUInt16LE(0xffff, z64.length - 12);
  assert.throws(() => readZip(z64), (e) => e.code === 'ZIP64_UNSUPPORTED' && /ZIP64/.test(e.message));
  const z64b = Buffer.from(good);
  z64b.writeUInt32LE(0xffffffff, cd + 24);
  assert.throws(() => readZip(z64b), (e) => e.code === 'ZIP64_UNSUPPORTED');

  const badCrc = Buffer.from(good);
  badCrc.writeUInt32LE((badCrc.readUInt32LE(cd + 16) ^ 0xff) >>> 0, cd + 16);
  const entries = readZip(badCrc); // chyba až při čtení obsahu
  assert.throws(() => entries.get('a.txt')(), (e) => e.code === 'ZIP_CORRUPT' && /kontrolní součet/.test(e.message));

  const badMethod = Buffer.from(good);
  badMethod.writeUInt16LE(14, cd + 10); // LZMA
  assert.throws(() => readZip(badMethod), (e) => e.code === 'ZIP_METHOD_UNSUPPORTED');

  const badData = Buffer.from(good);
  badData.fill(0xff, 40, 60); // poškozená deflate data
  assert.throws(() => readZip(badData).get('a.txt')(), (e) => e.code === 'ZIP_CORRUPT');
});

test('readZip: ochrana proti zip bombě (velikost dle centrálního adresáře)', () => {
  const data = Buffer.alloc(1024 * 1024, 0x61);
  const zip = writeZip([{ name: 'bomb.txt', data }]);
  const cd = zip.readUInt32LE(zip.length - 6);
  const lying = Buffer.from(zip);
  lying.writeUInt32LE(100, cd + 24); // tvrdí 100 B, rozbalí se 1 MB
  assert.throws(() => readZip(lying).get('bomb.txt')(), (e) => e.code === 'ZIP_CORRUPT');
});

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

/** Ručně sestavený ZIP s datovým deskriptorem (tak zapisují streamovací knihovny). */
function zipWithDataDescriptor(name, data) {
  const nameBuf = Buffer.from(name);
  const comp = zlib.deflateRawSync(data);
  const crc = zlib.crc32(data) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0008, 6); // bit 3
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(nameBuf.length, 26);
  const desc = Buffer.alloc(16);
  desc.writeUInt32LE(0x08074b50, 0);
  desc.writeUInt32LE(crc, 4);
  desc.writeUInt32LE(comp.length, 8);
  desc.writeUInt32LE(data.length, 12);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0008, 8);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(comp.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, nameBuf, comp, desc]);
  const cdBuf = Buffer.concat([cd, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cdBuf, eocd]);
}
