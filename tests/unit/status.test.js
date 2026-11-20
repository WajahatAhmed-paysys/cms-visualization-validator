'use strict';

const assert = require('assert');
const { evaluateCheck, aggregateCards, summarise } = require('../../src/core/status');

function call(overrides) {
  return {
    id: 'X',
    label: 'x',
    mode: 'cms',
    ok: true,
    statusCode: 200,
    durationMs: 10,
    body: {},
    error: null,
    ...overrides
  };
}

function check(view, role = null, extra = {}) {
  return { view, viewLabel: view, card: view, role, ...extra };
}

describe('status engine - Alert Navigator', () => {
  it('is AVAILABLE when alert metadata and typologies exist', () => {
    const result = evaluateCheck(check('alert-navigator'), [
      call({ id: 'C-NAV', body: { alertMetadata: { transactionId: 'a||b' }, typologies: [{}] } })
    ]);
    assert.strictEqual(result.status, 'AVAILABLE');
  });

  it('is EMPTY when alert exists but has no typologies', () => {
    const result = evaluateCheck(check('alert-navigator'), [
      call({ id: 'C-NAV', body: { alertMetadata: {}, typologies: [] } })
    ]);
    assert.strictEqual(result.status, 'EMPTY');
  });

  it('is BLOCKED on a 404', () => {
    const result = evaluateCheck(check('alert-navigator'), [call({ id: 'C-NAV', ok: false, statusCode: 404 })]);
    assert.strictEqual(result.status, 'BLOCKED');
  });

  it('is FAILED on a 500', () => {
    const result = evaluateCheck(check('alert-navigator'), [call({ id: 'C-NAV', ok: false, statusCode: 500 })]);
    assert.strictEqual(result.status, 'FAILED');
  });
});

describe('status engine - Transaction Details', () => {
  it('is AVAILABLE only when both pacs rows exist (CMS)', () => {
    const good = evaluateCheck(check('transaction-details'), [
      call({ id: 'C-TD', body: { transactionOverview: { pacs8: {}, pacs2: {} } } })
    ]);
    assert.strictEqual(good.status, 'AVAILABLE');

    const bad = evaluateCheck(check('transaction-details'), [
      call({ id: 'C-TD', body: { transactionOverview: { pacs8: {} } } })
    ]);
    assert.strictEqual(bad.status, 'FAILED');
  });

  it('is FAILED on 404 and BLOCKED when e2e is unresolved', () => {
    assert.strictEqual(
      evaluateCheck(check('transaction-details'), [call({ id: 'C-TD', ok: false, statusCode: 404 })]).status,
      'FAILED'
    );
    assert.strictEqual(evaluateCheck(check('transaction-details'), []).status, 'BLOCKED');
  });
});

describe('status engine - Transaction Network', () => {
  it('is AVAILABLE with connected accounts and EMPTY with none', () => {
    const available = evaluateCheck(check('network-transaction', 'creditor'), [
      call({ id: 'C-TN', body: { centerAccount: {}, connectedAccounts: [{}, {}] } })
    ]);
    assert.strictEqual(available.status, 'AVAILABLE');
    assert.strictEqual(available.metrics.connectedAccounts, 2);

    const empty = evaluateCheck(check('network-transaction', 'creditor'), [
      call({ id: 'C-TN', body: { centerAccount: {}, connectedAccounts: [] } })
    ]);
    assert.strictEqual(empty.status, 'EMPTY');
  });

  it('is BLOCKED when the role account id is missing', () => {
    const result = evaluateCheck(check('network-transaction', 'debtor', { blockedReason: 'debtorAccountId is null in entity metadata' }), []);
    assert.strictEqual(result.status, 'BLOCKED');
  });

  it('is BLOCKED on a Q-TN1 404', () => {
    const result = evaluateCheck(check('network-transaction', 'creditor'), [call({ id: 'C-TN', ok: false, statusCode: 404 })]);
    assert.strictEqual(result.status, 'BLOCKED');
  });
});

describe('status engine - raw mode', () => {
  it('Account Network is EMPTY when account_holder has no rows', () => {
    const result = evaluateCheck(check('network-account', 'creditor'), [
      call({ id: 'Q-A1', mode: 'raw', body: { data: [] }, rowCount: 0 })
    ]);
    assert.strictEqual(result.status, 'EMPTY');
  });

  it('Account Network is AVAILABLE when account rows exist', () => {
    const result = evaluateCheck(check('network-account', 'creditor'), [
      call({ id: 'Q-A1', mode: 'raw', body: { data: [{ destination: 'a' }] }, rowCount: 1 })
    ]);
    assert.strictEqual(result.status, 'AVAILABLE');
  });

  it('Transaction History is EMPTY with an empty event set and AVAILABLE with rows', () => {
    const empty = evaluateCheck(check('transaction-history', 'debtor'), [
      call({ id: 'Q-TH1', mode: 'raw', body: { data: [] }, rowCount: 0 })
    ]);
    assert.strictEqual(empty.status, 'EMPTY');

    const available = evaluateCheck(check('transaction-history', 'debtor'), [
      call({ id: 'Q-TH1', mode: 'raw', body: { data: [{}] }, rowCount: 1 })
    ]);
    assert.strictEqual(available.status, 'AVAILABLE');
  });
});

describe('status engine - Alert History', () => {
  it('treats a 200 with zeros as EMPTY, not available', () => {
    const result = evaluateCheck(check('alert-history', 'creditor'), [
      call({ id: 'C-AH-SUMMARY', body: { totalAlerts: 0 } }),
      call({ id: 'C-AH-TIMELINE', body: { alertCountOverTime: [] } }),
      call({ id: 'C-AH-ALERTS', body: { alerts: [] } })
    ]);
    assert.strictEqual(result.status, 'EMPTY');
  });

  it('is AVAILABLE when there are alerts', () => {
    const result = evaluateCheck(check('alert-history', 'creditor'), [
      call({ id: 'C-AH-SUMMARY', body: { totalAlerts: 3 } }),
      call({ id: 'C-AH-TIMELINE', body: { alertCountOverTime: [{}] } }),
      call({ id: 'C-AH-ALERTS', body: { alerts: [{}] } })
    ]);
    assert.strictEqual(result.status, 'AVAILABLE');
  });
});

describe('status engine - Conditions', () => {
  it('counts conditions across debtor/creditor accounts and entity conditions', () => {
    const result = evaluateCheck(check('conditions'), [
      call({
        id: 'C-COND',
        body: {
          debtor: { accounts: [{ conditions: [{ condition_id: 'c1' }] }] },
          creditor: { accounts: [{ conditions: [{ condition_id: 'c2' }, { condition_id: 'c3' }] }] },
          entityConditions: [{ condition_id: 'c4' }]
        }
      })
    ]);
    assert.strictEqual(result.status, 'AVAILABLE');
    assert.strictEqual(result.metrics.conditions, 4);
  });

  it('is EMPTY when no conditions exist and FAILED on Q-C1 404', () => {
    const empty = evaluateCheck(check('conditions'), [call({ id: 'C-COND', body: {} })]);
    assert.strictEqual(empty.status, 'EMPTY');

    const failed = evaluateCheck(check('conditions'), [call({ id: 'C-COND', ok: false, statusCode: 404 })]);
    assert.strictEqual(failed.status, 'FAILED');
  });
});

describe('status aggregation', () => {
  it('card status is the worst of its rows and counts availability', () => {
    const checks = [
      { card: 'Network Analysis', view: 'network-transaction', viewLabel: 'Transaction Network', role: 'creditor', status: 'AVAILABLE' },
      { card: 'Network Analysis', view: 'network-transaction', viewLabel: 'Transaction Network', role: 'debtor', status: 'FAILED' },
      { card: 'Network Analysis', view: 'network-account', viewLabel: 'Account Network', role: 'creditor', status: 'EMPTY' }
    ];
    const cards = aggregateCards(checks);
    const card = cards.find((entry) => entry.card === 'Network Analysis');
    assert.strictEqual(card.status, 'FAILED');
    assert.strictEqual(card.available, 1);
    assert.strictEqual(card.total, 3);
  });

  it('summarises counts', () => {
    const summary = summarise([
      { status: 'AVAILABLE' },
      { status: 'AVAILABLE' },
      { status: 'EMPTY' },
      { status: 'FAILED' },
      { status: 'BLOCKED' }
    ]);
    assert.deepStrictEqual(summary, { available: 2, empty: 1, failed: 1, blocked: 1, skipped: 0, total: 5 });
  });
});
