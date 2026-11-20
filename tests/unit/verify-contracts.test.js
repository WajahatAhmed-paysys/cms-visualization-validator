'use strict';

const assert = require('assert');
const { evaluateFields, aggregateStatus } = require('../../src/verify/verifier');
const { getContracts } = require('../../src/verify/contracts');

function evaluate(viewKey, rows, cmsBag, meta = { role: null, granularity: 'month' }) {
  const rawBag = { rows, calls: [] };
  const fields = evaluateFields(getContracts(viewKey), rawBag, cmsBag, meta);
  return { fields, status: aggregateStatus(fields) };
}

function fieldOf(fields, key) {
  return fields.find((f) => f.key === key);
}

describe('verify contracts - alert navigator', () => {
  const rows = {
    'Q-NAV': [
      {
        alert_id: 796,
        transaction_id: 'tx-1',
        transaction_amount: '12.5',
        transaction_currency: 'USD',
        typologies: JSON.stringify([
          { typology_id: '1', rules: JSON.stringify([{ rule_weight: 1, rule_id: 'r1' }, { rule_weight: 0, rule_id: 'EFRuP@9' }]) }
        ])
      }
    ]
  };
  const cms = { 'C-NAV': { alertMetadata: { alertId: 796, transactionId: 'tx-1', amount: 12.5, currency: 'USD' }, statistics: { totalTypologies: 1, totalRules: 1 } } };

  it('passes when raw and CMS agree', () => {
    const { status, fields } = evaluate('alert-navigator', rows, cms);
    assert.strictEqual(status, 'VERIFIED');
    assert.strictEqual(fieldOf(fields, 'statistics.totalRules').pass, true);
  });

  it('fails when a stat differs', () => {
    const bad = JSON.parse(JSON.stringify(cms));
    bad['C-NAV'].statistics.totalRules = 0;
    const { status } = evaluate('alert-navigator', rows, bad);
    assert.strictEqual(status, 'MISMATCH');
  });
});

describe('verify contracts - transaction history', () => {
  const rows = {
    'Q-TH1': [
      { end_to_end_id: 'e1', tx_type: 'pacs.008.001.10', is_alerted: 1, is_investigated: 0, tx_amount: '100' },
      { end_to_end_id: 'e2', tx_type: 'pacs.008.001.10', is_alerted: 0, is_investigated: 1, tx_amount: '50' }
    ],
    'Q-TH3': [{ total_tx_count: 10, total_amount: '150' }],
    'Q-BF': [{ amount: 1 }, { amount: 2 }]
  };
  const cms = {
    'C-TH': {
      summary: {
        totalTransactions: 2,
        totalVolume: 150,
        alertsTriggered: 1,
        investigated: 1,
        alertsPercentage: 50,
        investigatedPercentage: 50,
        expected: { transactionCount: 10, volume: 150 }
      }
    },
    'C-BF': { sampleSize: 2 }
  };

  it('verifies volume and percentage from EVENT rows', () => {
    const { status, fields } = evaluate('transaction-history', rows, cms, { role: 'creditor', granularity: 'month' });
    assert.strictEqual(status, 'VERIFIED');
    assert.strictEqual(fieldOf(fields, 'summary.totalVolume').expected, 150);
    assert.strictEqual(fieldOf(fields, 'summary.alertsPercentage').expected, 50);
  });

  it('flags a volume mismatch', () => {
    const bad = JSON.parse(JSON.stringify(cms));
    bad['C-TH'].summary.totalVolume = 200;
    const { status } = evaluate('transaction-history', rows, bad, { role: 'creditor', granularity: 'month' });
    assert.strictEqual(status, 'MISMATCH');
  });
});

describe('verify contracts - transaction network', () => {
  const rows = {
    'Q-TN1': [{ account_id: 'acct-1' }],
    'Q-TN2': [{ connected_account_id: 'a' }],
    'Q-TN3': [{ connected_account_id: 'b' }],
    'Q-TN4': [{ transaction_id: 't1', debtor_account_id: 'x', creditor_account_id: 'y', is_alerted: 0 }],
    'Q-TN5': [{ entity_id: 'a', is_alerted: 1 }],
    'Q-TN6': []
  };
  const cms = {
    'C-TN': {
      centerAccount: { networkSummary: { connectedAccounts: 2, outboundConnections: 1, inboundConnections: 1, accountsWithAlerts: 1 } },
      connectedAccounts: [{}, {}],
      edges: [{}]
    }
  };

  it('verifies connected + summarised counts', () => {
    const { status, fields } = evaluate('network-transaction', rows, cms, { role: 'debtor', granularity: 'month' });
    assert.strictEqual(status, 'VERIFIED');
    assert.strictEqual(fieldOf(fields, 'connectedAccounts').expected, 2);
    assert.strictEqual(fieldOf(fields, 'summary.outboundConnections').expected, 1);
  });

  it('flags an edge-count mismatch', () => {
    const bad = JSON.parse(JSON.stringify(cms));
    bad['C-TN'].edges = [{}, {}, {}];
    const { status } = evaluate('network-transaction', rows, bad, { role: 'debtor', granularity: 'month' });
    assert.strictEqual(status, 'MISMATCH');
  });
});

describe('verify contracts - alert history', () => {
  const rows = {
    'Q-AH1': [{ total_alerts: 0, cases_opened: 0, investigations: 0, sar_filings: 0, total_value: 0 }],
    'Q-AH2': []
  };
  const cms = {
    'C-AH-SUMMARY': { totalAlerts: 0, casesOpened: 0, investigations: 0, sarFilings: 0, totalValue: 0 },
    'C-AH-TIMELINE': { alertCountOverTime: [] }
  };

  it('treats zeros-on-both-sides as verified', () => {
    const { status } = evaluate('alert-history', rows, cms, { role: 'creditor', granularity: 'month' });
    assert.strictEqual(status, 'VERIFIED');
  });

  it('flags a total mismatch', () => {
    const bad = JSON.parse(JSON.stringify(cms));
    bad['C-AH-SUMMARY'].totalAlerts = 5;
    const { status } = evaluate('alert-history', rows, bad, { role: 'creditor', granularity: 'month' });
    assert.strictEqual(status, 'MISMATCH');
  });
});

describe('verify contracts - conditions', () => {
  const rows = { 'Q-C1': [{ interbank_settlement_amount: '100', interbank_settlement_currency: 'USD', tx_type: 'pacs.008.001.10', debtor_account_id: 'dA', creditor_account_id: 'cA' }] };
  const cms = {
    'C-COND': { transaction: { amount: 100, currency: 'USD', type: 'pacs.008.001.10' }, debtor: { accounts: [{}] }, creditor: { accounts: [{}] } }
  };

  it('verifies the transaction fields', () => {
    const { status } = evaluate('conditions', rows, cms);
    assert.strictEqual(status, 'VERIFIED');
  });

  it('flags an amount mismatch', () => {
    const bad = JSON.parse(JSON.stringify(cms));
    bad['C-COND'].transaction.amount = 150;
    const { status } = evaluate('conditions', rows, bad);
    assert.strictEqual(status, 'MISMATCH');
  });
});

describe('verify contracts - conditions totalConditions (source-aligned)', () => {
  const calls = [
    { id: 'Q-C2', subId: 'Q-C2.accounts', ok: true, body: { data: [{ account_id: 'a1' }, { account_id: 'a2' }] } },
    { id: 'Q-C2', subId: 'Q-C2.conditions', ok: true, body: { data: [{ condition_id: 'c1' }, { condition_id: 'c2' }] } },
    { id: 'Q-C3', ok: true, body: { data: [{ condition_id: 'c1' }, { condition_id: 'c2' }] } },
    { id: 'Q-C4', ok: true, body: { data: [{ condition_id: 'e1' }] } }
  ];
  const cms = {
    'C-COND': {
      transaction: { amount: 0, currency: '', type: '' },
      debtor: { accounts: [{ conditions: [{}, {}] }] },
      creditor: { accounts: [{ conditions: [{}] }] }
    }
  };

  function evalWithCalls(cmsBag) {
    const rawBag = { rows: { 'Q-C1': [{}] }, calls };
    return evaluateFields(getContracts('conditions'), rawBag, cmsBag, { role: null, granularity: 'month' });
  }

  it('sums only Q-C2.conditions + Q-C4 rows (excludes accounts and Q-C3) and passes', () => {
    const fields = evalWithCalls(cms);
    const f = fields.find((x) => x.key === 'totalConditions');
    assert.strictEqual(f.expected, 3);
    assert.strictEqual(f.actual, 3);
    assert.strictEqual(f.pass, true);
    assert.strictEqual(f.required, true);
  });

  it('flags a CMS discrepancy as FAIL once totalConditions is required', () => {
    const bad = JSON.parse(JSON.stringify(cms));
    bad['C-COND'].debtor.accounts[0].conditions.push({}, {});
    const fields = evalWithCalls(bad);
    const f = fields.find((x) => x.key === 'totalConditions');
    assert.strictEqual(f.expected, 3);
    assert.strictEqual(f.actual, 5);
    assert.strictEqual(f.pass, false);
  });
});
