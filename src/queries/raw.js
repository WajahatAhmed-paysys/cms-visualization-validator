'use strict';

const sql = require('../lib/sql');
const { withEntitySuffix, cleanAccountId, unique } = require('../lib/ids');

/**
 * Raw query catalogue.
 *
 * Every builder returns `{ id, sql, limit }` for POST /execute_sql, or
 * `{ id, tableQuery, limit }` for POST /query, or `null` when the required
 * upstream value is not available.
 *
 * Labelled query identifiers (`P1`, `Q-TN2`, ...) are documentation ids; they
 * do not exist in the CMS source code.
 */

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

// P1 and P2 are Postgres lookups inside the CMS backend. They are not
// reachable from the Lakehouse API, so raw mode borrows them through the CMS
// `entity-metadata` endpoint. Kept in the catalogue for completeness.

// Q-EM: executed by the CMS with the server-resolved `referenceId`.
function qEm(ctx) {
  if (!ctx.referenceId) return null;
  return {
    id: 'Q-EM',
    limit: 1,
    sql: `
SELECT
  DISTINCT
  td.debtor_Id,
  td.debtor_account_id,
  td.debtor_name,
  td.creditor_id,
  td.creditor_account_id,
  td.creditor_name
FROM transaction_detail td
WHERE td.end_to_end_id = ${sql.literal(ctx.referenceId)}
  AND td.tenant_id = ${sql.literal(ctx.tenantId)}
  AND td.tx_type = 'pacs.008.001.10'`
  };
}

// ---------------------------------------------------------------------------
// Alert Navigator
// ---------------------------------------------------------------------------

function qNav(ctx, options = {}) {
  const alertId = sql.numeric(ctx.alertId);
  const tenantId = sql.literal(ctx.tenantId);
  // Some deployed schemas lack `block_or_override_status`; allow a tolerant variant.
  const includeBlockStatus = options.includeBlockStatus !== false;
  return {
    id: 'Q-NAV',
    limit: 1,
    sql: `
WITH rules_agg AS (
    SELECT
        anr.alert_id,
        anr.tenant_id,
        anr.typology_id,
        anr.typology_cfg,
        COLLECT_LIST(
            NAMED_STRUCT(
                'rule_id',                   anr.rule_id,
                'rule_cfg',                  anr.rule_cfg,
                'rule_weight',               anr.rule_weight,
                'rule_independent_variable', anr.rule_independent_variable,
                'rule_sub_ref',              anr.rule_sub_ref,
                'rule_processing_time_ms',   anr.rule_processing_time_ms,
                'rule_tenant_id',            anr.rule_tenant_id,
                'rule_desc',                 anr.rule_desc,
                'matched_band_reason',       anr.matched_band_reason
            )
        ) AS rules
    FROM alert_navigator_rules anr
    WHERE anr.alert_id  = ${alertId}
      AND anr.tenant_id = ${tenantId}
      AND (
        anr.rule_weight > 0
        OR anr.rule_id LIKE 'EFRuP@%'
      )
    GROUP BY
        anr.alert_id,
        anr.tenant_id,
        anr.typology_id,
        anr.typology_cfg
)
SELECT
    anh.alert_id,
    anh.tenant_id,
    anh.case_id,
    anh.tx_msg_id,
    anh.tx_type,
    anh.alert_timestamp,
    anh.alert_reason,
    anh.alert_type,
    anh.prediction_outcome,
    anh.priority,
    anh.priority_score,
    anh.evaluation_id,
    anh.alert_status,
    anh.transaction_status,
    anh.transaction_amount,
    anh.transaction_currency,
    anh.transaction_id,
${includeBlockStatus ? '    anh.block_or_override_status,\n' : ''}    anh.alert_date,
    COLLECT_LIST(
        NAMED_STRUCT(
            'typology_id',               ant.typology_id,
            'typology_cfg',              ant.typology_cfg,
            'typology_score',            ant.typology_score,
            'typology_review',           ant.typology_review,
            'typology_processing_time_ms', ant.typology_processing_time_ms,
            'typology_tenant_id',        ant.typology_tenant_id,
            'flow_processor',            ant.flow_processor,
            'alert_threshold',           ant.alert_threshold,
            'interdiction_threshold',    ant.interdiction_threshold,
            'rule_count_in_typology',    ant.rule_count_in_typology,
            'rules',                     ra.rules
        )
    ) AS typologies
FROM alert_navigator_header anh
LEFT JOIN alert_navigator_typologies ant
    ON  ant.alert_id  = anh.alert_id
    AND ant.tenant_id = anh.tenant_id
LEFT JOIN rules_agg ra
    ON  ra.alert_id     = ant.alert_id
    AND ra.tenant_id    = ant.tenant_id
    AND ra.typology_id  = ant.typology_id
    AND ra.typology_cfg = ant.typology_cfg
WHERE
    anh.alert_id  = ${alertId}
    AND anh.tenant_id = ${tenantId}
GROUP BY
    anh.alert_id, anh.tenant_id, anh.case_id, anh.tx_msg_id, anh.tx_type,
    anh.alert_timestamp, anh.alert_reason, anh.alert_type, anh.prediction_outcome,
    anh.priority, anh.priority_score, anh.evaluation_id, anh.alert_status,
    anh.transaction_status, anh.transaction_amount, anh.transaction_currency,
    anh.transaction_id, ${includeBlockStatus ? 'anh.block_or_override_status, ' : ''}anh.alert_date`
  };
}

// ---------------------------------------------------------------------------
// Transaction Details (uses POST /query, not /execute_sql)
// ---------------------------------------------------------------------------

function qTd(ctx) {
  if (!ctx.e2eId) return null;
  return {
    id: 'Q-TD',
    limit: 100,
    tableQuery: {
      table_name: 'transaction_detail',
      filters: {
        end_to_end_id: ctx.e2eId,
        tenant_id: ctx.tenantId
      },
      columns: [
        'transaction_id',
        'tx_msg_id',
        'tx_event_ts',
        'tx_type',
        'interbank_settlement_amount',
        'interbank_settlement_currency',
        'debtor_name',
        'debtor_account_id',
        'creditor_name',
        'creditor_account_id',
        'instg_mmb_id',
        'instd_mmb_id',
        'instructed_amount',
        'instructed_currency',
        'exchange_rate',
        'charge_total_amount',
        'charge_currency',
        'tx_event_date'
      ]
    }
  };
}

// ---------------------------------------------------------------------------
// Profile Overview
// ---------------------------------------------------------------------------

function qProf(role, ctx) {
  if (!ctx.referenceId) return null;
  const id = role === 'creditor' ? 'Q-PROF-C' : 'Q-PROF-D';
  const idColumn = role === 'creditor' ? 'td_src.creditor_id' : 'td_src.debtor_id';
  const nameColumn = role === 'creditor' ? 'td_src.creditor_name' : 'td_src.debtor_name';

  return {
    id,
    limit: 1000,
    sql: `
SELECT DISTINCT
  th.tx_msg_id, td_src.tx_event_ts as event_date, th.tx_amount, th.tx_ccy, th.tx_type,
  th.is_alerted, th.is_investigated, th.cum_tx_count, th.cum_tx_amount,
  th.entity_role, ${nameColumn}, th.entity_id, th.entity_type
FROM transaction_detail td_src
INNER JOIN transaction_history th
  ON th.entity_id IN (${idColumn})
 AND th.tenant_id = td_src.tenant_id
 AND th.row_type = 'EVENT'
WHERE td_src.end_to_end_id = ${sql.literal(ctx.referenceId)}
  AND td_src.tenant_id = ${sql.literal(ctx.tenantId)}
  AND td_src.tx_type = 'pacs.008.001.10'
ORDER BY event_date DESC`
  };
}

// ---------------------------------------------------------------------------
// Account Network
// ---------------------------------------------------------------------------

function qA1(ctx, entityId) {
  if (!entityId) return null;
  return {
    id: 'Q-A1',
    limit: 100,
    sql: `
SELECT *
FROM account_holder ah
WHERE ah.source = ${sql.literal(withEntitySuffix(entityId))}
  AND ah.tenant_id = ${sql.literal(ctx.tenantId)}`
  };
}

function qA2(ctx, entityId, accountIds) {
  const ids = unique((accountIds || []).map(cleanAccountId));
  if (!ids.length) return null;
  const inClause = sql.list(ids);
  return {
    id: 'Q-A2',
    limit: 1000,
    sql: `
SELECT from_account_id, to_account_id, tx_count, total_amount, currency_hint,
       first_event_ts, last_event_ts, is_alerted_edge, is_investigated_edge
FROM tx_network_accounts_edges
WHERE tenant_id = ${sql.literal(ctx.tenantId)}
  AND bucket_granularity = ${sql.literal(ctx.granularity)}
  AND (
    from_account_id IN (${inClause})
    OR to_account_id IN (${inClause})
  )`
  };
}

// ---------------------------------------------------------------------------
// Counterparty Network
// ---------------------------------------------------------------------------

function qCp1(ctx, counterpartyId) {
  if (!counterpartyId) return null;
  const cp = sql.literal(counterpartyId);
  return {
    id: 'Q-CP1',
    limit: 1000,
    sql: `
WITH first_degree AS (
  SELECT
    CASE
      WHEN from_counterparty_id = ${cp} THEN to_counterparty_id
      ELSE from_counterparty_id
    END AS counterparty_id
  FROM tx_network_counterparties_edges
  WHERE tenant_id = ${sql.literal(ctx.tenantId)}
    AND bucket_granularity = ${sql.literal(ctx.granularity)}
    AND (
      from_counterparty_id = ${cp}
      OR to_counterparty_id = ${cp}
    )
),
network_seeds AS (
  SELECT ${cp} AS counterparty_id
  UNION
  SELECT counterparty_id FROM first_degree
)
SELECT
  from_counterparty_id,
  to_counterparty_id,
  tx_count,
  total_amount,
  currency_hint,
  first_event_ts,
  last_event_ts,
  is_alerted_edge,
  is_investigated_edge,
  CASE
    WHEN from_counterparty_id = ${cp} OR to_counterparty_id = ${cp} THEN 1
    ELSE 2
  END AS degree
FROM tx_network_counterparties_edges
WHERE tenant_id = ${sql.literal(ctx.tenantId)}
  AND bucket_granularity = ${sql.literal(ctx.granularity)}
  AND (
    from_counterparty_id IN (SELECT counterparty_id FROM network_seeds)
    OR to_counterparty_id IN (SELECT counterparty_id FROM network_seeds)
  )`
  };
}

function qCp2(ctx, nodeIds) {
  const ids = unique(nodeIds || []);
  if (!ids.length) return null;
  return {
    id: 'Q-CP2',
    limit: 1000,
    sql: `
SELECT
  cal.counterparty_id,
  CASE
    WHEN cal.counterparty_id LIKE 'dbtr_%' THEN td.debtor_name
    WHEN cal.counterparty_id LIKE 'cdtr_%' THEN td.creditor_name
    ELSE COALESCE(td.debtor_name, td.creditor_name)
  END AS holder_name
FROM counterparty_account_links cal
LEFT JOIN transaction_detail td ON (
  (cal.counterparty_id LIKE 'dbtr_%' AND td.debtor_account_id = cal.account_id)
  OR (cal.counterparty_id LIKE 'cdtr_%' AND td.creditor_account_id = cal.account_id)
)
WHERE cal.tenant_id = ${sql.literal(ctx.tenantId)}
  AND cal.counterparty_id IN (${sql.list(ids)})`
  };
}

function qCp3(ctx, counterpartyId) {
  if (!counterpartyId) return null;
  return {
    id: 'Q-CP3',
    limit: 1,
    sql: `
SELECT
  SUM(tx_count) AS transactions,
  SUM(total_amount) AS total_value,
  MAX(is_alerted_edge) AS is_alerted,
  MAX(is_investigated_edge) AS is_investigated,
  MIN(first_event_ts) AS first_event_ts,
  MAX(last_event_ts) AS last_event_ts
FROM tx_network_counterparties_edges
WHERE tenant_id = ${sql.literal(ctx.tenantId)}
  AND bucket_granularity = ${sql.literal(ctx.granularity)}
  AND (
    from_counterparty_id = ${sql.literal(counterpartyId)}
    OR to_counterparty_id = ${sql.literal(counterpartyId)}
  )`
  };
}

function qCp4(ctx, counterpartyId) {
  if (!counterpartyId) return null;
  return {
    id: 'Q-CP4',
    limit: 1,
    sql: `
SELECT DISTINCT debtor_name AS holder_name
FROM transaction_detail td
JOIN counterparty_account_links cal ON td.debtor_account_id = cal.account_id
WHERE td.tenant_id = ${sql.literal(ctx.tenantId)}
  AND cal.counterparty_id = ${sql.literal(counterpartyId)}
LIMIT 1`
  };
}

// ---------------------------------------------------------------------------
// Transaction Network
// ---------------------------------------------------------------------------

function qTn1(ctx, accountId) {
  if (!accountId) return null;
  return {
    id: 'Q-TN1',
    limit: 1,
    sql: `
SELECT DISTINCT
  COALESCE(debtor_account_id, creditor_account_id) as account_id,
  COALESCE(debtor_name, creditor_name) as account_name
FROM transaction_detail
WHERE (debtor_account_id = ${sql.literal(accountId)} OR creditor_account_id = ${sql.literal(accountId)})
  AND tenant_id = ${sql.literal(ctx.tenantId)}
LIMIT 1`
  };
}

function qTn2(ctx, accountId, from, to) {
  if (!accountId) return null;
  return {
    id: 'Q-TN2',
    limit: 1000,
    sql: `
SELECT
  creditor_account_id as connected_account_id,
  creditor_name as connected_account_name,
  'OUTBOUND' as flow_direction,
  COUNT(transaction_id) as total_transactions,
  SUM(interbank_settlement_amount) as total_value,
  AVG(interbank_settlement_amount) as avg_value,
  MIN(tx_event_ts) as first_tx_date,
  MAX(tx_event_ts) as last_tx_date
FROM transaction_detail
WHERE debtor_account_id = ${sql.literal(accountId)}
  AND tenant_id = ${sql.literal(ctx.tenantId)}${sql.dateRangeClause('tx_event_ts', from, to)}
GROUP BY creditor_account_id, creditor_name`
  };
}

function qTn3(ctx, accountId, from, to) {
  if (!accountId) return null;
  return {
    id: 'Q-TN3',
    limit: 1000,
    sql: `
SELECT
  debtor_account_id as connected_account_id,
  debtor_name as connected_account_name,
  'INBOUND' as flow_direction,
  COUNT(transaction_id) as total_transactions,
  SUM(interbank_settlement_amount) as total_value,
  AVG(interbank_settlement_amount) as avg_value,
  MIN(tx_event_ts) as first_tx_date,
  MAX(tx_event_ts) as last_tx_date
FROM transaction_detail
WHERE creditor_account_id = ${sql.literal(accountId)}
  AND tenant_id = ${sql.literal(ctx.tenantId)}${sql.dateRangeClause('tx_event_ts', from, to)}
GROUP BY debtor_account_id, debtor_name`
  };
}

function qTn4(ctx, accountId, from, to) {
  if (!accountId) return null;
  return {
    id: 'Q-TN4',
    limit: 1000,
    sql: `
SELECT
  td.transaction_id,
  td.debtor_account_id,
  td.debtor_name,
  td.creditor_account_id,
  td.creditor_name,
  td.interbank_settlement_amount,
  td.interbank_settlement_currency,
  td.tx_event_ts,
  MAX(COALESCE(th.is_alerted, 0)) AS is_alerted,
  MAX(COALESCE(th.is_investigated, 0)) AS is_investigated
FROM transaction_detail td
LEFT JOIN transaction_history th
  ON th.transaction_id = td.transaction_id
  AND th.tenant_id = td.tenant_id
  AND th.row_type = 'EVENT'
WHERE (td.debtor_account_id = ${sql.literal(accountId)} OR td.creditor_account_id = ${sql.literal(accountId)})
  AND td.tenant_id = ${sql.literal(ctx.tenantId)}${sql.dateRangeClause('td.tx_event_ts', from, to)}
GROUP BY
  td.transaction_id, td.debtor_account_id, td.debtor_name,
  td.creditor_account_id, td.creditor_name,
  td.interbank_settlement_amount, td.interbank_settlement_currency, td.tx_event_ts
ORDER BY td.tx_event_ts ASC`
  };
}

function qTn5(ctx, accountIds) {
  const ids = unique(accountIds || []);
  if (!ids.length) return null;
  return {
    id: 'Q-TN5',
    limit: ids.length,
    sql: `
SELECT
  entity_id,
  MAX(COALESCE(is_alerted, 0))      as is_alerted,
  MAX(COALESCE(is_investigated, 0)) as is_investigated
FROM transaction_history
WHERE tenant_id = ${sql.literal(ctx.tenantId)}
  AND row_type = 'AGG'
  AND entity_id IN (${sql.list(ids)})
GROUP BY entity_id`
  };
}

function qTn6(ctx, accountIds) {
  const ids = unique(accountIds || []);
  if (!ids.length) return null;
  return {
    id: 'Q-TN6',
    limit: ids.length,
    sql: `
SELECT DISTINCT account_id, counterparty_id
FROM counterparty_account_links
WHERE tenant_id = ${sql.literal(ctx.tenantId)}
  AND account_id IN (${sql.list(ids)})`
  };
}

// ---------------------------------------------------------------------------
// Alert History (values interpolated, not positional)
// ---------------------------------------------------------------------------

function ahDateFilterClause(ctx) {
  // Determinism (spec §14.1): when a pinned `now` is supplied, use it so the raw
  // date filter matches the CMS's request-time period start exactly.
  const start = sql.periodStart(ctx.granularity, ctx.now);
  if (!start) return '';
  return `\n  AND a.created_at_ts >= ${sql.literal(start)}`;
}

function qAh1(ctx, entityId) {
  if (!entityId) return null;
  const entity = sql.literal(entityId);
  return {
    id: 'Q-AH1',
    limit: 1,
    sql: `
SELECT
  CASE WHEN td.debtor_id = ${entity} THEN td.debtor_id ELSE td.creditor_id END AS entity_id,
  CASE WHEN td.debtor_id = ${entity} THEN td.debtor_name ELSE td.creditor_name END AS entity_name,
  CASE WHEN td.debtor_id = ${entity} THEN 'DEBTOR' ELSE 'CREDITOR' END AS entity_role,
  COUNT(DISTINCT a.alert_id) AS total_alerts,
  COUNT(DISTINCT c.case_id) FILTER (WHERE c.case_id IS NOT NULL) AS cases_opened,
  COUNT(DISTINCT CASE WHEN c.status LIKE 'STATUS_%' AND c.status != 'STATUS_00_DRAFT' THEN c.case_id END) AS investigations,
  COALESCE(SUM(t.sar_filings), 0) AS sar_filings,
  COALESCE(SUM(td.instructed_amount), 0) AS total_value
FROM alerts a
LEFT JOIN transaction_detail td
  ON a.tx_original_e2e_id = td.end_to_end_id AND td.tx_type = 'pacs.008.001.10'
LEFT JOIN cases c ON a.case_id = c.case_id
LEFT JOIN (
  SELECT case_id,
         COUNT(DISTINCT task_id) FILTER (WHERE task_type LIKE '%SAR_STR_FILING%') AS sar_filings
  FROM tasks
  GROUP BY case_id
) t ON c.case_id = t.case_id
WHERE a.tenant_id = ${sql.literal(ctx.tenantId)}${ahDateFilterClause(ctx)}
  AND (td.debtor_id = ${entity} OR td.creditor_id = ${entity})
GROUP BY entity_id, entity_name, entity_role`
  };
}

function qAh2(ctx, entityId) {
  if (!entityId) return null;
  const entity = sql.literal(entityId);
  return {
    id: 'Q-AH2',
    limit: 1000,
    sql: `
SELECT
  DATE_TRUNC('month', a.created_at_ts) as date,
  COUNT(DISTINCT a.alert_id) as alert_count,
  COUNT(DISTINCT c.case_id) FILTER (WHERE c.case_id IS NOT NULL) as case_count,
  COUNT(DISTINCT CASE WHEN c.status LIKE 'STATUS_%' AND c.status != 'STATUS_00_DRAFT' THEN c.case_id END) as investigation_count,
  COALESCE(SUM(td.instructed_amount), 0) as total_value
FROM alerts a
LEFT JOIN transaction_detail td
  ON a.tx_original_e2e_id = td.end_to_end_id AND td.tx_type = 'pacs.008.001.10'
LEFT JOIN cases c ON a.case_id = c.case_id
WHERE 1=1
  AND a.tenant_id = ${sql.literal(ctx.tenantId)}${ahDateFilterClause(ctx)}
  AND (td.debtor_id = ${entity} OR td.creditor_id = ${entity})
GROUP BY DATE_TRUNC('month', a.created_at_ts)
ORDER BY date ASC`
  };
}

function qAh3Count(ctx, entityId) {
  if (!entityId) return null;
  const entity = sql.literal(entityId);
  return {
    id: 'Q-AH3',
    subId: 'Q-AH3.count',
    limit: 1,
    sql: `
SELECT COUNT(DISTINCT a.alert_id) as total
FROM alerts a
LEFT JOIN transaction_detail td
  ON a.tx_original_e2e_id = td.end_to_end_id AND td.tx_type = 'pacs.008.001.10'
WHERE 1=1
  AND a.tenant_id = ${sql.literal(ctx.tenantId)}${ahDateFilterClause(ctx)}
  AND (td.debtor_id = ${entity} OR td.creditor_id = ${entity})`
  };
}

function qAh3Page(ctx, entityId, pageLimit = 1000) {
  if (!entityId) return null;
  const entity = sql.literal(entityId);
  return {
    id: 'Q-AH3',
    subId: 'Q-AH3.page',
    limit: pageLimit,
    sql: `
SELECT DISTINCT
  a.alert_id, a.created_at_ts as date, a.alert_type_norm as type,
  a.priority_norm as severity, a.alert_status as status, a.case_id,
  c.status as case_status, a.evaluation_id
FROM alerts a
LEFT JOIN transaction_detail td
  ON a.tx_original_e2e_id = td.end_to_end_id AND td.tx_type = 'pacs.008.001.10'
LEFT JOIN cases c ON a.case_id = c.case_id
WHERE 1=1
  AND a.tenant_id = ${sql.literal(ctx.tenantId)}${ahDateFilterClause(ctx)}
  AND (td.debtor_id = ${entity} OR td.creditor_id = ${entity})
ORDER BY date DESC
LIMIT 1000 OFFSET 0`
  };
}

// ---------------------------------------------------------------------------
// Transaction History + Benford
// ---------------------------------------------------------------------------

function qTh1(ctx, accountId) {
  if (!accountId) return null;
  return {
    id: 'Q-TH1',
    limit: 1000,
    sql: `
SELECT DISTINCT th.end_to_end_id, th.tx_msg_id, th.end_to_end_id, th.transaction_id,
  td.tx_event_ts as event_date, th.tx_amount, th.tx_ccy, th.tx_type,
  th.is_alerted, th.is_investigated, th.cum_tx_count, th.cum_tx_amount,
  th.entity_role, td.debtor_name, td.creditor_name
FROM transaction_history th
LEFT JOIN transaction_detail td
  ON th.transaction_id = td.transaction_id AND th.tenant_id = td.tenant_id
WHERE th.row_type = 'EVENT'
  AND th.entity_id = ${sql.literal(accountId)}
  AND th.tenant_id = ${sql.literal(ctx.tenantId)}
  AND td.debtor_name IS NOT NULL
  AND td.creditor_name IS NOT NULL
ORDER BY event_date DESC`
  };
}

function qTh2(ctx, accountId) {
  if (!accountId) return null;
  return {
    id: 'Q-TH2',
    limit: 1000,
    sql: `
SELECT bucket_start, bucket_tx_count, bucket_tx_amount, bucket_granularity
FROM transaction_history
WHERE row_type = 'AGG'
  AND entity_id = ${sql.literal(accountId)}
  AND bucket_granularity = ${sql.literal(ctx.granularity)}
  AND tenant_id = ${sql.literal(ctx.tenantId)}
ORDER BY bucket_start ASC`
  };
}

function qTh3(ctx, accountId) {
  if (!accountId) return null;
  return {
    id: 'Q-TH3',
    limit: 100,
    sql: `
SELECT SUM(tx_count) as total_tx_count, SUM(total_amount) as total_amount
FROM counterparty_account_links
WHERE account_id = ${sql.literal(accountId)}
  AND tenant_id = ${sql.literal(ctx.tenantId)}`
  };
}

function qBf(ctx, accountId, from, to) {
  if (!accountId || !from || !to) return null;
  return {
    id: 'Q-BF',
    limit: 100000,
    sql: `
SELECT ABS(interbank_settlement_amount) AS amount
FROM transaction_detail
WHERE tenant_id = ${sql.literal(ctx.tenantId)}
  AND interbank_settlement_amount IS NOT NULL
  AND interbank_settlement_amount > 0
  AND (debtor_account_id = ${sql.literal(accountId)} OR creditor_account_id = ${sql.literal(accountId)})
  AND tx_event_date BETWEEN ${sql.literal(from)} AND ${sql.literal(to)}`
  };
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

function qC1(ctx) {
  if (!ctx.e2eId) return null;
  return {
    id: 'Q-C1',
    limit: 1,
    sql: `
SELECT transaction_id, end_to_end_id, tx_event_ts, tx_event_date, tx_type, interbank_settlement_amount, interbank_settlement_currency,
debtor_id, debtor_name, debtor_account_id, creditor_id, creditor_name, creditor_account_id
FROM transaction_detail
WHERE end_to_end_id = ${sql.literal(ctx.e2eId)} AND tenant_id = ${sql.literal(ctx.tenantId)}
  AND tx_type = 'pacs.008.001.10'
ORDER BY tx_event_ts DESC
LIMIT 1`
  };
}

function qC2a(ctx, partyId) {
  if (!partyId) return null;
  return {
    id: 'Q-C2',
    subId: 'Q-C2.accounts',
    limit: 100,
    sql: `
SELECT DISTINCT destination as account_id
FROM account_holder
WHERE source = ${sql.literal(withEntitySuffix(partyId))}
  AND tenant_id = ${sql.literal(ctx.tenantId)}`
  };
}

function qC2b(ctx, accountId) {
  if (!accountId) return null;
  const account = sql.literal(accountId);
  return {
    id: 'Q-C2',
    subId: 'Q-C2.conditions',
    limit: 500,
    sql: `
SELECT pk, condition_id, condition_reason, condition_type, perspective, condition_inception_ts, condition_expiry_ts,
condition_created_ts, is_active, is_expired, account_id, entity_id, tenant_id, account_scheme, event_types_csv, created_by_user
FROM conditions
WHERE (condition_key_key = ${account} OR account_id = ${account})
  AND tenant_id = ${sql.literal(ctx.tenantId)}`
  };
}

function qC3(ctx, accountId, asOfDate, showInactive) {
  if (!accountId) return null;
  let asOfClause = '';
  if (asOfDate && !showInactive) {
    const asOf = sql.literal(asOfDate);
    asOfClause = `\n  AND ct.condition_inception_ts <= ${asOf}\n  AND (ct.condition_expiry_ts IS NULL OR ct.condition_expiry_ts >= ${asOf})`;
  }
  return {
    id: 'Q-C3',
    limit: 500,
    sql: `
SELECT
  ct.condition_id, ct.condition_reason, ct.condition_type, ct.perspective,
  ct.condition_inception_ts, ct.condition_expiry_ts, ct.condition_created_ts,
  ct.is_active, ct.is_expired, ct.account_id, ct.tenant_id,
  ct.account_scheme, ct.event_types_csv, ct.created_by_user
FROM conditions ct
WHERE ct.account_id = ${sql.literal(accountId)}
  AND ct.tenant_id = ${sql.literal(ctx.tenantId)}${asOfClause}
ORDER BY ct.condition_inception_ts DESC
LIMIT 500`
  };
}

function qC4(ctx, entityId) {
  if (!entityId) return null;
  return {
    id: 'Q-C4',
    limit: 500,
    sql: `
SELECT pk, condition_id, condition_reason, condition_type, perspective, condition_inception_ts, condition_expiry_ts,
condition_created_ts, is_active, is_expired, account_id, entity_id, tenant_id, account_scheme, event_types_csv, created_by_user
FROM conditions
WHERE entity_id = ${sql.literal(entityId)}
  AND target_type = 'ENTITY'
  AND tenant_id = ${sql.literal(ctx.tenantId)}
ORDER BY condition_inception_ts DESC
LIMIT 500`
  };
}

// ---------------------------------------------------------------------------
// Catalogue metadata (30 labels / 31 statements)
// ---------------------------------------------------------------------------

const RAW_QUERY_CATALOGUE = [
  { id: 'P1', label: 'Postgres alert row', view: 'bootstrap', kind: 'postgres' },
  { id: 'P2', label: 'Postgres reference-id field name', view: 'bootstrap', kind: 'postgres' },
  { id: 'Q-EM', label: 'Entity metadata', view: 'bootstrap', kind: 'sql' },
  { id: 'Q-NAV', label: 'Alert Navigator', view: 'alert-navigator', kind: 'sql' },
  { id: 'Q-TD', label: 'Transaction Details', view: 'transaction-details', kind: 'table-query' },
  { id: 'Q-PROF-C', label: 'Profile - creditor', view: 'profile-overview', kind: 'sql' },
  { id: 'Q-PROF-D', label: 'Profile - debtor', view: 'profile-overview', kind: 'sql' },
  { id: 'Q-A1', label: 'Account Network - accounts', view: 'network-account', kind: 'sql' },
  { id: 'Q-A2', label: 'Account Network - edges', view: 'network-account', kind: 'sql' },
  { id: 'Q-CP1', label: 'Counterparty Network - edges', view: 'network-counterparty', kind: 'sql' },
  { id: 'Q-CP2', label: 'Counterparty Network - names', view: 'network-counterparty', kind: 'sql' },
  { id: 'Q-CP3', label: 'Counterparty Network - metrics', view: 'network-counterparty', kind: 'sql' },
  { id: 'Q-CP4', label: 'Counterparty Network - name fallback', view: 'network-counterparty', kind: 'sql' },
  { id: 'Q-TN1', label: 'Transaction Network - centre', view: 'network-transaction', kind: 'sql' },
  { id: 'Q-TN2', label: 'Transaction Network - outbound', view: 'network-transaction', kind: 'sql' },
  { id: 'Q-TN3', label: 'Transaction Network - inbound', view: 'network-transaction', kind: 'sql' },
  { id: 'Q-TN4', label: 'Transaction Network - edges', view: 'network-transaction', kind: 'sql' },
  { id: 'Q-TN5', label: 'Transaction Network - flags', view: 'network-transaction', kind: 'sql' },
  { id: 'Q-TN6', label: 'Transaction Network - links', view: 'network-transaction', kind: 'sql' },
  { id: 'Q-AH1', label: 'Alert History - summary', view: 'alert-history', kind: 'sql' },
  { id: 'Q-AH2', label: 'Alert History - timeline', view: 'alert-history', kind: 'sql' },
  { id: 'Q-AH3', label: 'Alert History - alerts page + total', view: 'alert-history', kind: 'sql', statements: 2 },
  { id: 'Q-TH1', label: 'Transaction History - events', view: 'transaction-history', kind: 'sql' },
  { id: 'Q-TH2', label: 'Transaction History - buckets', view: 'transaction-history', kind: 'sql' },
  { id: 'Q-TH3', label: 'Transaction History - baseline', view: 'transaction-history', kind: 'sql' },
  { id: 'Q-BF', label: 'Benford input', view: 'transaction-history', kind: 'sql' },
  { id: 'Q-C1', label: 'Conditions - transaction', view: 'conditions', kind: 'sql' },
  { id: 'Q-C2', label: 'Conditions - accounts', view: 'conditions', kind: 'sql' },
  { id: 'Q-C3', label: 'Conditions - details', view: 'conditions', kind: 'sql' },
  { id: 'Q-C4', label: 'Conditions - entity', view: 'conditions', kind: 'sql' }
];

module.exports = {
  qEm,
  qNav,
  qTd,
  qProf,
  qA1,
  qA2,
  qCp1,
  qCp2,
  qCp3,
  qCp4,
  qTn1,
  qTn2,
  qTn3,
  qTn4,
  qTn5,
  qTn6,
  qAh1,
  qAh2,
  qAh3Count,
  qAh3Page,
  qTh1,
  qTh2,
  qTh3,
  qBf,
  qC1,
  qC2a,
  qC2b,
  qC3,
  qC4,
  RAW_QUERY_CATALOGUE
};
