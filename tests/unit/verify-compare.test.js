'use strict';

const assert = require('assert');
const { compareField, normalise } = require('../../src/verify/compare');
const { round2, velocity, daysBetween, frequency, parseArray, num } = require('../../src/verify/recompute');

describe('verify compare - numeric tolerances', () => {
  it('passes money within 0.01 and fails beyond it', () => {
    const f = { key: 'x', kind: 'money' };
    assert.strictEqual(compareField(f, 100.0, 100.01).pass, true);
    assert.strictEqual(compareField(f, 100.0, 100.02).pass, false);
    assert.ok(compareField(f, 100.0, 100.02).delta > 0.01);
  });

  it('requires exact counts', () => {
    const f = { key: 'n', kind: 'count' };
    assert.strictEqual(compareField(f, 5, 5).pass, true);
    assert.strictEqual(compareField(f, 5, 6).pass, false);
  });

  it('compares percents within 0.01', () => {
    const f = { key: 'p', kind: 'percent' };
    assert.strictEqual(compareField(f, 33.33, 33.34).pass, true);
    assert.strictEqual(compareField(f, 33.33, 34).pass, false);
  });

  it('honours explicit tolerance', () => {
    assert.strictEqual(compareField({ key: 'm', kind: 'money', tolerance: 1 }, 100, 100.5).pass, true);
  });
});

describe('verify compare - empty handling', () => {
  it('treats both null as pass', () => {
    assert.strictEqual(compareField({ key: 'x', kind: 'money' }, null, null).pass, true);
  });

  it('fails when only one side is empty', () => {
    assert.strictEqual(compareField({ key: 'x', kind: 'money' }, null, 0).pass, false);
    assert.strictEqual(compareField({ key: 'x', kind: 'money' }, 5, null).pass, false);
  });

  it('normalises the literal "no data found" to empty', () => {
    assert.strictEqual(normalise('count', 'no data found'), null);
    assert.strictEqual(compareField({ key: 'x', kind: 'count' }, 'no data found', null).pass, true);
  });
});

describe('verify compare - strings, dates, informational', () => {
  it('trims and compares strings exactly', () => {
    assert.strictEqual(compareField({ key: 's', kind: 'string' }, ' abc ', 'abc').pass, true);
    assert.strictEqual(compareField({ key: 's', kind: 'string' }, 'abc', 'abd').pass, false);
  });

  it('compares booleans', () => {
    assert.strictEqual(compareField({ key: 'b', kind: 'bool' }, true, 'true').pass, true);
    assert.strictEqual(compareField({ key: 'b', kind: 'bool' }, false, 'true').pass, false);
  });

  it('allows date tolerance in ms', () => {
    const f = { key: 'd', kind: 'date' };
    const a = '2026-01-01T00:00:00.000Z';
    const b = '2026-01-01T00:00:00.500Z';
    const c = '2026-01-01T00:00:02.000Z';
    assert.strictEqual(compareField(f, a, b).pass, true);
    assert.strictEqual(compareField(f, a, c).pass, false);
  });

  it('never fails informational fields', () => {
    assert.strictEqual(compareField({ key: 'i', kind: 'informational' }, 1, 999).pass, true);
  });

  it('never fails optional (required:false) fields', () => {
    assert.strictEqual(compareField({ key: 'o', kind: 'count', required: false }, 1, 2).pass, true);
  });
});

describe('verify recompute helpers', () => {
  it('rounds to 2 decimals', () => {
    assert.strictEqual(round2(1.234), 1.23);
    assert.strictEqual(round2('12.345'), 12.35);
    assert.strictEqual(round2(10), 10);
  });

  it('coerces empty-ish values to 0', () => {
    assert.strictEqual(num(null), 0);
    assert.strictEqual(num(''), 0);
    assert.strictEqual(num('no data found'), 0);
    assert.strictEqual(num('7'), 7);
  });

  it('maps velocity thresholds', () => {
    assert.strictEqual(velocity(49), 'MEDIUM');
    assert.strictEqual(velocity(50), 'HIGH');
    assert.strictEqual(velocity(9), 'LOW');
    assert.strictEqual(velocity(10), 'MEDIUM');
  });

  it('computes inclusive day spans and frequency', () => {
    assert.strictEqual(daysBetween('2026-01-01', '2026-01-01'), 1);
    assert.strictEqual(daysBetween('2026-01-01', '2026-01-03'), 3);
    assert.strictEqual(frequency(6, 3), '2.0/day');
  });

  it('parses array-or-json-string', () => {
    assert.deepStrictEqual(parseArray('[1,2]'), [1, 2]);
    assert.deepStrictEqual(parseArray([3]), [3]);
    assert.deepStrictEqual(parseArray('not json'), []);
    assert.deepStrictEqual(parseArray(null), []);
  });
});
