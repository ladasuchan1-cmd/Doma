'use strict';
// Export cen (SPEC §7) – souhrnný re-export modulů rows, feeds, pohoda, webhook, xlsx-report a apply.

const rows = require('./rows');
const feeds = require('./feeds');
const pohoda = require('./pohoda');
const webhook = require('./webhook');
const xlsxReport = require('./xlsx-report');
const apply = require('./apply');

module.exports = { ...rows, ...feeds, ...pohoda, ...webhook, ...xlsxReport, ...apply };
