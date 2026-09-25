'use strict';
// Formáty dat bez závislostí – souhrnný export (viz docs/SPEC.md §4).

const decode = require('./decode');
const xml = require('./xml');
const csv = require('./csv');
const zip = require('./zip');
const xlsx = require('./xlsx');

module.exports = { ...decode, ...xml, ...csv, ...zip, ...xlsx };
