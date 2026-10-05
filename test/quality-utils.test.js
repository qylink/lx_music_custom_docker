'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const q = require('../src/services/quality-utils');

test('classifyError: permanent for source not found / disabled', () => {
  assert.equal(q.classifyError(new Error('source not found')), 'permanent');
  assert.equal(q.classifyError(new Error('source is disabled')), 'permanent');
  assert.equal(q.classifyError(new Error('empty url')), 'permanent');
  assert.equal(q.classifyError({ message: '不存在' }), 'permanent');
});

test('classifyError: transient for network errors', () => {
  const e = new Error('ECONNRESET'); e.code = 'ECONNRESET';
  assert.equal(q.classifyError(e), 'transient');
  const t = new Error('timeout'); t.response = { status: 500 };
  assert.equal(q.classifyError(t), 'transient');
});

test('classifyError: rate_limited for 429 / rate limit msg', () => {
  const e = new Error('rate limited'); e.response = { status: 429 };
  assert.equal(q.classifyError(e), 'rate_limited');
  assert.equal(q.classifyError(new Error('too many requests')), 'rate_limited');
});

test('classifyError: unknown fallback', () => {
  assert.equal(q.classifyError(new Error('something weird')), 'unknown');
  assert.equal(q.classifyError(null), 'unknown');
});

test('parseRetryAfter: seconds and HTTP date', () => {
  assert.equal(q.parseRetryAfter('10'), 10000);
  assert.ok(q.parseRetryAfter('Thu, 01 Jan 2099 00:00:00 GMT') > 0);
  assert.equal(q.parseRetryAfter('junk'), null);
  assert.equal(q.parseRetryAfter(null), null);
});

test('downgradeQuality: picks next lower supported', () => {
  assert.equal(q.downgradeQuality('320', ['128k', '192k', '320k']), '192k');
  assert.equal(q.downgradeQuality('320k', ['128k']), '128k');
  assert.equal(q.downgradeQuality('128k', ['128k']), null);
  assert.equal(q.downgradeQuality('flac', ['320k', '128k']), '320k');
  assert.equal(q.downgradeQuality('192', []), '128k');
});

test('mapQuality: closest supported, alias normalization', () => {
  assert.equal(q.mapQuality('320', ['128k', '320k']), '320k');
  assert.equal(q.mapQuality('320', ['128k', 'flac']), 'flac'); // 优先 flac
  assert.equal(q.mapQuality('flac', ['128k']), '128k');
  assert.equal(q.mapQuality('128', []), '128k');
});