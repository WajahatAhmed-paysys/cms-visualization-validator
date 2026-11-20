'use strict';

/**
 * The CMS Visualization tab has 7 sub-tabs, two of which are not single feeds:
 *   - Network Analysis contains Transaction / Account / Counterparty Network
 *   - Transaction History carries a separate Benford block
 *
 * That gives 9 data views and 15 role-view checks:
 *   Alert Navigator             1
 *   Transaction Details         1
 *   Transaction History         2 (creditor, debtor)
 *   Transaction Network         2
 *   Account Network             2
 *   Counterparty Network        2
 *   Alert History               2
 *   Conditions                  1
 *   Profile Overview            2
 *   ----------------------------------
 *   Total                      15
 */

const VIEWS = [
  {
    key: 'alert-navigator',
    card: 'Alert Navigator',
    label: 'Alert Navigator',
    roles: [null],
    roleScope: null,
    queries: ['Q-NAV'],
    expectedQueryCount: 1
  },
  {
    key: 'transaction-details',
    card: 'Transaction Details',
    label: 'Transaction Details',
    roles: [null],
    roleScope: null,
    queries: ['Q-TD'],
    expectedQueryCount: 1
  },
  {
    key: 'transaction-history',
    card: 'Transaction History',
    label: 'Transaction History',
    roles: ['creditor', 'debtor'],
    roleScope: 'account',
    queries: ['Q-TH1', 'Q-TH2', 'Q-TH3', 'Q-BF'],
    expectedQueryCount: 4
  },
  {
    key: 'network-transaction',
    card: 'Network Analysis',
    label: 'Transaction Network',
    roles: ['creditor', 'debtor'],
    roleScope: 'account',
    queries: ['Q-TN1', 'Q-TN2', 'Q-TN3', 'Q-TN4', 'Q-TN5', 'Q-TN6'],
    expectedQueryCount: 6
  },
  {
    key: 'network-account',
    card: 'Network Analysis',
    label: 'Account Network',
    roles: ['creditor', 'debtor'],
    roleScope: 'entity',
    queries: ['Q-A1', 'Q-A2'],
    expectedQueryCount: 2
  },
  {
    key: 'network-counterparty',
    card: 'Network Analysis',
    label: 'Counterparty Network',
    roles: ['creditor', 'debtor'],
    roleScope: 'entity',
    queries: ['Q-CP1', 'Q-CP2', 'Q-CP3', 'Q-CP4'],
    expectedQueryCount: 4
  },
  {
    key: 'alert-history',
    card: 'Alert History',
    label: 'Alert History',
    roles: ['creditor', 'debtor'],
    roleScope: 'entity',
    queries: ['Q-AH1', 'Q-AH2', 'Q-AH3'],
    expectedQueryCount: 4
  },
  {
    key: 'conditions',
    card: 'Conditions',
    label: 'Conditions',
    roles: [null],
    roleScope: null,
    queries: ['Q-C1', 'Q-C2', 'Q-C3', 'Q-C4'],
    expectedQueryCount: null // dynamic: 5 + 2A
  },
  {
    key: 'profile-overview',
    card: 'Profile Overview',
    label: 'Profile Overview',
    roles: ['creditor', 'debtor'],
    roleScope: 'profile',
    queries: ['Q-PROF-C', 'Q-PROF-D'],
    expectedQueryCount: 1 // one POST returns both sides
  }
];

const QUERY_LABELS = {
  P1: 'Postgres: alert row',
  P2: 'Postgres: reference-id field name',
  'Q-EM': 'Entity metadata (parties + accounts)',
  'Q-NAV': 'Alert Navigator header/typologies/rules',
  'Q-TD': 'Transaction Details (pacs.008 + pacs.002)',
  'Q-PROF-C': 'Profile Overview - creditor history',
  'Q-PROF-D': 'Profile Overview - debtor history',
  'Q-A1': 'Account Network - entity accounts',
  'Q-A2': 'Account Network - account edges',
  'Q-CP1': 'Counterparty Network - two-degree edges',
  'Q-CP2': 'Counterparty Network - node names',
  'Q-CP3': 'Counterparty Network - root metrics',
  'Q-CP4': 'Counterparty Network - root name fallback',
  'Q-TN1': 'Transaction Network - centre account',
  'Q-TN2': 'Transaction Network - outbound edges',
  'Q-TN3': 'Transaction Network - inbound edges',
  'Q-TN4': 'Transaction Network - transaction-level edges',
  'Q-TN5': 'Transaction Network - node alert flags',
  'Q-TN6': 'Transaction Network - counterparty links',
  'Q-AH1': 'Alert History - summary',
  'Q-AH2': 'Alert History - timeline',
  'Q-AH3': 'Alert History - alerts page + total',
  'Q-TH1': 'Transaction History - event rows',
  'Q-TH2': 'Transaction History - aggregate buckets',
  'Q-TH3': 'Transaction History - expected baseline',
  'Q-BF': 'Benford analysis input',
  'Q-C1': 'Conditions - transaction parties',
  'Q-C2': 'Conditions - accounts and per-account conditions',
  'Q-C3': 'Conditions - details per account',
  'Q-C4': 'Conditions - entity-level conditions'
};

const ROLE_FIELD = {
  entity: { creditor: 'creditorId', debtor: 'debtorId' },
  account: { creditor: 'creditorAccountId', debtor: 'debtorAccountId' }
};

/** Expand the 9 views x role matrix into the 15 role-view checks. */
function buildChecks(roles) {
  const activeRoles = roles && roles.length ? roles : ['creditor', 'debtor'];
  const checks = [];
  for (const view of VIEWS) {
    for (const role of view.roles) {
      if (role === null) {
        checks.push({ view: view.key, viewLabel: view.label, card: view.card, role: null });
      } else if (activeRoles.includes(role)) {
        checks.push({ view: view.key, viewLabel: view.label, card: view.card, role });
      }
    }
  }
  return checks;
}

function getView(key) {
  return VIEWS.find((view) => view.key === key);
}

/** The entity-metadata field that supplies this role's parameter, if any. */
function roleParamField(viewKey, role) {
  const view = getView(viewKey);
  if (!view || !role || !view.roleScope || view.roleScope === 'profile') return null;
  return ROLE_FIELD[view.roleScope] ? ROLE_FIELD[view.roleScope][role] : null;
}

function totalQueryLabels() {
  return Object.keys(QUERY_LABELS).length;
}

module.exports = { VIEWS, QUERY_LABELS, buildChecks, getView, roleParamField, totalQueryLabels };
