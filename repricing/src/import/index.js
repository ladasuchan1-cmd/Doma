'use strict';
// Import katalogu a cen konkurence – souhrnný export (viz docs/SPEC.md §5).

const records = require('./records');
const mapping = require('./mapping');
const products = require('./products');
const offers = require('./offers');
const sources = require('./sources');

module.exports = { ...records, ...mapping, ...products, ...offers, ...sources };
