'use strict';

/**
 * Recompute helpers — the exact arithmetic the CMS applies, so the verifier's
 * "expected" side is a faithful oracle. Values come from raw Lakehouse rows.
 */

const round2 = (x) => Math.round(Number(x) * 100) / 100;

const num = (x) => (x === null || x === undefined || x === '' || x === 'no data found' ? 0 : Number(x) || 0);

const sum = (arr, fn = (v) => v) => arr.reduce((acc, value) => acc + num(fn(value)), 0);

const velocity = (txCount) => {
  const n = num(txCount);
  return n >= 50 ? 'HIGH' : n >= 10 ? 'MEDIUM' : 'LOW';
};

function daysBetween(a, b) {
  if (!a || !b) return 1;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (!Number.isFinite(ms)) return 1;
  return Math.max(1, Math.ceil(ms / 86400000) + 1);
}

const frequency = (count, days) => `${days > 0 ? (num(count) / days).toFixed(1) : '0'}/day`;

const parseArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }
  return [];
};

/** Sum of a column across rows, ignoring non-numeric. */
function columnSum(rows, column) {
  return round2(sum(rows || [], (row) => row && row[column]));
}

/** First numeric value coerced, or 0. */
function firstNum(rows, column) {
  const row = (rows || [])[0];
  return row ? num(row[column]) : 0;
}

module.exports = { round2, num, sum, velocity, daysBetween, frequency, parseArray, columnSum, firstNum };
