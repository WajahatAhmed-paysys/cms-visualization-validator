'use strict';

const { getView } = require('./registry');

/**
 * Availability status model
 * -------------------------
 * AVAILABLE (Green)  : every required query succeeded and the view is non-empty
 * EMPTY     (Yellow) : queries succeeded but the view would render empty
 * FAILED    (Red)    : a required query/endpoint failed
 * BLOCKED   (Grey)   : an upstream value is missing (e.g. null debtor id)
 * SKIPPED            : not requested / not applicable
 */

const SEVERITY = {
  SKIPPED: 0,
  BLOCKED: 1,
  AVAILABLE: 2,
  EMPTY: 3,
  FAILED: 4
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowsOf(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.rows)) return body.rows;
  return [];
}

function rowCountOf(call) {
  if (!call) return 0;
  if (typeof call.rowCount === 'number') return call.rowCount;
  if (call.body && typeof call.body.row_count === 'number') return call.body.row_count;
  return rowsOf(call.body).length;
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }
  if (value && Array.isArray(value.data)) return value.data;
  return [];
}

function findCall(calls, id) {
  return (calls || []).find((call) => call && call.id === id) || null;
}

function findCallBySubId(calls, subId) {
  return (calls || []).find((call) => call && call.subId === subId) || null;
}

function failureOf(calls) {
  return (calls || []).find((call) => call && !call.ok) || null;
}

function failureReason(label, call) {
  if (!call) return `${label}: not executed`;
  if (call.error) return `${call.id}: ${call.error.code} - ${call.error.message}`;
  const body = call.body || {};
  const detail = body.message || (body.detail && body.detail.message) || null;
  let reason = `${call.id}: HTTP ${call.statusCode}${detail ? ` - ${detail}` : ''}`;
  if (call.statusCode >= 500 && detail && /Failed to fetch|not running|not reachable|timeout|timed out/i.test(detail)) {
    reason += ' (downstream Lakehouse timeout — server-side; try lower concurrency or retry)';
  } else if (call.statusCode >= 500) {
    reason += ' (server error — retry may succeed)';
  }
  return reason;
}

function toStatusPayload(check, status, reason, calls, metrics) {
  const durations = (calls || []).map((call) => call.durationMs || 0);
  return {
    view: check.view,
    viewLabel: check.viewLabel,
    card: check.card,
    role: check.role || null,
    status,
    reason: reason || null,
    queries: calls || [],
    durationMs: check.durationMs != null ? check.durationMs : Math.max(0, ...durations),
    metrics: metrics || {}
  };
}

// ---------------------------------------------------------------------------
// CMS response helpers
// ---------------------------------------------------------------------------

function profileRowCount(body, role) {
  if (!body) return 0;
  const key = role === 'creditor' ? 'transactionCreditorResp' : 'transactionDebtorResp';
  const side = body[key];
  if (!side) return 0;
  if (typeof side.row_count === 'number') return side.row_count;
  if (Array.isArray(side.data)) return side.data.length;
  return 0;
}

function collectConditionIds(body) {
  const ids = new Set();
  const visited = new Set();

  function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 6 || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach((entry) => walk(entry, depth + 1));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'conditions' || key === 'entityConditions' || key === 'accountConditions') && Array.isArray(value)) {
        value.forEach((condition, index) => {
          const id =
            (condition && (condition.condition_id || condition.conditionId || condition.pk)) || `${key}:${depth}:${index}`;
          ids.add(String(id));
        });
      } else {
        walk(value, depth + 1);
      }
    }
  }

  walk(body, 0);
  return ids;
}

function countRawConditions(calls) {
  const ids = new Set();
  let anonymous = 0;
  for (const call of calls || []) {
    if (!call || !call.ok) continue;
    if (!['Q-C2', 'Q-C3', 'Q-C4'].includes(call.id)) continue;
    const rows = rowsOf(call.body);
    for (const row of rows) {
      const id = row && (row.condition_id || row.pk);
      if (id) ids.add(String(id));
      else anonymous += 1;
    }
  }
  return ids.size + anonymous;
}

// ---------------------------------------------------------------------------
// Per-view evaluators
// ---------------------------------------------------------------------------

const EVALUATORS = {
  'alert-navigator'(check, calls) {
    const call = findCall(calls, 'C-NAV') || findCall(calls, 'Q-NAV');
    if (!call) return toStatusPayload(check, 'FAILED', 'Q-NAV was not executed', calls);
    if (call.statusCode === 404) return toStatusPayload(check, 'BLOCKED', 'Alert not found (Q-NAV 404)', calls);
    if (!call.ok) return toStatusPayload(check, 'FAILED', failureReason('Alert Navigator', call), calls);

    if (call.mode === 'cms') {
      const body = call.body || {};
      const typologies = parseArray(body.typologies);
      if (body.alertMetadata && typologies.length >= 1) {
        return toStatusPayload(check, 'AVAILABLE', null, calls, { typologies: typologies.length });
      }
      if (body.alertMetadata) {
        return toStatusPayload(check, 'EMPTY', 'Alert found but no typologies', calls, { typologies: 0 });
      }
      return toStatusPayload(check, 'EMPTY', 'No alert metadata in response', calls);
    }

    const rows = rowsOf(call.body);
    if (!rows.length) return toStatusPayload(check, 'EMPTY', 'No alert_navigator_header row', calls);
    const typologies = parseArray(rows[0].typologies);
    return typologies.length
      ? toStatusPayload(check, 'AVAILABLE', null, calls, { typologies: typologies.length })
      : toStatusPayload(check, 'EMPTY', 'Alert row found but no typologies', calls, { typologies: 0 });
  },

  'transaction-details'(check, calls) {
    const call = findCall(calls, 'C-TD') || findCall(calls, 'Q-TD');
    if (!call) return toStatusPayload(check, 'BLOCKED', 'endToEndId could not be resolved', calls);
    if (call.statusCode === 404) {
      return toStatusPayload(check, 'FAILED', 'pacs.008 and/or pacs.002 row missing (Q-TD 404)', calls);
    }
    if (!call.ok) return toStatusPayload(check, 'FAILED', failureReason('Transaction Details', call), calls);

    if (call.mode === 'cms') {
      const overview = (call.body && call.body.transactionOverview) || {};
      if (overview.pacs8 && overview.pacs2) {
        return toStatusPayload(check, 'AVAILABLE', null, calls);
      }
      return toStatusPayload(check, 'FAILED', 'CMS returned without both pacs.008 and pacs.002 details', calls);
    }

    const types = new Set(rowsOf(call.body).map((row) => row && row.tx_type));
    if (types.has('pacs.008.001.10') && types.has('pacs.002.001.12')) {
      return toStatusPayload(check, 'AVAILABLE', null, calls, { rows: rowsOf(call.body).length });
    }
    return toStatusPayload(check, 'FAILED', 'transaction_detail lacks a pacs.008 and/or pacs.002 row', calls);
  },

  'profile-overview'(check, calls) {
    const rawId = check.role === 'creditor' ? 'Q-PROF-C' : 'Q-PROF-D';
    const call = findCall(calls, rawId) || findCall(calls, 'C-PROF');
    if (!call) return toStatusPayload(check, 'BLOCKED', 'Profile query was not executed', calls);
    if (call.statusCode === 404) return toStatusPayload(check, 'BLOCKED', 'Alert not found for profile generation', calls);
    if (!call.ok) return toStatusPayload(check, 'FAILED', failureReason('Profile Overview', call), calls);

    const count = call.mode === 'cms' ? profileRowCount(call.body, check.role) : rowsOf(call.body).length;
    if (count > 0) return toStatusPayload(check, 'AVAILABLE', null, calls, { rows: count });
    return toStatusPayload(check, 'EMPTY', 'No transaction history rows for this role', calls, { rows: 0 });
  },

  'network-transaction'(check, calls) {
    if (check.blockedReason) return toStatusPayload(check, 'BLOCKED', check.blockedReason, calls);
    const primary = findCall(calls, 'C-TN') || findCall(calls, 'Q-TN1');
    if (!primary) return toStatusPayload(check, 'BLOCKED', 'Role account id is missing', calls);
    if (primary.statusCode === 404) {
      return toStatusPayload(check, 'BLOCKED', 'Account not found in transaction data (Q-TN1 404)', calls);
    }
    if (!primary.ok) return toStatusPayload(check, 'FAILED', failureReason('Transaction Network', primary), calls);

    const required = (calls || []).filter((call) => ['C-TN', 'Q-TN1', 'Q-TN2', 'Q-TN3', 'Q-TN4'].includes(call.id));
    const failed = failureOf(required);
    if (failed) return toStatusPayload(check, 'FAILED', failureReason('Transaction Network', failed), calls);

    if (primary.mode === 'cms') {
      const body = primary.body || {};
      const connected = Array.isArray(body.connectedAccounts) ? body.connectedAccounts : [];
      if (!body.centerAccount) return toStatusPayload(check, 'EMPTY', 'Centre account absent from response', calls);
      if (connected.length > 0) {
        return toStatusPayload(check, 'AVAILABLE', null, calls, {
          connectedAccounts: connected.length,
          accountsWithAlerts: connected.filter((account) => account && account.hasAlert).length
        });
      }
      return toStatusPayload(check, 'EMPTY', 'Centre account found but no connected accounts', calls, {
        connectedAccounts: 0
      });
    }

    const centreRows = rowsOf(primary.body);
    if (!centreRows.length) return toStatusPayload(check, 'EMPTY', 'Centre account not found (Q-TN1 empty)', calls);
    const connectedIds = new Set();
    for (const id of ['Q-TN2', 'Q-TN3']) {
      const call = findCall(calls, id);
      if (!call || !call.ok) continue;
      for (const row of rowsOf(call.body)) {
        if (row && row.connected_account_id) connectedIds.add(String(row.connected_account_id));
      }
    }
    return connectedIds.size
      ? toStatusPayload(check, 'AVAILABLE', null, calls, { connectedAccounts: connectedIds.size })
      : toStatusPayload(check, 'EMPTY', 'No outbound or inbound connections', calls, { connectedAccounts: 0 });
  },

  'network-account'(check, calls) {
    if (check.blockedReason) return toStatusPayload(check, 'BLOCKED', check.blockedReason, calls);
    const primary = findCall(calls, 'C-AN') || findCall(calls, 'Q-A1');
    if (!primary) return toStatusPayload(check, 'BLOCKED', 'Role entity id is missing', calls);
    if (!primary.ok) return toStatusPayload(check, 'FAILED', failureReason('Account Network', primary), calls);

    const required = (calls || []).filter((call) => ['C-AN', 'Q-A1', 'Q-A2'].includes(call.id));
    const failed = failureOf(required);
    if (failed) return toStatusPayload(check, 'FAILED', failureReason('Account Network', failed), calls);

    if (primary.mode === 'cms') {
      const nodes = ((primary.body && primary.body.network && primary.body.network.nodes) || []).length;
      const edges = ((primary.body && primary.body.network && primary.body.network.edges) || []).length;
      return nodes > 1
        ? toStatusPayload(check, 'AVAILABLE', null, calls, { nodes, edges })
        : toStatusPayload(check, 'EMPTY', 'Only the root entity node was returned', calls, { nodes, edges });
    }

    const accounts = rowsOf(primary.body);
    if (accounts.length > 0) return toStatusPayload(check, 'AVAILABLE', null, calls, { accounts: accounts.length });
    return toStatusPayload(check, 'EMPTY', 'No account_holder rows for this entity', calls, { accounts: 0 });
  },

  'network-counterparty'(check, calls) {
    if (check.blockedReason) return toStatusPayload(check, 'BLOCKED', check.blockedReason, calls);
    const primary = findCall(calls, 'C-CPN') || findCall(calls, 'Q-CP1');
    if (!primary) return toStatusPayload(check, 'BLOCKED', 'Role entity id is missing', calls);
    if (!primary.ok) return toStatusPayload(check, 'FAILED', failureReason('Counterparty Network', primary), calls);

    // Q-CP4 is a fallback and may legitimately be empty; Q-CP3 is metrics only.
    const required = (calls || []).filter((call) => ['C-CPN', 'Q-CP1', 'Q-CP2'].includes(call.id));
    const failed = failureOf(required);
    if (failed) return toStatusPayload(check, 'FAILED', failureReason('Counterparty Network', failed), calls);

    if (primary.mode === 'cms') {
      const nodes = ((primary.body && primary.body.network && primary.body.network.nodes) || []).length;
      const edges = ((primary.body && primary.body.network && primary.body.network.edges) || []).length;
      return nodes > 1
        ? toStatusPayload(check, 'AVAILABLE', null, calls, { nodes, edges })
        : toStatusPayload(check, 'EMPTY', 'Only the root counterparty node was returned', calls, { nodes, edges });
    }

    const edges = rowsOf(primary.body);
    return edges.length
      ? toStatusPayload(check, 'AVAILABLE', null, calls, { edges: edges.length })
      : toStatusPayload(check, 'EMPTY', 'No counterparty edges for this entity', calls, { edges: 0 });
  },

  'alert-history'(check, calls) {
    if (check.blockedReason) return toStatusPayload(check, 'BLOCKED', check.blockedReason, calls);
    const summary = findCall(calls, 'C-AH-SUMMARY') || findCall(calls, 'Q-AH1');
    if (!summary) return toStatusPayload(check, 'BLOCKED', 'Role entity id is missing', calls);
    if (!summary.ok) return toStatusPayload(check, 'FAILED', failureReason('Alert History', summary), calls);

    const required = (calls || []).filter((call) =>
      ['C-AH-SUMMARY', 'C-AH-TIMELINE', 'C-AH-ALERTS', 'Q-AH1', 'Q-AH2', 'Q-AH3'].includes(call.id)
    );
    const failed = failureOf(required);
    if (failed) return toStatusPayload(check, 'FAILED', failureReason('Alert History', failed), calls);

    if (summary.mode === 'cms') {
      const totalAlerts = Number((summary.body && summary.body.totalAlerts) || 0);
      const timelineCall = findCall(calls, 'C-AH-TIMELINE');
      const timeline = (timelineCall && timelineCall.body && timelineCall.body.alertCountOverTime) || [];
      return totalAlerts > 0 || timeline.length > 0
        ? toStatusPayload(check, 'AVAILABLE', null, calls, { totalAlerts, timelinePoints: timeline.length })
        : toStatusPayload(check, 'EMPTY', 'Summary returned zeros (no alerts in the selected period)', calls, {
            totalAlerts: 0
          });
    }

    const summaryRows = rowsOf(summary.body);
    const totalAlerts = summaryRows.length ? Number(summaryRows[0].total_alerts || 0) : 0;
    const timelineCall = findCall(calls, 'Q-AH2');
    const timelineRows = timelineCall ? rowsOf(timelineCall.body) : [];
    return totalAlerts > 0 || timelineRows.length > 0
      ? toStatusPayload(check, 'AVAILABLE', null, calls, { totalAlerts, timelinePoints: timelineRows.length })
      : toStatusPayload(check, 'EMPTY', 'No alerts for this entity in the selected period', calls, { totalAlerts: 0 });
  },

  'transaction-history'(check, calls) {
    if (check.blockedReason) return toStatusPayload(check, 'BLOCKED', check.blockedReason, calls);
    const rowsCall = findCall(calls, 'C-TH') || findCall(calls, 'Q-TH1');
    if (!rowsCall) return toStatusPayload(check, 'BLOCKED', 'Role account id is missing', calls);
    if (!rowsCall.ok) return toStatusPayload(check, 'FAILED', failureReason('Transaction History', rowsCall), calls);

    // Q-TH3 (baseline) failure is swallowed by the CMS; Q-BF is a separate block.
    const failed = (calls || []).find(
      (call) => call && !call.ok && ['C-TH', 'Q-TH1', 'Q-TH2'].includes(call.id)
    );
    if (failed) return toStatusPayload(check, 'FAILED', failureReason('Transaction History', failed), calls);

    const benford = findCall(calls, 'Q-BF') || findCall(calls, 'C-BF');
    const benfordSample = benford && benford.ok
      ? benford.mode === 'cms'
        ? Number((benford.body && benford.body.sampleSize) || 0)
        : rowsOf(benford.body).length
      : 0;

    if (rowsCall.mode === 'cms') {
      const timeline = (rowsCall.body && rowsCall.body.timeline) || [];
      return timeline.length
        ? toStatusPayload(check, 'AVAILABLE', null, calls, { timelinePoints: timeline.length, benfordSample })
        : toStatusPayload(check, 'EMPTY', 'Transaction history timeline is empty', calls, {
            timelinePoints: 0,
            benfordSample
          });
    }

    const rows = rowsOf(rowsCall.body);
    return rows.length
      ? toStatusPayload(check, 'AVAILABLE', null, calls, { rows: rows.length, benfordSample })
      : toStatusPayload(check, 'EMPTY', 'No EVENT rows in transaction_history for this account', calls, {
          rows: 0,
          benfordSample
        });
  },

  conditions(check, calls) {
    if (check.blockedReason) return toStatusPayload(check, 'BLOCKED', check.blockedReason, calls);
    const transaction = findCall(calls, 'C-COND') || findCall(calls, 'Q-C1');
    if (!transaction) return toStatusPayload(check, 'BLOCKED', 'endToEndId could not be resolved', calls);
    if (transaction.statusCode === 404) {
      return toStatusPayload(check, 'FAILED', 'Transaction not found (Q-C1 404)', calls);
    }
    if (!transaction.ok) return toStatusPayload(check, 'FAILED', failureReason('Conditions', transaction), calls);

    if (transaction.mode === 'cms') {
      const ids = collectConditionIds(transaction.body);
      // Also count per-account details responses, in case a build does not embed
      // the nested condition arrays in the by-transaction payload.
      for (const call of calls || []) {
        if (call && call.id === 'C-COND-DETAILS' && call.ok) {
          for (const id of collectConditionIds(call.body)) ids.add(id);
        }
      }
      const count = ids.size;
      return count > 0
        ? toStatusPayload(check, 'AVAILABLE', null, calls, { conditions: count })
        : toStatusPayload(check, 'EMPTY', 'No conditions for either party', calls, { conditions: 0 });
    }

    const transactionRows = rowsOf(transaction.body);
    if (!transactionRows.length) return toStatusPayload(check, 'EMPTY', 'Transaction row not found', calls);
    const count = countRawConditions(calls);
    return count > 0
      ? toStatusPayload(check, 'AVAILABLE', null, calls, { conditions: count })
      : toStatusPayload(check, 'EMPTY', 'No conditions for either party', calls, { conditions: 0 });
  }
};

/**
 * Evaluate one role-view check.
 * @param {{view:string, viewLabel:string, card:string, role:string|null, blockedReason?:string, durationMs?:number}} check
 * @param {Array} calls
 */
function evaluateCheck(check, calls) {
  const view = getView(check.view);
  const evaluator = EVALUATORS[check.view];
  if (!view || !evaluator) {
    return toStatusPayload(check, 'FAILED', `No evaluator registered for view "${check.view}"`, calls);
  }
  try {
    return evaluator(check, calls || []);
  } catch (error) {
    return toStatusPayload(check, 'FAILED', `Status evaluation error: ${error.message}`, calls);
  }
}

/**
 * Group role-view checks into cards. A card header shows the worst of its rows
 * (Red > Yellow > Green > Grey) plus an `n/m available` summary.
 */
function aggregateCards(checks) {
  const cards = new Map();
  for (const check of checks) {
    if (!cards.has(check.card)) {
      cards.set(check.card, { card: check.card, rows: [], status: 'SKIPPED', available: 0, total: 0 });
    }
    const card = cards.get(check.card);
    card.rows.push(check);
    card.total += 1;
    if (check.status === 'AVAILABLE') card.available += 1;
    if ((SEVERITY[check.status] || 0) > (SEVERITY[card.status] || 0)) card.status = check.status;
  }
  return Array.from(cards.values());
}

function summarise(checks) {
  const summary = { available: 0, empty: 0, failed: 0, blocked: 0, skipped: 0, total: checks.length };
  for (const check of checks) {
    if (check.status === 'AVAILABLE') summary.available += 1;
    else if (check.status === 'EMPTY') summary.empty += 1;
    else if (check.status === 'FAILED') summary.failed += 1;
    else if (check.status === 'BLOCKED') summary.blocked += 1;
    else summary.skipped += 1;
  }
  return summary;
}

module.exports = {
  evaluateCheck,
  aggregateCards,
  summarise,
  rowsOf,
  rowCountOf,
  parseArray,
  collectConditionIds,
  SEVERITY
};
