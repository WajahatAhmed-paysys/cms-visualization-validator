'use strict';

const { http } = require('../lib/http');
const { authHeaders } = require('../core/auth');
const { lastNDays, dateOnly } = require('../lib/sql');

/**
 * CMS-proxy mode: call the same endpoints the React tabs and Voila notebooks
 * call, so the validator reflects exactly what the CMS would render.
 */

async function authorisedCall(ctx, options) {
  const doCall = () =>
    http({
      method: options.method || 'GET',
      url: `${ctx.config.cmsBaseUrl}${options.path}`,
      query: options.query,
      headers: authHeaders(ctx.token),
      body: options.body,
      timeoutMs: ctx.requestTimeoutMs || ctx.config.requestTimeoutMs
    });

  let result = await doCall();
  let attempts = 1;

  // One transparent re-login on an expired token.
  if (result.statusCode === 401 && typeof ctx.reauth === 'function') {
    await ctx.reauth();
    result = await doCall();
    attempts += 1;
  }

  // Optional single retry for transient downstream failures (5xx / timeout).
  if (!result.ok && ctx.retryTransient && isTransientFailure(result)) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    result = await doCall();
    attempts += 1;
  }

  return {
    id: options.id,
    subId: options.subId || null,
    label: options.label,
    mode: 'cms',
    semantic: options.semantic || 'row-detail',
    attempts,
    ...result,
    rowCount: extractRowCount(result.body)
  };
}

function isTransientFailure(result) {
  if (!result) return false;
  if (result.error) return true;
  return typeof result.statusCode === 'number' && result.statusCode >= 500;
}

function extractRowCount(body) {
  if (!body) return undefined;
  if (typeof body.row_count === 'number') return body.row_count;
  if (Array.isArray(body.data)) return body.data.length;
  if (Array.isArray(body.rows)) return body.rows.length;
  if (Array.isArray(body.timeline)) return body.timeline.length;
  if (Array.isArray(body.alerts)) return body.alerts.length;
  if (body.network && Array.isArray(body.network.nodes)) return body.network.nodes.length;
  return undefined;
}

function enc(value) {
  return encodeURIComponent(String(value));
}

async function authMe(ctx) {
  return authorisedCall(ctx, {
    id: 'C-ME',
    label: 'CMS /v1/auth/me',
    path: '/v1/auth/me'
  });
}

async function entityMetadata(ctx) {
  return authorisedCall(ctx, {
    id: 'C-EM',
    label: 'Entity metadata (P1, P2, Q-EM)',
    path: `/api/v1/lakehouse/entity-metadata/${enc(ctx.alertId)}`,
    query: { tenantId: ctx.tenantId },
    semantic: 'metadata'
  });
}

async function alertNavigator(ctx) {
  return authorisedCall(ctx, {
    id: 'C-NAV',
    label: 'Alert Navigator (Q-NAV)',
    path: `/api/v1/lakehouse/alert-navigator/${enc(ctx.alertId)}`,
    query: { tenantId: ctx.tenantId },
    semantic: 'aggregate'
  });
}

async function transactionDetails(ctx) {
  if (!ctx.e2eId) return null;
  return authorisedCall(ctx, {
    id: 'C-TD',
    label: 'Transaction Details (Q-TD)',
    path: `/api/v1/lakehouse/transaction-detail/${enc(ctx.e2eId)}`,
    query: { tenantId: ctx.tenantId },
    semantic: 'row-detail'
  });
}

async function profileGenerate(ctx) {
  return authorisedCall(ctx, {
    id: 'C-PROF',
    label: 'Profile Overview (P1, P2, Q-PROF-C/D)',
    method: 'POST',
    path: `/api/v1/lakehouse/profile/generate/${enc(ctx.alertId)}`,
    body: { tenantId: ctx.tenantId },
    semantic: 'row-detail'
  });
}

function networkTimeParams(ctx) {
  const params = { tenantId: ctx.tenantId, timeRange: ctx.timeRange };
  if (ctx.fromDate) params.startDate = ctx.fromDate;
  if (ctx.toDate) params.endDate = ctx.toDate;
  return params;
}

async function transactionNetwork(ctx, role, accountId) {
  return authorisedCall(ctx, {
    id: 'C-TN',
    label: `Transaction Network (Q-TN1..6) - ${role}`,
    path: `/api/v1/jupyter/proxy/network-analysis/transaction/${enc(accountId)}`,
    query: networkTimeParams(ctx),
    semantic: 'graph'
  });
}

async function accountNetwork(ctx, role, entityId) {
  return authorisedCall(ctx, {
    id: 'C-AN',
    label: `Account Network (Q-A1, Q-A2) - ${role}`,
    path: `/api/v1/jupyter/proxy/network-analysis/entity/${enc(entityId)}`,
    query: { tenantId: ctx.tenantId, granularity: ctx.granularity },
    semantic: 'graph'
  });
}

async function counterpartyNetwork(ctx, role, entityId) {
  return authorisedCall(ctx, {
    id: 'C-CPN',
    label: `Counterparty Network (Q-CP1..4) - ${role}`,
    path: `/api/v1/jupyter/proxy/network-analysis/counterparty-node/${enc(entityId)}`,
    query: { tenantId: ctx.tenantId, granularity: ctx.granularity },
    semantic: 'graph'
  });
}

async function alertHistory(ctx, role, entityId) {
  const base = { tenantId: ctx.tenantId, entityId, granularity: ctx.granularity };
  const [summary, timeline, alerts] = await Promise.all([
    authorisedCall(ctx, {
      id: 'C-AH-SUMMARY',
      label: `Alert History summary (Q-AH1) - ${role}`,
      path: '/api/v1/jupyter/proxy/alert-history/summary',
      query: base,
      semantic: 'aggregate'
    }),
    authorisedCall(ctx, {
      id: 'C-AH-TIMELINE',
      label: `Alert History timeline (Q-AH2) - ${role}`,
      path: '/api/v1/jupyter/proxy/alert-history/timeline',
      query: base,
      semantic: 'aggregate'
    }),
    authorisedCall(ctx, {
      id: 'C-AH-ALERTS',
      label: `Alert History alerts page (Q-AH3) - ${role}`,
      path: '/api/v1/jupyter/proxy/alert-history/alerts',
      query: { ...base, page: 1, limit: 1000 },
      semantic: 'row-detail'
    })
  ]);
  return [summary, timeline, alerts];
}

async function transactionHistory(ctx, role, accountId) {
  const [from, to] = benfordWindow(ctx);
  const [history, benford] = await Promise.all([
    authorisedCall(ctx, {
      id: 'C-TH',
      label: `Transaction History (Q-TH1..3) - ${role}`,
      path: `/api/v1/jupyter/proxy/transaction-history/${enc(accountId)}`,
      query: {
        tenantId: ctx.tenantId,
        startDate: ctx.fromDate || from,
        endDate: ctx.toDate || to,
        granularity: ctx.granularity
      },
      semantic: 'row-detail'
    }),
    authorisedCall(ctx, {
      id: 'C-BF',
      label: `Benford analysis (Q-BF) - ${role}`,
      path: `/api/v1/jupyter/proxy/lake/analytics/benford/account/${enc(accountId)}`,
      query: { tenantId: ctx.tenantId, from: ctx.fromDate || from, to: ctx.toDate || to },
      semantic: 'aggregate'
    })
  ]);
  return [history, benford];
}

async function conditions(ctx) {
  if (!ctx.e2eId) return [];
  const transaction = await authorisedCall(ctx, {
    id: 'C-COND',
    label: 'Conditions by transaction (Q-C1, Q-C2, Q-C4)',
    path: `/api/v1/jupyter/proxy/conditions/by-transaction/${enc(ctx.e2eId)}`,
    query: { tenantId: ctx.tenantId },
    semantic: 'row-detail'
  });

  const calls = [transaction];
  if (!transaction.ok) return calls;

  // The by-transaction response already carries per-account condition arrays;
  // the details endpoint is called per account for per-account drill-down.
  const accounts = extractAccounts(transaction.body).slice(0, 20);
  const details = await Promise.all(
    accounts.map((account) =>
      authorisedCall(ctx, {
        id: 'C-COND-DETAILS',
        subId: account.accountId,
        label: `Conditions details - ${account.role} account ${account.accountId}`,
        path: '/api/v1/jupyter/proxy/conditions/details',
        query: { tenantId: ctx.tenantId, accountId: account.accountId },
        semantic: 'row-detail'
      })
    )
  );
  return calls.concat(details);
}

function extractAccounts(body) {
  const seen = new Set();
  const accounts = [];
  const push = (party, role) => {
    if (!party || !Array.isArray(party.accounts)) return;
    for (const entry of party.accounts) {
      const id =
        entry.accountId ||
        entry.account_id ||
        (entry.account && (entry.account.accountId || entry.account.account_id)) ||
        entry.id;
      if (!id) continue;
      const key = `${role}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      accounts.push({ role, accountId: id });
    }
  };
  push(body.debtor, 'debtor');
  push(body.creditor, 'creditor');
  return accounts;
}

function benfordWindow(ctx) {
  if (ctx.fromDate && ctx.toDate) return [ctx.fromDate, ctx.toDate];
  return lastNDays(90);
}

function today() {
  return dateOnly(new Date());
}

module.exports = {
  authorisedCall,
  authMe,
  entityMetadata,
  alertNavigator,
  transactionDetails,
  profileGenerate,
  transactionNetwork,
  accountNetwork,
  counterpartyNetwork,
  alertHistory,
  transactionHistory,
  conditions,
  extractAccounts,
  benfordWindow,
  today
};
