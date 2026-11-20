'use strict';

/**
 * Field contracts per view (spec §4).
 *
 * A contract returns an array of fields:
 *   { key, kind, expected(rawBag, cmsBag, meta), actual(rawBag, cmsBag, meta), required, tolerance? }
 *
 * `rawBag`  = { rows: { 'Q-TH1': [...], 'Q-C2.accounts': [...] }, calls: [callRecord] }
 * `cmsBag`  = { 'C-TH': body, 'C-AH-SUMMARY': body, ... }
 * `meta`    = { role, granularity }
 */

const { parseArray, round2, num, sum, velocity, daysBetween } = require('./recompute');
const { cleanAccountId, unique } = require('../lib/ids');
const { lastNDays } = require('../lib/sql');

// --- helpers ---------------------------------------------------------------

function getPath(obj, path) {
  if (obj == null) return undefined;
  const parts = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

const flag = (value) => value === true || value === 1 || value === '1' || value === 'true';

const rows = (bag, id) => (bag && bag.rows && bag.rows[id]) || [];
const body = (cmsBag, id) => (cmsBag && cmsBag[id]) || null;
const callsBy = (bag, id, labelPart) =>
  ((bag && bag.calls) || []).filter(
    (call) => call && call.id === id && (!labelPart || String(call.label || '').toLowerCase().includes(labelPart))
  );

function field(key, kind, expected, actual, options = {}) {
  return Object.assign({ key, kind, expected, actual }, options);
}

// --- 4.1 Alert Navigator ---------------------------------------------------

function alertNavigator(rawBag, cmsBag) {
  const row = rows(rawBag, 'Q-NAV')[0] || {};
  const typologies = parseArray(row.typologies);
  const totalTypologies = typologies.filter((t) => t && t.typology_id != null).length;
  const totalRules = typologies.reduce((acc, t) => {
    // alerts-lakehouse.service.ts:175-176,204-211 — CMS counts only triggered rules:
    // rule_weight > 0 AND rule_id does NOT start with EFRuP.
    const rules = parseArray(t && t.rules).filter(
      (r) => r && Number(r.rule_weight) > 0 && !String(r.rule_id || '').startsWith('EFRuP@')
    );
    return acc + rules.length;
  }, 0);
  const nav = body(cmsBag, 'C-NAV') || {};
  const statistics = nav.statistics || {};

  return [
    field('alertId', 'count', () => num(row.alert_id), () => num(getPath(nav, 'alertMetadata.alertId'))),
    field('transactionId', 'string', () => String(row.transaction_id || ''), () => String(getPath(nav, 'alertMetadata.transactionId') || ''), {
      required: true
    }),
    field('amount', 'money', () => num(row.transaction_amount), () => num(getPath(nav, 'alertMetadata.amount'))),
    field('currency', 'string', () => String(row.transaction_currency || ''), () => String(getPath(nav, 'alertMetadata.currency') || '')),
    field('statistics.totalTypologies', 'count', () => totalTypologies, () => num(statistics.totalTypologies)),
    field('statistics.totalRules', 'count', () => totalRules, () => num(statistics.totalRules))
  ];
}

// --- 4.2 Transaction Details ----------------------------------------------

function transactionDetails(rawBag, cmsBag) {
  const all = rows(rawBag, 'Q-TD');
  const pacs8 = all.find((r) => r && r.tx_type === 'pacs.008.001.10') || {};
  const pacs2 = all.find((r) => r && r.tx_type === 'pacs.002.001.12') || {};
  const td = body(cmsBag, 'C-TD') || {};

  return [
    field('pacs8.transactionId', 'string', () => String(pacs8.tx_msg_id || ''), () => String(getPath(td, 'transactionOverview.pacs8.transactionId') || '')),
    field('pacs8.timestamp', 'date', () => pacs8.tx_event_ts, () => getPath(td, 'transactionOverview.pacs8.timestamp')),
    field('pacs2.transactionId', 'string', () => String(pacs2.tx_msg_id || ''), () => String(getPath(td, 'transactionOverview.pacs2.transactionId') || '')),
    field('amount.amount', 'money', () => num(pacs8.interbank_settlement_amount), () => num(getPath(td, 'transactionFlow.amount.amount'))),
    field('amount.currency', 'string', () => String(pacs8.interbank_settlement_currency || 'USD'), () => String(getPath(td, 'transactionFlow.amount.currency') || '')),
    field('debtor.iban', 'string', () => String(pacs8.debtor_account_id || ''), () => String(getPath(td, 'transactionFlow.debtor.account.iban') || '')),
    field('creditor.iban', 'string', () => String(pacs8.creditor_account_id || ''), () => String(getPath(td, 'transactionFlow.creditor.account.iban') || '')),
    field('exchangeRate', 'money', () => num(pacs8.exchange_rate) || 1, () => num(getPath(td, 'amountAndCurrency[0].exchangeRate')), {
      required: true
    }),
    field('chargeTotal', 'money', () => num(pacs8.charge_total_amount), () => num(getPath(td, 'amountAndCurrency[1].totalCharges')), {
      required: true
    })
  ];
}

// --- 4.3 Transaction History ----------------------------------------------

function transactionHistory(rawBag, cmsBag, meta) {
  const events = rows(rawBag, 'Q-TH1');
  const baseline = rows(rawBag, 'Q-TH3');
  const benfordRows = rows(rawBag, 'Q-BF');
  const th = body(cmsBag, 'C-TH') || {};
  const summary = th.summary || {};

  // transaction-lakehouse.service.ts:255-258,277-278 —
  // totalTransactions counts only pacs.008 rows; totalVolume sums ALL events;
  // alerts/investigated count over all events; percentages use the pacs.008 count
  // as the denominator.
  const totalTransactions = events.filter((e) => e.tx_type === 'pacs.008.001.10').length;
  const volume = round2(sum(events, (e) => e.tx_amount));
  const alerts = events.filter((e) => Number(e.is_alerted) === 1).length;
  const investigated = events.filter((e) => Number(e.is_investigated) === 1).length;
  const pct = (n) => (totalTransactions > 0 ? round2((n / totalTransactions) * 100) : 0);

  const expectedBaselineCount = baseline.length && baseline[0].total_tx_count != null ? num(baseline[0].total_tx_count) : null;
  const expectedBaselineVolume = baseline.length && baseline[0].total_amount != null ? round2(sum(baseline, (b) => b.total_amount)) : null;

  // Window the CMS was called with (verify always sends start/end; default last 90d).
  const [defaultFrom, defaultTo] = lastNDays(90);
  const windowFrom = (meta && meta.fromDate) || defaultFrom;
  const windowTo = (meta && meta.toDate) || defaultTo;
  const durationDays = daysBetween(windowFrom, windowTo);
  const avgPerDay = durationDays > 0 ? totalTransactions / durationDays : 0;

  return [
    field('summary.totalTransactions', 'count', () => totalTransactions, () => num(summary.totalTransactions), {
      input: () => `${events.length} EVENT rows, pacs.008 = ${totalTransactions}`
    }),
    field('summary.totalVolume', 'money', () => volume, () => num(summary.totalVolume)),
    field('summary.alertsTriggered', 'count', () => alerts, () => num(summary.alertsTriggered)),
    field('summary.investigated', 'count', () => investigated, () => num(summary.investigated)),
    field('summary.alertsPercentage', 'percent', () => pct(alerts), () => num(summary.alertsPercentage)),
    field('summary.investigatedPercentage', 'percent', () => pct(investigated), () => num(summary.investigatedPercentage)),
    field('summary.durationDays', 'count', () => durationDays, () => num(summary.durationDays), {
      required: false,
      input: () => `${windowFrom} → ${windowTo} (inclusive)`
    }),
    field('summary.avgTransactionsPerDay', 'money', () => avgPerDay, () => num(summary.avgTransactionsPerDay), {
      required: false,
      input: () => `${totalTransactions} / ${durationDays}`
    }),
    field('summary.expected.transactionCount', 'count', () => expectedBaselineCount, () => num(getPath(summary, 'expected.transactionCount')), {
      required: true,
      input: () => 'SUM(tx_count) from counterparty_account_links'
    }),
    field('summary.expected.volume', 'money', () => expectedBaselineVolume, () => num(getPath(summary, 'expected.volume')), {
      required: true,
      input: () => 'SUM(total_amount) from counterparty_account_links'
    }),
    field('benfordSample', 'count', () => benfordRows.length, () => num(getPath(body(cmsBag, 'C-BF') || {}, 'sampleSize')), {
      required: true,
      input: () => `Q-BF amount rows = ${benfordRows.length}`
    })
  ];
}

// --- 4.4 Account Network ---------------------------------------------------

function accountNetwork(rawBag, cmsBag) {
  const accounts = unique(rows(rawBag, 'Q-A1').map((r) => cleanAccountId(r.destination || r.account_id)));
  const edges = rows(rawBag, 'Q-A2');
  const an = body(cmsBag, 'C-AN') || {};
  const nodes = getPath(an, 'network.nodes') || [];
  const accountNodes = nodes.filter((n) => n && n.type === 'ACCOUNT').length;
  const transactions = round2(sum(edges, (e) => e.tx_count));

  return [
    field('network.accounts', 'count', () => accounts.length, () => accountNodes),
    // account-lakehouse.service.ts:308-339 — one edge per held account (entity -> account);
    // NOT plus Q-A2 row count. accountDetails tx/value are summed from Q-A2 rows (:344-345).
    field('network.edges', 'count', () => accounts.length, () => (getPath(an, 'network.edges') || []).length),
    field('accountDetails.transactions', 'count', () => transactions, () => num(getPath(an, 'accountDetails.transactions'))),
    field('accountDetails.totalValue', 'money', () => round2(sum(edges, (e) => e.total_amount)), () => num(getPath(an, 'accountDetails.totalValue'))),
    field('accountDetails.velocity', 'string', () => velocity(transactions), () => String(getPath(an, 'accountDetails.velocity') || ''))
  ];
}

// --- 4.5 Counterparty Network ---------------------------------------------

function counterpartyNetwork(rawBag, cmsBag) {
  const edges = rows(rawBag, 'Q-CP1');
  const metrics = rows(rawBag, 'Q-CP3')[0] || {};
  const cpn = body(cmsBag, 'C-CPN') || {};

  const nodeIds = unique(edges.flatMap((e) => [e.from_counterparty_id, e.to_counterparty_id]));
  const pairs = new Set(edges.map((e) => [e.from_counterparty_id, e.to_counterparty_id].filter(Boolean).sort().join('->')));
  const transactions = num(metrics.transactions);

  return [
    field('network.nodes', 'count', () => nodeIds.length, () => (getPath(cpn, 'network.nodes') || []).length),
    field('network.edges', 'count', () => pairs.size, () => (getPath(cpn, 'network.edges') || []).length),
    field('counterpartyDetails.transactions', 'count', () => transactions, () => num(getPath(cpn, 'counterpartyDetails.transactions'))),
    field('counterpartyDetails.totalValue', 'money', () => round2(num(metrics.total_value)), () => num(getPath(cpn, 'counterpartyDetails.totalValue'))),
    field('counterpartyDetails.velocity', 'string', () => velocity(transactions), () => String(getPath(cpn, 'counterpartyDetails.velocity') || ''))
  ];
}

// --- 4.6 Transaction Network ----------------------------------------------

function transactionNetwork(rawBag, cmsBag) {
  const tn2 = rows(rawBag, 'Q-TN2');
  const tn3 = rows(rawBag, 'Q-TN3');
  const tn4 = rows(rawBag, 'Q-TN4');
  const tn5 = rows(rawBag, 'Q-TN5');
  const tn = body(cmsBag, 'C-TN') || {};
  const summary = getPath(tn, 'centerAccount.networkSummary') || {};

  const connected = unique(tn2.concat(tn3).map((r) => r.connected_account_id));

  // accounts-with-alerts: union of TN5 AGG flags and TN4 per-transaction flags.
  const alerted = new Set();
  for (const row of tn5) {
    if (row && row.entity_id && (flag(row.is_alerted) || flag(row.is_investigated))) alerted.add(String(row.entity_id));
  }
  for (const row of tn4) {
    if (!row) continue;
    if (flag(row.is_alerted) || flag(row.is_investigated)) {
      if (row.debtor_account_id) alerted.add(String(row.debtor_account_id));
      if (row.creditor_account_id) alerted.add(String(row.creditor_account_id));
    }
  }
  const alertedConnected = connected.filter((acct) => alerted.has(String(acct))).length;

  const edgeCount = tn4.length > 0 ? tn4.length : tn2.length + tn3.length;

  return [
    field('connectedAccounts', 'count', () => connected.length, () => (getPath(tn, 'connectedAccounts') || []).length),
    field('summary.connectedAccounts', 'count', () => connected.length, () => num(summary.connectedAccounts)),
    field('summary.outboundConnections', 'count', () => tn2.length, () => num(summary.outboundConnections)),
    field('summary.inboundConnections', 'count', () => tn3.length, () => num(summary.inboundConnections)),
    field('summary.accountsWithAlerts', 'count', () => alertedConnected, () => num(summary.accountsWithAlerts), { required: true }),
    field('edgeCount', 'count', () => edgeCount, () => (getPath(tn, 'edges') || []).length)
  ];
}

// --- 4.7 Alert History -----------------------------------------------------

function alertHistory(rawBag, cmsBag) {
  const summaryRow = rows(rawBag, 'Q-AH1')[0] || {};
  const timeline = rows(rawBag, 'Q-AH2');
  const summary = body(cmsBag, 'C-AH-SUMMARY') || (body(cmsBag, 'C-AH-SUMMARY.body') || {});
  const timelineBody = body(cmsBag, 'C-AH-TIMELINE') || {};

  return [
    field('summary.totalAlerts', 'count', () => num(summaryRow.total_alerts), () => num(summary.totalAlerts)),
    field('summary.casesOpened', 'count', () => num(summaryRow.cases_opened), () => num(summary.casesOpened)),
    field('summary.investigations', 'count', () => num(summaryRow.investigations), () => num(summary.investigations)),
    field('summary.sarFilings', 'count', () => num(summaryRow.sar_filings), () => num(summary.sarFilings)),
    field('summary.totalValue', 'money', () => round2(num(summaryRow.total_value)), () => num(summary.totalValue)),
    field('timeline.points', 'count', () => timeline.length, () => (getPath(timelineBody, 'alertCountOverTime') || []).length)
  ];
}

// --- 4.8 Conditions --------------------------------------------------------

function countConditionsInBody(conditionBody) {
  if (!conditionBody) return 0;
  let count = 0;
  for (const party of ['debtor', 'creditor']) {
    for (const account of getPath(conditionBody, `${party}.accounts`) || []) {
      count += (account && Array.isArray(account.conditions) ? account.conditions.length : 0);
    }
  }
  for (const key of ['debtor.entityConditions', 'creditor.entityConditions']) {
    const arr = getPath(conditionBody, key);
    if (Array.isArray(arr)) count += arr.length;
  }
  return count;
}

function countRawConditions(rawBag) {
  // Mirror CMS counting: sum per-account condition rows + entity-level rows.
  // Only Q-C2.conditions (NOT Q-C2.accounts) and Q-C4 contribute; Q-C3 is the
  // same data as Q-C2.conditions and would double-count.
  let total = 0;
  for (const call of rawBag.calls || []) {
    if (!call || !call.ok) continue;
    const accountConds = call.id === 'Q-C2' && call.subId === 'Q-C2.conditions';
    const entityConds = call.id === 'Q-C4';
    if (!accountConds && !entityConds) continue;
    total += rawBagRows(call).length;
  }
  return total;
}

function conditions(rawBag, cmsBag) {
  const c1 = rows(rawBag, 'Q-C1')[0] || {};
  const cond = body(cmsBag, 'C-COND') || {};

  const debtorAccounts = unique(
    callsBy(rawBag, 'Q-C2', 'debtor')
      .flatMap((call) => rawBagRows(call))
      .map((entry) => cleanAccountId(entry && (entry.account_id || entry.destination)))
      .concat(c1.debtor_account_id ? [cleanAccountId(c1.debtor_account_id)] : [])
  );
  const creditorAccounts = unique(
    callsBy(rawBag, 'Q-C2', 'creditor')
      .flatMap((call) => rawBagRows(call))
      .map((entry) => cleanAccountId(entry && (entry.account_id || entry.destination)))
      .concat(c1.creditor_account_id ? [cleanAccountId(c1.creditor_account_id)] : [])
  );

  return [
    field('transaction.amount', 'money', () => num(c1.interbank_settlement_amount), () => num(getPath(cond, 'transaction.amount'))),
    field('transaction.currency', 'string', () => String(c1.interbank_settlement_currency || ''), () => String(getPath(cond, 'transaction.currency') || '')),
    field('transaction.type', 'string', () => String(c1.tx_type || ''), () => String(getPath(cond, 'transaction.type') || '')),
    field('debtor.accounts', 'count', () => debtorAccounts.length, () => (getPath(cond, 'debtor.accounts') || []).length, { required: true }),
    field('creditor.accounts', 'count', () => creditorAccounts.length, () => (getPath(cond, 'creditor.accounts') || []).length, { required: true }),
    // condition-lakehouse.service.ts — CMS sums per-account array lengths + entity arrays
    // (no global de-dup), and uses raw account_holder.destination ids (:23,:33).
    field('totalConditions', 'count', () => countRawConditions(rawBag), () => countConditionsInBody(cond), { required: true })
  ];
}

function rawBagRows(call) {
  if (!call || !call.body) return [];
  if (Array.isArray(call.body.data)) return call.body.data;
  if (Array.isArray(call.body)) return call.body;
  return [];
}

// --- 4.9 Profile Overview (informational only) ----------------------------

function profileOverview(rawBag, cmsBag, meta) {
  const envelope = body(cmsBag, 'C-PROF') || {};
  const side = meta && meta.role === 'debtor' ? envelope.transactionDebtorResp : envelope.transactionCreditorResp;
  const data = side && Array.isArray(side.data) ? side.data : [];
  const rowCount = side && typeof side.row_count === 'number' ? side.row_count : data.length;
  const totalAmount = round2(sum(data, (row) => row && row.tx_amount));

  return [
    field('totalTransactions', 'informational', () => rowCount, () => rowCount),
    field('totalAmount', 'informational', () => totalAmount, () => totalAmount)
  ];
}

const VIEW_CONTRACTS = {
  'alert-navigator': alertNavigator,
  'transaction-details': transactionDetails,
  'transaction-history': transactionHistory,
  'network-account': accountNetwork,
  'network-counterparty': counterpartyNetwork,
  'network-transaction': transactionNetwork,
  'alert-history': alertHistory,
  conditions: conditions,
  'profile-overview': profileOverview
};

function getContracts(viewKey) {
  return VIEW_CONTRACTS[viewKey] || null;
}

module.exports = { VIEW_CONTRACTS, getContracts };
