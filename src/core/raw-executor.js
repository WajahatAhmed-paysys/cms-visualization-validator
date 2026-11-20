'use strict';

const { http } = require('../lib/http');
const { authHeaders } = require('../core/auth');
const { rowsOf } = require('../core/status');
const { withEntitySuffix, cleanAccountId, unique } = require('../lib/ids');
const raw = require('../queries/raw');
const cms = require('../queries/cms');

/**
 * Raw-SQL mode: execute every labelled query directly against the Lakehouse
 * API (`/execute_sql`, plus `/query` for Q-TD) for per-query isolation and
 * timings. Bootstrap identifiers (P1/P2/Q-EM) are resolved through the CMS
 * entity-metadata endpoint because Postgres is not reachable from here.
 */

function callRecord(definition, response, semantic) {
  return {
    id: definition.id,
    subId: definition.subId || null,
    label: definition.label || definition.id,
    mode: 'raw',
    semantic: semantic || 'row-detail',
    ok: response.ok,
    statusCode: response.statusCode,
    durationMs: response.durationMs,
    body: response.body,
    error: response.error,
    request: response.request,
    sql: definition.sql || null,
    limit: definition.limit,
    rowCount:
      response.body && typeof response.body.row_count === 'number'
        ? response.body.row_count
        : rowsOf(response.body).length
  };
}

async function withRetry(ctx, fn) {
  let response = await fn();
  if (!response.ok && ctx.retryTransient && (response.error || response.statusCode >= 500)) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    response = await fn();
  }
  return response;
}

async function executeSql(ctx, definition) {
  if (!definition) return null;
  const response = await withRetry(ctx, () =>
    http({
      method: 'POST',
      url: `${ctx.config.lakehouseBaseUrl}/execute_sql`,
      headers: authHeaders(ctx.token),
      body: { sql_query: definition.sql, limit: definition.limit },
      timeoutMs: ctx.requestTimeoutMs || ctx.config.requestTimeoutMs
    })
  );
  return callRecord(definition, response, definition.semantic);
}

async function queryTable(ctx, definition) {
  if (!definition) return null;
  const response = await withRetry(ctx, () =>
    http({
      method: 'POST',
      url: `${ctx.config.lakehouseBaseUrl}/query`,
      headers: authHeaders(ctx.token),
      body: definition.tableQuery,
      timeoutMs: ctx.requestTimeoutMs || ctx.config.requestTimeoutMs
    })
  );
  return callRecord(definition, response, 'row-detail');
}

// ---------------------------------------------------------------------------
// Per-view raw runners. Each returns an array of call records.
// ---------------------------------------------------------------------------

async function rawAlertNavigator(ctx) {
  const base = raw.qNav(ctx);
  let call = await executeSql(ctx, { ...base, label: 'Q-NAV Alert Navigator', semantic: 'aggregate' });

  // Schema tolerance: retry without columns that some deployments do not have.
  const bodyText = call && call.body ? JSON.stringify(call.body) : '';
  if (call && !call.ok && /UNRESOLVED_COLUMN|block_or_override_status/i.test(bodyText)) {
    const fallback = raw.qNav(ctx, { includeBlockStatus: false });
    const retried = await executeSql(ctx, {
      ...fallback,
      label: 'Q-NAV Alert Navigator (fallback: no block_or_override_status)',
      semantic: 'aggregate'
    });
    retried.subId = 'Q-NAV.fallback';
    call = retried;
  }
  return [call].filter(Boolean);
}

async function rawTransactionDetails(ctx) {
  const definition = raw.qTd(ctx);
  if (!definition) return [];
  return [await queryTable(ctx, { ...definition, label: 'Q-TD Transaction Details' })].filter(Boolean);
}

async function rawProfile(ctx) {
  // referenceId is server-resolved (Postgres) and not exposed to clients, so
  // the profile query shapes cannot be issued faithfully against /execute_sql.
  // Fall back to the CMS endpoint, which resolves referenceId internally.
  const call = await cms.profileGenerate(ctx);
  call.subId = 'Q-PROF (via CMS; referenceId server-side)';
  return [call];
}

async function rawTransactionNetwork(ctx, role) {
  const accountId = ctx.ids[`${role}AccountId`];
  if (!accountId) return [];

  const tn1 = await executeSql(ctx, { ...raw.qTn1(ctx, accountId), label: `Q-TN1 centre - ${role}` });
  const calls = [tn1].filter(Boolean);
  if (!tn1 || !tn1.ok || rowsOf(tn1.body).length === 0) return calls;

  const [tn2, tn3, tn4] = await Promise.all([
    executeSql(ctx, { ...raw.qTn2(ctx, accountId, ctx.fromDate, ctx.toDate), label: `Q-TN2 outbound - ${role}` }),
    executeSql(ctx, { ...raw.qTn3(ctx, accountId, ctx.fromDate, ctx.toDate), label: `Q-TN3 inbound - ${role}` }),
    executeSql(ctx, { ...raw.qTn4(ctx, accountId, ctx.fromDate, ctx.toDate), label: `Q-TN4 edges - ${role}` })
  ]);
  calls.push(...[tn2, tn3, tn4].filter(Boolean));

  if ([tn2, tn3].some((call) => call && !call.ok)) return calls;

  const connected = unique(
    [tn2, tn3]
      .flatMap((call) => (call ? rowsOf(call.body) : []))
      .map((row) => row && row.connected_account_id)
  );
  const allAccounts = unique([accountId, ...connected]);

  const [tn5, tn6] = await Promise.all([
    executeSql(ctx, { ...raw.qTn5(ctx, allAccounts), label: `Q-TN5 flags - ${role}` }),
    executeSql(ctx, { ...raw.qTn6(ctx, allAccounts), label: `Q-TN6 links - ${role}` })
  ]);
  calls.push(...[tn5, tn6].filter(Boolean));
  return calls;
}

async function rawAccountNetwork(ctx, role) {
  const entityId = ctx.ids[`${role}Id`];
  if (!entityId) return [];

  const a1 = await executeSql(ctx, { ...raw.qA1(ctx, entityId), label: `Q-A1 accounts - ${role}` });
  const calls = [a1].filter(Boolean);
  if (!a1 || !a1.ok) return calls;

  const accountIds = unique(rowsOf(a1.body).map((row) => row && (row.destination || row.account_id)));
  const a2Definition = raw.qA2(ctx, entityId, accountIds);
  if (a2Definition) {
    calls.push(await executeSql(ctx, { ...a2Definition, label: `Q-A2 edges - ${role}` }));
  }
  return calls.filter(Boolean);
}

async function rawCounterpartyNetwork(ctx, role) {
  const entityId = ctx.ids[`${role}Id`];
  if (!entityId) return [];

  const cp1 = await executeSql(ctx, { ...raw.qCp1(ctx, entityId), label: `Q-CP1 edges - ${role}` });
  const calls = [cp1].filter(Boolean);
  if (!cp1 || !cp1.ok) return calls;

  const nodeIds = unique(
    rowsOf(cp1.body).flatMap((row) => [row && row.from_counterparty_id, row && row.to_counterparty_id])
  );
  const cp2Definition = raw.qCp2(ctx, nodeIds);

  const [cp2, cp3, cp4] = await Promise.all([
    cp2Definition ? executeSql(ctx, { ...cp2Definition, label: `Q-CP2 names - ${role}`, semantic: 'metadata' }) : null,
    executeSql(ctx, { ...raw.qCp3(ctx, entityId), label: `Q-CP3 metrics - ${role}`, semantic: 'aggregate' }),
    executeSql(ctx, { ...raw.qCp4(ctx, entityId), label: `Q-CP4 name fallback - ${role}`, semantic: 'metadata' })
  ]);
  calls.push(...[cp2, cp3, cp4].filter(Boolean));
  return calls;
}

async function rawAlertHistory(ctx, role) {
  const entityId = ctx.ids[`${role}Id`];
  if (!entityId) return [];

  const results = await Promise.all([
    executeSql(ctx, { ...raw.qAh1(ctx, entityId), label: `Q-AH1 summary - ${role}`, semantic: 'aggregate' }),
    executeSql(ctx, { ...raw.qAh2(ctx, entityId), label: `Q-AH2 timeline - ${role}`, semantic: 'aggregate' }),
    executeSql(ctx, { ...raw.qAh3Count(ctx, entityId), label: `Q-AH3 count - ${role}`, semantic: 'aggregate' }),
    executeSql(ctx, { ...raw.qAh3Page(ctx, entityId), label: `Q-AH3 page - ${role}`, semantic: 'row-detail' })
  ]);
  return results.filter(Boolean);
}

async function rawTransactionHistory(ctx, role) {
  const accountId = ctx.ids[`${role}AccountId`];
  if (!accountId) return [];

  const [from, to] = ctx.fromDate && ctx.toDate ? [ctx.fromDate, ctx.toDate] : cms.benfordWindow(ctx);
  const results = await Promise.all([
    executeSql(ctx, { ...raw.qTh1(ctx, accountId), label: `Q-TH1 events - ${role}` }),
    executeSql(ctx, { ...raw.qTh2(ctx, accountId), label: `Q-TH2 buckets - ${role}`, semantic: 'aggregate' }),
    executeSql(ctx, { ...raw.qTh3(ctx, accountId), label: `Q-TH3 baseline - ${role}`, semantic: 'aggregate' }),
    executeSql(ctx, { ...raw.qBf(ctx, accountId, from, to), label: `Q-BF benford - ${role}`, semantic: 'aggregate' })
  ]);
  return results.filter(Boolean);
}

async function rawConditions(ctx) {
  const c1Definition = raw.qC1(ctx);
  if (!c1Definition) return [];
  const c1 = await executeSql(ctx, { ...c1Definition, label: 'Q-C1 transaction parties' });
  const calls = [c1].filter(Boolean);
  if (!c1 || !c1.ok || rowsOf(c1.body).length === 0) return calls;

  const row = rowsOf(c1.body)[0];
  const parties = [
    { role: 'debtor', id: row.debtor_id, primaryAccount: row.debtor_account_id },
    { role: 'creditor', id: row.creditor_id, primaryAccount: row.creditor_account_id }
  ];

  const accountGroups = await Promise.all(
    parties.map(async (party) => {
      if (!party.id) return [];
      const holderCall = await executeSql(ctx, {
        ...raw.qC2a(ctx, party.id),
        label: `Q-C2 accounts - ${party.role}`
      });
      const calls = [holderCall].filter(Boolean);
      if (!holderCall || !holderCall.ok) return calls;

      const accounts = unique(
        // NOTE: rawConditions cleans ids here. The CMS conditions service uses the
        // raw account_holder.destination; both forms have been observed to return
        // the same condition rows for the sampled alert, but if a future alert
        // mismatches on totalConditions, verify the id form first.
        rowsOf(holderCall.body)
          .map((entry) => entry && (entry.account_id || entry.destination))
          .concat(party.primaryAccount ? [party.primaryAccount] : [])
          .map(cleanAccountId)
      );
      if (!accounts.length) return calls;

      const perAccount = await Promise.all(
        accounts.flatMap((accountId) => [
          executeSql(ctx, { ...raw.qC2b(ctx, accountId), label: `Q-C2 conditions - ${accountId}` }),
          executeSql(ctx, { ...raw.qC3(ctx, accountId), label: `Q-C3 details - ${accountId}` })
        ])
      );
      calls.push(...perAccount.filter(Boolean));
      return calls;
    })
  );

  const entityCalls = await Promise.all(
    parties.filter((party) => party.id).map((party) =>
      executeSql(ctx, { ...raw.qC4(ctx, party.id), label: `Q-C4 entity conditions - ${party.role}` })
    )
  );

  return calls.concat(...accountGroups, ...entityCalls.filter(Boolean));
}

const RAW_RUNNERS = {
  'alert-navigator': () => rawAlertNavigator,
  'transaction-details': () => rawTransactionDetails,
  'profile-overview': () => rawProfile,
  'network-transaction': rawTransactionNetwork,
  'network-account': rawAccountNetwork,
  'network-counterparty': rawCounterpartyNetwork,
  'alert-history': rawAlertHistory,
  'transaction-history': rawTransactionHistory,
  conditions: rawConditions
};

module.exports = {
  executeSql,
  queryTable,
  rawAlertNavigator,
  rawTransactionDetails,
  rawProfile,
  rawTransactionNetwork,
  rawAccountNetwork,
  rawCounterpartyNetwork,
  rawAlertHistory,
  rawTransactionHistory,
  rawConditions,
  RAW_RUNNERS
};
