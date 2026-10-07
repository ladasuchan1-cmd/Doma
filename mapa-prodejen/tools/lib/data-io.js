'use strict';
// Zápis a čtení datových souborů data/<název>.js. Soubor je obyčejný skript (funguje i z file://):
//   window.MP_DATA = window.MP_DATA || {};
//   window.MP_DATA.<název> = <JSON>;
// readDataset() ho umí načíst i v Node (testy, server) bez vyhodnocování kódu.

const fs = require('node:fs');
const path = require('node:path');

const HEADER = 'window.MP_DATA = window.MP_DATA || {};\n';

function serializeDataset(name, value) {
  if (!/^[a-z][a-z0-9_]*$/i.test(name)) throw new Error('Neplatný název datasetu: ' + name);
  return `${HEADER}window.MP_DATA.${name} = ${JSON.stringify(value)};\n`;
}

function writeDataset(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name + '.js');
  fs.writeFileSync(file, serializeDataset(name, value));
  return file;
}

function parseDataset(text, name) {
  const marker = `window.MP_DATA.${name} = `;
  const i = text.indexOf(marker);
  if (i < 0) throw new Error(`Soubor neobsahuje dataset ${name}`);
  let json = text.slice(i + marker.length).trimEnd();
  if (json.endsWith(';')) json = json.slice(0, -1);
  return JSON.parse(json);
}

function readDataset(dir, name) {
  const file = path.join(dir, name + '.js');
  if (!fs.existsSync(file)) return null;
  return parseDataset(fs.readFileSync(file, 'utf8'), name);
}

module.exports = { serializeDataset, writeDataset, parseDataset, readDataset, HEADER };
