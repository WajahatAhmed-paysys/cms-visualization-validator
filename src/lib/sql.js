'use strict';

/**
 * SQL literal helpers.
 *
 * The CMS builds SQL by escaping and substituting values textually before
 * posting to the Lakehouse `/execute_sql` endpoint (GoldLakehouseService
 * .escapeSqlValue). These helpers reproduce that behaviour so the raw-mode
 * catalogue sends the same statements the CMS would send.
 */

function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Cannot render non-finite number as SQL literal: ${value}`);
    return String(value);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function numeric(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Expected a numeric SQL literal, got: ${value}`);
  return String(n);
}

/** Renders an array as a comma separated list of literals. */
function list(values) {
  return values.map(literal).join(', ');
}

function numericList(values) {
  return values.map(numeric).join(', ');
}

/** Renders `(a, b, c)` for IN (...) clauses. */
function inList(values) {
  return `(${list(values)})`;
}

function assertIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name))) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return name;
}

/** 'YYYY-MM-DD HH:mm:ss' in local time, Spark-friendly. */
function timestamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${date}`);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** 'YYYY-MM-DD' in local time. */
function dateOnly(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${date}`);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Start of the current day/month/year. This mirrors the CMS Alert History
 * behaviour: it is NOT a rolling window.
 */
function periodStart(granularity, now = new Date()) {
  if (!granularity) return null;
  const d = new Date(now.getTime());
  if (granularity === 'day') {
    d.setHours(0, 0, 0, 0);
  } else if (granularity === 'month') {
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
  } else if (granularity === 'year') {
    d.setMonth(0, 1);
    d.setHours(0, 0, 0, 0);
  } else {
    return null;
  }
  return timestamp(d);
}

/** Last N days as [fromDate, toDate] strings. */
function lastNDays(days, now = new Date()) {
  const to = new Date(now.getTime());
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return [dateOnly(from), dateOnly(to)];
}

/**
 * Append an optional `AND <column> >= ... AND <column> <= ...` clause.
 * Returns '' when either bound is missing.
 */
function dateRangeClause(column, from, to) {
  if (!from || !to) return '';
  return `\n  AND ${column} >= ${literal(from)} AND ${column} <= ${literal(to)}`;
}

module.exports = {
  literal,
  numeric,
  list,
  numericList,
  inList,
  assertIdentifier,
  timestamp,
  dateOnly,
  periodStart,
  lastNDays,
  dateRangeClause
};
