'use strict';

/**
 * Re-run Data Verify comparisons from the captured fixtures — no network.
 * Prints the same per-view table and writes offline artifacts.
 *
 *   node scripts/verify-from-fixtures.js
 */

const fs = require('fs');
const path = require('path');
const { buildRawBag, buildCmsBag, evaluateFields, aggregateStatus } = require('../src/verify/verifier');
const { getContracts } = require('../src/verify/contracts');

function pad(value, width) {
  return String(value).padEnd(width, ' ');
}
function fmt(value) {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function main() {
  const file = path.join(__dirname, '..', 'tests', 'fixtures', 'verify-fixtures.json');
  if (!fs.existsSync(file)) {
    console.error('No fixtures found. Run: node scripts/capture-verify-fixtures.js <alertId>');
    process.exit(2);
  }
  const fixtures = JSON.parse(fs.readFileSync(file, 'utf8'));

  const results = [];
  for (const check of fixtures.checks) {
    if (check.status === 'BLOCKED' || check.status === 'NOT_COMPARABLE') {
      results.push({ ...check, fields: [] });
      continue;
    }
    const rawBag = buildRawBag(check.rawCalls);
    const cmsBag = buildCmsBag(check.cmsCalls);
    const fields = evaluateFields(getContracts(check.view), rawBag, cmsBag, { role: check.role, granularity: fixtures.granularity });
    results.push({ ...check, fields, status: aggregateStatus(fields) });
  }

  console.log('CMS Data Verify — OFFLINE (from fixtures)');
  console.log(`Alert ${fixtures.alertId} | tenant ${fixtures.tenantId} | granularity ${fixtures.granularity} | captured ${fixtures.capturedAt}`);
  console.log('');
  const header = `${pad('VIEW / ROLE', 34)}${pad('STATUS', 15)}${pad('FIELDS', 8)}FIRST FAILURE`;
  console.log(header);
  console.log('-'.repeat(Math.max(header.length, 80)));

  const summary = { VERIFIED: 0, MISMATCH: 0, NOT_COMPARABLE: 0, BLOCKED: 0, fieldsPassed: 0, fieldsFailed: 0 };
  for (const view of results) {
    const fields = view.fields || [];
    const passed = fields.filter((f) => f.pass).length;
    summary[view.status] = (summary[view.status] || 0) + 1;
    summary.fieldsPassed += passed;
    summary.fieldsFailed += fields.length - passed;
    const firstFail = fields.find((f) => !f.pass && f.required);
    let detail = '';
    if (view.status === 'MISMATCH' && firstFail) {
      detail = `${firstFail.key}: expected ${fmt(firstFail.expected)} actual ${fmt(firstFail.actual)}${firstFail.delta != null ? ` Δ${firstFail.delta}` : ''}`;
    } else if (view.status !== 'VERIFIED') {
      detail = view.reason || '';
    }
    const label = `${view.viewLabel}${view.role ? ` [${view.role}]` : ''}`;
    console.log(`${pad(label, 34)}${pad(view.status, 15)}${pad(fields.length ? `${passed}/${fields.length}` : '-', 8)}${detail}`);
  }
  console.log('');
  console.log(
    `Summary: ${summary.VERIFIED} verified, ${summary.MISMATCH} mismatch, ${summary.NOT_COMPARABLE} not comparable, ` +
      `${summary.BLOCKED} blocked (of ${results.length}) · fields ${summary.fieldsPassed} passed / ${summary.fieldsFailed} failed`
  );

  return summary.MISMATCH;
}

process.exitCode = main() > 0 ? 1 : 0;
