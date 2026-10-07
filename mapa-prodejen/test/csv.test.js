'use strict';
// Testy CSV parseru a serializace (lib/csv.js).
const test = require('node:test');
const assert = require('node:assert');
const csv = require('../lib/csv.js');

test('parse – uvozovky, zdvojené uvozovky, nový řádek v poli, CRLF, BOM', () => {
  const text = '﻿a,b,c\r\n1,"x, y","řekl ""ahoj"""\r\n2,"více\nřádků",\r\n';
  const rows = csv.parse(text);
  assert.deepStrictEqual(rows, [
    ['a', 'b', 'c'],
    ['1', 'x, y', 'řekl "ahoj"'],
    ['2', 'více\nřádků', ''],
  ]);
});

test('parse – detekce oddělovače a parseObjects (hlavička s otazníky ze SPARQL)', () => {
  const rows = csv.parseObjects('?p;?kind\nhttps://osm/node/1;tourism=hotel\n\n');
  assert.deepStrictEqual(rows, [{ p: 'https://osm/node/1', kind: 'tourism=hotel' }]);
  assert.strictEqual(csv.detectSeparator('a\tb\tc\n1\t2\t3'), '\t');
  assert.strictEqual(csv.detectSeparator('abc'), ',');
  assert.deepStrictEqual(csv.parseObjects(''), []);
});

test('detekce oddělovače z víc řádků – tabulka z Excelu s nadpisem, středník s desetinnou čárkou', () => {
  assert.strictEqual(csv.detectSeparator('Objednávky dle měst, rok 2025\nObec\tPočet\nPraha\t5\nBrno\t3'), '\t');
  assert.strictEqual(csv.detectSeparator('PSČ;Částka\n16000;1234,50\n15000;99,90'), ';');
  assert.strictEqual(csv.detectSeparator('a,b\n1,2'), ',');
});

test('parse – uvozovky uprostřed pole jsou obyčejný znak (text vložený z Excelu)', () => {
  assert.deepStrictEqual(csv.parse('Obec\tPozn\nPraha\t5" kolo\nBrno\tx', '\t'), [['Obec', 'Pozn'], ['Praha', '5" kolo'], ['Brno', 'x']]);
  assert.deepStrictEqual(csv.parse('a\t"b\tc"\t"""d"""', '\t'), [['a', 'b\tc', '"d"']]);
});

test('parse – poslední řádek bez ukončení a prázdná pole', () => {
  assert.deepStrictEqual(csv.parse('a,b\n,\n1,2'), [['a', 'b'], ['', ''], ['1', '2']]);
});

test('serialize – BOM, středník, CRLF, escapování a ochrana před vzorci', () => {
  const out = csv.serialize([
    ['Název', 'Poznámka'],
    ['Hotel; U Lípy', 'řekl "ahoj"\nnový řádek'],
    ['=SUM(A1)', null],
  ]);
  assert.ok(out.startsWith('﻿'));
  const lines = out.slice(1).split('\r\n');
  assert.strictEqual(lines[0], 'Název;Poznámka');
  assert.strictEqual(lines[1], '"Hotel; U Lípy";"řekl ""ahoj""\nnový řádek"');
  assert.strictEqual(lines[2], "'=SUM(A1);");
  assert.strictEqual(csv.serialize([['a', 'b']], { sep: ',', bom: false }), 'a,b\r\n');
});

test('round-trip serialize → parse', () => {
  const rows = [['id', 'text'], ['1', 'a;b'], ['2', 'c"d\ne']];
  const parsed = csv.parse(csv.serialize(rows));
  assert.deepStrictEqual(parsed, rows);
});
