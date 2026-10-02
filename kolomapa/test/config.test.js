'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, parseSchedule } = require('../src/config');

test('výchozí konfigurace', () => {
  const c = loadConfig({});
  assert.equal(c.port, 8090);
  assert.equal(c.host, '127.0.0.1');
  assert.deepEqual(c.sources, ['bazos', 'sbazar', 'cyklobazar']);
  assert.deepEqual(c.schedule, { hour: 5, minute: 30 });
  assert.equal(c.ai.enabled, false);
  assert.equal(c.ai.model, 'claude-opus-5-5');
});

test('zdroje, plán, AI klíč', () => {
  assert.deepEqual(loadConfig({ KOLOMAPA_SOURCES: 'all' }).sources, ['bazos', 'sbazar', 'aukro', 'cyklobazar']);
  assert.deepEqual(loadConfig({ KOLOMAPA_SOURCES: 'aukro, bazos, nic' }).sources, ['bazos', 'aukro']);
  assert.equal(parseSchedule('off'), null);
  assert.deepEqual(parseSchedule('7:05'), { hour: 7, minute: 5 });
  assert.deepEqual(parseSchedule('25:00'), { hour: 5, minute: 30 });
  const c = loadConfig({ ANTHROPIC_API_KEY: 'sk-test', KOLOMAPA_AI_MAX_PER_RUN: '10' });
  assert.equal(c.ai.enabled, true);
  assert.equal(c.ai.maxPerRun, 10);
});
