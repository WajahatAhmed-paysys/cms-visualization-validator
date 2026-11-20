'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const projectRoot = path.join(__dirname, '..');

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function parseRoles(value) {
  const allowed = ['creditor', 'debtor'];
  const roles = String(value || 'creditor,debtor')
    .split(',')
    .map((r) => r.trim().toLowerCase())
    .filter((r) => allowed.includes(r));
  return roles.length ? Array.from(new Set(roles)) : allowed;
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

const config = {
  projectRoot,
  cmsBaseUrl: trimSlash(process.env.CMS_BASE_URL || 'http://10.10.80.18:3090'),
  lakehouseBaseUrl: trimSlash(process.env.LAKEHOUSE_BASE_URL || 'http://10.10.80.19:8282'),
  username: process.env.CMS_USERNAME || '',
  password: process.env.CMS_PASSWORD || '',
  tenantId: process.env.TENANT_ID || 'DEFAULT',
  granularity: process.env.GRANULARITY || 'month',
  roles: parseRoles(process.env.ROLES),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 35000),
  runBudgetMs: Number(process.env.RUN_BUDGET_MS || 180000),
  concurrency: Math.min(Math.max(Number(process.env.CONCURRENCY || 4), 1), 8),
  e2eId: process.env.E2E_ID || '',
  fromDate: process.env.FROM_DATE || '',
  toDate: process.env.TO_DATE || '',
  timeRange: process.env.TIME_RANGE || '30d',
  reportDir: path.join(projectRoot, 'reports'),
  // Tables the catalogue depends on. Used by the `health`/`tables` preflight.
  expectedTables: parseList(
    process.env.EXPECTED_TABLES ||
      [
        'transaction_detail',
        'transaction_history',
        'account_holder',
        'tx_network_accounts_edges',
        'tx_network_counterparties_edges',
        'counterparty_account_links',
        'alert_navigator_header',
        'alert_navigator_typologies',
        'alert_navigator_rules',
        'alerts',
        'cases',
        'tasks',
        'conditions'
      ].join(',')
  ),
  // Data Verify tolerances (spec §12)
  verifyTolerance: Number(process.env.VERIFY_TOLERANCE || 0.01),
  verifyMoneyTolerance: Number(process.env.VERIFY_MONEY_TOLERANCE || 0.01),
  verifyPercentTolerance: Number(process.env.VERIFY_PERCENT_TOLERANCE || 0.01)
};

module.exports = config;
