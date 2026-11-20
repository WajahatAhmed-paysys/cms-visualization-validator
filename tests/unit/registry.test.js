'use strict';

const assert = require('assert');
const { VIEWS, buildChecks, QUERY_LABELS, getView, roleParamField } = require('../../src/core/registry');
const { RAW_QUERY_CATALOGUE } = require('../../src/queries/raw');

describe('registry', () => {
  it('models 9 data views', () => {
    assert.strictEqual(VIEWS.length, 9);
  });

  it('expands to 15 role-view checks for both roles', () => {
    const checks = buildChecks(['creditor', 'debtor']);
    assert.strictEqual(checks.length, 15);
  });

  it('expands to 9 checks for a single role', () => {
    assert.strictEqual(buildChecks(['creditor']).length, 9);
  });

  it('shows six Network Analysis checks (3 sub-tabs x 2 roles)', () => {
    const checks = buildChecks(['creditor', 'debtor']).filter((check) => check.card === 'Network Analysis');
    assert.strictEqual(checks.length, 6);
    const subViews = new Set(checks.map((check) => check.view));
    assert.deepStrictEqual([...subViews].sort(), ['network-account', 'network-counterparty', 'network-transaction']);
  });

  it('has exactly one Conditions check and one Transaction Details check', () => {
    const checks = buildChecks(['creditor', 'debtor']);
    assert.strictEqual(checks.filter((check) => check.view === 'conditions').length, 1);
    assert.strictEqual(checks.filter((check) => check.view === 'transaction-details').length, 1);
  });

  it('catalogues 30 query labels and 31 SQL statements', () => {
    assert.strictEqual(RAW_QUERY_CATALOGUE.length, 30);
    const statements = RAW_QUERY_CATALOGUE.reduce((total, entry) => total + (entry.statements || 1), 0);
    assert.strictEqual(statements, 31);
    assert.strictEqual(Object.keys(QUERY_LABELS).length, 30);
  });

  it('maps role parameters to entity-metadata fields', () => {
    assert.strictEqual(roleParamField('network-account', 'creditor'), 'creditorId');
    assert.strictEqual(roleParamField('network-transaction', 'debtor'), 'debtorAccountId');
    assert.strictEqual(roleParamField('alert-navigator', 'creditor'), null);
    assert.ok(getView('conditions'));
  });
});
