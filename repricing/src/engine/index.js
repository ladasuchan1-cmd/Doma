'use strict';
// Cenotvorba – veřejné API enginu (re-export modulů). SPEC §6.

const rounding = require('./rounding');
const market = require('./market');
const metrics = require('./metrics');
const filter = require('./filter');
const presets = require('./presets');
const pricing = require('./pricing');
const run = require('./run');
const groups = require('./groups');

module.exports = {
  // rounding.js
  roundPrice: rounding.roundPrice,
  priceCandidates: rounding.priceCandidates,
  describeRounding: rounding.describeRounding,
  validateRounding: rounding.validateRounding,
  DEFAULT_BANDS: rounding.DEFAULT_BANDS,
  // market.js
  buildMarket: market.buildMarket,
  rankOf: market.rankOf,
  positionOf: market.positionOf,
  findCompetitorOffer: market.findCompetitorOffer,
  DEFAULT_MARKET_FILTER: market.DEFAULT_MARKET_FILTER,
  EXCLUDE_REASONS: market.EXCLUDE_REASONS,
  // metrics.js
  productView: metrics.productView,
  FIELDS: metrics.FIELDS,
  FIELD_GROUPS: metrics.FIELD_GROUPS,
  POSITION_LABELS: metrics.POSITION_LABELS,
  discoverAttrFields: metrics.discoverAttrFields,
  isLockActive: metrics.isLockActive,
  scheduleActive: metrics.scheduleActive,
  parseDateTime: metrics.parseDateTime,
  pragueParts: metrics.pragueParts,
  // filter.js
  compileFilter: filter.compileFilter,
  validateFilter: filter.validateFilter,
  isEmptyFilter: filter.isEmptyFilter,
  FilterError: filter.FilterError,
  OPS: filter.OPS,
  // presets.js
  DEFAULT_CONFIG: presets.DEFAULT_CONFIG,
  normalizeConfig: presets.normalizeConfig,
  STRATEGY_PRESETS: presets.STRATEGY_PRESETS,
  TARGET_MODES: presets.TARGET_MODES,
  FALLBACK_MODES: presets.FALLBACK_MODES,
  TARGET_MODE_LABELS: presets.TARGET_MODE_LABELS,
  FALLBACK_MODE_LABELS: presets.FALLBACK_MODE_LABELS,
  GROUP_ALIGN_MODES: presets.GROUP_ALIGN_MODES,
  GROUP_ALIGN_LABELS: presets.GROUP_ALIGN_LABELS,
  // pricing.js
  computePrice: pricing.computePrice,
  formatMoney: pricing.formatMoney,
  formatPct: pricing.formatPct,
  BLOCKING_FLAGS: pricing.BLOCKING_FLAGS,
  FLAG_LABELS: pricing.FLAG_LABELS,
  REASON_LABELS: pricing.REASON_LABELS,
  // run.js
  loadContext: run.loadContext,
  evaluateProduct: run.evaluateProduct,
  runPricing: run.runPricing,
  simulate: run.simulate,
  explainProduct: run.explainProduct,
  latestProposal: run.latestProposal,
  prepareStrategy: run.prepareStrategy,
  // groups.js – cenové skupiny (C3)
  alignGroups: groups.alignGroups,
  groupKey: groups.groupKey,
};
