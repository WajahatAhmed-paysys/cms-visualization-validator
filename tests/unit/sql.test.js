'use strict';

const assert = require('assert');
const sql = require('../../src/lib/sql');

describe('sql helpers', () => {
  it('escapes single quotes in string literals', () => {
    assert.strictEqual(sql.literal("O'Brien"), "'O''Brien'");
    assert.strictEqual(sql.literal('plain'), "'plain'");
  });

  it('renders null and booleans', () => {
    assert.strictEqual(sql.literal(null), 'NULL');
    assert.strictEqual(sql.literal(undefined), 'NULL');
    assert.strictEqual(sql.literal(true), 'true');
    assert.strictEqual(sql.literal(false), 'false');
  });

  it('renders numbers but rejects non-numeric values passed to numeric()', () => {
    assert.strictEqual(sql.literal(42), '42');
    assert.throws(() => sql.numeric('not-a-number'), /Expected a numeric/);
  });

  it('renders lists for IN clauses', () => {
    assert.strictEqual(sql.inList(['a', 'b']), "('a', 'b')");
    assert.strictEqual(sql.list([1, 2, 3]), '1, 2, 3');
  });

  it('computes the start of the current period (not a rolling window)', () => {
    const now = new Date(2026, 10, 10, 15, 30, 0); // 10 Nov 2026 local
    assert.strictEqual(sql.periodStart('day', now), '2026-11-10 00:00:00');
    assert.strictEqual(sql.periodStart('month', now), '2026-11-01 00:00:00');
    assert.strictEqual(sql.periodStart('year', now), '2026-01-01 00:00:00');
    assert.strictEqual(sql.periodStart(null, now), null);
  });

  it('builds a date range clause only when both bounds exist', () => {
    assert.strictEqual(sql.dateRangeClause('tx_event_ts', '2020-01-01', '2020-02-01'), "\n  AND tx_event_ts >= '2020-01-01' AND tx_event_ts <= '2020-02-01'");
    assert.strictEqual(sql.dateRangeClause('tx_event_ts', null, '2020-02-01'), '');
  });
});
